// verify_bootclients.mjs — building the engine's client builds one client, not thousands.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// On 2026-09-23 a run of dev/verify_marknotice.mjs logged `memory access out of bounds` from the
// page, once in a while and never at a step of its own. The trap was in the wasm allocator, freeing
// a `DaimondApp` the collector had finalised during the boot. Its heap had been corrupted earlier,
// by a JavaScript stack overflow that landed inside a wasm call -- and the overflow was the end of a
// loop: `diamondApp()` put the user's engine-wide settings on the app it was building BEFORE filing
// it, and the setters asked `diamondApp()` for an app to set them through. That missed the cache,
// so it built another, which asked again: some six thousand apps a boot, on base as well. The held
// delete's setter joined the loop on 2026-09-23, and from then on the overflow corrupted the heap
// in three boots out of four.
//
// ── WHAT IT ASSERTS ──────────────────────────────────────────────────────────
//
//   1. Signing in and connecting a provider builds a handful of engine clients, not thousands.
//   2. Saving a provider empties the client cache; building again is again a handful.
//   3. No page error in the run.
//
// Counted at `FinalizationRegistry.prototype.register`, which wasm-bindgen's glue calls once for
// every `DaimondApp` it constructs; the count is installed before any script on the page runs.
//
// Needs a world for the mock provider: `eval "$(bash dev/world.sh N --env)"`.
import { open, connectMock } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// One client per provider and model a Diamond or a chat is built for, the file tools' own and the
// settings panel's. A boot on the fixed build measured 3 (2026-09-23); the loop built 6,000 and more.
const HANDFUL = 16;

const s = await open({ name: 'bootclients',
	route: async (page) => {
		page.setDefaultNavigationTimeout(180000);
		await page.addInitScript(() => {
			window.__daimondApps = 0;
			const register = FinalizationRegistry.prototype.register;
			FinalizationRegistry.prototype.register = function (target, held, token) {
				if (target && target.constructor && target.constructor.name === 'DaimondApp') {
					window.__daimondApps++;
				}
				return register.call(this, target, held, token);
			};
		});
	} });
const p = s.page;
const built = () => p.evaluate(() => window.__daimondApps);

// The boot's own deferred work: the rail, the settings panel, the first sync.
await p.waitForTimeout(5000);
const boot = await built();
check('1. signing in and connecting a provider builds a handful of engine clients',
	boot > 0 && boot <= HANDFUL, String(boot));

// A provider saved empties the cache, and the Diamond's client is then built afresh.
await connectMock(s);
await p.waitForTimeout(1500);
await p.evaluate(() => DaimondCore.diamondApp());
await p.waitForTimeout(1500);
const again = (await built()) - boot;
check('2. after a provider is saved, building again is again a handful',
	again > 0 && again <= HANDFUL, String(again));

const pageErrors = s.errs.filter((e) => /^pageerror|PAGE CRASHED/.test(e));
check('3. no page error in the run', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
