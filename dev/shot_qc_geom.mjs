// shot_qc_geom.mjs — the questions a screenshot raises and only a measurement
// can answer.
//
// Reading images finds the gross faults. It cannot tell 10px of inset from
// 14px, and the difference between those two is the whole of "the left edges
// wander" — the complaint that produced this pass. So each check below is a
// specific claim with a number attached, printed as pass/fail against a stated
// rule rather than as a rectangle for someone to compare by eye.
//
//   node dev/shot_qc_geom.mjs
import { open, errors } from './harness.mjs';

const s = await open({ name: 'qcgeom', connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);
const rows = [];
const r2 = (n) => Math.round(n * 100) / 100;

/// One claim, its measured value, and whether it holds.
function claim(what, ok, detail) {
	rows.push({ ok, what, detail });
	console.log(`${ok ? 'ok  ' : 'LOOK'}  ${what}\n        ${detail}`);
}

await page.waitForFunction(() => !!(window.DaimondPanels && DaimondPanels.panels), null, { timeout: 20000 });
await pause(800);
await page.evaluate(() => { const c = document.getElementById('admin-close'); if (c && c.getClientRects().length) c.click(); });
await page.evaluate(() => DaimondPanels.show('rail'));
await pause(400);

// ── The rail's two lists ───────────────────────────────────────────────
//
// A Diamond tile and a chat tile are the same component in two lists. If the
// lists inset them differently the rail has a visible step down its middle.
const lists = await page.evaluate(() => {
	const g = (id) => {
		const el = document.getElementById(id);
		if (!el) return null;
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			padLeft: parseFloat(cs.paddingLeft), padRight: parseFloat(cs.paddingRight),
			padTop: parseFloat(cs.paddingTop), padBottom: parseFloat(cs.paddingBottom),
			contentLeft: r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
			contentRight: r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
		};
	};
	return { diamond: g('diamond-list'), session: g('session-list') };
});
claim('the two rail lists inset their tiles by the same amount',
	lists.diamond && lists.session
		&& lists.diamond.padLeft === lists.session.padLeft
		&& lists.diamond.padRight === lists.session.padRight,
	`#diamond-list padding ${lists.diamond?.padLeft}/${lists.diamond?.padRight}px, `
	+ `#session-list padding ${lists.session?.padLeft}/${lists.session?.padRight}px; `
	+ `content starts at x=${r2(lists.diamond?.contentLeft)} vs x=${r2(lists.session?.contentLeft)}`);

// ── The rail's furniture, left edge by left edge ────────────────────────
//
// Everything stacked in one column should start on one line. Each of these is
// a different component written at a different time, which is how a column
// acquires four different left edges.
const railLefts = await page.evaluate(() => {
	const pick = [
		['pptw label',    '.pptw-head-label'],
		['DIAMONDS head', '.railhead span'],
		['tag pool',      '#diamond-filter'],
		['diamond list',  '#diamond-list'],
		['session list',  '#session-list'],
		['status rows',   '.astat-row'],
		['admin note',    '.admin-note'],
	];
	const rail = document.getElementById('panel-rail').getBoundingClientRect();
	const out = [];
	for (const [name, sel] of pick) {
		const el = document.querySelector(sel);
		if (!el || !el.getClientRects().length) continue;
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		out.push({ name, left: Math.round((r.left + parseFloat(cs.paddingLeft) - rail.left) * 100) / 100 });
	}
	return out;
});
{
	const xs = railLefts.map((x) => x.left);
	const spread = Math.max(...xs) - Math.min(...xs);
	claim('the rail column starts its rows on one left edge', spread <= 1,
		railLefts.map((x) => `${x.name}=${x.left}`).join('  ') + `  → spread ${r2(spread)}px`);
}

// ── The two rail heads' buttons end on one right edge ──────────────────
const heads = await page.evaluate(() => {
	const rail = document.getElementById('panel-rail').getBoundingClientRect();
	// Scoped to the rail: `.railhead` is also the class the four dock panels use
	// for their own headers, and measuring those against the RAIL's rectangle
	// reported a button "-1152px from the edge" — a number with no meaning.
	return [...document.querySelectorAll('#panel-rail .railhead')].map((h) => {
		const bs = [...h.querySelectorAll('button')].filter((b) => b.getClientRects().length);
		return {
			label: (h.querySelector('span') || {}).textContent,
			lastRight: bs.length ? Math.round((rail.right - bs[bs.length - 1].getBoundingClientRect().right) * 100) / 100 : null,
			sizes: bs.map((b) => { const r = b.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }),
		};
	});
});
{
	const insets = heads.filter((h) => h.lastRight !== null).map((h) => h.lastRight);
	claim('both rail heads end their button rows at the same inset',
		insets.length > 1 && Math.max(...insets) - Math.min(...insets) <= 0.5,
		heads.map((h) => `${h.label}: last button ${h.lastRight}px from the rail edge, sizes ${h.sizes.join(',')}`).join('; '));
	const allSizes = heads.flatMap((h) => h.sizes);
	claim('every rail-head button is the same size', new Set(allSizes).size === 1,
		allSizes.join(' '));
}

// ── The appearance menu's segmented rows ───────────────────────────────
await page.click('#settings-menu-btn', { force: true });
await pause(400);
const segs = await page.evaluate(() => [...document.querySelectorAll('#settings-menu .seg')].map((row) => {
	const bs = [...row.children].filter((b) => b.getClientRects().length);
	const ws = bs.map((b) => Math.round(b.getBoundingClientRect().width * 100) / 100);
	const tops = new Set(bs.map((b) => Math.round(b.getBoundingClientRect().top)));
	return {
		labels: bs.map((b) => b.textContent.trim().replace(/\s+/g, '')),
		widths: ws, lines: tops.size,
		spread: Math.round((Math.max(...ws) - Math.min(...ws)) * 100) / 100,
		flex: getComputedStyle(bs[0]).flex,
	};
}));
for (const seg of segs) {
	claim(`segmented row [${seg.labels.join('|')}] is evenly divided`,
		seg.lines > 1 || seg.spread <= 1,
		`widths ${seg.widths.join(', ')}px on ${seg.lines} line(s), spread ${seg.spread}px, flex ${seg.flex}`);
}

// The percentage readout at the end of the text-size row: right-aligned inside
// a 38px min-width box, which is what decides whether "100%" touches the edge.
const pct = await page.evaluate(() => {
	const el = document.querySelector('#settings-menu .size-row .pct');
	if (!el) return null;
	const pop = document.getElementById('settings-menu').getBoundingClientRect();
	const r = el.getBoundingClientRect();
	const up = el.previousElementSibling.getBoundingClientRect();
	return {
		text: el.textContent, right: Math.round((pop.right - r.right) * 100) / 100,
		gapToButton: Math.round((r.left - up.right) * 100) / 100,
		width: Math.round(r.width * 100) / 100,
	};
});
if (pct) {
	claim('the text-size percentage keeps the popover\'s own padding',
		pct.right >= 5,
		`"${pct.text}" is ${pct.right}px from the popover edge (rows above use 6px), `
		+ `${pct.gapToButton}px from the A button, ${pct.width}px wide`);
}
await page.keyboard.press('Escape');
await pause(200);

// ── The dock panels' headers ───────────────────────────────────────────
//
// Five panels, five headers built separately. They are the most-seen row in
// the app after the top bar.
const dock = await page.evaluate(() => {
	['agents', 'mail', 'work', 'spend'].forEach((id) => { try { DaimondPanels.show(id); } catch (e) {} });
	return true;
});
await pause(600);
const dockHeads = await page.evaluate(() => {
	const out = [];
	for (const id of ['agents', 'mail', 'work', 'spend']) {
		const p = document.getElementById('panel-' + id);
		if (!p || !p.getClientRects().length) continue;
		const head = p.querySelector('.phead, .panel-head, .chead, [class*="head"]');
		if (!head) continue;
		const pr = p.getBoundingClientRect();
		const title = head.querySelector('span, h2, .ptitle');
		const bs = [...head.querySelectorAll('button')].filter((b) => b.getClientRects().length);
		const hr = head.getBoundingClientRect();
		out.push({
			id, headClass: head.className,
			height: Math.round(hr.height * 100) / 100,
			titleLeft: title ? Math.round((title.getBoundingClientRect().left - pr.left) * 100) / 100 : null,
			lastRight: bs.length ? Math.round((pr.right - bs[bs.length - 1].getBoundingClientRect().right) * 100) / 100 : null,
			btn: bs.length ? (() => { const r = bs[0].getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; })() : null,
			// A title whose ink centre is off the button row's centre is the
			// classic "the label sits high" — measured, not guessed.
			titleMid: title ? Math.round((title.getBoundingClientRect().top + title.getBoundingClientRect().bottom) / 2 * 100) / 100 : null,
			btnMid: bs.length ? Math.round((bs[0].getBoundingClientRect().top + bs[0].getBoundingClientRect().bottom) / 2 * 100) / 100 : null,
		});
	}
	return out;
});
{
	const lefts = dockHeads.map((h) => h.titleLeft).filter((x) => x !== null);
	const rights = dockHeads.map((h) => h.lastRight).filter((x) => x !== null);
	claim('every dock panel titles at the same left inset',
		lefts.length > 1 && Math.max(...lefts) - Math.min(...lefts) <= 0.5,
		dockHeads.map((h) => `${h.id}=${h.titleLeft}`).join(' '));
	claim('every dock panel ends its button row at the same right inset',
		rights.length > 1 && Math.max(...rights) - Math.min(...rights) <= 0.5,
		dockHeads.map((h) => `${h.id}=${h.lastRight}`).join(' '));
	claim('every dock panel header is the same height',
		new Set(dockHeads.map((h) => h.height)).size === 1,
		dockHeads.map((h) => `${h.id}=${h.height}px`).join(' '));
	const off = dockHeads.filter((h) => h.titleMid !== null && h.btnMid !== null
		&& Math.abs(h.titleMid - h.btnMid) > 0.75);
	claim('every dock title sits on its button row\'s centre line', off.length === 0,
		dockHeads.map((h) => `${h.id}: title mid ${h.titleMid} vs buttons ${h.btnMid}`).join('; '));
}

// ── Left insets inside a panel body ────────────────────────────────────
//
// A panel's own content, top to bottom. The header sets an inset; everything
// under it should keep it.
const insets = await page.evaluate(() => {
	const out = [];
	for (const id of ['work', 'mail', 'spend', 'agents']) {
		const p = document.getElementById('panel-' + id);
		if (!p || !p.getClientRects().length) continue;
		const pr = p.getBoundingClientRect();
		const kids = [...p.querySelectorAll('*')]
			.filter((e) => e.getClientRects().length && (e.textContent || '').trim()
				&& e.children.length === 0 && e.getBoundingClientRect().height > 6);
		const seen = new Map();
		for (const k of kids) {
			// The INK, not the box: a full-width block with 10px of padding has
			// its left edge at 0 and its text at 10, and it is the text a reader
			// lines up against its neighbour.
			const rng = document.createRange();
			rng.selectNodeContents(k);
			const r = rng.getBoundingClientRect();
			if (r.width < 1) continue;
			const x = Math.round((r.left - pr.left) * 10) / 10;
			if (!seen.has(x)) seen.set(x, (k.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22));
		}
		out.push({ id, edges: [...seen.entries()].sort((a, b) => a[0] - b[0]) });
	}
	return out;
});
for (const p of insets) {
	// Text nested inside a card legitimately starts further in; what matters is
	// how many DISTINCT top-level edges the eye has to reconcile below 24px.
	const shallow = p.edges.filter(([x]) => x <= 24);
	claim(`the ${p.id} panel uses one left inset for its own top-level text`,
		shallow.length <= 1,
		shallow.map(([x, t]) => `${x}px "${t}"`).join('  |  ') || '(none under 24px)');
}

console.log(`\n${rows.filter((r) => !r.ok).length} of ${rows.length} claims want a look.`);
const errs = errors(s).filter((e) => !/502|Bad Gateway/.test(e));
if (errs.length) console.log(`\n${errs.length} console error(s): ` + errs.slice(0, 5).join(' | '));
await s.close();
