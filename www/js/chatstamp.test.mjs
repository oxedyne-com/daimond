/* ============================================================
   Test — the chat store's change stamp sees a row upgraded in
   place (www/js/daimond.js `stampOf`, hand-off QA F5, 2026-09-25).
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

   `stampOf`, `msgStanding` and `standingOf` are lifted from the
   REAL daimond.js by a brace-balanced scan.

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

const { stampOf, msgStanding } = new Function([
	extractFn(APP, 'stampOf'),
	extractFn(APP, 'msgStanding'),
	extractFn(APP, 'standingOf'),
	'return { stampOf, msgStanding };',
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

console.log('\n' + checks + ' checks, ' + failures + ' failed');
if (failures) process.exitCode = 1;
