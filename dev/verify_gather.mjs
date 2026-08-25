// A worker's report reaches the daimon that dispatched it.
//
// Fan-out existed and gather did not. `spawn_agent` dispatched a worker, the
// worker ran, and its text landed on a tile in the Agents panel -- where the only
// route onward was a person pressing "Fold in", which runs the reducer to propose
// a new crystal. That is the CRYSTAL's path, not the conductor's read. So the
// daimon could not read what its own workers found, could not compare two of
// them, could not notice that one contradicted another, and could not iterate.
//
// What is asserted here is measured FROM THE WIRE, not from the tiles: after the
// batch finishes, a further request reaches the model carrying both workers'
// reports. A tile that shows the text proves nothing about what the daimon saw.
//
//   node dev/verify_gather.mjs
//   node dev/verify_gather.mjs --break nogather   # must fail something
import { open, shot, mockLog, clearMockLog } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['nogather', 'nodispatch', 'nonotice'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'gather' + (BREAK ? '-' + BREAK : '') });
const { page } = s;

await page.click('#new-diamond-btn');
await page.waitForSelector('.dlg-input', { timeout: 8000 });
await page.fill('.dlg-input', 'Gather Test');
await page.click('.dlg-ok');
await page.waitForTimeout(1200);

// The break: the depth limit at zero, so no gather round may follow. That is
// exactly the behaviour before this feature -- the workers still run, the tiles
// still fill, "Fold in" still works. The old behaviour was not broken, it was
// incomplete, and a check that cannot tell those apart is worthless.
if (BREAK === 'nogather') {
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers) return false;
		window.DaimondWorkers.MAX_GATHER_DEPTH = 0;
		return true;
	});
	if (!applied) {
		console.error("break 'nogather': no handle on the worker pump, so nothing was broken.");
		process.exit(2);
	}
}

// The other break: the pump itself. `spawn_agent` still answers, the turn still
// ends, and NOTHING is started -- which is exactly the shape of the defect the
// checks below were written for, measured 2026-08-24. A model was told
// "Dispatched agent 'X'. It runs in its own context and reports back a summary",
// waited for a result, and spent the rest of a turn on it; the relay log for that
// run held twelve requests, all one growing chain, and not one worker request.
if (BREAK === 'nodispatch') {
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers || !window.DaimondWorkers.dispatch) return false;
		window.DaimondWorkers.dispatch = function () {};
		return true;
	});
	if (!applied) {
		console.error("break 'nodispatch': no handle on the worker pump, so nothing was broken.");
		process.exit(2);
	}
}

// The third break: the app keeps its own counsel. `Workers.tellDaimon` is the one
// door through which the app's word about a fan-out reaches the model, so stubbing it
// restores exactly the behaviour measured on 2026-08-25 -- a status line on the
// crystal, and a daimon that never learns its workers did not run.
if (BREAK === 'nonotice') {
	const applied = await page.evaluate(() => {
		if (!window.DaimondWorkers || !window.DaimondWorkers.tellDaimon) return false;
		window.DaimondWorkers.tellDaimon = function () { return false; };
		return true;
	});
	if (!applied) {
		console.error("break 'nonotice': no handle on the notice, so nothing was broken.");
		process.exit(2);
	}
}

clearMockLog();

// Two workers in one turn, each answering with something the other does not say,
// so a round that carries both can be told from a round that carries one.
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"alpha","task":"say ALPHAFOUND"} '
	+ ';; spawn_agent {"name":"beta","task":"say BETAFOUND"}');
await page.keyboard.press('Enter');
await page.waitForTimeout(2000);

// Let both workers run to a terminal state, then let the gather round go out.
await page.waitForTimeout(9000);
await shot(s, 'gather-1-dispatched');

const runs = await page.evaluate(() =>
	[...document.querySelectorAll('#panel-agents .acard')].length);

const wire = mockLog();
// The dispatching turn is the first request; a gather round is a LATER one whose
// prompt carries both workers' names. Searching every message of every request,
// because the instruction is a user message on the daimon's own conversation.
const carries = (m, needle) => (m.messages || [])
	.some(x => typeof x.content === 'string' && x.content.includes(needle));
const gatherReqs = wire.filter(m => carries(m, 'alpha') && carries(m, 'beta')
	&& carries(m, 'finished'));

check('the dispatch produced two agent tiles (nothing below is true of an empty pane)',
	runs >= 2, `${runs} tile(s)`);
check('a further request reached the model after the batch finished',
	gatherReqs.length >= 1, `${gatherReqs.length} of ${wire.length} request(s) carry both names`);
check('and it carried BOTH workers\' reports, not one',
	gatherReqs.some(m => carries(m, 'alpha') && carries(m, 'beta')),
	gatherReqs.length ? 'yes' : 'no such request');
check('the round says the workers finished, so the daimon knows why it is being asked',
	gatherReqs.some(m => carries(m, 'finished')));

// ── What `spawn_agent` claimed, held against what the relay actually saw ─────
//
// `spawn_agent` returns a sentence and starts nothing: the page collects the calls
// and starts the workers after the turn ends. So the sentence is a promise about a
// request that does not exist yet, and the only honest test of it is the wire.
// Asked here rather than in a Rust test because a Rust test can only read the
// sentence; this can read whether it came true.
const said = (needle) => wire.some((m) => JSON.stringify(m.messages || []).includes(needle));
// A worker's own request carries its task and never the tool that asked for it:
// a worker cannot see the conversation that sent it, so `spawn_agent` is absent
// from its messages while the dispatching chain carries it in every round.
const workerReqs = wire.filter((m) => {
	const j = JSON.stringify(m.messages || []);
	return j.includes('ALPHAFOUND') && !j.includes('spawn_agent');
});
check('a worker request of its own reached the relay, so the dispatch was real',
	workerReqs.length >= 1, `${workerReqs.length} of ${wire.length} request(s)`);
check('and the daimon was never told a worker had started, because none had',
	!said('Dispatched agent'),
	said('Dispatched agent') ? 'a tool result claimed a dispatch' : 'no such claim');
check('it was told WHEN the worker starts, so it does not spend the turn waiting',
	said('begins when the turn ends'));

await shot(s, 'gather-2-reported');

// ── A fan-out the app decides NOT to start ──────────────────────────────────
//
// The other half of the same promise, and the one that was missing. `spawn_agent`
// tells the daimon its workers begin when the turn ends and that their reports come
// back as a later turn, and the daimon then stops, which is what it was told to do.
// Everything that can decide otherwise decides it AFTER the turn has ended -- the
// spend gate declining, a paused node refusing, a turn that died before it stopped --
// and every one of those used to write a line of grey status text on the crystal and
// return. A status line is not addressed to the model.
//
// Measured 2026-08-25 as AA-4 in dev/HATES.md: a daimon dispatched eight workers,
// said "I'll wait for the workers to complete", ended its turn, and 25 tool calls
// bought nothing. It never learnt otherwise, and it could not have.
//
// The gate is tripped here rather than mocked: the burst is charged past its budget
// through the governor's own `observe`, exactly as a long turn charges it, so what is
// under test is the shipped rule and not a stub of it. The arithmetic is the
// product's -- with no learned baseline a worker is priced at $0.08 and the burst
// budget is $1.00, so eight workers need only $0.36 already spent to trip it, which
// a 25-call turn passes on its own.
const armed = await page.evaluate(() => {
	if (!window.DaimondGovernor || !window.DaimondGovernor.observe) return false;
	window.DaimondGovernor.observe({ t: Date.now(), u: 9 });
	return true;
});
check('the burst is over budget, so the next fan-out must be asked about',
	armed, armed ? 'charged $9' : 'no governor to charge');

clearMockLog();
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"gamma","task":"say GAMMAFOUND"} '
	+ ';; spawn_agent {"name":"delta","task":"say DELTAFOUND"}');
await page.keyboard.press('Enter');
// The gate is asked AFTER the turn ends, so the dialog appears once the daimon has
// already stopped. That is the whole shape of the defect.
await page.waitForSelector('.dlg-card .dlg-cancel', { timeout: 20000 });
await shot(s, 'gather-3-gate');
await page.click('.dlg-card .dlg-cancel');
await page.waitForTimeout(3000);

const wire2 = mockLog();
const ranGamma = wire2.some((m) => {
	const j = JSON.stringify(m.messages || []);
	return j.includes('GAMMAFOUND') && !j.includes('spawn_agent');
});
check('the declined fan-out started no worker, so nothing was spent on it',
	!ranGamma, ranGamma ? 'a worker request reached the relay anyway' : 'no worker request');

// THE PROPERTY. The next thing the daimon is sent must contradict what `spawn_agent`
// told it, or it goes on believing two workers are out there. Read off the wire and
// not out of the page: the daimon's conversation is reachable only from inside
// daimond.js, and the relay sees exactly what the model sees.
clearMockLog();
await page.fill('#chat-input', 'carry on');
await page.keyboard.press('Enter');
await page.waitForTimeout(6000);
const wire3 = mockLog();
const told = (needle) => wire3.some((m) =>
	JSON.stringify(m.messages || []).includes(needle));
check('the daimon\'s next turn carries the app\'s word that they were NOT started',
	told('WERE NOT STARTED'),
	`${wire3.length} request(s) since`);
check('and it says the reason, so the daimon is not left guessing at silence',
	told('told no'));
check('and that nothing was spent, so it does not report a cost it never paid',
	told('nothing was spent'));
check('and that there is nothing to wait for, which is what ends the lost turn',
	told('nothing to wait for'));
await shot(s, 'gather-4-told');

// ── A batch that finished, and a round that was not run ─────────────────────
//
// The other silent drop, and the one the chat path was already fixed for. `gather`
// has four guards that are each a good reason not to SPEND a round -- the pump held,
// the depth cap reached, the user looking at another Diamond, no model to run on --
// and each of them used to `return` with the reports left on their tiles and the
// daimon still waiting for a report that would now never come. The reports are not
// lost and never were; what was lost is the daimon's ability to read them. Driven
// through the depth cap because that one is a number this can set.
const reset = await page.evaluate(() => {
	if (!window.DaimondGovernor || !window.DaimondWorkers) return false;
	window.DaimondGovernor.reset();			// the burst above must not gate this fan-out
	window.DaimondWorkers.MAX_GATHER_DEPTH = 0;
	return true;
});
check('the depth cap is at zero, so no round may follow this batch', reset);

clearMockLog();
await page.fill('#chat-input',
	'@tools spawn_agent {"name":"epsilon","task":"say EPSILONFOUND"}');
await page.keyboard.press('Enter');
await page.waitForTimeout(11000);
const wire4 = mockLog();
check('the worker ran, so there is a report for the daimon to be denied',
	wire4.some((m) => {
		const j = JSON.stringify(m.messages || []);
		return j.includes('EPSILONFOUND') && !j.includes('spawn_agent');
	}), `${wire4.length} request(s)`);
// A ROUND IS THE LAST MESSAGE OF A REQUEST, never a phrase anywhere in it: the
// daimon's conversation is cumulative, so scenario 1's gather instruction is still in
// the history of every request from here on and a substring search says "a round ran"
// for ever after the first one.
const isRound = (m) => {
	const msgs = m.messages || [];
	const last = msgs.length ? msgs[msgs.length - 1] : null;
	return !!(last && last.role === 'user' && typeof last.content === 'string'
		&& last.content.includes('finished. Their reports follow'));
};
check('and no round followed it, which is what the depth cap is for',
	!wire4.some(isRound), `${wire4.filter(isRound).length} round(s)`);

clearMockLog();
await page.fill('#chat-input', 'what did it find');
await page.keyboard.press('Enter');
await page.waitForTimeout(6000);
const wire5 = mockLog();
// `### epsilon` AND NOT MERELY `EPSILONFOUND`. The token the worker was asked to say
// is in the daimon's own `spawn_agent` arguments, which are in its history from the
// moment it made the call, so a search for it alone passes with the whole delivery
// removed -- checked, by stubbing the notice and watching it pass. The `###` heading
// is written by `gather` when it composes the reports and appears nowhere else.
check('the daimon\'s next turn carries the report anyway, unspent and unlost',
	wire5.some((m) => {
		const j = JSON.stringify(m.messages || []);
		return j.includes('### epsilon') && j.includes('EPSILONFOUND');
	}), `${wire5.length} request(s) since`);
check('and says the round did not run, so a silence is not read as a result',
	wire5.some((m) => JSON.stringify(m.messages || []).includes('no round was run')));
await shot(s, 'gather-5-undelivered');

await s.close();

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
