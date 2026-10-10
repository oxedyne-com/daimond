// gateway: none
// verify_crystalmend -- a crystal.json that starts with `{` and will not parse is DRAWN as its raw text, open to be mended
// on the face: the fault's line and column named in plain words, the caret at the fault, and Save through the one write
// door. A Save that still does not parse is refused with the new position and writes nothing; one that parses draws.
//
// WHY THIS EXISTS. D-20261008-08, the Ontheism Diamond (notes/daimond_r543/ontheism_infographic_diag.md, cause 3.2): one
// pair of unescaped quotes left crystal.json unparseable from v48, and the face said "Mend the text below." over no text
// at all -- the raw editor sat inside the closed Memory panel above it -- so the owner could neither see the fault nor
// mend it in place.
//
// Arms: the one-line fault from the diagnosis, a fault on line 3 of a pretty file, a still-broken Save, a mending Save, a
// CRLF file (clean before typing, caret in the drawn text), and the mend box at phone width.
//
//   node dev/verify_crystalmend.mjs
import { open } from './harness.mjs';

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};
const s = await open({ name: 'verify_crystalmend', signIn: true, connect: true, defaults: false,
	route: async (page) => { await page.setViewportSize({ width: 1280, height: 800 }); } });
const page = s.page;

await page.evaluate(() => { const b = document.getElementById('new-diamond-btn'); if (b) b.click(); });
await page.waitForTimeout(900);
await page.fill('.dlg-input', 'QaMend').catch(() => {});
await page.click('.dlg-ok', { force: true }).catch(() => {});
await page.waitForTimeout(2500);
const id = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'QaMend');
	return d ? d.id : '';
});
check('a Diamond was made', !!id, id);
const PATH = 'diamonds/' + id + '/crystal.json';
// Planted under the engine's K0 gate, which refuses an invalid write: the broken file is what a pre-K0 turn left.
const plant = (text) => page.evaluate(async ({ path, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js'); await m.write_file(path, text);
}, { path: PATH, text });
const stored = () => page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await app.read_crystal_data(id);
}, id);

// The face, opened fresh: the note, every VISIBLE textarea in the crystal body with its caret, and the visible text.
const face = async () => {
	await page.evaluate(() => { const c = document.getElementById('dview-chat'); if (c) c.click(); });
	await page.waitForTimeout(600);
	await page.evaluate(() => { const c = document.getElementById('dview-crystal'); if (c) c.click(); });
	await page.waitForTimeout(1800);
	return look();
};
const look = () => page.evaluate(() => {
	const body = document.getElementById('crystal-body');
	// Seen, not merely laid out: the inside of a closed <details> keeps its boxes (content-visibility: hidden).
	const vis = (e) => !!(e && e.getClientRects().length && (!e.checkVisibility || e.checkVisibility()));
	const tas = body ? [...body.querySelectorAll('textarea')].filter(vis) : [];
	return {
		broken: (document.querySelector('.crystal-broken') || {}).textContent || '',
		tas: tas.map(t => ({ v: t.value, at: t.selectionStart, end: t.selectionEnd, clean: t.value === t.defaultValue })),
		text: body ? body.innerText : '',
		drawn: !!document.querySelector('#crystal-frame-wrap, .crystal-fallback'),
	};
});
const mendBox = (f, raw) => f.tas.find(t => t.v === raw);
const saveMend = async (value) => {
	await page.evaluate((v) => {
		const ta = [...document.querySelectorAll('#crystal-body textarea')]
			.find(t => t.getClientRects().length && (!t.checkVisibility || t.checkVisibility()));
		if (!ta) return;
		ta.value = v; ta.dispatchEvent(new Event('input', { bubbles: true }));
		const box = ta.closest('.crystal-mend') || ta.parentNode;
		const b = box && box.querySelector('.crystal-act.primary');
		if (b) b.click();
	}, value);
	await page.waitForTimeout(2500);
};

// ── (1) the one-line fault from the diagnosis: the quotes around "b" are not escaped ───────────────────────────────
const ONE = '{"title":"T","summary":"a "b" c"}';
await plant(ONE);
check('planted exactly', (await stored()) === ONE);
let f = await face();
console.log('       face:', JSON.stringify({ broken: f.broken, tas: f.tas, text: f.text.slice(0, 300) }));
check('the face names the broken crystal', !!f.broken, f.broken.slice(0, 80));
let m = mendBox(f, ONE);
check('the raw text is drawn, verbatim, in a visible editable box', !!m, JSON.stringify(f.tas.map(t => t.v.slice(0, 40))));
check('the fault is named by line and column (line 1, column 28: the b)', /\b1\b[\s\S]*\b28\b/.test(f.broken + '\n' + f.text)
	&& /line|Zeile/i.test(f.text), f.text.slice(0, 200));
check('the caret sits at the fault (offset 27)', !!m && m.at === 27, m ? `${m.at}..${m.end}` : 'no box');

// ── (2) a fault on line 3 of a pretty file: the line and column move with it, and so does the caret ───────────────
const THREE = '{\n  "title": "Ontheism",\n  "summary": "it asks "could it" form",\n  "sections": []\n}';
const at3 = THREE.indexOf('could');
await plant(THREE);
f = await face();
m = mendBox(f, THREE);
check('line 3: the raw text is drawn', !!m, JSON.stringify(f.tas.map(t => t.v.slice(0, 40))));
check('line 3: named as line 3, column 24', /\b3\b[\s\S]*\b24\b/.test(f.text), f.text.slice(0, 200));
check('line 3: the caret at the fault', !!m && m.at === at3, m ? `${m.at} (want ${at3})` : 'no box');

// ── (3) a Save that still does not parse is refused with its position, and nothing is written ─────────────────────
const STILL = '{"title":"T","summary":"a \\"b\\" c" "x"}';
await saveMend(STILL);
f = await look();
check('still broken: the file on disk is unchanged', (await stored()) === THREE);
check('still broken: the new position is named (line 1, column 36)', /\b1\b[\s\S]*\b36\b/.test(f.text), f.text.slice(0, 200));
m = mendBox(f, STILL);
check('still broken: the typing is kept, caret at the new fault', !!m && m.at === 35, m ? String(m.at) : 'gone');

// ── (4) a Save that parses: written, and the crystal draws ────────────────────────────────────────────────────────────
const MENDED = '{"title":"T","summary":"a \\"b\\" c"}';
await saveMend(MENDED);
const after = await stored();
let parsed = null; try { parsed = JSON.parse(after); } catch (e) { parsed = null; }
check('mended: the stored crystal parses with the quotes kept', !!parsed && parsed.summary === 'a "b" c', String(after).slice(0, 80));
f = await face();
check('mended: no broken note', !f.broken, f.broken.slice(0, 80));
check('mended: the crystal draws', f.drawn);

// ── (6) CRLF line ends (r546 D-26 F2): the box draws them as LF, so it must not count as typed in before anyone types,
// and the caret is placed in what it drew, not at the raw file's offset (12, two CRs past the `"b"` at 10) ──────────
const CRLF = '{\r\n "a":1\r\n "b":2\r\n}';
await plant(CRLF);
f = await face();
m = mendBox(f, CRLF.replace(/\r\n/g, '\n'));
check('CRLF: the raw text is drawn', !!m, JSON.stringify(f.tas.map(t => t.v.slice(0, 40))));
check('CRLF: the box is not held before anyone types (value equals what was drawn)', !!m && m.clean, m ? String(m.clean) : 'no box');
check('CRLF: named as line 3, column 2', /\b3\b[\s\S]*\b2\b/.test(f.text), f.text.slice(0, 200));
check('CRLF: the caret at the "b" (offset 10 in the drawn text)', !!m && m.at === 10, m ? `${m.at}..${m.end}` : 'no box');

// ── (5) the mend box at phone width: inside the viewport, no sideways page scroll ────────────────────────────────────
await plant('{"title":"' + 'long words '.repeat(60) + '"x"}');
await page.setViewportSize({ width: 390, height: 844 });
f = await face();
const fit = await page.evaluate(() => {
	const ta = [...document.querySelectorAll('#crystal-body textarea')]
			.find(t => t.getClientRects().length && (!t.checkVisibility || t.checkVisibility()));
	if (!ta) return null;
	const r = ta.getBoundingClientRect();
	return { over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
		right: Math.round(r.right), vw: document.documentElement.clientWidth };
});
check('390px: the mend box is inside the viewport and the page does not scroll sideways',
	!!fit && fit.over <= 0 && fit.right <= fit.vw, JSON.stringify(fit));

console.log(`${ok} ok, ${bad} failed`);
await s.browser.close().catch(() => {});
process.exit(bad ? 1 : 0);
