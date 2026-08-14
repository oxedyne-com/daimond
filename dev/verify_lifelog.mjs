// verify_lifelog.mjs — drive the lifelog capp in a real Diamond and hold it to its numbers.
//
// WHERE THIS FILE BELONGS, and it is now there. It lives in `dev/` and must stay: `dev/run_all.sh`
// enumerates `dev/verify_*.mjs` and nothing else, so anywhere else it is never in the gate; and
// `verify/lib.mjs` walks `www/` for the transparency manifest, excluding only the handful of
// files named in its `EXCLUDE`, so from inside `www/` its bytes would be SEALED INTO THE PUBLISHED
// BUNDLE and served to every user — which is where it used to sit. Nothing below writes a path
// down: the repo root is derived from this file's own URL, `harness.mjs` is imported through it,
// and screenshots go to the harness scratch root. `dev/gate.sh` runs the suite inside a `git
// worktree` AT A DIFFERENT PATH, so an absolute path here would read the MAIN tree's page while
// driving the worktree's app — a verifier measuring one tree and reporting on another.
//
//   node dev/verify_lifelog.mjs                 # clean
//   node dev/verify_lifelog.mjs --break <name>  # and each property proved red first
//
// WHAT IT ASSERTS, and the rule it is written under: assert MEANING, not arity. An earlier
// version of this file counted elements — "more than six tiles", "more than five rows" — and
// its headline check, "A TAP REACHES THE DISK", tested the shard for `"src":"preset"`. The
// FIXTURE BELOW SEEDS PRESET LINES, so that check was green before the tap and would have
// stayed green if the tile had done nothing at all. It is now a before-and-after on the ids in
// the file. That is the failure this project keeps paying for and it is worth naming: a
// verifier that passes for the wrong reason is worse than no verifier, because it is believed.
//
// The properties, and the last five of the first eight carry the weight:
//
//   1. The page is inside its ceilings and asks for nothing it may not have (static, no browser).
//   2. The frame is still up after `data`, so `rendered` named every content key of the crystal
//      — checked BOTH ways: the frame is there, and the channel's own key list covers the
//      crystal's keys including one the page has never heard of.
//   3. It furnishes an empty Diamond with lanes it can be used from.
//   4. A TAP REACHES THE DISK: a NEW line, with the right food, the right day, and every line
//      that was there before still there unchanged.
//   5. A SCALE TILE LOGS THE ADJUSTED AMOUNT, not the tile's default.
//   6. A DELETE LEAVES A TOMBSTONE and the row goes.
//   7. THE ARITHMETIC IS RIGHT: today's energy, computed here from the fixture and the food
//      table, matches the number on screen to the calorie; and one lift's volume in a session
//      matches kg x reps summed here.
//   8. The chart shows one bar per day that HAS something and none for the day that does not,
//      and the pie folds its ninth series into a neutral Other rather than inventing a hue.
//
// And the two the owner asked for after using it (notes6, items 1 and 2):
//
//   9. LOG AND LIFE ARE TWO VIEWS, NOT ONE MIXED ONE. Log has the tiles and the entries and no
//      chart; Life has the numbers and the charts and no tile pad; and the switch works BOTH
//      WAYS, because a mode a person cannot get out of is worse than the mix it replaced.
//  10. A LANE CAN BE MADE FROM INSIDE THE PAGE, and the made lane is USABLE: it reaches the
//      disk, it arrives with tiles, pressing one puts a line in that lane's own shard, and Life
//      reads the line back. An empty one is refused with the reason on screen. And an EDIT of a
//      lane a daimon wrote keeps the catalogue, the formula and the tiles it has no vocabulary
//      for — the check that stops this feature eating the three lanes that ship.
//
// Screenshots go to the scratchpad (harness `scratch`), never into www/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Derived from this file, so it is the same tree whatever the working directory is: `run_all.sh`
// invokes `node dev/verify_lifelog.mjs` from the repo root, and a person runs it from `dev/`.
// This file lives in `dev/`, so the root is one up — and if the page is not under it, that is
// said here rather than left to surface as an opaque ENOENT from a guessed second location.
const ROOT = path.join(HERE, '..');
const PAGE_PATH = path.join(ROOT, 'www', 'capps', 'lifelog', 'crystal.html');
if (!fs.existsSync(PAGE_PATH)) {
	console.error('verify_lifelog: no capp page at ' + PAGE_PATH
		+ '\nthis file must sit in the repo\'s `dev/`; it derives everything else from there.');
	process.exit(2);
}
const H = await import(pathToFileURL(path.join(ROOT, 'dev', 'harness.mjs')).href);
const { open, signInAs, connectMock, errors, scratch } = H;

// src/tools.rs, CRYSTAL_PAGE_CAP_DEFAULT — 64 KiB until 2026-08-13, and the shipped page was
// 1,500 bytes short of it. Read from there rather than restated, so a page that fits a ceiling
// this file believes in but the engine does not is caught here instead of at delivery.
const PAGE_CAP = (() => {
	const src = fs.readFileSync(path.join(ROOT, 'src', 'tools.rs'), 'utf8');
	const m = /CRYSTAL_PAGE_CAP_DEFAULT:\s*usize\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(src);
	if (!m) throw new Error('verify_lifelog: CRYSTAL_PAGE_CAP_DEFAULT not found in src/tools.rs');
	return Number(m[1]) * Number(m[2]);
})();
let PAGE = fs.readFileSync(PAGE_PATH, 'utf8');
const DIR = path.dirname(PAGE_PATH);
/// What the template carries besides its page, by its own manifest.
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, 'capp.json'), 'utf8'));
const CARRIES = MANIFEST.files.filter(f => f !== 'crystal.html');
const FILE = (rel) => fs.readFileSync(path.join(DIR, rel), 'utf8');

// TWO WAYS A LIFELOG DIAMOND COMES INTO EXISTENCE, and both have to work:
//
//   delivered  the guide's button copies the template, files and all, so the lanes and the
//              catalogues are on disk before the page has run once. This is what a user gets.
//   seeded     a daimon wrote `crystal.html` and nothing else, so the page finds no `index.json`
//              and furnishes the Diamond itself on first run.
//
// The default run is the DELIVERED one, because that is the path a user is on. `--seed` lays
// down nothing but the page and exercises the fallback. Neither is a substitute for the other:
// a run that only ever seeded would say nothing about the files this directory ships.
// `--break noseed` damages the page's own seeding, which the delivered run never reaches, so it
// implies `--seed`. A break that cannot run its target is a break that reports green.
const SEED_MODE = process.argv.includes('--seed') || process.argv.includes('noseed');
const SHOTS = process.env.SHOTS || path.dirname(scratch('shots', 'x'));
fs.mkdirSync(SHOTS, { recursive: true });

// The floor a filled surface's ink must clear against its own ground. 3.0 rather than 4.5, and
// the reason is worth stating: the app resolves its own `accentText` against its own accent and
// hands it to the page, so a threshold above what the APP's palette achieves would be this file
// failing the whole product's colour scheme through a capp. What is being caught here is the
// fault the owner reported — ink that does not invert at all, which lands between 1.0 and 2.0
// — and 3.0 catches that with room to spare while leaving the palette's own choices alone.
const CONTRAST_MIN = 3.0;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ────────────────────────────────────────────────────
//
// Here they go on the PAGE and not on the app, which is the opposite of
// `dev/verify_capp.mjs` and right for the opposite reason: there, what is under test is what
// the app REFUSES an untrusted page, so a break in the page would prove only that a page which
// does not ask does not receive. Here the page IS the artefact, so the breaks are its own.
const BREAKS = {
	// The page reports only the keys it recognises. `habits` is in the crystal below and in no
	// page's vocabulary, so the app must judge the page to be showing less than the Diamond
	// holds and take the frame down.  -> 2 goes red.
	blindkeys: {
		find: "	for (k in D) if (D.hasOwnProperty(k) && k.charAt(0) !== '_') ks.push(k);\n"
			+ "	post({ cmd: 'rendered', keys: ks });",
		with: "	for (k in D) if (D.hasOwnProperty(k) && 'title summary facts open'.indexOf(k) >= 0)"
			+ " ks.push(k);\n	post({ cmd: 'rendered', keys: ks });",
	},
	// The log is kept in memory and never written. The SCREEN still shows the tap, which is
	// exactly why the check reads the disk and not the DOM.  -> 4, 5 and 6 go red, 2 does not.
	nosave: {
		find: "\t\tps.push(save('log/' + ln + '/' + ym2 + '.jsonl', by[ym2].join('\\n') + '\\n', 'append'));",
		with: "\t\tps.push(Promise.resolve({ ok: true }));",
	},
	// The furniture arrives without the template tile it is named for.  -> 3 goes red.
	noseed: {
		find: "\t\tsave('lanes/diet.json', JSON.stringify(diet), 'replace'),",
		with: "\t\tsave('lanes/diet.json', JSON.stringify(diet).split('Porridge').join('X'), 'replace'),",
	},
	// The stepper's amount is thrown away and the tile logs its default.  -> 5 goes red.
	scalefixed: {
		find: "\t\tvar tl = (l.tiles || [])[+v], f = cp(tl.f); f[tl.by] = S.amt;",
		with: "\t\tvar tl = (l.tiles || [])[+v], f = cp(tl.f);",
	},
	// A catalogue number stops being per 100 g, so every derived field is 100x.  -> 7a goes red.
	unscaled: {
		find: "\t\treturn v * base / (f.d.per || 100);",
		with: "\t\treturn v * base;",
	},
	// The expression walker adds where it should multiply, so volume is kg+reps.  -> 7b goes red.
	badformula: {
		find: "\t\tst.push(k.o === '+' ? a + b : k.o === '-' ? a - b : k.o === '*' ? a * b",
		with: "\t\tst.push(k.o === '+' ? a + b : k.o === '-' ? a - b : k.o === '*' ? a + b",
	},
	// A bar is drawn for a bucket with nothing in it, so a gap in the log stops showing.
	//  -> 8a goes red.
	phantombars: { find: "\t\tif (h > 0.5) {", with: "\t\tif (true) {" },
	// The tail is never folded, so a twelfth food is a twelfth hue.  -> 8b goes red.
	allhues: { find: "\tif (out.length > 8) {", with: "\tif (false) {" },
	// The page stops asking for height, so its bottom half is below the fold for ever.
	//  -> 'AND ITS HEIGHT CAME FROM THE PAGE'S OWN MESSAGE' goes red. It is the only break here
	// that named no check when it was written, and it duly changed nothing: the check beside it
	// reads `clientHeight`, which the surrounding layout satisfies on a desktop viewport with or
	// without the message. A break that reports green is the defect this file exists to catch.
	noheight: { find: "\tLASTH = h; post({ cmd: 'height', px: h });", with: "\tLASTH = h;" },

	// ── The two the owner asked for ────────────
	// Life draws the tile pad as well, so the two views are one mixed view again — which is the
	// thing he reported.  -> 'LIFE IS THE READING VIEW' goes red, 'LOG IS THE ENTRY VIEW' does not.
	mixedviews: {
		find: "function home() { return S.view === 'life' ? lifeView() : logView(); }",
		with: "function home() { return S.view === 'life' ? pad() + lifeView() : logView(); }",
	},
	// The other direction of the same fault, and it needs its own break because `mixedviews`
	// leaves Log alone: the entry view carries the numbers and the charts as well, which is
	// exactly the page he was given.  -> 'LOG IS THE ENTRY VIEW' goes red, 'LIFE IS' does not.
	mixedlog: {
		find: "\treturn (sc ? scopeBar(l, sc) : '') + pad() + restBar(l) + toastBar()",
		with: "\treturn (sc ? scopeBar(l, sc) : '') + pad() + stats() + charts() + restBar(l) + toastBar()",
	},
	// The builder stops offering one of the types the ontology names, so a lane that wants a note
	// on every entry cannot be made from the page at all.  -> 'THE + OPENS A LANE BUILDER' goes
	// red. `ref` is absent by design and is not in the list the check requires.
	fewtypes: {
		find: "var FTYPES = [['num', 'Number'], ['dur', 'Time'], ['enum', 'Choice'], ['bool', 'Yes/no'], ['text', 'Note']];",
		with: "var FTYPES = [['num', 'Number'], ['dur', 'Time'], ['enum', 'Choice'], ['bool', 'Yes/no']];",
	},
	// The switch only ever goes one way, so a person who presses Life is in Life for good.
	//  -> 'AND THE SWITCH GOES BOTH WAYS' goes red.
	stuckview: {
		find: "\telse if (a === 'view') { S.view = v; S.tile = -1; S.scr = null; loadRange().then(draw); }",
		with: "\telse if (a === 'view') { S.view = 'life'; S.tile = -1; S.scr = null; loadRange().then(draw); }",
	},
	// The lane is made in memory and never written, so it is gone on the next open. The SCREEN
	// still shows it, which is why the check reads the disk.  -> 'A LANE MADE FROM THE PAGE
	// REACHES THE DISK' goes red.
	nolanesave: {
		find: "\tvar ps = [save('lanes/' + l.id + '.json', laneJson(l), 'replace')];",
		with: "\tvar ps = [Promise.resolve({ ok: true })];",
	},
	// Nothing is checked before a lane is written, so a lane with no name and no fields is made
	// — and it draws nothing for ever.  -> 'AN EMPTY LANE IS REFUSED' goes red.
	weaklane: {
		find: "\tif (why) { toast(why, 1); draw(); return; }",
		with: "\tif (0) { toast(why, 1); draw(); return; }",
	},
	// The daily target typed into the builder is dropped on the way to the file, so the number in
	// Life has nothing to be measured against.  -> 'A LANE MADE FROM THE PAGE REACHES THE DISK'
	// goes red on its target.
	notarget: {
		find: "\t\tif (!r2.k || tv == null || (r2.t !== 'num' && r2.t !== 'dur')) continue;",
		with: "\t\tif (true) continue;",
	},
	// A new lane arrives with an empty pad: every field it has and no way to press any of them.
	//  -> 'IT ARRIVES WITH TILES' and the shard check after it go red.
	notiles: { find: "\tl.tiles = tiles;", with: "\tl.tiles = sc.edit ? tiles : [];" },
	// The builder claims a vocabulary it has not got: a catalogue field and a computed field
	// become ordinary rows, and saving flattens them.  -> 'AN EDIT KEEPS WHAT THE DAIMON WROTE'
	// goes red, on the diet lane that ships.
	flatten: {
		find: "\t\tif (d.d || d.t === 'ref') continue;",
		with: "\t\tif (false) continue;",
	},
	// A redraw nobody asked for — a theme arriving, a toast clearing itself — no longer reads the
	// half-built lane back out of the DOM, so it types over it.  -> 'A HALF-BUILT LANE SURVIVES'
	// and 'THE REDRAW A TOAST FORCES' both go red. This is the fault the run of 2026-08-14 found
	// in the shipped page, on the entry form as well as the new screen.
	losename: {
		find: "\t\telse if (S.scr && S.scr.t === 'lane') readLane();",
		with: "\t\telse if (S.scr && S.scr.t === 'lane') { }",
	},
	// The view switch goes back in a scroller with the lane names, where at 375px with four lanes
	// it is clipped and nothing else notices.  -> 'THE LOG/LIFE SWITCH IS WHOLLY ON THE SCREEN'
	// goes red, and the page's own `scrollWidth` check stays green — which is the point of it.
	clippedswitch: {
		find: "\t\t+ '<div class=\"gap\"></div><div class=\"seg\">'",
		with: "\t\t+ '<div class=\"gap\"></div><div class=\"chips\">'",
	},
	// ── The ontology the Gym lane is the hardest case of ────────────
	//
	// None of what follows is a gym feature. `p` is a plan, `prefill` is "the same as last
	// time", `pick` is several choices at once, `rest` is a lane that counts between one
	// commit and the next, and `end` is the second of two stamps. Each break below damages
	// one of them, and each is chosen to survive every check but the one it proves — where
	// that is not possible it is said so here and in the report.

	// The lane files this directory ships stop being the lanes the page would seed, so a
	// delivered Diamond and a seeded one are two different apps. The page still WORKS —
	// nothing else moves.  -> 'THE LANES IT CARRIES ARE THE LANES IT WOULD SEED' goes red.
	laneDrift: {
		find: "\t\tid: 'gym', n: 'Gym', dayStart: 0, sess: true, primary: 'lift', title: 'name',",
		with: "\t\tid: 'gym', n: 'Gymnasium', dayStart: 0, sess: true, primary: 'lift', title: 'name',",
	},
	// The pending gate opens: a plan counts. This is the one break that is MEANT to redden
	// more than one check, because "invisible to every number" is one property with four
	// witnesses — the day's total, the pie, the streak and the bar for the day that has
	// nothing real in it. A gate that leaked into only three of them would be worse.
	//  -> the energy check, 'AND NO NUMBER COUNTS IT' and the bar count all go red.
	countpending: {
		find: "\tfor (i = 0; i < es.length; i++) if (!es[i].p) o.push(es[i]);",
		with: "\tfor (i = 0; i < es.length; i++) o.push(es[i]);",
	},
	// The other half, and the reason it needs its own break: a plan that is not DRAWN is
	// also counted by nothing, and the aggregation checks above cannot tell the two apart.
	//  -> 'A PLANNED ENTRY IS DRAWN, AND DRAWN AS A PLAN' goes red, and nothing else.
	nopendingrow: {
		find: "\tfor (i = es.length - 1; i >= 0; i--) if (!es[i].of) rows.push(es[i]);",
		with: "\tfor (i = es.length - 1; i >= 0; i--) if (!es[i].of && !es[i].p) rows.push(es[i]);",
	},
	// Nothing is ever carried forward, so every set opens empty and every food has to have
	// its amount typed again.  -> 'AND EACH OPENS ON THE LAST TIME' goes red.
	noprefill: {
		find: "\t\tif (!f || f.prefill !== 'last' || bag[f.k] != null) continue;",
		with: "\t\tif (true) continue;",
	},
	// Prefill reads a row that has been written down and not yet done. One mistyped weight
	// then propagates down the whole exercise, and the log fills with numbers nobody lifted.
	//  -> 'AND A ROW THAT IS ONLY A PLAN IS NOT WHAT THE NEXT ONE COPIES' goes red.
	prefillpending: {
		find: "\t\tif (e.p || (e.f || {})[l.primary] !== ref) continue;",
		with: "\t\tif ((e.f || {})[l.primary] !== ref) continue;",
	},
	// The picker takes several and adds one, which is the difference between choosing your
	// exercises and choosing an exercise five times.  -> 'THE PICKER TAKES SEVERAL AT ONCE'
	// goes red on what reaches the disk, not on what the screen highlighted.
	singlepick: {
		find: "\t\t\tif (!on6[k6]) continue;",
		with: "\t\t\tif (!on6[k6] || es3.length) continue;",
	},
	// What the picker adds is committed rather than planned, so the session's totals count
	// work that has not been done.  -> 'EXERCISES ARE PICKED SEVERAL AT A TIME AND ARRIVE AS
	// A PLAN' goes red.
	notpending: { find: "\t\t\tif (sc.p) ne3.p = 1;", with: "\t\t\tif (0) ne3.p = 1;" },
	// A session with no end stamp reads as finished, so the workout in progress is not one.
	//  -> 'A WORKOUT STARTS OPEN AND BECOMES THE SCREEN' goes red on the control it offers.
	alwaysclosed: {
		find: "function sessOpen(e) { return !!e && !e.end; }",
		with: "function sessOpen(e) { return false; }",
	},
	// A length stops falling out of the two stamps, so a session that was never given a
	// typed duration has none.  -> 'A FINISH CLOSES IT, AND ITS LENGTH IS THE DISTANCE
	// BETWEEN TWO STAMPS' goes red on yesterday's 1h 2m.
	nospan: {
		find: "\tif ((raw === '' || raw === undefined) && f.t === 'dur' && e.end) {",
		with: "\tif (false) {",
	},
	// The rest clock will not restart while it is running, so the second exercise's set
	// rests on whatever was left of the first's.  -> 'THE REST CLOCK STARTS ON A TICK AND
	// STARTS AGAIN ON THE NEXT' goes red.
	reststicky: {
		find: "\tREST.until = Date.now() + REST.secs * 1000;\n\trestTone(REST.secs);",
		with: "\tif (REST.until > Date.now()) return;\n\tREST.until = Date.now() + REST.secs * 1000;\n\trestTone(REST.secs);",
	},
	// The tone plays at the moment of the tick instead of being scheduled two minutes out on
	// the audio clock — which is what a countdown driven by `setInterval` would sound like,
	// and it is silent in a backgrounded tab.  -> 'AND THE DING IS SCHEDULED ON THE AUDIO
	// CLOCK' goes red on the offsets, which is the only place the difference shows.
	nodingsched: {
		find: "\t\tt0 = c.currentTime + secs + i * 0.3;",
		with: "\t\tt0 = c.currentTime + i * 0.3;",
	},
	// The scope stops selecting: the live list shows every set of every session there has
	// ever been.  -> THIS ONE REDDENS TWO, and deliberately: reviewing a past session and
	// working through a live one are the SAME list with the same scope, which is the whole
	// point of building the workout as the Log view rather than as a screen of its own. A
	// break that reddened only one of them would mean there were two selections to get
	// wrong.
	scopeleak: {
		find: "function scoped(l, sc) { return sc ? kids(l.id, sc.id) : inBucket(l.id, curB(), S.per); }",
		with: "function scoped(l, sc) {\n\tif (!sc) return inBucket(l.id, curB(), S.per);\n\t"
			+ "var a = live(l.id), o = [], i;\n\tfor (i = 0; i < a.length; i++) if (a[i].of) o.push(a[i]);\n\t"
			+ "return o;\n}",
	},
	// A selected row keeps the ink it had on the ground it no longer has: the row goes dark,
	// its contents do not invert, and what you have just chosen is the one thing you cannot
	// read. This is the fault the owner reported, in the class it belongs to.
	//  -> 'SELECTED SURFACES INVERT THEIR INK' goes red.
	dimselect: {
		find: ".pickr.on .gap,.pickr.on .ev{color:var(--on)}",
		with: ".pickr.on .never-matches{color:var(--on)}",
	},
	// The page goes back to taking the app's `accentText` on trust. In this palette that is a
	// light tint of the accent — ink for accent-coloured text on the PAGE's ground, not ink
	// for text on the accent — so every selected chip in the capp measures 1.83:1 and the
	// thing you have just chosen is the thing you cannot read. This was the shipped state.
	//  -> 'SELECTED SURFACES INVERT THEIR INK' goes red, on the switch rather than the rows.
	trustaccenttext: {
		find: "\t\tif (!on || ratio(luma(on), la) < 3) on = ratio(0, la) >= ratio(1, la) ? '#141414' : '#ffffff';",
		with: "\t\tif (!on) on = ratio(0, la) >= ratio(1, la) ? '#141414' : '#ffffff';",
	},
	// The pressed rule goes back BEHIND `.tile.acc .tn`. Both weigh (0,2,1), so the later one
	// wins and a pressed accent tile draws accent ink on an accent ground: 1.00, and the name
	// of the tile under the thumb is invisible for as long as the thumb is on it.
	//  -> 'SELECTED SURFACES INVERT THEIR INK' goes red, on the pressed tile.
	dimpressed: {
		find: ".tile:active .ts,.tile:active .tn{color:var(--on)}",
		with: ".tile:active .never-matches{color:var(--on)}",
	},
	// The weight box is given a height a fraction under what its own type needs. The VALUE in
	// it stays correct, so every check that reads a set's numbers back is green and the person
	// holding the phone sees an empty box.  -> 'AND EVERY CONTROL HAS MORE ROOM THAN ITS OWN
	// TYPE NEEDS' goes red, and nothing that reads a value moves at all.
	tightsetin: {
		find: ".setin{width:56px;text-align:center;font-family:var(--mo);font-weight:600;padding:4px 5px;flex:none}",
		with: ".setin{width:56px;text-align:center;font-family:var(--mo);font-weight:600;padding:4px 5px;flex:none;height:16px}",
	},

	// A field box that will not fit a phone, which is where a lane gets made.  -> 'the lane
	// builder does not scroll sideways on a phone' goes red.
	widebuilder: {
		find: ".fbox{border:1px solid var(--bd);border-radius:var(--rd);padding:9px 10px;margin:0 0 9px}",
		with: ".fbox{border:1px solid var(--bd);border-radius:var(--rd);padding:9px 10px;margin:0 0 9px;min-width:520px}",
	},
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error('no such break: ' + BREAK + '\nhave: ' + Object.keys(BREAKS).join(' '));
		process.exit(2);
	}
	const n = PAGE.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times, so nothing was broken `
			+ 'and the run below would prove nothing.');
		process.exit(2);
	}
	PAGE = PAGE.replace(spec.find, spec.with);
	console.log(`  (running with the page broken: ${BREAK})`);
}

// ── 1. What can be judged without a browser ───────────────────────
//
// The ceiling first, because a page over it is not refused at render time — it is refused at
// WRITE time, so an oversized page is a capp that cannot be delivered at all, and every check
// below would then be measuring whatever was in the Diamond instead.
const bytes = Buffer.byteLength(PAGE, 'utf8');
check('the page is inside the page ceiling the engine enforces', bytes <= PAGE_CAP,
	bytes + ' / ' + PAGE_CAP + ' bytes, ' + (PAGE_CAP - bytes) + ' to spare');
// The policy is `default-src 'none'; script-src 'unsafe-inline'` with `img-src data:`, so each
// of these is a thing that cannot work rather than a thing that is discouraged. A page that
// contained one would fail in the browser as a silent CSP refusal, which is the hardest kind of
// failure to see in a screenshot.
const FORBIDDEN = [
	[/\bfetch\s*\(/, 'fetch'],
	[/XMLHttpRequest|WebSocket|sendBeacon/, 'a network client'],
	[/\b(local|session)Storage\b|indexedDB/i, 'storage, which throws in an opaque origin'],
	[/\bnew\s+Function\b|\beval\s*\(/, 'eval, which the policy blocks'],
	[/<iframe|<video|<audio|new\s+Worker|importScripts/, 'a nested frame, media or a worker'],
	[/(src|href)\s*=\s*["']https?:/, 'an external asset'],
	[/window\.open|\balert\s*\(|\bconfirm\s*\(|\bprompt\s*\(/, 'a popup the sandbox has not got'],
];
// Comments first, or the page's own note that `new Function` is blocked reads as a page using
// it. A check that fires on the sentence explaining why the thing is absent is a check nobody
// will believe the second time.
const CODE = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
	.filter(l => !/^\s*\/\//.test(l)).join('\n');
const found = FORBIDDEN.filter(([re]) => re.test(CODE)).map(([, n]) => n);
check('the page asks for nothing the sandbox and the policy have not got',
	found.length === 0, found.join(', ') || 'none of ' + FORBIDDEN.length);

// The files the template carries, read as data rather than as bytes. A lane whose `show` names
// a field that is not there draws a dash for ever and says nothing about why, so the drift is
// worth catching in a file rather than in a screenshot — and this costs no browser.
{
	const gone = CARRIES.filter(f => !fs.existsSync(path.join(DIR, f)));
	check('the template carries every file its manifest names', gone.length === 0,
		gone.join(', ') || CARRIES.length + ' files');
	const complaints = [];
	if (!gone.length) {
		const index = JSON.parse(FILE('index.json'));
		const lanes = index.lanes.map(id => [id, JSON.parse(FILE('lanes/' + id + '.json'))]);
		const named = CARRIES.filter(f => f.startsWith('lanes/')).map(f => f.slice(6, -5));
		if (named.sort().join() !== index.lanes.slice().sort().join()) {
			complaints.push('index.json names ' + index.lanes + ' but the manifest carries ' + named);
		}
		for (const [id, l] of lanes) {
			const keys = new Set((l.fields || []).map(f => f.k));
			const cat = fs.existsSync(path.join(DIR, 'cat/' + id + '.json'))
				? JSON.parse(FILE('cat/' + id + '.json')) : { items: [] };
			const items = new Set((cat.items || []).map(x => x.id));
			const wants = (k, why) => { if (k && !keys.has(k)) complaints.push(id + ': ' + why + ' names `' + k + '`'); };
			if (l.id !== id) complaints.push(id + ': the file says id `' + l.id + '`');
			wants(l.primary, 'primary'); wants(l.second, 'second'); wants(l.title, 'title');
			(l.show || []).forEach(s => wants(String(s).split(':')[0], 'show'));
			(l.sessShow || []).forEach(s => wants(String(s).split(':')[0], 'sessShow'));
			(l.setFields || []).forEach(k => wants(k, 'setFields'));
			(l.targets || []).forEach(t => wants(t.f, 'a target'));
			for (const f of l.fields || []) {
				if (f.d && f.d.c) {
					wants(f.d.c, 'the catalogue field of `' + f.k + '`');
					wants(f.d.by, 'the scaling field of `' + f.k + '`');
					// Every item must carry the number the derived field reads off it, or that
					// item silently contributes nothing to the day's total.
					const missing = (cat.items || []).filter(x => !x.v || x.v[f.d.k] == null);
					if (missing.length) {
						complaints.push(id + ': ' + missing.length + ' catalogue items have no `'
							+ f.d.k + '` for field `' + f.k + '`');
					}
				}
				if (f.d && f.d.e) {
					(f.d.e.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])
						.forEach(v => wants(v, 'the formula of `' + f.k + '`'));
				}
			}
			for (const t of l.tiles || []) {
				wants(t.by, 'tile `' + t.n + '`');
				(t.fs || []).forEach(k => wants(k, 'tile `' + t.n + '`'));
				for (const bag of [t.f].concat(t.e || []).filter(Boolean)) {
					for (const k of Object.keys(bag)) {
						wants(k, 'tile `' + t.n + '`');
						const fd = (l.fields || []).find(x => x.k === k);
						if (fd && fd.t === 'ref' && !items.has(bag[k])) {
							complaints.push(id + ': tile `' + t.n + '` points at `' + bag[k]
								+ '`, which is not in the catalogue');
						}
						if (fd && fd.t === 'enum' && !(fd.o || []).includes(bag[k])) {
							complaints.push(id + ': tile `' + t.n + '` sets ' + k + '=`' + bag[k]
								+ '`, which is not one of its choices');
						}
					}
				}
			}
		}
	}
	check('every lane it carries points only at fields, catalogue items and choices that exist',
		complaints.length === 0, complaints.slice(0, 4).join(' | ') || 'checked');
}

// The same lanes, twice over, and they have to be the same lanes. A delivered Diamond gets the
// files in this directory; one a daimon wrote from the page alone gets `seed()`'s literals. The
// two are maintained by hand and drift silently — a property added to the page's gym and not to
// `lanes/gym.json` is a feature that works for one half of the users and is absent for the
// other, and every check in this file that runs delivered would say nothing about it. So the
// literals are lifted out of the page's own source and compared. `eval` here is node reading a
// data literal out of a file this repo owns; the page itself may not have it and is held to
// that separately.
{
	const grab = (name) => {
		const i = PAGE.indexOf('var ' + name + ' = {');
		if (i < 0) return null;
		const j = PAGE.indexOf('{', i);
		let d = 0, k = j;
		for (; k < PAGE.length; k++) {
			if (PAGE[k] === '{') d++;
			else if (PAGE[k] === '}' && !--d) break;
		}
		return PAGE.slice(j, k + 1);
	};
	// The page's own per-100 g helper, in scope so the diet literal evaluates as it does there.
	// eslint-disable-next-line no-unused-vars
	const sc = (k, n, u) => ({ k, t: 'num', n, u, agg: 'sum', d: { c: 'food', k, per: 100, by: 'g' } });
	const drift = [];
	for (const id of ['diet', 'gym', 'body']) {
		const src = grab(id);
		if (!src) { drift.push(id + ': no literal in the page at all'); continue; }
		let seeded = null;
		try { seeded = eval('(' + src + ')'); } catch (e) { drift.push(id + ': ' + e.message); continue; }
		const shipped = JSON.parse(FILE('lanes/' + id + '.json'));
		const a = JSON.stringify(seeded), b = JSON.stringify(shipped);
		if (a !== b) {
			const pos = [...a].findIndex((c, n) => c !== b[n]);
			drift.push(id + ' differs from ' + pos + ': carried `' + b.slice(pos, pos + 40)
				+ '` vs seeded `' + a.slice(pos, pos + 40) + '`');
		}
	}
	check('THE LANES IT CARRIES ARE THE LANES IT WOULD SEED', drift.length === 0,
		drift.join(' | ') || 'diet, gym and body identical either way');
}

// ── A fortnight of history, so the charts have something to draw ──
const p2 = n => (n < 10 ? '0' : '') + n;
const ymd = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
const isoAt = d => {
	const o = -d.getTimezoneOffset(), s = o < 0 ? '-' : '+', a = Math.abs(o);
	return ymd(d) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
		+ s + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
};
let n = 0;
const nid = () => 'seed' + (++n).toString(36);
const at = (back, h, m) => {
	const d = new Date();
	d.setDate(d.getDate() - back); d.setHours(h, m, 0, 0);
	return d;
};
const ent = (back, h, m, f, src, of) => {
	const d = at(back, h, m);
	return { id: nid(), at: isoAt(d), day: ymd(d), of, src, f, w: Date.now() };
};

// The energy column of the page's own food table, so the oracle below is arithmetic done HERE
// rather than the page's answer read back at it. If these drift from the page the check fails,
// which is the point: they are the input to a number the page must reproduce.
const KCAL = {
	oats: 379, milk: 61, ban: 89, coff: 1, bread: 247, ched: 403, app: 52,
	alm: 579, chick: 165, rice: 130, broc: 34, choc: 546,
};

const diet = [], gym = [], body = [];
const BREAKFAST = [['oats', 80], ['milk', 250], ['ban', 120]];
const LUNCH = [['bread', 120], ['ched', 40], ['app', 150]];
const DINNER = [['chick', 200], ['rice', 250], ['broc', 150]];
const GAP_DAY = 5;			// one day with nothing in it, so a streak and a chart mean something
let todayKcal = 0;
for (let d = 13; d >= 0; d--) {
	if (d === GAP_DAY) continue;
	const eat = (back, h, m, food, g, meal, src) => {
		diet.push(ent(back, h, m, { food, g, meal }, src));
		if (back === 0) todayKcal += KCAL[food] * g / 100;
	};
	for (const [food, g] of BREAKFAST) eat(d, 7, 40, food, g, 'Breakfast', 'expand');
	eat(d, 9, 15, 'coff', 250, 'Snack', 'preset');
	for (const [food, g] of LUNCH) eat(d, 12, 50, food, g, 'Lunch', 'scale');
	if (d % 3 === 0) eat(d, 16, 10, 'alm', 30, 'Snack', 'scale');
	for (const [food, g] of DINNER) eat(d, 19, 30, food, g, 'Dinner', 'expand');
	if (d % 4 === 1) eat(d, 21, 0, 'choc', 25, 'Snack', 'form');
	body.push(ent(d, 7, 5, { kg: 82.4 - (13 - d) * 0.06, waist: 88 - (13 - d) * 0.05 }, 'form'));
	body.push(ent(d, 7, 6, { sleep: (6.4 + (d % 3) * 0.55) * 3600, mood: ['Fine', 'Good', 'Great', 'Flat'][d % 4] }, 'form'));
	// `d === 1` as well as every fifth day, and it is not decoration. THE BODY LANE'S DAY STARTS
	// AT 04:00, so between midnight and four in the morning the lane's "today" is the calendar
	// day before — and with a reading only every fifth day, that bucket had no resting heart rate
	// in it and the check below went red on the clock rather than on the code. A verifier that
	// fails for four hours a night is a verifier people learn to ignore.
	if (d % 5 === 0 || d === 1) body.push(ent(d, 7, 8, { hr: 54 + (d % 3) }, 'form'));
}
// A PLAN, and not a record. Two of tonight's meals written down before they are eaten, and one
// on the day the log has a hole in. Both are drawn and neither is counted, which is the whole
// of `p` — and the choice of foods is deliberate: they are foods ALREADY eaten today, so the
// pie's series are the same set either way and only the totals would move. A break that
// counted them therefore has nowhere to hide behind a legend that happened to change shape.
const PLANNED = [['chick', 300], ['rice', 300]];
let plannedKcal = 0;
for (const [food, g] of PLANNED) {
	const e = ent(0, 20, 30, { food, g, meal: 'Dinner' }, 'pick');
	e.p = 1;
	diet.push(e);
	plannedKcal += KCAL[food] * g / 100;
}
// On the empty day, so that a plan cannot extend a streak or raise a bar out of nothing.
const gapPlan = ent(GAP_DAY, 12, 0, { food: 'app', g: 150, meal: 'Lunch' }, 'pick');
gapPlan.p = 1;
diet.push(gapPlan);
const STREAK = GAP_DAY;		// days 0..4 have something real in them, and the fifth has a plan

// Distinct foods eaten today, which is what the pie has to split up. Eleven of them, and the
// page's rule is that a ninth series is never a ninth hue: seven, then a neutral Other. Real
// entries only: the pie is a reading and a plan is not read.
const TODAY_FOODS = new Set(diet.filter(e => e.day === ymd(new Date()) && !e.p).map(e => e.f.food));
const DAYS_LOGGED = 13;		// fourteen buckets on the chart, one of them empty

// Yesterday's session is the one the verifier opens, so its numbers are named here.
const PUSH = [['bp', 85, 5], ['bp', 85, 4], ['ohp', 47.5, 6], ['push', 25, 15], ['dip', 0, 10]];
const PLAN = [
	[12, 'Legs', [['sq', 100, 5], ['sq', 100, 5], ['sq', 105, 3], ['rdl', 80, 8], ['rdl', 80, 8], ['lp', 160, 10]]],
	[9, 'Push', [['bp', 80, 5], ['bp', 82.5, 5], ['bp', 85, 3], ['ohp', 45, 8], ['ohp', 45, 7], ['dip', 0, 12]]],
	[6, 'Pull', [['dl', 140, 3], ['dl', 145, 3], ['row', 70, 8], ['row', 70, 8], ['lat', 60, 10], ['curl', 14, 12]]],
	[3, 'Legs', [['sq', 105, 5], ['sq', 105, 5], ['sq', 110, 3], ['rdl', 85, 8], ['lp', 170, 10]]],
	[1, 'Push', PUSH],
];
const SESS_MIN = 62;
for (const [back, name, sets] of PLAN) {
	const s = ent(back, 18, 0, { name }, 'tap');
	// TWO STAMPS AND NO TYPED DURATION. A session is open until it has an `end`, and its
	// length is the distance between the two — so every one of these is finished, none of
	// them scopes the page on opening, and the 1h 2m the screen shows for one of them is
	// arithmetic on the pair rather than a number in a field.
	s.sess = 1;
	s.end = isoAt(at(back, 19, 2));
	gym.push(s);
	sets.forEach(([lift, kg, reps], i) => {
		gym.push(ent(back, 18, 4 + i * 6, { lift, kg, reps }, 'form', s.id));
	});
}
// How many of those sessions fall in the month the run happens in — COUNTED rather than assumed.
// `back: 12` is the second of the month on the fourteenth and the twenty-fourth of the month
// before on the sixth, so a check that assumed all five would be a check that failed for the
// first fortnight of every month.
const THIS_MONTH = ymd(new Date()).slice(0, 7);
const SESS_IN_MONTH = PLAN.filter(([back]) => ymd(at(back, 18, 0)).slice(0, 7) === THIS_MONTH).length;

// Volume is `kg*reps` summed, and the sets are grouped by lift in the order each first appeared.
const PUSH_LIFTS = [...new Set(PUSH.map(x => x[0]))];
const BENCH_VOL = PUSH.filter(x => x[0] === 'bp').reduce((a, [, kg, reps]) => a + kg * reps, 0);

const shard = es => {
	const by = {};
	for (const e of es) (by[e.day.slice(0, 7)] ||= []).push(JSON.stringify(e));
	return by;
};
// LOCAL, not `toISOString`: the page files an entry under the local day it belongs to, and a
// UTC month would read the wrong shard for anybody east of Greenwich in the first hours of a
// month. That is the same trap the page's own date comment names.
const ym = ymd(new Date()).slice(0, 7);
const today = ymd(new Date());

// ── Drive it ──────────────────────────────────────────────────────
const s = await open({ name: 'lifelog', signIn: false, connect: false });
const { page } = s;
const shot = async (label) => {
	const p = path.join(SHOTS, label + '.png');
	await page.screenshot({ path: p, fullPage: false, timeout: 12000 }).catch(e => console.log('shot: ' + e));
	console.log('  shot ' + p);
};
/// The crystal column alone, which is the thing being judged. The frame is taller than the
/// panel, so the panel is scrolled first and the shot is of what a reader would have in front
/// of them.
const shotP = async (label, y) => {
	if (y != null) {
		// Whatever actually scrolls. `.crystal-body` is the scroller on the desktop layout and is
		// NOT one on the phone, where the panel is a sheet — so a run that only ever set
		// `.crystal-body.scrollTop` took every 375px shot at the top of the page and labelled them
		// "charts" and "session". A shot that does not show what its name says is worse than none.
		const moved = await page.evaluate((yy) => {
			const seen = [];
			let el = document.querySelector('.crystal-frame');
			while (el && el !== document.documentElement) {
				const cs = getComputedStyle(el);
				if (el.scrollHeight > el.clientHeight + 4 && /auto|scroll/.test(cs.overflowY)) {
					el.scrollTop = yy;
					seen.push((el.className || el.tagName) + '=' + el.scrollTop);
					if (el.scrollTop > 0) return seen;
				}
				el = el.parentElement;
			}
			window.scrollTo(0, yy);
			seen.push('window=' + window.scrollY);
			return seen;
		}, y);
		if (!moved.some(x => !/=0$/.test(x))) console.log('  (nothing scrolled: ' + moved.join(' ') + ')');
		await page.waitForTimeout(350);
	}
	const el = await page.$('.panel[data-panel="ai"]');
	const p = path.join(SHOTS, label + '.png');
	if (el) await el.screenshot({ path: p, timeout: 12000 }).catch(e => console.log('shot: ' + e));
	else await page.screenshot({ path: p, timeout: 12000 }).catch(() => {});
	console.log('  shot ' + p);
};
/// What the channel thinks of the page: the reason it gave up, if it did, and the keys the page
/// said it drew. `_state()` is the verifier's window on it and the app never uses it.
const state = () => page.evaluate(() => {
	const st = window.DaimondCrystal && window.DaimondCrystal._state && window.DaimondCrystal._state();
	return st ? { mode: st.mode, reason: st.reason, keys: st.keys, ready: st.ready } : null;
});
/// Anything inside the crystal frame. It is the only blob: frame on the page — the guide is a
/// child of the main frame too, and a naive search finds that one and measures it instead.
const inFrame = async (fn, arg) => {
	const f = page.frames().find(fr => fr.url().indexOf('blob:') === 0);
	if (!f) throw new Error('the crystal frame is not mounted; channel says '
		+ JSON.stringify(await state()));
	return await f.evaluate(fn, arg);
};
/// A number as the page printed it: "1,980" and "82.4 kg" both come back as numbers.
const numOf = (txt) => {
	const m = /-?[\d,]*\.?\d+/.exec(String(txt || '').replace(/\s/g, ''));
	return m ? Number(m[0].replace(/,/g, '')) : NaN;
};

let id = '';
/// One lane's shard as records, read outside the page through the engine. `file_read` numbers
/// its lines, so the prefix comes off before the JSON does.
const shardLines = async (lane = 'diet') => {
	const txt = await page.evaluate((a) => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + a.id + '/log/' + a.lane + '/' + a.ym + '.jsonl' }))
		.then(String).catch(e => 'ERR ' + e), { id, ym, lane });
	return String(txt).split('\n')
		.map(x => x.replace(/^\s*\d+\t/, ''))
		.filter(x => x.trim())
		.map(x => { try { return JSON.parse(x); } catch { return null; } })
		.filter(Boolean);
};
/// A lane file as an object, whatever the engine put in front of its lines — or null, which is
/// what a lane that was never written looks like from out here.
const jsonAt = async (rel) => {
	const txt = await page.evaluate((a) => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + a.id + '/' + a.rel }))
		.then(String).catch(e => 'ERR ' + e), { id, rel });
	const body = String(txt).split('\n').map(x => x.replace(/^\s*\d+\t/, '')).join('\n').trim();
	try { return JSON.parse(body); } catch { return null; }
};
/// Everything a lane points at that is not there. The same invariant the static block holds the
/// SHIPPED lanes to, applied to a lane the page made a minute ago: a `show` naming a field that
/// does not exist draws a dash for ever, and a tile naming one logs nothing when it is pressed.
const laneComplaints = (l) => {
	const byK = new Map(((l && l.fields) || []).map(f => [f.k, f])), out = [];
	const wants = (k, why) => { if (k && !byK.has(k)) out.push(why + ' names `' + k + '`'); };
	wants(l.primary, 'primary');
	(l.show || []).forEach(s => wants(String(s).split(':')[0], 'show'));
	(l.targets || []).forEach(t => wants(t.f, 'a target'));
	for (const t of l.tiles || []) {
		wants(t.by, 'tile `' + t.n + '`');
		(t.fs || []).forEach(k => wants(k, 'tile `' + t.n + '`'));
		for (const bag of [t.f].concat(t.e || []).filter(Boolean)) {
			for (const k of Object.keys(bag)) {
				wants(k, 'tile `' + t.n + '`');
				const fd = byK.get(k);
				// A tile that sets a choice the field does not offer records a value nothing can
				// read back — the same complaint the static block makes about the shipped lanes.
				if (fd && fd.t === 'enum' && !(fd.o || []).includes(bag[k])) {
					out.push('tile `' + t.n + '` sets ' + k + '=`' + bag[k] + '`, not one of its choices');
				}
			}
		}
	}
	return out;
};
/// The view the page is in, read off the switch itself rather than guessed from what is drawn.
const viewNow = () => inFrame(() => {
	const on = document.querySelector('[data-a="view"].on');
	return on ? on.getAttribute('data-v') : '';
});
/// What each view is made of, which is the whole of the owner's second request.
const viewParts = () => inFrame(() => ({
	tiles: document.querySelectorAll('.pad .tile').length,
	rows: document.querySelectorAll('.er').length,
	stats: document.querySelectorAll('.st').length,
	charts: document.querySelectorAll('svg').length,
}));
/// mm:ss as seconds, or -1. The rest clock is read off the screen, because what the page holds
/// in a closure is not what the person in the gym is looking at.
const clockSecs = (t) => {
	const m = /(\d+):(\d+)/.exec(String(t || ''));
	return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
};
/// The live list, group by group: what each exercise is called, what its heading adds up to,
/// what each of its rows is showing, and which rows are still only a plan.
const liveGroups = () => inFrame(() => [...document.querySelectorAll('.grp')].map(g => ({
	n: g.querySelector('.grph .gap').textContent,
	vol: g.querySelector('.grph .ev').textContent,
	pend: g.querySelectorAll('.setr.pend').length,
	green: g.querySelectorAll('.tick.on').length,
	vals: [...g.querySelectorAll('.setr')].map(r => {
		const ins = [...r.querySelectorAll('.setin')];
		return ins.length ? ins.map(i => i.value).join('x') : r.querySelector('.gap').textContent.trim();
	}),
})));
/// THE ROOM A GLYPH ACTUALLY HAS, which is not the same question as whether the text is there.
///
/// An input whose `value` is correct and whose content box is a fraction of a pixel shorter
/// than its own type shows nothing at all, and every assertion on its value passes. So each
/// control is measured three ways: the height left inside the padding against the font size,
/// and whether the content overflows the box in either direction. All of the new controls are
/// small boxes with numbers in them, which is precisely the shape this fails on.
const roomIn = (sel) => inFrame((s) => [...document.querySelectorAll(s)].map((el) => {
	const cs = getComputedStyle(el);
	const r1 = (v) => Math.round(v * 10) / 10;
	return {
		n: s + '>' + String(el.className || el.tagName).split(' ').join('.'),
		fs: r1(parseFloat(cs.fontSize)),
		room: r1(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)),
		overW: r1(el.scrollWidth - el.clientWidth),
		overH: r1(el.scrollHeight - el.clientHeight),
	};
}), sel);
/// THE CONTRAST OF INK ON THE GROUND IT ACTUALLY SITS ON.
///
/// The walk up for the first OPAQUE background is the whole of this function, and it is here
/// because of a real failure in this app: a contrast verifier once reported eleven palettes at
/// exactly 1.00 because it read `background-color` off the element, got `rgba(0,0,0,0)`,
/// treated that as a colour, and was in effect photographing the backdrop. So a colour that is
/// not opaque is not a ground, and an element whose ground cannot be resolved is REPORTED with
/// a null ratio rather than quietly scored as anything at all.
///
/// Only elements with a text node of their OWN are measured. A container is not judged on text
/// belonging to its children, or a wrapper whose own colour nothing ever paints would fail a
/// check about something a reader can actually see.
const contrastIn = (sel) => inFrame((s) => {
	const lum = (c) => {
		const m = /(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(c || '');
		if (!m) return null;
		if (m[4] != null && Number(m[4]) < 0.95) return null;
		const f = (v) => {
			v = Number(v) / 255;
			return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]);
	};
	const ground = (el) => {
		let e = el;
		while (e) {
			const g = lum(getComputedStyle(e).backgroundColor);
			if (g != null) return g;
			e = e.parentElement;
		}
		return null;
	};
	const own = (k) => [...k.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
	const out = [];
	for (const el of document.querySelectorAll(s)) {
		for (const k of [el, ...el.querySelectorAll('*')]) {
			if (!own(k)) continue;
			const ink = lum(getComputedStyle(k).color), bg = ground(k);
			const name = s + '>' + String(k.className || k.tagName).split(' ').join('.');
			if (ink == null || bg == null) { out.push({ n: name, r: null }); continue; }
			const hi = Math.max(ink, bg) + 0.05, lo = Math.min(ink, bg) + 0.05;
			out.push({ n: name, r: Math.round((hi / lo) * 100) / 100 });
		}
	}
	return out;
}, sel);

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
	await signInAs(s, 'lifelog');
	await connectMock(s);
	await page.waitForTimeout(1500);

	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Lifelog');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1800);
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(1200);

	id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Lifelog');
		return d ? d.id : '';
	});
	check('a Diamond to live in', !!id, id);

	// `habits` is the one that matters: a key no page has heard of, which is the EXPECTED case
	// because the reducer is a fresh model rewriting the whole crystal from one sentence. A page
	// that drew the four it recognised and left this one out must be taken down.
	const CRYSTAL = {
		title: 'Lifelog',
		summary: 'What I eat, what I lift, and what the scales say. Kept here so the '
			+ 'numbers are mine and stay on this device.',
		facts: [{ k: 'Started', v: 'this month' }, { k: 'Lanes', v: 'diet, gym, body' }],
		open: ['Get fibre over 30 g a day', 'Squat 120 kg for five'],
		habits: { weighIn: 'every morning, before breakfast' },
	};
	// The template laid down exactly as `cappFiles` lays it down, unless `--seed`, in which case
	// the page arrives alone and has to furnish the Diamond itself.
	const carried = SEED_MODE ? [] : CARRIES.map(rel => [rel, FILE(rel)]);
	await page.evaluate(async (a) => {
		const w = (p, c) => window.__free.run_tool('file_write', JSON.stringify({ path: p, content: c }));
		await w('diamonds/' + a.id + '/crystal.json', a.crystal);
		await w('diamonds/' + a.id + '/crystal.html', a.page);
		for (const [rel, text] of a.carried) await w('diamonds/' + a.id + '/' + rel, text);
		for (const [lane, by] of a.logs) {
			for (const ymk in by) {
				await w('diamonds/' + a.id + '/log/' + lane + '/' + ymk + '.jsonl', by[ymk].join('\n') + '\n');
			}
		}
	}, {
		id, page: PAGE, crystal: JSON.stringify(CRYSTAL), carried,
		logs: [['diet', shard(diet)], ['gym', shard(gym)], ['body', shard(body)]],
	});

	// Re-select, so the crystal renders AFTER the page was written — and again after every
	// viewport change. A resize reparents the panel, the iframe fires a SECOND `load`, and
	// crystal.js treats that as `partial` and tears the frame down. That is the app's rule and
	// not this page's business, but it means a screenshot at a new width has to be taken on a
	// fresh mount.
	const mount = async (w, h) => {
		if (w) { await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(700); }
		// The guide and the workspace take two of four seats; a person reading a Diamond has them
		// shut, and with them open the crystal column is 250px.
		await page.evaluate(() => { DaimondPanels.hide('guide'); DaimondPanels.hide('work'); });
		await page.waitForTimeout(400);
		await page.evaluate(() => DaimondPanels.show('ai'));
		await page.waitForTimeout(400);
		await page.$$eval('.diamond-box', els => els[0] && els[0].click());
		await page.waitForTimeout(3200);
	};
	// Tall enough that the whole crystal column is in the shot. The panel is the scroller and it
	// does not answer to `scrollTop` from a script — see `shotP` — so the only honest way to
	// photograph the bottom of the page is to give the viewport room for it.
	await mount(1280, 1560);

	// ── 2. The coverage trap, checked from both ends ──
	const up = await page.evaluate(() => !!document.querySelector('#crystal-frame, .crystal-frame'));
	const fell = await page.evaluate(() => !!document.querySelector('.crystal-fallback-note'));
	check('THE FRAME IS UP AND THE APP DID NOT FALL BACK', up && !fell,
		'frame:' + up + ' fallback:' + fell);
	// THE PAGE THAT IS ACTUALLY RUNNING, read out of the frame's own document.
	//
	// A break lives in a string held by this file; what matters is the code the browser is
	// executing. If the damage never reached that, the run goes green for the best of reasons
	// and proves nothing — and the matrix then reads exactly like a matrix of real results.
	// So on a clean run the document is confirmed whole, and on a broken one the anchor is
	// confirmed GONE and the damage confirmed PRESENT: both directions, because a replacement
	// that appended rather than replaced would satisfy only the second.
	//
	// It is read from the FRAME and not from the file, and that is not a convenience. The
	// engine's `file_read` truncates at 80,000 bytes and the page is larger than that, so a
	// check written against the file would have reported every late anchor as gone — the page
	// literal that seeds the lanes is in the last tenth of it. `outerHTML` carries the text of
	// every `<style>` and `<script>` verbatim, which is where every anchor here lives.
	// One break legitimately KEEPS its anchor and wraps a guard round it, so "the anchor is
	// gone" is only asked of a replacement that replaces. Distinguishing the two is the point:
	// the check this first ran under called that break broken, which is the same instrument
	// working — it noticed a difference between what was meant and what was there.
	const spec = BREAK ? BREAKS[BREAK] : null;
	const additive = !!spec && spec.with.indexOf(spec.find) >= 0;
	const running = await inFrame(() => document.documentElement.outerHTML);
	check(BREAK ? 'AND THE BREAK REACHED THE PAGE THAT IS RUNNING'
		: 'the page that is running is the page in this repo',
		BREAK
			? running.includes(spec.with) && (additive || !running.includes(spec.find))
			: running.includes(PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('<style>') + 400))
				&& running.length > bytes * 0.9,
		BREAK
			? 'damage present: ' + running.includes(spec.with)
				+ (additive ? ' (additive, so the anchor stays)'
					: ', anchor gone: ' + !running.includes(spec.find))
			: running.length + ' characters running vs ' + bytes + ' bytes on disk');

	const st = await state();
	const missing = Object.keys(CRYSTAL).filter(k => !(st && (st.keys || []).includes(k)));
	check('and `rendered` named every content key, the unknown one included',
		missing.length === 0, 'missing: ' + (missing.join(', ') || 'none')
		+ ' | mode:' + (st && st.mode) + ' reason:' + (st && st.reason));

	// ── 3. The Diamond is furnished, by whichever of the two routes applies ──
	//
	// `seeded` is the tell: the page stamps `index.json` with the moment it furnished the store,
	// and the shipped template has no such stamp. So the delivered run proves the page READ the
	// template rather than overwriting it, and the seed run proves the page wrote one when it
	// found nothing — which the same string test could never have separated.
	const readAt = (rel) => page.evaluate((a) => window.__free
		.run_tool('file_read', JSON.stringify({ path: 'diamonds/' + a.id + '/' + a.rel }))
		.then(String).catch(e => 'ERR ' + e), { id, rel });
	const laneFile = await readAt('lanes/diet.json');
	const indexFile = await readAt('index.json');
	const stamped = /"seeded"/.test(indexFile);
	check('it has furnished lanes to be used from',
		/"tiles"/.test(laneFile) && /Porridge/.test(laneFile), laneFile.slice(0, 70));
	check(SEED_MODE
		? 'and it furnished them ITSELF, having arrived with nothing'
		: 'and it read the ones the template carried rather than seeding over them',
		SEED_MODE ? stamped : !stamped, 'seeded stamp: ' + stamped);

	// It drew the seeded fortnight rather than an empty day: one row per top-level entry today.
	const todayRows = diet.filter(e => e.day === today).length;
	const drew = await inFrame(() => ({
		tiles: document.querySelectorAll('.tile').length,
		rows: document.querySelectorAll('.er').length,
		names: [...document.querySelectorAll('.er .en')].map(x => x.firstChild.textContent),
		wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
	}));
	check('every one of today\'s entries is a row, named from the catalogue',
		drew.rows === todayRows && drew.names.includes('Rolled oats') && drew.names.includes('Black coffee'),
		drew.rows + ' rows for ' + todayRows + ' entries; ' + drew.names.slice(0, 3).join(' / '));
	check('no horizontal scroll', !drew.wide, JSON.stringify({ wide: drew.wide }));

	// ── `p`: a plan, drawn ──
	//
	// The row count above already includes the two planned meals, because a plan is an entry
	// like any other and IS shown. This is the other half: that it is shown AS a plan, so a
	// day already eaten is not confused with a day merely intended. It needs its own break,
	// because every aggregation check below is equally green whether a plan is uncounted or
	// simply absent — two correct checks with a gap between them that neither can see.
	const planned = await inFrame(() => ({
		rows: document.querySelectorAll('.er').length,
		pend: document.querySelectorAll('.er.pend').length,
		said: [...document.querySelectorAll('.er.pend small')].map(x => x.textContent).join(' | '),
		names: [...document.querySelectorAll('.er.pend .en')].map(x => x.firstChild.textContent),
	}));
	check('A PLANNED ENTRY IS DRAWN, AND DRAWN AS A PLAN',
		planned.pend === PLANNED.length && planned.rows === todayRows
		&& planned.names.includes('Chicken breast') && /planned/.test(planned.said),
		JSON.stringify(planned));

	// ── 9. Log and Life: the axis he asked for ──
	//
	// Assert what each view IS MADE OF, not which button looks pressed. The complaint was that
	// one screen mixed entry with reporting, so the property is that the tile pad and the charts
	// are never on the same screen — and that a person who presses Life can get back.
	const logParts = await viewParts();
	check('LOG IS THE ENTRY VIEW: tiles to press and the entries they made, nothing to read back',
		logParts.tiles > 0 && logParts.rows > 0 && logParts.stats === 0 && logParts.charts === 0,
		JSON.stringify(logParts));
	await inFrame(() => document.querySelector('[data-a="view"][data-v="life"]').click());
	await page.waitForTimeout(900);
	const lifeParts = await viewParts();
	check('LIFE IS THE READING VIEW: the numbers and the charts, and no tile pad in front of them',
		lifeParts.stats > 0 && lifeParts.charts > 0 && lifeParts.tiles === 0,
		JSON.stringify(lifeParts));

	// ── 7a. The arithmetic, against a number computed here ──
	const energy = await inFrame(() => {
		const st2 = [...document.querySelectorAll('.st')]
			.find(x => /Energy/.test(x.querySelector('.sk').textContent));
		return st2 ? st2.querySelector('.sv').textContent : '';
	});
	check('TODAY\'S ENERGY IS THE FIXTURE\'S OWN ARITHMETIC',
		numOf(energy) === Math.round(todayKcal),
		'page: ' + JSON.stringify(energy) + '  expected: ' + Math.round(todayKcal)
		+ ' (' + todayKcal.toFixed(1) + ')');
	await shotP('lifelog-1280-dark-life', 0);
	await inFrame(() => document.querySelector('[data-a="view"][data-v="log"]').click());
	await page.waitForTimeout(800);
	const backParts = await viewParts();
	const backView = await viewNow();
	check('AND THE SWITCH GOES BOTH WAYS, so a tap on Life is not a mode to be stuck in',
		backView === 'log' && backParts.tiles > 0 && backParts.charts === 0,
		'view:' + backView + ' ' + JSON.stringify(backParts));

	console.log('  channel: ' + JSON.stringify(st));
	// The frame is only as tall as the page says it is, and a page that reports short is a page
	// whose bottom half nobody ever sees.
	const geom = await page.evaluate(() => {
		const f = document.querySelector('.crystal-frame');
		return f ? { h: f.clientHeight, min: f.style.minHeight } : null;
	});
	const inner = await inFrame(() => ({
		body: document.body.scrollHeight, root: document.documentElement.scrollHeight,
		app: document.getElementById('app').scrollHeight,
	}));
	check('the frame is as tall as the page', geom && geom.h >= inner.app - 8,
		JSON.stringify(geom) + ' vs ' + JSON.stringify(inner));
	// AND THE HEIGHT CAME FROM THE PAGE, which `clientHeight` alone cannot tell you: at this
	// viewport the frame's own layout is already taller than the page, so the check above is
	// green whether the page reported a height or never opened its mouth. `--break noheight`
	// drops the `height` message and that check did not move — a break proving nothing.
	// `crystal.js:onHeight` turns the message into an inline `min-height` (a MINIMUM, so a
	// short page still fills the panel), and that inline style is the only evidence that the
	// page's own number reached the app. On a phone, where the panel is shorter than the page,
	// it is also the whole reason the bottom half is reachable at all.
	const minPx = geom && parseFloat(geom.min || '');
	check('AND ITS HEIGHT CAME FROM THE PAGE\'S OWN MESSAGE, not from the layout around it',
		!!(minPx > 0 && minPx >= inner.app - 8),
		'min-height:' + JSON.stringify(geom && geom.min) + ' vs the page\'s ' + inner.app + 'px');
	await shotP('lifelog-1280-dark-log', 0);
	await shotP('lifelog-1280-dark-log-2', 620);

	// ── 8. Charts ──
	await inFrame(() => document.querySelector('[data-a="view"][data-v="life"]').click());
	await page.waitForTimeout(700);
	await shotP('lifelog-1280-dark-charts', 560);
	const chart = await inFrame(() => ({
		bars: document.querySelectorAll('svg path[fill="var(--ac)"]').length,
		legend: [...document.querySelectorAll('.leg .lgn')].map(x => x.textContent),
	}));
	check('A BAR PER DAY THAT HAS SOMETHING, AND NONE FOR THE DAY THAT HAS NOT',
		chart.bars === DAYS_LOGGED, chart.bars + ' bars over 14 buckets, ' + DAYS_LOGGED + ' logged');
	// ── `p`: and counted by nothing ──
	//
	// The energy stat above is one witness. These are the other three, and they are here
	// rather than folded into it because they are three separate code paths: the pie goes
	// through `groups`, the streak through `streak`, and the bar for the empty day through
	// `aggPer`. A gate that leaked into any one of them would leave a number on the screen
	// that nobody has earned. The bar count is the check immediately above this one.
	const noCount = await inFrame(() => ({
		streak: (document.querySelector('.tag b') || {}).textContent || '',
		pie: (document.querySelector('.pie svg text') || {}).textContent || '',
	}));
	check('AND NO NUMBER COUNTS IT: NOT THE PIE, NOT THE STREAK, NOT THE EMPTY DAY\'S BAR',
		Number(noCount.streak) === STREAK && numOf(noCount.pie) === Math.round(todayKcal)
		&& Math.round(todayKcal) !== Math.round(todayKcal + plannedKcal),
		JSON.stringify(noCount) + ' expected streak ' + STREAK + ', pie ' + Math.round(todayKcal)
		+ ' (a plan would have made it ' + Math.round(todayKcal + plannedKcal) + ')');

	check('THE PIE FOLDS ITS TAIL INTO ONE NEUTRAL OTHER',
		TODAY_FOODS.size > 8 && chart.legend.length === 8
		&& chart.legend[chart.legend.length - 1] === 'Other',
		TODAY_FOODS.size + ' foods -> ' + chart.legend.length + ' series: ' + chart.legend.join(', '));

	// Group the pie by the catalogue's own attribute — the food-group split. Same mechanism as
	// grouping by the ref field itself, one option along.
	await inFrame(() => document.querySelectorAll('[data-a="pieg"]')[1].click());
	await page.waitForTimeout(500);
	const byGroup = await inFrame(() => [...document.querySelectorAll('.leg .lgn')].map(x => x.textContent));
	check('and it groups by an attribute of the catalogue item, not only by the field',
		byGroup.includes('Grain') && byGroup.includes('Protein') && byGroup.length < 8,
		byGroup.join(', '));
	await shotP('lifelog-1280-dark-pie-bygroup', 900);

	// Week, then month.
	await inFrame(() => document.querySelector('[data-a="per"][data-v="week"]').click());
	await page.waitForTimeout(900);
	await shotP('lifelog-1280-dark-week', 560);
	await inFrame(() => document.querySelector('[data-a="per"][data-v="month"]').click());
	await page.waitForTimeout(1200);
	await shotP('lifelog-1280-dark-month', 560);
	await inFrame(() => document.querySelector('[data-a="per"][data-v="day"]').click());
	await page.waitForTimeout(600);

	// ── 7b. The gym lane, one day back — where yesterday's session is ──
	await inFrame(() => document.querySelector('[data-a="lane"][data-v="gym"]').click());
	await page.waitForTimeout(1000);
	await inFrame(() => document.querySelector('[data-a="view"][data-v="log"]').click());
	await page.waitForTimeout(400);
	await inFrame(() => document.querySelector('[data-a="off"][data-v="-1"]').click());
	await page.waitForTimeout(1000);
	await shotP('lifelog-1280-dark-gym', 0);
	const opened = await inFrame(() => {
		const r = document.querySelector('[data-a="sess"]');
		if (!r) return false;
		r.click(); return true;
	});
	await page.waitForTimeout(600);
	await shotP('lifelog-1280-dark-session', 0);
	await shotP('lifelog-1280-dark-session-2', 520);
	const sess = await inFrame(() => ({
		groups: [...document.querySelectorAll('.grph')].map(g => ({
			n: g.querySelector('.gap').textContent, v: g.querySelector('.ev').textContent,
		})),
		sets: document.querySelectorAll('.setr').length,
	}));
	const bench = sess.groups.find(g => g.n === 'Bench press');
	check('A SESSION OPENS ON ITS SETS, GROUPED BY LIFT IN THE ORDER THEY APPEARED',
		opened && sess.sets === PUSH.length && sess.groups.length === PUSH_LIFTS.length,
		sess.sets + ' sets in ' + sess.groups.length + ' groups; expected '
		+ PUSH.length + ' in ' + PUSH_LIFTS.length);
	check('AND ONE LIFT\'S VOLUME IS kg x reps SUMMED, NOT A NUMBER OFF A SCREEN',
		!!bench && numOf(bench.v) === BENCH_VOL,
		'page: ' + JSON.stringify(bench && bench.v) + '  expected: ' + BENCH_VOL + ' kg');

	// ── `end`: a length that falls out of two stamps ──
	// The fixture typed no duration into any of these sessions. It stamped a start and a
	// finish 62 minutes apart, and the number on the scope bar is the distance between them.
	const spanBar = await inFrame(() => ({
		ts: (document.querySelector('.scope .ts') || {}).textContent || '',
		fin: (document.querySelector('[data-a="finish"]') || {}).textContent || '',
	}));
	check('A CLOSED SESSION\'S LENGTH IS THE DISTANCE BETWEEN ITS TWO STAMPS',
		/\b1h 2m\b/.test(spanBar.ts) && spanBar.fin === 'Reopen',
		JSON.stringify(spanBar) + ' expected ' + SESS_MIN + ' minutes and a way to reopen');

	// ── THE WORKOUT ──────────────────────────────────────────────────
	//
	// What the owner asked for, and what he did NOT ask for: a Gym screen. What is built is
	// the Log view given three things it did not have — a SCOPE (only this session's own
	// entries), a GROUPING (by the lane's `primary`), and rows that are a PLAN until they are
	// ticked. Everything asserted below is asserted through those three, which is why the
	// checks read `.grp`, `.setr` and `.scope` rather than anything named after a gym.
	await inFrame(() => {
		const b = document.querySelector('[data-a="unscope"]');
		if (b) b.click();
	});
	await page.waitForTimeout(400);
	await inFrame(() => document.querySelector('[data-a="now"]').click());
	await page.waitForTimeout(700);

	// The audio instrument, installed BEFORE anything can open a context — and proved to read
	// nothing first. A counter that was already at one would report the page as correct
	// whatever the page went on to do, which is the failure this project keeps paying for.
	await inFrame(() => {
		const Real = window.AudioContext || window.webkitAudioContext;
		window.__audio = { have: !!Real, ctx: 0, osc: 0, when: [] };
		if (!Real) return;
		const Fake = function () {
			const c = new Real();
			window.__audio.ctx++;
			const co = c.createOscillator.bind(c);
			c.createOscillator = function () {
				const o = co();
				window.__audio.osc++;
				const st = o.start.bind(o);
				o.start = function (t) {
					window.__audio.when.push(Math.round(t - c.currentTime));
					return st(t);
				};
				return o;
			};
			return c;
		};
		window.AudioContext = Fake;
		window.webkitAudioContext = Fake;
	});
	const audio0 = await inFrame(() => window.__audio);
	check('the audio instrument is in place and reads nothing yet',
		audio0.have && audio0.ctx === 0 && audio0.osc === 0, JSON.stringify(audio0));

	// ── A button starts a session, and the session becomes the screen ──
	const gymWas = new Set((await shardLines('gym')).map(e => e.id));
	await inFrame(() => {
		const t = [...document.querySelectorAll('.pad .tile')]
			.find(x => /Start a workout/.test(x.textContent));
		if (t) t.click();
	});
	await page.waitForTimeout(1600);
	const startLines = (await shardLines('gym')).filter(e => !gymWas.has(e.id));
	const sessId = startLines.length ? startLines[0].id : '';
	const live1 = await inFrame(() => ({
		scope: !!document.querySelector('.scope'),
		title: (document.querySelector('.scope .h1') || {}).textContent || '',
		finish: (document.querySelector('[data-a="finish"]') || {}).textContent || '',
		dates: !!document.querySelector('[data-a="off"]'),
		tiles: [...document.querySelectorAll('.pad .tile .tn')].map(x => x.textContent),
	}));
	await shotP('lifelog-1280-dark-workout-start', 0);
	check('A WORKOUT STARTS OPEN, TITLED, AND BECOMES THE SCREEN',
		startLines.length === 1 && startLines[0].sess === 1 && !startLines[0].end
		&& live1.scope && live1.title === 'Morning' && live1.finish === 'Finish'
		&& !live1.dates && live1.tiles.includes('Add exercises')
		&& !live1.tiles.includes('Start a workout'),
		JSON.stringify(live1) + ' | disk: '
		+ JSON.stringify(startLines.map(e => ({ sess: e.sess, end: e.end, f: e.f }))));

	// ── A picker that takes several, and the contrast of what it has taken ──
	//
	// The PRESSED state cannot be read off a computed style: `:active` needs a button that is
	// actually held down. So it is held down, on the frame's own coordinates, measured while
	// down, and then released — and the release IS the click that opens the picker, so the
	// measurement costs no extra interaction and cannot drift out of the sequence.
	let pressed = [];
	const tileBox = await (async () => {
		const f = page.frames().find(fr => fr.url().indexOf('blob:') === 0);
		return f ? await f.locator('.tile.acc').first().boundingBox().catch(() => null) : null;
	})();
	if (tileBox) {
		await page.mouse.move(tileBox.x + tileBox.width / 2, tileBox.y + tileBox.height / 2);
		await page.mouse.down();
		await page.waitForTimeout(180);
		pressed = await contrastIn('.tile:active');
		await page.mouse.up();
	} else {
		await inFrame(() => {
			const t = [...document.querySelectorAll('.pad .tile')]
				.find(x => /Add exercises/.test(x.textContent));
			if (t) t.click();
		});
	}
	await page.waitForTimeout(900);
	const chose = await inFrame(() => {
		const rows = [...document.querySelectorAll('.pickr')];
		for (const want of ['Back squat', 'Bench press']) {
			const r = rows.find(x => x.querySelector('.gap').textContent === want);
			if (r) r.click();
		}
		const add = document.querySelector('[data-a="padd"]');
		return {
			on: document.querySelectorAll('.pickr.on').length,
			label: add ? add.textContent : '',
			typed: !!document.getElementById('q'),
		};
	});
	await shotP('lifelog-1280-dark-workout-pick', 0);

	// ── The selected-button fault, in the class it belongs to ──
	//
	// A selected surface goes to the accent ground; if its contents keep the ink they had,
	// what you have just chosen is the one thing on the screen you cannot read. Four kinds of
	// filled surface are measured at once — a chosen row, a pressed tile, the view switch,
	// the primary button — and reported WITH THEIR NUMBERS, because a contrast check that
	// says only "pass" is one nobody can argue with.
	//
	// What this found in the shipped page was two separate faults. `.tile.acc .tn` sat AFTER
	// the pressed rule at equal weight, so a pressed accent tile drew accent ink on an accent
	// ground at 1.00. And the page took the app's `accentText` on trust, which in this
	// palette is a light tint of the accent rather than ink to sit on it: every selected chip
	// in the whole capp measured 1.83.
	const ratios = [].concat(pressed,
		await contrastIn('.pickr.on'), await contrastIn('.chip.on'), await contrastIn('.go'));
	const unresolved = ratios.filter(x => x.r == null);
	const worst = ratios.filter(x => x.r != null).sort((a, b) => a.r - b.r)[0];
	check('SELECTED SURFACES INVERT THEIR INK, EVERY ONE OF THEM',
		pressed.length >= 2 && ratios.length >= 8 && unresolved.length === 0
		&& !!worst && worst.r >= CONTRAST_MIN,
		ratios.length + ' surfaces (' + pressed.length + ' of them pressed), worst '
		+ JSON.stringify(worst)
		+ (unresolved.length ? ', unresolved: ' + JSON.stringify(unresolved.slice(0, 3)) : '')
		+ ' | ' + ratios.map(x => x.n + '=' + x.r).join(' '));

	await inFrame(() => {
		const b = document.querySelector('[data-a="padd"]');
		if (b) b.click();
	});
	await page.waitForTimeout(1800);
	const added = (await shardLines('gym')).filter(e => !gymWas.has(e.id) && e.id !== sessId);
	const g1 = await liveGroups();
	const names1 = g1.map(x => x.n).sort().join();
	check('THE PICKER TAKES SEVERAL AT ONCE AND ADDS EVERY ONE OF THEM',
		chose.on === 2 && chose.label === 'Add 2' && added.length === 2
		&& names1 === 'Back squat,Bench press',
		JSON.stringify(chose) + ' | disk: ' + added.length + ' | groups: ' + names1);
	check('AND THEY ARRIVE AS A PLAN, UNDER THIS SESSION, WITH NOTHING TICKED',
		added.every(e => e.p === 1 && e.of === sessId)
		&& g1.every(x => x.pend === 1 && x.green === 0),
		JSON.stringify(added.map(e => ({ p: e.p, of: e.of === sessId, f: e.f })))
		+ ' | ' + JSON.stringify(g1));

	// ── `prefill`: the same as last time, and never the same as a plan ──
	//
	// The last real squat was 110 x 3, three days back; the last real bench 85 x 4, yesterday.
	const valOf = (gs, n) => (gs.find(x => x.n === n) || { vals: [] }).vals;
	check('AND EACH OPENS ON THE LAST TIME THAT EXERCISE WAS REALLY DONE',
		valOf(g1, 'Back squat')[0] === '110x3' && valOf(g1, 'Bench press')[0] === '85x4',
		JSON.stringify(g1.map(x => x.n + ': ' + x.vals.join(' '))));

	// Something wrong typed into the bench row, and NOT ticked. A plan is not a record, so the
	// next row must still come from the last real one — otherwise one mistyped weight walks
	// down the whole exercise and the log fills with numbers nobody lifted.
	// GUARDED, every one of these. A break that removes a group must redden the check that
	// names it and nothing else: an exception here would abort the run and take every later
	// check with it, and a break whose damage is hidden behind `the run completed` has proved
	// only that the file stops when it throws.
	await inFrame(() => {
		const g = [...document.querySelectorAll('.grp')].find(x => /Bench press/.test(x.textContent));
		const ins = g ? [...g.querySelectorAll('.setin')] : [];
		if (ins.length >= 2) { ins[0].value = '60'; ins[1].value = '20'; }
	});
	await inFrame(() => {
		const g = [...document.querySelectorAll('.grp')].find(x => /Bench press/.test(x.textContent));
		const b = g && g.querySelector('[data-a="addset"]');
		if (b) b.click();
	});
	await page.waitForTimeout(1600);
	const g2 = await liveGroups();
	check('AND A ROW THAT IS ONLY A PLAN IS NOT WHAT THE NEXT ONE COPIES',
		valOf(g2, 'Bench press').length === 2 && valOf(g2, 'Bench press')[0] === '60x20'
		&& valOf(g2, 'Bench press')[1] === '85x4',
		JSON.stringify(g2.map(x => x.n + ': ' + x.vals.join(' '))));

	// ── The tick, the rest clock, and the ding that is scheduled rather than counted ──
	await inFrame(() => {
		const g = [...document.querySelectorAll('.grp')].find(x => /Bench press/.test(x.textContent));
		const b = g && g.querySelector('.setr.pend [data-a="tick"]');
		if (b) b.click();
	});
	await page.waitForTimeout(1500);
	const rest1 = await inFrame(() => ({
		bar: !!document.querySelector('.rest'),
		clock: (document.getElementById('rest') || {}).textContent || '',
		said: (document.querySelector('.rest .ts') || {}).textContent || '',
		green: document.querySelectorAll('.setr .tick.on').length,
	}));
	await shotP('lifelog-1280-dark-workout-rest', 0);
	await page.waitForTimeout(3400);
	const midClock = await inFrame(() => (document.getElementById('rest') || {}).textContent || '');
	// A DIFFERENT exercise. The rest is between one effort and the next, not between one
	// exercise and the next, and a clock that only restarted within a group would be green on
	// any check that ticked the same lift twice.
	await inFrame(() => {
		const g = [...document.querySelectorAll('.grp')].find(x => /Back squat/.test(x.textContent));
		const b = g && g.querySelector('.setr.pend [data-a="tick"]');
		if (b) b.click();
	});
	await page.waitForTimeout(1300);
	const rest2 = await inFrame(() => (document.getElementById('rest') || {}).textContent || '');
	check('THE REST CLOCK STARTS ON A TICK AND STARTS AGAIN ON THE NEXT, IN ANY EXERCISE',
		rest1.bar && rest1.green >= 1
		&& clockSecs(rest1.clock) >= 116 && clockSecs(rest1.clock) <= 120
		&& clockSecs(midClock) <= clockSecs(rest1.clock) - 2
		&& clockSecs(rest2) >= clockSecs(midClock) + 3 && clockSecs(rest2) >= 116,
		'first ' + rest1.clock + ' -> waited -> ' + midClock + ' -> other exercise -> ' + rest2);
	check('AND IT SAYS WHAT IT CANNOT PROMISE, rather than promising it',
		/may not ring/i.test(rest1.said), JSON.stringify(rest1.said));

	// ── Room for the numbers, on the screen that is all numbers ──
	//
	// This is the live screen, so every control this work added is on it at once: the weight
	// and rep boxes, the ticks, the clock, the chips and the Finish button. A box shorter
	// than its own type is invisible text that every value assertion above would still call
	// correct — the failure this check exists for, and the reason it measures the room rather
	// than reading the value back.
	const room = [].concat(await roomIn('.setin'), await roomIn('.tick'), await roomIn('.rt'),
		await roomIn('.chip.on'), await roomIn('.go'));
	const cramped = room.filter(x => x.room < x.fs || x.overW > 1 || x.overH > 1);
	check('AND EVERY CONTROL HAS MORE ROOM THAN ITS OWN TYPE NEEDS',
		room.length >= 8 && cramped.length === 0,
		room.length + ' controls measured, ' + cramped.length + ' cramped'
		+ (cramped.length ? ': ' + JSON.stringify(cramped.slice(0, 3)) : '')
		+ ' | tightest ' + JSON.stringify(room.slice().sort((a, b) => (a.room - a.fs) - (b.room - b.fs))[0]));

	// The ding cannot be a file under this policy, so it is synthesised — and it is SCHEDULED
	// on the audio clock two minutes out rather than fired by an interval, which is the only
	// version of it that survives a throttled tab. The offsets are the only place the
	// difference between the two shows at all.
	const au = await inFrame(() => window.__audio);
	check('AND THE DING IS SCHEDULED ON THE AUDIO CLOCK, NOT COUNTED DOWN BY A TIMER',
		au.ctx === 1 && au.osc >= 4 && au.when.length >= 4
		&& au.when.every(w => w >= 115 && w <= 125),
		JSON.stringify(au) + ' — one context opened on the press, tones due ~120s out');

	// ── The gap between two correct checks ──
	//
	// Each group heading is right, and each row is right, and the two of them together still
	// permit the session's own total to be something else entirely — a leaked scope, a
	// double-counted plan, a sum over the wrong set. So the three numbers are compared with
	// each other AND with arithmetic done here: 60 x 20 and 110 x 3, the two rows that were
	// actually ticked, and not one thing more.
	const DONE_VOL = 60 * 20 + 110 * 3;
	const g3 = await liveGroups();
	const bar3 = await inFrame(() => (document.querySelector('.scope .ts') || {}).textContent || '');
	const groupSum = g3.reduce((a, x) => a + numOf(x.vol), 0);
	const barVol = numOf(String(bar3).split('·')[1] || '');
	check('THE SESSION\'S TOTAL IS THE SUM OF ITS GROUPS AND OF NOTHING ELSE',
		groupSum === DONE_VOL && barVol === DONE_VOL,
		'groups ' + JSON.stringify(g3.map(x => x.n + '=' + x.vol)) + ' sum ' + groupSum
		+ ', scope bar ' + JSON.stringify(bar3) + ' -> ' + barVol + ', arithmetic ' + DONE_VOL);

	// ── A finish, and what the closed session then reads as ──
	await inFrame(() => {
		const b = document.querySelector('[data-a="finish"]');
		if (b) b.click();
	});
	await page.waitForTimeout(1700);
	const fin = await inFrame(() => ({
		scope: !!document.querySelector('.scope'),
		dates: !!document.querySelector('[data-a="off"]'),
		rows: [...document.querySelectorAll('.er .en')].map(x => x.firstChild.textContent),
		said: [...document.querySelectorAll('.er small')].map(x => x.textContent).join(' | '),
	}));
	const closed = (await shardLines('gym')).filter(e => e.id === sessId).pop();
	await shotP('lifelog-1280-dark-workout-done', 0);
	check('A FINISH CLOSES IT, AND NOTHING TYPED A DURATION ANYWHERE',
		!!closed && !!closed.end && (closed.f || {}).dur == null
		&& !fin.scope && fin.dates && fin.rows.includes('Morning')
		&& /2 logged/.test(fin.said) && /1 to do/.test(fin.said),
		JSON.stringify({ end: closed && closed.end, f: closed && closed.f }) + ' | '
		+ JSON.stringify(fin));

	// AND THE SAME LENGTH READ BACK THE ORDINARY WAY. The scope bar works out a running
	// session's length for itself, so it is green whether or not a CLOSED session's duration
	// falls out of its stamps — which is what the first version of this block missed: the
	// break that removes the derivation changed nothing at all and reported green. The
	// reading that actually needs it is the lane's own `dur` field in Life, where five
	// finished sessions have to add up without a single typed duration between them.
	await inFrame(() => document.querySelector('[data-a="view"][data-v="life"]').click());
	await page.waitForTimeout(800);
	await inFrame(() => document.querySelector('[data-a="per"][data-v="month"]').click());
	await page.waitForTimeout(1300);
	const gymLife = await inFrame(() => [...document.querySelectorAll('.st')]
		.map(x => x.querySelector('.sk').textContent + '=' + x.querySelector('.sv').textContent));
	const timeStat = (gymLife.find(x => /^Time=/.test(x)) || '=').split('=')[1];
	const mHM = /(?:(\d+)h)?\s*(?:(\d+)m)?/.exec(timeStat || '');
	const mins = timeStat && /\d/.test(timeStat) ? Number(mHM[1] || 0) * 60 + Number(mHM[2] || 0) : -1;
	check('AND EVERY FINISHED SESSION\'S LENGTH IS READ BACK FROM ITS STAMPS, NOT A FIELD',
		mins >= SESS_IN_MONTH * SESS_MIN && mins <= SESS_IN_MONTH * SESS_MIN + 2,
		'Time reads ' + JSON.stringify(timeStat) + ' = ' + mins + ' minutes; expected '
		+ SESS_IN_MONTH + ' x ' + SESS_MIN + ' plus the one just finished | ' + gymLife.join('  '));
	await inFrame(() => document.querySelector('[data-a="per"][data-v="day"]').click());
	await page.waitForTimeout(700);
	await inFrame(() => document.querySelector('[data-a="view"][data-v="log"]').click());
	await page.waitForTimeout(500);

	// The body lane, which is where `last`, `mean` and `since` are.
	await inFrame(() => document.querySelector('[data-a="lane"][data-v="body"]').click());
	await page.waitForTimeout(1200);
	// The readings are read back in LIFE now, which is the point of the axis: the body lane's
	// numbers are reporting and its four tiles are entry.
	await inFrame(() => document.querySelector('[data-a="view"][data-v="life"]').click());
	await page.waitForTimeout(900);
	const bodyStats = await inFrame(() => [...document.querySelectorAll('.st')]
		.map(x => x.querySelector('.sk').textContent + '=' + x.querySelector('.sv').textContent));
	// `last` on a word, `since` as an age, `sum` with a rollup on a duration: three aggregations
	// that a numeric-only reading would have shown as a dash.
	check('the body lane reads `last`, `since` and a duration rather than dashes',
		bodyStats.length === 5 && !bodyStats.some(x => /=—/.test(x)),
		bodyStats.join('  '));
	await shotP('lifelog-1280-dark-body', 0);

	// ── 4. A tap, and whether it reached the disk ──
	//
	// The fixture ALREADY contains `"src":"preset"` lines. Testing the file for that string is
	// green before the tap and green if the tile does nothing, which is what the first version of
	// this check did. So: the ids that were in the file, then the ids that are, and the
	// difference has to be exactly the coffee.
	await inFrame(() => document.querySelector('[data-a="lane"][data-v="diet"]').click());
	await page.waitForTimeout(1000);
	await inFrame(() => document.querySelector('[data-a="view"][data-v="log"]').click());
	await page.waitForTimeout(700);
	const before = await shardLines();
	const beforeIds = new Set(before.map(e => e.id));
	await inFrame(() => document.querySelector('[data-a="tile"][data-v="7"]').click());	// Coffee, a preset
	await page.waitForTimeout(1200);
	const after = await shardLines();
	const fresh = after.filter(e => !beforeIds.has(e.id));
	const kept = before.every((e, i) => after[i] && after[i].id === e.id
		&& JSON.stringify(after[i].f) === JSON.stringify(e.f));
	check('A TAP REACHES THE DISK as one new line and nothing else moves',
		fresh.length === 1 && fresh[0].src === 'preset' && fresh[0].f.food === 'coff'
		&& fresh[0].day === today && kept,
		'new: ' + JSON.stringify(fresh.map(e => ({ src: e.src, f: e.f })))
		+ ' | ' + before.length + ' -> ' + after.length + ' lines, earlier lines intact: ' + kept);
	await shotP('lifelog-1280-dark-tapped', 0);

	// ── 5. The scale tile: adjust, then log the ADJUSTED amount ──
	// Two presses of `+` on a tile whose default is 80 g and whose step is 10 g. A tile that
	// logged its default would give 80 and a tile that took one press would give 90, so the
	// number is the whole assertion.
	await inFrame(() => document.querySelector('[data-a="tile"][data-v="0"]').click());
	await page.waitForTimeout(400);
	await shotP('lifelog-1280-dark-scale', 0);
	const shown = await inFrame(() => {
		// Re-queried between clicks: the first one redraws and the element it was on is detached,
		// and a detached node's click never reaches the delegated listener on `document`.
		document.querySelectorAll('[data-a="amt"]')[1].click();
		document.querySelectorAll('[data-a="amt"]')[1].click();
		return document.querySelector('.amt').textContent;
	});
	await page.waitForTimeout(300);
	await inFrame(() => document.querySelector('[data-a="logscale"]').click());
	await page.waitForTimeout(1200);
	const scaled = (await shardLines()).filter(x => x.src === 'scale' && x.f && x.f.food === 'oats');
	check('A SCALE TILE LOGS THE ADJUSTED AMOUNT, not the tile\'s default',
		scaled.length === 1 && Number(scaled[0].f.g) === 100 && numOf(shown) === 100,
		'stepper showed ' + JSON.stringify(shown) + ', disk says '
		+ JSON.stringify(scaled.map(x => x.f.g)));

	// The form screen opens on the fields the tile names.
	await inFrame(() => {
		const t = document.querySelectorAll('[data-a="tile"]');
		t[t.length - 1].click();
	});
	await page.waitForTimeout(500);
	const form = await inFrame(() => ({
		labels: [...document.querySelectorAll('.fl')].map(x => x.textContent),
		commit: !!document.querySelector('[data-a="commit"]'),
	}));
	check('a form tile opens on the fields it names',
		form.commit && form.labels.some(x => /Amount/.test(x)) && form.labels.some(x => /Meal/.test(x)),
		form.labels.join(' | '));
	await shotP('lifelog-1280-dark-form', 0);
	await inFrame(() => document.querySelector('[data-a="back"]').click());
	await page.waitForTimeout(400);

	// ── 6. An edit, and a delete that leaves a tombstone ──
	// The rows are counted on the LOG screen, before the form covers it: the form draws no `.er`
	// at all, so counting from in there would compare 0 with 12 and pass for a reason that has
	// nothing to do with deleting anything.
	const rowsBefore = await inFrame(() => document.querySelectorAll('.er').length);
	await inFrame(() => document.querySelectorAll('[data-a="edit"]')[0].click());
	await page.waitForTimeout(500);
	await shotP('lifelog-1280-dark-edit', 0);
	const target = await inFrame(() => {
		const d = document.querySelector('[data-a="del"]');
		return d ? d.getAttribute('data-v') : '';
	});
	check('an entry opens in a form that can delete it', !!target, target);
	await inFrame(() => document.querySelector('[data-a="del"]').click());
	await page.waitForTimeout(1200);
	const tomb = (await shardLines()).filter(x => x.id === target && x.del);
	const rowsAfter = await inFrame(() => document.querySelectorAll('.er').length);
	check('A DELETE LEAVES A TOMBSTONE ON DISK AND THE ROW GOES',
		tomb.length === 1 && rowsAfter === rowsBefore - 1,
		'tombstones: ' + tomb.length + ', rows ' + rowsBefore + ' -> ' + rowsAfter);

	// ── 10. The +: a lane made from inside the page ──
	//
	// notes6 item 1. A lane is this capp's primitive, three arrived furnished, and there was no
	// way to make a fourth. What is asserted is not that a screen opened. It is that the lane
	// reached the DISK coherent, that it arrived with something to press, that pressing it put a
	// line in that lane's OWN shard, and that Life read the line back. A lane you cannot log into
	// is the failure this block exists to catch, and it is the one the owner would meet first.
	const lanesBefore = (await jsonAt('index.json')).lanes.slice();
	await inFrame(() => document.querySelector('[data-a="lanenew"]').click());
	await page.waitForTimeout(600);
	await shotP('lifelog-1280-dark-newlane', 0);
	const builder = await inFrame(() => ({
		name: !!document.querySelector('[data-lin="n"]'),
		types: [...document.querySelectorAll('[data-a="ftype"]')].map(x => x.getAttribute('data-v')),
		save: !!document.querySelector('[data-a="lanesave"]'),
	}));
	const idxOpen = await jsonAt('index.json');
	check('THE + OPENS A LANE BUILDER, and opening it has written nothing',
		builder.name && builder.save
		&& ['num', 'dur', 'enum', 'bool', 'text'].every(t => builder.types.includes('0|' + t))
		&& idxOpen.lanes.join() === lanesBefore.join(),
		builder.types.join(' ') + ' | index: ' + idxOpen.lanes.join());

	// Named but with no field in it. A lane with no fields draws nothing and logs nothing, so
	// this must not become one — and it must say which of the two things is missing rather than
	// doing nothing and leaving the person pressing.
	await inFrame(() => { document.querySelector('[data-lin="n"]').value = 'Reading'; });
	await inFrame(() => document.querySelector('[data-a="lanesave"]').click());
	await page.waitForTimeout(1000);
	const refused = await inFrame(() => ({
		still: !!document.querySelector('[data-a="lanesave"]'),
		said: [...document.querySelectorAll('.hint, .toast')].map(x => x.textContent).join(' | '),
	}));
	const idxEmpty = await jsonAt('index.json');
	check('AN EMPTY LANE IS REFUSED, and the screen says what is missing',
		idxEmpty.lanes.join() === lanesBefore.join() && refused.still
		&& /at least one field/i.test(refused.said),
		'index: ' + idxEmpty.lanes.join() + ' | said: ' + refused.said.slice(0, 100));

	// A number with a unit, and a yes/no — between them they cover the two things a made lane
	// has to get right: something to add up, and something to tap.
	await inFrame(() => { document.querySelector('[data-lin="0.n"]').value = 'Pages'; });
	await inFrame(() => { document.querySelector('[data-lin="0.u"]').value = 'pages'; });
	// A daily target, because the bar and the tick beside a number in Life are the whole of what
	// "reporting" means to somebody keeping a log, and they come from here.
	await inFrame(() => { document.querySelector('[data-lin="0.tv"]').value = '20'; });
	await inFrame(() => document.querySelector('[data-a="fadd"]').click());
	await page.waitForTimeout(600);
	await inFrame(() => { document.querySelector('[data-lin="1.n"]').value = 'Finished a book'; });
	await inFrame(() => document.querySelector('[data-a="ftype"][data-v="1|bool"]').click());
	await page.waitForTimeout(600);
	await shotP('lifelog-1280-dark-newlane-filled', 0);
	await inFrame(() => document.querySelector('[data-a="lanesave"]').click());
	await page.waitForTimeout(2000);

	const made = await jsonAt('lanes/reading.json');
	const idxAfter = await jsonAt('index.json');
	const mf = (made && made.fields) || [];
	const pages = mf.find(f => f.k === 'pages'), finished = mf.find(f => f.t === 'bool');
	const tgt = ((made && made.targets) || []).find(t => t.f === 'pages');
	check('A LANE MADE FROM THE PAGE REACHES THE DISK, and points at nothing that is not there',
		!!made && idxAfter.lanes.includes('reading')
		&& !!pages && pages.t === 'num' && pages.u === 'pages' && pages.agg === 'sum'
		&& !!finished && finished.n === 'Finished a book'
		&& !!tgt && tgt.p === 'day' && tgt.dir === 'min' && tgt.v === 20
		&& laneComplaints(made).length === 0,
		JSON.stringify({ lanes: idxAfter.lanes, fields: mf.map(f => f.k + ':' + f.t), target: tgt,
			complaints: made ? laneComplaints(made) : ['no file at all'] }));

	const padNow = await inFrame(() => ({
		on: (document.querySelector('[data-a="lane"].on') || { textContent: '' }).textContent,
		tiles: [...document.querySelectorAll('.pad .tile .tn')].map(x => x.textContent),
	}));
	check('IT ARRIVES WITH TILES TO PRESS, on the lane the page has switched to',
		padNow.on === 'Reading' && padNow.tiles.includes('Finished a book')
		&& padNow.tiles.includes('New entry'), JSON.stringify(padNow));

	const tapped = await inFrame(() => {
		const t = [...document.querySelectorAll('.pad .tile')]
			.find(x => /Finished a book/.test(x.textContent));
		if (!t) return false;
		t.click(); return true;
	});
	await page.waitForTimeout(1600);
	const readingLines = await shardLines('reading');
	check('AND PRESSING ONE PUTS A LINE IN THAT LANE\'S OWN SHARD',
		tapped && readingLines.length === 1 && readingLines[0].f.finished_a_book === true
		&& readingLines[0].day === today && readingLines[0].src === 'tap',
		JSON.stringify(readingLines.map(e => ({ src: e.src, day: e.day, f: e.f }))));

	await inFrame(() => document.querySelector('[data-a="view"][data-v="life"]').click());
	await page.waitForTimeout(1000);
	const newLife = await inFrame(() => [...document.querySelectorAll('.st')]
		.map(x => x.querySelector('.sk').textContent + '=' + x.querySelector('.sv').textContent));
	await shotP('lifelog-1280-dark-newlane-life', 0);
	check('AND LIFE READS THE NEW LANE BACK: the tap counted, not a dash',
		newLife.some(x => /^Finished a book=1/.test(x)), newLife.join('  '));

	// ── The edit that must not eat the lanes that ship ──
	//
	// The screen has no vocabulary for a catalogue, a `ref` that reads one, or a field computed
	// from a formula — and the diet lane is made of all three. So an edit through it is a PATCH:
	// what it cannot show it carries, and the field it adds is reachable from the pad the same
	// day. Without this the `+` would be a way to flatten the three lanes that arrive furnished.
	await inFrame(() => document.querySelector('[data-a="lane"][data-v="diet"]').click());
	await page.waitForTimeout(1200);
	const dietBefore = await jsonAt('lanes/diet.json');
	await inFrame(() => document.querySelector('[data-a="laneedit"]').click());
	await page.waitForTimeout(700);
	const editRows = await inFrame(() => [...document.querySelectorAll('.fbox input')]
		.filter(x => /\.n$/.test(x.getAttribute('data-lin'))).map(x => x.value));
	check('the builder offers the fields it can show and leaves the rest alone',
		editRows.includes('Meal') && editRows.includes('Amount')
		&& !editRows.includes('Food') && !editRows.includes('Energy'), editRows.join(' | '));
	await inFrame(() => document.querySelector('[data-a="fadd"]').click());
	await page.waitForTimeout(600);
	await inFrame((i) => { document.querySelector('[data-lin="' + i + '.n"]').value = 'Water'; },
		editRows.length);
	await inFrame((i) => { document.querySelector('[data-lin="' + i + '.u"]').value = 'ml'; },
		editRows.length);
	await shotP('lifelog-1280-dark-laneedit', 0);
	await inFrame(() => document.querySelector('[data-a="lanesave"]').click());
	await page.waitForTimeout(2000);
	const dietAfter = await jsonAt('lanes/diet.json');
	const fkeys = (l) => ((l && l.fields) || []).map(f => f.k);
	const tnames = (l) => ((l && l.tiles) || []).map(t => t.n);
	const kcal = ((dietAfter && dietAfter.fields) || []).find(f => f.k === 'kcal');
	const amount = ((dietAfter && dietAfter.fields) || []).find(f => f.k === 'g');
	const genForm = ((dietAfter && dietAfter.tiles) || []).find(t => t.gen && t.m === 'form');
	check('AN EDIT KEEPS WHAT THE DAIMON WROTE, and the field it adds is usable that day',
		!!kcal && !!kcal.d && kcal.d.c === 'food' && kcal.d.per === 100
		&& fkeys(dietAfter).includes('food') && dietAfter.primary === 'food'
		&& !!amount && amount.step === 10
		&& tnames(dietBefore).every(nm => tnames(dietAfter).includes(nm))
		&& fkeys(dietAfter).includes('water') && (dietAfter.show || []).includes('water')
		&& !!genForm && genForm.fs.includes('water')
		&& laneComplaints(dietAfter).length === 0,
		JSON.stringify({ fields: fkeys(dietAfter), kcal: kcal && kcal.d, step: amount && amount.step,
			tiles: tnames(dietAfter), complaints: laneComplaints(dietAfter) }));

	// ── Light ink, and the warm skin ──
	await page.evaluate(() => window.DaimondTheme && window.DaimondTheme.set('light'));
	await page.waitForTimeout(1200);
	await shotP('lifelog-1280-light-log', 0);
	await shot('lifelog-1280-light-whole');
	// A `data` message arrives on every theme change, and the page must be idempotent under it:
	// still up, still on the diet lane, still showing the same rows.
	const afterInk = await page.evaluate(() => ({
		up: !!document.querySelector('.crystal-frame'),
		fell: !!document.querySelector('.crystal-fallback-note'),
	}));
	check('a theme change re-sends `data` and the page survives it',
		afterInk.up && !afterInk.fell, JSON.stringify(afterInk));
	await inFrame(() => document.querySelector('[data-a="view"][data-v="life"]').click());
	await page.waitForTimeout(700);
	await shotP('lifelog-1280-light-charts', 560);
	await inFrame(() => document.querySelector('[data-a="view"][data-v="log"]').click());
	await page.waitForTimeout(400);

	// A lane takes longer to describe than an entry does, and `data` arrives again on every
	// theme, ink and skin change — so the redraw those force must not type over what is being
	// written. Same property as the half-filled entry form, on the screen where it costs most.
	await inFrame(() => document.querySelector('[data-a="lanenew"]').click());
	await page.waitForTimeout(500);
	await inFrame(() => { document.querySelector('[data-lin="n"]').value = 'Half typed'; });
	await page.evaluate(() => window.DaimondTheme && window.DaimondTheme.set('dark'));
	await page.waitForTimeout(1400);
	const stillThere = await inFrame(() => {
		const i = document.querySelector('[data-lin="n"]');
		return i ? i.value : '(the builder is not even up)';
	});
	check('A HALF-BUILT LANE SURVIVES THE REDRAW A THEME CHANGE FORCES',
		stillThere === 'Half typed', JSON.stringify(stillThere));
	await inFrame(() => document.querySelector('[data-a="back"]').click());
	await page.waitForTimeout(400);

	// THE REDRAW NOBODY ASKED FOR, and the one that actually bit: a toast clears itself six
	// seconds after it appeared and redraws the page from state. Anything typed since and not yet
	// read back out of the DOM is gone. This is not hypothetical — the first run of the block
	// above lost the `Water` field exactly this way, and the entry form had carried the same
	// fault since it was written. So the toast is started first and nothing is clicked after the
	// typing, because a click of any kind is what used to rescue it.
	await inFrame(() => document.querySelector('[data-a="tile"][data-v="7"]').click());	// Coffee
	await page.waitForTimeout(700);
	await inFrame(() => document.querySelector('[data-a="lanenew"]').click());
	await page.waitForTimeout(400);
	await inFrame(() => { document.querySelector('[data-lin="n"]').value = 'Typed while a toast was up'; });
	await page.waitForTimeout(6800);
	const survived = await inFrame(() => {
		const i = document.querySelector('[data-lin="n"]');
		return i ? i.value : '(the builder is not even up)';
	});
	check('AND SO DOES THE REDRAW A TOAST FORCES WHEN IT CLEARS ITSELF',
		survived === 'Typed while a toast was up', JSON.stringify(survived));
	await inFrame(() => document.querySelector('[data-a="back"]').click());
	await page.waitForTimeout(400);
	await page.evaluate(() => window.DaimondTheme && window.DaimondTheme.set('light'));
	await page.waitForTimeout(1000);

	// ── The phone ──
	await mount(375, 812);
	await shotP('lifelog-375-light-log', 0);
	await shot('lifelog-375-light-whole');
	await page.evaluate(() => window.DaimondTheme && window.DaimondTheme.set('dark'));
	await page.waitForTimeout(1200);
	await shotP('lifelog-375-dark-log', 0);
	await shotP('lifelog-375-dark-log-2', 560);
	const narrow = await inFrame(() => ({
		wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
		w: document.documentElement.clientWidth,
		cols: getComputedStyle(document.querySelector('.pad')).gridTemplateColumns.split(' ').length,
	}));
	check('the phone width does not scroll sideways', !narrow.wide, JSON.stringify(narrow));
	// AND THE SWITCH IS ALL THERE. `scrollWidth` cannot see this one: the lane chips live in a
	// scroller, and anything clipped INSIDE a scroller leaves the page's own width untouched. At
	// 375px with four lanes the switch was half off the right edge and every other check was
	// green. So the assertion is the button's own rectangle against the page's width.
	const swi = await inFrame(() => {
		const r = { w: document.documentElement.clientWidth };
		['log', 'life'].forEach(v => {
			const el = document.querySelector('[data-a="view"][data-v="' + v + '"]');
			r[v] = el ? Math.round(el.getBoundingClientRect().right) : -1;
		});
		return r;
	});
	check('THE LOG/LIFE SWITCH IS WHOLLY ON THE SCREEN AT PHONE WIDTH',
		swi.log > 0 && swi.life > 0 && swi.life <= swi.w, JSON.stringify(swi));
	await inFrame(() => document.querySelector('[data-a="view"][data-v="life"]').click());
	await page.waitForTimeout(900);
	await shotP('lifelog-375-dark-charts', 520);

	// The builder is the widest thing on the page — an input, five type chips, four aggregation
	// chips and a target — and a phone is where it will be used. The rest of the page is held to
	// not scrolling sideways; so is this.
	await inFrame(() => document.querySelector('[data-a="lanenew"]').click());
	await page.waitForTimeout(600);
	await shotP('lifelog-375-dark-newlane', 0);
	const buildNarrow = await inFrame(() => ({
		wide: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
		box: document.querySelector('.fbox').getBoundingClientRect().width,
		w: document.documentElement.clientWidth,
	}));
	check('the lane builder does not scroll sideways on a phone',
		!buildNarrow.wide && buildNarrow.box <= buildNarrow.w, JSON.stringify(buildNarrow));
	await inFrame(() => document.querySelector('[data-a="back"]').click());
	await page.waitForTimeout(400);

	// Back to Log, because a session is opened from an entry row and there are no rows in Life.
	// Without this the shot below was taken on the charts and labelled `session`.
	await inFrame(() => document.querySelector('[data-a="view"][data-v="log"]').click());
	await page.waitForTimeout(500);
	await inFrame(() => document.querySelector('[data-a="lane"][data-v="gym"]').click());
	await page.waitForTimeout(1000);
	await inFrame(() => {
		const r = document.querySelector('[data-a="sess"]');
		if (r) r.click();
	});
	await page.waitForTimeout(700);
	await shotP('lifelog-375-dark-session', 0);

	// The skin changes the radii and the typeface under the page. It is not reloaded for it: the
	// app re-sends `data` on the attribute change and the page has to follow, live.
	//
	// BOTH WAYS, and starting from `sharp` rather than ending at `warm`. A fresh account has no
	// stored view, so `initView` gives it `simple`, and `setView` gives Simple the WARM skin —
	// so a run that only ever set 'warm' was setting what was already there and comparing a
	// value with itself. It read 14px -> 14px and reported the page as not following.
	const rd = () => inFrame(() => getComputedStyle(document.documentElement)
		.getPropertyValue('--rd').trim());
	await page.evaluate(() => window.DaimondSkin.set('sharp'));
	await page.waitForTimeout(1400);
	const rdSharp = await rd();
	await page.evaluate(() => window.DaimondSkin.set('warm'));
	await page.waitForTimeout(1400);
	const rdWarm = await rd();
	// The app's own shape tokens (variables.css): 8px sharp, 14px warm. Asserted as the values
	// and not merely as a difference, so a page that echoed any two strings would not pass.
	check('THE PAGE FOLLOWS A LIVE SKIN CHANGE, IN BOTH DIRECTIONS',
		rdSharp === '8px' && rdWarm === '14px', 'sharp:' + rdSharp + ' warm:' + rdWarm);
	await shotP('lifelog-375-dark-warm', 0);

	// The 502s are the account service, which no world has; they say nothing about the page.
	const errs = errors(s).filter(e => !/502|account/i.test(e));
	check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('the run completed', false, String((e && e.stack) || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must:\n  ${bad.join('\n  ')}`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
