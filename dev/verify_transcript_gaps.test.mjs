// verify_transcript_gaps.test.mjs — the wrapper reads each engine's count from the child's STDOUT alone.
//
// The predeploy guard (harness.mjs → predeploy_guard.mjs) writes to stderr. The wrapper matched its
// `N passed, M failed` line against stdout + stderr, so the guard's line, appended after it, moved the
// count off the end: both engines passed 26/0 and the wrapper said "no count", 0 passed, 2 failed
// (diag_pg_eport.md red 1a). Red before the fix: there was no `engineCount`, and the count read both.
//
//   node --test dev/verify_transcript_gaps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(fileURLToPath(new URL('./verify_transcript_gaps.mjs', import.meta.url)), 'utf8');

function lifted() {
	const a = SRC.indexOf('\nfunction engineCount(');
	assert.ok(a >= 0, 'verify_transcript_gaps.mjs has an engineCount');
	return new Function(SRC.slice(a, SRC.indexOf('\n}\n', a) + 3) + '\nreturn engineCount;')();
}

const OUT = '  ok   one\n  ok   two\n\n26 passed, 0 failed\n';
const GUARD = 'predeploy guard: ran inside dk postgates, the live build is the tree\'s\n';

test('a stderr line cannot change the count', () => {
	const engineCount = lifted();
	assert.deepEqual(engineCount(OUT), { passed: 26, failed: 0 });
	assert.equal(engineCount(''), null);
	// The wrapper hands engineCount the child's stdout only: the guard's stderr never reaches it.
	assert.match(SRC, /engineCount\(r\.out\)/);
	assert.doesNotMatch(SRC, /out \+ err/);
});

test('a run that dies without its count still has none', () => {
	const engineCount = lifted();
	assert.equal(engineCount('  ok   one\nTypeError: boom\n'), null);
	assert.deepEqual(engineCount('25 passed, 1 failed\n'), { passed: 25, failed: 1 });
});
