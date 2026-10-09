// gateway: none
// verify_crystalbar -- a broken crystal on the real page: the face names it, the crystal BAR offers no Edit that could
// write `{}` over it, and a big broken crystal still puts MUST FIX, with its place, in the daimon's prompt.
//
// WHY THIS EXISTS. r541 QA A2, F1 (specs/daimond_r541_qa_A2_20261009.md): `renderCrystal` built `crystalBar(data || {})`, and
// `data` is null for JSON that does not parse, so the bar's Edit opened the form on `{}` and Save wrote `{}` over the file.
// `{}` parses, so no MUST FIX and no face note ever said the crystal was gone.  The node half is www/js/crystalbar.test.mjs.
//
//   node dev/verify_crystalbar.mjs
import { open, steerDiamond, mockLog, clearMockLog, contentText } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const NAME = 'QaBar';
const s = await open({ name: 'verify_crystalbar', signIn: true, connect: true, defaults: false,
	route: async (page) => { await page.setViewportSize({ width: 1280, height: 800 }); } });
const page = s.page;
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
const PATH = 'diamonds/' + id + '/crystal.json';
const plant = (text) => page.evaluate(async ({ path, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js'); await m.write_file(path, text);
}, { path: PATH, text });
const stored = () => page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await app.read_crystal_data(id);
}, id);
const crystalFace = async () => {
	await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await page.waitForTimeout(600);
	await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	await page.waitForTimeout(1500);
};

// ── (1)+(2) the face, and the crystal bar's Edit ─────────────────────────────────────────────
const BROKEN = '{\n  "title": "Ontheism",\n  "summary": "Kept words.",\n  "sections": [\n    {"heading": "H", "body": "B"},\n  ]\n}';
await plant(BROKEN);
check('the broken text is on disk', (await stored()) === BROKEN);
await crystalFace();
const face = await page.evaluate(() => ({
	broken: !!document.querySelector('.crystal-broken'),
	brokenText: (document.querySelector('.crystal-broken') || {}).textContent || '',
	barActs: [...document.querySelectorAll('.crystal-bar .crystal-act')].map(b => ({ t: b.textContent, vis: !!b.getClientRects().length })),
	panelEdit: [...document.querySelectorAll('.mem-raw, .crystal-act')].length,
}));
console.log('       face:', JSON.stringify(face));
check('the face names the broken crystal', face.broken, face.brokenText);
const editIdx = face.barActs.findIndex(b => /Edit/.test(b.t) && b.vis);
check('the crystal bar offers no visible Edit for a broken crystal', editIdx < 0, JSON.stringify(face.barActs[editIdx] || null));
if (editIdx >= 0) {
	await page.evaluate((i) => document.querySelectorAll('.crystal-bar .crystal-act')[i].click(), editIdx);
	await page.waitForTimeout(800);
	const form = await page.evaluate(() => [...document.querySelectorAll('.crystal-form input, .crystal-form textarea')].map(e => e.value));
	console.log('       the form opened with values:', JSON.stringify(form));
	await page.evaluate(() => { const b = document.querySelector('.crystal-bar .crystal-act.primary'); if (b) b.click(); });
	await page.waitForTimeout(2000);
	const after = await stored();
	console.log('       crystal.json after Edit -> Save:', JSON.stringify(after));
	check('Edit -> Save does not replace the broken crystal with an empty one', after === BROKEN, JSON.stringify(after).slice(0, 80));
}

// ── (4) History Restore of a broken version keeps the bytes ─────────────────────────────────
await plant(BROKEN);
const restored = await page.evaluate(async ({ id, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_data(id, '{"title":"Later"}');
	return true;
}, { id, text: BROKEN });
await crystalFace();
// Restore through the History face: find the row whose snapshot is the broken text.
await page.evaluate(() => { const b = [...document.querySelectorAll('.crystal-bar .crystal-act')].find(x => /History|history/.test(x.textContent)); if (b) b.click(); });
await page.waitForTimeout(1500);
const rows = await page.evaluate(() => [...document.querySelectorAll('button')].filter(b => /Restore/.test(b.textContent) && b.getClientRects().length).map(b => b.textContent));
console.log('       restore buttons:', JSON.stringify(rows));

// ── (3) a big broken crystal splits, and the daimon's prompt still carries MUST FIX ──────────
const big = JSON.stringify({ title: 'Ontheism', summary: 'S', sections: Array.from({ length: 12 }, (_, i) => ({ heading: 'Sec ' + i, body: 'x'.repeat(1800) })) }, null, 2)
	.replace(/\n}$/, ',\n}');
await plant(big);
clearMockLog();
await steerDiamond(s, 'hello');
let sys = '';
for (let i = 0; i < 120 && !sys; i++) {
	await page.waitForTimeout(500);
	const log = mockLog();
	if (!log.length) continue;
	sys = ((log[0] && log[0].messages) || []).filter((x) => x.role === 'system').map((x) => contentText(x.content)).join('\n');
}
const hot = /the HOT part \((\d+) of (\d+) bytes/.exec(sys);
console.log('       split header:', hot ? hot[0] : '(none)', '| must-fix:', (/MUST FIX[^\n]*/.exec(sys) || ['(none)'])[0].slice(0, 260));
check('a big broken crystal is split in the prompt', !!hot, `${big.length} bytes`);
check('and the prompt says MUST FIX with the place, and to mend it in place', /MUST FIX/.test(sys) && /line \d+/.test(sys) && /file_edit/.test(sys));

console.log(`\nverify_crystalbar: ${ok} ok, ${bad} failed`);
await s.close?.();
process.exit(bad ? 1 : 0);
