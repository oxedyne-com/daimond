/* ============================================================
   Test -- r542 QA A, F2: a worker's turn facts are the attempt's that billed.
   ------------------------------------------------------------
   One meter fed the worker's sink for the whole session. After a key re-mint the
   dead attempt is cleared (`run.text`, `run.tools`, the journal) and the task runs
   again on a NEW app, so the tokens billed are the new attempt's alone -- while the
   meter's tool calls, failures, stalls and first-event time still counted both, and
   `ft` also counted the slot raise and `Files.reknow` that run before the turn.

   The fix starts a fresh meter where each attempt starts, beside `runTurnCapped`.
   Asserted on the source, read from the worker's own block of daimond.js: the
   worker's run cannot be loaded standalone (it needs the wasm app).
   ============================================================ */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};

// The worker's block: from its meter's declaration to its `finally`, which bills the
// last attempt through `billAttempt` (r543 QA F-A2-2).
const a = SRC.indexOf('var wmeter');
const b = SRC.indexOf('} finally {', SRC.indexOf('await runTurnCapped(run.task);', a));
const blk = (a >= 0 && b > a) ? SRC.slice(a, b) : '';
check("the worker's block is found", !!blk);

// Every call that starts an attempt, and where each fresh meter is made.
const calls = [...blk.matchAll(/await runTurnCapped\(/g)].map((m) => m.index);
const metas = [...blk.matchAll(/wmeter = turnMeter\(Date\.now\(\)\)/g)].map((m) => m.index);
check('two attempts can start (the first and the re-mint retry)', calls.length === 2, 'calls=' + calls.length);
check('the declaration makes no meter: nothing before the first attempt is measured',
	/^var wmeter = null;/.test(blk), blk.slice(0, 80));
calls.forEach((c, i) => {
	// The nearest meter made before this attempt, with no other attempt in between.
	const prev = metas.filter((m) => m < c).pop();
	const between = prev === undefined ? '' : blk.slice(prev, c);
	check('attempt ' + (i + 1) + ' starts on a fresh meter of its own',
		prev !== undefined && !/runTurnCapped\(/.test(between.slice(1))
		&& !/await (DaimondModels|Files|scope)/.test(between),
		prev === undefined ? 'no meter before it' : between.slice(0, 200));
});
check('the bill reads the meter of the attempt that ran, if one did',
	SRC.includes("(run.prov && run.prov.rid) || '', wmeter ? wmeter.facts('w') : null);"));

console.log(`\nworker meter (r542 QA A F2): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
