// verify_mobile.mjs — the phone shell: chat floor, left drawer, thing-sheet.
//
// Drives the real page at a phone viewport (390×844) and checks the paradigm:
// the rail opens as a left drawer, a stage guest rises as a bottom sheet over
// the chat (never taking a bar slot), the ask pill forwards to the one
// composer, closing the sheet returns the guest to the stage, and growing back
// to desktop reseats everything with the chat still whole.
//
// AND THE RULE THE PARADIGM RESTS ON, which nothing checked until 2026-08-12:
// EVERY PANEL A PHONE CAN BE ASKED FOR ARRIVES ON SCREEN. A phone panel needs
// either a seat in the bottom bar with a `body[data-mpanel="…"]` rule in
// `responsive.css`, or a place in `MOBILE_GUESTS` so it rises as a sheet. Graph
// and Pending had neither: `responsive.css:89` hides every panel and only four
// rules un-hide anything, so asking for either took the conversation off screen
// and put nothing in its place — a visible button, a blank screen, and no way
// back but the hamburger. Pending was the worse of the two, because a worker's
// consent question opens that panel itself.
//
// This file could not see it. It read `dataset.mpanel` twice and both times
// asserted it was `'ai'`, which is a fact about the floor and says nothing about
// what the user was shown. The sweep below asks the only question that matters:
// after asking for a panel, is that panel on the screen, and is anything?
//
// It is written over the PANEL SET, not a list, so the next panel added without
// a destination fails here rather than shipping.
//
//   node dev/verify_mobile.mjs --break noguest   # the sweep fails for graph and
//                                                # pending: the state before the fix
//   node dev/verify_mobile.mjs                   # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is a real edit to a real file, served in place of it through
// `page.route`, and is how that piece behaved before the fix.
const BREAKS = {
	// `MOBILE_GUESTS` as it was: the panels added after the rule was written are
	// not in it, so none of them has anywhere to go on a phone.
	//
	// MATCHED BY SHAPE AND NOT BY THE TABLE'S LITERAL TEXT, which is the state
	// this break was found in on 2026-08-17: it pinned the four lines the table
	// held when it was written, three panels had been added to it since, the
	// anchor matched ZERO times, and `--break noguest` hard-exited 2 instead of
	// going red. A break nobody can run is a check nobody has proved. The table
	// is edited every time a panel is added, so the anchor must be the thing that
	// does not change -- its opening line and its closing brace.
	noguest: [{
		file: 'js/daimond.js',
		re:   /var MOBILE_GUESTS = \{[\s\S]*?\n\t\};/,
		with: 'var MOBILE_GUESTS = { web: 1, doc: 1, msg: 1, compose: 1, tools: 1, '
			+ 'spend: 1, term: 1, trash: 1 };',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. A break whose anchor is not there exactly
/// once broke nothing, and the run below would prove nothing.
///
/// A spec anchors by `find` (literal) or by `re` (shape). The shape form is for
/// anchors inside something that is edited often -- a table of panels, say --
/// where pinning the literal text makes the break go stale the next time
/// somebody adds a line to it, and stale means it aborts rather than fails.
function damaged(src, spec) {
	if (spec.re) {
		const n = (src.match(new RegExp(spec.re.source, spec.re.flags.includes('g')
			? spec.re.flags : spec.re.flags + 'g')) || []).length;
		if (n !== 1) {
			console.error(`break '${BREAK}': the shape ${spec.re} matches ${n} time(s) in ${spec.file}.`);
			process.exit(2);
		}
		return src.replace(spec.re, spec.with);
	}
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}.`);
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// The damaged files, ONE BODY PER FILE.
///
/// Every edit a break names for a file goes into the SAME body, in order, and
/// that one body is what the route serves. A `page.route` per edit spec does not
/// work and does not say so: Playwright hands a request to the LAST route
/// registered for its URL, so a two-edit break shipped only its second edit --
/// and still went red, for half the reason it claims, with nothing to notice it.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

const routeBreaks = async (pg) => {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await pg.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
// A browser-only tab talking to no gateway account gets 401s on /api/* — that is
// the disconnected state, not a fault. Judge only real script/page errors.
const realErrs = () => s.errs.filter(e =>
	!/Failed to load resource|status of 401|status of 4\d\d/.test(e));
const shot = async (p) => { try { await page.screenshot({ path: p, timeout: 8000 }); } catch (e) { console.log('  (shot skipped: ' + p + ')'); } };
const raise = async (id) => {			// force a clean open even if open-by-default
	await page.evaluate((x) => { window.DaimondPanels.hide(x); window.DaimondPanels.show(x); }, id);
	await sleep(450);
};

const s = await open({ signIn: true, connect: true, name: 'mobiletester', route: routeBreaks });
const { page } = s;

// Become a phone. matchMedia('(max-width:760px)') flips, and the shell takes over.
await page.setViewportSize({ width: 390, height: 844 });
// Headless does not reliably advance CSS transitions, so a measured mid-flight
// value is meaningless; disable them so every assertion reads the settled state.
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await sleep(400);

// A chat must exist for the floor to be the conversation.
await page.evaluate(() => { try { document.getElementById('new-session-btn').click(); } catch (e) {} });
await sleep(300);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^Start$/.test(x.textContent.trim())); if (b) b.click(); });
await sleep(500);

// ── 1. Boot clean on a phone ───────────────────────────────
check('boot: no console errors', realErrs().length === 0, realErrs().slice(0, 3).join(' | '));
check('boot: shell present', await page.evaluate(() => !!window.DaimondSheet && !!window.DaimondShell));
check('boot: hamburger visible', await page.evaluate(() => {
	const b = document.getElementById('drawer-btn'); return b && getComputedStyle(b).display !== 'none';
}));
check('boot: bar has 4 destinations', await page.evaluate(() =>
	document.querySelectorAll('#mnav button').length === 4));
check('boot: floor is the chat', await page.evaluate(() => document.body.dataset.mpanel === 'ai'));

// ── 2. The drawer ──────────────────────────────────────────
await page.evaluate(() => document.getElementById('drawer-btn').click());
await sleep(350);
check('drawer: opens on hamburger', await page.evaluate(() => document.body.classList.contains('drawer-open')));
check('drawer: rail is on screen', await page.evaluate(() => {
	const r = document.getElementById('panel-rail'); if (!r) return false;
	const x = r.getBoundingClientRect().left; return x > -5;			// slid in from the left
}));
check('drawer: scrim is catching taps', await page.evaluate(() => {
	const sc = document.getElementById('scrim'); return sc && getComputedStyle(sc).pointerEvents === 'auto';
}));
await page.evaluate(() => document.getElementById('scrim').click());
await sleep(350);
check('drawer: scrim tap closes it', await page.evaluate(() => !document.body.classList.contains('drawer-open')));

// ── 3. A thing rises as a sheet ────────────────────────────
await raise('web');
check('sheet: opens for a stage guest', await page.evaluate(() => window.DaimondSheet.isOpen() && window.DaimondSheet.guest() === 'web'));
check('sheet: guest moved into the sheet', await page.evaluate(() => {
	const el = document.getElementById('panel-web');
	return el && el.closest('#msheet') !== null;
}));
check('sheet: floor stays the chat', await page.evaluate(() => document.body.dataset.mpanel === 'ai'));
check('sheet: raised above peek', await page.evaluate(() => {
	const h = document.getElementById('msheet').getBoundingClientRect().height;
	return h > 120;								// well above the ~56px peek
}));
check('sheet: ask pill on screen at half', await page.evaluate(() => {
	const pill = document.getElementById('msheet-ask');
	const r = pill.getBoundingClientRect();
	return r.height > 0 && r.bottom <= window.innerHeight + 1 && r.top >= 0;
}));
check('sheet: web keeps an ask pill', await page.evaluate(() =>
	!document.getElementById('msheet-ask').classList.contains('hidden')));
check('sheet: bar still reachable above sheet', await page.evaluate(() => {
	const bar = document.getElementById('mnav'), sh = document.getElementById('msheet');
	const bz = +getComputedStyle(bar).zIndex || 0, sz = +getComputedStyle(sh).zIndex || 0;
	return bz > sz;
}));
check('sheet: chat composer hidden while sheet up', await page.evaluate(() => {
	const bar = document.querySelector('.ai .chat-input-bar');
	return bar && getComputedStyle(bar).visibility === 'hidden';
}));
await shot('shots/mobile-sheet-web.png');

// ── 4. Tools sheet hides the ask pill ──────────────────────
await raise('tools');
check('sheet: only one guest up at a time', await page.evaluate(() =>
	document.getElementById('panel-web').closest('#msheet') === null &&
	document.getElementById('panel-tools').closest('#msheet') !== null));
check('sheet: tools has no ask pill', await page.evaluate(() =>
	document.getElementById('msheet-ask').classList.contains('hidden')));

// ── 5. Close returns the guest to the stage ────────────────
await page.evaluate(() => document.getElementById('msheet-close').click());
await sleep(400);
check('close: sheet down', await page.evaluate(() => !window.DaimondSheet.isOpen() && !document.body.classList.contains('sheet-open')));
check('close: guest back in the stage', await page.evaluate(() => {
	const el = document.getElementById('panel-tools');
	return el && el.closest('#stage') !== null && el.closest('#msheet') === null;
}));
check('close: engine marks it closed', await page.evaluate(() => !window.DaimondPanels.isOpen('tools')));

// ── 6. The ask pill forwards to the one composer ───────────
await raise('web');
const asked = await page.evaluate(async () => {
	const before = document.querySelectorAll('.chat-msg-user').length;
	document.getElementById('msheet-ask-input').value = 'what is this page';
	document.getElementById('msheet-ask-send').click();
	await new Promise(r => setTimeout(r, 600));
	const after = document.querySelectorAll('.chat-msg-user').length;
	return { before, after, parkedH: document.getElementById('msheet').style.height };
});
check('ask: pill posts a user message to the chat', asked.after === asked.before + 1, JSON.stringify(asked));

// ── 6a. Every panel a phone can ask for arrives on screen ──
//
// The panel SET is read out of the page, so a panel added later is swept
// without anybody remembering to add it here. Two questions per panel, and they
// are different failures: the panel the user asked for is on screen, and SOME
// panel is — a blank main area is the defect that shipped, and a panel that is
// merely mis-seated is the one that would replace it.
//
// Everything else is closed first. A dock with no free seat refuses to open
// anything (`DaimondPanels.show` returns early), and a refusal is not the defect
// under test — it would redden this sweep for a reason that has nothing to do
// with whether the panel has a phone destination.
// The PANELS, not the chips that name them: `data-panel` is on both, so the
// element's own id is what says which is which.
const panelIds = await page.evaluate(() =>
	[...document.querySelectorAll('[data-panel]')]
		.filter(e => e.id === 'panel-' + e.dataset.panel)
		.map(e => e.dataset.panel)
		.filter(id => id !== 'rail'));
check('phone: the page declares its panels', panelIds.length >= 10, panelIds.join(' '));

const missing = [], blank = [];
for (const id of panelIds) {
	const seen = await page.evaluate(async (x) => {
		const P = window.DaimondPanels;
		[...document.querySelectorAll('[data-panel]')].forEach((e) => {
			if (e.id !== 'panel-' + e.dataset.panel) return;
			const p = e.dataset.panel;
			if (p !== x && p !== 'rail' && p !== 'ai') { try { P.hide(p); } catch (e2) {} }
		});
		try { P.hide(x); } catch (e2) {}
		P.show(x);
		await new Promise(r => setTimeout(r, 400));
		const el = document.getElementById('panel-' + x);
		const b = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
		// Anything at all in the main area with a real box. The bug shows here as
		// nothing: `body[data-mpanel="graph"]` matches no un-hide rule, so every
		// panel in `.main` keeps `display: none !important`.
		//
		// NOT `.rail`. `responsive.css:89` hides `.panel:not(.rail)`, so the rail
		// keeps its box whatever happens and counting it made this a check that
		// could not fail — it passed against the broken build, which is the one
		// thing a check must never do.
		const anyMain = [...document.querySelectorAll('.main .panel:not(.rail)')]
			.some((p) => p.getBoundingClientRect().height > 20);
		return { onScreen: b.width > 0 && b.height > 0, anyMain,
			mpanel: document.body.dataset.mpanel,
			guest: window.DaimondSheet ? window.DaimondSheet.guest() : null };
	}, id);
	if (!seen.onScreen) missing.push(id + ' (mpanel=' + seen.mpanel + ', sheet=' + seen.guest + ')');
	if (!seen.anyMain)  blank.push(id);
	// The sheet is put away between panels so each one is asked of a clean shell.
	await page.evaluate(() => { try { window.DaimondSheet.close(); } catch (e) {} });
	await sleep(250);
}
check('phone: every panel the user can ask for arrives on screen',
	missing.length === 0, missing.length ? ('never appeared: ' + missing.join('; ')) : panelIds.length + ' swept');
check('phone: and none of them leaves the main area blank',
	blank.length === 0, blank.length ? ('blank screen for: ' + blank.join(', ')) : '');
await shot('shots/mobile-panel-sweep.png');

// Back to the chat floor for the desktop half below.
await page.evaluate(() => { try { window.DaimondSheet.close(); } catch (e) {} window.DaimondPanels.show('ai'); });
await sleep(350);

// ── 7. Grow back to desktop: everything reseats ────────────
await page.setViewportSize({ width: 1500, height: 950 });
// A real browser fires `resize` on a viewport change; Playwright's
// setViewportSize does not always, so dispatch it as the browser would.
await page.evaluate(() => window.dispatchEvent(new Event('resize')));
await sleep(600);
console.log('  dbg ' + JSON.stringify(await page.evaluate(() => ({
	innerW: window.innerWidth,
	mqMatches: window.matchMedia('(max-width: 760px)').matches,
	sheetOpen: document.body.classList.contains('sheet-open'),
	guest: window.DaimondSheet.guest(),
	webParent: (function () { const e = document.getElementById('panel-web'); return e && e.parentElement ? e.parentElement.id : null; })(),
	webOpen: window.DaimondPanels.isOpen('web'),
}))));
check('desktop: sheet folded away', await page.evaluate(() =>
	!document.body.classList.contains('sheet-open') && !window.DaimondSheet.isOpen()));
check('desktop: rail back in the main column', await page.evaluate(() => {
	const r = document.getElementById('panel-rail');
	return r && r.closest('#main') !== null && getComputedStyle(r).position !== 'fixed';
}));
check('desktop: web guest reseated on the stage', await page.evaluate(() => {
	const el = document.getElementById('panel-web');
	return el && el.closest('#stage') !== null;
}));
check('desktop: no new console errors', realErrs().length === 0, realErrs().slice(0, 3).join(' | '));

await shot('shots/mobile-desktop-after.png');

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED: ' + bad.join(', '));
await s.close();
process.exit(bad.length ? 1 : 0);
