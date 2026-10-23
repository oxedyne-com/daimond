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

	/// One line in the opt-in diagnostics ring (www/js/diag.js). A no-op when
	/// Diagnostics is off; ids, counts and reasons only, never content. This is
	/// the COLLECTOR side of the hand-off picture: why this device claimed an
	/// errand or stood down for the nominee.
	function diag(tag, d) { try { if (window.DaimondDiag) DaimondDiag.log(tag, d); } catch (e) {} }

	/// The errand's daimon model and how this device holds its key, for `collect errand`
	/// (DIAG_BUSY3 fix 3): a models refusal then reads as "row absent" or "key sealed".
	function errandModelDiag(e) {
		var m = e && e.model;
		if (!m || !m.provider) return ' provider=none';
		var M = window.DaimondModels, ks = (M && M.keyState) ? M.keyState(m.provider) : '?';
		return ' provider=' + m.provider + ' model=' + String(m.model || '') + ' key=' + ks;
	}

	// The schema version the errand and report carry. Bumped when a field's
	// meaning changes, so a peer never runs an envelope it half-understands.
	var ENVELOPE_V = 1;

	var T_ERRAND = 'errand';	// a turn dispatched to a peer
	var T_REPORT = 'report';	// a peer's account of how the turn went
	// The two envelopes remote consent rides. A runner blocked on a genuinely
	// per-turn question (a `web_type`, a `web_click`, an overlong address) that the
	// synced account policy does NOT already cover cannot raise a dialog where nobody
	// is, so it seals a `consent-ask` to the account and awaits the answer; an
	// attended device raises the tile and seals back a `consent-grant`. They ride the
	// same self-seal and the same signature as the errand -- no new transport, no new
	// crypto -- and slot into the same route-by-type the collector already does.
	var T_ASK   = 'consent-ask';	// runner -> the account: a live question for a human
	var T_GRANT = 'consent-grant';	// an attended device -> the runner: the answer
	// NON-CHAT WORK GOES THE SAME WAY A TURN DOES. A phone that cannot hold a book's
	// files, or cannot afford the heap a layout costs, hands the COMPILE to a machine
	// that can, and the machine hands back the laid-out artifact. Same self-seal, same
	// signature, same post door, same collector -- a second transport for the same
	// journey is a second set of money- and data-safety arguments to get right.
	var T_COMPILE = 'compile';	// a device -> a runner: lay this document out
	var T_BUILT   = 'built';	// the runner -> the account: what the layout cost and where it is
	// A RUNNER TURN IS UNDONE WHERE IT RAN (RUN-HIST, 23 Oct). The asker's History holds the
	// turn's rows (the report's `turnRec`) but not the files, which are on the runner; "Undo
	// this turn" asks the runner to put back what the turn changed, and the runner answers
	// with what it put back, removed and skipped. Same seal, same signature, same post door.
	var T_UNDO    = 'undo-turn';	// a device -> the runner that ran a turn: undo it
	var T_UNDONE  = 'undone';	// the runner -> the device that asked: what the undo did

	/// Is `t` a peer envelope tag this layer owns? The collector routes exactly these
	/// eight and hands everything else (a message artefact) to the message path.
	function peerType(t) {
		return t === T_ERRAND || t === T_REPORT || t === T_ASK || t === T_GRANT
			|| t === T_COMPILE || t === T_BUILT || t === T_UNDO || t === T_UNDONE;
	}

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
	// The tags and the AAD are the Rust seal's (`src/seal/peer.rs`), reached through
	// `window.DaimondSeal` (daimond.js); the AES-GCM under the account key stays with
	// identity.js, which holds that key.
	var PEER_AAD = 'daimond/peer/env/1';	// the envelope's GCM domain (peer::AAD)

	/// The seal bridge; its calls wait for the wasm, so an early hand-off waits too
	/// (and one made while the page still parses waits for the module to publish it).
	async function sealBridge() {
		if (!window.DaimondSeal && typeof document !== 'undefined' && document.readyState !== 'complete') {
			await new Promise(function (r) {
				document.addEventListener('DOMContentLoaded', r, { once: true });
				window.addEventListener('load', r, { once: true });
			});
		}
		if (!window.DaimondSeal || typeof window.DaimondSeal.scheme !== 'function') {
			throw new Error('peer: the seal is not loaded, so nothing can be sealed or opened.');
		}
		return window.DaimondSeal;
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
	///
	/// A VERDICT OR A THROW (TAKEROW, 2026-10-16). `false` is definite: no signature,
	/// another author, or a signature checked and wrong -- the collector drops on it.
	/// A device that cannot check -- no identity or verifier loaded, no key of its own
	/// yet, the verifier failing -- THROWS, and the collector leaves the row on the
	/// relay for the next collect rather than dropping it as a forgery.
	async function verifyEnvelope(obj) {
		if (!obj || !obj.author || !obj.sig) return false;
		if (!window.DaimondIdentity || !window.DaimondIdentity.verifySig) {
			throw new Error('peer: no verifier loaded, so a peer envelope cannot be checked yet.');
		}
		var mine = await window.DaimondIdentity.publicKeyRaw();
		if (!mine) throw new Error('peer: this device has no account key yet, so a peer envelope cannot be checked.');
		if (hex(mine) !== String(obj.author)) return false;	// authored by us?
		return await window.DaimondIdentity.verifySig(unhex(obj.author), obj.sig, signedBytes(obj));
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
			// The Diamond this errand's chat belongs to, or '' for an ordinary chat. A
			// daimon errand is serviced by `steer_crystal` (the crystal-agent turn), not
			// the chat engine, so the runner has to know which it is BEFORE it reconstructs
			// -- the chatId alone cannot say, an older phone build carries none, and the
			// runner then falls back to the reconstructed `ctx.chat.diamondId`.
			diamondId: String(o.diamondId || ''),
			prompt:  String(o.prompt == null ? '' : o.prompt),
			// The note ahead of the person's words (U4), composed once on the device that sent the
			// message and kept apart from `prompt`; '' for none. The runner joins it in the engine.
			pre:     String(o.pre == null ? '' : o.pre),
			// The Effort the turn runs with (D-20261014-08), '' for the model's own default.
			effort:  String(o.effort || ''),
			model:   o.model || null,		// { provider, model, url } -- models.js:127-129
			scope:   o.scope || null,		// the workspace fence -- scopeChatTo, daimond.js:17553
			// THE FENCE, AS ABSOLUTE ROOTS (R3c2): the engine's `fence_spec` over this page's bounds,
			// `{ rw, ro, deny, net }`, exactly as the Hand gets it here (`command_fence_json`). A
			// runner holds the turn to these and never works roots out itself; null where this page
			// has no hand to resolve against, and a runner refuses an errand without one.
			fence:   o.fence || null,
			pause:   o.pause || null,		// pause-tree snapshot at dispatch -- §1.1
			parcelVersion: o.parcelVersion | 0,	// the freshness anchor -- §1.3
			deadline:      +o.deadline || 0,	// epoch-ms after which no peer starts (NOT |0: ms overflows 32 bits)
			dispatchedBy:  String(o.dispatchedBy || ''),
			// How many times THIS turn has already parked (below MAX_PARKS by
			// construction -- a dispatch is refused at the bound). Rides the errand and
			// is carried forward through the parked report and the synced dispatched
			// placeholder, so the ≤MAX_PARKS bound is GLOBAL across devices rather than
			// a per-device count that would multiply the spend cap by device count.
			parkCount: o.parkCount | 0,
			// THE DEVICES THAT HAVE ALREADY HANDED THIS TURN BACK (r545, Q19): each runner
			// whose hand-back the sender collected, appended by the sender as it re-seats
			// the turn (`triedAfterHandBack`). A busy runner does not hold the row for one of
			// them, and does not defer to a nominee among them: each has said it will not run
			// it. [] from a first send and from an older sender.
			tried:   triedList(o.tried),
			// THE THREAD THE TURN NEEDS, carried ON the errand so the runner can start
			// without the parcel. `parcelVersion` still names the version the dispatcher
			// is pushing -- the workspace, the Diamonds, everything else -- but the turn
			// itself needs only the conversation, and that is small enough to ride here.
			// `{ chatId, title, provider, model, msgs:[{ role, content, mid, ts }] }`, or
			// null from a dispatcher that carries none (an older build, or a thread too
			// large to seed) -- read as "pull the parcel as before".
			seed:    o.seed || null,
			// THE THREAD'S FINGERPRINT, `{ n, sig }` over the model-facing prefix (content-
			// free, `threadSig`). Readiness on the runner is "holds THIS thread", not "holds
			// the turn's user message" -- so a runner whose parcel is stale hands the turn
			// back rather than running an incomplete conversation (S-HAND #3). null from an
			// older dispatcher, which `holdsThread` reads as "fall back to holdsTurn".
			thread:  o.thread || null,
			// THE LAST MESSAGE THE ASKER SAW, `{ ts, mid }` (UNBLOCK-11), from `throughOf`. The
			// runner waits a bounded while for that message to arrive, then runs whatever it
			// holds and tells the model what it lacked: a turn is never refused for a thread
			// that differs. null when the chat held nothing before the prompt, and from an
			// older sender.
			through: (o.through && o.through.mid) ? { ts: +o.through.ts || 0, mid: String(o.through.mid) } : null,
			// THE MESSAGES THE ASKER HELD before the prompt, as short hashes of their mids, newest
			// `THREAD_IDS_MAX` (`threadIds`, QA r572z-A N1). The runner checks each is held, so a row
			// of its own cannot stand in for one it lacks. null from an older sender: counts judge.
			ids:     idList(o.ids),
			// THE ROWS THE SENDER REMOVED and has not yet shipped in a parcel (a Retry's
			// retracted answer), by mid. The runner leaves them out of the thread it judges
			// and runs, and records the same removal, so the errand never waits on the
			// parcel carrying the tombstones (UNBLOCK-1). [] from an older sender.
			gone:    triedList(o.gone),
			// THE HANDED-OFF TURNS OF THIS CHAT STILL RUNNING OR QUEUED when this one was
			// sent, whose answers the sender's thread therefore lacks (`openTurn`). The runner
			// they were queued at answers them first, so its copy may hold those answers
			// beyond the thread and still match (UNBLOCK-1 3b). [] when none, and from an
			// older sender.
			behind:  triedList(o.behind),
			// THE DEVICE THE SENDER ELECTED, which alone takes the turn while it is
			// listening (D-20261009-23). '' from an older sender, judged by the nomination.
			to:      String(o.to || ''),
			// THE QUESTIONS THE DISPATCHING DEVICE CAN ANSWER for a handed-off turn
			// (CONSENT-ROUTE, 10 Oct): a write outside the Diamond, a toolkit on first use, a
			// command in the ask mode. A runner routes one of these to that device only when
			// it is named here; [] from an older sender, whose device would draw such a
			// question as a misleading "reach" tile, so the runner refuses it instead.
			asks:    askList(o.asks),
			// Does the SENDER hold the autonomous posture? On the runner it answers this
			// turn's permits in the sender's place; the runner's own posture never does.
			auto:    o.auto === true,
			ts:      o.ts || Date.now(),
		};
	}

	/// Build a report envelope object (not yet sealed). §4.4: the report is the
	/// NUDGE, never the answer -- the answer is already in the parcel.
	function makeReport(f) {
		var o = f || {};
		var rep = {
			t:       T_REPORT,
			v:       ENVELOPE_V,
			eid:     String(o.eid || ''),
			turnId:  String(o.turnId || ''),
			chatId:  String(o.chatId || ''),
			status:  String(o.status || 'done'),	// done | refused-spend | error | aborted | parked | undeliverable (| busy, r543 only)
			// THE DEVICE THIS REPORT IS FOR: the errand's dispatcher. The relay's ack is one
			// account-wide watermark, so any device that collects the report and acks past it
			// drops it for every device -- the runner first of all, whose own collect folds
			// the report it has just posted. A collector that is not `to` leaves the row on
			// the relay for it (`noteHeldFor`). '' from an older runner, which is acked as before.
			to:      String(o.to || ''),
			parcelVersion: o.parcelVersion | 0,	// which version already carries the answer
			cost:    o.cost || null,
			why:     o.why ? String(o.why) : '',	// a human sentence for the failure states
			// THE PAUSE NODE a runner refused the turn for, on an `error` report (R53-U8b, QU8
			// Q3), so the sender says "paused" where it said "couldn't finish". '' otherwise,
			// and from an older runner, whose refusal still reads as a failure.
			paused:  o.paused ? String(o.paused) : '',
			// The GLOBAL park counter carried home so a re-dispatcher (any device that
			// collects this report) bumps from the true total, never from a device-local
			// zero. Only meaningful on a `parked` report; 0 elsewhere.
			parkCount: o.parkCount | 0,
			// Whether the answer ALREADY travelled, as the final frame on the progress
			// door, ahead of the parcel. 1 means the originator can show the finished turn
			// now and need not wait for a version; 0 is the old behaviour (a runner on an
			// older build), where the parcel is the first sight of it.
			finalTail: o.finalTail | 0,
			// THE RUNNER THAT SENT IT, on a hand-back: the claim `leaseReclaim` may vacate.
			// '' from an older runner, whose hand-back waits for its own release.
			by:      String(o.by || ''),
			// THE QUEUE DEPTH of a runner that handed the turn back because it was busy (r544,
			// QA F-A1): an `undeliverable` with `busy` > 0. 0 on every other report.
			busy:    o.busy | 0,
			// WHY A HAND-BACK WAS MADE, as a code the sender's tile can name (D2, 11 Oct):
			// 'thread' when the runner could not rebuild the conversation as sent, 'models' when it
			// cannot run the turn's models (D-20261018-09 PR), 'models-behind' when it had not yet
			// reached the asker's horizon on them by the deadline (HT3; the sender ends it "not run"
			// with Retry, rulings §1 l.17, and the lens counts it apart). '' otherwise, and from an older runner,
			// whose hand-back reads as a hand-off that did not finish.
			// 'refused' when a runner refused the turn before its run (RUN-HIST E: Kimberlite's no model
			// key, clamp, credits and spawn refusals), which the sender also ends "not run" with Retry.
			cause:   (o.cause === 'thread' || o.cause === 'models' || o.cause === 'models-behind'
				|| o.cause === 'refused') ? o.cause : '',
			// A `done` that ran nothing: a reload here cut the turn's run short, and the
			// final frame carries what it had done, badged (r545 F-C2-1). 0 elsewhere.
			interrupted: o.interrupted | 0,
			// AN `aborted` RUN CUT SHORT ON THE RUNNER (check_f234 fix 1): why it was cut
			// ('deadline', 'poison'), which the sender draws as Interrupted + Retry. '' otherwise.
			cut:     o.cut ? String(o.cut) : '',
			// THE WORDS THE SENDER SAID INTO THE RUN (`DaimondLease.say`) that reached the model,
			// by id (UNBLOCK-27 R7). The sender queues any it said that are not named here, so a
			// word said too late for the turn runs as the next one. [] from an older runner.
			heard:   triedList(o.heard),
			ts:      o.ts || Date.now(),
		};
		// THE TURN'S ROWS, carried to the asker's History (RUN-HIST): which files the turn made
		// or changed on the runner, and the restore reference `{on, run, since}` its Undo uses.
		// Present only when the runner kept something, so an older asker sees the report it knew.
		if (o.turnRec && typeof o.turnRec === 'object') rep.turnRec = o.turnRec;
		return rep;
	}

	/// Build an undo-turn envelope (not yet sealed): ask the runner `to` to undo its run
	/// `run`. No `since` travels: the runner reads it from its own record of the run, so a
	/// page cannot aim a restore at any trash turn it likes.
	function makeUndo(f) {
		var o = f || {};
		return {
			t:      T_UNDO,
			v:      ENVELOPE_V,
			uid:    String(o.uid || ''),
			to:     String(o.to || ''),
			by:     String(o.by || ''),
			keeper: String(o.keeper || ''),
			run:    String(o.run || ''),
			ts:     o.ts || Date.now(),
		};
	}

	/// A list of device ids, de-duplicated, as strings; [] for anything else.
	function triedList(v) {
		var out = [];
		(Array.isArray(v) ? v : []).forEach(function (x) {
			var id = String(x || '');
			if (id && out.indexOf(id) < 0) out.push(id);
		});
		return out;
	}

	/// An errand's `ids`: the newest `THREAD_IDS_MAX` non-empty strings, or null when it carries none.
	function idList(v) {
		if (!Array.isArray(v)) return null;
		var out = [];
		for (var i = Math.max(0, v.length - THREAD_IDS_MAX); i < v.length; i++) {
			var h = String(v[i] == null ? '' : v[i]);
			if (h) out.push(h);
		}
		return out;
	}

	/// `tried` with the runner that sent hand-back `r` added, or `tried` as a list when
	/// `r` is no hand-back or names no runner (an older runner's).
	function triedAfterHandBack(tried, r) {
		var out = triedList(tried);
		if (handBackReport(r) && r.by && out.indexOf(String(r.by)) < 0) out.push(String(r.by));
		return out;
	}

	/// Is a report a HAND-BACK: the runner ran nothing and the turn is the sender's to run?
	/// `undeliverable`, and r543's `busy`, which a page of that build still sends.
	function handBackReport(r) {
		return !!r && r.t === T_REPORT && (r.status === 'undeliverable' || r.status === 'busy');
	}

	/// Does a report SETTLE its turn, so nothing re-runs it here? Every report but a
	/// survivable `parked` and a hand-back. The ONE list (r544, QA F-A1): r543 kept it twice,
	/// here and in daimond.js, and the `busy` status it added to neither was read as a
	/// terminal failure by both, so a turn its runner handed back was never run.
	function settlingReport(r) {
		return !!r && r.t === T_REPORT && r.status !== 'parked' && !handBackReport(r);
	}

	/// A runner's report on errand `e`: `f`'s status and sentence, with the errand's turn,
	/// chat, id and addressee (`to` = its `dispatchedBy`) always taken from `e`.
	///
	/// EVERY REPORT A RUNNER POSTS IS BUILT HERE (R3 QA Q3, Q6). A report with no `to` is
	/// taken off the relay by the runner's own next collect before the device that sent the
	/// turn has it, and each place that built its own report was a place to forget the
	/// addressee: the pause refusal did, and the restarted runner's hand-back had no errand
	/// to name one from. `e` may be a lease record, which carries the turn, the errand id and
	/// the dispatcher (`leaseTakeFromCas`), for a hand-back made with no errand in hand.
	function reportFor(e, f) {
		var o = e || {};
		return makeReport(Object.assign({}, f, {
			eid: o.eid, to: o.dispatchedBy, turnId: o.turnId, chatId: o.chatId,
		}));
	}

	// ── The compile errand's bounds ────────────────────────────
	//
	// The post door takes 64 KiB per sealed envelope (gateway post.rs), and the
	// envelope is base64 of a GCM seal of JSON -- about 1.4x the plaintext. So the
	// inline budget is set where 24 KiB of source plus the hashes of a 29-file import
	// set (~4 KiB) still seals to well under 45 KiB. Past it a file rides as chunks,
	// which is the same door a Diamond's bytes already take.

	var COMPILE_FILES_MAX   = 16;			// changed files one errand may carry at all
	var COMPILE_FILE_CHARS  = 16 * 1024;	// past this ONE file goes to chunks
	var COMPILE_INLINE_CHARS = 24 * 1024;	// past this the REST of them go to chunks
	// Three minutes, not the turn's fifteen: a compile that has not started in three
	// minutes has a dead runner, and the phone's own "Compile here" is right there.
	var COMPILE_DEADLINE_MS = 3 * 60 * 1000;

	/// Split the changed files into what rides INLINE and what must be offloaded as
	/// chunks, or refuse the whole errand. Pure, so the rule is one table a test can
	/// enumerate rather than a shape the dispatcher happens to build.
	///
	/// `changed` is `[{ path, sha, text }]`. Answers
	/// `{ inline, offload, refused, why, n }` -- `why` an i18n key, because a refusal
	/// the user reads has to be a sentence in their language and not a thrown string.
	///
	/// REFUSING PAST THE COUNT IS THE HONEST ANSWER. Sixteen changed files is not a
	/// compile hand-off, it is a device that has not synced; the ordinary parcel
	/// carries the rest in one round and the compile then has nothing to send.
	function compilePlan(changed, opts) {
		var o = opts || {}, list = changed || [];
		var maxN     = o.filesMax   != null ? o.filesMax   : COMPILE_FILES_MAX;
		var maxFile  = o.fileChars  != null ? o.fileChars  : COMPILE_FILE_CHARS;
		var maxTotal = o.totalChars != null ? o.totalChars : COMPILE_INLINE_CHARS;
		if (list.length > maxN) {
			return { inline: [], offload: [], refused: true, n: list.length,
				why: 'files.compile_too_many_changed' };
		}
		var inline = [], offload = [], used = 0;
		for (var i = 0; i < list.length; i++) {
			var f = list[i] || {};
			var text = String(f.text == null ? '' : f.text);
			// Biggest first would pack better and read worse: the order files arrive in is
			// the order the import set names them, and a reader comparing the errand with
			// the sidecar should find the two in the same order.
			if (text.length > maxFile || used + text.length > maxTotal) {
				offload.push({ path: String(f.path || ''), sha: String(f.sha || ''), text: text });
				continue;
			}
			used += text.length;
			inline.push({ path: String(f.path || ''), sha: String(f.sha || ''), text: text });
		}
		return { inline: inline, offload: offload, refused: false, why: '', n: list.length };
	}

	/// THE KEY ONE LIVE PREVIEW OF ONE DOCUMENT IS STORED UNDER: a short hash of the
	/// folder token and the main's path, so two books in two folders never collide and
	/// the same book on two devices always agrees. Short on purpose -- it is an index
	/// key beside a few hundred workspace paths, not a content address.
	async function docKeyFor(wsid, main) {
		var bytes = utf8(String(wsid == null ? '' : wsid) + '\u0000' + String(main || ''));
		var h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		return hex(h).slice(0, 32);
	}

	/// Build a compile errand (not yet sealed): lay THIS document out, on a machine
	/// that can. `files` ride inline; `refs` are the same files as chunk manifests,
	/// already offloaded by the caller (the async half cannot live in an envelope
	/// builder). `expect` is the dispatcher's own view of the import set, so the
	/// runner can answer "stale" precisely rather than "something moved".
	function makeCompileErrand(f) {
		var o = f || {};
		var eid = o.eid || newId();
		return {
			t:        T_COMPILE,
			v:        ENVELOPE_V,
			eid:      eid,
			// The LEASE and PROGRESS key. A compile is not a turn, but every keyed door
			// here takes a string, so it gets one that cannot collide with a turn id.
			cid:      String(o.cid || ('cmp-' + eid)),
			main:     String(o.main || ''),
			want:     String(o.want || 'vector'),	// vector | pdf | publish
			// The folder token hash the dispatcher last saw for this document. '' means
			// "any folder"; a runner whose own token differs refuses rather than compiling
			// a book out of the wrong tree.
			wsid:     String(o.wsid || ''),
			docKey:   String(o.docKey || ''),
			files:    o.files || [],		// [{ path, sha, text }]
			refs:     o.refs  || [],		// [{ path, sha, ref: <manifest v2> }]
			expect:   o.expect || { imports: [], hashes: {} },
			deadline: +o.deadline || 0,		// epoch-ms (NOT |0: ms overflows 32 bits)
			dispatchedBy: String(o.dispatchedBy || ''),
			ts:       o.ts || Date.now(),
		};
	}

	/// Build a built report (not yet sealed): what the layout cost, what it read, and
	/// where the artifact is. The artifact itself never rides here -- it is chunks
	/// under `@p/<docKey>`, named by `vector`/`pdf` as manifests -- so the report stays
	/// a small write on the same 64 KiB door a turn's report uses.
	function makeBuilt(f) {
		var o = f || {};
		return {
			t:       T_BUILT,
			v:       ENVELOPE_V,
			eid:     String(o.eid || ''),
			cid:     String(o.cid || ''),
			main:    String(o.main || ''),
			status:  String(o.status || 'done'),	// done | error | refused | stale
			why:     o.why ? String(o.why) : '',	// the compiler's sentence, or the check's
			by:      String(o.by || ''),			// the lease holder, named by id not by label
			to:      String(o.to || ''),			// the compile's dispatcher, as a report's `to`
			ms:      o.ms | 0,						// wall time of the compile alone
			heap:    o.heap || { before: 0, after: 0, growth: 0, headroom: 0 },
			pages:   o.pages | 0,
			imports: o.imports || [],				// out.watch -- the import set as compiled
			hashes:  o.hashes || {},				// so the phone can tell stale from current
			wrote:   o.wrote || [],					// what the runner put into the real folder
			// WHICH FILES MOVED between dispatch and write. A second save landing in that
			// window is not an error and not a reason to refuse -- it is compiled anyway
			// and named, and the phone decides whether to ask again.
			moved:   o.moved || [],
			vector:  o.vector || null,				// manifest v2, or null on pdf/publish
			pdf:     o.pdf || null,
			docKey:  String(o.docKey || ''),
			ts:      o.ts || Date.now(),
		};
	}

	/// Build a consent-ask (not yet sealed): a runner's live question for a human.
	/// `cid` names THIS question and is minted FRESH on every ask (including a
	/// re-raise), so a captured or replayed grant for a spent `cid` matches nothing.
	/// `detail` is the EXACT uncut string the human must authorise -- never a summary;
	/// `dispatchedBy` is where the answer routes back to (the runner's device id);
	/// `target` is the ONE device that should raise the tile and answer -- the chat's
	/// SOURCE device by preference (owner rule 2026-09-05: a chat's permission belongs
	/// to the device it was driven from), or the fallback the decision chose. Empty
	/// keeps the old any-attended-device behaviour.
	function makeAsk(f) {
		var o = f || {};
		return {
			t:       T_ASK,
			v:       ENVELOPE_V,
			cid:     o.cid || newId(),		// names THIS question; fresh per ask
			eid:     String(o.eid || ''),
			turnId:  String(o.turnId || ''),
			chatId:  String(o.chatId || ''),
			tool:    String(o.tool || ''),
			host:    String(o.host || ''),
			detail:  String(o.detail == null ? '' : o.detail),	// the uncut string to authorise
			// 'consent' (a web act), or one of PERMIT_ASKS, whose grant must quote it.
			kind:    permitAsk(o.kind) ? String(o.kind) : 'consent',
			about:   String(o.about == null ? '' : o.about),	// a permit's { id, kits | place }, JSON
			deadline:     +o.deadline || 0,		// epoch-ms (NOT |0: ms overflows 32 bits)
			// How long the asker waits, in ms. The receiver counts it from when IT first saw
			// the question, so two devices' clocks never have to agree (B-F9); `deadline`,
			// on the asker's clock, stays for a receiver that predates this.
			wait:         +o.wait || 0,
			dispatchedBy: String(o.dispatchedBy || ''),	// the runner, so the grant routes home
			target:  String(o.target || ''),	// the device that should raise/answer this ask
			// THE ONE ADDRESSEE FIELD every note carries (`to`), read by `noteHeldFor`: an ask
			// that names its device is held for it. `target` stays for the raise rule that
			// reads it. Empty is the broadcast, which every collector holds for its life.
			to:      String(o.target || ''),
			ts:      o.ts || Date.now(),
		};
	}

	/// Build a consent-grant (not yet sealed): an attended device's answer. It signs
	/// `cid`/`turnId`/`verdict` but NOT `tool`/`host`/`detail` (they are not fields
	/// here, so the signature cannot cover them) -- so the runner must replay the EXACT
	/// act it bound to `cid`, never re-derive it from the grant. `verdict` is exactly
	/// what `egressAllowed` returns, so the runner needs no translation layer.
	function makeGrant(f) {
		var o = f || {};
		return {
			t:       T_GRANT,
			v:       ENVELOPE_V,
			cid:     String(o.cid || ''),
			eid:     String(o.eid || ''),
			turnId:  String(o.turnId || ''),
			verdict: o.verdict === 'allow' ? 'allow' : 'deny',
			by:      String(o.by || ''),		// the answering device, for the UI
			// WHICH BLOCKER this answers (owner ruling 2026-09-12). 'consent' is the
			// original per-turn permission and stays the default, so a grant from a
			// build that predates the blocker reads exactly as it did; 'ask' carries
			// the `ask` tool's chosen option in `choice`. The runner matches the kind
			// against what it is actually blocked on (`blockerAnswerDecision`), so an
			// answer to one question can never resolve another.
			kind:    String(o.kind || 'consent'),
			choice:  String(o.choice == null ? '' : o.choice),
			// THE RUNNER THAT ASKED (the ask's `dispatchedBy`). Without it a third device that
			// collected the grant took it and acked it off the relay before the runner saw it,
			// and the turn parked at its deadline (R3 QA Q4, D126). The answer is addressed to
			// it: a relay that acks per device keeps the grant for the runner whichever device
			// collects it first, and an older relay has it held for it, briefly. '' when the
			// caller names none: `sealForSelf` fills it from the ask this device saw, or from
			// the turn's live lease.
			to:      String(o.to || ''),
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
		// A grant names the runner it answers before it is signed, so the addressee is
		// covered by the signature like every other field.
		if (obj && obj.t === T_GRANT && !obj.to && !obj.sig) {
			var addressee = grantAddressee(obj);
			if (addressee) obj.to = addressee;
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
		var sealed = await (await sealBridge()).peerFrame(await window.DaimondIdentity.wrapBytesAad(plain, PEER_AAD));
		// The delivery address is the account's public key in the BASE64URL form the
		// gateway binds an account to (identity.js:publicKeyB64url). It is NOT the hex
		// of the raw key: the gateway looks a delivery up by the b64url string, so a
		// hex `to` matches no account and every post 404s ("No account holds that key").
		var to = window.DaimondIdentity.publicKeyB64url
			? window.DaimondIdentity.publicKeyB64url() : '';
		var body = {
			to:       to || '',
			addr:     await addressOf(sealed),
			envelope: b64enc(sealed),
		};
		// What the relay may know in the clear about a post to our own account: whose
		// it is, how long it matters, and which turn it belongs to (`relayMeta`). A
		// relay that does not read them ignores them.
		var meta = relayMeta(signed);
		for (var k in meta) if (Object.prototype.hasOwnProperty.call(meta, k)) body[k] = meta[k];
		return body;
	}

	// ── What the relay is told in the clear, about our own posts ─
	//
	// A relay that acks per device (gateway release 5, `acks: "device"` on a collect)
	// drops a row addressed to one device only on that device's ack, and forgets any
	// row at its `ttl`. So a note names the device it is for, and every row says how
	// long it is worth keeping; an errand names its turn, and the relay answers with
	// the turn's first post on its own clock (`first`), which the age rule reads. A
	// device id and a turn id are already in the clear on a presence beat and a
	// progress read, so nothing new is revealed, and only to our own account's relay.

	/// The asks this device has seen, `cid -> { by, deadline }`, so the answer to one
	/// can be addressed to the runner that asked. Bounded; the oldest goes first.
	var _askFrom = {}, _askOrder = [], ASK_FROM_MAX = 64;

	/// Remember who asked `ask`, and until when it can be answered.
	function noteAskFrom(ask) {
		if (!ask || ask.t !== T_ASK || !ask.cid) return;
		var cid = String(ask.cid);
		if (!_askFrom[cid]) _askOrder.push(cid);
		_askFrom[cid] = { by: String(ask.dispatchedBy || ''), deadline: +ask.deadline || 0 };
		while (_askOrder.length > ASK_FROM_MAX) delete _askFrom[_askOrder.shift()];
	}

	/// The runner a grant answers: the ask's `dispatchedBy` where this device saw the
	/// ask, else the holder of the turn's live lease (a blocker read off the lease), else
	/// '' and the grant goes to the account as it did.
	function grantAddressee(grant) {
		var a = _askFrom[String(grant.cid || '')];
		if (a && a.by) return a.by;
		var r = _leases[String(grant.turnId || '')];
		if (r && r.holder && liveLease(r, Date.now())) return String(r.holder);
		return '';
	}

	/// `{ for?, ttl?, turn? }` for a sealed post to our own account. Pure but for the
	/// ask memory and the clock. `ttl` is seconds and every span is read on the sender's
	/// own clock, so no two clocks are compared.
	function relayMeta(env, now) {
		var n = now == null ? Date.now() : now, out = {};
		if (!env) return out;
		var secs = function (ms) { return Math.max(30, Math.min(86400, Math.ceil(ms / 1000))); };
		if (env.t === T_REPORT || env.t === T_BUILT || env.t === T_UNDONE) {
			if (env.to) { out['for'] = String(env.to); out.ttl = secs(NOTE_HOLD_MS); }
		} else if (env.t === T_UNDO) {
			// Kept for the runner as long as the relay keeps anything: a day, its cap
			// (gateway/src/schema.rs:3444), short of the runner's 7-day keep. An ask still
			// unanswered after that goes again when the runner is seen back (versions.js
			// `undoTurnAgain`).
			if (env.to) { out['for'] = String(env.to); out.ttl = secs(86400000); }
		} else if (env.t === T_GRANT) {
			if (env.to) {
				var a = _askFrom[String(env.cid || '')];
				out['for'] = String(env.to);
				out.ttl = secs(a && a.deadline ? a.deadline - n + 30000 : NOTE_HOLD_MS);
			}
		} else if (env.t === T_ASK) {
			if (env.target) {
				out['for'] = String(env.target);
				out.ttl = secs(env.deadline ? env.deadline - n + 30000 : NOTE_HOLD_MS);
			}
		} else if (env.t === T_ERRAND) {
			// No `for`: an errand is claimed by whichever device may run it. It is kept
			// until no device may start it (the lease refuses a take past the deadline).
			if (env.turnId) out.turn = String(env.turnId);
			if (+env.deadline) out.ttl = secs(+env.deadline + LEASE_TTL_MS - n);
		}
		return out;
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
		var scheme = await (await sealBridge()).scheme(bytes);
		var sym = (scheme === 'DPY2' || scheme === 'DPY1') ? scheme : null;
		if (sym) {
			if (!window.DaimondIdentity || !window.DaimondIdentity.unwrapBytesAad) {
				throw new Error('peer: no identity, so a sealed peer body cannot be opened.');
			}
			var body = bytes.subarray(4);
			try {
				return sym === 'DPY2'
					? await window.DaimondIdentity.unwrapBytesAad(body, PEER_AAD)
					: await window.DaimondIdentity.unwrapBytes(body);	// DPY1 legacy, drop next release
			} catch (e) {
				// Only a failed GCM tag is "not for this device" -- a REFUSAL, typed as
				// post.js types its own (TAKEROW). A locked identity or an engine failure
				// is this device not ready, and goes up as it came, untyped: transient.
				if (!(e && e.name === 'OperationError')) throw e;
				var notOurs = new Error('peer: this errand was not sealed to this account, so it is not for this device.');
				notOurs.refusal = 'not_for_you';
				throw notOurs;
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
		if (!obj || !peerType(obj.t)) {
			throw new Error('peer: an opened envelope carried no known type tag.');
		}
		if (!(await verifyEnvelope(obj))) {
			throw new Error('peer: an opened envelope was not signed by this account, so it is refused.');
		}
		return obj;
	}

	/// Classify a collected row's sealed body WITHOUT verifying: unseal and parse,
	/// answer the object if it is a peer envelope (`t` in errand/report), or null for
	/// everything else -- a message artefact (not JSON), a row the seal REFUSES (a
	/// typed `refusal`), or a shape with no peer tag. This is the cheap peek `takeRow`
	/// does before the message read: a null falls straight through to the message path
	/// unchanged. Verification is deferred to `absorb`, so the peek stays a classify.
	///
	/// IT THROWS ONLY WHEN THIS DEVICE COULD NOT OPEN THE ROW (TAKEROW, 2026-10-16): the
	/// identity locked, no seal loaded, the engine failing. A null there sent a DPY row
	/// on to the message read, which called it "not sealed", kept it as bad, and the ack
	/// dropped an errand or a report for every device. `takeRow` leaves such a row on
	/// the relay and stops the pass.
	async function peek(b64) {
		var bytes, plain, obj;
		try { bytes = b64dec(b64); } catch (e) { return null; }
		try { plain = await openSealed(bytes); }
		catch (e) { if (e && e.refusal) return null; throw e; }
		try { obj = JSON.parse(fromUtf8(plain)); }
		catch (e) { return null; }
		if (obj && peerType(obj.t)) return obj;
		return null;
	}

	// The registered runners, set by daimond.js (step 4/5). Absent here, `absorb`
	// verifies and drops -- routing without a runner is a no-op, not a crash.
	var _onErrand = null;
	var _onReport = null;
	var _onAsk    = null;	// a runner's live consent question, raised on an attended device
	var _onGrant  = null;	// an attended device's answer, delivered to the awaiting runner
	var _onCompile = null;	// a compile errand, run on a machine that holds the folder
	var _onBuilt   = null;	// the runner's account of a compile, collected by the dispatcher
	var _onUndone  = null;	// a runner's account of an undone turn, for the device that asked
	function onErrand(fn) { _onErrand = fn; }

	/// How many turns this device is running for chats OTHER than `chatId`, 0 when it is
	/// free for it (H1). Registered by the app; absent, a device is never busy.
	var _busyProbe = null;
	function onBusyProbe(fn) { _busyProbe = fn; }
	function busyFor(chatId) {
		if (!_busyProbe) return 0;
		try { return busyDepth(_busyProbe(String(chatId || ''))); } catch (e) { return 0; }
	}

	/// Must this collected envelope be decided NOW rather than behind the work already
	/// running here (post.js `startWork`)? A turn errand for another chat, while this
	/// device is busy, is: it is answered at once, so no sender waits on a timer for a
	/// turn this device would only reach when its current one ends (H1, C1).
	function decideNow(env) {
		return !!(env && env.t === T_ERRAND && busyFor(env.chatId) > 0);
	}

	/// Does this device already hold work in the errand's chat -- its turn, queue, Diamond,
	/// workers or another runner turn of it? Registered by the app (`chatHasWork`); absent,
	/// a chat never has work.
	var _chatWorkProbe = null;
	function onChatWorkProbe(fn) { _chatWorkProbe = fn; }

	/// Must this collected envelope start NOW rather than behind the work chain (post.js
	/// `startWork`)? A busy answer does (`decideNow`), and so does a turn for a chat that
	/// already has work here (BUSY-SELF F1): behind the chain it reached no `runErrand`, took
	/// no lease, and the sender's backstop ran it on the sender. Started now, it takes the
	/// lease and waits in the app's `queueBehind`, which orders the turns of one chat. Asked
	/// before the turn registers, so its own run is not counted.
	function startsNow(env) {
		if (!env || env.t !== T_ERRAND) return false;
		if (decideNow(env)) return true;
		if (!_chatWorkProbe || !env.chatId) return false;
		try { return !!_chatWorkProbe(env); } catch (e) { return false; }
	}
	function onReport(fn) { _onReport = fn; }
	function onAsk(fn)    { _onAsk = fn; }
	function onGrant(fn)  { _onGrant = fn; }
	function onCompile(fn) { _onCompile = fn; }
	function onBuilt(fn)   { _onBuilt = fn; }
	function onUndone(fn)  { _onUndone = fn; }

	/// Does this envelope ask the device that collects it to RUN something -- a turn or
	/// a compile -- rather than note something? The collector folds a note where it
	/// collects it and starts work only after letting go of the mailbox lock (post.js
	/// `takeRow`), because a runner calls back into the mailbox from inside its run.
	function isWork(env) { return !!env && (env.t === T_ERRAND || env.t === T_COMPILE); }

	/// What a device runs once at a time for a work envelope: the turn, so a re-hand of a
	/// turn already running here waits for that run, or the compile.
	function workKey(env) {
		if (!env) return '';
		return env.t === T_COMPILE ? 'compile:' + String(env.cid || '') : turnWorkKey(env.turnId);
	}

	/// The work key of one turn, whoever runs it here. A runner's collect claims it
	/// (post.js `claimWork`) and so does every local run of a dispatched turn
	/// (daimond.js `recoverOneLocally`): the lease arbitrates between devices, and this
	/// claim between the tabs of one device, which share its id and so its lease.
	function turnWorkKey(turnId) { return 'turn:' + String(turnId || ''); }

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
		else if (obj.t === T_ASK    && _onAsk)    { noteAskFrom(obj); await _onAsk(obj, row); }
		else if (obj.t === T_GRANT  && _onGrant)  await _onGrant(obj, row);
		// A compile stands down the same way an errand does -- the result is propagated
		// so takeRow can HOLD the errand on the relay for a runner that deferred.
		else if (obj.t === T_COMPILE && _onCompile) result = await _onCompile(obj, row);
		else if (obj.t === T_BUILT   && _onBuilt)   await _onBuilt(obj, row);
		else if (obj.t === T_UNDONE  && _onUndone)  await _onUndone(obj, row);
		// An `undo-turn` is the runner's (kimberlite) to act on; a page leaves it, held for
		// its addressee as every note for another device is (`noteHeldFor`).
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
			} else if (obj.t === T_ASK) {
				tally.asks = (tally.asks | 0) + 1;
				if (h.onAsk) await h.onAsk(obj, row);
			} else if (obj.t === T_GRANT) {
				tally.grants = (tally.grants | 0) + 1;
				if (h.onGrant) await h.onGrant(obj, row);
			} else if (obj.t === T_COMPILE) {
				tally.compiles = (tally.compiles | 0) + 1;
				if (h.onCompile) await h.onCompile(obj, row);
			} else if (obj.t === T_BUILT) {
				tally.builts = (tally.builts | 0) + 1;
				if (h.onBuilt) await h.onBuilt(obj, row);
			} else if (obj.t === T_UNDONE) {
				tally.undones = (tally.undones | 0) + 1;
				if (h.onUndone) await h.onUndone(obj, row);
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
	// the thin wiring that runs that order.
	//
	// The order is load-bearing (§4.1) and it INVERTED at seq 223. The property has
	// not changed -- a peer must never claim an errand whose prompt it cannot read --
	// but the prompt is no longer on the parcel: the errand carries the thread
	// (`seedFrom`), so the ERRAND IS POSTED FIRST, the local turn is marked peer-held
	// SECOND, and the parcel follows LAST, in the background. What that removes is a
	// wait proportional to the whole account: 23.3 s of the owner's 27.6 s
	// send-to-claim was flushing 7.86 MB before the errand could be posted, for a
	// conversation of a few kilobytes.

	var DISPATCH_DEADLINE_MS = 15 * 60 * 1000;	// no peer should start a turn older than this
	var REASON_DISPATCHED    = 'dispatched';	// the interrupted-reason, beside 'offline'/'unloading'

	// The ordered step tags. The SEQUENCE is the safety property, so it is data a
	// test can assert, not just the shape of the wiring.
	var STEP_PUSH_PROMPT   = 'push-prompt';		// push the parcel (now LAST, in the background)
	var STEP_MARK_DISPATCH = 'mark-dispatched';	// mark the local turn why:'dispatched'
	var STEP_POST_ERRAND   = 'post-errand';		// seal + post the errand, carrying the thread seed

	// WHAT A SEED CARRIES. Enough of the thread for the runner to run the turn, and
	// no more: a tail of WHOLE messages under a total budget, so the errand stays a
	// small sealed envelope on the post door rather than a second parcel. Measured
	// against the live fault it exists to remove -- a 7.86 MB parcel flushed BEFORE the
	// errand was posted -- these are three orders of magnitude smaller.
	var SEED_MAX_MSGS  = 24;				// the thread's tail, newest-last
	var SEED_MAX_CHARS = 64 * 1024;			// the whole seed's content budget
	// What a seed from before whole-message seeds cut each message to. Such a seed says
	// nothing of which rows it cut, so a row this long in one is taken as cut.
	var LEGACY_SEED_MSG_CHARS = 16 * 1024;
	// How many of the asker's message ids an errand carries (QA r572z-A N1): at most 7 base-36
	// characters each, so at most ~5 KiB of JSON beside the prompt, whether or not the seed is
	// dropped to fit the post. Older rows than these are judged by count alone.
	var THREAD_IDS_MAX = 512;

	/// Is this row part of the conversation a model is fed? THE ONE RULE (FIRE C2-READY, QA r572y C2b F3)
	/// that `throughOf`, `seedFrom`, `threadSig` and so `threadReadiness` share, so the message an errand
	/// says the asker last saw is always one its seed can carry and its fingerprint counts.
	function conversational(m) {
		if (!m || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool')) return false;
		// A render-only provisional row is not history: a final frame the runner cut at the door
		// (`progressRow`) is held provisional until the runner's own copy lands (F4).
		if (m.provisional) return false;
		// A cut turn's LANDED partial answer is memory (C2: `landFailedTurn`, the kill path, a recovered
		// row). A hand-off's placeholder is not, whatever words it shows, nor a badge with none.
		if (m.interrupted) return !!m.content && m.why !== REASON_DISPATCHED;
		return true;
	}

	/// THE THREAD THE ERRAND CARRIES. Pure over a chat's `messages`: the tail, ending
	/// at the turn's own user message, whole messages only, the whole under
	/// `SEED_MAX_CHARS`, oldest dropped first.
	///
	/// This is the whole of why the errand no longer waits for the parcel. The order
	/// was push-then-post because a peer must never claim an errand whose prompt it
	/// cannot read -- and on a phone carrying a 7.86 MB account that push was 23.3 s
	/// of the 27.6 s the owner waited to see the claim, for a conversation measured in
	/// kilobytes. The safety property is unchanged and the means are different: the
	/// runner reads the thread off the ERRAND, and the parcel (the workspace, the
	/// Diamonds, the rest of the account) follows in the background.
	///
	/// Only `conversational` rows travel: a `think_log`, a `vision_log` and every
	/// other view-only row are left out -- the runner rebuilds its own. Answers null where there is nothing to seed,
	/// so an errand carries `seed: null` rather than an empty shell.
	function seedFrom(chat, turnId, maxMsgs, maxChars) {
		var c = chat || {}, msgs = Array.isArray(c.messages) ? c.messages : [];
		var id = String(turnId || '');
		var nMax = (maxMsgs | 0) > 0 ? (maxMsgs | 0) : SEED_MAX_MSGS;
		var cMax = (maxChars | 0) > 0 ? (maxChars | 0) : SEED_MAX_CHARS;
		// END AT THE TURN'S OWN USER MESSAGE. Anything after it on the dispatcher is
		// the placeholder it is about to write, which the runner must not be seeded with.
		var end = msgs.length;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m && m.role === 'user' && String(m.mid || '') === id) { end = i + 1; break; }
		}
		var keep = [];
		var used = 0;
		for (var j = end - 1; j >= 0 && keep.length < nMax; j--) {
			var mm = msgs[j];
			// A seed marked `whole` must not carry a provisional row, or a runner lacking the
			// answer grafts the cut copy as the real one (F4); `conversational` leaves it out.
			if (!conversational(mm)) continue;
			var body = String(mm.content == null ? '' : mm.content);
			// A person's message brings the note it took (U4), counted with it: the budget is
			// the envelope's size, and the note rides the same seal.
			var note = (mm.role === 'user' && typeof mm.pre === 'string') ? mm.pre : '';
			// WHOLE OR NOT AT ALL (slowparcel CASE 3). A cut copy carries the message's
			// mid, so the runner's graft takes it for the message and `holdsThread`,
			// which reads roles and mids and never content, passes it: the runner then
			// fed the model the first 16 KiB of a 20 KiB paste and said nothing. A
			// message that does not fit ENDS the tail instead, so a runner that lacks it
			// fails `holdsThread` and pulls the parcel or hands the turn back. The turn's
			// own message is the exception: it is skipped, not an end, because the prompt
			// rides the errand whole and the reconstruct writes it from there.
			if (used + body.length + note.length > cMax) {
				if (mm.role === 'user' && String(mm.mid || '') === id) continue;
				break;
			}
			used += body.length + note.length;
			var sm = { role: mm.role, content: body, mid: String(mm.mid || ''), ts: +mm.ts || 0 };
			if (note) sm.pre = note;
			// An app-made record keeps its mark, so a runner's copy of it is the same record.
			if (mm.role === 'user' && mm.app === true) sm.app = true;
			// An interjection was said into a turn, never run as one, so the runner's engine
			// leaves it unmarked as the tab's does (B3, EP-6 F6L).
			if (mm.role === 'user' && mm.interject) sm.interject = true;
			// A landed partial travels as one, so the runner's copy carries the same badge.
			if (mm.interrupted) { sm.interrupted = 1; if (mm.iturn) sm.iturn = String(mm.iturn); }
			keep.unshift(sm);
		}
		if (!keep.length) return null;
		return {
			chatId:   String(c.id || ''),
			// The record's own `name` (it was `title`, a field no chat record has, so a seed
			// never carried the name), and the worker the dispatcher chose (r53 W-rec).
			name:     String(c.name || ''),
			provider: String(c.provider || ''),
			model:    String(c.model || ''),
			workerModel:    String(c.workerModel || ''),
			workerProvider: String(c.workerProvider || ''),
			effort:   String(c.effort || ''),		// the chat's Effort, so the runner thinks as hard
			whole:    1,				// no message in `msgs` is cut; see seedGraft
			msgs:     keep,
		};
	}

	/// WHAT A RUNNER IS MISSING from a seeded errand: the seed's messages whose `mid`
	/// the chat it holds does not already carry, in the seed's own order. Pure, so
	/// the graft is decided here and daimond.js only appends what this names.
	///
	/// A chat the runner has never seen answers the whole seed -- which is what lets
	/// it build the thread and run, rather than block for the parcel and hand the turn
	/// back `undeliverable`. A chat already holding every message answers nothing, so
	/// a runner whose pull landed first does no work.
	///
	/// A seed from a dispatcher older than whole-message seeds (no `whole`) may hold
	/// cut copies, and a cut copy grafted under its mid would pass `holdsThread`. So
	/// in such a seed a row at the old cut length is not taken: the graft keeps only
	/// the tail after it, and a runner lacking it pulls the parcel or hands back.
	function seedGraft(chat, errand) {
		var e = errand || {}, seed = e.seed;
		if (!seed || !Array.isArray(seed.msgs) || !seed.msgs.length) return [];
		var have = {}, msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m && m.mid) have[String(m.mid)] = 1;
		}
		var from = 0, skip = {};
		if (!seed.whole) {
			for (var k = seed.msgs.length - 1; k >= 0; k--) {
				var cm = seed.msgs[k];
				if (!cm || String(cm.content == null ? '' : cm.content).length < LEGACY_SEED_MSG_CHARS) continue;
				// The turn's own message: the prompt rides the errand whole.
				if (cm.role === 'user' && String(cm.mid || '') === String(e.turnId || '')) { skip[k] = 1; continue; }
				from = k + 1;
				break;
			}
		}
		var out = [];
		for (var j = from; j < seed.msgs.length; j++) {
			var sm = seed.msgs[j];
			if (skip[j] || !sm || !sm.mid || have[String(sm.mid)]) continue;
			out.push(sm);
		}
		return out;
	}

	/// Does a chat hold the turn this errand names -- the user message the runner
	/// anchors `promptInTranscript` to? The reconstruct's readiness test, so a chat
	/// that synced BEFORE the prompt is not mistaken for one that can run it.
	function holdsTurn(chat, turnId) {
		var id = String(turnId || '');
		if (!id) return false;
		var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m && m.role === 'user' && String(m.mid || '') === id) return true;
		}
		return false;
	}

	/// FNV-1a over a string, 32-bit unsigned. Only for the content-free thread
	/// fingerprint below -- a fast, dependency-free hash, never a cryptographic one.
	function fnv1a(s) {
		var h = 0x811c9dc5, str = String(s == null ? '' : s);
		for (var i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return h >>> 0;
	}

	/// The thread's fingerprint UP TO (excluding) the turn's own user message: `{ n, sig }`
	/// over the model-facing rows' `role:mid` pairs. CONTENT-FREE, so it costs almost
	/// nothing on the errand and cannot disagree with itself across seed clips -- it names
	/// no content, only the shape of the prefix a model would be fed: the `conversational`
	/// rows, exactly those `seedFrom` carries.
	/// `gone` (optional) lists mids the sender has removed and the copy may still hold.
	/// `behind` (optional) lists turns whose answer rows are left out, as the sender's
	/// thread lacked them (`openTurn`). `asked` (optional) lists turns whose prompt rows
	/// are left out too: a runner's own turns the sender had not yet seen asked.
	function threadSig(chat, turnId, gone, behind, asked) {
		var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		var id   = String(turnId || '');
		var out  = goneSet(gone);
		var skip = goneSet(behind);
		var ask  = goneSet(asked);
		var parts = [], n = 0;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (!m || !m.role) continue;
			if (m.role === 'user' && String(m.mid || '') === id) break;	// stop AT the turn's user message
			if (!conversational(m)) continue;
			if (out[String(m.mid || '')]) continue;			// removed by the sender
			if (m.role !== 'user' && skip[String(m.iturn || '')]) continue;	// a queued-behind answer
			if (m.role === 'user' && (ask[String(m.mid || '')] || ask[String(m.iturn || '')])) continue;	// an unseen own prompt
			parts.push(m.role + ':' + String(m.mid || ''));
			n++;
		}
		return { n: n, sig: fnv1a(parts.join('\n')) };
	}

	/// The short hash an errand's `ids` names a message by: FNV-1a of its mid, base 36.
	function midHash(mid) { return fnv1a(String(mid)).toString(36); }

	/// THE MESSAGES THE ASKER HOLDS before the turn's own prompt, oldest first, as `midHash`es: the
	/// rows `threadSig` counts on the sender, so `ids.length` is `thread.n` up to `THREAD_IDS_MAX`.
	function threadIds(chat, turnId) {
		var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		var id = String(turnId || ''), out = [];
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (!m || !m.role) continue;
			if (m.role === 'user' && String(m.mid || '') === id) break;
			if (!conversational(m)) continue;
			out.push(midHash(m.mid || ''));
		}
		return out.length > THREAD_IDS_MAX ? out.slice(out.length - THREAD_IDS_MAX) : out;
	}

	/// How many of the errand's `ids` this view does not hold as a conversational row.
	function idsMissing(view, ids) {
		var have = {}, msgs = view.messages, n = 0;
		for (var i = 0; i < msgs.length; i++) if (conversational(msgs[i])) have[midHash(msgs[i].mid || '')] = 1;
		for (var j = 0; j < ids.length; j++) if (!have[ids[j]]) n++;
		return n;
	}

	/// The mids of an errand's `gone` list as a lookup.
	function goneSet(gone) {
		var out = {};
		triedList(gone).forEach(function (mid) { out[mid] = 1; });
		return out;
	}

	/// The handed-off turns of `chat` still unanswered ahead of `turnId`, oldest first.
	/// Walking back from it, each turn counts while it is marked dispatched and the sender
	/// holds no model-facing row of its answer; the first that is not ends the run. A turn
	/// sent now queues behind them all on their runner, which will hold their answers by
	/// the time it takes this one (UNBLOCK-1 3b).
	function openTurn(chat, turnId) {
		var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		var id = String(turnId || ''), asked = [], sent = {}, done = {}, i, m, t;
		for (i = 0; i < msgs.length; i++) {
			m = msgs[i];
			if (!m) continue;
			if (m.role === 'user' && String(m.mid || '') === id) break;
			if (m.role === 'user') asked.push(String(m.iturn || m.mid || ''));	// a hand-off's prompt has the turn id for its mid
		}
		for (i = 0; i < msgs.length; i++) {
			m = msgs[i];
			t = m ? String(m.iturn || '') : '';
			if (!t) continue;
			if (m.why === REASON_DISPATCHED) sent[t] = 1;
			else if ((m.role === 'assistant' || m.role === 'tool') && !m.interrupted && !m.provisional) done[t] = 1;	// answered here
		}
		var out = [];
		for (i = asked.length - 1; i >= 0; i--) {
			t = asked[i];
			if (!t || !sent[t] || done[t]) break;
			out.unshift(t);
		}
		return out;
	}

	/// Does this copy's thread match the errand's, as it stands or less the answers to the
	/// turns the errand queued behind? The second reading is taken only where one is named.
	/// `own` (optional) lists the runner's own turns in the chat that were in flight when
	/// the errand came (UNBLOCK-1 BUSY-SELF): the sender may have seen none of their rows,
	/// their prompts only, or all of them, so each of those readings is tried as well.
	function threadMatches(view, e, own) {
		var want = e.thread, b = triedList(e.behind), o = triedList(own);
		var reads = [[null, null]];
		if (b.length) reads.push([b, null]);
		if (o.length) {
			var bo = b.concat(o);
			reads.push([o, null], [bo, null], [o, o], [bo, o]);
		}
		for (var i = 0; i < reads.length; i++) {
			var t = threadSig(view, e.turnId, e.gone, reads[i][0], reads[i][1]);
			if (t.n === (want.n | 0) && t.sig === (want.sig >>> 0)) return true;
		}
		return false;
	}

	/// The last message the asker saw before this turn's prompt, as `{ ts, mid }`: the newest
	/// `conversational` user or assistant row with words and a mid, other than the turn's own
	/// prompt and the rows of this turn. null when there is none. This is what an errand's
	/// `through` names.
	function throughOf(chat, turnId) {
		var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		var tid = String(turnId || '');
		for (var i = msgs.length - 1; i >= 0; i--) {
			var m = msgs[i];
			if (!conversational(m) || !m.mid || !m.content || m.role === 'tool') continue;
			if (tid && (String(m.mid) === tid || String(m.iturn || '') === tid)) continue;
			return { ts: +m.ts || 0, mid: String(m.mid) };
		}
		return null;
	}

	/// Does this copy of the chat hold the message the errand's asker last saw? True when the
	/// errand names none (an older sender, or a chat with nothing before the prompt). The copy
	/// alone: `threadReadiness` asks it of the copy with the seed laid in where that counts.
	function holdsThrough(chat, errand) {
		var t = errand && errand.through;
		if (!t || !t.mid) return true;
		var mid = String(t.mid);
		var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		for (var i = 0; i < msgs.length; i++) if (msgs[i] && String(msgs[i].mid) === mid) return true;
		return false;
	}

	/// Does this chat hold EXACTLY the thread the errand was dispatched from -- the same
	/// model-facing prefix, by `{ n, sig }`? An errand without `thread` (an older dispatcher)
	/// falls back to `holdsTurn`, so a mixed-build fleet still hands off in both directions.
	/// Readiness is `threadReadiness`, which also runs a copy holding more than the asker.
	function holdsThread(chat, errand, own) {
		var e = errand || {};
		// A non-resident chat shows a summary, not its transcript: it holds no thread yet.
		if (chat && chat._loaded === false) return false;
		if (!e.thread || typeof e.thread.n !== 'number') return holdsTurn(chat, e.turnId);
		return threadMatches(chat, e, own);
	}

	/// IS THIS COPY READY TO RUN THE ERRAND'S TURN? The one readiness check (FIRE C2-READY, QA
	/// r572y C2b F1/F2), judged on the asker's WHOLE history, not only the last message it saw:
	/// `peerReady` asks it before the claim and `peerReconstruct` after the graft, so the two
	/// cannot disagree. Answers `{ state, ready, have, want, lack }`, `state` one of:
	///   match    -- the thread is the dispatcher's, by `{ n, sig }` (`threadMatches`);
	///   diverged -- it holds as many model-facing rows as the asker and the asker's last
	///               message, and rows the asker never saw: memory belongs to the converged
	///               transcript (UNBLOCK-11), so it runs;
	///   behind   -- it lacks rows the asker held (`lack` of them, at least one): it keeps
	///               pulling to the one deadline, then runs and says so.
	/// `ready` is match or diverged. A chat that is not resident is behind (load it); an absent
	/// one is built from the seed. An errand with no thread (an older dispatcher) is judged by
	/// `holdsTurn`, `want` -1 and `lack` 0, as its lack cannot be counted.
	/// The seed is grafted VIRTUALLY, so the answer costs no write and a runner may ask it
	/// before it claims (D2, 11 Oct). After the graft `{ copy: true }` asks the copy alone, so a
	/// graft that failed is seen (C2 r3b).
	/// `held` is this device's sync version: a copy not yet holding the sender's parcel
	/// (`held < errand.parcelVersion`) may still lose rows to a deletion in flight (a Retry
	/// tombstones the old answer and dispatches before that parcel lands), so it is only
	/// `behind`, never `diverged`. Without `held` the rows alone judge.
	/// `own` names the runner's own in-flight turns in the chat (`threadMatches`); behind and
	/// diverged are judged with every row of theirs left out, as the sender may lack them.
	function threadReadiness(chat, errand, held, own, opts) {
		var e = errand || {};
		var resident = !!chat && chat._loaded !== false;
		var base = resident && Array.isArray(chat.messages) ? chat.messages : [];
		var view = (opts && opts.copy) ? { messages: base } : { messages: base.concat(seedGraft({ messages: base }, e)) };
		var o = triedList(own);
		var mine = threadSig(view, e.turnId, e.gone, o, o);
		if (!e.thread || typeof e.thread.n !== 'number') {
			var turn = !(chat && !resident) && holdsTurn(view, e.turnId);
			return { state: turn ? 'match' : 'behind', ready: turn, have: mine.n, want: -1, lack: 0 };
		}
		var wantN = e.thread.n | 0;
		var out = { have: mine.n, want: wantN };
		// WHICH rows, not how many (QA r572z-A N1): a row the asker never saw -- the runner's own
		// answer to an earlier hand-off -- must not make up for an older one it lacks. Rows older
		// than the errand's ids, and an older sender's errand without them, are judged by count.
		var miss = Array.isArray(e.ids) ? idsMissing(view, e.ids) : 0;
		if (chat && !resident) out.state = 'behind';		// load it, then ask again
		else if (threadMatches(view, e, o)) out.state = 'match';
		else if (miss > 0 || mine.n < wantN || !holdsThrough(view, e)) out.state = 'behind';
		else out.state = typeof held === 'number' && held < (e.parcelVersion | 0) ? 'behind' : 'diverged';
		out.ready = out.state !== 'behind';
		out.lack  = out.ready ? 0 : Math.max(1, miss, wantN - mine.n);
		return out;
	}

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
		var pre      = String(o.pre == null ? '' : o.pre);		// the note beside it (U4), '' for none
		var effort   = String(o.effort || '');				// the Effort it runs with, '' for the default
		// The peer must run the model the CHAT chose, not the peer's own default.
		var model    = o.model || { provider: c.provider || '', model: c.model || '', url: String(o.url || '') };
		// The Diamond the chat belongs to, so the runner services a daimon turn through
		// `steer_crystal` rather than the chat engine. Taken from the caller, or the chat.
		var diamondId = String(o.diamondId || c.diamondId || '');
		var scope    = o.scope || null;			// the workspace fence -- scopeChatTo, daimond.js:17553
		var fence    = o.fence || null;			// the absolute roots the Hand gets (R3c2), or null
		var pause    = o.pause || null;			// pause-tree snapshot pinned to dispatch -- §1.1
		var deadline = leaseMs(o.deadline) || (now + DISPATCH_DEADLINE_MS);
		var by       = String(o.dispatchedBy || '');
		// The prior-park total this dispatch inherits (0 on a first dispatch). A
		// re-dispatch of a parked turn carries the GLOBAL count read from the synced
		// placeholder / parked report, so the ≤MAX_PARKS bound holds across devices.
		var parkCount = o.parkCount | 0;
		var tried    = triedList(o.tried);		// the runners that handed it back (Q19)
		// THE THREAD, ON THE ERRAND. Taken from the chat the caller handed in, so the
		// errand is self-sufficient and the order below can put it first. A caller that
		// passes `seed: false` suppresses it (the recovery path, which is running the
		// turn on the device that already holds the chat).
		var seed = (o.seed === false) ? null
			: (o.seed || seedFrom(c, turnId, o.seedMaxMsgs, o.seedMaxChars));
		// THE THREAD'S FINGERPRINT, computed from the SAME chat the seed is (content-free,
		// so it is unaffected by whether the seed is clipped or dropped). It rides the
		// errand and decides the runner's readiness -- the seed only ACCELERATES a runner
		// that has not synced; the sig decides whether the thread is complete there.
		//
		// NEVER FROM AN UNLOADED CHAT (D2, 11 Oct). A non-resident chat holds only the new
		// user row, so its fingerprint read n = 0 against a runner holding the real thread,
		// which could never match. The caller makes the chat resident first; reaching here
		// without it is a bug, refused rather than sent.
		if (c._loaded === false && (o.thread === undefined || (o.seed !== false && !o.seed))) {
			throw new Error('the thread cannot be taken from a chat whose transcript is not loaded');
		}
		var thread = (o.thread !== undefined) ? o.thread : threadSig(c, turnId);
		var gone   = triedList(o.gone);		// removals not yet in a parcel
		var to     = String(o.to || '');		// the elected runner
		var behind = openTurn(c, turnId);		// the running turns this one queues behind
		var through = throughOf(c, turnId);	// the last message the asker saw
		var ids    = threadIds(c, turnId);		// which messages it held (N1)
		return {
			// MARK FIRST, then post, then push. The durable `why:'dispatched'`
			// placeholder is written BEFORE the errand is posted, so a refused post is a
			// TRANSCRIPT event a store-driven rebuild reproduces -- not DOM chrome the
			// rebuild wipes, leaving the user an empty turn (D-20260918-27). The mark is a
			// LOCAL write, no network, so it does not reintroduce the seq-223 wait: the
			// errand still carries the thread (`seed`) and is still posted AHEAD of the
			// parcel PUSH, which was the whole of seq 223 -- a peer that claims reads the
			// prompt at once and waits on no whole-account flush. The parcel goes LAST and
			// in the BACKGROUND: the workspace, the Diamonds and the rest of the account
			// still travel, and nothing the runner waits on is behind them.
			order:  [STEP_MARK_DISPATCH, STEP_POST_ERRAND, STEP_PUSH_PROMPT],
			turnId: turnId, chatId: chatId, eid: eid, seed: seed,
			// What daimond.js writes on the local turn BETWEEN the push and the post,
			// so recoverInterrupted and Continue treat it as peer-held, not a local
			// interruption (§3.3). The runner/guards consult it in step 6.
			mark: { interrupted: true, why: REASON_DISPATCHED, iturn: turnId, itext: prompt, dispatchedBy: by, parkCount: parkCount },
			/// The errand. `parcelVersion` is the version the dispatcher's push WILL
			/// commit at, where it is known; with the post now ahead of the push it is 0,
			/// which the receiver reads as "no target version" and its progress-based
			/// catch-up already handles. The seed is what the runner actually needs.
			errand: function (parcelVersion) {
				return makeErrand({
					eid: eid, turnId: turnId, chatId: chatId, diamondId: diamondId,
					prompt: prompt, pre: pre, effort: effort, model: model,
					scope: scope, fence: fence, pause: pause, parcelVersion: parcelVersion,
					deadline: deadline, dispatchedBy: by, parkCount: parkCount, ts: now,
					seed: seed, thread: thread, tried: tried, asks: PERMIT_ASKS,
					gone: gone, to: to, behind: behind, through: through, ids: ids,
					auto: o.auto === true,
				});
			},
			// The fully-resolved fields (bar parcelVersion), exposed for inspection.
			fields: {
				turnId: turnId, chatId: chatId, diamondId: diamondId, prompt: prompt, pre: pre, effort: effort,
				model: model, scope: scope, fence: fence,
				pause: pause, deadline: deadline, dispatchedBy: by, eid: eid, parkCount: parkCount,
				seed: seed, thread: thread, tried: tried, gone: gone, to: to, behind: behind, through: through, ids: ids,
			},
		};
	}

	/// Seal the dispatch errand, DROPPING the thread seed when the sealed envelope
	/// would not fit the relay. The seed is a fast-path for a peer that has NOT synced
	/// (peer.js §, "a device that has not synced"); a peer already holding the thread
	/// grafts nothing from it. When the recent tail is large the seed both DUPLICATES
	/// what a synced peer already has AND seals past the post door -- and the gateway
	/// then 413s the WHOLE hand-off, so the errand never arrives and the turn is lost.
	/// So the sealed size is measured against the effective `/api/post` cap
	/// (`DaimondPost.relayMaxBytes`, the one number the relay client owns), and on a miss
	/// the errand is re-sealed with `seed:false`: the runner reconstructs the thread from
	/// the parcel it is syncing anyway (`seedGraft` returns nothing, `peerReconstruct`
	/// pulls), the documented fallback -- a reconstruct wait, never the turn.
	///
	/// `plan` (optional) is a `buildDispatch` result the caller already built, so the
	/// local mark can be drawn before this awaits; omitted, it is built here. `cap`
	/// (optional) overrides the relay cap, for tests. Answers
	/// `{ plan, body, seedDropped, sealedLen }` -- `plan` is the one whose `errand` the
	/// returned `body` actually seals (the seedless re-seal when the seed was dropped).
	async function sealFittingErrand(chat, opts, plan, cap) {
		// The door: `DaimondWire.fits('post', b64Len)` (the one client-side owner of the
		// post cap), or the relay client's own `fitsRelay`, or the bare estimate -- and an
		// explicit `cap` overrides all three for tests.
		var lim = (cap | 0) > 0 ? (cap | 0)
			: (window.DaimondWire && DaimondWire.limit && DaimondWire.limit('post') > 0 ? DaimondWire.limit('post')
				: (window.DaimondPost && DaimondPost.relayMaxBytes ? DaimondPost.relayMaxBytes() : (64 * 1024)));
		function fits(envLen) {
			if ((cap | 0) > 0) return Math.floor(envLen / 4) * 3 <= (cap | 0);
			if (window.DaimondWire && DaimondWire.fits) return DaimondWire.fits('post', envLen);
			if (window.DaimondPost && DaimondPost.fitsRelay) return DaimondPost.fitsRelay(envLen);
			return Math.floor(envLen / 4) * 3 <= lim;
		}
		var o = opts || {};
		var prompt  = String(o.prompt == null ? '' : o.prompt);
		var p       = plan || buildDispatch(chat, opts);
		var threadN = (p.fields && p.fields.thread && (p.fields.thread.n | 0)) || 0;
		var hadSeed = !!(p.fields && p.fields.seed);
		var body    = await sealForSelf(p.errand(0));
		var envLen  = String((body && body.envelope) || '').length;
		var tries   = 1;
		function answer(pl, bod, dropped, t) {
			var sm = (pl.fields && pl.fields.seed && pl.fields.seed.msgs) ? pl.fields.seed.msgs.length : 0;
			return { plan: pl, body: bod, seedDropped: dropped,
				seedClipped: sm > 0 && sm < threadN, tries: t,
				sealedLen: String((bod && bod.envelope) || '').length };
		}
		if (!hadSeed || fits(envLen)) return answer(p, body, !hadSeed && threadN > 0, tries);

		// The seed is present but the sealed envelope is over the door. SHRINK it -- not to
		// nothing at once (a synced peer grafts the tail and completes instantly), but down
		// a ladder, re-measuring each rung against the SAME door. `DaimondWire.fits` is the
		// door (WS-BRICK's `daimond_wire_fits_seam_plan` follow-on). Seedless is the last
		// rung: the runner reconstructs from the parcel it is syncing anyway, and its
		// readiness is `holdsThread`, so it never runs a truncated thread (S-HAND #3).
		var cMax0   = Math.min(SEED_MAX_CHARS, Math.floor(lim * 3 / 4) - prompt.length - String(o.pre == null ? '' : o.pre).length - 4096);
		var budgets = [cMax0, Math.floor(cMax0 / 2), Math.floor(cMax0 / 4)];
		for (var b = 0; b < budgets.length; b++) {
			if (budgets[b] <= 0) break;
			var o2 = {}; if (opts) Object.keys(opts).forEach(function (k) { o2[k] = opts[k]; });
			o2.seedMaxChars = budgets[b];
			o2.eid = p.fields.eid;			// keep the errand id stable across the re-seal
			var pc   = buildDispatch(chat, o2);
			var bc   = await sealForSelf(pc.errand(0));
			tries++;
			if (fits(String((bc && bc.envelope) || '').length)) return answer(pc, bc, false, tries);
		}
		// Seedless.
		var o3 = {}; if (opts) Object.keys(opts).forEach(function (k) { o3[k] = opts[k]; });
		o3.seed = false;
		o3.eid  = p.fields.eid;
		var pd = buildDispatch(chat, o3);
		var bd = await sealForSelf(pd.errand(0));
		tries++;
		return answer(pd, bd, true, tries);
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
	///   parked         -- report status 'parked': "needs your permission — it will
	///                     re-run when you're back" (a survivable park, below the bound)
	///   blocked        -- the lease carries a `blocker`: the runner is stopped on a
	///                     permission, a question, a lock or a provider refusal, and
	///                     the tile shows it with the runner's own controls
	///   awaiting-consent -- an open consent-ask for this turn: the runner is blocked
	///                     on a live question the user must answer -- "<peer> needs your
	///                     permission to {act}", replacing "Sent to your other devices."
	///   interrupted    -- the runner cut the run short (its deadline, a poisoned engine)
	///                     and settled it: "Interrupted on <machine>" + [Retry]
	///   ending         -- the lease was taken only to END the turn "not run" (`endingLease`),
	///                     or this device is ending it so (`localRun` 'end'): nothing ran
	///                     and nobody is on it, live, settled or before the claim lands
	///   failed         -- report a failure (a terminal park included), OR the lease
	///                     expired mid-run with no report (the peer stopped): the `why`
	///                     sentence + [Run here]
	/// `ask` is a collected consent-ask envelope for this turn, or null. `localRun` says
	/// this device has taken the turn on itself (a hand-off that fell back here) before
	/// its own claim lands: it reads `claimed`, by this device, never "Sending to <runner>";
	/// 'end' says this device is ending it "not run", which reads `ending`.
	function uiState(turn, lease, report, selfId, now, ask, localRun) {
		if (!turn || turn.why !== REASON_DISPATCHED) return 'not-dispatched';
		var n = now == null ? Date.now() : now;
		// ENDED, NOT RUN (SUHT-I9). Before any report: a runner's hand-back report is what
		// sends a turn here to be ended, and read first it drew "<asker> is picking this up".
		// Its own end before the claim lands reads so too, unless ANOTHER device's live lease
		// says otherwise: its own run claim left live (a reload) is not a run, as the work
		// claim (`claimTurnHere`) holds no run of the turn here while it ends it (I9-LOWS LOW-2).
		// An ending lease reads so only while the end is in force, live or settled: one past
		// its deadline unsettled is an end that never finished, so it falls through to
		// failed and [Run here], as the updater's `leaseFree` already reads it (LOW-1).
		if (endingLease(lease) && (liveLease(lease, n) || settledLease(lease))) return 'ending';
		if (localRun === 'end' && !(liveLease(lease, n) && String(lease.holder) !== String(selfId))) return 'ending';
		// A report settles it either way, and outlives the lease.
		if (report && report.t === 'report') {
			if (report.status === 'done')   return 'done';
			if (report.status === 'parked') return 'parked';	// survivable: re-runs when a human is back
			// UNDELIVERABLE: the peer could not sync the chat and handed the turn back. A
			// spinner ('claimed') only where this device will run it itself -- the same
			// gate the recovery goes through (`recoverDecision`). Anywhere else nothing
			// will ever pick it up (a non-sender, an ask answer, a hand-off past its
			// deadline), so the tile says so and offers [Run here] rather than spin for ever.
			if (handBackReport(report)) {
				return recoverDecision(turn, lease, false, selfId, n) ? 'claimed' : 'failed';
			}
			// A RUN CUT SHORT ON THE RUNNER (the deadline, a poisoned engine) is Interrupted,
			// with Retry (ruling D-20261010-22); a refusal stays failed.
			if (report.status === 'aborted' && report.cut) return 'interrupted';
			return 'failed';									// aborted / error / refused-spend: terminal
		}
		// A LEASE THAT SAYS THE TURN FINISHED, with no report here (r52d QA F2). The report
		// lives only in the memory of the tab that collected it, so a second tab of the
		// sending device, or this one after a reload, read the released lease as
		// "dispatched" beside the finished answer. The lease is read by every tab and every
		// device: `done`, or released from done (`settled`, stamped by `leaseSetCas`).
		// One marked `cut` ended unfinished: it is settled, never re-run, and reads Interrupted.
		if (settledLease(lease)) return lease.cut ? 'interrupted' : 'done';
		// A BLOCKER ON THE LEASE outranks everything the lease mode could say (it
		// reads 'running' throughout the wait) and outranks the relayed ask, because
		// it is the authoritative copy: the runner wrote it through the same CAS that
		// arbitrates the claim, so every device reads one description of one turn.
		// Owner ruling 2026-09-12: the originating user must never see a hanging turn.
		if (liveLease(lease, n) && lease.blocker && blockerKind(lease.blocker.kind)) return 'blocked';
		// A live question the runner is blocked on takes precedence over the lease
		// state (which reads 'running' throughout the wait): the dispatch UI must stop
		// saying "sent" and say what is actually holding it up. Retained beneath the
		// blocker for a runner on a build that posts the ask but writes no blocker.
		if (ask && ask.t === T_ASK) return 'awaiting-consent';
		// THE TURN FELL BACK HERE (UNBLOCK-1 DISPATCH-FAIL): from the moment this device
		// takes it on, its own claim may take a store round trip (39 s in the rig's stall)
		// or replace a lapsed one. A live lease, its own included, still says the rest.
		if (localRun === true && !liveLease(lease, n)) return 'claimed';
		// No report yet: read the lease.
		if (liveLease(lease, n)) {
			return lease.mode === 'running' ? 'running' : 'claimed';
		}
		// A lease that was taken then expired without a report is a peer that
		// stopped mid-run (§6): failed, offer a local re-run.
		if (lease && lease.mode !== 'released') return 'failed';
		// No live lease and none reported: waiting, or nobody picked it up in time. A
		// placeholder carries no `deadline` of its own, so the errand's is read off its
		// stamp; without that fallback a hand-off nobody took said "Sent to your other
		// devices" for ever and never offered [Run here]. One with no stamp cannot be
		// aged at all, and reads as expired, as it does to `watchDecision`.
		// A RUNNER CLAIMED IT AND WENT SILENT (UNBLOCK-7 F3): its lease drained and no report
		// came. A peer was awake, so it is failed (Interrupted + Retry), not "no peer awake".
		// Only past the deadline: inside it a fresh tab reads no lease before its first door read.
		if (turn.claimedBy && handoffExpired(turn, n)) return 'failed';
		if (handoffExpired(turn, n)) return 'no-peer-awake';
		return 'dispatched';
	}

	/// Does a lease record say its turn ran to completion: `done`, or released from done?
	function settledLease(r) {
		return !!r && (r.mode === 'done' || (r.mode === 'released' && !!r.settled));
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
	///
	/// AND ONLY A LIVE HAND-OFF OF THIS DEVICE'S OWN (2026-09-23). This decision was the
	/// sole gate on re-executing a turn nobody had just asked for, and it asked neither
	/// whose turn it was nor how old. The index it is fed from is rebuilt from EVERY
	/// synced summary, so any device holding a placeholder synced from another could
	/// run it, however stale: on 2026-09-22 at 13:37Z gilgamesh claimed and ran five
	/// turns minted on 2026-09-17 (`mu4y7fa4-1-du152` first, in Diamond 19faba2f2212,
	/// with the file deletes at 13:38:33Z) while its owner worked in another Diamond.
	/// Two conditions now: the placeholder names THIS device as the one that sent it,
	/// and the hand-off is still inside its window (`handoffExpired`: the errand's
	/// deadline, never more than `DISPATCH_DEADLINE_MS` past the turn's birth). Past
	/// that the person decides, from the tile: [Run here], or [Answer again] for the
	/// answers below.
	///
	/// AN ANSWER TO A QUESTION IS NEVER RECOVERED. A turn whose prompt is an ask-card
	/// answer (`Chose: …`, `Other: …`) means something only beside the card it answered;
	/// run later as a bare prompt it is an instruction nobody gave. The 09-22 delete was
	/// "Chose: Detach the paths", five days after the card. It is left for the person,
	/// and its tile never offers [Run here]: [Answer again] opens the question again and
	/// sends nothing (`dispatchControl`).
	function recoverDecision(turn, lease, finished, selfId, now) {
		if (!turn || turn.why !== REASON_DISPATCHED) return false;
		if (finished || settledLease(lease)) return false;		// a settled lease: finished, or cut and settled
		var n = now == null ? Date.now() : now;
		if (!turn.dispatchedBy || String(turn.dispatchedBy) !== String(selfId)) return false;
		if (isAskAnswer(turn.itext)) return false;
		if (handoffExpired(turn, n)) return false;
		if (liveLease(lease, n) && lease.holder !== String(selfId)) return false;	// a peer is on it
		return true;
	}

	/// WITHDRAW ON LOSS [M9]: has the runner a turn was sent to stopped listening before
	/// anyone claimed it? Then the sender withdraws it at once, by taking the turn's lease
	/// at the lease door as any local recovery does (`recoverDecision`, then the take in
	/// `runErrand`), rather than waiting out the backstop for a runner that cannot collect.
	/// The take is the arbiter: if the runner's claim landed first, it wins, the take
	/// stands down and the turn runs there. Only from a deriving gateway's row (`rec`, the
	/// runner's): an old gateway's beat cannot say a runner stopped listening, and the
	/// backstop stays for that and for a runner that listens but never claims.
	function withdrawOnLoss(turn, lease, rec, selfId, now) {
		if (!turn || turn.why !== REASON_DISPATCHED || !turn.toDevice) return false;
		if (!turn.dispatchedBy || String(turn.dispatchedBy) !== String(selfId)) return false;
		if (!recDerived(rec) || rec.listening !== false) return false;
		var n = now == null ? Date.now() : now;
		if (liveLease(lease, n) || settledLease(lease)) return false;	// claimed, or finished
		return recoverDecision(turn, lease, false, selfId, n);
	}

	/// The two words an ask-card answer travels under, a wire format between the page
	/// and the model (daimond.js `ASK_CHOSE`, `ASK_OTHER`), never translated.
	var ASK_ANSWER_MARKS = ['Chose: ', 'Other: '];

	/// Is this prompt an answer to an ask card rather than something typed?
	function isAskAnswer(text) {
		var t = String(text == null ? '' : text);
		for (var i = 0; i < ASK_ANSWER_MARKS.length; i++) {
			if (t.indexOf(ASK_ANSWER_MARKS[i]) === 0) return true;
		}
		return false;
	}

	/// The moment after which no device may start a handed-off turn: the placeholder's
	/// own `deadline` where it carries one, else `DISPATCH_DEADLINE_MS` from its stamp,
	/// which is when the errand it was sent with expires. 0 when it has none of these.
	///
	/// Never later than `DISPATCH_DEADLINE_MS` past the stamp, whatever `deadline` says:
	/// no errand is sent with a longer one (`buildDispatch`), so a longer value is a
	/// fault, and it must not buy a turn a longer life than the errand it rode on.
	///
	/// NOR LATER THAN THE WINDOW PAST THE TURN'S BIRTH (E-R1). A re-seat refreshes the
	/// placeholder's `ts`, so the stamp alone let every re-seat buy another fifteen
	/// minutes; the turn id and the placeholder's own `mid` are stamped once and kept,
	/// so the whole chain of re-seats ends where a collector's `turnAgeVerdict` does.
	function handoffDeadline(turn) {
		var ts = leaseMs(turn && turn.ts);
		var dl = leaseMs(turn && turn.deadline);
		var born = turnBirth([turn && turn.iturn, turn && turn.mid], []);
		var caps = [dl, ts ? ts + DISPATCH_DEADLINE_MS : 0, born ? born + DISPATCH_DEADLINE_MS : 0];
		var out = 0;
		for (var i = 0; i < caps.length; i++) if (caps[i] && (!out || caps[i] < out)) out = caps[i];
		return out;
	}

	/// Is a handed-off turn past the point where any device may start it? Pure. Also
	/// true when it cannot be aged (no stamp, no deadline, no birth), and when its stamp
	/// or its birth lies more than `DISPATCH_DEADLINE_MS` in the future: the sending
	/// device's clock ran fast, or stepped back since, and trusting that stamp would keep
	/// the turn recoverable for the length of the skew.
	function handoffExpired(turn, now) {
		var n = now == null ? Date.now() : now;
		var dl = handoffDeadline(turn);
		if (!dl || n > dl) return true;
		var ts = leaseMs(turn && turn.ts);
		if (ts && ts > n + DISPATCH_DEADLINE_MS) return true;
		var born = turnBirth([turn && turn.iturn, turn && turn.mid], []);
		return !!born && born > n + DISPATCH_DEADLINE_MS;
	}

	// ── The age of a handed-off turn (E-R1, 2026-09-23) ────────
	//
	// On 2026-09-22 a tab still on an older build came back to the foreground and
	// handed on a turn it had sent five days before. The re-hand carried a fresh `ts`
	// and a fresh `deadline`; the desktop that collected it judged it by them, and ran
	// it with nobody there. A deadline the sender writes is only as old as the send it
	// rode on, so a turn is aged from its BIRTH, which no re-hand can refresh.

	// Nothing Daimond wrote is older than this, so an id whose prefix reads earlier is
	// not a time at all: `legacy-0000` parses as base 36 too.
	var BIRTH_FLOOR_MS = Date.UTC(2020, 0, 1);

	/// A millisecond stamp, or 0 where it is not a plausible one.
	function plausibleMs(t) {
		var n = leaseMs(t);
		return (isFinite(n) && n >= BIRTH_FLOOR_MS) ? n : 0;
	}

	/// The moment an id was minted, read off its base-36 prefix (`newMid`, daimond.js),
	/// or 0 for an id that carries none.
	function midMs(id) {
		var m = /^([0-9a-z]{8,9})-/.exec(String(id == null ? '' : id));
		return m ? plausibleMs(parseInt(m[1], 36)) : 0;
	}

	/// When a turn was born, on the clock of the device that sent it: the earliest
	/// plausible of the ids' prefixes and of the stamps, or 0 where none is plausible.
	/// The earliest, because a re-hand can refresh a stamp but never make one older.
	function turnBirth(ids, stamps) {
		var best = 0, i, t;
		for (i = 0; i < (ids || []).length; i++) {
			t = midMs(ids[i]);
			if (t && (!best || t < best)) best = t;
		}
		for (i = 0; i < (stamps || []).length; i++) {
			t = plausibleMs(stamps[i]);
			if (t && (!best || t < best)) best = t;
		}
		return best;
	}

	/// The birth stamps a device holds for a turn in its OWN copy of the chat: the
	/// turn's user message (`mid === turnId`), and the dispatched placeholder, whose
	/// `mid` a re-seat keeps (`markTurnDispatched` updates it in place). Pure.
	function turnBirthHints(messages, turnId) {
		var id = String(turnId || ''), out = [];
		var msgs = Array.isArray(messages) ? messages : [];
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (!m) continue;
			if (m.role === 'user' && String(m.mid || '') === id && plausibleMs(m.ts)) out.push(plausibleMs(m.ts));
			if (m.why === REASON_DISPATCHED && String(m.iturn || '') === id && midMs(m.mid)) out.push(midMs(m.mid));
		}
		return out;
	}

	/// The birth of an errand's turn: its id, the seed's copy of the turn's user
	/// message, and whatever the collecting device holds itself (`hints`).
	function errandBirth(e, hints) {
		var stamps = Array.isArray(hints) ? hints.slice() : [];
		var msgs = (e && e.seed && Array.isArray(e.seed.msgs)) ? e.seed.msgs : [];
		for (var i = 0; i < msgs.length; i++) {
			var sm = msgs[i];
			if (sm && sm.role === 'user' && String(sm.mid || '') === String(e.turnId)) stamps.push(sm.ts);
		}
		return turnBirth([e && e.turnId], stamps);
	}

	/// Is a turn still inside the window a device may start it in, judged on this
	/// device's clock? Pure. What a sender asks before it hands a turn on at all -- a
	/// parked re-run, a step-away -- so it never posts an errand every collector would
	/// refuse. False for a turn with no plausible birth.
	function turnInWindow(ids, stamps, now) {
		var n = now == null ? Date.now() : now;
		var born = turnBirth(ids, stamps);
		return !!born && born <= n + DISPATCH_DEADLINE_MS && n - born < DISPATCH_DEADLINE_MS;
	}

	/// May this device start a handed-off turn now? Pure, and the one age rule every
	/// path to a run asks (`runErrand`): a turn starts only while it is younger than
	/// `DISPATCH_DEADLINE_MS`, measured from its birth and never from a deadline the
	/// sender wrote.
	///
	/// NO TWO DEVICES' CLOCKS ARE COMPARED. The age is two spans, each read on one
	/// clock: birth to the errand's stamp on the sender's (`ts - birth`), then the post
	/// to now on the relay's (`relayNow - rowTs`). A constant offset cancels inside each,
	/// so a sender five days fast still reads its five-day-old turn as five days old and
	/// one an hour slow still reads a fresh turn as fresh; the collector's own clock
	/// would get both wrong. Each span is floored at zero, so a clock that went
	/// backwards can never take age away.
	///
	/// `opts` is `{ rowTs, relayNow, births, now }`: the relay's arrival stamp for the
	/// row, in Unix seconds; the relay's clock now, in ms (`DaimondPresence.relayNow`);
	/// the birth stamps this device holds itself (`turnBirthHints`); and the local clock.
	/// With no row -- a device recovering its own turn -- the second span is read on the
	/// local clock, which is then the sender's own; with a row but no relay clock yet it
	/// is read on the local clock too, and `clock` says so.
	///
	/// Answers `{ ok, why, age, birth, until, clock }`, `until` being the local moment
	/// the turn ages out. `why` on a refusal: `unaged` (no plausible birth, or no stamp
	/// to age it by), `clock-back` (born more than the window after it was sent: the
	/// sender's clock stepped back between the two, as audit F4 reads a future stamp)
	/// or `stale`.
	function turnAgeVerdict(errand, opts) {
		var e = errand || {}, o = opts || {};
		var n = o.now == null ? Date.now() : leaseMs(o.now);
		var birth = errandBirth(e, o.births);
		var sent = plausibleMs(e.ts);
		if (!birth || !sent) return { ok: false, why: 'unaged', age: 0, birth: birth, until: 0, clock: '' };
		if (birth > sent + DISPATCH_DEADLINE_MS) {
			return { ok: false, why: 'clock-back', age: 0, birth: birth, until: 0, clock: '' };
		}
		var span = Math.max(0, sent - birth);
		// The relay stamps a row in Unix SECONDS (schema.rs `PostRow.ts`). A value already
		// in milliseconds is taken as it is, so a change of unit can never read a row that
		// sat for days as posted this instant.
		var rowTs = leaseMs(o.rowTs);
		var rowMs = rowTs >= 1e11 ? rowTs : rowTs * 1000;
		var rel = (o.relayNow != null) ? plausibleMs(o.relayNow) : 0;
		var since, clock;
		if (rowMs > 0) {
			clock = rel ? 'relay' : 'local';
			since = Math.max(0, (rel || n) - rowMs);
		} else {
			clock = 'sender';
			since = Math.max(0, n - sent);
		}
		var age = span + since;
		// THE TURN'S FIRST POST ON THE RELAY (gateway release 5): the arrival stamp of
		// the first post that named this turn, read on the relay's clock alone. Every
		// birth above is some device's clock, so a sender whose clock stepped back by
		// the turn's age between birth and re-hand passed them all; this cannot be
		// moved by any device. The older of the two ages stands.
		var first = leaseMs(o.rowFirst);
		var firstMs = first >= 1e11 ? first : first * 1000;
		if (firstMs > 0 && rowMs > 0) {
			var byRelay = Math.max(0, (rel || n) - firstMs);
			if (byRelay > age) { age = byRelay; clock = rel ? 'relay-first' : 'local-first'; }
		}
		if (age >= DISPATCH_DEADLINE_MS) return { ok: false, why: 'stale', age: age, birth: birth, until: 0, clock: clock };
		return { ok: true, why: '', age: age, birth: birth, until: n + (DISPATCH_DEADLINE_MS - age), clock: clock };
	}

	/// The sentence a busy runner's hand-back carries home.
	var BUSY_WHY = 'Your other device was busy with another chat, so this one runs here.';

	/// The sentence a refused turn's `aborted` report carries home.
	var STALE_TURN_WHY = 'This turn was sent more than ' + Math.round(DISPATCH_DEADLINE_MS / 60000)
		+ ' minutes ago, so no device will start it unattended. Run it here if it is still wanted.';

	/// Could a handed-off turn still send this device progress frames, so that it is
	/// worth watching? Pure, and the bound on the watch set in daimond.js.
	///
	/// Written 2026-09-23 because nothing bounded it. A dispatched placeholder that no
	/// peer ever answered was re-watched after every reload, with no age limit and no
	/// check that any device held the turn, and each watch held a read open at the
	/// gateway -- gilgamesh held two for twelve hours and its pulls slowed fifty-fold.
	///
	/// Frames come only from a device RUNNING the turn, so the answer is read off the
	/// lease, which is the one record of who that is:
	///  - finished (a done report, or the answer merged): nothing more is coming;
	///  - a live lease held by ANOTHER device: that device is running it -- watch;
	///  - a live lease held by THIS device: it runs here, and draws itself;
	///  - a lease taken for this seat and no longer live: the runner stopped or handed
	///    it back, and no device holds the turn;
	///  - no claim yet: watch only while a peer may still claim it, which is the
	///    errand's own deadline (`DISPATCH_DEADLINE_MS` from the dispatch). No peer
	///    starts a turn past it (`leaseTakeFrom` refuses), so a placeholder older than
	///    that with no live lease can never produce another frame.
	/// A placeholder with no stamp at all cannot be aged, and is not watched.
	function watchDecision(turn, lease, finished, selfId, now) {
		if (!turn || turn.why !== REASON_DISPATCHED) return false;
		if (finished) return false;
		var n = now == null ? Date.now() : now;
		if (liveLease(lease, n)) return lease.holder !== String(selfId);
		// A claim made AFTER this seat was set (`renewedAt` is stamped at the take) that
		// has since lapsed or been released: the runner is gone. A record older than the
		// seat belongs to an earlier seating that a re-dispatch has superseded.
		var ts = leaseMs(turn.ts);
		if (lease && ts && leaseMs(lease.renewedAt) >= ts) return false;
		return !handoffExpired(turn, n);
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
	var _presMeta = null;				// { derived, ver, mine } of the last presence answer
	// THE MAP IS UNKNOWN (HT2, gateway restart): a re-read that did not answer 200 says the
	// map held is no longer the gateway's, so it is not shown as if it were. Until a map
	// lands, the switch reads Here, the rule a send follows when its read does not land.
	var _presUnknown = false;
	// How far the relay's clock leads this one, from the last presence answer that
	// carried the server's `now`; null until one has. The relay's clock is the one an
	// errand's arrival is stamped on, so it is what a collector ages the post by.
	var _relaySkew = null;

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
			if (!recAwake(rec, n, w)) continue;							// stale, or no door held
			if (!best || leaseMs(rec.lastSeen) > leaseMs(best.lastSeen)) {
				best = { deviceId: id, name: (rec.name || ''), lastSeen: leaseMs(rec.lastSeen) };
			}
		}
		return best;
	}

	/// Does a presence record carry the gateway's derived truth (HT1: `listening`,
	/// `doors`, `stated`)? Absent from an old gateway's row, whose readers keep today's
	/// age rules (design 2.5, the rollback [M4]).
	function recDerived(rec) {
		return !!rec && typeof rec.listening === 'boolean';
	}

	/// Has some tab of this device stated a posture (HT1 `stated`)? A row a park made
	/// before any statement says `stated: false` and is never seated, elected or routed a
	/// consent [M3]; a row from an old gateway cannot say, and counts as stated.
	function recStated(rec) {
		return !!rec && rec.stated !== false;
	}

	/// Is a presence record GENUINELY AVAILABLE to run an errand -- not merely beating,
	/// but actively servicing the errand channel? A background browser tab keeps sending
	/// the lightweight, non-waking presence beat (its 45 s timer, throttled to ~60 s but
	/// still inside the freshness window) while it is throttled OUT of the errand
	/// long-poll (`DaimondPost.parkOnce`) -- so it reads "awake" yet never collects the
	/// errand: the PHANTOM RUNNER the owner hit (a turn "handed to gilgamesh" that
	/// gilgamesh never ran). Genuine availability is the beat AND a recent completed
	/// errand-channel round (`servicedAt`), which the runner stamps only while it is
	/// really parked and collecting.
	///
	/// `servicedAt` reaches this record only when the gateway relays it (mirroring
	/// `attended_at`). Until that ships, the field is ABSENT, and this falls back to the
	/// bare beat so hand-off is not disabled wholesale -- the dispatcher-side recovery
	/// timer (daimond.js) is then the backstop that reclaims a turn a phantom never ran.
	/// A record that DOES carry `servicedAt` is judged strictly: a stale servicing stamp
	/// (a tab that beat but stopped collecting) is NOT genuine.
	///
	/// FROM A GATEWAY THAT DERIVES PRESENCE (HT1, design 2.5 [H1]) the row carries the
	/// gateway's own `listening`, and that is the whole answer: no stamp is aged, so a
	/// parked runner whose posture has not changed for an hour is still offered, and one
	/// whose park died is not, however recent its last statement. A row no tab has stated
	/// a posture for (`stated: false`, a park before any statement) is never genuine
	/// [M3]: what it would run with is unknown.
	function recGenuine(rec, now, windowMs) {
		if (!rec) return false;
		if (recDerived(rec)) return rec.listening === true && rec.stated !== false;
		var w = windowMs || DISPATCH_FRESH_MS;
		if ((now - leaseMs(rec.lastSeen)) > w) return false;		// not even beating
		if (rec.servicedAt != null) {								// reported: judge it strictly
			return (now - leaseMs(rec.servicedAt)) <= w;
		}
		return true;												// not reported (old gateway): the beat stands, Fix B backstops
	}

	/// The freshest GENUINELY-AVAILABLE peer (beating AND servicing errands), not this
	/// device, or null. The candidate the auto-dispatch decision hands a turn to, so a
	/// phantom presence-only tab is never chosen over a genuine peer or over local.
	function freshestGenuinePeer(presence, selfId, now, windowMs, currentBuild) {
		var p = presence || {}, self = String(selfId || ''), n = now == null ? Date.now() : now;
		var w = windowMs || DISPATCH_FRESH_MS;
		// The build the fleet SHOULD be on (this device's best-known served build). When
		// given, a peer KNOWN to be on it is preferred over a fresher-but-superseded
		// peer -- but a stale peer is never EXCLUDED, only de-preferred: excluding it
		// would strand a fleet mid-rollout, when nobody is current yet. An unknown peer
		// build ('' -- an old gateway that does not relay it, or a device not yet re-
		// synced) is treated as neutral, never as stale. See the hand-off skew guard.
		var cur = String(currentBuild || '');
		var best = null, bestCurrent = null;
		for (var id in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id)) continue;
			if (id === self) continue;
			var rec = p[id];
			if (!recGenuine(rec, n, w)) continue;
			var bd   = String((rec && rec.build) || '');
			var cand = { deviceId: id, name: (rec.name || ''), lastSeen: leaseMs(rec.lastSeen), build: bd };
			if (!best || cand.lastSeen > best.lastSeen) best = cand;
			if (cur && bd && bd === cur && (!bestCurrent || cand.lastSeen > bestCurrent.lastSeen)) {
				bestCurrent = cand;
			}
		}
		var chosen = bestCurrent || best;
		// Flag (never exclude) a chosen peer whose build is KNOWN and superseded, so the
		// caller can log it and the in-flight tile can say the turn went to an old build.
		if (chosen && chosen !== bestCurrent && cur && chosen.build && chosen.build !== cur) {
			chosen.staleBuild = true;
		}
		return chosen;
	}

	/// Record this device's heartbeat. Answers whether the map changed (it always
	/// does -- lastSeen moved -- which is what makes the beat a push). `attended` is
	/// the attention signal (foreground + recent interaction) a live consent routes on:
	/// `attendedAt` stamps when the device was last attended, so freshness is judged on
	/// attention rather than on the bare beat.
	///
	/// `runner` is the nominated machine's own posture (runner.js): it has been set up
	/// to stay awake and listening. A LIVE per-beat fact, not a stamp, because the
	/// question it answers -- is that machine actually arranged to be a runner -- is
	/// only ever asked of a device that is beating now.
	///
	/// `mobile` is the machine's own answer to whether it is a phone or a tablet. STICKY,
	/// unlike the posture: it is a boot-time fact about the machine, so a beat that cannot
	/// say keeps what the device already said rather than unsaying it.
	function presenceBeat(deviceId, name, now, attended, servicing, build, runner, mobile,
		hand, folder, busy, busyChats) {
		var id = String(deviceId || '');
		if (!id) return false;
		var n = now == null ? Date.now() : now;
		var prev = _presence[id];
		var at = attended ? n : (prev ? leaseMs(prev.attendedAt) : 0);
		// `servicing` = this device is genuinely running the errand long-poll now; stamp
		// `servicedAt` so a peer can tell a real runner from a throttled tab that only
		// beats. A beat with `servicing` unknown keeps the prior stamp (a transient miss
		// is not proof it stopped); explicitly false when the listener is down.
		var sv = servicing ? n : (prev ? leaseMs(prev.servicedAt) : 0);
		// The running build id this device carries, so the fleet's build spread is
		// visible and a peer on a superseded build can be de-preferred at hand-off. An
		// absent build ('' or null) keeps the prior known one rather than clobbering it,
		// exactly as `servicedAt` preserves an unreported stamp.
		var bd = (build != null && build !== '') ? String(build) : (prev ? (prev.build || '') : '');
		_presence[id] = { name: String(name || ''), lastSeen: n, attended: !!attended,
			attendedAt: at, servicedAt: sv, build: bd, runner: !!runner };
		// Is this MACHINE a phone or tablet? Its own answer, from real signals rather than
		// from its label or its window width, so the election seats a seat and not a name.
		// LEFT ABSENT when the caller cannot say, exactly as `servicedAt` is: absent must
		// mean "fall back to the old inference", never "desktop".
		if (mobile != null) _presence[id].mobile = !!mobile;
		else if (prev && typeof prev.mobile === 'boolean') _presence[id].mobile = prev.mobile;
		// THE TWO PLACEMENT FIELDS. `hand` is whether this machine can reach a machine
		// hand at all; `folder` whether it holds the real, mounted workspace rather than
		// a browser replica. LIVE, not sticky like `mobile`: a hand unplugged and a
		// folder grant withdrawn must both stop reading as present on the very next beat,
		// so an explicit false is carried through and only ABSENCE keeps the last answer
		// (a beat that could not ask is not the device saying no).
		if (hand != null)   _presence[id].hand = !!hand;
		else if (prev && typeof prev.hand === 'boolean') _presence[id].hand = prev.hand;
		if (folder != null) _presence[id].folder = !!folder;
		else if (prev && typeof prev.folder === 'boolean') _presence[id].folder = prev.folder;
		// HOW MANY TURNS THIS MACHINE IS RUNNING OR HOLDING, 0 when idle (H1). LIVE like the
		// placement pair, and absent when the beat cannot say: the election reads absence
		// as "not known to be busy", and the runner's own busy answer to an errand covers it.
		// The chats that load is in ride with it, so they never disagree.
		if (busy != null) {
			_presence[id].busy = busyDepth(busy);
			var bc = chatIds(busyChats);
			if (bc) _presence[id].busyChats = bc;
		} else if (prev && typeof prev.busy === 'number') {
			_presence[id].busy = prev.busy;
			if (prev.busyChats) _presence[id].busyChats = prev.busyChats;
		}
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
				var adopted = {
					name: String(inc.name || ''), lastSeen: leaseMs(inc.lastSeen),
					attended: !!inc.attended, attendedAt: leaseMs(inc.attendedAt),
				};
				// Preserve ABSENT (do not coerce to 0), exactly as presenceIngest does: a
				// peer arriving with no servicing field must read as "not reported" ->
				// recGenuine falls back to the beat, NOT as serviced_at 0 -> strictly stale
				// -> wrongly excluded. Only set the field when the incoming actually carries it.
				if (inc.servicedAt != null) adopted.servicedAt = leaseMs(inc.servicedAt);
				// The running build id rides with the freshest line, so a peer that
				// updated (and beats a fresher line) carries its new build; an absent
				// one keeps what we last knew rather than blanking it.
				adopted.build = (inc.build != null && inc.build !== '') ? String(inc.build)
					: (cur ? (cur.build || '') : '');
				// The runner posture rides the freshest line. Absent reads as false, not as
				// "keep the old answer": a machine that has been disarmed beats without the
				// field, and a remembered true would keep routing hand-offs at it.
				adopted.runner = !!inc.runner;
				// The device's own mobility answer, preserved ABSENT like servicedAt: an
				// incoming line without it keeps what we last knew rather than asserting
				// "desktop" about a device that never said.
				if (typeof inc.mobile === 'boolean') adopted.mobile = inc.mobile;
				else if (cur && typeof cur.mobile === 'boolean') adopted.mobile = cur.mobile;
				// The placement pair, preserved ABSENT the same way -- the election skips a
				// peer that cannot say rather than striking it out, so absence has to survive
				// the merge as absence.
				if (typeof inc.hand === 'boolean') adopted.hand = inc.hand;
				else if (cur && typeof cur.hand === 'boolean') adopted.hand = cur.hand;
				if (typeof inc.folder === 'boolean') adopted.folder = inc.folder;
				else if (cur && typeof cur.folder === 'boolean') adopted.folder = cur.folder;
				// Busy rides the freshest line, LIVE: a line that cannot say keeps the last
				// answer only while it is the same device speaking.
				if (inc.busy != null) adopted.busy = busyDepth(inc.busy);
				else if (cur && typeof cur.busy === 'number') adopted.busy = cur.busy;
				_presence[id] = adopted;
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
	///
	/// `answer`, when given, is the whole presence-door answer: a deriving gateway's
	/// (HT1) `derived`, `ver` and `mine` are kept beside the map (`presenceMeta`). An
	/// answer without `derived` leaves them unset and the map is read as before.
	function presenceIngest(serverMap, serverNow, answer) {
		var recv = Date.now();
		// A map that lands makes the view known again, and that is a move even when the
		// map is the one held: the switch drawn Here for the unknown is redrawn.
		var wasUnknown = _presUnknown;
		_presUnknown = false;
		// A map folded into a content pull comes without its answer: the meta stands.
		if (answer !== undefined) {
			_presMeta = (answer && answer.derived === true)
				? { derived: true, ver: answer.ver != null ? Number(answer.ver) : null,
					mine: (answer.mine && typeof answer.mine === 'object') ? answer.mine : null }
				: { derived: false, ver: null, mine: null };
		}
		var skew = leaseMs(serverNow) - recv;	// how far the server clock leads ours
		// Kept, for the age of a handed-off turn (`relayNow`): only from an answer that
		// carried a real server clock, so an absent `now` never reads as a vast lead.
		if (plausibleMs(serverNow)) _relaySkew = skew;
		var next = {}, map = serverMap || {};
		for (var id in map) {
			if (!Object.prototype.hasOwnProperty.call(map, id)) continue;
			var rec = map[id];
			if (!rec) continue;
			// The wire field is `last_seen`; tolerate `lastSeen` in case a caller
			// hands an already-client-framed record straight in.
			var seen = leaseMs(rec.last_seen != null ? rec.last_seen : rec.lastSeen);
			// The attention signal a live consent routes on. The gateway relays it as
			// `attended` / `attended_at` (skew-adjusted like last_seen); when a build's
			// gateway does not yet carry it, it reads absent -> not attended, so a runner
			// PARKS rather than routing a question to a device that may be unwatched (the
			// fail-safe the design requires).
			var atRaw = rec.attended_at != null ? rec.attended_at : rec.attendedAt;
			var recOut = {
				name: String(rec.name || ''), lastSeen: seen - skew,
				attended: !!rec.attended, attendedAt: atRaw != null ? (leaseMs(atRaw) - skew) : 0,
			};
			// The genuine-servicing signal the eligibility gate reads (recGenuine). The
			// gateway relays it as `serviced_at`, skew-adjusted like last_seen. LEFT ABSENT
			// when the gateway does not send it, so recGenuine can tell "old gateway, fall
			// back to the beat" from "new gateway reporting a stale (or zero) servicing".
			var svRaw = rec.serviced_at != null ? rec.serviced_at : rec.servicedAt;
			if (svRaw != null) recOut.servicedAt = leaseMs(svRaw) - skew;
			// The running build id, relayed verbatim by the gateway (no clock in it, so
			// no skew adjust). Absent -> '' (unknown), which reads as "not stale"
			// everywhere: a gateway that does not yet relay build simply shows no skew
			// rather than a false one. The roster's last-known build fills the gap for
			// the display and the hand-off preference until the relay ships.
			recOut.build = (rec.build != null) ? String(rec.build) : '';
			// The runner posture, relayed verbatim (no clock in it). A gateway that does
			// not carry the field reads as false everywhere, which costs nothing: the
			// nomination still routes hand-offs, and this only ever ADDS the knowledge
			// that the nominated machine is arranged to be one.
			recOut.runner = !!rec.runner;
			// The device's OWN mobility answer, relayed verbatim (a boolean, no clock in
			// it). LEFT ABSENT when the gateway or the peer does not send it, so the
			// election can tell "cannot say -> fall back to the name/viewport inference"
			// from "says desktop". Coercing absent to false would seat a phone on an old
			// build; coercing it to true would strand a fleet mid-rollout.
			if (typeof rec.mobile === 'boolean') recOut.mobile = rec.mobile;
			// The placement pair, relayed verbatim (booleans, no clock in them). LEFT
			// ABSENT when the gateway or the peer does not send them, because the election
			// must be able to tell "cannot say" from "has not got it": the first is named
			// as a maybe, the second is struck out, and a fleet mid-rollout is full of the
			// first. Coercing absent to false is how seq 217 struck a live runner out.
			if (typeof rec.hand === 'boolean')   recOut.hand   = rec.hand;
			if (typeof rec.folder === 'boolean') recOut.folder = rec.folder;
			// The turns that machine is running or holding (H1), relayed verbatim. LEFT
			// ABSENT when the gateway or the peer does not send it: unknown is not idle,
			// but neither is it busy, and the runner answers a busy errand itself.
			if (rec.busy != null) recOut.busy = busyDepth(rec.busy);
			// The chats that load is in, so the switch offers a runner busy with THIS chat
			// (the turn queues there) and passes over one busy with others. ABSENT when not
			// sent: such a peer is busy by its count, as before.
			var rbc = chatIds(rec.busy_chats != null ? rec.busy_chats : rec.busyChats);
			if (rbc) recOut.busyChats = rbc;
			// A paired native runner's row, from its signed beat (R2f): the Devices list
			// sends its Remove to the runner's own door, not the sync roster's.
			// Its engine id (R5a) rides with it, absent when it has none, so it is not offered.
			if (rec.kind === 'runner') {
				recOut.kind = 'runner';
				if (typeof rec.engine === 'string' && rec.engine) recOut.engine = rec.engine;
				// ELECT: its own signed word that it runs the errand's model set, kept only
				// on a runner's row and only when it said so, so `honoursModelSet` never reads
				// a guess. A tab states the same fact on its roster line, not here.
				if (rec.modelset === true) recOut.modelset = true;
			}
			// THE DERIVED TRUTH (HT1, design 2.1-2.2): whether the device holds a door
			// (`listening`), when the gateway last heard a door event (`heard_at`, its
			// clock, skew-adjusted), how many parks it holds (`doors`), and whether any
			// tab of it has stated a posture (`stated`; an unstated row is never seated).
			// LEFT ABSENT from a gateway that does not derive, so a reader tells "cannot
			// say" from "not listening".
			if (typeof rec.listening === 'boolean') recOut.listening = rec.listening;
			if (rec.heard_at != null) recOut.heardAt = leaseMs(rec.heard_at) - skew;
			if (rec.doors != null) recOut.doors = Math.max(0, Number(rec.doors) | 0);
			if (typeof rec.stated === 'boolean') recOut.stated = rec.stated;
			next[String(id)] = recOut;
		}
		var before = JSON.stringify(_presence);
		_presence = next;
		return wasUnknown || JSON.stringify(_presence) !== before;
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
			if (!recAwake(p[id], n, w)) continue;
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

	function presenceForget() { _presence = {}; _relaySkew = null; _presMeta = null; _presUnknown = false; }

	/// A re-read did not land: the map held is unknown until one does. Answers whether
	/// that moved the view (it was known), so the switch redraws once.
	function presenceLost() {
		if (_presUnknown) return false;
		_presUnknown = true;
		return true;
	}

	/// Is the map held unknown (a re-read did not land since the last map)?
	function presenceUnknown() { return _presUnknown; }

	/// The last presence answer's own fields: `{derived, ver, mine}`, or null before one.
	function presenceMeta() { return _presMeta; }

	/// Take the relay's clock from any answer that carries one (a collect's `now`),
	/// without touching the presence view. The same offset a presence answer sets.
	function learnRelayNow(serverNow) {
		if (plausibleMs(serverNow)) _relaySkew = leaseMs(serverNow) - Date.now();
	}

	/// The relay's clock now, in ms, as the last presence answer measured it; null until
	/// one has. What `turnAgeVerdict` reads the time since an errand's post on.
	function relayNow() { return _relaySkew == null ? null : Date.now() + _relaySkew; }

	/// Say that the presence view MOVED, so a surface drawn from it redraws at once
	/// rather than on its own next timer. The seat line under the composer reads this:
	/// a desktop waking or going quiet changes where the next turn will run, and a line
	/// that told the user otherwise until the next beat would be a line they plan
	/// against wrongly. Swallowed where there is no window (the node tests).
	function announcePresence() {
		try { window.dispatchEvent(new CustomEvent('daimond:presence')); }
		catch (e) { /* no window, or no CustomEvent: the caller's own timer still redraws */ }
	}

	/// `fn` wrapped so a mutation that actually moved the view announces itself. The
	/// three writers (beat, adopt, ingest) each answer whether anything changed, which
	/// is exactly the condition worth a redraw.
	function announcing(fn) {
		return function () {
			var moved = fn.apply(null, arguments);
			if (moved) announcePresence();
			return moved;
		};
	}

	window.DaimondPresence = {
		BEAT_MS:  PRESENCE_BEAT_MS,
		FRESH_MS: PRESENCE_FRESH_MS,
		beat:     announcing(presenceBeat),
		/// sync.js's section contract -- freshest-scalar, NOT take-if-vacant.
		snapshot: presenceSnapshot,
		adopt:    announcing(presenceAdopt),
		/// Replace the local view from the gateway's authoritative map, converting
		/// each last_seen into this client's clock frame (skew-immune). This is the
		/// sync path now -- presence rides its own non-waking gateway route, not the
		/// content parcel -- so it supersedes the freshest-scalar `adopt` above.
		ingest:   announcing(presenceIngest),
		lost:     announcing(presenceLost),
		unknown:  presenceUnknown,
		/// The awake peers, and one device's name, for the UI and auto-dispatch.
		awake:    presenceAwake,
		name:     presenceName,
		forget:   presenceForget,
		meta:     presenceMeta,
		relayNow: relayNow,
		learnRelayNow: learnRelayNow,
	};

	// ── Remote consent — attention, routing, the park bound ────
	//
	// A turn dispatched from the phone runs on a runner where nobody is. When it hits
	// a genuinely per-turn consent the synced account policy does not cover, the
	// runner cannot raise a dialog into an empty room: it routes the question to a
	// device the user is ON, and awaits the answer while holding its turn in memory.
	// Only the question and the answer travel; the turn never leaves the runner.
	//
	// The helpers here are the PURE decisions -- who is attended, whether to ask or
	// park, and how far the park loop may run. daimond.js seals/posts/awaits over the
	// real channel; the money-safety of the bound is decided here so a test drives it.

	// The default life of one live consent question. ~1 minute, tunable: the runner
	// holds its lease straight to the errand deadline (~15 min) throughout, so the
	// short consent wait sits INSIDE the long claim and no lease renewal is needed.
	var CONSENT_DEADLINE_MS = 60 * 1000;

	// The hard cap on how many times ONE turn may park-and-re-dispatch. It is BOTH the
	// liveness cap and the SPEND cap: each re-dispatch replays the turn's pre-consent
	// account spend (the earlier LLM calls, a completed web_search), so N re-dispatches
	// cost at most N× that spend. Small on purpose. The count is GLOBAL (synced on the
	// errand / parked report / placeholder), so it is not multiplied by device count.
	var MAX_PARKS = 2;

	/// Is a presence record ATTENDED -- a person is at this device now, not merely a
	/// beating heartbeat? Attention is a foreground + recent-interaction signal the
	/// beat carries (`attended`), distinct from `lastSeen`: routing a live question to
	/// an awake-but-unwatched device would just relocate the invisible stall. Absent or
	/// false is NOT attended, so an attention-indeterminate device is never asked.
	///
	/// From a deriving gateway, the merged `attended` while a door is held (`recAwake`)
	/// and a posture is stated, with no stamp aged: a phone in a person's hand that has
	/// not changed for five minutes is still attended [H1, M3].
	function recAttended(rec, now, windowMs) {
		if (!rec || !rec.attended) return false;
		if (recDerived(rec)) return rec.stated !== false && recAwake(rec, now, windowMs);
		var w = windowMs || DISPATCH_FRESH_MS;
		var seen = leaseMs(rec.attendedAt != null ? rec.attendedAt : rec.lastSeen);
		return (now - seen) <= w;
	}

	/// Is a presence record AWAKE -- a fresh heartbeat within the window -- regardless
	/// of whether a person is positively at it? Weaker than `recAttended`: it does not
	/// require the attention signal. Used for the SOURCE device only, where "the device
	/// the chat was driven from" is the right place for its consent to land even if the
	/// person has stepped over to watch the runner -- the consent deadline parks it if
	/// nobody answers, so an awake-but-unwatched source is a bounded wait, not a hang.
	///
	/// From a deriving gateway: a door held, or listening through its grace. Not `doors`
	/// alone, which a park answering mid-churn drops for a moment with no notify to
	/// redraw (a door's flap moves no version, wire_ht1).
	function recAwake(rec, now, windowMs) {
		if (!rec) return false;
		if (recDerived(rec)) return (rec.doors | 0) > 0 || rec.listening === true;
		var w = windowMs || DISPATCH_FRESH_MS;
		return (now - leaseMs(rec.lastSeen)) <= w;
	}

	/// The freshest ATTENDED peer (not this device) in a presence map, or null. The one
	/// pure answer to "is there a device the user is on that a live question can go to".
	/// Attention fails SAFE: an indeterminate or stale-attention device is skipped, so
	/// the caller parks rather than routing a question nobody will see.
	function attendedPeer(presence, selfId, now, windowMs) {
		var p = presence || {}, self = String(selfId || '');
		var n = now == null ? Date.now() : now, best = null;
		for (var id in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id)) continue;
			if (id === self) continue;
			var rec = p[id];
			if (!recAttended(rec, n, windowMs)) continue;
			if (!best || leaseMs(rec.lastSeen) > leaseMs(best.lastSeen)) {
				best = { deviceId: id, name: (rec.name || ''), lastSeen: leaseMs(rec.lastSeen) };
			}
		}
		return best;
	}

	/// Decide what a runner does with a per-turn consent it cannot answer locally:
	/// ASK a specific attended peer, or PARK. Pure. `covered` is the policy-sync
	/// short-circuit -- a standing account grant the runner already holds resolves the
	/// act with no question at all, so the ask fires ONLY when the synced policy does
	/// not already cover it (this composes with the shipped consent-sync, never
	/// double-asking). Answers `{ action, peer?, verdict?, why? }`.
	function consentRouteDecision(presence, selfId, now, opts) {
		var o = opts || {};
		if (o.covered) return { action: 'allow', verdict: 'allow', why: 'policy' };
		var self = String(selfId || '');
		var n = now == null ? Date.now() : now;
		var p = presence || {};
		// PREFER THE SOURCE DEVICE -- the one the turn was dispatched from, which is
		// where the person drove the chat (owner rule 2026-09-05: "any permissions
		// related to a chat go to the source device"). Preferred whenever the source
		// is merely AWAKE, attended or not: it is the device the chat lives on, and if
		// nobody answers there the consent deadline parks the turn (bounded). Only when
		// the source is OFFLINE does routing fall back to an attended peer.
		var src = String(o.source || '');
		if (src && src !== self && recStated(p[src]) && recAwake(p[src], n, o.windowMs)) {
			var srec = p[src];
			return { action: 'ask', peer: {
				deviceId: src, name: (srec.name || ''), lastSeen: leaseMs(srec.lastSeen), source: true } };
		}
		// Source offline (or none): the freshest ATTENDED peer, else park.
		var peer = attendedPeer(p, self, n, o.windowMs);
		if (peer) return { action: 'ask', peer: peer };
		return { action: 'park', why: 'no-attended-device' };
	}

	/// The outcome of a park, given the parkCount the errand carried. Pure and the
	/// single arbiter of the spend bound. `next` is the new GLOBAL park total (this
	/// park included); `terminal` is true once it reaches the bound, at which point the
	/// turn fails clean rather than re-dispatching into another respend.
	function parkOutcome(errandParkCount, maxParks) {
		var mx = (maxParks == null) ? MAX_PARKS : (maxParks | 0);
		var next = (errandParkCount | 0) + 1;
		return { next: next, terminal: next >= mx };
	}

	// ── Broadcast consent — raise on every device, resolve from the first ──
	//
	// Owner rule 2026-09-09: a handed-off turn's permission ask must reach the device
	// the user is actually AT, not only the source. A runner (argonaut) is handed a
	// turn precisely so the user can be elsewhere (their phone); if the runner then
	// hits a permission prompt and that prompt is trapped on the runner, the turn
	// dead-ends and the hand-off was pointless. So the ask is BROADCAST to the whole
	// account -- every attended device raises the tile -- and whichever device answers
	// FIRST resolves it everywhere: its grant unblocks the runner and dismisses the
	// tile on every other device. The two helpers here are the PURE decisions -- who
	// raises a tile, and which grant commits -- so a test drives the money-safe bound;
	// daimond.js owns the DOM tiles, the seal/post and the awaited promise.

	/// Should THIS device raise the consent tile for a broadcast ask? Pure, and the
	/// single fail-safe filter every device runs on a collected `consent-ask`. Because
	/// the ask is broadcast, routing no longer names one device: EVERY attended device
	/// raises it and the first to answer resolves it everywhere. `opts`:
	///   resolved   -- a grant for this cid has already been seen, so a device coming
	///                 back online must NOT re-raise an already-answered ask;
	///   alreadyUp  -- a tile for this cid is already on this device's panel (dedup);
	///   canAnswer  -- this device can actually show a tile now (foreground, no modal).
	/// Fail-safe order: a resolved or expired ask is suppressed before anything draws,
	/// a duplicate is suppressed, and a device nobody is at raises nothing (its caller
	/// still records the ask for the dispatch status -- a dialog nobody sees would only
	/// relocate the stall this exists to fix).
	function askRaiseDecision(ask, selfId, now, opts) {
		var o = ask || {}, x = opts || {};
		var n = now == null ? Date.now() : now;
		if (x.resolved)                            return { raise: false, why: 'resolved' };
		if (askExpired(o, x.seenAt, n))            return { raise: false, why: 'expired' };
		if (x.alreadyUp)                           return { raise: false, why: 'dedup' };
		// A PERMIT is asked of one device, the one the turn was sent from, and never
		// broadcast: the runner keeps no dialog of its own for it, and another device's
		// build is unknown (`permitRouteDecision`).
		if (permitAsk(o.kind) && String(o.target || '') !== String(selfId || '')) {
			return { raise: false, why: 'not-target' };
		}
		if (!x.canAnswer)                          return { raise: false, why: 'unattended' };
		return { raise: true, why: 'broadcast' };
	}

	/// Has an ask outlived its asker's wait? Pure. An ask that says how long it waits is
	/// timed from when this device first saw it (`seenAt`, this device's own clock): the
	/// asker's `deadline` is a moment on ANOTHER device's clock, and a clock a minute and a
	/// half ahead here used to bury a question before it was drawn. An older asker's ask
	/// carries only the moment, and is read as before.
	function askExpired(ask, seenAt, now) {
		var o = ask || {}, w = +o.wait || 0, at = +seenAt || 0;
		if (w > 0 && at > 0) return now > at + w;
		return !!(o.deadline && now > (+o.deadline || 0));
	}

	/// What becomes of a press on a permit's Allow or Not now? Pure. `spent`: this
	/// question already took an answer on this device, from the tile or the footer,
	/// and takes no second. `late`: the asker has stopped waiting, so nothing is written
	/// and nothing sent. Otherwise `answer`.
	///
	/// # Arguments
	/// * `st` - `{ spent, seenAt }` as this device holds them for the ask's cid.
	function permitAnswerDecision(ask, st, now) {
		var x = st || {};
		if (x.spent) return 'spent';
		if (askExpired(ask, x.seenAt, now == null ? Date.now() : now)) return 'late';
		return 'answer';
	}

	/// Which of the asks a device is holding should be RE-RAISED now? Pure, and the
	/// answer to the second half of the owner's 2026-09-12 ruling: an ask that arrived
	/// while the device was hidden was recorded for the dispatch badge and never drawn,
	/// because `askRaiseDecision` (rightly) refuses to put a dialog where nobody is --
	/// and nothing asked the question again when the person came back. So the whole open
	/// set is re-decided on the one event at which the answer to "could somebody answer
	/// this" has just changed.
	///
	/// `open` is turnId -> ask envelope; `resolved` and `up` are the two ledgers
	/// `askRaiseDecision` reads (cid -> true / cid -> tile id). Answers the asks to
	/// raise, in arrival order, each of which has passed the SAME filter a freshly
	/// collected ask passes -- so a resolved, expired or already-drawn ask is never
	/// raised twice by this path.
	function reRaiseDecision(open, selfId, now, opts) {
		var o = open || {}, x = opts || {}, out = [];
		var n = now == null ? Date.now() : now;
		for (var tid in o) {
			if (!Object.prototype.hasOwnProperty.call(o, tid)) continue;
			var ask = o[tid];
			if (!ask || ask.t !== T_ASK) continue;
			var cid = String(ask.cid || '');
			var d = askRaiseDecision(ask, selfId, n, {
				resolved:  !!(x.resolved && x.resolved[cid]),
				alreadyUp: !!(x.up && x.up[cid]),
				seenAt:    (x.seen && x.seen[cid]) || 0,
				canAnswer: !!x.canAnswer,
			});
			if (d.raise) out.push(ask);
		}
		return out;
	}

	/// The FIRST-RESPONDER resolution rule for a collected `consent-grant`, pure so the
	/// money-safe bound is driven by a test. `pending` is the runner's awaiting record
	/// for the grant's cid (`{ turnId }`) or null. The caller SPENDS the record on a
	/// commit (deletes it, in the same synchronous step it reads it), so a racing second
	/// grant for the same cid finds null here and drops -- exactly ONE resolution is ever
	/// committed and the turn consumes it once, even if the answer reaches the runner by
	/// more than one path. The race rule is STRICTLY FIRST-COMMITTED-WINS: whichever
	/// grant reaches the runner first is the sole resolution; a later conflicting grant
	/// (allow-vs-deny included) is a NO-OP -- never an override, never a re-apply. A
	/// grant whose cid is spent/unknown, or whose turnId does not match the held act,
	/// authorises nothing -- the forged/replayed-grant defence, enforced here as well as
	/// at the signature. See dev/HANDOFF_CONSENT_DESIGN.md for why deny-wins would need a
	/// shared serialisation point (a gateway/store CAS) that this client transport lacks.
	function grantDecision(pending, grant) {
		var g = grant || {};
		if (!pending)                                     return { commit: false, drop: true, why: 'spent-or-unknown' };
		if (String(g.turnId) !== String(pending.turnId))  return { commit: false, drop: true, why: 'turn-mismatch' };
		return { commit: true, verdict: g.verdict === 'allow' ? 'allow' : 'deny', why: 'first-committed' };
	}

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

	/// A label, normalised for a match: trimmed and lower-cased, so "Argonaut" beat
	/// under one device matches the roster label the star was resolved from however
	/// their casing or padding happened to differ.
	function normLabel(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

	/// Among candidate records ALREADY filtered to seatable, non-mobile peers, pick the
	/// one to seat: the freshest, but PREFERRING one on `cur` (the current build) over a
	/// fresher-but-superseded one, and marking the chosen record `staleBuild` when its
	/// build is known and superseded. Mirrors freshestGenuinePeer's soft skew guard, so
	/// a mixed-build fleet de-prefers (never excludes) a stale peer.
	function freshestWithBuild(cands, cur) {
		var best = null, bestCurrent = null;
		for (var i = 0; i < cands.length; i++) {
			var c = cands[i];
			if (!best || c.lastSeen > best.lastSeen) best = c;
			if (cur && c.build && c.build === cur && (!bestCurrent || c.lastSeen > bestCurrent.lastSeen)) bestCurrent = c;
		}
		var chosen = bestCurrent || best;
		if (chosen && chosen !== bestCurrent && cur && chosen.build && chosen.build !== cur) chosen.staleBuild = true;
		return chosen;
	}

	// ── Present-derived hand-off target (owner redesign 2026-09-09) ──
	//
	// WHO RUNS A HANDED-OFF TURN is resolved from LIVE PRESENCE ONLY -- who is beating
	// now, with their label, mobile-view flag and servicing flag -- and NEVER from the
	// stored, add-only device list in the account blob. That list fills with ghost ids
	// from device identity re-mints and, on the owner's live trace, had ZERO overlap
	// with the live set: the "worker" star pointed at a phantom, the election returned
	// generic, and the turn ran LOCALLY on the phone though a fresh live desktop was
	// right there. The fallback chain here is the owner's binding rule, in this exact
	// order:
	//   (a) the preferred worker -- the star's LIVE nominated id if it is beating, else
	//       the star's LABEL matched against whoever carries it in live presence (so a
	//       dead re-mint id is IGNORED and the machine that is HERE NOW is seated);
	//   (b) ELSE any other live, non-mobile-view, genuinely-servicing desktop;
	//   (c) ELSE run local on the phone -- the LAST resort only.
	// A mobile-view device is NEVER seated as another device's worker. `exclude` lets the
	// no-premature-local retry re-resolve past a seated desktop that failed to claim, so
	// the next live desktop is tried before local.

	/// Resolve the hand-off target from live presence and the fallback chain. Pure.
	/// Is a presence record a MOBILE device -- one that must never be seated as another
	/// device's worker?
	///
	/// `mobile` is the device's OWN answer, decided at its boot from real signals (touch,
	/// pointer, UA mobility, standalone PWA -- mobile.js `isMobileDevice`) and carried on
	/// every beat. It is read FIRST and it is final, either way: a phone its owner named
	/// "gilgamesh" says `mobile:true` and is not seated, and a desktop window dragged
	/// under 760px says `mobile:false` and still is.
	///
	/// `mobileView` is the OLD inference -- the peer's NAME, or this device's viewport
	/// width (daimond.js `presenceIsMobileView`) -- and it stands in only while the field
	/// is ABSENT, which is a peer on a build that predates the flag. Absent on both reads
	/// as NON-mobile, so a live desktop is never wrongly withheld.
	function recMobileView(rec) {
		if (!rec) return false;
		if (typeof rec.mobile === 'boolean') return rec.mobile;
		return !!rec.mobileView;
	}

	/// Does a presence record DECLARE THE RUNNER POSTURE -- has that machine been set
	/// up (runner.js: a held wake lock and a kept-open errand long-poll) to take a
	/// handed-off turn?
	///
	/// It is the machine's OWN claim about itself, carried on every beat and relayed
	/// verbatim, and it is the only seating signal that needs nothing stored on the
	/// deciding device. That is why it exists: the star lives in the nominating
	/// device's localStorage and reaches a phone only on the next full parcel round,
	/// so a phone that has not yet taken one -- or that lost the record -- cannot
	/// name the runner at all, and fell to `local/no-desktop` beside an armed
	/// argonaut (owner, 2026-09-13). A posture on the wire cannot be missed that way.
	function recRunner(rec) {
		return !!(rec && rec.runner);
	}

	/// A beat's chat ids, strings only, or null when it sent no list (it cannot say).
	function chatIds(v) {
		if (!Array.isArray(v)) return null;
		var out = [];
		for (var i = 0; i < v.length; i++) if (typeof v[i] === 'string' && v[i]) out.push(v[i]);
		return out;
	}

	/// A beat's `busy` as a depth: the turns that machine is running or holding. An old
	/// boolean true reads as one.
	function busyDepth(v) {
		if (v === true) return 1;
		var k = +v;
		return (k > 0 && isFinite(k)) ? Math.floor(k) : 0;
	}

	/// How busy a device is for a turn of `chatId`, from what it says about itself
	/// (`{ busy, busyChats }`, its beat or its own state): 0 when `chatId` is among the chats
	/// it is busy with, since a second turn there queues behind the first (O3), else its
	/// whole depth. The ONE rule the runner's errand answer, its beat and every sender's
	/// switch apply, so the seat and the claim cannot disagree (UNBLOCK-1 BUSY-SELF). A
	/// record that cannot name its chats (an older build) is busy by its count.
	function busyForRec(rec, chatId) {
		var n = busyDepth(rec && rec.busy);
		if (!n) return 0;
		var id = String(chatId || '');
		var on = (rec && Array.isArray(rec.busyChats)) ? rec.busyChats : [];
		for (var i = 0; id && i < on.length; i++) if (String(on[i]) === id) return 0;
		return n;
	}

	/// Is this peer BUSY for the turn being seated (H1, C1)? A machine running a turn
	/// collects the next errand only when that turn ends, so seating it made the sender
	/// wait out its backstop and run the turn itself. The one exception is `queueOn`,
	/// the device already running this same chat (O3): the turn queues there, visibly,
	/// whether its lease says so (`queueOn`) or its beat names the chat (`busyForRec`).
	function recBusy(rec, id, o) {
		if (!rec || !(rec.busy > 0)) return false;
		if (o && o.queueOn && String(o.queueOn) === String(id)) return false;
		return busyForRec(rec, o && o.chatId) > 0;
	}

	/// Does this presence record MEET the caller's requirement -- a beat field that must
	/// be explicitly true for this peer to be seated at all?
	///
	/// `placeTask` uses it for `hand` and `folder`: only a machine that holds the machine
	/// hand may be seated for a `run`, and only one that holds the real folder is worth
	/// handing a compile to. ABSENT IS NOT FALSE, and that distinction is the seq-218
	/// rollout rule applied here: a peer on a build that predates the field cannot say,
	/// so it is skipped from the LIVE pass (nothing is dispatched on a guess) and named
	/// by `nobody()` as unknown rather than struck out as lacking it.
	function meetsRequire(rec, req) {
		return !req || (!!rec && rec[req] === true);
	}

	// THIS PAGE'S ENGINE ID (R5a, X12): the sha-256, in hex, of the wasm it runs. '' until
	// daimond.js has hashed it, and then no native runner is offered.
	var _engineId = '';
	function setEngineId(h) { _engineId = String(h || ''); }

	/// May this record take a turn from this page's engine? A paired native runner
	/// (`kind: 'runner'`) only when its engine id, stamped at its release build and carried
	/// in its signed beat, equals the page's: the same id or not at all, no shim (design
	/// §6.1/§12). A tab's record runs the engine it loaded and is not judged here.
	/// `o.engineId`, when given, stands for the page's id.
	///
	/// A native runner serves DAIMOND CREDITS ONLY (lead ruling, R3c4c): it answers on its
	/// one credits key and never maps a chat's own key onto it, so it is offered only when
	/// `o.provider`, the provider the chat's turn runs on (the page passes the pair in force,
	/// daimond.js electProvider, so a chat following a credits default counts), is `credits`. Absent is not offered: an election
	/// that cannot say what the chat runs on does not hand it to a machine that can only
	/// refuse it.
	function recEngineOk(rec, o) {
		if (!rec || rec.kind !== 'runner') return true;
		if (String((o && o.provider) || '') !== 'credits') return false;
		var mine = (o && o.engineId != null) ? String(o.engineId) : _engineId;
		return !!mine && String(rec.engine || '') === mine;
	}

	/// May the election seat this peer at all: REACHABLE (rulings §1, design 2.5) -- not
	/// a phone, meeting the caller's requirement (`require`: `hand`, or `folder` for a chat
	/// whose folder is rooted on the asker, F4c), able to run this page's engine and the
	/// chat's provider (`recEngineOk`, a native runner only), stated and listening (`recGenuine`, the
	/// gateway's `listening` where it derives it, else the beat within `w`). Busy is asked
	/// apart (`busyHere`), so a busy peer is named in `passed`. The one test every seat
	/// reader calls: the election's four passes and the seat line's runner-silent.
	function reachable(rec, o, n, w) {
		return !!rec && !recMobileView(rec) && meetsRequire(rec, o && o.require) && recEngineOk(rec, o)
			&& recGenuine(rec, n, w);
	}

	/// Answers `{ target, reason }` where `target` is `{ deviceId, name, lastSeen, build,
	/// staleBuild? }` or null (→ run local), and `reason` is one of
	/// `nominee` / `nominee-presumed` / `worker` / `other-desktop` / `local`. `passed`
	/// names every live peer skipped because its beat said busy, so the election row and
	/// the tile can say why the turn did not go there.
	function handoffTarget(presence, opts, now) {
		var passed = [];
		var res = electTarget(presence, opts, now, passed);
		res.passed = passed;
		return res;
	}

	function electTarget(presence, opts, now, passed) {
		var o = opts || {}, p = presence || {};
		var seen = {};
		function busyHere(id, rec) {
			if (!recBusy(rec, id, o)) return false;
			if (!seen[id]) { seen[id] = 1; passed.push({ deviceId: id, name: (rec.name || ''), busy: rec.busy | 0 }); }
			return true;
		}
		var self = String(o.selfId || '');
		var n = now == null ? Date.now() : now;
		var w = o.windowMs || DISPATCH_FRESH_MS;
		var nomWin = (o.presumeNomineeWindowMs && o.presumeNomineeWindowMs > w) ? o.presumeNomineeWindowMs : w;
		var cur = String(o.currentBuild || '');
		var pref = normLabel(o.preferredLabel);
		var nom = String(o.nominatedId || '');
		var exclude = o.exclude || {};

		// (a) THE PREFERRED WORKER by its raw nominated id, when that id is itself a LIVE,
		// non-mobile presence entry. LIVE is `recGenuine`: beating AND, where the record
		// reports it, listening for errands (UNBLOCK-1). A tab that beats but has stopped
		// parking cannot collect the errand, so seating it made the sender wait out its
		// backstop. The claim side judges the nominee by the same test
		// (nominationStandDown), and the errand names the device elected here (`to`), so
		// seat and claim cannot disagree the way repro_nominee_stolen did. One last known
		// within the presume window (an unconfirmed cold snapshot) is trusted live
		// (repro_nominee_unconfirmed). A ghost id absent from presence misses this, and the
		// label match below recovers it.
		if (nom && nom !== self && !exclude[nom]) {
			var nr = p[nom];
			if (reachable(nr, o, n, nomWin) && !busyHere(nom, nr)) {
				// Seated on trust, not a fresh beat. Never from a deriving gateway: its row is
				// seated only while the gateway says it listens, so nothing is presumed.
				var presumed = !recDerived(nr) && (n - leaseMs(nr.lastSeen)) > w;
				var nb = String(nr.build || '');
				var nomStale = !!(cur && nb && nb !== cur);
				return { target: { deviceId: nom, name: (nr.name || ''), lastSeen: leaseMs(nr.lastSeen), build: nb, staleBuild: nomStale },
					reason: presumed ? 'nominee-presumed' : 'nominee' };
			}
		}

		// (a') THE PREFERRED WORKER by LABEL, resolved against LIVE presence, and only when
		// the label picks out exactly ONE live desktop. The star is a preferred LABEL
		// (daimond.js resolves it from the nomination against the roster), matched here
		// against every BEATING non-mobile device, so a superseded id in any stored list is
		// ignored and the machine that carries the label and is HERE NOW is seated. Bare
		// beat within `w`.
		//
		// UNIQUE OR NOTHING. A derived name is the browser and the platform and nothing
		// else, so two of a user's Linux Chromes say the same thing; seating the fresher of
		// them on a name they share is a lottery dressed as a preference, and it decides
		// which machine RUNS AND BILLS the turn. Two matches fall through to (b), which
		// seats a genuinely-servicing desktop on its own terms. A derived name now carries
		// the device's own id tail (daimond.js deviceSelfName), so the collision is rare as
		// well as refused.
		if (pref) {
			var byLabel = [];
			for (var id in p) {
				if (!Object.prototype.hasOwnProperty.call(p, id)) continue;
				if (id === self || exclude[id]) continue;
				var r = p[id];
				if (!reachable(r, o, n, w)) continue;		// beating and listening, as (a)
				if (normLabel(r.name) !== pref) continue;
				if (busyHere(id, r)) continue;
				byLabel.push({ deviceId: id, name: (r.name || ''), lastSeen: leaseMs(r.lastSeen), build: String(r.build || '') });
			}
			// Through freshestWithBuild even for one, so a lone match on a superseded build
			// still carries `staleBuild` to the caller.
			if (byLabel.length === 1) return { target: freshestWithBuild(byLabel, cur), reason: 'worker' };
		}

		// (a'') A PEER THAT DECLARES THE RUNNER POSTURE, seated on the BARE BEAT and with
		// NOTHING stored here. `runner` rode the wire from the day it shipped and was read
		// by nobody: the election seated a nominee id or a `recGenuine` desktop, so the one
		// machine that had said in as many words "I am arranged to take a turn" was the one
		// machine the decision ignored. Live: argonaut armed and beating, the phone holding
		// no nominee record and argonaut's `serviced_at` stale -- (a) missed for want of the
		// record, (b) excluded it as a phantom, and the phone ran the turn itself.
		//
		// The posture no longer outranks the servicing stamp (UNBLOCK-1): a machine arranged
		// to collect that has not collected within the window cannot take the errand, and
		// seating it made the sender wait out its backstop. `serviced_at` is stamped on each
		// beat while a park round completed in the last 90 s, so a momentary gap (a backoff
		// round, a throttled tick) does not age it out. An old gateway that relays no
		// `serviced_at` still seats on the beat (recGenuine). It sits BELOW the star, so an
		// explicit nomination still wins.
		var runners = [];
		for (var id3 in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id3)) continue;
			if (id3 === self || exclude[id3]) continue;
			var r3 = p[id3];
			if (!recRunner(r3) || !reachable(r3, o, n, w)) continue;		// beating and listening, as (a)
			if (busyHere(id3, r3)) continue;
			runners.push({ deviceId: id3, name: (r3.name || ''), lastSeen: leaseMs(r3.lastSeen), build: String(r3.build || '') });
		}
		if (runners.length) return { target: freshestWithBuild(runners, cur), reason: 'runner-posture' };

		// (b) ANY OTHER LIVE, non-mobile, GENUINELY-SERVICING desktop. recGenuine (beating
		// AND servicing, with the bare-beat fallback on an old gateway that does not relay
		// serviced_at) excludes a phantom background tab, so a non-designated peer that beats
		// but never collects is never seated over local (seq 217). Mobile-view devices are
		// never seated as another device's worker.
		var desks = [];
		for (var id2 in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id2)) continue;
			if (id2 === self || exclude[id2]) continue;
			var r2 = p[id2];
			if (!reachable(r2, o, n, w)) continue;
			if (busyHere(id2, r2)) continue;
			desks.push({ deviceId: id2, name: (r2.name || ''), lastSeen: leaseMs(r2.lastSeen), build: String(r2.build || '') });
		}
		if (desks.length) return { target: freshestWithBuild(desks, cur), reason: 'other-desktop' };

		// (c) NO live non-mobile desktop is available: run local (the last resort).
		return { target: null, reason: 'local' };
	}

	/// Decide whether to dispatch, and to whom. Pure. Answers
	/// `{ dispatch, peer, reason, staleBuild? }`. The TARGET is resolved from live
	/// presence by `handoffTarget` (the owner's fallback chain, ghosts ignored, mobile
	/// excluded); this function owns only the "should we hand off at all" gating -- the
	/// per-chat opt-out, the always-on-worker rule, the step-away and posture rules, the
	/// agentic rule, and the mobile-vs-desktop last-resort split.
	/// Is the chat being seated running a turn on this device itself (`queueOn` is self)?
	function runsHere(o) {
		return !!(o && o.queueOn && o.selfId && String(o.queueOn) === String(o.selfId));
	}

	function autoDispatchDecision(chat, presence, opts, now) {
		var box = { passed: [] };
		var d = dispatchDecision(chat, presence, opts, now, box);
		// The busy peers the election passed over (H1), for the elect row and the tile.
		d.passed = box.passed;
		return d;
	}

	function dispatchDecision(chat, presence, opts, now, box) {
		var o = opts || {}, c = chat || {};
		var n = (now == null ? Date.now() : now);
		var win = o.freshWindowMs || DISPATCH_FRESH_MS;

		// The present-derived target and how it was reached. A ghost id in any stored list
		// is never seated -- routing reads presence, not the blob device list.
		var res = handoffTarget(presence, {
			selfId:                 o.selfId,
			windowMs:               win,
			currentBuild:           o.currentBuild,
			preferredLabel:         o.preferredLabel,
			nominatedId:            o.nominatedId,
			presumeNomineeWindowMs: o.presumeNomineeWindowMs,
			exclude:                o.exclude,
			// A runner busy with ANOTHER chat is passed over, so the switch reads Here; the
			// device already running THIS chat stays seated, and a follow-up waits in that
			// chat's queue behind the running turn (O3, D-20261009-23).
			queueOn:                o.queueOn,
			// The chat being seated, read against each peer's `busyChats`.
			chatId:                 o.chatId != null ? o.chatId : c.id,
			// What the chat runs on, as the page resolved it (the stored pick only when the
			// caller gave none): a native runner is offered a credits chat only (recEngineOk).
			provider:               o.provider != null ? o.provider : c.provider,
			// A chat whose folder is rooted on this device runs only where a folder is
			// rooted too (F4c, UNBLOCK-32): a runner without one would reach none of it, and
			// a switch that offers a runner which then cannot do the turn is a fault (§1).
			require:                o.needFolder ? 'folder' : '',
		}, n);
		box.passed = res.passed || [];
		var target = res.target;
		// `runner-posture` is worker-grade: a machine arranged to be the runner is the seat
		// for every turn exactly as the star is, which is the whole point of arming it.
		var isWorker = !!(target && (res.reason === 'nominee' || res.reason === 'nominee-presumed'
			|| res.reason === 'worker' || res.reason === 'runner-posture'));

		// The per-chat choice: true = always hand off, false = keep on THIS device
		// (the opt-out), null/undefined = decide by the reliability policy below.
		var toggle = (o.toggle != null) ? !!o.toggle : null;
		// An explicit opt-out pins the chat here regardless of any peer -- tested first.
		if (toggle === false) return { dispatch: false, reason: 'chat-local' };

		// THIS CHAT'S TURN IS RUNNING HERE (UNBLOCK-1 DISPATCH-FAIL). A hand-off that fell
		// back to this device -- a refused post, the backstop, a hand-back, a lease that
		// lapsed -- is this device's run, and a follow-up queues behind it here (O3), so the
		// seat is here: the switch never names a runner that is not running the turn
		// (rulings §1, I9). `queueOn` is the device running the chat (`chatRunningOn`).
		if (runsHere(o)) return { dispatch: false, reason: 'running-here' };

		// THE PREFERRED WORKER (a live nominee or the star's label) takes EVERY turn, above
		// the step-away / posture / agentic / quick-local rules -- it is the account's chosen
		// always-on runner, and the CLAIM arbitration defers to it, so the dispatch must seat
		// it too or iOS labels a fresher peer while the worker actually runs.
		if (isWorker) return { dispatch: true, peer: target, reason: res.reason, staleBuild: !!target.staleBuild };

		// THIS DEVICE IS THE NOMINEE. `handoffTarget`'s own nominee clause (a) excludes a
		// self match (`nom !== self`), so a nominee reading its own id back here would fall
		// through to (a')/(a'')/(b) and seat some OTHER live desktop instead -- dispatching
		// the elected runner's own turn away to a peer that was never asked to take it, which
		// then just sits unclaimed. The elected nominee always runs its own turns locally.
		if (o.nominatedId && String(o.nominatedId) === String(o.selfId)) return { dispatch: false, reason: 'self-nominee' };

		// THE PERSON'S SWITCH (owner, D-20261009-23): a turn sent from the composer runs on
		// the runner the "Here | <runner>" switch names, or here -- nowhere else. A desktop
		// seated by any other rule is a device the switch never offered, so the label would
		// name one machine while another ran the turn (9 Oct: argonaut named, gilgamesh ran).
		if (o.runnerOnly) return { dispatch: false, reason: 'no-runner' };

		// A device stepping away (backgrounding) with a turn STILL IN FLIGHT hands the
		// running turn to a live desktop before it suspends -- but only if one exists;
		// none means keep it here to be recovered on return.
		if (o.backgrounding && o.turnInFlight) {
			return target ? { dispatch: true, peer: target, reason: 'backgrounding-in-flight', staleBuild: !!target.staleBuild }
				: { dispatch: false, reason: 'no-genuine-peer' };
		}

		// An explicit per-chat opt-IN, or the device-wide "hand off while I am away"
		// posture: honour it when a live desktop exists, else run local.
		if (toggle === true || o.globalDefault) {
			return target ? { dispatch: true, peer: target, reason: 'toggle-on', staleBuild: !!target.staleBuild }
				: { dispatch: false, reason: 'no-genuine-peer' };
		}

		// A LONG or AGENTIC turn is worth offloading to a live desktop even from another
		// desktop -- the separate "fan a heavy turn out to a persistent peer" feature. The
		// worker signal must be a GENUINE pair: daimond.js seeds `workerModel`/`workerProvider`
		// to the chat's OWN model for every active chat, so a bare truthiness test would
		// dispatch every turn (D2) -- a worker/Diamond chat is one whose pair DIFFERS from
		// the chat's own.
		var agenticWorker = (c.workerModel    && String(c.workerModel)    !== String(c.model    || ''))
			|| (c.workerProvider && String(c.workerProvider) !== String(c.provider || ''));
		var agentic = !!o.toolsEnabled || !!o.expectedLong || !!agenticWorker;
		if (agentic && target) return { dispatch: true, peer: target, reason: 'long-turn', staleBuild: !!target.staleBuild };

		// THE RUNNER IS DOWN (no preferred worker, no posture). Fallback ordering by
		// connection reliability -- desktop > laptop > mobile (owner 2026-09-06):
		//   - MOBILE: hand to a live non-mobile desktop if one exists; else run LOCAL -- the
		//     LAST resort, because the phone is the least reliably connected device. Never
		//     fall to local while a live non-mobile desktop is present (the owner's rule).
		//   - DESKTOP / LAPTOP: run LOCAL. A desktop is itself a reliable runner.
		if (o.isPhone) {
			return target ? { dispatch: true, peer: target, reason: 'mobile-peer', staleBuild: !!target.staleBuild }
				: { dispatch: false, reason: 'no-genuine-peer' };
		}
		return { dispatch: false, reason: 'desktop-local' };
	}

	/// WHERE THE NEXT TURN WILL RUN, as a line a user can read before they send.
	///
	/// The election was invisible: a turn left for another machine, or stayed here, and the
	/// only way to find out which was to send and watch. On a phone that matters -- a turn
	/// that runs locally needs the screen kept awake and in the foreground, and the user can
	/// only plan for that if they are told BEFORE they commit to it (owner spec 2026-09-12).
	///
	/// Pure, and the SAME decision the send takes: `autoDispatchDecision` over the same
	/// presence, so the line cannot promise one seat and the send take another. Answers
	///
	///   { where, label, deviceId, warn, why, reason, dispatch, staleBuild }
	///
	/// `where` is `runner` (the account's nominated always-on device), `desktop` (another
	/// live desktop, the runner being absent) or `local` (here). `label` is the seat's
	/// device name; `warn` is true only where running here is a thing
	/// the user must act on -- a mobile device, which must stay foregrounded -- and `why`
	/// then names the reason the line can give: `chat-local`, `runner-silent` or
	/// `no-desktop`.
	function seatPlan(chat, presence, opts, now) {
		var o = opts || {}, p = presence || {};
		// An unknown map seats nobody (`presenceUnknown`): Here, as a send whose read did
		// not land, never a runner the map last named before the gateway went.
		if (o.presenceUnknown) p = {};
		var n = (now == null ? Date.now() : now);
		var w = o.freshWindowMs || DISPATCH_FRESH_MS;
		var d = autoDispatchDecision(chat, p, o, n);
		if (d.dispatch && d.peer) {
			var onRunner = (d.reason === 'nominee' || d.reason === 'nominee-presumed'
				|| d.reason === 'worker' || d.reason === 'runner-posture');
			// A nominee that is SET but not beating is named as the reason this turn is going
			// somewhere else, so a silent runner is visible rather than merely bypassed.
			var nom  = String(o.nominatedId || '');
			var nrec = nom ? p[nom] : null;
			var nomLive = recGenuine(nrec, n, w);	// reachable = listening (rulings §1)
			var fallback = !onRunner && nom && !nomLive;
			return {
				where:      onRunner ? 'runner' : 'desktop',
				label:      String(d.peer.name || ''),
				deviceId:   String(d.peer.deviceId || ''),
				warn:       false,
				// The line names the seat in one clause; WHY it is a fallback rather than the
				// starred runner rides the tooltip (owner, 2026-09-13). Empty on an ordinary
				// seat, which has nothing to explain.
				why:        fallback ? 'runner-silent' : '',
				reason:     d.reason,
				dispatch:   true,
				staleBuild: !!d.staleBuild,
			};
		}
		// LOCAL. On a mobile device this is the state worth shouting about, so the line
		// carries the warning and the reason; on a desktop it is the ordinary case and the
		// line is a plain statement.
		var mob = !!o.selfMobile;
		var nom2  = String(o.nominatedId || '');
		var nrec2 = nom2 ? p[nom2] : null;
		var why = (d.reason === 'chat-local' || d.reason === 'running-here') ? 'chat-local'
			: (nom2 && !recGenuine(nrec2, n, w)) ? 'runner-silent'
			: 'no-desktop';
		return {
			where:    'local',
			label:    '',
			deviceId: String(o.selfId || ''),
			warn:     mob,
			why:      why,
			// THE RUNNER THE LINE IS TALKING ABOUT, so `runner-silent` can NAME it.
			// A locked device cannot beat at all -- the gateway session is taken by
			// SIGNING a challenge with the sealed key (gateway.js bootstrapOnce), so a
			// tab at its lock screen is indistinguishable from one asleep or closed.
			// Naming the machine is therefore the whole of what the fleet can honestly
			// say, and it is what the owner needed: "argonaut is not awake", not "no
			// other device is awake to take it" while argonaut sat at a lock screen
			// (2026-09-13).
			runnerId: nom2,
			reason:   d.reason,
			dispatch: false,
		};
	}

	/// THE "Here | <runner>" SWITCH (owner, D-20261009-23), as `{ runner, choice, until }`.
	///
	/// `runner` is `{ deviceId, label }` for the nominated runner while it is reachable
	/// and free, else null and the switch is plain "Here". It is found with the chat's own
	/// choice set aside, so a chat pinned Here still offers the runner it could go back to.
	/// `choice` is what the next send does: `here` when the chat is pinned here
	/// (`opts.toggle === false`) or there is no runner, else `runner`. `until` is the
	/// first moment the runner no longer counts as reachable on the beat it has (0 with no
	/// runner, or a row the gateway derives), so the caller can redraw to "Here" then
	/// rather than at the next beat (R4).
	function seatSwitch(chat, presence, opts, now) {
		// The runner is found with this device's own run of the chat set aside too, so the
		// switch still offers the runner the next turn may go back to, unpressed, while the
		// chat's turn runs here (UNBLOCK-1 DISPATCH-FAIL).
		var here0 = runsHere(opts);
		var o = Object.assign({}, opts || {}, { toggle: null }, here0 ? { queueOn: '' } : {});
		var plan = seatPlan(chat, presence, o, now);
		var runner = (plan.where === 'runner' && plan.deviceId)
			? { deviceId: plan.deviceId, label: plan.label } : null;
		var here = !runner || here0 || (opts && opts.toggle === false);
		var until = 0;
		if (runner) {
			var rec = (presence || {})[runner.deviceId];
			var w = o.freshWindowMs || DISPATCH_FRESH_MS;
			if (plan.reason === 'nominee-presumed' && o.presumeNomineeWindowMs > w) w = o.presumeNomineeWindowMs;
			// Reachable while it beats and listens within `w` (electTarget, recGenuine), so
			// the first moment either stamp ages out.
			// From a deriving gateway nothing ages: the switch is redrawn on each presence
			// change instead (design 2.5), so there is no moment to arm a timer for.
			if (rec && !recDerived(rec)) {
				var last = leaseMs(rec.lastSeen);
				if (rec.servicedAt != null) last = Math.min(last, leaseMs(rec.servicedAt));
				until = last + w + 1;
			}
		}
		return { runner: runner, choice: here ? 'here' : 'runner', until: until };
	}

	// ════════════════════════════════════════════════════════════
	// WHERE A TASK RUNS — the placement (owner design, 2026-09-14).
	// ------------------------------------------------------------
	// The seat line answers that question for a TURN. Everything else the app does
	// -- laying a book out, running the project's publish script -- answered it by
	// assuming "here", which is right on a desktop and was the whole of the fault on a
	// phone: the author's 48-page book is 29 files the phone may not hold and 306 MB of
	// wasm heap it may not have, and pressing Compile there produced either a file the
	// gather could not reach or a tab iOS ended without a word.
	//
	// So the same election answers for the rest of the work. `placeTask` sits beside
	// `seatPlan` and calls through to it for a turn, so a compile and a turn cannot name
	// different machines for one presence snapshot, and it moves a task ONLY for a need
	// the device demonstrably cannot meet -- a file it does not hold, a heap it cannot
	// afford, a machine hand it has not got. Never for a preference, and never for a
	// guess about which machine is "better".
	// ════════════════════════════════════════════════════════════

	// The closed vocabulary. A task is one of these and nothing else, so the rule table
	// is something a test enumerates rather than something it guesses at.
	var TASK_KINDS = ['edit', 'view', 'save', 'compile', 'publish', 'dev', 'run',
		'verify', 'serve', 'terminal', 'turn'];

	// The four placement reasons, beside the three `seatPlan` already names. `here` is
	// in the set on purpose: "everything it needs is here" is an answer, and a reason
	// the tooltip gives, not the absence of one.
	var PLACE_WHYS = ['here', 'missing-files', 'too-large', 'needs-hand',
		'runner-silent', 'no-desktop', 'chat-local'];

	/// Is `k` a task kind this layer places?
	function taskKind(k) { return TASK_KINDS.indexOf(String(k)) >= 0; }

	/// The i18n key for the BUTTON, given the kind and where the task landed. Only the
	/// two kinds that have a button answer; everything else places without saying so.
	function placeKey(kind, where) {
		var compile = kind === 'compile';
		var hand = ['publish', 'dev', 'run', 'verify', 'serve', 'terminal'].indexOf(kind) >= 0;
		if (!compile && !hand) return '';		// nothing else is drawn as a button
		if (where === 'here')   return hand ? 'files.publish_here' : 'files.compile_here';
		if (where === 'runner') return hand ? 'files.publish_on'   : 'files.compile_on';
		return '';
	}

	/// The i18n key for the HOVER, given the reason. The button says where; the title
	/// says why, which is the shape the seat line settled on (owner, 2026-09-13).
	function placeTitleKey(why) {
		return why === 'here'          ? 'place.why_here'
			: why === 'missing-files' ? 'place.why_missing_files'
			: why === 'too-large'     ? 'place.why_too_large'
			: why === 'needs-hand'    ? 'place.why_needs_hand'
			: '';
	}

	/// `opts` with a beat field every candidate must explicitly carry as true.
	function withRequire(opts, field) {
		var o = {};
		for (var k in (opts || {})) {
			if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
		}
		o.require = field;
		return o;
	}

	/// The LAST DEVICE THE ROSTER SAW carrying `field`, so a refusal can name argonaut
	/// while argonaut is asleep. Answers `{ deviceId, name, known }` -- `known` false
	/// where the roster holds a plausible machine that has simply never said (an older
	/// build), which is named as a maybe and never struck out.
	function lastSeenWith(roster, field, selfId) {
		var r = roster || {}, self = String(selfId || '');
		var sure = null, maybe = null;
		for (var id in r) {
			if (!Object.prototype.hasOwnProperty.call(r, id)) continue;
			if (id === self) continue;
			var rec = r[id];
			if (!rec || rec.mobile === true) continue;		// a phone is never the answer here
			var when = leaseMs(rec.lastSeen);
			if (rec[field] === true) {
				if (!sure || when > leaseMs(sure.lastSeen)) sure = { id: id, rec: rec, lastSeen: when };
			} else if (rec[field] == null) {
				if (!maybe || when > leaseMs(maybe.lastSeen)) maybe = { id: id, rec: rec, lastSeen: when };
			}
		}
		var pick = sure || maybe;
		if (!pick) return { deviceId: '', name: '', known: false };
		return { deviceId: pick.id, name: String(pick.rec.name || ''), known: !!sure };
	}

	/// The placement answer, assembled once so every arm has the same fields.
	function placed(where, need, f) {
		var o = f || {};
		return {
			where:    where,
			key:      o.key != null ? o.key : placeKey(need.kind, where),
			titleKey: o.titleKey != null ? o.titleKey : placeTitleKey(o.why || 'here'),
			label:    String(o.label || ''),
			deviceId: String(o.deviceId || ''),
			why:      String(o.why || 'here'),
			reason:   String(o.reason || ''),
			// The two measured numbers, so the tooltip can state the case rather than
			// assert it: how many files are missing, and the megabytes on each side.
			n:        o.n | 0,
			needMB:   o.needMB | 0,
			roomMB:   o.roomMB | 0,
			need:     need,
			seat:     o.seat || null,
			can:      where !== 'nobody',
		};
	}

	/// Where should this task run? Pure, and the SAME election a turn takes.
	///
	/// `need` is the `TaskNeed` the caller declares at the moment the button is drawn
	/// (and again at the click, because files change); `ledger` is this device's own
	/// answer about itself; `presence` the live beats; `opts` the seat options plus a
	/// `roster` of last-known device lines. Answers
	///
	///   { where, key, titleKey, label, deviceId, why, reason, n, needMB, roomMB,
	///     need, seat, can }
	///
	/// `where` is `here`, `runner` or `nobody`; `why` is drawn from `PLACE_WHYS`.
	function placeTask(need, ledger, presence, opts, now) {
		var n = need || {}, L = ledger || {}, p = presence || {}, o = opts || {};
		var t = now == null ? Date.now() : now;
		var kind = String(n.kind || '');

		function here(why) {
			return placed('here', n, { why: why || 'here',
				deviceId: String(L.deviceId || o.selfId || ''), label: String(o.selfName || '') });
		}
		function onRunner(res, why, more) {
			var tgt = res.target || {};
			var m = more || {};
			return placed('runner', n, { why: why, reason: res.reason,
				deviceId: String(tgt.deviceId || ''), label: String(tgt.name || ''),
				n: m.n, needMB: m.needMB, roomMB: m.roomMB });
		}
		function nobody(field, why, more) {
			var last = lastSeenWith(o.roster, field, o.selfId);
			var m = more || {};
			return placed('nobody', n, {
				// NAMED, AND HONESTLY. A machine the roster has seen holding this is named;
				// one that has simply never said is named as a maybe -- never struck out,
				// which is the seq-218 rollout rule (an old runner must not disappear from
				// Publish the way it once disappeared from hand-off).
				key:      last.deviceId ? (last.known ? 'place.nobody' : 'place.nobody_maybe')
					: 'place.nobody_generic',
				titleKey: placeTitleKey(why),
				deviceId: last.deviceId, label: last.name, why: why,
				n: m.n, needMB: m.needMB, roomMB: m.roomMB });
		}

		// 1. HERE BY ROUTE. Editing and viewing want the person; a save is here because
		// the bytes are here and the sync carries them on. No election is consulted: a
		// rule presence could argue with is not a rule.
		if (kind === 'edit' || kind === 'view' || kind === 'save') return here('here');

		// 2. A TURN KEEPS THE EXISTING ELECTION VERBATIM. `seatPlan` is the answer and
		// this is only a wrapper, so the seat line and the Send button stay one thing.
		if (kind === 'turn') {
			var sp = seatPlan(o.chat, p, o, t);
			return placed(sp.where === 'local' ? 'here' : 'runner', n, {
				key:      '',			// the seat line owns its own wording
				titleKey: '',
				label: sp.label, deviceId: sp.deviceId, why: sp.why || '', reason: sp.reason,
				seat: sp });
		}

		// 3. THE HAND-BEARING TASKS. Only a device with the machine hand may run them, so
		// the question is "which Hand-bearing device is awake", not "where would a turn
		// go". The election is reused with a FILTER, so the nominee/label/posture/desktop
		// order is the seat plan's, restricted to peers whose beat says `hand`.
		if (n.hand) {
			if (L.hand) return here('here');
			var h = handoffTarget(p, withRequire(o, 'hand'), t);
			if (h.target) return onRunner(h, 'needs-hand');
			return nobody('hand', 'needs-hand');
		}

		// 4. A COMPILE. Two measurable needs and nothing else moves it (owner rule): a
		// file this device does not hold, or a heap the device cannot afford.
		if (kind === 'compile') {
			var miss = (L.files && L.files.missing) ? L.files.missing : [];
			var room = (L.budgetMB | 0) - (L.heapMB | 0);
			// 0 means NO ESTIMATE YET, which is not the same as "it will fit": with no
			// measurement the compile happens here and the local heap guard holds it, which
			// is what it is for. A number is only ever trusted downwards.
			var want = (n.memoryMB > 0) ? (n.memoryMB + (L.headroom | 0)) : 0;
			if (!miss.length && (want === 0 || want <= room)) return here('here');
			var why = miss.length ? 'missing-files' : 'too-large';
			var more = { n: miss.length, needMB: want, roomMB: room };
			// A runner that HOLDS THE FOLDER, so the book it lays out is the real one and
			// the PDF it writes lands beside the source rather than in a replica.
			var r = handoffTarget(p, withRequire(o, 'folder'), t);
			if (r.target) return onRunner(r, why, more);
			return nobody('folder', why, more);
		}

		// Every other kind is local until it declares a need.
		return here('here');
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
		if (rec.busy > 0) return false;				// busy nominee -> an idle device claims (H1)
		var n = now == null ? Date.now() : now;
		// Stand down only while the nominee is LIVE by the test the seat uses (recGenuine):
		// one that beats but no longer listens never collects, so deferring to it stalls.
		return recGenuine(rec, n, windowMs || DISPATCH_FRESH_MS);
	}

	/// Should this device stand down from an errand ADDRESSED to another device? The
	/// sender's switch named one runner, and only it takes the turn (D-20261009-23): not
	/// a second idle desktop, and not while the named runner is busy, since a turn
	/// addressed to a busy runner is queued there on purpose (O3). The 14:03 fault (13 Oct)
	/// was gilgamesh taking a turn named for a busy argonaut. Answers true (stand down),
	/// false (this is the addressee: claim, whoever the nominee is) or null when the
	/// errand names nobody or names a runner that already handed it back -- then the
	/// nomination decides, as before.
	///
	/// WHATEVER THE ADDRESSEE'S STATE (HT-ID, QA-HT-B F2; rulings §1 l.9, l.15). An errand
	/// that names a runner is that runner's alone. A collector does not judge the runner
	/// gone: under derived presence a runner reads not-live 10 s after its park dies, and
	/// at once while a reloaded tab has parked but not yet stated, so a liveness gate here
	/// handed argonaut's turn to gilgamesh. If the runner cannot take it, the asker's
	/// withdraw-on-loss or backstop ends it. "Any awake device" stays for an errand with no
	/// addressee. `presence`, `now` and `windowMs` are kept for the callers' signature.
	function addresseeStandDown(errand, selfId, presence, now, windowMs) {
		var e = errand || {};
		var to = String(e.to || '');
		if (!to) return null;
		if (to === String(selfId || '')) return false;
		if (triedList(e.tried).indexOf(to) >= 0) return null;
		return true;
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
	// How often the runner streams the running turn's transcript to the mailbox, so a
	// peer watching the hand-off sees the thinking and tool calls unfold rather than a
	// blank wait until the turn finishes. Faster than the liveness ticker because it is
	// the UX cadence, not the lease cadence. A tick sends ONE SMALL FRAME -- the turn's
	// rendered tail through the progress door (sync.js pushProgressFrame), tens of
	// kilobytes at most -- and not the whole account parcel, which is what made this
	// cadence affordable; a tick whose tail is unchanged sends nothing at all.
	//
	// 750 ms, down from 2000 (Q20, D-20261006-13: model output reached a watcher too
	// slowly). The runner LOOKS every PROGRESS_TICK_MS and SENDS only when the turn
	// changed, at least PROGRESS_EVERY_MS after the last frame left and never while
	// one is in flight -- so a quiet turn costs nothing and a busy one at most four
	// frames in three seconds. A fixed 750 ms interval could not keep that spacing:
	// a frame leaves some milliseconds after its tick, so the next tick would land
	// short of 750 ms and wait a whole interval more.
	var PROGRESS_EVERY_MS = 750;		// least spacing of two streaming frames
	var PROGRESS_TICK_MS  = 250;		// how often the runner looks for growth
	var LIVENESS_GAP_MS   = 3000;		// least spacing of event-driven lease reads on a running turn
	var MAX_TAKE_TRIES = 10;		// bound the CAS retry loop (was 6): more headroom under two-device churn
	var TAKE_BACKOFF_MS = 250;		// jittered wait between take retries so a claim gets a clean window
	var UNREAD_RETRY_MS = 1000;		// the pause before a lease write looks once more at a door that would not read
	var UNREAD_LOOKS    = 3;		// reads of an unreadable door that a take makes before it stands down on it
	// The hard ceiling on how long ONE errand's liveness ticker may run before it gives
	// up and aborts. The ticker is READ-ONLY (it never renews the parcel -- the lease is
	// claimed straight to its deadline, so no renew is needed), so it is not itself a
	// churn source; but a runTurn whose promise never settles would keep the ticker (and
	// the errand) alive indefinitely, so this caps it -- after which the run is aborted
	// best-effort and the lease is left to expire at its deadline. Generous, because it
	// is a backstop for a hung turn, not a turn budget.
	var MAX_LEASE_LIFE_MS = 30 * 60 * 1000;	// 30 min: a turn still 'running' past this is hung, not live
	// HOW FAR AHEAD A RUNNING TURN HOLDS ITS LEASE (UNBLOCK-25). `DISPATCH_DEADLINE_MS` bounds
	// only when a turn may START; a turn still running near it renews its own lease through
	// the door, this far ahead, so every other device reads it live and none re-runs it.
	// Never past the hung cap from the deadline (`expiryCap`). A runner that dies stops
	// renewing, and its lease lapses within this, as Interrupted + Retry.
	var RUN_HOLD_MS = 5 * 60 * 1000;

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

	/// Was a turn's lease taken to END the turn rather than run it (SUHT-I9)? The asker takes
	/// a hand-off's lease as itself before it ends the turn "not run" (`endHandOffNotRun`), so
	/// the errand still in the box can never run late on the runner. Such a claim arbitrates
	/// like any other, but nobody is running the turn: every reader that names a RUNNER --
	/// `leaseHolder`, `leaseHeldBy`, `uiState` -- reads it as nobody's run, on every device.
	function endingLease(r) { return !!r && !!r.ending; }

	/// Did THIS device end the turn "not run" (SUHT-R F4)? Its own `ending` lease, settled: the
	/// end won its take and settled, so whatever the turn still lacks (the row, a dropped
	/// placeholder) is this device's to finish, and nobody runs it.
	function endedHere(r, selfId) {
		return endingLease(r) && settledLease(r) && !!selfId && String(r.holder || '') === String(selfId);
	}

	/// Is a record DEAD: vacant, and past the last moment any copy of it anywhere
	/// could still read live, by one TTL of grace? A released tombstone (expiry 0)
	/// must outlive the stale 'running' copy it supersedes, and that copy's expiry is
	/// at most its deadline (clampExpiry), so the deadline is IN the max -- shortening
	/// the grace to `expiry` alone would drop a tombstone while its stale live copy
	/// still circulates and resurrect a released turn. A dead record decides nothing
	/// (the both-vacant arm of pickLease grants nothing), so dropping it changes no
	/// arbitration -- it only stops the lease door growing for ever, which is the S1
	/// this guards (the sealed door 413s at ~200-300 dispatched turns and hand-off
	/// dies for the account). A record lives at most DISPATCH_DEADLINE_MS +
	/// LEASE_TTL_MS (16.5 min) after its dispatch.
	function deadLease(r, now) {
		if (!r || liveLease(r, now)) return false;
		if (isMark(r)) return !!r.retired && now > leaseMs(r.deadline);
		var last = Math.max(leaseMs(r.expiry), leaseMs(r.deadline), leaseMs(r.renewedAt));
		return now - last > LEASE_TTL_MS;
	}

	// ── The answered mark (r569) ─────────────────────────────────
	//
	// A claim is a lease, and a lease is drained 16.5 minutes after its dispatch, so it
	// cannot be the only record that an occasion was ANSWERED: a device that woke later
	// found no record and ran it again. A MARK is the durable half, kept in the same
	// section and written through the same door: "answered through `mark`" in generation
	// `gen` (a folder's uidValidity), under a key its caller names. Within one generation
	// it merges as a monotone max, so two writers converge with no arbitration. It is not
	// drained while live: one record per key, which the caller bounds (one per Diamond,
	// mailbox and folder), and RETIRES when what it answered for is deleted. It holds no
	// claim: no holder, released, expiry 0, so every live-lease reader passes over it.
	//
	// A GENERATION IS AN IDENTITY, NEVER AN ORDER (r569 A1). IMAP promises only that a
	// new UIDVALIDITY differs from the old: a mailbox moved to another server can come
	// back lower, and one read as a signed 32-bit number goes negative above 2^31. A mark
	// that "covered" every lower generation then silenced the folder for good. So a mark
	// of another generation covers nothing, and between two generations the fresher write
	// wins. At worst a device still on the old generation writes it back once, and the
	// next arrival in the new one runs a turn it need not have: a cost, not a loss.
	var MARK_HORIZON_MS = 30 * 24 * 3600 * 1000;	// a retired mark's life

	/// Is a record an answered mark rather than a lease? A retired one is too.
	function isMark(r) { return !!r && typeof r.mark === 'number'; }

	/// Is a record a mark still in force, not retired?
	function liveMark(r) { return isMark(r) && !r.retired; }

	/// Does mark `r` cover `n` in generation `gen`?
	function markCovers(r, gen, n) {
		return liveMark(r) && leaseMs(r.gen) === leaseMs(gen) && r.mark >= leaseMs(n);
	}

	/// The winner of two marks for one key: the higher of two live marks in one generation,
	/// else the fresher write (a new generation, or a retirement); the incoming on a tie,
	/// as `pickLease` keeps.
	function pickMark(local, incoming) {
		if (!isMark(local)) return isMark(incoming) ? incoming : local;
		if (!isMark(incoming)) return local;
		if (liveMark(local) && liveMark(incoming) && leaseMs(local.gen) === leaseMs(incoming.gen)) {
			return local.mark > incoming.mark ? local : incoming;
		}
		return leaseMs(local.renewedAt) > leaseMs(incoming.renewedAt) ? local : incoming;
	}

	/// Mark `cur` retired at `now`: fresher than every live copy, so it wins every merge,
	/// and drained one horizon later. A mark written again after it is a fresh start.
	function retiredRecord(cur, now) {
		return {
			mark: leaseMs(cur.mark), gen: leaseMs(cur.gen), retired: 1, mode: 'released', expiry: 0,
			deadline: now + MARK_HORIZON_MS, renewedAt: Math.max(now, leaseMs(cur.renewedAt) + 1),
		};
	}

	/// A mark record answering through `n` in `gen`, written after `cur` (fresher
	/// `renewedAt`, so it replaces a mark of another generation or a retired one).
	function markRecord(gen, n, now, cur) {
		return {
			mark: leaseMs(n), gen: leaseMs(gen), mode: 'released', expiry: 0,
			deadline: now + MARK_HORIZON_MS, renewedAt: Math.max(now, leaseMs(cur && cur.renewedAt) + 1),
		};
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
		if (dl > cap) cap = dl;
		// A RUNNING TURN PAST ITS START WINDOW (UNBLOCK-25) holds its lease one `RUN_HOLD_MS`
		// ahead of this device's clock, and never past the hung cap measured from the
		// dispatcher's deadline, so a fast-clock holder still cannot park a turn for long.
		if (dl && r.mode === 'running') {
			var run = Math.min(now + RUN_HOLD_MS, dl + MAX_LEASE_LIFE_MS);
			if (run > cap) cap = run;
		}
		return cap;
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
	///  - both vacant -> the fresher record, kept for one TTL past its deadline, then
	///    drained (`deadLease`, applied in `mergeLeases`). A dead lease grants nothing,
	///    so this never decides a claim; keeping it briefly only lets a tombstone
	///    outlive the stale live copy it supersedes.
	function mergeOneLease(local, incoming, now) {
		return clampExpiry(pickLease(local, incoming, now), now);
	}

	/// The winner of two records for one turnId, BEFORE the expiry clamp.
	function pickLease(local, incoming, now) {
		if (isMark(local) || isMark(incoming)) return pickMark(local, incoming);
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
		// THE DRAIN (fix for the S1 lease-door 413). A dead record re-arriving from a
		// device that has not merged yet is re-added by the union loop above and dropped
		// again here, so the map stays bounded rather than growing one entry per turn for
		// ever. Every proposal and every local view folds through this one choke point.
		for (k in out) {
			if (Object.prototype.hasOwnProperty.call(out, k) && deadLease(out[k], now)) delete out[k];
		}
		return out;
	}

	/// The clock every lease age and expiry is measured on when a caller passes none:
	/// this device's own clock, corrected by the offset the gateway's answers have
	/// taught it (`relayNow`, learned from `presenceIngest`'s pull/presence `now`),
	/// never this device's raw, uncorrected clock. Two devices whose raw clocks
	/// disagree by more than the 90s TTL both correct toward the SAME gateway time and
	/// so agree on whether a lease is live (SIM-4: a device far enough ahead read a
	/// still-running peer's lease as dead and re-ran, and re-billed, the turn). Falls
	/// back to the raw clock only before any gateway round trip has taught the offset.
	function authorityNow() { var r = relayNow(); return r == null ? Date.now() : r; }

	function leaseNow(nowFn) { return (typeof nowFn === 'function') ? nowFn() : authorityNow(); }

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
	// STOP-ON-PEER: the turns this device is RUNNING, each with the check its runner
	// wants made when an adopted lease view moves. A revoke written elsewhere reaches
	// the view on the lease wake (sync.js `leaseWake`), and the runner reads
	// the door at once rather than at its next journal event or the 30 s ticker: a
	// quiet turn (a long tool call, a model thinking) heard a Stop only on the ticker.
	var _leaseWatch = Object.create(null);	// turnId -> fn

	/// THE RUNS A POISONED ENGINE MUST END (UNBLOCK-7 F4). A wasm trap leaves every engine
	/// await in this page unsettled, so a run waiting on one would hold the runner busy
	/// until the page died. Each running errand registers its end here; `poisonRuns`
	/// (daimond.js, on the trap) ends them all through the same door the lease deadline
	/// does. Answers how many it reached.
	var _poisonWatch = Object.create(null);	// turnId -> fn(why)
	function poisonRuns(why) {
		var ks = Object.keys(_poisonWatch), n = 0;
		for (var i = 0; i < ks.length; i++) {
			var f = _poisonWatch[ks[i]];
			if (typeof f !== 'function') continue;
			try { f(why || 'poison'); n += 1; } catch (err) { /* one run's end never blocks another's */ }
		}
		return n;
	}
	function leaseWatchFire() {
		var ws = Object.keys(_leaseWatch);
		for (var i = 0; i < ws.length; i++) {
			try { _leaseWatch[ws[i]](); } catch (err) { /* the ticker still checks */ }
		}
	}

	/// Merge an arriving parcel's `leases` into the local view under take-if-vacant.
	/// Called by sync.js's reconcile. Answers whether anything MOVED, so a pull that
	/// agreed with us schedules no push -- the same quiet-on-no-change contract the
	/// pause tree keeps (sync.js:786) -- and, when it moved, notifies the UI so the
	/// dispatched footer re-renders against the fresh lease (D4).
	function leaseAdopt(incoming, nowFn) {
		if (!incoming) return false;
		return leaseWrite(mergeLeases(_leases, incoming, leaseNow(nowFn)));
	}

	/// THE ONE WRITE TO THE LOCAL LEASE VIEW, so every change -- a merge from a pull, a
	/// claim lost to a peer's CAS, a renew, a release -- fires `_onLeaseChange` and the
	/// UI redraws against it. A claim that lost its race used to assign the door's map
	/// straight in, the footer kept "[Take back]" for a turn the peer had claimed, and
	/// twelve seconds later the control vanished with no sentence (D1, 2026-10-11).
	/// Answers whether the view moved.
	function leaseWrite(next) {
		var before = JSON.stringify(_leases);
		_leases = next || {};
		var moved = JSON.stringify(_leases) !== before;
		if (moved && _onLeaseChange) {
			try { _onLeaseChange(); } catch (err) { /* a redraw must never break a sync */ }
		}
		if (moved) leaseWatchFire();	// STOP-ON-PEER
		return moved;
	}

	/// The device RUNNING a turn: the live holder of its lease at `now`, or null when it is
	/// vacant or held only to end the turn (`endingLease`), which is nobody's run.
	function leaseHolder(turnId, now) {
		var r = _leases[String(turnId)];
		return liveLease(r, now == null ? authorityNow() : now) && !endingLease(r) ? r.holder : null;
	}

	/// The full lease record for a turn, or null. What the guards and the UI state
	/// machine read (they need mode/expiry/holder, not just the live holder).
	function leaseRecord(turnId) {
		return _leases[String(turnId)] || null;
	}

	/// The DEVICE ID of a hand-off target, whatever shape the caller is holding.
	///
	/// `handoffTarget` answers `{ deviceId, name, lastSeen, build }` and nothing in
	/// that record is called `id`, so a call site reaching for `t.id || t` handed
	/// `String()` the whole object and the feed carried `peer:"[object Obje"` --
	/// twelve characters of a template, on every elected dispatch, where the one
	/// field the event exists to report should have been. A bare id string is
	/// answered verbatim, so a caller that already resolved one needs no branch.
	function peerIdOf(t) {
		if (!t) return '';
		if (typeof t === 'string') return t;
		return String(t.deviceId || t.id || '');
	}

	/// The human LABEL of a hand-off target, or '' where it has none. Beside
	/// `peerIdOf` because an id of twelve hex characters tells a reader of the feed
	/// which device only if they already know the fleet.
	function peerLabelOf(t) {
		if (!t || typeof t === 'string') return '';
		return String(t.name || t.label || '');
	}

	/// Should THIS device hold its parcel push back, because another device is
	/// running a turn it is not part of? Pure over the lease snapshot.
	///
	/// Three devices, one turn: the phone dispatched it, argonaut is running it, and
	/// gilgamesh is neither. On the owner's hand-off gilgamesh pushed anyway, won the
	/// compare-and-set, and the runner's own push of the ANSWER came back 409 -- pull,
	/// merge, retry, +20 s -- after which the phone 409'd five times re-pushing its
	/// own. None of those pushes carried anything anybody was waiting for.
	///
	/// So a device that is neither the originator nor the runner defers while a lease
	/// it can see reads `running`. It is a DEFERRAL, not a refusal: the caller
	/// re-schedules, and what it was going to send it sends a moment later, when the
	/// two devices that are mid-hand-off have had the door. Bounded by the lease's own
	/// liveness, so a runner that dies cannot hold anybody off past its deadline.
	///
	/// `originator` is the turn's `dispatchedBy` as this device knows it -- from the
	/// dispatched placeholder it holds, where it holds one. A device that dispatched
	/// the turn NEVER defers: it is the one waiting for the answer, and its own pushes
	/// are how its half of the conversation travels.
	function deferPushFor(leases, selfId, now, isOriginatorOf) {
		var me = String(selfId || '');
		var n  = now == null ? authorityNow() : now;
		var ls = leases || {};
		for (var id in ls) {
			if (!Object.prototype.hasOwnProperty.call(ls, id)) continue;
			var r = ls[id];
			if (!liveLease(r, n) || r.mode !== 'running') continue;
			if (String(r.holder || '') === me) continue;			// we ARE the runner
			if (isOriginatorOf && isOriginatorOf(id)) continue;		// we sent it
			return String(id);										// the turn we are standing off for
		}
		return '';
	}

	/// Does `holder` hold a LIVE lease on any turn at all?
	///
	/// `leaseHolder` answers for one turnId, which is what every caller needed until
	/// something had to ask the question the other way round: is this device running
	/// a turn for anybody? The updater asks it before reloading a runner, because a
	/// reload drops a turn the device is holding for another and no amount of build
	/// drift is worth that.
	function leaseHeldBy(holder, now) {
		var who = String(holder || '');
		if (!who) return false;
		var n = now == null ? authorityNow() : now;
		for (var id in _leases) {
			if (!Object.prototype.hasOwnProperty.call(_leases, id)) continue;
			var r = _leases[id];
			if (liveLease(r, n) && !endingLease(r) && String(r.holder || '') === who) return true;
		}
		return false;
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

	// TRAINING WHEELS — remove with the DEBUG_SHARE module. The debug feed's
	// `handoff`: the lease IS the hand-off, so its three acts -- claim, release,
	// rescue -- are the whole of what this device did about somebody else's turn.
	// Ids (short), the verdict and the reason; never a prompt, an answer, or an
	// envelope. A no-op unless the share switch is on. Lifts out in one grep of
	// `DEBUG_SHARE`.
	function dsHandoff(payload) {
		try {
			if (window.DEBUG_SHARE && DEBUG_SHARE.event) DEBUG_SHARE.event('handoff', payload);
		} catch (e) { /* the feed must never break an arbitration */ }
	}

	/// TAKE the lease for a turn, based on a parcel snapshot already read. Answers
	/// `{ won, holder, why }`. The arbitration is `leaseTakeFromCas` below; this is
	/// only the reporting skin over it, so a hand-off that stood down leaves a
	/// trace of having done so.
	async function leaseTakeFrom(snap, turnId, opts, cas, nowFn) {
		var res = await leaseTakeFromCas(snap, turnId, opts, cas, nowFn);
		dsHandoff({
			act:    'claim',
			turn:   String(turnId).slice(0, 24),
			won:    res && res.won ? 1 : 0,
			holder: String((res && res.holder) || '').slice(0, 12),
			why:    String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// The arbitration. Stands down -- never runs -- when a live foreign lease
	/// exists (the merge drops the claim), when the turn has aged out (`opts.until`,
	/// or the deadline where no age verdict was passed), or when the CAS could not be
	/// won in bounds.
	///
	/// The fold is `mergeLeases(MY claim /*local*/, server leases /*incoming*/)`:
	/// the server's existing foreign lease is the INCOMING that beats my fresh
	/// claim, so the merge -- and nothing else -- decides the race. This argument
	/// order is load-bearing; reversed, a loser would keep its own claim and double
	/// bill, which is exactly what the freshest-scalar mutation test proves.
	async function leaseTakeFromCas(snap, turnId, opts, cas, nowFn) {
		var o = opts || {};
		var holder = String(o.holder || '');
		var tid    = String(turnId);
		var unreadLooks = 0;
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var now = leaseNow(nowFn);
			// AN UNREADABLE DOOR IS UNKNOWN, NOT VACANT (QA LQ1, 2026-10-04). Its `leases` is
			// `{}` only because nothing could be read, so a claim folded into it and committed
			// at the door's real version would REPLACE every record on the door with one, or
			// with an empty blob if this device is locked (`leaseSeal`) -- and a runner that
			// can read the door again would find its own turn gone. So it is never committed on.
			// But one slow or dropped read (the shim turns a timeout into this snapshot) is no
			// verdict either, so the door is looked at again after a pause, UNREAD_LOOKS times
			// in all and within the try budget, before the take stands down. The stand-down is
			// undecided (`standDownUndecided`): the errand stays on the relay for one more collect.
			if (snap.unread) {
				if (++unreadLooks >= UNREAD_LOOKS || attempt + 1 >= MAX_TAKE_TRIES) return { won: false, why: 'unread' };
				await new Promise(function (r) { setTimeout(r, UNREAD_RETRY_MS); });
				try { snap = await cas.read(); }
				catch (e) { snap = { version: 0, leases: {}, unread: true }; }
				continue;
			}
			// A MISSING OR ZERO DEADLINE IS NOT "NO DEADLINE" (S6-2). Only an old build
			// (or a hand-crafted envelope) posts an errand with no `deadline`; this build
			// always stamps one (`buildDispatch`, above). Falling back to
			// `ts + DISPATCH_DEADLINE_MS`, the same age `handoffDeadline` gives a
			// deadline-less placeholder, ages a deadline-less errand exactly as it ages
			// one that carries a real deadline, rather than letting a fresh runner accept
			// it however stale.
			var deadline = leaseMs(o.deadline) || (leaseMs(o.ts) ? leaseMs(o.ts) + DISPATCH_DEADLINE_MS : 0);
			// A TURN IS JUDGED BY ITS BIRTH, NOT BY THE SENDER'S DEADLINE (E-R1). `until` is
			// when `turnAgeVerdict` says the turn ages out, on THIS device's clock. The
			// deadline the sender wrote is no judge: a re-hand refreshes it, and a sender
			// more than the window slow had every fresh hand-off refused on it. The claim is
			// held to the later of the two, because with the refusal gone a slow sender's
			// deadline can already be past here, and a claim held to one TTL would read
			// expired on every other device while the turn still ran (the >TTL double-run).
			// A caller with no verdict -- a compile, a direct take -- keeps the old refusal.
			var until = leaseMs(o.until);
			if (until) {
				if (now > until) return { won: false, why: 'stale-turn' };
				if (until > deadline) deadline = until;
			} else if (deadline && now > deadline) {
				return { won: false, why: 'deadline' };
			}
			// A SETTLED lease is the tombstone of a turn a peer already finished
			// (leaseSetCas stamps `settled:1` on done->released). It reads VACANT, so without
			// this a taker whose collect delivered the errand and the done report in one page
			// would route the errand first and take the freed lease -- a second run, a second
			// charge (S-HAND #1). The proof of completion is in the lease, which every taker
			// reads before it takes, so it stands down here on the snapshot in hand.
			var settledCur = snap && snap.leases ? snap.leases[tid] : null;
			// A TOMBSTONE PAST ITS LIFE IS GONE (post-QA r569qa2 Q4). `mergeLeases` drops a dead
			// record at the next write, but the door holds it until some write lands, and on a
			// quiet account none may for hours: every take until then read it and stood down, so
			// a failed mail turn was retried only when an unrelated write happened to drain it.
			// A dead record decides nothing (`deadLease`), so it is read as the drain would.
			if (settledCur && deadLease(settledCur, now)) settledCur = null;
			// It adopts what it read, as every stand-down does: the mark raised with the
			// tombstone is what tells this device the arrival was answered (r569).
			if (settledCur && settledCur.settled) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { won: false, why: 'settled' };
			}
			// ANSWERED FOR GOOD (r569 R1). `opts.mark` names the occasion's answered mark:
			// covered, it was answered, however long ago, and stands down like a settled
			// turn. Not yet written, of another generation or retired, it is SEEDED below
			// the occasion in the claim's own write, so what is owed above it can be worked
			// out on any device, a reloaded one too, without a write of its own.
			var mk = o.mark && o.mark.key ? o.mark : null;
			var mcur = mk && snap && snap.leases ? snap.leases[String(mk.key)] : null;
			if (mk && markCovers(mcur, mk.gen, mk.upTo)) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { won: false, why: 'settled' };
			}
			// A RE-TAKE OF THIS DEVICE'S OWN LIVE CLAIM (RUNNER-READY F2). `mergeLeases` keeps a
			// live lease whose holder is the claimant, so the take wins -- but the run that
			// claimed it is gone (a reload: the work claim forbids a second run on this device),
			// and the caller ends that run as Interrupted rather than running the turn again.
			var retake = !!settledCur && String(settledCur.holder || '') === holder && liveLease(settledCur, now);
			// The claim expiry is the errand's DEADLINE (real or derived above), not
			// now + TTL, so the lease stays live for the whole turn WITHOUT a renew. A renew
			// through the lease door itself is not held back by a running turn (`leaseCommit`
			// sits outside the parcel push's busy gate, sync.js `pushWaits`), and the
			// mail claim relies on that, but a renew that rides the parcel is, and a
			// TTL-capped claim held by it would read expired elsewhere after 90s and be re-run
			// (the >TTL double-run). An errand with neither a deadline nor a `ts` falls back
			// to a single TTL, which the mail claim renews through the door. A
			// recovery errand carries the placeholder's own deadline (`errandForRecovery`,
			// 2026-09-23), so the refusal above stops a recovery of a hand-off that has
			// expired, as it stops any other taker.
			// The record carries `deadline` so every merge/clamp honours the same bound, and
			// the device the turn is being run FOR (`dispatchedBy`), so a runner that comes
			// back from a reload with the lease and no errand can still address the report
			// that hands it back (`reportFor`, R3 QA Q6). Every later write carries it on.
			var claim = {
				turnId: tid, eid: String(o.eid || ''), holder: holder,
				dispatchedBy: String(o.dispatchedBy || ''),
				mode: 'claimed', deadline: deadline || 0,
				expiry: (deadline && deadline > now) ? deadline : (now + LEASE_TTL_MS),
				renewedAt: now,
			};
			// WHY IT IS HELD (SUHT-I9): `opts.intent` 'end' takes the turn only to end it, and
			// says so on the record, so no device reads its holder as the turn's runner.
			if (o.intent === 'end') claim.ending = 1;
			var mine = { [tid]: claim };
			if (mk && !(liveMark(mcur) && leaseMs(mcur.gen) === leaseMs(mk.gen))) {
				mine[String(mk.key)] = markRecord(mk.gen, mk.floor, now, mcur);
			}
			var proposed = mergeLeases(mine, snap.leases, now);
			if (!proposed[tid] || proposed[tid].holder !== holder) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));	// adopt what we learned
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
				var conf = await readTwice(cas);
				// AN UNREADABLE CONFIRM IS NOT A LOSS (QA LQ2, 2026-10-04). The claim LANDED -- the
				// door answered `ok` to a write at its own version, and stores the proposal verbatim
				// -- so after one more look, an unreadable door trusts that answer. Standing down
				// here left a `claimed` record pinned to the deadline and the sender showing
				// "picking this up" for the whole of it, on a turn nobody was running.
				if (conf.unread) { leaseWrite(proposed); return { won: true, holder: holder, deadline: proposed[tid].deadline, retake: retake }; }
				leaseWrite(conf.leases || {});
				var landed = _leases[tid];
				if (landed && landed.holder === holder && liveLease(landed, leaseNow(nowFn))) {
					return { won: true, holder: holder, deadline: claim.deadline, retake: retake };
				}
				return { won: false, holder: landed ? landed.holder : null };
			}
			// A SIZE refusal is not a race: the door weighed the sealed blob and it does
			// not fit (DaimondWire.fits, or a real 413). Retrying spins MAX_TAKE_TRIES
			// times against a fixed-size refusal for no gain, so stand down at once with
			// the honest reason -- the drain heals the door as records age out.
			if (res.why === 'too_large') return { won: false, why: 'too_large' };
			// An UNREAD refusal is not a race either: this device could not seal the claim (it
			// is locked), and the next try would be refused the same way.
			if (res.why === 'unread') return { won: false, why: 'unread' };
			// A REKEY refusal is not a race either (Gap 5): the device is behind the epoch
			// chain, so `leaseCommit` will refuse EVERY try with the same 'rekey' -- its
			// stale wrap key seals a lease blob nobody on the current epoch can open. Stand
			// down at once rather than burn MAX_TAKE_TRIES to reach 'exhausted'; a re-link
			// clears it. Carried out as its own reason so the caller can tell it apart.
			if (res.why === 'rekey') return { won: false, why: 'rekey' };
			// 409: the version CHURNED under us. Under active two-device sync the parcel
			// version keeps moving, so a stale `base` is refused by the commit BEFORE it
			// even pushes -- back-to-back tries then all fail and the claim never lands
			// (the live why:'exhausted' hand-off failure). Take a FRESH read so the next
			// base is current, and back off a jittered moment so the two devices do not
			// collide in lockstep -- giving the claim a real window. The fold above still
			// stands us down if a live foreign winner has appeared, so this stays
			// single-run safe: only the persistence changes, never the arbitration.
			try { snap = await cas.read(); }
			catch (e) { snap = { version: res.version, leases: res.leases || {}, unread: !!res.unread }; }
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
	///
	/// `opts.hold` keeps the record's mode: a claim renewed only to stay live (a mail
	/// arrival's) is not a `running` hand-off, which other devices defer their push for.
	async function leaseRenew(turnId, holder, cas, nowFn, opts) {
		var tid = String(turnId), h = String(holder), hold = !!(opts && opts.hold);
		var holdMs = (opts && +opts.holdMs > 0) ? +opts.holdMs : 0;	// a running turn's hold (UNBLOCK-25)
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			if (snap.unread) return { ok: false, why: 'unread' };		// unknown, never 'revoked'
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			if (!cur || cur.holder !== h || cur.mode === 'released') {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: false, why: 'revoked' };
			}
			// A renew never SHRINKS a deadline-bounded expiry: it holds to the later of
			// one TTL from now and the errand's deadline. Since a running turn is claimed
			// straight to its deadline and no longer renews on a ticker (runErrand only
			// transitions claimed -> running once), this is a no-op for a live turn; it
			// stays correct for a direct DaimondLease.renew of a TTL-only (no-deadline)
			// lease, where it is the old `now + TTL`.
			// A RUNNING TURN'S HOLD (`holdMs`, UNBLOCK-25) reaches past the deadline, to the hung
			// cap at most: the start window does not bound a turn already running.
			var dl = leaseMs(cur.deadline);
			var exp = Math.max(now + LEASE_TTL_MS, dl);
			if (holdMs && dl) exp = Math.max(exp, Math.min(now + holdMs, dl + MAX_LEASE_LIFE_MS));
			var bumped = {
				turnId: tid, eid: cur.eid, holder: h, dispatchedBy: String(cur.dispatchedBy || ''),
				mode: cur.mode === 'claimed' && !hold ? 'running' : cur.mode,
				deadline: dl,
				expiry: exp, renewedAt: now,
			};
			if (cur.blocker) bumped.blocker = cur.blocker;		// a hold is not an unblock
			if (cur.ending) bumped.ending = 1;					// held to end, never a run (SUHT-I9)
			if (cur.said) bumped.said = cur.said;			// nor does it unsay what was said (UNBLOCK-27 R7)
			if (cur.unheard) bumped.unheard = cur.unheard;		// nor take back a receipt (UNBLOCK-27 R7c)
			var proposed = mergeLeases({ [tid]: bumped }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true, expiry: leaseMs(proposed[tid] && proposed[tid].expiry) }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
			if (res.why === 'unread') return { ok: false, why: 'unread' };	// unsealable, not a race: no retry
		}
		return { ok: false, why: 'exhausted' };
	}

	/// RAISE answered mark `key` to `n` in generation `gen` (r569). Monotone, so a raise a
	/// mark already covers writes nothing and answers ok. `seed` raises only a mark that is
	/// absent, retired or of another generation: the floor below an occasion not yet claimed.
	async function leaseMark(key, gen, n, cas, nowFn, seed) {
		var k = String(key);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			if (snap.unread) return { ok: false, why: 'unread' };
			var now = leaseNow(nowFn);
			var cur = snap.leases[k];
			if (markCovers(cur, gen, n) || (seed && liveMark(cur) && leaseMs(cur.gen) === leaseMs(gen))) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: true };
			}
			var proposed = mergeLeases({ [k]: markRecord(gen, n, now, cur) }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };
			if (res.why === 'unread') return { ok: false, why: 'unread' };
		}
		return { ok: false, why: 'exhausted' };
	}

	/// RETIRE every live mark whose key starts with `prefix`, but those named in `keep`
	/// (r569 A3): what they answered for -- a Diamond, an action, a folder -- is gone, and a
	/// mark is otherwise never drained. Read from this device's view first, so a call with
	/// nothing to retire costs no round trip.
	async function leaseRetire(prefix, keep, cas, nowFn) {
		var p = String(prefix), kept = keep || {};
		function doomed(m) {
			var out = {};
			Object.keys(m || {}).forEach(function (k) {
				if (k.indexOf(p) === 0 && !kept[k] && liveMark(m[k])) out[k] = m[k];
			});
			return out;
		}
		if (!Object.keys(doomed(_leases)).length) return { ok: true };
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			if (snap.unread) return { ok: false, why: 'unread' };
			var now = leaseNow(nowFn), gone = doomed(snap.leases), mine = {};
			Object.keys(gone).forEach(function (k) { mine[k] = retiredRecord(gone[k], now); });
			if (!Object.keys(mine).length) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: true };
			}
			var proposed = mergeLeases(mine, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };
			if (res.why === 'unread') return { ok: false, why: 'unread' };
		}
		return { ok: false, why: 'exhausted' };
	}

	/// Is a stand-down undecided, so that the errand stays on the relay for one more collect
	/// rather than being acked away? Standing down for the nominated runner or the addressee is, and so is a take
	/// that could not read the door or won no try at it, or a runner whose engine is poisoned and
	/// about to reload: nobody holds the turn, and a stand-down
	/// that dropped the errand would leave the sender to find out at its deadline. A stand-down
	/// for a live foreign claim, a settled or aged-out turn, or a refusal that will not change
	/// is decided, and the errand goes.
	function standDownUndecided(why) {
		return why === 'nominee' || why === 'addressee' || why === 'unread' || why === 'exhausted' || why === 'busy-hold'
			|| why === 'poisoned';
	}

	/// Is another live, idle, non-mobile, servicing desktop beside these, one that would
	/// claim a turn this busy device holds back from? `not` is this device's id, or a list:
	/// this device and the errand's sender, which never claims its own errand. With
	/// `before`, only a desk whose id sorts ahead of it counts (`busyHoldsFor`).
	function idleDeskBeside(presence, not, now, windowMs, before) {
		var p = presence || {}, w = windowMs || DISPATCH_FRESH_MS;
		var n = now == null ? Date.now() : now;
		var skip = (Array.isArray(not) ? not : [not]).map(function (x) { return String(x || ''); });
		var top  = before == null ? null : String(before);
		for (var id in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id) || skip.indexOf(id) >= 0) continue;
			if (top != null && !(id < top)) continue;
			var r = p[id];
			if (!r || recMobileView(r) || r.busy > 0) continue;
			// Listening, whatever its posture: a runner-posture desk that beats but has stopped
			// collecting never claims, so holding a row for it stalls the turn to the backstop.
			if (recGenuine(r, n, w)) return true;
		}
		return false;
	}

	/// Does a busy device hold an errand's row for an idle desk beside it, rather than hand
	/// the turn back? Only for a desk whose id sorts ahead of its own (r545, Q22).
	///
	/// A device that starts a turn reads idle to every other until its next beat lands, so
	/// two busy desktops can each read the other idle. Each used to hold the row for the
	/// other, nobody handed it back, and the sender waited out its 95 s backstop; `tried`
	/// could not help, as neither said no. The id order is one both compute alike: of busy
	/// desks that read each other idle, the first in it finds nobody ahead and hands back,
	/// the sender re-seats the turn with it in `tried`, and the next finds nobody ahead in
	/// turn. A desk that really is idle claims the row whatever its place, and a busy
	/// device ahead of it hands back early, which costs one re-seat, to that desk.
	function busyHoldsFor(presence, selfId, not, now, windowMs) {
		return idleDeskBeside(presence, [selfId].concat(not || []), now, windowMs, String(selfId || ''));
	}

	/// Run a lease write, and once more after a pause when the door would not read.
	/// Only an unread door is worth a second look: any other refusal is a fact.
	async function retryUnread(run) {
		var res = await run();
		if (res && res.ok === false && res.why === 'unread') {
			await new Promise(function (r) { setTimeout(r, UNREAD_RETRY_MS); });
			res = await run();
		}
		return res;
	}

	/// The done and released writes, for every exit that frees a lease. A refused one used to
	/// be ignored, leaving the lease 'running' to its deadline with the sender waiting it out,
	/// so the result is read: an unread door is tried once more, and a write that still failed
	/// is said. `what` names the errand in the diag line (`turn=<id>`, or `compile=<id>`).
	///
	/// `cut` marks a run that ended without finishing (the deadline, a poisoned engine): the
	/// record still settles, so it is never run again, and every device reads it Interrupted.
	///
	/// `deadAt`: the claim's deadline, so a record the door no longer holds before it answers
	/// `absent` (unknown) rather than `not_ours` (`leaseVerdict`).
	async function settleLease(what, id, holder, mode, cas, nowFn, cut, deadAt) {
		var r = await retryUnread(function () { return leaseSet(id, holder, mode, cas, nowFn, cut, deadAt); });
		if (!(r && r.ok)) diag('collect lease write', what + '=' + id + ' mode=' + mode
			+ ' ok=0 why=' + String((r && r.why) || '?'));
		return r;
	}

	/// Read the door, once more after a pause when it would not read (an unread snapshot, or
	/// a read that threw). Still unread: `{ unread: true }`. The confirm read after a claim
	/// landed uses it, and so does the restart sweep before it frees a lease.
	async function readTwice(cas) {
		for (var i = 0; i < 2; i++) {
			var snap = null;
			try { snap = await cas.read(); } catch (e) { snap = null; }
			if (snap && !snap.unread) return snap;
			if (i === 0) await new Promise(function (r) { setTimeout(r, UNREAD_RETRY_MS); });
		}
		return { unread: true };
	}

	/// COMPLETE (mode 'done') or RELEASE (mode 'released', which is vacant) a lease
	/// this device holds, with the act reported to the debug feed.
	async function leaseSet(turnId, holder, mode, cas, nowFn, cut, deadAt) {
		var res = await leaseSetCas(turnId, holder, mode, cas, nowFn, cut, deadAt);
		dsHandoff({
			act:  mode === 'released' ? 'release' : 'complete',
			turn: String(turnId).slice(0, 24),
			ok:   res && res.ok ? 1 : 0,
			why:  String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// What a turn's lease record says to the device that runs it, at `now` against the
	/// claim's deadline `deadAt` (0: none). One rule for the liveness read and for both of a
	/// run's end doors, so they cannot drift apart again (check_last F1):
	/// - `ours`: still held.
	/// - `stopped`: ours, released and settled -- the sender's Stop (`leaseRevokeCas` settle).
	/// - `released`: ours, released and not settled -- a take-back, the only revoke of the two.
	/// - `not_ours`: another holder, or no record past the deadline (expired and drained).
	/// - `absent`: no record before the deadline. Unknown, not revoked: a revoke is a positive
	///   record, never a deletion.
	function leaseVerdict(cur, selfId, now, deadAt) {
		if (!cur) return (deadAt > 0 && now <= deadAt) ? 'absent' : 'not_ours';
		if (cur.holder !== String(selfId)) return 'not_ours';
		if (cur.mode === 'released') return cur.settled ? 'stopped' : 'released';
		return 'ours';
	}

	/// The write itself. `release` is also how the phone takes a turn back from a
	/// live peer (§3.3): the peer's read-only liveness check sees it released and aborts.
	/// A refusal answers the record's `leaseVerdict` as its `why`.
	async function leaseSetCas(turnId, holder, mode, cas, nowFn, cut, deadAt) {
		var tid = String(turnId), h = String(holder);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			if (snap.unread) return { ok: false, why: 'unread' };		// unknown, never 'not_ours'
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			var verdict = leaseVerdict(cur, h, now, leaseMs(deadAt));
			// A RELEASED RECORD IS NO LONGER HELD (check_final D1). A take-back (`claimed` ->
			// `released`, holder unchanged) that the runner has not yet read would otherwise be
			// overwritten by its `done`, and the `released` after it then stamps `settled` and
			// the cut: the sender reads Interrupted with Retry while it runs the turn itself.
			// A settled one is the sender's Stop, which the run answers differently (`stopped`).
			if (verdict === 'not_ours' || verdict === 'absent'
				|| (mode === 'done' && (verdict === 'released' || verdict === 'stopped'))) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: false, why: verdict };
			}
			// THE PROOF OF COMPLETION, CARRIED IN THE LEASE. A released lease reads vacant
			// (`liveLease` false), so a peer whose `GET ?since=` was in flight can receive the
			// errand and the done report in one page, route the errand first and take the
			// freed lease -- a second run and a second charge (S-HAND #1, the narrow race).
			// So a done->released transition stamps `settled:1`; `leaseTakeFromCas` reads it
			// before it takes and stands down. A release from a PARK (`running`->`released`)
			// or a take-back / undeliverable hand-back (`claimed`->`released`) is NOT a
			// completion, so it never sets it -- a parked re-dispatch still claims. Once set,
			// it is preserved (`cur.settled | 0`), and it survives every merge because
			// `pickLease`/`clampExpiry` carry whole records rather than rebuilding fields.
			var next = {
				turnId: tid, eid: cur.eid, holder: h, dispatchedBy: String(cur.dispatchedBy || ''),
				mode: mode, deadline: leaseMs(cur.deadline),
				// AFTER the record it replaces, even within one millisecond: the merge below
				// keeps the door's copy on a same-holder tie, which silently dropped a `done`
				// written in the millisecond of the renew, so the release that followed it
				// was never `settled` (check_f234 fix 1, seen on a frozen test clock).
				expiry: mode === 'released' ? 0 : cur.expiry, renewedAt: Math.max(now, leaseMs(cur.renewedAt) + 1),
				settled: (mode === 'released' && cur.mode === 'done') ? 1 : (cur.settled | 0),
			};
			// THE CUT MARK (check_f234 fix 1): kept once written, as `settled` is.
			var cutMark = String(cut || cur.cut || '');
			if (cutMark) next.cut = cutMark;
			if (cur.ending) next.ending = 1;				// held to end, never a run (SUHT-I9)
			var proposed = mergeLeases({ [tid]: next }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
			if (res.why === 'unread') return { ok: false, why: 'unread' };	// unsealable, not a race: no retry
		}
		return { ok: false, why: 'exhausted' };
	}

	/// REVOKE a turn's lease whoever holds it -- the phone's take-back (§3.3). Unlike
	/// `release`, which is the holder letting go, this vacates a lease held by a
	/// DIFFERENT device: the running peer's read-only liveness check reads
	/// `mode:'released'` and hard-aborts its turn. CAS-written, so it races the peer
	/// cleanly. `renewedAt` is stamped now so the same-holder merge keeps the released
	/// record over the peer's live one.
	///
	/// `opts.settle` is a STOP rather than a rescue (D-20261011-21): the record is stamped
	/// `settled:1`, so every take refuses it and no backstop, recovery or other collector
	/// runs the turn again, and every device reads it finished.
	async function leaseRevoke(turnId, cas, nowFn, opts) {
		var settle = !!(opts && opts.settle);
		var res = await leaseRevokeCas(turnId, cas, nowFn, null, settle);
		dsHandoff({
			act:  settle ? 'stop' : 'rescue',
			turn: String(turnId).slice(0, 24),
			ok:   res && res.ok ? 1 : 0,
			why:  String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// VACATE the claim `holder` took for errand `eid`, and only that claim, only while it has
	/// not started: the sender's half of a hand-back (hand-off QA F7, 2026-09-25). A runner
	/// reports `undeliverable` from its reconstruct, before anything runs, and releases its
	/// lease after; one that died between the two held the turn to the errand's deadline, and
	/// [Run here] with it. The report is the runner's word that it stopped, so the sender
	/// does the release itself. A claim that moved on -- another holder, another errand, or
	/// `running` -- is left alone and answered `{ ok: false, why }`.
	async function leaseReclaim(turnId, holder, eid, cas, nowFn) {
		var h = String(holder || ''), id = String(eid || '');
		var res = await leaseRevokeCas(turnId, cas, nowFn, function (cur) {
			if (!h || cur.holder !== h) return 'holder';
			if (String(cur.eid || '') !== id) return 'eid';
			return cur.mode === 'claimed' ? '' : cur.mode;
		});
		dsHandoff({
			act:  'reclaim',
			turn: String(turnId).slice(0, 24),
			ok:   res && res.ok ? 1 : 0,
			why:  String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// The write itself. `guard(cur)` answers '' to go on, or why to stand down; `settle`
	/// stamps the revoked record `settled:1` (a Stop: the turn is finished, never re-run).
	async function leaseRevokeCas(turnId, cas, nowFn, guard, settle) {
		var tid = String(turnId);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			if (snap.unread) return { ok: false, why: 'unread' };		// not 'already vacant'
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			// Already vacant, but the view has not heard: the runner's release landed and this
			// device has yet to pull it, so `continueTurn` would still read a peer-held lease
			// and do nothing. Adopt what the door says.
			if (!cur || (cur.mode === 'released' && (!settle || cur.settled))) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: true };
			}
			var stop = guard ? guard(cur) : '';
			if (stop) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: false, why: stop };
			}
			// `renewedAt` at least the current record's, so the same-holder merge's
			// released-wins tie-break (or a strictly-greater renew) always keeps this
			// over the peer's live running record -- a fast-clock peer cannot outbid it.
			var revoked = {
				turnId: tid, eid: cur.eid, holder: cur.holder, dispatchedBy: String(cur.dispatchedBy || ''),
				mode: 'released', expiry: 0, deadline: leaseMs(cur.deadline),
				renewedAt: Math.max(now, leaseMs(cur.renewedAt)),
			};
			if (settle || cur.settled) revoked.settled = 1;	// STOP-ON-PEER: a stopped turn is never re-run
			if (cur.ending) revoked.ending = 1;				// held to end, never a run (SUHT-I9)
			// Settling a record already released: one ms on, so the same-holder merge (whose
			// released-vs-released tie goes to the incoming copy) keeps the stamp.
			if (settle && cur.mode === 'released') revoked.renewedAt = Math.max(now, leaseMs(cur.renewedAt) + 1);
			var proposed = mergeLeases({ [tid]: revoked }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
			if (res.why === 'unread') return { ok: false, why: 'unread' };	// unsealable, not a race: no retry
		}
		return { ok: false, why: 'exhausted' };
	}

	// ════════════════════════════════════════════════════════════
	// WHAT HE SAID INTO A TURN ANOTHER DEVICE RUNS (UNBLOCK-27 R7).
	// ------------------------------------------------------------
	// "50 min? to ocr 7 pages??!!!": his "put it together now" waited for the turn it
	// was meant to end. A word said on the device that sent a turn rides the turn's
	// LEASE RECORD, as the blocker and the Stop do, for their reasons: every device
	// already reads it, the runner already reads it between rounds (the liveness
	// read), and it is CAS-arbitrated. Each word carries the id it was said as, so
	// the runner delivers it once whatever number of devices write or re-read it.
	// ════════════════════════════════════════════════════════════
	var SAID_MAX = 8;				// words waiting on one turn
	var SAID_TEXT_MAX = 4000;			// characters in one, so the door stays small

	/// SAY `said` ({ id, text, pre }) into the turn `turnId` another device holds, for its
	/// runner to deliver at its next seam. `{ ok: true }` once the door holds it (and for
	/// an id it already holds); `{ ok: false, why }` where nothing is running to hear it,
	/// so the caller queues the words instead.
	async function leaseSay(turnId, said, cas, nowFn) {
		var tid = String(turnId || ''), id = String((said && said.id) || '');
		var text = String((said && said.text) || '').trim();
		if (!tid || !id || !text) return { ok: false, why: 'empty' };
		if (text.length > SAID_TEXT_MAX) return { ok: false, why: 'too_long' };
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			if (snap.unread) return { ok: false, why: 'unread' };
			var now = leaseNow(nowFn);
			var cur = snap.leases[tid];
			// A turn held only to end it can hear nothing (I9-LOWS LOW-4).
			if (!cur || isMark(cur) || !liveLease(cur, now) || endingLease(cur)
				|| (cur.mode !== 'claimed' && cur.mode !== 'running')) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: false, why: 'not_running' };
			}
			var list = Array.isArray(cur.said) ? cur.said.slice() : [];
			if (list.some(function (x) { return x && String(x.id) === id; })) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: true };
			}
			if (list.length >= SAID_MAX) return { ok: false, why: 'full' };
			list.push({ id: id, text: text, pre: String((said && said.pre) || '') });
			var next = {};
			Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
			next.said = list;
			// After the runner's own copy, so the same-holder merge keeps this one everywhere.
			next.renewedAt = Math.max(now, leaseMs(cur.renewedAt) + 1);
			var proposed = mergeLeases({ [tid]: next }, snap.leases, now);
			if (!proposed[tid] || !Array.isArray(proposed[tid].said) || proposed[tid].said.length !== list.length) continue;
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };
			if (res.why === 'unread') return { ok: false, why: 'unread' };
		}
		return { ok: false, why: 'exhausted' };
	}

	/// The runner's RECEIPT for words said into its turn too late for it to hear them
	/// (UNBLOCK-27 R7c): the turn had no model round left, its answer already being
	/// written. Their ids join the lease's `unheard` list, which the sender reads off the
	/// lease view and sends each as the next turn at once, rather than waiting for the
	/// report at the turn's end. Only the holder writes it, and only on a live run.
	async function leaseUnheard(turnId, ids, holder, cas, nowFn) {
		var tid = String(turnId || ''), h = String(holder || '');
		var add = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
		if (!tid || !h || !add.length) return { ok: false, why: 'empty' };
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			if (snap.unread) return { ok: false, why: 'unread' };
			var now = leaseNow(nowFn);
			var cur = snap.leases[tid];
			if (!cur || isMark(cur) || cur.holder !== h || (cur.mode !== 'claimed' && cur.mode !== 'running')) {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: false, why: 'not_ours' };
			}
			var list = Array.isArray(cur.unheard) ? cur.unheard.map(String) : [];
			var fresh = add.filter(function (id) { return list.indexOf(id) === -1; });
			if (!fresh.length) { leaseWrite(mergeLeases(_leases, snap.leases, now)); return { ok: true }; }
			list = list.concat(fresh).slice(-SAID_MAX * 2);
			var next = {};
			Object.keys(cur).forEach(function (k) { next[k] = cur[k]; });
			next.unheard = list;
			next.renewedAt = Math.max(now, leaseMs(cur.renewedAt) + 1);
			var proposed = mergeLeases({ [tid]: next }, snap.leases, now);
			if (!proposed[tid] || !Array.isArray(proposed[tid].unheard) || proposed[tid].unheard.length !== list.length) continue;
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };
			if (res.why === 'unread') return { ok: false, why: 'unread' };
		}
		return { ok: false, why: 'exhausted' };
	}

	// ════════════════════════════════════════════════════════════
	// THE BLOCKER — what is stopping the runner, carried to every device.
	// ------------------------------------------------------------
	// Owner ruling 2026-09-12: a blocker raised on the RUNNER -- a permission
	// popup, a question, a lock -- must be copied to the originating device and
	// to every other device, cleared everywhere by the FIRST to respond, with
	// the runner keeping local control. The originating user must never see a
	// hanging turn.
	//
	// It rides the LEASE RECORD and not a new channel, for three reasons. The
	// lease is already the one thing every device reads about a handed-off turn
	// (`adoptLeaseDoor` folds it into an ordinary pull, so a watching phone sees
	// it with no new request); it is already CAS-arbitrated, so two devices
	// cannot write contradictory blockers; and it already dies with the turn --
	// a released lease carries no blocker, so a stale question cannot outlive
	// the thing it was blocking. The ANSWER travels the other way over the
	// relay, reusing the consent-grant envelope (`makeGrant`, now carrying a
	// `kind` and, for an `ask`, the `choice`), so there is no second transport
	// and no second first-wins rule: `grantDecision` is still the arbiter.
	//
	// FIVE KINDS, two of them report-only:
	//   consent   -- a per-turn permission the runner is holding a dialog on.
	//                Answerable anywhere: grant or deny.
	//   ask       -- the `ask` TOOL's question, with its options. Answerable
	//                anywhere, because answering it is only sending the chat's
	//                next message.
	//   fsa       -- File System Access wants a click. NOT answerable remotely:
	//                `requestPermission` needs a user gesture ON the runner, so
	//                the tile REPORTS it and offers to run the turn here instead.
	//   lock      -- the runner is locked (or reloaded mid-turn). Report-only.
	//   provider  -- the model provider refused (401/402, out of credit).
	//                Report-only; the turn is handed back.
	// ════════════════════════════════════════════════════════════

	var BLOCKER_KINDS = ['consent', 'ask', 'fsa', 'lock', 'provider', 'place', 'toolkit', 'run', 'change'];

	// ── Permits: the three engine questions a hand-off routes home ──
	//
	// CONSENT-ROUTE (10 Oct). A write outside the Diamond (`place`), a toolkit on first use
	// (`toolkit`) and a command in the ask mode (`run`) were asked as a dialog on the RUNNER,
	// a machine nobody is at, so a handed-off turn sat there until B's own deadline or for
	// ever. They are now asked on the device the turn was sent from, through the consent
	// relay, and answered allow/deny under their own kind. A yes grants THIS TURN only: the
	// engine's turn-scoped allow, never a mark (a mark is in force only where it was pressed,
	// markshere.js R2), save the toolkit, which the answering device writes to the Diamond.
	// UNBLOCK-26 U5: `change` -- an edit, delete or move of a file he made, shown as a
	// diff and asked of him alone; the autonomous setting never answers it.
	var PERMIT_ASKS = ['place', 'toolkit', 'run', 'change'];
	var PERMIT_YES = { place: 'allow-place', toolkit: 'allow-kit', run: 'allow', change: 'allow-change' };
	// Why a permit was not granted, as the asking device is told it.
	var PERMIT_WHYS = ['refused', 'timeout', 'unsupported'];
	// The engine's word for each, so the model is told the same reason the person is
	// (tools.rs `permit_of`): only a refusal is the user's no.
	var PERMIT_NO_WORD = { refused: 'deny', timeout: 'deny-timeout', unsupported: 'deny-unasked' };

	// The engine's word for a permit nobody was at THIS device to be asked (a local turn
	// with the page hidden and no one answering): not the user's no either.
	var PERMIT_ABSENT_WORD = 'deny-absent';

	/// The engine's word for a permit not granted for `why`; an unknown reason is a plain no.
	function permitNoWord(why) { return PERMIT_NO_WORD[String(why || '')] || 'deny'; }

	/// Is `k` one of the three permit questions?
	function permitAsk(k) { return PERMIT_ASKS.indexOf(String(k || '')) >= 0; }

	/// The permit kinds named in `a`, known ones only, each once.
	function askList(a) {
		var out = [];
		(Array.isArray(a) ? a : []).forEach(function (k) {
			k = String(k || '');
			if (permitAsk(k) && out.indexOf(k) < 0) out.push(k);
		});
		return out;
	}

	/// Where a runner may put a permit question, or why it may not. Pure.
	///
	/// `route` is `consentRouteDecision`'s answer; `source` the device the turn was sent
	/// from; `asks` what that device's errand said it can answer. The question goes to the
	/// SOURCE alone, the person's device: another attended device's build is unknown, and
	/// one that predates permits would draw the question as a "reach" tile. So a source
	/// that cannot answer is `unsupported`, and so is a source not awake: the question was
	/// never put to anybody, so nobody "did not answer in time" (B-F3). Never a park.
	function permitRouteDecision(kind, route, source, asks) {
		var src = String(source || '');
		if (!permitAsk(kind)) return { action: 'refuse', why: 'unsupported' };
		if (askList(asks).indexOf(String(kind)) < 0) return { action: 'refuse', why: 'unsupported' };
		var r = route || {};
		if (r.action !== 'ask' || !r.peer || String(r.peer.deviceId || '') !== src || !src) {
			return { action: 'refuse', why: 'unsupported' };
		}
		return { action: 'ask', target: src };
	}

	/// The engine's word for a permit's answer, and why. `verdict` is what the wait
	/// resolved with: 'allow', 'deny', or null when the deadline passed.
	function permitOutcome(kind, verdict) {
		if (verdict === 'allow') return { word: PERMIT_YES[kind] || 'deny', why: '' };
		var why = verdict === 'deny' ? 'refused' : 'timeout';
		return { word: permitNoWord(why), why: why };
	}

	/// Is this grant a runner telling THIS device why its permit was not granted?
	/// Answers the reason, or ''. The runner's own copy is not news to it.
	function permitNotice(grant, selfId) {
		var g = grant || {};
		if (!permitAsk(g.kind) || g.verdict === 'allow') return '';
		if (PERMIT_WHYS.indexOf(String(g.choice || '')) < 0) return '';
		var me = String(selfId || '');
		if (!me || String(g.by || '') === me) return '';
		if (g.to && String(g.to) !== me) return '';
		return String(g.choice);
	}

	/// Does this grant settle `ask` on a device that holds it? A permit is answered by its
	/// target alone (`blockerAnswerDecision`), so only the target's answer, or the runner's
	/// own word on it, takes the question down; a third device's grant, which the runner
	/// drops, must not dismiss the question where it was asked and leave it to time out.
	/// Any other ask keeps the broadcast rule: the first answer anywhere settles it.
	function grantSettlesAsk(ask, grant) {
		var a = ask || null, g = grant || {};
		if (!a || !permitAsk(a.kind)) return true;
		var by = String(g.by || '');
		if (!by) return false;
		return by === String(a.target || '') || by === String(a.dispatchedBy || '');
	}

	// A blocker is read by a human on another device, so its text is capped where
	// it is built rather than where it is drawn: the lease door has a 64 KiB
	// ceiling (gateway LEASE_MAX_BYTES, guarded client-side by DaimondWire.fits(
	// 'lease', …) before the CAS) shared by every turn's record, and a runaway
	// `detail` -- a whole page of typed text -- would push a live lease map over it
	// and fail the CLAIM, not merely the blocker.
	var BLOCKER_DETAIL_MAX  = 600;	// the exact string being authorised, cut with an ellipsis
	var BLOCKER_OPTIONS_MAX = 4;	// `ask` offers two to four; the tool refuses more
	var BLOCKER_LABEL_MAX   = 80;

	/// Is `k` a blocker kind this layer knows? An unknown kind is NOT drawn with
	/// controls -- see `blockerTileSpec` -- so a newer runner's blocker degrades to
	/// a report on an older device rather than to a button that does nothing.
	function blockerKind(k) {
		return BLOCKER_KINDS.indexOf(String(k || '')) >= 0;
	}

	/// Build a blocker record for the lease. `detail` is the uncut thing a human
	/// must read, cut HERE to a readable length; `options` is the `ask` tool's
	/// option list, reduced to labels because a remote tile answers by label and
	/// the means/recommendation are already in the runner's own card. `since` is
	/// when the runner became blocked, so a tile can say how long it has waited.
	function makeBlocker(f) {
		var o = f || {};
		var detail = String(o.detail == null ? '' : o.detail);
		if (detail.length > BLOCKER_DETAIL_MAX) detail = detail.slice(0, BLOCKER_DETAIL_MAX) + '…';
		var out = {
			kind:   blockerKind(o.kind) ? String(o.kind) : 'lock',
			detail: detail,
			since:  +o.since || Date.now(),
		};
		// `cid` names the question the answer must quote, so a grant for a blocker
		// the runner has already cleared authorises nothing (`grantDecision`).
		if (o.cid)  out.cid  = String(o.cid);
		if (o.tool) out.tool = String(o.tool);
		if (o.host) out.host = String(o.host);
		if (o.about && permitAsk(out.kind)) out.about = String(o.about).slice(0, BLOCKER_DETAIL_MAX);
		// A permit names the one device that may answer it (the ask's `target`).
		if (o.target && permitAsk(out.kind)) out.target = String(o.target);
		if (Array.isArray(o.options) && o.options.length) {
			out.options = o.options.slice(0, BLOCKER_OPTIONS_MAX).map(function (op) {
				var lab = (op && typeof op === 'object') ? op.label : op;
				return String(lab == null ? '' : lab).slice(0, BLOCKER_LABEL_MAX);
			}).filter(function (s) { return !!s; });
			if (!out.options.length) delete out.options;
		}
		return out;
	}

	/// Can a blocker of this kind be ANSWERED from another device, or only
	/// reported there? `fsa` needs a user gesture on the runner's own page
	/// (`requestPermission` is refused without one) and `lock`/`provider` are facts
	/// about the runner that no answer elsewhere changes -- so those three offer
	/// "Run here instead" and nothing that pretends to reach across.
	function blockerAnswerable(kind) {
		return kind === 'consent' || kind === 'ask' || permitAsk(kind);
	}

	/// What a device should DRAW for a blocker, as data rather than as text: the
	/// renderer owns the words (daimond.js, literal `t()` keys so
	/// `dev/i18ncheck.mjs` can read each one out of the source) and this owns the
	/// shape. Pure, so the decision a tile makes is under test without a DOM.
	///
	/// `controls` is the ordered list of what the tile offers:
	///   'grant' / 'deny'  -- a consent, answerable here;
	///   'choose'          -- one button per `options` entry, answerable here;
	///   'runhere'         -- release the lease and re-seat locally (report-only).
	/// An unknown kind draws as a report with 'runhere', never as a dead button.
	/// A permit is answerable only on its `target`, the device the turn was sent from
	/// (`selfId` is the drawing device): anywhere else it is reported and offers nothing,
	/// the same rule `askRaiseDecision` keeps for the tile and `blockerAnswerDecision`
	/// keeps on the runner.
	function blockerTileSpec(blocker, name, selfId) {
		var b = blocker || {};
		var kind = blockerKind(b.kind) ? String(b.kind) : '';
		var spec = {
			kind:      kind || 'unknown',
			name:      String(name || ''),
			detail:    String(b.detail || ''),
			tool:      String(b.tool || ''),
			host:      String(b.host || ''),
			about:     String(b.about || ''),
			target:    String(b.target || ''),
			options:   Array.isArray(b.options) ? b.options.slice(0, BLOCKER_OPTIONS_MAX) : [],
			since:     +b.since || 0,
			answerable: blockerAnswerable(kind),
			controls:  [],
		};
		if (permitAsk(kind) && (!spec.target || spec.target !== String(selfId || ''))) {
			spec.answerable = false;						// not this device's question
		}
		// A change is answered only on its Pending tile, where the change is drawn: a bare
		// Allow under a cut-short quote would be a yes to a diff nobody saw (UNBLOCK-26 U5).
		else if (kind === 'change')                      spec.controls = [];
		else if (kind === 'consent' || permitAsk(kind))  spec.controls = ['grant', 'deny'];
		else if (kind === 'ask' && spec.options.length)  spec.controls = ['choose'];
		else                                             spec.controls = ['runhere'];
		return spec;
	}

	/// The live blocker on a turn, or null. A blocker on a lease that is no longer
	/// live grants nothing and is not shown: the question died with the turn.
	function blockerOf(turnId, now) {
		var r = _leases[String(turnId)];
		if (!liveLease(r, now == null ? authorityNow() : now)) return null;
		return (r && r.blocker && blockerKind(r.blocker.kind)) ? r.blocker : null;
	}

	/// WRITE (or clear) the blocker on a lease this device holds, through the SAME
	/// compare-and-set the claim went through. `blocker` null clears it.
	///
	/// Only the HOLDER may write: a watching device that tried would be refused
	/// `not_ours`, which is what stops two devices describing one turn differently.
	/// Mode, deadline and expiry are carried forward untouched -- a blocker is not a
	/// state change, so it must not shorten a claim or turn `running` back into
	/// `claimed` -- and `renewedAt` is stamped now so the same-holder merge keeps
	/// this over the runner's own earlier record on every other device.
	async function leaseBlockCas(turnId, holder, blocker, cas, nowFn) {
		var tid = String(turnId), h = String(holder);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			if (!cur || cur.holder !== h || cur.mode === 'released') {
				leaseWrite(mergeLeases(_leases, snap.leases, now));
				return { ok: false, why: 'not_ours' };
			}
			var next = {
				turnId: tid, eid: cur.eid, holder: h, dispatchedBy: String(cur.dispatchedBy || ''),
				mode: cur.mode, deadline: leaseMs(cur.deadline), expiry: cur.expiry,
				renewedAt: Math.max(now, leaseMs(cur.renewedAt) + 1),
			};
			if (blocker) next.blocker = makeBlocker(blocker);
			if (cur.ending) next.ending = 1;				// held to end, never a run (SUHT-I9)
			if (cur.said) next.said = cur.said;			// what was said into the turn waits on (UNBLOCK-27 R7)
			if (cur.unheard) next.unheard = cur.unheard;		// and so does the runner's receipt (UNBLOCK-27 R7c)
			var proposed = mergeLeases({ [tid]: next }, snap.leases, now);
			// The merge keeps the record it judges fresher; a proposal that lost is a
			// sibling writing the same lease, so re-read and try again rather than
			// pushing a record the merge has already discarded.
			if (!proposed[tid] || proposed[tid].holder !== h) continue;
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { leaseWrite(proposed); return { ok: true, blocked: !!blocker }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
			if (res.why === 'unread') return { ok: false, why: 'unread' };	// unsealable, not a race: no retry
		}
		return { ok: false, why: 'exhausted' };
	}

	/// Raise a blocker, with the act reported to the debug feed.
	async function leaseBlock(turnId, holder, blocker, cas, nowFn) {
		var res = await leaseBlockCas(turnId, holder, blocker, cas, nowFn);
		dsHandoff({
			act:  'block',
			turn: String(turnId).slice(0, 24),
			kind: String((blocker && blocker.kind) || '').slice(0, 10),
			ok:   res && res.ok ? 1 : 0,
			why:  String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// Clear the blocker, whatever it was.
	async function leaseUnblock(turnId, holder, cas, nowFn) {
		var res = await leaseBlockCas(turnId, holder, null, cas, nowFn);
		dsHandoff({
			act:  'unblock',
			turn: String(turnId).slice(0, 24),
			ok:   res && res.ok ? 1 : 0,
			why:  String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// The FIRST-ANSWER-WINS rule for a blocker answer arriving at the runner.
	/// `pending` is the runner's awaiting record (`{ turnId, kind }`) or null --
	/// SPENT by the caller in the same synchronous step it reads it, exactly as
	/// `grantDecision`'s is, so a second answer for one blocker finds nothing and
	/// is a no-op. `answer` is the grant envelope.
	///
	/// It is `grantDecision` with the two blocker fields added: the KIND must match
	/// what the runner is actually blocked on (an `ask` answer cannot resolve a
	/// consent), and an `ask` answer must carry a choice. A dropped answer costs the
	/// runner its deadline, never a wrong act.
	function blockerAnswerDecision(pending, answer) {
		var a = answer || {};
		var d = grantDecision(pending, a);
		if (!d.commit) return d;
		var want = String(pending.kind || 'consent');
		var got  = String(a.kind || 'consent');
		// A permit is answered by its target alone: a third device that has the chat
		// open, at any build, authorises nothing and refuses nothing, so the question
		// stays with the person it was asked of.
		if (permitAsk(want) && (!pending.target || String(a.by || '') !== String(pending.target))) {
			return { commit: false, drop: true, why: 'not-target' };
		}
		// A PERMIT answered as a plain consent came from a device that cannot know what it
		// agreed to (a build that predates permits drew it as "reach"), so it is a no, at
		// once, rather than a drop that holds the turn to its deadline.
		if (permitAsk(want) && got === 'consent') return { commit: true, kind: want, verdict: 'deny', why: 'old-answerer' };
		if (want !== got) return { commit: false, drop: true, why: 'kind-mismatch' };
		if (want === 'ask') {
			var choice = String(a.choice == null ? '' : a.choice).trim();
			if (!choice) return { commit: false, drop: true, why: 'no-choice' };
			return { commit: true, kind: 'ask', choice: choice, why: 'first-committed' };
		}
		return { commit: true, kind: want, verdict: d.verdict, why: d.why };
	}

	/// Should THIS device, on boot, RELEASE a `running` lease it finds under its own
	/// name? Pure, and the answer to the hang the owner reported: a runner that
	/// locked or reloaded mid-turn left its own lease claimed to the errand deadline
	/// (~15 min), `recoverDecision` read a live foreign lease and stood down, and the
	/// originator watched a spinner for a quarter of an hour.
	///
	/// A lease is OURS and STALE when it is live, held by this device, not released,
	/// and no turn of that id is running here -- which on a fresh page load is every
	/// lease this device holds, because a turn is memory and the page has just
	/// started. `running` names the set: `running[turnId]` truthy means the turn is
	/// genuinely in flight here. It is one tab's memory, so it cannot see a turn a
	/// sibling tab is running (F2): daimond.js `releaseOwnStaleLeases` takes the turn's
	/// work claim (`turnWorkKey`) before it frees anything this answers.
	function staleOwnLeaseDecision(leases, selfId, running, now) {
		var out = [], map = leases || {}, live = running || {};
		var self = String(selfId || ''), n = now == null ? Date.now() : now;
		if (!self) return out;
		for (var tid in map) {
			if (!Object.prototype.hasOwnProperty.call(map, tid)) continue;
			var r = map[tid];
			if (!liveLease(r, n)) continue;
			if (String(r.holder) !== self) continue;	// a peer's lease is never ours to free
			if (live[tid]) continue;					// genuinely running here
			out.push(String(tid));
		}
		return out;
	}

	/// Classify an error a runner's turn threw, so a failure the RUNNER cannot
	/// recover from is handed back instead of counting as a silent crash.
	///
	/// A genuine crash is deliberately left to expire (the relay keeps the errand
	/// and the phone reclaims), but three failures are not crashes and the old
	/// reading of them cost the originator the whole deadline:
	///   'provider'  -- the model provider refused the key or the credit (401, 402,
	///                  "insufficient credits"). Re-running on this device would
	///                  refuse identically, so there is nothing to wait for.
	///   'fsa'       -- the folder grant was withdrawn or declined. Another device
	///                  may well hold its own grant, so hand it back at once.
	///   'lock'      -- Daimond locked under the turn; nothing can be sealed.
	/// Anything else is `null`: unchanged behaviour, the errand stays on the relay.
	function runnerErrorKind(err) {
		// A person's pause, landing on this device between the take and the turn: the
		// refusal carries `paused` (models.js `pauseError`), and it is theirs, not a crash
		// to leave pinned to the deadline (R2 QA, F2).
		if (err && err.paused) return 'paused';
		var msg = String((err && (err.message || err.why)) || err || '');
		var code = +((err && (err.status || err.code)) || 0);
		if (code === 401 || code === 402) return 'provider';
		if (/\b(401|402)\b/.test(msg)) return 'provider';
		if (/insufficient\s+credit|out\s+of\s+credit|no\s+credit\s+remaining/i.test(msg)) return 'provider';
		if (/invalid\s+api\s+key|unauthori[sz]ed|api\s+key\s+(is\s+)?(missing|invalid)/i.test(msg)) return 'provider';
		if (/permission\s+(was\s+)?(not\s+granted|denied)|folder\s+access|lost\s+access\s+to\s+the\s+folder/i.test(msg)) return 'fsa';
		if (/\bis\s+locked\b|Daimond\s+is\s+locked/i.test(msg)) return 'lock';
		return null;
	}

	/// The sentence a handed-back failure carries home, by kind. One line, for the
	/// originator's tile -- it is the whole of what they are told, so it says what
	/// happened, where, and that the turn is theirs again.
	///
	/// A pause is the one kind that brings its own sentence: the refusal already names the
	/// Diamond or chat and the play that resumes it, so `err`'s message goes home as it is.
	function runnerErrorWhy(kind, name, err) {
		if (kind === 'paused' && err && err.message) return String(err.message);
		var who = String(name || '') || 'the other device';
		if (kind === 'provider') return 'The AI provider refused the turn on ' + who
			+ ' -- its key or its credit. Nothing was spent; run it here or top up.';
		if (kind === 'fsa')      return who + ' no longer has access to the folder this turn needs, '
			+ 'so it handed the turn back.';
		if (kind === 'lock')     return who + ' locked while this turn was running, so it handed the turn back.';
		return 'The turn stopped on ' + who + ' and was handed back.';
	}

	/// Stage a leases section as the local view, for the sync shim ONLY: the CAS
	/// `commit` installs the proposed section here so the next `DaimondSync.push`
	/// sends it. Everything else reaches `_leases` through `adopt`/`take`/`renew`.
	function leaseInstall(leases) { leaseWrite(leases || {}); }

	/// Drop the local view, for a test or an account switch.
	function leaseForget() { leaseWrite({}); }

	// The lease section provider, attached like pause.js so sync.js finds it by the
	// same `snapshot`/`adopt` contract every other section keeps.
	window.DaimondLease = {
		LEASE_TTL_MS:      LEASE_TTL_MS,
		RENEW_EVERY_MS:    RENEW_EVERY_MS,
		MAX_LEASE_LIFE_MS: MAX_LEASE_LIFE_MS,
		/// The gateway-corrected clock every lease age/expiry check must use in place
		/// of a raw `Date.now()` (SIM-4). Published so a caller that judges liveness
		/// directly, rather than through a `nowFn` a lease call takes, can still reach
		/// the authority clock rather than reaching for its own raw one.
		authorityNow: authorityNow,
		/// The named take-if-vacant merge for one turnId and for the whole section.
		/// Published so sync.js and a verifier drive the ONE implementation.
		mergeOne:  mergeOneLease,
		merge:     mergeLeases,
		live:      liveLease,
		/// Is a record vacant and past every copy's last-live moment by a TTL? The
		/// drain predicate `mergeLeases` applies; published for the drain test.
		dead:      deadLease,
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
		/// Is this device running a turn for anybody? The question `holder` cannot
		/// answer, because it takes a turnId and the asker has none.
		heldBy:    leaseHeldBy,
		/// The lifecycle over a compare-and-set.
		take:      leaseTake,
		/// TAKE from a snapshot already read -- lets a test race two takes from ONE
		/// base version, which is the concurrency the lease exists to arbitrate.
		takeFrom:  leaseTakeFrom,
		renew:     leaseRenew,
		/// The answered mark: raise it, and does a record cover an occasion?
		mark:      leaseMark,
		retire:    leaseRetire,
		covers:    markCovers,
		complete:  function (turnId, holder, cas, nowFn) { return leaseSet(turnId, holder, 'done', cas, nowFn); },
		release:   function (turnId, holder, cas, nowFn) { return leaseSet(turnId, holder, 'released', cas, nowFn); },
		/// The phone's take-back: revoke whoever holds the lease (§3.3).
		revoke:    leaseRevoke,
		reclaim:   leaseReclaim,
		/// THE BLOCKER: raise what is stopping the runner onto its own lease record,
		/// clear it when it is answered, and read the live one off a turn. Only the
		/// holder may write; every device reads.
		block:     leaseBlock,
		unblock:   leaseUnblock,
		/// Words said into a turn another device runs, delivered there once (UNBLOCK-27 R7).
		say:       leaseSay,
		/// The runner's receipt for words its turn could no longer hear (UNBLOCK-27 R7c).
		unheard:   leaseUnheard,
		blocker:   blockerOf,
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
	///   selfName     this device's label, for the sentence a handed-back failure
	///                carries home ("The AI provider refused the turn on argonaut");
	///                absent reads as "the other device";
	///   cas          the lease CAS (`syncCas` over the real sync);
	///   pauseHold    optional (errand) -> { node, why } | null: a person's pause holding
	///                the turn, on this device's set merged with the errand's `pause`;
	///                answered before the take. Absent -> no pause is asked here;
	///   reconstruct  async (errand) -> ctx: pull to >= parcelVersion, find the chat,
	///                `scopeChatTo`, fetch chunks;
	///   runTurn      async (ctx, prompt, { onProgress }): the ordinary turn engine,
	///                calling `onProgress` on journal events so the lease renews;
	///   abort        (): hard-stop the in-flight turn (`chat.app.abort`);
	///   pushResult   async () -> version: `captureSession` + parcel push (append merge).
	///                Called LAST and NOT awaited (see step 4), so nothing the
	///                originator is watching is behind it;
	///   finalFrame   optional async (turnId) -> tail: send the turn's WHOLE rendered
	///                tail as the last frame on the progress door, marked `final`, so
	///                the originating device shows the finished answer without waiting
	///                for the parcel. Absent -> the parcel is the first sight of it,
	///                which is what a runner on an older build does;
	///   awaitPush    optional: await the parcel push before answering, so a test can
	///                assert the whole sequence. Production leaves it off;
	///   pushProgress optional async (turnId) -> at: stream the RUNNING turn's
	///                transcript tail to the progress door on a timer, so a peer
	///                watching the hand-off sees it unfold. ONE SMALL FRAME per tick,
	///                keyed by the turn -- no new turn, no new lease, no second
	///                charge, and not the account parcel (which travels once, at the
	///                end, through `pushResult`). A no-op answering 0 when the tail
	///                has not changed; otherwise the `frameNow` time the frame was
	///                handed to the door, which the cadence is kept from.
	///                Absent (runner-acceptance, tests) -> no streaming, no timer;
	///   frameNow     optional () -> ms: the clock of `pushProgress`'s answer
	///                (default Date.now; NOT `now`, which is the lease clock).
	///   post         async (reportEnvelope): post the report;
	///   ack          async (): `DaimondPost.ack`, AFTER the push committed;
	///   now          optional clock, for tests.
	///
	/// Answers `{ ran, done?, aborted?, error?, why?, holder?, trace }`. `trace` is
	/// the ordered side effects, so a test asserts the sequence rather than guessing.
	///
	/// PARK — abandon and re-run, never resume (there is no mid-turn checkpoint). When
	/// a per-turn consent could not be answered (no attended device, or the wait timed
	/// out), egressAllowed on the runner records the intent and aborts the turn; this
	/// runner then parks. Park REPORTS THEN RELEASES -- mirroring the reconstruct-fail
	/// order below -- so the lease is never stranded. Below MAX_PARKS the report is
	/// `parked` (the turn re-dispatches, fresh, when a human next surfaces); AT the
	/// bound it is a terminal failure the user is told about, and it does not re-run.
	/// The parkCount it carries is the GLOBAL total, so two devices cannot each drive
	/// the loop independently -- the count and the single-runner lease together cap the
	/// respend at MAX_PARKS.
	async function parkAndRelease(e, d, trace, pk) {
		var turnId = String(e.turnId);
		var out    = parkOutcome(e.parkCount, d.maxParks);
		var terminal = out.terminal;
		var why = String((pk && pk.why) || (terminal
			? 'This turn needed your permission and no device was available to grant it -- it did not run.'
			: 'This turn needs your permission and no device was available -- it will re-run when you are back.'));
		// REPORT then RELEASE (the reconstruct-fail order), so the lease is freed only
		// after the account of the stop is on its way. A terminal park is an `aborted`
		// report (no re-dispatch); a survivable one is `parked`, carrying the bumped
		// GLOBAL count so the re-dispatcher increments from the true total.
		try {
			if (d.post) await d.post(reportFor(e, {
				status: terminal ? 'aborted' : 'parked', why: why, parkCount: out.next }));
			trace.push('report');
		} catch (err) { /* the release below still frees the turn */ }
		try { await settleLease('turn', turnId, d.selfId, 'released', d.cas, d.now); trace.push('release'); }
		catch (err) { /* an unreleased lease still expires at its deadline */ }
		return { ran: true, parked: !terminal, terminal: terminal, why: why, parkCount: out.next, trace: trace };
	}

	/// THE CLOCK EVERY LEASE CALL OF AN ERRAND READS (SIM-4). Every take, renew, complete and
	/// release reads THIS, never a raw `Date.now()`: two devices whose raw clocks disagree by
	/// more than the 90s TTL must still agree on whether a lease is live, or the one further
	/// ahead reads a peer's still-running lease as dead and re-runs -- and re-bills -- the
	/// turn. `d.relayNow` is the SAME gateway-corrected clock the age verdict reads;
	/// `authorityNow` (this device's own `DaimondPresence`-corrected clock) is the fallback
	/// while a caller (a direct take-if-vacant test, `runCompileErrand`'s sibling) supplies none.
	function depsClock(d) {
		return function leaseClock() {
			var r = (typeof d.relayNow === 'function') ? d.relayNow() : d.relayNow;
			if (r != null) return r;
			return (typeof d.now === 'function') ? d.now() : authorityNow();
		};
	}

	/// How a runner's turn ENDS, finished or interrupted: the final frame, the report, the
	/// lease settled done, the ack, the lease released, and the parcel. `e` is the errand,
	/// or a lease record standing in for it (`reportFor`). Answers the parcel's version.
	///
	/// `leaseSettled`: the lease was already ended by the device that sent the turn (its
	/// Stop settles it, `leaseRevokeCas`), so this run writes it no more. `deadAt`: the
	/// claim's deadline (`leaseVerdict`); the errand's own when not given.
	///
	/// Answers `{ revoked, stopped, parcelVersion }`.
	async function finishTurn(e, d, rep, trace, leaseClock, leaseSettled, deadAt) {
		var tid = String((e && e.turnId) || ''), finalTail = '', stopped = !!leaseSettled;
		var dl = leaseMs(deadAt) || leaseMs(e && e.deadline);
		if (d.finalFrame) {
			try { finalTail = String((await d.finalFrame(tid)) || ''); trace.push('final-frame'); }
			catch (err) { /* a dropped final frame only means the parcel is the first sight */ }
		}
		// THE LEASE BEFORE THE REPORT (check_final D1's class). A take-back this run has not
		// read refuses the `done`; the errand is then the taker's, so the run ends as endDead's
		// revoke does -- no done report, no ack, no release, no parcel.
		// The sender's Stop, unread, refuses it too (check_last F1), but a Stop is not a
		// take-back: the run ends as `endStopped` does, its answer kept and marked stopped
		// and sent home, with the lease left as the Stop settled it. A record the door does
		// not hold before the deadline is unknown (`absent`), so the run ends as it would have.
		var leaseHeld = !leaseSettled;
		if (leaseHeld) {
			var dn = await settleLease('turn', tid, d.selfId, 'done', d.cas, leaseClock, '', dl);
			var dwhy = (dn && !dn.ok) ? String(dn.why || '') : '';
			if (dwhy === 'released' || dwhy === 'not_ours') {
				trace.push('revoked-unseen');
				return { revoked: true, stopped: false, parcelVersion: 0 };
			}
			if (dwhy === 'stopped') { trace.push('stopped-unseen'); stopped = true; leaseHeld = false; }
			else if (dwhy === 'absent') trace.push('absent');
			else trace.push('complete');
		}
		// No `stopped` on the report: the sender's own Stop marks its tile, and the runner's
		// row is marked by its abort or `endLocal` (Rulings §1).
		try {
			await d.post(reportFor(e, Object.assign({ status: 'done', parcelVersion: 0, finalTail: finalTail ? 1 : 0 }, rep || {})));
			trace.push('report');
		} catch (err) { /* the report is only the nudge; the frame already carried the answer */ }
		try { if (d.ack) { await d.ack(e); trace.push('ack'); } }
		catch (err) { /* a missed ack costs one idempotent re-collect, never a drop */ }
		if (leaseHeld) { await settleLease('turn', tid, d.selfId, 'released', d.cas, leaseClock, '', dl); trace.push('release'); }
		// THE PARCEL, AFTER THE LEASE IS FREE. Awaited only where the caller asked
		// for it (`awaitPush`, which the tests do so the sequence is assertable);
		// otherwise started and left to land, because the originator is no longer
		// waiting on any part of it.
		var parcelVersion = 0;
		var pushing = (async function () {
			try { return (await d.pushResult()) | 0; }
			catch (err) { return 0; }
		})();
		if (d.awaitPush) { parcelVersion = (await pushing) | 0; trace.push('push'); }
		else { pushing.then(function () { trace.push('push'); }, function () {}); }
		return { revoked: false, stopped: stopped, parcelVersion: parcelVersion };
	}

	/// A RUN OF THIS TURN THAT A RELOAD HERE CUT SHORT, ENDED AND REPORTED (r545 F-C2-1; R3 F3).
	///
	/// The one door both of the runner's recoveries go through: `runErrand` when the errand
	/// is collected again, and the boot recovery (`recoverInterrupted`) when it is not -- a
	/// runner that reloads holds no work claim on the errand's row any more, so a re-collect
	/// is not something its recovery may wait on. `d.interrupted` folds the journal's open
	/// run into the chat and answers true; the turn then ends as it stood, with no model
	/// request and no tool call: reported done and interrupted to the device that sent it,
	/// whose Retry decides whether it runs again. Answers the run's result, or null when this
	/// device holds no open run of the turn. `deadAt` is the claim's deadline: the errand's
	/// own may be skewed by the sender's clock, or absent on the boot path (check_f1stop P3).
	async function reportInterrupted(e, deps, ctx, trace, deadAt) {
		var d = deps || {};
		trace = trace || [];
		if (!d.interrupted) return null;
		var cut = false;
		try { cut = !!(await d.interrupted(e, ctx)); }
		catch (err) { cut = false; }
		if (!cut) return null;
		trace.push('interrupted');
		var fin = await finishTurn(e, d, { interrupted: 1 }, trace, depsClock(d), false, deadAt);
		if (fin.revoked) return { ran: false, aborted: true, why: 'revoked', trace: trace };
		return { ran: false, done: true, interrupted: true, stopped: fin.stopped || undefined, parcelVersion: fin.parcelVersion, trace: trace };
	}

	/// Errands being run in THIS page, by turn id (RUNNER-READY F2). A re-take of this
	/// device's own live lease is read as a run a reload cut short, and ended Interrupted
	/// (`runErrandOnce` 1a); that reading holds only while no run of the turn is under way
	/// here. Another tab is kept out by the work claim (post.js `claimWork`); this keeps
	/// out a second call in the same page, which would otherwise settle the lease of the
	/// run still going.
	var _errandsHere = Object.create(null);

	async function runErrand(errand, deps) {
		var tid = String((errand || {}).turnId);
		if (_errandsHere[tid]) return { ran: false, why: 'local-in-flight', trace: ['local-in-flight'] };
		_errandsHere[tid] = 1;
		try { return await runErrandOnce(errand, deps); }
		finally { delete _errandsHere[tid]; }
	}

	async function runErrandOnce(errand, deps) {
		var d = deps || {}, e = errand || {};
		var turnId = String(e.turnId);
		var trace = [];
		// THE LEASE CLOCK (SIM-4). Every take, renew, complete and release below
		// reads THIS, never a raw `Date.now()`: two devices whose raw clocks
		// disagree by more than the 90s TTL must still agree on whether a lease is
		// live, or the one further ahead reads a peer's still-running lease as dead
		// and re-runs -- and re-bills -- the turn. `d.relayNow` is the SAME
		// gateway-corrected clock the age verdict below reads (the deps already
		// carry it for that, so a lease call is not asking every caller for a
		// second, separate clock); `authorityNow` (this device's own
		// `DaimondPresence`-corrected clock) is the fallback while a caller (a
		// direct take-if-vacant test, `runCompileErrand`'s sibling) supplies none.
		var leaseClock = depsClock(d);
		diag('collect errand', 'turn=' + turnId
			+ ' by=' + String(e.dispatchedBy || '').slice(0, 8)
			+ ' self=' + String(d.selfId || '').slice(0, 8)
			+ ' nominee=' + String(d.nominatedId || 'none').slice(0, 8)
			+ errandModelDiag(e));

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
		// stands down. On completion the ack dep SETTLES the errand's own hold first
		// (post.js `settle`), so the ack now genuinely drops the relay row and a peer that
		// collects after finds no errand; a peer whose collect raced in the errand and the
		// done report together reads `settled:1` on the released lease and stands down.
		// `allowSelf` only lifts THIS blanket refusal; every other guard is untouched.
		// `dispatchedBy` names the dispatching device (the per-device id, not the
		// account key), so a match to this device is our own dispatch.
		if (!d.allowSelf && e.dispatchedBy && String(e.dispatchedBy) === String(d.selfId)) {
			trace.push('self-dispatched');
			diag('collect stand-down', 'turn=' + turnId + ' own dispatch');
			return { ran: false, why: 'self-dispatched', trace: trace };
		}
		// AND A RECOVERY IS ONLY EVER OF THIS DEVICE'S OWN DISPATCH (2026-09-23).
		// `allowSelf` lifts the refusal above for the device that sent the turn; it is
		// not a licence to run somebody else's. The recovery errand carries the
		// placeholder's real sender (`errandForRecovery`), so an orphan synced from
		// another device stops here -- the path by which gilgamesh ran argonaut's.
		if (d.allowSelf && String(e.dispatchedBy || '') !== String(d.selfId)) {
			trace.push('not-own-recovery');
			diag('collect stand-down', 'turn=' + turnId + ' recovery of a turn another device sent');
			return { ran: false, why: 'not-own-recovery', trace: trace };
		}

		// A POISONED ENGINE BACKS OFF (UNBLOCK-7). A page whose engine trapped reloads
		// itself within POISON_RELOAD_MS (daimond.js), and a turn it claimed in that window
		// died Interrupted under its lease. So it stands down first, before anything that
		// could post, take or ack: the errand stays held in the mailbox (`standDownUndecided`),
		// and the reloaded page, reading the same mailbox record, collects it and runs it.
		var sick = false;
		try { sick = !!(d.poisoned && d.poisoned()); } catch (err) { sick = false; }
		if (sick) {
			trace.push('poisoned');
			diag('collect stand-down', 'turn=' + turnId + ' engine poisoned, reload pending');
			return { ran: false, why: 'poisoned', trace: trace };
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
			if (already) {
				trace.push('already-done');
				diag('collect stand-down', 'turn=' + turnId + ' already done');
				return { ran: false, why: 'already-done', trace: trace };
			}
		}

		// THE AGE RULE (E-R1, 2026-09-23). A turn older than the window is never started,
		// however fresh the errand that carries it: it is judged by its birth
		// (`turnAgeVerdict`), never by the deadline a sender wrote. Asked after the three
		// checks above, which post nothing -- so a sender is never told its own errand
		// was refused, and a turn already answered is not reported aborted -- and before
		// the nominee and the take, so nothing that could start a turn comes first. The
		// refusal is ANSWERED with an `aborted` report, which every device counts as
		// settled (`dispatchedTurnSettled`), so the sender stops re-handing it; the
		// collector lets the row go, and the relay drops it.
		var age = turnAgeVerdict(e, {
			rowTs:    d.rowTs,
			rowFirst: d.rowFirst,
			relayNow: (typeof d.relayNow === 'function') ? d.relayNow() : d.relayNow,
			births:   (typeof d.births === 'function') ? d.births(e) : d.births,
			now:      leaseNow(leaseClock),
		});
		diag('collect age', 'turn=' + turnId + ' age=' + Math.round(age.age / 1000) + 's'
			+ ' born=' + (age.birth ? new Date(age.birth).toISOString() : 'none')
			+ ' clock=' + (age.clock || 'none') + ' -> ' + (age.ok ? 'start' : 'REFUSE ' + age.why));
		if (!age.ok) {
			trace.push('stale-turn');
			try {
				if (d.post) await d.post(reportFor(e, { status: 'aborted', why: STALE_TURN_WHY }));
				trace.push('report');
			} catch (err) { /* refused either way; the sender's own window ends it too */ }
			return { ran: false, why: 'stale-turn', age: age, trace: trace };
		}

		// A PERSON'S PAUSE (R2 QA, F2). `pauseHold` answers `{ node, why }` when a pause
		// holds this turn, on this device's set merged with the one the errand carries from
		// dispatch -- the parcel that would tell this device follows the errand, and a
		// sender on an older build never asked. Here, with the age rule, so nothing that
		// could start a turn comes first; and before the nominee, since every device refuses
		// it alike. Answered like a hand-back: an `error` report, which the sender shows with
		// its [Run here], and there the same pause refuses the turn until play is pressed.
		var ph = null;
		try { ph = d.pauseHold ? d.pauseHold(e) : null; } catch (err) { ph = null; }
		if (ph) {
			trace.push('paused');
			diag('collect refuse', 'turn=' + turnId + ' paused at ' + String(ph.node || ''));
			try {
				if (d.post) await d.post(reportFor(e, { status: 'error', why: String(ph.why || 'This turn is paused.'),
					paused: String(ph.node || 'root') }));
				trace.push('report');
			} catch (err) { /* refused either way; the sender's deadline ends it too */ }
			return { ran: false, why: 'paused', node: String(ph.node || ''), trace: trace };
		}

		// BUSY (H1, C1). This device is running a turn for another chat, so it would reach
		// this one only when that ends, and the sender used to wait out its backstop and
		// then run the turn itself. Decided now instead. When this device is the one the
		// turn waits on -- the nominee, or with no idle desktop live beside it ahead of it in
		// id order (`busyHoldsFor`, Q22) -- it hands the turn back at once and lets the row
		// go, and the sender runs it. Otherwise it HOLDS the row and leaves it to the idle
		// device that will claim it. A turn for the chat already running here is not busy:
		// it queues behind it (O3).
		//
		// THE HAND-BACK IS AN `undeliverable` CARRYING `busy` (r544, QA F-A1), not a status
		// of its own. r543 answered `busy`, which no sender counted as a hand-back: the turn
		// read as settled, the fallback and the backstop both stood down, and it never ran.
		// Every sender since 2026-09 runs an `undeliverable` at once, r542 and r543 included.
		// The sender itself is never the idle desk: it does not claim its own errand (QA F-A2).
		//
		// NOR FOR A DEVICE THAT HAS HANDED IT BACK (r545, Q19). `tried` names each runner the
		// sender collected a hand-back from. Holding the row for one of them, or deferring to
		// a nominee among them, sent the turn to a device that had already said no, and it
		// waited out the sender's backstop. A nominee in it is no nominee for this turn.
		var tried = triedList(e.tried);
		var nomE  = String(d.nominatedId || '');
		if (nomE && tried.indexOf(nomE) >= 0) nomE = '';
		// THE ADDRESSEE (D-20261009-23): true = another live device was named, so leave it
		// the turn; false = this device was named; null = the nomination decides.
		var addr = d.allowSelf ? null : addresseeStandDown(e, d.selfId, d.presence, leaseNow(leaseClock), d.freshWindowMs);
		var busyN = (!d.allowSelf && d.busyFor) ? busyDepth(d.busyFor(e)) : 0;
		if (busyN > 0) {
			var mine = addr !== null ? addr === false
				: nomE ? nomE === String(d.selfId)
				: !busyHoldsFor(d.presence, d.selfId, [e.dispatchedBy].concat(tried), leaseNow(leaseClock), d.freshWindowMs);
			diag('collect busy', 'turn=' + turnId + ' depth=' + busyN + ' -> ' + (mine ? 'ANSWER busy' : 'hold for an idle device'));
			if (!mine) {
				trace.push('busy-hold');
				return { ran: false, why: 'busy-hold', busy: busyN, trace: trace };
			}
			trace.push('busy');
			try {
				if (d.post) await d.post(reportFor(e, { status: 'undeliverable', busy: busyN, why: BUSY_WHY,
					by: String(d.selfId || '') }));
				trace.push('report');
			} catch (err) { /* the sender's backstop still ends it */ }
			return { ran: false, why: 'busy', busy: busyN, trace: trace };
		}
		// THIS DEVICE'S OWN WORK IN THE CHAT (UNBLOCK-1 BUSY-SELF). A chat it is running is
		// not busy for itself, so the turn queues behind that work rather than going back.
		// Those turns' rows may be ones the sender has not seen, so the thread is judged with
		// and without them; the ids are asked now, before any of them can end.
		var own = (!d.allowSelf && typeof d.ownTurns === 'function') ? triedList(d.ownTurns(e)) : [];

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
		// THE COLLECTOR-SIDE SMOKING-GUN. Whether this device defers to the nominee is
		// decided here against LIVE presence, and the inputs (nominee id, whether it is
		// present in this device's snapshot, and its beat age) are exactly what tells a
		// stand-down that SHOULD have happened from one driven by a stale or mismatched
		// nominee id. Built only when Diagnostics is on.
		if (window.DaimondDiag && DaimondDiag.on()) {
			var _nom = nomE;
			var _rec = _nom ? ((d.presence || {})[_nom]) : null;
			var _beat = _rec ? Math.round((leaseNow(leaseClock) - leaseMs(_rec.lastSeen)) / 1000) + 's' : 'absent';
			var _stand = !d.allowSelf && nominationStandDown(nomE, d.selfId, d.presence, leaseNow(leaseClock), d.freshWindowMs);
			diag('collect nominee check', 'turn=' + turnId
				+ ' nominee=' + (_nom ? _nom.slice(0, 8) : 'none')
				+ ' present=' + (_rec ? 'Y' : 'N') + ' beat=' + _beat
				+ ' -> ' + (_stand ? 'STAND DOWN for nominee' : 'proceed to claim'));
		}
		if (addr === true) {
			diag('collect addressee', 'turn=' + turnId + ' named ' + String(e.to).slice(0, 8) + ' -> STAND DOWN');
			trace.push('stood-down-for-addressee');
			return { ran: false, why: 'addressee', trace: trace };
		}
		if (addr === null && !d.allowSelf && nominationStandDown(nomE, d.selfId, d.presence, leaseNow(leaseClock), d.freshWindowMs)) {
			trace.push('stood-down-for-nominee');
			return { ran: false, why: 'nominee', trace: trace };
		}

		// A missing lease CAS cannot arbitrate a claim, so there is no safe way to run:
		// stand down cleanly rather than let `leaseTake` dereference a null `cas` and
		// throw the opaque "Cannot read properties of null (reading 'read')".
		if (!d.cas || typeof d.cas.read !== 'function') {
			trace.push('no-cas');
			diag('collect stand-down', 'turn=' + turnId + ' no lease CAS');
			return { ran: false, why: 'no-cas', trace: trace };
		}

		// 0. READY BEFORE THE CLAIM (D2, rc-b ruling b, 11 Oct). A runner never claims a
		// turn it cannot run. It asks first whether it can run the turn's models and rebuild
		// the errand's thread (the seed grafted in, a bounded pull where it is only behind);
		// if it cannot, it writes no lease, hands the turn back `undeliverable` with the
		// reason, and acks the errand, so the sender runs it at once rather than after a
		// claimed turn's stall.
		// Not asked on a local recovery (`allowSelf`): that device holds the thread itself.
		if (!d.allowSelf && typeof d.ready === 'function') {
			var rd = null;
			try { rd = await d.ready(e, own); } catch (err) { rd = { ok: false, why: String((err && err.message) || err) }; }
			if (rd && rd.ok === false) {
				var nwhy  = String(rd.why || 'this device cannot rebuild the thread');
				var ncause = rd.cause || 'thread';	// 'models' / 'models-behind': the turn's set (HT3)
				trace.push('not-ready');
				diag('collect NOT READY', 'turn=' + turnId + ' -- ' + nwhy);
				// One console line, as the reconstruct refusal below prints: it is the same refusal
				// of a stale thread, met earlier, and a verifier on B's console reads either.
				try { if (typeof console !== 'undefined') console.error('peer: collect not ready for turn ' + turnId + ' -- ' + nwhy); } catch (e2) {}
				try { if (d.post) { await d.post(reportFor(e, { status: 'undeliverable', why: nwhy, cause: ncause, by: String(d.selfId || '') })); trace.push('report'); } }
				catch (err) { /* the sender's backstop still ends it */ }
				try { if (d.ack) { await d.ack(e); trace.push('ack'); } }
				catch (err) { /* a missed ack costs one idempotent re-collect */ }
				return { ran: false, undeliverable: true, why: 'not-ready', detail: nwhy, trace: trace };
			}
		}

		// 1. TAKE. Stand down -- never run -- if a peer already holds it.
		var tTake = leaseNow(leaseClock);
		var took = await leaseTake(turnId, { holder: d.selfId, eid: e.eid, dispatchedBy: e.dispatchedBy,
			deadline: e.deadline, ts: e.ts, until: age.until }, d.cas, leaseClock);
		trace.push('take');
		if (!took.won) {
			diag('collect stand-down', 'turn=' + turnId
				+ (standDownUndecided(took.why) ? ' undecided (' : ' peer holds (')
				+ (took.why || '?') + ' holder=' + String(took.holder || '').slice(0, 8) + ')');
			return { ran: false, why: took.why || 'stood-down', holder: took.holder, trace: trace };
		}
		diag('collect CLAIMED', 'turn=' + turnId + ' by ' + String(d.selfId || '').slice(0, 8)
			+ ' take=' + (leaseNow(leaseClock) - tTake) + 'ms');

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
		var revoked = false, checkStopped = false, checkTimer = null, progressTimer = null;
		// THE RUN'S OTHER END (UNBLOCK-7 F4). `runTurn` is raced against this, resolved when
		// the lease deadline passes or the engine is poisoned: a run whose await never settles
		// still ends, reported aborted, acked and released, rather than holding the runner.
		var deadWhy = null, deadFire = null;
		var DEAD = {};
		var dead = new Promise(function (r) { deadFire = r; });
		function killRun(why) {
			if (deadWhy != null) return;
			deadWhy = String(why || 'deadline');
			trace.push('dead-' + deadWhy);
			diag('collect DEAD', 'turn=' + turnId + ' why=' + deadWhy);
			deadFire(DEAD);
		}
		// The CLAIM's deadline, not the errand's (check_f234 Q2): a sender whose clock runs slow
		// writes a deadline already past here, and the take holds the claim to the age window
		// instead. Racing the errand's own would kill a healthy run on its first tick.
		var deadAt = leaseMs(took.deadline) || leaseMs(e.deadline);		// 0: no deadline to race
		// THE START WINDOW IS NOT THE FINISH LINE (UNBLOCK-25). `deadAt` bounds only how late the
		// turn may START: a run that has begun holds its lease past it by renewing (`holdOn`),
		// and ends when the lease is no longer held -- a take-back, the hung cap, or a lease
		// that lapsed because no renew could land. A run that kept going on a lapsed lease could
		// meet the asker's Retry on another device: two runs, two bills.
		var runningNow = false;				// step 4 began: the start window is behind it
		var heldTo = deadAt;				// the lease's expiry as this run last wrote it
		var holdFlight = false;				// one hold renew in flight at a time
		var runHold = (d.runHoldMs != null) ? d.runHoldMs : RUN_HOLD_MS;
		function holdEnd() { return Math.max(deadAt, heldTo); }
		var stoppedThere = false;		// the revoke is the sender's Stop (settled), not a take-back
		var progFlight = null, progLast = 0;		// the frame in flight; when the last one left
		var checkStart = leaseNow(leaseClock);
		var maxLife = (d.maxLeaseLifeMs != null) ? d.maxLeaseLifeMs : MAX_LEASE_LIFE_MS;
		var setT = d.setTimer   || (typeof setInterval   === 'function' ? setInterval   : null);
		var clrT = d.clearTimer || (typeof clearInterval === 'function' ? clearInterval : null);
		function stopCheck() {
			checkStopped = true;
			if (_leaseWatch[turnId] === leaseWatched) delete _leaseWatch[turnId];
			if (liveTrail != null) { try { clearTimeout(liveTrail); } catch (err) {} liveTrail = null; }
			if (checkTimer != null && clrT) { try { clrT(checkTimer); } catch (err) {} checkTimer = null; }
			// The progress timer streams the RUNNING turn; it dies with the ticker, on
			// EVERY exit, so it can neither push a frame of a finished turn nor leak.
			// Stopped HERE (before the final pushResult, which stopCheck precedes) so a
			// progress frame never overlaps the final push on the one-round gate.
			if (progressTimer != null && clrT) { try { clrT(progressTimer); } catch (err) {} progressTimer = null; }
		}
		// READ-ONLY: never writes the parcel (no renew, no churn). Aborts on a revoke
		// -- the lease is no longer ours, or was released, which a sync pull adopts into
		// the view this reads -- and on the lifetime cap, the backstop for a runTurn
		// whose promise never settles, which then ends as a dead run (`killRun`).
		// PACED. The engine calls this on EVERY journal event (a streamed token is one), and
		// since the lease door left the parcel a read is a network GET, not a look at memory:
		// one read per event was ~27 GETs a second on a 52-round turn (2026-10-04), each held
		// behind the browser's six connections until its 18 s budget ended, which starved the
		// runner's own progress PUTs. So an event-driven call (`force` absent) reads only when no
		// event-driven read is in flight and the last read began `gapMs` ago: a take-back is seen
		// within one gap of the next event. The ticker passes `force` and ALWAYS reads, even over
		// a stuck in-flight read, so on a quiet stream detection is never later than the tick.
		var liveIn = 0, liveLast = -Infinity, liveTrail = null;
		var stuckMs = (d.livenessStuckMs != null) ? d.livenessStuckMs : 2 * LIVENESS_GAP_MS;
		function liveTrailArm(wait) {
			if (liveTrail != null || checkStopped || revoked || typeof setTimeout !== 'function') return;
			liveTrail = setTimeout(function () { liveTrail = null; liveness(false); }, Math.max(0, wait));
		}
		var gapMs = (d.livenessGapMs != null) ? d.livenessGapMs : LIVENESS_GAP_MS;
		// The cut that is due, or '' (F4, UNBLOCK-25): a turn not yet started past its start
		// window ('deadline'), or a running one past the lease it holds ('lapsed'). The run ENDS
		// after the read, so a revoke is still recorded as one, whatever the read found.
		function cutDue() {
			var n = leaseNow(leaseClock);
			if (!runningNow) return (deadAt > 0 && n > deadAt) ? 'deadline' : '';
			return (heldTo > 0 && n > heldTo) ? 'lapsed' : '';
		}
		async function liveness(force) {
			var due = cutDue();
			if (!checkStopped && revoked && due) { killRun(due); return; }
			await livenessRead(force);
			if (!checkStopped && (due = cutDue())) killRun(due);
		}
		// HOLD THE LEASE AHEAD OF ITS EXPIRY while the turn runs (UNBLOCK-25): one door write
		// per half hold, only once it is within half a hold of lapsing, so a turn inside its
		// start window writes nothing new. A lapsed lease is never revived: another device may
		// already read it Interrupted and have pressed Retry.
		async function holdOn() {
			if (!runningNow || !(heldTo > 0) || holdFlight || checkStopped || revoked) return;
			var n = leaseNow(leaseClock);
			if (n > heldTo || heldTo - n > runHold / 2) return;
			holdFlight = true;
			try {
				var rn = await leaseRenew(turnId, d.selfId, d.cas, leaseClock, { holdMs: runHold });
				if (rn && rn.ok && rn.expiry > heldTo) {
					if (heldTo <= deadAt) trace.push('hold');
					heldTo = rn.expiry;
				}
			} catch (err) { /* the next tick tries again; a lease never held lapses and ends the run */ }
			finally { holdFlight = false; }
		}
		async function livenessRead(force) {
			if (checkStopped || revoked) return;
			if (leaseNow(leaseClock) - checkStart > maxLife) {
				trace.push('renew-capped');
				// The run ENDS here (check_final D2): an abort alone leaves a hung run's race
				// waiting for ever. Not `revoked` -- the lease is still ours, so it is settled
				// and cut through `endDead`, and the reason rides with its abort.
				stopCheck();
				killRun('lease_cap');
				return;
			}
			var wall = Date.now();		// the wall clock, so a test's frozen `now` cannot freeze the pacing
			var held = false;
			if (force !== true) {
				var since = wall - liveLast;		// negative if the wall clock stepped back: read, do not wait
				var need = liveIn > 0 ? Math.max(gapMs, stuckMs) : gapMs;
				var wait = since < 0 ? 0 : need - since;
				if (wait > 0 || liveIn >= 3) { liveTrailArm(Math.min(wait > 0 ? wait : gapMs, gapMs)); return; }
				liveIn += 1; held = true;
			}
			liveLast = wall;
			var snap;
			try { snap = await d.cas.read(); } catch (err) { return; }	// a failed read is not a revoke
			finally { if (held) liveIn -= 1; }
			if (checkStopped || revoked) return;
			// Nor is an unreadable door: a revoke is a POSITIVE record (`leaseRevokeCas` writes a
			// 'released' one, it never deletes), so what could not be read is unknown, not revoked.
			if (!snap || snap.unread || !snap.leases) return;
			var cur = snap.leases[turnId];
			// An absent record is a revoke only past the lease's own deadline, when it has expired
			// and drained; before it, a take-back would have left a 'released' record (`absent`).
			var verdict = leaseVerdict(cur, d.selfId, leaseNow(leaseClock), holdEnd());
			if (verdict === 'ours') { await hearSaid(cur); await holdOn(); return; }
			if (verdict === 'absent') return;
			{
				revoked = true;
				// A STOP PRESSED ON THE DEVICE THAT SENT THE TURN (D-20261011-21, R3 F1 ruled a):
				// this run's own lease, released SETTLED. It ends as a Stop pressed here ends it,
				// the partial kept and marked stopped by the person, and is sent home.
				stoppedThere = verdict === 'stopped';
				trace.push(stoppedThere ? 'stopped' : 'abort');
				diag('collect REVOKED', 'turn=' + turnId + ' why=' + (!cur ? 'absent'
					: verdict === 'not_ours' ? 'holder' : verdict));
				try { if (d.abort) d.abort(stoppedThere ? 'user' : 'lease_revoked'); } catch (err) { /* idempotent */ }
			}
		}
		// WHAT THE SENDER SAID INTO THIS RUN (UNBLOCK-27 R7), handed to the turn by id, once
		// each: a word the turn could not take yet (`d.interject` false: nothing running to
		// hear it) is offered again at the next read.
		//
		// A word the turn can no longer hear (`d.interject` answers 'late': its last model round
		// is under way, the answer being written) is never taken, so it is never a second row
		// here, and the runner answers it AT ONCE with a receipt on the lease (`leaseUnheard`),
		// which the sender reads and sends the word as the next turn (UNBLOCK-27 R7c). Before,
		// it was taken, never reached the model, and waited out the answer's tail for the report.
		var saidTaken = {}, saidLate = {};
		async function hearSaid(cur) {
			if (!d.interject || !cur || !Array.isArray(cur.said)) return;
			var late = [];
			cur.said.forEach(function (x) {
				var id = String((x && x.id) || '');
				if (!id || saidTaken[id] || saidLate[id]) return;
				var took = false;
				try { took = d.interject({ id: id, text: String(x.text || ''), pre: String(x.pre || ''), turn: turnId }); }
				catch (err) { took = false; }
				if (took === true) { saidTaken[id] = 1; trace.push('said'); }
				else if (took === 'late') { saidLate[id] = 1; late.push(id); }
			});
			if (!late.length) return;
			trace.push('unheard');
			var rr;
			try { rr = await leaseUnheard(turnId, late, d.selfId, d.cas, leaseClock); }
			catch (err) { rr = { ok: false, why: 'threw' }; }
			diag('said unheard receipt', 'turn=' + turnId + ' n=' + late.length + ' ok=' + (rr && rr.ok ? 1 : 0));
		}
		// Is a word on the lease view this run has neither taken nor answered? The view moving
		// is the sender's say landing, so the run reads the door now, not at the next tick.
		function saidWaiting(r) {
			return !!r && Array.isArray(r.said) && r.said.some(function (x) {
				var id = String((x && x.id) || '');
				return !!id && !saidTaken[id] && !saidLate[id];
			});
		}
		// What the report names as heard: taken by the turn AND read by the model (`d.landed`).
		// A word the turn took but ended before its next round never reached the model, so
		// it is left out, and the sender sends it again as the next turn.
		function heardIds() {
			return Object.keys(saidTaken).filter(function (id) {
				if (!d.landed) return true;
				try { return d.landed(id) === true; } catch (err) { return false; }
			});
		}
		// What the engine's journal events call: a nudge, never a forced read.
		function nudge() { return liveness(false); }
		// Steps 4's tail: the final frame, the report, the lease, the ack and the parcel,
		// as a finished run and an interrupted one both end. Answers `{ revoked, parcelVersion }`.
		async function complete(rep) {
			// A streaming frame still in flight lands first, so it can never arrive after
			// the final frame and stand in for the finished turn.
			if (progFlight) { try { await progFlight; } catch (err) { /* settled either way */ } }
			return finishTurn(e, d, Object.assign({}, rep || {}, { heard: heardIds() }), trace, leaseClock, false, holdEnd());
		}
		// What an adopted lease view calls (`_leaseWatch`): a read of the door, but only
		// when the view no longer says this device runs the turn, so a lease change on
		// another turn costs no request.
		// A run its sender stopped ends as a finished one does -- final frame, report, ack,
		// parcel -- so the partial the Stop kept reaches the sender, as a Stop pressed here
		// sends it; only the lease is not written, the sender's Stop having settled it.
		async function endStopped() {
			stopCheck();
			if (progFlight) { try { await progFlight; } catch (err) { /* settled either way */ } }
			var sfin = await finishTurn(e, d, { heard: heardIds() }, trace, leaseClock, true, holdEnd());
			return { ran: true, done: true, stopped: true, parcelVersion: sfin.parcelVersion, trace: trace };
		}
		// THE END OF A RUN THAT WILL NOT END ITSELF (F4): unless the lease is no longer ours,
		// the engine aborted, the `done` written and the local run dropped, the lease SETTLED FIRST
		// (done -> released, marked `cut`), as every run cut short ends (R3 F3), and only
		// then the `aborted` report home and the ack. Settled before anything can be lost,
		// neither a lost report, a lost ack nor a reload makes the turn re-runnable: no
		// take wins a settled lease, and the sender reads it Interrupted, whose Retry decides
		// (check_f234 fix 1; ruling D-20261010-22).
		async function endDead() {
			stopCheck();
			var abortWhy = deadWhy === 'deadline' ? 'lease_deadline' : deadWhy === 'lapsed' ? 'lease_lapsed'
				: deadWhy === 'lease_cap' ? 'lease_cap' : 'engine_poisoned';
			// THE ENGINE ABORTED FIRST, so the spend stops now and not when the lease door
			// answers (check_f1stop P2): the door's read and write can take tens of seconds.
			// A Stop already read is the sender's, so its run is aborted as one.
			try { if (d.abort) d.abort(stoppedThere ? 'user' : abortWhy); }
			catch (err) { /* idempotent */ }
			// Then the `done`, unless a read already found the lease gone: its refusal says
			// whether the sender's Stop crossed the kill unread (check_last F1). The label
			// follows that verdict, in `endLocal`, and not the abort.
			var dwhy0 = '';
			if (!revoked) {
				try {
					var dn = await settleLease('turn', turnId, d.selfId, 'done', d.cas, leaseClock, deadWhy, holdEnd());
					dwhy0 = (dn && !dn.ok) ? String(dn.why || '') : '';
				} catch (err) { dwhy0 = 'unread'; /* an unsettled lease still expires at its deadline */ }
				if (dwhy0 === 'stopped') { trace.push('stopped-unseen'); stoppedThere = true; }
			}
			try { if (d.endLocal) await d.endLocal(e, stoppedThere ? 'user' : deadWhy); } catch (err) { /* the reload or the boot recovery is the net */ }
			// Stopped by the sender, read or not: the Stop's contract holds for a run killed
			// after it -- the partial kept, marked stopped and sent home, the lease unwritten.
			if (stoppedThere) return await endStopped();
			if (revoked) return { ran: true, aborted: true, why: 'revoked', dead: deadWhy, trace: trace };
			// Taken back or taken over before this run read it (check_final D1): the errand is
			// theirs now, so it ends as the revoke above does -- no report, no ack.
			if (dwhy0 === 'released' || dwhy0 === 'not_ours') {
				trace.push('revoked-unseen');
				return { ran: true, aborted: true, why: 'revoked', dead: deadWhy, trace: trace };
			}
			if (dwhy0 === 'absent') trace.push('absent');		// unknown: reported as before
			else if (!dwhy0) {
				trace.push('complete');
				try { await settleLease('turn', turnId, d.selfId, 'released', d.cas, leaseClock, deadWhy, holdEnd()); trace.push('release'); }
				catch (err) { /* an unsettled lease still expires at its deadline */ }
			}
			var who = String(d.selfName || '').trim();
			var dwhy = who ? 'Interrupted on ' + who : 'Interrupted on the device that ran it';
			try { if (d.post) { await d.post(reportFor(e, { status: 'aborted', why: dwhy, by: String(d.selfId || ''), cause: deadWhy, cut: deadWhy, heard: heardIds() })); trace.push('report'); } }
			catch (err) { /* the settled lease already says it */ }
			try { if (d.ack) { await d.ack(e); trace.push('ack'); } }
			catch (err) { /* a missed ack costs one re-collect, which the settled lease refuses */ }
			// The partial travels as the parcel, started and left to land.
			try {
				var pushing = Promise.resolve(d.pushResult ? d.pushResult() : 0);
				pushing.then(function () { trace.push('push'); }, function () {});
				if (d.awaitPush) await pushing;
			} catch (err) { /* a dropped parcel is only a later sync */ }
			return { ran: true, aborted: true, why: deadWhy, trace: trace };
		}
		function leaseWatched() {
			var r = _leases[turnId];
			if (!r || r.holder !== String(d.selfId) || r.mode === 'released' || (d.interject && saidWaiting(r))) liveness(true);
		}
		try {
			// 1a. A RE-TAKE OF THIS DEVICE'S OWN LIVE LEASE IS A RECOVERY, NEVER A RUN (rulings §1,
			// RUNNER-READY F2). The claim on the door is this device's, and no run of the turn is
			// under way here (the work claim), so the run that took it was cut short by a reload.
			// It ends HERE, before the reconstruct: the Interrupted fold needs only the chat and
			// the journal, never the engine, and a reconstruct on a page whose engine was not yet
			// up threw and handed the turn back as `error`, its rounds lost (reconstruct_diag.md).
			// With no journal run to fold, the turn is still settled Interrupted: never run again
			// from round 0, so no tool call the lost run made is made twice. Retry decides.
			if (took.retake) {
				trace.push('retake');
				diag('collect RETAKE', 'turn=' + turnId + ' own live lease: interrupted, not rerun');
				var rir = await reportInterrupted(e, d, null, trace, deadAt);
				if (rir) return rir;
				trace.push('interrupted');
				var rfin = await finishTurn(e, d, { interrupted: 1 }, trace, depsClock(d), false, deadAt);
				if (rfin.revoked) return { ran: false, aborted: true, why: 'revoked', trace: trace };
				return { ran: false, done: true, interrupted: true, stopped: rfin.stopped || undefined,
					parcelVersion: rfin.parcelVersion, trace: trace };
			}
			// 1b. QUEUE BEHIND THIS DEVICE'S OWN TURN IN THE CHAT, holding the lease (UNBLOCK-1
			// BUSY-SELF). Taken FIRST, so the sender's backstop reads the turn as claimed and
			// stands down however long the turn ahead runs, then rebuilt once that turn has
			// ended, so the thread holds its answer. The wait ends early on a take-back or past
			// the deadline: the ticker reads the lease as a running turn's does.
			if (own.length > 0 && typeof d.queueBehind === 'function') {
				trace.push('queue');
				diag('collect QUEUED', 'turn=' + turnId + ' behind ' + own.join(','));
				var qTick = setT ? setT(function () { liveness(true); if (d.heartbeat) d.heartbeat(); }, RENEW_EVERY_MS) : null;
				var qEnd = null;
				try {
					qEnd = await Promise.race([Promise.resolve(d.queueBehind(e,
						function () { return revoked || deadWhy != null; })), dead]);
				} catch (err) { qEnd = null; /* the rebuild below judges the chat as it stands */ }
				finally { if (qTick != null && clrT) { try { clrT(qTick); } catch (err) {} } }
				if (qEnd === DEAD) return await endDead();
				// Taken back while it waited: nothing ran, and the turn is the taker's.
				if (revoked) return { ran: false, aborted: true, why: stoppedThere ? 'stopped' : 'revoked', trace: trace };
				// A turn of the chat that began in the wait is own work too.
				if (qEnd && Array.isArray(qEnd.own)) own = triedList(own.concat(qEnd.own));
				trace.push('queued');
			}
			// 2. RECONSTRUCT the chat and workspace at the errand's version.
			var ctx;
			try { ctx = await d.reconstruct(e, own); trace.push('reconstruct'); }
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
				// UNDELIVERABLE (progress-based reconstruct gave up: the parcel is not
				// reaching this device) vs an unexpected reconstruct error. The former is a
				// clean hand-back -- ACK the errand so it leaves the shared relay and no peer
				// re-claims it into a loop, and the dispatcher's undeliverable-report handler
				// drops to a local run at once. The latter is a surprise this device could be
				// alone in hitting, so it is left ON the relay (not acked) for another peer or
				// the deadline, exactly as before.
				var undeliverable = !!(err && err.undeliverable);
				trace.push(undeliverable ? 'reconstruct-undeliverable' : 'reconstruct-failed');
				try { if (typeof console !== 'undefined') console.error('peer: reconstruct '
					+ (undeliverable ? 'undeliverable' : 'failed') + ' for turn ' + turnId + ' -- ' + rwhy); } catch (e2) {}
				// IN THE DIAGNOSTICS LOG TOO (RUNNER-READY F3). A console line alone left a
				// reloaded runner's hand-back as silence after `reconstruct start` in every dump.
				diag('collect reconstruct ' + (undeliverable ? 'undeliverable' : 'failed'), 'turn=' + turnId + ' -- ' + rwhy.slice(0, 200));
				// A RUN THIS DEVICE ALREADY MADE IS NOT HANDED BACK (RUNNER-READY F3). When the
				// journal here holds the turn open, the turn was run on this device and a reload
				// cut it short: it ends Interrupted, as 2b ends it, and the sender's Retry
				// decides. An `error` would offer [Run here], which re-runs every tool call the
				// lost run made. The fold needs no reconstruct (the dep finds the chat itself).
				if (!undeliverable) {
					var fir = await reportInterrupted(e, d, null, trace, deadAt);
					if (fir) return fir;
				}
				try { if (d.post) await d.post(reportFor(e, {
					status: undeliverable ? 'undeliverable' : 'error', why: rwhy, by: d.selfId,
					cause: (undeliverable && err.cause) || '' })); }
				catch (e2) { /* the release below still frees the turn */ }
				try { await settleLease('turn', turnId, d.selfId, 'released', d.cas, leaseClock); trace.push('release'); }
				catch (e2) { /* an unreleased lease still expires at its deadline */ }
				if (undeliverable) {
					try { if (d.ack) { await d.ack(e); trace.push('ack'); } }
					catch (e2) { /* a missed ack costs one idempotent re-collect, never a re-run: finished guards it */ }
				}
				return { ran: false, error: true, undeliverable: undeliverable, why: rwhy, trace: trace };
			}

			// 2b. A RUN A RELOAD CUT SHORT IS NOT RUN AGAIN (r545 F-C2-1). The asker re-sends
			// a turn whose runner reloaded mid-turn; re-running it from round 0 repeated
			// every tool call the lost run had made -- each side effect twice -- and billed
			// the rounds again. When this device's journal holds the turn open (`interrupted`
			// folds it into the chat and answers true), the turn ends here as it stood:
			// interrupted, with no model request and no tool call, and the person who sent
			// it decides whether to run it again.
			var ir = await reportInterrupted(e, d, ctx, trace, deadAt);
			if (ir) return ir;

			// 3. Transition claimed -> running ONCE -- a semantic state change for the UI
			// footer ("running" vs "picking this up"), one write, before the turn goes
			// busy. This keeps the deadline expiry (leaseRenew never shrinks it); it does
			// NOT start a heartbeat. A lease already revoked between take and here aborts.
			var mk = await retryUnread(function () { return leaseRenew(turnId, d.selfId, d.cas, leaseClock); });
			if (mk && mk.ok && mk.expiry > heldTo) heldTo = mk.expiry;
			if (!mk.ok && mk.why === 'revoked') {
				revoked = true;
				trace.push('abort');
				diag('collect REVOKED', 'turn=' + turnId + ' why=renew');
				try { if (d.abort) d.abort('lease_revoked'); } catch (err) { /* idempotent */ }
				return { ran: true, aborted: true, why: 'revoked', trace: trace };
			}
			// 4. RUN. A revoked lease HARD-ABORTS at once, via the read-only ticker and
			// the injected onProgress (kept so a real journal-event piggyback can check
			// liveness between ticks); chat.app.abort is the hard stop.
			runningNow = true;		// from here the lease is held, not the start window
			if (setT) checkTimer = setT(function () { liveness(true); if (d.heartbeat) d.heartbeat(); }, RENEW_EVERY_MS);
			_leaseWatch[turnId] = leaseWatched;	// and at once, on a lease wake
			_poisonWatch[turnId] = killRun;		// and at once, on a poisoned engine
			// STREAM THE RUNNING TURN. Through the length of the run, push the transcript
			// as it stands so a peer watching the hand-off sees it unfold. A no-op dep
			// (the runner-acceptance path, and peer.test) starts no timer, so this is
			// invisible where it is not wired. Money-safe: `pushProgress` is the SAME
			// account parcel under compare-and-set -- no new turn, no new lease, no
			// second charge -- and it never waits, so it cannot stall the turn. Stopped
			// by stopCheck on every exit, before the final pushResult.
			if (setT && d.pushProgress) {
				var frameNow = d.frameNow || Date.now;
				progressTimer = setT(function () {
					if (checkStopped || revoked || progFlight) return;
					if (progLast && frameNow() - progLast < PROGRESS_EVERY_MS) return;
					// The turn id is PASSED: a frame is keyed by the turn it belongs to, so the
					// dep cannot be left to guess which turn this device is running.
					var sent;
					try { sent = d.pushProgress(turnId); } catch (err) { return; }	// a dropped frame is only a slower stream
					progFlight = Promise.resolve(sent).then(function (at) {
						if (typeof at === 'number' && at > 0) progLast = at;
					}, function () { /* a dropped frame is only a slower stream */ })
						.then(function () { progFlight = null; });
					return progFlight;
				}, PROGRESS_TICK_MS);
			}
			try {
				// D3 — the prompt is ALREADY in the synced transcript (the dispatcher
				// persist-first pushed it before posting the errand, §4.1). Tell runTurn so,
				// so it runs the turn against the existing user message instead of appending
				// a second copy -- otherwise the prompt sits twice in `messages` AND is fed
				// to the model twice (seeded history + the re-sent turn). `turnId` names the
				// existing user message (mid === turnId) the runner anchors to.
				var turnP = (async function () {
					return d.runTurn(ctx, e.prompt, { onProgress: nudge, promptInTranscript: true, turnId: turnId, until: deadAt,
						pre: (typeof e.pre === 'string') ? e.pre : '',
						effort: (typeof e.effort === 'string') ? e.effort : undefined,
						model: e.model || null });		// the model the asker resolved (C3)
				})();
				turnP.then(null, function () { /* a run raced out by `dead` may still reject */ });
				// Decided by which end came first, not by `deadWhy` alone: a turn that finished in
				// the microtask window of a kill (a poison from another turn) keeps its whole answer.
				if (await Promise.race([turnP, dead]) === DEAD) return await endDead();
				trace.push('run');
			} catch (err) {
				// Ended by the deadline or the poison, whatever the engine then threw.
				if (deadWhy != null) return await endDead();
				// Stopped by the sender: ended as a Stop here ends it (`endStopped`).
				if (stoppedThere) return await endStopped();
				// Revoked -> the lease is already whoever took it back's; touch nothing,
				// do NOT ack -- the errand is theirs now.
				if (revoked) return { ran: true, aborted: true, why: 'revoked', trace: trace };
				// PARK -> egressAllowed could not get consent and aborted the turn on
				// purpose (no attended device, or the wait timed out). This is not a
				// crash: report the park (or terminal failure at the bound) and RELEASE
				// the lease, so the turn re-dispatches or ends clean rather than stranding.
				var pkErr = d.parkRequested ? d.parkRequested(e) : null;
				if (pkErr) { stopCheck(); return await parkAndRelease(e, d, trace, pkErr); }
				// NOT EVERY THROW IS A CRASH (owner ruling 2026-09-12). A provider that
				// refused the key or the credit, a withdrawn folder grant, a lock under the
				// turn: each is a fact about THIS device that waiting cannot change, and
				// leaving it to the 15-minute deadline is exactly the hanging turn the
				// ruling forbids. So hand it back -- REPORT the reason, RELEASE the lease,
				// and leave the errand ON the relay (no ack) so another device may still
				// take it. The dispatcher's `failed` state then offers [Run here] at once.
				var ek = runnerErrorKind(err);
				if (ek) {
					stopCheck();
					var ewhy = runnerErrorWhy(ek, d.selfName, err);
					trace.push('handback');
					try { if (d.post) await d.post(reportFor(e, { status: 'error', why: ewhy, heard: heardIds() })); trace.push('report'); }
					catch (e2) { /* the release below still frees the turn */ }
					try { await settleLease('turn', turnId, d.selfId, 'released', d.cas, leaseClock); trace.push('release'); }
					catch (e2) { /* an unreleased lease still expires at its deadline */ }
					return { ran: true, error: true, handback: ek, why: ewhy, trace: trace };
				}
				// A genuine crash: do NOT ack and do NOT complete, so the relay keeps the
				// errand and the lease EXPIRES (at its deadline). The phone reclaims (§2.5).
				return { ran: true, error: true, why: String(err && err.message || err), trace: trace };
			}
			if (stoppedThere) return await endStopped();
			if (revoked) return { ran: true, aborted: true, why: 'revoked', trace: trace };
			// PARK could also be signalled without the turn throwing (egressAllowed
			// returned a refusal and the turn wound down on its own). Park takes
			// precedence over completing a half-answer: nothing past the consent point
			// ran, so there is nothing to push.
			var pkOk = d.parkRequested ? d.parkRequested(e) : null;
			if (pkOk) { stopCheck(); return await parkAndRelease(e, d, trace, pkOk); }
			// The turn produced a result: stop the liveness ticker BEFORE completing, so
			// nothing races the done/release writes below.
			stopCheck();

			// 4. COMPLETE. THE ANSWER TRAVELS BEFORE THE ACCOUNT DOES (seq 223).
			//
			// The order was push-then-report, and it cost the person who sent the turn
			// everything the push cost: on the owner's hand-off the turn ended and the
			// runner then spent 20.3 s scanning its manifests and flushing a whole parcel
			// -- which collided with a third device's push, 409'd, pulled, retried -- with
			// the finished answer sitting in it the entire time. 58.9 s total for a 3.5 s
			// turn, most of it after the model had stopped.
			//
			// So the FINAL FRAME goes first: the turn's whole rendered tail, on the
			// progress door the watcher is already reading, marked `final` so it draws it
			// and stops following. Then the lease, then the report, then the ack -- every
			// one of them a small write the originator is waiting on. The PARCEL goes LAST
			// and is not awaited: it carries the durable copy, the workspace the turn
			// touched and the session, and nobody is watching a spinner for it.
			//
			// Money-safety is unchanged and the reasoning is worth keeping: the ACK is
			// what takes the errand off the relay, and a crash before the answer is
			// durable must leave it there. The answer is durable in two places now -- the
			// final frame on the progress door, which the originator folds into its own
			// transcript, and the parcel. A crash between the two leaves the errand ACKED
			// with the answer on the door, which is the state the originator already
			// handles; what it can no longer do is strand the turn for the length of a
			// flush.
			var fin = await complete(null);
			if (fin.revoked) return { ran: true, aborted: true, why: 'revoked', trace: trace };
			if (fin.stopped) return { ran: true, done: true, stopped: true, parcelVersion: fin.parcelVersion, trace: trace };
			return { ran: true, done: true, parcelVersion: fin.parcelVersion, trace: trace };
		} finally {
			stopCheck();			// EVERY exit stops the liveness ticker -- no timer leaks.
			if (_poisonWatch[turnId] === killRun) delete _poisonWatch[turnId];
		}
	}

	// ════════════════════════════════════════════════════════════
	// THE COMPILE ON THE RUNNER
	// ------------------------------------------------------------
	// `runErrand`'s skeleton with the turn engine swapped for a layout, kept in that
	// order because the order is the money- and data-safety: nothing is written before
	// the lease is won, nothing is acked before the report is posted, and a lease taken
	// back mid-compile stops the run rather than racing it.
	// ════════════════════════════════════════════════════════════

	/// Run one compile errand end to end. Pure over injected `deps`:
	///
	///   selfId, selfName, nominatedId, presence, freshWindowMs, allowSelf, cas, now
	///                as `runErrand` takes them;
	///   finished  async (errand) -> bool: a `built` for this eid was already collected;
	///   check     async (errand) -> { ok, why }: does this device hold the folder the
	///             errand was written for (the `wsid` match), and can it compile at all;
	///   write     async (files)  -> { wrote:[paths], moved:[paths] }: put the carried
	///             bytes into the real folder. ALL of them before the compile, so the
	///             runner's own watch fires `touched` once and not once per file;
	///   compile   async (main, want) -> { vector?, pdf?, pages, watch, hashes, ms,
	///             heap:{before,after,growth,headroom}, error? }. It goes THROUGH the
	///             runner's own watch where the watch holds this document, so a write
	///             and an errand are ONE layout and one heap growth, not two;
	///   offload   async (bytes, docKey) -> manifest v2, or null where the device
	///             cannot offload (no cloud, identity locked);
	///   frame     async (cid, text, final): one line on the progress door;
	///   post      async (builtEnvelope);
	///   ack       async ().
	///
	/// Answers `{ ran, done?, error?, refused?, aborted?, why?, holder?, trace }`.
	async function runCompileErrand(errand, deps) {
		var d = deps || {}, e = errand || {};
		var cid = String(e.cid || '');
		var trace = [];
		diag('collect compile', 'cid=' + cid
			+ ' main=' + String(e.main || '')
			+ ' by=' + String(e.dispatchedBy || '').slice(0, 8));

		// The same three stand-downs a turn takes, and for the same reasons: a device
		// must not run its own dispatch on the automatic path, must not re-run a compile
		// already reported, and must leave the claim to a freshly-awake nominee.
		if (!d.allowSelf && e.dispatchedBy && String(e.dispatchedBy) === String(d.selfId)) {
			trace.push('self-dispatched');
			return { ran: false, why: 'self-dispatched', trace: trace };
		}
		if (d.finished) {
			var already = false;
			try { already = await d.finished(e); } catch (err) { already = false; }
			if (already) { trace.push('already-done'); return { ran: false, why: 'already-done', trace: trace }; }
		}
		if (!d.allowSelf && nominationStandDown(d.nominatedId, d.selfId, d.presence,
			leaseNow(d.now), d.freshWindowMs)) {
			trace.push('stood-down-for-nominee');
			return { ran: false, why: 'nominee', trace: trace };
		}
		if (!d.cas || typeof d.cas.read !== 'function') {
			trace.push('no-cas');
			return { ran: false, why: 'no-cas', trace: trace };
		}

		// 1. TAKE. The same take-if-vacant CAS a turn uses, on the compile's own key, so
		// two awake runners cannot each lay the book out and each grow a heap for it.
		var took = await leaseTake(cid, { holder: d.selfId, eid: e.eid, dispatchedBy: e.dispatchedBy,
			deadline: e.deadline, ts: e.ts }, d.cas, d.now);
		trace.push('take');
		if (!took.won) {
			return { ran: false, why: took.why || 'stood-down', holder: took.holder, trace: trace };
		}

		var revoked = false, checkStopped = false, checkTimer = null;
		var checkStart = leaseNow(d.now);
		var maxLife = (d.maxLeaseLifeMs != null) ? d.maxLeaseLifeMs : MAX_LEASE_LIFE_MS;
		var setT = d.setTimer   || (typeof setInterval   === 'function' ? setInterval   : null);
		var clrT = d.clearTimer || (typeof clearInterval === 'function' ? clearInterval : null);
		function stopCheck() {
			checkStopped = true;
			if (checkTimer != null && clrT) { try { clrT(checkTimer); } catch (err) {} checkTimer = null; }
		}
		// READ-ONLY, exactly as the turn's is: it never writes the parcel, so a compile
		// in flight causes no churn. It detects the take-back -- the phone pressed
		// "Compile here" -- and stops this run rather than letting two devices lay the
		// same book out at once. Ticker-driven only (no per-event caller), so one read a
		// tick needs no pacing.
		async function liveness() {
			if (checkStopped || revoked) return;
			if (leaseNow(d.now) - checkStart > maxLife) { stopCheck(); revoked = true; return; }
			var snap;
			try { snap = await d.cas.read(); } catch (err) { return; }
			if (!snap || snap.unread || !snap.leases) return;		// unreadable: unknown, not a revoke
			var cur = snap.leases[cid];
			if (!cur && leaseNow(d.now) <= leaseMs(e.deadline)) return;	// absent before the deadline
			if (!cur || cur.holder !== String(d.selfId) || cur.mode === 'released') {
				revoked = true;
				trace.push('abort');
				diag('collect REVOKED', 'compile=' + cid + ' why=' + (!cur ? 'absent'
					: cur.holder !== String(d.selfId) ? 'holder' : 'released'));
			}
		}
		async function say(text, final) {
			if (!d.frame) return;
			try { await d.frame(cid, text, !!final); trace.push(final ? 'final' : 'frame'); }
			catch (err) { /* a dropped frame is only a quieter stream */ }
		}
		async function release() {
			try { await settleLease('compile', cid, d.selfId, 'released', d.cas, d.now); trace.push('release'); }
			catch (err) { /* an unreleased lease still expires at its deadline */ }
		}
		async function report(f) {
			try {
				await d.post(makeBuilt(Object.assign({ eid: e.eid, cid: cid, main: e.main,
					docKey: e.docKey, by: String(d.selfId || ''), to: e.dispatchedBy }, f)));
				trace.push('report');
			} catch (err) { /* the release below still frees the compile */ }
		}

		try {
			if (setT) checkTimer = setT(function () { liveness(); }, RENEW_EVERY_MS);

			// 2. CHECK. A runner whose folder token differs from the one the errand was
			// written for refuses rather than laying out a book from another tree -- the
			// bytes would be written into the wrong project and the pages would be of a
			// document nobody asked for.
			var ck = { ok: true, why: '' };
			if (d.check) { try { ck = (await d.check(e)) || { ok: false, why: 'no answer' }; }
				catch (err) { ck = { ok: false, why: String((err && err.message) || err) }; } }
			trace.push('check');
			if (!ck.ok) {
				await report({ status: 'refused', why: String(ck.why || '') });
				await release();
				try { if (d.ack) { await d.ack(e); trace.push('ack'); } } catch (err) {}
				return { ran: false, refused: true, why: String(ck.why || ''), trace: trace };
			}

			// 3. WRITE. Every carried file before any compile, so the watch's own
			// `daimond-file-written` handler coalesces them into ONE rebuild rather than
			// one per file -- and so the compile below sees the whole set, never half of it.
			await say('gathering');
			var wrote = [], moved = [];
			if (d.write) {
				var w = (await d.write(e)) || {};
				wrote = w.wrote || [];
				moved = w.moved || [];
			}
			trace.push('write');
			if (revoked) { stopCheck(); return { ran: true, aborted: true, why: 'revoked', trace: trace }; }

			// 4. COMPILE. Through the watch where the watch holds this document, so the
			// write above and this errand are one layout: two would be two heap growths on
			// a heap that only ever grows (about 10 MB each on the author's book).
			var out;
			try { out = (await d.compile(e.main, e.want)) || {}; }
			catch (err) { out = { error: String((err && err.message) || err) }; }
			trace.push('compile');
			if (revoked) { stopCheck(); return { ran: true, aborted: true, why: 'revoked', trace: trace }; }
			var heap = out.heap || { before: 0, after: 0, growth: 0, headroom: 0 };
			if (out.error) {
				// THE RUNNER DID RUN. A compile error is the document's, not the placement's,
				// so it is reported, acked and not left on the relay for a second machine to
				// hit the same error at the same cost.
				await report({ status: 'error', why: String(out.error), ms: out.ms | 0,
					heap: heap, imports: out.watch || [], hashes: out.hashes || {}, wrote: wrote });
				await release();
				try { if (d.ack) { await d.ack(e); trace.push('ack'); } } catch (err) {}
				return { ran: true, error: true, why: String(out.error), trace: trace };
			}
			await say('laid out ' + (out.pages | 0) + ' pages in ' + (out.ms | 0) + ' ms');

			// 5. OFFLOAD. The artifact goes as chunks under the document's own key, and the
			// index rides the runner's next parcel -- a folder-mounted runner cannot COMMIT
			// it, which is exactly why the dispatcher adopts the ref and commits for it.
			var vector = null, pdf = null;
			if (d.offload) {
				if (out.vector && out.vector.length) vector = await d.offload(out.vector, e.docKey, 'vector');
				if (out.pdf && out.pdf.length)       pdf    = await d.offload(out.pdf, e.docKey, 'pdf');
			}
			trace.push('offload');
			if (vector && vector.chunks) await say('uploading ' + vector.chunks.length + ' chunks');
			if (revoked) { stopCheck(); return { ran: true, aborted: true, why: 'revoked', trace: trace }; }

			// 6. THE ANSWER TRAVELS, THEN THE ACCOUNT OF IT. The final frame first (the
			// dispatcher is watching that door), then the report, then the lease, then the
			// ack -- ack LAST, so a crash before the report leaves the errand on the relay
			// and the dispatcher's own "Compile here" is still the way out.
			stopCheck();
			await say('built', true);
			await report({
				status: moved.length ? 'stale' : 'done',
				ms: out.ms | 0, heap: heap, pages: out.pages | 0,
				imports: out.watch || [], hashes: out.hashes || {},
				wrote: wrote, moved: moved, vector: vector, pdf: pdf });
			await release();
			try { if (d.ack) { await d.ack(e); trace.push('ack'); } }
			catch (err) { /* a missed ack costs one idempotent re-collect, never a re-compile */ }
			return { ran: true, done: true, pages: out.pages | 0, vector: vector, trace: trace };
		} catch (err) {
			// A THROW BEFORE THE REPORT is a fact about THIS device, so the account goes
			// home and the lease is freed -- but the errand is NOT acked, because another
			// Hand-bearing machine may still be able to lay the document out.
			var why = String((err && err.message) || err);
			await report({ status: 'error', why: why });
			await release();
			return { ran: true, error: true, why: why, trace: trace };
		} finally {
			stopCheck();
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

	/// The dispatching-side settle probe, registered by daimond.js. Does THIS device
	/// already hold the finished turn -- a done/aborted report collected for it, or a
	/// non-empty assistant answer merged under its iturn? Null until registered (the
	/// runner-acceptance path and peer.test's older stubs); then `holdOwnDispatch` decides
	/// on the deadline alone.
	var _settled = null;
	function onSettled(fn) { _settled = fn; }

	/// Should this device keep its OWN un-run errand on the relay for a peer? Consulted by
	/// post.js `takeRow` before it HOLDs an own dispatch. NOT once the turn is settled here
	/// (a peer answered it, or this device recovered it locally): holding a settled errand
	/// leaves it for a peer waking inside the deadline to re-run and RE-BILL (S-HAND #1),
	/// and freezes the ack cursor for the row's 30-day life (S-HAND #2). NOT once no peer
	/// may start it either: `leaseTakeFromCas` refuses every claim past `deadline`, so past
	/// `deadline + LEASE_TTL_MS` the row can only freeze the cursor. Answers true = hold,
	/// which is the default and the safe direction -- the take-if-vacant lease means a held
	/// errand is never run twice, while a wrongly-dropped one costs only a local recovery.
	async function holdOwnDispatch(env, now) {
		var n = now == null ? Date.now() : now;
		var dl = leaseMs(env && env.deadline);
		if (dl && n > dl + LEASE_TTL_MS) return false;		// past the last moment any peer may start it
		// Or past the window from the turn's birth, which is where every collector now
		// refuses it (`turnAgeVerdict`); one clock, since the errand is this device's own.
		// A hold's kept facts carry the birth already read (`ownHoldFacts`).
		var born = leaseMs(env && env.born) || errandBirth(env);
		if (born && n > born + DISPATCH_DEADLINE_MS + LEASE_TTL_MS) return false;
		if (_settled) {
			try { if (await _settled(env)) return false; } catch (e) { /* on doubt, hold */ }
		}
		return true;
	}

	// How long a collector leaves a note on the relay for the device it names: the span in
	// which a hand-off can still be live (`holdOwnDispatch` holds an own errand as long).
	// Past it the parcel carries the answer home, and the row may only freeze the cursor.
	var NOTE_HOLD_MS = DISPATCH_DEADLINE_MS + LEASE_TTL_MS;
	// A consent question and its answer live only as long as the question can be answered:
	// its deadline, and this much after it for the answer on its way.
	var ANSWER_SLACK_MS = 30000;

	/// How long a note is held for its device: a question for as long as it stands, its
	/// answer for as long as a question can, and anything else `NOTE_HOLD_MS`. Pure.
	///
	/// A QUESTION'S LIFE IS ITS OWN SPAN, `deadline - ts`: two readings of the asker's one
	/// clock, which no skew moves, laid on the relay's stamp by `noteHoldOpen`. A hold that
	/// outlived its question would only pin every collector's cursor for nothing.
	function noteWindowMs(env) {
		var t = env && env.t;
		if (t === T_ASK) {
			var span = leaseMs(env.deadline) - leaseMs(env.ts);
			if (!(span > 0)) span = CONSENT_DEADLINE_MS;
			return Math.min(NOTE_HOLD_MS, span + ANSWER_SLACK_MS);
		}
		if (t === T_GRANT) return CONSENT_DEADLINE_MS + ANSWER_SLACK_MS;
		return NOTE_HOLD_MS;
	}

	/// The device a collected note must be left on the relay for, or '' when this device
	/// may take it and let the ack pass it. Pure.
	///
	/// THE RELAY'S ACK IS ONE WATERMARK FOR THE WHOLE ACCOUNT (gateway `ack_posts`): any
	/// device that acks past a row drops it for every device. A message survives that,
	/// because the collector folds it into the mailbox record the parcel carries; a note
	/// does not, because it is folded into page memory on the device that collected it.
	/// So a report acked off by the runner that posted it never reaches the dispatcher it
	/// was written for (2026-09-24, `verify_handoff_slowparcel` CASE 1): the runner's own
	/// collect folds its report, its finished run then lets the errand go and acks through
	/// both, and the phone sits on "Sent to your other devices" with [Take back] offered
	/// over a turn that has already run.
	///
	/// A note that names its device (`to`: a report's or a built's dispatcher) is held
	/// by every other collector until that device acks it or `NOTE_HOLD_MS` has passed
	/// since the relay took it. `row.ts` is the relay's arrival stamp in Unix seconds
	/// (a value already in milliseconds is read as one); `relayNow` is the relay's clock,
	/// or null where none is known yet.
	///
	/// AGED ON THE RELAY'S CLOCK OR NOT AT ALL (R3 QA Q1). The stamp is the relay's, and
	/// this device's clock is not: one running twenty minutes ahead, collecting before its
	/// first presence answer taught it the relay's, read a report posted a second ago as
	/// older than its window, took it and acked it away from the phone. With no relay clock
	/// the note is held, and the hold ends on this device's own count from here
	/// (`noteHoldOpen`), which a skewed clock does not move.
	///
	/// EVERY NOTE WITH AN ADDRESSEE IS HELD FOR IT, and one field names it: `to` (SIM-3,
	/// 2026-09-25). A consent question named its device only in `target`, which this did
	/// not read, so the runner that asked folded its own question and acked it away before
	/// the phone saw it. A question with no addressee is the owner's broadcast (every
	/// attended device raises it), so it is held for every device -- `'*'` -- for as long
	/// as it can be answered, including by the runner that asked it. Each note's window is
	/// `noteWindowMs`.
	function noteHeldFor(env, row, selfId, relayNow) {
		if (!env || env.t === T_ERRAND || env.t === T_COMPILE) return '';	// work is claimed, not held for
		var to = String(env.to || '');
		if (!to && env.t === T_ASK) to = '*';
		if (!to || to === String(selfId || '')) return '';
		// A row with no stamp cannot be aged, so it is not held: a hold that could never
		// end would freeze this device's ack cursor for the row's whole life (S-HAND #2).
		if (!(noteStampMs(row && row.ts) > 0)) return '';
		return (noteAge(row && row.ts, relayNow) > noteWindowMs(env)) ? '' : to;
	}

	/// A relay stamp in milliseconds: Unix seconds, or a value already in milliseconds.
	function noteStampMs(ts) {
		var t = leaseMs(ts);
		return t >= 1e11 ? t : t * 1000;
	}

	/// A note's age in milliseconds on the relay's clock, or -1 when no relay clock is known.
	function noteAge(ts, relayNow) {
		var rn = plausibleMs(relayNow), at = noteStampMs(ts);
		return (rn && at > 0) ? rn - at : -1;
	}

	/// What a note's hold keeps, so a later pass decides it without reading the row again
	/// (`noteHoldOpen`): the relay's stamp, this device's clock when it was first taken, and
	/// the note's age then on the relay's clock -- 0 where none was known, so the count
	/// from here is the whole of it and the hold can only run long, never short.
	///
	/// And the note's window (`noteWindowMs` of `env`), where the envelope is given.
	function noteHoldFacts(row, relayNow, now, env) {
		var n = now == null ? Date.now() : now;
		var f = { ts: leaseMs(row && row.ts), seenAt: n, age0: Math.max(0, noteAge(row && row.ts, relayNow)) };
		if (env) f.win = noteWindowMs(env);
		return f;
	}

	/// Should a held note's row be looked for on the relay again? Only while the device it is
	/// held for is awake (a beat inside `PRESENCE_FRESH_MS` in the presence view). Pure.
	///
	/// A LOOK IS THE ONLY WAY TO LEARN THE NOTE HAS BEEN TAKEN -- the relay says so by not
	/// having it -- and it costs every row above it (R3 QA Q5): read on every collect while
	/// the phone was away, it grew with the square of the rows that arrived meanwhile. An
	/// awake device can take the note at any moment, and its own collects keep the relay
	/// drained, so a look then costs little and finds the note gone on the pass after it is
	/// taken: a runner that refused a replayed turn fifteen seconds after the phone took its
	/// last report must see that at once, or its ack stays pinned below the refused errand.
	/// A device that is not awake cannot take it, and a look would only download again what
	/// is above it. A take the view has not heard of yet is found once the device's beat is.
	function noteLookAgain(deviceId, presence, now) {
		var rec = presence ? presence[String(deviceId || '')] : null;
		if (!rec) return false;
		var n = now == null ? Date.now() : now;
		return recAwake(rec, n, PRESENCE_FRESH_MS);
	}

	/// Is a note held for another device still inside its window? Pure, over the facts its
	/// hold kept (`noteHoldFacts`).
	///
	/// DECIDED FROM THOSE, NEVER FROM THE ROW AGAIN (R3 QA Q2, Q5). Re-reading a held note
	/// to decide it re-downloaded every row above it on every collect for the length of the
	/// window, and folded it again each time: a runner re-ran a `built` note's download and
	/// preview on every park wake. The age is read on the relay's clock where it is known,
	/// and otherwise as the age at first sight plus what this device has counted since --
	/// the difference of two readings of one clock, which no skew moves.
	function noteHoldOpen(h, relayNow, now) {
		var age = noteAge(h && h.ts, relayNow);
		if (age < 0) {
			var n = now == null ? Date.now() : now;
			age = (+(h && h.age0) || 0) + Math.max(0, n - leaseMs(h && h.seenAt));
		}
		return age <= ((+(h && h.win) > 0) ? +h.win : NOTE_HOLD_MS);
	}

	/// What an own errand's hold keeps, so a later pass asks `holdOwnDispatch` without
	/// reading the row again: the fields that rule and the settled probe read, with the
	/// turn's birth read once here. Small, where the envelope carries the thread's seed.
	function ownHoldFacts(env) {
		var e = env || {};
		return {
			t: T_ERRAND, eid: String(e.eid || ''), turnId: String(e.turnId || ''),
			chatId: String(e.chatId || ''), dispatchedBy: String(e.dispatchedBy || ''),
			deadline: leaseMs(e.deadline), born: errandBirth(e),
		};
	}

	/// Is a compile's account this device's to draw? Where it names its device (`to`), only
	/// that one; an older runner's names none, and the device with the compile in flight
	/// takes it, as before.
	///
	/// A NOTE IS FOLDED ON EVERY DEVICE THAT COLLECTS IT, and a `built` drawn wherever it
	/// was folded took over a third device's preview: it downloaded the artifact, stopped
	/// the document that device was watching, pulled its sheet to Preview and rewrote the
	/// sidecar (R3 QA Q2). Every device still records it, since a runner's `finished` reads
	/// it; only the one that asked draws it.
	function builtIsOurs(r, selfId, inFlight) {
		var to = String((r && r.to) || '');
		return to ? to === String(selfId || '') : !!inFlight;
	}

	// ════════════════════════════════════════════════════════════
	// THE STREAMED VIEW OF A RUNNING TURN
	// ------------------------------------------------------------
	// Two pure functions, here rather than in daimond.js because they are the whole
	// content of the streaming path and the only part of it worth testing without a
	// browser: what a frame SAYS (`progressTail`) and what a watcher DOES with one
	// that arrives (`foldProgress`). The app supplies the messages and draws the
	// result; the decisions are here.
	// ════════════════════════════════════════════════════════════

	// Any one streamed message's content share, so one huge tool argument or a giant
	// paste cannot be the whole frame. A message longer than this is clipped -- and a
	// clipped provisional row does NOT byte-match its final copy, so it is REPLACED by
	// mid on the parcel merge rather than converged; the common turn is well under it
	// and its provisional rows match their final copies exactly (no rebuild at merge).
	var PROGRESS_MSG_CHARS = 16 * 1024;
	// The roles a watcher draws (drawHistoryMessage's own set): anything else after the
	// user turn is view-only scaffolding the watcher rebuilds for itself.
	var PROGRESS_ROLES = {
		assistant: 1, think_log: 1, tool_log: 1, vision_log: 1,
		error_log: 1, note_log: 1, fold_log: 1, leak_log: 1, end_log: 1,
	};

	/// The turn's messages AFTER its own user message, as STRUCTURED rows a watcher can
	/// fold into its transcript and draw through the ordinary renderer -- not flattened
	/// text. Each row carries only what the drawing reads: `{mid, role, name, content,
	/// outcome, args, callId, folded, kept, interrupted, ts}`. A message's content is
	/// kept in FULL (up to `PROGRESS_MSG_CHARS`), so a provisional row byte-matches the
	/// final copy that syncs later and the parcel merge is a no-op redraw rather than a
	/// rebuild. The whole array is bounded by `maxChars`, OLDEST rows dropped first --
	/// what falls off the front the watcher already holds from an earlier frame.
	///
	/// Pure and DOM-free: `messages` is the chat's array. A turn whose user message is
	/// not in it answers [] -- the runner has nothing to say about a turn it does not
	/// hold, which is a quiet frame and not an error.
	function progressTail(messages, turnId, maxChars) {
		var msgs = Array.isArray(messages) ? messages : [];
		var id   = String(turnId || '');
		var cap  = (maxChars | 0) > 0 ? (maxChars | 0) : 48 * 1024;
		if (!id) return [];
		var at = -1;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m && (String(m.mid || '') === id || String(m.iturn || '') === id)
				&& m.role === 'user') { at = i; break; }
		}
		if (at < 0) return [];
		// Gather from the tail backwards under the total budget, so the OLDEST row is
		// the one dropped (the watcher already saw it), then restore document order.
		var picked = [];
		var used = 0, dropped = false;
		for (var j = msgs.length - 1; j > at; j--) {
			var row = progressRow(msgs[j]);
			if (!row) continue;
			var len = row.content ? row.content.length : 0;
			if (used + len > cap && picked.length) { dropped = true; break; }	// budget spent, oldest dropped first
			used += len;
			picked.push(row);
		}
		// A frame that left rows out is not the whole turn, so no row of it says so.
		if (dropped) for (var w = 0; w < picked.length; w++) delete picked[w].whole;
		picked.reverse();
		return picked;
	}

	/// One transcript message as a streamed structured row, or null for a view-only
	/// row a watcher does not draw. Content is kept in full up to `PROGRESS_MSG_CHARS`,
	/// and in full whatever its length when `full` is set (`turnRows`).
	///
	/// `whole: 1` says nothing was cut from it. The sender makes a final frame's rows its
	/// real answer only when every row says so (`adoptFinalFrame`); a cut row would be a
	/// truncated answer kept for good if the runner's own copy never arrived.
	function progressRow(m, full) {
		if (!m || !m.role || !PROGRESS_ROLES[m.role]) return null;
		var lim = full ? Infinity : PROGRESS_MSG_CHARS;
		var c = String(m.content == null ? '' : m.content);
		var cut = c.length > lim;
		if (cut) c = c.slice(0, lim);
		var row = { mid: String(m.mid || ''), role: m.role, content: c, ts: +m.ts || 0 };
		if (m.name)        row.name    = String(m.name);
		if (m.outcome)     row.outcome = String(m.outcome);
		if (m.args && String(m.args).length > lim) cut = true;
		if (m.args)        row.args    = String(m.args).length > lim
			? String(m.args).slice(0, lim) : String(m.args);
		if (m.callId)      row.callId  = String(m.callId);
		if (m.folded)      row.folded  = m.folded | 0;
		if (m.kept)        row.kept    = m.kept | 0;
		if (m.interrupted) row.interrupted = 1;
		// An interrupted row says why and carries the prompt its Retry re-sends; a run id says
		// which run of a handed-off turn made the row (`otherRunRows`).
		if (m.interrupted && m.why)   row.why   = String(m.why);
		if (m.interrupted && m.itext) row.itext = String(m.itext);
		if (m.run)         row.run     = String(m.run);
		if (m.interrupted && m.lostOn) row.lostOn = String(m.lostOn);
		// `ranOn` is what the answer's final copy carries (the device that ran the turn):
		// streaming it means the FINAL provisional row byte-matches the parcel copy's
		// `msgSig`, so the merge is a no-op redraw rather than a rebuild.
		if (m.ranOn)       row.ranOn   = String(m.ranOn);
		// And the run's own figures (hand-off QA F5): an adopted final frame is the answer
		// on the sender, so it carries what the runner's copy would, or its tile says
		// nothing of the model, time, tokens or cost when that copy never replaces it.
		RAN_FACTS.forEach(function (k) { if (m[k] != null && m[k] !== '') row[k] = ranFact(k, m[k]); });
		if (!cut)          row.whole   = 1;
		// THE PRODUCT RECORD, as stamped: the same object on every frame and on the final
		// copy, so a provisional row persisted before the parcel lands carries the same bytes.
		if (m.prod)        row.prod    = m.prod;
		// An ending is its figures and its word, not its content: without them the asker's
		// provisional stop line has no `how` and draws nothing until the parcel lands.
		if (m.role === 'end_log') END_FIELDS.forEach(function (k) {
			if (m[k] == null) return;
			row[k] = Array.isArray(m[k]) ? m[k].map(String) : (typeof m[k] === 'string' ? m[k] : (m[k] | 0));
		});
		return row;
	}

	// What an `end_log` carries beyond the common row: how the turn ended, why it stopped, and the tallies.
	var END_FIELDS = ['how', 'why', 'offered', 'rounds', 'calls', 'refused', 'failed', 'malformed', 'reasoned', 'missing'];

	// The figures `runTurn` stamps on a handed-off answer, and their types off the door.
	var RAN_FACTS = ['ranMs', 'ranModel', 'ranTokIn', 'ranTokOut', 'ranCost'];
	function ranFact(k, v) { return k === 'ranModel' ? String(v) : (+v || 0); }

	/// A frame's rows as the door's payload, `{v:1, msgs:[...]}` JSON, fitted to the door:
	/// `budget` is `{chars, bytes}` and `weigh(text)` what a text adds (sync.js
	/// `progressBudget`, `progressWeight`). Whole rows are left out from the OLDEST end, as
	/// `progressTail` leaves them, and none is ever cut: the door's own guard slices the
	/// string and its 413 halves it, and either cuts the JSON, so an unfitted frame over the
	/// line was lost (r52d Open 1: `whole: 1` adds ten bytes a row, and tool arguments are
	/// not in the content budget at all). A frame that left rows out is not the whole turn,
	/// so no row of it says so. '' when not even the newest row fits. Without a budget, the
	/// rows as they are.
	///
	/// `extra` adds fields beside `msgs` (a final frame's `ref` and `n`, `finalRef`), weighed
	/// with the shell so the rows are fitted to what is left.
	function frameJson(rows, budget, weigh, extra) {
		if (!Array.isArray(rows) || !rows.length) return '';
		var parts, head = '{"v":1,';
		try {
			parts = rows.map(function (r) { return JSON.stringify(r); });
			if (extra) Object.keys(extra).forEach(function (k) {
				if (k !== 'v' && k !== 'msgs') head += JSON.stringify(k) + ':' + JSON.stringify(extra[k]) + ',';
			});
		}
		catch (e) { return ''; }
		head += '"msgs":[';
		var all = head + parts.join(',') + ']}';		// JSON.stringify({ v: 1, ...extra, msgs: rows })
		if (!budget || typeof weigh !== 'function') return all;
		var shell = weigh(head + ']}');
		var chars = shell.chars, bytes = shell.bytes, keep = 0;
		for (var i = parts.length - 1; i >= 0; i--) {
			var w = weigh(parts[i]), sep = keep ? 1 : 0;		// the comma between two rows
			if (chars + w.chars + sep > budget.chars || bytes + w.bytes + sep > budget.bytes) break;
			chars += w.chars + sep;
			bytes += w.bytes + sep;
			keep++;
		}
		if (!keep) return '';
		if (keep === rows.length) return all;
		var out = rows.slice(rows.length - keep).map(function (r) {
			var c = Object.assign({}, r);
			delete c.whole;
			return JSON.stringify(c);
		});
		return head + out.join(',') + ']}';
	}

	// The run states a frame's `workers` may name (daimond.js `Workers`).
	var WORKER_STATES = ['queued', 'running', 'paused', 'done', 'error', 'stopped',
		'interrupted', 'capped', 'spend_cap', 'blocked', 'timed_out'];
	var FRAME_WORKERS_MAX = 32;		// workers read off one frame

	/// The workers a runner's frame names, `[{ id, name, status }]`, read field by field:
	/// off the door, so untrusted. An entry without an id or with a state this build does
	/// not know is dropped, and a frame from a build that sends none yields [].
	function frameWorkers(raw) {
		if (!Array.isArray(raw)) return [];
		var out = [];
		for (var i = 0; i < raw.length && out.length < FRAME_WORKERS_MAX; i++) {
			var w = raw[i];
			if (!w || typeof w !== 'object') continue;
			var id = (typeof w.id === 'string') ? w.id.slice(0, 64) : '';
			var st = (typeof w.status === 'string') ? w.status : '';
			if (!id || WORKER_STATES.indexOf(st) < 0) continue;
			var name = (typeof w.name === 'string' && w.name) ? w.name.slice(0, 80) : id;
			out.push({ id: id, name: name, status: st });
		}
		return out;
	}

	/// EVERY row of the turn, each whole (`progressRow(m, true)`), in document order up to
	/// the next user message: what a final frame stands for. `progressTail` is the view of it that fits one frame; these
	/// are the rows a watcher may make its answer (`adoptFinalFrame`), so nothing is cut or
	/// left out. [] when the turn's user message is not held.
	function turnRows(messages, turnId) {
		var msgs = Array.isArray(messages) ? messages : [];
		var id   = String(turnId || '');
		if (!id) return [];
		var asked = msgs.some(function (m) {
			return m && m.role === 'user' && (String(m.mid || '') === id || String(m.iturn || '') === id);
		});
		if (!asked) return [];
		var out = [];
		turnSpan(msgs, id).forEach(function (m) {
			var row = progressRow(m, true);
			if (row) out.push(row);
		});
		return out;
	}

	/// The rows of turn `turnId`, in document order: every row tagged `iturn === turnId`, and
	/// every row between its user message and the next that is tagged with no other turn held
	/// here. A row tagged with another held turn is that turn's wherever it stands: on a runner,
	/// a prompt queued behind a running turn lands before that turn's answer, which was then
	/// taken for the queued turn's, dropped as another run's and sent as its answer (UNBLOCK-1
	/// 3d). A tag naming no turn held here is read by position, as an untagged row is.
	function turnSpan(messages, turnId) {
		var msgs = Array.isArray(messages) ? messages : [];
		var id = String(turnId || ''), held = {}, out = [], inSpan = false, i, m, t;
		if (!id) return out;
		for (i = 0; i < msgs.length; i++) {
			m = msgs[i];
			if (!m || m.role !== 'user') continue;
			if (m.mid) held[String(m.mid)] = 1;
			if (m.iturn) held[String(m.iturn)] = 1;
		}
		for (i = 0; i < msgs.length; i++) {
			m = msgs[i];
			if (!m) continue;
			if (m.role === 'user') {
				inSpan = String(m.mid || '') === id || String(m.iturn || '') === id;
				continue;
			}
			t = String(m.iturn || '');
			if (t === id || (inSpan && !(t && held[t]))) out.push(m);
		}
		return out;
	}

	/// The rows of turn `turnId` that belong to no run but `keepRun`: what a device drops
	/// when a handed-off turn's final frame arrives, or before its runner sends one, so a
	/// run the runner lost (a reload mid-turn) leaves nothing behind beside the one that
	/// stands. `[{ mid, provisional }]`, in transcript order.
	///
	/// The turn's span is `turnSpan`. Two kinds go: a row carrying a `run` that
	/// is not `keepRun`, and, where `keepMids` is given (a final frame that is whole), a
	/// provisional row whose mid the frame does not hold. A row with no `run` was written
	/// by a build older than the field, or by the asker itself (the dispatched
	/// placeholder), and is never taken for another run's.
	function otherRunRows(messages, turnId, keepRun, keepMids) {
		var msgs = Array.isArray(messages) ? messages : [];
		var id = String(turnId || ''), keep = String(keepRun || '');
		if (!id) return [];
		var out = [];
		turnSpan(msgs, id).forEach(function (m) {
			if (!m.mid) return;
			var stale = (keep && m.run && String(m.run) !== keep)
				|| (keepMids && m.provisional && !keepMids[String(m.mid)]);
			if (stale) out.push({ mid: String(m.mid), provisional: !!m.provisional });
		});
		return out;
	}

	/// The run a final frame's rows were made by: the `run` its rows carry (the last one
	/// when a frame holds more than one), or '' from a build that stamps none.
	function frameRun(rows) {
		var run = '';
		(Array.isArray(rows) ? rows : []).forEach(function (r) { if (r && r.run) run = String(r.run); });
		return run;
	}

	// ── A final frame larger than the door (hand-off QA F4, 2026-09-25) ──
	//
	// The door keeps ONE frame per account (gateway `put_progress`: a frame for any other
	// turn id reclaims the last), newest wins, so a final frame cannot be paged across
	// several frames: a watcher reading on a tap or a 4 s tick sees only the last page. So
	// the whole rows travel as content chunks, the door the Diamonds' bytes and a compile's
	// files already take, and the final frame names them: `{v:1, ref, n, msgs}`, where
	// `msgs` is the view that fits (`progressTail`, cut, never adopted) and `ref` the
	// manifest of `{v:1, turn, msgs}` holding every row whole. A chunk nobody commits is
	// swept after the gateway's day of grace, long past any hand-off's deadline.

	/// The rows a final frame's chunk holds, checked: `obj` is the parsed chunk body, and
	/// the answer is its rows when it is this turn's, carries `n` rows, and every one is
	/// whole, or null. Untrusted until then, as everything off the door is.
	function refRows(obj, turnId, n) {
		if (!obj || obj.v !== 1 || String(obj.turn || '') !== String(turnId || '')) return null;
		if (!Array.isArray(obj.msgs) || !obj.msgs.length) return null;
		if ((n | 0) && obj.msgs.length !== (n | 0)) return null;
		return frameWhole(obj.msgs) ? obj.msgs : null;
	}

	/// Is a frame the whole of what it streams: rows, every one marked `whole` by
	/// `progressRow`, none cut and none left out? A frame from a build that marks
	/// nothing never is.
	function frameWhole(rows) {
		if (!Array.isArray(rows) || !rows.length) return false;
		for (var i = 0; i < rows.length; i++) if (!rows[i] || rows[i].whole !== 1) return false;
		return true;
	}

	/// Fold an arriving frame into what a watcher is showing: answers the new state,
	/// or null when the frame changes nothing and no redraw is owed.
	///
	/// A frame REPLACES the one before it -- it carries the whole tail as structured
	/// rows, not a delta -- so this is a newest-wins reducer and the rules are about
	/// what "newest" means:
	///
	///   * a frame for another turn is not this watcher's, and is ignored;
	///   * a seq at or below the one in hand arrived late (the door's park and the
	///     fallback poll can both answer, and either may be overtaken), and is ignored,
	///     so a late frame never rewinds the view;
	///   * `final` closes the streamed view and CARRIES the full final rows -- the last
	///     word on the turn, which no later frame reopens or overdraws.
	/// Can the turn a watched view (`foldProgress` state) stands for still hear words said into it
	/// (UNBLOCK-27 R7c)? Not once its final frame is in, nor while its newest row is its answer
	/// being written: prose with no call after it, so no seam follows, or its ending. Prose before
	/// a call is filed as working (`think_log`), so a trailing assistant row is the answer. A turn
	/// with no frame yet may still hear; its runner answers a late word `unheard` itself.
	function frameHears(view) {
		if (!view) return true;
		if (view.final) return false;
		var rows = Array.isArray(view.msgs) ? view.msgs : [];
		var last = rows.length ? rows[rows.length - 1] : null;
		if (!last) return true;
		if (last.role === 'end_log') return false;
		return !(last.role === 'assistant' && String(last.content == null ? '' : last.content).trim());
	}

	function foldProgress(state, frame) {
		var cur = state || {};
		if (cur.final) return null;
		if (!frame || !frame.turn) return null;
		if (cur.turn && String(cur.turn) !== String(frame.turn)) return null;
		if (frame.final) {
			var fin = Array.isArray(frame.msgs) ? frame.msgs : (cur.msgs || []);
			return { turn: String(frame.turn), seq: (frame.seq | 0) || (cur.seq | 0),
				msgs: fin, final: true };
		}
		var seq = frame.seq | 0;
		if (seq <= (cur.seq | 0)) return null;
		var rows = Array.isArray(frame.msgs) ? frame.msgs : [];
		if (!rows.length) return null;
		return { turn: String(frame.turn), seq: seq, msgs: rows, final: false };
	}

	/// Fold a frame's structured rows into a transcript `messages` array as PROVISIONAL
	/// rows, so the ordinary renderer draws the handed-off turn as it is produced and
	/// the tile grows exactly like a live local turn. Pure: answers a NEW array, or null
	/// when nothing changed (so the caller draws nothing).
	///
	/// The rules that keep tiles immutable and the parcel merge a no-op redraw:
	///   * a new row lands after the nearest earlier row of its frame already held, else
	///     after the turn's dispatched placeholder (the chrome tile that stands above the
	///     streaming answer and is removed when it merges), so the turn is drawn in the
	///     runner's order and a growing turn's add is an APPEND the append fast path draws
	///     without rebuilding the thread; absent a placeholder the rows go at the tail of the turn;
	///   * a REAL (non-provisional) row already in the transcript for a mid WINS -- the
	///     answer has merged, and a stale frame must never overdraw it;
	///   * a provisional row is updated in place BY MID, never moved, so a tile already
	///     shown grows rather than being rebuilt underneath the reader;
	///   * each provisional row carries the SAME mid the runner will push, so the parcel
	///     merge replaces it by mid (mergeMessages) with a byte-identical final copy --
	///     equal `msgSig`, no rebuild.
	function foldProvisional(messages, turnId, frameMsgs) {
		var msgs = Array.isArray(messages) ? messages : [];
		var id   = String(turnId || '');
		var rows = Array.isArray(frameMsgs) ? frameMsgs : [];
		if (!id) return null;
		// Where the user turn is, and where the placeholder for it sits (if any).
		var userAt = -1, placeAt = -1;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m && m.role === 'user' && (String(m.mid || '') === id || String(m.iturn || '') === id)) userAt = i;
			if (userAt >= 0 && m && m.why === REASON_DISPATCHED && String(m.iturn || '') === id) { placeAt = i; break; }
		}
		if (userAt < 0) return null;					// the watcher does not hold this turn yet
		// The mids the transcript already carries: a REAL (merged) row is authoritative
		// and a frame never touches it; a provisional row of the same mid may grow.
		var real = {}, prov = {};
		for (var k = 0; k < msgs.length; k++) {
			var mm = msgs[k];
			if (!mm || !mm.mid) continue;
			if (mm.provisional) prov[String(mm.mid)] = mm; else real[String(mm.mid)] = k;
		}
		var changed = false;
		var add = [];							// [frame index, new row]
		for (var j = 0; j < rows.length; j++) {
			var r = rows[j];
			if (!r || !r.mid) continue;
			var rid = String(r.mid);
			if (real[rid] != null) continue;			// the real copy has landed: leave it
			var want = provRow(r, id);
			var have = prov[rid];
			if (have) {
				if (provRowSig(have) !== provRowSig(want)) { copyProv(have, want); changed = true; }
			} else {
				add.push([j, want]); prov[rid] = want; changed = true;
			}
		}
		if (!changed) return null;
		if (!add.length) return msgs.slice();			// in-place growth only: same order, new content
		// Each new row goes right after the nearest EARLIER row of the frame the transcript
		// already holds (merged or provisional, by mid), so a row that arrives a frame late --
		// the answer after its thinking, tool 2 after tool 1 -- is drawn where the runner has
		// it. With no earlier row held it goes after the placeholder (or, when there is none,
		// after the turn's own last row, so a final frame folded once a later turn has begun
		// stays with its turn). Rows added together keep the frame's order, and while the
		// turn's rows end the transcript an add is a pure append.
		var out = msgs.slice();
		var endAt = userAt;
		for (var e = userAt + 1; e < out.length; e++) {
			if (out[e] && out[e].role === 'user' && String(out[e].iturn || '') !== id) break;
			endAt = e;
		}
		var baseAt = placeAt >= 0 ? placeAt + 1 : endAt + 1;
		for (var a = 0; a < add.length; a++) {
			var insAt = -1;
			for (var p = add[a][0] - 1; p >= 0 && insAt < 0; p--) {
				var pid = rows[p] && rows[p].mid ? String(rows[p].mid) : '';
				if (!pid) continue;
				for (var q = userAt; q < out.length; q++) {
					if (out[q] && String(out[q].mid || '') === pid) { insAt = q + 1; break; }
				}
			}
			if (insAt < 0) insAt = baseAt;
			out.splice(insAt, 0, add[a][1]);
		}
		return out;
	}

	/// A provisional transcript row from a streamed structured row.
	function provRow(r, turnId) {
		var m = {
			mid: String(r.mid), role: r.role,
			content: String(r.content == null ? '' : r.content),
			iturn: String(turnId || ''), ts: +r.ts || 0, provisional: 1,
		};
		if (r.name)        m.name    = String(r.name);
		if (r.outcome)     m.outcome = String(r.outcome);
		if (r.args)        m.args    = String(r.args);
		if (r.callId)      m.callId  = String(r.callId);
		if (r.folded)      m.folded  = r.folded | 0;
		if (r.kept)        m.kept    = r.kept | 0;
		if (r.interrupted) m.interrupted = 1;
		if (r.interrupted && r.why)   m.why   = String(r.why);
		if (r.interrupted && r.itext) m.itext = String(r.itext);
		if (r.run)         m.run     = String(r.run);
		if (r.interrupted && r.lostOn) m.lostOn = String(r.lostOn);
		if (r.ranOn)       m.ranOn   = String(r.ranOn);
		RAN_FACTS.forEach(function (k) { if (r[k] != null && r[k] !== '') m[k] = ranFact(k, r[k]); });
		if (r.prod)        m.prod    = r.prod;
		if (r.role === 'end_log') END_FIELDS.forEach(function (k) { if (r[k] != null) m[k] = r[k]; });
		return m;
	}
	/// Copy a provisional row's drawable fields onto an existing one, in place, so the
	/// tile grows rather than the array reordering.
	function copyProv(dst, src) {
		dst.content = src.content; dst.ts = src.ts;
		dst.name = src.name; dst.outcome = src.outcome; dst.args = src.args;
		dst.callId = src.callId; dst.folded = src.folded; dst.kept = src.kept;
		dst.interrupted = src.interrupted; dst.ranOn = src.ranOn;
		['why', 'itext', 'run', 'lostOn'].forEach(function (k) { if (src[k] != null) dst[k] = src[k]; });
		RAN_FACTS.forEach(function (k) { if (src[k] != null) dst[k] = src[k]; else delete dst[k]; });
		// Never taken away: a record, once a row has one, is the row's for good.
		if (src.prod) dst.prod = src.prod;
		if (src.role === 'end_log') END_FIELDS.forEach(function (k) { if (src[k] != null) dst[k] = src[k]; });
	}
	/// The drawable signature of a provisional row -- what a redraw or the transcript's
	/// own `msgSig` would read, so an unchanged frame folds to null AND the final frame's
	/// `ranOn`/content changes are applied (making the provisional row match the parcel
	/// copy so the merge is a no-op redraw).
	function provRowSig(m) {
		var c = m.content == null ? '' : String(m.content);
		return m.role + '#' + c.length + '#' + (m.outcome || '') + '#' + (m.name || '')
			+ '#' + (m.folded || 0) + '#' + (m.kept || 0) + '#' + (m.interrupted ? 1 : 0)
			+ '#' + (m.ranOn || '') + '#' + (m.ranMs || 0) + '#' + (m.run || '')
			+ (m.interrupted ? '#' + (m.why || '') + '#' + (m.lostOn || '') : '')
			+ (m.role === 'end_log' ? '#' + (m.how || '') + '#' + (m.why || '') : '');
	}

	// The control a dispatched turn's footer offers, given its §5 display state. The
	// TABLE, lifted out of the renderer so it is one thing a test can enumerate rather
	// than a chain of DOM branches -- and so the owner's ruling is stated once:
	//
	//   NO TAKE BACK (owner, D-20261009-23, superseding the 2026-09-17 pre-claim
	//   take-back). The person chooses where a turn runs on the "Here | <runner>" switch
	//   BEFORE sending; a turn handed to the runner runs there, and the worst case is a
	//   lost turn. A turn that failed, was aborted, or found no awake device offers
	//   [Run here] (reclaim + run locally) as recovery; a parked turn offers a re-run.
	var DISPATCH_CONTROLS = {
		dispatched:         '',			// healthy hand-off: nothing to take back (D-20261009-23)
		'no-peer-awake':    'runhere',	// nobody took it: run here
		failed:             'runhere',	// the peer stopped/refused: run here
		interrupted:        'retry',	// cut short on the runner: retry, as the switch says
		parked:             'rerun',	// survivable park: re-run
		claimed:            '',			// a peer holds it
		running:            '',			// a peer is running it
		'awaiting-consent': '',			// blocked on a live question
		blocked:            '',			// blocked on the runner
		done:               '',			// the answer draws itself
		ending:             '',			// ended "not run": its row brings Retry
	};
	/// The one control a dispatched turn's footer offers for a §5 state, or '' for none.
	///
	/// AN ANSWER IS NEVER SENT WITHOUT ITS QUESTION, NOT EVEN ON A CLICK. Where `turn`'s
	/// prompt is an ask-card answer (`isAskAnswer`), a control that would send it after
	/// the fact -- [Run here], a re-run -- becomes 'answeragain': the question it answered
	/// is opened again and the person answers it fresh, beside its options. "Chose:
	/// Detach the paths" run days later as a bare prompt is an instruction nobody gave
	/// (the 2026-09-22 delete). Take-back stays: it is pre-claim, in the same sitting.
	function dispatchControl(state, turn) {
		var s = String(state || '');
		var c = Object.prototype.hasOwnProperty.call(DISPATCH_CONTROLS, s) ? DISPATCH_CONTROLS[s] : '';
		if ((c === 'runhere' || c === 'rerun' || c === 'retry') && turn && isAskAnswer(turn.itext)) return 'answeragain';
		return c;
	}

	window.DaimondPeer = {
		ENVELOPE_V: ENVELOPE_V,
		T_ERRAND:   T_ERRAND,
		T_REPORT:   T_REPORT,
		T_ASK:      T_ASK,
		T_GRANT:    T_GRANT,
		T_UNDO:     T_UNDO,
		T_UNDONE:   T_UNDONE,
		makeErrand:  makeErrand,
		makeReport:  makeReport,
		/// Ask the runner that ran a turn to undo it (RUN-HIST); its answer is an `undone`.
		makeUndo:    makeUndo,
		/// Is `t` one of this layer's envelope tags (the collector's routing set)?
		peerType:    peerType,
		/// The two remote-consent envelopes: a runner's live question (`makeAsk`, fresh
		/// `cid` per ask) and an attended device's answer (`makeGrant`, which signs
		/// `cid`/`turnId`/`verdict` but NOT `tool`/`host`/`detail`, so the runner replays
		/// the EXACT act it held).
		makeAsk:     makeAsk,
		makeGrant:   makeGrant,
		/// Seal an envelope to this account and answer the `{ to, addr, envelope }`
		/// post body. Reuses `DaimondPost.seal`; no server is involved, which is
		/// also how it is tested.
		sealForSelf: sealForSelf,
		relayMeta:   relayMeta,
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
		/// Which envelopes are work, started after the collector lets go of the mailbox
		/// lock, and the key a device runs one of at a time.
		isWork:  isWork,
		workKey: workKey,
		busyForRec: busyForRec,
		turnWorkKey: turnWorkKey,
		/// Whether an errand is THIS device's own dispatch -- so the sender's collect
		/// leaves it on the relay for the peer rather than acking it away.
		isOwnDispatch: isOwnDispatch,
		/// Whether the sender should KEEP holding its own errand (post.js `takeRow`): false
		/// once the turn is settled here or no peer may start it any more. `onSettled`
		/// registers the "is this turn finished here?" probe daimond.js supplies.
		holdOwnDispatch: holdOwnDispatch,
		onSettled:       onSettled,
		/// The device a collected note is left on the relay for (post.js `takeRow`), or '';
		/// what its hold keeps, and whether it still stands, decided from that alone.
		noteHeldFor:     noteHeldFor,
		noteHoldFacts:   noteHoldFacts,
		noteHoldOpen:    noteHoldOpen,
		noteLookAgain:   noteLookAgain,
		NOTE_HOLD_MS:    NOTE_HOLD_MS,
		noteWindowMs:    noteWindowMs,
		/// What an own errand's hold keeps for `holdOwnDispatch` to be asked again.
		ownHoldFacts:    ownHoldFacts,
		/// Whether a compile's account is this device's to draw (daimond.js `onBuiltReport`).
		builtIsOurs:     builtIsOurs,
		/// Every report a runner posts, built from its errand or its lease.
		reportFor:       reportFor,
		/// Register the runners the collector hands a verified envelope to. Set by
		/// daimond.js; absent, `absorb` verifies and drops.
		onErrand: onErrand,
		onBusyProbe: onBusyProbe,
		decideNow: decideNow,
		startsNow: startsNow,
		onChatWorkProbe: onChatWorkProbe,
		onReport: onReport,
		/// Register the remote-consent handlers: `onAsk` raises a runner's question on
		/// an attended device; `onGrant` delivers the answer to the awaiting runner.
		onAsk:    onAsk,
		onGrant:  onGrant,
		/// Register the compile handlers: `onCompile` runs a compile errand on a machine
		/// that holds the folder; `onBuilt` delivers the runner's account to the device
		/// that asked for it.
		onCompile: onCompile,
		onBuilt:   onBuilt,
		/// Register the handler for a runner's `undone`: what an undo-turn put back.
		onUndone:  onUndone,
		/// Route a batch of collected rows by their sealed type tag (direct-drive).
		routeRows:   routeRows,
		/// Fold a peer's answer into a transcript as an append.
		foldAssistant: foldAssistant,
		/// The dispatcher's pure core: assemble the ordered plan + full errand
		/// (`buildDispatch`), and classify a `why:'dispatched'` turn against the
		/// lease (`dispatchState`). daimond.js runs the order; these hold the logic.
		buildDispatch: buildDispatch,
		/// Seal the dispatch errand, dropping the thread seed when it would not fit the
		/// relay (a large tail a synced peer already holds, which would 413 the hand-off).
		sealFittingErrand: sealFittingErrand,
		dispatchState: dispatchState,
		/// The §5 display state of a dispatched turn (dispatched/no-peer-awake/
		/// claimed/running/done/failed). Pure; daimond.js only renders it.
		uiState:       uiState,
		handBackReport: handBackReport,
		triedAfterHandBack: triedAfterHandBack,
		busyHoldsFor:       busyHoldsFor,
		settlingReport: settlingReport,
		settledLease:  settledLease,
		endingLease:   endingLease,
		endedHere:     endedHere,
		frameWhole:    frameWhole,
		frameJson:     frameJson,
		frameWorkers:  frameWorkers,
		turnRows:      turnRows,
		otherRunRows:  otherRunRows,
		turnSpan:      turnSpan,
		frameRun:      frameRun,
		refRows:       refRows,
		PROGRESS_MSG_CHARS: PROGRESS_MSG_CHARS,
		watchDecision: watchDecision,
		handoffDeadline: handoffDeadline,
		handoffExpired:  handoffExpired,
		isAskAnswer:   isAskAnswer,
		/// THE AGE OF A HANDED-OFF TURN (E-R1): whether a device may start it now, judged
		/// from its birth (`turnAgeVerdict`); the birth itself (`turnBirth`, `midMs`); the
		/// stamps a device holds for it in its own copy of the chat (`turnBirthHints`); and
		/// whether a sender may still hand it on at all (`turnInWindow`).
		turnAgeVerdict: turnAgeVerdict,
		turnBirth:      turnBirth,
		turnBirthHints: turnBirthHints,
		turnInWindow:   turnInWindow,
		midMs:          midMs,
		/// Should this turn be auto-handed to a peer, and which one? Pure; daimond.js
		/// acts on it at send-time. And the shared "which peer is awake" answer.
		autoDispatchDecision: autoDispatchDecision,
		/// Resolve the hand-off target from LIVE PRESENCE ONLY, by the owner's fallback
		/// chain -- preferred worker (live nominee id, else the star's label) → any other
		/// live non-mobile servicing desktop → local. A ghost id in any stored list is
		/// ignored; a mobile-view device is never seated. `exclude` re-resolves past a
		/// seated desktop that failed to claim, so the next desktop is tried before local.
		handoffTarget: handoffTarget,
		/// Is a presence record a MOBILE device? The beat's own `mobile` flag decides
		/// either way; the old name/viewport `mobileView` inference stands in only while
		/// that field is absent (a peer on a build that predates it).
		recMobileView: recMobileView,
		/// Does a presence record declare the RUNNER POSTURE -- that machine's own claim,
		/// carried on every beat, that it is arranged to take a handed-off turn? The one
		/// seating signal that needs nothing stored on the deciding device.
		recRunner:     recRunner,
		/// The device id and the label of a hand-off target, read from whatever shape
		/// the caller holds -- a `handoffTarget` record or a bare id string. The feed's
		/// `peer` field went out as "[object Obje" for want of these.
		/// THE THREAD AN ERRAND CARRIES, and what a runner does with it. `seedFrom`
		/// clips a chat's tail to the errand's budget; `seedGraft` answers which of
		/// those messages the runner's own copy is missing; `holdsTurn` is the
		/// reconstruct's readiness test -- does this chat carry the turn at all. All
		/// three pure, which is what moved the parcel off the dispatch's critical path.
		seedFrom:      seedFrom,
		seedGraft:     seedGraft,
		holdsTurn:     holdsTurn,
		/// The content-free thread fingerprint the errand carries (`threadSig`), over the
		/// rows `conversational` admits; `threadReadiness` is the runner's readiness check.
		conversational: conversational,
		threadSig:     threadSig,
		holdsThread:   holdsThread,
		throughOf:     throughOf,
		holdsThrough:  holdsThrough,
		threadReadiness: threadReadiness,
		SEED_MAX_MSGS:  SEED_MAX_MSGS,
		SEED_MAX_CHARS: SEED_MAX_CHARS,
		/// Should this device defer its parcel push because another device is mid-turn on
		/// a hand-off it is no part of? Pure; sync.js consults it before a push, and
		/// re-schedules rather than refusing. The 409 storm three devices made of one
		/// hand-off is what it removes.
		deferPushFor:  deferPushFor,
		peerIdOf:      peerIdOf,
		peerLabelOf:   peerLabelOf,
		/// WHERE THE NEXT TURN WILL RUN, as the line under the composer states it. The same
		/// `autoDispatchDecision` the send takes, mapped to an i18n key, a device label and
		/// whether running here is something the user must act on.
		seatPlan:      seatPlan,
		seatSwitch:    seatSwitch,
		/// This page's engine id (R5a): a native runner is offered only on the same one.
		setEngineId:   setEngineId,
		recEngineOk:   recEngineOk,
		/// WHERE ANY TASK RUNS -- the placement. A turn goes through `seatPlan` verbatim;
		/// a compile moves only for a file this device does not hold or a heap it cannot
		/// afford; a `run` moves only to a device that holds the machine hand. Pure, so
		/// `dev/verify_place.mjs` enumerates the whole rule table without a browser.
		placeTask:     placeTask,
		taskKind:      taskKind,
		TASK_KINDS:    TASK_KINDS,
		PLACE_WHYS:    PLACE_WHYS,
		/// The two key-choosing halves of the placement, lifted so the button's words and
		/// the tooltip's are one table a test can enumerate rather than two call sites.
		placeKey:      placeKey,
		placeTitleKey: placeTitleKey,
		/// Does a presence record carry a required beat field as EXPLICITLY true? Absent
		/// is unknown, never false -- the rollout rule the seq-218 regression taught.
		meetsRequire:  meetsRequire,
		/// THE COMPILE HAND-OFF. `compilePlan` decides what rides inline and what must be
		/// offloaded (and refuses an errand that is really a missed sync);
		/// `makeCompileErrand`/`makeBuilt` are the two envelopes; `runCompileErrand` is
		/// the runner's whole side, pure over injected deps; `docKeyFor` is the one key a
		/// document's live preview is stored under.
		compilePlan:       compilePlan,
		makeCompileErrand: makeCompileErrand,
		makeBuilt:         makeBuilt,
		runCompileErrand:  runCompileErrand,
		docKeyFor:         docKeyFor,
		COMPILE_FILES_MAX:    COMPILE_FILES_MAX,
		COMPILE_FILE_CHARS:   COMPILE_FILE_CHARS,
		COMPILE_INLINE_CHARS: COMPILE_INLINE_CHARS,
		COMPILE_DEADLINE_MS:  COMPILE_DEADLINE_MS,
		freshestPeer:  freshestPeer,
		/// The genuine-availability gate: `recGenuine` -- is a presence record beating AND
		/// servicing the errand channel (not a phantom background tab)? -- and
		/// `freshestGenuinePeer` -- the freshest peer that passes it. What the auto-dispatch
		/// decision selects on, so a presence-only phantom is never chosen. Given a fifth
		/// `currentBuild` argument it PREFERS (never requires) a peer on that build, so a
		/// stale peer left over from a mixed-build fleet is de-preferred, and marks the
		/// chosen record `staleBuild` when it is a known-superseded build.
		recGenuine:    recGenuine,
		recDerived:    recDerived,
		recStated:     recStated,
		freshestGenuinePeer: freshestGenuinePeer,
		/// The remote-consent decisions, pure so a test drives the money-safe bound.
		/// `attendedPeer` -- the freshest device the user is ON (foreground + recent
		/// interaction), or null; `consentRouteDecision` -- ask that peer, resolve from
		/// policy, or park; `parkOutcome` -- the new GLOBAL park total and whether it
		/// reaches the terminal spend bound.
		attendedPeer:         attendedPeer,
		recAwake:             recAwake,
		consentRouteDecision: consentRouteDecision,
		parkOutcome:          parkOutcome,
		/// The BROADCAST-consent decisions (owner rule 2026-09-09): `askRaiseDecision`
		/// -- should THIS device raise the tile for a broadcast ask (fail-safe on a
		/// resolved/expired/duplicate ask, and record-only where nobody is) -- and
		/// `grantDecision` -- the first-committed-wins resolution rule the runner spends
		/// a cid on, so exactly one grant resolves the turn and a racing second is a no-op.
		askRaiseDecision:     askRaiseDecision,
		/// Which still-open asks to raise NOW -- the return-to-foreground re-decide, so
		/// an ask that arrived while the device was hidden is not lost.
		reRaiseDecision:      reRaiseDecision,
		grantDecision:        grantDecision,
		/// THE BLOCKER's pure half (owner ruling 2026-09-12): build a record
		/// (`makeBlocker`), decide what a tile draws for it (`blockerTileSpec`),
		/// whether it can be answered away from the runner at all
		/// (`blockerAnswerable`), and the first-answer-wins rule the runner spends one
		/// on (`blockerAnswerDecision`).
		makeBlocker:          makeBlocker,
		blockerTileSpec:      blockerTileSpec,
		blockerAnswerable:    blockerAnswerable,
		blockerAnswerDecision: blockerAnswerDecision,
		PERMIT_ASKS: PERMIT_ASKS,
		permitAsk: permitAsk,
		permitRouteDecision: permitRouteDecision,
		permitOutcome: permitOutcome,
		permitNoWord:  permitNoWord,
		permitAnswerDecision: permitAnswerDecision,
		askExpired:    askExpired,
		PERMIT_ABSENT_WORD: PERMIT_ABSENT_WORD,
		PERMIT_YES:    PERMIT_YES,
		permitNotice: permitNotice,
		grantSettlesAsk: grantSettlesAsk,
		/// The two runner-self-recovery decisions: which of this device's own leases a
		/// boot should release (`staleOwnLeaseDecision`), and whether a thrown error is
		/// a hand-back rather than a crash (`runnerErrorKind` / `runnerErrorWhy`).
		staleOwnLeaseDecision: staleOwnLeaseDecision,
		runnerErrorKind:       runnerErrorKind,
		runnerErrorWhy:        runnerErrorWhy,
		CONSENT_DEADLINE_MS:  CONSENT_DEADLINE_MS,
		MAX_PARKS:            MAX_PARKS,
		/// Whether the dispatching device should RECOVER an orphaned dispatched turn
		/// locally on its return -- dispatched, not finished, not held by a live peer.
		/// daimond.js acts on it through the same lease, so it is money-safe.
		recoverDecision: recoverDecision,
		withdrawOnLoss:  withdrawOnLoss,
		/// Should this device stand down from claiming a dispatched turn, deferring to
		/// the account's nominated always-on runner? Pure; runErrand consults it before
		/// the lease take, and daimond.js supplies the nominee id + live presence.
		nominationStandDown: nominationStandDown,
		addresseeStandDown:  addresseeStandDown,
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
		poisonRuns: poisonRuns,
		reportInterrupted: reportInterrupted,
		/// A stand-down whose errand stays on the relay for one more collect.
		standDownUndecided: standDownUndecided,
		busyDepth: busyDepth,
		/// The retry on an unread door that every lease write in `runErrand` has, for a caller
		/// that revokes or releases outside it: a write, a read, and the done or released write.
		retryUnread: retryUnread,
		readTwice:   readTwice,
		settleLease: settleLease,
		/// The content address of some sealed bytes, exposed for a caller that
		/// seals by hand.
		addressOf:   addressOf,
		/// THE STREAMED VIEW of a running turn, all pure. `progressTail(messages, turnId,
		/// maxChars)` is what a runner's frame SAYS -- the turn's messages after the user
		/// turn as STRUCTURED rows (full content, oldest dropped to fit the budget), not
		/// flattened text. `foldProgress(state, frame)` is what a watcher DOES with an
		/// arriving frame: newest-wins replacement, a late or foreign frame ignored, and
		/// `final` carrying the full rows once the real transcript has landed.
		/// `foldProvisional(messages, turnId, frameMsgs)` folds those rows INTO a
		/// transcript as PROVISIONAL messages the ordinary renderer draws -- the immutable
		/// tile that grows like a live turn and is replaced by mid on the parcel merge.
		progressTail:    progressTail,
		foldProgress:    foldProgress,
		foldProvisional: foldProvisional,
		/// Can a watched turn still hear words said into it (UNBLOCK-27 R7c)?
		frameHears:      frameHears,
		/// The footer control a dispatched turn offers for a §5 state -- 'runhere',
		/// 'rerun', 'answeragain' or '' (none). Pure table, so the owner's no-take-back
		/// ruling (D-20261009-23) is one thing a test enumerates.
		dispatchControl: dispatchControl,
	};
})();
