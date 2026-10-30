/* ============================================================
   Test: a native runner's turn is adopted on the page as a whole turn (RUNNER-TURN RT-C,
   design notes/daimond_runner_20261016/runnerturn_design.md §1.4, §3.2 a, c, d).

   The runner's log rows carry every row of the turn, the answer with its product record
   and its figures (`ran*`, with `ranCached` and `ranCtx`). The page adopts them through the
   existing path; RT-C adds what only the page can do:

     A     the adopted answer keeps its `prod`, so a rating tray mounts (`rateQualifies`);
     C     the chat totals grow by the answer's figures ONCE per run, on any device and in either
           sync order (`foldedRuns`), and only for a native runner: a page runner's figures come
           home on its own synced record;
     D     `recordCarriedTurn` builds the turn's Files row `<run>-files` from the version the
           wasm recorded, before `<run>-end`, and none when it recorded nothing (the second
           device, by run); the runner's session gets the tail note the Here session gets;
   P2.3a: the rows arrive by the chat log, so the turn's end (`onLogEnd`) is where A and C
   happen; the frame's adoption and its provisional copies are gone.
     KEY   a row that carries `say: {k, v}` (a native runner's error, vision or failed answer,
           content empty) is said through `t(k, v)`, else its content.
     CUT   the runner's stand-in for rows a frame had to drop (`<run>-cut`, role `cut_log`,
           say `turn.rows_cut` {n}) is drawn as "N steps not shown", in the locale's plural,
           once at its ts, before and after adoption, and a re-read frame does not repeat it;
           the transcript export says the same sentence (D-20261026-05).

   Run:  node www/js/runnerturn_page.test.mjs
   On 9f601b5b4: the RT-C functions are missing (FAILs).
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const J = (x) => JSON.stringify(x);

/// Lifts `function name(...) { ... }` out of `src` by counting braces; '' when absent.
function extractFn(src, name) {
	let start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) return '';
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}
function extractVar(src, name) {
	const m = src.match(new RegExp('^\\tvar ' + name + ' = [^\\n]*;$', 'm'));
	return m ? m[0].slice(1) : '';
}

if (process.env.DAIMOND_JS && !process.env.TREE) process.env.TREE = join(dirname(process.env.DAIMOND_JS), '..', '..');
const { liftSource, makeWindow } = await import('../../dev/syncprobe.mjs');
const { loadPage } = await import('./test/page.mjs');
const src  = readPage(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');
const psrc = readPage(process.env.PEER_JS || join(HERE, 'peer.js'), 'utf8');

// The real peer.js and provenance.js, each in a bare window.
const pwin = {};
new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date',
	'with (window) {\n' + psrc
	+ '\n}')(pwin, undefined, console, setTimeout, clearTimeout, Date);
// The real module, and its row functions the page adopts through (not exported: reached in place).
const P = Object.assign({}, pwin.DaimondPeer);
const vwin = {};
new Function('window', readPage(join(HERE, 'provenance.js'), 'utf8'))(vwin);
const Prov = vwin.DaimondProvenance;

const RTC = ['FOLDED_RUNS_MAX', 'NATIVE_FIGS', 'HERE_FIELDS', 'TOTAL_FIELDS'];
const RTC_FNS = ['runKeyCmp', 'hasNativeRuns', 'hereOf', 'nativeBaseWinner', 'nativeJoin', 'deriveNativeTotals',
	'noteHerePrompt', 'runFolded', 'markRunFolded', 'runnerRoadNative', 'foldRunnerTotals',
	'carriedFilesRow', 'logRowText'];
const missing = RTC_FNS.filter((n) => !extractFn(src, n)).concat(RTC.filter((n) => !extractVar(src, n)));
check('the tree has the RT-C functions', !missing.length, 'missing ' + missing.join(', '));

// ── The adopting world: framedanswer.test.mjs's, with the fold beside it ──
const lifted = new Function('env', [
	'var REASON_DISPATCHED_STR = "dispatched";',
	'function loadMsgTombs() { return {}; }',
	'var window = env.window, DaimondPeer = env.window.DaimondPeer, DaimondLease = env.window.DaimondLease;',
	'var DaimondProvenance = env.window.DaimondProvenance;',
	'var peerReports = env.peerReports, _finalMids = env.finalMids, _finalRun = env.finalRun, _abiRefused = {};',
	'var current = null; function renderHistory() {}',
	'var DaimondChunks = null, _refFetch = {}, _progressView = {}, _renderedSigs = null;',
	'function ownsChat() { return true; } function growProvisionalTiles() {} function sigsOf() { return null; }',
	'function msgTombstone() {}',
	'function dispatchedChat(t) { return env.chatFor(t); }',
	'function chatHoldingTurn(t) { return env.chatFor(t); }',
	'function touchChat() { env.touched++; }',
	'function persistChats() { env.persisted++; }',
	'function diag() {}',
	'function renderDispatchedBadges() {}',
	'function dropDispatchedPlaceholder(t) { var c = env.chatFor(t); c.messages = c.messages.filter(function (m) { return !(m.why === "dispatched" && m.iturn === t); }); }',
	'var DaimondStamp = (function () { var window = {}; ' + readPage(join(HERE, 'stamp.js'), 'utf8') + '\n return window.DaimondStamp; })();',
	liftSource(['mergeMessages'], ['loadMsgTombs', 'window', 'DaimondStamp']).src,
	extractFn(src, 'dispatchedAnswerPresent'),
	extractFn(src, 'dispatchedPlaceholderIn'),
	extractFn(src, 'handoffLeaseSettled'),
	extractFn(src, 'handoffDone'),
	extractVar(src, 'ARRIVE_FRESH_MS'),
	extractFn(src, 'noteArrive'),
	extractFn(src, 'dropOtherRunRows'),
	extractFn(src, 'isNotRunRow'),
	extractFn(src, 'isLostRow'),
	...RTC.map((n) => extractVar(src, n)),
	...RTC_FNS.filter((n) => n !== 'carriedFilesRow' && n !== 'logRowText').map((n) => extractFn(src, n)),
	extractFn(src, 'onLogEnd'),
	extractFn(src, 'rateProdOf'),
	extractFn(src, 'rateQualifies'),
	'return { onLogEnd: onLogEnd, rateQualifies: rateQualifies };',
].join('\n'));

function world(presence) {
	const env = {
		window: {
			DaimondPeer:  Object.assign({}, P),
			DaimondLease: { record: () => null },
			DaimondProvenance: Prov,
			DaimondPresence: { snapshot: () => presence || {} },
		},
		peerReports: {}, finalMids: {}, finalRun: {}, persisted: 0, touched: 0, chat: null,
		chatFor: () => env.chat,
	};
	Object.assign(env, lifted(env));
	// The turn's end row folded (turnlog.js `onEnd`): the view's rows are the turn's own.
	env.end = (t) => { env.onLogEnd(env.chat, t, { rows: env.chat.messages.filter((m) => m.iturn === t && m.role !== 'user') }); return true; };
	return env;
}

const PROD = { h: 'p1:answer:c1:R1-final', k: 'answer', m: 'm1', pv: 'p1', cm: 'm1', fam: '', fi: true, cls: 'unknown',
	role: 'chat', sp: '', d: '', c: 'c1', t: 'u1', dev: 'RUN', at: 50 };
const user  = () => ({ mid: 'u1', role: 'user', content: 'three plus three', ts: 10, iturn: 'u1' });
const place = (native) => Object.assign({ mid: 'p1', role: 'assistant', content: '', why: 'dispatched', iturn: 'u1', ts: 11, interrupted: true },
	native ? { toNative: 1 } : {});
const D = { ranTokIn: 100, ranTokOut: 20, ranCached: 50, ranCost: 0.25, ranCtx: 900 };
const answer = (run, on, extra) => Object.assign({ mid: run + '-final', role: 'assistant', content: 'six', ts: 40, iturn: 'u1',
	run, ranOn: on, ranMs: 700, ranModel: 'm1' }, D, { prod: [PROD] }, extra || {});
const BASE = { promptTokens: 1000, completionTokens: 200, cachedTokens: 300, costUsd: 0.5, lastPrompt: 400 };
const tot = (c) => [c.promptTokens, c.completionTokens, c.cachedTokens, +(+c.costUsd).toFixed(6), c.lastPrompt];
const WANT = [1100, 220, 350, 0.75, 900];

/// Device `w` holding the turn with the runner's rows drawn from the log, its done report in.
function stage(w, run, on, native, totals) {
	w.chat = Object.assign({ id: 'c1', updatedAt: 5, metaAt: 5,
		messages: [user(), place(native),
			{ mid: run + '-t0', role: 'think_log', content: 'adding', ts: 20, iturn: 'u1', run },
			answer(run, on)] }, totals || BASE);
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	return w;
}

console.log('\nA: the runner answer keeps its record at the turn\'s end, so a tray mounts\n');
{
	const w = stage(world({ RUN: { kind: 'runner' } }), 'R1', 'RUN', true);
	w.end('u1');
	const a = w.chat.messages.find((m) => m.mid === 'R1-final');
	check('its prod is the runner\'s, byte for byte', a && J(a.prod) === J([PROD]), J(a && a.prod));
	check('rateQualifies passes on it', w.rateQualifies(a));
}

console.log('\nC: the totals grow once per run, native only\n');
{
	const w = stage(world({ RUN: { kind: 'runner' } }), 'R1', 'RUN', true);
	w.end('u1');
	check('native, by the dispatch mark: base + the row\'s figures, lastPrompt = ranCtx', J(tot(w.chat)) === J(WANT), J(tot(w.chat)));
	check('the run is recorded folded', Array.isArray(w.chat.foldedRuns) && w.chat.foldedRuns.some((f) => f.r === 'R1'), J(w.chat.foldedRuns));
	// The save is readChatLog's, after the fold (logboot.test).
	// The end read again (a re-read past the cursor, or a second device's copy).
	const held = w.chat;
	stage(w, 'R1', 'RUN', true, { promptTokens: held.promptTokens, completionTokens: held.completionTokens,
		cachedTokens: held.cachedTokens, costUsd: held.costUsd, lastPrompt: held.lastPrompt, foldedRuns: held.foldedRuns });
	w.end('u1');
	check('a second end of the same run leaves them at base + d', J(tot(w.chat)) === J(WANT), J(tot(w.chat)));
}
{
	// The road read from the runner's presence row where the mark has none (an older mark).
	const w = stage(world({ RUN: { kind: 'runner' } }), 'R1', 'RUN', false);
	w.end('u1');
	check('native, by the presence row of ranOn: folded', J(tot(w.chat)) === J(WANT), J(tot(w.chat)));
}
{
	const w = stage(world({ PG: { kind: 'page' } }), 'R2', 'PG', false);
	w.end('u1');
	check('a page runner (no mark, its presence a page): not folded', J(tot(w.chat)) === J(tot(BASE)), J(tot(w.chat)));
}
{
	// A page runner whose record (base + d, R2 marked folded) synced before the frame.
	const w = stage(world({ PG: { kind: 'page' } }), 'R2', 'PG', true,
		{ promptTokens: 1100, completionTokens: 220, cachedTokens: 350, costUsd: 0.75, lastPrompt: 900, foldedRuns: [{ r: 'R2', at: 30 }] });
	w.end('u1');
	check('a page runner\'s record first, then its frame: still base + d', J(tot(w.chat)) === J(WANT), J(tot(w.chat)));
}
{
	const w = stage(world({ RUN: { kind: 'runner' } }), 'R1', 'RUN', true, Object.assign({}, BASE, { ranTokIn: 0 }));
	const a = w.chat.messages.find((m) => m.mid === 'R1-final');
	['ranTokIn', 'ranTokOut', 'ranCost', 'ranCached', 'ranCtx'].forEach((k) => delete a[k]);
	w.end('u1');
	check('[ctl] an answer with no figures (an old runner) folds nothing', J(tot(w.chat)) === J(tot(BASE)) && !w.chat.foldedRuns, J(tot(w.chat)));
}

// The sync race, through the real `mergeChatRecords`.
{
	const mw = makeWindow({ now: 1_000_000_000 });
	let M = null, why = '';
	try { M = loadPage({ window: mw, want: ['mergeChatRecords', 'slimChat', 'nativeJoin', 'markRunFolded', 'noteHerePrompt'] }); } catch (e) { why = String((e && e.message) || e); }
	if (!M) check('mergeChatRecords and nativeJoin lift', false, why);
	else {
		// Device A adopted and folded; its record synced to B before B adopted.
		const a = stage(world({ RUN: { kind: 'runner' } }), 'R1', 'RUN', true);
		a.end('u1');
		a.chat.updatedAt = 9;
		const b = stage(world({ RUN: { kind: 'runner' } }), 'R1', 'RUN', true);
		const merged = M.mergeChatRecords(a.chat, b.chat, { mtombs: {} });
		check('the merge carries A\'s foldedRuns', Array.isArray(merged.foldedRuns) && merged.foldedRuns.some((f) => f.r === 'R1'), J(merged.foldedRuns));
		b.chat = Object.assign(merged, { messages: b.chat.messages });
		b.end('u1');
		check('B adopts after A\'s folded record synced: counted once', J(tot(b.chat)) === J(WANT), J(tot(b.chat)));
		// The other order: B folded first, then A's record lands.
		const b2 = stage(world({ RUN: { kind: 'runner' } }), 'R1', 'RUN', true);
		b2.end('u1');
		b2.chat.updatedAt = 8;
		const m2 = M.mergeChatRecords(a.chat, b2.chat, { mtombs: {} });
		check('B folded first, then A\'s record: still once', J(tot(m2)) === J(WANT), J(tot(m2)));
		check('the union is absent when both are empty (the push-skip fixed point)',
			!('foldedRuns' in M.mergeChatRecords({ id: 'x', updatedAt: 1, messages: [] }, { id: 'x', updatedAt: 1, messages: [] }, { mtombs: {} })));
		const big = [];
		for (let i = 0; i < 70; i++) big.push({ r: 'run' + i, at: 100 + i });
		const join = (x, y) => M.nativeJoin({ foldedRuns: x }, { foldedRuns: y }).runs;
		const j = join(big.slice(0, 40), big.slice(30).concat([{ r: 'run5', at: 1 }]));
		check('the join is bounded at FOLDED_RUNS_MAX, keeping the newest', j.length === 64 && j[0].r === 'run6' && j[63].r === 'run69', J(j.slice(0, 2)));
		check('a run held twice keeps the earlier stamp', join([{ r: 'q', at: 5 }], [{ r: 'q', at: 3 }])[0].at === 3);

		// THE TOTALS ARE DERIVED, NOT LAST-WRITE. Device A folded R1; device B never saw R1 and ran
		// a Here turn of its own (+H) later, so B's record is the newer: R1 must still count once.
		const H = { p: 10, c: 2, ca: 1, usd: 0.125 };
		const bHere = { id: 'c1', updatedAt: 20, metaAt: 5, messages: [],
			promptTokens: 1000 + H.p, completionTokens: 200 + H.c, cachedTokens: 300 + H.ca, costUsd: 0.5 + H.usd, lastPrompt: 450 };
		const WANT_H = [1110, 222, 351, 0.875];
		const t4 = (c) => tot(c).slice(0, 4);
		const m3 = M.mergeChatRecords(a.chat, bHere, { mtombs: {} });
		const m4 = M.mergeChatRecords(bHere, a.chat, { mtombs: {} });
		check('the newer record without R1 (B) merged with A\'s: R1 counted once, B\'s turn kept', J(t4(m3)) === J(WANT_H), J(tot(m3)));
		check('the same, the other merge order', J(t4(m4)) === J(WANT_H), J(tot(m4)));
		check('the merged record names R1 with its figures', (m3.foldedRuns || []).some((f) => f.r === 'R1' && f.p === 100 && f.usd === 0.25), J(m3.foldedRuns));
		check('its here part is B\'s own bill', m3.hereP === 1010 && m3.hereC === 202, J([m3.hereP, m3.hereC]));
		const m5 = M.mergeChatRecords(m3, a.chat, { mtombs: {} });
		check('merged again with A: still once (idempotent)', J(t4(m5)) === J(WANT_H), J(tot(m5)));
		check('[ctl] a record no native run touched carries none of the new fields',
			!['foldedRuns', 'nativeBase', 'hereP', 'hereC', 'hereCa', 'hereUsd', 'hereAt'].some((k) => k in M.mergeChatRecords(Object.assign({}, bHere), Object.assign({}, bHere, { updatedAt: 19 }), { mtombs: {} })));

		// The context meter: a run newer than the last Here turn sets it; a Here turn after it stands.
		check('a run newer than B\'s last Here turn sets lastPrompt to its ctx', m3.lastPrompt === 900, m3.lastPrompt);
		const late = Object.assign({}, m3, { updatedAt: 30, lastPrompt: 123, hereAt: 10 ** 13 });
		check('a Here turn after the run keeps its own lastPrompt through a merge', M.mergeChatRecords(late, a.chat, { mtombs: {} }).lastPrompt === 123);

		// TRIM AT THE BOUND. 65 native runs of one prompt token each: the oldest goes into the
		// base, and a device still holding it as a run counts it once on a merge, either order.
		const runs = [];
		for (let i = 0; i < 65; i++) runs.push({ r: 'n' + String(i).padStart(2, '0'), at: 1000 + i, p: 1 });
		const full = { id: 'c2', updatedAt: 50, metaAt: 5, messages: [], promptTokens: 7, completionTokens: 0, cachedTokens: 0, costUsd: 0, lastPrompt: 0 };
		runs.forEach((f) => M.markRunFolded(full, f.r, f.at, f));
		check('the bound holds 64 runs, the oldest in the base', full.foldedRuns.length === 64 && full.nativeBase && full.nativeBase.n === 1
			&& full.nativeBase.p === 1 && full.foldedRuns[0].r === 'n01', J(full.nativeBase));
		check('the totals count all 65 runs over the here part', full.promptTokens === 72 && full.hereP === 7, J([full.promptTokens, full.hereP]));
		const older = { id: 'c2', updatedAt: 40, metaAt: 5, messages: [], promptTokens: 7, completionTokens: 0, cachedTokens: 0, costUsd: 0, lastPrompt: 0 };
		runs.slice(0, 64).forEach((f) => M.markRunFolded(older, f.r, f.at, f));
		check('[ctl] a device short of the newest run holds the oldest as a run', older.foldedRuns.length === 64 && !older.nativeBase && older.promptTokens === 71);
		const t1 = M.mergeChatRecords(full, older, { mtombs: {} }), t2 = M.mergeChatRecords(older, full, { mtombs: {} });
		check('trimmed on one side, held on the other: each run once, either order', t1.promptTokens === 72 && t2.promptTokens === 72
			&& t1.foldedRuns.length === 64 && t1.nativeBase.n === 1, J([t1.promptTokens, t2.promptTokens, t1.nativeBase]));
		check('the trimmed run reads as folded, so a late re-adopt of it adds nothing', (() => {
			const c = structuredClone(full); M.markRunFolded(c, 'n00', 1000, { p: 1 }); return c.promptTokens === 72; })());

		// A page runner's own run is held with no figures: its bill is in its here part.
		const pr = { id: 'c3', updatedAt: 5, metaAt: 5, messages: [], promptTokens: 1100, completionTokens: 220, cachedTokens: 350, costUsd: 0.75, lastPrompt: 900 };
		M.markRunFolded(pr, 'R2', 30);
		check('a page runner marking its own run leaves its totals as billed', J(tot(pr)) === J(WANT) && pr.hereP === 1100, J(tot(pr)));
	}
}

console.log('\nD: recordCarriedTurn builds the Files row before the end row\n');
{
	const liftD = new Function('env', [
		'var window = env.window, DaimondVersions = env.window.DaimondVersions, DaimondProvenance = env.window.DaimondProvenance;',
		'var DaimondPeer = env.window.DaimondPeer, DaimondSync = null, current = null;',
		'function stampProd(p) { return p; }',
		'function selfDeviceId() { return "ASK"; }',
		'function chatHoldingTurn(t) { return env.chat; }',
		'function newMid() { return "fresh"; }',
		'function touchChat() { env.touched++; } function persistChats() { env.persisted++; }',
		'function touchMsg(m) { return m; }',
		'function histOpenFor() { return false; } function showCrystalHistory() {} function renderHistory() {} function ownsChat() { return false; }',
		'function diag() {}',
		extractFn(src, 'prodBaseOf'),
		extractFn(src, 'carriedProdBase'),
		extractFn(src, 'turnFileProds'),
		extractFn(src, 'turnFileList'),
		extractFn(src, 'carriedFilesRow'),
		extractFn(src, 'recordCarriedTurn'),
		'return { recordCarriedTurn: recordCarriedTurn };',
	].join('\n'));
	const NOTE = { role: 'user', content: '[Daimond: this turn changed 1 file (v3): /w/out.txt. The user can restore any of them from History, and file_revert does the same when they ask.]' };
	function dworld(keeper, said) {
		const env = {
			window: {
				DaimondPeer: P,
				DaimondProvenance: { h: { file: (s, v, p) => 'v1:file:' + s + ':' + v + ':' + p } },
				DaimondVersions: {
					recordCarried: async () => said,
					// The runner's own author, as its turnRec names it: the model for a role, via a command.
					manifests: async () => [{ version: 3, ts: 33, files: [{ path: '/w/out.txt', hash: 'h1', by: { role: 'm-1', via: 'command' } }] }],
					diff: async () => null,		// no bodies on the asker
				},
			},
			touched: 0, persisted: 0,
			chat: { id: 'c1', diamondId: keeper.indexOf('chat:') === 0 ? '' : keeper, messages: [user(),
				{ mid: 'R1-t0', role: 'tool_log', content: 'ok', ts: 20, iturn: 'u1', run: 'R1' },
				answer('R1', 'RUN', { prod: [Object.assign({}, PROD, { sp: 'sp1:ab', d: keeper.indexOf('chat:') === 0 ? '' : keeper })] }),
				{ mid: 'R1-end', role: 'end_log', content: '', ts: 45, iturn: 'u1', run: 'R1', how: 'halted' }],
				session: { msgs: [{ role: 'assistant', content: 'six' }], upto: 'R1-final' } },
		};
		return Object.assign(env, liftD(env));
	}
	const rec = (keeper) => ({ keeper, run: 'R1', turnId: 'u1', on: 'RUN', ts: 42,
		files: [{ path: '/w/out.txt', hash: 'h1', created: true, add: 3, del: 0 }] });
	const settle = async (w, r, report) => { const p = w.recordCarriedTurn(r, report); if (p && p.then) await p; for (let i = 0; i < 10; i++) await new Promise((s) => setTimeout(s, 0)); };
	{
		const w = dworld('chat:c1', { version: 3, files: ['/w/out.txt'], note: NOTE });
		await settle(w, rec('chat:c1'), { turnId: 'u1', session: { upto: 'R1-final' } });
		const ms = w.chat.messages, at = ms.findIndex((m) => m.mid === 'R1-files');
		const row = ms[at];
		check('a chat keeper: a files_log row <run>-files', row && row.role === 'files_log', J(ms.map((m) => m.mid)));
		check('it sits before <run>-end', at >= 0 && ms[at + 1] && ms[at + 1].mid === 'R1-end', J(ms.map((m) => m.mid)));
		check('its prod is k=file, credited to the runner device', row && row.prod && row.prod[0].k === 'file' && row.prod[0].dev === 'RUN', J(row && row.prod));
		// RT-D1 finding B: the Here turn's Files row names the chat's author (role, prompt print, model,
		// provider, chat), so the carried one takes the turn's prodBase, as its answer row does.
		const fp = (row && row.prod && row.prod[0]) || {};
		check('its author is the carried turn\'s prodBase, as the answer row\'s is', fp.role === 'chat' && fp.sp === 'sp1:ab'
			&& fp.m === 'm1' && fp.pv === 'p1' && fp.c === 'c1' && fp.d === '' && fp.t === 'u1', J(fp));
		check('its per-file facts stay the file\'s', fp.h === 'v1:file:chat:c1:3:/w/out.txt' && fp.hash === 'h1' && fp.at === 33
			&& fp.via === 'command' && fp.run === '', J(fp));
		check('its delta is the turnRec\'s line counts', row && J(row.delta) === J([{ h: 'v1:file:chat:c1:3:/w/out.txt', add: 3, del: 0 }]), J(row && row.delta));
		check('iturn is the turn, ts before the end row', row && row.iturn === 'u1' && row.ts < 45, J(row));
		check('the runner session carries the tail note, as a Here session does',
			J(w.chat.session.msgs[w.chat.session.msgs.length - 1]) === J(NOTE), J(w.chat.session.msgs));
		await settle(w, rec('chat:c1'), { turnId: 'u1', session: { upto: 'R1-final' } });
		check('a second settle adds no second row or note', w.chat.messages.filter((m) => m.mid === 'R1-files').length === 1
			&& w.chat.session.msgs.filter((m) => m.content === NOTE.content).length === 1);
	}
	{
		const w = dworld('D1', { version: 3, files: ['/w/out.txt'], note: NOTE });
		await settle(w, rec('D1'), null);
		const ms = w.chat.messages, at = ms.findIndex((m) => m.mid === 'R1-files');
		const row = ms[at];
		check('a Diamond keeper: a user row with the tail note text, prod and files', row && row.role === 'user'
			&& row.content === NOTE.content && row.prod && row.prod[0].k === 'file' && Array.isArray(row.files), J(row));
		const dp = (row && row.prod && row.prod[0]) || {};
		check('a Diamond keeper\'s Files row takes the prodBase too', dp.role === 'chat' && dp.sp === 'sp1:ab' && dp.d === 'D1' && dp.c === 'c1', J(dp));
		check('its files carry the line counts', row && row.files && row.files[0].path === '/w/out.txt' && row.files[0].add === 3, J(row && row.files));
		check('before <run>-end', at >= 0 && ms[at + 1].mid === 'R1-end');
	}
	{
		const w = dworld('chat:c1', {});
		await settle(w, rec('chat:c1'), null);
		check('the wasm recorded nothing (a second device, by run): no row', !w.chat.messages.some((m) => m.mid === 'R1-files'));
	}
}

console.log('\nKEY: an error or vision row with a key is said in the page\'s language\n');
{
	const f = extractFn(src, 'logRowText');
	if (!f) check('logRowText exists', false);
	else {
		const tOr = (k, fb, v) => (k === 'err.rate' ? 'Limite: ' + v.s : fb);
		const logRowText = new Function('tOr', f + '\nreturn logRowText;')(tOr);
		check('a say: t(key, params)', logRowText({ role: 'error_log', say: { k: 'err.rate', v: { s: 3 } }, content: '' }) === 'Limite: 3');
		check('a failed answer\'s say too', logRowText({ role: 'assistant', say: { k: 'err.rate', v: { s: 5 } }, content: '' }) === 'Limite: 5');
		check('an unknown key: the content', logRowText({ role: 'error_log', say: { k: 'err.none' }, content: 'Rate limited' }) === 'Rate limited');
		check('no key: the content', logRowText({ role: 'vision_log', content: 'blind' }) === 'blind');
	}
}

console.log('\nCUT: a frame\'s "N steps not shown" row is drawn, once, where it stands\n');
{
	// The real i18n module with the real English table, so the plural pair is the one shipped.
	const iw = {};
	const ictx = vm.createContext({ window: iw, console, navigator: { language: 'en' },
		localStorage: { getItem: () => null, setItem() {} },
		document: { querySelectorAll: () => [], documentElement: { setAttribute() {}, lang: '' } } });
	vm.runInContext(readPage(join(HERE, 'i18n.js'), 'utf8'), ictx);
	ictx.DaimondI18n = iw.DaimondI18n;
	vm.runInContext(readPage(join(HERE, '..', 'i18n', 'en.js'), 'utf8'), ictx);
	const I = iw.DaimondI18n;
	const logRowText = new Function('t', 'tn', [extractFn(src, 'tOr'), extractFn(src, 'logRowText'),
		'return logRowText;'].join('\n'))(I.t, I.tn);
	const cutRow = (n) => ({ mid: 'R1-cut', role: 'cut_log', content: '', ts: 15, run: 'R1',
		say: { k: 'turn.rows_cut', v: { n } } });
	check('three rows: "3 steps not shown"', logRowText(cutRow(3)) === '3 steps not shown', logRowText(cutRow(3)));
	check('one row: "1 step not shown"', logRowText(cutRow(1)) === '1 step not shown', logRowText(cutRow(1)));

	// drawHistoryMessage, every helper it calls a recorder: what was drawn, and with what words.
	let drawn = [];
	const scope = new Proxy({ logRowText, window: {} }, {
		has: (o, k) => typeof k === 'string' && !(k in globalThis && !(k in o)),
		get: (o, k) => (k in o ? o[k] : (...a) => { drawn.push([k, a]); return null; }),
	});
	const draw = new Function('S', 'with (S) {\n' + extractFn(src, 'drawHistoryMessage') + '\nreturn drawHistoryMessage; }')(scope);
	const says = (msgs) => {
		drawn = [];
		msgs.forEach((m, i, a) => draw(m, i, a));
		return drawn.filter((d) => d[1].some((x) => x === '3 steps not shown'));
	};

	const frame = [Object.assign(cutRow(3), { whole: 1 }),
		{ mid: 'R1-t5', role: 'tool_log', name: 'read', content: 'ok', ts: 30, run: 'R1', whole: 1 },
		{ mid: 'R1-final', role: 'assistant', content: 'six', ts: 40, run: 'R1', whole: 1 }];
	// The turn's rows as the log draws them, then its end.
	const w = world({ RUN: { kind: 'runner' } });
	w.chat = { id: 'c1', updatedAt: 5, metaAt: 5, messages: [user(), place(true)].concat(
		frame.map((r) => Object.assign({ iturn: 'u1' }, r, r.mid === 'R1-final' ? answer('R1', 'RUN') : {}))) };
	w.peerReports.u1 = { t: 'report', turnId: 'u1', status: 'done' };
	w.end('u1');
	const kept = w.chat.messages.filter((m) => m.mid !== 'p1');
	check('ended: the cut row stays at its ts', J(kept.map((m) => m.mid)) === J(['u1', 'R1-cut', 'R1-t5', 'R1-final']),
		J(w.chat.messages.map((m) => m.mid)));
	check('ended: drawn once as "3 steps not shown"', says(w.chat.messages).length === 1, J(drawn.map((d) => d[0])));

	// Agent-accessible: the plain-text transcript says the same sentence.
	const transcriptOf = new Function('logRowText', [
		'function chatDisplayName() { return "c"; } function outcomeOfStoredText() { return "done"; }',
		extractFn(src, 'transcriptOf'), 'return transcriptOf;'].join('\n'))(logRowText);
	const text = transcriptOf(w.chat);
	check('the transcript export says "3 steps not shown"', text.split('3 steps not shown').length === 2, J(text));
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);
