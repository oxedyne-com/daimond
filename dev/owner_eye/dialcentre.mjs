// owner_eye/dialcentre.mjs -- each credit row's dial on the row's centre line at every rail width
// (DIALCENTRE, D-20261024-17: "the lack of centering of the dials is obvious on argonaut", his
// argonaut rail ~445 px against gilgamesh's ~360 px). Loaded by dev/verify_ownereye.mjs.
//
//   D1 rail.pools.dial-centred       1440x900 with the rail pulled to 300, 360, 445 and 520 px, and
//                                    the phone's drawer: each pool row's dial centre within 2 px of
//                                    the row's centre; the range ("idle") beside the dial, right of
//                                    it on the dial's line, before Today; battery, name and balance
//                                    left of the dial, Today right of the range, each whole in the
//                                    row; Today never cut. Then stressed (a long name, balance,
//                                    range and Today): the dial unmoved within 2 px, the long text
//                                    cut by its own ellipsis, not pushed over the dial.
//
// Each cell's offsets are printed as notes (`dx` per pool); --shots adds a crop of the credit rows
// at each width.

import fs from 'node:fs';
import path from 'node:path';

const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SHOTS = arg('--shots') || process.env.OE_SHOTS || null;
const WIDTHS = [300, 360, 445, 520];
const TOL = 2;

// One measurement of every pool row; `tag` names the width and the stress in each finding.
const measure = (p, tag, stressed) => p.evaluate(({ tag, stressed, TOL }) => {
	const f = [], dx = [], R = (e) => e.getBoundingClientRect();
	const rows = [...document.querySelectorAll('#spend-row .evp')];
	if (!rows.length) return { f: [`${tag}: no pool rows`], dx };
	const cut = (e) => e.scrollWidth > e.clientWidth + 1;
	for (const r of rows) {
		const k = `${tag} ${r.dataset.pool}`, rb = R(r);
		const el = { battery: r.querySelector('svg.evb'), name: r.querySelector('.evnm'), balance: r.querySelector('.evbal'),
			dial: r.querySelector('svg.evd'), range: r.querySelector('.evmi'), today: r.querySelector('.evday'),
			todayLabel: r.querySelector('.evdl'), todayValue: r.querySelector('.evdv') };
		let whole = true;
		for (const [n, e] of Object.entries(el)) {
			if (!e) { f.push(`${k}: ${n} absent`); whole = false; continue; }
			const q = R(e);
			if (!(q.width > 0 && q.height > 0)) { f.push(`${k}: ${n} not drawn`); whole = false; }
			else if (q.left < rb.left - 0.5 || q.right > rb.right + 0.5) { f.push(`${k}: ${n} ${q.left.toFixed(1)}-${q.right.toFixed(1)} outside its row ${rb.left.toFixed(1)}-${rb.right.toFixed(1)}`); whole = false; }
		}
		if (!whole) continue;
		const d = R(el.dial), mi = R(el.range), td = R(el.today);
		const off = (d.left + d.right) / 2 - (rb.left + rb.right) / 2;
		dx.push(+off.toFixed(2));
		if (Math.abs(off) > TOL) f.push(`${k}: dial centre ${((d.left + d.right) / 2).toFixed(1)} is ${off.toFixed(1)} px off the row's centre ${((rb.left + rb.right) / 2).toFixed(1)} (row ${rb.width.toFixed(0)} px)`);
		// The range beside the dial: right of it, on its line, before Today.
		if (mi.left < d.right - 0.5) f.push(`${k}: range left ${mi.left.toFixed(1)} over the dial's right ${d.right.toFixed(1)}`);
		if (mi.left - d.right > 12) f.push(`${k}: range ${(mi.left - d.right).toFixed(1)} px from the dial, not beside it`);
		if (mi.bottom < d.top || mi.top > d.bottom) f.push(`${k}: range ${mi.top.toFixed(1)}-${mi.bottom.toFixed(1)} off the dial's line ${d.top.toFixed(1)}-${d.bottom.toFixed(1)}`);
		if (mi.right > td.left + 0.5) f.push(`${k}: range right ${mi.right.toFixed(1)} over Today's left ${td.left.toFixed(1)}`);
		// The left column keeps clear of the dial; Today is never cut.
		for (const n of ['battery', 'name', 'balance']) { const q = R(el[n]); if (q.right > d.left + 0.5) f.push(`${k}: ${n} right ${q.right.toFixed(1)} over the dial's left ${d.left.toFixed(1)}`); }
		for (const n of ['todayLabel', 'todayValue']) if (cut(el[n])) f.push(`${k}: ${n} "${el[n].textContent}" cut (${el[n].scrollWidth} > ${el[n].clientWidth} px)`);
		// Unstressed, the name and balance are whole; stressed, a cut one shows its ellipsis.
		for (const n of ['name', 'balance']) {
			const e = el[n];
			if (!cut(e)) continue;
			if (!stressed) f.push(`NOTE: ${k}: ${n} "${e.textContent}" cut (${e.scrollWidth} > ${e.clientWidth} px)`);
			else if (getComputedStyle(e).textOverflow !== 'ellipsis') f.push(`${k}: ${n} cut with no ellipsis`);
		}
	}
	return { f, dx };
}, { tag, stressed, TOL });

// Long text in every slot of every row; the live rows are put back after.
const stress = (p, on) => p.evaluate((on) => {
	const box = document.querySelector('#spend-row .evpools');
	if (!box) return;
	if (!on) { if (window.__dcSaved !== undefined) box.innerHTML = window.__dcSaved; delete window.__dcSaved; return; }
	window.__dcSaved = box.innerHTML;
	for (const r of box.querySelectorAll('.evp')) {
		const s = (q, t) => { const e = r.querySelector(q); if (e) e.textContent = t; };
		s('.evnm', 'Daimond credits for the whole family and the office');
		s('.evbal', 'A$1,234,567.89');
		s('.evmi', '12 h 59 min left');
		s('.evdv', 'US$12,345.67');
	}
}, on);

const frame = (p) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

const crop = async (p, c, n) => {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	const e = await p.$('#spend-row');
	if (e) await e.screenshot({ path: path.join(SHOTS, `dc_${c.state}_${c.theme}_${n}.png`) });
};

export default [
	{ id: 'D1', name: 'rail.pools.dial-centred', cite: { id: 'D-20261024-17', quote: 'the lack of centering of the dials is obvious on argonaut' },
	  also: { id: 'D-20261020-14', quote: 'One row per pool: battery, name and balance (user currency, tag glyph) left; dial (15-min rate) and one-line time left right' },
	  vp: ['1440x900', '393x793'], states: ['full', 'real'], check: async (p, c) => {
		const f = [];
		const widths = c.phone ? [null] : WIDTHS;
		const was = await p.evaluate(() => { const r = document.getElementById('panel-rail'); return r ? r.style.width : null; });
		for (const w of widths) {
			if (w) { await p.evaluate((w) => { document.getElementById('panel-rail').style.width = w + 'px'; }, w); await frame(p); }
			const tag = w ? `rail ${w}` : 'phone';
			for (const stressed of [false, true]) {
				if (stressed) { await stress(p, true); await frame(p); }
				const m = await measure(p, tag + (stressed ? ' stressed' : ''), stressed);
				f.push(...m.f, `NOTE: ${tag}${stressed ? ' stressed' : ''} dx ${m.dx.join(' ')}`);
				if (!stressed) await crop(p, c, c.phone ? 'phone' : `w${w}`);
				if (stressed) { await stress(p, false); await frame(p); }
			}
		}
		if (!c.phone) await p.evaluate((w) => { document.getElementById('panel-rail').style.width = w; }, was || '');
		return f;
	} },
];
