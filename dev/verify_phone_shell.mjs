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
//                          overlaps, the head is 52px on a chat, 96px in select mode and b4's large-title head on a
//                          Diamond in every locale, the title is the same width at every length, and the mode chip and
//                          "more" keep one x on each page (the crystal face draws neither: its acts are the bar's ⋯)
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
//   SP  Settings a page    on a phone Settings is only ever a page of the stack, never the modal: a connected phone opens
//                          on home (narrowed or booted at a phone's width); a window narrowed past 760px with Settings up
//                          stands on the Settings page, not home with Admin over it; Credits and Models tapped in the Models group are pages pushed
//                          over it with the modal down, Back is the group again, and on down the stack to home
//   DR  the stack          (Stack A2: the drawer is retired; the rail is the home page, the conversation the turn page
//                          over it) Back goes home and a push is a history entry the browser's Back undoes; showing a
//                          destination (New Chat, New Diamond, a chat, a footer chip) pushes the turn page; a tap that
//                          chooses nothing does not, nor a fan-out landing in the background; installed (navigator.
//                          standalone stubbed), a left-edge touch swipe is a popstate back home
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

import { readPage } from './pagesrc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, errors, scratch, BROWSER, checker } from './harness.mjs';
import { guardRan } from './verdict.mjs';

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
	// Showing a destination no longer pushes the turn page (`mshow`, page/layout.js), as the drawer's close once went
	// missing on 5.2.8; that takes the sheet guests with it, as an Admin prompt row did before gatefix moved it up.
	drawer: { section: 'DR', file: 'js/daimond.js',
		from: "\tif (DaimondStack.started() && isMobile()) DaimondStack.push('turn');\n\t// A guest rises as a sheet;",
		to:   '\t// A guest rises as a sheet;',
		what: 'showing a destination leaves the home page over it' },
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
		src[b.file] = src[b.file] || readPage(path.join(WWW, b.file), 'utf8');
		if (src[b.file].split(b.from).length !== 2) stale.push(n);
	}
	// A break whose anchor is not there YET (the code it damages is written after the check) is reported, not hidden,
	// and stops a run that asked for it.
	if (stale.length && BREAK && stale.includes(BREAK)) { console.error('break no longer matches exactly once: ' + BREAK); process.exit(2); }
	if (stale.length && process.argv.includes('--check-breaks')) { console.error('break(s) no longer match exactly once: ' + stale.join(', ')); process.exit(2); }
}
const ALL = 'HD,HM,HK,HP,HX,SP,DR,ST';
const ONLY = new Set((arg('--only') || (BREAK && !process.argv.includes('--full') ? BREAKS[BREAK].section : ALL))
	.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean));
const on = (s) => ONLY.has(s);
const ROUTE = !BREAK ? null : async (page) => {
	const b = BREAKS[BREAK];
	const body = readPage(path.join(WWW, b.file), 'utf8').replace(b.from, () => b.to);
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
/// A real tap on the first VISIBLE element matching `sel`, for set-up: false when nothing is there to tap. A DOM
/// click sends no pointerdown, so a set-up step that clicked by script could pass where a thumb does nothing (gate 50).
const clk = async (sel) => {
	const up = await S.page.evaluate((q) => [...document.querySelectorAll(q)].some((e) => e.checkVisibility({ visibilityProperty: true })), sel);
	if (!up) return false;
	await tap(sel);
	return true;
};
const shot = (name, clip) => S.page.screenshot({ path: path.join(SHOTS, name + '.png'), ...(clip ? { clip } : {}) }).catch(() => {});
/// A real tap at the centre of the first VISIBLE element matching `sel`, as a thumb would. Visible is checkVisibility's:
/// a tile inside a closed group (the built-in Diamonds' <details>) keeps a layout box but is neither drawn nor hit.
async function tap(sel) {
	const box = await S.page.evaluate((q) => {
		const e = [...document.querySelectorAll(q)].find((x) => x.checkVisibility({ visibilityProperty: true }));
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
/// Is the home page (the rail, once the drawer) the page in view? (Stack A2.)
const drawerOpen = () => ev(() => document.getElementById('app').dataset.stack === 'home');
/// Back to the conversation, for a set-up that never depends on DR.
async function closeDrawer() {
	// Settings is pages of the stack over home (Stack A3), so a set-up that left it up goes home first.
	if (await ev(() => /^settings/.test(window.DaimondStack.top() || ''))) await goHome();
	if (await drawerOpen()) { await ev(() => window.DaimondShell.turn()); await sleep(500); }
}
/// To the home page, for a set-up.
const goHome = async () => { await ev(() => window.DaimondShell.home()); await sleep(500); };
/// A chat with one answer in it, on screen, the drawer shut.
async function startChat() {
	await goHome();
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
	await goHome();
	const ok1 = (await clk('#session-list .session-box .session-box-name')) || (await clk('#session-list .session-box .tile-label')) || (await clk('#session-list .session-box'));
	if (!ok1) { await closeDrawer(); await startChat(); return; }
	await sleep(900); await closeDrawer();
}
async function toDiamond() {
	await goHome();
	// A person with no Diamond of their own opens the Built-in group to reach one.
	if (!(await ev(() => [...document.querySelectorAll('.diamond-box')].some((e) => e.checkVisibility())))) await clk('.rail-builtin:not([open]) > summary');
	// The name, as a person opens a row: a row's own controls (a Diamond's pause sits mid-row) do their own thing.
	const ok1 = (await clk('.diamond-box .session-box-name')) || (await clk('.diamond-box .tile-label')) || (await clk('.diamond-box'));
	// WebKit keeps no file store (CRF2), so no Diamond ever reaches the device: read the capability, as the gate's `webkitPair` does.
	if (!ok1 && (await ev(() => typeof (navigator.storage && navigator.storage.getDirectory))) !== 'function') throw new NotCovered('this browser has no origin file system, so no Diamond reaches the device');
	need(ok1, 'no Diamond on the home page');
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
		tags: !!document.getElementById('chead-tags') && shown(document.getElementById('chead-tags')),
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
// Stack A4 (b4): a Diamond is a page. Its head is the large title (34 px), the tags line when it has tags,
// then the Crystal | Chat | Files segment; the figures are b4's, measured in WebKit at 390 px on 30 Oct.
// On the crystal face the mode chip and "more" leave the head (the bar's ✎ and ⋯ carry the crystal's
// acts), so the chip and "more" checks read only the cells that draw them, each page on its own.
const HEIGHT = { chat: 52, select: 96, crystal: 133, dchat: 136 };
const TAGS_H = 44;		// the tags line (32 px chips) and its 12 px gap, on a Diamond with tags
const headH = (c) => HEIGHT[c.state] + (c.m.tags ? TAGS_H : 0);
const drawsChip = (c) => c.state !== 'crystal';
const pageOf = (c) => (c.state === 'crystal' || c.state === 'dchat') ? 'diamond' : 'chat';
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
	// Select mode is latched by the Select row of "more", as a person latches it: the head draws no "−" until select
	// mode is on (HM), so a tap on the "−" found nothing to press and the mode never latched.
	await tap('#chead-more'); await tap('#chead-more-menu #chead-select-row'); await sleep(500);
	need(await ev(() => !!document.querySelector('.panel.ai .chead.selecting')), 'select mode did not latch');
	await gridState('select');
	await clk('#collapse-btn'); await sleep(400);
	let diamond = true;
	try { await toDiamond(); } catch (e) { if (!e.notCovered) throw e; diamond = false; NC.push('HD: the crystal face, its full screen and the Diamond chat face (' + e.message + ')'); }
	if (diamond) {
	await gridState('crystal');
	// Full screen on the crystal face: the head keeps one control, the way back, and it is as easy to press as any.
	// On a phone it is entered from the bar's ⋯ (its last row); the head's own button shows only once it is on.
	await tap('#stack-acts .icon-btn:last-child'); await sleep(400);
	await tap('.stack-acts-menu > [role=menuitem]:last-child'); await sleep(700);
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
	const hh = cells.filter((c) => Math.round(c.m.head.h) !== headH(c));
	check(`HD: the head is 52px on a chat, 96px in select mode and ${HEIGHT.crystal}/${HEIGHT.dchat}px (+${TAGS_H} with tags) on a Diamond's crystal/chat face, in every locale and variant`, hh.length === 0,
		hh.length ? list(hh, (c) => `${where(c)} ${c.m.head.h} not ${headH(c)}`) : `in all ${cells.length} cells`);
	// The title is the same width whatever it says.
	const group = (cs, key) => { const g = new Map(); for (const c of cs) { const k = key(c); if (!g.has(k)) g.set(k, []); g.get(k).push(c); } return g; };
	const tw = [];
	for (const [k, cs] of group(cells.filter((c) => !c.locale), (c) => `${c.state}/${c.look}/${c.variant || '-'}`)) {
		const ws = cs.map((c) => c.m.title.w); if (Math.max(...ws) - Math.min(...ws) > 1) tw.push(`${k} ${J(ws)}`);
	}
	check('HD: the title is the same width at every length', tw.length === 0, tw.slice(0, 4).join('; '));
	const tc = grid.filter((c) => c.title === 'mid' && c.state === 'chat');
	const dd = grid.filter((c) => c.title === 'mid' && c.state === 'crystal');
	const dh = grid.filter((c) => c.title === 'mid' && c.state === 'dchat');
	const wc = tc.map((c) => c.m.title.w), wd = dd.map((c) => c.m.title.w), wh = dh.map((c) => c.m.title.w);
	// Option B measured 231 and 207 with the chip's padding at 10px; the chip wears the head-tool role's 9px, so the title has 2px more.
	// 231 was a chat with no mark before its title; since the avatars (5b1584d5b, 16 Oct) every chat's head draws its
	// 18px mark and 6px gap there (measured 30 Oct: mark 25-43, title from 49), so a chat's title is 233 - 24 = 209.
	// With no Diamond to measure the Diamond half is NOT COVERED (named above), and the chat half is still asserted.
	// A Diamond's figures are b4's: the title fills its row beside the tile, and on the chat face shares it with the chip and "more".
	check(`HD: the title is about 209px on a chat${diamond ? ', 292px on a Diamond\'s crystal face and 173px on its chat face' : ''} (within 3px)`,
		wc.length > 0 && (wd.length > 0 || !diamond) && wc.every((w) => Math.abs(w - 209) <= 3) && wd.every((w) => Math.abs(w - 292) <= 3)
		&& wh.every((w) => Math.abs(w - 173) <= 3), `chat ${J(wc)}, crystal ${J(wd)}, Diamond chat ${J(wh)}`);
	check('HD: "Compare the three joinery quotes" is shown whole on a chat', tc.length > 0 && tc.every((c) => !c.m.title.cut), J(tc.map((c) => c.m.title.cut)));
	const cut = cells.filter((c) => c.m.chip && c.m.chip.cut);
	const chipped = cells.filter(drawsChip);
	check('HD: the mode word is never cut', chipped.every((c) => c.m.chip) && cut.length === 0, list(cut, (c) => `${where(c)} "${c.m.chip.txt}"`));
	const bare = cells.filter((c) => !drawsChip(c) && (c.m.more || (c.m.chip && c.m.chip.w > 0)));
	check('HD: a Diamond\'s crystal face draws neither the mode chip nor "more" in its head (its acts are the bar\'s ✎ and ⋯)', bare.length === 0, list(bare, where));
	// "More" and the chip hold one place: more by its left edge everywhere, the chip by its right edge everywhere and
	// by its left edge for one word.
	for (const pgName of ['chat', 'diamond']) {
		const mx = chipped.filter((c) => pageOf(c) === pgName).map((c) => c.m.more ? c.m.more.x : null);
		if (!mx.length) continue;
		check(`HD: "more" is drawn in every ${pgName} head that carries it, in one place`, mx.every((x) => x != null) && Math.max(...mx) - Math.min(...mx) <= 1, `x ${J([...new Set(mx.map((x) => x == null ? 'none' : Math.round(x)))])}`);
	}
	// The figures option B was chosen on, as this run measures them.
	const hts = (st) => [...new Set(cells.filter((c) => c.state === st).map((c) => Math.round(c.m.head.h)))];
	const taps = cells.flatMap((c) => c.m.ctrls.map((o) => o.tap));
	console.log(`  (B row: head ${J(hts('chat'))}/${J(hts('crystal'))}/${J(hts('dchat'))}/${J(hts('select'))} for chat/crystal/dchat/select; title ${J([...new Set(wc.map(Math.round))])}/${J([...new Set(wd.map(Math.round))])}; scrolling cells ${sc.length}; sideways-scroll cells ${hs.length}; overlap cells ${ovs.length}; smallest tap cross ${Math.min(...taps.map((t) => t.w))}x${Math.min(...taps.map((t) => t.h))})`);
	for (const pgName of ['chat', 'diamond']) {
		const cr = chipped.filter((c) => pageOf(c) === pgName).map((c) => c.m.chip ? c.m.chip.x + c.m.chip.w : null);
		if (!cr.length) continue;
		check(`HD: the mode chip ends in one place in every ${pgName} head`, cr.every((x) => x != null) && Math.max(...cr) - Math.min(...cr) <= 1, `right edge ${J([...new Set(cr.map((x) => x == null ? 'none' : Math.round(x)))])}`);
	}
	const cl = [];
	for (const [k, cs] of group(chipped.filter((c) => c.m.chip && !c.locale), (c) => `${pageOf(c)} ${c.m.chip.txt}`)) {
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
		// Where the page is: a history move that ran off the app's first entry leaves a document with none of this.
		app: !!window.DaimondShell, depth: history.length, stack: (document.getElementById('app') || { dataset: {} }).dataset.stack || null,
		helpRow: cs ? { pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(' '), gap: cs.columnGap, icon: ic ? Math.round(ic.getBoundingClientRect().width) : null } : null };
}, HOME);
await section('HX', async () => {
	DESK = await open({ name: 'shelldesk', route: ROUTE });
	await DESK.page.setViewportSize({ width: 1300, height: 900 });
	await sleep(1500);
	if (await DESK.page.locator('#admin-close').isVisible()) await DESK.page.click('#admin-close'); await sleep(300);
	let f = await deskFacts(DESK.page);
	check('HX: at 1300x900 there is no "more", every tool sits home in the head\'s right-hand cluster, and the menu is shut',
		!f.more && f.away.length === 0 && f.menuShut, J(f));
	await DESK.page.click('#help-btn'); await sleep(300);
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

	// Widened with the menu up over a New Chat, the menu's entry and the turn page's both come off. Each owner of
	// the one history once stepped back for itself in the same task, and the two steps walked off the front of
	// the app (A4g, {app:false}). Real taps only: New Chat on home, then "more".
	await goHome();
	await tap('#home-compose-btn'); await sleep(900);
	if (!(await ev(() => { const m = document.getElementById('chead-more'); return !!(m && m.getClientRects().length); }))) {
		await S.page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
		await chat(S, 'hello');
	}
	await tap('#chead-more');
	const up = await readMenu('#chead-more-menu');
	const h0 = await ev(() => ({ len: history.length, st: history.state }));
	need(up && up.open && h0.st && h0.st.dlayers > 0 && Array.isArray(h0.st.stack) && h0.st.stack.length > 1,
		'the menu over the turn page did not stand on its own entry: ' + J(h0));
	await S.page.setViewportSize({ width: 1300, height: 900 }); await sleep(2500);
	const g = await S.page.evaluate(() => ({ app: !!window.DaimondShell && !!document.getElementById('app'),
		stack: history.state && history.state.stack, layers: history.state ? history.state.dlayers || 0 : null,
		above: window.DaimondHistory ? window.DaimondHistory.above() : null,
		pages: window.DaimondStack ? window.DaimondStack.pages() : null })).catch((e) => ({ app: false, err: String(e).slice(0, 80) }));
	// The floor is the entry the page booted on (history.js): booted at a computer's width it carries no state of
	// ours, so its stack reads null; booted on a phone, ['home']. Either way nothing lies between it and the page.
	check('HX: widened with the menu up over a New Chat, the page is still the app, on its floor entry (home, no layer)',
		g.app && g.above === 0 && !g.layers && J(g.pages) === J(['home']) && (g.stack === null || J(g.stack) === J(['home'])), J(g));
	await S.page.setViewportSize({ width: 390, height: 844 }); await sleep(900);
});

// ── SP ──────────────────────────────────────────────────────────────────────
// Settings on a phone is a page of the stack (Stack A3), so nothing that opens it may put up the modal or leave the
// drawer standing over home. Its own session: the boot under test is the one `phone()` tidies away.
const settingsAt = (P) => P.evaluate(() => ({ top: DaimondStack.top(), depth: DaimondStack.depth(),
	admin: !!document.querySelector('#admin.admin-open'), modal: document.getElementById('settings-modal').style.display }));
await section('SP', async () => {
	const T = await open({ name: 'shellsp', touch: true, ...(BROWSER === 'webkit' ? { ua: PHONE_UA } : { isMobile: true }), route: ROUTE });
	try {
		const P = T.page;
		const tapIn = async (sel) => {
			const box = await P.evaluate((q) => {
				const e = [...document.querySelectorAll(q)].find((x) => x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden');
				if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
			}, sel);
			need(box, `nothing visible to tap for ${sel}`);
			await P.touchscreen.tap(box.x, box.y); await sleep(600);
		};
		// A phone opens on home: nothing about a connected profile needs the person in Settings (A4k).
		const atHome = (b) => b.top === 'home' && b.depth === 1 && !b.admin && b.modal === 'none';
		const b0 = await settingsAt(P);
		await P.setViewportSize({ width: 390, height: 844 }); await sleep(1200);
		const b1 = await settingsAt(P);
		check('SP: a connected phone opens on home, Settings shut and the modal down', atHome(b1), J({ wide: b0, phone: b1 }));
		await P.reload(); await sleep(1800);
		const b2 = await settingsAt(P);
		check('SP: booted at a phone\'s width, a connected phone opens on home', atHome(b2), J(b2));
		// Settings up at a computer's width, then the window narrowed past 760px.
		await P.setViewportSize({ width: 1500, height: 950 }); await sleep(900);
		await tapIn('#user-row');
		const w = await settingsAt(P);
		need(w.admin, 'the identity row did not open Settings at a computer\'s width: ' + J(w));
		await P.setViewportSize({ width: 390, height: 844 }); await sleep(1200);
		const b3 = await settingsAt(P);
		check('SP: narrowed to a phone with Settings up, it stands on the Settings page, never home under Admin or the modal',
			b3.modal === 'none' && b3.admin && (b3.top === 'settings' || b3.top === 'settings-group'), J({ wide: w, phone: b3 }));
		await P.evaluate(() => window.DaimondShell.home()); await sleep(500);
		await tapIn('#user-row');
		await tapIn('.sg-door[data-sgroup="models"]');
		const g = await settingsAt(P);
		need(g.top === 'settings-group', 'the Models door did not push its group page: ' + J(g));
		for (const [row, name] of [['#astat-account', 'Credits'], ['#astat-model', 'Models']]) {
			await tapIn(`.sg-group-page ${row}`);
			const a = await settingsAt(P);
			const shown = await P.evaluate((q) => { const v = document.querySelector('.sg-view-page ' + q); return !!v && v.getClientRects().length > 0; }, name === 'Credits' ? '#admin-credits' : '#admin-models');
			check(`SP: ${name}, tapped in the Models group, is a page pushed over it, with the modal down`,
				a.modal === 'none' && a.admin && a.top === 'settings-view' && a.depth === g.depth + 1 && shown, J({ ...a, shown }));
			await tapIn('#stack-back');
			const b = await settingsAt(P);
			check(`SP: Back from ${name} is the Models group again`, b.top === 'settings-group' && b.depth === g.depth, J(b));
		}
		for (let i = 0; i < 4 && (await settingsAt(P)).top !== 'home'; i++) await tapIn('#stack-back');
		const h = await settingsAt(P);
		check('SP: the bar\'s Back goes down the stack to home, Settings shut and the modal down', h.top === 'home' && !h.admin && h.modal === 'none', J(h));
	} finally { await letGo(T); }
});

// ── DR ──────────────────────────────────────────────────────────────────────
// The home page (the rail; it was the drawer until Stack A2) is the phone's list of chats and Diamonds. Showing a
// destination on the floor pushes the turn page over it: a New Chat, a New Diamond, a picked chat or Diamond, a footer
// chip. Nothing that chooses nothing does. "drawerIs(true)" below reads "the home page is in view".
const hitFloor = () => ev(() => {
	// The point at the middle of the composer (or, with no composer on screen, of the head's title) must belong to the
	// panel the person is about to use, and not to the home page or anything else laid over it.
	const pick = (document.getElementById('chat-input') && document.getElementById('chat-input').getClientRects().length && document.getElementById('chat-input'))
		|| document.querySelector('.panel.ai .ctitle');
	if (!pick) return { found: false };
	const r = pick.getBoundingClientRect(), h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
	return { found: true, target: pick.id || pick.className, hit: h ? (h.id || h.className || h.tagName) : null, ok: !!h && (h === pick || pick.contains(h)) };
});
const drawerIs = (home) => ev((o) => (document.getElementById('app').dataset.stack === 'home') === o, home);
const openDrawer = async () => { if (!(await drawerOpen())) { await tap('#stack-back'); await sleep(450); } };
const hist = () => ev(() => ({ len: history.length, stack: history.state && history.state.stack, top: window.DaimondStack.top() }));
await section('DR', async () => {
	await chatReady();
	await closeDrawer();
	// The bar: no hamburger; Back on the turn page goes home, and the browser's Back undoes a push.
	check('DR: no hamburger on the phone bar', await ev(() => !document.getElementById('drawer-btn')));	// keeps: drawer-btn asserts it is gone (A2)
	const h0 = await hist();
	check('DR: the turn page is a history entry over home', h0.top === 'turn' && J(h0.stack) === J(['home', 'turn']), J(h0));
	await openDrawer();
	check('DR: a tap on the bar\'s Back goes to the home page, and Back is hidden there', (await drawerIs(true)) && await ev(() => document.getElementById('stack-back').hidden), J(await hist()));
	await ev(() => window.DaimondShell.turn()); await sleep(500);
	const h1 = await hist();
	await S.page.goBack(); await sleep(600);
	const h2 = await hist();
	check('DR: the browser\'s Back pops the turn page to home', h2.top === 'home' && (await drawerIs(true)), J({ h1, h2 }));
	await tap('#new-session-btn'); await sleep(900);
	await S.page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 }).catch(() => {});
	let f = await hitFloor();
	check('DR: New Chat pushes the turn page, and the composer is what a tap on it reaches', (await drawerIs(false)) && f.ok, J({ drawerOpen: await drawerIs(true), ...f }));
	await shot('DR_newchat', { x: 0, y: 0, width: 390, height: 844 });
	// Picking a chat: another one (the rail's own click pushes the turn), and the one already open (it returned early).
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
		check(`DR: picking ${which === 'other' ? 'another chat' : 'the chat that is already open'} shows the turn page`, await drawerIs(false), J(await hitFloor()));
	}
	// New Diamond: the dialog, a name, OK.
	await openDrawer();
	await tap('#new-diamond-btn'); await sleep(700);
	const dlg = await ev(() => { const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop(); if (!card) return false; const inp = card.querySelector('input.dlg-input'); if (!inp) return false; inp.value = 'Shell ' + Date.now().toString(36); inp.dispatchEvent(new Event('input', { bubbles: true })); card.setAttribute('data-ps-dlg', '1'); return true; });
	need(dlg, 'the New Diamond dialog did not come up');
	await tap('[data-ps-dlg] .dlg-ok');
	await sleep(2200);
	f = await hitFloor();
	check('DR: New Diamond pushes the turn page, and the Diamond is what a tap on the floor reaches', (await drawerIs(false)) && f.ok, J({ drawerOpen: await drawerIs(true), ...f }));
	await shot('DR_newdiamond', { x: 0, y: 0, width: 390, height: 844 });
	// A footer chip, from home. The Diamonds chip is the one that shows home; Workspace is a dock destination.
	await toChat(); await closeDrawer();
	await openDrawer();
	// A footer chip is under the home page on a phone, so a thumb cannot reach it: it is pressed by script, as the
	// gate's own chip taps are, and the seam must still push the turn page.
	const pressed = await ev(() => { const c = document.querySelector('#mnav .ptag[data-panel="work"]'); if (!c) return false; c.click(); return true; });	// keeps: click the chip row is under the home page, so no thumb reaches it there; the gate's chip crawl presses it by script and the seam must still push the turn page
	need(pressed, 'there is no Workspace chip in the footer');
	await sleep(900);
	const st = await ev(() => ({ drawer: document.getElementById('app').dataset.stack === 'home', mpanel: document.body.dataset.mpanel, sheet: document.body.classList.contains('sheet-open') }));
	check('DR: a footer chip to Workspace, pressed from home, pushes the turn page and shows Workspace', !st.drawer && (st.mpanel === 'work' || st.sheet), J(st));
	await shot('DR_workspace_chip', { x: 0, y: 0, width: 390, height: 844 });
	await clk('#mnav .ptag[data-panel="ai"]'); await sleep(700);
	// An Admin "Edit the ... prompt" row opens the Doc SHEET. A destination that rises as a sheet returned from `mshow`
	// before the drawer was closed, so the sheet stood over a still-open drawer, and in the gate's mouse crawl the next
	// Admin control was under a `div.modal` (admin: home, 16 Oct). The row must leave the home page, and with the sheet
	// gone the next row must be what a tap on it reaches. On the Stack the rows are Settings' Prompts group, a page of
	// its own (settingsgroups.js, D-20261024-16): home, the name, then the Prompts door, as a person goes.
	await locale('en'); await toChat(); await closeDrawer();
	const toPrompts = async () => { await goHome(); await tap('#user-row'); await sleep(600); await tap('.sg-door[data-sgroup="prompts"]'); await sleep(600); };
	const promptRows = () => ev(() => [...document.querySelectorAll('button')]
		.filter((b) => b.getClientRects().length && /^Edit the .* prompt/.test(b.textContent.trim()))
		.map((b) => { const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.textContent.trim() }; }));
	const coverAt = (p) => ev((q) => {
		const h = document.elementFromPoint(q.x, q.y), m = h && h.closest('div.modal');
		const b = h && h.closest('button'), row = b && /^Edit the .* prompt/.test(b.textContent.trim()) ? b : null;
		return { hit: h ? (h.id || h.className || h.tagName) : null, row: row ? row.textContent.trim() : null, modal: m ? (m.id || m.className) : null };
	}, p);
	await toPrompts();
	let rows = await promptRows();
	need(rows.length >= 2, `Admin shows ${rows.length} "Edit the ... prompt" rows; two are needed`);
	await S.page.touchscreen.tap(rows[0].x, rows[0].y); await sleep(1500);
	const ep = await ev(() => ({ drawer: document.getElementById('app').dataset.stack === 'home', sheet: document.body.classList.contains('sheet-open'),
		modals: [...document.querySelectorAll('div.modal')].filter((m) => m.getClientRects().length && getComputedStyle(m).display !== 'none').map((m) => m.id || m.className) }));
	check(`DR: "${rows[0].label}" leaves the home page for the Doc sheet it opens`, !ep.drawer && ep.modals.length === 0, J(ep));
	await shot('DR_admin_prompt', { x: 0, y: 0, width: 390, height: 844 });
	await ev(() => { if (window.DaimondSheet && DaimondSheet.isOpen()) DaimondSheet.close(); }); await sleep(700);
	const adminAt = () => ev(() => ({ top: window.DaimondStack.top(), depth: window.DaimondStack.depth(), sheet: document.body.classList.contains('sheet-open') }));
	const before = await adminAt();
	await toPrompts();
	rows = await promptRows();
	need(rows.length >= 2, `a person who goes home, presses their name and the Prompts door again does not get the prompt rows back: ${J({ before, after: await adminAt() })}`);
	const cov = await coverAt(rows[1]);
	check(`DR: and afterwards "${rows[1].label}" is what a tap on it reaches, under no modal`, cov.row === rows[1].label && !cov.modal, J(cov));
	await closeDrawer(); await toChat();
	// A fan-out is not a person's tap. `Workers.dispatch` (what the model's spawn_agent reaches) lands in the middle of a turn
	// and reveals the Agents panel, so it can land while a person is on the home page choosing another chat. It must open
	// the panel and leave the home page, and the floor under it, alone. The panel is shut first so that the engine has to open it.
	const fanOut = (name) => ev((n) => {
		try {
			const P = window.DaimondPanels, f = window.DaimondAttach.focus();
			if (P.isOpen('agents')) P.hide('agents');
			window.DaimondWorkers.dispatch('', '', [{ name: n, task: 'Say exactly: DR-FAN-OUT' }], false, null, 0, { chatId: f && f.kind === 'chat' ? String(f.id) : '', chatName: 'DR' });
			return '';
		} catch (e) { return String(e && e.message || e); }
	}, name);
	const faced = () => ev(() => ({ drawer: document.getElementById('app').dataset.stack === 'home', mpanel: document.body.dataset.mpanel, agents: window.DaimondPanels.isOpen('agents') }));
	await toChat(); await closeDrawer(); await openDrawer();
	const floor0 = (await faced()).mpanel;
	const threw = await fanOut('dr-held'); await sleep(900);
	let fo = await faced();
	check('DR: a fan-out landing on the home page opens Agents and leaves home in view, on the same floor', !threw && fo.drawer && fo.agents && fo.mpanel === floor0, J({ threw, floor0, ...fo }));
	await closeDrawer();
	const threw2 = await fanOut('dr-shown'); await sleep(900);
	fo = await faced();
	check('DR: the same fan-out on the turn page still shows Agents (the hold is for home only)', !threw2 && !fo.drawer && fo.mpanel === 'agents', J({ threw2, ...fo }));
	await toChat();
	// What chooses nothing leaves home in view: the status fold (or the tag filter, when tags exist). The Diamonds and
	// Chats folds are gone: a page's lists do not fold (Stack A2).
	await closeDrawer(); await openDrawer();
	check('DR: no fold on the Diamonds or Chats heading', await ev(() => [...document.querySelectorAll('.rail-fold[data-fold="diamonds"], .rail-fold[data-fold="chats"]')].every((b) => !b.getClientRects().length)));
	const sel = await ev(() => { const t = document.querySelector('.tagf-toggle'); return t && t.getClientRects().length ? '.tagf-toggle' : '.rail-fold[data-fold="status"]'; });
	await tap(sel); await sleep(500);
	check(`DR: a tap that chooses nothing (${sel}) leaves home in view`, await drawerIs(true));
	await tap(sel); await sleep(300);
	await closeDrawer();
	// Installed (fix 8 of the Stack review): Playwright cannot emulate `display-mode`, so iOS's own signal,
	// `navigator.standalone`, is stubbed before the page loads; a left-edge touch swipe on the turn page must be a
	// popstate back home. In a tab (above, unstubbed) the browser's own swipe does it, and the page binds none.
	const app = await open({ name: 'shell-pwa', touch: true, ...(BROWSER === 'webkit' ? { ua: PHONE_UA } : { isMobile: true }), route: ROUTE });
	try {
		const pg = app.page;
		await pg.addInitScript(() => { try { Object.defineProperty(navigator, 'standalone', { get: () => true }); } catch (e) { /* none */ } });
		await pg.setViewportSize({ width: 390, height: 844 });
		await pg.reload(); await sleep(1500);
		if (await pg.locator('#admin-close').isVisible()) await pg.tap('#admin-close'); await sleep(300);
		await pg.evaluate(() => { window.__pops = 0; window.addEventListener('popstate', () => { window.__pops++; }); window.DaimondShell.turn(); });
		await sleep(500);
		const was = await pg.evaluate(() => ({ top: window.DaimondStack.top(), sa: navigator.standalone }));
		need(was.top === 'turn' && was.sa === true, `the installed page did not reach its turn page: ${J(was)}`);
		const cdp = BROWSER === 'webkit' ? null : await pg.context().newCDPSession(pg).catch(() => null);
		const swipe = async (pts) => {
			if (cdp) {
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]] });
				for (const p of pts.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] });
				await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
				return;
			}
			// WebKit has no CDP: real Touch objects, dispatched where a finger at the edge would land.
			await pg.evaluate((ps) => {
				const at = (p) => document.elementFromPoint(p.x, p.y) || document.body;
				const mk = (p, el) => new Touch({ identifier: 1, target: el, clientX: p.x, clientY: p.y });
				const el = at(ps[0]);
				const fire = (type, p) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: p ? [mk(p, el)] : [], changedTouches: [mk(p || ps[ps.length - 1], el)] }));
				fire('touchstart', ps[0]);
				for (const p of ps.slice(1)) fire('touchmove', p);
				fire('touchend', null);
			}, pts);
		};
		await swipe([{ x: 6, y: 420 }, { x: 30, y: 421 }, { x: 70, y: 422 }, { x: 110, y: 423 }]);
		await sleep(700);
		const after = await pg.evaluate(() => ({ top: window.DaimondStack.top(), pops: window.__pops, stack: document.getElementById('app').dataset.stack }));
		check('DR: installed, a left-edge swipe on the turn page is a popstate back home', after.top === 'home' && after.pops >= 1 && after.stack === 'home', J(after));
		await swipe([{ x: 200, y: 420 }, { x: 260, y: 421 }, { x: 320, y: 422 }]);
		await pg.evaluate(() => window.DaimondShell.turn()); await sleep(500);
		await swipe([{ x: 200, y: 420 }, { x: 260, y: 421 }, { x: 320, y: 422 }]); await sleep(500);
		check('DR: installed, a swipe from mid-screen does not go back', await pg.evaluate(() => window.DaimondStack.top() === 'turn'));
	} finally { await letGo(app); }
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
				// Normalise: nothing open, and the chip's destination not already where we are -- pressing the chip of
				// the place on screen shows nothing, so there is nothing to bring in (mobile.js markHere scrolls on a
				// change of place only, by design). The strip is the turn page's: it lies under the home page (Stack A2),
				// so the arrival is made from another place on the turn page -- pressed from home, a thumb met the
				// identity row and opened Settings, and every chip after it was measured under that page. Then the strip
				// as far from this chip as it will go.
				if (await ev(() => /^settings/.test(window.DaimondStack.top() || ''))) await goHome();
				await ev(() => { if (document.getElementById('app').dataset.stack === 'home') window.DaimondShell.turn(); });
				await sleep(150);
				if (await ev(() => document.body.classList.contains('sheet-open'))) await clk('#msheet-close');
				await sleep(150);
				await ev(async (q) => {
					const c = document.querySelector(`#mnav .panel-tags .ptag[data-panel="${q.id}"]`);
					if (c && c.classList.contains('on')) document.querySelector(`#mnav .panel-tags .ptag[data-panel="${q.id === 'ai' ? 'work' : 'ai'}"]`).click();	// keeps: click set-up only, the arrival under test is the tap below
				}, { id });
				await sleep(150);
				await ev(async (q) => {
					const s = document.querySelector('#mnav .panel-tags'); s.scrollLeft = q.far ? s.scrollWidth : 0;
				}, { far: i < n / 2 });
				await sleep(150);
				// A thumb presses what it can see: the chip's visible part, or, when the far scroll has put it wholly out
				// of the strip, its edge once the strip is swiped just far enough to show 12px of it.
				const at = await ev((i2) => {
					const st = document.querySelector('#mnav .panel-tags'); const c = st && st.querySelector(`.ptag[data-panel="${i2}"]`);
					if (!c) return null;
					const vis = () => { const a = st.getBoundingClientRect(), b = c.getBoundingClientRect(); return { x0: Math.max(a.left, b.left), x1: Math.min(a.right, b.right), y: b.top + b.height / 2, a, b }; };
					let v = vis();
					if (v.x1 - v.x0 < 8) { st.scrollLeft += v.b.left >= v.a.right ? (v.b.left - v.a.right + 12) : (v.b.right - v.a.left - 12); v = vis(); }
					return v.x1 - v.x0 >= 4 ? { x: (v.x0 + v.x1) / 2, y: v.y } : null;
				}, id);
				if (at) await S.page.touchscreen.tap(at.x, at.y);
				await sleep(450);
				// The rail chip's place is home, where the strip is not on screen: "once shown" does not arise.
				if (await ev(() => window.DaimondStack.top() === 'home')) continue;
				const m = await ev(MEAS, { id, fade: FADE });
				if (m.gone) continue;
				const tol = -0.5;
				if (m.boxLeft < tol || m.boxRight < tol || m.labLeft < tol || m.labRight < tol) bad2.push(`${look}/${code} ${id} (${m.more}) box ${m.box} label ${m.lab} strip ${m.strip}: left clear ${m.boxLeft}, right clear ${m.boxRight}`);
				if (m.inBarFade) barFade.push(`${look}/${code} ${id}`);
				if (look === 'obsidian' && code === 'en' && id === 'work') await shot('ST_work_en', { x: 0, y: 700, width: 390, height: 144 });
			}
			await ev(() => { if (document.getElementById('app').dataset.stack === 'home') window.DaimondShell.turn(); });
			await sleep(150);
			if (await ev(() => document.body.classList.contains('sheet-open'))) await clk('#msheet-close');
			await clk('#mnav .ptag[data-panel="ai"]');
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
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} ok, ${bad.length} failed${NC.length ? ', ' + NC.length + ' NOT COVERED' : ''}${BREAK ? ' (BREAK ' + BREAK + ')' : ''}`);
if (bad.length) { console.log('\nFAILED:\n' + bad.map((b) => '  - ' + b).join('\n')); process.exit(1); }
