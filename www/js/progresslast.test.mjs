// progresslast.test.mjs -- the state of a running turn is always the last tile, and an
// open Decision is that state (UNBLOCK-6, D-20261014-02; rulings §2 with D-20261007-05).
//
//	node --test www/js/progresslast.test.mjs
//
// The thread's placement code (`postToChat`, the pin-to-foot functions, `placeFurniture`,
// the turn indicator and `appendDispatchedTile`) is lifted from the REAL daimond.js by a
// brace-balanced scan and run over a stand-in DOM with real sibling order, so an edit that
// lets a turn's tiles land below its "<device> is on it" tile, or the indicator below an
// open Decision, fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readFileSync(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');

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

// A stand-in node with real sibling order: what the placement code walks.
class Node {
	constructor(type, cls) {
		this.nodeType = type; this.className = cls || ''; this.id = ''; this.dataset = {};
		this.childNodes = []; this.parentNode = null;
		const self = this;
		this.classList = {
			add: (c) => { if (!self.classList.contains(c)) self.className = (self.className + ' ' + c).trim(); },
			remove: (c) => { self.className = self.className.split(' ').filter((x) => x !== c).join(' '); },
			toggle: () => {},
			contains: (c) => self.className.split(' ').includes(c),
		};
	}
	sib(d) { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + d] || null; }
	get nextSibling() { return this.sib(1); }
	get previousSibling() { return this.sib(-1); }
	get firstChild() { return this.childNodes[0] || null; }
	get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
	get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
	remove() { if (this.parentNode) { const p = this.parentNode; p.childNodes.splice(p.childNodes.indexOf(this), 1); } this.parentNode = null; }
	insertBefore(n, ref) {
		n.remove();
		const at = ref ? this.childNodes.indexOf(ref) : -1;
		if (ref && at < 0) throw new Error('insertBefore: the reference is not a child');
		if (at < 0) this.childNodes.push(n); else this.childNodes.splice(at, 0, n);
		n.parentNode = this;
		return n;
	}
	appendChild(n) { return this.insertBefore(n, null); }
	querySelector() { return null; }
	set innerHTML(v) {}
	appendTextNode() {}
}
const el = (cls, name) => { const n = new Node(1, cls); n.name = name || cls; return n; };

function world() {
	const W = { out: el('chat-output'), state: 'running', blocked: false, answered: false };
	const names = ['lastContent', 'firstAwaiting', 'firstDecision', 'tailAnchor', 'pinAwaiting', 'unpinAwaiting',
		'reconcileAwaiting', 'placeFurniture', 'postToChat', 'showSpinner', 'hideSpinner', 'handoffLive',
		'appendDispatchedTile'];
	const body = names.map((n) => extractFn(APP, n)).join('\n');
	W.api = new Function('W', 'el', 'Node', `
		var chatOutput = W.out, current = { id: 'c' }, liveThink = null, _contBtn = null;
		var _renderingHistory = false, _renderSynced = true, TILE_ROLL = {};
		var spinnerEl = null, spinnerSay = null;
		var document = {
			createElement: function () { return el(''); },
			createComment: function () { return new Node(8, ''); },
			getElementById: function (id) { return chatOutput.children.filter(function (n) { return n.id === id; })[0] || null; },
		};
		function retireContinue() {}
		function curGen() { return null; }
		function liveWork() {}
		function makeRollup() { throw new Error('no rollable tiles in this test'); }
		function rollUpdate() {}
		function syncContainerSel() {}
		function nearBottom() { return false; }
		function setScrollTop() {}
		function tOr(k) { return k; }
		function t(k) { return k; }
		function cssEsc(s) { return s; }
		function peerUiStateFor() { return W.state; }
		function dispatchedAnswerPresent() { return W.answered; }
		function blockerFor() { return W.blocked ? { kind: 'ask' } : null; }
		function handoffClaimLabel() { return 'argonaut'; }
		function handoffTargetLabel() { return ''; }
		function buildTile(kind) { var n = el('ctile', 'handoff'); n._body = el('body'); n.appendChild(n._body); return n; }
		function renderDispatchedFooter() {}
		function seatTileNote() { return null; }
		function drawHandoffWorkers() {}
		function tagTurn() {}
		${body}
		return { postToChat: postToChat, showSpinner: showSpinner, hideSpinner: hideSpinner,
			appendDispatchedTile: appendDispatchedTile, spinner: function () { return spinnerEl; } };
	`)(W, el, Node);
	return W;
}

// The elements of the thread, top to bottom, by name.
const order = (W) => W.out.children.map((n) => n.name);
// The last tile of the thread, ignoring the queue box beneath everything.
const lastTile = (W) => W.out.children.filter((n) => n.id !== 'chat-queued').pop().name;
// An ask card standing for an open Decision; `open.v = false` answers it.
function decision(name) { const c = el('ask-card', name); c.open = { v: true }; c._awaits = () => c.open.v; return c; }
function queueBox(W) { const q = el('queue', 'queue'); q.id = 'chat-queued'; W.out.appendChild(q); return q; }

test('a handed-off turn streaming 9 steps keeps "<device> is on it" last after every step', () => {
	const W = world();
	W.api.postToChat(el('user', 'question'));
	W.api.appendDispatchedTile({ iturn: 't1', ts: 1 });
	assert.equal(lastTile(W), 'handoff');
	for (let i = 1; i <= 9; i++) {
		W.api.postToChat(el('tile', 'step' + i));
		assert.equal(lastTile(W), 'handoff', 'after step ' + i + ': ' + order(W).join(' '));
	}
	assert.deepEqual(order(W).slice(0, 2), ['question', 'step1']);
});

test('the queue box stays beneath the progress tile', () => {
	const W = world();
	queueBox(W);
	W.api.postToChat(el('user', 'question'));
	W.api.appendDispatchedTile({ iturn: 't1', ts: 1 });
	W.api.postToChat(el('tile', 'step1'));
	assert.deepEqual(order(W), ['question', 'step1', 'handoff', 'queue']);
});

test('an open Decision is the state: it stands below the hand-off tile, and goes home answered', () => {
	const W = world();
	W.api.postToChat(el('user', 'question'));
	W.api.appendDispatchedTile({ iturn: 't1', ts: 1 });
	W.api.postToChat(el('tile', 'step1'));
	const d = decision('decision');
	W.api.postToChat(d);
	assert.equal(lastTile(W), 'decision');
	W.api.postToChat(el('tile', 'step2'));
	assert.deepEqual(order(W), ['question', 'step1', 'step2', 'handoff', 'decision']);
	d.open.v = false;
	W.api.postToChat(el('tile', 'step3'));
	assert.equal(lastTile(W), 'handoff', order(W).join(' '));
	assert.ok(order(W).indexOf('decision') < order(W).indexOf('step3'), 'answered, it returns to its place');
});

test('a hand-off tile that is redrawn while a Decision is open stands above the Decision', () => {
	const W = world();
	W.api.postToChat(el('user', 'question'));
	W.api.postToChat(decision('decision'));
	W.api.appendDispatchedTile({ iturn: 't1', ts: 1 });
	assert.deepEqual(order(W), ['question', 'handoff', 'decision']);
});

test('a finished hand-off goes back to the head of its turn', () => {
	const W = world();
	W.api.postToChat(el('user', 'question'));
	W.api.appendDispatchedTile({ iturn: 't1', ts: 1 });
	W.api.postToChat(el('tile', 'step1'));
	W.state = 'done';
	W.api.postToChat(el('tile', 'answer'));
	assert.deepEqual(order(W), ['question', 'handoff', 'step1', 'answer']);
	for (const st of ['failed', 'interrupted']) {
		const V = world();
		V.api.postToChat(el('user', 'question'));
		V.api.appendDispatchedTile({ iturn: 't1', ts: 1 });
		V.api.postToChat(el('tile', 'step1'));
		V.state = st;
		V.api.postToChat(el('tile', 'step2'));
		assert.equal(lastTile(V), 'step2', st + ': ' + order(V).join(' '));
	}
});

test('a local turn: the indicator is last, and an open Decision stands below it', () => {
	const W = world();
	queueBox(W);
	W.api.postToChat(el('user', 'question'));
	W.api.showSpinner('Thinking');
	W.api.spinner().name = 'spinner';
	W.api.postToChat(el('tile', 'step1'));
	assert.equal(lastTile(W), 'spinner');
	const d = decision('decision');
	W.api.postToChat(d);
	assert.deepEqual(order(W), ['question', 'step1', 'spinner', 'decision', 'queue']);
	W.api.showSpinner('Waiting');
	assert.deepEqual(order(W), ['question', 'step1', 'spinner', 'decision', 'queue']);
	d.open.v = false;
	W.api.postToChat(el('tile', 'step2'));
	assert.equal(lastTile(W), 'spinner', order(W).join(' '));
});
