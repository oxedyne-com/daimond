// verify_graph.mjs — the Graph pane: what is stored is what is drawn, both ways.
//
// The pane's whole claim is that it is a verification instrument: a person looks at it to
// settle whether the association structure is the one they believe they built.  That claim
// only holds if the picture is a FAITHFUL function of the store, so this proves the two
// directions separately -- every stored link between two live Diamonds is drawn exactly
// once, and every drawn edge names a link that is really there -- and then proves the
// things a faithful picture also has to get right: which way the arrow points, which edge
// closes a cycle, that two relations between one pair are two lines AND two readable words,
// that an artefact is a count rather than a box, that a link to a deleted Diamond is
// confessed in the stats and drawn nowhere, that no hint stands over the boxes it points at,
// and that the same store draws the same bytes on every load.
//
// The fixture is built through the real wasm, in one browser profile:
//
//        Alpha ──part-of──▶ Bravo ──part-of──▶ Charlie ──(no rel)──▶ Foxtrot
//          │  ╲                 ▲                  │
//          │   ╲blocks,informs  │relates-to        │derives-from (closes the cycle)
//          │    ╲               │                  │
//          │     ▶ Delta ───────┘                  ▼
//          ├─ file:x.md   (an artefact: a count, not a box)         back to Alpha
//          └─ diamond:Xray, then Xray deleted   (dangling)
//        Echo — linked to nothing at all
//
// Run with dev/serve.mjs (DAIMOND_PORT, default 8777) up.  No gateway needed, so it
// belongs in phase 1.

import fs from 'node:fs';
import { open, shot, errors, signInAs, scratch } from './harness.mjs';

const out = [];
let bad = 0;
const check = (ok, what) => {
	out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
	console.log(`${ok ? '  ok   ' : '  FAIL '}${what}`);
	if (!ok) bad++;
};
// A divergence that is real, understood, and reported rather than asserted: it is the
// pane's behaviour as shipped, not a regression this run introduced.
const known = [];
const note = (ok, what, why) => { if (!ok) known.push(`${what}\n        ${why}`); };

// A fixed profile, emptied first, so a re-run starts from the same store rather than
// from the last run's Diamonds.  Under ~/.cache/daimond, never the repo and never /tmp.
const PROFILE = scratch('graph-profile');
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'graph', connect: false, profile: PROFILE });
const { page } = s;
await page.waitForTimeout(2500);

/// Reach the real wasm directly.  A fresh `DaimondApp` shares the page's OPFS, so this is
/// the store the pane is reading, not a copy of it.
const wasm = (fn, arg) => page.evaluate(async ({ src, arg }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', 'arg', `return (${src})(app, arg);`))(app, arg);
}, { src: fn.toString(), arg });

// ── The fixture ──────────────────────────────────────────────────
const fx = await wasm(async (app) => {
	const mk = (n) => app.create_diamond(n);
	const A = await mk('Alpha'), B = await mk('Bravo'), C = await mk('Charlie');
	const D = await mk('Delta'), E = await mk('Echo'), F = await mk('Foxtrot'), X = await mk('Xray');
	const ln = (owner, from, to, rel, note) =>
		app.add_link(owner, 'diamond:' + from, to, rel, note || '', 'user');
	const L = {};
	L.ab   = await ln(A, A, 'diamond:' + B, 'part-of', 'the launch sits under the brand');
	L.bc   = await ln(B, B, 'diamond:' + C, 'part-of');
	L.db   = await ln(D, D, 'diamond:' + B, 'relates-to');
	L.ca   = await ln(C, C, 'diamond:' + A, 'derives-from');   // closes the cycle
	L.ad1  = await ln(A, A, 'diamond:' + D, 'blocks');         // parallel pair, one
	L.ad2  = await ln(A, A, 'diamond:' + D, 'informs');        // parallel pair, two
	L.art  = await ln(A, A, 'file:x.md', 'produced');          // an artefact end
	L.dang = await ln(A, A, 'diamond:' + X, 'references');     // about to dangle
	L.cf   = await ln(C, C, 'diamond:' + F, '');               // an empty relation
	await app.delete_diamond(X);
	return { id: { A, B, C, D, E, F, X }, L };
});
const id = fx.id, L = fx.L;
const nameOf = {};
[['A', 'Alpha'], ['B', 'Bravo'], ['C', 'Charlie'], ['D', 'Delta'],
 ['E', 'Echo'], ['F', 'Foxtrot'], ['X', 'Xray']].forEach(([k, n]) => { nameOf[id[k]] = n; });
const linkName = {};
Object.keys(L).forEach(k => { linkName[L[k]] = k; });
check(Object.values(id).every(v => typeof v === 'string' && v.length > 0)
	&& Object.values(L).every(v => typeof v === 'string' && v.length > 0),
	`fixture built: 7 Diamonds (Xray then deleted), 9 links — ${Object.keys(L).join(' ')}`);

// ── Open the pane ────────────────────────────────────────────────
async function draw() {
	await page.evaluate(() => {
		DaimondPanels.show('graph');
		if (window.DaimondGraph) DaimondGraph.refresh();
	});
	await page.waitForTimeout(1200);
}
/// Everything the pane put on screen, read back as plain data.
const drawn = () => page.evaluate(() => {
	const svg = document.querySelector('#graph-body svg#graph-svg');
	const pos = (tr) => {
		const m = /translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(tr || '');
		return m ? { x: +m[1], y: +m[2] } : null;
	};
	const ends = (d) => {
		const m = /^M(-?[\d.]+),(-?[\d.]+)\s+C.*\s(-?[\d.]+),(-?[\d.]+)$/.exec(d || '');
		return m ? { x0: +m[1], y0: +m[2], x3: +m[3], y3: +m[4] } : null;
	};
	return {
		hasSvg: !!svg,
		edges: svg ? [...svg.querySelectorAll('g.graph-edges > g.graph-edge')].map(g => {
			const path = g.querySelector('path.graph-edge-line');
			const lab  = g.querySelector('text.graph-edge-label');
			return {
				lid:  g.dataset.linkId, from: g.dataset.from, to: g.dataset.to,
				back: g.classList.contains('back'),
				label: lab ? lab.textContent : null,
				d: path ? path.getAttribute('d') : null,
				ends: path ? ends(path.getAttribute('d')) : null,
				marker: path ? path.getAttribute('marker-end') : null,
				dash: path ? getComputedStyle(path).strokeDasharray : null,
			};
		}) : [],
		nodes: svg ? [...svg.querySelectorAll('g.graph-nodes > g.graph-node')].map(g => {
			const box = g.querySelector('rect.graph-node-box');
			return {
				did: g.dataset.diamondId, at: pos(g.getAttribute('transform')),
				w: box ? +box.getAttribute('width') : null,
				h: box ? +box.getAttribute('height') : null,
				isolate: g.classList.contains('isolate'),
				cycled:  g.classList.contains('cycled'),
				name: (g.querySelector('text.graph-node-name') || {}).textContent ?? null,
				badge: (g.querySelector('g.graph-badge text') || {}).textContent ?? null,
				cycleBadge: (g.querySelector('g.graph-cycle text') || {}).textContent ?? null,
			};
		}) : [],
		band:  (svg && svg.querySelector('text.graph-band') || {}).textContent ?? null,
		stats: (document.querySelector('#graph-body .graph-stats') || {}).textContent ?? null,
		empty: [...document.querySelectorAll('#graph-body p.graph-empty')].map(e => e.textContent),
	};
});
await draw();
let g = await drawn();
check(g.hasSvg, `the pane drew an SVG: ${g.nodes.length} node(s), ${g.edges.length} edge(s)`);
await shot(s, 'graph-fixture');

// The store, read exactly as graph.js reads it.
const stored = JSON.parse(await wasm(async (app) => await app.all_links()));
const live   = JSON.parse(await wasm(async (app) => await app.list_diamonds())).map(d => d.id);
const liveSet = new Set(live);
const dref = (r) => (String(r || '').slice(0, 8) === 'diamond:' ? String(r).slice(8) : null);
const dd = stored.filter(l => {
	const a = dref(l.from), b = dref(l.to);
	return a && b && liveSet.has(a) && liveSet.has(b);
});
check(stored.length === 9 && dd.length === 7 && live.length === 6,
	`store: ${stored.length} links, ${dd.length} between live Diamonds, ${live.length} Diamonds`);

// ── 1. Stored → drawn ────────────────────────────────────────────
let ones = 0, matched = 0, labelled = 0;
for (const l of dd) {
	const hits = g.edges.filter(e => e.lid === l.id);
	if (hits.length === 1) ones++;
	if (hits.length === 1 && hits[0].from === dref(l.from) && hits[0].to === dref(l.to)) matched++;
	if (hits.length === 1 && hits[0].label === (l.rel ? l.rel : null)) labelled++;
}
check(ones === dd.length, `every stored Diamond-to-Diamond link is drawn EXACTLY once: ${ones}/${dd.length}`);
check(matched === dd.length, `each drawn edge carries the stored from/to: ${matched}/${dd.length}`);
check(labelled === dd.length,
	`the relation is the label, and an empty relation gets no label: ${labelled}/${dd.length}`
	+ ` (empty-rel link ${linkName[L.cf]} label=${JSON.stringify((g.edges.find(e => e.lid === L.cf) || {}).label)})`);

// ── 2. Drawn → stored: no invented edges ─────────────────────────
const byId = {};
stored.forEach(l => { byId[l.id] = l; });
const invented = g.edges.filter(e => {
	const l = byId[e.lid];
	return !l || dref(l.from) !== e.from || dref(l.to) !== e.to;
});
check(g.edges.length === dd.length && invented.length === 0,
	`no edge is drawn that the store does not hold: ${g.edges.length} drawn, ${dd.length} stored`
	+ (invented.length ? ` — invented: ${JSON.stringify(invented.map(e => e.lid))}` : ''));

// ── 3. Direction: the line starts at `from` and the arrow lands on `to` ──
const nodeAt = {};
g.nodes.forEach(n => { nodeAt[n.did] = n; });
function directed(lid, label) {
	const e = g.edges.find(x => x.lid === lid);
	if (!e || !e.ends) return check(false, `${label}: no drawable edge for ${lid}`);
	const a = nodeAt[e.from], b = nodeAt[e.to];
	if (!a || !b) return check(false, `${label}: an end has no node`);
	// A forward edge leaves the bottom-centre of `from` and lands on the top-centre of `to`.
	const okStart = Math.abs(e.ends.x0 - (a.at.x + a.w / 2)) < 0.001 && Math.abs(e.ends.y0 - (a.at.y + a.h)) < 0.001;
	const okEnd   = Math.abs(e.ends.x3 - (b.at.x + b.w / 2)) < 0.001 && Math.abs(e.ends.y3 - b.at.y) < 0.001;
	check(okStart && okEnd && e.marker === 'url(#gm-arrow)',
		`${label}: starts on ${nameOf[e.from]} (${e.ends.x0},${e.ends.y0}) and the arrow lands on `
		+ `${nameOf[e.to]} (${e.ends.x3},${e.ends.y3}); boxes at ${a.at.y}+${a.h} and ${b.at.y}`);
}
directed(L.ab, 'Alpha part-of Bravo runs Alpha → Bravo');
directed(L.bc, 'Bravo part-of Charlie runs Bravo → Charlie');
// And the back edge, which leaves and arrives on the right-hand side instead.
{
	const e = g.edges.find(x => x.lid === L.ca);
	const a = e && nodeAt[e.from], b = e && nodeAt[e.to];
	check(!!(e && e.ends && a && b)
		&& Math.abs(e.ends.x0 - (a.at.x + a.w)) < 0.001 && Math.abs(e.ends.y0 - (a.at.y + a.h / 2)) < 0.001
		&& Math.abs(e.ends.x3 - (b.at.x + b.w)) < 0.001 && Math.abs(e.ends.y3 - (b.at.y + b.h / 2)) < 0.001
		&& e.marker === 'url(#gm-arrow-back)',
		'the closing edge runs Charlie → Alpha out to the right: '
		+ (e && e.ends ? `(${e.ends.x0},${e.ends.y0}) → (${e.ends.x3},${e.ends.y3})` : 'no such edge drawn'));
}
// A drawn arrow must never point the way the store does not.  Checked over every edge, so a
// swap that happened to leave one edge alone would still be caught.
const wrongWay = g.edges.filter(e => {
	const l = byId[e.lid];
	return !l || dref(l.from) !== e.from;
});
check(wrongWay.length === 0, `no edge is drawn against its stored direction: ${g.edges.length} checked`);

// ── 4. The cycle ─────────────────────────────────────────────────
//
// An oracle worked out a different way from the pane's depth-first search: a Diamond is on a
// cycle when it can reach itself in one or more steps.  Agreeing with a reachability closure
// means something; agreeing with a copy of findCycles would not.
function reaches(edges) {
	const adj = {};
	edges.forEach(e => { (adj[e.from] || (adj[e.from] = [])).push(e.to); });
	const from = {};
	live.forEach(v => {
		const seen = new Set(), stack = [...(adj[v] || [])];
		while (stack.length) {
			const n = stack.pop();
			if (seen.has(n)) continue;
			seen.add(n);
			(adj[n] || []).forEach(m => stack.push(m));
		}
		from[v] = seen;
	});
	return from;
}
const ddE = dd.map(l => ({ id: l.id, from: dref(l.from), to: dref(l.to) }));
const reachAll = reaches(ddE);
const onCycle  = live.filter(v => reachAll[v].has(v));
const backDrawn = g.edges.filter(e => e.back).map(e => e.lid);
// Which edge is the closing one is decided, and stays decided: the search starts at the
// lowest Diamond id (Alpha) and follows out-edges in link-id order, so it walks
// Alpha → Bravo → Charlie and meets Alpha again on `derives-from`.
check(backDrawn.length === 1 && backDrawn[0] === L.ca,
	`exactly the derives-from link closes the cycle: ${JSON.stringify(backDrawn.map(x => linkName[x] || x))}`);
const aBack = g.edges.find(e => e.back), aFwd = g.edges.find(e => !e.back);
check(!!aBack && g.edges.filter(e => e.back).every(e => /\d/.test(e.dash || '') && e.dash !== 'none')
	&& g.edges.filter(e => !e.back).every(e => (e.dash || 'none') === 'none'),
	`the closing edge is dashed and nothing else is: back=${JSON.stringify(aBack && aBack.dash)}, `
	+ `forward=${JSON.stringify(aFwd && aFwd.dash)}`);
// Removing what the pane called closing edges must leave an acyclic graph, or the dashes
// are not marking cycle-closers at all.
const leftover = reaches(ddE.filter(e => !backDrawn.includes(e.id)));
check(live.every(v => !leftover[v].has(v)),
	`with the closing edge gone the rest is acyclic: ${live.filter(v => leftover[v].has(v)).map(v => nameOf[v]).join(',') || 'no cycle left'}`);
const cycled = g.nodes.filter(n => n.cycled).map(n => n.did);
// Both directions against the independent reachability oracle: every Diamond
// really on a cycle is badged (Delta joins through a cross edge, the case a
// back-edge stack segment misses), and nothing else is.
check(cycled.length === 4 && [id.A, id.B, id.C, id.D].every(x => cycled.includes(x)),
	`the Diamonds on the closed cycle are badged, Delta included: ${cycled.map(x => nameOf[x]).sort().join(',')}`);
check(g.nodes.filter(n => n.cycled).every(n => n.cycleBadge === '⟲')
	&& g.nodes.filter(n => !n.cycled).every(n => n.cycleBadge === null),
	`each cycled node carries the ⟲ badge and no other node does: ${g.nodes.filter(n => n.cycleBadge).length} badge(s)`);
check(cycled.every(v => onCycle.includes(v)) && onCycle.every(v => cycled.includes(v)),
	`the badged set IS the oracle's cycle set, both ways: oracle says ${onCycle.map(x => nameOf[x]).sort().join(',')}, `
	+ `pane badges ${cycled.map(x => nameOf[x]).sort().join(',')}`);
check(!(g.nodes.find(n => n.did === id.F) || {}).cycled,
	'Foxtrot, a sink, carries no cycle badge');

// ── 5. Parallel edges ────────────────────────────────────────────
const par = g.edges.filter(e => e.from === id.A && e.to === id.D);
check(par.length === 2, `both relations between Alpha and Delta are drawn: ${par.map(e => e.label).join(', ')}`);
check(par.length === 2 && par[0].d !== par[1].d && par[0].ends && par[1].ends
	&& par[0].ends.x0 !== par[1].ends.x0,
	`and are separated rather than laid on top of each other: x0 ${par.map(e => e.ends && e.ends.x0).join(' vs ')}`);
check(par.length === 2 && new Set(par.map(e => e.label)).size === 2,
	`each parallel line carries its own relation: ${JSON.stringify(par.map(e => e.label))}`);

/// Where each label between one pair actually landed, read off the drawn document.
///
/// A measurement in the TEST is free; the same measurement inside the layout would not be,
/// because a picture that placed a word by how wide the browser drew it would place it
/// differently on another machine.  So this asks the document, and the pane never does.
const labelsBetween = (pg, from, to) => pg.evaluate(({ from, to }) =>
	[...document.querySelectorAll('#graph-body g.graph-edge')]
		.filter(g => g.dataset.from === from && g.dataset.to === to)
		.map(g => {
			const tx = g.querySelector('text.graph-edge-label');
			if (!tx) return null;
			const bb = tx.getBBox();
			return {
				lid: g.dataset.linkId, text: tx.textContent,
				ax: +tx.getAttribute('x'), ay: +tx.getAttribute('y'),
				x: bb.x, y: bb.y, w: bb.width, h: bb.height,
			};
		}).filter(Boolean), { from, to });

/// The two labels between one pair, asserted apart in both senses: their anchors are a
/// label's height apart, and the boxes the words actually occupy do not intersect.
function labelsApart(boxes, what) {
	const u = boxes[0], v = boxes[1];
	const gap  = (u && v) ? Math.abs(u.ay - v.ay) : 0;
	const need = (u && v) ? Math.max(u.h, v.h) : 0;
	check(boxes.length === 2 && gap >= need,
		`${what}: the two labels are set apart ALONG their own lines by at least a label's height — `
		+ `${gap.toFixed(1)}px apart, a label is ${need.toFixed(1)}px tall `
		+ `(${boxes.map(z => `${JSON.stringify(z.text)}@y=${z.ay.toFixed(1)}`).join(', ')})`);
	const hit = !!(u && v)
		&& !(u.x + u.w <= v.x || v.x + v.w <= u.x || u.y + u.h <= v.y || v.y + v.h <= u.y);
	check(boxes.length === 2 && !hit,
		`${what}: and the boxes the words occupy do not intersect — `
		+ boxes.map(z => `${JSON.stringify(z.text)} [${z.x.toFixed(1)},${z.y.toFixed(1)} `
			+ `${z.w.toFixed(1)}×${z.h.toFixed(1)}]`).join(' vs '));
}
// Nudging the PATHS apart was never the whole job: a label rides its own path, so two
// parallel labels landed at the same height and printed one over the other.
labelsApart(await labelsBetween(page, id.A, id.D), 'Alpha ⇉ Delta');

// ── 6. Artefacts, and a link to a Diamond that is gone ───────────
const badged = g.nodes.filter(n => n.badge !== null);
check(badged.length === 1 && badged[0].did === id.A && badged[0].badge === '◈ 1',
	`only Alpha carries an artefact badge, and it reads "◈ 1": ${JSON.stringify(badged.map(n => [nameOf[n.did], n.badge]))}`);
check(!g.edges.some(e => e.from === id.X || e.to === id.X)
	&& !g.nodes.some(n => n.did === id.X),
	'the deleted Diamond has no node and no edge');
check((g.stats || '').includes('1 link points at a Diamond that is gone'),
	`the stats line confesses the dangling link: ${JSON.stringify(g.stats)}`);
check((g.stats || '').includes('6 Diamonds') && (g.stats || '').includes('7 links between Diamonds')
	&& (g.stats || '').includes('1 link closes a cycle'),
	`the stats line counts what is drawn: ${JSON.stringify(g.stats)}`);

// ── 7. The unlinked band ─────────────────────────────────────────
const iso = g.nodes.filter(n => n.isolate);
check(iso.length === 1 && iso[0].did === id.E, `only Echo is marked unlinked: ${iso.map(n => nameOf[n.did]).join(',')}`);
check(g.band !== null && /\S/.test(g.band), `the band is headed: ${JSON.stringify(g.band)}`);
const connected = g.nodes.filter(n => !n.isolate);
const lowestConnected = connected.length ? Math.max(...connected.map(n => n.at.y)) : null;
check(iso.length === 1 && lowestConnected !== null && iso[0].at.y > lowestConnected,
	`the band sits below every connected Diamond: Echo at y=${iso.length ? iso[0].at.y : '(not marked)'}, `
	+ `lowest connected y=${lowestConnected}`);
check(g.nodes.length === 6 && g.nodes.map(n => n.did).join(',') === live.slice().sort().join(','),
	`every Diamond has a node, in id order: ${g.nodes.map(n => nameOf[n.did]).join(',')}`);

// ── 8. The same store draws the same bytes ───────────────────────
const serialise = () => page.evaluate(() => {
	const svg = document.querySelector('#graph-body svg#graph-svg');
	return svg ? new XMLSerializer().serializeToString(svg) : '';
});
const first = await serialise();
const svgs = [first];
for (let i = 0; i < 2; i++) {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'graph');
	await page.waitForTimeout(1200);
	await draw();
	svgs.push(await serialise());
}
check(svgs[0].length > 500 && svgs[1] === svgs[0] && svgs[2] === svgs[0],
	`the same store serialises byte-identical across three loads: ${svgs.map(x => x.length).join('/')} chars`
	+ (svgs[1] === svgs[0] ? '' : ` — first difference at ${[...svgs[0]].findIndex((c, i) => c !== svgs[1][i])}`));

// ── 9. A link changing redraws the pane, with no reload ──────────
g = await drawn();
const before = g.edges.length;
const newLink = await wasm(async (app, a) =>
	await app.add_link(a.d, 'diamond:' + a.d, 'diamond:' + a.f, 'mentions', '', 'user'),
	{ d: id.D, f: id.F });
await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-links-changed')));
await page.waitForTimeout(1200);
let g2 = await drawn();
check(g2.edges.length === before + 1 && g2.edges.some(e => e.lid === newLink),
	`a new link appears on the event alone, no reload: ${before} → ${g2.edges.length} edge(s)`);
await wasm(async (app, a) => await app.remove_link(a.owner, a.lid), { owner: id.D, lid: newLink });
await page.evaluate(() => document.dispatchEvent(new CustomEvent('daimond-links-changed')));
await page.waitForTimeout(1200);
g2 = await drawn();
check(g2.edges.length === before && !g2.edges.some(e => e.lid === newLink),
	`and a removed link goes the same way: ${g2.edges.length} edge(s)`);

// ── 10. A node opens its Diamond ─────────────────────────────────
await page.click(`g.graph-node[data-diamond-id="${id.C}"] rect.graph-node-box`, { force: true });
await page.waitForTimeout(1200);
const cur = await page.evaluate(() => (window.DaimondDiamond.current() || {}).id || null);
check(cur === id.C, `clicking a node selects that Diamond: ${nameOf[cur] || cur} (wanted Charlie)`);

// The dev server proxies /api to a gateway that is either absent (502 from the proxy) or
// running and unwilling to serve this throwaway identity (401, 402).  None of the three is the
// pane: the Graph draws from OPFS and asks the network for nothing whatever, so whichever
// answer the gateway happens to be giving today is the environment talking, not this suite.
// Everything else a page logs is still an error this run has to answer for.
const gatewayNoise = /(401 \(Unauthorized\)|402 \(Payment Required\)|502 \(Bad Gateway\))/;
const errsA = errors(s).filter(e => !gatewayNoise.test(e));
check(errsA.length === 0, `no console errors beyond the gateway's answer: ${JSON.stringify(errsA.slice(0, 3))}`);
await s.close();

// ── 11. The empty paths, on a profile that has never held anything ──
const PROFILE_B = scratch('graph-profile-empty');
fs.rmSync(PROFILE_B, { recursive: true, force: true });
const b = await open({ name: 'graphB', connect: false, profile: PROFILE_B });
await b.page.waitForTimeout(2000);
await b.page.evaluate(() => { DaimondPanels.show('graph'); DaimondGraph.refresh(); });
await b.page.waitForTimeout(1000);
const bare = await b.page.evaluate(() => ({
	empty: [...document.querySelectorAll('#graph-body p.graph-empty')].map(e => e.textContent),
	svg:   !!document.querySelector('#graph-body svg#graph-svg'),
}));
check(bare.empty.length === 1 && /no Diamonds yet/i.test(bare.empty[0]) && !bare.svg,
	`with no Diamonds at all the pane says so and draws nothing: ${JSON.stringify(bare)}`);

const bIds = await b.page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return [await app.create_diamond('Only one'), await app.create_diamond('And another')];
});
await b.page.evaluate(() => DaimondGraph.refresh());
await b.page.waitForTimeout(1000);
const noLinks = await b.page.evaluate(() => ({
	empty: [...document.querySelectorAll('#graph-body p.graph-empty')].map(e => e.textContent),
	nodes: [...document.querySelectorAll('#graph-body g.graph-node')].map(g => g.dataset.diamondId),
	edges: document.querySelectorAll('#graph-body g.graph-edge').length,
	iso:   document.querySelectorAll('#graph-body g.graph-node.isolate').length,
	band:  (document.querySelector('#graph-body text.graph-band') || {}).textContent ?? null,
	stats: (document.querySelector('#graph-body .graph-stats') || {}).textContent ?? null,
}));
// The hint promised "the picture appears here" from ABOVE the band it was pointing at: the
// Diamonds were already drawn, right underneath it, in the band that says they are unlinked.
// A hint that has to be read past the thing it describes is not a hint, so it is gone -- the
// band and the stats line say the same thing where the thing itself is.
check(noLinks.empty.length === 0 && !!noLinks.band && /\S/.test(noLinks.band),
	`Diamonds but no links: no hint stands over the boxes, and the band speaks for itself — `
	+ `hint ${JSON.stringify(noLinks.empty)}, band ${JSON.stringify(noLinks.band)}`);
check(noLinks.nodes.length === 2 && bIds.every(x => noLinks.nodes.includes(x)) && noLinks.edges === 0,
	`and the Diamonds are still drawn: ${noLinks.nodes.length} node(s), ${noLinks.edges} edge(s), ${noLinks.iso} unlinked`);
check((noLinks.stats || '').includes('2 Diamonds') && (noLinks.stats || '').includes('0 links'),
	`the stats line is still there and honest: ${JSON.stringify(noLinks.stats)}`);
await shot(b, 'graph-empty');

// ── 12. Two LONG relations between one pair ──────────────────────
// The case the overlap was reported against, built on its own: one pair, two relations, both
// far too long to be pulled apart by the eighteen pixels the paths are nudged.
const longIds = await b.page.evaluate(async (a) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return [
		await app.add_link(a[0], 'diamond:' + a[0], 'diamond:' + a[1], 'is-a-precondition-for', '', 'user'),
		await app.add_link(a[0], 'diamond:' + a[0], 'diamond:' + a[1], 'supersedes-and-replaces', '', 'user'),
	];
}, bIds);
await b.page.evaluate(() => DaimondGraph.refresh());
await b.page.waitForTimeout(1000);
const twoLong = await labelsBetween(b.page, bIds[0], bIds[1]);
check(longIds.every(x => typeof x === 'string' && x.length > 0) && twoLong.length === 2,
	`two long relations between one pair are both drawn and both labelled: ${JSON.stringify(twoLong.map(z => z.text))}`);
labelsApart(twoLong, 'two long relations between one pair');
await shot(b, 'graph-parallel-labels');
const errsB = errors(b).filter(e => !gatewayNoise.test(e));
check(errsB.length === 0, `no console errors on the empty session: ${JSON.stringify(errsB.slice(0, 3))}`);
await b.close();

console.log('\n' + out.join('\n'));
if (known.length) console.log(`\nKNOWN, REPORTED NOT ASSERTED:\n  - ${known.join('\n  - ')}`);
console.log(bad === 0 ? `\nALL ${out.length} CHECKS PASSED` : `\n${bad} of ${out.length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
