// mailroutine.test.mjs -- routine mail is quiet, and a real failure always reaches Pending
// (review R569 R4 and R5; D-20261016-17, rulings §16).
//
//	node --test www/js/mailroutine.test.mjs
//
// The owner's words: "require the user to look in only a single place for system alerts, the
// Pending panel", and of the Email Diamond, "Post nothing in this chat". Three cases:
//
//   1. Routine mail with nothing to report leaves the chat, Pending and the badge as they were.
//   2. A real failure raises one needs-him alert, even with the Diamond's twenty already up.
//   3. Mail that needs him raises exactly one Pending item and posts nothing in the chat.
//   4. Words the model writes anyway in a mail turn go to one quiet Pending item, never the chat.
//
// `Triggers.fire`, `steerFromTrigger`, `judgeTriggeredTurn` and `quietTurnEnd` are lifted from
// the REAL daimond.js, and the Pending panel is the REAL alerts.js. `runSteer` stands in for the
// engine and keeps only its contract, which src/agent.rs proves in `cargo test --lib`
// (`test_a_pending_only_turn_*`): an empty ending with no failed call is a quiet `answered` for a
// turn marked pending-only, and is otherwise nudged into a written report; a raise that landed
// is a report; an empty ending over a failed call ends `silent`.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { makeWindow } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readPage(join(HERE, 'daimond.js'), 'utf8');
const ALERTS_SRC = readPage(join(HERE, 'alerts.js'), 'utf8');
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

globalThis.window = { DaimondPause: { isPaused: () => false, triggerLeaf: (d, a) => d + '/' + a } };
const DaimondTriggers = require('./triggers.js');

// What the model does with an arrival: raise an alert or not, and whether a call of its failed.
// The reply is what the engine leaves it saying, by the contract above.
function engine(how, act) {
	if (act.failed) return { how: 'silent', reply: '', failed: 1 };
	if (act.raise || (how && how.pendingOnly)) return { how: 'answered', reply: '', failed: 0 };
	return { how: 'answered', reply: 'I read the new mail; nothing needs you.', failed: 0 };
}

function world(act) {
	const win = makeWindow({ now: 1_790_000_000_000 });
	new Function('window', 'with (window) {\n' + ALERTS_SRC + '\n}')(win);
	const W = { win, act, turns: [], proposals: [], chat: { B: { messages: [] } } };
	W.A = { id: 'A', name: 'Work' }; W.B = { id: 'B', name: 'Email' };
	W.ta = Object.assign(DaimondTriggers.blank('mail'), {
		id: 'm1', mailbox: 'alerts@oxegen.io', folder: 'INBOX', instruction: 'Watch the server alerts.' });
	const body = ['offScreenSteerAllowed', 'steerFromTrigger', 'triggerHandOff', 'steerTriggerHere', 'claimTimerFire', 'timerFireId', 'oweMail', 'mailClaimId', 'claimMailArrival', 'trailTrigger',
		'settleMailClaim', 'keepMailClaim', 'seedMailMark', 'mailMarkKey', 'mailGen', 'judgeTriggeredTurn', 'quietTurnEnd', 'followVerdicts'].map((n) => extractFn(APP, n)).join('\n');
	W.api = new Function('W', 'DaimondTriggers', `
		var window = W.win, diamonds = [W.A, W.B], currentDiamond = W.A, _mailOwed = {}, _mailRunning = {}, _mailTries = {}, MAIL_TRIES_MAX = 3, _lastSteer = {}, FOLLOW_MAX_MS = 20 * 60 * 1000;
		function t(k, v) { return k + (v ? ' ' + JSON.stringify(v) : ''); }
		var document = { getElementById: function () { return null; } };
		function diamondBusy() { return false; }
		function askOpenIn() { return false; }
		function daimonChat(f) { return f; }
		function seatDrawnRunner() { return ''; }		// the switch draws Here: the trigger runs here (STEER-2)
		function chatSeatHere() { return false; }
		function diamondCanRun() { return true; }
		function proposeFromTurn(f, ta, reply) { if (String(reply || '').trim()) W.proposals.push(reply); }
		function selfDeviceId() { return ''; }
		function leaseClockNow() { return Date.now(); }
		function diag() {}
		async function selectDiamond(f) { currentDiamond = f; }
		async function runSteer(f, text, depth, detached, how) {
			W.turns.push({ in: f.id, how: how });
			var rec = W.chat[f.id], srec = { role: 'user', content: text, app: true };
			rec.messages.push(srec);
			if (W.act.raise) window.DaimondPendingTool.raise(f.id, JSON.stringify(W.act.raise));
			var e = W.engine(how, W.act);
			if (e.reply) rec.messages.push({ role: 'assistant', content: e.reply });
			var quiet = typeof quietTurnEnd === 'function' && quietTurnEnd(f, rec, srec, how, e.reply, e.how, null);
			if (quiet !== 'quiet') rec.messages.push({ role: 'end_log', how: e.how });
			_lastSteer[f.id] = { how: e.how, failed: e.failed, refused: 0 };
			return e.reply;
		}
		async function doSteer(text, depth, how) { return runSteer(currentDiamond, text, depth, null, how); }
		${body}
		var _triggers = { A: { v: 1, actions: [] }, B: { v: 1, actions: [W.ta] } };
		var Triggers = {
			of: function (id) { return _triggers[id].actions; },
			save: async function () {},
			${extractMethod(APP, 'fire')},
		};
		return Triggers;`)(Object.assign(W, { engine }), DaimondTriggers);
	// What the person sees: the chat, the Pending panel's items, and the badge.
	W.seen = () => ({
		chat:    W.chat.B.messages.length,
		pending: W.win.DaimondAlerts.live().length + W.proposals.length,
		badge:   W.win.DaimondAlerts.count() + W.proposals.length,
	});
	return W;
}

const ARRIVED = { kind: 'mail', mailbox: 'alerts@oxegen.io', folder: 'INBOX' };

test('routine mail with nothing to report leaves the chat, Pending and the badge unchanged', async () => {
	const W = world({});
	const was = W.seen();
	await W.api.fire(ARRIVED);
	assert.equal(W.turns.length, 1, 'the arrival ran no turn');
	assert.ok(W.turns[0].how && W.turns[0].how.pendingOnly, 'the mail turn was not marked as reporting on Pending');
	assert.deepEqual(W.seen(), was, 'routine mail changed what the person sees: ' + JSON.stringify(W.chat.B.messages));
});

test('a real failure raises one needs-him alert even with twenty already up', async () => {
	const W = world({ failed: true });
	const tool = W.win.DaimondPendingTool;
	for (let i = 0; i < 20; i++) {
		const r = JSON.parse(tool.raise('B', JSON.stringify({ key: 'srv' + i, headline: 'Server ' + i + ' down', needs: true })));
		assert.ok(r.ok, 'alert ' + i + ' was refused: ' + JSON.stringify(r));
	}
	assert.equal(JSON.parse(tool.raise('B', JSON.stringify({ key: 'srv20', headline: 'One more', needs: true }))).full, true,
		'the daimon\'s twenty-first alert was not refused');
	await W.api.fire(ARRIVED);
	const failed = W.win.DaimondAlerts.live().filter((a) => a.key === 'turn-failed.mail');
	assert.equal(failed.length, 1, 'the failure was lost past the live limit');
	assert.equal(failed[0].needs, true, 'a failed turn does not need the person');
	assert.equal(W.win.DaimondAlerts.count(), 21, 'the badge does not count the failure');
	// The page's key is the page's: the model can neither raise it nor take it down.
	assert.equal(JSON.parse(tool.raise('B', JSON.stringify({ key: 'turn-failed', headline: 'x', needs: false }))).ok, false);
	assert.equal(JSON.parse(tool.clear('B', JSON.stringify({ key: 'turn-failed' }))).ok, false);
	assert.equal(JSON.parse(tool.clear('B', JSON.stringify({ key: 'turn-failed.mail' }))).ok, false);
	assert.equal(W.win.DaimondAlerts.live().filter((a) => a.key === 'turn-failed.mail').length, 1);
});

test('mail that needs him raises exactly one Pending item and posts nothing in the chat', async () => {
	const W = world({ raise: { key: 'disk-full', headline: 'jarrah disk 95% full', needs: true } });
	await W.api.fire(ARRIVED);
	const s = W.seen();
	assert.equal(s.pending, 1, 'expected exactly one Pending item, got ' + s.pending);
	assert.equal(s.badge, 1);
	assert.equal(W.win.DaimondAlerts.live()[0].key, 'disk-full');
	assert.equal(s.chat, 0, 'the turn posted in the Email chat: ' + JSON.stringify(W.chat.B.messages));
});

test('a second talkative mail turn adds to the quiet note; the oldest words go first past 600', async () => {
	const W = world({});
	const one = 'I read the new mail: the backup on karri finished at 03:10.';
	const two = 'And the certificate on jarrah renews on Friday.';
	W.engine = () => ({ how: 'answered', reply: one, failed: 0 });
	await W.api.fire(ARRIVED);
	W.win._setNow(1_790_000_000_000 + 60_000);
	W.engine = () => ({ how: 'answered', reply: two, failed: 0 });
	await W.api.fire(ARRIVED);
	let up = W.win.DaimondAlerts.live();
	assert.equal(up.length, 1, 'the notes are one item: ' + JSON.stringify(up));
	assert.ok(up[0].detail.includes(one), 'the first finding was overwritten by the second: ' + up[0].detail);
	assert.ok(up[0].detail.includes(two), 'the second finding is missing: ' + up[0].detail);
	assert.ok(up[0].detail.indexOf(one) < up[0].detail.indexOf(two), 'the newest words are not last');
	// Past 600 characters the oldest words are dropped, never the newest.
	const last = 'Finally: the \u{1F525} alarm on the boiler cleared at 05:00.';
	W.engine = () => ({ how: 'answered', reply: 'x'.repeat(590), failed: 0 });
	await W.api.fire(ARRIVED);
	W.engine = () => ({ how: 'answered', reply: last, failed: 0 });
	await W.api.fire(ARRIVED);
	up = W.win.DaimondAlerts.live();
	assert.equal(up.length, 1, 'the note was refused or split: ' + JSON.stringify(up));
	assert.ok(Array.from(up[0].detail).length <= 600, 'the note passed 600 characters: ' + Array.from(up[0].detail).length);
	assert.ok(up[0].detail.endsWith(last), 'the newest words were cut: ' + up[0].detail.slice(-80));
	assert.ok(!up[0].detail.includes(one), 'the oldest words were kept over newer ones');
});

// B-1: routine quiet ends `answered`, so a mail turn that ends `silent` answered nothing, even
// with no call failed: it is a failure the person must see, not routine mail.
test('a mail turn that ends silent with no failed call raises turn-failed', async () => {
	const W = world({});
	W.engine = () => ({ how: 'silent', reply: '', failed: 0 });
	await W.api.fire(ARRIVED);
	const up = W.win.DaimondAlerts.live();
	assert.equal(up.length, 1, 'an empty mail ending reached no one: ' + JSON.stringify(up));
	assert.equal(up[0].key, 'turn-failed.mail');
	assert.equal(up[0].needs, true);
});

test('words a mail turn writes anyway reach one quiet Pending item and never the chat', async () => {
	const W = world({});
	const said = 'I read the new mail: the backup on karri finished at 03:10.';
	W.engine = () => ({ how: 'answered', reply: said, failed: 0 });
	await W.api.fire(ARRIVED);
	assert.equal(W.chat.B.messages.length, 0, 'the mail turn posted in the Email chat: ' + JSON.stringify(W.chat.B.messages));
	assert.equal(W.proposals.length, 0, 'the words were also offered as a proposal');
	const up = W.win.DaimondAlerts.live();
	assert.equal(up.length, 1, 'expected exactly one Pending item, got ' + JSON.stringify(up));
	assert.equal(up[0].diamond, 'B', 'the item is not the Email Diamond\'s, so its Open link goes elsewhere');
	assert.equal(up[0].needs, false, 'the words were raised as needing him');
	assert.equal(up[0].detail, said, 'the finding was lost or altered on its way to Pending');
	assert.equal(W.win.DaimondAlerts.count(), 0, 'the quiet item counts on the badge');
	// Its key is the page's: the model can neither raise it nor take it down.
	const tool = W.win.DaimondPendingTool;
	assert.equal(JSON.parse(tool.raise('B', JSON.stringify({ key: up[0].key, headline: 'x', needs: false }))).ok, false);
	assert.equal(JSON.parse(tool.clear('B', JSON.stringify({ key: up[0].key }))).ok, false);
});
