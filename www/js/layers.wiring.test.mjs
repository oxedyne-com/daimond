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
	for (const f of [ 'mobile.js', 'workspace.js', 'pairing.js', 'mail.js', 'report.js', 'handmode.js' ]) {
		assert.ok(at(f) < 0 || at('layers.js') < at(f), `layers.js must come before ${f}`);
	}
	assert.match(h, /viewport-fit=cover/);
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
