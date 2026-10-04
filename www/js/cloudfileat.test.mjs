/* ============================================================
   Test -- cloud.js `fileAt` tells an absent file from a store that cannot be read.
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js over a stand-in OPFS whose handles fail with a
   chosen error name.

   THE BUG (QA F-5 of fix/store-files-travel, 4 Oct 2026). `dirFor` and `fileAt` answered null
   for a missing directory and for a failed one alike, so `collectOwn` (daimond.js) read a
   store it could not open as a file that was gone, and sent a recorded text as "deleted".
   SYNC_CONTRACT.md section 1, rule 7: a store that cannot be read is unavailable, never
   empty, and nothing deletes because of it.

   Asserted: NotFoundError, and a file where a directory is wanted (TypeMismatchError), are
   null; any other error from a directory or a file handle is thrown; a file that is there is
   returned; `isHeld` is false for an absent file and does not turn a fault into a held file.

   Run:   node www/js/cloudfileat.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const err = (name) => Object.assign(new Error(name), { name });

/// One tab holding cloud.js over a stand-in store: `dirErr` is what `getDirectoryHandle` throws for any
/// name but `d`, `fileErr` what `getFileHandle` throws for any name but `f.txt`.
function tab({ dirErr, fileErr }) {
	const ls = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	const file = { size: 3, lastModified: 1789894800000, text: async () => 'abc' };
	const inner = {
		getDirectoryHandle: async () => { throw err(dirErr); },
		getFileHandle: async (n) => { if (n === 'f.txt') return { getFile: async () => file }; throw err(fileErr); },
	};
	const root = {
		getDirectoryHandle: async (n) => { if (n === 'd') return inner; throw err(dirErr); },
		getFileHandle: async (n) => { if (n === 'f.txt') return { getFile: async () => file }; throw err(fileErr); },
	};
	loadStore(win, ls);
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}');
	fn(win, ls, { storage: { getDirectory: async () => root } }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, class { constructor(t) { this.type = t; } });
	return win.DaimondCloud;
}

const asked = async (p) => { try { return { v: await p }; } catch (e) { return { threw: e && e.name }; } };

console.log('\nA store that answers plainly: nothing there is null\n');
{
	const C = tab({ dirErr: 'NotFoundError', fileErr: 'NotFoundError' });
	check('a missing file is null', (await asked(C.fileAt('f.nope'))).v === null);
	check('a missing directory is null', (await asked(C.fileAt('nodir/f.txt'))).v === null);
	check('[ctl] a file that is there is returned', ((await asked(C.fileAt('f.txt'))).v || {}).lastModified === 1789894800000);
	check('[ctl] and one in a directory is', ((await asked(C.fileAt('d/f.txt'))).v || {}).size === 3);
	check('isHeld is false for a missing file', (await asked(C.isHeld('f.nope'))).v === false);
}

console.log('\nA file where a directory is wanted, or the reverse, is the same answer\n');
{
	const C = tab({ dirErr: 'TypeMismatchError', fileErr: 'TypeMismatchError' });
	check('a name that is the wrong kind is null', (await asked(C.fileAt('f.nope'))).v === null && (await asked(C.fileAt('nodir/f.txt'))).v === null);
}

console.log('\nA store that cannot be read is not an empty one\n');
for (const name of ['UnknownError', 'InvalidStateError', 'NotAllowedError', 'SecurityError']) {
	const D = tab({ dirErr: name, fileErr: 'NotFoundError' });
	check(name + ' from a directory handle is thrown, not null', (await asked(D.fileAt('nodir/f.txt'))).threw === name, JSON.stringify(await asked(D.fileAt('nodir/f.txt'))));
	const F = tab({ dirErr: 'NotFoundError', fileErr: name });
	check(name + ' from a file handle is thrown, not null', (await asked(F.fileAt('f.nope'))).threw === name, JSON.stringify(await asked(F.fileAt('f.nope'))));
	check('[ctl] ' + name + ': isHeld never says held', (await asked(F.isHeld('f.nope'))).v !== true);
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
