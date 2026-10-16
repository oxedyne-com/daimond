/* ============================================================
   Test — one presence sweep at a time per page (CHUNK-HAVE fix 3).
   ------------------------------------------------------------
   The iPhone's `have` queries took 81-190 s on 13 Oct because the
   gateway read every chunk to answer them, and one page sent three
   sweeps of the same set within one second (06:27:50-51), so each
   landed on a gateway already carrying the others and all three
   passed the 63 s deadline (diag_chunkstall.md). The gateway now
   answers from Ozone's index; this is the page's half: however
   many callers ask at once, the page puts ONE `have` to the
   gateway at a time, and every caller still gets its whole answer.

   Kept as they were: every address is asked (the 18 lost
   addresses), HAVE_QUERY_BATCH is 2,000, the deadline is the
   call's own. A failed or thrown query frees the next caller.
   An upload's `missing` is `presence` underneath, so it shares
   the one lane too.

   Drives the REAL www/js/chunks.js in a simulated tab, with a
   `DaimondGateway.gwFetch` that holds each `have` open until the
   test lets it go, and counts how many are open at once.

   Run:  node www/js/havesingleflight.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: 'complete', addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	function CustomEventShim(t, o) { this.type = t; this.detail = o && o.detail; }
	const quiet = { debug: () => {}, log: () => {}, warn: console.warn, error: console.error };
	function loadScript(rel) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage',
			'TextEncoder', 'TextDecoder', 'CustomEvent', 'Blob',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis', 'navigator',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage,
			TextEncoder, TextDecoder, CustomEventShim, Blob,
			setTimeout, clearTimeout, setInterval, clearInterval,
			quiet, globalThis, { storage: {} });
	}
	loadScript('store.js');
	loadScript('chunks.js');
	return win;
}

/// A gateway whose every `have` waits for `release()`; `fail` makes the next
/// answers a 500, `throwNext` makes the next one throw as an abort does.
function armGateway(win, held) {
	const g = { open: 0, maxOpen: 0, asked: [], waiting: [], fail: 0, throwNext: 0 };
	g.release = () => { const w = g.waiting.splice(0); w.forEach((f) => f()); return w.length; };
	win.DaimondGateway = {
		clientApi: () => 1,
		gwFetch: async (path_, init) => {
			const body = JSON.parse(init.body);
			if (body.op !== 'have') return { status: 200, json: async () => ({ ok: true }) };
			g.open++; g.maxOpen = Math.max(g.maxOpen, g.open);
			g.asked.push(body.addrs.slice());
			try {
				await new Promise((r) => g.waiting.push(r));
				if (g.throwNext > 0) { g.throwNext--; throw new Error('AbortError: the 63 s deadline'); }
				if (g.fail > 0) { g.fail--; return { status: 500, json: async () => ({ error: 'busy' }) }; }
				return { status: 200, json: async () => ({ ok: true, missing: body.addrs.filter((a) => !held.has(a)) }) };
			} finally { g.open--; }
		},
	};
	return g;
}

const addr = (i) => String(i).padStart(64, '0');
const tick = () => new Promise((r) => setTimeout(r, 0));

/// Let every held query go, one at a time, until `done` settles.
async function drain(g, done) {
	let settled = false;
	done.then(() => { settled = true; }, () => { settled = true; });
	for (let i = 0; i < 200 && !settled; i++) { await tick(); await tick(); g.release(); }
	return settled;
}

console.log('\n— A: three sweeps at once put one `have` at a time —');
{
	const win = makeTab();
	const all = [];
	for (let i = 0; i < 4500; i++) all.push(addr(i));
	const gone = new Set(all.slice(10, 28));		// the 18 lost addresses
	const held = new Set(all.filter((a) => !gone.has(a)));
	const g = armGateway(win, held);

	// The 06:27:50 shape: three sweeps of the same set in the same second.
	const sweeps = [win.DaimondChunks.presence(all), win.DaimondChunks.presence(all), win.DaimondChunks.presence(all)];
	await tick(); await tick();
	check('only one `have` is open while three sweeps wait', g.open === 1, `${g.open} open`);
	const ok = await drain(g, Promise.all(sweeps));
	check('every sweep finishes', ok);
	const res = await Promise.all(sweeps);
	check('never more than one `have` open at a time', g.maxOpen === 1, `max ${g.maxOpen}`);
	check('every sweep answers ok', res.every((r) => r.ok === true));
	check('each names exactly the 18 lost addresses', res.every((r) => r.missing.length === 18
		&& r.missing.every((a) => gone.has(a))), res.map((r) => r.missing.length).join(','));
	check('every address is still asked, by every sweep', g.asked.reduce((n, b) => n + b.length, 0) === 3 * 4500,
		`${g.asked.reduce((n, b) => n + b.length, 0)} asked`);
	check('batches stay at HAVE_QUERY_BATCH', g.asked.length === 9 && Math.max(...g.asked.map((b) => b.length)) === 2000,
		`${g.asked.length} batches`);
}

console.log('\n— B: a failed or aborted query frees the next caller —');
{
	const win = makeTab();
	const held = new Set([addr(1)]);
	const g = armGateway(win, held);
	g.throwNext = 1;
	const first = win.DaimondChunks.presence([addr(1)]);
	const second = win.DaimondChunks.presence([addr(1), addr(2)]);
	let firstErr = null;
	first.catch((e) => { firstErr = e; });
	const ok = await drain(g, Promise.allSettled([first, second]));
	check('both settle', ok);
	check('the aborted one reports its abort as before', firstErr !== null);
	const s = await second;
	check('the next one is not wedged behind it', s.ok === true && s.missing.join() === addr(2));

	g.fail = 1;
	const third = win.DaimondChunks.presence([addr(1)]);
	const fourth = win.DaimondChunks.presence([addr(1), addr(3)]);
	const ok2 = await drain(g, Promise.all([third, fourth]));
	check('a refused query settles and frees the lane', ok2);
	const t = await third, f = await fourth;
	check('the refused one says it could not ask', t.ok === false);
	check('and the next one is answered', f.ok === true && f.missing.join() === addr(3));
	check('never more than one open', g.maxOpen === 1, `max ${g.maxOpen}`);
}

console.log('\n— C: nothing to ask asks nothing —');
{
	const win = makeTab();
	const g = armGateway(win, new Set());
	const r = await win.DaimondChunks.presence([]);
	check('an empty sweep answers at once', r.ok === true && r.missing.length === 0 && g.asked.length === 0);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
