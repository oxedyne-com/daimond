// gateway: none
// verify_wslines.mjs -- by-role and variable length for the Workspace panel's two new lines of 12 Oct:
// the Can change "Gone" row (WS-GONE) and the search walk-limit line (WS-SEARCH).
//
// dev/verify_consistency.mjs cannot reach either: its seed marks no folder, and its search never walks
// 500,000 entries. So they are measured here, at 1440x900 and 390x845, in en, de and ja:
//   G1  a gone row's name is drawn as a kept row's name (family, size, weight, line height), muted;
//       its take-away ◈ is the kept row's size, at the kept row's right edge;
//   G2  a gone folder named short, long and very long: name, "Gone" and ◈ never overlap, all stay
//       inside the row and the panel, "Gone" is never clipped, and the panel never scrolls sideways;
//   S1  the walk-limit line is drawn as the result-limit line ("Showing first N") it sits beside;
//   S2  with a short and a long count, it stays inside the panel, unclipped, in every locale.
//
// The served daimond.js has its two search limits lowered (SEARCH_MAX 3, SEARCH_WALK_MAX 60, or
// 1500 for the long count) so a small fixture reaches both lines through the real path.
// Run with the world up; no gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let bad = 0;
const check = (ok, what, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail !== undefined && detail !== '' ? '  -- ' + detail : ''}`);
	if (!ok) bad++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BOX = '#panel-work .files-filter-input';
const GONE = ['q', 'joinery-and-benchtop-quotes', 'joinery-and-benchtop-quotes-from-every-supplier-we-spoke-to-in-2026'];
const VPS = [[1440, 900], [390, 845]];
const LOCALES = ['en', 'de', 'ja'];

const src = fs.readFileSync(path.join(ROOT, 'www/js/daimond.js'), 'utf8');
const lowered = (walk) => {
	const out = src.replace(/var SEARCH_MAX\t\t= 100;/, 'var SEARCH_MAX\t\t= 3;')
		.replace(/var SEARCH_WALK_MAX\t= 500000;/, `var SEARCH_WALK_MAX\t= ${walk};`);
	if (out === src || !out.includes(`SEARCH_WALK_MAX\t= ${walk};`)) throw new Error('the search limits were not found to lower');
	return out;
};

// A rect pair overlaps when both spans cross by more than a pixel.
const GEO = () => {
	const P = document.getElementById('panel-work').getBoundingClientRect();
	const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
	const st = (e, ks) => { if (!e) return null; const c = getComputedStyle(e); const o = {}; ks.forEach((k) => { o[k] = c[k]; }); return o; };
	const rows = [...document.querySelectorAll('#panel-work .files-focus .r[data-kind="mark"]')].map((r) => ({
		path: r.dataset.path, gone: r.classList.contains('gone'), row: box(r),
		nm: box(r.querySelector('.nm')), place: box(r.querySelector('.place')), dm: box(r.querySelector('button.dm')),
		placeClip: r.querySelector('.place') ? r.querySelector('.place').scrollWidth > r.querySelector('.place').clientWidth + 1 : false,
		nmStyle: st(r.querySelector('.nm'), ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'color']),
	}));
	const w = document.getElementById('panel-work');
	return { panel: { l: P.left, r: P.right }, sideScroll: w.scrollWidth > w.clientWidth + 1, rows };
};
const LINES = () => {
	const P = document.getElementById('panel-work').getBoundingClientRect();
	const one = (sel) => {
		const e = document.querySelector('#panel-work ' + sel);
		if (!e) return null;
		const r = e.getBoundingClientRect(), c = getComputedStyle(e);
		return { text: e.textContent, l: r.left, r: r.right, h: r.height, clip: e.scrollWidth > e.clientWidth + 1,
			style: { fontFamily: c.fontFamily, fontSize: c.fontSize, color: c.color, textAlign: c.textAlign, paddingTop: c.paddingTop, paddingLeft: c.paddingLeft, lineHeight: c.lineHeight } };
	};
	return { panel: { l: P.left, r: P.right }, capped: one('.files-capped:not(.files-stopped)'), stopped: one('.files-stopped') };
};
const over = (a, b) => !!a && !!b && Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
const inside = (a, o) => !!a && a.l >= o.l - 1 && a.r <= o.r + 1;

async function session(walk, fn) {
	const body = lowered(walk);
	const S = await open({ name: 'wslines' + walk, route: async (page) => {
		await page.route(/\/js\/daimond\.js(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	} });
	try { await fn(S.page); } finally { await S.close().catch(() => {}); }
}

async function fixture(page, name) {
	await page.setViewportSize({ width: 1440, height: 900 });
	await wait(1500);
	await page.evaluate(() => { if (getComputedStyle(document.getElementById('settings-modal')).display !== 'none') window.DaimondAdmin.closeModal(); });
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await wait(1200);
	const fx = await page.evaluate(async ({ name, GONE }) => {
		let id = null;
		for (const d of JSON.parse(await DaimondCore.diamondApp().list_diamonds())) if (d.name === name) id = d.id;
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		for (const p of ['k', ...GONE]) {
			await app.run_tool('file_write', JSON.stringify({ path: p + '/a.md', content: '# a\n' }));
			await app.add_link(id, 'diamond:' + id, 'dir:[browser]' + p, 'holds', '', 'user');
			if (window.DaimondAttach && DaimondAttach.confirmHere) await DaimondAttach.confirmHere(id, 'dir:[browser]' + p);
		}
		for (let i = 0; i < 80; i++) await app.run_tool('file_write', JSON.stringify({ path: `pad/f_${String(i).padStart(2, '0')}.txt`, content: 'x' }));
		const removed = [];
		const hunt = async (h, depth) => {
			for await (const [n, e] of h.entries()) {
				if (e.kind !== 'directory') continue;
				if (GONE.includes(n)) { await h.removeEntry(n, { recursive: true }); removed.push(n); continue; }
				if (depth < 2) await hunt(e, depth + 1);
			}
		};
		await hunt(await navigator.storage.getDirectory(), 0);
		return { id, removed };
	}, { name, GONE });
	await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-links-changed')));
	await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-diamond-changed')));
	await page.evaluate(() => DaimondPanels.show('work'));
	await wait(600);
	return fx;
}

const settle = async (page, vp, loc) => {
	await page.setViewportSize({ width: vp[0], height: vp[1] });
	await page.evaluate(async (loc) => { await window.DaimondI18n.setLocale(loc); }, loc);
	await page.evaluate(() => DaimondPanels.show('work'));
	await wait(500);
};

try {
	// The Gone rows, and the search lines with a short count (60).
	await session(60, async (page) => {
		const fx = await fixture(page, 'Line lengths');
		check(!!fx.id && fx.removed.length === GONE.length, 'the fixture: one kept and three gone marked folders', JSON.stringify(fx));
		for (const vp of VPS) for (const loc of LOCALES) {
			const at = `${vp[0]}x${vp[1]} ${loc}`;
			await settle(page, vp, loc);
			await page.fill(BOX, '');
			await page.evaluate(() => { const r = document.querySelector('#panel-work [data-act="refresh"]'); if (r) r.click(); });
			await wait(1500);
			const g = await page.evaluate(GEO);
			const kept = g.rows.find((r) => r.path === 'k'), gone = g.rows.filter((r) => r.gone);
			check(!!kept && gone.length === GONE.length, `${at}: one kept row and three Gone rows drawn`, `${gone.length} gone`);
			if (!kept) continue;
			const K = kept.nmStyle;
			const same = gone.every((r) => ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight'].every((k) => r.nmStyle[k] === K[k]) && r.nmStyle.color !== K.color);
			check(same, `${at}: G1 a Gone row's name is a kept row's name, muted`, JSON.stringify(gone.map((r) => r.nmStyle).concat([K])));
			const dmOk = gone.every((r) => r.dm && kept.dm && Math.abs(r.dm.w - kept.dm.w) < 1 && Math.abs(r.dm.r - kept.dm.r) < 1);
			check(dmOk, `${at}: G1 its ◈ is the kept row's size, at the kept row's right edge`, JSON.stringify(gone.map((r) => r.dm).concat([kept.dm])));
			const lay = gone.map((r) => ({ path: r.path.slice(0, 12), h: Math.round(r.row.h),
				overlap: over(r.nm, r.place) || over(r.nm, r.dm) || over(r.place, r.dm),
				out: !inside(r.nm, r.row) || !inside(r.place, r.row) || !inside(r.dm, r.row) || !inside(r.row, g.panel), clip: r.placeClip }));
			check(lay.every((x) => !x.overlap && !x.out && !x.clip) && !g.sideScroll,
				`${at}: G2 short, long and very long Gone names: no overlap, nothing outside, "Gone" unclipped`,
				JSON.stringify({ keptH: Math.round(kept.row.h), lay, sideScroll: g.sideScroll }));
			check(lay.every((x) => Math.abs(x.h - Math.round(kept.row.h)) <= 1), `${at}: G2 a long Gone name keeps the row one line high, as a long kept name does`,
				JSON.stringify({ keptH: Math.round(kept.row.h), heights: lay.map((x) => x.h) }));
			// The search lines.
			await page.fill(BOX, 'f_');
			await wait(2500);
			const capped = (await page.evaluate(LINES)).capped;
			await page.fill(BOX, 'zzqq');
			await wait(2500);
			const L = await page.evaluate(LINES);
			check(!!capped && !!L.stopped, `${at}: both lines drawn`, JSON.stringify({ capped: capped && capped.text, stopped: L.stopped && L.stopped.text }));
			if (!capped || !L.stopped) continue;
			check(Object.keys(capped.style).every((k) => capped.style[k] === L.stopped.style[k]), `${at}: S1 the walk-limit line is drawn as the result-limit line`,
				JSON.stringify({ capped: capped.style, stopped: L.stopped.style }));
			check(inside(L.stopped, L.panel) && !L.stopped.clip, `${at}: S2 short count: inside the panel, unclipped`, JSON.stringify({ text: L.stopped.text, h: L.stopped.h }));
		}
	});
	// The search line with a long count (1,500 entries walked).
	await session(1500, async (page) => {
		await fixture(page, 'Long count');
		await page.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
			for (let i = 0; i < 1500; i++) await app.run_tool('file_write', JSON.stringify({ path: `bulk/b_${String(i).padStart(4, '0')}.txt`, content: 'x' }));
		});
		for (const vp of VPS) for (const loc of LOCALES) {
			const at = `${vp[0]}x${vp[1]} ${loc}`;
			await settle(page, vp, loc);
			await page.fill(BOX, '');
			await wait(300);
			await page.fill(BOX, 'zzqq');
			let L = null;
			for (let i = 0; i < 30 && !(L && L.stopped); i++) { await wait(1000); L = await page.evaluate(LINES); }
			check(!!L.stopped && /1[,.\s ]?500/.test(L.stopped.text) && inside(L.stopped, L.panel) && !L.stopped.clip,
				`${at}: S2 long count: inside the panel, unclipped`, JSON.stringify(L.stopped && { text: L.stopped.text, h: L.stopped.h }));
		}
	});
} catch (e) {
	console.log('FAIL  the gate itself stopped: ' + (e && e.stack || e));
	bad++;
}
console.log(`\n${bad ? 'FAILED' : 'PASSED'}: ${bad} failing check(s)`);
process.exit(bad ? 1 : 0);
