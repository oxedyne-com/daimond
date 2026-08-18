/* ============================================================
   Daimond — sharing a Diamond (share.js)
   ------------------------------------------------------------
   Giving somebody a copy of something you keep. The Diamond's
   files travel inside a signed `daimond/share/0` payload, the
   payload is sealed to the recipient's key, and what lands on
   their machine is THEIRS.

   ── WHAT A SHARE IS, AND WHAT IT IS NOT ─────────────────────

   1. A SHARE IS A COPY THE RECEIVER OWNS. It is re-sealed to
      their key, it lands in their workspace as a Diamond of
      their own, and they may change it. You never see their
      changes and they never see yours. It is NOT a live view:
      there is no content key that outlives an edit, nothing to
      revoke, no sync fan-out to anybody but the owner, and
      nobody's storage in question but the receiver's own.

   2. DATA TRAVELS FREELY; CODE TRAVELS ONLY BY CONSENT. A
      Diamond that carries a crystal page is carrying a PROGRAM
      written by another person, and a receiver must accept it
      before it is written, let alone run. The claim that there
      is such a program is `code`, and it is INSIDE THE SIGNED
      PAYLOAD — not in a wrapper this file or a relay adds. A
      flag either of those could set or clear is not a consent
      flag; what makes this one worth showing a person is that
      it cannot be touched without the signature failing.

      The gate is on the WRITE, not on the mount. Once a page is
      inside a Diamond, opening that Diamond mounts it, so a
      question asked at mount time is a question asked too late.

   ── ONE SEAL, NOT TWO ───────────────────────────────────────
   The sealing here is `DaimondPost.seal` / `.unseal`, called and
   not copied: the same DPS1 head, the same X25519 + HKDF slot
   per recipient, the same AES-GCM body bound to the whole head.
   A second way of encrypting is how one of the two stops being
   reviewed — voice.js says it about secrets at rest and it is
   just as true in flight.

   ── AND IT HAS TO GET THERE ─────────────────────────────────
   A share is composed to bytes and then somebody has to CARRY
   them. There are two carriers and the choice is made by
   measuring, not by asking: `/api/post` refuses a sealed envelope
   over 64 KiB, and the Log Life capp page alone is about 64 KB, so
   a share carrying a capp cannot go through the relay at all.

   So a share too large is written out as a `.dshare` file, and one
   arriving as a file is read back in — `carrier`, `save`, `take`
   and `pick` below. This is not a fallback for the awkward case:
   it is the only route a capp has, and it is the honest route for
   a person with no gateway account or a share going onto a stick.

   A `.dshare` IS NOT MORE TRUSTED THAN A MESSAGE. The bytes are
   the same sealed envelope, and `take` goes through the same
   `receive` → `accept` → `askAboutCode` path. Opening a file
   somebody handed you must never become a way of running their
   program.

   ── WHAT NEVER TRAVELS ──────────────────────────────────────
   `.daimond/`, `versions/` and `capp.json` are refused by the
   FORMAT (fe2o3_sbj `share.rs`), not by this file, so every
   implementation refuses them: the sender's agent log and their
   own history are not part of a recipe, and a delivery record
   carried across from somebody else's machine would pin the
   receiver's copy against updates they never chose.

   Attaches one global, `window.DaimondShare`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written at the call site where the
	/// table has no entry for it yet. The same device post.js and voice.js use.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}

	function log(/* ...args */) {
		try {
			if (!window.DAIMOND_DEBUG) return;
			console.log.apply(console, ['[share]'].concat([].slice.call(arguments)));
		} catch (e) { /* no console */ }
	}

	// ── What a share is ────────────────────────────────────────

	/// The schema every share is signed under. The purpose tag is inside the
	/// signing input, so a signature over a share can never be read as one over a
	/// message, and the other way about.
	var SCHEMA = 'daimond/share/0';

	/// What a sealed share is called when it is handed over as a file.
	var EXT = '.dshare';

	/// The type a `.dshare` travels under. It is CIPHERTEXT, so there is nothing
	/// truthful to say about its contents and nothing a browser should try to do
	/// with it but save it.
	var MIME = 'application/octet-stream';

	/// The largest sealed envelope `/api/post` carries: the gateway's own
	/// `max_bytes` on that route (`gateway/src/settings.rs`, fallback 65536).
	var RELAY_MAX = 64 * 1024;

	/// The most a share may carry, in bytes of file bodies. Exactly
	/// `limit::TOTAL_BYTES` in the schema's own crate: checked here so a person is
	/// told before they have waited for anything, and checked there because that
	/// is the authority.
	var TOTAL_MAX = 2 * 1024 * 1024;

	/// The most files one share may carry. `limit::FILES`, for the same reason.
	var FILES_MAX = 64;

	/// The most the covering note may carry, in bytes of UTF-8. `limit::NOTE_BYTES`.
	var NOTE_MAX = 512;

	/// The largest `.dshare` this will even try to open. `TOTAL_MAX` is the ceiling
	/// on the file bodies; the head, one slot per recipient, the paths, the note
	/// and the seal's own tag sit on top of it, so this is that ceiling with room
	/// for the wrapping. Checked before anything is unsealed, so a file somebody
	/// dropped in by mistake costs a sentence rather than a megabyte of work.
	var FILE_MAX = TOTAL_MAX + 64 * 1024;

	/// What a share may not carry, applied here so the sender is not handed a
	/// refusal from the encoder for a file they never asked to send.
	///
	/// THE FORMAT IS THE AUTHORITY -- fe2o3_sbj `share.rs` refuses these three
	/// whatever this file does -- and `collect` below DROPS such a file SILENTLY
	/// rather than failing or reporting it. That is deliberate and it is the one
	/// place in this file where something goes missing without the sender being
	/// told: a person sharing a recipe did not ask for their agent log to go with
	/// it and should not have to know it exists to get the recipe sent.
	///
	/// The sentence here used to say the sender WAS told which of their files was
	/// left out. They were not, and never had been -- `collect` writes a debug
	/// line and returns only what travels. The behaviour is right; the sentence
	/// was describing a courtesy the code does not perform, which is how a reader
	/// concludes a gap is covered. Corrected rather than implemented.
	///
	/// The rule three lines below is the one that DOES hold, and it is the
	/// principle worth keeping in view: a share too large is refused rather than
	/// trimmed, because a copy missing a file is not a smaller copy. These three
	/// are not part of the copy at all, which is why they are the exception.
	var NEVER_TRAVELS = /^(\.daimond\/|versions\/|capp\.json$)/;

	// ── Bytes ──────────────────────────────────────────────────

	function utf8(s) { return new TextEncoder().encode(String(s)); }

	function fromUtf8(b) { return new TextDecoder().decode(b); }

	function b64enc(buf) {
		var b = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
		var s = '';
		for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return btoa(s);
	}

	function b64dec(str) {
		var s = atob(String(str));
		var b = new Uint8Array(s.length);
		for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
		return b;
	}

	/// base64url, as the app writes a key.
	function urldec(s) {
		var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
		while (b.length % 4) b += '=';
		return b64dec(b);
	}

	/// Thirty-two key bytes, from whatever a caller is holding.
	///
	/// A DEFECT ONLY A REAL CALLER COULD FIND. `compose` decoded `toEnc` with
	/// `b64dec` and `to` with `urldec`, and the app's own people directory carries
	/// BOTH as 64 characters of hex -- `readCard` in trust.js takes them straight
	/// out of the crate's JSON, where `key` is documented as hex and `enc` is the
	/// same. So a share composed to somebody the user actually knows was refused
	/// with "there is no sealing key for that person yet", which is the one wrong
	/// thing that sentence could have said: the key was right there and this file
	/// was reading it in the wrong alphabet.
	///
	/// Nothing caught it because nothing called `compose` with a directory record
	/// until the Share view existed. A parameter contract no caller exercises is a
	/// parameter contract nobody has checked.
	///
	/// Hex is tried FIRST and only on an exact 64 characters of hex digits, because
	/// a 64-character base64url string is also a legal 48-byte key encoding and
	/// guessing wrong there would swap a real refusal for a silent wrong key.
	function keyBytes(v) {
		if (v instanceof Uint8Array) return v;
		if (!v) return null;
		var str = String(v);
		if (/^[0-9a-fA-F]{64}$/.test(str)) return unhex(str);
		try { return urldec(str); } catch (e) { return null; }
	}

	/// The bytes of a hex string. `hex` below is the other direction.
	function unhex(str) {
		var s = String(str), out = new Uint8Array(s.length >> 1);
		for (var i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
		return out;
	}

	function hex(bytes) {
		var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		var s = '';
		for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
		return s;
	}

	function sameBytes(a, b) {
		if (!a || !b || a.length !== b.length) return false;
		for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
		return true;
	}

	// ── The bridges ────────────────────────────────────────────
	//
	// The same arrangement post.js and identity.js use, and for the same reason:
	// this is a classic script, the canonical encoding lives in the format's own
	// crate, and a second encoding written in JavaScript would be a second address
	// for one share. Nothing here computes what the crate owns.

	function bridge() {
		return (typeof window !== 'undefined' && window.DaimondCrypto) || null;
	}

	/// Whether the wasm bridge carries everything this file needs.
	///
	/// `shareDraft` and `shareRead` are the two names post.js did not need. Said
	/// out loud when they are missing rather than worked around: a share encoded
	/// here instead would have a different address from the same share encoded by
	/// any other build, and a share verified here instead would be a second
	/// implementation of the one check that matters.
	function cryptoReady() {
		var b = bridge();
		return !!(b && typeof b.shareDraft === 'function' && typeof b.shareRead === 'function'
			&& typeof b.signingInput === 'function' && typeof b.assemble === 'function'
			&& typeof b.address === 'function');
	}

	/// Whether the seal is reachable. It is post.js's, called and not copied.
	function sealReady() {
		return !!(window.DaimondPost && typeof DaimondPost.seal === 'function'
			&& typeof DaimondPost.unseal === 'function');
	}

	/// Whether this build can put a share ON somebody's machine.
	///
	/// Separate from `cryptoReady` because the two fail differently and a person
	/// deserves to know which: without the format nothing can be composed at all,
	/// and without this a share can be composed, sent, opened and read and there
	/// is nowhere for it to land.
	function landReady() {
		return !!(window.DaimondDiamond && typeof DaimondDiamond.land === 'function'
			&& typeof DaimondDiamond.files === 'function');
	}

	/// Why sharing cannot be used, in words, or '' when it can.
	function why() {
		if (!bridge() || !cryptoReady()) return tOr('share.err_no_bridge',
			'This build cannot share a Diamond: its share format is not loaded.');
		if (!sealReady()) return tOr('share.err_no_seal',
			'This build cannot share a Diamond: the seal it would be sent under is not loaded.');
		if (!landReady()) return tOr('share.err_no_store',
			'This build can read a share but has nowhere to put one.');
		return '';
	}

	function ready() { return !why(); }

	// ── Collecting what travels ────────────────────────────────

	/// Everything of a Diamond that a share carries, as `[{path, body}]`.
	///
	/// The three things that never travel are dropped HERE, silently, rather than
	/// refused: a person sharing a recipe did not ask for their agent log to go
	/// with it and should not have to know it exists to get the recipe sent. The
	/// format refuses them too, which is what makes this a convenience rather than
	/// the guard.
	async function collect(id) {
		if (!landReady()) {
			throw new Error(tOr('share.err_no_store',
				'This build can read a share but has nowhere to put one.'));
		}
		var all = await DaimondDiamond.files(String(id));
		var out = [];
		var total = 0;
		for (var i = 0; i < (all || []).length; i++) {
			var f = all[i];
			var path = String((f && f.path) || '');
			if (!path || NEVER_TRAVELS.test(path)) { log('not travelling', path); continue; }
			var body = f.body instanceof Uint8Array ? f.body
				: (typeof f.body === 'string' ? utf8(f.body) : new Uint8Array(f.body || []));
			total += body.length;
			out.push({ path: path, body: body });
		}
		if (!out.length) {
			throw new Error(tOr('share.err_empty',
				'There is nothing in that Diamond to send yet.'));
		}
		if (out.length > FILES_MAX) {
			throw new Error(tOr('share.err_too_many_files',
				'That Diamond holds {n} files, and a share carries at most {max}.',
				{ n: out.length, max: FILES_MAX }));
		}
		if (total > TOTAL_MAX) {
			throw new Error(tOr('share.err_too_big',
				'That Diamond is {mb} MB, and a share carries at most {max} MB. It is refused '
				+ 'rather than trimmed: a copy missing a file is not a smaller copy.',
				{ mb: (total / (1024 * 1024)).toFixed(1),
				  max: (TOTAL_MAX / (1024 * 1024)).toFixed(0) }));
		}
		return out;
	}

	// ── Composing ──────────────────────────────────────────────

	/// Build, sign and seal one share. Answers
	/// `{ addr, artefact, sealed, envelope, code, ts }`.
	///
	/// THE SEAM, exactly as post.js draws it: the crate encodes the payload and
	/// says what to sign, this signs it with a key that never crosses the
	/// boundary, and the crate takes the signature back and assembles. The
	/// envelope is a pure function of the same four arguments both calls are
	/// given, so a caller cannot sign one envelope and assemble another.
	///
	/// `to` is the recipient's SIGNING key, and it goes inside the payload, so a
	/// share lifted out of one sealed envelope and dropped into another is caught
	/// when it is opened. `toEnc` is their SEALING key, which is a different key
	/// for a stated reason (see identity.js), and is what the slot is made for.
	///
	/// `code` comes back so a caller can say what they are about to send BEFORE
	/// they send it. It is the crate's own answer, asked of the draft, so the
	/// sentence a sender reads and the claim their signature carries cannot
	/// disagree.
	async function compose(opts) {
		var o = opts || {};
		var stop = why();
		// A build with nowhere to LAND a share can still compose one, so the store
		// is not required here; the other two are.
		if (!cryptoReady() || !sealReady()) {
			throw new Error(stop || tOr('share.err_no_bridge',
				'This build cannot share a Diamond: its share format is not loaded.'));
		}
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(tOr('share.err_locked',
				'Unlock Daimond to share: a share is signed with your own key.'));
		}

		var name = String(o.name == null ? '' : o.name).trim();
		if (!name) {
			throw new Error(tOr('share.err_no_name', 'A share needs a name for what is in it.'));
		}
		var note = String(o.note == null ? '' : o.note).trim();
		if (utf8(note).length > NOTE_MAX) {
			throw new Error(tOr('share.err_note_long',
				'That note is longer than {n} characters and was not sent. A share carries a line '
				+ 'about what it is; a letter is a message.', { n: NOTE_MAX }));
		}

		var toPub = keyBytes(o.to);
		if (!toPub || toPub.length !== 32) {
			throw new Error(tOr('share.err_bad_key',
				'That person has no usable key, so nothing was sent.'));
		}
		var toEnc = o.toEnc ? keyBytes(o.toEnc) : encFor(o.to);
		if (!toEnc || toEnc.length !== 32) {
			throw new Error(tOr('share.err_no_card',
				'There is no sealing key for that person yet, so nothing can be sealed to them. '
				+ 'Scan their code, or ask them to send you theirs.'));
		}

		// The files: named by the caller, or collected from the Diamond they named.
		var files = o.files;
		if (!files) {
			if (!o.diamond) {
				throw new Error(tOr('share.err_nothing',
					'There is nothing to share: name a Diamond or the files to send.'));
			}
			files = await collect(o.diamond);
		}

		var b = bridge();
		var nonce = crypto.getRandomValues(new Uint8Array(16));
		var draft = b.shareDraft(name, toPub, nonce);
		var payload, code;
		try {
			if (note) draft.note(note);
			for (var i = 0; i < files.length; i++) {
				var f = files[i];
				var body = f.body instanceof Uint8Array ? f.body
					: (typeof f.body === 'string' ? utf8(f.body) : new Uint8Array(f.body || []));
				draft.addFile(String(f.path), body);
			}
			// Asked BEFORE encoding, so a caller can still stop; the crate computes
			// it and the payload's own `code` bit is computed from the same rule.
			code = !!draft.carriesCode();
			payload = draft.encode();
		} finally {
			// A wasm-bindgen object holds memory on the other side of the boundary
			// until it is told to let go, and a draft that is not freed is a leak per
			// share rather than per session.
			try { if (draft && draft.free) draft.free(); } catch (e) { /* already freed */ }
		}

		var author = await DaimondIdentity.publicKeyRaw();
		var when   = Date.now();
		var input  = b.signingInput(payload, SCHEMA, author, when);
		// `sign` answers STANDARD base64, not base64url. The envelope wants the raw
		// bytes, so it is decoded rather than passed on as text.
		var sig      = b64dec(await DaimondIdentity.sign(input));
		var artefact = b.assemble(payload, SCHEMA, author, when, sig);
		var addr     = hex(b.address(payload));

		// The sender's own slot, so their other devices can re-read what they sent.
		// Left out when this device has no sealing key: better a share the sender
		// cannot re-open than one that cannot be sent at all.
		var mine = DaimondIdentity.sealingKeyRaw();
		var to   = [toEnc];
		if (mine && !sameBytes(mine, toEnc)) to.push(mine);

		var sealed = await DaimondPost.seal(to, artefact);
		return {
			addr:     addr,
			// THE NAME COMES BACK, and its absence was a defect rather than a gap:
			// `filename` below builds the file's stem from `made.name`, so without
			// this every `.dshare` anybody ever saved would have been called
			// `share-<addr>.dshare` and the name the sender chose would have reached
			// nobody. It is the sender's own text, cleaned there and not here.
			name:     name,
			artefact: artefact,
			sealed:   sealed,
			envelope: b64enc(sealed),
			code:     code,
			ts:       when,
		};
	}

	/// A recipient's sealing key, from trust.js's projection where there is one.
	///
	/// trust.js is the only authority on who is who; nothing here holds a
	/// directory of its own. post.js reads the same projection, and this asks it
	/// the same way rather than keeping a second copy of the answer.
	function encFor(pub) {
		try {
			if (window.DaimondPost && DaimondPost.people) {
				var list = DaimondPost.people() || [];
				for (var i = 0; i < list.length; i++) {
					if (String(list[i].pub) === String(pub) && list[i].enc) {
						return keyBytes(list[i].enc);
					}
				}
			}
		} catch (e) { /* no directory: the caller must name the key */ }
		return null;
	}

	// ── Opening ────────────────────────────────────────────────

	/// Open one sealed share and say what it turned out to be.
	///
	/// THE READER CHECKS AND NOBODY ELSE. Magic, envelope, address, signature,
	/// canonical encoding and schema all run in `DaimondCrypto.shareRead`, on this
	/// device. Two checks are made here on top of it, and both are about this
	/// account rather than about the artefact:
	///
	///  - the payload's `to` must be THIS account's key. A share sealed to us but
	///    addressed to somebody else is a share somebody re-slotted, and the
	///    signature covers `to`, so this catches it;
	///  - where the caller was told an address, it must be the address the
	///    artefact has, or the two are not the same thing.
	///
	/// Nothing is written by this function. What comes back is a reading, and
	/// `accept` is the only thing that puts anything on the machine.
	async function openSealed(bytes, expectAddr) {
		if (!cryptoReady() || !sealReady()) {
			throw new Error(tOr('share.err_no_bridge',
				'This build cannot share a Diamond: its share format is not loaded.'));
		}
		var b = (bytes instanceof Uint8Array) ? bytes
			: (typeof bytes === 'string' ? b64dec(bytes) : new Uint8Array(bytes));
		var plain = await DaimondPost.unseal(b);
		var read = bridge().shareRead(plain);		// throws, with the reason, on anything wrong

		try {
			var mine = await DaimondIdentity.publicKeyRaw();
			if (!mine || !sameBytes(mine, read.to())) {
				throw new Error(tOr('share.err_not_addressed',
					'That share is addressed to a different key from this one.'));
			}
			if (expectAddr && String(expectAddr) !== read.address()) {
				throw new Error(tOr('share.err_addr_mismatch',
					'The share you were told about is not the share that arrived.'));
			}
		} catch (e) {
			try { if (read && read.free) read.free(); } catch (e2) { /* already freed */ }
			throw e;
		}
		return read;
	}

	/// Everything a reading says, as plain values, so a caller can draw it without
	/// holding the wasm object open.
	///
	/// The wasm side owns the file BODIES and they are not copied out here: a
	/// share may be two megabytes and a summary is a sentence. `accept` takes the
	/// bodies, one at a time, at the moment it writes them.
	///
	/// **`code` is `read.code()` and must stay so.** It is the sender's signed
	/// claim; the per-file `code` beside each path is THIS build's reading of the
	/// suffix, which is a different fact wearing the same word. Today the two
	/// always agree, because the schema refuses a payload where they do not — so
	/// no test here can tell a build that reads the claim from one that recomputes
	/// it, and swapping them would go unnoticed until a later build learned a
	/// suffix this one does not know. That is exactly the case the signed bit
	/// exists for, and it is the case a green test would be silent about.
	function describe(read) {
		var files = [];
		var n = read.count();
		for (var i = 0; i < n; i++) {
			files.push({ path: read.path(i), code: !!read.isCode(i) });
		}
		return {
			name:    read.name(),
			note:    read.note(),
			code:    !!read.code(),
			author:  read.author(),
			address: read.address(),
			ts:      read.time(),
			files:   files,
		};
	}

	/// The files of a reading that are code, by path.
	function codePaths(read) {
		var out = [];
		for (var i = 0; i < read.count(); i++) {
			if (read.isCode(i)) out.push(read.path(i));
		}
		return out;
	}

	// ── Consent ────────────────────────────────────────────────

	/// Ask, in the app's own words, whether a page written by somebody else may be
	/// written into this workspace.
	///
	/// **In app chrome, never in a frame.** A click inside a rendered page is a
	/// click whose user activation the app cannot verify, so a timer is
	/// indistinguishable from a person; this is asked where a click is provably
	/// somebody's, which is the same rule `makeCappDiamond` follows.
	///
	/// It says three things, and each is there because leaving it out would make
	/// the question unanswerable: WHAT it is (a page — a program), WHOSE it is
	/// (the sender's fingerprint, since a display name is advisory and a key is
	/// not), and WHICH files (named, so "it contains code somewhere" is never the
	/// whole of what anybody is told).
	async function askAboutCode(read) {
		var paths = codePaths(read);
		var who = fingerprintOf(read.author());
		var body = tOr('share.code_body',
			'“{name}” includes a page: a program written by somebody else, which Daimond will '
			+ 'run when you open it. It came from {who}. Accept it only if you meant to receive '
			+ 'a page from them.\n\nWhat would be added: {files}',
			{ name: read.name(), who: who, files: paths.join(', ') });
		if (window.DaimondCore && typeof DaimondCore.confirm === 'function') {
			return await DaimondCore.confirm(body, tOr('share.code_ok', 'Accept the page'),
				{ title: tOr('share.code_title', 'This share contains code'), danger: true });
		}
		// No dialog is not a reason to write it anyway. A build with nothing to ask
		// with refuses, which is the only answer that is honest here: the fence is
		// the consent, not the dialog.
		log('no confirm dialog: refusing the code');
		return false;
	}

	/// The sender's key as a person reads it. It DECIDES nothing, and is shown
	/// because a display name is the sender's own text and a key is not.
	function fingerprintOf(key) {
		try {
			var b = bridge();
			if (b && typeof b.fingerprint === 'function') return b.fingerprint(key);
		} catch (e) { /* fall through to the raw form */ }
		return hex(key).slice(0, 16);
	}

	// ── Landing ────────────────────────────────────────────────

	/// Put a share on this machine as a Diamond of the receiver's own.
	///
	/// `opts.withCode` decides whether the code files are written: `undefined`
	/// asks (`askAboutCode`), `true` writes them, `false` writes only the data. A
	/// caller drawing two buttons passes the answer; a caller drawing one asks.
	///
	/// **All or nothing within the answer given.** A share that half-landed would
	/// be a Diamond nobody chose the contents of, so a failure to write leaves the
	/// error to the caller rather than reporting a partial success.
	///
	/// Answers `{ ok, id, wrote, left, said }` — what went in, what was
	/// deliberately left out, and THE SENTENCE FOR IT. `said` is `''` when
	/// everything landed, and it is not optional decoration: a result carrying
	/// `ok: true` beside a count of what it failed to do is how a user comes to be
	/// told success over a partial one, and a count with no words attached is a
	/// count every caller has to remember to look at. The total case -- nothing
	/// landed at all, because the whole share was a page -- comes back `ok: false`
	/// with its own sentence in `why`.
	async function accept(read, opts) {
		var o = opts || {};
		if (!landReady()) {
			throw new Error(tOr('share.err_no_store',
				'This build can read a share but has nowhere to put one.'));
		}
		var withCode = o.withCode;
		if (read.code() && withCode === undefined) withCode = await askAboutCode(read);
		if (!read.code()) withCode = false;		// nothing to include, so nothing was accepted

		var files = [], left = [];
		for (var i = 0; i < read.count(); i++) {
			var path = read.path(i);
			if (read.isCode(i) && !withCode) { left.push(path); continue; }
			files.push({ path: path, body: read.body(i) });
		}
		if (!files.length) {
			return { ok: false, why: tOr('share.err_all_code',
				'Everything in that share is a page, and the page was not accepted, so nothing '
				+ 'has been added.'), left: left, skipped: [], said: '' };
		}

		// The receiver's OWN Diamond: a new one, with a new identity, carrying no
		// record of the sender's delivery and no history of theirs. The name is
		// advisory — the store settles a clash, since two people may pick one name
		// and neither is wrong.
		var id = await DaimondDiamond.land(read.name(), files);
		log('landed', id, files.length, 'files,', left.length, 'left out');
		// A PARTIAL LANDING SAYS SO, and `ok: true` beside a count of what did not
		// arrive is exactly how it stopped saying so. `left` was returned and
		// nothing anywhere read it: a share of five files of which two were pages
		// landed three, reported success, and never mentioned the other two -- and
		// the receiver cannot go and look for what they were never told about.
		// `share.err_all_code` covered only the total case, where nothing lands at
		// all, which is the case a person cannot fail to notice.
		//
		// The sentence goes back with the result as well as onto the screen, so a
		// caller cannot end up holding the list without the words for it. That is
		// the half that stays true in a build with no dialog on the page.
		// THE SHAPE `post.js` ALREADY REPORTS, not a third one. `shortfall(r)` takes
		// a whole answer and names everything in it that fell short, and group.js
		// reports through the same function; a bespoke sentence here would be the
		// third wording for one fact and the next field somebody adds to this answer
		// would be reported in two places or none. A landing leaves out FILES rather
		// than recipients, so the paths are given as `skipped` entries -- a label and
		// the reason -- which is the half of that shape they fit.
		var skipped = left.map(function (path) {
			return { label: path, why: tOr('share.left_page',
				'it is a page you did not accept') };
		});
		var out = { ok: true, id: id, wrote: files.map(function (f) { return f.path; }),
			left: left, skipped: skipped, said: '' };
		out.said = shortSaid(out);
		if (out.said) tell(out.said);
		return out;
	}

	/// What did not land, as a sentence, or '' when everything did.
	///
	/// `DaimondPost.shortfall` IS THE AUTHORITY AND THERE IS NO SECOND COPY OF IT.
	/// This carried one: the old `skipWords` body, joining the labels itself and
	/// saying them through `post.group_skipped` -- a second wording for "these
	/// people have not got it", live on the receiving path, and the fifth and last
	/// instance of the class the other four were fixed for. Two wordings for one
	/// fact is how one of them stops being translated, and the one that stops is
	/// always the one nobody is looking at.
	///
	/// `shortfall` takes THE WHOLE ANSWER rather than the `skipped` field, which is
	/// the reason it is reachable from here at all: the next thing added to a
	/// landing's answer is reported by it or nowhere, and this file does not have to
	/// learn what that thing was.
	///
	/// WHEN THE AUTHORITY IS ABSENT THERE IS NO SENTENCE, and the absence is said
	/// out loud rather than papered over. `www/index.html` loads `js/post.js` ten
	/// lines above this file, so a build reaching that branch is a build with a
	/// missing script, which is a fault to see rather than to translate around.
	function shortSaid(r) {
		if (!r || !r.skipped || !r.skipped.length) return '';
		try {
			if (window.DaimondPost && typeof DaimondPost.shortfall === 'function') {
				return String(DaimondPost.shortfall(r) || '').trim();
			}
		} catch (e) { log('the shortfall sentence would not compose', e); }
		log('js/post.js is not loaded, so nothing can say what did not land:',
			r.skipped.length, 'file(s)');
		return '';
	}

	/// Put `text` in front of the receiver.
	///
	/// NOT AWAITED, and that is a bug avoided rather than a style. `accept` runs
	/// inside `receive`'s `try`, whose `finally` frees the wasm reading; awaiting a
	/// dialog there would hold that reading open for as long as the dialog stood,
	/// and for any caller that is not a person sitting in front of the screen it
	/// would never return at all. `landDiamond` in `daimond.js` carries the same
	/// note over the same mistake, made once already.
	///
	/// `DaimondCore.confirm` with no second button is a one-button notice -- which
	/// is what `noticeDialog` is, and that is private to `daimond.js`. A published
	/// `DaimondCore.notice` would be the right door; this is the one that exists.
	function tell(text) {
		try {
			if (window.DaimondCore && typeof DaimondCore.confirm === 'function') {
				DaimondCore.confirm(text, tOr('dlg.ok', 'OK'), {
					title: tOr('share.landed_title', 'Shared Diamond added'),
					cancelLabel: null,
					danger: false,
				});
				return;
			}
		} catch (e) { /* fall through: the sentence still went back to the caller */ }
		log('nothing to say it with:', text);
	}

	/// Open a sealed share and land it, asking about code on the way.
	///
	/// The whole receiving side in one call, for the control that takes a file.
	/// The wasm reading is freed whatever happens, which a caller doing the two
	/// steps itself has to remember and this does not.
	async function receive(bytes, expectAddr) {
		var read = await openSealed(bytes, expectAddr);
		try {
			return await accept(read);
		} finally {
			try { if (read && read.free) read.free(); } catch (e) { /* already freed */ }
		}
	}

	// ── Handing it over ────────────────────────────────────────

	/// What a sealed share is called when it is written out as a file.
	///
	/// The address is in the name, so two shares of one Diamond do not overwrite
	/// each other and a person can see that the file they were given is the file
	/// they were told about.
	function filename(made) {
		var stem = String((made && made.name) || 'share')
			.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40);
		var addr = String((made && made.addr) || '').slice(0, 12);
		return (stem || 'share') + (addr ? '-' + addr : '') + EXT;
	}

	// ── Which carrier ──────────────────────────────────────────
	//
	// A COMPOSED SHARE HAD NOWHERE TO GO. Everything above builds a sealed
	// envelope and stops, and the relay -- the only carrier this app had -- refuses
	// one over 64 KiB. The Log Life capp page alone is about 64 KB, so a share
	// carrying a capp could not go through the relay AT ALL: the whole capp-sharing
	// feature dead-ended at a byte count, and it dead-ended silently.
	//
	// So the carrier is CHOSEN, by measuring, and the file route below is what the
	// large case takes. It is also the honest route for a person with no gateway
	// account and for a share going onto a memory stick, which is why it is not
	// hidden behind the size.

	/// Whether a sealed envelope of `n` bytes fits through the relay.
	function fitsRelay(n) {
		// BOTH of the gateway's checks, which are not the same number. `/api/post`
		// turns a body away on the cheap base64-length estimate BEFORE it decodes
		// anything -- `envelope.len() / 4 * 3 > max_bytes` -- and then again on the
		// decoded length. base64 rounds up to a group of three, so the estimate is
		// the stricter of the two, and a sealed envelope of exactly 64 KiB is
		// refused by it: 65,536 bytes is 87,384 characters, and 87384 / 4 * 3 is
		// 65,538. The last size that goes through is 65,535 bytes.
		return Math.ceil(Number(n) / 3) * 3 <= RELAY_MAX;
	}

	/// Which carrier a composed share must take: `'relay'` or `'file'`.
	function carrier(made) {
		var n = (made && made.sealed) ? made.sealed.length : 0;
		return fitsRelay(n) ? 'relay' : 'file';
	}

	/// Which carrier, and why, in the sender's language.
	///
	/// The SIZE is in the sentence rather than a bare "too large", because the
	/// sender is the only person who can do anything about it and the number is
	/// what tells them whether taking one file out would be enough.
	function carrierWhy(made) {
		var n = (made && made.sealed) ? made.sealed.length : 0;
		if (fitsRelay(n)) {
			return tOr('share.by_relay',
				'This share is {size} and goes straight to them through the relay.',
				{ size: kb(n) });
		}
		return tOr('share.by_file',
			'This share is {size} and the relay carries at most {max}, so it travels as a '
			+ 'file: save it and give them the file. It is sealed to them either way.',
			{ size: kb(n), max: kb(RELAY_MAX) });
	}

	/// A byte count the way a sender reads one.
	function kb(n) {
		var v = Number(n) || 0;
		if (v < 1024) return v + ' B';
		if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
		return (v / (1024 * 1024)).toFixed(1) + ' MB';
	}

	// ── The file route ─────────────────────────────────────────
	//
	// The handover is the app's own: one `Blob`, one object URL, a synthetic
	// `<a download>`, and the URL revoked straight after. Every other place
	// Daimond gives somebody a file does exactly this, and a second way of doing
	// it would be a second thing to fix.
	//
	// WHAT DOES NOT CHANGE BY GOING THROUGH A FILE. The bytes are the same sealed
	// envelope the relay would have carried: the same signature over the same
	// payload, the same slot per recipient, the same address. A `.dshare` is
	// therefore no more trusted than a message -- and in particular the CONSENT
	// STEP IS THE SAME ONE. `take` goes through `receive`, which goes through
	// `accept`, which asks `askAboutCode` before a page is written. Opening a file
	// somebody handed you must never become a way of running their program, and
	// the gate is on the WRITE rather than on the mount because a Diamond that
	// holds a page mounts it the moment it is opened.

	/// Hand a composed share over as a `.dshare`. Answers the name it was given.
	function save(made) {
		if (!made || !made.sealed || !made.sealed.length) {
			throw new Error(tOr('share.err_nothing',
				'There is nothing to share: name a Diamond or the files to send.'));
		}
		var name = filename(made);
		var a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([made.sealed], { type: MIME }));
		a.download = name;
		a.rel = 'noopener';
		a.click();
		URL.revokeObjectURL(a.href);
		log('saved', name, made.sealed.length, 'bytes');
		return name;
	}

	/// What was saved, as a sentence, for a panel that wants to say it.
	function savedSaid(name) {
		return tOr('share.saved_as',
			'Saved as {name}. Give them that file: it is sealed to them and to nobody else.',
			{ name: name });
	}

	/// The bytes of a `.dshare`, whatever shape a caller is holding it in.
	async function bytesOf(src) {
		if (src instanceof Uint8Array) return src;
		if (typeof Blob !== 'undefined' && src instanceof Blob) {
			return new Uint8Array(await src.arrayBuffer());
		}
		if (typeof ArrayBuffer !== 'undefined' && src instanceof ArrayBuffer) {
			return new Uint8Array(src);
		}
		// A base64 envelope, which is the form the relay carries and the form a
		// person pastes. Anything else is not a share and says so.
		if (typeof src === 'string' && src) return b64dec(src);
		throw new Error(tOr('share.err_no_file',
			'No file was chosen, so nothing was opened.'));
	}

	/// Take a `.dshare` and land what is in it.
	///
	/// `expectAddr` where the receiver was told an address to expect, which is
	/// checked by `openSealed` and not here.
	///
	/// The two guards before the seal are about the FILE and not about the share: a
	/// file of no bytes and a file far larger than any share can be are both
	/// answered without decrypting anything, so a wrong file dropped in costs a
	/// sentence. Everything that is actually about the share -- magic, envelope,
	/// address, signature, canonical encoding, schema, and who it is addressed to
	/// -- is checked where it always was.
	async function take(src, expectAddr) {
		var b = await bytesOf(src);
		if (!b.length) {
			throw new Error(tOr('share.err_not_share',
				'That file is not a Daimond share.'));
		}
		if (b.length > FILE_MAX) {
			throw new Error(tOr('share.err_file_huge',
				'That file is {size}, which is larger than any share can be, so it was not '
				+ 'opened.', { size: kb(b.length) }));
		}
		return await receive(b, expectAddr);
	}

	/// Ask for a `.dshare` from the machine, and land what is chosen.
	///
	/// Must be called from a click: an `<input type="file">` opens nothing without
	/// a user gesture, which is the browser's own rule and the right one -- a page
	/// that could open a file chooser on a timer could open one over something the
	/// person meant to press.
	function pick(expectAddr) {
		return new Promise(function (resolve, reject) {
			if (typeof document === 'undefined' || !document.body) {
				reject(new Error(tOr('share.err_no_file',
					'No file was chosen, so nothing was opened.')));
				return;
			}
			var input = document.createElement('input');
			input.type = 'file';
			// Both, because a browser matches the extension and an operating system
			// that has never seen a `.dshare` matches the type.
			input.accept = EXT + ',' + MIME;
			input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px';
			var done = false;
			function finish(fn, arg) {
				if (done) return;
				done = true;
				try { input.remove(); } catch (e) { /* already gone */ }
				fn(arg);
			}
			input.addEventListener('change', function () {
				var f = input.files && input.files[0];
				if (!f) {
					finish(reject, new Error(tOr('share.err_no_file',
						'No file was chosen, so nothing was opened.')));
					return;
				}
				// Resolved with the PROMISE of the landing, so a caller awaiting this
				// is awaiting the whole of it -- including the consent question.
				take(f, expectAddr).then(function (r) { finish(resolve, r); },
					function (e) { finish(reject, e); });
			});
			// A chooser somebody closed still has to SETTLE -- a promise left pending
			// is a button that never comes back. It settles as a rejection carrying
			// "no file was chosen", and whether that earns a red line is the caller's
			// decision and not this function's: nothing here can draw one.
			input.addEventListener('cancel', function () {
				finish(reject, new Error(tOr('share.err_no_file',
					'No file was chosen, so nothing was opened.')));
			});
			document.body.appendChild(input);
			input.click();
		});
	}

	// ── The panel ──────────────────────────────────────────────
	//
	// EVERYTHING ABOVE THIS LINE WAS COMPLETE AND UNREACHABLE. share.js could
	// collect a Diamond, sign it, seal it to one person, choose a carrier, write a
	// `.dshare` out and read one back in -- and no button anywhere in Daimond
	// called any of it. A module with no production caller is not done, and this
	// project had shipped that failure three times before this one. Forty checks
	// passing against a surface a user cannot reach prove only that the surface
	// works.
	//
	// So this is the Share view of the Social panel, and it renders into
	// `#social-share-list` exactly as post.js renders into the messages list: the
	// chip, the head and the empty line belong to improve.js, and everything below
	// the line is this file's. The two halves of the feature are both here, in the
	// order a person meets them -- taking one in needs nothing but the file, and
	// sending one needs a Diamond and somebody to send it to.

	var HOST = '#social-share-list';
	var VIEW = 'share';

	function host() { return document.querySelector(HOST); }

	function node(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	/// The line under the chip goes away exactly when there is something to read.
	function said(n) {
		try {
			if (window.DaimondSocial && DaimondSocial.filled) DaimondSocial.filled(VIEW, n);
		} catch (e) { /* no panel shell */ }
	}

	/// Draw the view. Cleared wholesale every time, so nothing belonging to
	/// anything else may be parked inside it.
	function render() {
		var h = host();
		if (!h) return;
		h.textContent = '';
		var stop = why();
		if (stop) {
			// The off-line carries the REASON rather than a generic absence: the
			// three ways this can be unavailable fail differently and a person
			// deserves to know which.
			var off = document.getElementById('social-share-off');
			if (off) off.textContent = stop;
			said(0);
			return;
		}
		h.appendChild(takeBlock());
		h.appendChild(sendBlock());
		said(1);
	}

	/// Taking one in. First, because it needs nothing of the user but the file.
	function takeBlock() {
		var box = node('div', 'shr-block');
		box.appendChild(node('h3', 'shr-head', tOr('share.panel_take_head', 'Open a share')));
		box.appendChild(node('p', 'shr-note', tOr('share.panel_take_help',
			'Take a {ext} somebody gave you. A page inside it is a program they wrote, and '
			+ 'it is never written into your workspace without asking you first.',
			{ ext: EXT })));
		var say = node('p', 'shr-say');
		say.hidden = true;
		var b = node('button', 'shr-btn shr-take', tOr('share.panel_take', 'Open a share file…'));
		b.type = 'button';
		b.addEventListener('click', function () {
			say.className = 'shr-say';
			say.textContent = '';
			say.hidden = true;
			// `pick` MUST be called from the click, which is why it is called here
			// and not through a helper that awaits something first: an
			// `<input type="file">` opens nothing without a user gesture.
			pick().then(function (r) {
				if (!r || !r.ok) {
					// The total refusal -- everything in it was a page and the page was
					// declined -- carries its own sentence, and it is not an error.
					say.className = 'shr-say';
					say.textContent = (r && r.why) || tOr('share.err_all_code',
						'Everything in that share is a page, and the page was not accepted, so '
						+ 'nothing has been added.');
					say.hidden = false;
					return;
				}
				// WHAT LANDED AND WHAT DID NOT, in one line each. `said` on the
				// result is '' when everything arrived; when it is not, it names the
				// files that were left out, and a receiver who was never told cannot
				// go looking for them.
				say.className = 'shr-say';
				say.textContent = tOr('share.landed_ok',
					'Added as a Diamond of your own. {n} file(s) arrived.',
					{ n: r.wrote.length });
				say.hidden = false;
				if (r.said) {
					var more = node('p', 'shr-say shr-warn', r.said);
					say.parentNode.appendChild(more);
				}
			}, function (e) {
				say.className = 'shr-say shr-warn';
				say.textContent = (e && e.message) ? e.message : String(e);
				say.hidden = false;
			});
		});
		box.appendChild(b);
		box.appendChild(say);
		return box;
	}

	/// Sending one. The Diamond is the one being worked, because that is the
	/// gesture -- you are looking at something and you give somebody a copy --
	/// and because a picker of every Diamond would be a second Diamonds list in a
	/// panel that is not the rail.
	function sendBlock() {
		var box = node('div', 'shr-block');
		box.appendChild(node('h3', 'shr-head', tOr('share.panel_send_head', 'Send a Diamond')));

		var cur = null;
		try {
			if (window.DaimondDiamond && DaimondDiamond.current) cur = DaimondDiamond.current();
		} catch (e) { cur = null; }
		if (!cur || !cur.id) {
			box.appendChild(node('p', 'shr-note', tOr('share.panel_no_diamond',
				'Open a Diamond to share it. A share carries the files of one Diamond, so '
				+ 'there has to be one in front of you.')));
			return box;
		}

		var folk = [];
		try {
			if (window.DaimondPost && DaimondPost.people) folk = DaimondPost.people() || [];
		} catch (e) { folk = []; }
		folk = folk.filter(function (p) { return p && p.pub && p.enc; });
		if (!folk.length) {
			// A sealing key is what a share needs, and a person known by signing key
			// alone has not got one. Said in those terms rather than "nobody yet",
			// because the fix is specific: swap codes.
			box.appendChild(node('p', 'shr-note', tOr('share.panel_no_people',
				'Nobody here has a sealing key yet, so there is nobody a share can be '
				+ 'sealed to. Show somebody your code, or read theirs.')));
			return box;
		}

		box.appendChild(node('p', 'shr-note', tOr('share.panel_this',
			'Sharing “{name}” — a copy they will own, not a view of yours.',
			{ name: cur.name || cur.id })));

		var pickWho = node('select', 'shr-who');
		pickWho.setAttribute('aria-label', tOr('share.panel_who', 'Who it goes to'));
		for (var i = 0; i < folk.length; i++) {
			var o = node('option', null, folk[i].label || fingerprintOf(keyBytes(folk[i].pub)));
			o.value = folk[i].pub;
			pickWho.appendChild(o);
		}

		var say = node('p', 'shr-say');
		say.hidden = true;
		var extra = node('p', 'shr-say');
		extra.hidden = true;

		var go = node('button', 'shr-btn shr-send', tOr('share.panel_send', 'Share'));
		go.type = 'button';
		go.addEventListener('click', function () {
			var who = null;
			for (var j = 0; j < folk.length; j++) {
				if (folk[j].pub === pickWho.value) { who = folk[j]; break; }
			}
			if (!who) return;
			go.disabled = true;
			extra.hidden = true;
			extra.textContent = '';
			say.className = 'shr-say';
			say.textContent = tOr('share.panel_sealing', 'Sealing…');
			say.hidden = false;
			sendTo(cur, who, say, extra).then(function () { go.disabled = false; },
				function (e) {
					say.className = 'shr-say shr-warn';
					say.textContent = (e && e.message) ? e.message : String(e);
					say.hidden = false;
					go.disabled = false;
				});
		});

		var row = node('div', 'shr-row');
		row.appendChild(pickWho);
		row.appendChild(go);
		box.appendChild(row);
		box.appendChild(say);
		box.appendChild(extra);
		return box;
	}

	/// Compose a share of `cur` to `who`, and hand it to whichever carrier fits.
	///
	/// THE CARRIER IS CHOSEN AND THE CHOICE IS SAID. A person watching this needs
	/// to know which happened, because the two ask different things of them: a
	/// relay send is finished when it says so, and a file is finished when they
	/// have given somebody the file.
	async function sendTo(cur, who, say, extra) {
		var made = await compose({
			name: cur.name || cur.id,
			diamond: cur.id,
			to: who.pub,
			toEnc: who.enc,
		});
		var name = who.label || fingerprintOf(keyBytes(who.pub));
		if (carrier(made) === 'file') {
			var file = save(made);
			say.className = 'shr-say';
			say.textContent = savedSaid(file);
			say.hidden = false;
			extra.className = 'shr-say';
			extra.textContent = carrierWhy(made);
			extra.hidden = false;
			return;
		}
		// The relay. `DaimondPost.fanout` is the door a message and a group roster
		// both take, called and not copied: a second POST written here would be a
		// second place for the relay's refusals to lose their words, which is
		// exactly what happened to the group send once already.
		if (!window.DaimondPost || typeof DaimondPost.fanout !== 'function') {
			var only = save(made);
			say.className = 'shr-say';
			say.textContent = savedSaid(only);
			say.hidden = false;
			return;
		}
		var r = await DaimondPost.fanout(made, [who.pub]);
		if (r && r.sent) {
			say.className = 'shr-say';
			say.textContent = tOr('share.panel_sent', 'Sent to {who}.', { who: name });
			say.hidden = false;
			return;
		}
		// REFUSED, AND THE REASON, AND WHAT TO DO INSTEAD. `fanout` answers a
		// `why` per recipient and a caller that read only `sent` would report
		// nothing at all -- the same defect as a landing that counts what it left
		// out and says none of it.
		var bad = (r && r.refused && r.refused[0]) || null;
		say.className = 'shr-say shr-warn';
		say.textContent = tOr('share.panel_refused',
			'The relay would not take it: {why} It is saved as a file instead — give them '
			+ 'that.', { why: (bad && bad.why) ? bad.why : '' });
		say.hidden = false;
		var fell = save(made);
		extra.className = 'shr-say';
		extra.textContent = savedSaid(fell);
		extra.hidden = false;
	}

	// ── Wiring ─────────────────────────────────────────────────

	function attachPanel() {
		if (!host()) return false;
		try {
			if (window.DaimondSocial && DaimondSocial.watch) {
				DaimondSocial.watch(function (view) { if (view === VIEW) render(); });
			}
		} catch (e) { /* no panel to watch */ }
		// Say the panel's own words again in a new language. Every string here is
		// built rather than marked up, so a language change reaches none of them
		// unless this surface is registered -- the trap post.js names in the same
		// words three hundred lines above its own registration.
		try {
			DaimondI18n.surface(function () { return host(); }, function () { render(); });
		} catch (e) { /* no i18n in this build */ }
		render();
		return true;
	}

	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', function () { attachPanel(); });
		} else if (!attachPanel()) {
			document.addEventListener('DOMContentLoaded', function () { attachPanel(); });
		}
		// The Diamond being worked decides what the Send half offers, so a change of
		// Diamond redraws it. Without this the panel offers to share whatever was
		// open when it was last drawn, which is a share of the wrong thing.
		document.addEventListener('daimond-diamond-changed', function () {
			try { if (host()) render(); } catch (e) { /* nothing drawn yet */ }
		});
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondShare = {
		/// Whether this build can share at all, and why not. A caller drawing a
		/// disabled control needs the sentence, not the boolean.
		ready: ready,
		why:   why,
		/// The three parts, separately, so a caller can draw between them.
		collect: collect,
		compose: compose,
		open:    openSealed,
		accept:  accept,
		/// The whole receiving side in one call.
		receive: receive,
		/// What a reading says, without holding the wasm object open.
		describe:  describe,
		codePaths: codePaths,
		/// The consent question on its own, for a caller that has already read a
		/// share and wants to ask before doing anything else with it.
		askAboutCode: askAboutCode,
		/// What a sealed share is called as a file, and the extension it wears.
		filename: filename,
		ext:      EXT,
		mime:     MIME,
		/// Which carrier a composed share must take, and the sentence that says
		/// why. The relay refuses one over 64 KiB and a capp page is about that on
		/// its own, so this is not a corner case.
		carrier:    carrier,
		carrierWhy: carrierWhy,
		fitsRelay:  fitsRelay,
		/// The file route, both ways. `save` writes one out; `take` reads one in
		/// from a `File`, a `Blob`, bytes or a base64 envelope; `pick` asks for one
		/// and must be called from a click. All three keep the consent step: a capp
		/// arriving by file is asked about exactly as one arriving by relay is.
		save:      save,
		savedSaid: savedSaid,
		take:      take,
		pick:      pick,
		/// The panel. `render` is published so a verifier draws the view the way the
		/// chip does rather than through a second path written for it.
		render: render,
		view:   VIEW,
		/// The schema, and the ceilings, for a panel that wants to say them.
		schema: SCHEMA,
		limits: { files: FILES_MAX, bytes: TOTAL_MAX, note: NOTE_MAX,
		          relay: RELAY_MAX, file: FILE_MAX },
	};
})();
