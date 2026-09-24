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

	/// The largest sealed envelope `/api/post` carries, in bytes. The number now lives
	/// in ONE place for the whole client -- `DaimondWire` (js/wire.js), whose fallback
	/// IS the deployed 64 KiB pin and whose served value the gateway teaches later.
	/// These two keep their names because peer.js's errand dispatch and share.js call
	/// them; they delegate to the seam so #3/#5/#6 migrate their call sites to
	/// `DaimondWire.fits` later without a flag day. The 64 KiB below is the pre-seam
	/// fallback for the impossible case where wire.js did not load; NOT 3 MiB, which is
	/// the knob's default and not what jarrah has ever run.
	function relayMaxBytes() { return window.DaimondWire ? DaimondWire.limit('post') : 64 * 1024; }

	/// Would a sealed envelope whose BASE64 form is `envB64Len` characters long fit the
	/// relay? The gateway turns a body away on the cheap pre-decode estimate --
	/// `envelope.len() / 4 * 3 > max_bytes` -- before it decodes anything, so the seam
	/// applies that exact integer arithmetic. `max` overrides the cap (share.js passes
	/// its own 3 MiB share ceiling until #5 routes it through `fits('share', n)`).
	function fitsRelay(envB64Len, max) {
		if ((max | 0) > 0) return Math.floor(Number(envB64Len || 0) / 4) * 3 <= (max | 0);
		return window.DaimondWire ? DaimondWire.fits('post', envB64Len)
			: Math.floor(Number(envB64Len || 0) / 4) * 3 <= 64 * 1024;
	}

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
	// 4 since `shares` joined it. A diamond somebody sent through the relay waits
	// in the same tray a stranger's first message does, and the sealed envelope is
	// kept beside it -- the ack tells the relay to let go, and after that this
	// record is the only copy of the gift there is.
	// 5 since `feed` joined it. The followers-only feed keeps NO POST BODY on the
	// device -- a deletion propagates because nothing is cached past the session --
	// so what is here is three small maps: how far the cadence read has got, the
	// highest post id DRAWN per author, and the ids that arrived and have not been.
	// The badge is counted off the last of them, so it survives a reload the way
	// an unread message does.
	var REC_V = 5;

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

	/// The most of a parent message a reply quotes. One line at the dock's width,
	/// which is the point: a quote that wrapped would compete with the message it
	/// heads instead of placing it.
	var QUOTE_MAX = 80;

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
			// THE READING GOES OUT WITH THE REFUSAL. Refusing is still the right
			// answer -- nothing but a message may reach the message list -- but a
			// share arriving through the relay is a diamond somebody gave away, and
			// the envelope this device is holding is the only copy of it there will
			// be once the ack has run. `takeRow` routes on `kind` and draws the row
			// from `reading`, so three megabytes are unsealed once rather than
			// twice, and the alternative -- a bare refusal -- is how the bytes came
			// to be dropped while the sender was told "Sent".
			var notPost = new Error(tOr('post.err_not_a_post',
				'That is not a message; it is a {kind}.', { kind: String(got.kind || '?') }));
			notPost.kind    = String(got.kind || '?');
			notPost.reading = got;
			throw notPost;
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
		return { v: REC_V, through: 0, seen: 0, acked: 0, tries: 0, holds: [], msgs: {}, notes: {}, groups: {},
			shares: {}, feed: blankFeed() };
	}

	/// The feed's corner of the record. `since` is the CADENCE watermark the merged
	/// read carries and is advanced only on a page that says `more:false`; `read` is
	/// the highest post id per author that has actually been drawn on a screen; `new`
	/// holds the ids that arrived above that mark, which is what the badge counts.
	function blankFeed() {
		return { since: 0, read: {}, new: {} };
	}

	/// Bring a record written by an older build up to `REC_V`, or answer null where
	/// this build cannot.
	///
	/// A BUMP USED TO EMPTY THE STORE, and that is what this exists to stop. `read`
	/// answered `blank()` for any version it did not know, so raising `REC_V` to
	/// make room for a new section deleted every message on the device -- and
	/// `adopt` refuses a record at another version too, so no other device would
	/// have put them back. The comment on `REC_V` argues the trade is right
	/// "while nothing is deployed"; something is deployed now.
	///
	/// Each step is additive and names what it adds, so a record two versions old
	/// walks up rather than being refused by a rule about the gap.
	function upgrade(r) {
		if (r.v === 3) { r.shares = {}; r.v = 4; }
		if (r.v === 4) { r.feed = blankFeed(); r.v = 5; }
		return r.v === REC_V ? r : null;
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
		if (r && typeof r === 'object' && r.v !== REC_V) r = upgrade(r);
		if (!r || r.v !== REC_V) { _st = blank(); return _st; }
		r.msgs   = r.msgs   || {};
		r.notes  = r.notes  || {};
		r.groups = r.groups || {};
		r.shares = r.shares || {};
		r.feed   = r.feed   || blankFeed();
		r.feed.read = r.feed.read || {};
		r.feed.new  = r.feed.new  || {};
		r.feed.since = r.feed.since | 0;
		r.through = r.through | 0;
		// The highest box seq this device has FOLDED, held rows included. The ack
		// watermark `through` is pinned below a HELD errand (takeRow), so a park keyed on
		// `through` re-answers instantly for ever against the box's own higher high-water --
		// the held-row spin. `seen` is what a park is keyed on instead; it climbs past a
		// held row so the park waits for something GENUINELY new. Never below `through`.
		r.seen    = Math.max(r.seen | 0, r.through);
		r.acked   = r.acked | 0;
		r.tries   = r.tries | 0;
		// The seqs of this device's OWN un-run errands still on the relay, each with its
		// turnId. LOCAL like `seen` (stripped from every parcel snapshot below): it is a
		// per-device view of the shared box, and `adopt` has no rule for it. Rebuilt every
		// collect pass and freed by `settle`; defaulted here for a record written before it.
		r.holds   = Array.isArray(r.holds) ? r.holds : [];
		_st = r;
		return _st;
	}

	/// Write the store back, wrapped. Serialised, so an interleaved pair of
	/// writes cannot leave the older one on disk. Answers whether the write COMPLETED:
	/// `true` when `setItem` returned, `false` on a throw (a quota over-run is the one
	/// that bites). `ackThrough` reads this before it acks -- a swallowed failure would
	/// let the relay drop the only copy of a message this device never actually stored.
	/// The other `await save()` call sites ignore the value, so this is additive.
	async function save() {
		if (!_st) return false;
		// Captured HERE, not inside the queued `.then` below. This call can sit behind
		// an earlier write on `_writing` for a tick or more, and the `storage` handler
		// (below) nulls `_st` the moment ANOTHER tab writes -- so reading `_st` inside
		// the `.then` can find it already null and stringify that, wrapping the four
		// bytes "null". `read()` then unwraps "null" into a record that fails the
		// version check and answers `blank()`, discarding the store. The snapshot at
		// the door is what this device actually had when `save()` was called.
		var snapshot = JSON.stringify(_st);
		var mine = _writing = (_writing || Promise.resolve()).then(async function () {
			try {
				localStorage.setItem(LS, await DaimondIdentity.wrap(snapshot));
				return true;
			} catch (e) { log('store write failed', e); return false; }
		});
		var okSaved = await mine;
		if (_writing === mine) _writing = null;
		return okSaved;
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

	// ── The feed half of the record ────────────────────────────
	//
	// js/feed.js HOLDS NO STORAGE OF ITS OWN and reaches its three maps through
	// these, for the reason group.js does: the record is already wrapped at rest
	// under the identity key, already re-sealed on a passphrase change and already
	// carried on the sync parcel, and a second store would have to repeat all three
	// while being exercised a tenth as often.
	//
	// NO POST BODY IS EVER KEPT HERE, only ids. A follower's device caching the
	// words would be a device where an author's deletion never arrived, and the
	// whole claim of the feed is that a delete deletes.

	/// The feed's three maps, as a copy, or null while the identity is locked.
	function feedState() {
		if (!_st) return null;
		return JSON.parse(JSON.stringify(_st.feed || blankFeed()));
	}

	/// Move the cadence watermark. Only a page that said `more:false` may do it:
	/// advancing on a partial page skips every row the next page would have held.
	async function feedSince(ts) {
		var st = await read();
		if (!st) return 0;
		if ((ts | 0) > (st.feed.since | 0)) { st.feed.since = ts | 0; await save(); }
		return st.feed.since | 0;
	}

	/// Note the ids one author's rows arrived with, and answer how many of them are
	/// new. `whole` is for a read that fetched the author's rows ENTIRE -- it
	/// replaces the list rather than adding to it, which is how a post deleted by
	/// its author stops being counted as unread here.
	async function feedSaw(author, ids, whole) {
		var st = await read();
		if (!st) return 0;
		var a    = String(author || '');
		var mark = st.feed.read[a] | 0;
		var want = (ids || []).map(function (i) { return i | 0; })
			.filter(function (i) { return i > mark; });
		var had  = whole ? [] : (st.feed.new[a] || []);
		var seen = {}, out = [];
		had.concat(want).forEach(function (i) {
			if (i > mark && !seen[i]) { seen[i] = 1; out.push(i | 0); }
		});
		var fresh = out.length - had.filter(function (i) { return i > mark; }).length;
		if (out.length) st.feed.new[a] = out.sort(function (x, y) { return x - y; });
		else delete st.feed.new[a];
		await save();
		return fresh > 0 ? fresh : 0;
	}

	/// One author's posts are DRAWN up to `id`: raise the mark and drop what it
	/// covers. The measuring of "drawn" belongs to feed.js, on the rule
	/// `markDrawnRead` keeps below -- this only records what it decided.
	async function feedDrawn(author, id) {
		var st = await read();
		if (!st) return 0;
		var a = String(author || '');
		if ((id | 0) <= (st.feed.read[a] | 0)) return 0;
		st.feed.read[a] = id | 0;
		var left = (st.feed.new[a] || []).filter(function (i) { return (i | 0) > (id | 0); });
		if (left.length) st.feed.new[a] = left; else delete st.feed.new[a];
		await save();
		countChanged();
		return 1;
	}

	/// How many feed posts have arrived and not been drawn. The Social badge adds
	/// this to `unread()` above; see `postBadge` in js/daimond.js, and the comment
	/// there insisting there is ONE badge.
	function feedUnread() {
		if (!_st || !_st.feed) return 0;
		var n = 0;
		Object.keys(_st.feed.new).forEach(function (a) {
			var mark = _st.feed.read[a] | 0;
			(_st.feed.new[a] || []).forEach(function (i) { if ((i | 0) > mark) n++; });
		});
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
		// The store has only just become readable, so this is the first moment the
		// tally is a number at all. Until the badge was told here it could not
		// light before somebody opened the panel -- and opening the panel is the
		// thing it exists to ask for.
		countChanged();
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
		var rec = JSON.parse(JSON.stringify(_st));
		// `seen` is a PURELY LOCAL park cursor (post-park spin fix): it climbs past a
		// HELD row that `through` cannot pass, and it is per-device, so it must never ride
		// the parcel -- syncing it would push the parcel every time a held row is folded,
		// a new amplifier, and `adopt` has no rule for it. It persists locally through
		// `save` (which serialises `_st` directly), not through here.
		delete rec.seen;
		delete rec.holds;		// per-device view of the shared box, never on the parcel -- see `seen`.
		return rec;
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
		// SHARES MERGE LIKE MESSAGES, and for the same reason: a share is immutable
		// -- its address is its content -- so only the flags move, and each of them
		// only ever goes true. `taken` matters most: a gift added on the desktop
		// must stop waiting in the tray on the phone, or a person lands two copies
		// of one diamond and neither device is wrong about it.
		Object.keys(rec.shares || {}).forEach(function (addr) {
			var r = rec.shares[addr];
			if (!r || typeof r !== 'object' || !r.addr) return;
			var mine = _st.shares[addr];
			if (!mine) { _st.shares[addr] = r; moved = true; return; }
			if (r.taken && !mine.taken)   { mine.taken = 1; moved = true; }
			if (r.hidden && !mine.hidden) { mine.hidden = 1; moved = true; }
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
				// The roster's own signed bytes travel with the four fields
				// they were read out of -- see group.js on `art`. A parcel from
				// an older build carries none, and blanking what this device
				// holds would leave a group whose messages it can no longer
				// report.
				if (r.art) mine.art = String(r.art);
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

	// ── Offloading the tail of the message record ──────────────
	//
	// A RETAINED INCOMING MESSAGE IS ~30 KiB, and nothing bounded the SUM of them.
	// The body cap is 8 KiB, but a received row also keeps the sealed EVIDENCE the
	// relay will not -- the artefact, the envelope and the content key (`art`/`env`/
	// `ck`, see the note where a row is stored) -- which roughly doubles it. The whole
	// record rides the sync parcel as one section (sync.js `state.post`), and on a
	// heavy social account those numerous small rows are the section that 413s the
	// parcel once the chats have been budgeted (the parcel ceiling and its reasoning
	// live in daimond.js `SYNC_PARCEL_MAX`).
	//
	// So the messages get the treatment the chat transcripts got: a byte budget, the
	// freshest kept inline, the tail's HEAVY HALF (`body`/`art`/`env`/`ck`/`refs`)
	// offloaded to a content chunk and left as a `msgRef`, hydrated on the other
	// device on demand. The mutable flags (`read`/`tray`/`hidden`/`del`) and the
	// identity (`addr`/`ts`) stay inline, which is what lets `adopt`'s flags-merge run
	// against a tail row with no chunk to fetch: a message is immutable -- its address
	// is its content -- so a copy the other device already holds needs nothing
	// materialised, and only a message it has never seen is fetched (adoptRefs).
	//
	// The offload is deterministic and content-addressed (the manifest is reused via
	// its stored fingerprint, exactly as the chat collector reuses one) so two
	// collects of one state are byte-identical and the push-skip still holds.
	var SYNC_POST_INLINE_MAX = 2 * 1024 * 1024;

	/// A cheap content fingerprint, deliberately identical to daimond.js `fileHash`
	/// and cloud.js `hash` -- enough to tell whether a message's heavy half changed,
	/// which for an immutable message is never. Local so the offload does not depend
	/// on cloud.js having loaded first.
	function fp(s) {
		var h = 5381;
		for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
		return (h >>> 0).toString(36) + ':' + s.length;
	}

	/// The heavy, immutable half of a message row: the body, the sealed evidence and
	/// any refs. Everything NOT here -- the address, the flags, the timestamps -- stays
	/// inline, so an already-held message converges on flags alone with nothing to
	/// hydrate.
	function heavyPart(m) {
		return { body: m.body, art: m.art, env: m.env, ck: m.ck, refs: m.refs, replyTo: m.replyTo };
	}

	/// The parcel section with the message tail offloaded. The async twin of
	/// `snapshot()`: same `null` while locked, same deep copy, but the rows past the
	/// inline budget carry a `msgRef` in place of their heavy half. Returns the plain
	/// snapshot unchanged when nothing can be offloaded -- no chunk store, or an
	/// account light enough that the budget never binds -- so an ordinary account's
	/// parcel is byte-for-byte what it was.
	async function snapshotRefs() {
		if (!_st) return null;
		var rec = JSON.parse(JSON.stringify(_st));
		delete rec.seen;		// a local park cursor, never on the parcel -- see `snapshot`.
		delete rec.holds;		// a local view of the box's held rows, never on the parcel.
		// ...and whether this device may DECLARE what it uploads. The gateway sweeps
		// every held chunk the committed index does not name, and only a device that
		// merged that index may commit it, so a message tail offloaded from a device
		// that cannot commit is deleted a day later with the parcel still pointing at
		// it. Same seam the Diamond and chat collectors use (`offloadAllowed`).
		var canOffload = !!(window.DaimondChunks && DaimondChunks.offloadBytes
			&& window.DaimondCloud && DaimondCloud.available && DaimondCloud.available()
			&& DaimondCloud.contentGet && DaimondCloud.contentSet);
		if (!canOffload) return rec;
		var msgs = rec.msgs || {};
		var addrs = Object.keys(msgs);
		// Serialise each heavy half once, then rank freshest-first with an address
		// tie-break, so two collects of one state choose the same inline set and the
		// parcel stays a fixed point.
		var recs = [];
		for (var i = 0; i < addrs.length; i++) {
			var m0 = msgs[addrs[i]];
			var serial = JSON.stringify(heavyPart(m0));
			recs.push({ addr: addrs[i], m: m0, serial: serial, len: serial.length });
		}
		var order = recs.slice().sort(function (x, y) {
			var tx = ms(x.m && x.m.ts), ty = ms(y.m && y.m.ts);
			if (ty !== tx) return ty - tx;					// freshest first
			return x.addr < y.addr ? -1 : 1;				// deterministic tie-break
		});
		var inline = {}, spent = 0;
		for (var r = 0; r < order.length; r++) {
			var o = order[r];
			if (spent + o.len <= SYNC_POST_INLINE_MAX) { inline[o.addr] = 1; spent += o.len; }
		}
		var live = {};
		for (var j = 0; j < recs.length; j++) {
			var addr = recs[j].addr, mm = recs[j].m;
			live[addr] = 1;
			var ckey = '@m/' + addr;
			var stored = DaimondCloud.contentGet(ckey);
			// Rides inline: drop any manifest it once had, so its chunks are swept.
			if (inline[addr]) {
				if (stored && DaimondCloud.contentForget) DaimondCloud.contentForget(ckey);
				continue;
			}
			var fpv = fp(recs[j].serial);
			var ref;
			if (stored && stored.fp === fpv && Array.isArray(stored.chunks)) {
				ref = { v: stored.v, size: stored.size, key: stored.key, chunks: stored.chunks };
			} else {
				var mani;
				try { mani = await DaimondChunks.offloadBytes('m:' + addr, new TextEncoder().encode(recs[j].serial)); }
				catch (e) { continue; }						// offload failed: ride inline this round
				// Recorded, or the heavy half rides inline. A `contentSet` lost to quota
				// leaves the parcel naming a `msgRef` whose chunks the next commit -- built
				// from the index that never took them -- does not declare, so the gateway
				// sweeps them and the far device gets a body-less message, re-swept every
				// round. So on a failed index write the row rides inline this round (its
				// heavy half is left in place, not stripped below) and the collector retries
				// next round; `indexDurable` also blocks the commit until the write lands.
				if (!DaimondCloud.contentSet(ckey, {
						v: mani.v, size: mani.size, key: mani.key, chunks: mani.chunks, fp: fpv })) {
					continue;
				}
				ref = { v: mani.v, size: mani.size, key: mani.key, chunks: mani.chunks };
			}
			// Strip the heavy half; keep the flags and identity; hang the reference.
			mm.body = null; mm.art = null; mm.env = null; mm.ck = null; mm.refs = null; mm.replyTo = null;
			mm.msgRef = ref;
		}
		// Drop manifests for messages that are gone, so their chunks stop being named
		// live. Writes only on a real deletion; a no-op collect leaves the index be.
		if (DaimondCloud.contentReap) DaimondCloud.contentReap('@m/', live);
		return rec;
	}

	/// Hydrate any offloaded rows, then merge. `adopt` is synchronous by contract (a
	/// throw from it jams the sync) and a chunk fetch is async, so the fetch happens
	/// HERE and `adopt` sees the whole record it always did. Only a message this
	/// device does not already hold is fetched -- a held copy is the same immutable
	/// bytes and merges on its inline flags alone. A row whose chunks cannot be
	/// materialised is dropped this round rather than stored blank; it self-heals when
	/// the reference resolves on a later parcel.
	async function adoptRefs(rec) {
		if (!rec || typeof rec !== 'object' || !rec.msgs) return adopt(rec);
		var addrs = Object.keys(rec.msgs);
		for (var i = 0; i < addrs.length; i++) {
			var addr = addrs[i], m = rec.msgs[addr];
			if (!m || !m.msgRef) continue;
			var ref = m.msgRef;
			// Already held: the flags merge needs no evidence, so drop the reference
			// and let `adopt` merge the inline flags against the copy we keep.
			if (_st && _st.msgs && _st.msgs[addr]) { m.msgRef = null; continue; }
			var bytes = (window.DaimondChunks && DaimondChunks.materialiseBytes)
				? await DaimondChunks.materialiseBytes(ref) : null;
			if (!bytes) { delete rec.msgs[addr]; continue; }
			var heavy;
			try { heavy = JSON.parse(new TextDecoder().decode(bytes)); }
			catch (e) { delete rec.msgs[addr]; continue; }
			m.body = heavy.body; m.art = heavy.art; m.env = heavy.env;
			m.ck = heavy.ck; m.refs = heavy.refs; m.replyTo = heavy.replyTo;
			m.msgRef = null;
		}
		return adopt(rec);
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

	/// This device's id, for the park's `device` parameter. Read from identity.js at
	/// call time rather than cached: a device that is not unlocked yet has none, and an
	/// empty id simply parks as an older client did -- the gateway then refuses nothing
	/// by id, which is the same behaviour the park had before the removal existed.
	function selfDeviceIdForPark() {
		try { return String((window.DaimondIdentity && DaimondIdentity.deviceId()) || ''); }
		catch (e) { return ''; }
	}

	/// One relay request. Through `DaimondGateway.gwFetch`, which is THE ONE COPY
	/// of the session rule -- renew once, retry once -- so nothing here carries a
	/// second version of it.
	///
	/// `timeoutMs`, where given, is a CLIENT-SIDE DEADLINE: the request is aborted
	/// when it passes and the error thrown carries `timedOut`. `fetch` has no
	/// timeout of its own, and a GET nothing ever answers hangs for as long as the
	/// operating system keeps the socket -- a phone once sat forty-one minutes on a
	/// dead `/api/post`, servicing nothing and beating presence the whole time. See
	/// `PARK_DEADLINE_MS`.
	async function call(method, body, query, timeoutMs) {
		var opts = {
			method:      method,
			credentials: 'same-origin',
			headers:     { 'x-daimond-api': String(DaimondGateway.clientApi()) },
		};
		if (body !== undefined) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		var ctl = null, timer = null, fired = false;
		if (timeoutMs > 0) {
			try { ctl = new AbortController(); } catch (e) { ctl = null; }
			if (ctl) {
				opts.signal = ctl.signal;
				timer = setTimeout(function () {
					fired = true;
					try { ctl.abort(); } catch (e) { /* already gone */ }
				}, timeoutMs);
			}
		}
		var r;
		try {
			r = await DaimondGateway.gwFetch(PATH + (query || ''), opts);
		} catch (e) {
			// The deadline, not the network: tell them apart, because one is a
			// black-holed request to retry with a backoff and the other is an
			// ordinary outage.
			if (fired) {
				var to = new Error('the request passed its deadline');
				to.timedOut = true;
				throw to;
			}
			throw e;
		} finally {
			if (timer) clearTimeout(timer);
		}
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
	/// The relay rows the FEED writes, and which of them waits for an answer.
	///
	/// All three carry their words in `envelope` and not in a body -- the collect
	/// has nothing sealed to put there -- and all three are the relay's own rows,
	/// so they are kept beside the notices and can never reach the message list.
	var FEED_KINDS = { follow: 1, followed: 1, feedgone: 1 };

	/// `work` collects the rows that ask this device to run something; the caller
	/// starts them once it has let go of the mailbox lock (`startWork`).
	async function takeRow(st, row, work) {
		if (FEED_KINDS[String(row.kind)]) {
			st.notes['n' + row.seq] = {
				seq:  row.seq | 0, kind: String(row.kind),
				addr: String(row.addr || ''), ts: row.ts | 0,
				// Who asked, or whose post was taken down. `from` is the relay's
				// `from_pub`; `text` is a handle for a follow and "<id> <reason>"
				// for a removal.
				from: String(row.from_pub || ''),
				text: String(row.envelope || ''),
				// A follow request WAITS ON A PERSON, so it is drawn in the tray
				// with three buttons; the other two are notices and ask nothing.
				ask:  String(row.kind) === 'follow' ? 1 : 0,
			};
			return ROSTER;
		}
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
		// a second sighting of one is a re-collect and not news. A share is
		// immutable in exactly the same way and is held in its own section.
		if (st.msgs[String(row.addr)]) return NOTHING;
		if (st.shares && st.shares[String(row.addr)]) return NOTHING;
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
				// OUR OWN dispatch: leave it on the relay for the peer to run and ack.
				// The sender collecting its own post must NOT advance the ack cursor past
				// it -- acking it here drops it from the shared relay before the peer
				// collects, which is the awake-sender hand-off failure. HOLD tells
				// collect() to keep the ack watermark just below this row.
				//
				// But VERIFY the account signature before honouring the HOLD. `peer` is
				// the UNVERIFIED peek object, and `dispatchedBy` rides inside it; a
				// forgery sealed to this account's public sealing key could set it to
				// our own device id purely to force a HOLD and stall the ack cursor
				// (an availability nuisance -- it is never run, the signature stops
				// that). Only a row that verifies as ours may hold; an unverified
				// "own dispatch" falls through to absorb, which drops it and lets the
				// cursor advance.
				if (DaimondPeer.isOwnDispatch && DaimondPeer.isOwnDispatch(peer)) {
					var ours = false;
					try { ours = await DaimondPeer.verifyEnvelope(peer); } catch (e) { ours = false; }
					if (ours) {
						// HOLD ONLY WHILE THE TURN IS LIVE. An own errand left on the relay is
						// what a peer runs -- but once THIS device has settled the turn (it ran
						// locally, or a peer's answer merged) or the turn can no longer be
						// started by anyone (past `deadline + LEASE_TTL_MS`, where
						// leaseTakeFromCas refuses every claim), holding it only freezes the ack
						// cursor (S-HAND #2) AND leaves the errand for a peer waking inside the
						// 15-min window to re-run and re-bill (S-HAND #1 -- the MONEY defect).
						// `holdOwnDispatch` answers false in exactly those two cases; an older
						// peer.js without the hook leaves `keep` true, so the behaviour is
						// unchanged there and the held-errand tests stay green.
						var keep = true;
						try { if (DaimondPeer.holdOwnDispatch) keep = await DaimondPeer.holdOwnDispatch(peer); }
						catch (e) { keep = true; }
						if (keep) return hold(peer.turnId);
						// Settled or dead: fall through to absorb, which answers
						// 'self-dispatched' and routes nothing; takeRow then answers NOTHING and
						// the cursor passes the row, so the relay drops it and no peer re-runs it.
					}
				}
				// WORK STARTS AFTER THE MAILBOX LOCK, NEVER UNDER IT (E-R4, 2026-09-23). An
				// errand or a compile asks this device to RUN something: minutes of turn that
				// end by calling back into this module (daimond.js's ack dep calls `settle`
				// and `ack`), whose locked exports ask for the lock `round` holds across this
				// collect. A Web Lock is not re-entrant, so the turn waited on the lock and
				// the lock on the turn: the first hand-off answered, and the desktop never
				// parked or collected again until it was reloaded. So the row is only CLAIMED
				// here and HELD -- left on the relay, as an own dispatch is, until its run is
				// over -- and the run starts once the lock is let go (`startWork`). The claim
				// is a lock of its own per turn, so a second collect, in this tab or another,
				// holds the row rather than running the turn twice.
				if (DaimondPeer.isWork && DaimondPeer.isWork(peer)) {
					var claim = await claimWork(DaimondPeer.workKey(peer));
					if (!claim) return hold(peer.turnId);	// already being run on this device
					var signed = false;
					try { signed = await DaimondPeer.verifyEnvelope(peer); } catch (e) { signed = false; }
					if (!signed) {
						// The forged-errand defence `absorb` applies, applied before the hold,
						// so a forgery can never pin the ack cursor.
						claim.release();
						log('a peer envelope failed its signature check; dropped');
						return NOTHING;
					}
					work.push({ peer: peer, row: row, claim: claim });
					return hold(peer.turnId);
				}
				// A NOTE -- a report, a consent question or its answer, a compile's account --
				// is folded here, under the lock, as a message is: each handler records it in
				// page memory and returns. Nothing folded here may call a locked verb of this
				// module or wait on the network.
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
			// A SHARE, AND ITS BYTES. This is where a relayed gift was lost: the
			// row opened, `openEnvelope` said "that is not a message; it is a
			// share", and the only thing kept was `bad:<addr>` with no envelope in
			// it -- then the ack told the relay to let go and the diamond was gone,
			// with "Sent to Ada" still on the sender's screen.
			//
			// NEVER LANDED HERE. A share is a write of somebody else's files and a
			// page inside one is a program, so it waits in the tray exactly as a
			// stranger's first message does, and `addShare` is the only thing that
			// puts any of it on the machine.
			if (e && e.kind === 'share' && keepShare(st, row, e.reading)) return SHARE;
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

	/// Keep a share that arrived through the relay, with the sealed envelope and
	/// enough of the reading to draw a row without opening it again.
	///
	/// `reading` is `DaimondCrypto.read`'s own answer, which carries the name, the
	/// note, the signed `code` bit and one entry per file -- everything the tray
	/// row says. The BODIES are not in it, deliberately: they are in `env`, which
	/// is kept whole because the signature is over the whole of it and a share
	/// re-encoded here would be a share this device could no longer prove.
	///
	/// True when it was kept. False for anything that is not a share this build
	/// can draw, which falls through to the unreadable trace rather than being
	/// recorded as a gift nobody can open.
	function keepShare(st, row, reading) {
		var sh = reading && reading.share;
		if (!sh || !row.envelope) return false;
		var files = Array.isArray(sh.files) ? sh.files : [];
		var bytes = 0;
		for (var i = 0; i < files.length; i++) bytes += (files[i].bytes | 0);
		st.shares = st.shares || {};
		st.shares[String(row.addr)] = {
			addr: String(row.addr),
			from: String(row.from_pub || ''),
			fp:   String(reading.fingerprint || ''),
			name: String(sh.name || ''),
			note: String(sh.note || ''),
			code: !!sh.code,
			n:    files.length,
			bytes: bytes,
			ts:   ms(reading.time) || (row.ts | 0) * 1000,
			seq:  row.seq | 0,
			env:  String(row.envelope),
			taken: 0, hidden: 0,
		};
		return true;
	}

	/// What one row came to. Named, because three integers in a row are three
	/// chances to add the wrong one.
	var MESSAGE    = { got: 1, notes: 0, unreadable: 0 };
	var ROSTER     = { got: 0, notes: 1, unreadable: 0 };
	var UNREADABLE = { got: 0, notes: 0, unreadable: 1 };
	var NOTHING    = { got: 0, notes: 0, unreadable: 0 };
	// A diamond, waiting in the tray. None of `collect`'s three counters is about
	// it -- it is not a message, not a relay notice and not a failure -- so it
	// adds nothing to them and is counted where it is held, by `shares()`.
	var SHARE      = { got: 0, notes: 0, unreadable: 0, share: 1 };
	// Our own un-run errand, or a stand-down for the account's nominee: collected but
	// deliberately LEFT on the relay for the peer. `hold` tells collect() to keep the ack
	// watermark below this row's seq (so ackThrough never drops it) AND names the turn, so
	// `settle` can later drop exactly this hold -- without a network round -- the moment
	// the turn is settled here. Only the peer that runs it may otherwise ack it away.
	function hold(turnId) { return { got: 0, notes: 0, unreadable: 0, hold: true, turnId: String(turnId || '') }; }

	// ── Arrival ────────────────────────────────────────────────
	//
	// THE ONE SIGNAL THIS MODULE RAISES. Web Push is declined (messaging_plan
	// §10), so the count on the Social chip is the whole of what the app does to
	// say a message landed while somebody was looking elsewhere -- and until this
	// event existed nothing told it. The doorbell email rang and the app itself
	// said nothing at all.
	//
	// RAISED WHERE A ROW IS FOLDED, never where a request is answered: a park
	// woken by somebody else's traffic and a pull that found nothing both stay
	// quiet. `count` is NEW ROWS, which is the definition `daimond:mail-arrived`
	// already uses at mail.js, so one listener can take either. `unread` is the
	// honest tally that follows it, because a badge draws what is unread and
	// never a running total of arrivals.
	var ARRIVED = 'daimond:post-arrived';

	/// Say that `n` messages landed. Answers what it announced, so a caller can
	/// count without asking the DOM.
	function announce(n, addrs) {
		if (!(n > 0)) return 0;
		try {
			window.dispatchEvent(new CustomEvent(ARRIVED, {
				detail: { count: n | 0, unread: unread(), addrs: (addrs || []).slice() },
			}));
		} catch (e) { /* an old browser: the rows are folded either way */ }
		return n | 0;
	}

	/// The unread tally moved. The badge holds the number, so it is TOLD rather
	/// than left to poll -- and it is the same badge Mail lights, one function in
	/// daimond.js, so a second count here would be a second thing to keep right.
	function countChanged() {
		try { if (window.DaimondBadge && DaimondBadge.post) DaimondBadge.post(); }
		catch (e) { /* no badge in this build */ }
	}

	/// The ack watermark for a record: `seen` when nothing is held, else one below the
	/// LOWEST live hold, so `ackThrough` never drops a held errand off the relay before
	/// its peer runs it. `seen` has already climbed past every held row (the park spin
	/// fix), so a hold clips `through` DOWN without stalling the park. A hold dropped
	/// (settled, or re-decided vacant on the next collect) lets `through` rejoin `seen`.
	function watermark(st) {
		if (!st || !Array.isArray(st.holds) || !st.holds.length) return st && st.seen | 0;
		var lo = Infinity;
		for (var i = 0; i < st.holds.length; i++) {
			var s = st.holds[i].seq | 0;
			if (s < lo) lo = s;
		}
		return Math.min(st.seen | 0, lo - 1);
	}

	/// Collect everything above what this device has folded, and fold it.
	///
	/// NOTHING IS ACKED HERE. The relay drops nothing on a read; it drops only on
	/// an ack, and the ack is `ackThrough` below, after a commit.
	///
	/// NOTHING IS RUN HERE EITHER. A row that asks for work is claimed into `work`
	/// and held; the caller starts it after letting go of the mailbox lock.
	async function collect(work) {
		var st = await read();
		if (!st) return { ok: false, why: 'locked' };
		// NOT `unread`: that is the exported tally, and a local of the same name
		// here would hide it from `announce` below.
		var got = 0, notes = 0, badRows = 0, more = false;
		var arrived = [];

		for (var round = 0; round < 8; round++) {
			// BOUNDED, because everything else waits on the lock this read is made under.
			// A request the network black-holes answers nothing for as long as the
			// operating system keeps the socket, which is the park's forty-one minutes.
			var r;
			try { r = await call('GET', undefined, '?since=' + st.through, RELAY_DEADLINE_MS); }
			catch (e) { return { ok: false, why: (e && e.timedOut) ? 'timeout' : 'offline', got: got }; }
			if (r.status !== 200 || !r.json || !r.json.ok) {
				return { ok: false, why: 'status_' + r.status, got: got };
			}
			// Phase B: the collect answer carries the post-door caps, which is how
			// `post`/`post_rows`/`collect` reach the client for the later findings. A
			// Phase-A gateway sends no `limits`, and `learn` ignores absence.
			if (window.DaimondWire && r.json.limits) {
				DaimondWire.learn({ post: r.json.limits.max_bytes, post_rows: r.json.limits.max_rows,
					collect: r.json.limits.max_collect_bytes });
			}
			// RE-DECIDE EVERY HOLD THIS PASS. `through` is pinned below the lowest live
			// hold, so `?since=through` re-fetches every held row and `takeRow` re-runs
			// `holdOwnDispatch` on each -- a turn settled since the last pass no longer holds,
			// so the cursor passes it here (S-HAND #1/#2) even without a `settle` call. The
			// set is rebuilt from scratch, never carried, so a stale hold cannot linger.
			st.holds = [];
			var rows = r.json.rows || [];
			for (var i = 0; i < rows.length; i++) {
				var row  = rows[i];
				var took = await takeRow(st, row, work);
				got     += took.got;
				notes   += took.notes;
				badRows += took.unreadable;
				if (took.got) arrived.push(String(row.addr));
				// A HELD row (our own live errand, or a stand-down for the nominee) is
				// recorded with its turnId, so `settle` can drop exactly it later.
				if (took.hold) st.holds.push({ seq: row.seq | 0, turnId: String(took.turnId || '') });
				// EVERY folded row moves `seen`, a HELD one included -- this is the whole
				// spin fix. `through` -- what ackThrough acks through -- is clipped just below
				// the LOWEST live hold (watermark), so the relay keeps every held row for its
				// peer; but the park is keyed on `seen`, which climbs past the held row so the
				// next park waits rather than re-answering at once against the box's own
				// high-water.
				if ((row.seq | 0) > (st.seen | 0)) st.seen = row.seq | 0;
				st.through = Math.max(st.through | 0, watermark(st));
			}
			parkAgain();			// a request that was served proves the session is back
			more = !!r.json.more;
			if (!more || st.holds.length) break;	// once holding, stop fetching further batches this pass
		}
		await save();
		render();
		_servicedAt = Date.now();		// a collect completed: this device is servicing the channel
		announce(got, arrived);
		// SCHEDULE a push, never gate the ack on one: an idle always-on receiver that
		// folds rows and acks them off the relay is now the only copy until this fires.
		// `nudge` only arms sync's own debounced timer -- it is a no-op with no parcel,
		// no entitlement or no sync module at all, so this is safe unconditionally.
		if (got || notes) {
			try { if (window.DaimondSync && DaimondSync.nudge) DaimondSync.nudge(); }
			catch (e) { /* no sync module, or it declined: the ack below still stands */ }
		}
		return { ok: true, got: got, notes: notes, unreadable: badRows, more: more };
	}

	/// Drop this device's OWN hold on `turnId`, because the turn is now settled here (it
	/// ran locally, or a peer's answer merged). The held errand no longer needs to sit on
	/// the relay, so the ack watermark is freed past it AT ONCE -- rather than waiting for
	/// the next collect to re-decide the hold -- and the next `ackThrough` then tells the
	/// relay it may drop the row so no peer waking inside the deadline re-runs and re-bills
	/// it (S-HAND #1). NEVER acks itself: `ackThrough` owns the durable-commit-before-ack
	/// order (WS-BRICK), and `settle` only moves the local watermark. A no-op -- and no
	/// save -- when no hold matches, so the ack dep can call it on every errand cheaply.
	async function settle(turnId) {
		var id = String(turnId || '');
		if (!id) return { settled: false };
		var st = await read();
		if (!st) return { settled: false };
		if (!Array.isArray(st.holds) || !st.holds.length) return { settled: false };
		var before = st.holds.length;
		st.holds = st.holds.filter(function (h) { return String(h.turnId || '') !== id; });
		if (st.holds.length === before) return { settled: false };
		st.through = Math.max(st.through | 0, watermark(st));
		await save();
		return { settled: true, through: st.through };
	}

	// ── The ordering, which is the whole safety property ───────
	//
	// COLLECTED = one device has fetched the envelope, folded it into THIS DEVICE'S
	// wrapped record, and READ THAT RECORD BACK to prove the fold is durably on disk.
	// The device then acks. Nothing else counts, and the ack is sent in that order.
	//
	// The ack is a WATERMARK BY REFERENCE (a `seq`): it tells the relay it may let go
	// of rows this device has already stored. It must not demand the whole account
	// parcel by value. It used to: the old ack gated on `DaimondSync.push()` moving the
	// parcel version, so once the parcel was over Steel's door (sync.js `tooLarge`) the
	// version never moved, the device never acked, the relay box filled to `max_rows`,
	// and EVERY sender to the account was refused (the S1 this fixes). Coupling the
	// mailbox to the size of unrelated account state is the bug; the fix is to commit
	// the rows LOCALLY and ack on that, never on the parcel.
	//
	// The parcel still carries the folded rows to the account's OTHER devices, on the
	// sync engine's own schedule (`state.post = snapshotRefs()`), and nothing about the
	// mailbox waits on it. A device wiped between its ack and its next successful push
	// loses those rows -- the same one-copy exposure every other local-only state has,
	// and the read-back is what makes "durable" mean written rather than intended.

	/// Whether the account has a parcel push at all -- used ONLY to LABEL the report
	/// (`solo`), never to choose the ack path. `state()` reports the same thing.
	function syncReady() {
		return !!(window.DaimondSync && DaimondSync.entitled && DaimondSync.entitled()
			&& DaimondSync.parcel && DaimondSync.push && DaimondSync.version);
	}

	/// The wrapped record as it sits in storage, re-read: `through` on it, or -1 when
	/// the record is absent, will not unwrap, or will not parse. Never `_st` -- that is
	/// memory, and the point is to prove what reached the disk.
	async function storedThrough() {
		var raw = null;
		try { raw = localStorage.getItem(LS); } catch (e) { return -1; }
		if (!raw) return -1;
		try {
			var r = JSON.parse(await DaimondIdentity.unwrap(raw));
			return (r && r.v === REC_V) ? (r.through | 0) : -1;
		} catch (e) { return -1; }
	}

	/// Tell the relay it may let go of rows up to `through`, once they are durably in
	/// THIS device's record. Answers `{ acked, why, solo }`. Every `why` is a refusal
	/// to ack, and every one costs a re-collect and nothing else: the relay still holds
	/// the envelope, and collecting it again is idempotent by address.
	async function ackThrough() {
		var st = await read();
		if (!st) return { acked: 0, why: 'locked' };
		if (st.through <= st.acked) return { acked: 0, why: 'nothing' };
		var want = st.through;
		// The local durable commit. `save()` answers false on a write throw (a quota
		// over-run), and the read-back proves the row actually reached the disk -- a
		// swallowed failure here is how the relay would drop the only copy.
		if (!(await save())) return { acked: 0, why: 'not_saved' };
		if ((await storedThrough()) < want) return { acked: 0, why: 'not_saved' };
		var r = await tellRelay(want);
		r.solo = !syncReady();			// one copy in one place, as state() reports it
		return r;
	}

	/// The ack request itself, and the only place it is made.
	async function tellRelay(want) {
		var r;
		try { r = await call('POST', { through: want }, '?op=ack', RELAY_DEADLINE_MS); }
		catch (e) { return { acked: 0, why: (e && e.timedOut) ? 'timeout' : 'offline' }; }
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { acked: 0, why: 'status_' + r.status };
		}
		var st = await read();
		if (st) { st.acked = want; await save(); }
		return { acked: want, dropped: (r.json.dropped | 0) };
	}

	/// Hold an exclusive lock across `fn`, so two tabs cannot interleave a collect, a fold
	/// and an ack against the same mailbox record. Without this, tab A can fold rows, save,
	/// prove the save with a read-back and ack the relay -- while tab B, still holding the
	/// `_st` it had before any of that, runs its OWN collect (which saves unconditionally,
	/// see `collect` above) mid-way through and overwrites disk with a record that never
	/// saw A's rows. The rows are then gone from disk (B's write), the relay (A's ack) and
	/// memory (nobody's `_st` has both) -- collected, acked, and never pushed anywhere.
	/// Mirrors `withTurnLock` in daimond.js; degrades to running `fn` straight where the
	/// Web Locks API is absent (an older engine), exactly as that one does.
	///
	/// NOT RE-ENTRANT. `fn` must never reach a locked export of this module (`collect`,
	/// `ack`, `settle`): the request queues behind the lock its own caller holds, and
	/// neither ever settles. That is what stopped a desktop collecting after its first
	/// hand-off (E-R4), and why work is started after the lock (`startWork`).
	function withMailboxLock(fn) {
		if (window.navigator && navigator.locks && navigator.locks.request) {
			return navigator.locks.request('daimond-post-mailbox', { mode: 'exclusive' }, fn);
		}
		return fn();
	}

	/// The longest a relay read or an ack may take while it holds the mailbox lock.
	/// A collect carries up to the relay's 1 MiB batch, so this is generous.
	var RELAY_DEADLINE_MS = 60000;

	/// Collect, fold and ack, in that order, under the mailbox lock; then start the
	/// work the collect claimed. The one routine anything else calls.
	async function round() {
		var work = [];
		try {
			return await withMailboxLock(async function () {
				var c = await collect(work);
				if (!c.ok) return c;
				var a = await ackThrough();
				return { ok: true, got: c.got, notes: c.notes, unreadable: c.unreadable,
					acked: a.acked | 0, why: a.why || '' };
			});
		} finally { startWork(work); }
	}

	/// `collect` under the mailbox lock, and the work it claimed started after it.
	async function collectLocked() {
		var work = [];
		try { return await withMailboxLock(function () { return collect(work); }); }
		finally { startWork(work); }
	}

	// ── The work a row asks for ────────────────────────────────
	//
	// An errand or a compile is claimed under the mailbox lock and run after it. The
	// row stays HELD for the whole run, so the relay keeps it until the run is over
	// (the ack-after-the-answer order `runErrand` promises), and the claim is kept
	// until the row has been let go, so no collect in between takes it for unclaimed.

	/// Claims held in THIS tab, for an engine without the Web Locks API.
	var _claimed = {};

	/// Claim the right to run one row's work: `{ release }`, or null when a run of the
	/// same turn is already claimed on this device -- in this tab, or in another tab of
	/// this browser, which shares the device id and so would win the same lease.
	///
	/// NEVER WAITS (`ifAvailable`): it is asked for under the mailbox lock, and a wait
	/// there is the deadlock this exists to prevent.
	function claimWork(key) {
		var name = 'daimond-post-work:' + String(key || '');
		function here() {
			if (_claimed[name]) return null;
			_claimed[name] = 1;
			return { release: function () { delete _claimed[name]; } };
		}
		if (!(window.navigator && navigator.locks && navigator.locks.request)) {
			return Promise.resolve(here());
		}
		return new Promise(function (resolve) {
			navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, function (lock) {
				if (!lock) { resolve(null); return undefined; }
				// Held until `release`: the lock is let go when this promise settles.
				return new Promise(function (done) { resolve({ release: function () { done(); } }); });
			}).catch(function () { resolve(here()); });
		});
	}

	/// This tab's work, one piece at a time and in the order it was collected -- as it
	/// ran when it ran inside the collect, and as the runner expects: a consent is
	/// routed for THE running turn (`activeRunnerTurn`, daimond.js).
	var _workChain = Promise.resolve();

	/// Start the work a collect claimed, now that the mailbox lock is let go. Not
	/// awaited by whoever collected it: a turn is minutes long, and the listener that
	/// found it must be back on its park, collecting, while it runs. Answers a promise
	/// of whether each row is still held once its work is over, for `take`.
	function startWork(list) {
		return Promise.all((list || []).map(function (w) {
			var run = function () { return runWork(w); };
			var p = _workChain.then(run, run);
			_workChain = p;
			return p;
		}));
	}

	/// Run one claimed row, let the row go, and only then give up the claim. Answers
	/// whether the row is still held.
	async function runWork(w) {
		var res = null, stood = false;
		try { res = await DaimondPeer.absorb(w.peer, w.row); }
		catch (e) { log('a peer envelope would not apply', e); }
		try {
			// A non-nominee that STOOD DOWN for the account's nominated always-on runner
			// leaves the errand on the relay, exactly as an own dispatch is left: acking
			// past it would drop it before the nominee collects, and a nominee that then
			// never ran would strand the turn. So the row stays HELD and is collected --
			// and decided against live presence -- again, until the nominee runs it or its
			// beat ages out and this device claims. Money-safe by the lease either way.
			stood = !!(res && res.result && res.result.why === 'nominee');
			if (!stood) await withMailboxLock(function () { return letGo(w.row.seq); });
		} catch (e) { log('a finished row could not be let go; the next collect decides it', e); }
		finally { w.claim.release(); }
		return stood;
	}

	/// Drop the hold on one row whose work is over, and ack what that frees. Under the
	/// mailbox lock; the ack keeps its durable-commit-first order (`ackThrough`).
	async function letGo(seq) {
		var st = await read();
		if (!st) return { acked: 0, why: 'locked' };
		if (Array.isArray(st.holds) && st.holds.length) {
			var s = seq | 0;
			st.holds = st.holds.filter(function (h) { return (h.seq | 0) !== s; });
			st.through = Math.max(st.through | 0, watermark(st));
		}
		return await ackThrough();
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

	/// Ask to follow somebody, answer somebody who asked, or let go either way.
	///
	/// Here beside `connect` rather than in js/feed.js because it is the SAME
	/// door: one path, a peer's public key and a verb, and the block that governs
	/// both is the one this module already reads. `action` is `request`,
	/// `approve`, `remove` or `unfollow`.
	///
	/// A REQUEST IS ANSWERED THE SAME WHETHER IT WAS STORED OR NOT. The relay
	/// answers a blocked ask exactly as it answers an ordinary one, for the reason
	/// `deliver` gives above, so nothing here may report a block and no caller may
	/// infer one from `{ok:true}`.
	async function follow(peerPub, action) {
		if (['request', 'approve', 'remove', 'unfollow'].indexOf(String(action)) < 0) {
			return { ok: false, why: 'unknown_action' };
		}
		var r;
		try { r = await call('POST', { peer: String(peerPub), action: String(action) }, '?op=follow'); }
		catch (e) { return { ok: false, why: 'offline' }; }
		if (r.status !== 200 || !r.json || !r.json.ok) {
			return { ok: false, status: r.status | 0,
				why: (r.json && r.json.reason) || 'status_' + r.status };
		}
		return { ok: true };
	}

	/// Add a diamond somebody sent, as a diamond of this account's own.
	///
	/// THE ONLY THING THAT PUTS A SHARE ON THE MACHINE. `takeRow` keeps the sealed
	/// envelope and nothing else happens until this is pressed, so the consent
	/// step is a person's press and not a collect.
	///
	/// share.js does the opening and the landing, called and not copied: the
	/// address is re-checked against the envelope, the payload's `to` against this
	/// account's key, and `askAboutCode` is asked before a page is written. A
	/// second landing path written here would be a second place for that question
	/// to be forgotten.
	async function addShare(addr) {
		var st = await read();
		if (!st || !st.shares || !st.shares[String(addr)]) {
			return { ok: false, why: tOr('post.share_gone',
				'That diamond is no longer waiting.') };
		}
		if (!window.DaimondShare || typeof DaimondShare.open !== 'function'
			|| typeof DaimondShare.accept !== 'function') {
			return { ok: false, why: tOr('share.err_no_bridge',
				'This build cannot share a diamond: its share format is not loaded.') };
		}
		var rec = st.shares[String(addr)];
		var reading;
		try { reading = await DaimondShare.open(rec.env, rec.addr); }
		catch (e) { return { ok: false, why: String((e && e.message) || e) }; }
		var r;
		try {
			// The sender's name as THIS device knows them, so the landed diamond can
			// say who it came from in words rather than in a key. Advisory, and the
			// key beside it in `origin.json` is the fact.
			r = await DaimondShare.accept(reading, { handle: nameFor(rec.from) });
		} catch (e) {
			return { ok: false, why: String((e && e.message) || e) };
		} finally {
			try { if (reading && reading.free) reading.free(); } catch (e2) { /* freed */ }
		}
		// MARKED TAKEN WHATEVER LANDED. `accept` answers `ok: false` where the whole
		// share was a page the receiver declined, and that is an answer rather than
		// a failure: re-drawing the row would ask the same question again for ever.
		rec.taken = 1;
		await save();
		render();
		return r;
	}

	/// Keep the sender's own row for a diamond they sent.
	///
	/// A share does not go through `send`, because `send` composes a message and a
	/// share is composed by share.js and handed to `fanout` already sealed. So the
	/// Sent copy is written here, at the one door, rather than share.js reaching
	/// into this module's record -- and it is written only after the relay took it,
	/// which is the rule `send` keeps for the same reason.
	async function noteShareSent(o) {
		var st = await read();
		if (!st || !o || !o.addr) return false;
		st.msgs[String(o.addr)] = {
			addr: String(o.addr), dir: 'out', to: String(o.to || ''),
			body: tOr('post.share_sent_row', 'Sent {name} to {who}',
				{ name: String(o.name || ''), who: String(o.who || '') }),
			ts: ms(o.ts) || Date.now(), read: 1, tray: 0, share: 1,
		};
		await save();
		render();
		return true;
	}

	/// Stop drawing a share's tray row. Local, like Ignore on a message, and it
	/// keeps the envelope: a person who ignored a gift and changed their mind has
	/// nothing left to change it with once the relay has let go.
	async function hideShare(addr) {
		var st = await read();
		if (!st || !st.shares || !st.shares[String(addr)]) return false;
		st.shares[String(addr)].hidden = 1;
		await save();
		render();
		return true;
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
	/// THE WATCHDOG. `fetch` has no timeout, so a park whose request is black-holed --
	/// the socket accepted and then nothing, which is what a front door being restarted
	/// behind a proxy looks like -- hangs for as long as the operating system keeps the
	/// connection. A phone once sat FORTY-ONE MINUTES on a dead `/api/post`: it beat
	/// presence the whole time, looked like the freshest available peer, and serviced
	/// nothing, so every errand handed to it was handed into a hole. The gateway answers
	/// a park within `PARK_MS` or says "nothing yet", so anything past that window plus
	/// slack is not a slow answer, it is no answer.
	var PARK_DEADLINE_MS = PARK_MS + 10000;
	/// A failed park waits before the next, doubling to a minute. The first wait is the
	/// five seconds this always took; the doubling is what stops a device whose front
	/// door is down retrying every five seconds for an hour.
	var PARK_BACKOFF_MS  = 5000;
	var PARK_BACKOFF_CAP = 60000;
	var _parking  = false;		// is a park in flight or scheduled?
	var _parkOff  = '';			// why parking stopped, or ''
	var _parkGen  = 0;			// torn down and restarted, so a stale park is ignored
	var _parks    = 0;			// parks made, for a verifier
	var _parkFails = 0;			// consecutive failed parks, which is what the backoff reads
	var _parkTimeouts = 0;		// parks the watchdog cut, for a verifier
	var _servicedAt = 0;		// last time a park long-poll round or a collect actually completed

	/// How long to wait after `n` consecutive failures. Doubling, capped.
	function parkBackoff(n) {
		var k = n > 1 ? n - 1 : 0;
		if (k > 10) k = 10;					// 5 s << 10 is already past the cap
		var ms = PARK_BACKOFF_MS * Math.pow(2, k);
		return ms > PARK_BACKOFF_CAP ? PARK_BACKOFF_CAP : ms;
	}

	/// Tell the debug feed a park was cut. Through `event` rather than
	/// `noteFetchFail`, deliberately: that helper tags a status-0 failure `aborted`
	/// when the page is hidden, and a runner's window is hidden nearly all the time --
	/// so the one signal that says the errand channel is dead would be filed as an
	/// ordinary navigation and hidden from the reader by default. `gwFetch` reports the
	/// abort itself, as a bare status 0; this is the line beside it that says WHY.
	function noteParkTimeout(ms) {
		try {
			if (window.DEBUG_SHARE && DEBUG_SHARE.event) {
				DEBUG_SHARE.event('fetch.fail', { path: PATH, status: 0, ms: ms | 0,
					err: 'park-timeout' });
			}
		} catch (e) { /* the feed is not a dependency of the transport */ }
	}

	/// Start parking. Idempotent, and refuses where parking has been turned off.
	function parkStart() {
		if (_parking || _parkOff) return false;
		_parking = true;
		_parkGen++;
		_parkFails = 0;			// a deliberate start is not a continuation of an old outage
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

	/// Lift a stop that a working request has disproved. Never lifts `no_park`, and
	/// never lifts `removed`.
	///
	/// Both are facts nothing this client does will change. `no_park` is the front
	/// door dropping the query string; `removed` is the account having removed this
	/// device (owner ruling 2026-09-12), which the gateway will go on refusing for
	/// ever -- so re-arming the park on it would be exactly the hammering this check
	/// exists to prevent, against a door that is never going to open.
	function parkAgain() {
		if (_parkOff && _parkOff !== 'no_park' && _parkOff !== 'removed') _parkOff = '';
	}

	async function parkOnce(gen) {
		while (_parking && gen === _parkGen) {
			var st = await read();
			if (!st) { parkStop(''); return; }
			_parks++;
			var began = Date.now();
			var r;
			try {
				// `device` names WHICH device is parking, so the gateway can refuse a
				// device the account has REMOVED (owner ruling 2026-09-12) and can evict
				// this very park the instant the removal lands -- the park is the errand
				// listener's door, which is how a handed-off turn reaches a device, so it
				// is the second door a removed device must not hold. Optional on the wire:
				// a gateway that does not read it parks exactly as before.
				// ABOVE THE HIGHEST SEQ FOLDED, not the ack watermark. `through` is pinned
				// below a HELD errand (takeRow HOLDs an own-dispatch or a nominee stand-down
				// so the relay keeps it for the peer), and the box's high-water is above it,
				// so a park keyed on `through` returns instantly (post.rs:608) and `round()`
				// re-folds the same held rows every PARK_FLOOR_MS -- the 1 Hz spin that tripped
				// AddressGuard. `seen` climbs past a held row, so the park waits for a row that
				// is genuinely new. A held row is still re-decided: `collect` fetches from
				// `through`, and the nominee-fallback re-collect (daimond.js) fires on the
				// freshness window, so a stand-down still resolves.
				var above = Math.max(st.through | 0, st.seen | 0);
				r = await call('GET', undefined, '?above=' + above
					+ '&ms=' + PARK_MS + '&w=' + encodeURIComponent(WAKE_ID)
					+ '&device=' + encodeURIComponent(selfDeviceIdForPark()), PARK_DEADLINE_MS);
			} catch (e) {
				// The network went, or the watchdog cut a request nothing was ever going
				// to answer. Neither is a reason to give up on the transport, so this
				// waits and tries again rather than turning parking off for good -- but
				// the wait DOUBLES, so a front door that is down is not hammered, and a
				// cut park is reported: until it was, a hole in the errand channel was
				// indistinguishable from a quiet one.
				if (e && e.timedOut) { _parkTimeouts++; noteParkTimeout(Date.now() - began); }
				await sleep(parkBackoff(++_parkFails));
				continue;
			}
			if (gen !== _parkGen) return;
			if (r.status === 401 || r.status === 426) { parkStop('session'); return; }
			// REMOVED FROM THE ACCOUNT. Parking stops for good -- the door will refuse
			// this device for ever -- and the one event that wipes and locks is raised
			// where it is raised for the presence beat, so both doors reach the same
			// handler. Keyed on the flag, not the status alone.
			if (r.status === 410 && r.json && r.json.removed === true) {
				parkStop('removed');
				try { window.dispatchEvent(new CustomEvent('daimond:device-removed')); }
				catch (e) { /* the beat says the same thing */ }
				return;
			}
			if (r.status !== 200 || !r.json) { await sleep(5000); continue; }
			// THE CHECK THIS WHOLE BLOCK EXISTS FOR.
			if (r.json.waited !== true) {
				parkStop('no_park');
				log('the park answered without `waited`: the query string is being dropped, '
					+ 'so this is an ordinary pull. Parking is off.');
				return;
			}
			// A genuine park round completed: this device is actively servicing the errand
			// channel right now. Stamp it so presence can tell a real runner from a
			// throttled background tab that only beats (peer.js recGenuine).
			_servicedAt = Date.now();
			_parkFails  = 0;		// an answered park clears the outage
			// THE LISTENER OUTLIVES ITS ROUND. A round that threw used to throw out of
			// this loop with `_parking` still true, and `parkStart` refuses while it is:
			// the device went on beating presence and never parked again. The next park
			// asks again from the same cursor, so a failed round costs one round.
			if (r.json.changed) {
				try { await round(); }
				catch (e) { log('a round failed; the next park asks again', e); }
			}
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

	/// The diamonds waiting to be added, ignored or blocked. Newest first, as the
	/// message tray is.
	function shares() {
		if (!_st || !_st.shares) return [];
		return Object.keys(_st.shares).map(function (k) { return _st.shares[k]; })
			.filter(function (s2) { return s2 && !s2.taken && !s2.hidden; })
			.sort(function (a, b) { return (b.ts | 0) - (a.ts | 0); });
	}

	/// The rows waiting to be accepted, ignored or blocked.
	function tray() {
		if (!_st) return [];
		return Object.keys(_st.msgs).map(function (k) { return _st.msgs[k]; })
			.filter(function (m) { return m.tray && !m.del && !m.hidden; })
			.sort(function (a, b) { return (b.ts | 0) - (a.ts | 0); });
	}

	/// The follow requests waiting to be approved, ignored or blocked. Newest
	/// first, as the message tray is, and kept with the notices because that is
	/// what they are: rows the relay wrote, with nothing signed in them.
	function follows() {
		if (!_st) return [];
		return Object.keys(_st.notes).map(function (k) { return _st.notes[k]; })
			.filter(function (n) { return n && n.ask && !n.hidden; })
			.sort(function (a, b) { return (b.seq | 0) - (a.seq | 0); });
	}

	/// Take one follow request off this device's tray. WRITES NOTHING TO THE
	/// RELAY, on the rule Ignore keeps everywhere else in this panel: a sender who
	/// could tell an ignore from a silence has a presence oracle. The pending
	/// entry stays on the gateway until it is approved, blocked, or falls off the
	/// end of the author's pending list.
	async function hideFollow(seq) {
		var st = await read();
		var n  = st && st.notes['n' + (seq | 0)];
		if (!n) return false;
		n.hidden = 1;
		await save();
		render();
		return true;
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
			// A follow request is drawn in the TRAY, because it waits on an answer,
			// and one that was ignored is drawn nowhere at all.
			if (n.ask || n.hidden) return;
			var key = n.kind === 'expired' && n.addr ? 'a:' + n.addr : 'k:' + k;
			var held = byAddr[key];
			if (!held) {
				byAddr[key] = { seq: n.seq | 0, kind: n.kind, addr: n.addr,
					ts: n.ts | 0, copies: 1, from: n.from || '', text: n.text || '' };
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

	/// Mark every incoming row that is NOW ON SCREEN as read.
	///
	/// DRAWN, NOT FETCHED, and that distinction is the whole of what makes the
	/// count mean anything. A park folds messages while the panel is shut; a
	/// device that cleared its own badge on collection would clear it for
	/// messages nobody has ever looked at, which is precisely the case the badge
	/// exists to announce. So the mark is made HERE, after the rows are in the
	/// document, and only where the list has real area: an absent element and a
	/// hidden one both measure nothing, which is the honest answer for both.
	function markDrawnRead(addrs) {
		if (!_st || !addrs || !addrs.length) return 0;
		var h = host();
		if (!h) return 0;
		var b = h.getBoundingClientRect();
		if (!(b.width > 1 && b.height > 1)) return 0;
		var n = 0;
		addrs.forEach(function (a) {
			var m = _st.msgs[a];
			if (m && m.dir === 'in' && !m.read) { m.read = 1; n++; }
		});
		if (!n) return 0;
		save();
		countChanged();
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
				'Unlock Daimond to read your messages.')));
			filled(true);		// locked is a state this view drew, not an absent feature
			return;
		}

		// The request tray, above the list, because it is the thing waiting on a
		// person and the list is not.
		var pending = tray();
		var gifts   = shares();
		var asks    = follows();
		if (pending.length || gifts.length || asks.length) {
			var tsec = elt('section', 'post-tray');
			tsec.id = 'post-tray';
			tsec.appendChild(elt('h3', null, tOr('post.tray_head', 'Waiting for your answer')));
			// Somebody asking to read what this account writes. First, because it is
			// the shortest decision on the tray and the only one with no words in it
			// to read.
			asks.forEach(function (f) { tsec.appendChild(drawFollowRow(f)); });
			// Diamonds first. A gift asks for more than an answer -- it asks to be
			// written into the workspace -- and it is the row a person most needs to
			// see before they start pressing things.
			gifts.forEach(function (g) { tsec.appendChild(drawShareRow(g)); });
			pending.forEach(function (m) { tsec.appendChild(drawTrayRow(m)); });
			h.appendChild(tsec);
		}

		var lsec = elt('section', 'post-list');
		lsec.id = 'post-list';
		var msgs = list();
		if (!msgs.length) {
			lsec.appendChild(peopleLine('post-empty', tOr('post.none',
				'No messages yet. Add somebody in {people}.')));
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

		// NULL WHERE THERE IS NOTHING TO WRITE WITH. An empty `.post-write` is a
		// grey bar with nothing in it, which reads as a control that has failed to
		// load rather than as a stage a new account is in.
		var write = drawWrite();
		if (write) h.appendChild(write);

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

		// READ WHEN DRAWN. Last, because it measures the element it has just put
		// on the screen, and a row counted before it was placed is a row nobody
		// saw.
		markDrawnRead(msgs.filter(function (m) { return m.dir === 'in' && !m.read; })
			.map(function (m) { return m.addr; }));
	}

	/// A line with the word People in it, drawn as the chip it goes to.
	///
	/// ONE SENTENCE, not two halves glued together: the whole of it is one
	/// translated string with a `{people}` slot, so a translator moves the word
	/// where their language puts it. The chip's own label fills the slot, so the
	/// word in the sentence is always the word on the chip.
	///
	/// A BUTTON AND NOT A LINK, for the same reason `.ref-chip` is: this is
	/// navigation inside the app, and a link is something a reader tries to copy
	/// out. group.js draws its own empty line through this, so there is one of
	/// these and not two.
	function peopleLine(cls, text) {
		var p = elt('p', cls);
		var parts = String(text).split('{people}');
		p.appendChild(document.createTextNode(parts[0]));
		if (parts.length > 1) {
			var b = elt('button', 'post-link', tOr('social.people', 'People'));
			b.type = 'button';
			b.dataset.act = 'post-people';
			p.appendChild(b);
			p.appendChild(document.createTextNode(parts.slice(1).join('{people}')));
		}
		return p;
	}

	/// One message. A handle and a fingerprint and no app chrome whatever: the
	/// official shape is granted only by a verified signature, and this file
	/// draws no official shape at all.
	function drawRow(m) {
		var row = elt('article', 'post-msg');
		row.dataset.addr = m.addr;
		// Who to answer, on the element, so the Reply press needs no lookup and no
		// closure per row.
		if (m.dir === 'in' && m.from) row.dataset.from = String(m.from);
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
		drawQuote(row, m);
		if (m.bad) {
			// It arrived and it will not open. Said, rather than left as a gap.
			row.appendChild(elt('p', 'post-bad', tOr('post.unreadable',
				'A message arrived that this device could not open.')));
			row.appendChild(elt('p', 'post-bad-why', m.bad));
		} else {
			row.appendChild(elt('p', 'post-body', m.body || ''));
		}
		drawRefs(row, m.refs);
		// One row of controls, and it is drawn only where there is something on
		// it: an empty `.post-acts` is a gap under every message.
		var acts = elt('div', 'post-acts');
		drawReply(acts, m);
		drawReport(acts, m);
		if (acts.childNodes.length) row.appendChild(acts);
		return row;
	}

	/// What a reply says of the message it answers, in one line.
	///
	/// FOUND LOCALLY. Only the parent's ADDRESS travels (`replyTo`, set in
	/// `compose` and signed with the rest), never its words -- a relay that could
	/// supply the quote would be a relay that had read the message. So a parent
	/// the relay has let go of (§11.3) is simply not here, and the row says that
	/// rather than heading itself with an empty line.
	function quoteText(addr) {
		var p = _st && _st.msgs[String(addr)];
		var said = (p && !p.bad) ? String(p.body || '').replace(/\s+/g, ' ').trim() : '';
		if (!said) return tOr('post.reply_gone', 'In reply to a message that has expired.');
		return tOr('post.reply_quote', 'In reply to: {said}',
			{ said: said.length > QUOTE_MAX ? said.slice(0, QUOTE_MAX) + '…' : said });
	}

	/// The quoted line, above the words that answer it.
	function drawQuote(row, m) {
		if (!m.replyTo) return;
		var p = _st && _st.msgs[String(m.replyTo)];
		var here = !!(p && !p.bad && String(p.body || '').trim());
		var q = elt('p', 'post-quote' + (here ? '' : ' post-quote-gone'), quoteText(m.replyTo));
		q.dataset.parent = String(m.replyTo);
		row.appendChild(q);
	}

	/// Reply, on a row somebody else wrote.
	///
	/// THE SAME SEND PATH, and nothing new on the wire: `replyTo` has ridden the
	/// signed payload since the format was written and this is the first thing in
	/// the app that sets it. Not offered on a row this device sent, on one that
	/// would not open, or on the relay's own notices: there is nobody to answer in
	/// any of the three.
	function drawReply(acts, m) {
		if (m.dir !== 'in' || m.bad || !m.from) return;
		var b = elt('button', 'post-btn post-reply', tOr('post.reply', 'Reply'));
		b.type = 'button';
		b.dataset.act = 'post-reply';
		acts.appendChild(b);
	}

	/// The Report control, where there is something to report WITH.
	///
	/// ONE ATTRIBUTE, and that is the whole of the coupling: report.js listens
	/// for a delegated click on `[data-report-addr]` and touches nothing in this
	/// panel's DOM. It also answers `canReport`, and it is asked rather than
	/// guessed at -- a control that exists only to produce an error explains less
	/// than its absence does, and a message collected by an older build has no
	/// artefact to prove anything with.
	/// A GROUP ROW GETS THE SAME CONTROL, and this is where that used to stop
	/// being true in practice: the control was drawn, and the gateway refused
	/// every filing, because a group message's signed `to` is the group's id and
	/// not the reporter's key. report.js now sends the roster with it and the
	/// gateway checks membership from that; nothing here changes, because `m`
	/// already carries `gid` and report.js reads it off the same record.
	function drawReport(acts, m) {
		try {
			if (!window.DaimondReport || !DaimondReport.canReport) return;
			if (!DaimondReport.canReport(m)) return;
			var b = elt('button', 'post-btn post-report', tOr('post.report', 'Report'));
			b.type = 'button';
			b.setAttribute('data-report-addr', String(m.addr));
			acts.appendChild(b);
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

	/// One follow request: who is asking, and the three answers.
	///
	/// THE SAME ROW A STRANGER'S FIRST MESSAGE GETS, because it is the same kind
	/// of decision and a feed request dressed differently would be a second thing
	/// to learn. The handle is the relay's word for the asker and is drawn as the
	/// claim it is -- a handle is the gateway's namespace, not a matched key.
	function drawFollowRow(f) {
		var row = elt('article', 'post-req post-follow');
		row.dataset.seq  = String(f.seq | 0);
		row.dataset.peer = f.from || '';
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name',
			nameFor(f.from) || f.text || tOr('post.someone', 'Someone new')));
		row.appendChild(who);
		drawKeyLine(row, f.from);
		row.appendChild(elt('p', 'post-body', tOr('feed.wants', '{who} wants to follow you',
			{ who: f.text || nameFor(f.from) || tOr('post.someone', 'Someone new') })));
		var acts = elt('div', 'post-acts');
		[['post-follow-approve', tOr('feed.approve', 'Approve')],
		 ['post-follow-ignore',  tOr('post.ignore',  'Ignore')],
		 ['post-follow-block',   tOr('post.block',   'Block')]].forEach(function (pair) {
			var b = elt('button', 'post-btn', pair[1]);
			b.type = 'button';
			b.dataset.act = pair[0];
			acts.appendChild(b);
		});
		row.appendChild(acts);
		return row;
	}

	/// One diamond somebody sent, waiting in the same tray a stranger's first
	/// message waits in.
	///
	/// THE SAME ROW AS A MESSAGE'S, and deliberately: a share carries no official
	/// shape either. What differs is the facts line, because the three things a
	/// person needs before they press Add are what it is, how big it is, and
	/// whether a program is inside it.
	function drawShareRow(sh) {
		var row = elt('article', 'post-req post-share');
		row.dataset.addr = sh.addr;
		row.dataset.peer = sh.from || '';
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name',
			nameFor(sh.from) || tOr('post.someone', 'Someone new')));
		if (sh.fp) who.appendChild(elt('span', 'post-fp', sh.fp));
		row.appendChild(who);
		drawKeyLine(row, sh.from);
		var facts = tOr('post.share_row',
			'{who} sent you a diamond: {name} · {n} files · {size}', {
				who:  nameFor(sh.from) || tOr('post.someone', 'Someone new'),
				name: sh.name || tOr('share.landed_name', 'A shared diamond'),
				n:    sh.n | 0, size: bytesSaid(sh.bytes),
			});
		// SAID BEFORE THE PRESS. A page is a program somebody else wrote, and
		// `askAboutCode` asks about it properly -- but a person deciding whether to
		// press Add at all should not have to press it to find out there is one.
		if (sh.code) facts += ' · ' + tOr('post.share_has_page', 'includes a page');
		row.appendChild(elt('p', 'post-body', facts));
		if (sh.note) row.appendChild(elt('p', 'post-share-note', sh.note));
		var acts = elt('div', 'post-acts');
		[['post-share-add',    tOr('post.share_add', 'Add')],
		 ['post-share-ignore', tOr('post.ignore', 'Ignore')],
		 ['post-share-block',  tOr('post.block',  'Block')]].forEach(function (pair) {
			var b = elt('button', 'post-btn', pair[1]);
			b.type = 'button';
			b.dataset.act = pair[0];
			acts.appendChild(b);
		});
		row.appendChild(acts);
		var say = elt('p', 'post-share-say', '');
		say.hidden = true;
		row.appendChild(say);
		return row;
	}

	/// A byte count the way a person reads one. share.js says the same thing in
	/// its own `kb`, which is not reachable from here without loading it first.
	function bytesSaid(n) {
		var v = Number(n) || 0;
		if (v < 1024) return v + ' B';
		if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
		return (v / (1024 * 1024)).toFixed(1) + ' MB';
	}

	/// A row the relay wrote. No author, no reply control, and its own section --
	/// never in the message stream.
	function drawNotice(n) {
		var row = elt('article', 'post-notice');
		// SOMEBODY LET THIS ACCOUNT FOLLOW THEM, or one of this account's own posts
		// was taken down. Both are the relay's rows and neither is a message, so
		// they are said here and never in the list -- the `feedgone` text is
		// "<id> <reason>", of which the reader is owed the reason.
		if (n.kind === 'followed') {
			row.appendChild(elt('p', null, tOr('feed.followed', '{who} let you follow them',
				{ who: n.text || nameFor(n.from) || tOr('post.someone', 'Someone new') })));
			return row;
		}
		if (n.kind === 'feedgone') {
			var said = String(n.text || '').split(' ').slice(1).join(' ');
			row.appendChild(elt('p', null, tOr('feed.gone',
				'A post of yours was removed: {reason}.',
				{ reason: said || tOr('feed.gone_why', 'the operator gave no reason') })));
			return row;
		}
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

	/// The box, with its audience named above the button and again on it. Null
	/// where there is nobody to write to AND nothing on the list, because the
	/// empty line above has already said what to do about that.
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
			// SAID ONCE. With no people and no messages the empty line above has
			// already said exactly this, and a box repeating it is the screen
			// arguing with itself (audit SOC-02).
			if (!list().length) return null;
			box.appendChild(peopleLine('post-nobody',
				tOr('post.nobody', 'Add somebody in {people}.')));
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
		pick.addEventListener('change', function () {
			sayAudience();
			// A reply answers ONE message from ONE person. Pointing the box
			// somewhere else makes it a new message, and the line above it must
			// stop claiming otherwise.
			if (_replyTo) {
				_replyTo = '';
				var head = document.getElementById('post-replying');
				if (head && head.parentNode) head.parentNode.removeChild(head);
			}
		});

		// WHAT THIS ANSWERS, in the box, because a reply that looks like a new
		// message is a reply somebody sends into the wrong conversation. With the
		// way out beside it: a box that could not stop being a reply would make
		// the control a trap.
		if (_replyTo) {
			var head = elt('div', 'post-replying');
			head.id = 'post-replying';
			head.appendChild(elt('p', 'post-quote', quoteText(_replyTo)));
			var drop = elt('button', 'post-btn post-unreply',
				tOr('post.reply_drop', 'Not a reply'));
			drop.type = 'button';
			drop.dataset.act = 'post-unreply';
			head.appendChild(drop);
			box.appendChild(head);
		}
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

	/// The message the box is ANSWERING, as its address, or ''. Held beside `_to`
	/// and cleared on the same occasions: a redraw keeps it, a send spends it, and
	/// choosing somebody else drops it.
	var _replyTo = '';

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
			// `replyTo` ONLY on the one-to-one path. A reply answers one person,
			// and a group send seals to a roster -- a `replyTo` there would name a
			// message most of the roster has never seen.
			var args = isGroup
				? { body: ta ? ta.value : '', group: whom.slice(2) }
				: { body: ta ? ta.value : '', to: whom, replyTo: _replyTo || '' };
			send(args).then(function (r) {
				if (!r.ok) { say(r.why + shortfall(r)); return; }
				if (ta) ta.value = '';
				// Spent. `send` has already redrawn once; this redraws the box
				// without the reply head, and `say` below reads the note element
				// that redraw just built.
				if (_replyTo) { _replyTo = ''; render(); }
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
		if (act === 'post-reply') {
			e.preventDefault();
			var msg = b.closest('.post-msg');
			if (!msg) return;
			_replyTo = String(msg.dataset.addr || '');
			to(msg.dataset.from || '');
			render();
			var box = document.getElementById('post-text');
			if (box) box.focus();
			return;
		}
		if (act === 'post-unreply') {
			e.preventDefault();
			_replyTo = '';
			render();
			return;
		}
		if (act === 'post-people') {
			e.preventDefault();
			try { if (window.DaimondSocial && DaimondSocial.show) DaimondSocial.show('people'); }
			catch (err) { /* no panel shell in this build */ }
			return;
		}
		// A FOLLOW REQUEST, answered. Approve and Block reach the relay; Ignore
		// reaches it in no way at all, which is the same rule the message tray's
		// Ignore keeps and for the same reason.
		if (act === 'post-follow-approve' || act === 'post-follow-ignore'
			|| act === 'post-follow-block') {
			e.preventDefault();
			var frow = b.closest('.post-follow');
			if (!frow) return;
			var fseq = frow.dataset.seq | 0;
			var fpub = String(frow.dataset.peer || '');
			if (act === 'post-follow-ignore') { hideFollow(fseq); return; }
			b.disabled = true;
			var done = function () { hideFollow(fseq); };
			if (act === 'post-follow-block') {
				// The messaging block, which the gateway also reads as "take this
				// pair out of both feed records" -- one block, not two, so a person
				// blocking somebody does not have to do it twice.
				connect(fpub, 'block').then(done, done);
			} else {
				follow(fpub, 'approve').then(done, done);
			}
			return;
		}
		if (!row) return;
		var peer = row.dataset.peer;
		if (act === 'post-share-add') {
			e.preventDefault();
			// NOT `say`. `say` is this module's own function, used by the send branch
			// six lines above, and a `var` of that name here hoists to the top of the
			// handler and shadows it with `undefined` for every branch -- so pressing
			// Send threw "say is not a function" and no message left the browser. A
			// `var` in a long delegated handler is function-scoped whatever line it
			// is written on.
			var line = row.querySelector('.post-share-say');
			b.disabled = true;
			if (line) {
				line.hidden = false;
				line.textContent = tOr('post.share_adding', 'Adding…');
			}
			addShare(row.dataset.addr).then(function (r) {
				b.disabled = false;
				// The row has gone by now where it landed, so the only sentence that
				// has anywhere to be drawn is a refusal.
				if (line && r && !r.ok) { line.textContent = r.why || ''; line.hidden = false; }
			});
			return;
		}
		if (act === 'post-share-ignore') { e.preventDefault(); hideShare(row.dataset.addr); return; }
		if (act === 'post-share-block') {
			e.preventDefault();
			// The row goes first and the relay is told second: blocking somebody is
			// about them, and a gift left drawn under a blocked name would be the
			// one thing the press did not do.
			hideShare(row.dataset.addr).then(function () { connect(peer, 'block'); });
			return;
		}
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
		/// The relay's own size door, published so the errand dispatch (peer.js) and
		/// share.js measure a sealed envelope against ONE cap and ONE arithmetic rather
		/// than each guessing. `fitsRelay(base64Len, max?)` mirrors the gateway's cheap
		/// pre-decode estimate exactly; `relayMaxBytes()` is the deployed `/api/post` cap.
		relayMaxBytes: relayMaxBytes,
		fitsRelay:     fitsRelay,
		// Locked individually as well as `round` is: daimond.js and peer.js call `collect`
		// and `ack` on their own, not only through `round`, and each is its own tab-crossing
		// critical section. `round` itself calls the raw functions above, not these wrapped
		// exports, so it takes the lock exactly once rather than deadlocking on itself --
		// and the work a collect claims runs after the lock, because a runner calls `settle`
		// and `ack` from inside its turn (E-R4).
		collect: collectLocked,
		ack:     function () { return withMailboxLock(ackThrough); },
		/// Free this device's own hold on a turn's errand once the turn is settled here, so
		/// the next ack drops it from the relay and no peer re-runs it. Under the same lock
		/// as `collect`/`ack`; the ack dep (daimond.js) calls it before `ack` on a done turn.
		settle:  function (turnId) { return withMailboxLock(function () { return settle(turnId); }); },
		round:   round,
		connect: connect,
		/// Ask to follow, answer somebody who asked, or let go. The same door
		/// `connect` takes, with the feed's four verbs on it.
		follow:  follow,
		/// THE RELAY'S DOOR, published so js/feed.js reaches the gateway through
		/// the same path, the same api header and the same deadline handling
		/// rather than a second copy of them. `call(method, body, query, timeoutMs)`
		/// answers `{ status, json }` and throws only where the request never went.
		call:    call,
		/// The doorbell: whether one email a day may say something is waiting.
		/// The read carries the REACH as well as the switch -- see above.
		doorbell:    doorbell,
		setDoorbell: setDoorbell,
		/// Parking, and whether it is still on. `off` names the reason it stopped;
		/// `no_park` means the front door dropped the query string.
		parkStart: parkStart,
		parkStop:  function () { parkStop(''); },
		parking:   function () { return { on: _parking, off: _parkOff, parks: _parks,
			fails: _parkFails, timeouts: _parkTimeouts, deadlineMs: PARK_DEADLINE_MS }; },
		/// How long to wait after `n` consecutive failed parks. Published for
		/// www/js/park.test.mjs, which has to prove the doubling without waiting it out.
		parkBackoff: parkBackoff,
		/// When this device last completed an errand-channel round (a park long-poll or a
		/// collect), epoch-ms, or 0. The genuine-servicing signal presence carries so a
		/// peer can tell a real runner from a background tab that only beats. `servicing`
		/// answers whether that was within `windowMs` (default 90 s) AND parking is on.
		servicedAt: function () { return _servicedAt; },
		servicing:  function (windowMs) {
			var w = windowMs || 90000;
			return _parking && _servicedAt > 0 && (Date.now() - _servicedAt) <= w;
		},
		/// The parcel's two halves, for sync.js. `snapshot` answers null while the
		/// identity is locked, and the caller must leave the section OFF when it
		/// does -- an empty record reads to the other device as a deletion.
		snapshot: snapshot,
		adopt:    adopt,
		/// The same two halves, but with the message tail offloaded to content chunks
		/// under a byte budget and hydrated back on the way in -- the treatment the
		/// chat transcripts get, for the section that would otherwise 413 a heavy
		/// account's parcel. sync.js prefers these and falls back to the pair above on
		/// a build without them; see the offload note beside `snapshotRefs`.
		snapshotRefs: snapshotRefs,
		adoptRefs:    adoptRefs,
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
		/// The feed half of the record, for js/feed.js, which holds no storage of
		/// its own either. `feedState` answers a COPY; the other four write and
		/// save. No post body is ever kept -- see the section's own header.
		feedState:  feedState,
		feedSince:  feedSince,
		feedSaw:    feedSaw,
		feedDrawn:  feedDrawn,
		feedUnread: feedUnread,
		/// The follow requests waiting in the tray, and the local-only Ignore.
		follows:    follows,
		hideFollow: hideFollow,
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
			var work = [];
			var r = await takeRow(st, row, work);
			await save();
			render();
			announce(r.got, r.got ? [String(row.addr)] : []);
			// THE WORK IT STARTED, RUN TO THE END. No lock is held here, and a door a
			// suite drives is no use if it answers before what it started has happened. A
			// row whose work is over has been let go, and answers as one never held.
			var held = await startWork(work);
			if (held.length && !held.some(Boolean)) return NOTHING;
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
		/// The message the box is answering, as its address, or ''. Published for
		/// a verifier: a Reply that set the wrong parent would still look right on
		/// the screen.
		replyTo:  function () { return _replyTo; },
		/// The one line a reply draws of what it answers, including the wording
		/// for a parent this device no longer holds. Published so a verifier reads
		/// the same sentence the row does rather than a second copy of it.
		quoteText: quoteText,
		/// One line with the word People in it, drawn as the chip it goes to.
		/// group.js draws its own empty line through this, so the sentence and the
		/// press exist once.
		peopleLine: peopleLine,
		/// The event this module raises when messages land: `daimond:post-arrived`,
		/// carrying `{ count, unread, addrs }`.
		arrivedEvent: ARRIVED,
		/// What is held, for a panel and for a verifier.
		list:     list,
		tray:     tray,
		notices:  notices,
		unread:   unread,
		hide:     hide,
		/// The diamonds waiting in the tray, and the three things a person can do
		/// with one. `addShare` is the ONLY door that lands one: `takeRow` keeps the
		/// envelope and nothing else happens until somebody presses Add.
		shares:     shares,
		addShare:   addShare,
		hideShare:  hideShare,
		/// The sender's own Sent row for a diamond they gave away. share.js calls it
		/// after `fanout` answered, so a Sent list never shows one that did not
		/// leave.
		noteShareSent: noteShareSent,
		/// Everything this module would say if asked.
		state:    function () {
			return {
				read:    !!_st,
				through: _st ? _st.through : 0,
				acked:   _st ? _st.acked : 0,
				solo:    !syncReady(),
				park:    { on: _parking, off: _parkOff, parks: _parks,
					fails: _parkFails, timeouts: _parkTimeouts },
				unread:  unread(),
			};
		},
		/// Drop what is in memory, for an account switch, a lock, or a verifier
		/// that wants the store read again from disk.
		forget:   forget,
	};
})();
