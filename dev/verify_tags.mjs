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
// An empty account is already told "No Diamonds yet." -- a second line about
// tags there would be nagging about a thing there is nothing to do it to.
check(!(await page.isVisible('#diamond-tag-hint')), 'no tag hint on an account with no Diamonds at all');

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

// ── The tag pool's empty state ───────────────────────────────────
// Every chip in the rail is drawn from a Diamond, so a store with no tag on
// anything draws none, and a rail that is just a search box reads as filing
// that was taken away rather than filing not yet done. That is how the tag
// loss was read, twice. Say which, where the chips would be.
const hintText = () => page.$eval('#diamond-tag-hint', e => e.textContent).catch(() => '');
check(await page.isVisible('#diamond-tag-hint'),
	'a store with Diamonds but no tags shows a hint where the chips would be');
check((await hintText()).includes('No tags yet'),
	`the hint says the tags are missing, not the feature: ${JSON.stringify(await hintText())}`);
// It must not sit anywhere a chip's text is read from: the filter chip's text
// IS a tag name, and the list's text is read for "No Diamonds match".
check(await page.$eval('#diamond-tag-hint',
	e => !e.closest('#diamond-filter') && !e.closest('#diamond-list')).catch(() => false),
	'the hint sits outside the filter chip and outside the Diamonds list');
check(!(await page.isVisible('#diamond-filter')), 'and it does not raise an empty filter chip beside it');
// The route to a first tag, for the reader who wants it, in the order the pool
// really offers them -- a hint promising chips the editor does not offer would
// be the same lie in a smaller font.
const hintTip = await page.$eval('#diamond-tag-hint', e => e.title).catch(() => '');
check(hintTip.includes('person, project, topic, org'),
	`the hint's tooltip names the starter tags in the pool's order: ${JSON.stringify(hintTip)}`);
await shot(s, 'tags-empty-hint');

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

// ── The hint goes when there is something to filter with ─────────
const tagged = (await railOf()).find(r => r.name === 'Ship a CSV parser');
check(tagged && tagged.tags.length === 2 && !(await page.isVisible('#diamond-tag-hint')),
	`one tag anywhere replaces the hint with chips: chips=${JSON.stringify(tagged && tagged.tags)}`);
await shot(s, 'tags-chips-no-hint');

// ── And comes back when the last tag goes ────────────────────────
// The state the user was actually left in when the sync bug ate the tag set:
// the filing system is empty again, and the rail has to say so rather than
// look like the feature went with it.
await openTagEditor('Ship a CSV parser');
for (let i = 0; i < 2; i++) {
	await page.click('.tag-row:not(.tag-sug) .tag-x', { force: true });
	await page.waitForTimeout(600);
}
check((await editorTags()).length === 0, `both tags come off: ${JSON.stringify(await editorTags())}`);
check(await page.isVisible('#diamond-tag-hint'), 'deleting the LAST tag brings the hint back');
// Put them back the way the pool offers them, so the rest of this pass sees
// the store it expects.
for (const want of ['person', 'rust']) {
	for (const c of await page.$$('.tag-sug .tag-chip')) {
		if ((await c.textContent()) === want) { await c.click({ force: true }); break; }
	}
	await page.waitForTimeout(600);
}
const restoredTwo = await editorTags();
check(restoredTwo.includes('person') && restoredTwo.includes('rust') && !(await page.isVisible('#diamond-tag-hint')),
	`and goes again once a tag is back: ${JSON.stringify(restoredTwo)}`);
await page.click('.crystal-act', { force: true });          // ← Back to the crystal
await page.waitForTimeout(500);

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

// ── The boolean the rail actually holds ──────────────────────────
// One tag was never enough to say "the family things, but not the ones already
// bought". The rail keeps two lists -- the tags wanted and the tags refused --
// and a rule for combining the first. Every state below is reached the way a
// user reaches it: by clicking chips.
//
// The fixture here: "Ship a CSV parser" [person, rust], "Mum birthday plan"
// [person, family, gifts, urgent], "Rust compiler notes" [].

/// What the summary beside the search box is saying, read off the DOM.
///
/// A summary chip's text is the tag plus the × that takes it out -- that × is a
/// real text node, and the check above asserts it -- so it is stripped here, the
/// way the editor's reader strips it. Nothing ELSE may be in there: `raw` keeps
/// the untouched text so the negation mark can be proved absent from it.
const fstate = () => page.evaluate(() => {
	const f  = document.getElementById('diamond-filter');
	const up = !!f && f.style.display !== 'none' && getComputedStyle(f).display !== 'none';
	const chips = up ? [...f.querySelectorAll('.tag-chip')] : [];
	const name = c => c.textContent.replace(/×$/, '');
	const on = up ? f.querySelector('.tag-mode-btn.on') : null;
	return {
		up,
		inc:   chips.filter(c => !c.classList.contains('tag-no')).map(name),
		exc:   chips.filter(c =>  c.classList.contains('tag-no')).map(name),
		raw:   chips.map(c => c.textContent),
		mode:  on ? on.dataset.mode : null,
		clear: up && !!f.querySelector('.tag-clear-all'),
	};
});
/// Click a chip in the SUMMARY, which takes that tag out of the filter. Matched
/// past the closer, which is a text node in there and part of the chip's text.
const dropChip = async (name) => {
	const hit = await page.$$eval('#diamond-filter .tag-chip', (els, n) => {
		for (const e of els) if (e.textContent.replace(/×$/, '') === n) { e.click(); return true; }
		return false;
	}, name);
	if (!hit) check(false, `the summary offers a "${name}" chip to click`);
	await page.waitForTimeout(400);
};
const setMode = async (m) => {
	await page.click(`#diamond-filter .tag-mode-btn[data-mode="${m}"]`, { force: true });
	await page.waitForTimeout(400);
};
const railMarks = () => page.$$eval('.session-box-meta .tag-chip',
	els => els.map(e => ({ t: e.textContent, on: e.classList.contains('tag-inc') })));

// A rail chip cycles: off -> wanted -> refused -> off. The last leg is walked
// from the summary, because refusing a tag takes every Diamond carrying it off
// the rail, and the chip goes with them.
const cyc = [];
await clickTag('person');
cyc.push(await fstate());
const wantMarks = await railMarks();
check(wantMarks.some(m => m.t === 'person' && m.on) && wantMarks.every(m => m.t === 'person' || !m.on),
	`the chip doing the filtering is marked in the rail, and only it: ${JSON.stringify(wantMarks)}`);
await clickTag('person');
cyc.push(await fstate());
const refused = await boxes();
check(refused.length === 1 && refused[0] === 'Rust compiler notes',
	`a second click refuses the tag, and its carriers leave the rail: ${JSON.stringify(refused)}`);
check(JSON.stringify(cyc[1].raw) === JSON.stringify(['person×']),
	`a refused chip's text is the tag and its closer, and nothing else: ${JSON.stringify(cyc[1].raw)}`);
const negation = await page.$eval('#diamond-filter .tag-no',
	e => getComputedStyle(e, '::before').content).catch(() => '');
check(negation.includes('¬'),
	`the negation is drawn by the theme, not put in the chip's text: ${JSON.stringify(negation)}`);
await shot(s, 'tags-dark-exclude');
await dropChip('person');
cyc.push(await fstate());
check(!cyc[2].up && (await boxes()).length === 3,
	`a click in the summary puts the tag down again: ${JSON.stringify(cyc[2])}`);
// The state a predicate would have to invent a meaning for -- one tag both
// wanted and refused -- is one the cycle cannot produce: each leg MOVES the
// tag, and moving is not copying. A step holding it in both lists would read
// "inc+exc" below and fail, and so would a leg that never happened, so this one
// line is both the order and the impossibility.
const where = st => ['inc', 'exc'].filter(k => st[k].indexOf('person') !== -1).join('+') || 'off';
check(JSON.stringify(cyc.map(where)) === JSON.stringify(['inc', 'exc', 'off']),
	`the cycle is off -> wanted -> refused -> off, one list at a time: ${JSON.stringify(cyc.map(where))}`);

// ── ALL and ANY ──────────────────────────────────────────────────
await clickTag('person');
check((await fstate()).mode === null && (await fstate()).clear === false,
	'with one tag wanted there is no combining control and no clear-all: neither would change anything');
await clickTag('rust');
const bothTags = await boxes();
check(bothTags.length === 1 && bothTags[0] === 'Ship a CSV parser',
	`two wanted tags default to ALL -- only the Diamond carrying both: ${JSON.stringify(bothTags)}`);
const modeUp = await fstate();
check(modeUp.mode === 'all' && modeUp.clear === true,
	`a second tag raises the combining control on ALL, and a clear-all: ${JSON.stringify(modeUp)}`);
await setMode('any');
const anyBoxes = await boxes();
check(anyBoxes.length === 2 && anyBoxes.includes('Mum birthday plan') && anyBoxes.includes('Ship a CSV parser'),
	`ANY gives the union of the two instead: ${JSON.stringify(anyBoxes)}`);
await shot(s, 'tags-dark-any');

// The mode is a habit of reading and is kept; the two lists are a way of looking
// at this page and are not. An account switch reloads, so this is that too.
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'tags');
await page.waitForTimeout(1500);
const afterBoot = await fstate();
check(!afterBoot.up && (await boxes()).length === 3,
	`the wanted and refused lists do not survive a reload -- which is what an account switch is: ${JSON.stringify(afterBoot)}`);
check(!(await page.isVisible('#diamond-tag-hint')),
	'and the empty-pool hint stays away, because it keys off tags existing, not off filtering');
await clickTag('person');
await clickTag('rust');
const kept = await fstate();
check(kept.mode === 'any' && (await boxes()).length === 2,
	`the ALL/ANY choice IS kept across the reload: ${JSON.stringify(kept)}`);
await dropChip('rust');
const oneLeft = await fstate();
check(oneLeft.mode === null && oneLeft.clear === false && (await boxes()).length === 2,
	`and the control goes again when one tag is left: ${JSON.stringify(oneLeft)}`);

// ── A refusal beats a want ───────────────────────────────────────
// "Mum birthday plan" carries `person`, which is wanted. Refusing `family`
// still takes it off the rail: a tag you have said you do not want to see
// cannot be talked round by one you do.
await clickTag('rust');                     // wanted: person, rust (ANY)
await clickTag('family');                   // wanted: + family, so Mum still shows
await clickTag('family');                   // refused
const beaten = await boxes();
check(beaten.length === 1 && beaten[0] === 'Ship a CSV parser',
	`a refused tag hides its Diamond even though a wanted tag matches it: ${JSON.stringify(beaten)}`);
const halves = await fstate();
check(JSON.stringify(halves.inc.slice().sort()) === JSON.stringify(['person', 'rust'])
	&& JSON.stringify(halves.exc) === JSON.stringify(['family']),
	`the summary shows both halves at once, so neither reason for hiding is silent: ${JSON.stringify(halves)}`);
await shot(s, 'tags-dark-boolean');
check((await search('csv')).length === 1, 'the search box composes on top of the boolean');
const boolNone = await search('zzzznope');
check(boolNone.length === 0 && (await page.textContent('.diamond-list')).includes('No Diamonds match'),
	'and a search that matches nothing inside a boolean still says so');
await search('');

// ── Clear-all, and an honest empty rail ──────────────────────────
await page.click('#diamond-filter .tag-clear-all', { force: true });
await page.waitForTimeout(400);
const cleared = await fstate();
check(!cleared.up && (await boxes()).length === 3,
	`one click on the clear-all puts both lists down: ${JSON.stringify(cleared)}`);
// ALL over two tags no Diamond shares. Reached under ANY, where both chips stay
// on the rail to be clicked, then narrowed.
await clickTag('person');
await clickTag('rust');
await clickTag('family');
await dropChip('person');
const anyTwo = await boxes();
check(anyTwo.length === 2, `ANY over rust and family holds both their Diamonds: ${JSON.stringify(anyTwo)}`);
await setMode('all');
const impossible = await boxes();
check(impossible.length === 0 && (await page.textContent('.diamond-list')).includes('No Diamonds match'),
	`ALL over two tags no Diamond shares empties the rail and says why: ${JSON.stringify(impossible)}`);
await page.click('#diamond-filter .tag-clear-all', { force: true });
await page.waitForTimeout(400);
check((await boxes()).length === 3, 'and the clear-all brings them back');

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

// ── Deleting a tag that the filter is holding ────────────────────
// Done on this profile because it destroys tags, and nothing follows it. A tag
// deleted while WANTED would leave a filter no Diamond can satisfy; deleted
// while REFUSED it would go on hiding Diamonds with no chip anywhere to click.
// It has to leave both lists.
const bp = b.page;
const bBoxes = () => bp.$$eval('.diamond-box .session-box-name', els => els.map(e => e.textContent));
const bClickTag = async (name) => {
	await bp.$$eval('.session-box-meta .tag-chip', (els, n) => {
		for (const e of els) if (e.textContent === n) { e.click(); return; }
	}, name);
	await bp.waitForTimeout(400);
};
const bState = () => bp.evaluate(() => {
	const f  = document.getElementById('diamond-filter');
	const up = !!f && f.style.display !== 'none' && getComputedStyle(f).display !== 'none';
	const chips = up ? [...f.querySelectorAll('.tag-chip')] : [];
	const name = c => c.textContent.replace(/×$/, '');
	return {
		up,
		inc: chips.filter(c => !c.classList.contains('tag-no')).map(name),
		exc: chips.filter(c =>  c.classList.contains('tag-no')).map(name),
	};
});
/// Delete a tag from the pool in the tag editor, and confirm it.
const bKill = async (name) => {
	await bp.evaluate((n) => {
		const chip = [...document.querySelectorAll('.tag-sug .tag-chip')].find(e => e.textContent === n);
		if (chip) chip.querySelector('.tag-kill').click();
	}, name);
	await bp.waitForSelector('.dlg-ok', { timeout: 10000 });
	await bp.click('.dlg-ok');
	await bp.waitForTimeout(1200);
};
// Unlocking left the Admin drawer over the rail, and it takes the clicks meant
// for a Diamond box. Dismiss it exactly as a user would.
const adminX = await bp.$('#admin-close');
if (adminX && await adminX.isVisible()) { await adminX.click({ force: true }); await bp.waitForTimeout(400); }
// The editor is opened FIRST, on "Ship a CSV parser": the pool only offers what
// is not already on the Diamond being edited, and the filter below is built out
// of tags that are on another one. The editor lives in the centre; the rail it
// is read against stays where it is.
const bIdx = (await bBoxes()).indexOf('Ship a CSV parser');
await bp.$$eval('.diamond-box', (els, i) => els[i].click(), bIdx);
await bp.waitForTimeout(500);
for (const btn of await bp.$$('.crystal-act')) {
	if ((await btn.textContent()).includes('Tags')) { await btn.click({ force: true }); break; }
}
await bp.waitForSelector('.tag-editor', { timeout: 5000 });
await bClickTag('gifts');                   // wanted: "Mum birthday plan" alone
await bClickTag('family');                  // wanted as well; Mum carries both
await bClickTag('family');                  // refused, so Mum goes and the rail empties
const bSet = await bState();
check(JSON.stringify(bSet.inc) === JSON.stringify(['gifts']) && JSON.stringify(bSet.exc) === JSON.stringify(['family']),
	`a filter with one tag in each list, built by clicking: ${JSON.stringify(bSet)}`);
check((await bBoxes()).length === 0, 'and it is currently hiding everything, which is the point');
await bKill('family');
const afterExcKill = await bState();
check(afterExcKill.exc.length === 0 && JSON.stringify(afterExcKill.inc) === JSON.stringify(['gifts'])
	&& (await bBoxes()).length === 1,
	`deleting a REFUSED tag takes it out of the filter, leaves the rest, and gives the Diamonds back: ${JSON.stringify(afterExcKill)}`);
await bKill('gifts');
const afterIncKill = await bState();
check(!afterIncKill.up && (await bBoxes()).length === 3,
	`deleting a WANTED tag clears the filter rather than emptying the rail: ${JSON.stringify(afterIncKill)}, ${JSON.stringify(await bBoxes())}`);

const errsB = errors(b).filter(e => !/502 \(Bad Gateway\)/.test(e));
check(errsB.length === 0, `no console errors on the restoring session: ${JSON.stringify(errsB.slice(0, 3))}`);
await b.close();

console.log(out.join('\n'));
if (known.length) console.log(`\nKNOWN, NOT THIS CHANGE:\n  - ${known.join('\n  - ')}`);
console.log(bad === 0 ? `\nALL ${out.length} CHECKS PASSED` : `\n${bad} of ${out.length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
