/* hostspeed.js -- each model's measured speed on each host, as the page reads it (D-20261020-10).

   THE PAGE-FACING SEAM.  `DaimondHostSpeed.figures()` returns one object per (model, host)
   pairing measured in the window (the newest 12 rounds, at most 48 h old; `src/hostspeed.rs`):

       { model:      'deepseek/deepseek-v4.1-flash',  // the model id as requested
         host:       'DeepInfra',       // the host OpenRouter named on the round
         rounds:     9,                 // rounds in the window
         tps:        41.2,              // median output tokens a second, or null when none was long enough to time
         firstMs:    1840,              // median ms to the first token, or null when none came
         stallShare: 0.11,              // share of the rounds that went silent
         slow:       false,             // routing leaves this host out for this model
         why:        '',                // when slow: 'stalls', 'rate', 'behind' or 'wait'
         out:        15302,             // output tokens over the window
         lastAt:     1792700000000 }    // newest round, ms since 1970

   Sorted by model, then host.  An engine that is not up yet, or a bundle without the export,
   gives [].  The measuring and the routing are the engine's; this file only reads them and keeps
   the window across visits in localStorage.  Model Compare's speed columns and the U5b routing
   rows are built on `figures()`, so its shape is a contract: add fields, never rename one.
*/
(function () {
	'use strict';

	var KEY     = 'daimond.hostspeed.v1';	// localStorage key for the window
	var SAVE_MS = 2000;						// a burst of rounds is one write

	var wasm = null, timer = null;

	function num(x) { return typeof x === 'number' && isFinite(x) ? x : null; }
	function store() {
		try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
	}

	// One engine row in the page's shape.
	function shape(r) {
		var rounds = Math.max(0, Math.round(num(r.rounds) || 0));
		var stalls = Math.max(0, Math.round(num(r.stalls) || 0));
		var why = typeof r.slow === 'string' ? r.slow : '';
		return {
			model:      String(r.model || ''),
			host:       String(r.host || ''),
			rounds:     rounds,
			tps:        num(r.tps),
			firstMs:    num(r.first_ms),
			stallShare: rounds ? stalls / rounds : 0,
			slow:       why !== '',
			why:        why,
			out:        Math.max(0, Math.round(num(r.out) || 0)),
			lastAt:     Math.max(0, Math.round(num(r.last_at) || 0)),
		};
	}

	/// The engine's JSON as `figures()` returns it; exported for the test.
	function parse(text) {
		var rows;
		try { rows = JSON.parse(String(text || '[]')); } catch (e) { return []; }
		if (!Array.isArray(rows)) return [];
		return rows.filter(function (r) { return r && typeof r === 'object' && r.model && r.host; })
			.map(shape)
			.sort(function (a, b) {
				return a.model < b.model ? -1 : a.model > b.model ? 1 : (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
			});
	}

	function figures() {
		if (!wasm || typeof wasm.host_speeds !== 'function') return [];
		try { return parse(wasm.host_speeds()); } catch (e) { return []; }
	}

	/// Write the window now.  A full or refused store loses the figures, which the next rounds remake.
	function save() {
		if (timer) { clearTimeout(timer); timer = null; }
		var s = store();
		if (!s || !wasm || typeof wasm.host_speeds_save !== 'function') return false;
		try { s.setItem(KEY, String(wasm.host_speeds_save())); return true; } catch (e) { return false; }
	}

	function saveSoon() {
		if (timer || !wasm) return;
		timer = setTimeout(save, SAVE_MS);
	}

	/// Bind the engine, once it is instantiated, and give it back last visit's window.
	function attach(mod) {
		wasm = mod || null;
		var s = store();
		if (!s || !wasm || typeof wasm.host_speeds_load !== 'function') return 0;
		try {
			var text = s.getItem(KEY);
			return text ? wasm.host_speeds_load(text) : 0;
		} catch (e) { return 0; }
	}

	var api = { figures: figures, parse: parse, attach: attach, save: save, saveSoon: saveSoon, KEY: KEY };
	if (typeof window !== 'undefined') window.DaimondHostSpeed = api;
})();
