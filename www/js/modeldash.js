/* modeldash.js — the private per-model dashboard, and the one-tap trust rating.
 *
 * "Which model has been costing what, which one fails, which one I trust" --
 * answered from records that already exist on this device, plus one new
 * local store this file adds: a one-tap trust rating per model. Nothing
 * here has a network path. There is no fetch, no gateway call, no sync
 * field: this build is the dashboard half of the Leaders design
 * (`daimond_leaderboards_design.md`, "The private dashboard"), not the
 * contribution channel, which does not exist yet.
 *
 * THE CONTRIBUTION PREVIEW. The design's promise is that this screen shows,
 * to the integer, what would be sent if the person later opts into the
 * anonymous model boards -- so there is no separate "what we collect" list
 * to trust, because this dashboard IS that list. The table below draws
 * exactly the fields the design names for a contribution (tokens in/out,
 * cost, turns, ratings) and says plainly, per row, which of the design's
 * other fields (turns failed, turns stopped, a turn-time histogram) this
 * build cannot show, because nothing on the device records them yet -- see
 * the gap note in `gapFields()`. A row that quietly read "0 failed" would be
 * a false claim; a row that says "not recorded" is the true one.
 *
 * THE LEDGER. Every figure but the rating comes from `DaimondLedger`
 * (www/js/ledger.js), which reads/writes localStorage key `daimond-ledger`
 * -- an append-only, ~90-day-pruned log of priced turns. This file adds no
 * field to that store and no second copy of its aggregation: `perModel()`
 * already sums tokens, cost and turns per model per window, and was
 * extended there (not here) to also split prompt vs completion tokens,
 * because a second caller needing that split is exactly the situation
 * "extend the existing machinery" describes.
 *
 * THE RATING STORE. `daimond-model-ratings` in localStorage, `{ model:
 * { up, down } }` -- a tap increments a count, matching the design's
 * contributed shape (`rating up` / `rating down` are counts, not a toggle),
 * so the number on screen is already the number a future contribution would
 * carry. Device-local only; nothing merges or syncs it (yet).
 *
 * TWO HALVES, the pattern `dockdrag.js` and `models.js` use: everything
 * above the `typeof document === 'undefined'` guard is PURE -- ledger joins
 * and localStorage reads/writes, no DOM -- and is what `modeldash.test.mjs`
 * proves against fixture ledger entries with no browser. Below the guard is
 * the panel: a table like Spending's, a week/month toggle, and the two
 * rating buttons.
 */
(function () {
	'use strict';

	var RATINGS_KEY = 'daimond-model-ratings';

	// ── Rating store (localStorage) ─────────────────────────────
	// Shape: `{ "<model>": { up: N, down: N } }`. Corrupt or absent storage
	// degrades to "no ratings", the same rule `ledger.js` uses for its own
	// store, rather than throwing and taking the dashboard with it.
	function loadRatings() {
		try {
			var raw = localStorage.getItem(RATINGS_KEY);
			if (!raw) return {};
			var obj = JSON.parse(raw);
			return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
		} catch (e) { return {}; }
	}

	// Swallows quota/availability errors, as `ledger.js`'s `save` does: a
	// failed write must not break the tap that triggered it.
	function saveRatings(obj) {
		try { localStorage.setItem(RATINGS_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ }
	}

	/// This model's rating counts, `{ up, down }`, zeros when it has never
	/// been rated.
	function ratingsFor(model) {
		var r = loadRatings()[model || ''];
		return { up: (r && r.up) || 0, down: (r && r.down) || 0 };
	}

	/// Record one tap. `dir` is `'up'` or `'down'`; anything else is a no-op
	/// that just returns the model's current counts, so a caller need not
	/// validate before calling. Returns the model's new `{ up, down }`.
	function rate(model, dir) {
		model = model || '';
		if (dir !== 'up' && dir !== 'down') return ratingsFor(model);
		var all = loadRatings();
		var r = all[model] || { up: 0, down: 0 };
		r[dir] = (r[dir] || 0) + 1;
		all[model] = r;
		saveRatings(all);
		return { up: r.up || 0, down: r.down || 0 };
	}

	/// Erase every rating (a user "reset ratings" action, or a test's revert
	/// check).
	function clearRatings() {
		try { localStorage.removeItem(RATINGS_KEY); } catch (e) { /* ignore */ }
	}

	// ── The dashboard rows ───────────────────────────────────────
	//
	// Joins `DaimondLedger.perModel(period)` -- tokens, cost, turns, the
	// prompt/completion split -- with this file's own rating store. Nothing
	// here re-walks the raw ledger: that aggregation belongs to `ledger.js`
	// and stays owned there, so there is exactly one place a ledger entry is
	// summed per model.
	//
	// `ledgerApi` defaults to `window.DaimondLedger` and exists so a test can
	// hand in the real module (loaded against a fixture-seeded localStorage)
	// without this file reaching for a global the test did not set up.
	//
	// Returns `[{ model, tokens, promptTokens, completionTokens, usd, turns,
	// reportedUsd, up, down, medianTurnMs, turnsCompleted, turnsFailed,
	// turnsStopped, outcomeTurns, failureRate }]` in `perModel`'s own order
	// (dearest first). The outcome fields (D-20260921-01) are `null`/`0` for
	// a model whose turns predate turn-time tracking, or that has none in
	// the window -- `outcomeTurns === 0` is the panel's own signal to show
	// "not recorded" rather than a rate it did not earn.
	function dashboardRows(period, ledgerApi) {
		var L = ledgerApi || (typeof window !== 'undefined' ? window.DaimondLedger : null);
		var rows = [];
		if (L && typeof L.perModel === 'function') {
			try { rows = L.perModel(period) || []; } catch (e) { rows = []; }
		}
		var ratings = loadRatings();
		return rows.map(function (r) {
			var rt = ratings[r.model] || { up: 0, down: 0 };
			return {
				model:            r.model,
				tokens:           r.tokens || 0,
				promptTokens:     r.prompt || 0,
				completionTokens: r.completion || 0,
				usd:              r.usd || 0,
				turns:            r.turns || 0,
				reportedUsd:      r.reportedUsd || 0,
				up:               rt.up || 0,
				down:             rt.down || 0,
				medianTurnMs:     (typeof r.medianTurnMs === 'number') ? r.medianTurnMs : null,
				turnsCompleted:   r.turnsCompleted || 0,
				turnsFailed:      r.turnsFailed || 0,
				turnsStopped:     r.turnsStopped || 0,
				outcomeTurns:     r.outcomeTurns || 0,
				failureRate:      (typeof r.failureRate === 'number') ? r.failureRate : null,
			};
		});
	}

	/// The design's per-contribution fields this build genuinely has no
	/// record of, named once so the panel can say so honestly instead of
	/// drawing a zero it did not earn.
	///
	/// D-20260921-01 added a duration and an outcome tag to the ledger, so
	/// median turn time and the failed/stopped rate are real figures now
	/// (`medianTurnMs`/`failureRate` above) and have left this list. What
	/// remains is the turn-time SPREAD the design's histogram wants -- fixed
	/// duration buckets, not just the middle value -- which still needs
	/// storage this build does not add.
	function gapFields() {
		return ['turnSecondsHistogram'];
	}

	var PURE = {
		RATINGS_KEY:   RATINGS_KEY,
		loadRatings:   loadRatings,
		saveRatings:   saveRatings,
		ratingsFor:    ratingsFor,
		rate:          rate,
		clearRatings:  clearRatings,
		dashboardRows: dashboardRows,
		gapFields:     gapFields,
	};
	if (typeof document === 'undefined') { window.DaimondModelDash = PURE; return; }

	// ── The DOM half: the Model stats panel ─────────────────────

	var period = 'month';	// 'week' | 'month'
	var wiredActions = false;

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	function fmtUsd(v) { return window.DaimondI18n ? DaimondI18n.money(v, 'fine') : ('$' + (v || 0).toFixed(4)); }

	function fmtTokens(n) {
		n = n || 0;
		if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
		if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
		return String(n);
	}

	// Median turn time, ms -> a short reading: seconds to one decimal past a
	// second, whole milliseconds under it. `null` (no turn in the window
	// carries a duration) reads as an em dash, not a zero it did not earn.
	function fmtMs(ms) {
		if (typeof ms !== 'number') return '—';
		if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
		return Math.round(ms) + 'ms';
	}

	// Failed-or-stopped share of the turns this build has an outcome for,
	// `null` (none recorded) reading the same em dash `fmtMs` does.
	function fmtRate(rate) {
		if (typeof rate !== 'number') return '—';
		return Math.round(rate * 100) + '%';
	}

	function sectionHead(title, hint) {
		var h = el('div', 'mdash-sec-head');
		h.appendChild(el('h3', 'mdash-sec-title', title));
		if (hint) h.appendChild(el('span', 'mdash-sec-hint', hint));
		return h;
	}

	// The default model, or '' when nothing has said. Read fresh each draw --
	// changing the default in the Models settings must show up here without
	// a reload.
	function defaultModel() {
		var M = window.DaimondModels;
		if (!M || typeof M.getDefault !== 'function') return '';
		try { return (M.getDefault() || {}).model || ''; } catch (e) { return ''; }
	}

	// One row's rating control: a tap up, a tap down, each showing its own
	// running count. Tapping redraws just this row's counts in place rather
	// than the whole table, so a second tap is not spent finding the row
	// again.
	function rateCell(model) {
		var wrap = el('span', 'mdash-rate');
		var counts = ratingsFor(model);

		function btn(dir, glyph, cls) {
			var b = el('button', 'mdash-rate-btn ' + cls + (counts[dir] > 0 ? ' mdash-has' : ''),
				glyph + ' ' + counts[dir]);
			b.type = 'button';
			b.title = dir === 'up' ? t('modeldash.rate_up_help') : t('modeldash.rate_down_help');
			b.addEventListener('click', function () {
				counts = rate(model, dir);
				wrap.innerHTML = '';
				wrap.appendChild(btn('up', '▲', 'mdash-rate-up'));
				wrap.appendChild(btn('down', '▼', 'mdash-rate-down'));
			});
			return b;
		}
		wrap.appendChild(btn('up', '▲', 'mdash-rate-up'));
		wrap.appendChild(btn('down', '▼', 'mdash-rate-down'));
		return wrap;
	}

	function table() {
		var rows = dashboardRows(period);
		if (!rows.length) return el('div', 'mdash-empty', t('modeldash.no_usage'));

		var def = defaultModel();
		var tbl = el('table', 'mdash-table');
		var thead = el('tr');
		[t('modeldash.col_model'), t('modeldash.col_turns'), t('modeldash.col_tok_in'),
			t('modeldash.col_tok_out'), t('modeldash.col_cost'), t('modeldash.col_median'),
			t('modeldash.col_fail_rate'), t('modeldash.col_rating')]
			.forEach(function (h, i) {
				thead.appendChild(el('th', i > 0 && i < 7 ? 'num' : null, h));
			});
		var thd = el('thead'); thd.appendChild(thead); tbl.appendChild(thd);

		var tb = el('tbody');
		rows.forEach(function (r) {
			var tr = el('tr');
			var nameTd = el('td', 'mdash-model', r.model || t('modeldash.unknown_model'));
			if (r.model && r.model === def) {
				var badge = el('span', 'mdash-default-badge', t('modeldash.default_badge'));
				nameTd.appendChild(badge);
			}
			tr.appendChild(nameTd);
			tr.appendChild(el('td', 'num', String(r.turns)));
			tr.appendChild(el('td', 'num', fmtTokens(r.promptTokens)));
			tr.appendChild(el('td', 'num', fmtTokens(r.completionTokens)));
			tr.appendChild(el('td', 'num', fmtUsd(r.usd)));
			// D-20260921-01 -- real figures now the ledger carries a duration and
			// an outcome per turn; `outcomeTurns === 0` (nothing in this window
			// recorded either) is the one case still shown as "—", not "0%".
			var medianTd = el('td', 'num', fmtMs(r.medianTurnMs));
			medianTd.title = t('modeldash.col_median_help');
			tr.appendChild(medianTd);
			var failTd = el('td', 'num', r.outcomeTurns > 0 ? fmtRate(r.failureRate) : '—');
			failTd.title = t('modeldash.col_fail_rate_help', { failed: r.turnsFailed, stopped: r.turnsStopped });
			tr.appendChild(failTd);
			var rateTd = el('td');
			rateTd.appendChild(rateCell(r.model));
			tr.appendChild(rateTd);
			tb.appendChild(tr);
		});
		tbl.appendChild(tb);
		return tbl;
	}

	function gapNote() {
		return el('div', 'mdash-gap', t('modeldash.gap_note'));
	}

	function render() {
		var host = document.getElementById('modeldash-view');
		if (!host) return;
		host.innerHTML = '';

		var sec = el('section', 'mdash-sec');
		sec.appendChild(sectionHead(t('modeldash.title'), t('modeldash.hint')));
		sec.appendChild(el('div', 'mdash-note', t('modeldash.preview_note')));

		var toggle = el('div', 'mdash-toggle');
		['week', 'month'].forEach(function (key) {
			var b = el('button', 'mdash-toggle-btn' + (period === key ? ' on' : ''), t('modeldash.period_' + key));
			b.type = 'button';
			b.addEventListener('click', function () { period = key; render(); });
			toggle.appendChild(b);
		});
		sec.appendChild(toggle);

		sec.appendChild(table());
		sec.appendChild(gapNote());
		host.appendChild(sec);
	}

	function wireActions() {
		if (wiredActions) return;
		var panel = document.getElementById('panel-modeldash');
		if (panel) {
			panel.addEventListener('click', function (ev) {
				var b = ev.target.closest && ev.target.closest('[data-act="modeldash-refresh"]');
				if (b) { ev.preventDefault(); render(); }
			});
		}
		wiredActions = true;
	}

	// A turn recorded (or a sync/backup ledger merge) while this panel sits
	// open in the dock, so the table does not go stale until a tap on
	// Refresh (S-UI #2). `ledger.js` raises the one event every write path
	// funnels through; redrawn only if the panel is actually the thing on
	// screen, the same "am I open" test the locale hook above already makes.
	var hooked = false;
	function onLedgerChanged() {
		if (document.getElementById('modeldash-view')) render();
	}

	/// Called when the panel is revealed. Everything here is local and
	/// synchronous -- no fetch, ever -- so the draw is instant.
	function onOpen() {
		wireActions();
		render();
		if (!hooked) { window.addEventListener('daimond:ledger', onLedgerChanged); hooked = true; }
	}

	/// Called when the panel is dismissed -- drops the subscription above so a
	/// closed panel is not still redrawing itself nobody can see.
	function onClose() {
		if (hooked) { window.removeEventListener('daimond:ledger', onLedgerChanged); hooked = false; }
	}

	function show() {
		var P = window.DaimondPanels;
		var wasOpen = !!(P && P.isOpen && P.isOpen('modeldash'));
		if (P) P.show('modeldash'); else onOpen();
		if (wasOpen) onOpen();
	}

	window.DaimondModelDash = {
		// Pure surface (also on `PURE`, kept in sync for the test file).
		RATINGS_KEY:   RATINGS_KEY,
		loadRatings:   loadRatings,
		saveRatings:   saveRatings,
		ratingsFor:    ratingsFor,
		rate:          rate,
		clearRatings:  clearRatings,
		dashboardRows: dashboardRows,
		gapFields:     gapFields,
		// DOM surface.
		onOpen:  onOpen,
		onClose: onClose,
		refresh: onOpen,
		show:    show,
	};

	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () {
			if (document.getElementById('modeldash-view')) render();
		});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wireActions);
	} else {
		wireActions();
	}
})();
