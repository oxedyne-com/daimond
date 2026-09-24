/* support.js — the stranger support loop: "Something went wrong" -> a report
 * the operator can actually read.
 *
 * WHY THIS EXISTS (D-20260920-02, arm B2 of the launch-scale plan). A
 * non-owner who hits a bug is a number in a column: telemetry.js is
 * deliberately integer-only, so a client crash reaches the gateway as
 * `error.thrown += 1` and nothing else. Two rings already hold the detail --
 * breadcrumb.js's always-on `DaimondTrail` and diag.js's opt-in
 * `DaimondDiag` -- but neither ever left the device unless a person found
 * Settings, turned Diagnostics on by hand, and pressed Share, and by then the
 * part of the ring that explained THIS bug had usually rolled past it.
 *
 * WHAT THIS FILE ADDS, and nothing more:
 *   1. `arm()` -- auto-arms Diagnostics for ARM_MS after an `error.thrown` or
 *      `turn.fail`, so a report made straight after an error is not empty.
 *      Never switches OFF a Diagnostics ring the person turned on themselves.
 *   2. `report()` -- the one-tap action. Assembles the build id, the trail
 *      and the diag ring into `{ts, tag, data}` rows and posts them through
 *      the EXISTING `/api/debug-trace` gate -- the same endpoint and wire
 *      shape diag.js's own `flush()` and daimond.js's `postDebugTrace` use.
 *      NO NEW TRANSPORT and no gateway change.
 *   3. Consent, asked ONCE PER ACCOUNT rather than per device: the answer
 *      rides the sync parcel exactly the way debugshare.js's toggle does --
 *      freshest-`at`-wins, `{on, at}`, verbatim (`syncSnapshot`/`adoptSync`
 *      below, wired into `collectSync`/`applySync` in daimond.js beside
 *      `debugShare`).
 *
 * WHAT IS NEVER SENT beyond what the two rings already hold: a report is
 * exactly their rows plus a build id and a short fixed reason code -- no
 * message text, no file contents, no keys, no free-text box. Same rule as
 * breadcrumb.js and diag.js state for themselves; this sends only what they
 * already collect.
 *
 * DEFERRED to the gateway half of B2 (not built here): a console reader that
 * lists these traces per account/wave, and a burst-rate view of
 * `error.thrown` per build. See the plan doc, §3 row B2(c).
 */
(function () {
	'use strict';

	var ENDPOINT   = '/api/debug-trace';
	var CLIENT_API = 2;                          // matches diag.js / debugshare.js / gateway.js

	// ── Auto-arm: a report made after an error is not empty ─────────
	//
	// Per-device (localStorage), not synced -- arming is about what THIS
	// device's ring holds right now, not a fact about the account.
	var ARMED_UNTIL_KEY  = 'daimond-support-armed-until';
	// Persisted OWNERSHIP: '1' iff THIS module is the one that switched
	// Diagnostics on and has not since let go of it. `ARMED_UNTIL_KEY` alone is
	// not enough to survive a reload -- a person who armed the ring BY HAND
	// leaves the same "something is on" fact on disk, and reading that fact
	// back as "I did this" is exactly what wiped a hand-armed ring at expiry
	// (finding #1). Written ONLY beside the branch that actually calls
	// `DaimondDiag.set(true, ...)`, and cleared the moment ownership ends --
	// on expiry, on a person's own Settings toggle, or on a ring found off.
	var ARMED_BY_US_KEY  = 'daimond-support-armed-by-us';
	var ARM_MS = 10 * 60 * 1000;                 // 10 minutes
	var armedByUs = false;                       // did THIS module switch Diagnostics on?
	var armTimer  = null;
	// Bumped by every `arm()`/resume, so a stale timer from an EARLIER error
	// (superseded by a second one extending the window) can tell it is stale
	// without re-deriving that from the clock -- `setTimeout`'s delay is a
	// request, never a promise, and a test (or a throttled background tab)
	// firing it early must not disarm a window that has not really elapsed.
	var armGen = 0;

	// ── Consent, per ACCOUNT ──────────────────────────────────────────
	//
	// Same shape and merge rule as debugshare.js's `debugShare: {on, at}`:
	// freshest-`at`-wins, written verbatim so a value both devices already
	// agree on serialises to the same bytes and the sync push-skip holds.
	//
	// ONE record, `{ on, at }`, written in one `setItem` through `DaimondStore`: as
	// two keys, a box that took the stamp and refused the value kept a new stamp on
	// an old answer, and never adopted or sent again (SIM-13).
	var CONSENT_REC_KEY   = 'daimond-support-consent-rec';
	// The pair it replaces, read only while the record has never been written.
	var CONSENT_KEY       = 'daimond-support-consent';
	var CONSENT_STAMP_KEY = 'daimond-support-consent-at';

	function read(k)     { try { return localStorage.getItem(k); } catch (e) { return null; } }
	function write(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* quota, or refused */ } }
	function ms(v)        { var n = parseInt(v, 10); return (isFinite(n) && n > 0) ? n : 0; }

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	/// A translated string, or the English written here when the key is
	/// missing. The same helper report.js and post.js carry, for the same
	/// reason: a build whose locale files have not caught up shows English
	/// rather than a raw key.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return String(fallback);
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return Object.prototype.hasOwnProperty.call(v, name) ? String(v[name]) : whole;
		});
	}

	function nudgeSync() {
		try { if (window.DaimondSync && DaimondSync.nudge) DaimondSync.nudge(); } catch (e) { /* next round does it */ }
	}

	// ── Consent: local read/write, and the sync parcel pair ───────────

	/// This device's decision, `{ on, at }`, or null when it has never made one.
	function consentRec() {
		var r = window.DaimondStore.get(CONSENT_REC_KEY, null);
		if (r && typeof r === 'object') return { on: !!r.on, at: ms(r.at) };
		var v = read(CONSENT_KEY), at = ms(read(CONSENT_STAMP_KEY));
		return (v !== null || at) ? { on: v === '1', at: at } : null;
	}

	/// The fresher of two decisions, `b` only when it beats `a`: the merge's law, and
	/// the one an owed decision is retried under. A tie goes the same way on every
	/// device, and to OFF: sharing diagnostics is consent, so withholding wins (A3).
	function fresherConsent(a, b) {
		if (!b) return a;
		return window.DaimondStamp.beats(b.at, !!b.on, a ? a.at : 0, a ? !!a.on : false, offFirst) ? b : a;
	}
	function offFirst(on) { return on ? 0 : 1; }

	function consented() { var r = consentRec(); return !!(r && r.on); }

	/// Record THIS device's own consent decision, stamped so it can win (or
	/// lose to) another device's answer for the same account over the next
	/// sync round.
	function setConsented(v) {
		// Past the decision it replaces, whatever the clocks (A1).
		var prev = consentRec();
		window.DaimondStore.put(CONSENT_REC_KEY, { on: !!v, at: window.DaimondStamp.next(prev && prev.at) }, fresherConsent);
		nudgeSync();
	}

	/// The consent flag as it rides the sync parcel: `{on, at}`, or `null`
	/// when this device has never decided. `null` reads to the other side as
	/// "nothing to say", so a fresh device cannot clear a decision another
	/// device already made. See `collectSync` in daimond.js.
	function syncSnapshot() {
		var r = consentRec();
		return (r && r.at) ? { on: r.on, at: r.at } : null;
	}

	/// Adopt a consent decision that arrived from another linked device: the
	/// STRICTLY fresher `at` wins and is written verbatim -- no restamp, so a
	/// record this device already holds moves nothing and the next parcel is
	/// byte-identical (the push-skip this app relies on everywhere else).
	/// See `applySync` in daimond.js.
	///
	/// A decision the box refuses THROWS, so the section is re-pulled rather than
	/// read as applied (SIM-16, A5).
	function adoptSync(rec) {
		if (!rec || typeof rec !== 'object') return;
		var at = ms(rec.at);
		if (!at) return;
		var mine = consentRec(), next = { on: !!rec.on, at: at };
		if (fresherConsent(mine, next) === next) window.DaimondStore.putMerged(CONSENT_REC_KEY, next, fresherConsent);
	}

	// ── Auto-arm ────────────────────────────────────────────────────

	/// Arm `DaimondDiag` for ARM_MS. A no-op on the ring itself when
	/// Diagnostics is already on -- this file only ever turns it on, and only
	/// ever turns off what IT turned on, so a person who opted in by hand in
	/// Settings is never switched off underneath them. Critically, the
	/// "armed-until" window is only ever recorded when THIS call is the one
	/// extending OUR OWN arm -- never as a side-effect of finding the ring
	/// already on for some other reason.
	function arm(why) {
		if (!window.DaimondDiag) return;
		try {
			if (!DaimondDiag.on()) {
				armedByUs = true;
				write(ARMED_BY_US_KEY, '1');
				DaimondDiag.set(true, why || 'auto-armed');
			}
			// Only write/extend the window when WE hold (or just took) ownership.
			// A ring already on because a PERSON armed it leaves `armedByUs` false
			// here, so neither key is touched -- their ring, their window, and this
			// file never claims a stake in it.
			if (armedByUs) {
				write(ARMED_UNTIL_KEY, String(Date.now() + ARM_MS));
				if (armTimer) clearTimeout(armTimer);
				var myGen = ++armGen;
				armTimer = setTimeout(function () { disarmIfOurs(myGen); }, ARM_MS + 250);
			}
		} catch (e) { /* a diagnostic aid must never break the caller that armed it */ }
	}

	/// Switch Diagnostics back off and let go of ownership. The one place that
	/// turns a ring THIS FILE armed back off, whether the window ran out on its
	/// own clock (`disarmIfOurs`) or was found already elapsed on boot (#2).
	function doDisarm(reason) {
		armedByUs = false;
		write(ARMED_BY_US_KEY, '0');
		write(ARMED_UNTIL_KEY, '0');
		try { if (window.DaimondDiag) DaimondDiag.set(false, reason); } catch (e) {}
	}

	function disarmIfOurs(gen) {
		armTimer = null;
		if (!armedByUs) return;
		// A second error inside the window called `arm()` again and bumped
		// `armGen`; this is that FIRST error's now-stale timer, and the window
		// it opened is still running under the newer one, so it must not close it.
		if (gen !== armGen) return;
		doDisarm('auto-arm expired');
	}

	// A reload during the arm window loses the timer, not the ring (diag.js
	// persists that itself); resume counting down from where it left off, but
	// ONLY when the PERSISTED OWNERSHIP MARKER says this file is the one that
	// armed it -- a ring on for any other reason (a person's own Settings
	// toggle) is never adopted here (finding #1's second half).
	(function resumeArm() {
		if (read(ARMED_BY_US_KEY) !== '1') return;
		if (!window.DaimondDiag || !DaimondDiag.on()) {
			// We owned it, but it is off already (or Diagnostics is unavailable) --
			// nothing left to resume; drop the stale markers rather than leave them
			// to be misread by a later boot.
			write(ARMED_BY_US_KEY, '0');
			write(ARMED_UNTIL_KEY, '0');
			return;
		}
		var until = ms(read(ARMED_UNTIL_KEY));
		armedByUs = true;
		if (until > Date.now()) {
			var myGen = ++armGen;
			armTimer = setTimeout(function () { disarmIfOurs(myGen); }, (until - Date.now()) + 250);
		} else {
			// #2: the tab was closed DURING the window and reopened AFTER it had
			// elapsed -- no timer ever fired, so without this the ring is left
			// stuck on, silently breaking the opt-in promise. Disarm immediately.
			doDisarm('auto-arm expired (found stuck on boot)');
		}
	})();

	// A person's OWN Settings toggle overrides whatever this file thinks it
	// owns, in either direction: whatever the ring is doing now is theirs, not
	// ours, so every marker that would let a later timer or boot treat it as
	// something we are free to switch off is dropped on the spot (finding #1).
	try {
		window.addEventListener('daimond:diagnostics', function (e) {
			var why = e && e.detail && e.detail.why;
			if (why !== 'settings') return;
			armedByUs = false;
			if (armTimer) { clearTimeout(armTimer); armTimer = null; }
			++armGen;                       // stales any timer already in flight
			write(ARMED_BY_US_KEY, '0');
			write(ARMED_UNTIL_KEY, '0');
		});
	} catch (e) { /* no addEventListener in this environment: nothing to listen with */ }

	// ── Assembling and posting the report ──────────────────────────

	function buildId() {
		try { return (window.DaimondTrail && DaimondTrail.lastBuild && DaimondTrail.lastBuild()) || ''; }
		catch (e) { return ''; }
	}
	function deviceId() {
		try { return (window.DaimondIdentity && DaimondIdentity.deviceId()) || ''; }
		catch (e) { return ''; }
	}

	/// Mask what the consent sheet promises never travels, so the promise is
	/// true BY CONSTRUCTION rather than by every future caller remembering not
	/// to log a secret. The two rings are meant to carry only event names, ids
	/// and counts, but a generic error sink (a thrown JS error, a provider
	/// error body quoted verbatim up to ~300 bytes -- `llm.rs`) can carry raw
	/// text neither ring meant to hold, so this runs over EVERY row's data
	/// regardless of source.
	function scrub(s) {
		s = String(s == null ? '' : s);
		// An API key, wherever it turns up in a stray error string.
		s = s.replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
		// An Authorization header quoted back by a provider or a fetch failure.
		s = s.replace(/\bBearer\s+\S+/gi, 'Bearer ***');
		// `diamonds/<id>/<path...>` names a real file inside a person's own
		// Diamond (e.g. "share land failed" at daimond.js's OPFS writer) --
		// the report needs to say WHICH file failed, not the shape of what is
		// inside their Diamond, so only the basename survives.
		s = s.replace(/\bdiamonds\/\S+/g, function (whole) {
			var parts = whole.replace(/["'),.;:]+$/, '').split('/');
			return parts[parts.length - 1] || whole;
		});
		return s;
	}

	/// The rows one report carries: a header row naming the build and the
	/// reason, then the trail (always-on, up to 200 rows) and the diag ring
	/// (up to 500, empty unless Diagnostics has been on for some of the last
	/// ARM_MS). Same `{ts, tag, data}` shape the gateway already accepts from
	/// diag.js's `flush()` and daimond.js's `postDebugTrace` -- no new field,
	/// no new endpoint. Every `data` field is scrubbed before it leaves this
	/// function (#3): nothing downstream needs to remember to do it.
	function reportRows(reason) {
		var rows = [{
			ts:   Date.now(),
			tag:  'report',
			data: 'reason=' + String(reason || 'unspecified').slice(0, 40) + ' build=' + (buildId() || '?'),
		}];
		try {
			var trail = (window.DaimondTrail && DaimondTrail.rows) ? DaimondTrail.rows() : [];
			trail.forEach(function (r) {
				rows.push({ ts: r.t, tag: ('trail ' + (r.w || '')).slice(0, 64), data: scrub(r.d || '') });
			});
		} catch (e) { /* the trail is best-effort; a report without it still says something */ }
		try {
			var diag = (window.DaimondDiag && DaimondDiag.rows) ? DaimondDiag.rows() : [];
			diag.forEach(function (r) {
				rows.push({ ts: r.ts, tag: ('diag ' + (r.tag || '')).slice(0, 64), data: scrub(r.data || '') });
			});
		} catch (e) { /* likewise */ }
		return rows;
	}

	// ── Byte budget (#7) ───────────────────────────────────────────
	//
	// A fullest report -- 200 trail rows plus 500 diag rows -- can outgrow
	// `MAX_BODY` (256 KiB, `gateway/src/handlers/debug_trace.rs`) once wrapped
	// in the post envelope, and the gateway then answers 413 and the report is
	// lost entirely. Trimmed here, on the client, so a big report arrives
	// SMALLER rather than not at all.
	var BODY_BUDGET = 250 * 1024;                // headroom under the gateway's 256 KiB cap

	function byteLen(s) {
		try { return new TextEncoder().encode(s).length; }
		catch (e) { return String(s).length; }    // no TextEncoder: an ASCII-length estimate is still a bound
	}

	/// Trim ROWS to fit BODY_BUDGET once wrapped in the wire envelope,
	/// dropping the OLDEST rows first (everything after the header) so the
	/// header and the events nearest the failure -- the newest -- survive.
	function fitBudget(rows) {
		var envelope = byteLen(JSON.stringify({ v: 1, device: deviceId(), rows: [] }));
		var sizes = rows.map(function (r) { return byteLen(JSON.stringify(r)) + 1; });   // +1 for the join comma
		var total = envelope;
		for (var i = 0; i < sizes.length; i++) total += sizes[i];
		if (total <= BODY_BUDGET || rows.length <= 1) return rows;
		var drop = 1;                             // never drop the header at index 0
		while (drop < rows.length && total > BODY_BUDGET) {
			total -= sizes[drop];
			drop++;
		}
		return [rows[0]].concat(rows.slice(drop));
	}

	/// Does a report carry more than its own header -- i.e. did either ring
	/// have something to say? Exposed so a caller (and the dev test) can tell
	/// a genuinely empty report from one that merely names a build.
	function nonEmpty(rows) { return Array.isArray(rows) && rows.length > 1; }

	/// Post one report to the existing debug-trace gate. Answers
	/// `{ok, rows, why}`. Subject to the SAME gateway rate floor diag.js's own
	/// `flush()` observes (`debug_trace.rs::MIN_INTERVAL_MS`) -- a double tap
	/// is answered with the same 429.
	function post(reason) {
		var rows = fitBudget(reportRows(reason));
		return fetch(ENDPOINT, {
			method:      'POST',
			credentials: 'same-origin',
			headers:     { 'content-type': 'application/json', 'x-daimond-api': String(CLIENT_API) },
			body:        JSON.stringify({ v: 1, device: deviceId(), rows: rows }),
		}).then(function (res) {
			if (res && res.ok) return { ok: true, rows: rows.length };
			return { ok: false, rows: rows.length, why: 'the server declined (' + (res && res.status) + ')' };
		}, function () {
			return { ok: false, rows: rows.length, why: 'the request could not be sent' };
		});
	}

	// ── The consent sheet, and the one-tap entry point ───────────────

	function elt(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	var _open = null;
	function close() {
		if (_open && _open.parentNode) _open.parentNode.removeChild(_open);
		_open = null;
	}

	/// The one-tap action, called from the error toast and from Settings.
	/// Sends straight away once this account has agreed; the FIRST time ever,
	/// shows the consent sheet instead. `say(text)`, optional, is handed a
	/// short line the caller may display (a toast update, a settings status
	/// line...).
	function reportProblem(reason, say) {
		say = typeof say === 'function' ? say : function () {};
		if (consented()) {
			say(tOr('support.sending', 'Sending a report…'));
			post(reason).then(function (r) { say(sentLine(r)); });
			return;
		}
		openConsent(reason, say);
	}

	function sentLine(r) {
		return r.ok
			? tOr('support.sent', 'Sent — thank you.')
			: tOr('support.send_failed', 'Could not send') + (r.why ? ': ' + r.why : '');
	}

	function openConsent(reason, say) {
		close();
		var wrap = elt('div', 'modal');
		wrap.id = 'support-sheet';
		var card = elt('div', 'modal-card');
		card.appendChild(elt('h2', '', tOr('support.title', 'Send a report?')));
		card.appendChild(elt('p', 'report-rule', tOr('support.rule',
			'This sends the app’s recent activity log -- event names, ids, counts and a '
				+ 'clock, never your messages, files or keys -- to the Daimond team, so this '
				+ 'problem can be diagnosed. Asked once for this account; every linked device '
				+ 'remembers the answer.')));
		var status = elt('p', 'report-status');
		status.setAttribute('role', 'status');
		card.appendChild(status);
		var acts = elt('div', 'post-acts');
		var go = elt('button', 'post-btn report-send', tOr('support.send', 'Send this report'));
		go.type = 'button';
		var no = elt('button', 'post-btn report-cancel', tOr('support.cancel', 'Not now'));
		no.type = 'button';
		acts.appendChild(go);
		acts.appendChild(no);
		card.appendChild(acts);
		no.addEventListener('click', close);
		go.addEventListener('click', function () {
			setConsented(true);
			go.disabled = true;
			status.textContent = tOr('support.sending', 'Sending a report…');
			post(reason).then(function (r) {
				status.textContent = sentLine(r);
				say(sentLine(r));
				no.textContent = tOr('support.done', 'Close');
			});
		});
		wrap.appendChild(card);
		document.body.appendChild(wrap);
		_open = wrap;
		go.focus();
	}

	window.DaimondSupport = {
		report:       reportProblem,      // the one-tap action
		arm:          arm,                // auto-arm Diagnostics after an error
		consented:    consented,
		syncSnapshot: syncSnapshot,        // for collectSync
		adoptSync:    adoptSync,           // for applySync
		reportRows:   reportRows,          // exposed for the dev test
		nonEmpty:     nonEmpty,
		post:         post,
		scrub:        scrub,               // exposed for the dev test (#3)
		fitBudget:    fitBudget,           // exposed for the dev test (#7)
	};
})();
