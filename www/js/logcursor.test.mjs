/* ============================================================
   Test — LOGCURSOR-ORDER: the log cursor never runs ahead of the stored transcript.
   ------------------------------------------------------------
   Since LOSTREPLY-29B a whole chat's reply draws while the chat store is stalled. The
   reply's save then waits on that store, and the stall notice asks for a restart, which
   drops the queued save. If the reader's place was already stored past the reply, the
   next load reads the log from above it and the reply is lost on this device. Here the
   real page folds a reply under a stall, the browser is restarted, and the reply must be
   stored or read again; once a stall ends the reply is stored and the place moves past
   it; and a chat that is not whole still loads and draws while only another store is late.
   A save that fails on or skips a chat does not count as stored for it, an earlier save
   cannot release a place a later one owes, and a destroyed chat's place is not written back.

     node www/js/logcursor.test.mjs
   ============================================================ */
import { makeWindow } from '../../dev/syncprobe.mjs';
import { page } from './test/chatidb.mjs';
import { loadPage } from './test/page.mjs';

const WAIT = 40;			// ms: the policy's store wait for this test
const BOUND = WAIT * 10;	// a read that must not wait on the store comes back well within this
const SEQ = 31;				// the log row the reply is folded from

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), pause(ms).then(() => null)]);
const msg = (i) => ({ mid: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: 'line ' + i, ts: 1700000000000 + i });
const REPLY = { mid: 'reply1', role: 'assistant', content: 'the Kimberlite reply', ts: 1700000009999 };
const PLACE_KEY = 'daimond.chatlog.place';

let stalled = false;
let held = [];
const gate = (fn) => { if (stalled) held.push(fn); else fn(); };
// One browser profile's localStorage, kept across a restart.
const ls = (() => {
	const m = new Map();
	return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
		clear: () => m.clear(), key: (i) => [...m.keys()][i] || null, get length() { return m.size; } };
})();
const sinces = [];		// the cursor each log read started from
const reads = [];		// the chats a log read reached

const WANT = ['ChatStore', 'readChatLog', 'transcriptWhole', 'chats', 'forgetLogPlace'];
function tab(data, fold, wait = WAIT) {
	let P = null;
	const opts = (o, want) => Object.assign({}, o, {
		want,
		stub: {
			readChat: async (c) => {
				reads.push(c.id);
				sinces.push(+c.logSeq || 0);
				if (fold && !c.messages.some((m) => m.mid === REPLY.mid)) { c.logSeq = SEQ; c.messages = c.messages.concat([REPLY]); }
				return { ok: true };
			},
			selectChat: () => {}, renderSessionList: () => {},
		},
	});
	// A page that keeps the place in its database reads the box's copy at install (LSFULL).
	const load = (o) => {
		try { return (P = loadPage(opts(o, WANT.concat(['readBoxedLogPlaces'])))); }
		catch (e) { if (!/declares no/.test(String(e && e.message))) throw e; }
		return (P = loadPage(opts(o, WANT)));
	};
	const mk = (o) => {
		const w = makeWindow(Object.assign({}, o, { ls }));
		w.DaimondSync = { readLog: async () => ({ rows: [] }) };
		w.DaimondSeal = {};
		w.DaimondIdentity = { unwrapBytesAad: async (b) => b, isUnlocked: () => true };
		return w;
	};
	const t = page(data, mk, load, gate, wait);
	if (P.readBoxedLogPlaces) P.readBoxedLogPlaces();
	return Object.assign(t, { P });
}
const storedPlace = (id) => { try { return (JSON.parse(ls.getItem(PLACE_KEY) || '{}') || {})[id]; } catch (e) { return undefined; } };
const whole = (id) => ({ id, name: id, messages: [0, 1].map(msg), session: { msgs: [] }, updatedAt: Date.now(), _loaded: true });
const cold = (id) => ({ id, name: id, messages: [], msgCount: 2, updatedAt: Date.now(), _loaded: false });

// An earlier load of the page stored three chats.
const data = new Map();
{
	const A = tab(data, false);
	await A.ChatStore.boot();
	A.ChatStore.save(['warm', 'later', 'other', 'failed', 'skipped', 'gen', 'gone'].map(whole));
	check('the earlier load stored its chats', !!(await within(A.ChatStore.settled(), BOUND)));
}

// A whole chat's reply draws under a stall of the chat store.
{
	const B = tab(data, true);
	await B.ChatStore.boot();
	const warm = whole('warm');
	B.P.chats.push(warm);
	stalled = true;
	B.ChatStore.save(B.P.chats.slice());
	await pause(WAIT * 4);
	check('the chat store is stalled', B.ChatStore.stalled());
	const r = await within(B.P.readChatLog(warm), BOUND);
	check('the log read comes back', !!r);
	check('and the reply is drawn', warm.messages.some((m) => m.mid === REPLY.mid));
	await pause(WAIT * 4);
	const p = storedPlace('warm');
	check('the stored place stays below the reply its store does not hold', !p || (+p.seq || 0) < SEQ, JSON.stringify(p));
}

// The browser is restarted, as the notice asks: the stuck commit and the queued saves are gone.
stalled = false; held = [];
{
	const C = tab(data, false);
	await C.ChatStore.boot();
	const got = await C.ChatStore.loadMessages('warm');
	const stored = (got.messages || []).some((m) => m.mid === REPLY.mid);
	const warm = cold('warm');
	C.P.chats.push(warm);
	sinces.length = 0;
	await within(C.P.readChatLog(warm), BOUND);
	check('after a restart the reply is read again from the log', stored || (sinces[0] !== undefined && sinces[0] < SEQ),
		'stored=' + stored + ' since=' + sinces[0]);
}

// A stall that ends: the reply is stored, and only then does the place move past it.
{
	const D = tab(data, true);
	await D.ChatStore.boot();
	const later = whole('later');
	D.P.chats.push(later);
	stalled = true;
	D.ChatStore.save(D.P.chats.slice());
	await pause(WAIT * 4);
	await within(D.P.readChatLog(later), BOUND);
	await pause(WAIT * 4);
	stalled = false;
	held.splice(0).forEach((fn) => fn());
	for (let i = 0; i < 100 && D.ChatStore.stalled(); i++) await pause(10);
	for (let i = 0; i < 100 && !((storedPlace('later') || {}).seq >= SEQ); i++) await pause(10);
	await within(D.ChatStore.settled(), BOUND);
	const got = await D.ChatStore.loadMessages('later');
	check('once the store answers the reply is stored', (got.messages || []).some((m) => m.mid === REPLY.mid), JSON.stringify(got).slice(0, 160));
	check('and the place moves past it', (+(storedPlace('later') || {}).seq || 0) === SEQ, JSON.stringify(storedPlace('later')));
}

// A chat whose transcript only the store holds loads and draws while another store is late.
{
	const E = tab(data, false);
	await E.ChatStore.boot();
	E.window.DaimondStoreWait.bounded(new Promise(() => {}), 'reading the other store').catch(() => {});
	await pause(WAIT * 2);
	check('another store is late', E.ChatStore.stalled());
	const other = cold('other');
	E.P.chats.push(other);
	reads.length = 0;
	const r = await within(E.P.readChatLog(other), BOUND);
	check('the chat\'s transcript loads', E.P.transcriptWhole(other), JSON.stringify({ n: other.messages.length, _short: other._short }));
	check('and its reply is folded in', !!r && reads.includes('other'), JSON.stringify(reads));
}

// A save that fails on the chat (its chunk put throws) does not count as landed for it.
const failReply = (name, v) => name === 'msgchunks' && JSON.stringify(v).includes(REPLY.content);
{
	const F = tab(data, true);
	await F.ChatStore.boot();
	const c = whole('failed');
	F.P.chats.push(c);
	F.ChatStore.save(F.P.chats.slice());
	await within(F.ChatStore.settled(), BOUND);
	data.failPut = failReply;
	await within(F.P.readChatLog(c), BOUND);
	await within(F.ChatStore.settled(), BOUND);
	await pause(WAIT * 2);
	data.failPut = null;
	check('a reply is drawn into a chat whose save fails', c.messages.some((m) => m.mid === REPLY.mid));
	check('the failed save holds the place below the reply', (+(storedPlace('failed') || {}).seq || 0) < SEQ, JSON.stringify(storedPlace('failed')));
}

// A save that leaves a chat alone (its transcript in hand is not one) does not count as stored for it.
{
	const S = tab(data, false);
	await S.ChatStore.boot();
	const c = whole('skipped');
	c.messages.push('not a message');
	let fired = false;
	const gen = S.ChatStore.save([c]);
	S.ChatStore.whenStored('skipped', gen, () => { fired = true; });
	await within(S.ChatStore.settled(), BOUND);
	await pause(WAIT * 2);
	check('the save is numbered', typeof gen === 'number', String(gen));
	check('a save that skips a chat does not count as stored for it', !fired);
}

// Save 1 (without the reply) lands after the draw and save 2 (with it) fails: the place waits for save 2.
{
	const G = tab(data, true, WAIT * 10);
	await G.ChatStore.boot();
	const c = whole('gen');
	G.P.chats.push(c);
	stalled = true;
	G.ChatStore.save(G.P.chats.slice());
	data.failPut = failReply;
	await within(G.P.readChatLog(c), BOUND);
	stalled = false;
	held.splice(0).forEach((fn) => fn());
	await within(G.ChatStore.settled(), BOUND * 10);
	await pause(WAIT * 2);
	data.failPut = null;
	check('an earlier save landing does not release the place a later save owes', (+(storedPlace('gen') || {}).seq || 0) < SEQ, JSON.stringify(storedPlace('gen')));
}

// A chat destroyed while its place is due: the place is not written back when its save lands.
{
	const K = tab(data, true);
	await K.ChatStore.boot();
	const c = whole('gone');
	K.P.chats.push(c);
	stalled = true;
	K.ChatStore.save(K.P.chats.slice());
	await pause(WAIT * 4);
	await within(K.P.readChatLog(c), BOUND);
	K.P.forgetLogPlace('gone');
	stalled = false;
	held.splice(0).forEach((fn) => fn());
	for (let i = 0; i < 100 && K.ChatStore.stalled(); i++) await pause(10);
	await within(K.ChatStore.settled(), BOUND);
	await pause(WAIT * 2);
	check('a reply is drawn into the chat before it is destroyed', c.messages.some((m) => m.mid === REPLY.mid));
	check('a destroyed chat\'s place is not written back', storedPlace('gone') === undefined, JSON.stringify(storedPlace('gone')));
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
