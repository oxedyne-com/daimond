// verify_classifier_phrases.mjs — the two Safari phrases through the real classifier, without a
// browser.
//
// THE DEFECT (dev/PERSISTENCE_STUDY.md §3.1). A fetch that dies before its headers reaches
// JavaScript as the BROWSER's own sentence. Chromium says `Failed to fetch`; WebKit says
// `Load failed`, and iOS also produces `The network connection was lost`. `isUnreachable` and
// `failureClass` in www/js/daimond.js used to hold Chromium's wording and not WebKit's, so on
// iOS a turn that died BEFORE THE FIRST TOKEN fell through to `runTurn`'s terminal catch branch:
// an error line was written and `J.clearTurn` deleted the turn from the write-ahead log. No badge,
// no Continue, and `failureClass` counted it `other` so telemetry never showed it.
//
// verify_predrop.mjs proves the whole recovery path end to end in a real page. THIS file is its
// unit companion: it exercises the two classifier FUNCTIONS in isolation, on the exact strings
// Safari hands them, with nothing running. Read together they cover the seam from the browser's
// word to the recovery branch.
//
// HOW IT STAYS HONEST. It does not paste the regexes; it LIFTS them from www/js/daimond.js at run
// time — the two shared patterns `CLIENT_ROAD` and `BROWSER_ROAD`, and the bodies of
// `isUnreachable` and `failureClass` — and runs the real code. If any of those four moves or is
// renamed, the extraction throws and this file fails loudly rather than testing a stale copy.
//
// PROVED AGAINST BROKEN CODE FIRST. `--break wording` rebuilds the two functions from the 2026-08-27
// patterns (the ones that held `Failed to fetch` and not `Load failed`), and runs the SAME checks.
// The eight Safari-phrase checks then fail and the controls still pass — which is the proof that
// those eight assertions actually bite on the wording, not on something incidental:
//
//   node dev/verify_classifier_phrases.mjs --break wording   # the eight phrase checks fail
//   node dev/verify_classifier_phrases.mjs                   # and then, clean
//
// THE COUNT IS ASSERTED. A patch here can DISPLACE an existing case rather than add one, so the
// number of checks run is pinned: change the set and the last check trips until the number is
// updated on purpose.
//
//   node dev/verify_classifier_phrases.mjs
//
// Needs nothing running.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && BREAK !== 'wording') {
	console.error(`unknown break '${BREAK}'; the only one is 'wording'`);
	process.exit(2);
}

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Lift the real classifier out of the source ───────────────

/// The whole of a `var NAME = …;` statement that fits on one line — used for the two shared
/// regex patterns, each a single-line literal with no `;` inside it.
function grabVarLine(name) {
	const m = SRC.match(new RegExp('^\\s*var ' + name + ' = .*$', 'm'));
	if (!m) { console.error(`could not find 'var ${name}' in js/daimond.js`); process.exit(2); }
	return m[0].trim();
}

/// A function declaration by signature, brace-matched from its opening `{`. These three bodies
/// carry no braces inside a string, regex or comment, so a plain depth count is exact; a mis-lift
/// is caught by the sentinel assertions below.
function grabFn(sig) {
	const start = SRC.indexOf(sig);
	if (start < 0) { console.error(`could not find '${sig}' in js/daimond.js`); process.exit(2); }
	const open = SRC.indexOf('{', start);
	let depth = 0, i = open;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return SRC.slice(start, i);
}

const CLIENT_LIT  = grabVarLine('CLIENT_ROAD');
const BROWSER_LIT = grabVarLine('BROWSER_ROAD');
const IU_SRC      = grabFn('function isUnreachable(');
const FC_SRC      = grabFn('function failureClass(');

// The 2026-08-27 patterns, before `Load failed` and `The network connection was lost` were in
// either of them — the exact wording restored by verify_predrop.mjs's `--break wording`.
const OLD_BROWSER = 'var BROWSER_ROAD = /Failed to fetch|network\\s*error|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|refused|dns/i;';
const OLD_CLIENT  = 'var CLIENT_ROAD = /could not reach|the stream broke|read stream chunk failed/i;';

/// Build the two real functions with a chosen pair of patterns in scope. `isUnreachable` and
/// `failureClass` both name `CLIENT_ROAD` and `BROWSER_ROAD` and nothing else from the closure,
/// so this runs the shipped logic verbatim.
function build(clientLit, browserLit) {
	const f = new Function(
		clientLit + '\n' + browserLit + '\n' + IU_SRC + '\n' + FC_SRC + '\n'
		+ 'return { isUnreachable: isUnreachable, failureClass: failureClass };');
	return f();
}

const C = BREAK === 'wording'
	? build(OLD_CLIENT, OLD_BROWSER)
	: build(CLIENT_LIT, BROWSER_LIT);

if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: the phrase failures below are the point ***\n`);

// ── The shipped regex really carries the phrases ─────────────
//
// Read off the FILE (never the break substitute): a guard that the two Safari sentences are in
// the source that ships, so a green run cannot mean "matched by coincidence".
console.log('the shipped BROWSER_ROAD literal');
check(/Load failed/.test(BROWSER_LIT),
	'the source BROWSER_ROAD contains "Load failed"');
check(/The network connection was lost/.test(BROWSER_LIT),
	'the source BROWSER_ROAD contains "The network connection was lost"');

// ── The two functions cannot drift apart ─────────────────────
//
// The whole point of the shared patterns is that the recovery branch and the telemetry class read
// the SAME evidence. If a later edit gives one of them its own regex, these two trip.
console.log('the two readers share the two patterns');
check(/CLIENT_ROAD\.test\(s\)\s*\|\|\s*BROWSER_ROAD\.test\(s\)/.test(IU_SRC),
	'isUnreachable tests CLIENT_ROAD || BROWSER_ROAD and nothing else');
check(/CLIENT_ROAD\.test\(s\)/.test(FC_SRC) && /BROWSER_ROAD\.test\(s\)/.test(FC_SRC),
	"failureClass's first branch reads both shared patterns");

// ── The Safari phrases land in the offline branch ────────────
//
// Bare, and wrapped the way the engine actually hands them up: `friendlyError`/`offline` strip the
// fe2o3 source frames before testing, so the wrapped forms are what reaches the regex in the field.
const SAFARI = [
	['Load failed',                                       'WebKit, bare'],
	['The network connection was lost',                   'iOS, bare'],
	['LLM: fetch failed: TypeError: Load failed',         'WebKit, as the engine wraps it'],
	['TypeError: The network connection was lost',        'iOS, wrapped'],
];
console.log('the Safari phrases classify as offline');
for (const [phrase, where] of SAFARI) {
	check(C.isUnreachable(phrase) === true,
		`isUnreachable("${phrase}") is true (${where})`,
		C.isUnreachable(phrase) ? '' : 'FELL THROUGH — this is the deleted-turn path');
	check(C.failureClass(phrase) === 'offline',
		`failureClass("${phrase}") is 'offline' (${where})`,
		C.failureClass(phrase) === 'offline' ? '' : `got '${C.failureClass(phrase)}'`);
}

// ── A genuine non-transport error must NOT read as offline ───
//
// The control that makes the above mean something: if everything read offline, the fix would be a
// wire that shorts every turn into "recoverable". Each of these is a real provider or tool failure,
// and each must keep its own class — 'offline' is specifically the road, not a catch-all.
const CONTROLS = [
	['HTTP 400 Bad Request',                 'other',        'a malformed request'],
	['HTTP 401 Unauthorized',                'refused',      'a bad key'],
	['HTTP 429 Too Many Requests',           'rate_limited', 'a rate limit'],
	['HTTP 500 Internal Server Error',       'server_error', 'a provider fault'],
	['file_edit: old_string not found',      'other',        'a tool refusal'],
];
console.log('a real error keeps its own class, not offline');
for (const [phrase, klass, where] of CONTROLS) {
	check(C.isUnreachable(phrase) === false,
		`isUnreachable("${phrase}") is false (${where})`,
		C.isUnreachable(phrase) ? 'MISREAD AS THE ROAD' : '');
	check(C.failureClass(phrase) !== 'offline' && C.failureClass(phrase) === klass,
		`failureClass("${phrase}") is '${klass}', not 'offline' (${where})`,
		`got '${C.failureClass(phrase)}'`);
}

// ── The count is pinned ──────────────────────────────────────
//
// EXPECTED is the number of checks above. A case added or displaced changes it, so a silent swap
// cannot pass. Update this deliberately when the set changes.
const EXPECTED = 22;
const ranBefore = ran;
check(ranBefore === EXPECTED,
	`exactly ${EXPECTED} checks ran — a displaced case trips this`,
	`ran ${ranBefore}`);

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
