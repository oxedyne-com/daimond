/* ============================================================
   Test -- a browser that keeps no files (cloud.js `fileStore`).
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js over three browsers: one with no
   `navigator.storage.getDirectory` at all (Playwright's WebKit, an
   older Safari, iOS Private Browsing), one whose `getDirectory`
   rejects (a private window elsewhere, site data blocked or cleared),
   and one whose store works.

   THE BUG (the reopen rehearsal, 2026-09-25). `refreshPaths` asked
   `isHeld` of every workspace path in the index, `isHeld` opened the
   OPFS root, and with no OPFS that threw out of the pull's `chunked`
   section. The merge was reported unfinished, the version never
   adopted, and every push after it met a 409: up to 48 refusals a
   minute from the WebKit iPhone.

   Asserted: `refreshPaths` never throws for want of a store and
   counts every path away (the safe answer: `noteFileTombs` keeps an
   away path rather than read it as deleted); `fileStore` answers the
   right word and announces a change; a fetch says so in a sentence;
   a working store is untouched.

   Run:   node www/js/cloudstore.test.mjs
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

const IX = {
	'notes/big.txt': { v: 2, size: 204800, bytes: 204800, key: 'k1', chunks: [{ addr: 'a1', size: 10 }] },
	'@c/chat1':      { v: 2, size: 900, bytes: 900, key: 'k2', chunks: [{ addr: 'a2', size: 10 }] },
};

/// One tab holding cloud.js, over a browser whose file store is `mode`.
function tab(mode) {
	const store = new Map([['daimond-cloud-index', JSON.stringify(IX)]]);
	const ls = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const events = [];
	const win = { addEventListener: () => {}, dispatchEvent: (ev) => { events.push(ev); return true; } };
	const empty = { getDirectoryHandle: async () => { throw Object.assign(new Error('absent'), { name: 'NotFoundError' }); },
		getFileHandle: async () => { throw Object.assign(new Error('absent'), { name: 'NotFoundError' }); } };
	const storage = mode === 'none' ? {}
		: mode === 'refused' ? { getDirectory: async () => { throw Object.assign(new Error('not allowed'), { name: 'SecurityError' }); } }
		: { getDirectory: async () => empty };
	loadStore(win, ls);
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	const fn = new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}');
	class CE { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
	fn(win, ls, { storage }, setTimeout, clearTimeout, { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, CE);
	return { C: win.DaimondCloud, events, win };
}

for (const mode of ['none', 'refused', 'held']) {
	console.log('\n' + mode.toUpperCase() + ': a browser whose file store is ' + mode + '\n');
	const { C, events, win } = tab(mode);
	win.DaimondChunks = {};
	let threw = null, away = null;
	try { away = await C.refreshPaths(); } catch (e) { threw = e; }
	check('refreshPaths does not throw', !threw, threw && String(threw));
	check('the workspace path counts away, and a content key never does',
		!!away && away['notes/big.txt'] === 204800 && !('@c/chat1' in away), JSON.stringify(away));
	check('fileStore answers ' + JSON.stringify(mode), C.fileStore().state === mode, JSON.stringify(C.fileStore()));
	const told = events.filter((e) => e.type === 'daimond:file-store').map((e) => e.detail && e.detail.state);
	check('and the change was announced once', told.length === 1 && told[0] === mode, JSON.stringify(told));
	const said = await C.fetch('notes/big.txt', false).catch((e) => 'THREW ' + e);
	if (mode === 'held') {
		check('[ctl] a working store is asked about the file, not refused', !/cannot keep files/.test(said), said);
	} else {
		check('a fetch is refused in a sentence', /^Error: this browser cannot keep files/.test(said)
			&& /notes\/big\.txt stays in cloud storage/.test(said), said);
		const ev = await C.evict('notes/big.txt').catch((e) => 'THREW ' + e);
		check('and a free finds nothing to free', /^OK: /.test(ev), ev);
	}
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
