/* ============================================================
   Test — PAGESTORE A fix: the store wait bounds SILENCE, not a whole walk.
   ------------------------------------------------------------
   A cursor walk over a long transcript answers row by row. Bounding the whole walk by
   the policy's store wait called a healthy store stalled whenever the walk outran it.
   Scaled 1:100 from "a cursor answering every 1 s for 30 s under a 20 s bound is not
   stalled; one silent 21 s is". Also checked: two taps on a stalled store read the log
   once when it answers (one callback per chat, not per tap).

     node www/js/pagestore_silence.test.mjs
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

const WAIT = 200;	// ms: the policy's store wait (20 s scaled)
const STEP = 10;	// ms between cursor rows (1 s scaled)
const ROWS = 30;	// rows in the walk (30 s scaled)
const GAP  = 210;	// ms of one silence (21 s scaled)

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/// An IndexedDB whose transcript cursor answers one row per `gaps[i]` ms; every other
/// request answers at once, or is held while `hold` is set.
function walkIdb(gaps) {
	let hold = false;
	const held = [];
	const later = (fn) => { if (hold) held.push(fn); else queueMicrotask(fn); };
	// As IndexedDB does, a transaction completes once its requests (a cursor until its walk
	// ends) have settled and their handlers queued no more.
	const settle = (t) => { t.open -= 1; later(() => { if (t.open === 0 && !t.over) { t.over = true; if (t.oncomplete) t.oncomplete(); } }); };
	const answer = (t, result) => { t.open += 1; const r = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); }, result: undefined }; later(() => { r.result = result; if (r.onsuccess) r.onsuccess(); r.ls.forEach((f) => f()); settle(t); }); return r; };
	const cursor = (t, range) => {
		t.open += 1;
		const r = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); }, result: null };
		const rows = (range && /^c1#$/.test(range.a)) ? gaps : [];
		let i = 0;
		const next = () => {
			if (i >= rows.length) { r.result = null; r.onsuccess && r.onsuccess(); r.ls.forEach((f) => f()); settle(t); return; }
			const k = i++;
			setTimeout(() => {
				r.result = { value: { k: 'c1#' + String(k).padStart(12, '0') + '-x', chatId: 'c1', seq: k, msgs: [] }, continue: next };
				r.onsuccess && r.onsuccess();
				r.ls.forEach((f) => f());
			}, rows[k]);
		};
		if (hold) held.push(next); else queueMicrotask(next);
		return r;
	};
	const store = (t) => ({
		get:        () => answer(t, undefined),
		getAll:     () => answer(t, []),
		getAllKeys: () => answer(t, []),
		openCursor: (range) => cursor(t, range),
		put:        () => answer(t, undefined),
		delete:     () => answer(t, undefined),
		clear:      () => answer(t, undefined),
	});
	const db = {
		objectStoreNames: { contains: () => true },
		transaction() { const t = { open: 1, over: false }; t.objectStore = () => store(t); settle(t); return t; },
		close() {},
	};
	return {
		idb: { open() { const r = { result: db }; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; } },
		stick() { hold = true; },
		release() { hold = false; held.splice(0).forEach((fn) => fn()); },
	};
}

function page(gaps, extra) {
	const fake = walkIdb(gaps);
	const w = makeWindow({ now: Date.now() });
	w.indexedDB = fake.idb;
	w.IDBKeyRange = { bound: (a, b) => ({ a, b }) };
	w.setTimeout = setTimeout;
	w.clearTimeout = clearTimeout;
	w.DaimondI18n = { t: (k) => k };
	w.DaimondPolicy = { storeWaitMs: () => WAIT, tombTtlMs: () => 37 * 86400e3, storePieceBytes: () => 32768 };
	loadScript(w, 'storewait.js');
	const said = [];
	w.console = { log() {}, debug() {}, info() {}, warn() {}, error: (...a) => { said.push(a.join(' ')); } };
	const el = () => ({ style: {}, children: [], setAttribute() {}, addEventListener() {},
		appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
		removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
		querySelector() { return null; } });
	w.document = { body: el(), createElement: el, hidden: false, visibilityState: 'visible', cookie: '' };
	w.DaimondSync = { readLog: async () => ({ rows: [] }) };
	w.DaimondSeal = {};
	w.DaimondIdentity = { unwrapBytesAad: async (b) => b, isUnlocked: () => true };
	const P = loadPage({ window: w, want: ['ChatStore', 'readChatLog'], stub: extra || {} });
	return { P, fake, said };
}

// A walk that keeps answering, for longer than the wait in all, is not stalled.
{
	const { P, said } = page(Array(ROWS).fill(STEP));
	const t0 = Date.now();
	const got = await P.ChatStore.loadMessages('c1');
	const took = Date.now() - t0;
	check('the walk outran the wait in all', took > WAIT, took + ' ms');
	check('a walk that keeps answering is not failed', !(got && got.failed), JSON.stringify(got).slice(0, 120));
	check('and the store is not called stalled', !P.ChatStore.stalled() && !/Restart this browser/.test(said.join('\n')), said.join(' | ').slice(0, 200));
}

// One silence longer than the wait is a stall.
{
	const gaps = Array(ROWS).fill(STEP);
	gaps[5] = GAP;
	const { P } = page(gaps);
	const got = await P.ChatStore.loadMessages('c1');
	check('one silence over the wait is a stall', !!(got && got.failed) || P.ChatStore.stalled(), JSON.stringify(got).slice(0, 120));
}

// Two taps on a stalled store: the log is read once when it answers.
{
	const reads = [];
	const { P, fake } = page([], { readChat: async (c) => { reads.push(c.id); return {}; } });
	fake.stick();
	await P.ChatStore.loadMessages('c0');
	const chat = { id: 'c2', messages: [], _loaded: false };
	await P.readChatLog(chat);
	await P.readChatLog(chat);
	check('the store is stalled for the taps', P.ChatStore.stalled());
	let ran = 0;
	P.ChatStore.whenAnswers('c3', () => { ran += 1; });
	P.ChatStore.whenAnswers('c3', () => { ran += 1; });
	fake.release();
	for (let i = 0; i < 50 && !reads.includes('c2'); i++) await pause(10);
	await pause(50);
	check('one callback per chat runs once', ran === 1, ran + ' runs');
	check('the log is read once for two taps', reads.filter((x) => x === 'c2').length === 1, JSON.stringify(reads));
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
