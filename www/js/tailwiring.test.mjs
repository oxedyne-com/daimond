/* ============================================================
   Test — #22's tail-note WIRING (www/js/daimond.js), not just its render.

   verify_p22table.mjs proves `_tailNoteTable` renders correctly when called
   directly. It never proved the table is ever CALLED on a real turn: the
   engine's tail note ("[Daimond: this turn changed N files (vV): ...]") is
   the LAST element of the array `fa.steer_crystal(...)` returns, and until
   this fix that array was written only into `rec.session.msgs` (what the
   NEXT turn sends) -- never into `rec.messages` (what `renderHistory` /
   `drawHistoryMessage` actually draw). So `appendUserMessage` -> `_parseTailNote`
   -> `_tailNoteTable` was never reached on a real turn; a deployed feature
   that never renders.

   Fixed by pushing the tail note onto `rec.messages` (and drawing it live via
   `appendUserMessage` when the chat is on screen) right after `steer_crystal`
   returns, mirroring the exact shape the typed question is pushed with
   (daimond.js ~47924) and the `iturn` stamping a detached runner turn's
   answer gets (~48327).

   A second, latent bug rode along: `_tailNoteTable` joined the tail note's
   version number `p.v` against a manifest's schema-version field `m.v`
   (always 1) instead of `m.version` (the real version number, e.g. 58 for
   `{"version":58,"v":1,...}` -- see wasm/diamond.rs:2331's
   `{{"version":{},{}}}`). Every row therefore drew "·", never "+N −M".

   BOTH pieces of real source are lifted from daimond.js with a brace-balanced
   scan (the same technique devicename.test.mjs uses) -- not retyped, read
   from the file every run, so a regression in either is what reddens this.

   Run:  node www/js/tailwiring.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');

/// Lifts `function name(...) { ... }` (or `async function`) out of `src` by
/// counting braces from its opening one, so nesting inside (an `if`, an
/// object literal) cannot end the scan early. Adapted from devicename.test.mjs.
function extractFn(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found in daimond.js: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

/// Lifts a single-line `var NAME = ...;` declaration.
function extractVar(src, name) {
	const re = new RegExp('\\n\\tvar ' + name + '\\s*=[^\\n]*;');
	const m = re.exec(src);
	if (!m) throw new Error('var not found in daimond.js: ' + name);
	return m[0].trim();
}

/// Lifts the exact text between two unique, one-line anchors (inclusive of
/// the start line, exclusive of the end line) -- used for the wiring block,
/// which is inline code inside `runSteer`, not a function of its own.
function extractBetween(src, startNeedle, endNeedle) {
	const s = src.indexOf(startNeedle);
	if (s < 0) throw new Error('start anchor not found: ' + startNeedle);
	const e = src.indexOf(endNeedle, s);
	if (e < 0) throw new Error('end anchor not found: ' + endNeedle);
	return src.slice(s, e);
}

async function main() {

	// ── (A) THE WIRING: the tail note reaches `rec.messages` ──────────
	console.log('(A) the tail note, the LAST element of `after`, lands in rec.messages');
	{
		const parseTailNoteSrc = extractFn(src, '_parseTailNote');
		const wiringSrc = extractBetween(src,
			'// #22: the engine appends the end-of-turn changed-files note as the LAST',
			'// The ending, last, under whatever the turn managed to say.');
		// The lifted block references `after`, `rec`, `detached`, `onScreen`,
		// `appendUserMessage`, `newMid` and `_parseTailNote` exactly as
		// `runSteer` does; here they are the function's own parameters/closure.
		const wrapperBody = parseTailNoteSrc + '\n'
			+ 'function applyTailNoteWiring(after, rec, detached, onScreen, appendUserMessage, newMid) {\n'
			+ wiringSrc + '\n'
			+ '}\n'
			+ 'return { applyTailNoteWiring: applyTailNoteWiring };\n';
		const wiring = new Function(wrapperBody)();

		const TAIL = '[Daimond: this turn changed 2 files (v58): a.txt, b.txt. The user can '
			+ 'restore any of them from History, and file_revert does the same when they ask.]';

		// (a1) an ordinary (non-detached) turn: the note is pushed AND drawn live.
		{
			const rec = { messages: [{ role: 'assistant', content: 'Done.', mid: 'A1', ts: 100 }] };
			const after = [
				{ role: 'user', content: 'edit the files' },
				{ role: 'assistant', content: 'Done.' },
				{ role: 'user', content: TAIL },
			];
			const drawn = [];
			const appendUserMessage = (text, ts) => drawn.push({ text: text, ts: ts });
			wiring.applyTailNoteWiring(after, rec, null, () => true, appendUserMessage, () => 'MID_TAIL');

			check('(a1) rec.messages grew by exactly one row',
				rec.messages.length === 2, rec.messages.length);
			const last = rec.messages[rec.messages.length - 1];
			check('(a2) the pushed row is the tail note, verbatim',
				last && last.role === 'user' && last.content === TAIL);
			check('(a3) it carries a fresh mid (not the assistant reply\'s)',
				last.mid === 'MID_TAIL');
			check('(a4) a non-detached turn stamps no iturn (matches the typed-question shape, ~47924)',
				last.iturn === undefined);
			check('(a5) onScreen()=true drew it live via appendUserMessage',
				drawn.length === 1 && drawn[0].text === TAIL && drawn[0].ts === last.ts);
		}

		// (a6) off-screen: still recorded, never drawn (matches every other
		// push in this turn, which all guard the draw with `onScreen()`).
		{
			const rec = { messages: [] };
			const after = [{ role: 'user', content: TAIL }];
			const drawn = [];
			wiring.applyTailNoteWiring(after, rec, null, () => false, (t, ts) => drawn.push(t), () => 'M2');
			check('(a6) off-screen: the row is still recorded', rec.messages.length === 1);
			check('(a7) off-screen: nothing is drawn', drawn.length === 0);
		}

		// (a8)/(a9) a detached (runner) turn stamps `iturn`, the same finished-
		// guard field the assistant reply gets at ~48327-48329.
		{
			const rec = { messages: [] };
			const after = [{ role: 'user', content: TAIL }];
			wiring.applyTailNoteWiring(after, rec, { turnId: 'ERRAND-9' }, () => false, () => {}, () => 'M3');
			check('(a8) a detached turn stamps iturn with the errand\'s turn id',
				rec.messages[0] && rec.messages[0].iturn === 'ERRAND-9');
			check('(a9) mid is still fresh (mid !== iturn: distinct fields)',
				rec.messages[0].mid === 'M3');
		}

		// (a10) idempotent: calling the wiring twice over the same `after`/`rec`
		// (as a defensive re-entry would) never double-pushes the same note.
		{
			const rec = { messages: [] };
			const after = [{ role: 'user', content: TAIL }];
			wiring.applyTailNoteWiring(after, rec, null, () => false, () => {}, () => 'M4');
			wiring.applyTailNoteWiring(after, rec, null, () => false, () => {}, () => 'M5');
			check('(a10) a second pass over the same tail note does not duplicate it',
				rec.messages.length === 1, rec.messages.length);
		}

		// (a11) a turn that changed nothing (no tail note as the last message
		// of `after`) leaves rec.messages exactly as it was.
		{
			const rec = { messages: [{ role: 'assistant', content: 'All good, nothing to change.', mid: 'A1', ts: 1 }] };
			const after = [{ role: 'user', content: 'is everything ok?' }, { role: 'assistant', content: 'All good, nothing to change.' }];
			wiring.applyTailNoteWiring(after, rec, null, () => true, () => { throw new Error('must not draw'); }, () => 'M6');
			check('(a11) no tail note as the last message: rec.messages is untouched',
				rec.messages.length === 1);
		}
	}

	// ── (B) THE JOIN: `_tailNoteTable` draws real +N −M deltas ────────
	console.log('\n(B) _tailNoteTable joins the tail note to its manifest by VERSION NUMBER');
	{
		function makeEl(tag) {
			return {
				tagName: tag, className: '', textContent: '', title: '', type: '',
				_children: [], _listeners: {},
				classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
				appendChild(child) {
					const i = this._children.indexOf(child);
					if (i >= 0) this._children.splice(i, 1);
					this._children.push(child);
					return child;
				},
				insertBefore(child, ref) {
					const i = this._children.indexOf(ref);
					this._children.splice(i < 0 ? this._children.length : i, 0, child);
					return child;
				},
				// #22 rework (f1fa6e0a): `paintDelta` clears the delta cell with
				// `replaceChildren()` before appending its two `.tf-add`/`.tf-del`
				// spans, rather than setting `.textContent` directly.
				replaceChildren() { this._children = []; },
				addEventListener(type, fn) { this._listeners[type] = fn; },
				querySelector() { return null; },
				remove() {},
			};
		}
		const document = { createElement: (tag) => makeEl(tag) };
		function tn(key, n) {
			if (key === 'chat.turn_files') return n + ' file' + (n === 1 ? '' : 's') + ' changed this turn';
			if (key === 'chat.turn_files_more') return 'Show ' + n + ' more';
			return key;
		}
		// The exact wasm/diamond.rs:2331 shape: `version` is the real version
		// number, `v` the manifest SCHEMA version (always 1) -- the field the
		// old, broken join used.
		const manifestsFixture = [{
			version: 58, v: 1, ts: 1, cause: 'turn', turn: '', note: '', truncated: 0,
			files: [
				{ path: 'a.txt', hash: 'HASHA1', was: 'HASHA0', gone: false },
				{ path: 'b.txt', hash: 'HASHB1', gone: false }, // a new file: no `was`
			],
		}];
		const DaimondVersions = {
			manifests: async () => manifestsFixture,
			diff: async (id, was, hash) => (was === 'HASHA0' && hash === 'HASHA1') ? { add: 3, del: 1, rows: [] } : null,
		};
		function openFile() { /* not exercised: no row is clicked */ }

		const tableSrc = [
			extractVar(src, '_TAIL_MORE'),
			extractFn(src, '_parseTailNote'),
			extractFn(src, '_tailNoteTable'),
			extractFn(src, '_turnFileRow'),
		].join('\n');
		const wrapperBody = 'var currentDiamond = null;\n' + tableSrc
			+ '\nreturn { tailNoteTable: _tailNoteTable, setCurrentDiamond: function (d) { currentDiamond = d; } };\n';
		const table = new Function('document', 'tn', 'DaimondVersions', 'openFile', wrapperBody)(
			document, tn, DaimondVersions, openFile);
		table.setCurrentDiamond({ id: 'd1' });

		const TAIL = '[Daimond: this turn changed 2 files (v58): a.txt, b.txt. The user can '
			+ 'restore any of them from History, and file_revert does the same when they ask.]';
		const box = await table.tailNoteTable(TAIL);
		// The a.txt row's delta is filled by a fire-and-forget `.then()`
		// (real code, ~daimond.js:12437); flush it before reading textContent.
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		check('(b1) the table is built (the tail note parses)', !!box);
		check('(b2) box carries the .turn-files class', box.className === 'turn-files');
		const head = box._children[0];
		check('(b3) the head names the count', head && /\b2\b/.test(head.textContent), head && head.textContent);
		const rows = box._children[1];
		check('(b4) two rows, no fold button (2 files < the 6-row fold)', rows && rows._children.length === 2);

		const rowA = rows._children[0];
		const [nameA, deltaA] = rowA._children;
		check('(b5) row 1 opens a.txt', nameA.textContent === 'a.txt');
		// THE JOIN-FIX PROOF: with the old `m.v === p.v` join (always 1 === 58,
		// false), `byPath` would be empty and `paintDelta` would never fire, so
		// this would read '·' forever. Stale as of the #22 rework (f1fa6e0a):
		// `paintDelta` now clears the cell and appends two spans (`.tf-add`
		// "+N", `.tf-del` "-M") rather than setting `.textContent` to one
		// string -- verify_p22table.mjs proves the CSS/shape of that rework
		// but never drives the live version join, so that proof stays here,
		// updated to the current two-span shape rather than removed.
		const [addA, delA] = deltaA._children;
		check('(b6) row 1\'s delta is +3/−1 -- the manifest joined by VERSION NUMBER (the fix)',
			!!addA && !!delA && addA.className === 'tf-add' && addA.textContent === '+3'
			&& delA.className === 'tf-del' && delA.textContent === '−1',
			deltaA._children.map((c) => c.className + ':' + c.textContent));

		const rowB = rows._children[1];
		const [nameB, deltaB] = rowB._children;
		check('(b7) row 2 opens b.txt', nameB.textContent === 'b.txt');
		check('(b8) row 2 (a new file, no `was`) has no auto-diff: stays "·"',
			deltaB.textContent === '·', deltaB.textContent);

		// Prove (b6) really is the join, not a fluke: with the manifest at a
		// version the tail note does NOT name, the join finds nothing and both
		// rows read "·" again -- the pre-fix behaviour, still reachable when the
		// versions genuinely do not correspond.
		const missTable = new Function('document', 'tn', 'DaimondVersions', 'openFile', wrapperBody)(
			document, tn, { manifests: async () => [{ version: 99, v: 1, files: [] }], diff: DaimondVersions.diff }, openFile);
		missTable.setCurrentDiamond({ id: 'd1' });
		const missBox = await missTable.tailNoteTable(TAIL);
		await new Promise((r) => setImmediate(r));
		const missDeltaA = missBox._children[1]._children[0]._children[1];
		check('(b9) a genuinely non-matching manifest version still reads "·" (the join is real, not a stub)',
			missDeltaA.textContent === '·', missDeltaA.textContent);
	}

	console.log(failures ? ('\nFAIL -- ' + failures + '/' + checks + ' checks') : ('\nALL PASS -- ' + checks + '/' + checks));
	process.exit(failures ? 1 : 0);
}

main();

