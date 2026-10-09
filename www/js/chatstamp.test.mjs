/* ============================================================
   Test — the chat store's change stamp sees a row upgraded in
   place (www/js/daimond.js `stampOf`, hand-off QA F5, 2026-09-25),
   and persistChats carries every field that stamp reads onto a
   non-resident merge (QA F5 follow-up, 2026-09-27).
   ------------------------------------------------------------
   The runner's own copy of a handed-off answer replaces the one
   the asker took from its final frame (`framed`) by mid, with the
   same count and often the same `updatedAt`. The stamp read only
   counts and stamps, so the merged record was found unchanged and
   never written: the asker kept the framed copy on disk, and its
   next read put it back in memory for good. The stamp now carries
   the rows' standing (provisional, framed, interrupted), counted
   where the transcript is resident and read off the summary where
   it is not, so an unchanged chat still stamps the same both ways.

   F5 added `standing` to the stamp but `persistChats` carried only
   `msgCount` onto a non-resident merge, so a summary's `standing`
   (and, found by the same sweep, its `sessionMsgs`) never matched
   and every un-opened chat with either was rewritten on every save.
   `stampOf` and the carry now read the SAME three residency-aware
   functions (`chatMsgCount`/`chatSessionMsgs`/`standingOf`), so the
   two cannot drift apart again by construction.

   `stampOf`, `msgStanding`, `standingOf`, `chatMsgCount`,
   `chatSessionMsgs`, `slimChat`, and the exact residency-carry
   block inside `persistChats`, are all lifted from the REAL
   daimond.js by a brace-balanced scan -- nothing here is a
   reimplementation, so a future edit that drops a field from
   either side is caught here, not just described here.

   Run:  node www/js/chatstamp.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const APP = readFileSync(join(HERE, 'daimond.js'), 'utf8');

/// Lifts `function name(...) { ... }` at any indentation by counting braces.
function extractFn(src, name) {
	const m = new RegExp('\\n\\t+function ' + name + '\\(').exec(src);
	if (!m) throw new Error('function not found: ' + name);
	const start = m.index + 1;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

/// Lifts one brace-balanced `{ ... }` block starting at the first `{` at or after
/// `marker` inside `src` -- for a snippet that is not its own named function, such
/// as `persistChats`'s residency-carry `if`.
function extractBlock(src, marker) {
	const idx = src.indexOf(marker);
	if (idx < 0) throw new Error('block not found: ' + marker);
	const brace = src.indexOf('{', idx);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(idx, i);
}

const carryBlock = extractBlock(extractFn(APP, 'persistChats'), 'if (c._loaded === false)');

const { stampOf, msgStanding, standingOf, chatMsgCount, chatSessionMsgs, slimChat, applyCarry } = new Function([
	extractFn(APP, 'stampOf'),
	extractFn(APP, 'msgStanding'),
	extractFn(APP, 'standingOf'),
	extractFn(APP, 'chatMsgCount'),
	extractFn(APP, 'chatSessionMsgs'),
	extractFn(APP, 'withRecent'),
	extractFn(APP, 'slimChat'),
	'function applyCarry(merged, c) { ' + carryBlock + ' }',
	'return { stampOf, msgStanding, standingOf, chatMsgCount, chatSessionMsgs, slimChat, applyCarry };',
].join('\n'))();

const rows = (framed) => [
	{ role: 'user', content: 'q', mid: 'u' },
	Object.assign({ role: 'assistant', content: 'the answer', mid: 'a' }, framed ? { framed: 1 } : {}),
];
const chat = (msgs, extra) => Object.assign({ id: 'c', updatedAt: 100, metaAt: 100, holds: [], messages: msgs, _loaded: true }, extra || {});

check('a framed copy replaced by the runner\'s own moves the stamp (same count, same updatedAt)',
	stampOf(chat(rows(true))) !== stampOf(chat(rows(false))), [stampOf(chat(rows(true))), stampOf(chat(rows(false)))]);
const prov = rows(false); prov[1] = Object.assign({}, prov[1], { provisional: 1 });
check('so does a provisional copy replaced by a real one', stampOf(chat(prov)) !== stampOf(chat(rows(false))));
const intr = rows(false); intr[1] = Object.assign({}, intr[1], { interrupted: 1 });
check('and a badge taken off', stampOf(chat(intr)) !== stampOf(chat(rows(false))));
check('an unchanged chat stamps the same twice', stampOf(chat(rows(true))) === stampOf(chat(rows(true))));
// The summary the store writes carries `msgCount` and `standing`, and no transcript.
const summary = { id: 'c', updatedAt: 100, metaAt: 100, holds: [], msgCount: 2, sessionMsgs: 0, standing: msgStanding(rows(true)) };
check('a summary row stamps as the resident chat it summarises', stampOf(summary) === stampOf(chat(rows(true))), [stampOf(summary), stampOf(chat(rows(true)))]);
const hydrated = chat([], { _loaded: false, msgCount: 2, sessionMsgs: 0, standing: summary.standing });
check('and so does a chat not resident here, off the standing its summary carried', stampOf(hydrated) === stampOf(summary));
check('a summary from an older build (no standing) stamps as a non-resident chat that has none',
	stampOf(Object.assign({}, summary, { standing: undefined })) === stampOf(chat([], { _loaded: false, msgCount: 2, sessionMsgs: 0 })));
// Content changes that `slimMessages` makes on the way in are not in the stamp.
const slim = rows(false).concat([{ role: 'tool_log', content: 'x'.repeat(10), mid: 't', elided: 900 }]);
const full = rows(false).concat([{ role: 'tool_log', content: 'x'.repeat(910), mid: 't' }]);
check('a tool result shortened by the store stamps as the full one (no rewrite on every save)', stampOf(chat(slim)) === stampOf(chat(full)));

// ── persistChats's residency carry (QA F5 follow-up, 2026-09-27) ───────────────
//
// An OLD-FORMAT stored chat: migrated from before summaries existed, never opened
// this session, with real standing (an interrupted row) and a real tool session --
// exactly the shape that rewrote on every save before the fix (triage's "c9001").
const oldRows = rows(false).concat([{ role: 'assistant', content: 'y', mid: 'z', interrupted: 1 }]);
const diskRow = { id: 'c9001', updatedAt: 500, metaAt: 500, holds: [{ ref: 'a' }],
	msgCount: oldRows.length, sessionMsgs: 3, standing: msgStanding(oldRows) };
// The live copy is hydrated from that same row and never loaded -- nothing about
// THIS chat changed, only some OTHER chat had a turn that triggered persistChats.
const liveCopy = { id: 'c9001', updatedAt: 500, metaAt: 500, holds: [{ ref: 'a' }], messages: [],
	_loaded: false, msgCount: diskRow.msgCount, sessionMsgs: diskRow.sessionMsgs, standing: diskRow.standing };
// `mergeChatRecords`'s `out = slimChat(turnNewer)`, degenerately either side here
// since nothing about this chat changed; the residency carry is what runs next.
const merged = slimChat(diskRow);
applyCarry(merged, liveCopy);
check('an unloaded, old-format chat is not rewritten by an unrelated save',
	stampOf(merged) === stampOf(diskRow), [stampOf(merged), stampOf(diskRow)]);
check('...specifically because its sessionMsgs was carried', chatSessionMsgs(merged) === chatSessionMsgs(diskRow));
check('...and its standing was carried', standingOf(merged) === standingOf(diskRow));

console.log('\n' + checks + ' checks, ' + failures + ' failed');
if (failures) process.exitCode = 1;
