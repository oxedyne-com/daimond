/* ============================================================
   Test — a Diamond's folder is its own (HATE-7).
   ------------------------------------------------------------
   A Diamond holds an absolute folder on its runner, sent as the
   errand's `scope.root` (the runner's start directory,
   `errand_place`); choosing it never swaps the workspace.

     H1  a Diamond with a folder sends that root, holds beside it;
     H2  the workspace is untouched: the scope never asks the
         workspace root, and the turn needs no workspace folder;
     H3  a Diamond without one keeps the old scope;
     H4  a path outside every runner's reach is refused with its
         sentence; one inside, or any while no runner states a
         reach, is kept; a relative path is refused;
     H5  peer.js keeps a runner row's `reach` only as opened from its seal.

   Lifts the REAL functions out of daimond.js. Red proof:
   HATE7_SRC=<daimond.js at the base> node this file.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(process.env.HATE7_SRC || join(HERE, 'daimond.js'), 'utf8');
const PEER = readPage(process.env.HATE7_PEER || join(HERE, 'peer.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
function lift(name) {
	const a = SRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) { console.log('  (this revision lacks: ' + name + ')'); return ''; }
	return SRC.slice(a, SRC.indexOf('\n\t}\n', a) + 3);
}
const KEY = (/\n\tvar DIAMOND_FOLDER_KEY = [^;]*;/.exec(SRC) || ['var DIAMOND_FOLDER_KEY = "x";'])[0];

const store = {};
const localStorage = {
	getItem: (k) => (k in store ? store[k] : null),
	setItem: (k, v) => { store[k] = String(v); },
	removeItem: (k) => { delete store[k]; },
};
const env = { presence: {} };
const STR = {
	'tile.dlg_folder_abs':   'A folder is an absolute path, starting with /.',
	'tile.dlg_folder_reach': '{path} lies outside every folder its runner may reach.',
};
const names = ['readJson', 'diamondFolder', 'setDiamondFolder', 'folderInReach', 'errandScope',
	'folderRefusal'];
const body = KEY + '\n' + names.map(lift).join('\n') + '\nreturn {'
	+ names.map((n) => n + ': typeof ' + n + " === 'function' ? " + n + ' : null').join(', ') + '};';
const window = {
	DaimondPresence: { snapshot: () => env.presence },
};
// No `rootHere` is given: the workspace root went with marks (UNBLOCK-82, D-20261031-11), so a lifted
// function that still asked for it throws here, and H2 reads that none names it.
const F = new Function('localStorage', 'window',
	'diag', 't', body)(localStorage, window,
	() => {},
	(k, v) => String(STR[k] || k).replace(/\{(\w+)\}/g, (_, n) => (v && v[n]) || ''));
const need = (n) => { if (!F[n]) { check('has ' + n, false); return false; } return true; };

console.log('HATE-7: a Diamond\'s folder is its own');
if (need('setDiamondFolder') && need('errandScope')) {
	const dia = { id: 'c1', diamondId: 'd1' };
	F.setDiamondFolder('d1', '/srv/proj');
	const s = F.errandScope(dia, ['a.txt']);
	check('H1 a Diamond with a folder sends that root',
		s && s.root === '/srv/proj' && Array.isArray(s.holds) && s.holds[0] === 'a.txt', JSON.stringify(s));
	check('H2 the workspace root is never asked: no lifted function names rootHere', !/\brootHere\b/.test(body), // keeps: rootHere absence check: no lifted function may name it (UNBLOCK-82)
		names.filter((n) => /\brootHere\b/.test(lift(n))).join(', '));
	const other = { id: 'c2', diamondId: 'd2' };
	const s2 = F.errandScope(other, ['b']);
	check('H3 a Diamond without one sends the plain holds (no workspace folder)',
		Array.isArray(s2) && s2[0] === 'b', JSON.stringify(s2));
	F.setDiamondFolder('d1', '');
	check('H3 cleared, the folder is gone', Array.isArray(F.errandScope(dia, [])));
}
if (need('folderRefusal')) {
	env.presence = {};
	check('H4 no runner states a reach: kept', F.folderRefusal('/anywhere') === '');
	env.presence = { r1: { kind: 'runner', reach: ['/home/u/usr', '/srv/p/'] }, t1: {} };
	check('H4 inside a reach root: kept', F.folderRefusal('/home/u/usr/code') === '');
	check('H4 the root itself: kept', F.folderRefusal('/srv/p') === '');
	const why = F.folderRefusal('/etc');
	check('H4 outside: refused with its sentence',
		why === '/etc lies outside every folder its runner may reach.', why);
	check('H4 a sibling prefix is not inside', F.folderRefusal('/home/u/usrx') !== '');
	check('H4 a relative path is refused', F.folderRefusal('code/p') === STR['tile.dlg_folder_abs']);
	check('H4 empty clears', F.folderRefusal('') === '');
}
{
	// UNBLOCK-78: the row's reach is only ever the opened seal; a clear list is never kept
	// (peer.test.mjs proves the open, the refused purpose and the ignored clear list).
	const ok = /recOut\.reach = rr/.test(PEER) && /reachRoots\(String\(id\), rec\.reach\)/.test(PEER)
		&& !/Array\.isArray\(rec\.reach\)/.test(PEER);
	check('H5 peer.js keeps a runner row\'s reach only as opened from its seal', ok);
}
console.log((failures ? 'FAIL' : 'PASS') + ' ' + (checks - failures) + '/' + checks);
process.exit(failures ? 1 : 0);
