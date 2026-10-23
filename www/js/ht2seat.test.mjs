/* ============================================================
   Test -- every seat reader on the derived presence fields, the send-time
   read, withdraw on loss, and the folder rule (HT2 part b; design
   daimond_handoff_truth_design_20261023 §2.5, §2.6; F4c, UNBLOCK-32).
   ------------------------------------------------------------
   The REAL peer.js and markshere.js in one simulated tab, and the REAL
   `maybeAutoDispatch`, `sendPresenceRead` and `chatNeedsFolder` lifted out
   of daimond.js, on a fixed clock.

     A1  a parked runner whose posture has not changed for 5 min is still
         offered by the switch;
     A2  an attended phone, no change for 5 min: a consent is routed to it;
     A3  a `stated: false` row is never seated, elected or routed a consent
         (the "gilgamesh seated" case);
     A4  a runner whose `listening` turns false: the switch reads Here on
         that presence change, with no timer to arm;
     A5  a send whose presence read has not landed at 2 s runs Here, and
         one whose read lands decides on what it read, presuming nothing;
     A6  a withdrawal racing a claim: the turn runs exactly once, both orders;
     A7  an old gateway's map: today's verdicts on every reader;
     A8  a Diamond folder rooted on the asker only: Here, and the turn runs
         here; rooted on both: offered.
     A9  the map unknown (a re-read did not land, HT2 c4): the switch's
         options carry it and the switch reads Here.

   Red proof:  MM_SRC_REV=209f7e19a node www/js/ht2seat.test.mjs
   Breaks:     node www/js/ht2seat.test.mjs --break <name>, names below.
   ============================================================ */
import { source, liftFn } from './testlift.mjs';
import { webcrypto } from 'node:crypto';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : null; })();
// Each break undoes one part of HT2b in the source; the arm it names goes red.
const BREAKS = {
	genuine:  ['p', "if (recDerived(rec)) return rec.listening === true && rec.stated !== false;", ''],						// A1
	attended: ['p', "if (recDerived(rec)) return rec.stated !== false && recAwake(rec, now, windowMs);", ''],				// A2
	stated:   ['p', "if (recDerived(rec)) return rec.listening === true && rec.stated !== false;",
		"if (recDerived(rec)) return rec.listening === true;"],																// A3
	listen:   ['p', "if (recDerived(rec)) return rec.listening === true && rec.stated !== false;",
		"if (recDerived(rec)) return rec.stated !== false;"],																// A4
	sendread: ['d', 'if (!read) {', 'if (false) {'],																	// A5
	withdraw: ['p', "if (!recDerived(rec) || rec.listening !== false) return false;", 'return false;'],					// A6
	olddrv:   ['p', "return !!rec && typeof rec.listening === 'boolean';", 'return !!rec;'],							// A7
	folder:   ['d', "try { return DaimondMarksHere.rootedHere(chat.diamondId || '', chat.id || '', rootHere()); }",
		'try { return false; }'],																						// A8
	seatunk:  ['d', 'presenceUnknown: !!(window.DaimondPresence && DaimondPresence.unknown && DaimondPresence.unknown()),', ''],	// A9
};

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

let PEER = source('peer.js');
let DMND = source('daimond.js');
const MARKS = source('markshere.js');
const STAMP = source('stamp.js');
if (BREAK) {
	const b = BREAKS[BREAK];
	if (!b) throw new Error('no break ' + BREAK);
	const was = b[0] === 'p' ? PEER : DMND;
	const now = was.replace(b[1], b[2]);
	if (now === was) throw new Error('break ' + BREAK + ': its line is not in the source');
	if (b[0] === 'p') PEER = now; else DMND = now;
}

// ── One simulated tab ──
function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { localStorage };
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.DaimondIdentity = { isUnlocked: () => true };
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: 'complete', addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	function CustomEventShim(t, o) { this.type = t; this.detail = o && o.detail; }
	const quiet = { debug: () => {}, log: () => {}, warn: () => {}, error: console.error };
	for (const body of [STAMP, PEER, MARKS]) {
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage',
			'TextEncoder', 'TextDecoder', 'CustomEvent', 'Blob',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis', 'navigator', 'module',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage,
			TextEncoder, TextDecoder, CustomEventShim, Blob,
			setTimeout, clearTimeout, setInterval, clearInterval,
			quiet, globalThis, { storage: {} }, undefined);
	}
	return win;
}

const NOW  = 1_800_000_000_000;
const MIN  = 60_000;
const SELF = 's0000000000000000000000000000000';
const RUN  = 'a0000000000000000000000000000000';		// the nominated runner (argonaut)
const GIL  = 'g0000000000000000000000000000000';		// a desktop no tab has stated for (gilgamesh)
const PHN  = 'p0000000000000000000000000000000';		// the phone the person is at
const FID  = '0123456789abcdef0123456789abcdef';		// the asker's folder id
const DIA  = '18f0a0b0c0d0e0f';						// the chat's Diamond
const CHAT = { id: 'c1', diamondId: DIA, messages: [] };

const tab = makeTab();
const P = tab.DaimondPeer;
const M = tab.DaimondMarksHere;
const W = P.DISPATCH_FRESH_MS;

// A row from a deriving gateway: the posture stated 5 min ago, the doors held now.
function derived(f) {
	return Object.assign({ name: 'argonaut', lastSeen: NOW - 5 * MIN, runner: true, folder: true, mobile: false,
		listening: true, heardAt: NOW - 1000, doors: 1, stated: true }, f);
}
// A row from a gateway before HT1: the beat and nothing derived.
function old(f) {
	return Object.assign({ name: 'argonaut', lastSeen: NOW - 5000, runner: true, folder: true, mobile: false }, f);
}
const seatOpts = (f) => Object.assign({ selfId: SELF, nominatedId: RUN, freshWindowMs: W, runnerOnly: true,
	toggle: null }, f);
const sw  = (p, f) => P.seatSwitch(CHAT, p, seatOpts(f), NOW);
const ad  = (p, f) => P.autoDispatchDecision(CHAT, p, seatOpts(f), NOW);

// ── A1 ──
console.log('\nA1. a parked runner, no posture change for 5 min');
{
	const s = sw({ [RUN]: derived() });
	check('A1. the switch still offers it', s.choice === 'runner' && !!s.runner && s.runner.deviceId === RUN,
		'choice=' + s.choice);
	check('A1b. and a send hands the turn to it', ad({ [RUN]: derived() }).dispatch === true);
}

// ── A2 ──
console.log('\nA2. an attended phone, no change for 5 min');
{
	const phone = derived({ name: 'iphone', runner: false, folder: false, mobile: true, attended: true,
		attendedAt: NOW - 5 * MIN });
	const a = P.attendedPeer({ [PHN]: phone }, RUN, NOW, W);
	check('A2. a consent is routed to it', !!a && a.deviceId === PHN, a ? a.deviceId.slice(0, 1) : 'none');
}

// ── A3 ──
console.log('\nA3. a row no tab has stated a posture for');
{
	// Fresh: a park made the row a second ago, so only `stated` can keep it out.
	const gil = derived({ name: 'gilgamesh', stated: false, lastSeen: NOW - 1000 });
	const s = sw({ [RUN]: gil });
	check('A3. the nominee unstated: never seated, the switch reads Here', s.choice === 'here' && !s.runner,
		'choice=' + s.choice);
	const d = ad({ [GIL]: gil }, { nominatedId: '' , globalDefault: true });
	check('A3b. nor elected as another desktop', d.dispatch === false, 'reason=' + d.reason);
	const a = P.attendedPeer({ [GIL]: derived({ name: 'gilgamesh', attended: true, stated: false, lastSeen: NOW - 1000 }) }, SELF, NOW, W);
	check('A3c. nor routed a consent', a === null, a ? a.deviceId.slice(0, 1) : 'none');
}

// ── A4 ──
console.log('\nA4. the runner stops listening');
{
	const before = sw({ [RUN]: derived() });
	// Its park died a moment ago; the posture it stated is a second old, so no stamp has aged.
	const lost = derived({ lastSeen: NOW - 1000, listening: false, doors: 0 });
	const after = sw({ [RUN]: lost });
	check('A4. on that presence change the switch reads Here', before.choice === 'runner' && after.choice === 'here',
		before.choice + ' -> ' + after.choice);
	check('A4b. and no timer is armed on a derived row', before.until === 0, 'until=' + before.until);
}

// ── A5 ── the real maybeAutoDispatch, lifted, its world stubbed
console.log('\nA5. the send-time read');
// A one-line `var X = v;  // note` (testlift's liftVar reads to the next line ending in `;`).
function varLine(name) {
	const m = new RegExp('\\n\\t+(var ' + name + '\\b[^\\n]*?;)').exec(DMND);
	return m ? m[1] : '';
}
function liftSend(refresh) {
	const delays = [];
	const decided = [];
	const presence = { [RUN]: derived() };
	const fakeTimeout = (fn, ms) => { delays.push(ms); if (ms === 2000 || ms === 4000) queueMicrotask(fn); return 1; };
	const DaimondSync = { presenceDerived: () => true, refreshPresence: refresh };
	const DaimondPeer = Object.assign({}, P, {
		autoDispatchDecision: (c, p, o) => { decided.push({ p, o }); throw new Error('decided'); },
	});
	const DaimondPresence = { snapshot: () => presence };
	const win = { DaimondSync, DaimondPeer, DaimondPresence };
	const body = [
		varLine('NOMINEE_REFRESH_CAP_MS'), varLine('NOMINEE_TRUST_MS'), varLine('PRESENCE_READ_CAP_MS'), liftFn(DMND, 'sendPresenceRead'), liftFn(DMND, 'maybeAutoDispatch'),
		'return maybeAutoDispatch;',
	].join('\n');
	const make = new Function('window', 'DaimondSync', 'DaimondPeer', 'DaimondPresence', 'setTimeout', 'navigator',
		'turnHold', 'selfDeviceId', 'nominatedDeviceId', 'diag', 'reconcileRoster', 'presenceWithLeaseBusy',
		'turnPresence', 'isPhoneViewport', 'chatToolsEnabled', 'preferredWorkerLabel', 'fleetCurrentBuild',
		'handoffWhenAway', 'chatRunningOn', 'chatSeatHere', 'chatNeedsFolder', 'electProvider', body);
	const fn = make(win, DaimondSync, DaimondPeer, DaimondPresence, fakeTimeout, { onLine: true },
		() => false, () => SELF, () => RUN, () => {}, () => {}, (p) => p,
		(p) => p, () => false, () => true, () => '', () => '',
		() => false, () => '', () => false, () => false, () => '');
	return { fn, delays, decided, presence };
}
{
	const t = liftSend(() => new Promise(() => {}));			// a read that never lands
	const r = await t.fn(CHAT, 'p', 1, 'm1', null);
	check('A5. a read not landed at 2 s: Here, and nothing decided', r === false && t.decided.length === 0,
		'returned ' + r + ', decided ' + t.decided.length);
	check('A5b. bounded at 2 s, not 4', t.delays.includes(2000) && !t.delays.includes(4000), 'timers ' + t.delays.join());
	const fresh = { [RUN]: derived({ heardAt: NOW }) };
	const u = liftSend(() => Promise.resolve({ presence: fresh, derived: true }));
	await u.fn(CHAT, 'p', 1, 'm1', null);
	const o = u.decided.length ? u.decided[0].o : {};
	check('A5c. a read that lands decides on what it read, presuming nothing',
		u.decided.length === 1 && u.decided[0].p === u.presence && !(o.presumeNomineeWindowMs > 0),
		'decided ' + u.decided.length + ', presume ' + o.presumeNomineeWindowMs);
}

// ── A6 ── two devices' DaimondLease on one CAS door
console.log('\nA6. withdrawal racing a claim');
function makeCas() {
	let version = 1, leases = {};
	return {
		read: async () => ({ version, leases: JSON.parse(JSON.stringify(leases)) }),
		write: async (base, next) => {
			if (base !== version) return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
			version += 1;
			leases = JSON.parse(JSON.stringify(next));
			return { ok: true, version };
		},
	};
}
const TID = 'm-turn-1';
const placeholder = { why: P.REASON_DISPATCHED, toDevice: RUN, dispatchedBy: SELF, iturn: TID, itext: 'p',
	ts: NOW - 20000, mid: 'ph-' + TID };
const lostRow = derived({ lastSeen: NOW - 1000, listening: false, doors: 0 });
const claim = (who, eid) => ({ holder: who, eid, deadline: NOW + 15 * MIN });
async function race(runnerFirst) {
	const asker = makeTab().DaimondLease, runner = makeTab().DaimondLease;
	const cas = makeCas(), now = () => NOW;
	let runs = 0, askerRan = false;
	const withdrawOnLoss = P.withdrawOnLoss || (() => false);
	async function askerWithdraws() {
		// runDispatchFallback's order: the lease door read and adopted, then the decision,
		// then the run's take by CAS.
		asker.adopt((await cas.read()).leases, now);
		if (!withdrawOnLoss(placeholder, asker.record(TID), lostRow, SELF, NOW)) return;
		const r = await asker.take(TID, claim(SELF, 'eA'), cas, now);
		if (r.won) { runs++; askerRan = true; }
	}
	async function runnerClaims() {
		const r = await runner.take(TID, claim(RUN, 'eR'), cas, now);
		if (r.won) runs++;
	}
	if (runnerFirst) { await runnerClaims(); await askerWithdraws(); }
	else { await askerWithdraws(); await runnerClaims(); }
	return { runs, askerRan };
}
{
	const a = await race(false);
	check('A6. the runner lost before it claimed: withdrawn, run here, exactly once',
		a.runs === 1 && a.askerRan, 'runs=' + a.runs + ' here=' + a.askerRan);
	const b = await race(true);
	check('A6b. the runner\'s claim landed first: the withdrawal fails, run there, exactly once',
		b.runs === 1 && !b.askerRan, 'runs=' + b.runs + ' here=' + b.askerRan);
	const c = P.withdrawOnLoss ? P.withdrawOnLoss(placeholder, null, old({ lastSeen: NOW - 5 * MIN }), SELF, NOW) : false;
	check('A6c. an old gateway\'s row never withdraws (the backstop stands)', c === false);
}

// ── A7 ──
console.log('\nA7. an old gateway\'s map: today\'s verdicts');
{
	check('A7. a beating runner is offered', sw({ [RUN]: old() }).choice === 'runner');
	check('A7b. one whose beat is 5 min old is not', sw({ [RUN]: old({ lastSeen: NOW - 5 * MIN }) }).choice === 'here');
	const s = sw({ [RUN]: old() });
	check('A7c. and the switch arms its timer at the beat\'s edge', s.until === NOW - 5000 + W + 1, 'until=' + s.until);
	check('A7d. serviced long ago: not genuine', P.recGenuine(old({ servicedAt: NOW - 5 * MIN }), NOW, W) === false);
	const ph = old({ name: 'iphone', mobile: true, runner: false, attended: true, attendedAt: NOW - 5000 });
	check('A7e. an attended phone within the window is routed a consent',
		(P.attendedPeer({ [PHN]: ph }, RUN, NOW, W) || {}).deviceId === PHN);
	check('A7f. and one attended 5 min ago is not',
		P.attendedPeer({ [PHN]: Object.assign({}, ph, { attendedAt: NOW - 5 * MIN }) }, RUN, NOW, W) === null);
}

// ── A8 ── the folder rule, the asker's half lifted from daimond.js
console.log('\nA8. a Diamond folder rooted on the asker');
{
	const root = 'machine:usr#' + FID;
	tab.localStorage.setItem(M.KEY, JSON.stringify({ v: 1, d: { [DIA]: [{ id: 'l1', to: 'dir:[machine:usr]books/x',
		rel: 'holds', share: false, root }] }, c: {} }));
	const lifted = liftFn(DMND, 'chatNeedsFolder');
	const needs = lifted ? new Function('window', 'DaimondMarksHere', 'selfHoldsFolder', 'rootHere',
		lifted + '\nreturn chatNeedsFolder;')(tab, M, () => true, () => root) : () => undefined;
	const nf = needs(CHAT);
	check('A8a. the asker reads the chat as rooted here', nf === true, 'needFolder=' + nf);
	const s = sw({ [RUN]: derived({ folder: false, lastSeen: NOW - 1000 }) }, { needFolder: nf });
	const d = ad({ [RUN]: derived({ folder: false, lastSeen: NOW - 1000 }) }, { needFolder: nf });
	check('A8. rooted on the asker only: the switch reads Here, and the turn runs here',
		s.choice === 'here' && d.dispatch === false, 'choice=' + s.choice + ' dispatch=' + d.dispatch);
	const s2 = sw({ [RUN]: derived({ folder: true, lastSeen: NOW - 1000 }) }, { needFolder: nf });
	check('A8b. rooted on both: offered', s2.choice === 'runner', 'choice=' + s2.choice);
	const browser = lifted ? new Function('window', 'DaimondMarksHere', 'selfHoldsFolder', 'rootHere',
		lifted + '\nreturn chatNeedsFolder;')(tab, M, () => false, () => 'browser')(CHAT) : false;
	check('A8c. no folder open here: nothing required', browser === false);
}

// ── A9 ── the switch's options, lifted from daimond.js, over an unknown map
console.log('\nA9. the map unknown');
{
	const lifted = liftFn(DMND, 'seatOpts');
	const mk = (unknown) => lifted ? new Function('window', 'DaimondPresence', 'DaimondPeer', 'current', 'selfDeviceId',
		'isPhoneViewport', 'isMobileDeviceSelf', 'preferredWorkerLabel', 'fleetCurrentBuild', 'nominatedDeviceId',
		'handoffWhenAway', 'chatSeatHere', 'chatNeedsFolder', 'electProvider', lifted + '\nreturn seatOpts;')(
		{ DaimondPresence: { unknown: () => unknown } }, { unknown: () => unknown }, P, CHAT, () => SELF,
		() => true, () => true, () => '', () => '', () => RUN, () => true, () => false, () => false, () => '')(CHAT) : {};
	const o = mk(true);
	check('A9a. the switch\'s options carry the unknown map', o.presenceUnknown === true, 'presenceUnknown=' + o.presenceUnknown);
	const s = P.seatSwitch(CHAT, { [RUN]: derived() }, o, NOW);
	const k = P.seatSwitch(CHAT, { [RUN]: derived() }, mk(false), NOW);
	check('A9. unknown: the switch reads Here; known: the runner', s.choice === 'here' && !s.runner && k.choice === 'runner',
		s.choice + ' / ' + k.choice);
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
