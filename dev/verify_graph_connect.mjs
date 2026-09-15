// verify_graph_connect.mjs — joining two Diamonds is ONE gesture, and the picture
// is still a function of the store.
//
// `verify_graph.mjs` proves the picture is faithful to the link store and
// `verify_graphedit.mjs` proves the editor did not cost that.  This is phase 1 of
// the Map: the owner's sentence was "I can click and drag a tile but joining them
// is not easy; connector anchors should appear as the mouse hovers over the
// edges."  So what is proved here is the GESTURE — that the anchors appear where
// a hand reaches for them and nowhere else, that a dragged link snaps to a port
// within 24 screen pixels and not at 30, that letting go writes one link with the
// ends the hand chose and no relation, that the relation is then OFFERED rather
// than demanded, that letting go over empty canvas makes a Diamond already linked
// — and the three properties a gesture is most likely to cost: that no gesture
// rebuilds the picture, that the arrangement survives a reload, and that a line
// never runs back under the boxes it joins.
//
// AND THE NUMBER.  The last section connects two Diamonds twice over, once by the
// route that existed before this work (arm Link, click, click, Create) and once by
// the drag, and prints what each cost.  "Joining is not easy" is a complaint about
// a cost, and a claim to have fixed it that carries no measurement is an opinion.
// The columns that matter are the machine-independent ones -- deliberate acts,
// targets the hand must acquire, pixels of pointer travel -- because Playwright
// acquires a target instantly, which is exactly the part of the old route that
// costs a person the most.  The milliseconds are printed too, labelled as the
// driver's, and the drag's are HIGHER: six synthetic pointer moves are slower
// than two instant clicks, which says something about the driver and nothing
// about the gesture.
//
// EVERY CHECK IS RED-PROOFED, and the proof is a flag rather than a story: each
// `--break <name>` disables, from the page, exactly ONE mechanism, and the checks
// that mechanism holds up must then go red.  Several of them redden more than one
// check, and that is the finding rather than a fault -- take the anchors away and
// the drag, the snap and the drop all stop, because they all rest on them.  What
// a break may never do is leave every check green.
//
// Nothing in `www/` is edited to do it: the breaks patch the published modules in
// the live page -- `DaimondGraphGeom`, `DaimondGesture`, `DaimondDiamond` -- which
// is the honest place to break a thing from, and means a break can never be left
// behind in the source.
//
//	node dev/verify_graph_connect.mjs                 # clean
//	node dev/verify_graph_connect.mjs --breaks        # list them
//	node dev/verify_graph_connect.mjs --break snap    # expected to FAIL
//
// Run with dev/serve.mjs up (dev/world.sh N --up).  No gateway needed: the Graph
// draws from OPFS and asks the network for nothing.
import fs from 'node:fs';
import { open, shot, errors, signInAs, scratch } from './harness.mjs';

const out = [];
let bad = 0;
const check = (ok, what) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
	console.log(`${ok ? '  ok   ' : '  FAIL '}${what}`);
	if (!ok) bad++;
};

// ── The breaks ───────────────────────────────────────────────────
//
// Each is a function evaluated IN THE PAGE, named for the mechanism it removes: if
// a check survives its own mechanism being removed, the check was not measuring
// it.
const BREAKS = {
	anchors:  'the edge band never matches, so no anchor is ever raised',
	leave:    'the edge band always matches, so the anchors never go',
	snap:     'the magnetic snap finds nothing',
	nosnap:   'the snap ignores its tolerance and takes the nearest port at any distance',
	write:    'the drop finds no tile under it, so no link is written',
	chip:     'a press on a relation chip never reaches the picker',
	escape:   'Escape never reaches the pane',
	create:   'the creation door answers nothing',
	select:   'a click never reaches an edge',
	reverse:  'the Reverse control is detached from its handler',
	del:      'the Delete key never reaches the pane',
	hold:     'a rest on a coarse pointer means what it means everywhere else',
	zoom:     'the zoom holds the scroll where it was instead of the point',
	rebuild:  'every move of a dragged link redraws the whole picture',
	layout:   'the stored arrangement is dropped on the way out',
	abort:    'Escape never reaches the pane, so a drag cannot be called off',
	outside:  'the snap takes a port however far outside the picture the pointer is',
	keyl:     'the L key never reaches the pane',
	arrow:    'every line is given a second arrowhead',
	curve:    'routing goes back to choosing by centres rather than by clear air',
};
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (process.argv.includes('--breaks')) {
	Object.keys(BREAKS).forEach(k => console.log(`  --break ${k.padEnd(9)} ${BREAKS[k]}`));
	process.exit(0);
}
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(' ')}`);
	process.exit(2);
}

// A profile PER RUN, so a red-proof and a clean run can be driven at the same time
// without sharing a Chrome profile directory -- which two of them did, once, and
// the clean run reported three failures that belonged to neither.
const PROFILE = scratch('graph-connect' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });
const s = await open({ name: 'graphconnect', connect: false, profile: PROFILE, defaults: false });
const { page } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: ${BREAKS[BREAK]}. A failure below is the point ***\n`);
await page.waitForTimeout(2500);
// ROOM TO AIM IN. Every screen position below is arithmetic from a picture
// coordinate, which needs the picture coordinate to be ON SCREEN -- and the Graph
// shares the stage with the AI, the Web page and the Work panel, which leaves it
// about 400 px of width. So the stage is given over to it, exactly as a person
// closing the other panels would. Nothing about the pane changes; only how much of
// it is in view.
await page.setViewportSize({ width: 1800, height: 1100 });
await page.waitForTimeout(400);
await page.evaluate(() => {
	['ai', 'web', 'work', 'crystal', 'files', 'agents', 'terminal', 'msg']
		.forEach(k => { try { DaimondPanels.hide(k); } catch (e) { /* not on the stage */ } });
});
await page.waitForTimeout(600);

/// Reach the real wasm directly. A fresh `DaimondApp` shares the page's OPFS, so
/// this is the store the pane is reading, not a copy of it.
const wasm = (fn, arg) => page.evaluate(async ({ src, arg }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', 'arg', `return (${src})(app, arg);`))(app, arg);
}, { src: fn.toString(), arg });

/// Apply a break, if this run is the one it belongs to.
const breaking = async (name, fn) => { if (BREAK === name) await page.evaluate(fn); };

// ── The fixture ──────────────────────────────────────────────────
//
// Four Diamonds and one link, PLACED rather than laid out: `DaimondGraph.adopt`
// is the sync's own door into the arrangement, so the coordinates below are the
// coordinates the picture is drawn at and every screen position in this file is
// arithmetic rather than a search of the document.
//
//	Alpha (120,120) ──────────────  Bravo (520,120)
//	      │  part-of
//	Charlie (120,420)               Echo (520,420), level with nothing
const NODE_W = 176, NODE_H = 44;
const fx = await wasm(async (app) => {
	const A = await app.create_diamond('Alpha'), B = await app.create_diamond('Bravo');
	const C = await app.create_diamond('Charlie'), E = await app.create_diamond('Echo');
	const ca = await app.add_link(C, 'diamond:' + C, 'diamond:' + A, 'part-of', 'seed', 'user');
	return { A, B, C, E, ca };
});
const id = fx;
const PLACED = { [id.A]: { x: 120, y: 120 }, [id.B]: { x: 520, y: 120 },
                 [id.C]: { x: 120, y: 420 }, [id.E]: { x: 520, y: 420 } };

/// Put the picture where this file says it is, and give the Graph the stage.
///
/// READ BEFORE PLACING, and it is not a nicety. A draw prunes the positions of
/// Diamonds that are not in the store it is drawing FROM, and a redraw draws from
/// the store the last read produced -- so placing Diamonds made since that read
/// and then redrawing throws the placements away as belonging to Diamonds that do
/// not exist. Which is a true thing about the pane and a trap for anything that
/// seeds through the wasm and then arranges.
async function draw() {
	await page.evaluate(() => {
		DaimondPanels.show('graph');
		['ai', 'web', 'work', 'crystal', 'files', 'agents', 'terminal', 'msg']
			.forEach(k => { try { DaimondPanels.hide(k); } catch (e) { /* not on the stage */ } });
		return DaimondGraph.refresh();
	});
	await page.waitForTimeout(500);
	await place(PLACED);
}

/// Adopt an arrangement through the sync's own door and draw it.
async function place(pos) {
	await page.evaluate((p) => {
		const t = Date.now(), rec = { v: 1, pos: {} };
		Object.keys(p).forEach(k => { rec.pos[k] = { x: p[k].x, y: p[k].y, t: t }; });
		DaimondGraph.adopt(rec);
		return DaimondGraph.refresh();
	}, pos);
	await page.waitForTimeout(700);
}
await draw();

/// Where the picture is on screen, and at what scale, so a picture coordinate can
/// be aimed at.
const view = () => page.evaluate(() => {
	const svg = document.querySelector('#graph-body svg#graph-svg');
	if (!svg) return null;
	const r = svg.getBoundingClientRect();
	const vb = (svg.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number);
	return { left: r.left, top: r.top, k: r.width / vb[2], w: vb[2], h: vb[3] };
});
let V = await view();
const on = (p) => ({ x: V.left + p.x * V.k, y: V.top + p.y * V.k });
/// The four ports of a placed box, in picture coordinates.
const ports = (p) => ({
	top:    { x: p.x + NODE_W / 2, y: p.y },
	right:  { x: p.x + NODE_W,     y: p.y + NODE_H / 2 },
	bottom: { x: p.x + NODE_W / 2, y: p.y + NODE_H },
	left:   { x: p.x,              y: p.y + NODE_H / 2 },
});

const links = () => wasm(async (app) => JSON.parse(await app.all_links()));
/// Where an anchor is on screen, or the corner of the window.
///
/// Never null, and that is deliberate. A break that stops the anchors appearing
/// must redden the check that is ABOUT the anchors and leave the rest of the run
/// standing; a `null` dereferenced three lines later would end the process
/// instead, and a verifier that dies under its own red-proof proves nothing about
/// the other sixteen checks.
const anchorPt = async (side) => (await page.evaluate((sd) => {
	const g = document.querySelector(`#graph-body g.graph-anchor[data-side="${sd}"]`);
	const r = g && g.getBoundingClientRect();
	return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}, side || 'right')) || { x: 0, y: 0 };
const anchors = () => page.evaluate(() =>
	[...document.querySelectorAll('#graph-body g.graph-anchor')].map(g => ({
		id: g.getAttribute('data-diamond-id'), side: g.getAttribute('data-side'),
	})));
const targets = () => page.evaluate(() =>
	[...document.querySelectorAll('#graph-body g.graph-node.link-target')]
		.map(g => g.getAttribute('data-diamond-id')));

check(!!V && Object.values(id).every(v => typeof v === 'string' && v),
	`fixture: four Diamonds placed through the sync's own door, one seed link `
	+ `(${(await links()).length} link(s), scale ${V ? V.k.toFixed(3) : '—'})`);

// ── 1. The anchors appear on the edge, and not in the middle ─────
await breaking('anchors', () => {
	window.DaimondGraphGeom.inEdgeBand = function () { return false; };
});
const edgeOfA = on({ x: PLACED[id.A].x + NODE_W - 4, y: PLACED[id.A].y + NODE_H / 2 });
await page.mouse.move(edgeOfA.x, edgeOfA.y);
await page.waitForTimeout(220);
let an = await anchors();
check(an.length === 4 && an.every(a => a.id === id.A)
	&& ['top', 'right', 'bottom', 'left'].every(sd => an.some(a => a.side === sd)),
	`hovering Alpha's edge raises four anchors on Alpha, one per side: `
	+ JSON.stringify(an.map(a => a.side)));
await shot(s, 'connect-1-anchors');

await page.mouse.move(on({ x: PLACED[id.A].x + NODE_W / 2, y: PLACED[id.A].y + NODE_H / 2 }).x,
	on({ x: PLACED[id.A].x + NODE_W / 2, y: PLACED[id.A].y + NODE_H / 2 }).y);
await page.waitForTimeout(220);
check((await anchors()).length === 0,
	`and the middle of the tile raises none — a press there moves the Diamond`);

// ── 2. Leaving takes them away ───────────────────────────────────
await breaking('leave', () => {
	window.DaimondGraphGeom.inEdgeBand = function () { return true; };
});
await page.mouse.move(edgeOfA.x, edgeOfA.y);
await page.waitForTimeout(220);
const raised = (await anchors()).length;
await page.mouse.move(on({ x: 900, y: 700 }).x, on({ x: 900, y: 700 }).y);
await page.waitForTimeout(220);
check(raised === 4 && (await anchors()).length === 0,
	`leaving the edge takes them away again: ${raised} raised, ${(await anchors()).length} left`);

// ── 3. The magnetic snap ─────────────────────────────────────────
//
// Bravo's left port is at (520, 142) and Alpha's right anchor at (296, 142), so a
// pointer dragged along that line is a known number of pixels from the port it is
// aiming at. 20 px must snap and 30 px must not, which is the 24 the module says.
await breaking('snap', () => {
	window.DaimondGraphGeom.nearestPort = function () { return null; };
	window.DaimondGraphGeom.hit = function () { return null; };
});
await breaking('nosnap', () => {
	const real = window.DaimondGraphGeom.nearestPort;
	window.DaimondGraphGeom.nearestPort = function (c, p) { return real(c, p, Infinity); };
});
const aR = on(ports(PLACED[id.A]).right);
const bL = ports(PLACED[id.B]).left;
await page.mouse.move(edgeOfA.x, edgeOfA.y);
await page.waitForTimeout(200);
const anchorBox = await anchorPt('right');
check(!!anchorBox && Math.abs(anchorBox.x - aR.x) < 2 && Math.abs(anchorBox.y - aR.y) < 2,
	`the right-hand anchor is drawn ON the right-hand port: `
	+ `${anchorBox ? `(${anchorBox.x.toFixed(1)},${anchorBox.y.toFixed(1)})` : 'absent'} `
	+ `vs (${aR.x.toFixed(1)},${aR.y.toFixed(1)})`);

await page.mouse.move(anchorBox.x, anchorBox.y);
await page.mouse.down();
await page.mouse.move(on({ x: bL.x - 30, y: bL.y }).x, on({ x: bL.x - 30, y: bL.y }).y);
await page.waitForTimeout(150);
const at30 = await targets();
await page.mouse.move(on({ x: bL.x - 20, y: bL.y }).x, on({ x: bL.x - 20, y: bL.y }).y);
await page.waitForTimeout(150);
const at20 = await targets();
check(at20.length === 1 && at20[0] === id.B,
	`20 px from Bravo's port the link snaps to Bravo and lights it: ${JSON.stringify(at20)}`);
check(at30.length === 0,
	`and 30 px away — past the 24 the module states — nothing is lit: ${JSON.stringify(at30)}`);
await shot(s, 'connect-2-snap');

// A live line exists while the gesture runs, and it is the only moving thing.
const liveWhile = await page.evaluate(() =>
	document.querySelectorAll('#graph-body g.graph-live path.graph-live-line').length);

// ── 4. No gesture rebuilds the picture ───────────────────────────
//
// Counted two ways, because either alone could pass on a module that rebuilt: the
// pane's own count of how many times it has BUILT the SVG, and a MutationObserver
// on the body watching for children being replaced.
await breaking('rebuild', () => {
	const real = window.DaimondGraphGeom.hit;
	window.DaimondGraphGeom.hit = function (c, p) { window.DaimondGraph.organise(); return real(c, p); };
});
await page.evaluate(() => {
	window.__churn = 0;
	window.__draws0 = DaimondGraph._draws();
	window.__obs = new MutationObserver(ms => ms.forEach(m => { window.__churn += m.addedNodes.length; }));
	window.__obs.observe(document.getElementById('graph-body'), { childList: true });
});
for (let i = 6; i >= 1; i--) {
	const p = on({ x: bL.x - 20 - i * 12, y: bL.y - i * 3 });
	await page.mouse.move(p.x, p.y);
}
await page.waitForTimeout(150);
const churn = await page.evaluate(() => ({
	churn: window.__churn, drawn: DaimondGraph._draws() - window.__draws0,
}));
check(churn.churn === 0 && churn.drawn === 0,
	`six moves of a dragged link rebuilt nothing: ${churn.drawn} draw(s), `
	+ `${churn.churn} child replacement(s) under #graph-body`);
check(liveWhile === 1, `and exactly one live line followed the pointer: ${liveWhile}`);

// ── 5. The drop writes the link, with no relation ────────────────
await breaking('write', () => {
	window.DaimondGraphGeom.nearestPort = function () { return null; };
	window.DaimondGraphGeom.hit = function () { return null; };
});
const bMid = on({ x: PLACED[id.B].x + NODE_W / 2, y: PLACED[id.B].y + NODE_H / 2 });
await page.mouse.move(bMid.x, bMid.y);
await page.mouse.up();
await page.waitForTimeout(1200);
let L = await links();
const made = L.filter(l => l.from === 'diamond:' + id.A && l.to === 'diamond:' + id.B);
check(made.length === 1 && made[0].rel === '' && made[0].by === 'user' && made[0].owner === id.A,
	`the drop wrote ONE link, Alpha → Bravo, asserted by the user with no relation `
	+ `on it: ${JSON.stringify(made.map(l => [l.rel, l.by, l.owner === id.A ? 'owned by Alpha' : l.owner]))}`);
const AB = made[0] || {};

// ── 6. The relation is offered, not demanded ─────────────────────
// Intercepted at the chip rather than through `DaimondGraph.rels.tidy`, which was
// the first attempt and proved nothing: the picker calls the module's INTERNAL
// `tidyRel`, so patching the published copy of it left all thirty-four checks
// green. A break that cannot redden its own check is a break that has to be
// rewritten, not recorded.
await breaking('chip', () => {
	document.addEventListener('click', e => {
		if (e.target.closest && e.target.closest('.graph-relpick-chip')) e.stopImmediatePropagation();
	}, true);
});
const picker = await page.evaluate(() => {
	const p = document.getElementById('graph-relpick');
	return p ? { up: !!p.getClientRects().length,
	             chips: [...p.querySelectorAll('.graph-relpick-chip')].map(c => c.textContent) } : null;
});
check(!!picker && picker.up && picker.chips.includes('part-of'),
	`and the relation picker opened on the new line, offering the words the store `
	+ `already holds: ${picker ? JSON.stringify(picker.chips) : 'no picker'}`);
await shot(s, 'connect-3-picker');
await page.click('#graph-relpick .graph-relpick-chip', { timeout: 4000 }).catch(() => {});
await page.waitForTimeout(1000);
L = await links();
const revised = L.find(l => l.id === AB.id) || {};
check(revised.rel === 'part-of' && revised.id === AB.id && revised.ts === AB.ts,
	`choosing a chip revises THAT link — same id, same timestamp, so the record of `
	+ `when it was first asserted survives: rel=${JSON.stringify(revised.rel)}, `
	+ `id ${revised.id === AB.id ? 'held' : 'CHANGED'}, ts ${revised.ts === AB.ts ? 'held' : 'CHANGED'}`);

// ── 7. Escape keeps the link and leaves the relation blank ───────
await breaking('escape', () => {
	window.addEventListener('keydown', e => {
		if (e.key === 'Escape') e.stopImmediatePropagation();
	}, true);
});
await draw();
V = await view();
const cEdge = on({ x: PLACED[id.C].x + NODE_W - 4, y: PLACED[id.C].y + NODE_H / 2 });
await page.mouse.move(cEdge.x, cEdge.y);
await page.waitForTimeout(200);
const cAnchor = await anchorPt('right');
const eMid = on({ x: PLACED[id.E].x + NODE_W / 2, y: PLACED[id.E].y + NODE_H / 2 });
await page.mouse.move(cAnchor.x, cAnchor.y);
await page.mouse.down();
await page.mouse.move((cAnchor.x + eMid.x) / 2, (cAnchor.y + eMid.y) / 2);
await page.mouse.move(eMid.x, eMid.y);
await page.mouse.up();
await page.waitForTimeout(1200);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
L = await links();
const CE = L.find(l => l.from === 'diamond:' + id.C && l.to === 'diamond:' + id.E);
const pickerGone = await page.evaluate(() => {
	const p = document.getElementById('graph-relpick');
	return !p || !p.getClientRects().length;
});
check(!!CE && CE.rel === '' && pickerGone,
	`Escape on the picker shuts it and leaves the link standing with no relation, `
	+ `which is a complete link: rel=${JSON.stringify(CE && CE.rel)}, picker ${pickerGone ? 'gone' : 'STILL UP'}`);

// ── 8. Let go over empty canvas: a Diamond there, already linked ─
await breaking('create', () => {
	window.DaimondDiamond.create = async function () { return null; };
});
await draw();
V = await view();
const empty = { x: 880, y: 560 };
await page.mouse.move(cEdge.x, cEdge.y);
await page.waitForTimeout(200);
const cA2 = await anchorPt('right');
await page.mouse.move(cA2.x, cA2.y);
await page.mouse.down();
await page.mouse.move(on({ x: 600, y: 520 }).x, on({ x: 600, y: 520 }).y);
await page.mouse.move(on(empty).x, on(empty).y);
await page.mouse.up();
await page.waitForTimeout(400);
const namerUp = await page.evaluate(() => {
	const n = document.getElementById('graph-namer');
	return !!(n && n.getClientRects().length);
});
await page.fill('#graph-namer-name', 'Foxtrot').catch(() => {});
await page.keyboard.press('Enter');
await page.waitForTimeout(2200);
const madeIt = await page.evaluate(async (from) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const ds = JSON.parse(await app.list_diamonds());
	const f = ds.find(d => d.name === 'Foxtrot');
	const ls = JSON.parse(await app.all_links());
	let pos = null;
	try { pos = (JSON.parse(localStorage.getItem('daimond-graph') || '{}').pos || {})[f && f.id]; }
	catch (e) { /* none */ }
	return { id: f && f.id, pos: pos,
	         linked: !!(f && ls.some(l => l.from === 'diamond:' + from && l.to === 'diamond:' + f.id)) };
}, id.C);
check(namerUp && !!madeIt.id && madeIt.linked,
	`letting go over empty canvas asked for a name and made a Diamond there, already `
	+ `linked from Charlie: named ${namerUp ? 'yes' : 'NO'}, made ${madeIt.id ? 'yes' : 'NO'}, `
	+ `linked ${madeIt.linked ? 'yes' : 'NO'}`);
check(!!madeIt.pos && Math.abs(madeIt.pos.x - (empty.x - NODE_W / 2)) < 6
	&& Math.abs(madeIt.pos.y - (empty.y - NODE_H / 2)) < 6,
	`and it was put WHERE THE LINK WAS LET GO, centred on the drop: `
	+ `${JSON.stringify(madeIt.pos)} against (${empty.x - NODE_W / 2},${empty.y - NODE_H / 2})`);
await shot(s, 'connect-4-created');

// ── 9. An edge is selected, reversed and dropped ─────────────────
await breaking('select', () => {
	document.getElementById('graph-body').addEventListener('click', e => {
		if (e.target.closest && e.target.closest('.graph-edge')) e.stopImmediatePropagation();
	}, true);
});
await draw();
/// A point on a drawn link's line that the pointer can actually reach.
const edgeAt = (lid) => page.evaluate((l) => {
	const p = document.querySelector(`g.graph-edge[data-link-id="${l}"] path.graph-edge-line`);
	if (!p) return { err: 'no such edge drawn' };
	const svg = p.ownerSVGElement, r = svg.getBoundingClientRect();
	const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
	for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) {
		const pt = p.getPointAtLength(p.getTotalLength() * f);
		const x = r.left + pt.x * (r.width / vb[2]), y = r.top + pt.y * (r.height / vb[3]);
		if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
		const el = document.elementFromPoint(x, y);
		const g = el && el.closest ? el.closest('g.graph-edge') : null;
		if (g && g.dataset.linkId === l) return { x, y };
	}
	return { err: 'no reachable point on the line' };
}, lid);
let ep = await edgeAt(AB.id);
if (!ep.err) { await page.mouse.click(ep.x, ep.y); await page.waitForTimeout(500); }
const sel = await page.evaluate((lid) => ({
	marked: !!document.querySelector(`g.graph-edge[data-link-id="${lid}"].selected`),
	form:   !!(document.getElementById('graph-edit') || {}).getClientRects
	          && !!document.getElementById('graph-edit').getClientRects().length,
	rev:    !!document.getElementById('graph-edit-reverse'),
}), AB.id);
check(!ep.err && sel.marked && sel.form && sel.rev,
	`clicking a link selects it and opens its form, which carries Reverse: `
	+ `${ep.err || JSON.stringify(sel)}`);

await breaking('reverse', () => {
	const b = document.getElementById('graph-edit-reverse');
	if (b) b.replaceWith(b.cloneNode(true));
});
await page.click('#graph-edit-reverse', { force: true, timeout: 4000 }).catch(() => {});
await page.waitForTimeout(1400);
L = await links();
const backwards = L.find(l => l.from === 'diamond:' + id.B && l.to === 'diamond:' + id.A);
const forwards  = L.find(l => l.id === AB.id);
check(!!backwards && !forwards && backwards.rel === 'part-of' && backwards.note === '',
	`Reverse turns it round as a NEW record — the store refuses to edit an end — `
	+ `carrying the relation: ${backwards ? `Bravo → Alpha rel=${JSON.stringify(backwards.rel)}` : 'not reversed'}`
	+ `, the old record ${forwards ? 'IS STILL THERE' : 'gone'}`);

await breaking('del', () => {
	window.addEventListener('keydown', e => {
		if (e.key === 'Delete') e.stopImmediatePropagation();
	}, true);
});
await draw();
ep = await edgeAt(backwards ? backwards.id : AB.id);
if (!ep.err) { await page.mouse.click(ep.x, ep.y); await page.waitForTimeout(500); }
await page.keyboard.press('Escape');       // shut the form; the selection stands
await page.waitForTimeout(300);
await page.keyboard.press('Delete');
await page.waitForTimeout(1200);
L = await links();
check(!ep.err && !L.some(l => l.id === (backwards || {}).id),
	`and the Delete key drops the selected link: `
	+ `${L.length} link(s) left — ${L.map(l => l.rel || '(no relation)').join(', ')}`);

// ── 9b. The two endings that must write nothing ──────────────────
await draw();
const quiet0 = (await links()).length;
const startDrag = async () => {
	const e = on({ x: PLACED[id.A].x + NODE_W - 4, y: PLACED[id.A].y + NODE_H / 2 });
	await page.mouse.move(e.x, e.y);
	await page.waitForTimeout(200);
	const g = await anchorPt('right');
	if (!g.x && !g.y) return null;
	await page.mouse.move(g.x, g.y);
	await page.mouse.down();
	return g;
};

await breaking('abort', () => {
	window.addEventListener('keydown', e => {
		if (e.key === 'Escape') e.stopImmediatePropagation();
	}, true);
});
let grabbed = await startDrag();
const bCentre = on({ x: PLACED[id.B].x + NODE_W / 2, y: PLACED[id.B].y + NODE_H / 2 });
if (grabbed) {
	await page.mouse.move((grabbed.x + bCentre.x) / 2, grabbed.y);
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	await page.mouse.move(bCentre.x, bCentre.y);
	await page.mouse.up();
	await page.waitForTimeout(900);
}
const afterAbort = await page.evaluate(() => ({
	live: document.querySelectorAll('#graph-body path.graph-live-line').length,
	lit:  document.querySelectorAll('#graph-body g.graph-node.link-target').length,
}));
check(!!grabbed && (await links()).length === quiet0
	&& afterAbort.live === 0 && afterAbort.lit === 0,
	`Escape mid-drag calls the link off and writes nothing, and the release after it `
	+ `does nothing either: ${(await links()).length} link(s), still ${quiet0}; `
	+ `${afterAbort.live} live line(s), ${afterAbort.lit} tile(s) lit`);

await breaking('outside', () => {
	const real = window.DaimondGraphGeom.nearestPort;
	window.DaimondGraphGeom.nearestPort = function (c, p) { return real(c, p, Infinity); };
});
await draw();
grabbed = await startDrag();
const bar = await page.evaluate(() => {
	const r = document.querySelector('#panel-graph .graph-bar').getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
if (grabbed) {
	await page.mouse.move(grabbed.x, grabbed.y - 40);
	await page.mouse.move(bar.x, bar.y);
	await page.mouse.up();
	await page.waitForTimeout(900);
}
const namerAfter = await page.evaluate(() => {
	const n = document.getElementById('graph-namer');
	return !!(n && n.getClientRects().length);
});
check(!!grabbed && (await links()).length === quiet0 && !namerAfter,
	`letting go outside the picture is a gesture abandoned — no link, and no Diamond `
	+ `offered where there is no canvas: ${(await links()).length} link(s), still `
	+ `${quiet0}; namer ${namerAfter ? 'UP' : 'absent'}`);

// ── 9c. The keyboard: select a Diamond, press L, click the target ─
await breaking('keyl', () => {
	window.addEventListener('keydown', e => {
		if (e.key === 'l' || e.key === 'L') e.stopImmediatePropagation();
	}, true);
});
await draw();
const eCentre = on({ x: PLACED[id.E].x + NODE_W / 2, y: PLACED[id.E].y + NODE_H / 2 });
await page.mouse.click(eCentre.x, eCentre.y);
await page.waitForTimeout(700);
await draw();
await page.evaluate(() => document.getElementById('graph-body').focus
	&& document.getElementById('graph-body').focus());
await page.keyboard.press('l');
await page.waitForTimeout(500);
const armed = await page.evaluate((e) => ({
	pressed: (document.getElementById('graph-link-btn') || {}).getAttribute('aria-pressed'),
	source: !!document.querySelector(`g.graph-node[data-diamond-id="${e}"].link-source`),
}), id.E);
const aCentre = on({ x: PLACED[id.A].x + NODE_W / 2, y: PLACED[id.A].y + NODE_H / 2 });
await page.mouse.click(aCentre.x, aCentre.y);
await page.waitForTimeout(600);
let wroteByKey = false;
if (await page.evaluate(() => !!document.getElementById('graph-edit-ok'))) {
	await page.click('#graph-edit-ok', { force: true, timeout: 4000 }).catch(() => {});
	await page.waitForTimeout(1100);
	wroteByKey = (await links()).some(l => l.from === 'diamond:' + id.E && l.to === 'diamond:' + id.A);
}
check(armed.pressed === 'true' && armed.source && wroteByKey,
	`with a Diamond selected, L links it to the next one clicked — the route a `
	+ `keyboard has: armed ${armed.pressed}, Echo marked as the source `
	+ `${armed.source ? 'yes' : 'NO'}, link written ${wroteByKey ? 'yes' : 'NO'}`);

// ── 10. Direction is drawn once ──────────────────────────────────
await breaking('arrow', () => {
	document.querySelectorAll('#graph-body path.graph-edge-line')
		.forEach(p => p.setAttribute('marker-start', 'url(#gm-arrow)'));
});
const arrows = await page.evaluate(() =>
	[...document.querySelectorAll('#graph-body g.graph-edge')].map(g =>
		[...g.querySelectorAll('path')].reduce((n, p) =>
			n + ['marker-start', 'marker-mid', 'marker-end'].filter(a => p.getAttribute(a)).length, 0)));
check(arrows.length > 0 && arrows.every(n => n === 1),
	`every edge carries exactly one arrowhead, so a line says its direction once: `
	+ JSON.stringify(arrows));

// ── 11. A line never runs back under the boxes it joins ──────────
//
// The case the routing guard is for: two tiles almost level and far apart. Asked
// of the DRAWN path, sampled along its length, against the node outline's own
// `isPointInFill` — so the question is put to the shapes the browser painted
// rather than to the arithmetic that placed them.
await breaking('curve', () => {
	const G = window.DaimondGraphGeom;
	const port = G.port;
	G.route = function (a, b, nudge, opts) {
		// The condition as it was: down whenever the target's centre is lower.
		const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
		const f = 0.5, p0 = port(a, bc.y > ac.y ? 'bottom' : 'top', f);
		const p3 = port(b, bc.y > ac.y ? 'top' : 'bottom', f);
		const dy = Math.max(24, Math.abs(p3.y - p0.y));
		return { p0, p1: { x: p0.x, y: p0.y + dy * 0.42 }, p2: { x: p3.x, y: p3.y - dy * 0.42 }, p3 };
	};
});
// A CYCLE between the two, so the CLOSING edge is drawn side by side as well.
// That case was found by a red-proof rather than by reasoning: a closing edge bows
// out to the right of its source and back into its target, which between two boxes
// standing side by side runs straight THROUGH the target for half its length.
await wasm(async (app, x) => {
	await app.add_link(x.a, 'diamond:' + x.a, 'diamond:' + x.b, 'feeds', '', 'user');
	await app.add_link(x.b, 'diamond:' + x.b, 'diamond:' + x.a, 'answers', '', 'user');
}, { a: id.A, b: id.B });
const LEVEL = Object.assign({}, PLACED, {
	[id.A]: { x: 120, y: 300 }, [id.B]: { x: 760, y: 310 },
});
await place(LEVEL);
const under = await page.evaluate(() => {
	const svg = document.querySelector('#graph-body svg#graph-svg');
	const boxes = [...svg.querySelectorAll('g.graph-node')].map(g => ({
		id: g.getAttribute('data-diamond-id'),
		box: g.querySelector('path.graph-node-box'),
		m: new DOMMatrix(getComputedStyle(g).transform),
	}));
	const faults = [];
	svg.querySelectorAll('g.graph-edge').forEach(g => {
		const p = g.querySelector('path.graph-edge-line');
		const ends = [g.getAttribute('data-from'), g.getAttribute('data-to')];
		const len = p.getTotalLength();
		for (let i = 3; i < 97; i++) {
			const at = p.getPointAtLength(len * i / 100);
			boxes.filter(b => ends.includes(b.id)).forEach(b => {
				// The box is drawn in its own translated frame, so the sample is
				// taken back into it before being asked about.
				const local = new DOMPoint(at.x - b.m.e, at.y - b.m.f);
				if (b.box.isPointInFill(local)) faults.push([g.getAttribute('data-link-id'), b.id, i]);
			});
		}
	});
	return { faults: faults.slice(0, 4), n: faults.length,
	         edges: svg.querySelectorAll('g.graph-edge').length,
	         back: svg.querySelectorAll('g.graph-edge.back').length };
});
check(under.edges > 0 && under.n === 0 && under.back > 0,
	`with two tiles ten pixels apart vertically and six hundred apart sideways, no `
	+ `line runs back under either box it joins — the closing edge of the cycle `
	+ `between them included: ${under.edges} edge(s) sampled, ${under.back} of them `
	+ `closing, ${under.n} fault(s)${under.n ? ' ' + JSON.stringify(under.faults) : ''}`);
await shot(s, 'connect-5-level');

// ── 12. The wheel scales about the pointer ───────────────────────
await breaking('zoom', () => {
	window.DaimondGraphGeom.zoomAt = function (scroll) { return { x: scroll.x, y: scroll.y }; };
});
await draw();
V = await view();
// The point to hold, taken from the middle of the PANE and converted into the
// picture's own coordinates -- so it is a point that is certainly on screen,
// which is the whole claim being made about it.
const mid = await page.evaluate(() => {
	const r = document.getElementById('graph-body').getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
const hold = { x: (mid.x - V.left) / V.k, y: (mid.y - V.top) / V.k };
const before = on(hold);
await page.mouse.move(before.x, before.y);
await page.mouse.wheel(0, -120);
await page.waitForTimeout(700);
V = await view();
const after = on(hold);
const zoomed = await page.evaluate(() => {
	try { return JSON.parse(localStorage.getItem('daimond-graph')).zoom; } catch (e) { return null; }
});
check(zoomed > 1 && Math.abs(after.x - before.x) < 3 && Math.abs(after.y - before.y) < 3,
	`a wheel notch enlarges past the old ceiling of 1 and holds the point under the `
	+ `pointer: zoom ${zoomed}, the point moved `
	+ `(${(after.x - before.x).toFixed(1)},${(after.y - before.y).toFixed(1)}) px`);
let ceiling = null;
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(120); }
ceiling = await page.evaluate(() => {
	try { return JSON.parse(localStorage.getItem('daimond-graph')).zoom; } catch (e) { return null; }
});
check(Math.abs(ceiling - 2.5) < 0.001,
	`and stops at the stated ceiling of 2.5: ${ceiling}`);
await page.evaluate(() => DaimondGraph.resetView());
await page.waitForTimeout(600);

// ── 13. The arrangement survives a reload ────────────────────────
await breaking('layout', () => {
	window.addEventListener('beforeunload', () => {
		try {
			const k = Object.keys(localStorage).find(x => x.endsWith('daimond-graph'));
			if (k) localStorage.removeItem(k);
		} catch (e) { /* nothing to drop */ }
	});
});
const posBefore = await page.evaluate(() => {
	const o = {};
	document.querySelectorAll('#graph-body g.graph-node').forEach(g => {
		o[g.getAttribute('data-diamond-id')] = g.getAttribute('transform');
	});
	return o;
});
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'graphconnect');
await page.waitForTimeout(1500);
await page.evaluate(() => {
	DaimondPanels.show('graph');
	['ai', 'web', 'work', 'crystal', 'files', 'agents', 'terminal', 'msg']
		.forEach(k => { try { DaimondPanels.hide(k); } catch (e) { /* not on the stage */ } });
	return DaimondGraph.refresh();
});
await page.waitForTimeout(1200);
const posAfter = await page.evaluate(() => {
	const o = {};
	document.querySelectorAll('#graph-body g.graph-node').forEach(g => {
		o[g.getAttribute('data-diamond-id')] = g.getAttribute('transform');
	});
	return o;
});
const moved = Object.keys(posBefore).filter(k => posBefore[k] !== posAfter[k]);
check(Object.keys(posBefore).length > 3 && moved.length === 0,
	`every Diamond is where it was after a reload — a gesture wrote an arrangement, `
	+ `not a session: ${Object.keys(posBefore).length} box(es), ${moved.length} moved`);

// ── 14. The number: what joining two Diamonds costs ──────────────
//
// Both routes driven in ONE build on ONE machine, so the two numbers are
// comparable in the only way that matters. The old route is still there — it is
// the keyboard's — so nothing had to be checked out to measure it.
await draw();
V = await view();
const seed = await wasm(async (app) => {
	const P = await app.create_diamond('Papa'), Q = await app.create_diamond('Quebec');
	const R = await app.create_diamond('Romeo'), S = await app.create_diamond('Sierra');
	return { P, Q, R, S };
});
const TIMED = Object.assign({}, PLACED, {
	[seed.P]: { x: 120, y: 660 }, [seed.Q]: { x: 520, y: 660 },
	[seed.R]: { x: 120, y: 800 }, [seed.S]: { x: 520, y: 800 },
});
await page.evaluate(() => DaimondGraph.refresh());
await page.waitForTimeout(500);
await place(TIMED);
V = await view();

/// Wait for a condition rather than for a number of milliseconds.
///
/// The timings below are the point of this section, so nothing in them may be a
/// `waitForTimeout`: a fixed wait measures the wait. Each step waits for the thing
/// it was actually waiting for -- the control to read as armed, the source to read
/// as picked, the form to be on screen, the LINK TO BE IN THE STORE -- polled every
/// 20 ms, which is finer than a frame.
async function until(fn, ms) {
	const t0 = Date.now();
	for (;;) {
		if (await fn()) return true;
		// Three seconds, not eight. Everything waited for here settles in well under
		// one when it is going to settle at all, and the difference is entirely
		// paid by the twenty red-proof runs, where every wait is a wait for
		// something that has been deliberately removed.
		if (Date.now() - t0 > (ms || 3000)) return false;
		await page.waitForTimeout(20);
	}
}
/// Is the link ON SCREEN yet?
///
/// Asked of the picture rather than of the store, and for two reasons. It is what
/// the person is waiting for -- the line appearing is how they know the two are
/// joined -- and it is one cheap `querySelector`, where reading the store means
/// building a `DaimondApp` and walking every sidecar, which at a 20 ms poll is
/// slower than the thing being measured. The store is checked afterwards, outside
/// the clock, by the check above.
const linked = (from, to) => () => page.evaluate((p) =>
	!!document.querySelector(`#graph-body g.graph-edge[data-from="${p.f}"][data-to="${p.t}"]`),
	{ f: from, t: to });

/// The route as it was: arm the mode, click the source, click the target, press
/// Create. Four acts, and a trip to the toolbar before the first of them.
async function oldWay(from, to) {
	const a = on({ x: TIMED[from].x + NODE_W / 2, y: TIMED[from].y + NODE_H / 2 });
	const b = on({ x: TIMED[to].x + NODE_W / 2, y: TIMED[to].y + NODE_H / 2 });
	const btn = await page.evaluate(() => {
		const r = document.getElementById('graph-link-btn').getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	const aims = [btn, a, b];
	const t0 = Date.now();
	await page.click('#graph-link-btn', { force: true });                       // 1
	if (!await until(() => page.evaluate(() =>
		(document.getElementById('graph-link-btn') || {}).getAttribute('aria-pressed') === 'true')))
		return { ms: Date.now() - t0, acts: 4, failed: 'the mode never armed' };
	await page.mouse.click(a.x, a.y);                                            // 2
	if (!await until(() => page.evaluate(() =>
		!!document.querySelector('#graph-body g.graph-node.link-source'))))
		return { ms: Date.now() - t0, acts: 4, failed: 'the source was never picked' };
	await page.mouse.click(b.x, b.y);                                            // 3
	if (!await until(() => page.evaluate(() => {
		const f = document.getElementById('graph-edit-ok');
		return !!(f && f.getClientRects().length);
	}))) {
		// Say what was under the pointer rather than dying with a selector name:
		// a timing cell that cannot take its first measurement has to report WHY.
		const seen = await page.evaluate((p) => {
			const el = document.elementFromPoint(p.x, p.y);
			return { under: el ? el.tagName + '.' + (el.getAttribute('class') || '') : 'nothing',
			         node: el && el.closest && el.closest('.graph-node')
			               ? el.closest('.graph-node').getAttribute('data-diamond-id') : null };
		}, b);
		return { ms: Date.now() - t0, acts: 4, failed: 'no form: ' + JSON.stringify(seen) };
	}
	const okAt = await page.evaluate(() => {
		const r = document.getElementById('graph-edit-ok').getBoundingClientRect();
		return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
	});
	aims.push(okAt);
	await page.click('#graph-edit-ok', { force: true, timeout: 4000 }).catch(() => {});  // 4
	const wrote = await until(linked(from, to), 4000);
	return { ms: Date.now() - t0, acts: 4, aims: aims, travel: travel(aims),
	         failed: wrote ? '' : 'the link was never written' };
}

/// The route now: one drag, from an anchor the pointer raised on the way.
async function newWay(from, to) {
	const edge = on({ x: TIMED[from].x + NODE_W - 4, y: TIMED[from].y + NODE_H / 2 });
	const b = on({ x: TIMED[to].x + NODE_W / 2, y: TIMED[to].y + NODE_H / 2 });
	const t0 = Date.now();
	await page.mouse.move(edge.x, edge.y);
	if (!await until(() => page.evaluate(() =>
		!!document.querySelector('#graph-body g.graph-anchor[data-side="right"]'))))
		return { ms: Date.now() - t0, acts: 1, failed: 'no anchor was raised' };
	const g = await anchorPt('right');
	await page.mouse.move(g.x, g.y);
	await page.mouse.down();                                                     // 1, and only
	for (let i = 1; i <= 4; i++) {
		await page.mouse.move(g.x + ((b.x - g.x) * i) / 4, g.y + ((b.y - g.y) * i) / 4);
	}
	await page.mouse.up();
	const wrote = await until(linked(from, to), 4000);
	const ms = Date.now() - t0;
	// The relation is a refinement offered afterwards, not a step, so the picker is
	// outside the measurement -- and left with no relation, which is a whole link.
	await page.keyboard.press('Escape');
	return { ms: ms, acts: 1, aims: [g, b], travel: travel([g, b]),
	         failed: wrote ? '' : 'the link was never written' };
}

/// How far the pointer must travel to acquire a route's targets in turn.
function travel(aims) {
	let d = 0;
	for (let i = 1; i < aims.length; i++) {
		d += Math.hypot(aims[i].x - aims[i - 1].x, aims[i].y - aims[i - 1].y);
	}
	return Math.round(d);
}

const before14 = (await links()).length;
const oldRun = await oldWay(seed.P, seed.Q);
check(!oldRun.failed, `the route as it was still runs, so it can be timed: ${oldRun.failed || 'four acts'}`);
const midway = (await links()).length;
const newRun = await newWay(seed.R, seed.S);
check(!newRun.failed, `and so does the drag: ${newRun.failed || 'one act'}`);
const after14 = (await links()).length;
L = await links();
check(midway === before14 + 1 && after14 === before14 + 2
	&& L.some(l => l.from === 'diamond:' + seed.P && l.to === 'diamond:' + seed.Q)
	&& L.some(l => l.from === 'diamond:' + seed.R && l.to === 'diamond:' + seed.S),
	`both routes joined a pair, so the two timings below are of the same act: `
	+ `${before14} → ${midway} → ${after14} link(s)`);
// THE MILLISECONDS ARE THE DRIVER'S, NOT A HAND'S, and the column is labelled so.
// Playwright acquires a target instantly, which is exactly the part of the old
// route that costs a person the most -- four targets to find and hit, one of them
// a 60-pixel button in a toolbar, with a form to read in the middle. So what is
// reported first is what is machine-independent: the deliberate acts, the targets
// the hand must acquire, and how far the pointer must travel between them. The
// drag's own milliseconds are HIGHER here, and honestly so: six synthetic pointer
// moves and a poll are slower than two instant clicks, which says something about
// Playwright and nothing about the gesture.
console.log('\n  ── what joining two Diamonds costs ───────────────────');
console.log(`     before  Link → source → target → Create`);
console.log(`             ${oldRun.acts} acts   ${oldRun.aims.length} targets to acquire   `
	+ `${oldRun.travel} px of pointer travel   ${oldRun.ms} ms (driver)`);
console.log(`     after   one drag, anchor → tile`);
console.log(`             ${newRun.acts} act    ${newRun.aims.length} targets to acquire   `
	+ `${newRun.travel} px of pointer travel   ${newRun.ms} ms (driver)`);
console.log(`     ratio   ${(oldRun.acts / newRun.acts).toFixed(0)}× fewer acts, `
	+ `${(oldRun.aims.length / newRun.aims.length).toFixed(1)}× fewer targets, `
	+ `${(oldRun.travel / Math.max(1, newRun.travel)).toFixed(2)}× the travel\n`);
check(oldRun.travel > newRun.travel,
	`the drag also moves the pointer less far than the mode it replaces: `
	+ `${newRun.travel} px against ${oldRun.travel} px`);
check(newRun.acts < oldRun.acts,
	`and the drag costs fewer acts than the mode it replaces: ${newRun.acts} against ${oldRun.acts}`);

const gatewayNoise = /(401 \(Unauthorized\)|402 \(Payment Required\)|502 \(Bad Gateway\))/;
const errsA = errors(s).filter(e => !gatewayNoise.test(e));
check(errsA.length === 0, `no console errors beyond the gateway's answer: ${JSON.stringify(errsA.slice(0, 3))}`);
await s.close();

// ── 15. A finger, which has no hover to raise anything with ──────
//
// A separate session, because `hasTouch` is a property of the context. Driven
// through CDP rather than through Playwright's `touchscreen`, which offers a tap
// and nothing longer: a long press is touchStart, a wait, touchEnd.
const PROFILE_T = scratch('graph-connect-touch' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE_T, { recursive: true, force: true });
const tt = await open({ name: 'graphtouch', connect: false, profile: PROFILE_T,
	defaults: false, touch: true });
await tt.page.waitForTimeout(2500);
const tid = await tt.page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return { A: await app.create_diamond('Tango'), B: await app.create_diamond('Uniform') };
});
await tt.page.evaluate((ids) => {
	DaimondPanels.show('graph');
	const t = Date.now();
	DaimondGraph.adopt({ v: 1, pos: {
		[ids.A]: { x: 120, y: 120, t: t }, [ids.B]: { x: 520, y: 120, t: t } } });
	DaimondGraph.resetView();
	return DaimondGraph.refresh();
}, tid);
await tt.page.waitForTimeout(1000);
if (BREAK === 'hold') {
	await tt.page.evaluate(() => {
		const real = window.DaimondGesture.drag;
		window.DaimondGesture.drag = function (el, o) {
			const p = Object.assign({}, o);
			delete p.onHold;
			return real(el, p);
		};
		return DaimondGraph.refresh();
	});
	await tt.page.waitForTimeout(600);
}
const tv = await tt.page.evaluate(() => {
	const svg = document.querySelector('#graph-body svg#graph-svg');
	const r = svg.getBoundingClientRect();
	const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number);
	return { left: r.left, top: r.top, k: r.width / vb[2] };
});
const finger = { x: tv.left + (120 + NODE_W / 2) * tv.k, y: tv.top + (120 + NODE_H / 2) * tv.k };
const cdp = await tt.page.context().newCDPSession(tt.page);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart',
	touchPoints: [{ x: finger.x, y: finger.y }] });
await tt.page.waitForTimeout(800);
const held = await tt.page.evaluate(() =>
	[...document.querySelectorAll('#graph-body g.graph-anchor')]
		.map(g => g.getAttribute('data-side')));
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await tt.page.waitForTimeout(300);
check(held.length === 4,
	`a finger resting on a tile raises its four anchors — the hover a finger has `
	+ `not got: ${JSON.stringify(held)}`);
await shot(tt, 'connect-6-touch');
const errsT = errors(tt).filter(e => !gatewayNoise.test(e));
check(errsT.length === 0, `no console errors on the touch session: ${JSON.stringify(errsT.slice(0, 3))}`);
await tt.close();

console.log('\n' + out.join('\n'));
console.log(bad === 0 ? `\nALL ${out.length} CHECKS PASSED` : `\n${bad} of ${out.length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
