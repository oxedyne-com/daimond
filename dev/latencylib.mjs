// latencylib.mjs -- the arithmetic the latency instrument shares (U0 of the sync re-plan, 2026-10-08).
//
// `dev/lens.mjs latency`, `dev/verify_latency.mjs` and the soak's LATENCY judgement all read the same
// `arrive` records (`DEBUG_SHARE.arrive`, www/js/debugshare.js) and answer the same question against the
// same targets, so the percentile rule and the targets live here once.
//
// TARGETS are the sync re-plan's section 1 table. L1 is a tile (a row of a turn) reaching another
// device, L2 an edit (a rename), L3 a turn's last row held saved-real. L5, the 409s per device per hour,
// is zero.

export const TARGETS = {
	tile:   { p50: 2000, p90: 4000 },		// L1
	edit:   { p50: 2000, p90: 5000 },		// L2
	commit: { p90: 5000 },					// L3
	f409:   0,								// L5, per device per hour
};

/// Nearest-rank percentile of an ASCENDING array; null for an empty one.
export function pctile(sorted, p) {
	if (!sorted.length) return null;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/// "840 ms" under a second, "2.4 s" above, "-" for none.
export function fmtMs(ms) {
	if (ms === null || ms === undefined) return '-';
	return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s';
}

/// n, P50, P90 and max of the `ms` of some arrival records. A negative `ms` is one clock ahead of
/// the other, not a fast delivery, so it is counted as `skew` and left out; a record with no
/// stamp (`ms` not a number) is counted as `unstamped`.
export function summarise(recs) {
	const ms = [];
	let skew = 0, unstamped = 0;
	for (const r of recs) {
		if (typeof r.ms !== 'number') { unstamped++; continue; }
		if (r.ms < 0) { skew++; continue; }
		ms.push(r.ms);
	}
	ms.sort((a, b) => a - b);
	return { n: ms.length, p50: pctile(ms, 0.5), p90: pctile(ms, 0.9), max: ms.length ? ms[ms.length - 1] : null, skew, unstamped };
}

/// Does a summary meet the target for its kind? `why` names each figure that misses.
export function judge(kind, s) {
	const t = TARGETS[kind];
	if (!t) return { pass: true, why: [] };
	const why = [];
	if (!s.n) why.push('nothing arrived');
	if (s.n && t.p50 !== undefined && s.p50 > t.p50) why.push(`P50 ${fmtMs(s.p50)} > ${fmtMs(t.p50)}`);
	if (s.n && t.p90 !== undefined && s.p90 > t.p90) why.push(`P90 ${fmtMs(s.p90)} > ${fmtMs(t.p90)}`);
	return { pass: !why.length, why };
}
