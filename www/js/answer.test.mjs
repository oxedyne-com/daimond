// answer.test.mjs -- the answer rule: a press acts, or visibly answers why it cannot.
//
//	node --test www/js/answer.test.mjs
//
// The dead-controls crawl (D-20261003-07, finding 5) found controls that took a
// press and changed nothing: the Ask pill with an empty field, Compose's four
// buttons, Workspace Refresh, a heading that looked pressable. The rule is one
// helper, answer.js, and this proves it in two parts: the helper (a reason
// disables with the reason as the title, and lifts when the state changes), and
// the state of each case (what its reason is, in every state it can be in).
// No browser: the elements are stand-ins with the few members the helper uses,
// and answer.js is a plain IIFE evaluated against one stand-in global.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(HERE, 'answer.js');
const I18N = path.join(HERE, '..', 'i18n');

// A stand-in global; `changes` is what a language switch would call.
function load() {
	const win = { DaimondI18n: { onChange(fn) { win.changes.push(fn); } }, changes: [] };
	new Function('window', fs.readFileSync(SRC, 'utf8'))(win);
	return win;
}

// An element with a title, a disabled flag and listeners, and nothing else.
function el(title = null) {
	const e = { disabled: false, attrs: new Map(), on: {} };
	if (title !== null) e.attrs.set('title', title);
	e.getAttribute = (k) => (e.attrs.has(k) ? e.attrs.get(k) : null);
	e.setAttribute = (k, v) => { e.attrs.set(k, String(v)); };
	e.removeAttribute = (k) => { e.attrs.delete(k); };
	e.addEventListener = (ev, fn) => { (e.on[ev] = e.on[ev] || []).push(fn); };
	e.fire = (ev) => (e.on[ev] || []).map((fn) => fn({ type: ev }));
	return e;
}

// A reason leaves the button ENABLED and marks it aria-disabled, so a tap on a phone, which a
// disabled button swallows, reaches the rule and is answered (r533 QA B-4). Only a hold on a send
// in flight sets the real `disabled`.
const off = (b) => b.getAttribute('aria-disabled') === 'true';

// ── the helper ──────────────────────────────────────────────────────────
test('a reason disables the control and becomes its title; none gives both back', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Ask');
	assert.equal(A.gate(b, 'Type a question.'), true);
	assert.equal(off(b), true);
	assert.equal(b.getAttribute('title'), 'Type a question.');
	assert.equal(A.gate(b, ''), false);
	assert.equal(off(b), false);
	assert.equal(b.getAttribute('title'), 'Ask');
});

test('a reason does not set disabled, so a tap reaches the rule; a hold does set it', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Ask');
	A.gate(b, 'Type a question.');
	assert.equal(off(b), true);
	assert.equal(b.disabled, false, 'a disabled button takes no click, and a phone shows no title');
	A.gate(b, '');
	assert.equal(off(b), false);
	assert.equal(b.getAttribute('aria-disabled'), null, 'the attribute goes, not "false"');
	const c = A.control(b, { can: () => '', act() {} });
	c.hold(true);
	assert.equal(b.disabled, true);
	assert.equal(off(b), false, 'a hold has no reason to give');
});

test('a tap on a control with a reason is said, wherever the control is a button that is not disabled', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Ask');
	const said = [];
	let acted = 0;
	A.control(b, { can: () => 'Type a question.', act: () => { acted++; }, say: (m, bad) => said.push([m, bad]) });
	assert.equal(b.disabled, false);
	b.fire('click');
	assert.equal(acted, 0);
	assert.deepEqual(said, [[ 'Type a question.', true ]], 'the tap was answered');
});

test('a control with no title of its own ends with none, not an empty one', () => {
	const { DaimondAnswer: A } = load();
	const b = el();
	A.gate(b, 'No message open.');
	assert.equal(b.getAttribute('title'), 'No message open.');
	A.gate(b, '');
	assert.equal(b.getAttribute('title'), null);
});

test('a second reason replaces the first and the original title still comes back', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Send');
	A.gate(b, 'No message open.');
	A.gate(b, 'Say who it is going to.');
	assert.equal(b.getAttribute('title'), 'Say who it is going to.');
	A.gate(b, '');
	assert.equal(b.getAttribute('title'), 'Send');
});

test('a language change that rewrote the title under a reason is not undone by lifting it', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Ask');
	A.gate(b, 'Type a question.');
	b.setAttribute('title', 'Fragen');		// the i18n pass wrote the new language's title over ours
	A.gate(b, 'Frage eingeben.');
	assert.equal(b.getAttribute('title'), 'Frage eingeben.');
	A.gate(b, '');
	assert.equal(b.getAttribute('title'), 'Fragen', 'the new language\'s title, not the old one kept');
});

test('a press with a reason answers it and does not act; a press without one acts', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Go');
	let open = false, acted = 0;
	const said = [];
	const c = A.control(b, { can: () => (open ? '' : 'Not yet.'), act: () => { acted++; }, say: (m, bad) => said.push([m, bad]) });
	assert.equal(off(b), true, 'disabled from the start, by the reason');
	assert.equal(b.getAttribute('title'), 'Not yet.');
	// A press that gets past a disabled button (a key) is answered, not swallowed.
	b.fire('click');
	assert.equal(acted, 0);
	assert.deepEqual(said, [['Not yet.', true]]);
	open = true;
	c.sync();
	assert.equal(off(b), false);
	b.fire('click');
	assert.equal(acted, 1);
	assert.equal(said.length, 1, 'nothing more said when it can act');
});

test('state that changes between the last sync and the press is caught at the press', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Go');
	let ok = true, acted = 0;
	const said = [];
	A.control(b, { can: () => (ok ? '' : 'Gone.'), act: () => { acted++; }, say: (m) => said.push(m) });
	assert.equal(off(b), false);
	ok = false;					// nothing re-synced
	b.fire('click');
	assert.equal(acted, 0);
	assert.deepEqual(said, ['Gone.']);
	assert.equal(off(b), true, 'and the control now shows why');
});

test('a watched field re-asks as it changes, so the control follows the state', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Ask'), f = el();
	f.value = '';
	A.control(b, { can: () => (f.value.trim() ? '' : 'Type a question.'), act() {}, fields: [f] });
	assert.equal(off(b), true);
	f.value = 'why?';
	f.fire('input');
	assert.equal(off(b), false);
	f.value = '   ';
	f.fire('input');
	assert.equal(off(b), true, 'blank is empty');
	f.value = 'x';
	f.fire('change');
	assert.equal(off(b), false, 'change counts as well as input');
});

test('a held control is disabled with no reason and does not act, then lets go', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Send');
	let acted = 0;
	const c = A.control(b, { can: () => '', act: () => { acted++; } });
	c.hold(true);
	assert.equal(b.disabled, true);
	assert.equal(b.getAttribute('title'), 'Send', 'a send in flight needs no reason');
	b.fire('click');
	assert.equal(acted, 0);
	c.hold(false);
	assert.equal(b.disabled, false);
	b.fire('click');
	assert.equal(acted, 1);
});

test('a hold does not lift a reason: the control stays disabled by it afterwards', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Send');
	let to = '';
	const c = A.control(b, { can: () => (to ? '' : 'Say who.'), act() {} });
	c.hold(true);
	c.hold(false);
	assert.equal(off(b), true);
	assert.equal(b.getAttribute('title'), 'Say who.');
});

test('a control made twice on one element is the first, with one click listener', () => {
	const { DaimondAnswer: A } = load();
	const b = el('Go');
	const one = A.control(b, { can: () => '', act() {} });
	const two = A.control(b, { can: () => 'never', act() {} });
	assert.equal(one, two);
	assert.equal(b.on.click.length, 1);
	assert.equal(off(b), false);
});

test('a language change re-asks every control, so its reason is said in the new language', () => {
	const win = load();
	const A = win.DaimondAnswer;
	const b = el('Ask');
	let word = 'Type a question.';
	A.control(b, { can: () => word, act() {} });
	assert.equal(b.getAttribute('title'), 'Type a question.');
	word = 'Frage eingeben.';
	assert.equal(win.changes.length, 1, 'registered once with the language machinery');
	win.changes[0]();
	assert.equal(b.getAttribute('title'), 'Frage eingeben.');
});

// ── the state of each case ──────────────────────────────────────────────
test('Ask: an empty or blank field is a reason; a question is none', () => {
	const R = load().DaimondAnswer.reasons;
	for (const text of [ '', '   ', '\n\t', undefined, null ]) assert.equal(R.ask({ text }), 'sheet.ask_empty', JSON.stringify(text));
	assert.equal(R.ask({ text: 'why?' }), '');
	assert.equal(R.ask({ text: '  why?  ' }), '');
});

test('Ask: a composer that is not there yet is a reason of its own, ahead of the question', () => {
	const R = load().DaimondAnswer.reasons;
	assert.equal(R.ask({ text: 'why?', ready: false }), 'common.not_ready');
	assert.equal(R.ask({ text: '', ready: false }), 'common.not_ready');
	assert.equal(R.ask({ text: 'why?', ready: true }), '');
});

test('Compose Send: nothing open, then nobody to send to, then free', () => {
	const R = load().DaimondAnswer.reasons;
	assert.equal(R.send({ open: false, to: 'a@b.c' }), 'compose.none_open', 'nothing open outranks a stale address');
	assert.equal(R.send({ open: true, to: '' }), 'compose.err_no_to');
	assert.equal(R.send({ open: true, to: '   ' }), 'compose.err_no_to');
	assert.equal(R.send({ open: true, to: 'a@b.c' }), '');
});

test('Compose Save Draft, Attach and Discard need only a message open', () => {
	const R = load().DaimondAnswer.reasons;
	assert.equal(R.draft({ open: false }), 'compose.none_open');
	assert.equal(R.draft({ open: true }), '');
	assert.equal(R.draft({ open: true, to: '' }), '', 'an unaddressed draft can still be saved, attached to or discarded');
});

test('every reason the table can give is worded, in all eight languages', () => {
	const R = load().DaimondAnswer.reasons;
	const keys = new Set();
	for (const s of [ { text: '' }, { text: 'x', ready: false }, { open: false }, { open: true, to: '' } ]) for (const f of Object.values(R)) { const k = f(s); if (k) keys.add(k); }
	assert.ok(keys.size >= 4, 'the table gave only ' + keys.size + ' keys');
	for (const f of fs.readdirSync(I18N).filter((x) => x.endsWith('.js'))) {
		const src = fs.readFileSync(path.join(I18N, f), 'utf8');
		for (const k of keys) {
			const m = src.match(new RegExp("'" + k.replace(/\./g, '\\.') + "':\\s*'([^']+)'"));
			assert.ok(m && m[1].trim(), `${f} has no words for ${k}`);
		}
	}
});
