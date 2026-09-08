/* diag.js — an opt-in, richer trail of the sync/apply decisions.
 *
 * WHY THIS EXISTS, BESIDE breadcrumb.js. The always-on trail (breadcrumb.js) is
 * a 200-row list of fixed EVENT names -- "boot", "unlocked", "sync pull 12K
 * sealed" -- and it is deliberately coarse, because it is on for everyone and
 * pasted by hand into a bug report. It cannot say WHICH chats a parcel carried,
 * which the merge kept, skipped, removed or resurrected, or how a hand-off
 * moved between devices. That is the detail the iPhone loop and the converge
 * failures actually turn on, and it is invisible on a phone with no console.
 *
 * So this is a SECOND, richer ring -- the last 500 decisions, each a
 * `{ts, tag, data}` -- gated behind an opt-in "Diagnostics" switch that is OFF
 * by default and per-device. When it is off, `log()` is a single boolean test
 * and returns; nothing is recorded and nothing can leave the device. When it is
 * on, the device records its own decisions and, on request, may share them with
 * the gateway so the operator can read what iOS did server-side.
 *
 * WHAT IS NEVER RECORDED. The same rule as the trail: no passphrase, no key, no
 * token, no message text, no file contents, no address. What IS recorded is
 * chat IDS (random handles this app minted), version numbers, counts, and fixed
 * decision tags -- the shape of a merge, never its content. The gateway that
 * receives a shared log keys the file by the account (which it minted and reads
 * off the session, never off the body) and the opaque per-device id.
 */
(function () {
	'use strict';

	var ENABLED_KEY = 'daimond-diagnostics';	// per-device opt-in; '1' is on
	var RING_KEY    = 'daimond-diag-ring';		// the persisted ring, so it survives a reload
	var LASTFLUSH_KEY = 'daimond-diag-flushed';	// last successful share, for the client rate cap

	// 500, not the trail's 200: a single converge failure can touch dozens of
	// chats, and the beginning of a loop -- the part that says what started it --
	// must not fall off the end of one apply.
	var MAX = 500;
	// The endpoint a share posts to. Proxied to the app-side gateway, which
	// appends to a per-account/per-device file the operator reads. See
	// gateway/src/handlers/debug_trace.rs.
	var ENDPOINT = '/api/debug-trace';
	// The client half of the rate cap. The gateway keeps its own, authoritative;
	// this only spares a user who taps twice.
	var MIN_FLUSH_MS = 15000;
	// The most rows one share carries. The gateway caps the body too; this keeps
	// the post small on a phone.
	var MAX_FLUSH_ROWS = 500;
	// The client API version header, so a share is not met with a 426. Matches
	// CLIENT_API in gateway.js.
	var CLIENT_API = 2;

	var t0 = Date.now();

	// Cached so `on()` -- called at the top of every `log()` -- is a field read
	// rather than a localStorage hit. Kept in step by `set()` and by a
	// cross-tab `storage` event (a switch flipped in one tab reaches the others).
	var enabled = read(ENABLED_KEY) === '1';
	// The in-memory ring. Loaded once from storage so a reload keeps what the
	// last page recorded, then held here and persisted on a debounce.
	var ring = loadRing();

	function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

	function loadRing() {
		try {
			var r = JSON.parse(localStorage.getItem(RING_KEY) || '[]');
			return Array.isArray(r) ? r.slice(-MAX) : [];
		} catch (e) { return []; }
	}

	/// The same ANSI/escape scrub the trail uses: an `err!` crossing the wasm
	/// boundary arrives wrapped in colour codes, which are noise in a text box.
	function plain(s) {
		return String(s)
			.replace(/\[[0-9;]*m/g, '')
			.replace(/\[[0-9]{1,2}(;[0-9]{1,2})*m/g, '')
			.replace(/\s+/g, ' ')
			.trim();
	}

	// Persistence is debounced: the ring is held in memory and written to
	// storage a short beat after the last event, so a merge touching dozens of
	// chats rewrites the ~150 KB blob once, not once per chat. A page going away
	// flushes it synchronously, so a reload -- the very thing under suspicion on
	// the looping phone -- never loses the tail.
	var saveTimer = null;
	function persistSoon() {
		if (saveTimer) return;
		saveTimer = setTimeout(function () { saveTimer = null; persistNow(); }, 250);
	}
	function persistNow() {
		if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
		try { localStorage.setItem(RING_KEY, JSON.stringify(ring)); }
		catch (e) { /* quota, or storage refused: a diagnostic is never worth an error */ }
	}

	/// Record one decision. A NO-OP WHEN DIAGNOSTICS IS OFF -- the first line is
	/// the whole cost then, so the seams may call it unconditionally.
	///
	/// `tag` is a short fixed string from the app's own code; `data` is ids,
	/// counts and versions, never anything a user or a model typed.
	function log(tag, data) {
		if (!enabled || !tag) return;
		try {
			ring.push({
				ts:   Date.now(),
				// How long this PAGE has been alive, so a reload -- a small number
				// after a large one -- is legible at a glance, as in the trail.
				a:    Date.now() - t0,
				tag:  plain(tag).slice(0, 48),
				data: data == null ? undefined : plain(data).slice(0, 300),
			});
			if (ring.length > MAX) ring = ring.slice(ring.length - MAX);
			persistSoon();
		} catch (e) { /* never let a diagnostic throw into a caller */ }
	}

	function rows() { return ring.slice(); }

	function on() { return enabled; }

	/// Turn Diagnostics on or off. Turning it OFF clears the ring: a person who
	/// switches it off has said they no longer want their decisions recorded,
	/// and the honest response is to forget what was recorded, not to keep it
	/// where the next share could still carry it.
	function set(v, why) {
		enabled = !!v;
		try { localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0'); } catch (e) {}
		if (!enabled) {
			ring = [];
			persistNow();
		} else {
			log('diagnostics on', why || '');
		}
		try {
			window.dispatchEvent(new CustomEvent('daimond:diagnostics', { detail: { on: enabled } }));
		} catch (e) {}
	}

	function clear() { ring = []; persistNow(); }

	/// The ring as text, NEWEST FIRST, for a person to read and paste. Newest
	/// first because the question is almost always "what did it just do".
	function text(header) {
		var out = [];
		if (header) {
			Object.keys(header).forEach(function (k) {
				out.push('# ' + k + ': ' + header[k]);
			});
			out.push('#');
		}
		for (var i = ring.length - 1; i >= 0; i--) {
			var r = ring[i];
			var when = new Date(r.ts).toISOString().slice(11, 23);
			out.push(when + '  +' + (Math.round((r.a || 0) / 100) / 10) + 's  '
				+ r.tag + (r.data ? '  ' + r.data : ''));
		}
		return out.join('\n');
	}

	/// The wall-clock of the most recent event carrying `tag` (e.g. 'pull'), or
	/// 0. The panel header reads "last pull" from this rather than reaching into
	/// sync.js for a private cursor.
	function lastTs(tag) {
		for (var i = ring.length - 1; i >= 0; i--) {
			if (ring[i].tag === tag) return ring[i].ts;
		}
		return 0;
	}

	// ── Sharing the log with the gateway ─────────────────────────
	//
	// GATED THREE WAYS. Diagnostics must be on; a session cookie must be present
	// (the gateway derives the account from it and refuses without one); and a
	// client-side minimum interval spares a double tap. The gateway keeps the
	// authoritative rate and size caps -- this end is a courtesy, not a control.

	/// Share the ring with the gateway. Answers `{ ok, why }`. A no-op that
	/// answers `{ ok:false, why:'off' }` when Diagnostics is off, so no caller
	/// can post without the switch.
	function flush() {
		if (!enabled) return Promise.resolve({ ok: false, why: 'off' });
		var last = 0;
		try { last = parseInt(read(LASTFLUSH_KEY) || '0', 10) || 0; } catch (e) {}
		if (Date.now() - last < MIN_FLUSH_MS) {
			return Promise.resolve({ ok: false, why: 'too soon; wait a moment and try again' });
		}
		var device = '';
		try { device = (window.DaimondIdentity && DaimondIdentity.deviceId()) || ''; } catch (e) {}
		var payload = {
			v:      1,
			device: device,
			rows:   ring.slice(-MAX_FLUSH_ROWS).map(function (r) {
				return { ts: r.ts, tag: r.tag, data: r.data == null ? '' : r.data };
			}),
		};
		// Persist the attempt time BEFORE the request, so a slow network cannot
		// let a second tap through while the first is still in flight.
		try { localStorage.setItem(LASTFLUSH_KEY, String(Date.now())); } catch (e) {}
		return fetch(ENDPOINT, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body:        JSON.stringify(payload),
		}).then(function (res) {
			if (res && res.ok) { log('shared diagnostics', payload.rows.length + ' rows'); return { ok: true }; }
			return { ok: false, why: 'the server declined (' + (res && res.status) + ')' };
		}, function (e) {
			return { ok: false, why: 'the request could not be sent' };
		});
	}

	// ── The on-device panel ──────────────────────────────────────

	function elWith(tag, style, text) {
		var e = document.createElement(tag);
		if (style) e.setAttribute('style', style);
		if (text != null) e.textContent = text;
		return e;
	}

	/// Render the panel into `container`, from the ring and a `header` state
	/// object the app supplies (device id/name, version, chat count, locked). A
	/// SELF-CONTAINED view: it builds its own DOM with inline styles so it draws
	/// the same in the app's settings panel and in a bare test harness, and reads
	/// legibly on a phone screenshot without the app's CSS.
	///
	/// `header` is `{ device, deviceName, version, chats, locked, build }`; any
	/// field may be absent. "Last pull" is derived from the ring itself.
	function renderPanel(container, header) {
		if (!container) return;
		container.textContent = '';
		header = header || {};

		var wrap = elWith('div', 'font:13px/1.5 -apple-system,system-ui,sans-serif;'
			+ 'color:#111;background:#fff;padding:12px;border-radius:8px;'
			+ 'max-width:100%;box-sizing:border-box;');

		// ── the header block ──
		var lastPull = lastTs('pull');
		var head = [
			['Diagnostics',  enabled ? 'on' : 'off'],
			['Device',       (header.deviceName ? header.deviceName + '  ' : '') + '(' + short(header.device) + ')'],
			['Identity',     header.locked ? 'locked' : 'unlocked'],
			['Parcel version', header.version == null ? '?' : String(header.version)],
			['Chats in rail', header.chats == null ? '?' : String(header.chats)],
			['Last pull',    lastPull ? new Date(lastPull).toISOString().slice(11, 19) : 'none this session'],
			['Build',        header.build || '?'],
			['Events held',  String(ring.length) + ' of ' + MAX],
		];
		var hbox = elWith('div', 'display:grid;grid-template-columns:auto 1fr;gap:2px 12px;'
			+ 'margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid #ddd;');
		head.forEach(function (kv) {
			hbox.appendChild(elWith('div', 'color:#666;', kv[0]));
			hbox.appendChild(elWith('div', 'font-weight:600;word-break:break-word;', kv[1]));
		});
		wrap.appendChild(hbox);

		// ── the copy affordance ──
		var bar = elWith('div', 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;');
		var copyBtn = elWith('button', 'font:13px inherit;padding:6px 12px;border:1px solid #bbb;'
			+ 'border-radius:6px;background:#f4f4f4;cursor:pointer;', 'Copy');
		copyBtn.addEventListener('click', function () {
			var txt = text(headerLines(head));
			var done = function () { copyBtn.textContent = 'Copied'; };
			if (txt && navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(txt).then(done, function () { selectInto(pre, txt); });
			} else { selectInto(pre, txt); }
		});
		bar.appendChild(copyBtn);
		wrap.appendChild(bar);

		// ── the events, newest first ──
		var pre = elWith('div', 'font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;'
			+ 'white-space:pre-wrap;word-break:break-word;background:#fafafa;'
			+ 'border:1px solid #eee;border-radius:6px;padding:8px;'
			+ 'max-height:60vh;overflow:auto;user-select:text;-webkit-user-select:text;');
		pre.textContent = ring.length
			? text(headerLines(head))
			: 'Nothing recorded yet — this device has made no sync or apply decisions since Diagnostics was turned on.';
		wrap.appendChild(pre);

		container.appendChild(wrap);
	}

	function headerLines(head) {
		var h = {};
		head.forEach(function (kv) { h[kv[0]] = kv[1]; });
		return h;
	}
	function short(id) { id = String(id || ''); return id ? id.slice(0, 8) : 'this device'; }
	function selectInto(pre, txt) {
		if (txt) pre.textContent = txt;
		try {
			var r = document.createRange(); r.selectNodeContents(pre);
			var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
		} catch (e) {}
	}

	// A switch flipped in one tab reaches the others, so a person who turns
	// Diagnostics off does not leave it recording in a tab they forgot.
	window.addEventListener('storage', function (e) {
		if (e && e.key === ENABLED_KEY) enabled = read(ENABLED_KEY) === '1';
	});
	// Flush the ring the instant the page goes away, so the looping phone's last
	// decisions survive the reload that erased everything before this existed.
	window.addEventListener('pagehide', persistNow);
	window.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'hidden') persistNow();
	});

	window.DaimondDiag = {
		on:          on,
		set:         set,
		log:         log,
		rows:        rows,
		text:        text,
		clear:       clear,
		flush:       flush,
		lastTs:      lastTs,
		renderPanel: renderPanel,
	};
})();
