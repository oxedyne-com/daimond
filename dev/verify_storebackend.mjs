// gateway: none
// verify_storebackend -- the store backend conformance suite (src/store/conformance.rs) run on OPFS in the page, through
// the debug-only export `__store_conformance` (a debug build, or `--features store_conformance`).
//
// WHY THIS EXISTS. d1_plan §9.2 D1cm: the native store runs over a memory backend now and Ozone later, and OPFS is the
// reference for both.  The same suite that holds the memory store natively runs here on OPFS, case by case, so a case
// OPFS fails is a fault in the suite's reading of OPFS, and one the other backends pass where OPFS does not is theirs.
//
//   node dev/verify_storebackend.mjs
import { open } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const s = await open({ name: 'verify_storebackend', signIn: true, connect: false, defaults: false });
const page = s.page;

const got = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	if (typeof m.__store_conformance !== 'function') return { missing: true };
	let cases;
	try { cases = JSON.parse(await m.__store_conformance('__conformance/verify_' + Date.now())); }
	catch (e) { return { error: String(e) }; }
	// The suite leaves no data: not its own folder, nor the `__conformance` folder above it.
	const top = await navigator.storage.getDirectory();
	let left = false;
	try { await top.getDirectoryHandle('__conformance'); left = true; } catch (_) {}
	return { cases, left };
});

if (got.missing) {
	check('the build exports __store_conformance (debug, or --features store_conformance)', false);
} else if (got.error) {
	check('the suite ran', false, got.error);
} else {
	check('the suite ran every case', got.cases.length >= 22, `${got.cases.length} cases`);
	for (const c of got.cases) check(c.name, c.ok, c.why);
	check('the suite leaves no __conformance folder in OPFS', !got.left);
}

console.log(`${ok} ok, ${bad} failed`);
await s.browser.close().catch(() => {});
process.exit(bad ? 1 : 0);
