/* ============================================================
   Test -- the copies of one message converge (the message law, r53).
   ------------------------------------------------------------
   THE BUG (soak R4, `messagesRef.key`). `mergeMessages` unioned two
   transcripts by mid and kept the FIRST copy of a message it met, bar
   five named rules. Two copies of one message that differed any other
   way -- the prompt the phone wrote and the runner's copy of it, with
   and without `iturn`; a placeholder re-seated on one device -- stayed
   different for good: each device kept its own, the transcript bytes
   never agreed, and every pull fetched and re-unioned each such chat.

   THE LAW (`msgCmp`/`msgJoin`, daimond.js). ONE total order on a
   message's copies: standing (the runner's copy over a final frame's
   over a streamed row, wholesale), stamp `at`, the length of the body
   the copy stands for (a stored cut counts as the body it was cut
   from), then `ts`, field count and canonical form read off the stored
   form, and last the uncut copy over its own cut. The badge
   (`interrupted`/`why`) is joined on its own: Continue's clear
   (`interrupted: 0`) over everything, else the top standing's copies,
   off winning. Every in-place edit stamps `at` (`touchMsg`).

   WHAT IS CHECKED, through the REAL functions lifted from the tree
   under test (dev/syncprobe.mjs, `TREE=<checkout>` to aim it elsewhere):
     A. the join laws on generated transcripts, BYTE FOR BYTE (the
        manifest key is a hash of the bytes): idempotent, commutative,
        associative, a fixed point -- with stamps, badges and clears,
        partial copies, cut copies, key orders and undefined-valued keys
        drawn at random; and NEVER LOWER OVER HIGHER on the same draws:
        the join stands as high as every copy, holds as long a body as
        every copy of its standing and stamp, is the order's greatest,
        and keeps a clear; and the store's cut commutes with the join;
     B. what the law must mean: a partial copy never beats a whole one, a
        cut never the body it was cut from (QA F1: the empty tool log,
        the think log's first fragment, stamped or not), a stamped edit
        beats what it was made from, the badge comes off and a clear
        survives the runner's copy (QA F2), the stuck `iturn` pair settles
        on the copy that has it, a tie between two mids sorts the same in
        every locale.
   On release/r52 @ 69127922 (first-wins) A and most of B fail.
     node www/js/msglaw.test.mjs      # ALL PASS
   ============================================================ */
import { makeWindow, sliceDaimond, rng } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const NOW = 1_000_000_000;
const w = makeWindow({ now: NOW });
const { mergeMessages, msgCmp, copyStanding, msgBodyLen, slimMessages, clearBadge } = sliceDaimond(w,
	['mergeMessages', 'msgCmp', 'copyStanding', 'msgBodyLen', 'slimMessages', 'clearBadge'],
	{ loadMsgTombs: () => ({}) }).fns;

// The bytes a transcript travels as. Key order counts, and so does a key holding
// `undefined` (JSON drops it, as the parcel does).
const bytes = (msgs) => JSON.stringify(msgs);
const clone = (x) => structuredClone(x);
const J = (...lists) => {
	let acc = mergeMessages(clone(lists[0]), [], 'c1', {});
	for (let i = 1; i < lists.length; i++) acc = mergeMessages(acc, clone(lists[i]), 'c1', {});
	return acc;
};

// ── A. The laws ─────────────────────────────────────────────────────

function shuffled(r, a) {
	const o = a.slice();
	for (let i = o.length - 1; i > 0; i--) { const j = r.int(i + 1); [o[i], o[j]] = [o[j], o[i]]; }
	return o;
}
/// One copy of message `mid`: fields drawn from the shapes copies really take, in a
/// random key order.
function copy(r, mid) {
	const role = r.chance(0.8) ? 'assistant' : r.pick(['user', 'tool_log', 'think_log']);
	const f = [['mid', mid], ['role', role]];
	// A log may be long enough for the store to cut (`slimMessages`, below).
	const long = role.endsWith('_log') && r.chance(0.5);
	f.push(['content', long ? r.pick(LONG) : r.pick(['', 'si', 'six', 'six.', 'SIX', 'six, because'])]);
	if (r.chance(0.8)) f.push(['ts', r.pick([10, 11, 12])]);
	if (r.chance(0.6)) f.push(['at', r.pick([1000, 2000, 2000, 3000])]);
	if (r.chance(0.2)) f.push(['provisional', 1]);
	if (r.chance(0.2)) f.push(['framed', 1]);
	if (r.chance(0.2)) f.push(['elided', r.pick([0, 7])]);
	if (r.chance(0.35)) f.push(['interrupted', r.pick([true, true, 1, false, 0])]);
	if (r.chance(0.3)) f.push(['why', r.pick(['dispatched', 'paused'])]);
	if (r.chance(0.5)) f.push(['iturn', 'u1']);
	if (r.chance(0.3)) f.push(['ranOn', 'b']);
	if (r.chance(0.3)) f.push(['toDevice', r.pick(['x', 'y'])]);
	if (r.chance(0.2)) f.push(['triedDevices', r.pick([['x'], ['x', 'y']])]);
	if (r.chance(0.15)) f.push(['refused', r.chance(0.5) ? { status: 0, why: 'no' } : { why: 'no', status: 0 }]);
	if (r.chance(0.15)) f.push(['name', undefined]);
	const o = {};
	for (const [k, v] of shuffled(r, f)) o[k] = v;
	// Half the long logs arrive as the store keeps them: cut by the app's own hand.
	return (long && r.chance(0.5)) ? slimMessages([o])[0] : o;
}
// Bodies over both keeps (2048 for a tool log, 3072 for a think log), sharing a head
// and a tail so two of them cut to one stored form where only the middle differs.
const LONG = ['h'.repeat(2100) + 'a'.repeat(1500) + 't'.repeat(1100),
	'h'.repeat(2100) + 'b'.repeat(1500) + 't'.repeat(1100),
	'h'.repeat(2100) + 'a'.repeat(900) + 't'.repeat(1100)];
function transcript(r) {
	const out = [];
	for (const mid of ['u1', 'p1', 'a1']) {
		const n = r.pick([0, 1, 1, 2]);
		for (let i = 0; i < n; i++) out.push(copy(r, mid));
	}
	return shuffled(r, out);
}

console.log('\nA. the join laws, byte for byte, on generated transcripts\n');
{
	const r = rng(53);
	const TRIALS = 2000;
	const fail = { idempotent: 0, commutative: 0, associative: 0, 'fixed point': 0,
		'never lower over higher': 0, 'a clear stands': 0, 'the cut commutes with the join': 0 };
	const first = {};
	for (let i = 0; i < TRIALS; i++) {
		const x = transcript(r), y = transcript(r), z = transcript(r);
		const x1 = bytes(J(x));
		const note = (law, d) => { fail[law]++; if (!first[law]) first[law] = d; };
		if (bytes(J(x, x)) !== x1) note('idempotent', { x });
		if (bytes(J(JSON.parse(x1))) !== x1) note('fixed point', { x });
		if (bytes(J(x, y)) !== bytes(J(y, x))) note('commutative', { x, y, xy: J(x, y), yx: J(y, x) });
		if (bytes(J(J(x, y), z)) !== bytes(J(x, J(y, z)))) note('associative', { x, y, z });
		// NEVER LOWER OVER HIGHER: the join of every copy of a mid stands as high as each,
		// holds as long a body as each of its standing and stamp, and is the order's
		// greatest; a clear anywhere is a clear in the join.
		const xy = J(x, y), ins = x.concat(y);
		for (const m of xy) {
			for (const c of ins.filter((k) => k.mid === m.mid)) {
				const up = copyStanding(m) >= copyStanding(c) && msgCmp(m, c) >= 0
					&& !(copyStanding(m) === copyStanding(c) && (m.at || 0) === (c.at || 0) && msgBodyLen(m) < msgBodyLen(c));
				if (!up) note('never lower over higher', { join: m, copy: c });
				if (c.interrupted === 0 && m.interrupted !== 0) note('a clear stands', { join: m, copy: c });
			}
		}
		// The store keeps every transcript cut (`slimMessages`): a device that joined the
		// uncut copies and then cut holds what a device that met only the cuts holds.
		const cutAfter = w.DaimondStamp.canon(slimMessages(J(x, y)));
		const cutFirst = w.DaimondStamp.canon(J(slimMessages(clone(x)), slimMessages(clone(y))));
		if (cutAfter !== cutFirst) note('the cut commutes with the join', { x, y });
	}
	for (const law of Object.keys(fail)) {
		check(`${law} on ${TRIALS} generated triples`, fail[law] === 0,
			fail[law] ? fail[law] + ' failed; first: ' + JSON.stringify(first[law]).slice(0, 400) : '');
	}
}

// ── B. What the law means ───────────────────────────────────────────

const one = (out, mid) => out.filter((m) => m.mid === mid);
const both = (a, b) => [J(a, b), J(b, a)];
const same = (p) => bytes(p[0]) === bytes(p[1]);

console.log('\nB. a partial copy never beats a whole one\n');
{
	const real = { mid: 'a1', role: 'assistant', content: 'si', ts: 12, ranOn: 'b' };
	const prov = { mid: 'a1', role: 'assistant', content: 'six, because', ts: 12, provisional: 1, at: 9e12 };
	const p = both([prov], [real]);
	check('the runner\'s copy over a streamed row, though the row is longer and stamped later',
		same(p) && one(p[0], 'a1')[0].content === 'si' && !one(p[0], 'a1')[0].provisional, bytes(p[0]));
	const framed = { mid: 'a1', role: 'assistant', content: 'six, becau', ts: 12, framed: 1, at: 9e12 };
	const q = both([framed], [real]);
	check('the runner\'s copy over a final frame\'s, whatever the stamps',
		same(q) && !one(q[0], 'a1')[0].framed, bytes(q[0]));
}

console.log('\nB. a cut never stands over the body it was cut from (QA F1)\n');
{
	const BIG = 'R'.repeat(5000);
	const T = (o) => Object.assign({ mid: 't1', role: 'tool_log', iturn: 'u1', name: 'ls', ts: 5 }, o);
	// A tool log is pushed EMPTY and filled in place; a save between the two leaves both on
	// disk, the fill as the store cuts it.
	for (const [label, pend, filled] of [
		['stamped (this build)', T({ content: '', at: 1000 }), T({ content: BIG, outcome: 'done', at: 2000 })],
		['unstamped (an older build\'s copies)', T({ content: '' }), T({ content: BIG, outcome: 'done' })],
	]) {
		const cut = slimMessages([filled])[0];
		const p = both([pend], [cut]);
		const m = one(p[0], 't1')[0];
		check('the filled tool result over the empty copy, stored cut, ' + label,
			same(p) && m.outcome === 'done' && m.elided === 5000 - 2048, bytes(p[0]).slice(0, 160));
		// A chunk history holds both, in either order, and the reader joins it.
		check('and a chunk history of both reads back filled, ' + label,
			one(J([pend, cut]), 't1')[0].outcome === 'done' && one(J([cut, pend]), 't1')[0].outcome === 'done');
	}
	// A think log is pushed short and grown in place.
	const th1 = { mid: 'k1', role: 'think_log', content: 'short thought', iturn: 'u1', ts: 6 };
	const th2 = slimMessages([Object.assign({}, th1, { content: 'short thought' + 'x'.repeat(6000) })])[0];
	for (const [label, a, b] of [['stamped', Object.assign({}, th1, { at: 1000 }), Object.assign({}, th2, { at: 3000 })],
		['unstamped', th1, th2]]) {
		const p = both([a], [b]);
		check('the grown think log over its first fragment, ' + label, same(p) && one(p[0], 'k1')[0].elided > 0, bytes(p[0]).slice(0, 120));
	}
	// The uncut body and its own cut: the uncut copy, so the tab holding it re-cuts from it.
	const full = T({ content: BIG, outcome: 'done', at: 2000 });
	const own = slimMessages([full])[0];
	const q = both([own], [full]);
	check('the uncut body over its own cut, at one stamp', same(q) && !one(q[0], 't1')[0].elided && one(q[0], 't1')[0].content === BIG);
	check('and the store keeps the same cut either way', bytes(slimMessages(q[0])) === bytes([own]));
	// THE TRADE, stated: an edit stamped on a stored cut is a later write and stands. The
	// uncut text lived only in the memory of the tab that ran the turn (every save and
	// every parcel carries the cut), so what the store keeps is the same either way.
	const edited = Object.assign(clone(own), { iturn: 'u9', at: 3000 });
	const r = both([full], [edited]);
	check('an edit stamped on a stored cut stands over the older uncut body',
		same(r) && one(r[0], 't1')[0].iturn === 'u9', bytes(r[0]).slice(0, 160));
	check('and a device that held only the cut stores the same bytes',
		bytes(slimMessages(r[0])) === bytes(J([own], [edited])));
}

console.log('\nB. an edit made after seeing a copy beats it\n');
{
	const old = { mid: 'p1', role: 'assistant', content: '', why: 'dispatched', interrupted: true, iturn: 'u1', toDevice: 'x', parkCount: 0, ts: 11, at: 2000 };
	const reseat = Object.assign(clone(old), { toDevice: 'y', parkCount: 1, ts: 40, at: w.DaimondStamp.next(2000) });
	const p = both([old], [reseat]);
	check('a re-seat (stamped) is the copy on both devices, in either order',
		same(p) && one(p[0], 'p1')[0].toDevice === 'y' && one(p[0], 'p1')[0].parkCount === 1, bytes(p[0]));
	// An older build's re-seat moves no stamp: it is still decided the same both ways.
	const legacy = Object.assign(clone(old), { toDevice: 'z' });
	check('an unstamped edit (an older build\'s) is decided the same way both ways', same(both([old], [legacy])));
}

console.log('\nB. the badge comes off, and stays off\n');
{
	const badged = { mid: 'a1', role: 'assistant', content: 'the whole partial', ts: 12, interrupted: true, why: 'offline', iturn: 'u1', at: 9e12 };
	const cleared = { mid: 'a1', role: 'assistant', content: 'the whole', elided: 8, ts: 12, iturn: 'u1', at: 1000 };
	const p = both([badged], [cleared]);
	const a = one(p[0], 'a1')[0];
	check('off wins over a copy stamped later, and the fuller body is kept',
		same(p) && !a.interrupted && !a.why && a.content === 'the whole partial', bytes(p[0]));
	const prov = { mid: 'a1', role: 'assistant', content: 'the whole partial', ts: 12, iturn: 'u1', provisional: 1 };
	const q = both([prov], [badged]);
	check('but a streamed row says nothing about the badge: the real copy keeps it',
		same(q) && one(q[0], 'a1')[0].interrupted === true, bytes(q[0]));
}

console.log('\nB. a clear survives the runner\'s copy (QA F2)\n');
{
	// "Run it here" on a turn the runner paused: Continue takes the badge off the copy
	// this device holds, a final frame's or a streamed row, and the runner's own copy,
	// badged and standing higher, lands after.
	const real = { mid: 'a1', role: 'assistant', content: 'half an answer', iturn: 'u1', ts: 10, interrupted: true, why: 'paused', itext: 'go', ranOn: 'b' };
	for (const flag of ['framed', 'provisional']) {
		const held = { mid: 'a1', role: 'assistant', content: 'half an answer', iturn: 'u1', ts: 10, interrupted: 1, ranOn: 'b', [flag]: 1 };
		clearBadge(held);
		const p = both([held], [real]);
		const m = one(p[0], 'a1')[0];
		check('a clear on a ' + flag + ' copy stands when the runner\'s badged copy lands',
			same(p) && m.interrupted === 0 && m.why === undefined && !m[flag] && m.itext === 'go', bytes(p[0]));
	}
	const streamed = { mid: 'a1', role: 'assistant', content: 'half an', iturn: 'u1', ts: 10, provisional: 1 };
	const q = both([streamed], [real]);
	check('a streamed row that merely lacks the badge is no clear: the runner\'s badge stays',
		same(q) && one(q[0], 'a1')[0].interrupted === true, bytes(q[0]));
}

console.log('\nB. the stuck pairs the soak found settle\n');
{
	// c3/c20: the phone's prompt carries `iturn`; the runner's graft of it does not.
	const phone = { role: 'user', content: 'what is three plus three', mid: 'u1', iturn: 'u1', ts: 10 };
	const graft = { role: 'user', content: 'what is three plus three', mid: 'u1', ts: 10 };
	const p = both([phone], [graft]);
	check('unstamped (today\'s copies): both devices keep the copy with `iturn`',
		same(p) && one(p[0], 'u1')[0].iturn === 'u1', bytes(p[0]));
	const stamped = Object.assign(clone(phone), { at: 1500 });
	const rebuilt = { role: 'user', content: 'what is three plus three', mid: 'u1', iturn: 'u1', ts: 99 };
	const q = both([stamped], [rebuilt]);
	check('stamped (this build): the phone\'s own copy, with its `ts`, over the runner\'s rebuilt one',
		same(q) && one(q[0], 'u1')[0].ts === 10, bytes(q[0]));
	// c9: a final frame's copies against the runner's, which carry what it ran.
	const fr = { mid: 'a1', role: 'assistant', content: 'six', ts: 12, ranOn: 'b', iturn: 'u1', framed: 1 };
	const rn = { mid: 'a1', role: 'assistant', content: 'six', ts: 12, ranOn: 'b', iturn: 'u1', ranMs: 812, ranModel: 'm', ranCost: 0.01 };
	const s = both([fr], [rn]);
	check('the runner\'s copy with its run figures over the framed one', same(s) && one(s[0], 'a1')[0].ranMs === 812, bytes(s[0]));
	const k1 = { mid: 'a1', role: 'assistant', content: 'six', ts: 12 };
	const k2 = { ts: 12, content: 'six', role: 'assistant', mid: 'a1' };
	check('two copies equal but for key order settle on one set of bytes', same(both([k1], [k2])));
}

console.log('\nB. a tie in time sorts the same in every locale\n');
{
	const out = J([{ mid: 'a1', role: 'user', content: 'x', ts: 5 }, { mid: 'B1', role: 'user', content: 'y', ts: 5 }]);
	check('by code point: "B1" before "a1" (a locale collation puts "a1" first)',
		out.map((m) => m.mid).join(',') === 'B1,a1', out.map((m) => m.mid).join(','));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
if (failures) process.exitCode = 1;
