// verify_docking.mjs — the dock survives a change of tiling and a change back.
//
// The dock is one width (`widths.dock`) times however many columns the grid
// asks for, and those columns then divide that width between themselves. So
// the two numbers have to agree: if the engine sizes the dock for ONE column
// while TWO are still drawing, every panel comes back at half width.
//
// That is what was reported from the live app: Auto → 2 by 2 → Auto left the
// dock a single narrow column, the panels crushed into the left half of it and
// dead space beside them. The cause was that closing a panel does not move its
// element — it only hides it — so the column it was seated in still held a
// node, `.pcol:empty` never fired, and a column nobody could see kept its
// share of the dock.
//
// What is asserted is the invariant rather than the case: A COLUMN THAT TAKES
// WIDTH HAS SOMETHING VISIBLE IN IT, and going back to a tiling returns the
// dock to exactly what that tiling gave before it was left.
//
//   node dev/verify_docking.mjs
//
// Needs dev/serve.mjs on :8777. No gateway.

import { open, signInAs, shot, errors } from './harness.mjs';

const s = await open({ name: 'docking', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// What the dock is holding and what its columns are doing.
///
/// Measured, not intended: `getClientRects()` and `getBoundingClientRect()`,
/// because the whole defect was a column the engine had finished with that the
/// browser was still drawing. Anything reading the engine's own bookkeeping
/// would have called the broken layout healthy.
const geom = () => p.evaluate(() => {
	const d = document.getElementById('dock');
	const cols = [...d.querySelectorAll('.pcol')].map((c) => ({
		id: c.id,
		w: Math.round(c.getBoundingClientRect().width),
		shows: [...c.children].filter((k) => k.getClientRects().length).map((k) => k.dataset.panel),
	}));
	return {
		grid:  DaimondPanels.grid(),
		width: Math.round(d.getBoundingClientRect().width),
		drawn: cols.filter((c) => c.w > 0),
		open:  DaimondPanels.panels().filter((x) => x.zone === 'dock')
			.filter((x) => DaimondPanels.isOpen(x.id)).map((x) => x.id),
	};
});

/// The complaint, or null when every column that takes width earns it.
const dead = (g) => {
	const empty = g.drawn.filter((c) => c.shows.length === 0);
	if (empty.length) {
		return empty.map((c) => `${c.id} is ${c.w}px wide with nothing in it`).join('; ');
	}
	return null;
};

/// Put the dock in a known state: exactly these panels open, on this grid.
const dock = async (ids, grid) => {
	await p.evaluate(({ ids, grid }) => {
		DaimondPanels.setGrid(grid);
		DaimondPanels.panels().filter((x) => x.zone === 'dock').forEach((x) => {
			if (ids.indexOf(x.id) === -1) DaimondPanels.hide(x.id);
		});
		ids.forEach((id) => DaimondPanels.show(id));
	}, { ids, grid });
	await p.waitForTimeout(400);
};

// ── The baseline: two panels docked, on Auto, having never left it ──────
await dock(['work', 'mail'], 'auto');
const base = await geom();
check('Auto seats two dock panels in one column', base.drawn.length === 1,
	base.drawn.map((c) => `${c.id} ${c.w}px [${c.shows}]`).join(', '));
check('and that column is the whole dock', base.drawn[0] && base.drawn[0].w === base.width,
	`column ${base.drawn[0] ? base.drawn[0].w : '-'}px of a ${base.width}px dock`);
check('the baseline itself is honest', dead(base) === null, dead(base));

// ── The reported round trip, panel for panel ────────────────────────────
// Auto → a tiling → Auto, with a panel closed while away, which is what leaves
// a column holding a node nobody can see. Every tiling with more than one
// column can do it, so every one of them is walked.
for (const g of ['2x2', '2x3', '3x2']) {
	await p.evaluate((grid) => {
		DaimondPanels.show('spend');       // three panels, so the tiling spreads them
		DaimondPanels.setGrid(grid);
	}, g);
	await p.waitForTimeout(400);
	const spread = await geom();
	check(`${g} spreads the dock over more than one column`, spread.drawn.length > 1,
		spread.drawn.map((c) => `${c.id} ${c.w}px [${c.shows}]`).join(', '));

	await p.evaluate(() => DaimondPanels.hide('spend'));
	await p.waitForTimeout(350);
	await p.evaluate(() => DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(400);

	const back = await geom();
	const complaint = dead(back);
	check(`${g} → Auto leaves no column drawing on nothing`, complaint === null, complaint);
	check(`${g} → Auto comes back to one column`, back.drawn.length === 1,
		back.drawn.map((c) => `${c.id} ${c.w}px [${c.shows}]`).join(', '));
	check(`${g} → Auto comes back at the width Auto had`,
		back.drawn[0] && back.drawn[0].w === base.drawn[0].w,
		`${base.drawn[0].w}px before, ${back.drawn[0] ? back.drawn[0].w : '-'}px after`);
	if (complaint || back.drawn.length !== 1) await shot(s, 'docking-' + g);
}

// ── And without closing anything, which is how it was reported ──────────
{
	await dock(['work', 'spend', 'mail'], 'auto');
	const before = await geom();
	await p.evaluate(() => DaimondPanels.setGrid('2x2'));
	await p.waitForTimeout(400);
	await p.evaluate(() => DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(400);
	const after = await geom();
	check('three panels, Auto → 2x2 → Auto, is a round trip',
		after.width === before.width && after.drawn.length === before.drawn.length
		&& dead(after) === null,
		`${before.width}px/${before.drawn.length} col then ${after.width}px/${after.drawn.length} col`
		+ (dead(after) ? ' — ' + dead(after) : ''));
}

// ── The one-column tiling is not the auto one ───────────────────────────
// `1` is a chosen tiling and `auto` is a resolved one; they can agree on the
// count and still have to leave the dock in the same state.
{
	await dock(['work', 'spend', 'mail'], '2x2');
	await p.evaluate(() => DaimondPanels.hide('spend'));
	await p.waitForTimeout(350);
	await p.evaluate(() => DaimondPanels.setGrid('1'));
	await p.waitForTimeout(400);
	const one = await geom();
	check('2x2 → one column leaves no column drawing on nothing', dead(one) === null, dead(one));
	check('and the one column is the whole dock',
		one.drawn.length === 1 && one.drawn[0].w === one.width,
		`${one.drawn.length} columns, ${one.drawn[0] ? one.drawn[0].w : '-'}px of ${one.width}px`);
}

// ── A wide window, where Auto is itself two columns ─────────────────────
{
	await p.setViewportSize({ width: 2000, height: 950 });
	await dock(['work', 'spend', 'mail'], 'auto');
	const wide = await geom();
	check('above the two-column mark Auto takes two columns', wide.drawn.length === 2,
		wide.drawn.map((c) => `${c.id} ${c.w}px`).join(', '));
	await p.evaluate(() => DaimondPanels.setGrid('3x2'));
	await p.waitForTimeout(400);
	await p.evaluate(() => DaimondPanels.hide('spend'));
	await p.waitForTimeout(350);
	await p.evaluate(() => DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(400);
	const back = await geom();
	check('3x2 → Auto on a wide window leaves no dead column', dead(back) === null, dead(back));
	check('and the columns still share the whole dock',
		back.drawn.reduce((a, c) => a + c.w, 0) >= back.width - 16,
		`${back.drawn.map((c) => c.w).join(' + ')} of ${back.width}px`);
	await p.setViewportSize({ width: 1500, height: 950 });
	await p.evaluate(() => DaimondPanels.reflow());
	await p.waitForTimeout(400);
}

// ── What the saved layout brings back ───────────────────────────────────
// The DOM is rebuilt from the markup on a reload, so a live-only fault would
// heal itself and the user would never see it twice. This says so explicitly,
// and would catch the day the columns start being written to the layout.
{
	await dock(['work', 'spend', 'mail'], '2x2');
	await p.evaluate(() => DaimondPanels.hide('spend'));
	await p.waitForTimeout(300);
	await p.evaluate(() => DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(400);
	const live = await geom();
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'docking');
	await p.waitForTimeout(2500);
	const fresh = await geom();
	check('the tiling outlives the reload', fresh.grid === 'auto', fresh.grid);
	check('and the dock comes up honest', dead(fresh) === null, dead(fresh));
	check('at the same width it was left at', fresh.width === live.width,
		`${live.width}px then ${fresh.width}px`);
	if (dead(live)) await shot(s, 'docking-reload');
}

// ── The handle moves the edge the pointer is holding ────────────────────
// `widths.dock` is ONE column's width and the dock is that times the columns it
// draws, so a drag added to it whole moved the edge at two or three times the
// speed of the hand.
//
// Driven by dispatched pointer events rather than `page.mouse`: Chromium
// headless drops the moves after a mousedown on this particular handle often
// enough that a real-mouse drag is not a usable oracle here (the rail's
// identical handle drags fine, so it is the harness, not the app). Pointer
// CAPTURE is the one thing a dispatched event cannot have, so it is stubbed for
// the length of the drag -- the arithmetic under test is untouched.
const dragDock = (dx) => p.evaluate((by) => {
	const h = document.getElementById('handle-dock');
	const r = h.getBoundingClientRect();
	const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
	const cap = Element.prototype.setPointerCapture, rel = Element.prototype.releasePointerCapture;
	Element.prototype.setPointerCapture = function () {};
	Element.prototype.releasePointerCapture = function () {};
	const fire = (type, cx) => h.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: cx, clientY: y,
	}));
	fire('pointerdown', x);
	for (let i = 1; i <= 10; i++) fire('pointermove', x - Math.round(by * i / 10));
	fire('pointerup', x - by);
	Element.prototype.setPointerCapture = cap;
	Element.prototype.releasePointerCapture = rel;
}, dx);
{
	for (const [grid, cols] of [['auto', 1], ['2x2', 2], ['3x2', 3]]) {
		await dock(['work', 'spend', 'mail'], grid);
		const w0 = (await geom()).width;
		await dragDock(100);
		await p.waitForTimeout(250);
		const w1 = (await geom()).width;
		check(`on ${grid} (${cols} column${cols > 1 ? 's' : ''}) a 100px drag widens the dock by 100px`,
			Math.abs((w1 - w0) - 100) <= 4, `${w0}px then ${w1}px`);
		await p.evaluate(() => DaimondPanels.reflow());
	}
	// Put the width back, so nothing downstream inherits a dragged dock.
	await p.evaluate(() => {
		document.getElementById('handle-dock').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		DaimondPanels.setGrid('auto');
	});
	await p.waitForTimeout(300);
}

// ── Nothing threw ───────────────────────────────────────────────────────
{
	const errs = errors(s).filter((e) => !/502|Bad Gateway|Failed to load resource/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.join(' | ') || 'clean');
}

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
