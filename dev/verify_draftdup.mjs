// verify_draftdup.mjs — the junk-draft-duplicate bug (2026-09-13), in isolation.
//
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
const DAIMOND_SRC = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'daimond.js'), 'utf8');
const DRAFTS_SRC  = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'drafts.js'),  'utf8');

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
