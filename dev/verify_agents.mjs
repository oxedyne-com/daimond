// The conductor dispatches workers; a finished worker folds in ONCE (not
// repeatedly), and finished tiles can be cleared.
//
// The header used to claim "a failed worker is not offered a fold" as well.
// Every worker in this fixture succeeds, so that sentence was never under test
// and has gone rather than being left standing as a claim the run does not make.
//
// "FOLDS IN ONCE" is a claim about what is left afterwards: the card that folded
// carries the folded mark and is no longer OFFERED the fold, and the offer count
// drops by exactly one. That is checked per card now; the old version counted
// buttons in the panel as a whole, which a second card losing its button would
// also satisfy.
//
// PROVED AGAINST A SHORT DISPATCH FIRST. `--break two` steers with two
// spawn_agent calls instead of three, and the dispatch check must go red.
//
//   node dev/verify_agents.mjs --break two   # expected to FAIL
//   node dev/verify_agents.mjs               # and then, clean
import { open, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && BREAK !== 'two') {
	console.error(`unknown break '${BREAK}'; known: two`);
	process.exit(2);
}

/// One row per worker card: what it is called, what state it is in, whether it
/// carries the folded mark and whether it is still being offered a fold.
const cards = (page) => page.evaluate(() => [...document.querySelectorAll('#panel-agents .acard')].map(c => ({
	name:   ((c.querySelector('.an') || {}).textContent || '').trim().slice(0, 24),
	status: ((c.querySelector('.pill') || {}).textContent || '').trim(),
	folded: !!c.querySelector('.afolded'),
	offer:  [...c.querySelectorAll('.abtn')].some(b => /Fold in/.test(b.textContent)),
})));

const s = await open({ name: 'agents' });
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

// New Diamond.
await s.page.click('#new-diamond-btn');
await s.page.waitForSelector('.dlg-input', { timeout: 8000 });
await s.page.fill('.dlg-input', 'Dispatch Test');
await s.page.click('.dlg-ok');
await s.page.waitForTimeout(1000);

// Steer with three spawn_agent calls in one turn.
const spawns = ['{"name":"alpha","task":"do A"}', '{"name":"beta","task":"do B"}', '{"name":"gamma","task":"do C"}']
	.slice(0, BREAK === 'two' ? 2 : 3);
await s.page.fill('#chat-input', '@tools ' + spawns.map(a => 'spawn_agent ' + a).join(' ;; '));
await s.page.keyboard.press('Enter');
await s.page.waitForTimeout(1500);

// Open the Agents dock panel.
await s.page.evaluate(() => window.DaimondPanels.show('agents'));
await s.page.waitForTimeout(500);

// Wait for the three workers to finish (each runs a mock turn).
await s.page.waitForTimeout(6000);
await shot(s, 'agents-1-dispatched');

const before = await cards(s.page);
const clearVisible = await s.page.evaluate(() => {
	const b = document.getElementById('agents-clear');
	return !!(b && b.style.display !== 'none');
});
console.log('after dispatch:', JSON.stringify(before));

check('THREE WORKERS WERE DISPATCHED FROM ONE TURN', before.length === 3,
	`${before.length} cards: ${before.map(c => c.name).join(', ') || '(none)'}`);
// Printed and never judged before: a panel of three workers stuck at "running"
// read exactly like three that had finished.
check('and all three finished', before.length > 0 && before.every(c => /done/i.test(c.status)),
	`statuses ${JSON.stringify(before.map(c => c.status))}`);
check('each finished worker is offered a fold', before.length > 0 && before.every(c => c.offer),
	`${before.filter(c => c.offer).length}/${before.length} offered`);
check('the Clear control is on the panel', clearVisible, '#agents-clear');

// Fold the first foldable worker in.
const foldBtn = s.page.locator('#panel-agents .acard').first().locator('.abtn', { hasText: 'Fold in' }).first();
const offered = await foldBtn.count();
check('there is a fold to press', !!offered, `${offered} "Fold in" on the first card`);
let after = before;
if (offered) {
	await foldBtn.click();
	await s.page.waitForTimeout(2500);		// the propose (reducer) turn
	// Accept the proposed fold diff in the Centre.
	const accept = await s.page.$('.diff-accept');
	if (accept) { await accept.click(); await s.page.waitForTimeout(2000); }
	after = await cards(s.page);
}
console.log('after folding:', JSON.stringify(after));
await shot(s, 'agents-2-folded');

const folded = after.filter(c => c.folded);
check('THE WORKER THAT WAS FOLDED IN IS MARKED AS FOLDED', folded.length === 1,
	`${folded.length} cards carry .afolded`);
// "Once, not repeatedly": the card that folded is no longer offered the fold,
// and nobody else lost theirs.
check('AND IS NOT OFFERED THE FOLD A SECOND TIME',
	folded.length === 1 && !folded[0].offer, folded.length ? `offer=${folded[0].offer}` : 'nothing folded');
check('while every other worker keeps its own offer',
	after.filter(c => c.offer).length === before.filter(c => c.offer).length - 1,
	`${after.filter(c => c.offer).length} offers left of ${before.filter(c => c.offer).length}`);

// Clear finished.
const afterClear = await s.page.evaluate(async () => {
	const b = document.getElementById('agents-clear');
	if (b) b.click();
	await new Promise(r => setTimeout(r, 400));
	return document.querySelectorAll('#panel-agents .acard').length;
});
check('CLEARING FINISHED WORKERS EMPTIES THE PANEL', afterClear === 0, `${afterClear} cards left`);

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
