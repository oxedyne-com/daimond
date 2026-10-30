/* ============================================================
   Test -- the chat log, read (P2.3a, design §2): page/turnlog.js over the
   real wasm codec and the real DaimondSeal bridge, the key stood in by
   an identity wrap (a row's sealed body is its plaintext), the door by a
   list of wire rows the gateway would have stamped.

     FOLD    a handed-off turn's rows (msg, more, msg, edit, end) fold in
             seq order, each message once, the state tile last until the
             end, then gone; `onEnd` heard once
     REREAD  the same rows read again, and a wake past the head, fold
             nothing twice and move nothing
     GAP     a cursor below the gateway's `low` resets to low-1 and reads
     JOIN    a parcel copy and a log copy of one mid are one message,
             ordered by the log (`msgJoin`, the real message law)
     MEMBER  each drawn row carries the member the gateway stamped
     RESIDENT a chat whose transcript is not loaded (`_loaded` false, its
             `messages` the empty placeholder) is not folded: the log drawn
             over nothing became the whole chat on screen, and its first
             line ("@err 500") its rail title (REL-1pg, webkit by-role)
     WHOLE   the log folds only onto a transcript a load proved whole:
             not a chat with no loaded flag, and not one a cold store
             answered empty (`failed`), which `loadChatMessages` marks
             `_short` and reads again (REL-1n)
     ENDS    a turn's end draws from its end row: done and stopped add
             nothing; interrupted marks the turn's answer as the runner-lost
             tile (or adds an empty one); not_run adds the "not run" row
             with Retry (mid <turn>-nr, `isNotRunRow`), its cause from
             the end's `not_run`; a Diamond's is tagged `notrun`

     node www/js/turnlog.test.mjs

   Needs www/pkg (dev/build-wasm.sh --no-opt).
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readPage } from '../../dev/pagesrc.mjs';
import { loadSeal, installSeal } from './sealfixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const wasm = await loadSeal();
const seal = installSeal({});
const TL = await import('./page/turnlog.js');

// The message law, lifted whole from the page as framedanswer.test.mjs lifts it.
const { liftSource } = await import('../../dev/syncprobe.mjs');
const law = new Function([
	'function loadMsgTombs() { return {}; }',
	'var DaimondStamp = (function () { var window = {}; ' + readPage(join(HERE, 'stamp.js'), 'utf8') + '\n return window.DaimondStamp; })();',
	liftSource(['msgJoin'], ['loadMsgTombs', 'window', 'DaimondStamp']).src,
	'return { msgJoin: msgJoin };',
].join('\n'))();

const unwrap = async (b) => b;		// the stand-in key: sealed is plain
let seq = 0;
function wire(turn, n, kind, body, member) {
	const head = { seq: ++seq, turn, n, kind, member: member || 'acct', daimon: '', at: 1000 + seq, len: 0 };
	const plain = wasm.row_seal(JSON.stringify(head), JSON.stringify(body));
	return JSON.parse(wasm.row_wire(JSON.stringify(head), plain));
}
const isTile = (m, t) => m.why === 'dispatched' && String(m.iturn) === String(t);

function deps(door, ends) {
	return {
		seal, unwrap,
		join: law.msgJoin,
		isTile,
		onEnd: (chat, t, v) => {
			ends.push(t + ':' + v.status);
			chat.messages = chat.messages.filter((m) => !isTile(m, t));
		},
		read: async (_id, since) => door(since),
	};
}
function doorOf(rows, low) {
	return (since) => {
		if (low && since < low - 1) return { ok: true, gap: true, low };
		const out = rows.filter((r) => r.seq > since);
		return { ok: true, rows: out, head: rows.length ? rows[rows.length - 1].seq : 0, low: low || 0, more: false };
	};
}

// ── FOLD ──
const user = { mid: 'u1', role: 'user', content: 'hi', ts: 900, iturn: 'T1' };
const tile = { mid: 'ph1', role: 'assistant', content: '', why: 'dispatched', iturn: 'T1', ts: 901 };
const chat = { id: 'c1', _loaded: true, messages: [user, tile] };
const ends = [];
const log = [];
const D = deps((s) => doorOf(log)(s), ends);

log.push(wire('T1', 1, 'msg', { mid: 'u1', role: 'user', text: 'hi' }, 'acct'));
log.push(wire('T1', 2, 'msg', { mid: 'a1', role: 'assistant', text: 'Hel' }, 'acct'));
await TL.readChat(chat, D);
let ids = chat.messages.map((m) => m.mid).join(',');
check('FOLD open: user, answer, then the state tile last', ids === 'u1,a1,ph1', ids);
check('FOLD open: rows provisional', chat.messages.find((m) => m.mid === 'a1').provisional === 1);
log.push(wire('T1', 3, 'more', { mid: 'a1', text: 'lo' }));
log.push(wire('T1', 4, 'msg', { mid: 't1', role: 'tool', text: 'ls' }));
log.push(wire('T1', 5, 'edit', { mid: 'a1', role: 'assistant', text: 'Hello' }));
await TL.readChat(chat, D);
ids = chat.messages.map((m) => m.mid).join(',');
check('FOLD later rows: seq order, tile still last', ids === 'u1,a1,t1,ph1', ids);
check('FOLD edit applied', chat.messages.find((m) => m.mid === 'a1').content === 'Hello');
check('FOLD each mid once', new Set(chat.messages.map((m) => m.mid)).size === chat.messages.length);
check('FOLD not ended yet', ends.length === 0);
log.push(wire('T1', 6, 'end', { status: 'done', totals: null, alerts: [], undo: null, tried: ['dev2'] }));
await TL.readChat(chat, D);
ids = chat.messages.map((m) => m.mid).join(',');
check('FOLD end: tile gone, rows stand', ids === 'u1,a1,t1', ids);
check('FOLD end: rows real', chat.messages.every((m) => !m.provisional));
check('FOLD end heard once, done', ends.join() === 'T1:done', ends.join());
check('FOLD cursor at the head', TL.logCursor(chat) === 6);
check('FOLD ended view dropped', !chat.logViews.T1);
check('FOLD an ended turn stays known ended (the detector\'s check)', TL.turnEnded && TL.turnEnded(chat, 'T1') === true);
check('FOLD an open or unseen turn is not', TL.turnEnded && TL.turnEnded(chat, 'T9') === false);

// ── REREAD ──
const before = JSON.stringify(chat.messages);
await TL.foldRows(chat, (await TL.openRows(log, seal, unwrap)).rows, D);
await TL.readChat(chat, D);
check('REREAD folds nothing twice', JSON.stringify(chat.messages) === before && ends.length === 1);

// ── GAP ──
seq = 40;
const late = [wire('T2', 1, 'msg', { mid: 'u2', role: 'user', text: 'again' })];
const g = { id: 'c2', _loaded: true, messages: [], logSeq: 3 };
const r = await TL.readChat(g, deps(doorOf(late, 41), []));
check('GAP resets and re-reads', r.ok && TL.logCursor(g) === 41 && g.messages.length === 1, JSON.stringify(r) + ' ' + g.logSeq);

// ── JOIN ──
const parcel = { mid: 'a9', role: 'assistant', content: 'done', ts: 5, at: '' };
const logged = { mid: 'a9', role: 'assistant', content: 'done', ts: 2005, seq: 77, member: 'acct', iturn: 'T9', provisional: 1 };
const j1 = law.msgJoin(parcel, logged), j2 = law.msgJoin(logged, parcel);
check('JOIN either order keeps the log order', j1.seq === 77 && j2.seq === 77 && j1.ts === 2005 && j2.ts === 2005,
	JSON.stringify([j1, j2]));
check('JOIN one copy either order', JSON.stringify(j1) === JSON.stringify(j2), JSON.stringify([j1, j2]));

// ── MEMBER ──
seq = 60;
const m = { id: 'c3', _loaded: true, messages: [] };
await TL.readChat(m, deps(doorOf([wire('T3', 1, 'msg', { mid: 'u3', role: 'user', text: 'x' }, 'bob')]), []));
check('MEMBER stamped on the row', m.messages[0] && m.messages[0].member === 'bob');

// ── ENDS ──
const isNotRun = (m) => !!m && !!m.interrupted && (!!m.notRun || m.why === 'notrun');
async function ended(status, rows, extra, ch) {
	seq = 100;
	const c = ch || { id: 'e1', _loaded: true, messages: [{ mid: 'u5', role: 'user', content: 'q', ts: 1, iturn: 'T5' }] };
	const w = rows.map((r, i) => wire('T5', i + 1, 'msg', r));
	w.push(wire('T5', rows.length + 1, 'end', Object.assign({ status, totals: null, alerts: [], undo: null, tried: ['dev9'] }, extra || {})));
	await TL.readChat(c, deps(doorOf(w), []));
	return c;
}
let e = await ended('done', [{ mid: 'a5', role: 'assistant', text: 'ok' }]);
check('ENDS done adds nothing', e.messages.map((m) => m.mid).join() === 'u5,a5' && !e.messages.some((m) => m.interrupted));
e = await ended('stopped', [{ mid: 'a5', role: 'assistant', text: 'part' }]);
check('ENDS stopped adds nothing', e.messages.map((m) => m.mid).join() === 'u5,a5' && !e.messages.some((m) => m.interrupted));
e = await ended('interrupted', [{ mid: 'a5', role: 'assistant', text: 'half' }]);
let a = e.messages.find((m) => m.mid === 'a5');
check('ENDS interrupted marks the answer runner-lost', a.interrupted === true && a.why === 'runner' && a.iturn === 'T5'
	&& e.messages.length === 2, JSON.stringify(e.messages));
e = await ended('interrupted', []);
a = e.messages[e.messages.length - 1];
check('ENDS interrupted with no answer adds the tile', a.mid === 'T5-end' && a.interrupted === true && a.why === 'runner'
	&& a.content === '' && a.itext === 'q', JSON.stringify(a));
e = await ended('not_run', [], { not_run: { why: 'sig:v1-refused', cause: 'abi', to: 'dev9', name: 'iphone' } });
a = e.messages[e.messages.length - 1];
check('ENDS not_run adds the not-run row', isNotRun(a) && a.mid === 'T5-nr' && a.why === 'runner' && a.itext === 'q'
	&& a.notRun.why === 'sig:v1-refused' && a.notRun.cause === 'abi' && a.notRun.name === 'iphone' && !('said' in a.notRun),
	JSON.stringify(a));
e = await ended('not_run', [], null, { id: 'e2', diamondId: 'd1', _loaded: true, messages: [] });
a = e.messages[e.messages.length - 1];
check('ENDS not_run in a Diamond is tagged notrun', isNotRun(a) && a.why === 'notrun' && a.notRun.why, JSON.stringify(a));
const had = { id: 'e3', _loaded: true, messages: [{ mid: 'T5-nr', role: 'assistant', content: '', interrupted: true, why: 'runner', iturn: 'T5', notRun: { why: 'old' }, ts: 2 }] };
e = await ended('not_run', [], null, had);
check('ENDS not_run joins a row already held', e.messages.filter((m) => m.mid === 'T5-nr').length === 1, JSON.stringify(e.messages));

// ── RESIDENT ──
// REL-1pg: the paired WebKit device's joinery chat, not resident, read on a tap. Folded, the
// log's one turn was all its `messages` held, so the rail named it "@err 500" and the pass
// that opens it by name never found it.
{
	const rlog = [wire('T9', 1, 'msg', { mid: 'u9', role: 'user', text: '@err 500' }, 'acct')];
	const cold = { id: 'n1', _loaded: false, messages: [] };
	const r = await TL.readChat(cold, deps(doorOf(rlog), []));
	check('RESIDENT a chat not loaded folds nothing', cold.messages.length === 0, JSON.stringify(cold.messages));
	check('RESIDENT its cursor does not move', TL.logCursor(cold) === 0, String(cold.logSeq));
	check('RESIDENT the read says so', r && r.ok === false && r.resident === false, JSON.stringify(r));
	cold._loaded = true;
	cold.messages = [{ mid: 'j1', role: 'user', content: 'Compare the three joinery quotes', ts: 500 }];
	await TL.readChat(cold, deps(doorOf(rlog), []));
	check('RESIDENT once loaded it folds under the transcript', cold.messages.map((m) => m.mid).join() === 'j1,u9',
		cold.messages.map((m) => m.mid).join());
}

// ── WHOLE ──
// REL-1n: the log adds to a transcript and never stands for one, so it folds only onto a
// transcript a load proved whole. Two ways the joinery chat still met it with none there.
{
	const wlog = [wire('T8', 1, 'msg', { mid: 'u8', role: 'user', text: '@err 500' }, 'acct')];
	const mids = (c) => c.messages.map((x) => x.mid).join();
	// A chat that never said whether its transcript is loaded.
	const bare = { id: 'n2', messages: [] };
	const r = await TL.readChat(bare, deps(doorOf(wlog), []));
	check('WHOLE a chat with no loaded flag folds nothing', bare.messages.length === 0, mids(bare));
	check('WHOLE its cursor does not move', TL.logCursor(bare) === 0 && r && r.resident === false, String(bare.logSeq));
	// The paired WebKit device: its cold store answers the open with an empty, `failed` read,
	// and the real `loadChatMessages` makes the chat resident all the same.
	const { liftSource } = await import('../../dev/syncprobe.mjs');
	let store = { messages: [], session: null, failed: true };
	const byTs = (a, b) => (a.ts || 0) - (b.ts || 0);
	const load = new Function('ChatStore', 'mergeMessages',
		liftSource(['loadChatMessages'], ['ChatStore', 'mergeMessages']).src + '\nreturn loadChatMessages;')(
		{ loadMessages: async () => store },
		(a, b) => { const by = {}; a.concat(b).forEach((x) => { by[x.mid] = x; }); return Object.values(by).sort(byTs); });
	const paired = { id: 'n3', name: '', _loaded: false, messages: [], msgCount: 182 };
	await load(paired);
	await TL.readChat(paired, deps(doorOf(wlog), []));
	check('WHOLE a cold read folds nothing', paired.messages.length === 0, mids(paired));
	check('WHOLE a cold read keeps the cursor', TL.logCursor(paired) === 0, String(paired.logSeq));
	store = { messages: [{ mid: 'j1', role: 'user', content: 'Compare the three joinery quotes', ts: 500 }], session: null };
	await load(paired);
	await TL.readChat(paired, deps(doorOf(wlog), []));
	check('WHOLE once the store settles it folds under the transcript', mids(paired) === 'j1,u8', mids(paired));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('turnlog: all passed');
