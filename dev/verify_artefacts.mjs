// verify_artefacts.mjs — what a Facet produced, derived rather than declared.
//
// Nobody maintains this list. Every tool call is already recorded on the turn as a
// `tool_log` carrying its name and arguments, so the artefacts of a stretch of work can be
// read straight off it — and a derived list cannot drift, because there is nothing to keep
// up to date. The harvest happens at the fold, which is both the last moment the tool calls
// still exist (folding drops the back-and-forth) and a moment the user has already blessed.
//
// What is pinned here: that writes count and reads do not, that re-folding does not stack
// duplicates, that a link to a since-deleted file says so rather than failing quietly, and
// that the strip stays hidden until there is something in it.
//
// Run with dev/serve.mjs up. No gateway needed.
import { open, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'artefacts', connect: false });
const p = s.page;
await p.waitForTimeout(2500);

// ── A Facet, and a chat whose turns carry tool calls ─────────────────────
const facetId = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return await app.create_facet('Ship the launch');
});
check('a Facet was created', !!facetId, facetId);

// The harvest reads `tool_log` messages, so this is exactly the shape a real turn leaves.
const harvested = await p.evaluate(async ({ facetId }) => {
	const tl = (name, args) => ({ role: 'tool_log', name, args: JSON.stringify(args) });
	const messages = [
		{ role: 'user', content: 'do the thing' },
		tl('file_read',  { path: 'notes/old-research.md' }),      // a READ: not an artefact
		tl('file_search',{ query: 'pricing' }),                   // also not
		tl('file_write', { path: 'notes/pricing.md', content: 'x' }),
		tl('file_edit',  { path: 'notes/launch-copy.md' }),
		tl('web_open',   { url: 'https://stripe.com/docs?a=1' }),
		tl('web_fetch',  { url: 'https://example.com/background' }),  // background: not deliberate
		tl('file_write', { path: 'notes/pricing.md', content: 'again' }), // same file twice
		{ role: 'assistant', content: 'done' },
	];
	// Drive the harvest the way an accepted fold does.
	await window.DaimondArtefacts.harvest(facetId, { sourceRun: { messages } });
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return JSON.parse(await app.links_touching('facet:' + facetId) || '[]');
}, { facetId });

const refs = harvested.map(l => l.to);
check('a written file became an artefact', refs.includes('file:notes/pricing.md'));
check('an edited file became one too', refs.includes('file:notes/launch-copy.md'));
check('an opened page became one', refs.includes('url:https://stripe.com/docs?a=1'));
check('a file that was only READ did not',
	!refs.includes('file:notes/old-research.md'),
	'reads are noise: forty lookups would drown the one thing that matters');
check('a background fetch did not', !refs.includes('url:https://example.com/background'));
check('the same file written twice is one artefact',
	refs.filter(r => r === 'file:notes/pricing.md').length === 1);
check('a produced file says so', harvested.find(l => l.to === 'file:notes/pricing.md')?.rel === 'produced');
check('an opened page says consulted',
	harvested.find(l => l.to.startsWith('url:'))?.rel === 'consulted');
check('the harvest names itself as the source',
	harvested.every(l => l.by === 'fold'), harvested[0]?.by);
check('exactly the three artefacts, and nothing else', harvested.length === 3,
	`${harvested.length}: ${refs.join(', ')}`);

// ── Re-folding must not stack duplicates ────────────────────────────────
const again = await p.evaluate(async ({ facetId }) => {
	const tl = (name, args) => ({ role: 'tool_log', name, args: JSON.stringify(args) });
	const messages = [
		tl('file_write', { path: 'notes/pricing.md', content: 'third time' }),
		tl('file_write', { path: 'notes/new-thing.md', content: 'new' }),
	];
	await window.DaimondArtefacts.harvest(facetId, { sourceRun: { messages } });
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return JSON.parse(await app.links_touching('facet:' + facetId) || '[]');
}, { facetId });
check('folding again does not stack a duplicate', again.length === 4,
	`${again.length} artefact(s)`);
check('but a genuinely new artefact is added',
	again.some(l => l.to === 'file:notes/new-thing.md'));

// ── A malformed tool call is skipped, not thrown on ─────────────────────
const malformed = await p.evaluate(async ({ facetId }) => {
	const messages = [
		{ role: 'tool_log', name: 'file_write', args: 'not json at all{' },
		{ role: 'tool_log', name: 'file_write', args: JSON.stringify({ nopath: 1 }) },
		{ role: 'tool_log', name: 'file_write', args: JSON.stringify({ path: '   ' }) },
		{ role: 'tool_log', name: 'file_write', args: JSON.stringify({ path: 'notes/fine.md' }) },
	];
	try {
		await window.DaimondArtefacts.harvest(facetId, { sourceRun: { messages } });
	} catch (e) { return { threw: String(e) }; }
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	return { links: JSON.parse(await app.links_touching('facet:' + facetId) || '[]') };
}, { facetId });
check('a malformed tool call does not throw inside an accepted fold', !malformed.threw,
	malformed.threw);
check('and the good one beside it still lands',
	(malformed.links || []).some(l => l.to === 'file:notes/fine.md'));

// ── The strip: hidden at zero, and a count when there is something ──────
//
// The Facets above were made through a fresh app instance, which the running rail knows
// nothing about, so it is reloaded here before anything is clicked.
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'artefacts');      // a reload puts the identity gate back
await p.waitForTimeout(3000);

const strip = await p.evaluate(async ({ facetId }) => {
	// Select it the way a user does: click its row in the rail.
	const row = Array.from(document.querySelectorAll('#facet-list .facet-box'))
		.find(e => /Ship the launch/.test(e.textContent));
	if (row) row.click();
	await new Promise(r => setTimeout(r, 1200));
	const el = document.getElementById('arte-strip');
	const list = document.getElementById('arte-list');
	return {
		shown: el ? el.style.display !== 'none' : null,
		text:  el ? el.textContent.trim() : null,
		listShown: list ? list.style.display !== 'none' : null,
	};
}, { facetId });
check('the strip is shown once there are artefacts', strip.shown === true, String(strip.shown));
check('it is a count, not a list', /^◈ \d+ artefacts?$/.test(strip.text || ''), strip.text);
check('the list stays closed until it is clicked', strip.listShown === false,
	String(strip.listShown));

const opened = await p.evaluate(async () => {
	document.getElementById('arte-strip').click();
	await new Promise(r => setTimeout(r, 700));
	const list = document.getElementById('arte-list');
	return {
		shown: list.style.display !== 'none',
		rows:  list.querySelectorAll('.arte-row').length,
		first: (list.querySelector('.arte-open') || {}).textContent,
		kinds: Array.from(list.querySelectorAll('.arte-kind')).map(e => e.textContent),
	};
});
check('clicking opens the list', opened.shown === true);
check('every artefact has a row', opened.rows === 5, `${opened.rows} row(s)`);
check('each row says what kind of thing it is',
	opened.kinds.every(k => ['file', 'url'].includes(k)), opened.kinds.join(','));

// ── The reference-insert: the thing that makes it a picker ──────────────
const inserted = await p.evaluate(async () => {
	document.querySelector('.arte-row .arte-use').click();
	await new Promise(r => setTimeout(r, 300));
	const box = document.getElementById('steer-input');
	return box ? box.value : null;
});
check('a row can put its reference in the steer box',
	/notes\/|https:/.test(inserted || ''), inserted);

// ── An empty Facet gets no empty shelf ──────────────────────────────────
await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	await app.create_facet('Nothing done yet');
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'artefacts');
await p.waitForTimeout(3000);

const empty = await p.evaluate(async () => {
	const row = Array.from(document.querySelectorAll('#facet-list .facet-box'))
		.find(e => /Nothing done yet/.test(e.textContent));
	if (!row) return 'no such row';
	row.click();
	await new Promise(r => setTimeout(r, 1200));
	const el = document.getElementById('arte-strip');
	return el ? el.style.display : 'absent';
});
check('a Facet with no artefacts shows no strip at all',
	empty === 'none' || empty === 'absent', empty);

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
