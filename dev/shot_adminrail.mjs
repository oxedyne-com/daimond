// shot_adminrail.mjs — the rail's split into a pinned Status strip and an
// on-demand Admin drawer. Drives: rest → cog opens Admin (menu) → close →
// Models status row opens Admin (Models) → Esc closes.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'adminrail-shot', signIn: true, connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);
const openState = () => page.$eval('#admin', el => el.classList.contains('admin-open'));

await pause(400);
const r0 = await openState();
await shot(s, 'adminrail-rest');            // drawer closed, Status strip only

// The cog opens the Admin drawer on its menu.
await page.click('#settings-btn', { force: true });
await pause(350);
const r1 = await openState();
const title1 = await page.$eval('#admin-drawer-title', el => el.textContent);
await shot(s, 'adminrail-cog-open');

// Close it with the drawer's ×.
await page.click('#admin-close', { force: true });
await pause(350);
const r2 = await openState();

// A Status row (Models) opens the drawer straight to that section.
await page.click('#astat-model', { force: true });
await pause(400);
const r3 = await openState();
const title3 = await page.$eval('#admin-drawer-title', el => el.textContent);
const modelsShown = await page.$eval('#admin-models', el => el.style.display !== 'none');
await shot(s, 'adminrail-models-open');

// Esc closes it.
await page.keyboard.press('Escape');
await pause(350);
const r4 = await openState();

// A click outside the rail also closes it (open, then click the stage).
await page.click('#settings-btn', { force: true });
await pause(300);
const r5open = await openState();
await page.mouse.click(760, 400);           // somewhere on the stage
await pause(300);
const r6 = await openState();

console.log(JSON.stringify({
	rest_closed:        r0 === false,
	cog_opens:          r1 === true,
	cog_title_admin:    title1.trim() === 'Admin',
	x_closes:           r2 === false,
	models_row_opens:   r3 === true && modelsShown,
	models_title:       title3.trim() === 'Models',
	esc_closes:         r4 === false,
	clickaway_opens:    r5open === true,
	clickaway_closes:   r6 === false,
}, null, 2));

const realErrs = s.errs.filter(e => !/502|Bad Gateway|\/api\b/.test(e));
const ok = r0 === false && r1 === true && title1.trim() === 'Admin' && r2 === false
	&& r3 === true && modelsShown && title3.trim() === 'Models' && r4 === false
	&& r5open === true && r6 === false && realErrs.length === 0;
console.log(ok ? '\n✅ PASS' : '\n❌ FAIL');
if (realErrs.length) console.log('ERRORS:', realErrs);
await s.close();
process.exit(ok ? 0 : 1);
