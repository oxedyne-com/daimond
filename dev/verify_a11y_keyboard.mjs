// gateway: none
// verify_a11y_keyboard.mjs — the app can be driven, and left, without a mouse.
//
// WHAT THIS FILE LOCKS DOWN. Each of these is a property that holds RIGHT NOW
// and must keep holding; a change that breaks one fails the run.
//
//   1. Tab order is document order. Nothing carries a positive tabindex, and a
//      walk of the first stops lands on the visible controls in the order they
//      are written. A positive tabindex is the one way to make Tab jump about,
//      and it is never worth it.
//   2. Nothing NEW becomes keyboard-invisible. Every element the CSS declares
//      clickable (`cursor: pointer`) that cannot take focus is counted against a
//      frozen census, GHOSTS below. The census may only shrink. A new div with a
//      click handler on it fails this run, loudly, naming the element.
//   3. A surrogate control is a whole control. Anything carrying `role="button"`
//      that is not a <button> must be focusable AND must act on Enter and on
//      Space -- checked by pressing them, not by reading the markup.
//   4. Every focusable control shows a visible focus indicator: its computed
//      style under :focus-visible differs from its resting style in at least one
//      of outline / box-shadow / background / border / colour. `outline: none`
//      with nothing put back fails here.
//   5. A dialog opens focused, keeps Tab inside it, closes on Escape, and gives
//      the focus back to the control that opened it. Two dialogs are held to it: the
//      new-Diamond dialog, and (Rating U2) the popup behind an answer's details control,
//      with Details shut and open, and (Rating U3) the popup behind a changed file's details control, reached
//      by Tab from the file's name.
//   6. The appearance menu and the panel gallery each move focus into
//      themselves, close on Escape, and return focus to their opener.
//   7. The command palette opens with the caret in its box and swallows Tab, so
//      the keyboard cannot end up typing behind the scrim.
//   8. Focus the app moves by itself draws no ring (2026-10-02, "New Chat" after an
//      automatic reload; quality bar rule 1). Section 10: with stay-unlocked forced
//      on, the app is reloaded with NO input and left past the unlock and the 60 ms
//      hand-over; the focused element must not match :focus-visible with a visible
//      outline, the keyboard must not be left on <body>, and the first Tab must land
//      on New Chat WITH its ring; with a chat open the message box itself holds the focus, draws no
//      ring, and a typed character lands in it with no click. The same
//      is read after a menu that a pointer opened is closed by a pointer. Computer
//      (1440x900) and phone (390x844, touch), Obsidian and Porcelain. `--ring-only`
//      runs this section alone.
//
// KNOWN DEFECTS are reported at the end under "KNOWN" and do NOT fail the run.
// They are written up with a file:line and a fix in dev/a11y_report.md. They are
// asserted as known rather than asserted as correct, deliberately: freezing a
// bug into a test makes the fix look like a regression.
//
// SELF-TEST. The last section breaks five of the properties above in the live
// page and requires each check to go red, then restores them and requires green
// again. A check never seen red is not evidence, so the evidence is produced on
// every run.
//
//   node dev/verify_a11y_keyboard.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.

import fs from 'node:fs';
import { open, newChat, chat, scratch, signInAs, connectMock } from './harness.mjs';

const out = [];
let bad = 0;
const check = (ok, what, detail) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail != null ? ' — ' + detail : ''}`);
	if (!ok) bad++;
	return ok;
};
const known = [];
const note = (what, why) => known.push(`${what}\n        ${why}`);

// ── The frozen census of keyboard-invisible clickables ──────────────
//
// Every entry is a real defect, written up in dev/a11y_report.md. The list is
// here so that the NEXT one fails this run rather than joining them quietly.
// Matched on the element's tag+id+class signature.
const GHOSTS = new Set([
	'div#astat-store.astat-row',
	'div#astat-store-native.astat-row',
	'span.astat-dot.off',
	'span.astat-dot.ok',
	'span.astat-dot.warn',
	'span.astat-val',
	'span.astat-aside',
	'div.session-box-header',
	'span.session-box-name',
	'div.session-box-meta',
	'span.session-box-ctx',
	'span.session-box-time',
	'div.session-box.chat-box.active.active',
	'div.session-box.chat-box.active',
	'div.session-box.chat-box.pending',
	'div.tile-active',
	'div.tile-active-top',
	'span.tile-model-chip',
	'div.tile-meter',
	'div.tile-pending',
]);

// ── Page-side predicates ────────────────────────────────────────────
//
// Written as strings so the same source can be handed to page.evaluate both for
// the real check and for the self-test, and so the self-test cannot accidentally
// exercise a different implementation from the one that ships.

const FOCUS_SEL = 'a[href],button:not([disabled]),input:not([disabled]),'
	+ 'select:not([disabled]),textarea:not([disabled]),'
	+ '[tabindex]:not([tabindex="-1"]),summary,iframe,embed';

/// Every element the CSS says is clickable but the keyboard cannot reach.
const GHOSTS_ON_PAGE = (sel) => {
	const sig = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
		+ (typeof e.className === 'string' && e.className.trim()
			? '.' + e.className.trim().split(/\s+/).join('.') : '');
	const vis = (e) => {
		const r = e.getBoundingClientRect();
		if (!r.width || !r.height) return false;
		const cs = getComputedStyle(e);
		return cs.visibility !== 'hidden' && cs.opacity !== '0';
	};
	return [...document.querySelectorAll('*')].filter((e) => {
		if (!vis(e) || e.matches(sel)) return false;
		if (getComputedStyle(e).cursor !== 'pointer') return false;
		// A control nested inside a focusable one is reached with its parent.
		let p = e.parentElement;
		while (p) { if (p.matches(sel)) return false; p = p.parentElement; }
		return true;
	}).map(sig);
};

/// Controls whose focus ring is indistinguishable from their resting state.
///
/// One representative per tag+class, because the app draws hundreds of the same
/// button and the property belongs to the RULE, not to the instance.
const NO_FOCUS_RING = (sel) => {
	const P = ['outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow',
		'backgroundColor', 'borderColor', 'borderWidth', 'borderStyle', 'color',
		'textDecorationLine', 'filter'];
	const snap = (e) => { const cs = getComputedStyle(e); return P.map((p) => cs[p]).join('|'); };
	// `visibility` too, not only the box (TOP-05): a `visibility: hidden`
	// control (the update chip, while current) keeps its rect but cannot
	// truly take focus, so `.focus()` on it is a silent no-op that this
	// check would otherwise read as "the ring never changes".
	const vis = (e) => { const r = e.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
	const sig = (e) => e.tagName.toLowerCase()
		+ (typeof e.className === 'string' && e.className.trim()
			? '.' + e.className.trim().split(/\s+/).join('.') : '') + (e.id ? '#' + e.id : '');
	const prev = document.activeElement;
	const seen = new Set(), bad = [];
	[...document.querySelectorAll(sel)].filter(vis).forEach((e) => {
		// An iframe's ring is the embedding browser's business, not the page's.
		if (e.tagName === 'IFRAME' || e.tagName === 'EMBED') return;
		const key = e.tagName + '|' + (typeof e.className === 'string' ? e.className : '');
		if (seen.has(key)) return;
		seen.add(key);
		const rest = snap(e);
		e.focus();
		if (snap(e) === rest) bad.push(sig(e));
	});
	if (prev && prev.focus) prev.focus();
	return bad;
};

/// Anything wearing role="button" that is not one: is it reachable?
const SURROGATES = () => {
	const sig = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
		+ (typeof e.className === 'string' && e.className.trim()
			? '.' + e.className.trim().split(/\s+/).join('.') : '');
	return [...document.querySelectorAll('[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="tab"]')]
		.filter((e) => !['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName))
		.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
		.map((e) => ({ sig: sig(e), ti: e.getAttribute('tabindex'),
			ok: e.matches('[tabindex]:not([tabindex="-1"])') }));
};

/// Elements pulled out of document order by a positive tabindex.
const POSITIVE_TABINDEX = () => [...document.querySelectorAll('[tabindex]')]
	.filter((e) => Number(e.getAttribute('tabindex')) > 0)
	.map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + '@' + e.getAttribute('tabindex'));

/// Where the focus is, and whether it is inside `sel`.
const WHERE = (sel) => {
	const a = document.activeElement;
	const root = sel ? document.querySelector(sel) : null;
	return {
		name: !a ? '(none)' : a.tagName + (a.id ? '#' + a.id : '')
			+ (typeof a.className === 'string' && a.className.trim()
				? '.' + a.className.trim().split(/\s+/)[0] : ''),
		id: a ? a.id : '',
		inside: !!(root && a && root.contains(a)),
		onBody: !a || a === document.body || a === document.documentElement,
	};
};

/// How many stops a surface holds, so a trap can be walked past the end of it.
const COUNT_IN = ({ sel, focusSel }) => {
	const root = document.querySelector(sel);
	if (!root) return 0;
	return [...root.querySelectorAll(focusSel)].filter((e) => !e.disabled && e.getClientRects().length).length;
};

/// The first `n` visible focusables, in document order.
const DOM_ORDER = ({ sel, n }) => [...document.querySelectorAll(sel)]
	// `getBoundingClientRect` alone missed one real case (TOP-05): the update
	// chip is `visibility: hidden` while current (css/updater.css), which
	// keeps its box (a laid-out width, so nothing else in the row jumps) but
	// takes it OUT of the tab order same as `display: none` would -- real Tab
	// correctly skips it and this filter, without the visibility check, did not.
	.filter((e) => { const r = e.getBoundingClientRect();
		return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; })
	.slice(0, n)
	.map((e) => e.tagName + (e.id ? '#' + e.id : '')
		+ (typeof e.className === 'string' && e.className.trim()
			? '.' + e.className.trim().split(/\s+/)[0] : ''));

// ── Real clicks, because focus is what is being measured ────────────
//
// A scripted `element.click()` fires the handler without moving the focus, so a
// dialog that faithfully restores the focus it found on opening restores the
// BODY and reads as broken. verify_focus.mjs learned this; the same applies here.
const BOX_OF = ({ rootSel, text }) => {
	const root = rootSel ? document.querySelector(rootSel) : document;
	if (!root) return null;
	const el = text
		? [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === text)
		: root;
	if (!el) return null;
	el.scrollIntoView({ block: 'center', inline: 'center' });
	const r = el.getBoundingClientRect();
	if (!r.width || !r.height) return null;
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
async function press(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	const b = await page.evaluate(BOX_OF, { rootSel: sel, text: '' });
	if (!b) throw new Error(`${sel} has no box to click`);
	await page.mouse.click(b.x, b.y);
	await page.waitForTimeout(400);
}

// ── 10. Focus the app moves by itself draws no ring ─────────────────
//
// Chrome draws a button's keyboard ring (:focus-visible) for focus a script moves
// in a page where nobody has clicked or tapped yet. A desktop stays unlocked across
// a reload, so the updater's, sync recovery's and pairing's reloads unlock with no
// click, and the unlock's hand-over (daimond.js hideIdentity) used to focus New Chat
// itself and draw a thick ring round it. This section is in THIS file, not in
// verify_no_left_bars's outline half, because that half reads the computed borders of
// a synthetic stage and cannot reload an unlocked app; the property is about focus,
// which this file owns (dialogs, menus and the palette give focus back here too).
//
// What is read, in a fresh document that has had no input at all:
//   A. after the unlock and the 60 ms hand-over, document.activeElement is not <body>
//      (the keyboard was handed on) and does not draw a ring;
//   B. SELF-TEST, in the same document: focusing New Chat by script the way the old
//      hand-over did DOES read as a ring, so the predicate is shown going red;
//   C. the panel takes the focus back, the first Tab lands on the control the hand-over
//      is for, and THAT draws its ring (a keyboard user still sees where they are);
//   D. in a second fresh document, each menu opener that is on screen is pressed by a
//      pointer and closed by a pointer (the opener again, then a click outside), and the
//      element the close returns focus to draws no ring;
//   E. a keyboard-opened menu or dialog closed by a pointer leaves no ring, closed by a key keeps it;
//   F. (computer) Tab onto a control, press it with a pointer, then press a key: the ring is back on the control that holds the focus.
const RING_OF = () => {
	const a = document.activeElement;
	if (!a || a === document.body) return { onBody: true, name: 'BODY', ring: false };
	const cs = getComputedStyle(a);
	const out = cs.outlineStyle !== 'none' && cs.outlineStyle !== 'hidden'
		&& parseFloat(cs.outlineWidth) > 0 && !/rgba\([^)]*,\s*0\)$/.test(cs.outlineColor);
	const fv = a.matches(':focus-visible');
	const name = a.tagName.toLowerCase() + (a.id ? '#' + a.id : '')
		+ (typeof a.className === 'string' && a.className.trim() ? '.' + a.className.trim().split(/\s+/)[0] : '');
	return { onBody: false, name, id: a.id || '', fv, outline: cs.outlineStyle + ' ' + cs.outlineWidth,
		ring: fv && out };
};
const UNLOCKED_NOW = () => {
	const m = document.getElementById('identity-modal');
	let un = false;
	try { un = DaimondIdentity.isUnlocked(); } catch (e) { un = false; }
	return { un, gate: !!(m && m.offsetParent !== null), ready: !!window.__DAIMOND_READY,
		theme: window.DaimondTheme ? window.DaimondTheme.get() : '' };
};
const WANT_FIRST = () => ['chat-input', 'new-session-btn', 'new-diamond-btn']
	.map((id) => document.getElementById(id))
	.filter((e) => e && e.getClientRects().length).map((e) => e.id)[0] || '';
async function reloadNoInput(page) {
	await page.reload();
	// The wait is for the unlock to be done, not for a fixed time: the gate is hidden,
	// the identity is unlocked, and then 700 ms more, which is past the 60 ms.
	for (const t0 = Date.now(); Date.now() - t0 < 60000; ) {
		const u = await page.evaluate(UNLOCKED_NOW).catch(() => ({}));
		if (u.un && u.ready && !u.gate) break;
		await page.waitForTimeout(200);
	}
	await page.waitForTimeout(700);
	return page.evaluate(UNLOCKED_NOW);
}
async function ringSection() {
	const configs = [
		{ tag: 'desk 1440x900',  w: 1440, h: 900, phone: false },
		{ tag: 'phone 390x844',  w: 390,  h: 844, phone: true },
	];
	const root = scratch('pw', 'ring-' + process.pid);
	for (const cfg of configs) for (const theme of ['obsidian', 'porcelain']) {
		const tag = `${cfg.tag} ${theme}`;
		const profile = `${root}/${cfg.phone ? 'phone' : 'desk'}-${theme}`;
		const r = await open({ name: 'ring', profile, connect: false, signIn: false,
			touch: cfg.phone, isMobile: cfg.phone });
		const pg = r.page;
		await pg.setViewportSize({ width: cfg.w, height: cfg.h });
		// Stay-unlocked ON before the account is made, so the unlocked session is kept in
		// tab storage: a phone's default is OFF, and a desktop's is ON.
		await pg.evaluate(() => localStorage.setItem('daimond-stay-unlocked', '1'));
		await signInAs(r, 'ring');
		await pg.evaluate((t) => { window.DaimondLook && window.DaimondLook.set('daylight'); window.DaimondTheme.set(t); }, theme);
		await pg.waitForTimeout(400);
		const tap = async (x, y) => (cfg.phone ? pg.touchscreen.tap(x, y) : pg.mouse.click(x, y));
		const centre = (sel) => pg.evaluate((q) => {
			const e = document.querySelector(q);
			if (!e || !e.getClientRects().length) return null;
			const b = e.getBoundingClientRect();
			if (!b.width || !b.height || b.right < 0 || b.left > innerWidth || b.bottom < 0 || b.top > innerHeight) return null;
			return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
		}, sel);
		// Two arrangements: no chat open (New Chat is the first stop), and a chat open on the
		// computer (the message box is). A phone keeps to the first, where the drawer holds New Chat.
		const arrangements = cfg.phone ? ['no chat'] : ['no chat', 'chat open'];
		for (const arr of arrangements) {
			const at = `${tag}, ${arr}`;
			if (arr === 'chat open') await newChat(r);
			// A. the unattended reload.
			const u = await reloadNoInput(pg);
			check(u.un && !u.gate, `${at}: the reload came back unlocked with no input (stay-unlocked on)`,
				`unlocked ${u.un}, gate showing ${u.gate}`);
			check(u.theme === theme, `${at}: the look survived the reload`, `theme ${u.theme}`);
			const want = await pg.evaluate(WANT_FIRST);
			const a = await pg.evaluate(RING_OF);
			check(!a.onBody, `${at}: the unlock hands the keyboard on, not left on <body>`, `focus is on ${a.name}`);
			check(!a.ring, `${at}: nothing the app focused by itself draws a ring after an unattended reload`,
				`${a.name}, :focus-visible ${a.fv}, outline ${a.outline}`);
			if (arr === 'chat open') {
				// The message box is a text field: it takes the focus itself, draws no ring, and a
				// character typed with no click lands in it (typing is the input, so it comes last).
				check(a.id === 'chat-input', `${at}: the unlock leaves the focus in the message box`, `focus is on ${a.name}`);
				await pg.keyboard.type('x');
				const v = await pg.evaluate(() => { const c = document.getElementById('chat-input'); const v = c ? c.value : null; if (c) c.value = ''; return v; });
				check(v === 'x', `${at}: a character typed with no click lands in the composer`, `value ${JSON.stringify(v)}`);
				continue;
			}
			// B. the predicate goes red on the old hand-over, in this same document.
			await pg.evaluate(() => { const b = document.getElementById('new-session-btn'); if (b) b.focus(); });
			const old = await pg.evaluate(RING_OF);
			check(old.ring, `${at}: SELF-TEST: focusing New Chat by script, as the old hand-over did, reads as a ring`,
				`${old.name}, :focus-visible ${old.fv}, outline ${old.outline}`);
			// C. the panel takes the focus back; Tab lands on the control, with its ring.
			await pg.evaluate(() => { const h = document.querySelector('.focus-home'); if (h) h.focus(); });
			await pg.keyboard.press('Tab');
			await pg.waitForTimeout(150);
			const c = await pg.evaluate(RING_OF);
			check(want !== '' && c.id === want, `${at}: the first Tab after the unlock lands on ${want || '(nothing on screen)'}`,
				`focus is on ${c.name}`);
			// A text field marks focus by its caret and its border colour (check 4 holds it to
			// that), not by an outline, so for the message box landing on it is the whole claim.
			check(c.ring || /^(textarea|input)/.test(c.name),
				`${at}: and the keyboard user sees where they are (the button's ring, or the field's caret)`,
				`${c.name}, outline ${c.outline}`);
		}
		// D. a menu a pointer opened, closed by a pointer, in a fresh document with no input.
		await reloadNoInput(pg);
		let tested = 0;
		for (const op of ['#help-btn', '#settings-menu-btn', '#panel-more', '#drawer-btn', '#chead-more']) {
			for (const how of ['the opener again', 'a click outside']) {
				const o = await centre(op);
				if (!o) continue;
				await tap(o.x, o.y);
				await pg.waitForTimeout(350);
				const open1 = await pg.evaluate((q) => document.querySelector(q).getAttribute('aria-expanded') === 'true', op);
				if (!open1) continue;
				if (how === 'the opener again') await tap(o.x, o.y);
				else {
					const out = await centre('#current-session-name') || { x: 4, y: cfg.h - 4 };
					await tap(out.x, out.y);
				}
				await pg.waitForTimeout(350);
				const d = await pg.evaluate(RING_OF);
				tested++;
				check(!d.ring, `${tag}: ${op} opened by a pointer and closed by ${how} leaves no ring`,
					`${d.name}, :focus-visible ${d.fv}, outline ${d.outline}`);
			}
		}
		check(tested > 0, `${tag}: at least one pointer-opened menu was exercised`, `${tested} open-close pairs`);
		// E. The keyboard opens, the pointer closes (P6, 2026-10-02): the opener is given the focus back, and it rings only if the close
		// was by key. Chrome keeps :focus-visible on a control a key focused and a pointer then pressed (the dialog's own close control,
		// focused by the Enter that opened it), and a script focus inherits it, so the opener drew a ring after a mouse close.
		// The rating popup needs an answer to rate, so it is a computer case; the Guarded chip's menu is read on both.
		await reloadNoInput(pg);
		if (!cfg.phone) {
			await connectMock(r);
			await newChat(r, { reuse: true });
			await chat(r, '@text RING-E an answer to rate');
		}
		const focusOn = (q) => pg.evaluate((sel) => {
			const e = [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length).pop();
			if (!e) return false;
			e.scrollIntoView({ block: 'center', inline: 'center' });
			e.focus();
			return document.activeElement === e;
		}, q);
		const E = [['the Guarded chip', '#hand-mode-chip', 'opener']].concat(cfg.phone ? [] : [['the rating details control', '#chat-output .ctile-rate-more', 'focused']]);
		for (const [name, q, at] of E) for (const how of ['a pointer press', 'Escape']) {
			if (!(await focusOn(q))) { check(false, `${tag}: ${name} takes keyboard focus`, 'not on screen, or it would not focus'); continue; }
			await pg.keyboard.press('Enter');
			await pg.waitForTimeout(500);
			// A dialog is closed by pressing what holds the focus (its own close control); a menu by pressing its opener again.
			const held = await pg.evaluate(({ a2, sel }) => { const a = a2 === 'opener' ? document.querySelector(sel) : document.activeElement; if (!a || a === document.body) return null; const b = a.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }, { a2: at, sel: q });
			if (how === 'Escape') await pg.keyboard.press('Escape');
			else if (held) await tap(held.x, held.y);
			await pg.waitForTimeout(500);
			const d = await pg.evaluate(RING_OF);
			if (how === 'Escape') check(d.ring, `${tag}: ${name} opened and closed by the keyboard keeps its ring (the keyboard user keeps their place)`,
				`${d.name}, :focus-visible ${d.fv}, outline ${d.outline}`);
			else check(!d.ring, `${tag}: ${name} opened by the keyboard and closed by a pointer leaves no ring`,
				`${d.name}, :focus-visible ${d.fv}, outline ${d.outline}`);
		}
		// F. Tab, a pointer press, then a key (the 5.3.0 QA, surface 5): Chrome sets :focus-visible on the active element after a key, but
		// the guard's data-nofv stayed from the press, so no ring showed until the focus left. The key must clear it from the control
		// that holds the focus. A computer case: a touch screen's press moves the drawer's focus on (the account row closes it).
		if (!cfg.phone) {
			// From New Chat, the side panel's own order: the chat tiles' controls, then the account row.
			await pg.evaluate(() => { const b = document.getElementById('new-session-btn'); if (b) b.focus(); });
			let at = (await pg.evaluate(RING_OF)); const path = [at.name];
			for (let i = 0; i < 30 && at.id !== 'user-row'; i++) { await pg.keyboard.press('Tab'); at = (await pg.evaluate(RING_OF)); path.push(at.name); }
			check(at.id === 'user-row', `${tag}: Tab reaches the account row`, `focus path ${path.join(' > ')}`);
			check(at.ring, `${tag}: the Tab-focused account row draws its ring`, `${at.name}, :focus-visible ${at.fv}, outline ${at.outline}`);
			const ur = await centre('#user-row');
			if (ur) {
				await tap(ur.x, ur.y);
				await pg.waitForTimeout(300);
				const p1 = await pg.evaluate(RING_OF);
				check(p1.id === 'user-row' && !p1.ring, `${tag}: a pointer press on it leaves the focus there, with no ring`,
					`${p1.name}, :focus-visible ${p1.fv}, outline ${p1.outline}`);
				for (const key of ['Shift', 'ArrowDown']) {
					await pg.keyboard.press(key);
					await pg.waitForTimeout(200);
					const p2 = await pg.evaluate(RING_OF);
					check(p2.id !== 'user-row' || p2.ring, `${tag}: then a key (${key}) draws the ring on the control that holds the focus`,
						`${p2.name}, :focus-visible ${p2.fv}, outline ${p2.outline}, data-nofv ${await pg.evaluate(() => document.activeElement.hasAttribute('data-nofv'))}`);
					if (p2.id !== 'user-row') break;
				}
			} else check(false, `${tag}: the account row is on screen to press`, 'no box');
		}
		await r.close();
		try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* gone */ }
	}
	try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* gone */ }
}

if (process.argv.includes('--ring-only')) {
	await ringSection();
	console.log(out.join('\n'));
	console.log(bad === 0 ? `\nRING: ALL ${out.length} CHECKS PASSED` : `\nRING: ${bad} of ${out.length} FAILED`);
	process.exit(bad === 0 ? 0 : 1);
}

// ── The run ─────────────────────────────────────────────────────────

// The profile is taken away with the browser: a run that leaves one behind
// leaves ~350 MB behind, and the pile has reached gigabytes before now.
const profile = scratch('pw', 'a11yk-' + process.pid);
const s = await open({ name: 'a11yk', profile });
const closeBrowser = s.close;
s.close = async () => {
	await closeBrowser();
	try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* gone */ }
};
const { page } = s;
await page.waitForTimeout(700);

// Two Diamonds and a chat, so the rail holds the repeating rows the audit is
// really about. An empty rail passes every keyboard test by having nothing in it.
async function newDiamond(name) {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(700);
}
await newDiamond('Alpha');
await newDiamond('Beta');
await newChat(s);
await page.waitForTimeout(500);

// Establish keyboard modality once: Chrome only matches :focus-visible when the
// last interaction was a key, and every focus check below depends on it.
await page.keyboard.press('Tab');
await page.waitForTimeout(120);

// ── 1. Tab order is document order ──────────────────────────────────
const positives = await page.evaluate(POSITIVE_TABINDEX);
check(positives.length === 0,
	'nothing carries a positive tabindex, so Tab follows the document',
	positives.length ? JSON.stringify(positives) : null);

// Walked from the very top, stopping short of the stage: the Web panel holds an
// iframe, and a Tab into an iframe leaves document.activeElement on the frame,
// which desynchronises any walk that continues past it.
//
// The walk STARTS by focusing the first control rather than by blurring back to
// the body. Blur leaves Chrome's sequential-navigation starting point where it
// was, so the next Tab carries on from the middle of the document and the walk
// measures nothing.
const N = 18;
await page.evaluate(() => window.scrollTo(0, 0));
const wantOrder = await page.evaluate(DOM_ORDER, { sel: FOCUS_SEL, n: N });
const NOW = () => {
	const a = document.activeElement;
	return a.tagName + (a.id ? '#' + a.id : '')
		+ (typeof a.className === 'string' && a.className.trim()
			? '.' + a.className.trim().split(/\s+/)[0] : '');
};
await page.evaluate((sel) => {
	const first = [...document.querySelectorAll(sel)]
		.find((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
	if (first) first.focus();
}, FOCUS_SEL);
await page.waitForTimeout(80);
const gotOrder = [await page.evaluate(NOW)];
for (let i = 1; i < N; i++) {
	await page.keyboard.press('Tab');
	await page.waitForTimeout(40);
	gotOrder.push(await page.evaluate(NOW));
}
const firstDiff = wantOrder.findIndex((w, i) => w !== gotOrder[i]);
check(firstDiff === -1, `a ${N}-stop Tab walk visits the controls in the order they are written`,
	firstDiff === -1 ? null
		: `stop ${firstDiff + 1}: document says ${wantOrder[firstDiff]}, Tab went to ${gotOrder[firstDiff]}`);

// ── 2. Nothing new is keyboard-invisible ────────────────────────────
const ghosts = await page.evaluate(GHOSTS_ON_PAGE, FOCUS_SEL);
const fresh = [...new Set(ghosts)].filter((g) => !GHOSTS.has(g));
check(fresh.length === 0,
	`no NEW clickable-but-unfocusable element (${new Set(ghosts).size} known, census of ${GHOSTS.size})`,
	fresh.length ? `not in the census: ${JSON.stringify(fresh)}` : null);
// The census may shrink: say so, so it gets tightened rather than left slack.
const goneNow = [...GHOSTS].filter((g) => !ghosts.includes(g));
if (goneNow.length && goneNow.length < GHOSTS.size) {
	out.push(`----  ${goneNow.length} census entries were not on the page this run `
		+ `(either fixed, or that surface was not open): ${JSON.stringify(goneNow.slice(0, 6))}`);
}
// The Diamonds list and the chat tiles were both here, and both are fixed:
// each row carries the role, the tab stop and the Enter/Space handler.
// `dev/verify_railkeys.mjs` makes a Diamond and two chats and presses the keys
// against them -- Enter and Space each open a chat, Enter acts on a Diamond row,
// and the delete button says WHICH Diamond it would delete.
// The Email panel was here, and is not any more: all four row types now carry the
// role, the tab stop and the Enter/Space handler, and `dev/verify_mailkeys.mjs`
// presses the keys against a seeded panel and asserts the application changed. A
// note left behind after its fix makes the fix look like a regression, which is
// exactly what the header of this file says not to do.

// ── 3. A surrogate control is a whole control ───────────────────────
const surro = await page.evaluate(SURROGATES);
const unreachable = surro.filter((x) => !x.ok);
check(unreachable.length === 0,
	`every role="button" surrogate can take focus (${surro.length} on screen)`,
	unreachable.length ? JSON.stringify(unreachable) : null);

// And that it actually acts on the two keys a button acts on.
//
// Measured by whether the key was CONSUMED, not by hunting for a side effect: a
// surrogate that handles Enter calls preventDefault before letting the event go,
// so a probe listener attached after the app's own sees defaultPrevented. That
// is the same question for every surrogate whatever it does, which a side-effect
// test is not.
async function keyConsumed(sel, key) {
	await page.evaluate((s) => {
		window.__a11yDP = null;
		const el = document.querySelector(s);
		if (!el) return;
		window.__a11yProbe = (e) => { window.__a11yDP = e.defaultPrevented; };
		el.addEventListener('keydown', window.__a11yProbe);	// registered last, so it runs last
		el.focus();
	}, sel);
	await page.keyboard.press(key);
	await page.waitForTimeout(200);
	const dp = await page.evaluate(() => window.__a11yDP);
	await page.evaluate((s) => {
		const el = document.querySelector(s);
		if (el && window.__a11yProbe) el.removeEventListener('keydown', window.__a11yProbe);
	}, sel);
	return dp;
}
if (await page.$('.files-mode-chip.act')) {
	for (const key of ['Enter', 'Space']) {
		const took = await keyConsumed('.files-mode-chip.act', key);
		check(took === true, `a role="button" chip acts on ${key}`,
			took === true ? null : 'the key passed straight through — no keydown handler');
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
		// Whatever the chip opened is put away, so the next check starts clean.
		if (await page.$('.dlg-card')) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }
	}
} else {
	check(false, 'a role="button" surrogate was on screen to press', 'none found');
}

// ── 4. Every control shows where the focus is ───────────────────────
const noRing = await page.evaluate(NO_FOCUS_RING, FOCUS_SEL);
check(noRing.length === 0,
	'every focusable control changes visibly when it takes keyboard focus',
	noRing.length ? `no change on: ${JSON.stringify(noRing)}` : null);

// ── 5. A dialog: focused, trapped, escapable, and gives focus back ──
await page.evaluate(() => window.scrollTo(0, 0));
await press(page, '#new-diamond-btn');
await page.waitForSelector('.dlg-card', { timeout: 8000 });
await page.waitForTimeout(300);
let w = await page.evaluate(WHERE, '.dlg-card');
check(w.inside, 'a dialog puts the focus inside itself when it opens', w.inside ? w.name : `focus is on ${w.name}`);

const stops = await page.evaluate(COUNT_IN, { sel: '.dlg-card', focusSel: FOCUS_SEL });
let escapedAt = -1, escapedTo = '';
for (let i = 0; i < stops + 3; i++) {
	await page.keyboard.press('Tab');
	await page.waitForTimeout(50);
	const x = await page.evaluate(WHERE, '.dlg-card');
	if (!x.inside) { escapedAt = i + 1; escapedTo = x.name; break; }
}
check(escapedAt === -1, `Tab cannot walk out of a dialog (${stops} stops, ${stops + 3} presses)`,
	escapedAt === -1 ? null : `Tab ${escapedAt} landed on ${escapedTo}, behind the scrim`);

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
check(!(await page.$('.dlg-card')), 'Escape closes the dialog');
w = await page.evaluate(WHERE, null);
check(w.id === 'new-diamond-btn', 'closing the dialog gives the focus back to the control that opened it',
	`focus is on ${w.name}`);

// ── 5b. Rating U2: the popup behind an answer's details control is a dialog too ─
// It is drawn by `openBodyDialog` (role="dialog", aria-modal, labelled by its heading) with the
// five steps, the tags, Details and Withdraw inside it, and it must meet the same four properties.
// An answer is made first (the chat from `newChat` is empty). The control is reached and pressed by the
// KEYBOARD (focus, then Enter), because this file is about driving the app without a mouse, and because a
// pointer press on an arrow deliberately leaves the focus where it was (the composer keeps it; widget W5), so
// the "control that opened it" is only the control when a key opened it.
await chat(s, '@text A11Y-RATE an answer to rate');
await page.evaluate(() => window.scrollTo(0, 0));
const rateFocused = await page.evaluate(() => {
	const b = [...document.querySelectorAll('#chat-output .ctile-rate-more')].find((x) => x.getClientRects().length);
	if (!b) return false;
	b.scrollIntoView({ block: 'center', inline: 'center' });
	b.focus();
	return document.activeElement === b;
});
check(rateFocused, 'an answer shows a details control that takes keyboard focus', rateFocused ? null : 'none visible, or it would not focus');
if (rateFocused) {
	await page.keyboard.press('Enter');
	await page.waitForSelector('.rate-card', { timeout: 8000 }).catch(() => {});
	await page.waitForTimeout(400);
	const dlg = await page.evaluate(() => {
		const c = document.querySelector('.rate-card');
		if (!c) return null;
		const h = c.getAttribute('aria-labelledby') && document.getElementById(c.getAttribute('aria-labelledby'));
		return { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), name: h ? h.textContent.trim() : '' };
	});
	check(!!dlg && dlg.role === 'dialog' && dlg.modal === 'true' && dlg.name.length > 0,
		'the rating popup is a labelled modal dialog', JSON.stringify(dlg));
	w = await page.evaluate(WHERE, '.rate-card');
	check(w.inside, 'the rating popup puts the focus inside itself when it opens', w.inside ? w.name : `focus is on ${w.name}`);
	for (const state of ['Details shut', 'Details open']) {
		if (state === 'Details open') {
			await page.click('.rate-card .tile-dlg-adv-sum', { force: true });
			await page.waitForTimeout(300);
			w = await page.evaluate(WHERE, '.rate-card');
		}
		const rstops = await page.evaluate(COUNT_IN, { sel: '.rate-card', focusSel: FOCUS_SEL });
		let rEscaped = -1, rTo = '';
		for (let i = 0; i < rstops + 3; i++) {
			await page.keyboard.press('Tab');
			await page.waitForTimeout(50);
			const x = await page.evaluate(WHERE, '.rate-card');
			if (!x.inside) { rEscaped = i + 1; rTo = x.name; break; }
		}
		check(rstops > 0 && rEscaped === -1, `Tab cannot walk out of the rating popup, ${state} (${rstops} stops, ${rstops + 3} presses)`,
			rEscaped === -1 ? null : `Tab ${rEscaped} landed on ${rTo}, behind the scrim`);
	}
	await page.keyboard.press('Escape');
	await page.waitForTimeout(400);
	check(!(await page.$('.rate-card')), 'Escape closes the rating popup');
	w = await page.evaluate(WHERE, null);
	check(/ctile-rate-more/.test(w.name), 'closing the rating popup gives the focus back to the details control that opened it',
		`focus is on ${w.name}`);
}

// ── 5c. Rating U3: a changed file's arrows and details are reached by Tab, and its popup is a dialog ─
// A chat turn that writes two files leaves a Files row (`.turn-files`), and each of its rows carries the same three controls as an
// answer (`.turn-file-rate`: up, down, details). On a computer the group shows at rest, quiet in colour, and takes the accent when a control holds focus;
// a keyboard user must find it by Tab: the row's name, its delta, then the three. The details control opens the "Rate this change"
// popup, which meets the dialog properties of 5 and 5b, and gives the focus back to the control that opened it.
{
	const cdir = await page.evaluate(() => window.DaimondAttach.chatScratch(String(window.DaimondAttach.focus().id)));
	const cw = (p, c) => JSON.stringify({ path: `${cdir}/${p}`, content: c });
	await chat(s, '@tools file_write ' + cw('a11y-n.md', 'a new file\n') + ' ;; file_write ' + cw('a11y-o.md', 'another\n'));
	await page.waitForSelector('#chat-output .turn-files .turn-file-row > .turn-file-rate', { timeout: 10000 }).catch(() => {});
	await page.waitForTimeout(500);
	const row = await page.evaluate(() => {
		const t = [...document.querySelectorAll('#chat-output .turn-files')].pop();
		const c = t && t.closest('.ctile'); if (c) c.classList.remove('collapsed');
		const n = t && t.querySelector('.turn-file-row .turn-file-name');
		if (!n) return false;
		n.scrollIntoView({ block: 'center', inline: 'center' }); n.focus();
		return document.activeElement === n;
	});
	check(row, 'a changed-files row shows a name that takes keyboard focus', row ? null : 'no Files row, or the name would not focus');
	if (row) {
		const seen = [], ops = [];
		for (let i = 0; i < 5; i++) {
			await page.keyboard.press('Tab');
			await page.waitForTimeout(60);
			seen.push(await page.evaluate(() => { const a = document.activeElement; return a ? (a.className && typeof a.className === 'string' ? a.className.split(/\s+/)[0] : a.tagName.toLowerCase()) : ''; }));
			// The group's opacity while this control holds focus (the group is never hidden, at rest or in focus).
			ops.push(await page.evaluate(() => { const a = document.activeElement; const g = a && a.closest('.turn-file-rate'); return g ? +getComputedStyle(g).opacity : -1; }));
		}
		const at = (c) => seen.indexOf(c);
		check(at('turn-file-delta') === 0 && at('ctile-rate-up') === 1 && at('ctile-rate-down') === 2 && at('ctile-rate-more') === 3,
			'Tab from a file name reaches its delta, then the up arrow, the down arrow and the details control, in that order', JSON.stringify(seen));
		const inGroup = ops.filter((o) => o >= 0);
		check(inGroup.length === 3 && inGroup.every((o) => o > 0), 'a file row\'s rating group shows itself while one of its controls holds focus', JSON.stringify(ops));
		// Back onto the details control, and open it by the keyboard.
		const onMore = await page.evaluate(() => { const b = document.querySelector('#chat-output .turn-files .turn-file-row .ctile-rate-more'); if (!b) return false; b.focus(); return document.activeElement === b; });
		if (onMore) {
			await page.keyboard.press('Enter');
			await page.waitForSelector('.rate-card', { timeout: 8000 }).catch(() => {});
			await page.waitForTimeout(400);
			const fd = await page.evaluate(() => {
				const c = document.querySelector('.rate-card');
				if (!c) return null;
				const h = c.getAttribute('aria-labelledby') && document.getElementById(c.getAttribute('aria-labelledby'));
				return { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), name: h ? h.textContent.trim() : '' };
			});
			check(!!fd && fd.role === 'dialog' && fd.modal === 'true' && fd.name.length > 0, 'the popup from a file row is a labelled modal dialog', JSON.stringify(fd));
			w = await page.evaluate(WHERE, '.rate-card');
			check(w.inside, 'the file popup puts the focus inside itself when it opens', w.inside ? w.name : `focus is on ${w.name}`);
			const fstops = await page.evaluate(COUNT_IN, { sel: '.rate-card', focusSel: FOCUS_SEL });
			let fEsc = -1, fTo = '';
			for (let i = 0; i < fstops + 3; i++) {
				await page.keyboard.press('Tab');
				await page.waitForTimeout(50);
				const x = await page.evaluate(WHERE, '.rate-card');
				if (!x.inside) { fEsc = i + 1; fTo = x.name; break; }
			}
			check(fstops > 0 && fEsc === -1, `Tab cannot walk out of the file popup (${fstops} stops, ${fstops + 3} presses)`, fEsc === -1 ? null : `Tab ${fEsc} landed on ${fTo}, behind the scrim`);
			await page.keyboard.press('Escape');
			await page.waitForTimeout(400);
			check(!(await page.$('.rate-card')), 'Escape closes the file popup');
			w = await page.evaluate(WHERE, null);
			const back = await page.evaluate(() => { const a = document.activeElement; return !!(a && a.classList.contains('ctile-rate-more') && a.closest('.turn-file-rate')); });
			check(back, 'closing the file popup gives the focus back to the file row\'s details control', `focus is on ${w.name}`);
		} else check(false, 'a file row\'s details control takes keyboard focus', 'it would not focus');
	}
}

// ── 6. The appearance menu ──────────────────────────────────────────
await press(page, '#settings-menu-btn');
await page.waitForTimeout(350);
check(await page.evaluate(() => document.getElementById('settings-menu').hidden === false),
	'the appearance menu opens');
w = await page.evaluate(WHERE, '#settings-menu');
check(w.inside, 'the appearance menu takes the focus when it opens', w.inside ? w.name : `focus is on ${w.name}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
check(await page.evaluate(() => document.getElementById('settings-menu').hidden === true),
	'Escape closes the appearance menu');
w = await page.evaluate(WHERE, null);
check(w.id === 'settings-menu-btn', 'and the focus goes back to the button that opened it', `focus is on ${w.name}`);

// ── 7. The panel gallery ────────────────────────────────────────────
// The ⋯ button only exists once the chip row has overflowed, so the window is
// narrowed until it does — which is the state a real user meets it in.
let galReached = false;
for (const width of [1000, 900, 850, 820, 790]) {
	await page.setViewportSize({ width, height: 900 });
	await page.waitForTimeout(450);
	if (await page.$('#panel-more')) { galReached = true; break; }
}
if (galReached) {
	await press(page, '#panel-more');
	await page.waitForTimeout(350);
	w = await page.evaluate(WHERE, '#panel-gallery');
	check(w.inside, 'the panel gallery takes the focus when it opens', w.inside ? w.name : `focus is on ${w.name}`);
	// The gallery holds Tab as the appearance menu does (workspace.js keepFocusIn).
	const galStops = await page.evaluate(COUNT_IN, { sel: '#panel-gallery', focusSel: FOCUS_SEL });
	let galLeft = -1;
	for (let i = 0; i < galStops + 3; i++) {
		await page.keyboard.press('Tab');
		await page.waitForTimeout(50);
		if (!(await page.evaluate(WHERE, '#panel-gallery')).inside) { galLeft = i + 1; break; }
	}
	check(galStops > 0 && galLeft === -1, `Tab stays inside the panel gallery (${galStops} stops, ${galStops + 3} presses)`,
		galLeft === -1 ? null : `Tab ${galLeft} left it`);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(350);
	check(await page.evaluate(() => document.getElementById('panel-gallery').hidden === true),
		'Escape closes the panel gallery');
	w = await page.evaluate(WHERE, null);
	check(w.id === 'panel-more', 'and the focus goes back to the ⋯ that opened it', `focus is on ${w.name}`);
} else {
	check(false, 'the ⋯ gallery button could be reached by narrowing the window', 'it never appeared');
}
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(450);

// ── 8. The command palette ──────────────────────────────────────────
// Guide is behind Help since TOP-03, so reaching it is two presses, not one.
await press(page, '#help-btn');
await page.waitForTimeout(250);
await press(page, '#guide-btn');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
// Some ordinary button holds the focus, not a text field -- `help-btn`
// stands in for `guide-btn` here, which Escape (closing Help behind the
// guide's own click) has already left unfocusable.
await page.evaluate(() => document.getElementById('help-btn').focus());
await page.keyboard.press('Control+k');
await page.waitForSelector('#palette', { state: 'visible', timeout: 8000 });
await page.waitForTimeout(300);
w = await page.evaluate(WHERE, '#palette');
check(w.id === 'pal-input', 'the palette opens with the caret in its box', `focus is on ${w.name}`);
await page.keyboard.press('Tab');
await page.waitForTimeout(120);
w = await page.evaluate(WHERE, '#palette');
check(w.id === 'pal-input', 'Tab is swallowed, so the keyboard cannot type behind the scrim',
	`focus is on ${w.name}`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(await page.evaluate(() => document.getElementById('palette').hidden === true),
	'Escape closes the palette');
w = await page.evaluate(WHERE, null);
if (w.onBody) {
	note('Closing the command palette drops the focus on <body>',
		'www/js/workspace.js:737 closePalette() hides the scrim without restoring the focus '
		+ 'it took. The next Tab starts again from the top of the app. See a11y_report.md §6.');
} else {
	check(true, 'closing the palette leaves the focus on something', `focus is on ${w.name}`);
}

// ── 9. SELF-TEST: each check is shown going red ─────────────────────
//
// A check that has never failed is an assertion about the test, not about the
// app. Five properties are broken in the live page, the SAME predicate is run,
// and it must report the breakage; then the page is put back and it must go
// quiet again. Restoration is verified, not assumed.
out.push('');
out.push('--- self-test: breaking each property and requiring the check to notice');

const red = (ok, what) => check(ok, `[self-test] ${what}`);

// (a) The census: give a plain <span> a pointer cursor and no way to focus it.
await page.evaluate(() => {
	const d = document.createElement('span');
	d.id = 'a11y-selftest-ghost';
	d.textContent = 'x';
	d.style.cssText = 'cursor:pointer;display:inline-block;width:20px;height:20px';
	document.querySelector('.top-actions').appendChild(d);
});
let g2 = await page.evaluate(GHOSTS_ON_PAGE, FOCUS_SEL);
red(g2.includes('span#a11y-selftest-ghost'), 'a new unfocusable clickable is caught by the census');
await page.evaluate(() => document.getElementById('a11y-selftest-ghost').remove());
g2 = await page.evaluate(GHOSTS_ON_PAGE, FOCUS_SEL);
red(!g2.includes('span#a11y-selftest-ghost'), 'and the census is quiet again once it is removed');

// (b) The focus ring: strip it from one class of button.
await page.evaluate(() => {
	const st = document.createElement('style');
	st.id = 'a11y-selftest-ring';
	st.textContent = '.addbtn:focus, .addbtn:focus-visible { outline: none !important; box-shadow: none !important; }';
	document.head.appendChild(st);
});
await page.keyboard.press('Tab');
let r2 = await page.evaluate(NO_FOCUS_RING, FOCUS_SEL);
red(r2.some((x) => x.includes('addbtn')), 'a control stripped of its focus ring is caught');
await page.evaluate(() => document.getElementById('a11y-selftest-ring').remove());
await page.keyboard.press('Tab');
r2 = await page.evaluate(NO_FOCUS_RING, FOCUS_SEL);
red(r2.length === 0, 'and every control passes again once the ring is restored');

// (c) A positive tabindex, which is the one way to scramble Tab order.
await page.evaluate(() => document.getElementById('guide-btn').setAttribute('tabindex', '5'));
let p2 = await page.evaluate(POSITIVE_TABINDEX);
red(p2.length === 1 && p2[0].includes('guide-btn'), 'a positive tabindex is caught');
await page.evaluate(() => document.getElementById('guide-btn').removeAttribute('tabindex'));
p2 = await page.evaluate(POSITIVE_TABINDEX);
red(p2.length === 0, 'and the page is clean again once it is removed');

// (d) A role="button" surrogate with its tabindex taken away.
await page.evaluate(() => {
	const c = document.querySelector('.files-mode-chip.act');
	if (c) { c.dataset.a11ySaveTi = c.getAttribute('tabindex') || ''; c.removeAttribute('tabindex'); }
});
let s2 = await page.evaluate(SURROGATES);
red(s2.some((x) => !x.ok && x.sig.includes('files-mode-chip')),
	'a role="button" that lost its tabindex is caught');
await page.evaluate(() => {
	const c = document.querySelector('.files-mode-chip.act');
	if (c && c.dataset.a11ySaveTi) { c.setAttribute('tabindex', c.dataset.a11ySaveTi); delete c.dataset.a11ySaveTi; }
});
s2 = await page.evaluate(SURROGATES);
red(s2.every((x) => x.ok), 'and every surrogate is reachable again once it is restored');

// (e) The key-consumed probe, against the exact shape of the defect it exists to
// catch: a span wearing role="button" and a tabindex, wired to click only.
await page.evaluate(() => {
	const b = document.createElement('span');
	b.id = 'a11y-selftest-click-only';
	b.setAttribute('role', 'button');
	b.setAttribute('tabindex', '0');
	b.textContent = 'press me';
	b.style.cssText = 'position:fixed;left:2px;bottom:2px;z-index:99999';
	b.addEventListener('click', () => { window.__a11ySelftestClicked = true; });
	document.body.appendChild(b);
});
const clickOnly = await keyConsumed('#a11y-selftest-click-only', 'Enter');
red(clickOnly !== true, 'a click-only role="button" is seen NOT to answer Enter');
// The same probe on the real chip, which does answer, so the probe is not simply
// reporting "no" to everything.
const realChip = await keyConsumed('.files-mode-chip.act', 'Enter');
red(realChip === true, 'and the same probe still says yes to a chip that does answer it');
await page.evaluate(() => document.getElementById('a11y-selftest-click-only').remove());
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
if (await page.$('.dlg-card')) { await page.keyboard.press('Escape'); await page.waitForTimeout(250); }

// (f) The focus-trap walk, run against a surface that genuinely does NOT trap.
//
// Not a broken copy of the dialog and not a real popover: the appearance menu and
// the gallery trap Tab now (workspace.js keepFocusIn, defect §9 in a11y_report.md),
// so the positive control is a fixed div wearing role="dialog" with three buttons
// and no key handler at all, as (e) uses a click-only span. The identical walk that
// says "trapped" for the dialog must say "escaped" here. If it does not, the walk is
// measuring nothing and the dialog's pass is empty.
await page.evaluate(() => {
	const d = document.createElement('div');
	d.id = 'a11y-selftest-untrapped';
	d.setAttribute('role', 'dialog');
	d.setAttribute('aria-label', 'self-test control');
	d.style.cssText = 'position:fixed;left:2px;bottom:40px;z-index:99999;background:#fff;padding:4px';
	for (const t of ['one', 'two', 'three']) {
		const b = document.createElement('button');
		b.type = 'button';
		b.textContent = t;
		d.appendChild(b);
	}
	document.body.appendChild(d);
	d.querySelector('button').focus();
});
const ctlStops = await page.evaluate(COUNT_IN, { sel: '#a11y-selftest-untrapped', focusSel: FOCUS_SEL });
let leftCtl = false;
for (let i = 0; i < ctlStops + 3; i++) {
	await page.keyboard.press('Tab');
	await page.waitForTimeout(50);
	if (!(await page.evaluate(WHERE, '#a11y-selftest-untrapped')).inside) { leftCtl = true; break; }
}
red(leftCtl, `the same trap-walk reports an escape on an untrapped dialog (${ctlStops} stops)`);
await page.evaluate(() => document.getElementById('a11y-selftest-untrapped').remove());

// The appearance menu, which does hold Tab: the walk that just reported an escape
// on the control must report none on the real popover.
await press(page, '#settings-menu-btn');
await page.waitForTimeout(350);
const menuStops = await page.evaluate(COUNT_IN, { sel: '#settings-menu', focusSel: FOCUS_SEL });
let leftMenu = false;
for (let i = 0; i < menuStops + 3; i++) {
	await page.keyboard.press('Tab');
	await page.waitForTimeout(50);
	if (!(await page.evaluate(WHERE, '#settings-menu')).inside) { leftMenu = true; break; }
}
red(!leftMenu, `Tab stays inside the appearance menu (${menuStops} stops, ${menuStops + 3} presses)`);
await page.keyboard.press('Escape');
await page.waitForTimeout(350);

// And once more on the dialog, so both answers come from one run of one walk.
await press(page, '#new-diamond-btn');
await page.waitForSelector('.dlg-card', { timeout: 8000 });
await page.waitForTimeout(300);
const stops2 = await page.evaluate(COUNT_IN, { sel: '.dlg-card', focusSel: FOCUS_SEL });
let leftDlg = false;
for (let i = 0; i < stops2 + 3; i++) {
	await page.keyboard.press('Tab');
	await page.waitForTimeout(50);
	if (!(await page.evaluate(WHERE, '.dlg-card')).inside) { leftDlg = true; break; }
}
red(!leftDlg, 'and reports no escape on the dialog, in the same run');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await s.close();

// ── 10. Focus the app moves by itself draws no ring ─────────────────
await ringSection();

console.log(out.join('\n'));
if (known.length) {
	console.log(`\nKNOWN DEFECTS — reported, not failed (see dev/a11y_report.md):\n  - ${known.join('\n  - ')}`);
}
console.log(bad === 0
	? `\nALL ${out.filter((l) => l.startsWith('PASS')).length} CHECKS PASSED`
	: `\n${bad} of ${out.filter((l) => /^(PASS|FAIL)/.test(l)).length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
