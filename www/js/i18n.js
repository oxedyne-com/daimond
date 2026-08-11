/* i18n.js — what the app says, and what money looks like.
 *
 * Two settings live here and nowhere else: the language the interface speaks,
 * and the currency figures are shown in. Both are preferences of the device,
 * kept beside the theme rather than inside an account, so a browser shared by
 * two people does not ask each of them again.
 *
 * Money is DISPLAY ONLY. Daimond bills in US dollars. A figure converted into
 * another currency is a courtesy and always carries a ≈; at every point where
 * a charge actually happens the US dollar amount is printed explicitly beside
 * it, with one sentence saying so. The rates are a static table stamped with
 * the date they were taken — nothing here calls a rate service, because a
 * price panel that phones home is not a local-first app.
 *
 * Strings live in `i18n/<locale>.js`, each of which calls `register()` with a
 * flat object of dot-namespaced keys. `en` is the baseline and the fallback: a
 * key missing from a translation falls back to English rather than to a blank,
 * and says so once in the console.
 *
 * THREE WAYS A STRING GETS INTO THE NEW LANGUAGE, and a surface needs whichever
 * fits how it was built:
 *
 *   `data-i18n` in the markup   — `apply()` repaints it on every change. Free.
 *   `bind(node, attr, key)`     — sets the string AND stamps the key, for a
 *                                 widget built in script that knows the key.
 *   `mark(node, attr, text)`    — for a string a widget was HANDED rather than
 *                                 looked up: it recovers the key from the string
 *                                 and stamps it, after which the first case
 *                                 applies. Use `bind` where the key is to hand.
 *   `surface(host, draw)`       — for a surface that builds itself and is only
 *                                 sometimes on screen. Redrawn where it stands.
 *
 * `onChange` remains for what is on screen the whole time. Anything that opens
 * and closes should use `surface`: the bug it exists to stop is a panel left in
 * the language it was opened in, and that came back once already because each
 * hook decided for itself whether it was open.
 */
(function () {
	'use strict';

	var LS_LOCALE = 'daimond-locale';
	var LS_CCY    = 'daimond-currency';

	// ── Locales ────────────────────────────────────────────────
	// Native names, because a language picker that names languages in a
	// language you cannot read is no use to the person who needs it.
	var LOCALES = [
		{ code: 'en',      name: 'English' },
		{ code: 'es',      name: 'Español' },
		{ code: 'de',      name: 'Deutsch' },
		{ code: 'fr',      name: 'Français' },
		{ code: 'pt-BR',   name: 'Português (Brasil)' },
		{ code: 'zh-Hans', name: '简体中文' },
		{ code: 'ja',      name: '日本語' },
		{ code: 'ko',      name: '한국어' },
	];

	// ── Currencies ─────────────────────────────────────────────
	// Approximate, and labelled as such wherever they are used. One number per
	// currency: units of it per US dollar.
	var RATES_AS_OF = '2026-07-01';
	var CURRENCIES = [
		{ code: 'USD', name: 'US dollar',        rate: 1 },
		{ code: 'EUR', name: 'Euro',             rate: 0.92 },
		{ code: 'GBP', name: 'Pound sterling',   rate: 0.79 },
		{ code: 'JPY', name: 'Japanese yen',     rate: 151 },
		{ code: 'CNY', name: 'Chinese yuan',     rate: 7.2 },
		{ code: 'KRW', name: 'Korean won',       rate: 1360 },
		{ code: 'INR', name: 'Indian rupee',     rate: 84 },
		{ code: 'BRL', name: 'Brazilian real',   rate: 5.4 },
		{ code: 'AUD', name: 'Australian dollar', rate: 1.52 },
		{ code: 'CAD', name: 'Canadian dollar',  rate: 1.37 },
	];

	var RATE = {};
	CURRENCIES.forEach(function (c) { RATE[c.code] = c.rate; });

	// ── State ──────────────────────────────────────────────────
	var TABLES  = {};       // locale code -> { key: string }
	var missing = {};       // keys already complained about, so one warning each
	var loading = {};       // locale code -> Promise, so a file loads once
	var present = {};       // locale code -> true|false once probed
	var hooks   = [];       // functions to run after a locale change
	var live    = [];       // { host, draw } for surfaces that build their own strings
	var booted  = false;
	var landed  = false;	// the active non-English table has arrived
	var revMap  = null;     // the table in force, value -> every key that produces it
	var revFor  = null;     // which locale revMap was built from
	var origin  = Object.create(null);   // string -> the key `t` last produced it from, this locale

	var curLocale = null;   // the chosen locale, or null while nothing is chosen
	var curCcy    = null;   // the chosen currency, or null for US dollars

	function supported(code) {
		for (var i = 0; i < LOCALES.length; i++) if (LOCALES[i].code === code) return true;
		return false;
	}

	/// Map whatever the browser reports onto a locale we ship. `pt-PT` lands on
	/// Brazilian Portuguese and `zh-Hant` lands on nothing, which is honest:
	/// half a translation is worse than English.
	function mapBrowser(tag) {
		tag = String(tag || '');
		if (!tag) return 'en';
		if (supported(tag)) return tag;
		var base = tag.split(/[-_]/)[0].toLowerCase();
		var reg  = (tag.split(/[-_]/)[1] || '').toLowerCase();
		if (base === 'pt') return 'pt-BR';
		if (base === 'zh') return (reg === 'tw' || reg === 'hk' || reg === 'mo' || /hant/i.test(tag)) ? 'en' : 'zh-Hans';
		if (supported(base)) return base;
		return 'en';
	}

	function readStored() {
		try {
			var l = localStorage.getItem(LS_LOCALE);
			if (l && supported(l)) curLocale = l;
			var c = localStorage.getItem(LS_CCY);
			if (c && RATE[c]) curCcy = c;
		} catch (e) { /* private mode: the defaults stand. */ }
	}
	readStored();

	/// The locale in force: the choice if there is one, else the browser's.
	function locale() { return curLocale || mapBrowser(navigator.language || 'en'); }
	/// The currency in force. Absent a choice, US dollars.
	function currency() { return curCcy || 'USD'; }

	/// Whether figures are being converted. A caller that marks its own
	/// estimates with a ≈ asks this first, so a converted estimate carries one
	/// ≈ rather than two.
	function converted() { return currency() !== 'USD'; }

	/// What to hand `Intl` and `toLocaleString`. Until the user has chosen a
	/// language, this is `undefined` — the browser's own idea of how to write a
	/// number, which is what every figure in the app used before i18n existed.
	function intlLocale() { return curLocale || undefined; }

	// ── Lookup ─────────────────────────────────────────────────

	/// Fill `{name}` placeholders from `vars`. An unknown placeholder is left
	/// standing rather than blanked, so a mistake is visible instead of silent.
	function interp(s, vars) {
		return s.replace(/\{(\w+)\}/g, function (whole, k) {
			return (vars && vars[k] != null) ? String(vars[k]) : whole;
		});
	}

	/// The string for `key` in the current locale, falling back to English.
	function t(key, vars) {
		var s = TABLES[locale()] ? TABLES[locale()][key] : undefined;
		if (s == null && TABLES.en) s = TABLES.en[key];
		if (s == null) {
			if (!missing[key]) {
				missing[key] = 1;
				console.warn('i18n: no string for "' + key + '"');
			}
			return key;
		}
		if (vars) return interp(s, vars);
		// Which key these words came from, so `mark` is told rather than left to
		// guess. Only the table's own string is recorded: one with a `{n}` filled
		// in is not a string the table produces, and marking it would repaint the
		// placeholder back over the number.
		origin[s] = key;
		return s;
	}

	/// Plural form: looks up `<key>.one` or `<key>.other`, with `{n}` bound to
	/// the count. English has two forms; a language with more registers the
	/// extra forms under the same key and overrides `plural()` for itself.
	function tn(key, n, vars) {
		var v = {};
		if (vars) for (var k in vars) if (Object.prototype.hasOwnProperty.call(vars, k)) v[k] = vars[k];
		v.n = n;
		return t(key + (n === 1 ? '.one' : '.other'), v);
	}

	/// Whether the current table (not the fallback) carries this key. The
	/// picker uses it to tell a real translation from an English stand-in.
	function has(key) {
		var tbl = TABLES[locale()];
		return !!(tbl && tbl[key] != null);
	}

	// ── Money ──────────────────────────────────────────────────

	/// Decimal places for a figure, by size. Two cascades, because the app has
	/// always had two: `calm` is the per-turn cost beside a message, `fine` is
	/// the spending panel, which shows a sub-cent turn honestly.
	function digits(v, mode) {
		if (mode === 'fine') {
			if (v > 0 && v < 0.0995) return 4;
			if (v > 0 && v < 0.995)  return 3;
			return 2;
		}
		if (v < 0.01) return 4;
		if (v < 1)    return 3;
		return 2;
	}

	/// The dollar string the app printed before display currencies existed.
	/// Reproduced exactly rather than routed through `Intl`, because `Intl`
	/// groups thousands and this never did.
	function plainUsd(u, mode) {
		if (mode === 'fine') return '$' + u.toFixed(digits(u, 'fine'));
		if (u <= 0) return '$0';
		return '$' + u.toFixed(digits(u, 'calm'));
	}

	/// Format an amount already in `ccy`, using the locale's conventions. Below
	/// a unit the natural fraction digits are overridden, so a fifth of a cent
	/// reads as a fifth of a cent instead of rounding to nothing.
	function intlMoney(v, ccy, mode) {
		var opt = { style: 'currency', currency: ccy };
		var d = digits(v, mode);
		if (d > 2) { opt.minimumFractionDigits = d; opt.maximumFractionDigits = d; }
		try {
			return v.toLocaleString(intlLocale(), opt);
		} catch (e) {
			return ccy + ' ' + v.toFixed(Math.min(d, 4));
		}
	}

	/// A US dollar figure as the user has asked to see it. In US dollars this
	/// is byte-for-byte what the app always printed; in anything else it is the
	/// converted figure behind a ≈.
	function money(usd, mode) {
		usd = +usd || 0;
		var ccy = currency();
		if (ccy === 'USD') return plainUsd(usd, mode);
		// Nothing converts to nothing exactly, so zero carries no ≈ and none of
		// the sub-cent digits a real figure would earn.
		if (usd === 0) return intlFixed(0, ccy, mode === 'fine' ? 2 : 0);
		return '≈' + intlMoney(usd * RATE[ccy], ccy, mode);
	}

	/// The same, for the gateway's minor units. `src` is the currency the
	/// gateway quoted, which is US dollars unless it says otherwise; a figure
	/// already quoted in another currency is shown as quoted, not converted
	/// twice.
	function moneyMinor(minor, src) {
		var v = (minor || 0) / 100;
		src = String(src || 'usd').toUpperCase();
		var ccy = currency();
		if (src !== 'USD' || ccy === 'USD') {
			try {
				return v.toLocaleString(intlLocale(), { style: 'currency', currency: src });
			} catch (e) {
				return '$' + v.toFixed(2);
			}
		}
		return '≈' + intlMoney(v * RATE[ccy], ccy);
	}

	/// A price the user will actually be CHARGED. Always says US dollars out
	/// loud, and hangs the converted figure off it when there is one, because
	/// the card statement will read in dollars whatever this panel shows.
	function billed(usd, mode) {
		usd = +usd || 0;
		var ccy = currency();
		// Reading in dollars already: "$" is not ambiguous, and this is what the
		// app has always printed.
		if (ccy === 'USD') return plainUsd(usd, mode);
		return 'US' + plainUsd(usd, mode) + ' ≈ ' + intlMoney(usd * RATE[ccy], ccy, mode);
	}

	/// `billed`, for the gateway's minor units.
	function billedMinor(minor, src) {
		src = String(src || 'usd').toUpperCase();
		if (src !== 'USD' || currency() === 'USD') return moneyMinor(minor, src);
		return 'US' + ((minor || 0) / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })
			+ ' ≈ ' + intlMoney(((minor || 0) / 100) * RATE[currency()], currency());
	}

	// ── Round prices in a currency that is not the billing one ─
	//
	// A shop offers €10, not €9.26. A dollar tier converted straight through
	// gives the second, which reads as a rounding error rather than a price —
	// so the tier is snapped to the ladder every shop in the world uses, and
	// the dollar figure that will actually be charged is printed beside it.

	// Currencies quoted whole. Asked of `Intl` first, because it knows; the
	// list is the answer for a browser that does not.
	var ZERO_DEC = { JPY: 1, KRW: 1 };
	function decimalsOf(ccy) {
		try {
			var r = new Intl.NumberFormat('en', { style: 'currency', currency: ccy }).resolvedOptions();
			if (typeof r.maximumFractionDigits === 'number') return r.maximumFractionDigits;
		} catch (e) {}
		return ZERO_DEC[ccy] ? 0 : 2;
	}

	var LADDER = [1, 2, 2.5, 5];

	/// The nearest rung of the 1 / 2 / 2.5 / 5 × 10ᵏ ladder, by ratio — so a
	/// price is snapped by how far off it is proportionally, not absolutely.
	function snap(v) {
		if (!(v > 0)) return 0;
		var k = Math.floor(Math.log(v) / Math.LN10);
		var best = null, bestErr = Infinity;
		// One decade either side, because the nearest rung to 9.2 is 10, which
		// belongs to the decade above.
		for (var d = k - 1; d <= k + 1; d++) {
			for (var i = 0; i < LADDER.length; i++) {
				var c = LADDER[i] * Math.pow(10, d);
				var err = c > v ? c / v : v / c;
				if (err < bestErr - 1e-12) { bestErr = err; best = c; }
			}
		}
		return best;
	}

	/// The next rung strictly above `v`. Used only to break a tie when two
	/// tiers snap to the same price.
	function nextRung(v) {
		var k = Math.floor(Math.log(v) / Math.LN10) - 1;
		for (var d = k; d <= k + 3; d++) {
			for (var i = 0; i < LADDER.length; i++) {
				var c = LADDER[i] * Math.pow(10, d);
				if (c > v * (1 + 1e-9)) return c;
			}
		}
		return v * 2;
	}

	/// Turn a list of US dollar tiers (minor units) into round prices in the
	/// display currency, each paired with the dollar amount that will actually
	/// be charged for it.
	///
	/// Returns `[{ local, localText, billedMinor, billedText, ccy }]`. With US
	/// dollars selected the tiers come back untouched, which is what keeps the
	/// dollar case byte-for-byte what it always was.
	function niceTiers(usdMinors) {
		var ccy = currency();
		var list = (usdMinors || []).map(function (m) { return +m || 0; });
		if (ccy === 'USD') {
			return list.map(function (m) {
				return {
					local: m / 100, localText: moneyMinor(m, 'usd'),
					billedMinor: m, billedText: 'US$' + (m / 100).toFixed(2), ccy: 'USD',
				};
			});
		}
		var rate = RATE[ccy];
		var dec  = decimalsOf(ccy);
		var out = [], prev = 0;
		list.forEach(function (m) {
			var v = snap((m / 100) * rate);
			// Whole-quoted currencies cannot carry a rung below the unit.
			if (dec === 0 && v < 1) v = 1;
			while (v <= prev) v = nextRung(v);
			prev = v;
			var minor = Math.round((v / rate) * 100);
			out.push({
				local: v,
				localText: intlFixed(v, ccy, (dec === 0 || v === Math.round(v)) ? 0 : 2),
				billedMinor: minor,
				billedText: 'US$' + (minor / 100).toFixed(2),
				ccy: ccy,
			});
		});
		return out;
	}

	/// A figure in a named currency at a fixed number of decimals.
	function intlFixed(v, ccy, dp) {
		try {
			return v.toLocaleString(intlLocale(), {
				style: 'currency', currency: ccy,
				minimumFractionDigits: dp, maximumFractionDigits: dp,
			});
		} catch (e) { return ccy + ' ' + v.toFixed(dp); }
	}

	// ── Applying a table to the document ───────────────────────

	function each(sel, fn) {
		var ns = document.querySelectorAll(sel);
		for (var i = 0; i < ns.length; i++) fn(ns[i]);
	}

	/// Walk `root` and set every marked node from the table. Attributes carry
	/// their own marks, because a button often needs both a label and a title.
	function apply(root) {
		root = root || document;
		var q = root.querySelectorAll ? root : document;
		var sel = function (s, fn) {
			var ns = q.querySelectorAll(s);
			for (var i = 0; i < ns.length; i++) fn(ns[i]);
		};
		// `pick`, not `t`: a mark stamped by `mark` may name several keys, and it
		// answers null when they have parted and the node must be left alone.
		var put = function (n, attr, fn) {
			var v = pick(n.getAttribute(attr));
			if (v != null) fn(v);
		};
		sel('[data-i18n]',             function (n) { put(n, 'data-i18n',             function (v) { n.textContent = v; }); });
		sel('[data-i18n-html]',        function (n) { put(n, 'data-i18n-html',        function (v) { n.innerHTML   = v; }); });
		sel('[data-i18n-title]',       function (n) { put(n, 'data-i18n-title',       function (v) { n.title       = v; }); });
		sel('[data-i18n-placeholder]', function (n) { put(n, 'data-i18n-placeholder', function (v) { n.placeholder = v; }); });
		sel('[data-i18n-aria-label]',  function (n) { put(n, 'data-i18n-aria-label',  function (v) { n.setAttribute('aria-label', v); }); });
		sel('[data-i18n-alt]',         function (n) { put(n, 'data-i18n-alt',         function (v) { n.setAttribute('alt', v); }); });
		// A panel's name is markup (`data-label`), because the layout engine reads
		// the DOM as its registry. Writing the translation back into that attribute
		// keeps the one registry there is.
		//
		// The same name also becomes the panel's accessible name. An unnamed
		// <section> is not a landmark at all, and an unnamed <aside> is announced
		// as "complementary" with nothing to tell it from the next one -- Chrome's
		// tree showed three of them side by side as `complementary ""`. The name
		// exists; it was simply never given to the accessibility tree. Doing it
		// here rather than in the markup means the translated name and the spoken
		// name cannot drift apart.
		sel('[data-i18n-label]',       function (n) {
			var label = t(n.getAttribute('data-i18n-label'));
			n.setAttribute('data-label', label);
			n.setAttribute('aria-label', label);
		});
	}

	// ── Marking a string that has already been resolved ────────
	//
	// `data-i18n` in the markup covers everything the page ships with. It cannot
	// cover a widget that is HANDED a string -- a dialog is given a title, not a
	// key -- and those are exactly the surfaces that got stuck in the language
	// they were opened in. Recovering the key from the string closes that gap
	// without every caller having to pass one.

	/// The table in force as value -> every key that produces it, joined by `|`.
	///
	/// Several keys per string is the normal case, not the exception: `Save` is
	/// `Save` under half a dozen of them. See `pick` for what is done about it.
	function reverse() {
		var code = locale();
		if (revFor === code && revMap) return revMap;
		var tbl = TABLES[code] || TABLES.en || {};
		revMap = {};
		for (var k in tbl) {
			if (!Object.prototype.hasOwnProperty.call(tbl, k)) continue;
			var v = tbl[k];
			if (typeof v !== 'string' || !v) continue;
			revMap[v] = revMap[v] ? revMap[v] + '|' + k : k;
		}
		revFor = code;
		return revMap;
	}

	/// The string for a mark, which names one key or several that produced the
	/// same words.
	///
	/// Several is only a problem if they have PARTED in the language now in
	/// force: while `common.cancel` and `graph.cancel` are the same word there
	/// is nothing to choose between them, and either repaints the node
	/// correctly. When they differ, nothing on the node says which was meant, so
	/// it is left as it stands -- a word in the language just left is wrong, but
	/// the wrong word in the right language is worse.
	function pick(spec) {
		if (spec.indexOf('|') === -1) return t(spec);
		var ks = spec.split('|');
		var v  = t(ks[0]);
		for (var i = 1; i < ks.length; i++) if (t(ks[i]) !== v) return null;
		return v;
	}

	// Which attribute mark carries a given property.
	var MARKS = {
		'':            'data-i18n',
		'title':       'data-i18n-title',
		'aria-label':  'data-i18n-aria-label',
		'placeholder': 'data-i18n-placeholder',
		'alt':         'data-i18n-alt',
	};

	/// Put an already-resolved string on a node AND record where it came from,
	/// so the next language change repaints it through `apply` like anything
	/// marked up in the page.
	///
	/// `attr` is '' for the node's text, or one of `title`, `aria-label`,
	/// `placeholder`, `alt`. A string the table did not produce -- a name, a
	/// figure, a sentence with a number interpolated into it -- is set and left
	/// unmarked, which is exactly what it was before.
	function mark(node, attr, text) {
		if (!node) return text;
		attr = attr || '';
		text = (text == null) ? '' : String(text);
		if (attr === '') node.textContent = text;
		else if (attr === 'title') node.title = text;
		else if (attr === 'placeholder') node.placeholder = text;
		else node.setAttribute(attr, text);
		var slot = MARKS[attr];
		if (!slot) return text;
		// What PRODUCED these words, in preference to what could have. `origin`
		// names the one key `t` last answered with, so a caller handing over a
		// string it has just resolved is marked exactly; `reverse` is the fallback
		// for a string that reached here some other way, and it names every key
		// that could have made it -- which `pick` then refuses to choose between
		// when they have parted in the language being switched to. Ja `保存` is
		// `common.save`, `push.save`, `graph.save` AND `files.download`, and Korean
		// parts the last from the other three: guessed, the Save button stayed
		// Japanese; told, it repaints.
		var key = origin[text] || reverse()[text];
		if (key) node.setAttribute(slot, key);
		else node.removeAttribute(slot);   // a stale mark would repaint over the new text
		return text;
	}

	/// The same, for a caller that KNOWS the key. Better than `mark` wherever it
	/// is available, because it is never left guessing between keys that happen
	/// to share a word.
	///
	/// A mark read back off a node is accepted too, group and all, so a widget
	/// that is moved from one host to another can carry its own mark across.
	function bind(node, attr, key) {
		if (!node || !key) return '';
		attr = attr || '';
		var slot = MARKS[attr];
		if (slot) node.setAttribute(slot, key);
		var v = pick(key);
		if (v == null) return '';
		if (attr === '') node.textContent = v;
		else if (attr === 'title') node.title = v;
		else if (attr === 'placeholder') node.placeholder = v;
		else node.setAttribute(attr, v);
		return v;
	}

	/// Take a table from `i18n/<code>.js`. The first table to arrive for the
	/// locale in force paints the document; the page is fully parsed by then,
	/// because these scripts sit at the foot of the body.
	function register(code, table) {
		TABLES[code] = table;
		present[code] = true;
		revFor = null;          // a new table means a new set of strings to trace back
		if (!booted && (code === locale() || code === 'en')) {
			booted = true;
			apply();
		}
		// The arrival of the ACTIVE locale's table is a change, whenever it
		// lands: en.js always arrives first and takes the boot branch, so a
		// persisted locale loads after surfaces have already drawn themselves
		// in the English fallback — they must be told, exactly as a manual
		// switch tells them.
		if (code === locale() && code !== 'en') {
			landed = true;
			origin = Object.create(null);   // the strings recorded came from the table just replaced
			apply();
			fire();
		}
	}

	/// Fetch a locale file, once. Resolves true when the file exists and has
	/// registered a table, false when it does not — which is how the picker
	/// knows which languages are really here, rather than being told.
	function load(code) {
		if (TABLES[code]) return Promise.resolve(true);
		if (loading[code]) return loading[code];
		loading[code] = new Promise(function (done) {
			var s = document.createElement('script');
			s.src = 'i18n/' + code + '.js';
			s.async = true;
			s.onload  = function () { present[code] = !!TABLES[code]; done(!!TABLES[code]); };
			s.onerror = function () { present[code] = false; done(false); };
			document.head.appendChild(s);
		});
		return loading[code];
	}

	/// Which of the shipped locales actually have a file. Probed by loading
	/// them, so adding `i18n/de.js` is the whole of shipping German.
	function available() {
		return Promise.all(LOCALES.map(function (l) {
			return load(l.code).then(function (ok) { return ok ? l.code : null; });
		})).then(function (a) {
			return a.filter(function (x) { return x; });
		});
	}

	/// The element a registered surface is showing itself in, or null when it is
	/// not on screen. `host` may be the element or a function returning one, so a
	/// surface that is built on demand can register before it has a node.
	function shown(host) {
		var el = null;
		try { el = (typeof host === 'function') ? host() : host; } catch (e) { return null; }
		if (!el || !el.getClientRects) return null;
		return el.getClientRects().length ? el : null;
	}

	/// Register a surface that builds its own strings, so a language change
	/// reaches it WHERE IT STANDS.
	///
	/// `draw` rebuilds the surface; `host` is the node showing it, or a function
	/// returning that node (or nothing when the surface is not up). On a change
	/// every registered surface that is on screen is redrawn, and one that is not
	/// is left alone -- it is built in the new language when it is next opened,
	/// which is the whole reason a closed surface needs no work.
	///
	/// The visibility test lives HERE rather than in each caller, and that is the
	/// point of the call. Every surface that shipped stuck in the language it was
	/// opened in had either no hook at all or a hook that decided for itself
	/// whether it was on screen; a surface that registers cannot get that half
	/// wrong, and a surface added later is covered by registering beside the
	/// others rather than by a new line in a change handler somewhere else.
	function surface(host, draw) {
		if (typeof draw !== 'function') return;
		live.push({ host: host, draw: draw });
		// Same reason as `onChange`: a table that landed before this registration
		// has already had its repaint, and this surface missed it.
		if (landed && shown(host)) {
			try { draw(); } catch (e) { console.warn('i18n surface failed', e); }
		}
	}

	function fire() {
		hooks.forEach(function (fn) { try { fn(); } catch (e) { console.warn('i18n hook failed', e); } });
		live.forEach(function (s) {
			if (!shown(s.host)) return;
			try { s.draw(); } catch (e) { console.warn('i18n surface failed', e); }
		});
	}

	/// Choose a language. Loads its table if need be, repaints the marked
	/// nodes, and tells everything that draws its own strings to draw again.
	function setLocale(code) {
		if (!supported(code)) code = 'en';
		return load(code).then(function (ok) {
			curLocale = ok ? code : 'en';
			origin = Object.create(null);   // every string recorded belongs to the language just left
			try { localStorage.setItem(LS_LOCALE, curLocale); } catch (e) {}
			document.documentElement.lang = curLocale;
			apply();
			fire();
			return ok;
		});
	}

	/// Choose a display currency. Nothing is fetched and nothing is billed
	/// differently; the figures on screen change and gain a ≈.
	function setCurrency(code) {
		code = String(code || 'USD').toUpperCase();
		if (!RATE[code]) code = 'USD';
		curCcy = code;
		try { localStorage.setItem(LS_CCY, code); } catch (e) {}
		fire();
	}

	/// Run `fn` after any language or currency change. For what is on screen for
	/// as long as the app is -- a status line, a list in the rail. A surface that
	/// COMES AND GOES belongs in `surface` instead, which does the "am I open"
	/// test on the caller's behalf.
	function onChange(fn) {
		if (typeof fn !== 'function') return;
		hooks.push(fn);
		// The active locale's table can land before the modules register their
		// hooks (it loads in the head; they run at the foot of the body). A
		// hook arriving after that landing has missed its repaint -- run it
		// now, so registration order cannot decide the language on screen.
		if (landed) { try { fn(); } catch (e) { console.warn('i18n hook failed', e); } }
	}

	// The document says what language it is in from the first paint, so a
	// screen reader and the browser's own translation offer both start right.
	try { document.documentElement.lang = locale(); } catch (e) {}

	window.DaimondI18n = {
		t:            t,
		tn:           tn,
		has:          has,
		apply:        apply,
		mark:         mark,
		bind:         bind,
		surface:      surface,
		register:     register,
		load:         load,
		available:    available,
		locales:      function () { return LOCALES.slice(); },
		locale:       locale,
		setLocale:    setLocale,
		currencies:   function () { return CURRENCIES.slice(); },
		currency:     currency,
		converted:    converted,
		setCurrency:  setCurrency,
		ratesAsOf:    function () { return RATES_AS_OF; },
		money:        money,
		moneyMinor:   moneyMinor,
		billed:       billed,
		billedMinor:  billedMinor,
		niceTiers:    niceTiers,
		snap:         snap,
		onChange:     onChange,
	};

	// A remembered language must load itself: `setLocale` fetches its table,
	// but a RELOADED page only reads the stored code -- without this, every
	// reload came back English until the picker was touched again.
	if (locale() !== 'en') load(locale());
})();
