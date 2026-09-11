/* debugshare.js — TRAINING WHEELS, remove after beta.
 *
 * ============================================================================
 * TRAINING WHEELS — remove after beta. This whole file, its <script> tag in
 * index.html, and the two `DEBUG_SHARE` touch points in daimond.js (the
 * Settings toggle and the one `registerProvider` call) are a temporary,
 * owner-requested debug aid. Deleting the file, its script tag, and grepping
 * `DEBUG_SHARE` / `TRAINING WHEELS` out of daimond.js lifts the feature in one
 * obvious pass. Nothing else depends on it.
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
	var telTimer = null, snapTimer = null;
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

	// ── Posting and draining ─────────────────────────────────────

	function deviceId() {
		try { return (window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId()) || ''; }
		catch (e) { return ''; }
	}

	/// POST one batch of rows. Fire-and-forget on the network, but the promise
	/// resolves so the drainer can pace itself. A down endpoint is not our problem.
	function postRows(rows) {
		var body = JSON.stringify({ v: 1, device: deviceId(), rows: rows });
		return fetch(ENDPOINT, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body:        body,
		}).then(function () {}, function () {});
	}

	/// True while either lane holds a pending post.
	function pending() { return telQueue.length > 0 || snapQueue.length > 0; }

	/// Drain the two lanes one batch every `POST_GAP_MS`, so the handler's rate cap
	/// never refuses us. The telemetry lane is always taken first and emptied before
	/// any snapshot batch is sent, so a telemetry post that arrives mid-snapshot is
	/// the very next thing on the wire. Stops the instant the feature is turned off
	/// (both lanes are cleared by `applyState`, and this checks `enabled` each round).
	function drain() {
		if (draining) return;
		draining = true;
		(function step() {
			if (!enabled || !pending()) { draining = false; return; }
			// Telemetry jumps the queue: the priority lane wins whenever it has anything.
			var rows = telQueue.length ? telQueue.shift() : snapQueue.shift();
			postRows(rows).then(function () {
				if (!enabled || !pending()) { draining = false; return; }
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

	/// Assemble and enqueue a full snapshot. A no-op when off.
	function snapshotNow() {
		if (!enabled) return Promise.resolve(false);
		return gatherSnapshot().then(function (bundle) {
			enqueue(chunk(bundle));
			return true;
		});
	}

	function telemetryTick() {
		if (!enabled) return;
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
		try { telTimer  = setInterval(telemetryTick, TELEMETRY_MS); } catch (e) {}
		try { snapTimer = setInterval(function () { snapshotNow(); }, RESNAP_MS); } catch (e) {}
	}
	function stopTimers() {
		try { if (telTimer) clearInterval(telTimer); } catch (e) {}
		try { if (snapTimer) clearInterval(snapTimer); } catch (e) {}
		telTimer = null; snapTimer = null;
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
		} else {
			stopTimers();
			telQueue = [];
			snapQueue = [];
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
		// Exposed for the verifier so it can assert lane ordering directly.
		_telQueueLen:  function () { return telQueue.length; },
		_snapQueueLen: function () { return snapQueue.length; },
	};
})();
