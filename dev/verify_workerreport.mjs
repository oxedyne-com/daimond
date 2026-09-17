// verify_workerreport.mjs — the Ontheism WORKER-REPORT fix, page half.
//
// A finished worker's report must reach its daimon, and must never be mistaken for
// "nothing found" and re-dispatched. Two faults are closed here (a third, the engine
// nudge, is native and covered by an agent.rs #[test]):
//
//   VARIANT 2 (Workers.gather):
//     - the gather round runs OFF-SCREEN (no `currentDiamond`/`diamondShowingOrRunning`
//       gate), so a report is not withheld when the user looks elsewhere;
//     - a busy Diamond does not DROP the round (the batch is already deleted, so there is
//       no retry): it is delivered when the Diamond next falls idle, or preserved in the
//       conversation (`tellDaimon`) rather than lost;
//     - exactly-once: the batch is deleted AND the runs are marked `gathered`.
//
//   VARIANT 1 (page half — workerEndingNote + the empty-batch note):
//     - `workerEndingNote` switches on the engine's own `ended.how`, so a `silent` /
//       `reasoned_only` worker that RAN TOOLS (`ended.calls > 0`) states its rounds, its
//       tool calls and "check its files before re-dispatching" -- instead of a blank note;
//     - the empty-batch emitter, when the workers DID tool work, points at the files rather
//       than inviting a re-dispatch ("ask again with a narrower task").
//
// Pure node -- `workerEndingNote` is a top-level function driven verbatim; the gather /
// emitter / agent.rs halves are asserted against the shipped source by literal slice. Each
// fix is proven red-first by a `--break` that runs the check against the PRE-FIX shape.
//
//   node dev/verify_workerreport.mjs
//   node dev/verify_workerreport.mjs --break note      # workerEndingNote back to status-only
//   node dev/verify_workerreport.mjs --break offscreen # the gather screen gate back
//   node dev/verify_workerreport.mjs --break busydrop  # the busy round dropped again
//   node dev/verify_workerreport.mjs --break emitter   # the empty-batch note back to "ask again"
//   node dev/verify_workerreport.mjs --break rust      # the agent.rs report nudge removed
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(join(HERE, '..', 'www/js/daimond.js'), 'utf8');
const RUST = readFileSync(join(HERE, '..', 'src/agent.rs'), 'utf8');

const BREAK = (() => { const i = process.argv.indexOf('--break'); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : ''; })();
const BREAKS = ['note', 'offscreen', 'busydrop', 'emitter', 'rust'];
if (BREAK && !BREAKS.includes(BREAK)) { console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`); process.exit(2); }

const ok = [], bad = [];
const check = (name, pass, detail) => { (pass ? ok : bad).push(name); console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : '')); };

// Pull a top-level `function NAME(` body verbatim (one-tab indent), the verify_streammerge
// method used across the suite -- so this drives the shipped code, not a paraphrase.
function slice(name) {
	let start = SRC.indexOf('\tfunction ' + name + '(');
	if (start < 0) throw new Error('could not find ' + name);
	let i = SRC.indexOf('{', start), depth = 0, end = -1;
	for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } } }
	return SRC.slice(start, end);
}

// ── VARIANT 1 (page): workerEndingNote switches on ended.how ────────────────────
{
	// The real function, bound over `withCommas` (its one dependency).
	// eslint-disable-next-line no-new-func
	const real = new Function('withCommas',
		slice('workerEndingNote') + '\nreturn workerEndingNote;')(new Function('n',
		"return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');"));

	// The PRE-FIX version, for the `note` break: it switched on `r.status` ALONE, and
	// `workerEndStatus` maps both silent and reasoned_only to `done`, so a tool-using worker
	// that said nothing drew a BLANK note -- read by the daimon as "nothing found".
	const preFix = (r) => {
		switch (r.status) {
			case 'capped':    return ' — stopped at the round cap';
			case 'spend_cap': return ' — stopped at the spend cap';
			case 'error':     return ' — error';
			case 'stopped':   return ' — stopped';
			default:          return '';
		}
	};
	const note = (BREAK === 'note') ? preFix : real;

	const silentWorker  = { status: 'done', costUsd: 0.1, ended: { how: 'silent',        calls: 3, rounds: 5 } };
	const reasonWorker  = { status: 'done', costUsd: 0.2, ended: { how: 'reasoned_only', calls: 2, rounds: 4 } };
	const answered      = { status: 'done', costUsd: 0.0, ended: { how: 'answered',      calls: 1, rounds: 1 } };
	const noToolSilent  = { status: 'done', costUsd: 0.0, ended: { how: 'silent',        calls: 0, rounds: 1 } };
	const cappedWorker  = { status: 'capped', costUsd: 1.2, ended: { how: 'capped',      calls: 4, rounds: 9 } };

	const sn = note(silentWorker);
	check('(1) a SILENT worker that ran tools names its work and points at the files, not silence',
		/tool call/.test(sn) && /without a final message/.test(sn) && /check its files/i.test(sn) && /3/.test(sn),
		JSON.stringify(sn).slice(0, 90));
	const rn = note(reasonWorker);
	check('(1) a REASONED-ONLY worker that ran tools says the same',
		/tool call/.test(rn) && /check its files/i.test(rn) && /2/.test(rn), JSON.stringify(rn).slice(0, 90));
	check('(1) a worker that actually ANSWERED draws no note (the ordinary case is quiet)',
		note(answered) === '');
	check('(1) a silent worker that ran NO tools is NOT told to check files (there is nothing to check)',
		!/check its files/i.test(note(noToolSilent)));
	check('(1) a CAPPED worker keeps its own note (unchanged by this fix)',
		/round cap/.test(note(cappedWorker)));
}

// ── VARIANT 2 (source): the gather round runs off-screen, is never dropped, once ─
{
	const anchor = SRC.indexOf('var dGath = diamonds.find');
	const real   = anchor >= 0 ? SRC.slice(anchor - 400, anchor + 2600) : '';
	// PRE-FIX shapes for the breaks.
	const preScreen = 'if (!dGath || !diamondShowingOrRunning(b.diamondId)) {\n'
		+ '  this.tellDaimon(b.diamondId, held + "the user was looking at something else.");\n'
		+ '  return;\n}\n setTimeout(function () { runSteer(dGath, instruction, b.depth + 1); }, 0);';
	const preDrop = real.replace(/var deliverGather[\s\S]*?setTimeout\(function \(\) \{ deliverGather\(GATHER_IDLE_TRIES\); \}, 0\);/,
		'setTimeout(function () { runSteer(dGath, instruction, b.depth + 1); }, 0);');
	const gs = (BREAK === 'offscreen') ? preScreen : (BREAK === 'busydrop') ? preDrop : real;

	check('(2) the gather site no longer gates on the screen (off-screen reports are never lost)',
		!/diamondShowingOrRunning\(b\.diamondId\)/.test(gs) && !/currentDiamond\.id !== b\.diamondId/.test(gs),
		'a screen gate is still present');
	check('(2) the gather round is steered BY ID (off-screen / on a runner)',
		/runSteer\(dGath, instruction, b\.depth \+ 1\)/.test(gs));
	check('(2) a busy Diamond is not DROPPED: the round waits for idle (deliverGather on diamondBusy)',
		/deliverGather/.test(gs) && /diamondBusy\(b\.diamondId\)/.test(gs)
		&& /tellDaimon\(b\.diamondId/.test(gs), 'the busy round is dropped, not deferred');
	// Exactly-once is not a break target (it is belt-and-braces over the batch delete); assert it holds.
	if (BREAK !== 'offscreen' && BREAK !== 'busydrop') {
		check('(2) exactly-once: the batch is deleted AND the runs are marked gathered',
			/delete this\.batches\[batch\]/.test(SRC) && /r\.gathered = r\.gathered \|\|/.test(SRC));
	}
}

// ── VARIANT 1 (source): the empty-batch note switches on tool work ──────────────
{
	const at = SRC.indexOf('if (!substance) {');
	const real = at >= 0 ? SRC.slice(at, at + 900) : '';
	const preFix = 'if (!substance) {\n this.tellDaimon(b.diamondId, held + (one ? "it" : "they")'
		+ ' + " stopped before saying anything, so there was nothing to read. Ask again"'
		+ ' + " with a narrower task if the work still matters."); return; }';
	const es = (BREAK === 'emitter') ? preFix : real;
	check('(1) the empty-batch note switches on whether the workers ran tools (`ended.calls > 0`)',
		/ended && r\.ended\.calls > 0/.test(es) && /check its files/i.test(es),
		'still invites a re-dispatch of finished work');
}

// ── VARIANT 1 (native source): the agent.rs report nudge ────────────────────────
{
	const preFix = 'if empty_reply && (reasoned_only > 0 || !resp.thinking.trim().is_empty()) {';
	const rs = (BREAK === 'rust') ? preFix : RUST;
	check('(1/native) agent.rs nudges an empty final reply that made tool calls to write its report',
		/empty_reply && !report_nudged && !claims\.calls\.is_empty\(\)/.test(rs)
		&& /fn report_nudge\(\)/.test(RUST) && /Write your report now/.test(RUST),
		'the report nudge is missing');
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed` + (bad.length ? '' : ' — NOTHING FAILED, so the checks prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
