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
 * THE VERB LIST IS FROZEN. `ready`, `asset`, `rendered`, `height`, `open`, and
 * that is all of it. Daimond has migrated crystal formats four times; none of
 * those tools work on a page, so a migration can rename a file but cannot
 * rewrite a model-authored page, and a sixth verb added later would be a verb
 * every existing page does not speak. There is deliberately no `ask` and no
 * write: a parent cannot verify user activation across the boundary, so a timer
 * in the page is indistinguishable from a click, and the ask-the-daimon box
 * therefore lives in app chrome BELOW the frame where a click is provably a
 * person.
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
 *     window.DaimondCrystal = { CORE_KEYS, DEFAULT_PAGE, FALLBACK_MS, PROTOCOL,
 *                               parse, toMarkdown, fromMarkdown,
 *                               mount, unmount, fallback }
 */
(function () {
	'use strict';

	/// The core schema, in the order everything renders it. Extra top-level keys
	/// are permitted and nothing may ever drop one it does not recognise.
	var CORE_KEYS = ['title', 'summary', 'sections', 'facts', 'open', 'links'];

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
	function themeOf(el) {
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
			open:       tr(opts, 'crystal.field_open', 'Open threads'),
			links:      tr(opts, 'crystal.field_links', 'Links'),
			other:      tr(opts, 'crystal.other_fields', 'Other fields'),
			other_note: tr(opts, 'crystal.other_fields_note',
				'Kept as they are, and shown here so nothing vanishes.'),
			empty:      tr(opts, 'crystal.empty', 'The crystal is empty. Steer it below to begin.'),
		};
	}

	/// The data as the page receives it: the model's keys untouched, the channel's
	/// two added, and any `_` key the model happened to write stripped — the
	/// underscore is reserved on the wire, so a crystal carrying `_theme` cannot
	/// dress itself up as the parent.
	function wireData(data, opts, el) {
		var d = obj(data), out = {};
		for (var k in d) {
			if (!own(d, k) || k.charAt(0) === '_') continue;
			out[k] = d[k];
		}
		out._theme  = themeOf(el);
		out._labels = labelsFor(opts);
		return out;
	}


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
	// moment ago. A line it was talked into leaving behind is exempt from the cap,
	// absent from the standing context, unseen by the reducer and unseen by the
	// fold diff — and it syncs to every device. `ask()` was dropped from the verb
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

	/// A page with the policy in it, and where it had to go.
	function armour(html) {
		var s = String(html);
		var carried = CSP_HAS.test(s);
		var m = /<head\b[^>]*>/i.exec(s);
		if (m) return insertCsp(s, m.index + m[0].length, 'head', carried);
		m = /<html\b[^>]*>/i.exec(s);
		if (m) return insertCsp(s, m.index + m[0].length, 'html', carried);
		m = /^\s*<!doctype\b[^>]*>/i.exec(s);
		if (m) return insertCsp(s, m[0].length, 'doctype', carried);
		return insertCsp(s, 0, 'start', carried);
	}

	function insertCsp(s, at, where, carried) {
		return {
			html:     s.slice(0, at) + CSP_META + s.slice(at),
			injected: true,
			carried:  carried,
			at:       where,
		};
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

		var frame = document.createElement('iframe');
		frame.className = 'crystal-frame';
		// `allow-scripts` and NOTHING else, ever. See the head of this file.
		frame.setAttribute('sandbox', 'allow-scripts');
		frame.setAttribute('referrerpolicy', 'no-referrer');
		frame.setAttribute('title', tr(opts, 'crystal.view_crystal', 'Crystal'));

		// The page cannot reach the network, whoever wrote it. See above.
		var armed = armour(page);
		var url = URL.createObjectURL(new Blob([armed.html], { type: PAGE_TYPE }));
		frame.src = url;
		wrap.appendChild(frame);
		el.appendChild(wrap);

		live = {
			el: el, opts: opts, data: data, frame: frame, url: url,
			// The record, not the page: `_state` reports this and nothing holds the
			// armoured text once the blob has it.
			csp: { policy: PAGE_CSP, injected: armed.injected, carried: armed.carried, at: armed.at },
			ready: false, reported: false, done: false, loads: 0, keys: [],
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
		if (window.MutationObserver) {
			live.watch = new MutationObserver(function () { sendData(); });
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
		toFrame({ cmd: 'data', data: wireData(live.data, live.opts, live.el) });
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

	/// A text file from this Diamond's scope, read for the page by the app. The
	/// path is vetted here before anybody is asked for anything: a page that asks
	/// for `../../other/crystal.json` gets an error, not a file.
	function onAsset(m) {
		var id = m.id;
		var rel = safePath(m.path);
		if (!rel) { toFrame({ id: id, error: 'path' }); return; }
		var reader = (live.opts && typeof live.opts.onAsset === 'function')
			? live.opts.onAsset : null;
		if (!reader) { toFrame({ id: id, error: 'unavailable' }); return; }
		var full = 'diamonds/' + str(live.opts.id) + '/' + rel;
		var mine = live;
		Promise.resolve().then(function () {
			return reader(full, rel);
		}).then(function (text) {
			if (live !== mine || live.done) return;
			toFrame({ id: id, text: str(text) });
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
	/// content in it, the page is showing less than the Diamond holds and the
	/// built-in view takes over — the one defect this design is shaped around is a
	/// key that vanishes from the display because nothing recognised it.
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
		var want = contentKeys(live.data);
		for (var j = 0; j < want.length; j++) {
			if (keys.indexOf(want[j]) < 0) { fell('partial'); return; }
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
		if (hasContent(d.open)) {
			drew++;
			body.appendChild(fieldHead(tr(opts, 'crystal.field_open', 'Open threads')));
			var ul = document.createElement('ul');
			ul.className = 'crystal-fb-open';
			var opens = arr(d.open);
			for (var oi = 0; oi < opens.length; oi++) {
				var li = document.createElement('li');
				li.textContent = str(opens[oi]);
				ul.appendChild(li);
			}
			body.appendChild(ul);
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
			var note = document.createElement('p');
			note.className = 'crystal-fb-extra-note';
			note.textContent = tr(opts, 'crystal.other_fields_note',
				'Kept as they are, and shown here so nothing vanishes.');
			extra.appendChild(note);
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
				'This Diamond\u2019s page did not show everything it holds, so its data is shown instead.')
			: tr(opts, 'crystal.page_failed',
				'This Diamond\u2019s page did not load, so its data is shown instead.');
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

	var DEFAULT_PAGE = [
		'<!doctype html>',
		'<html><head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width,initial-scale=1">',
		'<meta http-equiv="Content-Security-Policy" content="default-src \'none\';'
			+ ' script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:">',
		'<style>',
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
		'</style></head><body><div id="r"></div><script>',
		'(function(){',
		'var CORE=["title","summary","sections","facts","open","links"];',
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
		'if(has(D.open)){keys.push("open");',
		'if(L.open)h+="<h2>"+esc(L.open)+"</h2>";h+="<ul>";',
		'for(i=0;i<D.open.length;i++)h+="<li>"+inl(D.open[i]==null?"":D.open[i])+"</li>";',
		'h+="</ul>";}',
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
		'})();',
		'<\/script></body></html>',
		'',
	].join('\n');


	// ── Export ──────────────────────────────────────────────────────

	window.DaimondCrystal = {
		CORE_KEYS:    CORE_KEYS,
		DEFAULT_PAGE: DEFAULT_PAGE,
		upgrade:      upgrade,
		FALLBACK_MS:  FALLBACK_MS,
		PROTOCOL:     PROTOCOL,
		parse:        parse,
		toMarkdown:   toMarkdown,
		fromMarkdown: fromMarkdown,
		mount:        mount,
		unmount:      unmount,
		fallback:     fallback,
		/// The policy every page is served under, so a verifier can assert the exact
		/// string rather than keeping a copy of it that can drift.
		PAGE_CSP:     PAGE_CSP,
		/// What is on screen, for a verifier: whether the page or the built-in view
		/// is up, why, which keys the page claimed, and where the policy was put in
		/// the page — `'head'`, `'html'`, `'doctype'` or `'start'`, with `carried`
		/// saying whether the author had already declared one. Never used by the app.
		_state: function () {
			if (!live) {
				return { mode: 'none', ready: false, reason: '', keys: [], height: 0, csp: null };
			}
			if (live.done) {
				return {
					mode:   'fallback',
					ready:  true,
					reason: str(live.reason),
					keys:   (live.keys || []).slice(),
					height: 0,
					csp:    live.csp || null,
				};
			}
			return {
				mode:   'frame',
				ready:  !!live.ready,
				reason: '',
				keys:   (live.keys || []).slice(),
				height: live.height || 0,
				csp:    live.csp || null,
			};
		},
	};
})();
