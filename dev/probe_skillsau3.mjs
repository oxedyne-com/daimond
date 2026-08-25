import { open } from './harness.mjs';
const s = await open({ name: 'skillsau3', defaults: false });
const { page } = s;
const msgs = [];
page.on('console', m => msgs.push(m.type() + ': ' + m.text().slice(0, 200)));
page.on('pageerror', e => msgs.push('PAGEERROR: ' + String(e).slice(0, 200)));
await page.waitForTimeout(2500);
await page.evaluate(() => DaimondPanels.show('work'));
await page.waitForTimeout(1200);
const out = {};
// Blank the file so the chip is in its empty state.
out.blanked = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.store_write('DAIMOND.md', '');
	return String(await m.store_read('DAIMOND.md') || '').length;
});
await page.reload(); await page.waitForTimeout(3000);
await page.evaluate(() => DaimondPanels.show('work'));
await page.waitForTimeout(1200);
out.chip = await page.evaluate(() => {
	const e = document.getElementById('instructions-chip');
	return e ? { d: e.style.display, empty: e.getAttribute('data-empty') } : null;
});
out.seedExported = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	return typeof m.instructions_seed === 'function' ? String(m.instructions_seed()).length : 'absent';
});
msgs.length = 0;
out.box = await page.evaluate(() => {
	const e = document.getElementById('instructions-chip');
	if (!e) return null;
	const r = e.getBoundingClientRect();
	return { w: r.width, h: r.height, x: r.x, y: r.y, onclick: typeof e.onclick,
		panel: (e.closest('[id^=panel-]') || {}).id || null,
		panelShown: (() => { const p = e.closest('[id^=panel-]'); return p ? getComputedStyle(p).display : null; })() };
});
// Dispatched on the element rather than at its coordinates: the reload above drops
// the session, so the unlock modal is over the page and intercepts a real pointer.
// What is under test is the chip's own handler.
await page.evaluate(() => document.getElementById('instructions-chip').click());
await page.waitForTimeout(3000);
out.after = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	let bytes = 0; try { bytes = String(await m.store_read('DAIMOND.md') || '').length; } catch (e) {}
	let ws = 0; try { ws = String(await m.read_file('DAIMOND.md') || '').length; } catch (e) { ws = 'read err'; }
	const e = document.getElementById('instructions-chip');
	return { storeBytes: bytes, workspaceBytes: ws, empty: e && e.getAttribute('data-empty'),
		editorOpen: /How to answer me/.test(document.body.innerText) };
});
out.console = msgs.slice(0, 12);
console.log(JSON.stringify(out, null, 1));
await s.browser.close();
