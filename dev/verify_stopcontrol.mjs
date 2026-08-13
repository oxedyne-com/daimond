// verify_stopcontrol.mjs — can a daimon turn be stopped from the face a Diamond opens on?
//
// The user's report: "i could not stop the llm, the arrow send button doesn't
// change to a stop button! I had to refresh".
//
// A Diamond opens on its CRYSTAL face, and both faces share one composer. The
// turn machinery repaints that composer through `syncComposer`, which was called
// at the start of a steer behind `if (onScreen())` -- and `onScreen()` is true
// only on the CHAT face. So the button stayed an arrow for the whole turn.
//
// What is asserted is MEANING, not a glyph: the control is in stop mode, and
// pressing it actually ends the turn -- proved by the turn finishing far sooner
// than the mock would have taken to answer.
//
//   node dev/verify_stopcontrol.mjs            # the working tree
//   node dev/verify_stopcontrol.mjs --broken   # the same page with the guard put back
//
// `--broken` is a hand check and exits 1 by design; `run_all.sh` runs it without the flag.
//
// `--broken` rewrites the ONE line in the served daimond.js, so the two runs
// differ by that line and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, connectMock, scratch } from './harness.mjs';

// Derived, never written down. `gate.sh` runs the suite inside a `git
// worktree` at a different path, and an absolute path here would read the
// MAIN tree's `daimond.js` while driving the worktree's app -- a verifier
// measuring one tree and reporting on another.
const APPDIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROKEN = process.argv.includes('--broken');

// The whole of the fix, in one line either way.
const FIXED_LINE  = '\t\tsyncComposer();\n\t\tif (onCrystal) showCrystalSpinner();';
const BROKEN_LINE = '\t\tif (onScreen()) syncComposer();\n\t\tif (onCrystal) showCrystalSpinner();';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

/// What the one composer button is saying right now, read from the DOM.
const sendState = (p) => p.evaluate(() => {
	const b = document.getElementById('chat-send');
	if (!b) return { there: false };
	return {
		there:   true,
		shown:   b.getClientRects().length > 0,
		stop:    b.classList.contains('stop'),
		glyph:   (b.textContent || '').trim(),
		title:   b.title || '',
		enabled: !b.disabled,
	};
});

/// Is the Diamond's own record mid-turn, as the rest of the app sees it?
const generating = (p) => p.evaluate(() =>
	!!(window.DaimondCore && window.DaimondCore.busy && window.DaimondCore.busy()));

async function newDiamond(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')]
			.filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	await p.waitForTimeout(1500);
}

const route = BROKEN ? async (page) => {
	const src = fs.readFileSync(APPDIR + '/www/js/daimond.js', 'utf8');
	if (!src.includes(FIXED_LINE)) throw new Error('the fixed line is not in the file; --broken cannot rewrite it');
	const hurt = src.replace(FIXED_LINE, BROKEN_LINE);
	await page.route('**/js/daimond.js', (r) => r.fulfill({
		status: 200, contentType: 'application/javascript; charset=utf-8', body: hurt,
	}));
} : null;

const s = await open({ name: 'stopprobe', profile: scratch('pw', 'stopprobe-' + process.pid), route });
const { page: p } = s;
try {
	await connectMock(s);
	await newDiamond(p, 'Stop probe');

	// The face a Diamond opens on. Named, not assumed.
	const face = await p.evaluate(() => ({
		crystal: !!document.getElementById('panel-ai').classList.contains('crystal-face'),
		composer: (() => { const b = document.querySelector('.chat-input-bar');
			return !!(b && b.getClientRects().length); })(),
	}));
	check(face.crystal, 'a new Diamond opens on the crystal face', JSON.stringify(face));
	check(face.composer, 'and the composer is under it', JSON.stringify(face));

	const before = await sendState(p);
	check(before.there && before.shown && !before.stop, 'at rest the button is Send',
		JSON.stringify(before));

	// A turn long enough to watch. 300 chunks at 120ms is ~36s of streaming, so
	// anything that ends inside a few seconds ended because it was STOPPED.
	await p.fill('#chat-input', '@long 300');
	await p.click('#chat-send');
	await p.waitForTimeout(1500);

	const mid = await sendState(p);
	const gen = await generating(p);
	check(gen, 'the turn is running', 'DaimondCore.busy() = ' + gen);
	check(mid.stop, 'MID-TURN THE BUTTON IS STOP', JSON.stringify(mid));
	check(mid.glyph === '■', 'and it shows the stop mark', JSON.stringify(mid));
	check(mid.enabled && mid.shown, 'and it can be pressed', JSON.stringify(mid));

	// THE CONTROL FOR THE CHECK BELOW. Without this, a turn that ended by itself
	// would read as a turn the press stopped. Left alone for six seconds, this one
	// is still going: the mock has 300 chunks to dribble at 120ms.
	await p.waitForTimeout(4500);
	check(await generating(p), 'left alone, the turn is STILL running six seconds in',
		'so anything that ends it after this was the press');

	// The property that matters: pressing it ENDS THE TURN. Nothing here reads a
	// class to decide that -- the turn is over when the app says it is not busy.
	//
	// This passes in the BROKEN build too, and that is the point rather than a
	// flaw: `sendMode()` already returns 'stop', so the button was ALWAYS wired to
	// stop the turn -- it merely said "Send" while it did. Nobody presses an arrow
	// to stop something, which is why the paint is the whole defect.
	const t0 = Date.now();
	await p.click('#chat-send');
	let ended = false;
	for (let i = 0; i < 60; i++) {
		await p.waitForTimeout(250);
		if (!(await generating(p))) { ended = true; break; }
	}
	const took = Date.now() - t0;
	check(ended && took < 8000, 'PRESSING IT STOPS THE TURN', 'ended after ' + took + 'ms');

	await p.waitForTimeout(600);
	const after = await sendState(p);
	check(after.there && !after.stop && after.glyph === '➤',
		'and the button goes back to Send', JSON.stringify(after));

	await p.screenshot({ path: scratch('stopprobe-' + (BROKEN ? 'broken' : 'fixed') + '.png') });
} catch (e) {
	console.log('  FAIL threw — ' + (e && e.message));
	failures++;
} finally {
	const errs = s.errs.filter(e => !/favicon|manifest/i.test(e));
	if (errs.length) console.log('  console errors: ' + errs.slice(0, 5).join(' | '));
	await s.close();
}
console.log((BROKEN ? 'BROKEN' : 'FIXED') + ': ' + (failures ? failures + ' failure(s)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
