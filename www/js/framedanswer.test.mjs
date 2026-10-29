/* ============================================================
   Test: the final frame is the answer once the hand-off is done (owner, queue
   item 7, 2026-09-25), and the runner's own copy still replaces it.

   The sending device folds the runner's final frame as provisional rows. With
   the `done` report, or a lease that settled, those rows are the finished turn:
   `adoptFinalFrame` saves them real (marked `framed`) and the placeholder drops.
   `mergeMessages` then lets the runner's own copy replace a framed one by mid,
   in either order, and never the reverse.

   Lifts the REAL `stampMessages`, the message law, `mergeMessages`,
   `dispatchedAnswerPresent`, `dispatchedPlaceholderIn`, `handoffLeaseSettled`,
   `handoffDone` and `adoptFinalFrame` out of daimond.js, and the real
   `settledLease` rule out of peer.js.

     MERGE   a framed copy vs the runner's (either order), vs a provisional one
     ADOPT   no done yet: nothing moves; a done report or a settled lease: the
             frame's rows go real, the placeholder drops, a real row is left alone
     RELOAD  the adopted rows are what the store holds (persistChats called)
     WHOLE   only a final frame every row of which the runner marked uncut, with
             no row left out, may become the answer (`progressRow`, `frameWhole`)
     REF     a 100 kB answer the runner sent as a head and a `ref` (REPLY-REF):
             a second device with no report adopts the whole from the chunks
     NATIVE  a native turn of 22 rows over 64 KB (UNBLOCK-42): an early settling
             report ended the watch, the chunked final frame came after, then `done`
             with `finalTail`; the done report reads the frame, and all 22 rows land
             whole, in order, once (`readReportedFinal`)

     CLOSED  a native turn of 36 rows (UNBLOCK-44b): 34 drawn from provisional frames, the
             report `done` ends the watch, whose last read finds the door empty (the door
             keeps one frame per account); the done report must still read the chunked
             final, and the answer row (`-final`) and the ending land real

     LIVE    a native turn's provisional frames, drawn as they come on the asker and on
             a second device (UNBLOCK-43): three frames, the third over the cap and so
             missing its front rows, then a chunked final that cut a row; each row shows
             once and in the runner's order, and the adoption leaves exactly the final rows

     FILES   the Files row a runner's turn gets here (`<run>-files`, UNBLOCK-46): made while
             the final frame is adopted inside its own awaits, it still lands in the chat, and
             made first, the adoption and the runner's parcel leave it

   Run:  node www/js/framedanswer.test.mjs
   On 7ca624dd's daimond.js: adoptFinalFrame is missing (ABORT).
   On 0e21f01fa's: readReportedFinal is missing, NATIVE fails.
   On a6aaae055's: a frame missing its front rows draws its new row above the turn, LIVE fails.
   On aa5fab050's (ccp14): the watch's close keeps the streamed rows as a final view, the done
   report takes it as folded and reads nothing, CLOSED fails.
   On 1d13d0b4a's: a frame of only new rows (a frame missed) draws them above the turn, LIVE fails.
   On 47a27e90b's: the Files row is spliced into the array the adoption replaced, FILES RACE fails.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

/// Lifts `function name(...) { ... }` out of `src` by counting braces, past the quoted
/// strings and comments (`parseFrameRef` tests for a `'{'`).
function extractFn(src, name) {
	let start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) throw new Error('function not found: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
		if (src[i] === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 1; continue; }
		if (src[i] === "'" || src[i] === '"') {
			const q = src[i];
			for (i++; i < src.length && src[i] !== q; i++) if (src[i] === '\\') i++;
			continue;
		}
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

/// Lifts the one-line `var name = ...;` declaration out of `src`.
function extractVar(src, name) {
	const m = src.match(new RegExp('^\\tvar ' + name + ' = [^\\n]*;$', 'm'));
	if (!m) throw new Error('var not found: ' + name);
	return m[0].slice(1);
}

// The message law is lifted with everything `mergeMessages` reaches (dev/syncprobe.mjs
// `liftSource`), from the same tree as DAIMOND_JS, so no hand-kept list can drift from it.
if (process.env.DAIMOND_JS && !process.env.TREE) process.env.TREE = join(dirname(process.env.DAIMOND_JS), '..', '..');
const { liftSource } = await import('../../dev/syncprobe.mjs');
const src  = readPage(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');
const psrc = readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8');
const HAS_READ = src.indexOf('\n\tfunction readReportedFinal(') >= 0;
const lifted = new Function('env', [
	'var REASON_DISPATCHED_STR = "dispatched";',
	'function loadMsgTombs() { return {}; }',
	'var window = env.window, DaimondPeer = env.window.DaimondPeer, DaimondLease = env.window.DaimondLease;',
	'var peerReports = env.peerReports, _finalMids = env.finalMids, _finalRun = env.finalRun, _abiRefused = env.abiRefused || {};',
	'var current = null; function renderHistory() {}',
	// What `fetchFinalRef` and `applyProvisional` read beside the lifted law (REPLY-REF).
	'var DaimondChunks = env.window.DaimondChunks, DaimondSync = env.window.DaimondSync, _refFetch = {}, _progressView = env.progressView, _renderedSigs = null;',
	// What `onLastFrame` reaches beside them (NATIVE): no ABI floor, no panels, no workers.
	'function frameAbiOk() { return true; } function refuseAbiFrame() {} function applyFrameUi() {} function setFrameWorkers() {}',
	'function ownsChat() { return true; } function growProvisionalTiles() {} function sigsOf() { return null; }',
	'function msgTombstone(mids) { env.tombs.push.apply(env.tombs, mids); }',
	'function dispatchedChat(t) { return env.chatFor(t); }',
	'function chatHoldingTurn(t) { return env.holding ? env.holding(t) : null; }',
	'function touchChat() {}',
	'function persistChats() { env.persisted++; }',
	'function diag() {}',
	'function renderDispatchedBadges() { env.badges++; }',
	'function dropDispatchedPlaceholder(t) { env.dropped.push(t); var c = env.chatFor(t); c.messages = c.messages.filter(function (m) { return !(m.why === "dispatched" && m.iturn === t); }); }',
	// The message law (r53), lifted whole, and the stamp rule it ranks by.
	'var DaimondStamp = (function () { var window = {}; ' + readPage(join(HERE, 'stamp.js'), 'utf8') + '\n return window.DaimondStamp; })();',
	liftSource(['mergeMessages'], ['loadMsgTombs', 'window', 'DaimondStamp']).src,
	extractFn(src, 'dispatchedAnswerPresent'),
	extractFn(src, 'dispatchedPlaceholderIn'),
	extractFn(src, 'handoffLeaseSettled'),
	extractFn(src, 'handoffDone'),
	// The latency instrument's arrive seam (U0) that `adoptFinalFrame` reports to.
	extractVar(src, 'ARRIVE_FRESH_MS'),
	extractFn(src, 'noteArrive'),
	extractFn(src, 'finalFrameChat'),
	extractFn(src, 'dropOtherRunRows'),
	// The lost-row predicate the adopted frame reads (SUHT-R F1+F3).
	extractFn(src, 'isNotRunRow'),
	extractFn(src, 'isLostRow'),
	// The fold of a native runner's figures, which the adoption calls (RT-C).
	...['FOLDED_RUNS_MAX', 'NATIVE_FIGS', 'HERE_FIELDS', 'TOTAL_FIELDS'].map((n) => extractVar(src, n)),
	...['runKeyCmp', 'hasNativeRuns', 'hereOf', 'nativeBaseWinner', 'nativeJoin', 'deriveNativeTotals', 'runFolded', 'markRunFolded', 'runnerRoadNative', 'foldRunnerTotals'].map((n) => extractFn(src, n)),
	extractFn(src, 'adoptFinalFrame'),
	extractFn(src, 'applyProvisional'),
	extractFn(src, 'fetchFinalRef'),
	...['uiWebUrl', 'frameUi', 'parseFrameRef', 'onLastFrame'].map((n) => extractFn(src, n)),
	// The read a `done` report makes of the door (NANCY); absent on the base, where NATIVE fails.
	...(HAS_READ ? [extractVar(src, '_reportRead'), extractFn(src, 'readReportedFinal')] : ['function readReportedFinal() { return false; }']),
	src.indexOf('\n\tfunction otherErrandReport(') >= 0 ? extractFn(src, 'otherErrandReport') : 'function otherErrandReport() { return false; }',
	// The watch's frame reader (LIVE): every device that watches the turn draws through it.
	'var _progressWatched = env.watched || {};',
	extractFn(src, 'onProgressFrame'),
	// The watch's end (CLOSED): what a settling report runs before it reads the door.
	'var _watchIx = env.watchIx || {}, _progressSent = {}, _frameWorkers = {};',
	extractFn(src, 'updateProgressWatch'),
	// The Files row a runner's turn gets here (UNBLOCK-46), with its version-store reads stubbed:
	// `env.during` runs inside the first await, where a final frame's adoption may land.
	'var DaimondProvenance = { h: { file: function (s, v, p) { return s + "@" + v + ":" + p; } } };',
	'function carriedProdBase() { return null; }',
	'async function turnFileProds() { await null; if (env.during) env.during(); return ["h1"]; }',
	'async function turnFileList() { return [{ path: "a.txt" }]; }',
	extractFn(src, 'carriedFilesRow'),
	'return { carriedFilesRow: carriedFilesRow, mergeMessages: mergeMessages, adoptFinalFrame: adoptFinalFrame, fetchFinalRef: fetchFinalRef, readReportedFinal: readReportedFinal, otherErrandReport: otherErrandReport, onProgressFrame: onProgressFrame, updateProgressWatch: updateProgressWatch, progressView: _progressView };',
].join('\n'));
const settledLease = new Function(extractFn(psrc, 'settledLease') + '\nreturn settledLease;')();
const otherRunRows = (psrc.indexOf('function otherRunRows(') >= 0)
	? new Function(extractFn(psrc, 'turnSpan') + '\n' + extractFn(psrc, 'otherRunRows') + '\nreturn otherRunRows;')() : null;

function world(lease) {
	const env = {
		window: {
			DaimondPeer:  { settledLease, otherRunRows },
			DaimondLease: { record: () => lease || null },
		},
		peerReports: {}, finalMids: {}, finalRun: {}, tombs: [], persisted: 0, badges: 0, dropped: [], chat: null, progressView: {},
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
	// A reload on the runner mid-turn: run R1 streamed rows, R2 reran and finished (F-C2-1).
	const w = sending(null);
	w.chat.messages.splice(2, 0, Object.assign(real('x1', 'lost run tool'), { run: 'R1' }), prov('x2', 'lost run stream'));
	w.chat.messages.push(Object.assign(real('a2', 'kept run'), { run: 'R2' }));
	w.finalMids.u1.a2 = 1;
	w.finalRun.u1 = 'R2';
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	check('LOST RUN: adopted', w.adoptFinalFrame('u1') === true);
	const ms = w.chat.messages;
	check('a real row of another run goes, and is tombstoned', !find(ms, 'x1').length && w.tombs.join() === 'x1', JSON.stringify(w.tombs));
	check('a provisional row the whole frame does not hold goes, untombstoned', !find(ms, 'x2').length && w.tombs.indexOf('x2') < 0);
	check('[ctl] the kept run\'s rows and the unstamped real row stand', ['t1', 'a1', 'a0', 'a2'].every((mid) => find(ms, mid).length === 1),
		ms.map((m) => m.mid).join());
	check('the run is consumed', !('u1' in w.finalRun));
}
{
	const w = sending(null);
	w.chat.messages = [user(), place(), Object.assign(prov('i1', ''), { interrupted: true, why: 'runner', run: 'R1' })];
	w.finalMids.u1 = {};
	w.finalMids.u1.i1 = 1;
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	check('a lost run\'s interrupted answer drops the placeholder', w.adoptFinalFrame('u1') === true && w.dropped.join() === 'u1');
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
		'with (window) {\n' + readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8') + '\n}')(win, undefined, console, setTimeout, clearTimeout, Date);
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

console.log('\nREF: a long answer sent as a head and a ref is adopted whole (REPLY-REF)\n');
{
	// The real peer.js, as WHOLE loads it, beside the settled-lease rule.
	const win = {};
	new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date',
		'with (window) {\n' + readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8') + '\n}')(win, undefined, console, setTimeout, clearTimeout, Date);
	// About 100 kB, of every UTF-8 width, as the runner's errand_settle arm sends it.
	let long = '';
	for (let i = 0; i < 10000; i++) long += String(i).padStart(4, '0') + 'é€😀 ';
	// The runner's body (settle.rs `ref_body`): one `final_row`, marked whole.
	const row = { mid: 'AN', role: 'assistant', content: long, ts: 12, run: 'R1', ranOn: 'b', ranMs: 900, ranCost: 0, whole: 1 };
	const body = new TextEncoder().encode(JSON.stringify({ v: 1, turn: 'u1', msgs: [row] }));
	const ref = { v: 2, size: body.length, key: 'k', chunks: [{ addr: 'a', size: body.length }] };
	const w = world({ turnId: 'u1', holder: 'b', mode: 'released', expiry: 0, settled: 1 });
	w.window.DaimondPeer = Object.assign({}, win.DaimondPeer, { settledLease, otherRunRows });
	let asked = null;
	w.window.DaimondChunks = { materialiseBytes: async (r) => { asked = r; return body; } };
	Object.assign(w, lifted(w));
	// The second device: the chat holds the turn and the streamed head, cut short; no report.
	const head = prov('AN', long.slice(0, 16 * 1024));
	w.chat = { id: 'c1', messages: [user(), place(), head] };
	w.fetchFinalRef('u1', ref, 1);
	for (let i = 0; i < 20 && !w.persisted; i++) await new Promise((r) => setTimeout(r, 0));
	const an = find(w.chat.messages, 'AN');
	check('the ref is read from the chunks', asked === ref);
	check('no report here', !w.peerReports.u1);
	check('the answer is adopted whole, byte for byte', an.length === 1 && an[0].content === long && an[0].framed === 1 && !an[0].provisional,
		JSON.stringify(an.map((m) => ({ n: m.content.length, framed: m.framed, provisional: m.provisional }))));
	check('the placeholder dropped and the store was written', w.dropped.join() === 'u1' && w.persisted >= 1);
	const w2 = world({ turnId: 'u1', holder: 'b', mode: 'released', expiry: 0, settled: 1 });
	w2.window.DaimondPeer = Object.assign({}, win.DaimondPeer, { settledLease, otherRunRows });
	const cut = new TextEncoder().encode(JSON.stringify({ v: 1, turn: 'u1', msgs: [Object.assign({}, row, { whole: 0 })] }));
	w2.window.DaimondChunks = { materialiseBytes: async () => cut };
	Object.assign(w2, lifted(w2));
	w2.chat = { id: 'c1', messages: [user(), place(), prov('AN', long.slice(0, 16 * 1024))] };
	w2.fetchFinalRef('u1', ref, 1);
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
	check('[ctl] a ref\'d row not marked whole is not adopted', find(w2.chat.messages, 'AN')[0].provisional === 1 && !w2.dropped.length);
}

console.log('\nNATIVE: a chunked final frame read on the done report, after the watch ended (UNBLOCK-42)\n');
{
	const win = {};
	new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date',
		'with (window) {\n' + readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8') + '\n}')(win, undefined, console, setTimeout, clearTimeout, Date);
	// 22 rows of a native runner's turn, about 107 kB in all, each marked whole (settle.rs).
	const T = 'mvnu8dx4-9-1kqcx-rt';
	const rows = [];
	for (let i = 0; i < 22; i++) {
		rows.push({ mid: 'R' + String(i).padStart(2, '0'), role: i % 2 ? 'assistant' : 'tool', content: ('row ' + i + ' ').repeat(700),
			iturn: T, ts: 100 + i, run: 'K1', ranOn: 'kim', whole: 1 });
	}
	const body = new TextEncoder().encode(JSON.stringify({ v: 1, turn: T, msgs: rows }));
	check('[ctl] the turn is over the 64 KB door', body.length > 64 * 1024, body.length + 'B');
	const ref = { v: 2, size: body.length, key: 'k', chunks: [{ addr: 'a', size: 40000 }, { addr: 'b', size: 40000 }, { addr: 'c', size: body.length - 80000 }] };
	// The frame on the door (`view_frame`): the last rows that fit, the newest cut, and the manifest.
	const view = rows.slice(-6).map((r, i, a) => (i === a.length - 1 ? Object.assign({}, r, { content: r.content.slice(0, 900), whole: 0 }) : r));
	const frame = { seq: 7, final: true, abi: 0, tail: JSON.stringify({ v: 1, msgs: view, ref: ref, n: 22 }) };
	const w = world(null);
	w.window.DaimondPeer = Object.assign({}, win.DaimondPeer, { settledLease, otherRunRows });
	let reads = 0, chunkReads = 0;
	w.window.DaimondSync = { getProgressFrame: async (t, since) => { reads++; return t === T && since === 0 ? frame : null; } };
	w.window.DaimondChunks = { materialiseBytes: async (r) => { chunkReads++; return JSON.stringify(r) === JSON.stringify(ref) ? body : null; } };
	Object.assign(w, lifted(w));
	w.chat = { id: 'c1', messages: [{ mid: T, role: 'user', content: 'again', ts: 50 }, { mid: 'p1', role: 'assistant', content: '', why: 'dispatched', iturn: T, ts: 51 }] };
	// 09:11:56: an early settling report, and the watch closed on an empty door.
	const early = { t: 'report', turnId: T, status: 'aborted', why: 'stale' };
	w.peerReports[T] = early;
	check('[ctl] the early report reads nothing', w.readReportedFinal(T, early) === false && reads === 0);
	w.progressView[T] = { turn: T, seq: 0, msgs: null, final: true };	// the closed view
	// 09:12:44: the real `done`, which says the final frame is on the door.
	const done = { t: 'report', turnId: T, status: 'done', finalTail: 1 };
	w.peerReports[T] = done;
	check('the done report reads the final frame from the door', w.readReportedFinal(T, done) === true && reads === 1, 'reads=' + reads);
	for (let i = 0; i < 40 && !w.dropped.length; i++) await new Promise((r) => setTimeout(r, 0));
	// And the same report collected again: nothing is read or adopted twice.
	w.readReportedFinal(T, done);
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
	const got = w.chat.messages.filter((m) => m.iturn === T && m.role !== 'user' && m.why !== 'dispatched');
	check('the chunks were read', chunkReads === 1, 'chunkReads=' + chunkReads);
	check('all 22 rows landed, once each, in order', got.map((m) => m.mid).join() === rows.map((r) => r.mid).join(), got.map((m) => m.mid).join());
	check('every row whole, byte for byte, and real', got.length === 22 && got.every((m, i) => m.content === rows[i].content && m.framed === 1 && !m.provisional),
		JSON.stringify(got.map((m) => ({ mid: m.mid, n: m.content.length, framed: m.framed, provisional: m.provisional }))));
	check('adopted once: the placeholder dropped once, and the store written', w.dropped.join() === T && w.persisted >= 1, 'dropped=' + w.dropped.join());
	check('the door was read once', reads === 1, 'reads=' + reads);
	// A report left from an earlier errand of the same derived id settles nothing (exact eid).
	const w2 = world(null);
	w2.chat = { id: 'c1', messages: [{ mid: T, role: 'user', content: 'again', ts: 50 }, { mid: 'p1', role: 'assistant', content: '', why: 'dispatched', iturn: T, ts: 51, eid: 'E2' }] };
	check('a report on another errand of the turn id is not this hand-off\'s', w2.otherErrandReport({ t: 'report', turnId: T, eid: 'E1', status: 'aborted' }) === true);
	check('[ctl] the errand it was sent as is', w2.otherErrandReport({ t: 'report', turnId: T, eid: 'E2', status: 'done' }) === false);
	check('[ctl] and a report naming none decides nothing', w2.otherErrandReport({ t: 'report', turnId: T, status: 'done' }) === false);
}

console.log('\nCLOSED: a 36-row native turn read on its done report after a 34-row provisional view (UNBLOCK-44b)\n');
{
	const win = {};
	new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date',
		'with (window) {\n' + readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8') + '\n}')(win, undefined, console, setTimeout, clearTimeout, Date);
	const T = 'mvnu8dx4-9-1kqcx-rt-rt-rt', RUN = 'e-32f1';
	const now = Date.now();
	const row = (mid, role, content, i) => ({ mid, role, content, iturn: T, ts: now - 60000 + i * 1000, run: RUN, ranOn: 'kdu5d0t4', whole: 1 });
	const live = [];
	for (let i = 0; i < 34; i++) live.push(row(RUN + '-t' + i, i % 2 ? 'tool_log' : 'think_log', ('step ' + i + ' ').repeat(500), i));
	const answer = 'The answer: ' + 'six, because three and three. '.repeat(100);
	const whole = live.concat([row(RUN + '-final', 'assistant', answer, 34), Object.assign(row(RUN + '-end', 'end_log', '', 35), { lst: 1 })]);
	const body = new TextEncoder().encode(JSON.stringify({ v: 1, turn: T, msgs: whole }));
	check('[ctl] the turn is over the 64 KB door', body.length > 64 * 1024, body.length + 'B');
	const ref = { v: 2, size: body.length, key: 'k', chunks: [{ addr: 'a', size: 50000 }, { addr: 'b', size: 50000 }, { addr: 'c', size: body.length - 100000 }] };
	const strip = (r, n) => { const c = Object.assign({}, r, { content: r.content.slice(0, n) }); delete c.whole; return c; };
	const fin = { seq: 40, final: true, abi: 0, tail: JSON.stringify({ v: 1, ref, n: whole.length, msgs: whole.slice(-8).map((r) => strip(r, 600)) }) };
	const placeRow = { mid: 'p1', role: 'assistant', content: '', why: 'dispatched', iturn: T, ts: now - 61000 };
	const w = world(null);
	w.window.DaimondPeer = Object.assign({}, win.DaimondPeer, { settledLease, otherRunRows });
	let reads = 0, lastReads = 0;
	w.window.DaimondSync = {
		watchProgress: () => {},
		// The watch's one last read: the door was reclaimed by another key's frame, so it is empty.
		unwatchProgress: (k, onLast) => { if (onLast) lastReads++; },
		getProgressFrame: async (t, since) => { reads++; return t === T && since === 0 ? fin : null; },
	};
	w.window.DaimondChunks = { materialiseBytes: async (x) => (JSON.stringify(x) === JSON.stringify(ref) ? body : null) };
	w.watched = { [T]: true };
	w.watchIx = { [T]: 1 };
	Object.assign(w, lifted(w));
	w.chat = { id: 'c1', messages: [{ mid: T, role: 'user', content: 'what is three plus three', ts: now - 62000 }, Object.assign({}, placeRow)] };
	// 15:21:17-15:22:19: the runner's provisional frames, the last of them all 34 live rows.
	for (let f = 1; f <= 34; f++) w.onProgressFrame(T, { seq: f, final: false, abi: 0, tail: JSON.stringify({ v: 1, msgs: live.slice(0, f) }) });
	const held = () => w.chat.messages.filter((m) => m.iturn === T && m.role !== 'user' && m.why !== 'dispatched');
	check('[ctl] the 34 live rows are drawn provisional', held().length === 34 && held().every((m) => m.provisional), held().length + ' rows');
	// 15:22:24: the `done` report. It ends the watch first (`updateExpedite`), then reads the door.
	const done = { t: 'report', turnId: T, status: 'done', finalTail: 1 };
	w.peerReports[T] = done;
	delete w.watchIx[T];
	w.updateProgressWatch();
	check('[ctl] the watch\'s last read was made', lastReads === 1);
	check('the closed watch is not taken for a folded final frame', !(w.progressView[T] && w.progressView[T].msgs && w.progressView[T].msgs.length),
		JSON.stringify(w.progressView[T] && { final: w.progressView[T].final, n: (w.progressView[T].msgs || []).length }));
	check('the done report reads the final frame from the door', w.readReportedFinal(T, done) === true && reads === 1, 'reads=' + reads);
	for (let i = 0; i < 40 && !w.dropped.length; i++) await new Promise((r) => setTimeout(r, 0));
	const got = held();
	const ans = got.find((m) => m.mid === RUN + '-final');
	check('the answer row is there, whole and real', !!ans && ans.content === answer && ans.framed === 1 && !ans.provisional,
		ans ? JSON.stringify({ n: ans.content.length, framed: ans.framed, provisional: ans.provisional }) : 'no -final row');
	check('all 36 rows landed, once each, in order', got.map((m) => m.mid).join() === whole.map((r) => r.mid).join(), got.length + ' rows');
	check('every row real', got.every((m) => m.framed === 1 && !m.provisional));
	check('the placeholder dropped once', w.dropped.join() === T, 'dropped=' + w.dropped.join());
}

console.log('\nLIVE: a native turn\'s rows drawn as they come, on the asker and a second device (UNBLOCK-43)\n');
{
	const win = {};
	new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date',
		'with (window) {\n' + readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8') + '\n}')(win, undefined, console, setTimeout, clearTimeout, Date);
	const T = 'mvq1live-3-x', RUN = 'K7';
	const r = (i, role, content, x) => Object.assign({ mid: RUN + '-t' + i, role, content, ts: 200 + i, run: RUN, ranOn: 'kim', whole: 1 }, x || {});
	const th0 = r(0, 'think_log', 'reading the question'), tl1 = r(1, 'tool_log', 'ls: 4 files', { name: 'ls' });
	const tl2 = r(2, 'tool_log', 'cat: three and three', { name: 'cat' });
	const cutRow = r(1, 'cut_log', '', { mid: RUN + '-cut', say: { k: 'turn.rows_cut', v: { n: 1 } } });
	const ans = (c) => r(3, 'assistant', c);
	// The runner's provisional frames (final:false, same envelope as the final): ALL rows so far,
	// and the third over the cap, so it carries the newest rows that fit and not its front ones.
	const frame = (seq, msgs, extra) => ({ seq, final: false, abi: 0, tail: JSON.stringify(Object.assign({ v: 1, msgs }, extra || {})) });
	const f1 = frame(1, [th0, tl1]);
	const f2 = frame(2, [th0, tl1, ans('Si')]);
	const f3 = frame(3, [tl2, Object.assign(ans('Six, becau'), { whole: 0 })]);
	// The final frame, chunked (the turn is over the door): the view that fits, and the whole rows,
	// where the runner cut tl1 for its stand-in.
	const fin = [th0, cutRow, tl2, ans('Six, because three and three.')];
	const body = new TextEncoder().encode(JSON.stringify({ v: 1, turn: T, msgs: fin }));
	const ref = { v: 2, size: body.length, key: 'k', chunks: [{ addr: 'a', size: body.length }] };
	const ff = { seq: 4, final: true, abi: 0, tail: JSON.stringify({ v: 1, msgs: [Object.assign(ans('Six, because'), { whole: 0 })], ref, n: fin.length }) };
	const lease = { turnId: T, holder: 'kim', mode: 'held', expiry: Date.now() + 60000 };
	const placeRow = { mid: 'p1', role: 'assistant', content: '', why: 'dispatched', iturn: T, ts: 51 };
	const device = (name, asker) => {
		const w = world(lease);
		w.window.DaimondPeer = Object.assign({}, win.DaimondPeer, { settledLease, otherRunRows });
		w.window.DaimondChunks = { materialiseBytes: async (x) => (JSON.stringify(x) === JSON.stringify(ref) ? body : null) };
		w.watched = { [T]: true };
		Object.assign(w, lifted(w));
		w.chat = { id: 'c1', messages: [{ mid: T, role: 'user', content: 'what is three plus three', ts: 50 }, Object.assign({}, placeRow)] };
		w.name = name; w.asker = asker;
		return w;
	};
	const turnRows = (w) => w.chat.messages.filter((m) => m.role !== 'user' && m.why !== 'dispatched').map((m) => m.mid);
	const mids = (rows) => rows.map((x) => x.mid).join();
	// Both devices watch: the runner holds the lease, and neither tab is that runner.
	for (const self of ['gil', 'arg']) {
		check('the ' + self + ' tab watches the native runner\'s turn', win.DaimondPeer.watchDecision(Object.assign({}, placeRow, { ts: Date.now() }), lease, false, self, Date.now()) === true);
	}
	const gil = device('the asker', true), arg = device('the second device', false);
	// A watcher that missed frame 2: frame 3 carries only rows it has not drawn (the door keeps
	// only the newest frame), so none has a neighbour held and all are newer than the turn's.
	const skip = device('a device that missed frame 2', false);
	skip.onProgressFrame(T, f1);
	skip.onProgressFrame(T, f3);
	check(skip.name + ': frame 3, every row new, goes below the rows held', mids([th0, tl1, tl2, ans('')]) === turnRows(skip).join(), turnRows(skip).join());
	for (const w of [gil, arg]) {
		w.onProgressFrame(T, f1);
		check(w.name + ': frame 1 draws its rows', mids([th0, tl1]) === turnRows(w).join(), turnRows(w).join());
		w.onProgressFrame(T, f2);
		check(w.name + ': frame 2 adds the answer as it grows', mids([th0, tl1, ans('')]) === turnRows(w).join() && w.chat.messages.find((m) => m.mid === RUN + '-t3').content === 'Si', turnRows(w).join());
		w.onProgressFrame(T, f3);
		check(w.name + ': frame 3, missing its front rows, keeps them and adds its new row after them', mids([th0, tl1, tl2, ans('')]) === turnRows(w).join(), turnRows(w).join());
		check(w.name + ': the answer grew in place', w.chat.messages.find((m) => m.mid === RUN + '-t3').content === 'Six, becau');
		w.onProgressFrame(T, f2);
		check(w.name + ': a late frame changes nothing', mids([th0, tl1, tl2, ans('')]) === turnRows(w).join() && w.chat.messages.find((m) => m.mid === RUN + '-t3').content === 'Six, becau', turnRows(w).join());
		check(w.name + ': every row so far provisional', w.chat.messages.filter((m) => m.iturn === T && m.provisional).length === 4);
	}
	// The turn ends: the asker has its `done` report, the second device sees the lease settle.
	gil.peerReports[T] = { t: 'report', turnId: T, status: 'done', finalTail: 1 };
	Object.assign(lease, { mode: 'released', settled: 1 });
	for (const w of [gil, arg, skip]) {
		w.onProgressFrame(T, ff);
		for (let i = 0; i < 40 && !w.dropped.length; i++) await new Promise((res) => setTimeout(res, 0));
		const got = w.chat.messages.filter((m) => m.iturn === T && m.role !== 'user' && m.why !== 'dispatched');
		check(w.name + ': the final adoption leaves exactly the final rows, in order', mids(fin) === got.map((m) => m.mid).join(), got.map((m) => m.mid).join());
		check(w.name + ': each real, whole, once', got.length === fin.length && got.every((m, i) => m.content === fin[i].content && m.framed === 1 && !m.provisional),
			JSON.stringify(got.map((m) => ({ mid: m.mid, framed: m.framed, provisional: m.provisional }))));
		check(w.name + ': the cut row is gone and its cut_log line stands', !got.some((m) => m.mid === tl1.mid) && got.some((m) => m.role === 'cut_log'));
		check(w.name + ': the placeholder dropped', w.dropped.join() === T);
	}
}

console.log('\nFILES: the page-made Files row of a runner\'s turn stands past the final frame (UNBLOCK-46)\n');
{
	// His turn: the tile "appeared only briefly". The Files row (`<run>-files`) is made here, from
	// the done report, while the final frame of the same report is adopted.
	const rec = { run: 'R1', turnId: 'u1', keeper: 'chat:c1', on: 'b', ts: 20,
		files: [{ path: 'a.txt', add: 2, del: 1, his: true, change: { text: true, rows: [] } }] };
	const said = { version: 3, note: { role: 'user', content: '[Daimond: this turn changed a.txt]' } };
	const runRows = () => [user(), place(), Object.assign(prov('t1', 'thinking'), { run: 'R1' }),
		Object.assign(prov('a1', 'six'), { run: 'R1' }), Object.assign(prov('R1-end', ''), { role: 'end_log', run: 'R1', ts: 30 })];
	for (const keeper of ['chat:c1', 'diamond:d1']) {
		const k = keeper.split(':')[0];
		// RACE: the adoption lands inside the row's own awaits.
		{
			const w = world(null);
			w.chat = { id: 'c1', messages: runRows() };
			w.finalMids.u1 = { t1: 1, a1: 1, 'R1-end': 1 };
			w.finalRun.u1 = 'R1';
			w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
			let adopted = false;
			w.during = () => { adopted = w.adoptFinalFrame('u1'); };
			const row = await w.carriedFilesRow(w.chat, Object.assign({}, rec, { keeper }), said);
			check(k + ' RACE: the frame was adopted inside the row\'s awaits', adopted === true);
			check(k + ' RACE: the row was made', !!row && row.mid === 'R1-files' && Array.isArray(row.yours));
			check(k + ' RACE: and the chat holds it after the adoption', find(w.chat.messages, 'R1-files').length === 1,
				w.chat.messages.map((m) => m.mid).join());
			check(k + ' RACE: before the turn\'s end row', (() => { const ms = w.chat.messages.map((m) => m.mid);
				return ms.indexOf('R1-files') >= 0 && ms.indexOf('R1-files') === ms.indexOf('R1-end') - 1; })(), w.chat.messages.map((m) => m.mid).join());
		}
		// AFTER: the row made first, then the final frame adopted (the replace never takes it).
		{
			const w = world(null);
			w.chat = { id: 'c1', messages: runRows() };
			await w.carriedFilesRow(w.chat, Object.assign({}, rec, { keeper }), said);
			w.finalMids.u1 = { t1: 1, a1: 1, 'R1-end': 1 };
			w.finalRun.u1 = 'R1';
			w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
			check(k + ' AFTER: adopted', w.adoptFinalFrame('u1') === true);
			check(k + ' AFTER: the Files row stands, untombstoned', find(w.chat.messages, 'R1-files').length === 1 && w.tombs.indexOf('R1-files') < 0,
				w.chat.messages.map((m) => m.mid).join());
			// B: the asker's parcel brings the row; the runner's final copy merges over it.
			const b = w.mergeMessages(w.chat.messages, [user(), real('a1', 'six')], 'c1', {});
			check(k + ' AFTER: and the runner\'s parcel leaves it', find(b, 'R1-files').length === 1);
		}
	}
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);
