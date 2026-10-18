// mailclaim.test.mjs -- one turn per new message, however many devices are open (MO-1).
//
//	node --test www/js/mailclaim.test.mjs
//
// Each open, unlocked device polls the synced mailbox and announces the same arrival, and
// since MAIL-OFFSCREEN each one fired its own off-screen turn for it: N devices, N turns,
// N bills. Now an arrival is CLAIMED on the lease door before its turn runs, keyed by
// Diamond, mailbox, folder, uidvalidity and uid; the device that loses does nothing, and
// a claim whose holder dies lapses so another device takes it and nothing is lost.
//
// Two devices, each the REAL `Triggers.fire` / `retryMail` / `steerFromTrigger` and the
// claim helpers lifted from daimond.js, each over its OWN copy of the real peer.js
// DaimondLease, sharing ONE lease door. Red on 6d8c1373: both devices run the turn.
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

globalThis.window = { DaimondPause: { isPaused: () => false, triggerLeaf: (d, a) => d + '/' + a } };
const DaimondTriggers = require('./triggers.js');

const CLOCK = { now: 1_800_000_000_000 };

// One open device: Diamond A on screen, Diamond B watching alerts@.
function device(name, door, turns, opts) {
	const peer = loadPeer();
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
	const W = { name, turns, busy: new Set(), hold: null };
	// The page's first pull lands: sync.js raises `daimond:heard` once.
	W.hear = () => { said.heard = true; heardBy.splice(0).forEach((fn) => fn()); };
	W.A = { id: 'A', name: 'Work' }; W.B = { id: 'B', name: 'Email' };
	W.mailB = Object.assign(DaimondTriggers.blank('mail'), {
		id: 'm1', mailbox: 'alerts@oxegen.io', folder: 'INBOX', instruction: 'Triage the alert.',
	});
	const names = ['offScreenSteerAllowed', 'steerFromTrigger', 'oweMail',
		'mailMarkKey', 'mailClaimId', 'syncsHere', 'retryMailOnHeard', 'claimMailArrival', 'trailTrigger', 'seedMailMark', 'keepMailClaim', 'settleMailClaim', 'owedByMark', 'mailGen', 'mailFloors', 'mailFloorsWrite', 'pruneMailMarks', 'judgeTriggeredTurn', 'followVerdicts'];
	const body = names.map((n) => extractFn(APP, n)).join('\n');
	const vars = ['MAIL_CLAIM_GRACE_MS', 'MAIL_FLOOR_KEY', '_mailFloor', 'FOLLOW_MAX_MS', '_mailHeardArmed'].map((n) => extractVar(APP, n)).join('\n');
	W.api = new Function('W', 'DaimondTriggers', 'window', 'door', 'CLOCK', `
		var diamonds = [W.A, W.B], currentDiamond = W.A, _mailOwed = {}, _mailRunning = {}, _mailTries = {}, MAIL_TRIES_MAX = 3, _lastSteer = {};
		var _triggers = { A: { v: 1, actions: [] }, B: { v: 1, actions: [W.mailB] } };
		var DaimondLease = window.DaimondLease, DaimondPeer = window.DaimondPeer;
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

test('two devices see the same arrival at once: one turn in all', async () => {
	const door = makeDoor(), turns = [];
	const P = device('phone', door, turns), D = device('desk', door, turns);
	const [a, b] = await Promise.all([P.api.fire(ARRIVED), D.api.fire(ARRIVED)]);
	assert.equal(turns.length, 1, 'the arrival ran ' + turns.length + ' turns: ' + JSON.stringify(turns));
	assert.equal(a.length + b.length, 1, 'both devices reported a firing');
	// The winner settled its claim, so the loser's retry stands down for good.
	await P.api.retryMail(); await D.api.retryMail();
	assert.equal(turns.length, 1, 'a retry ran the claimed arrival again');
	assert.equal(P.owed() + D.owed(), 0, 'a settled arrival is still owed');
});

test('a device that sees the arrival after the winner finished runs nothing', async () => {
	const door = makeDoor(), turns = [];
	const P = device('phone', door, turns), D = device('desk', door, turns);
	await P.api.fire(ARRIVED);
	await D.api.fire(ARRIVED);
	assert.equal(turns.length, 1);
	assert.equal(turns[0].on, 'phone');
});

test('a new message after the claimed one is its own turn', async () => {
	const door = makeDoor(), turns = [];
	const P = device('phone', door, turns), D = device('desk', door, turns);
	await P.api.fire(ARRIVED);
	await D.api.fire(Object.assign({}, ARRIVED, { uids: [43] }));
	assert.equal(turns.length, 2, 'a later message was taken for the earlier one');
});

test('a claimant that dies: the arrival is taken by another device once its claim lapses', async () => {
	const door = makeDoor(), turns = [];
	const P = device('phone', door, turns), D = device('desk', door, turns);
	// The phone claims and starts, then is gone: its turn never ends, its claim never settles.
	let never; P.hold = new Promise((r) => { never = r; });
	P.api.fire(ARRIVED);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(turns.length, 1);
	await D.api.fire(ARRIVED);
	assert.equal(turns.length, 1, 'the desk ran an arrival the phone holds');
	assert.equal(D.owed(), 1, 'the desk forgot the arrival it lost, so a dead claimant loses it');
	await D.api.retryMail();
	assert.equal(turns.length, 1, 'the desk ran it while the phone\'s claim was live');
	CLOCK.now += 16 * 60 * 1000;		// past the claim's deadline
	await D.api.retryMail();
	assert.equal(turns.length, 2, 'the lapsed claim was never taken over');
	assert.equal(turns[1].on, 'desk');
	never();
});

// A door that never answers 200: no sync tier, Safe mode, or sync unreachable (S1MF-live).
function deadDoor() {
	return {
		read: async () => ({ version: 0, leases: {}, unread: true }),
		commit: async () => ({ ok: false, why: 'unread' }),
	};
}

for (const never of ['identity', 'safe', 'tier']) {
	test('a page that can never coordinate (' + never + ') runs the arrival though the door is unreadable', async () => {
		const turns = [], trail = [];
		const P = device('phone', deadDoor(), turns, { heard: false, never, trail });
		const fired = await P.api.fire(ARRIVED);
		assert.equal(turns.length, 1, 'a device that cannot sync never ran its mail trigger: ' + JSON.stringify(trail));
		assert.equal(fired.length, 1);
		assert.equal(P.owed(), 0);
	});
}

// QA r572w B N2: a syncing page whose first pull is not back yet is not a page without sync.
test('a syncing page that has not heard yet does not run an arrival another device ran', async () => {
	const door = makeDoor(), turns = [];
	const D = device('desk', door, turns);
	await D.api.fire(ARRIVED);						// the desk claims, runs and settles it
	const P = device('phone', door, turns, { heard: false });	// unlocked, boot pull still out
	await P.api.fire(ARRIVED);
	assert.deepEqual(turns.map((t) => t.on), ['desk'], 'the arrival ran twice (MO-1)');
	assert.equal(P.owed(), 1, 'the unheard arrival was not held owed');
	P.hear();
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(turns.map((t) => t.on), ['desk'], 'the retry after the pull ran a settled arrival');
	assert.equal(P.owed(), 0, 'a settled arrival is still owed after the pull');
});

test('an arrival held unheard runs once the first pull lands, and not before', async () => {
	const door = makeDoor(), turns = [], trail = [];
	const P = device('phone', door, turns, { heard: false, trail });
	const fired = await P.api.fire(ARRIVED);
	assert.equal(turns.length, 0, 'a page that had not heard ran the arrival blind');
	assert.equal(fired.length, 0);
	assert.ok(trail.some(([w, d]) => w === 'trigger' && /unheard/.test(d)),
		'the hold left no trail row naming why: ' + JSON.stringify(trail));
	await P.api.retryMail();						// a tick while the door is still unreachable
	assert.equal(turns.length, 0, 'a tick before the first pull ran the arrival blind');
	assert.equal(P.owed(), 1);
	P.hear();
	await new Promise((r) => setTimeout(r, 50));
	assert.deepEqual(turns.map((t) => t.on), ['phone'], 'the held arrival did not run after the pull');
	assert.equal(P.owed(), 0);
});

test('a page that has heard the mailbox keeps the stand-down, and says so on the trail', async () => {
	const turns = [], trail = [];
	const P = device('phone', deadDoor(), turns, { heard: true, trail });
	const fired = await P.api.fire(ARRIVED);
	assert.equal(turns.length, 0, 'a synced page ran past an undecided claim');
	assert.equal(fired.length, 0);
	assert.equal(P.owed(), 1, 'the refused arrival was not kept owed');
	assert.ok(trail.some(([w, d]) => w === 'trigger' && /unread/.test(d)),
		'the refusal left no trail row naming why: ' + JSON.stringify(trail));
});
