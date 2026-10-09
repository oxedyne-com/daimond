/* crystal.js — a Diamond's crystal, and the page that draws it.
 *
 * A crystal is two files now. `crystal.json` is the memory: capped, folded, and
 * put in the standing context. `crystal.html` is a self-contained page that
 * renders it, and every Diamond starts on the one below, so the shipped page is
 * the view most people actually see rather than a placeholder behind a feature
 * flag.
 *
 * THE PAGE IS NOT TRUSTED, AND THAT IS THE WHOLE MECHANISM. It is written by a
 * model that may itself have been steered by a web page it read a moment ago, it
 * is exempt from the cap on the data, it is absent from the standing context,
 * unseen by the reducer and unseen by the fold diff — the one injection in this
 * app that survives a turn, and it syncs to every device. So it runs in an
 * `iframe` with `sandbox="allow-scripts"` and nothing else: an opaque origin,
 * with no reach into `localStorage` where the key lives, no OPFS, no wasm
 * bridge, and no read of the app's DOM.
 *
 * `allow-same-origin` is the attribute that would undo all of it. A blob: URL
 * INHERITS OUR ORIGIN, so a page rendered that way unsandboxed runs AS US.
 * `www/js/web.js` at ~line 673 carries the long form of that argument for the
 * agent's own preview frame; this is the same trap and the same answer. Do not
 * add `allow-forms`, `allow-popups`, `allow-modals` or `allow-top-navigation`
 * either.
 *
 * AND THE SANDBOX IS ONLY HALF OF IT. Isolation stops the page READING anything
 * of ours; it does not stop it SENDING. So every page — the shipped one and any
 * a model writes later — is served under a `Content-Security-Policy` that
 * forbids the network outright, injected on the way into the frame. That is not
 * a restriction laid on top of the design, it is the design written down: a page
 * that is self-contained, with its CSS and its script inline and its images as
 * data URIs, has nothing to fetch. See `armour` below.
 *
 * THE VERB LIST GREW ONCE, on 2026-08-13, and the paragraph it replaced said it
 * never would. That paragraph was right about `ask` and wrong to bundle `save`
 * in with it, so the argument is worth restating rather than deleting.
 *
 * A parent cannot verify user activation across this boundary: a timer in the
 * page is indistinguishable from a click. For `ask` that is decisive, because
 * asking spends the user's money, and a page that could ask in a loop could
 * spend it in a loop -- which is why the ask-the-daimon box lives in app chrome
 * BELOW the frame, where a click is provably a person. For `save` the same
 * argument gives a much smaller answer: a runaway page can write only inside its
 * own Diamond, only text it composed itself, and only what the budget below
 * allows. So the verb exists and the loop is bounded instead of forbidden.
 *
 * The cost of growing the list is real and is paid by OLD pages, not new ones: a
 * page written before today does not speak `save`, and nothing can teach it --
 * a migration can rename a file but cannot rewrite a model-authored page. So a
 * verb may be ADDED and may never change meaning, and a page that does not use
 * one is unaffected. `ready`, `asset`, `save`, `rendered`, `height`, `open`.
 *
 * A DAIMON CAN SEE ITS OWN PAGE, ON DEMAND (`render`, 2026-10-04). `capture` cannot reach
 * into a frame (an opaque origin has no DOM we can query), so a daimon was blind to how its
 * own page drew, and one asked to fix a tile-size fault spent 52 rounds guessing from the
 * CSS. The page is often not on screen at all (a handed-off turn runs on another device),
 * so nothing here depends on the visible frame: `render` makes a FRESH frame, off screen,
 * through the same `makeFrame` as `mount` (same sandbox, same policy), hands it the same
 * data, and posts it `{cmd:'probe', id, sel}`. A shim armoured in beside the policy of THAT
 * frame only, a separate script the page cannot edit, answers `{cmd:'probed', id, ...}` with
 * rows measured from the page's OWN DOM and a PNG drawn in the frame by the app's own
 * rasteriser; then the frame is removed. The visible frame never carries the shim. The
 * answer is DATA, never trusted: a page can post `probed` itself, so the parent takes only
 * the numbers and short printable strings it expects, caps every one, builds the table's
 * text itself, and answers only the probe it has outstanding. No sandbox flag changes.
 * See "The probe" below for the threat written down.
 *
 * FAILING IS VISIBLE. A page that never says `ready`, or that reports rendering
 * less than the data holds, is replaced by the built-in view with a note saying
 * which of the two happened and a button that puts the standard page back.
 * Silent degradation is how a broken page stays broken for a month, and a page
 * that quietly showed three sections of seven after a key rename would be
 * invisible to the parent and invisible to the model too.
 *
 * LEADING-UNDERSCORE KEYS ARE THE CHANNEL'S OWN. The page is in an opaque origin
 * and can see neither the app's stylesheet nor its translation table, so the
 * parent hands both to it inside the `data` reply, under `_theme` and `_labels`.
 * They are never the model's, they are stripped from anything that goes back out,
 * and the built-in view ignores them. A key beginning with `_` is thus reserved
 * on the wire, and everything else — recognised or not — is content.
 *
 *     window.DaimondCrystal = { CORE_KEYS, DEFAULT_PAGE, adopt, restyle, soften, draw, isDefault, FALLBACK_MS, PROTOCOL,
 *                               parse, toMarkdown, fromMarkdown,
 *                               mount, unmount, fallback, render, setAssetReader }
 */
(function () {
	'use strict';

	/// The core schema, in the order everything renders it. Extra top-level keys
	/// are permitted and nothing may ever drop one it does not recognise.
	var CORE_KEYS = ['title', 'summary', 'sections', 'facts', 'links'];

	/// The channel's version. Every message carries `{dc:1, v:1}`; a message
	/// without both is not ours and is not read.
	var PROTOCOL = 1;

	/// How long a page has to say `ready`, and then how long it has to say
	/// `rendered`. Short enough that a broken page does not look like a slow one.
	var FALLBACK_MS = 1500;

	/// What the frame may ask to be. A page that reports nothing keeps the height
	/// the stylesheet gave it and scrolls inside itself, which is ugly but loses
	/// nothing; a page reporting a silly number is clamped rather than believed.
	var MIN_H = 40;
	var MAX_H = 20000;

	/// The longest href the parent will carry out of the frame.
	var HREF_MAX = 2048;


	// ── Small shared helpers ────────────────────────────────────────

	/// A string from anything, without `null` becoming the word.
	function str(v) { return v == null ? '' : String(v); }

	/// An array from anything, so a malformed crystal renders rather than throws.
	function arr(v) { return Array.isArray(v) ? v : []; }

	/// A plain object from anything. An array is not one: `sections` is a list and
	/// the document is not.
	function obj(v) {
		return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
	}

	function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

	/// Whether a value carries content. One predicate, used by the coverage check,
	/// by `toMarkdown` and by both views, so "the page did not render this" and
	/// "there was nothing to render" can never disagree.
	function hasContent(v) {
		if (v == null) return false;
		if (typeof v === 'string') return v.trim() !== '';
		if (typeof v === 'number' || typeof v === 'boolean') return true;
		if (Array.isArray(v)) return v.length > 0;
		if (typeof v === 'object') {
			for (var k in v) if (own(v, k)) return true;
			return false;
		}
		return false;
	}

	/// The top-level keys of a crystal that carry something, channel keys aside.
	function contentKeys(data) {
		var d = obj(data), out = [];
		for (var k in d) {
			if (!own(d, k) || k.charAt(0) === '_') continue;
			if (hasContent(d[k])) out.push(k);
		}
		return out;
	}

	/// The three keys `toMarkdown` has a markdown form for, and therefore the three
	/// the migration can produce. Everything else travels as data.
	var MD_KEYS = ['title', 'summary', 'sections'];

	/// The keys markdown cannot carry, in a stable order: the rest of the core
	/// first, then everything the reducer invented, in the order it wrote them.
	function extraKeys(data) {
		var d = obj(data), out = [], i;
		for (i = 0; i < CORE_KEYS.length; i++) {
			var c = CORE_KEYS[i];
			if (MD_KEYS.indexOf(c) >= 0) continue;
			if (own(d, c) && hasContent(d[c])) out.push(c);
		}
		for (var k in d) {
			if (!own(d, k) || k.charAt(0) === '_') continue;
			if (CORE_KEYS.indexOf(k) >= 0) continue;
			if (hasContent(d[k])) out.push(k);
		}
		return out;
	}

	/// A string from the app's table, or the English written here while the key is
	/// still on its way into the other seven locales. The same shape as the app's
	/// own `tOr`, because this file must hold no strings of its own that a reader
	/// could ever see untranslated.
	function tr(opts, key, english, vars) {
		var f = (opts && typeof opts.t === 'function') ? opts.t : null;
		if (f) {
			var s = f(key, vars);
			if (s != null && s !== key) return String(s);
		}
		return String(english).replace(/\{(\w+)\}/g, function (whole, k) {
			return (vars && vars[k] != null) ? String(vars[k]) : whole;
		});
	}


	// ── parse ───────────────────────────────────────────────────────

	/// Read `crystal.json`. Never throws: a Diamond whose crystal will not parse
	/// must still draw something, because the alternative is a blank face and an
	/// agent handed an empty crystal writing a new one over work it never saw.
	///
	/// `error` is diagnostic — the engine's own words, for a console line or a
	/// detail row. The sentence shown to the reader is the app's
	/// `crystal.json_invalid`, never this.
	function parse(text) {
		var s = str(text);
		if (!s.trim()) return { ok: true, data: {}, error: '' };
		var d;
		try {
			d = JSON.parse(s);
		} catch (e) {
			return { ok: false, data: null, error: String((e && e.message) || e) };
		}
		if (d === null || typeof d !== 'object' || Array.isArray(d)) {
			return { ok: false, data: null, error: 'The crystal must be a JSON object.' };
		}
		return { ok: true, data: d, error: '' };
	}


	// ── The migration, and the property that proves it ──────────────
	//
	// `crystal.md` becomes `crystal.json`, and the assertion is not the steps but
	// the round trip: `toMarkdown(fromMarkdown(md)) === md`, byte for byte, over
	// the real crystals in a seeded workspace. The same conversion exists in Rust,
	// which does the actual migration, and `verify_crystalmigrate` compares the two
	// — so THE TWO MUST BE ONE FUNCTION IN TWO LANGUAGES, not two functions that
	// each happen to round-trip against themselves. This pair follows Rust.
	//
	// NOTHING IS JOINED AND NOTHING IS TRIMMED. `toMarkdown` writes `# `, the
	// title, one newline; then the summary exactly as it stands; then, per section,
	// `## `, the heading, one newline, and the body exactly as it stands. No
	// separator is inserted anywhere and no trailing newline is invented. The
	// blank line a reader sees between two sections is therefore the first
	// character of the following body, carried there by the split and put back by
	// the concatenation.
	//
	// That is what makes losslessness STRUCTURAL rather than enumerated. The
	// alternative — join the pieces with a blank line and strip the blank lines
	// off each piece on the way in — reads more tidily in the JSON and normalises
	// on the way out, and normalisation is precisely what cannot round-trip: a
	// document with three blank lines between two sections, or with none, comes
	// back with one either way and no longer matches the file it came from.
	//
	// AN EMPTY HEADING EMITS NO MARKER. It is the no-headings case, which owns the
	// whole document and has no `## ` of its own to put back. The splitter refuses
	// to read a bare `## ` line as a heading for the same reason, so the two can
	// never collide; the `# ` line is held to the same rule.
	//
	// And the check is MECHANICAL, not a list of shapes it knows about:
	// `fromMarkdown` parses, renders straight back, compares byte for byte, and
	// falls back to a single verbatim section when they differ. A ladder of cases
	// covers the inputs somebody thought of. This covers the one nobody did, which
	// is the one that turns up in a real workspace.
	//
	// Two cases are still worth naming. A `##` INSIDE A FENCED CODE BLOCK is not a
	// heading: the scan toggles on fences and a `## ` under an open one is body
	// text. The round trip would survive reading it as a heading — the pieces
	// rejoin to the same bytes either way — so nothing about losslessness catches
	// that mistake; what it produces is a section whose body opens with a dangling
	// fence, which every renderer downstream then gets wrong. TEXT BEFORE THE FIRST
	// HEADING has no home in the schema, so a `# ` line that is not the first line
	// of the file is not promoted to `title` at all — the whole run before the
	// first `## ` becomes the summary, hash and all, which reproduces exactly
	// because the summary is carried verbatim.
	//
	// Every rule below is Rust's, deliberately and to the letter, down to the ones
	// that look arbitrary from here: a fence is any line whose trimmed form opens
	// with three backticks or three tildes and it merely TOGGLES, a heading needs
	// text that survives a trim, and a heading line need not end in a newline —
	// one that does not simply fails the comparison and sends the document
	// verbatim. Two functions that each round-trip against themselves are still two
	// functions, and `verify_crystalmigrate` compares them against each other.

	/// Whether a line opens or closes a fenced code block.
	function isFence(line) {
		var t = line.trim();
		return t.indexOf('```') === 0 || t.indexOf('~~~') === 0;
	}

	/// Find the structural headings of a markdown file: the `# ` line if it is the
	/// first line, and every `## ` line outside a fenced code block. A heading whose
	/// text does not survive a trim is not a heading — a section with an empty
	/// heading is how the no-headings case is spelled, and the renderer drops the
	/// marker for it, so a bare `## ` left in the body is the only way it survives.
	function scan(md) {
		var h1 = null, h2 = [];
		var i = 0, n = md.length;
		var fenced = false;
		while (i < n) {
			var j = md.indexOf('\n', i);
			var end = (j < 0) ? n : j + 1;         // past the newline
			var line = md.slice(i, (j < 0) ? n : j);
			if (isFence(line)) {
				fenced = !fenced;
			} else if (!fenced) {
				// The title is the FIRST line or nothing. A `# ` further down is
				// somebody's sub-heading, and hoisting it would move text the user
				// put after it to before it.
				if (i === 0 && line.indexOf('# ') === 0 && line.slice(2).trim() !== '') {
					h1 = { after: end, title: line.slice(2) };
				}
				if (line.indexOf('## ') === 0 && line.slice(3).trim() !== '') {
					h2.push({ start: i, after: end, heading: line.slice(3) });
				}
			}
			i = end;
		}
		return { h1: h1, h2: h2 };
	}

	/// The structural reading of a markdown file. Every run of text is taken byte
	/// for byte; the only characters this drops are the newlines that end the
	/// heading lines, and `toMarkdown` puts those back.
	function decompose(md) {
		var sc = scan(md);
		var title = sc.h1 ? sc.h1.title : '';
		var pos = sc.h1 ? sc.h1.after : 0;
		var firstH2 = sc.h2.length ? sc.h2[0].start : md.length;
		var summary = md.slice(pos, firstH2);
		var secs = [];
		for (var i = 0; i < sc.h2.length; i++) {
			var end = (i + 1 < sc.h2.length) ? sc.h2[i + 1].start : md.length;
			secs.push({ heading: sc.h2[i].heading, body: md.slice(sc.h2[i].after, end) });
		}
		// No headings at all becomes one section with an empty heading, per the
		// schema. Not a bare summary: a summary is what a title is followed BY, and
		// there is no title here.
		if (!title && !secs.length) return { sections: [{ heading: '', body: summary }] };
		var data = {};
		if (title) data.title = title;
		if (summary) data.summary = summary;
		if (secs.length) data.sections = secs;
		return data;
	}

	/// A markdown crystal read as data. The answer is always one this file's own
	/// `toMarkdown` reproduces exactly, because it is checked rather than trusted.
	function fromMarkdown(md) {
		var s = str(md);
		// Nothing stays nothing. A new Diamond's crystal is an empty file, and it
		// should arrive as an empty object rather than a section holding no text.
		if (!s) return {};
		var d = decompose(s);
		if (toMarkdown(d) === s) return d;
		return { sections: [{ heading: '', body: s }] };
	}

	/// Data rendered back to markdown: pure concatenation, nothing joined, nothing
	/// trimmed, no trailing newline synthesised. An empty title or heading emits no
	/// marker at all.
	///
	/// The three keys the migration produces come out as markdown. Everything else
	/// — the rest of the core schema and whatever the reducer invented — comes out
	/// as one fenced JSON block, because markdown has no faithful form for a list
	/// of key/value pairs and reshaping it is exactly the loss this design exists
	/// to prevent. That block also needs no labels, so this function stays
	/// locale-free: it is the migration's serialiser and the verifier's oracle,
	/// not a display path. It is the one place a separator is inserted, and it
	/// cannot touch the round trip: a migrated crystal never carries those keys, so
	/// the branch never runs while the property is being checked.
	function toMarkdown(data) {
		var d = obj(data), out = '', i;
		var title = str(d.title);
		if (title) out += '# ' + title + '\n';
		out += str(d.summary);
		var secs = arr(d.sections);
		for (i = 0; i < secs.length; i++) {
			var s = obj(secs[i]);
			var h = str(s.heading);
			if (h) out += '## ' + h + '\n';
			out += str(s.body);
		}
		var rest = extraKeys(d);
		if (rest.length) {
			var bag = {};
			for (i = 0; i < rest.length; i++) bag[rest[i]] = d[rest[i]];
			if (out) out = out.replace(/\n*$/, '\n\n');
			out += '```json\n' + JSON.stringify(bag, null, 2) + '\n```';
		}
		return out;
	}


	// ── The theme and the words, handed across the boundary ─────────
	//
	// The page cannot see `variables.css` and cannot see the translation table, so
	// it is told. Both ride inside the `data` reply rather than in verbs of their
	// own, which is what keeps the verb list at five.
	//
	// The colours are RESOLVED, not named: a probe element is asked what
	// `var(--text-primary)` actually comes out as in the app's current cascade, so
	// all eleven palettes and both skins work without this file knowing one of
	// them by name, and a custom property defined in terms of another resolves
	// rather than arriving as the literal text `var(--bg-primary)`.

	var TONES = [
		['bg',         '--bg-secondary'],
		['surface',    '--bg-tertiary'],
		['text',       '--text-primary'],
		['muted',      '--text-muted'],
		['border',     '--border'],
		['accent',     '--accent'],
		['accentText', '--accent-text'],
	];

	/// What the app looks like right now, in terms a page in an opaque origin can
	/// use directly.
	function themeOf(el, names) {
		var root = document.documentElement;
		var out = {
			ink:    root.getAttribute('data-ink') || 'light',
			theme:  root.getAttribute('data-theme') || '',
			skin:   root.getAttribute('data-skin') || 'sharp',
			font:   '', mono: '', size: '', radius: '',
		};
		var probe = document.createElement('div');
		probe.setAttribute('aria-hidden', 'true');
		probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;'
			+ 'visibility:hidden;pointer-events:none';
		(el || document.body).appendChild(probe);
		try {
			for (var i = 0; i < TONES.length; i++) {
				probe.style.color = 'var(' + TONES[i][1] + ')';
				out[TONES[i][0]] = getComputedStyle(probe).color || '';
			}
			probe.style.color = '';
			var cs = getComputedStyle(probe);
			out.font   = cs.fontFamily || '';
			out.size   = cs.fontSize || '';
			probe.style.fontFamily = 'var(--font-mono)';
			out.mono   = getComputedStyle(probe).fontFamily || '';
			out.radius = getComputedStyle(document.documentElement)
				.getPropertyValue('--radius').trim() || '';
			var faces = facesNamed(out.skin, out.font + ',' + out.mono + ',' + names);
			if (faces) out.faces = faces;
		} catch (e) {
			// A theme we could not read is not a reason to show nothing; the page
			// carries its own neutral defaults for exactly this.
		}
		if (probe.parentNode) probe.parentNode.removeChild(probe);
		return out;
	}

	/// The field names, translated once by the parent because the page cannot.
	function labelsFor(opts) {
		return {
			facts:      tr(opts, 'crystal.field_facts', 'Facts'),
			links:      tr(opts, 'crystal.field_links', 'Links'),
			other:      tr(opts, 'crystal.other_fields', 'Other fields'),
			empty:      tr(opts, 'crystal.empty', 'The crystal is empty. Steer it below to begin.'),
		};
	}

	/// The data as the page receives it: the model's keys untouched, the channel's
	/// two added, and any `_` key the model happened to write stripped — the
	/// underscore is reserved on the wire, so a crystal carrying `_theme` cannot
	/// dress itself up as the parent.
	function wireData(data, opts, el, names) {
		var d = obj(data), out = {};
		for (var k in d) {
			if (!own(d, k) || k.charAt(0) === '_') continue;
			out[k] = d[k];
		}
		out._theme  = themeOf(el, names);
		out._labels = labelsFor(opts);
		return out;
	}


	// ── The skin's faces, carried into the frame ────────────────────
	//
	// The names in `_theme.font` are only names on the far side. The page is in an opaque
	// origin under `font-src data:`, so a face the app serves as a file (Daylight's
	// `fonts/*.woff2`) cannot be fetched from there, and before this the page set in the
	// system sans under a font stack that named Sofia Sans. Neither the sandbox nor the
	// policy moves for it. The parent reads the bytes it already serves, ONCE per load of
	// the app, and hands them over in `_theme.faces`; the few lines `FACE_PRELUDE` puts in
	// the page beside the policy register them with `FontFace` from the ArrayBuffer, which
	// fetches nothing and so asks nothing of `font-src`.
	//
	// It is the parent that puts those lines in, not the shipped page, because a page is the
	// Diamond's own once it is written: a change to `DEFAULT_PAGE` would reach no existing
	// Diamond, and a page a model rewrote would never learn it. Any page that dresses itself
	// from `_theme.font` gets the faces.
	//
	// Only a skin named in `FACE_SKINS` carries faces, and the prelude goes in only when the
	// page is mounted under one. Sharp and Warm are not named, so their pages go into the
	// frame byte for byte as they did before, and their `_theme` has no `faces` key.
	//
	// The faces are read from the skin's own `@font-face` rules, so the sheet stays their
	// one statement: a face changed there is the face carried here.

	/// The skins whose faces the frame is given, and the sheet that declares them.
	var FACE_SKINS = { daylight: /(^|\/)skin-daylight\.css(\?|#|$)/ };

	/// Per skin: `{ faces: null | [{ family, weight, style, data }], busy: Promise }`.
	var faceCache = {};

	/// Does this skin carry its faces into the frame?
	function faceSkin(skin) { return own(FACE_SKINS, skin); }

	/// The `@font-face` rules of a skin's sheet, as `{ family, weight, style, url }`.
	function faceRules(skin) {
		var want = FACE_SKINS[skin], out = [];
		var sheets = document.styleSheets || [];
		for (var i = 0; i < sheets.length; i++) {
			var sh = sheets[i];
			if (!sh.href || !want.test(sh.href)) continue;
			var rules;
			try { rules = sh.cssRules; } catch (e) { continue; }
			for (var j = 0; j < rules.length; j++) {
				var r = rules[j];
				if (typeof CSSFontFaceRule === 'undefined' || !(r instanceof CSSFontFaceRule)) continue;
				var fam = str(r.style.getPropertyValue('font-family')).trim()
					.replace(/^["']|["']$/g, '');
				var src = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(str(r.style.getPropertyValue('src')));
				if (!fam || !src) continue;
				var url;
				try { url = new URL(src[1], sh.href).href; } catch (e) { continue; }
				out.push({
					family: fam,
					weight: str(r.style.getPropertyValue('font-weight')).trim() || 'normal',
					style:  str(r.style.getPropertyValue('font-style')).trim() || 'normal',
					url:    url,
				});
			}
		}
		return out;
	}

	/// Start reading a skin's faces, once. A read that fails is forgotten, so the next
	/// mount tries again rather than the frame going without for the rest of the session.
	function loadFaces(skin) {
		if (!faceSkin(skin) || faceCache[skin]) return;
		var slot = faceCache[skin] = { faces: null, busy: null };
		var rules = faceRules(skin);
		slot.busy = Promise.all(rules.map(function (f) {
			return fetch(f.url).then(function (res) {
				if (!res.ok) throw new Error(f.url + ': ' + res.status);
				return res.arrayBuffer();
			}).then(function (buf) {
				return { family: f.family, weight: f.weight, style: f.style, data: buf };
			});
		})).then(function (faces) {
			if (!faces.length) throw new Error('no @font-face rules for ' + skin);
			slot.faces = faces;
			// The page was sent its theme without them; send it again, now with.
			if (live && !live.done && live.faces && currentSkin() === skin) sendData();
		}, function () {
			if (faceCache[skin] === slot) delete faceCache[skin];
		});
	}

	/// The faces read for `skin` whose family `stack` names, or null when there are none
	/// (a skin without faces, or faces not read yet).
	function facesNamed(skin, stack) {
		var slot = faceSkin(skin) ? faceCache[skin] : null;
		if (!slot || !slot.faces) return null;
		var names = str(stack).toLowerCase(), out = [];
		for (var i = 0; i < slot.faces.length; i++) {
			var f = slot.faces[i];
			if (names.indexOf(f.family.toLowerCase()) >= 0) out.push(f);
		}
		return out.length ? out : null;
	}

	function currentSkin() {
		return document.documentElement.getAttribute('data-skin') || 'sharp';
	}

	/// What the parent puts in a page mounted under a face skin, right after the policy
	/// (`armour` puts both first in the document). It listens for the `data` reply before the
	/// page's own script does, and registers each face once. A policy the page declares for
	/// itself comes later in the document and governs only what follows it, so it cannot block
	/// this. A page that never asks for its data gets no faces and sets in the system sans as
	/// before: nothing breaks, it only goes without.
	var FACE_PRELUDE = '<script>(function(){var got={};'
		+ 'addEventListener("message",function(e){if(e.source!==parent)return;'
		+ 'var m=e.data;if(!m||m.dc!==1||m.v!==1||m.cmd!=="data")return;'
		+ 'var t=m.data&&m.data._theme,f=t&&t.faces;'
		+ 'if(!f||!f.length||!window.FontFace||!document.fonts)return;'
		+ 'for(var i=0;i<f.length;i++){var x=f[i]||{},k=x.family+"|"+x.weight+"|"+x.style;'
		+ 'if(got[k]||!x.data)continue;got[k]=1;'
		+ 'try{var ff=new FontFace(x.family,x.data,{weight:x.weight,style:x.style});'
		+ 'document.fonts.add(ff);ff.loaded.catch(function(){});}catch(_){}}});})();<\/script>';


	// ── The policy every page runs under ────────────────────────────
	//
	// THE SANDBOX STOPS THE PAGE READING OUR STORAGE. IT DOES NOT STOP IT SENDING.
	// An opaque origin still has `fetch`, still has an `img` it can point at a
	// server, and the page is handed the whole crystal by design. So the isolation
	// that makes the frame safe to run says nothing at all about the frame walking
	// the memory out.
	//
	// That matters more here than anywhere else in the app, because of who wrote
	// the page: a model that may itself have been steered by a web page it read a
	// moment ago. A line it was talked into leaving behind is absent from the
	// standing context, unseen by the reducer and unseen by the fold diff — and it
	// syncs to every device. (This list used to open with "exempt from the cap",
	// which stopped being true on 2026-08-09 when the page got a ceiling of its
	// own. Dropping it costs the argument nothing: what makes a line durable is
	// that nothing READS the page, not that nothing weighs it.) `ask()` was
	// dropped from the verb
	// list over exactly that shape, so leaving the same hole open in the transport
	// would be inconsistent. The daimon can exfiltrate too, but only through the
	// egress gate, where a person sees it and says yes once; a page would do it
	// silently, on every render, for ever, with no gate involved. That difference
	// is the entire reason there is a gate.
	//
	// THE POLICY IS NOT A RESTRICTION ADDED ON TOP. It is the page the design
	// already asks for, written down: self-contained, CSS and JS inlined, images as
	// data URIs, nothing that refers outside itself. A page that breaks under it is
	// a page that was already breaking the rule it was built to.
	//
	// It is injected into every page, including one that carries a policy of its
	// own, because the browser enforces every policy on a document at once and the
	// effective one is their intersection — so ours can only tighten, never loosen,
	// whatever the author wrote.
	//
	// WHERE IT GOES IS THE PART TO GET RIGHT. Never before the doctype: a `<meta>`
	// ahead of `<!doctype html>` puts the document in quirks mode, which would
	// change how every authored page lays out and would be a rendering bug we
	// caused. First child of `<head>` where there is one; failing that after the
	// `<html>` tag, where the parser opens a head and puts it there; failing that
	// after a leading doctype; and only with neither, at the very start.
	//
	// Going in first also pushes a page's own `<meta charset>` a hundred-odd bytes
	// further down, and an encoding declaration only counts inside the first 1024.
	// That is why `PAGE_TYPE` below states the encoding on the resource itself,
	// where it outranks any meta: the blob is built from a JavaScript string, so it
	// IS UTF-8 whatever the page believes, and saying so removes the question
	// rather than leaving it to a byte count.

	// `data:` for pictures and typefaces, and no host anywhere. The policy is not a
	// restriction laid on top of the design -- it IS the design: a self-contained page
	// with its CSS, its script and its assets inlined, referring to nothing outside
	// itself. A data URI cannot make a network request, so admitting one costs nothing
	// the rest of the policy is buying; leaving `font-src` out would have banned an
	// inlined typeface while allowing an inlined picture, which is an accident rather
	// than a rule.
	var PAGE_CSP = 'default-src \'none\'; script-src \'unsafe-inline\'; '
		+ 'style-src \'unsafe-inline\'; img-src data:; font-src data:';

	var PAGE_TYPE = 'text/html;charset=utf-8';

	var CSP_META = '<meta http-equiv="Content-Security-Policy" content="' + PAGE_CSP + '">';

	/// Whether a page already declares a policy of its own. Only reported, never
	/// acted on: ours goes in either way and the two intersect.
	var CSP_HAS = /<meta[^>]+http-equiv\s*=\s*["']?\s*content-security-policy/i;

	/// A page with the policy in it, and where it had to go. `extra` follows the policy
	/// at the same place: the face prelude, under a skin that carries faces, else ''.
	function armour(html, extra) {
		var s = String(html);
		var add = CSP_META + timeTag() + (extra || '');
		var carried = CSP_HAS.test(s);
		// After the leading whitespace, comments and doctype, which are all a document may hold before its
		// first element, and nowhere else: never after a `<head>` or `<html>` found by searching, since a
		// comment or a script string can hold either and would swallow the policy and the shim with it.
		// A `<meta>` there is read in the parser's "before html" mode, which makes the head, and the page's
		// own `<html>` and `<head>` tags then merge into it or are ignored; the doctype is still first,
		// so standards mode is kept. The tail is all optional, so the match never backtracks.
		var m = /^(?:\s*<!--[\s\S]*?-->)*\s*(<!doctype\b[^>]*>)?/i.exec(s);
		return insertCsp(s, m[0].length, m[1] ? 'doctype' : 'start', carried, add);
	}

	/// The app's clock for the page, on the account's calendar (D-20261006-34): a page draws a
	/// date the way the app does, and never needs the browser's own Gregorian date picker. It
	/// goes in with the policy, so every page has it, and is dropped if it could close the tag.
	function timeTag() {
		var T = window.DaimondTime, tag = '';
		try { tag = T && typeof T.frameTag === 'function' ? String(T.frameTag()) : ''; } catch (e) { tag = ''; }
		var body = tag.replace(/^<script>/, '').replace(/<\/script>$/, '');
		return /<\/script|<!--/i.test(body) ? '' : tag;
	}

	function insertCsp(s, at, where, carried, add) {
		return {
			html:     s.slice(0, at) + add + s.slice(at),
			injected: true,
			carried:  carried,
			at:       where,
		};
	}


	/// A sandboxed frame for a page, under the policy, with its blob URL. The ONE place a crystal
	/// frame is made: the on-screen view and the off-screen render both come here, so they cannot
	/// differ in what the page may do.
	function makeFrame(page, extra, cls, title) {
		var frame = document.createElement('iframe');
		frame.className = cls;
		// `allow-scripts` and NOTHING else, ever. See the head of this file.
		frame.setAttribute('sandbox', 'allow-scripts');
		frame.setAttribute('referrerpolicy', 'no-referrer');
		frame.setAttribute('title', title);
		var armed = armour(page, extra);
		var url = URL.createObjectURL(new Blob([armed.html], { type: PAGE_TYPE }));
		frame.src = url;
		return { frame: frame, armed: armed, url: url };
	}


	// ── The probe: measuring a page from inside its frame ───────────
	//
	// THE THREAT, WRITTEN DOWN. (1) The shim is a way for the page's DOM to talk to the
	// parent, so it must not widen the sandbox: it adds no flag, no origin and no network,
	// reads only `document` and `getComputedStyle` of the frame it runs in, and posts only
	// the measurement and the PNG bytes. The off-screen frame is made by `makeFrame`, the
	// one function that sets `sandbox`, and is handed only what the visible frame is: the
	// Diamond's own crystal, the theme and the labels. It is read-only (`save` and `open`
	// from it are let go) and it is removed on every path out, so a page that hangs costs
	// a hidden frame for a bounded time and nothing else. (2) The page is hostile by assumption -- it may
	// post `probed` without the shim, or lie in it -- so the parent never believes the
	// shape of a reply: numbers must be numbers, strings are cut to printable ASCII and a
	// cap, row and column counts are fixed here, the table text is built HERE, and a reply
	// is read only while a probe is outstanding, only with its id, and only with the nonce
	// the host wrote into the shim it armoured in. The nonce is in the shim's closure and
	// travels only from the shim to the host, never in the `probe` message the page can read;
	// the shim takes its own tag out of the document and keeps `parent` as it was at the
	// start, so the page can neither read the nonce nor redirect the reply to a spy. It proves
	// who answered, not that the bytes are honest: the rasteriser runs in the page's realm, so
	// a picture is believed only once it DECODES at the size claimed (`probeSight`). (3) A page can put
	// words in its own class names, which is words a daimon will read; that is no new
	// channel, since the daimon already reads the page's source with `file_read`, but the
	// class text is cut and its tokens joined with dots so it does not read as a sentence.
	// The CSS-value columns hold only values their property could (`pv`) and the error
	// lines are the host's own words (`pngWhy`), because the table is read as the tool's
	// measurement and not as the page's text.
	// (4) A picture is a PNG signature, base64, under a cap, or it is dropped.

	/// The most rows a probe returns, and the longest it waits for a picture.
	var PROBE_ROWS = 12;
	var PROBE_OUTLINE_ROWS = 24;
	var PROBE_PNG_MS = 28000;
	/// A picture over this is not passed on: `file_read` shows an image only up to 2 MB.
	var PROBE_PNG_MAX = 2 * 1024 * 1024;
	var PROBE_SEL_MAX = 300;
	/// crystal_look: the most targets, the longest one, and the matches shown for each.
	var LOOK_MAX = 8;
	var LOOK_CHARS = 120;
	var LOOK_ROWS = 4;
	/// The canvas limits `selfshot.js` draws within: a side, and the pixels in all.
	var PROBE_PX_SIDE = 16384;
	var PROBE_PX_MAX = 64e6;

	var probeSeq = 0;

	/// The script that goes into every page. It is a function written out in full and
	/// handed over as text, because the frame can import nothing: `win` is the frame's own
	/// window, and `mk` is the app's rasteriser (`selfshot.js`) or `null`, so a picture
	/// is drawn by the very code the app uses on itself.
	function shim(win, mk, nonce) {
		var doc = win.document, up = win.parent, ROWS = 12, OUT_ROWS = 24, raster = null;
		// Out of the document before any page script can read the nonce from it.
		try { var me = doc.currentScript; if (me && me.parentNode) me.parentNode.removeChild(me); } catch (e) { /* no tag to remove */ }
		function s(v, n) { v = v == null ? '' : String(v); return v.length > n ? v.slice(0, n) : v; }
		// K3: the page's console, its uncaught errors and the verbs it is sent, kept as they happen
		// (the shim runs ahead of the page) so a probe can say why a page showed what it did.
		var ring = [], TRACE_N = 40, TRACE_W = 200;
		function note(k, v) {
			ring.push(s(k + ': ' + v, TRACE_W));
			if (ring.length > TRACE_N) ring.shift();
		}
		function said(a) {
			var o = [], i;
			for (i = 0; i < a.length && i < 6; i++) {
				var x = a[i];
				try { o.push(typeof x === 'string' ? x : (x && x.message) ? String(x.message) : JSON.stringify(x)); }
				catch (e) { o.push(String(x)); }
			}
			return o.join(' ');
		}
		try {
			var con = win.console;
			if (con) ['log', 'info', 'warn', 'error', 'debug'].forEach(function (k) {
				var was = con[k];
				if (typeof was !== 'function') return;
				con[k] = function () { note('console.' + k, said(arguments)); return was.apply(con, arguments); };
			});
		} catch (e) { /* a console that cannot be wrapped */ }
		win.addEventListener('error', function (e) {
			note('error', s(e && e.message, TRACE_W) + (e && e.lineno ? ' (line ' + e.lineno + ')' : ''));
		});
		win.addEventListener('unhandledrejection', function (e) {
			var r = e && e.reason;
			note('unhandled rejection', r && r.message ? r.message : said([r]));
		});
		// The load proof's facts: what the reader can see, read as text, and what the page draws.
		function facts() {
			var b = doc.body || {}, text = s(b.innerText != null ? b.innerText : b.textContent, 200000);
			function n(sel) { try { return doc.querySelectorAll(sel).length; } catch (e) { return 0; } }
			return {
				text: text, svg: n('svg'), canvas: n('canvas'), img: n('img'),
				bar: n('[class*=bar],[class*=chart]'), pre: n('pre'), dbg: n('#dbg'),
				keymap: /KEYMAP/.test(text) ? 1 : 0, dkeys: /DKEYS/.test(text) ? 1 : 0,
			};
		}
		function r1(v) { v = Number(v); return isFinite(v) ? Math.round(v * 10) / 10 : null; }
		function who(e) {
			return { tag: s(String(e.tagName).toLowerCase(), 24), id: s(e.id, 80),
				cls: s(e.getAttribute ? e.getAttribute('class') : '', 160) };
		}
		function box(e) {
			var b = e.getBoundingClientRect();
			return { x: r1(b.x != null ? b.x : b.left), y: r1(b.y != null ? b.y : b.top), w: r1(b.width), h: r1(b.height) };
		}
		function row(e, outline) {
			var o = who(e), b = box(e), c = win.getComputedStyle(e), p = e.parentElement;
			o.x = b.x; o.y = b.y; o.w = b.w; o.h = b.h;
			o.display = s(c.display, 24);
			o.box = s(c.boxSizing, 16);
			o.width = s(c.width, 24);
			o.height = s(c.height, 24);
			o.aspect = s(c.aspectRatio, 24);
			o.padding = s(c.padding || [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].join(' '), 60);
			o.cols = s(c.gridTemplateColumns, 400);
			o.flex = /flex/.test(String(c.display)) ? s(c.flexDirection, 16) + ' ' + s(c.flexWrap, 12) : '';
			o.ox = Math.max(0, Math.round((e.scrollWidth || 0) - (e.clientWidth || 0)));
			o.oy = Math.max(0, Math.round((e.scrollHeight || 0) - (e.clientHeight || 0)));
			if (p && p.getBoundingClientRect && !outline) {
				var pc = win.getComputedStyle(p), q = who(p);
				q.w = box(p).w;
				q.display = s(pc.display, 24);
				q.cols = s(pc.gridTemplateColumns, 400);
				o.parent = q;
			}
			return o;
		}
		// With no selector, the page's main blocks: the body and what is inside it to three levels,
		// in document order, hidden things left out, the shallowest first when there are too many.
		function walk(root) {
			var all = [], SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, BR: 1, LINK: 1, META: 1 };
			(function down(e, d) {
				all.push({ e: e, d: d });
				if (d >= 3) return;
				var k = e.children || [], i;
				for (i = 0; i < k.length && all.length < 400; i++) {
					if (SKIP[k[i].tagName] || win.getComputedStyle(k[i]).display === 'none') continue;
					down(k[i], d + 1);
				}
			})(root, 0);
			return all;
		}
		// crystal_look: what a person sees of an element -- its box, its type, its padding and its
		// colours. A target is a selector, or `text:` and the words on the element, which finds
		// the innermost visible elements whose own text is those words (any case).
		function lrow(e) {
			var o = who(e), b = box(e), c = win.getComputedStyle(e);
			o.x = b.x; o.y = b.y; o.w = b.w; o.h = b.h;
			o.fs = s(c.fontSize, 24); o.lh = s(c.lineHeight, 24); o.fw = s(c.fontWeight, 8);
			o.pad = s(c.padding || [c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft].join(' '), 60);
			o.fg = s(c.color, 60); o.bg = s(c.backgroundColor, 60);
			o.bd = s(c.borderTopWidth, 16) + ' ' + s(c.borderTopColor, 60);
			o.box = s(c.boxSizing, 16);
			return o;
		}
		function shown(e) {
			var r = e.getBoundingClientRect();
			return r.width > 0 && r.height > 0 && win.getComputedStyle(e).visibility !== 'hidden';
		}
		function byText(words) {
			var want = words.replace(/\s+/g, ' ').trim().toLowerCase(), hit = [];
			if (!want) return hit;
			var all = doc.body ? doc.body.querySelectorAll('*') : [], i;
			for (i = 0; i < all.length && i < 20000; i++) {
				var e = all[i];
				if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(e.tagName)) continue;
				var t = String(e.innerText != null ? e.innerText : e.textContent).replace(/\s+/g, ' ').trim().toLowerCase();
				if (t === want && shown(e)) hit.push(e);
			}
			// The innermost: an element that holds another match is the match's wrapper.
			return hit.filter(function (e) { return !hit.some(function (f) { return f !== e && e.contains(f); }); });
		}
		function look(ts) {
			return ts.slice(0, 8).map(function (t) {
				t = s(t, 120);
				var o = { t: t, rows: [] }, list;
				try {
					list = /^text:/i.test(t) ? byText(t.slice(5))
						: Array.prototype.filter.call(doc.querySelectorAll(t), shown);
				} catch (err) { o.error = 1; return o; }
				o.count = list.length;
				for (var i = 0; i < list.length && i < 4; i++) o.rows.push(lrow(list[i]));
				return o;
			});
		}
		function post(o) {
			o.dc = 1; o.v = 1; o.cmd = 'probed';
			if (nonce) o.nonce = nonce;
			try { up.postMessage(o, '*'); } catch (e) { /* the parent went away */ }
		}
		function answer(m) {
			var out = { id: m.id }, sel = typeof m.sel === 'string' ? m.sel.slice(0, 300) : '', list, i;
			out.trace = ring.slice();
			if (Array.isArray(m.look) && m.look.length) {
				try { out.look = look(m.look); } catch (err) { out.look = []; }
			}
			if (m.proof === true) {
				try { out.facts = facts(); } catch (err) { out.facts = { error: s(err && err.message, 160) }; }
			}
			try {
				var depths = null;
				if (sel.replace(/\s/g, '')) list = doc.querySelectorAll(sel);
				else {
					var all = walk(doc.body), pick = all.map(function (x, k) { return { k: k, d: x.d }; })
						.sort(function (a, b) { return a.d - b.d || a.k - b.k; }).slice(0, OUT_ROWS)
						.sort(function (a, b) { return a.k - b.k; });
					list = pick.map(function (q) { return all[q.k].e; });
					depths = pick.map(function (q) { return q.d; });
					out.outline = true;
					out.count = all.length;
				}
				if (!out.outline) out.count = list.length;
				out.rows = [];
				for (i = 0; i < list.length && i < (depths ? OUT_ROWS : ROWS); i++) {
					out.rows.push(row(list[i], !!depths));
					if (depths) out.rows[i].depth = depths[i];
				}
				var de = doc.documentElement || {};
				out.view = { w: win.innerWidth, h: win.innerHeight, sw: de.scrollWidth, sh: de.scrollHeight };
			} catch (err) {
				out.error = s(err && err.message, 160);
				post(out);
				return;
			}
			if (m.png !== true || !list.length) { post(out); return; }
			try {
				if (!mk) throw new Error('the page has no rasteriser');
				raster = raster || mk();
				// The picture is the whole page (its body), whatever the table was asked about:
				// a tile's own picture would say nothing about how the tiles sit together.
				var t = doc.body;
				if (t.querySelectorAll('*').length > raster.MAX_NODES) {
					throw new Error('the page holds more than ' + raster.MAX_NODES + ' elements');
				}
				raster.rasterise(t, {
					max_w: m.max_w > 0 ? Math.min(Number(m.max_w), 4000) : 0,
					background: typeof m.background === 'string' ? m.background.slice(0, 64) : '',
				}).then(function (r) {
					out.png_b64 = r.b64; out.w = r.w; out.h = r.h;
					post(out);
				}, function (err) {
					out.png_error = s(err && err.message, 300);
					post(out);
				});
			} catch (err) {
				out.png_error = s(err && err.message, 300);
				post(out);
			}
		}
		// Fonts, then a beat for layout, so the page is measured as it settles and not as it
		// starts. Without a timer (a test's stand-in) it answers at once.
		function settle(go) {
			if (!win.setTimeout) { go(); return; }
			var fin = false;
			function run() { if (fin) return; fin = true; win.setTimeout(go, 60); }
			try {
				if (doc.fonts && doc.fonts.ready) { doc.fonts.ready.then(run, run); win.setTimeout(run, 2000); return; }
			} catch (err) { /* no font set to wait for */ }
			run();
		}
		win.addEventListener('message', function (e) {
			if (e.source !== up) return;
			var m = e.data;
			if (m && m.dc === 1 && typeof m.cmd === 'string' && m.cmd !== 'probe') note('host -> page', s(m.cmd, 24));
			if (!m || m.dc !== 1 || m.v !== 1 || m.cmd !== 'probe') return;
			settle(function () { answer(m); });
		});
	}

	/// The shim as a `<script>` for `armour`, with the app's rasteriser inside it when
	/// `selfshot.js` has loaded. The rasteriser text is dropped if it could close the tag.
	function probeShimTag(nonce) {
		var shot = window.DaimondShot;
		var mk = shot && typeof shot.rasteriserSource === 'string' ? shot.rasteriserSource : '';
		if (/<\/script|<!--/i.test(mk)) mk = '';
		return '<script>(' + shim.toString() + ')(window,' + (mk || 'null') + ',' + JSON.stringify(String(nonce)) + ');<\/script>';
	}

	/// A fresh secret for one render: 128 random bits as hex, or `''` where the browser has no
	/// random source (the render is then refused, never run without one).
	function newNonce() {
		var c = typeof crypto !== 'undefined' ? crypto : (window.crypto || null), a, out = '', i;
		if (!c || typeof c.getRandomValues !== 'function') return '';
		a = c.getRandomValues(new Uint8Array(16));
		for (i = 0; i < a.length; i++) out += (a[i] < 16 ? '0' : '') + a[i].toString(16);
		return out;
	}

	/// One line, printable ASCII, cut to `n`: the only shape a page's text is let into a table in.
	function pc(v, n) {
		v = (typeof v === 'string' || typeof v === 'number') ? String(v) : '';
		v = v.replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
		return v.length > n ? v.slice(0, n - 1) + '~' : v;
	}

	/// A number the page measured, to one decimal, or `?` when it is not a number it could have.
	function pn(v) { return (typeof v === 'number' && isFinite(v) && Math.abs(v) < 1e7) ? v.toFixed(1) : '?'; }
	function pi(v) { return (typeof v === 'number' && isFinite(v) && v >= 0 && v < 1e7) ? String(Math.round(v)) : '?'; }

	// What a computed style can hold, column by column. A value that is anything else is `?`: the CSS
	// properties printed in the table have no way to carry a sentence, so a sentence in one is the page
	// speaking, and the host does not repeat it. A grid line name is the one free word CSS allows, so it
	// is let through only as one short identifier.
	function kws(t) { var o = {}; t.split(' ').forEach(function (k) { o[k] = 1; }); return o; }
	var PV_DISPLAY = kws('block inline inline-block flex inline-flex grid inline-grid none contents flow flow-root '
		+ 'table inline-table table-row table-cell table-row-group table-header-group table-footer-group '
		+ 'table-column table-column-group table-caption list-item ruby run-in');
	var PV_BOX = kws('content-box border-box');
	var PV_SIZE = kws('auto none min-content max-content fit-content');
	var PV_TRACK = kws('auto none min-content max-content subgrid masonry');
	var PV_DIR = kws('row row-reverse column column-reverse');
	var PV_WRAP = kws('nowrap wrap wrap-reverse');
	var PV_LEN = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(px|%|em|rem|ex|ch|vw|vh|vmin|vmax|cm|mm|in|pt|pc|fr)?$/i;
	var PV_NAME = /^\[[A-Za-z0-9_-]{1,16}\]$/;
	var PV_COLOUR = /^(rgba?|hsla?|color|oklch|oklab|lab|lch)\([a-z0-9., \/%-]{1,80}\)$/;
	var PV_RATIO = /^(auto )?\d+(\.\d+)?( \/ \d+(\.\d+)?)?$/;

	/// A computed-style value of the named `kind`, or `?` when it is not a value that kind can have.
	function pv(v, kind) {
		var t = pc(v, 200), w = t.split(' '), ok = false;
		if (!t) return '?';
		switch (kind) {
			case 'display': ok = w.length <= 3 && w.every(function (x) { return PV_DISPLAY[x] === 1; }); break;
			case 'box':     ok = PV_BOX[t] === 1; break;
			case 'size':    ok = w.length === 1 && (PV_SIZE[t] === 1 || PV_LEN.test(t)); break;
			case 'aspect':  ok = t === 'auto' || PV_RATIO.test(t); break;
			case 'pad':     ok = w.length <= 4 && w.every(function (x) { return PV_LEN.test(x); }); break;
			case 'flex':    ok = w.length === 2 && PV_DIR[w[0]] === 1 && PV_WRAP[w[1]] === 1; break;
			case 'lh':      ok = w.length === 1 && (t === 'normal' || PV_LEN.test(t)); break;
			case 'weight':  ok = /^(normal|bold|lighter|bolder|[1-9]00|[1-9]\d{0,2}(\.\d+)?)$/.test(t); break;
			case 'colour':  ok = t === 'transparent' || PV_COLOUR.test(t); break;
			case 'tracks':
				ok = (t.match(/\[[^\]]*\]|\S+/g) || []).every(function (x) { return PV_TRACK[x] === 1 || PV_LEN.test(x) || PV_NAME.test(x); });
				break;
			default: break;
		}
		return ok ? t : '?';
	}

	/// What the host says of a picture the page could not draw, in its own words: the page's
	/// `png_error` is matched against the refusals the rasteriser is known to make and never quoted.
	function pngWhy(e) {
		var t = pc(e, 300), n = /\bmore than (\d{1,5}) elements/.exec(t);
		if (n) return 'the page holds more than ' + n[1] + ' elements, over what the rasteriser takes';
		if (/no rasteriser/i.test(t)) return 'the page has no rasteriser';
		if (/canvas|limit/i.test(t)) return 'the picture would be larger than the browser can draw; pass a smaller "max_w"';
		if (/did not rasterise/i.test(t)) return 'the page did not draw within 20 s';
		if (/taint|cross-origin/i.test(t)) return 'the page holds a cross-origin picture or background, which the browser will not read out';
		if (/could not be rasterised/i.test(t)) return 'the page could not be rasterised; an embedded resource may be cross-origin, or its markup one the serialiser rejects';
		return 'the page could not be drawn as a picture';
	}

	/// `tag#id.class.class`, each part cut to a name's characters and the class tokens
	/// joined with dots, so a sentence in a class attribute does not read as one.
	function pname(o, n) {
		o = obj(o);
		var cls = pc(o.cls, 160).split(' ').filter(Boolean).map(function (c) { return pword(c, 40); }).join('.');
		var out = pword(String(o.tag || '').toLowerCase(), 24) + (o.id ? '#' + pword(o.id, 40) : '') + (cls ? '.' + cls : '');
		return out.length > n ? out.slice(0, n - 1) + '~' : (out || '?');
	}

	/// A page's word cut to the characters a name has, so it is a name in the table and nothing else.
	function pword(v, k) { return pc(v, k).replace(/[^A-Za-z0-9_\-:.\/%#@\[\]]+/g, '_'); }

	/// The distinct values of `vs` within `tol` of an earlier one, in order of first sight, and
	/// each value's place among them. The first of a cluster is its anchor, so a run of
	/// values creeping apart does not chain into one.
	function pclust(vs, tol) {
		var an = [], at = vs.map(function (v) {
			for (var k = 0; k < an.length; k++) if (Math.abs(v - an[k]) <= tol) return k;
			an.push(v);
			return an.length - 1;
		});
		return { an: an, at: at };
	}

	/// The anchors of `c` as labels: whole pixels, or a decimal on the axis where two would read alike.
	function plabels(c) {
		var r = c.an.map(function (v) { return String(Math.round(v)); });
		var alike = r.some(function (x, k) { return r.indexOf(x) !== k; });
		return alike ? c.an.map(function (v) { return v.toFixed(1); }) : r;
	}

	/// The one line that says what the numbers of a selector table add up to, so a daimon does
	/// no sums: how many sizes the matches come in (and how many of each), how tall the rows
	/// are down the page and what sets the tallest, and whether the widths differ by a column
	/// span. `raw` is the rows shown and `count` the matches in all. Built from numbers the
	/// host has checked and a class or id only as a name; `''` when no row has a size.
	function probeVerdict(raw, count) {
		var good = function (n) { return typeof n === 'number' && isFinite(n) && Math.abs(n) < 1e7; };
		var rs = [], i, k;
		for (i = 0; i < raw.length; i++) {
			var r = obj(raw[i]);
			if (good(r.x) && good(r.y) && good(r.w) && good(r.h) && r.w >= 0 && r.h >= 0) rs.push({ i: i, x: r.x, y: r.y, w: r.w, h: r.h, r: r });
		}
		if (!rs.length) return '';
		// Sizes: width and height are clustered apart, so 119.328 and 119.344 are one width and 80 and 84 are two heights.
		var cw = pclust(rs.map(function (b) { return b.w; }), 0.5), ch = pclust(rs.map(function (b) { return b.h; }), 0.5);
		var lw = plabels(cw), lh = plabels(ch), by = {}, sz = [];
		rs.forEach(function (b, j) {
			var key = cw.at[j] + ',' + ch.at[j];
			if (!by[key]) { by[key] = { n: 0, first: j, w: cw.at[j], h: ch.at[j] }; sz.push(by[key]); }
			by[key].n++;
		});
		sz.sort(function (a, b) { return b.n - a.n || a.first - b.first; });
		var shown = sz.slice(0, 4).map(function (s) {
			var none = cw.an[s.w] === 0 && ch.an[s.h] === 0;
			return lw[s.w] + 'x' + lh[s.h] + ' x' + s.n + (none ? ' (not drawn)' : '');
		});
		if (sz.length > 4) shown.push('+' + (sz.length - 4) + ' more');
		var parts = [sz.length + ' size' + (sz.length === 1 ? '' : 's') + ': ' + shown.join(', ')];
		// Rows: boxes whose tops agree to a pixel are one row. A row is as tall as its tallest box that
		// does not run on into the next row, so a box that spans two rows is not taken for the height of its first.
		var drawn = rs.filter(function (b) { return !(b.w === 0 && b.h === 0); });
		var sorted = drawn.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; });
		var bands = [];
		sorted.forEach(function (b) {
			var last = bands[bands.length - 1];
			if (last && b.y - last.y <= 1) last.bs.push(b); else bands.push({ y: b.y, bs: [b] });
		});
		bands.forEach(function (bd, j) {
			var nx = j + 1 < bands.length ? bands[j + 1].y : null;
			var fit = nx === null ? bd.bs : bd.bs.filter(function (b) { return b.y + b.h <= nx + 1; });
			var hs = (fit.length ? fit : bd.bs).map(function (b) { return b.h; });
			bd.h = fit.length || nx === null ? Math.max.apply(null, hs) : Math.min.apply(null, hs);
		});
		if (bands.length) {
			var hc = pclust(bands.map(function (bd) { return bd.h; }), 0.5), hl = plabels(hc);
			var top = Math.max.apply(null, bands.map(function (bd) { return bd.h; }));
			parts.push(bands.length === 1 ? '1 row of ' + hl[0]
				: hc.an.length === 1 ? 'all ' + bands.length + ' rows ' + hl[0] : 'rows ' + hl.join(' / '));
			// What sets the tallest: the class the tallest box has and the first shorter one has not, else its id, else its row.
			var short = null, tall = null;
			drawn.forEach(function (b) {
				if (!short && b.h < top - 0.5) short = b;
				if (!tall && Math.abs(b.h - top) <= 0.5) tall = b;
			});
			if (short && tall) {
				var have = pc(short.r.cls, 160).split(' ');
				var diff = pc(tall.r.cls, 160).split(' ').filter(function (c) { return c && have.indexOf(c) < 0; });
				var who = diff.length ? '.' + diff.map(function (c) { return pword(c, 40); }).join('.')
					: tall.r.id ? '#' + pword(tall.r.id, 40) : 'row ' + (tall.i + 1);
				parts[parts.length - 1] += ' (set by ' + (who.length > 60 ? who.slice(0, 59) + '~' : who) + ')';
			}
		}
		// Columns: in a grid, a wider box is k columns when its width is k of the narrowest and the k - 1 gaps between them.
		var grid = drawn.length > 0 && drawn.every(function (b) {
			var d = obj(b.r.parent).display;
			return /grid/.test(pv(d, 'display'));
		});
		if (grid && cw.an.length > 1) {
			var gaps = [];
			bands.forEach(function (bd) {
				var row = bd.bs.slice().sort(function (a, b) { return a.x - b.x; });
				for (k = 1; k < row.length; k++) {
					var g = row[k].x - (row[k - 1].x + row[k - 1].w);
					if (g > 0) gaps.push(g);
				}
			});
			if (gaps.length) {
				gaps.sort(function (a, b) { return a - b; });
				var gap = gaps.length % 2 ? gaps[(gaps.length - 1) / 2] : (gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2;
				var narrow = Math.min.apply(null, cw.an.filter(function (v) { return v > 0; })), ks = [], all = true;
				cw.an.forEach(function (v) {
					if (v <= narrow + 0.5) return;
					var hit = 0;
					for (var n = 2; n <= 24 && !hit; n++) if (Math.abs(v - (n * (narrow + gap) - gap)) <= 1.5) hit = n;
					if (hit) { if (ks.indexOf(hit) < 0) ks.push(hit); } else all = false;
				});
				if (all && ks.length) parts.push('widths differ by column span (' + ks.sort(function (a, b) { return a - b; }).map(function (n) { return 'x' + n; }).join(', ') + ')');
			}
		}
		var cut = count > raw.length ? ' (first ' + raw.length + ' of ' + count + ')' : '';
		var line = 'verdict' + cut + ': ' + parts.join('; ');
		return line.length > 230 ? line.slice(0, 229) + '~' : line;
	}

	/// A grid's tracks, with a run of identical ones counted: `204px 204px 204px` is `204px x3`.
	function ptracks(v) {
		if (!pc(v, 600)) return '';
		var t = pv(v, 'tracks') === '?' ? ['?'] : pc(v, 600).split(' '), out = [], i = 0, j;
		while (i < t.length) {
			j = i;
			while (j + 1 < t.length && t[j + 1] === t[i]) j++;
			out.push(j > i ? t[i] + ' x' + (j - i + 1) : t[i]);
			i = j + 1;
		}
		var s = out.join(' ');
		return s.length > 100 ? s.slice(0, 99) + '~' : s;
	}

	/// The text a daimon reads for a probe reply `m` to the selector `sel`. Pure, and
	/// total: whatever `m` is, the result is at most `PROBE_ROWS + 3` lines of printable
	/// ASCII, built here and not taken from the page.
	function probeTable(m, sel) {
		m = obj(m);
		var outline = m.outline === true;
		var raw = arr(m.rows).slice(0, outline ? PROBE_OUTLINE_ROWS : PROBE_ROWS);
		var count = (typeof m.count === 'number' && isFinite(m.count) && m.count >= 0)
			? Math.min(Math.floor(m.count), 1000000) : raw.length;
		var v = obj(m.view);
		var size = '(frame ' + pi(v.w) + 'x' + pi(v.h) + ', page ' + pi(v.sw) + 'x' + pi(v.sh) + ')';
		var head = outline
			? 'outline of the crystal page ' + size + ': the body and its blocks to three levels, ' + raw.length + ' of ' + count + ' shown.'
			: 'probe ' + (pc(sel, 60) ? "'" + pc(sel, 60) + "'" : '(the page body)') + ' in the crystal page ' + size
				+ ': ' + count + ' match' + (count === 1 ? '' : 'es') + ', ' + raw.length + ' shown.';
		var cols = ['#', 'element', 'x', 'y', 'w', 'h', 'display', 'box', 'css-w', 'css-h', 'aspect', 'padding', 'cols', 'notes'];
		if (!outline) cols.push('parent');
		var rows = [cols];
		for (var i = 0; i < raw.length; i++) {
			var r = obj(raw[i]), p = r.parent && typeof r.parent === 'object' ? r.parent : null;
			var own = ptracks(r.cols), disp = pv(r.display, 'display');
			var flex = /flex/.test(disp) ? ' ' + pv(r.flex, 'flex') : '';
			var depth = outline && typeof r.depth === 'number' && r.depth >= 0 && r.depth <= 3 ? Math.floor(r.depth) : 0;
			// What is wrong with the box, in the fewest words: its own content spills out of it, or the
			// box runs past the right edge of the frame (a page wider than the screen).
			var notes = [];
			if (typeof r.ox === 'number' && r.ox > 1 && r.ox < 1e7) notes.push('over-x+' + Math.round(r.ox));
			if (typeof r.oy === 'number' && r.oy > 1 && r.oy < 1e7) notes.push('over-y+' + Math.round(r.oy));
			if (typeof r.x === 'number' && typeof r.w === 'number' && typeof v.w === 'number' && r.x + r.w > v.w + 1) {
				notes.push('off-right+' + Math.round(r.x + r.w - v.w));
			}
			var cells = [String(i + 1), '  '.repeat(depth) + pname(r, 80), pn(r.x), pn(r.y), pn(r.w), pn(r.h),
				disp + flex, pv(r.box, 'box'), pv(r.width, 'size'), pv(r.height, 'size'),
				pv(r.aspect, 'aspect'), pv(r.padding, 'pad'), (own && own !== 'none') ? own : '-', notes.join(' ') || '-'];
			if (!outline) {
				var pd = p ? pv(p.display, 'display') : '';
				cells.push(p ? pname(p, 40) + ' w=' + pn(p.w) + ' ' + pd + (/grid/.test(pd) ? ' cols=' + (ptracks(p.cols) || '?') : '') : '-');
			}
			rows.push(cells);
		}
		var wide = cols.map(function (_, k) { return Math.max.apply(null, rows.map(function (x) { return x[k].length; })); });
		var lines = rows.map(function (x) {
			return x.map(function (c, k) { return k === x.length - 1 ? c : c + ' '.repeat(wide[k] - c.length); }).join('  ').replace(/\s+$/, '');
		});
		var verdict = outline ? '' : probeVerdict(raw, count);
		return [head].concat(verdict ? [verdict] : [], lines).join('\n');
	}

	/// The picture in a reply, if it is one: base64 of a PNG, under the cap. Else `''`.
	function probePng(m) {
		var b = obj(m).png_b64;
		if (typeof b !== 'string' || b.length < 16 || b.length % 4 !== 0) return '';
		if (b.length > Math.ceil(PROBE_PNG_MAX * 4 / 3)) return '';
		if (b.slice(0, 11) !== 'iVBORw0KGgo') return '';
		return /^[A-Za-z0-9+\/]+={0,2}$/.test(b) ? b : '';
	}

	/// The width and height a PNG's header states, or `null` when the bytes do not open with a
	/// signature and an IHDR chunk. Reads 24 bytes; decodes nothing.
	function pngHead(b64) {
		if (typeof b64 !== 'string' || b64.length < 32 || typeof atob !== 'function') return null;
		var t;
		try { t = atob(b64.slice(0, 32)); } catch (e) { return null; }
		var u = function (k) {
			return ((t.charCodeAt(k) << 24) | (t.charCodeAt(k + 1) << 16) | (t.charCodeAt(k + 2) << 8) | t.charCodeAt(k + 3)) >>> 0;
		};
		if (t.length < 24 || u(8) !== 13 || t.slice(12, 16) !== 'IHDR') return null;
		return { w: u(16), h: u(20) };
	}

	/// A probe result whose picture has been made to PROVE itself: the header names the size the
	/// reply claimed, within the canvas limits, and the browser decodes it to that size. A picture
	/// that fails is dropped, with the host's own words in the table, so junk never reaches the
	/// daimon's model (a provider refuses it, and the model would be written off as blind).
	/// Resolves `r` itself, changed in place.
	/// crystal_look's measurement, built HERE from the shim's reply: for each target the model named,
	/// in its order, the matches' box, type, padding and colours, each value one its property could
	/// hold. `looks` is the targets as the host sent them, so a target's name is never the page's.
	function lookTable(m, looks) {
		var got = arr(m.look), v = obj(m.view), out = [];
		out.push('look at the crystal page (frame ' + pi(v.w) + 'x' + pi(v.h) + ', page ' + pi(v.sw) + 'x' + pi(v.sh)
			+ '), as its owner sees it: ' + looks.length + ' target' + (looks.length === 1 ? '' : 's') + '.');
		var cols = ['target', '#', 'element', 'x', 'y', 'w', 'h', 'font-size', 'line-h', 'weight', 'box', 'padding', 'colour', 'background', 'border'];
		var rows = [cols];
		looks.forEach(function (t, k) {
			var g = obj(got[k]), raw = arr(g.rows).slice(0, LOOK_ROWS), name = pc(t, 40);
			var count = (typeof g.count === 'number' && isFinite(g.count) && g.count >= 0) ? Math.min(Math.floor(g.count), 1000000) : raw.length;
			if (g.error) { rows.push([name, '-', 'not a selector the page can run'].concat(cols.slice(3).map(function () { return ''; }))); return; }
			if (!raw.length) { rows.push([name, '-', 'nothing visible matches'].concat(cols.slice(3).map(function () { return ''; }))); return; }
			raw.forEach(function (r, i) {
				r = obj(r);
				var bd = pc(r.bd, 80).split(' '), bw = pv(bd[0], 'size'), bc = pv(bd.slice(1).join(' '), 'colour');
				rows.push([i === 0 ? name + (count > raw.length ? ' (' + raw.length + ' of ' + count + ')' : '') : '', String(i + 1),
					pname(r, 50), pn(r.x), pn(r.y), pn(r.w), pn(r.h), pv(r.fs, 'size'), pv(r.lh, 'lh'), pv(r.fw, 'weight'),
					pv(r.box, 'box'), pv(r.pad, 'pad'), pv(r.fg, 'colour'), pv(r.bg, 'colour'), bw + ' ' + bc]);
			});
		});
		var wide = cols.map(function (_, k) { return Math.max.apply(null, rows.map(function (x) { return String(x[k] || '').length; })); });
		rows.forEach(function (x) {
			out.push(x.map(function (c, k) { c = String(c || ''); return k === x.length - 1 ? c : c + ' '.repeat(wide[k] - c.length); }).join('  ').replace(/\s+$/, ''));
		});
		return out.join('\n');
	}

	function probeSight(r) {
		if (!r.png_b64) return Promise.resolve(r);
		function drop(why) {
			r.table += '\nNo picture: ' + why + '.';
			r.png_b64 = ''; r.w = 0; r.h = 0;
			return r;
		}
		var hd = pngHead(r.png_b64), bin, u, i;
		if (!hd || hd.w !== r.w || hd.h !== r.h || r.w < 1 || r.h < 1 || r.w > PROBE_PX_SIDE || r.h > PROBE_PX_SIDE
			|| r.w * r.h > PROBE_PX_MAX) {
			return Promise.resolve(drop('the page\'s picture did not have the header and size of a picture it could have drawn'));
		}
		var gone = function () { return drop('the page\'s picture did not decode, so it was not passed on'); };
		if (typeof createImageBitmap !== 'function' || typeof Blob !== 'function') {
			return Promise.resolve(drop('this browser cannot check the page\'s picture, so it was not passed on'));
		}
		try {
			bin = atob(r.png_b64); u = new Uint8Array(bin.length);
			for (i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
			return createImageBitmap(new Blob([u], { type: 'image/png' })).then(function (bm) {
				var same = !!bm && bm.width === r.w && bm.height === r.h;
				try { if (bm && bm.close) bm.close(); } catch (e) { /* nothing to free */ }
				return same ? r : gone();
			}, gone);
		} catch (e) {
			return Promise.resolve(gone());
		}
	}

	/// A probe's reply as the daimon gets it: `{ err }` in the daimon's words, or
	/// `{ table, png_b64, w, h }`. Pure: the page's reply `m` is believed in nothing.
	function probeResult(m, sel, wantPng, looks) {
		m = obj(m);
		looks = arr(looks);
		if (typeof m.error === 'string' && m.error) {
			// The page's own words are not repeated: it is not a selector the page can run, or the page could not be measured with it.
			return { err: 'The crystal page refused the selector ' + JSON.stringify(pc(sel, 60)) + ': it is not a selector the page can run, '
				+ 'or the page could not be measured with it. Try a simpler one, or leave the selector out for an outline.' };
		}
		if (arr(m.rows).length === 0) {
			return { err: 'Nothing in the crystal page matches the selector ' + JSON.stringify(pc(sel, 60))
				+ '. This measures the Diamond\'s own page, not the app. Leave the selector out to list its body and the '
				+ 'body\'s children, or name an element the page has.' };
		}
		var table = looks.length ? lookTable(m, looks) : probeTable(m, sel), b64 = wantPng ? probePng(m) : '';
		if (wantPng && !b64) {
			table += '\nNo picture: ' + (typeof m.png_error === 'string' && m.png_error ? pngWhy(m.png_error)
				: (typeof m.png_b64 === 'string' && m.png_b64 ? 'the page returned something that is not a picture' : 'the page returned none')) + '.';
		}
		var w = Number(m.w), h = Number(m.h);
		return { table: table, png_b64: b64, w: b64 && w > 0 && w <= 16384 ? Math.floor(w) : 0, h: b64 && h > 0 && h <= 16384 ? Math.floor(h) : 0 };
	}

	// ── The load proof (K1, K3) ─────────────────────────────────────
	//
	// D-20261008-08: a daimon's Ontheism infographic drew an empty card, a JSON dump and a key map
	// for two turns, and the daimon said it was done, because its probe measured boxes and never
	// whether the reader could see the crystal. The proof reads the page as the owner does -- its
	// visible text and what it draws -- and the verdict is the host's, from the crystal it holds;
	// the page's reply supplies only facts, and a page that lies about them lies about itself.

	/// Text reduced to the words a reader sees: markdown marks and links dropped, case and
	/// punctuation folded, so `**Part 3** -- Fire` in the data matches `PART 3 - FIRE` on screen.
	function plainWords(v) {
		return str(v).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
	}

	/// A JSON member on screen: a quoted key, a colon, and the start of a value.
	var JSON_RUN = /"[A-Za-z_][\w-]*"\s*:\s*["\[{0-9tfn]/;
	var SUMMARY_PREFIX = 40;

	/// The verdict on what the page showed: `{ proof: 'pass' | 'FAIL: <reasons>', debug }`, where
	/// `debug` counts the debug nodes left on screen (`#dbg`, `<pre>`, KEYMAP, DKEYS) for the
	/// turn's end to compare with the last version that passed. `gmin` is the fewest graphics
	/// the ask wants (an infographic's), 0 when it names none.
	function proofVerdict(facts, data, gmin) {
		var f = obj(facts), d = obj(data), why = [], i;
		var num = function (v) { v = Number(v); return isFinite(v) && v > 0 ? Math.min(Math.floor(v), 100000) : 0; };
		var debug = num(f.dbg) + num(f.pre) + num(f.keymap) + num(f.dkeys);
		if (typeof f.text !== 'string') {
			return { proof: 'FAIL: the page could not be read as text', debug: debug };
		}
		var seen = ' ' + plainWords(f.text) + ' ';
		function shows(v) { var w = plainWords(v); return !w || seen.indexOf(' ' + w + ' ') >= 0; }
		if (str(d.title).trim() && !shows(d.title)) why.push('the title ' + JSON.stringify(pc(d.title, 60)) + ' is not on screen');
		var sum = plainWords(d.summary).slice(0, SUMMARY_PREFIX).replace(/\s\S*$/, '');
		if (sum && seen.indexOf(sum) < 0) why.push('the summary is not on screen');
		var missing = [], secs = arr(d.sections);
		for (i = 0; i < secs.length; i++) {
			var h = obj(secs[i]).heading;
			if (str(h).trim() && !shows(h)) missing.push(JSON.stringify(pc(h, 40)));
		}
		if (missing.length) {
			why.push((missing.length === 1 ? 'the section ' : missing.length + ' sections are missing: ')
				+ missing.slice(0, 6).join(', ') + (missing.length > 6 ? ' and ' + (missing.length - 6) + ' more' : '')
				+ (missing.length === 1 ? ' is not on screen' : ''));
		}
		if (JSON_RUN.test(f.text) || /\{"/.test(f.text)) why.push('raw JSON is on screen');
		if (num(f.dbg)) why.push('a #dbg debug panel is on screen');
		if (num(f.keymap) || num(f.dkeys)) why.push('a KEYMAP or DKEYS debug dump is on screen');
		var g = num(f.svg) + num(f.canvas) + num(f.img) + num(f.bar), want = num(gmin);
		if (want && g < want) why.push('the ask is an infographic and the page draws ' + g + ' graphic' + (g === 1 ? '' : 's')
			+ ' (svg, canvas, img, bar or chart), fewer than ' + want);
		if (!seen.trim() && !g) why.push('the page shows nothing');
		return { proof: why.length ? 'FAIL: ' + why.join('; ') : 'pass', debug: debug };
	}

	/// The keys of `data` with content that a page's `rendered` list leaves out.
	function undrawn(data, keys) {
		var want = contentKeys(data), out = [], i;
		for (i = 0; i < want.length; i++) if (arr(keys).indexOf(want[i]) < 0) out.push(want[i]);
		return out;
	}

	/// The page's console and the channel's verbs as the daimon reads them: printable ASCII, a long
	/// base64 or hex run cut to `[..]`, the newest 20 lines of 160.
	function traceText(lines) {
		var out = arr(lines).filter(function (l) { return typeof l === 'string'; }).map(function (l) {
			return pc(l.replace(/[A-Za-z0-9+\/=_-]{40,}/g, '[..]'), 160);
		}).filter(function (l) { return l; });
		return out.slice(-20).join('\n');
	}

	/// Render a Diamond's page in a frame of its own, off screen, and measure and
	/// photograph it from inside. It does NOT need the page to be showing, and it
	/// works on a page just edited, which is the point: a daimon on a handed-off turn
	/// has no page on screen, and a daimon that cannot see what it built guesses.
	///
	/// `req` is `{ page, data, id, width, sel, max_w, background, png }` (`png: false` asks for the
	/// table alone, which is what a re-measure after an edit wants): the stored page text
	/// (empty for the shipped default) and the stored `crystal.json` text, read by the
	/// caller from the Diamond. The frame is made by the very function `mount` uses,
	/// so it has the same sandbox and the same policy; it is READ-ONLY (a `save` or an
	/// `open` from it is let go), it is on its own channel and not `live`, and it is gone
	/// whatever happens. Its `asset` verb is answered as the on-screen frame's is
	/// (`serveAsset`), from the folder of the Diamond `id` names, so the picture is faithful to
	/// the screen. Resolves `{ table, png_b64, w, h, trace }`, else rejects in words.
	///
	/// With `proof: true` (and `graphics_min`) it is the load proof: the reply also carries
	/// `proof` (`pass` or `FAIL: ...`) and `debug`, and a page that cannot be drawn at all
	/// RESOLVES as a failed proof with the reason as its table, because a page that never loads
	/// is the plainest failure there is and not a fault of the driver.
	function render(req) {
		req = obj(req);
		var verbs = [];
		var out = renderPage(req, verbs);
		if (req.proof !== true) return out;
		return out.then(null, function (e) {
			var why = pc(e && e.message, 300) || 'the page could not be drawn';
			return { table: 'The page could not be drawn: ' + why, png_b64: '', w: 0, h: 0,
				proof: 'FAIL: ' + why.replace(/\.$/, ''), debug: 0, trace: traceText(verbs) };
		});
	}

	function renderPage(req, verbs) {
		var width = Math.round(Number(req.width));
		if (!(width >= 200 && width <= 4000)) width = 1440;
		var high = width < 768 ? 844 : 900;
		var sel = str(req.sel).slice(0, PROBE_SEL_MAX);
		var wantPng = req.png !== false, wantProof = req.proof === true, gmin = Number(req.graphics_min) || 0;
		var looks = arr(req.look).filter(function (t) { return typeof t === 'string' && t.trim(); })
			.slice(0, LOOK_MAX).map(function (t) { return t.trim().slice(0, LOOK_CHARS); });
		var page = str(req.page).trim() ? draw(String(req.page)) : DEFAULT_PAGE;
		// A crystal that does not parse is an ERROR here and never `{}`: the probe used to draw the
		// empty card for it, and a daimon went looking for a layout fault in a page that had
		// simply never been given its data (lane K, K0).  Blank stays `{}`, a new Diamond's.
		var parsed = parse(req.data);
		if (!parsed.ok) {
			return Promise.reject(new Error('crystal.json is not valid JSON (' + parsed.error +
				'), so the crystal page cannot be drawn; the owner\'s panel shows it as text. ' +
				'Write it again as one JSON object.'));
		}
		var data = obj(parsed.data);
		return new Promise(function (resolve, reject) {
			var faces = faceSkin(currentSkin());
			if (faces) loadFaces(currentSkin());
			var names = page.toLowerCase();
			var nonce = newNonce();
			if (!nonce) {
				reject(new Error('This browser has no random source, so the crystal page cannot be measured safely.'));
				return;
			}
			var made = makeFrame(page, probeShimTag(nonce) + (faces ? FACE_PRELUDE : ''), 'crystal-offscreen', 'crystal');
			var frame = made.frame;
			frame.style.cssText = 'position:fixed;left:-30000px;top:0;border:0;width:' + width + 'px;height:' + high + 'px;';
			frame.setAttribute('aria-hidden', 'true');
			frame.tabIndex = -1;
			var settled = false, loads = 0, ready = false, rendered = false, asked = 0, readyT = 0, renderT = 0, replyT = 0;
			var answered = false, drew = [];

			function end(fn, v) {
				if (settled) return;
				settled = true;
				clearTimeout(readyT); clearTimeout(renderT); clearTimeout(replyT);
				window.removeEventListener('message', onMsg);
				if (frame.parentNode) frame.parentNode.removeChild(frame);
				try { URL.revokeObjectURL(made.url); } catch (e) { /* already gone */ }
				fn(v);
			}
			function say(msg) {
				var w = frame.contentWindow;
				if (!w) return;
				msg.dc = 1; msg.v = PROTOCOL;
				try { w.postMessage(msg, '*'); } catch (e) { /* the frame went away */ }
			}
			function ask() {
				if (asked || settled) return;
				asked = ++probeSeq;
				say({ cmd: 'probe', id: asked, sel: sel, png: wantPng, proof: wantProof, look: looks,
					max_w: Number(req.max_w) > 0 ? Math.min(Number(req.max_w), 4000) : 0,
					background: str(req.background).slice(0, 64) });
				replyT = setTimeout(function () {
					end(reject, new Error('The crystal page did not answer within ' + Math.round(PROBE_PNG_MS / 1000)
						+ ' s. Its script may be stuck; read its source instead.'));
				}, PROBE_PNG_MS);
			}
			function onMsg(e) {
				if (settled || loads > 1 || e.source !== frame.contentWindow) return;
				var m = e.data;
				if (!m || m.dc !== 1 || m.v !== PROTOCOL) return;
				if (m.cmd !== 'probed' && verbs.length < 40) verbs.push('page -> host: ' + pc(m.cmd, 24));
				switch (m.cmd) {
					case 'ready':
						if (ready) return;
						ready = true;
						clearTimeout(readyT);
						say({ cmd: 'data', data: wireData(data, req, document.body, names) });
						// A page that says `rendered` is measured then; one that never does, after the
						// same grace the on-screen frame gives it.
						renderT = setTimeout(ask, FALLBACK_MS);
						break;
					case 'rendered':
						if (!rendered) drew = arr(m.keys).filter(function (k) { return typeof k === 'string'; });
						rendered = true; clearTimeout(renderT); ask(); break;
					case 'asset':
						// The same answer the on-screen frame gets, for this Diamond's own folder only.
						serveAsset(m, req.id, assetFor(req)).then(function (reply) {
							if (!settled) say(reply);
						});
						break;
					case 'probed':
						// Only the shim this host armoured in holds the nonce, so a page's own early
						// answer is let go, and the shim's genuine one still lands.
						if (!asked || answered || m.id !== asked || typeof m.nonce !== 'string' || m.nonce !== nonce) return;
						answered = true;
						var r = probeResult(m, sel, wantPng, looks);
						if (r.err) { end(reject, new Error(r.err)); return; }
						if (!rendered) r.table += '\nThe page never said what it drew; it may not follow the channel.';
						r.trace = traceText(arr(m.trace).concat(verbs));
						if (wantProof) {
							var v = proofVerdict(m.facts, data, gmin), miss = undrawn(data, drew);
							// What the viewer does with the same page: no `rendered` and it shows the plain
							// data view instead; keys left out and it names them under the page.
							var also = !rendered ? 'the page never says what it drew, so the viewer shows the plain data view in its place'
								: miss.length ? 'the page says it did not draw ' + miss.slice(0, 8).map(function (k) { return pc(k, 40); }).join(', ') : '';
							if (also) v.proof = (v.proof === 'pass' ? 'FAIL: ' : v.proof + '; ') + also;
							r.proof = v.proof; r.debug = v.debug;
						}
						probeSight(r).then(function (v) { end(resolve, v); });
						break;
					default: break;   // `save`, `open`, `height`: a view takes no action
				}
			}
			window.addEventListener('message', onMsg);
			frame.addEventListener('load', function () {
				loads++;
				if (loads > 1) end(reject, new Error('The crystal page navigated itself away, so it was not measured.'));
			});
			readyT = setTimeout(function () {
				end(reject, new Error('The crystal page never said `ready`, so it cannot be drawn; its script may have failed '
					+ 'on load. Read its source, or reset it to the shipped page.'));
			}, 4000);
			document.body.appendChild(frame);
		});
	}


	// ── mount ───────────────────────────────────────────────────────
	//
	// One frame at a time, because there is exactly one caller and a second live
	// channel would mean two `message` listeners racing over one reply. `mount`
	// owns the whole lifecycle — build, wire, time, and swap in the built-in view
	// itself when the page fails. The app does not drive any of that, and there
	// are NO custom events anywhere in this file: the app re-mounts after a write,
	// which is the one rule written straight out of the last session's integration
	// bug, where two lanes each invented a name for the same signal.

	var live = null;

	/// Render a Diamond's crystal into `el` using its own page.
	///
	/// `opts` is `{ id, data, page, onOpen, onKeys, onFallback, onAsset, onReset, t }`.
	function mount(el, opts) {
		unmount();
		if (!el) return;
		opts = opts || {};
		clearOurs(el);

		var page = str(opts.page).trim() ? String(opts.page) : DEFAULT_PAGE;
		var data = obj(opts.data);

		var wrap = document.createElement('div');
		wrap.id = 'crystal-frame-wrap';

		// The page cannot reach the network, whoever wrote it. See above. Under a skin that carries
		// faces it is also given the lines that register them.
		var faces = faceSkin(currentSkin());
		if (faces) loadFaces(currentSkin());
		var made = makeFrame(page, faces ? FACE_PRELUDE : '', 'crystal-frame', tr(opts, 'crystal.view_crystal', 'Crystal'));
		var frame = made.frame, armed = made.armed, url = made.url;
		wrap.appendChild(frame);
		el.appendChild(wrap);

		live = {
			el: el, opts: opts, data: data, frame: frame, url: url,
			// What the page names, lower-cased: a face it names in its own stack is handed
			// over with the theme's, so a head set in Sofia Sans Condensed draws in it.
			names: page.toLowerCase(),
			// The record, not the page: `_state` reports this and nothing holds the
			// armoured text once the blob has it.
			csp: { policy: PAGE_CSP, injected: armed.injected, carried: armed.carried, at: armed.at },
			ready: false, reported: false, done: false, loads: 0, keys: [], faces: faces,
			timer: 0, rtimer: 0, watch: null, height: 0, onMsg: null, onLoad: null,
		};

		live.onMsg = function (e) { onMessage(e); };
		window.addEventListener('message', live.onMsg);

		// A second load is the page navigating ITSELF somewhere. The sandbox stops
		// it taking the tab, but a `postMessage` to an opaque origin must be sent
		// with `'*'` — there is no origin to name — so a frame that has moved on
		// would receive the next reply. Nothing is sent after this, and the page is
		// treated as broken, because a crystal page has no business navigating.
		live.onLoad = function () {
			if (!live) return;
			live.loads++;
			if (live.loads === 1) {
				// The document is fetched; the URL has done its work.
				try { URL.revokeObjectURL(live.url); } catch (e) { /* already gone */ }
				live.url = '';
				return;
			}
			fell('partial');
		};
		frame.addEventListener('load', live.onLoad);

		live.timer = setTimeout(function () { fell('timeout'); }, FALLBACK_MS);

		// The palette can change under us at any moment, and `data-theme` is what
		// the app stamps — watching the attribute is watching the actual event
		// rather than inventing a signal for it. The page is simply sent its data
		// again, which is the only thing it knows how to be told anything by.
		//
		// Except into a skin that carries faces from a page mounted without the prelude:
		// that page has no way to take them, so it is mounted again, which is a person
		// choosing a look and not something that happens while they read.
		if (window.MutationObserver) {
			live.watch = new MutationObserver(function () {
				if (live && !live.done && !live.faces && faceSkin(currentSkin())) {
					mount(live.el, live.opts);
					return;
				}
				sendData();
			});
			live.watch.observe(document.documentElement, {
				attributes: true,
				attributeFilter: ['data-theme', 'data-ink', 'data-skin'],
			});
		}
	}

	/// Take down whatever is mounted. Safe to call when nothing is.
	function unmount() {
		if (!live) return;
		var l = live;
		live = null;
		detach(l);
		if (l.el) clearOurs(l.el);
	}

	/// Everything the channel holds open, released. The DOM is left alone: the
	/// fallback view is put up by `fell` after this runs.
	function detach(l) {
		if (l.onMsg) window.removeEventListener('message', l.onMsg);
		if (l.onLoad && l.frame) l.frame.removeEventListener('load', l.onLoad);
		if (l.watch) { try { l.watch.disconnect(); } catch (e) { /* gone */ } }
		clearTimeout(l.timer);
		clearTimeout(l.rtimer);
		if (l.url) { try { URL.revokeObjectURL(l.url); } catch (e) { /* gone */ } }
		l.url = '';
		l.onMsg = null;
		l.onLoad = null;
		l.watch = null;
	}

	/// Remove only what this file put in the container. The crystal bar and the
	/// ask row above and below are the app's, and a `mount` that emptied its
	/// parent would take them with it.
	function clearOurs(el) {
		var kill = el.querySelectorAll('#crystal-frame-wrap, .crystal-fallback');
		for (var i = 0; i < kill.length; i++) {
			if (kill[i].parentNode) kill[i].parentNode.removeChild(kill[i]);
		}
	}


	// ── The channel ─────────────────────────────────────────────────

	/// The frame's only way back to us. A sandboxed frame is isolated, not
	/// silenced, and neither is anything else on the page: `message` is a window
	/// event, so an advert in some other frame, an extension, or a page we merely
	/// displayed can all post at us. `web.js` at ~line 831 hit this exact trap.
	/// So: the sender must be OUR frame's window, and the shape must be ours.
	function onMessage(e) {
		if (!live || live.done || !live.frame) return;
		if (e.source !== live.frame.contentWindow) return;
		var m = e.data;
		if (!m || m.dc !== 1 || m.v !== PROTOCOL) return;
		switch (m.cmd) {
			case 'ready':    onReady(); break;
			case 'asset':    onAsset(m); break;
			case 'save':     onSave(m); break;
			case 'rendered': onRendered(m); break;
			case 'height':   onHeight(m); break;
			case 'open':     onOpen(m); break;
			default: break;   // an unknown verb is a page from a later Daimond; ignore it
		}
	}

	/// Post to the frame. The target origin can only be `'*'`: the frame has an
	/// opaque origin, which names nothing. That is safe because we know what is in
	/// it — and it stops being true the moment the page navigates, which is why
	/// `onLoad` above shuts the channel when it does.
	function toFrame(msg) {
		if (!live || live.done || !live.frame) return;
		var w = live.frame.contentWindow;
		if (!w) return;
		msg.dc = 1;
		msg.v = PROTOCOL;
		try { w.postMessage(msg, '*'); } catch (e) { /* the frame went away */ }
	}

	function sendData() {
		if (!live || live.done || !live.ready) return;
		toFrame({ cmd: 'data', data: wireData(live.data, live.opts, live.el, live.names) });
	}

	/// The page is listening. Its data goes out unprompted, and a second clock
	/// starts: a page that says `ready` and then never says what it rendered has
	/// shown us nothing we can check, and unverifiable is the failure this whole
	/// design is shaped around.
	function onReady() {
		if (live.ready) return;
		live.ready = true;
		clearTimeout(live.timer);
		live.timer = 0;
		sendData();
		live.rtimer = setTimeout(function () {
			if (live && !live.reported) fell('partial');
		}, FALLBACK_MS);
	}

	/// The answer to a page's `asset` verb: one text file from a Diamond's scope, read for it
	/// by the app. The path is vetted here before anybody is asked for anything: a page that
	/// asks for `../../other/crystal.json` gets an error, not a file. Resolves the reply to
	/// post, `{ id, text }` or `{ id, error }`, and never rejects.
	///
	/// ONE FUNCTION FOR BOTH FRAMES. The on-screen view (`onAsset`) and the off-screen one
	/// (`render`) answer through it, so a page that fetches its own files draws the same in
	/// the picture a daimon is given as on the screen a person sees, under the same checks.
	/// `reader` is the app's (`readCrystalAsset`), which re-checks the path; `id` names the
	/// Diamond whose folder it is, so a frame can only ever read its own.
	function serveAsset(m, id, reader) {
		var rid = m.id;
		var rel = safePath(m.path);
		if (!rel) return Promise.resolve({ id: rid, error: 'path' });
		if (typeof reader !== 'function' || !str(id)) return Promise.resolve({ id: rid, error: 'unavailable' });
		var full = 'diamonds/' + str(id) + '/' + rel;
		return Promise.resolve().then(function () {
			return reader(full, rel);
		}).then(function (text) {
			return { id: rid, text: str(text) };
		}, function (err) {
			return { id: rid, error: String((err && err.message) || err) };
		});
	}

	/// The app's reader for `asset`, for a frame that has no `mount` to be handed one.
	/// Registered once by the app (`setAssetReader`), and used by `render`.
	var assetReader = null;
	function setAssetReader(fn) { assetReader = typeof fn === 'function' ? fn : null; }

	// The last version of a Diamond's page that passed the load proof (K1), kept by the app in
	// `diamonds/<id>/.daimond/crystal_passed.json` as `{version, at, page, data, debug}`; K2
	// restores from it. `crystal.js` has no store of its own, so the app registers one.
	var passedStore = null;
	function setPassedStore(st) {
		passedStore = st && typeof st.mark === 'function' && typeof st.last === 'function' ? st : null;
	}

	/// Mark the Diamond's page and data, as stored now, as passing at `version` (0: the newest
	/// recorded). Resolves the mark, or `null` with no store.
	function markPassed(id, version) {
		if (!passedStore || !str(id)) return Promise.resolve(null);
		return Promise.resolve(passedStore.mark(String(id), Number(version) || 0)).then(passedOf);
	}

	/// The last mark for the Diamond, or `null` when none is kept.
	function lastPassed(id) {
		if (!passedStore || !str(id)) return Promise.resolve(null);
		return Promise.resolve(passedStore.last(String(id))).then(passedOf, function () { return null; });
	}

	function passedOf(j) {
		var o = null;
		try { o = typeof j === 'string' ? (j ? JSON.parse(j) : null) : j; } catch (e) { return null; }
		return o && typeof o === 'object' && typeof o.version === 'number' ? o : null;
	}

	/// The `(fullPath, rel)` reader an off-screen render answers `asset` with: the request's own,
	/// else the app's registered one, which takes the Diamond's id first as `readCrystalAsset` does.
	function assetFor(req) {
		if (typeof req.onAsset === 'function') return req.onAsset;
		if (!assetReader) return null;
		return function (full, rel) { return assetReader(req.id, full, rel); };
	}

	/// A text file from this Diamond's scope, for the on-screen page.
	function onAsset(m) {
		var reader = (live.opts && typeof live.opts.onAsset === 'function')
			? live.opts.onAsset : null;
		var mine = live;
		serveAsset(m, live.opts && live.opts.id, reader).then(function (reply) {
			if (live !== mine || live.done) return;
			toFrame(reply);
		});
	}

	/// The files a page may never write, whatever it asks.
	///
	/// **A page must not be able to rewrite itself.** `crystal.html` IS the page and
	/// `crystal.json` is what it renders; a page that could write either could change its own
	/// code between one render and the next, and nothing a person reviewed would stay reviewed.
	/// That is the difference between a page that keeps a log and a page that rewrites the app,
	/// and it is one line of guard.
	///
	/// `versions/` is the crystal's own history and `.daimond/` holds the rules about what agents
	/// may do — neither is a page's business either. Everything else under the Diamond is fair
	/// game, which is the whole point: a capp keeps its data beside itself.
	///
	/// `capp.json` is here as of sharing. It is the DELIVERY RECORD: it says which bytes were
	/// delivered and at what template version, and it decides which of a capp's files a future
	/// template fix may replace. A page that could rewrite it could pin itself against every
	/// update, or claim a file it had edited and have the next version overwrite the user's own
	/// work. While a capp could only ever have come from this build that was a hazard and not a
	/// hole — nothing escaped the Diamond and nothing reached anybody else's. **A capp can now
	/// arrive from another person**, so the page that would be doing the pinning is one the
	/// receiver did not write, on a machine whose owner never chose it. The share format refuses
	/// to carry a delivery record at all (fe2o3_sbj `share.rs`), and this is the other half:
	/// having refused to carry one, it must also refuse to let a page mint one.
	///
	/// `triggers.json` is here as of 2026-09-24. It is the Diamond's automation: what may start
	/// a turn with nobody present. A page that wrote it could not arm anything, since a
	/// triggered action is held until a person releases it on this device (`releasedHereOnly`
	/// in pause.js), but what a page may not start it has no business writing either.
	var PAGE_NEVER_WRITES = /^(crystal\.(json|html|md)$|versions\/|\.daimond\/|capp\.json$|triggers\.json$)/;

	/// The most a page may write in one call.
	///
	/// A log line is a few hundred bytes and a curated table is tens of kilobytes; a megabyte is
	/// a page that has misunderstood what it is doing. It is a cap on ONE write, not on the file:
	/// an append-driven log grows past this a line at a time, which is exactly right.
	///
	/// Measured in UTF-16 code units, because that is what `String.length` counts -- so a log in
	/// a script outside Latin-1 meets this at roughly half the byte figure. Stated rather than
	/// corrected: the cap is a guard against a page that has gone wrong, not an accounting
	/// boundary, and a limit that reads the same in every script is worth more than one that is
	/// exact in one.
	var SAVE_MAX = 512 * 1024;

	/// How many times one mounting of a page may save.
	///
	/// The bound that lets `save` exist at all, given that a click and a timer look the same from
	/// out here (see the head of this file). A person logging meals taps a few dozen times in a
	/// sitting; a page whose generated code has a loop in it reaches this in a second and is then
	/// refused, with the frame still up and the app still answering. Per MOUNT, not per session:
	/// leaving the Diamond and coming back is a person deciding to, and it is the cheapest
	/// possible way out of a page that has run away with itself.
	var SAVE_BUDGET = 400;

	/// Answer the page's `save` verb: write one text file into THIS Diamond's directory.
	///
	/// The mirror of [`onAsset`], deliberately: same fence, same reply shape, same Diamond. A
	/// crystal page has no storage of its own — the frame is `sandbox="allow-scripts"`, so its
	/// origin is opaque and `localStorage` throws — and no network, because its policy is
	/// `default-src 'none'`. So without this a page can draw anything and remember nothing, and
	/// every interactive crystal is a toy that forgets on reload.
	///
	/// `postMessage` works inside that sandbox, which is why this needs no relaxation of it. The
	/// page asks; the app writes. That is better than granting the frame storage, because the app
	/// decides what a page may touch and can say no — as it does above.
	///
	/// `mode` is `append` (the default for a log) or `replace`. Append keeps a logger honest
	/// WITHIN a device: two taps in the same tick both survive, where two replaces lose one.
	/// It does NOT merge across devices -- sync replaces a Diamond wholesale from the fresher
	/// copy -- and the first version of this comment claimed it did. See `writeCrystalAsset`.
	function onSave(m) {
		var id = m.id;
		var rel = safePath(m.path);
		if (!rel) { toFrame({ id: id, error: 'path' }); return; }
		if (PAGE_NEVER_WRITES.test(rel)) { toFrame({ id: id, error: 'protected' }); return; }
		var text = str(m.text);
		if (text.length > SAVE_MAX) { toFrame({ id: id, error: 'too big' }); return; }
		live.saves = (live.saves || 0) + 1;
		if (live.saves > SAVE_BUDGET) { toFrame({ id: id, error: 'too many' }); return; }
		var writer = (live.opts && typeof live.opts.onSave === 'function')
			? live.opts.onSave : null;
		if (!writer) { toFrame({ id: id, error: 'unavailable' }); return; }
		var full = 'diamonds/' + str(live.opts.id) + '/' + rel;
		var mine = live;
		Promise.resolve().then(function () {
			return writer(full, rel, text, m.mode === 'replace' ? 'replace' : 'append');
		}).then(function () {
			if (live !== mine || live.done) return;
			toFrame({ id: id, ok: true });
		}, function (err) {
			if (live !== mine || live.done) return;
			toFrame({ id: id, error: String((err && err.message) || err) });
		});
	}

	/// A relative path inside the Diamond's own folder, or '' for anything that
	/// leaves it. Backslashes, a scheme, a leading slash and any `..` segment are
	/// all refused rather than normalised, because a path that needed normalising
	/// was not one the page should have asked for.
	function safePath(p) {
		var s = str(p).trim();
		if (!s || s.length > 512) return '';
		if (s.indexOf('\\') >= 0 || s.indexOf('\0') >= 0) return '';
		if (s.charAt(0) === '/' || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return '';
		var parts = s.split('/'), out = [];
		for (var i = 0; i < parts.length; i++) {
			var seg = parts[i];
			if (seg === '' || seg === '.') continue;
			if (seg === '..') return '';
			out.push(seg);
		}
		return out.length ? out.join('/') : '';
	}

	/// What the page says it drew. If that does not cover every top-level key with
	/// content in it, the page is showing less than the Diamond holds, and a note
	/// over the page names what it leaves out — the one defect this design is shaped
	/// around is a key that vanishes from the display because nothing recognised it.
	///
	/// The page stays up (K1, D-20261008-08). It used to be replaced by the built-in view,
	/// so an infographic that drew its sections and left `links` out was never seen at all,
	/// by the owner or by anyone judging it; the note keeps the key from vanishing, and the
	/// daimon is told at its next turn (`onFallback('undrawn', keys)`).
	function onRendered(m) {
		live.reported = true;
		clearTimeout(live.rtimer);
		live.rtimer = 0;
		var keys = [], raw = arr(m.keys);
		for (var i = 0; i < raw.length; i++) {
			if (typeof raw[i] === 'string') keys.push(raw[i]);
		}
		live.keys = keys;
		if (live.opts && typeof live.opts.onKeys === 'function') {
			try { live.opts.onKeys(keys.slice()); } catch (e) { /* the app's problem */ }
		}
		var miss = undrawn(live.data, keys), wrap = live.frame.parentNode, old = null;
		if (wrap && wrap.querySelector) old = wrap.querySelector('.crystal-undrawn');
		if (old && old.parentNode) old.parentNode.removeChild(old);
		live.undrawn = miss;
		if (!miss.length || !wrap) return;
		var note = document.createElement('div');
		note.className = 'crystal-fallback-note crystal-undrawn';
		note.textContent = tr(live.opts, 'crystal.page_undrawn', 'This page does not show: {keys}.', { keys: miss.join(', ') });
		wrap.insertBefore(note, live.frame);
		var said = miss.join('\n');
		if (said === live.undrawnSaid) return;
		live.undrawnSaid = said;
		if (live.opts && typeof live.opts.onFallback === 'function') {
			try { live.opts.onFallback('undrawn', miss.slice()); } catch (e) { /* the app's problem */ }
		}
	}

	/// The page's own height, so the frame is at least as tall as its content
	/// and the crystal scrolls in one column rather than two.
	///
	/// `minHeight`, not `height`: `height` would pin the frame to exactly this
	/// many pixels and undo the CSS rule (crystal.css, `.crystal-frame`) that
	/// fills the rest of a panel a short page does not reach. A `min-height`
	/// only ever RAISES the floor -- a page taller than the panel still grows
	/// past it, a page shorter than the panel still gets the whole panel.
	function onHeight(m) {
		var px = Number(m.px);
		if (!isFinite(px)) return;
		px = Math.max(MIN_H, Math.min(MAX_H, Math.round(px)));
		if (px === live.height) return;
		live.height = px;
		live.frame.style.minHeight = px + 'px';
	}

	/// A link the page asked to follow. The app routes it and may refuse; this end
	/// only decides what is worth passing on.
	///
	/// Same-origin is refused HERE rather than handed over, because the app's
	/// egress gate allows the app's own address outright — a sensible rule for the
	/// agent's browser, and the wrong one for a page written by a model, which
	/// could otherwise walk the memory out a path fragment at a time.
	function onOpen(m) {
		var href = str(m.href).trim();
		if (!href || href.length > HREF_MAX) return;
		if (!/^(https?:|mailto:)/i.test(href)) return;
		if (/^https?:/i.test(href)) {
			var host = '';
			try { host = new URL(href).host; } catch (e) { return; }
			if (!host || host === location.host) return;
		}
		if (live.opts && typeof live.opts.onOpen === 'function') {
			try { live.opts.onOpen(href); } catch (e) { /* the app's problem */ }
		}
	}

	/// Give up on the page and show the data. Once, and visibly.
	function fell(reason) {
		if (!live || live.done) return;
		live.done = true;
		var l = live;
		detach(l);
		live = {
			el: l.el, done: true, opts: l.opts, data: l.data,
			reason: reason, keys: l.keys || [], csp: l.csp || null,
		};
		if (l.el) {
			clearOurs(l.el);
			var o = {}, k;
			for (k in l.opts) if (own(l.opts, k)) o[k] = l.opts[k];
			o.reason = reason;
			fallback(l.el, l.data, o);
		}
		if (l.opts && typeof l.opts.onFallback === 'function') {
			try { l.opts.onFallback(reason); } catch (e) { /* the app's problem */ }
		}
	}


	// ── The built-in view ───────────────────────────────────────────
	//
	// What the app shows when the page will not. It renders the core schema
	// properly AND every unknown top-level key generically, because a key that
	// disappears from the display because nothing recognised it is the defect the
	// whole design is shaped around — and the reducer is a fresh, tool-less model
	// under a user-editable prompt rewriting the whole file from one sentence, so
	// key drift is the expected behaviour, not a risk.
	//
	// Markdown goes through `DaimondRender.md`, the app's sanitiser, which drops
	// `script`, `style`, `iframe`, `form`, `input`, `button` and `svg` whole. It is
	// right to and must not be loosened for this: unlike the frame, this view
	// renders inside the app's own page.

	/// The generic view of a crystal, with a note when it is standing in for a
	/// page that failed. `opts.reason` is `'timeout'`, `'partial'`, or absent.
	function fallback(el, data, opts) {
		if (!el) return;
		opts = opts || {};
		clearOurs(el);
		var d = obj(data);
		var root = document.createElement('div');
		root.className = 'crystal-fallback';

		if (opts.reason) root.appendChild(fallbackNote(opts));

		var body = document.createElement('div');
		body.className = 'crystal-fb-body';
		var drew = 0;

		if (hasContent(d.title)) {
			drew++;
			var h1 = document.createElement('h2');
			h1.className = 'crystal-fb-title';
			h1.textContent = str(d.title);
			body.appendChild(h1);
		}
		if (hasContent(d.summary)) {
			drew++;
			body.appendChild(mdBlock(d.summary, 'crystal-fb-summary'));
		}
		if (hasContent(d.sections)) {
			drew++;
			var secs = arr(d.sections);
			for (var i = 0; i < secs.length; i++) {
				var s = obj(secs[i]);
				var sec = document.createElement('section');
				sec.className = 'crystal-fb-sec';
				if (hasContent(s.heading)) {
					var h = document.createElement('h3');
					h.textContent = str(s.heading);
					sec.appendChild(h);
				}
				if (hasContent(s.body)) sec.appendChild(mdBlock(s.body, ''));
				body.appendChild(sec);
			}
		}
		if (hasContent(d.facts)) {
			drew++;
			body.appendChild(fieldHead(tr(opts, 'crystal.field_facts', 'Facts')));
			var dl = document.createElement('dl');
			dl.className = 'crystal-fb-facts';
			var facts = arr(d.facts);
			for (var fi = 0; fi < facts.length; fi++) {
				var f = obj(facts[fi]);
				var dt = document.createElement('dt');
				dt.textContent = str(f.k);
				var dd = document.createElement('dd');
				dd.textContent = str(f.v);
				dl.appendChild(dt);
				dl.appendChild(dd);
			}
			body.appendChild(dl);
		}
		if (hasContent(d.links)) {
			drew++;
			body.appendChild(fieldHead(tr(opts, 'crystal.field_links', 'Links')));
			var lu = document.createElement('ul');
			lu.className = 'crystal-fb-links';
			var links = arr(d.links);
			for (var li2 = 0; li2 < links.length; li2++) {
				var lk = obj(links[li2]);
				var item = document.createElement('li');
				item.appendChild(linkEl(str(lk.href), str(lk.label) || str(lk.href), opts));
				lu.appendChild(item);
			}
			body.appendChild(lu);
		}

		// Everything the schema does not name, INCLUDING a leading-underscore key.
		// The channel's own two are put on the copy that goes to the frame and never
		// on this one, so an underscore reaching here was written by the model —
		// and the reserved namespace is a rule about the wire, not a licence to
		// leave a key off the screen. `contentKeys`, which decides what a page must
		// prove it drew, is right to skip them: the page is never sent them.
		var rest = [];
		for (var rk in d) {
			if (!own(d, rk)) continue;
			if (CORE_KEYS.indexOf(rk) >= 0) continue;
			if (hasContent(d[rk])) rest.push(rk);
		}
		if (rest.length) {
			drew++;
			var extra = document.createElement('div');
			extra.className = 'crystal-fb-extra';
			extra.appendChild(fieldHead(tr(opts, 'crystal.other_fields', 'Other fields')));
			for (var xi = 0; xi < rest.length; xi++) {
				var box = document.createElement('div');
				box.className = 'crystal-fb-field';
				var name = document.createElement('div');
				name.className = 'crystal-fb-key';
				name.textContent = rest[xi];
				box.appendChild(name);
				box.appendChild(valueEl(d[rest[xi]], 0));
				extra.appendChild(box);
			}
			body.appendChild(extra);
		}

		if (!drew) {
			var empty = document.createElement('div');
			empty.className = 'crystal-empty';
			empty.textContent = tr(opts, 'crystal.empty',
				'The crystal is empty. Steer it below to begin.');
			body.appendChild(empty);
		}

		root.appendChild(body);
		el.appendChild(root);
	}

	/// Why the page is not on screen, and the way back to one that works.
	function fallbackNote(opts) {
		var note = document.createElement('div');
		note.className = 'crystal-fallback-note';
		var why = document.createElement('span');
		why.className = 'crystal-fallback-why';
		why.textContent = (opts.reason === 'partial')
			? tr(opts, 'crystal.page_partial',
				'This diamond\u2019s page did not show everything it holds, so its data is shown instead.')
			: tr(opts, 'crystal.page_failed',
				'This diamond\u2019s page did not load, so its data is shown instead.');
		note.appendChild(why);
		if (typeof opts.onReset === 'function') {
			var btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'crystal-reset';
			btn.textContent = tr(opts, 'crystal.page_reset', 'Reset the page');
			btn.addEventListener('click', function () { opts.onReset(); });
			note.appendChild(btn);
		}
		return note;
	}

	function fieldHead(text) {
		var h = document.createElement('h3');
		h.className = 'crystal-fb-field-head';
		h.textContent = text;
		return h;
	}

	/// Markdown through the app's sanitiser, or plain text where the renderer is
	/// not on the page. Either way nothing live reaches the DOM.
	function mdBlock(text, cls) {
		var div = document.createElement('div');
		div.className = ('crystal-fb-md ' + (cls || '')).trim();
		if (window.DaimondRender && typeof DaimondRender.md === 'function') {
			div.innerHTML = DaimondRender.md(str(text));
		} else {
			div.textContent = str(text);
		}
		return div;
	}

	/// A link that goes out through the app rather than navigating the panel.
	function linkEl(href, label, opts) {
		var a = document.createElement('a');
		a.className = 'crystal-fb-link';
		a.textContent = label;
		var ok = /^(https?:|mailto:)/i.test(href);
		if (!ok) { a.title = href; return a; }
		a.href = href;
		a.rel = 'noopener noreferrer';
		a.addEventListener('click', function (e) {
			e.preventDefault();
			if (typeof opts.onOpen === 'function') opts.onOpen(href);
		});
		return a;
	}

	/// Any value at all, drawn as something a reader can take in. Past four levels
	/// it goes out as JSON rather than being flattened — unreadable is recoverable,
	/// absent is not.
	function valueEl(v, depth) {
		var i;
		if (typeof v === 'string') return mdBlock(v, '');
		if (typeof v === 'number' || typeof v === 'boolean') {
			var span = document.createElement('div');
			span.className = 'crystal-fb-scalar';
			span.textContent = String(v);
			return span;
		}
		if (depth >= 4 || v == null) return jsonEl(v);
		if (Array.isArray(v)) {
			var ul = document.createElement('ul');
			ul.className = 'crystal-fb-list';
			for (i = 0; i < v.length; i++) {
				var li = document.createElement('li');
				li.appendChild(valueEl(v[i], depth + 1));
				ul.appendChild(li);
			}
			return ul;
		}
		if (typeof v === 'object') {
			var dl = document.createElement('dl');
			dl.className = 'crystal-fb-map';
			for (var k in v) {
				if (!own(v, k)) continue;
				var dt = document.createElement('dt');
				dt.textContent = k;
				var dd = document.createElement('dd');
				dd.appendChild(valueEl(v[k], depth + 1));
				dl.appendChild(dt);
				dl.appendChild(dd);
			}
			return dl;
		}
		return jsonEl(v);
	}

	function jsonEl(v) {
		var pre = document.createElement('pre');
		pre.className = 'crystal-fb-json';
		try { pre.textContent = JSON.stringify(v, null, 2); }
		catch (e) { pre.textContent = String(v); }
		return pre;
	}


	// ── The shipped page ────────────────────────────────────────────
	//
	// Every Diamond starts on this, so it is the common case and not a
	// placeholder. It is self-contained by necessity as well as by rule: it lives
	// in an opaque origin, so there is no stylesheet to link, no font to fetch and
	// no network to reach — its own `Content-Security-Policy` says so out loud,
	// which is worth having because the sandbox stops the page reading anything of
	// ours but does not stop it POSTING somewhere, and the standard page should be
	// demonstrably incapable of that.
	//
	// It speaks the whole channel: `ready`, then `rendered` with the keys it drew,
	// then `height` whenever its own height changes, and `open` for every link. It
	// renders the core schema and, like the built-in view, every unknown key
	// generically — a default page that quietly skipped what it did not recognise
	// would trip its own coverage check, and rightly.
	//
	// It holds no English. The field names arrive in `_labels` and the colours in
	// `_theme`; a label that did not arrive is simply not drawn, and its content is
	// drawn anyway, because a missing word must never cost a key.
	//
	// The core key list is repeated inside the page. That is the price of the page
	// being self-contained, and it is the right price: a page a model rewrites next
	// week cannot import a constant from us either.


	/// The theme function as every page written before 2026-08-11 carries it.
	///
	/// Verbatim from the `DEFAULT_PAGE` of the day, joined the way that array is joined. It is
	/// matched EXACTLY and nothing else is: a page this does not recognise is left completely
	/// alone, so a page a model rewrote in its own style is never guessed at.
	var THEME_WAS = [
		'function theme(t){if(!t)return;var m={bg:"--bg",surface:"--sf",text:"--tx",',
		'muted:"--mu",border:"--bd",accent:"--ac",accentText:"--at",font:"--fo",',
		'mono:"--mo",size:"--fs",radius:"--rd"};',
		'for(var k in m)if(m.hasOwnProperty(k)&&t[k])',
		'document.documentElement.style.setProperty(m[k],t[k]);}',
	].join('\n');

	/// The same function, applying the palette as a DEFAULT the page can override.
	var THEME_NOW = [
		'function theme(t){if(!t)return;var m={bg:"--bg",surface:"--sf",text:"--tx",',
		'muted:"--mu",border:"--bd",accent:"--ac",accentText:"--at",font:"--fo",',
		'mono:"--mo",size:"--fs",radius:"--rd"};',
		'var css="";for(var k in m)if(m.hasOwnProperty(k)&&t[k])',
		'css+=m[k]+":"+t[k]+";";',
		'var el=document.getElementById("dc-theme");',
		'if(!el){el=document.createElement("style");el.id="dc-theme";',
		'document.head.insertBefore(el,document.head.firstChild);}',
		'el.textContent=":root{"+css+"}";}',
	].join('\n');

	/// A page brought up to date, or `null` when there is nothing to do.
	///
	/// `setProperty` on `documentElement` is an INLINE style, and an inline style beats the
	/// page's own `:root{--bg:#fff}` rule every time -- so a page that asked for its own
	/// colours was overwritten by the app's palette one message later. Every page written
	/// before the fix carries that function, because a page is copied from the default when
	/// the Diamond first renders and is the user's own thereafter.
	///
	/// A one-line substitution rather than a rewrite: whatever the page has become, only this
	/// block changes, and a page that does not contain it byte for byte is returned as `null`
	/// and never written.
	function upgrade(html) {
		var s = String(html == null ? '' : html);
		if (s.indexOf(THEME_WAS) === -1) return null;
		return s.split(THEME_WAS).join(THEME_NOW);
	}

	/// The shipped page's style, as it is now. The neutral values live in `var()` fallbacks at
	/// their use sites and NOT in a `:root` rule, so the theme in `<style id="dc-theme">` (the
	/// palette the parent sends, first in the head) applies to a page that does not declare a
	/// variable itself, and a page that does (`:root{--bg:#fff}`) still wins over the theme.
	/// A `:root{--tx:#777}` after the theme beat it in every look from 2026-08-11 until this.
	/// A link is drawn in `--ac`, the accent: `--at` is the text ON an accent fill (dark on Obsidian's
	/// pink), which the old `:root` had hidden by overriding it, and which drew links invisibly once
	/// the theme applied.
	var CSS_NOW = [
		'*{box-sizing:border-box}',
		'html,body{background:transparent;margin:0;padding:0}',
		'body{font-family:var(--fo,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif);font-size:var(--fs,14px);line-height:1.6;color:var(--tx,#777);',
		'word-break:break-word;overflow-wrap:anywhere;padding:0 0 2px}',
		'h1,h2,h3{font-family:"Sofia Sans Condensed",var(--fo,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif)}',
		'h1{font-size:1.45em;line-height:1.25;font-weight:650;margin:0 0 .5em}',
		'h2{font-size:1.08em;line-height:1.35;font-weight:650;margin:1.5em 0 .45em}',
		'h3{font-size:1em;font-weight:650;margin:1.1em 0 .35em}',
		'h1:first-child,h2:first-child,h3:first-child{margin-top:0}',
		'p{margin:0 0 .8em}',
		'a{color:var(--ac,#4a7fd0);text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
		'code{font-family:var(--mo,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:.92em;background:color-mix(in srgb,var(--tx,#777) 9%,transparent);',
		'border-radius:4px;padding:.05em .3em}',
		'pre{font-family:var(--mo,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:.9em;background:color-mix(in srgb,var(--tx,#777) 9%,transparent);',
		'border-radius:var(--rd,8px);padding:10px 12px;',
		'overflow-x:auto;margin:0 0 .85em;line-height:1.5}',
		'pre code{background:none;border:0;padding:0;font-size:1em}',
		'ul,ol{margin:0 0 .8em;padding-left:1.25em}',
		'li{margin:.12em 0}',
		'blockquote{margin:0 0 .8em;padding:.45em .85em;background:var(--sf,rgba(128,128,128,.10));border-radius:var(--rd,8px);color:var(--mu,#999)}',
		'img{max-width:100%;height:auto;border-radius:var(--rd,8px)}',
		'.facts{display:grid;grid-template-columns:auto 1fr;gap:.25em .9em;margin:0 0 .85em}',
		'.facts .k{color:var(--mu,#999);font-size:.93em}',
		'.facts .v{min-width:0}',
		'.field{border-radius:var(--rd,8px);padding:9px 11px;margin:0 0 .7em;background:var(--sf,rgba(128,128,128,.10))}',
		'.field > .k{color:var(--mu,#999);font-family:var(--mo,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:.85em;margin:0 0 .4em}',
		'.field > :last-child{margin-bottom:0}',
		'.note{color:var(--mu,#999);font-size:.9em;margin:0 0 .7em}',
		'.empty{color:var(--mu,#999);font-style:italic}',
		'@media (max-width:420px){.facts{grid-template-columns:1fr;gap:0}',
		'.facts .k{margin-top:.45em}}',
	];

	/// The style every default page was stored with before the fix above, verbatim.
	var CSS_WAS = [
		':root{--bg:transparent;--sf:rgba(128,128,128,.10);--tx:#777;--mu:#999;',
		'--bd:rgba(128,128,128,.35);--ac:#4a7fd0;--at:#4a7fd0;',
		'--fo:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
		'--mo:ui-monospace,SFMono-Regular,Consolas,monospace;--fs:14px;--rd:8px}',
		'*{box-sizing:border-box}',
		'html,body{background:transparent;margin:0;padding:0}',
		'body{font-family:var(--fo);font-size:var(--fs);line-height:1.6;color:var(--tx);',
		'word-break:break-word;overflow-wrap:anywhere;padding:0 0 2px}',
		'h1{font-size:1.45em;line-height:1.25;font-weight:650;margin:0 0 .5em}',
		'h2{font-size:1.08em;line-height:1.35;font-weight:650;margin:1.5em 0 .45em}',
		'h3{font-size:1em;font-weight:650;margin:1.1em 0 .35em}',
		'h1:first-child,h2:first-child,h3:first-child{margin-top:0}',
		'p{margin:0 0 .8em}',
		'a{color:var(--at);text-decoration:underline;text-underline-offset:2px;cursor:pointer}',
		'code{font-family:var(--mo);font-size:.92em;background:var(--sf);',
		'border:1px solid var(--bd);border-radius:4px;padding:.05em .3em}',
		'pre{font-family:var(--mo);font-size:.9em;background:var(--sf);',
		'border:1px solid var(--bd);border-radius:var(--rd);padding:10px 12px;',
		'overflow-x:auto;margin:0 0 .85em;line-height:1.5}',
		'pre code{background:none;border:0;padding:0;font-size:1em}',
		'ul,ol{margin:0 0 .8em;padding-left:1.25em}',
		'li{margin:.12em 0}',
		'blockquote{margin:0 0 .8em;padding:0 0 0 .85em;border-left:2px solid var(--bd);color:var(--mu)}',
		'img{max-width:100%;height:auto;border-radius:var(--rd)}',
		'.facts{display:grid;grid-template-columns:auto 1fr;gap:.25em .9em;margin:0 0 .85em}',
		'.facts .k{color:var(--mu);font-size:.93em}',
		'.facts .v{min-width:0}',
		'.field{border:1px solid var(--bd);border-radius:var(--rd);padding:9px 11px;margin:0 0 .7em;background:var(--sf)}',
		'.field > .k{color:var(--mu);font-family:var(--mo);font-size:.85em;margin:0 0 .4em}',
		'.field > :last-child{margin-bottom:0}',
		'.note{color:var(--mu);font-size:.9em;margin:0 0 .7em}',
		'.empty{color:var(--mu);font-style:italic}',
		'@media (max-width:420px){.facts{grid-template-columns:1fr;gap:0}',
		'.facts .k{margin-top:.45em}}',
	];

	/// The `open` key's drawing, which the page carried until 2026-09-15.
	var OPEN_CORE  = 'var CORE=["title","summary","sections","facts","open","links"];';
	var OPEN_BLOCK = [
		'if(has(D.open)){keys.push("open");',
		'if(L.open)h+="<h2>"+esc(L.open)+"</h2>";h+="<ul>";',
		'for(i=0;i<D.open.length;i++)h+="<li>"+inl(D.open[i]==null?"":D.open[i])+"</li>";',
		'h+="</ul>";}',
	].join('\n');
	var CSP_NEW = '; img-src data:; font-src data:">';
	var CSP_WAS = '; img-src data:">';

	/// Every page the shipped default has ever been stored as, rebuilt from today's.
	///
	/// Four defaults have shipped (2026-08-10 twice, 08-11, 09-15), differing in the policy
	/// meta, the theme function and the `open` key, and a page from before 08-11 is brought up
	/// by `upgrade` into a mix of them. So each of the three differences is a switch, and the
	/// style block (always the old one) is swapped back; eight pages, of which at most five ever
	/// existed. Built once, on first use, because `DEFAULT_PAGE` is defined below.
	var oldDefaults = null;
	function oldDefaultPages() {
		if (oldDefaults) return oldDefaults;
		var base = DEFAULT_PAGE.split(CSS_NOW.join('\n')).join(CSS_WAS.join('\n'));
		var out = [];
		for (var m = 0; m < 8; m++) {
			var pg = base;
			if (m & 1) pg = pg.split(CSP_NEW).join(CSP_WAS);
			if (m & 2) pg = pg.split(THEME_NOW).join(THEME_WAS);
			if (m & 4) {
				pg = pg.split('var CORE=["title","summary","sections","facts","links"];').join(OPEN_CORE);
				pg = pg.split('if(has(D.links)){keys.push("links");')
					.join(OPEN_BLOCK + '\n' + 'if(has(D.links)){keys.push("links");');
			}
			out.push(pg);
		}
		oldDefaults = out;
		return out;
	}

	/// The current default page when `html` is byte for byte a default the app once shipped,
	/// else `null`. For DRAWING, never for storing.
	///
	/// A stored page is the Diamond's own file and it syncs: a Diamond travels whole, the
	/// fresher `touched` replacing the other copy, and a write on two devices before they meet
	/// is a two-sided change that the merge keeps as a conflict version. `write_crystal_page`
	/// is such a write (a version, a log record, `updated` and `touched` moved, the Diamond
	/// back on the wire and at the top of the rail), so an upgrade that wrote would put every
	/// default Diamond through it on every device. The substitution is a pure function of the
	/// stored bytes instead: each device computes the same page, nothing is written and nothing
	/// travels. A page that has been edited, by anyone, is no default and is left alone.
	function adopt(html) {
		var s = String(html == null ? '' : html);
		if (s === DEFAULT_PAGE) return null;
		var olds = oldDefaultPages();
		for (var i = 0; i < olds.length; i++) if (olds[i] === s) return DEFAULT_PAGE;
		return null;
	}

	/// The `:root` block every shipped default carried, verbatim, and the same block at no
	/// specificity: the theme's `:root` (a style element first in the head) outranks it
	/// wherever it speaks and its values remain as fallbacks where the theme is silent.
	var ROOT_WAS  = CSS_WAS.slice(0, 4).join('\n');
	var ROOT_SOFT = ROOT_WAS.replace(/^:root/, ':where(:root)');
	var LINK_WAS  = 'a{color:var(--at);text-decoration:underline;text-underline-offset:2px;cursor:pointer}';
	var LINK_NOW  = CSS_NOW.filter(function (l) { return l.indexOf('a{color:var(--ac') === 0; })[0];

	/// An EDITED page with the shipped grey `:root` softened, or `null` when it carries none.
	///
	/// A daimon that edits a default page copies the old block verbatim, and a `:root` after
	/// the theme beats it, so the page would go grey on its first edit. Only a block that is
	/// byte for byte the shipped one is touched: a page whose `:root` differs by one byte keeps
	/// it, so a daimon's own value still wins (the 08-11 rule). The shipped link rule goes with
	/// it, because `--at` was blue only through that block and is the text ON an accent fill
	/// once the theme speaks. For DRAWING, as `adopt`: pure, never stored.
	function soften(html) {
		var s = String(html == null ? '' : html);
		if (s.indexOf(ROOT_WAS) === -1) return null;
		return s.split(ROOT_WAS).join(ROOT_SOFT).split(LINK_WAS).join(LINK_NOW);
	}

	/// The whole `<style>` element of every default the app has shipped, and of today's. All four
	/// shipped defaults carried the one style block (they differ in the policy meta, the theme
	/// function and the `open` key), so the list holds one; a release that changes the block
	/// again adds the old one here.
	var STYLES_WAS = [ '<style>\n' + CSS_WAS.join('\n') + '\n</style>' ];
	var STYLE_NOW  = '<style>\n' + CSS_NOW.join('\n') + '\n</style>';

	/// An EDITED page whose style block is still a shipped default's, byte for byte, with that
	/// block swapped for today's, or `null` when it holds none.
	///
	/// The likely edit is a daimon adding a paragraph, a script or a second `<style>`, and
	/// leaving the shipped block alone. Such a page takes the whole of today's look (fills for
	/// outlines, no bar on the quote, Condensed heads) and not only the palette that `soften`
	/// gives it. The match is the whole element, tags included, so a block with a rule added
	/// inside it, or one byte changed, is a hand edit and is left to `soften`. For DRAWING, as
	/// `adopt`: pure, never stored.
	function restyle(html) {
		var s = String(html == null ? '' : html), hit = false;
		for (var i = 0; i < STYLES_WAS.length; i++) {
			if (s.indexOf(STYLES_WAS[i]) === -1) continue;
			s = s.split(STYLES_WAS[i]).join(STYLE_NOW);
			hit = true;
		}
		return hit ? s : null;
	}

	/// The page to draw for a stored one: today's default for a shipped default, else the page
	/// with its intact shipped style block swapped for today's, else the page with its shipped
	/// `:root` softened, else the page itself.
	function draw(html) {
		return adopt(html) || restyle(html) || soften(html) || String(html == null ? '' : html);
	}

	/// Is this page the shipped default, of today or of any earlier release?
	function isDefault(html) {
		var s = String(html == null ? '' : html);
		return s === DEFAULT_PAGE || adopt(s) !== null;
	}

	// The page is assembled from four shared pieces, so the shipped page and the starter speak one
	// channel from one text: the head and its policy, the library (escaping, the markdown, the
	// generic view and the theme), the wire (height, the data message, links, `ready`), and the close.
	// DEFAULT_PAGE is byte for byte what it was before the split; `adopt` matches stored copies of it.
	var PAGE_OPEN = [
		'<!doctype html>',
		'<html><head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\';'
			+ ' script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">',
		'<style>',
	];
	var PAGE_LIB = [
		'var CORE=["title","summary","sections","facts","links"];',
		'var R=document.getElementById("r"),D={},L={},last=-1;',
		'function post(o){o.dc=1;o.v=1;parent.postMessage(o,"*");}',
		'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")',
		'.replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
		'function has(v){if(v==null)return false;',
		'if(typeof v==="string")return v.trim()!=="";',
		'if(typeof v==="number"||typeof v==="boolean")return true;',
		'if(Object.prototype.toString.call(v)==="[object Array]")return v.length>0;',
		'if(typeof v==="object"){for(var k in v)if(v.hasOwnProperty(k))return true;return false;}',
		'return false;}',
		// Links never navigate: the parent decides, because it is the only side
		// that can put the question to a person.
		'function anch(h,txt){return /^(https?:|mailto:)/i.test(h)',
		'?"<a data-h=\\""+h+"\\">"+txt+"</a>":txt;}',
		'function inl(s){s=esc(s);',
		's=s.replace(/`([^`]+)`/g,function(m,a){return "<code>"+a+"</code>";});',
		's=s.replace(/!\\[([^\\]]*)\\]\\((data:image\\/[^)\\s]+)\\)/g,',
		'function(m,a,b){return "<img alt=\\""+a+"\\" src=\\""+b+"\\">";});',
		's=s.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,function(m,a,b){return anch(b,a);});',
		's=s.replace(/\\*\\*([^*]+)\\*\\*/g,"<strong>$1</strong>");',
		's=s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g,"$1<em>$2</em>");',
		'return s;}',
		// Enough markdown for what a reducer writes: paragraphs, headings, lists,
		// quotes and fenced code. A `##` inside a fence stays inside it.
		'function md(src){var L2=String(src).split("\\n"),i=0,o="";',
		'while(i<L2.length){var l=L2[i];',
		'var f=/^ {0,3}(`{3,}|~{3,})/.exec(l);',
		'if(f){var c=f[1].charAt(0),n=f[1].length,b=[];i++;',
		'var re=new RegExp("^ {0,3}"+(c==="`"?"`":"~")+"{"+n+",}\\\\s*$");',
		'while(i<L2.length&&!re.test(L2[i])){b.push(L2[i]);i++;}i++;',
		'o+="<pre><code>"+esc(b.join("\\n"))+"</code></pre>";continue;}',
		'if(/^\\s*$/.test(l)){i++;continue;}',
		'var hm=/^ {0,3}(#{1,6})\\s+(.*)$/.exec(l);',
		'if(hm){var lv=Math.min(4,hm[1].length+2);',
		'o+="<h"+lv+">"+inl(hm[2])+"</h"+lv+">";i++;continue;}',
		'if(/^ {0,3}>\\s?/.test(l)){var q=[];',
		'while(i<L2.length&&/^ {0,3}>\\s?/.test(L2[i])){q.push(L2[i].replace(/^ {0,3}>\\s?/,""));i++;}',
		'o+="<blockquote>"+md(q.join("\\n"))+"</blockquote>";continue;}',
		'var LI=/^ {0,3}([-*+]|\\d+[.)])\\s+/;',
		'if(LI.test(l)){var ord=/^ {0,3}\\d/.test(l),it=[];',
		'while(i<L2.length&&LI.test(L2[i])){it.push("<li>"+inl(L2[i].replace(LI,""))+"</li>");i++;}',
		'o+=(ord?"<ol>":"<ul>")+it.join("")+(ord?"</ol>":"</ul>");continue;}',
		'var p=[];',
		'while(i<L2.length&&!/^\\s*$/.test(L2[i])&&!/^ {0,3}(`{3,}|~{3,})/.test(L2[i])',
		'&&!LI.test(L2[i])&&!/^ {0,3}>\\s?/.test(L2[i])&&!/^ {0,3}#{1,6}\\s/.test(L2[i]))',
		'{p.push(L2[i]);i++;}',
		'o+="<p>"+inl(p.join("\\n")).replace(/\\n/g,"<br>")+"</p>";}',
		'return o;}',
		// Anything at all, so a key the reducer invented is still on screen.
		'function val(v,d){',
		'if(typeof v==="string")return md(v);',
		'if(typeof v==="number"||typeof v==="boolean")return "<p>"+esc(v)+"</p>";',
		'if(v==null||d>=4)return "<pre>"+esc(JSON.stringify(v,null,2))+"</pre>";',
		'if(Object.prototype.toString.call(v)==="[object Array]"){var o="<ul>";',
		'for(var i=0;i<v.length;i++)o+="<li>"+val(v[i],d+1)+"</li>";return o+"</ul>";}',
		'if(typeof v==="object"){var o2="";',
		'for(var k in v){if(!v.hasOwnProperty(k))continue;',
		'o2+="<div class=\\"field\\"><div class=\\"k\\">"+esc(k)+"</div>"+val(v[k],d+1)+"</div>";}',
		'return o2;}',
		'return "<pre>"+esc(String(v))+"</pre>";}',
		// The palette arrives as DEFAULTS THE PAGE MAY OVERRIDE, written into a style
		// element at the top of the cascade -- not as inline properties on :root.
		// setProperty on documentElement is an inline style, and an inline style beats
		// the page's own `:root{--bg:#fff}` rule every time. A user asked for a white
		// background, the daimon set --bg and the app overwrote it on the next data
		// message, so the widget it added in the same turn worked and the colour did
		// not. A theme is what the page starts from, not what it is held to.
		'function theme(t){if(!t)return;var m={bg:"--bg",surface:"--sf",text:"--tx",',
		'muted:"--mu",border:"--bd",accent:"--ac",accentText:"--at",font:"--fo",',
		'mono:"--mo",size:"--fs",radius:"--rd"};',
		'var css="";for(var k in m)if(m.hasOwnProperty(k)&&t[k])',
		'css+=m[k]+":"+t[k]+";";',
		'var el=document.getElementById("dc-theme");',
		'if(!el){el=document.createElement("style");el.id="dc-theme";',
		'document.head.insertBefore(el,document.head.firstChild);}',
		'el.textContent=":root{"+css+"}";}',
	];
	var PAGE_WIRE = [
		'function measure(){var px=Math.ceil(Math.max(document.body.scrollHeight,',
		'R.getBoundingClientRect().height))+2;',
		'if(Math.abs(px-last)<2)return;last=px;post({cmd:"height",px:px});}',
		'addEventListener("message",function(e){if(e.source!==parent)return;',
		'var m=e.data;if(!m||m.dc!==1||m.v!==1)return;',
		'if(m.cmd==="data"){D=m.data||{};L=D._labels||{};theme(D._theme);render();}});',
		'document.addEventListener("click",function(e){var a=e.target;',
		'while(a&&a!==document.body&&a.tagName!=="A")a=a.parentNode;',
		'if(!a||a.tagName!=="A")return;e.preventDefault();',
		'var h=a.getAttribute("data-h")||"";if(h)post({cmd:"open",href:h});});',
		'if(window.ResizeObserver)new ResizeObserver(measure).observe(document.body);',
		'else addEventListener("resize",measure);',
		'post({cmd:"ready"});',
	];
	var PAGE_SHUT = [
		'})();',
		'<\/script></body></html>',
		'',
	];
	var PAGE_BODY = ['</style></head><body><div id="r"></div><script>', '(function(){'];
	var DEFAULT_PAGE = PAGE_OPEN.concat(CSS_NOW, PAGE_BODY, PAGE_LIB, [
		'function render(){var h="",keys=[],i;',
		'if(has(D.title)){keys.push("title");h+="<h1>"+esc(D.title)+"</h1>";}',
		'if(has(D.summary)){keys.push("summary");h+=md(D.summary);}',
		'if(has(D.sections)){keys.push("sections");',
		'for(i=0;i<D.sections.length;i++){var s=D.sections[i]||{};',
		'if(has(s.heading))h+="<h2>"+esc(s.heading)+"</h2>";',
		'if(has(s.body))h+=md(s.body);}}',
		'if(has(D.facts)){keys.push("facts");',
		'if(L.facts)h+="<h2>"+esc(L.facts)+"</h2>";h+="<div class=\\"facts\\">";',
		'for(i=0;i<D.facts.length;i++){var ft=D.facts[i]||{};',
		'h+="<div class=\\"k\\">"+esc(ft.k==null?"":ft.k)+"</div>";',
		'h+="<div class=\\"v\\">"+inl(ft.v==null?"":ft.v)+"</div>";}h+="</div>";}',
		'if(has(D.links)){keys.push("links");',
		'if(L.links)h+="<h2>"+esc(L.links)+"</h2>";h+="<ul>";',
		'for(i=0;i<D.links.length;i++){var lk=D.links[i]||{};',
		'var hr=esc(lk.href==null?"":lk.href);',
		'var lb=esc(lk.label==null||lk.label===""?(lk.href==null?"":lk.href):lk.label);',
		'h+="<li>"+anch(hr,lb)+"</li>";}h+="</ul>";}',
		'var xs=[];for(var k in D){if(!D.hasOwnProperty(k))continue;',
		'if(k.charAt(0)==="_")continue;if(CORE.indexOf(k)>=0)continue;',
		'if(!has(D[k]))continue;xs.push(k);}',
		'if(xs.length){if(L.other)h+="<h2>"+esc(L.other)+"</h2>";',
		'if(L.other_note)h+="<div class=\\"note\\">"+esc(L.other_note)+"</div>";',
		'for(i=0;i<xs.length;i++){keys.push(xs[i]);',
		'h+="<div class=\\"field\\"><div class=\\"k\\">"+esc(xs[i])+"</div>"',
		'+val(D[xs[i]],1)+"</div>";}}',
		'if(!h&&L.empty)h="<div class=\\"empty\\">"+esc(L.empty)+"</div>";',
		'R.innerHTML=h;post({cmd:"rendered",keys:keys});measure();}',
	], PAGE_WIRE, PAGE_SHUT).join('\n');


	// ── The starter page, which a daimon forks ──────────────────────
	//
	// D-20261008-08 (K4). The Ontheism daimon forked a hand-built page full of earlier hacks
	// (`loadSelf`, a re-ping, a `<pre>` dump of the data) and re-derived the handshake on every
	// retry. This is the page to fork instead: the same head, policy, library and wire as
	// DEFAULT_PAGE, plus a small set of infographic parts that are drawn from the crystal's own keys.
	// The app installs it at STARTER_PATH, where a fenced daimon may read it and never write it.
	//
	// The parts are a plain function, stringified into the page, so it is real code here (linted,
	// and testable in node) and has no free variable: everything it uses arrives as an argument.
	var STARTER_PATH = '.daimond/starters/crystal.html';

	function starterDraw(D, L, H) {
		var esc = H.esc, md = H.md, inl = H.inl, has = H.has, anch = H.anch;
		var keys = [], h = '', i, k;
		var isArr = function (v) { return Object.prototype.toString.call(v) === '[object Array]'; };
		var num = function (v) { var n = typeof v === 'number' ? v : parseFloat(String(v)); return isFinite(n) ? n : null; };
		var txt = function (v) { return v == null ? '' : String(v); };
		var img = function (s) { return /^data:image\//i.test(txt(s)) ? '<img alt="" src="' + esc(s) + '">' : ''; };
		// An icon is a data-URI image, else a short glyph, else the first letter in a disc.
		var icon = function (v, word) {
			var s = txt(v);
			if (/^data:image\//i.test(s)) return '<span class="ic">' + img(s) + '</span>';
			if (s && s.length <= 4) return '<span class="ic">' + esc(s) + '</span>';
			var c = esc((txt(word).trim().charAt(0) || '*').toUpperCase());
			return '<span class="ic"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15"/>'
				+ '<text x="16" y="21" text-anchor="middle">' + c + '</text></svg></span>';
		};
		var part = {
			// stats: [{label, value, max?, unit?}] as rings.
			stats: function (v) {
				var o = '<div class="rings">';
				for (var j = 0; j < v.length; j++) {
					var s = v[j] || {}, n = num(s.value), mx = num(s.max) || 100, f = n == null ? 0 : Math.max(0, Math.min(1, n / mx));
					o += '<figure class="ring"><svg viewBox="0 0 36 36" aria-hidden="true"><circle class="t" cx="18" cy="18" r="15.9"/>'
						+ '<circle class="f" cx="18" cy="18" r="15.9" stroke-dasharray="' + (f * 100).toFixed(1) + ' 100"/></svg>'
						+ '<b>' + esc(txt(s.value)) + esc(txt(s.unit)) + '</b><figcaption>' + inl(txt(s.label)) + '</figcaption></figure>';
				}
				return o + '</div>';
			},
			// ranked: [{label, value}] as bars, largest first.
			ranked: function (v) {
				var r = v.slice().sort(function (a, b) { return (num((b || {}).value) || 0) - (num((a || {}).value) || 0); });
				var top = Math.max.apply(null, r.map(function (x) { return Math.abs(num((x || {}).value) || 0); }).concat([1e-9]));
				var o = '<div class="bars">';
				for (var j = 0; j < r.length; j++) {
					var s = r[j] || {}, w = Math.round(100 * Math.abs(num(s.value) || 0) / top);
					o += '<div class="bar"><span class="bl">' + inl(txt(s.label)) + '</span><span class="bt"><i style="width:' + w + '%"></i></span>'
						+ '<span class="bv">' + esc(txt(s.value)) + '</span></div>';
				}
				return o + '</div>';
			},
			// timeline: [{when, what}] in the order given.
			timeline: function (v) {
				var o = '<ol class="tl">';
				for (var j = 0; j < v.length; j++) {
					var s = v[j] || {};
					o += '<li><span class="tw">' + esc(txt(s.when != null ? s.when : (s.date != null ? s.date : s.year))) + '</span>'
						+ '<div class="tx">' + md(txt(s.what != null ? s.what : (s.text != null ? s.text : s.label))) + '</div></li>';
				}
				return o + '</ol>';
			},
			// spectrum: {left, right, value 0..1 or 0..100, label}, or a list of them.
			spectrum: function (v) {
				var a = isArr(v) ? v : [v], o = '';
				for (var j = 0; j < a.length; j++) {
					var s = a[j] || {}, n = num(s.value), p = n == null ? 50 : (n > 1 ? n : n * 100);
					p = Math.max(0, Math.min(100, p));
					o += '<div class="sp">' + (has(s.label) ? '<div class="sl">' + inl(txt(s.label)) + '</div>' : '')
						+ '<div class="st"><i style="left:' + p.toFixed(1) + '%"></i></div>'
						+ '<div class="se"><span>' + esc(txt(s.left)) + '</span><span>' + esc(txt(s.right)) + '</span></div></div>';
				}
				return o;
			},
			// cards: [{icon, title, body}].
			cards: function (v) {
				var o = '<div class="cards">';
				for (var j = 0; j < v.length; j++) {
					var s = v[j] || {};
					o += '<div class="card">' + icon(s.icon, s.title) + '<div><h3>' + esc(txt(s.title)) + '</h3>' + md(txt(s.body)) + '</div></div>';
				}
				return o + '</div>';
			},
		};
		// Which part a key no part names fits, judged by its shape, so a new key still draws.
		var shape = function (v) {
			if (!isArr(v) || !v.length) return (v && typeof v === 'object' && 'left' in v && 'right' in v) ? 'spectrum' : '';
			var o = v[0];
			if (!o || typeof o !== 'object') return '';
			if ('when' in o || 'date' in o || 'year' in o) return 'timeline';
			if ('left' in o && 'right' in o) return 'spectrum';
			if (num(o.value) != null && 'label' in o) return 'ranked';
			if ('title' in o && ('body' in o || 'icon' in o)) return 'cards';
			return '';
		};
		// Anything else, without a `<pre>` or a run of JSON: a list of fields, as text.
		var gen = function (v, d) {
			if (typeof v === 'string') return /^data:image\//i.test(v) ? img(v) : md(v);
			if (typeof v === 'number' || typeof v === 'boolean') return '<p>' + esc(v) + '</p>';
			if (v == null) return '';
			if (isArr(v)) { var o = '<ul>'; for (var j = 0; j < v.length; j++) o += '<li>' + gen(v[j], d + 1) + '</li>'; return o + '</ul>'; }
			var o2 = '<dl class="kv">';
			for (var q in v) if (Object.prototype.hasOwnProperty.call(v, q)) o2 += '<dt>' + esc(q) + '</dt><dd>' + gen(v[q], d + 1) + '</dd>';
			return o2 + '</dl>';
		};
		var head = function (k2) { return '<h2>' + esc(L[k2] || k2.charAt(0).toUpperCase() + k2.slice(1).replace(/_/g, ' ')) + '</h2>'; };

		if (has(D.title) || has(D.summary) || has(D.image)) {
			h += '<header class="hero">';
			if (has(D.image)) { keys.push('image'); h += img(D.image); }
			if (has(D.title)) { keys.push('title'); h += '<h1>' + esc(D.title) + '</h1>'; }
			if (has(D.summary)) { keys.push('summary'); h += md(D.summary); }
			h += '</header>';
		}
		if (has(D.sections) && isArr(D.sections)) {
			keys.push('sections'); h += '<div class="cards">';
			for (i = 0; i < D.sections.length; i++) {
				var s = D.sections[i] || {};
				h += '<section class="card">' + icon(s.icon, s.heading) + '<div>' + (has(s.heading) ? '<h2>' + esc(s.heading) + '</h2>' : '')
					+ (has(s.body) ? md(s.body) : '') + '</div></section>';
			}
			h += '</div>';
		}
		var named = ['stats', 'cards', 'ranked', 'spectrum', 'timeline'];
		for (i = 0; i < named.length; i++) {
			k = named[i];
			if (!has(D[k])) continue;
			keys.push(k); h += head(k) + part[k](isArr(D[k]) || k === 'spectrum' ? D[k] : [D[k]]);
		}
		if (has(D.facts) && isArr(D.facts)) {
			keys.push('facts'); h += head('facts') + '<div class="facts">';
			for (i = 0; i < D.facts.length; i++) {
				var ft = D.facts[i] || {};
				h += '<div class="k">' + esc(txt(ft.k)) + '</div><div class="v">' + inl(txt(ft.v)) + '</div>';
			}
			h += '</div>';
		}
		if (has(D.links) && isArr(D.links)) {
			keys.push('links'); h += head('links') + '<ul>';
			for (i = 0; i < D.links.length; i++) {
				var lk = D.links[i] || {}, hr = esc(txt(lk.href));
				h += '<li>' + anch(hr, esc(has(lk.label) ? lk.label : txt(lk.href))) + '</li>';
			}
			h += '</ul>';
		}
		var done = ['title', 'summary', 'image', 'sections', 'facts', 'links'].concat(named);
		for (k in D) {
			if (!Object.prototype.hasOwnProperty.call(D, k) || k.charAt(0) === '_' || done.indexOf(k) >= 0 || !has(D[k])) continue;
			var sh = shape(D[k]);
			keys.push(k);
			h += head(k) + (sh ? part[sh](sh === 'spectrum' && !isArr(D[k]) ? D[k] : D[k]) : gen(D[k], 1));
		}
		if (!h && L.empty) h = '<div class="empty">' + esc(L.empty) + '</div>';
		return { html: h, keys: keys };
	}

	var STARTER_CSS = [
		'.hero{margin:0 0 1.2em}.hero img{display:block;max-height:220px;margin:0 0 .8em}',
		'.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:12px;margin:0 0 1em}',
		'.card{display:flex;gap:10px;align-items:flex-start;background:var(--sf,rgba(128,128,128,.10));border-radius:var(--rd,8px);padding:12px;min-width:0}',
		'.card>div{min-width:0}.card h2,.card h3{margin:0 0 .35em}.card>div>:last-child{margin-bottom:0}',
		'.ic{flex:0 0 32px;width:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;font-size:20px}',
		'.ic img,.ic svg{width:32px;height:32px;border-radius:50%}',
		'.ic circle{fill:var(--ac,#4a7fd0)}.ic text{fill:var(--at,#fff);font:600 16px var(--fo,system-ui,sans-serif)}',
		'.rings{display:flex;flex-wrap:wrap;gap:14px;margin:0 0 1em}',
		'.ring{position:relative;margin:0;width:104px;text-align:center}.ring svg{width:88px;height:88px;transform:rotate(-90deg)}',
		'.ring circle{fill:none;stroke-width:3.2}.ring .t{stroke:color-mix(in srgb,var(--tx,#777) 15%,transparent)}',
		'.ring .f{stroke:var(--ac,#4a7fd0);stroke-linecap:round}',
		'.ring b{position:absolute;left:0;right:0;top:30px;font-size:1.05em}.ring figcaption{color:var(--mu,#999);font-size:.88em}',
		'.bars{margin:0 0 1em}.bar{display:grid;grid-template-columns:minmax(0,9em) 1fr auto;gap:8px;align-items:center;margin:.3em 0}',
		'.bt{height:10px;border-radius:5px;background:color-mix(in srgb,var(--tx,#777) 12%,transparent);overflow:hidden}',
		'.bt i{display:block;height:100%;background:var(--ac,#4a7fd0);border-radius:5px}.bv{font-variant-numeric:tabular-nums}',
		'.tl{list-style:none;padding:0 0 0 18px;margin:0 0 1em;border-left:2px solid color-mix(in srgb,var(--tx,#777) 20%,transparent)}',
		'.tl li{position:relative;margin:0 0 .8em}.tl li:before{content:"";position:absolute;left:-24px;top:.45em;width:10px;height:10px;border-radius:50%;background:var(--ac,#4a7fd0)}',
		'.tw{color:var(--mu,#999);font-size:.88em}.tx>:last-child{margin-bottom:0}',
		'.sp{margin:0 0 1em}.st{position:relative;height:12px;border-radius:6px;background:linear-gradient(90deg,color-mix(in srgb,var(--ac,#4a7fd0) 25%,transparent),var(--ac,#4a7fd0))}',
		'.st i{position:absolute;top:-4px;width:6px;height:20px;margin-left:-3px;border-radius:3px;background:var(--tx,#777)}',
		'.se{display:flex;justify-content:space-between;color:var(--mu,#999);font-size:.88em}',
		'.kv{display:grid;grid-template-columns:auto 1fr;gap:.2em .9em;margin:0 0 .8em}.kv dt{color:var(--mu,#999)}.kv dd{margin:0;min-width:0}',
		'.kv dd>:last-child{margin-bottom:0}',
		'@media (max-width:420px){.bar{grid-template-columns:1fr auto}.bar .bt{grid-column:1/-1;grid-row:2}}',
	];

	var STARTER_PAGE = PAGE_OPEN.concat(CSS_NOW, STARTER_CSS, [
		'</style></head><body>',
		'<!-- The Daimond crystal starter. Fork it: keep the head, the channel and `ready`, change the parts. -->',
		'<!-- Its data arrives in the `data` message. It never reads a file and never fetches: no asset, no loadSelf. -->',
		'<!-- Every key it draws goes in `rendered`, and a key no part names still draws, by its shape. -->',
		'<!-- Parts: stats [{label,value,max,unit}], ranked [{label,value}], timeline [{when,what}], -->',
		'<!-- spectrum {left,right,value,label}, cards [{icon,title,body}], sections[].icon, image (a data URI). -->',
		'<div id="r"></div><script>', '(function(){',
	], PAGE_LIB, [
		'var DRAW=' + starterDraw.toString() + ';',
		'function render(){var o=DRAW(D,L,{esc:esc,md:md,inl:inl,has:has,anch:anch});',
		'R.innerHTML=o.html;post({cmd:"rendered",keys:o.keys});measure();}',
	], PAGE_WIRE, PAGE_SHUT).join('\n');


	// ── Export ──────────────────────────────────────────────────────

	window.DaimondCrystal = {
		setAssetReader: setAssetReader,
		setPassedStore: setPassedStore,
		markPassed:     markPassed,
		lastPassed:     lastPassed,
		CORE_KEYS:    CORE_KEYS,
		DEFAULT_PAGE: DEFAULT_PAGE,
		STARTER_PAGE: STARTER_PAGE,
		STARTER_PATH: STARTER_PATH,
		upgrade:      upgrade,
		adopt:        adopt,
		restyle:      restyle,
		soften:       soften,
		draw:         draw,
		isDefault:    isDefault,
		FALLBACK_MS:  FALLBACK_MS,
		PROTOCOL:     PROTOCOL,
		parse:        parse,
		toMarkdown:   toMarkdown,
		fromMarkdown: fromMarkdown,
		mount:        mount,
		unmount:      unmount,
		fallback:     fallback,
		render:       render,
		probeTable:   probeTable,
		probeResult:  probeResult,
		lookTable:    lookTable,
		proofVerdict: proofVerdict,
		traceText:    traceText,
		probePng:     probePng,
		probeSight:   probeSight,
		_shim:        shim,
		_armour:      armour,
		/// The policy every page is served under, so a verifier can assert the exact
		/// string rather than keeping a copy of it that can drift.
		PAGE_CSP:     PAGE_CSP,
		/// What is on screen, for a verifier: whether the page or the built-in view
		/// is up, why, which keys the page claimed, and where the policy was put in
		/// the page — `'doctype'` (after the doctype) or `'start'` (ahead of the page), with `carried`
		/// saying whether the author had already declared one. Never used by the app.
		_state: function () {
			if (!live) {
				return { mode: 'none', ready: false, reason: '', keys: [], height: 0, csp: null, faces: false };
			}
			if (live.done) {
				return {
					mode:   'fallback',
					ready:  true,
					reason: str(live.reason),
					keys:   (live.keys || []).slice(),
					height: 0,
					csp:    live.csp || null,
					faces:  false,
				};
			}
			return {
				mode:   'frame',
				ready:  !!live.ready,
				reason: '',
				keys:   (live.keys || []).slice(),
				undrawn: (live.undrawn || []).slice(),
				height: live.height || 0,
				csp:    live.csp || null,
				faces:  !!live.faces,
			};
		},
	};
})();
