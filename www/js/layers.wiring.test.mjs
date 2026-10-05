// layers.wiring.test.mjs -- that every layer the app opens goes through the stack.
//
//	node --test www/js/layers.wiring.test.mjs
//
// layers.test.mjs proves the stack. This proves nothing opens AROUND it: the
// next dialog somebody writes, or the next place that flips `drawer-open`, would
// otherwise bring back a surface the platform's Back leaves the app from, and no
// unit test of the stack could see it. The checks are over the source, by role:
// every builder of a `.modal` registers it, the drawer and a popover have one
// opener and one closer each, and the safe-area inset is applied to each role of
// layer head by ONE rule of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const read = (...p) => fs.readFileSync(path.join(WWW, ...p), 'utf8');
const JS   = fs.readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.test.mjs'));
const count = (s, re) => (s.match(re) || []).length;

test('every file that builds a modal registers it with the stack', () => {
	// className = 'modal ...', elt('div', 'modal'), '<div class="modal ...'.
	const BUILD = /className\s*=\s*'modal[ ']|elt\('div',\s*'modal'\)|html\('<div class="modal[ "]/g;
	let builders = 0;
	for (const f of JS) {
		const s = read('js', f), n = count(s, BUILD);
		if (!n) continue;
		builders += n;
		const reg = count(s, /DaimondLayers\.open\(/g);
		assert.ok(reg >= 1, `${f} builds ${n} modal(s) and never calls DaimondLayers.open`);
	}
	assert.ok(builders >= 8, 'the scan found only ' + builders + ' modal builders; the pattern has drifted');
});

test('every opener of a dialog has the matching closer reporting it', () => {
	for (const f of JS) {
		const s = read('js', f);
		const opens = count(s, /DaimondLayers\.open\(DaimondLayers\.uid\('dialog'\)/g);
		const dones = count(s, /DaimondLayers\.done\(lid\)/g);
		assert.equal(dones >= opens, true, `${f}: ${opens} dialog layer(s) opened, ${dones} closed`);
	}
});

test('the drawer\'s class changes in one opener and one closer', () => {
	let hits = 0;
	for (const f of JS) hits += count(read('js', f), /classList\.(add|remove|toggle)\('drawer-open'/g);
	assert.equal(hits, 2, 'drawer-open is flipped in ' + hits + ' places');
	const m = read('js', 'mobile.js');
	assert.match(m, /function openDrawer\(\) \{[^}]*DaimondLayers\.open\('drawer'/s);
	assert.match(m, /function closeDrawer\(\) \{[^}]*DaimondLayers\.done\('drawer'/s);
});

test('a popover is hidden in one place, which tells the stack', () => {
	const w = read('js', 'workspace.js');
	assert.match(w, /function hidePop\(pop\) \{\s*pop\.hidden = true;\s*DaimondLayers\.done\('pop'\);/);
	assert.equal(count(w, /\b(menuEl|galEl|el|pop)\.hidden = true/g), 1, 'a popover is hidden somewhere other than hidePop');
	assert.equal(count(read('js', 'handmode.js'), /pop\.hidden = true/g), 0);
	assert.match(w, /function openPop[\s\S]*?DaimondLayers\.open\('pop'/);
});

test('the sheet, the palette and the Admin drawer register and report', () => {
	const m = read('js', 'mobile.js'), w = read('js', 'workspace.js'), d = read('js', 'daimond.js');
	assert.match(m, /DaimondLayers\.open\('sheet'/);
	assert.match(m, /DaimondLayers\.done\('sheet'\)/);
	assert.match(w, /DaimondLayers\.open\('palette'/);
	assert.match(w, /DaimondLayers\.done\('palette'\)/);
	for (const id of [ 'admin', 'admin-view' ]) {
		assert.match(d, new RegExp(`DaimondLayers\\.open\\('${id}'`));
		assert.match(d, new RegExp(`DaimondLayers\\.done\\('${id}'\\)`));
	}
});

test('nothing overwrites the history state a layer entry carries', () => {
	for (const f of JS) assert.equal(count(read('js', f), /history\.replaceState\(\{\}/g), 0, f);
});

test('the stack is loaded before anything that opens a surface', () => {
	const h = read('index.html');
	const at = (name) => h.indexOf(`<script src="js/${name}"></script>`);
	assert.ok(at('layers.js') > 0, 'layers.js is not loaded');
	for (const f of [ 'mobile.js', 'workspace.js', 'pairing.js', 'mail.js', 'report.js', 'handmode.js', 'passcode.js', 'graph.js', 'dockdrag.js' ]) {
		assert.ok(at(f) < 0 || at('layers.js') < at(f), `layers.js must come before ${f}`);
	}
	assert.match(h, /viewport-fit=cover/);
});

// ── Escape is the stack's, not the module's (r535 U4) ───────────────────────

// How many quoted 'Escape' each file may hold in code, and why: the router itself, the one full-screen
// bubble listener that must see what the router did not take, the recorder's list of keys worth keeping,
// and the terminal, where Escape is a byte for the program in it.
const ESCAPE_ALLOW = { 'layers.js': 1, 'daimond.js': 1, 'record.js': 1, 'terminal.js': 3 };

/// The source without its comments, so that a note about Escape is not taken for a handler of it.
const code = (s) => s
	.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
	.split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

test('no module answers Escape for itself, outside the few that must', () => {
	for (const f of JS) {
		const n = count(code(read('js', f)), /['"`]Escape['"`]/g);
		assert.equal(n, ESCAPE_ALLOW[f] || 0, `${f} compares a key with 'Escape' ${n} time(s) in code; ${ESCAPE_ALLOW[f] || 0} allowed`);
	}
});

test('the terminal marks the three elements that own Escape as input', () => {
	const t = read('js', 'terminal.js');
	for (const v of [ 'input', 'paste', 'menu' ]) {
		assert.match(t, new RegExp(`\\b${v}\\.setAttribute\\('data-own-escape'`), `terminal.js: ${v} is not marked data-own-escape`);
	}
});

test('what Escape used to close is a layer, or a claim the router asks', () => {
	const d = read('js', 'daimond.js'), p = read('js', 'passcode.js'), m = read('js', 'mobile.js');
	// The Chats menu is a layer: Back closes it as well.
	assert.match(d, /DaimondLayers\.open\('chatsmenu', closeChatsMenu(, anchor)?\)/);
	assert.match(d, /function closeChatsMenu\(\) \{[^}]*DaimondLayers\.done\('chatsmenu'\)/s);
	// The composer's skill menu and the link form are claims: key modes, no history.
	assert.match(d, /DaimondLayers\.claim\('skill', /);
	assert.match(d, /DaimondLayers\.release\('skill'\)/);
	assert.match(d, /DaimondLayers\.claim\('linkform', /);
	// The passcode dialog is a dialog layer like pairing's and mail's.
	assert.match(p, /DaimondLayers\.open\(DaimondLayers\.uid\('dialog'\), /);
	assert.match(p, /DaimondLayers\.done\(lid\)/);
	// The drawer hides by transform, so it carries a closer of its own, which also gives the focus back to the burger.
	assert.match(m, /function leaveDrawer\(\) \{[^}]*closeDrawer\(\)[^}]*drawer-btn/s);
	assert.match(m, /DaimondLayers\.open\('drawer', leaveDrawer\)/);
	assert.match(m, /DaimondLayers\.open\('sheet'/);
	// The drag and the graph are claims, held for the page's life, that decline when idle.
	assert.match(read('js', 'dockdrag.js'), /DaimondLayers\.claim\('dockdrag', /);
	assert.match(read('js', 'graph.js'), /DaimondLayers\.claim\('graph', /);
});

test('a claim that is not a surface never opens a history entry', () => {
	for (const f of [ 'dockdrag.js', 'graph.js' ]) {
		const s = read('js', f);
		assert.equal(count(s, /DaimondLayers\.open\(/g), 0, `${f} keeps its Escape as a claim; it must not also open a layer`);
	}
});

// ── The safe-area inset, one rule per role of layer ─────────────────────────

const rule = (css, sel) => {
	const i = css.indexOf(sel);
	assert.ok(i >= 0, 'no rule for ' + sel);
	return css.slice(i, css.indexOf('}', i));
};

test('the phone\'s modal, its card and the identity card keep clear of the status bar', () => {
	const css = read('css', 'mobile.css');
	assert.match(rule(css, '.modal { padding:'), /var\(--safe-t\)/);
	assert.match(rule(css, '.modal-card {'), /var\(--safe-t\)/);
	assert.match(rule(css, '#identity-modal .modal-card'), /var\(--safe-t\)/);
});

test('the Admin drawer on a phone stands inside the rail\'s own inset', () => {
	assert.match(rule(read('css', 'mobile.css'), '.panel.rail .admin-body {'), /top:\s*calc\(8px \+ var\(--safe-t\)\)/);
});

test('the palette stands below the status bar at any height', () => {
	const css = read('css', 'workspace.css');
	assert.match(rule(css, '.pal-scrim {'), /var\(--safe-t\)/);
	assert.match(rule(css, '.pal-scrim { padding-top'), /var\(--safe-t\)/);
});

test('the guide\'s header keeps its controls under the status bar', () => {
	assert.match(rule(read('css', 'guide.css'), '.site-head {'), /padding-top:\s*var\(--safe-t\)/);
});

test('a popover\'s head stays put while its rows scroll', () => {
	assert.match(rule(read('css', 'app.css'), '.pop > .ui-head { position'), /position:\s*sticky/);
});

test('a popover opened from a row of the fold gives the stack the fold\'s own button to return to', () => {
	// Settings is a row of Help's popover on a phone. Opening it hides that popover, so the row is not drawn when
	// the layer is recorded, and Escape would give the keyboard to the page instead of to Help (r535 K1).
	const w = read('js', 'workspace.js');
	const open = w.slice(w.indexOf('function openPop'), w.indexOf('function hidePop'));
	assert.match(open, /getClientRects\(\)\.length/, 'openPop does not ask whether the anchor is drawn');
	assert.match(open, /getElementById\('help-btn'\)/, 'openPop has no drawn trigger to fall back on');
	assert.match(open, /DaimondLayers\.open\('pop',[\s\S]*?\},\s*back\)/, 'the stack is not handed the drawn trigger');
});
