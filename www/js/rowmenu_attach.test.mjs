// UNBLOCK-24 (D-20261017-12): a brand-new Diamond's workspace is set from the Workspace panel. Every
// tree row's ⋯ offers "Add to <the Diamond>" or "Add to this chat", and "Remove from …" where the row is
// already in, through the ◈'s own path (`pressMark`), so the two cannot disagree.
//
// openRowMenu lives inside the Workspace panel's closure in a 60,000-line IIFE, so it is cut out of the
// source by its name and run alone against stand-ins for what it calls.
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readPage(join(HERE, 'daimond.js'), 'utf8');

function cut(name) {
	const at = src.indexOf('\t\tfunction ' + name + '(');
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n\t\t}\n', at);
	return src.slice(at, end + 4);
}

const css = readPage(join(HERE, '..', 'css', 'files.css'), 'utf8');

// Run the menu for one row with one focus and one attach state; return its items and the presses made.
function menu(focus, st, e) {
	const items = [], pressed = [];
	const deps = {
		attachFocus:   () => focus,
		attachStateOf: () => st,
		pressMark:     (p, d) => { pressed.push([p, d]); },
		openPop:       (key, anchor, label, fill) => fill((act, text, run) => items.push({ act, text, run }), () => {}, { dataset: {} }),
		t:             (k, a) => k + (a ? JSON.stringify(a) : ''),
		rootedRef:     (k, p) => k + ':' + p,
		attachedOf:    () => null,
		isUsersMark:   () => false,
		fetchEntry() {}, downloadPath() {}, renameEntry() {}, deleteEntry() {},
		fmtBytes: String, list() {}, curDir: '', freeEntry() {}, window: {},
	};
	const openRowMenu = new Function(...Object.keys(deps), cut('openRowMenu') + '\nreturn openRowMenu;')(...Object.values(deps));
	openRowMenu({}, e || { name: 'notes.md', dir: false }, 'notes.md', {});
	return { items, pressed };
}

const DIAMOND = { kind: 'diamond', id: 'd1', name: 'Kitchen renovation' };
const CHAT    = { kind: 'chat', id: 'c1' };
const OFF     = { on: false, away: false };
const ON      = { on: true, away: false };

test('a row not in the Diamond offers Add to it, first, and the press is the ◈ press', () => {
	const { items, pressed } = menu(DIAMOND, OFF);
	assert.equal(items[0].act, 'attach');
	assert.equal(items[0].text, 'files.add_to{"name":"Kitchen renovation"}');
	items[0].run();
	assert.deepEqual(pressed, [['notes.md', false]]);
});

test('a row already in offers Remove from it, through the same press', () => {
	const { items, pressed } = menu(DIAMOND, ON, { name: 'papers', dir: true });
	assert.equal(items[0].act, 'detach');
	assert.equal(items[0].text, 'files.remove_from{"name":"Kitchen renovation"}');
	items[0].run();
	assert.deepEqual(pressed, [['notes.md', true]]);
});

test('an ordinary chat is named as this chat', () => {
	assert.equal(menu(CHAT, OFF).items[0].text, 'files.add_to_chat');
	assert.equal(menu(CHAT, ON).items[0].text, 'files.remove_from_chat');
});

test('no item where the press would not add or remove: waiting, own folder, nothing in focus', () => {
	const acts = (f, s) => menu(f, s).items.map((i) => i.act);
	for (const a of [acts(DIAMOND, { on: true, away: true }), acts(DIAMOND, { on: true, own: true }), acts(null, OFF)]) {
		assert.ok(!a.includes('attach') && !a.includes('detach'), a.join(' '));
	}
});

test('a phone draws the ghost ◈ at rest: its touch rule outranks the hover-only hide', () => {
	// The hide is `.files-row .dm.ghost:not(.wait)` (0,4,0); a touch rule of three classes lost to it, and a
	// phone, which has no visible ⋯ either, was left with no visible way to add anything.
	const touch = css.slice(css.indexOf('@media (max-width: 760px), (pointer: coarse)'));
	const rule = touch.slice(0, touch.indexOf('\n}\n')).split('\n').find((l) => /\.dm\.ghost/.test(l) && /visibility:\s*visible/.test(l)) || '';
	assert.match(rule, /\.files-row \.dm\.ghost:not\(\.wait\)/);
});

// HATE-8: the `+` picker shows the disk as it is. A folder made while it stands open (in a terminal, say)
// appears when the person comes back to the tab, through the same listing, without Workspace › Refresh;
// and the picker stops listening once it is closed.
function cutTop(name) {
	const at = src.indexOf('\tasync function ' + name + '(');
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n\t}\n', at);
	return src.slice(at, end + 3);
}

function fakeEl() {
	const el = {
		children: [], dataset: {}, style: {}, attrs: {},
		classList: { add() {}, remove() {}, toggle() {} },
		appendChild(c) { el.children.push(c); return c; },
		setAttribute(k, v) { el.attrs[k] = v; }, removeAttribute(k) { delete el.attrs[k]; },
		addEventListener() {}, dispatchEvent() {},
	};
	Object.defineProperty(el, 'innerHTML', { set() { el.children = []; }, get() { return ''; } });
	return el;
}

test('HATE-8: the open picker re-reads the folder it shows when the tab is come back to', async () => {
	const listed = [], heard = {};
	let close;
	const win = {
		addEventListener(k, f) { (heard[k] = heard[k] || []).push(f); },
		removeEventListener(k, f) { heard[k] = (heard[k] || []).filter((g) => g !== f); },
	};
	const deps = {
		attachFocus:      () => ({ kind: 'chat', id: 'c1' }),
		attachAddGrants:  () => false,
		dialog:           (o) => { o.build(fakeEl(), { allow() {} }); return new Promise((r) => { close = r; }); },
		t:                (k) => k,
		Files:            { crumbs() {}, listing: async (d) => { listed.push(d); return { ok: true, rows: [] }; },
			attachedAll: async () => [] },
		DaimondAnswer:    { reasons: { pick: () => '' } },
		document:         { createElement: fakeEl },
		window:           win,
		kindName() {}, chatAttachSetWorkspace() {}, rootedRef() {}, attachChanged() {},
		Event:            function () {},
	};
	const attachPicker = new Function(...Object.keys(deps), cutTop('attachPicker') + '\nreturn attachPicker;')(...Object.values(deps));
	const done = attachPicker({});
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(listed, [''], 'opened: one listing of the root');
	assert.equal((heard['daimond:tabfocus'] || []).length, 1, 'the open picker listens for the tab coming back');
	heard['daimond:tabfocus'][0]();
	await new Promise((r) => setTimeout(r, 0));
	assert.deepEqual(listed, ['', ''], 'coming back re-reads the folder shown');
	close(null);
	await done;
	assert.equal((heard['daimond:tabfocus'] || []).length, 0, 'a closed picker no longer listens');
});

// HATE-10: an attached folder is CONTEXT. The composer is left as the person typed it, and the folder rides
// the first message's note (`pre`, joined ahead of the words by the engine and never shown as `content`).
function cutAny(name) {
	for (const head of ['\tasync function ' + name + '(', '\tfunction ' + name + '(']) {
		const at = src.indexOf(head);
		if (at >= 0) return src.slice(at, src.indexOf('\n\t}\n', at) + 3);
	}
	return '';
}

test('HATE-10: attaching a folder leaves the composer alone and the first message carries it as its note', async () => {
	const chat = { id: 'c1', messages: [] };
	const input = { value: '', dispatchEvent() {} };
	const names = ['attachPrefixGateOpen', 'mergeAttachPrefix', 'pushUserRecord'];
	const sync = cutAny('syncAttachPrefix') || cutAny('syncComposerAttachPrefix');
	const syncName = cutAny('syncAttachPrefix') ? 'syncAttachPrefix' : 'syncComposerAttachPrefix';
	const body = names.map(cutAny).join('\n') + '\n' + sync + '\nreturn { sync: ' + syncName + ', push: pushUserRecord };';
	const deps = {
		attachFocus:         () => ({ kind: 'chat', id: 'c1' }),
		document:            { getElementById: () => input },
		current:             chat,
		threadStarted:       (c) => !!(c && c.messages.length),
		chatAttachList:      () => [{ ref: 'dir:code/lane', path: 'code/lane', state: 'note' }],
		attachPrefixText:    (list) => 'Note ' + list.map((a) => a.path).join(', ') + '\n',
		attachReadBodies:    async () => '',
		attachPrefixSeq: 0, attachPrefixWritten: {},
		ratingPre:           () => '',
		tsPast:              (c, ts) => ts,
		Event:               function () {},
	};
	const fns = new Function(...Object.keys(deps), body)(...Object.values(deps));
	await fns.sync();
	assert.equal(input.value, '', 'the composer holds only what the person typed');
	input.value = 'Make the dialog buttons consistent.';
	const rec = fns.push(chat, { role: 'user', content: input.value, ts: 1 }, true);
	assert.equal(rec.content, 'Make the dialog buttons consistent.');
	assert.equal(rec.pre, 'Note code/lane\n', 'the folder rides the note');
	const second = fns.push(chat, { role: 'user', content: 'And the menus.', ts: 2 }, true);
	assert.equal(second.pre, undefined, 'only the first message carries it');
});
