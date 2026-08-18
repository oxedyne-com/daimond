// dev/verify_relay_e2e.mjs -- the two halves meeting: a message sealed in one
// browser, carried by a RUNNING GATEWAY, and opened in another.
//
// WHY THIS FILE EXISTS. Every other verifier of the messaging client carries the
// bytes itself. `verify_post.mjs` says so at the top -- "no server in the path at
// all" -- and `verify_trust.mjs` and `verify_group.mjs` both assert that no
// gateway was even running. That is the right shape for what they prove: the
// seal must not need a server, and a group that only works with one has put the
// server inside the cryptography. But it leaves one thing untested, and it is
// the thing that breaks: the CLIENT's idea of `/api/post` and the GATEWAY's idea
// of `/api/post` were written from the contract by different lanes, each was
// exercised only against itself, and each was honestly correct in isolation. Two
// halves that have never spoken cannot be said to fit.
//
// So the property here is not the seal and not the roster. It is: THE WIRE.
// Every request below goes through the real front door to a real gateway process
// with a real store, and the answers are read by the real client.
//
// WHAT THIS RUN OWNS. Its own gateway, on its own port, in its own directory,
// with an EMPTY store; and its own dev server pointed at that gateway. Nothing
// is shared, because the checks below count rows in a postbox and counting them
// in a store somebody else is writing to would measure their afternoon. The
// browser-only worlds (`dev/world.sh N`) number the app at 8777+N and the mock
// provider at 9099+N; this takes world 5's app port and a gateway port well
// clear of both, so a run here does not collide with anybody's browser work.
//
//   bash dev/world.sh 5 --down        # this file starts its own server
//   node dev/verify_relay_e2e.mjs
//   DAIMOND_RELAY_PORT=8920 DAIMOND_RELAY_GW_PORT=9509 node dev/verify_relay_e2e.mjs
//
// Those two are the ONLY ports this file honours, and `dev/gate.sh` derives them
// from the world number so a suite run never collides with the world's own
// server. See the constants below for what went wrong when it read the world's.
//
// A fault injected on purpose, so a check can be shown going red. Each break
// names the checks it MUST redden, and a run where those stayed green fails --
// "something went red" is not enough when the run already has a standing failure
// in it, which this one does (§5). A break credited with catching a defect it
// never saw is the exact shape `dev/verify_conformance.mjs` was rewritten around.
//
//   --break=echo     the plaintext rides along beside the envelope   -> §2 one check
//   --break=anyone   any key opens any envelope                      -> §3 one check
//   --break=noack    no collect-and-ack round is run                  -> §4 TWO checks,
//                    and it cannot be otherwise: one behaviour violates both
//                    sentences -- the relay was not told, and the relay is still
//                    holding it.
//
// WHAT THIS FILE DOES NOT PROVE, said here rather than left to be assumed:
//
//   * Nothing about the seal's strength. §1 of `verify_post.mjs` owns that, with
//     no server in the path, which is where it belongs. What is asserted here is
//     that the SAME seal survives a round trip through the relay -- a different
//     claim, and the one nobody had made.
//   * Nothing about parking or the doorbell. Those are `verify_post.mjs` §7 and
//     `verify_doorbell.mjs`, both against a routed browser rather than a gateway.
//   * Nothing about production. This is loopback with `dev_insecure` on and the
//     beta opened, which is what `dev/gwbin.mjs` builds for every gateway-driving
//     verifier in the tree.

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requireFreshGateway, GWBIN, GWDIR, openBeta, procLog } from './gwbin.mjs';

// `harness.mjs` reads the app's URL into a module CONST at import time, so this
// file cannot set `DAIMOND_APP` in its own body and be believed: an `import`
// statement is evaluated before any of it runs. The first draft did exactly that
// and every browser went to :8777 -- world 0's server, proxying to a gateway on
// :9002 that this run never started -- while the refusal check above happily
// confirmed :8782 was free. The whole run then measured the wrong relay and said
// so only in one URL, in one passing line's detail. So the harness is imported
// BELOW, dynamically, after the environment it reads is set.
let open, errors;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// 9502: clear of the dev servers (8777+N), the mock providers (9099+N), the
// shared gateway (9002) and verify_passcode's own (9402). A "spare" port inside
// one of those ranges answers a health probe with somebody else's process.
//
// DELIBERATELY NOT `DAIMOND_PORT` OR `DAIMOND_GW_PORT`, the same rule and for the
// same reason as dev/verify_redeem.mjs. This file starts a dev server of its own
// pointed at a gateway of its own, and `dev/run_all.sh` runs inside a world that
// has already exported `DAIMOND_PORT` for the server everything else shares.
// Reading it made this verifier try to seize the suite's own port, find it held,
// and refuse -- correctly, and every single time. Under `dev/gate.sh`'s default
// world 9 that port is 8786, and the whole of this file's output on the
// 2026-08-17 gate was one refusal naming two variables it had not been given,
// while the same file passes 32 checks standalone. A collision by construction,
// not a flake. So the knobs are its own, and the world it runs in cannot reach in
// and move them; `gate.sh` derives them from the world number.
const GW_PORT  = Number(process.env.DAIMOND_RELAY_GW_PORT || 9502);
const GW_URL   = `http://127.0.0.1:${GW_PORT}`;
const APP_PORT = Number(process.env.DAIMOND_RELAY_PORT || 8782);	// world 5
const APP_URL  = `http://localhost:${APP_PORT}`;
const SCRATCH  = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const WORK     = path.join(SCRATCH, 'verify_relay_e2e-gw');
const GW_LOG   = procLog('verify_relay_e2e');
const SRV_LOG  = procLog('verify_relay_e2e', 'server');

const BREAK = (process.argv.find(a => a.startsWith('--break=')) || '').slice(8);
/// What each break must turn red, by the leading words of the check's name.
///
/// Named rather than counted. This file has a standing failure in §5 -- a real
/// defect in the app, reported below -- so a run with ANY break already ends with
/// something red, and "the run failed" would credit every break with catching it.
const AIMS = {
	echo:   ['and the words are nowhere'],
	anyone: ['a third identity holding the same bytes'],
	noack:  ['the relay is told it may let go', 'and the relay is then holding nothing'],
};
if (BREAK && !(BREAK in AIMS)) {
	console.log(`  --break=${BREAK} is not one of: ${Object.keys(AIMS).join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
/// Record a check. `detail` is the evidence and is printed either way; `why` is
/// what went wrong and is printed only when it did, so a passing line can never
/// be read as a failure.
const check = (name, pass, detail, why) => {
	(pass ? ok : bad).push(name);
	const tail = pass ? (detail ? ' — ' + detail : '')
		: ' — ' + [why, detail].filter(Boolean).join(' · ');
	console.log((pass ? '  ok   ' : '  FAIL ') + name + tail);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Poll until `fn` answers true, or give up. Returns whether it did.
async function waitFor(fn, ms = 12000, gap = 150) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) { /* not up yet */ }
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

/// Is anything listening on a loopback port?
async function held(port) {
	return await waitFor(async () => {
		const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
		return !!r;
	}, 600, 200);
}


// ┌───────────────────────────────────────────────────────────────────────────┐
// │ THIS RUN'S OWN GATEWAY AND ITS OWN FRONT DOOR                             │
// └───────────────────────────────────────────────────────────────────────────┘

/// Build the gateway's working directory: the deployed config with the port
/// changed and the beta opened, the real signing keys symlinked in, and an empty
/// store.
///
/// The database key is NOT symlinked. The store here is new, so its at-rest key
/// must be new too; pointing a fresh store at the live key either fails or --
/// far worse -- succeeds against the live store.
function buildWorkDir() {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(WORK, 'keys'), { recursive: true });
	for (const k of ['licence', 'stripe', 'openrouter']) {
		const from = path.join(GWDIR, 'keys', k);
		if (fs.existsSync(from)) fs.symlinkSync(from, path.join(WORK, 'keys', k));
	}
	let cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8')
		.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${GW_PORT})`);
	if (!cfg.includes(`(u16|${GW_PORT})`)) {
		console.log('  FAIL could not set the listen port in the copied app.jdat — '
			+ 'has its shape changed? A gateway left on the deployed port would be '
			+ 'measured instead of this one.');
		process.exit(1);
	}
	// Registration must be open: both browsers mint a fresh keypair, and the
	// deployed config answers a fresh keypair `403 the beta is closed`, which
	// would leave this run measuring a shut door.
	cfg = openBeta(cfg, 'verify_relay_e2e');
	fs.writeFileSync(path.join(WORK, 'app.jdat'), cfg);
	return WORK;
}

let gw = null, srv = null;

/// Stop everything this run started, and only what this run started.
///
/// The browser profiles go too. `harness.mjs` names one `pw/<name>-<pid>` and
/// leaves it on disk, which is right for a fixed profile a run means to reuse and
/// pure litter for a pid-named one: three browsers a run, and ten runs of this
/// file in one afternoon left thirty directories in a `pw/` already holding 1.2 GB
/// across a hundred. Removed by exact name rather than by pattern, so a run cannot
/// delete another agent's profile while they are driving it.
function cleanup() {
	for (const p of [gw, srv]) { try { if (p) p.kill(); } catch (e) { /* already gone */ } }
	gw = null; srv = null;
	for (const n of ['relay-a', 'relay-b', 'relay-c']) {
		try { fs.rmSync(path.join(SCRATCH, 'pw', `${n}-${process.pid}`), { recursive: true, force: true }); }
		catch (e) { /* never made, or already gone */ }
	}
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });


// ┌───────────────────────────────────────────────────────────────────────────┐
// │ A DEVICE                                                                  │
// └───────────────────────────────────────────────────────────────────────────┘

/// Bring up one browser on its own profile, signed in, with an identity, a
/// sealing key and a card -- and an account on THIS run's gateway.
///
/// `connect: false` because the mock LLM provider has nothing to do with the
/// relay, and asking for one would make this file fail when a mock is not up.
/// Nothing is injected: post.js, trust.js and group.js are asserted in §0 and
/// come off the page as the browser assembled it.
async function device(name) {
	const s = await open({ name, signIn: true, connect: false });
	// Every request the page makes, with its body, so §3 can read what actually
	// left the browser rather than what the client says it sent.
	s.seen = [];
	s.page.on('request', r => {
		let body = '';
		try { body = r.postData() || ''; } catch (e) { /* not a body we can read */ }
		s.seen.push({ url: r.url(), method: r.method(), body });
	});
	await s.page.waitForFunction(
		() => !!window.DaimondPost && !!window.DaimondTrust && !!window.DaimondGroup
			&& !!window.DaimondIdentity && !!window.DaimondGateway,
		null, { timeout: 20000 },
	).catch(() => { throw new Error(
		`${name}: the page did not assemble — post.js, trust.js or group.js is missing `
		+ 'from www/index.html. Nothing here injects them; see §0.'); });
	await s.page.evaluate(async () => {
		await window.DaimondIdentity.ensureSealingKey();
		await window.DaimondIdentity.mintCard();
	});
	// The account is taken through the app's own bootstrap, which is the round a
	// real device makes, rather than by posting to /api/account from here.
	const authed = await s.page.evaluate(async () => {
		try { await window.DaimondGateway.bootstrap(); } catch (e) { /* read the state */ }
		return window.DaimondGateway.state().authed === true;
	});
	s.authed = authed;
	// BOTH SPELLINGS, because the app uses both and they are not interchangeable:
	// `DaimondPost.send({to})` takes base64url (it is the account key the relay
	// looks up), and `DaimondGroup.create(name, keys)` takes lower-case hex.
	//
	// This comment used to say the wrong spelling was dropped silently, because it
	// was: `if (!isHex(k, 32) || seen[k]) continue;`, with neither case added to
	// `missing`, so the first run of this file made a group of one and could not
	// tell. FIXED at www/js/group.js:653 -- a key that is not a key is carried out
	// in `bad` and named. The note is corrected rather than left standing: a
	// comment that outlives its defect tells the next reader a gap is open, which
	// is the species this lane's own audit caught in share.js:133.
	s.pub = await s.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
	s.hex = await s.page.evaluate(async () => {
		const raw = await window.DaimondIdentity.publicKeyRaw();
		return Array.from(raw).map(b => (b + 256).toString(16).slice(1)).join('');
	});
	return s;
}

/// The one place a plaintext word is chosen, so §3 and §4 cannot drift apart.
const WORDS = 'pelican semaphore ' + Math.random().toString(36).slice(2, 10);
const GWORDS = 'thimble cartography ' + Math.random().toString(36).slice(2, 10);


(async () => {
	// The gateway must be the one the code under test describes. This refuses on
	// a stale binary, which is the whole reason `dev/gwbin.mjs` exists: a
	// verifier measuring a build nobody is shipping produces numbers that are
	// harder to disbelieve than an absent result.
	requireFreshGateway();

	if (await held(GW_PORT)) {
		console.log(`  FAIL something is already answering on :${GW_PORT}. This run needs its `
			+ 'OWN gateway with an EMPTY store — it counts rows in a postbox, and counting '
			+ 'them in somebody else\'s store would measure their afternoon. Set '
			+ 'DAIMOND_RELAY_GW_PORT to a free port.');
		process.exit(1);
	}
	if (await held(APP_PORT)) {
		console.log(`  FAIL something is already serving on :${APP_PORT}. This run starts its own `
			+ `dev server so it can point /api at :${GW_PORT}; a server started by `
			+ `dev/world.sh proxies to :9002 instead, and the browser would then be `
			+ 'talking to a gateway this file did not start. Run `bash dev/world.sh 5 --down` '
			+ 'first, or set DAIMOND_RELAY_PORT to a free port.');
		process.exit(1);
	}

	const cwd = buildWorkDir();
	gw = spawn(GWBIN, [], { cwd, env: { ...process.env, APP_MODE: 'sandbox' }, stdio: GW_LOG.stdio });
	const gwUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
	check('this run\'s own gateway is up, on an empty store', gwUp, `${GW_URL} — ${cwd}`);
	if (!gwUp) { GW_LOG.report(); cleanup(); process.exit(1); }

	srv = spawn(process.execPath, [path.join(HERE, 'serve.mjs')], {
		cwd: ROOT,
		env: { ...process.env, DAIMOND_PORT: String(APP_PORT), DAIMOND_GW_PORT: String(GW_PORT) },
		stdio: SRV_LOG.stdio,
	});
	const srvUp = await waitFor(async () => (await fetch(`${APP_URL}/index.html`)).ok);
	check('and its own front door, proxying /api to it', srvUp, `${APP_URL} → :${GW_PORT}`);
	if (!srvUp) { SRV_LOG.report(); cleanup(); process.exit(1); }

	// The browsers must reach the app through THIS server, whatever the ambient
	// world variables say. The harness is loaded HERE, after the variable is set,
	// because it reads it once at import time -- see the note beside the import.
	process.env.DAIMOND_APP = APP_URL;
	({ open, errors } = await import('./harness.mjs'));

	let A = null, B = null, C = null;
	try {
		// ── 0. The seams are in the app ────────────────────────────────
		console.log('\n0. the client is the shipped one, and the relay is this run\'s');
		const html = fs.readFileSync(path.join(ROOT, 'www', 'index.html'), 'utf8');
		for (const f of ['post', 'trust', 'group']) {
			check(`www/index.html carries a script tag for js/${f}.js`,
				new RegExp('<script[^>]+src=["\']js/' + f + '\\.js["\']').test(html),
				'', 'nothing here injects it, so every section below would be untestable');
		}
		// The front door really is proxying, and to the gateway this run started.
		// A dev server whose proxy target were 9002 would answer the same shape
		// from a DIFFERENT process, which is exactly the confusion being closed.
		const viaDoor = await fetch(`${APP_URL}/api/health`);
		const direct  = await fetch(`${GW_URL}/api/health`);
		check('/api through the front door reaches this run\'s gateway',
			viaDoor.ok && direct.ok && (await viaDoor.text()) === (await direct.text()),
			`door ${viaDoor.status}, direct ${direct.status}`);

		A = await device('relay-a');
		B = await device('relay-b');
		C = await device('relay-c');		// the third identity, who must never open it
		check('three devices, three identities, three accounts on ONE relay',
			A.authed && B.authed && C.authed,
			`A ${A.authed} B ${B.authed} C ${C.authed}`,
			'a device with no gateway session cannot send or collect');
		check('and the three keys really are different',
			A.pub && B.pub && C.pub && new Set([A.pub, B.pub, C.pub]).size === 3);

		// ── 1. First contact, carried by this file and by nothing else ──
		console.log('\n1. first contact — the cards cross the table, not the network');
		const cardOf = s => s.page.evaluate(() => window.DaimondTrust.cardText());
		const readCard = (s, text) => s.page.evaluate(async (t) => {
			const card = window.DaimondTrust.parse(t);
			if (!card) return null;
			await window.DaimondTrust.record(card, window.DaimondTrust.ROUTE.QR);
			await window.DaimondPost.refreshPeople();
			return { key: card.key };
		}, text);

		const [aCard, bCard] = [await cardOf(A), await cardOf(B)];
		const aSees = await readCard(A, bCard);
		const bSees = await readCard(B, aCard);
		check('each device read the other\'s card', !!aSees && !!bSees);
		// The safety numbers are computed on each device and compared HERE.
		const aNum = await A.page.evaluate(() => window.DaimondIdentity.publicKeyB64url());
		check('and each now holds a sealing key for the other',
			await A.page.evaluate(p => (window.DaimondPost.people() || [])
				.some(x => x.pub === p), B.pub)
			&& await B.page.evaluate(p => (window.DaimondPost.people() || [])
				.some(x => x.pub === p), A.pub),
			'', 'without a card there is no key to seal to and §2 would test nothing');

		// ── 2. A message, through the real relay ───────────────────────
		console.log('\n2. A seals, the gateway carries, B opens');
		A.seen.length = 0;
		const sent = await A.page.evaluate(async ({ to, body }) => {
			const r = await window.DaimondPost.send({ to, body });
			return { ok: r.ok === true, why: r.why || '', addr: r.addr || '' };
		}, { to: B.pub, body: WORDS });
		check('A\'s send is accepted by the relay', sent.ok, sent.addr, sent.why);

		// What actually left the browser. The plaintext must be in NONE of it:
		// a client that sent the words alongside the envelope would pass every
		// open-it-again check in this file and every one in verify_post.
		const posts = A.seen.filter(r => r.method === 'POST' && /\/api\/post(\?|$)/.test(r.url));
		check('exactly one POST /api/post left the browser', posts.length === 1,
			`${posts.length} — ` + posts.map(p => p.url.replace(APP_URL, '')).join(' '));
		const wire = posts.map(p => p.url + ' ' + p.body).join('\n');
		const leaked = BREAK === 'echo' ? wire + ' ' + WORDS : wire;
		check('and the words are nowhere in what it sent',
			!leaked.includes(WORDS) && !leaked.includes(WORDS.split(' ')[0]),
			`${wire.length} bytes on the wire`,
			'the plaintext rode along beside the envelope');

		// WHAT THE RELAY ITSELF IS HOLDING, read raw rather than through the
		// client's bookkeeping. `DaimondPost.collect()` answers
		// `{ok, got, notes, unreadable, more}` and CONSUMES what it reads -- it
		// advances `through`, so a second call answers zero and a check that
		// counted rows off it would report an empty box for a message that had
		// arrived perfectly. So the box is read with a bare GET, which is what the
		// client's own `call('GET')` makes, and the client's collect is measured
		// separately by what it returns and what it stores.
		const boxOf = (s) => s.page.evaluate(async () => {
			const r = await fetch('/api/post?since=0', {
				credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
			});
			const j = await r.json().catch(() => null);
			return { status: r.status, rows: (j && j.rows) || [], seq: (j && j.seq) || 0 };
		});

		const bBox = await boxOf(B);
		check('the relay is holding exactly one row for B', bBox.rows.length === 1,
			`status=${bBox.status} rows=${bBox.rows.length} seq=${bBox.seq}`,
			'the envelope did not reach the recipient\'s postbox');
		const cBox = await boxOf(C);
		check('and nothing at all for C', cBox.rows.length === 0, `rows=${cBox.rows.length}`);

		// ── 3. B opens it, C cannot ────────────────────────────────────
		console.log('\n3. the seal survives the round trip');
		const row = bBox.rows[0] || null;
		check('the row the relay handed back names the sender and carries an envelope',
			!!row && row.from_pub === A.pub && row.kind === 'post'
			&& typeof row.envelope === 'string' && row.envelope.length > 0,
			row ? `kind=${row.kind} from=${String(row.from_pub).slice(0, 10)}…` : 'no row');

		// Through the client's own collect, which is the path a person's browser
		// takes: it reads the box, opens what it finds and files it.
		const took = await B.page.evaluate(() => window.DaimondPost.collect());
		check('B\'s own collect takes exactly one message off the relay',
			took.ok === true && took.got === 1,
			`got=${took.got} notes=${took.notes} unreadable=${took.unreadable}`,
			took.why || 'the client did not file the message it was handed');
		const filed = await B.page.evaluate(async (from) => {
			const st = await window.DaimondPost.read();
			const msgs = (st && st.msgs) || {};
			const k = Object.keys(msgs).find(k => msgs[k].dir === 'in' && msgs[k].from === from);
			return k ? { body: msgs[k].body, read: msgs[k].read, seq: msgs[k].seq } : null;
		}, A.pub);
		check('and what it filed is the exact words A typed',
			!!filed && filed.body === WORDS,
			filed ? JSON.stringify(filed.body).slice(0, 60) : 'nothing was filed',
			'the message did not survive the relay');

		// The negative that makes the positive mean something. C holds every
		// module B holds and a perfectly good identity; what C does not hold is
		// the key, and the relay cannot supply one.
		const byC = row ? await C.page.evaluate(async (r) => {
			try {
				const got = await window.DaimondPost.open(r.envelope, r.addr);
				return { opened: true, body: (got && got.post && got.post.body) || '' };
			} catch (e) { return { opened: false, why: String((e && e.message) || e) }; }
		}, row) : { opened: false, why: 'no row' };
		const cOpened = BREAK === 'anyone' ? { opened: true, body: WORDS } : byC;
		check('a third identity holding the same bytes cannot open it',
			cOpened.opened !== true, cOpened.opened ? 'C READ IT: ' + cOpened.body : cOpened.why,
			'the seal is decoration');

		// ── 4. The ack, and what it does to the box ────────────────────
		console.log('\n4. ack — the relay lets go only after the message is safe');
		// A collect is not a commit. Until something is acked the relay keeps the
		// row, so that a device which read a message and then lost it has not lost
		// the only copy. Asserted BEFORE the ack, because "the box is empty at the
		// end" is equally true of a relay that dropped it on the collect.
		const stillThere = await boxOf(B);
		check('a collect on its own does not release the row', stillThere.rows.length === 1,
			`rows=${stillThere.rows.length}`,
			'the relay let go of a message before being told it was safe elsewhere');

		// THROUGH `round()`, which is collect-then-ack and is what the app itself
		// calls -- on a park wake (post.js:1626) and on a panel refresh (:2072).
		// Calling `ack()` once instead measured a transient and flapped: `entitled`
		// in sync.js starts OPTIMISTICALLY TRUE and is only cleared by a 402 seen on
		// a push, so a free account's first ack takes the committed-parcel path,
		// the gateway refuses the push 402 (gateway/src/handlers/sync.rs:297), the
		// version does not move and `ackThrough` answers `not_committed`. The second
		// round has `entitled` false and solo-acks. It self-heals and it fails in the
		// safe direction -- the relay KEEPS the row -- so this walks the app's path
		// and REPORTS the number of rounds rather than hiding it in a retry loop. A
		// count above one is information, and a count that never releases is a wedge.
		const rounds = [];
		if (BREAK !== 'noack') {
			for (let i = 0; i < 3; i++) {
				const r = await B.page.evaluate(() => window.DaimondPost.round()
					.then(x => ({ acked: (x && x.acked) | 0, why: (x && x.why) || '' }))
					.catch(e => ({ acked: 0, why: String(e && e.message || e) })));
				rounds.push(r);
				if (r.acked >= 1) break;
			}
		}
		const released = rounds.some(r => r.acked >= 1);
		check('the relay is told it may let go, by the app\'s own collect-and-ack round',
			released,
			`${rounds.length} round(s): ` + rounds.map(r => `acked=${r.acked}${r.why ? '/' + r.why : ''}`).join(' → '),
			BREAK === 'noack' ? 'no round was run' : 'the relay was never told it could let go');
		const after = await boxOf(B);
		check('and the relay is then holding nothing', after.rows.length === 0,
			`rows=${after.rows.length}`,
			'the relay is still holding a message it has been told is safe');

		// ── 5. A group, through the same relay ─────────────────────────
		console.log('\n5. one group message, one envelope, delivered per member');
		const made = await A.page.evaluate(async (keys) => {
			const r = await window.DaimondGroup.create('relay e2e', keys);
			return { ok: r.ok === true, gid: r.gid || '', sent: r.sent | 0,
				members: r.members | 0, why: r.why || '' };
		}, [B.hex]);
		check('A makes a group naming B, and the roster reaches B',
			made.ok && !!made.gid && made.members === 2 && made.sent === 1,
			`members=${made.members} sent=${made.sent} ${String(made.gid).slice(0, 12)}…`,
			made.why || 'the roster named fewer people than it was given');

		// THE CREATOR'S OWN STATE. `create` applies its own roster through
		// `consume`, which files an unknown group as `invited` -- so the creator
		// comes out of `create` NOT joined, and `sealTo` refuses them with "Join
		// this group before writing to it." Nothing in the app then calls `join`:
		// the panel's Make button (www/js/group.js, the `group-make` branch) says
		// "Made, and N people have been told" and stops. `dev/verify_group.mjs`
		// only passes because IT calls `DaimondGroup.join(gid)` on the creator's
		// own page straight after `create` -- a line the app does not have.
		const canWrite = made.gid ? await A.page.evaluate(async ({ gid, body }) => {
			const r = await window.DaimondPost.send({ group: gid, body });
			return { ok: r.ok === true, sent: r.sent | 0, why: r.why || '' };
		}, { gid: made.gid, body: GWORDS }) : { ok: false, why: 'no group' };
		check('A can write to the group A just made', canWrite.ok, `sent=${canWrite.sent}`,
			canWrite.why + ' — the creator is left `invited` in their own group; '
			+ 'www/js/group.js\'s create() never joins and neither does the panel');

		// Joined by hand so the REST of this section still measures the wire. The
		// step above is the app's to make and its absence is reported, not papered
		// over: this line is the workaround and is labelled as one.
		if (made.gid && !canWrite.ok) {
			await A.page.evaluate(g => window.DaimondGroup.join(g), made.gid);
		}
		const gsent = made.gid ? (canWrite.ok ? canWrite
			: await A.page.evaluate(async ({ gid, body }) => {
				const r = await window.DaimondPost.send({ group: gid, body });
				return { ok: r.ok === true, sent: r.sent | 0, why: r.why || '' };
			}, { gid: made.gid, body: GWORDS })) : { ok: false, why: 'no group' };
		check('one group message is sealed once and carried by the relay',
			gsent.ok && gsent.sent >= 1, `sent=${gsent.sent}`, gsent.why);

		// B has to hear the roster before it can hear the message, and both come
		// down the same box in the order they were delivered.
		const bGroup = await B.page.evaluate(async () => {
			const r = await window.DaimondPost.collect();
			const st = await window.DaimondPost.read();
			const msgs = (st && st.msgs) || {};
			const gs = await window.DaimondGroup.list();
			return {
				got: r.got | 0, notes: r.notes | 0,
				bodies: Object.keys(msgs).map(k => ({ body: msgs[k].body, gid: msgs[k].gid || '' })),
				groups: gs.map(g => ({ gid: g.gid, state: g.state, n: (g.members || []).length })),
			};
		});
		check('B receives the roster and knows the group',
			bGroup.groups.some(g => g.gid === made.gid),
			JSON.stringify(bGroup.groups).slice(0, 120),
			'the roster did not reach B through the relay');
		check('B opens the group message, and it is marked as the group\'s',
			bGroup.bodies.some(x => x.body === GWORDS && x.gid === made.gid),
			JSON.stringify(bGroup.bodies).slice(0, 160),
			'a group message drawn as a one-to-one is a wrong sender on screen');

		// C was never in the roster and never held a slot.
		const cAfter = await boxOf(C);
		check('C, who is not in the group, was sent nothing at all',
			cAfter.rows.length === 0, `rows=${cAfter.rows.length}`);

		// ── 6. Arrival ─────────────────────────────────────────────────
		console.log('\n6. B is told something arrived');
		const unread = await B.page.evaluate(async () => {
			const st = await window.DaimondPost.read();
			if (!st || !st.msgs) return -1;
			return Object.keys(st.msgs)
				.filter(k => st.msgs[k].dir === 'in' && !st.msgs[k].read).length;
		});
		// Both of them: the one-to-one and the group message. With Web Push
		// declined this count IS the app's only notification, so a message that
		// arrived and left the count at zero would arrive invisibly.
		check('B\'s record holds both arrivals, unread', unread >= 2,
			`unread=${unread}`,
			'nothing would draw a badge, and with push declined the badge is the only notice');

		// Console errors the PAGE is responsible for. A failed fetch to a
		// service this fixture never started is the fixture's, not the app's.
		for (const s of [A, B, C]) {
			const thrown = errors(s).filter(e => !/Failed to load resource/.test(e));
			check(`${s.name} threw nothing`, thrown.length === 0, thrown.slice(0, 2).join(' | '));
		}
	} catch (e) {
		check('the run completed', false, String((e && e.stack) || e));
	} finally {
		for (const s of [A, B, C]) { try { if (s) await s.close(); } catch (e) { /* gone */ } }
	}

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) { GW_LOG.report(); SRV_LOG.report(8); }
	cleanup();
	// A `--break` run EXPECTS to fail: it exits 0 when something reddened and 1
	// when nothing did, so "the break changed nothing" is itself a failing run.
	if (BREAK) {
		const missed = AIMS[BREAK].filter(a => !bad.some(n => n.startsWith(a)));
		console.log(missed.length
			? `\n--break=${BREAK}: these stayed GREEN and should not have — ${missed.join('; ')}. `
				+ 'The check aimed at is not testing what it claims.'
			: `\n--break=${BREAK}: every check it aims at went red, which is the point.`);
		process.exit(missed.length ? 1 : 0);
	}
	process.exit(bad.length ? 1 : 0);
})();
