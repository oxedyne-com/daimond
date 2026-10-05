// answer.cases.test.mjs -- the real Ask pill and Compose code, run against stand-in elements.
//
//	node --test www/js/answer.cases.test.mjs
//
// answer.test.mjs proves the helper and the reasons table; answer.wiring.test.mjs proves the
// source routes through them. This runs the shipped code itself: the sources of the Ask pill
// (mobile.js) and of Compose (daimond.js) are cut out by their banners and evaluated against
// stand-ins, so what is asserted is what a press does in each state, not what the source says.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src  = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const cut  = (s, from, to) => {
	const a = s.indexOf(from), b = s.indexOf(to, a);
	assert.ok(a >= 0 && b > a, `cannot cut ${JSON.stringify(from)} .. ${JSON.stringify(to)}: the banners moved`);
	return s.slice(a, b);
};

function el(init = {}) {
	const e = Object.assign({ disabled: false, value: '', attrs: new Map(), on: {}, children: [], className: '', textContent: '', innerHTML: '', clicks: 0 }, init);
	e.getAttribute = (k) => (e.attrs.has(k) ? e.attrs.get(k) : null);
	e.setAttribute = (k, v) => { e.attrs.set(k, String(v)); };
	e.removeAttribute = (k) => { e.attrs.delete(k); };
	e.addEventListener = (ev, fn) => { (e.on[ev] = e.on[ev] || []).push(fn); };
	e.fire = async (ev) => { for (const fn of e.on[ev] || []) await fn({ type: ev, preventDefault() {} }); };
	e.appendChild = (c) => { e.children.push(c); };
	e.focus = () => {};
	e.click = () => { e.clicks++; return e.fire('click'); };
	return e;
}
const off = (b) => b.getAttribute('aria-disabled') === 'true';		// a reason, as a phone sees it (r533 QA B-4)
const words = (k, v) => '[' + k + (v ? ' ' + JSON.stringify(v) : '') + ']';

function answer() {
	const win = { DaimondI18n: { onChange() {} } };
	new Function('window', src('answer.js'))(win);
	return win.DaimondAnswer;
}

// ── the Ask pill, from mobile.js ────────────────────────────────────────
function ask(ready = true) {
	const body = cut(src('mobile.js'), '\tvar askCtl;', '\t// ── Init');
	const input = el(), send = el({ attrs: new Map([ [ 'title', 'Ask' ] ]) });
	const asked = [], snaps = [];
	const win = ready ? { DaimondCore: { ask: (t) => asked.push(t) } } : {};
	const make = new Function('DaimondAnswer', 'askInput', 'window', 't', 'snapTo', 'DaimondCore',
		body + '; return { askWhy: askWhy, ask: ask, say: askSay, set: function (c) { askCtl = c; }, note: function (n) { askNote = n; } };');
	const m = make(answer(), input, win, words, (d) => snaps.push(d), win.DaimondCore);
	input.blur = () => {};
	return { input, send, asked, snaps, m };
}

test('Ask: with an empty field the pill is disabled and says why', () => {
	const A = answer();
	const b = ask();
	const c = A.control(b.send, { can: b.m.askWhy, act: b.m.ask, fields: [ b.input ] });
	assert.equal(off(b.send), true);
	assert.equal(b.send.getAttribute('title'), '[sheet.ask_empty]');
	assert.equal(c.go(), false);
	assert.deepEqual(b.asked, []);
});

test('Ask: a question enables it, a press forwards the trimmed text, clears the field and disables it again', async () => {
	const A = answer();
	const b = ask();
	const c = A.control(b.send, { can: b.m.askWhy, act: b.m.ask, fields: [ b.input ] });
	b.m.set(c);
	b.input.value = '  what is this?  ';
	await b.input.fire('input');
	assert.equal(off(b.send), false);
	assert.equal(b.send.getAttribute('title'), 'Ask');
	c.go();
	assert.deepEqual(b.asked, [ 'what is this?' ]);
	assert.equal(b.input.value, '');
	assert.equal(off(b.send), true, 'a script clearing the field raises no input event, so the pill is re-asked');
	assert.deepEqual(b.snaps, [ 'peek' ]);
});

test('Ask: before the composer is there the pill says so, whatever is typed', () => {
	const A = answer();
	const b = ask(false);
	b.input.value = 'hello';
	const c = A.control(b.send, { can: b.m.askWhy, act: b.m.ask, fields: [ b.input ] });
	assert.equal(off(b.send), true);
	assert.equal(b.send.getAttribute('title'), '[common.not_ready]');
	c.go();
	assert.deepEqual(b.asked, []);
});

test('Ask: a tap or an Enter on the empty pill is answered in the sheet\'s note line, and typing lifts it', async () => {
	const A = answer();
	const b = ask();
	const note = el(); note.hidden = true;
	b.m.note(note);
	const c = A.control(b.send, { can: b.m.askWhy, act: b.m.ask, say: b.m.say, fields: [ b.input ] });
	b.m.set(c);
	assert.equal(b.send.disabled, false, 'not disabled, so a phone tap is delivered');
	assert.equal(note.hidden, true, 'nothing said until a press');
	await b.send.fire('click');
	assert.deepEqual(b.asked, []);
	assert.equal(note.textContent, '[sheet.ask_empty]');
	assert.equal(note.hidden, false);
	b.input.value = 'why?';
	await b.input.fire('input');
	assert.equal(note.textContent, '', 'a question lifts the reason');
	assert.equal(note.hidden, true);
});

test('Ask: "Not ready yet." is said on a press and lifts when the composer arrives and the control is re-asked', () => {
	const A = answer();
	const win = { DaimondCore: {} };
	const input = el({ value: 'hello' }), send = el({ attrs: new Map([ [ 'title', 'Ask' ] ]) });
	const body = cut(src('mobile.js'), '\tvar askCtl;', '\t// ── Init');
	const make = new Function('DaimondAnswer', 'askInput', 'window', 't', 'snapTo', 'DaimondCore',
		body + '; return { askWhy: askWhy, ask: ask, say: askSay, note: function (n) { askNote = n; } };');
	const m = make(A, input, win, words, () => {}, win.DaimondCore);
	const note = el(); note.hidden = true; m.note(note);
	const c = A.control(send, { can: m.askWhy, act: m.ask, say: m.say, fields: [ input ] });
	c.go();
	assert.equal(note.textContent, '[common.not_ready]');
	assert.equal(off(send), true);
	win.DaimondCore.ask = () => {};				// the composer is published
	A.syncAll();
	assert.equal(off(send), false, 'and the pill follows without a keystroke');
	assert.equal(note.hidden, true);
});

// ── Compose, from daimond.js ────────────────────────────────────────────
function compose() {
	const body = cut(src('daimond.js'), '\t// ── Compose: one panel, its buttons bound once', '\t/// A mail date as a person writes one');
	const ids = {};
	for (const id of [ 'from', 'to', 'cc', 'subject', 'text', 'atts', 'title', 'note', 'send', 'save', 'attach', 'discard', 'file' ]) ids['compose-' + id] = el();
	ids['compose-send'].attrs.set('title', 'Send');
	ids['compose-file'].files = [];
	const doc = { getElementById: (id) => ids[id] || null, createElement: () => el() };
	const log = { confirms: [], sent: [], saved: [], discarded: 0, hidden: 0, reflow: 0, opened: 0 };
	let yes = true;
	const stubs = {
		document: doc, t: words, DaimondAnswer: answer(), fmtBytes: String,
		confirmDialog: async (...a) => { log.confirms.push(a[1]); return yes; },
		friendlyError: (e) => 'ERR ' + e.message,
		DaimondGateway: { fmtMoney: (n) => '$' + n },
		DaimondPanels: { show() { log.opened++; }, hide() { log.hidden++; }, reflow() { log.reflow++; } },
	};
	const names = Object.keys(stubs);
	const make = new Function(...names, body + '; return { initCompose: initCompose, showCompose: showCompose };');
	const m = make(...names.map((n) => stubs[n]));
	const view = (over = {}) => Object.assign({ draft: { to: '', subject: '' }, from: [ 'me@x.io' ],
		send: async (f) => { log.sent.push(f); return {}; },
		save: async (f) => { log.saved.push(f); return '/drafts/1'; },
		discard: async () => { log.discarded++; },
		sent: () => {} }, over);
	return { ids, log, m, view, say: (v) => { yes = v; },
		btn: { send: ids['compose-send'], save: ids['compose-save'], attach: ids['compose-attach'], discard: ids['compose-discard'] } };
}

test('Compose: before any message is open all four buttons are disabled and say so', () => {
	const c = compose();
	c.m.initCompose();
	for (const [ k, b ] of Object.entries(c.btn)) {
		assert.equal(off(b), true, k + ' must not be a live button with nothing behind it');
		assert.equal(b.getAttribute('title'), '[compose.none_open]', k);
	}
});

test('Compose: a message with no address leaves Send disabled for want of one, and the rest live', () => {
	const c = compose();
	c.m.initCompose();
	c.m.showCompose(c.view());
	assert.equal(off(c.btn.send), true);
	assert.equal(c.btn.send.getAttribute('title'), '[compose.err_no_to]');
	for (const k of [ 'save', 'attach', 'discard' ]) assert.equal(off(c.btn[k]), false, k);
});

test('Compose: typing an address enables Send, and clearing it disables it again', async () => {
	const c = compose();
	c.m.initCompose();
	c.m.showCompose(c.view());
	c.ids['compose-to'].value = 'a@b.co';
	await c.ids['compose-to'].fire('input');
	assert.equal(off(c.btn.send), false);
	assert.equal(c.btn.send.getAttribute('title'), 'Send');
	c.ids['compose-to'].value = ' ';
	await c.ids['compose-to'].fire('input');
	assert.equal(off(c.btn.send), true);
});

test('Compose: a message that arrives addressed has Send live at once, with no keystroke', () => {
	const c = compose();
	c.m.initCompose();
	c.m.showCompose(c.view({ draft: { to: 'a@b.co', subject: 'Re: hi', inReplyTo: 'x' } }));
	assert.equal(off(c.btn.send), false);
});

test('Compose: Send confirms, sends the fields, closes the panel, and every button then says none is open', async () => {
	const c = compose();
	c.m.initCompose();
	c.m.showCompose(c.view({ draft: { to: 'a@b.co', subject: 's' } }));
	c.ids['compose-text'].value = 'body';
	await c.btn.send.click();
	assert.equal(c.log.sent.length, 1);
	assert.equal(c.log.sent[0].to, 'a@b.co');
	assert.equal(c.log.sent[0].body, 'body');
	assert.equal(c.log.hidden, 1);
	assert.equal(c.ids['compose-note'].textContent, 'Sent.');
	for (const b of Object.values(c.btn)) { assert.equal(off(b), true); assert.equal(b.getAttribute('title'), '[compose.none_open]'); }
	// And a press that still reaches Send is answered, not dropped.
	await c.btn.send.click();
	assert.equal(c.log.sent.length, 1);
	assert.equal(c.ids['compose-note'].textContent, '[compose.none_open]');
	assert.equal(c.ids['compose-note'].className, 'compose-note err');
});

test('Compose: declining the confirmation sends nothing and leaves the draft up', async () => {
	const c = compose();
	c.m.initCompose();
	c.m.showCompose(c.view({ draft: { to: 'a@b.co' } }));
	c.say(false);
	await c.btn.send.click();
	assert.equal(c.log.sent.length, 0);
	assert.equal(c.log.hidden, 0);
	assert.equal(off(c.btn.save), false);
});

test('Compose: a send that fails says why in the note and the buttons come back', async () => {
	const c = compose();
	c.m.initCompose();
	c.m.showCompose(c.view({ draft: { to: 'a@b.co' }, send: async () => { throw new Error('no route'); } }));
	await c.btn.send.click();
	assert.equal(c.ids['compose-note'].textContent, 'ERR no route');
	assert.equal(c.ids['compose-note'].className, 'compose-note err');
	assert.equal(off(c.btn.send), false);
	assert.equal(off(c.btn.save), false);
});

test('Compose: Save Draft reports where it saved, and Discard confirms, discards and closes', async () => {
	const c = compose();
	c.m.initCompose();
	c.m.showCompose(c.view());
	await c.btn.save.click();
	assert.equal(c.log.saved.length, 1);
	assert.equal(c.ids['compose-note'].textContent, 'Saved to /drafts/1');
	await c.btn.discard.click();
	assert.equal(c.log.discarded, 1);
	assert.equal(c.log.hidden, 1);
	assert.equal(off(c.btn.save), true, 'a discarded draft leaves nothing for Save to act on');
});

test('Compose: opening the next message does not leave the last one\'s handlers behind', async () => {
	const c = compose();
	c.m.initCompose();
	const first = [], second = [];
	c.m.showCompose(c.view({ draft: { to: 'one@x.io' }, send: async (f) => { first.push(f.to); return {}; } }));
	c.m.showCompose(c.view({ draft: { to: 'two@x.io' }, send: async (f) => { second.push(f.to); return {}; } }));
	assert.equal(c.btn.send.on.click.length, 1, 'one click handler, bound at boot');
	await c.btn.send.click();
	assert.deepEqual(first, []);
	assert.deepEqual(second, [ 'two@x.io' ]);
});

// ── Workspace Refresh, from daimond.js: it says "Refreshed." only when a listing was drawn ──
function workspace(listOutcome) {
	const s = src('daimond.js');
	const ld   = cut(s, '\t\tasync function listDiamond(dir) {', '\t\t/// A row for something in the Diamond\'s own directory');
	const ls   = cut(s, '\t\tasync function list(dir) {', '\t\t// ── What the tree used to keep from you');
	const act  = cut(s, '{ act: async function () {', '} });\n\t\t\tvar newBtn');
	const treeEl = el(), notes = [];
	const doc = { createElement: () => el() };
	const tools = () => ({ run_tool_outcome: async () => listOutcome });
	const body = ld + '\n' + ls + '\n; return { list: list, listDiamond: listDiamond, refresh: ' + act.replace(/^\{ act: /, '') + '} };';
	const make = new Function('document', 'tools', 'treeEl', 'viewEl', 'pathEl', 'syncLineNo', 'loadAttached', 'paintReach',
		'renderCrumbs', 'goDir', 't', 'toolReason', 'renderTree', 'parseListing', 'refreshResidency', 'ownDir', 'upRow',
		'diamondOwnRow', 'statAttachments', 'attached', 'attachedRow', 'daimonGroupRow', 'diamondScope', 'showModeMsg',
		'DaimondAnswer', 'window',
		'var curDir = "", curFile = null, listed = false, lastEntries = [], daimonGroupOpen = false;\n' + body);
	const noop = () => {};
	const m = make(doc, tools, treeEl, el({ style: {} }), el(), noop, async () => {}, noop, noop, noop, words, (r) => 'ERR ' + (r && r.text), noop,
		(txt) => [ { name: txt, dir: false } ], noop, () => 'own', () => null, () => el(), async () => {}, [], () => el(), () => el(),
		() => true, (text, isErr, ms) => notes.push({ text, isErr: !!isErr, ms }), answer(), {});
	return { m, treeEl, notes };
}

test('Refresh in Diamond scope: a listing that drew an error is not "Refreshed."', async () => {
	const w = workspace({ outcome: 'failed', text: 'no such folder' });
	// The panel's Refresh looks at curDir; open a sub-folder first, as a person would, so the listing runs.
	assert.equal(await w.m.listDiamond('sub'), false, 'listDiamond must say it drew an error');
	assert.equal(w.treeEl.children.length, 1);
	assert.equal(w.treeEl.children[0].textContent, 'ERR no such folder');
	assert.equal(await w.m.list('sub'), false, 'list() must pass the failure on');
	await w.m.refresh();
	assert.deepEqual(w.notes, [], 'a failed redraw says nothing false; the error row in the tree is the answer');
});

test('Refresh in Diamond scope: a listing that drew rows says "Refreshed." for three seconds', async () => {
	const w = workspace({ outcome: 'done', text: 'a.txt' });
	assert.equal(await w.m.listDiamond('sub'), true);
	assert.equal(await w.m.list('sub'), true);
	await w.m.refresh();
	assert.deepEqual(w.notes, [ { text: '[files.refreshed]', isErr: false, ms: 3000 } ]);
});

// ── the home composer's Send, from daimond.js ───────────────────────────
function homeSend(opts = {}) {
	const body = cut(src('daimond.js'), '\t/// What the one button under the composer means right now.', '\t// ── Meters');
	const chatSend = el({ attrs: new Map([ [ 'title', 'Send' ] ]) }), chatInput = el({ value: opts.value || '' });
	const log = { stopped: 0, sent: 0, toasts: [], focused: 0 };
	chatInput.focus = () => { log.focused++; };
	chatSend.classList = { toggle() {}, add() {}, remove() {} };
	const toasts = [];
	const make = new Function('DaimondAnswer', 'chatSend', 'chatInput', 'chatStop', 'curGen', 't', 'SEND_ARROW', 'toast', 'stopGeneration', 'sendUserMessage',
		'var current = ' + (opts.sending ? '{ _sending: true }' : 'null') + '; var sendCtl = null;'
		+ body + '; return { bind: function () { return bindSend(); }, sync: syncSendMode, mode: sendMode, set: function (c) { current = c; } };');
	const toast = (text, isErr) => { const b = { text, isErr, parentNode: { removeChild(x) { log.toasts.splice(log.toasts.indexOf(x), 1); } } }; log.toasts.push(b); toasts.push(text); return b; };
	const m = make(answer(), chatSend, chatInput, null, () => !!opts.running, words, '<arrow>', toast, () => { log.stopped++; }, () => { log.sent++; });
	return { chatSend, chatInput, log, m, toasts };
}

test('Home Send: an empty box is dimmed with the reason, and a press answers it and sends nothing', async () => {
	const h = homeSend();
	h.m.bind();
	assert.equal(off(h.chatSend), true);
	assert.equal(h.chatSend.disabled, false, 'not disabled, so a phone tap is delivered');
	assert.equal(h.chatSend.getAttribute('title'), '[sheet.ask_empty]');
	await h.chatSend.fire('click');
	assert.equal(h.log.sent, 0);
	assert.deepEqual(h.toasts, [ '[sheet.ask_empty]' ], 'the press is answered where the person can see it');
	assert.equal(h.log.focused, 1, 'and the cursor goes to the box that wants the words');
	await h.chatSend.fire('click');
	assert.equal(h.log.toasts.length, 1, 'a second press replaces the first note, it does not stack');
});

test('Home Send: typing lifts the reason and a press sends once', async () => {
	const h = homeSend();
	h.m.bind();
	h.chatInput.value = 'hello';
	await h.chatInput.fire('input');
	assert.equal(off(h.chatSend), false);
	assert.equal(h.chatSend.getAttribute('title'), 'Send', 'the title it had is given back');
	await h.chatSend.fire('click');
	assert.equal(h.log.sent, 1); assert.equal(h.log.stopped, 0); assert.deepEqual(h.toasts, []);
});

test('Home Send: a script emptying the box re-asks, since it raises no input event', () => {
	const h = homeSend({ value: 'hello' });
	h.m.bind();
	assert.equal(off(h.chatSend), false);
	h.chatInput.value = '';
	h.m.sync();
	assert.equal(off(h.chatSend), true);
});

test('Home Send: with a turn running and the box empty it is Stop, which acts', async () => {
	const h = homeSend({ running: true });
	h.m.bind();
	assert.equal(h.m.mode(), 'stop');
	assert.equal(off(h.chatSend), false, 'Stop is never dimmed for want of words');
	await h.chatSend.fire('click');
	assert.equal(h.log.stopped, 1); assert.equal(h.log.sent, 0);
});

test('Home Send: while a press is in flight it is really disabled with no reason, and a second press does nothing', async () => {
	const h = homeSend({ value: 'hello', sending: true });
	h.m.bind();
	h.m.sync();
	assert.equal(h.chatSend.disabled, true);
	assert.equal(off(h.chatSend), false, 'a hold gives no reason');
	await h.chatSend.fire('click');
	assert.equal(h.log.sent, 0);
	h.m.set(null);
	h.m.sync();
	assert.equal(h.chatSend.disabled, false, 'released with the press');
});

// ── Mail's Sync now, from mail.js ───────────────────────────────────────
// `note` is the helper's own, so a stand-in host carries just what it touches, and the timers are caught
// to be run by the test rather than waited for.
function mailSync(sel) {
	const timers = [];
	const win = { DaimondI18n: { onChange() {} } };
	new Function('window', 'setTimeout', src('answer.js'))(win, (fn, ms) => { timers.push({ fn, ms }); return 0; });
	const host = el();
	host.ownerDocument = { createElement: () => el() };
	host.querySelector = () => host.children.find((c) => /panel-say/.test(c.className)) || null;
	host.insertBefore = (n) => { n.parentNode = host; host.children.unshift(n); };
	host.removeChild = (n) => { host.children.splice(host.children.indexOf(n), 1); n.parentNode = null; };
	const body = cut(src('mail.js'), '\t// ── Sync now', '\t// ── Wiring');
	const state = { sel }, els = { state: host }, synced = [];
	const btn = el({ attrs: new Map([ [ 'title', 'Sync now' ] ]) });
	const make = new Function('DaimondAnswer', 'state', 'els', 't', 'syncAccount',
		body + '; return { bind: bindSync, ctl: function () { return syncCtl; } };');
	const m = make(win.DaimondAnswer, state, els, words, (a) => synced.push(a));
	return { m, state, host, btn, synced, timers };
}

test('Mail Sync now: with no mailbox it is dimmed with a reason, and a press says why and syncs nothing', async () => {
	const s = mailSync(null);
	s.m.bind(s.btn);
	assert.equal(off(s.btn), true);
	assert.equal(s.btn.getAttribute('title'), '[trig.no_mailbox]');
	assert.equal(s.btn.disabled, false, 'a tap on a phone must still arrive to be answered');
	await s.btn.click();
	assert.deepEqual(s.synced, []);
	assert.equal(s.host.children.length, 1);
	assert.equal(s.host.children[0].textContent, '[trig.no_mailbox]');
	assert.equal(s.host.children[0].className, 'panel-say');
	// One line at a time, and it takes its leave.
	await s.btn.click();
	assert.equal(s.host.children.length, 1);
	const last = s.timers[s.timers.length - 1];
	assert.equal(last.ms, 3000);
	last.fn();
	assert.equal(s.host.children.length, 0);
});

test('Mail Sync now: with a mailbox it is live and acts as it did, with no note', async () => {
	const s = mailSync('me@x.io');
	s.m.bind(s.btn);
	assert.equal(off(s.btn), false);
	assert.equal(s.btn.getAttribute('title'), 'Sync now');
	await s.btn.click();
	assert.deepEqual(s.synced, [ 'me@x.io' ]);
	assert.equal(s.host.children.length, 0);
});

test('Mail Sync now: a mailbox arriving or leaving re-asks it, since the panel draws on both', async () => {
	const s = mailSync(null);
	s.m.bind(s.btn);
	s.state.sel = 'me@x.io';
	s.m.ctl().sync();
	assert.equal(off(s.btn), false);
	assert.equal(s.btn.getAttribute('title'), 'Sync now', 'the title it had comes back');
	s.state.sel = null;
	s.m.ctl().sync();
	assert.equal(off(s.btn), true);
	await s.btn.click();
	assert.deepEqual(s.synced, []);
});
