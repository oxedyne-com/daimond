/* ============================================================
   dispatchfail.test.mjs -- a hand-off that fell back here names this device
   (UNBLOCK-1 DISPATCH-FAIL, FIRE under D-20261013-02; rig laws I2 + I9).

   THE BUG (rig T1425, 1 in 18). The phone handed a turn to argonaut, the post was
   refused (500), and the phone ran the turn itself, but its switch, tile and seat line
   still named argonaut: the switch read the runner from the lease alone, the tile
   read "Sending to argonaut…" until the phone's own claim landed (39 s in the store
   stall), and the answer's provenance read "hand-off to <this phone> didn't finish".
   The refusal itself was stamped on a placeholder object a sync merge had replaced.

     P1-P3  peer.js: a chat running here seats here; the runner is still offered, unpressed
     U1-U2  peer.js: uiState reads a turn this device took on as claimed, not "dispatched"
     R1-R5  daimond.js (lifted): the runner, the header, the footer and the provenance
     H1-H3  daimond.js (lifted): an answer that ran here never names this device as the
            hand-off target, and a refused hand-off is drawn as the refusal
     F1-F3  daimond.js (lifted): a refused post stamps the placeholder the chat holds NOW
            and ends that one "not run" (SEND-UNHANDED part 2; it ran here before)

   Run: node www/js/dispatchfail.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
const J = JSON.stringify;

// ── peer.js, loaded as the page loads it ──
const win = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const P = win.DaimondPeer;
const NOW = 1700000000000;
const PHONE = 'PHONE', DESK = 'DESK';
const live = { [DESK]: { name: 'argonaut', lastSeen: NOW - 1000, servicedAt: NOW - 1000, mobile: false } };
const chat = { id: 'c-df', messages: [] };
const base = { selfId: PHONE, nominatedId: DESK, isPhone: true, selfMobile: true };

console.log('dispatchfail: a hand-off that fell back here names this device\n');

// P1 the send: a chat whose turn runs here is not handed to the runner it never reached.
{
	const d = P.autoDispatchDecision(chat, live, Object.assign({ queueOn: PHONE, toggle: null }, base), NOW);
	check('P1 a chat running here seats its next turn here', d.dispatch === false && d.reason === 'running-here', J([d.dispatch, d.reason]));
	const c = P.autoDispatchDecision(chat, live, Object.assign({ queueOn: '', toggle: null }, base), NOW);
	check('[ctl] with nothing running here the nominee takes it', c.dispatch === true, J([c.dispatch, c.reason]));
}
// P2 the switch: pressed Here while the chat runs here, the runner still offered.
{
	const sw = P.seatSwitch(chat, live, Object.assign({ queueOn: PHONE }, base), NOW);
	check('P2 the switch reads Here while the chat runs here', sw.choice === 'here', J(sw));
	check('P3   and still offers the runner for the next turn', !!(sw.runner && sw.runner.deviceId === DESK), J(sw));
	const sr = P.seatSwitch(chat, live, Object.assign({ queueOn: DESK }, base), NOW);
	check('[ctl] a chat running on the runner reads the runner', sr.choice === 'runner', J(sr));
}
// U the tile's state.
{
	const turn = { why: 'dispatched', iturn: 't1', ts: NOW - 5000, toDevice: DESK, toName: 'argonaut' };
	const s = P.uiState(turn, null, null, PHONE, NOW, null, true);
	check('U1 a turn this device took on reads claimed before its own claim lands', s === 'claimed', s);
	check('[ctl] the same turn not taken on reads dispatched', P.uiState(turn, null, null, PHONE, NOW, null, false) === 'dispatched');
	const foreign = { holder: DESK, mode: 'running', expiry: NOW + 60000 };
	check('U2 a live lease still says the rest', P.uiState(turn, foreign, null, PHONE, NOW, null, true) === 'running');
}

// ── daimond.js, lifted ──
function labels(holder, recovering, self = PHONE, names0 = null) {
	const w = makeWindow({});
	w.DaimondLease = { holder: () => holder, record: () => null };
	w.DaimondPresence = { name: (id) => (id === DESK ? 'argonaut' : '') };	// no beat of its own
	const names = { [PHONE]: 'iphone', [DESK]: 'argonaut' };
	const stub = {
		selfDeviceId: () => self,
		_localRecovering: recovering ? { t1: true } : {},
		loadDevices: () => ({ [PHONE]: { label: names[PHONE] }, [DESK]: { label: names[DESK] } }),
		deviceNamesKnown: () => ({}),
		rememberDeviceName: () => {},
		t: (k, o) => k + (o ? J(o) : ''),
	};
	const { fns } = sliceDaimond(w, ['turnRunnerId', 'handoffClaimLabel', 'handoffTargetLabel', 'runnerLabel'], stub);
	return fns;
}
function provenance(self) {
	const w = makeWindow({});
	w.DaimondPresence = { name: () => '' };
	const names = { [PHONE]: 'Safari on iOS · c07e', [DESK]: 'argonaut' };
	const stub = {
		selfDeviceId: () => self,
		loadDevices: () => ({ [PHONE]: { label: names[PHONE] }, [DESK]: { label: names[DESK] } }),
		deviceNamesKnown: () => ({}),
		rememberDeviceName: () => {},
		t: (k, o) => k + (o ? J(o) : ''),
	};
	return sliceDaimond(w, ['runnerLabel', 'ranHereProvenance'], stub).fns;
}
try {
	const m = { iturn: 't1', why: 'dispatched', toDevice: DESK, toName: 'argonaut' };
	const f = labels(null, true);
	check('R1 taken on here, before its claim lands, the runner is this device', f.turnRunnerId('t1') === PHONE, f.turnRunnerId('t1'));
	check('R2   the header names this device', f.handoffClaimLabel(m) === 'iphone', f.handoffClaimLabel(m));
	check('R3   the footer names this device, not "another device"', f.runnerLabel(PHONE) === 'iphone', f.runnerLabel(PHONE));
	const g = labels(PHONE, true);
	check('R4 its own claim landed: the provenance names argonaut, never "hand-off to <this device>"',
		g.handoffTargetLabel(m) === 'argonaut', g.handoffTargetLabel(m));
	// THE RUNNER'S OWN TILE (rig busy3 run 1, r567bs): argonaut ran the turn it was handed and
	// read "Ran here — hand-off to argonaut didn't finish".
	const r = labels(DESK, false, DESK);
	check('R5 on the runner, a turn handed to it names no hand-off target', r.handoffTargetLabel(m) === '', r.handoffTargetLabel(m));
	const n = labels(null, false);
	check('[ctl] not taken on: nobody runs it', n.turnRunnerId('t1') === '', n.turnRunnerId('t1'));
} catch (e) { check('R the runner\'s labels lift from daimond.js', false, String(e && e.message || e)); }

// H the provenance an answer that ran here draws.
try {
	const onRunner = provenance(DESK), onPhone = provenance(PHONE);
	const a = onRunner.ranHereProvenance('argonaut', {});
	check('H1 the runner\'s own tile never reads "hand-off to argonaut"', a === null, J(a));
	const b = onPhone.ranHereProvenance('Safari on iOS · c07e', {});
	check('H2 the phone\'s own tile never reads "hand-off to Safari on iOS · c07e"', b === null, J(b));
	const c = onPhone.ranHereProvenance('argonaut', { handoffRefused: 'store timeout' });
	check('H3 a refused hand-off is drawn as the refusal, not "hand-off to argonaut didn\'t finish"',
		!!c && c.why === 'store timeout', J(c));
	const d = onPhone.ranHereProvenance('argonaut', {});
	check('[ctl] a hand-off to argonaut that fell back here names argonaut', !!d && d.to === 'argonaut' && !d.why, J(d));
	check('[ctl] a plain local turn draws nothing', onPhone.ranHereProvenance('', {}) === null);
} catch (e) { check('H the provenance lifts from daimond.js', false, String(e && e.message || e)); }

// F a refused post: the placeholder the chat holds after the await is the one stamped and run.
async function refusedPost(mode) {
	const w = makeWindow({});
	const rec = { recovered: null, persisted: 0 };
	const c = { id: 'c-f', messages: [{ role: 'user', content: 'go', iturn: 't9' }], provider: 'p', model: 'm' };
	const merge = () => { c.messages = c.messages.map((x) => Object.assign({}, x)); };	// a sync merge replaces every object
	w.DaimondPeer = {
		REASON_DISPATCHED: 'dispatched',
		buildDispatch: () => ({ mark: { iturn: 't9' }, fields: {} }),
		sealFittingErrand: async () => {
			merge();
			if (mode === 'seal') throw new Error('locked');
			return { body: { envelope: 'x' }, seedDropped: false, plan: { fields: {} } };
		},
	};
	w.DaimondPost = { post: async () => { merge(); return { ok: false, status: 500, why: 'boom' }; } };
	w.DaimondSync = { push: async () => true };
	const stub = {
		diag: () => {}, dsEvent: () => {}, turnHold: () => null, selfDeviceId: () => PHONE,
		storedPre: () => '', storedEffort: () => null, turnEffortOf: () => null, autonomousPosture: () => null,
		msgTombsOwed: () => [], loadChatMessages: async () => {}, honoursModelSet: () => true,
		markTurnDispatched: (ch, mark) => { ch.messages.push({ role: 'assistant', content: '', why: 'dispatched', iturn: mark.iturn, toDevice: DESK, toName: 'argonaut' }); },
		seatNoteOnPrompt: () => true, seatNameOf: (id, nm) => nm || id,
		touchMsg: () => {}, touchChat: () => {}, persistChats: () => { rec.persisted++; }, ownsChat: () => false, renderHistory: () => {},
		recoverOneLocally: (ch, m) => { rec.ranHere = m; },
		endHandOffNotRun: (ch, m) => { rec.recovered = m; },
		t: (k) => k,
	};
	const { fns } = sliceDaimond(w, ['dispatchToPeer'], stub);
	const res = await fns.dispatchToPeer(c, 't9', 'go', [], { toId: DESK, toName: 'argonaut' });
	const ph = c.messages.find((x) => x.why === 'dispatched');
	return { res, ph, rec };
}
{
	const r = await refusedPost('post');
	check('F1 a refused post is stamped on the placeholder the chat holds now', !!(r.ph && r.ph.refused && r.ph.refused.status === 500), J(r.ph));
	// Rulings §1 l.17 (SEND-UNHANDED part 2): a refused post ends "not run", never run here.
	check('F2   and that placeholder is the one ended "not run", none run here', r.rec.recovered === r.ph && !!r.ph && !r.rec.ranHere,
		J([!!r.rec.recovered, r.rec.recovered === r.ph, !!r.rec.ranHere]));
	const s = await refusedPost('seal');
	check('F3 a refused seal is stamped on the placeholder the chat holds now', !!(s.ph && s.ph.refused), J(s.ph));
}

console.log('\n' + (checks - failures) + ' of ' + checks + ' checks pass');
process.exit(failures ? 1 : 0);
