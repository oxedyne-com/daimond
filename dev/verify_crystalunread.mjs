// gateway: none
// verify_crystalunread -- a crystal.json that is not a crystal is NOT drawn as an empty, editable one: the face says it
// could not be read, the bar offers no Edit, no raw editor opens over it, and its bytes are left exactly as they were.
//
// WHY THIS EXISTS. r544 QA C, F-C1 (specs/daimond_r544_qa_C_20261009.md): the page read any text that did not start with
// `{` as legacy markdown, so binary bytes, an encrypted-looking blob and a zero-byte file were drawn as "Nothing kept here
// yet" with Edit, and Edit -> Save wrote them back as `{"sections":[{"heading":"","body":"<the blob>"}]}`.  Bytes that are
// not UTF-8 were already lost to the engine's `from_utf8_lossy`.  Arms: a binary-ish text, a ciphertext-like blob, bytes
// that are not UTF-8, a zero-byte file beside a version that holds a crystal; controls: valid JSON and a fresh Diamond
// still edit, and BOM-prefixed JSON is still named broken (to be mended) rather than drawn.
//
//   node dev/verify_crystalunread.mjs
import { open } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const s = await open({ name: 'verify_crystalunread', signIn: true, connect: true, defaults: false,
	route: async (page) => { await page.setViewportSize({ width: 1280, height: 800 }); } });
const page = s.page;

const make = async (name) => {
	await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
	await page.waitForTimeout(900);
	await page.fill('.dlg-input', name).catch(() => {});
	await page.click('.dlg-ok', { force: true }).catch(() => {});
	await page.waitForTimeout(2500);
	return page.evaluate(async (name) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === name);
		return d ? d.id : '';
	}, name);
};
// Raw bytes in and out, through the store's byte doors, so a non-UTF-8 file can be planted and compared exactly.
const plantBytes = (id, bytes) => page.evaluate(async ({ path, bytes }) => {
	const m = await import('/pkg/oxedyne_daimond.js'); await m.store_write_bytes(path, new Uint8Array(bytes));
}, { path: 'diamonds/' + id + '/crystal.json', bytes });
const bytesOf = (id) => page.evaluate(async (path) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return Array.from(await m.store_read_bytes(path, 0, 1 << 20)); } catch (e) { return 'ERR ' + e; }
}, 'diamonds/' + id + '/crystal.json');
const saveCrystal = (id, json) => page.evaluate(async ({ id, json }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_crystal_data(id, json);
}, { id, json });
const utf8 = (t) => Array.from(new TextEncoder().encode(t));
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

// The face, opened fresh: what it says, what the bar offers, whether a raw editor is open.
const face = async () => {
	await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await page.waitForTimeout(600);
	await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	await page.waitForTimeout(1800);
	return page.evaluate(() => ({
		broken: (document.querySelector('.crystal-broken') || {}).textContent || '',
		acts: [...document.querySelectorAll('.crystal-bar .crystal-act')].filter(b => b.getClientRects().length).map(b => b.textContent.trim()),
		memRaw: [...document.querySelectorAll('.mem-raw')].filter(b => b.getClientRects().length).length,
		empty: !!document.querySelector('.crystal-empty:not(.crystal-broken)'),
	}));
};
// Edit -> Save where an Edit is offered at all, so a red run shows the rewrite and not only the button.
const editSave = async () => {
	const i = await page.evaluate(() => [...document.querySelectorAll('.crystal-bar .crystal-act')]
		.findIndex(b => /Edit/.test(b.textContent) && b.getClientRects().length));
	if (i < 0) return false;
	await page.evaluate((i) => document.querySelectorAll('.crystal-bar .crystal-act')[i].click(), i);
	await page.waitForTimeout(800);
	await page.evaluate(() => { const b = document.querySelector('.crystal-bar .crystal-act.primary'); if (b) b.click(); });
	await page.waitForTimeout(2000);
	return true;
};

const GOOD = JSON.stringify({ title: 'Kept', summary: 'Kept words.', sections: [{ heading: 'H', body: 'B' }] }, null, 2);
const id = await make('QaUnread');
check('a Diamond was made', !!id, id);

// ── control: valid JSON draws and edits ──────────────────────────────────────────────────────────────────────────
await saveCrystal(id, GOOD);
let f = await face();
check('valid JSON: no broken note', !f.broken, f.broken);
check('valid JSON: Edit is offered', f.acts.some(a => /Edit/.test(a)), JSON.stringify(f.acts));

// ── the arms: none of these is a crystal, and none may be offered for editing or rewritten ───────────────────────
const arms = [
	['binary text', utf8('\u0000\u0001PK\u0003\u0004binary not json at all')],
	['ciphertext blob', utf8('AGE-ENCRYPTED-FILE v1\n' + 'Zm9vYmFy'.repeat(30))],
	['non-UTF-8 bytes', [0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0x7b, 0x22, 0xc3, 0x28]],
	['zero bytes beside a version', []],
];
for (const [k, bytes] of arms) {
	await saveCrystal(id, GOOD);		// a version that holds a crystal, which the zero-byte arm needs
	await plantBytes(id, bytes);
	check(`${k}: planted exactly`, same(await bytesOf(id), bytes));
	f = await face();
	console.log(`       ${k}: ${JSON.stringify(f)}`);
	check(`${k}: the face says it could not be read`, /could not be read/i.test(f.broken), f.broken.slice(0, 120));
	check(`${k}: no visible Edit in the crystal bar`, !f.acts.some(a => /Edit/.test(a)), JSON.stringify(f.acts));
	check(`${k}: no raw editor over it`, f.memRaw === 0, String(f.memRaw));
	await editSave();
	const after = await bytesOf(id);
	check(`${k}: bytes on disk unchanged`, same(after, bytes), Array.isArray(after) ? `${after.length} bytes` : after);
}

// ── the unreadable note at phone width: it wraps inside the face, and the page does not scroll sideways ────────────
await plantBytes(id, utf8('AGE-ENCRYPTED-FILE v1\n' + 'Zm9vYmFy'.repeat(400)));
await page.setViewportSize({ width: 390, height: 844 });
f = await face();
const fit = await page.evaluate(() => {
	const n = document.querySelector('.crystal-broken');
	if (!n) return null;
	const r = n.getBoundingClientRect();
	return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		right: Math.round(r.right), vw: document.documentElement.clientWidth, clipped: n.scrollWidth > n.clientWidth };
});
check('390px: the unreadable note is drawn', !!fit && /could not be read/i.test(f.broken), f.broken.slice(0, 60));
check('390px: no sideways page scroll, the note inside the viewport, nothing clipped',
	!!fit && fit.over <= 0 && fit.right <= fit.vw && !fit.clipped, JSON.stringify(fit));
await page.setViewportSize({ width: 1280, height: 800 });

// ── BOM-prefixed JSON stays what it was: named broken, to be mended in its raw text, never drawn or rewritten ─────
const BOM = '﻿{"title":"With a byte order mark","summary":"s"}';
await plantBytes(id, utf8(BOM));
f = await face();
check('BOM: the face names it', !!f.broken, f.broken.slice(0, 120));
check('BOM: no visible Edit in the crystal bar', !f.acts.some(a => /Edit/.test(a)), JSON.stringify(f.acts));
check('BOM: bytes on disk unchanged', same(await bytesOf(id), utf8(BOM)));

// ── control: a fresh Diamond's empty crystal (and its empty version 0) is still an empty, editable one ──────────
// Made last, because making a Diamond opens it.
const fresh = await make('QaUnreadFresh');
check('a second Diamond was made', !!fresh, fresh);
f = await face();
check('fresh Diamond: drawn empty, not unreadable', !f.broken && f.empty, f.broken);
check('fresh Diamond: Edit is offered', f.acts.some(a => /Edit/.test(a)), JSON.stringify(f.acts));

console.log(`${ok} ok, ${bad} failed`);
await s.browser.close().catch(() => {});
process.exit(bad ? 1 : 0);
