/* debugshare.js — TRAINING WHEELS, remove after beta.
 *
 * ============================================================================
 * TRAINING WHEELS — remove after beta. This whole file, its <script> tag in
 * index.html, and the `DEBUG_SHARE` touch points in daimond.js, gateway.js,
 * peer.js and sync.js are a temporary, owner-requested debug aid. Every one of
 * those touch points is a guarded one-liner beside a comment that says so, so
 * deleting the file, its script tag, and grepping `DEBUG_SHARE` out of those
 * four files lifts the feature in one obvious pass. Nothing else depends on it.
 * ============================================================================
 *
 * WHAT IT DOES. When a person turns "Share all data for debugging" on, in
 * Settings, this device gathers its OWN DECRYPTED diagnostics -- the cost
 * ledger, the plaintext chat transcripts, the device roster, presence and
 * election state, the error/console trail, context/token stats and the app
 * config -- and ships them to the developer so a beta bug can be read directly.
 * A prominent header indicator is shown the whole time it is on, so it is never
 * secretly collecting. Off by default; when off, nothing is gathered and nothing
 * is posted, and the only footprint is the toggle and (when on) the indicator.
 *
 * ACCOUNT-SYNCED, NOT PER-DEVICE. The flag is one account-level fact, carried on
 * the existing sync parcel (daimond.js `collectSync`/`applySync`) as the freshest-
 * `at`-wins scalar `debugShare: { on, at }` -- the same shape and merge rule as the
 * nominated runner. Turning it on ANY device turns it on across every linked device
 * (the eye appears and collection starts on each), and turning it off ANYWHERE stops
 * the fleet. Only the boolean and its stamp ride; no key or secret is added to the
 * parcel by this. A device that never touched the toggle says nothing (`null`), so it
 * cannot clear a fleet another device has just armed; the timestamp arbitrates the
 * rest, so a device that was offline adopts the freshest decision when it next syncs.
 * The same-device cross-tab `storage` path is kept beside it.
 *
 * ZERO-KNOWLEDGE PRESERVED. The client decrypts locally and ships the decrypted
 * diagnostics; the master/passphrase-derived key never leaves the device. The
 * gathering path never reads key material -- only a PUBLIC fingerprint of the
 * identity -- and a belt-and-braces redactor walks the whole assembled bundle
 * and replaces any field whose NAME looks like a secret (apiKey, token, salt,
 * wrapped private key, passphrase, ...) with a short fingerprint. So the raw
 * provider API key and the master key can never appear in the bundle in the
 * clear -- only first-6-chars-plus-hash fingerprints, per the repo's credential
 * rules.
 *
 * TRANSPORT. It REUSES the existing `/api/debug-trace` endpoint (the same one
 * diag.js and daimond.js already post election traces to) with no gateway
 * change: the bundle is minified JSON, base64-encoded, sliced into
 * `{ts, tag, data}` rows whose `data` fits under the handler's per-field cap,
 * grouped into posts under its body/row caps, and drained one post per interval
 * to respect the handler's rate cap. The operator reassembles a snapshot by
 * concatenating the `data` fields of the rows tagged `ds <id> i/N` and base64
 * decoding. Files land on jarrah at
 *   <gateway cwd>/debug-traces/<account>-<device>.log
 * (i.e. ~/usr/daimond-gateway/debug-traces/<account>-<device>.log), keyed by the
 * account the gateway reads off the session -- never off the body.
 *
 * CADENCE. On toggle-on it posts a full SNAPSHOT (everything). Then, while on,
 * it streams lightweight TELEMETRY on a short timer -- ledger deltas, new trail
 * errors, new diagnostic rows -- and re-snapshots periodically or when the
 * transcript/roster shape changes. Full transcripts are not sent every tick.
 *
 * EVENTS, ADDED 2026-09-12. Snapshots and telemetry are AGGREGATES: they say
 * what the account looks like now, and a reader has to re-derive from them what
 * actually happened. The interesting facts -- a fold fired, a tool failed, a
 * gateway call 500'd, a turn cost six dollars -- were buried in base64 chunk
 * sets that needed a script to reassemble, and an outage lost exactly the rows
 * that explained the outage. So every meaningful act now ALSO emits one small
 * self-describing JSON event at its source, through the single seam
 * `DEBUG_SHARE.event(kind, payload)`:
 *
 *   - One row per event, `{ts, tag:'ev <kind>', data:<JSON <= 360 bytes>}`, NOT
 *     base64 -- so the gateway's log file is greppable as it stands.
 *   - Every event carries the envelope `{v, d, n, b, t}`: schema version, short
 *     device id, a PERSISTED per-device sequence number, the build id, and the
 *     wall clock. `n` is what makes redelivery idempotent for the reader, which
 *     is what lets a failed post simply be retried.
 *   - A DURABLE OUTBOX (localStorage, memory fallback, 5,000 events) holds them.
 *     Rows leave it only when a post is known to have landed, so an outage, a
 *     reload or a tab kill loses nothing; on overflow the OLDEST go and one
 *     `feed.drop` records how many.
 *   - Events drain AHEAD of telemetry and snapshots, at the same 11 s pacing,
 *     with exponential backoff to five minutes while the endpoint is down.
 *   - SELF-PROTECTION. Every entry point is wrapped. An exception inside the
 *     feed queues one `feed.fault` and turns collection off for the session --
 *     the drainer keeps running, so the fault itself still reaches the gateway
 *     -- and the caller's own code path continues. The app never breaks because
 *     the feed did.
 *
 * The message TEXT is still not an event: transcripts stay in the periodic
 * elided snapshot. Content on every tick is what made the seed useless.
 */
(function () {
	'use strict';

	// ── Keys, endpoint, and the transport caps (mirrored from the handler) ──
	//
	// These four match `gateway/src/handlers/debug_trace.rs` with a margin, so a
	// post is never refused for size and a row is never clipped mid-payload:
	//   MAX_BODY   256 KiB  -> we keep a post under 200 KiB
	//   MAX_ROWS   1000     -> we put at most 400 rows in a post
	//   MAX_DATA   400      -> we keep a base64 slice at 360 bytes
	//   MIN_INTERVAL_MS 10s -> we drain one post every 11s
	var ENABLED_KEY = 'daimond-debugshare';		// the flag itself; '1' is on
	var STAMP_KEY   = 'daimond-debugshare-at';	// ms of the last LOCAL decision, for freshest-wins
	var LEDGER_KEY  = 'daimond-ledger';			// the cost ledger, read directly
	var SIGNALS_KEY = 'daimond-signals';		// the per-Diamond / per-model signal index
	var CROSS_KEY   = 'daimond-debug-cross';	// our own diamond×model spend cross (while on)
	var ENDPOINT    = '/api/debug-trace';
	var CLIENT_API  = 2;						// matches CLIENT_API in gateway.js / diag.js

	var MAX_DATA_BYTES = 360;
	var MAX_ROWS_POST  = 400;
	var MAX_BODY_BYTES = 200 * 1024;
	var POST_GAP_MS    = 11000;

	var TELEMETRY_MS = 30000;					// stream telemetry cadence while on
	var RESNAP_MS    = 300000;					// periodic full re-snapshot (5 min)

	// ── The event feed ──
	//
	// An event is ONE row, so its JSON must fit the handler's per-field cap with
	// the same margin the base64 slices keep: 360 bytes against MAX_DATA 400. A
	// payload past it is truncated field-by-field and marked `tr:1` rather than
	// dropped -- a clipped event still says a thing happened, and a dropped one
	// says nothing at all.
	var EVENT_KEY    = 'daimond-debugshare-outbox';	// the durable outbox
	var SEQ_KEY      = 'daimond-debugshare-seq';	// the per-device sequence `n`
	var BUILD_KEY    = 'daimond-build-seen';		// breadcrumb.js's confirmed build id
	var MAX_EVENT_BYTES = 360;
	var OUTBOX_CAP   = 5000;					// events held before the oldest are dropped
	var BACKOFF_MAX_MS = 300000;				// 5 min, the ceiling on repeated-failure backoff
	var PERSIST_MS   = 250;						// trailing debounce on writing the outbox out
	var ERRORS_PER_MIN = 20;					// error-capture rate cap, with a `dropped` count
	var ERR_WINDOW_MS  = 60000;
	var BEAT_TICK_MS = 30000;					// the beat timer's period ...
	var BEAT_TURN_MS = 30000;					// ... a beat this often while a turn runs ...
	var BEAT_IDLE_MS = 300000;					// ... and this often when nothing is running
	var MAX_MSG_CHARS = 200;					// an `error` message, clipped
	// A device id and a build id are ENVELOPE fields, present on every event, so
	// they are the two strings that must never crowd out the payload.
	var MAX_DEV_CHARS   = 12;
	var MAX_BUILD_CHARS = 24;
	// A context drop of more than this fraction between two rounds of one turn is
	// read as a fold, because the fold itself happens in Rust and emits nothing a
	// JS caller can see (see `inferFold`). Such an event is marked `inferred:1`.
	var FOLD_DROP = 0.30;
	// A REAL fold (the engine's `compacted` event) within this window suppresses
	// the inferred one, so a fold that IS reported is not also guessed at.
	var FOLD_REAL_MS = 20000;

	// A transcript embeds whole source-file reads and command outputs verbatim, so
	// a snapshot was ~7 MB / 25k chunks and drained for ~12 min, starving telemetry
	// behind it. The one lever is SIZE -- the handler's 11 s / 400-row / 360-byte
	// caps mean we cannot post faster -- so a giant string is hard-capped to this
	// many bytes with a "[+N bytes]" tail that keeps its size visible. The cap is
	// generous enough to leave an ordinary readable message whole and only bites a
	// giant tool payload. daimond.js has no `TOOL_ELISION_CAP` to reuse, so it
	// lives here. Only the free-form arrays (transcripts, trail, diag) are elided;
	// the structured state stays complete.
	var ELISION_CAP = 2048;

	// Windowing the transcripts, which is a SEPARATE lever from the per-payload
	// elision above. Elision caps each STRING; it does nothing about turn COUNT, and
	// an account with hundreds of turns still shipped every one -- a live trace saw a
	// ~5.7 MB / ~15,900-chunk snapshot drain for ~7 minutes, and the small per-round
	// telemetry the developer actually reads starved behind it. So the snapshot keeps
	// only the MOST RECENT turns: each chat's last `MAX_MSGS_PER_CHAT`, and across all
	// chats a total `TRANSCRIPT_BUDGET_BYTES` spent freshest-first. A row carries 360
	// base64 bytes (= 270 raw), so a ~700 KiB transcript budget plus the small
	// structured state lands the whole snapshot near the ~2,800-row / one-minute
	// target. ONLY the transcript prose is windowed; every structured section (config,
	// roster, presence, election, signals, ledger, tokenStats) and ALL telemetry stay
	// complete and unwindowed -- the live numbers are never cut.
	var MAX_MSGS_PER_CHAT       = 40;			// keep each chat's last N turns
	var TRANSCRIPT_BUDGET_BYTES = 700 * 1024;	// total cap across all chats' kept turns

	// The snapshot no longer ships the whole raw cost ledger. Telemetry carries the
	// per-model / per-Diamond AGGREGATES of it every tick (see aggregateLedger and
	// signalBreakdown), so the raw ~400-entry array was pure duplicated bulk that
	// pushed the snapshot past the one-minute drain target and starved the live
	// numbers behind it. Only the most recent turns are kept, as a tail the operator
	// can spot-check against the aggregates; the count dropped is recorded so the
	// tail is read as a window, not a short ledger.
	var SNAPSHOT_LEDGER_TAIL = 20;				// raw ledger entries kept in a snapshot

	// Field names whose VALUE is a secret and must be fingerprinted, never shipped
	// raw. Matched on the key name, case-insensitively, anywhere in the bundle --
	// so even an unexpected key/token buried in a transcript or config is caught.
	// The master/passphrase-derived key is never gathered at all; this is the
	// belt-and-braces second line for the provider key and anything key-shaped.
	var SECRET_RE = /(?:^|[_.-])(?:apikey|api_key|key|token|secret|passphrase|password|salt|wrapped|wrappedpriv|sealed|seal|privatekey|priv|mnemonic|seed|masterkey)(?:$|[_.-]|enc\b)/i;

	// ── State ──
	var enabled  = read(ENABLED_KEY) === '1';
	var provider = null;			// registered by daimond.js: () -> (obj | Promise<obj>)
	var statsFn  = null;			// registered by daimond.js: () -> live-stats obj (sync, cheap)
	var crossIx  = {};				// diamondId -> model -> {turns, usd}, filled while on
	// Two lanes, not one FIFO. Telemetry (small, frequent, the live per-round numbers)
	// drains first and completely; the snapshot lane (a large multi-thousand-row bundle)
	// drains only when the telemetry lane is empty. So a telemetry post enqueued while a
	// snapshot is mid-drain jumps ahead of the remaining snapshot backlog and reaches the
	// gateway within a post-cycle or two, instead of waiting minutes behind it. Both share
	// the one drainer and its 11 s pacing, so the handler's rate cap is never exceeded.
	var telQueue  = [];				// priority lane: telemetry posts, each an array of rows
	var snapQueue = [];				// snapshot lane: drained only when telQueue is empty
	var draining = false;
	var telTimer = null, snapTimer = null, beatTimer = null;
	// The event lane, which is neither of the above: DURABLE. Its rows leave only
	// when a post has landed, and they survive a reload -- see `loadOutbox`.
	var outbox      = [];			// [{ts, tag, data}], oldest first
	var persistTimer = null;
	var failStreak  = 0;			// consecutive failed event posts, for the backoff
	var dropOwed    = 0;			// events overflowed but not yet reported by feed.drop
	var dropping    = false;		// re-entry guard: a feed.drop must not recurse
	var feedOff     = false;		// the feed threw; collection is off for this session
	var lastBeatAt  = 0;
	var errWindowAt = 0, errCount = 0, errDropped = 0;
	var lastCtx     = {};			// turn id -> last round's prompt tokens, for `inferFold`
	var lastRealFold = {};			// turn id -> when a REAL fold was last reported
	var indicator = null;
	// Telemetry cursors, so a tick sends only what is NEW since the last one.
	var lastLedgerLen = 0, lastTrailLen = 0, lastDiagLen = 0;

	function read(k)  { try { return localStorage.getItem(k); } catch (e) { return null; } }
	function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

	/// A plain positive-millisecond number, or 0. Bignum-safe -- a stamp that
	/// round-tripped through the gateway can arrive as a bignum object with a
	/// `toNumber`, like the presence stamps peer.js reads.
	function ms(v) {
		var n = (v && typeof v.toNumber === 'function') ? v.toNumber() : Number(v);
		return (isFinite(n) && n > 0) ? n : 0;
	}

	/// Best-effort nudge to the sync engine, so a local flip is pushed to the
	/// fleet promptly rather than only on the next debounce. Guarded on the global,
	/// so a build without sync (or a test) pays only a property test.
	function nudgeSync() {
		try { if (window.DaimondSync && window.DaimondSync.nudge) window.DaimondSync.nudge(); }
		catch (e) {}
	}

	// Restore the diamond×model cross from a previous session, so a device that was
	// already sharing keeps its tally across a reload.
	try { crossIx = JSON.parse(read(CROSS_KEY) || '{}') || {}; } catch (e) { crossIx = {}; }

	// AND THE OUTBOX, which is the durability claim made good: whatever the last
	// session queued and could not deliver is here, in order, and drains from the
	// front the moment `bootRestore` kicks the drainer. Loaded unconditionally --
	// an off device's outbox was emptied when it was turned off, so this is empty.
	//
	// ONE CAVEAT, stated rather than engineered around: two tabs of the same device
	// each keep their own in-memory outbox and each write this key, so the loser of
	// a concurrent write loses only the PERSISTED copy -- its own events still go
	// out from memory, and a redelivery is idempotent for the reader because `n`
	// is per-device and monotonic.
	outbox = loadOutbox();
	function saveCross() { try { write(CROSS_KEY, JSON.stringify(crossIx)); } catch (e) {} }

	/// Record one metered turn's spend against its (Diamond, model) pair -- the one
	/// cross the ledger (which carries no Diamond) and the signal index (which holds
	/// Diamond and model separately) cannot answer: which Diamond spent what on
	/// which model. Called from daimond.js's `recordSpend`, and a no-op unless
	/// sharing is on, so an off device pays only a guarded call and a flag test.
	function noteCross(diamondId, model, usd) {
		if (!enabled) return;
		var id = diamondId || '(none)';
		var m  = model || '(unknown)';
		var d  = crossIx[id] || (crossIx[id] = {});
		var r  = d[m] || (d[m] = { turns: 0, usd: 0 });
		r.turns += 1;
		r.usd   += usd || 0;
		saveCross();
	}

	// ── Fingerprinting and redaction ─────────────────────────────

	/// A short, non-reversible rendering of a secret string for a person's eye:
	/// its first six characters, a stable hash, and its length. Enough to tell two
	/// keys apart and to confirm which key a device is on, and nothing an attacker
	/// could run with. A non-string value returns a typed marker.
	function fingerprint(v) {
		if (v == null) return '[redacted:absent]';
		if (typeof v !== 'string') {
			try { v = String(v); } catch (e) { return '[redacted:' + typeof v + ']'; }
		}
		if (v === '') return '[redacted:empty]';
		var head = v.slice(0, 6);
		// djb2, rendered as unsigned hex. Not a cryptographic hash -- it only has to
		// separate two different keys stably; the raw value never travels.
		var h = 5381;
		for (var i = 0; i < v.length; i++) { h = ((h << 5) + h + v.charCodeAt(i)) >>> 0; }
		return '[redacted ' + head + '…#' + h.toString(16) + '/' + v.length + ']';
	}

	/// A deep copy of `obj` with every secret-named field replaced by its
	/// fingerprint. Structure-preserving so the operator still sees WHICH fields
	/// were present and how they relate -- only the raw secret VALUE is gone.
	/// Cycle-safe and depth-bounded, since a diagnostics bundle is arbitrary state.
	function redact(obj, seen, depth) {
		seen = seen || [];
		depth = depth || 0;
		if (obj == null || typeof obj !== 'object') return obj;
		if (depth > 40 || seen.indexOf(obj) !== -1) return '[redacted:cycle-or-deep]';
		seen = seen.concat([obj]);
		if (Array.isArray(obj)) {
			return obj.map(function (v) { return redact(v, seen, depth + 1); });
		}
		var out = {};
		Object.keys(obj).forEach(function (k) {
			var v = obj[k];
			if (SECRET_RE.test(k)) {
				// A secret-named field: fingerprint a scalar, or note a structured
				// secret (a wrapped-key object) as present without walking into it.
				out[k] = (v != null && typeof v === 'object')
					? '[redacted:object]'
					: fingerprint(v);
			} else {
				out[k] = redact(v, seen, depth + 1);
			}
		});
		return out;
	}

	/// The UTF-8 byte length of a string -- what the transport actually pays, and
	/// so what the cap is measured in. Falls back gracefully where TextEncoder is
	/// absent.
	function byteLen(s) {
		try { return new TextEncoder().encode(s).length; }
		catch (e) {
			try { return unescape(encodeURIComponent(s)).length; }
			catch (e2) { return s.length; }
		}
	}

	/// A deep copy of `obj` with every string past `ELISION_CAP` bytes hard-capped
	/// to its first `ELISION_CAP` characters plus a `…[+N bytes]` tail naming how
	/// many bytes were dropped -- so the size stays visible and a giant file-read or
	/// command output no longer bloats the bundle, while an ordinary readable
	/// message (under the cap) passes through whole. Structure-preserving, so the
	/// operator still sees the shape of a transcript; cycle-safe and depth-bounded,
	/// like `redact()`, since the state it walks is arbitrary.
	function elide(obj, seen, depth) {
		seen = seen || [];
		depth = depth || 0;
		if (typeof obj === 'string') {
			var bytes = byteLen(obj);
			if (bytes <= ELISION_CAP) return obj;
			// Tool payloads are overwhelmingly ASCII, so a character slice at the cap
			// is at or under the byte cap; the tail reports the exact bytes dropped.
			var head = obj.slice(0, ELISION_CAP);
			return head + '…[+' + (bytes - byteLen(head)) + ' bytes]';
		}
		if (obj == null || typeof obj !== 'object') return obj;
		if (depth > 40 || seen.indexOf(obj) !== -1) return '[elided:cycle-or-deep]';
		seen = seen.concat([obj]);
		if (Array.isArray(obj)) {
			return obj.map(function (v) { return elide(v, seen, depth + 1); });
		}
		var out = {};
		Object.keys(obj).forEach(function (k) { out[k] = elide(obj[k], seen, depth + 1); });
		return out;
	}

	/// The JSON byte length of one message, for the windowing budget. Never throws --
	/// a message that will not serialise counts as zero, so it can never stall the walk.
	function msgBytes(m) {
		try { return byteLen(JSON.stringify(m) || ''); } catch (e) { return 0; }
	}

	/// Window transcripts down to a bounded, RECENT slice, so a snapshot of an account
	/// with hundreds of turns drains in about a minute instead of starving the live
	/// telemetry behind it. Two bounds, both keeping the NEWEST turns: each chat keeps
	/// only its last `MAX_MSGS_PER_CHAT` messages (a transcript is append-only, so the
	/// tail is the most recent turns), and across chats -- freshest `updatedAt` first --
	/// messages are kept, newest of each chat first, until the running total reaches
	/// `TRANSCRIPT_BUDGET_BYTES`, after which a chat keeps none. Each windowed chat
	/// carries `droppedOlderTurns`, the count of messages cut, so the operator reads it
	/// as a window rather than a short chat. Only the `messages` array is touched; every
	/// other chat field is preserved. Returns a NEW array and does not mutate the input;
	/// a non-array (e.g. `null`) is returned unchanged. Budget is measured on the RAW
	/// message, before `elide` shrinks any giant payload, so the wire never exceeds it.
	function windowTranscripts(chats) {
		if (!Array.isArray(chats)) return chats;
		// Freshest chats first, so the byte budget is spent on the most recent
		// conversations; a stable tiebreak keeps equal/absent stamps in original order.
		var order = chats.map(function (c, i) { return { c: c, i: i }; });
		order.sort(function (a, b) {
			var au = ms(a.c && a.c.updatedAt), bu = ms(b.c && b.c.updatedAt);
			return (au !== bu) ? (bu - au) : (a.i - b.i);
		});
		var budget = TRANSCRIPT_BUDGET_BYTES;
		var byIndex = {};
		order.forEach(function (entry) {
			var c = entry.c || {};
			var msgs = Array.isArray(c.messages) ? c.messages : [];
			var total = msgs.length;
			// Per-chat tail cap first: at most the last N turns of THIS chat.
			var tail = total > MAX_MSGS_PER_CHAT ? msgs.slice(total - MAX_MSGS_PER_CHAT) : msgs.slice();
			// Then the cross-chat byte budget, still keeping the newest and dropping the
			// oldest: walk the tail newest-first and stop when the next (older) turn will
			// not fit, so a budget already spent by fresher chats leaves this one empty.
			var out = [];
			for (var j = tail.length - 1; j >= 0; j--) {
				var b = msgBytes(tail[j]);
				if (budget - b < 0) break;
				budget -= b;
				out.unshift(tail[j]);
			}
			var rec = {};
			Object.keys(c).forEach(function (k) { if (k !== 'messages') rec[k] = c[k]; });
			rec.messages = out;
			var dropped = total - out.length;
			if (dropped > 0) rec.droppedOlderTurns = dropped;
			byIndex[entry.i] = rec;
		});
		// Restore the input's original order.
		return chats.map(function (c, i) { return byIndex[i]; });
	}

	// ── Assembling a bundle ──────────────────────────────────────

	/// The always-safe sources this module reads on its own, off public globals:
	/// the cost ledger, the error/console trail, and the diagnostics ring. The
	/// decrypted transcripts, roster, presence, election, config and token stats
	/// come from the registered provider (daimond.js), which alone can see them.
	function publicSources() {
		var ledger = [];
		try { ledger = JSON.parse(read(LEDGER_KEY) || '[]'); } catch (e) { ledger = []; }
		var trail = [];
		try { trail = (window.DaimondTrail && DaimondTrail.rows && DaimondTrail.rows()) || []; } catch (e) {}
		var diag = [];
		try { diag = (window.DaimondDiag && DaimondDiag.rows && DaimondDiag.rows()) || []; } catch (e) {}
		// The per-Diamond / per-model signal index -- turns, spend and misses. Small
		// and structured, so it travels whole and drives the live breakdowns.
		var signals = null;
		try { signals = JSON.parse(read(SIGNALS_KEY) || 'null'); } catch (e) { signals = null; }
		return { ledger: ledger, trail: trail, diag: diag, signals: signals };
	}

	/// Assemble a full snapshot from a `sources` object and the provider's state.
	/// Exposed for tests as `_assemble`. Redacts the whole result before returning,
	/// so no caller can ever hold an un-redacted bundle.
	function assemble(sources, state) {
		sources = sources || {};
		state = state || {};
		// The raw cost ledger is NOT shipped whole any more: telemetry's per-model and
		// per-Diamond aggregates already summarise it every tick, so a full ~400-entry
		// copy in the snapshot was duplicated bulk that delayed the drain. Keep only the
		// most recent tail for a spot-check, and record how many older entries were cut.
		var fullLedger = sources.ledger || [];
		var ledgerTail = fullLedger.length > SNAPSHOT_LEDGER_TAIL
			? fullLedger.slice(fullLedger.length - SNAPSHOT_LEDGER_TAIL)
			: fullLedger;
		var raw = {
			v:          1,
			kind:       'snapshot',
			ts:         Date.now(),
			iso:        new Date().toISOString(),
			// From the provider (daimond.js) -- the decrypted, private-scope state.
			// Only `transcripts` carries the giant verbatim tool outputs and the deep
			// turn history, so it alone is WINDOWED (recent turns only, see
			// windowTranscripts) and then elided; the rest is small, structured and
			// travels COMPLETE.
			config:      state.config || null,
			transcripts: elide(windowTranscripts(state.transcripts || null)),
			roster:      state.roster || null,
			presence:    state.presence || null,
			election:    state.election || null,
			tokenStats:  state.tokenStats || null,
			// From this module's own public reads. The signal index is structured
			// and complete; trail and diag are free-form logs, so their rows are
			// elided against a stray giant string while their shape is kept. The
			// ledger is a recent tail only -- telemetry carries its aggregates.
			signals:       sources.signals || null,
			ledger:        ledgerTail,
			ledgerDropped: fullLedger.length - ledgerTail.length,
			trail:         elide(sources.trail || []),
			diag:          elide(sources.diag || []),
		};
		// Redact after eliding, so a secret-named field is a fingerprint regardless
		// of what elision left of it.
		return redact(raw);
	}

	/// Gather the full decrypted state: the provider's output plus this module's
	/// public reads, assembled and redacted. Async because the provider may load
	/// transcripts from IndexedDB.
	function gatherSnapshot() {
		return Promise.resolve(provider ? provider() : null).then(function (state) {
			return assemble(publicSources(), state || {});
		}, function () {
			// A provider that throws must not stop the safe sources going out.
			return assemble(publicSources(), {});
		});
	}

	/// Fold the whole cost ledger into one row per model -- the discriminator the
	/// developer reads every tick. `ledger` is the raw array this module reads off
	/// `daimond-ledger`, entries shaped `{t,m,p,c,ca,u,r,e}`: `p` prompt tokens
	/// (cumulative per turn), `c` completion, `ca` cached, `u` USD, `r` set when
	/// the provider reported the cost. `cachedPct` is cache hit-rate on the prompt,
	/// `maxPromptTurn` the largest single-turn prompt, `reportedPct` how much of the
	/// spend the provider priced rather than this client guessing.
	function aggregateLedger(ledger) {
		var by = {};	// model id → accumulator
		for (var i = 0; i < ledger.length; i++) {
			var e = ledger[i];
			if (!e) continue;
			var m = e.m || '';
			if (!by[m]) by[m] = { model: m, turns: 0, prompt: 0, completion: 0,
				cached: 0, usd: 0, maxPromptTurn: 0, reported: 0 };
			var a = by[m];
			a.turns      += 1;
			a.prompt     += e.p || 0;
			a.completion += e.c || 0;
			a.cached     += e.ca || 0;
			a.usd        += e.u || 0;
			if ((e.p || 0) > a.maxPromptTurn) a.maxPromptTurn = e.p || 0;
			if (e.r) a.reported += 1;
		}
		return Object.keys(by).map(function (m) {
			var a = by[m];
			return {
				model:         a.model,
				turns:         a.turns,
				prompt:        a.prompt,
				completion:    a.completion,
				cached:        a.cached,
				cachedPct:     a.prompt ? 100 * a.cached / a.prompt : 0,
				usd:           a.usd,
				maxPromptTurn: a.maxPromptTurn,
				reportedPct:   a.turns ? 100 * a.reported / a.turns : 0,
			};
		});
	}

	/// The per-Diamond and per-model breakdowns from the signal index -- turns,
	/// spend and misses each. `ix.diamonds` answers "which Diamond spent what" over
	/// all history; `ix.models` answers "which model cost what". Both are small
	/// maps, so they go every tick. Returns empty arrays when there is no index.
	function signalBreakdown(signals) {
		var out = { diamonds: [], models: [] };
		if (!signals || typeof signals !== 'object') return out;
		var d = signals.diamonds || {};
		Object.keys(d).forEach(function (id) {
			var r = d[id] || {};
			out.diamonds.push({ diamondId: id, turns: r.turns || 0, usd: r.usd || 0, missed: r.missed || 0 });
		});
		var m = signals.models || {};
		Object.keys(m).forEach(function (model) {
			var r = m[model] || {};
			out.models.push({ model: model, turns: r.turns || 0, usd: r.usd || 0, missed: r.missed || 0 });
		});
		return out;
	}

	/// The diamond×model cross this module has accumulated while sharing was on --
	/// `[{diamondId, model, turns, usd}]`, dearest first -- so the operator reads
	/// which Diamond spent what on which model. Empty until turns are recorded.
	function crossBreakdown() {
		var out = [];
		Object.keys(crossIx).forEach(function (id) {
			var byModel = crossIx[id] || {};
			Object.keys(byModel).forEach(function (model) {
				var r = byModel[model] || {};
				out.push({ diamondId: id, model: model, turns: r.turns || 0, usd: r.usd || 0 });
			});
		});
		out.sort(function (a, b) { return b.usd - a.usd; });
		return out;
	}

	/// The live numbers from daimond.js's stats seam, or null when none is
	/// registered or it throws. Sync and cheap by contract -- no transcripts.
	function liveStats() {
		if (!statsFn) return null;
		try {
			var v = statsFn();
			return (v && typeof v === 'object') ? v : null;
		} catch (e) { return null; }
	}

	/// A lightweight telemetry object, sent EVERY tick: the ledger/trail/diag rows
	/// that are new since the last tick, plus a `stats` block -- per-model ledger
	/// aggregation and the live context/worker numbers -- that goes every time so
	/// the developer sees the figures that matter even on a quiet tick. No
	/// transcripts. Redacted like everything else. Returns null only when there is
	/// genuinely nothing to say (no new rows and no stats seam).
	function gatherTelemetry() {
		var s = publicSources();
		var ledDelta  = s.ledger.slice(lastLedgerLen);
		var trailNew  = s.trail.slice(lastTrailLen);
		var diagNew   = s.diag.slice(lastDiagLen);
		var sig = signalBreakdown(s.signals);
		var stats = {
			models:       aggregateLedger(s.ledger),	// per-model, from the cost ledger
			diamonds:     sig.diamonds,					// per-Diamond, from the signal index
			signalModels: sig.models,					// per-model, from the signal index
			cross:        crossBreakdown(),				// diamond×model, accumulated while on
			live:         liveStats(),					// context/worker, from the stats seam
		};
		if (!ledDelta.length && !trailNew.length && !diagNew.length && !stats) return null;
		lastLedgerLen = s.ledger.length;
		lastTrailLen  = s.trail.length;
		lastDiagLen   = s.diag.length;
		return redact({
			v:      1,
			kind:   'telemetry',
			ts:     Date.now(),
			iso:    new Date().toISOString(),
			ledger: ledDelta,
			trail:  trailNew,
			diag:   diagNew,
			stats:  stats,
		});
	}

	// ── Chunking a bundle into debug-trace rows ──────────────────

	/// UTF-8-safe base64 of a string (the JSON survives the handler's control-char
	/// scrub and byte-boundary clip intact, which raw JSON would not guarantee).
	function b64(str) {
		try {
			var bytes = new TextEncoder().encode(str);
			var bin = '';
			for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
			return btoa(bin);
		} catch (e) {
			try { return btoa(unescape(encodeURIComponent(str))); } catch (e2) { return ''; }
		}
	}

	/// Split an assembled bundle into an array of POSTS (each an array of rows the
	/// `/api/debug-trace` handler accepts). A snapshot's rows are tagged
	/// `ds <kind> <id> i/N` so the operator reassembles by concatenating `data` in
	/// order and base64-decoding. Exposed for tests as `_chunk`.
	function chunk(bundle) {
		var json = '';
		try { json = JSON.stringify(bundle); } catch (e) { json = '{"error":"stringify"}'; }
		var payload = b64(json);
		var id = (bundle && bundle.kind === 'telemetry' ? 't' : 's')
			+ Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
		var slices = [];
		for (var i = 0; i < payload.length; i += MAX_DATA_BYTES) {
			slices.push(payload.slice(i, i + MAX_DATA_BYTES));
		}
		if (!slices.length) slices.push('');
		var n = slices.length;
		var kind = (bundle && bundle.kind) || 'snapshot';
		var rows = slices.map(function (data, idx) {
			return {
				ts:  Date.now(),
				tag: 'ds ' + kind + ' ' + id + ' ' + (idx + 1) + '/' + n,
				data: data,
			};
		});
		// Group rows into posts under both the row cap and the body cap.
		var posts = [];
		var cur = [], curBytes = 0;
		rows.forEach(function (r) {
			var rowBytes = r.tag.length + r.data.length + 48;	// JSON overhead per row
			if (cur.length >= MAX_ROWS_POST || (curBytes + rowBytes) > MAX_BODY_BYTES) {
				if (cur.length) posts.push(cur);
				cur = []; curBytes = 0;
			}
			cur.push(r); curBytes += rowBytes;
		});
		if (cur.length) posts.push(cur);
		return posts;
	}

	// ── The event feed ─────────────────────────────────────────
	//
	// One fact, one row, at the point it happened. Everything below is reached
	// through `event(kind, payload)`, which is a no-op when the feature is off
	// and which cannot throw into its caller: see `event` and `fault`.

	/// A string clipped to `n` characters, with the ANSI colouring fe2o3's `err!`
	/// wraps a wasm-side error in stripped out -- in a log file those escapes are
	/// noise in front of the only words that matter.
	function clip(s, n) {
		var v = String(s == null ? '' : s)
			.replace(/\[[0-9;]*m/g, '')
			.replace(/\[[0-9]{1,2}(;[0-9]{1,2})*m/g, '')
			.replace(/\s+/g, ' ')
			.trim();
		return v.length > n ? v.slice(0, n) : v;
	}

	/// This device's id, short. An envelope field, so it is bounded: a long id
	/// would eat the payload's share of the 360 bytes.
	function shortDevice() { return clip(deviceId(), MAX_DEV_CHARS); }

	/// The build this tab is running, as the app best knows it: the updater's
	/// answer, else the id the LAST boot confirmed (breadcrumb.js writes it, and
	/// it is readable synchronously, which `build.json` is not).
	function buildTag() {
		try {
			if (window.DaimondUpdater && DaimondUpdater.booted && DaimondUpdater.booted()) {
				return clip(DaimondUpdater.booted(), MAX_BUILD_CHARS);
			}
		} catch (e) { /* the updater has not polled */ }
		return clip(read(BUILD_KEY) || '', MAX_BUILD_CHARS);
	}

	/// The next sequence number for this device, persisted BEFORE the event is
	/// queued. Monotonic across reloads, which is what makes a redelivered post
	/// harmless: the reader keys on `(device, n)` and keeps the first copy.
	function nextSeq() {
		var n = 0;
		try { n = parseInt(read(SEQ_KEY) || '0', 10) || 0; } catch (e) { n = 0; }
		n = (n > 0 ? n : 0) + 1;
		write(SEQ_KEY, String(n));
		return n;
	}

	/// The outbox as the last session left it. A parse failure yields an empty
	/// queue rather than a throw: a corrupt outbox must not stop the app booting.
	function loadOutbox() {
		var rows = [];
		try { rows = JSON.parse(read(EVENT_KEY) || '[]') || []; } catch (e) { rows = []; }
		if (!Array.isArray(rows)) return [];
		// Only well-formed rows, so one bad entry cannot make every later post
		// unpostable. A row is `{ts, tag, data}` and nothing else.
		return rows.filter(function (r) {
			return r && typeof r.tag === 'string' && typeof r.data === 'string';
		}).slice(-OUTBOX_CAP).map(function (r) {
			return { ts: ms(r.ts) || Date.now(), tag: r.tag, data: r.data };
		});
	}

	function persistNow() {
		try { if (persistTimer) clearTimeout(persistTimer); } catch (e) {}
		persistTimer = null;
		try { write(EVENT_KEY, JSON.stringify(outbox)); }
		catch (e) {
			// Quota. Half an outbox that persists beats a whole one that does not:
			// the oldest half goes, which is the same rule the overflow cap follows.
			try {
				outbox.splice(0, Math.ceil(outbox.length / 2));
				write(EVENT_KEY, JSON.stringify(outbox));
			} catch (e2) { /* memory-only from here; the queue still drains */ }
		}
	}

	/// Write the outbox out on a trailing debounce. A burst of three hundred
	/// events costs one serialisation rather than three hundred; the window it
	/// opens is at most `PERSIST_MS`, and anything lost in it would have been
	/// REDELIVERED rather than dropped, since `n` makes a repeat idempotent.
	function persistSoon() {
		if (persistTimer) return;
		try { persistTimer = setTimeout(persistNow, PERSIST_MS); }
		catch (e) { persistNow(); }
	}

	/// Append one finished row and kick the drainer. Overflow drops the OLDEST --
	/// a live device's recent history is what a reader wants -- and records the
	/// count in one `feed.drop`.
	function pushRow(tag, data) {
		outbox.push({ ts: Date.now(), tag: tag, data: data });
		if (outbox.length > OUTBOX_CAP) {
			var cut = outbox.length - OUTBOX_CAP;
			outbox.splice(0, cut);
			dropOwed += cut;
			if (!dropping) {
				dropping = true;
				try { emit('feed.drop', { count: dropOwed }); dropOwed = 0; }
				finally { dropping = false; }
			}
		}
		persistSoon();
		if (enabled) drain();
	}

	/// JSON, or a throw. Deliberately NOT swallowed: a payload that will not
	/// serialise is a fault, and `event` turns it into one.
	function str(o) { return JSON.stringify(o); }

	/// The event's JSON, cut to `MAX_EVENT_BYTES`. The LARGEST string field goes
	/// first and only far enough to fit, so a short tool name survives a long
	/// error message being trimmed; `tr:1` marks that something was cut. The
	/// envelope is never sacrificed -- an event with no payload left still says
	/// which device, which build, and where in the sequence it sits.
	function fit(obj) {
		var s = str(obj);
		if (byteLen(s) <= MAX_EVENT_BYTES) return s;
		var o = {};
		Object.keys(obj).forEach(function (k) { o[k] = obj[k]; });
		o.tr = 1;
		for (var guard = 0; guard < 32; guard++) {
			s = str(o);
			var over = byteLen(s) - MAX_EVENT_BYTES;
			if (over <= 0) return s;
			var bigK = '', bigN = 0;
			Object.keys(o).forEach(function (k) {
				if (k === 'v' || k === 'd' || k === 'n' || k === 'b' || k === 't' || k === 'tr') return;
				// The capability triple is never a string, so it is never a candidate
				// here -- said out loud because it is the part of a beat that must not
				// be trimmable, and a later change that stringified it would silently
				// make it so.
				if (typeof o[k] !== 'string') return;
				var n = byteLen(o[k]);
				if (n > bigN) { bigN = n; bigK = k; }
			});
			if (!bigK) break;
			// Characters, not bytes: a multi-byte string loses at least `over`
			// bytes this way, never fewer, so the loop always converges.
			var keep = o[bigK].length - over - 1;
			if (keep > 0) o[bigK] = o[bigK].slice(0, keep);
			else delete o[bigK];
		}
		s = str(o);
		if (byteLen(s) <= MAX_EVENT_BYTES) return s;
		// Nothing left but the envelope, and it is still worth sending.
		return str({ v: o.v, d: o.d, n: o.n, b: o.b, t: o.t, tr: 1 });
	}

	/// THE THREE CAPABILITY FACTS a stuck device cannot otherwise be seen to be
	/// missing: whether the tool surface exists at all, whether a workspace folder
	/// is actually mounted, and whether this device may commit a chunk set. The
	/// third is the one that matters most -- a device whose chunk index has not
	/// merged refuses every commit, silently, and that state was invisible until
	/// it cost a turn. `null` means the answer is not knowable yet (the core has
	/// not loaded), which is a different thing from `false`.
	function capabilities() {
		var cap = { tools: false, folder: false, mayCommit: null };
		try { cap.tools = !!window.DaimondTools; } catch (e) {}
		try { cap.folder = !!(window.DaimondFiles && DaimondFiles.folder && DaimondFiles.folder()); } catch (e) {}
		try {
			if (window.DaimondCore && DaimondCore.syncMayCommitChunks) {
				cap.mayCommit = !!DaimondCore.syncMayCommitChunks();
			}
		} catch (e) { /* the core is not up; `null` stands */ }
		return cap;
	}

	/// Build, redact, fit and queue one event. The envelope wins over a payload
	/// key of the same name, so a caller cannot overwrite `n` or `t` by accident.
	/// `boot` and `beat` additionally carry `capabilities()`, added HERE rather
	/// than at the call sites so neither kind can be emitted without them.
	/// Throws on a payload that will not serialise; only `event` calls this.
	function emit(kind, payload) {
		var ev = {
			v: 1,
			d: shortDevice(),
			n: nextSeq(),
			b: buildTag(),
			t: Date.now(),
		};
		if (kind === 'boot' || kind === 'beat') {
			var cap = capabilities();
			ev.tools     = cap.tools;
			ev.folder    = cap.folder;
			ev.mayCommit = cap.mayCommit;
		}
		if (payload && typeof payload === 'object') {
			Object.keys(payload).forEach(function (k) {
				if (k === 'v' || k === 'd' || k === 'n' || k === 'b' || k === 't') return;
				if (payload[k] === undefined) return;
				ev[k] = payload[k];
			});
		}
		pushRow('ev ' + kind, fit(redact(ev)));
		return true;
	}

	/// THE ONE SEAM. Every call site in the app reaches the feed through this and
	/// nothing else. A no-op when sharing is off or the feed has faulted; never
	/// throws into its caller.
	function event(kind, payload) {
		if (!enabled || feedOff || !kind) return false;
		try {
			var ok = emit(kind, payload);
			if (kind === 'round') inferFold(payload);
			return ok;
		} catch (e) { fault(e); return false; }
	}

	/// The feed itself threw. One `feed.fault` is queued and collection stops for
	/// the session -- but the DRAINER is left running, so the fault reaches the
	/// gateway rather than sitting in a queue nobody empties. Idempotent: a second
	/// fault in the same session says nothing, since the first already said it.
	function fault(e) {
		if (feedOff) return;
		feedOff = true;
		try { stopTimers(); } catch (e2) {}
		try {
			var row = {
				v: 1, d: shortDevice(), n: nextSeq(), b: buildTag(), t: Date.now(),
				msg: clip((e && e.message) || e || 'feed fault', MAX_MSG_CHARS),
			};
			pushRow('ev feed.fault', fit(redact(row)));
		} catch (e2) { /* a feed that cannot report its own fault is simply off */ }
	}

	/// A FOLD HAPPENS IN RUST and the JS side is told only when the engine emits
	/// `compacted`; a fold the engine performs silently shows up here as nothing
	/// but a context that got smaller. So a round whose `ctx` has dropped by more
	/// than `FOLD_DROP` against the previous round of the same turn is reported as
	/// a fold and MARKED `inferred:1`, which is the honest label for a fact that
	/// was deduced rather than observed. A real fold reported within
	/// `FOLD_REAL_MS` suppresses the guess, so the two never double up.
	function inferFold(p) {
		if (!p || typeof p !== 'object') return;
		var id = String(p.turn || p.chat || '');
		var ctx = Number(p.ctx) || 0;
		if (!id || ctx <= 0) return;
		var was = lastCtx[id] || 0;
		lastCtx[id] = ctx;
		if (was <= 0 || ctx >= was * (1 - FOLD_DROP)) return;
		var real = lastRealFold[id] || 0;
		if (real && (Date.now() - real) < FOLD_REAL_MS) return;
		emit('fold', { turn: id, before: was, after: ctx, trigger: 'est', inferred: 1 });
	}

	/// Record that the engine reported a REAL fold for this turn, so the inference
	/// above stands down. Called beside the `fold` event in daimond.js.
	function noteRealFold(id) {
		try {
			if (!id) return;
			lastRealFold[String(id)] = Date.now();
			lastCtx[String(id)] = 0;			// the next round re-seeds the baseline
		} catch (e) { fault(e); }
	}

	// ── Error capture ──────────────────────────────────────────
	//
	// The three ways a failure reaches the page: an uncaught throw, a rejected
	// promise nobody awaited, and the app's own `console.error`. All three become
	// `error` events, rate-capped at `ERRORS_PER_MIN` so a render loop failing
	// once a frame cannot fill the outbox -- the overflow is counted and reported
	// on the next event that IS admitted, as `dropped`.
	//
	// The hooks are installed once, at load, and are INERT while sharing is off:
	// they read nothing and queue nothing. `console.error` is wrapped so the
	// app's own logging happens FIRST and unconditionally, before this looks at
	// the arguments at all.

	/// One argument of a `console.error` call, as a short string. Only primitives
	/// and an Error's `message` are read: the name-based redactor cannot see into
	/// a stringified config object, so an object is named and never unpacked.
	function argWord(a) {
		try {
			if (a == null) return String(a);
			if (typeof a === 'string') return a;
			if (typeof a === 'number' || typeof a === 'boolean') return String(a);
			if (a.message) return String(a.message);
			if (Array.isArray(a)) return '[array:' + a.length + ']';
			return '[' + ((a.constructor && a.constructor.name) || 'object') + ']';
		} catch (e) { return '[unreadable]'; }
	}

	function noteError(msg, where) {
		if (!enabled || feedOff) return;
		var now = Date.now();
		if (now - errWindowAt >= ERR_WINDOW_MS) { errWindowAt = now; errCount = 0; }
		if (errCount >= ERRORS_PER_MIN) { errDropped += 1; return; }
		errCount += 1;
		var p = { msg: clip(msg, MAX_MSG_CHARS) };
		if (where) p.at = clip(where, 80);
		if (errDropped) { p.dropped = errDropped; errDropped = 0; }
		event('error', p);
	}

	/// A gateway call that did not answer 2xx, or threw. Path, status and elapsed
	/// ms only -- NEVER the request body, which carries the parcel and the prompt.
	function noteFetchFail(path, status, lapsed, err) {
		if (!enabled || feedOff) return;
		var p = { path: clip(path, 64), status: status | 0, ms: lapsed | 0 };
		if (err) p.err = clip(err, 120);
		event('fetch.fail', p);
	}

	// ── The beat ───────────────────────────────────────────────

	/// Where this device is, on a clock rather than on an event: build (in the
	/// envelope), context against the window and the fold point, worker state,
	/// credits when the gateway has said, and how deep the outbox is. Every 30 s
	/// while a turn runs, every 5 min when nothing does -- one timer, with the
	/// due time decided here, so a turn starting mid-interval is picked up within
	/// one tick rather than after five minutes.
	function beatTick() {
		if (!enabled || feedOff) return;
		var busy = false;
		try { busy = !!(window.DaimondCore && DaimondCore.busy && DaimondCore.busy()); } catch (e) {}
		var now = Date.now();
		var due = busy ? BEAT_TURN_MS : BEAT_IDLE_MS;
		if (lastBeatAt && (now - lastBeatAt) < (due - 500)) return;
		lastBeatAt = now;
		var live = liveStats() || {};
		var wk = live.workerState || null;
		var credits = null;
		try {
			var gs = (window.DaimondGateway && DaimondGateway.state) ? DaimondGateway.state() : null;
			if (gs && typeof gs.credits === 'number') credits = gs.credits;
		} catch (e) { /* the gateway has not answered */ }
		event('beat', {
			ctx:   live.contextActual || 0,
			win:   live.contextWindow || 0,
			fold:  live.foldAt || 0,
			model: clip(live.activeModel || '', 48),
			wk:    wk ? (wk.active | 0) : 0,
			wq:    wk ? (wk.queued | 0) : 0,
			busy:  busy ? 1 : 0,
			cr:    (credits == null) ? undefined : credits,
			ob:    outbox.length,
		});
	}

	/// One post's worth of events, taken from the FRONT of the outbox and never
	/// splitting one: a row is a whole event or it is not in the post. Bounded by
	/// both the row cap and the body cap, with the margins the chunker keeps.
	function eventBatch() {
		var out = [], bytes = 0;
		for (var i = 0; i < outbox.length && out.length < MAX_ROWS_POST; i++) {
			var r = outbox[i];
			var rowBytes = r.tag.length + r.data.length + 48;	// JSON overhead per row
			if (out.length && (bytes + rowBytes) > MAX_BODY_BYTES) break;
			out.push({ ts: r.ts, tag: r.tag, data: r.data });
			bytes += rowBytes;
		}
		return out;
	}

	/// How long to wait after a failed event post: the ordinary gap, doubling per
	/// consecutive failure, to a five-minute ceiling. Reset by the first success.
	function backoffMs() {
		var n = failStreak > 0 ? failStreak : 1;
		var wait = POST_GAP_MS * Math.pow(2, n - 1);
		return wait > BACKOFF_MAX_MS ? BACKOFF_MAX_MS : wait;
	}

	// ── Posting and draining ─────────────────────────────────────

	function deviceId() {
		try { return (window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId()) || ''; }
		catch (e) { return ''; }
	}

	/// POST one batch of rows. The promise resolves to whether the post LANDED --
	/// which the snapshot and telemetry lanes ignore, since a missed aggregate is
	/// replaced by the next one, and which the EVENT lane depends on: an event is
	/// removed from the outbox only when this says true. A thrown fetch and a
	/// non-2xx answer are the same thing here, and both mean "still ours".
	function postRows(rows) {
		var body = JSON.stringify({ v: 1, device: deviceId(), rows: rows });
		return fetch(ENDPOINT, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body:        body,
		}).then(function (r) {
			// A stub or a build whose fetch resolves nothing counts as delivered:
			// the alternative is an outbox that never empties.
			if (!r) return true;
			if (typeof r.ok === 'boolean') return r.ok;
			return !(r.status >= 400);
		}, function () { return false; });
	}

	/// True while any lane holds something to send. Nothing is pending while the
	/// feature is off: `applyState` clears all three, and an off device must put
	/// nothing on the wire.
	function pending() {
		if (!enabled) return false;
		return outbox.length > 0 || telQueue.length > 0 || snapQueue.length > 0;
	}

	/// Drain the two lanes one batch every `POST_GAP_MS`, so the handler's rate cap
	/// never refuses us. The telemetry lane is always taken first and emptied before
	/// any snapshot batch is sent, so a telemetry post that arrives mid-snapshot is
	/// the very next thing on the wire. Stops the instant the feature is turned off
	/// (both lanes are cleared by `applyState`, and this checks `enabled` each round).
	function drain() {
		if (draining) return;
		draining = true;
		(function step() {
			if (!pending()) { draining = false; return; }
			// EVENTS FIRST, and they are the only DURABLE lane: the rows stay in the
			// outbox until the post is known to have landed, so an outage costs a
			// retry rather than the events that explain it. A failure backs the next
			// attempt off; a success resets the backoff and removes exactly the rows
			// that went, which is why the batch is spliced by LENGTH off the front
			// and never by identity -- nothing else removes from the front.
			if (outbox.length) {
				var batch = eventBatch();
				postRows(batch).then(function (ok) {
					var wait = POST_GAP_MS;
					if (ok) {
						outbox.splice(0, batch.length);
						failStreak = 0;
						persistNow();
					} else {
						failStreak += 1;
						wait = backoffMs();
					}
					if (!pending()) { draining = false; return; }
					setTimeout(step, wait);
				});
				return;
			}
			// Telemetry jumps the queue: the priority lane wins whenever it has anything.
			var rows = telQueue.length ? telQueue.shift() : snapQueue.shift();
			postRows(rows).then(function () {
				if (!pending()) { draining = false; return; }
				setTimeout(step, POST_GAP_MS);
			});
		})();
	}

	/// Enqueue a bundle's posts onto the telemetry lane when `priority` is true, else
	/// the snapshot lane, and kick the drainer. A no-op when off.
	function enqueue(posts, priority) {
		if (!enabled || !posts || !posts.length) return;
		var q = priority ? telQueue : snapQueue;
		for (var i = 0; i < posts.length; i++) q.push(posts[i]);
		drain();
	}

	/// Assemble and enqueue a full snapshot. A no-op when off, or once the feed
	/// has faulted -- a feed that threw collects nothing more this session.
	function snapshotNow() {
		if (!enabled || feedOff) return Promise.resolve(false);
		return gatherSnapshot().then(function (bundle) {
			enqueue(chunk(bundle));
			return true;
		});
	}

	function telemetryTick() {
		if (!enabled || feedOff) return;
		var tel = gatherTelemetry();
		if (tel) enqueue(chunk(tel), true);		// priority lane -- ahead of any snapshot backlog
	}

	// ── The header indicator ─────────────────────────────────────
	//
	// A red, gently pulsing eye in the header's action group, shown the whole time
	// the feature is on and gone the instant it is off. Its title/hover carries the
	// plain warning. Theme-aware: the alert red is deliberately close in both
	// themes (an alarm should not go quiet in the dark), but the glyph and ring
	// adjust so it reads on either ground.

	var INDICATOR_TITLE = 'Debug data sharing is ON — all your Daimond data is being '
		+ 'shared with the developer for debugging. Turn off in Settings.';

	function ensureStyle() {
		try {
			if (document.getElementById('ds-style')) return;
			var s = document.createElement('style');
			s.id = 'ds-style';
			s.textContent =
				'.ds-indicator{display:inline-flex;align-items:center;justify-content:center;'
				+ 'width:34px;height:34px;margin:0 2px;border-radius:8px;cursor:pointer;'
				+ 'border:1px solid #ef4444;background:#fee2e2;color:#b91c1c;'
				+ 'animation:ds-pulse 1.6s ease-in-out infinite;}'
				+ '.ds-indicator:hover{background:#fecaca;}'
				+ '.ds-indicator .ic{width:20px;height:20px;stroke:currentColor;stroke-width:2;'
				+ 'fill:none;stroke-linecap:round;stroke-linejoin:round;}'
				+ '@keyframes ds-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.55);}'
				+ '50%{box-shadow:0 0 0 5px rgba(239,68,68,0);}}'
				+ '@media (prefers-color-scheme:dark){'
				+ '.ds-indicator{background:#450a0a;color:#fca5a5;border-color:#f87171;}'
				+ '.ds-indicator:hover{background:#5b1010;}}'
				+ ':root[data-theme="dark"] .ds-indicator{background:#450a0a;color:#fca5a5;border-color:#f87171;}'
				+ ':root[data-theme="light"] .ds-indicator{background:#fee2e2;color:#b91c1c;border-color:#ef4444;}';
			(document.head || document.body || document.documentElement).appendChild(s);
		} catch (e) {}
	}

	function mountIndicator() {
		try {
			if (indicator || typeof document === 'undefined' || !document.querySelector) return;
			ensureStyle();
			var host = document.querySelector('.top-actions') || document.querySelector('.topbar');
			if (!host) return;
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'ds-indicator';
			b.id = 'ds-indicator';
			b.title = INDICATOR_TITLE;
			b.setAttribute('aria-label', INDICATOR_TITLE);
			// An eye with a dot -- "your data is being watched" -- in an alert frame.
			b.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">'
				+ '<path d="M1.5 12S5 5.5 12 5.5 22.5 12 22.5 12 19 18.5 12 18.5 1.5 12 1.5 12z"/>'
				+ '<circle cx="12" cy="12" r="3"/></svg>';
			b.addEventListener('click', function () {
				// Best-effort nudge toward Settings; harmless if nobody listens.
				try { window.dispatchEvent(new CustomEvent('daimond:opensettings', { detail: { from: 'debugshare' } })); }
				catch (e) {}
			});
			// First child, so it sits at the leading edge of the action group and is
			// the first thing the eye meets.
			if (host.firstChild) host.insertBefore(b, host.firstChild);
			else host.appendChild(b);
			indicator = b;
		} catch (e) {}
	}

	function unmountIndicator() {
		try { if (indicator && indicator.remove) indicator.remove(); } catch (e) {}
		indicator = null;
	}

	// ── The switch ───────────────────────────────────────────────

	function startTimers() {
		stopTimers();
		if (feedOff) return;			// a faulted feed collects nothing more
		try { telTimer  = setInterval(telemetryTick, TELEMETRY_MS); } catch (e) {}
		try { snapTimer = setInterval(function () { snapshotNow(); }, RESNAP_MS); } catch (e) {}
		try { beatTimer = setInterval(function () { try { beatTick(); } catch (e2) { fault(e2); } }, BEAT_TICK_MS); } catch (e) {}
	}
	function stopTimers() {
		try { if (telTimer) clearInterval(telTimer); } catch (e) {}
		try { if (snapTimer) clearInterval(snapTimer); } catch (e) {}
		try { if (beatTimer) clearInterval(beatTimer); } catch (e) {}
		telTimer = null; snapTimer = null; beatTimer = null;
	}

	function isOn() { return enabled; }

	/// Apply the on/off EFFECT without recording a decision or nudging sync. On:
	/// show the indicator, start the timers, and post a full snapshot. Off: hide the
	/// indicator, stop the timers, drop any queued posts, and reset the telemetry
	/// cursors -- nothing more leaves the device. Idempotent and safe to call before
	/// the DOM exists (the indicator is simply not mounted then, and mounts on the
	/// next `on`). This is the shared body: `setEnabled` wraps it with a fresh stamp
	/// for a LOCAL decision, and `adoptSync` calls it after writing the remote stamp
	/// verbatim, so an adopted value never restamps and cannot ping-pong.
	function applyState(v) {
		enabled = !!v;
		write(ENABLED_KEY, enabled ? '1' : '0');
		try {
			window.dispatchEvent(new CustomEvent('daimond:debugshare', { detail: { on: enabled } }));
		} catch (e) {}
		if (enabled) {
			mountIndicator();
			// Seed the telemetry cursors at the current tail, so the first telemetry
			// tick sends only what happens AFTER toggle-on (the snapshot already
			// carried the backlog).
			var s = publicSources();
			lastLedgerLen = s.ledger.length;
			lastTrailLen  = s.trail.length;
			lastDiagLen   = s.diag.length;
			startTimers();
			snapshotNow();
			// NO IMMEDIATE BEAT. The snapshot that has just been queued carries the
			// same state and more, and `boot` -- emitted by daimond.js at start and
			// unlock -- is what says which build this device is on. The beat's job is
			// the CLOCK: it says a quiet device is still there. So the first one is
			// the timer's, not this.
			lastBeatAt = 0;
		} else {
			stopTimers();
			telQueue = [];
			snapQueue = [];
			// AND THE OUTBOX. Off means nothing more leaves this device, and a queue
			// held back to be posted the next time sharing is armed would be exactly
			// that -- data collected while on, delivered after the person said stop.
			outbox = [];
			failStreak = 0;
			dropOwed = 0;
			persistNow();
			unmountIndicator();
		}
	}

	/// Turn the feature on or off from a LOCAL action (the Settings toggle). Stamps
	/// the decision with the clock -- which is how this choice wins over an older one
	/// on every linked device (see `adoptSync`) -- applies the effect, and nudges the
	/// sync engine so the flag reaches the fleet without waiting for the next push.
	function setEnabled(v) {
		var on = !!v;
		// Stamp BEFORE applying, so a snapshot the effect kicks off already carries the
		// new decision when `collectSync` reads `syncSnapshot()`.
		write(STAMP_KEY, String(Date.now()));
		applyState(on);
		nudgeSync();
	}

	/// The flag as it rides the sync parcel: `{ on, at }`, or `null` when this device
	/// has never touched the toggle. Verbatim -- no restamp -- so a value this device
	/// already agrees with serialises to the same bytes and the push-skip still holds.
	/// `null` (never touched) reads to the other side as "nothing to say", so a fresh
	/// device cannot clear a fleet another device has just armed.
	function syncSnapshot() {
		var at = ms(read(STAMP_KEY));
		if (!at) return null;
		return { on: enabled, at: at };
	}

	/// Adopt a flag that arrived from another device: the fresher `at` wins, STRICTLY,
	/// and is written VERBATIM, so a record this device already holds moves nothing and
	/// the next parcel is byte-identical. When the fresher value differs from what this
	/// device shows, the effect is applied through `applyState` -- the indicator mounts
	/// or unmounts and collection starts or stops -- so the eye and the collection match
	/// the fleet. Only the boolean and its stamp are touched; no key or secret is read
	/// or written here.
	function adoptSync(rec) {
		if (!rec || typeof rec !== 'object') return;
		var at = ms(rec.at);
		if (!at) return;
		var on = !!rec.on;
		var mineAt = ms(read(STAMP_KEY));
		if (at > mineAt) {
			write(STAMP_KEY, String(at));		// verbatim: no restamp, so no ping-pong
			if (on !== enabled) applyState(on);
		}
	}

	/// Register the provider daimond.js supplies: a function returning (or
	/// resolving to) the decrypted private-scope state. Called once at boot.
	function registerProvider(fn) {
		if (typeof fn === 'function') provider = fn;
	}

	/// Register the live-stats seam daimond.js supplies: a cheap, synchronous
	/// function returning the current context/token/worker numbers (never
	/// transcripts). Telemetry calls it every tick. Called once at boot, beside
	/// `registerProvider`.
	function registerStats(fn) {
		if (typeof fn === 'function') statsFn = fn;
	}

	// If the switch was left on from a previous session, restore the indicator and
	// resume collection once the DOM is ready.
	function bootRestore() {
		if (!enabled) return;
		mountIndicator();
		var s = publicSources();
		lastLedgerLen = s.ledger.length;
		lastTrailLen  = s.trail.length;
		lastDiagLen   = s.diag.length;
		startTimers();
		// A boot snapshot lands the current state the moment the app is up.
		snapshotNow();
		// And whatever the LAST session could not deliver goes now, ahead of it: the
		// outbox is already loaded, and this is the moment it starts moving again.
		lastBeatAt = 0;
		drain();
	}
	try {
		if (typeof document !== 'undefined' && document.addEventListener) {
			if (document.readyState === 'loading') {
				document.addEventListener('DOMContentLoaded', bootRestore);
			} else {
				// Defer a tick so daimond.js has a chance to register its provider.
				setTimeout(bootRestore, 0);
			}
		}
	} catch (e) {}

	// A switch flipped in one tab reaches the others of the SAME device, so turning
	// it off in one place stops collection everywhere on this machine. The sibling
	// tab that flipped it already stamped `STAMP_KEY` and nudged sync, so this one
	// only mirrors the EFFECT -- `applyState`, never `setEnabled` -- and does not
	// restamp. (Cross-DEVICE propagation is `syncSnapshot`/`adoptSync` on the parcel.)
	try {
		window.addEventListener('storage', function (e) {
			if (e && e.key === ENABLED_KEY) {
				var now = read(ENABLED_KEY) === '1';
				if (now !== enabled) applyState(now);
			}
		});
	} catch (e) {}

	// ── The error hooks ──────────────────────────────────────────
	//
	// Installed once, at load, and inert while sharing is off. breadcrumb.js keeps
	// its own listeners for the same two events and its own twenty-line ring; this
	// does not touch that storage and does not replace it -- it mirrors the same
	// facts into the event stream, where they sit in sequence beside the turn that
	// produced them.
	try {
		window.addEventListener('error', function (e) {
			try {
				var where = '';
				if (e && e.filename) {
					where = String(e.filename).replace(/^https?:\/\/[^/]+/, '') + ':' + (e.lineno || 0);
				}
				noteError((e && e.message) || 'error', where);
			} catch (e2) { fault(e2); }
		});
	} catch (e) {}
	try {
		window.addEventListener('unhandledrejection', function (e) {
			try {
				var r = e && e.reason;
				noteError((r && r.message) || argWord(r) || 'rejection', 'unhandledrejection');
			} catch (e2) { fault(e2); }
		});
	} catch (e) {}

	// `console.error` is WRAPPED, not replaced: the original runs first and
	// unconditionally, before a single argument is looked at, so a broken feed
	// cannot cost the developer their console. The re-entry guard matters because
	// anything below that logs would otherwise call straight back into here.
	try {
		if (typeof console !== 'undefined' && typeof console.error === 'function' && !console.error._ds) {
			var origError = console.error;
			var inConsole = false;
			var wrapped = function () {
				try { origError.apply(console, arguments); } catch (e) {}
				if (inConsole) return;
				inConsole = true;
				try {
					var parts = [];
					for (var i = 0; i < arguments.length && i < 4; i++) parts.push(argWord(arguments[i]));
					noteError(parts.join(' '), 'console.error');
				} catch (e) { /* never from the app's own logging */ }
				inConsole = false;
			};
			wrapped._ds = true;
			console.error = wrapped;
		}
	} catch (e) {}

	// The outbox is written on a trailing debounce, so the page going away is the
	// one moment it must be written NOW -- everything queued in the last quarter
	// second is exactly what a crash-and-reload needs to still have.
	try {
		window.addEventListener('pagehide', function () { try { persistNow(); } catch (e) {} });
		window.addEventListener('visibilitychange', function () {
			try { if (document.visibilityState === 'hidden') persistNow(); } catch (e) {}
		});
	} catch (e) {}

	window.DEBUG_SHARE = {
		isOn:             isOn,
		setEnabled:       setEnabled,
		// Cross-device flag sync, ridden on the existing parcel by daimond.js
		// (`collectSync` reads `syncSnapshot`, `applySync` calls `adoptSync`).
		syncSnapshot:     syncSnapshot,
		adoptSync:        adoptSync,
		registerProvider: registerProvider,
		registerStats:    registerStats,
		noteCross:        noteCross,
		snapshotNow:      snapshotNow,
		// THE EVENT SEAM. One call, `DEBUG_SHARE.event(kind, payload)`, from every
		// call site in the app; a no-op when sharing is off and never a throw into
		// the caller. `noteFetchFail` is the gateway wrapper's shorthand for the
		// `fetch.fail` kind, and `noteRealFold` tells the fold inference to stand
		// down because the engine reported a fold itself.
		event:            event,
		noteFetchFail:    noteFetchFail,
		noteRealFold:     noteRealFold,
		/// Is the feed still collecting? False once it has faulted, even while the
		/// share switch is on -- see `fault`.
		feedOk:           function () { return !feedOff; },
		/// How many events are waiting to go out.
		outboxDepth:      function () { return outbox.length; },
		// Exposed for the verifier: drive one telemetry tick without the 30 s timer.
		_telemetryTick:   telemetryTick,
		// Exposed for the verifier (www/js/debugshare.test.mjs):
		_fingerprint: fingerprint,
		_redact:      redact,
		_elide:       elide,
		_windowTranscripts: windowTranscripts,
		_byteLen:     byteLen,
		_assemble:    assemble,
		_chunk:       chunk,
		_publicSources: publicSources,
		_gatherSnapshot: gatherSnapshot,
		_gatherTelemetry: gatherTelemetry,
		_aggregateLedger: aggregateLedger,
		_signalBreakdown: signalBreakdown,
		_crossBreakdown:  crossBreakdown,
		_queueLen:    function () { return telQueue.length + snapQueue.length; },
		// Exposed for the verifier: the event lane, its persistence, and the two
		// timed collectors, so the outage/reload/fault rules can be driven without
		// waiting out an interval.
		_outbox:      function () { return outbox.slice(); },
		_persistNow:  persistNow,
		_beatTick:    beatTick,
		_capabilities: capabilities,
		_noteError:   noteError,
		_fit:         fit,
		_eventBatch:  eventBatch,
		_backoffMs:   function (n) { failStreak = n; return backoffMs(); },
		_drain:       drain,
		// Exposed for the verifier so it can assert lane ordering directly.
		_telQueueLen:  function () { return telQueue.length; },
		_snapQueueLen: function () { return snapQueue.length; },
	};
})();
