// gateway: none
// verify_crystalsync -- a crystal changed elsewhere repaints the page on screen (U-A #1, D-20261006-07).
//
// The owner saw an old Life log on his second device every day: `onDiamondsChangedElsewhere` adopted the
// arriving record and never drew the crystal again. Here the "elsewhere" is the store written behind the
// page's back and the same `storage` event another tab (or the sync path) raises. Held to:
//   * the page on screen shows the new memory, without clicking away and back;
//   * an open memory panel is not wiped, and closing it shows the new memory;
//   * an open Edit form is not wiped, and its Cancel shows the new memory.
// The node half is www/js/crystalsync.test.mjs.
//
//   node dev/verify_crystalsync.mjs            (DAIMOND_BROWSER=webkit for the owner's engine)
import { open } from './harness.mjs';

let bad = 0;
const check = (name, cond, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	if (!cond) bad++;
};
const NAME = 'QaSync';
const s = await open({ name: 'verify_crystalsync', signIn: true, connect: true, defaults: false,
	route: async (page) => { await page.setViewportSize({ width: 1280, height: 800 }); } });
const page = s.page;
// Playwright's WebKit has no OPFS, so no Diamond can be made there (see verify_crystalfont.mjs). The one engine-dependent
// piece of the repaint is the memory panel's `toggle` event on close, so that is what is held to there, and the store
// path is recorded as a LIMIT rather than skipped silently.
if (!await page.evaluate(() => !!(navigator.storage && navigator.storage.getDirectory))) {
	const fired = await page.evaluate(() => new Promise((res) => {
		const d = document.createElement('details'); d.open = true; document.body.appendChild(d);
		setTimeout(() => {
			d.addEventListener('toggle', () => res(!d.open));
			d.open = false;
			setTimeout(() => res(false), 2000);
		}, 50);
	}));
	check('closing a <details> fires `toggle` with it closed (the deferred repaint\'s trigger)', fired);
	console.log('  LIMIT no OPFS in this engine: the store-path checks run on Chromium only');
	await s.close().catch(() => {});
	console.log(bad ? bad + ' failure(s)' : 'all checks passed (1 recorded limit)');
	process.exit(bad ? 1 : 0);
}
await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
await page.waitForTimeout(900);
await page.fill('.dlg-input', NAME).catch(() => {});
await page.click('.dlg-ok', { force: true }).catch(() => {});
await page.waitForTimeout(2500);
const id = await page.evaluate(async (name) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === name);
	return d ? d.id : '';
}, NAME);
check('a Diamond was made', !!id, id);

// Another device's write: the store changes under the page, then the event the sync path raises.
const elsewhere = (title) => page.evaluate(async ({ id, title }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_data(id, JSON.stringify({ title, summary: 'Written on another device.' }, null, 2));
	window.dispatchEvent(new StorageEvent('storage', { key: 'daimond-diamonds-rev', newValue: String(Date.now()) }));
}, { id, title });
// The words the page's frame shows. The frame is sandboxed, so it is read through Playwright's frame list.
const frameText = async () => {
	try {
		const h = await page.$('#crystal-frame-wrap iframe');
		const f = h && await h.contentFrame();
		return f ? await f.evaluate(() => document.body ? document.body.innerText : '') : '';
	} catch (e) { return ''; }      // a frame mid-teardown
};
const waitFor = async (re, ms) => {
	for (let i = 0; i < ms / 250; i++) { if (re.test(await frameText())) return true; await page.waitForTimeout(250); }
	return false;
};

await page.evaluate(async ({ id }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_data(id, JSON.stringify({ title: 'Alpha' }, null, 2));
}, { id });
await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
await page.waitForTimeout(600);
await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
check('the page shows the crystal it was opened on', await waitFor(/Alpha/, 6000), (await frameText()).slice(0, 80));

// (1) Changed elsewhere, nothing touched here.
await elsewhere('Bravo');
check('a crystal changed elsewhere is on screen without clicking away and back', await waitFor(/Bravo/, 5000),
	(await frameText()).slice(0, 80));

// (2) The memory panel is open: it stays open, and closing it shows the change.
await page.evaluate(() => { const d = document.querySelector('.crystal-memory'); if (d) d.open = true; });
await page.waitForTimeout(300);
await elsewhere('Charlie');
await page.waitForTimeout(2000);
const held = await page.evaluate(() => { const d = document.querySelector('.crystal-memory'); return !!(d && d.open); });
check('an open memory panel is not wiped by the change', held);
check('and the page waits for it', !/Charlie/.test(await frameText()), (await frameText()).slice(0, 80));
await page.evaluate(() => { const d = document.querySelector('.crystal-memory'); if (d) d.open = false; });
check('closing the memory panel shows the change', await waitFor(/Charlie/, 5000), (await frameText()).slice(0, 80));

// (3) The Edit form is open: it stays, and Cancel shows the change.
await page.evaluate(() => { const b = [...document.querySelectorAll('.crystal-bar .crystal-act')].find(x => /Edit/.test(x.textContent)); if (b) b.click(); });
await page.waitForTimeout(800);
const formUp = await page.evaluate(() => !!document.querySelector('.crystal-form'));
check('the Edit form opened', formUp);
await elsewhere('Delta');
await page.waitForTimeout(2000);
check('an open Edit form is not wiped by the change', await page.evaluate(() => !!document.querySelector('.crystal-form')));
await page.evaluate(() => { const b = [...document.querySelectorAll('.crystal-bar .crystal-act')].find(x => /Cancel/.test(x.textContent)); if (b) b.click(); });
check('and its Cancel shows the change', await waitFor(/Delta/, 5000), (await frameText()).slice(0, 80));

await s.close().catch(() => {});
console.log(bad ? bad + ' failure(s)' : 'all checks passed');
process.exit(bad ? 1 : 0);
