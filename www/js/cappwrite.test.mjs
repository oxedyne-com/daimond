/* ============================================================
   Test -- A PAGE WRITE AFTER A FAILED ONE IS NOT LOST (www/js/daimond.js, `writeCrystalAsset`, r547 CAPPWRITE).
   ------------------------------------------------------------
   A page's writes run one at a time through the `_cappWrite` chain. The chain was built with
   `.then(body, onRejected)`, so when the write before had rejected, the onRejected ran in place of
   the body: the new write's bytes were never written, yet its caller was answered as if they had
   been. Any page write that followed a failed one was silently lost (r546 live and r547).

   The REAL `writeCrystalAsset` and its chain are lifted from the file's own text and run as written
   against a `Wasm` stand-in whose store can be told to refuse the next write. Proved: the failing
   write's caller is refused; the write after it lands its bytes, and its caller is answered only once
   they have landed; appends still serialise after a failure; the queue is the tab's, so a failure on
   one Diamond costs another nothing; the Diamond is stamped; a failed save leaves a trail note naming
   the Diamond and the kind of error, never the path or the words; the queue holds no rejection.

   Run:   node www/js/cappwrite.test.mjs
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
check('writeCrystalAsset and its chain are found in daimond.js', A >= 0 && Z > A, 'at ' + A + '..' + Z);

// A store with OPFS's whole-file read and write, a little slow, that refuses the next write when told.
function stand() {
	const files = new Map(), touched = [];
	let refuse = 0;
	const tick = () => new Promise((r) => setTimeout(r, 5));
	const Wasm = {
		is_keeper_record: () => false,
		store_read: async (p) => { await tick(); if (!files.has(p)) throw new Error('no file ' + p); return files.get(p); },
		store_write: async (p, b) => { await tick(); if (refuse > 0) { refuse--; const e = new Error('store refused ' + p + ' ' + b); e.name = 'QuotaExceededError'; throw e; } files.set(p, b); },
		touch_diamond: async (id) => { touched.push(id); },
	};
	const notes = [];
	const win = { DaimondTrail: { note: (w, d) => notes.push(w + ': ' + d) } };
	return { Wasm, win, files, touched, notes, refuseNext: () => { refuse++; } };
}
function lift(s) {
	const src = SRC.slice(A, SRC.indexOf('\n', Z) + 1);
	return new Function('Wasm', 'window', src + '\nreturn writeCrystalAsset;')(s.Wasm, s.win);
}
let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String(e && e.message || e) }));

if (A >= 0 && Z > A) {
	const P = 'diamonds/d1/log.txt';

	// Case 1: the write after a failed one, issued while the failure is still in flight.
	{
		const s = stand(), write = lift(s);
		s.refuseNext();
		const p1 = settle(write('d1', P, 'log.txt', 'first', 'replace'));
		const p2 = write('d1', P, 'log.txt', 'second', 'replace').then(() => s.files.get(P));
		const r1 = await p1, r2 = await settle(p2);
		check('the failing write\'s caller is refused', !r1.ok && /refused/.test(r1.e), JSON.stringify(r1));
		check('the next write lands its bytes', s.files.get(P) === 'second', JSON.stringify(s.files.get(P)));
		check('and its caller is answered only once they have landed', r2.ok && r2.v === 'second', JSON.stringify(r2));
	}

	// Case 2: the write after a failed one, issued once the failure has settled.
	{
		const s = stand(), write = lift(s);
		s.refuseNext();
		const r1 = await settle(write('d1', P, 'log.txt', 'first', 'replace'));
		const r2 = await settle(write('d1', P, 'log.txt', 'later', 'replace').then(() => s.files.get(P)));
		check('a settled failure: its caller was refused', !r1.ok, JSON.stringify(r1));
		check('a settled failure: the next write lands, answered after', r2.ok && r2.v === 'later' && s.files.get(P) === 'later', JSON.stringify(r2));
	}

	// Case 3: two appends behind a failed one both land, in order, neither losing the other.
	{
		const s = stand(), write = lift(s);
		s.files.set(P, 'set 1\n');
		s.refuseNext();
		const r0 = settle(write('d1', P, 'log.txt', 'lost on purpose', 'append'));
		const ra = settle(write('d1', P, 'log.txt', 'set 2', 'append'));
		const rb = settle(write('d1', P, 'log.txt', 'set 3', 'append'));
		const got = [await r0, await ra, await rb];
		check('appends behind a failure: the failure is refused, the two after it answered', !got[0].ok && got[1].ok && got[2].ok, JSON.stringify(got));
		check('appends behind a failure: both lines are kept, in order', s.files.get(P) === 'set 1\nset 2\nset 3', JSON.stringify(s.files.get(P)));
		check('the Diamond is stamped for each write that landed', s.touched.length === 2, String(s.touched.length));
	}

	// Case 4: the queue is the tab's: a failure on Diamond X, then a write on Diamond Y.
	{
		const s = stand(), write = lift(s);
		const Y = 'diamonds/d2/log.txt';
		s.refuseNext();
		const rx = settle(write('d1', P, 'log.txt', 'on x', 'replace'));
		const ry = settle(write('d2', Y, 'log.txt', 'on y', 'replace').then(() => s.files.get(Y)));
		const gx = await rx, gy = await ry;
		check('a failure on one Diamond: its caller is refused', !gx.ok, JSON.stringify(gx));
		check('a failure on one Diamond: the next Diamond\'s write lands, answered after', gy.ok && gy.v === 'on y', JSON.stringify(gy));
		check('the failed save is in the trail, by Diamond and kind of error', s.notes.length === 1 && s.notes[0] === 'crystal page: save failed: d1 QuotaExceededError', JSON.stringify(s.notes));
		check('the trail note names no path and no words', !s.notes.some((n) => /log\.txt|diamonds\/|on x/.test(n)), JSON.stringify(s.notes));
		check('a write that lands leaves no trail note', !s.notes.some((n) => / d2 /.test(n + ' ')), JSON.stringify(s.notes));
	}
	await new Promise((r) => setTimeout(r, 50));
	check('the queue holds no rejection (no unhandled rejection)', unhandled === 0, String(unhandled));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('cappwrite: all passed');
