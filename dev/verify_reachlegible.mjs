// verify_reachlegible.mjs — the Workspace panel says what a daimon may reach, and
// the control that widens it says so in a word.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// Two faults, both found by the owner failing to use his own app on 2026-08-23,
// both in the Workspace panel, and both invisible to every check that existed.
//
//   1. THE SCOPE CHIP READ AS A PERMISSION SETTING AND IS A VIEW FILTER. He
//      worked an evening on `Everything`, where the panel drew the workspace at
//      large and said nothing whatever about the Diamond in front of him: the
//      Toolchains row was not drawn, the marks were in the other tree, and there
//      was no sentence anywhere. Nothing was marked into that Diamond, so
//      `diamond_bounds` gave it one `OnlyWriteUnder` — its own folder — and a
//      `file_search` naming no path started there, because `walk_starts`
//      (src/tools.rs) takes its default from exactly those prefixes. His daimon
//      reported a function present ten times as absent. Every fact needed to see
//      that coming was in the store and none of it was on the screen.
//
//   2. TWO `+` BUTTONS WITH IDENTICAL TEXT. One marked a folder into a fence and
//      one put a file in front of a model, and the only difference on screen was
//      a tooltip. Worse, the crystal footer's `+` was labelled "Attach" while
//      doing the marking, because on a Diamond `Files.attachAdd` writes a `holds`
//      link and `Files.bounds` turns every one of those into an `OnlyWriteUnder`.
//
// ── WHAT IT ASSERTS, WHICH IS THE PROPERTY AND NOT THE FIX ───────────────────
//
// Nothing here asks whether an element exists. Six properties, and each can hold
// while another breaks:
//
//   1. THE REACH ROW IS DRAWN IN BOTH TREES. `Everything` is where the fault
//      happened, so `Everything` is where it is measured first.
//   2. IT AGREES WITH THE FENCE, path for path and in order, against
//      `DaimondDiamond.bounds` — the same call `scopeAgentTo` hands the engine.
//      A row built from the panel's own cache would pass an existence check and
//      fail this one.
//   3. THE ZERO STATE IS SAID OUT LOUD, IN INK, WITHOUT A HOVER. This is the
//      state the owner was in and could not see. Asserted as a laid-out element
//      carrying a non-empty sentence that names the Diamond — a `title` would
//      not do, which is the whole complaint.
//   4. THE TOOLCHAINS ROW IS OFFERED ON `Everything` TOO.
//   5. ONE PRESS MARKS THE FOLDER ON SCREEN, and the fence and the row both
//      move. He had to open a picker and walk a tree back down to the folder he
//      was already standing in.
//   6. A `+` THAT WIDENS A FENCE SAYS SO, and does not read the same as a `+`
//      that does not. Measured as TEXT, because the tooltip was the fault.
//   7. A FOLDER'S MARK CONTROL IS NOT BEHIND A HOVER. A grant nobody can see is
//      a grant nobody takes back.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a real file to the real page through
// `page.route`, and the run is then EXPECTED TO FAIL. A break whose anchor is
// not found aborts rather than passing quietly.
//
//   node dev/verify_reachlegible.mjs --break noreach     # 1,2,3: the row only in the Diamond tree
//   node dev/verify_reachlegible.mjs --break reachlies   # 2: the marks dropped from the row
//   node dev/verify_reachlegible.mjs --break reachown    # 2: the own folder dropped from it
//   node dev/verify_reachlegible.mjs --break quietzero   # 3: the zero state left unsaid
//   node dev/verify_reachlegible.mjs --break scopeonly   # 4: Toolchains back in one tree
//   node dev/verify_reachlegible.mjs --break nomarkhere  # 5: no one-press mark
//   node dev/verify_reachlegible.mjs --break bareplus    # 6: the `+` back to a bare `+`
//   node dev/verify_reachlegible.mjs --break sameword    # 6: the two `+` given one word again
//   node dev/verify_reachlegible.mjs --break hoveronly   # 7: the mark hidden until hover
//   node dev/verify_reachlegible.mjs --break noclass     # 7: the row control never marked as a grant
//   node dev/verify_reachlegible.mjs --break panelmute   # 8: both rows silent in both trees
//   node dev/verify_reachlegible.mjs                     # and then, clean
//
// BRING THE WORLD DOWN AND UP BETWEEN RUNS. The mock keeps state across a run,
// so a re-run is not a repeat — see the header of dev/verify_twodepth.mjs for
// the hour that cost.
//
//   bash dev/world.sh 4 --down && eval "$(bash dev/world.sh 4 --up)"
//
// Needs dev/serve.mjs and dev/mockllm.mjs. No gateway and no real provider:
// nothing here sends a turn, because every fault is a thing on the screen. The
// mock is connected only because the New Diamond form refuses to create one
// without a model it can resolve a key for.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'reachlegible' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── The breaks ───────────────────────────────────────────────────────────────
//
// Each is one line and is scoped to survive every check but the ones it proves.
// `noreach` and `scopeonly` are the two defects exactly as they stood.
const BREAKS = {
	// The row put back behind the scope chip, which is where every fact about the
	// fence used to live.
	noreach: [{
		file: 'js/daimond.js',
		find: "			if (!currentDiamond) { reachEl.innerHTML = ''; reachEl.style.display = 'none'; return; }",
		with: "			if (!currentDiamond || !diamondScope()) { reachEl.innerHTML = ''; reachEl.style.display = 'none'; return; }",
	}],
	// The row drawn, and drawn from nothing: the marks dropped, so it reports a
	// fence narrower than the one the turn is given. Existence checks all pass.
	reachlies: [{
		file: 'js/daimond.js',
		find: "			var marks = b.attached || [], ro = b.read_only || [];",
		with: "			var marks = [], ro = b.read_only || [];",
	}],
	// The Diamond's own folder left off the row, so the panel under-reports the
	// fence by exactly the place a bare search starts when nothing else is marked.
	// `reachlies` cannot prove 2, because at that point there is nothing to drop.
	reachown: [{
		file: 'js/daimond.js',
		find: "			reachEl.appendChild(reachChip(t('dws.reach_own'), own, false));",
		with: "			void own;",
	}],
	// The state the owner was in, left unsaid again.
	quietzero: [{
		file: 'js/daimond.js',
		find: "				: t('dws.reach_none', { name: currentDiamond.name });",
		with: "				: '';",
	}],
	// Toolchains back in the Diamond tree only — absent rather than explained.
	scopeonly: [{
		file: 'js/daimond.js',
		find: "			if (!currentDiamond) { kitsEl.style.display = 'none'; return; }",
		with: "			if (!currentDiamond || !diamondScope()) { kitsEl.style.display = 'none'; return; }",
	}],
	// The one-press mark taken away, so the only route back is the picker.
	nomarkhere: [{
		file: 'js/daimond.js',
		find: "			if (!currentDiamond || !curDir) return null;",
		with: "			if (true) return null;",
	}],
	// The `+` back to what it was: one glyph, two meanings, a tooltip between them.
	bareplus: [{
		file: 'js/daimond.js',
		find: "			add.textContent = '+ ' + t(grants ? 'attach.add_mark' : 'attach.add');",
		with: "			add.textContent = '+';",
	}],
	// The class never applied, so nothing on the row says it is a grant and the
	// rule that lifts it has nothing to match. `hoveronly` breaks the rule and
	// this breaks the mark, which are two different ways to lose the same thing.
	noclass: [{
		file: 'js/daimond.js',
		find: "			btn.classList.toggle('mark', marks);",
		with: "			btn.classList.toggle('mark', false);",
	}],
	// The two `+` buttons given one word again. Nothing about the page changes;
	// the only thing that breaks is that they can no longer be told apart, which
	// is fault 2 exactly.
	sameword: [{
		file: 'i18n/en.js',
		find: "	'attach.add_mark':     'Mark a folder in',",
		with: "	'attach.add_mark':     'Attach',",
	}],
	// Both rows muted at once: the panel back to saying nothing about the Diamond
	// in either tree, which is what makes 8 a check about the OTHER tree rather
	// than a restatement of 1 and 4.
	panelmute: [
		{
			file: 'js/daimond.js',
			find: "		async function paintReach() {\n			if (!reachEl) return;",
			with: "		async function paintReach() {\n			if (reachEl) { reachEl.style.display = 'none'; reachEl.innerHTML = ''; }\n			if (true) return;",
		},
		{
			file: 'js/daimond.js',
			find: "			if (!currentDiamond) { kitsEl.style.display = 'none'; return; }",
			with: "			if (true) { kitsEl.style.display = 'none'; return; }",
		},
	],
	// The grant on a folder row hidden until the pointer finds it.
	hoveronly: [{
		file: 'css/files.css',
		find: '.attach-btn.mark { visibility: visible; }',
		with: '.attach-btn.mark { visibility: hidden; }',
	}],
};

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		// Off the WORKING copy, not off disk: a break with two edits to one file
		// would otherwise keep only the last of them and quietly test half of itself.
		const src = byFile.has(spec.file)
			? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		const n = src.split(spec.find).length - 1;
		if (n !== 1) {
			console.error(`--break ${BREAK}: anchor appears ${n} time(s) in ${spec.file}, wanted 1.`);
			console.error('The break is stale. A break that patches nothing launders a plain run as proof.');
			process.exit(1);
		}
		byFile.set(spec.file, src.replace(spec.find, spec.with));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	if (!BREAKS[BREAK]) {
		console.error(`--break ${BREAK}: no such break. Known: ${Object.keys(BREAKS).join(', ')}`);
		process.exit(1);
	}
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({
			status: 200,
			contentType: file.endsWith('.css') ? 'text/css' : 'application/javascript',
			body,
		}));
	}
}

const s = await open({ name: 'reachlegible', profile: PROFILE, route: serveBreaks });
const p = s.page;

// Every expected word is asked of the running app rather than spelled here: this
// app ships eight languages and a test that hard-codes English passes in one.
const T = (k, v) => p.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);

// ── The fixture ──────────────────────────────────────────────────────────────
//
// Written through the engine's own door, which is not fenced because it is not a
// turn — see the header of dev/harness.mjs.
const seeded = await p.evaluate(async () => {
	const M = await import('/pkg/oxedyne_daimond.js');
	await M.write_file('code/parser/src/lib.rs', 'pub fn parse() {}\n');
	await M.write_file('code/parser/README.md', '# parser\n');
	await M.write_file('books/draft.md', '# draft\n');
	return true;
});
check('0a the fixture is written', seeded === true);

await p.click('#new-diamond-btn', { force: true });
await p.waitForSelector('.dlg-input', { timeout: 10000 });
await p.fill('.dlg-input', 'Ship a CSV parser');
await p.click('.dlg-ok', { force: true });
await sleep(1600);
// Opened as well as made: `currentDiamond` is what every row of this panel is
// about, and a Diamond that exists but is not in focus draws no scope row at all.
await p.$$eval('.diamond-box', els => els[0] && els[0].click());
await sleep(1200);

const did = await p.evaluate(() => {
	const d = window.DaimondDiamond && DaimondDiamond.current && DaimondDiamond.current();
	return d ? d.id : '';
}).catch(() => '');

async function openPanel() {
	await p.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await sleep(600);
	await p.evaluate(() => {
		const b = document.querySelector('#panel-work [data-act="refresh"]');
		if (b) b.click();            // NOT page.click: a forced click is inert headless
	});
	await sleep(1100);
}
const setScope = async (which) => {
	await p.click(`.files-scope-chip[data-scope="${which}"]`, { force: true });
	await sleep(1100);
};

/// The reach row exactly as it is on the screen: laid out or not, its chips in
/// order, and the sentence under them as INK.
const reach = () => p.evaluate(() => {
	const el = document.querySelector('#panel-work .files-reach');
	if (!el) return { present: false };
	const says = el.querySelector('.files-reach-says');
	return {
		present: true,
		// `offsetParent` AND a non-zero box: a row that is `display:none` and one
		// that is laid out at nothing are both invisible, and only one of them
		// answers the attribute.
		shown:   !!el.offsetParent && el.getBoundingClientRect().height > 0,
		label:   (el.querySelector('.files-reach-label') || {}).textContent || '',
		chips:   [...el.querySelectorAll('.files-reach-chip')].map(c => ({
			path: c.dataset.path || '', text: c.textContent || '',
			ro: c.classList.contains('ro'),
		})),
		says:    says ? (says.textContent || '') : null,
		// The zero state has a class of its own so it can be coloured; read it
		// back so "it said something" and "it said the alarming thing" are two
		// different questions.
		saysNone: !!(says && says.classList.contains('none')),
		saysShown: !!(says && says.offsetParent && says.getBoundingClientRect().height > 0),
		markHere: (() => {
			const b = el.querySelector('[data-act="mark-here"]');
			return b ? { path: b.dataset.path || '', text: b.textContent || '' } : null;
		})(),
	};
});

/// What the engine would actually be told, from the call `scopeAgentTo` makes.
const bounds = (id) => p.evaluate((i) => window.DaimondDiamond.bounds(i), id);

/// The Toolchains row, as furniture that is there or is not.
const kits = () => p.evaluate(() => {
	const el = document.querySelector('#panel-work .files-kits');
	if (!el) return { present: false };
	return {
		present: true,
		shown:   !!el.offsetParent && el.getBoundingClientRect().height > 0,
		chips:   [...el.querySelectorAll('.files-kit-chip')].map(c => c.textContent),
	};
});

await openPanel();

// ── 1. The row is in the tree the fault happened in ──────────────────────────
const scopeNow = await p.evaluate(() => window.DaimondFilesPanelScope || null);
const active = await p.evaluate(() => {
	const c = document.querySelector('.files-scope-chip.active');
	return c ? c.dataset.scope : null;
});
check('1a the panel opens on Everything, as it always has', active === 'all',
	`active chip = ${active}${scopeNow ? '' : ''}`);

const r0 = await reach();
check('1b THE REACH ROW IS DRAWN ON `Everything`, which is where the evening went',
	!!r0 && r0.shown === true,
	r0 ? `present=${r0.present} laid out=${r0.shown}` : 'no row');
check('1c and it is labelled, so the chips above it read as a view control',
	!!r0 && r0.label.trim().length > 0, r0 ? JSON.stringify(r0.label) : '');

// ── 2. It agrees with the fence ──────────────────────────────────────────────
//
// Against `DaimondDiamond.bounds`, which is what `scopeAgentTo` hands the
// engine. A row built from the panel's own cached `attached` would draw the same
// pixels and fail here the moment the two differ.
const b0 = await bounds(did);
const wantPaths = [b0.own_dir].concat(b0.attached || []);
check('2a THE CHIPS ARE THE FENCE, path for path and in order',
	!!r0 && JSON.stringify(r0.chips.map(c => c.path)) === JSON.stringify(wantPaths),
	`row ${JSON.stringify(r0 ? r0.chips.map(c => c.path) : null)} vs fence ${JSON.stringify(wantPaths)}`);
check('2b and the Diamond’s own folder is the first of them, as diamond_bounds declares it',
	!!r0 && r0.chips.length > 0 && r0.chips[0].path === b0.own_dir,
	r0 && r0.chips[0] ? r0.chips[0].path : '');

// ── 3. The zero state, said out loud ─────────────────────────────────────────
check('3a nothing is marked in yet, which is the state under test',
	Array.isArray(b0.attached) && b0.attached.length === 0,
	JSON.stringify(b0.attached));
const zeroWords = await T('dws.reach_none', { name: 'Ship a CSV parser' });
check('3b THE PANEL SAYS SO, IN INK, WITH NOTHING HOVERED',
	!!r0 && r0.saysNone === true && r0.saysShown === true && (r0.says || '').trim().length > 0,
	r0 ? `none=${r0.saysNone} laid out=${r0.saysShown} text=${JSON.stringify((r0.says || '').slice(0, 60))}` : '');
check('3c and it names the Diamond, so it is about the thing in front of him',
	!!r0 && (r0.says || '').indexOf('Ship a CSV parser') !== -1,
	r0 ? JSON.stringify((r0.says || '').slice(0, 90)) : '');
check('3d it is the app’s own sentence for the state, not one this test invented',
	!!r0 && (r0.says || '').trim() === (zeroWords || '').trim(),
	JSON.stringify((zeroWords || '').slice(0, 60)));
await shot(s, 'reach-everything-zero');

// ── 4. Toolchains, in the tree the fault happened in ─────────────────────────
const k0 = await kits();
check('4a THE TOOLCHAINS ROW IS OFFERED ON `Everything` TOO',
	!!k0 && k0.shown === true, k0 ? `present=${k0.present} laid out=${k0.shown}` : 'no row');
check('4b and it offers the whole set, not a subset of it',
	!!k0 && k0.chips.length === 5, k0 ? JSON.stringify(k0.chips) : '');

// ── 5. One press, from the folder already on screen ──────────────────────────
//
// The route he had to take was: open the `+`, walk the picker's tree back down
// to the folder he was standing in, tick it, press OK.
const walked = await p.evaluate(() => {
	const rows = [...document.querySelectorAll('#panel-work .files-tree .files-row')];
	const hit = rows.find(r => ((r.querySelector('.files-name') || {}).textContent || '')
		.replace(/^[^A-Za-z0-9._-]+/, '').trim() === 'code');
	if (!hit) return false;
	hit.click();
	return true;
});
check('5a the tree walks into a folder', walked === true);
await sleep(1100);

const r1 = await reach();
check('5b THE PANEL OFFERS TO MARK THE FOLDER ON SCREEN',
	!!r1 && !!r1.markHere && r1.markHere.path === 'code',
	r1 ? JSON.stringify(r1.markHere) : '');

await p.evaluate(() => {
	const b = document.querySelector('#panel-work .files-reach [data-act="mark-here"]');
	if (b) b.click();
});
await sleep(1400);

const b1 = await bounds(did);
check('5c ONE PRESS AND THE FENCE MOVED',
	Array.isArray(b1.attached) && b1.attached.indexOf('code') !== -1,
	JSON.stringify(b1.attached));

const r2 = await reach();
check('5d and the row moved with it: a chip for the folder now stands in the fence',
	!!r2 && r2.chips.some(c => c.path === 'code'),
	r2 ? JSON.stringify(r2.chips.map(c => c.path)) : '');
check('5e and the alarm is gone, because the state it described is gone',
	!!r2 && r2.saysNone === false && (r2.says || '').trim().length > 0,
	r2 ? `none=${r2.saysNone} text=${JSON.stringify((r2.says || '').slice(0, 60))}` : '');
check('5f and it does not offer to mark a folder that is already inside the fence',
	!!r2 && r2.markHere === null, r2 ? JSON.stringify(r2.markHere) : '');
await shot(s, 'reach-everything-marked');

// ── 6. The `+` says what it does ─────────────────────────────────────────────
//
// The crystal footer's `+` was labelled "Attach" while marking, because on a
// Diamond attaching IS marking. TEXT, not `title`: the tooltip was the fault.
const stripOpen = await p.evaluate(() => {
	const strip = document.getElementById('arte-strip');
	if (!strip) return false;
	strip.click();
	return true;
});
check('6a the artefact strip opens', stripOpen === true);
await sleep(900);
const plus = await p.evaluate(() => {
	const b = document.querySelector('#arte-list [data-act="attach-add"]');
	if (!b) return null;
	return { text: (b.textContent || '').trim(), title: b.title || '', grants: b.dataset.grants || '' };
});
const markWord  = (await T('attach.add_mark')) || '';
const plainWord = (await T('attach.add')) || '';
check('6b the Diamond’s `+` carries a WORD and not only a glyph',
	!!plus && plus.text.replace(/^\+\s*/, '').length > 0, JSON.stringify(plus));
check('6c AND IT IS THE MARKING WORD, because on a Diamond this `+` widens the fence',
	!!plus && plus.text.indexOf(markWord) !== -1,
	`button ${JSON.stringify(plus && plus.text)} vs ${JSON.stringify(markWord)}`);
check('6d and it does not read as the one that merely attaches',
	!!plus && markWord !== plainWord && plus.text.replace(/^\+\s*/, '').trim() !== plainWord.trim(),
	`mark=${JSON.stringify(markWord)} plain=${JSON.stringify(plainWord)}`);
check('6e and it says so to a screen reader as well as to an eye',
	!!plus && plus.grants === '1' && plus.title.length > 0, JSON.stringify(plus));
await shot(s, 'reach-plus-labelled');

// ── 7. A grant on a folder row is not behind a hover ─────────────────────────
//
// Measured with the pointer nowhere near it, and as the COMPUTED visibility: a
// class is not evidence, because the rule that reads it is in a file this test
// can also damage.
await p.mouse.move(5, 5);
await sleep(200);
const rowMark = await p.evaluate(() => {
	const rows = [...document.querySelectorAll('#panel-work .files-tree .files-row.dir')];
	const row = rows.find(r => r.querySelector('.attach-btn'));
	if (!row) return null;
	const b = row.querySelector('.attach-btn');
	const cs = getComputedStyle(b);
	return {
		path:    row.dataset.path || '',
		mark:    b.classList.contains('mark'),
		vis:     cs.visibility,
		display: cs.display,
		title:   b.title || '',
	};
});
check('7a a folder row carries the control that marks it in',
	!!rowMark && rowMark.mark === true, JSON.stringify(rowMark));
check('7b AND IT IS ON THE SCREEN WITH NOTHING HOVERED',
	!!rowMark && rowMark.vis === 'visible' && rowMark.display !== 'none',
	rowMark ? `visibility=${rowMark.vis} display=${rowMark.display}` : '');
check('7c and it names the marking, not the attaching',
	!!rowMark && rowMark.title.indexOf('Ship a CSV parser') !== -1,
	rowMark ? JSON.stringify(rowMark.title) : '');

// ── 8. And the row survives the switch it was hidden behind ──────────────────
await setScope('diamond');
const r3 = await reach();
const b3 = await bounds(did);
check('8a the row is drawn in the Diamond tree as well',
	!!r3 && r3.shown === true, r3 ? `laid out=${r3.shown}` : 'no row');
check('8b and still agrees with the fence there',
	!!r3 && JSON.stringify(r3.chips.map(c => c.path))
		=== JSON.stringify([b3.own_dir].concat(b3.attached || [])),
	r3 ? JSON.stringify(r3.chips.map(c => c.path)) : '');
const k3 = await kits();
check('8c and the Toolchains row did not move either', !!k3 && k3.shown === true);
await shot(s, 'reach-diamond-tree');

// ── 9. The console ───────────────────────────────────────────────────────────
const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|Account service|net::ERR/.test(e));
check('9 nothing throws while all this happens', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `--break ${BREAK}: reddened ${bad.length} check(s), as it must`
		: `--break ${BREAK}: CHANGED NOTHING — the check it names is not testing what it says`);
	process.exit(bad.length ? 0 : 1);
}
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
