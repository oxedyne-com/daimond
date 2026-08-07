// shot_permchip.mjs — the ink-level check the permission chip's CSS asks for.
//
// The dot's nudge carries this comment in www/css/app.css:
//
//     /* CHECK THIS AT 8x before shipping — it is a nudge, not a measurement. */
//
// House rule (`feedback_ink_level_visual_qc`): centre the INK, not the box. A 6px
// dot beside 11px text sits visibly high if it is centred on the line box, because
// the line box carries the descender space and the word "Guarded" has no descender
// in it. So this measures where the ink actually is — from the font's own metrics,
// via TextMetrics — and says what the nudge should be, rather than eyeballing it.
//
// It also takes the 8x crop, faithfully: the element is screenshotted at the size
// it really rendered, then blown up nearest-neighbour, so what is magnified is the
// pixels the browser produced and not a re-layout at another zoom.
//
// And it checks the two contrast floors on a light and a dark palette: 4.5:1 for
// the word (it is text) and 3:1 for the dot (it is a non-text indicator).
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'permchip' });
const p = s.page;
await chat(s, '@text hello');           // the chat header is only drawn with a chat open

const visible = await p.evaluate(() => {
	const c = document.getElementById('hand-mode-chip');
	if (!c) return null;
	const r = c.getBoundingClientRect();
	return { w: r.width, h: r.height, text: c.innerText.trim(), aria: c.getAttribute('aria-label') };
});
check('the chip is on screen, in the chat header', !!(visible && visible.w > 0), visible ? JSON.stringify(visible) : 'absent');
check('the WORD carries the state, so nothing rests on the colour',
	!!(visible && /guarded/i.test(visible.text)), visible ? visible.text : '');
check('and the accessible name contains the visible word (WCAG 2.5.3)',
	!!(visible && visible.aria && visible.aria.includes(visible.text.replace(/\s+/g, ' '))),
	visible ? visible.aria : '');

// ── Where the ink actually is ──────────────────────────────────────────────

const ink = await p.evaluate(() => {
	const chip = document.getElementById('hand-mode-chip');
	const txt  = document.getElementById('hand-mode-chip-txt');
	const dot  = chip.querySelector('.mode-chip-dot');
	const cs   = getComputedStyle(txt);
	const cv   = document.createElement('canvas').getContext('2d');
	cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
	const m = cv.measureText(txt.textContent);
	const tr = txt.getBoundingClientRect();
	const dr = dot.getBoundingClientRect();
	// The inline box centres the font's content area (ascent+descent) inside the
	// line box, so the baseline is that offset plus the ascent.
	const fA = m.fontBoundingBoxAscent, fD = m.fontBoundingBoxDescent;
	const baseline = tr.top + (tr.height - (fA + fD)) / 2 + fA;
	const inkTop    = baseline - m.actualBoundingBoxAscent;
	const inkBottom = baseline + m.actualBoundingBoxDescent;
	const inkMid    = (inkTop + inkBottom) / 2;
	const dotMid    = dr.top + dr.height / 2;
	const applied   = getComputedStyle(dot).transform;   // the nudge, as matrix(…)
	return {
		font: cv.font,
		lineBox: { top: tr.top, height: tr.height },
		fontMetrics: { ascent: fA, descent: fD },
		inkAscent: m.actualBoundingBoxAscent, inkDescent: m.actualBoundingBoxDescent,
		inkTop, inkBottom, inkMid,
		dot: { top: dr.top, height: dr.height, mid: dotMid },
		delta: dotMid - inkMid,       // + means the dot sits BELOW the ink centre
		applied,
	};
});

console.log('\n  measured:');
console.log('    font                 ' + ink.font);
console.log('    line box             top ' + ink.lineBox.top.toFixed(2) + ', height ' + ink.lineBox.height.toFixed(2));
console.log('    font ascent/descent  ' + ink.fontMetrics.ascent.toFixed(2) + ' / ' + ink.fontMetrics.descent.toFixed(2));
console.log('    ink ascent/descent   ' + ink.inkAscent.toFixed(2) + ' / ' + ink.inkDescent.toFixed(2));
console.log('    ink top..bottom      ' + ink.inkTop.toFixed(2) + ' .. ' + ink.inkBottom.toFixed(2)
	+ '  (centre ' + ink.inkMid.toFixed(2) + ')');
console.log('    dot top..bottom      ' + ink.dot.top.toFixed(2) + ' .. ' + (ink.dot.top + ink.dot.height).toFixed(2)
	+ '  (centre ' + ink.dot.mid.toFixed(2) + ')');
console.log('    applied nudge        ' + ink.applied);
console.log('    dot centre − ink centre = ' + ink.delta.toFixed(2) + 'px'
	+ (ink.delta > 0 ? '  (dot sits low)' : ink.delta < 0 ? '  (dot sits high)' : ''));
const appliedY = parseFloat((/matrix\([^)]*,\s*([-\d.]+)\)/.exec(ink.applied) || [0, '0'])[1]) || 0;
// The nudge that WOULD centre it: what is applied now, less however far off it is.
console.log('    nudge applied ' + appliedY.toFixed(2) + 'px; nudge that centres it: translateY('
	+ (appliedY - ink.delta).toFixed(2) + 'px)');


// ── The other two labels ───────────────────────────────────────────────────
//
// One nudge serves three words, and they do not have the same ink. "Guarded" has
// an ascender and no descender; "Bypass" has both. A nudge measured against one
// word only is a nudge that is wrong for the other two, which is exactly the kind
// of measurement this check exists to stop being taken.
const perLabel = await p.evaluate(() => {
	const txt = document.getElementById('hand-mode-chip-txt');
	const cs  = getComputedStyle(txt);
	const cv  = document.createElement('canvas').getContext('2d');
	cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
	const out = {};
	for (const w of (window.DaimondHandMode ? DaimondHandMode.list().map(m => m.label) : ['Guarded'])) {
		const m = cv.measureText(w);
		// Relative to the baseline: negative is above it.
		out[w] = {
			asc:  m.actualBoundingBoxAscent,
			desc: m.actualBoundingBoxDescent,
			mid:  -(m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
		};
	}
	const x = cv.measureText('x');
	out.__xheight = { asc: x.actualBoundingBoxAscent, desc: x.actualBoundingBoxDescent,
		mid: -(x.actualBoundingBoxAscent - x.actualBoundingBoxDescent) / 2 };
	return out;
});
console.log('\n  the ink of each label, relative to the baseline:');
const mids = [];
for (const [w, m] of Object.entries(perLabel)) {
	console.log(`    ${w.padEnd(16)} ascent ${m.asc.toFixed(2)}, descent ${m.desc.toFixed(2)}, ink centre ${m.mid.toFixed(2)}`);
	if (w !== '__xheight') mids.push(m.mid);
}
const spread = Math.max(...mids) - Math.min(...mids);
console.log(`    spread across the three labels: ${spread.toFixed(2)}px`);
// Reported, not asserted: that the three are 2px apart is a fact about the words,
// not a defect. It is WHY the target below is a band rather than a word.
console.log(`    (no single offset can centre the dot on all three — hence the band)`);

// The target is the MIDPOINT of the labels' ink centres, not any one label's.
//
// Measuring against one word is how a nudge goes wrong, and the numbers above are
// why: the three ink centres are 2px apart, so an offset dead-on for "Guarded" is
// 2px out on "Bypass". The midpoint of the extremes is the offset whose worst case
// is smallest — 1px out on either, never 2px on one. The 8x crops in
// dev/shot_permchip_ladder.mjs are what confirmed it reads level on all three; the
// arithmetic alone cannot say that.
//
// Half a pixel is the smallest move a screen at DPR 1 can show, so that is the
// tolerance: inside it, nothing is gained by moving.
const baseline = ink.inkBottom;                       // no descender in "Guarded"
const target   = baseline + (Math.max(...mids) + Math.min(...mids)) / 2;
const offBand  = ink.dot.mid - target;
console.log('\n    midpoint of the labels  ' + target.toFixed(2)
	+ '   dot centre ' + ink.dot.mid.toFixed(2)
	+ '   off by ' + offBand.toFixed(2) + 'px');
console.log('    residual per label:     ' + Object.keys(perLabel).filter(k => k !== '__xheight')
	.map((w, i) => `${w} ${(target - (baseline + mids[i])).toFixed(2)}`).join(', '));
check('the dot sits at the midpoint of the three labels, so its worst case is smallest',
	Math.abs(offBand) <= 0.5,
	`${offBand.toFixed(2)}px off; nudge that lands it: translateY(${(appliedY - offBand).toFixed(2)}px)`);

// ── The 8x crop, faithful to what was rendered ─────────────────────────────

const chipPng = await p.locator('#hand-mode-chip').screenshot();
const crop8 = await p.evaluate(async (b64) => {
	const img = new Image();
	await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
	const c = document.createElement('canvas');
	c.width = img.width * 8; c.height = img.height * 8;
	c.id = '__crop8';
	const g = c.getContext('2d');
	g.imageSmoothingEnabled = false;              // nearest neighbour: no invented pixels
	g.drawImage(img, 0, 0, c.width, c.height);
	c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#808080';
	document.body.appendChild(c);
	return { w: c.width, h: c.height };
}, chipPng.toString('base64'));
await p.locator('#__crop8').screenshot({ path: path.join(SHOTS, 'permchip-8x.png') });
await p.evaluate(() => { const c = document.getElementById('__crop8'); if (c) c.remove(); });
console.log(`\n  8x crop written to dev/shots/permchip-8x.png (${crop8.w}×${crop8.h})`);

// ── Contrast, on a light palette and a dark one ────────────────────────────

const ratios = await p.evaluate(async () => {
	const lum = (c) => {
		const [r, g, b] = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const parse = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
	// The background actually behind the chip, walking up past anything transparent.
	const behind = (el) => {
		for (let n = el; n; n = n.parentElement) {
			const bg = getComputedStyle(n).backgroundColor;
			const a = (bg.match(/[\d.]+/g) || [])[3];
			if (bg && bg !== 'transparent' && a !== '0') return parse(bg);
		}
		return [0, 0, 0];
	};
	const ratio = (a, b) => { const [l, d] = [lum(a), lum(b)].sort((x, y) => y - x); return (l + 0.05) / (d + 0.05); };
	const out = {};
	for (const theme of ['light', 'dark']) {
		window.DaimondTheme.set(theme);
		await new Promise(r => setTimeout(r, 250));
		const chip = document.getElementById('hand-mode-chip');
		const txt  = document.getElementById('hand-mode-chip-txt');
		const dot  = chip.querySelector('.mode-chip-dot');
		const bg   = behind(chip);
		out[theme] = {
			word: ratio(parse(getComputedStyle(txt).color), bg),
			dot:  ratio(parse(getComputedStyle(dot).backgroundColor), bg),
		};
	}
	window.DaimondTheme.set('dark');
	return out;
});
for (const theme of ['light', 'dark']) {
	check(`the word clears the text floor on the ${theme} palette`, ratios[theme].word >= 4.5,
		`${ratios[theme].word.toFixed(2)}:1 (4.5 needed)`);
	check(`the dot clears the non-text floor on the ${theme} palette`, ratios[theme].dot >= 3,
		`${ratios[theme].dot.toFixed(2)}:1 (3.0 needed)`);
}

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
