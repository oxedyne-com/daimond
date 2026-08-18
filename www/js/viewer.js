// viewer.js — showing a file as what it IS, and never as characters it is not.
//
// Clicking a PDF used to fill the document panel with replacement characters,
// because `read_file` ends in `from_utf8_lossy` and every byte that is not
// valid UTF-8 became U+FFFD on the way into a `<pre>`. The app looked broken
// rather than the format looking unsupported, and those are very different bug
// reports.
//
// `file_probe` in the wasm now says what a file is from its first 512 bytes,
// and `read_bytes` hands over a range of it byte-exactly. This file is what
// spends them. It has four tiers, and they are in order of how much is known:
//
//   1. THE BROWSER DECODES IT. Pictures, sound, moving pictures, PDF and HTML
//      go to the decoder that exists for them, on a `Blob` carrying the probe's
//      own media type -- a `Blob` with the wrong type is how a correct picture
//      fails to appear, and for a PDF the type is what makes it safe as well.
//   2. TEXT-SHAPED STRUCTURE. JSON as a tree, CSV and TSV as a table, Markdown
//      through the renderer the chat already uses.
//   3. THE HONEST FLOOR. Everything else gets a hex and ASCII dump, paged, with
//      the format named. This is the tier that matters: it turns every format
//      nobody wrote a viewer for into something a person can inspect, instead
//      of into an apology.
//   4. AND IT SAYS WHEN THE NAME AND THE BYTES DISAGREE. A file called `.png`
//      holding PDF bytes is how somebody finds a broken export. Every other
//      viewer hides it.
//
// TWO RULES ARE LOAD-BEARING AND NEITHER IS A PREFERENCE.
//
// A FRAME gets `sandbox="allow-scripts"` and nothing else, ever. A `blob:` URL
// INHERITS OUR ORIGIN, so a frame with `allow-same-origin` runs as the app: it
// reads `localStorage`, where the user's API key lives, and it reaches OPFS.
// The file being framed may be one an agent wrote a moment ago, after reading a
// web page that told it what to write. `www/js/web.js` sets this out at length
// where the Web panel does the same thing. SVG is therefore shown through
// `<img>` and never a frame: script inside an SVG executes in a frame and does
// not in an `<img>`, which is the whole reason it sits in the image list.
//
// A PDF IS NOT FRAMED, AND THAT IS THE SAME RULE RATHER THAN AN EXCEPTION TO IT.
// A `sandbox` attribute of any value stops Chrome instantiating its PDF viewer,
// so a framed PDF drew a broken-page glyph and nothing else -- for months, under
// a header naming the format and its size, which is how it went unnoticed. PDFs
// go to an `<embed>` typed from the probe, and what keeps THAT from running as
// the app is the blob's type: `application/pdf` is handed to the PDF viewer and
// its bytes are never parsed as a document. Both halves are measured, not
// assumed; the note on `doc` below records what was measured and how.
//
// And nothing large is ever materialised. `createObjectURL` on a real `File`
// handle is cheap because the browser streams it off disk; on a `Blob` built in
// memory it is not, and all this has is `read_bytes`, so it is always building.
// Reads are therefore CAPPED and the cap is always SAID -- a silent truncation
// reads as a corrupt file. Bytes reach the blob store four megabytes at a time
// and are dropped as they go, so the JS heap holds one chunk however big the
// file is. This machine has been driven out of memory three times; a viewer
// that reads a 900 MB video into wasm memory would be the fourth.
//
// AND THERE ARE TWO DOORS OUT OF IT, added because the app could already write
// and edit an Office document and no part of the browser could ask it to.
// `office_write_docx` and `office_write_left` had been exported from the wasm
// with no caller in `www/js/` at all, so a capability shipped and nobody could
// reach it -- a failure this project has had three times.
//
//   * `fv-save` hands the bytes over as a file, on the app's own <a download>
//     route. It is the bytes CURRENTLY HELD, so it means the same thing before
//     and after an edit, and nothing it does touches the file on disk.
//   * `fv-edit` opens `fv-editrow` and applies a SURGICAL edit -- find and
//     replace in a text document, one cell in a spreadsheet -- through
//     `office_edit_doc` / `office_edit_sheet`, which rewrite the runs they were
//     asked to and copy every other part of the archive across byte for byte.
//     Round-tripping a stranger's document through Markdown to change one word
//     is data loss with a friendly face.
//
// A DECK GETS NEITHER, and the Markdown tier gets the write. Both of those are
// in `EDIT_DOOR` and `WRITE_AS`, with the reasons beside them.
//
//     window.DaimondViewer = { probe, verdict, show, close, at, opener,
//                              editable, KIND_HANDLERS }
//     window.DaimondDoc    = { show }          // what the DAIMON calls
//
// `opts` carries `{ store, t, onError, wasm }`. Every user-visible string in
// this file goes through `opts.t`, so the file holds no English of its own that
// a translation pass cannot reach.
//
// AND ONE THING HERE IS NOT FOR THE USER AT ALL. `DaimondDoc` at the bottom is
// the door the model reaches this panel through, and it exists because the
// absence of it was reported as a limitation of the app: asked to display a PDF
// that was sitting in the workspace, a daimon answered that it could not show
// one inline, "the file tools return raw bytes for it rather than a rendered
// view". Every word of that is true about its TOOLBOX and false about Daimond,
// which had been drawing PDFs since the `doc` tier below was written. A model
// reasons from the tools it holds, so a working surface it cannot reach is a
// surface it will tell the user does not exist.
(function () {
	'use strict';

	// ── Where the wasm is ────────────────────────────────────────────
	//
	// `daimond.js` is the app's one module and imports the package directly.
	// This is a classic script, so it asks for the same URL by dynamic import
	// -- the module map is keyed by URL, so this is the SAME instance, already
	// initialised, and not a second copy of the wasm. A caller that already
	// holds the namespace may hand it over as `opts.wasm` and skip all of it.
	var SELF = (document.currentScript && document.currentScript.src) || '';
	var PKG  = /\/js\/[^/]*$/.test(SELF)
		? SELF.replace(/\/js\/[^/]*$/, '/pkg/oxedyne_daimond.js')
		: new URL('pkg/oxedyne_daimond.js', document.baseURI).href;
	var pkgP = null;

	function mod(opts) {
		if (opts && opts.wasm) return Promise.resolve(opts.wasm);
		if (!pkgP) pkgP = import(PKG);
		return pkgP;
	}

	// ── Caps ─────────────────────────────────────────────────────────

	/// The most that is ever assembled into a `Blob` for the browser to decode.
	/// Past this the file is named and its bytes are dumped instead, because a
	/// prefix of an MP4 is not a shorter video -- it is a broken one.
	var CAP_WHOLE = 64 * 1024 * 1024;
	/// The most text that is ever decoded and put on screen. A prefix of text IS
	/// readable text, so this one truncates and says so.
	var CAP_TEXT  = 2 * 1024 * 1024;
	/// How much reaches the JS heap at once on the way to the blob store.
	var CHUNK     = 4 * 1024 * 1024;
	/// The most of an Office document that is ever unpacked. It is a ZIP, so its
	/// parts inflate several times over and the ceiling that matters is on what
	/// comes out; this is the ceiling on what goes in, and it matches
	/// `OFFICE_READ_MAX` in `src/tools.rs` so the panel and the model agree about
	/// which documents can be read.
	var CAP_OFFICE = 20 * 1024 * 1024;
	/// One page of the hex dump. Nothing more than this is ever held.
	var PAGE      = 4096;
	/// Rows of a table, and nodes of a JSON tree, before it is cut and said.
	var MAX_ROWS  = 1000;
	var MAX_COLS  = 200;
	var MAX_NODES = 4000;

	// ── What handles what ────────────────────────────────────────────

	/// Format (the `media` variant name from `oxedyne_fe2o3_stds::media`) to the
	/// handler that draws it. Public so a test can see what is covered without
	/// rendering anything.
	///
	/// `'*'` is the floor: any format with no entry here, and any format whose
	/// entry is text-shaped when the bytes turn out not to BE text, lands on the
	/// hex dump. `'text'` means the Doc panel's own rendering, which has line
	/// numbers and an editor and is not this file's business.
	var KIND_HANDLERS = {
		// 1 — the browser decodes it.
		Png: 'image',	Jpeg: 'image',	Gif: 'image',	Webp: 'image',
		Avif: 'image',	Heic: 'image',	Bmp: 'image',	Ico: 'image',
		Tiff: 'image',	Svg: 'image',
		Mp3: 'audio',	Wav: 'audio',	Flac: 'audio',	Ogg: 'audio',
		M4a: 'audio',
		Mp4: 'video',	Webm: 'video',	Matroska: 'video',	Avi: 'video',
		QuickTime: 'video',
		Pdf: 'doc',	Html: 'frame',
		// 1b — the browser cannot decode it and we can. A Word document is a ZIP
		// of XML, and `Media` has named it `Docx` correctly all along while this
		// table had no entry for it -- so somebody's CV opened as a PAGED HEX
		// DUMP under a header saying "Word document". That was a defect and not a
		// missing feature, which is why it is fixed ahead of the rest.
		//
		// `Xlsx` and `Pptx` are deliberately NOT here yet. A handler that opened
		// and then apologised would be worse than the dump, which at least lets a
		// person see the bytes; they arrive when they can be read.
		Docx: 'office',
		// A spreadsheet, once it could genuinely be read. It was deliberately
		// absent while it could not: a handler that opens and then apologises is
		// worse than the dump, which at least lets a person see the bytes and
		// know that nothing was interpreted for them.
		Xlsx: 'sheet',
		// The OpenDocument pair, which reach the SAME two tiers: what a reader
		// wants out of a text document is the same thing whichever vocabulary it
		// was written in, and that is the whole point of the neutral models
		// underneath. `Media` tells them apart from their own opening bytes, so a
		// file somebody renamed still lands on the right one.
		//
		// `Odp` and `Pptx` are deliberately absent. Both can be READ, but a deck
		// wants a tier that draws slides rather than paragraphs, and that tier
		// needs wording no translation file has yet. A handler that opened and
		// then apologised would be worse than the dump.
		Odt: 'office',	Ods: 'sheet',
		// 2 — text-shaped structure.
		Json: 'json',	Csv: 'table',	Tsv: 'table',	Markdown: 'markdown',
		Text: 'text',
		// 3 — the honest floor.
		Unknown: 'hex',
		'*': 'hex',
	};

	/// The handlers that decode bytes as characters, and so may only run when the
	/// probe says the bytes ARE characters.
	var TEXTY = { text: 1, json: 1, table: 1, markdown: 1 };

	/// Whether a tier needs the WHOLE file in memory before it can draw anything,
	/// which is what `CAP_WHOLE` is a ceiling on.
	///
	/// Asked in two places -- by `draw`, which acts on it, and by `verdict`, which
	/// tells the model what will happen -- so it is written once. The two saying
	/// different things would have the model promise a video over a hex dump.
	function wholeFile(h) {
		return h === 'image' || h === 'audio' || h === 'video' || h === 'frame'
			|| h === 'doc' || h === 'office' || h === 'sheet';
	}

	/// Which handler `info` resolves to.
	///
	/// The order matters and it is the whole guard against the original bug: a
	/// `.log` full of NULs is `Media::Text` by name and is not text, and routing
	/// it to a text handler on the strength of its name is exactly how a screen
	/// of U+FFFD happened in the first place. `info.text` is the probe's answer
	/// to "and are the bytes actually characters", and it overrules the table.
	function handlerFor(info) {
		var h = KIND_HANDLERS[info && info.media];
		if (!h) h = info && info.text ? 'text' : KIND_HANDLERS['*'];
		if (TEXTY[h] && !(info && info.text)) h = KIND_HANDLERS['*'];
		return h;
	}

	/// Whether a panel should hand these bytes to an EDITOR rather than draw them.
	///
	/// `text`, NOT `chars`, AND THE DIFFERENCE IS A SHIPPED BUG. `chars` is a fact
	/// about 512 bytes -- "these decode as characters" -- while `text` is that AND
	/// "the format is a text one". The Doc panel asked `chars`, so a PDF that
	/// carries no binary comment after `%PDF-` and no compressed stream in its
	/// first half-kilobyte answered yes: 19 of the 1044 PDFs on the author's own
	/// disk do, and clicking one filled the panel with `%PDF-1.4`, then
	/// `1 0 obj<</Type/Catalog…`, numbered, in a <pre>. That is precisely the
	/// salad this file exists to prevent, arriving through the door beside the one
	/// that was closed.
	///
	/// The reason given for the wider question was that `Makefile` has no
	/// extension, so its format would be Unknown and `text` false. It is not:
	/// `Media::sniff` falls back to `Media::Text` for any run of characters it
	/// recognises nothing else in, so `Makefile`, `LICENSE` and `README` all come
	/// back `Media::Text` with `text` true (measured, not assumed). `chars` was
	/// guarding a case that does not exist, and the guard is what let the PDF
	/// through. If that fallback ever changes, the no-extension check in
	/// `dev/verify_fileview.mjs` goes red, which is where the guard belongs.
	///
	/// # Arguments
	/// * `info` - What `probe` returned, or null when the probe could not answer.
	function editable(info) {
		if (!info || !info.text) return false;
		// A DRAWING IS NOT SOURCE, even though it is written in characters.
		//
		// `Media::Svg.is_text()` is true -- it is XML -- so an SVG satisfies
		// `text` and would go to the editor, where it appears as a screenful of
		// angle brackets. Its `kind()` is `Image` and `KIND_HANDLERS` has said
		// `Svg: 'image'` all along, so the viewer has always known how to draw
		// one; the panel simply could not reach it.
		//
		// This is the same over-reach as the bug above, pointed the other way.
		// Routing on `chars` sent PDFs to the editor because their first bytes
		// looked like characters; routing on `text` alone sends drawings there
		// because their whole FORMAT is characters. The question worth asking is
		// what the thing IS, and a picture is a picture.
		//
		// Deliberately narrow: only `Image`. HTML is text whose kind is a
		// document and a person may genuinely want either the source or the
		// page, so it stays in the editor until there is a control to choose --
		// guessing wrong there takes away the only way to fix a broken page.
		if (info.kind === 'Image') return false;
		return true;
	}

	// ── Small helpers ────────────────────────────────────────────────

	/// The app's string for `key`, or `english` where there is no table yet.
	///
	/// The bound function is called `tOr` everywhere below, and the name is not a
	/// preference: `dev/i18nfallback.mjs` finds fallbacks by looking for `tOr(`,
	/// `tf(` and `tr(`, so a helper called anything else keeps its English out of
	/// that check and free to drift from the catalogue. Every `fileview.*` string
	/// is in `i18n/en.js`; the second argument is what shows while the tables are
	/// still loading, and it must stay byte for byte the catalogue's own.
	function tOrOf(opts) {
		var fn = opts && opts.t;
		return function (key, english, vars) {
			if (typeof fn !== 'function') return fill(english, vars);
			var s = fn(key, vars);
			// `DaimondI18n.t` answers with the key itself when nothing has the
			// string, which is a debugging aid and not something to show a user.
			return (s == null || s === key) ? fill(english, vars) : s;
		};
	}

	/// Fill `{name}` placeholders, the way `DaimondI18n` does.
	function fill(s, vars) {
		return String(s == null ? '' : s).replace(/\{(\w+)\}/g, function (whole, k) {
			return (vars && vars[k] != null) ? String(vars[k]) : whole;
		});
	}

	/// A byte count as the file browser writes it.
	function fmtBytes(n) {
		if (!n) return '0 B';
		var u = ['B', 'KB', 'MB', 'GB'], i = 0;
		while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
		return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
	}

	/// An exact count, grouped, for the places where the exact number is the
	/// point -- a hex offset is not "12 KB".
	function fmtExact(n) {
		try { return Number(n).toLocaleString(); } catch (e) { return String(n); }
	}

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	// ── Object URLs, every one of which is revoked ───────────────────
	//
	// A long session opening thirty files leaks thirty of these otherwise, and
	// each one pins its whole blob. `close()` lets go of all of them, and `show`
	// calls `close` before it draws, so replacing the open file releases the one
	// that was there.

	var urls = [];

	function mint(blob) {
		var u = URL.createObjectURL(blob);
		urls.push(u);
		return u;
	}

	// ── Reading ──────────────────────────────────────────────────────

	/// `len` bytes of `path` from `offset`, through whichever root `opts.store`
	/// names. The wasm copies into a fresh JS array rather than handing back a
	/// view onto its own linear memory, so what comes back is safe to hold
	/// across an await -- which a view is not, and that cost five sessions once.
	async function readBytes(path, offset, len, opts) {
		var m = await mod(opts);
		var fn = (opts && opts.store) ? m.store_read_bytes : m.read_bytes;
		return await fn(path, offset, len);
	}

	/// The whole of a file as a `Blob` of `mime`, assembled a chunk at a time.
	///
	/// Each chunk becomes its own small `Blob` immediately and the array holding
	/// it is dropped, so the browser's blob store -- which may spill to disk --
	/// carries the file and the JS heap never holds more than one chunk. Building
	/// an array of `Uint8Array` and handing that to `new Blob` would hold the
	/// whole file in the heap, which is the thing being avoided.
	async function wholeBlob(path, size, mime, opts) {
		var parts = [], off = 0;
		while (off < size) {
			var n = Math.min(CHUNK, size - off);
			var u8 = await readBytes(path, off, n, opts);
			if (!u8.length) break;              // the file shrank under us; stop rather than spin
			parts.push(new Blob([u8]));
			off += u8.length;
		}
		return new Blob(parts, { type: mime });
	}

	/// The first `CAP_TEXT` bytes of a file, decoded. Returns `{ text, capped }`.
	async function headText(path, size, opts) {
		var want = Math.min(size, CAP_TEXT);
		var u8 = await readBytes(path, 0, want, opts);
		// Not `fatal`: this is only reached when the probe already said the bytes
		// are characters, and a cut multi-byte character at the cap must not turn
		// a two-megabyte read into an error.
		var text = new TextDecoder('utf-8').decode(u8);
		return { text: text, capped: size > want };
	}

	// ── The public entry points ──────────────────────────────────────

	/// What `path` is, without reading much of it.
	///
	/// The answer is the probe's own JSON -- `{size, media, kind, mime, label,
	/// text, byMagic, byName, disagree}` -- with one field added: `handler`, the
	/// name of the tier that will draw it. A caller routes on `handler`, and in
	/// particular keeps its own rendering when it is `'text'`.
	///
	/// # Arguments
	/// * `path` - The path, relative to whichever root `opts.store` names.
	/// * `opts` - `{ store, wasm }`.
	async function probe(path, opts) {
		var m = await mod(opts);
		var fn = (opts && opts.store) ? m.store_file_probe : m.file_probe;
		var info = JSON.parse(await fn(path));
		info.handler = handlerFor(info);
		return info;
	}

	/// What showing `path` would put on screen, said without drawing any of it.
	///
	/// ONE ANSWER to "what will the user see", read by the panel's own routing and
	/// by the daimon's `file_show` alike. A second table in Rust naming which
	/// formats have a viewer would be a second answer, free to drift from this
	/// file the first time a format changes tier -- and what drifts is a promise
	/// made to a user by a model that cannot check it.
	///
	/// `tier` is one of the handler names above, with three answers they do not
	/// carry:
	///
	///   * `editor` where the Doc panel keeps its own text view -- source, a
	///     `Makefile`, `DAIMOND.md` -- because that is the panel's routing and not
	///     this file's, and the model is being told what the PANEL will do;
	///   * `hex` for a file too big for the tier it belongs to, since a prefix of
	///     an MP4 is not a shorter video;
	///   * `empty` for a file of no bytes, which draws a sentence and nothing else.
	///
	/// # Arguments
	/// * `path` - The path, relative to whichever root `opts.store` names.
	/// * `opts` - `{ store, wasm }`.
	async function verdict(path, opts) {
		var info = await probe(path, opts);
		var tier = editable(info) ? 'editor' : info.handler;
		if (wholeFile(tier) && info.size > CAP_WHOLE) tier = 'hex';
		if (!info.size) tier = 'empty';
		return {
			path:     path,
			tier:     tier,
			media:    info.media,
			// The LABEL, in the library's English. The variant name is an
			// identifier and a sentence built from it reads "a Pdf".
			label:    info.label,
			size:     info.size,
			cap:      CAP_WHOLE,
			disagree: !!info.disagree,
			named:    info.byNameLabel || '',
			found:    info.byMagicLabel || '',
		};
	}

	// ── Where a document opens ───────────────────────────────────────
	//
	// MEASURED, headless Chromium 1229, on a three-page PDF whose pages carry
	// different amounts of ink, read back off the screen rather than off the DOM:
	//
	//   * `#page=N` on a `blob:` URL DOES reach the browser's PDF viewer through
	//     an `<embed>` -- pages 1, 2 and 3 came up 4.8%, 29.4% and 55.9% dark.
	//     `#zoom=scale,left,top` (in-page scroll) and `#view=FitH` move it too.
	//   * Changing ONLY the fragment on a live `<embed>` moves nothing. A fresh
	//     object URL is what makes the viewer read the fragment again -- which a
	//     redraw mints anyway.
	//   * NOTHING READS THE POSITION BACK. `contentWindow` and `contentDocument`
	//     are both `undefined` (the viewer is out of process), scrolling produces
	//     no message, and none of `getViewport`, `viewport`, `documentDimensions`
	//     or `getSelectedText` posted to the element is answered. The only thing
	//     it ever says is `{type:'documentLoaded'}`, from the PDF extension's
	//     origin, once.
	//
	// So a document can be REOPENED where it was last AIMED, and cannot be
	// reopened where the reader had scrolled to. That asymmetry is worth knowing
	// before anything is built on top of this: a rebuilt PDF put back on screen
	// lands wherever we last said, and page 1 is where we say by default.
	//
	// Kept out of `last` deliberately: `show` calls `close` before it draws, and
	// a caller aims at a file and THEN opens it, so an aim cleared by `close`
	// would be cleared between being set and being used.
	var aim = null;		// { path, page }

	/// Open `path` at `page` the next time it is drawn.
	///
	/// A page of 0 or nothing does NOT mean the top: it means "wherever this file
	/// was last aimed", which for a file nobody has aimed is the top. That is the
	/// difference between showing a rebuilt document and losing the reader's place
	/// in it -- redraw it with no page and it comes back where it was put, rather
	/// than at page 1. It is the most that is available, since nothing can read
	/// where the reader had actually scrolled to (see above).
	///
	/// # Arguments
	/// * `path` - The file the aim belongs to; an aim for one file never moves another.
	/// * `page` - 1-based page number, or nothing to keep this file's own aim.
	function at(path, page) {
		var n = Math.floor(Number(page) || 0);
		if (n > 0) { aim = { path: path, page: n }; return; }
		if (!aim || aim.path !== path) aim = null;
	}

	/// Which page `path` will open at, or 0 for the top.
	function aimPage(path) {
		return (aim && aim.path === path && aim.page > 0) ? aim.page : 0;
	}

	/// The URL fragment that carries the aim for `path`, or the empty string.
	function aimFrag(path) {
		var n = aimPage(path);
		return n ? '#page=' + n : '';
	}

	// The view currently on screen, so a change of language can redraw it. An
	// app that is translated everywhere except the panel you are looking at is
	// a bug class this project has had before.
	var last  = null;
	var epoch = 0;		// bumped by every show and close, so a slow read cannot land late

	/// Draw `path` into `el`, replacing whatever was there.
	///
	/// # Arguments
	/// * `host` - The element to fill. It is emptied first.
	/// * `path` - The path that was probed.
	/// * `info` - What `probe` returned.
	/// * `opts` - `{ store, t, onError, wasm }`.
	async function show(host, path, info, opts) {
		// Where the hex dump had got to, if this is the same file being redrawn
		// in another language. Read before `close`, which forgets it.
		var resume = (last && last.host === host && last.path === path) ? last.hexAt : 0;
		close();
		if (!host) return;
		var mine = ++epoch;
		var tOr = tOrOf(opts);
		var handler = (info && info.handler) || handlerFor(info);
		last = { host: host, path: path, info: info, opts: opts, hexAt: resume };

		var root = el('div', 'fileview');
		root.setAttribute('data-viewer', handler);
		root.appendChild(meta(info, tOr));
		if (info && info.disagree) root.appendChild(disagreeLine(info, tOr));
		var body = el('div', 'fv-body');
		root.appendChild(body);
		host.textContent = '';
		host.appendChild(root);

		try {
			await draw(handler, body, path, info, opts, tOr, mine, resume);
		} catch (e) {
			if (mine !== epoch) return;
			body.textContent = '';
			body.appendChild(el('p', 'fv-warn',
				tOr('fileview.read_failed', 'This file could not be read: {reason}',
					{ reason: (e && e.message) ? e.message : String(e) })));
			if (opts && typeof opts.onError === 'function') opts.onError(e);
		}
	}

	/// Let go of everything the viewer is holding: every object URL it minted,
	/// and the view it would otherwise redraw on a change of language.
	function close() {
		epoch++;
		for (var i = 0; i < urls.length; i++) {
			try { URL.revokeObjectURL(urls[i]); } catch (e) { /* already gone */ }
		}
		urls = [];
		last = null;
	}

	// ── The header every tier carries ────────────────────────────────

	/// The format and the size, in one quiet line.
	///
	/// The format name is looked up per variant with the library's own English
	/// as the fallback, so a translation can name a PDF in the reader's language
	/// without this file holding a table of format names in any language.
	function meta(info, tOr) {
		var row = el('div', 'fv-meta');
		row.appendChild(el('span', 'fv-fmt', fmtName(info && info.media, info && info.label, tOr)));
		row.appendChild(el('span', 'fv-size', fmtBytes((info && info.size) || 0)));
		return row;
	}

	function fmtName(media, label, tOr) {
		var v = media || 'Unknown';
		return tOr('fileview.fmt.' + v, label || v);
	}

	/// One line, when the name and the bytes do not agree.
	///
	/// `identify` acts on the bytes, so the format shown is always what the bytes
	/// said; the line says both and says which won, because a person looking at a
	/// broken export needs to know the claim as well as the evidence.
	function disagreeLine(info, tOr) {
		return el('p', 'fv-warn fv-disagree',
			tOr('fileview.disagree',
				'The name says {named}. The bytes say {found}, and the bytes are what is shown.',
				{
					// The LABEL, not the variant name. `byName`/`byMagic` are
					// identifiers -- `Pdf`, `Text` -- and a sentence built from them
					// read "The bytes say Pdf", which is the code's word for the
					// format arriving on screen in front of a person who is already
					// looking at something that went wrong.
					named: fmtName(info.byName, info.byNameLabel, tOr),
					found: fmtName(info.byMagic, info.byMagicLabel, tOr),
				}));
	}

	// ── The tiers ────────────────────────────────────────────────────

	/// Draw one tier into `body`. `mine` is the epoch this draw belongs to; every
	/// await is followed by a check of it, so a file opened while another was
	/// still reading cannot paint over the newer one.
	async function draw(handler, body, path, info, opts, tOr, mine, resume) {
		var size = (info && info.size) || 0;
		if (!size) {
			body.appendChild(el('p', 'fv-note', tOr('fileview.empty', 'This file is empty.')));
			return;
		}

		// Tier 1 wants the whole file, so it is the one with a hard ceiling. Over
		// it the file is NAMED and its bytes are dumped: a prefix of a container
		// format is not a smaller file, it is a corrupt one, and handing it to a
		// decoder produces exactly the "this app is broken" impression this whole
		// file exists to remove.
		if (wholeFile(handler) && size > CAP_WHOLE) {
			body.appendChild(el('p', 'fv-note', tOr('fileview.too_large',
				'A {fmt} of {size} is too large to hold in memory here. Its bytes follow; '
				+ 'download it to open it elsewhere.',
				{ fmt: fmtName(info.media, info.label, tOr), size: fmtBytes(size) })));
			await hex(body, path, info, opts, tOr, mine, resume);
			return;
		}

		switch (handler) {
			case 'image':	return await media(body, 'img',   path, info, opts, tOr, mine);
			case 'audio':	return await media(body, 'audio', path, info, opts, tOr, mine);
			case 'video':	return await media(body, 'video', path, info, opts, tOr, mine);
			case 'frame':	return await frame(body, path, info, opts, tOr, mine);
			case 'doc':	return await doc(body, path, info, opts, tOr, mine);
			case 'json':	return await json(body, path, info, opts, tOr, mine);
			case 'table':	return await table(body, path, info, opts, tOr, mine);
			case 'markdown':	return await markdown(body, path, info, opts, tOr, mine);
			case 'office':	return await office(body, path, info, opts, tOr, mine, resume);
			case 'sheet':	return await sheet(body, path, info, opts, tOr, mine, resume);
			case 'text':	return await plain(body, path, info, opts, tOr, mine);
			default:	return await hex(body, path, info, opts, tOr, mine, resume);
		}
	}

	/// A picture, a sound or a moving picture, on a `Blob` carrying the probe's
	/// media type. The type is not decoration: a `Blob` typed
	/// `application/octet-stream` is a picture that does not appear.
	async function media(body, tag, path, info, opts, tOr, mine) {
		var blob = await wholeBlob(path, info.size, info.mime, opts);
		if (mine !== epoch) return;
		var n = el(tag, 'fv-' + tag);
		if (tag === 'img') {
			n.alt = path;
		} else {
			n.controls = true;
			n.preload = 'metadata';
		}
		// A decoder that cannot read the bytes says so, rather than leaving a
		// broken-image glyph and no explanation. AVIF, HEIC and Matroska are all
		// formats a given browser may simply not carry.
		n.addEventListener('error', function () {
			if (n.parentNode) n.parentNode.replaceChild(el('p', 'fv-warn',
				tOr('fileview.decode_failed', 'This browser could not decode this {fmt}.',
					{ fmt: fmtName(info.media, info.label, tOr) })), n);
		});
		n.src = mint(blob);
		body.appendChild(n);
	}

	/// A PDF, handed to the browser's own document viewer.
	///
	/// WHY THIS IS NOT THE SANDBOXED FRAME BELOW, WHICH IS WHERE IT USED TO GO.
	/// A `sandbox` attribute of ANY value stops Chrome instantiating its PDF
	/// viewer -- the viewer is an internal resource and a sandboxed frame may not
	/// reach it -- so every PDF ever opened here drew a grey box with a
	/// broken-page glyph in it. `allow-scripts allow-same-origin` does not help
	/// either; it is the attribute's presence, not its value. Measured in
	/// Chromium 150: sandboxed frame, broken glyph; `<embed>`, `<object>` and a
	/// plain frame, the document. The panel said "PDF document, 966.3 KB" over
	/// the top of it, which is how the state passed for working.
	///
	/// AND THE SECURITY ARGUMENT THE SANDBOX WAS MAKING STILL HOLDS -- it is just
	/// not this element that has to make it. A `blob:` URL inherits our origin,
	/// so an unsandboxed frame over a file an agent wrote runs as the app and
	/// reaches `localStorage`, where the API key is. What closes that here is the
	/// BLOB'S TYPE: `application/pdf` sends Chrome to the PDF viewer and it never
	/// parses the bytes as a document. Measured, with a file of HTML carrying a
	/// script that writes to `parent`: typed `application/pdf` it did not run, in
	/// `<embed>`, in `<object>` and in a bare frame alike; typed `text/html` it
	/// ran in every one of them. The type is not ours to be wrong about, either
	/// -- it comes from `identify`, which reads the leading bytes, so a `.pdf`
	/// full of HTML is `Media::Html` and goes to the sandboxed frame below.
	///
	/// `<embed>` rather than a bare frame because it takes the type EXPLICITLY,
	/// which is what keeps the browser off its own sniffing, and because it has
	/// no navigable document for anything to reach through.
	///
	/// The fragment is the one thing this element takes instruction from -- see
	/// the note on `aim` above for what was measured about it, and for the half
	/// that does not work.
	async function doc(body, path, info, opts, tOr, mine) {
		var blob = await wholeBlob(path, info.size, info.mime, opts);
		if (mine !== epoch) return;
		var e = el('embed', 'fv-doc');
		e.setAttribute('type', info.mime || 'application/pdf');
		e.setAttribute('title', tOr('fileview.frame_title', 'The contents of {name}',
			{ name: path.split('/').pop() || path }));
		e.src = mint(blob) + aimFrag(path);
		body.appendChild(e);
	}

	/// An HTML page, in a frame that runs in an opaque origin.
	///
	/// `allow-scripts` AND NOTHING ELSE. Not `allow-same-origin`, which would
	/// hand the framed file our origin and with it `localStorage` and OPFS; not
	/// `allow-forms`, `allow-popups`, `allow-modals` or `allow-top-navigation`.
	/// The one flag is there so a page's own scripting works while it stays in an
	/// origin of its own.
	async function frame(body, path, info, opts, tOr, mine) {
		var blob = await wholeBlob(path, info.size, info.mime, opts);
		if (mine !== epoch) return;
		var f = el('iframe', 'fv-frame');
		f.setAttribute('sandbox', 'allow-scripts');
		f.setAttribute('referrerpolicy', 'no-referrer');
		f.setAttribute('title', tOr('fileview.frame_title', 'The contents of {name}',
			{ name: path.split('/').pop() || path }));
		f.src = mint(blob);
		body.appendChild(f);
	}

	/// Text with no structure this file claims to understand.
	///
	/// The Doc panel keeps its own text rendering -- the line-number gutter, the
	/// editor, the conflict check -- and a caller routes on `info.handler ===
	/// 'text'` before it ever calls `show`. This is the fallback for a caller
	/// that did not, and it is deliberately plain: something honest on screen
	/// beats a blank panel, but nothing here should tempt anybody to move the
	/// editor into it.
	async function plain(body, path, info, opts, tOr, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, tOr));
		body.appendChild(el('pre', 'fv-plain', got.text));
	}

	/// Markdown through the renderer the chat already uses.
	///
	/// `DaimondRender.md` sanitises, and it drops `script style iframe form input
	/// button svg` whole. That is correct and is not loosened here: the file being
	/// rendered may have been written by an agent, and this panel is inside our
	/// origin.
	/// AND IT IS WHERE MARKDOWN BECOMES A REAL DOCUMENT. `office_write` turns this
	/// text into the bytes of a `.docx` or a `.odt`, which is the one thing a
	/// person cannot do for themselves and the app could already do for them: the
	/// writer had no caller in `www/js/` at all, so the capability existed and
	/// nobody could ask for it.
	///
	/// The model does not emit document XML and there is no tool that lets it. It
	/// writes Markdown, which it does well, and the conversion from there is
	/// deterministic code -- which removes the failure class rather than mitigating
	/// it. The same is true of a person: this is the door for both.
	async function markdown(body, path, info, opts, tOr, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		var m = await mod(opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, tOr));
		// A CAPPED READ IS NOT WRITTEN OUT. The first two megabytes of a file are
		// readable text and are NOT a shorter document: what would land in
		// somebody's downloads is a document missing its end, with nothing about it
		// to say so. So the controls are absent and the reason is said.
		if (got.capped) {
			body.appendChild(el('p', 'fv-note', tOr('fileview.save_capped',
				'Only the start of this file is on screen, so it is not written out as a '
				+ 'document: what came back would be a document missing its end.')));
		} else {
			saveAsRow(body, m, got.text, path, tOr);
		}
		// `md-body` is render.css's own hook for a block of rendered markdown; it
		// carries the link colours, so a document's links look like the app's.
		var box = el('div', 'fv-md md-body');
		if (window.DaimondRender && DaimondRender.md) box.innerHTML = DaimondRender.md(got.text);
		else box.appendChild(el('pre', 'fv-plain', got.text));
		body.appendChild(box);
	}

	/// One button per format Markdown may be written out as.
	///
	/// It SAYS WHAT THE DOCUMENT DOES NOT CARRY, beside the file it just handed
	/// over. `office_write_left` is asked before the write and the answer is shown
	/// after it, which is a deliberate order and not the one this comment first
	/// claimed: it said "before it writes one", and the code has always written the
	/// file and then said. A picture referenced by a Markdown file does not travel
	/// into the document, and the person asked for a document, so they get one and
	/// are told what is missing from it -- rather than being stopped by a question
	/// about a picture they may not care about. If that trade is ever reconsidered,
	/// the note moves above the `handOver` and this paragraph changes with it.
	function saveAsRow(body, m, md, path, tOr) {
		var row = el('div', 'fv-bar');
		var say = el('p', 'fv-warn');
		say.hidden = true;

		// ONE CONTROL AND A LIST, not one button per format. Six buttons is about
		// 1400px of chrome standing above a document that is 380px wide on a phone,
		// and it would have wanted six labels in eight languages. A picker wants
		// none: every option is named through `fileview.fmt.<variant>`, the open
		// family the panel's header already reads, so a locale that has translated
		// "Word document" once has translated it here too.
		var pick = el('select');
		pick.setAttribute('data-media-pick', '1');
		var drew = 0;
		for (var i = 0; i < WRITE_AS.length; i++) {
			var as = WRITE_AS[i];
			if (!canWrite(m, as.media)) continue;
			drew++;
			var o = el('option', null, tOr('fileview.fmt.' + as.media, as.en));
			o.value = as.media;
			pick.appendChild(o);
		}
		// Nothing to offer: no picker, no button, no apology. A build whose writer
		// is absent says nothing rather than drawing a control that cannot work.
		if (!drew) return;

		var save = el('button', 'fv-btn fv-save', tOr('fileview.save_as', 'Save as a document'));
		save.type = 'button';
		save.title = tOr('fileview.save_as_help',
			'Write this text out as a real document and save it to your own device. '
			+ 'The file here is not changed.');
		save.addEventListener('click', function () {
			var media = pick.value;
			var as = null;
			for (var j = 0; j < WRITE_AS.length; j++) {
				if (WRITE_AS[j].media === media) { as = WRITE_AS[j]; break; }
			}
			if (!as) return;
			// Asked BEFORE the write, answered AFTER it. See the note on `markdown`
			// above for why that order is deliberate.
			var left = leftLine(m, md, as.media, tOr);
			try {
				var out = writeAs(m, md, as.media);
				if (!out || !out.length) {
					throw new Error(tOr('fileview.edit_nothing',
						'the editor returned no document'));
				}
				// `application/octet-stream`, and the SUFFIX is what names it. A type
				// per format would be a second table of media types to keep in step
				// with `Media`, and the download's name is what the operating system
				// opens a document by anyway.
				handOver(out, 'application/octet-stream', stemOf(baseName(path)) + as.ext);
				say.className = 'fv-note';
				say.textContent = left;
				say.hidden = !left;
			} catch (e) {
				// A FORMAT THAT REFUSED IS NAMED. `office_write` takes six and a
				// person may pick one whose writer objects to this particular prose --
				// a spreadsheet out of text holding no table, say. "This could not be
				// saved" alone would leave them pressing the same button again.
				say.className = 'fv-warn';
				say.textContent = tOr('fileview.save_as_failed',
					'This could not be saved as {fmt}: {why}',
					{ fmt: tOr('fileview.fmt.' + as.media, as.en),
					  why: (e && e.message) ? e.message : String(e) });
				say.hidden = false;
			}
		});

		// The button carries the words and the picker carries the same words as its
		// accessible name, rather than a visible label repeating the button beside
		// it. One phrase, one key, and nothing on screen said twice.
		pick.setAttribute('aria-label', tOr('fileview.save_as', 'Save as a document'));
		row.appendChild(pick);
		row.appendChild(save);
		body.appendChild(row);
		body.appendChild(say);
	}

	/// The whole of a file as one `Uint8Array`, assembled a chunk at a time.
	///
	/// Unlike `wholeBlob`, this has to end up contiguous, because what it feeds
	/// is a wasm function that takes a slice. It is therefore only ever used
	/// where a hard ceiling is already in force -- see `CAP_OFFICE`.
	async function wholeBytes(path, size, opts) {
		var out = new Uint8Array(size), off = 0;
		while (off < size) {
			var u8 = await readBytes(path, off, Math.min(CHUNK, size - off), opts);
			if (!u8.length) break;              // the file shrank under us; stop rather than spin
			out.set(u8, off);
			off += u8.length;
		}
		return off === size ? out : out.subarray(0, off);
	}

	/// What a reading view did not draw, as a sentence in the reader's language.
	///
	/// The wasm hands over a kind and a count for each -- `[{kind:'chart',n:1}]` --
	/// and never a finished phrase, because a phrase built in Rust is English a
	/// translation pass cannot reach, and this file holds none of that.
	///
	/// The number and the kind are BOTH the information. "4 things are not drawn:
	/// 3 text boxes, 1 chart" tells a reader whether to go and open the file
	/// properly; "some content is not shown" tells them only that this viewer
	/// cannot be trusted.
	function undrawnLine(undrawn, tOr) {
		if (!undrawn || !undrawn.length) return '';
		var total = 0, parts = [];
		for (var i = 0; i < undrawn.length; i++) {
			var it = undrawn[i];
			total += it.n;
			// One key per kind, and the count is the key's own argument, so a
			// language that pluralises differently does it in the translation file
			// rather than here.
			parts.push(tOr('fileview.undrawn_' + it.kind, DEFAULT_UNDRAWN[it.kind]
				|| '{n} of something', { n: it.n }));
		}
		return tOr('fileview.office_undrawn',
			'{total} things are not drawn: {parts}.',
			{ total: total, parts: parts.join(', ') });
	}

	/// What a document written from this Markdown will NOT carry, as a sentence in
	/// the reader's language, or '' when it carries everything.
	///
	/// THE SAME ARRANGEMENT AS `undrawnLine`, AND THAT IS THE POINT. It used to be
	/// a finished English sentence built in Rust and printed verbatim -- the one
	/// piece of English in this panel a translation pass could not reach, in a file
	/// whose own header says it holds none. `office_write_left` now hands back
	/// `[{kind, n, names}]` and the wording is composed here, per locale, exactly
	/// as the reading view's does.
	///
	/// `names` is the one thing `undrawn` has no equivalent for: a document being
	/// READ has no source names for what it could not draw, and Markdown does --
	/// they are paths the author wrote. So an image can be named rather than
	/// counted, which is the difference between "1 image is not carried" and
	/// knowing it was the one picture that mattered.
	///
	/// `media` matters because the answer differs by format: a spreadsheet written
	/// from prose has nothing to say, and a deck can leave speaker's notes behind,
	/// which the old English never mentioned at all.
	function leftLine(m, md, media, tOr) {
		if (typeof m.office_write_left !== 'function') return '';
		var left = null;
		try {
			left = m.office_write_left(md, media);
		} catch (e) {
			// A writer that cannot say what it would leave out is not a reason to
			// refuse the write; it is a reason to say nothing about the loss.
			return '';
		}
		if (!left || !left.length) return '';
		var parts = [];
		for (var i = 0; i < left.length; i++) {
			var it = left[i] || {};
			var names = (it.names && it.names.length) ? it.names.join(', ') : '';
			parts.push(names
				? tOr('fileview.left_' + it.kind + '_named',
					DEFAULT_LEFT_NAMED[it.kind] || '{n} of something: {names}',
					{ n: it.n, names: names })
				: tOr('fileview.left_' + it.kind, DEFAULT_LEFT[it.kind]
					|| '{n} of something', { n: it.n }));
		}
		return tOr('fileview.write_left',
			'Not everything in this text reaches the document: {parts}.',
			{ parts: parts.join(', ') });
	}

	/// The English each kind of loss falls back to. Two forms per kind, because a
	/// count with the sources named is a different sentence from a bare count and
	/// not the same one with a list bolted on.
	var DEFAULT_LEFT = {
		image:	'{n} image(s)',
		notes:	'{n} slide(s) of speaker\u2019s notes',
	};
	var DEFAULT_LEFT_NAMED = {
		image:	'{n} image(s): {names}',
		notes:	'{n} slide(s) of speaker\u2019s notes: {names}',
	};

	/// The English each kind falls back to, which is what ships until the
	/// translation files carry the keys above.
	var DEFAULT_UNDRAWN = {
		image:	'{n} image(s)',
		chart:	'{n} chart(s)',
		diagram:	'{n} diagram(s)',
		textbox:	'{n} text box(es)',
		object:	'{n} embedded object(s)',
		equation:	'{n} equation(s)',
		footnote:	'{n} footnote(s)',
		endnote:	'{n} endnote(s)',
		comment:	'{n} comment(s)',
	};

	// ── Handing a document back to the user ─────────────────────────
	//
	// THE ROUTE IS THE APP'S OWN AND IS NOT INVENTED HERE. Every other place
	// Daimond gives somebody a file -- the preview panel's ⤓, the document
	// panel's, the chat backup -- builds one `Blob`, mints an object URL, clicks a
	// synthetic `<a download>` and revokes the URL straight after. This is the
	// same three lines, so there is one handover in the app to change rather than
	// two to keep in step.
	//
	// It deliberately does NOT go through `mint`. Those URLs are revoked by
	// `close`, and `show` calls `close` before it draws, so a download holding a
	// minted URL would be cancelled by the next file somebody opened -- silently,
	// with a file of zero bytes in their downloads folder.

	function baseName(path) { return String(path).split('/').pop() || 'file'; }

	/// A file name with its extension taken off.
	function stemOf(name) { return String(name).replace(/\.[^./]+$/, '') || String(name); }

	/// Give `bytes` to the user as a file called `name`.
	function handOver(bytes, mime, name) {
		var a = document.createElement('a');
		a.href = URL.createObjectURL(
			new Blob([bytes], { type: mime || 'application/octet-stream' }));
		a.download = name;
		a.rel = 'noopener';
		a.click();
		URL.revokeObjectURL(a.href);
	}

	/// Which formats may be edited, and which wasm door does it.
	///
	/// NEITHER PRESENTATION FORMAT IS HERE, and that is the contract's decision
	/// rather than an omission: a slide is a position on a canvas, so an edit that
	/// changes the words without knowing the geometry puts text over other text.
	/// Nothing below asks about `Pptx` or `Odp` by name -- absence from this table
	/// is the whole of how the control fails to appear.
	var EDIT_DOOR = {
		Docx:	'office_edit_doc',	Odt:	'office_edit_doc',
		Xlsx:	'office_edit_sheet',	Ods:	'office_edit_sheet',
	};

	/// The formats a Markdown file may be written out AS, and the library's own
	/// English for each.
	///
	/// This is where the writer in `src/wasm/office.rs` reaches a person. It had
	/// no caller in `www/js/` at all: the app could turn Markdown into a real
	/// document and nobody could ask it to.
	///
	/// ALL SIX, because the writer writes all six and a person who wants an `.odp`
	/// should not be told to go and convert one somewhere else. What each format
	/// makes of the same prose differs and the difference is not a loss: the text
	/// documents take the whole thing, the decks split it at its headings into
	/// slides, and the spreadsheets take its TABLES, one sheet each.
	///
	/// THE NAMES COME FROM THE `fileview.fmt.` FAMILY, which is the same open
	/// extension point the panel's own header reads and which needs no new key in
	/// any locale: a translation that wants to name a PowerPoint in the reader's
	/// language adds `fileview.fmt.Pptx` and it is picked up here too. The English
	/// beside each is `Media::label`'s own, copied from
	/// `fe2o3_stds::media` so the picker and the header say one thing.
	var WRITE_AS = [
		{ media: 'Docx',	ext: '.docx',	en: 'Word document' },
		{ media: 'Odt',	ext: '.odt',	en: 'OpenDocument text' },
		{ media: 'Xlsx',	ext: '.xlsx',	en: 'Excel spreadsheet' },
		{ media: 'Ods',	ext: '.ods',	en: 'OpenDocument spreadsheet' },
		{ media: 'Pptx',	ext: '.pptx',	en: 'PowerPoint presentation' },
		{ media: 'Odp',	ext: '.odp',	en: 'OpenDocument presentation' },
	];

	/// Write `md` out as the bytes of `media`, or nothing where this build cannot.
	///
	/// `office_write(md, media)` is the one door. `office_write_docx(md)` is the
	/// older single-format one and is still exported, so it stands in where the
	/// general one is not in the bundle yet -- a Word document being the case that
	/// existed before either name did.
	function writeAs(m, md, media) {
		if (typeof m.office_write === 'function') return m.office_write(md, media);
		if (media === 'Docx' && typeof m.office_write_docx === 'function') {
			return m.office_write_docx(md);
		}
		return null;
	}

	/// Whether this build can write `media` from Markdown at all.
	function canWrite(m, media) {
		return typeof m.office_write === 'function'
			|| (media === 'Docx' && typeof m.office_write_docx === 'function');
	}

	/// The controls a reader gets over the document in front of them, and the row
	/// of fields one of them opens. Answers the LAST node of the block, which is
	/// what a caller redrawing the content below it walks from.
	///
	/// `fv-save` hands over the bytes CURRENTLY HELD -- the file as it arrived, or
	/// the file with an edit spliced into it -- so "save a copy" means the same
	/// thing before and after an edit, and the copy is the only thing that ever
	/// changes. Nothing here writes to the workspace: the file a person is looking
	/// at is left exactly as it was, which is what makes the control safe to press
	/// without a question first.
	///
	/// `fv-edit` opens `fv-editrow`. Apply hands the whole archive to the wasm and
	/// takes a whole new archive back, because the edit is SURGICAL there: every
	/// part of the ZIP the editor does not understand is copied across byte for
	/// byte. Round-tripping the document through Markdown would be data loss with
	/// a friendly face, and this panel is usually looking at a stranger's file.
	function actions(body, m, st, path, info, tOr, onEdited) {
		var row  = el('div', 'fv-bar');
		var fields = el('div', 'fv-editrow');
		var say  = el('p', 'fv-warn');
		fields.hidden = true;
		say.hidden    = true;
		body.appendChild(row);
		body.appendChild(fields);
		body.appendChild(say);

		function tell(text, bad) {
			say.className = bad ? 'fv-warn' : 'fv-note';
			say.textContent = text;
			say.hidden = !text;
		}

		var save = el('button', 'fv-btn fv-save', tOr('fileview.save', 'Save a copy'));
		save.type = 'button';
		save.title = tOr('fileview.save_help',
			'Save a copy of this to your own device. The file here is not changed.');
		save.addEventListener('click', function () {
			try {
				handOver(st.bytes, info.mime, baseName(path));
				tell('');
			} catch (e) {
				tell(tOr('fileview.save_failed', 'This could not be saved: {why}',
					{ why: (e && e.message) ? e.message : String(e) }), true);
			}
		});
		row.appendChild(save);

		var door = EDIT_DOOR[st.media];
		// A control that throws when it is pressed is worse than no control, so the
		// Edit button exists only where the wasm door behind it does.
		if (!door || typeof m[door] !== 'function') return say;

		var edit = el('button', 'fv-btn fv-edit', tOr('fileview.edit', 'Make an edit'));
		edit.type = 'button';
		edit.setAttribute('aria-expanded', 'false');
		edit.addEventListener('click', function () {
			fields.hidden = !fields.hidden;
			edit.setAttribute('aria-expanded', fields.hidden ? 'false' : 'true');
			if (!fields.hidden) {
				var first = fields.querySelector('input, select');
				if (first) first.focus();
			}
		});
		row.appendChild(edit);

		/// One labelled field. The label is the accessible name as well, so nothing
		/// here needs an `aria-label` saying the same words twice.
		function field(key, english, kind, name) {
			var lab = el('label');
			lab.appendChild(el('span', null, tOr(key, english)));
			var input = el('input');
			input.type = kind;
			input.setAttribute('data-edit', name);
			if (kind === 'number') { input.min = '1'; input.step = '1'; }
			lab.appendChild(input);
			fields.appendChild(lab);
			return input;
		}

		var apply = el('button', 'fv-btn', tOr('fileview.edit_apply', 'Apply'));
		apply.type = 'button';
		apply.setAttribute('data-edit', 'apply');
		apply.disabled = true;

		var edits = null;		// answers the JSON the wasm takes, or '' when it cannot yet

		if (door === 'office_edit_doc') {
			var find = field('fileview.edit_find', 'Find', 'text', 'find');
			var repl = field('fileview.edit_replace', 'Replace with', 'text', 'replace');
			var nth  = field('fileview.edit_nth', 'Which one', 'number', 'nth');
			edits = function () {
				var f = find.value;
				if (!f) return '';
				var one = { find: f, replace: repl.value };
				// Absent means every occurrence, which is the format's own rule; a 0
				// or a blank box must therefore send no `nth` at all rather than one.
				var n = Math.floor(Number(nth.value) || 0);
				if (n > 0) one.nth = n;
				return JSON.stringify([one]);
			};
			find.addEventListener('input', function () { apply.disabled = !find.value; });
			fields.appendChild(apply);
			fields.appendChild(el('p', 'fv-note', tOr('fileview.edit_note',
				'Leave “{which}” blank to change every one. Everything else in the file is '
				+ 'left byte for byte as it was.',
				{ which: tOr('fileview.edit_nth', 'Which one') })));
		} else {
			var pick = el('select');
			pick.setAttribute('data-edit', 'sheet');
			for (var i = 0; i < (st.sheets || []).length; i++) {
				var o = el('option', null, st.sheets[i]);
				o.value = st.sheets[i];
				pick.appendChild(o);
			}
			var wrap = el('label');
			wrap.appendChild(el('span', null, tOr('fileview.edit_sheet', 'Sheet')));
			wrap.appendChild(pick);
			fields.appendChild(wrap);
			var ref = field('fileview.edit_cell', 'Cell', 'text', 'ref');
			var val = field('fileview.edit_value', 'Value', 'text', 'value');
			edits = function () {
				var r = ref.value.trim();
				if (!r) return '';
				var one = { sheet: pick.value, ref: r.toUpperCase() };
				// The convention every spreadsheet already taught this person: a
				// leading `=` is a formula and anything else is a value. It needs no
				// control of its own, and a control would be a second way to say the
				// same thing.
				if (/^=/.test(val.value)) one.formula = val.value;
				else one.value = val.value;
				return JSON.stringify([one]);
			};
			ref.addEventListener('input', function () { apply.disabled = !ref.value.trim(); });
			fields.appendChild(apply);
			fields.appendChild(el('p', 'fv-note', tOr('fileview.edit_cell_note',
				'A value beginning with “=” is stored as a formula. Nothing is '
				+ 'recalculated, here or in the file.')));
		}

		apply.addEventListener('click', async function () {
			var json = edits();
			if (!json) return;
			var out = null;
			try {
				// `await` on a value that is not a promise costs nothing, and it is
				// what keeps the EDITOR'S OWN REASON on screen either way. The exports
				// are synchronous today and throw; were one ever to reject instead, a
				// bare call would put a pending promise in `out` and the reader would
				// be told "the editor returned no document" in place of the sentence
				// naming the string that did not match. A user told the wrong reason
				// for a refusal is barely better than one told nothing.
				out = await m[door](st.bytes, st.media, json);
			} catch (e) {
				// An unmatched `find` is an error naming the string, not a silent
				// no-op, and the bytes are left alone: a failed edit that had already
				// replaced them would leave the reader looking at a document nobody
				// asked for.
				tell(tOr('fileview.edit_failed', 'That edit was not made: {why}',
					{ why: (e && e.message) ? e.message : String(e) }), true);
				return;
			}
			if (!out || !out.length) {
				tell(tOr('fileview.edit_failed', 'That edit was not made: {why}',
					{ why: tOr('fileview.edit_nothing', 'the editor returned no document') }), true);
				return;
			}
			st.bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
			st.edits++;
			tell('');
			onEdited();
		});
		return say;
	}

	/// The line that says the document on screen is not the document on disk.
	///
	/// Never omitted once an edit has been applied. The panel is showing prose
	/// nothing else in the app can see, and a reader who closed it thinking the
	/// file had changed would have lost the edit without being told.
	function editedLine(st, tOr) {
		return el('p', 'fv-warn', tOr('fileview.edited',
			'Edited here, {n} time(s). The file itself has not changed — save a copy to '
			+ 'keep this.', { n: st.edits }));
	}

	/// A Word document, read into the prose it holds.
	///
	/// TWO THINGS HERE ARE DELIBERATE AND NEITHER IS A PREFERENCE.
	///
	/// It renders MARKDOWN through `DaimondRender.md`, not HTML through a frame.
	/// The document is a STRANGER'S -- it arrived by mail, or a share, or a drag
	/// -- and `DaimondRender.md` is the sanitiser this app already trusts for
	/// prose it did not write, dropping `script style iframe form input button
	/// svg` whole. Handing a stranger's markup to a frame would mean getting the
	/// sandbox exactly right for a second time, and the first time is what the
	/// note at the top of this file is about.
	///
	/// And it SAYS WHAT IT DID NOT DRAW, by name and by count. A reading view
	/// that quietly dropped a chart would be lying by omission. "4 things are not
	/// drawn: 3 text boxes, 1 chart" tells a reader whether to go and open the
	/// file properly; "some content is not shown" tells them only that this
	/// viewer cannot be trusted.
	async function office(body, path, info, opts, tOr, mine, resume) {
		if (info.size > CAP_OFFICE) {
			body.appendChild(el('p', 'fv-note', tOr('fileview.office_too_large',
				'A {fmt} of {size} is too large to unpack here. Its bytes follow.',
				{ fmt: fmtName(info.media, info.label, tOr), size: fmtBytes(info.size) })));
			await hex(body, path, info, opts, tOr, mine, resume);
			return;
		}
		var m = await mod(opts);
		if (mine !== epoch) return;
		var u8 = await wholeBytes(path, info.size, opts);
		if (mine !== epoch) return;
		var st = { bytes: u8, media: info.media, edits: 0, sheets: [] };
		var got = null, why = '';
		try {
			got = m.office_read_doc(st.bytes, st.media);
		} catch (e) {
			why = (e && e.message) || String(e);
		}
		// A document that cannot be read is NAMED and its bytes are shown, which
		// is the same floor every other format falls to. An encrypted document
		// arrives here, and the reason it gives says so.
		if (!got) {
			body.appendChild(el('p', 'fv-warn', tOr('fileview.office_failed',
				'This document could not be read: {why}', { why: why })));
			await hex(body, path, info, opts, tOr, mine, resume);
			return;
		}
		// THE EDIT IS READ BACK RATHER THAN ASSUMED. Every redraw parses the bytes
		// the editor produced, through the same reader that drew the file when it
		// arrived, so what the reader now sees is what a reader of the saved copy
		// will see. Painting the replacement into the old markdown would show an
		// edit that the archive might not carry.
		var anchor = null;
		function redraw() {
			while (anchor.nextSibling) body.removeChild(anchor.nextSibling);
			var g = null, w = '';
			try { g = m.office_read_doc(st.bytes, st.media); }
			catch (e) { w = (e && e.message) || String(e); }
			if (!g) {
				// THE EDITED BANNER FIRST, EVEN HERE -- especially here. `editedLine`
				// claims never to be omitted once an edit has been applied, and this
				// path omitted it: an edit that made the document unreadable drew the
				// failure alone, so the one reader who most needs to know the file
				// itself is untouched was the one reader not told.
				if (st.edits) body.appendChild(editedLine(st, tOr));
				body.appendChild(el('p', 'fv-warn', tOr('fileview.office_failed',
					'This document could not be read: {why}', { why: w })));
				return;
			}
			drawDoc(body, g, st, tOr);
		}
		anchor = actions(body, m, st, path, info, tOr, redraw);
		drawDoc(body, got, st, tOr);
	}

	/// One reading of a text document, on screen.
	function drawDoc(body, got, st, tOr) {
		if (st.edits) body.appendChild(editedLine(st, tOr));
		// `fv-note` and `fv-warn` and nothing new: the stylesheet is another lane's
		// file, and a band that needed a class nobody had written would render as
		// unstyled text on top of the document. These two are what every other
		// tier here already says its caveats in.
		body.appendChild(el('p', 'fv-note', tOr('fileview.office_reading',
			'Reading view. This is what the document says, not how it prints.')));
		var missing = undrawnLine(got.undrawn, tOr);
		if (missing) body.appendChild(el('p', 'fv-note', missing));
		if (got.tracked) {
			body.appendChild(el('p', 'fv-note', tOr('fileview.office_tracked',
				'{n} tracked insertion(s) are shown as accepted; deletions are not shown.',
				{ n: got.tracked })));
		}
		if (got.macros) {
			body.appendChild(el('p', 'fv-warn', tOr('fileview.office_macros',
				'This file contains macros. They are not run and not read.')));
		}
		var box = el('div', 'fv-md md-body');
		if (window.DaimondRender && DaimondRender.md) box.innerHTML = DaimondRender.md(got.markdown);
		else box.appendChild(el('pre', 'fv-plain', got.markdown));
		body.appendChild(box);
	}

	/// A spreadsheet, drawn as the grid it is.
	///
	/// THE VALUE SHOWN IS THE ONE STORED IN THE FILE. Both formats keep each
	/// cell's last computed value beside its formula, and that is the number the
	/// person who wrote the file SAW. Recalculating would also make a file differ
	/// from itself the moment it held `NOW`, `TODAY` or `RAND`, so a document
	/// opened and saved untouched would show as changed -- and the check that
	/// exists to catch a damaging edit would fire on a healthy file instead.
	///
	/// Every sheet is drawn, each under its own tab name, because a workbook whose
	/// second sheet is silently absent is a workbook a person makes a decision on
	/// without knowing what they missed. Each is CUT to a rectangle and the cut is
	/// SAID -- a silent truncation reads as a corrupt file.
	async function sheet(body, path, info, opts, tOr, mine, resume) {
		if (info.size > CAP_OFFICE) {
			body.appendChild(el('p', 'fv-note', tOr('fileview.office_too_large',
				'A {fmt} of {size} is too large to unpack here. Its bytes follow.',
				{ fmt: fmtName(info.media, info.label, tOr), size: fmtBytes(info.size) })));
			await hex(body, path, info, opts, tOr, mine, resume);
			return;
		}
		var m = await mod(opts);
		if (mine !== epoch) return;
		var u8 = await wholeBytes(path, info.size, opts);
		if (mine !== epoch) return;
		var st = { bytes: u8, media: info.media, edits: 0, sheets: [] };
		var got = null, why = '';
		try {
			got = m.office_read_sheet(st.bytes, st.media, MAX_ROWS, MAX_COLS);
		} catch (e) {
			why = (e && e.message) || String(e);
		}
		if (!got) {
			body.appendChild(el('p', 'fv-warn', tOr('fileview.sheet_failed',
				'This spreadsheet could not be read: {why}', { why: why })));
			await hex(body, path, info, opts, tOr, mine, resume);
			return;
		}
		// The tab names, so a cell can be named the way the workbook names it. Read
		// off the file rather than typed by the user: a sheet name is the one part
		// of a cell reference nobody can guess.
		for (var n = 0; n < got.sheets.length; n++) st.sheets.push(got.sheets[n].name);
		var anchor = null;
		function redraw() {
			while (anchor.nextSibling) body.removeChild(anchor.nextSibling);
			var g = null, w = '';
			try { g = m.office_read_sheet(st.bytes, st.media, MAX_ROWS, MAX_COLS); }
			catch (e) { w = (e && e.message) || String(e); }
			if (!g) {
				if (st.edits) body.appendChild(editedLine(st, tOr));
				body.appendChild(el('p', 'fv-warn', tOr('fileview.sheet_failed',
					'This spreadsheet could not be read: {why}', { why: w })));
				return;
			}
			drawSheet(body, g, st, tOr);
		}
		anchor = actions(body, m, st, path, info, tOr, redraw);
		drawSheet(body, got, st, tOr);
	}

	/// One reading of a workbook, on screen.
	function drawSheet(body, got, st, tOr) {
		if (st.edits) body.appendChild(editedLine(st, tOr));
		body.appendChild(el('p', 'fv-note', tOr('fileview.sheet_stored',
			'Values are as stored in the file. Formulas are not recalculated.')));
		if (got.macros) {
			body.appendChild(el('p', 'fv-warn', tOr('fileview.office_macros',
				'This file contains macros. They are not run and not read.')));
		}
		for (var i = 0; i < got.sheets.length; i++) {
			var s = got.sheets[i];
			body.appendChild(el('h3', 'fv-sheetname', s.name));
			var wrap = el('div', 'fv-tablewrap');
			var tbl  = el('table', 'fv-table');
			// The column letters and the row numbers are drawn, because they are how
			// a person names a cell to somebody else and how `sheet_read` takes a
			// range. A bare grid leaves them counting columns.
			var head = el('tr');
			head.appendChild(el('th', 'fv-rownum', ''));
			for (var h = 0; h < s.heads.length; h++) {
				head.appendChild(el('th', null, s.heads[h]));
			}
			tbl.appendChild(head);
			for (var r = 0; r < s.cells.length; r++) {
				var tr = el('tr');
				tr.appendChild(el('th', 'fv-rownum', String(r + 1)));
				for (var c = 0; c < s.cells[r].length; c++) {
					tr.appendChild(el('td', null, s.cells[r][c]));
				}
				tbl.appendChild(tr);
			}
			wrap.appendChild(tbl);
			body.appendChild(wrap);
			if (s.cut) {
				body.appendChild(el('p', 'fv-note', tOr('fileview.sheet_capped',
					'Showing {shown} of {rows} rows and {cols} columns of this sheet.',
					{ shown: fmtExact(s.cells.length), rows: fmtExact(s.rows),
					  cols: fmtExact(s.cols) })));
			}
			if (s.formulas) {
				body.appendChild(el('p', 'fv-note', tOr('fileview.sheet_formulas',
					'{n} cell(s) here carry a formula; the value shown is the stored one.',
					{ n: s.formulas })));
			}
		}
		if (got.missing && got.missing.length) {
			body.appendChild(el('p', 'fv-warn', tOr('fileview.sheet_missing',
				'{n} sheet(s) are named by this workbook and could not be read: {names}.',
				{ n: got.missing.length, names: got.missing.join(', ') })));
		}
	}

	/// JSON as a tree that opens and closes.
	async function json(body, path, info, opts, tOr, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, tOr));
		var data, ok = true;
		try { data = JSON.parse(got.text); } catch (e) { ok = false; }
		if (!ok) {
			// Truncated at the cap, or a `.jsonl` stream, or simply malformed. All
			// three are worth saying rather than papering over, and the text is
			// still the most useful thing to show.
			body.appendChild(el('p', 'fv-note',
				tOr('fileview.json_bad', 'This is not one JSON value, so it is shown as text.')));
			body.appendChild(el('pre', 'fv-plain', got.text));
			return;
		}
		var budget = { left: MAX_NODES };
		body.appendChild(node(data, null, 0, budget));
		if (budget.left <= 0) {
			body.appendChild(el('p', 'fv-note',
				tOr('fileview.tree_capped', 'The tree is cut short here; the file is larger than it shows.')));
		}
	}

	/// One JSON value. Objects and arrays past the top level arrive closed, so a
	/// deep document opens as a shape rather than as a wall.
	function node(v, key, depth, budget) {
		if (budget.left-- <= 0) return el('div', 'fv-jrow', '…');
		var isArr = Array.isArray(v);
		var isObj = v !== null && typeof v === 'object' && !isArr;
		if (!isArr && !isObj) {
			var row = el('div', 'fv-jrow');
			if (key !== null) row.appendChild(el('span', 'fv-jkey', key));
			row.appendChild(el('span', 'fv-jval fv-j-' + (v === null ? 'null' : typeof v),
				v === null ? 'null' : (typeof v === 'string' ? v : String(v))));
			return row;
		}
		var keys = isArr ? null : Object.keys(v);
		var n    = isArr ? v.length : keys.length;
		var d    = el('details', 'fv-jnode');
		if (depth < 1) d.open = true;
		var s = el('summary', 'fv-jsum');
		if (key !== null) s.appendChild(el('span', 'fv-jkey', key));
		// Brackets and a count: a shape and a number say what this is in every
		// language, so there is nothing here to translate.
		s.appendChild(el('span', 'fv-jshape', (isArr ? '[…]' : '{…}') + ' ' + n));
		d.appendChild(s);
		var kids = el('div', 'fv-jkids');
		if (isArr) {
			for (var i = 0; i < n; i++) {
				kids.appendChild(node(v[i], String(i), depth + 1, budget));
				if (budget.left <= 0) break;
			}
		} else {
			for (var j = 0; j < n; j++) {
				kids.appendChild(node(v[keys[j]], keys[j], depth + 1, budget));
				if (budget.left <= 0) break;
			}
		}
		d.appendChild(kids);
		return d;
	}

	/// CSV or TSV as a table.
	///
	/// The first row is drawn as a header. That is a guess, and it is the guess
	/// nearly every one of these files rewards; a wrong one costs a reader one
	/// bold row and nothing else.
	async function table(body, path, info, opts, tOr, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, tOr));
		var rows = parseDelim(got.text, info.media === 'Tsv' ? '\t' : ',');
		var wrap = el('div', 'fv-tablewrap');
		var tbl  = el('table', 'fv-table');
		var shown = Math.min(rows.length, MAX_ROWS);
		for (var r = 0; r < shown; r++) {
			var tr = el('tr');
			var cells = rows[r].slice(0, MAX_COLS);
			for (var c = 0; c < cells.length; c++) {
				tr.appendChild(el(r === 0 ? 'th' : 'td', null, cells[c]));
			}
			tbl.appendChild(tr);
		}
		wrap.appendChild(tbl);
		body.appendChild(wrap);
		if (rows.length > shown) {
			body.appendChild(el('p', 'fv-note', tOr('fileview.rows_capped',
				'Showing the first {shown} rows of {total}.',
				{ shown: fmtExact(shown), total: fmtExact(rows.length) })));
		}
	}

	/// Split delimited text into rows of fields.
	///
	/// Quoting is honoured for CSV, where a field may hold the delimiter, a
	/// newline or a doubled quote. TSV has no quoting convention worth the name,
	/// so a tab is always a tab.
	function parseDelim(text, delim) {
		var rows = [], row = [], cur = '', q = false, quoting = (delim === ',');
		for (var i = 0; i < text.length; i++) {
			var c = text.charAt(i);
			if (q) {
				if (c !== '"') { cur += c; continue; }
				if (text.charAt(i + 1) === '"') { cur += '"'; i++; } else { q = false; }
				continue;
			}
			if (quoting && c === '"' && cur === '') { q = true; continue; }
			if (c === delim)  { row.push(cur); cur = ''; continue; }
			if (c === '\n')   { row.push(cur); cur = ''; rows.push(row); row = []; continue; }
			if (c === '\r')   { continue; }
			cur += c;
		}
		if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
		return rows;
	}

	/// The floor: the bytes themselves, sixteen to a line, hex beside ASCII.
	///
	/// One page is read at a time and no page is kept, so walking a gigabyte
	/// costs four kilobytes of memory. The bar names the exact range and the
	/// exact total, because at this tier the exact number IS the information --
	/// "12 KB" is no use to somebody counting into a header.
	async function hex(body, path, info, opts, tOr, mine, at) {
		// Two sentences, because one with a `{fmt}` hole in it cannot serve both
		// cases: the format is the whole point when it is known, and when it is not
		// the hole fills with the word "Unknown" and the line reads "no viewer here
		// for a Unknown".
		body.appendChild(el('p', 'fv-note', info.media === 'Unknown'
			? tOr('fileview.hex_note_unknown',
				'Nothing here recognises this file, so these are its bytes.')
			: tOr('fileview.hex_note',
				'There is no viewer here for a {fmt}, so these are its bytes.',
				{ fmt: fmtName(info.media, info.label, tOr) })));

		var bar  = el('div', 'fv-hexbar');
		var prev = el('button', 'fv-btn', tOr('fileview.hex_prev', 'Earlier bytes'));
		var next = el('button', 'fv-btn', tOr('fileview.hex_next', 'Later bytes'));
		var at_  = el('span', 'fv-hexat');
		prev.type = 'button'; next.type = 'button';
		bar.appendChild(prev); bar.appendChild(next); bar.appendChild(at_);
		var pre = el('pre', 'fv-hex');
		body.appendChild(bar);
		body.appendChild(pre);

		// A remembered offset is clamped to a page boundary inside the file, so a
		// redraw of a file that has since shrunk lands somewhere that exists.
		var lastPage = Math.max(0, Math.floor(Math.max(0, info.size - 1) / PAGE) * PAGE);
		var off = Math.min(Math.max(0, at || 0), lastPage);

		async function page() {
			var u8 = await readBytes(path, off, PAGE, opts);
			if (mine !== epoch) return;
			pre.textContent = hexLines(u8, off);
			at_.textContent = tOr('fileview.hex_at', 'Bytes {from} to {to} of {total}', {
				from:  fmtExact(off),
				to:    fmtExact(off + Math.max(u8.length, 1) - 1),
				total: fmtExact(info.size),
			});
			prev.disabled = off <= 0;
			next.disabled = off + PAGE >= info.size;
			if (last) last.hexAt = off;
		}

		prev.addEventListener('click', function () {
			off = Math.max(0, off - PAGE);
			page();
		});
		next.addEventListener('click', function () {
			if (off + PAGE < info.size) { off += PAGE; page(); }
		});
		await page();
	}

	/// One page of bytes as `offset  hex hex …  |ascii|`.
	function hexLines(u8, base) {
		var out = '';
		for (var i = 0; i < u8.length; i += 16) {
			var line = (base + i).toString(16);
			while (line.length < 8) line = '0' + line;
			var hexPart = '', asc = '';
			for (var j = 0; j < 16; j++) {
				if (j === 8) hexPart += ' ';
				if (i + j < u8.length) {
					var b = u8[i + j];
					hexPart += (b < 16 ? '0' : '') + b.toString(16) + ' ';
					asc += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
				} else {
					hexPart += '   ';
				}
			}
			out += line + '  ' + hexPart + ' |' + asc + '|\n';
		}
		return out;
	}

	/// The line that says a read stopped short. Never omitted: a truncation
	/// nobody mentions reads as a corrupt file.
	function cappedLine(size, cap, tOr) {
		return el('p', 'fv-note', tOr('fileview.capped',
			'Showing the first {shown} of {total}.',
			{ shown: fmtBytes(cap), total: fmtBytes(size) }));
	}

	// ── A change of language redraws what is on screen ───────────────
	//
	// Every string above is fetched when it is drawn, so a panel already drawn
	// keeps the old language until something redraws it. The hex page is carried
	// across, so the redraw does not send a reader back to offset zero.

	if (window.DaimondI18n && DaimondI18n.onChange) {
		DaimondI18n.onChange(function () {
			if (!last) return;
			var l = last;
			try { show(l.host, l.path, l.info, l.opts); } catch (e) { /* nothing to redraw */ }
		});
	}

	// ── The daimon's door ────────────────────────────────────────────
	//
	// `file_show` in `src/tools.rs` calls `DaimondDoc.show` from the wasm, the way
	// the agent's web tools call `window.DaimondWeb`. It resolves with `verdict`'s
	// own answer as JSON, so the sentence the model then says to the user is built
	// from the table at the top of this file and not from a copy of it in Rust.
	//
	// THE OPENER IS REGISTERED RATHER THAN REACHED FOR. Only `daimond.js` can put
	// a file in the Doc panel -- the panel, its header, its download and its
	// editor are all inside that module's closure, and `openFile` there is what
	// decides between the editor and this viewer. So that module hands the
	// function over and this file keeps the question of what showing one MEANS.
	// The alternative was a second opener, which is a second answer to the
	// routing question that has already been got wrong twice.
	var opener = null;

	/// Register the function that puts a workspace file in the document panel.
	/// Called once, by `daimond.js`, with its own `openFile`.
	function setOpener(fn) {
		opener = (typeof fn === 'function') ? fn : null;
	}

	/// Put `path` in front of the user, and say what they are now looking at.
	///
	/// Rejects with a plain-English `Error` when there is no panel to show it in;
	/// the Rust edge passes that message through verbatim, because it is the only
	/// instruction the model gets about what to do next.
	///
	/// # Arguments
	/// * `path` - A workspace-relative path. Never bytes: a view that was handed
	///   CONTENT could not be refreshed when the file changed, and the same file
	///   shown again is the whole of how a rebuilt document reaches the reader.
	/// * `page` - Which page to open a PDF at, or nothing to leave it where this
	///   file was last aimed -- which is what makes a rebuilt document come back
	///   in the reader's place rather than at page 1.
	async function showToUser(path, page) {
		if (!opener) {
			throw new Error('Daimond’s document panel is not on this page, so there is '
				+ 'nothing to show a file in.');
		}
		var v = await verdict(path, {});
		at(path, page);			// before the draw, which is what reads it
		// The page ACTUALLY used, not the one asked for. They differ whenever a
		// re-show keeps an earlier aim, and a model told the argument back would
		// tell the user page 1 while they are looking at page 214.
		v.page = aimPage(path);
		await opener(path);
		return JSON.stringify(v);
	}

	window.DaimondDoc = { show: showToUser };

	window.DaimondViewer = {
		probe:         probe,
		verdict:       verdict,
		show:          show,
		close:         close,
		// Where a document opens next time it is drawn.
		at:            at,
		opener:        setOpener,
		// The routing question a panel with an editor in it has to answer, kept
		// here beside the table it is answered from rather than restated by every
		// caller -- one caller restating it is what put a PDF in a <pre>.
		editable:      editable,
		KIND_HANDLERS: Object.freeze(KIND_HANDLERS),
		// The second lock, published for the same reason the first one is: a test
		// can then see that no deck has an editor WITHOUT rendering one, and a
		// deck added here goes red on its own rather than only when somebody also
		// routes it to a reading tier. Two locks that can only be checked together
		// are one lock.
		EDIT_DOOR:     Object.freeze(EDIT_DOOR),
	};
})();
