/* ============================================================
   Test — LOSTREPLY-29B: a settled turn's reply draws while the store has stopped answering.
   ------------------------------------------------------------
   On TRAIN-29b Chrome left two readwrite transactions Committing for an hour, every later
   read Blocked behind them (indexeddb-internals, 09 Nov 04:14). A new Diamond's chat was
   not "whole", so the log read awaited its transcript from that store and the reply never
   drew. Here the real page runs over a store that, once stalled, answers nothing: no
   commit, no read. The reply of a chat whose transcript is in hand (one made in this tab,
   or one already resident) draws from the log; a chat that needs the store is released
   within the bound and read once the store answers; and the store's silence is said.

     node www/js/lostreply.test.mjs
   ============================================================ */
import { makeWindow } from '../../dev/syncprobe.mjs';
import { page } from './test/chatidb.mjs';
import { loadPage } from './test/page.mjs';

const WAIT = 40;			// ms: the policy's store wait for this test
const BOUND = WAIT * 10;	// a read that must not wait on the store comes back well within this

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const within = (p, ms) => Promise.race([p.then((v) => ({ v }), (e) => ({ e })), pause(ms).then(() => null)]);
const msg = (i) => ({ mid: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: 'line ' + i, ts: 1700000000000 + i });

let stalled = false;
const held = [];
const gate = (fn) => { if (stalled) held.push(fn); else fn(); };
const reads = [];

function tab(data) {
	let P = null;
	const load = (o) => (P = loadPage(Object.assign({}, o, {
		want: ['ChatStore', 'readChatLog', 'daimonChat', 'newChat', 'transcriptWhole', 'chats'],
		stub: { readChat: async (c) => { reads.push(c.id); return {}; }, selectChat: () => {}, renderSessionList: () => {} },
	})));
	const mk = (o) => {
		const w = makeWindow(o);
		w.DaimondSync = { readLog: async () => ({ rows: [] }) };
		w.DaimondSeal = {};
		w.DaimondIdentity = { unwrapBytesAad: async (b) => b, isUnlocked: () => true };
		return w;
	};
	const t = page(data, mk, load, gate, WAIT);
	return Object.assign(t, { P });
}

// A chat stored by an earlier load of the page.
const data = new Map();
{
	const A = tab(data);
	await A.ChatStore.boot();
	A.ChatStore.save([{ id: 'cold', name: 'cold', messages: [0, 1].map(msg), session: { msgs: [] }, updatedAt: Date.now(), _loaded: true }]);
	check('the earlier load stored its chat', !!(await within(A.ChatStore.settled(), BOUND)));
}

// This load: one chat resident and whole, one held only as its summary.
const B = tab(data);
await B.ChatStore.boot();
const P = B.P;
const warm = { id: 'warm', name: 'warm', messages: [0].map(msg), session: { msgs: [] }, updatedAt: Date.now(), _loaded: true };
const cold = { id: 'cold', name: 'cold', messages: [], msgCount: 2, updatedAt: Date.now(), _loaded: false };
P.chats.push(warm, cold);

// The store stops answering, and a save finds it out.
stalled = true;
B.ChatStore.save(P.chats.slice());
await pause(WAIT * 4);
check('the stalled store is said', B.ChatStore.stalled() && B.errors.length > 0, JSON.stringify(B.errors).slice(0, 160));

// A resident chat's reply draws: its transcript is in hand.
{
	const r = await within(P.readChatLog(warm), BOUND);
	check('a resident chat\'s log read comes back', !!r);
	check('and its reply is folded in', reads.includes('warm'), JSON.stringify(reads));
}

// A new Diamond's chat is whole when made, so its first reply draws from the log.
{
	const chat = P.daimonChat({ id: 'f1' });
	check('a new Diamond\'s chat is whole when made', P.transcriptWhole(chat), JSON.stringify({ _loaded: chat._loaded, _short: chat._short }));
	chat.messages.push(msg(0));
	const r = await within(P.readChatLog(chat), BOUND);
	check('its log read comes back', !!r);
	check('and its reply is folded in', reads.includes(chat.id), JSON.stringify(reads));
}

// So is a new chat's.
{
	let chat = null, threw = null;
	try { P.newChat(); chat = P.chats[0]; } catch (e) { threw = e; }
	check('a new chat is made', !!chat, threw && String(threw));
	if (chat) {
		check('a new chat is whole when made', P.transcriptWhole(chat), JSON.stringify({ _loaded: chat._loaded, _short: chat._short }));
		chat.messages.push(msg(0));
		const r = await within(P.readChatLog(chat), BOUND);
		check('its reply is folded in', !!r && reads.includes(chat.id), JSON.stringify(reads));
	}
}

// A chat whose transcript only the store holds is released, not held for ever, and read
// once the store answers: once for two taps.
{
	const r1 = await within(P.readChatLog(cold), BOUND);
	const r2 = await within(P.readChatLog(cold), BOUND);
	check('a log read that needs the store is released within the bound', !!r1 && !!r2);
	check('and folds nothing onto a transcript it lacks', !reads.includes('cold'), JSON.stringify(reads));
	stalled = false;
	held.splice(0).forEach((fn) => fn());
	for (let i = 0; i < 100 && !reads.includes('cold'); i++) await pause(10);
	await pause(WAIT);
	check('the log is read once the store answers', reads.filter((x) => x === 'cold').length === 1, JSON.stringify(reads));
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
