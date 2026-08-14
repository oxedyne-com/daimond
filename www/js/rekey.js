/* ============================================================
   Daimond — every secret sealed under the passphrase says so (rekey.js)
   ------------------------------------------------------------
   Daimond seals a secret under a key derived from the user's
   passphrase (`DaimondIdentity.wrap` / `.wrapBytes`). Change the
   passphrase and the key is re-derived under a fresh salt, so
   anything sealed under the old one is opaque from that moment —
   unless the code reads it out first and puts it back.

   ── THE ONE RULE THIS FILE EXISTS TO KEEP ───────────────────

   A MODULE THAT SEALS A SECRET UNDER THE PASSPHRASE REGISTERS
   HERE, BESIDE ITS OWN SEALING CODE — OR SAYS AT THAT SAME SPOT,
   IN SO MANY WORDS, WHY IT NEED NOT.

   Silence is the defect. Until 2026-08-14 the list of what gets
   re-sealed was written out by hand in `doChangePassphrase`, and
   seven modules called `wrap` while exactly one of them was on
   that list. Three were found separately, hours apart, each by a
   different lane:

     - `mail.js`   — every mailbox password, silently dead.
     - `models.js` — every provider API key, while the notice on
                     screen said the key HAD been re-encrypted.
     - `voice.js`  — would have shipped with the same hole.
     - `search.js` — the search API key, still broken that morning.

   None of those is the fault. The fault is that forgetting was
   the default and forgetting was silent, so the fix is not a
   longer hand-written list: it is that the list is no longer
   hand-written. `doChangePassphrase` iterates this registry and
   names nobody, and `dev/verify_rekey.mjs` reads the source for
   every caller of `wrap`/`wrapBytes` and fails on one that is
   neither registered here nor exempted where it seals.

   ── WHAT A PARTICIPANT LOOKS LIKE ───────────────────────────

       DaimondRekey.register({
           name:     'mail',        // the module, one word
           read:     unsealForRekey,   // OPTIONAL, see below
           reseal:   resealAfterRekey, // required
           forget:   forgetRekey,      // OPTIONAL, see below
           sentence: function (kind, list) { … },  // OPTIONAL
       });

   TWO PHASES, because the two shapes that already existed differ
   and both have to be expressible without either being bent:

     - `mail.js` holds its passwords ONLY sealed, so it must read
       them out BEFORE `DaimondIdentity.changePassphrase` swaps
       the key, hold them in its own module for the length of the
       change, and put them back afterwards. That is `read`.
     - `models.js` already holds its keys decrypted in memory
       while unlocked, so there is nothing to read out and it has
       no `read` at all. Only the wrapping has to be redone.

   `read()` answers `{ held: <count>, failed: [<name>, …] }` —
   how many plaintexts it is holding, and which secrets could not
   be READ (already unreadable going in, which is not caused here
   and is reported here because this is the one moment the app
   holds both the fact and the user's attention).

   `reseal()` answers `{ failed: [<name>, …], unread: [<name>, …] }`
   — which could not be put back, and which were already
   unreadable. Both NAMED, never counted: "Gmail needs its
   password again" can be acted on, "a mailbox failed" cannot.

   `forget()` drops anything held, for a change that did not
   happen. A participant with a `read` needs one; a participant
   without holds nothing, so it does not.

   `sentence(kind, list)` composes the module's own words for
   `kind` of 'unread' or 'failed'. The words stay in the module
   that knows what they mean, so this file carries no vocabulary
   and no locale keys for anybody else's secret.

   ── WHAT THIS FILE NEVER LEARNS ─────────────────────────────

   A SECRET. Every phase is called with NO ARGUMENTS and answers
   with counts and names, so there is no parameter a plaintext
   could arrive on and no field one is read out of. `mail.js`'s
   own comment says nothing outside that module has any business
   with a password; that stays true of the registry, which is
   inside no module and would otherwise be the one place every
   secret in the app passes through.

   ── WHAT NO FAILURE MAY COST ────────────────────────────────

   ANOTHER PARTICIPANT. Every registered participant runs, every
   time, whatever the one before it did: each is called in its own
   try/catch, failures are COLLECTED, and the caller says all of
   them at the end. There is deliberately NO `return` anywhere in
   either sequence below — the previous version of this code
   returned on the first failure and silently abandoned every
   secret beneath it, which is how one refused API key could cost
   the push token and the passkey together.

   Attaches one global, `window.DaimondRekey`.
   ============================================================ */
(function () {
	'use strict';

	/// What the app says. The table lives in i18n/en.js.
	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written here where the table has no
	/// entry for it yet. The same device voice.js and search.js use.
	function tOr(key, fallback, vars) {
		var s = t(key, vars);
		if (s !== key) return s;
		if (!vars) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, k) {
			return vars[k] != null ? String(vars[k]) : whole;
		});
	}

	/// The participants, in registration order — which is script order in
	/// index.html, and is therefore the order the notice names them in.
	var parts = [];

	/// Modules that seal something and say why they take no part. An exemption is
	/// a REGISTRATION of a decision, not an absence of one: the verifier reads
	/// these out of the source that seals, so a module can be silent about neither.
	var exempted = [];

	/// Registrations that were refused, so a malformed one is loud rather than
	/// missing. A refused registration is a module that will not be re-sealed, and
	/// that is exactly the failure this file exists to make impossible to have by
	/// accident.
	var refused = [];

	/// The word used for a participant that threw, where nothing it holds can be
	/// named individually because the whole of it went down together.
	function allOfThem() { return tOr('changepass.all_of_them', 'all of them'); }

	// ── Registration ────────────────────────────────────────────────

	/// Take part in a passphrase change.
	///
	/// Called at load, beside the sealing code it speaks for. A duplicate name is
	/// refused rather than replacing the first: two modules answering to one name
	/// would have one of them silently dropped, which is the defect again.
	function register(p) {
		var why = '';
		if (!p || typeof p !== 'object')          why = 'a participant must be an object';
		else if (!p.name || typeof p.name !== 'string') why = 'a participant needs a name';
		else if (typeof p.reseal !== 'function')  why = 'a participant needs a reseal phase';
		else if (p.read && typeof p.read !== 'function') why = 'read must be a function';
		else if (p.forget && typeof p.forget !== 'function') why = 'forget must be a function';
		else if (p.sentence && typeof p.sentence !== 'function') why = 'sentence must be a function';
		else if (names().indexOf(p.name) >= 0)    why = 'a participant of that name is already registered';
		// A `read` with no `forget` cannot let go of what it holds on a change that
		// failed, and a plaintext that outlives the change is the second half of
		// this file's promise. Refused here rather than found later.
		else if (p.read && typeof p.forget !== 'function') why = 'a participant that reads out must be able to forget';
		if (why) {
			refused.push({ name: (p && p.name) || '(unnamed)', why: why });
			try { if (window.console) console.error('[rekey] registration refused: ' + why); } catch (e) { /* no console */ }
			return false;
		}
		parts.push(p);
		return true;
	}

	/// Seal something and take no part, for a stated reason.
	///
	/// For a module whose seal is TRANSIENT — sealed at the moment of sending and
	/// never read back — or whose ciphertext genuinely cannot be re-wrapped from
	/// here. The reason is required and is kept, because "we thought about this
	/// one" and "we forgot this one" look identical from outside and only one of
	/// them is acceptable.
	function exempt(name, why) {
		if (!name || typeof name !== 'string' || !why || typeof why !== 'string') {
			refused.push({ name: String(name || '(unnamed)'), why: 'an exemption needs a name and a reason' });
			return false;
		}
		exempted.push({ name: name, why: why });
		return true;
	}

	/// The registered participants themselves, in order. The live objects: a test
	/// wraps one to prove the sequence really reached it, which a copy could not
	/// show. They carry no secret — see the header.
	function participants() { return parts.slice(); }

	/// Their names, which is all the caller needs to report what took part.
	function names() {
		return parts.map(function (p) { return p.name; });
	}

	/// The stated exemptions, `{ name, why }`.
	function exemptions() { return exempted.slice(); }

	/// Registrations that were refused, `{ name, why }`. Empty in a sound build.
	function refusals() { return refused.slice(); }

	// ── The three phases of a change ────────────────────────────────

	/// What a phase answered, reduced to counts and names.
	///
	/// Whitelisted rather than passed through: a participant returning something
	/// larger cannot widen what this file carries, and a name is coerced to a
	/// string here so that the notice cannot be handed an object to interpolate.
	function tidy(r) {
		var out = { held: 0, failed: [], unread: [] };
		if (!r || typeof r !== 'object') return out;
		if (typeof r.held === 'number' && isFinite(r.held)) out.held = r.held | 0;
		if (Array.isArray(r.failed)) out.failed = r.failed.map(String).filter(Boolean);
		if (Array.isArray(r.unread)) out.unread = r.unread.map(String).filter(Boolean);
		return out;
	}

	/// The module's own words for a failure, or a plain sentence naming it.
	function say(p, kind, list) {
		if (typeof p.sentence === 'function') {
			var s = '';
			try { s = String(p.sentence(kind, list.slice()) || ''); } catch (e) { s = ''; }
			if (s) return s;
		}
		return tOr('changepass.rekey_generic',
			'{who}: {list}.', { who: p.name, list: list.join(', ') });
	}

	/// Read out every secret that is held ONLY sealed, before the key changes.
	///
	/// Must be called BEFORE `DaimondIdentity.changePassphrase`: afterwards nothing
	/// can open them at all. Answers `{ held, ran, failed, sentences }` — `held` is
	/// how many plaintexts the participants between them are now holding, `failed`
	/// names what could not be read, and `sentences` is what to show for it.
	async function readAll() {
		var out = { held: 0, ran: [], failed: [], sentences: [] };
		for (var i = 0; i < parts.length; i++) {
			var p = parts[i];
			if (typeof p.read !== 'function') continue;
			out.ran.push(p.name);
			var r;
			// Each in its own try/catch, and NO return: a participant that throws
			// costs its own secret and nothing else. `forgetAll` still reaches it,
			// because a throw part-way through a read is exactly when something is
			// left held.
			try { r = tidy(await p.read()); }
			catch (e) { r = { held: 0, failed: [allOfThem()], unread: [] }; }
			out.held += r.held;
			if (r.failed.length) {
				out.failed.push({ name: p.name, list: r.failed });
				out.sentences.push(say(p, 'unread', r.failed));
			}
		}
		return out;
	}

	/// Put every secret back under the passphrase that has just replaced the old
	/// one, and let go of whatever was held.
	///
	/// Called AFTER `DaimondIdentity.changePassphrase` returned `{ ok: true }`.
	/// Answers `{ ran, failed, unread, sentences }`.
	async function resealAll() {
		var out = { ran: [], failed: [], unread: [], sentences: [] };
		for (var i = 0; i < parts.length; i++) {
			var p = parts[i];
			out.ran.push(p.name);
			var r;
			try { r = tidy(await p.reseal()); }
			catch (e) { r = { held: 0, failed: [allOfThem()], unread: [] }; }
			// Already unreadable going in, said first: it is the older fault, and a
			// user reading the sentence about it should not think this change caused it.
			if (r.unread.length) {
				out.unread.push({ name: p.name, list: r.unread });
				out.sentences.push(say(p, 'unread', r.unread));
			}
			if (r.failed.length) {
				out.failed.push({ name: p.name, list: r.failed });
				out.sentences.push(say(p, 'failed', r.failed));
			}
		}
		return out;
	}

	/// Drop every plaintext held, for a change that did not happen — or that fell
	/// over part-way through being prepared.
	///
	/// Safe to call twice and safe to call when nothing was ever read out. A
	/// participant that throws in here is caught and the rest still forget: the one
	/// thing worse than a change that failed is a change that failed with the
	/// passwords still in memory.
	function forgetAll() {
		var ran = [];
		for (var i = 0; i < parts.length; i++) {
			var p = parts[i];
			if (typeof p.forget !== 'function') continue;
			ran.push(p.name);
			try { p.forget(); } catch (e) { /* it kept its hold; the others still let go */ }
		}
		return ran;
	}

	// ── Public surface ──────────────────────────────────────────────
	window.DaimondRekey = {
		register:     register,
		exempt:       exempt,
		participants: participants,
		names:        names,
		exemptions:   exemptions,
		refusals:     refusals,
		readAll:      readAll,
		resealAll:    resealAll,
		forgetAll:    forgetAll,
	};
})();
