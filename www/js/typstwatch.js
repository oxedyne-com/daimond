/* ============================================================
   Daimond — the watched live document
   ------------------------------------------------------------
   `typst watch` and a document viewer, inside the page.  The
   author edits a `.typ` — or a daimon does — and the pages he is
   looking at become the new ones, in place, without him asking.

       window.DaimondTypstWatch = {
           began, stop, touched, rebuild, budgetMB, zoom, dark,
           state, pageBox, goToPage, rail, sections, fitPage
       }

   Six things decide the shape of this file, and each of them is
   a measurement rather than a preference.  The measurements are
   in `dev/TYPST_WATCH.md` and in `dev/probe_typstsvg.mjs`; what
   follows is what they cost.

   1. THE PAGES ARE DRAWN HERE, AND ARE NOT A PDF.
      On the author's 281-page book, on one warm compiler and one
      layout, `compile → 'pdf'` is 1834-2069 ms and
      `compile → 'vector'` is 235-272 ms.  Writing the document
      out costs about eight times what laying it out does, and the
      reader is looking at a screen, not at a file.  So the live
      view asks for the layout and draws it, and the PDF stays
      exactly where it was: the Compile button still writes one,
      `file_show` still opens one, export is untouched.

      The second reason is position.  Chrome's PDF viewer answers
      NOTHING through an `<embed>` — no `contentDocument`, no
      `contentWindow`, no reply to a `postMessage` — so where the
      reader has scrolled to cannot be read back, only set.  These
      pages are ours, so their scroll is ours, and "put it back
      where he was" stops being a guess.

   2. IT IS THE SAME COMPILER, THE SAME FONTS AND THE SAME LAYOUT
      as the PDF, and that is checked rather than asserted.
      `dev/verify_typstwatch.mjs` compiles one page both ways,
      rasterises the PDF with poppler — which has nothing to do
      with typst — rasterises these pages in the browser, and
      compares the ink.  Anti-aliasing differs.  Nothing else may.

   3. A REBUILD MUST NEVER BLANK THE VIEW.  The new pages are
      built in a detached node and swapped in one operation, with
      the scroll restored in the same turn.  There is no moment at
      which the host holds nothing: the old document stays on
      screen, at the reader's place, while the new one is compiled
      and parsed, and a failed compile leaves it there and puts
      the compiler's own words underneath.

   3b. AND ONLY THE PAGES IN VIEW ARE EVER DRAWN.  The whole book
      at once costs seven seconds of DOM on a 281-page document
      and, drawn as one element the height of the book, comes out
      a pale wash from about page forty.  Neither is the
      compiler's fault and neither is visible from the code.  The
      three measurements that settle it are at "Drawing" below;
      they are the reason this file is as long as it is.

   4. CROSSING THE WASM HEAP CEILING BRICKS THE COMPILER.
      Measured: the heap climbed to 3171 MB, the call trapped, and
      EVERY SUBSEQUENT COMPILE failed with `recursive use of an
      object detected which would lead to unsafe aliasing in rust`
      — a wasm-bindgen borrow left held by the trapped call — and
      the memory was never returned.  Only a reload recovers.  A
      one-shot button hides this because a person who sees one
      failure reloads.  A LOOP DOES NOT: it will eventually fire on
      a document that is too big and the compiler is dead from
      then on.  So this budgets the heap and refuses to START a
      rebuild that might not fit, falling back to a Rebuild button
      the user presses knowingly.  See `holdCheck` below.

   5. THE COMPILER IS MEMOISED IN `typst.js` AND THAT IS WHY THIS
      WORKS AT ALL.  One `TypstCompiler` for the life of the page,
      whose comemo cache survives `reset_shadow()`, is the whole
      difference between 0.4 s and 3 s per rebuild.  The note is at
      the top of `typst.js`, where the memo is.

   VENDORED, NOT FETCHED.  The renderer is
   `typst_ts_renderer_bg.wasm`, from `@myriaddreamin/typst-ts-
   renderer@0.7.0`, sitting beside the compiler it came out with:
   the compiler here is byte-identical to
   `@myriaddreamin/typst-ts-web-compiler@0.7.0`, and both wasm
   modules carry the SAME typst checkout in their own bytes —
   `checkouts/typst-a1cd3ade704ca26e/951788c`, typst 0.14.2 with
   typst-assets-0.14.2.  That is a stronger pairing than matching
   version numbers: it is the same typst source tree, read out of
   the binaries rather than off a filename.  Nothing is fetched at
   run time and nothing leaves the origin.

   SECURITY.  The renderer returns markup, and markup goes into
   this origin's DOM.  Three things follow, and none is optional.  The
   `<script>` typst.ts embeds for its own hover and link behaviour
   is CUT OUT of the string before it is parsed — it is not wanted,
   and a document an agent wrote after reading a web page is not
   something to run scripts from.  The `onclick=` attributes that
   script's helpers were the target of go with it, for the same
   reason and because they now name a function nobody defines.  And
   the pages live in a SHADOW ROOT, because the stylesheet typst.ts
   emits carries a bare `svg { fill: none; }` rule that would
   otherwise blank every icon in the app, and because the app's own
   CSS must not reach in and change what the book looks like.

   6. AND THE STYLESHEET HAS TO BE PUT BACK, because `render_in_window`
      DOES NOT EMIT IT.  Measured, `dev/probe_typstsvg.mjs`: the whole
      document through `svg_data` carries a 1.4 KB `<style>`; the same
      document through `render_in_window` carries `<style></style>`,
      empty.  Everything in that sheet that MATTERS is therefore
      missing from every page this view has ever drawn, and three
      reported faults are the one omission:

        * typst.ts lays an INVISIBLE TEXT LAYER over the glyph
          outlines — a `<foreignObject>` per run holding a
          `div.tsel` at `font-size: 62px` — so a reader can select
          and search. `.tsel { color: transparent }` is the only
          thing making it invisible. Without it every line is drawn
          twice: GHOSTED, DOUBLE-STRUCK TEXT.
        * every link becomes `<rect class="pseudo-link">`, and an SVG
          rect with no fill is BLACK. `.pseudo-link { fill:
          transparent }` is the only thing making it not. Without it
          a contents entry is a SOLID BLACK BAR the width of the
          line and an inline `#link` is a FILLED BLACK BOX.

      So the rules are adopted into the shadow root once, at mount,
      where `replaceChildren` cannot take them away again.  Taken
      from typst.ts's own sheet — `TYPST_CSS` below says which parts
      and why the rest is left out.

   7. A DOCUMENT IS A STACK OF SHEETS, NOT A SCROLL.  The first
      version drew the visible band as ONE SVG, so a page ran into
      the next with nothing between them and the author said so:
      "shows as a continuous page, not distinct pages".  Each page
      is now its own sheet — its own SVG, its own white paper, its
      own shadow — with `PAGE_GAP` points of the panel's ground
      between them, which is what Chrome's PDF viewer does and what
      a reader expects of a document.

      It costs LESS than what it replaced, because the band is
      still ONE session and ONE call — the sheets are cut out of the
      one answer afterwards, since the renderer hands back a
      `<g class="typst-page">` per page and says in its transform
      where each sits.  A call PER PAGE was tried first and is the
      trap: the session's diff is by CONTENT, not by window, so four
      pages carrying the same `#lorem(60)` came back as 428, 5, 7
      and 5 marks and three quarters of the document was simply
      missing.  `dev/TYPST_WATCH.md` §12 has that table and the two
      other things the renderer does not say.

      The glyph outlines are emitted once, into the first sheet, and
      the later sheets `<use>` them — which works because every
      sheet of one band goes into the one shadow root in the one
      `replaceChildren`, so an `href="#g…"` never points outside the
      tree it is in.  The band is replaced whole or not at all, so a
      def can never outlive its user.

   8. THE SECTION RAIL IS THE COMPILER'S ANSWER, THE PAGE IS THE
      RENDERER'S.  The entries — the words, the level and the order
      — come from `query('heading')` on the compiled document, which
      is exact and costs 6 ms on the fixture here and 9-14 ms on the
      author's 281-page book.  THE PAGE CANNOT COME FROM THERE.
      Measured on this vendored 0.14.2: `query('heading', 'location')`
      and `query('heading', 'page')` both answer `[]`, and so does
      the CLI (`dev/TYPST_WATCH.md` §6 tried it first).  Typst does
      not put an element's location among its fields.

      So each heading is found in the LAID-OUT pages instead, by its
      own words, page by page, in document order — see `locate`.  It
      runs only while the rail is open, it renders and never
      compiles, and it yields every `SCAN_CHUNK` pages so a long
      book fills the rail in rather than freezing it.
   ============================================================ */

const VENDOR   = new URL('../vendor/typst/', import.meta.url);
const R_GLUE   = new URL('typst_ts_renderer.mjs', VENDOR);
const R_WASM   = new URL('typst_ts_renderer_bg.wasm', VENDOR);
const PKG      = new URL('../pkg/oxedyne_daimond.js', import.meta.url);

/// The app's string for `k`, or `en` where the catalogue has none yet.
///
/// Called `tOr` on purpose and not as a preference: `dev/i18nfallback.mjs` finds the
/// English written beside a key by looking for `tOr(`, `tf(` and `tr(`, so a helper
/// called anything else keeps its sentences OUT of the check that holds them to the
/// catalogue — and a fallback nobody checks is a sentence free to drift from the one
/// the reader is supposed to see. Thirty-nine of them drifted in one afternoon once.
function tOr(k, en, v) {
	const s = window.DaimondI18n ? window.DaimondI18n.t(k, v) : null;
	if (s == null || s === k) {
		return String(en).replace(/\{(\w+)\}/g, (whole, n) => (v && v[n] != null) ? String(v[n]) : whole);
	}
	return s;
}

// ── How long to wait, and why that long ─────────────────────────────────────
//
// A debounce longer than the rebuild is time the reader spends waiting for
// nothing; one shorter than the rebuild queues work that is thrown away when the
// next keystroke lands.  So the wait is THE LAST REBUILD'S OWN DURATION, clamped,
// which is the only figure that is right for both of the author's books at once:
// the 281-page one rebuilds in about 0.4 s and the 665-page one in about 1.2 s,
// and no single constant serves both.
//
// The floor is 400 ms because that is what the smaller book costs and there is no
// point waiting less than a rebuild.  The ceiling is 2 s because past that the
// preview stops feeling connected to the typing, and a book that slow is better
// served by pressing Rebuild than by a loop that fires every two seconds.

/// The shortest wait after the last write before rebuilding.
const DEBOUNCE_MIN = 400;

/// The longest, however slow the last rebuild was.
const DEBOUNCE_MAX = 2000;

/// How often the watched files are asked whether they have changed.
///
/// Sixty-three files answered in 13 ms, three runs — so a second between polls is
/// about one part in eighty of one core, and the loop feels immediate.  The File
/// System Access API has no change events, so for a real folder this is the only
/// mechanism there is; a writer that KNOWS it wrote calls `touched` and skips it.
const POLL_MS = 1000;

/// The wasm heap, in MB, above which no further rebuild is started.
///
/// The wall is about 4 GB — a module with no declared maximum grew to 4081 MB and
/// then refused — and one over-large document past it leaves the compiler dead for
/// the life of the page.  2500 MB leaves room for the largest single document
/// measured here and stays a whole gigabyte clear.
const BUDGET_DEFAULT = 2500;

/// The least headroom assumed for the next rebuild before any has been measured.
const HEADROOM_MIN = 128;

/// What a trapped compiler says.  Either of these means the wasm-bindgen borrow is
/// held and nothing short of a reload will free it.
const TRAPPED = /recursive use of an object|unreachable/i;

/// How many rebuilds may run in a row on a change nothing could confirm before the
/// loop stops and says so.
///
/// Everything a page can read back is checked against its own contents, so this is
/// the backstop for the one case that cannot be: a file over `DIGEST_MAX` reporting
/// that it moved, again and again. Three of those in a row is a fault to report
/// rather than a state to sit in, because the heap ceiling is what comes next.
const SPIN_MAX = 3;

/// The space left between two sheets of paper, in DOCUMENT POINTS.
///
/// In points rather than pixels so that it is part of the same geometry as
/// everything else: the reader's place is a page and an offset in points, and a gap
/// measured in pixels would make that arithmetic depend on the zoom.  Twelve points
/// is about four millimetres at 100% — enough that the eye reads two sheets rather
/// than one long one, and little enough that a page turn is not a journey.
const PAGE_GAP = 12;

/// How many pages either side of the visible ones are drawn.
///
/// One page's worth of margin, so a flick of the wheel lands on a sheet that is
/// already there.  The band was measured in SCREENS before the pages were separated;
/// pages are the honest unit now that each one is its own SVG.
const MARGIN_PAGES = 1;

/// How far inside its own edges a page is asked for, in points.
///
/// `render_in_window` TAKES A CLOSED RECTANGLE, which cost an afternoon: asking for
/// exactly `[top, top + height]` returns the page whose top is exactly at `hi` as
/// well, and since the session answers with a DIFF, the next page's call then had
/// nothing left to give. Every sheet drew the page after it and the last one drew
/// nothing — a whole document off by one, with a blank sheet at the end.
///
/// A twentieth of a point is a fiftieth of a millimetre, which is smaller than the
/// resolution of anything that will ever be printed, and it is comfortably above the
/// f32 rounding at the foot of a 281-page book.
const PAGE_INSET = 0.05;

/// How many pages the outline scan lays out before it hands the frame back.
///
/// A page answers in well under a millisecond once the first one has emitted the
/// glyphs, so eight is a few milliseconds of work between two paints — invisible on
/// a short document and, on a 281-page one, a rail that fills in rather than a tab
/// that stops.
const SCAN_CHUNK = 8;

// ── Where the last good pages live, and what bounds them ────────────────────
//
// A failed build keeps the document that was on screen, so something has to be
// holding pages that the current source can no longer produce.  Two things are,
// and neither of them is the compiler's heap.
//
//   * The MARKS are an SVG in the shadow root — ordinary browser DOM, reclaimed
//     when it is replaced, and never more than about three screens of it because
//     only the band in view is drawn.
//   * The DOCUMENT is the VECTOR ARTIFACT, kept as bytes on the JavaScript heap:
//     11.1 MB for the author's 281-page book, one document's worth, replaced
//     whole by the next good build. It is kept because a scroll has to be able to
//     draw a page the current source may no longer produce.
//
// NO RENDER SESSION IS HELD BETWEEN DRAWS. Each render builds one from those bytes,
// uses it and frees it, which is forced by `render_in_window` being a diff (see
// below) and is the right thing anyway: the renderer's wasm heap is a SECOND
// `WebAssembly.Memory`, in a second module, and it never shrinks either. Holding
// nothing between draws settles it at one document's high-water mark instead of
// letting it climb with the session. It also means a preview that grew unboundedly
// still could not brick the COMPILER, which is the failure worth engineering
// against. `state().rheap` reports it, so it is measured rather than assumed.
let mod = null;			// the wasm package namespace, imported once
let renderer = null;		// the typst.ts renderer, built lazily
let vec = null;			// the vector artifact on screen, kept so a scroll can draw
let rinit = null;		// the renderer's wasm exports, for `rheap`

/// Everything the loop knows, in one object so `state()` cannot drift from it.
const S = {
	path:     '',		// the `.typ` being watched, or '' when idle
	files:    [],		// every real path the last gather read
	stamps:   null,		// what those files said last time, by path; null before any
	mode:     'idle',	// idle | live | held | dead
	builds:   0,		// rebuilds STARTED since `began`
	drawn:    0,		// rebuilds that reached the screen
	failed:   0,		// rebuilds the compiler refused
	debounce: DEBOUNCE_MIN,
	budget:   BUDGET_DEFAULT,
	headroom: HEADROOM_MIN,	// the biggest heap growth one rebuild has cost
	building: false,
	queued:   false,
	seen:     false,	// the panel has been on screen at least once
	error:    '',		// the compiler's own words, while a build is broken
	reason:   '',		// why the loop is held or dead
	cause:    '',		// 'write' or 'poll' or 'user': what asked for the rebuild
	why:      '',		// and which file it named, for a report from the field
	digests:  {},		// what each watched file said, the last time it was read
	blind:    false,	// the rebuild running now could not be confirmed from contents
	same:     0,		// unconfirmable rebuilds in a row, which is a spin nobody sees
	pages:    0,
	scale:    1,		// rendered px per pt, for putting the scroll back
	docW:     0,		// the document's own width, in points
	docH:     0,		// and its whole height, which the scroller is as tall as
	tops:     [],		// each page's top IN THE DOCUMENT, in pt
	heights:  [],		// each page's height, in pt
	lays:     [],		// each page's top ON SCREEN, in pt, gaps included
	laid:     0,		// the whole stack's height on screen, in pt
	zoom:     1,		// how much bigger than fitting the panel's width
	fit:      'width',	// 'width' or 'page': what the fit button last did
	dark:     false,	// the paper turned over, for reading at night
	rail:     false,	// the section rail is open
	toc:      [],		// { text, level, page } per heading; page 0 = not found yet
	scanned:  0,		// the build serial the pages in `toc` were found in
};

let timer = null;		// the debounce
let poller = null;		// the interval that asks the files
let host = null;		// the live view's root element

/// The wasm package, imported once.
async function wasm() {
	if (!mod) mod = await import(PKG.href);
	return mod;
}

/// The renderer, built once, lazily.
///
/// A megabyte of wasm that a reader who never compiles anything should not pay
/// for, so it is not touched until the first live view is drawn.
async function getRenderer() {
	if (renderer) return renderer;
	const g = await import(R_GLUE.href);
	rinit = await g.default(R_WASM.href);
	renderer = await new g.TypstRendererBuilder().build();
	return renderer;
}

/// The RENDERER's wasm heap in MB, which is not the compiler's.
///
/// Two modules, two `WebAssembly.Memory` objects, two ceilings. Worth reading
/// separately: pages held for a failed build are held HERE, and confusing the two
/// would have the budget guarding the wrong heap.
function rheapMB() {
	if (!rinit || !rinit.memory) return 0;
	return rinit.memory.buffer.byteLength / 1048576;
}


/// The part of typst.ts's own stylesheet a windowed render needs and does not get.
///
/// Verbatim from the sheet `svg_data` emits, which is a string literal in
/// `typst_ts_renderer_bg.wasm` and can be read out of it — `dev/probe_typstsvg.mjs`
/// prints both. Only the rules that decide what is ON THE PAGE are here, and the
/// three that are left out are left out on purpose:
///
///   * `.typst-text { pointer-events: bounding-box }` and `.hover .typst-text` are
///     for the hover highlight the embedded `<script>` drives, and that script is
///     cut out before anything parses it.
///   * `.outline_glyph { fill: var(--glyph_fill) }` WOULD BLANK THE BOOK. A CSS
///     declaration beats a presentation attribute, so that rule overrides the
///     `fill="#000"` typst.ts puts on every text group; typst.ts's own host page
///     defines `--glyph_fill`, and an undefined `var()` on an inherited property
///     falls back to the inherited value, which the same sheet sets to `none`.
///     Leaving both out keeps each run the colour the compiler gave it, which is
///     also the only way a coloured heading stays coloured.
///   * `svg { fill: none }` goes with it, for the same reason: it is that rule the
///     glyph rule exists to undo.
///
/// `.pseudo-link` is `pointer-events: none` rather than typst.ts's `all`. Its
/// anchors are `xlink:href="#"` plus an `onclick` naming a function this page does
/// not have, and the external ones open a window from a document a daimon may have
/// written. Inert matches the decision that cut the script out.
const TYPST_CSS =
	'.tsel span,\n'
	+ '.tsel {\n'
	+ '  left: 0;\n'
	+ '  position: fixed;\n'
	+ '  text-align: justify;\n'
	+ '  white-space: nowrap;\n'
	+ '  width: 100%;\n'
	+ '  height: 100%;\n'
	+ '  text-align-last: justify;\n'
	+ '  color: transparent;\n'
	+ '  white-space: pre;\n'
	+ '}\n'
	+ '.tsel span::-moz-selection,\n'
	+ '.tsel::-moz-selection {\n'
	+ '  color: transparent;\n'
	+ '  background: #7db9dea0;\n'
	+ '}\n'
	+ '.tsel span::selection,\n'
	+ '.tsel::selection {\n'
	+ '  color: transparent;\n'
	+ '  background: #7db9dea0;\n'
	+ '}\n'
	+ '.pseudo-link {\n'
	+ '  fill: transparent;\n'
	+ '  pointer-events: none;\n'
	+ '}\n';

/// What makes a page look like a sheet of paper, inside the shadow root.
///
/// It lives HERE and not in `www/css/viewer.css` for the same reason the rules above
/// do: the pages are in a shadow root, and the app's own stylesheet does not reach
/// into one.  The rest of the live view — the bar, the rail, the scroller — is in
/// `viewer.css` where it belongs.
///
/// The sheet carries the paper and the shadow; the SVG inside it carries only the
/// marks.  Keeping the white on the CONTAINER rather than on the SVG is what makes a
/// page that failed to draw look like a blank sheet instead of a hole.
const SHEET_CSS =
	'.tl-band { position: absolute; inset: 0; }\n'
	+ '.tl-sheet {\n'
	+ '  position: absolute;\n'
	+ '  left: 0;\n'
	+ '  background: #fff;\n'
	+ '  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.35);\n'
	+ '  overflow: hidden;\n'
	+ '}\n'
	+ '.tl-sheet > svg { display: block; }\n';

let sheetEl = null;		// the fallback <style>, where sheets cannot be adopted

/// Put `TYPST_CSS` into `root` so that `replaceChildren` cannot remove it.
///
/// `adoptedStyleSheets` is not a child, so it survives the swap that puts each new
/// band up; where it is missing the same rules go in as a `<style>` element that
/// `paint` re-inserts alongside the pages. Either way the rules are in place BEFORE
/// the first band is drawn, because a first frame of black bars is still a frame of
/// black bars.
function adopt(root) {
	try {
		const s = new CSSStyleSheet();
		s.replaceSync(TYPST_CSS + SHEET_CSS);
		root.adoptedStyleSheets = [s];
		sheetEl = null;
		return;
	} catch (e) { /* an engine without constructable sheets */ }
	sheetEl = document.createElement('style');
	sheetEl.textContent = TYPST_CSS + SHEET_CSS;
}

/// Put `node` on screen as the whole of the pages, rules included.
///
/// The one place the shadow root's children are replaced, so the fallback sheet
/// cannot be forgotten by a caller that swaps the pages some other way.
function paint(node) {
	const pages = host && host.querySelector('.tl-pages');
	if (!pages) return;
	if (sheetEl) pages.shadowRoot.replaceChildren(sheetEl, node);
	else pages.shadowRoot.replaceChildren(node);
}


// ── The view ────────────────────────────────────────────────────────────────

/// The Preview panel's other two renderings, and the display they had before the
/// live view stood in for them.
///
/// The panel holds an `<embed>` for a compiled PDF and `#pv-view` for anything the
/// file viewer draws; whichever is showing, the other is hidden. The live view is a
/// THIRD rendering of the same panel, so it takes its turn rather than sitting over
/// the top — a sheet over the panel covered its own header, and with it the ✕ that
/// closes it.
///
/// THE SOURCE IS NOT ONE OF THEM ANY MORE, and that is the whole reason the preview
/// was split out of the Doc panel. While the two shared a panel, opening the `.typ`
/// that this loop is FOLLOWING put the editor over the pages the loop was rebuilding
/// — the panel had to decide whose turn it was, and every fix for it broke the other
/// case. Now the source sits in the Doc panel and the pages sit here, side by side,
/// and there is no turn to take.
let stood = [];			// [element, previous inline display]

/// Build the live view's elements, or return the ones already there.
///
/// It sits INSIDE the Preview panel, in the same column as the `<embed>` and the
/// viewer's own host, and takes nothing away: closing it puts them back exactly as
/// they were, down to the inline `display` each one carried.
function mount() {
	if (host && host.isConnected) return host;
	const panel = document.getElementById('panel-preview');
	if (!panel) return null;
	host = document.createElement('div');
	host.className = 'typst-live';
	host.id = 'typst-live';
	host.innerHTML =
		'<div class="tl-bar">'
		+ '<button type="button" class="tl-toc" aria-pressed="false" aria-controls="tl-rail">'
		+ '\u2261</button>'
		+ '<span class="tl-mark" aria-hidden="true"></span>'
		+ '<span class="tl-says" role="status" aria-live="polite"></span>'
		+ '<button type="button" class="tl-rebuild" style="display:none"></button>'
		+ '<span class="tl-set">'
		+ '<input class="tl-page" type="text" inputmode="numeric" autocomplete="off" size="3">'
		+ '<span class="tl-of"></span>'
		+ '<button type="button" class="tl-out">\u2212</button>'
		+ '<button type="button" class="tl-fit"></button>'
		+ '<button type="button" class="tl-in">+</button>'
		+ '<button type="button" class="tl-night" aria-pressed="false"></button>'
		+ '</span>'
		+ '</div>'
		+ '<div class="tl-body">'
		+ '<nav class="tl-rail" id="tl-rail" hidden><ol class="tl-toclist"></ol>'
		+ '<p class="tl-tocnone"></p></nav>'
		+ '<div class="tl-scroll"><div class="tl-pages"></div></div>'
		+ '</div>'
		+ '<pre class="tl-err" style="display:none"></pre>';
	panel.appendChild(host);
	host.querySelector('.tl-rebuild').addEventListener('click', function () { rebuild(); });
	controls();
	// Scrolling out of the drawn band draws the next one. Throttled to a frame,
	// because a scroll fires far more often than a screen is painted and the work
	// only has to be done once per frame to be invisible.
	let pending = false;
	host.querySelector('.tl-scroll').addEventListener('scroll', function () {
		if (pending) return;
		pending = true;
		requestAnimationFrame(function () { pending = false; ensureWindow(); sayWhere(); });
	}, { passive: true });
	// A resized panel is a different scale, and the scale is the only thing a resize
	// changes: the layout is the compiler's. So it repaints rather than rebuilding,
	// and the reader's page and offset — which are in points — survive it.
	if (window.ResizeObserver) {
		let sizing = false;
		new ResizeObserver(function () {
			if (sizing) return;
			sizing = true;
			requestAnimationFrame(function () { sizing = false; resized(); });
		}).observe(host.querySelector('.tl-scroll'));
	}
	// The pages get a shadow root of their own: typst.ts's stylesheet carries a
	// bare `svg { fill: none; }` that would blank every icon in the app, and the
	// app's own CSS must not reach in and change what the book looks like.
	const pages = host.querySelector('.tl-pages');
	adopt(pages.attachShadow({ mode: 'open' }));
	return host;
}

// ── The settings the reader was not offered ─────────────────────────────────
//
// The live view shipped with a status bar and nothing else, which is one control
// fewer than the `<embed>` it stands in for: Chrome's PDF viewer at least has a
// zoom and a page box. So the same three, done properly, plus the one Chrome's
// viewer cannot be given at all.
//
// THEY ARE ALL VIEWING, NOT TYPESETTING. The layout is the compiler's and does not
// depend on any of them — the page count, the line breaks and where a footnote
// falls are the same at 40% as at 400% — so none of these starts a compile. That is
// why the zoom is a repaint (`resized`) and the reader's place, which is a page and
// an offset in POINTS, survives every one of them untouched.
//
// DARK PAPER IS A FILTER, and deliberately not a recompile. Asking typst for a dark
// document would change the document; inverting the drawn page changes only what
// the reader is looking at, so what is exported, printed and read by anybody else
// is unaffected. `hue-rotate(180deg)` after the inversion puts colours back roughly
// where they were, so a red figure stays red rather than turning cyan.
//
// The `<embed>` cannot have this one: there is no CSS, no API and no message that
// reaches inside Chrome's PDF plugin (measured — `dev/TYPST_WATCH.md` §6), which is
// the whole reason these pages are drawn here rather than handed to it.

/// The largest and smallest the pages may be drawn, as a multiple of fitting the
/// panel's width.  Past either the reader is no longer reading a page.
const ZOOM_MIN = 0.4, ZOOM_MAX = 4;

/// Whether the language hook has been registered.  Once per page: `onChange` keeps
/// what it is given for the life of the document, so registering it per mount would
/// leave a hook for every document the reader has opened.
let relabels = false;

/// Put this language's words on the bar's controls.
function labels() {
	if (!host) return;
	const q = (c) => host.querySelector(c);
	const page = q('.tl-page'), out = q('.tl-out'), inn = q('.tl-in');
	page.setAttribute('aria-label', tOr('typst.watch.page', 'Page'));
	out.setAttribute('title', tOr('typst.watch.zoom_out', 'Smaller'));
	out.setAttribute('aria-label', out.getAttribute('title'));
	inn.setAttribute('title', tOr('typst.watch.zoom_in', 'Bigger'));
	inn.setAttribute('aria-label', inn.getAttribute('title'));
	fitLabel();
	const toc = q('.tl-toc');
	toc.setAttribute('title', tOr('typst.watch.sections', 'Sections'));
	toc.setAttribute('aria-label', toc.getAttribute('title'));
	q('.tl-tocnone').textContent = tOr('typst.watch.sections_none',
		'This document has no headings to list.');
	dark(S.dark);			// the one whose LABEL is its state
	offerRebuild(host.querySelector('.tl-rebuild').style.display !== 'none');
	drawRail();
}

/// Wire the bar's controls, once, at mount.
function controls() {
	const q = (c) => host.querySelector(c);
	const page = q('.tl-page'), out = q('.tl-out'), inn = q('.tl-in'),
		fit = q('.tl-fit'), night = q('.tl-night');
	labels();
	out.addEventListener('click', function () { S.fit = 'width'; zoom(S.zoom / 1.25); });
	inn.addEventListener('click', function () { S.fit = 'width'; zoom(S.zoom * 1.25); });
	// One button for both fits, because they are one question — how much of the page
	// do I want — and Chrome's PDF viewer asks it with one control too. It shows the
	// percentage, so the title is what says which way it will go next.
	fit.addEventListener('click', function () { fitPage(S.fit !== 'page'); });
	night.addEventListener('click', function () { dark(!S.dark); });
	q('.tl-toc').addEventListener('click', function () { rail(!S.rail); });
	// Enter commits; blur commits too, because a number typed and then clicked away
	// from is a number the reader meant.
	const go = function () {
		const n = parseInt(page.value, 10);
		if (Number.isFinite(n)) goToPage(n);
		sayWhere();
	};
	page.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); go(); } });
	page.addEventListener('blur', go);
	sayWhere();
	// A SURFACE ALREADY ON SCREEN WHEN THE LANGUAGE CHANGES has to repaint itself:
	// every label above was resolved once, at mount, and the reader may well have a
	// document open while switching. `onChange` is the app's own hook for exactly
	// that, and it only ever puts words on a view that is still standing.
	if (!relabels && window.DaimondI18n && window.DaimondI18n.onChange) {
		relabels = true;
		window.DaimondI18n.onChange(function () {
			if (host && host.isConnected) labels();
		});
	}
}

/// Draw the pages at `z` times the width that fits, and put the reader back.
function zoom(z) {
	S.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
	resized();
	fitLabel();
	sayWhere();
}

/// Say which way the one fit button will go next.
function fitLabel() {
	if (!host) return;
	const fit = host.querySelector('.tl-fit');
	fit.setAttribute('title', S.fit === 'page'
		? tOr('typst.watch.fit_width', 'Fit the width')
		: tOr('typst.watch.fit_page', 'Fit the whole page'));
	fit.setAttribute('aria-label', fit.getAttribute('title'));
}

/// Fit a whole page in the view, or go back to fitting its width.
///
/// The zoom is already a multiple of "as wide as the panel", so fitting the page is
/// arithmetic on the page the reader is looking at and nothing else — pages need not
/// all be the same shape, and a landscape plate in a portrait book should fit as
/// itself.  Like every other control here it is a REPAINT: the layout is the
/// compiler's and does not depend on how much of a page is on screen.
function fitPage(on) {
	S.fit = on ? 'page' : 'width';
	const sc = scroller();
	const w = where();
	const i = w ? Math.min(w.page, S.heights.length - 1) : 0;
	const h = S.heights[i] || 0;
	if (!on || !sc || !h || !S.docW) {
		zoom(1);
		return;
	}
	const cs = getComputedStyle(sc);
	const inner = sc.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
	const deep = sc.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
	// `scale` is `(inner / docW) * zoom`, so the zoom that puts `h` points into `deep`
	// pixels is this and no search is needed.
	//
	// AND NEVER PAST FITTING THE WIDTH, which is what `1` is. A page has two
	// dimensions and the whole of it fits only at the SMALLER of the two fits; taking
	// the height alone in a panel that is tall and narrow gave 330% and cut the page
	// off down both sides, which is not a fit by any reading of the word.
	zoom(inner > 0 ? Math.min(1, (deep * S.docW) / (h * inner)) : 1);
}

/// Dark paper on or off.
///
/// The pages are inverted where they are DRAWN, so the scroller keeps the app's own
/// ground and only the paper turns over.
function dark(on) {
	S.dark = !!on;
	if (!host) return;
	host.setAttribute('data-night', S.dark ? '1' : '0');
	const b = host.querySelector('.tl-night');
	b.setAttribute('aria-pressed', S.dark ? 'true' : 'false');
	// ONE WORD, because the bar is a strip and the word "paper" was doing no work in
	// it: the button sits beside a page, and nothing else in the view is light or
	// dark. The title still says what it turns over, for anybody who hovers.
	b.textContent = S.dark ? tOr('typst.watch.paper_light', 'Light')
		: tOr('typst.watch.paper_dark', 'Dark');
	b.setAttribute('title', S.dark ? tOr('typst.watch.paper_light_why', 'Light paper')
		: tOr('typst.watch.paper_dark_why', 'Dark paper, for reading at night'));
	b.setAttribute('aria-label', b.getAttribute('title'));
}

/// Say which page the reader is on, and how big the pages are drawn.
function sayWhere() {
	if (!host) return;
	const w = where();
	const page = host.querySelector('.tl-page');
	if (page && document.activeElement !== page) {
		page.value = S.pages ? String((w ? w.page : 0) + 1) : '';
	}
	host.querySelector('.tl-of').textContent = S.pages ? '/ ' + S.pages : '';
	host.querySelector('.tl-fit').textContent = Math.round(S.zoom * 100) + '%';
	host.querySelector('.tl-set').style.display = S.pages ? '' : 'none';
	markHere();
}


/// Take the live view down, leaving the panel exactly as it was.
function unmount() {
	if (host && host.parentNode) host.parentNode.removeChild(host);
	host = null;
	band = null;
	vec = null;
	for (const [el, was] of stood) el.style.display = was;
	stood = [];
}

/// Stand in for the panel's other two renderings, remembering what they had.
///
/// Only once the first pages are actually on screen: until then the PDF the button
/// produced is what the reader is looking at, and taking it away to show nothing is
/// the blank this whole file exists to avoid.
function standIn() {
	for (const id of ['pv-view', 'doc-embed']) {
		const el = document.getElementById(id);
		if (!el) continue;
		// What it had is recorded ONCE, the first time; the hiding happens every
		// time. Pressing ⚙ Compile again while the view is live writes a fresh PDF
		// and shows the `<embed>` again, so a `standIn` that returned early left the
		// panel holding the live pages AND the PDF, one under the other.
		if (!stood.some(function (p) { return p[0] === el; })) stood.push([el, el.style.display]);
		el.style.display = 'none';
	}
}

/// The scroller, or null when nothing is mounted.
function scroller() {
	return host ? host.querySelector('.tl-scroll') : null;
}

/// Say what the loop is doing, in the bar over the document.
///
/// Deliberately quiet: a mark and a few words, because the thing worth looking at
/// is the document underneath.  It is never a spinner over the pages, and it never
/// replaces them.
function says(text, mark) {
	if (!host) return;
	host.querySelector('.tl-says').textContent = text || '';
	host.querySelector('.tl-mark').className = 'tl-mark' + (mark ? ' tl-' + mark : '');
	host.setAttribute('data-mode', S.mode + (S.building ? ' building' : ''));
}

/// Offer the Rebuild button, or take it away.
function offerRebuild(on) {
	if (!host) return;
	const b = host.querySelector('.tl-rebuild');
	b.style.display = on ? '' : 'none';
	b.textContent = tOr('typst.watch.rebuild', 'Rebuild');
}

/// Put the compiler's own words over the document, or clear them.
///
/// THE DOCUMENT STAYS. A failed build is the ordinary state of a document being
/// written, and losing the last good pages every time a brace is unbalanced would
/// make the preview useless exactly when it is most wanted.  The words are typst's,
/// naming the file and the line, composed by `typst.js` — not reworded here, since
/// the file and the line are the only part anybody acts on.
function showError(text) {
	if (!host) return;
	const e = host.querySelector('.tl-err');
	S.error = text || '';
	e.textContent = S.error;
	e.style.display = S.error ? '' : 'none';
}


// ── Where the reader was ────────────────────────────────────────────────────

/// Which page the reader is on, and how far into it, in points.
///
/// A fraction of the scroll height would be the easy answer and the wrong one: a
/// paragraph added to chapter two makes the whole book longer, and the same
/// fraction of a longer book is a different page.  A page and an offset within it
/// survives the document growing above the reader, which is the case that actually
/// happens while somebody is writing.
/// TWO COORDINATE SYSTEMS, AND KEEPING THEM APART IS THE WHOLE OF THIS SECTION.
/// `tops` is where a page sits IN THE DOCUMENT and is what the renderer is asked
/// about; `lays` is where its sheet sits ON SCREEN, which is the same thing plus the
/// gaps above it.  The reader's place is a page and an offset in points, so it is the
/// one quantity that means the same in both.
function where() {
	const sc = scroller();
	if (!sc || !S.lays.length) return null;
	const y = sc.scrollTop / (S.scale || 1);		// px back into pt
	// A HAIR OF SLACK AT THE PAGE EDGE, and it is not cosmetic. `goToPage` sets the
	// scroll to a page's own top; the browser hands that number back rounded to a
	// fraction of a pixel, which divided by the scale is a whisper BELOW the top —
	// and without the slack the reader is told they are on the page before the one
	// they were just taken to. A twentieth of a point is a fiftieth of a millimetre.
	const EDGE = 0.05;
	let i = 0;
	while (i + 1 < S.lays.length && S.lays[i + 1] <= y + EDGE) i++;
	return { page: i, into: Math.max(0, y - S.lays[i]) };
}

/// Where each sheet sits on screen, in points, and how tall the stack is.
///
/// Recomputed from `tops` and `heights` rather than carried alongside them, so the
/// gap cannot end up counted twice or not at all.
function layOut() {
	S.lays = [];
	let acc = 0;
	for (let i = 0; i < S.heights.length; i++) {
		S.lays.push(acc);
		acc += S.heights[i] + PAGE_GAP;
	}
	S.laid = S.heights.length ? acc - PAGE_GAP : 0;
}

/// Put the reader back where `w` says, in the document now on screen.
///
/// A page that no longer exists — a chapter deleted while it was being read —
/// clamps to the last one there is, rather than snapping to the top.
function goTo(w) {
	const sc = scroller();
	if (!sc || !w || !S.lays.length) return;
	const i = Math.min(w.page, S.lays.length - 1);
	const into = Math.min(w.into, S.heights[i] || 0);
	sc.scrollTop = (S.lays[i] + into) * (S.scale || 1);
}


// ── Drawing: only the pages the reader can see ──────────────────────────────
//
// THE WHOLE BOOK AT ONCE IS THE ONE THING THAT DOES NOT SCALE, AND IT IS NOT THE
// COMPILER. Measured on the author's 281-page book, laying the pages out costs
// 376-564 ms and everything after it costs seven seconds:
//
//     gather + lay out    376-564 ms
//     session                 27 ms
//     the whole book to SVG  ~250 ms   → 23.7 MB of markup
//     parsing that markup   1300-1900 ms
//     putting it in the DOM 5100-8400 ms   ← the loop, dead
//
// So the pages are drawn a WINDOW at a time. `RenderSession.render_in_window` takes
// a rectangle in document points and returns an SVG carrying only what falls inside
// it. Measured on a 33-page document, whole against a window of six pages:
//
//     whole:   47 ms to SVG, 3.01 MB, 202 ms to parse, 159 ms into the DOM
//     window:   7 ms to SVG, 0.65 MB,   1 ms to parse,   1 ms into the DOM
//
// AND THE ELEMENT MUST NOT BE THE HEIGHT OF THE BOOK EITHER, which is the second
// half of the same lesson and cost a second measurement to find. `render_in_window`
// hands back its window inside the WHOLE DOCUMENT'S viewBox, so the obvious thing —
// keep the element as tall as the book, put only the visible band in it — leaves an
// SVG 192,000 pixels tall. Chrome rasterises that far from its origin at a reduced
// resolution, and from about page forty onward the page comes out as a PALE WASH:
// measured on a 251-page document, page 1 was 5.6% dark pixels and page 40 was
// 0.00%, with the words still legible in outline. It looks exactly like a font or a
// colour bug and is neither.
//
// So the container carries the height and the SVGs carry only the band: a plain
// div as tall as the whole stack, with an absolutely-positioned SHEET per page in
// it, each cropped to its own page by its own viewBox. The scrollbar still measures
// the book, the reader's place still means a page and an offset, and nothing is ever
// asked to rasterise more than one page at a time.
//
// ONE SHEET PER PAGE RATHER THAN ONE SVG PER BAND, because a document is a stack of
// sheets and the author reported the previous drawing as "a continuous page". A
// SESSION MAY BE ASKED MORE THAN ONCE: measured on a six-page fixture, one session,
// one call per page —
//
//     page 1   6.0 ms   80 KB   55 glyph outlines   ← the defs, once
//     page 2   1.5 ms   27 KB    0
//     page 3   0.7 ms   26 KB    0
//     page 4   0.3 ms   27 KB    0
//
// — so the whole band costs about what one call for the same range cost, and the
// glyph outlines are emitted into whichever sheet needed them first. The later
// sheets `<use href="#g…">` them across the SVG boundary, which resolves because
// every sheet of one band goes into the ONE shadow root in the ONE `replaceChildren`
// and an id lookup is per tree, not per element. The band is replaced whole or not at
// all, so a def can never be taken away from a sheet still using it.

// AND `render_in_window` IS A DIFF, WHICH IS THE THIRD THING THIS COST TO LEARN.
// It answers with what has changed since THAT SESSION last drew, not with what is in
// the window. Measured on a 12-page document, one session, four calls:
//
//     first call, pages 1-3        381 KB, 7215 marks
//     the SAME window again          2 KB,    0 marks   ← an empty document
//     move to pages 11-13          114 KB, 2252 marks
//     back to pages 1-3            354 KB, 7162 marks   ← 53 marks it still held
//     a FRESH session, pages 1-3   381 KB, 7215 marks
//
// So a repaint of an unchanged window replaces the pages with nothing, and a repaint
// of an overlapping one silently drops whatever the session thinks is already on
// screen. Both are the blank this file exists to prevent, arriving through the
// renderer rather than through the DOM.
//
// The fix is to give every render its own session, built from the vector bytes that
// are kept for exactly that purpose, and freed the moment the pages are up. A
// session costs 27-32 ms on the 281-page book, which is a scroll of one screenful,
// and the alternative — keeping one session and applying its diffs — means owning
// typst.ts's incremental DOM protocol to save thirty milliseconds nobody can feel.
// (`render_svg_diff` and `mount_dom` are that protocol, if it is ever worth it.)

let band = null;		// the pages currently drawn, as `{ p0, p1 }` inclusive

/// Which sheet the point `y` — in LAID-OUT points — falls on or nearest to.
function pageAt(y) {
	if (!S.lays.length) return 0;
	let i = 0;
	while (i + 1 < S.lays.length && S.lays[i + 1] <= y) i++;
	return i;
}

/// The markup for pages `p0` to `p1` inclusive, out of a session of its own.
///
/// ONE CALL PER SESSION AND NEVER TWO, which cost the afternoon that the inset above
/// only half explains. Asking one session for page after page LOOKED right — each
/// call did answer with its own page — until a document repeated itself. Measured on
/// four pages each holding the same `#lorem(60)`:
///
///     one session, a call per page      428, 5, 7, 5 `<use>`   ← the body vanished
///     a session per page                428, 428, 430, 428
///     one session, ONE call for all     428, 428, 430, 428     ← and 7 ms for four
///
/// The diff is by CONTENT, not by page: a group the session has already drawn is not
/// drawn again, wherever it is. So the band is one call, and the pages are separated
/// afterwards out of the one answer — which is also the cheapest of the three, since
/// a session costs 27-32 ms on the author's 281-page book and this builds one.
function windowOf(ses, p0, p1) {
	return ses.render_in_window(0, S.tops[p0] + PAGE_INSET, S.docW,
		S.tops[p1] + S.heights[p1] - PAGE_INSET);
}

/// The renderer's answer, parsed, with what must not run taken out of it first.
function parseSvg(svg) {
	// The script typst.ts embeds goes before anything parses it — it is not wanted,
	// and its minified `&&` is not well-formed XML either, so leaving it in makes
	// `DOMParser` refuse the whole document and draw a parser-error banner instead
	// of a book.  (Measured, and it looked exactly like a rendering bug.)
	//
	// The `onclick="handleTypstLocation(…)"` on every internal link goes with it:
	// that function was DEFINED in the script just removed, so what is left is a
	// handler naming nothing, on an `<a xlink:href="#">` that would move the app's
	// own URL if it were ever reached.  Removed rather than relied upon to be
	// blocked, because "the policy will stop it" is not a reason to ship it.
	const clean = svg
		.replace(/<script\b[\s\S]*?<\/script>/gi, '')
		.replace(/\sonclick="[^"]*"/gi, '');
	const doc = new DOMParser().parseFromString(clean, 'image/svg+xml');
	const el = doc.documentElement;
	if (!el || el.nodeName === 'parsererror' || el.querySelector('parsererror')) {
		throw new Error('The laid-out pages did not parse: '
			+ String(el && el.textContent).slice(0, 200));
	}
	el.removeAttribute('style');
	return document.importNode(el, true);
}

/// The sheets for the pages around the reader, as one node ready to insert.
///
/// # Arguments
/// * `bytes` - The `vector` artifact this document was laid out to.
/// * `top`   - The top of the visible area, in LAID-OUT points.
/// * `deep`  - How tall the visible area is, in points.
/// * `scale` - Rendered pixels per document point.
function bandNode(bytes, top, deep, scale) {
	const last = S.heights.length - 1;
	if (last < 0) throw new Error('There are no pages to draw.');
	const p0 = Math.max(0, pageAt(Math.max(0, top)) - MARGIN_PAGES);
	const p1 = Math.min(last, pageAt(Math.max(0, top + deep)) + MARGIN_PAGES);
	// A session of its own, so what comes back is the WINDOW and not a diff against
	// whatever was drawn last. Freed before anything is parsed, whatever happens.
	const ses = renderer.session_from_artifact(bytes, 'vector');
	let markup;
	try {
		markup = windowOf(ses, p0, p1);
	} finally {
		try { ses.free(); } catch (e) { /* already gone */ }
	}
	const root = parseSvg(markup);
	// The answer is `<defs class="glyph">`, `<defs class="clip-path">`, `<style>` and
	// then one `<g class="typst-page">` per page. The pages become sheets; everything
	// else is SHARED and rides in the first of them, where an `href="#g…"` from any
	// other sheet still finds it — an id is looked up per TREE, and every sheet of one
	// band goes into the one shadow root in the one `replaceChildren`.
	const shared = [], groups = [];
	for (const el of Array.from(root.children)) {
		const c = el.getAttribute('class') || '';
		if (el.nodeName === 'g' && c.indexOf('typst-page') >= 0) groups.push(el);
		else shared.push(el);
	}
	const wrap = document.createElement('div');
	wrap.className = 'tl-band';
	for (let k = 0; k < groups.length; k++) {
		const m = /translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/
			.exec(groups[k].getAttribute('transform') || '');
		const i = pageOfGroup(m ? parseFloat(m[1]) : 0, k, groups.length, p0, p1);
		// The groups outside the window came back empty, and an empty sheet is a hole
		// in the document. They are dropped rather than drawn.
		if (i < p0 || i > p1 || i > last) continue;
		// A shallow clone of the root keeps its namespaces and its own class; the
		// viewBox is what crops it to this page and nothing else — no transform, no
		// second coordinate system to get wrong, and no element taller than a page for
		// Chrome to rasterise badly.
		const svg = root.cloneNode(false);
		svg.setAttribute('viewBox', '0 ' + S.tops[i] + ' ' + S.docW + ' ' + S.heights[i]);
		svg.setAttribute('width', String(S.docW * scale));
		svg.setAttribute('height', String(S.heights[i] * scale));
		svg.setAttribute('preserveAspectRatio', 'xMidYMin meet');
		// The shared parts ride in THE FIRST SHEET MADE, which is not the first group
		// answered: the groups outside the window were dropped just above, and hanging
		// the glyph outlines on one of those would have thrown them away with it.
		if (!wrap.childElementCount) for (const sh of shared) svg.appendChild(sh);
		svg.appendChild(groups[k]);
		const sheet = document.createElement('div');
		sheet.className = 'tl-sheet';
		sheet.setAttribute('data-page', String(i + 1));
		sheet.style.top    = (S.lays[i] * scale) + 'px';
		sheet.style.width  = (S.docW * scale) + 'px';
		sheet.style.height = (S.heights[i] * scale) + 'px';
		sheet.appendChild(svg);
		wrap.appendChild(sheet);
	}
	band = { p0, p1 };
	return wrap;
}

/// How wide the pages are drawn, and therefore how big everything is.
///
/// Read off the SCROLLER's content box rather than off the pages themselves, because
/// the pages now carry a width of their own: measuring the thing this sets would
/// compound, and one zoom in would become a zoom in per repaint.  The panel is
/// resizable and its width is the app's business; `S.zoom` is the reader's.
function scaleFor(docW) {
	const sc = scroller();
	if (!sc || !docW) return S.scale || 1;
	const cs = getComputedStyle(sc);
	const w = sc.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
	return w > 0 ? (w / docW) * S.zoom : (S.scale || 1);
}

/// Redraw the window if the reader has scrolled out of the one that is drawn.
///
/// Cheap enough to run inside a scroll handler — a few milliseconds — which is why
/// it runs there rather than on a timer. A repaint replaces the SVG in one
/// operation, so there is no frame with nothing in it.
function ensureWindow() {
	const sc = scroller();
	if (!sc || !vec || !band || !renderer) return;
	const scale = S.scale || 1;
	const top = sc.scrollTop / scale, deep = sc.clientHeight / scale;
	// In PAGES, because a sheet is what gets drawn. Clamped to the stack, so a
	// viewport taller than the book cannot ask for a page past the end and repaint on
	// every frame for ever.
	const a = pageAt(Math.max(0, top)), b = pageAt(Math.max(0, top + deep));
	if (a >= band.p0 && b <= band.p1) return;
	try {
		paint(bandNode(vec, top, deep, scale));
	} catch (e) { /* the pages that are up stay up */ }
}

/// Redraw at a new size, because the panel was resized.
///
/// The scale is the only thing that changes; the layout is the compiler's and does
/// not depend on how wide the panel is. So this is a repaint, not a rebuild — the
/// reader's page and offset are in points and survive it untouched.
function resized() {
	if (!vec || !host || !renderer) return;
	const was = where();
	S.scale = scaleFor(S.docW);
	const pages = host.querySelector('.tl-pages');
	pages.style.width  = (S.docW * S.scale) + 'px';
	pages.style.height = (S.laid * S.scale) + 'px';
	band = null;
	const sc = scroller();
	const top = was ? (S.lays[Math.min(was.page, S.lays.length - 1)] + was.into)
		: (sc ? sc.scrollTop / S.scale : 0);
	const deep = sc ? sc.clientHeight / S.scale : S.laid;
	try {
		paint(bandNode(vec, top, deep, S.scale));
	} catch (e) { return; }
	if (was) goTo(was);
	sayWhere();
}

/// Draw `bytes` — one `vector` artifact — into the live view.
///
/// Everything expensive happens on a DETACHED node, and the swap is a single
/// `replaceChildren` with the scroll put back in the same turn.  There is no frame
/// in which the host is empty; `dev/verify_typstwatch.mjs` counts the marks on
/// screen on every animation frame across a rebuild to prove it.
async function draw(bytes) {
	await getRenderer();
	// One session, for the geometry only, and freed before anything is drawn: the
	// page tops and heights are all that is wanted out of the document, and every
	// render after this builds its own (see the note on the diff, above).
	const probe = renderer.session_from_artifact(bytes, 'vector');
	let n, docW, docH;
	const heights = [], tops = [];
	try {
		const info = probe.pages_info;
		n = info.page_count;
		docW = info.width();
		docH = info.height();
		let acc = 0;
		for (let i = 0; i < n; i++) {
			const h = info.page(i).height_pt;
			tops.push(acc);
			heights.push(h);
			acc += h;
		}
	} finally {
		try { probe.free(); } catch (e) { /* already gone */ }
	}

	const sc = scroller();
	const was = where();
	const pages = host.querySelector('.tl-pages');
	// The geometry has to be in place before a band can be asked for, since
	// `bandNode` measures against it. ALL OF IT, `lays` included: the sheets are
	// placed from `lays` and the pages are rendered from `tops`, and a band built
	// with one of them stale would draw the right pages in the wrong places.
	const wasDoc = { w: S.docW, h: S.docH, s: S.scale, t: S.tops, hh: S.heights,
		l: S.lays, ld: S.laid, p: S.pages };
	S.docW    = docW;
	S.docH    = docH;
	S.tops    = tops;
	S.heights = heights;
	layOut();
	const scale = scaleFor(docW);
	// The band to draw is the one the reader is about to be put back at, not the one
	// they are looking at now: the document may have grown above them, and drawing
	// where they are and then scrolling elsewhere would show a screen of blank paper
	// until the repaint caught up.
	let top = sc ? sc.scrollTop / (wasDoc.s || scale) : 0;
	if (was) {
		const i = Math.min(was.page, S.lays.length - 1);
		top = S.lays[i] + Math.min(was.into, heights[i] || 0);
	}
	const deep = sc ? sc.clientHeight / scale : (S.laid || 1);
	let node;
	try {
		node = bandNode(bytes, top, deep, scale);
	} catch (e) {
		// Nothing has been touched on screen yet, so putting the geometry back
		// leaves the pages that are up exactly as they were.
		S.docW = wasDoc.w; S.docH = wasDoc.h;
		S.tops = wasDoc.t; S.heights = wasDoc.hh;
		S.lays = wasDoc.l; S.laid = wasDoc.ld;
		throw e;
	}

	// The container carries the whole STACK's height so the scrollbar measures the
	// book and the gaps between its sheets; each sheet inside it carries one page.
	// Both are set in the same turn as the swap, so there is no frame where the two
	// disagree and the reader is bounced by a scroller that briefly forgot how long
	// the document was.
	pages.style.width  = (docW * scale) + 'px';
	pages.style.height = (S.laid * scale) + 'px';
	paint(node);
	S.scale   = scale;
	S.pages   = n;
	if (was) goTo(was); else if (sc) sc.scrollTop = 0;
	sayWhere();

	// THE LAST GOOD PAGES ARE THESE BYTES AND THE MARKS ON SCREEN, AND NOTHING ELSE.
	// No render session is held between draws — each one is built, used and freed —
	// so the renderer's heap settles at one document's worth rather than growing with
	// the session. What is kept is the vector artifact itself (11.1 MB for the
	// 281-page book), on the JavaScript heap, because a scroll has to be able to draw
	// a page the current source may no longer produce.
	vec = bytes;
	S.drawn++;
	// The scale may have moved a hair between builds, so the band is confirmed
	// against where the reader actually landed rather than where we aimed.
	ensureWindow();
}


// ── The sections, and which page each one is on ─────────────────────────────
//
// WHAT THE COMPILER WILL ANSWER, AND WHAT IT WILL NOT. `query('heading')` hands back
// every heading in document order with its level and its words, in 6 ms on the
// fixture and 9-14 ms on the author's 281-page book. That is the rail's contents, and
// it is exact: it is the compiled document's own answer, not a reading of the source
// and not a guess off the drawn page.
//
// IT WILL NOT ANSWER WHICH PAGE. Measured on this vendored typst 0.14.2 through
// `dev/probe_typstoutline.mjs`:
//
//     query('heading')              6 headings, level and body, 5.8 ms
//     query('heading', 'body')      the words alone, 0.2 ms
//     query('heading', 'location')  []
//     query('heading', 'page')      []
//
// Typst does not put an element's location among its fields, so there is nothing to
// ask for. `dev/TYPST_WATCH.md` §6 reached the same wall from the CLI and concluded
// that a marker in the book was the way out; a rail that only worked for books that
// had been altered to carry markers is not a rail.
//
// So the page comes from the LAID-OUT PAGES instead, which is the other half of the
// same compile: each page is rendered on its own and its text read back, and each
// heading is matched to its own words, in order, going forward and never back.
//
// TWO THINGS MAKE THAT HONEST RATHER THAN A GUESS.
//
//   * IN ORDER. A heading is looked for at or after where the previous one was found,
//     so the rail cannot come out shuffled even when two chapters share a title.
//   * BY SIZE. A document with an `#outline()` prints every heading's words on its
//     first pages, and the naive match puts the whole rail on page 2. So each run
//     carries the size it was set at — typst.ts writes it as the group's own
//     `scale(0.0126,-0.0126)`, which is 12.6 pt — and where a heading's words appear
//     more than once, THE LARGEST SETTING WINS. A contents entry is set at body size
//     and the heading it points at is not.
//
// The one case this cannot separate is a heading set at exactly body size in a
// document that also lists it in a contents; that rail entry lands on the contents
// page. It is named here rather than hidden, and `dev/verify_typstwatch.mjs` proves
// the ordinary case against a fixture that has a contents in it.

/// The text runs of one rendered page, as `{ text, size }` in the order drawn.
///
/// Read out of the markup with a regular expression rather than parsed: this is
/// called once per page of the document and a `DOMParser` per page is the cost that
/// made the whole-book draw untenable. The two things wanted are adjacent in the
/// markup — the group's `scale(…)` is the type size in thousandths, and the `div.tsel`
/// inside it is the run's words.
function runsOf(svg) {
	const out = [];
	const re = /class="typst-text"[^>]*transform="scale\(([-\d.]+)[^"]*"[\s\S]*?class="tsel"[^>]*>([^<]*)</g;
	let m;
	while ((m = re.exec(svg)) !== null) {
		out.push({ size: Math.abs(parseFloat(m[1]) || 0) * 1000, text: unxml(m[2]) });
	}
	return out;
}

/// The rendered markup, cut into pages: `[{ page, runs }]` in the order drawn.
function pagesOfMarkup(markup, p0, p1) {
	const re = /<g[^>]*class="typst-page"[^>]*transform="translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/g;
	const at = [];
	let m;
	while ((m = re.exec(markup)) !== null) at.push({ y: parseFloat(m[1]), from: m.index });
	const out = [];
	for (let k = 0; k < at.length; k++) {
		const to = (k + 1 < at.length) ? at[k + 1].from : markup.length;
		const page = pageOfGroup(at[k].y, k, at.length, p0, p1);
		if (page >= 0) out.push({ page: page, runs: runsOf(markup.slice(at[k].from, to)) });
	}
	return out;
}

/// Which page the `k`th of `n` groups returned for the window `p0`-`p1` is.
///
/// BY ORDER, AND ONLY BY POSITION WHEN THE ORDER CANNOT BE TRUSTED.
///
/// Two things about the renderer's answer have to be known here and neither is
/// obvious. A WINDOW EMITS A GROUP FOR EVERY PAGE OF THE DOCUMENT, not for the pages
/// in it — the ones outside simply come back empty — so the count to expect is the
/// whole page count and a band of three pages arrives as two hundred and eighty-one
/// groups. And READING THE GROUP'S OWN `translate(0, y)` IS WRONG: the renderer
/// rounds that number to a whole point and then accumulates it, so on a page 453.543
/// pt tall the groups come back at 0, 454, 908, 1362 against tops of 0, 453.54,
/// 907.09, 1360.63 — adrift by 0.46 pt a page, which by page two hundred names a page
/// a fifth of a page away from the right one. That cost a rail every entry of which
/// pointed at the contents.
///
/// So the answer is the position in the sequence, which is exact for either count the
/// renderer might answer with; the y is used only to make the best of it when the
/// count says something has changed underfoot.
function pageOfGroup(y, k, n, p0, p1) {
	if (n === S.tops.length) return k;			// every page, which is what it does
	if (n === p1 - p0 + 1) return p0 + k;			// or just the window, one day
	let best = -1, off = Infinity;
	for (let i = 0; i < S.tops.length; i++) {
		const e = Math.abs(S.tops[i] - y);
		if (e < off) { off = e; best = i; }
	}
	return best;
}

/// The five XML entities typst.ts's markup can carry, back as themselves.
function unxml(s) {
	return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
}

/// One string, for comparing what was typeset with what was asked for.
///
/// Typst breaks a heading across lines wherever the measure runs out, and hyphenates
/// while it is at it, so the words come back in pieces that do not line up with the
/// source. Spaces go, and so does everything that is not a letter or a digit: what is
/// left is the same for `Chapter one` and for `Chap- ter one` on two lines.
function fold(s) {
	return String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/// Pull the words out of whatever `query` answered for one heading.
///
/// A heading's `body` is content, not a string: `= *Bold* title` comes back as a tree
/// of `text` nodes. Everything with a `text` is taken, in order, and everything else
/// is walked through — which is the same answer typst would print and needs no
/// knowledge of which element types exist.
function wordsOf(v) {
	if (v == null) return '';
	if (typeof v === 'string') return v;
	if (Array.isArray(v)) return v.map(wordsOf).join('');
	if (typeof v === 'object') {
		if (typeof v.text === 'string') return v.text;
		let out = '';
		for (const k of ['body', 'children', 'child']) if (k in v) out += wordsOf(v[k]);
		return out;
	}
	return '';
}

/// Ask the compiler what this document's headings are, and start finding their pages.
///
/// Called from `build`, in the same turn as the compile that produced these pages, so
/// the compiler still holds this project and answers out of the layout it has just
/// memoised. IT IS NOT CALLED FROM THE VIEW: nothing a reader does to the rail, the
/// zoom or the paper reaches the compiler, which is the rule the whole panel is built
/// on.
async function refreshToc() {
	const q = window.DaimondTypst && window.DaimondTypst.queryProject;
	if (!q) { S.toc = []; drawRail(); return; }		// an older driver in this page
	let list = null;
	try {
		list = await q('heading');
	} catch (e) {
		list = null;
	}
	S.toc = Array.isArray(list) ? list.map(function (h) {
		return {
			text:  wordsOf(h && h.body).replace(/\s+/g, ' ').trim(),
			level: Math.max(1, Math.min(6, Number(h && (h.level || h.depth)) || 1)),
			page:  0,
		};
	}).filter(function (e) { return e.text; }) : [];
	S.scanned = 0;
	drawRail();
	locate();
}

/// Find the page each heading is on, a chunk of pages at a time.
///
/// ONLY WHILE THE RAIL IS OPEN, because it is the rail that wants the answer and a
/// reader who never opens it should not pay for one. It renders and never compiles:
/// on the compiler's side nothing happens at all, and on the renderer's side one
/// session is built, asked for each page in turn, and freed.
///
/// It abandons itself the moment another build lands — `S.drawn` moves — because the
/// pages it is halfway through reading are no longer the pages on screen.
async function locate() {
	// ONE SCAN AT A TIME. `S.scanned` only says a scan has FINISHED, so without this
	// a reader who shuts the rail and opens it again starts a second walk of the book
	// beside the first — twice the renderer's work for one answer, and on a 281-page
	// document that is the difference between a rail that fills in and a tab that
	// stutters.
	if (scanning || !S.rail || !vec || !S.toc.length || S.scanned === S.drawn) return;
	scanning = true;
	try {
		await scan();
	} finally {
		scanning = false;
	}
}

let scanning = false;		// a page scan is walking the document right now

/// The walk itself. `locate` owns the guard; this owns the answer.
async function scan() {
	const serial = S.drawn;
	await getRenderer();
	if (S.drawn !== serial || !vec) return;
	// Every occurrence of every heading's words, with the size it was set at, so the
	// contents entry and the heading itself can be told apart afterwards.
	const want = S.toc.map(function (e) { return fold(e.text); });
	const seen = S.toc.map(function () { return []; });		// [{ page, size }]
	// A CHUNK AT A TIME, ONE SESSION AND ONE CALL EACH. One call, because a session
	// asked twice answers with a diff and a repeated paragraph comes back empty; a
	// chunk rather than the whole book, because the whole of the author's 281-page
	// document is 23.7 MB of markup to hold at once and eight pages is under a
	// megabyte.
	try {
		for (let a = 0; a < S.pages; a += SCAN_CHUNK) {
			const b = Math.min(S.pages - 1, a + SCAN_CHUNK - 1);
			const ses = renderer.session_from_artifact(vec, 'vector');
			let markup;
			try {
				markup = windowOf(ses, a, b);
			} finally {
				try { ses.free(); } catch (e) { /* already gone */ }
			}
			for (const pg of pagesOfMarkup(markup, a, b)) {
				// A heading that broke across lines is several runs, so a page is
				// folded into one string PER SIZE and each heading looked for in each.
				const bySize = new Map();
				for (const r of pg.runs) {
					const k = Math.round(r.size * 10);
					bySize.set(k, (bySize.get(k) || '') + fold(r.text));
				}
				for (const [k, text] of bySize) {
					for (let j = 0; j < want.length; j++) {
						if (want[j] && text.indexOf(want[j]) >= 0) {
							seen[j].push({ page: pg.page + 1, size: k / 10 });
						}
					}
				}
			}
			await frame();
			if (S.drawn !== serial || !vec || !S.rail) return;
		}
	} catch (e) {
		return;			// the rail keeps whatever it had; nothing on screen moved
	}
	if (S.drawn !== serial) return;
	// THE LARGEST SETTING WINS, AND NEVER BEFORE THE ONE ABOVE IT. The first rule
	// separates a heading from its own contents entry; the second keeps the rail in
	// the document's order when two chapters share a title.
	let floor = 0;
	for (let j = 0; j < S.toc.length; j++) {
		const forward = seen[j].filter(function (c) { return c.page >= floor; });
		const pool = forward.length ? forward : seen[j];
		let best = null;
		for (const c of pool) {
			if (!best || c.size > best.size + 0.05) best = c;
		}
		S.toc[j].page = best ? best.page : 0;
		if (best) floor = best.page;
	}
	S.scanned = serial;
	drawRail();
}

/// The next animation frame, so a long scan gives the page back between chunks.
function frame() {
	return new Promise(function (res) {
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function () { res(); });
		else setTimeout(res, 0);
	});
}

/// Open or close the section rail.
///
/// A VIEW CHANGE AND NOTHING ELSE. It shows what the last build already answered; the
/// only work it can start is the page scan, which is the renderer's and never the
/// compiler's.
function rail(on) {
	S.rail = !!on;
	if (!host) return S.rail;
	const nav = host.querySelector('.tl-rail');
	const b = host.querySelector('.tl-toc');
	nav.hidden = !S.rail;
	b.setAttribute('aria-pressed', S.rail ? 'true' : 'false');
	b.setAttribute('aria-expanded', S.rail ? 'true' : 'false');
	host.setAttribute('data-rail', S.rail ? '1' : '0');
	if (S.rail) locate();
	// The pages are drawn to the scroller's width, and the rail just took some of it.
	resized();
	return S.rail;
}

/// Put the sections in the rail, and mark the one the reader is in.
function drawRail() {
	if (!host) return;
	const ol = host.querySelector('.tl-toclist');
	const none = host.querySelector('.tl-tocnone');
	none.style.display = S.toc.length ? 'none' : '';
	if (ol.childElementCount !== S.toc.length) {
		const frag = document.createDocumentFragment();
		for (let i = 0; i < S.toc.length; i++) {
			const li = document.createElement('li');
			const a = document.createElement('button');
			a.type = 'button';
			a.className = 'tl-tocgo';
			a.appendChild(document.createTextNode(''));
			const n = document.createElement('span');
			n.className = 'tl-tocpage';
			a.appendChild(n);
			li.appendChild(a);
			frag.appendChild(li);
			a.addEventListener('click', function () {
				const e = S.toc[i];
				if (e && e.page) goToPage(e.page);
			});
		}
		ol.replaceChildren(frag);
	}
	const kids = ol.children;
	for (let i = 0; i < S.toc.length; i++) {
		const e = S.toc[i];
		const li = kids[i];
		const a = li.firstElementChild;
		li.setAttribute('data-level', String(e.level));
		a.firstChild.nodeValue = e.text;
		a.lastElementChild.textContent = e.page ? String(e.page) : '';
		a.disabled = !e.page;
	}
	hereNow = -2;			// whatever was marked, the list under it is new
	markHere();
}

let hereNow = -2;		// the rail entry last marked, so a scroll costs nothing

/// Mark the section the reader is inside, and only when it changes.
///
/// Called from every scroll, so it does the least work that says the truth: the
/// entry is the last one that STARTS at or before the page in view, and an entry
/// whose page is not known yet cannot be it.
function markHere() {
	if (!host || !S.rail) return;
	const at = where();
	const page = at ? at.page + 1 : 1;
	let cur = -1;
	for (let i = 0; i < S.toc.length; i++) if (S.toc[i].page && S.toc[i].page <= page) cur = i;
	if (cur === hereNow) return;
	const kids = host.querySelector('.tl-toclist').children;
	if (hereNow >= 0 && kids[hereNow]) {
		kids[hereNow].setAttribute('data-here', '0');
		kids[hereNow].firstElementChild.removeAttribute('aria-current');
	}
	if (cur >= 0 && kids[cur]) {
		kids[cur].setAttribute('data-here', '1');
		kids[cur].firstElementChild.setAttribute('aria-current', 'true');
	}
	hereNow = cur;
}


// ── The loop ────────────────────────────────────────────────────────────────

// ── A stamp that moved is not yet a change ──────────────────────────────────
//
// A file says it was written; that is not the same as saying it says something
// different. The author watched the bar cycle `Live` / `Rebuilding` every one to
// two seconds with nothing edited, and by the end of it the compiler was holding
// 2427 MB of the 2500 it is allowed. A rebuild on bytes that have not changed is
// FREE — comemo hashes the text and hands back the layout it already has, measured
// at 0 MB on the author's 281-page book — so a spin costs nothing until the moment
// something really does differ, and then about 10 MB a time. Two hundred of those
// is the wall. `dev/probe_typstloop.mjs` has both figures.
//
// So a moved stamp is CONFIRMED against the file's contents before it counts. That
// is one small read of one file, and only of the file that moved.
//
// THE OUTPUT CANNOT BE USED FOR THIS, which was tried first and is worth writing
// down: compiling the same three-line document three times gives three vector
// artifacts of identical length in which 5,624 of 7,816 bytes differ, and the SVG
// rendered from them differs too. typst.ts's format carries per-item fingerprints
// that are not stable between compiles, so "the pages came out the same" is not a
// question this side can ask. The INPUT is, and it is the honest question anyway.

/// The largest file whose contents are read back to confirm a change.
///
/// Sources are kilobytes and get checked. A font is eleven megabytes and does not
/// rewrite itself, so above this a moved stamp is taken at its word rather than
/// paying to read a typeface on every poll.
const DIGEST_MAX = 1048576;

/// A cheap digest of a file's BYTES, for telling a rewrite from a rewording.
///
/// Bytes and not text, through `read_bytes` rather than `read_file`: the latter ends
/// in `from_utf8_lossy`, so every byte of a picture that is not valid UTF-8 becomes
/// the same replacement character and two different pictures can digest alike. A
/// watcher that stopped following a figure because two versions of it decoded to the
/// same mush would be a very hard afternoon.
function digest(bytes) {
	let h = bytes.length >>> 0;
	for (let i = 0; i < bytes.length; i++) h = (h * 31 + bytes[i]) >>> 0;
	return String(h) + ':' + bytes.length;
}

/// Whether `path` still says exactly what it said when it was last read.
///
/// `false` whenever the answer is not known — the file is too big to check, it
/// could not be read, it is gone, or this is the first time it has been asked. An
/// unknown is a change, because the alternative is a preview that quietly stops
/// following a file.
///
/// # Arguments
/// * `path`  - The workspace-relative path whose stamp moved.
/// * `stamp` - What it just said about itself, `"<lastModified>:<size>"`.
async function confirmed(path, stamp) {
	const size = Number(String(stamp).split(':')[1]);
	if (!(size >= 0) || size > DIGEST_MAX) return false;
	let bytes;
	try {
		const m = await wasm();
		bytes = await m.read_bytes(path, 0, size);
	} catch (e) {
		return false;
	}
	if (!bytes || bytes.length !== size) return false;
	const d = digest(bytes);
	const was = S.digests[path];
	S.digests[path] = d;
	return was !== undefined && was === d;
}

/// Whether the heap has room for another rebuild, and the sentence if it has not.
///
/// The heap is MONOTONIC — a wasm32 `Memory` grows and never shrinks — so this is
/// a high-water mark, not a sample, and once it is over the budget it stays over.
/// That is why the honest remedy is a reload and not "wait a moment".
///
/// `headroom` is the biggest growth any one rebuild has cost so far, so the
/// question asked is "would ANOTHER one like the last fit", which is the question
/// that matters.  Before anything has been measured it is `HEADROOM_MIN`.
function holdCheck() {
	const heap = (window.DaimondTypst && window.DaimondTypst.heapMB)
		? window.DaimondTypst.heapMB() : 0;
	if (heap + S.headroom <= S.budget) return '';
	return tOr('typst.watch.heap',
		'The compiler is holding {heap} MB and another rebuild could need {more} MB more, '
		+ 'which is past the {budget} MB it is allowed on this page. Rebuilding on every save '
		+ 'has stopped, and the pages below are the last ones that built. The compiler cannot '
		+ 'give that memory back — reload the page to start it fresh, or press Rebuild to try '
		+ 'once anyway.',
		{ heap: Math.round(heap), more: Math.round(S.headroom), budget: Math.round(S.budget) });
}

/// Stop rebuilding on every save, and say why.
function hold(why) {
	S.mode = 'held';
	S.reason = why;
	if (timer) { clearTimeout(timer); timer = null; }
	S.queued = false;
	says(tOr('typst.watch.held', 'Rebuilding stopped'), 'held');
	showError(why);
	offerRebuild(true);
}

/// The compiler is gone until the page is reloaded, and nothing pretends otherwise.
function dead(why) {
	S.mode = 'dead';
	S.reason = why;
	if (timer) { clearTimeout(timer); timer = null; }
	if (poller) { clearInterval(poller); poller = null; }
	S.queued = false;
	says(tOr('typst.watch.dead', 'The compiler has stopped'), 'dead');
	showError(tOr('typst.watch.dead_why',
		'The compiler ran out of memory on this document and cannot be restarted without '
		+ 'reloading the page. The pages below are the last ones that built. Reload, and open '
		+ 'the same file again.') + '\n\n' + why);
	offerRebuild(false);
}

/// Rebuild now, coalescing anything already in flight.
///
/// ONE COMPILE AT A TIME AND ONE QUEUED, and a third edit replaces the queued one.
/// Without that a fast typist queues twenty compiles and the preview runs minutes
/// behind the text, which is worse than no preview at all because it looks like one.
///
/// # Arguments
/// * `force` - Skip the heap budget once, because the user pressed Rebuild knowing
///   what it said. The loop never does this to itself.
async function build(force) {
	if (S.mode === 'dead') return;
	if (S.building) { S.queued = true; return; }
	if (!force) {
		const why = holdCheck();
		if (why) { hold(why); return; }
	}
	S.building = true;
	S.builds++;
	says(tOr('typst.watch.building', 'Rebuilding…'), 'building');
	// The files as they stand NOW, taken before the compile reads them.
	//
	// Without this the poll counts the same edit twice: `touched` fires on the write
	// and rebuilds, then the next poll finds the stamps different from ITS last
	// reading and rebuilds again — one keystroke, two compiles, and a burst that
	// coalesced correctly still ran twice. Taken BEFORE rather than after, so a write
	// landing mid-compile is a change the next poll still sees.
	//
	// KEYED BY PATH, NOT BY POSITION. The list itself moves — an edit that adds an
	// `#import` brings a file in, one that removes it takes a file out — and a
	// comparison by index reads every entry after the change as changed, rebuilds,
	// records the new list against the OLD list's readings, and finds them all
	// changed again. That is a rebuild loop with nothing edited, and it costs about
	// 10 MB of wasm heap every time the bytes really do differ (measured, on the
	// author's 281-page book, in `dev/probe_typstloop.mjs`), so a spin nobody
	// notices walks the compiler into the ceiling in a few hundred rebuilds.
	S.stamps = (await stamps()) || S.stamps;
	const heapBefore = (window.DaimondTypst && window.DaimondTypst.heapMB)
		? window.DaimondTypst.heapMB() : 0;
	const t0 = Date.now();
	let out = null;
	try {
		const m = await wasm();
		out = await m.typst_compile_project_vector(S.path);
	} catch (e) {
		out = { error: (e && e.message) ? e.message : String(e) };
	}
	const took = Date.now() - t0;
	const heapAfter = (window.DaimondTypst && window.DaimondTypst.heapMB)
		? window.DaimondTypst.heapMB() : 0;
	if (heapAfter - heapBefore > S.headroom) S.headroom = heapAfter - heapBefore;

	// The watch list is re-read from every compile, failed or not: an edit that adds
	// an `#import` brings a file into the project, and a watcher still polling
	// yesterday's list would never see it change.
	if (out && out.watch && out.watch.length) {
		S.files = Array.from(out.watch).map(String);
	}

	if (out && out.vector && out.vector.length) {
		// A REBUILD NOBODY COULD CONFIRM is counted, because it is the only kind left
		// that can spin. Everything small enough to read back is checked against its
		// own contents and never gets here twice for nothing; what remains is a file
		// too big to check saying it moved, over and over, which is a loop with no
		// evidence behind it and the heap ceiling at the end of it.
		S.same = S.blind ? S.same + 1 : 0;
		try {
			await draw(out.vector);
			// The sections, asked of the compiler in the same turn as the compile that
			// produced these pages — see `refreshToc`. Not awaited on purpose: the
			// pages are up and the rail filling in a moment later costs the reader
			// nothing, whereas a rail that held the loop would.
			refreshToc();
			// A good build after a bad one clears the error SILENTLY. Nothing
			// announces the fix: the reader is looking at the page they were
			// trying to get back, and a banner saying so is in the way.
			showError('');
			// A HELD LOOP IS NOT UNHELD BY A BUILD SUCCEEDING. The user pressing
			// Rebuild proves the compile fits today, not that the heap has room for
			// the next one — and the heap only ever grows, so it usually has less.
			// Resuming on a success would quietly put the loop back on the path to
			// the wall, which is the one thing the budget exists to prevent. It
			// resumes only when the budget itself says there is room, which after a
			// reload it does.
			if (S.mode === 'held' && !holdCheck()) {
				S.mode = 'live';
				S.reason = '';
				offerRebuild(false);
			} else if (S.mode === 'held') {
				showError(S.reason);
				says(tOr('typst.watch.held', 'Rebuilding stopped'), 'held');
			}
		} catch (e) {
			S.failed++;
			showError((e && e.message) ? e.message : String(e));
		}
	} else {
		S.failed++;
		const why = (out && out.error) ? String(out.error) : tOr('typst.watch.nothing',
			'The compiler produced nothing and gave no reason.');
		showError(why);
		if (TRAPPED.test(why)) {
			S.building = false;
			dead(why);
			return;
		}
	}

	// The wait is the last rebuild's own length, so it fits whatever is being
	// written rather than whatever was guessed when this was written.
	S.debounce = Math.max(DEBOUNCE_MIN, Math.min(DEBOUNCE_MAX, took));
	S.building = false;
	if (S.mode === 'live' && S.same >= SPIN_MAX) {
		S.same = 0;
		hold(tOr('typst.watch.spin',
			'A watched file keeps reporting that it has changed, and it is too large '
			+ 'to read back and check: the pages have been laid out {n} times in a row '
			+ 'for it. Rebuilding on every save has stopped, so that it cannot fill '
			+ 'the compiler\u2019s memory. Press Rebuild when you want the pages '
			+ 'again. The file was {what}.',
			{ n: SPIN_MAX + 1, what: S.why.replace(/^(poll|write): /, '').split(' ')[0] }));
		return;
	}
	if (S.mode === 'live') {
		says(S.error
			? tOr('typst.watch.stale', 'Showing the last build that worked')
			: tOr('typst.watch.live_preview', 'Live preview'), S.error ? 'stale' : 'live');
	}
	if (S.queued) { S.queued = false; if (S.mode === 'live') build(false); }
}

/// Something was written; rebuild when the writing stops.
///
/// WHAT ASKED FOR THE REBUILD IS RECORDED, and comes back out through `state()`.
/// A loop that rebuilds when nothing has been edited is the one fault a reader
/// cannot diagnose from the screen — the bar says `Rebuilding…` and that is all —
/// so the answer to "what did it think had changed" is kept where it can be read
/// back and reported, instead of being worked out again from scratch each time.
///
/// # Arguments
/// * `cause`  - `'write'` or `'poll'`: how the change was noticed.
/// * `detail` - The path, and for a poll the two readings that differ.
function nudge(cause, detail) {
	if (S.mode !== 'live') return;
	S.cause = cause || '';
	S.why   = (cause || '') + ': ' + (detail || '');
	if (timer) clearTimeout(timer);
	timer = setTimeout(function () { timer = null; build(false); }, S.debounce);
}

/// What every watched file says about itself right now, as `{ path: stamp }`.
///
/// One question, asked from two places — the poll, and the moment before a rebuild
/// — so the loop cannot end up with two ideas of what it has already seen.
///
/// BY PATH, because the list is not stable and the answer has to survive it moving.
/// `null` when the question could not be asked, which is not the same as "nothing
/// changed" and must not be recorded as a reading.
async function stamps() {
	if (!S.files.length) return null;
	try {
		const m = await wasm();
		const got = Array.from(await m.typst_watch_stamps(S.files)).map(String);
		const out = {};
		for (let i = 0; i < S.files.length && i < got.length; i++) out[S.files[i]] = got[i];
		return out;
	} catch (e) {
		return null;			// a question that could not be asked is not an answer
	}
}

/// Ask the watched files whether they have changed, and nudge if any has.
async function poll() {
	if (S.mode === 'dead' || !S.path || !S.files.length) return;
	// The view being gone is what ends the watch. There is no toggle and no second
	// concept: the reader closed the document, so nothing more is compiled for it.
	//
	// "Gone" and "not there yet" are different, and telling them apart is the whole
	// of `seen`. The watch is armed by a compile that finished BEFORE the panel was
	// shown -- `began` is called from Rust, and the page opens the panel a moment
	// later, in the same turn -- so a poll landing in that gap would find the panel
	// invisible and stop a watch that had never started.
	const shown = host && host.isConnected && visible(document.getElementById('panel-preview'));
	if (shown) S.seen = true;
	if (S.seen && !shown) {
		stop();
		return;
	}
	if (!shown) return;
	const before = S.stamps;
	const now = await stamps();
	if (!now) return;			// the question could not be asked
	S.stamps = now;
	if (!before) return;			// nothing to compare a first reading against
	// A path in ONE of the two readings is not a change. A file the last compile
	// brought into the project has never been read before, and one it dropped is no
	// longer part of the document; either would be reported as a change by a
	// comparison that walked positions, and neither is one. A watched file DELETED
	// from disk still answers, as `0:-1`, so a chapter removed under the reader is
	// still a rebuild — which is the case the old comparison was written for.
	for (const p in now) {
		if (!(p in before) || now[p] === before[p]) continue;
		// It said it was written. Whether it says anything DIFFERENT is another
		// question, and the one that decides whether there is anything to lay out.
		if (await confirmed(p, now[p])) continue;
		S.blind = (Number(String(now[p]).split(':')[1]) > DIGEST_MAX);
		nudge('poll', p + ' ' + before[p] + ' \u2192 ' + now[p]);
		return;
	}
}

/// Whether an element is on screen at all.
function visible(el) {
	if (!el) return false;
	return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}


// ── The doors ───────────────────────────────────────────────────────────────

/// A document has just been compiled from the page: follow it from here.
///
/// Called by `src/wasm/typst.rs` at the page's own Compile door, after a compile
/// that WORKED.  That is the whole of how the watch starts — no toggle, no setting,
/// and nothing that reaches for a compiler on its own.  A vector compile does not
/// call this, or every rebuild would re-arm the loop that produced it.
///
/// # Arguments
/// * `path`  - The `.typ` that was compiled, workspace-relative.
/// * `watch` - Every real path that compile read.
function began(path, watch) {
	const p = String(path || '');
	if (!p) return;
	const files = watch ? Array.from(watch).map(String) : [];
	if (S.path === p && S.mode !== 'idle' && host && host.isConnected) {
		S.files = files.length ? files : S.files;
		// Compiling again wrote a fresh PDF and put the `<embed>` back on screen, so
		// the live view takes its place again rather than sitting beside it.
		if (S.drawn) standIn();
		return;			// already following this one
	}
	stop();
	S.path     = p;
	S.files    = files;
	S.stamps   = null;
	S.cause    = 'began';
	S.why      = 'began: ' + p;
	S.digests  = {};
	S.blind    = false;
	S.same     = 0;
	S.mode     = 'live';
	S.builds   = 0;
	S.drawn    = 0;
	S.failed   = 0;
	S.debounce = DEBOUNCE_MIN;
	S.headroom = HEADROOM_MIN;
	S.seen     = false;
	S.toc      = [];
	S.scanned  = 0;
	if (!mount()) { S.mode = 'idle'; S.path = ''; return; }
	says(tOr('typst.watch.starting', 'Laying out the pages…'), 'building');
	// The first live view is drawn BEFORE anything is hidden, so the PDF the button
	// just produced stays on screen until there are pages to put in its place.
	build(false).then(function () {
		if (S.mode !== 'idle' && S.drawn) standIn();
	});
	poll();
	if (poller) clearInterval(poller);
	poller = setInterval(function () { poll(); }, POLL_MS);
}

/// Stop watching and put the panel back as it was.
///
/// Called when the reader closes the document, and by `began` before it follows a
/// different one.  Nothing is compiled after this: the poll is cleared, the pending
/// debounce is cleared, and a build already in flight finds `mode` no longer `live`.
function stop() {
	if (timer) { clearTimeout(timer); timer = null; }
	if (poller) { clearInterval(poller); poller = null; }
	unmount();
	S.path   = '';
	S.files  = [];
	S.stamps = null;
	S.mode   = 'idle';
	S.queued = false;
	S.seen   = false;
	S.error  = '';
	S.reason = '';
	S.cause  = '';
	S.why    = '';
	S.digests = {};
	S.blind  = false;
	S.same   = 0;
	S.toc    = [];
	S.scanned = 0;
	S.tops   = [];
	S.heights = [];
	S.lays   = [];
	S.laid   = 0;
	S.pages  = 0;
	hereNow  = -2;
}

/// A writer that KNOWS it wrote says so, rather than waiting to be polled.
///
/// Both actors drive this loop and they are known in different ways.  A daimon's
/// write and the panel's own Save both go through the one Rust door for bytes, and
/// that door says so here; an external editor writing into a folder the user marked
/// in cannot say anything at all, and is caught by the poll.  Naming a path that is
/// not in the project is not a change: a turn writing a log file beside a book must
/// not rebuild the book.
///
/// # Arguments
/// * `path` - The workspace-relative path just written.
async function touched(path) {
	if (S.mode !== 'live') return;
	const p = String(path || '');
	if (!p) return;
	if (p !== S.path && S.files.indexOf(p) < 0) return;
	// Told rather than polled, but the question is the same one: a Save that wrote
	// back exactly what was there is a write, not an edit, and laying the book out
	// again for it would cost the reader a rebuild to see what is already up.
	let stamp = '';
	try {
		const m = await wasm();
		stamp = String((await m.typst_watch_stamps([p]))[0] || '');
	} catch (e) { /* ask the file's contents anyway */ }
	if (stamp && await confirmed(p, stamp)) return;
	S.blind = !!stamp && Number(String(stamp).split(':')[1]) > DIGEST_MAX;
	nudge('write', p);
}

/// Rebuild now, because the user asked.
///
/// The one place the heap budget is skipped, and only ever by a person who has just
/// read the sentence saying why it stopped.  The loop never does this to itself.
function rebuild() {
	if (S.mode === 'dead' || !S.path) return;
	if (timer) { clearTimeout(timer); timer = null; }
	// The user asking is not the loop spinning, whatever the last few builds did.
	S.cause = 'user';
	S.why   = 'user: Rebuild';
	S.blind = false;
	S.same  = 0;
	build(true);
}

/// Read or set the heap ceiling, in MB.
///
/// A real setting rather than a test hook: this machine is not every machine, and
/// an operator with headroom may want a bigger one.  Setting it does not change the
/// wall, which is the browser's and is about 4 GB — it changes how far from the wall
/// this stops.
function budgetMB(n) {
	const v = Number(n);
	if (Number.isFinite(v) && v > 0) S.budget = v;
	// Raising the ceiling on a loop that stopped because of it starts it again.
	// Anything else would leave the setting looking broken: the number changed, the
	// sentence still says there is no room, and nothing moves until a reload.
	if (S.mode === 'held' && !holdCheck()) {
		S.mode = 'live';
		S.reason = '';
		showError('');
		offerRebuild(false);
		says(tOr('typst.watch.live_preview', 'Live preview'), 'live');
	}
	return S.budget;
}

/// Where page `n` sits in the scroller, in CSS pixels: `{ top, height }`.
///
/// The scroller's own height is the whole document's and the SVG in it is only the
/// band in view, so nothing outside can work this out by measuring elements. It is
/// published because the answer is wanted — by a verifier photographing one page,
/// and by any control that jumps to a page.
///
/// # Arguments
/// * `n` - The 1-based page number.
function pageBox(n) {
	const i = Math.max(0, Math.min(Math.floor(n) - 1, S.lays.length - 1));
	if (!S.lays.length) return null;
	return { top: S.lays[i] * S.scale, height: S.heights[i] * S.scale };
}

/// Scroll so that page `n` is at the top of the view, and draw it.
function goToPage(n) {
	const sc = scroller();
	const b = pageBox(n);
	if (!sc || !b) return;
	sc.scrollTop = Math.min(sc.scrollHeight - sc.clientHeight, b.top);
	ensureWindow();
}

/// What the loop is doing, for the panel and for a verifier alike.
///
/// ONE answer, read out of the same object the loop acts on, so a check cannot
/// pass against a mirror of the state that has drifted from the state.
function state() {
	return {
		path:     S.path,
		mode:     S.mode,
		files:    S.files.length,
		builds:   S.builds,
		drawn:    S.drawn,
		failed:   S.failed,
		pages:    S.pages,
		debounce: S.debounce,
		budget:   S.budget,
		headroom: S.headroom,
		building: S.building,
		error:    S.error,
		reason:   S.reason,
		why:      S.why,
		same:     S.same,
		heap:     (window.DaimondTypst && window.DaimondTypst.heapMB)
			? window.DaimondTypst.heapMB() : 0,
		rheap:    rheapMB(),
		scroll:   scroller() ? scroller().scrollTop : 0,
		at:       where(),
		zoom:     S.zoom,
		fit:      S.fit,
		dark:     S.dark,
		rail:     S.rail,
		gap:      PAGE_GAP,
		sheets:   band ? (band.p1 - band.p0 + 1) : 0,
		band:     band ? { p0: band.p0, p1: band.p1 } : null,
		toc:      S.toc.map(function (e) {
			return { text: e.text, level: e.level, page: e.page };
		}),
		located:  S.scanned === S.drawn && S.drawn > 0,
	};
}

/// The sections as the rail has them: `{ text, level, page }`, in document order.
function sections() {
	return state().toc;
}

if (typeof window !== 'undefined' && !window.DaimondTypstWatch) {
	// A write that Daimond itself made is known the moment it lands: every byte the
	// app writes goes through one Rust door (`opfs::write_file`), and that door says
	// so on `window`. So a daimon editing a chapter refreshes the view immediately,
	// while an external editor writing into a marked folder waits for the next poll
	// — the File System Access API has no change events, so there is nothing else it
	// could wait for.
	window.addEventListener('daimond-file-written', function (ev) {
		touched(ev && ev.detail ? ev.detail.path : '');
	});
	window.DaimondTypstWatch = {
		began:    began,
		stop:     stop,
		touched:  touched,
		rebuild:  rebuild,
		budgetMB: budgetMB,
		zoom:     zoom,
		dark:     dark,
		state:    state,
		pageBox:  pageBox,
		goToPage: goToPage,
		rail:     rail,
		sections: sections,
		fitPage:  fitPage,
	};
}

export { began, stop, touched, rebuild, budgetMB, zoom, dark, state, pageBox, goToPage,
	rail, sections, fitPage };
