/* ============================================================
   Test -- the TurnView vectors through the wasm (P2.2).
   ------------------------------------------------------------
   src/errand/testdata/turnview_vectors.json is the one statement of
   how a turn's log rows fold. The engine runs it in Rust
   (src/errand/tests.rs); this runs the same cases through the
   exported `turnview_apply`, one row per call with the view passed
   back as JSON, as the page will. Both must agree on every row's
   `applied` code and on the final view.

     node www/js/errandwasm.test.mjs

   Needs www/pkg (dev/build-wasm.sh --no-opt).
   ============================================================ */
import { readFileSync } from 'node:fs';
import { deepStrictEqual } from 'node:assert';
import { loadSeal } from './sealfixture.mjs';

const VECTORS = new URL('../../src/errand/testdata/turnview_vectors.json', import.meta.url);

const wasm = await loadSeal();
if (typeof wasm.turnview_apply !== 'function') throw new Error('the wasm exports no turnview_apply');

const tv = JSON.parse(readFileSync(VECTORS, 'utf8'));
if (!Array.isArray(tv.cases) || tv.cases.length < 4) throw new Error('turnview_vectors.json: fewer than 4 cases');

let fails = 0;
for (const c of tv.cases) {
	// TurnView::new: an open turn with nothing folded.
	let view = { turn: c.turn, last: 0, state: 'open', rows: [] };
	const applied = [];
	for (const r of c.rows) {
		const out = JSON.parse(wasm.turnview_apply(JSON.stringify(view), JSON.stringify(r)));
		view = out.view;
		applied.push(out.applied);
	}
	try {
		deepStrictEqual(applied, c.applied, 'applied');
		deepStrictEqual(view, c.view, 'view');
		console.log('ok   ' + c.name);
	} catch (e) {
		fails++;
		console.log('FAIL ' + c.name + ': ' + e.message);
	}
}
console.log(`${tv.cases.length - fails}/${tv.cases.length} TurnView vectors agree through the wasm`);

// P2.2f: a tool row whose args are a 60 kB file_write goes whole in pieces (the engine's
// change_rows cuts the body's plaintext JSON); the page folds it back through turnview_apply.
{
	const args = JSON.stringify({ path: 'rw/big.txt', content: 'a'.repeat(60000) + 'é€😀' });
	const body = { mid: 't-1', role: 'tool_log', text: 'file_write', meta: { name: 'file_write', args } };
	const plain = [...JSON.stringify(body)];	// by code point, as the engine cuts on characters
	const size = 16000;
	let view = { turn: 't9', last: 0, state: 'open', rows: [] };
	const applied = [];
	for (let i = 0, n = 1; i < plain.length; i += size, n++) {
		const piece = { piece: plain.slice(i, i + size).join('') };
		if (i === 0) piece.first = true;
		if (i + size >= plain.length) piece.last = true;
		const head = { seq: n, turn: 't9', n, kind: i === 0 ? 'msg' : 'more', member: 'acct', daimon: 'd1', at: 2000 + n, len: 0 };
		const out = JSON.parse(wasm.turnview_apply(JSON.stringify(view), JSON.stringify({ head, body: piece })));
		view = out.view;
		applied.push(out.applied);
	}
	try {
		deepStrictEqual(applied, applied.map(() => 'taken'), 'applied');
		deepStrictEqual(view.rows.length, 1, 'rows');
		deepStrictEqual(view.rows[0].meta, body.meta, 'the tool row is not whole');
		deepStrictEqual([view.rows[0].seq, view.rows[0].at], [1, 2001], 'the body takes its first piece\'s seq');
		deepStrictEqual(view.joining, undefined, 'nothing left joining');
		console.log(`ok   a 60 kB tool row folds whole from ${applied.length} pieces`);
	} catch (e) {
		fails++;
		console.log('FAIL a 60 kB tool row in pieces: ' + e.message);
	}
}
if (fails) process.exit(1);
