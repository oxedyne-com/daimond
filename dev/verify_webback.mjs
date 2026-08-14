// verify_webback.mjs — the Web panel's Back control is on screen only when
// pressing it does something.
//
// THE DEFECT. `#web-back` called `els.frame.contentWindow.history.back()` inside
// a bare `try {} catch {}`. Every path into that frame throws:
//
//   * a cross-origin site — the same-origin policy, and the old comment said so;
//   * under Daimond Hands the frame is `display:none` and still holds the guide,
//     so a Back that worked would walk the GUIDE's history behind a header naming
//     a live site;
//   * AND OUR OWN GUIDE, which the reachability audit believed was the one case
//     that worked. It is not. `#web-frame` carries
//     `sandbox="allow-scripts allow-forms allow-popups …"` with NO
//     `allow-same-origin` (www/index.html), deliberately — `www/guide/frame.js`
//     opens by explaining why — so the guide sits in an OPAQUE origin and is as
//     cross-origin to us as anybody else's site. Measured below: the read throws
//     `SecurityError`.
//
// So the control did nothing, said nothing, and was permanently on screen. That
// is the failure this app's own principle is written against — a control that
// does nothing when pressed teaches the reader to distrust every control — so it
// is now drawn only where it can act.
//
// The properties, each chosen because it would be invisible if it were wrong:
//
//   1. IT IS NOT ON SCREEN WHERE IT CANNOT WORK: the guide, a cross-origin page,
//      and the extension driver. Asserted from the COMPUTED STYLE, which is what
//      the reader's eye gets, not from a class name.
//   2. AND THE REST OF THE TOOLBAR IS. Hiding the panel's controls wholesale
//      would pass check 1 and be a worse app.
//   3. IT IS A PROBE, NOT A TABLE OF DRIVERS. The audit's suggested fix — show it
//      for `guide` and `local` — would have kept a dead control on screen for the
//      commonest case of all, because the sandbox is what blocks it and the
//      driver does not say. Proved by GIVING the frame a browsing context we may
//      walk (the sandbox attribute removed, which only a test may do) and
//      watching the control come back on its own.
//   4. AND WHEN IT IS ON SCREEN IT WORKS: the frame really returns to the page it
//      came from. A rule that hid the button everywhere would satisfy 1 and be
//      indistinguishable from deleting it.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// damaged `www/js/web.js` to the real page through `page.route`, and the run is
// expected to fail. An anchor that does not appear exactly once aborts the run
// rather than passing quietly.
//
//   node dev/verify_webback.mjs --break always     # the shipped defect: never hidden
//   node dev/verify_webback.mjs --break hidden     # hidden even when it would work
//   node dev/verify_webback.mjs --break whitelist  # the audit's fix: driver table, no probe
//   node dev/verify_webback.mjs                    # and then, clean
//
//   eval "$(bash dev/world.sh 20 --up)"
//   node dev/verify_webback.mjs
//
// Needs dev/serve.mjs only. No gateway and no mock model. The extension half
// stubs ONE function — the `chrome.runtime.sendMessage` wire — and runs the
// shipped code above it: `detect` adopts the stamped id, `open` takes the ext
// branch, `adoptPage` sets the driver and `extNote` hides the frame with the
// guide still inside it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'webback' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The control as it shipped: bound, permanently visible, and swallowing the
	// SecurityError every press raises.
	always: [{
		file: 'js/web.js',
		find: '\tfunction paintBack() {\n\t\tif (els.back) els.back.style.display = canGoBack() ? \'\' : \'none\';\n\t}',
		with: '\tfunction paintBack() {\n\t\tif (els.back) els.back.style.display = \'\';\n\t}',
	}],
	// The opposite mistake: taken away even where it would work, which is
	// deleting the feature rather than fixing it.
	hidden: [{
		file: 'js/web.js',
		find: '\tfunction paintBack() {\n\t\tif (els.back) els.back.style.display = canGoBack() ? \'\' : \'none\';\n\t}',
		with: '\tfunction paintBack() {\n\t\tif (els.back) els.back.style.display = \'none\';\n\t}',
	}],
	// The fix the reachability audit proposed: show it for the drivers whose
	// pages are "ours". It is wrong, and wrong in the commonest state the panel
	// is ever in — the guide is ours and is still unreachable, because what
	// blocks it is the sandbox and not the driver.
	whitelist: [{
		file: 'js/web.js',
		find: '\t\tif (state.driver === \'ext\' || state.driver === \'none\') return false;\n'
			+ '\t\ttry {\n'
			+ '\t\t\treturn !!(els.frame && els.frame.contentWindow && els.frame.contentWindow.history);\n'
			+ '\t\t} catch (e) {\n'
			+ '\t\t\treturn false;                   // opaque or cross-origin: not ours\n'
			+ '\t\t}',
		with: '\t\treturn state.driver === \'guide\' || state.driver === \'local\';',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
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

async function route(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// ── Driving ──────────────────────────────────────────────────────────

const s = await open({ name: 'webback', profile: PROFILE, connect: false, route });
const { page } = s;

/// What the reader's eye gets: is this control drawn at all?
const shown = (id) => page.evaluate((i) => {
	const e = document.getElementById(i);
	if (!e) return false;
	const cs = getComputedStyle(e);
	return cs.display !== 'none' && cs.visibility !== 'hidden' && e.offsetHeight > 0;
}, id);

/// Which guide page the frame is actually showing, read from the frame's own
/// `location`. Only meaningful once the frame is reachable — which is the state
/// section 4 sets up, and the state it is asking about.
///
/// Read through the frame rather than from the `src` attribute: `src` says what
/// was last ASKED for, and a Back that failed would leave it saying exactly what
/// a Back that worked would.
const framePage = () => page.evaluate(() => {
	try { return document.getElementById('web-frame').contentWindow.location.href.replace(/^.*\/guide\//, ''); }
	catch (e) { return 'UNREACHABLE: ' + e.name; }
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

try {
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);

	// ── 0. The fact the whole fix rests on ───────────────────────
	// Not an assumption about the same-origin policy: the read is made, from the
	// page, in the state the app actually ships, and the error is printed.
	await page.evaluate(() => window.DaimondWeb.guide('index.html'));
	await page.waitForTimeout(1200);
	const reach = await page.evaluate(() => {
		const f = document.getElementById('web-frame');
		const out = { sandbox: f.getAttribute('sandbox') || '(none)', src: f.getAttribute('src') };
		try { out.history = 'length ' + f.contentWindow.history.length; }
		catch (e) { out.history = e.name; }
		return out;
	});
	check('OUR OWN GUIDE is unreachable too — the sandbox has no allow-same-origin, '
		+ 'so the frame is an opaque origin and its history throws',
		reach.history === 'SecurityError' && !/allow-same-origin/.test(reach.sandbox),
		`${reach.src}: sandbox="${reach.sandbox}", history → ${reach.history}`);

	// ── 1. Not on screen where it cannot work ────────────────────
	const driver0 = await page.evaluate(() => window.DaimondWeb.status().driver);
	check('with the guide on screen, Back is not drawn — it could only ever be silent there',
		!(await shown('web-back')), `driver ${driver0}`);

	// 2. And the panel did not simply lose its toolbar.
	check('but Reload and Open-in-a-tab still are — the toolbar was not hidden wholesale',
		(await shown('web-reload')) && (await shown('web-pop')),
		`reload ${await shown('web-reload')}, pop ${await shown('web-pop')}`);

	// A cross-origin page. `open()` needs no network to reach the state that
	// matters: the gateway probe fails, the frame is pointed at the site, and the
	// driver is `frame` — which is the state the control is being asked about.
	await page.evaluate(() => window.DaimondWeb.open('https://example.org/').catch(() => {}));
	await page.waitForTimeout(1500);
	const driver1 = await page.evaluate(() => window.DaimondWeb.status().driver);
	check('with a cross-origin page framed, Back is not drawn',
		driver1 === 'frame' && !(await shown('web-back')), `driver ${driver1}`);

	// The extension driver. The EXTENSION is stubbed — one function, the
	// `chrome.runtime.sendMessage` wire — and everything above it is the shipped
	// code: `detect()` adopts the stamped id, `open()` takes the ext branch,
	// `adoptPage` sets the driver and `extNote` hides the frame while leaving the
	// guide inside it. That last line is the defect this half is about.
	// The frame is put back on the guide first, because that is what it holds in
	// life: the panel's resting content, left behind when the extension takes the
	// page into a tab of its own.
	await page.evaluate(() => window.DaimondWeb.guide('index.html'));
	await page.waitForTimeout(900);
	const asExt = await page.evaluate(async () => {
		window.chrome = window.chrome || {};
		chrome.runtime = {
			lastError: null,
			sendMessage: (id, msg, cb) => setTimeout(() => cb(
				msg.cmd === 'ping'   ? { ok: true, version: 'stub' }
				: msg.cmd === 'open'   ? { ok: true, url: msg.url, title: 'News', mode: 'agent' }
				: msg.cmd === 'status' ? { ok: true, url: 'https://news.example/', title: 'News', mode: 'agent' }
				: { ok: true }), 0),
		};
		// Exactly how the real extension announces itself (see detect()).
		document.documentElement.dataset.daimondHands = 'stub-hands';
		window.dispatchEvent(new CustomEvent('daimond-hands', { detail: { id: 'stub-hands' } }));
		await new Promise(r => setTimeout(r, 300));
		try { await window.DaimondWeb.open('https://news.example/'); } catch (e) { /* refused */ }
		const f = document.getElementById('web-frame');
		return {
			driver: window.DaimondWeb.status().driver,
			// The frame is hidden and still holds the guide: what a Back would walk.
			frameHidden: getComputedStyle(f).display === 'none',
			frameHolds:  f.getAttribute('src') || '',
		};
	});
	await page.waitForTimeout(600);
	check('under Daimond Hands the frame is hidden and still holds the guide, and Back '
		+ 'is not drawn — a Back that "worked" there would walk the GUIDE\'s history '
		+ 'behind a header naming a live site',
		asExt.driver === 'ext' && asExt.frameHidden && /guide\//.test(asExt.frameHolds)
			&& !(await shown('web-back')),
		`driver ${asExt.driver}, frame hidden ${asExt.frameHidden}, holding ${asExt.frameHolds}`);

	// ── 3 and 4. The rule is a probe, and the control works ──────
	// Give the frame a browsing context we may walk. Only a test may do this: the
	// sandbox is the app's isolation of pages an agent wrote, and removing it in
	// shipped code would hand a written page the user's keys. Here it stands in
	// for any future change that makes the frame reachable — a guide frame of its
	// own, a back-channel through guide/frame.js — and asks whether the control
	// notices without anyone editing this rule.
	await page.evaluate(() => {
		document.getElementById('web-frame').removeAttribute('sandbox');
		window.DaimondWeb.guide('index.html');
	});
	await page.waitForTimeout(1500);
	const reach2 = await page.evaluate(() => {
		try { return 'length ' + document.getElementById('web-frame').contentWindow.history.length; }
		catch (e) { return e.name; }
	});
	check('give the frame a history we may walk and the control comes back BY ITSELF — '
		+ 'the rule asks the frame, it does not consult a table of drivers',
		(await shown('web-back')) && /^length/.test(reach2), `history → ${reach2}`);

	// And it really goes back. The frame is navigated to a second guide page, and
	// the assertion is the PAGE it lands on, not that a click was accepted.
	const from = await framePage();
	// Navigated by CLICKING THE GUIDE'S OWN LINK, inside the frame, which is how a
	// reader gets a second page into it. (`location.assign` from out here would
	// resolve the relative url against the APP's document, not the frame's — it
	// lands on the app root and looks like a broken guide.)
	await page.evaluate(() => {
		const d = document.getElementById('web-frame').contentWindow.document;
		const a = d.querySelector('a[href="spending.html"]');
		if (a) a.click(); else d.location.href = 'spending.html';
	});
	// Waited for by NAME rather than by a fixed sleep: a frame caught mid-flight
	// has no url yet, and a check that read one would be measuring the clock.
	await page.waitForFunction(
		() => /\/guide\/spending/.test(document.getElementById('web-frame').contentWindow.location.href),
		null, { timeout: 15000 }).catch(() => {});
	await sleep(400);
	const moved = await framePage();
	check('the frame moved to a second guide page, so there is somewhere to go back to',
		/^index\.html/.test(from) && /^spending\.html/.test(moved), `${from} → ${moved}`);

	// Pressed only if it is there to press. A run that threw on the click would
	// report "the run finished" and hide which property failed.
	const pressable = await shown('web-back');
	if (pressable) await page.click('#web-back', { force: true });
	await page.waitForFunction(
		() => /\/guide\/index/.test(document.getElementById('web-frame').contentWindow.location.href),
		null, { timeout: 15000 }).catch(() => {});
	await sleep(400);
	const landed = await framePage();
	// Named pages, not "it changed": a frame that fell back to about:blank, or one
	// this check could not read at all, would otherwise pass as a working Back.
	check('AND PRESSING BACK RETURNS IT to the page it came from — the control is drawn '
		+ 'only where it acts, and where it is drawn it acts',
		pressable && /^spending\.html/.test(moved) && /^index\.html/.test(landed),
		pressable ? `${from} → ${moved} → back → ${landed}`
			: 'the control was not on screen to press, in the one state where it works');

	await shot(s, 'webback' + (BREAK ? '-' + BREAK : ''));
} catch (e) {
	check('the run finished', false, String((e && e.message) || e));
	try { await shot(s, 'webback-threw'); } catch { /* nothing to show */ }
} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
