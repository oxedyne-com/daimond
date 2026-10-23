// gateway: none
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
//   node dev/verify_workerreport.mjs --node            # the pure halves only, no browser
//
// VARIANT 3 drives a real page (a world must be up: `eval "$(bash dev/world.sh N --up)"`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { guardRan } from './verdict.mjs';

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
		// The words the daimon reads when the batch did tool work: its work is in its
		// files, and it is not to be re-dispatched. (It said "check its files" first.)
		/ended && r\.ended\.calls > 0/.test(es) && /work is in its files/i.test(es)
			&& /do not re-dispatch/i.test(es),
		'still invites a re-dispatch of finished work');
}

// ── VARIANT 1 (native source): the agent.rs report nudge ────────────────────────
{
	const preFix = 'if empty_reply && (reasoned_only > 0 || !resp.thinking.trim().is_empty()) {';
	const rs = (BREAK === 'rust') ? preFix : RUST;
	check('(1/native) agent.rs nudges an empty final reply that made tool calls to write its report',
		// `!quiet` (S1M mailquiet): a quiet turn is never nudged to write a report.
		/empty_reply && !quiet && !report_nudged && !claims\.calls\.is_empty\(\)/.test(rs)
		&& /fn report_nudge\(\)/.test(RUST) && /You stopped without a reply/.test(RUST),
		'the report nudge is missing');
}

// ── VARIANT 3 (browser, U3a REP + BILL, UNBLOCK-16 F3/F4): an ending without a verdict ─
//
// A worker that works three rounds (`file_write` each, one path per round) and then goes
// quiet mid-stream is ended `timed_out` by the engine's liveness bound (`__livenessMs` 3 s).
// Its gathered report must hold its own last words AND the three files it left, `ended`
// must say 3 rounds, the bill must be booked once at what the mock reported, the feed must
// carry no round of the run after its `end` row, its session must be kept, and a
// `continue:` re-dispatch must pick that session back up. A Stop mid-run books the rounds
// so far. Skipped under `--break` (pure) and `--node`.
if (!BREAK && !process.argv.includes('--node')) {
	const H = await import('./harness.mjs');
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const lastUser = (m) => {
		const ms = m.messages || [];
		for (let i = ms.length - 1; i >= 0; i--) if (ms[i].role === 'user') return H.contentText(ms[i].content);
		return '';
	};
	const s = await H.open({ name: 'workerreport' });
	const p = s.page;
	await p.waitForFunction(() => !!window.DaimondCore && !!window.DaimondWorkers, null, { timeout: 20000 });
	const runOf = (name) => p.evaluate((n) => {
		const r = (window.DaimondWorkers.runs || []).find((x) => x.name === n);
		if (!r) return null;
		let sess = null;
		try { sess = r.app && r.app.export_session ? Array.prototype.slice.call(r.app.export_session() || []) : null; } catch (e) { sess = null; }
		return { id: r.id, status: r.status, report: r.report || '', ended: r.ended || null,
			cost: r.costUsd || 0, session: !!(r._session && r._session.length), live: sess ? sess.length : -1 };
	}, name);
	const waitEnd = async (name, ms) => {
		const END = ['done', 'error', 'stopped', 'capped', 'spend_cap', 'timed_out', 'blocked'];
		const t0 = Date.now(); let r = null;
		while (Date.now() - t0 < ms) { r = await runOf(name); if (r && END.includes(r.status)) return r; await sleep(250); }
		return r;
	};
	const ledgerSince = (t0) => p.evaluate((t) => (window.DaimondLedger.entries() || [])
		.filter((e) => (e.t || 0) >= t).map((e) => ({ t: e.t, u: e.u || 0, p: e.p || 0 })), t0);
	const near = (a, b) => Math.abs(a - b) <= 1e-6;
	const send = async (text) => { await p.fill('#chat-input', text); await p.keyboard.press('Enter'); };
	// The chat's own scratch folder: the one place a chat's worker may write unasked.
	const scratchDir = () => p.evaluate(() => window.DaimondAttach.chatScratch(window.DaimondAttach.focus().id));

	// (1) timed_out after 3 written rounds.
	await H.newChat(s);
	await p.waitForTimeout(500);
	await p.evaluate(() => {
		window.__livenessMs = 3000;
		window.__ds = [];
		const prev = window.DEBUG_SHARE || {};
		const keep = prev.event;
		window.DEBUG_SHARE = Object.assign(Object.create(prev), { event: (kind, payload) => {
			window.__ds.push({ kind, payload, t: Date.now() });
			try { if (keep) keep.call(prev, kind, payload); } catch (e) {}
		} });
	});
	H.clearMockLog();
	const t0 = await p.evaluate(() => Date.now());
	const dir = await scratchDir();
	const TASK = '@roundsthen 3/200 stall 600000 file_write {"path":"' + dir + '/wrep/f{n}.md","content":"WREP {n}"} @usage 100 50 0.01';
	await send('@tools spawn_agent ' + JSON.stringify({ name: 'wrep', task: TASK })
		+ ' ;; gather {"names":["wrep"],"timeout_s":40} @usage 1 1 0.001');
	const r1 = await waitEnd('wrep', 60000);
	await p.waitForTimeout(3000);			// the gather answers, the chat's next round goes out
	check('(3/rep) the worker ends timed_out on its liveness bound', !!r1 && r1.status === 'timed_out', r1 && r1.status);
	const rounds = (r1 && r1.ended && r1.ended.rounds) || 0;
	check('(3/rep) `ended.rounds` is 3, never 0', rounds === 3, String(rounds));
	const paths = ['wrep/f0.md', 'wrep/f1.md', 'wrep/f2.md'];
	const rep = (r1 && r1.report) || '';
	const hasAll = (t) => paths.every((x) => t.includes(x));
	check('(3/rep) the report holds the last segment\'s words', /Stalling/.test(rep), JSON.stringify(rep.slice(0, 160)));
	check('(3/rep) the report names all 3 files touched, on one line', /Files touched: /.test(rep) && hasAll(rep.split('Files touched: ').pop()),
		JSON.stringify(rep.slice(-200)));
	// What the conductor actually read back: the gather tool result in its next request.
	const gathered = H.mockLog().map((m) => (m.messages || []).filter((x) => x.role === 'tool')
		.map((x) => H.contentText(x.content)).join('\n')).filter((t) => /Files touched|wrep/.test(t)).pop() || '';
	check('(3/rep) the gathered report reaching the conductor holds the words and all 3 paths',
		/Stalling/.test(gathered) && hasAll(gathered), JSON.stringify(gathered.slice(0, 240)));
	// BILL (a): one row for the worker, at the mock's figures for what it delivered.
	const wire = H.mockLog().filter((m) => lastUser(m).startsWith('@roundsthen 3/200'));
	const wantW = wire.reduce((x, m) => x + ((m.answered && m.answered.cost) || 0), 0);
	const rows = await ledgerSince(t0);
	const wrows = rows.filter((e) => e.u >= 0.005);
	check('(3/bill a) the timed_out run books recordSpend once', wrows.length === 1, `${wrows.length} row(s) >= 0.005 of ${rows.length}`);
	check('(3/bill a) at 3 x 0.01 plus the stall attempt\'s reported usage',
		// A stalled stream never reaches its usage frame, so it reports nothing: 0.03 exactly.
		wrows.length === 1 && near(wrows[0].u, wire.slice(0, 3).reduce((x, m) => x + ((m.answered && m.answered.cost) || 0), 0))
			&& near(wrows[0].u, 0.03),
		`row ${wrows.map((e) => e.u.toFixed(4)).join(',')}; mock ${wantW.toFixed(4)} over ${wire.length} request(s), r1 cost ${r1 && r1.cost}`);
	// BILL (c): no round of this run in the feed after its `end` row.
	const feed = await p.evaluate(() => window.__ds || []);
	const endAt = feed.findIndex((e) => e.kind === 'worker' && e.payload && e.payload.at === 'end' && e.payload.w === (r1 && r1.id));
	const after = endAt < 0 ? [] : feed.slice(endAt + 1).filter((e) => e.payload && e.payload.w === (r1 && r1.id)
		&& /^(round|round_meta|stalled)$/.test(e.kind));
	const endRow = endAt >= 0 ? feed[endAt].payload : {};
	check('(3/bill c) no lens round of the run after at:\'end\'', endAt >= 0 && after.length === 0, `end row ${endAt}, ${after.length} after`);
	check('(3/rep) the end row carries r, calls and tc', endRow.r === 3 && endRow.calls === 3 && endRow.tc === 3,
		JSON.stringify({ r: endRow.r, calls: endRow.calls, tc: endRow.tc, ended: r1 && r1.ended }));
	// BILL (d): the session is kept, and a `continue:` re-dispatch picks it up.
	check('(3/bill d) export_session is non-null after timed_out', !!r1 && r1.session && r1.live > 0, r1 && `${r1.session} ${r1.live}`);
	await p.evaluate(() => { delete window.__livenessMs; });
	H.clearMockLog();
	await send('@tools spawn_agent ' + JSON.stringify({ name: 'wrep2', task: 'continue: WREPCONT finish the report' })
		+ ' ;; gather {"names":["wrep2"],"timeout_s":40} @usage 1 1 0.001');
	const r2 = await waitEnd('wrep2', 60000);
	// The worker's own first request: its last user message IS the task (the conductor's
	// request carries the task only inside its `@tools` line).
	const cont = H.mockLog().filter((m) => lastUser(m).startsWith('continue: WREPCONT'))[0];
	const carried = cont ? (cont.messages || []).filter((x) => x.role === 'tool').length : -1;
	check('(3/bill d) a continue: re-dispatch resumes the timed_out run\'s session', !!r2 && r2.status === 'done' && carried >= 3,
		`${r2 && r2.status}, ${carried} tool message(s) carried`);

	// (2) BILL (b): Stop mid-run books the rounds so far.
	await H.newChat(s);
	await p.waitForTimeout(500);
	H.clearMockLog();
	const t1 = await p.evaluate(() => Date.now());
	const dir2 = await scratchDir();
	const TASK2 = '@roundsthen 3/200 stall 600000 file_write {"path":"' + dir2 + '/wrep/s{n}.md","content":"S {n}"} @usage 100 50 0.01';
	await send('@tools spawn_agent ' + JSON.stringify({ name: 'wstop', task: TASK2 }) + ' @usage 1 1 0.001');
	for (let i = 0; i < 120; i++) {
		if (H.mockLog().filter((m) => lastUser(m).startsWith('@roundsthen 3/200')).length >= 4) break;
		await sleep(250);
	}
	await p.waitForTimeout(500);
	await p.evaluate(() => { const r = (window.DaimondWorkers.runs || []).find((x) => x.name === 'wstop'); if (r) window.DaimondWorkers.stop(r); });
	const r3 = await waitEnd('wstop', 20000);
	await p.waitForTimeout(1000);
	const srows = (await ledgerSince(t1)).filter((e) => e.u >= 0.005);
	check('(3/bill b) Stop mid-run books the rounds so far, once', !!r3 && r3.status === 'stopped' && srows.length === 1 && near(srows[0].u, 0.03),
		`${r3 && r3.status}, rows ${srows.map((e) => e.u.toFixed(4)).join(',')}`);
	await s.browser.close().catch(() => {});
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed` + (bad.length ? '' : ' — NOTHING FAILED, so the checks prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
