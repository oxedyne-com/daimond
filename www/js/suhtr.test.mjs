/* ============================================================
   suhtr.test.mjs -- Retry runs once in a Diamond; "not run" holds across builds and tab death
   (SUHT-R, QA B on live 4c94152fd: F1-F4; F5 is sendunh F1-ctl, flipped there).

   Adopts the QA's probes P1-P5 (lanes/oxedyne/qa-suht-b/probe) as failing-first arms.

     R1  F1  (P1, P1d)  the "not run" row is written in the shape an OLD build already routes
                   as one lost turn: a chat's `why: 'runner'`, a Diamond's `why: 'notrun'` (the
                   live 4c94152fd routes a Diamond's lost row only so; review MED-2), both with
                   `notRun`; a new build draws it "not run" with Retry on the lost route,
                   whatever its tag. R1d runs each build's own markInterrupted + continueTurn
                   (178d721c0, 4c94152fd, head; the old ones read out of git) on each tag.
     R2  F2  (P4)  two devices press Retry on one row with the switch on Here: a Diamond's
                   retry runs ONCE, under the derived `-rt` id and its lease, as a chat's does;
                   a Diamond's lost run's Retry takes the same routed door.
     R3  F3  (P3)  the other device reads Stop on the retry of a "not run" row run elsewhere.
     R4  F4  (P2, P5)  the end writes its row before it settles the lease; an `ending` lease
                   this device holds rebuilds a missing row on recovery; a turn that already
                   has its own ending loses its placeholder.
     R5  LOW-3     two devices (or two tabs rebuilding under F4) writing one turn's row before
                   either syncs merge into one row: its mid is the turn's (`tid + '-nr'`).
     R6  LOW-4     a Diamond Retry is admitted before it retracts: a busy Diamond, or one not
                   on this device, keeps the row and its Retry; no lease, no run.

   Run: node www/js/suhtr.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage, isSplit } from './test/page.mjs';

// R1d's child: one build's real `markInterrupted` + `continueTurn` (TREE names the build) draw
// the row in SUHTR_ROW in a chat (or a Diamond, SUHTR_DIAMOND) and press its button. Answers
// one JSON line: what it drew and whether the press took a routed door.
if (process.env.SUHTR_P1D) {
	const calls = [];
	const mk = (tag) => ({ tag, className: '', textContent: '', title: '', children: [], classList: { add() {} },
		appendChild(c) { this.children.push(c); return c; }, _click: null,
		addEventListener(e, f) { if (e === 'click') this._click = f; } });
	const w = makeWindow({ now: Date.now() });
	w.document = { createElement: mk };
	w.DaimondPeer = { dispatchState: () => 'reclaimable', isAskAnswer: () => false, uiState: () => 'x' };
	const row = JSON.parse(process.env.SUHTR_ROW);
	const chat = { id: 'c1', diamondId: process.env.SUHTR_DIAMOND ? 'f1' : undefined,
		messages: [{ role: 'user', content: 'go', mid: row.iturn, iturn: row.iturn }, row] };
	const P = (x) => JSON.stringify(x);
	// A build from before the page split (www/js/page/) is lifted by its own harness, the
	// dev/syncprobe.mjs the parent copies beside its daimond.js.
	const old = isSplit() ? null : await import(join(process.env.TREE, 'dev', 'syncprobe.mjs'));
	const stub = {
		current: chat, t: (k) => k, runnerLostLabel: () => 'LOST', renderDispatchedFooter() {},
		turnHold: () => null, holdSend: () => () => {}, confirmHold: async () => {}, toast() {},
		selfDeviceId: () => 'OLDDEV', leaseClockNow: () => Date.now(), loadMsgTombs: () => ({}),
		msgTombstone: (x) => calls.push('tombstone ' + P(x)), sessionCut() {}, touchChat() {}, persistChats() {},
		ChatStore: { compact() {} }, renderHistory() {}, renderQueue() {}, putInComposer() {}, syncFoldBusy() {}, handoffTargetLabel: () => '', deviceLabelFor: () => '',
		retryTurn: (c, i, x, o) => calls.push('retryTurn ' + i + ' ' + P(o)), answerAgain: () => calls.push('answerAgain'),
		clearBadge() {}, continueRouted: () => calls.push('continueRouted'), continueAsked: () => calls.push('continueAsked'), seatDrawnRunner: () => '',
		newMid: () => 'fresh-mid', maybeAutoDispatch: async () => { calls.push('maybeAutoDispatch'); return false; },
		runTurn: (c, x, o) => calls.push('runTurn HERE ' + P(x) + ' ' + P(o)),
		runSteer: (f, x, d, det, how) => calls.push('runSteer HERE ' + P(how)),
		diamonds: [{ id: 'f1', name: 'Lifelog' }], currentDiamond: null,
	};
	const want = ['markInterrupted', 'continueTurn'];
	const fns = old ? old.sliceDaimond(w, want, stub).fns : loadPage({ window: w, want, stub });
	const div = mk('div');
	fns.markInterrupted(div, row);
	const foot = div.children[0] || { children: [] };
	const label = foot.children.find((c) => c.tag === 'span') || {};
	const btn = foot.children.find((c) => c.tag === 'button');
	if (btn) btn._click();
	await new Promise((r) => setTimeout(r, 20));
	const routed = calls.includes('maybeAutoDispatch') || calls.some((c) => c.startsWith('retryTurn'));
	console.log('P1D ' + P({ label: label.textContent, button: btn ? btn.textContent : null, calls, routed }));
	process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
const J = JSON.stringify;
const settle = () => new Promise((r) => setTimeout(r, 20));

// One device's peer.js, loaded as the page loads it.
function loadPeer() {
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + readPage(join(HERE, rel), 'utf8') + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
	return win;
}
// The synced lease door the devices share.
function makeDoor() {
	let version = 1, leases = {};
	return {
		read: async () => ({ version, leases: JSON.parse(J(leases)) }),
		write: async (base, next) => {
			if (base !== version) return { ok: false };
			version++; leases = JSON.parse(J(next));
			return { ok: true, version };
		},
		peek: () => JSON.parse(J(leases)),
	};
}
// A small element, enough for `markInterrupted` to draw a footer and a button.
const el = (tag) => ({ tag, className: '', textContent: '', title: '', children: [], classList: { add() {} },
	appendChild(c) { this.children.push(c); return c; }, _click: null,
	addEventListener(e, f) { if (e === 'click') this._click = f; } });

console.log('suhtr: Retry runs once in a Diamond; "not run" holds across builds and tab death\n');

// ── R1 (F1): the row's shape, and how a new build draws it ──
const wrote = {};
{
	console.log('R1: the "not run" row, written and drawn');
	const w = makeWindow({ now: Date.now() });
	let n = 0;
	const fns = loadPage({ window: w, want: ['answerUnhanded'], stub: {
		touchMsg: (m) => { m._touched = 1; return m; }, newMid: () => 'row' + (++n), touchChat() {}, persistChats() {},
		ownsChat: () => false, renderHistory() {}, renderQueue() {}, putInComposer() {}, syncFoldBusy() {}, diag() {}, DaimondModels: { pauseError: () => ({ message: 'p' }) },
	} });
	const chat = { id: 'c1', messages: [{ role: 'user', content: 'go', mid: 'X', iturn: 'X' }] };
	fns.answerUnhanded(chat, 'X', 'go', { ok: false, why: 'refused after the mark: 500' });
	const row = chat.messages[1] || {};
	check('R1a the row is the lost-turn shape an old build routes (why runner + notRun)', row.why === 'runner'
		&& row.interrupted === true && !!row.notRun && row.iturn === 'X' && row.itext === 'go', J(row));
	const dchat = { id: 'c2', diamondId: 'f1', messages: [{ role: 'user', content: 'go', mid: 'X', iturn: 'X' }] };
	fns.answerUnhanded(dchat, 'X', 'go', { ok: false, why: 'refused after the mark: 500' });
	const drow = dchat.messages[1] || {};
	check('R1a2 a Diamond\'s row keeps why notrun (+ notRun), the tag the live build routes for a Diamond',
		drow.why === 'notrun' && drow.interrupted === true && !!drow.notRun && drow.iturn === 'X' && drow.itext === 'go', J(drow));
	wrote.chat = row; wrote.diamond = drow;
	fns.answerUnhanded(chat, 'X', 'go', { ok: false, why: 'again' });
	check('R1b a second refusal refreshes that row, no second', chat.messages.length === 2
		&& chat.messages[1].notRun && chat.messages[1].notRun.why === 'again', J(chat.messages));
	// A new build draws it "not run", and its Retry takes the lost route.
	const shapes = [['written', row], ['written Diamond', drow], ['legacy notrun', { role: 'assistant', content: '', interrupted: true, why: 'notrun',
		iturn: 'X', itext: 'go', notRun: { why: 'w' } }]];
	for (const [what, r] of shapes) {
		const calls = [];
		const d = loadPage({ window: makeWindow({ now: Date.now() }), want: ['markInterrupted'], stub: {
			current: { id: 'c1', messages: [chat.messages[0], r] }, t: (k) => k, runnerLostLabel: () => 'LOST',
			renderDispatchedFooter() {}, retryTurn: (c, i, x, o) => { calls.push(['retry', i, x, o]); },
			continueTurn: () => calls.push(['continue']), document: { createElement: el },
		} });
		const div = el('div');
		d.markInterrupted(div, r);
		const foot = div.children[0] || { children: [] };
		const label = foot.children.find((c) => c.tag === 'span') || {};
		const btn = foot.children.find((c) => c.tag === 'button');
		if (btn) btn._click();
		check('R1c ' + what + ': drawn "not run", Retry on the lost route', label.textContent === 'turn.not_run'
			&& calls.length === 1 && calls[0][0] === 'retry' && calls[0][3] && calls[0][3].lost === true,
			J([label.textContent, calls]));
	}
}

// ── R1d (MED-2, P1d): each build's own Retry on each tag, in a Diamond and in a chat ──
{
	console.log('R1d: old builds press Retry on the row (178d721c0, 4c94152fd, head)');
	const root = join(HERE, '..', '..');
	const builds = [['178d721c0', '178d721c0'], ['4c94152fd (live)', '4c94152fd'], ['head', null]];
	const run = (tree, row, diamond) => {
		const out = execFileSync(process.execPath, process.execArgv.concat([fileURLToPath(import.meta.url)]), { encoding: 'utf8',
			env: Object.assign({}, process.env, { TREE: tree, SUHTR_P1D: '1', SUHTR_ROW: J(row), SUHTR_DIAMOND: diamond ? '1' : '' }) });
		const line = out.split('\n').find((l) => l.startsWith('P1D ')) || 'P1D {}';
		return JSON.parse(line.slice(4));
	};
	const tag = (why) => ({ role: 'assistant', content: '', interrupted: true, why, iturn: 'u-1', itext: 'go',
		mid: 'm-row', ts: 1, notRun: { why: 'refused after the mark: 500', unable: false, ts: 1 } });
	// The tag each build routes a Diamond's row on: head both; the live build only `notrun`;
	// 178d721c0 neither (no new code can reach a page that old).
	const want = { '178d721c0': { notrun: false, runner: false }, '4c94152fd': { notrun: true, runner: false }, head: { notrun: true, runner: true } };
	for (const [name, sha] of builds) {
		let tree = root, tmp = null;
		if (sha) {
			tmp = mkdtempSync(join(tmpdir(), 'suhtr-' + sha + '-'));
			mkdirSync(join(tmp, 'www', 'js'), { recursive: true });
			writeFileSync(join(tmp, 'www', 'js', 'daimond.js'), execFileSync('git', ['-C', root, 'show', sha + ':www/js/daimond.js'], { maxBuffer: 1 << 28 }));
			mkdirSync(join(tmp, 'dev'));
			writeFileSync(join(tmp, 'dev', 'syncprobe.mjs'), execFileSync('git', ['-C', root, 'show', sha + ':dev/syncprobe.mjs']));
			tree = tmp;
		}
		try {
			const w = want[sha || 'head'];
			for (const why of ['notrun', 'runner']) {
				const r = run(tree, tag(why), true);
				check('R1d ' + name + ', Diamond, why ' + why + ': ' + (w[why] ? 'routed' : 'unrouted (pinned)'), r.routed === w[why], J(r));
			}
			// The rows head writes, on this build: a chat's routes on every build, a Diamond's on
			// every build but 178d721c0.
			const rc = run(tree, wrote.chat, false);
			check('R1d ' + name + ': the chat row head writes is routed', rc.routed === true, J(rc));
			const rd = run(tree, wrote.diamond, true);
			check('R1d ' + name + ': the Diamond row head writes is ' + (sha === '178d721c0' ? 'unrouted (pinned)' : 'routed'),
				rd.routed === (sha !== '178d721c0'), J(rd));
		} finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
	}
}

// ── R2 (F2): two devices' Retry on one row, the switch on Here ──
for (const diamond of [false, true]) {
	const kind = diamond ? 'Diamond' : 'chat';
	console.log('R2: two devices press Retry, ' + kind);
	const door = makeDoor(), runs = [];
	const device = (self) => {
		const P = loadPeer();
		const w = makeWindow({ now: Date.now() });
		w.DaimondLease = P.DaimondLease;
		w.DaimondPeer = Object.assign({}, P.DaimondPeer, { syncCas: () => door });
		w.DaimondSync = { flush: async () => {} };
		const chat = { id: 'c', diamondId: diamond ? 'd1' : '', messages: [{ role: 'user', content: 'go', mid: 'X', iturn: 'X' },
			{ role: 'assistant', content: '', interrupted: true, why: 'runner', iturn: 'X', itext: 'go', mid: 'R', notRun: { why: 'w' } }] };
		let n = 0;
		const fns = loadPage({ window: w, want: ['retryTurn'], stub: {
			selfDeviceId: () => self, leaseClockNow: () => Date.now(), peerSyncShim: () => ({}), diag() {}, toast() {},
			peerUiStateFor: () => 'x', answerAgain() {}, loadMsgTombs: () => ({}), msgTombstone() {}, sessionCut() {},
			touchChat() {}, persistChats() {}, ChatStore: { compact() {} }, renderHistory() {}, renderQueue() {}, putInComposer() {}, syncFoldBusy() {}, newMid: () => self + '-m' + (++n),
			maybeAutoDispatch: async () => false,
			claimTurnHere: async () => ({ release() {} }),
			watchRetryLease: () => () => {}, ownsChat: () => false, chatInput: null, syncSendMode() {},
			seatDrawnRunner: () => '', turnHold: () => '', askOpenIn: () => false,
			runTurn: async (c, x, o) => { runs.push(self + ' runTurn ' + (o && o.mid)); },
			runSteer: async (f, x, dp, det, how) => { runs.push(self + ' runSteer ' + ((how && how.mid) || 'fresh')); },
			diamonds: [{ id: 'd1' }], currentDiamond: null,
		} });
		return { fns, chat };
	};
	const A = device('A'), B = device('B');
	await Promise.all([A.fns.retryTurn(A.chat, 'X', 'go', { lost: true }), B.fns.retryTurn(B.chat, 'X', 'go', { lost: true })]);
	await settle();
	check('R2a ' + kind + ': run once, under X-rt', runs.length === 1 && / X-rt$/.test(runs[0]), J(runs));
}
{
	console.log('R2: a daimon turn takes its id from how.mid');
	const src = readPage(join(HERE, 'daimond.js'), 'utf8');
	check('R2b runSteer names the person\'s message from how.mid when given',
		/var dumid = detached \? String\(detached\.turnId\) : \(\(how && how\.mid\) \? String\(how\.mid\) : newMid\(\)\);/.test(src));
}
{
	console.log('R2: a Diamond\'s lost run\'s Retry takes the routed, fenced door');
	const calls = [];
	const chat = { id: 'c', diamondId: 'd1', messages: [{ role: 'user', content: 'go', mid: 'X', iturn: 'X' },
		{ role: 'assistant', content: 'half', interrupted: true, why: 'runner', iturn: 'X', itext: 'go', mid: 'R' }] };
	const fns = loadPage({ window: makeWindow({ now: Date.now() }), want: ['continueTurn'], stub: {
		turnHold: () => null, holdSend: () => () => {}, confirmHold: async () => {}, toast() {}, t: (k) => k,
		retryTurn: (c, i, x, o) => { calls.push(['retry', i, o]); }, askAgain: () => calls.push(['askAgain']),
		answerAgain: () => calls.push(['answerAgain']), msgTombstone() {}, sessionCut() {}, touchChat() {}, persistChats() {},
		ChatStore: { compact() {} }, renderHistory() {}, renderQueue() {}, putInComposer() {}, syncFoldBusy() {}, newMid: () => 'fresh', clearBadge() {}, DaimondPeer: { isAskAnswer: () => false },
		loadMsgTombs: () => ({}), tombstone() {}, mark() {}, offline() {}, hold() {}, handoffTargetLabel: () => '',
		selfDeviceId: () => 'A', leaseClockNow: () => Date.now(), deviceLabelFor: () => '', dropDispatchedPlaceholder() {},
		continueRouted: () => calls.push(['continueRouted']), continueAsked: () => calls.push(['continueAsked']), seatDrawnRunner: () => '', ensureApp() {}, runTurn: () => calls.push(['runTurn']),
	} });
	fns.continueTurn(chat, 'X', 'go', false, true);
	await settle();
	check('R2c retryTurn lost, never askAgain', calls.length === 1 && calls[0][0] === 'retry' && calls[0][2] && calls[0][2].lost === true, J(calls));
}

// ── R3 (F3): the other device's Stop on the retry of a "not run" row ──
for (const [what, row] of [['written row', { why: 'runner', notRun: { why: 'w' } }], ['legacy notrun', { why: 'notrun' }]]) {
	console.log('R3: Stop on the other device, ' + what);
	const held = { 'X-rt': true };
	const fns = loadPage({ window: makeWindow({ now: Date.now() }), want: ['peerHeldTurnOf'], stub: {
		peerLeaseHeld: (t) => !!held[t], _peerStopping: {}, peerUiStateFor: () => 'done', PEER_HELD: {},
	} });
	const prev = [{ role: 'user', content: 'earlier', mid: 'P', iturn: 'P' }, { role: 'assistant', content: 'ok', iturn: 'P' }];
	const chat = { id: 'c3', messages: prev.concat([{ role: 'user', content: 'go', mid: 'X', iturn: 'X' },
		Object.assign({ role: 'assistant', content: '', interrupted: true, iturn: 'X', itext: 'go' }, row)]) };
	fns.peerHeldTurnOf(chat);
	chat.messages = prev.slice();
	const after = fns.peerHeldTurnOf(chat);
	check('R3 ' + what + ': rows gone, A running X-rt reads Stop here', !!after && after.iturn === 'X-rt', J(after));
}

// ── R4 (F4): the end, row first, and idempotent from the lease ──
function endWorld(self, door, chat) {
	const P = loadPeer();
	const w = makeWindow({ now: Date.now() });
	const W = { P, dropped: [], order: [], ran: [] };
	w.DaimondLease = P.DaimondLease;
	const settleLease = P.DaimondPeer.settleLease;
	w.DaimondPeer = Object.assign({}, P.DaimondPeer, { syncCas: () => door,
		settleLease: async function (k, tid, who, mode) {
			W.order.push('settle:' + mode + ':row=' + (chat.messages.some((x) => x.notRun && x.iturn === tid) ? 1 : 0));
			return settleLease.apply(null, arguments);
		} });
	w.DaimondPost = { collect: async () => {} };
	w.DaimondSync = { leaseGet: async () => ({ leases: (await door.read()).leases }), pull: async () => {} };
	const fns = loadPage({ window: w, want: ['endHandOffNotRun', 'runDispatchFallback', 'leaseDoorRead', 'peerCollectOnReturn'], stub: {
		selfDeviceId: () => self, leaseClockNow: () => Date.now(), peerSyncShim: () => ({}),
		claimTurnHere: async () => ({ release() {} }), diag() {}, redrawRunner() {}, scheduleDispatchFallback() {},
		UNDECIDED_RECOLLECT_MS: 1, clearDispatchFallback() {}, drainAfterHeld() {},
		dropDispatchedPlaceholder: (tid) => { W.dropped.push(tid); W.order.push('drop');
			chat.messages = chat.messages.filter((x) => !(x.why === 'dispatched' && x.iturn === tid)); },
		touchMsg: (m) => m, newMid: () => 'n1', touchChat() {}, persistChats: () => { W.order.push('persist'); },
		ownsChat: () => false, renderHistory() {}, renderQueue() {}, putInComposer() {}, syncFoldBusy() {}, DaimondModels: { pauseError: () => ({ message: 'p' }) },
		chats: [chat], dispatchedChat: () => chat, _dispatchedIx: { [chat.messages[0].iturn]: chat.id },
		dispatchedTurnFinished: () => false, dispatchedAnswerPresent: () => false,
		recoverOneLocally: async (c, m) => { W.ran.push('recover:' + m.iturn); }, releaseOwnStaleLeases: async () => 0,
	} });
	W.fns = fns;
	return W;
}
const sentChat = (tid, self, extra) => ({ id: 'c4', messages: [{ role: 'user', content: 'go', mid: tid, iturn: tid }].concat(extra || [],
	[{ role: 'assistant', why: 'dispatched', interrupted: true, content: '', iturn: tid, itext: 'go', ts: Date.now() - 4000,
		toDevice: 'DESK', toName: 'argonaut', dispatchedBy: self, mid: 'PH' }]) });
{
	console.log('R4a: the row is written and persisted before the lease settles');
	const door = makeDoor(), chat = sentChat('t4a', 'PHONE');
	const W = endWorld('PHONE', door, chat);
	await W.fns.endHandOffNotRun(chat, chat.messages[1], 'runner DESK never claimed it');
	const firstSettle = W.order.find((x) => x.startsWith('settle:')) || '';
	check('R4a the row stands at the first settle, the placeholder gone', firstSettle === 'settle:done:row=1'
		&& W.order.indexOf('persist') < W.order.indexOf(firstSettle) && W.dropped.join() === 't4a', J(W.order));
	const L = W.P.DaimondLease.record('t4a');
	check('R4a the lease still ends settled and ending (I9)', !!L && !!L.settled && !!L.ending, J(L));
}
{
	console.log('R4b (P5): a turn that already has its own ending loses its placeholder');
	const door = makeDoor();
	const partial = { role: 'assistant', content: 'half an answer', interrupted: true, iturn: 't4b', itext: 'go', mid: 'PA' };
	const chat = sentChat('t4b', 'PHONE', [partial]);
	const W = endWorld('PHONE', door, chat);
	await W.fns.endHandOffNotRun(chat, chat.messages[2], 'runner DESK never claimed it (found on return)');
	check('R4b the placeholder goes, no "not run" row beside the partial', W.dropped.join() === 't4b'
		&& !chat.messages.some((x) => x.notRun), J({ dropped: W.dropped, rows: chat.messages.map((x) => x.why || x.role) }));
}
for (const via of ['backstop', 'return']) {
	console.log('R4c (P2): settled ending lease, no row, placeholder left; recovery by ' + via);
	const door = makeDoor(), chat = sentChat('t4c', 'PHONE');
	const W = endWorld('PHONE', door, chat);
	const P = W.P, clock = () => Date.now();
	await P.DaimondLease.take('t4c', { holder: 'PHONE', ts: Date.now(), intent: 'end' }, door, clock);
	await P.DaimondPeer.settleLease('turn', 't4c', 'PHONE', 'done', door, clock);
	// -- the tab died here: the placeholder persisted, no row --
	if (via === 'backstop') await W.fns.runDispatchFallback('c4', 't4c');
	else await W.fns.peerCollectOnReturn();
	await settle();
	check('R4c ' + via + ': the row is rebuilt from the lease, the placeholder goes, nothing run',
		chat.messages.some((x) => x.notRun && x.iturn === 't4c') && W.dropped.join() === 't4c' && W.ran.length === 0,
		J({ rows: chat.messages.map((x) => x.why || x.role), dropped: W.dropped, ran: W.ran }));
}
{
	console.log('R4d: a settled lease another device ended, or a run\'s, rebuilds nothing here');
	for (const [who, intent] of [['DESK', 'end'], ['PHONE', undefined]]) {
		const door = makeDoor(), chat = sentChat('t4d', 'PHONE');
		const W = endWorld('PHONE', door, chat);
		const P = W.P, clock = () => Date.now();
		await P.DaimondLease.take('t4d', { holder: who, ts: Date.now(), intent }, door, clock);
		await P.DaimondPeer.settleLease('turn', 't4d', who, 'done', door, clock);
		await W.fns.runDispatchFallback('c4', 't4d');
		check('R4d holder ' + who + ' intent ' + (intent || 'run') + ': no row written', !chat.messages.some((x) => x.notRun),
			J(chat.messages.map((x) => x.why || x.role)));
	}
}

// ── R5 (LOW-3): two devices, or two tabs rebuilding under F4, each write the row before either
// syncs; the copies merge (the real mergeMessages) into ONE "not run" row ──
for (const diamond of [false, true]) {
	console.log('R5: two writers of one turn\'s "not run" row, ' + (diamond ? 'Diamond' : 'chat'));
	const writer = (dev) => {
		let n = 0;
		return loadPage({ window: makeWindow({ now: Date.now() }), want: ['answerUnhanded'], stub: {
			touchMsg: (m) => m, newMid: () => dev + (++n), touchChat() {}, persistChats() {},
			ownsChat: () => false, renderHistory() {}, renderQueue() {}, putInComposer() {}, syncFoldBusy() {}, diag() {}, DaimondModels: { pauseError: () => ({ message: 'p' }) },
		} });
	};
	const copy = () => ({ id: 'c', diamondId: diamond ? 'f1' : undefined, messages: [{ role: 'user', content: 'go', mid: 'X-rt', iturn: 'X-rt', ts: 1 }] });
	const a = copy(), b = copy();
	writer('A').answerUnhanded(a, 'X-rt', 'go', { ok: false, why: 'refused on A' });
	writer('B').answerUnhanded(b, 'X-rt', 'go', { ok: false, why: 'declined on B' });
	const M = loadPage({ window: makeWindow({ now: Date.now() }), want: ['mergeMessages'], stub: { loadMsgTombs: () => ({}) } });
	const merged = M.mergeMessages(a.messages, b.messages, 'c', {});
	const rows = merged.filter((m) => m.notRun);
	check('R5 ' + (diamond ? 'Diamond' : 'chat') + ': the two copies merge into one not-run row', rows.length === 1
		&& rows[0].mid === a.messages[1].mid && a.messages[1].mid === b.messages[1].mid, J(merged.map((m) => [m.mid, m.why])));
	// The synced copy is the one the next refusal on either device refreshes, not a second.
	const c = { id: 'c', diamondId: a.diamondId, messages: merged };
	writer('C').answerUnhanded(c, 'X-rt', 'go', { ok: false, why: 'again' });
	check('R5 ' + (diamond ? 'Diamond' : 'chat') + ': a refusal after the sync refreshes that row', c.messages.filter((m) => m.notRun).length === 1
		&& c.messages.find((m) => m.notRun).notRun.why === 'again', J(c.messages.map((m) => [m.mid, m.notRun && m.notRun.why])));
}

// ── R6 (LOW-4): a Diamond Retry the steer cannot start (the Diamond not on this device) is not
// retracted: the row and its Retry stay, no lease is taken, nothing runs. A BUSY Diamond admits it
// (STEER D3): retracted, it waits for the Diamond's own turn to end -- a lost run's under its X-rt
// lease -- and then runs once; it was dropped by runSteer's busy guard. ──
for (const [what, busy, list, lost] of [['busy', true, [{ id: 'd1' }], true], ['not found', false, [], true],
	['busy, an edit\'s resend', true, [{ id: 'd1' }], false], ['idle (control)', false, [{ id: 'd1' }], true]]) {
	console.log('R6: Retry in a Diamond ' + what);
	const door = makeDoor(), runs = [], tombs = [];
	const P = loadPeer();
	const w = makeWindow({ now: Date.now() });
	w.DaimondLease = P.DaimondLease;
	w.DaimondPeer = Object.assign({}, P.DaimondPeer, { syncCas: () => door });
	w.DaimondSync = { flush: async () => {} };
	const chat = { id: 'c', diamondId: 'd1', messages: [{ role: 'user', content: 'go', mid: 'X', iturn: 'X' },
		{ role: 'assistant', content: '', interrupted: true, why: 'notrun', iturn: 'X', itext: 'go', mid: 'X-nr', notRun: { why: 'w' } }] };
	const fns = loadPage({ window: w, want: ['retryTurn', 'setCrystalBusy'], stub: {
		selfDeviceId: () => 'A', leaseClockNow: () => Date.now(), peerSyncShim: () => ({}), diag() {}, toast() {}, t: (k) => k,
		peerUiStateFor: () => 'x', answerAgain() {}, loadMsgTombs: () => ({}), msgTombstone: (x) => tombs.push(...x), sessionCut() {},
		touchChat() {}, persistChats() {}, ChatStore: { compact() {} }, renderHistory() {}, renderQueue() {}, putInComposer() {}, syncFoldBusy() {}, newMid: () => 'fresh',
		maybeAutoDispatch: async () => false, claimTurnHere: async () => ({ release() {} }),
		watchRetryLease: () => () => {}, ownsChat: () => false, chatInput: null, syncSendMode() {},
		seatDrawnRunner: () => '', turnHold: () => '', askOpenIn: () => false,
		runTurn: async () => { runs.push('runTurn'); },
		runSteer: async (f, x, dp, det, how) => { runs.push('runSteer ' + ((how && how.mid) || 'fresh')); return busy ? '' : 'ok'; },
		diamonds: list, currentDiamond: null, crystalRunning: busy ? { d1: true } : {},
	} });
	// Not awaited whole: a busy Diamond's retry is under way until the turn it waits on ends.
	const rp = fns.retryTurn(chat, 'X', 'go', { lost });
	await settle();
	const r = busy ? null : await rp;
	const leases = Object.keys(door.peek());
	if (what.startsWith('idle')) {
		check('R6 ' + what + ': retracted and run once under X-rt', tombs.includes('X-nr') && runs.length === 1 && runs[0] === 'runSteer X-rt', J([tombs, runs]));
	} else if (busy) {
		const want = lost ? 'runSteer X-rt' : 'runSteer fresh';
		// STEER-2 F1: the wait comes before every side effect, so nothing is retracted or leased in it.
		check('R6 ' + what + ': nothing retracted, run or leased while busy', !tombs.length
			&& !runs.length && !leases.length && chat.messages.length === 2, J([tombs, runs, leases]));
		fns.setCrystalBusy('d1', false);
		await settle();
		check('R6 ' + what + ': retracted and run once the Diamond\'s turn ends', tombs.includes('X-nr') && runs.length === 1 && runs[0] === want, J([tombs, runs]));
	} else {
		check('R6 ' + what + ': not retracted, nothing run, no lease', !r && !tombs.length && chat.messages.length === 2
			&& !runs.length && !leases.length, J([r, tombs, runs, leases, chat.messages.length]));
	}
}

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
