// Verify the palettes: every one declares every token, every text rung clears
// its contrast floor on every surface it is drawn on, and the pre-paint table in
// index.html says the same thing as the registry in daimond.js.
//
// A palette is offered from a list, so nobody reads it before choosing it. That
// makes the floor a property of the LIST and not of any one palette: a picker
// with ten entries is ten chances to hand someone grey-on-grey. The ratios here
// are computed from the declared hex, by the WCAG formula, not eyeballed off a
// screenshot -- a screenshot proves one palette on one machine.
//
// The floors are the ones the first three palettes were tuned to, and the
// comments in variables.css record why the muted rung has its own: it carries
// whole explanatory paragraphs, and it was found sitting at 2.75 when nobody was
// measuring it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const out = [];
let bad = 0;
const say   = (ok, what) => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`); return ok; };
const check = (ok, what) => { if (!say(ok, what)) bad++; };

// ── The declared palettes ────────────────────────────────────────
const css = fs.readFileSync(path.join(WWW, 'css', 'variables.css'), 'utf8');

/// Every `:root[data-theme="x"] { ... }` block, plus the bare `:root` block,
/// which is the dark palette's home and the source of every default.
function blocks(src) {
	const found = {};
	const re = /:root(\[data-theme="([a-z]+)"\])?\s*\{([^}]*)\}/g;
	let m;
	while ((m = re.exec(src))) {
		const name = m[2] || (m[1] ? null : 'dark');
		if (!name) continue;
		const decls = {};
		for (const line of m[3].split(';')) {
			const d = line.match(/(--[a-z0-9-]+)\s*:\s*([^;]+)/i);
			if (d) decls[d[1]] = d[2].trim();
		}
		found[name] = Object.assign(found[name] || {}, decls);
	}
	return found;
}
const declared = blocks(css);

// A palette inherits everything it does not restate from the bare :root block.
const base = declared.dark || {};
const NAMES = ['light', 'mist', 'linen', 'lollypop', 'sage', 'dusk', 'dark', 'midnight', 'forest', 'plum'];
const palette = (n) => Object.assign({}, base, declared[n] || {});

// ── Colour ──────────────────────────────────────────────────────
function rgb(hex) {
	const h = hex.trim().replace('#', '');
	if (!/^[0-9a-f]{6}$/i.test(h)) return null;
	return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
/// Relative luminance, sRGB, exactly as WCAG defines it.
function lum(c) {
	const f = c.map(v => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	});
	return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}
function ratio(a, b) {
	const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
	return (x + 0.05) / (y + 0.05);
}

// ── Every palette declares every token ──────────────────────────
const REQUIRED = [
	'--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover',
	'--border', '--border-2',
	'--text-primary', '--text-secondary', '--text-muted',
	'--accent', '--accent-hover', '--accent-soft', '--accent-text',
	'--ok', '--ok-bg', '--warn', '--warn-bg', '--danger', '--success',
];
for (const n of NAMES) {
	const p = palette(n);
	const missing = REQUIRED.filter(k => !p[k]);
	check(missing.length === 0, `${n}: declares every token${missing.length ? ` (missing ${missing.join(', ')})` : ''}`);
	const notHex = REQUIRED.filter(k => p[k] && !rgb(p[k]));
	check(notHex.length === 0, `${n}: every token is a plain hex colour${notHex.length ? ` (bad: ${notHex.map(k => `${k}=${p[k]}`).join(', ')})` : ''}`);
}

// ── The floors ──────────────────────────────────────────────────
// The three surfaces text is READ on, and --bg-hover, which it is only passed
// over. They do not get the same floor, and the reason is not convenience: the
// three palettes that predate the picker were tuned against the stable three
// and sit at 3.75-4.02 on hover, so holding new palettes to a bar the shipped
// ones never met would be an arbitrary line, while dropping the surface
// entirely would let a palette put unreadable text under the pointer. Hover is
// checked, one rung lower.
const STABLE = ['--bg-primary', '--bg-secondary', '--bg-tertiary'];
const HOVER  = '--bg-hover';
const RUNGS = [
	['--text-primary',   4.5],
	['--text-secondary', 4.5],
	// The quiet rung, held to 4.0: it is meant to be lighter than secondary and
	// still carries prose, so it gets its own floor rather than an exemption.
	['--text-muted',     4.0],
];
/// How far a floor is relaxed on the transient surface.
const HOVER_DROP = 0.5;

for (const n of NAMES) {
	const p = palette(n);
	let worst = { r: Infinity };
	for (const [rung, floor] of RUNGS) {
		for (const surf of STABLE.concat([HOVER])) {
			const a = rgb(p[rung] || ''), b = rgb(p[surf] || '');
			if (!a || !b) continue;
			const r = ratio(a, b);
			const f = surf === HOVER ? floor - HOVER_DROP : floor;
			if (r < worst.r) worst = { r, rung, surf, floor: f };
			check(r >= f,
				`${n}: ${rung.replace('--text-', '')} on ${surf.replace('--bg-', '')} = ${r.toFixed(2)} (floor ${f})`);
		}
	}
	if (worst.r < Infinity) {
		out.push(`      ${n}: worst rung ${worst.rung.replace('--text-', '')} on ${worst.surf.replace('--bg-', '')} at ${worst.r.toFixed(2)}`);
	}
}

// The accent carries button labels in white and its own text rung on a surface.
for (const n of NAMES) {
	const p = palette(n);
	const acc = rgb(p['--accent'] || ''), white = [255, 255, 255];
	if (acc) {
		check(ratio(acc, white) >= 3.5,
			`${n}: white on the accent = ${ratio(acc, white).toFixed(2)} (floor 3.5, it carries button labels)`);
	}
	const at = rgb(p['--accent-text'] || ''), bg3 = rgb(p['--bg-tertiary'] || '');
	if (at && bg3) {
		check(ratio(at, bg3) >= 4.0,
			`${n}: accent-text on tertiary = ${ratio(at, bg3).toFixed(2)} (floor 4.0)`);
	}
}

// ── The selected-chip pair is uniform ───────────────────────────
// The whole point of the neutral chip is that it does not vary, so no palette
// may quietly restate it.
for (const n of NAMES) {
	const own = declared[n] || {};
	const restated = ['--tag-on-bg', '--tag-on-fg', '--tag-on-hover'].filter(k => own[k]);
	check(n === 'dark' || restated.length === 0,
		`${n}: does not restate the selected-chip colours${restated.length ? ` (${restated.join(', ')})` : ''}`);
}
{
	const p = palette('dark');
	const on = rgb(p['--tag-on-bg'] || ''), fg = rgb(p['--tag-on-fg'] || '');
	check(!!on && !!fg && ratio(on, fg) >= 4.5,
		`the selected chip's own lettering = ${on && fg ? ratio(on, fg).toFixed(2) : '?'} (floor 4.5)`);
}

// ── The two registries agree ────────────────────────────────────
// index.html carries a copy of the palette table so the first paint is right;
// a copy that drifts shows a returning user the wrong band for a frame, or
// leaves data-ink saying the opposite of the palette actually loaded.
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const js   = fs.readFileSync(path.join(WWW, 'js', 'daimond.js'), 'utf8');

const fromHtml = {};
{
	const tbl = html.match(/var P = \{([\s\S]*?)\};/);
	if (tbl) {
		const re = /([a-z]+)\s*:\s*\[\s*'([a-z]+)'\s*,\s*'([a-z]+)'\s*\]/g;
		let m;
		while ((m = re.exec(tbl[1]))) fromHtml[m[1]] = { tone: m[2], ink: m[3] };
	}
}
const fromJs = {};
{
	const tbl = js.match(/var THEMES = \{([\s\S]*?)\n\t\};/);
	if (tbl) {
		const re = /([a-z]+)\s*:\s*\{\s*tone:\s*'([a-z]+)'\s*,\s*ink:\s*'([a-z]+)'\s*\}/g;
		let m;
		while ((m = re.exec(tbl[1]))) fromJs[m[1]] = { tone: m[2], ink: m[3] };
	}
}
check(Object.keys(fromJs).length === NAMES.length,
	`the registry in daimond.js holds all ${NAMES.length} palettes (found ${Object.keys(fromJs).length})`);
check(Object.keys(fromHtml).length === NAMES.length,
	`the pre-paint table in index.html holds all ${NAMES.length} palettes (found ${Object.keys(fromHtml).length})`);
for (const n of NAMES) {
	const a = fromJs[n], b = fromHtml[n];
	check(!!a && !!b && a.tone === b.tone && a.ink === b.ink,
		`${n}: the two tables agree (js=${a ? a.tone + '/' + a.ink : '-'} html=${b ? b.tone + '/' + b.ink : '-'})`);
}
// Every declared palette must actually exist in the stylesheet, and vice versa.
for (const n of NAMES) check(!!declared[n], `${n}: has a palette block in variables.css`);
for (const n of Object.keys(declared)) {
	check(NAMES.includes(n), `variables.css declares no palette the picker cannot offer (${n})`);
}

// ── The ink axis is what the rules key on ───────────────────────
// A rule naming a palette is a rule that a new palette silently misses, which
// is exactly how ten palettes would ship half-styled.
for (const file of ['app.css', 'render.css', 'guide.css']) {
	const src = fs.readFileSync(path.join(WWW, 'css', file), 'utf8');
	const named = [...src.matchAll(/\[data-theme="([a-z]+)"\]/g)].map(m => m[1]);
	check(named.length === 0,
		`${file}: no rule keys on a palette NAME${named.length ? ` (${[...new Set(named)].join(', ')})` : ''}`);
}

console.log(out.join('\n'));
console.log(bad ? `\n${bad} FAILED` : `\nALL PASS (${out.filter(l => l.startsWith('PASS')).length} checks)`);
process.exit(bad ? 1 : 0);
