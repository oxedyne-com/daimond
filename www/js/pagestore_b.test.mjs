/* ============================================================
   Test — PAGESTORE B: no record the page stores reaches Chrome's wrap threshold.
   ------------------------------------------------------------
   Chrome sends a value whose wire form is over kIDBWrapThreshold (65536 bytes,
   indexeddb.mojom) down its blob path, and on Chrome 153 that commit never called
   back (Q1108-045): the chat's whole row, transcript and model session in one value,
   went over it and wedged the store.

   Here the real ChatStore runs against an in-memory IndexedDB that measures every
   put with V8's own serialiser and, like that Chrome, never commits a transaction
   holding a value over the threshold. Checked: a chat holding one 200 KB message and
   a 300 KB session is saved and read back whole by a fresh page; no put reaches the
   threshold; an old whole-chat row is slimmed once at boot with its transcript and
   session intact.

     node www/js/pagestore_b.test.mjs
   ============================================================ */
import { fakeIdb, page, t27Page, WRAP, WAIT } from './test/chatidb.mjs';


let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const within = (p, ms) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r(null), ms))]);
const msg = (i, content) => ({ mid: 'm' + i, role: i % 2 ? 'assistant' : 'user', content, ts: 1700000000000 + i });
const big = (n, ch) => ch.repeat(n);
const sameMsgs = (a, b) => JSON.stringify(a.map((m) => [m.mid, m.content])) === JSON.stringify(b.map((m) => [m.mid, m.content]));

// ── A chat over the threshold round-trips in pieces ──
const data = new Map();
const A = page(data);
await A.ChatStore.boot();
const msgs = [msg(0, 'hello'), msg(1, big(100000, '€')), msg(2, 'and then')];
for (let i = 3; i < 300; i++) msgs.push(msg(i, 'line ' + i + ' ' + big(400, 'x')));
const session = { msgs: Array.from({ length: 60 }, (_, i) => ({ role: 'user', content: big(2500, 'ß') + i })) };
const chat = { id: 'c1', name: 'big', messages: msgs, session, updatedAt: Date.now(), _loaded: true };
A.ChatStore.save([chat]);
const saved = await within(A.ChatStore.settled(), WAIT * 20);
check('the save settles', !!saved);
const worst = A.puts.reduce((m, p) => (p.size > m.size ? p : m), { size: 0 });
check('no put reaches the threshold', worst.size < WRAP, worst.name + ' ' + worst.key + ' ' + worst.size + ' bytes');
const row = data.get('chats').get('c1');
check('the chat row holds no transcript or session', !!row && row.messages === undefined && row.session === undefined,
	row ? Object.keys(row).join(',') : 'no row');

const B = page(data);
await B.ChatStore.boot();
const got = await within(B.ChatStore.loadMessages('c1'), WAIT * 20);
check('a fresh page reads the chat back', !!got && !got.v.failed);
check('every message, the 200 KB one whole', !!got && sameMsgs(got.v.messages, msgs),
	got && got.v.messages.length + ' messages');
check('and the session whole', !!got && JSON.stringify(got.v.session) === JSON.stringify(session));

// ── An old whole-chat row is migrated once ──
const old = new Map();
fakeIdb(old);	// the stores
const oldMsgs = [msg(0, 'old'), msg(1, big(90000, '€'))];
const oldSession = { msgs: [{ role: 'user', content: big(50000, 'ß') }] };
old.get('chats').set('c9', { id: 'c9', name: 'old', messages: oldMsgs, session: oldSession, updatedAt: 1, status: 'active' });
const C = page(old);
await C.ChatStore.boot();
const slim = await within(C.ChatStore.slimSettled ? C.ChatStore.slimSettled() : Promise.resolve(), WAIT * 20);
check('the boot pass over old rows settles', !!slim);
const r9 = old.get('chats').get('c9');
check('the old row is slim after boot', !!r9 && r9.messages === undefined && r9.session === undefined,
	r9 ? Object.keys(r9).join(',') : 'no row');
const worstC = C.puts.reduce((m, p) => (p.size > m.size ? p : m), { size: 0 });
check('and no put of the migration reaches the threshold', worstC.size < WRAP, worstC.key + ' ' + worstC.size);
const D = page(old);
await D.ChatStore.boot();
const g9 = await within(D.ChatStore.loadMessages('c9'), WAIT * 20);
check('its transcript is intact', !!g9 && sameMsgs(g9.v.messages, oldMsgs), g9 && g9.v.messages.length + ' messages');
check('and its session', !!g9 && JSON.stringify(g9.v.session) === JSON.stringify(oldSession));
const E = page(old);
await E.ChatStore.boot();
await within(E.ChatStore.slimSettled ? E.ChatStore.slimSettled() : Promise.resolve(), WAIT * 20);
check('a second boot migrates nothing', !E.puts.some((p) => p.name === 'chats'), E.puts.map((p) => p.key).join(','));

// ── The version fence: a t27 page cannot open what this build laid out ──
{
	const data = new Map();
	const T = await t27Page(data);	// a t27 tab open across the deploy
	await T.ChatStore.boot();
	const A = page(data);
	await A.ChatStore.boot();
	check('the upgrade to this build closed the t27 tab', data.conns.size === 1 && data.ver === 4, data.conns.size + ' open at v' + data.ver);
	const ms = [msg(0, 'hello'), msg(1, big(100000, '€')), msg(2, 'and then')];
	A.ChatStore.save([{ id: 'c1', name: 'big', messages: ms, session: { msgs: [{ role: 'user', content: 'ctx' }] }, updatedAt: Date.now(), _loaded: true }]);
	check('the chat is saved', !!(await within(A.ChatStore.settled(), WAIT * 20)));
	const isFrag = (r) => typeof r.frag === 'string' && r.chatId === 'c1';
	const frags = [...data.get('msgchunks').values()].filter(isFrag).length;
	check('its big message is stored as fragments', frags > 1, frags + ' rows');
	const rows = JSON.stringify([...data.get('msgchunks').keys()]);
	// The open t27 tab's next save, then a rollback to t27.
	T.ChatStore.save([{ id: 'c1', name: 'big', messages: [msg(0, 'hello'), msg(2, 'edited on t27')], session: null, updatedAt: Date.now() + 1, _loaded: true }]);
	await within(T.ChatStore.settled(), WAIT * 20);
	const R = await t27Page(data);
	await within(R.ChatStore.boot(), WAIT * 20);
	const g = await within(R.ChatStore.loadMessages('c1'), WAIT * 20);
	check('a rolled-back t27 page reads no chat short', !g || !g.v || g.v.failed || g.v.messages.length === 0 || sameMsgs(g.v.messages, ms),
		g && g.v && g.v.messages ? g.v.messages.length + ' messages' : 'none');
	R.ChatStore.save([{ id: 'c1', name: 'big', messages: [msg(0, 'hello')], session: null, updatedAt: Date.now() + 2, _loaded: true }]);
	await within(R.ChatStore.settled(), WAIT * 20);
	check('and raises the alarm', R.errors.some((e) => e.includes('not being saved')), R.errors.slice(0, 1).join(''));
	check('no fragment row deleted, nothing in the store moved', JSON.stringify([...data.get('msgchunks').keys()]) === rows);
	const B2 = page(data);
	await B2.ChatStore.boot();
	const g2 = await within(B2.ChatStore.loadMessages('c1'), WAIT * 20);
	check('this build still reads every message', !!g2 && sameMsgs(g2.v.messages, ms), g2 && g2.v.messages.length + ' messages');
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
