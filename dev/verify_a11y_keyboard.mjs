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
//      the focus back to the control that opened it.
//   6. The appearance menu and the panel gallery each move focus into
//      themselves, close on Escape, and return focus to their opener.
//   7. The command palette opens with the caret in its box and swallows Tab, so
//      the keyboard cannot end up typing behind the scrim.
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
// Needs dev/serve.mjs on :8777 and dev/mockllm.mjs on :9099. No gateway.

import fs from 'node:fs';
import { open, newChat, scratch } from './harness.mjs';

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
	'div.session-box.diamond-box',
	'div.session-box.diamond-box.active',
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
	'span.tile-tok',
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
	const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
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
	.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
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
note('The Diamonds list is reachable by keyboard only to DELETE',
	'A .diamond-box is a <div> with a click handler (www/js/daimond.js:9123 diamondBox, '
	+ ':9208 box.addEventListener). Tab through the rail lands on the × delete button and '
	+ 'nothing else — the destructive action is the only one a keyboard can take. '
	+ 'See a11y_report.md §1.');
note('A chat cannot be opened from the keyboard',
	'.tile-label is focusable but only a mouse CLICK selects the chat '
	+ '(www/js/daimond.js:5281); Enter and Space were pressed on a non-current tile and '
	+ 'the chat did not change. See a11y_report.md §2.');
note('The whole Email panel is mouse-only',
	'.mail-acct, .mail-draft, .mail-msg and .mail-folder are <div>s with click handlers '
	+ '(www/js/mail.js:1313, :1349, :1362, :1430). See a11y_report.md §3.');

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
note('The appearance menu and the gallery do not hold Tab',
	'Both are role="dialog" popovers over the app (www/index.html:98, :101), but Tab walks '
	+ 'straight out of them into the page behind and they stay open. See a11y_report.md §9.');

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
await press(page, '#guide-btn');
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
await page.evaluate(() => document.getElementById('guide-btn').focus());
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
// Not a broken copy of the dialog: the appearance menu is a real popover that
// covers the app and lets Tab walk out of it (defect §9 in a11y_report.md), so
// the identical walk that says "trapped" for the dialog must say "escaped" here.
// If it does not, the walk is measuring nothing and the dialog's pass is empty.
await press(page, '#settings-menu-btn');
await page.waitForTimeout(350);
const menuStops = await page.evaluate(COUNT_IN, { sel: '#settings-menu', focusSel: FOCUS_SEL });
let leftMenu = false;
for (let i = 0; i < menuStops + 3; i++) {
	await page.keyboard.press('Tab');
	await page.waitForTimeout(50);
	if (!(await page.evaluate(WHERE, '#settings-menu')).inside) { leftMenu = true; break; }
}
red(leftMenu, `the same trap-walk reports an escape on an untrapped popover (${menuStops} stops)`);
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

console.log(out.join('\n'));
if (known.length) {
	console.log(`\nKNOWN DEFECTS — reported, not failed (see dev/a11y_report.md):\n  - ${known.join('\n  - ')}`);
}
console.log(bad === 0
	? `\nALL ${out.filter((l) => l.startsWith('PASS')).length} CHECKS PASSED`
	: `\n${bad} of ${out.filter((l) => /^(PASS|FAIL)/.test(l)).length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
