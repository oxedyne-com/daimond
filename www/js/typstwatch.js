/* ============================================================
   Daimond — the watched live document
   ------------------------------------------------------------
   `typst watch` and a document viewer, inside the page.  The
   author edits a `.typ` — or a daimon does — and the pages he is
   looking at become the new ones, in place, without him asking.

       window.DaimondTypstWatch = {
           began, stop, touched, rebuild, budgetMB, zoom, dark,
           state, pageBox, goToPage
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
	tops:     [],		// each page's top, in pt
	heights:  [],		// each page's height, in pt
	zoom:     1,		// how much bigger than fitting the panel's width
	dark:     false,	// the paper turned over, for reading at night
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
		s.replaceSync(TYPST_CSS);
		root.adoptedStyleSheets = [s];
		sheetEl = null;
		return;
	} catch (e) { /* an engine without constructable sheets */ }
	sheetEl = document.createElement('style');
	sheetEl.textContent = TYPST_CSS;
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
		+ '<div class="tl-scroll"><div class="tl-pages"></div></div>'
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
	const page = q('.tl-page'), out = q('.tl-out'), inn = q('.tl-in'), fit = q('.tl-fit');
	page.setAttribute('aria-label', tOr('typst.watch.page', 'Page'));
	out.setAttribute('title', tOr('typst.watch.zoom_out', 'Smaller'));
	out.setAttribute('aria-label', out.getAttribute('title'));
	inn.setAttribute('title', tOr('typst.watch.zoom_in', 'Bigger'));
	inn.setAttribute('aria-label', inn.getAttribute('title'));
	fit.setAttribute('title', tOr('typst.watch.fit', 'Fit the width'));
	dark(S.dark);			// the one whose LABEL is its state
	offerRebuild(host.querySelector('.tl-rebuild').style.display !== 'none');
}

/// Wire the bar's controls, once, at mount.
function controls() {
	const q = (c) => host.querySelector(c);
	const page = q('.tl-page'), out = q('.tl-out'), inn = q('.tl-in'),
		fit = q('.tl-fit'), night = q('.tl-night');
	labels();
	out.addEventListener('click', function () { zoom(S.zoom / 1.25); });
	inn.addEventListener('click', function () { zoom(S.zoom * 1.25); });
	fit.addEventListener('click', function () { zoom(1); });
	night.addEventListener('click', function () { dark(!S.dark); });
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
	sayWhere();
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
	b.textContent = S.dark ? tOr('typst.watch.day', 'Light paper')
		: tOr('typst.watch.night', 'Dark paper');
	b.setAttribute('title', b.textContent);
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
function where() {
	const sc = scroller();
	if (!sc || !S.tops.length) return null;
	const y = sc.scrollTop / (S.scale || 1);		// px back into pt
	let i = 0;
	while (i + 1 < S.tops.length && S.tops[i + 1] <= y) i++;
	return { page: i, into: y - S.tops[i] };
}

/// Put the reader back where `w` says, in the document now on screen.
///
/// A page that no longer exists — a chapter deleted while it was being read —
/// clamps to the last one there is, rather than snapping to the top.
function goTo(w) {
	const sc = scroller();
	if (!sc || !w || !S.tops.length) return;
	const i = Math.min(w.page, S.tops.length - 1);
	const into = Math.min(w.into, S.heights[i] || 0);
	sc.scrollTop = (S.tops[i] + into) * (S.scale || 1);
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
// So the container carries the height and the SVG carries only the band: a plain
// div as tall as the whole document, with an absolutely-positioned SVG inside it,
// cropped to the band by its own viewBox and about three screens tall. The
// scrollbar still measures the book, the reader's place still means a page and an
// offset, and nothing is ever asked to rasterise more than a few screens.

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

/// How much beyond the visible band is drawn, as a multiple of the viewport.
///
/// One screen either way: enough that a flick of the wheel lands inside what is
/// already drawn, and small enough that a window stays a few hundred kilobytes and
/// three screens tall.
const WINDOW_MARGIN = 1;

let band = null;		// the document band currently drawn, in points

/// The SVG for the band of document around `top`, as a node ready to insert.
///
/// # Arguments
/// * `bytes` - The `vector` artifact this document was laid out to.
/// * `top`   - The top of the visible area, in document points.
/// * `deep`  - How tall the visible area is, in document points.
/// * `scale` - Rendered pixels per document point.
function windowNode(bytes, top, deep, scale) {
	const docH = S.docH, docW = S.docW;
	const lo = Math.max(0, Math.min(docH, top - deep * WINDOW_MARGIN));
	const hi = Math.max(lo, Math.min(docH, top + deep * (1 + WINDOW_MARGIN)));
	// A session of its own, so what comes back is the WINDOW and not a diff against
	// whatever was drawn last. Freed before this returns, whatever happens.
	const ses = renderer.session_from_artifact(bytes, 'vector');
	let svg;
	try {
		svg = ses.render_in_window(0, lo, docW, hi);
	} finally {
		try { ses.free(); } catch (e) { /* already gone */ }
	}
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
	// The band, and only the band. `render_in_window` draws at the document's own
	// coordinates, so cropping to it is a viewBox and nothing else — no transform,
	// no second coordinate system to get wrong.
	el.setAttribute('viewBox', '0 ' + lo + ' ' + docW + ' ' + (hi - lo));
	el.setAttribute('width', String(docW * scale));
	el.setAttribute('height', String((hi - lo) * scale));
	el.setAttribute('preserveAspectRatio', 'xMidYMin meet');
	el.removeAttribute('style');
	const node = document.importNode(el, true);
	node.style.position = 'absolute';
	node.style.left = '0';
	node.style.top = (lo * scale) + 'px';
	band = { lo, hi };
	return node;
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
	// Clamped to the document, because a viewport taller than the book would
	// otherwise never be "inside" the band and would repaint on every frame.
	const want = { lo: Math.max(0, top), hi: Math.min(S.docH, top + deep) };
	if (want.lo >= band.lo && want.hi <= band.hi) return;
	try {
		paint(windowNode(vec, top, deep, scale));
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
	pages.style.height = (S.docH * S.scale) + 'px';
	band = null;
	const sc = scroller();
	const top = was ? (S.tops[Math.min(was.page, S.tops.length - 1)] + was.into)
		: (sc ? sc.scrollTop / S.scale : 0);
	const deep = sc ? sc.clientHeight / S.scale : S.docH;
	try {
		paint(windowNode(vec, top, deep, S.scale));
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
	// The geometry has to be in place before a window can be asked for, since
	// `windowNode` measures against it.
	const wasDoc = { w: S.docW, h: S.docH, s: S.scale, t: S.tops, hh: S.heights, p: S.pages };
	S.docW = docW;
	S.docH = docH;
	const scale = scaleFor(docW);
	// The band to draw is the one the reader is about to be put back at, not the one
	// they are looking at now: the document may have grown above them, and drawing
	// where they are and then scrolling elsewhere would show a screen of blank paper
	// until the repaint caught up.
	let top = sc ? sc.scrollTop / (wasDoc.s || scale) : 0;
	if (was) {
		const i = Math.min(was.page, tops.length - 1);
		top = tops[i] + Math.min(was.into, heights[i] || 0);
	}
	const deep = sc ? sc.clientHeight / scale : (docH || 1);
	let node;
	try {
		node = windowNode(bytes, top, deep, scale);
	} catch (e) {
		// Nothing has been touched on screen yet, so putting the geometry back
		// leaves the pages that are up exactly as they were.
		S.docW = wasDoc.w; S.docH = wasDoc.h;
		throw e;
	}

	// The container carries the whole document's height so the scrollbar measures
	// the book; the SVG inside it carries only the band. Both are set in the same
	// turn as the swap, so there is no frame where the two disagree and the reader
	// is bounced by a scroller that briefly forgot how long the document was.
	pages.style.width  = (docW * scale) + 'px';
	pages.style.height = (docH * scale) + 'px';
	paint(node);
	S.scale   = scale;
	S.pages   = n;
	S.tops    = tops;
	S.heights = heights;
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
			: tOr('typst.watch.live', 'Live'), S.error ? 'stale' : 'live');
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
		says(tOr('typst.watch.live', 'Live'), 'live');
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
	const i = Math.max(0, Math.min(Math.floor(n) - 1, S.tops.length - 1));
	if (!S.tops.length) return null;
	return { top: S.tops[i] * S.scale, height: S.heights[i] * S.scale };
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
		dark:     S.dark,
	};
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
	};
}

export { began, stop, touched, rebuild, budgetMB, zoom, dark, state, pageBox, goToPage };
