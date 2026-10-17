// mailmark.test.mjs -- an answered arrival stays answered on every device, for good (r569 R1-R3).
//
//	node --test www/js/mailmark.test.mjs
//
// MO-1 claims an arrival on the lease door, but the claim was the only record that it had
// been answered, and a settled lease drains 16.5 minutes after its dispatch. A device that
// woke later announced the same arrival from its own mark and ran it again (R1). A loser held
// its owed copy only until the claim's deadline and dropped it on the clock, so a winner that
// died lost the arrival (R3), and a turn longer than the fixed 15-minute claim was run twice
// (R2). Now a SYNCED mark, "answered through uid N" per Diamond, mailbox, folder and
// uidValidity, rides the lease section: an arrival at or below it is dropped, what is owed is
// this device's held mail above it, and the claim is renewed for as long as the turn runs.
//
// Each device is the REAL `Triggers.fire` / `retryMail` and claim helpers lifted from
// daimond.js over its OWN copy of the real peer.js, sharing ONE lease door, with its own
// timers so a device that dies stops renewing. Red on 4024e3a5.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readFileSync(join(HERE, 'daimond.js'), 'utf8');
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
		let body = readFileSync(join(HERE, rel), 'utf8');
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

// The gateway's lease door: one version, one map, compare-and-set.
function makeDoor() {
	let version = 1, leases = {};
	const copy = (x) => JSON.parse(JSON.stringify(x));
	return {
		read: async () => ({ version, leases: copy(leases), unread: false }),
		commit: async (base, next) => {
			if (base !== version) return { ok: false, version, leases: copy(leases) };
			version += 1; leases = copy(next);
			return { ok: true, version };
		},
		peek: () => copy(leases),
	};
}

let PAUSED = false;
globalThis.window = { DaimondPause: { isPaused: () => PAUSED, triggerLeaf: (d, a) => d + '/' + a } };
const DaimondTriggers = require('./triggers.js');


const CLOCK = { now: 1_800_000_000_000 };
const TICK  = 30 * 1000;

// One open page on device `name`: Diamond A on screen, Diamond B watching alerts@. Its
// timers are its own, so `W.dead` is a page that has gone (a reload, a closed tab).
function device(name, door, turns, held) {
	const peer = loadPeer();
	const W = { name, turns, busy: new Set(), hold: null, timers: new Map(), seq: 0, dead: false };
	W.held = held || { uidValidity: 7, lastUid: 42 };
	peer.DaimondMail = { held: () => W.held };
	W.peer = peer;
	W.A = { id: 'A', name: 'Work' }; W.B = { id: 'B', name: 'Email' };
	W.mailB = Object.assign(DaimondTriggers.blank('mail'), {
		id: 'm1', mailbox: 'alerts@oxegen.io', folder: 'INBOX', instruction: 'Triage the alert.',
	});
	W.tick = async () => { if (!W.dead) for (const fn of [...W.timers.values()]) await fn(); };
	const names = ['offScreenSteerAllowed', 'steerFromTrigger', 'oweMail', 'mailMarkKey',
		'mailClaimId', 'claimMailArrival', 'seedMailMark', 'keepMailClaim', 'settleMailClaim', 'owedByMark', 'mailGen', 'mailFloors', 'mailFloorsWrite', 'pruneMailMarks',
		'judgeTriggeredTurn'];
	const body = names.map((n) => extractFn(APP, n)).join('\n');
	const vars = ['MAIL_CLAIM_GRACE_MS', 'MAIL_FLOOR_KEY', '_mailFloor'].map((n) => extractVar(APP, n)).join('\n');
	W.api = new Function('W', 'DaimondTriggers', 'window', 'door', 'CLOCK', 'setInterval', 'clearInterval', `
		var diamonds = [W.A, W.B], currentDiamond = W.A, _mailOwed = {}, _mailRunning = {}, _lastSteer = {};
		var _triggers = { A: { v: 1, actions: [] }, B: { v: 1, actions: [W.mailB] } };
		var DaimondLease = window.DaimondLease, DaimondPeer = window.DaimondPeer, DaimondMail = window.DaimondMail;
		var document = { getElementById: function () { return null; } };
		function diamondBusy(id) { return W.busy.has(id); }
		function askOpenIn() { return false; }
		function daimonChat(f) { return f; }
		function diamondCanRun() { return true; }
		function proposeFromTurn() {}
		function diag() {}
		function selfDeviceId() { return W.name; }
		function leaseClockNow() { return CLOCK.now; }
		function peerSyncShim() { return door; }
		async function selectDiamond(f) { currentDiamond = f; }
		function t(k) { return k; }
		W.show = function (f) { currentDiamond = f; };
		async function runSteer(f, text) {
			W.turns.push({ on: W.name, in: f.id });
			if (W.hold) await W.hold;
			// What the engine's \`ended\` event records: a turn that ran through, unless W.end says.
			_lastSteer[f.id] = Object.assign({ how: 'answered', calls: 0, failed: 0, refused: 0 }, W.end || {});
			return '';
		}
		async function doSteer(text) { return runSteer(currentDiamond, text); }
		${vars}
		${body}
		W.owed = function () { return Object.keys(_mailOwed).length; };
		W.prune = typeof pruneMailMarks === 'function' ? pruneMailMarks : function () {}; W.triggers = _triggers;
		var Triggers = {
			of: function (id) { return _triggers[id].actions; },
			save: async function () {},
			${extractMethod(APP, 'fire')},
			${extractMethod(APP, 'retryMail')},
		};
		return Triggers;`)(W, DaimondTriggers, peer, door, CLOCK,
		(fn) => { const id = ++W.seq; W.timers.set(id, fn); return id; },
		(id) => { W.timers.delete(id); });
	return W;
}

const ARRIVED = { kind: 'mail', mailbox: 'alerts@oxegen.io', folder: 'INBOX', uids: [41, 42], uidValidity: 7 };
const settle = () => new Promise((r) => setTimeout(r, 50));

test('R1: a device that wakes 17 minutes after the arrival was answered runs nothing', async () => {
	const door = makeDoor(), turns = [];
	const P = device('desk', door, turns), D = device('phone', door, turns);
	await P.api.fire(ARRIVED);
	assert.equal(turns.length, 1);
	CLOCK.now += 17 * 60 * 1000;
	// The desk's next arrival writes the door, which drains every lease past its life.
	P.held = { uidValidity: 7, lastUid: 50 };
	await P.api.fire(Object.assign({}, ARRIVED, { uids: [50] }));
	assert.equal(turns.length, 2);
	await D.api.fire(ARRIVED);
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'the phone re-ran an arrival the desk answered: ' + JSON.stringify(turns));
	assert.equal(D.owed(), 0, 'an answered arrival is still owed on the phone');
});

test('R2: a turn longer than 15 minutes is never run twice', async () => {
	const door = makeDoor(), turns = [];
	const P = device('desk', door, turns), D = device('phone', door, turns);
	let done; P.hold = new Promise((r) => { done = r; });
	const pf = P.api.fire(ARRIVED);
	await settle();
	await D.api.fire(ARRIVED);
	for (let i = 0; i < 40; i++) {		// 20 minutes, the desk alive and its turn running
		CLOCK.now += TICK;
		await P.tick();
		await D.api.retryMail();
	}
	assert.equal(turns.length, 1, 'a live, slow desk turn was run again: ' + JSON.stringify(turns));
	done(); await pf;
	await D.api.retryMail();
	assert.equal(turns.length, 1, 'the phone ran the arrival after the desk answered it');
	assert.equal(D.owed(), 0, 'an answered arrival is still owed on the phone');
});

test('R3: a winner that dies mid-turn leaves the arrival to the waiting device, run exactly once', async () => {
	const door = makeDoor(), turns = [];
	const P = device('desk', door, turns), D = device('phone', door, turns);
	P.hold = new Promise(() => {});
	P.api.fire(ARRIVED);
	await settle();
	P.dead = true;
	await D.api.fire(ARRIVED);
	assert.equal(turns.length, 1);
	CLOCK.now += 17 * 60 * 1000;		// the phone's tab slept well past any deadline
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'nobody ran the arrival to completion: ' + JSON.stringify(turns));
	assert.equal(turns[1].on, 'phone');
	await D.api.retryMail();
	CLOCK.now += 17 * 60 * 1000;
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'the arrival ran more than once after the desk died');
});

test('a lone device that reloads mid-turn still answers the arrival, once', async () => {
	const door = makeDoor(), turns = [];
	const P = device('desk', door, turns);
	P.hold = new Promise(() => {});
	P.api.fire(ARRIVED);
	await settle();
	P.dead = true;					// reloaded: the page and its memory are gone
	CLOCK.now += 60 * 1000;
	const R = device('desk', door, turns);	// the same device, a fresh page
	R.peer.DaimondLease.adopt(door.peek());	// its boot pull adopts the lease section
	await R.api.retryMail();
	assert.equal(turns.length, 2, 'the reload lost the arrival: ' + JSON.stringify(turns));
	await R.api.retryMail();
	CLOCK.now += 17 * 60 * 1000;
	await R.api.retryMail();
	assert.equal(turns.length, 2, 'the arrival ran again after it was answered');
});

test('a new message above the answered mark is still its own turn', async () => {
	const door = makeDoor(), turns = [];
	const P = device('desk', door, turns), D = device('phone', door, turns);
	await P.api.fire(ARRIVED);
	D.held = { uidValidity: 7, lastUid: 43 };
	await D.api.fire(Object.assign({}, ARRIVED, { uids: [43] }));
	assert.equal(turns.length, 2, 'a later message was taken as answered');
});

test('a device that stands down on an answered arrival learns its mark', async () => {
	const door = makeDoor(), turns = [];
	const P = device('desk', door, turns), D = device('phone', door, turns);
	await P.api.fire(ARRIVED);
	await settle();
	assert.equal(turns.length, 1);
	const key = Object.keys(door.peek()).find((k) => k.startsWith('mark:mail:'));
	assert.equal(door.peek()[key].mark, 42, 'the desk did not raise the mark on the door');
	await D.api.fire(ARRIVED);
	assert.equal(turns.length, 1, 'the phone re-ran an answered arrival');
	const mk = D.peer.DaimondLease.record(key);
	assert.ok(mk && mk.mark === 42 && mk.gen === 7, 'the phone stood down without the mark it read: ' + JSON.stringify(mk));
});

// r569 A1: a generation is an identity. A folder rebuilt to a UIDVALIDITY above 2^31, or
// moved to a server that numbers it lower, must still run its next arrival.
for (const [name, uv] of [['above 2^31', 3_000_000_000], ['lower, after a server move', 5]]) {
	test('A1: a new generation ' + name + ' still runs its next arrival', async () => {
		const door = makeDoor(), turns = [];
		const P = device('desk', door, turns), D = device('phone', door, turns);
		await P.api.fire(ARRIVED);
		assert.equal(turns.length, 1);
		D.held = { uidValidity: uv, lastUid: 3 };
		await D.api.fire(Object.assign({}, ARRIVED, { uids: [3], uidValidity: uv }));
		assert.equal(turns.length, 2, 'the new generation was dropped as answered');
		const key = Object.keys(door.peek()).find((k) => k.startsWith('mark:mail:'));
		assert.equal(door.peek()[key].gen, uv, 'the mark did not move to the new generation');
		await D.api.retryMail();
		assert.equal(turns.length, 2, 'the new generation ran twice');
	});
}

// r569 A3: a mark is retired when nothing watches its folder, and drained a horizon later.
test('A3: a deleted mail action retires its folder mark, which then drains', async () => {
	const door = makeDoor(), turns = [];
	const P = device('desk', door, turns);
	await P.api.fire(ARRIVED);
	const key = Object.keys(door.peek()).find((k) => k.startsWith('mark:mail:'));
	P.prune('B');
	await settle();
	assert.ok(!door.peek()[key].retired, 'a watched folder lost its mark');
	P.triggers.B.actions = [];
	P.prune('B');
	await settle();
	assert.equal(door.peek()[key].retired, 1, 'the mark outlived its action');
	CLOCK.now += 31 * 24 * 3600 * 1000;
	const cas = P.peer.DaimondPeer.syncCas(door);
	await P.peer.DaimondLease.mark('mark:mail:Z::', 1, 1, cas, () => CLOCK.now);
	assert.equal(door.peek()[key], undefined, 'a retired mark was never drained');
});

// r569 A4: a paused action never fires, so what arrived in the pause is owed nothing.
test('A4: mail that arrived while the action was paused runs no turn on release', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	try {
		await D.api.fire(ARRIVED);
		assert.equal(turns.length, 1);
		PAUSED = true;
		D.held = { uidValidity: 7, lastUid: 45 };
		await D.api.retryMail();
		assert.equal(turns.length, 1, 'a paused action fired');
		PAUSED = false;
		await D.api.retryMail();
		assert.equal(turns.length, 1, 'the release ran a turn for mail from the pause');
		D.held = { uidValidity: 7, lastUid: 46 };
		await D.api.retryMail();
		assert.equal(turns.length, 2, 'mail after the release is owed nothing');
	} finally { PAUSED = false; }
});

// r569 B-1: routine quiet ends `answered`, so a mail turn that ends `silent` or `reasoned_only`
// answered nothing. One judgement of the ending raises `turn-failed` on Pending AND keeps the
// folder's answered mark down, off screen and on screen alike.
function alertsOn(W) {
	const seen = { raised: [], cleared: [] };
	W.peer.DaimondAlerts = {
		raise: (id, key) => { seen.raised.push(key); return true; },
		clear: (id, key) => { seen.cleared.push(key); return true; },
	};
	return seen;
}
const answeredMark = (door) => Object.entries(door.peek())
	.filter(([k, v]) => k.startsWith('mark:mail:') && typeof v.mark === 'number' && v.mark >= 42);

for (const [where, end] of [
	['off screen', { how: 'silent', calls: 0 }],
	['off screen', { how: 'reasoned_only', calls: 1 }],
	['on screen', { how: 'silent', calls: 0 }],
	['on screen', { how: 'reasoned_only', calls: 1 }],
]) {
	test('B-1: a mail turn ' + where + ' ending ' + end.how + ' raises turn-failed and leaves the arrival unanswered', async () => {
		const door = makeDoor(), turns = [];
		const D = device('phone', door, turns);
		if (where === 'on screen') D.show(D.B);
		const seen = alertsOn(D);
		D.end = end;
		await D.api.fire(ARRIVED);
		assert.equal(turns.length, 1);
		assert.deepEqual(seen.raised, ['turn-failed'], 'the failed mail turn reached no one');
		assert.deepEqual(answeredMark(door), [], 'a failed turn marked the arrival answered for good');
	});
}

test('B-1: a mail turn that ends answered marks the arrival and raises nothing', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	await D.api.fire(ARRIVED);
	assert.deepEqual(seen.raised, []);
	assert.deepEqual(seen.cleared, ['turn-failed']);
	assert.equal(answeredMark(door).length, 1, 'an answered arrival was not marked');
});

test('B-1: an arrival whose turn failed is owed again once its claim drains, and answered then', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	alertsOn(D);
	D.end = { how: 'silent', calls: 0 };
	await D.api.fire(ARRIVED);
	await D.api.retryMail();
	assert.equal(turns.length, 1, 'the failed arrival was re-run at once');
	CLOCK.now += 17 * 60 * 1000;
	D.end = null;
	const cas = D.peer.DaimondPeer.syncCas(door);
	await D.peer.DaimondLease.mark('mark:mail:Z::', 1, 1, cas, () => CLOCK.now);	// a write drains
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'the failed arrival was never owed again');
	assert.equal(answeredMark(door).length, 1, 'the retried turn did not mark the arrival');
});
