/* ============================================================
   Test — PAGESTORE A: a store that never answers must not hang a turn silently.
   ------------------------------------------------------------
   Chrome 153 left a readwrite transaction "Committing" for ever (a value over 64 KiB
   went down its blob path and the blob write never called back), and every later
   read of those stores waited behind it (Q1108-045). `readChatLog` set its busy flag,
   awaited `ChatStore.loadMessages`, and never came back: no rows, no notice, and every
   later tap only queued behind the first.

   Here the real ChatStore runs against a fake IndexedDB whose requests and commits do
   not answer until the test releases them. Checked: the read comes back within the
   policy's wait, says it failed, raises a notice naming the remedy, releases the busy
   flag (a second tap reads again), and the log is read again once the store answers.

     node www/js/pagestore.test.mjs
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

const WAIT = 60;	// ms: the policy's store wait for this test

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

/// An IndexedDB that opens, then holds every request and commit until `release()`.
function stuckIdb() {
	const held = [];
	let open = false;
	const later = (fn) => { if (open) queueMicrotask(fn); else held.push(fn); };
	const answer = (result) => { const r = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); }, result: undefined }; later(() => { r.result = result; if (r.onsuccess) r.onsuccess(); r.ls.forEach((f) => f()); }); return r; };
	const store = () => ({
		get:         () => answer(undefined),
		getAllKeys:  () => answer([]),
		openCursor:  () => answer(null),
		put:         () => answer(undefined),
		delete:      () => answer(undefined),
		clear:       () => answer(undefined),
	});
	const db = {
		objectStoreNames: { contains: () => true },
		transaction() {
			const t = { objectStore: store };
			later(() => { if (t.oncomplete) t.oncomplete(); });
			return t;
		},
		close() {},
	};
	return {
		idb: { open() { const r = { result: db }; queueMicrotask(() => r.onsuccess && r.onsuccess()); return r; } },
		release() { open = true; held.splice(0).forEach((fn) => fn()); },
	};
}

const within = (p, ms) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r(null), ms))]);

const fake = stuckIdb();
const IDBKeyRange = { bound: (a, b) => ({ a, b }) };
const w = makeWindow({ now: Date.now() });
w.indexedDB = fake.idb;
w.IDBKeyRange = IDBKeyRange;
w.setTimeout = setTimeout;
w.clearTimeout = clearTimeout;
w.DaimondI18n = { t: (k) => k };
w.DaimondPolicy = { storeWaitMs: () => WAIT, tombTtlMs: () => 37 * 86400e3 };
loadScript(w, 'storewait.js');
const reads = [];
const said = [];
w.console = { log() {}, debug() {}, info() {}, warn() {}, error: (...a) => { said.push(a.join(' ')); } };
// Enough of a DOM for the notice to be put up and taken down.
const el = () => ({ style: {}, children: [], setAttribute() {}, addEventListener() {},
	appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
	removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; return c; },
	querySelector(sel) { const want = sel.replace(/^\./, ''); const walk = (n) => n.className === want ? n : n.children.map(walk).find(Boolean); return walk(this) || null; } });
const body = el();
w.document = { body, createElement: el, hidden: false, visibilityState: 'visible', cookie: '' };
const alarm = () => said.join('\n');
w.DaimondSync = { readLog: async () => ({ rows: [] }) };
w.DaimondSeal = {};
w.DaimondIdentity = { unwrapBytesAad: async (b) => b, isUnlocked: () => true };
const P = loadPage({ window: w, want: ['ChatStore', 'readChatLog'],
	stub: { readChat: async (c) => { reads.push(c.id); return {}; } } });
const { ChatStore, readChatLog } = P;

// The store itself: a read is released within the wait and says it failed.
const got = await within(ChatStore.loadMessages('c1'), WAIT * 20);
check('a read of a stuck store comes back', !!got);
check('and says it failed', !!got && got.v && got.v.failed === true, got && JSON.stringify(got.v));
check('the store says it is stalled', typeof ChatStore.stalled === 'function' && ChatStore.stalled());
check('he is told, with the remedy', /Restart this browser/.test(alarm()), alarm().slice(0, 200));

// The log: a tap returns, and a second tap reads rather than queueing behind the first.
const chat = { id: 'c2', messages: [], _loaded: false };
const first = await within(readChatLog(chat), WAIT * 20);
check('a log tap on a stuck store returns', !!first);
const second = await within(readChatLog(chat), WAIT * 20);
check('a second tap is not held behind the first', !!second);

// The store answers: the log is read again of itself, and the notice comes down.
fake.release();
for (let i = 0; i < 50 && !reads.includes('c2'); i++) await new Promise((r) => setTimeout(r, 10));
check('the log is read once the store answers', reads.includes('c2'), JSON.stringify(reads));
check('and the store is no longer stalled', !ChatStore.stalled());
check('he saw a notice', said.length > 0);
check('and the notice is down', body.children.length === 0, body.children.length + ' left');

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
