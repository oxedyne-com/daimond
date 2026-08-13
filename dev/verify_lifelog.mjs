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
		find: "\treturn pad() + toastBar()",
		with: "\treturn pad() + stats() + charts() + toastBar()",
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
		find: "\tvar ps = [save('lanes/' + l.id + '.json', JSON.stringify(l), 'replace')];",
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
// Distinct foods eaten today, which is what the pie has to split up. Eleven of them, and the
// page's rule is that a ninth series is never a ninth hue: seven, then a neutral Other.
const TODAY_FOODS = new Set(diet.filter(e => e.day === ymd(new Date())).map(e => e.f.food));
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
for (const [back, name, sets] of PLAN) {
	const s = ent(back, 18, 0, { name, dur: 62 * 60 }, 'tap');
	gym.push(s);
	sets.forEach(([lift, kg, reps], i) => {
		gym.push(ent(back, 18, 4 + i * 6, { lift, kg, reps }, 'form', s.id));
	});
}
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

	// The body lane, which is where `last`, `mean` and `since` are.
	await inFrame(() => document.querySelector('[data-a="back"]').click());
	await page.waitForTimeout(300);
	await inFrame(() => document.querySelector('[data-a="now"]').click());
	await page.waitForTimeout(500);
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

	const pressed = await inFrame(() => {
		const t = [...document.querySelectorAll('.pad .tile')]
			.find(x => /Finished a book/.test(x.textContent));
		if (!t) return false;
		t.click(); return true;
	});
	await page.waitForTimeout(1600);
	const readingLines = await shardLines('reading');
	check('AND PRESSING ONE PUTS A LINE IN THAT LANE\'S OWN SHARD',
		pressed && readingLines.length === 1 && readingLines[0].f.finished_a_book === true
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
