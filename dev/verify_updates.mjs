// verify_updates.mjs — a running tab notices a new build and applies it safely.
//
// The contract: the tab reads build.json at boot to learn its own version, re-reads it to notice
// a newer one, lights the header chip, and reloads only at a safe moment -- never over a running
// turn, and in the foreground only on a click. After the reload it says, briefly, that it updated.
//
// build.json is faked per-scenario with Playwright request interception, so the test drives the
// whole state machine without a real deploy. The updater runs on the locked screen too (it is
// independent of identity), so no sign-in is needed.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const until = async (page, fn, ms = 5000) => {
	const t0 = Date.now();
	for (;;) {
		// A reload destroys the execution context mid-poll; treat that as "not yet" and keep trying.
		try { if (await page.evaluate(fn)) return true; } catch (e) { /* mid-navigation */ }
		if (Date.now() - t0 > ms) return false;
		await new Promise(r => setTimeout(r, 50));
	}
};

const s = await open({ signIn: false });
const { page } = s;

// Serve a chosen stamp for build.json. `stamp === null` means "no version system deployed" (404).
async function serve(stamp) {
	await page.unroute('**/build.json').catch(() => {});
	await page.route('**/build.json', route => route.fulfill(
		stamp === null
			? { status: 404, contentType: 'text/plain', body: 'none' }
			: { status: 200, contentType: 'application/json', body: JSON.stringify(stamp) }));
}
async function reboot(stamp) {
	await serve(stamp);
	await page.reload({ waitUntil: 'domcontentloaded' });
	// Wait for init's async stamp read to settle, not merely for the module to exist: `booted` is
	// set after `await readStamp()`, so checking too early races it.
	const want = stamp === null ? null : stamp.build;
	// Also wait for DaimondCore: later scenarios set DaimondCore.busy, which races
	// the module's own init otherwise (and a larger wasm makes the race show).
	await page.waitForFunction(
		w => !!window.DaimondUpdater && window.DaimondUpdater.booted() === w && !!window.DaimondCore,
		want, { timeout: 6000 }).catch(() => {});
}
const state = () => page.evaluate(() => (document.getElementById('update-chip') || {}).dataset?.state || null);
const hidden = () => page.evaluate(() => !!(document.getElementById('update-chip') || {}).hidden);
const title  = () => page.evaluate(() => (document.getElementById('update-chip') || {}).title || '');

/// Pretend a turn is running, or is not.
///
/// It waits for `DaimondCore` first, and that wait is the whole reason this is a
/// function. Every one of these assignments races the module's own init, and the
/// race is decided by how long the wasm takes to instantiate — so it was invisible
/// for as long as the bundle stayed the size it was, and then a release that added
/// two modules to it turned "sometimes" into "every time". The failure reads
/// `Cannot set properties of undefined`, which points at this file rather than at
/// the timing, and the note at the top of `reboot` above had already predicted it.
const setBusy = async (v) => {
	await page.waitForFunction(() => !!window.DaimondCore, null, { timeout: 8000 });
	await page.evaluate((b) => { window.DaimondCore.busy = () => b; }, v);
};

try {
	// ── A. Boot reads the stamp; the chip is present and quiet. ──────────────
	await reboot({ build: 'AAA', note: 'first' });
	check('boot records its own build id', (await page.evaluate(() => DaimondUpdater.booted())) === 'AAA');
	// TOP-05: current is the one state with nothing to click for, so it is the
	// one state the chip is not drawn in.
	check('chip is hidden and "current" at boot', (await state()) === 'current' && (await hidden()));

	// ── B. A newer stamp is noticed; chip goes "ready"; NO auto-reload in the foreground. ──
	await serve({ build: 'BBB', note: 'second' });
	await page.evaluate(() => (window.__m = 1));
	await page.evaluate(() => DaimondUpdater.check());
	const sawPending = await until(page, () => DaimondUpdater.pending() === 'BBB');
	check('a newer build is detected on re-check', sawPending);
	check('foreground does NOT auto-reload', (await page.evaluate(() => window.__m)) === 1);
	check('chip shows "ready"', (await state()) === 'ready');
	// Since 3202f51, the stamp's `note` is the deploy's transparency-chain commit
	// subject, not user copy, and is deliberately kept OUT of the chip -- it read
	// as garbage in a popup. The property now guaranteed is the opposite of what
	// this used to assert: the generic "ready" label shows, and the note never
	// leaks into it.
	check('chip carries the generic "ready" label, not the deploy\'s internal note',
		(await title()).includes('Update ready') && !(await title()).includes('second'));

	// ── C. A running turn suppresses even a forced click. ───────────────────
	await setBusy(true);
	await page.evaluate(() => (window.__m = 1));
	await page.evaluate(() => document.getElementById('update-chip').click());
	await new Promise(r => setTimeout(r, 300));
	check('a click does not reload while busy', (await page.evaluate(() => window.__m)) === 1);
	check('chip shows "busy" while a turn runs', (await state()) === 'busy' || (await state()) === 'ready');
	await setBusy(false);

	// ── D. Idle + click → it applies, reloads, and says it updated. ─────────
	await page.evaluate(() => { window.__m = 1; window.DaimondUpdater.check(); });
	await until(page, () => DaimondUpdater.pending() === 'BBB');
	await page.evaluate(() => document.getElementById('update-chip').click()).catch(() => {});
	const reloaded = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 8000);
	check('a click while idle reloads', reloaded);
	const doneShown = await until(page, () => (document.getElementById('update-chip') || {}).dataset?.state === 'done', 4000);
	check('after the update the chip says "updated"', doneShown);
	// Same as the "ready" chip above: the done label is generic and note-free.
	check('the "updated" chip stays generic, not carrying the deploy\'s internal note',
		(await title()).includes('Daimond updated') && !(await title()).includes('second'));

	// ── E. No stamp deployed → the chip stays silent. ───────────────────────
	await reboot(null);
	check('with no stamp the chip is hidden', await hidden());

	// ── G. The gateway refuses this tab (stale) → forced reload, foreground and all. ──
	await reboot({ build: 'GGG', note: 'g' });
	await setBusy(false); await page.evaluate(() => { window.__m = 1; });
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:stale')));
	const staleReloaded = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 8000);
	check('a stale tab force-reloads even in the foreground', staleReloaded);

	// ── H. Stale still never reloads over a running turn; it waits for idle. ──
	await reboot({ build: 'HHH', note: 'h' });
	await setBusy(true); await page.evaluate(() => { window.__m = 1; });
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:stale')));
	await new Promise(r => setTimeout(r, 500));
	check('stale does not reload over a running turn', (await page.evaluate(() => window.__m)) === 1);
	check('the chip goes red (stale) while busy', (await state()) === 'stale');
	await setBusy(false);
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:idle')));
	const staleAfterIdle = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 8000);
	check('stale applies the moment the turn ends', staleAfterIdle);

	// ── I. Loop guard: still stale after a forced reload from the same build → no re-loop. ──
	// (No reboot: we are on HHH with daimond-forced-from=HHH from H's reload.)
	await setBusy(false); await page.evaluate(() => { window.__m = 1; });
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:stale')));
	await new Promise(r => setTimeout(r, 600));
	check('loop guard: does not re-reload from the same build', (await page.evaluate(() => window.__m)) === 1);
	check('loop guard leaves the chip red for the user', (await state()) === 'stale');

	// ── J. A sync round in flight holds the AUTOMATIC path, tells the feed why, ──
	// and the banner (a desktop, not yet given up) says it will reload itself.
	//
	// The one-minute boot guard is real time here, not the fake clock
	// www/js/updater.test.mjs drives -- there is no way to fast-forward an actual
	// browser, so this scenario spends the minute for real before it means anything.
	await reboot({ build: 'JJJ', note: 'j' });
	await setBusy(false);
	await page.evaluate(() => {
		window.__ds = [];
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
		window.DaimondSync = { state: () => ({ quiet: false, busyWith: 'a push is armed' }) };
		// A real, focused browser tab is never `document.hidden`, and this script
		// cannot wait out the ten real minutes `quietEnough` would otherwise want --
		// so it is told this tab is backgrounded, which is the ordinary case the
		// automatic path is FOR (a foreground tab is covered on the fake clock in
		// www/js/updater.test.mjs, which can move ten minutes in an instant).
		Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
	});
	await new Promise(r => setTimeout(r, 61000));
	await serve({ build: 'KKK', note: 'k' });
	await page.evaluate(() => DaimondUpdater.check());
	const sawJ = await until(page, () => DaimondUpdater.pending() === 'KKK');
	check('scenario J: a newer build is detected while sync is busy', sawJ);
	const heldJ = await page.evaluate(() =>
		(window.__ds || []).find(e => e.kind === 'update' && e.payload && e.payload.at === 'held'));
	check('the debug feed holds why the automatic path is held, and it names sync',
		!!heldJ && /^sync:/.test((heldJ.payload || {}).why || ''), heldJ && JSON.stringify(heldJ));
	const bannerTxtJ = await page.evaluate(() => {
		const b = document.querySelector('.update-banner');
		return b && !b.hidden ? b.textContent : null;
	});
	check('the banner carries the desktop auto-reload copy, not the plain one',
		/reloads itself when this desktop is idle/.test(bannerTxtJ || ''), bannerTxtJ);
	// Un-stub sync: the tick asks again inside ten seconds, finds it safe, counts
	// down twenty, and reloads with no click -- which is the whole point here.
	await page.evaluate(() => {
		window.DaimondSync = { state: () => ({ quiet: true, busyWith: '' }) };
		window.__m = 1;
	});
	const reloadedJ = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 35000);
	check('once sync goes quiet the automatic path reloads on its own', reloadedJ);

	// ── K. A standing dialog holds the automatic path; the dialog's own idle bound
	// clears it with no human touching the page; the turn having ended, the
	// automatic path proceeds on its own -- and the banner named the reason while
	// it was held. 2026-09-15: a Publish card stood a full day, `busy()` true
	// throughout because the turn genuinely was that dialog, and nothing bounded
	// an ATTENDED screen nobody was answering. `dialogOpen()` (updater.js) and
	// `armIdleBound` (daimond.js's `dialog()`) are the two-part fix this measures.
	//
	// The "run a command" consent is the vehicle: unlike the net and publish
	// questions, it carried no `deadlineMs` of its own before this change, so
	// what closes it here can only be the new idle bound. `window.__daimondDialogIdleMs`
	// is that bound's own test hook (clamps DOWNWARD only, `netAskDeadline`'s
	// bargain) -- fifteen seconds rather than the real thirty minutes.
	await reboot({ build: 'LLL', note: 'l' });
	// The previous scenario's automatic reload wrote the once-per-ten-minutes
	// gap guard; left in place it would silently refuse THIS scenario's own
	// automatic reload at the end, which would then read as this fix failing.
	await page.evaluate(() => { try { localStorage.removeItem('daimond-soft-at'); } catch (e) {} });
	// The one-minute boot guard is real time here too (see scenario J's own
	// note): `whyUnsafe` checks it BEFORE `dialogOpen`, so a `held()` read taken
	// inside that first minute says 'boot', not 'dialog', whatever else is true.
	await new Promise(r => setTimeout(r, 61000));
	// And `quietEnough`'s ten-minute foreground quiescence is real time as well,
	// for a REAL focused tab -- scenario J's own note. Told backgrounded, exactly
	// as J is, so the automatic reload this scenario ends on is not itself
	// waiting on a clock ten times longer than the one under test.
	await page.evaluate(() => {
		Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
	});
	await setBusy(true);                                    // the turn this dialog belongs to
	await page.evaluate(() => { window.__daimondDialogIdleMs = 15000; });
	await serve({ build: 'MMM', note: 'm' });
	await page.evaluate(() => DaimondUpdater.check());
	const sawK = await until(page, () => DaimondUpdater.pending() === 'MMM');
	check('scenario K: a newer build is detected while a turn runs', sawK);

	const runP = page.evaluate(() => window.__daimondEgressAllowed(
		JSON.stringify({ tool: 'run', url: 'echo hi', detail: '/work' })));
	await page.waitForSelector('.modal.dlg', { timeout: 5000 });

	// PROVEN WHILE THE TURN IS STILL RUNNING: the dialog is the reason, not the
	// bare fact of a turn -- `whyUnsafe` reads `dialogOpen()` before `busy()`,
	// so this is more specific than "a turn is running" would have been.
	const heldDialog = await until(page, () => DaimondUpdater.held() === 'dialog', 15000);
	check('scenario K: a standing dialog holds the automatic path, named specifically',
		heldDialog, await page.evaluate(() => DaimondUpdater.held()));

	// Now the TURN itself concludes (busy() false) while the dialog still stands
	// -- the incident's own shape, a day apart: the turn is not what is left
	// holding this back any more, the dialog is, and the banner has to say so
	// once something asks it to redraw.
	await setBusy(false);
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:idle')));
	const bannerTxtK = await page.evaluate(() => {
		const b = document.querySelector('.update-banner');
		return b && !b.hidden ? b.textContent : null;
	});
	check('scenario K: the banner says why -- "a dialog is open", not merely "available"',
		/a dialog is open/.test(bannerTxtK || ''), bannerTxtK);

	const runResult = await runP;
	check('scenario K: nobody touched the page for the idle window, so it declines itself',
		runResult === 'deny', runResult);
	const dialogGoneK = await until(page, () => !document.querySelector('.modal.dlg'), 20000);
	check('scenario K: the card is gone rather than left standing for ever', dialogGoneK);

	await page.evaluate(() => { window.__m = 1; });
	const reloadedK = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 40000);
	check('scenario K: turn ended and dialog gone -- the automatic reload proceeds on its own',
		reloadedK);

	// ── F. No console errors from any of it. ────────────────────────────────
	// Gateway bootstrap 401s are expected here: this test runs signed-out with no gateway, so those
	// resource-load failures are not the updater's doing. Everything else must be silent.
	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|Unauthorized/.test(e));
	check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('test harness ran to completion', false, String(e && e.message || e));
} finally {
	await s.close();
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
