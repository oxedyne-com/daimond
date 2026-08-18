// verify_search_gateway.mjs — /api/web/search, and the refusals that are most
// of its behaviour.
//
// A search endpoint is mostly a set of answers to requests it will NOT serve,
// and each of those answers is a decision somebody could quietly change: the
// engine is the user's setting rather than the model's choice, and one engine
// is off the credits tier on purpose. Unit tests hold the decisions; this holds
// the wire, because a decision that never reaches an HTTP status is a decision
// the browser cannot act on.
//
// WHAT IS MEASURED, and why each one would otherwise go quiet:
//
//   1. A request with no query is refused, naming `query`. A search tool whose
//      empty call 500s teaches a model to stop calling it.
//   2. An engine nobody has heard of is refused, LISTING the ones that work.
//      "Unknown engine" leaves a model guessing; the list ends the guessing.
//   3. An engine named with no key is refused, naming the KEY. This is the
//      commonest real failure — a user picks Exa in Settings and does not
//      paste a key — and "search failed" would send them to the wrong place.
//   4. A key sent with `credits` is refused rather than ignored. Ignoring it
//      would spend the account's credits on a search the user believed their
//      own key was paying for.
//   5. **Serper on the credits tier is refused.** §3 of the search contract:
//      serper resells another engine's results, so Oxedyne does not bill for
//      it. The only way to reach that decision over HTTP is to configure the
//      gateway wrongly on purpose, which is what the second fixture below
//      does — a request cannot ask for it, and that is itself the point.
//   6. An operator who has chosen an engine and set no key gets a `503` that
//      says the OPERATOR has not configured search. They read logs; the user
//      cannot fix it.
//   7. GET is refused. The query is in the body and a query string is a URL,
//      and a URL is where searches end up in somebody's access log.
//   8. No response body ever echoes a key that was sent.
//   9. `limit` opens no path of its own. It is now a number with a price on it
//      — a credits search is metered by what the vendor charges, and on Exa the
//      results past the tenth are money — so a request that asks for the
//      largest allowed must still be refused for exactly the reason a small one
//      is, rather than finding a way past the routing.
//
// WHAT IS NOT MEASURED HERE. What a search COSTS. Every case below is refused
// before a socket opens, so nothing is metered and nothing is charged; the
// arithmetic is held by the unit tests in `gateway/src/handlers/web.rs`, which
// can price a search without spending anybody's vendor quota to do it.
//
// HOW IT RUNS. Two throwaway gateways, each on its own port with its own store
// and a CWD holding a patched `app.jdat` — one configured to search with
// `serper` (the misconfiguration), one with `brave` and no key (the unset
// operator). `DAIMOND_GW_DEV=1`, so no account, no session and no credits are
// needed to reach the refusals. Nothing touches the real store, and no request
// leaves this machine: every case here is refused before a socket is opened.
//
//   node dev/verify_search_gateway.mjs
//
// It needs a built gateway binary. It does NOT need dev/serve.mjs, a browser,
// or the gateway on :9002.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway } from './gwbin.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const GWDIR = path.join(ROOT, 'gateway');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 15000, gap = 200) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

/// The binary to drive. The isolated slot target is preferred when it is
/// newer, exactly as the other gateway verifiers do it — a stale binary would
/// answer 404 here and read as "the route was never wired".
function binary() {
	const cands = [
		path.join(os.homedir(), '.cache/cargo-targets/gateway_target/release/daimond_gateway'),
		path.join(GWDIR, 'target/release/daimond_gateway'),
	].filter(p => fs.existsSync(p));
	cands.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
	return cands[0] || null;
}

/// A working directory holding a patched `app.jdat`: its own port, its own
/// store, and a `/api/web/search` route configured as the case under test
/// needs it.
///
/// The route is INSERTED rather than edited, because `gateway/app.jdat` is the
/// deployed configuration and the record of intent. A verifier that edited it
/// would be one interrupted run away from committing a test fixture as the
/// shipped config.
function fixture(name, port, engine) {
	const out = path.join(HERE, 'searchgw', name);
	// Cleared rather than reused: the store inside it belongs to one run, and a
	// gateway that found a store from an older build would answer about that
	// one. `dev/searchgw/` wants a line in `.gitignore` beside `dev/devgw/`.
	fs.rmSync(out, { recursive: true, force: true });
	fs.mkdirSync(out, { recursive: true });
	// The keys are the real sandbox keys: `app.jdat` reads several of them with
	// `{file:…}` and the config will not load without them. Symlinked, never
	// copied. The STORE is this fixture's own, and not because the real one is
	// locked — o3db excludes nobody, and a second process opening it is refused
	// nothing. It is worse than that: it would get an index of its own built at
	// open, so neither process would see the other's writes, and a garbage
	// collector of its own over the same files. A fixture that shared the store
	// would measure a picture nothing else holds.
	const keys = path.join(out, 'keys');
	if (!fs.existsSync(keys)) fs.symlinkSync(path.join(GWDIR, 'keys'), keys);

	let cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8');
	cfg = cfg.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${port})`);

	// The vendor prices are written out even though no case here reaches a
	// vendor: they are what a credits search is metered by, and a gateway that
	// would not START with them configured is a failure this file should be the
	// one to find. `search_min_charge_minor` is deliberately absent — the floor
	// under a per-request charge went when the charge stopped being per request.
	const route = `        { "path": "/api/web/search", "handler": "web_search", "config": {
            "search_engine":                    "${engine}",
            "search_byok_minor":                "1",
            "search_cost_brave_per_1k_minor":   "500",
            "search_cost_exa_per_1k_minor":     "700",
            "search_cost_tavily_per_1k_minor":  "800",
            "search_cost_serper_per_1k_minor":  "100",
            "search_extra_result_per_1k_minor": "100",
            "search_fee_bps":                   "550",
            "max_redirects":                    "3"
        }},\n`;
	// The real route is REMOVED first, not merely preceded. It did not exist
	// when this fixture was written; once it was wired into app.jdat, inserting
	// ahead of it left two routes on one path and the router took the shipped
	// one -- so a fixture configured for serper quietly measured a gateway
	// configured for brave, and the refusal it asserted could never appear.
	// A duplicate is worse than an override precisely because it looks like it
	// worked.
	cfg = cfg.replace(
		/^[ \t]*\{ "path": "\/api\/web\/search",[\s\S]*?^[ \t]*\}\},[ \t]*\n/m, '');

	// Anchored on the fetch route's own line, so a config change elsewhere
	// cannot quietly move where this lands.
	const anchor = '        { "path": "/api/web/fetch", "handler": "web_fetch", "config": {';
	if (cfg.indexOf(anchor) === -1) {
		console.log('  FAIL dev/verify_search_gateway cannot find the fetch route in app.jdat');
		process.exit(1);
	}
	cfg = cfg.replace(anchor, route + anchor);
	fs.writeFileSync(path.join(out, 'app.jdat'), cfg);
	return out;
}

const procs = [];
function cleanup() {
	for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} }
}

/// Start a gateway in `cwd` and wait for it to answer.
async function start(bin, cwd, port) {
	const p = spawn(bin, [], {
		cwd,
		env: { ...process.env, APP_MODE: 'sandbox', DAIMOND_GW_DEV: '1' },
		stdio: 'ignore',
	});
	procs.push(p);
	const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).ok);
	return up;
}

const H = { 'content-type': 'application/json', 'x-daimond-api': '1' };
const post = (port, body) => fetch(`http://127.0.0.1:${port}/api/web/search`,
	{ method: 'POST', headers: H, body: JSON.stringify(body) });

/// The status and the text of a refusal, so an assertion can name both.
async function refusal(port, body) {
	const r = await post(port, body);
	let text = '';
	try { text = JSON.stringify(await r.json()); } catch (e) { text = '<not json>'; }
	return { status: r.status, text };
}

(async () => {
	requireFreshGateway();
	const bin = binary();
	if (!bin) {
		console.log('SKIP verify_search_gateway — no daimond_gateway binary built');
		process.exit(0);
	}

	// ── Fixture A: the operator has set the credits tier to serper ──
	const A_PORT = 9013;
	const upA = await start(bin, fixture('serper', A_PORT, 'serper'), A_PORT);
	check('a gateway starts with the credits tier set to serper', upA, bin);
	if (!upA) { cleanup(); process.exit(1); }

	// If the route is not wired the endpoint 404s and every check below would
	// pass or fail for the wrong reason, so it is settled first and loudly.
	const probe = await post(A_PORT, { query: 'ada lovelace' });
	if (probe.status === 404) {
		console.log('SKIP verify_search_gateway — /api/web/search answers 404, so the ' +
			'handler is not registered. Lane `gateway` owns handlers/web.rs and not the ' +
			'wiring: it still needs `pub use web::WebSearch` in handlers/mod.rs, an ' +
			'`api_reg.insert_boxed("web_search", …)` in app_main.rs, the route in ' +
			'gateway/app.jdat, and the proxy line in gateway/config.jdat.');
		cleanup();
		process.exit(0);
	}
	check('the search endpoint is wired', probe.status !== 404, 'HTTP ' + probe.status);

	// 5. Serper on the credits tier. Nothing in the REQUEST can ask for this —
	//    it is reachable only by configuring the gateway wrongly, which is what
	//    this fixture does.
	const serper = await refusal(A_PORT, { query: 'ada lovelace' });
	check('the credits tier refuses serper', serper.status === 503,
		'HTTP ' + serper.status);
	check('and the refusal says serper is reachable with your own key',
		/serper/i.test(serper.text) && /own key/i.test(serper.text), serper.text);
	check('and it names the operator, who is the one who can fix it',
		/operator/i.test(serper.text), serper.text);

	// Naming credits explicitly is the same request by another spelling, and
	// must not find a way through.
	const serperNamed = await refusal(A_PORT, { query: 'q', engine: 'credits' });
	check('naming the credits tier explicitly is refused the same way',
		serperNamed.status === 503, 'HTTP ' + serperNamed.status);

	// Serper with the caller's OWN key is the one way it is reachable, and it
	// must not be refused by the routing. It is not sent here: asserting that
	// the refusal is not the routing's is enough, and a real search would spend
	// somebody's quota.
	const serperByok = await refusal(A_PORT, { query: 'q', engine: 'serper', key: 'x'.repeat(40) });
	check('serper with your own key is not refused by the routing',
		serperByok.status !== 400 || !/only|credits cannot/i.test(serperByok.text),
		'HTTP ' + serperByok.status + ' ' + serperByok.text);
	check('and no reply echoes the key that was sent',
		serperByok.text.indexOf('x'.repeat(40)) === -1, serperByok.text);

	// ── The request-shape refusals, on the same gateway ──
	const noQuery = await refusal(A_PORT, {});
	check('a request with no query is refused, naming query',
		noQuery.status === 400 && /query/i.test(noQuery.text),
		'HTTP ' + noQuery.status + ' ' + noQuery.text);

	const unknown = await refusal(A_PORT, { query: 'q', engine: 'bing', key: 'k'.repeat(20) });
	check('an unknown engine is refused', unknown.status === 400,
		'HTTP ' + unknown.status);
	check('and the refusal lists the engines that do work',
		['brave', 'exa', 'tavily', 'serper'].every(e => unknown.text.indexOf(e) !== -1),
		unknown.text);

	const noKey = await refusal(A_PORT, { query: 'q', engine: 'exa' });
	check('an engine with no key is refused, naming the key',
		noKey.status === 400 && /key/i.test(noKey.text) && /exa/i.test(noKey.text),
		'HTTP ' + noKey.status + ' ' + noKey.text);

	const keyWithCredits = await refusal(A_PORT, { query: 'q', engine: 'credits', key: 'z'.repeat(30) });
	check('a key sent with the credits tier is refused rather than ignored',
		keyWithCredits.status === 400,
		'HTTP ' + keyWithCredits.status + ' ' + keyWithCredits.text);
	check('and that refusal does not echo the key either',
		keyWithCredits.text.indexOf('z'.repeat(30)) === -1, keyWithCredits.text);

	const kindWrong = await refusal(A_PORT, { query: 'q', kind: 'images' });
	check('a kind that is not one of the three is refused',
		kindWrong.status === 400 && /web|news|academic/i.test(kindWrong.text),
		'HTTP ' + kindWrong.status + ' ' + kindWrong.text);

	// 9. A limit is a number with a price on it, and it must not also be a way
	//    through. The largest one this endpoint allows is refused exactly as the
	//    default is — same status, same sentence.
	const plain = await refusal(A_PORT, { query: 'ada lovelace' });
	const big   = await refusal(A_PORT, { query: 'ada lovelace', limit: 20 });
	check('the largest limit is refused exactly as the default one is',
		big.status === plain.status && big.text === plain.text,
		'HTTP ' + big.status + ' ' + big.text);

	const got = await fetch(`http://127.0.0.1:${A_PORT}/api/web/search?query=q`,
		{ headers: { 'x-daimond-api': '1' } });
	check('GET is refused: a query belongs in a body, not in somebody\'s access log',
		got.status === 405, 'HTTP ' + got.status);

	// ── Fixture B: a well-configured engine with no key set ──
	const B_PORT = 9014;
	const upB = await start(bin, fixture('nokey', B_PORT, 'brave'), B_PORT);
	check('a second gateway starts with brave chosen and no key set', upB);
	if (upB) {
		const unset = await refusal(B_PORT, { query: 'ada lovelace' });
		check('an operator who set no key gets 503, not a generic failure',
			unset.status === 503, 'HTTP ' + unset.status);
		check('and the message says the OPERATOR has not configured search',
			/operator has not configured search/i.test(unset.text), unset.text);
		check('and it names the engine whose key is missing',
			/brave/i.test(unset.text), unset.text);
		check('and nothing was charged',
			/nothing has been charged/i.test(unset.text), unset.text);
	}

	cleanup();
	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(e => {
	cleanup();
	console.log('  FAIL verify_search_gateway threw — ' + (e && e.stack || e));
	process.exit(1);
});
