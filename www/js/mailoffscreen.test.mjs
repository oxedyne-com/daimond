// mailoffscreen.test.mjs -- mail arriving for a Diamond nobody is looking at fires there
// (D-20261016-17).
//
//	node --test www/js/mailoffscreen.test.mjs
//
// `Triggers.fire`, `Triggers.retryMail`, `steerFromTrigger`, `offScreenSteerAllowed` and
// `oweMail` are lifted from the REAL daimond.js by a brace-balanced scan, and `due`, `allowed`
// and `compose` are the real triggers.js, over a stand-in pause tree. With Diamond A on screen
// and Diamond B watching a mailbox, an arrival for B must run one turn in B -- in B's own
// thread, the screen unmoved -- and none in A; a paused leaf never fires; a busy B gets no
// second turn, and the arrival it refused is asked again rather than lost.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

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

const paused = new Set();
globalThis.window = { DaimondPause: { isPaused: (node) => paused.has(node), triggerLeaf: (d, a) => d + '/' + a } };
const DaimondTriggers = require('./triggers.js');

function mailTA(id, extra) {
	return Object.assign(DaimondTriggers.blank('mail'), {
		id, mailbox: 'alerts@oxegen.io', folder: 'INBOX', instruction: 'Triage the alert.',
	}, extra || {});
}

function world(mailB) {
	const W = { turns: [], selected: [], busy: new Set(), typed: '', mailB };
	const A = { id: 'A', name: 'Work' }, B = { id: 'B', name: 'Email' };
	W.A = A; W.B = B;
	const body = ['offScreenSteerAllowed', 'steerFromTrigger', 'oweMail',
		'mailMarkKey', 'mailClaimId', 'claimMailArrival', 'seedMailMark', 'keepMailClaim', 'settleMailClaim', 'owedByMark', 'mailGen', 'mailFloors', 'mailFloorsWrite', 'pruneMailMarks', 'judgeTriggeredTurn', 'followVerdicts'].map((n) => extractFn(APP, n)).join('\n');
	const fire = extractMethod(APP, 'fire'), retry = extractMethod(APP, 'retryMail');
	W.api = new Function('W', 'DaimondTriggers', `
		var diamonds = [W.A, W.B], currentDiamond = W.A, _mailOwed = {}, _mailRunning = {}, _mailTries = {}, MAIL_TRIES_MAX = 3, _lastSteer = {}, MAIL_FLOOR_KEY = 'daimond.mail.floor', _mailFloor = null, FOLLOW_MAX_MS = 20 * 60 * 1000;
		function t(k, v) { return k + (v ? ' ' + JSON.stringify(v) : ''); }
		var _triggers = {
			A: { v: 1, actions: [] },
			B: { v: 1, actions: [W.mailB] },
		};
		var document = { getElementById: function (id) { return id === 'chat-input' ? { value: W.typed } : null; } };
		function diamondBusy(id) { return W.busy.has(id); }
		function askOpenIn() { return false; }
		function daimonChat(f) { return f; }
		function diamondCanRun() { return true; }
		function proposeFromTurn() {}
		// One device, no lease door: the claim (mailclaim.test.mjs) runs unclaimed here.
		function selfDeviceId() { return ''; }
		function leaseClockNow() { return Date.now(); }
		function diag() {}
		async function selectDiamond(f) { W.selected.push(f.id); currentDiamond = f; }
		async function runSteer(f, text) {
			W.turns.push({ in: f.id, text: text, screen: currentDiamond.id });
			if (W.how === 'throw') throw new Error('provider down');
			// What the engine's \`ended\` event records (\`_lastSteer\`); nothing at all when it never ran.
			if (W.how) _lastSteer[f.id] = Object.assign({ how: W.how }, W.end || {});
			return '';
		}
		async function doSteer(text) { return runSteer(currentDiamond, text); }
		${body}
		W.owed = function () { return Object.keys(_mailOwed).length; };
		var Triggers = {
			of: function (id) { return _triggers[id].actions; },
			save: async function () {},
			${fire},
			${retry},
		};
		return Triggers;`)(W, DaimondTriggers);
	return W;
}

const ARRIVED = { kind: 'mail', mailbox: 'alerts@oxegen.io', folder: 'INBOX' };

test('mail for B while A is on screen runs one turn in B and none in A', async () => {
	paused.clear();
	const W = world(mailTA('m1'));
	const fired = await W.api.fire(ARRIVED);
	assert.deepEqual(fired, [{ id: 'B', actionId: 'm1' }], 'the arrival did not fire B\'s mail trigger');
	assert.equal(W.turns.length, 1, 'expected exactly one turn');
	assert.equal(W.turns[0].in, 'B', 'the turn ran somewhere other than B');
	assert.equal(W.turns[0].text, 'Triage the alert.');
	assert.equal(W.turns[0].screen, 'A', 'the screen moved off A');
	assert.deepEqual(W.selected, [], 'a Diamond was selected behind the person');
});

test('a paused mail trigger never fires, now or on a retry', async () => {
	paused.clear();
	paused.add(DaimondTriggers.node('B', 'm1'));
	const W = world(mailTA('m1'));
	assert.deepEqual(await W.api.fire(ARRIVED), []);
	await W.api.retryMail();
	assert.equal(W.turns.length, 0, 'a paused leaf spent a turn');
	assert.equal(W.owed(), 0, 'a paused arrival was held to fire later');
	paused.clear();
});

test('a busy B gets no second turn, and the refused arrival goes once B is free', async () => {
	paused.clear();
	const W = world(mailTA('m1'));
	W.busy.add('B');
	assert.deepEqual(await W.api.fire(ARRIVED), []);
	assert.equal(W.turns.length, 0, 'a second turn started in a busy Diamond');
	await W.api.retryMail();
	assert.equal(W.turns.length, 0, 'the retry ran while B was still busy');
	W.busy.delete('B');
	await W.api.retryMail();
	assert.equal(W.turns.length, 1, 'the refused arrival was lost');
	assert.equal(W.turns[0].in, 'B');
	await W.api.retryMail();
	assert.equal(W.turns.length, 1, 'the arrival fired twice');
});

test('somebody mid-sentence holds the mail turn, which goes when the box is empty', async () => {
	paused.clear();
	const W = world(mailTA('m1'));
	W.typed = 'half a line';
	assert.deepEqual(await W.api.fire(ARRIVED), []);
	W.typed = '';
	await W.api.retryMail();
	assert.equal(W.turns.length, 1);
	assert.equal(W.turns[0].in, 'B');
});

test('an activity timer that has not asked still waits for the screen', async () => {
	paused.clear();
	const ta = Object.assign(DaimondTriggers.blank('activity'), { id: 't1', instruction: 'Check.', minutes: 1 });
	const W = world(ta);
	const fired = await W.api.fire({ kind: 'activity', minutesFor: () => 5 });
	assert.deepEqual(fired, []);
	assert.equal(W.turns.length, 0, 'an un-asked timer ran off screen');
	assert.equal(W.owed(), 0, 'a timer was held as owed mail');
});

test('a later arrival that fires settles the turn owed for that folder (MO-2)', async () => {
	paused.clear();
	const W = world(mailTA('m1'));
	W.busy.add('B');
	assert.deepEqual(await W.api.fire(ARRIVED), []);
	assert.equal(W.owed(), 1, 'the refused arrival was not held');
	W.busy.delete('B');
	await W.api.fire(ARRIVED);
	assert.equal(W.turns.length, 1);
	assert.equal(W.owed(), 0, 'the turn that ran left the folder still owed');
	await W.api.retryMail();
	assert.equal(W.turns.length, 1, 'the retry ran a redundant second turn');
});

// The Pending panel's alerts (fire/alertpending's DaimondAlerts), recorded.
const ALERTS = [];
globalThis.window.DaimondAlerts = {
	raise: (d, k, h, x, n) => { ALERTS.push({ op: 'raise', d, k, h, x, n }); return 'new'; },
	clear: (d, k) => { ALERTS.push({ op: 'clear', d, k }); return true; },
};

test('a background mail turn that fails raises a turn-failed alert naming its Diamond', async () => {
	// `silent` over a failed call: an empty ending with nothing failed is routine mail (R569 R4).
	for (const how of ['failed', 'silent', 'throw', null]) {
		paused.clear(); ALERTS.length = 0;
		const W = world(mailTA('m1'));
		W.how = how;
		if (how === 'silent') W.end = { failed: 1 };
		await W.api.fire(ARRIVED).catch(() => {});
		assert.equal(W.turns.length, 1);
		const r = ALERTS.find((a) => a.op === 'raise');
		assert.ok(r, 'a ' + how + ' background turn reached no one: ' + JSON.stringify(ALERTS));
		assert.equal(r.d, 'B'); assert.equal(r.k, 'turn-failed.mail'); assert.equal(r.n, true);
		assert.ok(r.h.includes('Email'), 'the alert does not name the Diamond: ' + r.h);
	}
});

test('a background mail turn that ends well clears the turn-failed alert', async () => {
	paused.clear(); ALERTS.length = 0;
	const W = world(mailTA('m1'));
	W.how = 'answered';
	await W.api.fire(ARRIVED);
	// And the r569 mail failure under the bare key, on a Diamond with no other kind of action (MAIL-FU3).
	assert.deepEqual(ALERTS.map((a) => a.op + ':' + a.d + ':' + a.k), ['clear:B:turn-failed.mail', 'clear:B:turn-failed']);
});

// The shape against fire/alertpending's REAL alerts.js (cd0f018e), when that tree is at hand:
// the key, headline and detail this page writes must pass its `clean()` bounds, or the raise
// answers null and the failure is seen nowhere after all.
test('the turn-failed alert passes fire/alertpending\'s own bounds', async (tt) => {
	const AP = '/home/jason/lanes/oxedyne/ap/web/apps/oxedyne/lane-ap';
	let src = '';
	try { src = (await import('node:child_process')).execFileSync('git', ['-C', AP, 'show', 'cd0f018e:www/js/alerts.js'], { encoding: 'utf8' }); }
	catch (e) { tt.skip('fire/alertpending is not at hand'); return; }
	const mem = new Map();
	const win = { localStorage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) },
		dispatchEvent: () => true };
	globalThis.CustomEvent ??= class { constructor(t) { this.type = t; } };
	new Function('window', src)(win);
	const EN = {};
	globalThis.window.DaimondI18n = undefined;
	readFileSync(join(HERE, '../i18n/en.js'), 'utf8').replace(/'(pending\.turn_failed(?:_detail)?)':\s*'((?:[^'\\]|\\.)*)'/g,
		(m, k, v) => { EN[k] = v.replace(/\\'/g, "'"); });
	assert.ok(EN['pending.turn_failed'] && EN['pending.turn_failed_detail'], 'the English is missing');
	const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => v[k]);
	const name = 'N'.repeat(60);
	const was = win.DaimondAlerts.raise('B', 'turn-failed', fill(EN['pending.turn_failed'], { name }),
		fill(EN['pending.turn_failed_detail'], { name, when: '23:59' }), true);
	assert.equal(was, 'new', 'the real alerts.js refused the alert');
	assert.equal(win.DaimondAlerts.count(), 1);
	assert.equal(win.DaimondAlerts.clear('B', 'turn-failed'), true);
});

// FIRE MAIL-FIX2 r2 (check defect 2, 2026-10-17): an arrival held out past MAIL_TRIES_MAX has
// turn-failed as its one trace, and a timer turn of the same Diamond that ran well took it down.
// A mail turn's failure is now its own alert, which only an answered mail turn clears.
test('MAIL-FIX2 r2: a timer turn that ends well leaves a mail turn\'s failure up; only an answered mail turn clears it', () => {
	const live = new Set();
	const win = { DaimondAlerts: {
		raise: (d, k) => { live.add(d + ' ' + k); return 'new'; },
		clear: (d, k) => live.delete(d + ' ' + k),
	} };
	const J = new Function('window', `
		var _lastSteer = {};
		function t(k) { return k; }
		${extractFn(APP, 'judgeTriggeredTurn')}
		return { judge: judgeTriggeredTurn, steer: _lastSteer };`)(win);
	const B = { id: 'B', name: 'Email' };
	const turn = (how, mail) => {
		const before = J.steer.B;
		J.steer.B = { how, calls: 1, failed: 0, refused: 0 };
		return J.judge(B, before, false, mail);
	};
	assert.equal(turn('silent', true), true, 'the failed mail turn was not judged failed');
	assert.equal(live.size, 1, 'the failed mail turn raised nothing');
	assert.equal(turn('answered', false), false);
	assert.equal(live.size, 1, 'a timer turn that ran well took down the mail turn\'s failure');
	assert.equal(turn('answered', true), false);
	assert.equal(live.size, 0, 'an answered mail turn left its failure up');
});
