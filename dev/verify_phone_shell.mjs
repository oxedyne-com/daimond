// gateway: none
// verify_phone_shell.mjs -- the phone's shell: the chat head and its menu, the drawer, the footer strip.
// Carry r529, lane H (plan ~/usr/code/ai/claude/specs/daimond_carry_r529_plan_20261001.md, section 4 H1 to H3).
//
// A phone chat head holds the title, the mode chip and ONE 44px control, "more". Concise, Copy, Steps, Expand and
// Select are rows of its menu, which is Help's menu (same `.pop`, same closer head, same row). The owner chose this
// shape on 2026-09-30 ("B: title, mode, one more menu"). Everything here runs at 390x844 with touch, and nothing is
// keyed on hover (headless Chromium reports `hover: none`, log P finding 3).
//
//   HD  the head           every control has a 44x44 tap cross, nothing scrolls or sits under a fade, nothing
//                          overlaps, the head is 52px on a chat and 96px on a Diamond or in select mode in every
//                          locale, the title is the same width at every length, and the mode chip and "more" keep one x
//   HM  the menu           "more" opens it, its rows are 44px in his order with visible labels in the locale, a row
//                          runs its action and closes the menu, a state row is filled, the dot shows, and Help's rows
//                          are drawn by the same rule
//   HK  the keyboard       Enter opens with focus on the first row, Tab stays inside, Escape closes and gives the
//                          focus back (Help the same)
//   HP  one popover        Help, "more" and the mode chip each open a popover under `stopPropagation`, so a tap on one
//                          while another was up left both open, lying over each other (QA1 F1): opening any one closes
//                          the others, and one Escape clears the screen
//   HX  the computer       at 1300x900 there is no "more", every tool is home, the menu is shut; crossing 760px with
//                          the menu open shuts it and sends the buttons home
//   DR  the drawer         showing a destination (New Chat, New Diamond, a chat, a footer chip) closes it; a tap that
//                          chooses nothing does not, and neither does a fan-out landing in the background
//   ST  the footer strip   every chip, once shown, stands clear of the fade at both ends, in all eight languages
//
// A section that cannot find what it tests fails ONCE, by name, and the rest of the run goes on: on the code before
// H1 there is no "more", so HM and HK each fail once for that reason, and HD fails for what 5.2.6 draws.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE. `--break <name>` serves a damaged file through `page.route` and runs the
// one section it damages (`--full` runs them all, to see the red stay in its own section). A break whose anchor no
// longer matches exactly once in its file stops the run (exit 2) and so cannot pass by damaging nothing.
//
//   eval "$(bash dev/world.sh N --env)"
//   RC_SLOT=<slot> node dev/verify_phone_shell.mjs [--only HD,HM] [--break scroll] [--full]
//   DAIMOND_BROWSER=webkit node dev/verify_phone_shell.mjs --only HD,HM
//
// Shots: $SHELL_SHOTS (default $DAIMOND_SCRATCH/phone_shell/shots), named <section>_<state>_<look>_<title>.png

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, errors, scratch, BROWSER, checker } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const J    = JSON.stringify;

// ── Breaks: exact anchors, each the smallest change that makes the section's own claim false ──────────────────
// `from` must occur exactly once in `file`, or the run stops. The head's shape is a CSS fact, so most are CSS.
const BREAKS = {
	// The head's right-hand cluster is a scroller again, as it was in 5.2.6: the strip scrolls and the tools
	// sit in it. Red where the head is measured, and nowhere else (the menu still opens).
	scroll: { section: 'HD', file: 'css/skin-daylight.css',
		from: ':root[data-skin="daylight"] .panel.ai .chead > :is(.chead-left, .chead-right) { display: contents; }',
		to:   ':root[data-skin="daylight"] .panel.ai .chead > .chead-left { display: contents; }\n'
			+ '\t:root[data-skin="daylight"] .panel.ai .chead > .chead-right { display: flex; flex: 0 1 100px; min-width: 0; overflow-x: auto; overflow-y: hidden; }',
		what: 'the right-hand cluster of the head is a strip that scrolls sideways again' },
	// The words go: a row is an icon with no word, as the head tools are.
	label:  { section: 'HM', file: 'css/app.css',
		from: '[data-menu="rows"] .btn-label { display: inline; font-size: var(--fs-sm); }',
		to:   '[data-menu="rows"] .btn-label { display: none; }',
		what: 'the menu rows lose their visible labels' },
	// Opening the menu leaves the focus where it was.
	focus:  { section: 'HK', file: 'js/workspace.js',
		from: 'if (first) first.focus();\t// the menu is opened by keyboard',
		to:   '',
		what: 'a menu opens without moving the focus into it' },
	// The strip's scroll padding is nothing again, so a chip brought in stands under the fade.
	fade:   { section: 'ST', file: 'css/mobile.css',
		from: 'scroll-padding-inline: var(--fade);',
		to:   'scroll-padding-inline: 0;',
		what: 'the footer strip scrolls a chip in with no padding, so it stands under the fade' },
	// Showing a destination no longer closes the drawer (`mshow` in daimond.js), as on 5.2.8.
	drawer: { section: 'DR', file: 'js/daimond.js',
		from: '\t\tif (window.DaimondShell) DaimondShell.closeDrawer();\n\t\tdocument.body.dataset.mpanel = name;',
		to:   '\t\tdocument.body.dataset.mpanel = name;',
		what: 'showing a destination leaves the drawer open over it' },
	// `openPop` no longer hides the other popovers, as before QA1 F1: the mode chip and "more" stand open together.
	pops:   { section: 'HP', file: 'js/workspace.js',
		from: '\t\tdismissPops(pop);\n\t\tpop.hidden = false;',
		to:   '\t\tpop.hidden = false;',
		what: 'opening a popover leaves the others open' },
	// Crossing 760px leaves the buttons in the menu.
	home:   { section: 'HX', file: 'js/workspace.js',
		from: '} else if (item.mark && b.parentNode === el) {',
		to:   '} else if (false) {',
		what: 'above 760px the folded buttons stay in the menu' },
};
const arg = (f) => { const i = process.argv.indexOf(f); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; };
const BREAK = arg('--break');
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
{
	const src = {}, stale = [];
	for (const [n, b] of Object.entries(BREAKS)) {
		src[b.file] = src[b.file] || fs.readFileSync(path.join(WWW, b.file), 'utf8');
		if (src[b.file].split(b.from).length !== 2) stale.push(n);
	}
	// A break whose anchor is not there YET (the code it damages is written after the check) is reported, not hidden,
	// and stops a run that asked for it.
	if (stale.length && BREAK && stale.includes(BREAK)) { console.error('break no longer matches exactly once: ' + BREAK); process.exit(2); }
	if (stale.length && process.argv.includes('--check-breaks')) { console.error('break(s) no longer match exactly once: ' + stale.join(', ')); process.exit(2); }
}
const ALL = 'HD,HM,HK,HP,HX,DR,ST';
const ONLY = new Set((arg('--only') || (BREAK && !process.argv.includes('--full') ? BREAKS[BREAK].section : ALL))
	.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
const on = (s) => ONLY.has(s);
const ROUTE = !BREAK ? null : async (page) => {
	const b = BREAKS[BREAK];
	const body = fs.readFileSync(path.join(WWW, b.file), 'utf8').replace(b.from, () => b.to);
	console.log(`\n*** BREAK ${BREAK}: ${b.what} — failures below are the point ***\n`);
	await page.route('**/' + b.file + '*', (r) => r.fulfill({ status: 200, contentType: b.file.endsWith('.css') ? 'text/css' : 'application/javascript', body }));
};

const { ok, bad, check } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Skip extends Error { constructor(m) { super(m); this.skip = true; } }
/// A surface this browser cannot be given: reported as NOT COVERED, never as a pass and never as a failure.
class NotCovered extends Error { constructor(m) { super(m); this.notCovered = true; } }
const NC = [];
const need = (c, m) => { if (!c) throw new Skip(m); };
async function section(name, fn) {
	if (!on(name)) return;
	console.log(`\n── ${name} ──`);
	try { await fn(); }
	catch (e) { check(`${name}: ${e.skip ? e.message : 'threw: ' + e.message}`, false, e.skip ? '' : String(e.stack || '').split('\n')[1] || ''); }
}

// ── The device ──────────────────────────────────────────────────────────────
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const SHOTS = process.env.SHELL_SHOTS || path.join(process.env.DAIMOND_SCRATCH || '.', 'phone_shell', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
let S = null, DESK = null;
const seenErrors = [];
async function letGo(s) { if (!s) return; try { const e = await errors(s); if (e && e.length) seenErrors.push(String(e[0]).slice(0, 160)); } catch (e) { /* none */ } await s.close().catch(() => {}); }
async function phone() {
	if (S) return S;
	S = await open({ name: 'shell', touch: true, ...(BROWSER === 'webkit' ? { ua: PHONE_UA } : { isMobile: true }), route: ROUTE });
	await S.page.setViewportSize({ width: 390, height: 844 });
	await sleep(1200);
	await clk('#admin-close'); await sleep(400);
	return S;
}
const ev = (f, a) => S.page.evaluate(f, a);
/// Click by script, not by pointer: used for set-up only, never for the thing under test.
const clk = (sel) => S.page.evaluate((q) => { const b = [...document.querySelectorAll(q)].find((e) => e.getClientRects().length) || document.querySelector(q); if (!b) return false; b.click(); return true; }, sel);
const shot = (name, clip) => S.page.screenshot({ path: path.join(SHOTS, name + '.png'), ...(clip ? { clip } : {}) }).catch(() => {});
/// A real tap at the centre of the first VISIBLE element matching `sel`, as a thumb would.
async function tap(sel) {
	const box = await S.page.evaluate((q) => {
		const e = [...document.querySelectorAll(q)].find((x) => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden');
		if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	}, sel);
	need(box, `nothing visible to tap for ${sel}`);
	await S.page.touchscreen.tap(box.x, box.y);
	await sleep(350);
}
async function wear(th) {
	await ev((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, th);
	await sleep(500);
}
async function locale(code) {
	await ev(async (c) => { await window.DaimondI18n.setLocale(c); }, code);
	await sleep(500);
}
const drawerOpen = () => ev(() => document.body.classList.contains('drawer-open'));
/// Take the drawer down the way a thumb does, so a state set-up never depends on H2.
async function closeDrawer() {
	if (await drawerOpen()) { await clk('#scrim'); await sleep(500); }
}
/// A chat with one answer in it, on screen, the drawer shut.
async function startChat() {
	await clk('#drawer-btn'); await sleep(500);
	await clk('#new-session-btn'); await sleep(600);
	(await clk('.tile-start')) || (await clk('.pending-centre .empty-new-session')); await sleep(800);
	await S.page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
	await closeDrawer();
	await chat(S, 'hello');
	await closeDrawer();
}
/// Back to a chat after a Diamond.
async function toChat() {
	const onChat = await ev(() => { const sw = document.getElementById('diamond-view'); return !(sw && sw.getClientRects().length) && !!document.querySelector('#chat-input'); });
	if (onChat) return;
	await clk('#drawer-btn'); await sleep(500);
	const ok1 = await ev(() => { const t = document.querySelector('#session-list .session-box'); if (!t) return false; (t.querySelector('.tile-label') || t).click(); return true; });
	if (!ok1) { await closeDrawer(); await startChat(); return; }
	await sleep(900); await closeDrawer();
}
async function toDiamond() {
	await clk('#drawer-btn'); await sleep(500);
	const ok1 = await ev(() => { const t = document.querySelector('.diamond-box'); if (!t) return false; (t.querySelector('.tile-label') || t).click(); return true; });
	// WebKit keeps no file store (CRF2), so no Diamond ever reaches the device: read the capability, as the gate's `webkitPair` does.
	if (!ok1 && (await ev(() => typeof (navigator.storage && navigator.storage.getDirectory))) !== 'function') throw new NotCovered('this browser has no origin file system, so no Diamond reaches the device');
	need(ok1, 'no Diamond in the drawer');
	await sleep(1600); await closeDrawer();
}
const setTitle = (t) => ev((t0) => { const e = document.querySelector('.panel.ai .chead .ctitle'); e.textContent = t0; e.title = t0; }, t);

// ── What the page is asked ───────────────────────────────────────────────────
/// In the page: every number the head's checks read. One call per cell, so a cell is one moment.
const MEASURE = () => {
	const head = document.querySelector('.panel.ai .chead');
	const ttl  = head.querySelector('.ctitle');
	const R    = (e) => { const r = e.getBoundingClientRect(); return { x: +r.left.toFixed(2), y: +r.top.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) }; };
	const shown = (e) => { const cs = getComputedStyle(e); return e.getClientRects().length > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
	const maskOf = (e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); const m = cs.maskImage || cs.webkitMaskImage; if (m && m !== 'none') return true; } return false; };
	/// The tap cross: out from the centre of the box along both axes at pixel centres (n + 0.5), while the point lands on
	/// the control or inside it, to the first miss or 30px. The same measure the gate uses.
	const cross = (e) => {
		const r = e.getBoundingClientRect();
		const cx = Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 0.01), cy = Math.min(Math.max(r.top + r.height / 2, 0), innerHeight - 0.01);
		const px = Math.floor(cx) + 0.5, py = Math.floor(cy) + 0.5;
		const hit = (x, y) => { if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false; const h = document.elementFromPoint(x, y); return !!h && (h === e || e.contains(h)); };
		if (!hit(px, py)) return { w: 0, h: 0 };
		let l = 0, rt = 0, u = 0, d = 0;
		while (l < 30 && hit(px - l - 1, py)) l++;
		while (rt < 30 && hit(px + rt + 1, py)) rt++;
		while (u < 30 && hit(px, py - u - 1)) u++;
		while (d < 30 && hit(px, py + d + 1)) d++;
		return { w: l + rt + 1, h: u + d + 1 };
	};
	const SEL = 'button, select, a[href], [role=button], input';
	const ctrls = [...head.querySelectorAll(SEL)].filter(shown);
	const out = ctrls.map((e) => ({ id: e.id || [...e.classList].slice(0, 2).join('.') || e.tagName, ...R(e), tap: cross(e), masked: maskOf(e) }));
	const ov = [];
	for (let a = 0; a < ctrls.length; a++) for (let b = a + 1; b < ctrls.length; b++) {
		if (ctrls[a].contains(ctrls[b]) || ctrls[b].contains(ctrls[a])) continue;
		const A = ctrls[a].getBoundingClientRect(), B = ctrls[b].getBoundingClientRect();
		const w = Math.min(A.right, B.right) - Math.max(A.left, B.left), h = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
		if (w > 0.5 && h > 0.5) ov.push(`${out[a].id}/${out[b].id} ${w.toFixed(1)}x${h.toFixed(1)}`);
	}
	const tr = ttl.getBoundingClientRect();
	const tov = out.filter((o, i) => { const c = ctrls[i]; if (ttl.contains(c) || c.contains(ttl)) return false; const A = c.getBoundingClientRect(); return Math.min(A.right, tr.right) - Math.max(A.left, tr.left) > 0.5 && Math.min(A.bottom, tr.bottom) - Math.max(A.top, tr.top) > 0.5; }).map((o) => o.id);
	// A scroller is an element that MAY scroll and DOES overflow; a fade is a mask or a data-more mark.
	const scrolls = [head, ...head.querySelectorAll('*')].filter((e) => {
		const cs = getComputedStyle(e); const ox = /auto|scroll/.test(cs.overflowX), oy = /auto|scroll/.test(cs.overflowY);
		return (ox && e.scrollWidth > e.clientWidth + 1) || (oy && e.scrollHeight > e.clientHeight + 1);
	}).map((e) => e.id || e.className);
	const marks = [...head.querySelectorAll('[data-more]')].map((e) => e.id || e.className);
	const chipTxt = document.getElementById('hand-mode-chip-txt');
	const more = document.getElementById('chead-more');
	return {
		head: R(head), title: { ...R(ttl), cut: ttl.scrollWidth > ttl.clientWidth + 1 },
		ctrls: out, overlaps: ov, titleOverlaps: tov, scrolls, marks,
		masked: out.filter((o) => o.masked).map((o) => o.id),
		hscroll: document.documentElement.scrollWidth > innerWidth,
		chip: chipTxt ? { ...R(document.getElementById('hand-mode-chip')), cut: chipTxt.scrollWidth > chipTxt.clientWidth + 1, txt: chipTxt.textContent } : null,
		more: more && shown(more) ? R(more) : null,
	};
};

// ── HD ──────────────────────────────────────────────────────────────────────
const TITLES = {
	short: 'Tax',
	mid:   'Compare the three joinery quotes',
	long:  'Compare every joinery, benchtop and splashback quote for the Leederville kitchen renovation and list their lead times.',
	vlong: 'Compare every joinery benchtop splashback and cabinetry quote for the Leederville kitchen renovation including appliance lead times, delivery windows, installation dependencies, warranty terms and payment schedules across suppliers.',
};
if (TITLES.long.length !== 118 || TITLES.vlong.length !== 232) { console.error('the long titles must be 118 and 232 characters'); process.exit(2); }
const LOOKS = ['obsidian', 'porcelain'];
const HEIGHT = { chat: 52, select: 96, crystal: 96, dchat: 96 };
const cells = [];		// every head measurement of the run, tagged
const lowTap = (c) => c.m.ctrls.filter((o) => o.tap.w < 44 || o.tap.h < 44);
async function cell(tag, extra = {}) {
	const m = await ev(MEASURE);
	const c = { ...tag, ...extra, m };
	cells.push(c);
	return c;
}
const where = (c) => [c.state, c.look, c.title, c.variant || c.locale].filter(Boolean).join('/');

/// The variant pass: the mode word at its longest, in English and in French.
const VARIANTS = {
	chat:   [['ask',  [['#hand-mode-chip-txt', 'Ask every time']]], ['frm', [['#hand-mode-chip-txt', 'Demander à chaque fois']]]],
	// Select mode's words in French and German are checked as the locales' own words, through t(), in the locale pass below.
};
async function gridState(state) {
	for (const look of LOOKS) {
		await wear(look);
		for (const [tk, t] of Object.entries(TITLES)) {
			await setTitle(t); await sleep(250);
			await cell({ state, look, title: tk });
			if (tk === 'mid' || tk === 'vlong') await shot(`HD_${state}_${look}_${tk}`, { x: 0, y: 0, width: 390, height: 190 });
		}
		for (const [vn, txt] of VARIANTS[state] || []) {
			const prev = await ev((a) => a.map(([q]) => document.querySelector(q).textContent), txt);
			for (const tk of ['mid', 'vlong']) {
				await setTitle(TITLES[tk]);
				await ev((a) => a.forEach(([q, v]) => { document.querySelector(q).textContent = v; }), txt);
				await sleep(250);
				await cell({ state, look, title: tk, variant: vn });
				await shot(`HD_${state}_${look}_${tk}_${vn}`, { x: 0, y: 0, width: 390, height: 190 });
			}
			await ev((a) => a[1].forEach(([q], i) => { document.querySelector(q).textContent = a[0][i]; }), [prev, txt]);
		}
	}
	// Every language, through t(): the head must be the same height in all eight, with the longest mode word in play.
	const codes = (await ev(() => window.DaimondI18n.locales().map((l) => l.code)));
	for (const look of LOOKS) {
		await wear(look);
		for (const code of codes) {
			await locale(code);
			// The mode word at its widest in this language, the way a user who chose it would see it.
			await ev(() => { try { const l = window.DaimondHandMode.list().slice().sort((a, b) => b.label.length - a.label.length)[0]; if (l) window.DaimondHandMode.set(l.name); } catch (e) { /* none */ } });
			if (state === 'dchat') await ev(() => { const b = document.getElementById('chat-fold-btn'); if (b) b.style.display = ''; });
			await setTitle(TITLES.mid); await sleep(300);
			await cell({ state, look, title: 'mid', locale: code });
			if (look === 'obsidian' && state === 'select') await shot(`HD_select_${code}`, { x: 0, y: 0, width: 390, height: 190 });
		}
	}
	await locale('en');
	await ev(() => { try { window.DaimondHandMode.set('guarded'); } catch (e) { /* none */ } });
	await sleep(300);
}

await section('HD', async () => {
	await phone();
	await startChat();
	await shot('HD_ctx_chat_start');
	await gridState('chat');
	await clk('#collapse-btn'); await sleep(500);			// the "−" latches select mode (HM drives the real row)
	need(await ev(() => !!document.querySelector('.panel.ai .chead.selecting')), 'select mode did not latch');
	await gridState('select');
	await clk('#collapse-btn'); await sleep(400);
	let diamond = true;
	try { await toDiamond(); } catch (e) { if (!e.notCovered) throw e; diamond = false; NC.push('HD: the crystal face, its full screen and the Diamond chat face (' + e.message + ')'); }
	if (diamond) {
	await gridState('crystal');
	// Full screen on the crystal face: the head keeps one control, the way back, and it is as easy to press as any.
	await tap('#crystal-full-btn'); await sleep(700);
	const fs1 = await ev(() => ({ on: document.documentElement.hasAttribute('data-cfull'), m: null }));
	const fm = await ev(MEASURE);
	await shot('HD_crystal_fullscreen', { x: 0, y: 0, width: 390, height: 190 });
	check('HD: in full screen the head keeps one control, the way back, with a tap cross of at least 44x44',
		fs1.on && fm.ctrls.length === 1 && fm.ctrls[0].tap.w >= 44 && fm.ctrls[0].tap.h >= 44 && !fm.hscroll && !fm.more, J({ on: fs1.on, ctrls: fm.ctrls.map((c) => [c.id, c.tap.w, c.tap.h]), more: !!fm.more }));
	await tap('#crystal-full-btn'); await sleep(600);
	need(await ev(() => !document.documentElement.hasAttribute('data-cfull')), 'full screen did not end');
	await clk('#dview-chat'); await sleep(900);
	await ev(() => { const b = document.getElementById('chat-fold-btn'); if (b) b.style.display = ''; });	// Fold shows once the daimon has spoken; the worst case is forced
	await sleep(200);
	await gridState('dchat');
	}

	if (process.env.SHELL_DUMP) fs.writeFileSync(process.env.SHELL_DUMP, J(cells));
	const grid = cells.filter((c) => !c.variant && !c.locale);
	console.log(`  (${cells.length} cells: ${grid.length} in the title grid, ${cells.filter((c) => c.variant).length} variants, ${cells.filter((c) => c.locale).length} locale cells)`);
	const list = (xs, f) => xs.slice(0, 5).map(f).join('; ') + (xs.length > 5 ? ` … ${xs.length} in all` : '');

	const lows = cells.flatMap((c) => lowTap(c).map((o) => ({ c, o })));
	check('HD: every head control has a tap cross of at least 44x44', lows.length === 0 && cells.every((c) => c.m.ctrls.length > 0),
		lows.length ? list(lows, ({ c, o }) => `${where(c)} ${o.id} ${o.tap.w}x${o.tap.h}`) : `${cells.reduce((n, c) => n + c.m.ctrls.length, 0)} controls in ${cells.length} cells`);
	const sc = cells.filter((c) => c.m.scrolls.length || c.m.marks.length || c.m.masked.length);
	check('HD: no element scrolls, and none sits under a fade', sc.length === 0, list(sc, (c) => `${where(c)} scrolls ${J(c.m.scrolls)} marks ${J(c.m.marks)} masked ${J(c.m.masked)}`));
	const hs = cells.filter((c) => c.m.hscroll);
	check('HD: the page does not scroll sideways', hs.length === 0, list(hs, where));
	const ovs = cells.filter((c) => c.m.overlaps.length || c.m.titleOverlaps.length);
	check('HD: no control overlaps another, or the title', ovs.length === 0, list(ovs, (c) => `${where(c)} ${J(c.m.overlaps.concat(c.m.titleOverlaps))}`));
	const hh = cells.filter((c) => Math.round(c.m.head.h) !== HEIGHT[c.state]);
	check('HD: the head is 52px on a chat and 96px on a Diamond and in select mode, in every locale and variant', hh.length === 0,
		hh.length ? list(hh, (c) => `${where(c)} ${c.m.head.h}`) : `52/96/96/96 in all ${cells.length} cells`);
	// The title is the same width whatever it says.
	const group = (cs, key) => { const g = new Map(); for (const c of cs) { const k = key(c); if (!g.has(k)) g.set(k, []); g.get(k).push(c); } return g; };
	const tw = [];
	for (const [k, cs] of group(cells.filter((c) => !c.locale), (c) => `${c.state}/${c.look}/${c.variant || '-'}`)) {
		const ws = cs.map((c) => c.m.title.w); if (Math.max(...ws) - Math.min(...ws) > 1) tw.push(`${k} ${J(ws)}`);
	}
	check('HD: the title is the same width at every length', tw.length === 0, tw.slice(0, 4).join('; '));
	const tc = grid.filter((c) => c.title === 'mid' && c.state === 'chat');
	const dd = grid.filter((c) => c.title === 'mid' && c.state === 'crystal');
	const wc = tc.map((c) => c.m.title.w), wd = dd.map((c) => c.m.title.w);
	// Option B measured 231 and 207 with the chip's padding at 10px; the chip wears the head-tool role's 9px, so the title has 2px more.
	// With no Diamond to measure the Diamond half is NOT COVERED (named above), and the chat half is still asserted.
	check(`HD: the title is about 231px on a chat${diamond ? ' and 207px on a Diamond' : ''} (option B\'s figures, within 3px)`,
		wc.length > 0 && (wd.length > 0 || !diamond) && wc.every((w) => Math.abs(w - 231) <= 3) && wd.every((w) => Math.abs(w - 207) <= 3), `chat ${J(wc)}, Diamond ${J(wd)}`);
	check('HD: "Compare the three joinery quotes" is shown whole on a chat', tc.length > 0 && tc.every((c) => !c.m.title.cut), J(tc.map((c) => c.m.title.cut)));
	const cut = cells.filter((c) => c.m.chip && c.m.chip.cut);
	check('HD: the mode word is never cut', cells.every((c) => c.m.chip) && cut.length === 0, list(cut, (c) => `${where(c)} "${c.m.chip.txt}"`));
	// "More" and the chip hold one place: more by its left edge everywhere, the chip by its right edge everywhere and
	// by its left edge for one word.
	const mx = cells.map((c) => c.m.more ? c.m.more.x : null);
	check('HD: "more" is drawn in every cell, in one place', mx.every((x) => x != null) && Math.max(...mx) - Math.min(...mx) <= 1, `x ${J([...new Set(mx.map((x) => x == null ? 'none' : Math.round(x)))])}`);
	// The figures option B was chosen on, as this run measures them.
	const hts = (st) => [...new Set(cells.filter((c) => c.state === st).map((c) => Math.round(c.m.head.h)))];
	const taps = cells.flatMap((c) => c.m.ctrls.map((o) => o.tap));
	console.log(`  (B row: head ${J(hts('chat'))}/${J(hts('crystal'))}/${J(hts('dchat'))}/${J(hts('select'))} for chat/crystal/dchat/select; title ${J([...new Set(wc.map(Math.round))])}/${J([...new Set(wd.map(Math.round))])}; scrolling cells ${sc.length}; sideways-scroll cells ${hs.length}; overlap cells ${ovs.length}; smallest tap cross ${Math.min(...taps.map((t) => t.w))}x${Math.min(...taps.map((t) => t.h))})`);
	const cr = cells.map((c) => c.m.chip ? c.m.chip.x + c.m.chip.w : null);
	check('HD: the mode chip ends in one place in every cell', cr.every((x) => x != null) && Math.max(...cr) - Math.min(...cr) <= 1, `right edge ${J([...new Set(cr.map((x) => x == null ? 'none' : Math.round(x)))])}`);
	const cl = [];
	for (const [k, cs] of group(cells.filter((c) => c.m.chip && !c.locale), (c) => c.m.chip.txt)) {
		const xs = cs.map((c) => c.m.chip.x); if (Math.max(...xs) - Math.min(...xs) > 1) cl.push(`"${k}" ${J([...new Set(xs.map(Math.round))])}`);
	}
	check('HD: the mode chip starts in one place for any one word, at every title, state and look', cl.length === 0, cl.join('; '));
});

// ── The menus ───────────────────────────────────────────────────────────────
// The rows, in the owner's order, with the key of the word each shows. The Select row presses `#collapse-btn`.
const ROWS = [
	['concise-chip',     'chat.concise',     'Concise'],
	['chat-copy-btn',    'chat.copy_all',    'Copy'],
	['steps-toggle-btn', 'chat.steps',       'Steps'],
	['expand-all-btn',   'chat.menu_expand', 'Expand'],
	['chead-select-row', 'chat.menu_select', 'Select'],
];
// The computed style two rows must share for them to be one drawing.
const ROW_STYLE = ['display', 'alignItems', 'justifyContent', 'textAlign', 'columnGap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'height',
	'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textTransform', 'color', 'backgroundColor', 'borderTopWidth', 'borderTopLeftRadius',
	'boxSizing', 'whiteSpace', 'opacity'];
const POP_STYLE = ['display', 'flexDirection', 'rowGap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopLeftRadius', 'boxShadow', 'backgroundColor', 'minWidth'];
/// What an open menu shows: its container, its closer head and each visible row.
const readMenu = (sel) => ev(([q, ROW_STYLE_P, POP_STYLE_P]) => {
	const m = document.querySelector(q);
	if (!m) return null;
	const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
	const pick = (e, props) => { const cs = getComputedStyle(e); const o = {}; for (const p of props) o[p] = cs[p]; return o; };
	const probe = document.createElement('i'); probe.style.cssText = 'display:none;background:var(--dl-on)'; document.body.appendChild(probe);
	const fill = getComputedStyle(probe).backgroundColor; probe.remove();
	const rows = [...m.querySelectorAll(':scope > button')].filter(vis).map((b) => {
		const r = b.getBoundingClientRect(), lab = b.querySelector('.btn-label'), ic = b.querySelector('svg.ic');
		const cs = lab ? getComputedStyle(lab) : null;
		return { id: b.id, w: +r.width.toFixed(2), h: +r.height.toFixed(2), x: +r.left.toFixed(2), y: +r.top.toFixed(2), pressed: b.getAttribute('aria-pressed'), cls: b.className,
			label: lab ? lab.textContent.trim() : null, shown: !!(lab && cs.display !== 'none' && lab.getClientRects().length > 0), cut: !!(lab && lab.scrollWidth > lab.clientWidth + 1),
			icon: ic ? { w: ic.getBoundingClientRect().width, h: ic.getBoundingClientRect().height } : null,
			role: b.getAttribute('role'), aria: b.getAttribute('aria-label'), style: pick(b, ROW_STYLE_P), filled: getComputedStyle(b).backgroundColor === fill,
			gap: ic && lab ? +(lab.getBoundingClientRect().left - ic.getBoundingClientRect().right).toFixed(2) : null };
	});
	const hd = m.querySelector(':scope > .ui-head');
	const r = m.getBoundingClientRect();
	return { open: !m.hidden, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, style: pick(m, POP_STYLE_P), rows, fill,
		head: hd ? { text: hd.textContent.trim(), closer: !!hd.querySelector('.ui-close') } : null, hasHead: !!hd, role: m.getAttribute('role') };
}, [sel, ROW_STYLE, POP_STYLE]);
const dotOn = () => ev(() => { const m = document.getElementById('chead-more'); if (!m) return false; const cs = getComputedStyle(m, '::after'); return cs.content !== 'none' && cs.content !== 'normal' && parseFloat(cs.width) >= 5 && cs.display !== 'none'; });
const wordOf = (key) => ev((k) => window.DaimondI18n.t(k), key);
let made = false;
async function chatReady() {
	await phone();
	if (!made) { await startChat(); made = true; } else await toChat();
	await wear('obsidian');
}

await section('HM', async () => {
	await chatReady();
	// Help first: its rows are 44px on a phone, and they are the pattern the head's menu follows.
	await tap('#help-btn'); await sleep(250);
	const help = await readMenu('#help-menu');
	need(help && help.open, 'Help did not open');
	check('HM: Help\'s rows are 44px high on a phone', help.rows.length >= 2 && help.rows.every((r) => Math.abs(r.h - 44) <= 0.6), help.rows.map((r) => `${r.id} ${r.h}`).join(', '));
	await shot('HM_help_open', { x: 0, y: 0, width: 390, height: 420 });
	await S.page.keyboard.press('Escape'); await sleep(250);

	const hasMore = await ev(() => { const m = document.getElementById('chead-more'); return !!(m && m.getClientRects().length); });
	need(hasMore, 'there is no "more" button on the phone chat head');
	await tap('#chead-more');
	const menu = await readMenu('#chead-more-menu');
	need(menu && menu.open, '"more" did not open its menu');
	check('HM: "more" opens the menu, and says so (aria-expanded)', await ev(() => document.getElementById('chead-more').getAttribute('aria-expanded') === 'true'));
	await shot('HM_menu_open', { x: 0, y: 0, width: 390, height: 420 });
	check('HM: the rows are, in his order, Concise, Copy, Steps, Expand, Select', J(menu.rows.map((r) => r.id)) === J(ROWS.map((r) => r[0])), J(menu.rows.map((r) => r.id)));
	check('HM: every row is 44px high and at least 44 wide', menu.rows.length === 5 && menu.rows.every((r) => Math.abs(r.h - 44) <= 0.6 && r.w >= 44), menu.rows.map((r) => `${r.id} ${r.w}x${r.h}`).join(', '));
	check('HM: the menu has Help\'s closer head, titled "Chat options"', menu.hasHead && menu.head.closer && menu.head.text === (await wordOf('chat.more')), J(menu.head));
	const words = await Promise.all(ROWS.map((r) => wordOf(r[1])));
	check('HM: each row shows its word, visibly, from t() (Concise, Copy, Steps, Expand, Select)',
		menu.rows.every((r, i) => r.shown && r.label === words[i] && r.label === ROWS[i][2]), J(menu.rows.map((r) => [r.id, r.label, r.shown])));
	check('HM: no row shows the long spoken wording', menu.rows.every((r) => r.label.split(/\s+/).length <= 1), J(menu.rows.map((r) => r.label)));
	check('HM: each row has an icon of 16px', menu.rows.every((r) => r.icon && Math.round(r.icon.w) === 16 && Math.round(r.icon.h) === 16), J(menu.rows.map((r) => r.icon)));
	// The tap cross of each row, with the same measure as the head.
	const crosses = await ev((ids) => {
		const cross = (e) => { const r = e.getBoundingClientRect(); const px = Math.floor(r.left + r.width / 2) + 0.5, py = Math.floor(r.top + r.height / 2) + 0.5;
			const hit = (x, y) => { const h = document.elementFromPoint(x, y); return !!h && (h === e || e.contains(h)); };
			if (!hit(px, py)) return { w: 0, h: 0 }; let l = 0, rt = 0, u = 0, d = 0;
			while (l < 30 && hit(px - l - 1, py)) l++; while (rt < 30 && hit(px + rt + 1, py)) rt++; while (u < 30 && hit(px, py - u - 1)) u++; while (d < 30 && hit(px, py + d + 1)) d++;
			return { w: l + rt + 1, h: u + d + 1 }; };
		return ids.map((id) => ({ id, ...cross(document.getElementById(id)) }));
	}, ROWS.map((r) => r[0]));
	check('HM: every row has a tap cross of at least 44x44', crosses.every((c) => c.w >= 44 && c.h >= 44), J(crosses.map((c) => `${c.id} ${c.w}x${c.h}`)));
	const inView = menu.rect.x >= 0 && menu.rect.x + menu.rect.w <= 390 && menu.rect.y + menu.rect.h <= 844;
	check('HM: the menu sits inside the window and no label is cut', inView && menu.rows.every((r) => !r.cut), `${J(menu.rect)} cut ${J(menu.rows.filter((r) => r.cut).map((r) => r.id))}`);
	check('HM: Concise, Steps and Select report whether they are on', menu.rows[0].pressed !== null && menu.rows[2].pressed !== null && menu.rows[4].pressed !== null, J(menu.rows.map((r) => r.pressed)));
	check('HM: Steps is shown at first, so its row is filled; Concise is off, so its row is not', menu.rows[2].filled && !menu.rows[0].filled, J(menu.rows.map((r) => [r.id, r.filled])));
	const first = menu;
	await S.page.keyboard.press('Escape'); await sleep(250);

	// A row runs its action, and the menu closes. The real button is the row, so a spy on it hears the tap.
	await ev((ids) => { window.__spy = {}; ids.forEach((id) => { const b = document.getElementById(id); if (b && !b.__spied) { b.__spied = 1; b.addEventListener('click', () => { window.__spy[id] = (window.__spy[id] || 0) + 1; }); } }); }, ROWS.slice(0, 4).map((r) => r[0]));
	const shut = () => ev(() => { const m = document.getElementById('chead-more-menu'); return !!m && m.hidden; });
	const heard = (id) => ev((i) => (window.__spy && window.__spy[i]) || 0, id);
	const bad1 = [];
	for (const [id] of ROWS.slice(0, 4)) {
		await tap('#chead-more');
		const before = await heard(id);
		await tap(`#chead-more-menu #${id}`);
		if ((await heard(id)) !== before + 1) bad1.push(id + ' did not run');
		if (!(await shut())) bad1.push(id + ' left the menu open');
	}
	check('HM: each of the first four rows runs its own handler once, and closes the menu', bad1.length === 0, bad1.join('; '));
	// Concise and Steps leave a state behind, and the row says it.
	let st = await ev(() => ({ concise: document.getElementById('concise-chip').getAttribute('aria-pressed'), steps: document.getElementById('steps-toggle-btn').classList.contains('dim') }));
	check('HM: after one tap on each, Concise is on and Steps is hidden', st.concise === 'true' && st.steps === true, J(st));
	check('HM: the dot shows on "more" while Concise is on', await dotOn());
	await tap('#chead-more');
	const second = await readMenu('#chead-more-menu');
	check('HM: Concise is now a filled row, and Steps (hidden) is not', second.rows[0].filled && !second.rows[2].filled, J(second.rows.map((r) => [r.id, r.filled])));
	await S.page.keyboard.press('Escape'); await sleep(250);
	// Put both back (a tap each), and the dot goes with Concise.
	for (const id of ['concise-chip', 'steps-toggle-btn']) { await tap('#chead-more'); await tap(`#chead-more-menu #${id}`); }
	st = await ev(() => ({ concise: document.getElementById('concise-chip').getAttribute('aria-pressed'), steps: document.getElementById('steps-toggle-btn').classList.contains('dim') }));
	check('HM: and a second tap puts them back, and the dot goes', st.concise === 'false' && st.steps === false && !(await dotOn()), J(st));
	// Select: the row presses the real "−", which stays on the head and is drawn while select mode is on.
	check('HM: the head draws no "−" until select mode is on', await ev(() => { const b = document.getElementById('collapse-btn'); return !(b && b.getClientRects().length); }));
	await tap('#chead-more'); await tap('#chead-more-menu #chead-select-row');
	st = await ev(() => { const h = document.querySelector('.panel.ai .chead'); const b = document.getElementById('collapse-btn'); return { selecting: h.classList.contains('selecting'), out: !!(b && b.getClientRects().length) }; });
	check('HM: the Select row latches select mode, and the menu closes', st.selecting && await shut(), J(st));
	check('HM: select mode draws the "−" way out on the head, and the dot shows', st.out && await dotOn(), J(st));
	await shot('HM_select_on', { x: 0, y: 0, width: 390, height: 190 });
	await tap('#chead-more');
	const third = await readMenu('#chead-more-menu');
	check('HM: while select mode is on, the Select row is filled', third.rows[4].filled && third.rows[4].pressed === 'true', J([third.rows[4].filled, third.rows[4].pressed]));
	await S.page.keyboard.press('Escape'); await sleep(250);
	await tap('#collapse-btn');
	st = await ev(() => ({ selecting: document.querySelector('.panel.ai .chead').classList.contains('selecting') }));
	check('HM: the "−" leaves select mode', !st.selecting && !(await dotOn()), J(st));

	// One drawing: the same row, the same menu, Help or the head.
	await tap('#help-btn'); await sleep(250);
	const h2 = await readMenu('#help-menu');
	await S.page.keyboard.press('Escape'); await sleep(250);
	const hr = h2.rows.find((r) => r.id === 'about-btn'), mr = first.rows.find((r) => r.id === 'concise-chip');
	const diff = ROW_STYLE.filter((p) => hr.style[p] !== mr.style[p]);
	check('HM: Help\'s rows and the head menu\'s rows have the same computed style', diff.length === 0, diff.map((p) => `${p}: help ${hr.style[p]} / head ${mr.style[p]}`).join('; '));
	check('HM: and the same gap between icon and word', hr.gap === mr.gap && hr.icon && mr.icon && hr.icon.w === mr.icon.w, `help ${hr.gap} / head ${mr.gap}`);
	const pd = POP_STYLE.filter((p) => h2.style[p] !== first.style[p]);
	check('HM: and the menus themselves are the same pop', pd.length === 0 && h2.hasHead && first.hasHead && h2.role === first.role, pd.map((p) => `${p}: help ${h2.style[p]} / head ${first.style[p]}`).join('; ') + ` role ${h2.role}/${first.role}`);

	// All eight languages, through t().
	const codes = await ev(() => window.DaimondI18n.locales().map((l) => l.code));
	check('HM: there are eight languages to check', codes.length === 8, J(codes));
	const lang = [];
	for (const code of codes) {
		await locale(code);
		await tap('#chead-more');
		const m = await readMenu('#chead-more-menu');
		const w = await Promise.all(ROWS.map((r) => wordOf(r[1])));
		if (!m || !m.open) { lang.push(code + ' did not open'); continue; }
		if (J(m.rows.map((r) => r.id)) !== J(ROWS.map((r) => r[0]))) lang.push(`${code} rows ${J(m.rows.map((r) => r.id))}`);
		m.rows.forEach((r, i) => {
			if (!r.shown || !r.label || r.label !== w[i]) lang.push(`${code} ${r.id} shows "${r.label}", t() says "${w[i]}"`);
			if (w[i] === ROWS[i][1]) lang.push(`${code} ${r.id} is a raw key`);
			if (Math.abs(r.h - 44) > 0.6) lang.push(`${code} ${r.id} is ${r.h}px`);
			if (r.cut) lang.push(`${code} ${r.id} is cut`);
		});
		if (code === 'fr' || code === 'ja') await shot(`HM_menu_${code}`, { x: 0, y: 0, width: 390, height: 420 });
		await S.page.keyboard.press('Escape'); await sleep(200);
	}
	await locale('en');
	check('HM: in all eight languages the five rows show the locale\'s words, 44px high, whole', lang.length === 0, lang.slice(0, 6).join('; '));
});

// ── HK ──────────────────────────────────────────────────────────────────────
await section('HK', async () => {
	await chatReady();
	const kb = S.page.keyboard;
	for (const [label, btn, pop] of [['Help', '#help-btn', '#help-menu'], ['the head menu', '#chead-more', '#chead-more-menu']]) {
		const exists = await ev((q) => { const b = document.querySelector(q); return !!(b && b.getClientRects().length); }, btn);
		need(exists, `${label}: there is no button ${btn} to press`);
		await ev((q) => document.querySelector(q).focus(), btn);
		await kb.press('Enter'); await sleep(350);
		const st = await ev((q) => { const m = document.querySelector(q), f = document.activeElement; const first = m.querySelector('button:not(.ui-close)');
			return { open: !m.hidden, inside: m.contains(f), at: f.id || f.className, first: first && first.id }; }, pop);
		check(`HK: ${label}: Enter opens it with the focus on its first row`, st.open && st.inside && st.at === st.first && !!st.first, J(st));
		// Tab stays inside, forwards past the last row and backwards past the first.
		let out = '';
		const n = await ev((q) => document.querySelector(q).querySelectorAll('button').length, pop);
		for (let i = 0; i < n + 2 && !out; i++) { await kb.press('Tab'); out = await ev((q) => document.querySelector(q).contains(document.activeElement) ? '' : (document.activeElement.id || document.activeElement.tagName), pop); }
		for (let i = 0; i < n + 2 && !out; i++) { await kb.press('Shift+Tab'); out = await ev((q) => document.querySelector(q).contains(document.activeElement) ? '' : (document.activeElement.id || document.activeElement.tagName), pop); }
		check(`HK: ${label}: Tab and Shift+Tab stay inside it`, out === '', out ? 'focus left for ' + out : `${n} buttons, ${2 * (n + 2)} presses`);
		await kb.press('Escape'); await sleep(300);
		const end = await ev(([q, b]) => ({ shut: document.querySelector(q).hidden, at: document.activeElement && document.activeElement.id, want: b.slice(1) }), [pop, btn]);
		check(`HK: ${label}: Escape closes it and gives the focus back to its button`, end.shut && end.at === end.want, J(end));
	}
});

// ── HP ──────────────────────────────────────────────────────────────────────
// ONE POPOVER AT A TIME. Help, "more" and the mode chip each open under `stopPropagation`, so the document click that
// closes a popover on an outside tap never hears the others' openers: with "more" open, a tap on the chip left the menu
// up beneath the mode picker, and two Escapes were needed to clear the screen (QA1 F1, rule 8).
const POPS = [
	['more',          '#chead-more',     '#chead-more-menu'],
	['the mode chip', '#hand-mode-chip', '#hand-mode-pop'],
	['Help',          '#help-btn',       '#help-menu'],
];
const popsUp = () => ev(() => [...document.querySelectorAll('.pop')].filter((p) => !p.hidden && p.getClientRects().length).map((p) => p.id));
/// Can a thumb reach the control: is it the topmost thing at its own centre?
const reachable = (sel) => ev((q) => { const e = document.querySelector(q); if (!e || !e.getClientRects().length) return false; const r = e.getBoundingClientRect();
	const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!h && (h === e || e.contains(h)); }, sel);
await section('HP', async () => {
	await chatReady();
	await S.page.keyboard.press('Escape'); await sleep(250);
	const bad2 = [], seen = [];
	for (const [an, abtn, apop] of POPS) {
		for (const [bn, bbtn, bpop] of POPS) {
			if (apop === bpop) continue;
			await tap(abtn);
			const first = await popsUp();
			if (J(first) !== J([apop.slice(1)])) { bad2.push(`${an} opened ${J(first)}`); await S.page.keyboard.press('Escape'); await sleep(250); continue; }
			if (!(await reachable(bbtn))) { seen.push(`${bn} under ${an}`); await S.page.keyboard.press('Escape'); await sleep(250); continue; }
			await tap(bbtn);
			const both = await popsUp();
			const stale = await ev((q) => document.querySelector(q).getAttribute('aria-expanded'), abtn);
			if (J(both) !== J([bpop.slice(1)])) bad2.push(`${an} then ${bn}: open ${J(both)}`);
			if (stale === 'true') bad2.push(`${an} then ${bn}: ${an} still says expanded`);
			if (an === 'more' && bn === 'the mode chip') await shot('HP_more_then_mode', { x: 0, y: 0, width: 390, height: 700 });
			await S.page.keyboard.press('Escape'); await sleep(300);
			const left = await popsUp();
			if (left.length) bad2.push(`${an} then ${bn}: one Escape left ${J(left)}`);
		}
	}
	check('HP: opening any of Help, "more" and the mode chip with another up closes the other, and one Escape clears the screen', bad2.length === 0, bad2.join('; '));
	console.log(`  (${POPS.length * (POPS.length - 1) - seen.length} of ${POPS.length * (POPS.length - 1)} pairs driven by a real tap${seen.length ? '; not reachable: ' + seen.join(', ') : ''})`);
	// An outside tap on nothing in particular still closes the one that is up.
	for (const [n, btn, pop] of POPS) {
		await tap(btn);
		await S.page.touchscreen.tap(195, 780); await sleep(300);
		const left = await popsUp();
		if (left.length) bad2.push(`${n}: a tap outside left ${J(left)}`);
		await S.page.keyboard.press('Escape'); await sleep(200);
	}
	check('HP: a tap outside closes whichever one is up', bad2.every((m) => !/tap outside/.test(m)), bad2.filter((m) => /tap outside/.test(m)).join('; '));
});

// ── HX ──────────────────────────────────────────────────────────────────────
const HOME = ['concise-chip', 'chat-copy-btn', 'steps-toggle-btn', 'expand-all-btn', 'collapse-btn'];
const deskFacts = (page) => page.evaluate((ids) => {
	const home = document.querySelector('.panel.ai .chead-right');
	const more = document.getElementById('chead-more'), menu = document.getElementById('chead-more-menu');
	const row = document.querySelector('#help-menu #about-btn');
	const cs = row ? getComputedStyle(row) : null, ic = row && row.querySelector('svg.ic');
	return { more: !!(more && more.getClientRects().length && getComputedStyle(more).display !== 'none'),
		away: ids.filter((id) => { const b = document.getElementById(id); return !b || b.parentNode !== home; }),
		menuShut: !menu || menu.hidden, expanded: more ? more.getAttribute('aria-expanded') : null,
		helpRow: cs ? { pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '), gap: cs.columnGap, icon: ic ? Math.round(ic.getBoundingClientRect().width) : null } : null };
}, HOME);
await section('HX', async () => {
	DESK = await open({ name: 'shelldesk', route: ROUTE });
	await DESK.page.setViewportSize({ width: 1300, height: 900 });
	await sleep(1500);
	await DESK.page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); }); await sleep(300);
	let f = await deskFacts(DESK.page);
	check('HX: at 1300x900 there is no "more", every tool sits home in the head\'s right-hand cluster, and the menu is shut',
		!f.more && f.away.length === 0 && f.menuShut, J(f));
	await DESK.page.evaluate(() => document.getElementById('help-btn').click()); await sleep(300);
	f = await deskFacts(DESK.page);
	check('HX: Help on a computer is unchanged: rows of 7px 8px, a 4px gap, a 16px icon', !!f.helpRow && f.helpRow.pad === '7px 8px 7px 8px' && f.helpRow.gap === '4px' && f.helpRow.icon === 16, J(f.helpRow));
	await DESK.page.keyboard.press('Escape');
	await shot('HX_desk_1300', undefined);

	await chatReady();
	const hasMore = await ev(() => { const m = document.getElementById('chead-more'); return !!(m && m.getClientRects().length); });
	if (!hasMore) { console.log('  (this build has no "more" on the phone: the crossing check has nothing to cross)'); return; }
	await tap('#chead-more');
	const was = await readMenu('#chead-more-menu');
	need(was && was.open, 'the menu would not open to cross with');
	await S.page.setViewportSize({ width: 1300, height: 900 }); await sleep(900);
	f = await deskFacts(S.page);
	check('HX: crossing 760px with the menu open shuts it and sends every button home', f.menuShut && f.expanded !== 'true' && !f.more && f.away.length === 0, J(f));
	await S.page.setViewportSize({ width: 390, height: 844 }); await sleep(900);
	f = await ev(() => { const m = document.getElementById('chead-more-menu'); return { folded: ['concise-chip', 'chat-copy-btn', 'steps-toggle-btn', 'expand-all-btn'].every((id) => document.getElementById(id).parentNode === m), shut: m.hidden }; });
	check('HX: and crossing back folds them into the menu again, shut', f.folded && f.shut, J(f));
});

// ── DR ──────────────────────────────────────────────────────────────────────
// The drawer is the phone's list of chats and Diamonds. Showing a destination on the floor means its job is done, so
// it closes: a New Chat, a New Diamond, a picked chat or Diamond, a footer chip. Nothing that chooses nothing closes it.
const hitFloor = () => ev(() => {
	// The point at the middle of the composer (or, with no composer on screen, of the head's title) must belong to the
	// panel the person is about to use, and not to the drawer, the scrim or anything else laid over it.
	const pick = (document.getElementById('chat-input') && document.getElementById('chat-input').getClientRects().length && document.getElementById('chat-input'))
		|| document.querySelector('.panel.ai .ctitle');
	if (!pick) return { found: false };
	const r = pick.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
	return { found: true, target: pick.id || pick.className, hit: h ? (h.id || h.className || h.tagName) : null, ok: !!h && (h === pick || pick.contains(h)) };
});
const drawerIs = (open) => ev((o) => document.body.classList.contains('drawer-open') === o, open);
const openDrawer = async () => { if (!(await drawerOpen())) { await tap('#drawer-btn'); await sleep(450); } };
await section('DR', async () => {
	await chatReady();
	await closeDrawer();
	// New Chat.
	await openDrawer();
	check('DR: a tap on the hamburger opens the drawer', await drawerIs(true));
	await tap('#new-session-btn'); await sleep(900);
	await S.page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 }).catch(() => {});
	let f = await hitFloor();
	check('DR: New Chat closes the drawer, and the composer is what a tap on it reaches', (await drawerIs(false)) && f.ok, J({ drawerOpen: await drawerIs(true), ...f }));
	await shot('DR_newchat', { x: 0, y: 0, width: 390, height: 844 });
	// Picking a chat: another one (the rail's own click closes the drawer), and the one already open (it returned early).
	const pickChat = (which) => ev((w) => {
		const cur = (() => { try { const f = window.DaimondAttach.focus(); return f && f.kind === 'chat' ? String(f.id) : ''; } catch (e) { return ''; } })();
		const boxes = [...document.querySelectorAll('#session-list .session-box')].filter((b) => b.getClientRects().length);
		const box = boxes.find((b) => (w === 'current') === (b.dataset.id === cur));
		if (!box) return null;
		const r = (box.querySelector('.tile-label') || box).getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: box.dataset.id };
	}, which);
	for (const which of ['other', 'current']) {
		await openDrawer();
		const at = await pickChat(which);
		need(at, `there is no ${which} chat to pick (a second chat is made above)`);
		await S.page.touchscreen.tap(at.x, at.y); await sleep(800);
		check(`DR: picking ${which === 'other' ? 'another chat' : 'the chat that is already open'} closes the drawer`, await drawerIs(false), J(await hitFloor()));
	}
	// New Diamond: the dialog, a name, OK.
	await openDrawer();
	await tap('#new-diamond-btn'); await sleep(700);
	const dlg = await ev(() => { const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop(); if (!card) return false; const inp = card.querySelector('input.dlg-input'); if (!inp) return false; inp.value = 'Shell ' + Date.now().toString(36); inp.dispatchEvent(new Event('input', { bubbles: true })); card.querySelector('.dlg-ok').click(); return true; });
	need(dlg, 'the New Diamond dialog did not come up');
	await sleep(2200);
	f = await hitFloor();
	check('DR: New Diamond closes the drawer, and the Diamond is what a tap on the floor reaches', (await drawerIs(false)) && f.ok, J({ drawerOpen: await drawerIs(true), ...f }));
	await shot('DR_newdiamond', { x: 0, y: 0, width: 390, height: 844 });
	// A footer chip, with the drawer open. The Diamonds chip is the one that opens it; Workspace is a dock destination.
	await toChat(); await closeDrawer();
	await openDrawer();
	// A footer chip is under the drawer's scrim on a real phone, so a thumb cannot reach it: it is pressed by script, as the
	// gate's own chip taps are, and the seam must still take the drawer down.
	const pressed = await ev(() => { const c = document.querySelector('#mnav .ptag[data-panel="work"]'); if (!c) return false; c.click(); return true; });
	need(pressed, 'there is no Workspace chip in the footer');
	await sleep(900);
	const st = await ev(() => ({ drawer: document.body.classList.contains('drawer-open'), mpanel: document.body.dataset.mpanel, sheet: document.body.classList.contains('sheet-open') }));
	check('DR: a footer chip to Workspace, pressed with the drawer open, closes it and shows Workspace', !st.drawer && (st.mpanel === 'work' || st.sheet), J(st));
	await shot('DR_workspace_chip', { x: 0, y: 0, width: 390, height: 844 });
	await ev(() => { const c = document.querySelector('#mnav .ptag[data-panel="ai"]'); if (c) c.click(); }); await sleep(700);
	// A fan-out is not a person's tap. `Workers.dispatch` (what the model's spawn_agent reaches) lands in the middle of a turn
	// and reveals the Agents panel, so it can land while a person is in the drawer choosing another chat. It must open the
	// panel and leave the drawer, and the floor under it, alone. The panel is shut first so that the engine has to open it.
	const fanOut = (name) => ev((n) => {
		try {
			const P = window.DaimondPanels, f = window.DaimondAttach.focus();
			if (P.isOpen('agents')) P.hide('agents');
			window.DaimondWorkers.dispatch('', '', [{ name: n, task: 'Say exactly: DR-FAN-OUT' }], false, null, 0, { chatId: f && f.kind === 'chat' ? String(f.id) : '', chatName: 'DR' });
			return '';
		} catch (e) { return String(e && e.message || e); }
	}, name);
	const faced = () => ev(() => ({ drawer: document.body.classList.contains('drawer-open'), mpanel: document.body.dataset.mpanel, agents: window.DaimondPanels.isOpen('agents') }));
	await toChat(); await closeDrawer(); await openDrawer();
	const floor0 = (await faced()).mpanel;
	const threw = await fanOut('dr-held'); await sleep(900);
	let fo = await faced();
	check('DR: a fan-out landing while the drawer is open opens Agents and leaves the drawer open, on the same floor', !threw && fo.drawer && fo.agents && fo.mpanel === floor0, J({ threw, floor0, ...fo }));
	await closeDrawer();
	const threw2 = await fanOut('dr-shown'); await sleep(900);
	fo = await faced();
	check('DR: the same fan-out with the drawer shut still shows Agents (the hold is for the drawer only)', !threw2 && !fo.drawer && fo.mpanel === 'agents', J({ threw2, ...fo }));
	await toChat();
	// What chooses nothing leaves it open: the fold of the Diamonds section (or the tag filter, when tags exist).
	await closeDrawer(); await openDrawer();
	const sel = await ev(() => { const t = document.querySelector('.tagf-toggle'); return t && t.getClientRects().length ? '.tagf-toggle' : '.rail-fold[data-fold="diamonds"]'; });
	await tap(sel); await sleep(500);
	check(`DR: a tap that chooses nothing (${sel}) leaves the drawer open`, await drawerIs(true));
	await tap(sel); await sleep(300);
	await closeDrawer();
});

// ── ST ──────────────────────────────────────────────────────────────────────
// The footer strip scrolls and fades at an end that has more beyond it. A chip brought in by showing its destination
// must stand clear of the fade, or the first letters of "Workspace" read as cut. Measured for every chip, from the side
// it is farthest from, in all eight languages and both looks.
const FADE = 34;
await section('ST', async () => {
	await chatReady();
	await closeDrawer();
	const codes = await ev(() => window.DaimondI18n.locales().map((l) => l.code));
	const ids = await ev(() => [...document.querySelectorAll('#mnav .panel-tags .ptag[data-panel]')].map((c) => c.dataset.panel));
	need(ids.length > 3, 'the footer strip has no chips to measure');
	const MEAS = (a) => {
		const strip = document.querySelector('#mnav .panel-tags'), nav = document.getElementById('mnav');
		const chip = strip.querySelector(`.ptag[data-panel="${a.id}"]`);
		if (!chip) return { id: a.id, gone: true };
		const rg = document.createRange(); rg.selectNodeContents(chip);
		const lab = rg.getBoundingClientRect(), box = chip.getBoundingClientRect(), sr = strip.getBoundingClientRect(), nr = nav.getBoundingClientRect();
		const more = strip.getAttribute('data-more') || '';
		const fl = (more === 'start' || more === 'both') ? a.fade : 0, fr = (more === 'end' || more === 'both') ? a.fade : 0;
		// The bar carries a second fade of its own over its right end (skin-daylight.css, sweep item 20), read from its computed
		// mask. It is REPORTED, not scored: it is not the strip's fade, and the strip already fades the same end by `data-more`.
		const nm = getComputedStyle(nav).maskImage || getComputedStyle(nav).webkitMaskImage || '', m = /rgb\(0, 0, 0\) (\d+(?:\.\d+)?)%/.exec(nm);
		const clearR = sr.right - fr, barR = m ? nr.left + nr.width * parseFloat(m[1]) / 100 : null;
		return { id: a.id, more, scrollLeft: strip.scrollLeft, lab: [+lab.left.toFixed(1), +lab.right.toFixed(1)], box: [+box.left.toFixed(1), +box.right.toFixed(1)], strip: [+sr.left.toFixed(1), +sr.right.toFixed(1)],
			labLeft: +(lab.left - (sr.left + fl)).toFixed(1), boxLeft: +(box.left - (sr.left + fl)).toFixed(1), labRight: +(clearR - lab.right).toFixed(1), boxRight: +(clearR - box.right).toFixed(1), inBarFade: barR != null && lab.right > barR + 0.5 };
	};
	const bad2 = [], rest = [], barFade = [];
	for (const look of LOOKS) {
		await wear(look);
		for (const code of codes) {
			await locale(code);
			// At rest the first chip begins at the strip's padding edge.
			await ev(() => { document.querySelector('#mnav .panel-tags').scrollLeft = 0; }); await sleep(200);
			const r0 = await ev(() => { const s = document.querySelector('#mnav .panel-tags'), c = s.querySelector('.ptag'); return { first: c.getBoundingClientRect().left - s.getBoundingClientRect().left, pad: parseFloat(getComputedStyle(s).paddingLeft) }; });
			if (Math.abs(r0.first - r0.pad) > 1) rest.push(`${look}/${code} first chip at ${r0.first.toFixed(1)}, padding ${r0.pad}`);
			const n = ids.length;
			for (let i = 0; i < n; i++) {
				const id = ids[i];
				await ev(async (q) => { // normalise: nothing open, then the strip as far from this chip as it will go
					if (document.body.classList.contains('drawer-open')) document.getElementById('scrim').click();
					const sh = document.getElementById('msheet-close'); if (document.body.classList.contains('sheet-open') && sh) sh.click();
					const s = document.querySelector('#mnav .panel-tags'); s.scrollLeft = q.far ? s.scrollWidth : 0;
				}, { far: i < n / 2 });
				await sleep(150);
				await ev((i2) => { const c = document.querySelector(`#mnav .panel-tags .ptag[data-panel="${i2}"]`); if (c) c.click(); }, id);
				await sleep(450);
				const m = await ev(MEAS, { id, fade: FADE });
				if (m.gone) continue;
				const tol = -0.5;
				if (m.boxLeft < tol || m.boxRight < tol || m.labLeft < tol || m.labRight < tol) bad2.push(`${look}/${code} ${id} (${m.more}) box ${m.box} label ${m.lab} strip ${m.strip}: left clear ${m.boxLeft}, right clear ${m.boxRight}`);
				if (m.inBarFade) barFade.push(`${look}/${code} ${id}`);
				if (look === 'obsidian' && code === 'en' && id === 'work') await shot('ST_work_en', { x: 0, y: 700, width: 390, height: 144 });
			}
			await ev(() => { const s = document.getElementById('scrim'); if (document.body.classList.contains('drawer-open')) s.click(); const sh = document.getElementById('msheet-close'); if (document.body.classList.contains('sheet-open') && sh) sh.click(); const a = document.querySelector('#mnav .ptag[data-panel="ai"]'); if (a) a.click(); });
			await sleep(300);
		}
	}
	await locale('en');
	check(`ST: ${ids.length} chips x 8 languages x 2 looks: each chip, once shown, stands clear of the fade at both ends`, bad2.length === 0, bad2.slice(0, 4).join('; ') + (bad2.length > 4 ? ` … ${bad2.length} in all` : ''));
	console.log(`  (the bar's own fade over its right end (skin-daylight.css, outside this lane) still covers part of the label in ${barFade.length} of ${ids.length * codes.length * LOOKS.length} cells)`);
	check('ST: at rest the first chip begins at the strip\'s padding edge, in every language', rest.length === 0, rest.slice(0, 3).join('; '));
	const sp = await ev((fade) => { const s = document.querySelector('#mnav .panel-tags'), cs = getComputedStyle(s); return { start: parseFloat(cs.scrollPaddingInlineStart), end: parseFloat(cs.scrollPaddingInlineEnd), fade }; }, FADE);
	check('ST: the strip\'s scroll padding clears the fade it is masked by', sp.start >= FADE && sp.end >= FADE, J(sp));
});

// ── The end ─────────────────────────────────────────────────────────────────
await letGo(S); await letGo(DESK);
if (seenErrors.length) console.log('  (first page error of each device: ' + seenErrors.join(' | ') + ')');
for (const m of NC) console.log('  NOT COVERED  ' + m);
console.log(`\n${ok.length} ok, ${bad.length} failed${NC.length ? ', ' + NC.length + ' NOT COVERED' : ''}${BREAK ? ' (BREAK ' + BREAK + ')' : ''}`);
if (bad.length) { console.log('\nFAILED:\n' + bad.map((b) => '  - ' + b).join('\n')); process.exit(1); }
