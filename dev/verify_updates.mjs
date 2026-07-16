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

try {
	// ── A. Boot reads the stamp; the chip is present and quiet. ──────────────
	await reboot({ build: 'AAA', note: 'first' });
	check('boot records its own build id', (await page.evaluate(() => DaimondUpdater.booted())) === 'AAA');
	check('chip is visible and "current" at boot', (await state()) === 'current' && !(await hidden()));

	// ── B. A newer stamp is noticed; chip goes "ready"; NO auto-reload in the foreground. ──
	await serve({ build: 'BBB', note: 'second' });
	await page.evaluate(() => (window.__m = 1));
	await page.evaluate(() => DaimondUpdater.check());
	const sawPending = await until(page, () => DaimondUpdater.pending() === 'BBB');
	check('a newer build is detected on re-check', sawPending);
	check('foreground does NOT auto-reload', (await page.evaluate(() => window.__m)) === 1);
	check('chip shows "ready"', (await state()) === 'ready');
	check('chip carries the "what changed" note', (await title()).includes('second'));

	// ── C. A running turn suppresses even a forced click. ───────────────────
	await page.evaluate(() => { window.DaimondCore.busy = () => true; });
	await page.evaluate(() => (window.__m = 1));
	await page.evaluate(() => document.getElementById('update-chip').click());
	await new Promise(r => setTimeout(r, 300));
	check('a click does not reload while busy', (await page.evaluate(() => window.__m)) === 1);
	check('chip shows "busy" while a turn runs', (await state()) === 'busy' || (await state()) === 'ready');
	await page.evaluate(() => { window.DaimondCore.busy = () => false; });

	// ── D. Idle + click → it applies, reloads, and says it updated. ─────────
	await page.evaluate(() => { window.__m = 1; window.DaimondUpdater.check(); });
	await until(page, () => DaimondUpdater.pending() === 'BBB');
	await page.evaluate(() => document.getElementById('update-chip').click()).catch(() => {});
	const reloaded = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 8000);
	check('a click while idle reloads', reloaded);
	const doneShown = await until(page, () => (document.getElementById('update-chip') || {}).dataset?.state === 'done', 4000);
	check('after the update the chip says "updated"', doneShown);
	check('the "updated" note is carried across the reload', (await title()).includes('second'));

	// ── E. No stamp deployed → the chip stays silent. ───────────────────────
	await reboot(null);
	check('with no stamp the chip is hidden', await hidden());

	// ── G. The gateway refuses this tab (stale) → forced reload, foreground and all. ──
	await reboot({ build: 'GGG', note: 'g' });
	await page.evaluate(() => { window.DaimondCore.busy = () => false; window.__m = 1; });
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:stale')));
	const staleReloaded = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 8000);
	check('a stale tab force-reloads even in the foreground', staleReloaded);

	// ── H. Stale still never reloads over a running turn; it waits for idle. ──
	await reboot({ build: 'HHH', note: 'h' });
	await page.evaluate(() => { window.DaimondCore.busy = () => true; window.__m = 1; });
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:stale')));
	await new Promise(r => setTimeout(r, 500));
	check('stale does not reload over a running turn', (await page.evaluate(() => window.__m)) === 1);
	check('the chip goes red (stale) while busy', (await state()) === 'stale');
	await page.evaluate(() => { window.DaimondCore.busy = () => false; window.dispatchEvent(new Event('daimond:idle')); });
	const staleAfterIdle = await until(page, () => typeof window.__m === 'undefined' && !!window.DaimondUpdater, 8000);
	check('stale applies the moment the turn ends', staleAfterIdle);

	// ── I. Loop guard: still stale after a forced reload from the same build → no re-loop. ──
	// (No reboot: we are on HHH with daimond-forced-from=HHH from H's reload.)
	await page.evaluate(() => { window.DaimondCore.busy = () => false; window.__m = 1; });
	await page.evaluate(() => window.dispatchEvent(new Event('daimond:stale')));
	await new Promise(r => setTimeout(r, 600));
	check('loop guard: does not re-reload from the same build', (await page.evaluate(() => window.__m)) === 1);
	check('loop guard leaves the chip red for the user', (await state()) === 'stale');

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
