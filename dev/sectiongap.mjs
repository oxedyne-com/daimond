// gateway: none
// sectiongap.mjs -- r535 U3, the by-role gate's section-gap check. D-13 (owner, 5 Oct 2026):
// "spacing serves a purpose, to delineate panel sections", one value per role.
//
// Two gaps are measured, each against its own canonical value:
//
//   section-gap  the white space above a section head that has something above it in its panel:
//                the head's top less the bottom of the nearest item that ends above it.
//   head-gap     the same, where what ends above the head is a title row (a panel or dialog
//                title, or a control that shares its line, such as the close button).
//
// The canonical value is the mode, per configuration and kind, voted by the heads that are not
// exempt. A head more than TOL px off it is a fault. A head with nothing above it is the first
// in its panel and has no gap to measure. Pure: `report()` in verify_consistency.mjs hands it
// the captured items, so it runs on a saved capture and needs no browser.
export const TOL = 1.5;
const TITLES = /^(panel-title|dialog-title)$/;
// A dock panel's header row (`.railhead`, which the phone lifts into the sheet's grabber) is the panel's chrome: the white space between
// it and the body is the dock's one body inset, shared by every dock panel, and not a gap between two sections of the body.
const CHROME = /\.railhead(\.|$)/;
// A scroller, by the class or id it carries (`#admin-scroll`, `.msheet-scroll`).
const SCROLL = /scroll/;
const DEEP = 7; // `anc` is cut at seven levels: an item that deep may still be inside the scroller

// Mode of a list of numbers; a tie goes to the smaller, so the canonical value never depends on capture order.
const modeOf = (xs) => {
	const c = new Map(); for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
	return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
};

// Where an item's flow ends: its own box, or the row it sits in when that is taller (a tick or radio row is a 44px tap box that centres its
// text, so the text's own bottom stands above the row's). `lb` is the bottom of the item's `label`, where the capture found one.
const bottom = (o) => Math.max(o.r[1] + o.r[3], o.lb == null ? -Infinity : o.lb);
const anc = (o) => o.anc || [];
// Inside the scroller, as far as the chain shows: an item whose chain reaches its panel without meeting the scroller is outside it, and one
// whose chain is cut before the panel may still be in.
const inside = (o, sc) => { const j = anc(o).indexOf(o.panel); return anc(o).slice(0, j < 0 ? undefined : j).includes(sc) || j < 0 && anc(o).length >= DEEP; };
const chrome = (o) => CHROME.test(o.sig || '') || anc(o).some((a) => CHROME.test(a));

// One row per visible section head that has an item above it. `items` carry `roleName`, `surface`, `panel`, `view` and `r` ([x, y, w, h]).
export function measureGaps(items) {
	const byPanel = new Map();
	for (const it of items) {
		if (!it.view) continue;
		const k = it.surface + '|' + it.panel;
		if (!byPanel.has(k)) byPanel.set(k, []);
		byPanel.get(k).push(it);
	}
	const rows = [];
	for (const L of byPanel.values()) {
		for (const h of L) {
			if (h.roleName !== 'section-head') continue;
			// What stands above a head in the flow is in its own scroller. An item outside it counts only when it ends above the scroller's
			// content (the title row over a drawer): the status strip below, or a head scrolled out of sight beneath it, is not above anything.
			const sc = anc(h).find((a) => SCROLL.test(a));
			const top = sc ? Math.min(...L.filter((o) => anc(o).includes(sc)).map((o) => o.r[1])) : null;
			let prev = null;
			for (const o of L) {
				if (o === h || chrome(o)) continue;
				const bot = bottom(o);
				if (sc && !inside(o, sc) && bot > top + 1) continue;
				if (bot <= h.r[1] + 1 && (!prev || bot > bottom(prev))) prev = o;
			}
			if (!prev) continue; // first in its panel
			// The title row: the nearest item is a title, or sits on a title's line (its close button).
			const under = TITLES.test(prev.roleName) || L.some((t) => TITLES.test(t.roleName) && t.r[1] < prev.r[1] + prev.r[3] && prev.r[1] < t.r[1] + t.r[3]);
			// The head's own previous sibling stands in the flow too: a row whose box runs lower than its captured text (padding outside the item) ends where
			// the sibling does, so the white space is measured from there. Without it the same margin reads wider under a padded row than under a note.
			const above = h.ps != null && h.ps <= h.r[1] + 1 ? Math.max(bottom(prev), h.ps) : bottom(prev);
			rows.push({ kind: under ? 'head-gap' : 'section-gap', cfg: h.surface.split('/')[0], gap: h.r[1] - above, head: h, prev });
		}
	}
	return rows;
}

// Faults in the report's layout form, and the exempt rows with the reason each was let through. `exempt(head, kind)` answers a reason or null.
export function checkGaps(items, exempt = () => null) {
	const rows = measureGaps(items), faults = [], allowed = [], canon = {};
	const groups = new Map();
	for (const r of rows) {
		const why = exempt(r.head, r.kind);
		if (why) { allowed.push({ ...r, why }); continue; }
		const k = r.kind + '|' + r.cfg;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(r);
	}
	for (const [k, L] of groups) {
		if (L.length < 2) continue;
		const [m] = modeOf(L.map((r) => r.gap));
		canon[k] = m;
		for (const r of L) {
			if (Math.abs(r.gap - m) <= TOL) continue;
			faults.push({ kind: r.kind, cfg: r.cfg, canon: m + 'px', v: r.gap + 'px', sig: r.head.sig, text: r.head.text.slice(0, 40), surfaces: [r.head.surface.split('/')[1]], role: 'section-head', after: r.prev.sig });
		}
	}
	return { faults, allowed, canon, measured: rows.length };
}
