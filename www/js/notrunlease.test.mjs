/* ============================================================
   notrunlease.test.mjs -- a turn's lease taken to END it "not run" never reads as a run
   (SUHT-I9, rig law I9, seed dispatchfail).

   THE BUG (s14suht, fire/suht 67380337e). The dispatch post failed with a 500 and the
   iPhone ended the turn "not run" (`endHandOffNotRun`). It first takes the turn's lease
   as itself, on purpose, so the errand still in the box can never run late on the
   runner; but every "who is on it" reader names the lease holder as the device RUNNING
   the turn. For about 3.5 s the iPhone's tile read "iphone is picking this up." with
   Stop showing, and any device that read the lease through sync could say the same.

   The fix: the take says WHY it is held (`intent: 'end'`, carried on the record as
   `ending: 1` through every later write), and every runner reader -- `DaimondLease.holder`,
   `heldBy`, `uiState`, the asker's own frame before its claim lands -- names a runner
   only for a lease taken to run. The lease still arbitrates exactly as before.

     A1-A6  peer.js: an ending take is a live claim no runner can beat, and names no runner
     B1-B4  peer.js on another device: the synced record names no runner, claimed or settled
     D1-D6  daimond.js (lifted): the asker's runner, tile state, footer and Stop, in every
            frame of `endHandOffNotRun`, and on the other device
     W1-W2  daimond.js (lifted): the withdraw route (`runDispatchFallback` notRun), the same
     L1-L7  I9-LOWS (rc review, 2026-10-22): an ending lease that expired unsettled reads
            failed (LOW-1); this device's own live run lease does not outrank its own end
            (LOW-2, peer.js and daimond.js); words cannot be said into an ending lease (LOW-4)
     M      SYNCREAD-R2 MED-1: a retake to end over this device's own live run claim writes
            `ending` into the door's record, at a frozen, stepped-back or advancing clock

   Run: node www/js/notrunlease.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
const J = JSON.stringify;

// One device's peer.js, loaded as the page loads it: its own lease view.
function loadPeer() {
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
	return win;
}

// The synced lease door both devices read.
function makeDoor() {
	let version = 1, leases = {};
	return {
		read: async () => ({ version, leases: JSON.parse(J(leases)) }),
		write: async (base, next) => {
			if (base !== version) return { ok: false };
			version += 1; leases = JSON.parse(J(next));
			return { ok: true, version };
		},
		peek: () => JSON.parse(J(leases)),
	};
}

const NOW = Date.now();
const clock = () => NOW;
const PHONE = 'PHONE', DESK = 'DESK', TID = 't-i9';
const RUNNER = { claimed: 1, running: 1, blocked: 1, 'awaiting-consent': 1 };
const turn = () => ({ role: 'assistant', why: 'dispatched', iturn: TID, itext: 'go', ts: NOW - 4000,
	toDevice: DESK, toName: 'argonaut', dispatchedBy: PHONE });

console.log('notrunlease: a lease taken to end a turn never reads as a run\n');

// ── A: peer.js on the asker ──
{
	const ph = loadPeer(), door = makeDoor();
	const took = await ph.DaimondLease.take(TID, { holder: PHONE, ts: NOW, intent: 'end' }, door, clock);
	const rec = ph.DaimondLease.record(TID);
	check('A1 an ending take wins the door', !!(took && took.won), J(took));
	check('A2   and its record says it is held to end the turn', !!(rec && rec.ending), J(rec));
	check('A3   the holder of the turn (its runner) is nobody', ph.DaimondLease.holder(TID, NOW) === null, ph.DaimondLease.holder(TID, NOW));
	check('A4   the asker is not running a turn for anybody', ph.DaimondLease.heldBy(PHONE, NOW) === false);
	const s = ph.DaimondPeer.uiState(turn(), rec, null, PHONE, NOW, null, false);
	check('A5   the tile reads ending, never a runner\'s state', s === 'ending', s);
	// It still arbitrates: the runner that would run the errand late loses to it.
	const dk = loadPeer();
	const late = await dk.DaimondLease.take(TID, { holder: DESK, ts: NOW }, door, clock);
	check('A6 the runner\'s late take loses to the ending claim', !!late && !late.won, J(late));
	// Control: a take to run it is a runner.
	const c = loadPeer(), d2 = makeDoor();
	await c.DaimondLease.take(TID, { holder: PHONE, ts: NOW }, d2, clock);
	check('[ctl] a take to run names its holder as the runner', c.DaimondLease.holder(TID, NOW) === PHONE);
	check('[ctl]   and reads claimed', c.DaimondPeer.uiState(turn(), c.DaimondLease.record(TID), null, PHONE, NOW, null, false) === 'claimed');
}

// ── B: another device reading the synced lease ──
{
	const ph = loadPeer(), dk = loadPeer(), door = makeDoor();
	await ph.DaimondLease.take(TID, { holder: PHONE, ts: NOW, intent: 'end' }, door, clock);
	dk.DaimondLease.adopt(door.peek(), clock);
	const r1 = dk.DaimondLease.record(TID);
	check('B1 synced, the ending claim names no runner', dk.DaimondLease.holder(TID, NOW) === null, dk.DaimondLease.holder(TID, NOW));
	const s1 = dk.DaimondPeer.uiState(turn(), r1, null, DESK, NOW, null, false);
	check('B2   and the tile there reads ending', s1 === 'ending', s1);
	await ph.DaimondPeer.settleLease('turn', TID, PHONE, 'done', door, clock);
	dk.DaimondLease.adopt(door.peek(), clock);
	const r2 = dk.DaimondLease.record(TID);
	check('B3 settled done, the record still says it was ended', !!(r2 && r2.ending), J(r2));
	await ph.DaimondPeer.settleLease('turn', TID, PHONE, 'released', door, clock);
	dk.DaimondLease.adopt(door.peek(), clock);
	const r3 = dk.DaimondLease.record(TID);
	const s3 = dk.DaimondPeer.uiState(turn(), r3, null, DESK, NOW, null, false);
	check('B4 released, it reads ending, not done (nothing ran)', s3 === 'ending' && !!r3.ending, J([s3, r3]));
}

// ── D: daimond.js, lifted: every frame of endHandOffNotRun ──
function fakeDoc() {
	const el = (tag) => ({ tag, className: '', textContent: '', innerHTML: '', children: [],
		appendChild(c) { this.children.push(c); return c; }, addEventListener() {} });
	return { createElement: el };
}
function footText(f) {
	const out = [];
	const walk = (n) => { if (n.textContent) out.push((n.tag === 'button' ? 'BUTTON:' : '') + n.textContent); (n.children || []).forEach(walk); };
	walk(f);
	return out.join(' | ');
}
function device(peerWin, self, extra) {
	const w = makeWindow({ now: NOW });
	w.document = fakeDoc();
	w.DaimondLease = peerWin.DaimondLease;
	w.DaimondPeer = Object.assign({}, peerWin.DaimondPeer, extra || {});
	const names = { [PHONE]: 'iphone', [DESK]: 'argonaut' };
	const stub = Object.assign({
		selfDeviceId: () => self, leaseClockNow: clock, peerSyncShim: () => ({}),
		claimTurnHere: async () => ({ release() {} }), diag: () => {},
		dropDispatchedPlaceholder: () => {}, clearDispatchFallback: () => {}, redrawRunner: () => {},
		scheduleDispatchFallback: () => {}, UNDECIDED_RECOLLECT_MS: 1,
		peerReports: {}, _openAsk: {}, _peerStopping: {}, lostRetryMid: (x) => 'r-' + x,
		runnerLabel: (id) => names[id] || '', deviceLabelFor: (id) => names[id] || '',
		handoffTargetLabel: () => 'argonaut', interruptedRunner: () => null, pausedBack: () => '',
		renderBlockerFooter: () => {}, consentActPhrase: () => '', retryTurn() {}, reRunParked() {},
		continueTurn() {}, answerAgain() {}, drainAfterHeld() {}, current: null, ms: null,	// `ms`: a local name the lifter takes for a declaration
		t: (k, o) => k + (o ? J(o) : ''),
	}, extra && extra.stub);
	return loadPage({ window: w, want: ['endHandOffNotRun', 'turnRunnerId', 'peerUiStateFor', 'peerHeldTurnOf',
		'renderDispatchedFooter', 'handoffLive'].concat((extra && extra.names) || []), stub: stub });
}
try {
	const phW = loadPeer(), dkW = loadPeer(), door = makeDoor();
	const m = turn();
	const chat = { id: 'c-i9', messages: [{ role: 'user', content: 'go', iturn: TID }, m] };
	const frames = [];
	let A = null, D = null;
	const look = (where) => {
		dkW.DaimondLease.adopt(door.peek(), clock);
		const foot = { tag: 'div', children: [], appendChild(c) { this.children.push(c); return c; } };
		A.renderDispatchedFooter(foot, m);
		const dfoot = { tag: 'div', children: [], appendChild(c) { this.children.push(c); return c; } };
		D.renderDispatchedFooter(dfoot, m);
		frames.push({ where, runner: A.turnRunnerId(TID), st: A.peerUiStateFor(m), held: !!A.peerHeldTurnOf(chat),
			foot: footText(foot), dRunner: D.turnRunnerId(TID), dSt: D.peerUiStateFor(m), dFoot: footText(dfoot) });
	};
	let takeOpts = null;
	A = device(phW, PHONE, {
		syncCas: () => door,
		stub: {
			answerUnhanded: (ch, tid) => { look('before the row'); ch.messages.push({ role: 'assistant', interrupted: true, why: 'runner', notRun: { why: 'w' }, iturn: tid }); },
		},
	});
	// The take itself is watched: the frame before it starts and the one after it lands.
	const realTake = phW.DaimondLease.take;
	phW.DaimondLease.take = async (tid, o, cas, now) => {
		takeOpts = o; look('before the take');
		const r = await realTake(tid, o, cas, now); look('after the take'); return r;
	};
	D = device(dkW, DESK, { stub: { answerUnhanded: () => {} } });
	await A.endHandOffNotRun(chat, m, 'refused');
	phW.DaimondLease.take = realTake;
	check('D1 the ending take says it is held to end the turn', !!(takeOpts && takeOpts.intent === 'end'), J(takeOpts));
	check('D2 the not-run row was written', chat.messages.some((x) => !!x.notRun));
	const bad = (f) => f.runner === PHONE || RUNNER[f.st] || /peer_claimed|peer_running|iphone/.test(f.foot);
	const badA = frames.filter(bad);
	check('D3 no frame on the asker names it as the runner (switch, tile state, footer)', frames.length >= 3 && !badA.length, J(badA.length ? badA : frames));
	const stop = frames.filter((f) => f.held);
	check('D4 no frame on the asker holds the chat for Stop', frames.length >= 3 && !stop.length, J(stop));
	const badD = frames.filter((f) => f.dRunner === PHONE || RUNNER[f.dSt] || /peer_claimed|peer_running|iphone/.test(f.dFoot));
	check('D5 no frame on the other device names the asker as the runner', frames.length >= 3 && !badD.length, J(badD.length ? badD : frames));
	check('D6 the ended tile is no longer a live hand-off', A.handoffLive('ending') === false);
} catch (e) { check('D the ending frames lift from daimond.js', false, String(e && e.stack || e)); }

// W the withdraw route (SEND-UNHANDED part 2, diag-suhtreds): a runner withdrawn on loss
// ends through the same door, by `runDispatchFallback(..., { notRun })`.
try {
	const phW = loadPeer(), door = makeDoor();
	const m = turn();
	const chat = { id: 'c-w', messages: [{ role: 'user', content: 'go', iturn: TID }, m] };
	const frames = [];
	let A = null, takeOpts = null;
	const look = () => frames.push({ runner: A.turnRunnerId(TID), st: A.peerUiStateFor(m), held: !!A.peerHeldTurnOf(chat) });
	A = device(phW, PHONE, {
		syncCas: () => door,
		names: ['runDispatchFallback', 'leaseDoorRead'],
		stub: {
			chats: [chat], dispatchedChat: () => chat, dispatchedTurnFinished: () => false,
			dispatchedAnswerPresent: () => false, recoverOneLocally: () => { frames.push({ ranHere: 1 }); },
			answerUnhanded: (ch, tid) => { look(); ch.messages.push({ role: 'assistant', interrupted: true, why: 'runner', notRun: { why: 'w' }, iturn: tid }); },
		},
	});
	const realTake = phW.DaimondLease.take;
	phW.DaimondLease.take = async (tid, o, cas, now) => { takeOpts = o; look(); const r = await realTake(tid, o, cas, now); look(); return r; };
	await A.runDispatchFallback(chat.id, TID, { notRun: 'withdrawn: runner stopped listening, unclaimed' });
	phW.DaimondLease.take = realTake;
	check('W1 a withdrawn hand-off ends not run through the ending take', !!(takeOpts && takeOpts.intent === 'end')
		&& chat.messages.some((x) => !!x.notRun), J([takeOpts, chat.messages.map((x) => x.why || x.role)]));
	const bad = frames.filter((f) => f.ranHere || f.runner === PHONE || RUNNER[f.st] || f.held);
	check('W2   and no frame names the asker as the runner or holds it for Stop', frames.length >= 3 && !bad.length, J(frames));
} catch (e) { check('W the withdraw route lifts from daimond.js', false, String(e && e.stack || e)); }

// ── L: I9-LOWS ──
{
	// LOW-1: the asker's tab died between the ending take and its settle. The claim drains
	// at its deadline; past it the end never finished, so the tile reads failed, [Run here].
	const ph = loadPeer(), door = makeDoor();
	await ph.DaimondLease.take(TID, { holder: PHONE, ts: NOW, intent: 'end' }, door, clock);
	const rec = ph.DaimondLease.record(TID);
	const late = Number(rec.expiry) + 1;
	const s1 = ph.DaimondPeer.uiState(turn(), rec, null, PHONE, late, null, false);
	check('L1 an ending lease past its deadline, unsettled, reads failed, not ending', s1 === 'failed', J([s1, rec]));
	const s2 = ph.DaimondPeer.uiState(turn(), rec, null, PHONE, NOW, null, false);
	check('L2   while it is live it still reads ending', s2 === 'ending', s2);
	await ph.DaimondPeer.settleLease('turn', TID, PHONE, 'done', door, clock);
	await ph.DaimondPeer.settleLease('turn', TID, PHONE, 'released', door, clock);
	const rs = ph.DaimondLease.record(TID);
	const s3 = ph.DaimondPeer.uiState(turn(), rs, null, PHONE, Number(rs.expiry || 0) + 3600000, null, false);
	check('L3   and settled, it reads ending however late', s3 === 'ending', J([s3, rs]));
}
{
	// LOW-2 in peer.js: this device's own live run claim (a reload left it) and its own end.
	const ph = loadPeer(), door = makeDoor();
	await ph.DaimondLease.take(TID, { holder: PHONE, ts: NOW }, door, clock);
	const own = ph.DaimondLease.record(TID);
	const s1 = ph.DaimondPeer.uiState(turn(), own, null, PHONE, NOW, null, 'end');
	check('L4 ending it here over its own live run claim reads ending, not claimed', s1 === 'ending', J([s1, own]));
	const dk = loadPeer(), d2 = makeDoor();
	await dk.DaimondLease.take(TID, { holder: DESK, ts: NOW }, d2, clock);
	const s2 = ph.DaimondPeer.uiState(turn(), dk.DaimondLease.record(TID), null, PHONE, NOW, null, 'end');
	check('L5   a foreign live run still says the rest', s2 === 'claimed', s2);
}
try {
	// LOW-2 in daimond.js: `turnRunnerId` names only a foreign holder while this device ends it.
	const phW = loadPeer(), door = makeDoor();
	await phW.DaimondLease.take(TID, { holder: PHONE, ts: NOW }, door, clock);
	const m = turn();
	const chat = { id: 'c-l2', messages: [{ role: 'user', content: 'go', iturn: TID }, m] };
	const frames = [];
	let A = null;
	const look = (where) => frames.push({ where, runner: A.turnRunnerId(TID), st: A.peerUiStateFor(m) });
	A = device(phW, PHONE, { syncCas: () => door,
		stub: { answerUnhanded: (ch, tid) => { look('before the row'); ch.messages.push({ role: 'assistant', why: 'notrun', iturn: tid }); } } });
	const realTake = phW.DaimondLease.take;
	phW.DaimondLease.take = async (tid, o, cas, now) => { look('before the take'); const r = await realTake(tid, o, cas, now); look('after the take'); return r; };
	await A.endHandOffNotRun(chat, m, 'refused');
	phW.DaimondLease.take = realTake;
	const bad = frames.filter((f) => f.runner === PHONE || RUNNER[f.st]);
	check('L6 over its own live run claim, no frame of its end names the asker as the runner',
		frames.length >= 3 && !bad.length, J(bad.length ? bad : frames));
} catch (e) { check('L6 the ending frames lift from daimond.js', false, String(e && e.stack || e)); }
{
	// LOW-4: a turn held only to end it can hear nothing.
	const ph = loadPeer(), door = makeDoor();
	await ph.DaimondLease.take(TID, { holder: PHONE, ts: NOW, intent: 'end' }, door, clock);
	const r = await ph.DaimondLease.say(TID, { id: 's1', text: 'and also' }, door, clock);
	check('L7 words said into an ending lease are refused: not running', !!r && !r.ok && r.why === 'not_running', J(r));
}

// ── M: SYNCREAD-R2 MED-1 (rc review, 2026-10-23): the retake's record carries `ending` ──
// This device's own live run claim (a reload left it), then its own take to END the turn.
// The fold keeps the fresher `renewedAt` for one holder and the door's record on a tie, so
// a retake stamped no later than the claim it replaces wrote the old non-ending record:
// every device read `claimed` with the asker as runner, then `done` for a turn never run.
// The clock at the retake against the old claim: frozen, stepped back, advancing.
for (const [tag, dt] of [['frozen (dt 0)', 0], ['stepped back (dt -300 ms)', -300], ['advancing (dt +5 s)', 5000]]) {
	const ph = loadPeer(), dk = loadPeer(), door = makeDoor();
	await ph.DaimondLease.take(TID, { holder: PHONE, ts: NOW }, door, clock);
	const at = () => NOW + dt;
	const took = await ph.DaimondLease.take(TID, { holder: PHONE, ts: NOW, intent: 'end' }, door, at);
	const d1 = door.peek()[TID];
	dk.DaimondLease.adopt(door.peek(), at);
	const s1 = dk.DaimondPeer.uiState(turn(), dk.DaimondLease.record(TID), null, DESK, at(), null, false);
	check('M ' + tag + ': the retake wins as a retake, and the door record carries ending',
		!!(took && took.won && took.retake) && !!(d1 && d1.ending), J([took, d1]));
	check('M ' + tag + ':   another device reads ending, no runner', s1 === 'ending'
		&& dk.DaimondLease.holder(TID, at()) === null, J([s1, dk.DaimondLease.holder(TID, at())]));
	await ph.DaimondPeer.settleLease('turn', TID, PHONE, 'done', door, at);
	await ph.DaimondPeer.settleLease('turn', TID, PHONE, 'released', door, at);
	dk.DaimondLease.adopt(door.peek(), at);
	const r3 = dk.DaimondLease.record(TID);
	const s3 = dk.DaimondPeer.uiState(turn(), r3, null, DESK, at(), null, false);
	check('M ' + tag + ':   settled, it still reads ending, not done', s3 === 'ending' && !!(r3 && r3.ending), J([s3, r3]));
}

console.log('\n' + (checks - failures) + ' of ' + checks + ' checks pass');
process.exit(failures ? 1 : 0);
