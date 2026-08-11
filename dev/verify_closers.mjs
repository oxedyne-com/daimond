// verify_closers.mjs — everything that covers the app carries a way out you can
// reach with a thumb.
//
// `verify_escapable` asks whether a covering surface can be got rid of AT ALL,
// by Escape or by whatever control it offers. This asks the harder question the
// user actually reported: on a phone, is that control THERE, is it WHERE a hand
// looks for it, and is it BIG ENOUGH to hit.
//
//   "The top right settings dialog needs a top right closer cross, important on
//    mobile where there is not much space outside to touch to close."
//
// The appearance menu was 359px wide on a 390px screen. Nineteen pixels of
// margin either side is not a way out, and it had no cross at all. Four other
// surfaces had one under the thumb's floor, and About shipped a full-width Close
// at the bottom of a card you had to scroll.
//
// FIVE PROPERTIES, ASKED OF EVERY DIALOG BY NAME:
//
//   1. A CLOSER EXISTS, and it is on screen. Not "the markup contains one" — a
//      `.ui-close` that CSS has hidden is no closer, which is exactly what the
//      `nocross` break serves.
//
//   2. IT IS IN THE TOP RIGHT of the thing it closes. Measured against the CARD,
//      not the viewport: a cross 8px from the right of the screen is in the
//      wrong place if its card ends 60px short of that. It must also be the
//      rightmost control in its own row, because "top right" is a position
//      relative to the other controls, not only a coordinate.
//
//   3. ITS HIT AREA IS AT LEAST 44x44 at a phone width, and a finger landing
//      anywhere across it reaches it. The box is measured AND probed with
//      `elementFromPoint` at the centre and at the middle of all four edges: a
//      44px box with something laid over half of it measures fine and cannot be
//      pressed. (The corners are not probed — `border-radius` clips hit testing
//      there, correctly.)
//
//   4. PRESSING IT DISMISSES THAT DIALOG AND NOTHING ELSE. Not asserted as
//      "the dialog went": a census of every surface in the app is taken before
//      and after, and the difference has to be exactly the one named. A cross
//      that takes the drawer down with it passes any check that only looks at
//      what it was pointed at.
//
//   5. FOCUS LANDS BACK ON THE OPENER. The opener is focused and clicked, so
//      the keyboard genuinely starts there; after the cross, `activeElement`
//      has to be that same element and not the document body.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file through `page.route`, and the run is
// then expected to FAIL. A break whose anchor does not match exactly once aborts
// rather than passing quietly: a check proved against code that was never broken
// is not proved at all.
//
//   node dev/verify_closers.mjs --break nocross    # 1 fails: the closers vanish
//   node dev/verify_closers.mjs --break small      # 3 fails: they go back to 28px
//   node dev/verify_closers.mjs --break moved      # 2 fails: they slide left
//   node dev/verify_closers.mjs --break closesall  # 4 fails: a cross takes the
//                                                  # drawer down with the dialog
//   node dev/verify_closers.mjs --break nofocus    # 5 fails: focus falls to body
//   node dev/verify_closers.mjs                    # and then, clean
//   node dev/verify_closers.mjs 'Appearance menu'  # one dialog
//
//   eval "$(bash dev/world.sh 2 --up)"
//   node dev/verify_closers.mjs
//
// Needs dev/serve.mjs only. No gateway: every surface here is reachable without
// one, and any that is not is SKIPPED out loud rather than passed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, shot } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

// A phone, and the one the app is drawn for: iPhone 14/15 at its CSS width.
const PHONE = { width: 390, height: 844 };
// The floor. Apple's Human Interface figure, above WCAG 2.2 AA's 24px, because
// this is the control a user reaches for when they are stuck.
const FLOOR = 44;
// What check 5 asks about: the control `pressFrom`/`pressLabel` actually pressed
// to open the dialog, stamped as it went. Naming a selector here instead was
// wrong twice over — a prompt opened from a row INSIDE the admin drawer gives
// the keyboard back to that row, which is right, and a check that named the
// drawer's own opener called it a failure.
const OPENER = '[data-closers-opener]';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const ONLY = process.argv.filter((a, i) =>
	i >= 2 && a !== '--break' && process.argv[i - 1] !== '--break')[0] || '';

let failures = 0, skips = 0;
const skipped = [];
const check = (cond, msg, detail) => {
	console.log((cond ? '    ok   ' : '    FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const skip = (name, why) => {
	console.log('  SKIP ' + name + ' — ' + why);
	skipped.push(name + ': ' + why);
	skips++;
};

// ── The breaks ───────────────────────────────────────────────────────
//
// Each is a real edit to a real file, served in place of it. The CSS anchors are
// deliberately the ONE rule that gives every closer its shape, so a single break
// reaches the static crosses in index.html and the ones built in JS alike — a
// break that only damaged one family would leave the other proving nothing.
const CLOSER_RULE = '\t.ui-close { width: 44px; height: 44px; }';
// The three closers written in static markup carry a size of their own from the
// block each was tuned in, so every break has to name them beside `.ui-close` —
// a break that only reached the shared rule left the sheet and the drawer at
// full size and proved nothing about them.
const ALL = '.ui-close, .msheet-close, #admin-close, .admin-back, .panel.rail .panel-close';
const BREAKS = {
	// No closer anywhere. Check 1 asks whether one is ON SCREEN, so hiding them
	// is the same failure as never building them and covers both families at once.
	nocross: [{ file: 'css/responsive.css', find: CLOSER_RULE,
		with: '\t' + ALL + ' { display: none !important; }' }],
	// The pointer size, on a phone. This is the state the app was in before this
	// work: 28px for the tile dialog, 40 for the sheet and the admin drawer.
	small:   [{ file: 'css/responsive.css', find: CLOSER_RULE,
		with: '\t' + ALL + ' { width: 28px !important; height: 28px !important;'
			+ ' min-width: 28px !important; min-height: 28px !important; }' }],
	// Still there, still big, no longer in the corner. A margin on the flex item
	// pushes it left of wherever its row put it, in every kind of row here.
	moved:   [{ file: 'css/responsive.css', find: CLOSER_RULE,
		with: '\t.ui-close { width: 44px; height: 44px; }\n\t' + ALL
			+ ' { margin-right: 180px !important; }' }],
	// A cross that closes more than the thing it sits on. The rail drawer is the
	// witness for eleven of the thirteen: it is open underneath every dialog this
	// file raises on a phone, and it is what a closer wired one scope too wide
	// takes down with it. The sheet stands in as the drawer's own witness.
	//
	// The two it cannot reach are the Mobile sheet (the drawer would be drawn
	// over the cross being pressed) and the Panel gallery (a desktop width, where
	// there is no phone shell to witness anything). For those two, check 4 still
	// asks that no OTHER surface in the census moved — a smaller claim, made
	// honestly rather than dressed up.
	closesall: [
		{ file: 'js/closer.js',
			find: '\t\t\t\topts.onClose(e);',
			with: '\t\t\t\tdocument.body.classList.remove(\'drawer-open\');\n\t\t\t\topts.onClose(e);' },
		{ file: 'js/workspace.js',
			find: '\tfunction closePalette() {\n\t\tif (!palEl || palEl.hidden) return;',
			with: '\tfunction closePalette() {\n\t\tif (!palEl || palEl.hidden) return;\n\t\tdocument.body.classList.remove(\'drawer-open\');' },
		{ file: 'js/daimond.js',
			find: '\t\tfunction closeAdmin() {\n\t\t\tendForm();',
			with: '\t\tfunction closeAdmin() {\n\t\t\tdocument.body.classList.remove(\'drawer-open\');\n\t\t\tendForm();' },
		{ file: 'js/daimond.js',
			find: '\t\tfunction close() {\n\t\t\tdocument.removeEventListener(\'keydown\', onKey, true);\n\t\t\tif (sayPause) window.removeEventListener(\'daimond:pause\', sayPause);',
			with: '\t\tfunction close() {\n\t\t\tdocument.body.classList.remove(\'drawer-open\');\n\t\t\tdocument.removeEventListener(\'keydown\', onKey, true);\n\t\t\tif (sayPause) window.removeEventListener(\'daimond:pause\', sayPause);' },
		{ file: 'js/mobile.js',
			find: '\tfunction closeDrawer() { document.body.classList.remove(\'drawer-open\'); }',
			with: '\tfunction closeDrawer() { document.body.classList.remove(\'drawer-open\');'
				+ ' var sh = document.getElementById(\'msheet\'); if (sh) sh.classList.remove(\'open\'); }' },
	],
	// The keyboard is dropped on the floor. Both families again: the modal
	// dialogs restore through `refocus`, and the popovers and shells each do it
	// themselves, so all of them are cut.
	nofocus: [
		{ file: 'js/daimond.js',   find: '\tfunction refocus(prev, host) {\n\t\tif (tookFocus(prev)) return;', with: '\tfunction refocus(prev, host) {\n\t\tif (true) return;' },
		{ file: 'js/workspace.js', find: '\t\tif (b) { b.setAttribute(\'aria-expanded\', \'false\'); b.focus(); }', with: '\t\tif (b) { b.setAttribute(\'aria-expanded\', \'false\'); }' },
		{ file: 'js/mobile.js',    find: '\t\t\tif (burger2) { try { burger2.focus(); } catch (x) { /* not on screen */ } }', with: '\t\t\tif (burger2) { /* dropped */ }' },
		{ file: 'js/pairing.js',   find: '\t\t\tif (prev && prev.focus && prev.getClientRects && prev.getClientRects().length) {', with: '\t\t\tif (false) {' },
		{ file: 'js/workspace.js', find: '\t\tif (more) { more.setAttribute(\'aria-expanded\', \'false\'); more.focus(); }', with: '\t\tif (more) { more.setAttribute(\'aria-expanded\', \'false\'); }' },
		{ file: 'js/workspace.js', find: '\t\tif (palPrev && palPrev.focus && document.contains(palPrev)) {', with: '\t\tif (false) {' },
		{ file: 'js/handmode.js',  find: '\t\t\ttry { chip.focus(); } catch (e) { /* gone from the page */ }', with: '\t\t\t/* dropped */' },
		{ file: 'js/mobile.js',    find: '\t\t\ttry { opener.focus(); } catch (e) { /* gone with the redraw */ }', with: '\t\t\t/* dropped */' },
		{ file: 'js/daimond.js',   find: '\t\t\t\ttry { drawerOpener.focus(); } catch (e) { /* gone with the redraw */ }', with: '\t\t\t\t/* dropped */' },
	],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Every edit a break makes to ONE file, applied to one copy of it.
///
/// Grouped by file, and that is load-bearing: `page.route` keeps the LAST
/// handler registered for a pattern, so two specs against `js/daimond.js`
/// registered separately meant only the second edit was ever served — the run
/// then passed, and reported a check as proved that had been asked of working
/// code.
function damaged(file, specs) {
	let src = fs.readFileSync(path.join(WWW, file), 'utf8');
	for (const spec of specs) {
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`break '${BREAK}': the anchor appears ${n} times in ${file}, `
				+ 'so nothing was broken and the run below would prove nothing.');
			process.exit(2);
		}
		src = src.replace(spec.find, spec.with);
	}
	return src;
}

async function serveBreak(page) {
	if (!BREAK) return;
	const byFile = new Map();
	for (const spec of BREAKS[BREAK]) {
		if (!byFile.has(spec.file)) byFile.set(spec.file, []);
		byFile.get(spec.file).push(spec);
	}
	for (const [file, specs] of byFile) {
		const body = damaged(file, specs);
		const type = /\.css$/.test(file) ? 'text/css' : 'application/javascript';
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: type, body }));
	}
}

// ── Reading the page ─────────────────────────────────────────────────

/// Every surface the app can put over itself, and whether it is up.
///
/// This is what makes check 4 mean something. "The dialog closed" is one bit;
/// "and the drawer, the sheet, the menu and the other three modals are exactly
/// as they were" is the property, and it is the one a cross wired to the wrong
/// scope breaks.
const CENSUS = () => {
	const up = (sel) => [...document.querySelectorAll(sel)]
		.some((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
	return {
		'Rail drawer':      document.body.classList.contains('drawer-open'),
		'Mobile sheet':     !!document.querySelector('#msheet.open'),
		'Admin drawer':     !!document.querySelector('.admin.admin-open'),
		'Appearance menu':  up('#settings-menu'),
		'Panel gallery':    up('#panel-gallery'),
		'Permission ladder': up('#hand-mode-pop'),
		'Command palette':  up('#palette'),
		'Pairing':          up('.pair-scrim'),
		// About IS a body dialog and a change-of-passphrase IS a modal, so each
		// pair has to exclude the other or one dismissal reads as two and check 4
		// fails against working code.
		'Tile dialog':      up('.tile-dlg-card:not(.about-card)'),
		'About':            up('.about-card'),
		'Modal dialog':     up('.modal.dlg:not(.tile-dlg):not(#cp-modal) .dlg-card'),
		'Change passphrase': up('#cp-modal'),
		'Identity gate':    up('#identity-modal'),
	};
};

/// The closer's box, where it sits relative to the card it closes, and whether a
/// finger actually lands on it.
const MEASURE = ({ cardSel, closeSel }) => {
	const card = document.querySelector(cardSel);
	if (!card) return { err: 'no card ' + cardSel };
	const x = card.querySelector(closeSel) || document.querySelector(closeSel);
	if (!x || !x.getClientRects().length) return { closer: false };
	const cr = card.getBoundingClientRect();
	const r  = x.getBoundingClientRect();
	// The card's inner right edge, which is where a corner control actually sits.
	// `getBoundingClientRect().right` includes the border AND the scrollbar
	// gutter, and this browser draws a classic 15px scrollbar where a phone draws
	// an overlay -- so measuring from it reported every scrolling card's closer as
	// 15px further in than a person would ever see it.
	const innerRight = cr.left + card.clientLeft + card.clientWidth;
	const innerTop   = cr.top + card.clientTop;
	// The card's own padding is what "flush with the corner" MEANS here, and it
	// is not a constant: the warm skin multiplies every card's 24px by
	// `--space-scale`, so a dialog's closer is 33.6px in from the border on the
	// default skin and would be 24 on the sharp one. A fixed tolerance would have
	// been a check on which skin was in force.
	const cs = getComputedStyle(card);
	const padR = parseFloat(cs.paddingRight) || 0;
	const padT = parseFloat(cs.paddingTop) || 0;

	// The middles of the four edges and the centre. Not the corners: a rounded
	// button correctly does not receive a pointer in the clipped corner, so
	// probing there would demand a square target the design does not want.
	const i = 1;
	const pts = [
		['top', r.left + r.width / 2, r.top + i],
		['bottom', r.left + r.width / 2, r.bottom - i],
		['left', r.left + i, r.top + r.height / 2],
		['right', r.right - i, r.top + r.height / 2],
		['centre', r.left + r.width / 2, r.top + r.height / 2],
	];
	const missed = pts.filter(([, px, py]) => {
		const el = document.elementFromPoint(px, py);
		return !(el && (el === x || x.contains(el)));
	}).map(([k]) => k);

	// Is it the rightmost control in its own row? "Top right" is a place among
	// the other controls, not only a coordinate.
	const row = x.parentElement;
	const sibs = row ? [...row.children].filter((n) => n !== x && n.getClientRects().length) : [];
	const rightmost = sibs.every((n) => n.getBoundingClientRect().right <= r.right + 0.5);

	return {
		closer: true,
		w: +r.width.toFixed(1), h: +r.height.toFixed(1),
		fromRight: +(innerRight - r.right).toFixed(1),
		fromTop:   +(r.top - innerTop).toFixed(1),
		padR: +padR.toFixed(1), padT: +padT.toFixed(1),
		cardW: +cr.width.toFixed(1), cardH: +cr.height.toFixed(1),
		onScreen: r.top >= 0 && r.bottom <= window.innerHeight + 0.5
			&& r.left >= 0 && r.right <= window.innerWidth + 0.5,
		rightmost,
		missed: missed.join(','),
		name: x.getAttribute('aria-label') || '',
	};
};

/// Mark an element as the opener and give it the keyboard, without pressing it.
/// For the three surfaces raised through their own API, where there is no
/// control to click but the keyboard still has to come home to somewhere.
async function stamp(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	await page.evaluate((s) => {
		const e = document.querySelector(s);
		if (!e) return;
		[...document.querySelectorAll('[data-closers-opener]')]
			.forEach((n) => n.removeAttribute('data-closers-opener'));
		e.setAttribute('data-closers-opener', '1');
		try { e.focus(); } catch (x) { /* not focusable */ }
	}, sel);
}

/// Focus an element and click it, so the keyboard really starts where the user's
/// hand did. A bare `.click()` leaves `activeElement` on the body and any focus
/// check afterwards is asking nothing.
async function pressFrom(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	await page.evaluate((s) => {
		const e = document.querySelector(s);
		if (!e) return;
		// Stamped, so check 5 can ask about the control the hand actually pressed
		// rather than about a selector written out here. A dialog opened from a row
		// INSIDE the admin drawer must give the keyboard back to that row, and a
		// check naming the drawer's own opener would have called that a failure.
		[...document.querySelectorAll('[data-closers-opener]')]
			.forEach((n) => n.removeAttribute('data-closers-opener'));
		e.setAttribute('data-closers-opener', '1');
		try { e.focus(); } catch (x) { /* not focusable */ }
		e.click();
	}, sel);
	await page.waitForTimeout(350);
}

/// Press the control inside `rootSel` whose text is exactly `text`. Exact, not
/// Playwright's `:has-text`, which is a case-insensitive SUBSTRING and would
/// press "Change name…" when asked for "Change passphrase…".
async function pressLabel(page, rootSel, text) {
	await page.waitForSelector(rootSel, { timeout: 10000 });
	const hit = await page.evaluate(({ rootSel, text }) => {
		const root = document.querySelector(rootSel);
		if (!root) return false;
		const b = [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === text);
		if (!b) return false;
		[...document.querySelectorAll('[data-closers-opener]')]
			.forEach((n) => n.removeAttribute('data-closers-opener'));
		b.setAttribute('data-closers-opener', '1');
		try { b.focus(); } catch (e) { /* not focusable */ }
		b.click();
		return true;
	}, { rootSel, text });
	if (!hit) throw new Error(`no control labelled "${text}" in ${rootSel}`);
	await page.waitForTimeout(400);
}

/// Open the rail drawer, which is the WITNESS for check 4: on a phone it is
/// reachable from anywhere, it stays up under every dialog below, and a cross
/// wired to the wrong scope takes it down.
async function openDrawer(page) {
	await pressFrom(page, '#drawer-btn');
	await page.waitForTimeout(300);
}

// ── The surfaces ─────────────────────────────────────────────────────
//
// `card` is the box the closer must be in the top right OF. `close` finds the
// closer inside it. `opener` is the selector focus must come back to, and is
// what `reach` presses first. `witness: false` marks the two surfaces that
// cannot have the drawer open underneath them — the drawer itself, and the one
// the drawer would cover.
const DIALOGS = [
	{
		// The one the user reported, by name.
		name:   'Appearance menu',
		open:   { connect: false },
		card:   '#settings-menu',
		close:  '.ui-close',
		reach:  async (page) => {
			await pressFrom(page, '#settings-menu-btn');
			await page.waitForSelector('#settings-menu', { state: 'visible', timeout: 8000 });
		},
	},
	{
		name:   'Permission ladder',
		open:   { connect: false },
		card:   '#hand-mode-pop',
		close:  '.ui-close',
		reach:  async (page) => {
			// The chip lives in the chat head and is hidden until a chat is live;
			// what is being checked is the popover, not what reveals the chip.
			await page.evaluate(() => { const c = document.getElementById('hand-mode-chip'); if (c) c.style.display = ''; });
			await pressFrom(page, '#hand-mode-chip');
			await page.waitForSelector('#hand-mode-pop', { state: 'visible', timeout: 8000 });
		},
	},
	{
		name:   'Command palette',
		open:   { connect: false },
		card:   '.pal-box',
		close:  '#pal-close',
		reach:  async (page) => {
			// Focused and stamped first, so there is a real place for the keyboard to
			// go back to — the palette is opened with a key from wherever the hand
			// already was.
			await stamp(page, '#drawer-btn');
			await page.keyboard.press('Control+k');
			await page.waitForSelector('#palette', { state: 'visible', timeout: 8000 });
		},
	},
	{
		name:   'Modal dialog (Change name)',
		open:   { connect: false },
		card:   '.modal.dlg .dlg-card',
		close:  '.ui-close',
		reach:  async (page) => {
			await pressFrom(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Change name…');
		},
		// The prompt is opened from a row INSIDE the admin drawer, which the
		// dialog's own dismissal leaves standing — so the drawer is in the census
		// twice over and the rail drawer underneath must survive as well.
		census: 'Modal dialog',
	},
	{
		name:   'Confirm dialog (Forget this identity)',
		open:   { connect: false },
		card:   '.modal.dlg .dlg-card',
		close:  '.ui-close',
		reach:  async (page) => {
			await pressFrom(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Forget this identity…');
		},
		census: 'Modal dialog',
	},
	{
		name:   'Change passphrase',
		open:   { connect: false },
		card:   '#cp-modal .dlg-card',
		close:  '.ui-close',
		reach:  async (page) => {
			await pressFrom(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Change passphrase…');
			await page.waitForSelector('.dlg-card', { timeout: 8000 });
			await page.evaluate(() => { const i = document.querySelector('.dlg .dlg-input'); if (i) i.focus(); });
			await page.keyboard.type('testpass1234');
			await page.evaluate(() => { const b = [...document.querySelectorAll('.dlg .dlg-ok')].pop(); if (b) b.click(); });
			await page.waitForSelector('#cp-modal', { timeout: 8000 });
		},
		census: 'Change passphrase',
	},
	{
		name:   'About',
		open:   { connect: false },
		card:   '.about-card',
		close:  '.ui-close',
		reach:  async (page) => {
			await pressFrom(page, '#about-btn');
			await page.waitForSelector('.about-card', { timeout: 8000 });
		},
		census: 'About',
	},
	{
		name:   'Admin drawer',
		open:   { connect: false },
		card:   '.admin-drawer-head',
		close:  '#admin-close',
		reach:  async (page) => {
			await pressFrom(page, '#user-row');
			await page.waitForSelector('.admin.admin-open', { timeout: 8000 });
		},
		census: 'Admin drawer',
	},
	{
		name:   'Pairing (Link another device)',
		open:   { connect: false },
		card:   '.pair-box',
		close:  '.ui-close',
		reach:  async (page) => {
			await stamp(page, '#drawer-btn');
			await page.evaluate(() => window.DaimondPairing && DaimondPairing.showLink());
			await page.waitForSelector('.pair-scrim', { timeout: 8000 });
		},
		census: 'Pairing',
	},
	{
		name:   'Tile dialog (Diamond cog)',
		// A model IS connected here: making a Diamond is how a tile comes to
		// exist, and a rail with no tiles has no cog to press.
		open:   {},
		card:    '.tile-dlg-card',
		close:   '.tile-dlg-x',
		// The drawer is opened HERE rather than by the shared step, because the
		// Admin panel has to be put away first (a connected session opens it) and
		// putting it away is one of the things the `closesall` break makes close
		// the drawer as well. Opened after, the witness is open when it matters.
		witness: false,
		reach:   async (page) => {
			await page.evaluate(() => { const b = document.getElementById('admin-close'); if (b) b.click(); });
			await page.waitForTimeout(250);
			await openDrawer(page);
			await pressFrom(page, '#diamond-list .tile-cog');
			await page.waitForSelector('.tile-dlg-card', { timeout: 8000 });
		},
		census: 'Tile dialog',
	},
	{
		name:    'Mobile sheet',
		open:    { connect: false },
		card:    '.msheet-grab',
		close:   '#msheet-close',
		witness: false,		// the drawer would cover it
		reach:   async (page) => {
			await stamp(page, '#drawer-btn');
			await page.evaluate(() => window.DaimondSheet && DaimondSheet.open('doc'));
			await page.waitForTimeout(700);
		},
		census: 'Mobile sheet',
	},
	{
		name:    'Rail drawer',
		open:    { connect: false },
		card:    '.panel.rail .pptw-head',
		close:   '.panel-close',
		witness: false,		// it IS the witness for everything else
		// The sheet stands in as the thing that must survive: the drawer is drawn
		// over it, so closing the drawer with the sheet up is the case where a
		// closer wired too wide would take two surfaces down at once.
		under:   async (page) => {
			await page.evaluate(() => window.DaimondSheet && DaimondSheet.open('doc'));
			await page.waitForTimeout(600);
		},
		reach:   async (page) => {
			await pressFrom(page, '#drawer-btn');
			await page.waitForTimeout(400);
		},
		census: 'Rail drawer',
	},
	{
		// Desktop and tablet only: the chip row it overflows out of is
		// `display: none` on a phone, so there is no ⋯ to press there at all. It
		// is measured at the width it is REACHABLE at, and its floor is the
		// coarse-pointer one — which is why the harness is asked for a touch
		// context rather than a narrow window.
		name:     'Panel gallery',
		open:     { connect: false },
		viewport: { width: 900, height: 820 },
		touch:    true,
		card:     '#panel-gallery',
		close:    '.ui-close',
		witness:  false,		// no phone shell at this width
		reach:    async (page) => {
			await page.evaluate(() => {
				['doc', 'msg', 'compose'].forEach((p) => {
					try { DaimondPanels.markUsed(p); } catch (e) { /* not built yet */ }
				});
				try { DaimondPanels.reflow(); } catch (e) { /* nothing to reflow */ }
			});
			await page.waitForTimeout(500);
			await pressFrom(page, '#panel-more');
			await page.waitForSelector('#panel-gallery', { state: 'visible', timeout: 8000 });
		},
		census: 'Panel gallery',
	},
];

// ── The run ──────────────────────────────────────────────────────────

for (const d of DIALOGS) {
	if (ONLY && d.name !== ONLY) continue;
	console.log(`\n── ${d.name}`);

	const dir = scratch('pw', 'closers-' + Math.random().toString(36).slice(2, 10));
	let s = null;
	try {
		s = await open({ ...d.open, name: 'closers', profile: dir, touch: !!d.touch,
			route: serveBreak });
		await s.page.setViewportSize(d.viewport || PHONE);
		await s.page.waitForTimeout(400);

		if (d.under) await d.under(s.page);
		if (d.witness !== false) await openDrawer(s.page);

		await d.reach(s.page);
		await s.page.waitForTimeout(350);

		const before = await s.page.evaluate(CENSUS);
		const key = d.census || d.name;
		if (!before[key]) throw new Error(`${key} did not open (census: ${JSON.stringify(before)})`);

		const m = await s.page.evaluate(MEASURE, { cardSel: d.card, closeSel: d.close });
		if (m.err) throw new Error(m.err);

		// ── 1 ──
		check(m.closer === true, `${d.name}: carries a closer, and it is on screen`,
			m.closer ? m.name : 'no visible ' + d.close + ' in ' + d.card);
		if (!m.closer) {
			await shot(s, 'closers-missing-' + d.name.replace(/\W+/g, '-').toLowerCase());
			await s.close();
			fs.rmSync(dir, { recursive: true, force: true });
			continue;
		}

		// ── 2 ──
		// Flush with the corner of the card's CONTENT box, give or take the row's
		// own few pixels. Measured against the card's padding rather than a
		// constant, so the check says the same thing on both skins; a closer that
		// has drifted into the body, down to the foot, or behind another control
		// in its row fails all three ways.
		const cornered = m.fromRight >= -0.5 && m.fromRight <= m.padR + 10
			&& m.fromTop >= -0.5 && m.fromTop <= m.padT + 12
			&& m.rightmost && m.onScreen;
		check(cornered, `${d.name}: its closer is in the card's top right`,
			`${m.fromRight}px in from the card's right edge and ${m.fromTop}px down from its top,`
			+ ` against ${m.padR}/${m.padT}px of card padding`
			+ (m.rightmost ? '' : '; NOT the rightmost control in its row')
			+ (m.onScreen ? '' : '; and off the screen'));

		// ── 3 ──
		check(m.w >= FLOOR && m.h >= FLOOR && !m.missed,
			`${d.name}: its closer is at least ${FLOOR}x${FLOOR} and reachable across that box`,
			`${m.w}x${m.h}` + (m.missed ? `, and a finger misses it at: ${m.missed}` : ''));

		// ── 4 and 5 ──
		//
		// The keyboard is put INSIDE the dialog first. Without this the check
		// below is vacuous for every surface a user reaches without tabbing into
		// it: focus never left the opener, so it is still there afterwards whether
		// the dialog gives it back or not, and a broken restore reads as a pass.
		// This is what a person does anyway — they touch the thing before they
		// close it.
		await s.page.evaluate((sel) => {
			const root = document.querySelector(sel.card);
			if (!root) return;
			const inside = [...root.querySelectorAll('button,input,select,textarea,a[href]')]
				.filter((n) => !n.disabled && n.getClientRects().length
					&& !n.matches(sel.close) && !n.classList.contains('ui-close'));
			const target = inside[0] || root;
			if (!target.hasAttribute('tabindex') && !inside.length) target.setAttribute('tabindex', '-1');
			try { target.focus(); } catch (e) { /* not focusable */ }
		}, { card: d.card, close: d.close });
		await s.page.waitForTimeout(150);
		const left = await s.page.evaluate((sel) => !document.querySelector(sel)
			|| document.activeElement !== document.querySelector(sel), OPENER);
		if (!left) throw new Error('could not move the keyboard off the opener, so check 5 would prove nothing');

		await s.page.evaluate((sel) => {
			const root = document.querySelector(sel.card);
			const x = (root && root.querySelector(sel.close)) || document.querySelector(sel.close);
			if (x) x.click();
		}, { card: d.card, close: d.close });
		await s.page.waitForTimeout(600);
		const after = await s.page.evaluate(CENSUS);
		const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
		check(changed.length === 1 && changed[0] === key,
			`${d.name}: pressing it dismisses ${key} and nothing else`,
			changed.length === 0 ? 'nothing closed at all'
				: `what changed: ${changed.join(', ')}`);
		if (!(changed.length === 1 && changed[0] === key)) {
			await shot(s, 'closers-scope-' + d.name.replace(/\W+/g, '-').toLowerCase());
		}

		// ── 5 ──
		const landed = await s.page.evaluate((sel) => {
			const want = document.querySelector(sel);
			const a = document.activeElement;
			return {
				on: !!want && a === want,
				where: a ? (a.tagName.toLowerCase() + (a.id ? '#' + a.id : '')
					+ (a.className ? '.' + String(a.className).split(/\s+/).join('.') : '')) : '(none)',
			};
		}, OPENER);
		check(landed.on, `${d.name}: focus lands back on the control that opened it`,
			landed.on ? null : `it is on ${landed.where}`);

	} catch (e) {
		skip(d.name, String(e && e.message ? e.message : e).split('\n')[0]);
	} finally {
		try { if (s) await s.close(); } catch (e) { /* already gone */ }
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
	}
}

if (skipped.length) console.log('\nskipped: ' + skipped.join('; '));
if (BREAK) {
	console.log(`\n(run with --break ${BREAK}: a FAILURE above is the point of it)`);
}
console.log(failures === 0
	? `\nclosers: every surface carries a way out a thumb can reach${skips ? ` (${skips} SKIPPED)` : ''}.`
	: `\nclosers: ${failures} failure(s)${skips ? `, ${skips} SKIPPED` : ''}.`);
process.exit(failures === 0 && skips === 0 ? 0 : 1);
