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
 * secretly collecting. Off by default and per-device; when off, nothing is
 * gathered and nothing is posted, and the only footprint is the toggle and (when
 * on) the indicator.
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
	var ENABLED_KEY = 'daimond-debugshare';		// per-device opt-in; '1' is on
	var LEDGER_KEY  = 'daimond-ledger';			// the cost ledger, read directly
	var ENDPOINT    = '/api/debug-trace';
	var CLIENT_API  = 2;						// matches CLIENT_API in gateway.js / diag.js

	var MAX_DATA_BYTES = 360;
	var MAX_ROWS_POST  = 400;
	var MAX_BODY_BYTES = 200 * 1024;
	var POST_GAP_MS    = 11000;

	var TELEMETRY_MS = 30000;					// stream telemetry cadence while on
	var RESNAP_MS    = 300000;					// periodic full re-snapshot (5 min)

	// A transcript embeds whole source-file reads verbatim, so a snapshot was ~7 MB
	// / 25k chunks and drained for ~12 min, starving telemetry behind it. Every
	// string past this cap is truncated to head + a "[+N chars]" tail before the
	// bundle ships, which the operator still reads but which fits in a few posts.
	// daimond.js has no `TOOL_ELISION_CAP` to reuse, so the figure lives here.
	var ELISION_CAP = 400;

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
	var queue    = [];				// pending posts, each an array of {ts,tag,data} rows
	var draining = false;
	var telTimer = null, snapTimer = null;
	var indicator = null;
	// Telemetry cursors, so a tick sends only what is NEW since the last one.
	var lastLedgerLen = 0, lastTrailLen = 0, lastDiagLen = 0;

	function read(k)  { try { return localStorage.getItem(k); } catch (e) { return null; } }
	function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

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

	/// A deep copy of `obj` with every over-long string truncated to its first
	/// `ELISION_CAP` characters plus a `…[+N chars]` tail naming how much was cut.
	/// Structure-preserving, so the operator still sees the shape of a transcript --
	/// only the verbatim source-file reads inside it are shortened. Cycle-safe and
	/// depth-bounded, like `redact()`, since the state it walks is arbitrary.
	function elide(obj, seen, depth) {
		seen = seen || [];
		depth = depth || 0;
		if (typeof obj === 'string') {
			return obj.length > ELISION_CAP
				? obj.slice(0, ELISION_CAP) + '…[+' + (obj.length - ELISION_CAP) + ' chars]'
				: obj;
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
		return { ledger: ledger, trail: trail, diag: diag };
	}

	/// Assemble a full snapshot from a `sources` object and the provider's state.
	/// Exposed for tests as `_assemble`. Redacts the whole result before returning,
	/// so no caller can ever hold an un-redacted bundle.
	function assemble(sources, state) {
		sources = sources || {};
		state = state || {};
		var raw = {
			v:          1,
			kind:       'snapshot',
			ts:         Date.now(),
			iso:        new Date().toISOString(),
			// From the provider (daimond.js) -- the decrypted, private-scope state.
			config:      state.config || null,
			transcripts: state.transcripts || null,
			roster:      state.roster || null,
			presence:    state.presence || null,
			election:    state.election || null,
			tokenStats:  state.tokenStats || null,
			// From this module's own public reads.
			ledger:      sources.ledger || [],
			trail:       sources.trail || [],
			diag:        sources.diag || [],
		};
		// Elide first, so the transcripts' verbatim source-file reads are capped
		// before the bundle is chunked; then redact, so a secret-named field is a
		// fingerprint regardless of what elision left of it.
		return redact(elide(raw));
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
		var stats = {
			models: aggregateLedger(s.ledger),
			live:   liveStats(),
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

	/// Drain the post queue one batch every `POST_GAP_MS`, so the handler's rate
	/// cap never refuses us. Stops the instant the feature is turned off (the
	/// queue is cleared by `setEnabled`, and this checks `enabled` each round).
	function drain() {
		if (draining) return;
		draining = true;
		(function step() {
			if (!enabled || !queue.length) { draining = false; return; }
			var rows = queue.shift();
			postRows(rows).then(function () {
				if (!enabled || !queue.length) { draining = false; return; }
				setTimeout(step, POST_GAP_MS);
			});
		})();
	}

	function enqueue(posts) {
		if (!enabled || !posts || !posts.length) return;
		for (var i = 0; i < posts.length; i++) queue.push(posts[i]);
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
		if (tel) enqueue(chunk(tel));
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

	/// Turn the feature on or off. On: show the indicator, start the timers, and
	/// post a full snapshot. Off: hide the indicator, stop the timers, drop any
	/// queued posts, and reset the telemetry cursors -- nothing more leaves the
	/// device. Idempotent and safe to call before the DOM exists (the indicator is
	/// simply not mounted then, and mounts on the next `on`).
	function setEnabled(v) {
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
			queue = [];
			unmountIndicator();
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

	// A switch flipped in one tab reaches the others, so turning it off in one
	// place stops collection everywhere.
	try {
		window.addEventListener('storage', function (e) {
			if (e && e.key === ENABLED_KEY) {
				var now = read(ENABLED_KEY) === '1';
				if (now !== enabled) setEnabled(now);
			}
		});
	} catch (e) {}

	window.DEBUG_SHARE = {
		isOn:             isOn,
		setEnabled:       setEnabled,
		registerProvider: registerProvider,
		registerStats:    registerStats,
		snapshotNow:      snapshotNow,
		// Exposed for the verifier (www/js/debugshare.test.mjs):
		_fingerprint: fingerprint,
		_redact:      redact,
		_elide:       elide,
		_assemble:    assemble,
		_chunk:       chunk,
		_publicSources: publicSources,
		_gatherSnapshot: gatherSnapshot,
		_gatherTelemetry: gatherTelemetry,
		_aggregateLedger: aggregateLedger,
		_queueLen:    function () { return queue.length; },
	};
})();
