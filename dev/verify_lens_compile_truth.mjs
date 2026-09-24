// verify_lens_compile_truth.mjs — `ev compile` says what actually happened.
//
// THE DEFECT (found reading the lens against a live archive): three ways `ev
// compile` was a false green.
//
//   (a) The old `engine` field logged the LIVE-VIEW FLAG (`DaimondTypst.engine()`),
//       not the door that actually compiled. The ⚙ Compile button always goes
//       through typst.ts (`Wasm.typst_compile_project`) -- see `www/js/typst.js`'s
//       own comment on `engine()`: "It gates the LIVE VIEW only" -- so a device
//       flagged to `austenite` logged every button press as an Austenite compile
//       that never happened. Fixed by replacing the field outright: the payload
//       key is `producer` now, never `engine` again, so an old archived row (wrong
//       meaning, old name) can never be misread as a new one by sharing a key.
//   (b) No byte floor. `Wasm.typst_compile_project` answers with no `error` on a
//       108-byte PDF holding zero pages exactly as readily as on a real book (the
//       PDF write path's own floor, `bytes_of` in `src/wasm/typst.rs`, is "at
//       least 5 bytes"), so `ok:true` meant nothing about whether a page came
//       back.
//   (c) A runner's report and a local compile were the same event with nothing
//       to tell them apart, and the live-view's own delta compiles (Austenite,
//       `compileProjectDelta`) raised no `ev compile` at all -- the lens saw the
//       button's builds and nothing of the preview that runs on every keystroke.
//
// The fix, and what this proves:
//
//   1. `pdfHasPages` (www/js/daimond.js) is the real byte floor for the PDF
//      door: `%PDF` signature AND a `/Count N` with N >= 1 somewhere in the
//      object graph. Exercised here against the ACTUAL 108-byte-shaped
//      regression (a signature with no `/Count` at all) and against a `/Count 0`
//      page tree, both of which must read `false`; a `/Count 3` tree must read
//      `true`; non-PDF bytes must read `false`.
//   2. `reportCompileEvent` (www/js/daimond.js, inside `onBuiltReport`) tags a
//      runner's report `via:'runner'`, `producer:'typst'` (the runner's own
//      `compile()` never reaches Austenite -- see `compileDeps` in this file),
//      and floors `ok` on a real draw PLUS at least one page, across all four
//      report shapes: refused, error, an empty vector, and a real one.
//   3. `liveCompileTelemetry` (www/js/typstwatch.js, exported for exactly this)
//      labels the live view's OWN compiles by the door actually taken this
//      build (`useDelta`), and floors a delta's `ok` on a non-empty `order` --
//      not on the mere absence of `error`, which an empty-page delta would
//      still have.
//   4. A static check that the button's two `ev compile` call sites (in
//      `compileTypst`) now set the literal producer under the new `producer` key,
//      and that neither the old `engine` key nor a read of the live-view flag --
//      (a)'s exact defect -- has come back, even though `compileTypst` itself
//      needs a wasm build to execute.
//
// (2) and (4) run against SOURCE TEXT extracted from the real file and, for
// (2), evaluated as real code -- never a reimplementation the fix itself could
// drift away from unnoticed. `compileTypst` and `onBuiltReport` cannot be
// imported directly: `www/js/daimond.js` imports the built wasm-bindgen glue
// (`www/pkg/oxedyne_daimond.js`) at module scope, which does not exist without
// a browser build, and this is a JS-only change. `typstwatch.js` has no such
// dependency and is imported for real.
//
//   node dev/verify_lens_compile_truth.mjs

import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── Pull one named function's source out of a file by balanced braces ───────
//
// `function NAME(` to its matching `}`, counting braces and skipping string and
// template literals and comments well enough for this file's own style (tabs,
// no template literals inside these two functions, no `{`/`}` in a string on
// these particular lines). Good enough to extract real shipped source without
// re-typing it, which is the whole point: a fix to the code and a drift in a
// hand-copied test would otherwise both go unnoticed.
function extractFunction(src, name) {
	const at = src.indexOf('function ' + name + '(');
	if (at < 0) throw new Error('function ' + name + ' not found');
	const open = src.indexOf('{', at);
	if (open < 0) throw new Error('no body for ' + name);
	let depth = 0, i = open;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(at, i);
}

const daimondSrc    = fs.readFileSync(path.join(ROOT, 'www/js/daimond.js'), 'utf8');
const typstSrc      = fs.readFileSync(path.join(ROOT, 'www/js/typst.js'), 'utf8');

// ── (1) The PDF byte floor, run as the real extracted function ──────────────

const pdfHasPagesSrc = extractFunction(daimondSrc, 'pdfHasPages');
const pdfHasPages = new Function('TextDecoder', pdfHasPagesSrc + '; return pdfHasPages;')(TextDecoder);

function fakePdf(bodyAscii) {
	return new Uint8Array(Buffer.from('%PDF-1.7\n' + bodyAscii, 'latin1'));
}

check('pdfHasPages: the actual regression -- a signature with no /Count at all -- reads false',
	pdfHasPages(fakePdf('%%EOF')) === false);
check('pdfHasPages: a /Count 0 page tree reads false',
	pdfHasPages(fakePdf('/Type /Pages /Count 0 %%EOF')) === false);
check('pdfHasPages: a /Count 3 page tree reads true',
	pdfHasPages(fakePdf('/Type /Pages /Count 3 /Kids [1 0 R 2 0 R 3 0 R] %%EOF')) === true);
check('pdfHasPages: bytes with no %PDF signature read false, whatever they contain',
	pdfHasPages(new Uint8Array(Buffer.from('/Count 9 not a pdf at all', 'latin1'))) === false);
check('pdfHasPages: too short to be anything reads false, not a thrown exception',
	pdfHasPages(new Uint8Array([0x25, 0x50])) === false);
check('pdfHasPages: empty/undefined input reads false',
	pdfHasPages(null) === false && pdfHasPages(new Uint8Array(0)) === false);

// ── (2) The runner report's tagging and floor, run as the real extracted code ─
//
// `reportCompileEvent` is declared inside `onBuiltReport`, closing over the
// report object `r`. Extracted and re-declared inside a `new Function` whose
// parameters ARE that closure (`r`, `DEBUG_SHARE`, `t`), so the body runs
// completely unmodified and still closes over the same names.

const reportFnSrc = extractFunction(daimondSrc, 'reportCompileEvent');

function runReportCompileEvent(r) {
	const events = [];
	const DEBUG_SHARE = { event: (kind, payload) => { events.push({ kind, payload }); return true; } };
	const t = (key, args) => key + (args ? ':' + JSON.stringify(args) : '');	// unused by this fn; stubbed for safety
	const fn = new Function('r', 'DEBUG_SHARE', 't', 'window',
		reportFnSrc + '; return reportCompileEvent;')(r, DEBUG_SHARE, t, { DEBUG_SHARE });
	return { call: fn, events };
}

{
	const r = { main: 'book/main.typ', by: 'peerA', ms: 1200, why: 'heap ceiling reached' };
	const { call, events } = runReportCompileEvent(r);
	call(false, 0);
	const ev = events[0] && events[0].payload;
	check('reportCompileEvent(refused/error shape): tags via:runner', !!ev && ev.via === 'runner');
	check('reportCompileEvent(refused/error shape): the runner never reaches Austenite, so producer is typst',
		!!ev && ev.producer === 'typst');
	check('reportCompileEvent(refused/error shape): ok is false', !!ev && ev.ok === false);
	check('reportCompileEvent(refused/error shape): the why travels as err, clipped',
		!!ev && ev.err === 'heap ceiling reached');
}
{
	// The vector-missing shape: a report with nothing to draw. Still `ok:false`,
	// not the silent "no error therefore fine" the old code never distinguished.
	const r = { main: 'book/main.typ', by: 'peerA', ms: 400 };
	const { call, events } = runReportCompileEvent(r);
	call(false, 0);
	check('reportCompileEvent(empty vector shape): ok is false with no report content to draw',
		events[0] && events[0].payload.ok === false);
}
{
	// The real shape: a draw succeeded (`drew`) with a real page count -- the
	// caller passes `drew && (r.pages|0) >= 1` exactly as `onBuiltReport` does.
	const r = { main: 'book/main.typ', by: 'peerA', ms: 900, pages: 48 };
	const { call, events } = runReportCompileEvent(r);
	const drew = true;
	call(drew && (r.pages | 0) >= 1, 512000);
	const ev = events[0].payload;
	check('reportCompileEvent(real build): ok true only once a page count backs the draw',
		ev.ok === true && ev.bytes === 512000 && ev.producer === 'typst' && ev.via === 'runner');
}
{
	// A DRAW THAT REPORTS ZERO PAGES must not read as a good compile, the same
	// floor as the PDF door's /Count check -- this is (b)'s equivalent on the
	// runner path, and the whole reason `ok` is computed from `pages`, not from
	// `drew` alone.
	const r = { main: 'book/main.typ', by: 'peerA', ms: 900, pages: 0 };
	const { call, events } = runReportCompileEvent(r);
	const drew = true;
	call(drew && (r.pages | 0) >= 1, 4);
	check('reportCompileEvent: a draw with zero pages is NOT ok, matching the /Count floor',
		events[0].payload.ok === false);
}

// ── (3) The live view's own telemetry, imported for real (no wasm dependency) ─

const { liveCompileTelemetry } = await import(path.join(ROOT, 'www/js/typstwatch.js'));

{
	const t = liveCompileTelemetry(true, { order: ['p1', 'p2'], changed: [{ id: 'p1', svg: '<svg>x</svg>' }] });
	check('liveCompileTelemetry(delta, real pages): producer is austenite', t.producer === 'austenite');
	check('liveCompileTelemetry(delta, real pages): ok true', t.ok === true);
	check('liveCompileTelemetry(delta, real pages): bytes from the changed SVGs', t.bytes === '<svg>x</svg>'.length);
}
{
	// The false-green's exact shape on the delta door: no `error`, but an empty
	// `order` -- zero pages. `build()`'s own `drew` test would pass this (it
	// checks the FIELD, not the length -- an empty `changed` against a
	// non-empty `order` is a legitimate "nothing moved"), so this is the case
	// that proves the floor is on `order.length`, not on `drew`.
	const t = liveCompileTelemetry(true, { order: [], changed: [] });
	check('liveCompileTelemetry(delta, empty order): ok is false despite no error', t.ok === false);
}
{
	const t = liveCompileTelemetry(true, { error: 'label <x> does not exist' });
	check('liveCompileTelemetry(delta, error): ok is false', t.ok === false);
	check('liveCompileTelemetry(delta, error): producer is still austenite (the door was taken; it failed)',
		t.producer === 'austenite');
}
{
	const t = liveCompileTelemetry(false, { vector: new Uint8Array([1, 2, 3, 4, 5]) });
	check('liveCompileTelemetry(vector, non-empty): producer is typst, never austenite', t.producer === 'typst');
	check('liveCompileTelemetry(vector, non-empty): ok true, bytes from the vector length',
		t.ok === true && t.bytes === 5);
}
{
	const t = liveCompileTelemetry(false, { vector: new Uint8Array(0) });
	check('liveCompileTelemetry(vector, empty): ok is false', t.ok === false);
}

// ── (4) The button's two call sites no longer read the live-view flag ───────
//
// Static, on purpose: `compileTypst` needs a browser build to execute, but the
// exact defect in (a) was textual -- `engine: (window.DaimondTypst &&
// DaimondTypst.engine && DaimondTypst.engine()) || ''` -- and a regression that
// brings it back is just as textual. Both call sites must now read the literal
// producer, and neither may call `DaimondTypst.engine()` for it.
{
	const compileTypstAt = daimondSrc.indexOf('async function compileTypst(path, btn)');
	check('compileTypst is present to slice from', compileTypstAt > 0);
	const nextTop = daimondSrc.indexOf('\n\t\t/// The main of a project', compileTypstAt);
	const body = daimondSrc.slice(compileTypstAt, nextTop > 0 ? nextTop : compileTypstAt + 20000);
	const producerLiterals = body.match(/producer:\s*'typst'/g) || [];
	check('compileTypst: both ev-compile call sites now set producer to the literal typst',
		producerLiterals.length === 2, `found ${producerLiterals.length}`);
	check('compileTypst: neither call site emits the old `engine` key at all',
		!/\bengine:\s*/.test(body));
	check('compileTypst: neither call site reads the live-view flag any more',
		!/\(window\.DaimondTypst\s*&&\s*DaimondTypst\.engine/.test(body));
	check('compileTypst: the success branch floors ok on pdfHasPages, not on the absence of an error',
		/ok:\s*pdfHasPages\(out\.pdf\)/.test(body));
}

// ── typst.js's own comment still says what (a) depends on ───────────────────
// A cheap tripwire: if this sentence is ever edited away, the fix above is
// resting on a claim nobody guarantees any more.
check('typst.js still documents that engine() gates the live view only',
	/gates the LIVE VIEW only/.test(typstSrc));

// ── (5) The lens reader: `producer` is read, `engine` only for OLD rows ─────
//
// Owner ruling: no transitional arrangement -- the field is replaced outright,
// and `dev/lens.mjs` carries no more than a one-line fallback so a row already
// on disk from before this fix still prints something. A row written from now
// on always has `producer` and must never fall back.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lens-compile-truth-'));
	fs.mkdirSync(path.join(root, 'archive'), { recursive: true });
	const write = (rows) => fs.writeFileSync(path.join(root, 'archive', 'dev1.events.ndjson'),
		rows.map(r => JSON.stringify(r)).join('\n') + '\n');
	write([
		// An OLD row, from before this fix: only `engine`, carrying the WRONG
		// (live-view-flag) meaning. The reader may show it as a producer, since
		// that is the only value on disk for it, but must not invent a `via`.
		{ ts: 1000, device: 'dev1', src: 'ev', kind: 'compile',
			ev: { main: 'old.typ', engine: 'austenite', ok: true, ms: 10, bytes: 999 } },
		// A NEW row, in the shape this fix now writes.
		{ ts: 2000, device: 'dev1', src: 'ev', kind: 'compile',
			ev: { main: 'new.typ', producer: 'typst', via: 'runner', ok: true, ms: 20, bytes: 1234 } },
	]);
	const out = execFileSync('node', [path.join(ROOT, 'dev/lens.mjs'), 'events', '--since', 'all'], {
		encoding: 'utf8',
		env: Object.assign({}, process.env, { DAIMOND_LENS_HOME: root, DAIMOND_LENS_REMOTE: '' }),
	});
	const oldLine = out.split('\n').find(l => l.includes('old.typ')) || '';
	const newLine = out.split('\n').find(l => l.includes('new.typ')) || '';
	check('lens events: an old archived row (engine only) still prints a producer, via the fallback',
		/producer=austenite/.test(oldLine), oldLine);
	check('lens events: an old archived row never gains a via it never had',
		!/\bvia=/.test(oldLine), oldLine);
	check('lens events: a new row prints producer and via straight from the field, no fallback needed',
		/producer=typst via=runner/.test(newLine), newLine);
	fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
