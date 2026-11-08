/* ============================================================
   Test — CHUNK-CURSOR: a reply counts as on disk only once the save that carries it commits.
   ------------------------------------------------------------
   The chat store marks a message's chunk as written (`chunkedMids`) when its put is issued.
   If that put fails, the next save of the chat must append the chunk again; otherwise it
   puts the row alone, counts the chat as landed, and the log place passes a reply the
   store does not hold, so after a restart the reply is gone from this device. Here the
   real page draws a reply whose chunk put fails once, a later save succeeds, and the
   browser restarts: the reply must be stored or read again from the log.

     node www/js/chunkcursor.test.mjs
   ============================================================ */
import { makeWindow } from '../../dev/syncprobe.mjs';
import { page } from './test/chatidb.mjs';
import { loadPage } from './test/page.mjs';

const WAIT = 40, BOUND = WAIT * 10, SEQ = 31;
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), pause(ms).then(() => null)]);
const msg = (i) => ({ mid: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: 'line ' + i, ts: 1700000000000 + i });
const REPLY = { mid: 'reply1', role: 'assistant', content: 'the Kimberlite reply', ts: 1700000009999 };
let stalled = false, held = [];
const gate = (fn) => { if (stalled) held.push(fn); else fn(); };
const ls = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] || null, get length() { return m.size; } }; })();
const sinces = [];
function tab(data, fold, wait = WAIT) {
	let P = null;
	const load = (o) => (P = loadPage(Object.assign({}, o, {
		want: ['ChatStore', 'readChatLog', 'transcriptWhole', 'chats', 'readBoxedLogPlaces'],
		stub: { readChat: async (c) => { sinces.push(+c.logSeq || 0); if (fold && !c.messages.some((m) => m.mid === REPLY.mid)) { c.logSeq = SEQ; c.messages = c.messages.concat([REPLY]); } return { ok: true }; },
			selectChat: () => {}, renderSessionList: () => {} },
	})));
	const mk = (o) => {
		const w = makeWindow(Object.assign({}, o, { ls }));
		w.DaimondSync = { readLog: async () => ({ rows: [] }) };
		w.DaimondSeal = {};
		w.DaimondIdentity = { unwrapBytesAad: async (b) => b, isUnlocked: () => true };
		return w;
	};
	const t = page(data, mk, load, gate, wait);
	P.readBoxedLogPlaces();
	return Object.assign(t, { P });
}
const place = (id) => { try { return (JSON.parse(ls.getItem('daimond.chatlog.place') || '{}') || {})[id]; } catch (e) { return undefined; } };
const whole = (id) => ({ id, name: id, messages: [0, 1].map(msg), session: { msgs: [] }, updatedAt: Date.now(), _loaded: true });
const cold = (id) => ({ id, name: id, messages: [], msgCount: 2, updatedAt: Date.now(), _loaded: false });
const failReply = (name, v) => name === 'msgchunks' && JSON.stringify(v).includes(REPLY.content);

const data = new Map();
{
	const A = tab(data, false);
	await A.ChatStore.boot();
	A.ChatStore.save(['warm', 'gen'].map(whole));
	check('the earlier load stored its chats', !!(await within(A.ChatStore.settled(), BOUND)));
}
// F: the reply's chunk put fails once; a later save of the chat succeeds.
{
	const B = tab(data, true);
	await B.ChatStore.boot();
	const warm = whole('warm');
	B.P.chats.push(warm);
	B.ChatStore.save(B.P.chats.slice());
	await within(B.ChatStore.settled(), BOUND);
	data.failPut = failReply;
	await within(B.P.readChatLog(warm), BOUND);
	await within(B.ChatStore.settled(), BOUND);
	check('F: the reply is drawn', warm.messages.some((m) => m.mid === REPLY.mid));
	check('F: the failed save holds the place below the reply', !((+(place('warm') || {}).seq || 0) >= SEQ), JSON.stringify(place('warm')));
	data.failPut = null;
	B.ChatStore.save(B.P.chats.slice());	// any later save: another chat's turn, a rename
	await within(B.ChatStore.settled(), BOUND);
	await pause(WAIT * 2);
	const got = await B.ChatStore.loadMessages('warm');
	const stored = (got.messages || []).some((m) => m.mid === REPLY.mid);
	const p = +(place('warm') || {}).seq || 0;
	console.log('  info F: after the later save stored=' + stored + ' place=' + p);
	check('F: the place passes the reply only once the store holds it', stored || p < SEQ, 'stored=' + stored + ' place=' + p);
}
// The browser restarts.
{
	const C = tab(data, false);
	await C.ChatStore.boot();
	const got = await C.ChatStore.loadMessages('warm');
	const stored = (got.messages || []).some((m) => m.mid === REPLY.mid);
	const warm = cold('warm');
	C.P.chats.push(warm);
	sinces.length = 0;
	await within(C.P.readChatLog(warm), BOUND);
	check('F: after a restart the reply is stored or read again from the log', stored || (sinces[0] !== undefined && sinces[0] < SEQ),
		'stored=' + stored + ' since=' + sinces[0]);
}
console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
