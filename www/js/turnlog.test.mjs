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
const chat = { id: 'c1', messages: [user, tile] };
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
const g = { id: 'c2', messages: [], logSeq: 3 };
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
const m = { id: 'c3', messages: [] };
await TL.readChat(m, deps(doorOf([wire('T3', 1, 'msg', { mid: 'u3', role: 'user', text: 'x' }, 'bob')]), []));
check('MEMBER stamped on the row', m.messages[0] && m.messages[0].member === 'bob');

// ── ENDS ──
const isNotRun = (m) => !!m && !!m.interrupted && (!!m.notRun || m.why === 'notrun');
async function ended(status, rows, extra, ch) {
	seq = 100;
	const c = ch || { id: 'e1', messages: [{ mid: 'u5', role: 'user', content: 'q', ts: 1, iturn: 'T5' }] };
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
e = await ended('not_run', [], null, { id: 'e2', diamondId: 'd1', messages: [] });
a = e.messages[e.messages.length - 1];
check('ENDS not_run in a Diamond is tagged notrun', isNotRun(a) && a.why === 'notrun' && a.notRun.why, JSON.stringify(a));
const had = { id: 'e3', messages: [{ mid: 'T5-nr', role: 'assistant', content: '', interrupted: true, why: 'runner', iturn: 'T5', notRun: { why: 'old' }, ts: 2 }] };
e = await ended('not_run', [], null, had);
check('ENDS not_run joins a row already held', e.messages.filter((m) => m.mid === 'T5-nr').length === 1, JSON.stringify(e.messages));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('turnlog: all passed');
