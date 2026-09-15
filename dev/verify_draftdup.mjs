// verify_draftdup.mjs — the junk-draft-duplicate bug (2026-09-13), in isolation.
//
// node dev/verify_draftdup.mjs --break gateless   restore the shipped defect and run
// Declared breaks: gateless
// Live symptom: `#chat-input` refilled with "Note code/dev_handover,
// code/dev_handover/06_projects/daimond.md, …" and grew ANOTHER copy on every
// load or unlock -- 7 copies became 8 on one unlock.
//
// TWO FUNCTIONS TOGETHER MADE THE BUG, and this file proves both fixed in
// isolation, without a browser:
//
//   1. `syncComposerAttachPrefix` (www/js/daimond.js) reseeds the composer with
//      the attach prefix on every chat/Diamond select, including the one boot
//      does and the one an unlock does. It used to decide replace-vs-append by
//      comparing against `attachPrefixWritten`, its OWN in-memory cache -- which
//      starts empty on every fresh page load. The first call after a reload,
//      finding no memory of having written anything, always prepended.
//   2. `drafts.js` persists whatever lands in `#chat-input` on an `input`
//      event and restores it into the (empty) box next load -- including the
//      prefix (1) had just prepended, which (1) then saw as ordinary box
//      content on the NEXT load and prepended in front of again. Compounding.
//
// The fix for (1), `mergeAttachPrefix`, is lifted verbatim from daimond.js
// (`new Function`, not retyped) and driven through what a reload sequence
// actually hands it: `val` starts as whatever the previous call left in the
// box, `last` resets to '' every call (a fresh page load never remembers).
// The fix for (2) is `drafts.js`'s own `input` listener: it must persist a
// TRUSTED (real keystroke) event and ignore an UNTRUSTED (script-dispatched)
// one, checked by grepping the guard is where it should be -- `new Function`
// cannot fake `Event#isTrusted`, which the DOM itself sets read-only and true
// only for a real user action.
//
//   node dev/verify_draftdup.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Declared breaks, run by the verify verb as `--break <name>`. Each restores
// the defect EXACTLY as it shipped, so what reddens under it is what a user
// saw in the product — never a synthetic weakening of the check.
const BREAKS = {
	// Before 63ea78e5 there was NO first-turn gate at all: every select —
	// including the mid-session resume a restart does — reseeded the box.
	// Restoring that is the defect the owner reported on the forge (#15).
	gateless: [{
		file: 'js/daimond.js',
		find: '\tfunction attachPrefixGateOpen(hasTurns, boxValue, lastWritten) {\n'
			+ '\t\tif (hasTurns) return false;\n'
			+ '\t\tif (!boxValue) return true;\n'
			+ '\t\treturn !!(lastWritten && boxValue.indexOf(lastWritten) === 0);\n'
			+ '\t}\n',
		with: '\tfunction attachPrefixGateOpen(hasTurns, boxValue, lastWritten) {\n'
			+ '\t\t// [break:gateless] the defect as it shipped: no first-turn gate —\n'
			+ '\t\t// every select reseeded, including a mid-session resume.\n'
			+ '\t\tif (!boxValue) return true;\n'
			+ '\t\treturn !!(lastWritten && boxValue.indexOf(lastWritten) === 0);\n'
			+ '\t}\n',
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

const MERGE_SRC = grabFn(DAIMOND_SRC, 'function mergeAttachPrefix(');
const { mergeAttachPrefix } =
	new Function(MERGE_SRC + '\nreturn { mergeAttachPrefix: mergeAttachPrefix };')();

console.log('mergeAttachPrefix — the reseed, across a sequence of reloads');

const NOTE = 'Note code/dev_handover, code/dev_handover/06_projects/daimond.md\n';

// ── An empty box: the ordinary first seed ────────────────────────────
{
	const out = mergeAttachPrefix(NOTE, '', '');
	check(out === NOTE, 'seeding an empty box writes the prefix once', JSON.stringify(out));
}

// ── TWO RESTORES YIELD ONE COPY ──────────────────────────────────────
// Call 1: a fresh page, the box already holds what a PRIOR page life restored
// via drafts.js (the prefix, and nothing else) -- `last` is '' because this
// page's memory never saw it written. Call 2: reload again, same shape.
{
	let val = NOTE;                              // what drafts.js restored into the box
	let last = '';                                // this page's memory: nothing yet
	val = mergeAttachPrefix(NOTE, val, last);
	last = NOTE;
	check(val === NOTE, 'restore #1 after a reload leaves exactly one copy', JSON.stringify(val));

	// A second reload: memory resets to '' again, box still holds the one copy.
	last = '';
	val = mergeAttachPrefix(NOTE, val, last);
	check(val === NOTE, 'restore #2 after a second reload still leaves exactly one copy',
		JSON.stringify(val));
	check((val.match(/Note code\/dev_handover/g) || []).length === 1,
		'the prefix text itself appears exactly once, not stacked');
}

// ── UNLOCK AFTER BOOT YIELDS ONE COPY ─────────────────────────────────
// Boot draws the app once (memory empty, box holds whatever was restored) and
// unlocking draws it again in the SAME page life -- this time memory DOES
// carry `last` from the boot call, which is the case that was already correct;
// proved here so a change to the boot path cannot silently break it.
{
	let val = NOTE;                               // restored at boot
	let last = '';
	val = mergeAttachPrefix(NOTE, val, last);     // the boot-time call
	last = NOTE;
	check(val === NOTE, 'boot leaves one copy', JSON.stringify(val));

	val = mergeAttachPrefix(NOTE, val, last);     // the unlock-time call, same page life
	check(val === NOTE, 'unlock right after boot still leaves one copy', JSON.stringify(val));
}

// ── A user's own words in front are never touched ─────────────────────
{
	const typed = 'please also check the tests\n\n';
	let val = typed + NOTE;                       // the user typed, THEN the prefix was seeded under it...
	// ...no: the prefix always goes in FRONT (attachPrefixText's own contract),
	// so the realistic shape is prefix-then-typed. Both are asserted:
	check(mergeAttachPrefix(NOTE, NOTE + typed, NOTE) === NOTE + typed,
		"the user's own words after the prefix survive a re-seed");
	check(mergeAttachPrefix(NOTE, NOTE + typed, '') === NOTE + typed,
		"and survive it even with no memory of the prefix (a reload) — matched structurally");
}

// ── The attachments changed: the OLD prefix in memory is swapped, not stacked ──
{
	const OLD = 'Note a.txt\n';
	const val = mergeAttachPrefix(OLD, OLD, '');
	const out = mergeAttachPrefix(NOTE, val, OLD);   // same page life: memory has OLD
	check(out === NOTE, 'a changed attach set replaces the old prefix in place', JSON.stringify(out));
}

// ── The remaining gap (owner report, 2026-09-13): an EXISTING chat's composer
// came back prefilled with the attach prefix on focus, reload and unlock,
// because `syncComposerAttachPrefix` never gated the chat branch on the
// thread already having a turn -- only the Diamond branch had that check.
// `attachPrefixGateOpen` is the extracted rule; proved here the same way
// `mergeAttachPrefix` is, without a browser. ─────────────────────────────
const GATE_SRC = grabFn(DAIMOND_SRC, 'function attachPrefixGateOpen(');
const { attachPrefixGateOpen } =
	new Function(GATE_SRC + '\nreturn { attachPrefixGateOpen: attachPrefixGateOpen };')();

console.log('\nattachPrefixGateOpen — first turn only, into an otherwise-empty box');

// ── Existing chat + focus: NEVER written, whatever the box holds ──────
{
	check(attachPrefixGateOpen(/* hasTurns */ true, '', '') === false,
		'existing chat, empty box: gate stays closed');
	check(attachPrefixGateOpen(true, NOTE, '') === false,
		'existing chat, box already showing a prefix: gate stays closed');
	check(attachPrefixGateOpen(true, 'please also check the tests', '') === false,
		"existing chat, box holding the user's own draft: gate stays closed");
}

// ── Existing chat + reload: persisted user text is restored exactly, and the
// closed gate is WHY -- nothing downstream of a closed gate ever calls
// `mergeAttachPrefix`, so whatever `drafts.js` put in the box is what stays. ──
{
	const restored = 'please also check the tests\n\n';
	const open = attachPrefixGateOpen(true, restored, '');
	check(open === false, 'a chat with turns keeps the gate closed regardless of the restored text');
	// The box is therefore left exactly as `drafts.js` restored it -- no merge,
	// no prepend, simulated here by never invoking `mergeAttachPrefix` at all.
	const val = open ? mergeAttachPrefix(NOTE, restored, '') : restored;
	check(val === restored, 'closed gate: the persisted user text comes back exactly, no prefix',
		JSON.stringify(val));
}

// ── New chat: zero turns, empty box, no memory -- the gate opens and one
// prefix is written. ───────────────────────────────────────────────────
{
	const open = attachPrefixGateOpen(/* hasTurns */ false, '', '');
	check(open === true, 'new chat, empty box: gate opens');
	const val = open ? mergeAttachPrefix(NOTE, '', '') : '';
	check(val === NOTE, 'new chat: exactly one prefix is written', JSON.stringify(val));
}

// ── Zero turns but the user already typed, or a real draft is sitting there:
// the gate stays closed even on a brand new thread. ─────────────────────
{
	check(attachPrefixGateOpen(false, 'hello', '') === false,
		"new chat, but the user typed first: gate stays closed");
}

// ── An in-session toggle (Note ⇄ Read, still zero turns) is UNAFFECTED: the
// box holds exactly what this module wrote last, so the gate still opens. ──
{
	check(attachPrefixGateOpen(false, NOTE, NOTE) === true,
		'zero turns, box holds our own last prefix: gate still opens for a live toggle');
}

// ── Still zero turns, but the user typed something AFTER our own prefix
// (§6: "attaching one more thing... updates it") -- attaching a second file
// must still refresh the prefix in place, keeping the user's words. ────
{
	const typed = NOTE + 'please also review this';
	check(attachPrefixGateOpen(false, typed, NOTE) === true,
		"the user's words follow our own prefix: gate still opens to refresh it");
	const NOTE2 = 'Note code/dev_handover\n';
	const merged = mergeAttachPrefix(NOTE2, typed, NOTE);
	check(merged === NOTE2 + 'please also review this',
		'refreshing in place keeps the words the user added after the prefix', JSON.stringify(merged));
}

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
console.log('verify_draftdup: all checks passed');
