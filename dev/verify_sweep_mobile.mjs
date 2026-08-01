// verify_sweep_mobile.mjs — the phone/narrow sweep.
//
// Eleven palettes and a second spacing ("Breathe") went in without anyone
// holding the app at 320px with a thumb.  This drives the real page at seven
// widths, in both spacings, across every palette, through the states a phone
// actually reaches — the chat floor, the rail drawer, the sheet at half and at
// full, and each bottom-bar destination — and measures nine things mechanically:
//
//   off-right    nothing visible past the right edge
//   h-scroll     the document never scrolls horizontally
//   off-top      no drawer control sits above a drawer that cannot scroll to it
//   overlap      no two controls' boxes intersect
//   squeezed     no nowrap control is narrower than its own text
//   obscured     no control's centre belongs to something that is not an overlay
//   shell        drawer and sheet open, cover what they should, and close clean;
//                the drawer's two lists keep more than a row between them
//   target size  ≥24×24 CSS px (WCAG 2.2 AA 2.5.8); <44 is reported separately
//   contrast     the bottom nav, the tag chips and a link in a reply, per palette
//
// plus: the tag filter folds to one disclosure row at every width and spacing,
// and env(safe-area-inset-*) is spent once and only where it is owed.
//
// A browser cannot render a home-indicator inset, so the safe-area pass EMULATES
// one: the inset is injected as literal pixels into exactly the three
// declarations that name env(), which is what the device resolves them to, and
// the geometry is measured again.
//
// The context is built here rather than through harness.open() because a phone
// is `pointer: coarse` and `hover: none`, and responsive.css has a whole block
// keyed on that — testing it from a mouse context tests the wrong stylesheet.
//
//   node dev/verify_sweep_mobile.mjs              # the sweep
//   node dev/verify_sweep_mobile.mjs --quick      # three palettes, no shots
//   node dev/verify_sweep_mobile.mjs --selftest   # prove the checks can go red
//
// Needs `node dev/serve.mjs` and `node dev/mockllm.mjs` already running.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP, CHROME, signInAs, connectMock, scratch } from './harness.mjs';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots', 'sweepm');
const REPORT = path.join(HERE, 'sweep_mobile_report.md');

const QUICK    = process.argv.includes('--quick');
const SELFTEST = process.argv.includes('--selftest');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The matrix ───────────────────────────────────────────────────────────────
// 760px is the one structural cliff (responsive.css:11, mobile.css:24), so the
// pair either side of it is in the list: layout bugs live exactly there.
const BREAK = 760;
const SIZES = [
	{ w: 320, h: 568,  tag: '320x568',  note: 'smallest phone still in use (iPhone SE)' },
	{ w: 390, h: 844,  tag: '390x844',  note: 'iPhone 12/13/14' },
	{ w: 414, h: 896,  tag: '414x896',  note: 'iPhone 11 / XR' },
	{ w: 740, h: 360,  tag: '740x360',  note: 'phone landscape (exercises the 560+landscape rule)' },
	{ w: BREAK - 1, h: 1024, tag: '759x1024', note: 'breakpoint − 1 (last phone width)' },
	{ w: BREAK + 1, h: 1024, tag: '761x1024', note: 'breakpoint + 1 (first desktop width)' },
	{ w: 768, h: 1024, tag: '768x1024', note: 'tablet portrait — desktop layout, coarse pointer' },
];
const PALETTES = ['light', 'mist', 'linen', 'lollypop', 'sage', 'dusk', 'dark', 'amber', 'midnight', 'forest', 'plum'];
const SAMPLE   = ['light', 'dark', 'lollypop'];		// one light, one dark, one loud
const SKINS    = [['sharp', 'Compact'], ['warm', 'Breathe']];

// ── Findings ────────────────────────────────────────────────────────────────
// One row per (check, selector, width, skin, state); the palettes that showed
// it are collected, so "every palette" and "only lollypop" read differently.
const found = new Map();
function report(o) {
	const key = [o.check, o.sel, o.width, o.skin, o.state].join('|');
	const e = found.get(key) || { ...o, palettes: new Set(), n: 0 };
	e.palettes.add(o.palette);
	e.n++;
	if (o.detail) { e.detail = o.detail; (e.byPalette = e.byPalette || {})[o.palette] = o.detail; }
	found.set(key, e);
}
let probes = 0;

// ── The in-page probe ───────────────────────────────────────────────────────
// Everything below runs in the page.  It is one function so a state costs one
// round trip, and it takes its own geometry rather than trusting a stylesheet.
function PROBE(arg) {
	const W = window.innerWidth, H = window.innerHeight;

	const nm = (el) => {
		if (!el || !el.tagName) return String(el);
		let s = el.tagName.toLowerCase();
		if (el.id) s += '#' + el.id;
		const c = (typeof el.className === 'string' ? el.className : '').trim();
		if (c) s += '.' + c.split(/\s+/).slice(0, 3).join('.');
		return s.slice(0, 90);
	};
	// getComputedStyle is the cost of this whole probe: the off-screen scan reads
	// every element and clipRect reads its whole ancestry, so an uncached call
	// per node per lookup put a single state at several seconds.  One read per
	// element per probe.
	const _cs = new WeakMap();
	const cs = (el) => { let v = _cs.get(el); if (!v) { v = getComputedStyle(el); _cs.set(el, v); } return v; };
	const _rect = new WeakMap();
	const rect = (el) => { let v = _rect.get(el); if (!v) { v = el.getBoundingClientRect(); _rect.set(el, v); } return v; };
	const shown = (el) => {
		const s = cs(el);
		return !(s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0);
	};
	/// The rect a user can actually reach: the element's box, cut down by every
	/// ancestor that clips.  A 900px <pre> inside an `overflow-x: auto` box is
	/// not off-screen; a 900px toolbar in a visible box is.
	// The clip an element inherits from its ancestry, memoised down the tree so a
	// deep DOM is one pass rather than one walk per node.
	const _clip = new WeakMap();
	const ancestorClip = (el) => {
		let v = _clip.get(el);
		if (v) return v;
		const p = el.parentElement;
		const up = p ? ancestorClip(p) : { x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity };
		v = up;
		if (p) {
			const s = cs(p);
			const clipsX = s.overflowX !== 'visible', clipsY = s.overflowY !== 'visible';
			if (clipsX || clipsY) {
				const pr = rect(p);
				v = { x1: clipsX ? Math.max(up.x1, pr.left) : up.x1,
					y1: clipsY ? Math.max(up.y1, pr.top) : up.y1,
					x2: clipsX ? Math.min(up.x2, pr.right) : up.x2,
					y2: clipsY ? Math.min(up.y2, pr.bottom) : up.y2 };
			}
		}
		_clip.set(el, v);
		return v;
	};
	const clipRect = (el) => {
		const r = rect(el);
		// A fixed element escapes every ancestor's overflow (barring a transformed
		// containing block, which nothing here has), so the walk must not clip it —
		// the drawer and the sheet are both fixed inside an `overflow: hidden` #app.
		const c = cs(el).position === 'fixed'
			? { x1: -Infinity, y1: -Infinity, x2: Infinity, y2: Infinity }
			: ancestorClip(el);
		const x1 = Math.max(r.left, c.x1), y1 = Math.max(r.top, c.y1);
		const x2 = Math.min(r.right, c.x2), y2 = Math.min(r.bottom, c.y2);
		return { left: x1, top: y1, right: x2, bottom: y2, width: x2 - x1, height: y2 - y1 };
	};
	const onScreen = (r) => r.width > 0.5 && r.height > 0.5
		&& r.right > 0 && r.left < W && r.bottom > 0 && r.top < H;

	// ── 1. Off the right edge ───────────────────────────────────
	const offscreen = [];
	document.querySelectorAll('*').forEach(el => {
		if (!shown(el)) return;
		// If an ancestor already clips this subtree to within the screen, nothing
		// inside it can reach past the edge — and #app is `overflow: hidden` at
		// exactly the viewport width, so this retires almost the whole document
		// without ever measuring it.
		const fixed = cs(el).position === 'fixed';
		if (!fixed && ancestorClip(el).x2 <= W + 1) return;
		const r = clipRect(el);
		if (r.width <= 0.5 || r.height <= 0.5) return;
		if (r.bottom <= 0 || r.top >= H) return;
		if (r.right > W + 1) offscreen.push({ sel: nm(el), left: Math.round(r.left), right: Math.round(r.right) });
	});
	// One row per distinct selector; the report groups them anyway, and a burst
	// component drags forty descendants over the edge with it.
	const seenOff = new Set();
	const trimmed = offscreen.filter(o => !seenOff.has(o.sel) && seenOff.add(o.sel));

	// ── 2. Touch targets ────────────────────────────────────────
	const SEL = 'button, a[href], input:not([type=hidden]), select, textarea,'
		+ '[role="button"], [role="tab"], [role="switch"], [role="checkbox"], summary,'
		+ 'label[for], [tabindex]:not([tabindex="-1"])';
	const targets = [];
	document.querySelectorAll(SEL).forEach(el => {
		if (el.disabled) return;
		if (el.getAttribute('aria-hidden') === 'true') return;
		if (!shown(el)) return;
		if (cs(el).pointerEvents === 'none') return;
		const c = clipRect(el);
		if (!onScreen(c)) return;
		// The TARGET is the control's own box.  A list row half-scrolled out of a
		// scroller measures 4px tall through the clip, and reporting that as an
		// unreachable target is measuring the scroll position, not the design.
		const r = rect(el);
		targets.push({
			sel: nm(el),
			w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
			txt: (el.textContent || '').trim().slice(0, 24),
		});
	});

	// ── 4. Obscured ─────────────────────────────────────────────
	// A control whose own centre belongs to something else is unreachable.
	// An overlay that is SUPPOSED to be over the page (the scrim, the drawer,
	// the sheet) is named by the caller and does not count.
	const allow = arg.overlays || [];
	const obscured = [];
	document.querySelectorAll(SEL).forEach(el => {
		if (el.disabled || !shown(el)) return;
		const r = clipRect(el);
		if (!onScreen(r)) return;
		const cx = Math.min(W - 1, Math.max(1, r.left + r.width / 2));
		const cy = Math.min(H - 1, Math.max(1, r.top + r.height / 2));
		const hit = document.elementFromPoint(cx, cy);
		if (!hit) return;
		if (hit === el || el.contains(hit) || hit.contains(el)) return;
		const byOverlay = allow.some(o => {
			const root = document.querySelector(o);
			return root && root.contains(hit) && !root.contains(el);
		});
		if (byOverlay) return;
		obscured.push({ sel: nm(el), by: nm(hit) });
	});

	// ── 4b. Controls overlapping each other, and controls squeezed
	//        narrower than their own text ─────────────────────────
	// A flex row of chips with no `flex: none` does not clip when it runs out of
	// room — it SHRINKS the chips below their content, and the text then spills
	// across the neighbour.  Both halves of that are measured: the boxes that
	// intersect, and the boxes whose content no longer fits them.
	const ctrls = [];
	document.querySelectorAll(SEL).forEach(el => {
		if (el.disabled || !shown(el)) return;
		if (cs(el).pointerEvents === 'none') return;
		const r = clipRect(el);
		if (!onScreen(r)) return;
		ctrls.push({ el, r });
	});
	const overlayRoots = (arg.overlays || []).map(o => document.querySelector(o)).filter(Boolean);
	const inOverlay = (el) => overlayRoots.some(o => o.contains(el));
	const overlap = [], squeezed = [];
	// A palette cannot move a box, so the O(n²) pass runs once per state rather
	// than once per palette — otherwise eleven palettes cost eleven identical
	// sweeps of every pair of controls on screen.
	for (let i = 0; arg.deep && i < ctrls.length; i++) {
		const a = ctrls[i];
		// A nowrap control narrower than its own text has been shrunk past its
		// content; the text is outside the box the user can see and click.
		const st = cs(a.el);
		if (st.whiteSpace === 'nowrap' && st.overflowX === 'visible'
			&& a.el.scrollWidth > a.el.clientWidth + 1 && a.el.clientWidth > 0) {
			squeezed.push({ sel: nm(a.el), box: Math.round(a.el.clientWidth), content: Math.round(a.el.scrollWidth),
				txt: (a.el.textContent || '').trim().slice(0, 20) });
		}
		for (let j = i + 1; j < ctrls.length; j++) {
			const b = ctrls[j];
			if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
			if (inOverlay(a.el) !== inOverlay(b.el)) continue;		// an overlay is meant to be over things
			const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
			const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
			if (ox > 2 && oy > 2) overlap.push({ a: nm(a.el), b: nm(b.el), ox: Math.round(ox), oy: Math.round(oy) });
		}
	}

	// ── 3b. The notch strip ─────────────────────────────────────
	// `viewport-fit=cover` puts the page UNDER the notch, so in landscape the
	// leftmost (or rightmost) ~44px belong to the hardware unless something
	// spends safe-area-inset-left/right.  These are the controls that would sit
	// under it.
	const NOTCH = 44;
	const inNotch = [];
	if (W > H) {
		document.querySelectorAll(SEL).forEach(el => {
			if (el.disabled || !shown(el)) return;
			const r = clipRect(el);
			if (!onScreen(r)) return;
			if (r.left < NOTCH) inNotch.push({ sel: nm(el), left: Math.round(r.left), side: 'left' });
			if (r.right > W - NOTCH) inNotch.push({ sel: nm(el), left: Math.round(r.left), side: 'right' });
		});
	}

	// ── 5. The tag filter ───────────────────────────────────────
	const filt = document.getElementById('diamond-filter');
	const tog  = filt && filt.querySelector('.tagf-toggle');
	const pool = filt && filt.querySelector('.tagf-pool');
	const tagf = (!filt || !shown(filt)) ? null : {
		present: true,
		hasToggle: !!tog,
		expanded: tog ? tog.getAttribute('aria-expanded') === 'true' : null,
		toggleH: tog ? Math.round(tog.getBoundingClientRect().height) : null,
		filtH: Math.round(filt.getBoundingClientRect().height),
		lineH: tog ? parseFloat(cs(tog).lineHeight) || 0 : 0,
		poolH: pool ? Math.round(pool.getBoundingClientRect().height) : null,
		poolCapPx: pool ? Math.round(parseFloat(cs(pool).maxHeight)) : null,
		chips: pool ? [...pool.querySelectorAll('.tag-chip')].map(c => {
			const b = c.getBoundingClientRect();
			return { w: Math.round(b.width * 10) / 10, h: Math.round(b.height * 10) / 10 };
		}) : [],
	};

	// ── 6. Bar geometry, and what mobile.js believes about it ───
	const rectOf = (sel) => {
		const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
		if (!el || !shown(el)) return null;
		const b = el.getBoundingClientRect();
		return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left),
			r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
	};
	const geo = {
		W, H,
		phone: window.matchMedia('(max-width: ' + arg.breakpoint + 'px)').matches,
		coarse: window.matchMedia('(pointer: coarse)').matches,
		docSW: document.documentElement.scrollWidth,
		bodySW: document.body.scrollWidth,
		topbar: rectOf('.topbar'),
		mnav: rectOf('#mnav'),
		mnavBtns: [...document.querySelectorAll('#mnav button')].filter(b => shown(b)).map(b => {
			const r = b.getBoundingClientRect();
			return { t: (b.textContent || '').trim(), w: Math.round(r.width), h: Math.round(r.height) };
		}),
		sheet: rectOf('#msheet'),
		sheetOpen: !!(window.DaimondSheet && DaimondSheet.isOpen()),
		sheetGuest: window.DaimondSheet ? DaimondSheet.guest() : null,
		ask: rectOf('#msheet-ask'),
		askPadBottom: (() => { const e = document.getElementById('msheet-ask'); return e ? cs(e).paddingBottom : null; })(),
		grab: rectOf('#msheet-grab'),
		rail: rectOf('#panel-rail'),
		railOpaque: (() => {
			const e = document.getElementById('panel-rail'); if (!e) return null;
			const bg = cs(e).backgroundColor;
			const m = bg.match(/rgba?\(([^)]+)\)/); if (!m) return null;
			const p = m[1].split(',').map(x => parseFloat(x));
			return p.length < 4 || p[3] >= 0.999;
		})(),
		scrim: (() => {
			const e = document.getElementById('scrim'); if (!e) return null;
			const s = cs(e); const b = e.getBoundingClientRect();
			return { pe: s.pointerEvents, op: +s.opacity, bg: s.backgroundColor,
				covers: b.left <= 0 && b.top <= 0 && b.right >= W && b.bottom >= H };
		})(),
		drawerOpen: document.body.classList.contains('drawer-open'),
		// A drawer taller than the screen scrolls; a drawer whose content sits ABOVE
		// its own top edge while it is scrolled to the top does not.  Those controls
		// cannot be reached at all.
		railClipped: (() => {
			const rl = document.getElementById('panel-rail');
			if (!rl || !document.body.classList.contains('drawer-open')) return null;
			const rr = rect(rl);
			const out = [];
			rl.querySelectorAll('button, input, a[href], select, textarea').forEach(el => {
				if (!shown(el)) return;
				const r = rect(el);
				if (r.height > 0 && r.bottom <= rr.top + 1) out.push(nm(el));
				else if (r.height > 0 && r.top < rr.top - 1) out.push(nm(el) + ' (part)');
			});
			return { scrollTop: Math.round(rl.scrollTop), scrollH: Math.round(rl.scrollHeight),
				clientH: Math.round(rl.clientHeight), above: out.slice(0, 12) };
		})(),
		// What the drawer's two lists are left with once the search box, the tag
		// filter and the admin block have taken their cut.
		lists: (() => {
			const g = (id) => { const e = document.getElementById(id); return e ? Math.round(rect(e).height) : null; };
			return { diamonds: g('diamond-list'), chats: g('session-list') };
		})(),
		mpanel: document.body.dataset.mpanel,
		modalUp: [...document.querySelectorAll('.modal, .dlg')]
			.filter(e => cs(e).display !== 'none' && e.getBoundingClientRect().width > 0)
			.map(e => nm(e)),
	};

	// ── Colour: the palette-sensitive bits ──────────────────────
	const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? m.map(Number) : [0, 0, 0, 1]; };
	const lum = (c) => {
		const [r, g, b] = parse(c).slice(0, 3).map(v => {
			v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		});
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const bgOf = (el) => {
		for (let p = el; p; p = p.parentElement) {
			const c = cs(p).backgroundColor, a = parse(c)[3];
			if (a === undefined || a >= 0.999) return c;
		}
		return cs(document.body).backgroundColor;
	};
	const ratio = (fg, bg) => {
		const a = lum(fg), b = lum(bg);
		return +(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2));
	};
	const contrast = [];
	const measure = (el, what) => {
		if (!el || !shown(el)) return;
		const r = clipRect(el); if (!onScreen(r)) return;
		const st = cs(el);
		contrast.push({ what, sel: nm(el), ratio: ratio(st.color, bgOf(el)),
			size: Math.round(parseFloat(st.fontSize) * 10) / 10,
			weight: st.fontWeight, fg: st.color, bg: bgOf(el) });
	};
	document.querySelectorAll('#mnav button').forEach(b => {
		const lbl = b.querySelector('span') || b;
		measure(lbl, b.classList.contains('on') ? 'bottom nav (active)' : 'bottom nav (idle)');
	});
	if (pool) [...pool.querySelectorAll('.tag-chip')].slice(0, 4).forEach(c => measure(c, 'tag chip in the pool'));
	measure(document.querySelector('.tagf-toggle'), 'tag filter disclosure row');
	// A model's reply is full of links, and nothing in the app styles one — they
	// arrive as the browser's own #0000EE, which no palette knows about.
	// The FIRST link in a long transcript is scrolled far above the fold, and
	// measure() skips anything off screen — take the first one actually in view.
	measure([...document.querySelectorAll('#chat-output .chat-msg-content a')]
		.find(a => { const r = clipRect(a); return onScreen(r); }), 'link in a chat message');
	measure(document.querySelector('#chat-output .chat-msg-assistant .chat-msg-content'), 'assistant message body');
	measure(document.querySelector('#msheet-title'), 'sheet title');
	measure(document.querySelector('.rail-tag-hint'), 'rail tag hint');

	return { offscreen: trimmed, targets, obscured, overlap, squeezed, tagf, geo, contrast, inNotch };
}

// ── Driving ─────────────────────────────────────────────────────────────────
async function boot() {
	const dir = scratch('pw', 'sweepm');
	fs.mkdirSync(dir, { recursive: true });
	const browser = await chromium.launchPersistentContext(dir, {
		executablePath: CHROME,
		headless: false,
		args: ['--no-sandbox', '--disable-dev-shm-usage', '--headless=new'],
		viewport: { width: 390, height: 844 },
		// A phone is coarse and cannot hover.  responsive.css keys a whole block
		// on that, so without it the sweep reads a stylesheet no phone loads.
		hasTouch: true,
		deviceScaleFactor: 1,
	});
	const page = browser.pages()[0] || await browser.newPage();
	const errs = [];
	page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
	page.on('pageerror', e => errs.push('pageerror: ' + e.message));
	await page.goto(APP, { waitUntil: 'domcontentloaded' });
	const s = { browser, page, errs, name: 'sweepm' };
	await page.setViewportSize({ width: 1400, height: 900 });		// seed on a desktop
	await signInAs(s, 'sweepm');
	await connectMock(s);
	await page.evaluate(() => { try { DaimondAdmin.closeModal(); } catch (e) {} });
	// Headless does not advance transitions reliably; a mid-flight measurement is
	// a measurement of nothing.
	await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
	await sleep(400);
	return s;
}

/// Give the rail something to be: Diamonds, a vocabulary of tags, and a chat
/// whose content is hostile to a narrow column.
async function seed(s) {
	const { page } = s;
	const have = await page.$$eval('.diamond-box', els => els.length);
	if (have < 3) {
		for (const n of ['Ship a CSV parser', 'Mum birthday plan and the long tail of it', 'Rust compiler notes']) {
			await page.click('#new-diamond-btn', { force: true });
			await page.waitForSelector('.dlg-input', { timeout: 10000 });
			await page.fill('.dlg-input', n);
			await page.click('.dlg-ok', { force: true });
			await page.waitForTimeout(600);
		}
	}
	// Tags straight through the wasm: the editor is nine clicks a tag and this
	// sweep is not testing the editor.
	await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const rows = JSON.parse(await app.list_diamonds());
		const bank = ['person', 'work', 'idea', 'rust', 'admin', 'errands', 'reading',
			'2026', 'urgent', 'someday', 'money', 'travel', 'a-rather-long-tag-name'];
		for (let i = 0; i < rows.length; i++) {
			const tags = bank.filter((_, j) => (j + i) % 3 !== 2).slice(0, 9);
			await app.set_tags(rows[i].id, JSON.stringify(tags));
		}
	});
	// The rail paints its tag pool at load, so a reload is the honest way to see
	// the tags land.  The identity is held in memory only, so the reload drops
	// back to the passphrase gate and has to be answered again.
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'sweepm');
	await sleep(600);
	await page.evaluate(() => { try { DaimondAdmin.closeModal(); } catch (e) {} });
	await page.waitForSelector('#diamond-search', { timeout: 15000 });
	await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
	await sleep(600);

	// A chat with a long unbroken token in it — the thing that bursts a column.
	// Best effort: a chat gives the floor something to be, but a sweep of the
	// SHELL is still worth running on an empty one.
	try {
		if (!(await page.isVisible('#chat-input'))) {
			// The Admin drawer opens over the rail on a fresh profile and swallows
			// the + button's click (see harness.newChat).
			const dc = page.locator('#admin-close');
			if (await dc.isVisible().catch(() => false)) { await dc.click({ force: true }); await sleep(200); }
			await page.click('#new-session-btn', { force: true });
			await sleep(700);
			const start = page.locator('.tile-start').first();
			if (await start.count()) { await start.click({ force: true }); await sleep(700); }
			await page.waitForSelector('#chat-input', { state: 'visible', timeout: 8000 });
		}
		await page.fill('#chat-input', 'read https://example.com/a/very/long/unbroken/path/that/no/narrow/column/can/possibly/wrap/nicely?q=aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		await page.click('#chat-send', { force: true });
		await sleep(2500);
	} catch (e) {
		console.log('  (no chat seeded: ' + e.message.split('\n')[0] + ')');
	}
	// Agents is hidden until first reached; the bottom bar's fourth slot only
	// exists once it is, so reveal it or the bar is never tested full.
	await page.evaluate(() => {
		try { localStorage.setItem('daimond-agents-revealed', '1'); } catch (e) {}
		document.body.classList.remove('agents-hidden');
	});
}

/// Put the app into a named state and return the overlays that are meant to be
/// covering things there.
/// Put the page back to bare: no modal, no dialog, no sheet, no drawer.
///
/// On a phone the Admin drawer is hosted in `#settings-modal`, which is a
/// full-screen overlay — leave one standing and every later measurement is a
/// measurement of the overlay.
async function clearOverlays(page) {
	return page.evaluate(() => {
		const up = () => [...document.querySelectorAll('.modal, .dlg')]
			.filter(e => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0);
		const was = up().map(e => e.id || e.className);
		for (let i = 0; i < 4 && up().length; i++) {
			try { if (window.DaimondAdmin && DaimondAdmin.closeModal) DaimondAdmin.closeModal(); } catch (e) {}
			up().forEach(e => {
				const x = e.querySelector('.admin-back, .modal-close, .dlg-cancel, .dlg-ok');
				if (x) x.click(); else e.style.display = 'none';
			});
		}
		return was;
	});
}

async function setState(page, state) {
	await clearOverlays(page);
	await page.evaluate(() => {
		try { if (window.DaimondSheet && DaimondSheet.isOpen()) DaimondSheet.close(); } catch (e) {}
		try { if (window.DaimondShell) DaimondShell.closeDrawer(); } catch (e) {}
	});
	await sleep(150);
	switch (state) {
		case 'chat':
			await page.evaluate(() => { const b = document.querySelector('#mnav button[data-mp="ai"]'); if (b) b.click(); });
			break;
		case 'drawer':
			await page.evaluate(() => { const b = document.getElementById('drawer-btn'); if (b) b.click(); else DaimondShell.openDrawer(); });
			await sleep(250);
			// Open the tag pool, which is where the small controls live.
			await page.evaluate(() => {
				const t = document.querySelector('#diamond-filter .tagf-toggle');
				if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
			});
			break;
		case 'drawer-folded':
			await page.evaluate(() => {
				const b = document.getElementById('drawer-btn'); if (b) b.click(); else DaimondShell.openDrawer();
			});
			await sleep(250);
			await page.evaluate(() => {
				const t = document.querySelector('#diamond-filter .tagf-toggle');
				if (t && t.getAttribute('aria-expanded') === 'true') t.click();
			});
			break;
		case 'sheet-half':
			await page.evaluate(() => { DaimondPanels.hide('web'); DaimondPanels.show('web'); });
			break;
		case 'sheet-full':
			await page.evaluate(() => { DaimondPanels.hide('tools'); DaimondPanels.show('tools'); });
			break;
		case 'files':
			await page.evaluate(() => { const b = document.querySelector('#mnav button[data-mp="work"]'); if (b) b.click(); });
			break;
		case 'mail':
			await page.evaluate(() => { const b = document.querySelector('#mnav button[data-mp="mail"]'); if (b) b.click(); });
			break;
		case 'agents':
			await page.evaluate(() => { const b = document.querySelector('#mnav button[data-mp="agents"]'); if (b) b.click(); });
			break;
		case 'desktop':
			break;
	}
	await sleep(420);
	const overlays = { drawer: ['#scrim', '#panel-rail'], 'drawer-folded': ['#scrim', '#panel-rail'],
		'sheet-half': ['#msheet'], 'sheet-full': ['#msheet'] }[state] || [];
	return overlays;
}

// ── Judging one probe ───────────────────────────────────────────────────────
// The floors.  24 is the WCAG 2.2 AA minimum (2.5.8 Target Size, Minimum); 44
// is the size Apple and the AAA level ask for and is reported separately.
const MIN = 24, WANT = 44;
// Controls whose size is set by the reading scale and which sit in a row of
// their own are still worth knowing about but are not "unreachable".
function judge(r, ctx) {
	const { width, palette, skin, state } = ctx;

	// 1. off-screen / horizontal scroll
	if (r.geo.docSW > r.geo.W + 1) {
		report({ check: 'h-scroll', sel: 'document', width, palette, skin, state,
			detail: `scrollWidth ${r.geo.docSW} > innerWidth ${r.geo.W}` });
	}
	for (const o of r.offscreen) {
		report({ check: 'off-right', sel: o.sel, width, palette, skin, state,
			detail: `right edge at ${o.right}px, viewport is ${r.geo.W}px` });
	}

	// 2. touch targets
	const seen = new Map();
	for (const t of r.targets) {
		const prev = seen.get(t.sel);
		if (!prev || t.w * t.h < prev.w * prev.h) seen.set(t.sel, t);
	}
	for (const t of seen.values()) {
		if (t.w < MIN || t.h < MIN) {
			report({ check: 'target<24', sel: t.sel, width, palette, skin, state,
				detail: `${t.w}×${t.h} px${t.txt ? ' ("' + t.txt + '")' : ''}` });
		} else if (t.w < WANT || t.h < WANT) {
			report({ check: 'target<44', sel: t.sel, width, palette, skin, state,
				detail: `${t.w}×${t.h} px` });
		}
	}

	// 4. obscured. A standing modal covers everything by design, so it is
	// reported once rather than as forty unreachable controls.
	if (r.geo.modalUp && r.geo.modalUp.length) {
		report({ check: 'overlay', sel: r.geo.modalUp[0], width, palette, skin, state,
			detail: 'a modal was standing during this state — obscured check skipped' });
	} else {
		for (const o of r.obscured) {
			report({ check: 'obscured', sel: o.sel, width, palette, skin, state,
				detail: `centre belongs to ${o.by}` });
		}
	}

	// 4b. controls on top of each other, and controls squeezed past their text
	for (const o of (r.overlap || [])) {
		report({ check: 'overlap', sel: `${o.a} × ${o.b}`, width, palette, skin, state,
			detail: `their boxes intersect by ${o.ox}×${o.oy} px` });
	}
	for (const q of (r.squeezed || [])) {
		report({ check: 'squeezed', sel: q.sel, width, palette, skin, state,
			detail: `box ${q.box}px, its own text needs ${q.content}px${q.txt ? ' ("' + q.txt + '")' : ''}` });
	}

	// 5. the tag filter
	if (r.tagf && r.tagf.present) {
		if (!r.tagf.hasToggle) {
			report({ check: 'tagfilter', sel: '#diamond-filter', width, palette, skin, state,
				detail: 'no disclosure row — the pool is standing' });
		} else if (state === 'drawer-folded') {
			// Folded, the whole filter must be ONE row.
			const oneRow = Math.max(r.tagf.lineH * 2, 34);
			if (r.tagf.filtH > oneRow) {
				report({ check: 'tagfilter', sel: '#diamond-filter', width, palette, skin, state,
					detail: `folded height ${r.tagf.filtH}px, one row is ≤${Math.round(oneRow)}px` });
			}
		} else if (state === 'drawer') {
			if (r.tagf.poolH === null) {
				report({ check: 'tagfilter', sel: '.tagf-pool', width, palette, skin, state,
					detail: 'disclosure open but no pool drawn' });
			} else if (r.tagf.poolCapPx && r.tagf.poolH > r.tagf.poolCapPx + 2) {
				report({ check: 'tagfilter', sel: '.tagf-pool', width, palette, skin, state,
					detail: `pool ${r.tagf.poolH}px over its ${r.tagf.poolCapPx}px cap` });
			}
		}
	}

	// 3/6. the shells
	const g = r.geo;
	if (g.phone) {
		for (const b of (g.mnavBtns || [])) {
			if (b.h < MIN || b.w < MIN) {
				report({ check: 'target<24', sel: `#mnav button ("${b.t}")`, width, palette, skin, state,
					detail: `${b.w}×${b.h} px` });
			}
		}
		if (!g.mnav || g.mnav.h < 1) {
			report({ check: 'shell', sel: '#mnav', width, palette, skin, state, detail: 'bottom bar not drawn on a phone width' });
		}
		if (state === 'drawer' || state === 'drawer-folded') {
			if (!g.drawerOpen) report({ check: 'shell', sel: 'body.drawer-open', width, palette, skin, state, detail: 'the hamburger did not open the drawer' });
			if (g.rail && g.rail.l < -1) report({ check: 'shell', sel: '#panel-rail', width, palette, skin, state, detail: `drawer left edge at ${g.rail.l}px — it did not slide in` });
			if (g.rail && g.rail.r > g.W + 1) report({ check: 'shell', sel: '#panel-rail', width, palette, skin, state, detail: `drawer runs to ${g.rail.r}px past a ${g.W}px screen` });
			if (g.railOpaque === false) report({ check: 'shell', sel: '#panel-rail', width, palette, skin, state, detail: 'drawer background is not opaque — the page shows through' });
			const rc = g.railClipped;
			if (rc && rc.above.length && rc.scrollTop === 0) {
				report({ check: 'off-top', sel: '#panel-rail', width, palette, skin, state,
					detail: `scrolled to the top, ${rc.above.length} control(s) sit above the drawer's own top edge `
						+ `and cannot be reached: ${rc.above.join(', ')} (scrollHeight ${rc.scrollH}, clientHeight ${rc.clientH})` });
			}
			// A drawer whose lists have been squeezed out by their own furniture is
			// a drawer that shows the filing system and none of the files.
			for (const [what, h] of Object.entries(g.lists || {})) {
				if (h !== null && h < 60) {
					report({ check: 'shell', sel: `#${what === 'diamonds' ? 'diamond' : 'session'}-list`, width, palette, skin, state,
						detail: `the drawer's ${what} list is ${h}px tall — under two rows` });
				}
			}
			if (g.scrim && (g.scrim.pe !== 'auto' || !g.scrim.covers)) {
				report({ check: 'shell', sel: '#scrim', width, palette, skin, state,
					detail: `scrim pointer-events=${g.scrim.pe}, covers=${g.scrim.covers}` });
			}
		}
		if (state.startsWith('sheet')) {
			if (!g.sheetOpen) report({ check: 'shell', sel: '#msheet', width, palette, skin, state, detail: 'the sheet did not rise' });
			if (g.sheet && g.mnav && g.sheet.b > g.mnav.t + 1) {
				report({ check: 'shell', sel: '#msheet', width, palette, skin, state,
					detail: `sheet foot at ${g.sheet.b} overlaps the bar at ${g.mnav.t}` });
			}
			if (g.sheet && g.topbar && g.sheet.t < g.topbar.b) {
				report({ check: 'shell', sel: '#msheet', width, palette, skin, state,
					detail: `sheet top at ${g.sheet.t} rides under the top bar (bottom ${g.topbar.b})` });
			}
			if (g.ask && g.ask.b > g.H + 1) {
				report({ check: 'shell', sel: '#msheet-ask', width, palette, skin, state, detail: `ask pill foot at ${g.ask.b}, viewport ${g.H}` });
			}
			// Room left for the thing itself, between the grabber and the pill.
			if (g.sheet && g.grab && g.ask) {
				const body = g.ask.t - g.grab.b;
				if (body < 60) {
					report({ check: 'shell', sel: '#msheet-body', width, palette, skin, state,
						detail: `only ${body}px between the grabber and the ask pill` });
				}
			}
		}
	} else {
		if (g.mnav && g.mnav.h > 0) {
			report({ check: 'shell', sel: '#mnav', width, palette, skin, state, detail: 'phone bottom bar still drawn above the breakpoint' });
		}
	}

	// contrast — small text needs 4.5:1, ≥18.66px (or ≥24px) needs 3:1.
	for (const c of r.contrast) {
		const large = c.size >= 24 || (c.size >= 18.66 && +c.weight >= 700);
		const need = large ? 3 : 4.5;
		if (c.ratio < need) {
			report({ check: 'contrast', sel: c.sel, width, palette, skin, state,
				detail: `${c.what}: ${c.ratio}:1 at ${c.size}px, needs ${need}:1 (${c.fg} on ${c.bg})` });
		}
	}
	probes++;
}

// ── Safe-area emulation ─────────────────────────────────────────────────────
// Chromium renders env(safe-area-inset-*) as 0, so the three declarations that
// spend it are re-stated with a literal inset — exactly what a notched phone
// resolves them to — and the geometry is measured again.
const INSET = 34;			// iPhone portrait home-indicator inset
const INSET_CSS = `
@media (max-width: ${BREAK}px) {
	.mnav { padding-bottom: calc(6px + ${INSET}px) !important; }
	#msheet { bottom: calc(58px + ${INSET}px) !important; }
	.msheet-ask { padding-bottom: calc(8px + ${INSET}px) !important; }
}`;

async function safeAreaPass(page, ctx) {
	const handle = await page.addStyleTag({ content: INSET_CSS });
	await sleep(300);
	const before = await page.evaluate(() => {
		const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect();
			return { t: Math.round(b.top), b: Math.round(b.bottom), h: Math.round(b.height) }; };
		return { sheet: r('#msheet'), mnav: r('#mnav'), topbar: r('.topbar'), ask: r('#msheet-ask'),
			grab: r('#msheet-grab'), H: window.innerHeight };
	});
	await handle.evaluate(el => el.remove());
	await sleep(200);
	return before;
}

/// What the stylesheets actually spend the safe area on, read out of the CSSOM.
///
/// `viewport-fit=cover` is what MAKES the insets non-zero: it hands the app the
/// whole screen including the strips the hardware owns.  A page that asks for
/// that and then only ever pays back `-bottom` is under the notch on every other
/// side, and there is no way to see that in a browser that renders every inset
/// as zero.
async function staticAudit(page) {
	return page.evaluate(() => {
		const sides = { top: [], right: [], bottom: [], left: [] };
		// `r.cssRules` is TRUTHY on a plain CSSStyleRule in current Chromium — every
		// style rule is a grouping rule since CSS nesting landed, and its list is
		// merely empty.  Recursing on truthiness therefore walks past every rule in
		// the document and finds nothing.  Test the LENGTH, and read declarations off
		// `r.style` rather than off a grouping rule's whole cssText.
		const walk = (rules, href) => {
			for (const r of rules) {
				if (r.style) {
					// r.style's INDEXED properties are longhands, and a shorthand carrying
					// env() cannot be expanded — it is held as a pending substitution and
					// never appears there.  `padding: 6px 4px calc(6px + env(...))` is
					// exactly that shape, so read the declaration block as text.
					const decls = (r.style.cssText || '').split(';').map(x => x.trim()).filter(Boolean);
					for (const d of decls) {
						['top', 'right', 'bottom', 'left'].forEach(side => {
							if (d.includes('safe-area-inset-' + side)) {
								sides[side].push(`${(href || 'inline').split('/').pop()} — ${r.selectorText || '?'} { ${d} }`);
							}
						});
					}
				}
				if (r.cssRules && r.cssRules.length) walk(r.cssRules, href);
			}
		};
		for (const sh of document.styleSheets) {
			try { walk(sh.cssRules, sh.href); } catch (e) { /* cross-origin */ }
		}
		const meta = document.querySelector('meta[name="viewport"]');
		return { sides, viewport: meta ? meta.content : null };
	});
}

// ── The self-test ───────────────────────────────────────────────────────────
// A check never seen red is not evidence.  Each of these breaks the page in a
// specific way and asserts the corresponding check reports it.
async function selftest(page) {
	const results = [];
	let asState = 'chat', asOverlays = [];
	const run = async (name, breakIt, fixIt, wanted) => {
		found.clear();
		await breakIt();
		await sleep(250);
		const r = await page.evaluate(PROBE, { overlays: asOverlays, breakpoint: BREAK, deep: true });
		judge(r, { width: 'selftest', palette: 'dark', skin: 'sharp', state: asState });
		const hits = [...found.values()].filter(f => f.check === wanted.check
			&& (!wanted.sel || f.sel.includes(wanted.sel))
			&& (!wanted.detail || (f.detail || '').includes(wanted.detail)));
		await fixIt();
		await sleep(200);
		results.push({ name, red: hits.length > 0, saw: hits.slice(0, 2).map(h => `${h.sel} — ${h.detail}`) });
		console.log(`  ${hits.length ? 'RED ' : 'MISS'}  ${name}` + (hits.length ? ` → ${hits[0].sel}: ${hits[0].detail}` : ''));
	};

	await page.setViewportSize({ width: 390, height: 844 });
	asOverlays = await setState(page, 'chat');
	asState = 'chat';

	await run('touch target: shrink #drawer-btn to 20×20',
		() => page.evaluate(() => { const b = document.getElementById('drawer-btn');
			b.dataset.old = b.style.cssText; b.style.cssText += ';width:20px!important;height:20px!important;min-width:20px!important;min-height:20px!important'; }),
		() => page.evaluate(() => { const b = document.getElementById('drawer-btn'); b.style.cssText = b.dataset.old || ''; }),
		{ check: 'target<24', sel: 'drawer-btn' });

	// A fixed bar, because #app is `overflow: hidden` and would legitimately clip
	// an in-flow one — which is what clipRect is for, and is not the bug class.
	await run('off-screen: a fixed toolbar 200px past the right edge',
		() => page.evaluate(() => { const d = document.createElement('div'); d.id = 'selftest-wide-bar';
			d.style.cssText = 'position:fixed;left:100px;top:200px;width:' + (window.innerWidth + 100) + 'px;height:30px;background:#0f0;z-index:5';
			document.body.appendChild(d); }),
		() => page.evaluate(() => { const d = document.getElementById('selftest-wide-bar'); if (d) d.remove(); }),
		{ check: 'off-right', sel: 'selftest-wide-bar' });

	await run('obscured: drop a fixed pane over the top bar',
		() => page.evaluate(() => { const d = document.createElement('div'); d.id = 'selftest-cover';
			d.style.cssText = 'position:fixed;left:0;right:0;top:0;height:70px;z-index:999;background:#f00';
			document.body.appendChild(d); }),
		() => page.evaluate(() => { const d = document.getElementById('selftest-cover'); if (d) d.remove(); }),
		{ check: 'obscured' });

	await run('h-scroll: force the document wider than the screen',
		() => page.evaluate(() => { const d = document.createElement('div'); d.id = 'selftest-wide';
			d.style.cssText = 'position:absolute;left:0;top:0;width:1200px;height:4px';
			document.documentElement.style.overflowX = 'auto'; document.body.style.overflowX = 'auto';
			document.body.appendChild(d); }),
		() => page.evaluate(() => { const d = document.getElementById('selftest-wide'); if (d) d.remove();
			document.documentElement.style.overflowX = ''; document.body.style.overflowX = ''; }),
		{ check: 'h-scroll' });

	await run('overlap: slide one bottom-nav button over its neighbour',
		() => page.evaluate(() => { const b = document.querySelectorAll('#mnav button')[1];
			b.dataset.old = b.style.cssText; b.style.cssText += ';position:relative;left:-40px'; }),
		() => page.evaluate(() => { const b = document.querySelectorAll('#mnav button')[1]; b.style.cssText = b.dataset.old || ''; }),
		{ check: 'overlap' });

	await run('squeezed: shrink a bottom-nav label below its own text',
		() => page.evaluate(() => { const b = document.querySelectorAll('#mnav button')[2];
			b.dataset.old2 = b.style.cssText;
			b.style.cssText += ';white-space:nowrap;overflow:visible;width:8px;max-width:8px;flex:none'; }),
		() => page.evaluate(() => { const b = document.querySelectorAll('#mnav button')[2]; b.style.cssText = b.dataset.old2 || ''; }),
		{ check: 'squeezed' });

	asOverlays = await setState(page, 'drawer-folded');
	asState = 'drawer-folded';
	await run('tag filter: unfold the pool behind the disclosure row',
		() => page.evaluate(() => { const p = document.querySelector('#diamond-filter .tagf-pool');
			const t = document.querySelector('#diamond-filter .tagf-toggle');
			if (t && t.getAttribute('aria-expanded') !== 'true') t.click(); }),
		() => page.evaluate(() => { const t = document.querySelector('#diamond-filter .tagf-toggle');
			if (t && t.getAttribute('aria-expanded') === 'true') t.click(); }),
		{ check: 'tagfilter' });

	asOverlays = await setState(page, 'sheet-half');
	asState = 'sheet-half';
	console.log('  (sheet up for the shell self-test: '
		+ await page.evaluate(() => !!(window.DaimondSheet && DaimondSheet.isOpen())) + ')');
	await run('shell: shove the sheet foot down over the bottom bar',
		() => page.evaluate(() => { const m = document.getElementById('msheet');
			m.dataset.old = m.style.bottom; m.style.setProperty('bottom', '0px', 'important'); }),
		() => page.evaluate(() => { const m = document.getElementById('msheet'); m.style.bottom = m.dataset.old || ''; }),
		{ check: 'shell', sel: 'msheet', detail: 'overlaps the bar' });

	found.clear();
	return results;
}

// ── Main ────────────────────────────────────────────────────────────────────
const s = await boot();
const { page } = s;
await seed(s);
fs.mkdirSync(SHOTS, { recursive: true });

let selftestRows = [];
if (SELFTEST) {
	console.log('\nSELF-TEST — proving each check can go red\n');
	selftestRows = await selftest(page);
}

const palettes = QUICK ? SAMPLE : PALETTES;
const shots = [];
const safeArea = [];
const notch = new Map();
const cssSafe = await staticAudit(page);

console.log('\nSWEEP\n');
for (const size of SIZES) {
	await page.setViewportSize({ width: size.w, height: size.h });
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await sleep(500);
	const phone = size.w <= BREAK;
	const states = phone
		? ['chat', 'drawer-folded', 'drawer', 'sheet-half', 'sheet-full', 'files', 'mail', 'agents']
		: ['desktop'];

	for (const [skin, skinName] of SKINS) {
		await page.evaluate(k => window.DaimondSkin.set(k), skin);
		await sleep(200);
		for (const state of states) {
			const overlays = await setState(page, state);
			for (const palette of (size.w === 390 || size.w === 320 ? palettes : (QUICK ? SAMPLE : SAMPLE))) {
				await page.evaluate(p => window.DaimondTheme.set(p), palette);
				await sleep(90);
				const deep = palette === (QUICK ? SAMPLE : PALETTES)[0];
				const r = await page.evaluate(PROBE, { overlays, breakpoint: BREAK, deep });
				judge(r, { width: size.tag, palette, skin, state });
				for (const n of (r.inNotch || [])) notch.set(size.tag + '|' + state + '|' + n.side + '|' + n.sel, n);
			}
			// One screenshot per (width, skin, state) in a dark and a light palette.
			if (!QUICK && ['chat', 'drawer', 'sheet-half', 'sheet-full'].includes(state) || state === 'desktop') {
				for (const p of ['dark', 'lollypop']) {
					await page.evaluate(x => window.DaimondTheme.set(x), p);
					await sleep(120);
					const f = `${size.tag}-${skin}-${p}-${state}.png`;
					await page.screenshot({ path: path.join(SHOTS, f), timeout: 8000 }).catch(() => {});
					shots.push(f);
				}
			}
			// Safe-area: only where a fixed foot exists and only once per width/skin.
			if (phone && (state === 'sheet-full' || state === 'sheet-half')) {
				const g = await safeAreaPass(page, {});
				safeArea.push({ width: size.tag, skin, state, ...g });
			}
		}
		// The drawer must close and hand the page back.
		if (phone) {
			await setState(page, 'drawer');
			await page.evaluate(() => { const sc = document.getElementById('scrim'); if (sc) sc.click(); });
			await sleep(400);
			const after = await page.evaluate(() => ({
				open: document.body.classList.contains('drawer-open'),
				railL: Math.round(document.getElementById('panel-rail').getBoundingClientRect().left),
				scrimPE: getComputedStyle(document.getElementById('scrim')).pointerEvents,
				composer: (() => { const c = document.getElementById('chat-input'); if (!c) return 'absent';
					const st = getComputedStyle(c); return st.visibility + '/' + st.display; })(),
			}));
			if (after.open || after.railL > -10 || after.scrimPE !== 'none') {
				report({ check: 'shell', sel: '#scrim (close)', width: size.tag, palette: '(all)', skin, state: 'drawer-close',
					detail: `after a scrim tap: open=${after.open} railLeft=${after.railL} scrimPE=${after.scrimPE}` });
			}
			// And the sheet must hand the guest back to the stage.
			await setState(page, 'sheet-half');
			await page.evaluate(() => document.getElementById('msheet-close').click());
			await sleep(400);
			const back = await page.evaluate(() => {
				const el = document.getElementById('panel-web');
				return { inStage: !!(el && el.closest('#stage')), sheetOpen: !!(window.DaimondSheet && DaimondSheet.isOpen()),
					bodyClass: document.body.classList.contains('sheet-open'),
					composer: (() => { const b = document.querySelector('.ai .chat-input-bar'); return b ? getComputedStyle(b).visibility : 'absent'; })() };
			});
			if (!back.inStage || back.sheetOpen || back.bodyClass || back.composer !== 'visible') {
				report({ check: 'shell', sel: '#msheet-close', width: size.tag, palette: '(all)', skin, state: 'sheet-close',
					detail: `after closing: guestInStage=${back.inStage} sheetOpen=${back.sheetOpen} bodyClass=${back.bodyClass} composer=${back.composer}` });
			}
		}
		console.log(`  swept ${size.tag} ${skinName}`);
	}
}

// ── Safe-area judgement ─────────────────────────────────────────────────────
const safeFindings = [];
for (const a of safeArea) {
	if (!a.sheet || !a.mnav || !a.topbar) continue;
	if (a.sheet.t < a.topbar.b) {
		safeFindings.push(`${a.width} ${a.skin}: with a ${INSET}px bottom inset the FULL sheet's top is ${a.sheet.t}px, `
			+ `under the top bar (bottom ${a.topbar.b}px) — mobile.js maxH() spends 58px for the bar but the bar is ${a.mnav.h}px with the inset.`);
	}
	if (a.sheet.b > a.mnav.t + 1) {
		safeFindings.push(`${a.width} ${a.skin}: with a ${INSET}px inset the sheet foot (${a.sheet.b}) overlaps the bar top (${a.mnav.t}).`);
	}
	if (a.ask && a.state === 'sheet-half') {
		const h = a.ask.b - a.ask.t;
		if (h >= 61 + INSET - 1) {
			safeFindings.push(`${a.width} ${a.skin}: the ask pill grows from 61px to ${h}px with a ${INSET}px inset — `
				+ `.msheet-ask (mobile.css:218) spends safe-area-inset-bottom a SECOND time, although the sheet already `
				+ `stands ${INSET}px clear of the screen edge on top of the bar.  ${INSET}px of dead space inside the sheet.`);
		}
	}
}

// ── Write the evidence ──────────────────────────────────────────────────────
// The prose report (dev/sweep_mobile_report.md) is written by hand from this:
// a suggested fix is a judgement, and a generator that invents one would be
// padding.  Everything here is measurement, and re-running overwrites only
// measurement.
const rows = [...found.values()];
const SEV = { 'h-scroll': 0, 'off-right': 1, 'off-top': 2, 'overlap': 3, 'squeezed': 4, 'obscured': 5,
	'overlay': 6, 'shell': 7, 'target<24': 8, 'tagfilter': 9, 'contrast': 10, 'target<44': 11 };
const roll = new Map();
for (const r of rows) {
	const k = r.check + '|' + r.sel;
	const e = roll.get(k) || { check: r.check, sel: r.sel, widths: new Set(), skins: new Set(),
		states: new Set(), palettes: new Set(), details: new Set(), byPalette: {} };
	e.widths.add(r.width); e.skins.add(r.skin); e.states.add(r.state);
	r.palettes.forEach(p => e.palettes.add(p));
	if (r.detail) e.details.add(r.detail);
	Object.assign(e.byPalette, r.byPalette || {});
	roll.set(k, e);
}
const rolled = [...roll.values()].sort((a, b) => SEV[a.check] - SEV[b.check] || a.sel.localeCompare(b.sel));
const hard = rolled.filter(r => r.check !== 'target<44');
const soft = rolled.filter(r => r.check === 'target<44');

const spacings = (set) => [...set].map(x => x === 'sharp' ? 'Compact' : 'Breathe').join(', ');
const pal = (set) => set.size >= palettes.length ? 'all ' + palettes.length : [...set].join(', ');

const L = [];
L.push('# Sweep evidence — phone and narrow widths');
L.push('');
L.push('Generated by `dev/verify_sweep_mobile.mjs`. The read-and-judge report is');
L.push('`dev/sweep_mobile_report.md`; this file is the raw measurement behind it.');
L.push('');
L.push(`Run ${new Date().toISOString().slice(0, 16).replace('T', ' ')} against \`${APP}\`.`);
L.push(`${probes} probes over ${SIZES.length} widths × ${SKINS.length} spacings × ${palettes.length} palettes,`);
L.push('in a `hasTouch: true` context so `(pointer: coarse)` and `(hover: none)` match.');
L.push('');
L.push('Widths: ' + SIZES.map(z => `${z.tag} (${z.note})`).join('; ') + '.');
L.push('');
if (selftestRows.length) {
	L.push('## Checks proved red');
	L.push('');
	L.push('| broken deliberately | check fired |');
	L.push('| --- | --- |');
	for (const t of selftestRows) L.push(`| ${t.name} | ${t.red ? 'yes — ' + (t.saw[0] || '') : '**NO — the check is blind**'} |`);
	L.push('');
}
L.push('## Findings');
L.push('');
if (!hard.length) L.push('_None._');
for (const r of hard) {
	L.push(`### \`${r.check}\` — \`${r.sel}\``);
	L.push('');
	L.push(`- widths: ${[...r.widths].join(', ')}`);
	L.push(`- spacings: ${spacings(r.skins)}`);
	L.push(`- states: ${[...r.states].join(', ')}`);
	L.push(`- palettes: ${pal(r.palettes)}`);
	if (Object.keys(r.byPalette).length > 1 && r.check === 'contrast') {
		for (const [k, v] of Object.entries(r.byPalette)) L.push(`- ${k}: ${v}`);
	} else {
		for (const d of [...r.details].slice(0, 4)) L.push(`- ${d}`);
	}
	L.push('');
}
L.push('## Under 44×44 (advisory, WCAG AAA / platform guidance)');
L.push('');
L.push('| control | smallest seen | widths |');
L.push('| --- | --- | --- |');
for (const r of soft) {
	const sizes = [...r.details].map(d => d.replace(' px', ''));
	L.push(`| \`${r.sel}\` | ${sizes.sort()[0] || ''} | ${[...r.widths].join(' ')} |`);
}
L.push('');
L.push('## Safe-area insets');
L.push('');
L.push('`' + (cssSafe.viewport || '(no viewport meta)') + '`');
L.push('');
for (const side of ['top', 'right', 'bottom', 'left']) {
	const u = cssSafe.sides[side];
	L.push(`- \`safe-area-inset-${side}\`: ${u.length ? u.length + ' declaration(s) — ' + u.join(' | ') : '**never used**'}`);
}
L.push('');
L.push(`Geometry re-measured with a ${INSET}px bottom inset injected into exactly those declarations:`);
L.push('');
if (!safeFindings.length) L.push('- nothing moved.');
for (const f of safeFindings) L.push('- ' + f);
L.push('');
if (notch.size) {
	L.push('## Controls in the landscape notch strip (left/right 44px)');
	L.push('');
	const byWidth = new Map();
	for (const [k, v] of notch) {
		const w = k.split('|')[0];
		(byWidth.get(w) || byWidth.set(w, new Set()).get(w)).add(v.side + ' ' + v.sel + ' @x=' + v.left);
	}
	for (const [w, set] of byWidth) L.push(`- ${w}: ${[...set].join('; ')}`);
	L.push('');
}
L.push('## Screenshots');
L.push('');
L.push(`\`dev/shots/sweepm/\` — ${shots.length} files, \`<width>-<skin>-<palette>-<state>.png\`.`);
L.push('');
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
fs.writeFileSync(path.join(HERE, 'results', 'sweep_mobile_raw.md'), L.join('\n'));
fs.writeFileSync(path.join(HERE, 'results', 'sweep_mobile.json'),
	JSON.stringify({ rolled: rolled.map(r => ({ ...r, widths: [...r.widths], skins: [...r.skins],
		states: [...r.states], palettes: [...r.palettes], details: [...r.details] })),
		safeFindings, cssSafe, notch: [...notch.values()], shots }, null, 1));

console.log(`\n${hard.length} findings + ${soft.length} advisory, over ${probes} probes; ${shots.length} screenshots.`);
for (const r of hard) console.log(`  ${r.check.padEnd(11)} ${r.sel}  [${[...r.widths].join(' ')}]`);
console.log(`\nevidence: ${path.join(HERE, 'results', 'sweep_mobile_raw.md')}`);
await s.browser.close();
