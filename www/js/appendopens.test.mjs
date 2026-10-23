/* ============================================================
   Test -- the app's own notes do not open a turn (QA r578d-B B3).
   ------------------------------------------------------------
   `append_message` marked every appended user row as a turn's
   opening, the page's "agents not started" note and a rebuilt
   interjection included, so past the line "keep the last turn
   whole" landed on the note and retired the turn just finished
   one turn early. It now takes `opens`: a prose turn from another
   device passes true, an interjection and an app note false, and
   the prose restore marks only a row that is not an interjection.

   Run:  node --test www/js/appendopens.test.mjs
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE    = dirname(fileURLToPath(import.meta.url));
const DAIMOND = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const APP     = readFileSync(join(HERE, '..', '..', 'src', 'wasm', 'app.rs'), 'utf8');

/// The text of every call to `fn(` in `src`, paren-matched.
function calls(src, fn) {
	const out = [];
	let at = 0;
	for (;;) {
		const i = src.indexOf(fn + '(', at);
		if (i < 0) return out;
		let j = i + fn.length, depth = 0;
		for (; j < src.length; j++) {
			const c = src[j];
			if (c === '(') depth++;
			else if (c === ')') { depth--; if (depth === 0) break; }
		}
		out.push(src.slice(i, j + 1));
		at = j;
	}
}

test('B3: every page call says whether the row opens a turn', () => {
	const all = calls(DAIMOND, 'app.append_message');
	assert.ok(all.length >= 3, 'found the calls: ' + all.length);
	all.forEach((c) => {
		// Five arguments: role, content, pre, mid, opens.
		const args = c.slice(c.indexOf('(') + 1, -1);
		let depth = 0, commas = 0;
		for (const ch of args) {
			if ('([{'.includes(ch)) depth++;
			else if (')]}'.includes(ch)) depth--;
			else if (ch === ',' && depth === 0) commas++;
		}
		assert.equal(commas, 4, 'opens is passed: ' + c.slice(0, 120));
	});
	// The "agents not started" note is the app's, never a turn.
	assert.ok(all.some((c) => /^app\.append_message\('user', said, undefined, undefined, false\)$/.test(c)),
		'the note passes false');
	// A rebuilt row opens a turn unless it was an interjection.
	const prose = all.filter((c) => /m\.role, m\.content/.test(c));
	assert.ok(prose.length >= 2, 'the prose rebuilds: ' + prose.length);
	prose.forEach((c) => assert.match(c, /m\.role === 'user' && !m\.interject\)$/, c.slice(0, 160)));
});

// What the engine does with `opens` is pinned by behaviour in Rust
// (protocol.rs `of_row_opening_marks_only_a_row_a_turn_was_run_on`), not by its spelling here.
test('B3: the engine takes opens, and the prose restore reads the interjection', () => {
	assert.match(APP, /pub fn append_message\(&self, role: String, content: String, pre: Option<String>,\s+mid: Option<String>, opens: bool\)/);
	const a = APP.indexOf('pub fn append_message(');
	const body = APP.slice(a, APP.indexOf('\n    }\n', a));
	assert.doesNotMatch(body, /\.opening\(\)/);
	const r = APP.indexOf('    pub fn restore(\n');
	const rest = APP.slice(r, APP.indexOf('\n    }\n', r));
	assert.match(rest, /"interject"/);
});
