/* ============================================================
   Daimond — private messages (post.js)
   ------------------------------------------------------------
   The client half of the relay. `/api/post` is a post box the
   gateway cannot read: a message is sealed on this device to a
   key the recipient proved they hold, and what leaves here is
   ciphertext with a little metadata around it.

   ── THE FOUR RULES THIS FILE EXISTS TO KEEP ─────────────────

   1. THE SEAL IS MADE HERE AND OPENED HERE. Nothing between the
      two devices sees a body. The gateway carries base64 and
      cannot do anything else with it.

   2. WASM ENCODES, JAVASCRIPT SIGNS. The device signing key is a
      non-extractable WebCrypto key, so it cannot be handed to
      wasm and must not become extractable to make this easier.
      `DaimondCrypto` hands out a signing input and takes a
      signature back, and never sees a secret in either direction.

   3. THE ACK COMES AFTER THE COMMIT, NEVER BEFORE. A message is
      collected when a device has folded it into the account's
      sync parcel AND THAT PUSH HAS COMMITTED. Then, and only
      then, the relay is told it may let go. Ack after commit
      costs a crash one re-collect; ack before commit costs a
      device wiped in that window the only copy there was.

   4. A ROW THE RELAY WROTE IS NEVER DRAWN AS A PERSON. `kind` is
      a safety field: anything but "post" carries no envelope and
      no signature, so it goes in `notes` and can never reach the
      message list. The relay writes expiry notices; a relay that
      had been taken over would write whatever it liked.

   ── WHAT IS ENCRYPTED, AND WHERE ────────────────────────────
   In flight and at the relay: the seal below. At rest on this
   device: the store is wrapped with `DaimondIdentity.wrap`, the
   same one scheme that wraps the API key, the mailbox passwords
   and the forge voice. Not a second scheme — a second way of
   encrypting a secret at rest is how one of the two stops being
   reviewed. In the sync parcel: plaintext, because sync.js wraps
   the whole parcel under the same key before it leaves.

   The consequence is that the store can only be READ while the
   identity is unlocked, so `snapshot()` answers null while it is
   locked rather than an empty record. An empty record would read
   to the merge on the other device as "everything was deleted".

   Attaches one global, `window.DaimondPost`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written at the call site where the
	/// table has no entry for it yet. The same device voice.js and improve.js use.
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
			console.log.apply(console, ['[post]'].concat([].slice.call(arguments)));
		} catch (e) { /* no console */ }
	}

	// ── Where things are ───────────────────────────────────────

	/// The relay. One path, five operations, all on the caller's own account.
	var PATH = '/api/post';

	/// The store, wrapped. `daimond-` prefixed so accounts.js namespaces it per
	/// account without this file knowing: two people at one browser have two
	/// message stores and neither can see the other's.
	var LS = 'daimond-post';

	/// The record's shape, so a later one can be told from this one.
	// 2 since the artefact, the envelope and the content key began to be kept on
	// each incoming message: a record written by version 1 has none of them, so a
	// build reading one would draw a Report control over evidence that is not
	// there. `read()` answers a fresh record for any version it does not know,
	// which is the right trade while nothing is deployed -- the messages a bump
	// costs are re-collectable from the relay; a report that cannot be checked is
	// not repairable at all.
	// 3 since `groups` joined it. A group's roster and the messages sealed under
	// that roster are ONE account state and must merge together: a device that
	// adopted the messages and not the roster would hold a message for a group it
	// does not know it is in, and would refuse to open the next one.
	var REC_V = 3;

	/// The region the Social panel gives this module: the Messages view's list.
	/// Everything drawn below lives inside it, and the panel's own head, chips and
	/// empty line belong to improve.js. `DaimondSocial.filled('messages', n)` is
	/// how the honest "not switched on" line above it goes away, and it goes away
	/// only when a row has actually been drawn.
	var HOST = '#social-messages-list';

	/// Which view of the Social panel this module owns.
	var VIEW = 'messages';

	// ── The seal ───────────────────────────────────────────────
	//
	// One content key, sealed once per recipient slot: the age/PGP shape. That
	// one choice buys the sender's own Sent copy, groups later, and an offline
	// recovery slot, for a few lines.
	//
	//   "DPS1" (4) | epk (32) | n (1) | slot × n (60 each) | iv (12) | ciphertext
	//
	// The ephemeral key is per message and is what makes a slot openable: the
	// recipient computes the SAME shared secret from their own sealing key and
	// this public one, so nothing about the sender has to travel in the clear for
	// the seal to work. There is no recipient tag on a slot -- a reader tries
	// each in turn, which costs microseconds and means the envelope discloses the
	// NUMBER of recipients and not who they are.

	/// Magic, so a blob that is not one of these is refused rather than decoded.
	var MAGIC = [0x44, 0x50, 0x53, 0x31];		// "DPS1"

	/// AES-GCM nonce width, matching identity.js.
	var IV = 12;

	/// A slot: nonce, then the 32-byte content key with its 16-byte tag.
	var SLOT = IV + 32 + 16;

	/// The domain this seal's key derivation runs in. A tag that is not a prefix
	/// of any other tag, so two derivations can never collide.
	var SEAL_INFO = 'daimond.post.seal.v1';

	/// The schema every message is signed under. The purpose tag is inside the
	/// signing input, so a signature over a card can never be read as one over a
	/// message.
	var SCHEMA = 'daimond/post/0';

	/// The most a body may carry, in bytes of UTF-8. Exactly `limit::BODY_BYTES`
	/// in the schema's own crate: checked here so a person is told before they
	/// have composed anything, and checked there because that is the authority.
	var BODY_MAX = 8 * 1024;

	/// The most recipients one envelope may name. The slot count is one byte.
	var SLOTS_MAX = 255;

	// ── Encoding ───────────────────────────────────────────────

	function utf8(s) { return new TextEncoder().encode(String(s)); }

	function b64enc(buf) {
		var b = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
		var bin = '';
		for (var i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
		return btoa(bin);
	}

	function b64dec(str) {
		var bin = atob(String(str));
		var out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	/// Standard base64 to the base64url the gateway binds an account by. The two
	/// encodings differ and mixing them up fails a lookup silently.
	function b64url(b64) {
		return String(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	/// base64url back to raw bytes.
	function urldec(s) {
		var b = String(s).replace(/-/g, '+').replace(/_/g, '/');
		while (b.length % 4) b += '=';
		return b64dec(b);
	}

	function hex(bytes) {
		var s = '';
		for (var i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
		return s;
	}

	function unhex(s) {
		var str = String(s || '');
		var out = new Uint8Array(str.length >> 1);
		for (var i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
		return out;
	}

	/// A millisecond timestamp, kept whole.
	///
	/// NOT `| 0`, and this is the reason it is its own function. A bitwise
	/// operator coerces to a SIGNED 32-BIT integer, and a Unix millisecond passed
	/// 2038 in 1970 -- `Date.now()` is about 1.79e12, so `x | 0` wraps it to
	/// whatever the low thirty-two bits happen to be. The wrapped values stay
	/// locally ordered, which is exactly why this survives being looked at: two
	/// stamps a second apart still compare correctly, and the ordering only
	/// inverts when the pair straddles a 2^32 boundary, about every fifty days.
	/// A message list that sorted itself wrongly for one day in fifty, or a
	/// roster that a later one failed to replace, would be blamed on anything but
	/// arithmetic.
	///
	/// Seconds-scale stamps -- the gateway's `row.ts` -- are inside the range and
	/// are left as they were.
	function ms(v) {
		var n = Number(v);
		return isFinite(n) ? Math.trunc(n) : 0;
	}

	/// Concatenate byte arrays.
	function cat(parts) {
		var n = 0, i;
		for (i = 0; i < parts.length; i++) n += parts[i].length;
		var out = new Uint8Array(n), at = 0;
		for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
		return out;
	}

	/// Constant-ish byte equality, for comparing keys. Length first, then every
	/// byte: equality of keys is always the FULL key, never a fingerprint.
	function sameBytes(a, b) {
		if (!a || !b || a.length !== b.length) return false;
		var d = 0;
		for (var i = 0; i < a.length; i++) d |= a[i] ^ b[i];
		return d === 0;
	}

	// ── The wasm bridge ────────────────────────────────────────
	//
	// The same arrangement identity.js uses, and for the same reason: this is a
	// classic script, the canonical encoding lives in the format's own crate, and
	// a second encoding written in JavaScript would be a second address for one
	// message. Nothing here computes what the crate owns.

	/// The bridge, or null before it is up.
	function bridge() {
		return (typeof window !== 'undefined' && window.DaimondCrypto) || null;
	}

	/// Whether the bridge carries everything this file needs.
	///
	/// `postDraft` is the one name identity.js did not need, and it is the message
	/// encoder. Said out loud when it is missing rather than worked around: a
	/// message encoded here instead would have a different address from the same
	/// message encoded by any other build.
	function cryptoReady() {
		var b = bridge();
		return !!(b && typeof b.postDraft === 'function' && typeof b.signingInput === 'function'
			&& typeof b.assemble === 'function' && typeof b.address === 'function'
			&& typeof b.read === 'function');
	}

	/// Why the bridge cannot be used, in words, or '' when it can.
	function cryptoWhy() {
		var b = bridge();
		if (!b) return tOr('post.err_no_bridge',
			'This build cannot compose a message: its message format is not loaded.');
		if (typeof b.postDraft !== 'function') return tOr('post.err_no_draft',
			'This build cannot compose a message: its message encoder is not loaded.');
		return cryptoReady() ? '' : tOr('post.err_no_bridge',
			'This build cannot compose a message: its message format is not loaded.');
	}

	// ── Sealing ────────────────────────────────────────────────

	/// Derive one slot key from a shared secret.
	///
	/// The raw ECDH output is not uniformly distributed, so it is the INPUT to a
	/// derivation and never a key. The recipient's own public key is in the salt,
	/// which binds a slot to the party it was made for: a slot lifted out of one
	/// envelope and dropped into another derives a different key and does not open.
	async function slotKey(sharedBits, epk, theirPub) {
		var base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
		return await crypto.subtle.deriveKey(
			{ name: 'HKDF', hash: 'SHA-256', salt: cat([epk, theirPub]), info: utf8(SEAL_INFO) },
			base,
			{ name: 'AES-GCM', length: 256 },
			false,
			['encrypt', 'decrypt']);
	}

	/// Seal bytes to a list of 32-byte X25519 public keys.
	///
	/// The sender puts their OWN key in the list to keep a Sent copy; nothing here
	/// does that for them, because a caller that did not ask for one must not get
	/// a slot it does not know about.
	async function seal(recipients, plainBytes) {
		if (!recipients || !recipients.length) {
			throw new Error(tOr('post.err_no_recipient',
				'A sealed message needs at least one recipient key.'));
		}
		if (recipients.length > SLOTS_MAX) {
			throw new Error(tOr('post.err_too_many',
				'A message can be sealed to at most {n} people at once.', { n: SLOTS_MAX }));
		}
		var i;
		for (i = 0; i < recipients.length; i++) {
			if (!recipients[i] || recipients[i].length !== 32) {
				throw new Error(tOr('post.err_bad_key',
					'One of the recipients has no usable key, so nothing was sent.'));
			}
		}

		var pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
		var epk  = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

		// The content key: one per message, sealed once per slot.
		var ck  = crypto.getRandomValues(new Uint8Array(32));
		var aad = cat([new Uint8Array(MAGIC), epk]);

		var slots = [];
		for (i = 0; i < recipients.length; i++) {
			var theirs = await crypto.subtle.importKey(
				'raw', recipients[i], { name: 'X25519' }, false, []);
			var bits = new Uint8Array(await crypto.subtle.deriveBits(
				{ name: 'X25519', public: theirs }, pair.privateKey, 256));
			var k  = await slotKey(bits, epk, recipients[i]);
			var iv = crypto.getRandomValues(new Uint8Array(IV));
			var ct = new Uint8Array(await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: iv, additionalData: aad }, k, ck));
			slots.push(cat([iv, ct]));
		}

		var head = cat([new Uint8Array(MAGIC), epk, new Uint8Array([recipients.length])]
			.concat(slots));
		// The body is bound to the WHOLE head, so a slot cannot be swapped in from
		// another envelope without the body ceasing to open.
		var bodyKey = await crypto.subtle.importKey(
			'raw', ck, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
		var biv = crypto.getRandomValues(new Uint8Array(IV));
		var bct = new Uint8Array(await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv: biv, additionalData: head }, bodyKey, plainBytes));
		return cat([head, biv, bct]);
	}

	/// Open a sealed envelope with this device's sealing key, and answer BOTH the
	/// plaintext artefact and the content key that opened it.
	///
	/// Throws with a sentence a person can read. A slot that does not open is not
	/// an error -- most slots in a group message are somebody else's -- so the
	/// refusal comes only when NONE of them does.
	async function unsealFull(bytes) {
		var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		if (b.length < 4 + 32 + 1 + SLOT + IV + 16) {
			throw new Error(tOr('post.err_short', 'That message is too short to be one.'));
		}
		for (var m = 0; m < 4; m++) {
			if (b[m] !== MAGIC[m]) {
				throw new Error(tOr('post.err_not_sealed',
					'That is not a sealed Daimond message.'));
			}
		}
		var epk = b.slice(4, 36);
		var n   = b[36];
		var end = 37 + n * SLOT;
		if (n === 0 || b.length < end + IV + 16) {
			throw new Error(tOr('post.err_short', 'That message is too short to be one.'));
		}
		var head = b.slice(0, end);
		var aad  = cat([new Uint8Array(MAGIC), epk]);

		var mine = window.DaimondIdentity ? DaimondIdentity.sealingKeyRaw() : null;
		if (!mine) {
			throw new Error(tOr('post.err_no_sealing_key',
				'This device has no sealing key, so it cannot open a sealed message. '
				+ 'Unlock Daimond once and one will be made.'));
		}
		// One shared secret, one key, tried against every slot. The recipient does
		// not know which slot is theirs, and an envelope that said would be an
		// envelope that names its readers.
		var bits = await DaimondIdentity.sharedSecret(epk);
		var k    = await slotKey(bits, epk, mine);

		var ck = null;
		for (var i = 0; i < n; i++) {
			var at = 37 + i * SLOT;
			try {
				ck = new Uint8Array(await crypto.subtle.decrypt(
					{ name: 'AES-GCM', iv: b.slice(at, at + IV), additionalData: aad },
					k, b.slice(at + IV, at + SLOT)));
				break;
			} catch (e) { ck = null; }
		}
		if (!ck) {
			throw new Error(tOr('post.err_not_for_you',
				'This message was not sealed to any key this device holds.'));
		}
		var bodyKey = await crypto.subtle.importKey(
			'raw', ck, { name: 'AES-GCM' }, false, ['decrypt']);
		// THE CONTENT KEY COMES BACK OUT WITH THE PLAINTEXT, and that is the whole
		// of why this function was split in two. It used to be recovered here and
		// thrown away, so a caller that needed it later -- report.js, which has to
		// hand an operator the sealed form AND the key that opens it, or the report
		// is unverifiable -- had only one way to get it: implement the seal a second
		// time. This file's own header forbids exactly that, for the reason voice.js
		// states: a second way of doing this is how one of the two stops being
		// reviewed.
		return {
			plain: new Uint8Array(await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: b.slice(end, end + IV), additionalData: head },
				bodyKey, b.slice(end + IV))),
			ck: ck,
		};
	}

	/// The plaintext artefact alone, which is what most callers want.
	///
	/// The published shape, unchanged: `unsealFull` is the one that also answers
	/// the content key, and nothing outside this file needs both unless it is
	/// building a report.
	async function unseal(bytes) {
		return (await unsealFull(bytes)).plain;
	}

	// ── Composing ──────────────────────────────────────────────

	/// Build, sign and seal one message. Answers `{ addr, envelope, artefact }`.
	///
	/// THE SEAM, drawn the way §2.5.4 requires it: the crate encodes the payload
	/// and says what to sign, this signs it with a key that never crosses the
	/// boundary, and the crate takes the signature back and assembles. A caller
	/// cannot sign one envelope and assemble a different one, because the envelope
	/// is a pure function of the four arguments both calls are given.
	///
	/// `to` is the recipient's SIGNING key -- what the relay addresses by and what
	/// the reader checks the payload against. `toEnc` is their SEALING key, which
	/// is a different key for a stated reason (see identity.js), and is what the
	/// slot is made for.
	///
	/// `group` is the other shape, and it changes only what goes in those two
	/// places: `{ id, enc }` puts the GROUP's 32-byte id in the signed `to` and
	/// gives the envelope one slot per member. The id is not a public key and
	/// nothing here treats it as one -- the schema's `to` is thirty-two bytes and
	/// says nothing about what they are -- so a group needs no second schema, no
	/// change to the wasm write side and no third field anywhere.
	///
	// ── THE FAN-OUT, AND WHERE IT ACTUALLY STOPS ────────────────
	//
	// One envelope, one slot per member. A slot is `SLOT` = 60 bytes: 12 of
	// nonce, 32 of content key, 16 of tag. So the envelope carries 60n bytes
	// over what a one-to-one message costs:
	//
	//     10 members     600 B    nothing
	//     50 members     3.0 KB   nothing
	//    255 members    15.3 KB   THE HARD STOP
	//
	// 255 and not the thousand §12.6 estimates, for two reasons that are both
	// in this file rather than in the plan: the slot count is ONE BYTE
	// (`SLOTS_MAX`), and a slot is 60 bytes and not the 48 the plan assumed.
	//
	// The bytes are not the wall, though. The wall is the DELIVERIES. `send`
	// posts the same envelope once per member, so one message to a group of
	// fifty is fifty requests, each taking the relay's single `post_writes`
	// mutex (gateway/src/schema.rs, `Store::deliver_post`), and it lands fifty
	// rows against a box cap of 500 (`POST_BOX_MAX_ROWS`). Fifty people sending
	// ten messages each fills every box in the group. The trigger §12.6 sets
	// for a real group key -- "roughly a thousand members" -- is therefore
	// reached at TENS of members and not at a thousand, and it is reached by
	// request count and box pressure long before it is reached by bytes.
	async function compose(opts) {
		var o = opts || {};
		var body = String(o.body == null ? '' : o.body);
		await read();				// so `encFor` can see the cards this device holds
		var why = cryptoWhy();
		if (why) throw new Error(why);
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			throw new Error(tOr('post.err_locked',
				'Unlock Daimond to send a message: it is signed with your own key.'));
		}
		if (!body.trim()) {
			throw new Error(tOr('post.err_empty', 'There is nothing to send.'));
		}
		if (utf8(body).length > BODY_MAX) {
			throw new Error(tOr('post.err_long',
				'That message is longer than {n} characters of text and was not sent. '
				+ 'It is refused rather than cut: half a message is not a shorter message.',
				{ n: BODY_MAX }));
		}
		var grp   = o.group || null;
		var toPub = grp ? grp.id : (o.to instanceof Uint8Array ? o.to : urldec(o.to));
		if (!toPub || toPub.length !== 32) {
			throw new Error(tOr('post.err_bad_key',
				'One of the recipients has no usable key, so nothing was sent.'));
		}
		var toEnc = null;
		if (!grp) {
			// Named by the caller, or looked up. `encFor` asks trust.js first and
			// falls back to the cards read here; a caller that already holds the
			// key passes it.
			toEnc = o.toEnc instanceof Uint8Array ? o.toEnc
				: (o.toEnc ? b64dec(o.toEnc) : encFor(o.to));
			if (!toEnc || toEnc.length !== 32) {
				throw new Error(tOr('post.err_no_card',
					'There is no sealing key for that person yet, so nothing can be sealed to them. '
					+ 'Scan their code, or ask them to send you theirs.'));
			}
		}
		// A group's slot list MAY be empty, and this is where that was once
		// refused. A group of one -- made, and nobody added yet -- still has a
		// roster, and that roster still has to be sealed and stored so it reaches
		// this account's other devices. The sender's own slot below makes it a
		// valid envelope with one slot in it. Nothing is lost by allowing it: a
		// MESSAGE to a group with nobody in it is refused a step earlier, by
		// `DaimondGroup.sealTo`, in a sentence about the group rather than about
		// the seal.

		var b = bridge();
		var nonce = crypto.getRandomValues(new Uint8Array(16));
		var draft = b.postDraft(body, toPub, nonce);
		var payload;
		try {
			if (o.replyTo) draft.replyTo(unhex(o.replyTo));
			(o.refs || []).forEach(function (r) { addRef(draft, r); });
			payload = draft.encode();
		} finally {
			// A wasm-bindgen object holds memory on the other side of the boundary
			// until it is told to let go, and a draft that is not freed is a leak
			// per message rather than per session.
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

		// The sender's own slot, so a Sent copy is readable on this account's other
		// devices. Left out when this device has no sealing key: better a message
		// the sender cannot re-read than one that cannot be sent at all.
		//
		// One slot each and NO RECIPIENT TAG ON ANY OF THEM, which is what a
		// group message gets for free from the one-to-one seal: the envelope
		// discloses how many people are in the group and never which. A reader
		// trial-decrypts, at microseconds a slot. Nothing below may add a tag to
		// make that loop shorter -- the loop is the property.
		var mine = DaimondIdentity.sealingKeyRaw();
		var to   = grp ? grp.enc.slice() : [toEnc];
		if (mine && !to.some(function (k) { return sameBytes(mine, k); })) to.push(mine);

		return {
			addr:     addr,
			artefact: artefact,
			envelope: b64enc(await seal(to, artefact)),
			ts:       when,
		};
	}

	/// Hang one reference on a draft. The four kinds the schema admits, named
	/// rather than passed through: a fifth would be signed and drawn by nobody.
	function addRef(draft, r) {
		var fb = String((r && r.fallback) || '');
		switch (r && r.kind) {
		case 'proposal':
			draft.addProposal(String(r.account || ''), String(r.repo || ''), r.number | 0, fb);
			break;
		case 'build':
			draft.addBuild(String(r.id || ''), fb);
			break;
		case 'panel':
			draft.addPanel(String(r.name || ''), fb);
			break;
		case 'guide':
			draft.addGuide(String(r.page || ''), String(r.anchor || ''), fb);
			break;
		default:
			throw new Error(tOr('post.err_bad_ref',
				'That is not a kind of reference a message can carry.'));
		}
	}

	/// Open one collected envelope and say what it turned out to be.
	///
	/// THE READER CHECKS AND NOBODY ELSE. The whole verification -- magic,
	/// envelope, address, signature -- runs in `DaimondCrypto.read`, on this
	/// device. Two checks are made here on top of it, and both are about this
	/// account rather than about the artefact:
	///
	///  - the payload's `to` must be THIS account's key, OR a group this device is
	///    in. A message sealed to us but addressed to somebody else is a message
	///    somebody re-slotted, and the signature covers `to`, so this catches it;
	///  - the address the relay carried must be the address the artefact has, or
	///    the row and the message are not the same thing.
	///
	/// THE GROUP CASE IS THE SAME CHECK, asked of a different holder. A group id
	/// is thirty-two signed bytes in exactly the place a signing key sits, and
	/// group.js answers whether this device is in the group they name AND whether
	/// the author is in its current roster. Both halves matter: without the first
	/// anybody could address a message to any thirty-two bytes and have it drawn;
	/// without the second a member the creator removed would keep being drawn for
	/// ever, because there is no group key to rotate them out of and the relay
	/// knows nothing about groups at all. A build with no group module answers no
	/// to both, and behaves exactly as it did before groups existed.
	async function openEnvelope(b64, expectAddr) {
		var opened = await unsealFull(b64dec(b64));
		var plain = opened.plain;
		var b = bridge();
		if (!b || typeof b.read !== 'function') {
			throw new Error(tOr('post.err_no_bridge',
				'This build cannot compose a message: its message format is not loaded.'));
		}
		var got = JSON.parse(b.read(plain));
		if (got.kind !== 'post') {
			throw new Error(tOr('post.err_not_a_post',
				'That is not a message; it is a {kind}.', { kind: String(got.kind || '?') }));
		}
		var mine = await DaimondIdentity.publicKeyRaw();
		if (!mine || hex(mine) !== String(got.post.to)) {
			var g = null;
			try {
				if (window.DaimondGroup && DaimondGroup.accepts) {
					g = await DaimondGroup.accepts(String(got.post.to), got);
				}
			} catch (e) { g = null; }
			if (!g) {
				throw new Error(tOr('post.err_not_addressed',
					'That message is addressed to a different key from this one.'));
			}
			got.gid   = g.gid;
			got.gname = g.name || '';
			got.gop   = !!g.op;
		}
		if (expectAddr && String(expectAddr) !== String(got.address)) {
			throw new Error(tOr('post.err_addr_mismatch',
				'The message the relay named is not the message it carried.'));
		}
		// THE EVIDENCE, carried out beside the reading of it. `art` is the bytes the
		// signature is over; `ck` is what opened the body. A caller that only wants
		// the words ignores both, and `collect` keeps them so that a message can
		// still be reported after the relay has been told to let go -- at which
		// point this device holds the only copy there is.
		got.art = plain;
		got.ck  = opened.ck;
		return got;
	}

	// ── The store ──────────────────────────────────────────────
	//
	// Held in memory while unlocked and wrapped at rest. Read once per unlock;
	// `null` until it has been, which is what stops a locked device publishing an
	// empty record into the parcel and deleting the account's mail everywhere.

	/// The record, or null when it has not been read.
	var _st = null;

	/// A write that has not landed yet, so two writes in a row do not race.
	var _writing = null;

	/// A fresh, empty record.
	function blank() {
		return { v: REC_V, through: 0, acked: 0, tries: 0, msgs: {}, notes: {}, groups: {} };
	}

	/// Read the store out from under the passphrase. Idempotent.
	///
	/// A record that will not unwrap is NOT replaced with an empty one: that would
	/// hand the merge an empty record to spread. It is reported, and the module
	/// stays unread until an unlock that works.
	async function read() {
		if (_st) return _st;
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) return null;
		var raw = null;
		try { raw = localStorage.getItem(LS); } catch (e) { raw = null; }
		if (!raw) { _st = blank(); return _st; }
		var plain;
		try { plain = await DaimondIdentity.unwrap(raw); }
		catch (e) { log('store will not unwrap under this passphrase'); return null; }
		var r = null;
		try { r = JSON.parse(plain); } catch (e) { r = null; }
		if (!r || r.v !== REC_V) { _st = blank(); return _st; }
		r.msgs   = r.msgs   || {};
		r.notes  = r.notes  || {};
		r.groups = r.groups || {};
		r.through = r.through | 0;
		r.acked   = r.acked | 0;
		r.tries   = r.tries | 0;
		_st = r;
		return _st;
	}

	/// Write the store back, wrapped. Serialised, so an interleaved pair of
	/// writes cannot leave the older one on disk.
	async function save() {
		if (!_st) return;
		var mine = _writing = (_writing || Promise.resolve()).then(async function () {
			try {
				localStorage.setItem(LS, await DaimondIdentity.wrap(JSON.stringify(_st)));
			} catch (e) { log('store write failed', e); }
		});
		await mine;
		if (_writing === mine) _writing = null;
	}

	/// Drop what is in memory, for an account switch or a lock.
	function forget() { _st = null; }

	// ── The groups half of the record ──────────────────────────
	//
	// group.js holds NO STORAGE OF ITS OWN and reaches the roster through these
	// three. The record is already wrapped at rest under the identity key,
	// already re-sealed by `DaimondRekey` on a passphrase change and already
	// carried on the sync parcel; a second store would have to repeat all three
	// and would be the weaker of the two, since nothing would exercise it as
	// often. It is also the correct factoring rather than only the cheap one: a
	// device that adopted the messages without the roster would hold a message
	// for a group it does not know it is in.

	/// Whether this device has JOINED a group, read synchronously off the record.
	/// A group only invited, or left, answers false.
	function groupJoined(st, gid) {
		var g = st && st.groups && st.groups[String(gid)];
		return !!(g && g.state === 'joined');
	}

	/// Every group this account knows, as a copy. A copy, so a panel that hangs a
	/// drawing flag on a row cannot write one into the store.
	async function groups() {
		var st = await read();
		if (!st) return null;
		return JSON.parse(JSON.stringify(st.groups || {}));
	}

	/// Write one group's record back. Answers false while the identity is locked.
	async function putGroup(gid, rec) {
		var st = await read();
		if (!st || !rec) return false;
		// Whatever a panel hung on the copy stays on the panel's copy.
		delete rec.iAmCreator;
		st.groups[String(gid)] = rec;
		await save();
		return true;
	}

	/// Take the tray flag off every message of one group, because the invitation
	/// has been accepted. The same act `connect('accept')` performs for a person,
	/// and for the same reason: the messages were sealed to this device and are
	/// its own; the tray was holding them until the invitation was answered.
	async function untrayGroup(gid) {
		var st = await read();
		if (!st) return 0;
		var n = 0;
		Object.keys(st.msgs).forEach(function (a) {
			if (st.msgs[a].gid === String(gid) && st.msgs[a].tray) { st.msgs[a].tray = 0; n++; }
		});
		if (n) { await save(); render(); }
		return n;
	}

	// ── The unlock boundary ────────────────────────────────────
	//
	// `attachPanel` reads the store at `DOMContentLoaded`, which is BEFORE the
	// passphrase has been typed, so that read got nothing and nothing asked
	// again. The store then stayed unread for the whole session unless somebody
	// opened Social -> Messages by hand, and three things followed from it:
	// `snapshot()` answered null so the record was left off every sync parcel,
	// `adopt()` dropped an arriving one, and `unread()` answered 0 so the badge
	// whose only job is to say "open the panel" could not count until the panel
	// had been opened. identity.js announces the boundary; this listens.

	/// Read the store and redraw, for a caller that has just unlocked.
	async function wake() {
		try {
			await read();
			await refreshDir();
		} catch (e) { log('wake failed', e); }
		try { render(); } catch (e) { /* no panel yet */ }
		return !!_st;
	}

	try {
		window.addEventListener('daimond:unlock', function () { wake(); });
		window.addEventListener('daimond:lock', function () {
			forget();
			try { render(); } catch (e) { /* no panel */ }
		});
	} catch (e) { /* no window */ }

	// ── Surviving a passphrase change ──────────────────────────
	//
	// The store is sealed under the passphrase, so a change to it has to carry
	// the store across or the whole message history is orphaned -- silently, and
	// permanently, since there is no second copy of the read and tray flags.
	//
	// BOTH PHASES, and the `read` is the load-bearing one: after
	// `changePassphrase` swaps the key there is no old key left to open the blob
	// with, so the record must be in memory before it runs. `read()` is
	// idempotent, so this costs nothing on the ordinary path where the panel has
	// already read it.
	if (window.DaimondRekey) {
		DaimondRekey.register({
			name:   'post',
			/// Bring the record into memory under the OLD key.
			read:   async function () {
				var st = await read();
				return { held: st ? 1 : 0, failed: st ? [] : ['messages'] };
			},
			/// Write it back under the new one. `save()` returns early on a null
			/// record, so a store that would not open is never overwritten blank.
			reseal: async function () {
				if (!_st) return { failed: [], unread: ['messages'] };
				await save();
				return { failed: [], unread: [] };
			},
			/// A change that did not happen leaves the blob under the old key, so
			/// the in-memory copy is the thing to drop.
			forget: forget,
			sentence: function (kind) {
				return kind === 'unread'
					? tOr('changepass.post_not_unsealed',
						'Your private messages could not be read under your old passphrase, '
						+ 'so they have been left as they were.')
					: tOr('changepass.post_not_resealed',
						'Your private messages could not be re-encrypted under the new passphrase.');
			},
		});
	}

	// ── The parcel ─────────────────────────────────────────────

	/// What travels between this account's own devices.
	///
	/// SYNCHRONOUS, because sync.js collects a parcel synchronously, and `null`
	/// while the store is unread. sync.js hangs it on only when it is not null,
	/// the same rule the pairing look record is carried under.
	function snapshot() {
		if (!_st) return null;
		return JSON.parse(JSON.stringify(_st));
	}

	/// Merge another device's record into this one. True when this device moved.
	///
	/// EVERY RULE HERE IS MONOTONE, so the result is the same whichever device
	/// runs it and whichever order the parcels arrive in, and nothing stamps on
	/// the way in. A message is immutable -- its address is its content -- so only
	/// the flags merge: `read` and `del` only ever go true, `tray` only ever goes
	/// false, and the two sequences take the higher.
	function adopt(rec) {
		if (!rec || typeof rec !== 'object') return false;	// no section on the parcel
		if (rec.v !== REC_V) {
			// A record from a build this one cannot read. Not a merge failure --
			// there is nothing this version could correctly do with it -- but it is
			// not nothing either, so it is said.
			log('a message record at version', rec.v, 'was not merged; this build reads', REC_V);
			return false;
		}
		// LOUDLY. A record arrived and there is nowhere to put it, which loses the
		// other device's read and tray flags outright. Returning false here left
		// sync.js's `failed` list empty, so the merge counted as complete and the
		// next push went over the top of the parcel this device had just failed to
		// read -- the other device's work replaced by a version that never saw it.
		// A throw puts `post` in `failed`, which jams the sync and refuses that
		// push (www/js/sync.js:760, :996).
		if (!_st) {
			throw new Error('the message store is not read on this device, so an '
				+ 'arriving message record cannot be merged into it');
		}
		var moved = false;

		Object.keys(rec.msgs || {}).forEach(function (addr) {
			var r = rec.msgs[addr];
			if (!r || typeof r !== 'object') return;
			var mine = _st.msgs[addr];
			if (!mine) { _st.msgs[addr] = r; moved = true; return; }
			if (r.read && !mine.read)     { mine.read = 1; moved = true; }
			if (mine.tray && !r.tray)     { mine.tray = 0; moved = true; }
			if (r.hidden && !mine.hidden) { mine.hidden = 1; moved = true; }
			if (r.del && !mine.del)       { mine.del = r.del; moved = true; }
		});
		Object.keys(rec.notes || {}).forEach(function (k) {
			if (!_st.notes[k]) { _st.notes[k] = rec.notes[k]; moved = true; }
		});
		// GROUPS: TWO CLOCKS, EACH WITH EXACTLY ONE WRITER, which is what lets
		// this converge with no ordering machinery and no tie-break beyond an
		// address.
		//
		//  - the ROSTER half (`at`, `salt`, `name`, `members`, `creator`) is
		//    written only by the group's creator, so the higher `at` is simply
		//    the later roster. Equal stamps take the higher address, because a
		//    creator sending two rosters inside one millisecond must still leave
		//    every device holding the same one;
		//  - the LOCAL half (`state`, `stateAt`) is written only by this account,
		//    so the higher `stateAt` is this account's later decision.
		//
		// The two are never compared against each other. A rule that took, say,
		// the whole record on the higher `at` would let a creator's roster undo a
		// person's own decision to leave.
		Object.keys(rec.groups || {}).forEach(function (gid) {
			var r = rec.groups[gid];
			// A record whose roster is not a list is not a roster. Checked here
			// rather than where it is drawn: `adopt` is synchronous by contract and
			// a throw from it jams the whole sync, so a malformed section must be
			// refused at the merge and not three frames later inside a redraw.
			if (!r || typeof r !== 'object' || !r.gid || !Array.isArray(r.members)) return;
			var mine = _st.groups[gid];
			if (!mine) { _st.groups[gid] = r; moved = true; return; }
			if (ms(r.at) > ms(mine.at)
				|| (ms(r.at) === ms(mine.at)
					&& String(r.addr || '') > String(mine.addr || ''))) {
				mine.at      = ms(r.at);
				mine.addr    = String(r.addr || '');
				mine.salt    = r.salt;
				mine.name    = r.name;
				mine.creator = r.creator;
				mine.members = r.members;
				moved = true;
			}
			if (ms(r.stateAt) > ms(mine.stateAt)) {
				mine.state   = r.state;
				mine.stateAt = ms(r.stateAt);
				moved = true;
			}
		});
		if ((rec.through | 0) > _st.through) { _st.through = rec.through | 0; moved = true; }
		if ((rec.acked   | 0) > _st.acked)   { _st.acked   = rec.acked   | 0; moved = true; }
		// AND WRITTEN DOWN. Nothing else here saves a merge: a device that adopted
		// the other one's read marks and was then closed came back not having
		// adopted them, and would re-ack and re-draw what the other device had
		// already dealt with. Not awaited, because `adopt` is synchronous by
		// contract -- sync.js collects and merges a parcel synchronously -- and
		// `save()` serialises its own writes.
		if (moved) { save(); }
		return moved;
	}

	// ── People ─────────────────────────────────────────────────
	//
	// Sealing needs the recipient's ENCRYPTION key; the relay addresses by their
	// SIGNING key. trust.js holds both, in a log it REPLAYS AND RE-VERIFIES on
	// every read, and it is the only authority here. A second store of cards in
	// this file would be a second place a key could be wrong -- and the weaker of
	// the two, since nothing here re-checks a signature at rest.
	//
	// The projection is asynchronous and the panel draws synchronously, so it is
	// cached into `_dir` by `refreshDir` and read from there. The cache decides
	// nothing on its own: `compose` refreshes before it seals.

	/// key hex -> { pub, keyHex, enc, label, state }. Refreshed, never authored.
	var _dir = {};

	/// Read the People projection into the cache. Answers how many people there are.
	async function refreshDir() {
		var dir = {};
		try {
			if (window.DaimondTrust && DaimondTrust.people) {
				var all = await DaimondTrust.people();
				(all || []).forEach(function (p) {
					if (!p || !p.key || !p.enc) return;
					dir[String(p.key).toLowerCase()] = {
						keyHex: String(p.key).toLowerCase(),
						pub:    b64url(b64enc(unhex(p.key))),
						enc:    String(p.enc),
						label:  String(p.label || ''),
						state:  String(p.state || 'new'),
					};
				});
			}
		} catch (e) { log('people projection failed', e); }
		_dir = dir;
		return Object.keys(_dir).length;
	}

	/// The row held for a key, given either spelling of it.
	function dirFor(pub) {
		var p = String(pub || '');
		if (_dir[p.toLowerCase()]) return _dir[p.toLowerCase()];
		var k;
		for (k in _dir) {
			if (Object.prototype.hasOwnProperty.call(_dir, k) && _dir[k].pub === p) return _dir[k];
		}
		return null;
	}

	/// The sealing key held for somebody, as raw bytes, or null.
	function encFor(pub) {
		// This account's own key, which needs no card: a Sent copy and a note to
		// self are both sealed to it, and looking it up in a directory would be
		// asking somebody else about a key this device holds the other half of.
		try {
			if (window.DaimondIdentity && DaimondIdentity.publicKeyB64url() === String(pub)) {
				return DaimondIdentity.sealingKeyRaw();
			}
		} catch (e) { /* no identity */ }
		var it = dirFor(pub);
		return it ? unhex(it.enc) : null;
	}

	/// Everybody this device could seal to. A blocked key is not among them: the
	/// block is this account's own act and offering to write to them anyway would
	/// be the interface arguing with the user.
	function people() {
		return Object.keys(_dir).map(function (k) { return _dir[k]; })
			.filter(function (p) { return p.state !== 'blocked'; });
	}

	/// The groups this device has joined, read synchronously off the record.
	/// Empty while the identity is locked, which is the same answer `list()` gives.
	function joinedGroups() {
		if (!_st || !_st.groups) return [];
		return Object.keys(_st.groups).map(function (k) { return _st.groups[k]; })
			.filter(function (g) { return g && g.state === 'joined'; });
	}

	/// One group's record by id, or null.
	function groupRec(gid) {
		return (_st && _st.groups && _st.groups[String(gid)]) || null;
	}

	// ── The wire ───────────────────────────────────────────────

	/// This tab's wake channel, so the relay taps this device's OTHER tabs and
	/// not the one that is already parked.
	var WAKE_ID = 'p' + Math.random().toString(36).slice(2, 10);

	/// One relay request. Through `DaimondGateway.gwFetch`, which is THE ONE COPY
	/// of the session rule -- renew once, retry once -- so nothing here carries a
	/// second version of it.
	async function call(method, body, query) {
		var opts = {
			method:      method,
			credentials: 'same-origin',
			headers:     { 'x-daimond-api': String(DaimondGateway.clientApi()) },
		};
		if (body !== undefined) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		var r = await DaimondGateway.gwFetch(PATH + (query || ''), opts);
		var j = null;
		try { j = await r.json(); } catch (e) { j = null; }
		return { status: r.status, json: j };
	}

	// ── The doorbell ───────────────────────────────────────────
	//
	// One email, at most once a day, saying something is waiting. No sender, no
	// subject, no count. It is ON BY DEFAULT for a beta account (decision 11):
	// those people applied by email and were invited by email, and with push
	// declined it is the only thing a closed tab ever hears. A default that
	// sends is a default that MUST be reachable, and until this pair of calls had
	// a caller it was not: the gateway has answered `?view=doorbell` and
	// `?op=doorbell` all along and nothing in the app asked either.
	//
	// THE READ CARRIES THE REACH AS WELL AS THE STATE, and a screen must draw
	// both. "On" and "will ring" are different answers: an account with no
	// address on file has the first and not the second, and a switch that showed
	// only the first would be lying to the one person who could fix it
	// (gateway/src/handlers/post.rs:625, gateway/src/doorbell.rs:155).

	/// Whether the doorbell is on, and whether it could actually ring.
	///
	/// Answers `{ ok, on, set, reach, why, last_ts, ... }` or `{ ok:false, why }`.
	/// `set` is false while nobody has chosen, so a caller can draw a default AS a
	/// default rather than as somebody's decision.
	async function doorbell() {
		var r;
		try { r = await call('GET', undefined, '?view=doorbell'); }
		catch (e) { return { ok: false, why: 'offline' }; }
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, why: 'status_' + r.status };
		}
		return r.json;
	}

	/// Turn it on or off. Answers the same shape the read does, because the
	/// gateway answers the new state rather than an acknowledgement -- so a
	/// caller never has to guess what it now is, and a switch cannot draw a
	/// state the server did not confirm.
	///
	/// TURNING IT OFF TAKES ANY QUEUED RING WITH IT, at the gateway
	/// (`requeue_doorbell(.., 0)`), so a bell already armed does not ring once
	/// more on its way out. Nothing here needs to do anything about that; it is
	/// said because a caller drawing "off" is entitled to mean it.
	async function setDoorbell(on) {
		var r;
		try { r = await call('POST', { on: !!on }, '?op=doorbell'); }
		catch (e) { return { ok: false, why: 'offline' }; }
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, why: 'status_' + r.status };
		}
		return r.json;
	}

	/// Send one message. Answers `{ ok, addr }`, or `{ ok:false, why }`.
	///
	/// A FULL BOX IS DRAWN HONESTLY. 507 means the message did not arrive, and
	/// saying anything else here would be telling somebody their words were
	/// delivered when they were not.
	async function send(opts) {
		var o = opts || {};
		var st = await read();
		if (!st) return { ok: false, why: tOr('post.err_locked',
			'Unlock Daimond to send a message: it is signed with your own key.') };
		// THE ONE THING A PERSON MAY NOT WRITE. group.js marks a roster by the
		// first line of the body, and a person who typed that line would have
		// their words applied as a membership list instead of drawn. Refused here,
		// at the one door a person's own text comes through, so the marker never
		// has to be a security boundary: the authorisation is the id derivation,
		// and this only keeps honest prose out of the roster path.
		try {
			if (window.DaimondGroup && DaimondGroup.looksLikeOp
				&& DaimondGroup.looksLikeOp(o.body) && !o.group) {
				return { ok: false, why: tOr('post.err_reserved_line',
					'A message cannot begin with that line: Daimond uses it to carry a '
					+ 'group\'s membership list. Put something before it.') };
			}
		} catch (e) { /* no group module */ }
		if (o.group) return await sendGroup(st, o);
		var enc = o.toEnc || encFor(o.to);
		var made;
		try { made = await compose({ body: o.body, to: o.to, toEnc: enc, replyTo: o.replyTo, refs: o.refs }); }
		catch (e) { return { ok: false, why: String(e && e.message || e) }; }

		// THE SAME TABLE THE FAN-OUT READS, which is the whole of `whyRefused`'s
		// reason for existing: one recipient and forty recipients are the same POST
		// and must fail in the same words.
		var r;
		try { r = await call('POST', { to: String(o.to), addr: made.addr, envelope: made.envelope }); }
		catch (e) { return { ok: false, status: 0, why: whyRefused(0) }; }

		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, status: r.status | 0, why: whyRefused(r.status) };
		}

		// The sender's own copy. Kept only after the relay accepted it, so a Sent
		// list never shows something that did not leave.
		st.msgs[made.addr] = {
			addr: made.addr, dir: 'out', to: String(o.to), body: String(o.body),
			ts: made.ts, read: 1, tray: 0,
		};
		await save();
		render();
		return { ok: true, addr: made.addr };
	}

	// ── The raw put, for the persistent desktop peer ───────────
	//
	// PEER STEP 2 (dev/PEER_DESIGN.md §1.4). An errand and a report ride this same
	// `/api/post` door a message does, but they are NOT messages: they are sealed
	// by DaimondPeer -- raw JSON under the account's own seal -- and handed here as
	// a finished `{ to, addr, envelope }` body. `send` stays the message-shaped
	// door (compose -> seal -> post); this is the one raw put, and it composes
	// nothing and stores no Sent copy, because a peer envelope is not a message and
	// must never reach the message list. Status is read through the SAME
	// `whyRefused` table `send` uses, so a full box or a refused put fails in the
	// same words wherever it is posted from.

	/// Put an already-sealed `{ to, addr, envelope }` in the box. Answers
	/// `{ ok, status, addr, why }`. `to` is the account's OWN public address for a
	/// self-post, so the gateway wakes the account's OTHER devices (wake.rs
	/// `Sub.origin` does not wake the poster).
	async function post(body) {
		var b = body || {};
		if (!b.to || !b.addr || !b.envelope) {
			return { ok: false, status: 0, why: tOr('post.err_bad_put',
				'A post needs a recipient, an address and a sealed body.') };
		}
		var r;
		try { r = await call('POST', { to: String(b.to), addr: String(b.addr), envelope: String(b.envelope) }); }
		catch (e) { return { ok: false, status: 0, why: whyRefused(0) }; }
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, status: r.status | 0, why: whyRefused(r.status) };
		}
		return { ok: true, status: 200, addr: String(b.addr) };
	}

	/// Hand a roster to group.js, and say whether it moved anything.
	///
	/// Its own function rather than four lines inside `collect`, so that a
	/// verifier drives the same door a collect does. A test that opened an
	/// envelope and then reached into group.js by hand would be measuring less
	/// than the run it is standing in for: it would still pass on a build where
	/// `collect` had stopped calling this at all.
	async function absorbRoster(got) {
		try {
			if (!window.DaimondGroup || !DaimondGroup.consume) return false;
			return await DaimondGroup.consume(got);
		} catch (e) { log('a roster would not apply', e); return false; }
	}

	/// Seal one message to a group: ask group.js who, then compose once.
	///
	/// The half of `sendGroup` that involves no relay, split out because it is the
	/// half a group's cryptography actually lives in and it must be provable
	/// between three devices WITH NO SERVER IN THE PATH AT ALL -- which is how the
	/// two-party seal was proved and is the shape a group needs. A verifier that
	/// reimplemented these two calls would pass on a build where `sendGroup` had
	/// stopped making them.
	///
	/// Answers `{ ok, made, who }` or `{ ok:false, why, skipped }`.
	async function sealGroup(gid, opts) {
		var o = opts || {};
		if (!window.DaimondGroup) {
			return { ok: false, why: tOr('post.err_no_groups',
				'This build cannot send to a group.') };
		}
		var who = await DaimondGroup.sealTo(gid);
		if (!who.ok) return { ok: false, why: who.why, skipped: who.skipped || [] };
		var made;
		try {
			made = await compose({ body: o.body, replyTo: o.replyTo, refs: o.refs,
				group: { id: unhex(gid), enc: who.enc } });
		} catch (e) { return { ok: false, why: String(e && e.message || e) }; }
		return { ok: true, made: made, who: who };
	}

	/// One message to a group: sealed once, delivered once per member.
	///
	/// WHAT THIS DOES NOT PROMISE. The relay answers a blocked delivery exactly
	/// as it answers an accepted one, deliberately -- otherwise Block would be
	/// distinguishable from Ignore and the tray would be a presence oracle
	/// (gateway/src/handlers/post.rs, `deliver`). So `sent` is the number of
	/// members this device SENT to and never the number who received it, and the
	/// wording on screen has to say the first. A "delivered to 12" line would be a
	/// claim the transport was built not to be able to make.
	///
	/// A FULL BOX IS STILL DRAWN. 507 from one member is that member's box, not
	/// the message's failure, so it is counted into `refused` and named -- and the
	/// rest of the group still gets it. Refusing the whole send because one person
	/// has not collected their mail for a month would be one absent reader
	/// silencing a group.
	async function sendGroup(st, o) {
		if (!window.DaimondGroup) {
			return { ok: false, why: tOr('post.err_no_groups',
				'This build cannot send to a group.') };
		}
		var sealed = await sealGroup(o.group, o);
		if (!sealed.ok) return sealed;
		var made = sealed.made, who = sealed.who;

		var out = await fanout(made, who.to);
		if (!out.sent) {
			return { ok: false, why: tOr('post.err_group_none',
				'The message reached nobody in that group, so nothing was sent.'),
				skipped: who.skipped, refused: out.refused };
		}
		// The sender's own copy, kept only for the members the relay took it for.
		st.msgs[made.addr] = {
			addr: made.addr, dir: 'out', gid: o.group, body: String(o.body),
			ts: made.ts, read: 1, tray: 0, sent: out.sent,
		};
		await save();
		render();
		return { ok: true, addr: made.addr, sent: out.sent, refused: out.refused,
			skipped: who.skipped };
	}

	/// Deliver ONE already-sealed envelope to each of a list of signing keys.
	///
	/// A loop of ordinary deliveries, and no batched route on the gateway, for two
	/// reasons that both survive being argued with:
	///
	///  - a batch endpoint would hand the gateway a single request SAYING these N
	///    accounts are one group. The loop leaves it to infer that from N rows
	///    sharing an `addr`, which it can do today -- but the inference is what a
	///    blinded mailbox id (§12.7) removes, and a stored assertion is not;
	///  - it would buy nothing in correctness. The store has no transaction across
	///    two boxes (`Store::deliver_post` takes one lock per box), so a batch that
	///    failed halfway would leave exactly the partial delivery this does, with
	///    less said about which half.
	///
	/// Answers `{ sent, refused }`, where `refused` is `[{ to, why }]` and every
	/// entry is drawn rather than counted.
	async function fanout(made, tos) {
		var sent = 0, refused = [], i;
		for (i = 0; i < tos.length; i++) {
			var r;
			try {
				r = await call('POST', { to: String(tos[i]), addr: made.addr,
					envelope: made.envelope });
			} catch (e) {
				refused.push({ to: String(tos[i]), status: 0, why: whyRefused(0) });
				continue;
			}
			if (r.status === 200 && r.json && r.json.ok) { sent++; continue; }
			refused.push({ to: String(tos[i]), status: r.status | 0,
				why: whyRefused(r.status) });
		}
		return { sent: sent, refused: refused };
	}

	/// What a delivery status means, in words a person can act on.
	///
	/// ONE PLACE, because there were two and the second one had no words at all.
	/// The one-to-one send mapped 507, 404 and 413 onto four sentences inline, and
	/// `fanout` -- which is the same POST, once per member -- wrote `'status_507'`
	/// and `'offline'` instead: machine text no locale holds and nothing drew. So a
	/// group of ten where nine boxes were full reported "Sent to 1 people." and
	/// said nothing whatever about the nine. The words being in the one-to-one
	/// branch is WHY the fan-out invented codes, so they are moved out of it rather
	/// than copied.
	///
	/// `status` is 0 where the relay could not be reached at all.
	///
	/// TWO REGISTERS FOR THE SAME FACT, and which one a caller wants depends on
	/// where it is going to be read. `whole` is the sentence a one-to-one send
	/// shows on its own, and `clause` is what goes inside a list of members --
	/// "Left out: Bob (their mailbox is full)" -- pitched at `group.skip_blocked`
	/// rather than at `post.err_box_full`, whose full sentence is right for one
	/// recipient and far too long once ten are named on one line.
	function whyRefused(status, clause) {
		var s = status | 0;
		if (!s) {
			return clause
				? tOr('post.refused_offline', 'the relay could not be reached')
				: tOr('post.err_offline',
					'Daimond could not reach the relay, so the message has not been sent.');
		}
		if (s === 507) {
			return clause
				? tOr('post.refused_full', 'their mailbox is full')
				: tOr('post.err_box_full',
					'That mailbox is full, so the message did not arrive. '
					+ 'They have to collect what is already in it before another will fit.');
		}
		if (s === 404) {
			return clause
				? tOr('post.refused_no_account', 'no account holds their key')
				: tOr('post.err_no_account',
					'No account holds that key, so the message has not been sent.');
		}
		if (s === 413) {
			return clause
				? tOr('post.refused_too_big', 'too large for the relay to carry')
				: tOr('post.err_too_big',
					'That message is too large for the relay to carry.');
		}
		return clause
			? tOr('post.refused_other', 'the relay refused it')
			: tOr('post.err_refused',
				'The relay would not take that message, so it has not been sent.');
	}

	/// Take ONE row the relay handed over: open it, and put it where it belongs.
	///
	/// Its own function, and the only place a collected envelope becomes a record,
	/// so that a verifier proving what happens to a message drives the door
	/// `collect` drives. A test that opened an envelope and then wrote the record
	/// itself would still pass on a build where this had stopped being called --
	/// which is the shape of a check that measures less than the run it stands in
	/// for.
	///
	/// Answers the three counters `collect` keeps, so that the caller adds rather
	/// than branches.
	async function takeRow(st, row) {
		// THE SAFETY FIELD. A row the relay wrote carries no envelope and no
		// signature. It is recorded, and it can never reach the message list.
		if (String(row.kind) !== 'post') {
			st.notes['n' + row.seq] = {
				seq: row.seq | 0, kind: String(row.kind),
				addr: String(row.addr || ''), ts: row.ts | 0,
			};
			return ROSTER;			// a note, counted the same way
		}
		// A tombstone: the row survives so a gap is never silent, and the body is
		// gone. Drawn as an expiry, never as an empty message.
		if (row.expired) {
			st.notes['n' + row.seq] = {
				seq: row.seq | 0, kind: 'expired',
				addr: String(row.addr || ''), ts: row.ts | 0,
			};
			return ROSTER;
		}
		// Already held. A message is immutable -- its address is its content -- so
		// a second sighting of one is a re-collect and not news.
		if (st.msgs[String(row.addr)]) return NOTHING;
		// THE PERSISTENT DESKTOP PEER'S OWN ENVELOPES (dev/PEER_DESIGN.md §4.3). An
		// errand or a report rides this same box but is raw JSON, not a message
		// artefact -- `openEnvelope` below would reject it as "not a message". So it
		// is peeked for and routed FIRST: `DaimondPeer.peek` unseals and classifies,
		// `absorb` verifies the account signature and hands it to the runner. A row
		// that is not a peer envelope -- every ordinary message -- peeks to null and
		// falls straight through to the message read below, UNCHANGED. A build with
		// no peer module skips the block entirely.
		if (window.DaimondPeer && DaimondPeer.peek) {
			var peer = null;
			try { peer = await DaimondPeer.peek(row.envelope); } catch (e) { peer = null; }
			if (peer) {
				try { await DaimondPeer.absorb(peer, row); }
				catch (e) { log('a peer envelope would not apply', e); }
				return NOTHING;			// routed, and never a message on the list
			}
		}
		try {
			var got1 = await openEnvelope(row.envelope, row.addr);
			// A ROSTER IS NOT A MESSAGE, and this is the same safety
			// field the `kind` check above is: an artefact that says
			// who is in a group is machine text, so it is applied and
			// never stored where the list can draw it. A reader shown
			// JSON in a message bubble has been shown a failure as
			// content. `openEnvelope` has already checked that the id
			// recomputes from the artefact's OWN author and salt, so
			// nothing but the creator can reach this line.
			if (got1.gop) {
				return await absorbRoster(got1) ? ROSTER : NOTHING;
			}
			st.msgs[got1.address] = {
				addr: got1.address, dir: 'in',
				from: b64url(b64enc(unhex(got1.author))),
				fp:   String(got1.fingerprint || ''),
				body: String(got1.post.body || ''),
				replyTo: got1.post.replyTo ? String(got1.post.replyTo) : '',
				refs: got1.post.refs || [],
				ts:   ms(got1.time), seq: row.seq | 0,
				// THE GROUP, AND WHOSE FLAG DECIDES THE TRAY. The relay
				// sets `tray` per PAIR, so every message from every
				// member of a group somebody has just joined would
				// arrive as a stranger's request. The roster is the
				// consent -- joining a group IS accepting the people in
				// it -- so a message to a group this device has JOINED
				// goes straight to the list, and one to a group only
				// INVITED waits in the tray with the invitation. The
				// relay's flag is not being overruled about a person;
				// it never knew there was a group.
				gid:  got1.gid || '',
				tray: got1.gid ? (groupJoined(st, got1.gid) ? 0 : 1)
					: (row.tray ? 1 : 0),
				read: 0,
				// THE EVIDENCE, kept because the relay will not keep it. The
				// ack tells the relay it may let go, and after that this
				// device holds the only copy of the sealed form there is. A
				// build that stored only the decoded words could show a
				// message and never report it: report.js would have the
				// words and nothing to prove who signed them, and an
				// unverifiable report is an accusation rather than evidence.
				//
				// It roughly doubles what a message costs at rest and in the
				// parcel -- the body cap is 8 KiB, so an envelope and an
				// artefact in base64 come to roughly 30 KiB a message against
				// the gateway's 32 MiB parcel ceiling
				// (gateway/src/handlers/sync.rs:71). Said out loud rather
				// than trimmed: a report that cannot be filed because the
				// evidence was cut is the worst of both.
				art: b64enc(got1.art),
				env: String(row.envelope || ''),
				ck:  b64enc(got1.ck),
			};
			// It opened this time. The trace left by the attempt that did
			// not goes, or the panel says twice that one message arrived.
			delete st.msgs['bad:' + row.addr];
			return MESSAGE;
		} catch (e) {
			// KEPT, NOT DROPPED. A row that will not open is still a row the
			// ack would tell the relay to let go of, so it has to leave a
			// trace somebody can be shown rather than vanishing between two
			// sequence numbers.
			st.msgs['bad:' + row.addr] = {
				addr: String(row.addr), dir: 'in', bad: String(e && e.message || e),
				from: String(row.from_pub || ''), ts: row.ts | 0,
				seq: row.seq | 0, tray: row.tray ? 1 : 0, read: 0,
			};
			return UNREADABLE;
		}
	}

	/// What one row came to. Named, because three integers in a row are three
	/// chances to add the wrong one.
	var MESSAGE    = { got: 1, notes: 0, unreadable: 0 };
	var ROSTER     = { got: 0, notes: 1, unreadable: 0 };
	var UNREADABLE = { got: 0, notes: 0, unreadable: 1 };
	var NOTHING    = { got: 0, notes: 0, unreadable: 0 };

	/// Collect everything above what this device has folded, and fold it.
	///
	/// NOTHING IS ACKED HERE. The relay drops nothing on a read; it drops only on
	/// an ack, and the ack is `ackThrough` below, after a commit.
	async function collect() {
		var st = await read();
		if (!st) return { ok: false, why: 'locked' };
		var got = 0, notes = 0, unread = 0, more = false;

		for (var round = 0; round < 8; round++) {
			var r = await call('GET', undefined, '?since=' + st.through);
			if (r.status !== 200 || !r.json || !r.json.ok) {
				return { ok: false, why: 'status_' + r.status, got: got };
			}
			var rows = r.json.rows || [];
			for (var i = 0; i < rows.length; i++) {
				var row  = rows[i];
				var took = await takeRow(st, row);
				got    += took.got;
				notes  += took.notes;
				unread += took.unreadable;
				if ((row.seq | 0) > st.through) st.through = row.seq | 0;
			}
			parkAgain();			// a request that was served proves the session is back
			more = !!r.json.more;
			if (!more) break;
		}
		await save();
		render();
		return { ok: true, got: got, notes: notes, unreadable: unread, more: more };
	}

	// ── The ordering, which is the whole safety property ───────
	//
	// COLLECTED = one device has fetched the envelope, folded it into the
	// account's sync parcel, and THAT PARCEL PUSH HAS COMMITTED. The device then
	// acks. Nothing else counts, and the ack is sent in that order and no other.
	//
	// Both halves are checked here rather than assumed:
	//
	//  - the parcel that is about to be pushed is READ BACK and must actually
	//    carry the sequence about to be acked. Without this the ack would rest on
	//    the belief that sync.js hangs this module's record on the parcel, and a
	//    build where that line is missing would ack messages that travel nowhere.
	//  - the push must MOVE THE SERVER VERSION. A push that 409'd, 402'd, was
	//    refused for size or never reached the gateway leaves the version where it
	//    was, and none of those is a commit.
	//
	// `tries` is bumped before the parcel is read so the record is never
	// byte-identical to the one last pushed. sync.js returns early from a push
	// whose parcel has not changed, which would otherwise leave a fold that can
	// never be acked because the push that would prove it has nothing to send.

	/// Whether a parcel push is available to commit through.
	function syncReady() {
		return !!(window.DaimondSync && DaimondSync.entitled && DaimondSync.entitled()
			&& DaimondSync.parcel && DaimondSync.push && DaimondSync.version);
	}

	/// Tell the relay it may let go, once the parcel carrying it has committed.
	///
	/// Answers `{ acked, why }`. Every `why` is a refusal to ack, and every one of
	/// them costs a re-collect and nothing else: the relay still holds the
	/// envelope, and collecting it again is idempotent by address.
	async function ackThrough() {
		var st = await read();
		if (!st) return { acked: 0, why: 'locked' };
		if (st.through <= st.acked) return { acked: 0, why: 'nothing' };
		var want = st.through;

		if (!syncReady()) return await soloAck(want);

		st.tries = (st.tries | 0) + 1;
		await save();

		// What a push would send, read back. `DaimondSync.parcel()` is exactly what
		// leaves, not an approximation of it.
		var parcel = null;
		try { parcel = await DaimondSync.parcel(); }
		catch (e) { return { acked: 0, why: 'no_parcel' }; }
		if (!parcel || !parcel.post || (parcel.post.through | 0) < want) {
			// The record is not on the parcel. Said out loud, because the ordinary
			// cause is one missing line in sync.js and the symptom -- mail that is
			// collected and never released -- looks like a relay fault.
			log('the parcel does not carry the message record; not acking');
			return { acked: 0, why: 'not_in_parcel' };
		}

		var before = DaimondSync.version();
		try { await DaimondSync.push(); }
		catch (e) { return { acked: 0, why: 'push_failed' }; }
		if (DaimondSync.version() <= before) return { acked: 0, why: 'not_committed' };

		return await tellRelay(want);
	}

	/// The ack for an account with no parcel to commit to.
	///
	/// Collection degrades honestly to this one device's own ack, and that account
	/// then has one copy of its mail in one place -- which is true of everything
	/// else it owns. It is a degrade and is reported as one by `state()`, never a
	/// silent equivalent of the real thing.
	async function soloAck(want) {
		await save();				// the local record IS the commit here
		var r = await tellRelay(want);
		r.solo = true;
		return r;
	}

	/// The ack request itself, and the only place it is made.
	async function tellRelay(want) {
		var r;
		try { r = await call('POST', { through: want }, '?op=ack'); }
		catch (e) { return { acked: 0, why: 'offline' }; }
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { acked: 0, why: 'status_' + r.status };
		}
		var st = await read();
		if (st) { st.acked = want; await save(); }
		return { acked: want, dropped: (r.json.dropped | 0) };
	}

	/// Collect, fold and ack, in that order. The one routine anything else calls.
	async function round() {
		var c = await collect();
		if (!c.ok) return c;
		var a = await ackThrough();
		return { ok: true, got: c.got, notes: c.notes, unreadable: c.unreadable,
			acked: a.acked | 0, why: a.why || '' };
	}

	// ── The tray's buttons ─────────────────────────────────────

	/// Accept, block or unblock somebody.
	///
	/// IGNORE IS NOT HERE, and that is deliberate: it writes nothing and calls
	/// nothing. A sender who could tell an ignore from a silence has been handed a
	/// presence oracle. Ignoring is `hide` below, which is local and tells nobody.
	async function connect(peerPub, action) {
		if (action !== 'accept' && action !== 'block' && action !== 'unblock') {
			return { ok: false, why: 'unknown_action' };
		}
		var r;
		try { r = await call('POST', { peer: String(peerPub), action: action }, '?op=connect'); }
		catch (e) { return { ok: false, why: 'offline' }; }
		if (r.status !== 200 || !r.json || !r.json.ok) return { ok: false, why: 'status_' + r.status };
		if (action === 'accept') {
			var st = await read();
			if (st) {
				Object.keys(st.msgs).forEach(function (a) {
					if (st.msgs[a].from === String(peerPub)) st.msgs[a].tray = 0;
				});
				await save();
				render();
			}
		}
		return { ok: true };
	}

	/// Stop drawing a tray row. Writes nothing to the relay and tells nobody --
	/// which is the whole of what Ignore is.
	async function hide(addr) {
		var st = await read();
		if (!st || !st.msgs[addr]) return false;
		st.msgs[addr].tray = 0;
		st.msgs[addr].hidden = 1;
		await save();
		render();
		return true;
	}

	// ── Parking ────────────────────────────────────────────────
	//
	// A parked GET is answered the moment something lands, and every real park
	// answer carries `waited: true`. A reply WITHOUT it is a front door that
	// dropped the query string and served an ordinary pull -- so this stops
	// parking the first time it sees one, and does not start again on its own.
	// Without that check a stripped query turns the park into an unthrottled loop
	// against the server.

	var PARK_MS   = 45000;		// what the gateway will hold a request for
	/// However fast a park answered, the next one is not immediate. The same
	/// floor sync.js's own poll keeps, and for the same reason: a gateway that
	/// answers at once -- because it has news, or because it is behaving oddly --
	/// must not turn this into a spin. Without it a fast answer is a loop bounded
	/// only by the network.
	var PARK_FLOOR_MS = 1000;
	var _parking  = false;		// is a park in flight or scheduled?
	var _parkOff  = '';			// why parking stopped, or ''
	var _parkGen  = 0;			// torn down and restarted, so a stale park is ignored
	var _parks    = 0;			// parks made, for a verifier

	/// Start parking. Idempotent, and refuses where parking has been turned off.
	function parkStart() {
		if (_parking || _parkOff) return false;
		_parking = true;
		_parkGen++;
		parkOnce(_parkGen);
		return true;
	}

	/// Stop parking, with the reason. `''` for an ordinary stop.
	///
	/// `no_park` is the one reason that STICKS. It is a property of the front door
	/// -- the query string is being dropped -- so nothing this client does will
	/// change it, and asking again is the hammering the check exists to prevent. A
	/// lapsed session is not like that, and `parkAgain` below lifts it.
	function parkStop(why) {
		_parking = false;
		_parkGen++;
		if (why) _parkOff = why;
	}

	/// Lift a stop that a working request has disproved. Never lifts `no_park`.
	function parkAgain() {
		if (_parkOff && _parkOff !== 'no_park') _parkOff = '';
	}

	async function parkOnce(gen) {
		while (_parking && gen === _parkGen) {
			var st = await read();
			if (!st) { parkStop(''); return; }
			_parks++;
			var began = Date.now();
			var r;
			try {
				r = await call('GET', undefined, '?above=' + st.through
					+ '&ms=' + PARK_MS + '&w=' + encodeURIComponent(WAKE_ID));
			} catch (e) {
				// The network went. Not a reason to give up on the transport, so this
				// waits and tries again rather than turning parking off for good.
				await sleep(5000);
				continue;
			}
			if (gen !== _parkGen) return;
			if (r.status === 401 || r.status === 426) { parkStop('session'); return; }
			if (r.status !== 200 || !r.json) { await sleep(5000); continue; }
			// THE CHECK THIS WHOLE BLOCK EXISTS FOR.
			if (r.json.waited !== true) {
				parkStop('no_park');
				log('the park answered without `waited`: the query string is being dropped, '
					+ 'so this is an ordinary pull. Parking is off.');
				return;
			}
			if (r.json.changed) await round();
			var spent = Date.now() - began;
			if (spent < PARK_FLOOR_MS) await sleep(PARK_FLOOR_MS - spent);
		}
	}

	function sleep(ms) {
		return new Promise(function (r) { setTimeout(r, ms); });
	}

	// ── The panel ──────────────────────────────────────────────
	//
	// Everything is drawn inside the one region the Social panel gives this
	// module, so the panel's own layout reaches none of this. Built with
	// `createElement` and `textContent`, never `innerHTML`: a format whose whole
	// claim is that a message cannot carry code must not have its own reader
	// building markup by string concatenation.
	//
	// References are drawn by `DaimondRefs`, which improve.js owns. The nine
	// refusal wordings for a reference that will not resolve exist once, there,
	// and a second copy of them here would be a second copy to get wrong.

	function host() { return document.querySelector(HOST); }

	function elt(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = String(text);
		return e;
	}

	/// The messages this account holds, newest first, tray rows excluded.
	function list() {
		if (!_st) return [];
		return Object.keys(_st.msgs).map(function (k) { return _st.msgs[k]; })
			.filter(function (m) { return !m.tray && !m.del && !m.hidden; })
			.sort(function (a, b) { return (b.ts | 0) - (a.ts | 0); });
	}

	/// The rows waiting to be accepted, ignored or blocked.
	function tray() {
		if (!_st) return [];
		return Object.keys(_st.msgs).map(function (k) { return _st.msgs[k]; })
			.filter(function (m) { return m.tray && !m.del && !m.hidden; })
			.sort(function (a, b) { return (b.ts | 0) - (a.ts | 0); });
	}

	/// The relay's own rows. Never a message from a person.
	///
	/// FOLDED BY ADDRESS, which matters only for a group and costs nothing for
	/// anything else. One group message is one envelope delivered once per
	/// member, so a group of twelve that nobody collects expires twelve times and
	/// the relay writes the sender twelve notices -- one per box, all naming the
	/// same address (gateway/src/schema.rs, `Store::expire_post`). Twelve
	/// identical rows saying a message was never collected reads as twelve
	/// messages having been lost. One row, with the count on it, is what
	/// happened.
	///
	/// A one-to-one message has exactly one copy, so this folds nothing and the
	/// count is never drawn.
	function notices() {
		if (!_st) return [];
		var byAddr = {}, out = [];
		Object.keys(_st.notes).forEach(function (k) {
			var n = _st.notes[k];
			if (!n) return;
			var key = n.kind === 'expired' && n.addr ? 'a:' + n.addr : 'k:' + k;
			var held = byAddr[key];
			if (!held) {
				byAddr[key] = { seq: n.seq | 0, kind: n.kind, addr: n.addr,
					ts: n.ts | 0, copies: 1 };
				out.push(byAddr[key]);
				return;
			}
			held.copies++;
			// The newest sighting names the fold, so a returning device sorts it
			// where the last copy arrived rather than where the first did.
			if ((n.seq | 0) > held.seq) { held.seq = n.seq | 0; held.ts = n.ts | 0; }
		});
		return out.sort(function (a, b) { return (b.seq | 0) - (a.seq | 0); });
	}

	/// How many messages have not been read, for the dock's count badge.
	function unread() {
		if (!_st) return 0;
		var n = 0;
		Object.keys(_st.msgs).forEach(function (k) {
			var m = _st.msgs[k];
			if (m.dir === 'in' && !m.read && !m.del && !m.hidden) n++;
		});
		return n;
	}

	/// Take the panel's own empty line down, because this view has drawn.
	///
	/// UNLIKE People's, this line says "Messages are not switched on in this
	/// build" -- it is about the BUILD and not about the list being empty. So it
	/// goes the moment this module draws anything at all, and the empty case is
	/// said by `post.none` below, in this view's own words. Passing the row count
	/// here would leave a person with an empty list being told the feature does
	/// not exist.
	function filled(drew) {
		try {
			if (window.DaimondSocial && DaimondSocial.filled) {
				DaimondSocial.filled(VIEW, drew ? 1 : 0);
			}
		} catch (e) { /* the panel is not up */ }
	}

	function render() {
		var h = host();
		if (!h) return;
		h.textContent = '';

		if (!_st) {
			h.appendChild(elt('p', 'post-empty', tOr('post.locked',
				'Unlock Daimond to read your messages: they are kept encrypted on this device.')));
			filled(true);		// locked is a state this view drew, not an absent feature
			return;
		}

		// The request tray, above the list, because it is the thing waiting on a
		// person and the list is not.
		var pending = tray();
		if (pending.length) {
			var tsec = elt('section', 'post-tray');
			tsec.id = 'post-tray';
			tsec.appendChild(elt('h3', null, tOr('post.tray_head', 'Waiting for your answer')));
			pending.forEach(function (m) { tsec.appendChild(drawTrayRow(m)); });
			h.appendChild(tsec);
		}

		var lsec = elt('section', 'post-list');
		lsec.id = 'post-list';
		var msgs = list();
		if (!msgs.length) {
			lsec.appendChild(elt('p', 'post-empty', tOr('post.none',
				'No messages yet.')));
		} else {
			msgs.forEach(function (m) { lsec.appendChild(drawRow(m)); });
		}
		h.appendChild(lsec);

		var nots = notices();
		if (nots.length) {
			var nsec = elt('section', 'post-notices');
			nsec.id = 'post-notices';
			nots.forEach(function (n) { nsec.appendChild(drawNotice(n)); });
			h.appendChild(nsec);
		}

		h.appendChild(drawWrite());

		// GROUPS, inside this module's own region and drawn by group.js.
		//
		// The Social panel's views belong to improve.js, so a third view would be
		// an edit to a file this lane does not own; this is one container and one
		// call. group.js clears and fills only what is inside it, which is the
		// same contract improve.js gives this file for `#social-messages-list`.
		// It is also why nothing here has to re-register an i18n surface: a
		// language change redraws this, and this redraws that.
		var gsec = elt('div', 'post-groups');
		gsec.id = 'post-groups';
		h.appendChild(gsec);
		try {
			if (window.DaimondGroup && DaimondGroup.mount) DaimondGroup.mount(gsec);
		} catch (e) { log('the group section did not draw', e); }

		filled(true);
	}

	/// One message. A handle and a fingerprint and no app chrome whatever: the
	/// official shape is granted only by a verified signature, and this file
	/// draws no official shape at all.
	function drawRow(m) {
		var row = elt('article', 'post-msg');
		row.dataset.addr = m.addr;
		if (m.dir === 'out') row.classList.add('post-out');
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name', m.dir === 'out'
			? tOr('post.you', 'You')
			: (nameFor(m.from) || tOr('post.someone', 'Someone new'))));
		if (m.fp) who.appendChild(elt('span', 'post-fp', m.fp));
		// Which group it went to, where it went to one. Beside the author and in
		// the quiet colour, because a message to a group is a message from a
		// person and the person is what the row is about.
		if (m.gid) {
			var g = groupRec(m.gid);
			who.appendChild(elt('span', 'post-fp',
				(g && g.name ? g.name : tOr('group.unnamed', 'A group'))
				+ ' · ' + String(m.gid).slice(0, 8)));
		}
		row.appendChild(who);
		if (m.dir === 'in') drawKeyLine(row, m.from);
		if (m.bad) {
			// It arrived and it will not open. Said, rather than left as a gap.
			row.appendChild(elt('p', 'post-bad', tOr('post.unreadable',
				'A message arrived that this device could not open.')));
			row.appendChild(elt('p', 'post-bad-why', m.bad));
		} else {
			row.appendChild(elt('p', 'post-body', m.body || ''));
		}
		drawRefs(row, m.refs);
		drawReport(row, m);
		return row;
	}

	/// The Report control, where there is something to report WITH.
	///
	/// ONE ATTRIBUTE, and that is the whole of the coupling: report.js listens
	/// for a delegated click on `[data-report-addr]` and touches nothing in this
	/// panel's DOM. It also answers `canReport`, and it is asked rather than
	/// guessed at -- a control that exists only to produce an error explains less
	/// than its absence does, and a message collected by an older build has no
	/// artefact to prove anything with.
	function drawReport(row, m) {
		try {
			if (!window.DaimondReport || !DaimondReport.canReport) return;
			if (!DaimondReport.canReport(m)) return;
			var b = elt('button', 'post-btn post-report', tOr('post.report', 'Report'));
			b.type = 'button';
			b.setAttribute('data-report-addr', String(m.addr));
			row.appendChild(b);
		} catch (e) { /* no reporting in this build */ }
	}

	/// Hang a message's references on a row, through the one module that owns
	/// them. Nothing is drawn where there are none, and never an empty container.
	function drawRefs(row, refs) {
		if (!refs || !refs.length) return 0;
		try {
			if (!window.DaimondRefs || !DaimondRefs.draw) return 0;
			var host = elt('div', 'post-refs');
			var n = DaimondRefs.draw(host, refs);
			if (n) row.appendChild(host);
			return n;
		} catch (e) { return 0; }
	}

	/// The line under a name that says what is known about the KEY.
	///
	/// trust.js draws it, because §12.8.5's two-axis wording lives there and a
	/// second rendering of a key state is the exact thing that rule forbids.
	/// Nothing is drawn where trust.js is absent: showing a key's standing from a
	/// module that does not replay the log would be a claim with nothing behind it.
	function drawKeyLine(row, pub) {
		var it = dirFor(pub);
		if (!it) return;
		try {
			if (window.DaimondTrust && DaimondTrust.drawKeyLine) {
				row.appendChild(DaimondTrust.drawKeyLine({ state: it.state }));
			}
		} catch (e) { /* trust module not up */ }
	}

	/// One tray row, with the three buttons. Ignore writes nothing.
	function drawTrayRow(m) {
		var row = elt('article', 'post-req');
		row.dataset.addr = m.addr;
		row.dataset.peer = m.from || '';
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name', nameFor(m.from) || tOr('post.someone', 'Someone new')));
		if (m.fp) who.appendChild(elt('span', 'post-fp', m.fp));
		row.appendChild(who);
		drawKeyLine(row, m.from);
		row.appendChild(elt('p', 'post-body', m.bad ? '' : (m.body || '')));
		var acts = elt('div', 'post-acts');
		[['post-accept', tOr('post.accept', 'Accept')],
		 ['post-ignore', tOr('post.ignore', 'Ignore')],
		 ['post-block',  tOr('post.block',  'Block')]].forEach(function (p) {
			var b = elt('button', 'post-btn', p[1]);
			b.type = 'button';
			b.dataset.act = p[0];
			acts.appendChild(b);
		});
		row.appendChild(acts);
		return row;
	}

	/// A row the relay wrote. No author, no reply control, and its own section --
	/// never in the message stream.
	function drawNotice(n) {
		var row = elt('article', 'post-notice');
		var expiry = n.kind === 'expired' || n.kind === 'expiry';
		row.appendChild(elt('p', null, !expiry
			? tOr('post.notice', 'The relay left a notice here.')
			: ((n.copies | 0) > 1
				// A group message, uncollected by several of the people it went to.
				// The number is the sender's own and says how many copies expired;
				// it is not a read receipt and cannot become one, because it is a
				// fact about the relay letting go and never about anybody opening
				// anything.
				? tOr('post.expired_group',
					'A message you sent to a group was never collected by {n} of the '
					+ 'people it went to, and the relay has let those copies go.',
					{ n: n.copies })
				: tOr('post.expired',
					'A message you sent was never collected and the relay has let it go.'))));
		return row;
	}

	/// The box, with its audience named above the button and again on it.
	///
	/// A control labelled plain "Send" in two places that do opposite things is
	/// the defect the wording exists to prevent, so the button says which channel
	/// it is and the line above it says who can read what is typed.
	function drawWrite() {
		var box = elt('form', 'post-write');
		box.id = 'post-write';

		// Who it goes to. Nobody to write to is not an error, it is a stage a new
		// account is in, and it says what to do next rather than disabling a
		// control with no explanation.
		var who = people();
		// The groups this device has JOINED. An invitation is not a destination:
		// offering to write to a group somebody has not answered yet would seal
		// their words to a roster they have not accepted.
		var mine = joinedGroups();
		if (!who.length && !mine.length) {
			box.appendChild(elt('p', 'post-nobody', tOr('post.nobody',
				'There is nobody to write to yet. Exchange codes with somebody in '
				+ 'People, and they will be here.')));
			return box;
		}
		var pick = elt('select', 'post-to');
		pick.id = 'post-to';
		pick.setAttribute('aria-label', tOr('post.to_label', 'Who this goes to'));
		who.forEach(function (p) {
			var o = elt('option', null, p.label || tOr('post.someone', 'Someone new'));
			o.value = p.pub;
			if (p.pub === _to) o.selected = true;
			pick.appendChild(o);
		});
		// A group's option value is prefixed, because a group id and a signing key
		// are both thirty-two bytes and a picker that could not tell them apart
		// would be a picker that seals to the wrong thing on a collision of
		// spelling rather than of key.
		mine.forEach(function (g) {
			var o = elt('option', null, (g.name || tOr('group.unnamed', 'A group'))
				+ ' · ' + String(g.gid).slice(0, 8)
				+ ' (' + tOr('post.group_count', '{n} people', { n: g.members.length }) + ')');
			o.value = 'g:' + g.gid;
			if (o.value === _to) o.selected = true;
			pick.appendChild(o);
		});
		box.appendChild(pick);

		// WHO CAN READ THIS, and for a group it is a different sentence with a
		// different set of people behind it. Drawn from what is picked, and
		// redrawn when the pick changes, because a line that said "only you and
		// the person you are writing to" over a group of twelve would be false.
		var aud = elt('p', 'post-audience');
		aud.id = 'post-audience';
		box.appendChild(aud);
		var sayAudience = function () {
			var v = pick.value || '';
			if (v.slice(0, 2) === 'g:') {
				var g = groupRec(v.slice(2));
				aud.textContent = tOr('post.audience_group',
					'Sealed once for each of the {n} people in this group. There is no '
					+ 'shared key: anybody who joins later cannot read this, and anybody '
					+ 'taken out afterwards keeps it.', { n: g ? g.members.length : 0 });
			} else {
				aud.textContent = tOr('post.audience',
					'Private. Only you and the person you are writing to can read this.');
			}
		};
		sayAudience();
		pick.addEventListener('change', sayAudience);
		var ta = elt('textarea', 'post-text');
		ta.id = 'post-text';
		ta.setAttribute('aria-label', tOr('post.box_label', 'Write a private message'));
		ta.placeholder = tOr('post.box_ph', 'What you want to say, and to whom.');
		ta.maxLength = BODY_MAX;
		box.appendChild(ta);
		var send = elt('button', 'post-btn post-send', tOr('post.send', 'Send privately'));
		send.type = 'submit';
		send.dataset.act = 'post-send';
		box.appendChild(send);
		var note = elt('p', 'post-note');
		note.id = 'post-note';
		box.appendChild(note);
		return box;
	}

	/// Who the box is addressed to, as a base64url signing key. Remembered across
	/// a redraw so a collect arriving mid-sentence does not change the recipient
	/// under the person typing.
	var _to = '';

	/// Point the box at somebody. What a People row's "Message" press would call.
	function to(pub) {
		_to = String(pub || '');
		var pick = document.getElementById('post-to');
		if (pick) pick.value = _to;
		return _to;
	}

	/// Who the box is addressed to right now: the picker if it is up, else what
	/// was last chosen.
	function toNow() {
		var pick = document.getElementById('post-to');
		return (pick && pick.value) || _to;
	}

	/// EVERYTHING A SEND DID NOT DO, in one sentence, on the screen it happened on.
	///
	/// THE WHOLE ANSWER GOES IN, not two fields picked out of it, and that is the
	/// shape rather than a convenience. This was `skipWords(r.skipped)`, so
	/// `r.refused` -- built by `fanout`, documented AT `fanout` as "every entry is
	/// drawn rather than counted" -- was dropped on the floor by every caller there
	/// was. A group of ten where nine deliveries were refused said "Sent to 1
	/// people." and the sender never learnt about the other nine; a roster that
	/// reached one of five said five people had been told. Taking the answer rather
	/// than a field means the next thing added to it is reported here or nowhere,
	/// and nowhere is the shorter search.
	///
	/// The principle is `skipped`'s own and is only being finished: a member left
	/// out of a message the sender believes went to the whole group can be put
	/// right in one place, and that place is the sender's own screen at the moment
	/// they press.
	///
	/// TWO SENTENCES AND NOT ONE, because the two lists are fixable by different
	/// people. A key this device would not seal to is a refusal HERE, and the
	/// person reading it is the person who can lift it -- match the new key, or
	/// unblock. A delivery the relay would not take is a refusal ELSEWHERE, and
	/// what they can do about it is wait, or hand the words over another way.
	/// Folding both into one list is true and leaves the reader to work out which
	/// of those two is theirs, which is the part of a message worth paying eight
	/// translations for.
	function shortfall(r) {
		var mine = [], theirs = [];
		((r && r.skipped) || []).forEach(function (s) {
			mine.push(String(s && s.label || '?') + ' (' + String(s && s.why || '') + ')');
		});
		((r && r.refused) || []).forEach(function (x) {
			var to  = String(x && x.to || '');
			var who = nameFor(to) || to.slice(0, 8);
			theirs.push(who + ' (' + whyRefused(x && x.status, true) + ')');
		});
		var said = '';
		if (mine.length) {
			said += ' ' + tOr('group.refused', 'Not sealed to: {who}.',
				{ who: mine.join(', ') });
		}
		if (theirs.length) {
			said += ' ' + tOr('post.group_refused',
				'The relay would not take it for: {who}.', { who: theirs.join(', ') });
		}
		return said;
	}

	/// Say something in the panel's own status line.
	function say(text) {
		var n = document.getElementById('post-note');
		if (n) n.textContent = String(text || '');
	}

	/// The advisory label held for a key. ADVISORY: equality is always the full
	/// key, and a label is a thing its holder chose. On a key nobody has matched
	/// it is drawn as the claim it is -- trust.js's own wording, through
	/// `drawKeyLine`, so there is one place that says what a key state means.
	function nameFor(pub) {
		if (!pub) return '';
		var it = dirFor(pub);
		return (it && it.label) || '';
	}

	// ── Wiring ─────────────────────────────────────────────────

	/// The panel was opened. Read the store, draw it, and go and look: there is no
	/// change feed on the relay's ordinary path and looking IS how somebody finds
	/// out.
	function onOpen() {
		return read().then(function () {
			return refreshDir();
		}).then(function () {
			render();
			parkStart();
			return round();
		}).then(render, function (e) { log('open failed', e); render(); });
	}

	document.addEventListener('click', function (e) {
		var h = e.target && e.target.closest ? e.target.closest(HOST) : null;
		if (!h) return;
		var b = e.target.closest('[data-act]');
		if (!b) return;
		var act = b.dataset.act;
		var row = b.closest('.post-req');
		if (act === 'post-send') {
			e.preventDefault();
			var ta = document.getElementById('post-text');
			var whom = toNow();
			if (!whom) { say(tOr('post.err_no_to', 'Choose who this is going to first.')); return; }
			_to = whom;
			say(tOr('post.sending', 'Sending…'));
			var isGroup = whom.slice(0, 2) === 'g:';
			var args = isGroup
				? { body: ta ? ta.value : '', group: whom.slice(2) }
				: { body: ta ? ta.value : '', to: whom };
			send(args).then(function (r) {
				if (!r.ok) { say(r.why + shortfall(r)); return; }
				if (ta) ta.value = '';
				// SENT TO, never DELIVERED TO. The relay answers a blocked
				// delivery exactly as it answers an accepted one, so the number
				// this device holds is the number it wrote to and nothing more.
				//
				// AND THE SHORTFALL BESIDE IT. "Sent to 1 people." is a true
				// sentence about a group of ten and a false impression of one, so
				// the nine the relay would not take are named next to it.
				say(isGroup
					? tOr('post.sent_group', 'Sent to {n} people.', { n: r.sent | 0 })
						+ shortfall(r)
					: tOr('post.sent', 'Sent.'));
			});
			return;
		}
		if (!row) return;
		var peer = row.dataset.peer;
		if (act === 'post-accept') { e.preventDefault(); connect(peer, 'accept'); return; }
		if (act === 'post-block')  { e.preventDefault(); connect(peer, 'block');  return; }
		if (act === 'post-ignore') { e.preventDefault(); hide(row.dataset.addr);  return; }
	});

	// Another tab wrote, or an account switch emptied the store.
	window.addEventListener('storage', function (e) {
		if (!e.key || e.key.indexOf(LS) === -1) return;
		_st = null;
		read().then(render, function () { render(); });
	});

	// Say the panel's own words again in a new language. Every string on a row is
	// built here rather than marked up, so a language change reaches none of them
	// unless this surface is registered.
	try {
		DaimondI18n.surface(function () { return document.querySelector(HOST); },
			function () { render(); });
	} catch (e) { /* no i18n in this build */ }

	/// Take the Messages view of the Social panel and keep in step with it.
	///
	/// Read LAZILY, on the open, because that is when somebody is looking: a
	/// collect is a request and a park holds one open for the best part of a
	/// minute, and neither has any business happening on a boot nobody asked it
	/// of. The same arrangement trust.js uses for People.
	function attachPanel() {
		if (!host()) return false;
		try {
			if (window.DaimondSocial && DaimondSocial.watch) {
				DaimondSocial.watch(function (view) { if (view === VIEW) onOpen(); });
			}
		} catch (e) { /* no panel to watch */ }
		// Drawn once at rest, so a person switching to Messages sees the store
		// rather than a blank while the first collect is in flight.
		read().then(function () { return refreshDir(); }).then(render, function () { render(); });
		return true;
	}

	function start() {
		if (!attachPanel()) {
			// The panel is built by another module; if this ran first, wait for the
			// document rather than deciding there is no panel.
			document.addEventListener('DOMContentLoaded', attachPanel);
		}
	}
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();

	// ── Public surface ─────────────────────────────────────────
	window.DaimondPost = {
		/// The panel.
		onOpen:  onOpen,
		render:  render,
		/// Whether this build can compose at all, and why not. A caller drawing a
		/// disabled control needs the sentence, not the boolean.
		ready:   cryptoReady,
		why:     cryptoWhy,
		/// The seal, and the two identities it runs between. No server is involved
		/// in either, which is also how they are tested.
		seal:    seal,
		unseal:  unseal,
		compose: compose,
		open:    openEnvelope,
		/// The five verbs.
		send:    send,
		/// The raw put: an already-sealed `{ to, addr, envelope }` in the box, for
		/// the peer's errand and report. Not a message; composes and stores nothing.
		post:    post,
		collect: collect,
		ack:     ackThrough,
		round:   round,
		connect: connect,
		/// The doorbell: whether one email a day may say something is waiting.
		/// The read carries the REACH as well as the switch -- see above.
		doorbell:    doorbell,
		setDoorbell: setDoorbell,
		/// Parking, and whether it is still on. `off` names the reason it stopped;
		/// `no_park` means the front door dropped the query string.
		parkStart: parkStart,
		parkStop:  function () { parkStop(''); },
		parking:   function () { return { on: _parking, off: _parkOff, parks: _parks }; },
		/// The parcel's two halves, for sync.js. `snapshot` answers null while the
		/// identity is locked, and the caller must leave the section OFF when it
		/// does -- an empty record reads to the other device as a deletion.
		snapshot: snapshot,
		adopt:    adopt,
		/// Read the store out from under the passphrase. Idempotent, and answers
		/// null while the identity is locked. Fired for you at `daimond:unlock`;
		/// published so a caller that needs the record NOW -- the badge, a
		/// verifier -- can ask rather than wait for somebody to open the panel.
		read:     read,
		wake:     wake,
		/// People, so a message can be sealed to somebody. trust.js's projection is
		/// the only authority; this reads it and holds nothing of its own.
		refreshPeople: refreshDir,
		people:   people,
		/// The groups half of the record, for group.js, which holds no storage of
		/// its own. `groups` answers a COPY and null while the identity is locked.
		groups:      groups,
		putGroup:    putGroup,
		untrayGroup: untrayGroup,
		joined:      joinedGroups,
		/// One already-sealed envelope, delivered once per member. Published so
		/// group.js sends a roster through the same door a message takes.
		fanout:      fanout,
		/// Everything a send did not do, in one sentence. Published because
		/// group.js draws the answer to a fan-out of its own -- a roster -- and a
		/// second wording for "these people have not got it" is a second wording
		/// to forget to draw. Takes the WHOLE answer, never a field of it.
		shortfall:   shortfall,
		/// What a delivery status means, in words. One table, read by the
		/// one-to-one send and by the fan-out.
		whyRefused:  whyRefused,
		/// The roster branch of `collect`, published so a verifier drives the
		/// door a collect drives rather than a second one of its own.
		absorbRoster: absorbRoster,
		/// ONE ROW, taken exactly as `collect` takes it: opened, applied if it is
		/// a roster, recorded if it is a message, and kept as a trace if it will
		/// not open. Published so that a suite carrying bytes between devices with
		/// no relay in the path drives the SAME function a real collect does.
		take:        async function (row) {
			var st = await read();
			if (!st) return { got: 0, notes: 0, unreadable: 0, why: 'locked' };
			var r = await takeRow(st, row);
			await save();
			render();
			return r;
		},
		/// The half of a group send that involves no relay. Published for the
		/// same reason `seal` and `unseal` are: it is where the cryptography is,
		/// and it must be provable between devices with no server in the path.
		sealGroup:   sealGroup,
		/// The format's own reader, so group.js reads back a roster it has just
		/// composed through the SAME code an arriving one takes. A second reader
		/// would be a second place for a roster to mean something different.
		bridgeRead:  function (bytes) {
			var b = bridge();
			if (!b || typeof b.read !== 'function') throw new Error(cryptoWhy());
			return b.read(bytes);
		},
		/// Point the box at somebody, and read who it is pointed at.
		to:       to,
		toNow:    toNow,
		/// What is held, for a panel and for a verifier.
		list:     list,
		tray:     tray,
		notices:  notices,
		unread:   unread,
		hide:     hide,
		/// Everything this module would say if asked.
		state:    function () {
			return {
				read:    !!_st,
				through: _st ? _st.through : 0,
				acked:   _st ? _st.acked : 0,
				solo:    !syncReady(),
				park:    { on: _parking, off: _parkOff, parks: _parks },
				unread:  unread(),
			};
		},
		/// Drop what is in memory, for an account switch, a lock, or a verifier
		/// that wants the store read again from disk.
		forget:   forget,
	};
})();
