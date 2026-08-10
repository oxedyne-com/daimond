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
//      fails to appear.
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
// A frame gets `sandbox="allow-scripts"` and nothing else, ever. A `blob:` URL
// INHERITS OUR ORIGIN, so a frame with `allow-same-origin` runs as the app: it
// reads `localStorage`, where the user's API key lives, and it reaches OPFS.
// The file being framed may be one an agent wrote a moment ago, after reading a
// web page that told it what to write. `www/js/web.js` sets this out at length
// where the Web panel does the same thing. SVG is therefore shown through
// `<img>` and never a frame: script inside an SVG executes in a frame and does
// not in an `<img>`, which is the whole reason it sits in the image list.
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
//     window.DaimondViewer = { probe, show, close, KIND_HANDLERS }
//
// `opts` carries `{ store, t, onError, wasm }`. Every user-visible string in
// this file goes through `opts.t`, so the file holds no English of its own that
// a translation pass cannot reach.
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
		Pdf: 'frame',	Html: 'frame',
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

	// ── Small helpers ────────────────────────────────────────────────

	/// The app's string for `key`, or `english` where there is no table yet.
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
		var t = tOrOf(opts);
		var handler = (info && info.handler) || handlerFor(info);
		last = { host: host, path: path, info: info, opts: opts, hexAt: resume };

		var root = el('div', 'fileview');
		root.setAttribute('data-viewer', handler);
		root.appendChild(meta(info, t));
		if (info && info.disagree) root.appendChild(disagreeLine(info, t));
		var body = el('div', 'fv-body');
		root.appendChild(body);
		host.textContent = '';
		host.appendChild(root);

		try {
			await draw(handler, body, path, info, opts, t, mine, resume);
		} catch (e) {
			if (mine !== epoch) return;
			body.textContent = '';
			body.appendChild(el('p', 'fv-warn',
				t('fileview.read_failed', 'This file could not be read: {reason}',
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
	function meta(info, t) {
		var row = el('div', 'fv-meta');
		row.appendChild(el('span', 'fv-fmt', fmtName(info && info.media, info && info.label, t)));
		row.appendChild(el('span', 'fv-size', fmtBytes((info && info.size) || 0)));
		return row;
	}

	function fmtName(media, label, t) {
		var v = media || 'Unknown';
		return t('fileview.fmt.' + v, label || v);
	}

	/// One line, when the name and the bytes do not agree.
	///
	/// `identify` acts on the bytes, so the format shown is always what the bytes
	/// said; the line says both and says which won, because a person looking at a
	/// broken export needs to know the claim as well as the evidence.
	function disagreeLine(info, t) {
		return el('p', 'fv-warn fv-disagree',
			t('fileview.disagree',
				'The name says {named}. The bytes say {found}, and that is what is shown here.',
				{
					// The LABEL, not the variant name. `byName`/`byMagic` are
					// identifiers -- `Pdf`, `Text` -- and a sentence built from them
					// read "The bytes say Pdf", which is the code's word for the
					// format arriving on screen in front of a person who is already
					// looking at something that went wrong.
					named: fmtName(info.byName, info.byNameLabel, t),
					found: fmtName(info.byMagic, info.byMagicLabel, t),
				}));
	}

	// ── The tiers ────────────────────────────────────────────────────

	/// Draw one tier into `body`. `mine` is the epoch this draw belongs to; every
	/// await is followed by a check of it, so a file opened while another was
	/// still reading cannot paint over the newer one.
	async function draw(handler, body, path, info, opts, t, mine, resume) {
		var size = (info && info.size) || 0;
		if (!size) {
			body.appendChild(el('p', 'fv-note', t('fileview.empty', 'This file is empty.')));
			return;
		}

		// Tier 1 wants the whole file, so it is the one with a hard ceiling. Over
		// it the file is NAMED and its bytes are dumped: a prefix of a container
		// format is not a smaller file, it is a corrupt one, and handing it to a
		// decoder produces exactly the "this app is broken" impression this whole
		// file exists to remove.
		var whole = (handler === 'image' || handler === 'audio' || handler === 'video'
			|| handler === 'frame');
		if (whole && size > CAP_WHOLE) {
			body.appendChild(el('p', 'fv-note', t('fileview.too_large',
				'This is a {fmt} of {size}, too large to hold in memory here. Its bytes follow; '
				+ 'download it to open it in something that understands it.',
				{ fmt: fmtName(info.media, info.label, t), size: fmtBytes(size) })));
			await hex(body, path, info, opts, t, mine, resume);
			return;
		}

		switch (handler) {
			case 'image':	return await media(body, 'img',   path, info, opts, t, mine);
			case 'audio':	return await media(body, 'audio', path, info, opts, t, mine);
			case 'video':	return await media(body, 'video', path, info, opts, t, mine);
			case 'frame':	return await frame(body, path, info, opts, t, mine);
			case 'json':	return await json(body, path, info, opts, t, mine);
			case 'table':	return await table(body, path, info, opts, t, mine);
			case 'markdown':	return await markdown(body, path, info, opts, t, mine);
			case 'text':	return await plain(body, path, info, opts, t, mine);
			default:	return await hex(body, path, info, opts, t, mine, resume);
		}
	}

	/// A picture, a sound or a moving picture, on a `Blob` carrying the probe's
	/// media type. The type is not decoration: a `Blob` typed
	/// `application/octet-stream` is a picture that does not appear.
	async function media(body, tag, path, info, opts, t, mine) {
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
				t('fileview.decode_failed', 'This browser could not decode this {fmt}.',
					{ fmt: fmtName(info.media, info.label, t) })), n);
		});
		n.src = mint(blob);
		body.appendChild(n);
	}

	/// A PDF or an HTML page, in a frame that runs in an opaque origin.
	///
	/// `allow-scripts` AND NOTHING ELSE. Not `allow-same-origin`, which would
	/// hand the framed file our origin and with it `localStorage` and OPFS; not
	/// `allow-forms`, `allow-popups`, `allow-modals` or `allow-top-navigation`.
	/// The one flag is there because the browser's own PDF viewer is a script.
	async function frame(body, path, info, opts, t, mine) {
		var blob = await wholeBlob(path, info.size, info.mime, opts);
		if (mine !== epoch) return;
		var f = el('iframe', 'fv-frame');
		f.setAttribute('sandbox', 'allow-scripts');
		f.setAttribute('referrerpolicy', 'no-referrer');
		f.setAttribute('title', t('fileview.frame_title', 'The contents of {name}',
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
	async function plain(body, path, info, opts, t, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, t));
		body.appendChild(el('pre', 'fv-plain', got.text));
	}

	/// Markdown through the renderer the chat already uses.
	///
	/// `DaimondRender.md` sanitises, and it drops `script style iframe form input
	/// button svg` whole. That is correct and is not loosened here: the file being
	/// rendered may have been written by an agent, and this panel is inside our
	/// origin.
	async function markdown(body, path, info, opts, t, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, t));
		// `md-body` is render.css's own hook for a block of rendered markdown; it
		// carries the link colours, so a document's links look like the app's.
		var box = el('div', 'fv-md md-body');
		if (window.DaimondRender && DaimondRender.md) box.innerHTML = DaimondRender.md(got.text);
		else box.appendChild(el('pre', 'fv-plain', got.text));
		body.appendChild(box);
	}

	/// JSON as a tree that opens and closes.
	async function json(body, path, info, opts, t, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, t));
		var data, ok = true;
		try { data = JSON.parse(got.text); } catch (e) { ok = false; }
		if (!ok) {
			// Truncated at the cap, or a `.jsonl` stream, or simply malformed. All
			// three are worth saying rather than papering over, and the text is
			// still the most useful thing to show.
			body.appendChild(el('p', 'fv-note',
				t('fileview.json_bad', 'This is not one JSON value, so it is shown as text.')));
			body.appendChild(el('pre', 'fv-plain', got.text));
			return;
		}
		var budget = { left: MAX_NODES };
		body.appendChild(node(data, null, 0, budget));
		if (budget.left <= 0) {
			body.appendChild(el('p', 'fv-note',
				t('fileview.tree_capped', 'The tree is cut short here; the file is larger than it shows.')));
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
	async function table(body, path, info, opts, t, mine) {
		var got = await headText(path, info.size, opts);
		if (mine !== epoch) return;
		if (got.capped) body.appendChild(cappedLine(info.size, CAP_TEXT, t));
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
			body.appendChild(el('p', 'fv-note', t('fileview.rows_capped',
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
	async function hex(body, path, info, opts, t, mine, at) {
		// Two sentences, because one with a `{fmt}` hole in it cannot serve both
		// cases: the format is the whole point when it is known, and when it is not
		// the hole fills with the word "Unknown" and the line reads "no viewer here
		// for a Unknown".
		body.appendChild(el('p', 'fv-note', info.media === 'Unknown'
			? t('fileview.hex_note_unknown',
				'Nothing here recognises this file, so these are its bytes.')
			: t('fileview.hex_note',
				'There is no viewer here for a {fmt}, so these are its bytes.',
				{ fmt: fmtName(info.media, info.label, t) })));

		var bar  = el('div', 'fv-hexbar');
		var prev = el('button', 'fv-btn', t('fileview.hex_prev', 'Earlier bytes'));
		var next = el('button', 'fv-btn', t('fileview.hex_next', 'Later bytes'));
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
			at_.textContent = t('fileview.hex_at', 'Bytes {from} to {to} of {total}', {
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
	function cappedLine(size, cap, t) {
		return el('p', 'fv-note', t('fileview.capped',
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

	window.DaimondViewer = {
		probe:         probe,
		show:          show,
		close:         close,
		KIND_HANDLERS: Object.freeze(KIND_HANDLERS),
	};
})();
