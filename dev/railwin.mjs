// railwin.mjs -- how many of a phone rail list's tiles its window holds (ownereye R4,
// D-20261020-12), from the geometry the page reports, so a node test can feed it the
// geometry of any hour without a browser.
//
// g: { clientHeight, scrollTop, top, tiles: [{ top, bottom }] }, `top` the list's
// inner top edge and the tiles drawn ones, in page order.
//
// The count is of WHOLE tiles in the window at rest (scrolled to its top), which is
// the ruling's own unit. Until RAIL-FLOOR (25 Oct 2026) R4 divided the window by the
// first two tiles' distance, and in the hour after midnight a "Yesterday" head fell
// between them: 358 px read as 4.02 tiles of 89 while it held five whole ones. The same
// division let a head elsewhere pass a window short of its fifth tile.

/// How many whole tiles the window holds at rest.
export function windowTiles(g) {
	let n = 0;
	for (const b of g.tiles) if (b.bottom - g.top + g.scrollTop <= g.clientHeight + 0.5) n++;
	return n;
}

/// R4's findings for one list: [] when its window holds five whole tiles.
export function railWinFindings(sel, g) {
	const n = windowTiles(g);
	if (n >= 5) return [];
	const cut = g.tiles[n];
	const short = cut ? Math.ceil(cut.bottom - g.top + g.scrollTop - g.clientHeight) : 0;
	return [`${sel} window ${g.clientHeight} px holds ${n} whole tiles at rest, want >= 5${cut ? ` (tile ${n + 1} cut by ${short} px)` : ''}`];
}
