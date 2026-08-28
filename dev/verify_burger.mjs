// verify_burger.mjs — the phone hamburger still opens the drawer after the
// phone has been turned on its side and back.
//
// Reported from an iPhone: "after the modestly long chat use, the main hamburger
// icon left in the header for mobile view stops working". Long use is the
// EXPOSURE, not the cause. The transcript's size does not matter and neither does
// the session's age; what matters is that somewhere in a long session the phone
// was rotated once.
//
// An iPhone in landscape is 844 CSS pixels wide. That is outside the 760 the
// phone shell is bounded by and far inside the 1280 at which the desktop layout
// folds the rail away, so `DaimondPanels.apply()` takes its DESKTOP branch and
// writes an inline `display: none` on `#panel-rail`. Back in portrait the phone
// branch runs — and it used to do nothing at all, so the inline rule survived.
//
// The rail is the one panel that rule can kill. `responsive.css` decides every
// other panel's phone visibility with `display: … !important` and excludes
// `.rail` by name, because the rail is the DRAWER and is shown by
// `body.drawer-open` plus a transform. Nothing overrules the inline style, so the
// hamburger — which only toggles that class — opened a drawer that was not drawn.
// Diamonds, Chats and Admin were then unreachable until the page was reloaded.
//
//   node dev/verify_burger.mjs --break noelse   # the phone branch does nothing
//   node dev/verify_burger.mjs --break nomq     # `apply()` is never re-run on the flip
//   node dev/verify_burger.mjs                  # and then, clean
//
// `dev/probe_burger.mjs` is the diagnostic this came out of: it drives the same
// rotation on WebKit at an iPhone viewport, and its `--arm size` and `--arm time`
// are the two arms that come back clean, which is how the rotation was found.
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
	// The phone branch of `apply()`, back to the empty one it was: nothing puts
	// the rail's `display` back, so the landscape leg's inline `none` stands.
	//
	// Anchored on the branch's opening and its closing brace rather than on its
	// text, which is a comment somebody will improve.
	noelse: [{
		file: 'js/daimond.js',
		re:   /\t\t\t\} else \{\n\t\t\t\t\/\/ AND THE RAIL IS PUT BACK[\s\S]*?\n\t\t\t\}/,
		with: '\t\t\t}',
	}],
	// The second half: `apply()` is run again when the breakpoint itself flips.
	// Without it the only `apply()` on the way back to portrait is the one the
	// `resize` event drives, and at that moment `matchMedia` still answers false —
	// measured, not assumed — so it takes the desktop branch and hides the rail
	// with nothing following to undo it.
	nomq: [{
		file: 'js/daimond.js',
		re:   /\t\t\tif \(mobileMq\.addEventListener\) mobileMq\.addEventListener\('change', apply\);\n\t\t\telse if \(mobileMq\.addListener\) mobileMq\.addListener\(apply\);\n/,
		with: '',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. A break whose anchor is not there exactly
/// once broke nothing, and the run below would prove nothing.
function damaged(src, spec) {
	const re = new RegExp(spec.re.source, spec.re.flags.includes('g') ? spec.re.flags : spec.re.flags + 'g');
	const n = (src.match(re) || []).length;
	if (n !== 1) {
		console.error(`break '${BREAK}': the shape ${spec.re} matches ${n} time(s) in ${spec.file}.`);
		process.exit(2);
	}
	return src.replace(spec.re, spec.with);
}

/// The damaged files, ONE BODY PER FILE: Playwright hands a request to the LAST
/// route registered for its URL, so two routes for one file serve only the second.
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

const s = await open({ signIn: true, connect: true, name: 'burgertester', route: routeBreaks });
const { page } = s;

const PORTRAIT  = { width: 390, height: 844 };		// an iPhone 13, upright
const LANDSCAPE = { width: 844, height: 390 };		// the same phone, turned

/// Playwright's `setViewportSize` does not raise `resize` the way a device does,
/// and the whole fault lives in what the app does when it is told.
async function rotate(size) {
	await page.setViewportSize(size);
	await page.evaluate(() => window.dispatchEvent(new Event('resize')));
	await sleep(700);
}

/// Press the hamburger and say whether the drawer really arrived. The class is
/// not the answer: the fault under test toggles the class perfectly and draws
/// nothing, so the rail's own box is what is read.
async function drawerOpens() {
	await page.evaluate(() => { document.body.classList.remove('drawer-open'); });
	await sleep(350);
	await page.evaluate(() => document.getElementById('drawer-btn').click());
	await sleep(450);
	return page.evaluate(() => {
		const r = document.getElementById('panel-rail');
		if (!r) return { on: false, why: 'no rail' };
		const q = r.getBoundingClientRect();
		return {
			on:      q.width > 100 && q.left > -8,
			cls:     document.body.classList.contains('drawer-open'),
			display: getComputedStyle(r).display,
			inline:  r.style.display,
			box:     `${Math.round(q.left)},${Math.round(q.width)}`,
		};
	});
}

await rotate(PORTRAIT);
// Headless does not reliably advance CSS transitions, so a measured mid-flight
// value is meaningless; disable them so every assertion reads the settled state.
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} });
await sleep(300);

// ── 1. Before anything is rotated ──────────────────────────
let d = await drawerOpens();
check('portrait: the hamburger opens the drawer', d.on, JSON.stringify(d));
await page.evaluate(() => { document.body.classList.remove('drawer-open'); });
await sleep(350);

// ── 2. The landscape leg, which is where the inline style is written ──
//
// Asserted rather than assumed: if the desktop branch ever stops hiding the rail
// in this band, the check below is passing for a reason that has gone.
await rotate(LANDSCAPE);
check('landscape: the desktop branch puts the rail away', await page.evaluate(() =>
	document.getElementById('panel-rail').style.display === 'none'),
	await page.evaluate(() => `inline='${document.getElementById('panel-rail').style.display}'`));

// ── 3. And back, which is the bug ──────────────────────────
await rotate(PORTRAIT);
check('portrait again: no inline display is left on the rail', await page.evaluate(() =>
	document.getElementById('panel-rail').style.display !== 'none'),
	await page.evaluate(() => `inline='${document.getElementById('panel-rail').style.display}'`));

d = await drawerOpens();
check('portrait again: the hamburger opens the drawer', d.on, JSON.stringify(d));
check('portrait again: the drawer is drawn, not merely flagged', d.on && d.display !== 'none',
	JSON.stringify(d));
await page.evaluate(() => { document.body.classList.remove('drawer-open'); });
await sleep(400);

// ── 4. Twice, because a fix that only survives one crossing is a fix that
//       fails on the second. ─────────────────────────────────
await rotate(LANDSCAPE);
await rotate(PORTRAIT);
d = await drawerOpens();
check('two rotations: the hamburger still opens the drawer', d.on, JSON.stringify(d));
await page.evaluate(() => { document.body.classList.remove('drawer-open'); });
await sleep(400);

// ── 5. THE OBSERVATION THAT SEPARATES THIS FROM A BLOCKED THREAD ──
//
// If the main thread were the trouble, every control in the header would be dead
// together. About is beside the hamburger and opens a dialog of its own, so it
// answers the question in one press — and it must answer it in the broken world
// too, which is why it is checked here and not only in the clean one.
await page.evaluate(() => document.getElementById('about-btn').click());
await sleep(500);
check('the rest of the header is alive (About opens)', await page.evaluate(() => {
	const dlg = document.querySelector('body > .modal.dlg');
	return !!dlg && !!(dlg.offsetWidth || dlg.offsetHeight);
}));
await page.keyboard.press('Escape');
await sleep(300);

// ── 6. No desktop regression ───────────────────────────────
//
// The rail folds away on its own between 760 and 1280 and that is deliberate:
// the fix must not un-fold it, only stop it outliving the phone.
await rotate({ width: 1000, height: 800 });
check('desktop 1000px: the rail is still folded away', await page.evaluate(() =>
	getComputedStyle(document.getElementById('panel-rail')).display === 'none'),
	await page.evaluate(() => getComputedStyle(document.getElementById('panel-rail')).display));
await rotate({ width: 1400, height: 900 });
check('desktop 1400px: the rail is back', await page.evaluate(() =>
	getComputedStyle(document.getElementById('panel-rail')).display !== 'none'),
	await page.evaluate(() => getComputedStyle(document.getElementById('panel-rail')).display));

console.log(`\n${ok.length} ok, ${bad.length} failed${bad.length ? ': ' + bad.join(', ') : ''}`);
await s.close();
process.exit(bad.length ? 1 : 0);
