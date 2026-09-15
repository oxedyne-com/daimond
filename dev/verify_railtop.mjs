// verify_railtop.mjs — the top of the rail, as somebody meets it on day one.
//
// Six rows of the 2026-09-15 UI audit land on the first 120 pixels of the rail
// and on the first menu a fold opens. They are separate defects with one thing
// in common: each asks the user to learn something before the rail can be read.
//
//   RAIL-01  "▶ ⏸ ● Everything ×" — three glyphs, a noun that names a scope
//            rather than an act, and a twenty-one word tooltip carrying the
//            label's own work. Now "Pause all", the state in a word beside it,
//            and a title short enough to read at a glance.
//   RAIL-02  a standing "No tags yet…" line under the Diamonds head, on every
//            account that had not tagged anything. Gone: chips appear when tags
//            exist, and until then the rail says nothing about tags.
//   RAIL-03  two 22px squares with the same plus glyph, one above the other.
//            They say "New diamond" and "New chat".
//   RAIL-05  a Diamond and a chat wearing the accent at once, so two rows read
//            as "current". Exactly one, across both lists.
//   RAIL-07  a new account opening on two objects it did not make, one of them
//            wearing a play, a pause and a traffic light. Folded into a
//            "Built-in" group at the foot, shut.
//   CRY-18   the fold picker offering those same two as targets, so the first
//            fold anybody makes could be written into the app's help text.
//            Excluded, and "New diamond…" leads.
//
// WHAT IS NOT ASSERTED HERE, deliberately. That the built-ins still EXIST is
// `verify_defaults`'s (it reads the store, not the rail), and that the
// Optimiser's tile still works is `verify_optimiser`'s. This file is about
// where they sit, so those two stay the authority on whether they are there at
// all — a check written here would be a second opinion that could disagree.
//
// PROVED RED. `--break <name>` serves one damaged file in place of the real one
// and the matching check must notice:
//
//   node dev/verify_railtop.mjs --break twoactive   # each list clears only its own accent
//   node dev/verify_railtop.mjs --break flatlist    # the built-ins back in the flat list
//   node dev/verify_railtop.mjs --break foldall     # the fold picker offers everything again
//   node dev/verify_railtop.mjs                     # and then, clean
//
// Needs a world: `eval "$(bash dev/world.sh N --up)"`. No gateway.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, chat } from './harness.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is a real edit to a real file, served in its place through
// `page.route`. Anchored on shapes, not on prose somebody will improve.
const BREAKS = {
	// Back to two painters that each clear only their own list's class, which is
	// the state the audit photographed.
	twoactive: [{
		file: 'js/daimond.js',
		re:   /\t\tvar on = !!chosen && focused;\n\t\tbox\.classList\.toggle\('active', on\);/,
		with: "\t\tvar on = !!chosen;\n\t\tif (!on) return;\n\t\tbox.classList.toggle('active', on);",
	}],
	// The built-ins back among everything else, in the flat list.
	flatlist: [{
		file: 'js/daimond.js',
		re:   /\t\tvar mine = \[\], built = \[\];\n\t\tshown\.forEach\(function \(f\) \{ \(isBuiltInDiamond\(f\) \? built : mine\)\.push\(f\); \}\);/,
		with: '\t\tvar mine = shown, built = [];',
	}],
	// The picker walking every Diamond again.
	foldall: [{
		file: 'js/daimond.js',
		re:   /\t\tvar targets = diamonds\.filter\(function \(f\) \{ return !isBuiltInDiamond\(f\); \}\);/,
		with: '\t\tvar targets = diamonds;',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. A break whose anchor is not there exactly
/// once broke nothing, and the run would prove nothing.
function damaged(src, spec) {
	const re = new RegExp(spec.re.source, spec.re.flags.includes('g') ? spec.re.flags : spec.re.flags + 'g');
	const n = (src.match(re) || []).length;
	if (n !== 1) {
		console.error(`break '${BREAK}': the shape ${spec.re} matches ${n} time(s) in ${spec.file}.`);
		process.exit(2);
	}
	return src.replace(re, spec.with);
}

let bad = 0;
const check = (ok, what, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail != null ? ' — ' + detail : ''));
	if (!ok) bad++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const s = await open({ name: 'railtop', signIn: false, connect: false });
const p = s.page;

if (BREAK) {
	for (const spec of BREAKS[BREAK]) {
		const src = damaged(fs.readFileSync(path.join(WWW, spec.file), 'utf8'), spec);
		await p.route('**/' + spec.file, (route) => route.fulfill({
			status: 200, contentType: 'application/javascript', body: src }));
	}
	await p.reload({ waitUntil: 'domcontentloaded' });
}

const errs = [];
p.on('pageerror', (e) => errs.push(String(e)));

try {
	await signInAs(s, 'railtop');
	await connectMock(s);

	// The two built-ins, by the app's own seeding path, and then one Diamond and
	// one chat of the user's own — which is the smallest rail that can hold every
	// question below at once.
	await p.evaluate(() => DaimondDiamond.seedDefaults());
	await p.waitForFunction(() =>
		document.querySelectorAll('#diamond-list .diamond-box').length >= 2,
		null, { timeout: 25000 });
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', 'Mine');
	await p.click('.dlg-ok', { force: true });
	await sleep(1200);
	await p.click('#new-session-btn', { force: true });
	await sleep(1200);

	// ── RAIL-01. One control, named for the act, with the state in a word ──
	const pause = await p.evaluate(() => {
		const row   = document.getElementById('pptw-global-row');
		const label = row && row.querySelector('.pptw-head-label');
		const state = document.getElementById('pptw-global-state');
		return {
			label: label ? label.textContent.trim() : null,
			title: label ? (label.title || '') : '',
			state: state ? state.textContent.trim() : null,
			// The GROUP is the control. Three parts is its specification
			// (verify_pausewidget owns that); what matters here is that the row
			// holds one of them and not a second scattered set of verbs.
			groups: row ? row.querySelectorAll('.pptw').length : -1,
			verbs:  row ? row.querySelectorAll('button:not(.panel-close)').length : -1,
		};
	});
	check(pause.groups === 1, 'one pause control at the top of the rail', `${pause.groups} group(s)`);
	check(!!pause.label && /pause/i.test(pause.label),
		'and it is named for what pressing it does, not for the scope it covers',
		JSON.stringify(pause.label));
	// The word, not merely a word: it has to be one of the four the module can
	// produce, and it has to move when the root does.
	const STATES = await p.evaluate(() => ['play', 'pause', 'mixed', 'idle']
		.map((k) => DaimondI18n.t('pause.state_' + k)));
	check(STATES.includes(pause.state),
		'with the root\'s state beside it, in a word',
		`${JSON.stringify(pause.state)} of ${JSON.stringify(STATES)}`);
	// Six words is the audit's ceiling, and the old title was twenty-one.
	const titleWords = pause.title.trim().split(/\s+/).filter(Boolean).length;
	check(pause.title !== '' && titleWords <= 6,
		'and a title of six words or fewer', `${titleWords}: ${JSON.stringify(pause.title)}`);
	// It moves. A word painted once at boot is a label, not a reading.
	await p.evaluate(() => DaimondPause.set(DaimondPause.ROOT, false));
	await sleep(300);
	const held = await p.evaluate(() => document.getElementById('pptw-global-state').textContent.trim());
	await p.evaluate(() => DaimondPause.set(DaimondPause.ROOT, true));
	await sleep(300);
	const runs = await p.evaluate(() => document.getElementById('pptw-global-state').textContent.trim());
	check(held !== runs && held === STATES[1] && runs === STATES[0],
		'the word follows the root rather than being painted once',
		`paused=${JSON.stringify(held)} running=${JSON.stringify(runs)}`);

	// ── RAIL-02. Nothing is said about tags until there are some ──────────
	const tags = await p.evaluate(() => ({
		hint: !!document.getElementById('diamond-tag-hint'),
		pool: (() => { const f = document.getElementById('diamond-filter');
			return !!f && getComputedStyle(f).display !== 'none'; })(),
	}));
	check(!tags.hint && !tags.pool,
		'no standing tag hint, and no empty pool in its place',
		`hint=${tags.hint} pool=${tags.pool}`);

	// ── RAIL-03. The two makers say what they make ────────────────────────
	const btns = await p.evaluate(() => ['new-diamond-btn', 'new-session-btn'].map((id) => {
		const b = document.getElementById(id);
		return b ? { id, text: b.textContent.trim(), svg: b.querySelectorAll('svg').length } : { id, text: null };
	}));
	check(btns.every((b) => b.text && /\p{L}/u.test(b.text)),
		'both rail-head makers carry a word rather than a glyph',
		JSON.stringify(btns.map((b) => b.text)));
	check(new Set(btns.map((b) => b.text)).size === 2,
		'and the two of them do not read the same', JSON.stringify(btns.map((b) => b.text)));

	// ── RAIL-05. Exactly one accented row, across BOTH lists ──────────────
	//
	// Walked rather than asserted at one moment: the defect was a class nobody
	// came back for, so it only shows on the SECOND selection, and only when the
	// second is in the other list.
	const accents = () => p.evaluate(() => ({
		on:   [...document.querySelectorAll('#panel-rail .session-box.active')]
			.map((b) => (b.querySelector('.session-box-name, .tile-label') || {}).textContent || b.dataset.id),
		aria: document.querySelectorAll('#panel-rail .session-box[aria-current]').length,
	}));
	await p.evaluate(() => document.querySelector('#diamond-list > .diamond-box').click());
	await sleep(900);
	const a1 = await accents();
	check(a1.on.length === 1, 'one accented row after opening a diamond', JSON.stringify(a1.on));
	await p.evaluate(() => document.querySelector('#session-list .session-box').click());
	await sleep(900);
	const a2 = await accents();
	check(a2.on.length === 1, 'and still one after opening a chat from there',
		JSON.stringify(a2.on));
	check(a2.aria === 1, 'with one aria-current to match it', String(a2.aria));
	await p.evaluate(() => document.querySelector('#diamond-list > .diamond-box').click());
	await sleep(900);
	const a3 = await accents();
	check(a3.on.length === 1, 'and one on the way back to the diamond', JSON.stringify(a3.on));

	// ── RAIL-07. The built-ins, folded to the foot ────────────────────────
	const group = await p.evaluate(() => {
		const list = document.getElementById('diamond-list');
		const d = list && list.querySelector('.rail-builtin');
		const nameOf = (b) => (b.querySelector('.session-box-name') || {}).textContent || '';
		return {
			there:  !!d,
			open:   !!d && d.open,
			label:  d ? (d.querySelector('summary') || {}).textContent.trim() : null,
			inside: d ? [...d.querySelectorAll('.diamond-box')].map(nameOf) : [],
			// At the FOOT: nothing of the list comes after it.
			last:   !!d && list.lastElementChild === d,
			// And not in the flat list any more.
			flat:   [...list.querySelectorAll(':scope > .diamond-box')].map(nameOf),
			// Whatever the group holds, its transport controls are off screen with
			// it — which is the whole of "no inline transport controls".
			//
			// `checkVisibility`, NOT a bounding box. A shut `<details>` hides its
			// content through `content-visibility` on `::details-content`, and a
			// descendant of one still reports a height: the first version of this
			// check read 49px tall tiles inside a group the same pass had just
			// measured at 25px, and called a working fold a failure.
			shownWidgets: [...document.querySelectorAll('#diamond-list .pptw')]
				.filter((w) => w.checkVisibility({ contentVisibilityAuto: true,
					opacityProperty: true, visibilityProperty: true })).length,
			hiddenWidgets: d ? d.querySelectorAll('.pptw').length : 0,
		};
	});
	check(group.there && group.open === false,
		'the built-ins sit in a group that starts shut',
		`there=${group.there} open=${group.open}`);
	check(group.last, 'at the foot of the Diamonds list, with nothing after it');
	check(group.inside.length === 2
		&& group.inside.some((n) => /Help/.test(n)) && group.inside.some((n) => /Optimiser/.test(n)),
		'holding both of them', JSON.stringify(group.inside));
	check(group.flat.length > 0 && !group.flat.some((n) => /Daimond (Help|Optimiser)/.test(n)),
		'and neither is left in the flat list above it', JSON.stringify(group.flat));
	check(group.hiddenWidgets > 0 && group.shownWidgets === 0,
		'so the Optimiser\'s play/pause/light is off the first screen without being taken away',
		`inside=${group.hiddenWidgets} drawn=${group.shownWidgets}`);
	// Opening it is what a user does, and it must give them back exactly what was
	// always there.
	// Guarded: under `--break flatlist` there is no group, and a throw here would
	// end the run before it could report the four checks that have already gone
	// red -- which is the run that proves them.
	await p.evaluate(() => { const d = document.querySelector('.rail-builtin'); if (d) d.open = true; });
	await sleep(400);
	const opened = await p.evaluate(() =>
		[...document.querySelectorAll('.rail-builtin .diamond-box')]
			.filter((b) => b.checkVisibility({ contentVisibilityAuto: true,
				opacityProperty: true, visibilityProperty: true })).length);
	check(opened === 2, 'and opening it draws both tiles, unchanged', String(opened));
	await p.evaluate(() => { const d = document.querySelector('.rail-builtin'); if (d) d.open = false; });
	await sleep(300);

	// ── CRY-18. The fold picker ───────────────────────────────────────────
	await p.evaluate(() => document.querySelector('#session-list .session-box').click());
	await sleep(700);
	// Something to fold, or the picker refuses before it is drawn. Reached by the
	// same three presses `verify_foldall` uses -- collapse the thread, select every
	// turn, fold the selection -- because that is the route a user has and this
	// file must not invent a second one.
	await chat(s, 'a line to fold');
	await p.evaluate(() => {
		const c = document.getElementById('collapse-btn');
		if (c && !c.classList.contains('on')) c.click();
	});
	await sleep(400);
	await p.click('#sel-all', { force: true });
	await sleep(200);
	await p.click('#sel-fold', { force: true });
	await p.waitForSelector('.fold-menu', { timeout: 8000 });
	const picker = await p.evaluate(() =>
		[...document.querySelectorAll('.fold-menu .fold-menu-item')].map((b) => b.textContent.trim()));
	check(picker.length > 0 && /new/i.test(picker[0]),
		'"New diamond…" is the first entry in the fold picker', JSON.stringify(picker));
	check(!picker.some((x) => /Daimond (Help|Optimiser)/.test(x)),
		'and neither built-in is offered as a target', JSON.stringify(picker));
	check(picker.some((x) => x === 'Mine'),
		'while a diamond of the user\'s own still is', JSON.stringify(picker));
	await p.keyboard.press('Escape');

	check(errs.length === 0, 'nothing throws into the console while all this happens', errs[0] || '');
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
