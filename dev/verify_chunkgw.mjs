// verify_chunkgw.mjs — the chunk transport survives a lapsed session, and a
// deletion the gateway will not carry out is NOTICED rather than swallowed.
//
// TWO HALVES, ONE FILE, because they are the same file's two ways of going
// quiet.
//
// (A) THE 401. chunks.js was the sixth copy of the gateway `fetch` wrapper and
// the only one with no answer to a 401 at all. An hour into a sitting the
// gateway's session is gone and `missing()` reports EVERY address as missing —
// so the next sync re-encrypts and re-uploads the whole corpus — `putChunks()`
// throws, and the commit that lets the gateway sweep never lands. Every check
// below asserts on the REQUEST TRACE and on observable work (were bytes
// re-uploaded? did the sweep happen?), never on `state.authed`, which is the
// flag that was lying. The session is ended SERVER-SIDE with a raw POST to
// /api/auth/logout, which leaves precisely the production state: a live page
// holding a cookie that names nothing.
//
// (B) THE SWEEP FLOOR. `sweep_chunks` used to delete whatever a commit did not
// name, on one request, and a client bug did exactly that to a real account. It
// now refuses any sweep over half the chunks an account holds: nothing is
// deleted, the commit still succeeds, and the reply carries `sweep_held_back`,
// `sweep_held` and a `sweep_token` that the identical commit may quote to carry
// the deletion out. No client sent the token, so large deletions were simply
// never collected — silently, and the storage ceilings are computed from the
// committed index rather than from chunks held, so held-back chunks are charged
// to no cap at all.
//
// The checks here are written so that a deletion which silently does not happen
// CANNOT pass: each one asserts both what the gateway still holds and what the
// client says about it, and the "names nothing" case exists precisely to be the
// deletion that must not be collected and must be reported.
//
// Needs dev/serve.mjs (:8777) and a daimond_gateway on :9002; it starts its own
// if none is up, and stops what it started.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';
import { makePagePro } from './pro.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GWDIR  = path.resolve(__dirname, '..', 'gateway');
const GW_URL = 'http://127.0.0.1:9002';
const SRC    = path.resolve(__dirname, '..', 'www', 'js', 'chunks.js');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(fn, ms = 20000, gap = 250) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		try { if (await fn()) return true; } catch (e) { /* keep waiting */ }
		await sleep(gap);
	}
	return false;
}

// The binary built into the isolated target dir is the current one; the copy
// under gateway/target may be older, and a stale gateway here would answer
// without a sweep floor at all and every check in (B) would pass for the wrong
// reason. Newest wins, and the version is asserted below in any case.
const BINS = [
	path.join(os.homedir(), '.cache/cargo-targets/gateway_target/release/daimond_gateway'),
	path.join(GWDIR, 'target/release/daimond_gateway'),
].filter(p => fs.existsSync(p));
BINS.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

let gw = null;
const alreadyUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok, 800, 200);
if (alreadyUp) {
	console.log('  ok   using the gateway already on :9002');
} else {
	if (!BINS.length) {
		console.log('SKIP verify_chunkgw — no daimond_gateway binary built');
		process.exit(0);
	}
	gw = spawn(BINS[0], [], { cwd: GWDIR, env: { ...process.env, APP_MODE: 'sandbox' }, stdio: 'ignore' });
	check('gateway starts', await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok),
		BINS[0]);
}

const s = await open({ name: 'chunkgw', signIn: true, connect: false });
const { page } = s;

try {
	await page.waitForFunction(
		() => !!window.DaimondChunks && !!window.DaimondGateway && !!window.DaimondCore
			&& !!window.DaimondCloud && !!window.DaimondSync && DaimondGateway.state().authed,
		null, { timeout: 15000 },
	).catch(() => {});
	check('the chunk module and an authed session are live',
		await page.evaluate(() => !!window.DaimondChunks && DaimondGateway.state().authed));

	const lic = await makePagePro(page, GWDIR, GW_URL);
	check('the account holds Pro, so the chunk store will accept an upload',
		lic.pro === true, `webhook ${lic.status}, pro=${lic.pro}`);

	// ── The instrument ─────────────────────────────────────────────────
	// Every /api/ request, with the chunk `op` pulled out of the body, so a
	// commit can be told from a put in a trace where the URL is the same for
	// both. `__realFetch` is kept back so this file's own questions never land
	// in its own trace.
	await page.evaluate(() => {
		window.__seen = [];
		const real = window.fetch;
		window.__realFetch = real;
		window.fetch = async function (u, o) {
			const url    = String((u && u.url) || u || '');
			const method = (o && o.method) || (u && u.method) || 'GET';
			let op = '', body = null;
			try { body = JSON.parse((o && o.body) || 'null'); op = (body && body.op) || ''; } catch (e) {}
			const r = await real.apply(this, arguments);
			if (url.indexOf('/api/') !== -1) window.__seen.push({ url, method, status: r.status, op, body });
			return r;
		};
	});
	// The wake channel would pull in the middle of a measurement.
	await page.evaluate(() => { try { window.DaimondSync.wakeVia('off'); } catch (e) {} });

	const trace     = () => page.evaluate(() => window.__seen.map(e => ({ ...e, body: undefined })));
	const bodies    = () => page.evaluate(() => window.__seen.map(e => e.body));
	const clear     = () => page.evaluate(() => { window.__seen.length = 0; });
	const killSess  = () => page.evaluate(() => window.__realFetch('/api/auth/logout', {
		method: 'POST', credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
	}));
	/// The statuses seen for one chunk op, in order.
	const ops = (tr, op) => tr.filter(e => e.url.indexOf('/api/chunk') !== -1 && e.op === op).map(e => e.status);
	/// Refused, then served: the shape a wired caller leaves behind. A single
	/// 200 is NOT a pass — it would mean the request never met the expiry.
	const retried = st => st.length === 2 && st[0] === 401 && st[1] !== 401;

	// A settled sync, so the engine's own idle pushes are no-ops for the rest of
	// the run and cannot commit an index over the top of a measurement.
	await page.evaluate(() => window.DaimondSync.push());
	await sleep(400);

	// ── Page-side helpers ──────────────────────────────────────────────
	// Chunks are seeded through the REAL upload path — sealed with the account
	// key, addressed by the SHA-256 of the ciphertext, verified by the gateway —
	// so what is committed against below is a genuine account store.
	await page.evaluate(() => {
		window.__seed = async function (n) {
			const out = [];
			for (let i = 0; i < n; i++) {
				const ct = await DaimondIdentity.wrapBytes(
					new TextEncoder().encode('seed-' + i + '-' + Math.random()));
				out.push({
					addr: await DaimondChunks._sha256Hex(ct),
					blob: DaimondChunks._b64urlEncode(ct),
					size: ct.length,
				});
			}
			const r = await fetch('/api/chunk', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
				body: JSON.stringify({ op: 'put', chunks: out.map(c => ({ addr: c.addr, blob: c.blob })) }),
			});
			const j = await r.json();
			if (!j || !j.ok) throw new Error('seed put failed: ' + r.status);
			return out;
		};
		/// A manifests map naming `chunks`, one file per chunk — the shape
		/// `DaimondCloud.index()` hands `commit`.
		window.__manifests = function (chunks) {
			const m = {};
			chunks.forEach((c, i) => {
				m['seed-' + i + '.bin'] = { v: 2, size: c.size, key: 'k' + i, chunks: [{ addr: c.addr, size: c.size }] };
			});
			return m;
		};
		/// Which of these addresses the gateway still holds.
		window.__held = async function (addrs) {
			const r = await fetch('/api/chunk', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
				body: JSON.stringify({ op: 'have', addrs }),
			});
			const j = await r.json();
			const gone = new Set(j.missing || []);
			return addrs.filter(a => !gone.has(a));
		};
		/// The account's current sync blob version — what a commit must name.
		window.__version = async function () {
			const r = await fetch('/api/sync', { credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			const j = await r.json();
			return j.version | 0;
		};
		/// Wipe the account's chunk store, so each case starts from a known one.
		/// Through the commit path with an explicit confirmation, which is the
		/// only way to empty it — and it is the client's own escape hatch, so
		/// the reset exercises that too.
		window.__wipe = async function () {
			const v = await window.__version();
			await DaimondChunks.commit({}, v, null);
			if (DaimondChunks.state().standing) await DaimondChunks.confirmHeldSweep();
			return DaimondChunks.state();
		};
	});

	// ═══ (A) A lapsed session ══════════════════════════════════════════

	await killSess();
	const unaware = await page.evaluate(async () => {
		const r = await window.__realFetch('/api/chunk', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ op: 'have', addrs: [] }),
		});
		return { status: r.status, authed: DaimondGateway.state().authed };
	});
	check('the session really is gone on the gateway (a bare /api/chunk is 401)',
		unaware.status === 401, 'status=' + unaware.status);
	check('and the page still believes it is signed in — which is the bug',
		unaware.authed === true);

	// (A1) `have`, and the harm a refused one does. The file is offloaded once
	// with a live session, which fills the chunk map; the session is then killed
	// and the SAME file offloaded again. With the 401 answered, every chunk is
	// recognised and NOTHING is uploaded. Unanswered, `missing()` reports every
	// address as missing and the whole file is re-encrypted and sent again —
	// which is the observable, not a flag.
	await page.evaluate(() => DaimondGateway.bootstrap());	// a live session to seed from.
	const f1 = await page.evaluate(async () => {
		const body = new Uint8Array(600 * 1024).map((_, i) => (i * 7) % 251);
		window.__file = new File([body], 'big.bin');
		try {
			const m = await DaimondChunks.offloadFile('big.bin', window.__file);
			return { chunks: m.chunks.length };
		} catch (e) { return { chunks: 0, err: (e && e.message) || String(e) }; }
	});
	check('a 600 KiB file offloads into several chunks', f1.chunks >= 2,
		f1.chunks + ' chunks' + (f1.err ? ' — ' + f1.err : ''));

	await killSess();
	await clear();
	const f2 = await page.evaluate(() => DaimondChunks.offloadFile('big.bin', window.__file)
		.catch(e => ({ chunks: [], err: (e && e.message) || String(e) })));
	const trA1 = await trace();
	check('have: the refused query is re-authenticated and asked again',
		retried(ops(trA1, 'have')), 'statuses ' + JSON.stringify(ops(trA1, 'have')));
	check('have: and NOTHING is re-uploaded — the corpus is not resent over an expiry',
		ops(trA1, 'put').length === 0, ops(trA1, 'put').length + ' put requests');
	check('have: the same manifest comes back, chunk for chunk',
		f2.chunks.length === f1.chunks);

	// (A2) `put`: a file the store has never seen, offloaded over a dead
	// session. It used to throw `chunk put failed: 401`.
	await killSess();
	await clear();
	const f3 = await page.evaluate(async () => {
		const body = new Uint8Array(400 * 1024).map((_, i) => (i * 13 + 5) % 251);
		try {
			const m = await DaimondChunks.offloadFile('other.bin', new File([body], 'other.bin'));
			return { ok: true, chunks: m.chunks.length };
		} catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
	});
	const trA2 = await trace();
	check('put: the refused upload is re-authenticated and sent again',
		retried(ops(trA2, 'put').slice(0, 2)), 'statuses ' + JSON.stringify(ops(trA2, 'put')));
	check('put: and the offload finishes rather than throwing "chunk put failed: 401"',
		f3.ok === true, f3.ok ? '' : f3.err);

	// (A3) `commit`: the request whose loss means the gateway never sweeps.
	// Set up on a live session — the helpers below are raw `fetch` on purpose,
	// so they measure rather than repair — and kill it only once the account's
	// store is in a known state.
	await page.evaluate(() => DaimondGateway.bootstrap());
	await page.evaluate(() => window.__wipe());
	await page.evaluate(() => window.__seed(4).then(c => (window.__c = c)));
	await page.evaluate(async () => {
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c), v, null);
	});
	// The version is read while there is still a session to read it with. It is
	// a plain GET on /api/sync and a lapsed one answers 401, which would have
	// this commit name version 0 and be refused as STALE rather than for the
	// reason under test — a 409 that would look like a pass on a careless check.
	await page.evaluate(async () => { window.__v = await window.__version(); });
	await killSess();
	await clear();
	const commitA = await page.evaluate(() =>
		// Three of four live: one goes, which is what an edit looks like and is
		// well under the floor, so the sweep must simply happen.
		DaimondChunks.commit(window.__manifests(window.__c.slice(0, 3)), window.__v, null));
	const trA3 = await trace();
	check('commit: the refused commit is re-authenticated and sent again',
		retried(ops(trA3, 'commit')), 'statuses ' + JSON.stringify(ops(trA3, 'commit')));
	check('commit: and the sweep it authorises actually lands',
		commitA && commitA.swept === 1, JSON.stringify(commitA && { swept: commitA.swept }));
	const goneA = await page.evaluate(() => window.__held([window.__c[3].addr]));
	check('commit: the gateway no longer holds the chunk the commit dropped',
		goneA.length === 0, goneA.length + ' still held');

	// (A4) LATE-BOUND, NEVER CAPTURED. `DaimondGateway.gwFetch` is replaced at
	// runtime; a file that captured it into a local at load would sail straight
	// past the replacement, and a file that looks it up per call cannot.
	const bound = await page.evaluate(async () => {
		const real = DaimondGateway.gwFetch;
		let seen = 0;
		DaimondGateway.gwFetch = function () { seen++; return real.apply(this, arguments); };
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c.slice(0, 3)), v, null);
		DaimondGateway.gwFetch = real;
		return seen;
	});
	check('every chunk request goes through the CURRENT DaimondGateway.gwFetch',
		bound >= 1, bound + ' calls saw the replacement');

	// (A5) And the file keeps no private copy of the two things gateway.js owns.
	const src = fs.readFileSync(SRC, 'utf8');
	check('chunks.js carries no CLIENT_API of its own',
		!/CLIENT_API/.test(src));
	check('chunks.js makes no bare fetch() call',
		!/[^.\w]fetch\s*\(/.test(src.replace(/gwFetch\s*\(/g, 'gwF(')),
		(src.match(/[^.\w]fetch\s*\(/g) || []).join(' '));

	// ═══ (B) A sweep the gateway will not carry out ════════════════════

	// A session to run the rest on, whatever (A) left behind. The two halves are
	// independent on purpose: breaking the 401 wiring must not take the sweep
	// checks down with it, or a red run says nothing about which half moved.
	await page.evaluate(() => DaimondGateway.bootstrap());

	// (B0) The gateway under test really has a floor. Without this, every check
	// below would pass against an older binary for entirely the wrong reason.
	await page.evaluate(() => window.__wipe());
	await page.evaluate(() => window.__seed(4).then(c => (window.__c = c)));
	await page.evaluate(async () => {
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c), v, null);
	});
	const floor = await page.evaluate(async () => {
		// Straight to the gateway, around the client, so what is measured is the
		// contract and not this client's answer to it.
		const v = await window.__version();
		const r = await window.__realFetch('/api/chunk', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({
				op: 'commit', blob_version: v,
				chunks: [{ addr: window.__c[0].addr, size: window.__c[0].size, tier: 'p' }],
			}),
		});
		return { status: r.status, j: await r.json() };
	});
	check('the gateway refuses a sweep over the half floor, and says so',
		floor.status === 200 && floor.j.ok === true && floor.j.swept === 0
		&& floor.j.sweep_held_back === 3 && floor.j.sweep_held === 4 && !!floor.j.sweep_token,
		JSON.stringify(floor.j));
	const survived = await page.evaluate(() => window.__held(window.__c.map(c => c.addr)));
	check('and it deleted nothing at all', survived.length === 4, survived.length + ' of 4 held');

	// (B1) An ordinary sweep is untouched by any of this: without this check the
	// client would be indistinguishable from one that never sweeps.
	await page.evaluate(() => window.__wipe());
	await page.evaluate(() => window.__seed(8).then(c => (window.__c = c)));
	await page.evaluate(async () => {
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c), v, null);
	});
	await clear();
	const ord = await page.evaluate(async () => {
		const v = await window.__version();
		const j = await DaimondChunks.commit(window.__manifests(window.__c.slice(0, 7)), v, null);
		return { j, st: DaimondChunks.state() };
	});
	const trB1 = await trace();
	check('an ordinary sweep still collects its garbage, on one request',
		ord.j && ord.j.swept === 1 && ops(trB1, 'commit').length === 1,
		JSON.stringify({ swept: ord.j && ord.j.swept, requests: ops(trB1, 'commit').length }));
	check('and nothing is left standing over it',
		ord.st.standing === false && ord.st.heldBack === 0, JSON.stringify(ord.st));

	// (B2) A large deletion this client can account for is confirmed, and the
	// chunks REALLY GO. Two requests that agree, with the gateway's answer in
	// between — and never a third.
	await page.evaluate(() => window.__wipe());
	await page.evaluate(() => window.__seed(4).then(c => (window.__c = c)));
	await page.evaluate(async () => {
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c), v, null);
	});
	await clear();
	const conf = await page.evaluate(async () => {
		const before = DaimondChunks.state().confirmed;
		const v = await window.__version();
		const j = await DaimondChunks.commit(window.__manifests(window.__c.slice(0, 1)), v, null);
		return { j, before, st: DaimondChunks.state(), held: await window.__held(window.__c.map(c => c.addr)) };
	});
	const trB2 = await trace();
	check('a large deletion the client can account for is confirmed and runs',
		conf.j && conf.j.swept === 3, JSON.stringify(conf.j && { swept: conf.j.swept, back: conf.j.sweep_held_back }));
	check('and the gateway really has stopped holding those chunks',
		conf.held.length === 1, conf.held.length + ' of 4 still held');
	check('it cost exactly TWO commits — the interlock was honoured, not bypassed',
		ops(trB2, 'commit').length === 2, JSON.stringify(ops(trB2, 'commit')));
	check('and nothing is left standing, with the confirmation counted',
		conf.st.standing === false && conf.st.confirmed === conf.before + 1, JSON.stringify(conf.st));

	// (B3) The second commit is IDENTICAL bar the token. A rebuilt body would
	// name a different deletion and the token would not match it.
	const bs = (await bodies()).filter(b => b && b.op === 'commit');
	const same = bs.length === 2
		&& JSON.stringify({ ...bs[0], sweep_token: undefined }) === JSON.stringify({ ...bs[1], sweep_token: undefined })
		&& !bs[0].sweep_token && !!bs[1].sweep_token;
	check('the confirmation repeats the identical commit, adding only the token',
		same, bs.length + ' commit bodies');

	// (B4) THE ONE THAT MUST BE ABLE TO FAIL. An index naming nothing is the
	// sharpest form of a client that knows nothing declaring the account empty.
	// This client never confirms one — so the deletion does NOT happen, and the
	// whole point of this check is that the app SAYS SO. A test that only
	// asserted the chunks survived would pass just as well over silence.
	await page.evaluate(() => window.__wipe());
	await page.evaluate(() => window.__seed(4).then(c => (window.__c = c)));
	await page.evaluate(async () => {
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c), v, null);
	});
	await clear();
	const nil = await page.evaluate(async () => {
		const v = await window.__version();
		const j = await DaimondChunks.commit({}, v, null);
		const chip = document.getElementById('chunk-chip');
		return {
			j, st: DaimondChunks.state(),
			held: (await window.__held(window.__c.map(c => c.addr))).length,
			chip: chip ? {
				shown: getComputedStyle(chip).display !== 'none',
				text:  (chip.textContent || '').trim(),
				title: chip.title || '',
			} : null,
		};
	});
	const trB4 = await trace();
	check('an index naming nothing empties nothing', nil.held === 4, nil.held + ' of 4 held');
	check('and the client does not insist: exactly ONE commit, never a loop',
		ops(trB4, 'commit').length === 1, JSON.stringify(ops(trB4, 'commit')));
	check('the deletion that did not happen is RECORDED, with its reason',
		nil.st.standing === true && nil.st.why === 'names_nothing'
		&& nil.st.heldBack === 4 && nil.st.held === 4, JSON.stringify(nil.st));
	check('and it is SAID: a standing chip in the top bar, not a console line',
		!!nil.chip && nil.chip.shown === true && nil.chip.text.length > 0,
		JSON.stringify(nil.chip && { shown: nil.chip.shown, text: nil.chip.text }));
	check('the chip is a translated sentence, not a bare key',
		!!nil.chip && !/^chunks\./.test(nil.chip.text) && !/^chunks\./.test(nil.chip.title),
		nil.chip && nil.chip.text);
	check('and its hover carries both numbers, so the size of it is knowable',
		!!nil.chip && nil.chip.title.indexOf('4') !== -1 && nil.chip.title.length > 40,
		nil.chip && nil.chip.title.slice(0, 70));

	// (B5) The operator's escape hatch really carries that deletion out.
	const forced = await page.evaluate(async () => {
		const j = await DaimondChunks.confirmHeldSweep();
		return { j, st: DaimondChunks.state(), held: (await window.__held(window.__c.map(c => c.addr))).length };
	});
	check('a person confirming it deletes what the client would not on its own',
		forced.j && forced.j.swept === 4 && forced.held === 0,
		JSON.stringify({ swept: forced.j && forced.j.swept, held: forced.held }));
	check('and the standing notice clears with it',
		forced.st.standing === false, JSON.stringify(forced.st));

	// (B6) A device that may not declare a live set does not confirm one either.
	// sync gates the FIRST commit on this; the client re-asserts it immediately
	// before the destructive second request, which is the window where it moves.
	await page.evaluate(() => window.__wipe());
	await page.evaluate(() => window.__seed(4).then(c => (window.__c = c)));
	await page.evaluate(async () => {
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c), v, null);
	});
	await clear();
	const unmerged = await page.evaluate(async () => {
		const real = DaimondCore.syncMayCommitChunks;
		DaimondCore.syncMayCommitChunks = function () { return false; };
		const v = await window.__version();
		const j = await DaimondChunks.commit(window.__manifests(window.__c.slice(0, 1)), v, null);
		DaimondCore.syncMayCommitChunks = real;
		return { j, st: DaimondChunks.state(), held: (await window.__held(window.__c.map(c => c.addr))).length };
	});
	const trB6 = await trace();
	check('a device whose index is not a merged one does not confirm a deletion',
		unmerged.held === 4 && unmerged.st.standing === true && unmerged.st.why === 'not_merged',
		JSON.stringify({ held: unmerged.held, why: unmerged.st.why }));
	check('and it made no second attempt at it',
		ops(trB6, 'commit').length === 1, JSON.stringify(ops(trB6, 'commit')));

	// (B7) Where the two parties cannot agree on the size of the corpus, the
	// client does not insist on the largest deletion the gateway will accept.
	// Here the index names a chunk the gateway has never held, so the gateway's
	// held-minus-doomed and the client's own count disagree by one.
	await page.evaluate(() => window.__wipe());
	await page.evaluate(() => window.__seed(4).then(c => (window.__c = c)));
	await page.evaluate(async () => {
		const v = await window.__version();
		await DaimondChunks.commit(window.__manifests(window.__c), v, null);
	});
	await clear();
	const phantom = await page.evaluate(async () => {
		const v = await window.__version();
		const m = window.__manifests(window.__c.slice(0, 1));
		m['ghost.bin'] = { v: 2, size: 9, key: 'kg', chunks: [{ addr: 'ab'.repeat(32), size: 9 }] };
		const j = await DaimondChunks.commit(m, v, null);
		return { j, st: DaimondChunks.state(), held: (await window.__held(window.__c.map(c => c.addr))).length };
	});
	const trB7 = await trace();
	check('an index the gateway cannot account for does not authorise a deletion',
		phantom.held === 4 && phantom.st.standing === true && phantom.st.why === 'unaccounted',
		JSON.stringify({ held: phantom.held, why: phantom.st.why }));
	check('and that too is one request, not two',
		ops(trB7, 'commit').length === 1, JSON.stringify(ops(trB7, 'commit')));

	// (B8) The notice is standing, not permanent: the next commit that collects
	// clears it. Without this the chip would be a scar rather than a state.
	const cleared = await page.evaluate(async () => {
		const v = await window.__version();
		const j = await DaimondChunks.commit(window.__manifests(window.__c.slice(0, 3)), v, null);
		const chip = document.getElementById('chunk-chip');
		return { j, st: DaimondChunks.state(), shown: chip ? getComputedStyle(chip).display !== 'none' : null };
	});
	check('a later commit that does collect clears the standing notice',
		cleared.j && cleared.j.swept === 1 && cleared.st.standing === false && cleared.shown === false,
		JSON.stringify({ swept: cleared.j && cleared.j.swept, standing: cleared.st.standing, shown: cleared.shown }));

	// (B9) Nothing was raised over the app through any of it. A deletion the
	// gateway declined is a report, not an interruption.
	const modals = await page.evaluate(() => [...document.querySelectorAll('.modal, .pair-scrim, .daimond-toast')]
		.filter(m => getComputedStyle(m).display !== 'none')
		.map(m => (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)));
	check('nothing was raised over the app through the whole run',
		modals.length === 0, modals.join(' | '));

	const errs = s.errs.filter(e =>
		!/favicon|ERR_|Failed to load resource|401|402|404|409|413|426|502|Unauthorized/.test(e)
		&& !/WebSocket connection to '[^']*\/api\/sync\/ws/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('no exception during the run', false, String((e && e.stack) || e));
} finally {
	try { await s.close(); } catch (e) { /* ignore */ }
	if (gw) { try { gw.kill('SIGTERM'); } catch (e) { /* ignore */ } }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
