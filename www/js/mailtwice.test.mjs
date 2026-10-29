// mailtwice.test.mjs -- one mail arrival is one turn, whenever the 60 s tick falls (MAIL-TWICE).
//
//	node --test www/js/mailtwice.test.mjs
//
// In 2 of 4 clean `verify_mailtrigger` runs on C1b one announced arrival bought two turns
// ~0.3 s apart. The announced arrival's `Triggers.fire` claims it on the lease door, runs the
// turn and raises the folder's answered mark; the 60 s tick's `retryMail` meanwhile reads the
// mark (`owedByMark`), still under the arrival, and owes it again. Its claim names the same
// arrival, but this device's own live claim is one the door lets it RE-TAKE (`leaseTakeFrom`,
// RUNNER-READY F2), and the in-page guard covered only the turn itself: not the claim's round
// trips before it, nor the mark's after it. A tick in either gap ran the arrival twice.
//
// One device, the REAL `Triggers.fire` / `retryMail` and claim helpers lifted from
// daimond.js over the real peer.js DaimondLease, with the tick dropped into each await of
// the arrival's life in turn. Red on 03c79323: the two gaps each run two turns.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readPage(join(HERE, 'daimond.js'), 'utf8');
const require = createRequire(import.meta.url);

function balanced(src, start) {
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}
function extractFn(src, name) {
	const m = new RegExp('\\n\\t+(?:async )?function ' + name + '\\(').exec(src);
	return m ? balanced(src, m.index + 1) : '';
}
function extractMethod(src, name) {
	const m = new RegExp('\\n\\t+' + name + ': async function \\(').exec(src);
	return m ? balanced(src, m.index + 1) : '';
}
function extractVar(src, name) {
	const m = new RegExp('\\n\\t+var ' + name + ' *=[^;]*;').exec(src);
	return m ? m[0] : '';
}

// One device's peer.js: its own window, so its own `_leases`.
function loadPeer() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	win.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });
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
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function EventShim(t) { this.type = t; }
	for (const [rel, extra] of [
		['vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;'],
		['curvefallback.js'], ['identity.js'], ['post.js'], ['peer.js'],
	]) {
		let body = readPage(join(HERE, rel), 'utf8');
		if (extra) body += extra;
		new Function('window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'Event', 'setTimeout', 'clearTimeout',
			'setInterval', 'clearInterval', 'console', 'globalThis',
			'with (window) {\n' + body + '\n}')(win, document, webcrypto, localStorage, btoa, atob,
			TextEncoder, TextDecoder, EventShim, setTimeout, clearTimeout, setInterval, clearInterval,
			console, globalThis);
	}
	return win;
}

// The gateway's lease door: one version, one map, compare-and-set. `W.gap(next, prev)`, when
// set, runs once a commit has landed and before its caller hears: the round trip home.
function makeDoor(gap) {
	let version = 1, leases = {};
	const copy = (x) => JSON.parse(JSON.stringify(x));
	return {
		read: async () => ({ version, leases: copy(leases), unread: false }),
		commit: async (base, next) => {
			if (gap.pre) await gap.pre(copy(next), copy(leases));	// the write still on the wire
			if (base !== version) return { ok: false, version, leases: copy(leases) };
			const prev = leases;
			version += 1; leases = copy(next);
			if (gap.fn) await gap.fn(copy(next), prev);
			return { ok: true, version };
		},
		peek: () => copy(leases),
	};
}

globalThis.window = { DaimondPause: { isPaused: () => false, triggerLeaf: (d, a) => d + '/' + a } };
const DaimondTriggers = require('./triggers.js');

const CLOCK = { now: 1_800_000_000_000 };

// One open device: Diamond A on screen, Diamond B watching alerts@.
function device(name, door, turns, opts) {
	const peer = loadPeer();
	// The mail this page holds: what `owedByMark` reads the folder's top from.
	peer.DaimondMail = { held: () => W.held };
	// What sync.js would say: has this page ever heard back from the mailbox? And the trail.
	// What sync.js would say. By default a syncing page that has heard the mailbox. `never`
	// is a page that can never coordinate ('identity': none, 'safe': a safe start, 'tier': no
	// sync tier); `heard: false` a syncing page whose first pull is not back yet.
	const said = { heard: !(opts && opts.heard === false) }, never = (opts && opts.never) || '';
	if (never !== 'identity') peer.DaimondIdentity.everExisted = () => true;
	if (never === 'safe') peer.DaimondSafe = { on: () => true };
	peer.DaimondSync = { heard: () => said.heard, entitled: () => never !== 'tier' };
	const heardBy = [];
	peer.addEventListener = (t, fn) => { if (t === 'daimond:heard') heardBy.push(fn); };
	if (opts && opts.trail) peer.DaimondTrail = { note: (w, d) => opts.trail.push([w, String(d)]) };
	const W = { name, turns, busy: new Set(), hold: null, held: { uidValidity: 7, lastUid: 42 } };
	// The page's first pull lands: sync.js raises `daimond:heard` once.
	W.hear = () => { said.heard = true; heardBy.splice(0).forEach((fn) => fn()); };
	W.A = { id: 'A', name: 'Work' }; W.B = { id: 'B', name: 'Email' };
	W.mailB = Object.assign(DaimondTriggers.blank('mail'), {
		id: 'm1', mailbox: 'alerts@oxegen.io', folder: 'INBOX', instruction: 'Triage the alert.',
	});
	const names = ['offScreenSteerAllowed', 'steerFromTrigger', 'triggerHandOff', 'steerTriggerHere', 'claimTimerFire', 'timerFireId', 'oweMail',
		'mailMarkKey', 'mailClaimId', 'syncsHere', 'retryMailOnHeard', 'claimMailArrival', 'trailTrigger', 'seedMailMark', 'keepMailClaim', 'settleMailClaim', 'owedByMark', 'mailGen', 'mailFloors', 'mailFloorsWrite', 'pruneMailMarks', 'judgeTriggeredTurn', 'followVerdicts'];
	const body = names.map((n) => extractFn(APP, n)).join('\n');
	const vars = ['MAIL_CLAIM_GRACE_MS', 'MAIL_FLOOR_KEY', '_mailFloor', 'FOLLOW_MAX_MS', '_mailHeardArmed'].map((n) => extractVar(APP, n)).join('\n');
	W.api = new Function('W', 'DaimondTriggers', 'window', 'door', 'CLOCK', `
		var diamonds = [W.A, W.B], currentDiamond = W.A, _mailOwed = {}, _mailRunning = {}, _mailTries = {}, MAIL_TRIES_MAX = 3, _lastSteer = {};
		var _triggers = { A: { v: 1, actions: [] }, B: { v: 1, actions: [W.mailB] } };
		var DaimondLease = window.DaimondLease, DaimondPeer = window.DaimondPeer, DaimondMail = window.DaimondMail;
		var document = { getElementById: function () { return null; } };
		function diamondBusy(id) { return W.busy.has(id); }
		function askOpenIn() { return false; }
		function daimonChat(f) { return f; }
		function seatDrawnRunner() { return ''; }		// the switch draws Here: the trigger runs here (STEER-2)
		function chatSeatHere() { return false; }
		function diamondCanRun() { return true; }
		function proposeFromTurn() {}
		function diag() {}
		function selfDeviceId() { return W.name; }
		function leaseClockNow() { return CLOCK.now; }
		function peerSyncShim() { return door; }
		async function selectDiamond(f) { currentDiamond = f; }
		async function runSteer(f, text) {
			W.turns.push({ on: W.name, in: f.id });
			W.busy.add(f.id);
			try { if (W.hold) await W.hold; } finally { W.busy.delete(f.id); }
			// What the engine's \`ended\` event records: a turn that ran through, unless W.end says.
			_lastSteer[f.id] = Object.assign({ how: 'answered', calls: 0, failed: 0, refused: 0 }, W.end || {});
			return '';
		}
		async function doSteer(text) { return runSteer(currentDiamond, text); }
		${vars}
		${body}
		W.owed = function () { return Object.keys(_mailOwed).length; };
		var Triggers = {
			of: function (id) { return _triggers[id].actions; },
			save: async function () {},
			${extractMethod(APP, 'fire')},
			${extractMethod(APP, 'retryMail')},
		};
		return Triggers;`)(W, DaimondTriggers, peer, door, CLOCK);
	return W;
}

const ARRIVED = { kind: 'mail', mailbox: 'alerts@oxegen.io', folder: 'INBOX', uids: [41, 42], uidValidity: 7 };
const MARK    = 'mark:mail:B:alerts@oxegen.io:INBOX';
const TID     = 'mail:B:alerts@oxegen.io:INBOX:7:42';

/// One device whose 60 s tick (`retryMail`, as `triggerTick` calls it) falls once into the gap
/// `when(next, prev)` names. The folder held a baseline below the arrival, so its mark is seeded
/// at 40 by the claim, as on first arrival in the rig.
async function oneArrival(when, onWire) {
	const gap = { fn: null, pre: null }, door = makeDoor(gap), turns = [];
	const D = device('desk', door, turns);
	let ticked = 0;
	gap[onWire ? 'pre' : 'fn'] = async (next, prev) => {
		if (ticked || !when(next, prev)) return;
		ticked = 1;
		await D.api.retryMail();
	};
	await D.api.fire(ARRIVED);
	await D.api.retryMail();					// and the tick after it all, for good measure
	return { turns, ticked, door };
}

test('the tick in the claim\'s round trip, before the turn and its guard: one turn', async () => {
	const r = await oneArrival((n, p) => n[TID] && !p[TID]);
	assert.equal(r.ticked, 1, 'the tick never fell in the gap');
	assert.equal(r.turns.length, 1, 'the arrival ran ' + r.turns.length + ' turns');
});

test('the tick while the turn runs, the mark still under it: one turn', async () => {
	const gap = { fn: null }, door = makeDoor(gap), turns = [];
	const D = device('desk', door, turns);
	let go; D.hold = new Promise((r) => { go = r; });
	const first = D.api.fire(ARRIVED);
	while (!turns.length) await new Promise((r) => setTimeout(r, 5));
	assert.equal(door.peek()[MARK].mark, 40, 'the mark is not seeded under the arrival');
	await D.api.retryMail();
	go(); await first;
	await D.api.retryMail();
	assert.equal(turns.length, 1, 'the arrival ran ' + turns.length + ' turns');
});

test('the tick after the turn and before its mark lands (landed, unheard): one turn', async () => {
	// The mark raise through 42 has landed at the door; the turn's own page has not heard yet.
	const r = await oneArrival((n, p) => n[MARK] && n[MARK].mark === 42 && !(p[MARK] && p[MARK].mark === 42));
	assert.equal(r.ticked, 1, 'the tick never fell in the gap');
	assert.equal(r.turns.length, 1, 'the arrival ran ' + r.turns.length + ' turns');
});

test('the tick while the mark\'s write is on the wire (the C1b gap): one turn', async () => {
	const r = await oneArrival((n, p) => n[MARK] && n[MARK].mark === 42 && !(p[MARK] && p[MARK].mark === 42), true);
	assert.equal(r.ticked, 1, 'the tick never fell in the gap');
	assert.equal(r.turns.length, 1, 'the arrival ran ' + r.turns.length + ' turns');
});

for (const [where, side] of [['on the wire', 'pre'], ['landed, its confirm unread', 'fn']]) {
	test('the claim\'s write ' + where + ', an arrival already owed and the tick in it: one turn', async () => {
		// An arrival a first refusal left owed (here its Diamond was busy), asked again by the
		// announcement and by the tick at once.
		const gap = { fn: null, pre: null }, door = makeDoor(gap), turns = [];
		const D = device('desk', door, turns);
		D.busy.add('B');
		await D.api.fire(ARRIVED);
		D.busy.delete('B');
		assert.equal(turns.length, 0, 'a busy Diamond ran the arrival');
		assert.equal(D.owed(), 1, 'the refused arrival is not owed');
		let ticked = 0;
		gap[side] = async (n, p) => {
			if (ticked || !(n[TID] && n[TID].mode === 'claimed' && !(p[TID] && p[TID].mode === 'claimed'))) return;
			ticked = 1;
			await D.api.retryMail();
		};
		await D.api.fire(ARRIVED);
		await D.api.retryMail();
		assert.equal(ticked, 1, 'the tick never fell in the gap');
		assert.equal(turns.length, 1, 'the arrival ran ' + turns.length + ' turns');
	});
}

test('the tick after the mark, while the claim settles: one turn', async () => {
	const r = await oneArrival((n, p) => n[TID] && n[TID].settled && !(p[TID] && p[TID].settled));
	assert.equal(r.ticked, 1, 'the tick never fell in the gap');
	assert.equal(r.turns.length, 1, 'the arrival ran ' + r.turns.length + ' turns');
});

test('the tick before the mark, owed a different uid set ([42] against [41, 42]): one turn', async () => {
	// What `owedByMark` owes is the folder's top alone, whatever the announcement named.
	const gap = { fn: null }, door = makeDoor(gap), turns = [];
	const D = device('desk', door, turns);
	let go; D.hold = new Promise((r) => { go = r; });
	const first = D.api.fire(ARRIVED);
	while (!turns.length) await new Promise((r) => setTimeout(r, 5));
	await D.api.fire(Object.assign({}, ARRIVED, { ids: ['B'], uids: [42] }));
	go(); await first;
	await D.api.retryMail();
	assert.equal(turns.length, 1, 'the arrival ran ' + turns.length + ' turns');
});

test('a message that arrives while the turn runs is still its own turn, after it', async () => {
	const gap = { fn: null }, door = makeDoor(gap), turns = [];
	const D = device('desk', door, turns);
	let go; D.hold = new Promise((r) => { go = r; });
	const first = D.api.fire(ARRIVED);
	while (!turns.length) await new Promise((r) => setTimeout(r, 5));
	D.held = { uidValidity: 7, lastUid: 43 };
	await D.api.fire(Object.assign({}, ARRIVED, { uids: [43] }));
	go(); await first;
	D.hold = null;
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'uid 43 was lost or doubled: ' + turns.length + ' turns');
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'a settled arrival ran again');
});
