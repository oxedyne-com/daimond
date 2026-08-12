// Two classes of defect, measured in the page rather than read off a stylesheet.
//
//   FOCUS. A ring drawn with `:focus` paints for a MOUSE click as well as a Tab.
//   The ring means "the keyboard is here"; painting it when the pointer put it
//   there says something that is not true, and the app's own convention -- 40-odd
//   `:focus-visible` rules -- is the other way. So every control named below is
//   driven twice, once with a real `page.mouse.click` and once with a real
//   `page.keyboard.press('Tab')`, and the ring that PAINTS is compared. A rule
//   grepped out of the CSS proves nothing about what the cascade resolved to.
//   The second half of the same check is the opposite fault: a focusable control
//   whose focused paint is identical to its resting paint has no indicator at
//   all, which is worse than the wrong one.
//
//   INK. Every visible run of text, in every palette, at both spacings, against
//   the background actually composited under it, held to the WCAG floor its own
//   size and weight earns (4.5, or 3.0 for large text). dev/verify_theme.mjs
//   measures the DECLARED hex of the palette tokens; that cannot see a token
//   drawn on a surface no palette pairs it with, a rule that puts `opacity` over
//   a token, or a hardcoded colour. This measures what Chromium painted.
//
// Run: eval "$(bash dev/world.sh 9 --env)"; node dev/verify_focus_and_ink.mjs
//   --quick        two palettes rather than eleven
//   --self         run only the self-tests (the red proofs)

// The pictures live in dev/shots_focus_and_ink.mjs -- this file measures and
// says so in words; nothing here writes an image.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const QUICK = process.argv.includes('--quick');
const SELF  = process.argv.includes('--self');
const PALETTES = QUICK
	? ['light', 'dark']
	: ['light', 'mist', 'linen', 'lollypop', 'sage', 'dusk', 'dark', 'amber', 'midnight', 'forest', 'plum'];
const SPACINGS = ['sharp', 'warm'];

const log = (...a) => console.log(...a);
let bad = 0;
const check = (ok, what) => { log(`${ok ? 'PASS ' : 'FAIL '} ${what}`); if (!ok) bad++; return ok; };

/// Shortfalls that are REPORTED rather than failed, because the remedy is a
/// decision about the design and not a number anyone can compute.
///
/// `#autoreload.ar-off .ar-field { opacity: 0.55 }` (autoreload.css) dims the
/// three auto-reload fields while auto-reload is off. Its own comment says they
/// "stay editable, so it can be set up and then switched on" -- so these are
/// live controls, and WCAG's exemption for a disabled control does not reach
/// them. The labels read 2.33 (Light) and 2.90 (Dark); the hints 2.19 and 2.35.
/// Opacity cannot be the fix: it takes about 0.9 before the words clear 4.5, and
/// 0.9 is not a dim. Every real answer -- move the dim onto the boxes, drop the
/// ink a rung instead, state "off" some other way -- changes what "off" LOOKS
/// like, which is the author's call. Recorded here so the run stays honest and
/// green; a NEW shortfall, or one of these getting worse, still fails.
///
/// These two are only re-measured when the Credits view can be reached, which
/// needs the profile to have a gateway account; a fresh harness profile has
/// none, and the run says UNAVAILABLE rather than pretending it looked.
///
/// A THIRD instance of the same class is not in this table because this file
/// cannot reach it: `:root[data-skin="warm"] .top-meter { opacity: 0.6 }`
/// (skin-warm.css) quietens the always-on stats line, which computes to
/// 2.55-3.80 for `--text-secondary` and 2.38-3.15 for its `.sep`. The element is
/// empty under the mock, so there is no text to measure and the sweep is
/// honestly silent about it. That is the standing limit of an audit like this:
/// it can only weigh ink that is on the screen at the moment it looks.
const RECORDED = {
	'div#autoreload > div.ar-field > label.ar-label': 2.19,
	'div#autoreload > div.ar-field > div.ar-hint':    2.19,
};
const DRIFT = 0.03;

// ── What the page is asked, for both halves ──────────────────────────────
//
// One stringified function so nothing here can drift from what the browser
// resolved. `PAINT` reads the marks a control makes outside its own fill --
// outline, box-shadow, border, background -- which together are the whole of
// what a focus indicator can be in this app.
const PAINT = function (sel) {
	const el = document.querySelector(sel);
	if (!el) return null;
	const c = getComputedStyle(el);
	return {
		outline:  `${c.outlineStyle} ${c.outlineWidth} ${c.outlineColor} @${c.outlineOffset}`,
		shadow:   c.boxShadow,
		border:   `${c.borderTopWidth} ${c.borderTopStyle} ${c.borderTopColor}`,
		bg:       c.backgroundColor,
		focused:  document.activeElement === el,
		// Whether the UA thinks this is a keyboard focus. Chromium answers
		// `:focus-visible` honestly, and it is the thing the whole defect is
		// about, so it is recorded beside the paint rather than inferred from it.
		fv:       el.matches(':focus-visible'),
	};
};

/// True when two paint readings differ in anything a reader could see.
const differs = (a, b) => !a || !b
	|| a.outline !== b.outline || a.shadow !== b.shadow
	|| a.border !== b.border || a.bg !== b.bg;

/// Whether a reading carries a real ring -- an outline or a shadow with width.
const hasRing = (p) => !!p && (
	(p.outline && !/^none /.test(p.outline) && !/ 0px /.test(p.outline))
	|| (p.shadow && p.shadow !== 'none'));

// ── The ink audit, in the page ───────────────────────────────────────────
const INK = function () {
	const num = (v) => parseFloat(v) || 0;
	const parseCol = (s) => {
		if (!s) return null;
		const m = s.match(/rgba?\(([^)]+)\)/);
		if (!m) return null;
		const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
		return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
	};
	/// `top` composited over `base`, both premultiplied out to opaque.
	const over = (top, base) => ({
		r: top.r * top.a + base.r * (1 - top.a),
		g: top.g * top.a + base.g * (1 - top.a),
		b: top.b * top.a + base.b * (1 - top.a),
		a: 1,
	});
	const lum = (c) => {
		const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
		return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
	};
	const ratio = (a, b) => {
		const L1 = lum(a), L2 = lum(b);
		return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
	};
	/// The opacity every ancestor has already multiplied onto this element. An
	/// `opacity` on a parent dims the text AND its own background equally, but
	/// not the surface further up, so it has to be carried into both sides.
	const chainAlpha = (el) => {
		let a = 1;
		for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
			a *= num(getComputedStyle(e).opacity);
		}
		return a;
	};
	/// What is actually behind `el`: the first opaque background up the tree,
	/// with every translucent one composited onto it on the way down.
	const painted = (el) => {
		const stack = [];
		for (let e = el; e; e = e.parentElement) {
			const c = getComputedStyle(e);
			if (c.backgroundImage && c.backgroundImage !== 'none') return null;	// a gradient is not one colour
			const col = parseCol(c.backgroundColor);
			if (col && col.a > 0) stack.push(col);
			if (col && col.a >= 0.999) break;
		}
		const rootBg = parseCol(getComputedStyle(document.documentElement).backgroundColor);
		let acc = (rootBg && rootBg.a >= 0.999) ? rootBg : { r: 255, g: 255, b: 255, a: 1 };
		for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
		return acc;
	};
	const sel = (el) => {
		const bit = (e) => {
			if (e.id) return e.tagName.toLowerCase() + '#' + e.id;
			const cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
			return e.tagName.toLowerCase() + cls.map((c) => '.' + c).join('');
		};
		const p = [];
		for (let e = el; e && e !== document.body && p.length < 3; e = e.parentElement) p.unshift(bit(e));
		return p.join(' > ');
	};
	const drawn = (el) => {
		const c = getComputedStyle(el);
		if (c.visibility === 'hidden' || c.display === 'none') return null;
		const r = el.getBoundingClientRect();
		if (r.width < 1 || r.height < 1) return null;
		if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return null;
		return r;
	};

	const out = [];
	for (const el of document.querySelectorAll('*')) {
		const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
		if (!own) continue;
		if (!drawn(el)) continue;
		const c = getComputedStyle(el);
		const size = num(c.fontSize);
		if (size < 4) continue;
		if (c.webkitTextFillColor && c.webkitTextFillColor !== c.color) continue;	// gradient ink
		if (/text/.test(c.webkitBackgroundClip || '') || /text/.test(c.backgroundClip || '')) continue;
		const a = chainAlpha(el);
		if (a < 0.05) continue;			// effectively not painted
		const bgOpaque = painted(el);
		if (!bgOpaque) continue;
		const fgRaw = parseCol(c.color);
		if (!fgRaw) continue;
		// The chain alpha dims the ink towards the surface behind the whole
		// chain, which for a dimmed label IS the reader's experience of it.
		const fg = over({ ...fgRaw, a: Math.min(1, fgRaw.a * a) }, bgOpaque);
		const cr = ratio(fg, bgOpaque);
		// WCAG 2.2 SC 1.4.3: 3.0 for large text -- 24px, or 18.66px at 700+ --
		// and 4.5 for everything else.
		const wt = parseInt(c.fontWeight, 10) || 400;
		const large = size >= 24 || (size >= 18.66 && wt >= 700);
		const floor = large ? 3.0 : 4.5;
		if (cr >= floor) continue;
		out.push({
			sel: sel(el),
			cr: +cr.toFixed(2),
			floor,
			size: +size.toFixed(1),
			colour: c.color,
			alpha: +a.toFixed(2),
			text: (el.textContent || '').trim().slice(0, 36),
		});
	}

	// ── Placeholders ─────────────────────────────────────────────────
	// A placeholder is not a decoration: it is the sentence telling a person
	// what the field wants, and SC 1.4.3 exempts it from nothing. It also has
	// no text node, so the walk above cannot see it -- which is exactly how one
	// rule in this app came to dim a placeholder with `opacity: .7` and sit at
	// 3.00 in the light band while every measurement said the app was clean.
	for (const el of document.querySelectorAll('input[placeholder], textarea[placeholder]')) {
		if (!drawn(el)) continue;
		if (el.value) continue;					// a filled field shows no placeholder
		const ph = getComputedStyle(el, '::placeholder');
		const fgRaw = parseCol(ph.color);
		if (!fgRaw) continue;
		const size = num(ph.fontSize) || num(getComputedStyle(el).fontSize);
		const a = chainAlpha(el) * (num(ph.opacity) || 1);
		const bgOpaque = painted(el);
		if (!bgOpaque || a < 0.05) continue;
		const fg = over({ ...fgRaw, a: Math.min(1, fgRaw.a * a) }, bgOpaque);
		const cr = ratio(fg, bgOpaque);
		const wt = parseInt(ph.fontWeight, 10) || 400;
		const floor = (size >= 24 || (size >= 18.66 && wt >= 700)) ? 3.0 : 4.5;
		if (cr >= floor) continue;
		out.push({
			sel: sel(el) + '::placeholder',
			cr: +cr.toFixed(2),
			floor,
			size: +size.toFixed(1),
			colour: ph.color,
			alpha: +a.toFixed(2),
			text: (el.getAttribute('placeholder') || '').slice(0, 36),
		});
	}
	return out;
};

// ── Open ─────────────────────────────────────────────────────────────────
const s = await open({ name: 'focusink' });
const page = s.page;
const calm = async () => { await page.waitForTimeout(250); };

const setLook = async (pal, sp) => {
	await page.evaluate(({ pal, sp }) => {
		window.DaimondTheme.set(pal);
		window.DaimondSkin.set(sp);
	}, { pal, sp });
	await page.waitForTimeout(400);
};

/// Shut the Admin drawer if it is open, then open it fresh on its HOME view.
///
/// Every drawer scene starts here, because none of the ways in are idempotent:
/// `#user-row` toggles the drawer, the provider head toggles its provider, and
/// the rows that lead to Models and Credits only exist ON the home view -- so a
/// scene entered a second time from wherever the last one left off navigates
/// somewhere else entirely, and does it silently. Two runs of this file reported
/// a clean Credits view that was in fact the Admin home.
const drawerHome = async () => {
	for (let i = 0; i < 3; i++) {
		const open = await page.evaluate(() => {
			const el = document.getElementById('admin-scroll');
			return !!(el && el.offsetParent);
		}).catch(() => false);
		if (!open) break;
		await page.keyboard.press('Escape').catch(() => {});
		await page.waitForTimeout(250);
	}
	await page.click('#user-row', { force: true }).catch(() => {});
	await page.waitForTimeout(450);
};

// The scenes that hold the controls and the labels in question. Deliberately
// few: this verifier is about two classes, not a whole-app sweep.
const SCENES = {
	work: async () => {
		await calm();
		await page.evaluate(() => {
			try { ['tools', 'graph', 'web'].forEach((p) => DaimondPanels.hide(p)); } catch (e) {}
			const d = document.querySelector('.diamond-box');
			if (d) d.click();
		});
		await page.waitForTimeout(400);
	},
	// The Models view with ONE PROVIDER OPEN. The provider's credit block is
	// where the app's most dimmed placeholder lives, and it is built only inside
	// an expanded provider -- a scene that stops at the provider list has not
	// been to the place worth looking. The add-provider form is deliberately NOT
	// raised: it replaces the provider list, taking the credit block and every
	// field note off screen with it.
	models: async () => {
		await calm();
		await drawerHome();
		await page.click('#astat-model', { force: true }).catch(() => {});
		await page.waitForTimeout(1000);
		await page.evaluate(() => {
			if (document.querySelector('.models-credit')) return;
			const h = document.querySelector('.models-prov-head');
			if (h) h.click();
		});
		await page.waitForTimeout(900);
		// A drawer is a scroller: an element can exist, be laid out, and still be
		// below the fold -- where the audit rightly ignores it, because nobody
		// can read it there either. Bringing it into view is part of arriving.
		await page.evaluate(() => {
			const el = document.querySelector('.models-credit-input');
			if (el) el.scrollIntoView({ block: 'center' });
		});
		await page.waitForTimeout(350);
	},
	menu: async () => {
		await calm();
		await page.keyboard.press('Escape').catch(() => {});
		await page.click('#settings-menu-btn', { force: true }).catch(() => {});
		await page.waitForTimeout(350);
	},
	// The long lists and the panels: where the quiet rung carries whole notes.
	tools: async () => {
		await calm();
		await page.evaluate(() => { try { DaimondPanels.show('tools'); } catch (e) {} });
		await page.waitForTimeout(600);
	},
	graph: async () => {
		await calm();
		await page.evaluate(() => { try { DaimondPanels.show('graph'); } catch (e) {} });
		await page.waitForTimeout(700);
	},
	chat: async () => {
		await calm();
		await page.evaluate(() => {
			const c = document.querySelector('#session-list .session-box');
			if (c) c.click();
		});
		await page.waitForTimeout(450);
	},
	// The Credits view. Its own view, not part of Models -- and the reason it is
	// listed separately is that the app's lowest-contrast text lived here and no
	// scene reached it.
	credits: async () => {
		await calm();
		await drawerHome();
		// The Credits row, matched on `.astat-btn` and nothing wider. A looser
		// query over `[data-view]` picked up the boot script -- whose text
		// happens to contain the word -- and clicked that instead, so the scene
		// silently never opened and the check that needed it silently passed.
		// Retried: the row is built once the account's gateway state is known,
		// which is not always before the drawer paints. A harness profile with no
		// gateway account never grows the row at all -- that is an account state,
		// not a navigation failure, and it is reported as such below rather than
		// counted as a scene that went somewhere else.
		let hit = false;
		for (let i = 0; i < 4 && !hit; i++) {
			hit = await page.evaluate(() => {
				for (const el of document.querySelectorAll('.astat-row.astat-btn')) {
					if (/credit/i.test(el.textContent || '')) { el.click(); return true; }
				}
				return false;
			}).catch(() => false);
			if (!hit) await page.waitForTimeout(500);
		}
		if (!hit) unavailable.add('credits');
		await page.waitForTimeout(1000);
		await page.evaluate(() => {
			const el = document.getElementById('autoreload');
			if (el) el.scrollIntoView({ block: 'center' });
		});
		await page.waitForTimeout(350);
	},
};

/// What must be on screen for a scene to have arrived. A scene that quietly
/// lands somewhere else is the single commonest way an audit like this reports
/// "clean": it measured a view nobody asked for. Every entry is checked, and a
/// scene that does not arrive is named, loudly, in the run's output.
const SCENE_MARK = {
	work:    '.files-mode-chip',
	models:  '.models-credit-input',
	menu:    '#settings-menu .pop-head',
	tools:   '.tools-row, .tool-row, #panel-tools',
	graph:   '#panel-graph',
	chat:    '#chat-input',
	credits: '#autoreload',
};
const arrived = async (scene) => {
	const q = SCENE_MARK[scene];
	if (!q) return true;
	return page.evaluate((sel) => {
		for (const el of document.querySelectorAll(sel)) {
			const r = el.getBoundingClientRect();
			if (r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight) return true;
		}
		return false;
	}, q).catch(() => false);
};
const missed = new Set();
/// Scenes this account genuinely cannot show. Kept apart from `missed`: a view
/// that does not exist for this profile is not the same fault as a view that
/// exists and was navigated past, and conflating them would either fail every
/// run or excuse the navigation bug.
const unavailable = new Set();

// Escape, and nothing else. An earlier version REMOVED `.modal` nodes from the
// document to be sure a scene started clean, which quietly deleted the Admin
// drawer's own markup -- so every later scene that reopened it got a partly
// rebuilt view, and the one control this file most needed to reach (the credit
// field, inside an expanded provider) was never there. A scene setup that
// damages the app is not a scene setup.
const closeAll = async () => {
	await page.keyboard.press('Escape').catch(() => {});
	await page.waitForTimeout(120);
	await page.keyboard.press('Escape').catch(() => {});
	await page.waitForTimeout(200);
};

// ── Half one: the focus indicator ────────────────────────────────────────
//
// A control is clicked with a real mouse at its own centre, then blurred, then
// reached with a real Tab. Both readings are taken from the page.
//
// THE POINTER IS PARKED before every reading. A `page.mouse.click` leaves the
// cursor sitting on the control, so `:hover` is live in the "after a click"
// reading and a hover rule reads as a focus ring. The first run of this file
// reported `#astat-model` -- a `:focus-visible` control, correctly written --
// as painting a ring for the mouse, and that was the whole of the reason.
const PARK = { x: 4, y: 4 };

async function mouseThenKey(sel) {
	const box = await page.evaluate((q) => {
		const el = document.querySelector(q);
		if (!el) return null;
		const r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2) return null;
		if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return null;
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}, sel);
	if (!box) return null;

	// Resting: nothing focused, pointer parked.
	await page.mouse.move(PARK.x, PARK.y);
	await page.evaluate(() => document.activeElement && document.activeElement.blur());
	await page.waitForTimeout(90);
	const rest = await page.evaluate(PAINT, sel);

	// A real pointer press at the control's own centre, then the pointer moved
	// off it before the paint is read.
	// NOT FOLLOWED BY A KEY PRESS. Chromium's `:focus-visible` heuristic is that
	// any keyboard interaction promotes whatever is focused, so an Escape sent
	// to shut a <select>'s popup makes the clicked control match
	// `:focus-visible` and the reading claims a keyboard focus that never
	// happened. That is precisely how this file first reported every field and
	// select as "Chromium says :focus-visible on a click": the Escape was mine.
	await page.mouse.click(box.x, box.y);
	await page.waitForTimeout(90);
	await page.mouse.move(PARK.x, PARK.y);
	await page.waitForTimeout(120);
	const mouse = await page.evaluate(PAINT, sel);

	// A real Tab. Focus is put on the control's PREVIOUS tab stop and Tab is
	// pressed, so the UA's own keyboard heuristic is what lands focus here --
	// `el.focus()` does not set `:focus-visible` and would prove nothing.
	await page.evaluate(() => document.activeElement && document.activeElement.blur());
	await page.waitForTimeout(60);
	await page.evaluate((q) => {
		const el = document.querySelector(q);
		if (el) el.focus({ preventScroll: true });
	}, sel);
	await page.keyboard.press('Shift+Tab');
	await page.waitForTimeout(80);
	await page.keyboard.press('Tab');
	await page.waitForTimeout(140);
	let key = await page.evaluate(PAINT, sel);
	// If the Shift+Tab / Tab pair did not land back here -- a scroller can move
	// under it, and a menu can rebuild -- the reading is not evidence and is
	// reported as such rather than counted as "no ring".
	return { rest, mouse, key, landed: !!(key && key.focused), clicked: !!(mouse && mouse.focused) };
}

/// The controls to ask about, derived FROM THE STYLESHEETS rather than typed
/// out: every selector in `www/css/*.css` that carries a bare `:focus`, plus
/// the `:focus-visible` rules, so the two conventions are measured side by side
/// and a rule added later is covered without editing this file.
function focusSelectors() {
	const dir = path.join(HERE, '..', 'www', 'css');
	const rows = [];
	for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.css'))) {
		const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
		for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
			const body = m[2];
			for (const part of m[1].split(',')) {
				const t = part.trim();
				if (!/:focus(?![-\w])/.test(t)) continue;
				if (/::/.test(t)) continue;
				const base = t.replace(/:focus(?![-\w])/g, '');
				// Only rules that actually PAINT something matter here.
				if (!/outline|box-shadow|border|background|color/.test(body)) continue;
				rows.push({ file: f, sel: base.trim(), rule: t, body: body.trim().slice(0, 90) });
			}
		}
	}
	return rows;
}

const focusRows = [];
if (!SELF) {
	log('\n── focus: a real click beside a real Tab ───────────────────────────');
	const wanted = focusSelectors();
	log(`  ${wanted.length} bare \`:focus\` rules that paint, across www/css/*.css`);
	await setLook('light', 'sharp');
	const seen = new Set();
	for (const scene of ['work', 'models', 'menu']) {
		await closeAll();
		await SCENES[scene]();
		for (const w of wanted) {
			if (seen.has(w.rule)) continue;
			const present = await page.evaluate((q) => {
				try {
					for (const el of document.querySelectorAll(q)) {
						const r = el.getBoundingClientRect();
						const c = getComputedStyle(el);
						if (r.width > 2 && r.height > 2 && c.visibility !== 'hidden'
							&& r.top < innerHeight && r.bottom > 0) return true;
					}
				} catch (e) { return false; }
				return false;
			}, w.sel).catch(() => false);
			if (!present) continue;
			seen.add(w.rule);
			const r = await mouseThenKey(w.sel);
			if (!r) continue;
			const mouseRing = differs(r.rest, r.mouse);
			const keyRing   = differs(r.rest, r.key);
			focusRows.push({ ...w, scene, mouseRing, keyRing, r });
			log(`  ${w.rule.slice(0, 40).padEnd(42)} ${scene.padEnd(7)}`
				+ ` click:${mouseRing ? 'RING' : '----'}${r.clicked ? '' : '?'}`
				+ `  tab:${keyRing ? 'RING' : '----'}${r.landed ? '' : '?'}`
				+ `  fv(click)=${r.mouse && r.mouse.fv}`);
		}
	}
	await closeAll();
	log('');
	for (const row of focusRows) {
		if (!row.r.landed) { log(`  n/a   ${row.rule} — Tab did not land back on it`); continue; }
		check(row.keyRing, `${row.rule} paints a ring for the keyboard`);
		// A control the UA itself calls keyboard-focused on a plain click --
		// every text field, by spec -- cannot be asked not to paint: it matches
		// `:focus-visible` either way, so the ring is the UA's decision.
		if (row.r.mouse && row.r.mouse.fv) {
			log(`  n/a   ${row.rule} — Chromium reports :focus-visible on a plain click, so`
				+ ' `:focus` and `:focus-visible` paint identically here');
			continue;
		}
		check(!row.mouseRing, `${row.rule} paints NO ring for a mouse click`);
	}
}

// ── Half one and a half: does every Tab stop SHOW itself? ────────────────
//
// The wrong ring is the lesser fault. This walks the page with a real Tab and,
// at each stop, compares the focused control's own paint with its own resting
// paint -- so a control with no indicator at all is named, whatever rule (or
// absence of one) put it there. Nothing is read from a stylesheet.
const tabDead = new Map();
if (!SELF) {
	log('\n── focus: every Tab stop, does it show itself? ──────────────────────');
	// Each stop is marked as it is visited, so the walk stops when Tab wraps
	// round to something it has already seen. Deduping on a CLASS NAME instead
	// ended the walk after six stops out of forty-odd, because a toolbar full of
	// `button.files-btn` looks like one element to a selector.
	const STEP = `(function () {
		const el = document.activeElement;
		if (!el || el === document.body) return null;
		const already = el.hasAttribute('data-walked');
		el.setAttribute('data-walked', '1');
		const read = () => {
			const c = getComputedStyle(el);
			return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.outlineOffset,
				c.boxShadow, c.borderTopWidth, c.borderTopStyle, c.borderTopColor,
				c.backgroundColor, c.color, c.textDecorationLine].join('|');
		};
		const bit = (e) => {
			if (e.id) return e.tagName.toLowerCase() + '#' + e.id;
			const cl = (e.getAttribute('class') || '').trim().split(/\\s+/).filter(Boolean).slice(0, 2);
			return e.tagName.toLowerCase() + cl.map((c) => '.' + c).join('');
		};
		const r = el.getBoundingClientRect();
		const focused = read();
		// Blur to read the resting paint, then put focus back exactly where the
		// Tab left it so the walk carries on from the same place.
		el.blur();
		const rest = read();
		el.focus({ preventScroll: true });
		return { sel: bit(el), already, same: focused === rest,
			onScreen: r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight };
	})()`;
	// Tab resumes from whatever was focused last, so a fresh walk has to put the
	// sequential-navigation starting point back at the top of the document --
	// otherwise the second walk over the same page silently starts halfway and
	// never reaches the elements the first one covered.
	const rewind = async () => page.evaluate(() => {
		document.querySelectorAll('[data-walked]').forEach((e) => e.removeAttribute('data-walked'));
		const b = document.body;
		b.setAttribute('tabindex', '-1');
		b.focus();
		b.removeAttribute('tabindex');
	});
	for (const scene of ['work', 'models', 'menu']) {
		await closeAll();
		await SCENES[scene]();
		await rewind();
		let stops = 0;
		for (let i = 0; i < 140; i++) {
			await page.keyboard.press('Tab');
			await page.waitForTimeout(30);
			let r;
			try { r = await page.evaluate(STEP); } catch (e) { break; }
			if (!r) continue;
			if (r.already) break;			// wrapped round
			stops++;
			if (r.same && r.onScreen) {
				const e = tabDead.get(r.sel) || { sel: r.sel, where: new Set() };
				e.where.add(scene);
				tabDead.set(r.sel, e);
			}
		}
		log(`  ${scene.padEnd(7)} ${stops} Tab stops visited`);
	}
	await closeAll();
	for (const d of tabDead.values()) log(`  DEAD  ${d.sel} — focused paint identical to resting [${[...d.where].join(',')}]`);
	check(tabDead.size === 0, `every on-screen Tab stop paints something (${tabDead.size} do not)`);
}

// ── Half two: the ink ────────────────────────────────────────────────────
const inkWorst = new Map();		// key -> worst finding
if (!SELF) {
	log('\n── ink: every visible text run, every palette, both spacings ────────');
	for (const pal of PALETTES) {
		for (const sp of SPACINGS) {
			await setLook(pal, sp);
			for (const [name, enter] of Object.entries(SCENES)) {
				await closeAll();
				await enter();
				if (!await arrived(name) && !unavailable.has(name)) missed.add(`${pal}/${sp}/${name}`);
				const found = await page.evaluate(INK);
				for (const f of found) {
					const key = f.sel + '§' + f.text;
					const prev = inkWorst.get(key);
					if (!prev || f.cr < prev.cr) inkWorst.set(key, { ...f, where: `${pal}/${sp}/${name}` });
				}
			}
		}
		log(`  ${pal.padEnd(9)} cumulative distinct shortfalls: ${inkWorst.size}`);
	}
	await closeAll();
	log('');
	const rows = [...inkWorst.values()].sort((a, b) => a.cr - b.cr);
	const fresh = [];
	for (const f of rows) {
		const rec = RECORDED[f.sel];
		const kind = rec === undefined ? 'NEW  ' : (f.cr < rec - DRIFT ? 'WORSE' : 'known');
		if (kind !== 'known') fresh.push(f);
		log(`  ${kind} ${String(f.cr).padStart(5)}:1 (floor ${f.floor})  ${f.sel}`
			+ `  ${f.size}px ${f.colour} α${f.alpha}  [${f.where}]  ${JSON.stringify(f.text)}`);
	}
	check(fresh.length === 0,
		`no text run below its WCAG floor that is not already recorded`
		+ ` (${rows.length} short, ${rows.length - fresh.length} recorded)`);
	for (const m of missed) log(`  MISSED SCENE  ${m} — it never arrived, so its text was not measured`);
	for (const u of unavailable) log(`  UNAVAILABLE   ${u} — this account never builds it; nothing it holds was measured`);
	check(missed.size === 0, `every scene that exists arrived where it meant to (${missed.size} did not)`);
}

// ── The proof that matters: the shipped defects, put back ────────────────
//
// A synthetic probe proves the audit can see A fault. This puts back the exact
// declarations that were here before, on the real elements, in the real scenes,
// and requires each one to be named. A check that has only ever been shown a
// probe of its author's own design has not been shown a regression.
const WAS = `
:root { --text-muted: #877D70; }
:root[data-theme="light"] { --text-muted: #787068; }
:root[data-theme="lollypop"] { --text-muted: #8A5E85; }
.files-mode-chip.ghost { opacity: 0.55; color: var(--text-secondary); }
.files-mode-chip.ghost .ic { opacity: 1; }
.settings-section .models-credit-input::placeholder { color: var(--text-secondary); opacity: .7; }
`;
{
	log('\n── putting the shipped defects back, one stylesheet ────────────────');
	const sweepOnce = async () => {
		const hits = [];
		for (const pal of ['light', 'dark']) {
			for (const scene of ['work', 'models', 'menu', 'credits']) {
				await setLook(pal, 'sharp');
				await closeAll();
				await SCENES[scene]();
				if (!await arrived(scene) && !unavailable.has(scene)) log(`   !! ${pal}/${scene} did not arrive — nothing it holds was measured`);
				for (const f of await page.evaluate(INK)) hits.push({ ...f, pal, scene });
			}
		}
		return hits;
	};
	await page.evaluate((css) => {
		const st = document.createElement('style');
		st.id = 'was-revert';
		st.textContent = css;
		document.head.appendChild(st);
	}, WAS);
	await page.waitForTimeout(250);
	const back = await sweepOnce();
	const shown = new Set();
	for (const f of back) {
		const k = f.sel + f.pal;
		if (shown.has(k)) continue;
		shown.add(k);
		log(`   red: ${f.cr}:1 (floor ${f.floor})  ${f.sel}  [${f.pal}/${f.scene}]  ${JSON.stringify(f.text)}`);
	}
	check(back.some((f) => /pop-note|pop-head|cfg-.*-note|dview-btn/.test(f.sel)),
		'the quiet rung at its old value is named again');
	check(back.some((f) => /files-mode-chip/.test(f.sel)),
		'the ghosted Cloud chip at its old opacity is named again');
	check(back.some((f) => /models-credit-input::placeholder/.test(f.sel)),
		'the dimmed placeholder at its old declaration is named again');
	await page.evaluate(() => { const e = document.getElementById('was-revert'); if (e) e.remove(); });
	await page.waitForTimeout(250);
	const now = await sweepOnce().then((h) => h.filter((f) => RECORDED[f.sel] === undefined));
	check(now.length === 0, `and silent again with the fixes in (${now.length} unrecorded findings)`);
	for (const f of now) log(`   still: ${f.cr}:1  ${f.sel}  [${f.pal}/${f.scene}]`);
}

// ── The red proofs ───────────────────────────────────────────────────────
//
// Neither half is trusted until it has been shown a fault built for it, in the
// real page, through the same code path.
log('\n── proving both halves red ─────────────────────────────────────────');
await closeAll();
await setLook('light', 'sharp');
await SCENES.work();

// 1. Ink: a label forced to a colour a hair off its own ground. If the audit
//    cannot see this it cannot see anything.
{
	const before = (await page.evaluate(INK)).length;
	await page.evaluate(() => {
		const st = document.createElement('style');
		st.id = 'ink-probe';
		// FIXED and inside the viewport. Appended to `body` in normal flow the
		// probe lands below `#app`, which is a full-height column, so it is off
		// screen -- `drawn()` correctly discards it and the probe proves nothing
		// except that the audit ignores what nobody can see. That is the exact
		// shape of the sweep's own focus-ring probe defect, and it caught this
		// file on its first run.
		st.textContent = '#probe-ink { position: fixed; left: 20px; top: 240px; z-index: 99999;'
			+ ' color: #F2F0EC; background: #FBF9F5; font-size: 13px; padding: 4px; }';
		document.head.appendChild(st);
		const d = document.createElement('div');
		d.id = 'probe-ink';
		d.textContent = 'a label nobody can read';
		document.body.appendChild(d);
	});
	await page.waitForTimeout(150);
	const after = await page.evaluate(INK);
	const caught = after.some((f) => f.sel.includes('probe-ink'));
	check(caught, 'ink audit goes red on a planted 1.05:1 label'
		+ (caught ? ` (${after.find((f) => f.sel.includes('probe-ink')).cr}:1)` : ''));
	await page.evaluate(() => {
		['ink-probe', 'probe-ink'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
	});
	await page.waitForTimeout(100);
	const restored = (await page.evaluate(INK)).length;
	check(restored === before, `ink audit returns to ${before} findings once the probe is gone (${restored})`);
}

// 2. Ink, the subtler half: a label dimmed by an ANCESTOR's opacity, which no
//    reading of the declared colour can see. The chain-alpha code is the only
//    thing that catches it, so it is proved separately.
{
	await page.evaluate(() => {
		const wrap = document.createElement('div');
		wrap.id = 'probe-dim';
		wrap.style.cssText = 'position:fixed; left:20px; top:300px; z-index:99999;'
			+ ' background:#FBF9F5; opacity:0.30; padding:6px;';
		wrap.innerHTML = '<span id="probe-dim-in" style="color:#211C18; font-size:13px">dimmed to nothing</span>';
		document.body.appendChild(wrap);
	});
	await page.waitForTimeout(150);
	const after = await page.evaluate(INK);
	const hit = after.find((f) => f.sel.includes('probe-dim'));
	check(!!hit, 'ink audit goes red on text dimmed by an ancestor opacity'
		+ (hit ? ` (${hit.cr}:1, α${hit.alpha})` : ''));
	await page.evaluate(() => { const e = document.getElementById('probe-dim'); if (e) e.remove(); });
	await page.waitForTimeout(100);
}

// 2b. The placeholder pass, proved on its own: a real field, given a real
//     `::placeholder` rule of the exact shape the one defective rule had
//     (a rung dimmed with `opacity`). The element walk cannot see this at all,
//     so nothing but this pass can go red on it.
{
	await page.evaluate(() => {
		const i = document.createElement('input');
		i.id = 'probe-ph';
		i.type = 'text';
		i.placeholder = 'what this field wants';
		i.style.cssText = 'position:fixed; left:20px; top:440px; z-index:99999; width:200px;'
			+ ' background:#FBF9F5; border:1px solid #999;';
		document.body.appendChild(i);
		const st = document.createElement('style');
		st.id = 'probe-ph-style';
		st.textContent = '#probe-ph::placeholder { color: #6B635A; opacity: 0.28; }';
		document.head.appendChild(st);
	});
	await page.waitForTimeout(150);
	const hit = (await page.evaluate(INK)).find((f) => f.sel.includes('probe-ph'));
	check(!!hit, 'ink audit goes red on a placeholder dimmed by `opacity`'
		+ (hit ? ` (${hit.cr}:1, α${hit.alpha})` : ''));

	await page.evaluate(() => {
		document.getElementById('probe-ph-style').textContent = '#probe-ph::placeholder { color: #6B635A; }';
	});
	await page.waitForTimeout(150);
	const gone = (await page.evaluate(INK)).find((f) => f.sel.includes('probe-ph'));
	check(!gone, '…and green once the same placeholder drops the `opacity`');
	await page.evaluate(() => {
		['probe-ph', 'probe-ph-style'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
	});
	await page.waitForTimeout(100);
}

// 3. Focus: a BUTTON given a `:focus` ring, which must be seen to paint for a
//    MOUSE click; the same button moved to `:focus-visible`, which must not;
//    and the same button with no rule at all, which must read as ringless.
//    Three directions on one element, because a check that had only ever seen
//    the wrong-ring case would pass a control that had no ring whatever.
//
//    A button, not a text field. Chromium matches `:focus-visible` on any
//    plain click of a control that takes keyboard input, so on an `<input>`
//    the two selectors paint identically and the probe could never go green.
//    That is measured below rather than asserted from the spec.
{
	await page.evaluate(() => {
		const b = document.createElement('button');
		b.id = 'probe-ring';
		b.textContent = 'ring';
		b.style.cssText = 'position:fixed; left:20px; top:360px; z-index:99999;';
		document.body.appendChild(b);
		const st = document.createElement('style');
		st.id = 'probe-ring-style';
		st.textContent = '#probe-ring:focus { outline: 3px solid #C00; outline-offset: 2px; }';
		document.head.appendChild(st);
	});
	await page.waitForTimeout(150);
	const wrong = await mouseThenKey('#probe-ring');
	check(!!wrong && differs(wrong.rest, wrong.mouse),
		'focus check goes red on a `:focus` ring painted by a mouse click');
	check(!!wrong && differs(wrong.rest, wrong.key),
		'focus check sees the same ring for the keyboard');

	await page.evaluate(() => {
		document.getElementById('probe-ring-style').textContent =
			'#probe-ring:focus { outline: none; } '
			+ '#probe-ring:focus-visible { outline: 3px solid #C00; outline-offset: 2px; }';
	});
	await page.waitForTimeout(150);
	const right = await mouseThenKey('#probe-ring');
	check(!!right && !differs(right.rest, right.mouse),
		'focus check goes GREEN once the same control uses `:focus-visible`');
	check(!!right && differs(right.rest, right.key),
		'…and still sees the keyboard ring');

	// 4. No indicator at all -- the worse fault. Both readings must be silent.
	await page.evaluate(() => {
		document.getElementById('probe-ring-style').textContent =
			'#probe-ring:focus, #probe-ring:focus-visible { outline: none; }';
	});
	await page.waitForTimeout(150);
	const none = await mouseThenKey('#probe-ring');
	check(!!none && !differs(none.rest, none.key),
		'focus check reports NO ring when a control has no indicator at all');
	check(!!none && hasRing(none.rest) === false, 'the ringless probe really has no ring at rest');

	await page.evaluate(() => {
		['probe-ring', 'probe-ring-style'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
	});

	// 5. The measurement the whole `:focus` question turns on: does Chromium
	//    call a plain click on a TEXT FIELD a keyboard focus? If it does, moving
	//    a field's rule from `:focus` to `:focus-visible` changes nothing that
	//    paints, and the report has to say so rather than claim a fix.
	await page.evaluate(() => {
		const i = document.createElement('input');
		i.id = 'probe-text';
		i.type = 'text';
		i.style.cssText = 'position:fixed; left:20px; top:400px; z-index:99999; width:160px;';
		document.body.appendChild(i);
		const st = document.createElement('style');
		st.id = 'probe-text-style';
		st.textContent = '#probe-text:focus { outline: none; } '
			+ '#probe-text:focus-visible { outline: 3px solid #C00; outline-offset: 2px; }';
		document.head.appendChild(st);
	});
	await page.waitForTimeout(150);
	const field = await mouseThenKey('#probe-text');
	log(`  note  a text field on a plain click: :focus-visible = ${field && field.mouse && field.mouse.fv},`
		+ ` ring painted = ${!!(field && differs(field.rest, field.mouse))}`);
	check(!!field && field.mouse.fv === true && differs(field.rest, field.mouse),
		'Chromium treats a plain click on a text field as keyboard focus, so `:focus-visible` still paints');
	await page.evaluate(() => {
		['probe-text', 'probe-text-style'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
	});
}

// 6. The Tab walk is a DIFFERENT code path from the click/Tab pair above, so it
//    is proved on its own: a focusable button that paints nothing when focused,
//    planted as the FIRST child of the rail's own list so the walk reaches it
//    while it is on screen. A probe the walk never visits, or visits below the
//    scrollport, would prove exactly nothing -- which is the shape of the fault
//    the desktop sweep's own ring probe was found to have.
{
	await page.evaluate(() => {
		const st = document.createElement('style');
		st.id = 'probe-dead-style';
		st.textContent = '#probe-dead:focus, #probe-dead:focus-visible { outline: none; }';
		document.head.appendChild(st);
		const b = document.createElement('button');
		b.id = 'probe-dead';
		b.textContent = 'no ring';
		const host = document.getElementById('session-list') || document.body;
		host.insertBefore(b, host.firstChild);
	});
	await page.waitForTimeout(200);
	const onScreen = await page.evaluate(() => {
		const e = document.getElementById('probe-dead');
		const r = e.getBoundingClientRect();
		return r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight;
	});
	check(onScreen, 'the ringless Tab-walk probe is planted ON SCREEN, where the walk can see it');

	const walkFor = async (id) => {
		// Same rewind as the walk itself: without it the second pass starts from
		// wherever the first one stopped and never reaches the probe again --
		// which is how this proof first "failed" on a probe that was fine.
		await page.evaluate(() => {
			const b = document.body;
			b.setAttribute('tabindex', '-1');
			b.focus();
			b.removeAttribute('tabindex');
		});
		const hits = [];
		for (let i = 0; i < 60; i++) {
			await page.keyboard.press('Tab');
			await page.waitForTimeout(25);
			const r = await page.evaluate(`(function () {
				const el = document.activeElement;
				if (!el || el === document.body) return null;
				const read = () => { const c = getComputedStyle(el);
					return [c.outlineStyle, c.outlineWidth, c.outlineColor, c.outlineOffset,
						c.boxShadow, c.borderTopWidth, c.borderTopStyle, c.borderTopColor,
						c.backgroundColor, c.color, c.textDecorationLine].join('|'); };
				const focused = read(); el.blur(); const rest = read(); el.focus({ preventScroll: true });
				return { id: el.id, same: focused === rest };
			})()`);
			if (r && r.id === id) { hits.push(r.same); break; }
		}
		return hits;
	};
	const found = await walkFor('probe-dead');
	check(found.length > 0 && found[0] === true,
		'the Tab walk goes red on a focusable control that paints nothing when focused');

	// The same probe given a real ring must NOT be flagged, or the check is just
	// "everything is dead".
	await page.evaluate(() => {
		document.getElementById('probe-dead-style').textContent =
			'#probe-dead:focus { outline: 3px solid #C00; outline-offset: 2px; }';
	});
	await page.waitForTimeout(150);
	const found2 = await walkFor('probe-dead');
	check(found2.length > 0 && found2[0] === false,
		'…and green once the same control draws one');

	await page.evaluate(() => {
		['probe-dead', 'probe-dead-style'].forEach((id) => { const e = document.getElementById(id); if (e) e.remove(); });
	});
}

await s.close();
log(`\n${bad ? `${bad} FAILED` : 'ALL PASS'}`);
process.exit(bad ? 1 : 0);
