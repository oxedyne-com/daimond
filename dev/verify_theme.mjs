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
//
// ── Beyond the lettering ─────────────────────────────────────────────
// Text was only ever half of it. WCAG 2.2 SC 1.4.11 asks 3:1 of the parts of a
// control that are needed to IDENTIFY it -- the box round an input, the ring
// that says where the keyboard is, the fill that says a filter is on -- and SC
// 1.4.3 asks 4.5 of any state colour that is drawn as words rather than as a
// dot. None of that was measured, so the second half of this file measures it.
//
// A colour that falls short today is not failed, it is RECORDED. `KNOWN` below
// carries the ratio each shortfall stands at now; a check that is short but no
// worse than its record prints SHORT and the suite stays green, while a check
// that drops below its record, or that is short and has no record at all, is a
// hard FAIL. Palette debt can therefore be paid off but never quietly added to,
// which is the only property that matters for a picker with eleven entries.
// `node dev/verify_theme.mjs --emit-baseline` prints the table to paste back.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const out = [];
let bad = 0;
const say   = (ok, what) => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`); return ok; };
const check = (ok, what) => { if (!say(ok, what)) bad++; };

// Shortfalls that stand today, so a pre-existing debt does not fail the suite
// while still being gated against getting worse. See the header.
const shorts  = [];
const EMIT    = process.argv.includes('--emit-baseline');
/// How far a recorded shortfall may drift before it counts as a regression.
/// Big enough to absorb the last digit of a hex nudge, small enough that any
/// real darkening trips it.
const DRIFT   = 0.02;
/// A contrast check that may be short, provided it is no shorter than recorded.
///
/// `id` is the stable key into KNOWN; keep it free of measured numbers so the
/// record survives a colour being improved.
function soft(id, r, floor, what) {
	const line = `${what} = ${r.toFixed(2)} (floor ${floor})`;
	if (r >= floor) { say(true, line); return true; }
	const rec = KNOWN[id];
	if (rec === undefined) {
		check(false, `${line} -- a NEW shortfall, absent from the baseline`);
		shorts.push({ id, r, floor, what, fresh: true });
		return false;
	}
	if (r < rec - DRIFT) {
		check(false, `${line} -- WORSE than the recorded ${rec.toFixed(2)}`);
		shorts.push({ id, r, floor, what, worse: true });
		return false;
	}
	out.push(`SHORT ${line}`);
	shorts.push({ id, r, floor, what });
	return false;
}

// ── The record of what is short today ───────────────────────────
// Every entry is a real defect, written up in dev/contrast_report.md with a
// suggested colour. The number is what the ratio stands at now; `soft` above
// refuses to let it fall further, and refuses a shortfall that is not here at
// all, so the list can only be shortened.
const KNOWN = {
	'amber/accent-vs-border2': 2.99,
	'amber/border-2-vs-surface': 1.23,
	'amber/border-vs-surface': 1.04,
	'amber/border2-vs-border': 1.18,
	'amber/chip-edge': 1.82,
	'amber/chip-no-text': 4.48,
	'amber/tag-on-vs-surface': 1.70,
	'amber/white-on-accent-hover': 3.05,
	'amber/white-on-danger': 2.99,
	'amber/white-on-ok': 2.25,
	'dark/border-2-vs-surface': 1.29,
	'dark/border-vs-surface': 1.10,
	'dark/border2-vs-border': 1.17,
	'dark/chip-edge': 1.77,
	'dark/chip-no-text': 4.48,
	'dark/tag-on-vs-surface': 1.70,
	'dark/white-on-accent-hover': 2.93,
	'dark/white-on-danger': 2.93,
	'dark/white-on-ok': 2.36,
	'dusk/accent-ring-vs-surface': 1.91,
	'dusk/accent-vs-border': 1.52,
	'dusk/accent-vs-border2': 1.08,
	'dusk/bgprimary-on-accent': 2.76,
	'dusk/border-2-vs-surface': 1.76,
	'dusk/border-vs-surface': 1.25,
	'dusk/border2-vs-border': 1.40,
	'dusk/chip-edge': 1.27,
	'dusk/chip-no-text': 2.96,
	'dusk/tag-on-vs-surface': 1.13,
	'dusk/white-on-accent-hover': 3.88,
	'dusk/white-on-danger': 2.56,
	'dusk/white-on-ok': 2.15,
	'forest/accent-ring-vs-surface': 2.85,
	'forest/accent-vs-border': 2.77,
	'forest/accent-vs-border2': 2.14,
	'forest/bgprimary-on-accent': 3.84,
	'forest/border-2-vs-surface': 1.32,
	'forest/border-vs-surface': 1.03,
	'forest/border2-vs-border': 1.29,
	'forest/chip-edge': 1.71,
	'forest/chip-no-text': 4.06,
	'forest/tag-on-vs-surface': 1.54,
	'forest/white-on-accent-hover': 3.46,
	'forest/white-on-danger': 2.69,
	'forest/white-on-ok': 2.28,
	'ink-light/tag-on-vs-chip': 1.19,
	'light/border-2-vs-surface': 1.28,
	'light/border-vs-surface': 1.07,
	'light/border2-vs-border': 1.20,
	'light/chip-edge': 1.19,
	'light/chip-no-text': 3.14,
	'light/chip-text-hover': 4.47,
	'light/ok-on-ok-bg': 4.47,
	'light/warn-on-warn-bg': 4.26,
	'linen/border-2-vs-surface': 1.35,
	'linen/border-vs-surface': 1.04,
	'linen/border2-vs-border': 1.29,
	'linen/chip-edge': 1.14,
	'linen/chip-no-text': 2.88,
	'linen/chip-text-hover': 4.47,
	'linen/white-on-accent-hover': 4.48,
	'lollypop/accent-ring-vs-surface': 2.99,
	'lollypop/accent-vs-border': 2.85,
	'lollypop/accent-vs-border2': 2.22,
	'lollypop/bgprimary-on-accent': 3.53,
	'lollypop/border-2-vs-surface': 1.34,
	'lollypop/border-vs-surface': 1.04,
	'lollypop/border2-vs-border': 1.28,
	'lollypop/chip-edge': 1.13,
	'lollypop/chip-no-text': 2.90,
	'lollypop/chip-text-hover': 4.47,
	'lollypop/danger-on-warn-bg': 3.15,
	'lollypop/danger-vs-surface': 2.77,
	'lollypop/success-vs-surface': 2.09,
	'lollypop/warn-on-warn-bg': 2.21,
	'lollypop/warn-vs-surface': 1.95,
	'lollypop/white-on-accent-hover': 2.96,
	'lollypop/white-on-danger': 3.64,
	'midnight/accent-vs-border2': 2.42,
	'midnight/bgprimary-on-accent': 4.19,
	'midnight/border-2-vs-surface': 1.29,
	'midnight/border-vs-surface': 1.04,
	'midnight/border2-vs-border': 1.24,
	'midnight/chip-edge': 1.74,
	'midnight/chip-no-text': 4.17,
	'midnight/tag-on-vs-surface': 1.59,
	'midnight/white-on-accent-hover': 3.33,
	'midnight/white-on-danger': 2.88,
	'midnight/white-on-ok': 2.29,
	'mist/border-2-vs-surface': 1.30,
	'mist/border-vs-surface': 1.04,
	'mist/border2-vs-border': 1.24,
	'mist/chip-edge': 1.19,
	'mist/chip-no-text': 3.08,
	'mist/chip-text-hover': 4.47,
	'mist/ok-on-ok-bg': 4.44,
	'mist/white-on-accent-hover': 3.92,
	'motion/infinite-uncovered': 8.00,
	'plum/border-2-vs-surface': 1.26,
	'plum/border-vs-surface': 1.03,
	'plum/border2-vs-border': 1.22,
	'plum/chip-edge': 1.77,
	'plum/chip-no-text': 4.27,
	'plum/tag-on-vs-surface': 1.63,
	'plum/white-on-accent-hover': 2.64,
	'plum/white-on-danger': 2.65,
	'plum/white-on-ok': 2.25,
	'sage/border-2-vs-surface': 1.32,
	'sage/border-vs-surface': 1.02,
	'sage/border2-vs-border': 1.29,
	'sage/chip-edge': 1.05,
	'sage/chip-no-text': 2.65,
	'sage/chip-text-hover': 4.47,
	'sage/white-on-accent-hover': 4.09,
};

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
const NAMES = ['light', 'mist', 'linen', 'lollypop', 'sage', 'dusk', 'dark', 'amber', 'midnight', 'forest', 'plum'];
const palette = (n) => Object.assign({}, base, declared[n] || {});

/// Each palette's band and ink, read from the registry in daimond.js. Needed
/// before the contrast checks, because whether a filled button letters in white
/// or in the palette's own dark surface depends on the ink.
const THEME_SPEC = {};
{
	const js0 = fs.readFileSync(path.join(WWW, 'js', 'daimond.js'), 'utf8');
	const tbl = js0.match(/var THEMES = \{([\s\S]*?)\n\t\};/);
	if (tbl) {
		const re = /([a-z]+)\s*:\s*\{\s*tone:\s*'([a-z]+)'\s*,\s*ink:\s*'([a-z]+)'\s*\}/g;
		let m;
		while ((m = re.exec(tbl[1]))) THEME_SPEC[m[1]] = { tone: m[2], ink: m[3] };
	}
}

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

/// What a filled control letters in, on this palette.
///
/// Not always white. A filled button on a light palette is a deep accent and
/// takes white; on a dark palette it is a light mint or salmon and takes the
/// palette's own darkest surface, which is what `--on-fill` resolves to there.
/// Measuring white everywhere would measure a colour the app does not paint.
const onFill = (n) => {
	const p = palette(n);
	const spec = THEME_SPEC[n];
	return (spec && spec.ink === 'light') ? rgb(p['--bg-primary'] || '') : [255, 255, 255];
};

// The accent carries button labels, and its own text rung on a surface.
for (const n of NAMES) {
	const p = palette(n);
	const acc = rgb(p['--accent'] || ''), lettering = onFill(n);
	if (acc && lettering) {
		// 4.5, not 3.5: .tile-start is 12px and .admin-cta is 13px, so these are
		// ordinary words and not large text.
		check(ratio(acc, lettering) >= 4.5,
			`${n}: the label on a filled accent button = ${ratio(acc, lettering).toFixed(2)} (floor 4.5)`);
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
// Amber exists to keep short-wavelength light down, so that is a property and
// not a matter of taste: every colour it paints must be blue-poor, or a later
// edit "brightening it up" would quietly undo the only reason it is offered.
{
	const p = palette('amber');
	const loud = [];
	for (const k of REQUIRED) {
		const c = rgb(p[k] || '');
		if (!c) continue;
		// Blue may not lead. Allowing it to equal the smaller of red and green
		// keeps neutral greys legal and rules out anything that reads as cool.
		if (c[2] > Math.min(c[0], c[1])) loud.push(`${k}=${p[k]} (b=${c[2]} > min(r,g)=${Math.min(c[0], c[1])})`);
	}
	check(loud.length === 0, `amber: no colour lets blue lead${loud.length ? `: ${loud.join(', ')}` : ''}`);
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

// ════════════════════════════════════════════════════════════════
// Everything that is not lettering
// ════════════════════════════════════════════════════════════════
// Two floors, and which one applies is a question about what the colour is
// DOING, not about what kind of token it is:
//
//   CTRL 3.0  WCAG 2.2 SC 1.4.11, Non-text Contrast. The parts of a control
//             needed to identify it or its state -- the box round an input, the
//             ring that says where the keyboard is, the fill that says a filter
//             is on -- and any graphical object that carries meaning, such as a
//             status dot. Measured against the surface ADJACENT to it, which for
//             a border is the panel on one side and the control's own fill on
//             the other, so the worst of the surfaces is the one that counts.
//
//   WORD 4.5  SC 1.4.3, Contrast (Minimum). A state colour stops being a dot
//             and becomes text the moment a rule says `color:`. --warn is words
//             in .spend-governor.amber and .ti-label; --ok is words in .pill.ok;
//             #fff is words on every filled button. Those are text, and text
//             does not get the non-text floor.
//
// Nothing here relaxes on --bg-hover the way the text rungs do. A text rung is
// only PASSED OVER on hover; a chip, a border and a focus ring all sit on the
// hovered surface for as long as the pointer does, and a control that vanishes
// under the pointer is worse than one that never showed.
const SURF = ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-hover'];
const CTRL = 3.0;
const WORD = 4.5;
const WHITE = [255, 255, 255];
const nm = (s) => s.replace('--bg-', '').replace(/^--/, '');

/// The worst ratio a colour reaches against any of the given surfaces.
function worstOn(col, p, surfaces = SURF) {
	let w = { r: Infinity, surf: null };
	if (!col) return w;
	for (const s of surfaces) {
		const b = rgb(p[s] || '');
		if (!b) continue;
		const r = ratio(col, b);
		if (r < w.r) w = { r, surf: s };
	}
	return w;
}

// ── Borders ─────────────────────────────────────────────────────
// There are two border tokens doing two different jobs, and only one of them is
// a control's boundary.
//
// --border-strong IS the boundary. Every text field, select and outlined button
// in the app now reads `border: 1px solid var(--border-strong)`, and the fill
// inside a field is within 1.2:1 of the panel outside it on every palette, so
// that line is the only thing saying the control is there. Squarely SC 1.4.11,
// and therefore a HARD check: it may not be short on any palette, on any
// surface, ever. There is no baseline entry to fall back on and there must
// never be one -- the whole token exists because the debt was allowed to sit.
//
// --border and --border-2 are dividers: they separate two things that are both
// visible without them, and they are drawn quietly on purpose. They stay
// recorded rather than failed. --border-2 is still checked against --border
// because where it survives as a hover promotion, a hover that changes a
// boundary by less than 3:1 has not shown a state change.
for (const n of NAMES) {
	const p = palette(n);
	const strong = rgb(p['--border-strong'] || '');
	check(!!strong, `${n}: declares --border-strong`);
	if (strong) {
		const w = worstOn(strong, p);
		check(w.r >= CTRL,
			`${n}: --border-strong against its worst surface (${nm(w.surf)}) = ${w.r.toFixed(2)} (floor ${CTRL})`);
	}
	for (const tok of ['--border', '--border-2']) {
		const w = worstOn(rgb(p[tok] || ''), p);
		if (w.surf) soft(`${n}/${nm(tok)}-vs-surface`, w.r, CTRL,
			`${n}: ${nm(tok)} against its worst surface (${nm(w.surf)})`);
	}
	const b1 = rgb(p['--border'] || ''), b2 = rgb(p['--border-2'] || '');
	if (b1 && b2) soft(`${n}/border2-vs-border`, ratio(b1, b2), CTRL,
		`${n}: border-2 against border (the hover promotion of a boundary)`);
	// The field's own fill against the panel it is let into. Not a floor of its
	// own -- the border is allowed to be the boundary -- but recorded, because a
	// fill that is invisible is why the boundary has to carry the whole job.
	const t = rgb(p['--bg-tertiary'] || ''), s = rgb(p['--bg-secondary'] || '');
	if (t && s) out.push(`      ${n}: an input's fill against its panel = ${ratio(t, s).toFixed(2)} (no floor; it is why --border-strong matters)`);
}

// No control may quietly go back to a divider for its boundary. The tokens are
// only as good as the rules that use them, and the failure this catches is a new
// input written by copying an old one.
{
	// Comments are stripped FIRST. Without that, the prose above a rule is part of
	// what the selector pattern sees, and a paragraph explaining why an input sits
	// where it does named a box that is not a control at all.
	const css = ['app.css', 'files.css', 'mail.css', 'models.css', 'workspace.css',
		'autoreload.css', 'mobile.css', 'render.css', 'spend.css']
		.map((f) => fs.readFileSync(path.join(WWW, 'css', f), 'utf8'))
		.join('\n').replace(/\/\*[\s\S]*?\*\//g, ' ');
	const CONTROL = /\b(input|select|textarea)\b|(btn|button)\b/i;
	const stragglers = [];
	for (const m of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
		if (!/border:\s*1px (solid|dashed) var\(--border(-2)?\)/.test(m[2])) continue;
		const sel = m[1].trim().split('\n').pop().trim().replace(/\s+/g, ' ');
		if (CONTROL.test(sel)) stragglers.push(sel);
	}
	check(stragglers.length === 0,
		`no control takes a divider for its boundary${stragglers.length ? ' -- ' + JSON.stringify(stragglers) : ''}`);
}

// ── The accent, as the focus indicator ──────────────────────────
// Two shapes, both of them the accent. `outline: 2px solid var(--accent)` draws
// a ring on whatever surface the control sits on (app.css:258, workspace.css:166
// and :218, files.css:39, models.css:134), so the ring is measured against the
// surfaces. Every text field instead does `outline: none; border-color:
// var(--accent)` -- the focus indicator is the SAME PIXELS as the resting
// border, recoloured -- so what has to clear 3:1 there is accent against
// --border, which is WCAG 2.2 SC 2.4.11 Focus Appearance: the indicator has to
// contrast with the unfocused state of the pixels it replaces. A palette can
// pass one of these and fail the other, so both are checked.
for (const n of NAMES) {
	const p = palette(n);
	const acc = rgb(p['--accent'] || '');
	if (!acc) continue;
	const w = worstOn(acc, p);
	soft(`${n}/accent-ring-vs-surface`, w.r, CTRL,
		`${n}: the focus ring on its worst surface (${nm(w.surf)})`);
	const b1 = rgb(p['--border'] || '');
	if (b1) soft(`${n}/accent-vs-border`, ratio(acc, b1), CTRL,
		`${n}: a focused field's border against its resting border`);
	const b2 = rgb(p['--border-2'] || '');
	if (b2) soft(`${n}/accent-vs-border2`, ratio(acc, b2), CTRL,
		`${n}: a focused button's border against its resting border-2`);
}

// ── The selected chip, on every palette ─────────────────────────
// One neutral pair shared by all eleven, which is the point of it -- so it has
// to be checked ELEVEN times, once per palette, and the two questions are
// different. Against the surface: the chip is a filled control, SC 1.4.11.
// Against the chip it replaces: this is the state that says a filter is on, and
// a state nobody can see is not a state. The unselected fill is generated per
// hue, so the second question is asked at every hue the app can hash to.
{
	const p = palette('dark');
	const on = rgb(p['--tag-on-bg'] || '');
	if (on) for (const n of NAMES) {
		const w = worstOn(on, palette(n));
		soft(`${n}/tag-on-vs-surface`, w.r, CTRL,
			`${n}: the selected chip against its worst surface (${nm(w.surf)})`);
	}
}

// ── The state colours ───────────────────────────────────────────
// Their paired *-bg first, because that pairing is only ever used one way: the
// colour is the LETTERING and the -bg is the pill behind it (.pill.ok,
// .spend-governor.amber, .ti-label over .turn-interrupted's --warn-bg). 4.5.
// --danger over --warn-bg is the tripped governor, same rule.
for (const n of NAMES) {
	const p = palette(n);
	const pairs = [
		['--ok',     '--ok-bg',   'ok on its pill (.pill.ok)'],
		['--warn',   '--warn-bg', 'warn on its pill (.spend-governor.amber)'],
		['--danger', '--warn-bg', 'danger on the warn pill (.spend-governor.tripped)'],
	];
	for (const [fg, bg, what] of pairs) {
		const a = rgb(p[fg] || ''), b = rgb(p[bg] || '');
		if (a && b) soft(`${n}/${nm(fg)}-on-${nm(bg)}`, ratio(a, b), WORD, `${n}: ${what}`);
	}
	// The same colours as dots and rules on the main surfaces -- .astat-dot.ok,
	// .astat-dot.warn, .ctx-fill.high, .turn-interrupted's dashed edge. Graphical
	// objects that carry the whole meaning, so 3:1.
	for (const tok of ['--ok', '--warn', '--danger', '--success']) {
		const w = worstOn(rgb(p[tok] || ''), p);
		if (w.surf) soft(`${n}/${nm(tok)}-vs-surface`, w.r, CTRL,
			`${n}: ${nm(tok)} as a dot on its worst surface (${nm(w.surf)})`);
	}
	// White lettering on a filled state button. .diff-accept fills with --ok,
	// .dlg-ok.danger and .admin-item.danger:hover and .abtn.stop:hover fill with
	// --danger, and every primary button's HOVER fills with --accent-hover while
	// keeping the same white label. All words, all 4.5.
	const fills = [
		['--ok',           'the label on the Accept button (.diff-accept)'],
		['--danger',       'the label on a filled danger button (.dlg-ok.danger)'],
		['--accent-hover', 'the label on a primary button, hovered (.admin-cta:hover)'],
	];
	const lettering = onFill(n);
	for (const [tok, what] of fills) {
		const c = rgb(p[tok] || '');
		if (c && lettering) soft(`${n}/white-on-${nm(tok)}`, ratio(c, lettering), WORD, `${n}: ${what}`);
	}
	// The one filled control that letters in the surface colour rather than white.
	const acc = rgb(p['--accent'] || ''), bg1 = rgb(p['--bg-primary'] || '');
	if (acc && bg1) soft(`${n}/bgprimary-on-accent`, ratio(acc, bg1), WORD,
		`${n}: the lit All/Any label (.tag-mode-btn.on)`);
}

// ── The generated tag chips ─────────────────────────────────────
// These colours are in no palette. A tag's hue is hashed from its name in
// daimond.js and handed to app.css as --tag-h; saturation and lightness come
// from the ink axis. So the chip is a colour NOBODY DECLARED, and it is text on
// a fill, which is 4.5 -- and it varies with the hue, because HSL lightness is
// not luminance: at 94% lightness a yellow is far brighter than a blue.
//
// The hues and the formulas are read out of the source rather than restated, so
// that adding a hue to TAG_HUES or retuning a chip is measured on the next run
// instead of drifting away from a copy kept here.
const appCss = fs.readFileSync(path.join(WWW, 'css', 'app.css'), 'utf8');
const TAG_HUES = (() => {
	const m = js.match(/var TAG_HUES\s*=\s*\[([^\]]*)\]/);
	return m ? m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(v => !Number.isNaN(v)) : [];
})();
check(TAG_HUES.length > 0, `the tag hues are readable from daimond.js (found ${TAG_HUES.length})`);

/// sRGB for an `hsl(h s% l%)`, the way a browser resolves it.
function hsl(h, s, l) {
	h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs((h / 60) % 2 - 1));
	const m = l - c / 2;
	let v;
	if (h <  60) v = [c, x, 0]; else if (h < 120) v = [x, c, 0];
	else if (h < 180) v = [0, c, x]; else if (h < 240) v = [0, x, c];
	else if (h < 300) v = [x, 0, c]; else v = [c, 0, x];
	return v.map(q => Math.round((q + m) * 255));
}
/// The `hsl(var(--tag-h, 0) S% L%)` triples declared by one rule in app.css.
///
/// THE SELECTOR MUST START ITS OWN LINE, and that is the whole of this comment.
/// This was a bare `indexOf(selector + ' {')` until 2026-08-21, so ANY more
/// specific rule written earlier in the file shadowed it: `.session-box-tags
/// .tag-chip { flex: none; }` arrived at line 700 and the search stopped there,
/// on a rule with no colour in it at all. Every formula then read null and the
/// whole tag-chip section of this file went dark -- reported as "the formulas are
/// not readable", which sounds like a stylesheet fault and was a parser fault.
/// Anchoring to a line start makes a shadowing rule impossible rather than
/// unlikely: a nested selector cannot begin a line with the bare one.
function chipRule(selector) {
	const at = appCss.indexOf('\n' + selector + ' {');
	const i = at < 0 ? -1 : at + 1;
	if (i < 0) return null;
	const body = appCss.slice(i, appCss.indexOf('}', i));
	const grab = (prop) => {
		const m = body.match(new RegExp(prop + ':[^;]*?hsl\\(var\\(--tag-h[^)]*\\)\\s*(\\d+)%\\s*(\\d+)%'));
		return m ? [Number(m[1]), Number(m[2])] : null;
	};
	return { bg: grab('background'), fg: grab('color'), bd: grab('border(?:-color)?') };
}
const CHIP = {
	light: { rest: chipRule('.tag-chip'),                        hover: chipRule('button.tag-chip:hover'),                        no: chipRule('.tag-no') },
	dark:  { rest: chipRule(':root[data-ink="dark"] .tag-chip'), hover: chipRule(':root[data-ink="dark"] button.tag-chip:hover'), no: chipRule(':root[data-ink="dark"] .tag-no') },
};
check(!!(CHIP.light.rest && CHIP.light.rest.bg && CHIP.light.rest.fg && CHIP.dark.rest && CHIP.dark.rest.bg && CHIP.dark.rest.fg),
	'the tag chip formulas are readable from app.css');

// The ink each palette takes, from the registry already parsed above -- not a
// second copy of the table, which is the thing this file exists to prevent.
const inkOf = (n) => (fromJs[n] || {}).ink;
for (const n of NAMES) {
	const p = palette(n), ink = inkOf(n), c = CHIP[ink];
	if (!c || !c.rest || !c.rest.bg || !c.rest.fg) continue;
	// The chip's own lettering, at every hue. 4.5: it is the tag's name.
	let wt = { r: Infinity }, wh = { r: Infinity }, wb = { r: Infinity }, wn = { r: Infinity };
	for (const h of TAG_HUES) {
		const bg = hsl(h, ...c.rest.bg), fg = hsl(h, ...c.rest.fg);
		const r = ratio(fg, bg);
		if (r < wt.r) wt = { r, h };
		if (c.hover && c.hover.bg) {
			const rh = ratio(fg, hsl(h, ...c.hover.bg));
			if (rh < wh.r) wh = { r: rh, h };
		}
		// The chip against the panel. A chip is identifiable if EITHER its fill or
		// its edge is far enough from the surface -- it does not need both -- so
		// the better of the two is what has to clear 3:1, and a chip that clears
		// it on neither is a control nobody can see the extent of.
		{
			const surfs = ['--bg-secondary', '--bg-tertiary'];
			const fw = worstOn(bg, p, surfs);
			const bw = c.rest.bd ? worstOn(hsl(h, ...c.rest.bd), p, surfs) : { r: 0, surf: fw.surf };
			const best = fw.r >= bw.r ? fw : bw;
			if (best.r < wb.r) wb = { r: best.r, h, surf: best.surf };
		}
		// The REFUSED chip has no fill at all -- `background: transparent` -- so
		// its label is drawn straight onto the surface. Text, 4.5.
		if (c.no && c.no.fg) {
			const w = worstOn(hsl(h, ...c.no.fg), p);
			if (w.r < wn.r) wn = { r: w.r, h, surf: w.surf };
		}
	}
	if (wt.r < Infinity) soft(`${n}/chip-text`,       wt.r, WORD, `${n}: a tag chip's name, worst hue (${wt.h})`);
	if (wh.r < Infinity) soft(`${n}/chip-text-hover`, wh.r, WORD, `${n}: a tag chip's name while hovered, worst hue (${wh.h})`);
	if (wb.r < Infinity) soft(`${n}/chip-edge`,       wb.r, CTRL, `${n}: a tag chip's extent against the panel, worst hue (${wb.h})`);
	if (wn.r < Infinity) soft(`${n}/chip-no-text`,    wn.r, WORD, `${n}: a REFUSED tag's name on ${nm(wn.surf)}, worst hue (${wn.h})`);
}
// The selected chip against the chip it replaces. The fill is the only thing
// that changes, so this ratio IS the state change, and it is asked per hue and
// per ink because the fill it replaces is generated.
{
	const on = rgb(palette('dark')['--tag-on-bg'] || '');
	for (const ink of ['light', 'dark']) {
		const c = CHIP[ink];
		if (!on || !c || !c.rest || !c.rest.bg) continue;
		let w = { r: Infinity };
		for (const h of TAG_HUES) {
			const r = ratio(on, hsl(h, ...c.rest.bg));
			if (r < w.r) w = { r, h };
		}
		soft(`ink-${ink}/tag-on-vs-chip`, w.r, CTRL,
			`ink=${ink}: a selected chip against the unselected one, worst hue (${w.h})`);
	}
}

// ── Reduced motion ──────────────────────────────────────────────
// Not a contrast question, but the same kind of question: something the
// stylesheets do that nobody was checking. Every rule that moves has to have a
// `@media (prefers-reduced-motion: reduce)` answer somewhere in the same file,
// and an INFINITE animation is the one that cannot be argued away -- a 0.15s
// transition ends, a `2.2s infinite` pulse never does, and SC 2.2.2 asks that
// anything moving for more than five seconds can be stopped.
{
	const MOTION = fs.readdirSync(path.join(WWW, 'css')).filter(f => f.endsWith('.css'));
	const infinite = [];
	for (const f of MOTION) {
		const src = fs.readFileSync(path.join(WWW, 'css', f), 'utf8');
		const rm  = src.includes('prefers-reduced-motion');
		// Which animations does that file's reduce block actually turn off?
		const stopped = new Set();
		for (const m of src.matchAll(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\t*\}/g)) {
			for (const s of m[1].matchAll(/([^{}]+)\{[^{}]*(?:animation|transition)\s*:\s*none/g)) {
				for (const sel of s[1].split(',')) stopped.add(sel.trim());
			}
		}
		const lines = src.split('\n');
		lines.forEach((line, i) => {
			if (!/animation[^:]*:\s*[^;]*infinite/.test(line)) return;
			// The selector is what is left of the brace on the same line for a
			// one-line rule, and otherwise the nearest line above that opens a
			// block -- stopping at the previous rule's close, so a declaration
			// buried in a multi-line rule still finds its own selector.
			let sel = '';
			if (line.includes('{')) sel = line.split('{')[0].trim();
			else for (let k = i - 1; k >= 0; k--) {
				if (lines[k].includes('}')) break;
				if (lines[k].includes('{')) { sel = lines[k].split('{')[0].trim(); break; }
			}
			const covered = [...stopped].some(s => s === sel || sel.startsWith(s) || s.startsWith(sel));
			if (!covered) infinite.push(`${f}:${i + 1} ${sel || '(?)'}`);
		});
		if (!rm) {
			const moves = (src.match(/transition\s*:/g) || []).length + (src.match(/animation\s*:/g) || []).length;
			if (moves) out.push(`      ${f}: ${moves} moving rule(s), no prefers-reduced-motion block`);
		}
	}
	// Scored as a countdown from ten rather than a ratio, so the same gate does
	// the same job: covering one more animation raises the score and covering
	// them all clears the floor, while ADDING an uncovered one drops below the
	// record and fails outright.
	soft('motion/infinite-uncovered', 10 - infinite.length, 10,
		`every infinite animation has a prefers-reduced-motion answer${infinite.length ? ` (uncovered: ${infinite.join('; ')})` : ''}`);
}


console.log(out.join('\n'));
if (shorts.length) {
	console.log(`\n── short of the floor, and recorded (${shorts.length}) ──`);
	for (const s of shorts) console.log(`  ${s.what} = ${s.r.toFixed(2)} < ${s.floor}${s.fresh ? '  [NEW]' : ''}${s.worse ? '  [WORSE]' : ''}`);
	console.log('  See dev/contrast_report.md for the suggested colours.');
}
if (EMIT) {
	console.log('\n── baseline to paste into KNOWN ──');
	for (const s of shorts.slice().sort((a, b) => a.id.localeCompare(b.id))) {
		console.log(`\t'${s.id}': ${(Math.floor(s.r * 100) / 100).toFixed(2)},`);
	}
}
console.log(bad ? `\n${bad} FAILED` : `\nALL PASS (${out.filter(l => l.startsWith('PASS')).length} checks, ${shorts.length} short and recorded)`);
process.exit(bad ? 1 : 0);
