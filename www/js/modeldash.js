/* modeldash.js — the private per-model dashboard.
 *
 * "Which model has been costing what, which one fails, which one I trust" --
 * answered from records that already exist on this device, plus the old
 * per-model trust counts, which this file only reads. Nothing here has a
 * network path. There is no fetch, no gateway call, no sync
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
 * THE TRUST COLUMN READS RATED ANSWERS (U5b of 5.3.2). A model's cell is the account-level
 * `cm` cell of the rating roll-up (`DaimondRatingRoll`, www/js/ratingroll.js), which the page
 * builds from the ratings in every chat and hands in through `useRolls`: "9 up, 3 down of 340
 * answers" where the figure is trusted, "not enough yet, 4 more" where it is not, a dash where no
 * answer of the model has been rated. The cell is filed under the model's canonical id, so a row
 * the ledger names by a provider's spelling reads the same cell as the rating did
 * (`DaimondPricing.identify`). The old one-tap counts (`daimond-model-ratings`) are not read
 * here at all: the page imports them once into the Optimiser's digest and removes the key
 * (`importModelCounts`, daimond.js), so this table shows only figures from rated answers.
 *
 * TWO HALVES, the pattern `dockdrag.js` and `models.js` use: everything
 * above the `typeof document === 'undefined'` guard is PURE -- ledger joins
 * and localStorage reads/writes, no DOM -- and is what `modeldash.test.mjs`
 * proves against fixture ledger entries with no browser. Below the guard is
 * the panel: a table like Spending's and a week/month toggle.
 */
(function () {
	'use strict';

	// ── The Trust cell, from the rating cells ───────────────────

	function rolls() { return (typeof window !== 'undefined') ? window.DaimondRatingRoll : null; }

	// The id a rating cell is filed under: the catalogue's name for the model, which is what a
	// product's stamp carries. The model's own string stands where the catalogue is not loaded.
	function cmOf(model) {
		var P = (typeof window !== 'undefined') ? window.DaimondPricing : null;
		if (P && typeof P.identify === 'function') {
			try { return String(P.identify(model).cm || ''); } catch (e) { /* the string stands */ }
		}
		return String(model || '');
	}

	/// What the Trust column says of a model, from the account's rating cells (`roll`, as
	/// `DaimondRatingRoll.cells` makes it): `{ kind: 'none' }` where no answer of it has been
	/// rated, `{ kind: 'trusted', up, down, made }` where the figure can be believed, and
	/// `{ kind: 'thin', more }` with how many further ratings would make it so.
	function trustFor(roll, model) {
		var RR = rolls();
		var c = (roll && RR) ? RR.cell(roll, 3, '', 'cm', cmOf(model)) : null;
		if (!c || !c.n) return { kind: 'none' };
		if (c.ok) return { kind: 'trusted', up: c.pos, down: c.neg, made: c.made };
		return { kind: 'thin', more: c.more };
	}

	// ── The dashboard rows ───────────────────────────────────────
	//
	// Joins `DaimondLedger.perModel(period)` -- tokens, cost, turns, the
	// prompt/completion split -- with the Trust cell of `roll`. Nothing
	// here re-walks the raw ledger: that aggregation belongs to `ledger.js`
	// and stays owned there, so there is exactly one place a ledger entry is
	// summed per model.
	//
	// `ledgerApi` defaults to `window.DaimondLedger` and exists so a test can
	// hand in the real module (loaded against a fixture-seeded localStorage)
	// without this file reaching for a global the test did not set up.
	//
	// Returns `[{ model, tokens, promptTokens, completionTokens, usd, turns,
	// reportedUsd, trust, medianTurnMs, turnsCompleted, turnsFailed,
	// turnsStopped, outcomeTurns, failureRate }]` in `perModel`'s own order
	// (dearest first). The outcome fields (D-20260921-01) are `null`/`0` for
	// a model whose turns predate turn-time tracking, or that has none in
	// the window -- `outcomeTurns === 0` is the panel's own signal to show
	// "not recorded" rather than a rate it did not earn.
	function dashboardRows(period, ledgerApi, roll) {
		var L = ledgerApi || (typeof window !== 'undefined' ? window.DaimondLedger : null);
		var rows = [];
		if (L && typeof L.perModel === 'function') {
			try { rows = L.perModel(period) || []; } catch (e) { rows = []; }
		}
		return rows.map(function (r) {
			return {
				model:            r.model,
				tokens:           r.tokens || 0,
				promptTokens:     r.prompt || 0,
				completionTokens: r.completion || 0,
				usd:              r.usd || 0,
				turns:            r.turns || 0,
				reportedUsd:      r.reportedUsd || 0,
				trust:            trustFor(roll, r.model),
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
		trustFor:      trustFor,
		dashboardRows: dashboardRows,
		gapFields:     gapFields,
	};
	if (typeof document === 'undefined') { window.DaimondModelDash = PURE; return; }

	// ── The DOM half: the Model stats panel ─────────────────────

	var period = 'month';	// 'week' | 'month'
	var wiredActions = false;
	var rollSource = null;	// the page's reader of the account's rating cells, or null
	var roll = null;		// what it last gave, drawn in the Trust column
	var steerSource = null;	// the page's drawer of the Steering list, or null

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	// The cost cell is the price tag: estimated unless the providers billed all of it.
	function costCell(r) {
		var td = el('td', 'num');
		var all = r.usd > 0 && (r.reportedUsd || 0) >= r.usd - 1e-12;
		td.appendChild(DaimondI18n.priceTag(r.usd || 0, { mode: 'fine', estimated: !all }));
		return td;
	}

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

	// The Trust cell's words. A model with no rated answer reads as a dash, as an
	// unrecorded median does, and so does every model until the cells have been read.
	function trustText(tr) {
		if (tr.kind === 'trusted') return t('modeldash.trust_counts', { up: tr.up, down: tr.down, made: tr.made });
		if (tr.kind === 'thin') return t('modeldash.trust_more', { n: tr.more });
		return '—';
	}

	function table() {
		var rows = dashboardRows(period, undefined, roll);
		if (!rows.length) return el('div', 'mdash-empty', t('modeldash.no_usage'));

		var def = defaultModel();
		var tbl = el('table', 'mdash-table');
		var thead = el('tr');
		[t('modeldash.col_model'), t('modeldash.col_turns'), t('modeldash.col_tok_in'),
			t('modeldash.col_tok_out'), t('modeldash.col_cost'), t('modeldash.col_median'),
			t('modeldash.col_fail_rate'), t('modeldash.col_rating')]
			.forEach(function (h, i) {
				thead.appendChild(el('th', i > 0 ? 'num' : null, h));
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
			tr.appendChild(costCell(r));
			// D-20260921-01 -- real figures now the ledger carries a duration and
			// an outcome per turn; `outcomeTurns === 0` (nothing in this window
			// recorded either) is the one case still shown as "—", not "0%".
			var medianTd = el('td', 'num', fmtMs(r.medianTurnMs));
			medianTd.title = t('modeldash.col_median_help');
			tr.appendChild(medianTd);
			var failTd = el('td', 'num', r.outcomeTurns > 0 ? fmtRate(r.failureRate) : '—');
			failTd.title = t('modeldash.col_fail_rate_help', { failed: r.turnsFailed, stopped: r.turnsStopped });
			tr.appendChild(failTd);
			var rateTd = el('td', 'num', trustText(r.trust));
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

		// The notes the models are told, with Remove: the Steering list (Rating U7c), drawn by the page.
		if (steerSource) {
			var ss = el('section', 'mdash-sec');
			ss.appendChild(sectionHead(t('steer.title')));
			var body = el('div', 'mdash-steer');
			ss.appendChild(body);
			host.appendChild(ss);
			try { steerSource(body); } catch (e) { /* the table stands without it */ }
		}
	}

	function wireActions() {
		if (wiredActions) return;
		var panel = document.getElementById('panel-modeldash');
		if (panel) {
			// Redraws the same table when nothing moved, so a press says it ran.
			DaimondAnswer.control(panel.querySelector('[data-act="modeldash-refresh"]'), { act: function () {
				render();
				DaimondAnswer.note(document.getElementById('modeldash-view'), t('files.refreshed'), false, 3000);
			} });
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

	/// The page hands in how to read the account's rating cells: a function that answers a
	/// promise of `{ roll }`. Called each time the panel opens, so the Trust column is as
	/// current as the transcripts; nothing is stored here.
	function useRolls(fn) { rollSource = (typeof fn === 'function') ? fn : null; }

	/// The page hands in how to draw the Steering list: a function that fills the element it is given.
	function useSteering(fn) { steerSource = (typeof fn === 'function') ? fn : null; }

	function readRoll() {
		if (!rollSource) return;
		var p;
		try { p = rollSource(); } catch (e) { return; }
		if (!p || typeof p.then !== 'function') return;
		p.then(function (res) {
			roll = (res && res.roll) || null;
			if (document.getElementById('modeldash-view')) render();
		}, function () { /* the Trust cells stay as they were */ });
	}

	/// Called when the panel is revealed. The table is drawn at once from the ledger, and
	/// the Trust cells follow when the rating cells have been read.
	function onOpen() {
		wireActions();
		render();
		readRoll();
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
		trustFor:      trustFor,
		dashboardRows: dashboardRows,
		gapFields:     gapFields,
		// DOM surface.
		useRolls: useRolls,
		useSteering: useSteering,
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
