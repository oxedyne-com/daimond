// verify_checkreach -- every runnable file in `dev/` is either in the gate or says why not.
//
// WHY THIS EXISTS. `dev/run_all.sh` built its work list as `ls verify_*.mjs`, and a list built
// from a pattern omits whatever does not match it, silently. That one line cost more than any
// other fault in this repository:
//
//   * THE GATE HAD NEVER RUN A SINGLE RUST TEST. Not one, in any release this project has
//     made -- the "269 passed of 277" that seq 150 shipped on was browser verifiers
//     exclusively, and so was every release before it.
//   * `dev/verify_walkbound.sh`, a verifier by name, the only `.sh` among 281 `verify_*`
//     files: never run, confirmed absent from all forty `suite.log` files on disk.
//   * `dev/jscheck.sh`, the ONLY gate on whether the browser JavaScript parses at all -- it
//     exists because `node --check` exits 0 on a `.js` file holding a syntax error -- absent
//     from the same forty logs.
//   * `jscheck.sh`'s own `ls www/js/*.js`, which could not see the eight locale tables, the
//     files most often edited eight at a time. Against a tree with an unescaped apostrophe in
//     `www/i18n/fr.js` it answered `jscheck: 61 file(s) parse.`
//   * `NEEDS_GRANT`, a hand-kept list of two names that could not see `verify_sync`'s
//     identity: 37 failed / 68 passed in every gate, on an account that never held Pro.
//
// Six instances in two days, which is what makes it a shape and not six bugs, and Lane T
// stated the rule in one sentence: **a list built by a glob needs asking what it cannot see,
// not just what it returns.** This file is that question, made into a check.
//
// THE INVERSION IS THE WHOLE FIX. A pattern's default is invisible; this file's default is
// red. It does not ask "which files look like checks" -- that is a pattern again, one level
// up, and it would lose the next `verify_walkbound.sh` exactly as `ls verify_*.mjs` lost the
// last one. It enumerates EVERY file in `dev/`, asks git rather than the filesystem, and
// requires each one to land in exactly one of two places:
//
//   1. REACHABLE from `dev/run_all.sh`, following the files it names and the files those
//      name, or
//   2. REGISTERED in `dev/CHECKS.md` with a written reason it is not in the gate.
//
// A file in neither fails this check by name. A new `assert_thing.mjs` that nobody wired up
// goes red the day it is written, whatever it is called.
//
// AND IT IS CHECKED IN BOTH DIRECTIONS, because a register is a hand-kept list and this
// repository has learned what those do. A row naming a file that no longer exists fails; a
// row naming a file that IS in the gate fails, because it is then a false sentence about the
// gate. The register cannot rot in either direction while this runs.
//
// WHAT THIS CANNOT SEE, answered plainly, because an unqualified answer here would be the
// very fault the file is about:
//
//   * ONLY `dev/`. A check living anywhere else is outside its reach. The Rust tests are the
//     large case, and they have their own instrument one directory over: `dev/testcount.mjs`
//     asks each harness `--list` for the number of tests compiled into it and refuses to call
//     a run a pass unless that many executed. Between the two, "compiled but never run" is
//     covered for Rust and "written but never run" for `dev/`. Nothing covers `verify/`,
//     `ext/` or `hand/` the same way.
//   * REACHABLE IS NOT EXECUTED. This proves a file is WIRED INTO something the suite runs.
//     It does not prove the suite reaches the code inside it, and it cannot: `verify_conformance`
//     is reachable and skips whenever no forge is up. Whether a check has ever been seen to
//     fail is a different question and `dev/breakcheck.mjs` is the instrument for it.
//   * EDGES ARE STATIC TEXT. A file named through a variable -- `node "dev/$name.mjs"` -- is
//     not followed, except for the one form the suite's own work list uses, which is seeded
//     below. That errs toward calling a file unreachable, which is the safe direction: the
//     cost is a register row, not a hole. It errs the other way only through a transitive
//     edge, where naming a file is taken for running it: `dev/publish.mjs` counts as reachable
//     because `dev/deploy.sh` runs it and `verify_deploy` runs `deploy.sh --check-fresh`,
//     which never gets as far as publishing. The report prints the path it followed for every
//     such file, so the claim can be read rather than trusted.
//   * IGNORED FILES ARE INVISIBLE. `--exclude-standard` means `.gitignore` decides, so
//     `dev/audit_*.mjs` and `dev/*.log` are outside the roster by the same rule that keeps
//     build output out of it. A check hidden under an ignored name would not be seen.
//
//   node dev/verify_checkreach.mjs            # the assertions, and a summary
//   node dev/verify_checkreach.mjs --list     # every file, with its bucket and its path in
import fs		from 'node:fs';
import path		from 'node:path';
import { execFileSync }	from 'node:child_process';

const HERE	= path.dirname(new URL(import.meta.url).pathname);
const ROOT	= path.resolve(HERE, '..');
const LIST	= process.argv.includes('--list');

// Extensions that hold a program. A file with any of these, or with a `#!`, is runnable.
const RUNNABLE	= new Set(['mjs', 'js', 'sh', 'py']);
// Extensions that hold data, and are therefore not anybody's check.  THIS LIST IS HALF THE
// POINT: an extension on neither list is a file nobody has classified, and it fails below
// rather than being skipped, which is what stops the definition of "check file" from being
// one more pattern with a silent outside.
const INERT	= new Set(['md', 'json', 'jsonl', 'txt', 'bin', 'typ', 'xlsx', 'ttf', 'otf',
			'svg', 'png', 'jpg', 'webp', 'pdf', 'csv', 'html', 'css', 'jdat', 'toml',
			'lock', 'yml', 'yaml', 'log', 'zip', 'docx', 'xml', 'wasm',
			// A diff is data. `git apply` runs it, in the sense that a `.json` is run by
			// whatever reads it, but nothing in dev/ can be reached THROUGH one, so it is
			// no more a check than a fixture is.
			'patch']);

const fails	= [];
const oks	= [];
function ok(msg)   { oks.push(msg);   console.log(`  ok   ${msg}`); }
function bad(msg)  { fails.push(msg); console.log(`  FAIL ${msg}`); }

// ── The roster: asked of git, and never of a glob ───────────────────────────
//
// `--cached` is everything tracked; `--others --exclude-standard` is everything else that is
// not ignored. A file written this minute and never added is in it. A glob over the working
// tree would sweep in build output; a glob over `git ls-files` alone would miss the file
// somebody has just written, which is precisely the file most likely to be an unwired check.
let roster;
try {
	roster = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others',
		'--exclude-standard', '--', 'dev'], { encoding: 'utf8' })
		.split('\n').filter(Boolean);
} catch (e) {
	console.log(`  FAIL git could not list dev/: ${e.message}`);
	console.log('\n0 ok, 1 failed — and a fallback glob would be the fault this file exists to catch.');
	process.exit(1);
}

/// Does this file hold a program, rather than data?  Extension first, then the first two bytes.
function isRunnable(rel) {
	const ext = extOf(rel);
	if (ext && RUNNABLE.has(ext)) return true;
	try {
		const fd = fs.openSync(path.join(ROOT, rel), 'r');
		const b = Buffer.alloc(2);
		fs.readSync(fd, b, 0, 2, 0);
		fs.closeSync(fd);
		return b.toString('latin1') === '#!';
	} catch { return false; }
}
function extOf(rel) {
	const name = rel.slice(rel.lastIndexOf('/') + 1);
	const dot  = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

const runnable	= roster.filter(isRunnable);
const runSet	= new Set(runnable);
const byName	= new Map();
for (const p of runnable) byName.set(p.slice(p.lastIndexOf('/') + 1), p);

// ── The graph ───────────────────────────────────────────────────────────────
//
// An edge is one file naming another IN A POSITION WHERE SOMETHING RUNS IT: after `bash`,
// `sh`, `node` or `source`; inside a `spawn`, `execFile`, `fork`, `execSync` or `path.join`;
// as the target of an `import`, a `require` or a `from`; or on the right of a shell variable
// assignment, which is how `run_all.sh` names `dev/smtpd.mjs`.
//
// Comment lines are dropped, and so are lines whose business is to PRINT a filename rather
// than run it -- `say`, `echo`, `console.log`, and the continuation lines of an assembled
// message. Without that, `run_all.sh`'s own header, which names five other scripts while
// explaining why lists go stale, would make all five look wired in.
const CALLS	= /(?:^|[\s;&|("'])(?:bash|sh|node|python3?|source|\.)\s|\bspawn|\bexecFile|\bfork\(|\bexecSync|path\.join|\brequire\(|\bimport\(|\bfrom\s+['"]|^[A-Za-z_][A-Za-z0-9_]*=/;
const PRINTS	= /^\s*(say|echo)\b|console\.(log|error|warn)|^\s*\+/;
const COMMENT	= /^\s*(#|\/\/|\*|\/\*)/;
const NAMED	= /([A-Za-z0-9_.-]+\.(?:mjs|js|sh|py))\b/g;

function edgesOf(rel) {
	const out = new Set();
	let text;
	try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return out; }
	for (const line of text.split('\n')) {
		if (COMMENT.test(line) || PRINTS.test(line) || !CALLS.test(line)) continue;
		for (const m of line.matchAll(NAMED)) {
			const target = byName.get(m[1]);
			if (target && target !== rel) out.add(target);
		}
	}
	return out;
}

// THE SEEDS ARE READ OUT OF `dev/run_all.sh`, NOT RESTATED HERE.
//
// The first draft of this file listed phase 0's five static checks by name, and that draft
// could not have caught its own subject: delete `static_one jscheck` from the gate and the
// hand-kept list here would have gone on calling jscheck reachable. A checker for hand-kept
// lists, kept by hand. So the only seed is the gate itself, and everything it runs is found
// by following what it NAMES -- `static_one jscheck  bash dev/jscheck.sh` is an edge like any
// other, and a phase-0 line that is deleted stops being one.
//
// One construction cannot be followed that way, because it is a glob the shell expands rather
// than a name: `ALL=$(cd dev && ls verify_*.mjs | ...)`, with `refluxduo` appended beside it.
// That is read as a form and asserted below -- if the work list stops being built this way,
// this file says so and fails, rather than quietly seeding nothing.
const GLOB	= /^dev\/verify_[A-Za-z0-9_]+\.mjs$/;
const gateText	= fs.readFileSync(path.join(ROOT, 'dev/run_all.sh'), 'utf8');
const usesGlob	= /\bls\s+verify_\*\.mjs\b/.test(gateText);
const appended	= [...gateText.matchAll(/^\s*ALL="\$ALL\s+([A-Za-z0-9_]+)"/gm)].map(m => `dev/${m[1]}.mjs`);
const SEEDS	= [
	'dev/run_all.sh',
	...(usesGlob ? runnable.filter(p => GLOB.test(p)) : []),
	...appended,
];

const via	= new Map();
const seen	= new Set();
const queue	= [];
for (const s of SEEDS) { via.set(s, 'the work list in dev/run_all.sh'); queue.push(s); }
while (queue.length) {
	const p = queue.shift();
	if (seen.has(p) || !runSet.has(p)) continue;
	seen.add(p);
	for (const e of edgesOf(p)) {
		if (seen.has(e) || via.has(e)) continue;
		via.set(e, p);
		queue.push(e);
	}
}

// ── The register ────────────────────────────────────────────────────────────
//
// One row per file, and the path is the first backticked thing on the row. Prose around the
// rows is for the reader; only the rows are read here.
const REGISTER	= 'dev/CHECKS.md';
const registered = new Map();
let regText = '';
try { regText = fs.readFileSync(path.join(ROOT, REGISTER), 'utf8'); } catch { /* handled below */ }
for (const line of regText.split('\n')) {
	if (!line.startsWith('|')) continue;
	const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
	if (m) registered.set(m[1], line.split('|')[2]?.trim() ?? '');
}

// ── The checks ──────────────────────────────────────────────────────────────
console.log(`dev/ holds ${roster.length} files, of which ${runnable.length} are runnable.`);
console.log(`${seen.size} are reachable from dev/run_all.sh; ${registered.size} rows in ${REGISTER}.\n`);

// 1. A checker that enumerates nothing must not report a pass. `git ls-files` answers with
//    silence and exit 0 from a directory that is not a repository, and silence read as a
//    green is this whole blocker in one line.
if (roster.length > 0 && runnable.length > 0 && roster.includes('dev/run_all.sh')) {
	ok(`the roster came from git and holds dev/run_all.sh — ${roster.length} files`);
} else {
	bad('git listed no dev/ files, or not dev/run_all.sh. An empty enumeration is not a pass.');
}

// 2. The work list is still built the way this file knows how to read. A gate that stopped
//    globbing `verify_*.mjs` would leave every one of them unseeded, and 281 orphans would
//    read as an avalanche rather than as the one thing that actually changed.
if (usesGlob) {
	ok(`dev/run_all.sh still builds its work list from \`ls verify_*.mjs\`, plus ${appended.length ? appended.join(', ') : 'nothing'}`);
} else {
	bad('dev/run_all.sh no longer builds its work list from `ls verify_*.mjs`. Teach this file the '
		+ 'new form before reading anything below it — with no seeds, every verifier looks orphaned.');
}

// 3. Every file the suite's OWN glob matches must come out reachable. If it does not, the
//    graph below is broken and every other answer on this page is worthless.
const globbed	= runnable.filter(p => GLOB.test(p));
const globMiss	= globbed.filter(p => !seen.has(p));
if (globMiss.length === 0) {
	ok(`all ${globbed.length} verify_*.mjs the gate's own glob matches are reachable`);
} else {
	bad(`${globMiss.length} verify_*.mjs are not reachable, so the graph is wrong: ${globMiss.slice(0, 5).join(', ')}`);
}

// 4. Every extension in dev/ is classified. An unknown one is a file nobody has decided
//    about, and deciding by silence is the fault.
const unknownExt = new Map();
for (const p of roster) {
	const ext = extOf(p);
	if (RUNNABLE.has(ext) || INERT.has(ext)) continue;
	if (isRunnable(p)) continue;                    // a shebang settled it
	if (!unknownExt.has(ext)) unknownExt.set(ext, []);
	unknownExt.get(ext).push(p);
}
if (unknownExt.size === 0) {
	const kinds = [...new Set(roster.map(extOf))].sort().join(' ');
	ok(`every extension in dev/ is classified as a program or as data — ${kinds}`);
} else {
	for (const [ext, files] of unknownExt) {
		bad(`.${ext} is on neither the runnable nor the inert list, so ${files.length} file(s) `
			+ `were skipped without a decision: ${files.slice(0, 3).join(', ')}. Add the extension to `
			+ 'RUNNABLE or INERT in dev/verify_checkreach.mjs.');
	}
}

// 5. THE CHECK THIS FILE IS FOR.
const orphans = runnable.filter(p => !seen.has(p) && !registered.has(p));
if (orphans.length === 0) {
	ok(`every runnable file in dev/ is in the gate or in ${REGISTER} — ${seen.size} + ${runnable.length - seen.size}`);
} else {
	bad(`${orphans.length} runnable file(s) in dev/ are in neither the gate nor ${REGISTER}:`);
	for (const p of orphans) console.log(`         ${p}`);
	console.log(`       Wire each into dev/run_all.sh, or add a row to ${REGISTER} saying why not.`);
}

// 6. The register cannot name a file that is gone.
//
// ASKED OF THE DISK, not of the roster. `git ls-files --cached` still names a tracked file
// that has been deleted from the working tree, so testing against the roster made this check
// inert until somebody ran `git rm` -- which is to say, inert during exactly the window in
// which a row goes stale. It was proved by moving `dev/shot_badge.mjs` aside, and it stayed
// green.
const ghosts = [...registered.keys()].filter(p => !fs.existsSync(path.join(ROOT, p)));
if (ghosts.length === 0) {
	ok(`every one of the ${registered.size} rows in ${REGISTER} names a file that is on disk`);
} else {
	bad(`${ghosts.length} row(s) in ${REGISTER} name files that are gone: ${ghosts.join(', ')}`);
}

// 7. Nor a file that is in the gate. A row saying "the gate does not run this" about something
//    the gate runs is a false sentence about the gate, and the next reader believes it.
const liars = [...registered.keys()].filter(p => seen.has(p));
if (liars.length === 0) {
	ok(`no row in ${REGISTER} claims a file is outside the gate that the gate reaches`);
} else {
	bad(`${liars.length} row(s) in ${REGISTER} name files the gate DOES reach: ${liars.join(', ')}. Delete the rows.`);
}

// 8. And the register must not name a file that is not runnable, which would mean the row was
//    written about something this check would never have asked about in the first place.
const inertRows = [...registered.keys()].filter(p => roster.includes(p) && !runSet.has(p));
if (inertRows.length === 0) {
	ok(`every row in ${REGISTER} names a runnable file`);
} else {
	bad(`${inertRows.length} row(s) in ${REGISTER} name files that hold no program: ${inertRows.join(', ')}`);
}

if (LIST) {
	console.log('\nreachable, and by what path:');
	for (const p of [...seen].sort()) {
		if (GLOB.test(p)) continue;             // the work list itself; 281 lines of no news
		console.log(`  ${p}  <-  ${via.get(p)}`);
	}
	console.log('\nregistered as outside the gate:');
	for (const p of [...registered.keys()].sort()) console.log(`  ${p}`);
}

console.log(`\n${oks.length} ok, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
