// shot_agentpane.mjs — visual + behavioural check of the agents panel's new
// chips (parent Facet, inherited tags, model) and its Facets-style search/filter.
//
// Drives the real UI: two tagged Facets, a small fan-out from each, then the
// search box and a Facet-chip filter. Needs dev/serve.mjs :8777 + dev/mockllm.mjs.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'agentpane-shot', signIn: true, connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);

async function newFacet(name) {
	await page.click('#new-facet-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 8000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok');
	await page.waitForSelector('#steer-input', { timeout: 10000 });
	await pause(300);
}

async function addTags(tags) {
	// The "# Tags" button on the Facet command surface opens the tag editor.
	await page.click('button.brief-act:has-text("# Tags")', { force: true });
	await page.waitForSelector('.tag-input', { timeout: 6000 });
	for (const t of tags) {
		await page.fill('.tag-input', t);
		await page.click('button.brief-act:has-text("+ Add")', { force: true });
		await pause(250);
	}
}

async function steer(text) {
	await page.fill('#steer-input', text);
	await page.click('#steer-send');
	await pause(1200);
}

// ── Facet A: Backend audit, tagged, two workers ─────────────────────────
await newFacet('Backend audit');
await addTags(['rust', 'ledger']);
// Back to the steer surface by re-selecting the Facet in the rail.
await page.click('.facet-box:has-text("Backend audit")', { force: true });
await page.waitForSelector('#steer-input', { timeout: 8000 });
await steer('@tools spawn_agent {"name":"schema-check","task":"@text checked the schema"} '
	+ ';; spawn_agent {"name":"ledger-audit","task":"@text audited the ledger"}');

// ── Facet B: Frontend polish, tagged, two workers ───────────────────────
await newFacet('Frontend polish');
await addTags(['css']);
await page.click('.facet-box:has-text("Frontend polish")', { force: true });
await page.waitForSelector('#steer-input', { timeout: 8000 });
await steer('@tools spawn_agent {"name":"chip-render","task":"@text rendered the chips"} '
	+ ';; spawn_agent {"name":"theme-sweep","task":"@text swept the themes"}');

// Let the workers finish, then force the panel to repaint with fresh tags.
await pause(2500);
await page.fill('#agent-search', ' ');
await page.fill('#agent-search', '');
await pause(400);

const summary = await page.evaluate(() => {
	const cards = [...document.querySelectorAll('#agents-list .acard')];
	return {
		count: cards.length,
		tiles: cards.map(c => ({
			name:  (c.querySelector('.an') || {}).textContent,
			facet: (c.querySelector('.facet-chip') || {}).textContent,
			tags:  [...c.querySelectorAll('.tag-chip.tag-sm')].map(t => t.textContent),
			model: (c.querySelector('.achip-model') || {}).textContent,
		})),
	};
});
console.log('TILES:', JSON.stringify(summary, null, 2));
await shot(s, 'agentpane-all');

// ── Search filters by Facet name ────────────────────────────────────────
await page.fill('#agent-search', 'backend');
await pause(400);
const afterSearch = await page.$$eval('#agents-list .acard', cs => cs.length);
const searchMiss = await page.$eval('#agents-list', el => el.textContent.includes('No agents match') );
console.log('after search "backend": cards =', afterSearch);
await shot(s, 'agentpane-search-backend');
await page.fill('#agent-search', '');
await pause(300);

// ── Clicking a Facet chip filters to that Facet, and shows a clear chip ──
await page.click('.acard .facet-chip:has-text("Frontend polish")', { force: true });
await pause(400);
const afterChip = await page.evaluate(() => ({
	cards: document.querySelectorAll('#agents-list .acard').length,
	filterChip: (document.querySelector('#agent-filter .tag-chip') || {}).textContent || '(none)',
	filterShown: document.getElementById('agent-filter').style.display !== 'none',
}));
console.log('after Facet-chip filter:', JSON.stringify(afterChip));
await shot(s, 'agentpane-filter-frontend');

// ── Clear the filter with the × ─────────────────────────────────────────
await page.click('#agent-filter .tag-x', { force: true });
await pause(400);
const cleared = await page.$$eval('#agents-list .acard', cs => cs.length);
console.log('after clearing filter: cards =', cleared);

// ── Verdicts ────────────────────────────────────────────────────────────
// The gateway is not run in this harness, so /api calls 502 by design; those
// are not the pane's errors. Anything else is.
const realErrs = s.errs.filter(e => !/502|Bad Gateway|\/api\b/.test(e));
const ok = summary.count === 4
	&& summary.tiles.every(t => t.focus && t.model)
	&& summary.tiles.some(t => t.tags.length > 0)
	&& afterSearch === 2 && !searchMiss
	&& afterChip.cards === 2 && afterChip.filterShown
	&& cleared === 4
	&& realErrs.length === 0;
console.log(ok ? '\n✅ PASS — chips, search and Facet filter all work' : '\n❌ FAIL — see above');
if (realErrs.length) console.log('PAGE ERRORS:', realErrs);
await s.close();
process.exit(ok ? 0 : 1);
