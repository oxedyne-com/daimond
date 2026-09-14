// verify_gatherwake.mjs — a worker ending WAKES a blocking `gather`, rather than
// the wait having to notice on its own timer.
//
// Turn 55, 2026-09-14: the daimon spawned w21, then called `gather` five times --
// timeout_s 600, 600, 300, 120, 94, about 28.6 minutes of full-priced rounds --
// each of which ran its own timeout out in full and answered "No worker finished
// … Carry on." w21 was genuinely still running each time, so nothing here was
// wrong about any ONE call; what was missing is that nothing told the daimon a
// finishing worker would answer the very call it is blocking inside AT ONCE, so
// it never had a reason to ask for the full wait rather than a short, guessed one.
//
// `DaimondWorkers.awaitReports` (`www/js/daimond.js`, since 96b6ff1f, 2026-09-13)
// already does this: a worker's own ending calls `settleAwaits`, which resolves
// any gather blocking on it there and then. This file is that mechanism's own
// regression test, kept SEPARATE from `verify_spawn_gather.mjs` on purpose: that
// file dispatches six workers across four scenarios in one page before this one
// would run, and a seventh worker started there measures resource exhaustion in
// that browser context as often as it measures the wake -- a `waker` run stuck at
// `status:'running'` with `gathered` never set, not a real timing result. One
// page, one worker, nothing behind it to interact with.
//
// The round-cap half of turn 55 -- w21's 112 rounds against a `worker_max_rounds`
// of 100 -- is a pure engine property with no page-side behaviour of its own
// (`hold_to_worker`, `at_the_cap`, both in Rust), so it is pinned there, fast and
// exactly: `test_a_workers_true_ceiling_is_the_leg_times_its_continuations_00` in
// `src/agent.rs`. Driving two hundred real rounds through a browser here would
// cost minutes to prove what that test proves in milliseconds, and prove nothing
// a browser adds.
//
//   node dev/verify_gatherwake.mjs
//   node dev/verify_gatherwake.mjs --break nopush   # must fail something
import { open, newChat, shot, mockLog, clearMockLog } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['nopush'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Every `tool` reply on the wire whose content carries `needle`. Lifted from
/// `verify_spawn_gather.mjs` rather than shared, the way that file's own copy is
/// not shared further up either: three lines, and a shared helper module for it
/// would outweigh what it saves.
const toolRepliesWith = (wire, needle) => wire.flatMap((m) => (m.messages || [])
	.filter((x) => x.role === 'tool' && typeof x.content === 'string'
		&& x.content.includes(needle)));

const s = await open({ name: 'gatherwake' + (BREAK ? '-' + BREAK : '') });
const { page } = s;
await newChat(s);

// `nopush` removes the one thing that settles a gather early: the call a
// worker's own ending makes into a gather that is blocking on it. Without it a
// `gather` can only be answered by its own timer -- polling in every way that
// matters even though nothing here calls it twice -- which is turn 55's shape,
// reproduced on purpose to prove this file would have caught it.
if (BREAK === 'nopush') {
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers || !window.DaimondWorkers.settleAwaits) return false;
		window.DaimondWorkers.settleAwaits = function () {};
		return true;
	});
	if (!applied) {
		console.error("break 'nopush': no settle to take away, so nothing was broken.");
		process.exit(2);
	}
}

// ── A worker ending two seconds into a sixty-second gather answers in a few ──
clearMockLog();
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"waker","task":"@slow 2000"}'
	+ ' ;; gather {"names":["waker"],"timeout_s":60}');
await page.keyboard.press('Enter');
// TWO PHASES, not one check of "is it 0": `awaiting.length` reads 0 both BEFORE
// the round reaches the `gather` call and AFTER it settles, so a single check
// for 0 can pass at t≈0 -- before anything has happened -- and prove nothing.
// First wait for it to become nonzero, which is the gather actually blocking;
// only THEN start the clock on how long it takes to empty again.
const started = await page.waitForFunction(
	() => !!(window.DaimondWorkers) && window.DaimondWorkers.awaiting.length > 0,
	null, { timeout: 8000, polling: 50 }).catch(() => null);
check('the gather actually started blocking on the worker', !!started);
const t1 = Date.now();
const woke = await page.waitForFunction(
	() => !!(window.DaimondWorkers) && window.DaimondWorkers.awaiting.length === 0,
	null, { timeout: 6000, polling: 50 }).catch(() => null);
const elapsed = Date.now() - t1;
check('the worker ending WOKE the gather in a few seconds, not the full sixty',
	!!woke && elapsed < 6000, `${elapsed} ms (worker took ~2000 ms, timeout_s was 60)`);
await page.waitForTimeout(BREAK === 'nopush' ? 0 : 1500);
const wire = mockLog();
check('and the tool result carried its report',
	toolRepliesWith(wire, '### waker').length >= 1,
	`${toolRepliesWith(wire, '### waker').length} such tool repl(y|ies)`);
await shot(s, 'gatherwake-1-woken');

await s.close();

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
