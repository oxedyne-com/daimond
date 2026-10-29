// POST-QA r569cqa2 (confirm round, 2026-10-17): two gaps left beside the MAIL-FIX2 fixes.
// Each test asserts the correct behaviour, so red is a reproduced defect.
// Run: node --test www/js/postqa_r569cqa2.test.mjs
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWindow } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readPage(join(HERE, 'daimond.js'), 'utf8');
const ALERTS = readPage(join(HERE, 'alerts.js'), 'utf8');

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
// A top-level function's text, up to the next one at its own indent (no brace counting, so
// braces inside its strings cannot cut it short).
function topFn(src, name) {
	const m = new RegExp('\\n\\t(?:async )?function ' + name + '\\(').exec(src);
	if (!m) return '';
	const rest = src.slice(m.index + 1);
	const n = /\n\t(?:async )?function [A-Za-z_$][\w$]*\(/.exec(rest.slice(1));
	return n ? rest.slice(0, n.index + 1) : rest;
}

// Rulings §16: the Email Diamond posts nothing in its chat. MAIL-FIX2 r2 gave `tellDaimon` a
// `quiet` flag and set it on the five gather fallbacks of a pending-only batch. The three
// "agents not started" notices in `runSteer` (turn ended badly; the Diamond does not dispatch;
// the spend gate refused or was told no) still pass none, so a mail turn that dispatched and
// whose agents never started writes a `note_log` row into the Email chat.
test('CQA2-1: a pending-only turn whose agents never start posts nothing in its chat', () => {
	const body = topFn(APP, 'runSteerHeld');	// U3a: runSteer holds the client, runSteerHeld is the turn
	assert.ok(body.length > 1000, 'runSteer not found');
	const calls = body.match(/Workers\.tellDaimon\([^;]*?\);/gs) || [];
	assert.ok(calls.length >= 3, 'the not-started notices were not found: ' + calls.length);
	const loud = calls.filter((c) => !/pendingOnly|quiet/.test(c));
	assert.deepEqual(loud, [], loud.length + ' not-started notice(s) of a mail turn reach the Email chat');
});

// r569 raised a mail turn's failure as the bare `turn-failed`, and every routine mail on a
// reasoning model raised it falsely (post-QA r569qa2 Q2). r569c keys a mail failure
// `turn-failed.mail` and an answered mail turn clears only that, so the r569-era alert on the
// Email Diamond stays on Pending, counted as needing him, until he dismisses it or 30 days pass.
test('CQA2-2: an answered mail turn takes down the r569-era mail failure', () => {
	const w = makeWindow({ now: 1_790_000_000_000 });
	new Function('window', 'with (window) {\n' + ALERTS + '\n}')(w);
	const J = new Function('window', `
		var _lastSteer = {};
		function t(k) { return k; }
		var Triggers = { of: function () { return [{ kind: 'mail' }]; } };	// a mail-only Diamond, read
		${extractFn(APP, 'judgeTriggeredTurn')}
		return { judge: judgeTriggeredTurn, steer: _lastSteer };`)(w);
	const B = { id: 'B', name: 'Email' };
	// What r569 left on his Pending after a routine mail on a reasoning model.
	assert.equal(w.DaimondAlerts.raise('B', 'turn-failed', 'Email: a turn failed', 'r569', true), 'new');
	w._setNow(1_790_000_100_000);
	J.steer.B = { how: 'answered', calls: 1, failed: 0, refused: 0 };
	assert.equal(J.judge(B, null, false, true), false);
	const up = w.DaimondAlerts.live().filter((a) => a.diamond === 'B' && a.needs).map((a) => a.key);
	assert.deepEqual(up, [], 'an answered mail turn left the r569 false alarm up: ' + JSON.stringify(up));
});

// FIRE MAIL-FU3: the retirement reaches only a Diamond whose every action is a mail action. A
// timer action's failure is its own, and a mail turn that answered says nothing about it.
test('MAIL-FU3: an answered mail turn leaves a timer action\'s turn-failed up', () => {
	const w = makeWindow({ now: 1_790_000_000_000 });
	new Function('window', 'with (window) {\n' + ALERTS + '\n}')(w);
	const J = new Function('window', `
		var _lastSteer = {};
		var Triggers = { of: function () { return [{ kind: 'mail' }, { kind: 'timer' }]; } };
		function t(k) { return k; }
		${extractFn(APP, 'judgeTriggeredTurn')}
		return { judge: judgeTriggeredTurn, steer: _lastSteer };`)(w);
	assert.equal(w.DaimondAlerts.raise('B', 'turn-failed', 'Email: a turn failed', 'timer', true), 'new');
	w._setNow(1_790_000_100_000);
	J.steer.B = { how: 'answered', calls: 1, failed: 0, refused: 0 };
	assert.equal(J.judge({ id: 'B', name: 'Email' }, null, false, true), false);
	const up = w.DaimondAlerts.live().filter((a) => a.diamond === 'B' && a.needs).map((a) => a.key);
	assert.deepEqual(up, ['turn-failed']);
});

// FIRE MAIL-FU3: the walk's sweep takes the r569 alert down with no mail arriving, on a mail-only
// Diamond alone: not on one with a timer action, nor on one whose actions were never read.
test('MAIL-FU3: the Diamond walk retires the r569 mail failure on mail-only Diamonds', () => {
	const w = makeWindow({ now: 1_790_000_000_000 });
	new Function('window', 'with (window) {\n' + ALERTS + '\n}')(w);
	const acts = { M: [{ kind: 'mail' }], T: [{ kind: 'mail' }, { kind: 'timer' }], N: [] };
	const sweep = new Function('window', `
		var Triggers = { of: function (id) { return ${JSON.stringify(acts)}[id] || []; } };
		${extractFn(APP, 'retireR569MailFailures')}
		return retireR569MailFailures;`)(w);
	['M', 'T', 'N'].forEach((d) => w.DaimondAlerts.raise(d, 'turn-failed', d + ': a turn failed', 'r569', true));
	w.DaimondAlerts.raise('M', 'turn-failed.mail', 'M: a mail turn failed', 'r569c', true);
	w._setNow(1_790_000_100_000);
	sweep(w);
	const up = w.DaimondAlerts.live().map((a) => a.diamond + ':' + a.key).sort();
	assert.deepEqual(up, ['M:turn-failed.mail', 'N:turn-failed', 'T:turn-failed']);
	sweep(w);
	assert.equal(w.DaimondAlerts.live().length, 3, 'a second sweep changed something');
});

// FIRE MAIL-FU3: a mail turn whose agents never started is owed an ending that is not `answered`:
// each not-started notice is followed by the ending it owes the turn (`followVerdicts`).
test('MAIL-FU3: each not-started arm of runSteer owes the turn a stopped or failed ending', () => {
	const body = topFn(APP, 'runSteerHeld');	// U3a: runSteer holds the client, runSteerHeld is the turn
	const arms = body.match(/Workers\.tellDaimon\([^;]*?\);\s*owe\('(stopped|failed)'\);/gs) || [];
	assert.equal(arms.length, 3, 'not-started arms owing an ending: ' + arms.length);
	assert.match(body, /owe\('stopped'\);[\s\S]*?\} else \{[\s\S]*?Dispatched/, 'the spend gate arm owes stopped');
});
