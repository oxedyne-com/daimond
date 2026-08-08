// Does signing in leave the Admin drawer alone?
//
// It did not. `afterUnlock` called `DaimondAdmin.home()` to bring the account's
// controls up to date, and that one call both RENDERED the home view and
// SUMMONED the drawer -- so every sign-in ended with Admin standing open over
// the app, whatever the user had done with it last time. The drawer is a
// transient surface by its own stylesheet's account: summoned, and gone again
// when finished.
//
// The test signs in a SECOND time, after a reload, because that is the
// complaint: not that the drawer opens, but that closing it does not stick
// across a session. It also proves the cog still opens it and clicking away
// still shuts it -- a test that only looked for "closed" would pass just as
// well against a drawer that had stopped working altogether.
//
// `open()` itself leaves the drawer open: `connectMock` drives the model form
// through the cog and does not put it away. That is the harness, not the app,
// so the state is normalised before anything is asserted.
import { open, shot, signInAs } from './harness.mjs';

const s = await open({ name: 'drawerclosed' });
const { page } = s;
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

const drawerOpen = () => page.evaluate(() => {
	const a = document.getElementById('admin');
	return !!(a && a.classList.contains('admin-open'));
});
// The dismissal the drawer documents (`outsideClose`), which listens for
// mousedown rather than click.
const clickAway = async () => {
	await page.evaluate(() => {
		document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
	});
	await page.waitForTimeout(400);
};

// ── Normalise: put away whatever the harness left open ──────────────────────
await clickAway();
check((await drawerOpen()) === false, 'clicking away shuts the drawer');

// ── The complaint: close it, come back, and find it open again ──────────────
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(800);
await signInAs(s, 'drawer');
await page.waitForTimeout(1000);
check((await drawerOpen()) === false,
	'signing in again does NOT reopen the drawer');

// ── The other half: it must still be reachable and still render ─────────────
await page.click('#settings-btn', { force: true });
await page.waitForTimeout(700);
check((await drawerOpen()) === true, 'the cog still opens it');

const sections = await page.$$eval('.admin-sec', els => els.map(e => e.textContent.trim()));
console.log('drawer sections:', JSON.stringify(sections));
check(sections.filter(Boolean).length > 0,
	'the home view still renders its sections');

await shot(s, 'drawer-closed');
console.log(bad ? `\n${bad} FAILED` : '\nall passed');
process.exit(bad ? 1 : 0);
