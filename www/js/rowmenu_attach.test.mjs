// UNBLOCK-24 (D-20261017-12): a brand-new Diamond's workspace is set from the Workspace panel. Every
// tree row's ⋯ offers "Add to <the Diamond>" or "Add to this chat", and "Remove from …" where the row is
// already in, through the ◈'s own path (`pressMark`), so the two cannot disagree.
//
// openRowMenu lives inside the Workspace panel's closure in a 60,000-line IIFE, so it is cut out of the
// source by its name and run alone against stand-ins for what it calls.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(HERE, 'daimond.js'), 'utf8');

function cut(name) {
	const at = src.indexOf('\t\tfunction ' + name + '(');
	assert.ok(at >= 0, name + ' is not in daimond.js');
	const end = src.indexOf('\n\t\t}\n', at);
	return src.slice(at, end + 4);
}

const css = readFileSync(join(HERE, '..', 'css', 'files.css'), 'utf8');

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
