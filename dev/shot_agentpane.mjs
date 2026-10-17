// shot_agentpane.mjs — visual + behavioural check of the agents panel's new
// chips (parent Diamond, inherited tags, model) and its Diamonds-style search/filter.
//
// Drives the real UI: two tagged Diamonds, a small fan-out from each, then the search
// box and a Diamond-chip filter. Needs dev/serve.mjs (DAIMOND_PORT, default 8777) +
// dev/mockllm.mjs.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'agentpane-shot', signIn: true, connect: true });
const { page } = s;
const pause = (ms) => page.waitForTimeout(ms);

async function newDiamond(name) {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 8000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok');
	await page.waitForSelector('#chat-input', { timeout: 10000 });
	await pause(300);
}

async function addTags(tags) {
	// The "# Tags" button on the Diamond command surface opens the tag editor.
	await page.click('button.crystal-act:has-text("# Tags")', { force: true });
	await page.waitForSelector('.tag-input', { timeout: 6000 });
	for (const t of tags) {
		await page.fill('.tag-input', t);
		await page.click('button.crystal-act:has-text("+ Add")', { force: true });
		await pause(250);
	}
}

async function steer(text) {
	await page.fill('#chat-input', text);
	await page.click('#chat-send');
	await pause(1200);
}

// ── Diamond A: Backend audit, tagged, two workers ─────────────────────────
await newDiamond('Backend audit');
await addTags(['rust', 'ledger']);
// Back to the steer surface by re-selecting the Diamond in the rail.
await page.click('.diamond-box:has-text("Backend audit")', { force: true });
await page.waitForSelector('#chat-input', { timeout: 8000 });
await steer('@tools spawn_agent {"name":"schema-check","task":"@text checked the schema"} '
	+ ';; spawn_agent {"name":"ledger-audit","task":"@text audited the ledger"}');

// ── Diamond B: Frontend polish, tagged, two workers ───────────────────────
await newDiamond('Frontend polish');
await addTags(['css']);
await page.click('.diamond-box:has-text("Frontend polish")', { force: true });
await page.waitForSelector('#chat-input', { timeout: 8000 });
await steer('@tools spawn_agent {"name":"chip-render","task":"@text rendered the chips"} '
	+ ';; spawn_agent {"name":"theme-sweep","task":"@text swept the themes"}');

// Let the workers finish, then force the panel to repaint with fresh tags.
await pause(2500);
await page.fill('#agent-search', ' ');
await page.fill('#agent-search', '');
await pause(400);

const summary = await page.evaluate(() => {
	const cards = [...(window.__pressSquares && window.__pressSquares(), document.querySelectorAll('#agents-list .acard'))];
	return {
		count: cards.length,
		tiles: cards.map(c => ({
			name:  (c.querySelector('.an') || {}).textContent,
			diamond: (c.querySelector('.diamond-chip') || {}).textContent,
			tags:  [...c.querySelectorAll('.tag-chip.tag-sm')].map(t => t.textContent),
			model: (c.querySelector('.achip-model') || {}).textContent,
		})),
	};
});
console.log('TILES:', JSON.stringify(summary, null, 2));
await shot(s, 'agentpane-all');

// THE GRID DIMS WHAT A FILTER LEAVES OUT (Agents grid): no square moves and a pinned tile
// stays, so what a filter keeps is counted off the squares it leaves lit.
const litSquares = () => page.$$eval('#agents-grid .agsq.match:not(.o)', bs => bs.length);

// ── Search filters by Diamond name ────────────────────────────────────────
await page.fill('#agent-search', 'backend');
await pause(400);
const afterSearch = await litSquares();
const searchMiss = await page.$eval('#agents-list', el => el.textContent.includes('No agents match') );
console.log('after search "backend": lit squares =', afterSearch);
await shot(s, 'agentpane-search-backend');
await page.fill('#agent-search', '');
await pause(300);

// ── Clicking a Diamond chip filters to that Diamond, and shows a clear chip ──
await page.click('.acard .diamond-chip:has-text("Frontend polish")', { force: true });
await pause(400);
const afterChip = await page.evaluate(() => ({
	cards: document.querySelectorAll('#agents-grid .agsq.match:not(.o)').length,
	filterChip: (document.querySelector('#agent-filter .tag-chip') || {}).textContent || '(none)',
	filterShown: document.getElementById('agent-filter').style.display !== 'none',
}));
console.log('after Diamond-chip filter:', JSON.stringify(afterChip));
await shot(s, 'agentpane-filter-frontend');

// ── Clear the filter with the × ─────────────────────────────────────────
await page.click('#agent-filter .tag-x', { force: true });
await pause(400);
const cleared = await litSquares();
console.log('after clearing filter: lit squares =', cleared);

// ── Verdicts ────────────────────────────────────────────────────────────
// The gateway is not run in this harness, so /api calls 502 by design; those
// are not the pane's errors. Anything else is.
const realErrs = s.errs.filter(e => !/502|Bad Gateway|\/api\b/.test(e));
const ok = summary.count === 4
	&& summary.tiles.every(t => t.model)
	&& summary.tiles.some(t => t.tags.length > 0)
	&& afterSearch === 2 && !searchMiss
	&& afterChip.cards === 2 && afterChip.filterShown
	&& cleared === 4
	&& realErrs.length === 0;
console.log(ok ? '\n✅ PASS — chips, search and Diamond filter all work' : '\n❌ FAIL — see above');
if (realErrs.length) console.log('PAGE ERRORS:', realErrs);
await s.close();
process.exit(ok ? 0 : 1);
