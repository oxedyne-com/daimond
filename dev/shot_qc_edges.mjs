// shot_qc_edges.mjs — where the ink starts, surface by surface.
//
// The complaint this pass answers is about edges: chips and buttons that do not
// line up with each other or with the words beside them. A bounding box is the
// wrong instrument for that — a full-width element with 10px of padding reports
// `left = 0` and looks perfectly aligned to a measurement while its text sits
// 10px in from its neighbour's. So every left edge here is read off a `Range`
// over the element's own text, which is where the ink actually starts.
//
//   node dev/shot_qc_edges.mjs
import { open, errors } from './harness.mjs';

const s = await open({ name: 'qcedges', connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);
let bad = 0;
const claim = (ok, what, detail) => {
	if (!ok) bad++;
	console.log(`${ok ? 'ok  ' : 'LOOK'}  ${what}\n        ${detail}`);
};

// The ink's left edge, for a set of selectors, relative to a container.
const INK = function ({ within, sels }) {
	const host = document.querySelector(within);
	if (!host) return null;
	const base = host.getBoundingClientRect();
	const out = [];
	for (const sel of sels) {
		document.querySelectorAll(`${within} ${sel}`).forEach((el) => {
			if (!el.getClientRects().length) return;
			const rng = document.createRange();
			rng.selectNodeContents(el);
			const r = rng.getBoundingClientRect();
			if (r.width < 1) return;
			out.push({
				sel, left: Math.round((r.left - base.left) * 10) / 10,
				top: Math.round((r.top - base.top) * 10) / 10,
				text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
			});
		});
	}
	return out;
};

await page.waitForFunction(() => !!(window.DaimondPanels && DaimondPanels.panels), null, { timeout: 20000 });
await pause(800);
const quieten = () => page.evaluate(() => {
	document.querySelectorAll('.pop:not([hidden])').forEach((el) => { el.hidden = true; });
	const c = document.getElementById('admin-close');
	if (c && c.getClientRects().length) c.click();
});
await quieten();

// A Diamond and a chat, so the rail and the chat head are not empty.
await page.evaluate(() => DaimondPanels.show('rail'));
await pause(300);
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 8000 });
await page.fill('.dlg-input', 'Ship a CSV parser');
await page.click('.dlg-ok', { force: true });
await pause(900);
await quieten();

// ── The permission ladder ──────────────────────────────────────────────
await page.evaluate(() => DaimondPanels.show('ai'));
await pause(400);
if (await page.$('#hand-mode-chip')) {
	await page.click('#hand-mode-chip', { force: true });
	await pause(400);
	const ladder = await page.evaluate(() => {
		const pop = document.getElementById('hand-mode-pop');
		const base = pop.getBoundingClientRect();
		return [...pop.querySelectorAll('.mode-row')].map((row) => {
			const inp = row.querySelector('input');
			const nm = row.querySelector('.mode-row-name');
			const bl = row.querySelector('.mode-row-blurb');
			const ink = (el) => { if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); return Math.round((r.getBoundingClientRect().left - base.left) * 10) / 10; };
			return {
				on: row.classList.contains('on'),
				radio: inp ? Math.round((inp.getBoundingClientRect().left - base.left) * 10) / 10 : null,
				name: ink(nm), blurb: ink(bl), text: (nm && nm.textContent) || '',
			};
		});
	});
	const rs = ladder.map((r) => r.radio), ns = ladder.map((r) => r.name);
	claim(Math.max(...rs) - Math.min(...rs) <= 0.5 && Math.max(...ns) - Math.min(...ns) <= 0.5,
		'the permission ladder does not shift the selected rung',
		ladder.map((r) => `${r.on ? '*' : ' '}${r.text}: radio ${r.radio}, name ${r.name}, blurb ${r.blurb}`).join('; '));
	const blurbOff = ladder.filter((r) => r.blurb !== null && Math.abs(r.blurb - r.name) > 0.5);
	claim(blurbOff.length === 0, 'each rung\'s blurb starts under its own name',
		ladder.map((r) => `${r.text}: name ${r.name} vs blurb ${r.blurb}`).join('; '));
	await page.keyboard.press('Escape');
	await pause(200);
} else {
	console.log('skip  the permission ladder — no #hand-mode-chip');
}

// ── The Admin drawer's views ───────────────────────────────────────────
//
// Six views behind one drawer, each written separately. Switching between them
// should not move the left margin under the reader.
const views = [];
for (const [name, opener] of [['home', '#settings-btn'], ['models', '#astat-model'],
	['account', '#astat-account'], ['release', '#astat-release']]) {
	await quieten();
	await page.evaluate(() => DaimondPanels.show('rail'));
	const b = await page.$(opener);
	if (!b || !(await b.isVisible())) { console.log(`skip  admin ${name} — no ${opener}`); continue; }
	await b.click({ force: true });
	await pause(500);
	const ink = await page.evaluate(INK, { within: '#admin-scroll',
		sels: ['.cfg-lead', '.settings-section > h3', '.admin-sec', '.admin-item', '.admin-note',
			'.cfg-fieldlabel', '.cfg-fieldnote', 'p', 'label'] });
	if (!ink || !ink.length) { console.log(`skip  admin ${name} — nothing measurable`); continue; }
	// The first inset a reader meets in the view.
	const first = ink.slice().sort((a, b2) => a.top - b2.top || a.left - b2.left)[0];
	views.push({ name, left: first.left, text: first.text, edges: [...new Set(ink.map((x) => x.left))].sort((a, b2) => a - b2) });
}
if (views.length > 1) {
	const ls = views.map((v) => v.left);
	claim(Math.max(...ls) - Math.min(...ls) <= 0.5,
		'every Admin view starts its text on the same left edge',
		views.map((v) => `${v.name}=${v.left} ("${v.text}")`).join('  '));
	for (const v of views) {
		claim(v.edges.filter((x) => x < 40).length <= 2,
			`the Admin ${v.name} view keeps to one or two left edges`,
			`edges at ${v.edges.join(', ')}px`);
	}
}

// ── The tag editor ─────────────────────────────────────────────────────
await quieten();
await page.evaluate(() => DaimondPanels.show('rail'));
await page.$$eval('.diamond-box', (els) => els[0] && els[0].click());
await pause(700);
await page.evaluate(() => {
	const b = [...document.querySelectorAll('.crystal-act')].find((x) => /tag/i.test(x.textContent || ''));
	if (b) b.click();
});
const editor = await page.waitForSelector('.tag-editor', { timeout: 6000 }).catch(() => null);
if (editor) {
	const tag = await page.evaluate(() => {
		const ed = document.querySelector('.tag-editor');
		const r = ed.getBoundingClientRect();
		const add = ed.querySelector('.tag-add');
		const rows = [...ed.querySelectorAll('.tag-row')];
		const w = (el) => el ? Math.round(el.getBoundingClientRect().width) : null;
		return {
			editor: Math.round(r.width),
			addRow: add ? Math.round(add.getBoundingClientRect().width) : null,
			addContent: add ? Math.round([...add.children].reduce((acc, c) => Math.max(acc, c.getBoundingClientRect().right), 0) - add.getBoundingClientRect().left) : null,
			input: w(ed.querySelector('.tag-input')),
			rowWidths: rows.map(w),
		};
	});
	claim(tag.addContent !== null && tag.editor - tag.addContent <= 8,
		'the "Add a tag" row uses the width the chip rows above it use',
		`editor ${tag.editor}px wide, the add row's controls end ${tag.editor - tag.addContent}px short of it `
		+ `(input ${tag.input}px; .tag-input has max-width: 200px)`);
}

// ── The chat head ──────────────────────────────────────────────────────
await quieten();
await page.evaluate(() => DaimondPanels.show('ai'));
await pause(400);
const chead = await page.evaluate(() => {
	const h = document.querySelector('#panel-ai .chead');
	if (!h) return null;
	const kids = [...h.querySelectorAll('button, select, .cmeter')].filter((k) => k.getClientRects().length);
	const rs = kids.map((k) => k.getBoundingClientRect());
	const mids = rs.map((r) => Math.round((r.top + r.bottom) / 2 * 10) / 10);
	return {
		n: kids.length,
		heights: rs.map((r) => Math.round(r.height * 10) / 10),
		mids, midSpread: Math.round((Math.max(...mids) - Math.min(...mids)) * 10) / 10,
		labels: kids.map((k) => (k.textContent || k.id || '').trim().slice(0, 14)),
		headHeight: Math.round(h.getBoundingClientRect().height * 10) / 10,
	};
});
if (chead) {
	claim(chead.midSpread <= 0.5, 'every control in the chat head sits on one centre line',
		chead.labels.map((l, i) => `${l}@${chead.mids[i]}(${chead.heights[i]}px)`).join('  '));
}

// ── The top bar ────────────────────────────────────────────────────────
const topbar = await page.evaluate(() => {
	const bar = document.querySelector('.topbar');
	if (!bar) return null;
	const kids = [...bar.querySelectorAll('button, .ptag')].filter((k) => k.getClientRects().length);
	const rs = kids.map((k) => k.getBoundingClientRect());
	const mids = rs.map((r) => Math.round((r.top + r.bottom) / 2 * 10) / 10);
	const icons = kids.filter((k) => k.classList.contains('icon-btn'))
		.map((k) => { const r = k.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; });
	return { mids, midSpread: Math.round((Math.max(...mids) - Math.min(...mids)) * 10) / 10,
		icons, n: kids.length,
		labels: kids.map((k) => (k.textContent || k.id || '').trim().slice(0, 12)) };
});
if (topbar) {
	claim(topbar.midSpread <= 0.5, 'every control in the top bar sits on one centre line',
		topbar.labels.map((l, i) => `${l}@${topbar.mids[i]}`).join('  '));
	claim(new Set(topbar.icons).size <= 1, 'every top-bar icon button is the same size',
		topbar.icons.join(' '));
}

console.log(`\n${bad} claim(s) want a look.`);
const errs = errors(s).filter((e) => !/502|Bad Gateway/.test(e));
if (errs.length) console.log(`${errs.length} console error(s): ` + errs.slice(0, 5).join(' | '));
await s.close();
