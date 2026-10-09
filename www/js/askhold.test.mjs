// askhold.test.mjs -- an open Decision holds the queue, and the next message answers it
// (owner ruling D-20261009-20; r543 QA-B2 F-B2-1, F-B2-2).
//
//	node --test www/js/askhold.test.mjs
//
// `askMarkAnswered`, `askClose`, `askHolds`, `drainQueue` and `armAskIdleBound` are lifted from
// the REAL daimond.js by a brace-balanced scan and run over a small stand-in DOM, so an edit that
// lets a typed answer leave the card open, or a drained queue answer the question, fails here.
// The browser half (placement, reload, the live queue box) is dev/verify_decision_last.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

function extractFn(src, name) {
	const m = new RegExp('\\n\\t+(?:async )?function ' + name + '\\(').exec(src);
	if (!m) return '';
	const start = m.index + 1;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

// A stand-in element: just what the card code touches.
class El {
	constructor(cls, text) {
		this.className = cls || ''; this.textContent = text || ''; this.dataset = {}; this.kids = [];
		this.disabled = false; this.parent = null;
		const self = this;
		this.classList = {
			add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
			contains: (c) => self.className.split(' ').includes(c),
		};
	}
	appendChild(k) { k.parent = this; this.kids.push(k); return k; }
	remove() { if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this); this.parent = null; }
	all() { return this.kids.flatMap((k) => [k, ...k.all()]); }
	querySelectorAll(sel) { const c = sel.slice(1); return this.all().filter((k) => k.classList.contains(c)); }
	querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
	contains(n) { return n === this || this.all().includes(n); }
}
function card(q) {
	const c = new El('ask-card');
	c.appendChild(new El('ask-q', q));
	const opts = c.appendChild(new El('ask-opts'));
	for (const l of ['Alpha', 'Beta']) opts.appendChild(new El('ask-opt')).appendChild(new El('ask-label', l));
	c.appendChild(new El('ask-other'));
	return c;
}

// The lifted functions, over a world the test controls.
function world() {
	const W = { sent: [], steered: [], rendered: 0, unpinned: [], armed: null, out: new El('chat-output') };
	const names = ['askClose', 'askMarkAnswered', 'askHolds', 'drainQueue', 'armAskIdleBound', 'askCurrent',
		'askOpenIn', 'steerFromTrigger'];
	const body = names.map((n) => extractFn(APP, n)).join('\n');
	W.api = new Function('W', `
		var ASK_CHOSE = 'Chose: ', ASK_OTHER = 'Other: ', ASK_SILENT_MAX_MS = 3600000;
		var _askCard = null, current = null, _unloading = false, chats = [];
		var chatOutput = W.out;
		var document = { createElement: function (t) { return new W.El(''); }, body: W.out };
		function t(k, v) { return k + (v && v.what !== undefined ? '=' + v.what : ''); }
		function unpinAwaiting(c) { W.unpinned.push(c); }
		function renderQueue() { W.rendered++; }
		function updateQueueBadges() {}
		function returnQueue(c) { W.returned = (c._queue || []).slice(); c._queue = []; }
		function runTurn(chat, text) { W.sent.push(text); }
		function armIdleBound(stands, fire) { W.armed = { stands: stands, fire: fire }; }
		function dialogIdleMs() { return 1800000; }
		function trail() {}
		function askAnswer(c, text, shown) { if (c.dataset.answered) return; askClose(c, shown); W.sent.push(text); }
		var currentDiamond = null;
		function diamondBusy() { return false; }
		function daimonChat(f) { return f.rec; }
		function offScreenSteerAllowed() { return true; }
		async function selectDiamond(f) { currentDiamond = f; }
		async function doSteer(text) { W.steered.push(text); return ''; }
		async function runSteer(f, text) { W.steered.push(text); return ''; }
		${body}
		return {
			draw: function (c) { W.out.appendChild(c); _askCard = c; },
			open: function (chat) { current = chat; chats = [chat]; },
			askMarkAnswered: askMarkAnswered, drainQueue: drainQueue, armAskIdleBound: armAskIdleBound,
			steerFromTrigger: steerFromTrigger, onDiamond: function (f) { currentDiamond = f; },
			holds: function () { return typeof askHolds === 'function' ? askHolds() : null; },
		};`)(Object.assign(W, { El }));
	return W;
}

test('a message typed after the question answers it in the person\'s own words', () => {
	const W = world(), c = card('Which way?');
	W.api.draw(c);
	W.api.askMarkAnswered('Beta, but go slowly.');
	assert.equal(c.dataset.answered, '1', 'the typed answer left the card open (F-B2-1)');
	assert.equal(c.querySelector('.ask-done').textContent, 'ask.answered_own');
	assert.ok(c.querySelectorAll('.ask-opt').every((b) => b.disabled), 'its buttons are still live');
	assert.equal(c.querySelectorAll('.chosen').length, 0, 'an option was marked chosen for words nobody tapped');
	assert.equal(c.querySelector('.ask-other'), null, 'the Other box survived');
	assert.deepEqual(W.unpinned, [c], 'the card did not go back to its place');
});

test('a tap or the card\'s own box still names the answer', () => {
	const W = world(), c = card('Which way?');
	W.api.draw(c);
	W.api.askMarkAnswered('Chose: Beta');
	assert.equal(c.querySelector('.ask-done').textContent, 'ask.answered=Beta');
	assert.equal(c.querySelectorAll('.chosen').length, 1);
});

test('an empty row is not an answer', () => {
	const W = world(), c = card('Which way?');
	W.api.draw(c);
	W.api.askMarkAnswered('   ');
	assert.equal(c.dataset.answered, undefined);
});

test('a queue left by the asking turn is held while the question is open', () => {
	const W = world(), c = card('Which way?'), chat = { id: 'c1', _queue: ['Fence checked too.'] };
	W.api.open(chat);
	W.api.draw(c);
	W.api.drainQueue(chat, false);
	assert.deepEqual(W.sent, [], 'the queued message was sent as the answer to a question nobody had seen (F-B2-1a)');
	assert.deepEqual(chat._queue, ['Fence checked too.'], 'the held message left the queue box');
	assert.equal(W.api.holds(), true);
	// Answered: the queue goes on as before.
	W.api.askMarkAnswered('Chose: Alpha');
	assert.equal(W.api.holds(), false);
	W.api.drainQueue(chat, false);
	assert.deepEqual(W.sent, ['Fence checked too.']);
});

test('after a typed answer the idle default stands down, whatever the clock says', () => {
	const W = world(), c = card('Which way?');
	W.api.draw(c);
	W.api.armAskIdleBound(c, 'Alpha.', Date.now());
	assert.ok(W.armed && W.armed.stands(), 'the bound was not armed for a current question');
	W.api.askMarkAnswered('Beta then, going ahead.');
	assert.equal(W.armed.stands(), false, 'the idle bound still stands after a typed answer (F-B2-2)');
	// The half hour passes: the backstop, if it fired, would answer "Other: Alpha.".
	if (W.armed.stands()) W.armed.fire();
	assert.deepEqual(W.sent, [], 'the idle default sent an answer the person had not given');
});

// Q18: a Diamond's trigger or preset is drawn as a user message, but it is not the person's
// words. It never answers an open question; a trigger that comes due waits behind the card.
test('a trigger\'s or preset\'s message drawn after the question does not answer it', () => {
	const W = world(), c = card('Which way?');
	W.api.draw(c);
	W.api.askMarkAnswered('Run the hourly check.', true);
	assert.equal(c.dataset.answered, undefined, 'a trigger\'s message closed the card "in your own words"');
	assert.equal(c.querySelector('.ask-done'), null);
	// The person's own message after it still answers.
	W.api.askMarkAnswered('Beta, please.');
	assert.equal(c.dataset.answered, '1');
	assert.equal(c.querySelector('.ask-done').textContent, 'ask.answered_own');
});

test('a trigger that comes due while its Diamond\'s question is open waits behind the card', async () => {
	const W = world(), now = Date.now();
	const rec = { messages: [
		{ role: 'user', content: 'Plan it.', ts: now - 3000 },
		{ role: 'tool_log', name: 'ask', outcome: 'done', args: '{}', ts: now - 2000 },
		{ role: 'user', content: 'An earlier trigger.', app: true, ts: now - 1000 },
	] };
	const f = { id: 'D1', rec: rec };
	W.api.onDiamond(f);
	let out = await W.api.steerFromTrigger(f, 'Run the hourly check.', { kind: 'activity' });
	assert.equal(out.went, false, 'the trigger was sent while the question was open');
	assert.deepEqual(W.steered, [], 'the trigger\'s words reached the daimon as the answer');
	// Answered by the person: the held trigger goes at its next tick.
	rec.messages.push({ role: 'user', content: 'Chose: Alpha', ts: now });
	out = await W.api.steerFromTrigger(f, 'Run the hourly check.', { kind: 'activity' });
	assert.equal(out.went, true, 'the trigger stayed held after the answer');
	assert.deepEqual(W.steered, ['Run the hourly check.']);
});

test('a question no longer current does not hold a trigger', async () => {
	const W = world();
	const rec = { messages: [{ role: 'tool_log', name: 'ask', outcome: 'done', args: '{}', ts: Date.now() - 2 * 3600000 }] };
	const f = { id: 'D2', rec: rec };
	W.api.onDiamond(f);
	const out = await W.api.steerFromTrigger(f, 'Tick.', { kind: 'activity' });
	assert.equal(out.went, true, 'a stale question held the trigger for ever');
});
