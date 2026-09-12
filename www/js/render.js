/* ============================================================
   Daimond — rich markdown rendering + lightweight code highlighting
   ------------------------------------------------------------
   Self-contained, dependency-free (relies only on the already
   global `marked`).  Exposes:

       window.DaimondRender = { md, escapeHtml, sanitize,
                                foldScan, foldSegments, summaryText,
                                seamText, seamLine }

   `DaimondRender.md(text)` renders markdown to an HTML string with:
     - single-newline line breaks (marked `breaks: true`),
     - a small built-in syntax highlighter for common languages,
     - a "Copy" button on every fenced code block.

   Tables (and all other non-code markup) pass through untouched.

   `foldScan` / `foldSegments` do not render anything.  They read a
   model's `<details>` folds straight out of the raw text, so the chat
   can keep one control across a whole stream and so the key a fold is
   known by is derived the same way here as it is in Rust.  See
   dev/CONTRACT_FOLD.md §2.
   ============================================================ */
(function () {
	'use strict';

	/// What the app says. Only the copy button on a code block: everything else
	/// in this file is markup or a syntax-highlighter keyword.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	// ── HTML entity helpers ────────────────────────────────────

	/// Escape the five significant HTML characters.
	function escapeHtml(s) {
		return String(s)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	/// Reverse the entity encoding that `marked` applies to fenced
	/// code bodies, recovering the raw source text.
	function unescapeHtml(s) {
		return String(s)
			.replace(/&lt;/g, '<')
			.replace(/&gt;/g, '>')
			.replace(/&quot;/g, '"')
			.replace(/&#0?39;/g, "'")
			.replace(/&#x27;/gi, "'")
			.replace(/&amp;/g, '&');
	}

	// ── Language specifications ────────────────────────────────

	/// Build a lookup object from an array of words.
	function wordSet(arr) {
		var o = Object.create(null);
		for (var i = 0; i < arr.length; i++) o[arr[i]] = true;
		return o;
	}

	// Shared token regexes (sticky, matched at an explicit offset).
	var RE = {
		lineSlash:  /\/\/[^\n]*/y,
		blockC:     /\/\*[\s\S]*?\*\//y,
		lineHash:   /#[^\n]*/y,
		dStr:       /"(?:\\.|[^"\\\n])*"?/y,
		sStr:       /'(?:\\.|[^'\\\n])*'?/y,
		tplStr:     /`(?:\\.|[^`\\])*`?/y,
		pyTripleD:  /"""[\s\S]*?(?:"""|$)/y,
		pyTripleS:  /'''[\s\S]*?(?:'''|$)/y,
		num:        /0[xXbBoO][0-9a-fA-F_]+|(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y,
		ident:      /[A-Za-z_$][A-Za-z0-9_$]*/y,
		bashVar:    /\$\{[^}]*\}|\$[A-Za-z0-9_]+|\$[@*#?$!0-9]/y,
	};

	// Each rule is { re, cls }.  cls "ident" is classified further.
	var LANGS = {
		javascript: {
			upperType: true,
			keywords: wordSet([
				'var', 'let', 'const', 'function', 'return', 'if', 'else',
				'for', 'while', 'do', 'switch', 'case', 'break', 'continue',
				'new', 'typeof', 'instanceof', 'in', 'of', 'this', 'class',
				'extends', 'super', 'import', 'export', 'from', 'default',
				'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
				'delete', 'void', 'static', 'get', 'set',
			]),
			types: wordSet([]),
			literals: wordSet(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']),
			rules: [
				{ re: RE.blockC, cls: 'comment' },
				{ re: RE.lineSlash, cls: 'comment' },
				{ re: RE.tplStr, cls: 'string' },
				{ re: RE.dStr, cls: 'string' },
				{ re: RE.sStr, cls: 'string' },
				{ re: RE.num, cls: 'number' },
				{ re: RE.ident, cls: 'ident' },
			],
		},
		rust: {
			upperType: true,
			keywords: wordSet([
				'fn', 'let', 'mut', 'const', 'static', 'struct', 'enum',
				'trait', 'impl', 'for', 'while', 'loop', 'if', 'else',
				'match', 'return', 'break', 'continue', 'use', 'mod', 'pub',
				'crate', 'self', 'Self', 'super', 'as', 'where', 'ref',
				'move', 'dyn', 'async', 'await', 'unsafe', 'extern', 'type',
				'in', 'box',
			]),
			types: wordSet([
				'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
				'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
				'f32', 'f64', 'bool', 'char', 'str', 'String',
				'Vec', 'Option', 'Result', 'Box', 'Rc', 'Arc', 'HashMap',
				'BTreeMap', 'Outcome',
			]),
			literals: wordSet(['true', 'false', 'Some', 'None', 'Ok', 'Err']),
			rules: [
				{ re: RE.blockC, cls: 'comment' },
				{ re: RE.lineSlash, cls: 'comment' },
				{ re: RE.dStr, cls: 'string' },
				{ re: RE.sStr, cls: 'string' },
				{ re: RE.num, cls: 'number' },
				{ re: RE.ident, cls: 'ident' },
			],
		},
		python: {
			upperType: true,
			keywords: wordSet([
				'def', 'return', 'if', 'elif', 'else', 'for', 'while',
				'break', 'continue', 'pass', 'import', 'from', 'as', 'class',
				'try', 'except', 'finally', 'raise', 'with', 'lambda',
				'global', 'nonlocal', 'yield', 'del', 'in', 'is', 'not',
				'and', 'or', 'assert', 'async', 'await',
			]),
			types: wordSet([
				'int', 'float', 'str', 'bool', 'list', 'dict', 'tuple',
				'set', 'bytes', 'object',
			]),
			literals: wordSet(['True', 'False', 'None', 'self', 'cls']),
			rules: [
				{ re: RE.lineHash, cls: 'comment' },
				{ re: RE.pyTripleD, cls: 'string' },
				{ re: RE.pyTripleS, cls: 'string' },
				{ re: RE.dStr, cls: 'string' },
				{ re: RE.sStr, cls: 'string' },
				{ re: RE.num, cls: 'number' },
				{ re: RE.ident, cls: 'ident' },
			],
		},
		bash: {
			upperType: false,
			keywords: wordSet([
				'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until',
				'do', 'done', 'case', 'esac', 'function', 'in', 'select',
				'return', 'break', 'continue', 'local', 'export', 'declare',
				'readonly', 'source', 'alias', 'unset', 'set', 'echo', 'cd',
				'exit', 'trap',
			]),
			types: wordSet([]),
			literals: wordSet(['true', 'false']),
			rules: [
				{ re: RE.lineHash, cls: 'comment' },
				{ re: RE.bashVar, cls: 'type' },
				{ re: RE.dStr, cls: 'string' },
				{ re: RE.sStr, cls: 'string' },
				{ re: RE.num, cls: 'number' },
				{ re: RE.ident, cls: 'ident' },
			],
		},
		json: {
			upperType: false,
			keywords: wordSet([]),
			types: wordSet([]),
			literals: wordSet(['true', 'false', 'null']),
			rules: [
				{ re: RE.dStr, cls: 'string' },
				{ re: RE.num, cls: 'number' },
				{ re: RE.ident, cls: 'ident' },
			],
		},
	};

	// Map common aliases to canonical language keys.
	var ALIAS = {
		js: 'javascript', javascript: 'javascript', node: 'javascript',
		jsx: 'javascript', mjs: 'javascript', ts: 'javascript',
		typescript: 'javascript', tsx: 'javascript',
		rs: 'rust', rust: 'rust',
		py: 'python', python: 'python',
		sh: 'bash', shell: 'bash', bash: 'bash', zsh: 'bash', console: 'bash',
		json: 'json', jsonc: 'json', json5: 'json',
	};

	/// Resolve a fence language token to a canonical key, or '' if
	/// unsupported.
	function canonLang(tok) {
		if (!tok) return '';
		return ALIAS[tok.toLowerCase()] || '';
	}

	// ── Highlighter ────────────────────────────────────────────

	/// Classify a bare identifier against a language spec.
	function classifyIdent(word, spec) {
		if (spec.keywords[word]) {
			return '<span class="tok-keyword">' + escapeHtml(word) + '</span>';
		}
		if (spec.literals[word]) {
			return '<span class="tok-literal">' + escapeHtml(word) + '</span>';
		}
		if (spec.types[word]) {
			return '<span class="tok-type">' + escapeHtml(word) + '</span>';
		}
		if (spec.upperType && /^[A-Z]/.test(word)) {
			return '<span class="tok-type">' + escapeHtml(word) + '</span>';
		}
		return escapeHtml(word);
	}

	/// Highlight raw code for a canonical language.  Unknown or empty
	/// languages fall back to a plain HTML-escaped render.  Never
	/// throws.
	function highlight(code, lang) {
		var spec = LANGS[lang];
		if (!spec) return escapeHtml(code);
		var out = '';
		var i = 0;
		var n = code.length;
		var rules = spec.rules;
		var guard = 0;
		while (i < n) {
			// Safety valve against any pathological zero-width match.
			if (++guard > n + 16) { out += escapeHtml(code.slice(i)); break; }
			var matched = false;
			for (var r = 0; r < rules.length; r++) {
				var rule = rules[r];
				rule.re.lastIndex = i;
				var m = rule.re.exec(code);
				if (m && m.index === i && m[0].length > 0) {
					var txt = m[0];
					if (rule.cls === 'ident') {
						out += classifyIdent(txt, spec);
					} else {
						out += '<span class="tok-' + rule.cls + '">' +
							escapeHtml(txt) + '</span>';
					}
					i += txt.length;
					matched = true;
					break;
				}
			}
			if (!matched) {
				out += escapeHtml(code.charAt(i));
				i++;
			}
		}
		return out;
	}

	// ── Code-block enhancement ─────────────────────────────────

	// Matches a marked-emitted fenced code block.  The body is already
	// entity-escaped by marked, so `</code></pre>` is unambiguous.
	var CODE_RE = /<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g;

	/// Replace each `<pre><code>` block with a titled container that
	/// carries a language label, a copy button, and highlighted code.
	function enhanceCodeBlocks(html) {
		return html.replace(CODE_RE, function (whole, attrs, body) {
			try {
				var tok = '';
				var cm = /class="([^"]*)"/.exec(attrs);
				if (cm) {
					var lm = /language-([A-Za-z0-9_+#.-]+)/.exec(cm[1]);
					if (lm) tok = lm[1];
				}
				var lang = canonLang(tok);
				// Recover the raw source, dropping the trailing newline
				// that marked appends.
				var raw = unescapeHtml(body).replace(/\n$/, '');
				var hi = highlight(raw, lang);
				var label = tok ? tok.toLowerCase() : 'text';
				// Raw code parked in a data attribute for the copy button;
				// escapeHtml makes it attribute-safe and it decodes back to
				// the exact source via getAttribute().
				var enc = escapeHtml(raw);
				return '<div class="code-block" data-lang="' + escapeHtml(label) + '">' +
					'<div class="code-block-head">' +
					'<span class="code-block-lang">' + escapeHtml(label) + '</span>' +
					'<button class="code-copy-btn" type="button" data-code="' + enc + '">'
						+ escapeHtml(t('common.copy')) + '</button>' +
					'</div>' +
					'<pre><code>' + hi + '</code></pre>' +
					'</div>';
			} catch (e) {
				// Never lose the content on an odd edge case.
				return whole;
			}
		});
	}

	// ── Sanitisation (H5: escape-by-default) ───────────────────
	// The rendered surface is now the whole app, so model output must
	// never introduce live markup.  `marked` passes raw HTML through
	// untouched, so its output is sanitised against a tag/attribute
	// whitelist before it ever reaches the DOM.  A `<template>` holds
	// the parse inertly (no scripts run, no resources load); any tag
	// outside the whitelist is reduced to its text, dangerous elements
	// are dropped whole, and only vetted attributes and URLs survive.

	// Inline formatting, lists, headings, tables, code — the shape of
	// ordinary markdown output, nothing that can execute.
	//
	// DETAILS and SUMMARY are here because a model that writes a fold was
	// being punished for it.  Neither tag was on this list nor on TAG_DROP,
	// so a `<details>` fell to the unknown-wrapper branch in `scrub` and the
	// WHOLE fold — every heading, list, code block and paragraph inside it —
	// was replaced by one unformatted text node.  That is worse than not
	// folding at all: the markup a reader would have seen without the fold is
	// destroyed by the attempt to add one.  Both tags are inert (a disclosure
	// widget the browser opens and closes; no script, no fetch, no navigation),
	// so admitting them costs nothing this list exists to withhold.
	var TAG_OK = wordSet([
		'A', 'ABBR', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DETAILS', 'DIV',
		'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'KBD',
		'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG', 'SUB', 'SUMMARY', 'SUP',
		'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',
	]);
	// Elements dropped whole (content and all), never merely unwrapped.
	var TAG_DROP = wordSet([
		'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META',
		'TEMPLATE', 'NOSCRIPT', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA',
		'SELECT', 'SVG', 'MATH',
	]);
	// Attributes safe on any allowed element.
	var ATTR_OK = wordSet(['CLASS', 'TITLE', 'ALT', 'ALIGN']);

	/// True when a URL is safe to keep — http(s), mailto, in-page or
	/// root-relative, or an inline image data URI.  Everything else
	/// (notably `javascript:`) is rejected.
	function safeUrl(u) {
		var v = String(u == null ? '' : u).trim();
		if (/^(https?:|mailto:|#|\/)/i.test(v)) return true;
		if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(v)) return true;
		return false;
	}

	/// Recursively scrub a node's children in place against the
	/// whitelist.  Elements are visited on a static snapshot so
	/// live-collection surprises cannot skip a node.
	function scrub(node) {
		var kids = Array.prototype.slice.call(node.childNodes);
		for (var i = 0; i < kids.length; i++) {
			var ch = kids[i];
			if (ch.nodeType === 8) { node.removeChild(ch); continue; } // comment
			if (ch.nodeType !== 1) continue;                            // keep text
			var tag = ch.tagName;
			if (TAG_DROP[tag]) { node.removeChild(ch); continue; }
			// A `<summary>` anywhere but directly inside a `<details>` is a
			// disclosure label with nothing to disclose.  The browser still
			// draws the triangle, so it reads as a control and does nothing
			// when pressed — a lie about what is on screen.  It takes the same
			// treatment as an unknown wrapper, for the same reason: the words
			// are the reader's, the markup is not to be trusted.
			var orphanSummary = (tag === 'SUMMARY' && node.nodeName !== 'DETAILS');
			if (!TAG_OK[tag] || orphanSummary) {
				// Unknown wrapper: keep the text, discard the markup.
				node.replaceChild(document.createTextNode(ch.textContent || ''), ch);
				continue;
			}
			var attrs = Array.prototype.slice.call(ch.attributes);
			for (var a = 0; a < attrs.length; a++) {
				var name = attrs[a].name;
				var up = name.toUpperCase();
				var keep = ATTR_OK[up];
				if (!keep && up === 'HREF' && tag === 'A') keep = safeUrl(attrs[a].value);
				if (!keep && up === 'SRC' && tag === 'IMG') keep = safeUrl(attrs[a].value);
				// The one attribute a fold needs: `open` says whether it starts
				// expanded, which is the model's call and not the renderer's.
				// Scoped to its element like HREF and SRC above, so it does not
				// become a spare attribute anybody may write on anything.
				if (!keep && up === 'OPEN' && tag === 'DETAILS') keep = true;
				if (!keep) ch.removeAttribute(name);
			}
			if (tag === 'A') ch.setAttribute('rel', 'noopener noreferrer nofollow');
			// Stamped rather than left to a bare `details` selector in the
			// stylesheet, because the app draws a `<details>` of its own — the
			// release notes' list of sealed builds — and that one must keep the
			// browser's look rather than inherit a model's.
			if (tag === 'DETAILS') ch.classList.add('md-fold');
			scrub(ch);
		}
	}

	/// Sanitise an HTML string, returning safe HTML.  Falls back to a
	/// fully-escaped render if the DOM APIs are unavailable.
	function sanitize(html) {
		if (typeof document === 'undefined' || !document.createElement) {
			return escapeHtml(html);
		}
		var tpl = document.createElement('template');
		tpl.innerHTML = String(html == null ? '' : html);
		scrub(tpl.content);
		return tpl.innerHTML;
	}

	// ── A model's own fold, read out of the text ───────────────
	//
	// The chat draws a streaming fold as a real `<details>` that it KEEPS across
	// frames, so it has to know where a fold begins before `marked` has turned
	// anything into markup.  The same scan names the fold, and that name has to
	// agree character for character with the Rust half that strips a closed
	// fold's body out of the next payload -- dev/CONTRACT_FOLD.md §2, pinned by
	// dev/fixtures/fold_keys.json.
	//
	// Nothing here touches the DOM, and that is the point.  A DOM parse decodes
	// entities, lowercases tag names and normalises attributes; the Rust half
	// does none of those, so a key taken off a parsed tree would part company
	// with a key taken off the text exactly where a summary happened to contain
	// an `&`.

	// A CommonMark fence: three or more backticks or tildes, up to three spaces
	// of indent, and -- for backticks -- an info string with no backtick in it.
	var FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
	var DETAILS_TOK = /<details(?:\s[^>]*)?>|<\/details\s*>/gi;
	// Sticky: the label has to be the FIRST thing inside the element, or the
	// `<details>` is a disclosure with nothing on its front and takes no ordinal.
	var SUMMARY_AT = /\s*<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary\s*>/iy;
	// `open` as an attribute of its own, not the tail of `data-open` and not the
	// word inside `class="reopen"`.
	var OPEN_ATTR = /\sopen(?=[\s=>])/i;

	/// The half-open character ranges that fenced code covers, the fence lines
	/// included.  A `<details>` inside one is a model SHOWING markup rather than
	/// writing it, and it is not a fold.
	function fencedRanges(src) {
		var out = [], lines = src.split('\n'), pos = 0, open = '', openAt = 0;
		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var end = pos + line.length + (i < lines.length - 1 ? 1 : 0);
			var m = FENCE.exec(line);
			if (!open) {
				if (m && !(m[1].charAt(0) === '`' && m[2].indexOf('`') >= 0)) {
					open = m[1]; openAt = pos;
				}
			} else if (m && m[1].charAt(0) === open.charAt(0) && m[1].length >= open.length
					&& /^[ \t]*$/.test(m[2])) {
				out.push([openAt, end]);
				open = '';
			}
			pos = end;
		}
		// A fence still open at the end of the buffer runs to the end of it. That
		// is the ordinary mid-stream case, and it is why a half-written code block
		// showing a fold never briefly grows one.
		if (open) out.push([openAt, src.length]);
		return out;
	}

	function inRanges(ranges, i) {
		for (var r = 0; r < ranges.length; r++) {
			if (i >= ranges[r][0] && i < ranges[r][1]) return true;
		}
		return false;
	}

	/// A `<summary>`'s words: tags out, ends trimmed, every internal run of
	/// whitespace one space.  Not lowercased, not truncated, not decoded.
	function summaryText(raw) {
		return String(raw == null ? '' : raw)
			.replace(/<[^>]*>/g, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	/// Every TOP-LEVEL fold in `text`, in the order the openings appear, each with
	/// the key both halves of the app know it by.
	///
	/// A fold left unclosed -- the ordinary case mid-stream -- keys exactly as a
	/// closed one does and its body runs to the end of what has arrived, so the
	/// name does not change under the reader when `</details>` finally lands.
	function foldScan(text) {
		var src = String(text == null ? '' : text);
		var fenced = fencedRanges(src);
		var stack = [], found = [], m;
		DETAILS_TOK.lastIndex = 0;
		while ((m = DETAILS_TOK.exec(src)) !== null) {
			if (inRanges(fenced, m.index)) continue;
			if (m[0].charAt(1) === '/') {
				var done = stack.pop();
				if (done) { done.bodyEnd = m.index; done.end = m.index + m[0].length; }
				continue;
			}
			var top = stack.length === 0;
			SUMMARY_AT.lastIndex = m.index + m[0].length;
			var sm = SUMMARY_AT.exec(src);
			// An unlabelled `<details>` still nests, so it goes on the stack and
			// claims its own `</details>`; it simply is not a fold.
			if (!sm) { stack.push(null); continue; }
			var fold = {
				ord:	0,
				key:	'',
				summary: '',
				label:	sm[1],			// the summary's inner markup, as written
				body:	'',
				open:	OPEN_ATTR.test(m[0]),	// the model asked for it expanded
				start:	m.index,
				bodyStart: SUMMARY_AT.lastIndex,
				bodyEnd: -1,
				end:	-1,
			};
			// A fold inside a fold takes no ordinal, no key and no strip of its own
			// (dev/CONTRACT_FOLD.md §8): the outer body is what travels or does
			// not, and an inner fold goes with it. It still goes on the stack, or
			// the outer one would pair with the WRONG closing tag and the two
			// halves would disagree about where the fold ends.
			if (top) found.push(fold);
			stack.push(fold);
		}
		for (var i = 0; i < found.length; i++) {
			var f = found[i];
			f.ord = i;
			f.summary = summaryText(f.label);
			f.key = i + ':' + f.summary;
			f.body = (f.bodyEnd < 0 ? src.slice(f.bodyStart)
				: src.slice(f.bodyStart, f.bodyEnd)).trim();
		}
		return found;
	}

	/// Could what follows an unfinished `<details>` still turn into a fold?
	///
	/// MEASURED, not assumed: between `<details>` arriving and `</summary>`
	/// arriving there are a few frames in which the element is real markup with a
	/// half-typed label, and the HTML parser auto-closes it at the end of the
	/// fragment.  So `marked` draws a closed disclosure whose label grows, and the
	/// control proper then replaces it -- a fold that appears shut and snaps open,
	/// for no reason a reader can see.  Those frames draw nothing at all instead.
	///
	/// Only while it could STILL become a fold.  A `<details>` that is plainly
	/// never going to have a label is drawn at once, or a model that wrote a bare
	/// one by mistake would have the rest of its answer held back for ever.
	function foldPending(rest) {
		if (/<\/summary\s*>/i.test(rest)) return false;		// it already has one
		var r = rest.replace(/^\s+/, '');
		if (r === '') return true;
		if (/^<summary(?:\s[^>]*)?>/i.test(r)) return true;		// inside the label
		// Part way through writing the tag that opens it.
		return /^<[a-z]*(?:\s[^>]*)?$/i.test(r)
			&& '<summary'.indexOf(r.split(/[\s>]/)[0]) === 0;
	}

	// ── The seam the APP places ────────────────────────────────
	//
	// Three wordings by three authors asked the model to write the `<details>`
	// itself, and 5 answers in 76 carried one (dev/PROMPT_NOTES.md §5,
	// dev/REGISTER_NOTES.md §11).  So the markup is the app's now and the model
	// writes one line: `Fold:` and a sentence or two of what the working below it
	// concludes.  Everything under `foldScan` is unchanged -- the line is expanded
	// into exactly the element a model used to write, and the key, the strip and
	// the drawing never learn that anything is different.
	//
	// **The app refuses more often than it folds, and that is the point.**  A
	// length threshold applied blindly produces FOLD-ALL, which
	// dev/CONTRACT_FOLD.md §5 calls worse than no control at all.  So the two
	// failures a wording could never prevent are unreachable here instead: with
	// too little above the line, or too few words in the summary, or too little
	// below it, there is no fold and the sentence is left as prose.

	// Enough above the seam to be an answer.  The same 40 characters
	// `dev/probe_notes.mjs` calls FOLD-ALL below, measured the same way -- the
	// whitespace collapsed and the ends trimmed -- because it is the same rule.
	var SEAM_LEAD_MIN  = 40;
	// Enough below it to be worth a control.  CONTRACT_FOLD.md §5's carve-out: an
	// answer with no second depth opens on nothing.
	var SEAM_BODY_MIN  = 240;
	// A summary is a summary and not a label (§13).
	var SEAM_WORDS_MIN = 6;

	/// The summary a `Fold:` line carries, or `null` if the line is not one.
	///
	/// Generous in what it accepts, because a model that has understood the note
	/// and reached for a heading or for bold should not lose its fold over the
	/// decoration: `Fold:`, `**Fold:**`, `## Fold:` and `_Fold:_` all seam.  What
	/// it will not accept is a line whose summary is empty.
	function seamLine(line) {
		var s = String(line == null ? '' : line);
		if (/^ {4,}|^\t/.test(s)) return null;		// an indented code block
		s = s.replace(/^ {0,3}/, '').replace(/^#{1,6}[ \t]+/, '');
		var lead = /^(\*\*|__|\*|_)/.exec(s);
		if (lead) s = s.slice(lead[1].length);
		if (!/^Fold[ \t]*:/i.test(s)) return null;
		var rest = s.slice(s.indexOf(':') + 1);
		var shut = /^(\*\*|__|\*|_)/.exec(rest);
		if (shut) rest = rest.slice(shut[1].length);
		else if (lead) {
			var tail = new RegExp('(\\*\\*|__|\\*|_)$').exec(rest);
			if (tail) rest = rest.slice(0, rest.length - tail[1].length);
		}
		rest = rest.replace(/\s+/g, ' ').trim();
		return rest ? rest : null;
	}

	/// How much of `t` a reader would actually see, measured as the ladder measures
	/// the text above a fold.
	function seamVisible(t) { return String(t == null ? '' : t).replace(/\s+/g, ' ').trim().length; }

	/// `text` with the model's `Fold:` line turned into the element it stands for.
	///
	/// Four outcomes and only one of them is a fold:
	///
	/// - **no line, or the model wrote its own `<details>`** — the text is returned
	///   untouched, so an answer that folded itself is never folded twice;
	/// - **the line is there and the answer qualifies** — one top-level fold,
	///   blank lines and all, exactly as CONTRACT_FOLD.md §1 wants it;
	/// - **it does not qualify** — the line loses its `Fold:` and stays as prose.
	///   Nothing is hidden and nothing is lost;
	/// - **it does not qualify YET, mid-stream** — the line is held back, the way
	///   `foldPending` holds back a half-written `<details>`, because a fold that
	///   appears and then unwinds is worse than one that arrives late.
	///
	/// `settled` says no more text is coming, which is what tells the third case
	/// from the fourth.
	function seamText(src, settled) {
		var s = String(src == null ? '' : src);
		if (!/fold[ \t]*:/i.test(s)) return s;
		// A model that wrote the markup itself has already placed its seam.
		if (s.indexOf('<details') >= 0 && foldScan(s).length) return s;
		// Every `Fold:` line outside a fence, with where it starts and what it says.
		// A fenced one is a model showing the convention rather than using it, which
		// is the rule `fencedRanges` already carries for `<details>`.
		var fenced = fencedRanges(s), lines = s.split('\n'), at = 0, marks = [];
		for (var i = 0; i < lines.length; i++) {
			var got = inRanges(fenced, at) ? null : seamLine(lines[i]);
			if (got !== null) marks.push({ line: i, at: at, len: lines[i].length, sum: got });
			at += lines[i].length + 1;
		}
		if (!marks.length) return s;
		// The later ones are prose: only the first is the seam, and a second would
		// otherwise reach the reader with its marker still on it.
		var bare = function (from) {
			var keep = lines.slice(0);
			for (var k = 0; k < marks.length; k++) {
				if (marks[k].line >= from) keep[marks[k].line] = marks[k].sum;
			}
			return keep.join('\n');
		};
		var head = marks[0];
		var above = s.slice(0, head.at);
		var body  = s.slice(head.at + head.len + 1);
		// A summary carrying the very tags this builds would close the element
		// early and leave the rest of the answer outside it.
		if (/<\/?(summary|details)/i.test(head.sum)
			|| head.sum.split(/\s+/).length < SEAM_WORDS_MIN
			|| seamVisible(above) < SEAM_LEAD_MIN) {
			return bare(0);
		}
		if (seamVisible(body) < SEAM_BODY_MIN) {
			return settled ? bare(0) : s.slice(0, head.at);
		}
		var rest = bare(head.line + 1).split('\n').slice(head.line + 1).join('\n');
		return above.replace(/\s+$/, '')
			+ '\n\n<details>\n<summary>' + head.sum + '</summary>\n\n'
			+ rest.replace(/^\s+/, '').replace(/\s+$/, '')
			+ '\n\n</details>';
	}

	/// `text` cut into the pieces the chat draws: runs of ordinary markdown, and
	/// the TOP-LEVEL folds between them.
	///
	/// A nested fold stays inside its parent's body and is drawn there in the
	/// ordinary way -- it has no key of its own to be drawn against.
	///
	/// `settled` says no more text is coming, which turns off the hold-back in
	/// `foldPending`: a turn that died half way through a `<summary>` should show
	/// the words that did arrive rather than wait for a frame that never comes.
	function foldSegments(text, settled) {
		// The app's own seam first, so everything below this line is looking at
		// one kind of fold and not two.
		var src = seamText(text, settled);
		var all = foldScan(src), segs = [], at = 0;
		for (var i = 0; i < all.length; i++) {
			var f = all[i];
			if (f.start < at) continue;			// already inside one that is drawn
			if (f.start > at) segs.push({ kind: 'text', text: src.slice(at, f.start) });
			segs.push({
				kind: 'fold', ord: f.ord, key: f.key, summary: f.summary,
				label: f.label, body: f.body, open: f.open, closed: f.end >= 0,
			});
			at = f.end >= 0 ? f.end : src.length;
		}
		if (at < src.length) {
			var tail = src.slice(at), cut = tail.length;
			// The guard keeps the ordinary answer -- the overwhelming
			// majority, which has no fold in it at all -- off a second line scan
			// of the whole message on every frame of every stream.
			if (!settled && /<details/i.test(tail)) {
				// The LAST opener in what is left is the only one that can still be
				// being written; everything before it has had its chance.
				var fenced = fencedRanges(src), mm, openAt = -1, openEnd = 0;
				DETAILS_TOK.lastIndex = 0;
				while ((mm = DETAILS_TOK.exec(tail)) !== null) {
					if (mm[0].charAt(1) === '/' || inRanges(fenced, at + mm.index)) continue;
					openAt = mm.index; openEnd = mm.index + mm[0].length;
				}
				if (openAt >= 0 && foldPending(tail.slice(openEnd))) cut = openAt;
			}
			if (cut > 0) segs.push({ kind: 'text', text: tail.slice(0, cut) });
		}
		return segs;
	}

	// ── Math (LaTeX spans) ─────────────────────────────────────
	//
	// A model answering with `$x^2$` or `$$x^2$$` used to print as literal
	// dollars: `marked` treats the delimiters as ordinary text and the chat had
	// no KaTeX, so the reader saw the markup.  The pass here extracts every
	// CLOSED equation span out of the raw markdown BEFORE `marked` can mangle
	// it, parks the LaTeX behind an inert placeholder, and substitutes real
	// KaTeX markup back in AFTER sanitisation.  KaTeX's own output is trusted
	// post-sanitise by construction and the sanitiser never sees it: `trust:
	// false` kills \href and friends, and `throwOnError: false` turns a bad
	// expression into a styled error span with no payload — there is nothing
	// left for a sanitiser to remove, so a later reader must NOT "improve" the
	// order to run the substitution before scrub, or the whitelist would have
	// to admit KaTeX's subtree (see the XSS checks in dev/verify_render.mjs).
	// A span with no closing delimiter is left alone: mid-stream a half-written
	// `$$` must not vanish, and `settled` does not gate this pass — "unclosed"
	// simply means "not yet".  Without KaTeX vendored the feature degrades to
	// exactly today's literal dollars rather than to nothing.

	// One opening delimiter.  A set-free scan because a bag of regex
	// alternatives at one `exec` would mispair a closing `$$` with an earlier
	// opening `$`.  The inline dollar's first guard lives in the pattern (no
	// whitespace after the opening `$`); the closing side has BOTH guards
	// (no whitespace before, no digit after).
	var MATH_OPEN = [
		{ re: /\$\$/y,      display: true  },
		{ re: /\\\[/y,      display: true  },
		{ re: /\$(?!\s)/y,  display: false },
		{ re: /\\\(/y,      display: false },
	];

	var MATH_CLOSE = [
		{ re: /\$\$/y,      display: true,  len: 2 },
		{ re: /\\\]/y,      display: true,  len: 2 },
		{ re: /(?<!\s)\$(?!\d)/y, display: false, len: 1 },
		{ re: /\\\)/y,      display: false, len: 2 },
	];

	/// Every closed `$…$`, `$$…$$`, `\(…\)` and `\[…\]` span in `src`, in
	/// document order, each with the raw LaTeX (delimiters excluded), whether it
	/// is display mode, and the half-open range the whole delimited span
	/// occupies.  Fenced code and inline code are skipped (the same rule that
	/// keeps a `<details>` inside a fence from being a fold), and a `\$`
	/// escape stays literal.
	/// Inline-code ranges: each `…` span, so LaTeX being *discussed* in
	/// backticks never renders as an equation once the close search works.
	/// Non-greedy and paired, so a stray single backtick touches nothing.
	function tickRanges(src) {
		var out = [], re = /`([^`\n]*)`/g, m;
		while ((m = re.exec(src)) !== null) {
			out.push([m.index, m.index + m[0].length]);
		}
		return out;
	}

	function mathSpans(src) {
		// Inline code joins fenced code as a no-math zone: once the close
		// search actually works, `` `$x^2$` `` would otherwise turn the code
		// the reader is quoting into an equation, and LaTeX discussed in
		// backticks is common in exactly the chats that use LaTeX.
		var fenced = fencedRanges(src).concat(tickRanges(src)), out = [];
		for (var i = 0; i < src.length; i++) {
			if (inRanges(fenced, i)) continue;
			// `\$` stays literal — and ONLY `\$`: the previous guard also
			// swallowed `\(` and `\[`, which are two of the four delimiter
			// families this pass exists to read, so they could never open.
			if (src.charAt(i) === '\\' && src.charAt(i + 1) === '$') { i++; continue; }
			var open = null;
			for (var o = 0; o < MATH_OPEN.length; o++) {
				var or = MATH_OPEN[o].re;
				or.lastIndex = i;
				var om = or.exec(src);
				// A sticky match ANSWERS at the offset it was anchored at
				// (m.index), and leaves lastIndex pointing past it — so the
				// anchor test is on m.index, never on lastIndex after a match.
				if (om && om.index === i) { open = MATH_OPEN[o]; break; }
			}
			if (!open) continue;
			// The opener's WIDTH is the matched text's length, never the pattern
			// source's length: `/\$(?!\s)/y` matches one character while its
			// source is eight, and a `from` computed from the latter lands past
			// a short close so the span never closes.
			var from = i + om[0].length;
			for (var c = 0; c < MATH_CLOSE.length; c++) {
				var cr = MATH_CLOSE[c];
				if (cr.display !== open.display) continue;
				// The close is a FORWARD SEARCH from `from`: exec over the
				// remainder with the guards kept and the sticky flag dropped,
				// the offset added back. Anchoring at `from` answers only "is
				// the close exactly here", and searching the WHOLE string —
				// an earlier build's mistake — returns the first `$` behind
				// the opener, so a message that starts with maths never
				// rendered anything at all.
				var rest = src.slice(from), m;
				m = (new RegExp(cr.re.source)).exec(rest);
				// A `$$`-closed span must close on `$$`: if the `$$`-probe
				// found nothing but a `$` sits at exactly `from`, the peek did
				// not land on `$$` and there is no close (a lone `$` inside
				// the text is not one).
				if (!m && cr.len === 2) {
					var single = new RegExp('\\$(?!\\d)');
					var sm = single.exec(rest);
					if (sm && sm.index === 0) { m = null; }
				}
				if (m) {
					m.index += from;
					// THE FOLD WINS. A span whose range swallows `<details>` or
					// `<summary>` markup would replace the fold's own markup
					// with a placeholder, and the fold the contract protects
					// would be destroyed by the attempt to typeset across it.
					// Such a span is refused whole: the dollars stay literal,
					// exactly as they read before the feature existed, and the
					// fold keeps folding.
					var whole = src.slice(i, m.index + m[0].length);
					if (/<\/?(details|summary)/i.test(whole)) {
						i = m.index + m[0].length - 1;
						break;
					}
					out.push({
						display: open.display,
						tex: src.slice(from, m.index),
						start: i,
						end: m.index + m[0].length,
					});
					i = m.index + m[0].length - 1;
					break;
				}
			}
		}
		return out;
	}

	/// `src` with every closed math span replaced by an inert placeholder, with
	/// the recorded spans returned alongside.  Inert means PASS-THROUGH: `@` is
	/// not markdown punctuation, no angle brackets reach the sanitiser, and the
	/// token is not an HTML signature, so it survives both passes as text and is
	/// substituted AFTER the scrub — the substitution only ever renders KaTeX's
	/// own trusted markup, never model-authored HTML.
	function extractMath(src) {
		var spans = mathSpans(src), newsrc = '', at = 0;
		// A per-call nonce makes the placeholder UNGUESSABLE: a model typing a
		// literal `@@MATH0@@` into a message that also holds real mathematics
		// must not be able to collide with a recorded ordinal and have its
		// words replaced by an equation. Random per call, so nothing outside
		// this invocation can predict it.
		var nonce = Math.random().toString(36).slice(2, 8);
		for (var i = 0; i < spans.length; i++) {
			var sp = spans[i];
			var tok = '@@MATH' + nonce + '-' + i + '@@';
			newsrc += src.slice(at, sp.start) + tok;
			at = sp.end;
		}
		return { text: newsrc + src.slice(at), spans: spans, nonce: nonce };
	}

	/// `src` with every recorded placeholder (only those actually recorded)
	/// replaced by rendered KaTeX, or — when KaTeX is absent or a render throws
	/// — by the original LaTeX source with its delimiters restored, HTML-escaped.
	/// Any other `@@MATHn@@` in the text was written by the model and is left
	/// untouched, byte for byte; the pass never invents a replacement.
	/// Rendered-equation cache: the chat re-renders the whole growing answer on
	/// every streaming frame, so without this every equation in a long answer
	/// re-parses and re-renders dozens of times a second. Bounded, because an
	/// unbounded cache grows with every turn a chat ever renders.
	var mathCache = {}, mathCacheN = 0;
	var MATH_CACHE_MAX = 500;

	function substituteMath(src, spans, nonce) {
		if (!spans || !spans.length) return src;
		var e = escapeHtml, katex = typeof window.katex !== 'undefined' ? window.katex : null;
		var out = '', at = 0;
		// The token pattern is built from THIS call's nonce, so a token the
		// model typed — matching the shape but not the nonce — is never one of
		// ours and passes through untouched.
		var tokRe = new RegExp('@@MATH' + nonce + '-(\\d+)@@', 'g');
		// Pre-count every ordinal's occurrences: a placeholder appearing more
		// than once (a `$$` pair straddling a fold, where the two halves land in
		// different segments) must degrade EVERY occurrence to the literal
		// source, because neither half is closed mathematics and rendering
		// either as an equation would show a reader a fragment as typeset.
		var seen = {}, m0;
		while ((m0 = tokRe.exec(src)) !== null) {
			var n0 = parseInt(m0[1], 10);
			seen[n0] = (seen[n0] || 0) + 1;
		}
		var looked = [];
		for (var i = 0; i < spans.length; i++) { looked.push(i); }
		tokRe.lastIndex = 0;
		var m;
		while ((m = tokRe.exec(src)) !== null) {
			var n = parseInt(m[1], 10), sp = spans[n];
			if (!sp) continue;					// not one we recorded
			looked[n] = -1;
			out += src.slice(at, m.index);
			var dup = seen[n] > 1;
			var tag = sp.display ? 'div' : 'span';
			var cls = sp.display ? 'md-math md-math-block' : 'md-math';
			if (katex && !dup) {
				try {
					var cacheKey = (sp.display ? 'D' : 'I') + '|' + sp.tex;
					var cached = mathCache[cacheKey];
					if (cached === undefined) {
						if (mathCacheN >= MATH_CACHE_MAX) { mathCache = {}; mathCacheN = 0; }
						cached = katex.renderToString(sp.tex, {
							displayMode: sp.display,
							output: 'htmlAndMathml',
							throwOnError: false,
							trust: false,
							strict: 'ignore',
							maxSize: 100,
							maxExpand: 100,
						});
						mathCache[cacheKey] = cached;
						mathCacheN++;
					}
					out += '<' + tag + ' class="' + cls + '">'
						+ cached + '</' + tag + '>';
					at = m.index + m[0].length;
					continue;
				} catch (e2) { /* render threw — fall through to literal */ }
			}
			// The degrade path: yesterday's behaviour, exactly — the dollars and
			// the LaTeX, escaped, so what a reader without KaTeX sees is what a
			// reader saw before the feature existed.
			out += e((sp.display ? '$$' : '$') + sp.tex + (sp.display ? '$$' : '$'));
			at = m.index + m[0].length;
		}
		// A recorded span whose token never appeared (a placeholder that marked
		// swallowed — a `<details>` summary edge) falls back to the SAME literal,
		// so extraction and substitution can never disagree about a span.
		for (var k = 0; k < looked.length; k++) {
			if (looked[k] === -1) continue;
			var sp2 = spans[k];
			out += e((sp2.display ? '$$' : '$') + sp2.tex + (sp2.display ? '$$' : '$'));
		}
		return out + src.slice(at);
	}

	// ── Public render ──────────────────────────────────────────

	/// Render markdown `text` to a sanitised HTML string.
	function md(text) {
		var src = (text == null) ? '' : String(text);
		// Math first, before marked can do anything with the dollars: every
		// closed `$…$`, `$$…$$`, `\(…\)` and `\[…\]` span is moved out of the
		// stream into a placeholder, so marked never sees an underscore that it
		// could turn into emphasis or a `>` that could end the paragraph.  A
		// span still open is left exactly as written until its close lands.
		// The `$` test is the streaming fast path: most answers carry no
		// mathematics at all, and the whole extract-substitute machinery
		// costs real time on every frame of a growing answer, so a source
		// with none of the three opener characters never enters it.  `$`,
		// `\\` (both paren families) and `[`/`]`?  Only `$` and `\\` can open
		// a span; the bracket families need `\\` too, so the two suffice.
		var mth = null;
		if (src.indexOf('$') < 0 && src.indexOf('\\') < 0) {
			mth = null;					// no opener, no pass
		} else {
			try { mth = extractMath(src); }
			catch (e) { mth = null; }
		}
		if (mth) src = mth.text;
		var html;
		try {
			html = marked.parse(src, { breaks: true });
		} catch (e) {
			// marked threw on the PLACEHOLDER text; return the original source
			// escaped, never the mangled half.
			return escapeHtml((text == null) ? '' : String(text));
		}
		// Sanitise the model-authored markup first, then apply the
		// trusted code-transform (which builds its own markup
		// from already-escaped source), then put the math back —
		// KaTeX's output is trusted by the options above and is
		// never walked by the whitelist, which is the point.
		try {
			html = sanitize(html);
		} catch (e) { return escapeHtml((text == null) ? '' : String(text)); }
		try {
			html = enhanceCodeBlocks(html);
		} catch (e) { /* keep unenhanced html */ }
		if (mth) {
			try { html = substituteMath(html, mth.spans, mth.nonce); }
			catch (e) { /* keep the literal placeholders */ }
		}
		return html;
	}

	// ── Copy-to-clipboard (event delegation) ───────────────────

	/// Copy `text` to the clipboard, with a legacy fallback for
	/// browsers without the async clipboard API.
	function copyText(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text);
		}
		return new Promise(function (resolve, reject) {
			try {
				var ta = document.createElement('textarea');
				ta.value = text;
				ta.setAttribute('readonly', '');
				ta.style.position = 'fixed';
				ta.style.left = '-9999px';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				var ok = document.execCommand('copy');
				document.body.removeChild(ta);
				if (ok) { resolve(); } else { reject(new Error('copy failed')); }
			} catch (e) { reject(e); }
		});
	}

	// A single delegated listener services every copy button, present
	// or future, so app.js needs no per-button wiring.
	document.addEventListener('click', function (ev) {
		var btn = ev.target;
		if (!btn || !btn.classList || !btn.classList.contains('code-copy-btn')) return;
		var code = btn.getAttribute('data-code') || '';
		var restore = function (label) {
			btn.textContent = label;
			setTimeout(function () {
				btn.textContent = t('common.copy');
				btn.classList.remove('copied');
			}, 1400);
		};
		copyText(code).then(function () {
			btn.classList.add('copied');
			restore(t('toast.copied'));
		}, function () {
			restore(t('render.copy_failed'));
		});
	});

	// ── Export ─────────────────────────────────────────────────
	window.DaimondRender = {
		md: md, escapeHtml: escapeHtml, sanitize: sanitize,
		foldScan: foldScan, foldSegments: foldSegments, summaryText: summaryText,
		seamText: seamText, seamLine: seamLine,
		extractMath: extractMath, mathSpans: mathSpans,
	};
})();
