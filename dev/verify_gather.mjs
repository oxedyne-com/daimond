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
const BREAKS = ['nogather'];
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

await shot(s, 'gather-2-reported');
await s.close();

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
