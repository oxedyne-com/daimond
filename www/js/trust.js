/* ============================================================
   Daimond — first contact (trust.js)
   ------------------------------------------------------------
   How two people establish that they hold each other's real keys,
   with NO SERVER IN THE PATH AT ALL. Everything in this file runs
   between two devices in a room, or between two devices and a
   voice call. The gateway is not consulted, and cannot be: it is
   not a party to any of it.

   ── THE RULE EVERYTHING ELSE HANGS ON ───────────────────────

   A KEY THE GATEWAY HANDED YOU IS AN UNMATCHED KEY, FOR EVER,
   UNTIL A HUMAN DOES SOMETHING OUT OF BAND.

   A handle lookup is an asynchronous channel with an intermediary
   in it, and such a channel's ceiling is "unmatched": a
   man-in-the-middle substitutes its own key and re-signs
   everything cleanly under it, so a card that verifies perfectly
   proves the holder of that key composed it and NOTHING about who
   the holder is. Treating a lookup as sufficient would make the
   seal decorative. So there are exactly two ways up, both of them
   acts a person performs:

     * a card read off a screen by this device's own camera, in
       person, where there is no channel to poison; and
     * a safety number read aloud over a channel an attacker
       cannot silently rewrite.

   A card that arrives by a link, a paste or a lookup is recorded
   and is never offered the first of those. It cannot be: nothing
   about a pasted string says the two people were in a room.

   ── TWO AXES, AND THEY MUST NEVER SHARE A BADGE OR A WORD ───

   Key authenticity — *is this key the one held by the person I
   think?* — and human reputation — *is this a real, unique person,
   and what is their standing?* — are orthogonal, and all four
   combinations occur. A single scale that mixes them is a lie in
   two directions at once, and the dangerous direction is the one
   where a high reputation makes an unmatched key look safe.

   So, and this file exists to hold the line:

     * The word about a KEY is **matched** or **new**. Never
       "verified", never "trusted", in any surface, any locale,
       any tooltip. "Verified" belongs to personhood and is
       somebody else's claim; "trusted" is worse still, because it
       also collides with a tools-permission scope, which is a
       third thing again.
     * The key state is drawn as a LINE UNDER THE NAME, never as a
       badge beside it. Different POSITION, not merely different
       colour: a line under a name and a badge beside it cannot
       merge in a glance, and two badges side by side will.
     * The key line is ALWAYS present. A personhood badge, when
       there is ever one to draw, is present only when there is a
       bound claim — so its absence is unremarkable and its
       presence is not a prerequisite for anything.

   `drawKeyLine` is the only place a key state reaches a screen,
   and it refuses a string carrying either forbidden word rather
   than drawing it. A rule kept by discipline is a rule that ships
   broken in the seventh locale.

   ── WHAT IS STORED ──────────────────────────────────────────

   An append-only `trust.log` in this account's own storage, hash
   chained so that a truncation or an edit is detectable rather
   than merely discouraged. Three kinds of entry:

     card   a signed IdentityCard somebody handed us. Verified by
            the format's own crate on the way in AND on every
            replay; a card is a claim by its key and nothing more.
     edge   a signed TrustEdge — `{from, to, scope, method,
            created, nonce, sig}` — which is the record of the act
            a person performed. Scope is always IDENTITY. There is
            no TOOLS arm and there must never be one: nothing is
            installable from a message, so the escalation that
            scope exists to fence does not arise here.
     block  a key this account will not hear from. An appended
            fact, not a deletion, because the log only ever grows.

   The People list is a REPLAYABLE PROJECTION of that log and
   holds no state of its own. Every signature is checked on the
   replay, so a log whose edge has been tampered with projects the
   person back to "new" rather than quietly keeping a state it can
   no longer justify.

   ── ROTATION IS A CLAIM, NEVER A TRANSFER ───────────────────

   A card may name the key it supersedes. That links the two into
   one chain, and it does NOT carry a match across: the commonest
   reason to rotate is that the old key leaked, and a certificate
   signed by the old key is exactly what the leaker can also
   produce. So a chain whose older key was matched and whose
   current key was not is drawn loudly, and messages are held.
   ============================================================ */
(function () {
	'use strict';

	// ── What a person reads ────────────────────────────────────

	/// A string from the table, or the English written here where the table has
	/// no entry for it yet, so a sentence added before its translation reads as a
	/// sentence and not as a key. The same device identity.js uses.
	function t(k, v) { return window.DaimondI18n ? window.DaimondI18n.t(k, v) : k; }
	function tOr(key, fallback, vars) {
		var s = t(key, vars);
		if (s !== key) return s;
		if (!vars) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (m, n) {
			return (vars[n] === undefined) ? m : String(vars[n]);
		});
	}

	/// The words a key state may never carry, per language.
	///
	/// English first, because that is the fallback every locale falls back to and
	/// the one a hurried edit is written in. The others are the renderings of
	/// "verified" and "trusted" a translator would most naturally reach for; the
	/// list is a NET, not a proof, and the property the verifier really leans on
	/// is the geometric one — the line is under the name, so it cannot merge with
	/// a badge whatever it says.
	var FORBIDDEN = {
		en: ['verified', 'unverified', 'trusted', 'untrusted', 'verify', 'trust'],
		de: ['verifiziert', 'vertrauenswürdig', 'vertraut', 'bestätigt'],
		es: ['verificado', 'verificada', 'confianza', 'confiable'],
		fr: ['vérifié', 'vérifiée', 'confiance', 'certifié'],
		ja: ['認証済', '検証済', '信頼'],
		ko: ['인증됨', '검증됨', '신뢰'],
		pt: ['verificado', 'verificada', 'confiável', 'confiança'],
		zh: ['已验证', '已認證', '已认证', '可信', '信任'],
	};

	/// Whether a rendered key-state string carries a word from the other axis.
	function saysTheWrongThing(s) {
		var loc = '';
		try { loc = (window.DaimondI18n && window.DaimondI18n.locale && window.DaimondI18n.locale()) || ''; }
		catch (e) { loc = ''; }
		var lists = [FORBIDDEN.en];
		var head = String(loc || '').slice(0, 2).toLowerCase();
		if (FORBIDDEN[head] && head !== 'en') lists.push(FORBIDDEN[head]);
		var low = String(s).toLowerCase();
		for (var i = 0; i < lists.length; i++) {
			for (var j = 0; j < lists[i].length; j++) {
				if (low.indexOf(lists[i][j]) >= 0) return lists[i][j];
			}
		}
		return '';
	}

	// ── Encoding ───────────────────────────────────────────────

	function utf8(s) { return new TextEncoder().encode(String(s)); }

	function b64enc(buf) {
		var b = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
		var s = '';
		for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return btoa(s);
	}

	function b64dec(str) {
		var bin = atob(String(str));
		var out = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	function b64url(b64) { return String(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

	function unb64url(s) {
		var v = String(s).replace(/-/g, '+').replace(/_/g, '/');
		while (v.length % 4) v += '=';
		return v;
	}

	function hex(bytes) {
		var s = '';
		for (var i = 0; i < bytes.length; i++) s += (bytes[i] + 256).toString(16).slice(1);
		return s;
	}

	function unhex(s) {
		var v = String(s || '');
		var out = new Uint8Array(v.length >> 1);
		for (var i = 0; i < out.length; i++) out[i] = parseInt(v.substr(i * 2, 2), 16);
		return out;
	}

	function bytesEqual(a, b) {
		if (!a || !b || a.length !== b.length) return false;
		var diff = 0;
		for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
		return diff === 0;
	}

	// ── The bridge ─────────────────────────────────────────────

	/// The identity format's entry points, or null when the wasm module has not
	/// brought them up. Nothing here computes a fingerprint, a safety number or a
	/// card address itself: there is one implementation of each, in the crate
	/// that owns the format, and a second written in JavaScript is how two
	/// devices come to draw the same key differently.
	function bridge() {
		return (typeof window !== 'undefined' && window.DaimondCrypto) || null;
	}

	/// A verified card out of a whole artefact, or null. The WHOLE verification —
	/// magic, envelope, tree length, address, signature — runs in the crate; what
	/// comes back has passed every part of it.
	function readCard(bytes) {
		var b = bridge();
		if (!b || typeof b.read !== 'function') return null;
		var got;
		try { got = JSON.parse(b.read(bytes)); }
		catch (e) { return null; }
		if (!got || got.kind !== 'card' || got.schema !== 'daimond/card/0') return null;
		if (!got.author || !got.card || !got.card.enc) return null;
		return {
			key:   got.author,					// hex, 32 bytes: the signing key, and the identity
			fp:    got.fingerprint || '',
			label: String(got.card.label || ''),
			enc:   got.card.enc,
			prev:  got.card.prev || '',
			time:  Number(got.time) || 0,
			addr:  got.address || '',
		};
	}

	// ── The transports ─────────────────────────────────────────
	//
	// One artefact, three ways of carrying it, and the way it arrived is what
	// decides the ceiling — see `ROUTE` below. The bytes are identical in all
	// three; the difference is entirely about what the ROUTE proves, which is
	// why the route travels with the card rather than being inferred later.

	var PASTE_PREFIX = 'DMND-ID1.';
	/// The fragment a card rides in a URL. A fragment never reaches a server by
	/// construction, which is the whole reason it is one.
	var HASH_KEY = 'c';

	/// Where a card came from, and therefore how high it may go.
	///
	/// `qr` is this device's own camera reading a screen in the room. Nothing
	/// else is: a `DMND-ID1.` string in a chat window looks exactly the same
	/// whether a friend or an intermediary put it there.
	var ROUTE = { QR: 'qr', LINK: 'link', PASTE: 'paste', LOOKUP: 'lookup' };

	/// This identity's card as the string that is pasted.
	function cardText() {
		var c = window.DaimondIdentity && window.DaimondIdentity.card();
		return c ? (PASTE_PREFIX + b64url(c)) : '';
	}

	/// This identity's card as the URL a camera opens.
	function cardUrl() {
		var c = window.DaimondIdentity && window.DaimondIdentity.card();
		return c ? (location.origin + location.pathname + '#' + HASH_KEY + '=' + b64url(c)) : '';
	}

	/// Read a card out of whatever was handed over: the paste form, the URL
	/// form, or the bare base64url in either encoding. Answers the verified card
	/// with its raw bytes, or null.
	function parse(text) {
		var s = String(text || '').trim();
		if (!s) return null;
		var m = /[#&]c=([A-Za-z0-9_\-=+/]+)/.exec(s);
		if (m) s = m[1];
		else if (s.slice(0, PASTE_PREFIX.length).toUpperCase() === PASTE_PREFIX) {
			s = s.slice(PASTE_PREFIX.length);
		}
		s = s.replace(/\s+/g, '');
		var bytes;
		try { bytes = b64dec(unb64url(s)); }
		catch (e) { return null; }
		if (!bytes.length) return null;
		var card = readCard(bytes);
		if (!card) return null;
		card.bytes = bytes;
		return card;
	}

	// ── The log ────────────────────────────────────────────────

	/// This account's trust log. Namespaced per account by accounts.js, which
	/// shims localStorage, so nothing here has to know about accounts at all.
	var LOG_KEY = 'daimond-trust-log';

	/// Every scope a TrustEdge may carry. One, deliberately. Messaging writes
	/// IDENTITY and never TOOLS: no tool is installable from a message, so the
	/// escalation the second scope exists to fence does not arise, and neither
	/// does the expiry that goes with it. Two states, not four.
	var SCOPE_IDENTITY = 'identity';

	/// How a key was matched. Both arms are statements about an act the user
	/// performed on a KEY; neither could ever be read as a claim about a person.
	var METHOD = { QR: 'in_person_qr', NUMBER: 'safety_number' };

	function readLog() {
		var raw = null;
		try { raw = localStorage.getItem(LOG_KEY); } catch (e) { raw = null; }
		if (!raw) return [];
		var v = null;
		try { v = JSON.parse(raw); } catch (e) { v = null; }
		return Array.isArray(v) ? v : [];
	}

	function writeLog(entries) {
		try { localStorage.setItem(LOG_KEY, JSON.stringify(entries)); return true; }
		catch (e) { return false; }
	}

	/// The canonical bytes of a log entry, for the hash chain.
	///
	/// Every variable-length field is length-prefixed, so no two different
	/// entries can produce the same bytes by running one field's tail into the
	/// next one's head. The chain hash of the entry before it goes in first,
	/// which is what makes the chain a chain.
	function entryBytes(prevHash, e) {
		var parts = [];
		var push = function (bytes) {
			var n = bytes.length;
			parts.push(new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]));
			parts.push(bytes);
		};
		push(utf8('daimond-trust-log-v1'));
		push(unhex(prevHash || ''));
		push(utf8(String(e.k || '')));
		push(u64be(Number(e.t) || 0));
		// Whatever else the entry carries, in a fixed field order per kind, so
		// the bytes are a function of the entry and not of key insertion order.
		if (e.k === 'card') {
			push(utf8(String(e.a || '')));
			push(utf8(String(e.route || '')));
		} else if (e.k === 'edge') {
			push(utf8(String(e.from || '')));
			push(utf8(String(e.to || '')));
			push(utf8(String(e.scope || '')));
			push(utf8(String(e.method || '')));
			push(u64be(Number(e.created) || 0));
			push(utf8(String(e.nonce || '')));
			push(utf8(String(e.sig || '')));
		} else if (e.k === 'block') {
			push(utf8(String(e.key || '')));
			push(utf8(e.on ? '1' : '0'));
		}
		var total = 0, i;
		for (i = 0; i < parts.length; i++) total += parts[i].length;
		var out = new Uint8Array(total);
		var at = 0;
		for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
		return out;
	}

	/// Eight big-endian bytes of a millisecond stamp. Split rather than taken
	/// through a BigInt: a `u64` crossing into JavaScript is a `BigInt` every
	/// caller then has to build, and a millisecond is nowhere near 2^53 anyway.
	function u64be(ms) {
		var hi = Math.floor(ms / 4294967296);
		var lo = ms >>> 0;
		return new Uint8Array([
			(hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
			(lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255,
		]);
	}

	async function sha256hex(bytes) {
		var d = await crypto.subtle.digest('SHA-256', bytes);
		return hex(new Uint8Array(d));
	}

	/// Append one entry, chaining it to the one before. The log only ever grows:
	/// this is the single writer, and it appends.
	async function append(entry) {
		var log = readLog();
		var prev = log.length ? String(log[log.length - 1].h || '') : '';
		entry.t = entry.t || Date.now();
		entry.h = await sha256hex(entryBytes(prev, entry));
		log.push(entry);
		if (!writeLog(log)) return null;
		projection = null;					// the replay is stale now
		return entry;
	}

	/// Where the chain first breaks, or -1 when it does not.
	///
	/// A tampered or truncated log is not a log that quietly reads a little
	/// differently: it is one whose every later entry fails to hash, so the break
	/// has a position and the position is reported rather than the whole thing
	/// being thrown away.
	async function chainBreak() {
		var log = readLog();
		var prev = '';
		for (var i = 0; i < log.length; i++) {
			var e = log[i];
			var want = await sha256hex(entryBytes(prev, e));
			if (want !== String(e.h || '')) return i;
			prev = want;
		}
		return -1;
	}

	// ── The signed TrustEdge ───────────────────────────────────

	/// The bytes a TrustEdge is signed over.
	///
	/// Domain-separated and wholly length-prefixed. This is a LOCAL canonical
	/// form: an edge is a record of what this device's owner did, it is read back
	/// by this device, and Phase 3 sends it nowhere. When there is a
	/// `daimond/trust/0` SBJ schema in the format's own crate this should move
	/// there and be the crate's canonical encoding, exactly as the card is —
	/// see the report accompanying this file.
	function edgeInput(edge) {
		var parts = [];
		var push = function (bytes) {
			var n = bytes.length;
			parts.push(new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]));
			parts.push(bytes);
		};
		push(utf8('daimond-trust-edge-v1'));
		push(unhex(edge.from));
		push(unhex(edge.to));
		push(utf8(edge.scope));
		push(utf8(edge.method));
		push(u64be(Number(edge.created) || 0));
		push(b64dec(edge.nonce));
		var total = 0, i;
		for (i = 0; i < parts.length; i++) total += parts[i].length;
		var out = new Uint8Array(total);
		var at = 0;
		for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
		return out;
	}

	/// Verify an Ed25519 signature under a raw public key.
	///
	/// Here rather than in identity.js because identity.js has no such call: its
	/// `verify` takes a passphrase and answers whether the wrapping key derives,
	/// which is a different question entirely. A public-key signature check needs
	/// no unlock and no secret, so it is safe to do from anywhere — but it is
	/// generic, and it should be lifted into identity.js beside `sign`.
	async function verifySig(pubHex, sigB64, data) {
		try {
			var key = await crypto.subtle.importKey('raw', unhex(pubHex), { name: 'Ed25519' }, false, ['verify']);
			return await crypto.subtle.verify({ name: 'Ed25519' }, key, b64dec(sigB64), data);
		} catch (e) {
			return false;
		}
	}

	/// The out-of-band act, recorded. `to` is the correspondent's full 32-byte
	/// signing key as hex; `method` is one of METHOD.
	///
	/// Signed by this device, so the log is not merely a note this device wrote
	/// to itself: it is a statement this key made, and a log copied to another of
	/// this account's devices carries its own proof.
	async function markMatched(toHex, method) {
		if (method !== METHOD.QR && method !== METHOD.NUMBER) return null;
		var id = window.DaimondIdentity;
		if (!id || !id.isUnlocked()) return null;
		var pub = await id.publicKeyRaw();
		if (!pub) return null;
		var nonce = new Uint8Array(16);
		crypto.getRandomValues(nonce);
		var edge = {
			k:       'edge',
			from:    hex(pub),
			to:      String(toHex || '').toLowerCase(),
			scope:   SCOPE_IDENTITY,
			method:  method,
			created: Date.now(),
			nonce:   b64enc(nonce),
		};
		if (edge.to.length !== 64) return null;
		if (edge.to === edge.from) return null;			// an account does not match itself
		edge.sig = await id.sign(edgeInput(edge));
		return await append(edge);
	}

	/// Note a card. THIS IS NOT A MATCH and nothing about it raises anything:
	/// it records that this key, with this label and this sealing subkey, was
	/// handed over by this route at this moment.
	async function record(card, route) {
		if (!card || !card.bytes) return null;
		return await append({ k: 'card', a: b64enc(card.bytes), route: route || ROUTE.PASTE });
	}

	/// Stop hearing from a key, or start again. An appended fact: the log does
	/// not delete, so a block and its later removal are both in the record.
	async function setBlocked(keyHex, on) {
		return await append({ k: 'block', key: String(keyHex || '').toLowerCase(), on: !!on });
	}

	// ── The projection ─────────────────────────────────────────
	//
	// The People list is a replay of the log and holds nothing of its own. Every
	// signature is checked HERE, on every replay — the card by the format's own
	// crate, the edge by WebCrypto — so a log whose edge has been edited projects
	// the person back to "new" rather than keeping a state it can no longer
	// justify. An assertion that merely read `edge.method` would pass on a log
	// with the signature bytes scribbled out.

	var projection = null;

	/// Fold a label to what a confusable-blind eye sees.
	///
	/// Compatibility decomposition, combining marks removed, case folded, the
	/// handful of shapes that carry across scripts mapped to one, and everything
	/// that is not a letter or a digit dropped. It only ever raises a WARNING:
	/// two people are allowed to be called Ada, and a normalisation that blocked
	/// would be a normalisation that decided who may exist.
	var CONFUSABLE = {
		'0': 'o', '1': 'l', 'i': 'l', '5': 's', '2': 'z', '8': 'b', '6': 'g',
		'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
		'у': 'y', 'х': 'x', 'і': 'l', 'ѕ': 's',
		'ο': 'o', 'α': 'a', 'ε': 'e', 'ρ': 'p', 'ν': 'v',
	};

	function fold(label) {
		var s = String(label || '');
		try { s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (e) { /* no ICU */ }
		s = s.toLowerCase();
		var out = '';
		for (var i = 0; i < s.length; i++) {
			var c = s[i];
			if (CONFUSABLE[c]) c = CONFUSABLE[c];
			if (/[a-z0-9]/.test(c)) out += c;
		}
		// Two shapes that are pairs of letters rather than single ones.
		out = out.replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
		return out;
	}

	/// Replay the log into people. Cached, and thrown away by every append.
	async function people() {
		if (projection) return projection;
		var log = readLog();
		var mine = '';
		try {
			var pub = await (window.DaimondIdentity ? window.DaimondIdentity.publicKeyRaw() : null);
			if (pub) mine = hex(pub);
		} catch (e) { mine = ''; }

		var cards = {};			// key hex -> the latest verified card for that key
		var edges = {};			// key hex -> the verified edge that matched it
		var blocks = {};		// key hex -> whether the latest block entry is on
		var i;

		for (i = 0; i < log.length; i++) {
			var e = log[i];
			if (!e || typeof e !== 'object') continue;
			if (e.k === 'card') {
				// Verified AGAIN, on the replay. A card sitting in storage is a
				// file an attacker with the disk can edit, and one whose signature
				// no longer checks is not a weaker claim, it is no claim.
				var bytes;
				try { bytes = b64dec(String(e.a || '')); } catch (err) { continue; }
				var c = readCard(bytes);
				if (!c) continue;
				var held = cards[c.key];
				if (!held || c.time >= held.time) {
					c.route = e.route || ROUTE.PASTE;
					c.seen  = e.t || 0;
					c.first = held ? held.first : (e.t || 0);
					cards[c.key] = c;
				}
			} else if (e.k === 'edge') {
				if (e.scope !== SCOPE_IDENTITY) continue;		// no other scope exists
				if (mine && String(e.from).toLowerCase() !== mine) continue;	// not this account's act
				var okSig = await verifySig(e.from, e.sig, edgeInput(e));
				if (!okSig) continue;
				var to = String(e.to).toLowerCase();
				if (!edges[to] || (e.created || 0) > (edges[to].created || 0)) {
					edges[to] = { method: e.method, created: e.created || e.t || 0 };
				}
			} else if (e.k === 'block') {
				blocks[String(e.key).toLowerCase()] = !!e.on;
			}
		}

		// Chains. A card may name the key it supersedes, which links the two into
		// one person; the chain's root is the oldest key we hold a link back to.
		var parent = {};
		var k;
		for (k in cards) {
			if (!Object.prototype.hasOwnProperty.call(cards, k)) continue;
			var prev = String(cards[k].prev || '').toLowerCase();
			if (prev && cards[prev]) parent[k] = prev;
		}
		var rootOf = function (key) {
			var seen = {};
			var at = key;
			while (parent[at] && !seen[at]) { seen[at] = 1; at = parent[at]; }
			return at;
		};

		var groups = {};
		for (k in cards) {
			if (!Object.prototype.hasOwnProperty.call(cards, k)) continue;
			var r = rootOf(k);
			(groups[r] = groups[r] || []).push(cards[k]);
		}

		var out = [];
		for (var g in groups) {
			if (!Object.prototype.hasOwnProperty.call(groups, g)) continue;
			var chain = groups[g].slice().sort(function (a, b) { return a.time - b.time; });
			var current = chain[chain.length - 1];
			var edge = edges[current.key] || null;
			// A match on an OLDER key does not carry across, and this is the whole
			// of 12.4.5: rotation is a claim, and a certificate signed by the old
			// key is exactly what somebody who stole the old key can also produce.
			var older = null;
			for (i = 0; i < chain.length - 1; i++) {
				if (edges[chain[i].key]) older = { key: chain[i].key, at: edges[chain[i].key] };
			}
			var state = 'new';
			if (blocks[current.key]) state = 'blocked';
			else if (edge) state = 'matched';
			else if (older) state = 'changed';
			out.push({
				key:     current.key,
				fp:      current.fp,
				label:   current.label,
				enc:     current.enc,
				route:   current.route,
				first:   current.first || current.seen,
				seen:    current.seen,
				chain:   chain.map(function (c) { return c.key; }),
				state:   state,
				method:  edge ? edge.method : '',
				matchedAt: edge ? edge.created : 0,
				prevKey: older ? older.key : '',
				prevAt:  older ? older.at.created : 0,
				warn:    '',
				warnFp:  '',
			});
		}

		// Look-alikes, once every person is known: an unmatched label that folds
		// onto a matched one is the shape of an impersonation, and it is a warning
		// on the row and never an automatic block.
		var byFold = {};
		for (i = 0; i < out.length; i++) {
			if (out[i].state !== 'matched') continue;
			(byFold[fold(out[i].label)] = byFold[fold(out[i].label)] || []).push(out[i]);
		}
		for (i = 0; i < out.length; i++) {
			if (out[i].state === 'matched') continue;
			var twins = byFold[fold(out[i].label)];
			if (!twins || !twins.length) continue;
			if (twins.length === 1 && twins[0].key === out[i].key) continue;
			out[i].warn = 'lookalike';
			out[i].warnFp = twins[0].fp;
		}

		out.sort(function (a, b) { return (b.seen || 0) - (a.seen || 0); });
		projection = out;
		return out;
	}

	/// One person by their current key, or null.
	async function person(keyHex) {
		var all = await people();
		var want = String(keyHex || '').toLowerCase();
		for (var i = 0; i < all.length; i++) {
			if (all[i].key === want) return all[i];
			if (all[i].chain.indexOf(want) >= 0) return all[i];
		}
		return null;
	}

	// ── The safety number ──────────────────────────────────────

	/// The number this account and one correspondent read to each other.
	///
	/// The WHOLE 256-bit digest, sixty decimal digits in twelve groups of five,
	/// computed by the format's own crate over both keys sorted — so both parties
	/// get the same number without having to agree who is first. Not truncated,
	/// and the reason is not aesthetic: the attack is a meet-in-the-middle costing
	/// about 2^(n/2), so a number cut to 120 bits would face a 60-bit search.
	async function safetyNumber(otherKeyHex) {
		var b = bridge();
		var id = window.DaimondIdentity;
		if (!b || typeof b.safetyNumber !== 'function' || !id) return '';
		var mine = await id.publicKeyRaw();
		if (!mine) return '';
		var theirs = unhex(String(otherKeyHex || '').toLowerCase());
		if (theirs.length !== 32) return '';
		try { return b.safetyNumber(mine, theirs); }
		catch (e) { return ''; }
	}

	// ── Drawing a key state, and the only place it happens ─────

	/// The sentence for a person's key state.
	function keyWords(p) {
		var when = p.matchedAt ? shortDate(p.matchedAt) : '';
		if (p.state === 'blocked') return tOr('trust.key_blocked', 'Blocked key');
		if (p.state === 'matched') {
			return (p.method === METHOD.QR)
				? tOr('trust.key_matched_qr', 'Key matched in person, {when}', { when: when })
				: tOr('trust.key_matched_number', 'Key matched by safety number, {when}', { when: when });
		}
		if (p.state === 'changed') {
			return tOr('trust.key_changed',
				'Different key — the one you matched was last seen {when}',
				{ when: shortDate(p.prevAt) });
		}
		return tOr('trust.key_new', 'New key — you have not matched this one');
	}

	/// Draw a person's key state UNDER their name. The only route a key state
	/// takes to a screen.
	///
	/// A LINE, not a badge, and the element is a block so it cannot end up beside
	/// anything. If a table hands back a string carrying the other axis's word —
	/// in any locale — the English is drawn instead and the fault is said out
	/// loud, because a wrong word here is precisely the failure the two-axis rule
	/// exists to prevent, and it is the kind nobody notices.
	function drawKeyLine(p) {
		var words = keyWords(p);
		var wrong = saysTheWrongThing(words);
		if (wrong) {
			try {
				console.warn('Daimond: a key-state string carried the word "' + wrong
					+ '", which belongs to the personhood axis and never to a key. '
					+ 'The English is drawn instead. Fix the locale table.');
			} catch (e) { /* no console */ }
			words = ({
				blocked: 'Blocked key',
				matched: 'Key matched',
				changed: 'Different key from the one you matched',
			})[p.state] || 'New key — you have not matched this one';
		}
		var line = document.createElement('div');
		line.className = 'trust-keyline trust-key-' + p.state;
		line.setAttribute('data-key-state', p.state);
		line.textContent = words;
		return line;
	}

	function shortDate(ms) {
		if (!ms) return '';
		var loc = 'en';
		try { loc = (window.DaimondI18n && window.DaimondI18n.locale && window.DaimondI18n.locale()) || 'en'; }
		catch (e) { loc = 'en'; }
		try { return new Date(ms).toLocaleDateString(loc, { day: 'numeric', month: 'long' }); }
		catch (e) { return new Date(ms).toDateString(); }
	}

	// ── The scanner, loaded when it is wanted ──────────────────

	var scannerLoading = null;

	/// Bring up the QR reader. Loaded on demand rather than at boot: it is forty
	/// kilobytes that only a person opening the scanner ever needs, and the boot
	/// has enough to do.
	function scanner() {
		if (window.DaimondQRScan) return Promise.resolve(window.DaimondQRScan);
		if (scannerLoading) return scannerLoading;
		scannerLoading = new Promise(function (done) {
			var s = document.createElement('script');
			s.src = 'js/qrscan.js';
			s.onload = function () { done(window.DaimondQRScan || null); };
			s.onerror = function () { done(null); };
			document.head.appendChild(s);
		});
		return scannerLoading;
	}

	// ── The surfaces ───────────────────────────────────────────

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	/// The dialog frame, borrowed from pairing.js rather than written twice.
	///
	/// Said out loud when it is not there, because a dialog that silently never
	/// opens is a feature that looks absent rather than broken, and this file's
	/// every surface goes through it.
	function overlay(build) {
		injectStyles();
		if (window.DaimondPairing && window.DaimondPairing.ui && window.DaimondPairing.ui.overlay) {
			return window.DaimondPairing.ui.overlay(build);
		}
		try {
			console.warn('Daimond: js/pairing.js is not loaded, so the People surfaces have no '
				+ 'dialog frame to open in. Load it before js/trust.js.');
		} catch (e) { /* no console */ }
		return null;
	}

	function qrCanvas(text) {
		if (window.DaimondPairing && window.DaimondPairing.ui && window.DaimondPairing.ui.qrCanvas) {
			return window.DaimondPairing.ui.qrCanvas(text);
		}
		return null;
	}

	function injectStyles() {
		if (document.getElementById('trust-styles')) return;
		var s = document.createElement('style');
		s.id = 'trust-styles';
		s.textContent =
			'.trust-row{padding:10px 0;border-bottom:1px solid var(--border,#333)}' +
			'.trust-row:last-child{border-bottom:0}' +
			// The name, and then the key line UNDER it. `display:block` on the line
			// is doing real work: it is what makes the two impossible to draw side
			// by side, whatever a later stylesheet does to the colours.
			'.trust-name{display:block;font-size:var(--fs-base);font-weight:600}' +
			'.trust-claim{display:block;font-size:var(--fs-base);opacity:.9}' +
			'.trust-keyline{display:block;font-size:var(--fs-sm);opacity:.85;margin:2px 0 0}' +
			'.trust-key-matched{color:var(--ok,#5b8)}' +
			'.trust-key-new{opacity:.7}' +
			'.trust-key-changed{color:var(--danger)}' +
			'.trust-key-blocked{color:var(--danger)}' +
			'.trust-fp{display:block;font-family:ui-monospace,monospace;font-size:var(--fs-xs);' +
			'opacity:.7;letter-spacing:.04em;margin:2px 0 0}' +
			'.trust-warn{display:block;font-size:var(--fs-sm);color:var(--danger);margin:4px 0 0}' +
			'.trust-acts{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0}' +
			'.trust-list{max-height:52vh;overflow:auto;margin:0 0 12px}' +
			// Sixty digits in twelve groups of five, three to a row. Monospace and
			// generously spaced because the whole point is reading it aloud to
			// somebody without losing your place.
			'.trust-number{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 10px;' +
			'font-family:ui-monospace,monospace;font-size:var(--fs-xl);text-align:center;' +
			'padding:12px;border:1px dashed var(--border,#444);border-radius:8px;margin:0 0 12px;' +
			'user-select:all}' +
			'.trust-empty{opacity:.7;font-size:var(--fs-base);margin:0 0 12px}' +
			'.trust-scan{display:block;width:100%;max-width:320px;margin:0 auto 12px;border-radius:8px;' +
			'background:#000}';
		document.head.appendChild(s);
	}

	/// One row of the People list. The order is deliberate and it is the
	/// 2026-07-16 design's: what is known about the KEY comes before what the
	/// card CLAIMS about the person, and the fingerprint is on the row rather
	/// than behind a tap.
	function personRow(p, onChange) {
		var row = el('div', 'trust-row');
		// The label is advisory. On a key nobody has matched it is drawn as the
		// claim it is; on one that has been matched in person or by number, the
		// person on the other end is known and the name may be their name.
		var name = (p.state === 'matched')
			? el('div', 'trust-name', p.label || tOr('trust.no_name', '(no name given)'))
			: el('div', 'trust-claim', tOr('trust.calls_themselves', 'calls themselves “{name}”',
				{ name: p.label || '—' }));
		row.appendChild(name);
		row.appendChild(drawKeyLine(p));
		row.appendChild(el('div', 'trust-fp', p.fp));
		if (p.warn === 'lookalike') {
			row.appendChild(el('div', 'trust-warn',
				tOr('trust.lookalike',
					'This name looks like one you have already matched ({fp}). Names are not identities — check the key.',
					{ fp: p.warnFp })));
		}
		if (p.state === 'changed') {
			row.appendChild(el('div', 'trust-warn',
				tOr('trust.held', 'Messages from this key are held until you decide.')));
		}
		var acts = el('div', 'trust-acts');
		if (p.state !== 'blocked') {
			var num = el('button', 'pair-btn ghost', tOr('trust.compare_numbers', 'Compare safety numbers'));
			num.addEventListener('click', function () { showSafety(p.key, onChange); });
			acts.appendChild(num);
		}
		var blk = el('button', 'pair-btn ghost',
			p.state === 'blocked' ? tOr('trust.unblock', 'Unblock') : tOr('trust.block', 'Block'));
		blk.addEventListener('click', function () {
			setBlocked(p.key, p.state !== 'blocked').then(function () { if (onChange) onChange(); });
		});
		acts.appendChild(blk);
		row.appendChild(acts);
		return row;
	}

	/// Show the People view of the Social panel, which is where the list lives.
	function showPeople() {
		try {
			if (window.DaimondSocial && window.DaimondSocial.open) {
				window.DaimondSocial.open('people');
				return true;
			}
		} catch (e) { /* the panel is not up */ }
		return false;
	}

	/// Show this identity's own card, as a symbol and as a string.
	function showCard() {
		overlay(function (box) {
			box.appendChild(el('h3', null, tOr('trust.show_mine', 'Show my code')));
			var id = window.DaimondIdentity;
			var p = el('p', null, tOr('trust.show_lead',
				'Let them point their camera at this. Reading it in person is the only way either of you can mark the other matched without a phone call.'));
			box.appendChild(p);
			var mint = (id && id.card()) ? Promise.resolve({ ok: true }) : (id ? id.mintCard() : Promise.resolve({ ok: false }));
			mint.then(function () {
				var url = cardUrl();
				if (!url) {
					box.appendChild(el('p', 'pair-err', tOr('trust.no_card',
						'This device has no card yet. Unlock it and try again.')));
					return;
				}
				var qr = qrCanvas(url);
				if (qr) box.appendChild(qr);
				var fp = el('div', 'trust-fp', (id && id.fingerprint()) || '');
				box.appendChild(fp);
				var txt = el('textarea', 'pair-name');
				txt.value = cardText();
				txt.rows = 3;
				txt.readOnly = true;
				box.appendChild(el('p', 'pair-note', tOr('trust.paste_lead',
					'No camera? Send them this instead. A code that arrives this way is a new key and stays one until you compare numbers.')));
				box.appendChild(txt);
			});
		});
	}

	/// Take somebody's card: by camera, or by paste.
	function showAdd() {
		overlay(function (box, close) {
			box.appendChild(el('h3', null, tOr('trust.add', 'Add somebody')));
			box.appendChild(el('p', null, tOr('trust.add_lead',
				'Point this device at their code, or paste what they sent you.')));
			var video = document.createElement('video');
			video.className = 'trust-scan';
			video.setAttribute('playsinline', '');
			video.muted = true;
			box.appendChild(video);
			var err = el('div', 'pair-err');
			var input = el('textarea', 'pair-name');
			input.rows = 3;
			input.setAttribute('placeholder', PASTE_PREFIX + '…');
			box.appendChild(input);
			box.appendChild(err);
			var row = el('div', 'pair-row');
			var cancel = el('button', 'pair-btn ghost', t('common.cancel'));
			cancel.addEventListener('click', function () { stop(); close(); });
			var go = el('button', 'pair-btn', tOr('trust.read_paste', 'Read this'));
			row.appendChild(cancel);
			row.appendChild(go);
			box.appendChild(row);

			var stream = null;
			var timer = 0;
			function stop() {
				if (timer) { clearInterval(timer); timer = 0; }
				if (stream) {
					try { stream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
					stream = null;
				}
			}
			go.addEventListener('click', function () {
				var card = parse(input.value);
				if (!card) { err.textContent = tOr('trust.bad_card', 'That is not a Daimond code, or it did not verify.'); return; }
				stop();
				close();
				// A PASTE, so the ceiling is the safety number and the in-person
				// offer is not made. Nothing about a string in a chat window says
				// the two of you were in a room.
				accept(card, ROUTE.PASTE);
			});

			// The camera, where there is one. Its absence is not an error: the
			// paste box above is the whole feature on a machine with no camera.
			scanner().then(function (qr) {
				if (!qr || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
					video.style.display = 'none';
					return;
				}
				navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
					.then(function (st) {
						stream = st;
						video.srcObject = st;
						video.play().catch(function () { /* the user will use the paste box */ });
						timer = setInterval(function () {
							qr.detect(video).then(function (hit) {
								if (!hit || !hit.text) return;
								var card = parse(hit.text);
								if (!card) return;
								stop();
								close();
								// READ BY THIS DEVICE'S OWN CAMERA, so the two of
								// them are in a room and the in-person offer stands.
								accept(card, ROUTE.QR);
							});
						}, 250);
					})
					.catch(function () { video.style.display = 'none'; });
			});
		});
	}

	/// What a card that has just arrived offers, which depends entirely on how
	/// it arrived. This is decision 4, drawn.
	function accept(card, route) {
		return record(card, route).then(function () {
			return person(card.key);
		}).then(function (p) {
			// What this key ALREADY is, rather than "new" every time. A card from
			// somebody matched last week is not news, and a card that turns out to
			// supersede a matched key is the loud case in 12.4.5 -- neither may be
			// drawn as a first meeting.
			var state = p || { state: 'new', method: '', matchedAt: 0, prevAt: 0 };
			overlay(function (box, close) {
				box.appendChild(el('h3', null, tOr('trust.arrived', 'A code arrived')));
				box.appendChild(el('div', 'trust-claim',
					tOr('trust.calls_themselves', 'calls themselves “{name}”', { name: card.label || '—' })));
				box.appendChild(drawKeyLine(state));
				box.appendChild(el('div', 'trust-fp', card.fp));
				var row = el('div', 'pair-row');
				if (route === ROUTE.QR && state.state !== 'matched') {
					box.appendChild(el('p', 'pair-note', tOr('trust.qr_lead',
						'You read this off their screen, so there was no channel for anybody to get between you. Mark it matched only if that is what happened.')));
					var mk = el('button', 'pair-btn', tOr('trust.mark_matched', 'Mark matched now'));
					mk.addEventListener('click', function () {
						markMatched(card.key, METHOD.QR).then(function () {
							close();
							if (redraw) redraw();
							showPeople();
						});
					});
					row.appendChild(mk);
				} else if (state.state !== 'matched') {
					// THE CEILING FOR EVERY ASYNCHRONOUS ROUTE, and it is the root of
					// the model rather than a caution: whatever handed this over could
					// have substituted its own key and signed the result perfectly.
					box.appendChild(el('p', 'pair-note', tOr('trust.async_lead',
						'This came through something in the middle, so it stays a new key. Read the safety number aloud on a call to change that.')));
				}
				var num = el('button', 'pair-btn ghost', tOr('trust.compare_numbers', 'Compare safety numbers'));
				num.addEventListener('click', function () { close(); showSafety(card.key); });
				row.appendChild(num);
				box.appendChild(row);
			});
		});
	}

	/// The safety-number screen: sixty digits, and two people reading them.
	function showSafety(keyHex, onChange) {
		overlay(function (box, close) {
			box.appendChild(el('h3', null, tOr('trust.numbers', 'Safety numbers')));
			box.appendChild(el('p', null, tOr('trust.numbers_lead',
				'Read these sixty digits to each other on a call, or in person. Both of you must see the same twelve groups. Reading them in a message proves nothing — whatever could swap the keys could swap the message.')));
			var grid = el('div', 'trust-number');
			box.appendChild(grid);
			var err = el('div', 'pair-err');
			box.appendChild(err);
			var row = el('div', 'pair-row');
			var no = el('button', 'pair-btn ghost', tOr('trust.numbers_differ', 'They are different'));
			var yes = el('button', 'pair-btn', tOr('trust.numbers_match', 'The numbers match'));
			row.appendChild(no);
			row.appendChild(yes);
			box.appendChild(row);

			safetyNumber(keyHex).then(function (n) {
				if (!n) { err.textContent = tOr('trust.no_number', 'This device cannot compute the number yet.'); return; }
				var groups = n.split(/\s+/);
				for (var i = 0; i < groups.length; i++) grid.appendChild(el('span', null, groups[i]));
			});
			no.addEventListener('click', function () {
				grid.style.display = 'none';
				err.textContent = tOr('trust.numbers_differ_note',
					'Then somebody is between you. Do not use this key. Meet, or start again from a code you read in person.');
				yes.disabled = true;
			});
			yes.addEventListener('click', function () {
				markMatched(keyHex, METHOD.NUMBER).then(function (e) {
					close();
					if (onChange) onChange();
					else if (redraw) redraw();
					if (e) showPeople();
				});
			});
		});
	}

	// ── A card arriving in the URL ─────────────────────────────

	/// The card carried in `#c=`, if this load came from a scanned symbol.
	function pendingCard() {
		var m = /[#&]c=([^&]+)/.exec(location.hash || '');
		return m ? decodeURIComponent(m[1]) : '';
	}

	/// Take it out of the URL, so a reload does not re-offer it and it does not
	/// sit in history.
	function consumeHash() {
		try {
			var h = (location.hash || '').replace(/[#&]?c=[^&]*/, '');
			if (h === '#') h = '';
			history.replaceState({}, '', location.pathname + location.search + h);
		} catch (e) { /* nothing to tidy */ }
	}

	function maybeOpenFromHash() {
		var raw = pendingCard();
		if (!raw) return;
		if (document.querySelector('.pair-scrim')) return;		// a dialog is already up
		consumeHash();
		var card = parse(raw);
		if (!card) return;
		// A LINK, whatever put it there. A phone's camera opening this URL is not
		// this app's camera reading a screen, and the app cannot tell the two
		// apart — so it takes the lower of the two, which is the only safe way
		// round for a thing that cannot be told apart.
		accept(card, ROUTE.LINK);
	}

	// ── Where a person finds this ──────────────────────────────

	/// Draw the People list into a container. `#social-people-list` in the
	/// shipped panel, which is the seam improve.js left for exactly this: a lane
	/// renders rows and then says how many, and the panel takes its own honest
	/// empty line down.
	///
	/// Answers the redraw function, so whatever mounted it can ask for the list
	/// again after an act that changes it.
	function mount(host) {
		if (!host) return null;
		injectStyles();
		host.innerHTML = '';
		var acts = el('div', 'trust-acts');
		var mine = el('button', 'pair-btn ghost', tOr('trust.show_mine', 'Show my code'));
		mine.addEventListener('click', showCard);
		var add = el('button', 'pair-btn', tOr('trust.add', 'Add somebody'));
		add.addEventListener('click', showAdd);
		acts.appendChild(mine);
		acts.appendChild(add);
		host.appendChild(acts);
		var list = el('div', 'trust-list');
		host.appendChild(list);
		var draw = function () {
			return people().then(function (all) {
				list.innerHTML = '';
				for (var i = 0; i < all.length; i++) list.appendChild(personRow(all[i], draw));
				// The panel's own empty line goes when there is a row to see. Two
				// buttons are not a row: a list with nobody in it still wants the
				// sentence saying so.
				try {
					if (window.DaimondSocial && window.DaimondSocial.filled) {
						window.DaimondSocial.filled('people', all.length);
					}
				} catch (e) { /* the panel is not up */ }
				return all.length;
			});
		};
		draw();
		return draw;
	}

	/// Put the list in the Social panel and keep it in step with the panel.
	///
	/// Read LAZILY, on the open, because that is when somebody is looking, and
	/// because the replay verifies every signature in the log — work with no
	/// business happening on a boot nobody asked it of.
	var redraw = null;
	function attachPanel() {
		var host = document.getElementById('social-people-list');
		if (!host) return false;
		redraw = mount(host);
		try {
			if (window.DaimondSocial && window.DaimondSocial.watch) {
				window.DaimondSocial.watch(function (view) {
					if (view === 'people' && redraw) redraw();
				});
			}
		} catch (e) { /* no panel to watch */ }
		return true;
	}

	function start() {
		injectStyles();
		if (!attachPanel()) {
			// The panel is built by another module; if this ran first, wait for the
			// document rather than deciding there is no panel.
			document.addEventListener('DOMContentLoaded', attachPanel);
		}
		maybeOpenFromHash();
		window.addEventListener('hashchange', maybeOpenFromHash);
	}

	// ── Public surface ─────────────────────────────────────────
	window.DaimondTrust = {
		// The transports. One artefact, three carriers, and the carrier is what
		// decides the ceiling.
		cardText:   cardText,
		cardUrl:    cardUrl,
		parse:      parse,
		ROUTE:      ROUTE,
		METHOD:     METHOD,
		SCOPE:      SCOPE_IDENTITY,
		// The log, and the acts that write to it.
		log:        readLog,
		record:     record,
		markMatched: markMatched,
		setBlocked: setBlocked,
		chainBreak: chainBreak,
		edgeInput:  edgeInput,
		// The projection. `people` REPLAYS and re-verifies; it holds nothing.
		people:     people,
		person:     person,
		fold:       fold,
		forget:     function () { projection = null; },
		// The number, and the words.
		safetyNumber: safetyNumber,
		keyWords:   keyWords,
		drawKeyLine: drawKeyLine,
		// The surfaces.
		showPeople: showPeople,
		showCard:   showCard,
		showAdd:    showAdd,
		/// What a card that has just arrived is offered, given how it arrived.
		/// Published because the route is the whole of decision 4 and a verifier
		/// has to be able to drive both routes through the SAME door the scanner
		/// and the hash handler use — a second door would be a second place for
		/// the rule to be got wrong.
		offer:      accept,
		showSafety: showSafety,
		/// Draw the list into a container, and redraw it. `#social-people-list`
		/// is where `start` puts it; this is published so a second surface can
		/// have the SAME rows rather than a second rendering of a key state.
		mount:      mount,
		refresh:    function () { projection = null; return redraw ? redraw() : Promise.resolve(0); },
		// The reader, brought up on demand. Published so the verifier drives the
		// same loader the scanner does rather than a second one of its own.
		scanner:    scanner,
	};

	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
	else start();
})();
