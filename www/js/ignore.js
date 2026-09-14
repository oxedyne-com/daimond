// ignore.js — gitignore semantics, once, for every walker that needs them.
//
// Written for the shared folder (see `SYNC_FOLDER_SHARE_MAX` in js/daimond.js): a
// desktop with a real folder open now sends that folder's contents to the account's
// other devices, and a folder on somebody's disk is not a browser sandbox. It holds
// build output. `typst watch` rewrites a 1.7 MB PDF beside its source every time a
// character changes, and without a rule about it every keystroke would offload a
// fresh megabyte and wake every device the account has.
//
// So the folder's own `.gitignore` and `.oreignore` are honoured -- the user has
// already said what is derived, in the file they keep for saying it -- and a small
// built-in list stands underneath for a folder that carries neither.
//
// ONE PARSER. The rule that a `*` does not cross a `/`, that a trailing `/` means a
// directory, that a `!` line takes a path back and that the LAST match wins, is
// fiddly enough that a second copy of it would differ from this one, and the two
// halves that must agree are far apart: the census that decides what to send, and
// the merge that decides what an arriving path may be written to. A path one half
// ignores and the other does not is a file that travels one way and is deleted on
// the way back.
//
// What is deliberately NOT here: git's index. Real git will not re-include a file
// under an ignored directory whatever a later `!` line says, because it never looks
// inside. That falls out of the walk here too -- a walker that does not descend into
// an ignored directory cannot meet the file -- so the rule is honoured by
// construction rather than restated.
//
// Node-testable on its own: www/js/ignore.test.mjs drives this file with no browser.
(function () {
	'use strict';

	// The floor, for a folder that carries no ignore file of its own. Build output
	// and nothing else: this list must never grow into a taste about what is worth
	// syncing, because a file silently left behind is indistinguishable from one
	// that was lost.
	var DEFAULTS = [
		'*.pdf',			// typst, latex and every other compiler write these beside the source
		'*-preview.pdf',	// and the app's own Compile writes this one (Files.previewPdf)
		'target/',			// cargo
		'node_modules/',	// npm
		'.git/',			// the repository, not the work
		'.ore/',			// likewise
		'.scratch/',
		'*.log',
	];

	// The files a folder may state its own rules in, in the order they are applied:
	// a later one wins a tie, which is why `.oreignore` -- the tree's own, and the
	// one a person edits last -- reads after git's.
	var IGNORE_FILES = ['.gitignore', '.oreignore'];

	/// Escape one literal character for a regular expression.
	function esc(ch) { return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

	/// One glob segment as a regular-expression fragment: `*` and `?` never cross a
	/// separator, and a bracket class is carried through with git's `!` spelling of
	/// negation translated to the regex's `^`.
	function segRe(seg) {
		var out = '', i = 0;
		while (i < seg.length) {
			var c = seg.charAt(i);
			if (c === '\\' && i + 1 < seg.length) { out += esc(seg.charAt(i + 1)); i += 2; continue; }
			if (c === '*') { out += '[^/]*'; i++; continue; }
			if (c === '?') { out += '[^/]'; i++; continue; }
			if (c === '[') {
				var close = seg.indexOf(']', i + 1);
				if (close < 0) { out += '\\['; i++; continue; }
				var body = seg.slice(i + 1, close);
				if (body.charAt(0) === '!') body = '^' + body.slice(1);
				out += '[' + body + ']';
				i = close + 1;
				continue;
			}
			out += esc(c);
			i++;
		}
		return out;
	}

	/// Compile one line of an ignore file into a rule, or null for a line that is
	/// not one (blank, or a comment).
	///
	/// `base` is the directory the ignore file sits in, so a rule written in
	/// `book/.gitignore` is anchored to `book/` and never to the workspace root.
	function rule(line, base) {
		var s = String(line == null ? '' : line);
		// A trailing space is not part of a pattern unless it was escaped, which is
		// the one place git's trailing-whitespace rule is visible to a user.
		s = s.replace(/(?:(?!\\).|^)\s+$/, function (m) { return m.charAt(0) === '\\' ? m : m.replace(/\s+$/, ''); });
		s = s.replace(/\s+$/, '');
		if (!s || s.charAt(0) === '#') return null;

		var negate = false;
		if (s.charAt(0) === '!') { negate = true; s = s.slice(1); }
		else if (s.slice(0, 2) === '\\#' || s.slice(0, 2) === '\\!') s = s.slice(1);
		if (!s) return null;

		var dirOnly = false;
		if (s.charAt(s.length - 1) === '/') { dirOnly = true; s = s.slice(0, -1); }
		if (!s) return null;

		// ANCHORED WHEN THE PATTERN SAYS WHERE. A leading `/` anchors it to the
		// ignore file's own directory; so does any interior `/`, which is git's rule
		// and the one people forget -- `doc/build` means that path and not every
		// `build` under a `doc`.
		var anchored = false;
		if (s.charAt(0) === '/') { anchored = true; s = s.slice(1); }
		else if (s.indexOf('/') >= 0) anchored = true;
		if (!s) return null;

		var segs = s.split('/'), body = '';
		for (var i = 0; i < segs.length; i++) {
			var seg = segs[i];
			if (seg === '**') {
				// Any number of segments, this one included, so `a/**/b` matches
				// `a/b` as well as `a/x/y/b`.
				body += (i === segs.length - 1) ? '.*' : '(?:[^/]+/)*';
				continue;
			}
			body += segRe(seg);
			if (i !== segs.length - 1) body += '/';
		}
		var pre = anchored ? '' : '(?:.*/)?';
		return {
			re:      new RegExp('^' + pre + body + '$'),
			base:    String(base || ''),
			dirOnly: dirOnly,
			negate:  negate,
			src:     line,
		};
	}

	/// Every rule a set of ignore files states, in the order they must be applied.
	///
	/// # Arguments
	/// * `sets` - `[{ base, lines }]`, shallowest base first; `lines` is the file's
	///   text as an array or as one string.
	function compile(sets) {
		var out = [];
		(sets || []).forEach(function (set) {
			var lines = set.lines;
			if (typeof lines === 'string') lines = lines.split('\n');
			(lines || []).forEach(function (l) {
				var r = rule(l, set.base);
				if (r) out.push(r);
			});
		});
		return out;
	}

	/// The path of `p` relative to `base`, or null when `p` is not under it.
	function under(p, base) {
		if (!base) return p;
		var b = base.charAt(base.length - 1) === '/' ? base : base + '/';
		if (p === base) return '';
		return p.indexOf(b) === 0 ? p.slice(b.length) : null;
	}

	/// Is this one path ignored by these rules, ITS ANCESTORS NOT CONSIDERED?
	///
	/// Last match wins, which is what makes `!` work at all.
	function hits(rules, p, isDir) {
		var verdict = false;
		for (var i = 0; i < rules.length; i++) {
			var r = rules[i];
			if (r.dirOnly && !isDir) continue;
			var rel = under(p, r.base);
			if (rel === null || rel === '') continue;
			if (r.re.test(rel)) verdict = !r.negate;
		}
		return verdict;
	}

	/// Is this path ignored, its ancestors included?
	///
	/// A file under an ignored directory is ignored however it is reached. The walk
	/// never descends into one, so this matters for the OTHER caller -- the merge,
	/// which is handed a path by another device and has to decide the same question
	/// without having walked anything.
	function ignored(rules, path, isDir) {
		var p = String(path || '').replace(/^\/+/, '');
		if (!p) return false;
		var segs = p.split('/');
		for (var i = 0; i < segs.length - 1; i++) {
			if (hits(rules, segs.slice(0, i + 1).join('/'), true)) return true;
		}
		return hits(rules, p, !!isDir);
	}

	/// A matcher object, for a caller that would rather not carry the rules around.
	function matcher(sets) {
		var rules = compile(sets);
		return {
			rules:   rules,
			ignored: function (p, isDir) { return ignored(rules, p, isDir); },
		};
	}

	window.DaimondIgnore = {
		DEFAULTS:     DEFAULTS,
		IGNORE_FILES: IGNORE_FILES,
		compile:      compile,
		ignored:      ignored,
		matcher:      matcher,
	};
})();
