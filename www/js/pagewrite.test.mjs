/* ============================================================
   Test -- A PAGE WRITE AND ITS STAMP ARE ONE ACT, UNDER THE DIAMOND'S LOCK (www/js/daimond.js,
   `writeCrystalAsset`, PLB of the page-log guard).
   ------------------------------------------------------------
   A page's `save` wrote the file and then stamped the Diamond as two calls, holding nothing, and
   swallowed a failed stamp. So an import could land between the write and the stamp: it found this
   device's copy no fresher than the other's, laid the other copy over it, and the stamp that
   followed made the loss look like this device's newest change. And a stamp that failed answered
   the page as saved, leaving bytes down that the next sync would throw away.

   The REAL `writeCrystalAsset`, its `_cappWrite` chain and `holdDiamond` (this page's line; node has
   no Web Locks) are lifted from the file's own text and run against a `Wasm` stand-in. Proved: an
   import queued on the Diamond's lock while the write is in flight runs only after the write and
   the stamp, and so keeps the row; a failed stamp is a failed save, refused and in the trail; a
   build without `page_write` refuses rather than writing unstamped.

   Run:   node www/js/pagewrite.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const A = SRC.indexOf('\tasync function writeCrystalAsset(');
const Z = SRC.indexOf('\tvar _cappWrite = Promise.resolve();', A);
const LA = SRC.indexOf('\tvar DIAMOND_LOCKS = {};');
const LF = SRC.indexOf('\tfunction holdDiamond(', LA);
const LZ = SRC.indexOf('\n\t}\n', LF);
const found = A >= 0 && Z > A && LA >= 0 && LF > LA && LZ > LF;
check('writeCrystalAsset, its chain and holdDiamond are found in daimond.js', found, [A, Z, LA, LF, LZ].join(','));

const tick = () => new Promise((r) => setTimeout(r, 5));

// One Diamond `d1` with a stamp, a store with OPFS's whole-file read and write, and both doors: the
// old two calls (`store_write` then `touch_diamond`) and the one call (`page_write`). `stampFails`
// makes the stamp refuse; `onWritten` runs once the page's bytes are down, before the stamp.
function stand(opts) {
	const o = opts || {};
	const files = new Map(), ev = [];
	const d = { touched: 1, clock: 100 };
	const stamp = async () => {
		await tick();
		if (o.stampFails) { const e = new Error('meta.json is missing'); e.name = 'NotFoundError'; throw e; }
		d.touched = ++d.clock; ev.push('stamp');
	};
	const Wasm = {
		is_keeper_record: () => false,
		store_read: async (p) => { await tick(); if (!files.has(p)) throw new Error('no file ' + p); return files.get(p); },
		store_write: async (p, b) => { await tick(); files.set(p, b); ev.push('write'); if (o.onWritten) o.onWritten(); },
		touch_diamond: async () => { await stamp(); },
		page_write: async (id, p, text, append) => {
			await tick();
			const had = files.has(p) ? files.get(p) : null;
			let body = String(text);
			if (append && had) body = (had.slice(-1) === '\n' ? had : had + '\n') + body;
			files.set(p, body); ev.push('write');
			if (o.onWritten) o.onWritten();
			try { await stamp(); } catch (e) {
				if (had == null) files.delete(p); else files.set(p, had);
				throw new Error('The page\'s write was put back because the Diamond could not be stamped: ' + e.message);
			}
		},
	};
	if (o.noPageWrite) delete Wasm.page_write;
	const notes = [];
	const win = { DaimondTrail: { note: (w, n) => notes.push(w + ': ' + n) } };
	return { Wasm, win, files, ev, d, notes };
}
function lift(s) {
	const locks = SRC.slice(LA, LZ + 3);
	const src = SRC.slice(A, SRC.indexOf('\n', Z) + 1);
	return new Function('Wasm', 'window', 'navigator',
		locks + src + '\nreturn { write: writeCrystalAsset, hold: holdDiamond };')(s.Wasm, s.win, undefined);
}
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e && e.message || e) }));

if (found) {
	const P = 'diamonds/d1/log.txt';

	// Case 1: another device's copy, stamped 2 and without today's row, is imported while the row is
	// being written. The import takes the lock, and lays its copy down only where it is the fresher.
	{
		let api = null, imp = null;
		const s = stand({ onWritten: () => {
			if (imp) return;
			imp = api.hold('d1', async () => {
				s.ev.push('import');
				if (2 > s.d.touched) { s.files.set(P, 'set 1\n'); s.d.touched = 2; }
			});
		} });
		api = lift(s);
		s.files.set(P, 'set 1\n');
		const r = await settle(api.write('d1', P, 'log.txt', 'set 2', 'append'));
		await imp;
		check('an import between write and stamp waits: the write is answered', r.ok, JSON.stringify(r));
		check('an import between write and stamp waits: it runs only after the write and the stamp', s.ev.join(',') === 'write,stamp,import', s.ev.join(','));
		check('an import between write and stamp waits: the row is kept', s.files.get(P) === 'set 1\nset 2', JSON.stringify(s.files.get(P)));
	}

	// Case 2: the stamp fails.
	{
		const s = stand({ stampFails: true }), api = lift(s);
		s.files.set(P, 'set 1\n');
		const r = await settle(api.write('d1', P, 'log.txt', 'set 2', 'append'));
		check('a failed stamp is a failed save: the caller is refused', !r.ok, JSON.stringify(r));
		check('a failed stamp is a failed save: the trail says so', s.notes.length === 1 && /^crystal page: save failed: d1 /.test(s.notes[0]), JSON.stringify(s.notes));
		check('a failed stamp is a failed save: the file is as it was', s.files.get(P) === 'set 1\n', JSON.stringify(s.files.get(P)));
	}

	// Case 3: a build that has no one-call door refuses rather than writing unstamped.
	{
		const s = stand({ noPageWrite: true }), api = lift(s);
		const r = await settle(api.write('d1', P, 'log.txt', 'set 2', 'append'));
		check('a build without page_write refuses the save', !r.ok, JSON.stringify(r));
		check('a build without page_write writes nothing', !s.files.has(P), JSON.stringify(s.files.get(P)));
	}

	// Case 4: the lock is let go after the write, so the Diamond's next holder runs.
	{
		const s = stand(), api = lift(s);
		await settle(api.write('d1', P, 'log.txt', 'one', 'replace'));
		const after = await settle(Promise.race([api.hold('d1', async () => 'next'), tick().then(tick).then(tick).then(() => 'stuck')]));
		check('the Diamond\'s lock is let go after the write', after.ok && after.v === 'next', JSON.stringify(after));
	}
	await new Promise((r) => setTimeout(r, 50));
	check('no unhandled rejection', unhandled === 0, String(unhandled));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('pagewrite: all passed');
