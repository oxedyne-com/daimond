// verify_sweep_seen.mjs — is it on the screen, in the corner, and pressable?
//
// The owner exported eighteen defects from an ordinary day of using Daimond and
// at least half of them were visible to anyone who opened the app and looked.
// The suite is 290-odd verifier files and it was green throughout, because
// almost every check in it asserts that something is TRUE rather than that a
// person can SEE, REACH or PRESS it. A grep proves code exists; a passing
// assertion proves a value; neither proves anything about a screen.
//
// So this drives the real app at four shapes, opens every panel in every zone,
// and measures four families of property. What each one is here for is a defect
// that got past everything else:
//
//   SEEN     Social was not a flex column, so `.imp-notes { overflow-y: auto }`
//            had no overflow to engage on. Twenty notes kept, 2606px of list in
//            a 434px panel, NOT ONE note on the screen and nothing to scroll.
//            Measured here at 20 notes, and the check is general: no list may be
//            left with no item inside its panel and no way to scroll to one.
//   ANCHOR   the Web panel's closer went to 229px in and 65px down whenever the
//            page title was long, and Social's sat 248px in at every width. Both
//            are asked against the panel's OWN corner. And the second half of
//            the rule, which one snapshot cannot see: THE POSITIONS ARE TAKEN
//            AGAIN in a changed state -- a long title, a revealed chip, a
//            narrower window -- and every control that stayed must not have
//            moved. The owner's own sentence for it is the one encoded: a
//            transient element must never sit in the flow of clickable targets.
//   PRESS    `elementFromPoint` at each control's centre. Every click in this
//            suite is forced, so a button under a stale overlay passes them all.
//   SINGULAR four "Daimond Optimiser" tiles where two belong. Nothing counted.
//
// The state pairs are driven through the app's own paths where there is one --
// `DaimondWeb.open` for the title, `DaimondPanels.show` for the dock -- and
// through the element's own declaration where there is not: `#sync-chip` is
// built lazily by sync.js on the first status it has to report, so a run with no
// gateway holds no chip to reveal. See LIMITS at the foot of this header.
//
//   node dev/verify_sweep_seen.mjs               # the sweep
//   node dev/verify_sweep_seen.mjs --quick       # desktop and iphone only
//   node dev/verify_sweep_seen.mjs --headed      # under a real display, with shots
//   node dev/verify_sweep_seen.mjs --selftest    # prove each family can go red
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.
//
// ── LIMITS, WHICH ARE THE POINT OF WRITING THEM DOWN ────────────────────────
//
// A sweep that overclaims is worse than a small one that knows its edges, and
// the failure this file exists to correct is a suite that was green while the
// app was visibly broken. So:
//
//   * A CHROMIUM AT 390x844 IS NOT AN iPHONE. It is not iOS Safari, it has no
//     home-indicator inset, its scrollers are not rubber-banded and its fonts
//     are this machine's. Geometry that is wrong here is wrong there; geometry
//     that is right here may still be wrong there.
//   * IT MEASURES WHAT IS DRAWN, NEVER WHAT IT MEANS. An icon nobody recognises,
//     a word in the wrong register, a control that is exactly where it belongs
//     and is the wrong control -- all of them pass every family above. The
//     owner's "the system-prompt button became an unlabelled glyph and I
//     concluded the feature had been deleted" is not reachable from here, and
//     nothing in this file should be read as covering it.
//   * A REVEALED TRANSIENT IS THE ELEMENT'S OWN DECLARATION, not its module's
//     decision to show it. What is proved is that the row cannot hold it without
//     moving; what is not proved is when the app puts it there.
//   * ONE PALETTE, ONE SPACING. dev/verify_sweep_desktop.mjs walks eleven
//     palettes against two spacings for ink; this walks four shapes for
//     geometry, and the two are deliberately not merged.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, errors } from './harness.mjs';
import { audit, positions, drifted, transients, reveal, restore,
	SHAPES, CORNER, seedNotes, showPanels, openPanels } from './sweepkit.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots', 'nsweep');
fs.mkdirSync(SHOTS, { recursive: true });

const QUICK    = process.argv.includes('--quick');
const HEADED   = process.argv.includes('--headed');
const SELFTEST = process.argv.includes('--selftest');
const shapes   = QUICK ? SHAPES.filter((s) => s.name === 'desktop' || s.name === 'iphone') : SHAPES;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
/// Findings printed under a heading, so a red says what a person would see.
const say = (fs_) => { for (const f of fs_) console.log(`         ${f.family} ${f.what} @ ${f.where} — ${f.detail}`); };

// Every panel there is, so nothing is swept only in the arrangement that
// happens to be saved. The dock takes two at a time, which is the arrangement
// the Social defect was reported in.
const STAGE = ['ai', 'web', 'doc', 'tools', 'graph'];
const DOCK  = ['social', 'trash', 'agents', 'work', 'spend', 'pending'];

const s = await open({ name: 'nsweep', headed: HEADED });
const p = s.page;

// The world the panels are asked about: twenty notes kept, which is the state
// the Social panel was reported in, and which no fixture in this suite had.
await seedNotes(p, 20);
await p.reload({ waitUntil: 'domcontentloaded' });
const { signInAs } = await import('./harness.mjs');
await signInAs(s, s.name);
await p.waitForTimeout(800);

const findings = [];

for (const shape of shapes) {
	console.log(`\n── ${shape.name} ${shape.width}x${shape.height} ──────────────────────\n`);
	await p.setViewportSize({ width: shape.width, height: shape.height });
	await p.waitForTimeout(400);

	// A panel at a time in the stage, and PAIRS in the dock — a dock panel
	// sharing its column is the case the Social list was measured in, and the
	// one no other verifier reaches.
	const rounds = [];
	for (const id of STAGE) rounds.push({ label: id, show: ['ai', id] });
	for (let i = 0; i < DOCK.length; i += 2) rounds.push({ label: DOCK.slice(i, i + 2).join('+'), show: DOCK.slice(i, i + 2) });

	for (const r of rounds) {
		await showPanels(p, r.show);
		const live = await openPanels(p);
		// A round whose panels did not open would produce a full set of clean
		// measurements of whatever WAS open, under this round's name. That is the
		// silent-skip this file's own header argues against, so it is a failure.
		const missing = r.show.filter((id) => !live.includes(id));
		if (missing.length) {
			check(`${shape.name}/${r.label}: the panels opened`, false, `never opened: ${missing.join(', ')}`);
			continue;
		}
		const all = (await audit(p)).map((f) => ({ ...f, shape: shape.name, round: r.label }));
		// BEHIND is a count for a person, not a verdict. See the PRESS note in
		// sweepkit.mjs: a sheet over a panel and a stale overlay over the app are
		// the same geometry, and this file does not pretend to tell them apart.
		const found = all.filter((f) => f.family !== 'BEHIND');
		const behind = all.filter((f) => f.family === 'BEHIND');
		findings.push(...all);
		check(`${shape.name}/${r.label}: nothing hidden, stranded, covered or doubled`,
			found.length === 0, found.length ? `${found.length} finding(s)` : '');
		if (found.length) say(found);
		if (behind.length) console.log(`         note  ${behind.length} control(s) behind another surface`);
		if (HEADED || shape.name === 'iphone' || r.label === 'social+trash') {
			await p.screenshot({ path: path.join(SHOTS, `${shape.name}-${r.label}.png`) }).catch(() => {});
		}
	}
}

// ── ANCHOR, the half a snapshot cannot see ────────────────────────────────
console.log('\n── does it stay there? ───────────────────────────────────\n');

await p.setViewportSize({ width: 1280, height: 800 });
await showPanels(p, ['ai', 'web']);
await p.waitForTimeout(500);

// 1. A LONG TITLE. The Web panel's head holds a title and a row of buttons, and
//    an ordinary URL is long. This is the exact state the owner reported.
{
	// SCOPED TO THE PANEL WHOSE STATE CHANGED. Opening a page correctly takes the
	// Web chip out of the header's row, so every chip after it moves and a
	// document-wide reading would call that drift. The defect was in the head.
	const before = await positions(p, '#panel-web');
	const url = await p.evaluate(async () => {
		const u = location.origin + '/guide/index.html?'
			+ 'a-query-string-of-the-kind-an-ordinary-page-carries=' + 'x'.repeat(120);
		try { await window.DaimondWeb.open(u); } catch (e) { return ''; }
		return u;
	});
	await p.waitForTimeout(1200);
	check('the Web panel took a long page title', !!url, url ? '' : 'DaimondWeb.open refused');
	const after = await positions(p, '#panel-web');
	const moved = drifted(before, after);
	check('a long page title moves nothing in the head',
		moved.length === 0,
		moved.slice(0, 4).map((m) => `${m.name} ${m.dx > 0 ? '+' : ''}${m.dx},${m.dy > 0 ? '+' : ''}${m.dy}`).join('  '));
	const corner = (await audit(p)).filter((f) => f.family === 'ANCHOR');
	check('every closer is still in its own corner under a long title', corner.length === 0);
	if (corner.length) { say(corner); findings.push(...corner.map((f) => ({ ...f, shape: 'laptop', round: 'long title' }))); }
	await p.screenshot({ path: path.join(SHOTS, 'longtitle.png') }).catch(() => {});
}

// 2. A TRANSIENT IN THE FLOW. The owner's rule, and the one this file states as
//    a rule rather than as a measurement: an element the app shows and hides
//    must not displace the controls a person is aiming at.
{
	// A ROW OF PERSISTENT CONTROLS, WHEREVER IT IS. This asked `.top-actions` for
	// its own transients and reported "none in the DOM — nothing was proved here"
	// when it found none — so a top bar that had been EMPTIED of transients, which
	// is the strongest form of the fix and the one lane n-chrome took, read as a
	// failure to look. The sync chip and the held-sweep notice moved into the
	// rail's status strip, which is a row of buttons too, so both rows are asked.
	//
	// AND THE DRIFT IS MEASURED DOCUMENT-WIDE, not in the row that changed. That
	// is the opposite of the scoping the Web panel needed above, and deliberately:
	// a long page title is a state change the head is ABOUT, so its own controls
	// may reflow; a transient appearing is about nothing, and is entitled to move
	// nothing anywhere.
	const ROWS = ['.top-actions', '#admin-status'];
	const ts = [];
	for (const sel of ROWS) {
		for (const t of await transients(p, sel)) ts.push({ ...t, row: sel });
	}
	check('the app holds transients to test', ts.length > 0,
		ts.length ? ts.map((t) => `${t.name} (${t.row})`).join(', ')
			: 'none in either row — nothing was proved here');
	for (const t of ts) {
		const before = await positions(p);
		await reveal(p, t.key, 'Syncing…');
		await p.waitForTimeout(250);
		const after = await positions(p);
		const moved = drifted(before, after);
		await restore(p, t.key);
		await p.waitForTimeout(200);
		// BOTH AXES, because a row of controls in a column moves DOWN. Said as
		// `dx` alone, the first three findings here read "new-session-btn 0px" —
		// a defect reported as no movement at all, which is how a real one gets
		// waved past.
		const said = (m) => `${m.name} ${m.dx}×${m.dy}px`;
		const far = Math.max(...moved.map((m) => Math.max(Math.abs(m.dx), Math.abs(m.dy))), 0);
		check(`showing ${t.name} moves no persistent control`,
			moved.length === 0,
			moved.length ? `${moved.length} moved, e.g. ${moved.slice(0, 3).map(said).join(', ')}` : '');
		if (moved.length) {
			findings.push({ family: 'ANCHOR', what: 'a transient that displaces persistent controls',
				where: t.name, detail: `${moved.length} control(s) moved, up to ${far}px`,
				shape: 'laptop', round: 'transient' });
		}
	}
}

// 3. A NARROWER WINDOW. Everything is entitled to reflow; nothing is entitled to
//    leave its corner while it does.
{
	await p.setViewportSize({ width: 900, height: 800 });
	await p.waitForTimeout(700);
	const corner = (await audit(p)).filter((f) => f.family === 'ANCHOR' || f.family === 'PRESS');
	check('narrowing to 900px leaves every closer in its corner and every control pressable',
		corner.length === 0, corner.length ? `${corner.length} finding(s)` : '');
	if (corner.length) { say(corner); findings.push(...corner.map((f) => ({ ...f, shape: 'narrow', round: 'reflow' }))); }
}

// ── The same geometry in the engine an iPhone actually runs ───────────────
//
// A Chromium at 390x844 is a rectangle, not a phone, and the paragraph in this
// file's header says so. WebKit is the engine iOS Safari is built on, so the
// same audit through it is the closest this machine gets to the device the
// owner reported these faults from -- and the distance that remains is stated
// rather than closed: this is WebKit on Linux under Playwright, with this box's
// fonts, no home-indicator inset and no iOS compositor. It narrows the claim; it
// does not make it a claim about iOS.
//
// It SKIPS LOUDLY where WebKit will not launch, and a skip is never counted as a
// pass -- dev/run_all.sh's header spends a paragraph on what that costs.
{
	console.log('\n── the same audit, in WebKit at iPhone size ───────────────\n');
	process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
	const { pathToFileURL } = await import('node:url');
	const os = await import('node:os');
	const PWPATH = process.env.DAIMOND_PW
		|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
	const { webkit } = await import(pathToFileURL(PWPATH).href);
	// A FORWARDED DISPLAY STALLS THE LAUNCH, which is the house note about
	// WebKit and the reason these two lines are here rather than in the harness:
	// nothing in this block goes through `open()`.
	const env = { ...process.env };
	delete env.DISPLAY;
	delete env.WAYLAND_DISPLAY;
	const { scratch, APP } = await import('./harness.mjs');
	let ctx = null;
	try {
		ctx = await webkit.launchPersistentContext(scratch(`wk-nsweep-${process.pid}`), {
			viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
			hasTouch: true, isMobile: true, env, timeout: 45000,
		});
	} catch (e) {
		check('WebKit at iPhone size: the audit ran', false,
			'SKIPPED — WebKit would not launch: ' + String(e).split('\n')[0]);
	}
	if (ctx) {
		const wp = ctx.pages()[0] || await ctx.newPage();
		await wp.goto(APP, { waitUntil: 'domcontentloaded' });
		await signInAs({ page: wp, name: 'nsweepwk' }, 'nsweepwk');
		await wp.waitForTimeout(2500);
		await seedNotes(wp, 20);
		await wp.reload({ waitUntil: 'domcontentloaded' });
		await signInAs({ page: wp, name: 'nsweepwk' }, 'nsweepwk');
		await wp.waitForTimeout(2500);
		for (const round of [['ai'], ['social', 'trash'], ['web']]) {
			await showPanels(wp, round);
			const all = (await audit(wp)).map((f) => ({ ...f, shape: 'webkit-iphone', round: round.join('+') }));
			const found = all.filter((f) => f.family !== 'BEHIND');
			findings.push(...all);
			check(`webkit-iphone/${round.join('+')}: nothing hidden, stranded, covered or doubled`,
				found.length === 0, found.length ? `${found.length} finding(s)` : '');
			if (found.length) say(found);
			await wp.screenshot({ path: path.join(SHOTS, `webkit-iphone-${round.join('+')}.png`) }).catch(() => {});
		}
		await ctx.close();
	}
}

// ── The instrument proves it can go red ───────────────────────────────────
//
// A check never seen fail is not evidence. Under --selftest each family is
// given the defect it was written for -- the real ones, reverted in the page --
// and must find it.
if (SELFTEST) {
	console.log('\n── selftest: each family, against the defect it was written for ──\n');
	await p.setViewportSize({ width: 1280, height: 800 });
	await showPanels(p, ['social', 'trash']);

	// SEEN: the Social panel as it was — a block, so the list's `overflow-y:
	// auto` has nothing to engage on. This is the reverted fix, in one line.
	await p.addStyleTag({ content: '.social { display: block !important; overflow: visible !important; }' });
	await p.waitForTimeout(500);
	const seen = (await audit(p)).filter((f) => f.family === 'SEEN');
	check('selftest SEEN: a block Social panel is found', seen.length > 0, `${seen.length} finding(s)`);
	say(seen.slice(0, 3));

	// ANCHOR: the head's controls back inside the wrapping chip group.
	await p.addStyleTag({ content: '#panel-social .railhead-acts { order: 3 !important; }' });
	await p.waitForTimeout(400);
	const anch = (await audit(p)).filter((f) => f.family === 'ANCHOR');
	check('selftest ANCHOR: a closer out of its corner is found', anch.length > 0, `${anch.length} finding(s)`);
	say(anch.slice(0, 3));

	// PRESS: a sheet of glass over the app, of the kind a dialog leaves behind.
	await p.evaluate(() => {
		const g = document.createElement('div');
		g.id = 'nsweep-glass';
		g.style.cssText = 'position:fixed;inset:0;z-index:99999;background:transparent';
		document.body.appendChild(g);
	});
	await p.waitForTimeout(200);
	// A sheet of glass is a SURFACE, so its findings land in BEHIND -- which is
	// the honest answer, and what the count is there for. What is proved here is
	// that the instrument sees it at all: without the hit test nothing in this
	// suite would, because every click in it is forced.
	const press = (await audit(p)).filter((f) => f.family === 'PRESS' || f.family === 'BEHIND');
	check('selftest PRESS: a stale overlay is found', press.length > 10, `${press.length} control(s) under it`);
	await p.evaluate(() => document.getElementById('nsweep-glass').remove());

	// SINGULAR: a second tile of a name that is already in the rail.
	const dup = await p.evaluate(() => {
		const list = document.getElementById('diamond-list');
		if (!list || !list.firstElementChild) return false;
		list.appendChild(list.firstElementChild.cloneNode(true));
		return true;
	});
	await p.waitForTimeout(200);
	const sing = (await audit(p)).filter((f) => f.family === 'SINGULAR');
	check('selftest SINGULAR: a doubled rail tile is found', dup && sing.length > 0, `${sing.length} finding(s)`);
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, s.name);
}

// ── The report ────────────────────────────────────────────────────────────
const REPORT = path.join(HERE, 'sweep_seen_report.md');
const byFamily = {};
for (const f of findings) (byFamily[f.family] = byFamily[f.family] || []).push(f);
let md = '# What a person would see\n\n'
	+ `Written by \`dev/verify_sweep_seen.mjs\`, ${new Date().toISOString().slice(0, 10)}, `
	+ `${shapes.map((x) => x.name).join(', ')}.\n\n`;
for (const fam of Object.keys(byFamily)) {
	md += `## ${fam}\n\n| where | what | detail | shape | round |\n|---|---|---|---|---|\n`;
	for (const f of byFamily[fam]) md += `| \`${f.where}\` | ${f.what} | ${f.detail} | ${f.shape || ''} | ${f.round || ''} |\n`;
	md += '\n';
}
if (!findings.length) md += 'Nothing found.\n';
fs.writeFileSync(REPORT, md);
console.log(`\nreport: ${REPORT}`);

// A WORLD WITH NO GATEWAY REFUSES `/api` ON PURPOSE, and says so with a 502 --
// see dev/world.sh, which made that refusal honest rather than letting a
// stranger's gateway answer. This file needs no gateway, so those 502s are the
// world working, and counting them would make it red for a reason that has
// nothing to do with what it measures. Nothing else is filtered.
const errs = errors(s).filter((e) => !(/status of 502/.test(e) && /\/api\//.test(e)));
check('nothing threw in the page while it swept', errs.length === 0, errs.slice(0, 2).join(' | '));
await shot(s, 'nsweep-seen-last');
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { for (const b of bad) console.log('  FAIL ' + b); process.exit(1); }
