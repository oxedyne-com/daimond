/* ============================================================
   Test: the final frame is the answer once the hand-off is done (owner, queue
   item 7, 2026-09-25), and the runner's own copy still replaces it.

   The sending device folds the runner's final frame as provisional rows. With
   the `done` report, or a lease that settled, those rows are the finished turn:
   `adoptFinalFrame` saves them real (marked `framed`) and the placeholder drops.
   `mergeMessages` then lets the runner's own copy replace a framed one by mid,
   in either order, and never the reverse.

   Lifts the REAL `stampMessages`, `unbadge`, `mergeMessages`,
   `dispatchedAnswerPresent`, `dispatchedPlaceholderIn`, `handoffLeaseSettled`,
   `handoffDone` and `adoptFinalFrame` out of daimond.js, and the real
   `settledLease` rule out of peer.js.

     MERGE   a framed copy vs the runner's (either order), vs a provisional one
     ADOPT   no done yet: nothing moves; a done report or a settled lease: the
             frame's rows go real, the placeholder drops, a real row is left alone
     RELOAD  the adopted rows are what the store holds (persistChats called)
     WHOLE   only a final frame every row of which the runner marked uncut, with
             no row left out, may become the answer (`progressRow`, `frameWhole`)

   Run:  node www/js/framedanswer.test.mjs
   On 7ca624dd's daimond.js: adoptFinalFrame is missing (ABORT).
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

/// Lifts `function name(...) { ... }` out of `src` by counting braces.
function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const src  = readFileSync(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');
const psrc = readFileSync(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8');
const lifted = new Function('env', [
	'var OLD_LEGACY = /^legacy-\\d+$/;',
	'var REASON_DISPATCHED_STR = "dispatched";',
	'function loadMsgTombs() { return {}; }',
	'var window = env.window, DaimondPeer = env.window.DaimondPeer, DaimondLease = env.window.DaimondLease;',
	'var peerReports = env.peerReports, _finalMids = env.finalMids;',
	'function dispatchedChat(t) { return env.chatFor(t); }',
	'function chatHoldingTurn(t) { return env.holding ? env.holding(t) : null; }',
	'function touchChat() {}',
	'function persistChats() { env.persisted++; }',
	'function diag() {}',
	'function renderDispatchedBadges() { env.badges++; }',
	'function dropDispatchedPlaceholder(t) { env.dropped.push(t); var c = env.chatFor(t); c.messages = c.messages.filter(function (m) { return !(m.why === "dispatched" && m.iturn === t); }); }',
	extractFn(src, 'stampMessages'),
	extractFn(src, 'unbadge'),
	extractFn(src, 'mergeMessages'),
	extractFn(src, 'dispatchedAnswerPresent'),
	extractFn(src, 'dispatchedPlaceholderIn'),
	extractFn(src, 'handoffLeaseSettled'),
	extractFn(src, 'handoffDone'),
	extractFn(src, 'finalFrameChat'),
	extractFn(src, 'adoptFinalFrame'),
	'return { mergeMessages: mergeMessages, adoptFinalFrame: adoptFinalFrame };',
].join('\n'));
const settledLease = new Function(extractFn(psrc, 'settledLease') + '\nreturn settledLease;')();

function world(lease) {
	const env = {
		window: {
			DaimondPeer:  { settledLease },
			DaimondLease: { record: () => lease || null },
		},
		peerReports: {}, finalMids: {}, persisted: 0, badges: 0, dropped: [], chat: null,
		chatFor: () => env.chat,
	};
	return Object.assign(env, lifted(env));
}

const user  = () => ({ mid: 'u1', role: 'user', content: 'what is three plus three', ts: 10 });
const place = () => ({ mid: 'p1', role: 'assistant', content: '', why: 'dispatched', iturn: 'u1', ts: 11 });
const prov  = (mid, c) => ({ mid, role: 'assistant', content: c, ts: 12, ranOn: 'b', iturn: 'u1', provisional: 1 });
const real  = (mid, c) => ({ mid, role: 'assistant', content: c, ts: 12, ranOn: 'b', iturn: 'u1' });
const framed = (mid, c) => ({ mid, role: 'assistant', content: c, ts: 12, ranOn: 'b', iturn: 'u1', framed: 1 });
const find  = (out, mid) => out.filter((m) => m.mid === mid);

console.log('\nMERGE: the runner\'s copy over a framed one, in either order\n');
{
	const { mergeMessages } = world();
	const clip = framed('a1', 'six, becau');				// a frame clipped short of the answer
	const full = real('a1', 'SIX. Because three and three.');	// and not a prefix of it
	for (const [name, a, b] of [['framed first', [user(), clip], [user(), full]], ['runner first', [user(), full], [user(), clip]]]) {
		const a1 = find(mergeMessages(a, b, 'c1', {}), 'a1');
		check('the runner\'s copy stands (' + name + ')', a1.length === 1 && !a1[0].framed && a1[0].content === full.content, JSON.stringify(a1));
	}
	const pf = find(mergeMessages([user(), prov('a1', 'six')], [user(), framed('a1', 'six')], 'c1', {}), 'a1');
	check('a framed copy replaces a provisional one', pf.length === 1 && pf[0].framed && !pf[0].provisional, JSON.stringify(pf));
	const fp = find(mergeMessages([user(), framed('a1', 'six')], [user(), prov('a1', 'six')], 'c1', {}), 'a1');
	check('and a provisional one never replaces a framed one', fp.length === 1 && fp[0].framed && !fp[0].provisional, JSON.stringify(fp));
	const ff = find(mergeMessages([user(), framed('a1', 'si')], [user(), framed('a1', 'six')], 'c1', {}), 'a1');
	check('[ctl] two framed copies converge on the longer', ff.length === 1 && ff[0].content === 'six', JSON.stringify(ff));
}

console.log('\nADOPT: the final frame goes real only once the turn is done\n');
function sending(lease) {
	const w = world(lease);
	w.chat = { id: 'c1', messages: [user(), place(), prov('t1', 'thinking'), prov('a1', 'six'), real('a0', 'kept real')] };
	w.chat.messages[4].iturn = 'u1';
	w.finalMids.u1 = { t1: 1, a1: 1, a0: 1 };
	return w;
}
{
	const w = sending(null);
	check('no report and no settled lease: nothing moves', w.adoptFinalFrame('u1') === false
		&& w.chat.messages.filter((m) => m.provisional).length === 2 && !w.dropped.length);
	check('[ctl] and the frame\'s mids are kept for when it is', !!w.finalMids.u1);
}
{
	const w = sending(null);
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'parked' };
	check('[ctl] a parked report is not done', w.adoptFinalFrame('u1') === false);
}
{
	const w = sending(null);
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	check('a done report: adopted', w.adoptFinalFrame('u1') === true);
	const ms = w.chat.messages;
	check('the frame\'s rows are real and framed', ['t1', 'a1'].every((mid) => { const m = find(ms, mid)[0]; return m && !m.provisional && m.framed === 1; }),
		JSON.stringify(ms));
	check('a row already real is left as it was', (() => { const m = find(ms, 'a0')[0]; return m && !m.framed && m.content === 'kept real'; })());
	check('the placeholder dropped (no "Sent to your other devices")', w.dropped.join() === 'u1' && !ms.some((m) => m.why === 'dispatched'));
	check('RELOAD: and the store was written with them', w.persisted === 1);
	check('exactly one copy of each mid', ms.map((m) => m.mid).sort().join() === 'a0,a1,t1,u1', ms.map((m) => m.mid).join());
	check('a second call moves nothing', w.adoptFinalFrame('u1') === false && w.persisted === 1);
}
{
	const w = sending({ turnId: 'u1', holder: 'b', mode: 'released', expiry: 0, settled: 1 });
	check('a lease released from done, no report in this tab: adopted (the second tab\'s case)',
		w.adoptFinalFrame('u1') === true && !w.chat.messages.some((m) => m.provisional) && w.dropped.join() === 'u1');
}
{
	const w = sending({ turnId: 'u1', holder: 'b', mode: 'released', expiry: 0 });
	check('[ctl] a lease released without a settle (a take-back) adopts nothing', w.adoptFinalFrame('u1') === false);
}
{
	const w = sending(null);
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	w.adoptFinalFrame('u1');
	const after = w.mergeMessages(w.chat.messages, [user(), real('a1', 'six'), real('t1', 'thinking, in full')], 'c1', {});
	check('the runner\'s parcel then lands: its copies replace the framed ones, once each',
		['a1', 't1'].every((mid) => { const x = find(after, mid); return x.length === 1 && !x[0].framed && !x[0].provisional; }),
		JSON.stringify(after));
}

console.log('\nWHOLE: only a frame the runner marked whole may become the answer\n');
{
	// The real peer.js, in a bare window (its streaming functions read no siblings).
	const win = {};
	new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date',
		'with (window) {\n' + readFileSync(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8') + '\n}')(win, undefined, console, setTimeout, clearTimeout, Date);
	const P = win.DaimondPeer;
	const turn = (answer, extra) => [{ role: 'user', content: 'q', mid: 'U', iturn: 'U', ts: 1 }].concat(extra || [],
		[{ role: 'assistant', content: answer, mid: 'AN', iturn: 'U', ranOn: 'b', ts: 99 }]);
	const small = P.progressTail(turn('six'), 'U', 36 * 1024);
	check('an ordinary final frame is whole', P.frameWhole(small) && small.every((r) => r.whole === 1), JSON.stringify(small));
	const big = P.progressTail(turn('Z'.repeat(20 * 1024 + 7)), 'U', 36 * 1024);
	check('a 20 KiB answer is cut to the row limit and its row is not whole', big.length === 1 && big[0].content.length < 20 * 1024 && !big[0].whole && !P.frameWhole(big),
		JSON.stringify(big.map((r) => ({ n: r.content.length, whole: r.whole }))));
	const many = [];
	for (let i = 0; i < 6; i++) many.push({ role: 'assistant', content: 'Y'.repeat(8 * 1024), mid: 'T' + i, ts: 2 + i });
	const over = P.progressTail(turn('six', many), 'U', 36 * 1024);
	check('a frame that left its oldest rows out is not whole, though each row it kept is uncut', over.length < 7 && !P.frameWhole(over),
		over.length + ' rows; whole ' + over.filter((r) => r.whole).length);
	check('[ctl] a frame from a build that marks nothing is not whole', !P.frameWhole([{ mid: 'AN', role: 'assistant', content: 'six' }]));
	check('[ctl] nor is an empty one', !P.frameWhole([]));
}

console.log('\nLATE: a final frame whose placeholder has already gone (hand-off QA F4, round 2)\n');
{
	// A settled lease dropped the placeholder before the final frame was folded, fetched whole
	// from the chunks or read on the watch's last read: the chat is found by the turn itself.
	const w = world();
	const held = { id: 'c1', messages: [user(), prov('a1', 'six')] };
	w.chat = null;						// no placeholder index for the turn any more
	w.holding = (t) => (t === 'u1' ? held : null);
	w.finalMids.u1 = { a1: 1 };
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	check('the whole frame is still adopted in the chat holding the turn', w.adoptFinalFrame('u1') === true
		&& held.messages[1].framed === 1 && !held.messages[1].provisional, JSON.stringify(held.messages[1]));
	const w2 = world();
	w2.chat = null;
	w2.holding = () => null;
	w2.finalMids.u1 = { a1: 1 };
	w2.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	check('[ctl] and nothing moves where no chat holds it', w2.adoptFinalFrame('u1') === false);
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);
