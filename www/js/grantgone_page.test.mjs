/* ============================================================
   Test -- the folder-grant model is gone from the page (UNBLOCK-82 G2 step 6, D-20261031-11).

   One row per surface G2 removed: the file it lived in, and the pattern that must no longer
   appear there. Comments count too: a comment naming a removed function sends the next
   reader looking for it. `dev/grant_gone.sh` is the term gate across code, i18n and guides;
   this is the per-surface record of what went, so a revert of any one of them is named.

   `node --test www/js/grantgone_page.test.mjs`.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

// file, absent pattern, what went
const GONE = [
	['page/diamonds.js',       /\bgrantConsulted\b/,                     'the seed grant consult'],
	['cloud.js',               /\bmaterialiseTo\b/,                      'writing cloud bytes into a real folder'],
	['cloud.js',               /\bopenWriteUnderRoot\b/,                 'the folder writer'],
	['cloud.js',               /\bremoveUnderRoot\b/,                    'the folder remover'],
	['cloud.js',               /\buseRoot\b|\bactiveRoot\b/,             'the registered machine-folder root'],
	['page/boot.js',           /\buseRoot\b|\bsharedFolderHandle\b/,     'the boot wiring of that root'],
	['page/parcel_collect.js', /\bsharedFolderHandle\b/,                 'the shared folder handle'],
	['page/parcel_collect.js', /\bshareRoots\b|\bwalkShared\b|\bmaterialiseShared\b/, 'the folder share walk'],
	['page/parcel_collect.js', /'folder:' *\+/,                         'writing a folder sync location (older ones are still read)'],
	['page/parcel_collect.js', /\bFiles\.folder\b|\.folderId\(/,         'reading a folder that no longer exists'],
	['page/sourcemenu.js',     /\bFiles\.folder\b|\bselfHoldsFolder\b/,  'the folder test on the hand'],
	['page/marks.js',          /\bFiles\.folder\b|\.folderId\(/,         'the machine root of a new attachment'],
	['debugshare.js',          /DaimondFiles\.folder\b/,                 'the folder capability fact'],
	['page/consent.js',        /routePermitAsk\([a-z]+, '(toolkit|place)'/, 'the toolkit and place asks'],
	['page/consent.js',        /dws\.can_change|dws\.readonly|act_place|act_toolkit/, 'the grant words'],
];

for (const [file, pat, what] of GONE) {
	test(file + ' no longer has ' + what, () => {
		const m = src(file).match(pat);
		assert.equal(m, null, file + ' still names ' + (m && m[0]));
	});
}

test('[ctl] the table reads real files, and a pattern that is present is caught', () => {
	assert.match(src('page/consent.js'), /function egressAllowed/);
	assert.match(src('cloud.js'), /\bfileUnderRoot\b/);
});
