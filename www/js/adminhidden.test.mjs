// adminhidden.test.mjs -- a Settings row given `hidden` is not drawn (SETTINGS-IA, D-20261024-16).
//
//	node --test www/js/adminhidden.test.mjs
//
// `.admin-item` sets `display: block`, and an author `display` beats the browser's own
// `[hidden] { display: none }`, so "Open debug panel" and "Share diagnostic log" showed while
// diagnostics was off although daimond.js sets `hidden` on both. One rule in app.css, outside
// any media query, puts the attribute back in charge for every Settings row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS  = readFileSync(join(HERE, '..', 'css', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// The top-level rules only: a rule inside @media holds in some widths, not all.
function topRules(css) {
	const out = [];
	let d = 0, start = 0, sel = '';
	for (let i = 0; i < css.length; i++) {
		if (css[i] === '{') { if (d === 0) { sel = css.slice(start, i).trim(); start = i + 1; } d++; }
		else if (css[i] === '}') { d--; if (d === 0) { out.push([sel, css.slice(start, i)]); start = i + 1; } }
	}
	return out;
}

test('a hidden .admin-item is display:none at every width', () => {
	const hit = topRules(CSS).find(([sel, body]) =>
		sel.split(',').map(s => s.trim()).includes('.admin-item[hidden]')
		&& /display\s*:\s*none/.test(body));
	assert.ok(hit, 'app.css has no top-level `.admin-item[hidden] { display: none }`');
});

test('daimond.js still hides the two diagnostics rows by the attribute', () => {
	const js = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	assert.match(js, /panelBtn\.hidden = !diagOn/);
	assert.match(js, /shareBtn\.hidden = !diagOn/);
});
