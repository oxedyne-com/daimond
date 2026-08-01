// What the extension says, in the eight languages the app speaks.
//
// The strings live in `_locales/<dir>/messages.json`, which is Chrome's own
// format for exactly one reason: it is the only thing that can translate the
// manifest. `name`, `description` and `action.default_title` are read by the
// browser before any code of ours runs, and `__MSG_*__` in the manifest is the
// sole way to reach them. Having paid for that file layout, everything else
// uses it too, rather than carrying a second table.
//
// Which language, though, is not Chrome's business. Chrome would dress these
// windows in the BROWSER's UI language; the user chose a language in the app,
// and the grant window is a sentence the app started. So the lookup is:
//
//	1. the locale the user chose in the app, mirrored here by announce.js;
//	2. chrome.i18n, i.e. the browser's UI language;
//	3. `default_locale`, which is English.
//
// Each step falls through to the next, so a missing file, a language we do not
// ship, or a fresh profile that has never seen the app all end in plain English
// rather than in a blank window.

'use strict';

(function () {

	/// App locale code -> Chrome `_locales` directory name. Chrome's directories
	/// use an underscore and its own region spellings, so `pt-BR` is `pt_BR` and
	/// `zh-Hans` is `zh_CN` -- the app's script-based tag has no `_locales` form.
	const DIRS = {
		'en':      'en',
		'de':      'de',
		'es':      'es',
		'fr':      'fr',
		'ja':      'ja',
		'ko':      'ko',
		'pt-BR':   'pt_BR',
		'zh-Hans': 'zh_CN',
	};

	/// The chosen locale's table, or null while none is chosen or loaded.
	let table = null;
	/// The app locale code in force, for `document.documentElement.lang`.
	let code = '';
	let readyP = null;

	/// Expand `$NAME$` from the entry's own placeholder map, then `$1`..`$9`
	/// from the arguments -- the same two steps `chrome.i18n.getMessage` takes,
	/// so a message reads identically whichever path served it.
	function expand(entry, subs) {
		const ph = entry.placeholders || {};
		const s = String(entry.message).replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name) => {
			const p = ph[name] || ph[name.toLowerCase()];
			return p && p.content != null ? String(p.content) : whole;
		});
		return s.replace(/\$([1-9])/g, (whole, n) => {
			const v = subs[Number(n) - 1];
			return v == null ? '' : String(v);
		});
	}

	/// The string for `key`, with any `$1`.. substitutions.
	///
	/// An unknown key comes back as the key itself rather than as a blank, so a
	/// mistake is visible on the surface instead of leaving a window with a gap
	/// in it.
	function t(key) {
		const subs = Array.prototype.slice.call(arguments, 1);
		const entry = table && table[key];
		if (entry && typeof entry.message === 'string') return expand(entry, subs);
		try {
			const m = chrome.i18n.getMessage(key, subs.map(String));
			if (m) return m;
		} catch (e) { /* no i18n here; the key stands */ }
		return key;
	}

	/// The locale the app is speaking, as announce.js last saw it.
	async function chosen() {
		try {
			const got = await chrome.storage.local.get('locale');
			const c = got && got.locale;
			return DIRS[c] ? c : '';
		} catch (e) {
			return '';
		}
	}

	/// Load the chosen locale's table, once. Resolves whatever happens: a
	/// failure here simply leaves `chrome.i18n` in charge.
	function ready() {
		if (!readyP) readyP = (async () => {
			code = await chosen();
			if (!code) return;
			try {
				const res = await fetch(chrome.runtime.getURL('_locales/' + DIRS[code] + '/messages.json'));
				if (res.ok) table = await res.json();
			} catch (e) { /* the browser's own language stands */ }
		})();
		return readyP;
	}

	/// Set every marked node in `root` from the table. Attributes carry their
	/// own marks, because a button often needs a label and a title both.
	function paint(root) {
		const q = root || document;
		q.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.getAttribute('data-i18n')); });
		q.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.getAttribute('data-i18n-title')); });
		// Say what language this window is in, so a screen reader pronounces it
		// and the browser does not offer to translate what is already translated.
		if (!root && code) {
			try { document.documentElement.lang = code; } catch (e) {}
		}
	}

	globalThis.DaimondExtI18n = { t, ready, paint, dirs: DIRS, locale: () => code };

})();
