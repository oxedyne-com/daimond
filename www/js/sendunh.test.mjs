/* ============================================================
   Test — a hand-off the door refuses before its mark never loses
   the turn (SEND-UNHANDED, diag-elect LIVE and b).
   ------------------------------------------------------------
   The send (`maybeAutoDispatch`) writes the prompt, clears the
   composer and returns true, so no local run follows. When the
   door (`dispatchToPeer`, through the entry `handOffTurn`) then refuses BEFORE it marks the turn,
   the turn used to end in an error line with no Retry, and the
   backstop found no placeholder and let go: it ran nowhere.

   For every pre-mark refusal -- a runner that has not shown it
   runs the set (`unable`), no transport, a thread that cannot be
   built (peer.js "transcript is not loaded"), a throw -- and on
   every caller (the send, the parked re-run), the turn must:
     U1  not run here in silence (no runTurn/continueTurn);
     U2  leave no Retry-less error line;
     U3  leave one durable "not run" row on the turn (synced: touched);
     U4  draw that row with a Retry wired to `retryTurn`, whose lost
         route asks the same prompt again as ONE derived turn id;
     U5  a second refusal of the same turn refreshes the row, not adds one.
   And a person's pause at the door is said as before (P1).

   H: a runner hands the turn back (undeliverable) but its lease has
   already settled (`done`, r4a6 fault B): the backstop
   (`runDispatchFallback`, real peer.js `recoverDecision`) used to drop
   it in silence. It must end in the same "not run" row (U1-U4), and
   the placeholder goes. H0: a settled lease with no hand-back (a turn
   that ran there) and H2: a hand-back whose answer did land, add no row.

   F1 (QA-HT-B F1, rc's probe qahtb_f1 adopted): under a deriving gateway
   the send-time presence read did not land in 2 s while the switch showed
   the runner pressed. The turn ran Here in silence: no tile line, no
   election logged, the map not marked unknown. It must end in the "not
   run" row (U1-U4), post nothing, log the election and mark the map
   unknown. F1-ctl (rc ruling 23 Oct, QA B F5, reversing design M1): a
   read that lands and finds the pressed runner gone ends "not run" the
   same way (U1-U4); F1-ctl-here: nothing pressed, it runs Here. F1-here:
   nothing pressed, so a missed read runs Here as before, with the map
   unknown and the log.

   F3 (QA-HT-B F3): a turn withdrawn on loss (HT2 M9, W1) and a turn
   handed back `models-behind` (M1) used to run here with a note. Each
   must end in the "not run" row with Retry, its lease taken and settled
   first (so the errand can never run late on the runner), and the
   placeholder goes. W2: a runner's claim that won the take keeps the
   turn: no row, nothing run here. M0: a `thread` hand-back still runs
   here, as before.

   D (lead, §14 dispatchfail): a refusal AFTER the mark -- a prompt over
   the relay door (D-big), a refused post (D-refpost) -- ran here through
   `refuseAndRunHere`. It must end in the "not run" row (U1-U4), its lease
   settled, the placeholder gone. M1 holds the §14 modelunrun case: a
   models-behind hand-back whose lease was reclaimed (released, unsettled).

   Lifts the REAL functions out of daimond.js. Red on f43b648cc (U, H)
   and on 07fecc18c (F1, F3).
   Breaks: --break entry | draw | lost | settled | readmiss | declined | unknown |
           withdraw | behind | refused | cutref   (each must go red).

   K (lead, kfix f94184180 E-PORT): a runner's refusal before the run hands
   the lease back `released`, unsettled, `cut: 'refused'`; `settledLease`
   reads it false. K1 must end "not run" like H; K0, a plain release with
   no cause, still runs here.

   Part 3 (lead ruling, rulings §1 l.17 as extended: one ending for every
   turn the switch sent that its runner did not take): B1 the backstop for
   a runner that never claimed (D-20261009-23), M0 the thread hand-back,
   MD the models hand-back, BZ the busy hand-back, RT recovery-on-return,
   and K0 a plain release each end "not run" (M0, K0 asserted the old run
   here). SA / RT-SA: a step-away hand-off (`stepAway`, not sent by the
   switch) still runs here. Red on 447e30d9a.
   Breaks: backstop | busy | thread | models | onreturn | stepaway.

   RF (RUN-HIST E, qa_ep7_b M1, rulings §1 l.17): a Kimberlite refusal
   before the run (no model key, the clamp, credits, spawn). RF: this
   build's runner reports it `undeliverable`, cause `refused`, with why.
   It must end in the "not run" row with Retry (U1-U4) naming the
   runner's why, the footer never
   'failed' (no [Run here] past the switch), the placeholder gone.
   RF-err: a genuine failure mid-run (`error`, lease settled) stays
   terminal: no row, nothing run here. Red on 460ba71b9.
   Breaks: refwhy. (No older runner exists: none is paired before this
   release, and old clients are refused, never shimmed.)
   KR (rig s14suhtr killrunner, review_suhtr HIGH-1, rulings §1 l.9,
   l.18): the person's choice is what the switch drew AT THE PRESS, on
   the real renderSeatSwitch over the real peer.js seatSwitch and
   autoDispatchDecision. The runner drawn, then gone and the switch
   redrawn plain Here: Send (KRa), Retry (KRb) and a missed read (KRc)
   each run Here. KRd: drawn at the press, a presence event during the
   read, declined: "not run". Red on cb1befee3 (KRa-c).
   Break: sticky (the runner kept until Here is pressed).

   KRe/KRf (review_suhtr_delta D1, D2; rulings §1 l.19): the snapshot reaches the
   send through every wait of the press, on the real sendUserMessage and
   sendPressed: an edit's resend across the transcript load (KRe), and a press
   queued behind a send in flight (KRf). Red on df6fda35a.
   Breaks: editdrawn | waitdrawn.

   KRg (STEER D4; rulings §1 l.16, l.19): a Pending tile's Do it and Discuss
   go through the one entry (sendUserMessage) with the switch drawn at the
   tile's press; they steered here straight. Red on e34cc1520.
   Break: pendingdrawn.

   KRh (STEER D3; rulings §1 l.12, l.16): a Diamond's Retry pressed while
   its own turn runs, or overtaken by one in the wait for the lease, waits
   (shown as queued words are) under its -rt lease and runs once that turn
   ends; runSteer's busy guard dropped it. KRh-2: two devices press it
   while busy, the turn runs once. Red on e34cc1520. (Break idlewait retired:
   since KRh-race a retry never reaches askAgain's backstop wait.)
   KRh-reload / KRh-stop / KRh-hold (STEER-2 F1-F3, rc's review of STEER):
   pressed while busy, the retry waits BEFORE any side effect (a reload
   mid-wait finds the row and its Retry, nothing taken); a lost lease in
   the wait aborts no other turn; a woken retry after a failed turn or
   under an open Decision is handed back to its row. Red on af5e52cfa.
   Breaks: waitfirst | stopown | wakehold.
   KRh-race (lead usr-63): a steer starts between the wake and the lease,
   then a reload: the claim and -rt lease come before the retraction, and
   a Diamond busy by then gets the lease back and the retry waits again,
   nothing retracted. Red on d9cd57c1a. Break: leasefirst.
   KRh-stale (N1, rc's review of STEER delta 1): a stale "not run" row on
   another device, pressed while this one runs the retry, redraws at once
   from the -rt lease as running there, with no Retry. Red on 7e73f10db.
   Breaks: stalerow | staleredraw.
   KRh-end (D2-1, rc's review of STEER delta 2): once A's retry has ended
   (its -rt lease `done`, or settled), B's stale row still reads the turn
   as claimed by A: "running on A", no Retry, and a press on a view not
   yet fresh stands down and redraws. A vacant, unsettled lease (the busy
   give-back) still draws a Retry that wins. Red on 39dd37c5d.
   Breaks: claimedrow | settledredraw.
   KRh-expire (D2-2): the REAL peer.js lease view announces an expiry no
   write marks: a take at T0, no renewals, the clock past its expiry: one
   change, no holder, and the row draws Retry. Red on 39dd37c5d.
   Break: expiry (in peer.js). KRh-expire (skew, D3-2): on a device 2 s
   behind the gateway, the tick at the authority expiry finds the hand-off
   footer already failed (it reads leaseClockNow, not the raw clock). Red
   on 87594cc4e. Break: skewclock.

   KRi (STEER-2; rulings §1 l.16, l.19): Continue on a turn where nothing
   arrived goes through the one entry with the switch drawn at its press;
   it ran here (KRi-runhere: "Run here" still runs here). KRj: a timer or mail trigger follows where the switch
   points at that moment (a mail turn pending-only on the errand), a
   runner gone ends it "not run"; KRj-2/2r: two devices whose timers fire
   together run it once (one id, one lease). Red on 774c1a4c7.
   Breaks: contentry | contdrawn | trigentry | timerclaim.
   KRj-mail (STEER-3 N2, rulings §16 l.261): a mail turn with the switch on
   a runner writes no row in the thread and elects no runner (none yet
   advertises running a turn pending-only): it runs here, pending-only.
   Red on 7e73f10db. Break: mailhere. (The hand-off: RESUME_MAILHANDOFF.md.)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const BREAK = (process.argv.indexOf('--break') >= 0) ? process.argv[process.argv.indexOf('--break') + 1] : '';
const BREAKS = {
	entry: ['if (!r.ok && !st.marked) answerUnhanded(chat, turnId, promptText, r);', ''],
	draw:  ["if (isNotRunRow(m)) {", "if (false) {"],
	lost:  ['retryTurn(current, m.iturn, notRunAsk(current, m), { lost: true })', 'retryTurn(current, m.iturn, notRunAsk(current, m))'],
	settled: ['if (_handBack[tid] != null && DaimondPeer.settledLease', 'if (false && DaimondPeer.settledLease'],
	readmiss: ['if (!pressed || turnHold(chat)) return false;', 'return false;'],
	declined: ['if (!shown || chatSeatHere(chat) || turnHold(chat)) return false;', 'return false;'],
	unknown:  ['try { if (window.DaimondPresence && DaimondPresence.lost) DaimondPresence.lost(); }', 'try { }'],
	// Since part 3 every path below ends "not run" anyway, so a break runs the turn here first (U1 red).
	withdraw: ["var notRun = (opts && opts.notRun) ? String(opts.notRun)", "var notRun = (opts && opts.notRun) ? (await recoverOneLocally(chat, m), 'x') && String(opts.notRun)"],
	cutref:   ["String(lease.cut || '') === 'refused')) ? 'the runner", "String(lease.cut || '') === 'refused')) ? (await recoverOneLocally(chat, m), 'x') && 'the runner"],
	refused:  ["try { endHandOffNotRun(chat, ph, 'refused after the mark: ' + why); }", 'try { recoverOneLocally(chat, ph); }'],
	behind:   ["=== 'models-behind' ? 'handed back", "=== 'models-behind' ? (await recoverOneLocally(chat, m), 'x') && 'handed back"],
	backstop: ['await endHandOffNotRun(chat, m, cause ?', 'await recoverOneLocally(chat, m, cause ?'],
	busy:     ['if (m.busyBy) { await endHandOffNotRun(chat, m,', 'if (m.busyBy) { await recoverOneLocally(chat, m,'],
	thread:   ["if (m.threadBy || cause === 'thread') { await endHandOffNotRun(chat, m,", "if (m.threadBy || cause === 'thread') { await recoverOneLocally(chat, m,"],
	models:   ["if (cause === 'models') { await endHandOffNotRun(chat, m,", "if (cause === 'models') { await recoverOneLocally(chat, m,"],
	onreturn: ['else await endHandOffNotRun(jobs[k].chat, jobs[k].m,', 'else await recoverOneLocally(jobs[k].chat, jobs[k].m,'],
	stepaway: ['if (m.stepAway) { await recoverOneLocally(chat, m); return; }', ''],
	editdrawn: ['retryTurn(chat, replacing, text, { onStart: press.release, drawn: press.drawn })', 'retryTurn(chat, replacing, text, { onStart: press.release })'],
	waitdrawn: ['drawn: drawn };', "drawn: target ? seatDrawnRunner(target) : '' };"],
	pendingdrawn: ["var drawn = pressed !== undefined ? String(pressed || '') :", 'var drawn ='],
	contentry: ['continueAsked(chat, text, contOpts, drawn);', 'askAgain(chat, text, contOpts);'],
	contdrawn: ["\t\t\tif (pressed !== undefined) drawn = String(pressed || '');\n\t\t\telse { try { drawn = seatDrawnRunner(chat); }", "\t\t\tif (pressed !== undefined) drawn = undefined;\n\t\t\telse { try { drawn = seatDrawnRunner(chat); }"],
	trigentry: ['var handed = await triggerHandOff(f, text, mail);', 'var handed = null;'],
	timerclaim: ['var claim = mail ? null : await claimTimerFire(f, ta);', 'var claim = null;'],
	waitfirst: ['\t\tif (rf && diamondBusy(rf.id)) {\n\t\t\tvar drawnAt', '\t\tif (false) {\n\t\t\tvar drawnAt'],
	stopown: [['\t\t\tif (endRetryWait(chat, -1, false, tid)) return;', '\t\t\tendRetryWait(chat, -1, false, tid);'],
		["if (!chat._generating || (String(chat._runMid || '') !== String(tid) && String(chat._turnTag || '') !== String(tid))) return;",
			'if (!chat._generating) return;']],
	leasefirst: ["\t\t\tif (diamondBusy(f.id)) {\n\t\t\t\tdiag('retry waits again'", "\t\t\tif (false) {\n\t\t\t\tdiag('retry waits again'"],
	wakehold: ["\t\tif (hold) {\n\t\t\tdiag('retry handed back'", "\t\tif (false) {\n\t\t\tdiag('retry handed back'"],
	mailhere:  ['\t\tif (mail) return null;\n\t\tvar chat = daimonChat(f)', '\t\tvar chat = daimonChat(f)'],
	stalerow:  ['\t\tif (isLostRow(m) && drawLostRowRunning(div, foot, m)) return;\n', ''],
	staleredraw: ["else if (why === 'held' || why === 'settled' || (took && took.holder)) {", "else if (why === 'settled') {"],
	claimedrow:  ['{ who = peerLeaseClaimed(rt); }', "{ who = peerLeaseHeld(rt) ? String(DaimondLease.holder(rt) || '') || '?' : ''; }"],
	skewclock: ['return DaimondPeer.uiState(m, lease, report, selfDeviceId(), leaseClockNow(), ask,', 'return DaimondPeer.uiState(m, lease, report, selfDeviceId(), Date.now(), ask,'],
	settledredraw: ["else if (why === 'held' || why === 'settled' || (took && took.holder)) {", "else if (why === 'held' || (took && took.holder)) {"],
	refwhy:   ["'the runner refused it before the run' + refWhy", "'the runner refused it before the run'"],
	// The sticky store killrunner found: the runner last drawn pressed, kept until Here is pressed.
	sticky:   [["if (shown === undefined) { try { shown = seatDrawnRunner(chat); }",
			"if (shown === undefined) { try { shown = (seatDrawnRunner(chat), _seatSticky[String(chat.id || '')]); }"],
		["\t\t\tdelete run.dataset.device;\n\t\t}\n\t\tbox.hidden = false;",
			"\t\t\tdelete run.dataset.device;\n\t\t}\n\t\tif (current && onRunner) _seatSticky[String(current.id)] = run.textContent;\n\t\telse if (current && chatSeatHere(current)) delete _seatSticky[String(current.id)];\n\t\tbox.hidden = false;"]],
};
// Breaks of peer.js itself, applied where the arm loads its own copy of it.
const PEER_BREAKS = {
	expiry: ['\t\tarmLeaseExpiry();\n\t\treturn moved;', '\t\treturn moved;'],
};
if (BREAK && !PEER_BREAKS[BREAK]) {
	const b = BREAKS[BREAK];
	const pairs = (b && Array.isArray(b[0])) ? b : [b];
	for (const pr of pairs) {
		if (!pr || SRC.indexOf(pr[0]) < 0) { console.log('FAIL — unknown break or its text is gone: ' + BREAK); process.exit(1); }
		SRC = SRC.replace(pr[0], pr[1]);
	}
	console.log('(break: ' + BREAK + ')');
}
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
function lift(name) {
	let a = SRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) a = SRC.indexOf('\n\tasync function ' + name + '(');
	if (a < 0) return '';
	// A one-line function ends on its own line (`lostRetryMid`), not at the next one's close.
	const line = SRC.slice(a, SRC.indexOf('\n', a + 1));
	if (/\}\s*$/.test(line)) return line + '\n';
	return SRC.slice(a, SRC.indexOf('\n\t}\n', a) + 3);
}

const NAMES = ['runDispatchFallback', 'leaseDoorRead', 'electProvider', 'electSources', 'dispatchedAnswerPresent', 'maybeAutoDispatch', 'endSendNotRun', 'handOffTurn', 'dispatchToPeer', 'answerUnhanded', 'sayIfUnhanded',
	'reRunParked', 'markInterrupted', 'isNotRunRow', 'notRunAsk', 'retryTurn', 'lostRetryMid', 'turnMessagesOf',
	'sendPresenceRead', 'endHandOffNotRun', 'endTurnNotRun', 'withdrawLostHandoffs', 'noteHandBack', 'peerCollectOnReturn',
	'renderSeatSwitch', 'seatDrawnRunner', 'isLostRow', 'drawLostRowRunning', 'peerLeaseHeld', 'peerLeaseClaimed', 'runnerLabel', 'dispatchedTurnSettled', 'handoffLeaseSettled', 'handBackNote', 'seatReason', 'seatWhyKey', 'seatWhyText', 'dropRefusedTiles',
	'notRunCause', 'notRunRecord', 'placeholderNotRun', 'notRunWhyKey', 'drawNotRunReason'];

// ── peer.js, loaded as the page loads it (the real recoverDecision / settledLease) ──
const PW = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(PW, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const RP = PW.DaimondPeer;

// A small element, enough for `markInterrupted` to draw a footer and a button.
function el(tag) {
	const e = { tag, children: [], handlers: {}, textContent: '', className: '', dataset: {}, attrs: {},
		classList: { add() {} },
		setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(k, f) { this.handlers[k] = f; } };
	return e;
}
function buttons(e, out = []) { if (e.tag === 'button') out.push(e); e.children.forEach((c) => buttons(c, out)); return out; }

// fault: 'unable' | 'transport' | 'build' | 'throw' | 'paused'
function world(fault, extra) {
	const W = { ran: [], retried: [], routed: [], posted: 0, holds: 0, diags: [], settled: [], taken: [], lost: 0, logged: 0 };
	const peer = {
		autoDispatchDecision: () => ({ dispatch: true, peer: { deviceId: 'argonaut1' }, reason: 'nominee' }),
		peerIdOf: (p) => (p && p.deviceId) || '', peerLabelOf: () => 'argonaut',
		buildDispatch: (c, o) => {
			if (fault === 'build') throw new Error('the thread cannot be taken from a chat whose transcript is not loaded');
			if (fault === 'big' || fault === 'refpost') return { mark: { interrupted: true, why: 'dispatched', iturn: o.turnId,
				itext: o.prompt, dispatchedBy: o.dispatchedBy, ts: Date.now() }, fields: {} };
			W.posted++; throw new Error('posted (not reached by a pre-mark refusal)');
		},
		REASON_DISPATCHED: 'dispatched', DISPATCH_FRESH_MS: 90000, MAX_PARKS: 2,
		turnInWindow: () => true, isAskAnswer: () => false,
		recoverDecision: RP.recoverDecision, settledLease: RP.settledLease, dispatchState: RP.dispatchState,
		settlingReport: RP.settlingReport,
		runErrand: () => {},
		sealFittingErrand: async (c, o, plan) => ({ body: { envelope: 'sealed' }, plan, seedDropped: false }),
		withdrawOnLoss: RP.withdrawOnLoss, triedAfterHandBack: RP.triedAfterHandBack, standDownUndecided: RP.standDownUndecided,
		syncCas: () => ({}),
		settleLease: async (what, id, holder, mode) => { W.settled.push(id + ':' + mode); return { ok: true }; },
	};
	const env = {
		window: null, Date, String, Object, Array, JSON, Math, Promise, setTimeout, Error,
		diag: (a, b) => W.diags.push(a + ' ' + b),
		t: (k) => k, document: { createElement: el, getElementById: () => null },
		selfDeviceId: () => 'phone1', nominatedDeviceId: () => 'argonaut1',
		turnHold: () => { W.holds++; return (fault === 'paused' && W.holds >= 3) ? 'root' : null; },
		DaimondModels: { pauseError: (n) => ({ message: 'Paused at ' + n + '.' }) },
		honoursModelSet: () => fault !== 'unable',
		DaimondPeer: peer,
		DaimondPost: fault === 'transport' ? undefined : { post: async () => { W.posted++; return fault === 'refpost' ? { ok: false, status: 413, why: 'qa: refused' } : { ok: true }; },
			fitsRelay: () => fault !== 'big' },
		markTurnDispatched: (c, mark) => { c.messages.push(Object.assign({ mid: 'ph-' + mark.iturn }, mark)); },
		DaimondSync: { push: () => {} },
		DaimondPresence: { snapshot: () => ({}) },
		presenceWithLeaseBusy: (p) => p, turnPresence: (p) => p, reconcileRoster: () => {},
		isPhoneViewport: () => true, chatToolsEnabled: () => false, preferredWorkerLabel: () => '',
		fleetCurrentBuild: () => '', handoffWhenAway: () => true, chatRunningOn: () => '', chatSeatHere: () => false,
		chatNeedsFolder: () => false, electionTrace: () => '', autoLogElection: () => { W.logged++; },
		PRESENCE_READ_CAP_MS: 2000, UNDECIDED_RECOLLECT_MS: 30000,
		claimTurnHere: async () => ({ release() {} }), peerSyncShim: () => ({}), clearDispatchFallback: () => {},
		redrawRunner: () => {}, _dispatchedIx: {}, seatNoteOnPrompt: () => false, seatNameOf: () => 'argonaut',
		dispatchedPlaceholderIn: (c, tid) => (c.messages || []).find((x) => x.why === 'dispatched' && x.iturn === tid) || null,
		TAKE: 'won',
		_seatShownRunner: {}, _seatSticky: {}, renderSeatSwitch: () => {},
		giveUpSent: () => {}, newMid: (() => { let n = 0; return () => 'm' + (++n); })(),
		_handoffStart: {}, _electionTrace: {}, deviceLabelFor: () => 'argonaut', dsEvent: () => {},
		commitRatings: () => {}, ownsChat: () => false, appendUserMessage: () => {},
		pushUserRecord: (c, m) => { c.messages.push(m); },
		touchMsg: (m) => { m._touched = (m._touched | 0) + 1; return m; },
		touchChat: () => {}, persistChats: () => {}, renderHistory: () => {},
		scheduleDispatchFallback: () => {}, PRESUMED_FALLBACK_MS: 5000, electedTried: () => ['argonaut1'],
		turnEffortOf: () => null, storedPre: () => { if (fault === 'throw') throw new Error('qa: a throw before the mark'); return ''; },
		storedEffort: () => null, errandModelOf: () => ({}), errandFence: async () => null, errandClean: () => false, errandLocked: () => undefined, errandLimits: () => undefined, errandSession: () => undefined, errandReach: async () => undefined, errandToday: () => '', errandWords: async () => undefined, errandWordsFor: async () => undefined, errandProdBase: () => null, errandScope: (c, h) => h, autonomousPosture: () => false, msgTombsOwed: () => [],
		deviceNameFor: () => '',
		loadChatMessages: async () => {}, friendlyError: (e) => String(e && e.message),
		seatSwitchFor: () => ({ runner: { deviceId: 'argonaut1' } }),
		peerReports: {}, placeholderParkCount: () => 0,
		// A run here, in silence, is what must never happen.
		continueTurn: (c, tid) => { W.ran.push('continue:' + tid); },
		runTurn: (c, txt) => { W.ran.push('run:' + txt); },
		// The retry door, recorded where it hands on to the switch.
		retryRouted: (c, text, nmid, lost) => { W.routed.push({ text, nmid, lost: !!lost }); return true; },
		// A Diamond's retry is admitted only where its Diamond is here and idle (RF-D).
		steerDiamondOf: (c) => (c && c.diamondId ? { id: c.diamondId } : null), diamondBusy: () => false,
		loadMsgTombs: () => ({}), msgTombstone: () => {}, sessionCut: () => {}, ChatStore: { compact: () => {} },
		leaseClockNow: () => Date.now(),
		// The backstop's world: one chat, a lease the test sets, a hand-back held or not.
		chats: [], _handBack: {}, _handBackCause: {}, _abiRefused: {}, _progressView: {}, _finalMids: {}, _finalRun: {}, _fallbackInFlight: {}, _localRecovering: {}, _localEnding: {}, LEASE: null,
		// The test's one lease is the turn under test's, never its retry's `-rt` lease unless it names it.
		DaimondLease: { record: (tid) => (/-rt$/.test(String(tid)) && !(env.LEASE && (env.LEASE.turnId === tid || env.LEASE.turn === tid)) ? null : env.LEASE), snapshot: () => (env.LEASE ? { [env.LEASE.turn || '']: env.LEASE } : {}),
			take: async (tid) => { W.taken.push(tid); return env.TAKE === 'won' ? { won: true } : { won: false, why: 'held', holder: 'argonaut1' }; } },
		dispatchedChat: () => env.chats[0] || null, dispatchedTurnFinished: () => !!(env.LEASE && RP.settledLease(env.LEASE)),
		recoverOneLocally: (c, m) => { W.ran.push('recover:' + m.iturn); },
		_recovering: false, releaseOwnStaleLeases: async () => {},
		dropDispatchedPlaceholder: (tid) => { W.dropped = tid; const c = env.chats[0];
			c.messages = c.messages.filter((x) => !(x.why === 'dispatched' && x.iturn === tid)); },
		current: null,
	};
	env.window = env;
	const have = NAMES.concat(extra || []).map((n) => [n, lift(n)]).filter((x) => x[1]);
	W.have = have.map((x) => x[0]);
	// The not-run cause map (NOTRUN-WHY), as the page holds it.
	const notrunKeys = (/\n\tvar NOTRUN_KEYS = \{[\s\S]*?\n\t\};/.exec(SRC) || [''])[0];
	const body = notrunKeys + have.map((x) => x[1]).join('\n') + '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
		get: (t, k) => t[k],
		set: (t, k, v) => { t[k] = v; return true; },
	});
	W.env = env;
	W.f = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
	return W;
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };

// The "not run" row's Retry, pressed: drawn by the real markInterrupted, through the real retryTurn.
function pressRetry(W, chat, row) {
	if (!W.f.markInterrupted) return { drawn: false };
	W.env.current = chat;
	const div = el('div');
	try { W.f.markInterrupted(div, row); } catch (e) { return { drawn: false, threw: String(e) }; }
	const bs = buttons(div);
	const rb = bs.find((b) => b.textContent === 'turn.retry');
	const label = JSON.stringify(div.children.map((c) => c.children.map((x) => x.textContent)));
	if (!rb || !rb.handlers.click) return { drawn: true, retry: false, label };
	rb.handlers.click();
	return { drawn: true, retry: true, label };
}

function verdict(name, W, chat, tid, prompt, diamond) {
	const rows = chat.messages.filter((m) => m && String(m.iturn || '') === tid && m.role !== 'user');
	const errs = rows.filter((m) => m.role === 'error_log');
	const notrun = rows.filter((m) => !!m.notRun);
	check(name + ' U1 not run here in silence', W.ran.length === 0, JSON.stringify(W.ran));
	check(name + ' U2 no Retry-less error line', errs.length === 0, JSON.stringify(errs.map((m) => m.content)));
	check(name + ' U3 one durable "not run" row on the turn', notrun.length === 1
		&& notrun[0].interrupted === true && notrun[0].role === 'assistant' && notrun[0]._touched > 0,
		JSON.stringify(rows));
	if (!notrun.length) { check(name + ' U4 its Retry asks the turn again through retryTurn', false, 'no row'); return; }
	const p = pressRetry(W, chat, notrun[0]);
	if (diamond) return p;	// a Diamond's Retry: its caller reads the run (STEER D3, `retryDiamond`)
	const rt = W.routed[0];
	check(name + ' U4 its Retry asks the turn again through retryTurn', p.retry && W.routed.length === 1
		&& rt.text === prompt && rt.lost === true && rt.nmid === tid + '-rt' && W.ran.length === 0,
		JSON.stringify({ p, routed: W.routed, ran: W.ran }));
}

async function main() {
	const PROMPT = 'build the page';
	for (const fault of ['unable', 'transport', 'build', 'throw']) {
		console.log('S-' + fault + ': the send, refused before the mark');
		const W = world(fault);
		const chat = { id: 'c1', messages: [], holds: [] };
		let went;
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'u1'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('S-' + fault + ' the send committed (composer given up, no local run follows)', went === true, String(went));
		verdict('S-' + fault, W, chat, 'u1', PROMPT);
		if (fault === 'build') {
			// A second refusal of the same turn: one row, refreshed.
			await (W.f.handOffTurn || W.f.dispatchToPeer)(chat, 'u1', PROMPT, [], { runTo: 'argonaut1' });
			await settle();
			const n = chat.messages.filter((m) => !!m.notRun && m.iturn === 'u1').length;
			check('S-build U5 a second refusal refreshes the row, adds none', n === 1, 'rows ' + n);
		}
	}
	for (const fault of ['unable', 'build']) {
		console.log('R-' + fault + ': the parked re-run, refused before the mark');
		const W = world(fault);
		const chat = { id: 'c1', holds: [], messages: [
			{ role: 'user', content: PROMPT, mid: 'p1', iturn: 'p1' },
			{ role: 'assistant', content: '', interrupted: true, why: 'dispatched', iturn: 'p1', mid: 'ph1', itext: PROMPT },
		] };
		W.f.reRunParked(chat, 'p1', PROMPT);
		await settle();
		verdict('R-' + fault, W, chat, 'p1', PROMPT);
	}
	for (const [id, handBack, answered] of [['H', true, false], ['H0', false, false], ['H2', true, true]]) {
		console.log(id + ': the backstop, a settled lease' + (handBack ? ' under a hand-back' : ' with no hand-back')
			+ (answered ? ', its answer landed' : ''));
		const W = world('none');
		const chat = { id: 'c1', holds: [], messages: [
			{ role: 'user', content: PROMPT, mid: 'h1', iturn: 'h1' },
			{ role: 'assistant', content: '', interrupted: true, why: 'dispatched', iturn: 'h1', mid: 'ph1', itext: PROMPT,
				dispatchedBy: 'phone1', toDevice: 'argonaut1', ts: Date.now() },
		] };
		if (answered) chat.messages.push({ role: 'assistant', content: 'the page is built', iturn: 'h1', mid: 'a1' });
		W.env.chats = [chat];
		W.env.LEASE = { mode: 'done', holder: 'argonaut1', ts: Date.now() };
		if (handBack) W.env._handBack.h1 = 'c1';
		if (!W.f.runDispatchFallback) { check(id + ' runDispatchFallback lifted', false); continue; }
		await W.f.runDispatchFallback('c1', 'h1');
		await settle();
		if (id === 'H') {
			verdict('H', W, chat, 'h1', PROMPT);
			check('H the placeholder goes, so the row is the turn\'s one ending', W.dropped === 'h1', String(W.dropped));
		} else {
			const n = chat.messages.filter((m) => !!m.notRun).length;
			check(id + ' no "not run" row, nothing run here', n === 0 && W.ran.length === 0, 'notrun=' + n + ' ran=' + JSON.stringify(W.ran));
		}
	}
	for (const fault of ['big', 'refpost']) {
		console.log('D-' + fault + ': the send, refused after the mark');
		const W = world(fault);
		const chat = { id: 'c1', messages: [], holds: [] };
		W.env.chats = [chat];
		let went;
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'd1'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('D-' + fault + ' the send committed', went === true, String(went));
		check('D-' + fault + ' the lease is taken and settled, the placeholder goes', W.settled.join() === 'd1:done,d1:released'
			&& !chat.messages.some((m) => m.why === 'dispatched'), JSON.stringify({ settled: W.settled }));
		verdict('D-' + fault, W, chat, 'd1', PROMPT);
	}
	// ── F1: the send-time read, under a deriving gateway ──
	function readWorld(lands, shown, here, extra) {
		const W = world('none', extra);
		const e = W.env;
		e.setTimeout = (fn, ms) => setTimeout(fn, ms === 2000 ? 0 : ms);	// the 2 s cap, at once
		e.DaimondSync = { push: () => {}, presenceDerived: () => true,
			refreshPresence: () => lands ? Promise.resolve({ presence: lands, derived: true }) : new Promise(() => {}) };
		e.DaimondPresence = { snapshot: () => lands || {}, lost: () => { W.lost++; } };
		e._seatShownRunner = shown ? { c1: 'Chrome on argonaut' } : {};	// what cb1befee3 read
		e._seatSticky = shown ? { c1: 'Chrome on argonaut' } : {};		// --break sticky
		e.seatSwitchFor = () => (shown ? { choice: 'runner', runner: { deviceId: 'argonaut1', label: 'Chrome on argonaut' }, until: 0 }
			: { choice: 'here', runner: null, until: 0 });
		e.chatSeatHere = () => !!here;
		return W;
	}
	{
		console.log('F1: the read did not land in 2 s, the runner pressed');
		const W = readWorld(null, true, false);
		const chat = { id: 'c1', messages: [], holds: [] };
		let went;
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'r1'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('F1 the send is answered here (no local run follows)', went === true, String(went));
		check('F1 the prompt stands in the transcript', chat.messages.some((m) => m.role === 'user' && m.iturn === 'r1'));
		verdict('F1', W, chat, 'r1', PROMPT);
		check('F1 nothing posted: it runs nowhere', W.posted === 0, 'posted ' + W.posted);
		check('F1 the election is logged', W.logged === 1, 'logged ' + W.logged);
		check('F1 the map is marked unknown on the timeout', W.lost >= 1, 'lost ' + W.lost);
	}
	{
		console.log('F1-ctl: the read lands, the pressed runner is gone (rc ruling 23 Oct, QA B F5)');
		const W = readWorld({ argonaut1: { listening: false } }, true, false);
		W.env.DaimondPeer.autoDispatchDecision = () => ({ dispatch: false, reason: 'local' });
		const chat = { id: 'c1', messages: [], holds: [] };
		let went;
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'r2'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('F1-ctl the send is answered here (no local run follows)', went === true, String(went));
		check('F1-ctl the prompt stands in the transcript', chat.messages.some((m) => m.role === 'user' && m.iturn === 'r2'));
		verdict('F1-ctl', W, chat, 'r2', PROMPT);
		check('F1-ctl nothing posted, the election logged', W.posted === 0 && W.logged === 1, 'posted ' + W.posted + ' logged ' + W.logged);
	}
	{
		console.log('F1-ctl-here: the read lands, the runner is gone, nothing pressed');
		const W = readWorld({ argonaut1: { listening: false } }, false, false);
		W.env.DaimondPeer.autoDispatchDecision = () => ({ dispatch: false, reason: 'local' });
		const chat = { id: 'c1', messages: [], holds: [] };
		const went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'r4');
		await settle();
		check('F1-ctl-here runs Here as before, no row', went === false && !chat.messages.some((m) => m.notRun || m.why === 'notrun')
			&& W.logged === 1, 'went ' + went + ' logged ' + W.logged);
	}
	// ── KR (rig s14suhtr killrunner, review_suhtr HIGH-1; rulings §1 l.9, l.18): the person's choice is
	// what the switch drew AT THE PRESS. The REAL renderSeatSwitch draws from the REAL peer.js seatSwitch
	// over a presence map the arm sets, and the REAL autoDispatchDecision decides. KRa/KRb: the runner drawn,
	// then gone and redrawn plain Here; Send, then Retry, each run Here. KRc: the same, the read missed.
	// KRd: drawn at the press, a presence event during the read redraws Here, declined: "not run" (F5).
	function drawnWorld(extra) {
		const W = readWorld({}, false, false, extra);
		const e = W.env;
		const node = () => ({ hidden: false, textContent: '', title: '', dataset: {}, attrs: {},
			setAttribute(k, v) { this.attrs[k] = v; } });
		W.els = { 'seat-switch': node(), 'seat-here': node(), 'seat-runner': node() };
		e.document = { createElement: el, getElementById: (id) => W.els[id] || null };
		e.armSeatSwitchTimer = () => {};
		e.loadDevices = () => ({ phone1: {}, argonaut1: {} });
		e._seatShownRunner = {}; e._seatSticky = {};
		const now = Date.now();
		W.BEATING = { argonaut1: { deviceId: 'argonaut1', label: 'argonaut', lastSeen: now, servicedAt: now,
			listening: true, awake: true, isDesktop: true, build: '' } };
		W.presence = W.BEATING;
		const opts = { selfId: 'phone1', nominatedId: 'argonaut1', isPhone: true, globalDefault: true,
			freshWindowMs: RP.DISPATCH_FRESH_MS, runnerOnly: true };
		e.seatSwitchFor = (c) => RP.seatSwitch(c, W.presence, opts, Date.now());
		e.DaimondPeer.autoDispatchDecision = RP.autoDispatchDecision;
		e.DaimondPresence = { snapshot: () => W.presence, lost: () => { W.lost++; } };
		// The read lands with the map as it then stands, and redraws the switch, as `daimond:presence` does.
		W.read = (next) => () => { W.presence = next; W.f.renderSeatSwitch(); return Promise.resolve({ presence: next, derived: true }); };
		e.DaimondSync.refreshPresence = W.read({});
		W.redraw = (p) => { W.presence = p; W.f.renderSeatSwitch(); };
		W.drawsRunner = () => !W.els['seat-runner'].hidden && W.els['seat-runner'].attrs['aria-pressed'] === 'true';
		W.drawsHere = () => W.els['seat-runner'].hidden && W.els['seat-here'].attrs['aria-pressed'] === 'true';
		return W;
	}
	const noRow = (chat) => !chat.messages.some((m) => !!m.notRun);
	const rowsOf = (chat) => JSON.stringify(chat.messages.filter((m) => m.notRun).map((m) => m.notRun.why));
	{
		console.log('KRa/KRb: the runner drawn, then gone and redrawn Here; Send, then Retry');
		const W = drawnWorld();
		const chat = { id: 'c1', messages: [], holds: [] };
		W.env.current = chat;
		check('KR renderSeatSwitch and seatDrawnRunner lifted', W.have.indexOf('renderSeatSwitch') >= 0 && W.have.indexOf('seatDrawnRunner') >= 0,
			W.have.join());
		W.redraw(W.BEATING);
		const drew = W.drawsRunner();
		W.redraw({});
		check('KR the real switch drew the runner pressed, then plain Here', drew && W.drawsHere());
		let went;
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'k1'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('KRa Send runs Here: no "not run" row', went === false && noRow(chat), 'went ' + went + ' rows ' + rowsOf(chat));
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'k1-rt'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('KRb Retry runs Here: no "not run" row', went === false && noRow(chat), 'went ' + went + ' rows ' + rowsOf(chat));
		check('KR nothing posted, the election logged twice', W.posted === 0 && W.logged === 2, 'posted ' + W.posted + ' logged ' + W.logged);
	}
	{
		console.log('KRc: the runner drawn, then gone and redrawn Here; Send, the read misses');
		const W = drawnWorld();
		const chat = { id: 'c1', messages: [], holds: [] };
		W.env.current = chat;
		W.redraw(W.BEATING);
		W.redraw({});
		W.env.DaimondSync.refreshPresence = () => new Promise(() => {});
		let went;
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'k3'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('KRc a missed read under a plain Here switch runs Here', went === false && noRow(chat) && W.lost >= 1,
			'went ' + went + ' rows ' + rowsOf(chat) + ' lost ' + W.lost);
	}
	{
		console.log('KRd: the runner drawn at the press, gone by the send-time read');
		const W = drawnWorld();
		const chat = { id: 'c1', messages: [], holds: [] };
		W.env.current = chat;
		W.redraw(W.BEATING);
		const drew = W.drawsRunner();
		let went;
		try { went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'k2'); } catch (e) { went = 'threw ' + e; }
		await settle();
		check('KRd the switch drew the runner at the press and Here after the read', drew && W.drawsHere());
		check('KRd the send ends here (no local run follows)', went === true, String(went));
		check('KRd the row names the declined runner', /runner argonaut was pressed and the election declined it/.test(
			(chat.messages.find((m) => m.notRun) || { notRun: {} }).notRun.why || ''), rowsOf(chat));
		verdict('KRd', W, chat, 'k2', PROMPT);
	}
	// ── KRe/KRf (review_suhtr_delta D1, D2; rulings §1 l.19): the press's snapshot reaches the send
	// through every wait the press makes. The REAL sendUserMessage → sendPressed → (edit) retryTurn →
	// retryRouted → maybeAutoDispatch, under the REAL switch. KRe: an edit's resend, the transcript
	// loaded after the press, a presence event in that load redraws Here. KRf: a second door's press
	// waits behind a send in flight, the runner gone in that wait. Each: drawn at the press, so the
	// read that finds it gone ends "not run", never Here. Red on df6fda35a.
	// Breaks: editdrawn (the edit drops the snapshot), waitdrawn (taken after the wait).
	const SEND = ['sendUserMessage', 'sendPressed', 'holdSend', 'retryRouted', 'askAgain', 'lastTurnOf'];
	function pressWorld(more) {
		const W = drawnWorld(SEND.concat(more || []));
		const e = W.env;
		Object.assign(e, { chatInput: { value: '' }, syncSendMode: () => {}, confirmHold: async () => {},
			cfgReady: () => true, newChat: () => {}, startChat: () => {}, conciseText: (c, x) => x,
			recoveringHere: () => false, dispatchInFlight: () => null, sayIntoHere: () => false, enqueueMessage: (c, x) => { W.ran.push('queued:' + x); },
			steerDiamondOf: () => null, diamondBusy: () => false, peerUiStateFor: () => '', answerAgain: () => { W.ran.push('answerAgain'); },
			retryRouted: undefined });
		e.DaimondModels = Object.assign({}, e.DaimondModels, { resolve: () => ({}) });
		e.DaimondPeer.isAskAnswer = () => false;
		return W;
	}
	const notRunRow = (chat) => chat.messages.find((m) => !!m.notRun) || null;
	{
		console.log('KRe: an edit resent, the runner drawn at the press, gone during the transcript load');
		const W = pressWorld();
		const chat = { id: 'c1', holds: [], _loaded: false, _editing: 'e0', messages: [
			{ role: 'user', content: 'the old words', mid: 'e0', iturn: 'e0' },
			{ role: 'assistant', content: 'an answer', mid: 'e0a', iturn: 'e0' }] };
		W.env.current = chat;
		check('KRe sendUserMessage, sendPressed, retryRouted lifted', SEND.every((n) => W.have.indexOf(n) >= 0), W.have.join());
		W.redraw(W.BEATING);
		const drew = W.drawsRunner();
		W.env.loadChatMessages = async () => { W.redraw({}); };
		W.env.chatInput.value = PROMPT;
		try { await W.f.sendUserMessage(); } catch (e) { W.ran.push('threw ' + e); }
		await settle();
		check('KRe the switch drew the runner at the press and Here after the load', drew && W.drawsHere());
		check('KRe the old turn is retracted', !chat.messages.some((m) => m.iturn === 'e0'), JSON.stringify(chat.messages.map((m) => m.mid)));
		check('KRe not run here: the pressed runner is gone', W.ran.length === 0, JSON.stringify(W.ran));
		const row = notRunRow(chat);
		check('KRe one "not run" row names the declined runner', !!row && chat.messages.filter((m) => !!m.notRun).length === 1
			&& /runner argonaut was pressed and the election declined it/.test(row.notRun.why || ''), rowsOf(chat));
	}
	{
		console.log('KRf: a press waits behind a send in flight; the runner drawn at the press, gone in the wait');
		const W = pressWorld();
		const chat = { id: 'c1', holds: [], messages: [] };
		W.env.current = chat;
		W.redraw(W.BEATING);
		const drew = W.drawsRunner();
		const release = W.f.holdSend(chat);
		const sent = W.f.sendUserMessage(PROMPT);
		await settle();
		W.redraw({});
		const waited = W.ran.length === 0 && !chat.messages.length;
		release();
		try { await sent; } catch (e) { W.ran.push('threw ' + e); }
		await settle();
		check('KRf the press waited, and the switch drew Here after the wait', drew && waited && W.drawsHere());
		check('KRf not run here: the pressed runner is gone', W.ran.length === 0, JSON.stringify(W.ran));
		check('KRf one "not run" row names the declined runner', /runner argonaut was pressed and the election declined it/.test(
			(notRunRow(chat) || { notRun: {} }).notRun.why || ''), rowsOf(chat));
		const row = notRunRow(chat);
		check('KRf the row is durable and drawn interrupted', !!row && row.interrupted === true && row._touched > 0
			&& chat.messages.filter((m) => !!m.notRun).length === 1, rowsOf(chat));
	}
	// ── KRg (STEER D4; rulings §1 l.16, l.19): a Pending tile's Do it and Discuss go through the one
	// entry. They steered here straight (`doSteer`), whatever the switch said. The REAL Pending.doProposal
	// and Pending.discuss → sendUserMessage → sendPressed → sendToDiamondTurn → maybeAutoDispatch, under
	// the REAL switch: the runner drawn at the press, gone while the Diamond opens, so the turn ends
	// "not run" and never runs here. Red on e34cc1520. Break: pendingdrawn (the press's snapshot dropped).
	function liftMethod(name) {
		let a = SRC.indexOf('\n\t\t' + name + ': async function (');
		if (a < 0) a = SRC.indexOf('\n\t\t' + name + ': function (');
		if (a < 0) return null;
		const body = SRC.slice(SRC.indexOf(':', a) + 1, SRC.indexOf('\n\t\t},\n', a) + 4);
		return body;
	}
	for (const [id, how] of [['KRg-do', 'doProposal'], ['KRg-discuss', 'discuss']]) {
		console.log(id + ': a Pending tile\'s ' + how + ', the runner drawn at the press, gone while the Diamond opens');
		const W = pressWorld(['sendToDiamondTurn']);
		const e = W.env;
		const f = { id: 'd1', name: 'Life log' };
		const chat = { id: 'c1', diamondId: 'd1', holds: [], messages: [] };
		const other = { id: 'c0', holds: [], messages: [] };
		e.current = other;
		Object.assign(e, { diamonds: [f], currentDiamond: null, daimonChat: () => chat, toast: () => {},
			peerHeldTurnOf: () => null, dispatchInFlight: () => null, sayToRunner: async () => false,
			doSteer: (text) => { W.ran.push('steer:' + text); return Promise.resolve(''); },
			settleConsent: () => true,
			selectDiamond: async (d) => { W.redraw({}); e.currentDiamond = d; e.current = chat; } });
		const P = { drop: () => {} };
		const names = ['doProposal', 'discuss', 'heldFor', 'drawnFor', 'send'];
		const src = names.map((n) => [n, liftMethod(n)]).filter((x) => x[1]);
		const made = new Function('scope', 'with (scope) { return {' + src.map((x) => x[0] + ':' + x[1]).join(',\n') + '}; }')(
			new Proxy(e, { has: (t, k) => typeof k === 'string' && (k in W.f || k in t || !(k in globalThis)),
				get: (t, k) => (k in W.f ? W.f[k] : t[k]),
				set: (t, k, v) => { t[k] = v; return true; } }));
		Object.assign(P, made);
		e.Pending = P;
		check(id + ' the real Pending.' + how + ' lifted', typeof P[how] === 'function', src.map((x) => x[0]).join());
		// The switch draws for the Diamond's conversation; the tile is pressed from another one.
		e.current = chat; W.redraw(W.BEATING); const drew = W.drawsRunner(); e.current = other;
		try { await P[how]({ id: 'p1', diamondId: 'd1', kind: 'proposal', headline: 'tidy the notes', detail: '' }); }
		catch (err) { W.ran.push('threw ' + err); }
		await settle();
		check(id + ' the switch drew the runner at the press and Here after the Diamond opened', drew && W.drawsHere());
		check(id + ' not run here: the pressed runner is gone', W.ran.length === 0, JSON.stringify(W.ran));
		check(id + ' one "not run" row names the declined runner', chat.messages.filter((m) => !!m.notRun).length === 1
			&& /runner argonaut was pressed and the election declined it/.test((notRunRow(chat) || { notRun: {} }).notRun.why || ''),
			rowsOf(chat));
	}
	// ── KRh (STEER D3; rulings §1 l.12, l.16, l.19): a Diamond's Retry pressed while its own turn runs,
	// or overtaken by one in the wait for the lease, is run once that turn ends, under its `-rt` id and
	// lease, and waits where queued words wait. `runSteer` dropped it (a preset while busy): the turn
	// was retracted, or the press refused, and nothing ran. The REAL Retry (markInterrupted) → retryTurn
	// → retryRouted → maybeAutoDispatch (the REAL switch, drawing Here) → runRetryHere → askAgain, and
	// the REAL setCrystalBusy / diamondBusy; `runSteer` is its busy guard alone. Red on e34cc1520.
	// KRh-2: two devices press it while busy; the turn runs once.
	const D3 = ['retryRouted', 'runRetryHere', 'watchRetryLease', 'askAgain', 'awaitDiamondIdle', 'endRetryWait', 'setCrystalBusy',
		'diamondBusy', 'waitingOn', 'steerDiamondOf', 'retryWhenIdle', 'retryDiamond'];
	function busyWorld(self, store) {
		const W = drawnWorld(D3);
		const e = W.env;
		W.steered = []; W.droppedSteer = []; W.shown = []; W.aborted = [];
		W.presence = {};		// no runner reachable: the switch draws plain Here, so the retry runs here
		const f = { id: 'd1', name: 'Life log' };
		Object.assign(e, { diamonds: [f], currentDiamond: f, crystalRunning: Object.create(null),
			_diamondIdle: Object.create(null), syncFoldBusy: () => {}, toast: () => {}, putInComposer: () => {},
			chatInput: { value: '' }, syncSendMode: () => {}, answerAgain: () => { W.ran.push('answerAgain'); },
			askOpenIn: () => !!W.askOpen, abortTurn: (c) => { W.aborted.push(c.id); },
			setInterval: (fn) => { W.beat = fn; return 1; }, clearInterval: () => {},
			retryRouted: undefined, steerDiamondOf: undefined, diamondBusy: undefined, selfDeviceId: () => self,
			renderQueue: () => { W.shown.push((e.current && e.current._retryWait || []).map((w) => w.text).join('|')); },
			runSteer: (g, text, d, det, how) => {
				if (e.crystalRunning[g.id]) { W.droppedSteer.push(how && how.mid); return Promise.resolve(''); }
				W.steered.push(self + ':' + (how && how.mid)); return Promise.resolve('ok');
			} });
		e.DaimondLease = Object.assign({}, e.DaimondLease, {
			take: async (tid, rec) => {
				W.taken.push(tid);
				if (W.onTake) W.onTake();
				const h = store[tid];
				if (h && h !== rec.holder) return { won: false, why: 'held', holder: h };
				store[tid] = rec.holder; return { won: true };
			} });
		e.DaimondPeer.settleLease = async (what, id, holder, mode) => { W.settled.push(id + ':' + mode); return { ok: true }; };
		return W;
	}
	function lostChat() {
		return { id: 'c1', diamondId: 'd1', holds: [], messages: [
			{ role: 'user', content: PROMPT, mid: 'h1', iturn: 'h1' },
			{ role: 'assistant', content: '', interrupted: true, why: 'notrun', notRun: { why: 'qa' }, iturn: 'h1', mid: 'nr-h1', itext: PROMPT }] };
	}
	for (const [id, at] of [['KRh-press', 'press'], ['KRh-wait', 'wait']]) {
		console.log(id + ': a Diamond\'s Retry, its own turn running ' + (at === 'press' ? 'at the press' : 'from the wait for the lease'));
		const W = busyWorld('phone1', {});
		const chat = lostChat();
		W.env.current = chat;
		check(id + ' the retry path lifted', D3.every((n) => W.have.indexOf(n) >= 0), D3.filter((n) => W.have.indexOf(n) < 0).join());
		if (!W.f.setCrystalBusy) continue;
		if (at === 'press') W.f.setCrystalBusy('d1', true);
		else W.onTake = () => { W.onTake = null; W.f.setCrystalBusy('d1', true); };
		const p = pressRetry(W, chat, chat.messages[1]);
		await settle();
		const waiting = W.steered.length === 0 && W.droppedSteer.length === 0;
		const shown = (W.f.waitingOn ? W.f.waitingOn(chat) : 0) === 1 && W.shown.indexOf(PROMPT) >= 0;
		// Pressed while busy, nothing is taken until the wait ends (F1); overtaken in the take, the lease is
		// given back and nothing is retracted (lead usr-63: the lease is never held across a wait).
		const held = at === 'press' ? W.taken.join() === '' && W.settled.length === 0
			: W.taken.join() === 'h1-rt' && W.settled.join() === 'h1-rt:released' && chat.messages.map((m) => m.mid).join() === 'h1,nr-h1';
		W.f.setCrystalBusy('d1', false);
		await settle();
		check(id + ' the Retry pressed, and it waits while the turn runs', p.retry && waiting, JSON.stringify({ p, steered: W.steered, dropped: W.droppedSteer }));
		check(id + ' it waits where queued words wait', shown, JSON.stringify(W.shown));
		check(id + (at === 'press' ? ' no -rt lease is taken in the wait' : ' its -rt lease is given back for the wait, nothing retracted'), held,
			JSON.stringify({ taken: W.taken, settled: W.settled }));
		check(id + ' it runs once the turn ends, once, under its -rt id', W.steered.join() === 'phone1:h1-rt' && W.droppedSteer.length === 0,
			JSON.stringify({ steered: W.steered, dropped: W.droppedSteer, diags: W.diags.filter((d) => /retry/.test(d)) }));
		check(id + ' the lease is settled after the run, the wait drawn away', W.settled.join() === (at === 'press' ? '' : 'h1-rt:released,') + 'h1-rt:done,h1-rt:released'
			&& !(chat._retryWait || []).length && W.shown[W.shown.length - 1] === '', JSON.stringify({ settled: W.settled, shown: W.shown }));
	}
	{
		console.log('KRh-reload (F1): pressed while the Diamond is busy, a reload mid-wait keeps the row and its Retry');
		const W = busyWorld('phone1', {});
		const chat = lostChat();
		W.env.current = chat;
		if (W.f.setCrystalBusy) {
			W.f.setCrystalBusy('d1', true);
			const p = pressRetry(W, chat, chat.messages[1]);
			await settle();
			// The reload: memory (`_retryWait`) is gone; what is left is the record and the lease store.
			const rows = chat.messages.map((m) => m.mid).join();
			const waiting = (chat._retryWait || []).length === 1;
			const retryAgain = pressRetry(W, chat, chat.messages.find((m) => m.mid === 'nr-h1') || { iturn: 'h1' });
			check('KRh-reload the user row and the "not run" row with Retry stand, nothing taken or settled',
				p.retry && rows === 'h1,nr-h1' && retryAgain.retry && W.taken.length === 0 && W.settled.length === 0 && waiting,
				JSON.stringify({ rows, taken: W.taken, settled: W.settled, waiting }));
			check('KRh-reload a second press waits with the first, not beside it', (chat._retryWait || []).length === 1,
				String((chat._retryWait || []).length));
			W.f.setCrystalBusy('d1', false);
			await settle();
			check('KRh-reload woken, it retracts, takes its lease and runs once', W.steered.join() === 'phone1:h1-rt'
				&& W.taken.join() === 'h1-rt' && !chat.messages.some((m) => m.mid === 'nr-h1'),
				JSON.stringify({ steered: W.steered, taken: W.taken, rows: chat.messages.map((m) => m.mid) }));
		} else check('KRh-reload the retry path lifted', false);
	}
	{
		console.log('KRh-stop (F2): a lost retry lease stops only the run of that turn, never the Diamond\'s other turn');
		const W = busyWorld('phone1', {});
		const chat = lostChat();
		W.env.current = chat;
		if (W.f.watchRetryLease) {
			chat._generating = true; chat._runMid = 'other'; chat._turnTag = 'dtother';
			const end = W.f.watchRetryLease(chat, 'h1-rt', 'phone1', {});
			W.env.LEASE = { turn: 'h1-rt', holder: 'laptop1', mode: 'released', settled: true };
			if (W.beat) W.beat();
			end();
			check('KRh-stop the other turn is not aborted, nor marked stopped by the person',
				!!W.beat && W.aborted.length === 0 && !chat._aborted && chat._stopWhy === undefined,
				JSON.stringify({ beat: !!W.beat, aborted: W.aborted, _aborted: chat._aborted, why: chat._stopWhy }));
			const own = lostChat();
			own._generating = true; own._runMid = 'h1-rt';
			const end2 = W.f.watchRetryLease(own, 'h1-rt', 'phone1', {});
			W.beat(); end2();
			check('KRh-stop its own run is stopped', W.aborted.join() === 'c1' && own._aborted === true, JSON.stringify(W.aborted));
		} else check('KRh-stop the retry path lifted', false);
	}
	{
		console.log('KRh-race: a steer starts between the wake and the lease, then a reload; the row and its Retry stand');
		const W = busyWorld('phone1', {});
		const chat = lostChat();
		W.env.current = chat;
		if (W.f.setCrystalBusy) {
			W.f.setCrystalBusy('d1', true);
			pressRetry(W, chat, chat.messages[1]);
			await settle();
			W.onTake = () => { W.onTake = null; W.f.setCrystalBusy('d1', true); };	// overtaken in the lease take
			W.f.setCrystalBusy('d1', false);
			await settle();
			// The reload: what is left is the record and the lease store.
			const rows = chat.messages.map((m) => m.mid).join();
			const leaseFree = W.settled.join() === 'h1-rt:released';
			check('KRh-race the row and its Retry stand, the lease given back, nothing run', rows === 'h1,nr-h1' && leaseFree
				&& W.steered.length === 0 && W.droppedSteer.length === 0 && (chat._retryWait || []).length === 1,
				JSON.stringify({ rows, taken: W.taken, settled: W.settled, steered: W.steered, waiting: (chat._retryWait || []).length }));
			W.f.setCrystalBusy('d1', false);
			await settle();
			check('KRh-race woken again, it runs once under its -rt id', W.steered.join() === 'phone1:h1-rt'
				&& W.settled.join() === 'h1-rt:released,h1-rt:done,h1-rt:released' && !chat.messages.some((m) => m.mid === 'nr-h1'),
				JSON.stringify({ steered: W.steered, settled: W.settled }));
		} else check('KRh-race the retry path lifted', false);
	}
	for (const [id, how] of [['KRh-hold-failed', 'failed'], ['KRh-hold-ask', 'ask']]) {
		console.log(id + ' (F3): a woken retry keeps the queue\'s holds: ' + (how === 'failed' ? 'the turn it waited behind failed' : 'a Decision is open'));
		const W = busyWorld('phone1', {});
		const chat = lostChat();
		W.env.current = chat;
		if (W.f.setCrystalBusy) {
			W.f.setCrystalBusy('d1', true);
			pressRetry(W, chat, chat.messages[1]);
			await settle();
			if (how === 'ask') W.askOpen = true;
			W.f.setCrystalBusy('d1', false, how === 'failed');
			await settle();
			check(id + ' not run, nothing taken, the row and its Retry stand', W.steered.length === 0 && W.taken.length === 0
				&& chat.messages.some((m) => m.mid === 'nr-h1'),
				JSON.stringify({ steered: W.steered, taken: W.taken, rows: chat.messages.map((m) => m.mid) }));
			check(id + ' said why', W.diags.some((d) => /^retry handed back turn=h1 /.test(d)), JSON.stringify(W.diags.filter((d) => /retry/.test(d))));
		} else check(id + ' the retry path lifted', false);
	}
	{
		console.log('KRh-2: two devices press the Diamond\'s Retry while its turn runs on each; the turn runs once');
		const store = {};
		const A = busyWorld('phone1', store), B = busyWorld('laptop1', store);
		const ca = lostChat(), cb = lostChat();
		A.env.current = ca; B.env.current = cb;
		if (A.f.setCrystalBusy && B.f.setCrystalBusy) {
			A.f.setCrystalBusy('d1', true); B.f.setCrystalBusy('d1', true);
			const pa = pressRetry(A, ca, ca.messages[1]);
			const pb = pressRetry(B, cb, cb.messages[1]);
			await settle();
			const none = A.steered.length + B.steered.length === 0;
			A.f.setCrystalBusy('d1', false); B.f.setCrystalBusy('d1', false);
			await settle();
			const all = A.steered.concat(B.steered);
			check('KRh-2 both pressed, nothing ran while busy', pa.retry && pb.retry && none, JSON.stringify({ pa, pb, all }));
			check('KRh-2 the turn ran once, under one id', all.length === 1 && /:h1-rt$/.test(all[0])
				&& A.droppedSteer.length + B.droppedSteer.length === 0, JSON.stringify({ all, da: A.droppedSteer, db: B.droppedSteer }));
			check('KRh-2 the other stood down on the lease', B.diags.concat(A.diags).some((d) => /retry stand-down turn=h1-rt lease held/.test(d)),
				JSON.stringify(A.diags.concat(B.diags).filter((d) => /retry/.test(d))));
		} else check('KRh-2 the retry path lifted', false);
	}
	{
		// KRh-stale (N1, rc's review of STEER delta 1): device B's "not run" row is stale while device A
		// runs its retry under the -rt lease (A's retraction syncs only at its run's end). B's press
		// stood down on the held lease with only a diag: a dead button for the whole run. The row must
		// redraw at once to "running on A", with no Retry, from the -rt lease. Red on 7e73f10db.
		// Breaks: stalerow | staleredraw.
		console.log('KRh-stale (N1): a stale "not run" Retry pressed on B while A runs the retry');
		const store = { 'h1-rt': 'phone1' };
		const B = busyWorld('laptop1', store);
		const cb = lostChat();
		B.env.current = cb;
		const view = {};		// B's lease view: not yet fresh at the press
		B.env.DaimondLease.holder = (tid) => view[tid] || null;
		B.env.DaimondLease.record = (tid) => (view[tid] ? { holder: view[tid], mode: 'running' } : null);
		const take = B.env.DaimondLease.take;
		B.env.DaimondLease.take = async (tid, rec) => { const r = await take(tid, rec); if (!r.won) view[tid] = r.holder; return r; };
		B.env.DaimondPresence.name = (id) => (id === 'phone1' ? 'Pixel' : '');
		let redraws = 0;
		B.env.renderHistory = () => { redraws++; };
		const p = pressRetry(B, cb, cb.messages[1]);
		await settle();
		const div = el('div');
		let threw = '';
		try { B.f.markInterrupted(div, cb.messages[1]); } catch (err) { threw = String(err); }
		const words = div.children.map((c) => c.children.map((x) => x.textContent).join(' ')).join(' ');
		const retry = buttons(div).some((b) => b.textContent === 'turn.retry');
		check('KRh-stale the press stands down, nothing run, and the row is redrawn at once', p.retry && redraws >= 1
			&& B.steered.length === 0 && B.taken.join() === 'h1-rt', JSON.stringify({ p, redraws, steered: B.steered, taken: B.taken }));
		check('KRh-stale the row draws running on the other device, with no Retry', !threw && !retry
			&& /turn\.peer_running_named/.test(words), JSON.stringify({ words, retry, threw }));
	}
	{
		// KRh-end (D2-1, rc's review of STEER delta 2, probe D2-END): A's retry has ENDED, its -rt lease
		// `done` (still live until its release lands) or settled (the done->released tombstone, vacant),
		// while A's retraction has not reached B. B's row read only a live, unfinished lease as claimed,
		// so it drew "not run" with Retry again: a dead button, the -rt id being single-use until the
		// tombstone drains. Red on 39dd37c5d. Breaks: claimedrow | settledredraw.
		const T = Date.now();
		const rows = {
			done:    { turnId: 'h1-rt', holder: 'phone1', mode: 'done', expiry: T + 60000, deadline: T + 900000, renewedAt: T },
			settled: { turnId: 'h1-rt', holder: 'phone1', mode: 'released', settled: 1, expiry: 0, deadline: T + 900000, renewedAt: T },
		};
		for (const kind of ['done', 'settled']) {
			console.log('KRh-end (' + kind + '): B\'s stale row once A\'s retry has ended');
			const rec = rows[kind];
			const B = busyWorld('laptop1', {});
			const cb = lostChat();
			B.env.current = cb;
			const view = {};
			const L = PW.DaimondLease;
			B.env.DaimondLease = Object.assign({}, B.env.DaimondLease, {
				holder: (tid) => (view[tid] && L.live(view[tid], Date.now()) ? view[tid].holder : null),
				record: (tid) => view[tid] || null, dead: L.dead, authorityNow: () => Date.now(),
				// The real take on this door: a live foreign `done` is held by its holder; a settled
				// tombstone stands down `settled`. Either way it adopts what it read.
				take: async (tid) => { B.taken.push(tid); view[tid] = rec;
					return kind === 'settled' ? { won: false, why: 'settled' } : { won: false, holder: rec.holder }; } });
			B.env.DaimondPresence.name = (id) => (id === 'phone1' ? 'Pixel' : '');
			let redraws = 0, toasts = 0;
			B.env.renderHistory = () => { redraws++; };
			B.env.toast = () => { toasts++; };
			const draw = () => {
				const div = el('div');
				let threw = '';
				try { B.f.markInterrupted(div, cb.messages[1]); } catch (err) { threw = String(err); }
				return { words: div.children.map((c) => c.children.map((x) => x.textContent).join(' ')).join(' '),
					retry: buttons(div).some((b) => b.textContent === 'turn.retry'), threw };
			};
			// The view not yet fresh: the stale Retry is pressed; it stands down and redraws, no toast.
			const p = pressRetry(B, cb, cb.messages[1]);
			await settle();
			check('KRh-end (' + kind + ') a press stands down, nothing run, redrawn at once, no toast', p.retry && redraws >= 1
				&& toasts === 0 && B.steered.length === 0 && B.taken.join() === 'h1-rt',
				JSON.stringify({ p, redraws, toasts, steered: B.steered, taken: B.taken }));
			const d = draw();
			check('KRh-end (' + kind + ') the row draws running on the other device, with no Retry', !d.threw && !d.retry
				&& /turn\.peer_running_named/.test(d.words), JSON.stringify(d));
		}
		{
			// The keep: a vacant, UNSETTLED lease (the busy give-back: released, no `done`) draws Retry,
			// and the press wins and runs it once.
			console.log('KRh-end (vacant): a released-without-done -rt lease still draws a Retry that wins');
			const store = {};
			const B = busyWorld('laptop1', store);
			const cb = lostChat();
			B.env.current = cb;
			const rec = { turnId: 'h1-rt', holder: 'phone1', mode: 'released', expiry: 0, deadline: T + 900000, renewedAt: T };
			const L = PW.DaimondLease;
			B.env.DaimondLease = Object.assign({}, B.env.DaimondLease, {
				holder: () => null, record: (tid) => (tid === 'h1-rt' ? rec : null), dead: L.dead, authorityNow: () => Date.now() });
			const p = pressRetry(B, cb, cb.messages[1]);
			await settle();
			check('KRh-end (vacant) Retry drawn, pressed, it takes the lease and runs once', p.retry
				&& B.taken.join() === 'h1-rt' && B.steered.join() === 'laptop1:h1-rt', JSON.stringify({ p, taken: B.taken, steered: B.steered }));
		}
	}
	{
		// KRh-expire (D2-2): a crashed or sleeping holder stops renewing, and its lease turns vacant at
		// `expiry` as a function of time. Only `leaseWrite` announced a change, so every holder()-drawn
		// view (this row, the composer's Stop, the seat switch, the dispatched footer) stayed on "is
		// doing this" until an unrelated redraw, up to ~15 min. The REAL peer.js, loaded as above with
		// its own clock and timers driven here. Red on 39dd37c5d. Break: expiry.
		console.log('KRh-expire (D2-2): a lease that ages out with no write announces itself');
		const timers = [];
		let clock = Date.now(), tick = 0;
		const realNow = Date.now;
		Date.now = () => clock;
		try {
			const PW2 = { addEventListener() {}, dispatchEvent() { return true; },
				setTimeout: (fn, ms) => { const id = ++tick; timers.push({ id, fn, at: clock + (+ms || 0) }); return id; },
				clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); } };
			const advance = async (to) => {
				for (;;) {
					timers.sort((a, b) => a.at - b.at);
					if (!timers.length || timers[0].at > to) break;
					const x = timers.shift();
					clock = Math.max(clock, x.at);
					x.fn();
					await settle();
				}
				clock = to;
			};
			const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
			const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
				querySelectorAll: () => [], getElementById: () => null };
			for (const rel of ['stamp.js', 'peer.js']) {
				let body = readFileSync(join(HERE, rel), 'utf8');
				if (rel === 'peer.js' && PEER_BREAKS[BREAK]) {
					if (body.indexOf(PEER_BREAKS[BREAK][0]) < 0) { console.log('FAIL — peer.js break text is gone: ' + BREAK); process.exit(1); }
					body = body.replace(PEER_BREAKS[BREAK][0], PEER_BREAKS[BREAK][1]);
				}
				new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
					'with (window) {\n' + body + '\n}')(PW2, doc, quiet,
					{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
			}
			const L = PW2.DaimondLease;
			let door = {}, ver = 1;
			const cas = { read: async () => ({ version: ver, leases: JSON.parse(JSON.stringify(door)) }),
				write: async (v, leases) => { if (v !== ver) return { ok: false, why: 'conflict' }; door = JSON.parse(JSON.stringify(leases)); ver++; return { ok: true }; } };
			let fired = 0;
			L.onChange(() => { fired++; });
			const T0 = clock;
			const took = await L.take('h1-rt', { holder: 'phone1', ts: T0 }, cas);
			await settle();
			const exp = +((L.record('h1-rt') || {}).expiry || 0);
			const firedAtTake = fired;
			// B's row over the REAL view: claimed by phone1 while live.
			const B = busyWorld('laptop1', {});
			const cb = lostChat();
			B.env.current = cb;
			B.env.DaimondLease = Object.assign({}, B.env.DaimondLease, { holder: L.holder, record: L.record, dead: L.dead, authorityNow: L.authorityNow });
			B.env.DaimondPresence.name = (id) => (id === 'phone1' ? 'Pixel' : '');
			const draw = () => { const div = el('div'); B.f.markInterrupted(div, cb.messages[1]);
				return buttons(div).some((b) => b.textContent === 'turn.retry'); };
			const before = draw();
			check('KRh-expire the take won at T0, the row running there, no Retry', took && took.won && exp > T0
				&& L.holder('h1-rt') === 'phone1' && !before, JSON.stringify({ took, exp: exp - T0, before }));
			await advance(exp - 1);
			const early = fired - firedAtTake;
			await advance(exp + 1000);
			check('KRh-expire past expiry with no write: one change announced, no holder', early === 0
				&& fired - firedAtTake === 1 && L.holder('h1-rt') === null,
				JSON.stringify({ early, fired: fired - firedAtTake, holder: L.holder('h1-rt'), timers: timers.map((x) => x.at - T0) }));
			check('KRh-expire the row then draws Retry', draw() === true);
		} finally { Date.now = realNow; }
	}
	{
		// KRh-expire (skew, D3-2, rc's review of STEER delta 3): the view's tick runs on `authorityNow`;
		// a reader on the raw clock, on a device 2 s behind the gateway, still read the lease live at
		// it, so the dispatched footer said "claimed" until the next write. Red on 87594cc4e.
		console.log('KRh-expire (skew): a device 2 s behind the gateway, the footer at the tick');
		const timers = [];
		let clock = Date.now(), tick = 0;
		const realNow = Date.now;
		Date.now = () => clock;
		try {
			const PW3 = { addEventListener() {}, dispatchEvent() { return true; },
				setTimeout: (fn, ms) => { const id = ++tick; timers.push({ id, fn, at: clock + (+ms || 0) }); return id; },
				clearTimeout: (id) => { const i = timers.findIndex((x) => x.id === id); if (i >= 0) timers.splice(i, 1); } };
			const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
			const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
				querySelectorAll: () => [], getElementById: () => null };
			for (const rel of ['stamp.js', 'peer.js']) {
				new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
					'with (window) {\n' + readFileSync(join(HERE, rel), 'utf8') + '\n}')(PW3, doc, quiet,
					{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
			}
			PW3.DaimondPresence.learnRelayNow(clock + 2000);		// the gateway is 2 s ahead of this device
			const L = PW3.DaimondLease;
			let door = {}, ver = 1;
			const cas = { read: async () => ({ version: ver, leases: JSON.parse(JSON.stringify(door)) }),
				write: async (v, leases) => { if (v !== ver) return { ok: false, why: 'conflict' }; door = JSON.parse(JSON.stringify(leases)); ver++; return { ok: true }; } };
			const W = world(null, ['peerUiStateFor', 'leaseClockNow']);
			const states = [];
			const m = { role: 'assistant', interrupted: true, why: 'dispatched', iturn: 'h1-rt', mid: 'ph-h1-rt', dispatchedBy: 'laptop1' };
			Object.assign(W.env, { DaimondLease: L, _openAsk: {}, selfDeviceId: () => 'laptop1' });
			W.env.DaimondPeer.uiState = PW3.DaimondPeer.uiState;
			L.onChange(() => { states.push(W.f.peerUiStateFor(m)); });
			const took = await L.take('h1-rt', { holder: 'phone1', ts: L.authorityNow(), dispatchedBy: 'laptop1' }, cas, L.authorityNow);
			await settle();
			const before = W.f.peerUiStateFor ? W.f.peerUiStateFor(m) : '';
			states.length = 0;
			timers.sort((a, b) => a.at - b.at);
			const x = timers.shift();
			if (x) { clock = x.at; x.fn(); }
			await settle();
			check('KRh-expire (skew) claimed while live; at the tick the footer reads the lease lapsed', took && took.won
				&& before === 'claimed' && states.length === 1 && states[0] !== 'claimed',
				JSON.stringify({ won: took && took.won, before, states, have: W.have.indexOf('peerUiStateFor') >= 0 }));
		} finally { Date.now = realNow; }
	}
	{
		console.log('F1-here: the read did not land, no runner pressed');
		const W = readWorld(null, false, false);
		const chat = { id: 'c1', messages: [], holds: [] };
		const went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'r3');
		await settle();
		check('F1-here runs Here as before, the map unknown, the election logged, no row', went === false
			&& W.lost >= 1 && W.logged === 1 && !chat.messages.some((m) => !!m.notRun),
			'went ' + went + ' lost ' + W.lost + ' logged ' + W.logged);
	}
	// ── F3: withdrawn on loss, and handed back models-behind ──
	function sentChat(tid) {
		return { id: 'c1', holds: [], messages: [
			{ role: 'user', content: PROMPT, mid: tid, iturn: tid },
			{ role: 'assistant', content: '', interrupted: true, why: 'dispatched', iturn: tid, mid: 'ph-' + tid, itext: PROMPT,
				dispatchedBy: 'phone1', toDevice: 'argonaut1', ts: Date.now() },
		] };
	}
	for (const [id, take] of [['W1', 'won'], ['W2', 'lost']]) {
		console.log(id + ': the runner stopped listening, unclaimed; the take is ' + take);
		const W = world('none');
		const chat = sentChat('w1');
		W.env.chats = [chat];
		W.env._dispatchedIx = { w1: 'c1' };
		W.env.TAKE = take;
		W.env.DaimondPresence = { snapshot: () => ({ argonaut1: { listening: false, stated: true, lastSeen: Date.now() } }) };
		if (!W.f.withdrawLostHandoffs) { check(id + ' withdrawLostHandoffs lifted', false); continue; }
		W.f.withdrawLostHandoffs();
		await settle();
		if (id === 'W1') {
			verdict('W1', W, chat, 'w1', PROMPT);
			check('W1 the lease is taken, then settled, before the row', W.taken[0] === 'w1'
				&& W.settled.join() === 'w1:done,w1:released', JSON.stringify({ taken: W.taken, settled: W.settled }));
			check('W1 the placeholder goes', W.dropped === 'w1', String(W.dropped));
		} else {
			const n = chat.messages.filter((m) => !!m.notRun).length;
			check('W2 the runner\'s claim keeps it: no row, nothing run here, nothing settled', n === 0 && W.ran.length === 0
				&& W.settled.length === 0, 'notrun=' + n + ' ran=' + JSON.stringify(W.ran) + ' settled=' + W.settled);
		}
	}
	for (const [id, cause, status] of [['M1', 'models-behind'], ['M0', 'thread'], ['MD', 'models'], ['BZ', '', 'busy']]) {
		console.log(id + ': a hand-back, cause ' + cause);
		const W = world('none');
		const chat = sentChat('m1');
		W.env.chats = [chat];
		W.env.LEASE = { mode: 'released', holder: 'argonaut1', ts: Date.now(), expiry: 0 };	// reclaimed, not settled
		if (W.f.noteHandBack) W.f.noteHandBack({ turnId: 'm1', chatId: 'c1', by: 'argonaut1', status: status || 'undeliverable', cause });
		if (cause) W.env._handBackCause.m1 = cause;
		W.env._handBack.m1 = 'c1';
		await W.f.runDispatchFallback('c1', 'm1');
		await settle();
		// M0 (the thread hand-back) asserted a run here until part 3; it now ends "not run" like M1.
		verdict(id, W, chat, 'm1', PROMPT);
		check(id + ' the lease is settled and the placeholder goes', W.settled.join() === 'm1:done,m1:released' && W.dropped === 'm1',
			JSON.stringify({ settled: W.settled, dropped: W.dropped }));
		if (id === 'BZ') check('BZ no "ran here" line on the prompt', !chat.messages.some((m) => m.seatNote), JSON.stringify(chat.messages[0]));
	}
	// ── K: a runner's refusal before the run hands the lease back released, cut 'refused' (kfix f94184180) ──
	for (const [id, cut] of [['K1', 'refused'], ['K0', '']]) {
		console.log(id + ': a hand-back, the lease released' + (cut ? ', cut ' + cut : ', plain'));
		const W = world('none');
		const chat = sentChat('k1');
		W.env.chats = [chat];
		W.env.LEASE = { mode: 'released', settled: 0, cut, holder: 'argonaut1', ts: Date.now(), expiry: 0 };
		W.env._handBack.k1 = 'c1';
		await W.f.runDispatchFallback('c1', 'k1');
		await settle();
		if (id === 'K1') {
			verdict('K1', W, chat, 'k1', PROMPT);
			check('K1 the lease is settled and the placeholder goes', W.settled.join() === 'k1:done,k1:released' && W.dropped === 'k1',
				JSON.stringify({ settled: W.settled, dropped: W.dropped }));
		} else {
			// K0 asserted a run here until part 3: a runner that let the turn go unrun is not run here.
			verdict('K0', W, chat, 'k1', PROMPT);
		}
	}
	// ── B: the backstop, a runner that never claimed (D-20261009-23); SA: a step-away hand-off (control) ──
	for (const [id, stepAway] of [['B1', false], ['SA', true]]) {
		console.log(id + ': the backstop, nothing claimed' + (stepAway ? ', a step-away hand-off' : ', the switch sent it'));
		const W = world('none');
		const chat = sentChat('b1');
		if (stepAway) chat.messages[1].stepAway = true;
		W.env.chats = [chat];
		W.env.LEASE = null;
		await W.f.runDispatchFallback('c1', 'b1');
		await settle();
		if (id === 'B1') {
			verdict('B1', W, chat, 'b1', PROMPT);
			check('B1 the lease is taken and settled, the placeholder goes', W.taken[0] === 'b1'
				&& W.settled.join() === 'b1:done,b1:released' && W.dropped === 'b1', JSON.stringify({ taken: W.taken, settled: W.settled }));
		} else {
			const n = chat.messages.filter((m) => !!m.notRun).length;
			check('SA a step-away hand-off nobody took still runs here, no row', n === 0 && W.ran.join() === 'recover:b1',
				'notrun=' + n + ' ran=' + JSON.stringify(W.ran));
		}
	}
	// ── RT: recovery-on-return, a turn the switch sent that nobody claimed; RT-SA: a step-away one (control) ──
	for (const [id, stepAway] of [['RT', false], ['RT-SA', true]]) {
		console.log(id + ': recovery on return' + (stepAway ? ', a step-away hand-off' : ', the switch sent it'));
		const W = world('none');
		const chat = sentChat('t1');
		if (stepAway) chat.messages[1].stepAway = true;
		W.env.chats = [chat];
		W.env._dispatchedIx = { t1: 'c1' };
		W.env.LEASE = null;
		if (!W.f.peerCollectOnReturn) { check(id + ' peerCollectOnReturn lifted', false); continue; }
		await W.f.peerCollectOnReturn();
		await settle();
		if (id === 'RT') {
			verdict('RT', W, chat, 't1', PROMPT);
			check('RT the placeholder goes', W.dropped === 't1', String(W.dropped));
		} else {
			check('RT-SA a step-away hand-off nobody took is run here on return', W.ran.join() === 'recover:t1'
				&& !chat.messages.some((m) => !!m.notRun), JSON.stringify(W.ran));
		}
	}
	// ── KRi (STEER-2; rulings §1 l.16, l.19): Continue on a turn where nothing arrived goes through the
	// one entry with the switch drawn at its press. It ran here (`askAgain`), whatever the switch said.
	// The REAL continueTurn → maybeAutoDispatch under the REAL switch: the runner drawn at the press,
	// gone in the hold's read, so the turn ends "not run" and never runs here. KRi-here: a switch
	// drawing Here at the press runs it here. Red on 774c1a4c7. Breaks: contentry | contdrawn.
	const CONT = ['continueTurn', 'continueAsked', 'continueRouted', 'isLostRow'];
	for (const [id, beating, runHere] of [['KRi', true, false], ['KRi-here', false, false], ['KRi-runhere', true, true]]) {
		console.log(id + ': Continue on a turn where nothing arrived, ' + (beating ? 'the runner drawn at the press, gone in the hold\'s read' : 'the switch drawing Here'));
		const W = pressWorld(CONT);
		const e = W.env;
		const chat = { id: 'c1', holds: [], messages: [
			{ role: 'user', content: PROMPT, mid: 'i1', iturn: 'i1' },
			{ role: 'assistant', content: '', interrupted: true, mid: 'i1a', iturn: 'i1', itext: PROMPT }] };
		e.current = chat;
		let holds = 0;
		Object.assign(e, { turnHold: () => (holds++ === 0 ? 'root' : null), handoffTargetLabel: () => '', toast: () => {},
			confirmHold: async () => { W.redraw({}); } });
		check(id + ' the real continueTurn lifted', W.have.indexOf('continueTurn') >= 0, W.have.join());
		W.redraw(beating ? W.BEATING : {});
		const drew = beating ? W.drawsRunner() : W.drawsHere();
		// KRi-runhere: a "Run here" (a blocked or parked turn taken back) is the person choosing this device.
		if (runHere) e.confirmHold = async () => {};
		try { if (runHere) W.f.continueTurn(chat, 'i1', PROMPT, false, undefined, false); else W.f.continueTurn(chat, 'i1', PROMPT); }
		catch (err) { W.ran.push('threw ' + err); }
		await settle();
		if (!runHere) check(id + ' the switch drew ' + (beating ? 'the runner at the press, Here after the read' : 'Here'), drew && W.drawsHere());
		if (beating && !runHere) {
			check(id + ' not run here: the pressed runner is gone', W.ran.length === 0, JSON.stringify(W.ran));
			check(id + ' one "not run" row names the declined runner', chat.messages.filter((m) => !!m.notRun).length === 1
				&& /runner argonaut was pressed and the election declined it/.test((notRunRow(chat) || { notRun: {} }).notRun.why || ''),
				rowsOf(chat));
		} else {
			check(id + ' it runs here, once, with no row, nothing posted', W.ran.join() === 'run:' + PROMPT && noRow(chat) && W.posted === 0,
				JSON.stringify(W.ran) + rowsOf(chat) + ' posted ' + W.posted);
		}
	}
	// ── KRj (STEER-2; rulings §1 l.16, l.17, l.19; §16 the mail-trigger lines): a timer or mail trigger's
	// turn follows where the switch points at that moment. It always ran here (`doSteer`). The REAL
	// steerFromTrigger → triggerHandOff → maybeAutoDispatch under the REAL switch: drawn now, the turn is
	// handed to the runner (a mail turn pending-only); drawn now and gone by the read, it ends "not run";
	// Here, it runs here. KRj-2: two devices whose timers fire together run the turn once, by the
	// firing's claim (one id, one lease), the other standing down as fired. Red on 774c1a4c7.
	// Breaks: trigentry | timerclaim.
	const TRIG = ['steerFromTrigger', 'triggerHandOff', 'steerTriggerHere', 'claimTimerFire', 'timerFireId', 'keepMailClaim',
		'settleMailClaim', 'isNotRunRow'];
	function trigWorld(self, store) {
		const W = drawnWorld(TRIG);
		const e = W.env;
		W.handed = [];
		const f = { id: 'd1', name: 'Life log' };
		const chat = { id: 'c1', diamondId: 'd1', holds: [], messages: [] };
		W.fd = f; W.chat = chat;
		Object.assign(e, { current: chat, diamonds: [f], currentDiamond: f, daimonChat: () => chat, diamondBusy: () => false,
			askOpenIn: () => false, offScreenSteerAllowed: () => true, selectDiamond: async () => {}, _lastSteer: {},
			followVerdicts: async () => [], judgeTriggeredTurn: () => false, selfDeviceId: () => self, syncsHere: () => true,
			_mailRunning: {}, loadChatMessages: async () => {},
			doSteer: (text, x, how) => { W.how = how; W.ran.push(self + ':steer:' + text); return Promise.resolve('ok'); },
			runSteer: (g, text) => { W.ran.push(self + ':runSteer:' + text); return Promise.resolve('ok'); } });
		e.DaimondSync = Object.assign(e.DaimondSync, { heard: () => true, entitled: () => true });
		e.DaimondLease = { RENEW_EVERY_MS: 30000, renew: async () => {}, record: (tid) => (store[tid] ? { holder: store[tid] } : null),
			take: async (tid, rec) => {
				W.taken.push(tid);
				const h = store[tid];
				if (h && h !== rec.holder) return { won: false, why: 'held', holder: h };
				store[tid] = rec.holder; return { won: true };
			} };
		e.DaimondPeer.settleLease = async (what, id, holder, mode) => { W.settled.push(id + ':' + mode); return { ok: true }; };
		return W;
	}
	// The hand-off door, reached: the errand's fields recorded where the plan is built (the real
	// handOffTurn and dispatchToPeer before it). The post is not this arm's.
	const spyHand = (W) => { W.env.DaimondPeer.buildDispatch = (c, o) => {
		W.handed.push({ tid: o.turnId, txt: o.prompt, pendingOnly: o.pendingOnly === true });
		throw new Error('qa: recorded at the hand-off door'); }; };
	for (const [id, kind, at] of [['KRj-timer', 'activity', 'runner'], ['KRj-mail', 'mail', 'runner'], ['KRj-gone', 'activity', 'gone'], ['KRj-here', 'activity', 'here']]) {
		console.log(id + ': a ' + kind + ' trigger fires, the switch drawing ' + (at === 'here' ? 'Here' : 'the runner' + (at === 'gone' ? ', gone by the read' : '')));
		const W = trigWorld('phone1', {});
		check(id + ' the real steerFromTrigger lifted', W.have.indexOf('steerFromTrigger') >= 0, W.have.join());
		if (!W.f.steerFromTrigger) continue;
		spyHand(W);
		W.redraw(at === 'here' ? {} : W.BEATING);
		W.env.DaimondSync.refreshPresence = W.read(at === 'runner' ? W.BEATING : {});
		let out;
		try { out = await W.f.steerFromTrigger(W.fd, 'the timer says', { id: 'ta1', kind, minutes: 30 }); } catch (err) { out = 'threw ' + err; }
		await settle();
		if (kind === 'mail') {
			// STEER-3 N2 (rc's review of STEER delta 1; rulings §16 l.261): Send's door wrote the mail
			// turn's prompt as a user row in the Email Diamond's thread, and handed it to a runner that
			// advertises nothing about running it pending-only. Split: mail stays Here, pending-only.
			check(id + ' writes no user row (nor any row) in the thread (§16)', W.chat.messages.length === 0,
				JSON.stringify(W.chat.messages.map((m) => ({ role: m.role, c: m.content, why: m.why }))));
			check(id + ' no runner elected for mail (none advertises it): runs here once, pending-only',
				W.handed.length === 0 && W.ran.join() === 'phone1:steer:the timer says' && !!W.how && W.how.pendingOnly === true,
				JSON.stringify({ handed: W.handed, ran: W.ran, how: W.how }));
		} else if (at === 'runner') {
			check(id + ' handed to the runner, once, not run here', W.handed.length === 1 && W.ran.length === 0 && out && out.went === true,
				JSON.stringify({ handed: W.handed, ran: W.ran, out }));
			check(id + ' not pending-only', !!W.handed[0] && W.handed[0].pendingOnly === false, JSON.stringify(W.handed));
		} else if (at === 'gone') {
			check(id + ' not run here, nothing handed', W.ran.length === 0 && W.handed.length === 0, JSON.stringify({ handed: W.handed, ran: W.ran }));
			check(id + ' one "not run" row names the declined runner, the firing counted as gone and failed',
				W.chat.messages.filter((m) => !!m.notRun).length === 1 && out && out.went === true && out.failed === true
				&& /runner argonaut was pressed and the election declined it/.test((notRunRow(W.chat) || { notRun: {} }).notRun.why || ''),
				rowsOf(W.chat) + JSON.stringify(out));
		} else {
			check(id + ' runs here, once, nothing handed', W.ran.join() === 'phone1:steer:the timer says' && W.handed.length === 0,
				JSON.stringify({ handed: W.handed, ran: W.ran }));
		}
	}
	for (const [id, at] of [['KRj-2', 'here'], ['KRj-2r', 'runner']]) {
		console.log(id + ': two devices\' timers fire together, the switch drawing ' + (at === 'here' ? 'Here' : 'the runner') + ' on each');
		const store = {};
		const A = trigWorld('phone1', store), B = trigWorld('laptop1', store);
		if (!A.f.steerFromTrigger) { check(id + ' lifted', false); continue; }
		for (const W of [A, B]) {
			spyHand(W);
			W.redraw(at === 'here' ? {} : W.BEATING);
			W.env.DaimondSync.refreshPresence = W.read(at === 'here' ? {} : W.BEATING);
		}
		const ta = { id: 'ta1', kind: 'activity', minutes: 30 };
		const [oa, ob] = await Promise.all([A.f.steerFromTrigger(A.fd, 'the timer says', ta), B.f.steerFromTrigger(B.fd, 'the timer says', ta)]);
		await settle();
		const runs = A.ran.concat(B.ran), hands = A.handed.concat(B.handed);
		check(id + ' the turn runs once', (at === 'here' ? runs.length === 1 && hands.length === 0 : hands.length === 1 && runs.length === 0),
			JSON.stringify({ runs, hands }));
		check(id + ' one firing went, the other stood down as fired (its stopwatch restarts)',
			[oa, ob].filter((o) => o && o.went).length === 1 && [oa, ob].filter((o) => o && o.elsewhere).length === 1, JSON.stringify([oa, ob]));
		check(id + ' one id, one lease: both claimed the same firing', A.taken.length === 1 && B.taken.length === 1 && A.taken[0] === B.taken[0]
			&& /^timer:d1:ta1:/.test(A.taken[0]), JSON.stringify({ a: A.taken, b: B.taken }));
	}
	// ── RF: a Kimberlite refusal before the run (RUN-HIST E) ──
	const KEYWHY = 'argonaut has no model key for this turn: qa';
	for (const [id, status, cause, lease] of [
		['RF', 'undeliverable', 'refused', { mode: 'released', settled: 0, cut: 'refused' }],
		['RF-err', 'error', '', { mode: 'released', settled: 1, cut: '' }],
		['RF-D', 'undeliverable', 'refused', { mode: 'released', settled: 0, cut: 'refused' }]]) {
		console.log(id + ': a runner report ' + status + (cause ? ' cause ' + cause : '') + ', the lease ' + JSON.stringify(lease));
		// RF-D: the same refusal for a Diamond's turn, which the one writer tags `notrun`. Its Retry
		// goes STEER's real Diamond path (`retryDiamond`: the switch, drawing plain Here, then the
		// claim, its `-rt` lease and `askAgain` → `runSteer`), so the D3 names are lifted for it.
		const W = id === 'RF-D' ? busyWorld('phone1', {}) : world('none');
		const chat = sentChat('f1');
		if (id === 'RF-D') chat.diamondId = 'd1';
		W.env.chats = [chat];
		W.env.LEASE = Object.assign({ holder: 'argonaut1', ts: Date.now(), expiry: 0 }, lease);
		// The report as the runner posts it, collected here (`onReport`), and the decision read from
		// the real report store (`dispatchedTurnSettled`), not a stub.
		const report = { t: 'report', eid: 'e-f1', turnId: 'f1', chatId: 'c1', status, cause, why: KEYWHY,
			by: 'argonaut1', to: 'phone1' };
		W.env.peerReports = { f1: report };
		if (W.f.dispatchedTurnSettled) W.env.dispatchedTurnFinished = (c, tid) => W.f.dispatchedTurnSettled({ turnId: tid, chatId: c.id });
		const foot = RP.uiState(chat.messages[1], W.env.LEASE, report, 'phone1', Date.now());
		if (status === 'undeliverable') {
			W.f.noteHandBack(report);
			W.env._handBackCause.f1 = cause;
			W.env._handBack.f1 = 'c1';
		}
		await W.f.runDispatchFallback('c1', 'f1');	// the hand-back's decision, or the backstop's
		await settle();
		if (id === 'RF-err') {
			const n = chat.messages.filter((m) => !!m.interrupted && (!!m.notRun || m.why === 'notrun')).length;
			check('RF-err a failure mid-run stays terminal: footer failed, no row, nothing run here',
				foot === 'failed' && n === 0 && W.ran.length === 0, 'foot=' + foot + ' notrun=' + n + ' ran=' + JSON.stringify(W.ran));
			continue;
		}
		check(id + ' the footer is never failed (no [Run here] past the switch)', foot !== 'failed', foot);
		const row = chat.messages.find((m) => !!m.interrupted && (!!m.notRun || m.why === 'notrun'));
		check(id + ' the row keeps the refusal and the runner\'s words', !!row && !!row.notRun
			&& /refused it before the run/.test(row.notRun.why) && row.notRun.why.indexOf(KEYWHY) >= 0,
			JSON.stringify(row ? row.notRun : null));
		if (id === 'RF-D') check('RF-D a Diamond\'s refused turn is tagged notrun', !!row && row.why === 'notrun',
			row ? row.why : 'no row');
		if (id === 'RF-D') {
			const p = verdict(id, W, chat, 'f1', PROMPT, true);	// presses Retry, last
			await settle();
			check(id + ' U4 its Retry asks the turn again, once, here, under its -rt id and lease', !!p && p.retry
				&& W.steered.join() === 'phone1:f1-rt' && W.droppedSteer.length === 0 && W.routed.length === 0 && W.ran.length === 0
				&& W.taken.filter((t) => /-rt$/.test(t)).join() === 'f1-rt', JSON.stringify({ p, steered: W.steered, routed: W.routed, ran: W.ran, taken: W.taken }));
			check(id + ' the lease is settled, the placeholder goes, and the retry\'s -rt lease settled after its run',
				W.settled.join() === 'f1:done,f1:released,f1-rt:done,f1-rt:released' && W.dropped === 'f1',
				JSON.stringify({ settled: W.settled, dropped: W.dropped }));
			continue;
		}
		verdict(id, W, chat, 'f1', PROMPT);	// presses Retry, last
		check(id + ' the lease is settled and the placeholder goes', W.settled.join() === 'f1:done,f1:released' && W.dropped === 'f1',
			JSON.stringify({ settled: W.settled, dropped: W.dropped }));
	}
	{
		console.log('P1: a person\'s pause at the door is said as before');
		const W = world('paused');
		const chat = { id: 'c1', messages: [], holds: [] };
		await W.f.maybeAutoDispatch(chat, PROMPT, '', 'u9');
		await settle();
		const rows = chat.messages.filter((m) => m.iturn === 'u9' && m.role !== 'user');
		check('P1 said in the pause\'s words, nothing run, no "not run" row', W.ran.length === 0
			&& rows.length === 1 && rows[0].role === 'note_log' && /Paused/.test(rows[0].content), JSON.stringify(rows));
	}
	console.log((failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks + ' checks');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL — threw: ' + (e && e.stack || e)); process.exit(1); });
