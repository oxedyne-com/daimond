// gateway: live
// verify_gwdl1_rollback.mjs — the held-back set survives a gateway rollback both ways (DL-1).
//
// The gateway from 2026-09-27 keeps an account's held-back deletion as a record of its own
// (`chold:<account>`), declared until a person's token carries it out or an index names it
// again, and it ignores a sweep token that does not say a person gave it. Neither is in a
// gateway before it. So a rollback has two questions, and this asks both over ONE account on
// ONE store:
//
//   1. The new gateway writes a held-back set; the OLD gateway is put on the same store and
//      port. Does it start, serve the account, keep every chunk, and take a whole commit?
//   2. The NEW gateway is put back on the store the old one has written since, with the
//      held-back record now stale (the old gateway's index names those chunks again). Does it
//      read the account, clear the stale hold on the next whole commit, and still hold back,
//      refuse an unmarked token, and honour a person's?
//
// Needs a gateway already up on DAIMOND_GW_PORT (:9002 by default); it does not start one.
// Run standalone it answers only the new gateway's half. With GWDL1_SWAP=<path> it is a
// rollback probe: it writes <path>.1.ready and waits for <path>.1.done, which the runner writes
// after putting the OLD gateway on the same store and port; then <path>.2.ready / .2.done for
// the NEW one again (notes/daimond_fixbrief_r53_gwdl1/gwdl1_swap.sh).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GWDIR = path.resolve(__dirname, '..', 'gateway');
const SWAP  = process.env.GWDL1_SWAP || '';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Ask the runner for the next gateway and wait until it is serving.
async function swap(n) {
	fs.writeFileSync(`${SWAP}.${n}.ready`, String(Date.now()));
	const t0 = Date.now();
	while (!fs.existsSync(`${SWAP}.${n}.done`) && Date.now() - t0 < 120000) await sleep(500);
	return fs.existsSync(`${SWAP}.${n}.done`)
		? fs.readFileSync(`${SWAP}.${n}.done`, 'utf8').trim() : `no swap ${n} inside 120 s`;
}

const s = await open({ name: 'gwdl1rb', signIn: true, connect: false });
const { page } = s;

try {
	await page.waitForFunction(
		() => !!window.DaimondChunks && !!window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 15000 },
	).catch(() => {});
	const lic = await makePagePro(page, GWDIR, GW_URL);
	check('the account holds Pro, so the chunk store will accept an upload', lic.pro === true,
		`webhook ${lic.status}, pro=${lic.pro}`);
	// The engine's own rounds would commit over the top of every measurement below.
	await page.evaluate(() => { try { window.DaimondSync.wakeVia('off'); } catch (e) {} });
	await page.evaluate(() => window.DaimondSync.push());
	await sleep(400);

	// Raw requests only: this measures the gateway, not the page's answer to it.
	await page.evaluate(() => {
		const api = (body) => fetch('/api/chunk', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '2' },
			body: JSON.stringify(body),
		}).then(async r => ({ status: r.status, j: await r.json().catch(() => ({})) }));
		window.__api = api;
		window.__version = async () => {
			const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '2' } });
			return ((await r.json()).version) | 0;
		};
		window.__seed = async (n, tag) => {
			const out = [];
			for (let i = 0; i < n; i++) {
				const ct = await DaimondIdentity.wrapBytes(new TextEncoder().encode(tag + '-' + i + '-' + Math.random()));
				out.push({ addr: await DaimondChunks._sha256Hex(ct), blob: DaimondChunks._b64urlEncode(ct), size: ct.length });
			}
			const r = await api({ op: 'put', chunks: out.map(c => ({ addr: c.addr, blob: c.blob })) });
			if (!r.j.ok) throw new Error('seed put failed: ' + r.status);
			return out.map(c => ({ addr: c.addr, size: c.size }));
		};
		window.__commit = async (chunks, extra) => api(Object.assign({
			op: 'commit', blob_version: await window.__version(),
			chunks: chunks.map(c => ({ addr: c.addr, size: c.size, tier: 'p' })),
		}, extra || {}));
		window.__held = async (chunks) => {
			const r = await api({ op: 'have', addrs: chunks.map(c => c.addr) });
			const gone = new Set(r.j.missing || []);
			return chunks.filter(c => !gone.has(c.addr)).length;
		};
	});
	// From here, not from the page: the page's network guard keeps it to its own origin.
	const health = async () => {
		try { return await (await fetch(GW_URL + '/api/health')).json(); } catch (e) { return { err: String(e) }; }
	};

	// ── The new gateway writes a held-back set ────────────────────────────
	const a = await page.evaluate(async () => {
		window.__c = await window.__seed(4, 'rb');
		// Two more, declared and then dropped within the floor: released, so the store
		// holds a `crel:` record when the old gateway starts on it.
		window.__r = await window.__seed(2, 'rbrel');
		const both   = await window.__commit(window.__c.concat(window.__r));
		const rel    = await window.__commit(window.__c);
		const whole  = await window.__commit(window.__c);
		const narrow = await window.__commit(window.__c.slice(0, 1));
		window.__token = narrow.j.sweep_token;
		return { both: both.j, rel: rel.j, whole: whole.j, narrow: narrow.j,
			held: await window.__held(window.__c), kept: await window.__held(window.__r) };
	});
	check('the new gateway releases a drop within the floor and keeps it (a crel: record)',
		a.both.ok === true && a.rel.released === 2 && a.rel.swept === 0 && a.kept === 2,
		JSON.stringify({ rel: a.rel, kept: a.kept }));
	check('the new gateway holds a narrow commit back (3 of 4 declared)',
		a.whole.swept === 0 && a.narrow.swept === 0 && a.narrow.sweep_held_back === 3
		&& a.narrow.sweep_held === 4 && !!a.narrow.sweep_token && a.held === 4,
		JSON.stringify({ narrow: a.narrow, held: a.held }));

	if (SWAP) {
		// ── The OLD gateway on the store the new one wrote ────────────────
		const d1 = await swap(1);
		console.log('  swap 1: ' + d1);
		check('THE OLD GATEWAY STARTS AND SERVES THIS STORE',
			/swapped/.test(d1) && /"store_ok": ?true/.test(d1), d1);
		const b = await page.evaluate(async () => {
			const held  = await window.__held(window.__c);
			// A whole view, as the phone would send: the old gateway records it and sweeps nothing.
			const whole = await window.__commit(window.__c);
			// And it takes new work: two more chunks, declared by the old gateway's own commit.
			window.__d = await window.__seed(2, 'rbold');
			const more  = await window.__commit(window.__c.concat(window.__d));
			return { held, whole: whole.j, more: more.j, after: await window.__held(window.__c.concat(window.__d)) };
		});
		check('the old gateway still holds every chunk the new one held back', b.held === 4, String(b.held));
		check('and takes a whole commit and new work on that store, deleting nothing',
			b.whole.ok === true && b.whole.swept === 0 && b.more.ok === true && b.more.swept === 0 && b.after === 6,
			JSON.stringify({ whole: b.whole.swept, more: b.more.swept, after: b.after }));

		// ── The NEW gateway on the store the old one wrote ────────────────
		const d2 = await swap(2);
		console.log('  swap 2: ' + d2);
		check('THE NEW GATEWAY STARTS AND SERVES THE STORE THE OLD ONE WROTE',
			/swapped/.test(d2) && /"store_write_ok": ?true/.test(d2), d2);
	}

	// ── The new gateway, after a whole view: the hold is lifted, the floor holds ──
	const c = await page.evaluate(async (swapped) => {
		// The account's whole declared set at this point.
		const every  = swapped ? window.__c.concat(window.__d) : window.__c;
		const whole  = await window.__commit(every);
		const narrow = await window.__commit(every.slice(0, 1));
		const alone  = await window.__commit(every.slice(0, 1), { sweep_token: narrow.j.sweep_token });
		const keptAlone = await window.__held(every);
		const person = await window.__commit(every.slice(0, 1),
			{ sweep_token: narrow.j.sweep_token, sweep_confirm: 'person' });
		return { n: every.length, whole: whole.j, narrow: narrow.j, alone: alone.j, keptAlone,
			person: person.j, after: await window.__held(every) };
	}, !!SWAP);
	check('a whole commit sweeps nothing and lifts the stale hold',
		c.whole.ok === true && c.whole.swept === 0 && !c.whole.sweep_token, JSON.stringify(c.whole));
	check('a narrow commit is held back against everything declared',
		c.narrow.swept === 0 && c.narrow.sweep_held_back === c.n - 1 && c.narrow.sweep_held === c.n,
		JSON.stringify(c.narrow));
	check('a token no person gave is refused: held back again, nothing deleted',
		c.alone.swept === 0 && !!c.alone.sweep_token && c.keptAlone === c.n,
		JSON.stringify({ swept: c.alone.swept, kept: c.keptAlone }));
	check('a person\'s token releases them: kept 7 days, nothing deleted',
		c.person.swept === 0 && c.person.released === c.n - 1 && c.after === c.n,
		JSON.stringify({ released: c.person.released, after: c.after }));
	const back = await page.evaluate(async (swapped) => {
		const every = swapped ? window.__c.concat(window.__d) : window.__c;
		return (await window.__commit(every)).j;
	}, !!SWAP);
	check('a whole commit inside the week takes them back, with nobody asked',
		back.ok === true && back.released === 0 && !back.sweep_token, JSON.stringify(back));

	const h = await health();
	check('the gateway is healthy at the end', h && h.store_ok === true && h.store_write_ok === true,
		JSON.stringify(h));
} catch (e) {
	check('no exception during the run', false, String((e && e.stack) || e));
} finally {
	try { await s.close(); } catch (e) { /* ignore */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) {
	bad.forEach(b => console.log('  FAILED: ' + b));
	process.exit(1);
}
