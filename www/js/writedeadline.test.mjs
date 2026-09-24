/* ============================================================
   Test — every chunk op and every relay put has a deadline
   (www/js/chunks.js `call`, www/js/post.js `call`; P1a H3,
   2026-09-25).
   ------------------------------------------------------------
   `fetch` has no timeout. A request the network black-holes, or
   that iOS froze at suspension, hangs for as long as the operating
   system keeps the socket. A chunk op runs inside the parcel
   collect, so inside the push and its one-round gate; a relay put
   is an errand, a report or a message its sender is waiting on.
   Neither had a deadline.

   Drives the REAL modules against a `gwFetch` that NEVER ANSWERS,
   on a clock the test owns, and asserts each request ends at its
   deadline with a failure its caller already reads:

     C1. a chunk `have` query rejects at 60 s plus its body at
         64 KiB/s;
     C2. a chunk commit of ~1.4 MiB rejects at 60 s + 22 s, not later;
     P1. a relay put (`DaimondPost.post`) answers `ok:false` at 60 s
         plus its body;
     P2. a doorbell read is bounded the same way;
     P3. [ctl] the park keeps its own window (PARK_DEADLINE_MS),
         not the put's.

   Each fails on the release 4 files, where nothing ever settles:
     CHUNKS_JS=<r4>/www/js/chunks.js POST_JS=<r4>/www/js/post.js \
       node www/js/writedeadline.test.mjs
     node www/js/writedeadline.test.mjs          # ALL PASS
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE      = dirname(fileURLToPath(import.meta.url));
const CHUNKS_JS = process.env.CHUNKS_JS || join(HERE, 'chunks.js');
const POST_JS   = process.env.POST_JS || join(HERE, 'post.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await drain(); }

function makeClock(t0) {
	let now = t0, seq = 0;
	const timers = new Map();
	return {
		now: () => now,
		setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
		clearTimeout(id) { timers.delete(id); },
		setInterval(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: Math.max(1, ms || 1) }); return id; },
		clearInterval(id) { timers.delete(id); },
		async advance(ms) {
			const target = now + ms;
			for (let guard = 0; guard < 100000; guard++) {
				let pick = null;
				for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
				if (!pick) break;
				now = pick[1].at;
				if (pick[1].every) pick[1].at = now + pick[1].every; else timers.delete(pick[0]);
				try { pick[1].fn(); } catch (e) { console.log('  timer threw: ' + e); }
				await settle(6);
			}
			now = target;
			await settle(6);
		},
	};
}

/// A `gwFetch` nothing ever answers; each request records when it was made and when
/// its signal ended it.
function blackHole(clock) {
	const calls = [];
	const gwFetch = (url, opts) => {
		const rec = { url, at: clock.now(), end: -1, body: (opts && opts.body) || '' };
		calls.push(rec);
		return new Promise((res, rej) => {
			const sig = opts && opts.signal;
			if (!sig) return;
			const gone = () => { rec.end = clock.now(); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
			if (sig.aborted) { gone(); return; }
			sig.addEventListener('abort', gone);
		});
	};
	return { calls, gwFetch };
}

/// Race `p` against the virtual clock: advance up to `ms` and answer what `p` settled to.
async function within(clock, p, ms, step = 1000) {
	let out = { settled: false };
	p.then((v) => { out = { settled: true, ok: true, value: v }; },
		(e) => { out = { settled: true, ok: false, error: e }; });
	for (let t = 0; t < ms && !out.settled; t += step) await clock.advance(step);
	return out;
}

// ── chunks.js ──────────────────────────────────────────────────
{
	console.log('\nC. chunk ops against a gateway that never answers\n');
	const clock = makeClock(1757000000000);
	const hole  = blackHole(clock);
	const doc = { getElementById: () => null, querySelector: () => null,
		createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {},
			addEventListener: () => {}, querySelector: () => null }),
		head: { appendChild: () => {} }, body: { appendChild: () => {} } };
	const gateway = { clientApi: () => 1, gwFetch: hole.gwFetch };
	const win = { addEventListener: () => {}, dispatchEvent: () => true, DaimondGateway: gateway, document: doc };
	const store = new Map();
	const ls = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k) };
	const fn = new Function('window', 'document', 'DaimondGateway', 'localStorage', 'setTimeout', 'clearTimeout',
		'console', 'crypto', 'with (window) {\n' + readFileSync(CHUNKS_JS, 'utf8') + '\n}');
	fn(win, doc, gateway, ls, clock.setTimeout, clock.clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, { subtle: {} });
	const C = win.DaimondChunks;

	const r1 = await within(clock, C._missing(['a'.repeat(64)]), 600000);
	const c1 = hole.calls[0];
	check('C1. a `have` query nothing answers fails (release 4: never)', r1.settled && r1.ok === false,
		JSON.stringify({ settled: r1.settled }));
	check('C1. at 61 s', c1 && c1.end - c1.at === 61000, c1 ? (c1.end - c1.at) / 1000 + ' s' : 'no call');

	// A commit whose live set is ~1 MiB of addresses: 60 s plus 16 s of body.
	const live = {};
	for (let i = 0; i < 15000; i++) live['f' + i] = { v: 2, chunks: [{ addr: i.toString(16).padStart(64, '0') }] };
	const r2 = await within(clock, C.commit(live, 7, null), 900000);
	const c2 = hole.calls[hole.calls.length - 1];
	const want2 = Math.min(300000, 60000 + Math.ceil(c2.body.length / 65536) * 1000);
	check('C2. a large op nothing answers fails (release 4: never)', r2.settled && r2.ok === false,
		JSON.stringify({ settled: r2.settled }));
	check('C2. at 60 s plus its ' + Math.round(c2.body.length / 1024) + ' KiB body at 64 KiB/s',
		c2.end - c2.at === want2, (c2.end - c2.at) / 1000 + ' s, want ' + want2 / 1000 + ' s');
}

// ── post.js ────────────────────────────────────────────────────
{
	console.log('\nP. relay requests against a gateway that never answers\n');
	const clock = makeClock(1757000000000);
	const hole  = blackHole(clock);
	class Ctl {
		constructor() { this.signal = { aborted: false, _on: [], addEventListener(k, f) { this._on.push(f); } }; }
		abort() { if (this.signal.aborted) return; this.signal.aborted = true; this.signal._on.forEach((f) => { try { f({}); } catch (e) {} }); }
	}
	const local = new Map();
	const document = { readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {}, setAttribute() {},
			appendChild(c) { return c; }, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
	const win = { addEventListener() {}, dispatchEvent: () => true, Date: { now: clock.now },
		location: { origin: 'https://example.test', href: 'https://example.test/' }, navigator: { onLine: true },
		localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)),
			removeItem: (k) => local.delete(k) },
		DaimondIdentity: { isUnlocked: () => true, publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
			wrap: async (s) => s, unwrap: async (s) => s, deviceId: () => 'dev-self' },
		DaimondGateway: { clientApi: () => 9, gwFetch: hole.gwFetch },
		AbortController: Ctl };
	win.window = win;
	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'Date', 'AbortController', 'with (window) {\n' + readFileSync(POST_JS, 'utf8') + '\n}');
	fn(win, document, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval, { now: clock.now }, Ctl);
	await settle(20);
	const P = win.DaimondPost;

	const env = 'e'.repeat(200 * 1024);
	const n0 = hole.calls.length;
	const r1 = await within(clock, P.post({ to: 'pub-self', addr: 'post1abc', envelope: env }), 600000);
	const c1 = hole.calls[n0];
	const want1 = 60000 + Math.ceil(c1.body.length / 65536) * 1000;
	check('P1. a relay put nothing answers answers ok:false (release 4: never)', r1.settled && r1.ok
		&& r1.value && r1.value.ok === false, JSON.stringify(r1.settled ? r1.value : { settled: false }));
	check('P1. at 60 s plus its ' + Math.round(c1.body.length / 1024) + ' KiB body', c1.end - c1.at === want1,
		(c1.end - c1.at) / 1000 + ' s, want ' + want1 / 1000 + ' s');

	const n1 = hole.calls.length;
	const r2 = await within(clock, P.doorbell ? P.doorbell() : Promise.resolve({ ok: false, skip: true }), 600000);
	const c2 = hole.calls[n1];
	check('P2. a relay read nothing answers is bounded too (release 4: never)', r2.settled
		&& (!c2 || c2.end - c2.at === 60000), c2 ? (c2.end - c2.at) / 1000 + ' s' : 'no doorbell verb');

	const n2 = hole.calls.length;
	P.parkStart();
	await settle(20);
	await clock.advance(60000);
	const park = hole.calls.slice(n2).find((c) => /above=/.test(c.url));
	check('P3. [ctl] the park keeps its own window: cut at 55 s', park && park.end - park.at === 55000,
		park ? (park.end - park.at) / 1000 + ' s' : 'no park');
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
