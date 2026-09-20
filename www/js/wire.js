/* www/js/wire.js -- the measure-before-send seam.
 *
 * ONE client-side owner of the message-path caps, so a payload is weighed against
 * the door's own rule BEFORE it is sealed and sent rather than after a 413. The
 * gateway turns a body away on a cheap pre-decode estimate -- `b64.len()/4*3 > cap`
 * (sync.rs:423, mirrored on the post door) -- so that exact integer arithmetic is
 * written ONCE here for sync.js (the lease door), post.js, share.js and peer.js to
 * consult rather than each carrying its own copy of a number that lives in four
 * places on the gateway and is served by none of them.
 *
 * TWO PHASES. Phase A (this file, www only): the FALLBACK table below IS the live
 * pin, so behaviour is byte-for-byte the gateway's rule with no gateway change.
 * Phase B (a later gateway restart): the gateway serves a `limits` object on two
 * answers the client already reads, and `learn` moves an entry off it -- but a
 * served value only ever REPLACES a fallback, never widens the table, so an older
 * gateway that sends nothing changes nothing.
 */
(function () {
	'use strict';
	// The fallback table IS the live pin (gateway/app.jdat, sync.rs:378), not a knob's
	// default: a served value replaces an entry; nothing here is ever raised on a guess.
	var FALLBACK = {
		lease:     65536,	// sync.rs:378 LEASE_MAX_BYTES
		post:      65536,	// app.jdat:158 /api/post max_bytes
		post_rows: 500,		// app.jdat:159 /api/post max_rows (a count, not bytes)
		collect:   1048576,	// app.jdat:161 /api/post max_collect_bytes
		share:     3145728,	// share.js:125 RELAY_MAX (the share's own ceiling; #5)
		progress:  65536,	// sync.rs:480 (#12)
	};
	var _served = {};		// kind -> bytes, from the gateway; in-memory only.

	/// The cap for `kind` in bytes (or a count for `post_rows`); 0 for a kind this
	/// table does not know, so `fits` refuses rather than guesses.
	function limit(kind) {
		var k = String(kind || '');
		if (_served[k] > 0) return _served[k];
		return FALLBACK[k] > 0 ? FALLBACK[k] : 0;
	}

	/// Would a sealed payload whose BASE64 form is `b64Len` characters long pass the
	/// gateway's door for `kind`? The gateway's own pre-decode estimate, verbatim.
	function fits(kind, b64Len) {
		var cap = limit(kind);
		if (!cap) { try { console.warn('wire: unknown kind', kind); } catch (e) {} return false; }
		return Math.floor(Number(b64Len || 0) / 4) * 3 <= cap;
	}

	/// Ingest a served `limits` object. Only a positive finite number moves an entry
	/// this table already knows; anything else is ignored, so a missing or older
	/// gateway changes nothing.
	function learn(obj) {
		if (!obj || typeof obj !== 'object') return;
		for (var k in obj) {
			if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
			var v = Number(obj[k]);
			if (isFinite(v) && v > 0 && Object.prototype.hasOwnProperty.call(FALLBACK, k)) {
				_served[k] = Math.floor(v);
			}
		}
	}

	/// Where the cap for `kind` came from: 'served' once the gateway has taught it,
	/// 'fallback' while it is still the live pin. For the debug feed, not a gate.
	function source(kind) {
		return _served[String(kind || '')] > 0 ? 'served' : 'fallback';
	}

	window.DaimondWire = {
		limit:  limit,
		fits:   fits,
		learn:  learn,
		source: source,
		KINDS:  Object.keys(FALLBACK),
	};
})();
