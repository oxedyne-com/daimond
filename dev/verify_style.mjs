// verify_style.mjs — the objective half of style coherence: the things a machine
// can judge without an eye. Run per cell (engine × device × theme) and per view.
//
//   1. The page body never scrolls horizontally (a cardinal responsive rule).
//   2. No visible element spills past the viewport's right edge.
//   3. Every visible run of text clears a contrast floor against its background —
//      which doubles as the theme-leak check: a colour hardcoded for the dark
//      theme goes near-invisible on the light one and is caught here.
//   4. On a touch device, interactive targets are not too small to hit.
//
// The subjective half — spacing rhythm, alignment, "does it read as one system" —
// is not here; that is the screenshot + vision pass (shots_matrix.mjs).
import { openCell, defaultCells, VIEWS, cellLabel, enginesAvailable, resetView } from './matrix.mjs';

const CONTRAST_HARD = 3.0;	// below this, text is effectively unreadable — a fail
const TAP_MIN       = 40;	// px; a touch target smaller than this is flagged

// The in-page audit: returns { hScroll, overflow[], contrast[], tap[] } for the
// current state. Pure DOM + getComputedStyle, so it runs on any engine. All
// thresholds arrive as arguments — this function is serialised into the page and
// cannot close over the module's constants.
const AUDIT = (opts) => {
	const tapMin = opts.tapMin, contrastHard = opts.contrastHard;
	const vw = window.innerWidth;
	const de = document.documentElement;

	// 1. Horizontal body scroll.
	const hScroll = Math.max(0, de.scrollWidth - de.clientWidth);

	const tag = (el) => {
		const id = el.id ? '#' + el.id : '';
		const cls = (typeof el.className === 'string' && el.className) ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
		return el.tagName.toLowerCase() + id + cls;
	};
	const visible = (el) => {
		const s = getComputedStyle(el);
		if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) return false;
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
	};

	// 2. Elements spilling past the right edge.
	const overflow = [];
	for (const el of document.querySelectorAll('body *')) {
		if (!visible(el)) continue;
		const r = el.getBoundingClientRect();
		if (r.right > vw + 2 && r.width <= vw + 40) {	// ignore full-bleed scroll containers
			const s = getComputedStyle(el);
			if (s.overflowX === 'auto' || s.overflowX === 'scroll') continue;	// a scroller is allowed to be wide inside
			overflow.push({ el: tag(el), right: Math.round(r.right), vw });
			if (overflow.length >= 8) break;
		}
	}

	// 3. Contrast of visible text against its effective background.
	const parse = (c) => { const m = c && c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
	const lum = (r, g, b) => { const a = [r, g, b].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2]; };
	const ratio = (fg, bg) => { const L1 = lum(fg[0], fg[1], fg[2]), L2 = lum(bg[0], bg[1], bg[2]); const hi = Math.max(L1, L2), lo = Math.min(L1, L2); return (hi + 0.05) / (lo + 0.05); };
	const effBg = (el) => { let e = el; while (e) { const p = parse(getComputedStyle(e).backgroundColor); if (p && p[3] > 0.5) return p; e = e.parentElement; } const rootLight = de.getAttribute('data-theme') !== 'dark'; return rootLight ? [255, 255, 255] : [21, 18, 15]; };
	const hasDirectText = (el) => { for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim().length > 1) return true; return false; };

	const contrast = [];
	for (const el of document.querySelectorAll('body *')) {
		if (contrast.length >= 12) break;
		if (!hasDirectText(el) || !visible(el)) continue;
		const s = getComputedStyle(el);
		const fg = parse(s.color); if (!fg || fg[3] < 0.5) continue;
		const r = ratio(fg, effBg(el));
		if (r < contrastHard) contrast.push({ el: tag(el), ratio: Math.round(r * 100) / 100, text: el.textContent.trim().slice(0, 24) });
	}

	// 4. Tap targets (touch devices only — the caller decides whether to read this).
	const tap = [];
	for (const el of document.querySelectorAll('button, a[href], input, [role="button"], select')) {
		if (!visible(el)) continue;
		const r = el.getBoundingClientRect();
		if ((r.width < tapMin || r.height < tapMin) && r.width > 0) {
			tap.push({ el: tag(el), w: Math.round(r.width), h: Math.round(r.height) });
			if (tap.length >= 10) break;
		}
	}

	// 5. A centred dialog card that does not fill its modal, because a stray flex
	//    sibling is splitting the row. This is exactly the identity-screen bug: a
	//    mis-targeted injected button became a second flex child and squeezed the
	//    card until its content clipped. A shown modal whose card is under 70% of
	//    the modal width while a sibling exists is broken.
	const squeezed = [];
	for (const modal of document.querySelectorAll('.modal, .pair-scrim')) {
		if (!visible(modal) || getComputedStyle(modal).display !== 'flex') continue;
		const card = modal.querySelector('.modal-card, .pair-box');
		if (!card || !visible(card)) continue;
		const mw = modal.clientWidth, cw = card.getBoundingClientRect().width;
		if (mw > 0 && cw > 0 && cw < mw * 0.7 && modal.children.length > 1) {
			squeezed.push({ el: tag(card), cardW: Math.round(cw), modalW: mw, siblings: modal.children.length });
		}
	}

	return { hScroll: Math.round(hScroll), overflow, contrast, tap, squeezed };
};

// Findings are deduped per cell: the persistent top bar and rail repeat in every
// view, so the same element is reported once, with the views it showed up in.
// HARD faults (body scroll, invisible text) gate the run; REVIEW items (viewport
// overflow, borderline contrast, small tap targets) are judgement calls surfaced
// for the eye, and are printed but do not fail the run unless --strict is passed.
const STRICT = process.argv.includes('--strict');
const CONTRAST_INVISIBLE = 2.0;	// below this, text is effectively unreadable

const avail = await enginesAvailable();
console.log('engines: ' + Object.entries(avail).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join('  '));

const cells = defaultCells().filter(c => avail[c.engine]);
const skipped = defaultCells().filter(c => !avail[c.engine]);
if (skipped.length) console.log('skipped (engine unavailable): ' + [...new Set(skipped.map(c => c.engine))].join(', ') + '  (install to widen coverage)');

let hardTotal = 0, reviewTotal = 0;

for (const cell of cells) {
	const label = cellLabel(cell);
	const isMobile = ['pixel', 'iphone', 'iphone-se', 'ipad'].includes(cell.device);
	const hard = new Map(), review = new Map();	// key → { msg, views:Set }
	const add = (bag, key, msg, view) => {
		if (!bag.has(key)) bag.set(key, { msg, views: new Set() });
		bag.get(key).views.add(view);
	};

	// The first screen a new user sees is the signed-OUT create-account modal,
	// which the signed-in views below never show. Audit it on its own pass — a
	// squeezed card here is a HARD fault, it is literally the first impression.
	try {
		const ls = await openCell(cell, { signIn: false, connect: false });
		try {
			const a = await ls.page.evaluate(AUDIT, { tapMin: TAP_MIN, contrastHard: CONTRAST_HARD });
			for (const q of a.squeezed) add(hard, 'sqz:' + q.el, `first screen: ${q.el} fills only ${q.cardW}/${q.modalW}px of its modal (${q.siblings} flex children — a stray sibling is splitting the row)`, 'locked-out');
			if (a.hScroll > 2) add(hard, 'hscroll-out', `first screen: body scrolls horizontally by ${a.hScroll}px`, 'locked-out');
			for (const o of a.overflow) add(review, 'ovf-out:' + o.el, `first screen: ${o.el} spills past the right edge`, 'locked-out');
		} finally { await ls.close(); }
	} catch (e) { add(hard, 'locked-open', `could not open signed-out first screen — ${e.message}`, 'locked-out'); }

	let s;
	try { s = await openCell(cell, { signIn: true, connect: true }); }
	catch (e) { console.log(`\n■ ${label}\n  HARD  could not open cell — ${e.message}`); hardTotal += hard.size; continue; }
	try {
		for (const view of VIEWS) {
			if (view.needsAuth === false && view.name !== 'locked') continue;
			await resetView(s.page);
			await view.setup(s.page).catch(() => {});
			let a;
			try { a = await s.page.evaluate(AUDIT, { tapMin: TAP_MIN, contrastHard: CONTRAST_HARD }); }
			catch (e) { add(hard, 'audit-threw:' + view.name, `audit threw in ${view.name} — ${e.message}`, view.name); continue; }

			if (a.hScroll > 2) add(hard, 'hscroll', `body scrolls horizontally by ${a.hScroll}px`, view.name);
			for (const o of a.overflow) add(review, 'ovf:' + o.el, `${o.el} spills past the right edge (right ${o.right} > vw ${o.vw})`, view.name);
			for (const c of a.contrast) {
				const bag = c.ratio < CONTRAST_INVISIBLE ? hard : review;
				add(bag, 'con:' + c.el + ':' + c.text, `${c.el} "${c.text}" at ${c.ratio}:1`, view.name);
			}
			if (isMobile) for (const t of a.tap) add(review, 'tap:' + t.el, `${t.el} is ${t.w}×${t.h}px (< ${TAP_MIN})`, view.name);
		}
	} finally { await s.close(); }

	hardTotal += hard.size; reviewTotal += review.size;
	if (!hard.size && !review.size) { console.log(`\n■ ${label}  — clean`); continue; }
	console.log(`\n■ ${label}`);
	const show = (bag, kind) => { for (const { msg, views } of bag.values()) console.log(`  ${kind}  ${msg}  [${[...views].join(',')}]`); };
	show(hard, 'HARD ');
	show(review, 'review');
}

console.log(`\n${hardTotal} hard, ${reviewTotal} review across ${cells.length} cells` + (skipped.length ? `; ${[...new Set(skipped.map(c => c.engine))].join('/')} not installed` : ''));
process.exit((hardTotal || (STRICT && reviewTotal)) ? 1 : 0);
