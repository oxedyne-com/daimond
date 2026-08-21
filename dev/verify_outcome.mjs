// verify_outcome.mjs — a tool's outcome travels as DATA, and four consumers read it.
//
// THE DEFECT. `toolFailed` was `/^\s*Error\b/i` over a tool result's TEXT. It missed
// `Refused:`, which `refusal_line` (src/tools.rs) prefixes unconditionally across
// some twenty sites — so every fence refusal drew as a completed step, was
// journalled as a SUCCESS, was never telemetered as `tool.fail`, and told
// `DaimondSignals.noteTool` the tool had worked. Widening the regex was not the
// fix: four consumers were each guessing back a fact the tool layer already had.
// `CallOutcome { Done, Refused, Failed }` and `call_outcome()` have been sitting in
// src/tools.rs the whole time. `AgentEvent::ToolResult` now carries the answer as a
// third field, `outcome`, and `toolFailed` is deleted — dev/CONTRACT_OUTCOME.md.
//
// FIVE PROPERTIES, and they are the four consumers plus the store:
//
//   1. A REFUSAL IS SHOWN AS A REFUSAL — its own state, in the warning colour and
//      NAMED, not the danger red of a broken tool and not a silent tick.
//   2. AND JOURNALLED AS ONE. `J.toolDone(..., failed)` says the call did not
//      complete, so a recovered turn does not resurrect it as a success.
//   3. AND TELEMETERED AS ONE. `tel('tool.fail', …)` fires, so which capability is
//      being refused in the field is visible at all.
//   4. AND REPORTED TO THE OPTIMISER AS ONE. `noteTool(name, ok)` gets `false`.
//   6. AND AN OUTCOME THE BUILD DOES NOT RECOGNISE SAYS SO — loudly, because a
//      quiet one is a stale engine wearing a tick — WITHOUT rewriting the tool's
//      own words to say it. This is the state the app is in right now, between the
//      two lanes, and it is a property rather than an accident.
//   5. AND STORED WITH THE TOOL LOG, so the one prose reader left —
//      `outcomeOfStoredText`, for conversations written before the field existed —
//      serves a set that stops growing rather than one that grows for ever.
//
// WHY THE FIXTURE LIES ON PURPOSE. Turn A is truthful: three tool calls whose
// outcomes are what their text says. Every check would pass on turn A alone with
// the OLD text-sniffing code still in place, so turn A proves nothing about where
// the fact came from. Turn B runs the same three tools and stamps outcomes that
// CONTRADICT the prose — a successful write called `refused`, a `Refused:` and an
// `Error:` both called `done`. A consumer still reading the text is caught there
// and nowhere else. Contradicting the prose is not a licence the app has: the
// engine's word is the truth by contract, and turn B is the only way to ask
// whether the app believes that.
//
// WHAT IS SIMULATED, AND SAID OUT LOUD. The producing half is another lane's:
// until it lands, `ev.outcome` is `undefined` in a live run. So this file stands in
// for it — `DaimondApp.prototype.run_turn` is wrapped in the served wasm glue, and
// the sink it passes on stamps each `tool_result` from a plan this file owns. The
// stamp is not derived from anything the app can see; it is the test's own arranged
// truth, which is exactly what the engine's field will be. CHECK 0 reports whether
// the engine ITSELF sent an outcome, and fails until the other lane lands. It is
// meant to fail today. Nothing else in this file falls back to reading text.
//
// EACH PROPERTY PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_outcome.mjs --break sniff    # turn B's checks fail: the text wins again
//   node dev/verify_outcome.mjs --break flat     # 1 fails: a refusal is drawn as a failure
//   node dev/verify_outcome.mjs --break journal  # 2 fails: journalled as a success
//   node dev/verify_outcome.mjs --break tel      # 3 fails: never telemetered
//   node dev/verify_outcome.mjs --break signals  # 4 fails: the Optimiser is told it worked
//   node dev/verify_outcome.mjs --break nostore  # 5 fails: the history exception grows
//   node dev/verify_outcome.mjs --break quiet    # 6 fails: a missing outcome draws as a tick
//   node dev/verify_outcome.mjs --break mangle   # 6 fails: friendlyError rewrites the tool's words
//   node dev/verify_outcome.mjs --break friendly # 1 fails: the refusal's own sentence is prettified away
//   node dev/verify_outcome.mjs --break alarm    # 1 fails: a call that completed is drawn as broken
//   node dev/verify_outcome.mjs --break swap     # 1 fails: a failure is drawn as a refusal
//   node dev/verify_outcome.mjs                  # and then, clean but for check 0
//
//   eval "$(bash dev/world.sh 6 --up)"
//   node dev/verify_outcome.mjs
//
// Needs dev/serve.mjs and the mock. No gateway. No wasm rebuild — the wasm is the
// one already built; only its JS glue is wrapped, and only in this file's browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, chat, storedChats, signInAs, scratch, shot, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is a list of [find, replace, howManyTimes] over www/js/daimond.js. The
// count is asserted before the browser opens, so an anchor that has moved stops the
// run rather than patching nothing and reporting green.
const BREAKS = {
	// Every consumer reads the result TEXT again — the state before the seam. Turn A
	// still passes under this, which is the point of turn B.
	sniff: [
		["if (ev.outcome !== 'done') tel('tool.fail'",
		 "if (outcomeOfStoredText(ev.content || '') !== 'done') tel('tool.fail'", 1],
		["ev.content || '', ev.outcome !== 'done');",
		 "ev.content || '', outcomeOfStoredText(ev.content || '') !== 'done');", 1],
		["DaimondSignals.noteTool(ev.name || '', ev.outcome === 'done');",
		 "DaimondSignals.noteTool(ev.name || '', outcomeOfStoredText(ev.content || '') === 'done');", 1],
		["renderToolResult(ev.name || '', ev.content || '', ev.outcome);",
		 "renderToolResult(ev.name || '', ev.content || '', outcomeOfStoredText(ev.content || ''));", 2],
	],
	// Refused and failed collapse back into one state, as they were when nothing
	// could tell them apart.
	flat:    [["var refused = outcome === 'refused';", "var refused = false;", 1]],
	journal: [["ev.content || '', ev.outcome !== 'done');", "ev.content || '', false);", 1]],
	tel:     [["if (ev.outcome !== 'done') tel('tool.fail'", "if (false) tel('tool.fail'", 1]],
	signals: [["DaimondSignals.noteTool(ev.name || '', ev.outcome === 'done');",
	           "DaimondSignals.noteTool(ev.name || '', true);", 1]],
	// The outcome is not written down with the log, so history is back to guessing.
	nostore: [["pendingTool.outcome = ev.outcome || '';", "pendingTool.outcome = '';", 1]],
	// An outcome the build does not recognise is drawn as a success -- the quiet
	// failure mode, where a stale engine looks like a working one.
	quiet:   [["var failed  = !refused && outcome !== 'done';",
	           "var failed  = outcome === 'failed';", 1]],
	// friendlyError is let loose on anything not drawn as a success again, which is
	// what turns "Wrote 6 bytes" into "Could not reach that endpoint".
	mangle:  [["resPre.textContent = outcome === 'failed' ? friendlyError(result) : stripAnsi(result);",
	           "resPre.textContent = failed ? friendlyError(result) : stripAnsi(result);", 1]],
	// The plausible over-correction: a refusal is not a success, so put it through
	// the error prettifier too -- and lose the sentence the fence wrote for the user.
	friendly: [["resPre.textContent = outcome === 'failed' ? friendlyError(result) : stripAnsi(result);",
	            "resPre.textContent = outcome !== 'done' ? friendlyError(result) : stripAnsi(result);", 1]],
	// The other over-correction: everything that is not a refusal is a failure, so a
	// call that completed is drawn as a broken one.
	alarm:   [["var failed  = !refused && outcome !== 'done';", "var failed  = !refused;", 1]],
	// The two non-done states collapse the other way: a failure is drawn as a refusal.
	swap:    [["var refused = outcome === 'refused';", "var refused = outcome !== 'done';", 1]],
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const APP_SRC  = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
const GLUE_SRC = fs.readFileSync(path.join(WWW, 'pkg/oxedyne_daimond.js'), 'utf8');

let damaged = APP_SRC;
if (BREAK) {
	for (const [find, repl, want] of BREAKS[BREAK]) {
		const got = damaged.split(find).length - 1;
		if (got !== want) {
			console.error(`--break ${BREAK}: expected ${want} occurrence(s) of\n  ${find}\nbut found ${got}; `
				+ 'the anchor has moved and this break would patch nothing');
			process.exit(2);
		}
		damaged = damaged.split(find).join(repl);
	}
}

// The producing half of the seam, stood in for. Appended to the wasm glue, which is
// where `DaimondApp` is declared, so the wrap is on the class the app really uses.
// `__plan` is set from this file before each turn; with no plan, nothing is stamped.
const SHIM = `
/* ── dev/verify_outcome.mjs: stands in for AgentEvent::ToolResult's outcome field ── */
const __vo_run_turn = DaimondApp.prototype.run_turn;
DaimondApp.prototype.run_turn = function (msg, onEvent) {
	return __vo_run_turn.call(this, msg, function (ev) {
		if (ev && ev.type === 'tool_result') {
			try {
				// What the ENGINE sent, recorded before anything is written over it.
				(globalThis.__seen = globalThis.__seen || []).push(
					ev.outcome === undefined ? null : String(ev.outcome));
				const plan = globalThis.__plan || [];
				const at   = globalThis.__at | 0;
				if (at < plan.length) { ev.outcome = plan[at]; globalThis.__at = at + 1; }
			} catch (e) { /* the shim may never break the run it observes */ }
		}
		return onEvent(ev);
	});
};
`;

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({
	name:    'outcome',
	profile: scratch('pw', 'outcome' + (BREAK ? '-' + BREAK : '')),
	route:   async (page) => {
		await page.route('**/pkg/oxedyne_daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: GLUE_SRC + SHIM,
		}));
		if (BREAK) await page.route('**/js/daimond.js', (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: damaged,
		}));
	},
});
const { page: p } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

/// Arm the shim with the outcomes to stamp, in the order the results come back, and
/// start the recorders that the four consumers write into.
const arm = (plan) => p.evaluate((plan) => {
	globalThis.__plan = plan;
	globalThis.__at   = 0;
	globalThis.__seen = [];
	globalThis.__tel  = [];
	globalThis.__jrn  = [];
	// The journal and the telemetry client are both read at CALL time by the app
	// (`var J = window.DaimondJournal` at the top of the turn, `window.DaimondTelemetry`
	// inside `tel`), so wrapping them here is enough and nothing has to be reloaded.
	if (window.DaimondJournal && !window.DaimondJournal.__wrapped) {
		const orig = window.DaimondJournal.toolDone;
		window.DaimondJournal.toolDone = function (turnId, chatId, callId, result, failed) {
			globalThis.__jrn.push(!!failed);
			return orig.apply(this, arguments);
		};
		window.DaimondJournal.__wrapped = true;
	}
	if (window.DaimondTelemetry && !window.DaimondTelemetry.__wrapped) {
		const orig = window.DaimondTelemetry.emit;
		window.DaimondTelemetry.emit = function (name, n) {
			globalThis.__tel.push(name + ':' + n);
			return orig.apply(this, arguments);
		};
		window.DaimondTelemetry.__wrapped = true;
	}
	if (window.DaimondSignals) window.DaimondSignals.reset();
	return true;
}, plan);

/// Every tool block on screen, in order, as the reader sees it.
const blocks = () => p.evaluate(() => [...document.querySelectorAll('#chat-output .tool-block')]
	.map((b) => {
		const tag = b.querySelector('.tool-outcome');
		const res = b.querySelector('.tool-result');
		return {
			cls:     b.className,
			failed:  b.classList.contains('failed'),
			refused: b.classList.contains('refused'),
			word:    tag ? tag.textContent.trim() : '',
			colour:  tag ? tag.style.color : '',
			border:  b.style.borderColor || '',
			text:    res ? res.textContent.slice(0, 120) : '',
		};
	}));

/// This fixture's three tool logs, as the STORE holds them: raw result text and
/// the outcome written down beside it.
///
/// Read from storage rather than off the screen, because the screen is what several
/// of the checks below are about -- a fixture assertion that reads the rendering is
/// not a fixture assertion, and under `--break flat` it failed for the thing it was
/// supposed to hold still.
const toolLogs = async () => {
	const chats = await storedChats(s);
	const out = [];
	chats.forEach((c) => (c.messages || []).forEach((m) => {
		if (m.role === 'tool_log' && /ok\.txt|must-not-write|not-here/.test(String(m.args || ''))) out.push(m);
	}));
	return out.slice(-3);
};

const recorded = () => p.evaluate(() => ({
	seen:  globalThis.__seen || [],
	tel:   globalThis.__tel  || [],
	jrn:   globalThis.__jrn  || [],
	tools: (window.DaimondSignals ? window.DaimondSignals.snapshot().tools : {}) || {},
}));

/// The three-call fixture, written into the chat now in focus.
///
/// A write that lands, a write the FENCE refuses, and a read of a file that is not
/// there. One turn, one round: `@tools` returns all three calls together, so the
/// three results arrive in this order and the stamping plan lines up with them.
const fixture = async () => {
	const dir = await p.evaluate(() => {
		const f = window.DaimondAttach.focus();
		return window.DaimondAttach.chatScratch(f.id);
	});
	return '@tools '
		+ `file_write {"path":"${dir}/ok.txt","content":"landed"}`
		+ ' ;; '
		+ 'file_write {"path":"/etc/daimond-must-not-write.txt","content":"nope"}'
		+ ' ;; '
		+ `file_read {"path":"${dir}/not-here.txt"}`;
};

try {
	// ── Turn A: the outcomes agree with the prose ────────────────
	await newChat(s);
	await arm(['done', 'refused', 'failed']);
	await chat(s, await fixture(), { timeout: 60000 });
	const a  = await blocks();
	const ar = await recorded();
	const al = await toolLogs();
	await shot(s, 'outcome-truthful');

	// THE FIXTURE IS THE FIXTURE. Every assertion below is about three particular
	// results; a turn that produced something else would make them meaningless. Asked
	// of the STORED result text, which no rendering decision can move.
	check(a.length === 3 && al.length === 3
		&& !/^\s*(?:Error|Refused)\b/i.test(String(al[0].content || ''))
		&& /^\s*Refused\b/i.test(String(al[1].content || ''))
		&& /^\s*Error\b/i.test(String(al[2].content || '')),
		'THE FIXTURE RAN: a write that landed, a fence refusal, and a read that failed',
		`${a.length} tool block(s); `
			+ al.map((m) => JSON.stringify(String(m.content || '').slice(0, 26))).join(' / '));

	// ── 0. The seam itself ───────────────────────────────────────
	//
	// EXPECTED TO FAIL until the engine sends the field. Everything below runs on
	// this file's stand-in for it, and this is the check that says so out loud
	// rather than letting the rest imply the seam is live.
	const live = ar.seen.filter((o) => o === 'done' || o === 'refused' || o === 'failed').length;
	check(live === a.length && a.length > 0,
		'THE ENGINE ITSELF SENDS THE OUTCOME (fails until the Rust lane lands)',
		`the engine sent ${JSON.stringify(ar.seen)} for ${a.length} result(s)`);

	// ── 1. Shown as a refusal ────────────────────────────────────
	check(a.length === 3 && a[1].refused && !a[1].failed,
		'A REFUSAL IS SHOWN AS A REFUSAL — its own state, not the red of a broken tool',
		a.length === 3 ? `classes ${JSON.stringify(a[1].cls)}` : 'the fixture did not run');
	check(a.length === 3 && /refused/i.test(a[1].word) && /warn/.test(a[1].border),
		'and it is NAMED as well as coloured, so it does not rest on amber against red',
		a.length === 3 ? `word ${JSON.stringify(a[1].word)}, border ${JSON.stringify(a[1].border)}` : '');
	check(a.length === 3 && a[2].failed && !a[2].refused && /failed/i.test(a[2].word),
		'while a real failure keeps the failure state, so the two are told apart',
		a.length === 3 ? `classes ${JSON.stringify(a[2].cls)}, word ${JSON.stringify(a[2].word)}` : '');
	check(a.length === 3 && !a[0].failed && !a[0].refused && a[0].word === '',
		'and a call that completed is left alone',
		a.length === 3 ? `classes ${JSON.stringify(a[0].cls)}` : '');
	// The refusal's own sentence, unmangled. `friendlyError` collapses paragraphs and
	// swallows any string naming a number into its status-code arm, so a refusal put
	// through it would lose the very text this seam exists to start showing.
	check(a.length === 3 && /^\s*Refused\b/i.test(a[1].text),
		'and the refusal is shown in its own words, not put through friendlyError',
		a.length === 3 ? JSON.stringify(a[1].text.slice(0, 70)) : '');

	// ── 2, 3, 4. Journalled, telemetered, reported ───────────────
	check(JSON.stringify(ar.jrn) === JSON.stringify([false, true, true]),
		'AND JOURNALLED AS ONE — the refusal is written down as a call that did not complete',
		`toolDone(failed) = ${JSON.stringify(ar.jrn)}`);
	const failsA = ar.tel.filter((e) => e.indexOf('tool.fail:') === 0);
	check(failsA.length === 2,
		'AND TELEMETERED AS ONE — tool.fail fires for the refusal and the failure, not the write',
		`${failsA.length} tool.fail event(s): ${JSON.stringify(failsA)}`);
	check((ar.tools.file_write || {}).calls === 2 && (ar.tools.file_write || {}).failed === 1
		&& (ar.tools.file_read || {}).failed === 1,
		'AND REPORTED TO THE OPTIMISER AS ONE — noteTool is told the refused call did not work',
		JSON.stringify(ar.tools));

	// ── 5. Stored with the log ───────────────────────────────────
	check(JSON.stringify(al.map((m) => m.outcome)) === JSON.stringify(['done', 'refused', 'failed']),
		'AND STORED WITH THE TOOL LOG, so the history exception stops growing',
		`stored outcomes ${JSON.stringify(al.map((m) => m.outcome))}`);

	// ── Turn B: the outcomes CONTRADICT the prose ────────────────
	//
	// The check that makes the six above mean something. Every one of them would
	// pass with the old text-sniffing code still in place, because on turn A the
	// text and the truth agree. Here they do not, and only a consumer reading the
	// FIELD can get this right.
	await newChat(s);
	await arm(['refused', 'done', 'done']);
	await chat(s, await fixture(), { timeout: 60000 });
	const b  = await blocks();
	const br = await recorded();
	const bl = await toolLogs();
	await shot(s, 'outcome-crossed');

	check(b.length === 3 && bl.length === 3
		&& !/^\s*(?:Error|Refused)\b/i.test(String(bl[0].content || ''))
		&& /^\s*Refused\b/i.test(String(bl[1].content || ''))
		&& /^\s*Error\b/i.test(String(bl[2].content || '')),
		'THE CROSSED FIXTURE RAN: three results whose text says the opposite of their outcome',
		`${b.length} tool block(s); `
			+ bl.map((m) => JSON.stringify(String(m.content || '').slice(0, 26))).join(' / '));
	check(b.length === 3 && b[0].refused,
		'A SUCCESSFUL-LOOKING RESULT THE ENGINE CALLED REFUSED IS DRAWN AS REFUSED',
		b.length === 3 ? `classes ${JSON.stringify(b[0].cls)}, text ${JSON.stringify(b[0].text.slice(0, 40))}` : '');
	check(b.length === 3 && !b[1].refused && !b[1].failed && !b[2].refused && !b[2].failed,
		'and a "Refused:" and an "Error:" the engine called done are drawn as done',
		b.length === 3 ? `${JSON.stringify(b[1].cls)} / ${JSON.stringify(b[2].cls)}` : '');
	check(JSON.stringify(br.jrn) === JSON.stringify([true, false, false]),
		'the journal follows the engine, not the words',
		`toolDone(failed) = ${JSON.stringify(br.jrn)}`);
	const failsB = br.tel.filter((e) => e.indexOf('tool.fail:') === 0);
	check(failsB.length === 1,
		'telemetry follows the engine: one failure reported, and it is the one that reads as a success',
		`${failsB.length} tool.fail event(s)`);
	check((br.tools.file_write || {}).calls === 2 && (br.tools.file_write || {}).failed === 1
		&& !((br.tools.file_read || {}).failed),
		'and so does the Optimiser',
		JSON.stringify(br.tools));

	// ── 5b. And history redraws it from the STORE, not the prose ─
	//
	// A reload is the honest way to ask: nothing of the turn is left in memory, so
	// what comes back is what was written down.
	const storedB = bl.map((m) => m.outcome);
	check(JSON.stringify(storedB) === JSON.stringify(['refused', 'done', 'done']),
		'the crossed outcomes are what got stored, so a reload cannot fall back to reading the text',
		`stored outcomes ${JSON.stringify(storedB)}`);

	await p.reload({ waitUntil: 'domcontentloaded' });
	await p.waitForTimeout(1200);
	await signInAs(s, 'outcome');
	await p.waitForTimeout(1500);
	let after = await blocks();
	if (!after.length) {
		// The reload did not land back in the conversation; open it the way a user does.
		await p.evaluate(() => {
			const box = document.querySelector('#session-list .chat-box');
			if (box) box.click();
		});
		await p.waitForTimeout(1200);
		after = await blocks();
	}
	await shot(s, 'outcome-reloaded');
	check(after.length === 3 && after[0].refused && !after[1].refused && !after[1].failed,
		'AND A RELOADED CONVERSATION REDRAWS THE REFUSAL FROM THE STORED FIELD',
		after.length === 3 ? `${JSON.stringify(after[0].cls)} / ${JSON.stringify(after[1].cls)}`
			: `${after.length} tool block(s) after reload`);

	// ── 6. An outcome this build does not know ──────────────────
	//
	// A WORD THE ENGINE MIGHT SEND THAT THIS PAGE HAS NEVER HEARD OF -- a newer
	// engine against an older bundle, or a fourth state added upstream. It must be
	// flagged rather than waved through as a tick, because "I do not understand what
	// happened" and "it worked" are the two answers that must never look alike.
	//
	// THIS TEST USED TO DISARM THE SHIM and read what the engine really sent, which
	// was nothing at all while the Rust half was unlanded. That case is now
	// unreachable: the engine always sends one of the three, so disarming produces
	// two ordinary DONE calls and the check silently stopped testing anything. Which
	// is the same defect this whole file exists to prevent, arriving in the file
	// itself the moment its subject shipped.
	await newChat(s);
	await arm(['quinquagenarian', 'quinquagenarian']);
	const dirC = await p.evaluate(() => {
		const f = window.DaimondAttach.focus();
		return window.DaimondAttach.chatScratch(f.id);
	});
	// A file of TWO LINES, written and then read back. The second call's result is
	// the instrument: `friendlyError` collapses all whitespace to single spaces, so a
	// result that keeps its line break is a result that was not put through it.
	await chat(s, '@tools '
		+ `file_write {"path":"${dirC}/two.txt","content":"line one\\nline two"}`
		+ ' ;; '
		+ `file_read {"path":"${dirC}/two.txt"}`, { timeout: 60000 });
	const c = await blocks();
	await shot(s, 'outcome-absent');
	check(c.length === 2 && c.every((x) => (x.failed || x.refused) && x.word !== ''),
		'AN OUTCOME THE BUILD DOES NOT RECOGNISE IS FLAGGED, not drawn as a tick',
		c.map((x) => `${JSON.stringify(x.cls)}/${JSON.stringify(x.word)}`).join(' '));
	check(c.length === 2 && c[1].text.indexOf('\n') >= 0
		&& /line one/.test(c[1].text) && /line two/.test(c[1].text),
		"but the tool's own words are left alone — friendlyError is for a STATED failure",
		c.length === 2 ? JSON.stringify(c[1].text.slice(0, 60)) : `${c.length} tool block(s)`);

	const errs = errors(s);
	if (errs.length) console.log(`  note  ${errs.length} console error(s): ${errs.slice(0, 3).join(' | ')}`);
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
