// verify_sweep_desktop.mjs — every palette against every spacing, on the desktop
// shell, checked MECHANICALLY rather than by eye.
//
// Eleven palettes times two spacings is twenty-two looks, and a defect that
// only shows in one of them ships. Twice this week the same class reached the
// user: ink drawn OUTSIDE an element's border box (a non-inset `box-shadow`
// ring) and then sliced off by a scroll container's `overflow: hidden`. Once on
// the selected tag chip, once on the selected chat tile under Breathe. Neither
// is visible to a test that reads the DOM; both are obvious to one that reads
// the GEOMETRY.
//
// What is checked, per combination, over every scene:
//
//   1. CLIPPED INK   every non-inset box-shadow, against every ancestor that is
//                    entitled to clip it. Hard ink (spread and offset) is a
//                    defect; blur alone is a note. An axis that really scrolls
//                    is a note; an axis that is `hidden`, or `auto` on a box
//                    with nothing to scroll, is a defect.
//   2. OVERFLOW      scrollWidth > clientWidth while overflow-x cannot show it
//                    and no ellipsis admits to the cut.
//   3. INVISIBLE     text whose colour is within a whisker of the background
//                    actually painted behind it (composited up the ancestors).
//   4. OVERLAP       in-flow sibling controls whose boxes intersect.
//   5. OFF-SCREEN    ink painted past the right edge of the viewport that no
//                    clipper and no scroller accounts for.
//
// The clipped-ink check is proved against the two known cases with their fixes
// mentally reverted -- an outer ring injected onto `.session-box.active` and
// onto `.tag-chip.tag-inc` -- before the sweep runs. A check never seen red is
// not evidence.
//
//   node dev/verify_sweep_desktop.mjs            # the whole sweep
//   node dev/verify_sweep_desktop.mjs --quick    # dark + light only, for edits
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, errors } from './harness.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots', 'sweep');
fs.mkdirSync(SHOTS, { recursive: true });

const QUICK   = process.argv.includes('--quick');
const PALETTES = QUICK
	? ['dark', 'light']
	: ['light', 'mist', 'linen', 'lollypop', 'sage', 'dusk', 'dark', 'amber', 'midnight', 'forest', 'plum'];
const SPACINGS = ['sharp', 'warm'];		// shown as Compact and Breathe
const SPACE_WORD = { sharp: 'Compact', warm: 'Breathe' };

// ── The audit, as it runs in the page ────────────────────────────────────
//
// One function, stringified into the page. Everything it reports is measured:
// no rule is read from a stylesheet, so a defect introduced by a cascade nobody
// expected is caught the same as one written down.
const AUDIT = function () {
	const W = window.innerWidth;
	const out = [];
	const samples = [];		// every low-contrast text, for the cross-palette pass
	const add = (o) => out.push(o);

	/// A short, readable path to an element: enough to find it in the CSS.
	const sel = (el) => {
		const bit = (e) => {
			let s = e.tagName.toLowerCase();
			if (e.id) return s + '#' + e.id;
			const cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
			return s + cls.map((c) => '.' + c).join('');
		};
		const parts = [];
		for (let e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i++) {
			parts.unshift(bit(e));
			if (e.id) break;
		}
		return parts.join(' > ');
	};

	const cs = (e) => getComputedStyle(e);
	const num = (v) => parseFloat(v) || 0;

	/// Drawn at all: has a box, is not hidden, is not transparent.
	const drawn = (el) => {
		const r = el.getBoundingClientRect();
		if (r.width <= 0 || r.height <= 0) return null;
		const c = cs(el);
		if (c.visibility === 'hidden' || c.display === 'none') return null;
		let op = 1;
		for (let e = el; e && e.nodeType === 1; e = e.parentElement) op *= num(cs(e).opacity || '1');
		if (op < 0.06) return null;
		return r;
	};

	// ── box-shadow, parsed ────────────────────────────────────────────
	/// Split a computed shadow list on its top-level commas -- the colours have
	/// commas of their own, so a bare split() gets this wrong.
	const layers = (str) => {
		const parts = []; let depth = 0, cur = '';
		for (const ch of str) {
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
			if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
			cur += ch;
		}
		if (cur.trim()) parts.push(cur);
		return parts.map((p) => p.trim()).filter(Boolean);
	};
	/// One layer as numbers, or null when it paints nothing.
	const shadow = (part) => {
		const inset = /\binset\b/.test(part);
		// The colour comes off first: it is the only thing here with digits in
		// brackets, and its alpha decides whether the layer paints at all.
		let alpha = 1;
		const rgba = part.match(/rgba?\(([^)]*)\)/);
		if (rgba) {
			const bits = rgba[1].split(/[,/\s]+/).filter(Boolean);
			if (bits.length > 3) alpha = parseFloat(bits[3]);
		}
		const rest = part.replace(/rgba?\([^)]*\)/g, ' ').replace(/color\([^)]*\)/g, ' ')
			.replace(/\binset\b/g, ' ');
		const n = (rest.match(/-?\d*\.?\d+px/g) || []).map(parseFloat);
		if (!n.length) return null;
		const [ox = 0, oy = 0, blur = 0, spread = 0] = n;
		return { inset, alpha, ox, oy, blur, spread };
	};

	// ── Who is entitled to clip me ────────────────────────────────────
	/// Every ancestor that really clips `el`, nearest first, with the box it
	/// clips to. Absolutely and fixed positioned elements escape any ancestor
	/// that is not a containing block for them, which is what keeps menus and
	/// dialogs out of this report.
	const clippers = (el) => {
		const res = [];
		let pos = cs(el).position;
		for (let a = el.parentElement; a && a.nodeType === 1; a = a.parentElement) {
			const c = cs(a);
			const cb = c.position !== 'static' || c.transform !== 'none' || c.filter !== 'none'
				|| c.perspective !== 'none' || /transform|filter/.test(c.willChange || '')
				|| /paint|strict|content/.test(c.contain || '');
			const escapes = (pos === 'fixed' && !cb) || (pos === 'absolute' && !cb);
			if (!escapes && (c.overflowX !== 'visible' || c.overflowY !== 'visible')) {
				const r = a.getBoundingClientRect();
				res.push({
					el: a,
					ox: c.overflowX, oy: c.overflowY,
					// The clip is the PADDING box, so the borders come off.
					l: r.left + num(c.borderLeftWidth),
					r: r.right - num(c.borderRightWidth),
					t: r.top + num(c.borderTopWidth),
					b: r.bottom - num(c.borderBottomWidth),
					scrollX: a.scrollWidth > a.clientWidth + 1,
					scrollY: a.scrollHeight > a.clientHeight + 1,
				});
			}
			if (cb) pos = c.position;
			if (a === document.documentElement) break;
		}
		return res;
	};

	// ── colours ───────────────────────────────────────────────────────
	const parseCol = (v) => {
		const m = String(v).match(/rgba?\(([^)]*)\)/);
		if (!m) return null;
		const b = m[1].split(/[,/\s]+/).filter(Boolean).map(parseFloat);
		return { r: b[0], g: b[1], b: b[2], a: b.length > 3 ? b[3] : 1 };
	};
	const over = (fg, bg) => ({	// fg composited onto bg
		r: fg.r * fg.a + bg.r * (1 - fg.a),
		g: fg.g * fg.a + bg.g * (1 - fg.a),
		b: fg.b * fg.a + bg.b * (1 - fg.a),
		a: 1,
	});
	const lum = (c) => {
		const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
		return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
	};
	const ratio = (a, b) => {
		const la = lum(a), lb = lum(b);
		return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
	};
	/// The background actually painted behind an element, or null when
	/// something unreadable (an image, a gradient) is in the stack.
	const painted = (el) => {
		let acc = null;
		for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
			const c = cs(e);
			if (c.backgroundImage && c.backgroundImage !== 'none') return null;
			const col = parseCol(c.backgroundColor);
			if (!col || col.a === 0) continue;
			acc = acc ? over(acc, col) : col;
			if (acc.a >= 0.999) return acc;
		}
		// Nothing opaque all the way up: the canvas is whatever the root paints.
		const root = parseCol(cs(document.documentElement).backgroundColor);
		const base = root && root.a > 0 ? root : { r: 255, g: 255, b: 255, a: 1 };
		return acc ? over(acc, base) : base;
	};

	const all = [...document.querySelectorAll('*')];

	// ── 1. Ink drawn outside the box, and then cut off ────────────────
	/// Every side of `el`'s outer shadow that an ancestor cuts off. Used for the
	/// resting page and again for whatever has focus, because a focus ring is
	/// exactly this shape of ink and lives exactly where lists clip.
	const inkCut = (el, tagAs) => {
		const r = drawn(el);
		if (!r) return;
		const c = cs(el);
		const parsed = (c.boxShadow && c.boxShadow !== 'none')
			? layers(c.boxShadow).map(shadow).filter((s) => s && !s.inset && s.alpha > 0.02)
			: [];
		// An OUTLINE is the same fault in a different property: it is painted
		// outside the border box, takes no layout space, and an ancestor's
		// overflow cuts it exactly as it cuts a ring drawn with box-shadow. Most
		// of this app's focus rings are outlines, so leaving them out would have
		// meant checking the rarer half of the class.
		if (c.outlineStyle && c.outlineStyle !== 'none' && c.outlineStyle !== 'hidden') {
			const w = num(c.outlineWidth), off = num(c.outlineOffset);
			if (w > 0 && w + off > 0) {
				parsed.push({ inset: false, alpha: 1, ox: 0, oy: 0, blur: 0, spread: w + Math.max(off, 0),
					what: `outline ${c.outline} at offset ${c.outlineOffset}` });
			}
		}
		if (!parsed.length) return;
		const clips = clippers(el);
		if (!clips.length) return;
		// A clipper that has already thrown the element away WHOLLY takes its ring
		// with it: ink nobody can see is not a defect. Without this the walk skips
		// only that clipper's side (`room < -1` below) and carries on to a farther
		// ancestor, so `body { overflow: hidden }` gets blamed for shaving ink off
		// a control the scroller above it discarded 180px ago. That is how
		// `select#cfg-crystal-cap` was reported as a clipped focus ring: the Admin
		// drawer's foot is always at least 200px above the viewport's, so whenever
		// `body` CAN clip a ring on a drawer descendant, that descendant is off
		// screen by construction.
		for (const k of clips) {
			const outY = k.oy !== 'visible' && (r.bottom <= k.t + 1 || r.top >= k.b - 1);
			const outX = k.ox !== 'visible' && (r.right <= k.l + 1 || r.left >= k.r - 1);
			if (outX || outY) return;
		}
		for (const s of parsed) {
			// Hard ink is spread and offset: a ring, an outline, a lift with a
			// crisp edge. Blur alone fades, so a cut in it is a note.
			const hard = { l: s.spread - s.ox, r: s.spread + s.ox, t: s.spread - s.oy, b: s.spread + s.oy };
			const soft = { l: hard.l + s.blur, r: hard.r + s.blur, t: hard.t + s.blur, b: hard.b + s.blur };
			for (const k of clips) {
				const sides = [
					['left',   'l', k.ox, k.scrollX, r.left - k.l],
					['right',  'r', k.ox, k.scrollX, k.r - r.right],
					['top',    't', k.oy, k.scrollY, r.top - k.t],
					['bottom', 'b', k.oy, k.scrollY, k.b - r.bottom],
				];
				for (const [name, key, ovf, scrolls, room] of sides) {
					if (ovf === 'visible') continue;
					if (room < -1) continue;			// the element itself is out of view here
					const cutHard = hard[key] - Math.max(room, 0);
					const cutSoft = soft[key] - Math.max(room, 0);
					if (cutSoft <= 0.5) continue;
					// An axis that really scrolls cuts its content on purpose;
					// an axis that is `hidden`, or `auto` with nothing to
					// scroll, cuts it forever.
					const permanent = ovf === 'hidden' || ovf === 'clip' || !scrolls;
					const kind = cutHard > 0.5 ? 'hard' : 'soft';
					if (kind === 'soft' && !permanent) continue;
					// Under 2px of hard ink is a rounded corner or the browser's
					// own hairline ring shaved: real, but not what a reader sees.
					// At 2px and up a ring is missing a whole side.
					add({
						check: tagAs || 'clipped-ink',
						severity: kind === 'hard' && permanent && cutHard >= 2 ? 'defect' : 'note',
						sel: sel(el),
						by: sel(k.el),
						// The side is kept apart from the rest so one ring cut on
						// four sides reports as one fault, not four.
						side: name,
						ink: `${kind} ink, ${s.what || 'shadow ' + c.boxShadow}`,
						detail: `cut ${(kind === 'hard' ? cutHard : cutSoft).toFixed(1)}px`
							+ ` (room ${room.toFixed(1)}px; clipper overflow-${key === 'l' || key === 'r' ? 'x' : 'y'}:`
							+ ` ${ovf}${scrolls ? ', scrolls' : ', nothing to scroll'})`,
					});
				}
			}
		}
	};
	// Whatever happens to hold focus is the focus pass's business, not the
	// resting page's: counting it here would report the same ring twice and
	// make the resting figures depend on where a Tab happened to land.
	for (const el of all) if (el !== document.activeElement) inkCut(el, null);

	// ── 2. Text cut off with nothing to say it was ────────────────────
	for (const el of all) {
		const r = drawn(el);
		if (!r) continue;
		const c = cs(el);
		if (c.overflowX !== 'hidden' && c.overflowX !== 'clip') continue;
		if (el.clientWidth <= 0) continue;
		// Text meant for a screen reader and for nothing else. The visually-hidden
		// idiom is a 1x1 box with the paint clipped away, so its content ALWAYS
		// overflows -- that is how it works, not a defect. Matched on the shape of
		// the idiom (a 1x1 box whose paint is clipped to nothing) rather than on a
		// class name, so a rule cannot silence this check by borrowing a name.
		if (el.clientWidth <= 1 && el.clientHeight <= 1
			&& (c.clipPath === 'inset(50%)' || c.clip === 'rect(0px, 0px, 0px, 0px)')) continue;
		const over = el.scrollWidth - el.clientWidth;
		if (over <= 1) continue;
		if (c.textOverflow === 'ellipsis') continue;		// an admitted cut
		// Only where there is text of its own to lose; a container overflowing
		// because of a positioned child is a different complaint.
		const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
		if (!own) continue;
		add({
			check: 'overflow',
			severity: over > 4 ? 'defect' : 'note',
			sel: sel(el),
			by: '',
			detail: `${over.toFixed(0)}px of text cut with no ellipsis `
				+ `(scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}): `
				+ JSON.stringify((el.textContent || '').trim().slice(0, 40)),
		});
	}

	// ── 3. Text the same colour as what is behind it ──────────────────
	for (const el of all) {
		const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
		if (!own) continue;
		const r = drawn(el);
		if (!r) continue;
		const c = cs(el);
		if (num(c.fontSize) < 4) continue;
		if (c.webkitTextFillColor && c.webkitTextFillColor !== c.color) continue;	// gradient ink
		if (/text/.test(c.webkitBackgroundClip || '') || /text/.test(c.backgroundClip || '')) continue;
		const fgRaw = parseCol(c.color);
		const bg = painted(el);
		if (!fgRaw || !bg) continue;
		const fg = over(fgRaw, bg);
		const cr = ratio(fg, bg);
		// EVERY reading is kept, comfortable or not: one palette washing a label
		// out that the other ten read fine is a defect no absolute threshold can
		// see, and the oracle for it is the median of the others. Sampling only
		// the low readings would take the healthy palettes out of that median
		// and quietly compare the bad cases with each other.
		samples.push({ sel: sel(el), cr: +cr.toFixed(2) });
		if (cr >= 1.6) continue;
		add({
			check: 'invisible-text',
			severity: cr < 1.25 ? 'defect' : 'note',
			sel: sel(el),
			by: '',
			detail: `contrast ${cr.toFixed(2)}:1 — ${c.color} on rgb(${bg.r.toFixed(0)}, ${bg.g.toFixed(0)}, ${bg.b.toFixed(0)}): `
				+ JSON.stringify((el.textContent || '').trim().slice(0, 40)),
		});
	}

	// ── 4. Controls sitting on top of one another ─────────────────────
	const CTRL = 'button, a[href], input, select, textarea, [role="button"], .tag-chip, .chip-btn';
	const seenPair = new Set();
	for (const parent of all) {
		const kids = [...parent.children].filter((k) => k.matches(CTRL));
		if (kids.length < 2) continue;
		const boxes = kids.map((k) => {
			const c = cs(k);
			if (c.position !== 'static' && c.position !== 'relative') return null;
			return { k, r: drawn(k) };
		}).filter((x) => x && x.r);
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i].r, b = boxes[j].r;
				const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
				const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
				if (ox <= 2 || oy <= 2) continue;
				const key = sel(boxes[i].k) + '|' + sel(boxes[j].k);
				if (seenPair.has(key)) continue;
				seenPair.add(key);
				add({
					check: 'overlap',
					severity: ox > 4 && oy > 4 ? 'defect' : 'note',
					sel: sel(boxes[i].k),
					by: sel(boxes[j].k),
					detail: `two in-flow controls overlap by ${ox.toFixed(1)}x${oy.toFixed(1)}px`,
				});
			}
		}
	}

	// ── 5. Ink past the right edge of the window ──────────────────────
	for (const el of all) {
		const r = drawn(el);
		if (!r) continue;
		if (r.right <= W + 1) continue;
		if (r.width > W) continue;					// a full-bleed container is not the complaint
		// Anything a clipper already cuts inside the window is not on screen at
		// all, and anything inside a horizontal scroller is reachable.
		let accounted = false;
		for (const k of clippers(el)) {
			if (k.r <= W + 1) { accounted = true; break; }
			if ((k.ox === 'auto' || k.ox === 'scroll') && k.scrollX) { accounted = true; break; }
		}
		if (accounted) continue;
		// The nearest offender only: a row that is off the edge takes its
		// children with it, and one line is the report.
		if (el.parentElement) {
			const pr = el.parentElement.getBoundingClientRect();
			if (pr.right > W + 1 && pr.width <= W) continue;
		}
		add({
			check: 'offscreen',
			severity: r.right - W > 4 ? 'defect' : 'note',
			sel: sel(el),
			by: '',
			detail: `right edge ${r.right.toFixed(0)}px, ${(r.right - W).toFixed(0)}px past the ${W}px viewport`,
		});
	}

	// ── 6. The same question again, of whatever has focus ─────────────
	//
	// A focus ring is ink outside the border box by construction -- an outline
	// here, a box-shadow there -- and the places a keyboard walks (a form inside
	// a scrolling drawer, a search box at the top of a clipped list) are exactly
	// the places entitled to cut it. Nothing in the resting page shows this, so
	// each focusable is focused in turn and asked.
	//
	// The caller presses Tab once before this runs. That matters: Chromium only
	// treats a scripted focus() as `:focus-visible` when the last interaction
	// was a keypress, so without it every ring measured here reads `none` and
	// the whole pass quietly checks nothing. Scroll positions are put back
	// afterwards, because focusing moves them.
	{
		const was = document.activeElement;
		const scrollers = all.filter((e) => e.scrollTop || e.scrollLeft)
			.map((e) => [e, e.scrollTop, e.scrollLeft]);
		const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
		const list = [...document.querySelectorAll(FOCUSABLE)].filter((e) => drawn(e) && !e.disabled);
		for (const el of list.slice(0, 120)) {
			try { el.focus({ preventScroll: true }); } catch (e) { continue; }
			if (document.activeElement !== el) continue;
			inkCut(el, 'clipped-focus-ring');
		}
		try { if (was && was.focus) was.focus({ preventScroll: true }); else document.activeElement.blur(); } catch (e) {}
		for (const [e, t, l] of scrollers) { e.scrollTop = t; e.scrollLeft = l; }
	}

	return { out, samples };
};

// ── Driving the app ──────────────────────────────────────────────────────

const s = await open({ name: 'sweep' });
const { page } = s;
const log = (...a) => console.log(...a);

/// Anything modal, put away, so a scene starts from the same place.
async function calm() {
	await page.evaluate(() => {
		document.querySelectorAll('.dlg-cancel, .modal-close').forEach((b) => {
			if (b.offsetParent) b.click();
		});
		const m = document.getElementById('settings-menu');
		if (m && !m.hidden) m.hidden = true;
		const g = document.getElementById('panel-gallery');
		if (g && !g.hidden) g.hidden = true;
		const x = document.getElementById('admin-close');
		if (x && x.offsetParent) x.click();
	});
	await page.waitForTimeout(250);
}

// ── Build a workspace worth looking at ───────────────────────────────────
log('building the workspace…');
await calm();

async function newDiamond(name) {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(600);
}
const NAMES = ['Ship a CSV parser', 'Mum birthday plan', 'Rust compiler notes'];
const have = await page.$$eval('.diamond-box .session-box-name', (e) => e.map((x) => x.textContent));
for (const n of NAMES) if (!have.includes(n)) await newDiamond(n);

/// Tag a Diamond through the editor the user uses.
async function tag(name, tags) {
	const idx = await page.$$eval('.diamond-box .session-box-name',
		(els, n) => els.map((e) => e.textContent).indexOf(n), name);
	if (idx < 0) return;
	await page.$$eval('.diamond-box', (els, i) => els[i].click(), idx);
	await page.waitForTimeout(450);
	for (const b of await page.$$('.crystal-act')) {
		if (((await b.textContent()) || '').includes('Tags')) { await b.click({ force: true }); break; }
	}
	await page.waitForSelector('.tag-editor', { timeout: 5000 }).catch(() => {});
	for (const t of tags) {
		await page.fill('.tag-input', t);
		await page.keyboard.press('Enter');
		await page.waitForTimeout(350);
	}
	await page.click('.crystal-act', { force: true });		// ← back to the crystal
	await page.waitForTimeout(350);
}
const tagged = await page.$$eval('.session-box-tags .tag-chip', (e) => e.length);
if (!tagged) {
	await tag('Ship a CSV parser', ['rust', 'parser']);
	await tag('Mum birthday plan', ['person', 'family', 'gifts', 'urgent']);
}

// Two chats, each with a real turn through the mock.
const chats = await page.$$eval('.session-box:not(.diamond-box)', (e) => e.length).catch(() => 0);
if (chats < 2) {
	await chat(s, 'Write one short sentence about diamonds.');
	await page.click('#new-session-btn', { force: true });
	await page.waitForTimeout(400);
	const start = page.locator('.tile-start').first();
	if (await start.count()) await start.click({ force: true });
	await page.waitForTimeout(400);
	await chat(s, 'And one about rust.');
}

// The tag pool open, with a filter on it, and two panels in the dock.
await page.evaluate(() => {
	const tog = document.querySelector('#diamond-filter .tagf-toggle');
	if (tog && tog.getAttribute('aria-expanded') !== 'true') tog.click();
});
await page.waitForTimeout(350);
await page.evaluate(() => {
	const chip = [...document.querySelectorAll('#diamond-filter .tagf-pool .tag-chip')][0];
	if (chip) chip.click();
});
await page.waitForTimeout(350);
await page.evaluate(() => {
	try { DaimondPanels.show('work'); DaimondPanels.show('spend'); } catch (e) {}
});
await page.waitForTimeout(500);
log('workspace ready.');

// ── Scenes ───────────────────────────────────────────────────────────────
//
// Each is a state a user is really in, reached the way they reach it, and left
// the way it was found so the next one starts clean.
const SCENES = {
	/// The rail with a live tag filter, a Diamond open on its crystal, the dock
	/// with two panels. This is where both shipped defects lived.
	work: async () => {
		await calm();
		await page.evaluate(() => {
			// The stage scenes of the combination before this one left a guest
			// panel open; every combination starts from the same stage, or the
			// screenshots are not comparable across palettes.
			try {
				['tools', 'graph', 'web'].forEach((p) => DaimondPanels.hide(p));
			} catch (e) {}
			const d = document.querySelector('.diamond-box');
			if (d) d.click();
		});
		await page.waitForTimeout(500);
	},
	/// A chat selected, with real turns in it: the thread, the composer, the
	/// fold controls -- none of which the crystal view puts on screen.
	chat: async () => {
		await calm();
		await page.evaluate(() => {
			const c = document.querySelector('#session-list .session-box');
			if (c) c.click();
		});
		await page.waitForTimeout(500);
	},
	/// The Admin drawer over the rail.
	drawer: async () => {
		await calm();
		await page.click('#user-row', { force: true }).catch(() => {});
		await page.waitForTimeout(450);
	},
	/// The settings form inside the drawer: selects, text fields, the provider
	/// list. The one place in the app whose focus ring is a box-shadow rather
	/// than an outline, and it lives inside a scroller.
	models: async () => {
		await calm();
		// `#astat-model` -- the "Models · N" row -- not `#settings-btn`, which
		// opens the Admin home and leaves the form unbuilt.
		await page.click('#astat-model', { force: true }).catch(() => {});
		await page.waitForTimeout(700);
		await page.evaluate(() => {
			const add = document.getElementById('models-add');
			if (add && add.offsetParent) add.click();		// raise the form itself
		});
		await page.waitForTimeout(500);
	},
	/// The appearance menu: spacing, palette, text size.
	menu: async () => {
		await calm();
		await page.click('#settings-menu-btn', { force: true }).catch(() => {});
		await page.waitForTimeout(400);
	},
	/// A dialog over everything.
	dialog: async () => {
		await calm();
		await page.click('#new-diamond-btn', { force: true }).catch(() => {});
		await page.waitForSelector('.dlg-input', { timeout: 5000 }).catch(() => {});
		await page.fill('.dlg-input', 'A name long enough to test the field').catch(() => {});
		await page.waitForTimeout(250);
	},
	/// The Tools panel: a long list of rows in a scroller.
	tools: async () => {
		await calm();
		await page.evaluate(() => { try { DaimondPanels.show('tools'); } catch (e) {} });
		await page.waitForTimeout(700);
	},
	/// The Graph panel: cards, edges, the stats line.
	graph: async () => {
		await calm();
		await page.evaluate(() => { try { DaimondPanels.show('graph'); } catch (e) {} });
		await page.waitForTimeout(800);
	},
	/// The guide in the Web panel: the app's only long prose, and the surface
	/// where a palette's body text has to hold up paragraph after paragraph.
	guide: async () => {
		await calm();
		await page.click('#guide-btn', { force: true }).catch(() => {});
		await page.waitForTimeout(1200);
	},
};

async function setLook(pal, sp) {
	await page.evaluate(({ pal, sp }) => {
		window.DaimondTheme.set(pal);
		window.DaimondSkin.set(sp);
	}, { pal, sp });
	await page.waitForTimeout(450);		// the warm typeface and the transitions
}

// ── The check, proved red first ──────────────────────────────────────────
//
// Both fixes are mentally reverted -- an OUTER ring put back on the selected
// chat tile and on the selected tag chip -- and the clipped-ink check is asked
// whether it minds. If it does not, nothing below it means anything.
log('\nproving the clipped-ink check against the two known cases…');
await SCENES.work();
await setLook('dark', 'warm');
await page.evaluate(() => {
	const tile = document.querySelector('.session-box');
	if (tile) tile.click();
});
await page.waitForTimeout(400);
const beforeSelf = (await page.evaluate(AUDIT)).out.filter((f) => f.check === 'clipped-ink');
await page.evaluate(() => {
	const st = document.createElement('style');
	st.id = 'sweep-revert';
	// Exactly the two rules the fixes replaced: outer rings, no layout space.
	st.textContent = `
		:root[data-skin="warm"] .session-box.active { box-shadow: 0 0 0 2px red !important; }
		:root[data-ink] .tag-chip.tag-inc { box-shadow: 0 0 0 2px red !important; }
		:root[data-skin="warm"] .session-list, :root[data-skin="warm"] .diamond-list {
			padding-left: 0 !important; padding-right: 0 !important; }`;
	document.head.appendChild(st);
});
await page.waitForTimeout(350);
const afterSelf = (await page.evaluate(AUDIT)).out.filter((f) => f.check === 'clipped-ink');
const caught = (frag) => afterSelf.some((f) => f.sel.includes(frag) && f.severity === 'defect')
	&& !beforeSelf.some((f) => f.sel.includes(frag) && f.severity === 'defect');
const selfTile = caught('session-box');
const selfChip = caught('tag-chip');
for (const f of afterSelf.filter((x) => /session-box|tag-chip/.test(x.sel) && x.severity === 'defect')) {
	log(`   red: ${f.severity}  ${f.sel}  ${f.detail}`);
}
log(`   selected chat tile ring: ${selfTile ? 'FLAGGED' : 'MISSED'}`);
log(`   selected tag chip ring:  ${selfChip ? 'FLAGGED' : 'MISSED'}`);
await page.evaluate(() => { const st = document.getElementById('sweep-revert'); if (st) st.remove(); });
await page.waitForTimeout(300);

// The other four checks, each shown a fault built for it. A synthetic probe
// rather than a real regression -- there is no known one to revert -- but the
// same code path, on real elements in the real page, and every one of them is
// silent before the probe is planted.
log('proving the other four checks against a planted fault…');
const plant = async () => page.evaluate(() => {
	const box = document.createElement('div');
	box.id = 'sweep-probe';
	box.style.cssText = 'position:fixed; left:40px; top:40px; z-index:99999; background:#123456;';
	box.innerHTML = `
		<div id="probe-clip" style="width:60px; overflow-x:hidden; white-space:nowrap; text-overflow:clip;">
			a line far longer than sixty pixels of room</div>
		<div id="probe-ink" style="color:#123458; background:#123456;">invisible</div>
		<div id="probe-lap"><button style="position:relative">one</button><button
			style="position:relative; margin-left:-30px">two</button></div>`;
	document.body.appendChild(box);
	const off = document.createElement('button');
	off.id = 'probe-off';
	off.textContent = 'past the edge';
	off.style.cssText = `position:fixed; top:200px; left:${window.innerWidth - 20}px; width:120px; z-index:99999;`;
	document.body.appendChild(off);
	// A focusable planted INSIDE the chats list, wearing the kind of ring the
	// app's own controls wear. The list clips sideways and has no room to
	// spare, so a ring drawn outside the border box has to be caught.
	const st = document.createElement('style');
	st.id = 'probe-style';
	st.textContent = '#probe-focus:focus-visible { outline: 3px solid red; outline-offset: 3px; }';
	document.head.appendChild(st);
	const fb = document.createElement('button');
	fb.id = 'probe-focus';
	fb.textContent = 'ring';
	// FIRST child, not last. Appended to a `#session-list` that the sweep's own
	// workspace has already filled, the probe lands below the scrollport and is
	// measured at `visible: 0` -- so the one check that proves this audit can see
	// a clipped ring was itself only ever proved red against ink off screen. The
	// guard above then correctly discards it, and the self-test says so.
	const host = document.getElementById('session-list') || document.body;
	host.insertBefore(fb, host.firstChild);
});
const clear = async () => page.evaluate(() => {
	['sweep-probe', 'probe-off', 'probe-style', 'probe-focus'].forEach((id) => {
		const e = document.getElementById(id); if (e) e.remove();
	});
});
await page.keyboard.press('Tab');
const before4 = (await page.evaluate(AUDIT)).out;
await plant();
await page.waitForTimeout(200);
await page.keyboard.press('Tab');
const after4 = (await page.evaluate(AUDIT)).out;
await clear();
const went = (check, frag) => after4.some((f) => f.check === check && f.sel.includes(frag))
	&& !before4.some((f) => f.check === check && f.sel.includes(frag));
const selfOverflow = went('overflow', 'probe-clip');
const selfInk      = went('invisible-text', 'probe-ink');
const selfLap      = went('overlap', 'probe-lap');
const selfOff      = went('offscreen', 'probe-off');
const selfRing     = went('clipped-focus-ring', 'probe-focus');
log(`   overflow ${selfOverflow ? 'red' : 'MISSED'}, invisible-text ${selfInk ? 'red' : 'MISSED'},`
	+ ` overlap ${selfLap ? 'red' : 'MISSED'}, offscreen ${selfOff ? 'red' : 'MISSED'},`
	+ ` focus ring ${selfRing ? 'red' : 'MISSED'}`);
const proved = selfTile && selfChip && selfOverflow && selfInk && selfLap && selfOff && selfRing;
if (!proved) log('\nA CHECK NEVER SEEN RED IS NOT EVIDENCE — the sweep below is worth less than it looks.');

// ── The sweep ────────────────────────────────────────────────────────────
const found = new Map();		// key -> { ...finding, where: Set }
const record = (pal, sp, scene, f) => {
	// The colours come out of the key: one ring cut in eleven palettes is one
	// fault, and eleven rows saying so would bury the rest of the report. So do
	// the leaf's state classes -- `.ptag.ptag-dock.on` and `.ptag.ptag-stage`
	// are one stylesheet rule meeting one clipper, not six defects.
	// An id names one element and is never merged; only a class list is
	// shortened, and only to its first class.
	const tail = f.sel.split(' > ').pop();
	const leaf = tail.includes('#') ? tail : tail.replace(/^([a-z]+)(\.[\w-]+)?.*$/, '$1$2');
	const key = [f.check, leaf, f.by, (f.ink || '').replace(/rgba?\([^)]*\)/g, '·'),
		f.detail.replace(/[\d.]+/g, '#')].join('§');
	let e = found.get(key);
	if (!e) { e = { ...f, sides: new Set(), where: [], shots: new Set() }; found.set(key, e); }
	if (f.side) e.sides.add(f.side);
	if (f.severity === 'defect') e.severity = 'defect';
	e.where.push(`${pal}/${SPACE_WORD[sp]}/${scene}`);
	e.shots.add(`dev/shots/sweep/${pal}-${sp}-${scene}.png`);
	// Keep the worst numbers seen, so the report quotes the bad case.
	if (f.detail.length > e.detail.length) e.detail = f.detail;
};

/// sel -> palette/spacing -> the worst contrast that text was seen at.
const contrast = new Map();

log('\nsweeping…');
for (const pal of PALETTES) {
	for (const sp of SPACINGS) {
		await setLook(pal, sp);
		let n = 0;
		for (const [name, enter] of Object.entries(SCENES)) {
			await enter();
			await setLook(pal, sp);		// a scene can rebuild furniture; hold the look
			// The picture is taken BEFORE the Tab: a focus ring in every shot is
			// the harness's, not the app's, and it reads as a defect to the eye.
			await page.screenshot({ path: path.join(SHOTS, `${pal}-${sp}-${name}.png`), timeout: 8000 })
				.catch(() => {});
			await page.keyboard.press('Tab');		// arms :focus-visible; see the focus pass
			const res = await page.evaluate(AUDIT);
			for (const f of res.out) { record(pal, sp, name, f); if (f.severity === 'defect') n++; }
			for (const c of res.samples) {
				let m = contrast.get(c.sel);
				if (!m) { m = new Map(); contrast.set(c.sel, m); }
				const k = `${pal}/${sp}`;
				if (!m.has(k) || m.get(k) > c.cr) m.set(k, c.cr);
			}
		}
		await calm();
		log(`  ${pal.padEnd(9)} ${SPACE_WORD[sp].padEnd(8)} ${n} defect hits`);
	}
}

// ── One palette washing out what the others read fine ────────────────────
//
// No absolute threshold can find this: a muted hint at 2.6:1 is the design, and
// the same hint at 1.9:1 in one palette is a bug in that palette. The oracle is
// the OTHER TEN, so it only means anything on the full sweep.
const washed = [];
if (PALETTES.length > 4) {
	for (const [selName, m] of contrast) {
		if (m.size < PALETTES.length * 1.5) continue;	// not seen widely enough to compare fairly
		const vals = [...m.values()].sort((a, b) => a - b);
		const med = vals[Math.floor(vals.length / 2)];
		for (const [k, v] of m) {
			if (v < med * 0.7 && v < 3.2) {
				washed.push({ sel: selName, look: k, cr: v, med: +med.toFixed(2) });
			}
		}
	}
	washed.sort((a, b) => a.cr - b.cr);
}

// ── What came out ────────────────────────────────────────────────────────
const list = [...found.values()];
const defects = list.filter((f) => f.severity === 'defect');
const notes   = list.filter((f) => f.severity === 'note');

const ORDER = { 'clipped-ink': 0, 'clipped-focus-ring': 1, offscreen: 2, 'invisible-text': 3, overlap: 4, overflow: 5 };
const rank = (f) => (ORDER[f.check] ?? 9) * 1000 - f.where.length;
defects.sort((a, b) => rank(a) - rank(b));
notes.sort((a, b) => rank(a) - rank(b));

/// Which looks a finding appears in, said briefly: "everywhere", or the list.
const whereText = (f) => {
	const pals = new Set(f.where.map((w) => w.split('/')[0]));
	const sps  = new Set(f.where.map((w) => w.split('/')[1]));
	const scns = new Set(f.where.map((w) => w.split('/')[2]));
	const p = pals.size === PALETTES.length ? 'every palette' : [...pals].join(', ');
	const q = sps.size === 2 ? 'both spacings' : [...sps].join(', ');
	return `${p} — ${q} — ${[...scns].join(', ')}`;
};

log(`\n${defects.length} distinct defects, ${notes.length} notes, over ${PALETTES.length * SPACINGS.length} combinations.`);
const sidesOf = (f) => (f.sides && f.sides.size ? ` on the ${[...f.sides].join(', ')}` : '');
for (const f of defects) {
	log(`\nDEFECT  ${f.check}  ${f.sel}${f.by ? '   [clipped by ' + f.by + ']' : ''}`);
	log(`        ${f.ink ? f.ink + sidesOf(f) + ' — ' : ''}${f.detail}`);
	log(`        ${whereText(f)}`);
	log(`        ${[...f.shots][0]}`);
}
if (washed.length) {
	log('\n— text one palette washes out that the rest read fine —');
	for (const w of washed.slice(0, 25)) {
		log(`WASH    ${w.sel}  ${w.cr}:1 under ${w.look} against a ${w.med}:1 median`);
	}
}
log('\n— notes —');
for (const f of notes) {
	log(`NOTE    ${f.check}  ${f.sel}  ${f.ink ? f.ink + sidesOf(f) + ' — ' : ''}${f.detail}  (${whereText(f)})`);
}

const errs = errors(s).filter((e) => !/502|Bad Gateway|Failed to load resource|favicon/.test(e));
log(`\nconsole: ${errs.length ? errs.slice(0, 5).join(' | ') : 'clean'}`);
log(`self-test: ${proved ? 'every check was seen red before the sweep' : 'A CHECK WAS NEVER SEEN RED'}`);

// A machine-readable copy beside the screenshots, so the report can be built
// from what was measured rather than from what was remembered.
fs.writeFileSync(path.join(SHOTS, 'findings.json'), JSON.stringify({
	findings: list.map((f) => ({ ...f, shots: [...f.shots], sides: [...(f.sides || [])] })),
	washed,
	contrast: [...contrast].map(([k, m]) => ({ sel: k, by: [...m] })),
}, null, 1));

// The VERDICT, last, because the last line is the one that gets quoted.
//
// run_all.sh summarises a verifier by its final line. This one ended on "self-test: every
// check was seen red before the sweep" — true, reassuring, and silent about the two defects
// that had just failed the run. On the 2026-08-11 gate summary it read as a verifier that
// had failed for no stated reason, which is the worst kind of red to hand somebody: it costs
// a second run before anyone even knows what was found.
// Named by the FAULT, not by the entry. One cut piece of ink is recorded once per ancestor
// that clips it, so the crystal-cap ring at the foot of the models panel comes out as two
// findings — `[clipped by html > body]` and `[clipped by html]` — which are one thing to fix
// and would read on a summary as two. The blocks above still print every clipper; this line
// counts what a person would go and mend.
const faults = [...new Set(defects.map((f) => `${f.check} on ${f.sel}`))];
log(defects.length
	? `\nFAIL  ${faults.join('; ')}`
		+ `${faults.length < defects.length ? `  (${defects.length} findings, ${faults.length} fault(s))` : ''}`
		+ `  — evidence in ${path.join(SHOTS, 'findings.json')}`
	: `\nPASS  no defects over ${PALETTES.length * SPACINGS.length} combinations`
		+ `${notes.length ? `, ${notes.length} note(s) to look at` : ''}.`);

await s.close();
process.exit(defects.length ? 1 : 0);
