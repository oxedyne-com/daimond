// starfill.test.mjs -- the nomination star draws filled when its device is the runner.
//
//	node --test www/js/starfill.test.mjs
//
// STARFILL (UNBLOCK-37). The owner starred a device; the "runner" badge appeared but the
// star stayed hollow. The row set `fill="currentColor"` on the svg, but a presentation
// attribute loses to any author rule, and `.ic { fill: none }` is one. The fill belongs
// in the sheet, at a weight above `.ic`, and the dead attribute goes.
import { readPage } from '../../dev/pagesrc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const read = (...p) => readPage(path.join(WWW, ...p), 'utf8');

// Flat `selector { body }` pairs of a sheet, comments dropped, at-rule bodies entered.
function rules(src) {
	src = src.replace(/\/\*[\s\S]*?\*\//g, '');
	const out = [];
	const re = /([^{}]+)\{([^{}]*)\}/g;
	let m;
	while ((m = re.exec(src))) out.push({ sel: m[1].trim(), body: m[2] });
	return out;
}

const fillOf = (body) => {
	const m = /(?:^|;)\s*fill\s*:\s*([^;]+)/.exec(body);
	return m ? m[1].trim() : null;
};

test('a nominee star is filled by a rule that outweighs .ic', () => {
	const app = rules(read('css', 'app.css'));
	const base = app.find((r) => r.sel === '.ic');
	assert.ok(base, '.ic rule present');
	assert.equal(fillOf(base.body), 'none', '.ic stays hollow by default');
	const nom = app.filter((r) => r.sel.split(',').some((s) => s.trim() === '.device-nominate.is-nominee .ic'));
	assert.ok(nom.length > 0, 'a `.device-nominate.is-nominee .ic` rule is present');
	assert.ok(nom.some((r) => fillOf(r.body) === 'currentColor'), 'it sets fill: currentColor');
});

test('no skin takes the nominee fill back', () => {
	for (const f of ['app.css', 'skin-daylight.css']) {
		for (const r of rules(read('css', f))) {
			if (!/device-nominate/.test(r.sel)) continue;
			const v = fillOf(r.body);
			assert.ok(v === null || v === 'currentColor', `${f}: ${r.sel} sets fill ${v}`);
		}
	}
});

test('the star svg carries no dead fill attribute', () => {
	const js = read('js', 'daimond.js');
	const i = js.indexOf("'device-nominate'");
	assert.ok(i > 0, 'nominate button built in daimond.js');
	const seg = js.slice(i, i + 600);
	assert.ok(!/fill="currentColor"/.test(seg), 'fill is set by the sheet, not the svg');
});
