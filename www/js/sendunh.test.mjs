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
   unknown. F1-ctl (the probe's control): a read that lands and finds the
   runner gone still runs Here naming it. F1-here: nothing pressed, so a
   missed read runs Here as before, with the map unknown and the log.

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
   Breaks: --break entry | draw | lost | settled | readmiss | unknown |
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
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const BREAK = (process.argv.indexOf('--break') >= 0) ? process.argv[process.argv.indexOf('--break') + 1] : '';
const BREAKS = {
	entry: ['if (!r.ok && !st.marked) answerUnhanded(chat, turnId, promptText, r);', ''],
	draw:  ["if (m.why === 'notrun') {", "if (false) {"],
	lost:  ['retryTurn(current, m.iturn, notRunAsk(current, m), { lost: true })', 'retryTurn(current, m.iturn, notRunAsk(current, m))'],
	settled: ['if (_handBack[tid] != null && DaimondPeer.settledLease', 'if (false && DaimondPeer.settledLease'],
	readmiss: ['if (!pressed || turnHold(chat)) return false;', 'return false;'],
	unknown:  ['try { if (window.DaimondPresence && DaimondPresence.lost) DaimondPresence.lost(); }', 'try { }'],
	// Since part 3 every path below ends "not run" anyway, so a break runs the turn here first (U1 red).
	withdraw: ["var notRun = (opts && opts.notRun) ? String(opts.notRun)", "var notRun = (opts && opts.notRun) ? (await recoverOneLocally(chat, m), 'x') && String(opts.notRun)"],
	cutref:   ["String(lease.cut || '') === 'refused') ? 'the runner", "String(lease.cut || '') === 'refused') ? (await recoverOneLocally(chat, m), 'x') && 'the runner"],
	refused:  ["try { endHandOffNotRun(chat, ph, 'refused after the mark: ' + why); }", 'try { recoverOneLocally(chat, ph); }'],
	behind:   ["=== 'models-behind' ? 'handed back", "=== 'models-behind' ? (await recoverOneLocally(chat, m), 'x') && 'handed back"],
	backstop: ['await endHandOffNotRun(chat, m, cause ?', 'await recoverOneLocally(chat, m, cause ?'],
	busy:     ['if (m.busyBy) { await endHandOffNotRun(chat, m,', 'if (m.busyBy) { await recoverOneLocally(chat, m,'],
	thread:   ["if (m.threadBy || cause === 'thread') { await endHandOffNotRun(chat, m,", "if (m.threadBy || cause === 'thread') { await recoverOneLocally(chat, m,"],
	models:   ["if (cause === 'models') { await endHandOffNotRun(chat, m,", "if (cause === 'models') { await recoverOneLocally(chat, m,"],
	onreturn: ['else await endHandOffNotRun(jobs[k].chat, jobs[k].m,', 'else await recoverOneLocally(jobs[k].chat, jobs[k].m,'],
	stepaway: ['if (m.stepAway) { await recoverOneLocally(chat, m); return; }', ''],
};
if (BREAK) {
	const b = BREAKS[BREAK];
	if (!b || SRC.indexOf(b[0]) < 0) { console.log('FAIL — unknown break or its text is gone: ' + BREAK); process.exit(1); }
	SRC = SRC.replace(b[0], b[1]);
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
	return SRC.slice(a, SRC.indexOf('\n\t}\n', a) + 3);
}

const NAMES = ['runDispatchFallback', 'electProvider', 'dispatchedAnswerPresent', 'maybeAutoDispatch', 'handOffTurn', 'dispatchToPeer', 'answerUnhanded', 'sayIfUnhanded',
	'reRunParked', 'markInterrupted', 'notRunAsk', 'retryTurn', 'lostRetryMid', 'turnMessagesOf',
	'sendPresenceRead', 'endHandOffNotRun', 'withdrawLostHandoffs', 'noteHandBack', 'peerCollectOnReturn'];

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
	const e = { tag, children: [], handlers: {}, textContent: '', className: '',
		classList: { add() {} },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(k, f) { this.handlers[k] = f; } };
	return e;
}
function buttons(e, out = []) { if (e.tag === 'button') out.push(e); e.children.forEach((c) => buttons(c, out)); return out; }

// fault: 'unable' | 'transport' | 'build' | 'throw' | 'paused'
function world(fault) {
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
		runErrand: () => {},
		sealFittingErrand: async (c, o, plan) => ({ body: { envelope: 'sealed' }, plan, seedDropped: false }),
		withdrawOnLoss: RP.withdrawOnLoss, triedAfterHandBack: RP.triedAfterHandBack, standDownUndecided: RP.standDownUndecided,
		syncCas: () => ({}),
		settleLease: async (what, id, holder, mode) => { W.settled.push(id + ':' + mode); return { ok: true }; },
	};
	const env = {
		window: null, Date, String, Object, Array, JSON, Math, Promise, setTimeout, Error,
		diag: (a, b) => W.diags.push(a + ' ' + b),
		t: (k) => k, document: { createElement: el },
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
		_seatShownRunner: {}, _seatDropped: {}, renderSeatSwitch: () => {},
		giveUpSent: () => {}, newMid: (() => { let n = 0; return () => 'm' + (++n); })(),
		_handoffStart: {}, _electionTrace: {}, deviceLabelFor: () => 'argonaut', dsEvent: () => {},
		commitRatings: () => {}, ownsChat: () => false, appendUserMessage: () => {},
		pushUserRecord: (c, m) => { c.messages.push(m); },
		touchMsg: (m) => { m._touched = (m._touched | 0) + 1; return m; },
		touchChat: () => {}, persistChats: () => {}, renderHistory: () => {},
		scheduleDispatchFallback: () => {}, PRESUMED_FALLBACK_MS: 5000, electedTried: () => ['argonaut1'],
		turnEffortOf: () => null, storedPre: () => { if (fault === 'throw') throw new Error('qa: a throw before the mark'); return ''; },
		storedEffort: () => null, errandModelOf: () => ({}), errandFence: async () => null, autonomousPosture: () => false, msgTombsOwed: () => [],
		loadChatMessages: async () => {}, friendlyError: (e) => String(e && e.message),
		seatSwitchFor: () => ({ runner: { deviceId: 'argonaut1' } }),
		peerReports: {}, placeholderParkCount: () => 0,
		// A run here, in silence, is what must never happen.
		continueTurn: (c, tid) => { W.ran.push('continue:' + tid); },
		runTurn: (c, txt) => { W.ran.push('run:' + txt); },
		// The retry door, recorded where it hands on to the switch.
		retryRouted: (c, text, nmid, lost) => { W.routed.push({ text, nmid, lost: !!lost }); return true; },
		loadMsgTombs: () => ({}), msgTombstone: () => {}, sessionCut: () => {}, ChatStore: { compact: () => {} },
		leaseClockNow: () => Date.now(),
		// The backstop's world: one chat, a lease the test sets, a hand-back held or not.
		chats: [], _handBack: {}, _handBackCause: {}, _fallbackInFlight: {}, _localRecovering: {}, _localEnding: {}, LEASE: null,
		DaimondLease: { record: () => env.LEASE, snapshot: () => (env.LEASE ? { [env.LEASE.turn || '']: env.LEASE } : {}),
			take: async (tid) => { W.taken.push(tid); return env.TAKE === 'won' ? { won: true } : { won: false, why: 'held', holder: 'argonaut1' }; } },
		dispatchedChat: () => env.chats[0] || null, dispatchedTurnFinished: () => !!(env.LEASE && RP.settledLease(env.LEASE)),
		recoverOneLocally: (c, m) => { W.ran.push('recover:' + m.iturn); },
		_recovering: false, releaseOwnStaleLeases: async () => {},
		dropDispatchedPlaceholder: (tid) => { W.dropped = tid; const c = env.chats[0];
			c.messages = c.messages.filter((x) => !(x.why === 'dispatched' && x.iturn === tid)); },
		current: null,
	};
	env.window = env;
	const have = NAMES.map((n) => [n, lift(n)]).filter((x) => x[1]);
	W.have = have.map((x) => x[0]);
	const body = have.map((x) => x[1]).join('\n') + '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
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

function verdict(name, W, chat, tid, prompt) {
	const rows = chat.messages.filter((m) => m && String(m.iturn || '') === tid && m.role !== 'user');
	const errs = rows.filter((m) => m.role === 'error_log');
	const notrun = rows.filter((m) => m.why === 'notrun');
	check(name + ' U1 not run here in silence', W.ran.length === 0, JSON.stringify(W.ran));
	check(name + ' U2 no Retry-less error line', errs.length === 0, JSON.stringify(errs.map((m) => m.content)));
	check(name + ' U3 one durable "not run" row on the turn', notrun.length === 1
		&& notrun[0].interrupted === true && notrun[0].role === 'assistant' && notrun[0]._touched > 0,
		JSON.stringify(rows));
	if (!notrun.length) { check(name + ' U4 its Retry asks the turn again through retryTurn', false, 'no row'); return; }
	const p = pressRetry(W, chat, notrun[0]);
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
			const n = chat.messages.filter((m) => m.why === 'notrun' && m.iturn === 'u1').length;
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
			const n = chat.messages.filter((m) => m.why === 'notrun').length;
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
	function readWorld(lands, shown, here) {
		const W = world('none');
		const e = W.env;
		e.setTimeout = (fn, ms) => setTimeout(fn, ms === 2000 ? 0 : ms);	// the 2 s cap, at once
		e.DaimondSync = { push: () => {}, presenceDerived: () => true,
			refreshPresence: () => lands ? Promise.resolve({ presence: lands, derived: true }) : new Promise(() => {}) };
		e.DaimondPresence = { snapshot: () => lands || {}, lost: () => { W.lost++; } };
		e._seatShownRunner = shown ? { c1: 'Chrome on argonaut' } : {};
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
		console.log('F1-ctl: the read lands, the runner is gone (rc\'s control)');
		const W = readWorld({ argonaut1: { listening: false } }, true, false);
		W.env.DaimondPeer.autoDispatchDecision = () => ({ dispatch: false, reason: 'local' });
		const chat = { id: 'c1', messages: [], holds: [] };
		const went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'r2');
		await settle();
		check('F1-ctl runs Here naming the runner, the election logged', went === false
			&& W.env._seatDropped.c1 === 'Chrome on argonaut' && W.logged === 1,
			'went ' + went + ' dropped ' + JSON.stringify(W.env._seatDropped) + ' logged ' + W.logged);
	}
	{
		console.log('F1-here: the read did not land, no runner pressed');
		const W = readWorld(null, false, false);
		const chat = { id: 'c1', messages: [], holds: [] };
		const went = await W.f.maybeAutoDispatch(chat, PROMPT, '', 'r3');
		await settle();
		check('F1-here runs Here as before, the map unknown, the election logged, no row', went === false
			&& W.lost >= 1 && W.logged === 1 && !chat.messages.some((m) => m.why === 'notrun'),
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
			const n = chat.messages.filter((m) => m.why === 'notrun').length;
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
			const n = chat.messages.filter((m) => m.why === 'notrun').length;
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
				&& !chat.messages.some((m) => m.why === 'notrun'), JSON.stringify(W.ran));
		}
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
