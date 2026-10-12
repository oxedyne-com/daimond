// dev/verdict.mjs -- the one place a verifier's run is judged empty.
//
// 12 Oct 2026: verify_history_gate printed "all arms held" and exited 0 after running
// ZERO arms, because a kit leaked `ONLY` into it. A green line over nothing proves
// nothing, so every verifier ends through `guardRan` (or `verdict`, which calls it):
// a run that made no check, or skipped an arm its filter named, prints RAN NO CHECKS
// and exits 4 -- distinct from 1 (a check failed) and 2 (could not start).
//
// Plain node, no browser: a verifier that does not use the harness imports it too.

export const NO_CHECKS_EXIT = 4;

/// An arm filter read from `env` (`ONLY=P1,P5`): `want(k)` says whether arm `k` runs,
/// and remembers every arm it was asked about, so a name that matched none is caught.
export function armFilter(env) {
	const names = (process.env[env] || '').split(',').map((x) => x.trim()).filter(Boolean);
	const asked = new Set();
	const want = (k) => { asked.add(k); return names.length === 0 || names.includes(k); };
	want.env    = env;
	want.names  = names;
	want.unrun  = () => names.filter((n) => !asked.has(n));
	return want;
}

/// Ends the process with RAN NO CHECKS (exit 4) when `ran` is 0, or when any filter
/// named an arm that was never reached. Otherwise returns, and the verifier reports.
export function guardRan(ran, ...filters) {
	const unrun = [];
	for (const f of filters) for (const n of f.unrun()) unrun.push(`${f.env}=${n}`);
	if (ran > 0 && unrun.length === 0) return;
	const why = ran > 0 ? `the filter named arm(s) that never ran: ${unrun.join(', ')}`
		: 'zero checks were made' + (unrun.length ? ` (the filter named ${unrun.join(', ')}, which matched no arm)` : '');
	console.log(`\nRAN NO CHECKS -- ${why}; an empty run is not a pass`);
	process.exit(NO_CHECKS_EXIT);
}

/// Prints the run's last line and exits: 4 for an empty run, 1 if any check failed, else 0.
/// `bad` is the list (or count) of failures; `green` the line a clean run prints.
export function verdict({ ran, bad, green = 'all checks passed', filters = [] }) {
	guardRan(ran, ...filters);
	const n = Array.isArray(bad) ? bad.length : bad;
	if (n === 0) { console.log('\n' + green); process.exit(0); }
	console.log(`\n${n} check(s) FAILED` + (Array.isArray(bad) ? ': ' + bad.join(' ; ') : ''));
	process.exit(1);
}
