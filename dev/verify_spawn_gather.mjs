// A worker starts at the call, and its report comes back INSIDE the same turn.
//
// What this measures, and why it is measured off the wire. A worker's report used
// to reach the daimon as a whole further turn: the page collected every
// `spawn_agent` call, started the workers when the turn ended, and then spent a
// fresh turn handing the reports over -- a second full send of the standing
// context for the sake of a few kilobytes of report. On the owner's own chat one
// such turn cost US$0.67 by itself. The engine now starts the worker at the call
// (`DaimondWorkers.spawn`) and waits for it from inside the turn
// (`DaimondWorkers.awaitReports`), so what has to be true is a property of the
// PROVIDER LOG: one user turn from the chat, and a `tool` message in it carrying
// both reports. A tile that shows the text proves nothing about what the model saw.
//
// Five scenarios, all of them in every run: the gather that works, the gather that
// runs out of time, the gather the user stops, the worker that OUTLIVES the turn that
// dispatched it, and a Diamond's daimon doing the same thing as a chat. The last four
// are where the path can silently lose a report -- or, in the fourth's case, spend an
// afternoon and two more turns producing one nobody asked for.
//
//   node dev/verify_spawn_gather.mjs
//   node dev/verify_spawn_gather.mjs --break nobridge    # must fail something
//   node dev/verify_spawn_gather.mjs --break twice
//   node dev/verify_spawn_gather.mjs --break nostop
//   node dev/verify_spawn_gather.mjs --break noorphan   # the orphan runs to its whole ceiling
//   node dev/verify_spawn_gather.mjs --break emptyturn  # a turn is spent on an empty report
import { open, newChat, shot, mockLog, clearMockLog } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['nobridge', 'twice', 'nostop', 'noorphan', 'emptyturn'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Requests whose LAST message is a user turn carrying `needle`.
///
/// A round is judged on the last message and never on a phrase anywhere in the
/// request: a chat's conversation is cumulative, so a substring search says "a
/// turn ran" for ever after the first one.
const userTurnsWith = (wire, needle) => wire.filter((m) => {
	const msgs = m.messages || [];
	const last = msgs.length ? msgs[msgs.length - 1] : null;
	return !!(last && last.role === 'user' && typeof last.content === 'string'
		&& last.content.includes(needle));
});

/// Every `tool` reply on the wire whose content carries `needle`.
const toolRepliesWith = (wire, needle) => wire.flatMap((m) => (m.messages || [])
	.filter(x => x.role === 'tool' && typeof x.content === 'string'
		&& x.content.includes(needle)));

const s = await open({ name: 'spawngather' + (BREAK ? '-' + BREAK : '') });
const { page } = s;

// An ordinary chat of its own, which is the surface most turns happen on.
await newChat(s);

// The feed is an upload buffer the page cannot read back, so it is captured here
// the way `verify_contentoffload.mjs` captures it: a stand-in that keeps the rows.
await page.evaluate(() => {
	window.__ds = [];
	window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
});

// ── The breaks ──────────────────────────────────────────────────────────────
//
// `nobridge` is a NEW ENGINE IN AN OLD SHELL: the engine holds `gather` and the
// page has no pump to serve it. A page that switched on the engine's word alone
// would take the collector off the old path and start nothing at all.
//
// `twice` takes away the two guards that stop a report arriving TWICE -- once as
// the gather's own tool result, and once as the hand-back turn the post-turn path
// runs when a batch finishes. Two copies of one finding, read as two findings, is
// worse than none.
//
// `nostop` takes away `cancelAwaits`. `LlmClient::abort` only fires an armed
// fetch and during a gather there is none, so Stop would do nothing at all until
// the wait ran out.
if (BREAK === 'nobridge') {
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers || !window.DaimondWorkers.spawn) return false;
		delete window.DaimondWorkers.spawn;
		delete window.DaimondWorkers.awaitReports;
		return true;
	});
	if (!applied) {
		console.error("break 'nobridge': no pump to take the bridge off, so nothing was broken.");
		process.exit(2);
	}
}
if (BREAK === 'twice') {
	// Both guards, and only them: the turn's hold on its own batches, and the mark
	// that says a report has already been read. The workers still start in the turn
	// and the gather still reads them -- what is removed is everything that stops
	// the post-turn path delivering the same reports again.
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers || !window.DaimondWorkers.gather) return false;
		const real = window.DaimondWorkers.gather;
		window.DaimondWorkers.gather = function (b) {
			const saved = this.liveTurns;
			this.liveTurns = {};
			this.runs.forEach(function (r) { r.gathered = ''; });
			try { return real.call(this, b); } finally { this.liveTurns = saved; }
		};
		return true;
	});
	if (!applied) {
		console.error("break 'twice': no gather to unguard, so nothing was broken.");
		process.exit(2);
	}
}
if (BREAK === 'nostop') {
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers || !window.DaimondWorkers.cancelAwaits) return false;
		window.DaimondWorkers.cancelAwaits = function () {};
		return true;
	});
	if (!applied) {
		console.error("break 'nostop': no cancel to take away, so nothing was broken.");
		process.exit(2);
	}
}
// `noorphan` lets the arming happen and takes away the engine's ear for it: the page still
// marks every run of a turn that has ended, and `DaimondApp::orphan_worker` does nothing. That
// is proposal 15's own shape -- a worker with nobody waiting, running to the whole 200 rounds
// its preset allows. Scenario four reddens.
if (BREAK === 'noorphan') {
	const applied = await page.evaluate(async () => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		if (!mod || !mod.DaimondApp || !mod.DaimondApp.prototype.orphan_worker) return false;
		mod.DaimondApp.prototype.orphan_worker = function () {};
		return true;
	});
	if (!applied) {
		console.error("break 'noorphan': this wasm has no orphan ceiling to deafen, so nothing "
			+ 'was broken. Rebuild www/pkg.');
		process.exit(2);
	}
}
// `emptyturn` tells `deliverToChat` that every report has something in it, which is what this
// file said before the reading of an empty one cost US$1.14. Only scenario four's no-turn check
// reddens; the reports still land in the transcript either way.
if (BREAK === 'emptyturn') {
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers || !window.DaimondWorkers.deliverToChat) return false;
		const real = window.DaimondWorkers.deliverToChat;
		window.DaimondWorkers.deliverToChat = function (b, mine, instruction, parts) {
			return real.call(this, b, mine, instruction, parts, true);
		};
		return true;
	});
	if (!applied) {
		console.error("break 'emptyturn': no delivery to unguard, so nothing was broken.");
		process.exit(2);
	}
}

// ── One: two workers, one gather, one turn ──────────────────────────────────
//
// `a` answers with 9,000 bytes, which is over the 4 KB head `reportClip` keeps,
// so the size of what travels can be read rather than assumed; `b` answers after
// a second and a half, so the gather has something to wait for rather than
// finding both already finished.
clearMockLog();
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"a","task":"@big 9000"}'
	+ ' ;; spawn_agent {"name":"b","task":"@slow 1500"}'
	+ ' ;; gather {"names":["a","b"],"timeout_s":60}');
await page.keyboard.press('Enter');

const waiting = await page.waitForFunction(
	() => !!(window.DaimondWorkers && window.DaimondWorkers.awaiting
		&& window.DaimondWorkers.awaiting.length),
	null, { timeout: 12000 }).catch(() => null);
check('the turn goes INSIDE a gather and waits there', !!waiting);

await page.waitForTimeout(12000);
await shot(s, 'spawngather-1-ran');

const runs = await page.evaluate(() => (window.DaimondWorkers
	? window.DaimondWorkers.runs.map(r => ({ id: r.id, name: r.name, status: r.status,
		inTurn: !!r.inTurn, turnId: String(r.turnId || ''), gathered: String(r.gathered || ''),
		report: String(r.report || '') }))
	: []));
const wire = mockLog();
const gatherReplies = toolRepliesWith(wire, '### a');

check('both workers were started from inside the turn that asked for them',
	runs.filter(r => r.inTurn).length >= 2,
	JSON.stringify(runs.map(r => `${r.name}:${r.inTurn}`)));
check('the chat sent exactly ONE user turn, so no turn was spent on the reading',
	userTurnsWith(wire, '@tools spawn_agent').length === 1
		&& userTurnsWith(wire, 'Their reports follow').length === 0,
	`${userTurnsWith(wire, '@tools spawn_agent').length} sent, `
	+ `${userTurnsWith(wire, 'Their reports follow').length} hand-back`);
// `### a` is written by `gather_result` (src/tools.rs) and appears nowhere else.
// The worker's own task is in the daimon's history from the moment it made the
// call, so searching for the answer text alone would pass with the whole delivery
// removed -- checked, by stubbing the pump and watching it pass.
check('a tool result carried the first worker\'s report',
	gatherReplies.length >= 1, `${gatherReplies.length} tool repl(y|ies) with a report`);
check('and the SAME result carried the second one, so one gather read both',
	gatherReplies.some(x => x.content.includes('### b')),
	gatherReplies.length ? 'yes' : 'no such reply');
check('both runs are marked gathered, so neither is delivered a second time',
	runs.filter(r => r.gathered).length >= 2,
	JSON.stringify(runs.map(r => `${r.name}:${r.gathered ? 1 : 0}`)));
// AND THE READER MEETS IT ONCE. The mark above is the mechanism; this is what a
// person would actually see. When the last worker finishes the turn is still
// generating, so the post-turn path would not run a hand-back TURN -- it would
// paste the reports into the conversation as an app message, and the user would
// read one finding twice. The gathered report is the tool's own result and lives
// behind the steps toggle, so on the screen there should be no such block at all.
const pasted = await page.evaluate(() => {
	const out = document.getElementById('chat-output');
	const text = out ? out.innerText : '';
	return (text.match(/### a\b/g) || []).length;
});
check('the reports were not ALSO pasted into the conversation by the old path',
	pasted === 0, `${pasted} block(s) on screen`);

const big = runs.find(r => r.name === 'a');
check('the big worker\'s report travelled whole, inside the clip\'s 4 KB + 12 KB',
	!!big && big.report.length >= 8000 && big.report.length <= 4096 + 12288 + 200,
	big ? `${big.report.length} byte(s)` : 'no such run');
const carried = gatherReplies.find(x => x.content.includes('### a'));
check('and the tool result carried it rather than a summary of it',
	!!carried && carried.content.length > 8000,
	carried ? `${carried.content.length} byte(s)` : 'no such reply');
check('the result carries the figures a reader can parse',
	!!carried && /\[gather: n=2 pending=0 usd=/.test(carried.content),
	carried ? (carried.content.match(/\[gather:[^\]]*\]/) || ['none'])[0] : 'no such reply');

const turns = await page.evaluate(() => {
	try {
		// No id: `lastTurn` answers for the chat on screen, which is this one.
		const t = window.DaimondCore.lastTurn();
		return t ? { turns: t.turns | 0, how: String(t.how || '') } : null;
	} catch (e) { return null; }
});
check('the page recorded ONE turn for the chat, not two',
	!!turns && turns.turns === 1, JSON.stringify(turns));

const ds = await page.evaluate(() => window.__ds || []);
const gatherRows = ds.filter(r => r.kind === 'gather');
check('the feed carries a gather row naming the turn',
	gatherRows.length >= 1 && !!gatherRows[0].payload.turn,
	JSON.stringify(gatherRows.map(r => r.payload)));
const ends = ds.filter(r => r.kind === 'worker' && r.payload.at === 'end');
check('and the worker rows say which turn they belonged to',
	ends.length >= 2 && gatherRows.length >= 1
		&& ends.every(r => r.payload.turn === gatherRows[0].payload.turn),
	JSON.stringify(ends.map(r => r.payload.turn)));
// The join a reader makes. A flag on the worker row could not say this: a gather
// settles when the LAST of its workers finishes, so every earlier row is written
// before anything has read it.
check('and the gather row names the runs it read, which is the join',
	gatherRows.length >= 1
		&& ends.every(r => String(gatherRows[0].payload.w || '').split(',').includes(r.payload.w)),
	gatherRows.length ? `${gatherRows[0].payload.w} vs ${ends.map(r => r.payload.w).join('|')}`
		: 'no gather row');

// ── Two: a worker the gather could not wait for ─────────────────────────────
//
// Nothing is lost by a gather that runs out of time. The result names what is
// still running, the turn carries on and ends, and the late worker's report
// arrives by the path it always took -- `gather` -> `deliverToChat` -- as a later
// turn. This is the case where a report can go missing without anything saying so.
clearMockLog();
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"quick","task":"@text QUICKDONE"}'
	+ ' ;; spawn_agent {"name":"slowpoke","task":"@slow 14000"}'
	+ ' ;; gather {"names":["quick","slowpoke"],"timeout_s":10}');
await page.keyboard.press('Enter');
await page.waitForTimeout(16000);
const late1 = mockLog();
check('the timed-out gather handed over what had finished',
	toolRepliesWith(late1, '### quick').length >= 1,
	`${toolRepliesWith(late1, '### quick').length} such tool repl(y|ies)`);
// Case-insensitive, because there are two correct wordings: a gather that got SOME
// reports lists `Still running: x` after them, while one that got none opens
// `No worker finished within 10 s: x (w3) is still running`.
const pending = toolRepliesWith(late1, 'slowpoke')
	.filter(x => /still running/i.test(x.content));
check('and named the worker still running',
	pending.length >= 1, `${pending.length} such tool repl(y|ies)`);

await page.waitForTimeout(14000);
const late2 = mockLog();
// THE LATE REPORT ARRIVES, AND THE EARLY ONE DOES NOT ARRIVE TWICE. This is the
// shape the mark exists for: the turn read `quick` and not `slowpoke`, so when the
// batch finally completes the post-turn path must deliver `slowpoke` alone.
const handBack = late2.filter(m => (m.messages || []).some(x =>
	typeof x.content === 'string' && x.content.includes('### slowpoke')));
check('the late report still arrived, unlost',
	handBack.length >= 1, `${late2.length} request(s) since`);
check('and the report the turn had already read did NOT arrive a second time',
	!handBack.some(m => (m.messages || []).some(x => typeof x.content === 'string'
		&& x.content.includes('finished. Their reports follow')
		&& x.content.includes('### quick'))),
	handBack.length ? 'one copy' : 'nothing to judge');
await shot(s, 'spawngather-2-late');

// ── Three: Stop, pressed while the gather is waiting ────────────────────────
clearMockLog();
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"stopme","task":"@slow 25000"}'
	+ ' ;; gather {"names":["stopme"],"timeout_s":60}');
await page.keyboard.press('Enter');
const inGather = await page.waitForFunction(
	() => !!(window.DaimondWorkers && window.DaimondWorkers.awaiting
		&& window.DaimondWorkers.awaiting.length),
	null, { timeout: 12000 }).catch(() => null);
check('the stop case reaches a waiting gather to stop', !!inGather);
await page.click('#chat-send', { force: true });
// Seven seconds, which is well inside the twenty-five the worker would take and
// well inside the sixty the gather was told to wait: anything seen here is the
// press and not the deadline.
await page.waitForTimeout(7000);
const stopWire = mockLog();
check('the gather answered at once, saying the user stopped it',
	toolRepliesWith(stopWire, 'Stopped: the user stopped the turn').length >= 1,
	`${toolRepliesWith(stopWire, 'Stopped:').length} such tool repl(y|ies)`);
const settled = await page.evaluate(() => (window.DaimondWorkers
	? window.DaimondWorkers.awaiting.length : -1));
check('and nothing is left waiting, so the turn is not held open by a dead gather',
	settled === 0, `${settled} await(s)`);
await shot(s, 'spawngather-3-stopped');

// ── Four: the worker that outlives its turn ─────────────────────────────────
//
// PROPOSAL 15'S DRIVE, 2026-09-15, on the owner's own account. A `gather` ran out of time at
// 120 s; the daimon answered and its turn ended; and the worker went on ALONE for thirty
// minutes to the full 200 rounds its preset allows, US$0.47, with nothing in the page holding
// a promise on what it would say. Then the app spent a THIRD turn -- US$1.14 -- reading the
// report it finally produced, which was empty, because a worker stopped at a ceiling has
// written nothing since its last tool call.
//
// Two properties, and the second is not a consequence of the first: a worker nobody is waiting
// for is bounded (`compact::ORPHAN_GRACE_ROUNDS`, armed by `Workers.releaseTurn`), and a report
// with nothing in it starts no turn (`reportHasSubstance`). The reports still reach the
// transcript either way, which is what makes the second safe.
clearMockLog();
// The chat's own turn count before this one, so "the turn ended" is a fact read off the app
// rather than a wait long enough to be sure. `lastTurn().turns` is written on the engine's
// `ended` event, one seam before the `finally` that arms the ceiling.
const turns0 = await page.evaluate(() => {
	try { const t = window.DaimondCore.lastTurn(); return t ? (t.turns | 0) : 0; }
	catch (e) { return 0; }
});
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"lonely","task":"@rounds 400/300 file_list {\\"path\\":\\".\\"}"}'
	+ ' ;; gather {"names":["lonely"],"timeout_s":5}');
await page.keyboard.press('Enter');

// The turn: it waits five seconds, is handed a worker still running, and ends.
const ended = await page.waitForFunction((was) => {
	try { const t = window.DaimondCore.lastTurn(); return !!t && (t.turns | 0) > was; }
	catch (e) { return false; }
}, turns0, { timeout: 40000 }).catch(() => null);
const lateWire = mockLog();
check('the gather ran out of time on a worker that was still going',
	toolRepliesWith(lateWire, 'lonely').some(x => /is still running/i.test(x.content)),
	`${toolRepliesWith(lateWire, 'lonely').length} tool repl(y|ies) about it`);
check('and the turn ended anyway, leaving the worker with nobody waiting for it', !!ended);

// The bound. Up to forty seconds, because the unbounded shape this is about takes about
// twenty -- a check that looked sooner would pass under the break for want of looking.
const bounded = await page.waitForFunction(() => {
	const r = (window.DaimondWorkers ? window.DaimondWorkers.runs : [])
		.find(x => x.name === 'lonely');
	return !!(r && ['done', 'error', 'stopped', 'capped', 'spend_cap'].includes(r.status));
}, null, { timeout: 40000 }).catch(() => null);
const lonely = await page.evaluate(() => {
	const r = (window.DaimondWorkers ? window.DaimondWorkers.runs : [])
		.find(x => x.name === 'lonely');
	if (!r) return null;
	return { status: String(r.status || ''), orphaned: !!r.orphaned,
		rounds: (r.ended && r.ended.rounds) || 0,
		told: String(r.text || '').includes('the turn that dispatched this worker ended'),
		report: String(r.report == null ? '' : r.report).trim().length };
});
check('the orphaned worker was stopped rather than left to its own ceiling',
	!!bounded && !!lonely && lonely.status === 'capped', JSON.stringify(lonely));
// THE SENTENCE IS THE EVIDENCE, not the round count: the round it was orphaned in depends on
// how fast the mock answered, so a number here would be a timing assertion wearing a ceiling's
// clothes. The engine writes this sentence at one seam and nowhere else.
check('and it was stopped BY the orphaning, with its dispatcher named',
	!!lonely && lonely.told, lonely ? `told=${lonely.told} rounds=${lonely.rounds}` : 'no run');
// A HUNDRED, not the two hundred of the whole preset: the paced fixture reaches about
// thirty-five before its dispatcher lets go, and an unbounded one runs to the leg cap. A
// ceiling of 200 here would be met by both, which is a check that measures nothing.
check('far inside the hundred-round leg its preset would otherwise have allowed',
	!!lonely && lonely.rounds > 0 && lonely.rounds < 100, lonely ? `${lonely.rounds} rounds` : 'no run');

// AND NO TURN WAS SPENT READING WHAT IT DID NOT SAY. `Their reports follow` is the hand-back
// prompt and appears in no other message; the transcript block is drawn either way, which is
// where the reports actually live.
await page.waitForTimeout(3000);
const afterWire = mockLog();
check('no turn was started to read a report with nothing in it',
	userTurnsWith(afterWire, 'Their reports follow').length === 0,
	`${userTurnsWith(afterWire, 'Their reports follow').length} hand-back turn(s)`);
// READ AS THE READER SEES IT: the block is Markdown, so `### lonely` is an H3 whose text is
// the worker's name and its ending note -- a raw-text search for the hashes finds nothing and
// would pass with the whole delivery removed.
const pastedLonely = await page.evaluate(() => {
	const out = document.getElementById('chat-output');
	if (!out) return 0;
	return [...out.querySelectorAll('h1,h2,h3,h4')]
		.filter(h => (h.textContent || '').trim().startsWith('lonely')).length;
});
check('and the reports were put in the conversation instead, where they cost nothing',
	pastedLonely >= 1, `${pastedLonely} block(s) on screen`);
await shot(s, 'spawngather-4-orphan');


// ── Five: a DIAMOND's daimon, which is the surface the saving was measured on ──
//
// A daimon's turn does not run on the app's own belt: `compose_daimon` builds a
// fresh registry from the daimon tool set, so the page has to ask
// `daimon_can_gather` rather than `can_gather`. Asked the wrong one, every daimon
// turn there is quietly took the old path -- and the bank tasks that measured this
// item (05 `worker_audit`, 06 `worker_midfact`, 12 `big_report`) are all
// `"world": "diamond"`.
clearMockLog();
await page.click('#new-diamond-btn');
await page.waitForSelector('.dlg-input', { timeout: 8000 });
await page.fill('.dlg-input', 'Gather Diamond');
await page.click('.dlg-ok');
await page.waitForTimeout(1200);
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"dia","task":"@text DIAFOUND"}'
	+ ' ;; gather {"names":["dia"],"timeout_s":60}');
await page.keyboard.press('Enter');
await page.waitForTimeout(14000);
const diaRuns = await page.evaluate(() => (window.DaimondWorkers
	? window.DaimondWorkers.runs.filter(r => r.name === 'dia')
		.map(r => ({ inTurn: !!r.inTurn, dia: String(r.diamondId || ''),
			gathered: String(r.gathered || '') }))
	: []));
const diaWire = mockLog();
check('a Diamond\'s daimon started its worker inside the turn too',
	diaRuns.length >= 1 && diaRuns[0].inTurn && !!diaRuns[0].dia,
	JSON.stringify(diaRuns));
check('and read its report back as a tool result, not as a further turn',
	toolRepliesWith(diaWire, '### dia').length >= 1
		&& userTurnsWith(diaWire, 'Their reports follow').length === 0,
	`${toolRepliesWith(diaWire, '### dia').length} tool repl(y|ies), `
	+ `${userTurnsWith(diaWire, 'Their reports follow').length} hand-back`);
await shot(s, 'spawngather-5-daimon');

await s.close();

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
