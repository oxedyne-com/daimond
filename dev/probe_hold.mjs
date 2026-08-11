// probe_hold.mjs — a picture of where the ◈ is, following the path a person takes.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'probehold' });
const { page } = s;

await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Where is the diamond button');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(800);

await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: 'notes/mine.md', content: '# Mine\nBrought in by me.\n' }));
});

// What the panel is called where a person would look for it.
const labels = await page.evaluate(() => ({
	nav: [...document.querySelectorAll('[data-panel], .panel-tab, .rail-btn')]
		.map(e => ((e.getAttribute('data-panel') || '') + '=' + (e.textContent || e.getAttribute('title') || '').trim()).slice(0, 40))
		.filter(x => x.length > 2).slice(0, 14),
}));
console.log('panel entry points:', JSON.stringify(labels.nav, null, 1));

// Before a Diamond is opened.
await page.evaluate(() => DaimondPanels.show('work'));
await page.waitForTimeout(600);
await page.fill('.files-filter-input', 'mine');
await page.waitForTimeout(800);
for (const row of await page.$$('.files-row')) {
	const nm = await row.$eval('.files-name', e => e.textContent).catch(() => '');
	if (nm.includes('mine.md')) { await row.click({ force: true }); break; }
}
await page.waitForTimeout(1500);
const before = await page.evaluate(() => {
	const b = document.querySelector('[data-act="attach"]');
	if (!b) return 'no hold button in the DOM at all';
	const r = b.getBoundingClientRect();
	return { display: b.style.display, w: Math.round(r.width), h: Math.round(r.height) };
});
console.log('with NO Diamond open:', JSON.stringify(before));
await shot(s, 'hold-file-open-no-diamond');

// Now open the Diamond and look at the same file.
await page.$$eval('.diamond-box', els => els[0] && els[0].click());
await page.waitForTimeout(1200);
await page.evaluate(() => DaimondPanels.show('work'));
await page.waitForTimeout(600);
await page.fill('.files-filter-input', 'mine');
await page.waitForTimeout(800);
for (const row of await page.$$('.files-row')) {
	const nm = await row.$eval('.files-name', e => e.textContent).catch(() => '');
	if (nm.includes('mine.md')) { await row.click({ force: true }); break; }
}
await page.waitForTimeout(1500);
const after = await page.evaluate(() => {
	const b = document.querySelector('[data-act="attach"]');
	if (!b) return 'no hold button';
	const r = b.getBoundingClientRect();
	// Its neighbours, so the answer can say WHERE on screen it is.
	const bar = b.parentElement;
	return {
		label: b.getAttribute('aria-label'),
		visible: r.width > 0 && r.height > 0,
		at: { x: Math.round(r.x), y: Math.round(r.y) },
		siblings: [...bar.children].map(c => (c.textContent || '').trim().slice(0, 12)),
	};
});
console.log('with the Diamond open:', JSON.stringify(after, null, 1));
await shot(s, 'hold-file-open-diamond');
await s.browser.close();
