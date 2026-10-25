/* scrub.js — the one secret scrubber, for debug share and the lens.
 *
 * Loaded twice and kept once (SCRUB-ONE, D-20261006-24): `www/js/debugshare.js`
 * reads it as `window.DaimondScrub` (index.html loads this tag first), and
 * `dev/lens.mjs` requires it through `createRequire`, so the page's egress seam and
 * the lens's ingest seam run the same rules from the same file. Until 26 Oct 2026
 * the block was copied into both, and a test held the copies equal; equal copies
 * still shared one fault, the `named` rule taking only an unbroken run of eight
 * after `passphrase:`, so a passphrase of words travelled and was archived whole.
 *
 * Written in the dialect both hosts accept -- `var`, `function`, no arrows, no
 * module syntax -- because the page loads it as a classic script. Where it sits:
 * here, not in fe2o3's `fe2o3_net/lens/js/redact.js`, because the page reaches no
 * fe2o3 js at build or serve time without a vendoring step.
 *
 * Two layers. `redact`/`redactConfig` match a field NAME and fingerprint the value;
 * `scrubText`/`scrubDeep` match CONTENT, every string searched for the shapes a
 * credential wears.
 */
(function (root) {
	'use strict';

	// Field names whose VALUE is a secret and must be fingerprinted, never shipped
	// raw. Matched on the key name, case-insensitively, anywhere in the bundle --
	// so even an unexpected key/token buried in a transcript or config is caught.
	// The master/passphrase-derived key is never gathered at all; this is the
	// belt-and-braces second line for the provider key and anything key-shaped.
	var SECRET_RE = /(?:^|[_.-])(?:apikey|api_key|key|token|secret|passphrase|password|salt|wrapped|wrappedpriv|sealed|seal|privatekey|priv|mnemonic|seed|masterkey)(?:$|[_.-]|enc\b)/i;

	// SECRET_RE only fires on a `_`/`.`/`-` separator or the start of the whole
	// name, so a camelCase-joined field -- `pushToken`, a GitHub personal access
	// token carried on `config`, or a nested `refreshSecret` -- slides straight
	// past it: the "token" or "secret" is real but has no separator in front of
	// it. This companion has no such boundary and fires anywhere the word
	// appears, so it catches those too; `key` is still anchored to the END of
	// the name (`key$`) so an unrelated field merely containing "key" midword is
	// left alone while anything actually named `...Key` still fingerprints. Used
	// by `redactConfig` alone (below), not the general `redact` walk: a bare,
	// boundary-free "token" match would also catch a real, non-secret field such
	// as the top-level `tokenStats`, which config's free-form settings never has.
	var SECRET_RE_LOOSE = /token|secret|passphrase|password|key$/i;

	// The fields whose value is something a person typed and remembers -- a
	// passphrase, a password, a mailbox's app password (`mail.js` posts it as
	// `password` and keeps it sealed as `pass`), a recovery phrase. Matched at the
	// END of the name, so `smtpPassword` and `newPassphrase` go while `passAt` and
	// `passwordHint` stay, and `pass` only whole, so `bypass` and `compass` stay. Such
	// a value is marked with no head: the six characters `fingerprint` keeps to tell
	// two provider keys apart are the first word of a passphrase.
	var SECRET_KEY_TYPED = /(?:pass(?:word|wd|phrase)|mnemonic|seed[_-]?phrase)$|^pass$/i;

	// ── Fingerprinting and redaction ─────────────────────────────

	/// A short, non-reversible rendering of a secret string for a person's eye:
	/// its first six characters, a stable hash, and its length. Enough to tell two
	/// keys apart and to confirm which key a device is on, and nothing an attacker
	/// could run with. A non-string value returns a typed marker.
	function fingerprint(v) {
		if (v == null) return '[redacted:absent]';
		if (typeof v !== 'string') {
			try { v = String(v); } catch (e) { return '[redacted:' + typeof v + ']'; }
		}
		if (v === '') return '[redacted:empty]';
		var head = v.slice(0, 6);
		// djb2, rendered as unsigned hex. Not a cryptographic hash -- it only has to
		// separate two different keys stably; the raw value never travels.
		var h = 5381;
		for (var i = 0; i < v.length; i++) { h = ((h << 5) + h + v.charCodeAt(i)) >>> 0; }
		return '[redacted ' + head + '…#' + h.toString(16) + '/' + v.length + ']';
	}

	/// `fingerprint`, except for a field `SECRET_KEY_TYPED` names, whose string value
	/// is marked with no head at all. A value already marked passes as it is, so the
	/// lens can run this again over what the client sent.
	function typedMark(k, v) {
		if (!SECRET_KEY_TYPED.test(k) || typeof v !== 'string' || v === '') return fingerprint(v);
		if (v.indexOf('[redacted') === 0) return v;
		return scrubMark('named', v);
	}

	/// A deep copy of `obj` with every secret-named field replaced by its
	/// fingerprint. Structure-preserving so the operator still sees WHICH fields
	/// were present and how they relate -- only the raw secret VALUE is gone.
	/// Cycle-safe and depth-bounded, since a diagnostics bundle is arbitrary state.
	function redact(obj, seen, depth) {
		seen = seen || [];
		depth = depth || 0;
		if (obj == null || typeof obj !== 'object') return obj;
		if (depth > 40 || seen.indexOf(obj) !== -1) return '[redacted:cycle-or-deep]';
		seen = seen.concat([obj]);
		if (Array.isArray(obj)) {
			return obj.map(function (v) { return redact(v, seen, depth + 1); });
		}
		var out = {};
		Object.keys(obj).forEach(function (k) {
			var v = obj[k];
			if (SECRET_RE.test(k) || SECRET_KEY_TYPED.test(k)) {
				// A secret-named field: fingerprint a scalar, or note a structured
				// secret (a wrapped-key object) as present without walking into it.
				out[k] = (v != null && typeof v === 'object')
					? '[redacted:object]'
					: typedMark(k, v);
			} else {
				out[k] = redact(v, seen, depth + 1);
			}
		});
		return out;
	}

	/// Redacts `state.config` alone, before it joins the rest of the bundle.
	/// `config` is the account's persisted settings object -- exactly where a
	/// provider API key, a GitHub push token or some other credential-shaped
	/// field lives -- and unlike the rest of the bundle its field names are
	/// free-form and often camelCase-joined (`pushToken`, `refreshSecret`), so
	/// SECRET_RE's separator-anchored boundary misses them. This walks just that
	/// subtree with SECRET_RE_LOOSE added in, rather than widening the general
	/// `redact()` walk: a field such as `tokenStats` sits at the top of the
	/// bundle, not inside config, is not a secret, and would be wrongly swept up
	/// if the loose match ran everywhere.
	function redactConfig(obj, seen, depth) {
		seen = seen || [];
		depth = depth || 0;
		if (obj == null || typeof obj !== 'object') return obj;
		if (depth > 40 || seen.indexOf(obj) !== -1) return '[redacted:cycle-or-deep]';
		seen = seen.concat([obj]);
		if (Array.isArray(obj)) {
			return obj.map(function (v) { return redactConfig(v, seen, depth + 1); });
		}
		var out = {};
		Object.keys(obj).forEach(function (k) {
			var v = obj[k];
			if (SECRET_RE.test(k) || SECRET_RE_LOOSE.test(k) || SECRET_KEY_TYPED.test(k)) {
				out[k] = (v != null && typeof v === 'object')
					? '[redacted:object]'
					: typedMark(k, v);
			} else {
				out[k] = redactConfig(v, seen, depth + 1);
			}
		});
		return out;
	}


	// ── The content scrubber ─────────────────────────────────────
	//
	// WHY IT EXISTS. `redact`/`redactConfig` match a field NAME. That is the whole
	// guarantee for `config`, and it is worth nothing for a credential sitting in FREE
	// TEXT: a console line that printed one, a tile of the daimon's own answer quoting
	// one back, a failed fetch whose URL carries `?token=`, a tool argument, a stack
	// frame. So this matches by CONTENT. Every string in a payload is searched for the
	// shapes a credential actually wears, and each hit is replaced by a marker naming
	// the shape, a stable hash and the length -- so a reader still sees that a key was
	// there, and can tell two occurrences apart, while the value never leaves the
	// device.
	//
	// AND A CATCH-ALL BEHIND THEM. A shape nobody has enumerated is still a long,
	// unbroken, high-entropy run of characters, and nothing the feed is meant to carry
	// looks like that: a digest, a build id and a device id are hex, which tops out at
	// exactly 4 bits a character, and ordinary prose and identifiers are far below it.
	// So a run of `SCRUB_MIN_RUN` or more `[A-Za-z0-9_-]` whose Shannon entropy is
	// above `SCRUB_MIN_BITS` bits a character, and which is not one of the shapes
	// `scrubSafeRun` names, goes the same way.

	var SCRUB_MIN_RUN   = 32;		// shortest unbroken run the entropy catch considers
	var SCRUB_MIN_BITS  = 4.0;		// ... and the bits per character above which it fires
	var SCRUB_MAX_DEPTH = 40;		// the walk's bound, as in `redact` beside it

	// The shapes, each matched whole and replaced whole.
	var SCRUB_SHAPES = [
		// A PEM private key -- whole, or clipped by elision, in which case everything
		// from the header to the end of the string goes.
		{ k: 'pem',    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
		{ k: 'gh',     re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
		{ k: 'ghpat',  re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
		{ k: 'stripe', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g },
		{ k: 'whsec',  re: /\bwhsec_[A-Za-z0-9]{16,}/g },
		// `sk-`, `sk-or-v1-`, `sk-ant-api03-`: one rule, because every provider that
		// took the prefix kept the same alphabet after it.
		{ k: 'sk',     re: /\bsk-[A-Za-z0-9_-]{16,}/g },
		{ k: 'aws',    re: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA|APKA)[0-9A-Z]{12,}/g },
		{ k: 'gcp',    re: /\bAIza[0-9A-Za-z_-]{30,}/g },
		{ k: 'slack',  re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g },
		{ k: 'jwt',    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/g },
		// The tune relay mints one of these per run and the page carries it as its
		// provider key (`dev/tune/run.mjs`), so it reaches the feed by exactly the path
		// a real provider key would.
		{ k: 'tune',   re: /\btune-[0-9a-f]{32}/g },
	];

	// The secret NAMES the `named` rules look for against a value, as regex source:
	// every one, and the typed ones whose value runs to the end of the line.
	var SCRUB_NAME_TYPED = '(?:passphrase|password|passwd|mnemonic|seed[_-]?phrase)';
	var SCRUB_NAME = '(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|token|secret|'
		+ 'master[_-]?key|private[_-]?key|salt|sealed|wrapped|' + SCRUB_NAME_TYPED.slice(3, -1) + ')';

	// The shapes where the NAME must survive and only the value goes. A scrubbed
	// `?token=` is still a legible URL, and a console line with the value cut out of it
	// still says what the code was doing -- which fingerprinting the whole line, as
	// `looksSecret` did, did not.
	var SCRUB_PAIRS = [
		// An `Authorization` header, however it was spelled into the text. `bearer` in
		// any case, since a header name and its scheme are case-free on the wire;
		// `Basic` and `Token` capitalised only, as prose uses both words lower case.
		{ k: 'bearer', g: 3, re: /\b([Bb][Ee][Aa][Rr][Ee][Rr]|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{8,})/g },
		// A credential in a URL's query or fragment. `[` and `]` are excluded from the
		// value so a marker already placed here is not taken for a value and marked a
		// second time: the lens runs this block AGAIN on ingest, over output the client
		// has already scrubbed, and a rule that is not idempotent nests its own markers.
		{ k: 'urlarg', g: 2, re: /([?&#](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|key|auth|secret|password|passwd|sig|signature)=)([^&\s"'#<>\[\]]{4,})/gi },
		// The gateway's own session cookie. It is HttpOnly, so this app cannot read it
		// -- but a server log line pasted into a chat is not bound by that.
		{ k: 'cookie', g: 2, re: /(daimond_gw_sess=)([^;,\s"'\[\]]{4,})/g },
		// A secret NAME sitting against a value, with the value cut out so the message
		// still reads. Quoted first, single or double, whole up to the closing quote
		// (an escaped one does not close it) and at any length. Then, for the names
		// whose value a person types (a passphrase, a password, a recovery phrase), the
		// rest of the line: a passphrase is words, and the run-of-eight rule that once
		// stood alone here let `passphrase: correct horse battery staple` through whole.
		// Last, the run-of-eight for the names whose value is a token. A value that
		// opens on a quote or on a marker is left to the quoted rule or as it is, so a
		// second pass over scrubbed text changes nothing.
		{ k: 'named',  g: 2, re: new RegExp('(' + SCRUB_NAME + '["\']?\\s{0,3}[:=]\\s{0,3}")((?!\\[redacted )(?:[^"\\\\\\r\\n]|\\\\.)+)(?=")', 'gi') },
		{ k: 'named',  g: 2, re: new RegExp("(" + SCRUB_NAME + "[\"']?\\s{0,3}[:=]\\s{0,3}')((?!\\[redacted )(?:[^'\\\\\\r\\n]|\\\\.)+)(?=')", 'gi') },
		{ k: 'named',  g: 2, re: new RegExp('(' + SCRUB_NAME_TYPED + '["\']?[ \\t]{0,3}[:=][ \\t]{0,3})((?!["\']|\\[redacted )\\S(?:[^\\r\\n]*\\S)?)', 'gi') },
		{ k: 'named',  g: 2, re: new RegExp('(' + SCRUB_NAME + '["\'\\s]{0,3}[:=]["\'\\s]{0,3})([A-Za-z0-9_\\-./+=]{8,})', 'gi') },
		// An AWS secret is forty characters of base64 wearing no prefix at all, so it
		// is only recognisable NEXT TO the access-key id or the name it belongs to.
		{ k: 'awssec', g: 2, re: /((?:AKIA|ASIA)[0-9A-Z]{12,}[\s\S]{0,200}?["'\s:=,])([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/g },
		{ k: 'awssec', g: 2, re: /((?:aws)?_?secret_?access_?key["'\s]{0,3}[:=]["'\s]{0,3})([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi },
	];

	// Built from the constant rather than repeating it, so the two cannot drift.
	var SCRUB_RUN_RE = new RegExp('[A-Za-z0-9_-]{' + SCRUB_MIN_RUN + ',}', 'g');

	/// A short, non-reversible marker for one scrubbed value: the shape it wore, a
	/// stable hash and its length. The hash is what lets a reader say "the same thing
	/// again" across two events without the value travelling; it is djb2, the one
	/// `fingerprint` already uses, because the two markers sit side by side in a log
	/// and a reader should not have to learn both.
	function scrubMark(kind, v) {
		var h = 5381;
		for (var i = 0; i < v.length; i++) { h = ((h << 5) + h + v.charCodeAt(i)) >>> 0; }
		return '[redacted ' + kind + ' #' + h.toString(16) + '/' + v.length + ']';
	}

	/// Shannon entropy of a string, in bits per character. Hex tops out at 4.0 by
	/// construction and base64url at 6.0, so the threshold sits exactly where a digest
	/// stops and a key begins.
	function scrubEntropy(s) {
		var counts = {}, i, c;
		for (i = 0; i < s.length; i++) {
			c = s.charAt(i);
			counts[c] = (counts[c] || 0) + 1;
		}
		var keys = Object.keys(counts), h = 0, p;
		for (i = 0; i < keys.length; i++) {
			p = counts[keys[i]] / s.length;
			h -= p * (Math.log(p) / Math.LN2);
		}
		return h;
	}

	/// Is this unbroken run one of the shapes the feed is SUPPOSED to carry? Named
	/// explicitly rather than left to the entropy threshold, so the feed stays legible
	/// by rule and not by luck. Measured against the real archive rather than guessed
	/// at: a sha256 digest, a build id and a device id are hex; a tool call's
	/// correlation id and a message id are hex joined by `-` or `_`, which is why the
	/// separators are stripped before the hex test rather than tested around; a count
	/// or a stamp is decimal; and an identifier built out of words and a number
	/// (`worker_pool_seat_000412`) is every segment a word or a number and nothing else.
	function scrubSafeRun(s) {
		var bare = s.replace(/[-_]/g, '');
		if (/^[0-9a-fA-F]+$/.test(bare)) return true;	// digests, build ids, device ids, UUIDs
		if (/^[0-9]+$/.test(bare)) return true;			// counts, stamps, sequence numbers
		if (/^[A-Za-z]+$/.test(bare)) return true;		// identifiers and runs of prose
		// Every `-`/`_` separated segment a word or a number: an identifier a person
		// wrote, not a value a generator produced.
		var parts = s.split(/[-_]/), i;
		if (parts.length > 1) {
			for (i = 0; i < parts.length; i++) {
				if (!/^(?:[A-Za-z]{2,}|[0-9]+)$/.test(parts[i])) return false;
			}
			return true;
		}
		return false;
	}

	// The fields whose VALUE is a correlation id the reader navigates by -- a tool
	// call matched to its result, a turn to its rounds, a device to its events. A
	// provider mints some of them out of an alphabet indistinguishable from a key's,
	// so the entropy catch alone would take the feed's whole index with it. They are
	// exempt from THAT catch and from nothing else: an `id` holding an `sk-` key is
	// still scrubbed by the shape rules, which run first and do not consult this.
	var SCRUB_ID_KEYS = {
		id: 1, mid: 1, callId: 1, call_id: 1, tool_call_id: 1, toolCallId: 1,
		turn: 1, chat: 1, chatId: 1, device: 1, deviceId: 1, holder: 1,
		self: 1, nominated: 1, build: 1, d: 1, b: 1, n: 1, w: 1,
		// `body` is the archive's own snapshot FILENAME, minted by `lens.mjs` out of a
		// device id and a snapshot id -- neither a secret, and together an unbroken run
		// the entropy catch scored at 4.27 and took, which left `lens snapshot` unable
		// to find the file it had just written.
		body: 1,
	};

	/// One string, with every credential shape in it replaced by a marker. Returns the
	/// string unchanged when it holds none -- which is the overwhelmingly common case,
	/// and the one the per-tick cost is measured on. `isId` suppresses the entropy
	/// catch alone, for the correlation-id fields `SCRUB_ID_KEYS` names.
	function scrubText(s, isId) {
		if (!s || s.length < 8) return s;
		var i, r;
		for (i = 0; i < SCRUB_SHAPES.length; i++) {
			r = SCRUB_SHAPES[i];
			s = s.replace(r.re, (function (kind) {
				return function (m) { return scrubMark(kind, m); };
			})(r.k));
		}
		for (i = 0; i < SCRUB_PAIRS.length; i++) {
			r = SCRUB_PAIRS[i];
			s = s.replace(r.re, (function (rule) {
				return function () {
					var args = arguments, keep = '', j;
					for (j = 1; j < rule.g; j++) keep += (args[j] == null ? '' : args[j]);
					return keep + scrubMark(rule.k, String(args[rule.g]));
				};
			})(r));
		}
		// The catch-all runs LAST, so a run already turned into a marker above is not
		// weighed a second time.
		if (isId) return s;
		s = s.replace(SCRUB_RUN_RE, function (m) {
			if (scrubSafeRun(m)) return m;
			if (scrubEntropy(m) <= SCRUB_MIN_BITS) return m;
			return scrubMark('hi', m);
		});
		return s;
	}

	/// A deep copy of a payload with `scrubText` applied to every string in it, keys
	/// included, and a field `SECRET_KEY_TYPED` names marked whole -- a key can be a chat id or a model name, and nothing stops a future
	/// one being a token. Cycle-safe and depth-bounded like the redactors beside it,
	/// since what it walks is arbitrary state.
	function scrubDeep(obj, seen, depth, isId) {
		seen = seen || [];
		depth = depth || 0;
		if (typeof obj === 'string') return scrubText(obj, isId);
		if (obj == null || typeof obj !== 'object') return obj;
		if (depth > SCRUB_MAX_DEPTH || seen.indexOf(obj) !== -1) return '[scrubbed:cycle-or-deep]';
		seen = seen.concat([obj]);
		var i;
		if (Array.isArray(obj)) {
			var arr = [];
			// An array inherits its parent's field name: `callIds: [...]` is still ids.
			for (i = 0; i < obj.length; i++) arr[i] = scrubDeep(obj[i], seen, depth + 1, isId);
			return arr;
		}
		var out = {}, keys = Object.keys(obj), k, v;
		for (i = 0; i < keys.length; i++) {
			k = keys[i];
			v = obj[k];
			// A typed secret held as a field, a mailbox's app password in a posted
			// body, has no name beside it in its own string for `named` to find.
			out[scrubText(k)] = (typeof v === 'string' && SECRET_KEY_TYPED.test(k))
				? typedMark(k, v)
				: scrubDeep(v, seen, depth + 1, SCRUB_ID_KEYS[k] === 1);
		}
		return out;
	}

	var api = {
		SECRET_RE:       SECRET_RE,
		SECRET_RE_LOOSE: SECRET_RE_LOOSE,
		fingerprint:     fingerprint,
		redact:          redact,
		redactConfig:    redactConfig,
		scrubMark:       scrubMark,
		scrubText:       scrubText,
		scrubDeep:       scrubDeep,
	};
	// Node (the lens, the tests) takes it as a CommonJS export; the page as a global.
	if (typeof module === 'object' && module && module.exports) module.exports = api;
	else root.DaimondScrub = api;
})(typeof window !== 'undefined' ? window : this);
