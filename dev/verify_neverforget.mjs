// verify_neverforget.mjs — reliability for the longest time: a Diamond's objectives and
// open tasks survive forty turns, five forced context folds and two daimon Folds, with
// nothing but REQUIREMENTS.md, DECISIONS.md and STATE.md to remember them by.
//
// WHAT THIS IS WRITTEN FROM. `dev/verify_reqfiles.mjs` proves the three files exist, are in
// the prompt and are capped; `dev/verify_foldabsorb.mjs` proves ONE fold files its notes and
// a second identical one files nothing twice. Neither drives the thing the design of
// 2026-09-15 §5 was written for: a Diamond worked for a long time, by a daimon that may or
// may not follow the never-forget rule, whose session is folded and cleared more than once.
// This is that run.
//
// That is one claim with four halves, and any three can pass while the fourth is a lie:
//
//   A. THE TURN-END CHECK MINTS A VERSION AND A LOG LINE FOR EVERY TICK. A task moved from
//      `- [ ]` to `- [x]` earns its own `kind:"task"` record, carrying the task id, the
//      version, and what the turn's ledger shows behind the claim -- an edit to something
//      else, a worker's report, or neither, flagged.
//   B. THE TAIL NOTE FIRES EXACTLY WHEN THE LEDGER AND THE FILES DISAGREE, AND NEVER TWICE
//      RUNNING. A turn that wrote a file or read a report and left REQUIREMENTS.md and
//      STATE.md untouched gets ONE line saying so; the very next turn, even if the same
//      thing is still true, gets nothing -- the daimon has not had a turn to act on the
//      first warning yet.
//   C. THE BRIEFING NAMES WHAT IS STILL OPEN, byte-stable within a turn because it is parsed
//      from the same read of REQUIREMENTS.md the hot prompt block carries.
//   D. AND NONE OF IT DEPENDS ON THE SESSION. Two daimon Folds clear the conversation to
//      nothing; five context folds replace most of it with a notice. What ground truth this
//      run seeded lives in the FILES, and a daimon asked afterwards, with an empty session,
//      still reads the right objectives and the right open tasks off them.
//
// EACH PROVED AGAINST THE WORLD IT IS AGAINST, one switch at a time
// (`Agent::Limits`'s four -- see `dev/CRYSTAL_CONTRACT.md` §5 and the commit that added them):
//
//   node dev/verify_neverforget.mjs --break noabsorb    # the compactor answers in prose, so
//                                                       # a context fold's own open thread is
//                                                       # never filed under ## Unfiled: B and
//                                                       # C stay green, the one check on the
//                                                       # fold's own contribution goes red.
//   node dev/verify_neverforget.mjs --break notask      # task_log off: A goes red alone.
//   node dev/verify_neverforget.mjs --break nonote      # tail_note off: B goes red alone.
//   node dev/verify_neverforget.mjs --break notoptrhee  # briefing_top3 off: C's named list
//                                                       # goes red, its counts stay green.
//   node dev/verify_neverforget.mjs                     # and then, clean.
//
// THE BREAKS REMOVE THE EFFECT, NOT THE IMPLEMENTATION, exactly as `dev/verify_reqfiles.mjs`
// and `dev/verify_foldabsorb.mjs` do: `notask`/`nonote`/`notoptrhee` are `Agent::set_tune`
// switches reached through `window.__vf.set_tune`, and `noabsorb` is the mock's own fold
// sidecar. No line of the engine is rewritten by any of them.
//
//   eval "$(bash dev/world.sh 36 --up)" ; eval "$(bash dev/world.sh 36 --env)"
//   node dev/verify_neverforget.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');
const FOLD = LOG + '.fold';   // how the compactor answers a context fold

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = ['noabsorb', 'notask', 'nonote', 'notoptrhee'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error('no such break: ' + BREAK + '\nhave: ' + BREAKS.join(' '));
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

const REQ = 'REQUIREMENTS.md', DEC = 'DECISIONS.md', ST = 'STATE.md';
const RECONCILE_NOTE = '[Daimond: this turn changed files but REQUIREMENTS.md and STATE.md '
	+ 'were not updated; next turn, reconcile them first]';
const FOLD_OPEN_ITEM = 'whether anything above was left unfinished';   // structuredFold's own

// The fold's compactor answers the fixed FoldNotes shape unless `noabsorb` asks for prose.
fs.writeFileSync(FOLD, BREAK === 'noabsorb' ? 'garbage' : 'structured');

// ── Ground truth ──────────────────────────────────────────────────────────
//
// 3 objectives, 9 tasks, 3 under each. Six are ticked over the run, with three different
// kinds of backing behind the tick; three are left open, one per objective, so "open/done
// sets exactly match ground truth" is a real assertion and not a vacuous one.
const REQUIREMENTS_SEED =
	'# Requirements\n\n'
	+ 'What this Diamond exists to do. A task leaves this file by being ticked with the '
	+ 'version that did it, or by the user striking it out.\n\n'
	+ '## O1 Ship the parser\n\n'
	+ '- [ ] T1 Handle nested braces\n'
	+ '- [ ] T2 Reject invalid UTF-8\n'
	+ '- [ ] T3 Stream large files without loading them whole\n\n'
	+ '## O2 Harden the sync path\n\n'
	+ '- [ ] T4 Retry a dropped connection\n'
	+ '- [ ] T5 Detect a stale manifest\n'
	+ '- [ ] T6 Refuse a parcel over the ceiling\n\n'
	+ '## O3 Ship the guide\n\n'
	+ '- [ ] T7 Document the CLI flags\n'
	+ '- [ ] T8 Add a worked example\n'
	+ '- [ ] T9 Proofread the whole thing\n\n'
	+ '## Unfiled\n\n'
	+ '## Done\n';
const DECISIONS_SEED = '# Decisions\n\nOne dated line each, with the reason. Append only.\n';
const STATE_SEED = '# State\n\nWhere things are now.\n\n## Facts\n\n## Next step\n\nnothing yet\n';

const OBJECTIVES = ['O1 Ship the parser', 'O2 Harden the sync path', 'O3 Ship the guide'];
const DONE = ['T1', 'T3', 'T4', 'T6', 'T7', 'T9'];
const OPEN = ['T2', 'T5', 'T8'];
const TASK_TEXT = {
	T1: 'Handle nested braces', T2: 'Reject invalid UTF-8',
	T3: 'Stream large files without loading them whole',
	T4: 'Retry a dropped connection', T5: 'Detect a stale manifest',
	T6: 'Refuse a parcel over the ceiling',
	T7: 'Document the CLI flags', T8: 'Add a worked example', T9: 'Proofread the whole thing',
};
// Which backing each tick earns, and which turn (1-40) it happens on.
const TICKS = [
	{ turn: 3,  id: 'T1', backing: 'edit' },
	{ turn: 11, id: 'T3', backing: 'report' },
	{ turn: 17, id: 'T4', backing: 'edit' },
	{ turn: 25, id: 'T6', backing: 'none' },   // the UNVERIFIED case
	{ turn: 31, id: 'T7', backing: 'report' },
	{ turn: 36, id: 'T9', backing: 'edit' },
];
const DECISION_TURNS = { 6: 'DECISION-1 because reason one', 14: 'DECISION-2 because reason two',
	21: 'DECISION-3 because reason three', 28: 'DECISION-4 because reason four' };
// Silent work: a turn that writes a real file but never touches REQUIREMENTS.md or STATE.md.
// 8 and 9 are consecutive, so 9 proves "never twice running"; 23 is isolated, so it proves
// the warning is not silenced for good, only never doubled.
const SILENT_TURNS = new Set([8, 9, 23]);
// `NFG_LITE=1` skips the padded context-fold turns and the two daimon Folds -- everything else
// runs unchanged. For a machine under memory pressure a 200-message padded request is the one
// thing that has been seen to hang (`node dev/verify_foldabsorb.mjs`'s own folding turn does the
// same, under the same conditions, whoever wrote it): checks A-C and E still run and still prove
// what they prove, and D6/2/3 below read the flag rather than reporting a false break.
const LITE = !!process.env.NFG_LITE;
const PAD_BEFORE  = new Set(LITE ? [] : [5, 13, 20, 27, 34]);   // 5 forced context folds
const DAIMONFOLD_AFTER = new Set(LITE ? [] : [15, 29]);        // 2 daimon Folds, session cleared after

const s = await open({ name: 'neverforget' + (BREAK ? '-' + BREAK : '') });
const { page } = s;

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777',
		{ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'neverforget');
	await connectMock(s);
	await page.waitForTimeout(1500);

	const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
	await page.evaluate(async (mock) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		window.__m  = m;
		window.__vf = new m.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
		window.__vf.set_context_cap(16000);
	}, MOCK);
	if (BREAK === 'notask')     await page.evaluate(() => window.__vf.set_tune('{"task_log":false}'));
	if (BREAK === 'nonote')     await page.evaluate(() => window.__vf.set_tune('{"tail_note":false}'));
	if (BREAK === 'notoptrhee') await page.evaluate(() => window.__vf.set_tune('{"briefing_top3":false}'));

	const write = (p, t) => page.evaluate((a) => window.__m.write_file(a.p, a.t), { p, t });
	const read  = (p) => page.evaluate((x) => window.__m.read_file(x).catch(() => ''), p);
	const of    = (leaf) => read(`diamonds/${dia}/${leaf}`);

	const dia = await page.evaluate((nm) => window.__vf.create_diamond(nm), 'Neverforget');
	check('A0. a Diamond to work in', !!dia, dia);

	await write(`diamonds/${dia}/${REQ}`, REQUIREMENTS_SEED);
	await write(`diamonds/${dia}/${DEC}`, DECISIONS_SEED);
	await write(`diamonds/${dia}/${ST}`,  STATE_SEED);

	// A hard ceiling on any one page call, so a turn that hangs reports WHERE it hung
	// instead of the whole run sitting until the outer `timeout` kills it with no diagnosis.
	const withTimeout = (p, ms, label) => Promise.race([
		p,
		new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT after ${ms}ms: ${label} `
			+ `-- console errs so far: ${JSON.stringify((s.errs || []).slice(-5))}`)), ms)),
	]);

	// One steer_crystal call, chained: `prior` is exactly what the last call returned, the
	// same object the browser would persist and hand back next time.
	const steer = (instruction, prior) => withTimeout(page.evaluate(async (a) => {
		const out = await window.__vf.steer_crystal(a.id, a.instruction, '[]', '[]', '[]',
			a.prior, () => {});
		return Array.from(out || []).map((m) => ({
			role: m.role, content: m.content || '',
			tool_calls: m.tool_calls, tool_call_id: m.tool_call_id,
		}));
	}, { id: dia, instruction, prior }), 20000, 'steer(' + instruction.slice(0, 30) + ')');

	// A conversation too big to send whatever the running `prior` was, built fresh each time
	// exactly as `verify_foldabsorb.mjs`'s `foldingTurn` builds it -- many small messages
	// rather than a few huge ones, so `tail_start` has something it may cut.
	const padded = () => {
		const out = [];
		for (let i = 0; i < 200; i++) {
			out.push({ role: i % 2 ? 'assistant' : 'user',
				content: 'padding turn ' + i + ' ' + 'filler words that fill a window '.repeat(20) });
		}
		return out;
	};

	const foldPropose = (delta) => page.evaluate(async (a) => {
		try { return { ok: await window.__vf.fold_propose(a.id, a.delta) }; }
		catch (e) { return { err: String((e && e.message) || e) }; }
	}, { id: dia, delta });
	const foldApply = (prop) => page.evaluate(async (a) =>
		window.__vf.fold_apply(a.id, a.prop, 'the delta', 'daimon Fold via verifier'),
		{ id: dia, prop });

	let prior = [];
	let folds = 0, daimonFolds = 0;
	const noteTurns = [];
	for (let n = 1; n <= 40; n++) {
		if (PAD_BEFORE.has(n)) prior = padded();

		let instruction;
		const tick = TICKS.find((t) => t.turn === n);
		if (tick) {
			const line = `- [ ] ${tick.id} ${TASK_TEXT[tick.id]}`;
			const ticked = `- [x] ${tick.id} ${TASK_TEXT[tick.id]} (verified)`;
			const editCall = `file_write {"path":"diamonds/${dia}/notes-${tick.id}.md",`
				+ `"content":"verified ${tick.id}"} ;; `;
			const tickCall = `file_edit {"path":"diamonds/${dia}/${REQ}",`
				+ `"old_string":"${line}","new_string":"${ticked}"}`;
			if (tick.backing === 'edit') {
				instruction = `@tools ${editCall}${tickCall}`;
			} else if (tick.backing === 'report') {
				instruction = `@tools spawn_agent {"name":"w${tick.id}","task":"@text done"} ;; `
					+ `gather {"names":["w${tick.id}"],"timeout_s":8} ;; ${tickCall}`;
			} else {
				instruction = `@tool ${tickCall}`;
			}
		} else if (DECISION_TURNS[n]) {
			instruction = `@tool file_edit {"path":"diamonds/${dia}/${DEC}",`
				+ `"old_string":"Append only.\\n","new_string":"Append only.\\n\\n`
				+ `- 2026-09-15 ${DECISION_TURNS[n]}\\n"}`;
		} else if (SILENT_TURNS.has(n)) {
			instruction = `@tool file_write {"path":"diamonds/${dia}/scratch-${n}.md",`
				+ `"content":"real work, turn ${n}"}`;
		} else {
			instruction = `@text turn ${n} noted`;
		}

		const t0 = Date.now();
		prior = await steer(instruction, prior);
		console.log(`  .. turn ${n}/40 done in ${Date.now() - t0}ms (${instruction.slice(0, 40)})`);
		if (PAD_BEFORE.has(n)) {
			// A fold happened iff the notice landed: its own opening sentence, unmistakable.
			if (prior.some((m) => (m.content || '').startsWith('[Daimond folded the earlier part'))) {
				folds++;
			}
		}
		const last = prior.length ? prior[prior.length - 1] : null;
		if (last && last.role === 'user' && last.content === RECONCILE_NOTE) {
			noteTurns.push(n);
		}

		if (DAIMONFOLD_AFTER.has(n)) {
			const p = await foldPropose('MOCKDELTA turn ' + n);
			if (p.ok) { await foldApply(p.ok); daimonFolds++; }
			prior = [];   // the Fold button's other half: a fresh session
		}
	}

	check('1. forty scripted turns ran', true, '40/40');
	if (LITE) {
		console.log('  (NFG_LITE: no padded turn and no daimon Fold was asked for)');
	} else {
		check('2. five context folds fired', folds === 5, folds + ' fired');
		check('3. two daimon Folds committed', daimonFolds === 2, daimonFolds + ' committed');
	}

	// ── A. TASK RECORDS ───────────────────────────────────────────────
	//
	// ONE ASSERTION, KEPT THE SAME WHATEVER BREAK IS RUNNING, exactly as
	// `dev/verify_reqfiles.mjs` and `dev/verify_foldabsorb.mjs` do it: `notask` must turn this
	// green check red on its own, not be given a different check to pass instead.
	const log = JSON.parse(await page.evaluate((i) => window.__vf.log_read(i), dia));
	const taskRecs = log.filter((r) => r.kind === 'task');
	check('A1. one kind:"task" record per tick, six of them',
		taskRecs.length === TICKS.length,
		taskRecs.length + ' of ' + TICKS.length + ': ' + taskRecs.map((r) => r.task).join(','));
	for (const t of TICKS) {
		const r = taskRecs.find((x) => x.task === t.id);
		check(`A2. ${t.id} logged with the version and the ledger's own account`,
			!!r && r.crystal_version > 0
				&& (t.backing === 'edit'   ? r.note === 'an edit'
				  : t.backing === 'report' ? r.note === 'a worker report'
				  : /UNVERIFIED/.test(r.note || '')),
			r ? `v${r.crystal_version} note=${r.note}` : '(no record)');
	}

	// ── B. THE TAIL NOTE ─────────────────────────────────────────────
	//
	// Every decision turn (6,14,21,28) writes DECISIONS.md alone, and every silent turn
	// (8,9,23) writes a real file too -- both leave REQUIREMENTS.md and STATE.md exactly as
	// they were, so both are turns the tail note is FOR. A tick turn (3,11,17,25,31,36) never
	// qualifies: the tick is itself the write to REQUIREMENTS.md, so the files are never
	// byte-identical on a tick turn. 9 is the one turn missing from an otherwise complete list
	// of qualifying turns -- suppressed because 8, immediately before it, said the same thing
	// already. Kept as one assertion under `nonote` too: an empty `noteTurns` does not equal
	// this list, so the check goes red on its own rather than being swapped for one that reads
	// "and nothing appeared", which a bug that fired the note on the WRONG six turns would also
	// pass.
	const EXPECT_NOTES = [6, 8, 14, 21, 23, 28];
	check('B1. the warning appeared exactly on the turns that earned it',
		JSON.stringify(noteTurns) === JSON.stringify(EXPECT_NOTES), JSON.stringify(noteTurns));
	check('B2. and NEVER on turn 9 — the same reason, one turn later, never twice running',
		!noteTurns.includes(9), JSON.stringify(noteTurns));

	// ── C. THE BRIEFING ──────────────────────────────────────────────
	const wire = await page.evaluate(async (i) => {
		const w = JSON.parse(await window.__vf.wire_system(i, '[]', '[]', '[]'));
		return String((w && w.machine) || '');
	}, dia);
	const briefLine = (wire.match(/\d+ objectives?, \d+ open tasks?[^\n]*/) || [''])[0];
	check('C1. the briefing states the true count: 3 objectives, 3 open tasks',
		briefLine.startsWith('3 objectives, 3 open tasks'), briefLine);
	check('C2. and names the three that are actually open: T2, T5, T8',
		briefLine.includes('T2 ') && briefLine.includes('T5 ') && briefLine.includes('T8 '),
		briefLine);

	// ── D. GROUND TRUTH SURVIVES THE SESSION BEING CLEARED ────────────
	const finalReq = await of(REQ);
	check('D1. all three objectives are named, byte for byte',
		OBJECTIVES.every((o) => finalReq.includes('## ' + o)),
		OBJECTIVES.filter((o) => !finalReq.includes('## ' + o)).join(', ') || 'all present');
	const doneOk = DONE.every((id) => new RegExp('\\[x\\]\\s*' + id + '\\b').test(finalReq));
	const openOk = OPEN.every((id) => new RegExp('\\[ \\]\\s*' + id + '\\b').test(finalReq));
	check('D2. the DONE set matches ground truth exactly: ' + DONE.join(','), doneOk,
		'checked ' + DONE.length);
	check('D3. the OPEN set matches ground truth exactly: ' + OPEN.join(','), openOk,
		'checked ' + OPEN.length);
	// Not ticked NOR mentioned as done anywhere it should not be -- a leaked or duplicated
	// tick is as much a lie as a lost one.
	check('D4. no open task was ticked by mistake',
		OPEN.every((id) => !new RegExp('\\[x\\]\\s*' + id + '\\b').test(finalReq)));

	const finalDec = await of(DEC);
	check('D5. every scripted decision reached DECISIONS.md',
		Object.values(DECISION_TURNS).every((d) => finalDec.includes(d)),
		Object.values(DECISION_TURNS).filter((d) => !finalDec.includes(d)).join(', ') || 'all four');

	if (LITE) {
		console.log('  (NFG_LITE: no fold ran, so D6 -- what a fold files -- is not asked)');
	} else if (BREAK === 'noabsorb') {
		check('D6. noabsorb: the fold\'s own open thread is never filed under ## Unfiled',
			!finalReq.includes(FOLD_OPEN_ITEM),
			(finalReq.match(/## Unfiled[\s\S]{0,80}/) || ['(no Unfiled)'])[0].replace(/\n/g, ' '));
	} else {
		check('D6. and the context fold\'s own open thread was filed too, alongside them',
			finalReq.includes(FOLD_OPEN_ITEM),
			(finalReq.match(/## Unfiled[\s\S]{0,80}/) || ['(no Unfiled)'])[0].replace(/\n/g, ' '));
	}

	// ── E. ASKED COLD, WITH THE SESSION CLEARED ───────────────────────
	const asked = await steer(`@tool file_read {"path":"diamonds/${dia}/${REQ}"}`, []);
	const askedResult = (asked.find((m) => m.role === 'tool') || {}).content || '';
	check('E1. asked with no session at all, the daimon still reads the right objectives',
		OBJECTIVES.every((o) => askedResult.includes(o)),
		askedResult.slice(0, 40).replace(/\n/g, ' '));
	check('E2. and the right open tasks',
		OPEN.every((id) => new RegExp('\\[ \\]\\s*' + id + '\\b').test(askedResult)),
		'checked ' + OPEN.length);

	const errs = errors(s).filter((e) => !/502|Bad Gateway|account/i.test(e));
	check('F1. no unexpected console errors', errs.length === 0,
		errs.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	try { fs.unlinkSync(FOLD); } catch { /* the next run writes it again */ }
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
