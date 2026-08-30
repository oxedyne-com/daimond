/* ============================================================
   Daimond — the voice a proposal is written with (voice.js)
   ------------------------------------------------------------
   To write on the Oregami forge a tester must present a VOICE: a
   per-person secret the forge looks the writer up BY. There is no
   name on the wire and there is no shared one — the forge holds a
   digest of each person's secret and identifies the voice from the
   secret alone, so the secret IS the identity. That is why this
   file exists and why it is this careful.

   ── THE ONE RULE THIS FILE EXISTS TO KEEP ───────────────────

   THE SECRET IS HELD ENCRYPTED AT REST, IS DECRYPTED ONLY FOR
   THE MOMENT OF A REQUEST, AND IS NEVER WRITTEN TO A LOG, NEVER
   PUT IN A URL OR A QUERY STRING, AND NEVER PUT IN ANY TELEMETRY
   OR ERROR REPORT.

   Each clause is load-bearing:

   - ENCRYPTED AT REST, under the user's passphrase, by the SAME
     mechanism that wraps their API key and their mail app
     password: `DaimondIdentity.wrap` / `.unwrap`. Not a second
     scheme. A second way of encrypting a secret at rest is how one
     of the two stops being reviewed, and the reviewed one is the
     one everything else already uses.
   - ONLY FOR THE MOMENT OF A REQUEST: nothing here caches the
     plaintext. `header()` unwraps, hands the value to one call and
     lets it go. There is no module variable holding a decrypted
     secret between requests, so locking the identity really does
     take the voice away.
   - NEVER IN A URL: a query string is written into every access
     log it passes, kept in history, and handed on in a referrer. A
     credential in one is a credential published. `send()` is the
     one door a voiced request goes through, and it refuses a path
     that carries the secret at all — including one a CALLER built.
   - NEVER IN TELEMETRY: `telemetry.js` can only carry integers, by
     shape, so it cannot carry this even by mistake. Nothing here
     calls it, and nothing here puts the secret in the text of an
     error either: the sentences below say what is wrong with a
     secret and never echo it.

   ── WHAT DOES NOT NEED A VOICE ──────────────────────────────
   Reading a public repository. `header()` answers `{}` when no
   voice is held rather than throwing, so a read spreads nothing
   into its headers and goes through unvoiced. Refusing reads to a
   tester who has not been admitted would be a fence around a
   public page.

   ── WHAT IS NOT HERE, DELIBERATELY ──────────────────────────
   A name. The forge is handed the secret and nothing else, so a
   name field would be a field that travels for no reason and a
   second thing to keep in step. If the forge ever keys by name,
   the contract's §2.1 says so first and this file changes second.

   The gateway forwards this and stores nothing: it re-sends the
   value on `x-ore-voice` and keeps no copy. The header spelled
   here is Daimond's own leg only.

   Attaches one global, `window.DaimondVoice`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string with the English written at the call site as its fallback.
	///
	/// The same device improve.js and trash.js use: `t` answers with the KEY when
	/// the table has no entry, so a panel built against keys the locale files have
	/// not been given yet would read "voice.err.long" on screen. These strings are
	/// routed to the catalogue separately from this file.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	// ── What a voice is ────────────────────────────────────────

	/// Where the wrapped secret sits. `daimond-` prefixed, so accounts.js
	/// namespaces it per account without this file knowing: two people at one
	/// browser have two voices and neither can see the other's.
	var LS  = 'daimond-voice';

	/// The header the browser sends its voice on. Daimond's own namespace on
	/// Daimond's own leg; `improve.rs`'s `HDR_VOICE` is the other end of it, and
	/// the gateway translates it to the forge's `x-ore-voice`. One spelling, in
	/// one place, because a header nobody can find is a 401 nobody can explain.
	var HDR = 'x-daimond-voice';

	/// The record's shape, so a later one can be told from this one.
	var REC_V = 1;

	/// The longest secret that may be sent. Exactly the gateway's `MAX_SECRET`.
	/// Not larger: a secret this refuses and the gateway would forward is a fault
	/// the tester meets twice; a secret this forwards and the gateway refuses is a
	/// round trip spent to be told what was knowable here.
	var MAX = 256;

	/// The shortest. STRICTER THAN THE GATEWAY, which takes any non-empty value,
	/// and the reason is worth stating because looser-than-the-gateway would be a
	/// hole and stricter has to earn its place instead.
	///
	/// The forge mints a voice from `SECRET_BYTES` = 32 bytes of operating-system
	/// randomness and prints it in the Hematite64 alphabet, so a real secret is 45
	/// characters. Sixteen is far below any secret the forge has ever issued and
	/// far above anything a half-completed copy would leave behind — and a
	/// truncated paste is exactly the mistake this catches. Without it the tester
	/// sends a fragment, the forge answers `unknown`, and nothing on either side
	/// says the secret arrived short.
	var MIN = 16;

	/// A secret's alphabet, matching the gateway's `check_secret`: every character
	/// ASCII graphic, 0x21 to 0x7E. NOT a check against the forge's own alphabet —
	/// whether the secret is the RIGHT secret is the forge's question, asked with a
	/// digest. What this refuses is a value that could not be a credential at all,
	/// and in particular one carrying a control character, a space or a newline,
	/// which is how a header value ends early and a second one gets written.
	var GRAPHIC = /^[\x21-\x7e]+$/;

	// ── At rest ────────────────────────────────────────────────

	/// The stored record, or null where there is none or it is not one.
	function rec() {
		var raw = null;
		try { raw = localStorage.getItem(LS); } catch (e) { return null; }
		if (!raw) return null;
		var r = null;
		try { r = JSON.parse(raw); } catch (e) { return null; }
		if (!r || r.v !== REC_V || typeof r.s !== 'string' || !r.s) return null;
		return r;
	}

	/// Is a voice held for this account?
	///
	/// Presence only, and deliberately synchronous: a panel drawing a row needs to
	/// know whether to offer "Set a voice" or "Replace it" without unlocking
	/// anything. It says nothing about whether the secret can be READ right now,
	/// which needs the passphrase — see `header()`.
	function has() {
		return !!rec();
	}

	/// When the voice held was last set, in milliseconds, or 0.
	function at() {
		var r = rec();
		return (r && typeof r.at === 'number') ? r.at : 0;
	}

	/// What is wrong with this secret, or '' where nothing is.
	///
	/// Separate from `set()` so a form can say what is wrong as it is typed
	/// without a throw. The sentences NEVER quote the value: an error message
	/// carrying a credential is a credential in a screenshot.
	///
	/// Asked of `tidy()`'s answer and never of the raw field, because `set()`
	/// stores `tidy()`'s answer: a check that judged something other than what is
	/// kept would refuse a paste the store would have accepted, or the reverse.
	function check(secret) {
		var s = tidy(secret);
		if (!s) return tOr('voice.err.empty',
			'A voice is needed to write on the forge.');
		// The alphabet first, so that `length` below is a count of BYTES: every
		// character admitted here is one byte, which is what the gateway measures.
		if (!GRAPHIC.test(s)) return tOr('voice.err.shape',
			'That does not look like a voice. Copy the whole line the forge printed.');
		if (s.length < MIN) return tOr('voice.err.short',
			'That is shorter than any voice the forge issues. Copy the whole line.');
		if (s.length > MAX) return tOr('voice.err.long',
			'That is longer than a voice can be.');
		return '';
	}

	/// Exactly how long a minted voice is, in characters.
	///
	/// The forge mints `SECRET_BYTES` = 32 bytes of operating-system randomness and
	/// prints them in the Hematite64 alphabet (`oregami/src/voice.rs:67`, through
	/// `ore_store::keys::text_of`). Six bits a character, unpadded, so 32 bytes is
	/// ceil(256 / 6) = 43 symbols, AND THEN THE PADDING, which is what this file got
	/// wrong. HEMATITE64 is not standard Base64 -- `fe2o3_text/src/base2x.rs:39` says
	/// so outright -- and its padding is `'='` followed by a marker digit counting the
	/// leftover bits. 43 symbols carry 258 bits for 256 of secret, so every minted
	/// voice ends `=2` and is 45 characters.
	///
	/// THE OLD 43 DID NOT MERELY MISLABEL ANYTHING; IT DISARMED `tidy`. The label is
	/// taken off only when the tail is exactly a voice long, so against a real paste
	/// the test was 45 === 43, the `secret ` column stayed on the front, and `GRAPHIC`
	/// then refused the space -- the very dead end this pair of functions was written
	/// to end. The fix for tester note 17 was built against a length no voice has.
	///
	/// Used ONLY by `tidy` below, to decide whether a paste carrying whitespace is a
	/// labelled secret or a damaged one; every other bound stays the loose pair,
	/// because whether the secret is the RIGHT secret is the forge's question and this
	/// file does not answer it.
	var LEN = 45;

	/// The secret as it will be stored and sent: what was pasted, trimmed, and with
	/// a LABEL taken off the front where the paste plainly carried one.
	///
	/// A trim was not enough, and the reason is that the forge prints the credential
	/// in a two-column line:
	///
	///     secret   6yYbW…                         (`oregami voice`, src/main.rs:529)
	///
	/// A person told to "copy the whole line the forge printed" -- which is what
	/// this app's own help text said -- copies both columns, and `GRAPHIC` then
	/// fails on the space in the middle. The instruction and the validator
	/// disagreed, and the app took the validator's side with a sentence that
	/// repeated the instruction. That is the dead end the owner hit.
	///
	/// THE TAIL IS TAKEN ONLY WHEN IT IS EXACTLY A VOICE LONG, and that condition is
	/// the whole safety of this. The looser rule -- always take the last field --
	/// rescues the labelled paste and also swallows a DAMAGED one: a real secret
	/// with a space knocked into the middle of it would store its second half, be
	/// refused by the forge as `unknown`, and tell the tester nothing about which
	/// of the two things went wrong. Splitting a 45-character secret cannot leave a
	/// 45-character tail, so the two cases are separated exactly rather than by
	/// judgement, and a damaged paste is still refused by `GRAPHIC` below.
	///
	/// The alternative -- keep refusing and word the refusal better -- was rejected
	/// as the WHOLE fix, because the field is `type=password`: it asks a person to
	/// make an exact edit to characters they cannot see, which is the worst place in
	/// the app to demand precision. It is kept as HALF the fix, for every paste this
	/// cannot rescue: the sentences in `check` now say what to copy -- one run of 45
	/// characters with no spaces -- rather than repeating the instruction that
	/// caused the mistake.
	function tidy(secret) {
		var s = String(secret == null ? '' : secret).trim();
		if (!s) return s;
		var parts = s.split(/\s+/);
		if (parts.length < 2) return s;
		var tail = parts[parts.length - 1];
		return tail.length === LEN ? tail : s;
	}

	/// Hold a voice for this account, wrapped under the user's passphrase.
	///
	/// Throws with the sentence a person should read: the secret is invalid, or
	/// the identity is locked and there is no key to wrap it with. Storing it
	/// unwrapped "for now" is not an option this file offers.
	async function set(secret) {
		var why = check(secret);
		if (why) throw new Error(why);
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(tOr('voice.err.locked',
				'Unlock Daimond first: your voice is kept encrypted under your passphrase.'));
		}
		var wrapped = await DaimondIdentity.wrap(tidy(secret));
		localStorage.setItem(LS, JSON.stringify({ v: REC_V, s: wrapped, at: Date.now() }));
	}

	/// Forget the voice held, destructively.
	///
	/// The RECORD GOES. Not a flag beside it, not an empty field with the
	/// ciphertext kept "in case they come back": a secret still on disk that
	/// `has()` reports as absent is the worst of both, because nothing in the
	/// interface will ever offer to remove it again. Revoking at the forge is a
	/// separate act and this cannot do it; what this can promise is that the copy
	/// on this device is gone.
	function clear() {
		try { localStorage.removeItem(LS); } catch (e) { /* private mode: nothing was stored */ }
	}

	// ── Surviving a passphrase change ──────────────────────────
	//
	// The voice is sealed under a key derived from the passphrase, so a change
	// makes it unreadable unless it is read out under the old key and put back
	// under the new one. This file was written after the same hole was found in
	// `mail.js` and would have inherited it; it never shipped with it.
	//
	// The plaintext is held HERE for the length of the change and nowhere else.
	// `doChangePassphrase` used to hold it in a local of its own, which put a
	// secret in a module that has no business with one — the same rule mail.js
	// keeps about a password, kept about this.

	/// The secret in the clear, for the length of a change. Null at every other
	/// moment, which is what makes "nothing here caches the plaintext" true.
	var held = null;

	/// Read the voice out from under the CURRENT passphrase.
	///
	/// Must run BEFORE `DaimondIdentity.changePassphrase` swaps the key. A voice
	/// that cannot be read is reported and not held: it is already lost, and the
	/// only useful thing left to do about it is say so while the user is looking.
	async function readForRekey() {
		held = null;
		if (!has()) return { held: 0, failed: [] };
		var secret = '';
		try { secret = await DaimondIdentity.unwrap(rec().s); }
		catch (e) { return { held: 0, failed: [tOr('voice.the_voice', 'your forge voice')] }; }
		if (!secret) return { held: 0, failed: [] };
		held = secret;
		return { held: 1, failed: [] };
	}

	/// Put it back under the NEW passphrase, and forget it either way.
	///
	/// Wrapped directly rather than through `set()`, which re-validates: a voice
	/// stored by an older build that would not pass `check()` today must survive a
	/// passphrase change rather than being dropped by it. The `at` stamp is kept
	/// for the same reason — this is a re-wrapping, not a new voice.
	async function resealAfterRekey() {
		if (!held) return { failed: [] };
		var failed = [];
		try {
			var when = at() || Date.now();
			localStorage.setItem(LS, JSON.stringify({
				v: REC_V, s: await DaimondIdentity.wrap(held), at: when,
			}));
		} catch (e) { failed.push(tOr('voice.the_voice', 'your forge voice')); }
		finally { held = null; }		// in the clear; never held past here
		return { failed: failed };
	}

	/// Drop the plaintext unused, for a change that did not happen.
	function forgetRekey() { held = null; }

	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'voice',
			read:   readForRekey,
			reseal: resealAfterRekey,
			forget: forgetRekey,
			/// One secret, so the list is not named: there is only ever one voice
			/// and "your forge voice, your forge voice" would be the shape of a
			/// list where a thing is meant.
			sentence: function (kind) {
				return kind === 'unread'
					? tOr('changepass.voice_not_unsealed',
						'Your forge voice could not be read under the old passphrase, so it '
						+ 'still needs setting again from the line the forge printed for you.')
					: tOr('changepass.voice_not_resealed',
						'Your forge voice could not be re-encrypted under the new passphrase. '
						+ 'Set it again from the line the forge printed for you.');
			},
		});
	}

	// ── The sync parcel ────────────────────────────────────────
	//
	// A voice is a fact about the ACCOUNT, not about the browser it was set in:
	// paired devices share one passphrase-derived identity, so the wrapped
	// secret is decryptable on every one of them. It was simply never
	// transported, and the empty state on the other device told the user it
	// "will sync here shortly" -- a promise nothing kept. sync.js now carries
	// this record beside the pause tree and the trash, and voice.js answers for
	// it as those modules answer for theirs.
	//
	// THE WRAPPED RECORD TRAVELS AS-IS. Nothing here unwraps it: the ciphertext
	// is the same shape at both ends and the plaintext never enters the parcel,
	// so the one rule at the top of this file holds across the wire too.

	/// The stored record, for the parcel -- or null where there is none.
	///
	/// The whole `{ v, s, at }`, `s` still wrapped. `null` is omitted by the
	/// collector, and a section left off is a section the other device keeps;
	/// an empty record would read to the merge as a deletion.
	function snapshot() { return rec(); }

	/// Merge a record from another device. True when this device took it.
	///
	/// NEWER `at` WINS, and that is the whole merge. A re-issued voice is set
	/// with a fresh `Date.now()`, so it is newer everywhere and propagates; an
	/// older incoming record never buries a voice this device set more recently.
	/// A tie keeps what is already here, since the two are the same wrapped
	/// secret under the same identity. Nothing stamps on the way in -- a device
	/// that restamped what it adopted would push it straight back for ever.
	function adopt(incoming) {
		if (!incoming || typeof incoming !== 'object') return false;
		if (incoming.v !== REC_V || typeof incoming.s !== 'string' || !incoming.s) return false;
		var inAt = (typeof incoming.at === 'number') ? incoming.at : 0;
		var mine = rec();
		if (mine) {
			var myAt = (typeof mine.at === 'number') ? mine.at : 0;
			if (inAt <= myAt) return false;		// ours is newer or the same; keep it
		}
		try {
			localStorage.setItem(LS, JSON.stringify({ v: REC_V, s: incoming.s, at: inAt }));
		} catch (e) { return false; }			// private mode: nothing to store into
		return true;
	}

	// ── For the moment of a request ────────────────────────────

	/// The header a request carries, or `{}` where no voice is held.
	///
	/// `{}` rather than a throw, because reading a public repository needs no
	/// voice at all and a caller spreading this into its headers must be able to
	/// do so unconditionally:
	///
	///     fetch(url, { headers: Object.assign({}, await DaimondVoice.header()) })
	///
	/// A voice that is HELD but cannot be read is a different case and DOES throw:
	/// returning `{}` there would send the write unvoiced, the forge would answer
	/// `unvoiced`, and the tester would be told they have no voice when what they
	/// have is a locked one.
	///
	/// Nothing is cached. Each call unwraps afresh, so the plaintext lives for the
	/// length of one request and locking really does take it away.
	async function header() {
		if (!has()) return {};
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(tOr('voice.err.locked_send',
				'Unlock Daimond to write on the forge: your voice is encrypted under your passphrase.'));
		}
		var secret;
		try {
			secret = await DaimondIdentity.unwrap(rec().s);
		} catch (e) {
			// The GCM tag did not check, which in practice means the passphrase this
			// is wrapped under is not the one in force: a passphrase CHANGE re-derives
			// the wrapping key. `doChangePassphrase` now re-wraps this along with the
			// mailbox passwords, the provider keys, the API key and the push token —
			// but a change that failed part-way can still land here, so the message
			// has to stand on its own. Say what happened in words a person can act on
			// rather than passing WebCrypto's `OperationError` up — and never quote
			// the ciphertext, which is what the raw error carries.
			throw new Error(tOr('voice.err.unreadable',
				'Your voice cannot be read with this passphrase. Set it again from the line '
				+ 'the forge printed for you.'));
		}
		var out = {};
		out[HDR] = secret;
		return out;
	}

	/// THE ONE DOOR a voiced request goes through.
	///
	/// Callers may spread `header()` themselves, and reads do. Writes come through
	/// here, because the URL check below has to happen somewhere and a rule kept
	/// at every call site is a rule kept at all but one of them.
	///
	/// Through `DaimondGateway.gwFetch`, which is THE ONE COPY of the gateway's
	/// session rule — renew once, retry once. This file adds one header and does
	/// not reimplement any of that.
	async function send(path, opts) {
		var url = String(path == null ? '' : path);
		var h = await header();
		// The secret must not be in the URL, whoever put it there. A caller that
		// built `?voice=…` is refused rather than corrected, because a request that
		// went out with the query string quietly stripped would still have been
		// composed by code that thinks this is allowed.
		//
		// THE DECODED FORM IS TESTED AS WELL, AND WITHOUT IT THIS GUARD MISSED EVERY
		// REAL VOICE. A minted secret ends `=2` (see `LEN`), and every ordinary way of
		// building a query -- `encodeURIComponent`, `URLSearchParams`, a template with
		// a caller's own escaping -- writes that `=` as `%3D`. A raw substring test
		// therefore matched nothing, the request went out, and the credential reached
		// the access log, the history and the referrer this file's opening rule is
		// about. It read as sound for as long as `dev/verify_voice.mjs` drove it with a
		// 43-character fixture carrying no `=`: a fixture that was not the shape of the
		// thing hid a hole in the code that was.
		//
		// `decodeURIComponent` throws on a malformed escape, and a URL nobody can decode
		// is not one this can clear -- so the throw is caught and the raw test stands
		// alone rather than the whole guard falling open.
		var seen = url;
		try { seen = url + '\n' + decodeURIComponent(url); } catch (e) { /* raw only */ }
		if (h[HDR] && seen.indexOf(h[HDR]) >= 0) {
			throw new Error(tOr('voice.err.inurl',
				'A voice goes in a header, never in an address.'));
		}
		var o = Object.assign({}, opts || {});
		o.headers = Object.assign({}, (opts && opts.headers) || {}, h);
		if (window.DaimondGateway && DaimondGateway.gwFetch) {
			return await DaimondGateway.gwFetch(url, o);
		}
		return await fetch(url, o);
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondVoice = {
		/// The header name, so a caller and a test name the same string.
		HEADER: HDR,
		/// The bounds, for a form that wants to say them before it refuses.
		MIN:    MIN,
		MAX:    MAX,
		/// How long a minted voice is, so a form and a test name one number.
		LEN:    LEN,
		/// What would be stored for this paste, for a test that wants to see the
		/// label come off without storing anything.
		tidy:   tidy,
		has:    has,
		at:     at,
		/// The wrapped record for the sync parcel, or null; and the merge that
		/// applies one arriving from another device -- newer `at` wins.
		snapshot: snapshot,
		adopt:    adopt,
		/// What is wrong with a secret, or '' — for validating as it is typed.
		check:  check,
		set:    set,
		clear:  clear,
		/// `{ 'x-daimond-voice': secret }`, or `{}` where no voice is held.
		header: header,
		/// The one door a voiced request goes through.
		send:   send,
		/// The two phases of a passphrase change. Public so a test can drive them;
		/// the app itself reaches them only through `DaimondRekey`.
		readForRekey:     readForRekey,
		resealAfterRekey: resealAfterRekey,
		forgetRekey:      forgetRekey,
	};
})();
