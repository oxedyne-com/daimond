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
function extractObjMethod(src, name) {
	const m = new RegExp('\\n\\t+' + name + ': function \\(').exec(src);
	return m ? balanced(src, m.index + 1) : '';
}
// The lines of `Workers.dispatch` that tie a batch to the pending-only turn that dispatched it.
function dispatchFollow(src) {
	const a = src.indexOf('\t\t\tvar how = (owner && owner.how && owner.how.follow)');
	const b = a < 0 ? -1 : src.indexOf('\t\t\tspecs.forEach(', a);
	return a < 0 || b < 0 ? '' : src.slice(a, b);
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
	W.A = { id: 'A', name: 'Work' }; W.B = { id: 'B', name: 'Email', messages: [] };
	W.polls = [];		// the report-back round's 1.5 s idle polls, run by hand
	W.mailB = Object.assign(DaimondTriggers.blank('mail'), {
		id: 'm1', mailbox: 'alerts@oxegen.io', folder: 'INBOX', instruction: 'Triage the alert.',
	});
	W.tick = async () => { if (!W.dead) for (const fn of [...W.timers.values()]) await fn(); };
	const names = ['offScreenSteerAllowed', 'steerFromTrigger', 'oweMail', 'mailMarkKey',
		'mailClaimId', 'claimMailArrival', 'seedMailMark', 'keepMailClaim', 'settleMailClaim', 'owedByMark', 'mailGen', 'mailFloors', 'mailFloorsWrite', 'pruneMailMarks',
		'judgeTriggeredTurn', 'followVerdicts'];
	const body = names.map((n) => extractFn(APP, n)).join('\n');
	const vars = ['MAIL_CLAIM_GRACE_MS', 'MAIL_FLOOR_KEY', '_mailFloor', 'MAIL_TRIES_MAX', '_mailTries', 'FOLLOW_MAX_MS'].map((n) => extractVar(APP, n)).join('\n');
	W.api = new Function('W', 'DaimondTriggers', 'window', 'door', 'CLOCK', 'setInterval', 'clearInterval', 'setTimeout', `
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
		async function runSteer(f, text, depth, detached, how) {
			W.turns.push({ on: W.name, in: f.id, how: how, depth: depth });
			if (W.round) W.round(W.turns.length, how, Workers);
			if (W.hold) await W.hold;
			// What the engine's \`ended\` event records: a turn that ran through, unless W.end says.
			_lastSteer[f.id] = Object.assign({ how: 'answered', calls: 0, failed: 0, refused: 0 }, W.end || {},
				(W.endFor && W.endFor(W.turns.length)) || {});
			return '';
		}
		async function doSteer(text, depth, how) { return runSteer(currentDiamond, text, depth, null, how); }
		// The worker pool, far enough for a turn's fan-out: the REAL \`gather\`, and the REAL lines
		// of \`dispatch\` that tie a batch to the turn that dispatched it.
		function workerEndingNote() { return ''; }
		function reportBody(r) { return r.report || ''; }
		function withCommas(s) { return s; }
		function reportHasSubstance(r) { return !!r.report; }
		function workersHeld() { return false; }
		function setCrystalStatus() {}
		function touchChat() {}
		function persistChats() {}
		function newMid() { return 'm' + (++W.seq); }
		function appendNote(text) { (W.noted = W.noted || []).push(text); }
		var current = W.B;
		var Workers = {
			batches: {}, runs: [], liveTurns: {}, MAX_GATHER_DEPTH: 3, batchSeq: 0,
			isTerminal: function (s) { return s === 'done' || s === 'error'; },
			${extractObjMethod(APP, 'tellDaimon')},
			deliverToChat: function () { W.delivered = true; },
			${extractObjMethod(APP, 'gather')},
			fanOut: function (owner) {
				var batch = 'b' + (++this.batchSeq);
				this.batches[batch] = { diamondId: 'B', diamondName: 'Email', chatId: '', chatName: '',
					turnId: '', depth: 0, expected: 1, ids: [] };
				${dispatchFollow(APP)}
				var run = { id: 'w' + this.batchSeq, name: 'w' + this.batchSeq, batch: batch, status: 'running' };
				this.runs.push(run);
				return run;
			},
		};
		W.workers = Workers;
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
		(id) => { W.timers.delete(id); },
		(fn, ms) => (ms === 1500 ? W.polls.push(fn) : setTimeout(fn, ms)));
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
		assert.deepEqual(seen.raised, ['turn-failed.mail'], 'the failed mail turn reached no one');
		assert.deepEqual(answeredMark(door), [], 'a failed turn marked the arrival answered for good');
	});
}

test('B-1: a mail turn that ends answered marks the arrival and raises nothing', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	await D.api.fire(ARRIVED);
	assert.deepEqual(seen.raised, []);
	assert.deepEqual(seen.cleared, ['turn-failed.mail']);
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

// POST-QA r569qa2 (2026-10-17): a mail turn cut off before it finished answered nothing either.
// `stopped` is the engine's word for a turn halted mid-flight -- the person's lock (`lockApp`
// aborts every generating record, the daimon's included), a pause caught mid-turn (`brakeHeld`),
// or Stop -- and `capped` is a turn whose round budget ran out "with work still going". Neither
// reached its `pending_raise`, so neither may mark the arrival answered for every device.
for (const end of [{ how: 'stopped', calls: 1 }, { how: 'capped', calls: 4 }]) {
	test('POSTQA2: a mail turn ending ' + end.how + ' leaves the arrival unanswered for the other device', async () => {
		const door = makeDoor(), turns = [];
		const P = device('desk', door, turns), D = device('phone', door, turns);
		alertsOn(P); alertsOn(D);
		P.end = end;
		await P.api.fire(ARRIVED);			// the desk's turn is cut off (locked, paused, capped)
		assert.equal(turns.length, 1);
		assert.deepEqual(answeredMark(door), [], 'a turn cut off as ' + end.how + ' marked the arrival answered for good');
		CLOCK.now += 17 * 60 * 1000;
		const cas = D.peer.DaimondPeer.syncCas(door);
		await D.peer.DaimondLease.mark('mark:mail:Z::', 1, 1, cas, () => CLOCK.now);	// a write drains
		await D.api.fire(ARRIVED);
		await D.api.retryMail();
		assert.equal(turns.length, 2, 'nobody ever answered the arrival: ' + JSON.stringify(turns));
	});
}
test('POSTQA2: a mail turn that ran out of rounds is put in front of him', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	D.end = { how: 'capped', calls: 4 };
	await D.api.fire(ARRIVED);
	assert.deepEqual(seen.raised, ['turn-failed.mail'], 'a capped mail turn reached no one');
});

// MAIL-FIX2 Q4 (2026-10-17): a failed arrival's settled claim used to stand on the door until an
// unrelated write drained it, so on a quiet account it was never retried, and on a busy one it
// was retried without end. Past its life it is read as gone, and each device runs it a bounded
// number of times.
test('Q4: a failed arrival is owed again after its claim life with no other write on the door', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	alertsOn(D);
	D.end = { how: 'silent', calls: 0 };
	await D.api.fire(ARRIVED);
	CLOCK.now += 17 * 60 * 1000;
	D.end = null;
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'the failed arrival waited for an outside write');
	assert.equal(answeredMark(door).length, 1, 'the retried turn did not mark the arrival');
});

test('Q4: one device runs a failing arrival at most MAIL_TRIES_MAX times', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	alertsOn(D);
	D.end = { how: 'reasoned_only', calls: 0 };
	await D.api.fire(ARRIVED);
	for (let i = 0; i < 6; i++) {
		CLOCK.now += 17 * 60 * 1000;
		await D.api.fire(ARRIVED);
		await D.api.retryMail();
	}
	assert.equal(turns.length, 3, 'a failing arrival was retried without bound: ' + turns.length);
	assert.deepEqual(answeredMark(door), [], 'giving up marked the arrival answered');
});

test('Q4: a turn the person stopped is not counted against the bound, and raises nothing', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	D.end = { how: 'stopped', calls: 1 };
	for (let i = 0; i < 4; i++) {
		await D.api.fire(ARRIVED);
		CLOCK.now += 17 * 60 * 1000;
	}
	assert.equal(turns.length, 4, 'a stopped turn used up the retries');
	assert.deepEqual(seen.raised, [], 'a stopped turn raised an alert');
	D.end = null;
	await D.api.fire(ARRIVED);
	assert.equal(answeredMark(door).length, 1);
});

// MAIL-FIX2 Q3 (2026-10-17): a mail turn that dispatched an agent answered nothing until the round
// that reads its report did. That round used to run as an ordinary turn after the mark had risen,
// posting in the Email chat and judged by nobody. Now it is a round of the same pending-only turn,
// and the arrival is marked only once it is judged answered.
const finish = (W, run, report) => { run.status = 'done'; run.report = report; W.workers.gather(run.batch); };

test('Q3: a mail turn that dispatched an agent is marked only after its report-back round answers', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	let run = null;
	D.round = (n, how) => { if (n === 1) run = D.workers.fanOut({ how: how }); };
	const pf = D.api.fire(ARRIVED);
	await settle();
	assert.ok(run, 'the mail turn dispatched nothing');
	assert.deepEqual(answeredMark(door), [], 'the arrival was marked answered before its agent reported');
	finish(D, run, 'The disk on jarrah is at 61%; nothing is wrong.');
	await pf;
	assert.equal(turns.length, 2, 'the report never came back to the turn: ' + JSON.stringify(turns));
	assert.ok(turns[1].how && turns[1].how.pendingOnly, 'the report-back round was not pending-only, so it posts in the chat');
	assert.equal(D.delivered, undefined);
	assert.equal(answeredMark(door).length, 1, 'the answered turn did not mark the arrival');
	assert.deepEqual(seen.raised, []);
});

test('Q3: a report-back round that fails leaves the arrival owed and puts it in front of him', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	let run = null;
	D.round = (n, how) => { if (n === 1) run = D.workers.fanOut({ how: how }); };
	D.endFor = (n) => (n === 2 ? { how: 'reasoned_only', calls: 0 } : null);
	const pf = D.api.fire(ARRIVED);
	await settle();
	finish(D, run, 'The certificate on karri expired an hour ago.');
	await pf;
	assert.equal(turns.length, 2);
	assert.deepEqual(answeredMark(door), [], 'a failed report-back round marked the arrival answered');
	assert.deepEqual(seen.raised, ['turn-failed.mail'], 'the failed report-back round reached no one');
});

test('Q3: an agent that reports nothing leaves the arrival owed', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	let run = null;
	D.round = (n, how) => { if (n === 1) run = D.workers.fanOut({ how: how }); };
	const pf = D.api.fire(ARRIVED);
	await settle();
	finish(D, run, '');
	await pf;
	assert.equal(turns.length, 1, 'an empty report was read back');
	assert.deepEqual(answeredMark(door), [], 'an unread report marked the arrival answered');
	assert.deepEqual(seen.raised, ['turn-failed.mail']);
});

// FIRE MAIL-FIX2 r2 (check item 3, 2026-10-17): a mail turn's report-back round that cannot run
// put the agents' reports in the Email chat, which posts nothing there (rulings §16). They go into
// the daimon's own conversation alone, for the next mail turn, and turn-failed is what he sees.
const chatNotes = (W) => W.B.messages.filter((m) => m.role === 'note_log');
const sessionSaid = (W) => ((W.B.session && W.B.session.msgs) || []).map((m) => m.content).join('\n');

test('MAIL-FIX2 r2: an unread mail report goes into the daimon\'s conversation, never the Email chat', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	let run = null;
	D.round = (n, how) => { if (n === 1) run = D.workers.fanOut({ how: how }); };
	const pf = D.api.fire(ARRIVED);
	await settle();
	finish(D, run, '');
	await pf;
	assert.deepEqual(chatNotes(D), [], 'the agents\' reports were posted in the Email chat');
	assert.equal(D.noted, undefined, 'the agents\' reports were drawn in the Email thread');
	assert.match(sessionSaid(D), /Worker w1 finished/, 'the next mail turn will not read the reports');
	assert.deepEqual(seen.raised, ['turn-failed.mail'], 'the unread report reached no one');
});

test('MAIL-FIX2 r2: a mail report-back round waits out a busy Diamond, past a minute, and then runs', async () => {
	const door = makeDoor(), turns = [];
	const D = device('phone', door, turns);
	const seen = alertsOn(D);
	let run = null;
	D.round = (n, how) => { if (n === 1) run = D.workers.fanOut({ how: how }); };
	const pf = D.api.fire(ARRIVED);
	await settle();
	D.busy.add('B');					// a second mail turn holds the Diamond
	finish(D, run, 'The disk on jarrah is at 61%; nothing is wrong.');
	await settle();
	for (let i = 0; i < 80; i++) {			// two minutes of 1.5 s polls
		const p = D.polls.splice(0);
		assert.equal(p.length, 1, 'the round stopped waiting after ' + (i * 1.5) + ' s');
		p[0]();
	}
	assert.deepEqual(chatNotes(D), [], 'a busy Diamond put the reports in the Email chat');
	assert.equal(turns.length, 1);
	D.busy.delete('B');
	D.polls.splice(0).forEach((fn) => fn());
	await pf;
	assert.equal(turns.length, 2, 'the report-back round never ran');
	assert.equal(answeredMark(door).length, 1, 'the answered round did not mark the arrival');
	assert.deepEqual(seen.raised, []);
});
