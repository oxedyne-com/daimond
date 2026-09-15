// verify_dockdrag.mjs — a panel is carried into a slot of the Dock, and the
// indicators say where it will land before it is let go.
//
// The Dock's arrangement used to be a CONSEQUENCE: one flat list of panels in
// the order they were opened, seated round robin at draw time, so the only way
// to a different arrangement was to close panels and open them again in the
// order wanted. The cost of that is measured at the foot of this file, by
// driving both routes: the old one, and the drag that replaces it.
//
// EVERY CELL ASSERTS MEASURED RECTS AND DOM ORDER, never the engine's own
// bookkeeping alone (`verify_docking.mjs` is the model). The whole class of
// defect this feature can have is "the engine believes one arrangement and the
// browser draws another", and a check reading `DaimondPanels.dock()` would call
// that healthy. So each cell reads the columns from the DOM, in draw order, and
// compares them with what the engine says — and both have to agree.
//
// The arithmetic underneath — what a drop does to an arrangement, which zone a
// point is in, how a v1 record migrates — is `www/js/dockdrag.test.mjs`, under
// node, in milliseconds. This file is for what only a browser can settle.
//
//   node dev/verify_dockdrag.mjs
//   node dev/verify_dockdrag.mjs --break <name>   # expected to FAIL
//   node dev/verify_dockdrag.mjs --list           # the breaks and what each takes away
//
// Needs a world (DAIMOND_PORT). No gateway, no wasm rebuild.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ──────────────────────────────────────────────────────────
//
// Each is a named mutation of a SOURCE FILE, served in place of the real one by
// `page.route`, so what is being proved wrong is the shipped file rather than a
// stand-in for it. A cell that stays green under its own break is a cell that
// was not checking what it says it checks (dev/CHECKS.md §2a).
const BREAKS = {
	clickdrags: { what: 'the chip\'s drag swallows the click that was never a drag',
		file: 'js/dockdrag.js', edits: [[
			'if (tags) window.DaimondGesture.drag(tags, {',
			'if (tags) tags.addEventListener(\'click\', function (e) { e.stopPropagation(); e.preventDefault(); }, true);\n\t\tif (tags) window.DaimondGesture.drag(tags, {']] },
	nozones: { what: 'no point is ever in a zone, so no indicator is ever drawn',
		file: 'js/dockdrag.js', edits: [[
			'function pick(zs, x, y, tol) {',
			'function pick(zs, x, y, tol) { if (zs) return null;']] },
	wrongslot: { what: 'an insertion lands one row past the boundary it was aimed at',
		file: 'js/dockdrag.js', edits: [[
			'var i = zone.row + (zone.kind === \'after\' ? 1 : 0);',
			'var i = zone.row + (zone.kind === \'after\' ? 2 : 1);']] },
	alwayscol: { what: 'the column cap is a constant again, so an edge always offers one more',
		file: 'js/dockdrag.js', edits: [[
			'maxCols: Math.max(1, isFinite(maxCols) ? maxCols : 1),',
			'maxCols: 9,']] },
	noswap: { what: 'a drop on a panel\'s middle third does nothing',
		file: 'js/dockdrag.js', edits: [[
			'if (zone.kind === \'replace\') {',
			'if (zone.kind === \'replace\') { if (zone) return same;']] },
	closeschip: { what: 'a release outside the Dock closes something even when a chip was carried',
		file: 'js/dockdrag.js', edits: [[
			'if (ctx.placed) P().userHide(ctx.id);',
			'P().userHide(ctx.placed ? ctx.id : (P().dock()[0] || [])[0]);']] },
	disabledchip: { what: 'a chip the full Dock refuses is `disabled`, so it takes no pointer at all',
		file: 'js/workspace.js', edits: [[
			'b.setAttribute(\'aria-disabled\', \'true\');',
			'b.disabled = true;']] },
	nopersist: { what: 'the arrangement is written back flat, so a reload round-robins it',
		file: 'js/daimond.js', edits: [[
			'open: open, stage: stage, dock: dock,',
			'open: open, stage: stage, dock: dockIds(),']] },
	nomigrate: { what: 'a v1 record loads into one column instead of the grid\'s',
		file: 'js/dockdrag.js', edits: [[
			'ids.forEach(function (id, i) { out[i % n].push(id); });',
			'ids.forEach(function (id) { out[0].push(id); });']] },
	enterignored: { what: 'Enter leaves the keyboard mode without placing anything',
		file: 'js/dockdrag.js', edits: [[
			'if (ev.key === \'Enter\')  { ev.preventDefault(); keyLeave(true);  return; }',
			'if (ev.key === \'Enter\')  { ev.preventDefault(); keyLeave(false); return; }']] },
	escwrites: { what: 'Escape mid-drag commits the drop it was cancelling',
		file: 'js/dockdrag.js', edits: [[
			'if (live) { end(false); ev.preventDefault(); }',
			'if (live) { end(true); ev.preventDefault(); }']] },
	presetkeepscustom: { what: 'a drag leaves the preset standing, so the menu claims a tiling that is not on screen',
		file: 'js/daimond.js', edits: [[
			'\t\t\tgrid = \'custom\';\n',
			'\t\t\t/* grid = \'custom\'; */\n']] },
	// TWO EDITS, because one was not a break at all. Lowering the threshold
	// alone lifts the gesture on a slide but never sets `strip` -- that is
	// `onHold`'s doing -- so `move` and `drop` both return early and nothing is
	// reordered: the cell stayed green under its own break, which is a green
	// that means nothing. The bug this names is a strip that treats TRAVEL as
	// the lift, so the break has to make travel lift it.
	tapreorders: { what: 'the phone\'s strip lifts on a slide, so it cannot be scrolled',
		file: 'js/dockdrag.js', edits: [
			['threshold: 1e9,', 'threshold: 0,'],
			['\t\t\tonHold: function (ctx) {',
				'\t\t\tlift: function (ev, ctx) { lifting(ctx); },\n\t\t\tonHold: function (ctx) {']] },
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (process.argv.includes('--list')) {
	Object.keys(BREAKS).forEach((k) => console.log(`  ${k.padEnd(20)} ${BREAKS[k].what}`));
	process.exit(0);
}
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// Serve the mutated file in place of the real one, for this session only.
///
/// The substitution is ASSERTED to have landed: a break whose anchor text has
/// drifted out of the file would serve the real thing and the cell would pass,
/// which is a green that means nothing at all.
const breaker = BREAK ? async (page) => {
	const b = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, b.file), 'utf8');
	let out = src;
	for (const [from, to] of b.edits) {
		if (!out.includes(from)) {
			console.error(`--break ${BREAK}: anchor not found in ${b.file}:\n  ${from.slice(0, 80)}`);
			process.exit(2);
		}
		out = out.replace(from, to);
	}
	await page.route('**/' + b.file, (r) => r.fulfill({
		status: 200, contentType: 'application/javascript', body: out,
	}));
} : null;

// ── Reading the Dock the way the browser draws it ───────────────────────

/// The columns as DRAWN: which panels are visible in each column that takes
/// width, in document order, with the rectangles that prove they are there.
///
/// And the engine's own answer beside it, so a cell can insist the two agree.
const DRAWN = () => {
	const d = document.getElementById('dock');
	const cols = [...d.querySelectorAll('.pcol')]
		.filter((c) => c.getBoundingClientRect().width > 0)
		.map((c) => ({
			id: c.id,
			x: Math.round(c.getBoundingClientRect().x),
			w: Math.round(c.getBoundingClientRect().width),
			ids: [...c.children].filter((k) => k.classList.contains('panel')
				&& k.getClientRects().length).map((k) => ({
					id: k.dataset.panel,
					y: Math.round(k.getBoundingClientRect().y),
					h: Math.round(k.getBoundingClientRect().height),
				})),
		}));
	return {
		cols, grid: window.DaimondPanels.grid(),
		said: window.DaimondPanels.dock(),
		room: window.DaimondPanels.dockRoom(),
		open: window.DaimondPanels.panels().filter((p) => p.zone === 'dock')
			.filter((p) => window.DaimondPanels.isOpen(p.id)).map((p) => p.id),
	};
};

const drawn = (p) => p.evaluate(DRAWN);
/// The drawn arrangement as bare ids, which is what a cell compares.
const shape = (g) => g.cols.filter((c) => c.ids.length).map((c) => c.ids.map((k) => k.id));
/// Does what is on screen match what the engine believes, in every slot?
const agrees = (g) => JSON.stringify(shape(g)) === JSON.stringify(g.said);
const show = (g) => shape(g).map((c) => c.join('+')).join(' | ') || '(empty)';

/// The arrangement the engine is put into before a cell drives it.
///
/// Through the ordinary doors -- `setGrid` and `show` -- so the starting point
/// is one the app could actually be in, rather than a record written by hand.
const seed = async (p, grid, ids) => {
	await p.evaluate(({ grid, ids }) => {
		// EVERY CHIP IN THE ROW FIRST, because a fresh account's row is six of
		// them. `DEFAULT_PINNED` (TOP-01, 2026-09-15 audit) starts the desktop
		// top bar small and folds the rest into the gallery behind the ⋯ chip,
		// so `mail` and `agents` -- two of the three panels these cells drag --
		// are not in `#panel-tags` at all, and a press aimed at one waits out
		// its timeout on a chip that was never going to be there. Pinning them
		// is what a person does before dragging one, and it leaves the app's
		// default alone: this is the verifier arriving at the row it is about.
		// The phone half is unaffected either way -- `isPinned` is always true
		// there, and the footer strip carries the whole set (js/mobile.js).
		window.DaimondPanels.panels().forEach((x) => window.DaimondPanels.setPinned(x.id, true));
		window.DaimondPanels.panels().filter((x) => x.zone === 'dock')
			.forEach((x) => window.DaimondPanels.hide(x.id));
		window.DaimondPanels.setGrid(grid);
		ids.forEach((id) => window.DaimondPanels.show(id));
	}, { grid, ids });
	await p.waitForTimeout(450);
};

// ── Driving the gesture with a real pointer ─────────────────────────────

/// Where a thing is, in the pointer's own coordinates.
const box = (p, sel) => p.evaluate((sel) => {
	const el = document.querySelector(sel);
	if (!el) return null;
	const r = el.getBoundingClientRect();
	return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
}, sel);

const HEAD = (id) => `.panel[data-panel="${id}"] .railhead > [role="heading"]`;
const CHIP = (id) => `#panel-tags .ptag[data-panel="${id}"]`;

/// Press on `from`, travel to `to`, and answer what the overlay was showing at
/// the end of the travel -- WITHOUT releasing. The caller lets go, or does not.
const carryTo = async (p, from, to) => {
	const a = await box(p, from);
	if (!a) throw new Error('no drag source ' + from);
	await p.mouse.move(a.cx, a.cy);
	await p.mouse.down();
	// Past the four-pixel threshold first, in small steps, so the lift happens
	// where a hand would make it happen rather than in one teleport.
	await p.mouse.move(a.cx + 8, a.cy + 6, { steps: 3 });
	await p.mouse.move(to.x, to.y, { steps: 10 });
	await p.waitForTimeout(120);
	return p.evaluate(() => {
		const seen = (sel) => {
			const e = document.querySelector(sel);
			if (!e || e.hidden) return null;
			const r = e.getBoundingClientRect();
			return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
		};
		return {
			zone:  window.DaimondDockDrag.showing(),
			line:  seen('.ddz-line'),
			boxed: seen('.ddz-box'),
			col:   seen('.ddz-col'),
			ghost: !!document.querySelector('.ptag-ghost'),
			cross: !!(document.querySelector('.ptag-ghost .gx')
				&& !document.querySelector('.ptag-ghost .gx').hidden),
		};
	});
};

const release = async (p) => { await p.mouse.up(); await p.waitForTimeout(400); };

/// Abandon a drag: Escape, and then let the button go.
///
/// BOTH, and the second is not tidiness. A cell that pressed Escape and left
/// the button down handed the next cell a pointer that was already pressed, and
/// its `mouse.down()` did nothing at all -- four cells went red for a mistake
/// in the cell before them.
const abandon = async (p) => {
	await p.keyboard.press('Escape');
	await p.waitForTimeout(200);
	await p.mouse.up();
	await p.waitForTimeout(250);
};

/// A point in a panel: `f` down its height, `g` across its width.
const inPanel = async (p, id, f, g) => {
	const b = await box(p, `.panel[data-panel="${id}"]`);
	return { x: b.x + b.w * (g === undefined ? 0.5 : g), y: b.y + b.h * f };
};

const s = await open({ name: 'dockdrag', connect: false, route: breaker });
const p = s.page;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK} (${BREAKS[BREAK].what}): failures below are the point ***\n`);
await p.setViewportSize({ width: 2200, height: 1000 });
await p.waitForTimeout(1600);

// ── 1. clickstill: a press that never travelled is still a click ────────
{
	await seed(p, 'auto', ['work']);
	const wasOpen = await p.evaluate(() => window.DaimondPanels.isOpen('mail'));
	await p.click(CHIP('mail'));
	await p.waitForTimeout(400);
	const nowOpen = await p.evaluate(() => window.DaimondPanels.isOpen('mail'));
	await p.click(CHIP('mail'));
	await p.waitForTimeout(400);
	const backOpen = await p.evaluate(() => window.DaimondPanels.isOpen('mail'));
	check('a plain click on a chip still toggles the panel',
		!wasOpen && nowOpen && !backOpen, `${wasOpen} → ${nowOpen} → ${backOpen}`);
	const g = await drawn(p);
	check('and a click leaves no ghost and no overlay behind',
		!(await p.evaluate(() => !!document.querySelector('.ptag-ghost')))
		&& !(await p.evaluate(() => { const o = document.getElementById('dock-drop'); return o && !o.hidden; })),
		show(g));
}

// ── 2. zones: the indicator names the slot the pointer is over ──────────
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	const g0 = await drawn(p);
	check('four panels seat two and two, as the preset always did',
		JSON.stringify(shape(g0)) === JSON.stringify([['work', 'agents'], ['mail', 'spend']]),
		show(g0));
	check('and the browser agrees with the engine about every slot', agrees(g0),
		`${show(g0)} vs ${JSON.stringify(g0.said)}`);

	// Nothing is drawn before the press has travelled.
	const a = await box(p, HEAD('spend'));
	await p.mouse.move(a.cx, a.cy);
	await p.mouse.down();
	await p.mouse.move(a.cx + 2, a.cy + 1);
	await p.waitForTimeout(80);
	const still = await p.evaluate(() => ({
		ghost: !!document.querySelector('.ptag-ghost'),
		over: (() => { const o = document.getElementById('dock-drop'); return !!(o && !o.hidden); })(),
	}));
	check('under the threshold nothing is lifted and nothing is drawn',
		!still.ghost && !still.over, JSON.stringify(still));
	await p.mouse.up();
	await p.waitForTimeout(200);

	// The top of a panel is a line, the middle a box, the bottom a line again.
	const top = await carryTo(p, HEAD('spend'), await inPanel(p, 'work', 0.12));
	check('over the top of a panel the overlay is an insertion line',
		top.zone && top.zone.kind === 'before' && top.line && !top.boxed,
		`${top.zone && top.zone.kind}, line ${JSON.stringify(top.line)}`);
	const wbox = await box(p, '.panel[data-panel="work"]');
	await shot(s, 'dockdrag-insert');
	check('and that line sits on the boundary it names, across the column',
		top.line && Math.abs(top.line.y - Math.round(wbox.y)) <= 3 && top.line.w >= wbox.w - 4,
		`line y=${top.line && top.line.y} of panel y=${Math.round(wbox.y)}, w ${top.line && top.line.w} of ${Math.round(wbox.w)}`);

	await p.mouse.move((await inPanel(p, 'work', 0.5)).x, (await inPanel(p, 'work', 0.5)).y, { steps: 6 });
	await p.waitForTimeout(140);
	const mid = await p.evaluate(() => ({
		kind: (window.DaimondDockDrag.showing() || {}).kind,
		boxed: (() => { const e = document.querySelector('.ddz-box'); return e && !e.hidden ? Math.round(e.getBoundingClientRect().height) : 0; })(),
	}));
	check('over the middle third it is a box around the panel itself',
		mid.kind === 'replace' && Math.abs(mid.boxed - Math.round(wbox.h)) <= 4,
		`${mid.kind}, ${mid.boxed}px of ${Math.round(wbox.h)}px`);

	await shot(s, 'dockdrag-replace');
	const low = await inPanel(p, 'work', 0.9);
	await p.mouse.move(low.x, low.y, { steps: 6 });
	await p.waitForTimeout(140);
	const bot = await p.evaluate(() => (window.DaimondDockDrag.showing() || {}).kind);
	check('and over the bottom it is a line again, below', bot === 'after', String(bot));

	// Out of the Dock: no indicator at all, and the ghost says what a release
	// would do instead.
	await p.mouse.move(700, 500, { steps: 8 });
	await p.waitForTimeout(140);
	const out = await p.evaluate(() => ({
		zone: window.DaimondDockDrag.showing(),
		over: (() => { const o = document.getElementById('dock-drop'); return !!(o && !o.hidden); })(),
		cross: (() => { const x = document.querySelector('.ptag-ghost .gx'); return !!(x && !x.hidden); })(),
	}));
	check('over the stage nothing is offered, and the ghost carries a cross',
		out.zone === null && !out.over && out.cross, JSON.stringify(out));
	await abandon(p);
}

// ── 3. drop-places: a release seats the panel where the line was ────────
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	// Between Workspace and Agents in the first column: the boundary below
	// Workspace.
	const got = await carryTo(p, HEAD('spend'), await inPanel(p, 'work', 0.9));
	check('the line offered is the boundary below the Workspace',
		got.zone && got.zone.kind === 'after' && got.zone.col === 0 && got.zone.row === 0,
		JSON.stringify(got.zone && { k: got.zone.kind, c: got.zone.col, r: got.zone.row }));
	await release(p);
	const g = await drawn(p);
	check('and the release seats it exactly there',
		JSON.stringify(shape(g)) === JSON.stringify([['work', 'spend', 'agents'], ['mail']]), show(g));
	check('the DOM order and the engine agree about it', agrees(g),
		`${show(g)} vs ${JSON.stringify(g.said)}`);
	// The rectangles, not only the order: the moved panel is really above the
	// one it was put above.
	const ys = g.cols[0].ids.map((k) => k.y);
	check('and the rows are drawn in that order, top to bottom',
		ys.length === 3 && ys[0] < ys[1] && ys[1] < ys[2], ys.join(' < '));
	check('a drag makes the Dock custom, because no preset describes it',
		g.grid === 'custom', g.grid);
}

// ── 4. newcol: an edge offers a column only where one fits ──────────────
{
	// THREE PANELS IN TWO COLUMNS, so the drag has a third column to make. With
	// two it would be one panel carried to the edge of the only column it is in,
	// which is rightly a no-op -- and an assertion that a no-op is allowed is an
	// assertion that passes when nothing happened.
	await seed(p, '2x2', ['work', 'mail', 'agents']);
	const wide = await drawn(p);
	check('the starting point is two columns, one of them sharing',
		JSON.stringify(shape(wide)) === JSON.stringify([['work', 'agents'], ['mail']]), show(wide));
	const right = { x: wide.cols[wide.cols.length - 1].x + wide.cols[wide.cols.length - 1].w - 10,
		y: 400 };
	const at2200 = await carryTo(p, HEAD('agents'), right);
	check('at 2200px the right edge offers a third column',
		!!(at2200.zone && at2200.zone.kind === 'newcol' && at2200.col),
		`${at2200.zone && at2200.zone.kind}, outline ${JSON.stringify(at2200.col)}`);
	await shot(s, 'dockdrag-newcol');
	check('drawn as a full-height outline a column wide, not a line',
		!!(at2200.col && Math.abs(at2200.col.w - wide.cols[0].w) <= 4
			&& at2200.col.h > 400 && !at2200.line),
		`${JSON.stringify(at2200.col)} against a ${wide.cols[0].w}px column`);
	await release(p);
	const g = await drawn(p);
	check('and the release makes it, at the edge it was offered at',
		JSON.stringify(shape(g)) === JSON.stringify([['work'], ['mail'], ['agents']]), show(g));
	check('three columns are really drawn, side by side',
		g.cols.filter((c) => c.ids.length).length === 3
		&& g.cols[0].x < g.cols[1].x && g.cols[1].x < g.cols[2].x,
		g.cols.map((c) => `${c.id}@${c.x}`).join(' '));

	// Narrow enough that a third column cannot be had, with two already open.
	await p.setViewportSize({ width: 1240, height: 1000 });
	await p.evaluate(() => window.DaimondPanels.reflow());
	await p.waitForTimeout(500);
	await seed(p, '2x2', ['work', 'mail']);
	const narrow = await drawn(p);
	const last = narrow.cols[narrow.cols.length - 1];
	const edge = { x: last.x + last.w - 8, y: 400 };
	const at1240 = await carryTo(p, HEAD('mail'), edge);
	check(`at ${narrow.room.maxCols} column(s) of room the edge offers no more`,
		!at1240.zone || at1240.zone.kind !== 'newcol',
		`room ${JSON.stringify(narrow.room)}, showing ${at1240.zone && at1240.zone.kind}`);
	await abandon(p);
	await p.setViewportSize({ width: 2200, height: 1000 });
	await p.evaluate(() => window.DaimondPanels.reflow());
	await p.waitForTimeout(400);
}

// ── 5. replace: the middle third is a swap ──────────────────────────────
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	const before = shape(await drawn(p));
	await carryTo(p, HEAD('spend'), await inPanel(p, 'work', 0.5));
	await release(p);
	const g = await drawn(p);
	check('two placed panels dropped on each other change places',
		JSON.stringify(shape(g)) === JSON.stringify([['spend', 'agents'], ['mail', 'work']]),
		`${before.map((c) => c.join('+')).join(' | ')} → ${show(g)}`);
	check('nobody was lost in the swap',
		shape(g).flat().sort().join() === before.flat().sort().join(), show(g));
	check('and the browser agrees with the engine', agrees(g), show(g));
}

// ── 6. outside-closes: a tear-off puts a panel away, a chip does not ────
{
	await seed(p, '2x2', ['work', 'mail', 'agents']);
	await carryTo(p, HEAD('agents'), { x: 700, y: 500 });
	await release(p);
	const g = await drawn(p);
	check('a placed panel released over the stage is put away',
		!g.open.includes('agents') && !shape(g).flat().includes('agents'),
		`open: ${g.open.join(', ')}`);
	const chipBack = await p.$(CHIP('agents'));
	check('and comes back as a chip, where it can be clicked again', !!chipBack);

	// A chip carried out of the Dock and dropped is not a request to close
	// anything: it never had a slot to give up.
	const was = shape(await drawn(p));
	await carryTo(p, CHIP('agents'), { x: 700, y: 500 });
	await release(p);
	const after = await drawn(p);
	check('a chip released over the stage closes nothing',
		JSON.stringify(shape(after)) === JSON.stringify(was)
		&& after.open.length === (await p.evaluate(() => window.DaimondPanels.dock().flat().length)),
		`${was.map((c) => c.join('+')).join(' | ')} → ${show(after)}`);
}

// ── 7. chipdrag: a chip is a drag source, full Dock or not ──────────────
{
	// A Dock with no room left: one column, one row.
	await p.setViewportSize({ width: 2200, height: 300 });
	await p.evaluate(() => window.DaimondPanels.reflow());
	await p.waitForTimeout(400);
	await seed(p, 'auto', ['work']);
	await p.evaluate(() => window.DaimondPanels.setGrid('1'));
	await p.waitForTimeout(300);
	// Fill it, whatever "full" turns out to be at this height.
	await p.evaluate(() => ['mail', 'agents', 'spend', 'trash', 'social', 'pending', 'tracker']
		.forEach((id) => window.DaimondPanels.show(id)));
	await p.waitForTimeout(500);
	const full = await p.evaluate(() => {
		const m = window.DaimondPanels.model().panels.filter((x) => x.zone === 'dock' && x.full);
		return m.length ? m[0].id : null;
	});
	if (!full) {
		check('a full Dock could be reached to test the refused chip', false,
			'nothing reported full at 2200x300');
	} else {
		const st = await p.evaluate((id) => {
			const b = document.querySelector('#panel-tags .ptag[data-panel="' + id + '"]');
			return b ? { dis: b.disabled, aria: b.getAttribute('aria-disabled'),
				cls: b.className, pe: getComputedStyle(b).pointerEvents } : null;
		}, full);
		check('a chip the full Dock refuses is aria-disabled, not disabled',
			st && st.dis === false && st.aria === 'true' && /\bfull\b/.test(st.cls),
			JSON.stringify(st));
		check('so it still receives a pointer', st && st.pe !== 'none', st && st.pe);
		const target = await drawn(p);
		const victim = target.cols[0].ids[0].id;
		const got = await carryTo(p, CHIP(full), await inPanel(p, victim, 0.5));
		check('and it can be carried onto a panel to take its place',
			got.zone && got.zone.kind === 'replace' && got.boxed,
			`${got.zone && got.zone.kind}`);
		await release(p);
		const g = await drawn(p);
		check('the release seats the refused panel and sends the other back to the row',
			shape(g).flat().includes(full) && !shape(g).flat().includes(victim)
			&& !!(await p.$(CHIP(victim))),
			`${show(g)}; ${full} in, ${victim} out`);
	}
	await p.setViewportSize({ width: 2200, height: 1000 });
	await p.evaluate(() => window.DaimondPanels.reflow());
	await p.waitForTimeout(400);
}

// ── 8. persists: the arrangement survives a reload ──────────────────────
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	await carryTo(p, HEAD('spend'), await inPanel(p, 'work', 0.12));
	await release(p);
	const before = await drawn(p);
	const stored = await p.evaluate(() => JSON.parse(localStorage.getItem('daimond-layout') || '{}').dock);
	check('the record on disk is columns, not a flat list',
		Array.isArray(stored) && stored.every((c) => Array.isArray(c)), JSON.stringify(stored));
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(2600);
	const after = await drawn(p);
	check('and a reload brings the arrangement back, slot for slot',
		JSON.stringify(shape(after)) === JSON.stringify(shape(before)),
		`${show(before)} → ${show(after)}`);
	check('the reloaded Dock is drawn where the engine says it is', agrees(after), show(after));
	check('and it is still custom, so the menu does not claim a preset', after.grid === 'custom', after.grid);
}

// ── 9. migrate: a v1 record loads into the slots it was drawn in ────────
{
	// The flat record the app wrote until 2026-09-15, written by hand and read
	// back through the real loader. On Auto at 2200px the grid is two columns,
	// so the round robin is work/agents | mail/spend.
	await p.evaluate(() => {
		const l = JSON.parse(localStorage.getItem('daimond-layout') || '{}');
		l.open = Object.assign({}, l.open,
			{ work: true, mail: true, agents: true, spend: true, rail: true, ai: true });
		l.dock = ['work', 'mail', 'agents', 'spend'];
		l.grid = 'auto';
		localStorage.setItem('daimond-layout', JSON.stringify(l));
	});
	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(2600);
	const g = await drawn(p);
	check('a v1 flat record loads into the round robin it was drawn as — nothing moves',
		JSON.stringify(shape(g)) === JSON.stringify([['work', 'agents'], ['mail', 'spend']]),
		show(g));
	check('and it is still Auto: reading an old record is not a drag', g.grid === 'auto', g.grid);
}

// ── 10. keyboard: the same zones, walked ────────────────────────────────
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	const before = shape(await drawn(p));
	const focused = await p.evaluate((sel) => {
		const h = document.querySelector(sel);
		if (!h) return null;
		h.focus();
		return { tab: h.getAttribute('tabindex'), is: document.activeElement === h };
	}, HEAD('agents'));
	check('a docked panel\'s heading can be focused', focused && focused.is && focused.tab === '0',
		JSON.stringify(focused));
	await p.keyboard.press('ArrowUp');
	await p.waitForTimeout(200);
	const said = await p.evaluate(() => (document.getElementById('copy-say') || {}).textContent);
	const zone = await p.evaluate(() => window.DaimondDockDrag.showing());
	check('an arrow enters the move mode and draws the same overlay',
		zone && (zone.kind === 'before' || zone.kind === 'after')
		&& (await p.evaluate(() => { const l = document.querySelector('.ddz-line'); return !!(l && !l.hidden); })),
		JSON.stringify(zone && { k: zone.kind, c: zone.col, r: zone.row }));
	check('and says how to use it, in the polite region', /Arrow|Esc/i.test(said || ''), said);
	await p.keyboard.press('Enter');
	await p.waitForTimeout(400);
	const g = await drawn(p);
	check('Enter places the panel where the overlay was',
		JSON.stringify(shape(g)) !== JSON.stringify(before)
		&& JSON.stringify(shape(g)) === JSON.stringify([['agents', 'work'], ['mail', 'spend']]),
		`${before.map((c) => c.join('+')).join(' | ')} → ${show(g)}`);
	const moved = await p.evaluate(() => (document.getElementById('copy-say') || {}).textContent);
	check('and says so', /moved/i.test(moved || ''), moved);

	// Escape leaves it exactly as it was.
	const held = shape(await drawn(p));
	await p.evaluate((sel) => document.querySelector(sel).focus(), HEAD('work'));
	await p.keyboard.press('ArrowDown');
	await p.waitForTimeout(150);
	await p.keyboard.press('Escape');
	await p.waitForTimeout(300);
	const esc = await drawn(p);
	check('Escape leaves the keyboard mode having moved nothing',
		JSON.stringify(shape(esc)) === JSON.stringify(held)
		&& !(await p.evaluate(() => { const o = document.getElementById('dock-drop'); return !!(o && !o.hidden); })),
		show(esc));

	// A CHIP, with Shift+Enter: the panel opens at its default slot and the
	// same mode begins, with the focus moved to the heading the arrows belong
	// to -- without that move the mode is entered and then unreachable.
	await seed(p, '2x2', ['work', 'mail']);
	await p.evaluate((sel) => document.querySelector(sel).focus(), CHIP('spend'));
	await p.keyboard.press('Shift+Enter');
	await p.waitForTimeout(500);
	const chipMode = await p.evaluate(() => ({
		zone: window.DaimondDockDrag.showing(),
		on: document.activeElement && document.activeElement.getAttribute('role') === 'heading',
		open: window.DaimondPanels.isOpen('spend'),
	}));
	check('Shift+Enter on a chip opens the panel and begins the same mode',
		chipMode.open && !!chipMode.zone && chipMode.on, JSON.stringify(chipMode));
	await p.keyboard.press('ArrowUp');
	await p.waitForTimeout(150);
	await p.keyboard.press('Enter');
	await p.waitForTimeout(400);
	const placed = await drawn(p);
	check('and the arrows reach it, so Enter places the panel',
		shape(placed).flat().includes('spend') && agrees(placed), show(placed));
}

// ── 11. cancel: Escape mid-drag writes nothing and leaves nothing ───────
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	const before = shape(await drawn(p));
	const stored = await p.evaluate(() => localStorage.getItem('daimond-layout'));
	const got = await carryTo(p, HEAD('spend'), await inPanel(p, 'work', 0.12));
	check('the drag was really under way when Escape was pressed',
		!!got.zone && got.ghost, JSON.stringify(got.zone && got.zone.kind));
	await p.keyboard.press('Escape');
	await p.waitForTimeout(300);
	await p.mouse.up();
	await p.waitForTimeout(300);
	const g = await drawn(p);
	check('Escape mid-drag moves nothing', JSON.stringify(shape(g)) === JSON.stringify(before),
		`${before.map((c) => c.join('+')).join(' | ')} → ${show(g)}`);
	check('and writes nothing',
		(await p.evaluate(() => localStorage.getItem('daimond-layout'))) === stored);
	check('and takes the ghost and the overlay away with it', await p.evaluate(() => {
		const o = document.getElementById('dock-drop');
		return !document.querySelector('.ptag-ghost') && !(o && !o.hidden)
			&& !document.body.classList.contains('dock-dragging');
	}));
}

// ── 12. presets: the view menu still works, and offers the way back ─────
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	await carryTo(p, HEAD('spend'), await inPanel(p, 'work', 0.12));
	await release(p);
	check('after a drag the engine calls the Dock custom',
		(await p.evaluate(() => window.DaimondPanels.grid())) === 'custom');
	await p.click('#settings-menu-btn');
	await p.waitForTimeout(400);
	const menu = await p.evaluate(() => ({
		pressed: [...document.querySelectorAll('#settings-menu .grid-opt')]
			.filter((b) => b.getAttribute('aria-pressed') === 'true')
			.map((b) => (b.querySelector('.cap') || {}).textContent),
		reset: [...document.querySelectorAll('#settings-menu .gal-row .nm')]
			.map((e) => e.textContent).filter((x) => /reset/i.test(x)),
	}));
	check('the tiling segment shows no preset pressed', menu.pressed.length === 0,
		menu.pressed.join(', ') || 'none');
	check('and one row offers the way back', menu.reset.length === 1, menu.reset.join(', '));
	await p.keyboard.press('Escape');
	await p.waitForTimeout(250);
	await p.evaluate(() => window.DaimondPanels.setGrid('2x2'));
	await p.waitForTimeout(500);
	const g = await drawn(p);
	check('choosing a preset redistributes round robin, exactly as it always did',
		g.grid === '2x2' && shape(g).length === 2
		&& Math.abs(shape(g)[0].length - shape(g)[1].length) <= 1, `${g.grid}: ${show(g)}`);
	check('and the browser agrees with it', agrees(g), show(g));
}

// ── 13. measurement: the acts each route takes ──────────────────────────
//
// Printed rather than asserted: what a number should be is not this file's to
// decide. What it IS, on this build, driven both ways, is.
let MEASURE = null;
{
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	const start = shape(await drawn(p));
	const want  = 'spend';

	// TODAY'S ROUTE. The old engine had one flat list in open order, seated
	// round robin, so moving the last panel to the first slot meant closing
	// every panel after the one you wanted and opening them again in the new
	// order. Driven here through the chips, which is the door a hand uses.
	const t0 = Date.now();
	let clicks = 0;
	for (const id of ['agents', 'mail', 'spend']) { await p.click(CHIP(id)); clicks++; await p.waitForTimeout(220); }
	for (const id of ['spend', 'mail', 'agents']) { await p.click(CHIP(id)); clicks++; await p.waitForTimeout(220); }
	const oldMs = Date.now() - t0;

	// THE NEW ROUTE: one drag.
	await seed(p, '2x2', ['work', 'mail', 'agents', 'spend']);
	const t1 = Date.now();
	await carryTo(p, HEAD(want), await inPanel(p, 'work', 0.12));
	await release(p);
	const newMs = Date.now() - t1;
	const g = await drawn(p);
	MEASURE = { clicks, oldMs, acts: 1, newMs, landed: show(g), start: start.map((c) => c.join('+')).join(' | ') };
	check('the one drag really did put it in the first slot',
		shape(g)[0] && shape(g)[0][0] === want, show(g));
}

// ── 14. mobile: the footer strip reorders by long press ─────────────────
//
// WebKit at 390x844 with touch, because the phone's engine is WebKit and a
// Chromium context given an iPhone's width is still a mouse.
//
// DRIVEN WITH POINTER EVENTS OF TYPE `touch`, dispatched into the page, and
// that is a real limit of this cell rather than a convenience. The recogniser
// arms its hold only for a pointer with no hover (`gesture.js` `coarse`), and
// Playwright's `mouse` reports `pointerType: 'mouse'` in every context, touch
// or not, while its `touchscreen` offers a tap and nothing that can be held and
// slid. So the events are made here, in the shape a finger makes them. What
// that cannot prove is the browser's own touch handling around them -- the
// scroll it would have started, the capture it would have taken -- and REAL
// TOUCH HARDWARE IS THEREFORE STILL UNVERIFIED for this path.
const TOUCH = `(sel, type, x, y) => {
	const el = document.elementFromPoint(x, y) || document.querySelector(sel);
	if (!el) return false;
	el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch',
		isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y,
		button: type === 'pointermove' ? -1 : 0,
		buttons: type === 'pointerup' ? 0 : 1 }));
	return true;
}`;
let phoneNote = null;
{
	let m = null;
	try {
		m = await open({ name: 'dockdrag-phone', connect: false, browser: 'webkit',
			touch: true, route: breaker,
			ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
				+ ' (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
		const q = m.page;
		await q.setViewportSize({ width: 390, height: 844 });
		await q.waitForTimeout(2400);
		const row = '#mnav #panel-tags';
		const chips = () => q.$$eval(row + ' .ptag[data-panel]', (es) => es.map((e) => e.dataset.panel));
		// SCROLLED INTO VIEW FIRST. The strip is its own sideways scroller and
		// holds fourteen chips in 390px, so most of them are off screen -- and a
		// point outside the viewport hits nothing, so the press would land on the
		// row rather than on a chip and claim nothing at all.
		const spot = async (id, f) => {
			const sel = row + ' .ptag[data-panel="' + id + '"]';
			await q.evaluate((sel) => {
				const e = document.querySelector(sel);
				if (e && e.scrollIntoView) e.scrollIntoView({ inline: 'center', block: 'nearest' });
			}, sel);
			await q.waitForTimeout(250);
			return q.evaluate(({ sel, f }) => {
				const e = document.querySelector(sel);
				if (!e) return null;
				const r = e.getBoundingClientRect();
				const at = { x: Math.round(r.x + r.width * f), y: Math.round(r.y + r.height / 2) };
				at.on = document.elementFromPoint(at.x, at.y) === e
					|| e.contains(document.elementFromPoint(at.x, at.y));
				return at;
			}, { sel, f: f === undefined ? 0.5 : f });
		};
		const touch = (type, at) => q.evaluate(
			new Function('a', `return (${TOUCH})(a.sel, a.type, a.x, a.y)`),
			{ sel: row, type, x: at.x, y: at.y });

		const first = await chips();
		check('the phone draws the chip row in the footer', first.length >= 4,
			first.slice(0, 8).join(', '));
		// WITHIN ONE ZONE GROUP. The row is grouped rail, stage, dock before it
		// is ordered, so a chip carried into another group could not be seated
		// there whatever was written down -- see `slotAt` in js/dockdrag.js.
		const group = await q.$$eval(row + ' .ptag-group[data-zone="dock"] .ptag[data-panel]',
			(es) => es.map((e) => e.dataset.panel));
		check('the dock chips are a group of their own on the phone', group.length >= 3,
			group.join(', '));

		// A SLIDE WITH NO HOLD is the strip being scrolled, and must move nothing.
		//
		// THE SAME JOURNEY THE HELD CHIP TAKES BELOW, less the hold: the same
		// chip, the same destination, the same release. A shorter nudge was what
		// this cell used to do, and it passed under `--break tapreorders` for a
		// reason that had nothing to do with the strip -- a chip carried from its
		// slot to "just before the next one" lands back where it started whether
		// or not it ever lifted. The control has to be able to fail.
		const a0 = await spot(group[0]);
		await touch('pointerdown', a0);
		const a1 = await spot(group[1]);
		await touch('pointermove', { x: a1.x, y: a1.y });
		const a2 = await spot(group[2], 0.8);
		await touch('pointermove', { x: a2.x, y: a2.y });
		await touch('pointerup', { x: a2.x, y: a2.y });
		await q.waitForTimeout(400);
		check('a slide with no hold scrolls the strip and reorders nothing',
			JSON.stringify(await chips()) === JSON.stringify(first),
			(await chips()).slice(0, 8).join(', '));

		// A HOLD, then a slide past two chips of its own group, then a release.
		const b = await spot(group[0]);
		check('the chip to be carried is really under the point pressed', !!(b && b.on),
			JSON.stringify(b));
		await touch('pointerdown', b);
		await q.waitForTimeout(550);                  // past the 350ms hold
		const lifted = await q.evaluate(() => !!document.querySelector('.ptag.lifted'));
		check('a long press lifts the chip', lifted);
		const c = await spot(group[2], 0.8);
		await touch('pointermove', { x: c.x, y: c.y });
		await q.waitForTimeout(250);
		const ins = await q.evaluate(() => !!document.querySelector('.ptag-ins'));
		check('and sliding shows an insertion line between the chips', ins);
		await touch('pointerup', { x: c.x, y: c.y });
		await q.waitForTimeout(600);
		const moved = await chips();
		const movedGroup = await q.$$eval(row + ' .ptag-group[data-zone="dock"] .ptag[data-panel]',
			(es) => es.map((e) => e.dataset.panel));
		check('the release reorders the strip',
			movedGroup.indexOf(group[0]) > 0 && JSON.stringify(movedGroup) !== JSON.stringify(group),
			`${group.join(', ')} → ${movedGroup.join(', ')}`);
		// The picture is taken HERE, of the strip as it now stands, rather than
		// after the reload below -- a reload raises the unlock gate over the whole
		// screen, and a screenshot of that says nothing about the row behind it.
		await shot(m, 'dockdrag-phone');
		await q.reload({ waitUntil: 'domcontentloaded' });
		await q.waitForTimeout(2800);
		const back = await chips();
		check('and the order survives a reload',
			JSON.stringify(back) === JSON.stringify(moved), back.slice(0, 8).join(', '));
		// And a tap is still a tap: it takes you to the panel, it does not move it.
		const order = await chips();
		const d = await spot(order[3]);
		await touch('pointerdown', d);
		await touch('pointerup', d);
		await q.evaluate(({ sel }) => {
			const e = document.querySelector(sel);
			if (e) e.click();
		}, { sel: row + ' .ptag[data-panel="' + order[3] + '"]' });
		await q.waitForTimeout(600);
		check('and a tap leaves the order exactly as it was',
			JSON.stringify(await chips()) === JSON.stringify(order),
			(await chips()).slice(0, 8).join(', '));
	} catch (e) {
		phoneNote = String(e && e.message ? e.message : e).split('\n')[0];
		check('the phone strip could be driven at all', false, phoneNote);
	} finally {
		if (m) { try { await m.close(); } catch (e) { /* gone */ } }
	}
}

// ── Nothing threw ───────────────────────────────────────────────────────
{
	await shot(s, 'dockdrag-final');
	const errs = errors(s).filter((e) => !/502|Bad Gateway|404|Failed to load resource/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'clean');
}

await s.close();

if (MEASURE) {
	console.log('\n── Acts to move the fourth panel of four into the first slot ──');
	console.log(`  from            ${MEASURE.start}`);
	console.log(`  today           ${MEASURE.clicks} clicks (close three, open three in the new order), ${MEASURE.oldMs}ms`);
	console.log(`  after           ${MEASURE.acts} drag (down, move, up), ${MEASURE.newMs}ms`);
	console.log(`  landed          ${MEASURE.landed}`);
	console.log('  and "Email above the Workspace in the same column" had no route at all,');
	console.log('  because a column\'s order was the open order and nothing else.');
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
