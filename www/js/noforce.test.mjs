// noforce.test.mjs -- no dev/ script clicks, taps, hovers or fills with Playwright's `force: true`.
//
//	node --test www/js/noforce.test.mjs
//
// UNBLOCK-10 (D-20261014-09): `force: true` skips Playwright's actionability checks, so a gate that
// clicks with it passes on a control nobody can see or reach. verify_consistency clicked the rating
// arrows that way and stayed green while he could not find them on his desktop. A dev/ script acts as
// a user does, on a visible control, or it proves nothing.
//
// The ban is a ratchet. `dev/noforce_baseline.json` holds the count each older script had on
// 18 Oct 2026; a script may only go down from it, a script not in it must have none, and the gates
// named in ZERO must have none. Lower a count (or drop the row) when a script is cleaned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dev');
const BASE = JSON.parse(fs.readFileSync(path.join(DEV, 'noforce_baseline.json'), 'utf8'));
const ZERO = ['verify_consistency.mjs', 'verify_rating_widget.mjs', 'verify_rating_rest.mjs'];

/// Playwright option objects carrying `force: true`; a file-system call's `{ recursive, force }` is not one.
export function forced(src) {
	let n = 0;
	for (const line of src.split('\n')) {
		for (const m of line.matchAll(/\{[^{}]*\bforce\s*:\s*true\b[^{}]*\}/g)) {
			const before = line.slice(0, m.index);
			if (/recursive/.test(m[0]) || /\b(rmSync|rm|rmdir|rmdirSync|cpSync|cp)\s*\([^()]*$/.test(before)) continue;
			n++;
		}
	}
	return n;
}

const files = fs.readdirSync(DEV).filter((f) => /\.(mjs|js)$/.test(f));
const counts = Object.fromEntries(files.map((f) => [f, forced(fs.readFileSync(path.join(DEV, f), 'utf8'))]));

test('the detector counts a forced click and not a forced delete', () => {
	assert.equal(forced("await b.click({ force: true });\nfs.rmSync(p, { recursive: true, force: true });\nfs.rmSync(p, { force: true });"), 1);
	assert.equal(forced("await page.click('#x', { force: true, timeout: 5000 });"), 1);
});

test('the rating gates click as a user does: no force: true', () => {
	for (const f of ZERO) assert.equal(counts[f] || 0, 0, `${f} uses force: true ${counts[f]} time(s)`);
});

test('no dev/ script gains a forced action', () => {
	const over = files.filter((f) => counts[f] > (BASE[f] || 0)).map((f) => `${f}: ${counts[f]} > ${BASE[f] || 0}`);
	assert.deepEqual(over, [], 'force: true added: act on a visible control instead');
});
