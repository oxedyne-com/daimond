// headgap.test.mjs -- the section head owns the gap before it, whatever stands there.
//
//	node --test www/js/headgap.test.mjs
//
// r535 U3 made each section head (`.pop-head`, `.tile-dlg-head`) own the white space
// before it, and the thing in front gives up its own trailing margin. The rule that
// does it is `:has(+ .head) { margin-bottom: 0 }`, and `:has()` takes the weight of
// its argument, so the bare form weighs one class and loses to ANY later single-class
// rule that sets a margin (the gallery's `.gal-search`, 6px, left a 20px gap where the
// token gives 14). The checks read the cascade, by weight and source order, so the
// next field put in front of a head cannot quietly bring the extra gap back; the
// measured proof is `verify_consistency` section-gap, in a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..');
const css  = (f) => fs.readFileSync(path.join(WWW, 'css', f), 'utf8');

// Flat rules of a sheet, in source order. At-rule bodies are entered, their own
// preludes dropped; that is enough for the plain selectors read here.
function rules(src) {
	src = src.replace(/\/\*[\s\S]*?\*\//g, '');
	const out = [];
	const walk = (s) => {
		let i = 0;
		while (i < s.length) {
			const o = s.indexOf('{', i);
			if (o < 0) break;
			let d = 1, j = o + 1;
			while (j < s.length && d) { if (s[j] === '{') d++; else if (s[j] === '}') d--; j++; }
			const sel = s.slice(i, o).trim(), body = s.slice(o + 1, j - 1);
			if (sel.startsWith('@')) walk(body);
			else out.push({ sel, body, n: out.length });
			i = j;
		}
	};
	walk(src);
	return out;
}

// Weight of one selector as [ids, classes, types]. `:has` and `:not` and `:is` take
// their argument's weight (the heaviest argument for `:is`); `:where` takes none.
function weight(sel) {
	const w = [0, 0, 0];
	const add = (x) => { w[0] += x[0]; w[1] += x[1]; w[2] += x[2]; };
	let rest = sel;
	for (;;) {
		const m = /:(has|not|is|where)\(([^()]*)\)/.exec(rest);
		if (!m) break;
		if (m[1] !== 'where') {
			const parts = m[2].split(',').map((p) => weight(p.trim()));
			parts.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]));
			add(m[1] === 'is' || m[1] === 'not' || m[1] === 'has' ? parts[0] : [0, 0, 0]);
		}
		rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
	}
	rest = rest.replace(/\[[^\]]*\]/g, () => { w[1]++; return ' '; });
	rest = rest.replace(/::[\w-]+/g, () => { w[2]++; return ' '; });
	rest = rest.replace(/:[\w-]+/g, () => { w[1]++; return ' '; });
	rest = rest.replace(/#[\w-]+/g, () => { w[0]++; return ' '; });
	rest = rest.replace(/\.[\w-]+/g, () => { w[1]++; return ' '; });
	rest = rest.replace(/[>+~]/g, ' ');
	for (const t of rest.split(/\s+/)) if (/^[a-zA-Z][\w-]*$/.test(t)) w[2]++;
	return w;
}
const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
const heaviest = (rule) => rule.sel.split(',').map((s) => weight(s.trim())).sort((a, b) => cmp(b, a))[0];
const setsBottomMargin = (rule) => /(^|[;\s])margin(-bottom)?\s*:\s*(?!0\s*(;|$))/.test(rule.body.trim());

const gapRule = (rs, head) => rs.find((r) => r.sel.includes(':has(+ .' + head + ')') && /margin-bottom:\s*0/.test(r.body)
	&& !r.sel.includes(','));

test('the weight of a selector is read as the cascade reads it', () => {
	assert.deepEqual(weight('.gal-search'), [0, 1, 0]);
	assert.deepEqual(weight(':has(+ .pop-head)'), [0, 1, 0]);
	assert.deepEqual(weight('.pop :has(+ .pop-head)'), [0, 2, 0]);
	assert.deepEqual(weight('.pop :is(div, p):has(+ .pop-head)'), [0, 2, 1]);
	assert.deepEqual(weight(':root[data-skin="daylight"] .gal-search'), [0, 3, 0]);
	assert.deepEqual(weight(':where(.a) .b'), [0, 1, 0]);
});

test('the gallery search box cannot out-rank the head that follows it', () => {
	const rs = rules(css('workspace.css'));
	const gap = gapRule(rs, 'pop-head');
	assert.ok(gap, 'no `:has(+ .pop-head) { margin-bottom: 0 }` rule in workspace.css');
	const gw = heaviest(gap);
	// Every bare-class rule that gives its element a bottom margin must be lighter
	// than the gap rule, or come before it AND not be heavier; weight decides first.
	for (const r of rs) {
		if (r === gap || !setsBottomMargin(r)) continue;
		if (!/^\.[\w-]+$/.test(r.sel)) continue; // a lone class: the shape that beat it
		assert.ok(cmp(heaviest(r), gw) < 0 || (cmp(heaviest(r), gw) === 0 && r.n < gap.n),
			`\`${r.sel}\` (margin-bottom) out-ranks the head's gap rule \`${gap.sel}\` in workspace.css; ` +
			'the head must win over a field in front of it whatever the source order');
	}
	const gal = rs.find((r) => r.sel === '.gal-search');
	assert.ok(gal && setsBottomMargin(gal), 'the .gal-search margin moved; this guard has lost its subject');
	assert.ok(cmp(heaviest(gal), gw) < 0, '.gal-search must weigh less than the head gap rule');
});

test('the dialog head\'s gap rule is heavier than a bare class too', () => {
	const rs = rules(css('app.css'));
	const gap = gapRule(rs, 'tile-dlg-head');
	assert.ok(gap, 'no `:has(+ .tile-dlg-head) { margin-bottom: 0 }` rule in app.css');
	assert.ok(cmp(heaviest(gap), [0, 1, 0]) > 0, `\`${gap.sel}\` weighs one class; any later class rule beats it`);
});

test('the rename row leaves the dialog head to own the gap beneath it', () => {
	const rs = rules(css('app.css'));
	const row = rs.find((r) => r.sel === '.tile-dlg-name');
	assert.ok(row, 'no .tile-dlg-name rule in app.css');
	const pad = /padding:\s*([^;]+)/.exec(row.body);
	assert.ok(pad, '.tile-dlg-name has no padding');
	const v = pad[1].trim().split(/\s+/);
	// 1 value: all sides; 2: block, inline; 3: top, inline, bottom; 4: t r b l.
	const bottom = v.length === 1 ? v[0] : v.length === 2 ? v[0] : v[2];
	assert.match(bottom, /^0(px)?$/, `.tile-dlg-name pads ${bottom} below, so the Colour / Models head sits ${bottom} lower than the token`);
});

// A section head built with no words is a spacer in a head's clothes: it draws a gap the
// stylesheet did not give, and the by-role gate reads the row after it as 20px off the
// token (Lock, under "+ Add another account", once the note between them was cut).
test('no section head is built empty, anywhere in the page\'s scripts', () => {
	const bad = [];
	for (const f of fs.readdirSync(HERE).filter((n) => n.endsWith('.js'))) {
		fs.readFileSync(path.join(HERE, f), 'utf8').split('\n').forEach((l, i) => {
			if (/\bel\(\s*'div'\s*,\s*'(admin-sec|pop-head|tile-dlg-head)'\s*,\s*(''|""|)\s*\)/.test(l)) bad.push(`${f}:${i + 1}`);
		});
	}
	assert.deepEqual(bad, [], 'an empty section head used as a spacer; give the neighbour a margin, or cut it');
});
