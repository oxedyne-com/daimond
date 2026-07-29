// Verify Diamond tags: chips, search, tag filter, the tag editor, persistence,
// and the backup round trip -- against the real wasm, no stubs.
//
// Tags are the user's filing system and nothing else, so the check that
// matters most is the one proving a tag never reaches the model.

import fs from 'node:fs';
import { open, shot, errors, signInAs, mockLog, clearMockLog, scratch } from './harness.mjs';

const s = await open({ name: 'tags' });
const { page } = s;
const out = [];
const say = (ok, what) => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`); return ok; };
let bad = 0;
const check = (ok, what) => { if (!say(ok, what)) bad++; };
// A failure that is real, understood, and not this change's. Reported loudly,
// but it does not fail the run: see the note at the backup round trip.
const known = [];
const checkKnown = (ok, what, why) => { if (!ok) known.push(`${what}\n        ${why}`); };

const boxes = () => page.$$eval('.diamond-box .session-box-name', els => els.map(e => e.textContent));
const railOf = () => page.$$eval('.diamond-box', els => els.map(e => ({
	name: (e.querySelector('.session-box-name') || {}).textContent,
	tags: [...e.querySelectorAll('.session-box-meta .tag-chip')].map(c => c.textContent),
	more: (e.querySelector('.tag-more') || {}).textContent || null,
})));

/// Reach the real wasm directly. The page has already run init(), so a fresh
/// DaimondApp shares its memory and its OPFS -- this is the same store the UI
/// is reading, not a copy.
const wasm = (fn, arg) => page.evaluate(async ({ src, arg }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return await (new Function('app', 'arg', `return (${src})(app, arg);`))(app, arg);
}, { src: fn.toString(), arg });

// ── The search box is there before anything else is ──────────────
check(await page.isVisible('#diamond-search'), 'search box visible with zero Diamonds (not hidden behind a count)');

// ── Create three Diamonds ────────────────────────────────────────────
async function newDiamond(name) {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(700);
}
for (const n of ['Ship a CSV parser', 'Mum birthday plan', 'Rust compiler notes']) await newDiamond(n);
check((await boxes()).length === 3, 'three Diamonds in the rail');

// The contract says every row now carries tags, [] when there are none.
const rawRows = await wasm(async (app) => JSON.parse(await app.list_diamonds()));
check(rawRows.length === 3 && rawRows.every(r => Array.isArray(r.tags) && r.tags.length === 0),
	'list_diamonds rows carry "tags":[] when a Diamond has none');

// An untagged Diamond must look exactly as it did before tags existed.
const untaggedMeta = await page.$$eval('.diamond-box', els =>
	els.map(e => (e.querySelector('.session-box-meta') || {}).innerHTML || ''));
check(untaggedMeta.every(h => !h.includes('tag-chip')), 'untagged Diamonds render no chips (zero regression)');

// The order tagging must not disturb.
const orderBefore = await boxes();

// ── Tag the first Diamond through the editor ───────────────────────
async function openTagEditor(name) {
	const idx = (await boxes()).indexOf(name);
	await page.$$eval('.diamond-box', (els, i) => els[i].click(), idx);
	await page.waitForTimeout(500);
	for (const b of await page.$$('.crystal-act')) {
		if ((await b.textContent()).includes('Tags')) { await b.click({ force: true }); break; }
	}
	await page.waitForSelector('.tag-editor', { timeout: 5000 });
}
const editorTags = () => page.$$eval('.tag-row:not(.tag-sug) .tag-chip',
	els => els.map(e => e.textContent.replace('×', '')));

await openTagEditor('Ship a CSV parser');
check(await page.isVisible('.tag-editor'), 'tag editor opens from the crystal bar');
const sugs = await page.$$eval('.tag-sug .tag-chip', els => els.map(e => e.textContent));
check(JSON.stringify(sugs) === JSON.stringify(['person', 'project', 'topic', 'org']),
	`default suggestions offered: ${JSON.stringify(sugs)}`);

// One click adds a suggestion.
const sugChips = await page.$$('.tag-sug .tag-chip');
await sugChips[0].click({ force: true });
await page.waitForTimeout(600);
// Type a custom one, shouty and padded, to prove the real normalisation lands.
await page.fill('.tag-input', '  RUST  ');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const et = await editorTags();
check(et.includes('person') && et.includes('rust'), `editor shows current tags, normalised: ${JSON.stringify(et)}`);

// ── The two boxes: a closed chip lands back in the pool ──────────
// Close "rust" above; it must leave the Diamond AND reappear below, where
// one click brings it back -- the pool holds every tag, not a fixed list.
await page.click('.tag-chip.tag-edit .tag-x >> nth=-1', { force: true });   // rust is newest, last
await page.waitForTimeout(600);
const afterClose = await editorTags();
const pool = await page.$$eval('.tag-sug .tag-chip', els => els.map(e => e.textContent));
check(!afterClose.includes('rust') && pool.includes('rust'),
	`a closed tag returns to the pool: on=${JSON.stringify(afterClose)} pool has rust=${pool.includes('rust')}`);
const rustChip = await page.$$('.tag-sug .tag-chip');
for (const c of rustChip) {
	if ((await c.textContent()) === 'rust') { await c.click({ force: true }); break; }
}
await page.waitForTimeout(600);
check((await editorTags()).includes('rust'), 'one click in the pool restores it');

// ── Tagging must not reorder the rail ────────────────────────────
// The Rust set_tags deliberately leaves `updated` alone: filing a Diamond is not
// touching it, and a rail that reshuffles under a tag edit is a rail you
// cannot tag twice without losing your place.
await page.click('.crystal-act', { force: true });          // ← Back to the crystal
await page.waitForTimeout(500);
const orderAfter = await boxes();
check(JSON.stringify(orderBefore) === JSON.stringify(orderAfter),
	`rail order is stable across a tag edit: ${JSON.stringify(orderAfter)}`);

// ── Tag the second Diamond, so a filter has something to exclude ───
await openTagEditor('Mum birthday plan');
for (const t of ['person', 'family', 'gifts', 'urgent']) {
	await page.fill('.tag-input', t); await page.keyboard.press('Enter'); await page.waitForTimeout(450);
}
await page.click('.crystal-act', { force: true });
await page.waitForTimeout(500);

// ── Chips in the rail ────────────────────────────────────────────
const railChips = await railOf();
const mum = railChips.find(r => r.name === 'Mum birthday plan');
check(mum && mum.tags.length === 3 && mum.more === '+1',
	`overflow caps at 3 chips + "+N": ${JSON.stringify(mum)}`);
const csv = railChips.find(r => r.name === 'Ship a CSV parser');
check(csv && csv.tags.length === 2, `chips render on the tagged Diamond: ${JSON.stringify(csv && csv.tags)}`);

// Colour is deterministic and theme-driven, not hardcoded.
const hues = await page.$$eval('.session-box-meta .tag-chip',
	els => els.map(e => ({ t: e.textContent, h: e.style.getPropertyValue('--tag-h') })));
const byTag = {};
let stable = true;
for (const { t, h } of hues) { if (byTag[t] && byTag[t] !== h) stable = false; byTag[t] = h; }
check(stable && hues.every(x => x.h !== ''), `each tag carries one hue: ${JSON.stringify(byTag)}`);
const personHue = byTag['person'];
check(new Set(Object.values(byTag)).size > 1, 'different tags get different hues');
await shot(s, 'tags-dark-rail');

// ── Persistence: the whole point of the Rust side ────────────────
// Reload and sign back in: tags must come off disk, not out of memory.
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'tags');
await page.waitForTimeout(1500);
const afterReload = await railOf();
const mumAfter = afterReload.find(r => r.name === 'Mum birthday plan');
const csvAfter = afterReload.find(r => r.name === 'Ship a CSV parser');
check(mumAfter && JSON.stringify(mumAfter.tags) === JSON.stringify(['person', 'family', 'gifts']) && mumAfter.more === '+1',
	`tags PERSIST across a page reload: ${JSON.stringify(mumAfter)}`);
check(csvAfter && csvAfter.tags.length === 2,
	`every tagged Diamond survives the reload: ${JSON.stringify(csvAfter && csvAfter.tags)}`);
check(JSON.stringify(afterReload.map(r => r.name)) === JSON.stringify(orderBefore),
	`rail order survives the reload: ${JSON.stringify(afterReload.map(r => r.name))}`);

// ── Search ───────────────────────────────────────────────────────
async function search(q) {
	await page.fill('#diamond-search', q);
	await page.waitForTimeout(300);
	return boxes();
}
check(JSON.stringify(await search('mum')) === JSON.stringify(['Mum birthday plan']),
	'search matches the name, case-insensitively');
const rustHits = await search('RUST');
check(rustHits.length === 2, `search matches a TAG as well as a name: ${JSON.stringify(rustHits)}`);
check((await search('family')).length === 1, 'search matches a tag that is in no name');
const none = await search('zzzznope');
check(none.length === 0 && (await page.textContent('.diamond-list')).includes('No Diamonds match'),
	'a search with no hits says so');
await shot(s, 'tags-dark-search');
await search('');
check((await boxes()).length === 3, 'clearing the search box restores the list');

// ── Filter by clicking a chip ────────────────────────────────────
const clickTag = async (name) => {
	await page.$$eval('.session-box-meta .tag-chip', (els, n) => {
		for (const e of els) if (e.textContent === n) { e.click(); return; }
	}, name);
	await page.waitForTimeout(400);
};
await clickTag('person');
const filtered = await boxes();
check(filtered.length === 2 && filtered.includes('Mum birthday plan') && filtered.includes('Ship a CSV parser'),
	`clicking a chip filters to that tag: ${JSON.stringify(filtered)}`);
check(await page.isVisible('#diamond-filter'), 'the active filter shows as a chip beside the search box');
const fchip = await page.textContent('#diamond-filter');
check(fchip.includes('person') && fchip.includes('×'), `filter chip names the tag and offers a ×: ${JSON.stringify(fchip)}`);
check(await page.$eval('#diamond-filter .tag-chip', e => e.style.getPropertyValue('--tag-h')) === personHue,
	'the filter chip is the same colour as the tag it came from');
await shot(s, 'tags-dark-filter');
check((await search('mum')).length === 1, 'search narrows within an active tag filter');
await search('');
await page.click('#diamond-filter .tag-x', { force: true });
await page.waitForTimeout(400);
check((await boxes()).length === 3 && !(await page.isVisible('#diamond-filter')),
	'the filter chip × clears the filter');
await clickTag('person');
await clickTag('person');
check((await boxes()).length === 3, 'clicking the active tag again clears the filter');

// ── Removing a tag ───────────────────────────────────────────────
await openTagEditor('Ship a CSV parser');
await page.click('.tag-row:not(.tag-sug) .tag-x', { force: true });
await page.waitForTimeout(600);
check((await editorTags()).length === 1, `a tag can be removed: ${JSON.stringify(await editorTags())}`);
await shot(s, 'tags-dark-editor');

// ── The real normalisation, on the real wasm ─────────────────────
// Straight at the boundary, because the editor's input caps length itself and
// a restore can hand over whatever a hand-edited backup contains.
const normCases = await wasm(async (app) => {
	const id = JSON.parse(await app.list_diamonds()).find(r => r.name === 'Rust compiler notes').id;
	const run = async (tags) => {
		await app.set_tags(id, JSON.stringify(tags));
		return JSON.parse(await app.list_diamonds()).find(r => r.id === id).tags;
	};
	const res = {
		collapse: await run(['  My   BIG    Project  ']),
		empties:  await run(['ok', '', '   ', 'fine']),
		dedupe:   await run(['dup', 'DUP', ' dup ']),
		charCap:  await run(['é'.repeat(30)]),
		tagCap:   await run(Array.from({ length: 12 }, (_, i) => `t${i}`)),
	};
	// Malformed input must degrade, not throw.
	try {
		await app.set_tags(id, 'not json at all');
		res.malformed = JSON.parse(await app.list_diamonds()).find(r => r.id === id).tags;
	} catch (e) { res.malformed = `THREW: ${e}`; }
	// What doImport hands over if a hand-edited backup has "tags":"person"
	// (a bare string, not an array). It reaches set_tags as JSON `"person"`.
	try {
		await app.set_tags(id, JSON.stringify('person'));
		res.stringNotArray = JSON.parse(await app.list_diamonds()).find(r => r.id === id).tags;
	} catch (e) { res.stringNotArray = `THREW: ${e}`; }
	res.cleared = await run([]);
	return res;
});
check(JSON.stringify(normCases.collapse) === JSON.stringify(['my big project']),
	`internal whitespace collapses and lowercases: ${JSON.stringify(normCases.collapse)}`);
check(JSON.stringify(normCases.empties) === JSON.stringify(['ok', 'fine']),
	`empty and whitespace-only tags are dropped: ${JSON.stringify(normCases.empties)}`);
check(JSON.stringify(normCases.dedupe) === JSON.stringify(['dup']),
	`tags differing only by case/padding dedupe: ${JSON.stringify(normCases.dedupe)}`);
check(Array.isArray(normCases.charCap) && normCases.charCap.length === 1 && [...normCases.charCap[0]].length === 24,
	`the 24 cap counts CHARACTERS not bytes: ${[...(normCases.charCap[0] || '')].length} chars of 'é' kept`);
check(normCases.tagCap.length === 8, `at most 8 tags are kept: got ${normCases.tagCap.length}`);
check(Array.isArray(normCases.malformed) && normCases.malformed.length === 0,
	`malformed JSON degrades to no tags rather than throwing: ${JSON.stringify(normCases.malformed)}`);
check(Array.isArray(normCases.stringNotArray),
	`a bare string where an array was expected degrades rather than throwing: ${JSON.stringify(normCases.stringNotArray)}`);
check(JSON.stringify(normCases.cleared) === JSON.stringify([]), 'an empty array clears every tag');

// ── Themes ───────────────────────────────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'tags');
await page.waitForTimeout(1200);
await openTagEditor('Ship a CSV parser');
await page.evaluate(() => window.DaimondTheme.set('light'));
await page.waitForTimeout(600);
await shot(s, 'tags-light-editor');
await page.click('.crystal-act', { force: true });
await page.waitForTimeout(400);
await shot(s, 'tags-light-rail');
const contrast = await page.$$eval('.session-box-meta .tag-chip', els => els.map(e => {
	const cs = getComputedStyle(e);
	return { t: e.textContent, fg: cs.color, bg: cs.backgroundColor };
}));
check(contrast.length > 0 && contrast.every(c => c.fg !== c.bg && c.bg !== 'rgba(0, 0, 0, 0)'),
	`light theme resolves chip colours: ${JSON.stringify(contrast[0])}`);
await page.evaluate(() => window.DaimondTheme.set('lollypop'));
await page.waitForTimeout(600);
await shot(s, 'tags-lollypop-rail');
await page.evaluate(() => window.DaimondTheme.set('dark'));
await page.waitForTimeout(400);

// ── Honesty: a tag must never reach the model ────────────────────
// Tag a Diamond with a string that could not occur naturally, steer it, then
// read back everything the mock was actually sent.
await openTagEditor('Mum birthday plan');
await page.fill('.tag-input', 'zqxwmarker');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.click('.crystal-act', { force: true });
await page.waitForTimeout(400);
clearMockLog();
await page.fill('#steer-input', 'Say hello.');
await page.keyboard.press('Enter');
for (let i = 0; i < 40; i++) { if (mockLog().length) break; await page.waitForTimeout(400); }
await page.waitForTimeout(1000);
const sent = JSON.stringify(mockLog());
check(sent.length > 2, 'the model was actually called (so the next check can mean something)');
check(!sent.includes('zqxwmarker'), 'no tag reached the model: not in the prompt, the tools or the transcript');
const allCrystals = await wasm(async (app) => {
	const rows = JSON.parse(await app.list_diamonds());
	let all = '';
	for (const r of rows) { try { all += await app.read_crystal(r.id); } catch (e) { /* none yet */ } }
	return all;
});
check(!allCrystals.includes('zqxwmarker'), 'no tag leaked into any crystal');

// ── The backup round trip ────────────────────────────────────────
// Tags travel with a Diamond, or a restore silently drops the user's whole
// filing system while looking like it worked.
await page.click('#user-row');
await page.waitForTimeout(400);
const dl = page.waitForEvent('download', { timeout: 15000 });
await page.click('button.admin-item:has-text("Export a backup")');
const bpath = scratch('tags-backup.json');
await (await dl).saveAs(bpath);
const backup = JSON.parse(fs.readFileSync(bpath, 'utf8'));
const bmum = (backup.diamonds || []).find(f => f.name === 'Mum birthday plan');
check(bmum && Array.isArray(bmum.tags) && bmum.tags.includes('family'),
	`the export carries tags: ${JSON.stringify(bmum && bmum.tags)}`);
const brust = (backup.diamonds || []).find(f => f.name === 'Rust compiler notes');
check(brust && Array.isArray(brust.tags) && brust.tags.length === 0,
	`an untagged Diamond exports tags:[] not undefined: ${JSON.stringify(brust && brust.tags)}`);

const errsA = errors(s).filter(e => !/502 \(Bad Gateway\)/.test(e));
check(errsA.length === 0, `no console errors beyond the offline gateway: ${JSON.stringify(errsA.slice(0, 3))}`);
await s.close();

// A fresh profile: nothing of the first session is on this disk.
const b = await open({ name: 'tagsB' });
await b.page.click('#user-row');
await b.page.waitForTimeout(400);
const chooser = b.page.waitForEvent('filechooser', { timeout: 15000 });
await b.page.click('button.admin-item:has-text("Import a backup")');
await (await chooser).setFiles(bpath);
// A restore now confirms and reloads to bring every restored surface back
// consistent; acknowledge it, let it reload, and unlock the fresh session.
await b.page.waitForSelector('.dlg-ok', { timeout: 15000 });
await b.page.click('.dlg-ok');
await b.page.waitForSelector('#id-primary', { timeout: 15000 });
await signInAs(b, 'tagsB');
await b.page.waitForTimeout(800);
const restored = await b.page.$$eval('.diamond-box', els => els.map(e => ({
	name: (e.querySelector('.session-box-name') || {}).textContent,
	tags: [...e.querySelectorAll('.session-box-meta .tag-chip')].map(c => c.textContent),
	more: (e.querySelector('.tag-more') || {}).textContent || null,
})));
// A restore must bring each Diamond back ONCE. The workspace files carry the whole
// of `diamonds/<id>/` (crystal, versions, log, meta with tags), so restoring them
// reconstitutes each Diamond with its history; doImport no longer ALSO recreates it
// from the summary, which used to yield two ids for one Diamond.
check(restored.length === 3, `a restore brings each Diamond back exactly once -- got ${restored.length}, expected 3: ${JSON.stringify(restored.map(r => r.name))}`);

// The thing this pass is actually proving: tags survive the round trip.
const rmum = restored.filter(r => r.name === 'Mum birthday plan');
check(rmum.length > 0 && rmum.every(r => r.tags.length === 3 && r.more === '+2'),
	`tags RESTORE from a backup into a fresh profile (5 tags -> 3 chips + "+2"): ${JSON.stringify(rmum[0])}`);
const rrust = restored.filter(r => r.name === 'Rust compiler notes');
check(rrust.length > 0 && rrust.every(r => r.tags.length === 0),
	`an untagged Diamond restores untagged, with no chips: ${JSON.stringify(rrust[0])}`);
await shot(b, 'tags-restored');
const errsB = errors(b).filter(e => !/502 \(Bad Gateway\)/.test(e));
check(errsB.length === 0, `no console errors on the restoring session: ${JSON.stringify(errsB.slice(0, 3))}`);
await b.close();

console.log(out.join('\n'));
if (known.length) console.log(`\nKNOWN, NOT THIS CHANGE:\n  - ${known.join('\n  - ')}`);
console.log(bad === 0 ? `\nALL ${out.length} CHECKS PASSED` : `\n${bad} of ${out.length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
