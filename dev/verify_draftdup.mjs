// gateway: none
// verify_draftdup.mjs — the junk-draft-duplicate bug (2026-09-13), in isolation.
//
// node dev/verify_draftdup.mjs --break keeper   restore the shipped defect and run
// Declared breaks: keeper
// Live symptom: `#chat-input` refilled with "Note code/dev_handover,
// code/dev_handover/06_projects/daimond.md, …" and grew ANOTHER copy on every
// load or unlock -- 7 copies became 8 on one unlock.
//
// The app no longer writes the attach prefix into the composer at all (HATE-10,
// 2026-10-26): it rides the first message's note, `pre`. What is left to prove,
// without a browser, is the clean-up of drafts a PRIOR build corrupted:
//
//   1. `scrubAttachPrefixDup` (www/js/daimond.js) collapses a stored draft's
//      stacked copies once, on restore -- every copy on a started thread, all
//      but one on an unstarted one. Lifted verbatim (`new Function`, not retyped).
//   2. `drafts.js`'s `input` listener persists a TRUSTED (real keystroke) event
//      and ignores an UNTRUSTED (script-dispatched) one, checked by grepping the
//      guard is where it should be -- `new Function` cannot fake
//      `Event#isTrusted`, which the DOM sets read-only.
//
//   node dev/verify_draftdup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardRan } from './verdict.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Declared breaks, run by the verify verb as `--break <name>`. Each restores
// the defect EXACTLY as it shipped, so what reddens under it is what a user
// saw in the product — never a synthetic weakening of the check.
const BREAKS = {
	// Before 2026-09-15 a single copy was left standing even on a STARTED thread
	// (`copies < 2` returned ahead of the `hasTurns` test): the keeper the owner
	// kept meeting on gilgamesh, restored on every boot and re-persisted for ever.
	keeper: [{
		file: 'js/daimond.js',
		find: '\t\tif (hasTurns) return rest;\n'
			+ '\t\tif (copies < 2) return text;',
		with: '\t\t// [break:keeper] the defect as it shipped: one copy kept, turns or not.\n'
			+ '\t\tif (copies < 2) return text;\n'
			+ '\t\tif (hasTurns) return rest;',
	}],
};
const BREAK = process.argv.find(a => a.startsWith('--break='))?.slice(8)
	|| (process.argv[2] === '--break' ? process.argv[3] : null);
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

// The damaged source, loaded BEFORE any check reads it: the break edits the
// file the checks grep and evaluate, so a red here is the shipped defect.
// The pristine copy is taken BEFORE any damage, so exit-restore undoes it.
const SRC_DIR = path.join(HERE, '..', 'www');
const PATCHES = BREAK ? BREAKS[BREAK] : [];
const MEMENTOES = new Map();
function memento(file) {
	if (!MEMENTOES.has(file)) MEMENTOES.set(file, fs.readFileSync(file, 'utf8'));
	return MEMENTOES.get(file);
}
for (const p of PATCHES) {
	const file = path.join(SRC_DIR, p.file);
	const src = memento(file);
	if (!src.includes(p.find)) {
		console.error(`break '${BREAK}': anchor not found in ${p.file}`);
		process.exit(2);
	}
	fs.writeFileSync(file, src.replace(p.find, p.with));
}
process.on('exit', () => { for (const p of PATCHES) {                    // restore on exit, always
	const file = path.join(SRC_DIR, p.file);
	const src = MEMENTOES.get(file);
	if (src != null) fs.writeFileSync(file, src);
} });

// The damaged source as it NOW sits on disk, read AFTER any break was applied:
// the checks must see the defect, while MEMENTOES holds the pristine bytes
// captured BEFORE the patch loop for the restore-on-exit.
const DAIMOND_SRC = fs.readFileSync(path.join(SRC_DIR, 'js', 'daimond.js'), 'utf8');
const DRAFTS_SRC  = fs.readFileSync(path.join(SRC_DIR, 'js', 'drafts.js'), 'utf8');

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// Same device as verify_report_cap.mjs's grabFn: a function found by its
// declaration and brace-matched from the opening `{`, so a rename or a move
// throws here rather than silently testing a stale copy.
function grabFn(src, sig) {
	const start = src.indexOf(sig);
	if (start < 0) { console.error(`could not find '${sig}'`); process.exit(2); }
	const open = src.indexOf('{', start);
	let depth = 0, i = open;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

const NOTE = 'Note code/dev_handover, code/dev_handover/06_projects/daimond.md\n';

// ── Scrubbing an already-corrupted draft, once, on restore ──────────────
const SCRUB_SRC = grabFn(DAIMOND_SRC, 'function scrubAttachPrefixDup(');
const LOOSE_LINE_MATCH = DAIMOND_SRC.match(/var ATTACH_PREFIX_LOOSE_LINE = [^\n]*\n/);
if (!LOOSE_LINE_MATCH) { console.error('could not find ATTACH_PREFIX_LOOSE_LINE'); process.exit(2); }
const { scrubAttachPrefixDup } =
	new Function(LOOSE_LINE_MATCH[0] + SCRUB_SRC
		+ '\nreturn { scrubAttachPrefixDup: scrubAttachPrefixDup };')();

console.log('\nscrubAttachPrefixDup — the owner\'s six stacked copies, collapsed once');

// ── The live symptom: SIX identical copies, on a chat that has turns ────
{
	const six = NOTE.repeat(6);
	const out = scrubAttachPrefixDup(six, NOTE, /* hasTurns */ true);
	check(out === '', 'six stacked copies on an existing chat: every copy is dropped',
		JSON.stringify(out));
}

// ── Six copies, but nothing has been sent yet: keep exactly one ─────────
{
	const six = NOTE.repeat(6);
	const out = scrubAttachPrefixDup(six, NOTE, /* hasTurns */ false);
	check(out === NOTE, 'six stacked copies, zero turns: exactly one copy is kept', JSON.stringify(out));
}

// ── Six copies with the user's own words trailing: the words survive ────
{
	const typed = 'please also check the tests\n';
	const six = NOTE.repeat(6) + typed;
	const outTurns = scrubAttachPrefixDup(six, NOTE, true);
	check(outTurns === typed, "an existing chat's trailing words survive the scrub",
		JSON.stringify(outTurns));
	const outNew = scrubAttachPrefixDup(six, NOTE, false);
	check(outNew === NOTE + typed, "a zero-turn chat keeps one copy in front of the trailing words",
		JSON.stringify(outNew));
}

// ── A single legitimate seed -- one Note line AND one Read line -- is not a
// stack of two. On an UNSTARTED thread it survives untouched, exactly as a
// lone copy of the plain prefix does above; the property under test is that
// the pair is recognised as ONE unit, never as two stacked half-copies of
// something shorter. (2026-09-15: this used to be asserted under
// `hasTurns: true` as well, which is the keeper itself -- a single seed left
// standing forever on a thread the summary already proved had turns, because
// nothing downstream ever revisits a copy count under two. See
// `verify_prefixpeer.mjs`, which drives that exact fault end to end.) ───
{
	const READ = 'Read spec.md in full.\n';
	const single = NOTE + READ;
	const out = scrubAttachPrefixDup(single, NOTE + READ, false);
	check(out === single, 'one Note line plus one Read line is ONE seed, not two: left untouched',
		JSON.stringify(out));
	// A STARTED thread keeps none of it back, the Note+Read pair included --
	// one copy is still one copy too many once a turn has been spent.
	const outTurns = scrubAttachPrefixDup(single, NOTE + READ, true);
	check(outTurns === '', 'the same pair on a STARTED thread is stripped, not kept as "one seed"',
		JSON.stringify(outTurns));
}

// ── The loose fallback: the attach list has since changed, so the exact text
// no longer matches, but the same old line is still repeated verbatim. ──
{
	const OLD = 'Note old/path.md\n';
	const stacked = OLD.repeat(4);
	const out = scrubAttachPrefixDup(stacked, /* current, no longer matches */ NOTE, false);
	check(out === OLD, 'an old, now-unmatched prefix repeated verbatim is still collapsed to one copy',
		JSON.stringify(out));
}

// ── Nothing stacked: a single copy is left exactly as it was ────────────
{
	check(scrubAttachPrefixDup(NOTE, NOTE, false) === NOTE,
		'a single, unstacked copy is left alone');
	check(scrubAttachPrefixDup('hello', NOTE, false) === 'hello',
		'ordinary text with no prefix at all is left alone');
}

console.log('\ndrafts.js — a script-dispatched write is never mistaken for a keystroke');
{
	const listener = grabFn(DRAFTS_SRC, "el.addEventListener('input', function (e) {");
	const has = /isTrusted\s*===\s*false/.test(listener)
		&& listener.indexOf('isTrusted') < listener.indexOf('set(');
	check(has, 'the input listener bails out on an untrusted (synthetic) event before persisting',
		has ? null : 'no isTrusted guard found ahead of set() in the bound listener');
}

console.log(`\n${ran - bad}/${ran} checks passed`);
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
guardRan(ran);
console.log('verify_draftdup: all checks passed');
