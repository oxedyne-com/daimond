// verify_version.mjs — the browser notices when the gateway declares it too old.
//
// Phase-2 compatibility contract, client half: gateway.js sends `X-Daimond-Api` on every call and
// inspects the reply. A 426, or an advertised `x-daimond-min-api` above this build's version, means
// the tab is out of date -- it fires `daimond:stale`, which the updater turns into a forced reload.
// Here we route a real gateway call to each of those two answers and confirm the event fires. The
// loop guard (daimond-forced-from) is pre-set to this build so the assertion does not itself reload
// the page out from under us; the forced-reload behaviour is covered in verify_updates.mjs.
//
// Needs an unlocked identity, because the only unconditional gateway call is bootstrap().
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'version', signIn: true, connect: false });
const { page } = s;

// Wait for both the updater and the gateway client to be live.
await page.waitForFunction(() => !!window.DaimondUpdater && !!window.DaimondGateway, null, { timeout: 8000 }).catch(() => {});

// Pre-set the loop guard to this build, so onStale reaches its "already tried" branch and does NOT
// reload during the test.
await page.evaluate(() => {
	var b = window.DaimondUpdater && window.DaimondUpdater.booted();
	try { if (b) sessionStorage.setItem('daimond-forced-from', b); } catch (e) {}
});

// Fire bootstrap() (its first call is POST /api/account) against a routed answer, and watch for the
// staleness event.
async function firesStaleWhen(fulfil) {
	await page.unroute('**/api/account').catch(() => {});
	await page.route('**/api/account', route => route.fulfill(fulfil));
	return page.evaluate(() => new Promise(resolve => {
		window.addEventListener('daimond:stale', () => resolve(true), { once: true });
		try { window.DaimondGateway.bootstrap().catch(() => {}); } catch (e) {}
		setTimeout(() => resolve(false), 3500);
	}));
}

try {
	const on426 = await firesStaleWhen({
		status: 426, contentType: 'application/json',
		body: JSON.stringify({ ok: false, error: 'old', min_api: 2, api: 2 }),
	});
	check('a 426 from the gateway fires daimond:stale', on426);

	const onHeader = await firesStaleWhen({
		status: 200, contentType: 'application/json',
		headers: { 'x-daimond-min-api': '2', 'x-daimond-api': '2' },
		body: JSON.stringify({ ok: true }),
	});
	check('an advertised min-api above this build fires daimond:stale', onHeader);

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|426|502|Unauthorized/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('test harness ran to completion', false, String(e && e.message || e));
} finally {
	await s.close();
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
