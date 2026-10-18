/* ============================================================
   Test -- cloud.js lookups read "absent" only on the store's plain NotFoundError.
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js over a stand-in OPFS whose handles fail with a
   chosen error name.

   THE BUG (CLOUD-ISHELD, 19 Oct 2026, the runner's PLF-NF in JS). `isHeld` answered
   false on ANY error from the file lookup, and `fileUnderRoot`, `dirUnderRoot` and the
   unescaped-name probe in `diskNameIn` did the same, so a storage fault read as "not
   held": a file this device holds was fetched over, or listed as away. SYNC_CONTRACT.md
   section 1, rule 7: a store that cannot be read is unknown, never absent.

   Asserted: NotFoundError (and TypeMismatchError) still read as absent; any other error
   is thrown from `isHeld`, `fileUnderRoot` (file and directory) and the name probe; a
   held file is held.

   Run:   node www/js/cloudheld.test.mjs
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

/// A stand-in directory: `d` is a directory, `f.txt` a file; any other directory name
/// throws `dirErr`, any other file name `fileErr`.
function store({ dirErr, fileErr }) {
	const file = { size: 3, lastModified: 1789894800000, text: async () => 'abc' };
	const mk = (sub) => ({
		getDirectoryHandle: async (n) => { if (sub && n === 'd') return sub; throw err(dirErr); },
		getFileHandle: async (n) => { if (n === 'f.txt') return { getFile: async () => file }; throw err(fileErr); },
	});
	return mk(mk(null));
}

function tab(opts) {
	const ls = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	const root = store(opts);
	loadStore(win, ls);
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}');
	fn(win, ls, { storage: { getDirectory: async () => root } }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, class { constructor(t) { this.type = t; } });
	return { C: win.DaimondCloud, root };
}

const asked = async (p) => { try { return { v: await p }; } catch (e) { return { threw: e && e.name }; } };

console.log('\nNotFoundError is absent\n');
{
	const { C, root } = tab({ dirErr: 'NotFoundError', fileErr: 'NotFoundError' });
	check('isHeld is false for a missing file', (await asked(C.isHeld('f.nope'))).v === false);
	check('isHeld is false for a missing directory', (await asked(C.isHeld('nodir/f.txt'))).v === false);
	check('[ctl] isHeld is true for a held file', (await asked(C.isHeld('d/f.txt'))).v === true);
	check('fileUnderRoot is null for a missing file', (await asked(C.fileUnderRoot(root, 'f.nope'))).v === null);
	check('fileUnderRoot is null for a missing directory', (await asked(C.fileUnderRoot(root, 'nodir/f.txt'))).v === null);
	check('[ctl] fileUnderRoot returns a file that is there', ((await asked(C.fileUnderRoot(root, 'd/f.txt'))).v || {}).size === 3);
	// A name the codec escapes is probed unescaped first; NotFound there falls to the escaped name.
	check('an escaped name that is absent is not held', (await asked(C.isHeld('a:b.txt'))).v === false);
}
{
	const { C } = tab({ dirErr: 'TypeMismatchError', fileErr: 'TypeMismatchError' });
	check('TypeMismatchError is the same answer', (await asked(C.isHeld('f.nope'))).v === false);
}

console.log('\nAny other error is a fault, never "not held"\n');
for (const name of ['UnknownError', 'InvalidStateError', 'NotAllowedError', 'SecurityError']) {
	{
		const { C, root } = tab({ dirErr: 'NotFoundError', fileErr: name });
		check(name + ' from the file lookup: isHeld throws', (await asked(C.isHeld('f.nope'))).threw === name, JSON.stringify(await asked(C.isHeld('f.nope'))));
		check(name + ' from the file lookup: fileUnderRoot throws', (await asked(C.fileUnderRoot(root, 'f.nope'))).threw === name);
		check(name + ' on the unescaped probe: isHeld throws', (await asked(C.isHeld('a:b.txt'))).threw === name);
	}
	{
		const { C, root } = tab({ dirErr: name, fileErr: 'NotFoundError' });
		check(name + ' from a directory: isHeld throws', (await asked(C.isHeld('nodir/f.txt'))).threw === name);
		check(name + ' from a directory: fileUnderRoot throws', (await asked(C.fileUnderRoot(root, 'nodir/f.txt'))).threw === name);
	}
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
