// verify_a11y_aria.mjs — what the app tells a screen reader is what is on screen.
//
// The accessible name of every control is read out of CHROME'S OWN accessibility
// tree over CDP (Accessibility.queryAXTree), not computed here. That matters:
// an accname is the result of a precedence chain — aria-labelledby, then
// aria-label, then the element's own text, then title — and a hand-rolled
// approximation of it would agree with the browser right up to the case that is
// actually wrong. Six of Daimond's buttons carry a perfectly good `title` and
// still announce as a punctuation mark, because their text content outranks it.
// Only the real engine says so.
//
// WHAT THIS FILE LOCKS DOWN. Each holds right now and must keep holding.
//
//   1. Disclosure state is real: aria-expanded on the appearance menu button and
//      on the gallery's ⋯ FOLLOWS the popover, checked shut, open and shut again.
//   2. Toggle state is real: aria-pressed on a panel chip and on a gallery pin
//      tracks the thing it describes, checked by toggling it.
//   3. The command palette is a labelled modal: role="dialog", aria-modal="true",
//      an accessible name, and a combobox whose aria-activedescendant points at a
//      list item that exists.
//   4. The two popovers carry role and an accessible name.
//   5. The theme pulldown announces its three bands: an aria-label, three
//      <optgroup>s, and Chrome exposing each band as a named group.
//   6. Icon-only controls: no control's accessible name may be empty or bare
//      punctuation, beyond a frozen census, GLYPHS below. The census may only
//      shrink; a new nameless button fails the run and is named.
//   7. Every inline <svg> inside a control is aria-hidden="true", so an icon is
//      never read out beside the label it is illustrating.
//   8. Every <img> carries an alt; a decorative one carries alt="" AND
//      aria-hidden="true", so it is out of the tree by both routes.
//   9. The one live region there is (the reading-size sample) stays a live region.
//
// KNOWN DEFECTS are printed at the end and do NOT fail the run — they are
// written up with a file:line and a fix in dev/a11y_report.md. Asserting a bug
// as correct would make its fix look like a regression, so they are asserted as
// known instead.
//
// SELF-TEST. The last section strips an aria-label, freezes an aria-expanded,
// unhides an icon svg, removes an alt and removes an aria-modal — five real
// breakages in the live page — and requires the matching check to go red each
// time, then restores and requires green. A check never seen red is not evidence.
//
//   node dev/verify_a11y_aria.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.

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

// ── The frozen census of controls with no usable spoken name ────────
//
// Chrome's accname for each of these is the character printed on it, or nothing
// at all. Most carry a `title` that says the right thing and is outranked by the
// text content. All are written up in dev/a11y_report.md §4 and §10; the census
// is here so the NEXT one fails this run instead of joining them.
const GLYPHS = new Set([
	'button#settings-btn.icon-btn|⚙',
	'button#collapse-btn.chip-btn|−',
	'button#chat-send|➤',
	'button#chat-jump|↑',
	'button#chat-end|↓',
	'button#web-back.icon-btn|‹',
	'button#web-reload.icon-btn|⟳',
	'button#web-pop.icon-btn|↗',
	'iframe#web-frame.web-frame|',		// a Tab stop announced only as "frame"
	// The tag editor's remove-a-tag ×. Its neighbour four rules down --
	// poolCloser at www/js/daimond.js:10091 -- sets the aria-label this one wants.
	'button.tag-x|×',					// www/js/daimond.js:10043
	// Not on screen in this run's state, but the same shape in the source:
	// a bare × with a title and no aria-label.
	//
	// `button.mail-del` came OFF this census in phase G part two: the mailbox's
	// closer cross is gone and Remove sits at the foot of its settings dialog,
	// which is a labelled button with words in it. The fallback path in `mail.js`
	// still draws one for a container that offers no dialog, and this app is not
	// such a container.
	'button.arte-drop|×',				// www/js/daimond.js:10200
]);

// ── The frozen census of images with a half-declaration ─────────────
//
// The app's own pattern for a decorative image is alt="" AND aria-hidden="true";
// these carry only the first half. Written up in dev/a11y_report.md §12.
const IMGS = new Set([
	'img#web-mirror.web-mirror: alt="" but not aria-hidden',
]);

// ── Page-side predicates ────────────────────────────────────────────

/// Inline <svg> that a screen reader will read out beside its own button's label.
const LOUD_ICONS = () => {
	const sig = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
		+ (typeof e.className === 'string' && e.className.trim()
			? '.' + e.className.trim().split(/\s+/).join('.')
			: (e.className && e.className.baseVal ? '.' + e.className.baseVal.trim().split(/\s+/).join('.') : ''));
	return [...document.querySelectorAll('svg')]
		.filter((e) => e.getAttribute('aria-hidden') !== 'true')
		// An svg that IS the control (it carries its own role and label) is fine.
		.filter((e) => !e.getAttribute('role') && !e.getAttribute('aria-label'))
		.filter((e) => e.closest('button,a,[role="button"],label'))
		.map((e) => sig(e.closest('button,a,[role="button"],label')) + ' > svg');
};

/// Images with no text alternative, and decorative ones only half-hidden.
const BAD_IMAGES = () => {
	const sig = (e) => 'img' + (e.id ? '#' + e.id : '')
		+ (typeof e.className === 'string' && e.className.trim()
			? '.' + e.className.trim().split(/\s+/).join('.') : '');
	return [...document.querySelectorAll('img')].map((e) => {
		const alt = e.getAttribute('alt');
		if (alt == null) return sig(e) + ': no alt attribute at all';
		// alt="" declares it decorative; aria-hidden takes it out of the tree by
		// the other route as well, which is what stops a stray title or filename
		// being read in its place.
		if (alt === '' && e.getAttribute('aria-hidden') !== 'true') {
			return sig(e) + ': alt="" but not aria-hidden';
		}
		return null;
	}).filter(Boolean);
};

/// Landmarks and headings, as they stand.
const STRUCTURE = () => ({
	main:     document.querySelectorAll('main,[role="main"]').length,
	h1:       document.querySelectorAll('h1').length,
	// role="heading" counts. The panel heads are <span>s carrying the role rather
	// than <h2>s, because making them elements would have moved the layout, and a
	// count that ignored them would report zero headings on a page that has
	// thirteen -- a report line that is wrong is worse than no report line.
	headings: [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')]
		.filter((e) => e.getClientRects().length).length,
	unnamedRegions: [...document.querySelectorAll('aside,nav,header,footer,[role="region"],[role="complementary"]')]
		.filter((e) => e.getClientRects().length)
		.filter((e) => !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby'))
		.map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')),
	live: [...document.querySelectorAll('[aria-live],[role="status"],[role="alert"],[role="log"]')]
		.map((e) => (e.id || (typeof e.className === 'string' ? e.className : '')) + '=' + (e.getAttribute('aria-live') || e.getAttribute('role'))),
});

// ── The oracle: Chrome's own accname for every control ──────────────

const AX_SEL = 'a[href],button:not([disabled]),input:not([disabled]),'
	+ 'select:not([disabled]),textarea:not([disabled]),'
	+ '[tabindex]:not([tabindex="-1"]),[role="button"],iframe';

/// Every visible control, with the name the browser would speak.
async function accNames(cdp) {
	const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
	const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: AX_SEL });
	const rows = [];
	for (const nodeId of nodeIds) {
		let ax;
		try { ax = await cdp.send('Accessibility.queryAXTree', { nodeId }); } catch (e) { continue; }
		// An ignored node is one the tree does not carry -- a hidden panel's
		// buttons, mostly. Judging those would be judging markup nobody meets.
		const n = (ax.nodes || []).find((x) => !x.ignored);
		if (!n) continue;
		let d;
		try { d = await cdp.send('DOM.describeNode', { nodeId }); } catch (e) { continue; }
		const attrs = d.node.attributes || [];
		const at = {};
		for (let i = 0; i < attrs.length; i += 2) at[attrs[i]] = attrs[i + 1];
		rows.push({
			sig: d.node.nodeName.toLowerCase() + (at.id ? '#' + at.id : '')
				+ (at.class ? '.' + at.class.trim().split(/\s+/).join('.') : ''),
			role: n.role ? n.role.value : '',
			name: n.name ? n.name.value : '',
		});
	}
	return rows;
}

/// Controls whose spoken name is nothing, or nothing but punctuation.
const speechless = (rows) => rows.filter((r) =>
	!r.name.trim() || !/[\p{L}\p{N}]/u.test(r.name));

// ── The run ─────────────────────────────────────────────────────────

// The profile is taken away with the browser: a run that leaves one behind
// leaves ~350 MB behind, and the pile has reached gigabytes before now.
const profile = scratch('pw', 'a11ya-' + process.pid);
const s = await open({ name: 'a11ya', profile });
const closeBrowser = s.close;
s.close = async () => {
	await closeBrowser();
	try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* gone */ }
};
const { page } = s;
await page.waitForTimeout(700);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Accessibility.enable');
await cdp.send('DOM.enable');

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

// ── 1. aria-expanded follows the popover ────────────────────────────
const expOf = (sel) => page.getAttribute(sel, 'aria-expanded');
check(await expOf('#settings-menu-btn') === 'false',
	'the appearance menu button starts collapsed', `aria-expanded=${await expOf('#settings-menu-btn')}`);
await page.click('#settings-menu-btn', { force: true });
await page.waitForTimeout(400);
check(await expOf('#settings-menu-btn') === 'true'
	&& await page.evaluate(() => document.getElementById('settings-menu').hidden === false),
	'opening it sets aria-expanded="true", and the menu really is open');
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
check(await expOf('#settings-menu-btn') === 'false'
	&& await page.evaluate(() => document.getElementById('settings-menu').hidden === true),
	'and Escape puts both back');

// ── 2 & 4. The gallery: state, role, name, and its pins ─────────────
let galReached = false;
for (const width of [1000, 900, 850, 820, 790]) {
	await page.setViewportSize({ width, height: 900 });
	await page.waitForTimeout(450);
	if (await page.$('#panel-more')) { galReached = true; break; }
}
if (galReached) {
	check(await expOf('#panel-more') === 'false', 'the gallery ⋯ starts collapsed');
	check(await page.getAttribute('#panel-more', 'aria-haspopup') === 'dialog',
		'and says what it opens (aria-haspopup="dialog")');
	await page.click('#panel-more', { force: true });
	await page.waitForTimeout(400);
	check(await expOf('#panel-more') === 'true', 'opening the gallery sets aria-expanded="true"');
	check(await page.getAttribute('#panel-gallery', 'role') === 'dialog'
		&& !!(await page.getAttribute('#panel-gallery', 'aria-label')),
		'the gallery carries role="dialog" and an accessible name',
		JSON.stringify(await page.getAttribute('#panel-gallery', 'aria-label')));

	// A pin is a two-state control and must say which state it is in.
	const pin0 = await page.evaluate(() => {
		const p = document.querySelector('#panel-gallery .gal-pin');
		return p ? { pressed: p.getAttribute('aria-pressed'), label: p.getAttribute('aria-label') } : null;
	});
	check(!!pin0 && (pin0.pressed === 'true' || pin0.pressed === 'false') && !!pin0.label,
		'a gallery pin carries aria-pressed and its own label', JSON.stringify(pin0));
	await page.click('#panel-gallery .gal-pin', { force: true });
	await page.waitForTimeout(400);
	const pin1 = await page.evaluate(() => {
		const p = document.querySelector('#panel-gallery .gal-pin');
		return p ? p.getAttribute('aria-pressed') : null;
	});
	check(pin1 !== null && pin1 !== pin0.pressed,
		'and it flips when the pin is used', `${pin0.pressed} → ${pin1}`);
	await page.click('#panel-gallery .gal-pin', { force: true });		// put it back
	await page.waitForTimeout(400);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(350);
	check(await expOf('#panel-more') === 'false', 'and closing it puts aria-expanded back');
} else {
	check(false, 'the gallery ⋯ could be reached by narrowing the window', 'it never appeared');
}
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(450);

// ── 2b. aria-pressed on a panel chip tracks the panel ───────────────
const chipState = () => page.evaluate(() => {
	const c = document.querySelector('#panel-tags .ptag[data-panel="spend"]')
		|| document.querySelector('#panel-tags .ptag:not([disabled])');
	if (!c) return null;
	const p = document.getElementById('panel-' + c.dataset.panel);
	return { panel: c.dataset.panel, pressed: c.getAttribute('aria-pressed'),
		open: !!(p && p.getClientRects().length) };
});
const c0 = await chipState();
check(!!c0 && String(c0.open) === c0.pressed,
	'a panel chip\'s aria-pressed agrees with whether the panel is on screen', JSON.stringify(c0));
await page.click(`#panel-tags .ptag[data-panel="${c0.panel}"]`, { force: true });
await page.waitForTimeout(700);
const c1 = await chipState();
check(!!c1 && c1.pressed !== c0.pressed && String(c1.open) === c1.pressed,
	'and both flip together when the chip is used', `${JSON.stringify(c0)} → ${JSON.stringify(c1)}`);
await page.click(`#panel-tags .ptag[data-panel="${c0.panel}"]`, { force: true });
await page.waitForTimeout(700);

// ── 1b. The tag filter's disclosure ─────────────────────────────────
// The filter only exists once a tag does, so one is put on through the editor
// the way a user does it.
await page.$$eval('.diamond-box', (els) => els[0].click());
await page.waitForTimeout(600);
for (const b of await page.$$('.crystal-act')) {
	if (((await b.textContent()) || '').includes('Tags')) { await b.click({ force: true }); break; }
}
const editorUp = await page.waitForSelector('.tag-editor', { timeout: 8000 }).catch(() => null);
if (editorUp) {
	const sug = await page.$$('.tag-sug .tag-chip');
	if (sug.length) { await sug[0].click({ force: true }); await page.waitForTimeout(700); }
}
const tagf = await page.evaluate(() => {
	const b = document.querySelector('#diamond-filter .tagf-toggle');
	return b ? { exp: b.getAttribute('aria-expanded'), shown: !!b.getClientRects().length } : null;
});
if (tagf && tagf.shown) {
	check(tagf.exp === 'true' || tagf.exp === 'false',
		'the tag pool\'s disclosure declares its state', JSON.stringify(tagf));
	await page.click('#diamond-filter .tagf-toggle', { force: true });
	await page.waitForTimeout(500);
	const tagf2 = await page.evaluate(() => {
		const b = document.querySelector('#diamond-filter .tagf-toggle');
		return { exp: b.getAttribute('aria-expanded'), pool: !!document.querySelector('#diamond-filter .tagf-pool') };
	});
	check(tagf2.exp !== tagf.exp && String(tagf2.pool) === tagf2.exp,
		'and it flips with the pool it discloses', `${tagf.exp} → ${JSON.stringify(tagf2)}`);
} else {
	check(false, 'a tag could be added, so the pool disclosure could be checked',
		'the tag editor was not reachable');
}

// ── 3. The command palette is a labelled modal ──────────────────────
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
await page.evaluate(() => document.getElementById('guide-btn').focus());
await page.keyboard.press('Control+k');
await page.waitForSelector('#palette', { state: 'visible', timeout: 8000 });
await page.waitForTimeout(400);
const pal = await page.evaluate(() => {
	const b = document.querySelector('#palette .pal-box');
	const i = document.getElementById('pal-input');
	const ad = i.getAttribute('aria-activedescendant');
	return {
		role: b.getAttribute('role'), modal: b.getAttribute('aria-modal'),
		label: b.getAttribute('aria-label'),
		inputRole: i.getAttribute('role'), controls: i.getAttribute('aria-controls'),
		activedescendant: ad, pointsAtSomething: !!(ad && document.getElementById(ad)),
		listRole: (document.getElementById('pal-list') || {}).getAttribute
			? document.getElementById('pal-list').getAttribute('role') : null,
	};
});
check(pal.role === 'dialog' && pal.modal === 'true' && !!pal.label,
	'the palette is role="dialog" aria-modal="true" with a name', JSON.stringify(pal.label));
check(pal.inputRole === 'combobox' && pal.listRole === 'listbox' && pal.controls === 'pal-list',
	'its box is a combobox wired to its listbox', JSON.stringify(pal));
check(pal.pointsAtSomething,
	'aria-activedescendant points at a list item that exists', pal.activedescendant);

// ── 5. The theme pulldown announces its bands ───────────────────────
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.click('#settings-menu-btn', { force: true });
await page.waitForTimeout(450);
const theme = await page.evaluate(() => {
	const sel = document.querySelector('#settings-menu .theme-pick');
	if (!sel) return null;
	return { label: sel.getAttribute('aria-label'),
		groups: [...sel.querySelectorAll('optgroup')].map((g) => ({ label: g.label, n: g.children.length })),
		loose: [...sel.children].filter((c) => c.tagName === 'OPTION').length };
});
check(!!theme && !!theme.label, 'the theme pulldown has an accessible name', JSON.stringify(theme && theme.label));
check(!!theme && theme.groups.length === 3 && theme.groups.every((g) => g.label && g.n > 0),
	'and its palettes are in three named bands', JSON.stringify(theme && theme.groups));
check(!!theme && theme.loose === 0,
	'with no palette left outside a band, where it would be announced without one',
	`${theme && theme.loose} loose options`);
// And the browser really exposes the bands, rather than the markup merely holding them.
const themeAx = await (async () => {
	const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
	const q = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '#settings-menu .theme-pick' });
	if (!q.nodeIds.length) return null;
	const ax = await cdp.send('Accessibility.queryAXTree', { nodeId: q.nodeIds[0] });
	return (ax.nodes || []).filter((n) => !n.ignored && n.role && n.role.value === 'group')
		.map((n) => (n.name && n.name.value) || '');
})();
check(!!themeAx && themeAx.length === 3 && themeAx.every(Boolean),
	'and Chrome exposes all three as named groups', JSON.stringify(themeAx));
await page.keyboard.press('Escape');
await page.waitForTimeout(350);

// ── 6. Nothing NEW announces as a glyph ─────────────────────────────
const rows = await accNames(cdp);
const mute = speechless(rows);
const freshMute = mute.filter((r) => !GLYPHS.has(r.sig + '|' + r.name.trim()));
check(freshMute.length === 0,
	`no NEW control announces as nothing or as bare punctuation `
	+ `(${rows.length} controls in the tree, ${mute.length} known)`,
	freshMute.length ? JSON.stringify(freshMute) : null);
note(`${mute.length} controls on screen announce as a punctuation mark or as nothing`,
	'Chrome\'s accname for each is the character printed on it: Send is "➤", Settings is '
	+ '"⚙". Each carries a correct `title`, which loses to text content. See '
	+ 'a11y_report.md §4.');
// The pair of identical "×" delete buttons that used to be noted here is gone:
// phase C replaced the tile\'s closer cross with a cog whose accessible name
// carries the tile\'s own name, and moved Delete into the dialog it opens.

// ── 7. Icons are silent ─────────────────────────────────────────────
const loud = await page.evaluate(LOUD_ICONS);
check(loud.length === 0,
	'every inline icon inside a control is aria-hidden, so it is not read beside the label',
	loud.length ? JSON.stringify(loud.slice(0, 8)) : null);

// ── 8. Images ───────────────────────────────────────────────────────
const badImg = await page.evaluate(BAD_IMAGES);
const freshImg = badImg.filter((x) => !IMGS.has(x));
check(freshImg.length === 0,
	`every <img> has a text alternative, decorative ones hidden both ways (${badImg.length} known)`,
	freshImg.length ? JSON.stringify(freshImg) : null);
if (badImg.length) {
	note('A decorative image is declared decorative only once',
		'www/index.html:337 — #web-mirror carries alt="" but no aria-hidden, unlike the two '
		+ 'beside it which carry both. See a11y_report.md §12.');
}

// ── 9. Structure, and the one live region ───────────────────────────
const st = await page.evaluate(STRUCTURE);
out.push(`----  structure: ${st.main} <main>, ${st.h1} <h1>, ${st.headings} visible headings, `
	+ `${st.unnamedRegions.length} unnamed regions, ${st.live.length} live regions`);
if (!st.main) {
	note('There is no <main>, no <h1>, and not one visible heading',
		'www/index.html:61 opens the app as <div id="app">; the panels are unnamed <aside> '
		+ 'and <section> elements. Region and heading navigation, which is how a screen-reader '
		+ 'user moves around a page this size, reaches nothing. See a11y_report.md §7.');
}
if (st.unnamedRegions.length) {
	note(`${st.unnamedRegions.length} landmark regions have no name`,
		`${JSON.stringify(st.unnamedRegions)} — each <aside> is announced as "complementary" `
		+ 'with nothing to tell it from the next one. See a11y_report.md §7.');
}
note('Nothing that changes on its own is announced',
	'The one aria-live in the app is the reading-size sample (www/js/workspace.js:432). The '
	+ 'streaming answer (#chat-output), the sync chip (www/js/sync.js:245) and the spend meter '
	+ 'all change without a keypress and say nothing. See a11y_report.md §8.');

// The one that exists must keep existing, or the count above means nothing.
await page.click('#settings-menu-btn', { force: true });
await page.waitForTimeout(450);
check(await page.evaluate(() => {
	const e = document.querySelector('#settings-menu .sample');
	return !!e && e.getAttribute('aria-live') === 'polite';
}), 'the reading-size sample is still a polite live region');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ── 10. The modal surfaces that carry no semantics ──────────────────
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-card', { timeout: 8000 });
await page.waitForTimeout(300);
const dlg = await page.evaluate(() => {
	const c = document.querySelector('.dlg-card');
	return { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'),
		label: c.getAttribute('aria-label'), labelledby: c.getAttribute('aria-labelledby'),
		h2: (c.querySelector('h2') || {}).textContent || '' };
});
if (dlg.role !== 'dialog') {
	note('Every dialog in the app is an unlabelled <div>',
		'www/js/daimond.js:3361 builds the card as `modal-card dlg-card` with no role, no '
		+ 'aria-modal and no aria-labelledby, though it already writes an <h2> — '
		+ `"${dlg.h2}" — that would name it. Same at :12134, and in www/index.html:602 `
		+ '(#settings-modal) and :611 (#identity-modal). See a11y_report.md §5.');
} else {
	check(dlg.modal === 'true' && !!(dlg.label || dlg.labelledby),
		'a dialog is a labelled modal', JSON.stringify(dlg));
}
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
if (await page.getAttribute('#web-frame', 'title') === null) {
	note('The Web panel\'s iframe has no title',
		'www/index.html:335 — an untitled frame is announced only as "frame", and it is a '
		+ 'Tab stop. See a11y_report.md §10.');
}
if (await page.getAttribute('#settings-menu-btn', 'aria-haspopup') === 'menu'
	&& await page.getAttribute('#settings-menu', 'role') === 'dialog') {
	note('The appearance button promises a menu and opens a dialog',
		'www/index.html:88 says aria-haspopup="menu"; www/index.html:101 gives the target '
		+ 'role="dialog". See a11y_report.md §11.');
}

// ── 11. SELF-TEST: each check is shown going red ────────────────────
out.push('');
out.push('--- self-test: breaking each property and requiring the check to notice');
const red = (ok, what) => check(ok, `[self-test] ${what}`);

// (a) Take the label off a control that has one, and ask the browser again.
const before = speechless(await accNames(cdp)).length;
await page.evaluate(() => {
	const b = document.getElementById('guide-btn');
	b.dataset.a11ySave = b.getAttribute('aria-label') || '';
	b.removeAttribute('aria-label');
	b.dataset.a11ySaveTitle = b.getAttribute('title') || '';
	b.removeAttribute('title');		// title is the fallback; both must go
});
let mute2 = speechless(await accNames(cdp));
red(mute2.some((r) => r.sig.includes('guide-btn')),
	'a control stripped of its label is caught by the accessibility tree');
await page.evaluate(() => {
	const b = document.getElementById('guide-btn');
	b.setAttribute('aria-label', b.dataset.a11ySave);
	b.setAttribute('title', b.dataset.a11ySaveTitle);
	delete b.dataset.a11ySave; delete b.dataset.a11ySaveTitle;
});
mute2 = speechless(await accNames(cdp));
red(mute2.length === before && !mute2.some((r) => r.sig.includes('guide-btn')),
	'and the tree is back to the known census once the label is restored');

// (b) Freeze aria-expanded, so it lies about a menu that really opened.
await page.evaluate(() => {
	const b = document.getElementById('settings-menu-btn');
	window.__a11yFreeze = () => b.setAttribute('aria-expanded', 'false');
	b.addEventListener('click', window.__a11yFreeze);
});
await page.click('#settings-menu-btn', { force: true });
await page.waitForTimeout(450);
const lying = await page.evaluate(() => ({
	says: document.getElementById('settings-menu-btn').getAttribute('aria-expanded'),
	open: document.getElementById('settings-menu').hidden === false,
}));
red(lying.open && lying.says === 'false',
	'an aria-expanded that stops tracking is caught (menu open, attribute says false)');
await page.evaluate(() => {
	document.getElementById('settings-menu-btn').removeEventListener('click', window.__a11yFreeze);
	delete window.__a11yFreeze;
});
await page.keyboard.press('Escape');
await page.waitForTimeout(350);
await page.click('#settings-menu-btn', { force: true });
await page.waitForTimeout(450);
red(await page.getAttribute('#settings-menu-btn', 'aria-expanded') === 'true',
	'and it tracks again once the interference is removed');
await page.keyboard.press('Escape');
await page.waitForTimeout(350);

// (c) Unhide one icon svg.
await page.evaluate(() => {
	const g = document.querySelector('#new-diamond-btn svg');
	g.removeAttribute('aria-hidden');
	g.id = 'a11y-selftest-svg';
});
let loud2 = await page.evaluate(LOUD_ICONS);
red(loud2.some((x) => x.includes('new-diamond-btn')), 'an icon that is no longer hidden is caught');
await page.evaluate(() => {
	const g = document.getElementById('a11y-selftest-svg');
	g.setAttribute('aria-hidden', 'true'); g.removeAttribute('id');
});
loud2 = await page.evaluate(LOUD_ICONS);
red(loud2.length === 0, 'and every icon is silent again once it is restored');

// (d) Take the alt off an image. Measured against the frozen census, not
// against zero: one standing violation is already known, and a self-test that
// demanded zero would fail on it rather than on the breakage it just made.
const clean = (list) => list.filter((x) => !IMGS.has(x));
await page.evaluate(() => {
	const i = document.querySelector('.brand-wordmark.wm-on-dark');
	i.dataset.a11ySave = i.getAttribute('alt');
	i.removeAttribute('alt');
});
let img2 = await page.evaluate(BAD_IMAGES);
red(img2.some((x) => x.includes('no alt attribute')), 'an <img> with no alt is caught');
await page.evaluate(() => {
	const i = document.querySelector('.brand-wordmark.wm-on-dark');
	i.setAttribute('alt', i.dataset.a11ySave); delete i.dataset.a11ySave;
});
img2 = await page.evaluate(BAD_IMAGES);
red(clean(img2).length === 0, 'and every image is back to the known census once the alt is back');

// A decorative image half-hidden -- alt="" and nothing else -- is the subtler
// half of the same check, and must be caught on its own.
await page.evaluate(() => {
	const i = document.querySelector('#chead-mark');
	i.dataset.a11ySaveAh = i.getAttribute('aria-hidden') || '';
	i.removeAttribute('aria-hidden');
});
img2 = await page.evaluate(BAD_IMAGES);
red(img2.some((x) => x.includes('chead-mark') && x.includes('alt="" but not aria-hidden')),
	'a decorative image hidden by only one of the two routes is caught');
await page.evaluate(() => {
	const i = document.querySelector('#chead-mark');
	i.setAttribute('aria-hidden', i.dataset.a11ySaveAh || 'true'); delete i.dataset.a11ySaveAh;
});
img2 = await page.evaluate(BAD_IMAGES);
red(clean(img2).length === 0, 'and it passes again once both routes are back');

// (e) Take aria-modal off the palette.
await page.evaluate(() => document.getElementById('guide-btn').focus());
await page.keyboard.press('Control+k');
await page.waitForSelector('#palette', { state: 'visible', timeout: 8000 });
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('#palette .pal-box').removeAttribute('aria-modal'));
let pal2 = await page.evaluate(() => {
	const b = document.querySelector('#palette .pal-box');
	return { role: b.getAttribute('role'), modal: b.getAttribute('aria-modal'), label: b.getAttribute('aria-label') };
});
red(!(pal2.role === 'dialog' && pal2.modal === 'true' && !!pal2.label),
	'a modal that loses aria-modal is caught');
await page.evaluate(() => document.querySelector('#palette .pal-box').setAttribute('aria-modal', 'true'));
pal2 = await page.evaluate(() => {
	const b = document.querySelector('#palette .pal-box');
	return { role: b.getAttribute('role'), modal: b.getAttribute('aria-modal'), label: b.getAttribute('aria-label') };
});
red(pal2.role === 'dialog' && pal2.modal === 'true' && !!pal2.label,
	'and it is a labelled modal again once it is restored');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);

await s.close();

console.log(out.join('\n'));
if (known.length) {
	console.log(`\nKNOWN DEFECTS — reported, not failed (see dev/a11y_report.md):\n  - ${known.join('\n  - ')}`);
}
console.log(bad === 0
	? `\nALL ${out.filter((l) => l.startsWith('PASS')).length} CHECKS PASSED`
	: `\n${bad} of ${out.filter((l) => /^(PASS|FAIL)/.test(l)).length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
