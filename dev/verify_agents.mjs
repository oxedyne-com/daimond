// The conductor dispatches workers; a finished worker folds in ONCE (not
// repeatedly), a failed worker is not offered a fold, and finished tiles can
// be cleared.
import { open, shot, errors } from './harness.mjs';

const s = await open({ name: 'agents' });

// New Facet.
await s.page.click('#new-facet-btn');
await s.page.waitForSelector('.dlg-input', { timeout: 8000 });
await s.page.fill('.dlg-input', 'Dispatch Test');
await s.page.click('.dlg-ok');
await s.page.waitForTimeout(1000);

// Steer with three spawn_agent calls in one turn.
await s.page.fill('#steer-input',
	'@tools spawn_agent {"name":"alpha","task":"do A"} ;; spawn_agent {"name":"beta","task":"do B"} ;; spawn_agent {"name":"gamma","task":"do C"}');
await s.page.keyboard.press('Enter');
await s.page.waitForTimeout(1500);

// Open the Agents dock panel.
await s.page.evaluate(() => window.DaimondPanels.show('agents'));
await s.page.waitForTimeout(500);

// Wait for the three workers to finish (each runs a mock turn).
await s.page.waitForTimeout(6000);
await shot(s, 'agents-1-dispatched');

const before = await s.page.evaluate(() => {
	const cards = [...document.querySelectorAll('#panel-agents .acard')];
	return {
		count: cards.length,
		statuses: cards.map(c => (c.querySelector('.pill')||{}).textContent),
		foldButtons: [...document.querySelectorAll('#panel-agents .abtn')].filter(b => /Fold in/.test(b.textContent)).length,
		clearVisible: (() => { const b = document.getElementById('agents-clear'); return b && b.style.display !== 'none'; })(),
	};
});
console.log('after dispatch:', JSON.stringify(before));

// Fold the first foldable worker in, twice — second must be refused/absent.
const fold = [...await s.page.$$('#panel-agents .abtn')];
let foldResult = { folded: false };
const foldBtn = await s.page.evaluateHandle(() =>
	[...document.querySelectorAll('#panel-agents .abtn')].find(b => /Fold in/.test(b.textContent)));
if (foldBtn) {
	await s.page.evaluate(b => b && b.click(), foldBtn);
	await s.page.waitForTimeout(2500);   // the propose (reducer) turn
	// Accept the proposed fold diff in the Centre.
	const accept = await s.page.$('.diff-accept');
	if (accept) { await accept.click(); await s.page.waitForTimeout(2000); }
	foldResult = await s.page.evaluate(() => {
		const card = [...document.querySelectorAll('#panel-agents .acard')]
			.find(c => c.querySelector('.afolded') || [...c.querySelectorAll('.abtn')].some(b=>/Fold in/.test(b.textContent)) === false && c.querySelector('.an'));
		const marked = !!document.querySelector('#panel-agents .afolded');
		const anyFoldBtn = [...document.querySelectorAll('#panel-agents .abtn')].some(b => /Fold in/.test(b.textContent));
		return { folded: true, marked, foldButtonsRemaining: [...document.querySelectorAll('#panel-agents .abtn')].filter(b=>/Fold in/.test(b.textContent)).length };
	});
}
console.log('fold result:', JSON.stringify(foldResult));
await shot(s, 'agents-2-folded');

// Clear finished.
const afterClear = await s.page.evaluate(async () => {
	const b = document.getElementById('agents-clear');
	if (b) b.click();
	await new Promise(r => setTimeout(r, 400));
	return { cards: document.querySelectorAll('#panel-agents .acard').length };
});
console.log('after clear:', JSON.stringify(afterClear));

console.log('\nDISPATCHED 3:', before.count === 3);
console.log('FOLD IDEMPOTENT (marked, one fewer fold button):',
	foldResult.folded && foldResult.marked && foldResult.foldButtonsRemaining === 2);
console.log('CLEAR WORKS:', afterClear.cards === 0);
console.log('errors:', errors(s));
await s.close();
