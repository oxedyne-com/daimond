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
			extractFn(src, 'openTurnFile'),
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

	// ── (C) THE CLICKS: name opens the file, the delta folds a REAL diff ──
	//
	// (B) proves the table PAINTS. It never clicks a row. Live (owner, 2026-09-19)
	// both clicks were dead: the name link opened nothing, and the +N −M diff came
	// up empty. Two root causes, one per click, each proven fail-first here:
	//
	//   * the NAME click resolved its opener from `window.DaimondFiles.open` (never
	//     exposed -- js:39069) and a bare `openFile` (defined inside the Files
	//     closure, not in scope in the chat closure), so `open` was null and the
	//     click did nothing. The opener is `Files.open`, in scope in the one IIFE.
	//   * the DELTA click's `paintDiff` routed a pure-add pair (`op '+'`) into the
	//     deletion branch, which blanks the right cell -- so an all-add diff
	//     (`+N −0`, a new file) rendered as empty rows.
	//
	// The harness mirrors the REAL scope: `window` exists but exposes no `open`,
	// there is NO bare `openFile` (deliberately not a Function param), and `Files`
	// carries the real door. On the pre-fix tree (c1) and (c3) fail.
	console.log('\n(C) the row clicks: name -> opener; delta -> a non-empty side-by-side diff');
	{
		function makeEl(tag) {
			return {
				tagName: tag, className: '', textContent: '', title: '', type: '',
				_children: [], _listeners: {},
				classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
				appendChild(child) { const i = this._children.indexOf(child); if (i >= 0) this._children.splice(i, 1); this._children.push(child); return child; },
				insertBefore(child, ref) { const i = this._children.indexOf(ref); this._children.splice(i < 0 ? this._children.length : i, 0, child); return child; },
				replaceChildren() { this._children = []; },
				addEventListener(type, fn) { this._listeners[type] = fn; },
				querySelector(sel) { return findEl(this, sel); },
				remove() {},
			};
		}
		// A node's classes come from BOTH `.className` (set as a whole string, e.g.
		// paintDiff's `wrap.className = 'tf-sbs'`) and `classList.add(...)`; a real
		// querySelector sees both, so the stub must too.
		function classesOf(el) {
			const set = new Set((el.classList && el.classList._s) ? el.classList._s : []);
			String(el.className || '').split(/\s+/).forEach((c) => { if (c) set.add(c); });
			return set;
		}
		function matchesSel(el, sel) { return sel.charAt(0) === '.' ? classesOf(el).has(sel.slice(1)) : el.className === sel; }
		function findEl(el, sel) {
			for (const c of (el._children || [])) { if (matchesSel(c, sel)) return c; const d = findEl(c, sel); if (d) return d; }
			return null;
		}
		function textsOf(el, acc) { acc = acc || []; if (el.textContent) acc.push(el.textContent); (el._children || []).forEach((c) => textsOf(c, acc)); return acc; }

		const document = { createElement: (tag) => makeEl(tag) };
		function tn(key, n) {
			if (key === 'chat.turn_files') return n + ' file' + (n === 1 ? '' : 's') + ' changed this turn';
			if (key === 'chat.turn_files_more') return 'Show ' + n + ' more';
			return key;
		}
		// a.txt is an UPDATE (was -> now); b.txt is a NEW file (no `was`, all-add);
		// code/ws.txt is a NEW WORKSPACE file whose LIVE open fails (as a `code/…`
		// path with no folder mounted does), so it must fall back to the snapshot.
		const manifestsFixture = [{
			version: 7, v: 1, files: [
				{ path: 'a.txt', hash: 'A1', was: 'A0', gone: false },
				{ path: 'b.txt', hash: 'B1', gone: false },
				{ path: 'code/ws.txt', hash: 'C1', gone: false },
			],
		}];
		const DIFFS = {
			'A0|A1': { add: 1, del: 1, rows: [{ op: '-', text: 'old line' }, { op: '+', text: 'new line' }] },
			'|B1':   { add: 2, del: 0, rows: [{ op: '+', text: 'added alpha' }, { op: '+', text: 'added beta' }] },
			'|C1':   { add: 3, del: 0, rows: [{ op: '+', text: 'ws one' }, { op: '+', text: 'ws two' }] },
		};
		const BODIES = { 'A1': 'A body', 'B1': 'B body', 'C1': 'the workspace snapshot body' };
		const bodySpy = [];
		const DaimondVersions = {
			manifests: async () => manifestsFixture,
			diff: async (id, was, now) => DIFFS[(was || '') + '|' + (now || '')] || null,
			body: async (id, hash) => { bodySpy.push({ id: id, hash: hash }); return BODIES[hash] || null; },
		};
		// The real opener, in scope in the app's one IIFE as `Files.open`. A live
		// workspace read fails for `code/…` (NotFound), exactly as in the browser --
		// UNLESS the caller supplies the snapshot content (the read-only fallback),
		// which always resolves.
		const openSpy = [];
		const Files = { open: (p, opts) => {
			openSpy.push({ path: p, opts: opts });
			if (/^code\//.test(p) && !(opts && typeof opts.content === 'string')) {
				return Promise.reject(new Error('OPFS: NotFound'));
			}
			return Promise.resolve();
		} };
		// `window` exists but exposes NO `open` -- the exact shape of
		// window.DaimondFiles at daimond.js:39069. And `openFile` is deliberately
		// NOT a Function parameter, so it is out of scope here as it is in the real
		// chat closure: the pre-fix opener resolution therefore yields null.
		const windowStub = { DaimondFiles: { entries() {}, folder() { return null; } } };

		const tableSrc = [
			extractVar(src, '_TAIL_MORE'),
			extractFn(src, '_parseTailNote'),
			extractFn(src, '_tailNoteTable'),
			extractFn(src, 'openTurnFile'),
			extractFn(src, '_turnFileRow'),
		].join('\n');
		const wrapperBody = 'var currentDiamond = { id: "d1" };\n' + tableSrc
			+ '\nreturn { tailNoteTable: _tailNoteTable };\n';
		// `DaimondFiles` is passed as its own name too: in the browser a bare
		// `DaimondFiles` IS `window.DaimondFiles` (a global), and the pre-fix code
		// reads it bare -- so the harness resolves it the same way. It has no
		// `open`, exactly as the real public object does not (js:39069). The fixed
		// code ignores both and reaches `Files.open`.
		const table = new Function('document', 'tn', 'DaimondVersions', 'window', 'DaimondFiles', 'Files', wrapperBody)(
			document, tn, DaimondVersions, windowStub, windowStub.DaimondFiles, Files);

		const TAIL = '[Daimond: this turn changed 3 files (v7): a.txt, b.txt, code/ws.txt. The user can '
			+ 'restore any of them from History, and file_revert does the same when they ask.]';
		const box = await table.tailNoteTable(TAIL);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));

		const rows = box._children[1];
		const rowA = rows._children[0], rowB = rows._children[1], rowC = rows._children[2];
		const [nameA, deltaA] = rowA._children;
		const deltaB = rowB._children[1];
		const nameC = rowC._children[0];

		// (c1) NAME CLICK on a live/store file -> the opener is invoked with the path.
		nameA._listeners.click({ stopPropagation() {} });
		await new Promise((r) => setImmediate(r));
		check('(c1) clicking a name invokes the opener with the file path',
			openSpy.some((o) => o.path === 'a.txt'), JSON.stringify(openSpy));

		// (c2) DELTA CLICK on an UPDATE -> a non-empty side-by-side with BOTH sides.
		// (A regression guard: the update path was already right; this keeps it so.)
		await deltaA._listeners.click({ stopPropagation() {} });
		const sbsA = rowA.querySelector('.tf-sbs');
		const bodyA = textsOf(sbsA || makeEl('x')).join('\n');
		check('(c2) an update\'s delta folds in a non-empty diff carrying both sides',
			!!sbsA && bodyA.indexOf('old line') >= 0 && bodyA.indexOf('new line') >= 0, bodyA);

		// (c3) DELTA CLICK on a NEW file -> it OPENS the file and renders NO diff.
		// PRE-FIX: a new file's delta drew a two-column side-by-side with an empty
		// left column -- the broken "mess" the owner reported. Now: no `.tf-sbs`, and
		// the opener is reached instead.
		const openBeforeC3 = openSpy.length;
		await deltaB._listeners.click({ stopPropagation() {} });
		await new Promise((r) => setImmediate(r));
		const sbsB = rowB.querySelector('.tf-sbs');
		check('(c3) a new file\'s delta opens the file and renders no diff mess',
			!sbsB && openSpy.length > openBeforeC3 && openSpy[openSpy.length - 1].path === 'b.txt',
			JSON.stringify({ sbsB: !!sbsB, last: openSpy[openSpy.length - 1] }));

		// (c4) NAME CLICK on a WORKSPACE file whose live open FAILS -> it falls back
		// to the version-store snapshot, opened READ-ONLY with the recorded content.
		// PRE-FIX: the click called Files.open once, it threw NotFound, and nothing
		// happened -- the owner's "click the path, nothing".
		bodySpy.length = 0;
		nameC._listeners.click({ stopPropagation() {} });
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		const roOpen = openSpy.filter((o) => o.path === 'code/ws.txt')
			.find((o) => o.opts && o.opts.readOnly && o.opts.content === 'the workspace snapshot body');
		check('(c4) a workspace file that will not open live falls back to the snapshot, read-only',
			bodySpy.some((b) => b.hash === 'C1') && !!roOpen && !rowC.querySelector('.tf-sbs'),
			JSON.stringify({ bodySpy, opens: openSpy.filter((o) => o.path === 'code/ws.txt') }));
	}

	// (D) the +95s dispatch backstop stands down while a LOCAL recovery of the turn is
	// in flight. The milestone audit (D-11) found runDispatchFallback would re-seat a
	// turn to another desktop even while dispatchToPeer was recovering it locally (a
	// refused hand-off holds the SELF lease for the whole run) -- a second placeholder
	// and a stray errand. The two-line `_localRecovering` guard fixes it; this lifts the
	// REAL runDispatchFallback out of daimond.js and locks the guard both ways.
	{
		const fnSrc = extractFn(src, 'runDispatchFallback');
		const makeFn = (recovering) => {
			const retrySpy = [], localSpy = [];
			const peer  = { REASON_DISPATCHED: 'dispatched', recoverDecision: () => true, runErrand: () => {} };
			const lease = { record: () => null };
			const stubs = {
				window:                      { DaimondPeer: peer, DaimondLease: lease },
				DaimondPeer:                 peer,
				DaimondLease:                lease,
				chats:                       [{ id: 'c1', messages: [{ why: 'dispatched', iturn: 't1' }] }],
				dispatchedChat:              () => null,
				dispatchedTurnFinished:      () => false,
				selfDeviceId:                () => 'self',
				_localRecovering:            recovering ? { t1: true } : Object.create(null),
				retryNextDesktopBeforeLocal: async () => { retrySpy.push(1); return false; },
				recoverOneLocally:           async () => { localSpy.push(1); },
			};
			const names = Object.keys(stubs);
			const fn = new Function(...names, fnSrc + '\nreturn runDispatchFallback;')(...names.map((n) => stubs[n]));
			return { fn, retrySpy, localSpy };
		};

		// (d1) GUARD ON: a turn already recovering locally is neither re-seated nor re-run.
		// PRE-FIX (no guard) this re-dispatched the still-running turn to another desktop.
		const on = makeFn(true);
		await on.fn('c1', 't1');
		check('(d1) backstop stands down while _localRecovering[tid] is set (no re-seat, no re-run)',
			on.retrySpy.length === 0 && on.localSpy.length === 0,
			{ retry: on.retrySpy.length, local: on.localSpy.length });

		// (d2) GUARD OFF: with no local recovery in flight, the backstop still proceeds
		// to try the next desktop -- the guard is surgical, not a blanket stand-down.
		const off = makeFn(false);
		await off.fn('c1', 't1');
		check('(d2) with no local recovery in flight, the backstop still retries the next desktop',
			off.retrySpy.length === 1, { retry: off.retrySpy.length });
	}

	console.log(failures ? ('\nFAIL -- ' + failures + '/' + checks + ' checks') : ('\nALL PASS -- ' + checks + '/' + checks));
	process.exit(failures ? 1 : 0);
}

main();

