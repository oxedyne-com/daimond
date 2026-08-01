// Verify Diamond tags: chips, search, the standing tag pool, the tag editor,
// persistence, and the backup round trip -- against the real wasm, no stubs.
//
// Tags are the user's filing system and nothing else, so the check that
// matters most is the one proving a tag never reaches the model.
//
// The filter used to be drawn only once a tag had been clicked, and the only
// chip to click sat on a Diamond box -- so the space under the search box, which
// is where a filter goes, was empty until you had already found another way in.
// It is a POOL now: every tag in use, each chip cycling off -> wanted ->
// refused -> off where it sits. The checks that used to read a summary read the
// pool instead; the ones that asserted a summary chip's closer now assert the
// stronger thing, that a pool chip's text is the bare tag.
//
// The pool STOOD, and that was a rent it could not pay: thirty tags is three and
// a half rows of chips under the search box on every screen, whether anything is
// being filtered or not, and the rail's two lists live on what is left. It sits
// behind a DISCLOSURE now -- one muted row naming the feature and counting what
// is behind it, in the place and the ink of the "No tags yet" line, so the
// question "is there a filter here?" is answered before it is asked either way.
// The checks that asserted the pool stands by default now assert the disclosure
// stands by default: what is superseded is the pool being permanently up, not
// the pool. Two properties are new and load-bearing -- the choice is kept across
// a reload, and a filter that is ON is never invisible, because closed the chips
// holding it come out and stand on their own.

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

/// How the rail's two lists are sharing it. The furniture above them is cut out
/// of the same column, so anything that changes the furniture's height has to
/// make that cut again or the divider walks.
const shareOn = (pg) => pg.evaluate(() => {
	const l = document.getElementById('diamond-list').getBoundingClientRect().height;
	const c = document.getElementById('session-list').getBoundingClientRect().height;
	return { list: Math.round(l), sess: Math.round(c), share: +(l / (l + c)).toFixed(3),
		handle: !!document.getElementById('handle-rail-split') };
});

/// Open or close the pool, by the one control a user has for it. A no-op when it
/// is already the way round it was asked for.
const setPoolOn = async (pg, want) => {
	const now = await pg.$eval('#diamond-filter .tagf-toggle',
		b => b.getAttribute('aria-expanded') === 'true').catch(() => null);
	if (now === null || now === want) return now;
	await pg.click('#diamond-filter .tagf-toggle', { force: true });
	await pg.waitForTimeout(400);
	return want;
};

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
// The starters are translated, so they are read from the table rather than
// spelled out here: a test that hardcodes the English four passes in English
// and fails in the other seven for no reason but its own assumption.
const STARTERS = fs.readFileSync(new URL('../www/i18n/en.js', import.meta.url), 'utf8')
	.match(/'tag\.starters':\s*'([^']*)'/)[1]
	.split(',').map(x => x.trim()).filter(Boolean);
const hintTip = await page.$eval('#diamond-tag-hint', e => e.title).catch(() => '');
check(hintTip.includes(STARTERS.join(', ')),
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
check(JSON.stringify(sugs) === JSON.stringify(STARTERS),
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

// ── The standing pool ────────────────────────────────────────────
// The filter used to be drawn only once something had been clicked, and the
// only thing to click was a chip on a Diamond box. So a reader who went looking
// for the filter under the search box -- which is where a filter goes -- found
// nothing there, and concluded there wasn't one. The pool is the surface now:
// it is up before anything is touched, and it says what the vocabulary is.
/// Every chip in the pool, in the order the pool offers them.
const poolText = () => page.$$eval('#diamond-filter .tagf-pool .tag-chip',
	els => els.map(e => e.textContent));
/// Each pool chip and the state its class says the rail is holding it in.
const poolState = () => page.$$eval('#diamond-filter .tagf-pool .tag-chip', els => els.map(e => ({
	t: e.textContent,
	s: e.classList.contains('tag-inc') ? 'inc' : e.classList.contains('tag-no') ? 'exc' : 'off',
})));
const stateOf = (st, tag) => (st.find(x => x.t === tag) || { s: 'ABSENT' }).s;
/// One click on a pool chip: the same cycle a chip on a Diamond box walks.
const poolClick = async (tag) => {
	const hit = await page.$$eval('#diamond-filter .tagf-pool .tag-chip', (els, n) => {
		for (const e of els) if (e.textContent === n) { e.click(); return true; }
		return false;
	}, tag);
	if (!hit) check(false, `the pool offers a "${tag}" chip to click`);
	await page.waitForTimeout(400);
};
/// Round the cycle until the tag is filtering nothing. Bounded: the cycle is
/// three legs, so a fourth click would mean it does not close.
const poolOff = async (tag) => {
	for (let i = 0; i < 3 && stateOf(await poolState(), tag) !== 'off'; i++) await poolClick(tag);
};
/// One click on a tag chip on a Diamond BOX -- the other way into the filter,
/// and the only one there is while the pool is closed.
const clickTag = async (name) => {
	await page.$$eval('.session-box-meta .tag-chip', (els, n) => {
		for (const e of els) if (e.textContent === n) { e.click(); return; }
	}, name);
	await page.waitForTimeout(400);
};

// ── The disclosure the pool sits behind ──────────────────────────
// One row, always there once a tag is, naming the feature and counting what is
// behind it. This is the whole of the answer to both faults at once: a reader
// who goes looking under the search box finds the filter named, and a reader
// who never touches it pays one line for it instead of four.

/// The disclosure row: what it says, what it is holding, and how much of the
/// rail it takes -- a label is a word to hit, a row is a row.
const disc = () => page.evaluate(() => {
	const b = document.querySelector('#diamond-filter .tagf-toggle');
	if (!b) return null;
	const f = document.getElementById('diamond-filter');
	const chev = document.querySelector('#diamond-filter .tagf-chev');
	const cs = chev ? getComputedStyle(chev) : null;
	return {
		text: b.textContent.trim(),
		open: b.getAttribute('aria-expanded') === 'true',
		pool: !!document.querySelector('#diamond-filter .tagf-pool'),
		w:    Math.round(b.getBoundingClientRect().width),
		fw:   Math.round(f.getBoundingClientRect().width),
		// The chevron must be INK, not a character: borders on an empty box,
		// turned. A font glyph would be one missing-glyph box away from saying
		// nothing at all, in a UI that ships eight languages.
		chev: cs ? { rt: cs.borderRightWidth, bt: cs.borderBottomWidth,
			tr: cs.transform, txt: chev.textContent } : null,
	};
});
/// What the filter is saying while the pool is CLOSED: the chips that are
/// holding it, standing on their own.
const astate = () => page.evaluate(() => {
	const f   = document.getElementById('diamond-filter');
	const row = f && f.querySelector('.tagf-active');
	const chips = row ? [...row.querySelectorAll('.tag-chip')] : [];
	return {
		row:  !!row,
		pool: !!(f && f.querySelector('.tagf-pool')),
		ctl:  !!(f && f.querySelector('.tagf-ctl')),
		chips: chips.map(c => ({
			t: c.textContent,
			s: c.classList.contains('tag-inc') ? 'inc' : c.classList.contains('tag-no') ? 'exc' : 'off',
		})),
	};
});
/// One click on a chip in the collapsed active row.
const actClick = async (tag) => {
	const hit = await page.$$eval('#diamond-filter .tagf-active .tag-chip', (els, n) => {
		for (const e of els) if (e.textContent === n) { e.click(); return true; }
		return false;
	}, tag);
	if (!hit) check(false, `the active row offers a "${tag}" chip to click`);
	await page.waitForTimeout(400);
};

const d0 = await disc();
check(!!d0 && !d0.pool,
	`the pool is DOWN by default -- it is rent the rail pays on every screen: ${JSON.stringify(d0)}`);
check(!!d0 && d0.open === false, 'and the disclosure says so, in the attribute a screen reader reads');
check(!!d0 && /Filter by tag/.test(d0.text) && /\(2\)/.test(d0.text),
	`the row names the feature and counts what is behind it: ${JSON.stringify(d0 && d0.text)}`);
// The fault this replaces was a feature read as ABSENT, twice. A row that hid
// its own count would be the same mistake: "Filter by tag" with nothing behind
// it and "Filter by tag" with twelve are different offers.
check(!!d0 && d0.w >= d0.fw - 1,
	`and the whole row is the target, not the words -- at 250px a rail is mostly empty on the right: ${d0 && d0.w}px of ${d0 && d0.fw}px`);
check(!!d0 && !!d0.chev && parseFloat(d0.chev.rt) > 0 && parseFloat(d0.chev.bt) > 0
	&& d0.chev.tr !== 'none' && d0.chev.txt === '',
	`the chevron is drawn in CSS, not typed: ${JSON.stringify(d0 && d0.chev)}`);
check(!!d0 && !/[▸▾►▼▶#⌄›»→]/.test(d0.text),
	`so no glyph rides in the label's text, where a missing font would eat it: ${JSON.stringify(d0 && d0.text)}`);
await shot(s, 'tags-pool-collapsed');

// Opening it, and the divider not moving when it does. The furniture grows by
// a whole pool here; the two lists below are cut out of the same column.
const shareShut = await shareOn(page);
await setPoolOn(page, true);
const dOpen = await disc();
const shareOpen = await shareOn(page);
check(!!dOpen && dOpen.open && dOpen.pool, 'one click opens the pool, and the row says which way it is now');
check(shareOpen.list + shareOpen.sess < shareShut.list + shareShut.sess,
	`opening it really does take height off the two lists: ${shareShut.list + shareShut.sess}px -> ${shareOpen.list + shareOpen.sess}px`);
check(Math.abs(shareOpen.share - shareShut.share) <= 0.03,
	`and the divider holds its share rather than walking: ${shareShut.share} -> ${shareOpen.share}`);

check(await page.isVisible('#diamond-filter .tagf-pool'),
	'the tag pool is one click under the search box the moment a tag exists');
check(JSON.stringify(await poolText()) === JSON.stringify(['person', 'rust']),
	`and holds the tags actually in use, sorted: ${JSON.stringify(await poolText())}`);
// The editor offers `project`, `topic` and `org` whatever the store holds. The
// rail must not: filtering on a tag no Diamond carries can only empty the rail,
// so a chip for one would be a control whose single outcome is nothing.
check(!(await poolText()).some(x => ['project', 'topic', 'org'].includes(x)),
	`the starter suggestions nobody has used are NOT offered as filters: ${JSON.stringify(await poolText())}`);
// The chips are the reason every reader of a chip can strip a closer and be
// wrong: here there is nothing to strip.
check((await poolText()).every(x => x === x.trim() && !/[×¬]/.test(x)),
	`a pool chip's text is the bare tag -- no closer, no mark: ${JSON.stringify(await poolText())}`);
await shot(s, 'tags-pool-idle');
await shot(s, 'tags-chips-no-hint');

// ── The choice is kept, and a live filter is never invisible ─────
// Opening the pool is a habit of working, like the ALL/ANY mode, so it lasts
// past the page. Closing it must not take the FILTER with it: a rail that is
// hiding Diamonds and will not say why is the fault this whole surface exists
// to avoid, one size worse than the one it replaced.
await setPoolOn(page, false);
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'tags');
await page.waitForTimeout(1500);
const dReload = await disc();
check(!!dReload && !dReload.open && !dReload.pool,
	`the pool stays down across a reload, because that is what was chosen: ${JSON.stringify(dReload)}`);

// The one path that reaches the filter with the pool closed: a chip on a
// Diamond box. It must surface the state where the pool would have shown it.
await clickTag('person');
const aInc = await astate();
check(aInc.row && !aInc.pool && JSON.stringify(aInc.chips) === JSON.stringify([{ t: 'person', s: 'inc' }]),
	`closed, a filter puts its OWN chips up rather than nothing: ${JSON.stringify(aInc)}`);
check(aInc.ctl, 'and the controls that are not tags come with them, exactly as they do open');
// Only "Ship a CSV parser" carries a tag at this point in the pass.
check((await boxes()).length === 1, 'the filter really is on while the pool is down');
await shot(s, 'tags-pool-collapsed-active');
// The same chip, cycling the same way it does in the pool -- it IS a pool chip,
// standing somewhere else, so there is no second behaviour to keep in step.
await actClick('person');
const aExc = await astate();
check(JSON.stringify(aExc.chips) === JSON.stringify([{ t: 'person', s: 'exc' }])
	&& (await boxes()).length === 2,
	`a chip in the active row cycles in place, and refusing takes its carrier off the rail: ${JSON.stringify(aExc)}, ${JSON.stringify(await boxes())}`);
await actClick('person');
const aOff = await astate();
check(!aOff.row && !aOff.ctl && !aOff.pool && (await boxes()).length === 3,
	`and the row goes when the last tag comes off the filter, leaving the one row: ${JSON.stringify(aOff)}`);
// Opening it while a filter is on shows the state IN the pool, where each chip
// already carries its own -- so the two rows are never both saying it.
await clickTag('person');
await setPoolOn(page, true);
const aOpen = await astate();
check(!aOpen.row && aOpen.pool && stateOf(await poolState(), 'person') === 'inc',
	`open, the active row stands down: the pool chip is already wearing the state: ${JSON.stringify(aOpen)}`);
await page.click('#diamond-filter .tag-clear-all', { force: true });
await page.waitForTimeout(400);

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
check(!(await page.isVisible('#diamond-filter')),
	'and the pool goes with it -- an empty pool is a row of nothing, which is what the hint is for');
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
await clickTag('person');
const filtered = await boxes();
check(filtered.length === 2 && filtered.includes('Mum birthday plan') && filtered.includes('Ship a CSV parser'),
	`clicking a chip filters to that tag: ${JSON.stringify(filtered)}`);
// The pool is the same surface whichever chip started the filter: clicking one
// on a Diamond box lights that tag WHERE THE POOL ALREADY SHOWS IT.
check(stateOf(await poolState(), 'person') === 'inc',
	`a click on a box chip lights that tag in the pool: ${JSON.stringify(await poolState())}`);
check(await page.$eval('#diamond-filter .tag-chip.tag-inc', e => e.style.getPropertyValue('--tag-h')) === personHue,
	'the pool chip is the same colour as the tag it stands for');
// The controls that are NOT tags sit below the pool, and only when there is a
// filter for them to act on.
check(await page.isVisible('#diamond-filter .tagf-ctl'),
	'a filter raises the controls below the pool');
await shot(s, 'tags-dark-filter');
check((await search('mum')).length === 1, 'search narrows within an active tag filter');
await search('');
// The clear is the one-click way off. A pool chip carries no closer -- its text
// is the tag and nothing else -- so the cycle takes two clicks to put one tag
// down, and this is offered for a filter of any size because of it.
await page.click('#diamond-filter .tag-clear-all', { force: true });
await page.waitForTimeout(400);
check((await boxes()).length === 3 && !(await page.isVisible('#diamond-filter .tagf-ctl'))
	&& stateOf(await poolState(), 'person') === 'off',
	'the clear puts the filter down, and the pool stays up with every chip off');

// ── The boolean the rail actually holds ──────────────────────────
// One tag was never enough to say "the family things, but not the ones already
// bought". The rail keeps two lists -- the tags wanted and the tags refused --
// and a rule for combining the first. Every state below is reached the way a
// user reaches it: by clicking chips.
//
// The fixture here: "Ship a CSV parser" [person, rust], "Mum birthday plan"
// [person, family, gifts, urgent], "Rust compiler notes" [].

/// What the pool beside the search box is saying, read off the DOM.
///
/// No text is stripped anywhere here. A pool chip's textContent is the tag and
/// nothing else -- both marks are drawn by the theme -- so the state is read
/// from the classes and `raw` can prove the text itself carries neither.
/// `up` is now "something is filtering", not "the element is drawn": the pool
/// is standing furniture and is drawn whenever a tag exists at all.
const fstate = () => page.evaluate(() => {
	const f     = document.getElementById('diamond-filter');
	const shown = !!f && f.style.display !== 'none' && getComputedStyle(f).display !== 'none';
	const chips = shown ? [...f.querySelectorAll('.tagf-pool .tag-chip')] : [];
	const inc   = chips.filter(c => c.classList.contains('tag-inc'));
	const exc   = chips.filter(c => c.classList.contains('tag-no'));
	const on    = shown ? f.querySelector('.tag-mode-btn.on') : null;
	return {
		shown,
		up:    inc.length + exc.length > 0,
		pool:  chips.map(c => c.textContent),
		inc:   inc.map(c => c.textContent),
		exc:   exc.map(c => c.textContent),
		raw:   inc.concat(exc).map(c => c.textContent),
		mode:  on ? on.dataset.mode : null,
		clear: shown && !!f.querySelector('.tag-clear-all'),
		ctl:   shown && !!f.querySelector('.tagf-ctl'),
	};
});
const setMode = async (m) => {
	await page.click(`#diamond-filter .tag-mode-btn[data-mode="${m}"]`, { force: true });
	await page.waitForTimeout(400);
};
const railMarks = () => page.$$eval('.session-box-meta .tag-chip',
	els => els.map(e => ({ t: e.textContent, on: e.classList.contains('tag-inc') })));

// A chip cycles: off -> wanted -> refused -> off. Every leg is now walked in
// the POOL, from one chip that never moves -- which is the point of it. On a
// Diamond box the last leg is out of reach: refusing a tag takes every Diamond
// carrying it off the rail, and the box chip goes with them.
const cyc = [];
await clickTag('person');
cyc.push(await fstate());
const wantMarks = await railMarks();
check(wantMarks.some(m => m.t === 'person' && m.on) && wantMarks.every(m => m.t === 'person' || !m.on),
	`the chip doing the filtering is marked in the rail, and only it: ${JSON.stringify(wantMarks)}`);
check(stateOf(await poolState(), 'person') === 'inc',
	'and the pool wears the same mark for the same tag, so the two surfaces agree');
await poolClick('person');
cyc.push(await fstate());
const refused = await boxes();
check(refused.length === 1 && refused[0] === 'Rust compiler notes',
	`a second click refuses the tag, and its carriers leave the rail: ${JSON.stringify(refused)}`);
// The property the pool exists for. Every Diamond carrying `person` has just
// left the rail, so there is no box chip for it anywhere -- and the refusal is
// still one click from being put down, because the pool is drawn from the store.
check(stateOf(await poolState(), 'person') === 'exc'
	&& !(await railOf()).some(r => r.tags.includes('person')),
	`a REFUSED tag stays in the pool though no Diamond showing it carries it: ${JSON.stringify(await poolState())}`);
check(JSON.stringify(cyc[1].raw) === JSON.stringify(['person']),
	`a refused chip's text is the bare tag and nothing else: ${JSON.stringify(cyc[1].raw)}`);
const negation = await page.$eval('#diamond-filter .tag-no',
	e => getComputedStyle(e, '::before').content).catch(() => '');
check(negation.includes('¬'),
	`the negation is drawn by the theme, not put in the chip's text: ${JSON.stringify(negation)}`);
await shot(s, 'tags-dark-exclude');
await poolClick('person');
cyc.push(await fstate());
check(!cyc[2].up && (await boxes()).length === 3,
	`a third click in the pool puts the tag down again: ${JSON.stringify(cyc[2])}`);
check(cyc.every(st => st.shown) && cyc.map(st => st.ctl).join() === 'true,true,false',
	`the pool stands through all three legs; only the controls come and go: ${JSON.stringify(cyc.map(st => [st.shown, st.ctl]))}`);
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
check((await fstate()).mode === null,
	'with one tag wanted there is no combining control: ALL and ANY would name the same list');
// The clear IS offered at one tag now, where it used to wait for two. The chip
// that used to be the one-click way off carried an × and so read "person×" to
// everything that reads a chip; the pool's chip reads "person", and pays for it
// with a second click round the cycle. This is what buys that back.
check((await fstate()).clear === true,
	'but the clear is, because a pool chip has no closer and the cycle takes two clicks to put one tag down');
await clickTag('rust');
const bothTags = await boxes();
check(bothTags.length === 1 && bothTags[0] === 'Ship a CSV parser',
	`two wanted tags default to ALL -- only the Diamond carrying both: ${JSON.stringify(bothTags)}`);
const modeUp = await fstate();
check(modeUp.mode === 'all' && modeUp.clear === true,
	`a second tag raises the combining control on ALL, and the clear stays: ${JSON.stringify(modeUp)}`);
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
// The pool is not a filter state and does not reset with one: it is the
// vocabulary, and it comes back with every chip off. This is the hard refresh
// the user did, which found nothing under the search box at all.
check(afterBoot.shown && !afterBoot.ctl
	&& JSON.stringify(afterBoot.pool) === JSON.stringify(['family', 'gifts', 'person', 'rust', 'urgent']),
	`but the pool itself comes straight back on a hard reload, every chip off: ${JSON.stringify(afterBoot.pool)}`);
// Open, because it was left open. The other half of the kept choice: closed
// survived a reload above, and so does open -- it is one preference, not a
// default that only bites one way.
const dBoot = await disc();
check(!!dBoot && dBoot.open === true,
	`and comes back OPEN, because that is the way it was left: ${JSON.stringify(dBoot)}`);
check(!(await page.isVisible('#diamond-tag-hint')),
	'and the empty-pool hint stays away, because it keys off tags existing, not off filtering');
await clickTag('person');
await clickTag('rust');
const kept = await fstate();
check(kept.mode === 'any' && (await boxes()).length === 2,
	`the ALL/ANY choice IS kept across the reload: ${JSON.stringify(kept)}`);
await poolOff('rust');
const oneLeft = await fstate();
check(oneLeft.mode === null && oneLeft.clear === true && (await boxes()).length === 2,
	`the combining control goes again when one tag is left, and the clear stays: ${JSON.stringify(oneLeft)}`);

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
	`the pool shows both halves at once, so neither reason for hiding is silent: ${JSON.stringify(halves)}`);
// One row, in one order, whatever the boolean is: the wanted, the refused and
// the untouched sit alphabetically among each other rather than being gathered
// into groups that move under a click.
check(JSON.stringify(halves.pool) === JSON.stringify(['family', 'gifts', 'person', 'rust', 'urgent']),
	`and does not reorder itself around them: ${JSON.stringify(halves.pool)}`);
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
check(!cleared.up && cleared.shown && (await boxes()).length === 3,
	`one click on the clear puts both lists down and leaves the pool standing: ${JSON.stringify(cleared)}`);
// ALL over two tags no Diamond shares.
await clickTag('person');
await clickTag('rust');
await clickTag('family');
await poolOff('person');
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
	const f     = document.getElementById('diamond-filter');
	const shown = !!f && f.style.display !== 'none' && getComputedStyle(f).display !== 'none';
	const chips = shown ? [...f.querySelectorAll('.tagf-pool .tag-chip')] : [];
	const inc   = chips.filter(c => c.classList.contains('tag-inc'));
	const exc   = chips.filter(c => c.classList.contains('tag-no'));
	return {
		shown, pool: chips.map(c => c.textContent),
		up: inc.length + exc.length > 0,
		inc: inc.map(c => c.textContent),
		exc: exc.map(c => c.textContent),
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
// A profile that has never been touched, holding five restored tags: the pool
// is down and the row that names it is up. The first session proved the default
// on a store it had built; this proves it on a disk it has never seen.
const bFresh = await bp.evaluate(() => {
	const b = document.querySelector('#diamond-filter .tagf-toggle');
	return { row: !!b, open: b ? b.getAttribute('aria-expanded') === 'true' : null,
		text: b ? b.textContent.trim() : null,
		pool: !!document.querySelector('#diamond-filter .tagf-pool') };
});
check(bFresh.row && bFresh.open === false && !bFresh.pool && /\(\d+\)/.test(bFresh.text || ''),
	`a fresh profile opens with the pool down and its count on the row: ${JSON.stringify(bFresh)}`);
await setPoolOn(bp, true);
// The count on the closed row is the promise; the chips are what it is a
// promise OF. A number that did not match what opening gives you would be worse
// than no number, and it is read from the store rather than from the chips.
const bCount = await bp.$$eval('#diamond-filter .tagf-pool .tag-chip', els => els.length);
check(bCount > 0 && +((bFresh.text || '').match(/\((\d+)\)/) || [])[1] === bCount,
	`and the count it promised is the number of chips behind it: ${JSON.stringify(bFresh.text)} -> ${bCount} chips`);
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
check(!afterIncKill.pool.includes('family') && !afterIncKill.pool.includes('gifts'),
	`and both deleted tags leave the pool, so nothing offers a filter that cannot match: ${JSON.stringify(afterIncKill.pool)}`);

// ── The divider does not drift under the pool ────────────────────
// The pool is furniture, and the Diamonds and Chats lists are cut out of what
// the furniture leaves -- once, in pixels. Anything that changes the pool's
// height has to make that cut again, or the height comes off the Chats list
// alone and the divider walks up the rail a row at a time. Here the change is
// live and small: a click raises the controls row under the pool.
const shareOf = () => shareOn(bp);
const beforeCtl = await shareOf();
await bClickTag('person');                  // raises .tagf-ctl: the furniture grows a row
const withCtl = await shareOf();
await bp.evaluate(() => { const c = document.querySelector('.tag-clear-all'); if (c) c.click(); });
await bp.waitForTimeout(400);
const afterCtl = await shareOf();
check(withCtl.list + withCtl.sess < beforeCtl.list + beforeCtl.sess,
	`raising the controls really does take height off the two lists: ${beforeCtl.list + beforeCtl.sess}px -> ${withCtl.list + withCtl.sess}px`);
check(Math.abs(withCtl.share - beforeCtl.share) <= 0.03 && Math.abs(afterCtl.share - beforeCtl.share) <= 0.03,
	`and the divider stays at its share rather than walking: ${beforeCtl.share} -> ${withCtl.share} -> ${afterCtl.share}`);
check(beforeCtl.handle && afterCtl.handle, 'the divider itself is still there afterwards');

// ── A vocabulary the rail cannot afford ──────────────────────────
// Thirty-odd tags is a filing system, not a mistake, and the pool is furniture:
// the rail's two lists live on what it leaves. Unbounded, it would push the
// Diamonds off the bottom of the rail to show a row of chips for them.
const beforeBulk = await shareOf();
await bp.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
	for (let d = 0; d < 4; d++) {
		const id = await app.create_diamond('Bulk ' + d);
		await app.set_tags(id, JSON.stringify(words.map(w => w + '-' + d)));   // 8 is the per-Diamond cap
	}
});
// A hard reload, because that is the state being tested: a store that already
// has this much in it when the app opens.
await bp.reload({ waitUntil: 'domcontentloaded' });
await signInAs(b, 'tagsB');
await bp.waitForTimeout(1800);
const adminX2 = await bp.$('#admin-close');
if (adminX2 && await adminX2.isVisible()) { await adminX2.click({ force: true }); await bp.waitForTimeout(400); }
// Left open, so it comes up open -- on a store that now has a real vocabulary
// in it, which is the case where the choice is worth most either way.
const bBig = await bp.$eval('#diamond-filter .tagf-toggle',
	el => ({ open: el.getAttribute('aria-expanded') === 'true', text: el.textContent.trim() })).catch(() => null);
check(!!bBig && bBig.open && /\(3\d\)/.test(bBig.text),
	`the kept choice survives the vocabulary arriving, and the count follows it: ${JSON.stringify(bBig)}`);
const big = await bp.evaluate(() => {
	const el   = document.querySelector('#diamond-filter .tagf-pool');
	const list = document.getElementById('diamond-list');
	const sess = document.getElementById('session-list');
	const cs   = el ? getComputedStyle(el) : {};
	const rail = document.getElementById('panel-rail').getBoundingClientRect();
	return {
		tags: el ? el.children.length : 0,
		wrap: cs.flexWrap, over: cs.overflowY,
		clientH: el ? el.clientHeight : 0,
		scrollH: el ? el.scrollHeight : 0,
		list: list ? Math.round(list.getBoundingClientRect().height) : 0,
		sess: sess ? Math.round(sess.getBoundingClientRect().height) : 0,
		// Nothing may hang out of the rail's width; a chip row that did would
		// put a horizontal scrollbar under the whole column.
		widest: el ? Math.max(0, ...[...el.children].map(c => Math.round(c.getBoundingClientRect().right))) : 0,
		railRight: Math.round(rail.right),
		// Is a row CUT by the cap? A cap landing on a row boundary would show
		// thirty tags as three tidy rows and nothing to say there are more.
		cut: el ? (() => {
			const box = el.getBoundingClientRect();
			return [...el.children].some(c => {
				const r = c.getBoundingClientRect();
				return r.top < box.bottom - 1 && r.bottom > box.bottom + 1;
			});
		})() : false,
	};
});
check(big.tags >= 30, `a store with a real vocabulary in it: ${big.tags} tags in the pool`);
check(big.wrap === 'wrap' && big.over === 'auto' && big.scrollH > big.clientH,
	`the pool wraps and then scrolls rather than growing: ${JSON.stringify(big)}`);
check(big.clientH <= 80,
	`and is capped at about three rows however many tags there are: ${big.clientH}px for ${big.tags} chips`);
// The complaint that started all this was a control that gave no sign it was
// there. A pool that ended flush on a row would be the same mistake one size
// down: thirty tags looking like nine, with nothing saying otherwise.
check(big.cut,
	`a full pool cuts a row rather than ending flush, so the reader can see there is more: ${big.clientH}px of ${big.scrollH}px`);
check(big.widest <= big.railRight,
	`no chip hangs out of the rail: widest right edge ${big.widest} vs rail ${big.railRight}`);
// The furniture moved, so the split below it has to have been cut again --
// which is what `fitTagFilter` is for. Both lists still have a usable height.
check(big.list >= 60 && big.sess >= 60,
	`the two lists still share the rail under a full pool: Diamonds ${big.list}px, Chats ${big.sess}px`);
check(Math.abs(big.list / (big.list + big.sess) - beforeBulk.share) <= 0.03,
	`and the divider is where it was before the vocabulary arrived: ${beforeBulk.share} -> ${(big.list / (big.list + big.sess)).toFixed(3)}`);
await shot(b, 'tags-pool-many');
// A pool that is scrolled must stay where it was put: it repaints on every
// click, and one that jumped back to the top would make the tags past the
// third row unusable.
const scrollKept = await bp.evaluate(async () => {
	const el = document.querySelector('.tagf-pool');
	el.scrollTop = el.scrollHeight;
	const before = el.scrollTop;
	[...el.querySelectorAll('.tag-chip')].pop().click();
	await new Promise(r => setTimeout(r, 350));
	const now = document.querySelector('.tagf-pool');
	return { before, after: now.scrollTop, lit: !!now.querySelector('.tag-inc') };
});
check(scrollKept.before > 0 && scrollKept.after === scrollKept.before && scrollKept.lit,
	`the pool holds its scroll across the repaint a click causes: ${JSON.stringify(scrollKept)}`);
await shot(b, 'tags-pool-many-scrolled');
await bp.evaluate(() => { const c = document.querySelector('.tag-clear-all'); if (c) c.click(); });
await bp.waitForTimeout(300);

// ── Putting a full pool away gives the rail back ─────────────────
// The whole point of the disclosure, measured: with a real vocabulary in it the
// pool is three and a half rows of furniture, and closing it must hand every
// pixel of that to the two lists WITHOUT moving the divider between them.
const bigOpen = await shareOf();
await setPoolOn(bp, false);
const bigShut = await shareOf();
check(bigShut.list + bigShut.sess > bigOpen.list + bigOpen.sess + 40,
	`closing a full pool gives the rail back a real amount: ${bigOpen.list + bigOpen.sess}px -> ${bigShut.list + bigShut.sess}px`);
check(Math.abs(bigShut.share - bigOpen.share) <= 0.03,
	`and the divider does not drift for it: ${bigOpen.share} -> ${bigShut.share}`);
// Closed, with 36 tags filed, the whole filter is one row.
const bigRow = await bp.evaluate(() => {
	const f = document.getElementById('diamond-filter');
	return f ? Math.round(f.getBoundingClientRect().height) : 0;
});
check(bigRow > 0 && bigRow <= 26,
	`and 36 tags cost the rail one row instead of four: the filter is ${bigRow}px tall`);
await shot(b, 'tags-pool-many-collapsed');
// A filter built while it is closed still speaks, at this size too.
await bClickTag('alpha-0');
const bigAct = await bp.evaluate(() => {
	const row = document.querySelector('#diamond-filter .tagf-active');
	return { chips: row ? [...row.querySelectorAll('.tag-chip')].map(c => c.textContent) : null,
		pool: !!document.querySelector('#diamond-filter .tagf-pool'),
		ctl: !!document.querySelector('#diamond-filter .tagf-ctl') };
});
check(!!bigAct.chips && JSON.stringify(bigAct.chips) === JSON.stringify(['alpha-0'])
	&& !bigAct.pool && bigAct.ctl,
	`one tag filtering out of 36 shows ONE chip, not 36: ${JSON.stringify(bigAct)}`);
const bigActShare = await shareOf();
check(Math.abs(bigActShare.share - bigOpen.share) <= 0.03,
	`and the divider holds when that row arrives: ${bigShut.share} -> ${bigActShare.share}`);
await shot(b, 'tags-pool-many-collapsed-active');
await bp.evaluate(() => { const c = document.querySelector('.tag-clear-all'); if (c) c.click(); });
await bp.waitForTimeout(300);
await setPoolOn(bp, true);

// ── The phone drawer ─────────────────────────────────────────────
// The rail is a drawer there, 380px of a 390px screen, and the pool is the
// first thing under the search box on it.
await bp.setViewportSize({ width: 390, height: 844 });
await bp.waitForTimeout(600);
await bp.evaluate(() => document.getElementById('drawer-btn').click());
await bp.waitForTimeout(700);
// Back to the top of the pool, so the shot below is the state a thumb opens on.
await bp.evaluate(() => { const el = document.querySelector('.tagf-pool'); if (el) el.scrollTop = 0; });
await bp.waitForTimeout(200);
const phone = await bp.evaluate(() => {
	const el = document.querySelector('#diamond-filter .tagf-pool');
	if (!el) return null;
	const r = el.getBoundingClientRect();
	const cs = getComputedStyle(el);
	return {
		up: cs.display !== 'none' && r.height > 0,
		h: Math.round(r.height), right: Math.round(r.right), vw: window.innerWidth,
		scrollH: el.scrollHeight,
		// The drawer scrolls as one column; the pool must not drag it along
		// when a thumb runs off the end of the chips.
		contain: cs.overscrollBehaviorY,
		chips: el.children.length,
	};
});
check(!!phone && phone.up && phone.chips >= 30,
	`the pool is on the phone drawer too: ${JSON.stringify(phone)}`);
check(!!phone && phone.h <= 80 && phone.right <= phone.vw,
	`capped there as well, and inside the screen: ${JSON.stringify(phone)}`);
check(!!phone && phone.contain === 'contain',
	`and its own scroll does not become the drawer's: ${JSON.stringify(phone && phone.contain)}`);
await shot(b, 'tags-pool-phone');
// And the row it collapses to, on the same screen: the drawer is where the rent
// is dearest -- a phone shows a handful of Diamonds at a time, and four rows of
// chips is most of what a thumb came for.
await setPoolOn(bp, false);
const phoneShut = await bp.evaluate(() => {
	const b2 = document.querySelector('#diamond-filter .tagf-toggle');
	const f  = document.getElementById('diamond-filter');
	if (!b2 || !f) return null;
	const r = b2.getBoundingClientRect(), fr = f.getBoundingClientRect();
	return { text: b2.textContent.trim(), h: Math.round(fr.height),
		w: Math.round(r.width), right: Math.round(r.right), vw: window.innerWidth,
		pool: !!document.querySelector('#diamond-filter .tagf-pool') };
});
check(!!phoneShut && !phoneShut.pool && phoneShut.h <= 26 && phoneShut.right <= phoneShut.vw,
	`the phone drawer collapses to one row inside the screen: ${JSON.stringify(phoneShut)}`);
await shot(b, 'tags-pool-phone-collapsed');
await bp.setViewportSize({ width: 1400, height: 900 });
await bp.waitForTimeout(500);

const errsB = errors(b).filter(e => !/502 \(Bad Gateway\)/.test(e));
check(errsB.length === 0, `no console errors on the restoring session: ${JSON.stringify(errsB.slice(0, 3))}`);
await b.close();

console.log(out.join('\n'));
if (known.length) console.log(`\nKNOWN, NOT THIS CHANGE:\n  - ${known.join('\n  - ')}`);
console.log(bad === 0 ? `\nALL ${out.length} CHECKS PASSED` : `\n${bad} of ${out.length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
