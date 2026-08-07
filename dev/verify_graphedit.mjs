// verify_graphedit.mjs — the Graph pane as an EDITOR, without losing the
// instrument.
//
// verify_graph.mjs proves that the picture is a faithful function of the link
// store.  Phase I let the user move the picture, which is exactly the change
// that could quietly destroy that property, so this is its sibling: it searches
// for the properties the redesign turns on rather than confirming that the
// script it was written beside still runs.
//
// The five properties, and why each is a property and not a feature:
//
//   1. DETERMINISM SURVIVES.  The same store draws the same picture -- captured,
//      reloaded, captured again, required equal.  Then a Diamond is dragged and
//      the SAME requirement is made of the new picture.  A drag that wrote
//      nothing would pass the first half and fail the second; a drag that wrote
//      something unstable would fail the first half after it.
//   2. EVERY MODE IS ESCAPABLE.  Link mode, the context menu and the link form
//      are each entered and then left, by Escape AND by the pointer.  A mode
//      with no way out is the one-way door dev/verify_reversible.mjs exists for.
//   3. ORGANISE IS HONEST.  Run twice from one state it gives one arrangement,
//      and it loses neither a Diamond nor a link.
//   4. A CYCLE IS STILL DRAWN.  After a drag and after an organise, the closing
//      edge is still dashed and the Diamonds on the cycle are still badged.
//      Making a cycle visible is the whole point of the instrument and is the
//      first thing a canvas would be tempted to tidy away.
//   5. NOTHING IS LOST.  A Diamond with no stored position still appears, and a
//      deleted Diamond does not leave its coordinates behind for ever.
//
// The fixture, built through the real wasm in one browser profile:
//
//        Alpha ──feeds──▶ Bravo ──feeds──▶ Charlie
//          ▲                                  │
//          └────────── closes ────────────────┘        (a cycle, drawn dashed)
//        Delta ──notes──▶ Echo                         (a separate pair)
//        Foxtrot — linked to nothing                   (the unlinked band)
//
// Run with a world up:
//   eval "$(bash dev/world.sh 6 --up)" && node dev/verify_graphedit.mjs
//
// No gateway: the pane draws from OPFS and asks the network for nothing.

import fs from 'node:fs';
import { open, shot, errors, signInAs, scratch } from './harness.mjs';

const out = [];
let bad = 0;
const check = (ok, what) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
	console.log(`${ok ? '  ok   ' : '  FAIL '}${what}`);
	if (!ok) bad++;
};

const PROFILE = scratch('graphedit-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'graphedit', connect: false, profile: PROFILE, defaults: false });
const { page } = s;
await page.waitForTimeout(2500);

/// Reach the real wasm directly.  A fresh `DaimondApp` shares the page's OPFS,
/// so this is the store the pane is reading, not a copy of it.
const wasm = (fn, arg) => page.evaluate(async ({ src, arg }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', 'arg', `return (${src})(app, arg);`))(app, arg);
}, { src: fn.toString(), arg });

// ── The fixture ──────────────────────────────────────────────────
const fx = await wasm(async (app) => {
	const mk = (n) => app.create_diamond(n);
	const A = await mk('Alpha'), B = await mk('Bravo'), C = await mk('Charlie');
	const D = await mk('Delta'), E = await mk('Echo'), F = await mk('Foxtrot');
	const ln = (owner, from, to, rel) => app.add_link(owner, 'diamond:' + from, 'diamond:' + to, rel, '', 'user');
	const L = {};
	L.ab = await ln(A, A, B, 'feeds');
	L.bc = await ln(B, B, C, 'feeds');
	L.ca = await ln(C, C, A, 'closes');      // the closing edge
	L.de = await ln(D, D, E, 'notes');
	return { id: { A, B, C, D, E, F }, L };
});
const id = fx.id, L = fx.L;
const nameOf = {};
[['A', 'Alpha'], ['B', 'Bravo'], ['C', 'Charlie'], ['D', 'Delta'],
 ['E', 'Echo'], ['F', 'Foxtrot']].forEach(([k, n]) => { nameOf[id[k]] = n; });
check(Object.values(id).every(Boolean) && Object.values(L).every(Boolean),
	`fixture built: 6 Diamonds, 4 links, one three-Diamond cycle`);

// ── Driving the pane ─────────────────────────────────────────────

/// Shut the Admin drawer, which opens by itself on a profile with no model
/// connected. In a wide window it sits beside the stage and is harmless; in a
/// narrow one it lies over it, and a gesture aimed at the picture would land on
/// one of its pulldowns instead.
async function closeDrawer() {
	await page.evaluate(() => {
		const x = document.getElementById('admin-close');
		if (x && x.getClientRects().length) x.click();
	});
	await page.waitForTimeout(250);
}

async function draw() {
	await closeDrawer();
	await page.evaluate(() => {
		DaimondPanels.show('graph');
		if (window.DaimondGraph) DaimondGraph.refresh();
	});
	await page.waitForTimeout(900);
}

/// The picture as plain data: where every box is, what every line's `d` is, and
/// which of them are marked.  This is the geometry the determinism checks
/// compare, so it holds coordinates and nothing that could differ for a reason
/// that does not matter (an id, a tooltip, the order the browser enumerated).
const geom = () => page.evaluate(() => {
	const svg = document.querySelector('#graph-body svg#graph-svg');
	if (!svg) return null;
	const at = (tr) => {
		const m = /translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(tr || '');
		return m ? [+m[1], +m[2]] : null;
	};
	return {
		box: svg.getAttribute('viewBox'),
		nodes: [...svg.querySelectorAll('g.graph-nodes > g.graph-node')].map(g => ({
			id: g.dataset.diamondId,
			at: at(g.getAttribute('transform')),
			cycled: g.classList.contains('cycled'),
			isolate: g.classList.contains('isolate'),
			placed: g.classList.contains('placed'),
			badge: !!g.querySelector('g.graph-cycle'),
		})).sort((a, b) => (a.id < b.id ? -1 : 1)),
		edges: [...svg.querySelectorAll('g.graph-edges > g.graph-edge')].map(g => ({
			id: g.dataset.linkId, from: g.dataset.from, to: g.dataset.to,
			back: g.classList.contains('back'),
			d: (g.querySelector('path.graph-edge-line') || {}).getAttribute
				? g.querySelector('path.graph-edge-line').getAttribute('d') : null,
			dash: getComputedStyle(g.querySelector('path.graph-edge-line')).strokeDasharray,
			label: (g.querySelector('text.graph-edge-label') || {}).textContent ?? null,
		})).sort((a, b) => (a.id < b.id ? -1 : 1)),
		band: (svg.querySelector('text.graph-band') || {}).textContent ?? null,
		live: svg.querySelectorAll('g.graph-live path').length,
	};
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/// The layout as it is actually stored, read from outside the app.
const stored = () => page.evaluate(() => {
	try { return JSON.parse(localStorage.getItem('daimond-graph') || 'null'); }
	catch { return null; }
});

/// Where a Diamond's box is on screen, so the pointer can be aimed at it.
const boxAt = (did) => page.evaluate((d) => {
	const g = document.querySelector(`g.graph-node[data-diamond-id="${d}"] rect.graph-node-box`);
	if (!g) return null;
	const r = g.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
}, did);

/// A point inside the picture that is over NOTHING -- no box, no line.  Found
/// by asking the document what is under it rather than by guessing, because a
/// guess that happened to land on a node would make "clicking empty space
/// cancels" pass for the wrong reason.
const emptyPoint = () => page.evaluate(() => {
	const svg = document.querySelector('#graph-body svg#graph-svg');
	if (!svg) return null;
	const r = svg.getBoundingClientRect();
	for (let y = r.top + 6; y < Math.min(r.bottom, innerHeight) - 6; y += 7) {
		for (let x = r.left + 4; x < Math.min(r.right, innerWidth) - 4; x += 11) {
			const el = document.elementFromPoint(x, y);
			if (!el) continue;
			if (el.closest('.graph-node') || el.closest('.graph-edge')) continue;
			if (!svg.contains(el) && el !== svg) continue;
			return { x, y };
		}
	}
	return null;
});

/// Drag a Diamond by a delta, the way a hand does it: press, move in steps so
/// the module sees the gesture grow, release.
async function dragBy(did, dx, dy) {
	const b = await boxAt(did);
	if (!b) throw new Error('no box for ' + did);
	await page.mouse.move(b.x, b.y);
	await page.mouse.down();
	for (let i = 1; i <= 5; i++) await page.mouse.move(b.x + (dx * i) / 5, b.y + (dy * i) / 5);
	await page.mouse.up();
	await page.waitForTimeout(500);
	return b;
}

/// Sign back in and reopen the pane, which is what a reload costs here.
async function reload() {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'graphedit');
	await page.waitForTimeout(1400);
	await draw();
}

await draw();
let g0 = await geom();
check(!!g0 && g0.nodes.length === 6 && g0.edges.length === 4,
	`the pane drew the fixture: ${g0 ? g0.nodes.length : 0} node(s), ${g0 ? g0.edges.length : 0} edge(s)`);
await shot(s, 'graphedit-1-fixture');

// ── 1. Determinism, before anything has been moved ───────────────
await reload();
const g1 = await geom();
check(same(g0, g1), `the same store draws the same geometry across a reload`
	+ (same(g0, g1) ? '' : ` — ${JSON.stringify(g0.nodes)} vs ${JSON.stringify(g1.nodes)}`));
const pre = await stored();
check(!pre || !pre.pos || Object.keys(pre.pos).length === 0,
	`nothing is stored until something is moved: ${JSON.stringify(pre && pre.pos)}`);

// ── 2. A drag is written down, and the new picture is deterministic ──
const before = (await geom()).nodes.find(n => n.id === id.B).at;
await dragBy(id.B, 150, -60);
const afterDrag = await geom();
const movedNode = afterDrag.nodes.find(n => n.id === id.B);
check(!same(movedNode.at, before) && movedNode.placed,
	`dragging Bravo moved it and marked it placed: ${JSON.stringify(before)} → ${JSON.stringify(movedNode.at)}`);
const rec = await stored();
check(!!(rec && rec.pos && rec.pos[id.B]
	&& rec.pos[id.B].x === movedNode.at[0] && rec.pos[id.B].y === movedNode.at[1]
	&& typeof rec.pos[id.B].t === 'number' && rec.pos[id.B].t > 0),
	`and the coordinates are in the store, stamped: ${JSON.stringify(rec && rec.pos && rec.pos[id.B])}`);
const wrote = (rec && rec.pos) ? Object.keys(rec.pos) : [];
check(wrote.length === 1,
	`only the Diamond that was dragged was written: ${JSON.stringify(wrote.map(x => nameOf[x]))}`);
// The Diamonds that were NOT dragged must not have moved, or a drag would be a
// re-layout wearing a drag's clothes.
check(afterDrag.nodes.length === g1.nodes.length,
	`every Diamond still has a node after the drag: ${afterDrag.nodes.length} of ${g1.nodes.length}`
	+ (afterDrag.nodes.length === g1.nodes.length ? ''
		: ` — missing ${JSON.stringify(g1.nodes.filter(n => !afterDrag.nodes.some(m => m.id === n.id))
			.map(n => nameOf[n.id]))}`));
const strayed = g1.nodes.filter(n => n.id !== id.B).filter(n => {
	const now = afterDrag.nodes.find(m => m.id === n.id);
	return !now || !same(n.at, now.at);
});
check(strayed.length === 0, `and no other Diamond moved when Bravo did`
	+ (strayed.length ? ` — ${JSON.stringify(strayed.map(n => nameOf[n.id]))}` : ''));
await shot(s, 'graphedit-2-dragged');

// A press and a sweep is a drag.  To the browser it is also a TEXT SELECTION,
// and a picture left striped in highlight is both ugly and a state a later
// click acts inside.  Read WHILE THE BUTTON IS STILL DOWN: the drop redraws the
// picture, which destroys the selected nodes and takes the evidence with it, so
// a check made afterwards would pass on a pane that stripes itself every time.
{
	const from = await boxAt(id.A);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + 20 * i, from.y + 26 * i);
	const swept = await page.evaluate(() => String(window.getSelection() || ''));
	await page.keyboard.press('Escape');          // put it back; this is only a probe
	await page.mouse.up();
	await page.waitForTimeout(400);
	check(swept === '', `a drag across the picture selects no text: ${JSON.stringify(swept.slice(0, 70))}`);
	const stray = await stored();
	check(!(stray && stray.pos && stray.pos[id.A]),
		`and the drag Escape abandoned wrote nothing: ${JSON.stringify(stray && stray.pos && stray.pos[id.A])}`);
}

await reload();
const g2 = await geom();
check(same(afterDrag, g2), `the dragged picture survives a reload identically`
	+ (same(afterDrag, g2) ? '' : ` — Bravo at ${JSON.stringify(afterDrag.nodes.find(n => n.id === id.B).at)}`
		+ ` then ${JSON.stringify(g2.nodes.find(n => n.id === id.B).at)}`));
check(!same(g1, g2), `and it is NOT the picture before the drag — the store really changed`);

// ── 3. A cycle is still drawn and badged after a drag ────────────
const cycleOf = (g) => ({
	dashed: g.edges.filter(e => e.back).map(e => e.id).sort(),
	badged: g.nodes.filter(n => n.cycled && n.badge).map(n => n.id).sort(),
});
const c1 = cycleOf(g1), c2 = cycleOf(g2);
check(c1.dashed.length === 1 && c1.dashed[0] === L.ca && c1.badged.length === 3,
	`before the drag: one dashed closing edge, three badged Diamonds — `
	+ `${c1.badged.map(x => nameOf[x]).join(',')}`);
check(same(c1, c2), `after the drag the cycle is drawn and badged exactly as before: `
	+ `${JSON.stringify({ dashed: c2.dashed.length, badged: c2.badged.map(x => nameOf[x]) })}`);
check(g2.edges.filter(e => e.back).every(e => /\d/.test(e.dash || '') && e.dash !== 'none'),
	`and the closing edge is still DASHED, not merely classed: ${JSON.stringify(g2.edges.find(e => e.back).dash)}`);

// ── 4. The arrowhead lands on the box, not in it ─────────────────
//
// Two properties of the routing, checked after the ordinary drag and again
// after a drag that puts a target ABOVE its source -- which auto-layout can
// never produce, and which is therefore the case a layered router was never
// asked about.
async function routingChecks(when) {
const onPerimeter = await page.evaluate(() => {
	const W = 176, H = 44, EPS = 0.6;
	const at = (g) => {
		const m = /translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(g.getAttribute('transform') || '');
		return m ? { x: +m[1], y: +m[2] } : null;
	};
	const pos = {};
	document.querySelectorAll('g.graph-node').forEach(g => { pos[g.dataset.diamondId] = at(g); });
	const bad = [];
	document.querySelectorAll('g.graph-edge').forEach(g => {
		const d = g.querySelector('path.graph-edge-line').getAttribute('d');
		const m = /\s(-?[\d.]+),(-?[\d.]+)$/.exec(d);
		if (!m) { bad.push([g.dataset.linkId, 'unreadable']); return; }
		const x = +m[1], y = +m[2], b = pos[g.dataset.to];
		if (!b) { bad.push([g.dataset.linkId, 'no target box']); return; }
		const inX = x >= b.x - EPS && x <= b.x + W + EPS;
		const inY = y >= b.y - EPS && y <= b.y + H + EPS;
		const onV = Math.abs(y - b.y) < EPS || Math.abs(y - (b.y + H)) < EPS;
		const onH = Math.abs(x - b.x) < EPS || Math.abs(x - (b.x + W)) < EPS;
		// A closing edge lands on the right-hand side, which onH covers.
		if (!((inX && onV) || (inY && onH))) bad.push([g.dataset.linkId, `(${x},${y}) vs box ${b.x},${b.y}`]);
	});
	return bad;
});
const nEdges = await page.evaluate(() => document.querySelectorAll('g.graph-edge').length);
check(onPerimeter.length === 0,
	`${when}: every arrowhead lands on the edge of the box it points at: `
	+ (onPerimeter.length ? JSON.stringify(onPerimeter) : `${nEdges} edge(s) checked`));

// And it approaches from the right SIDE of the box.  Landing on the perimeter
// is not enough: the layered routing leaves the bottom of the source and enters
// the top of the target, and once a drag has put the target ABOVE its source
// that same routing draws a line going up out of the bottom of one box and into
// the top of the other -- both endpoints still perfectly on a perimeter, and the
// line doubling back across both boxes to get there.  So an edge whose target is
// above its source must NOT leave through the source's bottom edge.
const wrongSide = await page.evaluate(() => {
	const W = 176, H = 44, EPS = 0.6;
	const at = (g) => {
		const m = /translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(g.getAttribute('transform') || '');
		return m ? { x: +m[1], y: +m[2] } : null;
	};
	const pos = {};
	document.querySelectorAll('g.graph-node').forEach(g => { pos[g.dataset.diamondId] = at(g); });
	const bad = [];
	document.querySelectorAll('g.graph-edge:not(.back)').forEach(g => {
		const d = g.querySelector('path.graph-edge-line').getAttribute('d');
		const m = /^M(-?[\d.]+),(-?[\d.]+)/.exec(d);
		const a = pos[g.dataset.from], b = pos[g.dataset.to];
		if (!m || !a || !b) return;
		const y0 = +m[2];
		const above = (b.y + H / 2) <= (a.y + H / 2);
		const leftTheBottom = Math.abs(y0 - (a.y + H)) < EPS;
		if (above && leftTheBottom) bad.push([g.dataset.linkId, `target above, yet the line leaves y=${y0} which is the source's bottom (${a.y + H})`]);
	});
	return bad;
});
check(wrongSide.length === 0,
	`${when}: and no line goes UP out of the bottom of the box it starts at: `
	+ (wrongSide.length ? JSON.stringify(wrongSide) : `${nEdges} edge(s) checked`));
}
await routingChecks('after a sideways drag');

// Now the case auto-layout cannot make: Charlie pulled up above Bravo, which it
// points back at, so the B → C link runs upwards.
const cBox = await boxAt(id.C);
await dragBy(id.C, -90, -(cBox.y - 200));
const flipped = await geom();
const cy = flipped.nodes.find(n => n.id === id.C).at[1];
const by = flipped.nodes.find(n => n.id === id.B).at[1];
check(cy < by, `Charlie can be dragged above Bravo, which points at it: Charlie y=${cy}, Bravo y=${by}`);

await shot(s, 'graphedit-2b-flipped');
await routingChecks('with a target above its source');
// And the cycle is still a cycle when the picture has been turned upside down.
const cFlip = cycleOf(flipped);
check(cFlip.dashed.length === 1 && cFlip.badged.length === 3,
	`and the cycle survives being turned upside down: `
	+ `${cFlip.dashed.length} dashed, ${cFlip.badged.map(x => nameOf[x]).join(',')}`);
// Put it back, so what follows starts from the picture the earlier checks left.
await page.evaluate((d) => {
	const l = JSON.parse(localStorage.getItem('daimond-graph'));
	delete l.pos[d];
	localStorage.setItem('daimond-graph', JSON.stringify(l));
}, id.C);
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'graphedit');
await page.waitForTimeout(1400);
await draw();

// ── 5. Link mode is escapable, twice over ────────────────────────
const linkArmed = () => page.evaluate(() =>
	!!document.querySelector('#graph-link-btn.on'));
const liveLines = () => page.evaluate(() =>
	document.querySelectorAll('#graph-body g.graph-live path.graph-live-line').length);

// Each probe ARMS the mode outright rather than pressing the toggle, and
// asserts it is armed before trying to leave. A toggle pressed twice after a
// failed escape leaves the mode OFF, and the next probe would then pass by
// having nothing to escape from -- which is how a way-out check quietly stops
// checking anything.
const arm = async () => {
	await page.evaluate(() => DaimondGraph.linkMode(true));
	await page.waitForTimeout(250);
	return await linkArmed();
};
check(await arm(), `the Link mode arms, and the control shows it`);
await page.click('#graph-link-btn', { force: true });
await page.waitForTimeout(250);
check(!(await linkArmed()), `the Link control disarms it again`);

check(await arm(), `armed again for the Escape probe`);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(!(await linkArmed()), `Escape leaves it`);

check(await arm(), `armed again for the pointer probe`);
// Pick a source, so the mode is in its DEEPER state -- half a link drawn is the
// state a way out is most needed from, and the one most easily forgotten.
let b = await boxAt(id.A);
await page.mouse.click(b.x, b.y);
await page.waitForTimeout(300);
await page.mouse.move(b.x + 90, b.y + 70);
await page.waitForTimeout(200);
const live = await liveLines();
check(live === 1, `with a source picked, one live arrow follows the pointer: ${live} drawn`);
await shot(s, 'graphedit-3-linkmode');
const empty = await emptyPoint();
check(!!empty, `found a point over nothing to click: ${JSON.stringify(empty)}`);
await page.mouse.click(empty.x, empty.y);
await page.waitForTimeout(400);
check(!(await linkArmed()) && (await liveLines()) === 0,
	`clicking empty space leaves link mode and takes the arrow with it`);

// And the arrow was never anything but pointer feedback.
await reload();
check((await geom()).live === 0 && !JSON.stringify(await stored()).includes('live'),
	`nothing about the live arrow was stored: the reloaded picture has no live layer content`);

// ── 6. The context menu is escapable, twice over ─────────────────
const menuUp = () => page.evaluate(() => {
	const m = document.getElementById('graph-menu');
	return !!(m && m.getClientRects().length);
});
b = await boxAt(id.C);
await page.mouse.click(b.x, b.y, { button: 'right' });
await page.waitForTimeout(300);
check(await menuUp(), `right-clicking a Diamond opens a menu`);
const items = await page.evaluate(() =>
	[...document.querySelectorAll('#graph-menu .graph-menu-item')].map(x => x.textContent));
check(items.some(x => /organise/i.test(x)), `and it carries Organise: ${JSON.stringify(items)}`);
await shot(s, 'graphedit-4-menu');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(!(await menuUp()), `Escape closes the menu`);

await page.mouse.click(b.x, b.y, { button: 'right' });
await page.waitForTimeout(300);
const e2 = await emptyPoint();
await page.mouse.click(e2.x, e2.y);
await page.waitForTimeout(300);
check(!(await menuUp()), `and so does clicking away from it`);

// ── 7. Clicking a link edits it, and the form is escapable ───────
const formUp = () => page.evaluate(() => {
	const f = document.getElementById('graph-edit');
	return !!(f && f.getClientRects().length);
});
/// A point on a drawn link's line that the pointer can actually reach.
///
/// Not simply the midpoint: the pane scrolls, so a midpoint can be under the
/// panel's head or off the bottom of the window, and a click there would land
/// on something else entirely and report "the form did not open" for a reason
/// that has nothing to do with the form. So several fractions along the line
/// are tried and the first one the DOCUMENT agrees is over that link is
/// returned, with what it found instead when none is.
const edgeAt = (lid) => page.evaluate((l) => {
	const p = document.querySelector(`g.graph-edge[data-link-id="${l}"] path.graph-edge-line`);
	if (!p) return { err: 'no such edge drawn' };
	const svg = p.ownerSVGElement;
	const r = svg.getBoundingClientRect();
	const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
	const tried = [];
	for (const f of [0.5, 0.4, 0.6, 0.3, 0.7, 0.25, 0.75]) {
		const pt = p.getPointAtLength(p.getTotalLength() * f);
		const x = r.left + pt.x * (r.width / vb[2]);
		const y = r.top + pt.y * (r.height / vb[3]);
		if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) { tried.push([f, 'off screen']); continue; }
		const el = document.elementFromPoint(x, y);
		const g = el && el.closest ? el.closest('g.graph-edge') : null;
		if (g && g.dataset.linkId === l) return { x, y };
		tried.push([f, el ? el.tagName + '.' + (el.getAttribute('class') || '') : 'nothing']);
	}
	return { err: 'no reachable point on the line: ' + JSON.stringify(tried) };
}, lid);

let ep = await edgeAt(L.de);
check(!ep.err, `the Delta → Echo line is reachable by a pointer: ${ep.err || JSON.stringify(ep)}`);
await page.mouse.click(ep.x, ep.y);
await page.waitForTimeout(400);
check(await formUp(), `clicking a link opens its form`);
const rel0 = await page.evaluate(() => (document.getElementById('graph-edit-rel') || {}).value);
check(rel0 === 'notes', `pre-filled with the link's own relation: ${JSON.stringify(rel0)}`);
await shot(s, 'graphedit-5-linkform');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
check(!(await formUp()), `Escape closes the form and the link is untouched`);

ep = await edgeAt(L.de);
await page.mouse.click(ep.x, ep.y);
await page.waitForTimeout(400);
await page.click('#graph-edit-cancel', { force: true, timeout: 8000 });
await page.waitForTimeout(300);
check(!(await formUp()), `and so does its own Cancel`);

// Now really edit it.
ep = await edgeAt(L.de);
await page.mouse.click(ep.x, ep.y);
await page.waitForTimeout(400);
await page.fill('#graph-edit-rel', 'supersedes');
await page.fill('#graph-edit-note', 'changed by the verifier');
await page.click('#graph-edit-ok', { force: true });
await page.waitForTimeout(1000);
const edited = JSON.parse(await wasm(async (app) => await app.all_links()))
	.filter(l => l.from.endsWith(id.D) && l.to.endsWith(id.E));
check(edited.length === 1 && edited[0].rel === 'supersedes' && edited[0].note === 'changed by the verifier',
	`saving writes the new relation and note to the STORE, and leaves one link not two: `
	+ JSON.stringify(edited.map(l => [l.rel, l.note])));
const drawnRel = (await geom()).edges.find(e => e.from === id.D && e.to === id.E);
check(drawnRel && drawnRel.label === 'supersedes',
	`and the picture says so without a reload: ${JSON.stringify(drawnRel && drawnRel.label)}`);

// ── 8. A link drawn by clicking two Diamonds ─────────────────────
const linksNow = () => wasm(async (app) => await app.all_links()).then(x => JSON.parse(x));
const nLinks = (await linksNow()).length;
await page.click('#graph-link-btn', { force: true });
await page.waitForTimeout(250);
b = await boxAt(id.F);
await page.mouse.click(b.x, b.y);
await page.waitForTimeout(300);
let b2 = await boxAt(id.E);
await page.mouse.click(b2.x, b2.y);
await page.waitForTimeout(500);
check(await formUp(), `clicking a source then a target offers the new link's form`);
await page.fill('#graph-edit-rel', 'mentions');
await page.click('#graph-edit-ok', { force: true });
await page.waitForTimeout(1200);
const made = (await linksNow()).filter(l => l.from === 'diamond:' + id.F && l.to === 'diamond:' + id.E);
check(made.length === 1 && made[0].rel === 'mentions',
	`and the link is asserted from Foxtrot to Echo: ${JSON.stringify(made.map(l => l.rel))}`);
check((await linksNow()).length === nLinks + 1,
	`exactly one link was added: ${nLinks} → ${(await linksNow()).length}`);
check(!(await linkArmed()), `and the mode let go of itself once the link was drawn`);

// ── 9. Organise: twice from one state is once ────────────────────
await draw();
const gBeforeOrg = await geom();
await page.evaluate(() => DaimondGraph.organise());
await page.waitForTimeout(700);
const gOrg1 = await geom();
const posOrg1 = ((await stored()) || {}).pos || {};
await page.evaluate(() => DaimondGraph.organise());
await page.waitForTimeout(700);
const gOrg2 = await geom();
const posOrg2 = ((await stored()) || {}).pos || {};
const xy = (p) => Object.keys(p).sort().map(k => `${k}:${p[k].x},${p[k].y}`).join('|');
check(xy(posOrg1) === xy(posOrg2),
	`organising twice from one state writes one arrangement: ${Object.keys(posOrg1).length} position(s)`
	+ (xy(posOrg1) === xy(posOrg2) ? ', identical'
		: `\n        once:  ${xy(posOrg1)}\n        twice: ${xy(posOrg2)}`));
check(same(gOrg1, gOrg2), `and draws one picture`);
check(gOrg1.nodes.length === gBeforeOrg.nodes.length && gOrg1.edges.length === gBeforeOrg.edges.length,
	`organise loses neither a Diamond nor a link: ${gBeforeOrg.nodes.length}/${gBeforeOrg.edges.length}`
	+ ` → ${gOrg1.nodes.length}/${gOrg1.edges.length}`);
check(gOrg1.nodes.every(n => n.placed),
	`and it WROTE the arrangement rather than merely drawing it: `
	+ `${gOrg1.nodes.filter(n => n.placed).length}/${gOrg1.nodes.length} marked placed`);
await shot(s, 'graphedit-6-organised');

// The cycle again, after organise.
const c3 = cycleOf(gOrg1);
check(c3.dashed.length === 1 && c3.dashed[0] === L.ca && c3.badged.length === 3,
	`after organise the cycle is still drawn dashed and still badged: `
	+ `${c3.badged.map(x => nameOf[x]).join(',')}`);

// And the organised picture reloads identically, which is the whole claim.
await reload();
check(same(gOrg1, await geom()), `the organised picture survives a reload identically`);

// ── 10. Nothing is lost ──────────────────────────────────────────
const fresh = await wasm(async (app) => await app.create_diamond('Golf'));
await draw();
const gNew = await geom();
const golf = gNew.nodes.find(n => n.id === fresh);
check(!!golf && !golf.placed && golf.at && golf.at[1] > 0,
	`a Diamond made AFTER an organise has no stored position and is still drawn: `
	+ `${golf ? JSON.stringify(golf.at) : 'absent'}`);
const afterFresh = await stored();
check(!(afterFresh && afterFresh.pos && afterFresh.pos[fresh]),
	`and nothing was invented for it in the store`);

await wasm(async (app, a) => await app.delete_diamond(a), id.F);
await draw();
await page.waitForTimeout(400);
const afterDelete = await stored();
check(!(afterDelete && afterDelete.pos && afterDelete.pos[id.F]),
	`deleting Foxtrot took its stored position with it: `
	+ `${Object.keys(afterDelete.pos).length} position(s) left, for `
	+ `${(await geom()).nodes.length} Diamond(s)`);
check(Object.keys((afterDelete && afterDelete.pos) || {}).every(k => (gNew.nodes.some(n => n.id === k) && k !== id.F)),
	`and no position is left for a Diamond that is not drawn`);

// ── 11. Middle-drag pans, and the pan is remembered ──────────────
//
// In a window big enough to hold the whole picture there is nothing to pan, and
// a check made there would pass on a module that had never implemented panning
// at all.  So the window is made too small on purpose first, and the room to
// scroll is asserted before the gesture is made.
await page.setViewportSize({ width: 880, height: 560 });
await page.waitForTimeout(500);
await draw();
const room = await page.evaluate(() => {
	const b = document.getElementById('graph-body');
	return { x: b.scrollWidth - b.clientWidth, y: b.scrollHeight - b.clientHeight };
});
check(room.x > 20 && room.y > 20, `the picture is bigger than the window, so there is something to pan: `
	+ JSON.stringify(room));

// A point the DOCUMENT agrees is over the picture. The centre of the body is
// not good enough: with no model connected the Admin drawer stands open over
// the stage, and a gesture that began on a pulldown would report "panning does
// not work" about a control it never reached.
const bodyBox = await emptyPoint();
check(!!bodyBox, `found a point over the picture to start the pan from: ${JSON.stringify(bodyBox)}`);
await page.mouse.move(bodyBox.x, bodyBox.y);
await page.mouse.down({ button: 'middle' });
for (let i = 1; i <= 6; i++) await page.mouse.move(bodyBox.x - (60 * i) / 6, bodyBox.y - (40 * i) / 6);
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(600);
const panned = await page.evaluate(() => {
	const b = document.getElementById('graph-body');
	return { x: Math.round(b.scrollLeft), y: Math.round(b.scrollTop) };
});
check(panned.x > 0 && panned.y > 0, `a middle-drag pans the view: ${JSON.stringify(panned)}`);
const panRec = await stored();
check(!!(panRec && panRec.pan) && panRec.pan.x === panned.x && panRec.pan.y === panned.y,
	`and where it was left is written down: ${JSON.stringify(panRec && panRec.pan)}`);
await reload();
const panBack = await page.evaluate(() => {
	const b = document.getElementById('graph-body');
	return { x: Math.round(b.scrollLeft), y: Math.round(b.scrollTop) };
});
check(panBack.x === panned.x && panBack.y === panned.y,
	`and it comes back there after a reload: ${JSON.stringify(panBack)} (was ${JSON.stringify(panned)})`);
await shot(s, 'graphedit-8-panned');
await page.setViewportSize({ width: 1500, height: 950 });
await page.waitForTimeout(400);

// ── 12. The pair the sync parcel needs ───────────────────────────
//
// graph.js does not touch sync.js -- another agent owns it -- so what is checked
// here is the CONTRACT it is offering: a snapshot that is the same bytes twice
// running (which is what the push-skip in sync.js rests on: a section that
// serialised in enumeration order would push for ever), and an adopt that moves
// on a newer stamp, refuses an older one, and settles on a second application
// of the same record.
const snapTwice = await page.evaluate(() => [
	JSON.stringify(DaimondGraph.snapshot()), JSON.stringify(DaimondGraph.snapshot())]);
check(snapTwice[0] === snapTwice[1] && snapTwice[0].length > 20,
	`two snapshots with nothing between them are the same bytes: ${snapTwice[0].length} chars`);
const snapKeys = await page.evaluate(() => Object.keys(DaimondGraph.snapshot().pos));
check(snapKeys.length > 1 && snapKeys.every((k, i) => i === 0 || snapKeys[i - 1] < k),
	`the snapshot's Diamonds are in sorted order, not the order storage enumerated: `
	+ `${snapKeys.length} key(s)${snapKeys.every((k, i) => i === 0 || snapKeys[i - 1] < k) ? '' : ' — ' + JSON.stringify(snapKeys)}`);
check(!snapTwice[0].includes('"pan"'),
	`and the snapshot carries no pan — a scroll offset is this window's, not this account's`);

const adoption = await page.evaluate((d) => {
	const before = DaimondGraph.snapshot();
	const mine = before.pos[d];
	const newer = { v: 1, pos: { [d]: { x: 999, y: 777, t: (mine ? mine.t : 0) + 5000 } } };
	const took = DaimondGraph.adopt(newer);
	const after = DaimondGraph.snapshot().pos[d];
	const again = DaimondGraph.adopt(newer);
	const older = DaimondGraph.adopt({ v: 1, pos: { [d]: { x: 1, y: 1, t: 1 } } });
	const end = DaimondGraph.snapshot().pos[d];
	return { mine, took, after, again, older, end };
}, id.A);
check(adoption.took === true && adoption.after.x === 999 && adoption.after.y === 777,
	`a newer position from another device is taken: ${JSON.stringify(adoption.after)}`);
check(adoption.again === false,
	`the same record applied twice changes nothing — no stamp moves, so the round after a `
	+ `convergence is quiet`);
check(adoption.older === false && adoption.end.x === 999,
	`and an older position is refused: ${JSON.stringify(adoption.end)}`);
await page.waitForTimeout(900);          // adopt redraws through the ordinary refresh
const drawnAfterAdopt = (await geom()).nodes.find(n => n.id === id.A);
check(!!drawnAfterAdopt && drawnAfterAdopt.at[0] === 999 && drawnAfterAdopt.at[1] === 777,
	`and the picture redrew itself where the other device put it: `
	+ `${JSON.stringify(drawnAfterAdopt && drawnAfterAdopt.at)}`);

// ── 13. Nothing threw ────────────────────────────────────────────
const gatewayNoise = /(401 \(Unauthorized\)|402 \(Payment Required\)|502 \(Bad Gateway\))/;
const errs = errors(s).filter(e => !gatewayNoise.test(e));
check(errs.length === 0, `no console errors beyond the gateway's answer: ${JSON.stringify(errs.slice(0, 3))}`);

await shot(s, 'graphedit-7-final');
await s.close();

console.log('\n' + out.join('\n'));
console.log(bad === 0 ? `\nALL ${out.length} CHECKS PASSED` : `\n${bad} of ${out.length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
