/* ============================================================
   Daimond — the persistent desktop peer, seam layer (peer.js)
   ------------------------------------------------------------
   Step 1 of dev/PEER_DESIGN.md: PROVE THE SEAM. One tab seals a
   small errand envelope to its OWN account and drops it in the
   post box; a second tab of the same account collects it, runs
   the ordinary turn, folds the answer into the transcript and
   pushes the parcel; the first tab collects the answer by the
   ordinary sync merge. This module is the client-only glue for
   that, and NOTHING here is a gateway change: an errand and a
   report ride the same `/api/post` door a message does, sealed
   with the same seal, read only by the account that holds the key.

   ── WHAT THIS LAYER OWNS, AND WHAT IT DOES NOT ──────────────

   It OWNS the envelope shapes (errand, report), the self-seal to
   the account's own sealing key, the open that only the account
   can perform, and the route-by-type a collector does. It also
   owns the ONE fold the peer's result needs -- an assistant
   message appended under the turn's id -- which §3.1 of the
   design calls "an append, so it merges with nothing new".

   It does NOT own the transport (the raw put and the collect are
   DaimondPost's, injected here so step 1 needs no post.js edit --
   see the recommendation for step 2 at the foot of the design),
   the turn engine (`runTurn`, injected), or the parcel merge
   (sync.js / daimond.js `mergeMessages`, which unions this fold
   in unchanged). The lease is STEP 3 and is deliberately absent:
   step 1 assumes a single peer, so a double run is not yet a
   concern -- the point here is only that the errand travels,
   seals, opens to the same account ALONE, runs, and merges back.

   ── THE SEAL, REUSED NOT REINVENTED ─────────────────────────

   The envelope is sealed with `DaimondPost.seal` (post.js:291) to
   a single recipient: the account's OWN sealing key,
   `DaimondIdentity.sealingKeyRaw()`. That is exactly the self-slot
   `compose` already adds to every message so a Sent copy opens on
   the account's other devices (post.js:539-546). The gateway names
   no recipient in the clear and a reader trial-decrypts, so the
   gateway learns only that an account posted to itself.

   Attaches one global, `window.DaimondPeer`.
   ============================================================ */
(function () {
	'use strict';

	// The schema version the errand and report carry. Bumped when a field's
	// meaning changes, so a peer never runs an envelope it half-understands.
	var ENVELOPE_V = 1;

	var T_ERRAND = 'errand';	// a turn dispatched to a peer
	var T_REPORT = 'report';	// a peer's account of how the turn went

	// ── Bytes and text ─────────────────────────────────────────

	function utf8(s)   { return new TextEncoder().encode(String(s)); }
	function fromUtf8(b) { return new TextDecoder().decode(b); }

	/// Standard base64 of some bytes, and back. The seal hands base64 across the
	/// wire, so the envelope does too.
	function b64enc(bytes) {
		var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		var s = '';
		for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
		return btoa(s);
	}
	function b64dec(s) {
		var raw = atob(String(s));
		var out = new Uint8Array(raw.length);
		for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
		return out;
	}

	// The peer envelope is sealed with the account's SHARED symmetric key (the
	// passphrase+salt one every paired device derives), NOT the per-device X25519
	// sealing key. The old per-device seal was the "same account, different sealing
	// key -> silent drop" bug that needed a manual re-pair: a device that lazily
	// minted its own sealing key could not open a sibling's errand even though the
	// account was one. The symmetric key travels whole in the pairing bundle (the
	// salt does), so every device of the account opens it and the gateway -- which
	// never holds it -- opens nothing.
	//
	// The current scheme is `DPY2`: AES-GCM under the account key with the purpose
	// string bound in as additional data, so the ciphertext is cryptographically
	// domain-separated from every other thing sealed under that one key (the parcel,
	// the wrapped keys, the voice) and cannot be opened where any of them is
	// expected. The AAD authenticates the PURPOSE, not the literal tag bytes -- the
	// tag only routes the decrypt -- but that is enough: a body sealed for one
	// purpose fails GCM under another's AAD, so a mis-routed or flipped tag fails to
	// open rather than opening something. The open path also reads a legacy `DPY1`
	// (the same key, no AAD, the first-hour form) and a legacy post.js `DPS1` X25519
	// envelope, so a hand-off in flight across a rollout is never dropped.
	var PEER_AAD    = 'daimond/peer/env/1';						// the envelope's GCM domain
	var SYM_MAGIC   = new Uint8Array([0x44, 0x50, 0x59, 0x32]);	// "DPY2" -- AAD-bound
	var SYM_MAGIC_1 = new Uint8Array([0x44, 0x50, 0x59, 0x31]);	// "DPY1" -- legacy, no AAD

	/// Do the first four bytes match this scheme tag?
	function tagged(bytes, tag) {
		if (!bytes || bytes.length < tag.length) return false;
		for (var i = 0; i < tag.length; i++) {
			if (bytes[i] !== tag[i]) return false;
		}
		return true;
	}

	/// Concatenate byte arrays into one Uint8Array.
	function cat(parts) {
		var n = 0, i;
		for (i = 0; i < parts.length; i++) n += parts[i].length;
		var out = new Uint8Array(n), off = 0;
		for (i = 0; i < parts.length; i++) { out.set(parts[i], off); off += parts[i].length; }
		return out;
	}

	function hex(bytes) {
		var b = (bytes instanceof Uint8Array) ? bytes : new Uint8Array(bytes);
		var s = '';
		for (var i = 0; i < b.length; i++) s += ('0' + b[i].toString(16)).slice(-2);
		return s;
	}

	/// A random 128-bit id, hex. Names one dispatch (`eid`), distinct from the
	/// turn id, so a re-dispatch of the same turn is still a different errand.
	function newId() {
		return hex(crypto.getRandomValues(new Uint8Array(16)));
	}

	function unhex(s) {
		var str = String(s), out = new Uint8Array(str.length / 2);
		for (var i = 0; i < out.length; i++) out[i] = parseInt(str.substr(i * 2, 2), 16);
		return out;
	}

	/// The content address of the sealed bytes: a SHA-256, hex. This is the `addr`
	/// the post body carries beside the envelope -- the relay addresses a row by it
	/// and a re-post of the identical envelope collapses to one row, exactly as a
	/// message's address does (post.js `compose` -> `address`).
	async function addressOf(sealedBytes) {
		var d = await crypto.subtle.digest('SHA-256', sealedBytes);
		return hex(new Uint8Array(d));
	}

	// ── The signature, off the wasm message path ───────────────
	//
	// The seal restricts WHO CAN OPEN the errand to the account (the one slot is
	// the account's own sealing key). It does NOT restrict who can WRITE one: the
	// account's PUBLIC sealing key is on its card and in its QR code, so anyone
	// holding the card could seal an errand to the account and drop it in the box,
	// and the account would open it. A peer that ran that would run a stranger's
	// errand on the account's money. The signature closes exactly that hole: the
	// envelope is signed with the account's PRIVATE signing key, which is on no
	// card, so `verifyEnvelope` accepts only an envelope this account authored.
	//
	// It is a DETACHED signature over the canonical bytes, NOT the wasm
	// `signingInput`/`assemble` path a message takes -- the errand stays off the
	// bridge and out of the message renderer, which is the whole reason it is raw
	// JSON and not a message artefact.

	/// Canonical JSON of a value: object keys sorted, arrays in order, so the
	/// signer and the verifier serialise byte-for-byte the same thing however
	/// their field insertion order happened to differ.
	function canonical(v) {
		if (v === null || typeof v !== 'object') return JSON.stringify(v);
		if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
		var keys = Object.keys(v).sort();
		return '{' + keys.map(function (k) {
			return JSON.stringify(k) + ':' + canonical(v[k]);
		}).join(',') + '}';
	}

	/// The bytes a signature is over: the envelope WITHOUT its own `author`/`sig`,
	/// canonicalised. Both sides compute these identically -- the signer before it
	/// adds the two fields, the verifier after it strips them.
	function signedBytes(obj) {
		var base = {};
		Object.keys(obj).forEach(function (k) {
			if (k !== 'author' && k !== 'sig') base[k] = obj[k];
		});
		return utf8(canonical(base));
	}

	/// Sign an envelope with this account's signing key and answer a copy carrying
	/// `author` (this account's public key, hex) and `sig` (base64, as
	/// `DaimondIdentity.sign` answers).
	async function signEnvelope(obj) {
		if (!window.DaimondIdentity || !window.DaimondIdentity.sign) {
			throw new Error('peer: no identity, so an errand cannot be signed.');
		}
		var author = await window.DaimondIdentity.publicKeyRaw();
		if (!author) throw new Error('peer: this device has no signing key.');
		var sig = await window.DaimondIdentity.sign(signedBytes(obj));	// base64
		var out = {};
		Object.keys(obj).forEach(function (k) { out[k] = obj[k]; });
		out.author = hex(author);
		out.sig    = sig;
		return out;
	}

	/// Whether an envelope was authored by THIS account: the signature verifies
	/// AND `author` is this account's own public key. Both halves matter -- a valid
	/// signature by a stranger's key is a stranger's errand, and an `author` set to
	/// our key with no matching signature is a forgery that named us.
	async function verifyEnvelope(obj) {
		if (!obj || !obj.author || !obj.sig) return false;
		if (!window.DaimondIdentity || !window.DaimondIdentity.verifySig) return false;
		var mine = await window.DaimondIdentity.publicKeyRaw();
		if (!mine || hex(mine) !== String(obj.author)) return false;	// authored by us?
		try { return await window.DaimondIdentity.verifySig(unhex(obj.author), obj.sig, signedBytes(obj)); }
		catch (e) { return false; }
	}

	// ── The envelopes ──────────────────────────────────────────

	/// Build an errand envelope object (not yet sealed). The full §1.1 schema; a
	/// step-1 dispatcher fills only the core (`turnId`, `chatId`, `prompt`,
	/// `model`) and leaves the lease/freshness fields for later steps. The tag `t`
	/// is what the collector routes on, and it lives INSIDE the sealed plaintext,
	/// so the gateway -- which cannot open the seal -- never sees it.
	function makeErrand(f) {
		var o = f || {};
		return {
			t:       T_ERRAND,
			v:       ENVELOPE_V,
			eid:     o.eid || newId(),
			turnId:  String(o.turnId || ''),
			chatId:  String(o.chatId || ''),
			prompt:  String(o.prompt == null ? '' : o.prompt),
			model:   o.model || null,		// { provider, model, url } -- models.js:127-129
			scope:   o.scope || null,		// the workspace fence -- scopeChatTo, daimond.js:17553
			pause:   o.pause || null,		// pause-tree snapshot at dispatch -- §1.1
			parcelVersion: o.parcelVersion | 0,	// the freshness anchor -- §1.3
			deadline:      +o.deadline || 0,	// epoch-ms after which no peer starts (NOT |0: ms overflows 32 bits)
			dispatchedBy:  String(o.dispatchedBy || ''),
			ts:      o.ts || Date.now(),
		};
	}

	/// Build a report envelope object (not yet sealed). §4.4: the report is the
	/// NUDGE, never the answer -- the answer is already in the parcel.
	function makeReport(f) {
		var o = f || {};
		return {
			t:       T_REPORT,
			v:       ENVELOPE_V,
			eid:     String(o.eid || ''),
			turnId:  String(o.turnId || ''),
			chatId:  String(o.chatId || ''),
			status:  String(o.status || 'done'),	// done | refused-spend | error | aborted
			parcelVersion: o.parcelVersion | 0,	// which version already carries the answer
			cost:    o.cost || null,
			why:     o.why ? String(o.why) : '',	// a human sentence for the failure states
			ts:      o.ts || Date.now(),
		};
	}

	// ── Seal, and the open only the account can do ─────────────

	/// Seal one envelope object to the account's SHARED symmetric key and answer the
	/// post body `{ to, addr, envelope }` -- the identical shape `send` posts
	/// (post.js:1127). `to` is the account's own public address; `addr` is the
	/// sealed artefact's address; `envelope` is the base64 sealed bytes.
	///
	/// Every device of the account derives the SAME symmetric key from the passphrase
	/// and the account salt (the salt travels whole in the pairing bundle, identity.js
	/// `exportBundle`), so a peer of the SAME account opens it and the gateway -- which
	/// never holds the key -- opens nothing. This is deliberately NOT the per-device
	/// X25519 sealing key: two siblings of one account can hold different sealing keys
	/// (one was minted lazily after the other paired), and the old per-device seal then
	/// dropped the errand silently, which is why a re-pair was needed to hand off.
	async function sealForSelf(obj) {
		if (!window.DaimondIdentity || !window.DaimondIdentity.wrapBytes) {
			throw new Error('peer: no identity, so there is no key to seal with.');
		}
		if (window.DaimondIdentity.isUnlocked && !window.DaimondIdentity.isUnlocked()) {
			throw new Error('peer: Daimond is locked, so nothing can be sealed for a peer.');
		}
		// Signed BEFORE sealing, so the signature is inside the seal and the gateway
		// -- which cannot open the seal -- never sees author or sig. An envelope
		// already carrying a `sig` (a re-seal) is not signed twice.
		var signed = obj.sig ? obj : await signEnvelope(obj);
		var plain  = utf8(JSON.stringify(signed));
		// The tag rides in front of the AES-GCM `IV || ciphertext` so the open path
		// tells this scheme from a legacy one without a trial decrypt; the purpose
		// (not the tag bytes) is bound in as AAD, which domain-separates this key's
		// uses -- a body for another purpose fails to open here, and vice versa.
		var sealed = cat([SYM_MAGIC, await window.DaimondIdentity.wrapBytesAad(plain, PEER_AAD)]);
		// The delivery address is the account's public key in the BASE64URL form the
		// gateway binds an account to (identity.js:publicKeyB64url). It is NOT the hex
		// of the raw key: the gateway looks a delivery up by the b64url string, so a
		// hex `to` matches no account and every post 404s ("No account holds that key").
		var to = window.DaimondIdentity.publicKeyB64url
			? window.DaimondIdentity.publicKeyB64url() : '';
		return {
			to:       to || '',
			addr:     await addressOf(sealed),
			envelope: b64enc(sealed),
		};
	}

	/// Open a sealed peer body to its plaintext bytes, whichever scheme sealed it:
	/// the current symmetric account key (`DPY1`), or a legacy per-device X25519
	/// envelope (`DPS1`, post.js) still in flight across a rollout. Throws the same
	/// way each underlying open does, so the callers' refusal handling is unchanged.
	/// It DECRYPTS only; `openEnvelope` is where the signature is verified.
	async function openSealed(bytes) {
		// The three schemes are mutually exclusive at byte 0-3, so each tag routes
		// exactly one decrypt and a mis-tagged body fails its own scheme rather than
		// cross-opening another's. DPY2 (current, AAD-bound) and DPY1 (the first-hour
		// legacy, same key, no AAD) both open under this account's symmetric key; a
		// GCM failure is "sealed under a different account key" -- named, not left as
		// a raw OperationError -- the symmetric analogue of post.js's "not for you".
		var sym = tagged(bytes, SYM_MAGIC) ? SYM_MAGIC : (tagged(bytes, SYM_MAGIC_1) ? SYM_MAGIC_1 : null);
		if (sym) {
			if (!window.DaimondIdentity || !window.DaimondIdentity.unwrapBytesAad) {
				throw new Error('peer: no identity, so a sealed peer body cannot be opened.');
			}
			var body = bytes.subarray(sym.length);
			try {
				return sym === SYM_MAGIC
					? await window.DaimondIdentity.unwrapBytesAad(body, PEER_AAD)
					: await window.DaimondIdentity.unwrapBytes(body);	// DPY1 legacy, drop next release
			} catch (e) {
				throw new Error('peer: this errand was not sealed to this account, so it is not for this device.');
			}
		}
		if (!window.DaimondPost || !window.DaimondPost.unseal) {
			throw new Error('peer: the post seal is not loaded, so nothing can be opened.');
		}
		return await window.DaimondPost.unseal(bytes);	// DPS1 legacy X25519
	}

	/// Open a sealed envelope, VERIFY its signature, and answer the parsed object --
	/// or THROW. Two refusals, both about authorship:
	///
	///  - `openSealed` refuses an envelope not sealed under this account's key -- the
	///    same-account-can-OPEN property;
	///  - `verifyEnvelope` refuses one this account did not SIGN -- the
	///    same-account-WROTE-it property, which is what stops a correspondent who
	///    knows our public sealing key from forging an errand into the box.
	///
	/// A caller that wants the object without acting on it -- to inspect a rejected
	/// forgery -- catches the throw; the collector uses `peek`/`absorb` instead.
	async function openEnvelope(b64) {
		var plain = await openSealed(b64dec(b64));
		var obj;
		try { obj = JSON.parse(fromUtf8(plain)); }
		catch (e) { throw new Error('peer: an opened envelope was not an errand or report.'); }
		if (!obj || (obj.t !== T_ERRAND && obj.t !== T_REPORT)) {
			throw new Error('peer: an opened envelope carried no known type tag.');
		}
		if (!(await verifyEnvelope(obj))) {
			throw new Error('peer: an opened envelope was not signed by this account, so it is refused.');
		}
		return obj;
	}

	/// Classify a collected row's sealed body WITHOUT verifying or throwing: unseal
	/// and parse, answer the object if it is a peer envelope (`t` in errand/report),
	/// or null for everything else -- a message artefact (not JSON), a row this
	/// device cannot open, or a shape with no peer tag. This is the cheap peek
	/// `takeRow` does before the message read: a null falls straight through to the
	/// message path unchanged. Verification is deferred to `absorb`, so the peek
	/// stays a classify and nothing more.
	async function peek(b64) {
		var obj;
		try { obj = JSON.parse(fromUtf8(await openSealed(b64dec(b64)))); }
		catch (e) { return null; }
		if (obj && (obj.t === T_ERRAND || obj.t === T_REPORT)) return obj;
		return null;
	}

	// The registered runners, set by daimond.js (step 4/5). Absent here, `absorb`
	// verifies and drops -- routing without a runner is a no-op, not a crash.
	var _onErrand = null;
	var _onReport = null;
	function onErrand(fn) { _onErrand = fn; }
	function onReport(fn) { _onReport = fn; }

	/// Verify a peeked envelope and, if it was authored by this account, hand it to
	/// the registered runner. An envelope that does not verify is DROPPED with a
	/// note, never run -- that is the forged-errand defence, applied at the one door
	/// the collector routes through. Answers `{ routed, verified }`.
	async function absorb(obj, row) {
		var verified = await verifyEnvelope(obj);
		if (!verified) {
			if (window.console) console.log('peer: a ' + obj.t + ' failed signature check; dropped.');
			return { routed: false, verified: false };
		}
		// The errand runner's answer is propagated so takeRow can read a stand-down:
		// a non-nominee that deferred to the awake nominee (`why:'nominee'`) must leave
		// the errand on the relay (HOLD), not ack it away before the nominee collects.
		var result = null;
		if (obj.t === T_ERRAND && _onErrand) result = await _onErrand(obj, row);
		else if (obj.t === T_REPORT && _onReport) await _onReport(obj, row);
		return { routed: true, verified: true, result: result };
	}

	/// Route the post box's rows the way a collector does: open each, dispatch by
	/// the sealed `t` tag. A row that is not ours to open, or is an ordinary
	/// message, is handed to `onOther` rather than dropped -- the collector still
	/// owes it to the message list. Answers a small tally, so a caller adds rather
	/// than branches.
	///
	/// This mirrors `takeRow`'s routing (post.js:1322), and is retained as the
	/// direct-drive door a test uses; the real collect path goes through
	/// `takeRow` -> `peek` -> `absorb` (post.js, step 2). Unlike `absorb`, this
	/// verifies via `openEnvelope` (which throws on a bad signature), so a forgery
	/// lands in `onOther`.
	async function routeRows(rows, handlers) {
		var h = handlers || {};
		var tally = { errands: 0, reports: 0, other: 0, unopened: 0 };
		var list  = rows || [];
		for (var i = 0; i < list.length; i++) {
			var row = list[i];
			var obj = null;
			try { obj = await openEnvelope(row.envelope); }
			catch (e) {
				// Not ours, not JSON, or an ordinary message: hand it on untouched.
				tally.other++;
				if (h.onOther) await h.onOther(row, e);
				continue;
			}
			if (obj.t === T_ERRAND) {
				tally.errands++;
				if (h.onErrand) await h.onErrand(obj, row);
			} else if (obj.t === T_REPORT) {
				tally.reports++;
				if (h.onReport) await h.onReport(obj, row);
			}
		}
		return tally;
	}

	// ── The one fold the result needs ──────────────────────────

	/// Fold a peer's answer into a chat's transcript as an APPEND. §3.1: an errand
	/// result is a new assistant message on an existing chat -- a pure append -- so
	/// the parcel's append-only union takes it with no new rule. The message
	/// carries `iturn` = the turn id, which is what lets the phone's own tombstone
	/// path (§2.6, daimond.js:11796,11808) displace its "dispatched" placeholder
	/// rather than sit a duplicate beside the answer.
	///
	/// Mints a fresh `mid` the same shape daimond.js mints (`newMid`,
	/// daimond.js:968): time-in-base36 plus a random tail, so the union keys on it
	/// and never duplicates the message across a re-pull.
	function foldAssistant(chat, f) {
		var o = f || {};
		if (!chat.messages) chat.messages = [];
		var msg = {
			mid:    o.mid || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9)),
			role:   'assistant',
			content: String(o.text == null ? '' : o.text),
			iturn:  String(o.turnId || ''),
			model:  o.model || null,
			ts:     o.ts || Date.now(),
		};
		chat.messages.push(msg);
		chat.updatedAt = msg.ts;
		return msg;
	}

	// ── The dispatcher (dev/PEER_DESIGN.md §4.1) ───────────────
	//
	// STEP 4. The phone can only dispatch while awake -- sealing, signing and
	// posting all need the JS context running. `buildDispatch` is the PURE core: it
	// assembles the full errand and fixes the STRICT ORDER, and daimond.js does only
	// the thin wiring that runs that order. The order is load-bearing (§4.1): the
	// prompt parcel is pushed FIRST so a peer can never claim an errand whose prompt
	// it cannot yet read, the local turn is marked peer-held SECOND, and the errand
	// is posted LAST, carrying the version the prompt push returned.

	var DISPATCH_DEADLINE_MS = 15 * 60 * 1000;	// no peer should start a turn older than this
	var REASON_DISPATCHED    = 'dispatched';	// the interrupted-reason, beside 'offline'/'unloading'

	// The ordered step tags. The SEQUENCE is the safety property, so it is data a
	// test can assert, not just the shape of the wiring.
	var STEP_PUSH_PROMPT   = 'push-prompt';		// push the prompt parcel, capture parcelVersion
	var STEP_MARK_DISPATCH = 'mark-dispatched';	// mark the local turn why:'dispatched'
	var STEP_POST_ERRAND   = 'post-errand';		// seal + post the errand carrying that version

	/// Assemble a dispatch. PURE: it reads `chat` and the raw materials in `opts`
	/// (already gathered by daimond.js -- the turn id, the prompt, the scope from
	/// `scopeChatTo`, a `DaimondPause.snapshot()` pinned to this moment, the chat's
	/// model, this device's id) and answers the ordered plan plus a `errand(version)`
	/// finaliser. It does NO I/O, so the order and the whole envelope are testable
	/// without the app. `parcelVersion` is NOT known until the push returns, so the
	/// errand is finalised by the caller once it has it.
	function buildDispatch(chat, opts) {
		var o = opts || {}, c = chat || {};
		var now      = o.now || Date.now();
		var turnId   = String(o.turnId || '');
		var chatId   = String(o.chatId || c.id || '');
		var eid      = o.eid || newId();
		var prompt   = String(o.prompt == null ? '' : o.prompt);
		// The peer must run the model the CHAT chose, not the peer's own default.
		var model    = o.model || { provider: c.provider || '', model: c.model || '', url: String(o.url || '') };
		var scope    = o.scope || null;			// the workspace fence -- scopeChatTo, daimond.js:17553
		var pause    = o.pause || null;			// pause-tree snapshot pinned to dispatch -- §1.1
		var deadline = leaseMs(o.deadline) || (now + DISPATCH_DEADLINE_MS);
		var by       = String(o.dispatchedBy || '');
		return {
			order:  [STEP_PUSH_PROMPT, STEP_MARK_DISPATCH, STEP_POST_ERRAND],
			turnId: turnId, chatId: chatId, eid: eid,
			// What daimond.js writes on the local turn BETWEEN the push and the post,
			// so recoverInterrupted and Continue treat it as peer-held, not a local
			// interruption (§3.3). The runner/guards consult it in step 6.
			mark: { interrupted: true, why: REASON_DISPATCHED, iturn: turnId, itext: prompt, dispatchedBy: by },
			/// Finalise the errand once the prompt push has returned its version.
			errand: function (parcelVersion) {
				return makeErrand({
					eid: eid, turnId: turnId, chatId: chatId, prompt: prompt, model: model,
					scope: scope, pause: pause, parcelVersion: parcelVersion,
					deadline: deadline, dispatchedBy: by, ts: now,
				});
			},
			// The fully-resolved fields (bar parcelVersion), exposed for inspection.
			fields: {
				turnId: turnId, chatId: chatId, prompt: prompt, model: model, scope: scope,
				pause: pause, deadline: deadline, dispatchedBy: by, eid: eid,
			},
		};
	}

	/// What a turn marked `why:'dispatched'` should be treated as, given the lease.
	/// The pure decision recoverInterrupted and the Continue button consult (§3.3,
	/// wired in step 6):
	///  - `not-dispatched` -> an ordinary turn, ordinary recovery;
	///  - `peer-held`      -> a LIVE FOREIGN lease holds it: do NOT recover locally,
	///    show "running on your other device";
	///  - `reclaimable`    -> the lease is vacant/expired or ours: recover locally /
	///    offer Continue.
	function dispatchState(turn, leaseRec, selfId, now) {
		if (!turn || turn.why !== REASON_DISPATCHED) return 'not-dispatched';
		var n = now == null ? Date.now() : now;
		if (liveLease(leaseRec, n) && leaseRec.holder !== String(selfId)) return 'peer-held';
		return 'reclaimable';
	}

	/// The §5 DISPLAY state of a dispatched turn, for the phone's UI. Pure, so the
	/// renderer only draws what this decides. `turn` is the local dispatched turn,
	/// `lease` its lease record (or null), `report` a collected report envelope for
	/// it (or null), `selfId` the viewing device.
	///   dispatched     -- posted, no lease seen yet: "Sent to your other devices."
	///   no-peer-awake  -- deadline passed, no lease ever taken: "No awake device…"
	///   claimed        -- lease mode 'claimed': "<machine> is picking this up."
	///   running        -- lease mode 'running': "<machine> is doing this. [Take back]"
	///   done           -- report status 'done': the answer, the badge clears
	///   failed         -- report a failure, OR the lease expired mid-run with no
	///                     report (the peer stopped): the `why` sentence + [Run here]
	function uiState(turn, lease, report, selfId, now) {
		if (!turn || turn.why !== REASON_DISPATCHED) return 'not-dispatched';
		var n = now == null ? Date.now() : now;
		// A report settles it either way, and outlives the lease.
		if (report && report.t === 'report') {
			return report.status === 'done' ? 'done' : 'failed';
		}
		// No report yet: read the lease.
		if (liveLease(lease, n)) {
			return lease.mode === 'running' ? 'running' : 'claimed';
		}
		// A lease that was taken then expired without a report is a peer that
		// stopped mid-run (§6): failed, offer a local re-run.
		if (lease && lease.mode !== 'released') return 'failed';
		// No live lease and none reported: waiting, or nobody picked it up in time.
		var deadline = leaseMs(turn.deadline);
		if (deadline && n > deadline) return 'no-peer-awake';
		return 'dispatched';
	}

	/// Should the DISPATCHING device RECOVER this turn locally now (on its return to
	/// the foreground)? Pure. A backgrounded phone cannot run the deadline fallback,
	/// so on return it must run any turn that was dispatched but that NO peer ran, or
	/// the user comes back to nothing -- the reported "complete and utter failure".
	///
	/// Recover when the turn is `dispatched`, is NOT finished (no done report, no
	/// merged answer -- the app supplies this as `finished`), and is NOT held by a
	/// LIVE FOREIGN lease. A live foreign lease means a peer IS on it: leave it, and
	/// let the answer sync back (or the user take it back by hand). An expired lease,
	/// no lease, or our own lease is reclaimable. This only decides whether to TRY;
	/// the take-if-vacant lease is the money-safe arbiter at run time, so a peer that
	/// claims between this decision and the local take still wins (and vice-versa).
	function recoverDecision(turn, lease, finished, selfId, now) {
		if (!turn || turn.why !== REASON_DISPATCHED) return false;
		if (finished) return false;
		var n = now == null ? Date.now() : now;
		if (liveLease(lease, n) && lease.holder !== String(selfId)) return false;	// a peer is on it
		return true;
	}

	// ── Presence (dev/PEER_DESIGN.md §4.2, §7 step 7) ──────────
	//
	// Each AWAKE, visible Daimond writes a heartbeat into the parcel so the phone
	// knows which of its devices could take a turn -- and can NAME the machine
	// ("waiting for argonaut"). Unlike the lease, presence is genuinely
	// last-writer-wins: the freshest `lastSeen` per device is the truth, so it uses
	// the FRESHEST-SCALAR merge (like the pause tree), NOT take-if-vacant. A stale
	// beat is safe: the deadline and the lease catch a peer that actually slept, so
	// the worst a stale beat costs is one dispatch that finds no runner and falls to
	// `no-peer-awake` -- never a double run.

	var PRESENCE_BEAT_MS  = 45000;		// write a beat about this often while visible
	var PRESENCE_FRESH_MS = 120000;		// a beat older than this is not "awake" (≈ 2 min)
	// The window the auto-dispatch DECISION uses -- deliberately TIGHTER than the
	// display window above, and well under the gateway's 5-min presence TTL. A beat
	// is written every 45 s, so two beats plus slack is a peer that is genuinely
	// still beating; a peer last seen longer ago than this is treated as gone and
	// the turn runs locally, rather than dispatched to a device that may have died
	// since its last beat. The display can afford to name a peer as "awake" for
	// longer; a DISPATCH cannot, because a dispatch into a dead peer is an orphan
	// (the recovery-on-return catches it, but the tighter window avoids most).
	var DISPATCH_FRESH_MS = 90000;		// a peer beat older than this is not dispatched to (≈ 1.5 min)

	var _presence = {};					// deviceId -> { name, lastSeen }

	/// The freshest peer in a presence map that is NOT this device and whose beat is
	/// within the window, or null. The one pure helper both the UI and the
	/// auto-dispatch decision read, so "which peer is awake" has ONE answer.
	function freshestPeer(presence, selfId, now, windowMs) {
		var p = presence || {}, self = String(selfId || ''), n = now == null ? Date.now() : now;
		var w = windowMs || PRESENCE_FRESH_MS, best = null;
		for (var id in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id)) continue;
			if (id === self) continue;
			var rec = p[id];
			if (!rec || (n - leaseMs(rec.lastSeen)) > w) continue;			// stale
			if (!best || leaseMs(rec.lastSeen) > leaseMs(best.lastSeen)) {
				best = { deviceId: id, name: (rec.name || ''), lastSeen: leaseMs(rec.lastSeen) };
			}
		}
		return best;
	}

	/// Record this device's heartbeat. Answers whether the map changed (it always
	/// does -- lastSeen moved -- which is what makes the beat a push).
	function presenceBeat(deviceId, name, now) {
		var id = String(deviceId || '');
		if (!id) return false;
		_presence[id] = { name: String(name || ''), lastSeen: now == null ? Date.now() : now };
		return true;
	}

	/// Merge an arriving parcel's presence FRESHEST-SCALAR: the larger `lastSeen`
	/// per device wins. Called by sync.js's reconcile. Answers whether anything
	/// moved, so a pull that learned nothing schedules no push.
	function presenceAdopt(incoming) {
		if (!incoming) return false;
		var moved = false;
		for (var id in incoming) {
			if (!Object.prototype.hasOwnProperty.call(incoming, id)) continue;
			var inc = incoming[id];
			if (!inc) continue;
			var cur = _presence[id];
			if (!cur || leaseMs(inc.lastSeen) > leaseMs(cur.lastSeen)) {
				_presence[id] = { name: String(inc.name || ''), lastSeen: leaseMs(inc.lastSeen) };
				moved = true;
			}
		}
		return moved;
	}

	/// Ingest an AUTHORITATIVE presence map from the gateway and REPLACE the local
	/// view with it. The gateway is now the source of truth -- presence travels on
	/// its own lightweight, non-waking path, not on the content parcel -- so this is
	/// a replace, not the freshest-scalar merge `presenceAdopt` does.
	///
	/// `serverMap` is deviceId -> { name, last_seen } with `last_seen` and
	/// `serverNow` both stamped in the SERVER clock. Each `last_seen` is converted
	/// into THIS client's frame -- `last_seen - (serverNow - now_at_receipt)` -- so
	/// every existing freshness check that reads `Date.now()` (`awake`,
	/// `freshestPeer`) keeps working unchanged and is immune to cross-device clock
	/// skew. Answers whether the view moved, so a caller can skip a redraw that
	/// learned nothing.
	function presenceIngest(serverMap, serverNow) {
		var recv = Date.now();
		var skew = leaseMs(serverNow) - recv;	// how far the server clock leads ours
		var next = {}, map = serverMap || {};
		for (var id in map) {
			if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
			var rec = map[id];
			if (!rec) continue;
			// The wire field is `last_seen`; tolerate `lastSeen` in case a caller
			// hands an already-client-framed record straight in.
			var seen = leaseMs(rec.last_seen != null ? rec.last_seen : rec.lastSeen);
			next[String(id)] = { name: String(rec.name || ''), lastSeen: seen - skew };
		}
		var before = JSON.stringify(_presence);
		_presence = next;
		return JSON.stringify(_presence) !== before;
	}

	/// The section as it rides the parcel, or null when empty.
	function presenceSnapshot() {
		return Object.keys(_presence).length ? _presence : null;
	}

	/// The awake peers (not this device), freshest first, for the UI.
	function presenceAwake(selfId, now, windowMs) {
		var p = _presence, self = String(selfId || ''), n = now == null ? Date.now() : now;
		var w = windowMs || PRESENCE_FRESH_MS, out = [];
		for (var id in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id)) continue;
			if (id === self) continue;
			if ((n - leaseMs(p[id].lastSeen)) > w) continue;
			out.push({ deviceId: id, name: p[id].name || '', lastSeen: leaseMs(p[id].lastSeen) });
		}
		out.sort(function (a, b) { return b.lastSeen - a.lastSeen; });
		return out;
	}

	/// This device's name for a peer's deviceId (for "waiting for argonaut"), or ''.
	function presenceName(deviceId) {
		var r = _presence[String(deviceId || '')];
		return (r && r.name) || '';
	}

	function presenceForget() { _presence = {}; }

	window.DaimondPresence = {
		BEAT_MS:  PRESENCE_BEAT_MS,
		FRESH_MS: PRESENCE_FRESH_MS,
		beat:     presenceBeat,
		/// sync.js's section contract -- freshest-scalar, NOT take-if-vacant.
		snapshot: presenceSnapshot,
		adopt:    presenceAdopt,
		/// Replace the local view from the gateway's authoritative map, converting
		/// each last_seen into this client's clock frame (skew-immune). This is the
		/// sync path now -- presence rides its own non-waking gateway route, not the
		/// content parcel -- so it supersedes the freshest-scalar `adopt` above.
		ingest:   presenceIngest,
		/// The awake peers, and one device's name, for the UI and auto-dispatch.
		awake:    presenceAwake,
		name:     presenceName,
		forget:   presenceForget,
	};

	// ── Smart auto-dispatch (dev/PEER_DESIGN.md §4.1, §4.2) ────
	//
	// The pure decision: given the chat, the presence map and the moment, should
	// this turn be handed to a peer, and which one? daimond.js only ACTS on it, at
	// send-time while online, through the already-proven ordered dispatcher. The
	// rules, in order:
	//   - NO fresh peer            -> run locally, never dispatch into the void;
	//   - a per-chat OPT-OUT       -> keep this chat on THIS device (toggle === false);
	//   - the toggle is on         -> hand it off (blanket-when-awake for this chat);
	//   - MOBILE with a peer awake -> hand EVERY turn off (the phone is not where a
	//                                 turn should run when a persistent peer exists;
	//                                 sync brings the answer back). Desktop falls
	//                                 through -- it IS the persistent instance;
	//   - backgrounding in flight  -> hand it off (the phone is about to sleep);
	//   - a long/agentic turn      -> hand it off (tools/worker/expected-long);
	//   - otherwise (quick turn)   -> run locally, for instant streaming.
	//
	// The order is money-safe by construction: the NO-fresh-peer guard is first, so
	// nothing ever dispatches into the void, and the opt-out precedes every "hand it
	// off" rule, so a chat pinned local cannot be routed away by the mobile default.
	// Broadening WHICH turns route changes nothing about HOW routing works -- the
	// single-runner guarantee is the lease's (below), never this decision's.

	/// Decide whether to dispatch, and to whom. Pure. Answers
	/// `{ dispatch, peer, reason }`.
	function autoDispatchDecision(chat, presence, opts, now) {
		var o = opts || {}, c = chat || {};
		var peer = freshestPeer(presence, o.selfId, now, o.freshWindowMs);
		if (!peer) return { dispatch: false, reason: 'no-fresh-peer' };
		// The per-chat choice: true = always hand off, false = keep on THIS device
		// (the opt-out), null/undefined = decide by the policy below.
		var toggle = (o.toggle != null) ? !!o.toggle : null;
		// An explicit opt-out pins the chat here, even on a phone with a peer awake --
		// so it must be tested BEFORE the mobile default and before the global one.
		if (toggle === false) return { dispatch: false, reason: 'chat-local' };
		// The toggle on, or the global default when the chat has not chosen.
		if (toggle === true || o.globalDefault) return { dispatch: true, peer: peer, reason: 'toggle-on' };
		// MOBILE: a persistent peer is awake, so hand EVERY turn off -- quick or
		// agentic -- rather than run it on the phone; the answer syncs back. Desktop
		// (no isPhone) falls through: you are already on the persistent instance.
		if (o.isPhone) return { dispatch: true, peer: peer, reason: 'mobile-peer' };
		// The phone is backgrounding with a turn still in flight -- move the running
		// off it before it suspends.
		if (o.backgrounding && o.turnInFlight) return { dispatch: true, peer: peer, reason: 'backgrounding-in-flight' };
		// A long or agentic turn is worth the round trip; a quick one is not. The
		// worker signal must be a GENUINE one: daimond.js seeds `workerModel`/
		// `workerProvider` to the chat's OWN model for every active chat (newChat,
		// startChat), so `c.workerModel` is truthy on a plain chat and a bare
		// truthiness test dispatched EVERY turn (D2). A worker/Diamond chat is one
		// whose worker pair DIFFERS from the chat's own -- the user deliberately chose
		// a different model to fan work out to; a pair merely mirroring the default is
		// not agentic and stays local for instant streaming.
		var worker = (c.workerModel    && String(c.workerModel)    !== String(c.model    || ''))
			|| (c.workerProvider && String(c.workerProvider) !== String(c.provider || ''));
		var agentic = !!o.toolsEnabled || !!o.expectedLong || !!worker;
		if (agentic) return { dispatch: true, peer: peer, reason: 'long-turn' };
		return { dispatch: false, reason: 'quick-local' };
	}

	// ── The nominated always-on runner (the claim guard) ───────
	//
	// An account may name ONE device as the runner that should pick a dispatched
	// turn up, so a laptop someone closes mid-turn does not race in and grab it.
	// This decides only WHO attempts the lease claim; the take-if-vacant CAS below
	// is still the single-runner arbiter, so a stale or racing decision here can at
	// worst cost one extra claim attempt, never a double run.

	/// Should this device STAND DOWN from claiming a dispatched errand, deferring to
	/// the account's NOMINATED always-on runner? Pure. True only when a nominee is
	/// set, this device is NOT it, AND the nominee is presently, FRESHLY awake in the
	/// presence map -- judged by the SAME tight window a dispatch uses to call a peer
	/// awake (DISPATCH_FRESH_MS). A nominee whose last beat has aged out of that
	/// window is treated as OFFLINE, so this device claims (the owner's fallback: any
	/// awake device, over nobody-runs-it).
	///
	/// Two stalls this guards against, both by construction:
	///   - STALE PRESENCE: a lagging map still showing a slept nominee as awake would
	///     have every fallback stand down for a device that is gone. The freshness
	///     bound is the defence -- an aged beat reads offline and the fallback claims.
	///   - A PERMANENT stand-down: the decision reads LIVE presence and is re-taken on
	///     every re-collect (the errand is HELD on the relay, not acked, while standing
	///     down -- post.js), so a nominee that slept just after its last beat stops
	///     being "fresh" within one window and a fallback then claims. The worst-case
	///     stall is one presence-sync lag plus DISPATCH_FRESH_MS.
	function nominationStandDown(nominatedId, selfId, presence, now, windowMs) {
		var nom = String(nominatedId || '');
		if (!nom) return false;						// no nomination -> first-come, unchanged
		if (nom === String(selfId || '')) return false;	// this device IS the nominee -> claim
		var rec = (presence || {})[nom];
		if (!rec) return false;						// nominee absent from presence -> offline
		var n = now == null ? Date.now() : now;
		var w = windowMs || DISPATCH_FRESH_MS;
		return (n - leaseMs(rec.lastSeen)) <= w;	// stand down only while the nominee is FRESH
	}

	// ════════════════════════════════════════════════════════════
	// THE LEASE — the cross-device claim (dev/PEER_DESIGN.md §2).
	// ------------------------------------------------------------
	// The MONEY-CRITICAL step. `withTurnLock` (daimond.js:17209) is
	// per-origin per-browser: it stops two TABS of one browser running a
	// turn twice, and says nothing about two DEVICES. Two awake desktops
	// would each collect the errand and each bill it. The lease is the
	// cross-device layer above the browser lock, and a wrong version of it
	// is a double bill.
	//
	// It lives in the sync parcel under a `leases` section keyed by turnId,
	// arbitrated by the parcel's compare-and-set. The section is the ONE
	// part of the parcel that is NOT append-only union / freshest-scalar:
	// a lease is a mutable claim, and freshest-scalar is exactly the
	// double-claim bug -- two devices claiming from one base version would
	// each write a lease, and last-write-by-clock could hand it to whichever
	// clock read a microsecond later. So it gets its OWN merge, take-if-
	// vacant, invoked by sync.js through `adopt` the same way every other
	// section's merge is (pause.js, trash.js). With the CAS this is
	// first-writer-by-version-wins.
	// ════════════════════════════════════════════════════════════

	var LEASE_TTL_MS   = 90000;		// a lease past this is vacant (§2.4)
	var RENEW_EVERY_MS = 30000;		// three renews per TTL, so one dropped renew is survivable
	var MAX_TAKE_TRIES = 10;		// bound the CAS retry loop (was 6): more headroom under two-device churn
	var TAKE_BACKOFF_MS = 250;		// jittered wait between take retries so a claim gets a clean window
	// The hard ceiling on how long ONE errand's liveness ticker may run before it gives
	// up and aborts. The ticker is READ-ONLY (it never renews the parcel -- the lease is
	// claimed straight to its deadline, so no renew is needed), so it is not itself a
	// churn source; but a runTurn whose promise never settles would keep the ticker (and
	// the errand) alive indefinitely, so this caps it -- after which the run is aborted
	// best-effort and the lease is left to expire at its deadline. Generous, because it
	// is a backstop for a hung turn, not a turn budget.
	var MAX_LEASE_LIFE_MS = 30 * 60 * 1000;	// 30 min: a turn still 'running' past this is hung, not live

	/// The local materialised view of the parcel's `leases` section: turnId ->
	/// record. Snapshotted into the parcel and merged back through `adopt`.
	var _leases = {};

	/// Epoch-ms as a NUMBER, never `| 0`. A lease timestamp is a real
	/// wall-clock ms -- ~1.7e12 in 2026 -- which overflows a 32-bit `| 0` to
	/// garbage, so every comparison below uses this. (This is the width bug that
	/// `| 0` on a timestamp always is; see the i64/BigInt note in the project log.)
	function leaseMs(x) { return typeof x === 'number' ? x : (parseFloat(x) || 0); }

	/// Is a lease record a LIVE claim at `now`? A released lease, or one past its
	/// expiry, is vacant -- it grants nothing and may be overwritten.
	function liveLease(r, now) {
		return !!r && r.mode !== 'released' && leaseMs(r.expiry) > now;
	}

	/// The ceiling an adopted expiry may reach on the ADOPTING device's clock: one TTL
	/// from now, OR the errand's own `deadline` when the record carries one. A running
	/// turn's lease is claimed with `expiry = deadline` (see leaseTakeFrom), because a
	/// busy device cannot propagate a 30s renew (sync.js:1077 suppresses the push over a
	/// live turn), so a TTL-capped lease would read EXPIRED on other devices after 90s
	/// while the turn is still running -- and the phone's recovery would then re-run and
	/// re-bill it (the >TTL double-run). Bounding to the deadline lets the claim stay
	/// live for the whole turn with no renew at all. The deadline is authored by the
	/// DISPATCHER (buildDispatch), not the holder, so it is not a fast-clock lever.
	function expiryCap(r, now) {
		var cap = now + LEASE_TTL_MS;
		var dl  = leaseMs(r && r.deadline);
		return dl > cap ? dl : cap;
	}

	/// Clamp a record's expiry to `expiryCap`. A holder with a fast clock could
	/// otherwise write a far-future expiry and, if it then died, park the turn for up
	/// to that skew (QA defect a). Every merge clamps what it keeps to the ADOPTING
	/// device's clock, so no foreign expiry outlives the cap here. A deadline-bounded
	/// lease is already <= its deadline <= cap, so this is a no-op for it; an expiry
	/// ABOVE the cap (a fast clock, or a lease reaching past its own deadline) is
	/// clamped -- the fast-clock defence is preserved, now measured against the deadline
	/// rather than a bare TTL. A released record (expiry 0) is untouched. Returns a copy
	/// only when it must change the value, so an unchanged merge stays byte-identical.
	function clampExpiry(r, now) {
		if (!r) return r;
		var cap = expiryCap(r, now);
		if (leaseMs(r.expiry) <= cap) return r;
		var c = {};
		for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) c[k] = r[k];
		c.expiry = cap;
		return c;
	}

	/// Merge two records for ONE turnId under take-if-vacant. `incoming` is the
	/// arriving/authoritative side (a pulled parcel, or the server leases a claim
	/// is folded against); `local` is this device's side.
	///
	/// The whole money-safety property is these lines, so they are spelled out
	/// rather than compressed:
	///  - SAME holder -> the fresher `renewedAt` wins, live or not. This is decided
	///    FIRST, and it is the ONLY place `renewedAt` is consulted, so a device's
	///    own renew AND its own release supersede its earlier record -- a release
	///    that lost to its own still-live running lease would never land;
	///  - different holders, INCOMING live -> incoming wins, the local fresh claim
	///    drops. Under the CAS only one device commits a claim at a given version,
	///    so the loser -- pulling the winner's blob -- meets exactly this branch and
	///    stands down, and it never diverges because the loser's claim was refused
	///    by the CAS and so never reaches the winner as an incoming;
	///  - different holders, only LOCAL live -> local (the incoming is dead/vacant,
	///    e.g. reclaiming an expired lease);
	///  - both vacant -> the fresher record, for history only (a dead lease grants
	///    nothing, so this never decides a claim).
	function mergeOneLease(local, incoming, now) {
		return clampExpiry(pickLease(local, incoming, now), now);
	}

	/// The winner of two records for one turnId, BEFORE the expiry clamp.
	function pickLease(local, incoming, now) {
		if (local && incoming && local.holder === incoming.holder) {
			var ri = leaseMs(incoming.renewedAt), rl = leaseMs(local.renewedAt);
			if (ri !== rl) return ri > rl ? incoming : local;
			// EQUAL renewedAt between same-holder records: a 'released' wins, so a
			// stale 'running' can never resurrect a lease the holder let go (QA
			// defect b -- unreachable through the gateway today, latent otherwise).
			if (incoming.mode === 'released' && local.mode !== 'released') return incoming;
			if (local.mode === 'released' && incoming.mode !== 'released') return local;
			return incoming;			// truly identical: either
		}
		var lLive = liveLease(local, now), iLive = liveLease(incoming, now);
		if (iLive) return incoming;		// different holder, incoming live: incoming wins
		if (lLive) return local;		// only local live: local holds
		if (!local)    return incoming;	// both vacant
		if (!incoming) return local;
		return leaseMs(incoming.renewedAt) >= leaseMs(local.renewedAt) ? incoming : local;
	}

	/// The named take-if-vacant merge for the whole `leases` section: the union of
	/// turnIds, each resolved by `mergeOneLease`. This is the rule sync.js routes
	/// the section through, distinct from the append-only union / freshest-scalar
	/// the rest of the parcel uses. NOT freshest-scalar -- that is the double claim.
	function mergeLeases(local, incoming, now) {
		var out = {}, a = local || {}, b = incoming || {}, k;
		for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
		for (k in b) {
			if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
			out[k] = mergeOneLease(a[k], b[k], now);
		}
		return out;
	}

	function leaseNow(nowFn) { return (typeof nowFn === 'function') ? nowFn() : Date.now(); }

	/// The section as it rides the parcel, or null when empty (a null section is
	/// one the other device leaves untouched, the same contract pause.js keeps).
	function leaseSnapshot() {
		return Object.keys(_leases).length ? _leases : null;
	}

	// A change listener the dispatching UI registers (D4). A lease learned through a
	// sync pull -- the phone seeing the peer claim, then run, its turn -- moves the
	// local view here but touches no message record, so nothing would otherwise
	// redraw the dispatched footer: it would sit on "Sent to your other devices" while
	// the peer held and ran the lease, and never show "[Take back]". `leaseAdopt`
	// fires this whenever the merge actually moved, so a sync update advances the
	// footer claimed -> running the same way a report does.
	var _onLeaseChange = null;
	function leaseOnChange(fn) { _onLeaseChange = fn; }

	/// Merge an arriving parcel's `leases` into the local view under take-if-vacant.
	/// Called by sync.js's reconcile. Answers whether anything MOVED, so a pull that
	/// agreed with us schedules no push -- the same quiet-on-no-change contract the
	/// pause tree keeps (sync.js:786) -- and, when it moved, notifies the UI so the
	/// dispatched footer re-renders against the fresh lease (D4).
	function leaseAdopt(incoming, nowFn) {
		if (!incoming) return false;
		var before = JSON.stringify(_leases);
		_leases = mergeLeases(_leases, incoming, leaseNow(nowFn));
		var moved = JSON.stringify(_leases) !== before;
		if (moved && _onLeaseChange) {
			try { _onLeaseChange(); } catch (err) { /* a redraw must never break a sync */ }
		}
		return moved;
	}

	/// The live holder of a turn's lease at `now`, or null when it is vacant.
	function leaseHolder(turnId, now) {
		var r = _leases[String(turnId)];
		return liveLease(r, now == null ? Date.now() : now) ? r.holder : null;
	}

	/// The full lease record for a turn, or null. What the guards and the UI state
	/// machine read (they need mode/expiry/holder, not just the live holder).
	function leaseRecord(turnId) {
		return _leases[String(turnId)] || null;
	}

	// ── The lifecycle, over a compare-and-set ──────────────────
	//
	// A CAS is `{ read, write }`: `read()` answers `{ version, leases }`; `write(base,
	// leases)` answers `{ ok:true, version }` when `base` was current (and bumps it),
	// or `{ ok:false, version, leases }` with the current blob when it was not -- the
	// 409. In production this is the parcel's own push/pull (sync.js:19-25); the
	// arbitration is identical, and modelling it as a CAS is what lets the race be
	// driven deterministically in a test. The ARBITRATION IS ENTIRELY IN
	// `mergeLeases`: a take folds its claim through the merge and stands down the
	// instant the merge does not keep it, so there is no second code path where a
	// wrong merge could still be caught -- swap the merge for freshest-scalar and the
	// take double-claims. That is on purpose.

	/// TAKE the lease for a turn, based on a parcel snapshot already read. Answers
	/// `{ won, holder, why }`. Stands down -- never runs -- when a live foreign
	/// lease exists (the merge drops the claim), when the deadline has passed, or
	/// when the CAS could not be won in bounds.
	///
	/// The fold is `mergeLeases(MY claim /*local*/, server leases /*incoming*/)`:
	/// the server's existing foreign lease is the INCOMING that beats my fresh
	/// claim, so the merge -- and nothing else -- decides the race. This argument
	/// order is load-bearing; reversed, a loser would keep its own claim and double
	/// bill, which is exactly what the freshest-scalar mutation test proves.
	async function leaseTakeFrom(snap, turnId, opts, cas, nowFn) {
		var o = opts || {};
		var holder = String(o.holder || '');
		var tid    = String(turnId);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var now = leaseNow(nowFn);
			var deadline = leaseMs(o.deadline);
			if (deadline && now > deadline) {
				return { won: false, why: 'deadline' };
			}
			// The claim expiry is the errand's DEADLINE, not now + TTL, so the lease
			// stays live for the whole turn WITHOUT a renew -- a busy turn cannot push a
			// renew (sync.js:1077), so a TTL-capped claim would read expired elsewhere
			// after 90s and be re-run (the >TTL double-run). A recovery errand carries
			// no deadline (deadline 0), so it falls back to a single TTL, which is right:
			// recovery is the owner running its own orphan, not a peer holding for long.
			// The record carries `deadline` so every merge/clamp honours the same bound.
			var claim = {
				turnId: tid, eid: String(o.eid || ''), holder: holder,
				mode: 'claimed', deadline: deadline || 0,
				expiry: (deadline && deadline > now) ? deadline : (now + LEASE_TTL_MS),
				renewedAt: now,
			};
			var proposed = mergeLeases({ [tid]: claim }, snap.leases, now);
			if (!proposed[tid] || proposed[tid].holder !== holder) {
				_leases = mergeLeases(_leases, snap.leases, now);	// adopt what we learned
				return { won: false, holder: proposed[tid] ? proposed[tid].holder : null };
			}
			var res = await cas.write(snap.version, proposed);
			if (res.ok) {
				// A version bump is NOT proof our claim landed. The real sync resolves a
				// 409 mid-push by PULLING the concurrent winner's lease in, merging it
				// (take-if-vacant DROPS our claim), and pushing THAT -- yet the version
				// still advances, so a bare `ok` would let a loser believe it won and
				// double-run/double-charge (confirmed: two racers both `won` through the
				// pull-merge-retry commit). Trust the MERGE, never the version: re-read the
				// authoritative section and stand down unless it still names us as a LIVE
				// holder. A concurrent winner cannot be displaced by a later pull either --
				// its lease is live and foreign, which `mergeLeases` keeps -- so a re-read
				// that names us is a true win.
				var conf;
				try { conf = await cas.read(); }
				catch (e) { conf = { version: res.version, leases: res.leases || {} }; }
				_leases = conf.leases || {};
				var landed = _leases[tid];
				if (landed && landed.holder === holder && liveLease(landed, leaseNow(nowFn))) {
					return { won: true, holder: holder };
				}
				return { won: false, holder: landed ? landed.holder : null };
			}
			// 409: the version CHURNED under us. Under active two-device sync the parcel
			// version keeps moving, so a stale `base` is refused by the commit BEFORE it
			// even pushes -- back-to-back tries then all fail and the claim never lands
			// (the live why:'exhausted' hand-off failure). Take a FRESH read so the next
			// base is current, and back off a jittered moment so the two devices do not
			// collide in lockstep -- giving the claim a real window. The fold above still
			// stands us down if a live foreign winner has appeared, so this stays
			// single-run safe: only the persistence changes, never the arbitration.
			try { snap = await cas.read(); }
			catch (e) { snap = { version: res.version, leases: res.leases || {} }; }
			if (attempt + 1 < MAX_TAKE_TRIES) {
				await new Promise(function (r) {
					setTimeout(r, Math.round(TAKE_BACKOFF_MS * (0.5 + Math.random())));
				});
			}
		}
		return { won: false, why: 'exhausted' };
	}

	/// TAKE, reading the current parcel first. The ordinary entry point; the test
	/// uses `leaseTakeFrom` directly to race two takes from ONE base version.
	async function leaseTake(turnId, opts, cas, nowFn) {
		return leaseTakeFrom(await cas.read(), turnId, opts, cas, nowFn);
	}

	/// RENEW a lease this device holds, bumping its expiry. A healthy peer renews on
	/// journal progress; a dead one stops, and the lease expires. Answers
	/// `{ ok, why }`. Aborts (ok:false, why:'revoked') if the lease is no longer
	/// ours -- which is how a take-back (§3.3) reaches the running peer.
	async function leaseRenew(turnId, holder, cas, nowFn) {
		var tid = String(turnId), h = String(holder);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			if (!cur || cur.holder !== h || cur.mode === 'released') {
				_leases = mergeLeases(_leases, snap.leases, now);
				return { ok: false, why: 'revoked' };
			}
			// A renew never SHRINKS a deadline-bounded expiry: it holds to the later of
			// one TTL from now and the errand's deadline. Since a running turn is claimed
			// straight to its deadline and no longer renews on a ticker (runErrand only
			// transitions claimed -> running once), this is a no-op for a live turn; it
			// stays correct for a direct DaimondLease.renew of a TTL-only (no-deadline)
			// lease, where it is the old `now + TTL`.
			var bumped = {
				turnId: tid, eid: cur.eid, holder: h,
				mode: cur.mode === 'claimed' ? 'running' : cur.mode,
				deadline: leaseMs(cur.deadline),
				expiry: Math.max(now + LEASE_TTL_MS, leaseMs(cur.deadline)), renewedAt: now,
			};
			var proposed = mergeLeases({ [tid]: bumped }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { _leases = proposed; return { ok: true }; }
		}
		return { ok: false, why: 'exhausted' };
	}

	/// COMPLETE (mode 'done') or RELEASE (mode 'released', which is vacant) a lease
	/// this device holds. `release` is also how the phone takes a turn back from a
	/// live peer (§3.3): the peer's read-only liveness check sees it released and aborts.
	async function leaseSet(turnId, holder, mode, cas, nowFn) {
		var tid = String(turnId), h = String(holder);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			if (!cur || cur.holder !== h) {
				_leases = mergeLeases(_leases, snap.leases, now);
				return { ok: false, why: 'not_ours' };
			}
			var next = {
				turnId: tid, eid: cur.eid, holder: h, mode: mode,
				deadline: leaseMs(cur.deadline),
				expiry: mode === 'released' ? 0 : cur.expiry, renewedAt: now,
			};
			var proposed = mergeLeases({ [tid]: next }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { _leases = proposed; return { ok: true }; }
		}
		return { ok: false, why: 'exhausted' };
	}

	/// REVOKE a turn's lease whoever holds it -- the phone's take-back (§3.3). Unlike
	/// `release`, which is the holder letting go, this vacates a lease held by a
	/// DIFFERENT device: the running peer's read-only liveness check reads
	/// `mode:'released'` and hard-aborts its turn. CAS-written, so it races the peer
	/// cleanly. `renewedAt` is stamped now so the same-holder merge keeps the released
	/// record over the peer's live one.
	async function leaseRevoke(turnId, cas, nowFn) {
		var tid = String(turnId);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			if (!cur || cur.mode === 'released') return { ok: true };	// already vacant
			// `renewedAt` at least the current record's, so the same-holder merge's
			// released-wins tie-break (or a strictly-greater renew) always keeps this
			// over the peer's live running record -- a fast-clock peer cannot outbid it.
			var revoked = {
				turnId: tid, eid: cur.eid, holder: cur.holder,
				mode: 'released', expiry: 0, deadline: leaseMs(cur.deadline),
				renewedAt: Math.max(now, leaseMs(cur.renewedAt)),
			};
			var proposed = mergeLeases({ [tid]: revoked }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { _leases = proposed; return { ok: true }; }
		}
		return { ok: false, why: 'exhausted' };
	}

	/// Stage a leases section as the local view, for the sync shim ONLY: the CAS
	/// `commit` installs the proposed section here so the next `DaimondSync.push`
	/// sends it. Everything else reaches `_leases` through `adopt`/`take`/`renew`.
	function leaseInstall(leases) { _leases = leases || {}; }

	/// Drop the local view, for a test or an account switch.
	function leaseForget() { _leases = {}; }

	// The lease section provider, attached like pause.js so sync.js finds it by the
	// same `snapshot`/`adopt` contract every other section keeps.
	window.DaimondLease = {
		LEASE_TTL_MS:      LEASE_TTL_MS,
		RENEW_EVERY_MS:    RENEW_EVERY_MS,
		MAX_LEASE_LIFE_MS: MAX_LEASE_LIFE_MS,
		/// The named take-if-vacant merge for one turnId and for the whole section.
		/// Published so sync.js and a verifier drive the ONE implementation.
		mergeOne:  mergeOneLease,
		merge:     mergeLeases,
		live:      liveLease,
		/// The two halves of sync.js's section contract.
		snapshot:  leaseSnapshot,
		adopt:     leaseAdopt,
		/// Register a redraw the UI wants run when a sync pull moves the lease view
		/// (D4): the dispatched footer advances claimed -> running -> "[Take back]".
		onChange:  leaseOnChange,
		/// The live holder of a turn, or null; and the full record, for the guards
		/// and the UI state machine.
		holder:    leaseHolder,
		record:    leaseRecord,
		/// The lifecycle over a compare-and-set.
		take:      leaseTake,
		/// TAKE from a snapshot already read -- lets a test race two takes from ONE
		/// base version, which is the concurrency the lease exists to arbitrate.
		takeFrom:  leaseTakeFrom,
		renew:     leaseRenew,
		complete:  function (turnId, holder, cas, nowFn) { return leaseSet(turnId, holder, 'done', cas, nowFn); },
		release:   function (turnId, holder, cas, nowFn) { return leaseSet(turnId, holder, 'released', cas, nowFn); },
		/// The phone's take-back: revoke whoever holds the lease (§3.3).
		revoke:    leaseRevoke,
		/// Stage a section for the sync shim's CAS commit. Not for general use.
		install:   leaseInstall,
		forget:    leaseForget,
	};

	// ── The runner (dev/PEER_DESIGN.md §4.3, step 5) ───────────
	//
	// On a Channel::Post wake the errand routes through takeRow -> peek -> absorb
	// (step 2) to the runner registered here. `runErrand` is PURE over injected
	// deps, so the whole flow -- take, run, push, report, release, AND the
	// revoke->abort path -- is tested without daimond.js, which supplies the real
	// deps (the sync-bound lease CAS, reconstruct via ensureApp/scopeChatTo/chunks,
	// runTurn, the transcript push, the report post, the ack, chat.app.abort).

	/// Bind DaimondLease's abstract compare-and-set to a sync-like object. `sync`
	/// exposes `version()`, `leases()` and `commit(base, leases) -> { ok, version,
	/// leases }`; production wires `commit` onto DaimondSync -- install the leases
	/// section, push under CAS, report whether the version moved -- and this shim is
	/// what the lease lifecycle drives. The arbitration (push 409 -> adopt -> retry)
	/// is the lease's own; this only translates the interface, and both are proven
	/// against a fake sync in the tests.
	function syncCas(sync) {
		return {
			// A sync that offers an async `read` (the real lease door does; a test's
			// fake sync does not) reads through it; otherwise the synchronous
			// version()/leases() getters, which is what the tests drive.
			read:  function () {
				return sync.read
					? sync.read()
					: Promise.resolve({ version: sync.version(), leases: sync.leases() });
			},
			write: function (base, leases) { return Promise.resolve(sync.commit(base, leases)); },
		};
	}

	/// Run one errand end to end. Stands down -- never runs -- if a peer already
	/// holds it; HARD-ABORTS the instant the lease is revoked; and ACKS ONLY AFTER
	/// the result is pushed, so a crash before the push leaves the errand on the
	/// relay and the lease to expire (the phone reclaims, §2.5 -- nothing dropped).
	///
	/// Pure over `deps`:
	///   selfId       this device's id (the lease holder);
	///   cas          the lease CAS (`syncCas` over the real sync);
	///   reconstruct  async (errand) -> ctx: pull to >= parcelVersion, find the chat,
	///                `scopeChatTo`, apply `pause`, fetch chunks;
	///   runTurn      async (ctx, prompt, { onProgress }): the ordinary turn engine,
	///                calling `onProgress` on journal events so the lease renews;
	///   abort        (): hard-stop the in-flight turn (`chat.app.abort`);
	///   pushResult   async () -> version: `captureSession` + parcel push (append merge);
	///   post         async (reportEnvelope): post the report;
	///   ack          async (): `DaimondPost.ack`, AFTER the push committed;
	///   now          optional clock, for tests.
	///
	/// Answers `{ ran, done?, aborted?, error?, why?, holder?, trace }`. `trace` is
	/// the ordered side effects, so a test asserts the sequence rather than guessing.
	async function runErrand(errand, deps) {
		var d = deps || {}, e = errand || {};
		var turnId = String(e.turnId);
		var trace = [];

		// D1(a) — NEVER run an errand THIS device dispatched, EXCEPT on a deliberate
		// local recovery (`allowSelf`). The phone returns from the background and the
		// ordinary collect loop re-collects its OWN self-posted errand
		// (peerCollectOnReturn); routed here and run, it would re-take a released lease
		// and re-run a turn a peer already ran -- a second completion and a second
		// charge. So the AUTOMATIC path stands down on its own dispatch. Recovery is
		// different: it is the dispatching device DELIBERATELY running its own orphaned
		// turn because no peer did, and it has already confirmed the turn is not
		// finished and not held by a live foreign lease. It is STILL money-safe, because
		// it goes through the SAME `finished` (D1(b)) check and the SAME take-if-vacant
		// lease below -- a peer that took the lease first wins the merge and recovery
		// stands down; a peer that collects AFTER recovery's ack finds no errand and,
		// if it somehow does, `finished`/the released-with-answer lease stand it down.
		// `allowSelf` only lifts THIS blanket refusal; every other guard is untouched.
		// `dispatchedBy` names the dispatching device (the per-device id, not the
		// account key), so a match to this device is our own dispatch.
		if (!d.allowSelf && e.dispatchedBy && String(e.dispatchedBy) === String(d.selfId)) {
			trace.push('self-dispatched');
			return { ran: false, why: 'self-dispatched', trace: trace };
		}

		// D1(b) — a COMPLETED turn is not vacant-for-rerun. A released lease reads
		// vacant (`liveLease` false), and `done` is transient before `released`, so a
		// turn the peer already finished would be re-taken and re-billed by the next
		// device to collect the errand. A turn that already carries a done report or a
		// merged answer is FINISHED: stand down before the take. `finished` is supplied
		// by the app (it checks the report box and the transcript); absent -- the
		// runner-acceptance path -- this is a no-op.
		if (d.finished) {
			var already = false;
			try { already = await d.finished(e); } catch (err) { already = false; }
			if (already) { trace.push('already-done'); return { ran: false, why: 'already-done', trace: trace }; }
		}

		// D1(c) — DEFER TO THE NOMINATED RUNNER. When the account has named an always-on
		// runner and it is FRESHLY awake, a non-nominee stands down and leaves the claim
		// to it, so a laptop that may be closed mid-turn does not grab a turn the desktop
		// should run. Gated on the nominee's LIVE freshness (DISPATCH_FRESH_MS): a nominee
		// that has actually slept reads offline and this device claims instead -- fall back
		// to any awake device, the owner's explicit choice over nobody-runs-it. NOT applied
		// on a deliberate local recovery (`allowSelf`): recovery is the guaranteed net that
		// a turn NO peer ran is still run, and must never itself stall for the nominee.
		// Standing down does NOT ack -- takeRow HOLDs the errand on the relay (post.js) --
		// so it is re-collected and re-decided against live presence until the nominee runs
		// it or its beat ages out. Only WHO attempts the claim changes; the take-if-vacant
		// lease below is still the single-runner arbiter.
		if (!d.allowSelf && nominationStandDown(d.nominatedId, d.selfId, d.presence, leaseNow(d.now), d.freshWindowMs)) {
			trace.push('stood-down-for-nominee');
			return { ran: false, why: 'nominee', trace: trace };
		}

		// A missing lease CAS cannot arbitrate a claim, so there is no safe way to run:
		// stand down cleanly rather than let `leaseTake` dereference a null `cas` and
		// throw the opaque "Cannot read properties of null (reading 'read')".
		if (!d.cas || typeof d.cas.read !== 'function') {
			trace.push('no-cas');
			return { ran: false, why: 'no-cas', trace: trace };
		}

		// 1. TAKE. Stand down -- never run -- if a peer already holds it.
		var took = await leaseTake(turnId,
			{ holder: d.selfId, eid: e.eid, deadline: e.deadline }, d.cas, d.now);
		trace.push('take');
		if (!took.won) return { ran: false, why: took.why || 'stood-down', holder: took.holder, trace: trace };

		// THE LEASE DOES NOT RENEW. It is claimed straight to the errand's DEADLINE
		// (leaseTakeFrom), so it stays live for the whole turn with no periodic write --
		// which is what keeps the parcel a fixed point during a running turn AND closes
		// the >LEASE_TTL_MS double-run: a busy turn cannot push a 30s renew (sync.js:1077
		// suppresses the push over a live turn), so a TTL-capped lease read EXPIRED on
		// other devices after 90s while the turn ran on, and the phone's recovery re-ran
		// and re-billed it. What runs on a ticker now is a READ-ONLY liveness check: it
		// detects a take-back (the phone REVOKED the lease) and HARD-ABORTS, and it caps a
		// hung turn's lifetime -- it never writes the parcel, so a running turn causes no
		// churn. The check is owned HERE (not in the injected runTurn) and stopped on
		// EVERY exit (the finally), so it can neither outlive the errand nor leak a timer.
		var revoked = false, checkStopped = false, checkTimer = null;
		var checkStart = leaseNow(d.now);
		var maxLife = (d.maxLeaseLifeMs != null) ? d.maxLeaseLifeMs : MAX_LEASE_LIFE_MS;
		var setT = d.setTimer   || (typeof setInterval   === 'function' ? setInterval   : null);
		var clrT = d.clearTimer || (typeof clearInterval === 'function' ? clearInterval : null);
		function stopCheck() {
			checkStopped = true;
			if (checkTimer != null && clrT) { try { clrT(checkTimer); } catch (err) {} checkTimer = null; }
		}
		// READ-ONLY: never writes the parcel (no renew, no churn). Aborts on a revoke
		// -- the lease is no longer ours, or was released, which a sync pull adopts into
		// the view this reads -- and on the lifetime cap, the backstop for a runTurn
		// whose promise never settles, after which the lease is simply left to expire.
		async function liveness() {
			if (checkStopped || revoked) return;
			if (leaseNow(d.now) - checkStart > maxLife) {
				trace.push('renew-capped');
				stopCheck();
				revoked = true;
				try { if (d.abort) d.abort(); } catch (err) { /* idempotent */ }
				return;
			}
			var snap;
			try { snap = await d.cas.read(); } catch (err) { return; }	// a failed read is not a revoke
			var cur = (snap && snap.leases) ? snap.leases[turnId] : null;
			if (!cur || cur.holder !== String(d.selfId) || cur.mode === 'released') {
				revoked = true;
				trace.push('abort');
				try { if (d.abort) d.abort(); } catch (err) { /* idempotent */ }
			}
		}
		try {
			// 2. RECONSTRUCT the chat and workspace at the errand's version.
			var ctx;
			try { ctx = await d.reconstruct(e); trace.push('reconstruct'); }
			catch (err) {
				// The lease was TAKEN above. A reconstruct that throws must NOT leave it
				// pinned at 'claimed' to the errand's deadline: on an iOS phone that cannot
				// fire the deadline fallback, that reads as a turn stuck on "picking this
				// up" for ever, with the engine's real sentence swallowed and nothing to act
				// on. So SURFACE it and HAND IT BACK -- post an error report carrying the
				// reason (the phone shows it and offers [Run here]) and release the lease so
				// the turn is reclaimable at once rather than after the deadline. Nothing ran,
				// so there is no charge and the release is money-safe.
				var rwhy = String((err && err.message) || err);
				trace.push('reconstruct-failed');
				try { if (typeof console !== 'undefined') console.error('peer: reconstruct failed for turn ' + turnId + ' -- ' + rwhy); } catch (e2) {}
				try { if (d.post) await d.post(makeReport({ eid: e.eid, turnId: turnId, chatId: e.chatId, status: 'error', why: rwhy })); }
				catch (e2) { /* the release below still frees the turn */ }
				try { await leaseSet(turnId, d.selfId, 'released', d.cas, d.now); trace.push('release'); }
				catch (e2) { /* an unreleased lease still expires at its deadline */ }
				return { ran: false, error: true, why: rwhy, trace: trace };
			}

			// 3. Transition claimed -> running ONCE -- a semantic state change for the UI
			// footer ("running" vs "picking this up"), one write, before the turn goes
			// busy. This keeps the deadline expiry (leaseRenew never shrinks it); it does
			// NOT start a heartbeat. A lease already revoked between take and here aborts.
			var mk = await leaseRenew(turnId, d.selfId, d.cas, d.now);
			if (!mk.ok && mk.why === 'revoked') {
				revoked = true;
				trace.push('abort');
				try { if (d.abort) d.abort(); } catch (err) { /* idempotent */ }
				return { ran: true, aborted: true, why: 'revoked', trace: trace };
			}
			// 4. RUN. A revoked lease HARD-ABORTS at once, via the read-only ticker and
			// the injected onProgress (kept so a real journal-event piggyback can check
			// liveness between ticks); chat.app.abort is the hard stop.
			if (setT) checkTimer = setT(function () { liveness(); }, RENEW_EVERY_MS);
			try {
				// D3 — the prompt is ALREADY in the synced transcript (the dispatcher
				// persist-first pushed it before posting the errand, §4.1). Tell runTurn so,
				// so it runs the turn against the existing user message instead of appending
				// a second copy -- otherwise the prompt sits twice in `messages` AND is fed
				// to the model twice (seeded history + the re-sent turn). `turnId` names the
				// existing user message (mid === turnId) the runner anchors to.
				await d.runTurn(ctx, e.prompt, { onProgress: liveness, promptInTranscript: true, turnId: turnId });
				trace.push('run');
			} catch (err) {
				// Revoked -> the lease is already whoever took it back's; touch nothing,
				// do NOT ack -- the errand is theirs now.
				if (revoked) return { ran: true, aborted: true, why: 'revoked', trace: trace };
				// A genuine crash: do NOT ack and do NOT complete, so the relay keeps the
				// errand and the lease EXPIRES (at its deadline). The phone reclaims (§2.5).
				return { ran: true, error: true, why: String(err && err.message || err), trace: trace };
			}
			if (revoked) return { ran: true, aborted: true, why: 'revoked', trace: trace };
			// The turn produced a result: stop the liveness ticker BEFORE completing, so
			// nothing races the done/release writes below.
			stopCheck();

			// 4. COMPLETE in order: push the transcript (append merges), post the report,
			// mark the lease done, ACK the errand (only now the push has committed), then
			// release the lease.
			var parcelVersion = 0;
			try { parcelVersion = (await d.pushResult()) | 0; trace.push('push'); }
			catch (err) { return { ran: true, error: true, why: 'push-failed', trace: trace }; }
			try {
				await d.post(makeReport({ eid: e.eid, turnId: turnId, chatId: e.chatId,
					status: 'done', parcelVersion: parcelVersion }));
				trace.push('report');
			} catch (err) { /* the report is only the nudge; the answer is already pushed */ }
			await leaseSet(turnId, d.selfId, 'done', d.cas, d.now); trace.push('complete');
			try { if (d.ack) { await d.ack(); trace.push('ack'); } }
			catch (err) { /* a missed ack costs one idempotent re-collect, never a drop */ }
			await leaseSet(turnId, d.selfId, 'released', d.cas, d.now); trace.push('release');
			return { ran: true, done: true, parcelVersion: parcelVersion, trace: trace };
		} finally {
			stopCheck();			// EVERY exit stops the liveness ticker -- no timer leaks.
		}
	}

	// ── Public surface ─────────────────────────────────────────
	/// Does this errand name THIS device as its dispatcher? The sender must NOT ack
	/// its own un-run errand off the shared relay -- only the peer that actually runs
	/// it may (post.js `collect`/`takeRow` hold it otherwise). `dispatchedBy` carries
	/// the dispatcher's peer id, which is `DaimondIdentity.deviceId()` -- the same
	/// `selfDeviceId` the runner's D1(a) self-dispatch guard compares against.
	function isOwnDispatch(env) {
		if (!env || env.t !== T_ERRAND || !env.dispatchedBy) return false;
		var self = '';
		try {
			self = (window.DaimondIdentity && DaimondIdentity.deviceId)
				? String(DaimondIdentity.deviceId() || '') : '';
		} catch (e) { self = ''; }
		return !!self && String(env.dispatchedBy) === self;
	}

	window.DaimondPeer = {
		ENVELOPE_V: ENVELOPE_V,
		T_ERRAND:   T_ERRAND,
		T_REPORT:   T_REPORT,
		makeErrand:  makeErrand,
		makeReport:  makeReport,
		/// Seal an envelope to this account and answer the `{ to, addr, envelope }`
		/// post body. Reuses `DaimondPost.seal`; no server is involved, which is
		/// also how it is tested.
		sealForSelf: sealForSelf,
		/// Open a sealed envelope, or throw if it is not this account's OR was not
		/// signed by this account. The same-account-only property lives here.
		openEnvelope: openEnvelope,
		/// Sign an envelope with this account's key / verify one was so signed.
		signEnvelope:   signEnvelope,
		verifyEnvelope: verifyEnvelope,
		/// The collector's two doors: classify a row's sealed body without acting
		/// (`peek`), then verify-and-run it (`absorb`). `takeRow` calls these.
		peek:    peek,
		absorb:  absorb,
		/// Whether an errand is THIS device's own dispatch -- so the sender's collect
		/// leaves it on the relay for the peer rather than acking it away.
		isOwnDispatch: isOwnDispatch,
		/// Register the runners the collector hands a verified envelope to. Set by
		/// daimond.js; absent, `absorb` verifies and drops.
		onErrand: onErrand,
		onReport: onReport,
		/// Route a batch of collected rows by their sealed type tag (direct-drive).
		routeRows:   routeRows,
		/// Fold a peer's answer into a transcript as an append.
		foldAssistant: foldAssistant,
		/// The dispatcher's pure core: assemble the ordered plan + full errand
		/// (`buildDispatch`), and classify a `why:'dispatched'` turn against the
		/// lease (`dispatchState`). daimond.js runs the order; these hold the logic.
		buildDispatch: buildDispatch,
		dispatchState: dispatchState,
		/// The §5 display state of a dispatched turn (dispatched/no-peer-awake/
		/// claimed/running/done/failed). Pure; daimond.js only renders it.
		uiState:       uiState,
		/// Should this turn be auto-handed to a peer, and which one? Pure; daimond.js
		/// acts on it at send-time. And the shared "which peer is awake" answer.
		autoDispatchDecision: autoDispatchDecision,
		freshestPeer:  freshestPeer,
		/// Whether the dispatching device should RECOVER an orphaned dispatched turn
		/// locally on its return -- dispatched, not finished, not held by a live peer.
		/// daimond.js acts on it through the same lease, so it is money-safe.
		recoverDecision: recoverDecision,
		/// Should this device stand down from claiming a dispatched turn, deferring to
		/// the account's nominated always-on runner? Pure; runErrand consults it before
		/// the lease take, and daimond.js supplies the nominee id + live presence.
		nominationStandDown: nominationStandDown,
		REASON_DISPATCHED:    REASON_DISPATCHED,
		DISPATCH_DEADLINE_MS: DISPATCH_DEADLINE_MS,
		/// The TIGHTER window the auto-dispatch decision uses (under the display
		/// window and well under the gateway TTL), so a dispatch never goes to a peer
		/// last seen too long ago to still be beating.
		DISPATCH_FRESH_MS:    DISPATCH_FRESH_MS,
		/// The runner: bind the lease CAS to the real sync (`syncCas`), then run an
		/// errand end to end (`runErrand`) -- take, run, push, report, release, with
		/// a hard-abort on revoke and ack only after commit. Pure over injected deps.
		syncCas:    syncCas,
		runErrand:  runErrand,
		/// The content address of some sealed bytes, exposed for a caller that
		/// seals by hand.
		addressOf:   addressOf,
	};
})();
