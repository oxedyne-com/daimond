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
// The second half of the file is the height the columns divide between the
// panels stacked in them, on the same terms: A DIVIDER EXISTS EXACTLY WHERE
// THERE IS A BOUNDARY TO MOVE, and one the user has moved is still where they
// left it after a reload and after a round trip through another tiling.
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

// ── Panels stacked in a column divide its height ────────────────────────
//
// Two panels in one column used to take half of it each and that was that. A
// divider now sits between every adjacent pair, and what it is asked to prove
// is the same kind of invariant as above: A DIVIDER EXISTS EXACTLY WHERE THERE
// IS A BOUNDARY TO MOVE, and a boundary the user has moved is still where they
// left it after a reload and after a round trip through another tiling.
//
// The share is kept against the column's OCCUPANCY -- `work|mail` -- so the
// same two panels re-stacking anywhere find their own tuning, and a third
// joining them is a different stack and therefore an even one.

/// Exactly this set of dock panels, in this order, on this grid.
///
/// `dock()` above leaves the ORDER of anything already open alone, which is
/// right for what it tests and no use here: which panel is above which decides
/// what a divider is a boundary between.
const only = async (ids, grid) => {
	await p.evaluate(({ ids, grid }) => {
		DaimondPanels.setGrid(grid);
		DaimondPanels.panels().filter((x) => x.zone === 'dock').forEach((x) => DaimondPanels.hide(x.id));
		ids.forEach((id) => DaimondPanels.show(id));
	}, { ids, grid });
	await p.waitForTimeout(400);
};

/// What each drawing column is stacking, and every divider in the dock.
///
/// `loose` is the orphan count: a handle whose parent is not a column that
/// draws. The surplus-column sweep empties a retired column by moving its
/// children into the dock itself, so a divider left behind by a tiling change
/// would end up loose beside the panels -- a handle for a boundary that is not
/// there any more.
const stackGeom = () => p.evaluate(() => {
	const d = document.getElementById('dock');
	const drawn = (k) => k.getClientRects().length > 0;
	const cols = [...d.querySelectorAll('.pcol')].filter((c) => c.getBoundingClientRect().width > 0);
	return {
		cols: cols.map((c) => ({
			id: c.id,
			panels: [...c.children].filter((k) => k.classList.contains('panel') && drawn(k))
				.map((k) => ({ id: k.dataset.panel, h: Math.round(k.getBoundingClientRect().height) })),
			handles: [...c.children].filter((k) => k.classList.contains('hstack') && drawn(k)).length,
			order: [...c.children].filter(drawn)
				.map((k) => k.classList.contains('hstack') ? '|' : k.dataset.panel).join(' '),
		})),
		loose: [...d.querySelectorAll('.hstack')].filter((h) => {
			const par = h.parentNode;
			return !par || !par.classList.contains('pcol')
				|| par.getBoundingClientRect().width === 0;
		}).length,
		total: d.querySelectorAll('.hstack').length,
	};
});

/// Drag the i-th divider in the dock by `dy`, downwards positive.
///
/// Dispatched pointer events for the same reason `dragDock` uses them: headless
/// Chromium drops the moves after a mousedown on a dock handle. Capture is the
/// one thing a dispatched event cannot have, so it is stubbed for the drag.
const dragStack = (i, dy) => p.evaluate(({ i, by }) => {
	const h = document.querySelectorAll('#dock .hstack')[i];
	if (!h) return false;
	const r = h.getBoundingClientRect();
	const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
	const cap = Element.prototype.setPointerCapture, rel = Element.prototype.releasePointerCapture;
	Element.prototype.setPointerCapture = function () {};
	Element.prototype.releasePointerCapture = function () {};
	const fire = (type, cy) => h.dispatchEvent(new PointerEvent(type, {
		bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: x, clientY: cy,
	}));
	fire('pointerdown', y);
	for (let k = 1; k <= 10; k++) fire('pointermove', y + Math.round(by * k / 10));
	fire('pointerup', y + by);
	Element.prototype.setPointerCapture = cap;
	Element.prototype.releasePointerCapture = rel;
	return true;
}, { i, by: dy });

const heights = (g, col) => (g.cols[col || 0] ? g.cols[col || 0].panels.map((x) => x.h) : []);

{
	// A boundary exists only where two panels meet.
	await only(['work'], 'auto');
	const lone = await stackGeom();
	check('a column holding one panel has no divider', lone.total === 0,
		`${lone.total} in the dock`);

	await only(['work', 'mail'], 'auto');
	const two = await stackGeom();
	check('two panels stacked in a column get one divider between them',
		two.cols.length === 1 && two.cols[0].handles === 1 && two.cols[0].order === 'work | mail',
		two.cols.map((c) => `${c.id}: ${c.order}`).join(', '));
	const even = heights(two);
	check('and they start out sharing the column evenly',
		even.length === 2 && Math.abs(even[0] - even[1]) <= 4, even.join(' + '));

	// The drag moves the boundary the hand is on, and only that one.
	await dragStack(0, 80);
	await p.waitForTimeout(200);
	const moved = heights(await stackGeom());
	check('a divider dragged 80px down gives the upper panel 80px',
		Math.abs((moved[0] - even[0]) - 80) <= 6, `${even.join(' + ')} then ${moved.join(' + ')}`);
	check('and takes it off the lower one, so the column still fills',
		Math.abs((moved[0] + moved[1]) - (even[0] + even[1])) <= 4,
		`${even[0] + even[1]}px then ${moved[0] + moved[1]}px`);
	await shot(s, 'docking-stack-dragged');

	// What was tuned is still tuned after the page is built again from markup.
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'docking');
	await p.waitForTimeout(2500);
	const after = await stackGeom();
	check('the tuned boundary outlives a reload',
		Math.abs(heights(after)[0] - moved[0]) <= 6,
		`${moved.join(' + ')} then ${heights(after).join(' + ')}`);
	check('and the divider comes back with it',
		after.cols.length === 1 && after.cols[0].handles === 1, `${after.total} in the dock`);

	// Auto -> a tiling that separates them -> Auto. The same two panels re-stack,
	// so the same share applies; a key tied to the column slot could not do this.
	await p.evaluate(() => DaimondPanels.setGrid('2x2'));
	await p.waitForTimeout(400);
	const split2 = await stackGeom();
	check('a tiling that puts them in a column each has no divider to draw',
		split2.total === 0 && split2.cols.length === 2,
		`${split2.total} dividers over ${split2.cols.length} columns`);
	check('and leaves none loose in the dock', split2.loose === 0, `${split2.loose} loose`);
	await p.evaluate(() => DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(400);
	const round = await stackGeom();
	check('Auto -> 2x2 -> Auto keeps the tuned boundary',
		Math.abs(heights(round)[0] - moved[0]) <= 6,
		`${moved.join(' + ')} then ${heights(round).join(' + ')}`);
	check('and no column is left drawing on nothing', dead(await geom()) === null);

	// A panel joining the stack is a different stack: even, and the old tuning
	// is waiting for it to leave again.
	await p.evaluate(() => DaimondPanels.show('spend'));
	await p.waitForTimeout(400);
	const three = await stackGeom();
	check('a third panel joining the column brings a second divider',
		three.cols.length === 1 && three.cols[0].handles === 2, three.cols[0].order);
	const h3 = heights(three);
	check('and the new stack starts even rather than inheriting a share',
		h3.length === 3 && Math.max(...h3) - Math.min(...h3) <= 6, h3.join(' + '));

	// A divider is a boundary between two panels, not a lever on the column: the
	// lower one moves and the panel above it does not shift under the hand.
	await dragStack(1, 60);
	await p.waitForTimeout(200);
	const h3b = heights(await stackGeom());
	check('the lower divider of a three-panel column moves only its own pair',
		Math.abs(h3b[0] - h3[0]) <= 4 && Math.abs((h3b[1] - h3[1]) - 60) <= 6
		&& Math.abs((h3b[2] - h3[2]) + 60) <= 6, `${h3.join(' + ')} then ${h3b.join(' + ')}`);
	await p.evaluate(() => {
		const h = document.querySelectorAll('#dock .hstack')[1];
		if (h) h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
	});
	await p.waitForTimeout(200);

	await p.evaluate(() => DaimondPanels.hide('spend'));
	await p.waitForTimeout(400);
	check('and the pair gets its own tuning back when it leaves',
		Math.abs(heights(await stackGeom())[0] - moved[0]) <= 6,
		`${moved.join(' + ')} then ${heights(await stackGeom()).join(' + ')}`);

	// Neither panel can be dragged away to nothing.
	await dragStack(0, -3000);
	await p.waitForTimeout(200);
	const crushed = heights(await stackGeom());
	// Both bounds, so the check cannot pass on a divider that never moved: it
	// went as far as it could, and stopped at something you can still read.
	check('a divider dragged hard up leaves the upper panel usable, and no more',
		crushed[0] >= 110 && crushed[0] <= 160, `${crushed.join(' + ')}`);
	await dragStack(0, 3000);
	await p.waitForTimeout(200);
	const crushed2 = heights(await stackGeom());
	check('and dragged hard down leaves the lower one usable, and no more',
		crushed2[1] >= 110 && crushed2[1] <= 160, `${crushed2.join(' + ')}`);

	// The affordance the other dividers have.
	await p.evaluate(() => {
		const h = document.querySelector('#dock .hstack');
		if (h) h.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
	});
	await p.waitForTimeout(250);
	const reset = heights(await stackGeom());
	check('double-clicking a divider puts the column back to even',
		Math.abs(reset[0] - reset[1]) <= 4, reset.join(' + '));

	// Two columns, each stacking a pair: two boundaries that know nothing about
	// each other, which is the case a single stored ratio could not have held.
	await only(['work', 'mail', 'spend', 'agents'], '2x2');
	const quad = await stackGeom();
	check('2x2 with four panels gives each column its own divider',
		quad.cols.length === 2 && quad.cols.every((c) => c.handles === 1),
		quad.cols.map((c) => `${c.id}: ${c.order}`).join(', '));
	const colB = heights(quad, 1);
	await dragStack(0, 70);
	await p.waitForTimeout(200);
	const quad2 = await stackGeom();
	check('and dragging one leaves the other column alone',
		Math.abs(heights(quad2)[0] - heights(quad)[0] - 70) <= 6
		&& heights(quad2, 1).every((h, i) => Math.abs(h - colB[i]) <= 4),
		`${heights(quad).join(' + ')} | ${colB.join(' + ')} then `
		+ `${heights(quad2).join(' + ')} | ${heights(quad2, 1).join(' + ')}`);
	await p.evaluate(() => DaimondPanels.setGrid('auto'));
	await p.waitForTimeout(400);
	const stack4 = await stackGeom();
	check('four panels in one column stack with three dividers',
		stack4.cols.length === 1 && stack4.cols[0].handles === 3, stack4.cols[0].order);
	check('and the tiling change leaves none loose',
		stack4.loose === 0 && stack4.total === 3, `${stack4.total} total, ${stack4.loose} loose`);

	await only(['work', 'mail'], 'auto');

	// A column too short to honour any share does not offer a handle that
	// cannot move -- the rail's divider stands down the same way.
	await p.setViewportSize({ width: 1500, height: 300 });
	await p.evaluate(() => DaimondPanels.reflow());
	await p.waitForTimeout(300);
	const tiny = await stackGeom();
	const tinyH = await p.evaluate(() => Math.round(
		document.getElementById('dock-a').getBoundingClientRect().height));
	check('a column with no room to divide hides its divider',
		tinyH < 256 && (tiny.cols.length === 0 || tiny.cols[0].handles === 0),
		`${tinyH}px column, ` + tiny.cols.map((c) => `${c.id}: ${c.order}`).join(', '));
	await p.setViewportSize({ width: 1500, height: 950 });
	await p.evaluate(() => DaimondPanels.reflow());
	await p.waitForTimeout(300);

	// On a phone the dock is not a dock: one destination at a time, chosen from
	// the bottom bar. There is no boundary to hold, so there is no handle.
	await p.setViewportSize({ width: 390, height: 780 });
	await p.evaluate(() => DaimondPanels.reflow());
	await p.waitForTimeout(400);
	const phone = await p.evaluate(() =>
		[...document.querySelectorAll('.hstack')].filter((h) => h.getClientRects().length).length);
	check('the phone shell draws no dividers at all', phone === 0, `${phone} on screen`);
	await shot(s, 'docking-stack-phone');
	await p.setViewportSize({ width: 1500, height: 950 });
	await p.evaluate(() => DaimondPanels.reflow());
	await p.waitForTimeout(400);
	await shot(s, 'docking-stack-desktop');
}

// ── Nothing threw ───────────────────────────────────────────────────────
{
	const errs = errors(s).filter((e) => !/502|Bad Gateway|Failed to load resource/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.join(' | ') || 'clean');
}

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
