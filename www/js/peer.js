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

	/// Is `t` a peer envelope tag this layer owns? The collector routes exactly these
	/// six and hands everything else (a message artefact) to the message path.
	function peerType(t) {
		return t === T_ERRAND || t === T_REPORT || t === T_ASK || t === T_GRANT
			|| t === T_COMPILE || t === T_BUILT;
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
			// The Diamond this errand's chat belongs to, or '' for an ordinary chat. A
			// daimon errand is serviced by `steer_crystal` (the crystal-agent turn), not
			// the chat engine, so the runner has to know which it is BEFORE it reconstructs
			// -- the chatId alone cannot say, an older phone build carries none, and the
			// runner then falls back to the reconstructed `ctx.chat.diamondId`.
			diamondId: String(o.diamondId || ''),
			prompt:  String(o.prompt == null ? '' : o.prompt),
			model:   o.model || null,		// { provider, model, url } -- models.js:127-129
			scope:   o.scope || null,		// the workspace fence -- scopeChatTo, daimond.js:17553
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
			status:  String(o.status || 'done'),	// done | refused-spend | error | aborted | parked | undeliverable
			parcelVersion: o.parcelVersion | 0,	// which version already carries the answer
			cost:    o.cost || null,
			why:     o.why ? String(o.why) : '',	// a human sentence for the failure states
			// The GLOBAL park counter carried home so a re-dispatcher (any device that
			// collects this report) bumps from the true total, never from a device-local
			// zero. Only meaningful on a `parked` report; 0 elsewhere.
			parkCount: o.parkCount | 0,
			// Whether the answer ALREADY travelled, as the final frame on the progress
			// door, ahead of the parcel. 1 means the originator can show the finished turn
			// now and need not wait for a version; 0 is the old behaviour (a runner on an
			// older build), where the parcel is the first sight of it.
			finalTail: o.finalTail | 0,
			ts:      o.ts || Date.now(),
		};
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
			deadline:     +o.deadline || 0,		// epoch-ms (NOT |0: ms overflows 32 bits)
			dispatchedBy: String(o.dispatchedBy || ''),	// the runner, so the grant routes home
			target:  String(o.target || ''),	// the device that should raise/answer this ask
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
		if (!obj || !peerType(obj.t)) {
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
	function onErrand(fn) { _onErrand = fn; }
	function onReport(fn) { _onReport = fn; }
	function onAsk(fn)    { _onAsk = fn; }
	function onGrant(fn)  { _onGrant = fn; }
	function onCompile(fn) { _onCompile = fn; }
	function onBuilt(fn)   { _onBuilt = fn; }

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
		else if (obj.t === T_ASK    && _onAsk)    await _onAsk(obj, row);
		else if (obj.t === T_GRANT  && _onGrant)  await _onGrant(obj, row);
		// A compile stands down the same way an errand does -- the result is propagated
		// so takeRow can HOLD the errand on the relay for a runner that deferred.
		else if (obj.t === T_COMPILE && _onCompile) result = await _onCompile(obj, row);
		else if (obj.t === T_BUILT   && _onBuilt)   await _onBuilt(obj, row);
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
	// no more: a tail of messages, each clipped, under a total budget, so the errand
	// stays a small sealed envelope on the post door rather than a second parcel.
	// Measured against the live fault it exists to remove -- a 7.86 MB parcel flushed
	// BEFORE the errand was posted -- these are three orders of magnitude smaller.
	var SEED_MAX_MSGS  = 24;				// the thread's tail, newest-last
	var SEED_MAX_CHARS = 64 * 1024;			// the whole seed's content budget
	var SEED_MSG_CHARS = 16 * 1024;			// any one message's share of it

	/// THE THREAD THE ERRAND CARRIES. Pure over a chat's `messages`: the tail, ending
	/// at the turn's own user message, each message clipped to `SEED_MSG_CHARS` and
	/// the whole under `SEED_MAX_CHARS`, oldest dropped first.
	///
	/// This is the whole of why the errand no longer waits for the parcel. The order
	/// was push-then-post because a peer must never claim an errand whose prompt it
	/// cannot read -- and on a phone carrying a 7.86 MB account that push was 23.3 s
	/// of the 27.6 s the owner waited to see the claim, for a conversation measured in
	/// kilobytes. The safety property is unchanged and the means are different: the
	/// runner reads the thread off the ERRAND, and the parcel (the workspace, the
	/// Diamonds, the rest of the account) follows in the background.
	///
	/// Only the roles a model is fed travel: `user`, `assistant` and `tool`. A
	/// `think_log`, a `vision_log` and every other view-only row are left out --
	/// the runner rebuilds its own. Answers null where there is nothing to seed,
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
			if (!mm || !mm.role) continue;
			if (mm.role !== 'user' && mm.role !== 'assistant' && mm.role !== 'tool') continue;
			if (mm.interrupted) continue;			// a half turn is not history
			var body = String(mm.content == null ? '' : mm.content);
			if (body.length > SEED_MSG_CHARS) body = body.slice(0, SEED_MSG_CHARS);
			if (used + body.length > cMax && keep.length) break;	// the budget, oldest dropped first
			used += body.length;
			keep.unshift({ role: mm.role, content: body, mid: String(mm.mid || ''), ts: +mm.ts || 0 });
		}
		if (!keep.length) return null;
		return {
			chatId:   String(c.id || ''),
			title:    String(c.title || ''),
			provider: String(c.provider || ''),
			model:    String(c.model || ''),
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
	function seedGraft(chat, errand) {
		var e = errand || {}, seed = e.seed;
		if (!seed || !Array.isArray(seed.msgs) || !seed.msgs.length) return [];
		var have = {}, msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (m && m.mid) have[String(m.mid)] = 1;
		}
		var out = [];
		for (var j = 0; j < seed.msgs.length; j++) {
			var sm = seed.msgs[j];
			if (!sm || !sm.mid || have[String(sm.mid)]) continue;
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
	/// no content, only the shape of the prefix a model would be fed. Only user|assistant|
	/// tool travel to a model; a half turn (interrupted) and a render-only provisional row
	/// are not history and are skipped, exactly as `seedFrom` skips them.
	function threadSig(chat, turnId) {
		var msgs = (chat && Array.isArray(chat.messages)) ? chat.messages : [];
		var id   = String(turnId || '');
		var parts = [], n = 0;
		for (var i = 0; i < msgs.length; i++) {
			var m = msgs[i];
			if (!m || !m.role) continue;
			if (m.role === 'user' && String(m.mid || '') === id) break;	// stop AT the turn's user message
			if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
			if (m.interrupted || m.provisional) continue;
			parts.push(m.role + ':' + String(m.mid || ''));
			n++;
		}
		return { n: n, sig: fnv1a(parts.join('\n')) };
	}

	/// Does this chat hold EXACTLY the thread the errand was dispatched from -- the same
	/// model-facing prefix, by `{ n, sig }`? The reconstruct's readiness test (S-HAND #3):
	/// a runner whose parcel is behind or ahead does not match, so it hands the turn back
	/// undeliverable rather than running the model against a stale or truncated conversation.
	/// An errand without `thread` (an older dispatcher) falls back to `holdsTurn`, the
	/// pre-fix readiness, so a mixed-build fleet still hands off in both directions.
	function holdsThread(chat, errand) {
		var e = errand || {};
		if (!e.thread || typeof e.thread.n !== 'number') return holdsTurn(chat, e.turnId);
		var mine = threadSig(chat, e.turnId);
		return mine.n === (e.thread.n | 0) && mine.sig === (e.thread.sig >>> 0);
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
		// The peer must run the model the CHAT chose, not the peer's own default.
		var model    = o.model || { provider: c.provider || '', model: c.model || '', url: String(o.url || '') };
		// The Diamond the chat belongs to, so the runner services a daimon turn through
		// `steer_crystal` rather than the chat engine. Taken from the caller, or the chat.
		var diamondId = String(o.diamondId || c.diamondId || '');
		var scope    = o.scope || null;			// the workspace fence -- scopeChatTo, daimond.js:17553
		var pause    = o.pause || null;			// pause-tree snapshot pinned to dispatch -- §1.1
		var deadline = leaseMs(o.deadline) || (now + DISPATCH_DEADLINE_MS);
		var by       = String(o.dispatchedBy || '');
		// The prior-park total this dispatch inherits (0 on a first dispatch). A
		// re-dispatch of a parked turn carries the GLOBAL count read from the synced
		// placeholder / parked report, so the ≤MAX_PARKS bound holds across devices.
		var parkCount = o.parkCount | 0;
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
		var thread = (o.thread !== undefined) ? o.thread : threadSig(c, turnId);
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
					prompt: prompt, model: model,
					scope: scope, pause: pause, parcelVersion: parcelVersion,
					deadline: deadline, dispatchedBy: by, parkCount: parkCount, ts: now,
					seed: seed, thread: thread,
				});
			},
			// The fully-resolved fields (bar parcelVersion), exposed for inspection.
			fields: {
				turnId: turnId, chatId: chatId, diamondId: diamondId, prompt: prompt,
				model: model, scope: scope,
				pause: pause, deadline: deadline, dispatchedBy: by, eid: eid, parkCount: parkCount,
				seed: seed, thread: thread,
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
		var cMax0   = Math.min(SEED_MAX_CHARS, Math.floor(lim * 3 / 4) - prompt.length - 4096);
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
	///   failed         -- report a failure (a terminal park included), OR the lease
	///                     expired mid-run with no report (the peer stopped): the `why`
	///                     sentence + [Run here]
	/// `ask` is a collected consent-ask envelope for this turn, or null.
	function uiState(turn, lease, report, selfId, now, ask) {
		if (!turn || turn.why !== REASON_DISPATCHED) return 'not-dispatched';
		var n = now == null ? Date.now() : now;
		// A report settles it either way, and outlives the lease.
		if (report && report.t === 'report') {
			if (report.status === 'done')   return 'done';
			if (report.status === 'parked') return 'parked';	// survivable: re-runs when a human is back
			// UNDELIVERABLE is not terminal: the peer could not sync the chat and handed
			// the turn back, and the dispatcher is running it locally now (or the backstop
			// will). Keep the spinner ('claimed'), not a [Run here] failure, while that
			// happens -- if the local recovery genuinely stalls the deadline still lands it.
			if (report.status === 'undeliverable') return 'claimed';
			return 'failed';									// aborted / error / refused-spend: terminal
		}
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
	function recGenuine(rec, now, windowMs) {
		if (!rec) return false;
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
		hand, folder) {
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
			next[String(id)] = recOut;
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
		/// The awake peers, and one device's name, for the UI and auto-dispatch.
		awake:    presenceAwake,
		name:     presenceName,
		forget:   presenceForget,
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
	function recAttended(rec, now, windowMs) {
		if (!rec || !rec.attended) return false;
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
	function recAwake(rec, now, windowMs) {
		if (!rec) return false;
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
		if (src && src !== self && recAwake(p[src], n, o.windowMs)) {
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
		if (o.deadline && n > (+o.deadline || 0))  return { raise: false, why: 'expired' };
		if (x.alreadyUp)                           return { raise: false, why: 'dedup' };
		if (!x.canAnswer)                          return { raise: false, why: 'unattended' };
		return { raise: true, why: 'broadcast' };
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

	/// Answers `{ target, reason }` where `target` is `{ deviceId, name, lastSeen, build,
	/// staleBuild? }` or null (→ run local), and `reason` is one of
	/// `nominee` / `nominee-presumed` / `worker` / `other-desktop` / `local`.
	function handoffTarget(presence, opts, now) {
		var o = opts || {}, p = presence || {};
		var self = String(o.selfId || '');
		var n = now == null ? Date.now() : now;
		var w = o.windowMs || DISPATCH_FRESH_MS;
		var nomWin = (o.presumeNomineeWindowMs && o.presumeNomineeWindowMs > w) ? o.presumeNomineeWindowMs : w;
		var cur = String(o.currentBuild || '');
		var pref = normLabel(o.preferredLabel);
		var nom = String(o.nominatedId || '');
		var exclude = o.exclude || {};

		// (a) THE PREFERRED WORKER by its raw nominated id, when that id is itself a LIVE,
		// non-mobile presence entry. Judged on the BARE BEAT (not recGenuine) -- the SAME
		// liveness the CLAIM arbitration uses (nominationStandDown / lastSeen) -- so a
		// beating nominee whose serviced_at is stale in this snapshot is still seated on the
		// nominee (repro_nominee_stolen), and one last known within the presume window (an
		// unconfirmed cold snapshot) is trusted live (repro_nominee_unconfirmed). A ghost id
		// absent from presence simply misses this, and the label match below recovers it.
		if (nom && nom !== self && !exclude[nom]) {
			var nr = p[nom];
			if (nr && !recMobileView(nr) && meetsRequire(nr, o.require)
				&& (n - leaseMs(nr.lastSeen)) <= nomWin) {
				var presumed = (n - leaseMs(nr.lastSeen)) > w;		// seated on trust, not a fresh beat
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
				if (!r || recMobileView(r) || !meetsRequire(r, o.require)) continue;
				if ((n - leaseMs(r.lastSeen)) > w) continue;
				if (normLabel(r.name) !== pref) continue;
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
		// The posture OUTRANKS the servicing stamp on purpose. `serviced_at` answers "is this
		// tab collecting errands right now", which a runner holding a wake lock can fail
		// momentarily (a backoff round, a reload, a throttled tick) without ceasing to be the
		// runner; the posture answers "is this machine arranged to collect", which is the
		// question seating asks. Money-safety is untouched either way -- the lease CAS is
		// still the single-runner arbiter, and the dispatcher-side recovery timer reclaims a
		// turn nobody ran. It sits BELOW the star, so an explicit nomination still wins.
		var runners = [];
		for (var id3 in p) {
			if (!Object.prototype.hasOwnProperty.call(p, id3)) continue;
			if (id3 === self || exclude[id3]) continue;
			var r3 = p[id3];
			if (!r3 || !recRunner(r3) || recMobileView(r3) || !meetsRequire(r3, o.require)) continue;
			if ((n - leaseMs(r3.lastSeen)) > w) continue;
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
			if (!r2 || recMobileView(r2) || !meetsRequire(r2, o.require)) continue;
			if (!recGenuine(r2, n, w)) continue;
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
	function autoDispatchDecision(chat, presence, opts, now) {
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
		}, n);
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
	///   { where, key, label, deviceId, warn, why, reason, dispatch, staleBuild }
	///
	/// `where` is `runner` (the account's nominated always-on device), `desktop` (another
	/// live desktop, the runner being absent) or `local` (here). `key` is the i18n key for
	/// the line and `label` its `{name}`; `warn` is true only where running here is a thing
	/// the user must act on -- a mobile device, which must stay foregrounded -- and `why`
	/// then names the reason the line can give: `chat-local`, `runner-silent` or
	/// `no-desktop`.
	function seatPlan(chat, presence, opts, now) {
		var o = opts || {}, p = presence || {};
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
			var nomLive = !!(nrec && (n - leaseMs(nrec.lastSeen)) <= w);
			var fallback = !onRunner && nom && !nomLive;
			return {
				where:      onRunner ? 'runner' : 'desktop',
				key:        onRunner ? 'seat.on_runner'
					: (fallback ? 'seat.on_desktop_runner_off' : 'seat.on_desktop'),
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
		var why = (d.reason === 'chat-local') ? 'chat-local'
			: (nom2 && !(nrec2 && (n - leaseMs(nrec2.lastSeen)) <= w)) ? 'runner-silent'
			: 'no-desktop';
		return {
			where:    'local',
			key:      mob ? 'seat.local_mobile' : 'seat.local',
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
	// How often the runner streams the running turn's transcript to the mailbox, so a
	// peer watching the hand-off sees the thinking and tool calls unfold rather than a
	// blank wait until the turn finishes. Faster than the liveness ticker because it is
	// the UX cadence, not the lease cadence. A tick sends ONE SMALL FRAME -- the turn's
	// rendered tail through the progress door (sync.js pushProgressFrame), tens of
	// kilobytes at most -- and not the whole account parcel, which is what made this
	// cadence affordable; a tick whose tail is unchanged sends nothing at all.
	var PROGRESS_EVERY_MS = 2000;
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
		var last = Math.max(leaseMs(r.expiry), leaseMs(r.deadline), leaseMs(r.renewedAt));
		return now - last > LEASE_TTL_MS;
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
	///  - both vacant -> the fresher record, kept for one TTL past its deadline, then
	///    drained (`deadLease`, applied in `mergeLeases`). A dead lease grants nothing,
	///    so this never decides a claim; keeping it briefly only lets a tombstone
	///    outlive the stale live copy it supersedes.
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
		// THE DRAIN (fix for the S1 lease-door 413). A dead record re-arriving from a
		// device that has not merged yet is re-added by the union loop above and dropped
		// again here, so the map stays bounded rather than growing one entry per turn for
		// ever. Every proposal and every local view folds through this one choke point.
		for (k in out) {
			if (Object.prototype.hasOwnProperty.call(out, k) && deadLease(out[k], now)) delete out[k];
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
		var n  = now == null ? Date.now() : now;
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
		var n = now == null ? Date.now() : now;
		for (var id in _leases) {
			if (!Object.prototype.hasOwnProperty.call(_leases, id)) continue;
			var r = _leases[id];
			if (liveLease(r, n) && String(r.holder || '') === who) return true;
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
	/// exists (the merge drops the claim), when the deadline has passed, or when
	/// the CAS could not be won in bounds.
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
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var now = leaseNow(nowFn);
			var deadline = leaseMs(o.deadline);
			if (deadline && now > deadline) {
				return { won: false, why: 'deadline' };
			}
			// A SETTLED lease is the tombstone of a turn a peer already finished
			// (leaseSetCas stamps `settled:1` on done->released). It reads VACANT, so without
			// this a taker whose collect delivered the errand and the done report in one page
			// would route the errand first and take the freed lease -- a second run, a second
			// charge (S-HAND #1). The proof of completion is in the lease, which every taker
			// reads before it takes, so it stands down here on the snapshot in hand.
			var settledCur = snap && snap.leases ? snap.leases[tid] : null;
			if (settledCur && settledCur.settled) return { won: false, why: 'settled' };
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
			// A SIZE refusal is not a race: the door weighed the sealed blob and it does
			// not fit (DaimondWire.fits, or a real 413). Retrying spins MAX_TAKE_TRIES
			// times against a fixed-size refusal for no gain, so stand down at once with
			// the honest reason -- the drain heals the door as records age out.
			if (res.why === 'too_large') return { won: false, why: 'too_large' };
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
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
		}
		return { ok: false, why: 'exhausted' };
	}

	/// COMPLETE (mode 'done') or RELEASE (mode 'released', which is vacant) a lease
	/// this device holds, with the act reported to the debug feed.
	async function leaseSet(turnId, holder, mode, cas, nowFn) {
		var res = await leaseSetCas(turnId, holder, mode, cas, nowFn);
		dsHandoff({
			act:  mode === 'released' ? 'release' : 'complete',
			turn: String(turnId).slice(0, 24),
			ok:   res && res.ok ? 1 : 0,
			why:  String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// The write itself. `release` is also how the phone takes a turn back from a
	/// live peer (§3.3): the peer's read-only liveness check sees it released and aborts.
	async function leaseSetCas(turnId, holder, mode, cas, nowFn) {
		var tid = String(turnId), h = String(holder);
		for (var attempt = 0; attempt < MAX_TAKE_TRIES; attempt++) {
			var snap = await cas.read();
			var now  = leaseNow(nowFn);
			var cur  = snap.leases[tid];
			if (!cur || cur.holder !== h) {
				_leases = mergeLeases(_leases, snap.leases, now);
				return { ok: false, why: 'not_ours' };
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
				turnId: tid, eid: cur.eid, holder: h, mode: mode,
				deadline: leaseMs(cur.deadline),
				expiry: mode === 'released' ? 0 : cur.expiry, renewedAt: now,
				settled: (mode === 'released' && cur.mode === 'done') ? 1 : (cur.settled | 0),
			};
			var proposed = mergeLeases({ [tid]: next }, snap.leases, now);
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { _leases = proposed; return { ok: true }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
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
		var res = await leaseRevokeCas(turnId, cas, nowFn);
		dsHandoff({
			act:  'rescue',
			turn: String(turnId).slice(0, 24),
			ok:   res && res.ok ? 1 : 0,
			why:  String((res && res.why) || '').slice(0, 16),
		});
		return res;
	}

	/// The write itself.
	async function leaseRevokeCas(turnId, cas, nowFn) {
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
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
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

	var BLOCKER_KINDS = ['consent', 'ask', 'fsa', 'lock', 'provider'];

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
		return kind === 'consent' || kind === 'ask';
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
	function blockerTileSpec(blocker, name) {
		var b = blocker || {};
		var kind = blockerKind(b.kind) ? String(b.kind) : '';
		var spec = {
			kind:      kind || 'unknown',
			name:      String(name || ''),
			detail:    String(b.detail || ''),
			tool:      String(b.tool || ''),
			host:      String(b.host || ''),
			options:   Array.isArray(b.options) ? b.options.slice(0, BLOCKER_OPTIONS_MAX) : [],
			since:     +b.since || 0,
			answerable: blockerAnswerable(kind),
			controls:  [],
		};
		if (kind === 'consent')                          spec.controls = ['grant', 'deny'];
		else if (kind === 'ask' && spec.options.length)  spec.controls = ['choose'];
		else                                             spec.controls = ['runhere'];
		return spec;
	}

	/// The live blocker on a turn, or null. A blocker on a lease that is no longer
	/// live grants nothing and is not shown: the question died with the turn.
	function blockerOf(turnId, now) {
		var r = _leases[String(turnId)];
		if (!liveLease(r, now == null ? Date.now() : now)) return null;
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
				_leases = mergeLeases(_leases, snap.leases, now);
				return { ok: false, why: 'not_ours' };
			}
			var next = {
				turnId: tid, eid: cur.eid, holder: h, mode: cur.mode,
				deadline: leaseMs(cur.deadline), expiry: cur.expiry,
				renewedAt: Math.max(now, leaseMs(cur.renewedAt) + 1),
			};
			if (blocker) next.blocker = makeBlocker(blocker);
			var proposed = mergeLeases({ [tid]: next }, snap.leases, now);
			// The merge keeps the record it judges fresher; a proposal that lost is a
			// sibling writing the same lease, so re-read and try again rather than
			// pushing a record the merge has already discarded.
			if (!proposed[tid] || proposed[tid].holder !== h) continue;
			var res = await cas.write(snap.version, proposed);
			if (res.ok) { _leases = proposed; return { ok: true, blocked: !!blocker }; }
			if (res.why === 'too_large') return { ok: false, why: 'too_large' };	// not a race: no retry
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
	/// genuinely in flight here, so a second tab of the same device cannot release
	/// the lease out from under the tab that is actually working.
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
	function runnerErrorWhy(kind, name) {
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
		complete:  function (turnId, holder, cas, nowFn) { return leaseSet(turnId, holder, 'done', cas, nowFn); },
		release:   function (turnId, holder, cas, nowFn) { return leaseSet(turnId, holder, 'released', cas, nowFn); },
		/// The phone's take-back: revoke whoever holds the lease (§3.3).
		revoke:    leaseRevoke,
		/// THE BLOCKER: raise what is stopping the runner onto its own lease record,
		/// clear it when it is answered, and read the live one off a turn. Only the
		/// holder may write; every device reads.
		block:     leaseBlock,
		unblock:   leaseUnblock,
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
	///   reconstruct  async (errand) -> ctx: pull to >= parcelVersion, find the chat,
	///                `scopeChatTo`, apply `pause`, fetch chunks;
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
	///   pushProgress optional async (turnId): stream the RUNNING turn's transcript
	///                tail to the progress door on a timer, so a peer watching the
	///                hand-off sees it unfold. ONE SMALL FRAME per tick, keyed by the
	///                turn -- no new turn, no new lease, no second charge, and not the
	///                account parcel (which travels once, at the end, through
	///                `pushResult`). A no-op when the tail has not changed.
	///                Absent (runner-acceptance, tests) -> no streaming, no timer.
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
			if (d.post) await d.post(makeReport({
				eid: e.eid, turnId: turnId, chatId: e.chatId,
				status: terminal ? 'aborted' : 'parked', why: why, parkCount: out.next }));
			trace.push('report');
		} catch (err) { /* the release below still frees the turn */ }
		try { await leaseSet(turnId, d.selfId, 'released', d.cas, d.now); trace.push('release'); }
		catch (err) { /* an unreleased lease still expires at its deadline */ }
		return { ran: true, parked: !terminal, terminal: terminal, why: why, parkCount: out.next, trace: trace };
	}

	async function runErrand(errand, deps) {
		var d = deps || {}, e = errand || {};
		var turnId = String(e.turnId);
		var trace = [];
		diag('collect errand', 'turn=' + turnId
			+ ' by=' + String(e.dispatchedBy || '').slice(0, 8)
			+ ' self=' + String(d.selfId || '').slice(0, 8)
			+ ' nominee=' + String(d.nominatedId || 'none').slice(0, 8));

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
			var _nom = String(d.nominatedId || '');
			var _rec = _nom ? ((d.presence || {})[_nom]) : null;
			var _beat = _rec ? Math.round((leaseNow(d.now) - leaseMs(_rec.lastSeen)) / 1000) + 's' : 'absent';
			var _stand = !d.allowSelf && nominationStandDown(d.nominatedId, d.selfId, d.presence, leaseNow(d.now), d.freshWindowMs);
			diag('collect nominee check', 'turn=' + turnId
				+ ' nominee=' + (_nom ? _nom.slice(0, 8) : 'none')
				+ ' present=' + (_rec ? 'Y' : 'N') + ' beat=' + _beat
				+ ' -> ' + (_stand ? 'STAND DOWN for nominee' : 'proceed to claim'));
		}
		if (!d.allowSelf && nominationStandDown(d.nominatedId, d.selfId, d.presence, leaseNow(d.now), d.freshWindowMs)) {
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

		// 1. TAKE. Stand down -- never run -- if a peer already holds it.
		var tTake = leaseNow(d.now);
		var took = await leaseTake(turnId,
			{ holder: d.selfId, eid: e.eid, deadline: e.deadline }, d.cas, d.now);
		trace.push('take');
		if (!took.won) {
			diag('collect stand-down', 'turn=' + turnId + ' peer holds ('
				+ (took.why || '?') + ' holder=' + String(took.holder || '').slice(0, 8) + ')');
			return { ran: false, why: took.why || 'stood-down', holder: took.holder, trace: trace };
		}
		diag('collect CLAIMED', 'turn=' + turnId + ' by ' + String(d.selfId || '').slice(0, 8)
			+ ' take=' + (leaseNow(d.now) - tTake) + 'ms');

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
		var checkStart = leaseNow(d.now);
		var maxLife = (d.maxLeaseLifeMs != null) ? d.maxLeaseLifeMs : MAX_LEASE_LIFE_MS;
		var setT = d.setTimer   || (typeof setInterval   === 'function' ? setInterval   : null);
		var clrT = d.clearTimer || (typeof clearInterval === 'function' ? clearInterval : null);
		function stopCheck() {
			checkStopped = true;
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
				try { if (d.post) await d.post(makeReport({ eid: e.eid, turnId: turnId, chatId: e.chatId,
					status: undeliverable ? 'undeliverable' : 'error', why: rwhy })); }
				catch (e2) { /* the release below still frees the turn */ }
				try { await leaseSet(turnId, d.selfId, 'released', d.cas, d.now); trace.push('release'); }
				catch (e2) { /* an unreleased lease still expires at its deadline */ }
				if (undeliverable) {
					try { if (d.ack) { await d.ack(e); trace.push('ack'); } }
					catch (e2) { /* a missed ack costs one idempotent re-collect, never a re-run: finished guards it */ }
				}
				return { ran: false, error: true, undeliverable: undeliverable, why: rwhy, trace: trace };
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
			if (setT) checkTimer = setT(function () { liveness(); if (d.heartbeat) d.heartbeat(); }, RENEW_EVERY_MS);
			// STREAM THE RUNNING TURN. Through the length of the run, push the transcript
			// as it stands so a peer watching the hand-off sees it unfold. A no-op dep
			// (the runner-acceptance path, and peer.test) starts no timer, so this is
			// invisible where it is not wired. Money-safe: `pushProgress` is the SAME
			// account parcel under compare-and-set -- no new turn, no new lease, no
			// second charge -- and it never waits, so it cannot stall the turn. Stopped
			// by stopCheck on every exit, before the final pushResult.
			if (setT && d.pushProgress) {
				progressTimer = setT(function () {
					if (checkStopped || revoked) return;
					// The turn id is PASSED: a frame is keyed by the turn it belongs to, so the
					// dep cannot be left to guess which turn this device is running.
					try { d.pushProgress(turnId); } catch (err) { /* a dropped frame is only a slower stream */ }
				}, PROGRESS_EVERY_MS);
			}
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
					var ewhy = runnerErrorWhy(ek, d.selfName);
					trace.push('handback');
					try { if (d.post) await d.post(makeReport({ eid: e.eid, turnId: turnId,
						chatId: e.chatId, status: 'error', why: ewhy })); trace.push('report'); }
					catch (e2) { /* the release below still frees the turn */ }
					try { await leaseSet(turnId, d.selfId, 'released', d.cas, d.now); trace.push('release'); }
					catch (e2) { /* an unreleased lease still expires at its deadline */ }
					return { ran: true, error: true, handback: ek, why: ewhy, trace: trace };
				}
				// A genuine crash: do NOT ack and do NOT complete, so the relay keeps the
				// errand and the lease EXPIRES (at its deadline). The phone reclaims (§2.5).
				return { ran: true, error: true, why: String(err && err.message || err), trace: trace };
			}
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
			// and stops following. Then the report, then the lease, then the ack -- every
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
			var finalTail = '';
			if (d.finalFrame) {
				try { finalTail = String((await d.finalFrame(turnId)) || ''); trace.push('final-frame'); }
				catch (err) { /* a dropped final frame only means the parcel is the first sight */ }
			}
			try {
				await d.post(makeReport({ eid: e.eid, turnId: turnId, chatId: e.chatId,
					status: 'done', parcelVersion: 0, finalTail: finalTail ? 1 : 0 }));
				trace.push('report');
			} catch (err) { /* the report is only the nudge; the frame already carried the answer */ }
			await leaseSet(turnId, d.selfId, 'done', d.cas, d.now); trace.push('complete');
			try { if (d.ack) { await d.ack(e); trace.push('ack'); } }
			catch (err) { /* a missed ack costs one idempotent re-collect, never a drop */ }
			await leaseSet(turnId, d.selfId, 'released', d.cas, d.now); trace.push('release');
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
			return { ran: true, done: true, parcelVersion: parcelVersion, trace: trace };
		} finally {
			stopCheck();			// EVERY exit stops the liveness ticker -- no timer leaks.
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
		var took = await leaseTake(cid,
			{ holder: d.selfId, eid: e.eid, deadline: e.deadline }, d.cas, d.now);
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
		// same book out at once.
		async function liveness() {
			if (checkStopped || revoked) return;
			if (leaseNow(d.now) - checkStart > maxLife) { stopCheck(); revoked = true; return; }
			var snap;
			try { snap = await d.cas.read(); } catch (err) { return; }
			var cur = (snap && snap.leases) ? snap.leases[cid] : null;
			if (!cur || cur.holder !== String(d.selfId) || cur.mode === 'released') {
				revoked = true;
				trace.push('abort');
			}
		}
		async function say(text, final) {
			if (!d.frame) return;
			try { await d.frame(cid, text, !!final); trace.push(final ? 'final' : 'frame'); }
			catch (err) { /* a dropped frame is only a quieter stream */ }
		}
		async function release() {
			try { await leaseSet(cid, d.selfId, 'released', d.cas, d.now); trace.push('release'); }
			catch (err) { /* an unreleased lease still expires at its deadline */ }
		}
		async function report(f) {
			try {
				await d.post(makeBuilt(Object.assign({ eid: e.eid, cid: cid, main: e.main,
					docKey: e.docKey, by: String(d.selfId || '') }, f)));
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
		if (_settled) {
			try { if (await _settled(env)) return false; } catch (e) { /* on doubt, hold */ }
		}
		return true;
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
		var used = 0;
		for (var j = msgs.length - 1; j > at; j--) {
			var row = progressRow(msgs[j]);
			if (!row) continue;
			var len = row.content ? row.content.length : 0;
			if (used + len > cap && picked.length) break;	// budget spent, oldest dropped first
			used += len;
			picked.push(row);
		}
		picked.reverse();
		return picked;
	}

	/// One transcript message as a streamed structured row, or null for a view-only
	/// row a watcher does not draw. Content is kept in full up to `PROGRESS_MSG_CHARS`.
	function progressRow(m) {
		if (!m || !m.role || !PROGRESS_ROLES[m.role]) return null;
		var c = String(m.content == null ? '' : m.content);
		if (c.length > PROGRESS_MSG_CHARS) c = c.slice(0, PROGRESS_MSG_CHARS);
		var row = { mid: String(m.mid || ''), role: m.role, content: c, ts: +m.ts || 0 };
		if (m.name)        row.name    = String(m.name);
		if (m.outcome)     row.outcome = String(m.outcome);
		if (m.args)        row.args    = String(m.args).length > PROGRESS_MSG_CHARS
			? String(m.args).slice(0, PROGRESS_MSG_CHARS) : String(m.args);
		if (m.callId)      row.callId  = String(m.callId);
		if (m.folded)      row.folded  = m.folded | 0;
		if (m.kept)        row.kept    = m.kept | 0;
		if (m.interrupted) row.interrupted = 1;
		// `ranOn` is what the answer's final copy carries (the device that ran the turn):
		// streaming it means the FINAL provisional row byte-matches the parcel copy's
		// `msgSig`, so the merge is a no-op redraw rather than a rebuild.
		if (m.ranOn)       row.ranOn   = String(m.ranOn);
		return row;
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
	///   * a new row is APPENDED after the turn's dispatched placeholder (the chrome tile
	///     that stands above the streaming answer and is removed when it merges) -- after,
	///     not before, so an add is an APPEND and the append fast path draws it without
	///     rebuilding the thread; absent a placeholder the rows go at the tail of the turn;
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
		var add = [];
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
				add.push(want); prov[rid] = want; changed = true;
			}
		}
		if (!changed) return null;
		if (!add.length) return msgs.slice();			// in-place growth only: same order, new content
		// AFTER the placeholder (or at the tail when there is none), in the frame's
		// order -- so while the placeholder is the last message an add is a pure append.
		var out = msgs.slice();
		var insAt = placeAt >= 0 ? placeAt + 1 : out.length;
		out.splice.apply(out, [insAt, 0].concat(add));
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
		if (r.ranOn)       m.ranOn   = String(r.ranOn);
		return m;
	}
	/// Copy a provisional row's drawable fields onto an existing one, in place, so the
	/// tile grows rather than the array reordering.
	function copyProv(dst, src) {
		dst.content = src.content; dst.ts = src.ts;
		dst.name = src.name; dst.outcome = src.outcome; dst.args = src.args;
		dst.callId = src.callId; dst.folded = src.folded; dst.kept = src.kept;
		dst.interrupted = src.interrupted; dst.ranOn = src.ranOn;
	}
	/// The drawable signature of a provisional row -- what a redraw or the transcript's
	/// own `msgSig` would read, so an unchanged frame folds to null AND the final frame's
	/// `ranOn`/content changes are applied (making the provisional row match the parcel
	/// copy so the merge is a no-op redraw).
	function provRowSig(m) {
		var c = m.content == null ? '' : String(m.content);
		return m.role + '#' + c.length + '#' + (m.outcome || '') + '#' + (m.name || '')
			+ '#' + (m.folded || 0) + '#' + (m.kept || 0) + '#' + (m.interrupted ? 1 : 0)
			+ '#' + (m.ranOn || '');
	}

	// The control a dispatched turn's footer offers, given its §5 display state. The
	// TABLE, lifted out of the renderer so it is one thing a test can enumerate rather
	// than a chain of DOM branches -- and so the owner's take-back ruling (2026-09-17)
	// is stated once:
	//
	//   TAKE-BACK IS PRE-CLAIM ONLY. Before any device has claimed the turn there is
	//   nothing spent and nothing to revoke -- the reclaim is instant and money-safe by
	//   construction -- so the button is offered. The MOMENT a peer claims (claimed /
	//   running / awaiting-consent / blocked), there is no take-back: the mid-run revoke
	//   is dropped. A turn that failed, was aborted, or found no awake device offers
	//   [Run here] (reclaim + run locally); a parked turn offers a re-run.
	var DISPATCH_CONTROLS = {
		dispatched:         'takeback',	// pre-claim: reclaim locally, nothing spent
		'no-peer-awake':    'runhere',	// nobody took it: run here
		failed:             'runhere',	// the peer stopped/refused: run here
		parked:             'rerun',	// survivable park: re-run
		claimed:            '',			// a peer holds it: no take-back
		running:            '',			// a peer is running it: no take-back
		'awaiting-consent': '',			// blocked on a live question: no take-back
		blocked:            '',			// blocked on the runner: no take-back
		done:               '',			// the answer draws itself
	};
	/// The one control a dispatched turn's footer offers for a §5 state, or '' for none.
	function dispatchControl(state) {
		var s = String(state || '');
		return Object.prototype.hasOwnProperty.call(DISPATCH_CONTROLS, s) ? DISPATCH_CONTROLS[s] : '';
	}

	window.DaimondPeer = {
		ENVELOPE_V: ENVELOPE_V,
		T_ERRAND:   T_ERRAND,
		T_REPORT:   T_REPORT,
		T_ASK:      T_ASK,
		T_GRANT:    T_GRANT,
		makeErrand:  makeErrand,
		makeReport:  makeReport,
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
		/// Whether the sender should KEEP holding its own errand (post.js `takeRow`): false
		/// once the turn is settled here or no peer may start it any more. `onSettled`
		/// registers the "is this turn finished here?" probe daimond.js supplies.
		holdOwnDispatch: holdOwnDispatch,
		onSettled:       onSettled,
		/// Register the runners the collector hands a verified envelope to. Set by
		/// daimond.js; absent, `absorb` verifies and drops.
		onErrand: onErrand,
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
		/// The content-free thread fingerprint the errand carries (`threadSig`) and the
		/// runner's readiness test over it (`holdsThread`): does this device hold exactly
		/// the model-facing prefix the turn was dispatched from? S-HAND #3.
		threadSig:     threadSig,
		holdsThread:   holdsThread,
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
		/// The footer control a dispatched turn offers for a §5 state -- 'takeback'
		/// (pre-claim reclaim), 'runhere', 'rerun' or '' (none). Pure table, so the
		/// owner's pre-claim-only take-back ruling is one thing a test enumerates.
		dispatchControl: dispatchControl,
	};
})();
