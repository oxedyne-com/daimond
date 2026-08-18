/* ============================================================
   Daimond — groups (group.js)
   ------------------------------------------------------------
   A GROUP IS A MEMBERSHIP LIST AND THERE IS NO GROUP KEY.

   A message to a group is one envelope sealed once per member,
   which is the recipient-slot list in post.js doing the work it
   was reserved for. Membership changes need no re-keying because
   there is no key to change: a message is sealed to whoever is a
   member at the moment it is sent. That single decision removes
   group-key rotation, which is the part of group cryptography
   that is hard.

   ── THE THREE THINGS THAT MUST BE ON SCREEN ─────────────────

   Each is a consequence of the design and none is a defect, so
   each is said in the interface rather than left in a comment
   where the only person who reads it is the next person to
   write the code.

   1. JOINING SHOWS NOTHING EARLIER. A new member cannot read
      what was sent before they joined, because those envelopes
      were never sealed to them. Drawn on the invitation, before
      the Join press, not after it.

   2. REMOVING SOMEBODY RETRACTS NOTHING. They keep every
      message already delivered to them. The control therefore
      says "stop sending to", never "remove", and the sentence
      is beside it before the press. Anything else would be a
      promise this design cannot keep.

   3. CLOSING IS FINAL, AND IT DESTROYS NOTHING. A group is
      closed by its creator writing a roster that names NOBODY
      -- because a group IS its membership list, so a list with
      nobody on it is the group being over. Everybody keeps
      every message; nobody can write to it again, the creator
      included. Said in one confirmation dialogue before the
      press, because it cannot be undone.

   ── WHERE THE LIST LIVES, AND WHAT THE RELAY LEARNS ─────────

   In the clients, and nowhere else. A roster travels as an
   ORDINARY SEALED MESSAGE through the relay that already
   exists: the gateway gains no group record, no group endpoint
   and no group table, and `gateway/src/handlers/post.rs` is
   unchanged by this file.

   What the relay learns is therefore what it already learned by
   routing: N envelopes sharing one `addr`, landing in N boxes
   at one instant, which is a correlation anybody reading the
   store can make. It does NOT learn the group's name, its id,
   who created it, or that these deliveries are a group rather
   than a broadcast. §12.6 says the member list is visible to
   the relay and that is true — but by INFERENCE and not by
   record, which is the better of the two positions: the blinded
   mailbox ids §12.7 defers would remove the inference outright,
   whereas a stored roster would have to be designed away.

   ── WHO MAY ADD AND REMOVE, AND WHY IT IS NOT A POLICY ──────

   The creator, and only the creator. That is §12.6's first cut,
   and here it is not a rule a client could decline to enforce —
   it is an identity:

       gid = SHA-256("daimond.group.id.v1" ‖ creatorPub ‖ salt)

   A roster is obeyed only where the id recomputed from the
   op's OWN author key and its OWN salt equals the `to` the
   signature covers. Nobody but the holder of that signing key
   can produce a roster for that group, so "creator only" costs
   no membership-operation schema, no signed-op ordering and no
   story about two people editing membership at once — which is
   the convergence problem §12.6 declines to open.

   It also makes the invitation self-authenticating: a device
   that has never heard of a group can check the first roster it
   is sent, because everything needed to check it is inside it.

   Attaches one global, `window.DaimondGroup`.
   ============================================================ */
(function () {
	'use strict';

	// ── Saying things ──────────────────────────────────────────

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A string from the table, or the English written at the call site where the
	/// table has no entry for it yet. post.js's `tOr`, and for the same reason.
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
			console.log.apply(console, ['[group]'].concat([].slice.call(arguments)));
		} catch (e) { /* no console */ }
	}

	// ── The op ─────────────────────────────────────────────────
	//
	// A roster is a `daimond/post/0` payload like any other, because a new
	// schema would mean fe2o3_sbj, the wasm write side and a rebuilt bundle for
	// a record with five fields in it. What marks it is the first line of the
	// body, and post.js refuses to SEND a body whose first line is this — so no
	// message a person wrote can be mistaken for a roster.
	//
	// The marker is not a security boundary and is not asked to be one. A
	// hostile client forging a roster is refused by the id derivation, which is
	// where the authorisation actually is; the marker only keeps an honest
	// person's prose out of the roster path.

	/// The first line of every roster body.
	var MARK = 'daimond.group.op.v1';

	/// The domain the group id is derived in. Not a prefix of any other tag.
	var ID_INFO = 'daimond.group.id.v1';

	/// The salt's exact width, in bytes.
	var SALT = 16;

	/// The most members a roster may name.
	///
	/// The slot count in post.js's envelope is ONE BYTE, so 255 is the hard
	/// ceiling of the seal itself and not a policy. See the fan-out arithmetic
	/// in post.js, which reaches its practical wall well before this.
	var MEMBERS_MAX = 255;

	/// The most a group name may carry, in characters. A name is a label its
	/// author chose, drawn beside the id for the same reason a card's label is
	/// drawn beside a fingerprint.
	var NAME_MAX = 64;

	// ── Encoding ───────────────────────────────────────────────

	function utf8(s) { return new TextEncoder().encode(String(s)); }

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

	/// Whether a string is exactly `n` bytes of lowercase hexadecimal.
	function isHex(s, n) {
		return typeof s === 'string' && s.length === n * 2 && /^[0-9a-f]+$/.test(s);
	}

	/// A millisecond timestamp, kept whole. `| 0` would coerce it to a signed
	/// 32-bit integer, and `Date.now()` is about 1.79e12 -- see post.js's `ms`,
	/// which says what that costs and why it is invisible for weeks at a time.
	function ms(v) {
		var n = Number(v);
		return isFinite(n) ? Math.trunc(n) : 0;
	}

	function cat(parts) {
		var n = 0, i;
		for (i = 0; i < parts.length; i++) n += parts[i].length;
		var out = new Uint8Array(n), at = 0;
		for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
		return out;
	}

	function b64enc(buf) {
		var b = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
		var bin = '';
		for (var i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
		return btoa(bin);
	}

	/// Standard base64 to the base64url the gateway binds an account by.
	function b64url(b64) {
		return String(b64).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	/// A signing key in hex, as the base64url spelling the relay addresses by.
	function pubOf(keyHex) { return b64url(b64enc(unhex(keyHex))); }

	// ── The identity of a group ────────────────────────────────

	/// Derive a group's id from its creator's signing key and its salt.
	///
	/// This is the whole of the authorisation model. The id is what the payload's
	/// signed `to` carries, so a roster verifies for exactly one signing key and
	/// nobody else can mint one for the same group without finding a SHA-256
	/// preimage. It also means a device seeing a group for the first time can
	/// check the roster that introduces it without knowing anything beforehand.
	async function deriveId(creatorHex, saltHex) {
		if (!isHex(creatorHex, 32) || !isHex(saltHex, SALT)) return '';
		var bits = await crypto.subtle.digest('SHA-256',
			cat([utf8(ID_INFO), unhex(creatorHex), unhex(saltHex)]));
		return hex(new Uint8Array(bits));
	}

	// ── The store, which is post.js's ──────────────────────────
	//
	// Groups live in the message record and not in one of their own, and that is
	// deliberate rather than convenient. post.js already wraps that record under
	// the identity key at rest, re-seals it through `DaimondRekey` on a
	// passphrase change, hangs it on the sync parcel and merges an arriving one.
	// A second store would be a second thing to wrap, a second thing to re-seal
	// and a second section for sync.js to carry — and the roster and the
	// messages sealed under it are one account state, so they must merge
	// together or a device can hold a message for a group it does not know it is
	// in.

	/// The groups map, or null while the identity is locked.
	async function all() {
		if (!window.DaimondPost || !DaimondPost.groups) return null;
		return await DaimondPost.groups();
	}

	/// One group's record, or null.
	async function get(gid) {
		var g = await all();
		return (g && g[String(gid)]) || null;
	}

	/// Write one group's record back and save.
	async function put(gid, rec) {
		if (!window.DaimondPost || !DaimondPost.putGroup) return false;
		return await DaimondPost.putGroup(String(gid), rec);
	}

	// ── A record ───────────────────────────────────────────────
	//
	// TWO CLOCKS, EACH WITH ONE WRITER, which is what makes the merge in
	// post.js `adopt` converge without any ordering machinery:
	//
	//   * the ROSTER half -- `at`, `salt`, `name`, `members` -- is the
	//     creator's, and only the creator writes it, so the higher `at` wins;
	//   * the LOCAL half -- `state`, `stateAt` -- is this account's own
	//     decision, and only this account writes it, so the higher `stateAt`
	//     wins.
	//
	// Neither clock is compared against the other and neither is a Lamport
	// counter pretending to be a timestamp. A record is:
	//
	//   { gid, creator, salt, name, at, addr, members: [ {k, e, n} ],
	//     state: 'invited' | 'joined' | 'left', stateAt }

	/// The three states a group is in on THIS device.
	var STATE = { INVITED: 'invited', JOINED: 'joined', LEFT: 'left' };

	/// Whether a state may compose to the group.
	function canSend(st) { return st === STATE.JOINED; }

	/// Why nothing more can be sent to a closed group.
	///
	/// One place, because three callers refuse for it -- `sealTo`, `roster` and
	/// `close` -- and a sentence written out at each of them is three wordings
	/// waiting for two of them to stop being read. The same argument that makes
	/// `DaimondPost.shortfall` the single authority one level up.
	function closedWhy() {
		return tOr('group.err_closed',
			'This group has been closed, so nothing more can be sent to it. '
			+ 'Every message already here stays where it is.');
	}

	/// Has this group been CLOSED? Its roster names nobody.
	///
	/// CLOSED IS NOT A FOURTH FIELD, it is the membership list being empty, and
	/// that is the whole reason it works. Three things fall out of the machinery
	/// that already exists rather than having to be built:
	///
	///  - IT IS AUTHORISED. Only the holder of the creator's signing key can
	///    produce a roster for this id, so only they can produce the empty one.
	///  - IT TRAVELS BOTH ROADS. `members` is a field `post.js` `adopt` already
	///    copies on the roster half, so a second device of the same account
	///    converges over the sync parcel; every member converges over the relay
	///    through `consume`. A `closed` flag of its own would travel the relay and
	///    NOT the parcel, and the creator's other phone is the one device the
	///    relay never delivers their own roster to.
	///  - IT ENFORCES ITSELF AT THE READERS. `accepts` walks the roster looking
	///    for the author; an empty roster contains nobody, so a message to a
	///    closed group is refused by every reader for the same reason a removed
	///    member's is. There is no group key to rotate and the relay knows
	///    nothing, so the readers are the only place it could be.
	function isClosed(rec) {
		return !!rec && Array.isArray(rec.members) && rec.members.length === 0;
	}

	/// AND THE CASE THE THREE STATES DID NOT HAVE: this account wrote the roster.
	///
	/// All three are answers to somebody else's invitation, and an author has no
	/// invitation to answer -- writing the roster IS the answer. Until this was
	/// read, `create` applied its own roster through `consume`, was filed
	/// INVITED like any stranger's, and `sealTo` then refused the creator from a
	/// group they had just made with "Join this group before writing to it."
	/// Nothing in the app ever joined them: the panel's Make branch reports how
	/// many people were told and stops. So the state machine was not missing a
	/// FOURTH state, it was missing a rule about the three it has --
	///
	///   FOR A GROUP THIS ACCOUNT CREATED, THE STATE IS ALWAYS `joined`.
	///
	/// -- which holds because the id is derived from the creator's own signing key
	/// and `roster` puts them in every roster it writes, so there is no roster of
	/// theirs that does not name them. `invited` is unreachable for an author and
	/// so is `left`: both are contradicted by their own next roster.
	///
	/// WITH EXACTLY ONE EXCEPTION, and it is the one this rule's own premise names:
	/// THE CLOSING ROSTER, which names nobody at all (see `isClosed`). It is the
	/// one roster of the creator's that does not name them, so it is the one that
	/// puts an author in `left` -- and it has to, because "nobody can write to it
	/// again" includes them. `consume` reaches it before this branch: an empty
	/// roster fails the membership test first, and the chain below is ordered
	/// membership, then authorship, then invitation for that reason.
	///
	/// It is read HERE, at the one door a roster becomes a record, and not in
	/// `create`, because `create` is one of four ways in. The other three are
	/// `setMembers`, the creator's own copy arriving back off the relay, and a
	/// second device of the same account reading the same bytes -- and a repair
	/// bolted onto `create` would leave that last one filing the account's own
	/// group as an invitation on its owner's other phone.
	function authoredBy(rec, mineHex) {
		return !!mineHex && !!rec && String(rec.creator).toLowerCase() === mineHex;
	}

	/// This device's signing key in hex, or '' while the identity is unreadable.
	///
	/// Four places asked this question with four copies of the same try/catch, and
	/// '' is the answer that makes each of them fail closed: no key compares equal
	/// to it, so an unreadable identity is nobody rather than everybody.
	async function whoAmI() {
		try {
			var me = await DaimondIdentity.publicKeyRaw();
			return me ? hex(me) : '';
		} catch (e) { return ''; }
	}

	// ── Reading a roster op ────────────────────────────────────

	/// Whether a message body is a roster op rather than something somebody wrote.
	function looksLikeOp(body) {
		var s = String(body == null ? '' : body);
		return s.slice(0, MARK.length) === MARK
			&& (s.length === MARK.length || s.charAt(MARK.length) === '\n');
	}

	/// Parse a roster op out of a body, or null. Shape only; the id derivation
	/// below is what decides whether it may be obeyed.
	function parseOp(body) {
		if (!looksLikeOp(body)) return null;
		var j = null;
		try { j = JSON.parse(String(body).slice(MARK.length + 1)); }
		catch (e) { return null; }
		if (!j || typeof j !== 'object' || j.op !== 'roster') return null;
		if (!isHex(j.salt, SALT)) return null;
		// AN EMPTY ROSTER IS LEGAL AND MEANS CLOSED. This read `|| !j.members.length`
		// and refused one, so the shape a close travels in was rejected at the door
		// by the same function that lets every other roster through. It is still a
		// list, still signed, and still verified by the id derivation -- so nobody
		// but the creator can produce one. See `isClosed`.
		if (!Array.isArray(j.members) || j.members.length > MEMBERS_MAX) return null;
		var out = [], seen = {}, i;
		for (i = 0; i < j.members.length; i++) {
			var m = j.members[i];
			if (!m || !isHex(m.k, 32) || !isHex(m.e, 32)) return null;
			// A roster naming one key twice would let a member be counted twice in
			// a fan-out and, worse, would let one entry's sealing key disagree with
			// another's for the same person.
			if (seen[m.k]) return null;
			seen[m.k] = 1;
			out.push({ k: m.k, e: m.e, n: String(m.n || '').slice(0, NAME_MAX) });
		}
		return { salt: j.salt, name: String(j.name || '').slice(0, NAME_MAX), members: out };
	}

	/// Build the body of a roster op.
	function opBody(salt, name, members) {
		return MARK + '\n' + JSON.stringify({
			op:      'roster',
			salt:    salt,
			name:    String(name || '').slice(0, NAME_MAX),
			members: members.map(function (m) { return { k: m.k, e: m.e, n: m.n || '' }; }),
		});
	}

	// ── What post.js asks this file ────────────────────────────

	/// Whether an artefact addressed to `toHex` may be opened by this device.
	///
	/// post.js calls this when a message's signed `to` is not this account's own
	/// signing key, which is the ONE place a group message differs from any
	/// other. Two answers are yes, and each carries its own reason:
	///
	///  - THE INVITATION. The artefact is a roster op whose id, recomputed from
	///    its own author and its own salt, is the `to` it was signed under. It
	///    needs no prior knowledge, which is what makes a first roster carriable
	///    over the ordinary relay with nothing arranged beforehand.
	///
	///  - AN ORDINARY GROUP MESSAGE. There is a known group at that id, this
	///    device is in it, and THE AUTHOR IS IN ITS CURRENT ROSTER.
	///
	/// That last clause is where a removal is enforced, and it is the only place
	/// it can be. There is no group key to rotate and the relay knows nothing, so
	/// a member who has been dropped is refused BY EVERY READER rather than by
	/// the transport. A client that skipped it would keep drawing messages from
	/// somebody the creator removed, which is the one thing "stop sending to"
	/// must actually mean.
	async function accepts(toHex, got) {
		var want = String(toHex || '').toLowerCase();
		if (!isHex(want, 32)) return null;

		// The invitation, checked against itself.
		var op = parseOp(got && got.post && got.post.body);
		if (op) {
			var derived = await deriveId(String(got.author || '').toLowerCase(), op.salt);
			if (derived && derived === want) return { op: true, gid: want };
			// A body that reads as a roster and does not verify is refused
			// outright rather than falling through to be drawn as prose. A reader
			// shown JSON in a message bubble has been shown a failure as content.
			return null;
		}

		var rec = await get(want);
		if (!rec || rec.state === STATE.LEFT) return null;
		var who = String(got && got.author || '').toLowerCase();
		var i;
		// AND A CLOSED GROUP IS REFUSED BY THIS SAME WALK, with no line of its own.
		// A closed group's roster names nobody (see `isClosed`), so nobody is found
		// in it and every message to it is refused for the reason a removed
		// member's is. An explicit `isClosed` guard was written above this loop
		// first and then deleted: it could not be made to fail, because disabling
		// it left the walk refusing exactly the same envelopes. A check that cannot
		// go red is not a check, and the mechanism it was standing in front of is
		// the one worth naming here.
		//
		// It matters that this holds WITHOUT the local half being right. The two
		// halves of a record merge on separate clocks, and the local half only
		// moves when the arriving `stateAt` is the higher -- so a member who
		// pressed Join on a device whose clock runs ahead of the creator's can
		// adopt the empty roster onto a record still saying `joined`. Clock skew
		// between two people is not a fault either can see; the roster is.
		for (i = 0; i < rec.members.length; i++) {
			if (rec.members[i].k === who) {
				return { op: false, gid: want, name: rec.name, state: rec.state };
			}
		}
		return null;
	}

	/// Take one roster op and answer whether it moved this device.
	///
	/// The op is NOT re-checked against the creator here: `accepts` has already
	/// recomputed the id from the artefact's own author and salt, and calling
	/// this with an artefact that did not pass it is a caller error rather than
	/// a state to defend against. It is the same arrangement `openEnvelope` uses
	/// for a signature.
	async function consume(got) {
		var op = parseOp(got && got.post && got.post.body);
		if (!op) return false;
		var gid = String(got.post.to).toLowerCase();
		var at  = ms(got.time);
		var rec = await get(gid);

		// A CLOSED GROUP CANNOT BE REOPENED, AND IT IS THE READERS THAT SAY SO.
		// This is what makes the confirmation dialogue's "it cannot be undone" a
		// property rather than a promise: a later roster from the creator naming
		// everybody again is refused HERE, on every device, so a client that
		// offered to reopen a group would find nobody obeying it. Before the `at`
		// comparison, because a reopening roster is by definition the newer one.
		if (isClosed(rec)) return false;

		// A roster no newer than the one held changes nothing. This is what makes
		// a replay inert: an old op re-delivered by anybody is simply older.
		if (rec && (at < ms(rec.at)
			|| (at === ms(rec.at) && String(got.address) <= String(rec.addr || '')))) {
			return false;
		}

		var mineHex = await whoAmI();

		var inIt = false, i;
		for (i = 0; i < op.members.length; i++) {
			if (op.members[i].k === mineHex) { inIt = true; break; }
		}

		var next = {
			gid:     gid,
			creator: String(got.author).toLowerCase(),
			salt:    op.salt,
			name:    op.name,
			at:      at,
			addr:    String(got.address || ''),
			members: op.members,
			state:   rec ? rec.state : STATE.INVITED,
			stateAt: rec ? ms(rec.stateAt) : 0,
		};
		// THE LOCAL HALF, decided in one chain so that the precedence is on the
		// page rather than in the order two independent `if`s happen to sit in.
		// Membership first, then authorship, then the invitation.
		if (!inIt) {
			// A roster that no longer names this device is the removal, arriving. It
			// is sent to the dropped member deliberately (see `setMembers`), because
			// a removal nobody is told about leaves somebody composing into a group
			// that will refuse every word of it.
			//
			// NOTHING IS DELETED. Every message already collected stays exactly
			// where it is, which is the second sentence this file exists to keep
			// true.
			if (next.state !== STATE.LEFT) {
				next.state   = STATE.LEFT;
				next.stateAt = at;
			}
		} else if (authoredBy(next, mineHex)) {
			// THE AUTHOR IS IN THEIR OWN GROUP AND IS NOT ASKED. See `authoredBy`:
			// there is no invitation to answer, so there is no state but `joined`
			// for a roster this account wrote and named itself in. Written with the
			// ROSTER'S OWN STAMP rather than `Date.now()`, so the local half still
			// merges on a real millisecond clock and this account's other devices
			// converge on the same answer instead of on whichever read the bytes
			// last.
			if (next.state !== STATE.JOINED) {
				next.state   = STATE.JOINED;
				next.stateAt = at;
			}
		} else if (next.state === STATE.LEFT) {
			// And a roster that names this device again after a removal is a fresh
			// invitation rather than a silent rejoin: joining is an act.
			next.state   = STATE.INVITED;
			next.stateAt = at;
		}
		// The ANSWER IS THE WRITE, not the decision to write. A roster that was
		// understood and could not be stored -- the identity locked between the
		// two -- has moved nothing, and a caller told otherwise would count it as
		// applied and never look at it again.
		var wrote = await put(gid, next);
		if (wrote) log('roster', gid.slice(0, 8), next.state, next.members.length, 'member(s)');
		return wrote;
	}

	// ── Sealing to a group ─────────────────────────────────────

	/// Who a message to this group is sealed to, and who was left out.
	///
	/// Answers `{ ok, why, gid, enc, to, skipped, name }`:
	///  - `enc` is the sealing keys the envelope gets a slot for;
	///  - `to`  is the base64url signing keys the envelope is DELIVERED to;
	///  - `skipped` is `[{ label, why }]`, and it is drawn, never swallowed.
	///
	/// THE KEY-CHANGE RULE, which is the whole reason this is not a one-liner.
	/// trust.js holds a state per key — `matched`, `new`, `changed`, `blocked` —
	/// and a group message sealed to a CHANGED key is a group message sealed to
	/// somebody who may not be the same person. Of the three things that could be
	/// done about that:
	///
	///   * seal to it anyway — hands the words to whoever now holds the key, and
	///     tells the sender nothing;
	///   * refuse the whole send — one member's rotated key silences a group of
	///     forty for a reason nobody can see;
	///   * seal to the rest and SAY WHO WAS LEFT OUT — the sender's screen names
	///     them, and the message reaches everybody it safely can.
	///
	/// The third. The first is the only one that is unsafe and the second is the
	/// only one that is useless, so this is not a close call; what it costs is
	/// that the sender must be shown the list, which is why `skipped` is a
	/// returned value and not a log line.
	///
	/// A roster's `e` is THE CREATOR'S CLAIM about a member's sealing key. Where
	/// trust.js holds a card for the same signing key, that card wins and a
	/// disagreement is treated exactly as a key change is — because that is what
	/// it is, seen from the group's side.
	async function sealTo(gid) {
		var rec = await get(gid);
		if (!rec) {
			return { ok: false, why: tOr('group.err_unknown',
				'This device does not know that group.') };
		}
		// CLOSED IS ASKED FIRST, and the order is the whole of why the answer is
		// worth anything. A closed group leaves this account in `left`, so without
		// this line the sender is told "You are no longer in this group" -- true of
		// the record and wrong about what happened, and wrong in the one direction
		// that matters: it reads as something done to them, when it is a group
		// nobody is in any more. The creator gets that same sentence about a group
		// they closed themselves.
		if (isClosed(rec)) {
			return { ok: false, gid: gid, name: rec.name, why: closedWhy() };
		}
		if (!canSend(rec.state)) {
			return { ok: false, why: rec.state === STATE.LEFT
				? tOr('group.err_left',
					'You are no longer in this group, so nothing can be sent to it. '
					+ 'The messages already here stay where they are.')
				: tOr('group.err_not_joined',
					'Join this group before writing to it.') };
		}

		var dir = {};
		try {
			if (window.DaimondTrust && DaimondTrust.people) {
				(await DaimondTrust.people() || []).forEach(function (p) {
					if (p && p.key) dir[String(p.key).toLowerCase()] = p;
				});
			}
		} catch (e) { log('people projection failed', e); }

		var mineHex = await whoAmI();

		var enc = [], to = [], skipped = [], i;
		for (i = 0; i < rec.members.length; i++) {
			var m    = rec.members[i];
			var name = m.n || (dir[m.k] && dir[m.k].label) || m.k.slice(0, 8);
			if (m.k === mineHex) {
				// This device's own slot is post.js's business, and it adds one.
				// Adding a second here would be a duplicate slot in every envelope.
				continue;
			}
			var p = dir[m.k] || null;
			if (p && p.state === 'blocked') {
				skipped.push({ label: name, why: tOr('group.skip_blocked',
					'you blocked this key') });
				continue;
			}
			if (p && p.state === 'changed') {
				skipped.push({ label: name, why: tOr('group.skip_changed',
					'their key changed and you have not matched the new one') });
				continue;
			}
			if (p && p.enc && String(p.enc).toLowerCase() !== m.e) {
				// The roster and this device's own card disagree about a sealing
				// key. That IS a key change, arriving by another road.
				skipped.push({ label: name, why: tOr('group.skip_disagree',
					'the group\'s key for them is not the one you hold') });
				continue;
			}
			enc.push(unhex(m.e));
			to.push(pubOf(m.k));
		}
		if (!enc.length) {
			return { ok: false, gid: gid, name: rec.name, skipped: skipped,
				why: tOr('group.err_nobody',
					'There is nobody in this group this device can seal to.') };
		}
		return { ok: true, gid: gid, name: rec.name, enc: enc, to: to, skipped: skipped };
	}

	// ── Making and changing a group ────────────────────────────

	/// Start a group, and send its first roster.
	///
	/// The creator is a member of their own group and does not have to be named:
	/// a group of one that the creator is not in is a group nobody can write to.
	///
	/// `keys` are member signing keys in hex. Their sealing keys come from
	/// trust.js, because that is the only place this app holds a key it has
	/// re-verified; a member with no card cannot be added, and saying so is
	/// better than adding somebody nothing can be sealed to.
	async function create(name, keys) {
		if (!window.DaimondIdentity || !DaimondIdentity.isUnlocked()) {
			return { ok: false, why: tOr('group.err_locked',
				'Unlock Daimond to make a group: its roster is signed with your own key.') };
		}
		var salt = hex(crypto.getRandomValues(new Uint8Array(SALT)));
		var mine = await DaimondIdentity.publicKeyRaw();
		var gid  = await deriveId(hex(mine), salt);
		if (!gid) return { ok: false, why: tOr('group.err_no_id',
			'This device could not name a group.') };
		return await roster(gid, salt, name, keys, []);
	}

	/// Replace a group's membership and send the new roster.
	///
	/// `keys` is the WHOLE membership, not a delta. A snapshot converges with no
	/// ordering machinery because there is exactly one writer — the creator — so
	/// the higher `at` is simply the later roster. A delta stream would need gap
	/// detection and a story about a missing op, for a group that changes twice a
	/// year.
	async function setMembers(gid, name, keys) {
		var rec = await get(gid);
		if (!rec) return { ok: false, why: tOr('group.err_unknown',
			'This device does not know that group.') };
		var mine = await DaimondIdentity.publicKeyRaw();
		if (!mine || hex(mine) !== rec.creator) {
			return { ok: false, why: tOr('group.err_not_creator',
				'Only the person who made a group can change who is in it.') };
		}
		var keep = {}, i;
		for (i = 0; i < keys.length; i++) keep[String(keys[i]).toLowerCase()] = 1;
		var dropped = rec.members.filter(function (m) { return !keep[m.k]; })
			.map(function (m) { return m.k; });
		return await roster(gid, rec.salt, name == null ? rec.name : name, keys, dropped);
	}

	/// Compose one roster, apply it here, and send it.
	///
	/// `dropped` are members the new roster does not name. THEY ARE SENT IT TOO,
	/// and that is the one place this file spends an envelope on somebody who is
	/// not a member. A removal nobody is told about leaves a person composing
	/// into a group where every reader will refuse them, with nothing on their
	/// screen to explain it. The copy they get proves the second sentence rather
	/// than only asserting it: they can read the roster that does not name them,
	/// and every message they already hold is still there.
	///
	/// `closing` writes the ONE roster that names nobody -- not even its author --
	/// which is how a group is closed. See `isClosed` and `close`.
	async function roster(gid, salt, name, keys, dropped, closing) {
		// A CLOSED GROUP TAKES NO FURTHER ROSTER, asked at the door and not only in
		// `close`: `setMembers` comes through here too, and a membership change to a
		// group that no longer has a membership is a roster no reader would obey
		// (see `consume`). Refusing it here is what turns that silence into a
		// sentence.
		//
		// AND IT IS ONLY THE SENTENCE. Measured, by deleting these five lines: the
		// call still fails, because `consume` refuses the read-back and `roster`
		// refuses any roster it could not apply -- so what moves is the reason, from
		// "this device could not apply the roster it just wrote" to one a reader can
		// act on. Worth having and worth being honest about the size of.
		var was = await get(gid);
		if (isClosed(was)) return { ok: false, why: closedWhy() };
		var mine = await DaimondIdentity.publicKeyRaw();
		var mineHex = hex(mine);
		var dir = {};
		try {
			if (window.DaimondTrust && DaimondTrust.people) {
				(await DaimondTrust.people() || []).forEach(function (p) {
					if (p && p.key && p.enc) dir[String(p.key).toLowerCase()] = p;
				});
			}
		} catch (e) { /* nobody */ }

		keys = keys || [];
		var members = [], seen = {}, missing = [], bad = [], dupes = 0, i;
		// The creator first, always, and from this device's own keys rather than
		// from a card: asking a directory about a key this device holds the other
		// half of is how the two spellings of one key get out of step.
		var myEnc = DaimondIdentity.sealingKeyRaw();
		if (!myEnc) return { ok: false, why: tOr('group.err_no_sealing_key',
			'This device has no sealing key yet, so it cannot make a group.') };
		// EXCEPT WHEN CLOSING, which is the one roster the creator leaves themselves
		// out of. The sealing key is still required: `compose` gives the author
		// their own slot whatever the roster says, so the closing roster is
		// re-readable on this account's other devices exactly as every other is.
		if (!closing) {
			members.push({ k: mineHex, e: hex(myEnc),
				n: (window.DaimondIdentity.displayName && DaimondIdentity.displayName()) || '' });
			seen[mineHex] = 1;
		}

		for (i = 0; i < keys.length; i++) {
			var k = String(keys[i]).toLowerCase();
			// A KEY THAT IS NOT A KEY IS NAMED, NEVER SKIPPED. This line read
			// `if (!isHex(k, 32) || seen[k]) continue;` and dropped both cases on the
			// floor without adding either to `missing`, so a caller who mis-spelled
			// one key was answered `ok:true, members:1, sent:0` -- a group of one,
			// made silently, which is exactly what happened the first time anybody
			// called this by hand. The spelling is carried out in `bad` rather than
			// counted, because a count cannot be corrected and a spelling can.
			if (!isHex(k, 32)) { bad.push(k.slice(0, 72)); continue; }
			// A DUPLICATE IS A DIFFERENT CASE AND IS NOT AN ERROR. Naming somebody
			// twice, or naming yourself, asks for a roster this one already is: the
			// caller gets the membership they asked for, so it is counted and
			// reported and refuses nothing. Reporting it as a fault would refuse a
			// group over a request that was already granted.
			if (seen[k]) { dupes++; continue; }
			var p = dir[k];
			if (!p || !p.enc) { missing.push(k); continue; }
			seen[k] = 1;
			members.push({ k: k, e: String(p.enc).toLowerCase(), n: String(p.label || '') });
		}
		if (members.length > MEMBERS_MAX) {
			return { ok: false, why: tOr('group.err_too_many',
				'A group can hold at most {n} people.', { n: MEMBERS_MAX }) };
		}
		// A KEY THAT COULD NOT GO IN REFUSES THE ROSTER, and both arrays come back
		// so the caller can tell the two faults apart: `missing` is somebody real
		// whose code has not been scanned, `bad` is a spelling that is not a key at
		// all.
		//
		// TWO SENTENCES, BECAUSE THERE ARE TWO REPAIRS -- correct the spelling, or
		// scan a code -- which is `shortfall`'s own rule about two lists in one
		// answer. It was one sentence, `group.err_no_card` counting
		// `bad.length + missing.length`, and that arithmetic made the sentence
		// FALSE: one mis-typed key and one uncarded person read as "no sealing key
		// for 2 of the people chosen", sending the reader to scan a code for a
		// typing mistake. `{n}` is now the number the sentence is actually about.
		//
		// `group.err_bad_keys` IS PLURAL BECAUSE `bad` IS AN ARRAY. The singular
		// `group.err_bad_key` with its one `{k}` could not say what happened --
		// `create('x', ['ABC…zz', 'not-a-key'])` refuses with two entries -- so it
		// is gone rather than kept for a caller that does not exist. `{who}` is a
		// joined list in the register `post.group_refused` already uses, and it
		// carries the SPELLINGS, because a spelling is the thing that can be
		// corrected and a count is not.
		if (bad.length || missing.length) {
			if (bad.length) log('keys that are not keys, refused', bad);
			var why = '';
			if (bad.length) {
				why += tOr('group.err_bad_keys', 'These are not keys: {who}.',
					{ who: bad.join(', ') });
			}
			if (missing.length) {
				why += (why ? ' ' : '') + tOr('group.err_no_card',
					'There is no sealing key for {n} of the people chosen, so they cannot '
					+ 'be added. Scan their code first.', { n: missing.length });
			}
			return { ok: false, bad: bad, missing: missing, why: why };
		}

		// Everybody the roster is sent to: the new membership, plus anybody it
		// drops. The creator's own copy is post.js's Sent slot and is not a
		// delivery.
		var reach = members.filter(function (m) { return m.k !== mineHex; })
			.map(function (m) { return { k: m.k, e: m.e }; });
		for (i = 0; i < dropped.length; i++) {
			var was = null, j;
			for (j = 0; j < members.length; j++) { if (members[j].k === dropped[i]) was = 1; }
			if (was) continue;
			var old = dir[dropped[i]];
			if (old && old.enc) reach.push({ k: dropped[i], e: String(old.enc).toLowerCase() });
		}

		var body = opBody(salt, name, members);
		var made;
		try {
			made = await DaimondPost.compose({
				body:  body,
				group: { id: unhex(gid), enc: reach.map(function (r) { return unhex(r.e); }) },
			});
		} catch (e) { return { ok: false, why: String(e && e.message || e) }; }

		// APPLIED HERE THROUGH THE SAME DOOR AN ARRIVING ONE TAKES. The creator's
		// own copy comes back off the relay eventually, but a group that did not
		// exist until a round trip completed would be a group a person could
		// press twice. Reading the artefact back rather than writing the record
		// straight means there is one path that turns a roster into a record, and
		// a bug in it shows up for the creator first.
		//
		// AND A ROSTER THIS DEVICE DID NOT APPLY IS NOT SENT. The answer used to be
		// a log line, so a read-back that failed left the caller holding `ok:true`
		// for a group that is in nobody's record -- the same shape as the malformed
		// key above, one function further down. `consume` answering false is the
		// same failure as it throwing: either way this device would be fanning out
		// a roster it does not itself hold, and would then refuse every message
		// sent to the group it had just announced.
		try {
			var got = JSON.parse(DaimondPost.bridgeRead(made.artefact));
			got.address = got.address || made.addr;
			if (!await consume(got)) {
				throw new Error('this device could not apply the roster it just wrote,'
					+ ' so it was not sent');
			}
		} catch (e) {
			log('the creator could not read back their own roster', e);
			return { ok: false, why: String(e && e.message || e) };
		}

		var sent = await DaimondPost.fanout(made, reach.map(function (r) { return pubOf(r.k); }));
		await draw();
		// The composed roster comes back with the answer. A caller carrying it by
		// hand -- a verifier proving this works between three devices with no
		// server in the path -- must carry the SAME bytes the fan-out sent, not a
		// second composition of the same roster.
		// `refused` is drawn by the caller through `shortfallWords`, and `dupes`
		// counts the keys that were already in the roster -- a request that was
		// granted rather than a fault, so it is reported and refuses nothing.
		return { ok: true, gid: gid, sent: sent.sent, refused: sent.refused,
			dupes: dupes, members: members.length, addr: made.addr,
			envelope: made.envelope };
	}

	/// Close a group for everybody, and tell everybody who was in it.
	///
	/// THE CREATOR'S ACT, AND THE ONLY IRREVERSIBLE ONE IN THIS FILE. It writes the
	/// roster that names nobody, which every reader obeys and no later roster can
	/// undo (see `isClosed` and `consume`). Nothing is deleted anywhere: every
	/// member keeps every message they hold, and the record stays on the list so the
	/// transcript still has a name over it.
	///
	/// EVERYBODY WHO WAS IN IT IS SENT IT, through the same door a removal takes:
	/// the whole old membership is handed to `roster` as `dropped`, so each of them
	/// gets the roster that closes the group rather than finding out by writing into
	/// it and having every reader refuse them. A member whose card this device no
	/// longer holds cannot be sealed to and so is not told -- the same limit the
	/// removal path has, and for the same reason.
	async function close(gid) {
		var rec = await get(gid);
		if (!rec) return { ok: false, why: tOr('group.err_unknown',
			'This device does not know that group.') };
		if (isClosed(rec)) return { ok: false, why: closedWhy() };
		var mine = await DaimondIdentity.publicKeyRaw();
		if (!mine || hex(mine) !== rec.creator) {
			// Its own sentence rather than `group.err_not_creator`, which is about
			// changing who is in a group. Closing one is not a membership change and
			// being told it is sends the reader looking for a control that is not the
			// one they pressed.
			return { ok: false, why: tOr('group.err_close_not_creator',
				'Only the person who made a group can close it.') };
		}
		var told = rec.members.map(function (m) { return m.k; });
		return await roster(gid, rec.salt, rec.name, [], told, true);
	}

	/// Accept an invitation. Nothing earlier arrives with it, and the row said so.
	///
	/// A CLOSED GROUP CANNOT BE JOINED, and the guard is at the door rather than
	/// only on the control: the panel draws no Join on a closed row, but a panel is
	/// one caller, and a device that adopted the empty roster with an older
	/// `stateAt` (see `accepts`) would otherwise be one press from `joined` on a
	/// group nothing can be sent to.
	async function join(gid) {
		var rec = await get(gid);
		if (!rec) return false;
		if (isClosed(rec)) return false;
		if (rec.state === STATE.JOINED) return true;
		rec.state   = STATE.JOINED;
		rec.stateAt = Date.now();
		await put(gid, rec);
		// Messages that arrived while the invitation was open were sealed to this
		// device and are its own; the tray was holding them until the invitation
		// was answered, exactly as it holds a stranger's first message.
		try { if (window.DaimondPost && DaimondPost.untrayGroup) await DaimondPost.untrayGroup(gid); }
		catch (e) { /* no post module */ }
		await draw();
		return true;
	}

	/// Leave, or decline. Local, and it tells nobody: the same reasoning Ignore
	/// is silent under. Nothing already held is deleted.
	///
	/// A GROUP THIS ACCOUNT MADE CANNOT BE LEFT, and the guard is here rather than
	/// only on the control that draws it. `left` is a state the creator's own next
	/// roster contradicts -- `roster` names them in everything it writes and
	/// `consume` reads authorship -- so the press would appear to work and the
	/// next membership change would silently undo it. The invariant is worth more
	/// at the door than in the panel: a panel is one caller.
	///
	/// AND A CLOSED GROUP CANNOT BE LEFT EITHER, because there is nothing left to
	/// leave: the closing roster already put this account out of it, on every device
	/// that holds the roster. A press that wrote `left` again would move a stamp and
	/// nothing else, and answering true for it would tell the caller an act happened.
	async function leave(gid) {
		var rec = await get(gid);
		if (!rec) return false;
		if (isClosed(rec)) return false;
		if (authoredBy(rec, await whoAmI())) return false;
		rec.state   = STATE.LEFT;
		rec.stateAt = Date.now();
		await put(gid, rec);
		await draw();
		return true;
	}

	// ── The panel ──────────────────────────────────────────────
	//
	// Drawn INSIDE post.js's own region, because the Social panel's views belong
	// to improve.js and a third view would be an edit to a file this lane does
	// not own. post.js calls `draw` once from its `render`, so a language change
	// and a collect both reach this without a second surface registration.

	/// Where post.js parks this section, set by `mount`.
	var _host = null;

	function elt(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = String(text);
		return e;
	}

	/// A group's name, drawn as the claim it is: the creator chose it, so it is
	/// shown beside the first eight characters of the id, which nobody chose.
	function title(rec) {
		var name = rec.name || tOr('group.unnamed', 'A group');
		return name + ' · ' + String(rec.gid).slice(0, 8);
	}

	/// THE FIRST OF THE TWO SENTENCES, and it is on the invitation rather than
	/// after the press, because after the press it is an explanation and before
	/// it is a fact somebody can act on.
	function joiningSentence() {
		return tOr('group.joining_shows_nothing',
			'Joining shows you nothing that was sent before you join. Those messages '
			+ 'were never sealed to your key, so no device can open them for you.');
	}

	/// THE SECOND, beside the control that drops somebody, before it is pressed.
	/// The control itself says "stop sending to" and never "remove", because
	/// "remove" reads as though something is taken back and nothing is.
	function removingSentence() {
		return tOr('group.removing_retracts_nothing',
			'Taking somebody out takes nothing back. They keep every message already '
			+ 'sent to them; they will not receive anything sent from now on.');
	}

	/// THE THIRD, beside the control that closes a group, before it is pressed --
	/// and again inside the confirmation dialogue, because a sentence read once on
	/// the way past is not consent for something that cannot be undone.
	function closingSentence() {
		return tOr('group.close_note',
			'Closing a group closes it for everybody. Nobody can write to it again, '
			+ 'you included; every message already sent stays where it is. It cannot '
			+ 'be undone.');
	}

	/// Draw the whole section into the host post.js gave this file.
	async function draw() {
		if (!_host) return 0;
		_host.textContent = '';
		var g = await all();
		if (!g) return 0;			// locked; post.js has already said so

		// Whether this account made a group is asked ONCE, here, rather than
		// inside a row: the answer is a key comparison and a row that asked it
		// would be a row that has to be asynchronous to draw.
		var mineHex = await whoAmI();

		var rows = Object.keys(g).map(function (k) { return g[k]; })
			.sort(function (a, b) { return ms(b.at) - ms(a.at); });
		// CLOSED IS ASKED BEFORE THE STATE, so a closed group cannot be drawn as an
		// invitation or as a group somebody may write to whatever the local half
		// says. `consume` moves that half to `left` when the closing roster lands,
		// but the two halves merge on separate clocks (see `accepts`) and the
		// roster is the half that carries the closing.
		var closed = rows.filter(isClosed);
		var open   = rows.filter(function (r) { return !isClosed(r); });

		// AND THE LOCAL HALF IS SETTLED WHERE IT DISAGREES, because ONE READER OF
		// THIS RECORD IS NOT IN THIS FILE: `post.js` `joinedGroups` builds the
		// recipient picker from `state === 'joined'` alone, so a record left saying
		// `joined` over an empty roster offers a destination that `sealTo` then
		// refuses -- a control that cannot do what it says, which this panel
		// deliberately does not draw anywhere else. Writing it here rather than in
		// `adopt` keeps the repair in the file that owns what a group record means.
		// The picker is drawn in the same pass as this, so it goes right on the NEXT
		// render; the sentence in between is `group.err_closed`, which is the true
		// one either way.
		var settle = closed.filter(function (r) { return r.state !== STATE.LEFT; });
		for (var s = 0; s < settle.length; s++) {
			settle[s].state   = STATE.LEFT;
			settle[s].stateAt = ms(settle[s].at);
			await put(settle[s].gid, settle[s]);
		}
		// After the settle, because `put` strips this flag off the record it is
		// handed and a row drawn without it is a row whose author sees nothing.
		rows.forEach(function (r) { r.iAmCreator = authoredBy(r, mineHex); });
		var invites = open.filter(function (r) { return r.state === STATE.INVITED; });
		var joined  = open.filter(function (r) { return r.state === STATE.JOINED; });
		var left    = open.filter(function (r) { return r.state === STATE.LEFT; });

		if (invites.length) {
			var isec = elt('section', 'post-tray');
			isec.id = 'group-invites';
			isec.appendChild(elt('h3', null, tOr('group.invites_head', 'Group invitations')));
			invites.forEach(function (r) { isec.appendChild(drawInvite(r)); });
			_host.appendChild(isec);
		}

		// TWO CLASSES, both of them already in improve.css: `post-list` for the
		// padding and `post-tray` for the one rule that styles a section heading.
		// A third class of its own would be a rule to add to a stylesheet this
		// lane does not own, for a heading that already has one.
		var lsec = elt('section', 'post-list post-tray');
		lsec.id = 'group-list';
		lsec.appendChild(elt('h3', null, tOr('group.head', 'Groups')));
		if (!joined.length && !left.length && !closed.length) {
			// Two sentences, because "no groups yet" over a pending invitation is
			// a screen arguing with the row above it.
			lsec.appendChild(elt('p', 'post-empty', invites.length
				? tOr('group.none_joined',
					'None joined yet. Answer the invitation above, or make one below.')
				: tOr('group.none',
					'No groups yet. A group is a list of people a message is sealed to '
					+ 'one by one — there is no shared key, and nothing is kept on the relay.')));
		}
		joined.forEach(function (r) { lsec.appendChild(drawGroup(r)); });
		left.forEach(function (r)   { lsec.appendChild(drawLeft(r)); });
		// A CLOSED GROUP KEEPS ITS PLACE ON THE LIST, and that is not a cosmetic
		// choice: `post.js` `drawMsg` puts the group's NAME over every message of
		// it, read out of this record (`groupRec`). Take the record away and the
		// transcript the feature promises to keep loses the one thing that says
		// which group it was. So closing is not removing, and removing is not
		// offered here -- see the note on `drawClosed`.
		closed.forEach(function (r)  { lsec.appendChild(drawClosed(r)); });
		lsec.appendChild(drawMake());
		_host.appendChild(lsec);
		return rows.length;
	}

	/// An invitation, with the first sentence on it.
	function drawInvite(rec) {
		var row = elt('article', 'post-req');
		row.dataset.gid = rec.gid;
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name', title(rec)));
		row.appendChild(who);
		row.appendChild(elt('p', 'post-body', tOr('group.invited_by',
			'{n} people, invited by the person who made it.', { n: rec.members.length })));
		row.appendChild(elt('p', 'post-audience', joiningSentence()));
		var acts = elt('div', 'post-acts');
		[['group-join',    tOr('group.join', 'Join')],
		 ['group-decline', tOr('group.decline', 'Not now')]].forEach(function (p) {
			var b = elt('button', 'post-btn', p[1]);
			b.type = 'button';
			b.dataset.act = p[0];
			acts.appendChild(b);
		});
		row.appendChild(acts);
		return row;
	}

	/// A group this device is in.
	function drawGroup(rec) {
		var row = elt('article', 'post-msg');
		row.dataset.gid = rec.gid;
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name', title(rec)));
		who.appendChild(elt('span', 'post-fp', tOr('group.count',
			'{n} people', { n: rec.members.length })));
		row.appendChild(who);

		// The roster, on one line. A name is the creator's claim and the eight
		// characters beside it are not, which is the same pairing a card's label
		// and fingerprint are drawn in.
		row.appendChild(elt('p', 'post-body', rec.members.map(function (m) {
			return (m.n || tOr('post.someone', 'Someone new')) + ' · ' + m.k.slice(0, 8);
		}).join('\n')));

		// The creator's own controls. Everybody else sees the roster and no
		// buttons over it, because a control that always refuses explains less
		// than its absence.
		if (rec.iAmCreator) {
			row.appendChild(elt('p', 'post-audience', removingSentence()));
			var acts = elt('div', 'post-acts');
			rec.members.forEach(function (m) {
				if (m.k === rec.creator) return;
				var b = elt('button', 'post-btn', tOr('group.stop_sending',
					'Stop sending to {who}', { who: m.n || m.k.slice(0, 8) }));
				b.type = 'button';
				b.dataset.act = 'group-drop';
				b.dataset.key = m.k;
				acts.appendChild(b);
			});
			row.appendChild(acts);

			// AND THE ONE ACT THAT ENDS IT, which is the creator's alone for the same
			// reason changing the membership is: the id is derived from their signing
			// key, so nobody else can write the roster that closes it. Its own row of
			// controls, under its own sentence, and BELOW the per-member controls --
			// an irreversible act does not sit next to a reversible one.
			row.appendChild(elt('p', 'post-audience', closingSentence()));
			var end = elt('div', 'post-acts');
			var cl = elt('button', 'post-btn', tOr('group.close', 'Close this group'));
			cl.type = 'button';
			cl.dataset.act = 'group-close';
			end.appendChild(cl);
			row.appendChild(end);
		}

		// NOT OFFERED TO THE CREATOR, because `leave` refuses them and would be
		// right to: see its own note. This is the same argument the drop controls
		// above are absent under -- a control that cannot do what it says explains
		// less than its absence -- except that this one is worse than one that
		// always refuses, since it would appear to work until the next roster.
		if (!rec.iAmCreator) {
			var mineActs = elt('div', 'post-acts');
			var lv = elt('button', 'post-btn', tOr('group.leave', 'Leave this group'));
			lv.type = 'button';
			lv.dataset.act = 'group-leave';
			mineActs.appendChild(lv);
			row.appendChild(mineActs);
		}
		return row;
	}

	/// A group this device is no longer in. It stays on the list, with its
	/// messages, because that is the whole of the second sentence: leaving and
	/// being taken out both retract exactly nothing.
	function drawLeft(rec) {
		var row = elt('article', 'post-msg');
		row.dataset.gid = rec.gid;
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name', title(rec)));
		row.appendChild(who);
		row.appendChild(elt('p', 'post-body', tOr('group.gone',
			'You are no longer in this group. Nothing has been taken away: every '
			+ 'message already here stays, and nothing new will arrive.')));
		return row;
	}

	/// A group that has been closed. It keeps its place, with its messages, and it
	/// carries NO CONTROLS AT ALL -- not for the creator either.
	///
	/// COULD IT BE TAKEN OFF THE LIST? Not by this act, and the reason is a fact
	/// about another file rather than a preference: `post.js` `drawMsg` puts the
	/// group's name over every message of it, read out of this record. Delete the
	/// record and a transcript the whole feature exists to preserve is left under
	/// "A group · 3f2a91c4", which is deletion wearing the words of a tidy-up.
	///
	/// So it would be a SECOND act, local to one device, in the register of
	/// `post.js`'s Ignore -- hide the row, keep the record -- and it is not built
	/// here. Closing and hiding answer to different people: closing is the
	/// creator's and reaches everybody, hiding is each reader's own and reaches
	/// nobody. Putting them on one button would let one press mean either.
	function drawClosed(rec) {
		var row = elt('article', 'post-msg');
		row.dataset.gid = rec.gid;
		row.dataset.closed = '1';
		var who = elt('div', 'post-who');
		who.appendChild(elt('span', 'post-name', title(rec)));
		row.appendChild(who);
		row.appendChild(elt('p', 'post-body', tOr('group.closed',
			'This group has been closed by the person who made it. Nothing has been '
			+ 'taken away: every message already here stays, and nobody can write to '
			+ 'it again.')));
		return row;
	}

	/// The box that makes one. A name and a set of people this device holds cards
	/// for, because a member with no card is a member nothing can be sealed to.
	function drawMake() {
		var box = elt('form', 'post-write');
		box.id = 'group-make';
		var who = [];
		try { who = (window.DaimondPost && DaimondPost.people) ? DaimondPost.people() : []; }
		catch (e) { who = []; }
		if (!who.length) {
			box.appendChild(elt('p', 'post-nobody', tOr('group.nobody',
				'There is nobody to put in a group yet. Exchange codes with somebody '
				+ 'in People, and they will be here.')));
			return box;
		}
		var name = elt('input', 'post-to');
		name.id = 'group-name';
		name.type = 'text';
		name.maxLength = NAME_MAX;
		name.placeholder = tOr('group.name_ph', 'What to call this group');
		name.setAttribute('aria-label', tOr('group.name_label', 'The group\'s name'));
		box.appendChild(name);

		var pick = elt('select', 'post-to');
		pick.id = 'group-members';
		pick.multiple = true;
		pick.size = Math.min(6, who.length);
		pick.setAttribute('aria-label', tOr('group.members_label', 'Who is in this group'));
		who.forEach(function (p) {
			var o = elt('option', null, p.label || p.keyHex.slice(0, 8));
			o.value = p.keyHex;
			pick.appendChild(o);
		});
		box.appendChild(pick);

		box.appendChild(elt('p', 'post-audience', joiningSentence()));
		var mk = elt('button', 'post-btn post-send', tOr('group.make', 'Make this group'));
		mk.type = 'submit';
		mk.dataset.act = 'group-make';
		box.appendChild(mk);
		var note = elt('p', 'post-note');
		note.id = 'group-note';
		box.appendChild(note);
		return box;
	}

	function say(text) {
		var n = document.getElementById('group-note');
		if (n) n.textContent = String(text || '');
	}

	/// Everything a roster did not do, borrowed from post.js so that there is one
	/// voice for it.
	///
	/// A ROSTER'S REFUSALS ARE PEOPLE WHO DO NOT KNOW THE GROUP EXISTS, which is
	/// why they cannot be counted and dropped: "Made, and 5 people have been told"
	/// over a fan-out that reached one is a sentence about four people who will
	/// never see a message sent to them. It is the same fault post.js had one
	/// function along -- an `ok:true` beside a count of what failed, and no caller
	/// reading the count -- so it takes the same remedy rather than a second one.
	function shortfallWords(r) {
		try {
			if (window.DaimondPost && DaimondPost.shortfall) return DaimondPost.shortfall(r);
		} catch (e) { /* no post module */ }
		return '';
	}

	/// Ask, once, before closing a group. Answers whether they said yes.
	///
	/// THE APP'S OWN DIALOGUE FRAME, `DaimondCore.confirm`, which is
	/// `daimond.js`'s one modal: `share.js` asks about a stranger's code through
	/// it and `trust.js` borrows `pairing.js`'s overlay rather than writing a
	/// second. A third frame for a third question is how an app ends up with three
	/// ways of asking the same thing and only two of them trapping focus.
	///
	/// NO FRAME, NO CLOSE. The answer to a missing dialogue is `false`, not "go
	/// ahead": the one act in this file that cannot be undone must not happen
	/// because a script did not load. That is the opposite of `share.js`'s `tell`,
	/// which may fail quietly -- it only says something, and nothing turns on it.
	async function askClose(rec) {
		var body = closingSentence() + '\n\n' + tOr('group.close_ask',
			'This closes “{name}” for everybody in it.',
			{ name: rec.name || tOr('group.unnamed', 'A group') });
		try {
			if (window.DaimondCore && typeof DaimondCore.confirm === 'function') {
				return !!await DaimondCore.confirm(body,
					tOr('group.close_ok', 'Close it for everybody'), {
						title: tOr('group.close_title', 'Close this group for everybody?'),
						danger: true,
					});
			}
		} catch (e) { log('the confirmation dialogue would not open', e); }
		log('no dialogue frame, so the group was not closed');
		return false;
	}

	/// Take the region post.js gives this file, and draw into it.
	function mount(host) {
		_host = host || null;
		return draw();
	}

	// ── Wiring ─────────────────────────────────────────────────

	document.addEventListener('click', function (e) {
		var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
		if (!b || String(b.dataset.act).slice(0, 6) !== 'group-') return;
		if (!_host || !_host.contains(b)) return;
		var row = b.closest('[data-gid]');
		var gid = row ? row.dataset.gid : '';
		var act = b.dataset.act;
		e.preventDefault();

		if (act === 'group-join')    { join(gid);  return; }
		if (act === 'group-decline') { leave(gid); return; }
		if (act === 'group-leave')   { leave(gid); return; }
		if (act === 'group-drop') {
			get(gid).then(function (rec) {
				if (!rec) return;
				var keep = rec.members.filter(function (m) {
					return m.k !== rec.creator && m.k !== b.dataset.key;
				}).map(function (m) { return m.k; });
				say(tOr('group.sending_roster', 'Telling everybody…'));
				return setMembers(gid, rec.name, keep).then(function (r) {
					say((r.ok ? tOr('group.roster_sent', 'Done.') : r.why)
						+ shortfallWords(r));
				});
			});
			return;
		}
		if (act === 'group-close') {
			// ONE DIALOGUE, AND THE ACT IS INSIDE ITS ANSWER. Not asked and then done
			// anyway: `askClose` resolving false is the whole of the refusal, so a
			// dismissed dialogue leaves the group exactly as it was.
			get(gid).then(function (rec) {
				if (!rec) return;
				return askClose(rec).then(function (yes) {
					if (!yes) return;
					say(tOr('group.sending_roster', 'Telling everybody…'));
					return close(gid).then(function (r) {
						say((r.ok
							? tOr('group.closed_said',
								'Closed, and {n} people have been told.', { n: r.sent | 0 })
							: r.why) + shortfallWords(r));
					});
				});
			});
			return;
		}
		if (act === 'group-make') {
			var name = document.getElementById('group-name');
			var pick = document.getElementById('group-members');
			var keys = pick ? [].slice.call(pick.selectedOptions || [])
				.map(function (o) { return o.value; }) : [];
			if (!keys.length) {
				say(tOr('group.err_pick', 'Choose at least one person.'));
				return;
			}
			say(tOr('group.making', 'Making the group…'));
			create(name ? name.value : '', keys).then(function (r) {
				say((r.ok
					? tOr('group.made', 'Made, and {n} people have been told.', { n: r.sent | 0 })
					: r.why) + shortfallWords(r));
			});
			return;
		}
	});

	// ── Public surface ─────────────────────────────────────────
	window.DaimondGroup = {
		/// The marker post.js refuses to let a person send.
		MARK:    MARK,
		STATE:   STATE,
		/// The identity of a group, and the whole of its authorisation model.
		deriveId: deriveId,
		/// What post.js asks about an artefact whose `to` is not this key.
		accepts: accepts,
		consume: consume,
		looksLikeOp: looksLikeOp,
		/// Who a message to a group is sealed to and delivered to, and who was
		/// left out. `skipped` is drawn by the caller, never swallowed.
		sealTo:  sealTo,
		/// The acts.
		create:  create,
		setMembers: setMembers,
		join:    join,
		leave:   leave,
		/// The one that cannot be undone. Its confirmation is on the control, not
		/// in here: a caller reaching this has already asked or is a verifier.
		close:   close,
		/// Whether a group's roster names nobody, which is what closed IS.
		isClosed: isClosed,
		/// What is held, for a panel and for a verifier.
		list:    async function () {
			var g = await all();
			if (!g) return [];
			return Object.keys(g).map(function (k) { return g[k]; });
		},
		get:     get,
		/// The panel, hosted inside post.js's own region.
		mount:   mount,
		draw:    draw,
		/// The three sentences, published so a verifier asserts the WORDS that are
		/// drawn rather than a class name that could be drawn empty.
		joiningSentence:  joiningSentence,
		removingSentence: removingSentence,
		closingSentence:  closingSentence,
	};
})();
