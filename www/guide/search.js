/* The guide's search: a box in the header, and results as you type.
 *
 * notes2.txt line 96 asks for it as a fallback -- "some users will choose to
 * burn tokens on Daimond Help but a search facility in the guide is a fallback.
 * It has to be of decent quality." So it is not a substring scan: it tokenises,
 * requires every term to be present, ranks a heading match above a body match,
 * and shows the sentence the match is in rather than the top of the section.
 *
 * WHAT SHAPES THIS FILE.
 *
 * The guide is framed inside Daimond's Web panel WITHOUT `allow-same-origin`.
 * An opaque origin cannot fetch its own files and read the answer, cannot use
 * localStorage, and cannot reach the app's document. Everything here therefore
 * comes from `search-index.js`, which is loaded as a SCRIPT beside this one --
 * the same channel `frame.js` uses to exist at all. There is no network call,
 * no storage, and no dependency on the app.
 *
 * Five of the eight locales are not written in a Latin alphabet, and Japanese,
 * Korean and Chinese do not put spaces between words. Splitting a query on
 * whitespace and requiring whole "words" would find nothing in three of the
 * eight languages the guide ships in, so the matcher treats a run of CJK as a
 * sequence of characters to be found in order, not as a word.
 */
(function () {
	'use strict';

	var IX = window.GUIDE_INDEX;
	if (!IX || !IX.sections || !IX.sections.length) return;
	var W = IX.words || {};

	// ── Folding ───────────────────────────────────────────────────────
	//
	// Case and accents are removed so "Modele" finds "Modèle" and "GUIDE"
	// finds "guide". NFD splits a letter from its accent and the range below
	// deletes the accents; it is a no-op on scripts that do not use them.
	function fold(s) {
		return String(s || '').toLowerCase().normalize('NFD')
			.replace(/[̀-ͯ]/g, '');
	}

	var CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

	// Words a reader types that the guide does not use, pointed at words it
	// does. A help search is used by somebody who does not yet know the
	// vocabulary -- that is why they are searching. The guide says "passphrase"
	// throughout and never "password"; it explains bringing your own key and
	// never writes "BYOK". The table is built into the index, per locale, so
	// this file holds the mechanism and none of the vocabulary. English only
	// for now: see dev/guide-index.mjs for why.
	var ALIAS = (IX.alias && typeof IX.alias === 'object') ? IX.alias : {};

	/// A term, and anything the guide might say instead. The term itself is
	/// always first, so a direct hit is what gets scored when there is one.
	function expand(term) {
		var alt = ALIAS[term];
		if (!alt || !alt.length) return [term];
		var out = [term];
		for (var i = 0; i < alt.length; i++) out.push(fold(alt[i]));
		return out;
	}

	/// A query, as the terms that all have to be present.
	///
	/// Latin runs split on whitespace and punctuation. A CJK run is kept whole
	/// and matched as a substring: there is no space to split on, and a single
	/// character is too common to be a useful term on its own.
	function terms(q) {
		var out = [], cur = '', curCJK = false;
		var s = fold(q);
		for (var i = 0; i < s.length; i++) {
			var ch = s[i];
			var isCJK = CJK.test(ch);
			var isWord = /[\p{L}\p{N}]/u.test(ch);
			if (!isWord) { if (cur) out.push(cur); cur = ''; continue; }
			if (cur && isCJK !== curCJK) { out.push(cur); cur = ''; }
			cur += ch; curCJK = isCJK;
		}
		if (cur) out.push(cur);
		return out.filter(function (t) { return t.length > 0; });
	}

	// The index, folded once at load rather than once per keystroke. 137
	// sections of up to 1200 characters is about 100 kB of lower-casing, which
	// is nothing done once and noticeable done on every key.
	var ROWS = IX.sections.map(function (s) {
		return {
			s: s,
			ft: fold(s.t),
			fu: fold(s.u),
			fb: fold(s.b),
		};
	});

	/// Where a term is found, and how good the find is.
	///
	/// A match at the start of a word beats one in the middle, because "mod"
	/// meaning "model" is a prefix and "mod" meaning "commodity" is a
	/// coincidence. A CJK term has no word starts to look for, so it scores as
	/// a plain substring.
	function hit(hay, term) {
		var at = hay.indexOf(term);
		if (at < 0) return null;
		var whole = false, start = false;
		if (!CJK.test(term)) {
			var b = at === 0 || !/[\p{L}\p{N}]/u.test(hay[at - 1]);
			var e = at + term.length >= hay.length || !/[\p{L}\p{N}]/u.test(hay[at + term.length]);
			start = b; whole = b && e;
		}
		return { at: at, start: start, whole: whole };
	}

	/// Score one section against the query. Null when a term is missing --
	/// EVERY term must appear somewhere, which is what stops a two-word query
	/// returning everything that has either word.
	function score(row, ts) {
		var total = 0, where = null;
		for (var i = 0; i < ts.length; i++) {
			var forms = expand(ts[i]);
			var t = null, inT = null, inU = null, inB = null, viaAlias = false;
			// The typed word first; only if the guide does not use it at all is
			// an alias tried, and a hit through one is scored below a direct one
			// so it can never outrank the real thing.
			for (var f = 0; f < forms.length; f++) {
				var a = hit(row.ft, forms[f]), b = hit(row.fu, forms[f]), c = hit(row.fb, forms[f]);
				if (a || b || c) { t = forms[f]; inT = a; inU = b; inB = c; viaAlias = f > 0; break; }
			}
			if (!t) return null;
			var best = 0;
			// A heading match is what the reader is usually looking for: it is
			// the name of the thing, not a mention of it in passing.
			if (inT) best = Math.max(best, 100 + (inT.whole ? 40 : inT.start ? 25 : 0)
				- Math.min(inT.at, 30));
			if (inU) best = Math.max(best, 45 + (inU.whole ? 15 : inU.start ? 8 : 0));
			if (inB) {
				best = Math.max(best, 30 + (inB.whole ? 20 : inB.start ? 10 : 0)
					- Math.min(inB.at / 40, 20));
				if (!where) where = inB.at;
			}
			total += viaAlias ? best * 0.6 : best;
		}
		// A short heading that matches is a better answer than a long one that
		// happens to contain the same words.
		total += Math.max(0, 20 - row.ft.length / 4);
		return { n: total, at: where == null ? 0 : where };
	}

	function search(q) {
		var ts = terms(q);
		if (!ts.length) return [];
		var out = [];
		for (var i = 0; i < ROWS.length; i++) {
			var sc = score(ROWS[i], ts);
			if (sc) out.push({ row: ROWS[i], n: sc.n, at: sc.at });
		}
		out.sort(function (a, b) { return b.n - a.n; });
		return out.slice(0, 20);
	}

	// ── The snippet ───────────────────────────────────────────────────

	function esc(s) {
		return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	/// The body around the first match, with every term marked.
	///
	/// Cut on a space where there is one, so a snippet does not start
	/// mid-word; CJK has none, and a hard cut there is correct.
	function snippet(row, ts) {
		var b = row.s.b || '';
		if (!b) return '';
		var at = -1;
		for (var q = 0; q < ts.length && at < 0; q++) {
			var forms = expand(ts[q]);
			for (var f = 0; f < forms.length && at < 0; f++) at = row.fb.indexOf(forms[f]);
		}
		var from = at < 0 ? 0 : Math.max(0, at - 60);
		if (from > 0 && !CJK.test(b[from])) {
			var sp = b.indexOf(' ', from);
			if (sp > 0 && sp - from < 25) from = sp + 1;
		}
		var text = b.slice(from, from + 190);
		var out = esc(text);
		// Mark longest-first, so "model" does not get chopped up by "mod".
		var all = [];
		for (var q = 0; q < ts.length; q++) all = all.concat(expand(ts[q]));
		var sorted = all.sort(function (a, c) { return c.length - a.length; });
		for (var i = 0; i < sorted.length; i++) {
			out = mark(out, sorted[i]);
		}
		return (from > 0 ? '…' : '') + out + (from + 190 < b.length ? '…' : '');
	}

	/// Wrap each occurrence of `term` in <mark>, comparing FOLDED text but
	/// keeping the original. Skips anything already inside a tag or an entity,
	/// so a second pass cannot mark the inside of a `<mark>`.
	function mark(html, term) {
		var f = fold(html), t = term, out = '', i = 0;
		while (i < html.length) {
			var at = f.indexOf(t, i);
			if (at < 0) { out += html.slice(i); break; }
			// Inside a tag or an entity? Look back for an unclosed `<` or `&`.
			var lt = html.lastIndexOf('<', at), gt = html.lastIndexOf('>', at);
			var am = html.lastIndexOf('&', at), sc = html.lastIndexOf(';', at);
			if (lt > gt || (am > sc && at - am < 8)) {
				out += html.slice(i, at + t.length); i = at + t.length; continue;
			}
			out += html.slice(i, at) + '<mark>' + html.slice(at, at + t.length) + '</mark>';
			i = at + t.length;
		}
		return out;
	}

	// ── The box ───────────────────────────────────────────────────────

	var box, input, panel, results = [], sel = -1;

	function build() {
		var head = document.querySelector('.site-head-inner');
		if (!head) return false;

		box = document.createElement('div');
		box.className = 'gsearch';

		input = document.createElement('input');
		input.type = 'search';
		input.className = 'gsearch-in';
		input.id = 'guide-search';
		input.autocomplete = 'off';
		input.spellcheck = false;
		input.placeholder = W.ph || 'Search the guide';
		input.setAttribute('aria-label', W.ph || 'Search the guide');
		// A combobox, so a screen reader is told there is a list under this and
		// which row is current -- the arrow keys move a highlight the focus
		// never leaves, and without this that movement is silent.
		input.setAttribute('role', 'combobox');
		input.setAttribute('aria-expanded', 'false');
		input.setAttribute('aria-controls', 'guide-search-results');
		input.setAttribute('aria-autocomplete', 'list');

		panel = document.createElement('div');
		panel.className = 'gsearch-panel';
		panel.id = 'guide-search-results';
		panel.setAttribute('role', 'listbox');
		panel.hidden = true;

		var live = document.createElement('div');
		live.className = 'gsearch-live';
		live.setAttribute('aria-live', 'polite');

		box.appendChild(input);
		box.appendChild(panel);
		box.appendChild(live);
		head.appendChild(box);
		box._live = live;
		return true;
	}

	function close() {
		panel.hidden = true;
		input.setAttribute('aria-expanded', 'false');
		input.removeAttribute('aria-activedescendant');
		sel = -1;
	}

	function draw(q) {
		var ts = terms(q);
		results = search(q);
		panel.innerHTML = '';
		sel = -1;
		if (!ts.length) { close(); return; }

		if (!results.length) {
			var none = document.createElement('p');
			none.className = 'gsearch-none';
			none.textContent = W.no || 'Nothing found';
			panel.appendChild(none);
		} else {
			results.forEach(function (r, i) {
				var a = document.createElement('a');
				a.className = 'gsearch-hit';
				a.id = 'gsearch-hit-' + i;
				a.setAttribute('role', 'option');
				a.setAttribute('aria-selected', 'false');
				a.href = r.row.s.p + (r.row.s.a ? '#' + r.row.s.a : '');

				var t = document.createElement('span');
				t.className = 'gsearch-t';
				t.innerHTML = markAll(esc(r.row.s.t), ts);
				a.appendChild(t);

				if (r.row.s.u) {
					var u = document.createElement('span');
					u.className = 'gsearch-u';
					u.textContent = r.row.s.u;
					a.appendChild(u);
				}
				var sn = snippet(r.row, ts);
				if (sn) {
					var d = document.createElement('span');
					d.className = 'gsearch-b';
					d.innerHTML = sn;
					a.appendChild(d);
				}
				a.addEventListener('mousemove', function () { highlight(i); });
				panel.appendChild(a);
			});
		}
		panel.hidden = false;
		input.setAttribute('aria-expanded', 'true');
		var n = results.length;
		box._live.textContent = n === 0 ? (W.no || 'Nothing found')
			: n === 1 ? (W.n1 || '1 result')
			: (W.n || '{n} results').replace('{n}', n);
	}

	function markAll(html, ts) {
		var all = [];
		for (var q = 0; q < ts.length; q++) all = all.concat(expand(ts[q]));
		var sorted = all.sort(function (a, c) { return c.length - a.length; });
		for (var i = 0; i < sorted.length; i++) html = mark(html, sorted[i]);
		return html;
	}

	function highlight(i) {
		var hits = panel.querySelectorAll('.gsearch-hit');
		if (!hits.length) return;
		if (sel >= 0 && hits[sel]) {
			hits[sel].classList.remove('on');
			hits[sel].setAttribute('aria-selected', 'false');
		}
		sel = (i + hits.length) % hits.length;
		hits[sel].classList.add('on');
		hits[sel].setAttribute('aria-selected', 'true');
		input.setAttribute('aria-activedescendant', hits[sel].id);
		// `nearest`, so a highlight one row down does not jerk the list.
		if (hits[sel].scrollIntoView) hits[sel].scrollIntoView({ block: 'nearest' });
	}

	function wire() {
		var timer = null;
		input.addEventListener('input', function () {
			// A short settle, so a fast typist searches once rather than eight
			// times. 90ms is under the threshold at which a list feels laggy.
			clearTimeout(timer);
			timer = setTimeout(function () { draw(input.value); }, 90);
		});
		input.addEventListener('focus', function () {
			if (input.value.trim()) draw(input.value);
		});
		input.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') {
				if (!panel.hidden) { close(); e.preventDefault(); }
				else { input.value = ''; input.blur(); }
				return;
			}
			if (panel.hidden) return;
			var hits = panel.querySelectorAll('.gsearch-hit');
			if (e.key === 'ArrowDown')      { e.preventDefault(); highlight(sel + 1); }
			else if (e.key === 'ArrowUp')   { e.preventDefault(); highlight(sel - 1); }
			else if (e.key === 'Home' && hits.length) { e.preventDefault(); highlight(0); }
			else if (e.key === 'End' && hits.length)  { e.preventDefault(); highlight(hits.length - 1); }
			else if (e.key === 'Enter') {
				// With nothing picked, Enter takes the best answer — which is
				// what the reader meant by pressing it at all.
				var go = sel >= 0 ? hits[sel] : hits[0];
				if (go) { e.preventDefault(); window.location.href = go.href; }
			}
		});
		document.addEventListener('click', function (e) {
			if (box && !box.contains(e.target)) close();
		});
		// `/` from anywhere, the way it works in every reader this audience uses.
		// Not while typing in something else, and not with a modifier held.
		document.addEventListener('keydown', function (e) {
			if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
			var el = document.activeElement;
			if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
			if (el && el.isContentEditable) return;
			e.preventDefault();
			input.focus();
			input.select();
		});
	}

	/// Land on the section a result named, and say which one it is.
	///
	/// A fragment jump alone leaves the reader at a heading that looks like
	/// every other heading. The target is marked for a few seconds so the eye
	/// has somewhere to go.
	function landed() {
		var id = (window.location.hash || '').slice(1);
		if (!/^s\d+$/.test(id)) return;
		var el = document.getElementById(id);
		if (!el) return;
		el.classList.add('gsearch-landed');
		setTimeout(function () { el.classList.remove('gsearch-landed'); }, 2600);
	}

	function start() {
		if (!build()) return;
		wire();
		landed();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', start);
	} else {
		start();
	}
	window.addEventListener('hashchange', landed);
})();
