// shot_crystaldefault — one picture of a Diamond's crystal page (a stored 09-15 default) in one look.
//   node dev/shot_crystaldefault.mjs --look obsidian|porcelain|sharp|warm --out FILE [--phone] [--edited]
// --edited: the stored page is the same default with a paragraph added (a daimon's first edit), still carrying the shipped grey :root.
// Sharp and Warm are shelved (DaimondSkin.set resolves to Daylight), so for them the skin attribute is
// set directly after boot, the only way to see what the page does under them.
import { open } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const LOOK = arg('--look') || 'obsidian', OUT = arg('--out'), PHONE = argv.includes('--phone'), EDITED = argv.includes('--edited');
let html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'crystaldefaults', '20260915.html'), 'utf8');
if (EDITED) html = html.replace('<div id="r"></div>', '<div id="r"></div><p class="mine">Added by the daimon on its first edit.</p>');
const theme = LOOK === 'porcelain' ? 'porcelain' : 'obsidian';
const DATA = { title: 'Harbour survey', summary: 'Soundings for the **north mole**, taken at `02:40:17` on the ebb.',
	sections: [{ heading: 'Readings', body: 'Depth held at 7.2 m across the channel.\n\n```\nmole.north  7.2 m\n```\n\n> Hold the line at the mole.' }],
	facts: [{ k: 'Tide', v: 'ebb' }, { k: 'Crew', v: 'three' }, { k: 'Visibility', v: 'good' }], links: [{ label: 'Chart notes', href: 'https://example.com/chart' }], soundings: { depth: '7.2 m' } };
const s = await open({ name: 'shot' + LOOK, signIn: true, connect: true, defaults: false, ...(PHONE ? { isMobile: true, touch: true } : {}),
	route: async (page) => {
		await page.setViewportSize(PHONE ? { width: 390, height: 844 } : { width: 1440, height: 900 });
		await page.addInitScript((th) => { try { localStorage.setItem('daimond-skin', 'daylight'); localStorage.setItem('daimond-theme', th); } catch (e) {} }, theme);
	} });
const { page } = s;
await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
await page.waitForTimeout(900);
await page.fill('.dlg-input', 'Harbour survey').catch(() => {});
await page.click('.dlg-ok', { force: true }).catch(() => {});
await page.waitForTimeout(2500);
await page.evaluate(async ({ data, html }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Harbour survey');
	await app.run_tool('file_write', JSON.stringify({ path: 'diamonds/' + d.id + '/crystal.json', content: JSON.stringify(data) }));
	await app.write_crystal_page(d.id, html);
}, { data: DATA, html });
if (LOOK === 'sharp' || LOOK === 'warm') await page.evaluate((k) => document.documentElement.setAttribute('data-skin', k), LOOK);
await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
await page.waitForTimeout(700);
await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
for (let i = 0; i < 40; i++) {
	const st = await page.evaluate(() => window.DaimondCrystal ? DaimondCrystal._state() : null);
	if (st && st.mode === 'frame' && st.keys.length) break;
	await page.waitForTimeout(250);
}
await page.waitForTimeout(1200);
const fh = await page.$('iframe.crystal-frame'), fr = fh ? await fh.contentFrame() : null;
if (fr) console.log('  links', JSON.stringify(await fr.evaluate(() => {
	const a = document.querySelector('a'), u = document.querySelector('ul');
	const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
	const cs = a ? getComputedStyle(a) : null;
	return { a: r(a), ul: r(u), body: r(document.body), docH: document.documentElement.scrollHeight, color: cs && cs.color, vis: cs && cs.visibility, op: cs && cs.opacity,
		html: u ? u.outerHTML.slice(0, 160) : null, frameH: innerHeight };
})));
await page.screenshot({ path: OUT });
// The panel scrolls when the page is taller than it: a second picture at the foot, so the whole page is seen.
const moved = await page.evaluate(() => {
	let e = document.querySelector('iframe.crystal-frame');
	while (e && e !== document.body) {
		const o = getComputedStyle(e).overflowY;
		if ((o === 'auto' || o === 'scroll') && e.scrollHeight > e.clientHeight + 4) { e.scrollTop = e.scrollHeight; return [e.scrollHeight, e.clientHeight]; }
		e = e.parentElement;
	}
	return null;
});
if (moved) { console.log('  scrolled', JSON.stringify(moved)); await page.waitForTimeout(500); await page.screenshot({ path: OUT.replace('.png', '_foot.png') }); }
console.log('  shot ' + OUT);
await s.browser.close().catch(() => {});
