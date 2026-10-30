// drawerhidden.test.mjs -- the phone rail, off its home page, is out of Tab and VoiceOver.
//
// Stack A2 (30 Oct 2026) retired the drawer: the rail is now the stack's home page, and
// the same hiding applies whenever another page is on top.
//
//	node --test www/js/drawerhidden.test.mjs
//
// The drawer hides by transform, so a closed drawer's controls were still in the
// Tab order and still read by VoiceOver, off the left edge (GATEFIX, r568). The first
// cut set `inert` from mobile.js, but its desktop restore runs on a 60 ms debounce
// after a resize, so a window widened from a phone's width kept a dead rail for that
// beat and the New Chat click fell through to #main (verify_handoff_fault case N).
// The closed drawer is now `visibility: hidden` in the same media query that slides
// it away, the #msheet pattern, so the layout and the hiding can never disagree.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS  = readPage(path.join(HERE, '..', 'css', 'mobile.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const JS   = readPage(path.join(HERE, 'mobile.js'), 'utf8');

// The body of the first `@media (max-width: 760px) {` block, braces balanced.
function phoneBlock() {
	const at = CSS.indexOf('@media (max-width: 760px) {');
	assert.ok(at >= 0, 'mobile.css has no phone block');
	let depth = 0;
	for (let i = CSS.indexOf('{', at); i < CSS.length; i++) {
		if (CSS[i] === '{') depth++;
		else if (CSS[i] === '}' && --depth === 0) return CSS.slice(at, i + 1);
	}
	assert.fail('the phone block never closes');
}
// The declarations of the first rule whose selector list is exactly `sel`.
function rule(src, sel) {
	const re = new RegExp('(^|[};])\\s*' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
	const m = src.match(re);
	return m ? m[2] : null;
}

test('on a phone the rail is hidden under another page and shown at home', () => {
	const ph = phoneBlock();
	const away = rule(ph, '#app:not([data-stack="home"]) .panel.rail');
	assert.ok(away && /visibility:\s*hidden/.test(away),
		'the rail under another page is off screen and must leave Tab and VoiceOver');
	// The rail is the stack's floor, not a drawer slid in (a9f9374c7 retired the slide): home draws it in place, at once.
	const HOME = readPage(path.join(HERE, '..', 'css', 'phone', 'home.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
	const at = HOME.indexOf('.home-page > #panel-rail {');
	const home = at >= 0 ? HOME.slice(at, HOME.indexOf('}', at)) : null;
	assert.ok(home && /visibility:\s*visible/.test(home), 'the home page shows the rail');
	assert.ok(/transform:\s*none/.test(home) && /transition:\s*none/.test(home), 'the home page draws the rail in place, at once');
	const base = rule(ph, '.panel.rail');
	assert.ok(base && !/visibility|transform/.test(base), 'no slide or delayed hide is left on the rail frame');
});

test('a widened window has a live rail at once: no script makes the rail inert', () => {
	assert.ok(!/\.inert\s*=/.test(JS), 'mobile.js sets inert, which only its debounced resize undoes');
	assert.ok(!/visibility/.test(rule(CSS.replace(/@media[^{]*\{[\s\S]*$/, ''), '.panel.rail') || ''),
		'the desktop rail must never hide');
});

// The focus helpers, lifted from daimond.js and run over a small DOM. A closed drawer
// still has boxes, so "has client rects" cannot mean "can take the focus" (S1MF-live).
const APP = readPage(path.join(HERE, 'daimond.js'), 'utf8');
function lift(name) {
	const m = new RegExp('\\n\\t+function ' + name + '\\(').exec(APP);
	if (!m) return '';
	let depth = 0, i = APP.indexOf('{', m.index);
	for (; i < APP.length; i++) {
		if (APP[i] === '{') depth++;
		else if (APP[i] === '}' && --depth === 0) break;
	}
	return APP.slice(m.index + 1, i + 1);
}
// A page: `shown` elements take the focus, hidden ones keep their boxes and refuse it.
function page() {
	const doc = { activeElement: null, cards: [], byId: {} };
	const el = (id, shown, kids = []) => {
		const e = {
			id, isConnected: true, offsetWidth: 10, offsetHeight: 10, parentElement: null, attrs: {},
			getClientRects: () => [{}],
			checkVisibility: () => shown,
			focus() { if (shown) doc.activeElement = e; },
			querySelectorAll: () => kids,
			hasAttribute: (k) => k in e.attrs,
			setAttribute: (k, v) => { e.attrs[k] = v; },
		};
		kids.forEach((k) => { k.parentElement = e; });
		if (id) doc.byId[id] = e;
		return e;
	};
	doc.body = el('', true); doc.documentElement = el('', true);
	doc.activeElement = doc.body;
	doc.getElementById = (id) => doc.byId[id] || null;
	doc.querySelectorAll = () => doc.cards;
	doc.querySelector = () => null;
	const names = ['refocus', 'tookFocus', 'canFocus', 'onScreen', 'focusWithin', 'handOverTarget'];
	const api = new Function('document', 'window', 'getComputedStyle',
		names.map(lift).join('\n') + '\nreturn { refocus, handOverTarget: typeof handOverTarget === "function" ? handOverTarget : null };')(
		doc, { getComputedStyle: () => ({ visibility: 'visible', opacity: '1' }) }, () => ({ visibility: 'visible', opacity: '1' }));
	return { doc, el, api };
}

test('a dialog closed over Admin on a phone leaves the focus in Admin, not on the body', () => {
	const { doc, el, api } = page();
	// The verifier pressed #user-row in the closed drawer, so the focus never left the body.
	const row = el('user-row', false), rail = el('rail', false, [row]);
	const ok = el('admin-ok', true); doc.cards = [el('admin-card', true, [ok])];
	api.refocus(doc.body, rail);
	assert.equal(doc.activeElement.id, 'admin-ok', 'the focus was left on ' + (doc.activeElement.id || 'the body'));
});

test('the unlock on a phone hands the keyboard to New Chat on the home page, not a hidden control', () => {
	const { el, api } = page();
	assert.ok(api.handOverTarget, 'daimond.js has no handOverTarget');
	el('chat-input', false); el('new-session-btn', true); el('stack-back', true);
	const next = api.handOverTarget();
	assert.equal(next && next.id, 'new-session-btn');
});

test('a dialog closed with nothing standing behind it hands the keyboard to the page, not the body', () => {
	const { doc, el, api } = page();
	// K3 on a phone: Admin was opened from the rail, now under another page, so it too is hidden.
	const row = el('user-row', false), rail = el('rail', false, [row]);
	doc.cards = [el('admin-card', false, [el('admin-ok', false)])];
	el('chat-input', true); el('new-session-btn', false);
	api.refocus(doc.body, rail);
	assert.equal(doc.activeElement.id, 'chat-input', 'the focus was left on ' + (doc.activeElement.id || 'the body'));
});
