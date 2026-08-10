/* spend.js — the Spending view: where the money goes.
 *
 * Daimond spends from two separate pots, and this shows both without pretending
 * they are one:
 *
 *   Inference — the model calls themselves, billed to the user's OWN provider
 *     key. The browser talks to the provider directly, so the gateway never
 *     sees this; the cost is priced and logged per turn in `DaimondLedger`
 *     (localStorage), and read back here. This is almost always the largest
 *     line, so it comes first.
 *
 *   Credits — a prepaid balance held on the gateway, spent only on the few
 *     things that must leave the browser: fetching a web page, syncing or
 *     sending mail, and (soon) cross-device sync. Read from `/api/ledger`,
 *     already tagged with a category so the breakdown never parses a string.
 *
 * The two are different currencies and different accounts, so they are shown as
 * two tracks, never summed. Everything is drawn in plain SVG and DOM — no chart
 * library, no dependency.
 *
 * Exposes `window.DaimondSpend = { onOpen, refresh, show }`. `daimond.js` calls
 * `onOpen()` when the Spending panel is revealed; the header spend meter's click
 * calls `DaimondPanels.show('spend')`, which routes through it.
 */
(function () {
	'use strict';

	var period = 'month';			// inference window: 'week' | 'month'
	var creditEntries = [];			// last read of /api/ledger
	var wiredActions = false;

	// ── Small DOM + format helpers ─────────────────────────────

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	// Inference costs are provider USD, often sub-cent, so show enough figures
	// to be honest about a small number without a wall of zeros on a large one.
	// The `fine` cascade in i18n.js is this rule; the display currency rides
	// along with it.
	function fmtUsd(v) {
		return DaimondI18n.money(v, 'fine');
	}

	// Credits are gateway minor units; reuse the gateway's own formatter.
	function fmtCredits(minor) {
		var g = window.DaimondGateway;
		var cur = (g && g.state && g.state().currency) || 'usd';
		return DaimondI18n.moneyMinor(minor, cur);
	}

	function fmtTokens(n) {
		n = n || 0;
		if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
		if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
		return String(n);
	}

	// A short, local, human day/time for a ledger row.
	function fmtWhen(tsMs) {
		try {
			var d = new Date(tsMs);
			return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
				+ ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
		} catch (e) { return ''; }
	}

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }

	// Every category a movement can carry. The gateway is the authority on this
	// list: the first seven are `SPEND_CATEGORIES` in gateway/src/schema.rs, the
	// rest are the credit-side kinds `LedgerEntry::category` names from the kind
	// alone.
	//
	// This is a copy, and a copy is what went wrong: `infer` became a category on
	// 2026-07-17 and `storage` on 2026-07-21, this list was told about neither,
	// and for three weeks a user's own breakdown read "infer" and "storage" at
	// them in eight languages. dev/verify_spendcats.mjs reads the Rust and fails
	// when this list cannot name something the gateway can produce, so the next
	// category is a red check rather than three more weeks.
	var CATS = [
		'web', 'search', 'mail', 'sync', 'storage', 'infer', 'other',	// metered spends
		'topup', 'refund', 'grant', 'adjust',							// credit-side movements
	];

	// Categories already reported, so the console carries one line per unknown
	// name rather than one per row per redraw.
	var unnamed = {};

	// A friendly label for a credit category / kind.
	//
	// A category this build cannot name is money that left the balance with
	// nothing to say for it, and the row says exactly that. Printing the
	// gateway's own token instead is what let the last drift ship: "infer" looks
	// like a label to nobody and like a bug to no one either, so nothing was
	// reported and nothing was fixed. The token goes to the console, once, which
	// is where a diagnostic belongs -- not beside somebody's money.
	function catLabel(c) {
		if (CATS.indexOf(c) !== -1) return t('spend.cat_' + c);
		if (!c) return t('spend.cat_fallback');		// an entry that named nothing
		if (!unnamed[c]) {
			unnamed[c] = 1;
			console.warn('spend: the gateway named a category this build cannot label: "' + c + '"');
		}
		return t('spend.cat_unlisted');
	}

	// ── The SVG bar chart ──────────────────────────────────────
	// Bars are laid out in a 0..100 × 0..100 viewBox and stretched to the
	// container, so the CSS owns the size and the SVG owns only the shape.
	// Colour comes from `currentColor` and a muted track, so it themes for free.

	function barChart(bars, opts) {
		opts = opts || {};
		var W = 100, H = 100, n = bars.length;
		var wrap = el('div', 'spend-chart');
		if (!n) { wrap.appendChild(el('div', 'spend-empty', opts.empty || t('spend.nothing_yet'))); return wrap; }

		var max = 0;
		for (var i = 0; i < n; i++) max = Math.max(max, bars[i].value || 0);
		if (max <= 0) max = 1;

		var gap = n > 40 ? 0.15 : (n > 14 ? 0.35 : 0.9);
		var slot = W / n;
		var bw = Math.max(0.5, slot - gap);

		var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.setAttribute('class', 'spend-bars');

		for (var k = 0; k < n; k++) {
			var v = bars[k].value || 0;
			var h = (v / max) * (H - 2);
			var x = k * slot + (slot - bw) / 2;
			// A faint full-height track so empty days read as "zero", not "missing".
			var track = document.createElementNS(svg.namespaceURI, 'rect');
			track.setAttribute('x', x.toFixed(2));
			track.setAttribute('y', '0');
			track.setAttribute('width', bw.toFixed(2));
			track.setAttribute('height', String(H));
			track.setAttribute('class', 'spend-bar-track');
			svg.appendChild(track);
			if (h > 0) {
				var r = document.createElementNS(svg.namespaceURI, 'rect');
				r.setAttribute('x', x.toFixed(2));
				r.setAttribute('y', (H - h).toFixed(2));
				r.setAttribute('width', bw.toFixed(2));
				r.setAttribute('height', h.toFixed(2));
				r.setAttribute('class', 'spend-bar');
				var tip = document.createElementNS(svg.namespaceURI, 'title');
				tip.textContent = (bars[k].label ? bars[k].label + ': ' : '') + (opts.fmt ? opts.fmt(v) : v);
				r.appendChild(tip);
				svg.appendChild(r);
			}
		}
		wrap.appendChild(svg);

		// A sparse axis: first and last labels only, so a 30-bar chart is not a
		// smear of dates.
		if (opts.axis !== false && n > 1) {
			var axis = el('div', 'spend-axis');
			axis.appendChild(el('span', null, bars[0].label || ''));
			axis.appendChild(el('span', null, bars[n - 1].label || ''));
			wrap.appendChild(axis);
		}
		return wrap;
	}

	// A horizontal category breakdown: label, proportional fill, and amount.
	function breakdown(rows, fmt) {
		var wrap = el('div', 'spend-breakdown');
		var total = 0, i;
		for (i = 0; i < rows.length; i++) total += Math.abs(rows[i].value || 0);
		if (total <= 0) { wrap.appendChild(el('div', 'spend-empty', t('spend.nothing_spent'))); return wrap; }
		for (i = 0; i < rows.length; i++) {
			var v = Math.abs(rows[i].value || 0);
			if (v <= 0) continue;
			var row = el('div', 'spend-bd-row');
			// The label column is one line and ellipses anything longer, and the
			// dock is narrow: "Inference on credits" arrives as "Inference on…".
			// The full text rides along as a tooltip so the row can still be read.
			var lbl = el('span', 'spend-bd-label', rows[i].label);
			lbl.title = rows[i].label;
			row.appendChild(lbl);
			var barWrap = el('span', 'spend-bd-bar');
			var fill = el('span', 'spend-bd-fill');
			fill.style.width = Math.max(2, (v / total) * 100).toFixed(1) + '%';
			barWrap.appendChild(fill);
			row.appendChild(barWrap);
			row.appendChild(el('span', 'spend-bd-amt', fmt(v)));
			wrap.appendChild(row);
		}
		return wrap;
	}

	function sectionHead(title, hint) {
		var h = el('div', 'spend-sec-head');
		h.appendChild(el('h3', 'spend-sec-title', title));
		if (hint) h.appendChild(el('span', 'spend-sec-hint', hint));
		return h;
	}

	// Whether a rolled-up total is entirely what the providers reported. Old
	// entries carry no `r` and so are priced, not reported -- which is what they
	// were, and the honest answer for them is still "≈".
	function allReported(tot) {
		if (!tot || !(tot.usd > 0)) return false;
		var rep = tot.reportedUsd || 0;
		return rep >= tot.usd - 1e-12;
	}

	// The "≈" that precedes a figure, or nothing when the figure is a bill. A
	// converted figure already carries its own ≈ from i18n, so this adds none.
	function mark(tot) {
		if (allReported(tot)) return '';
		if (window.DaimondI18n && DaimondI18n.converted()) return '';
		return '≈ ';
	}

	// One line under the headline saying what the figure IS.
	function provenance(tot) {
		if (!tot || !(tot.usd > 0)) return '';
		if (allReported(tot)) return t('spend.all_reported');
		if ((tot.reportedUsd || 0) > 0) {
			return t('spend.part_reported', { amount: fmtUsd(tot.reportedUsd) });
		}
		return tot.estimated ? t('spend.none_reported_unknown') : t('spend.none_reported');
	}

	// A second line, when the figures above have MOVED since the user last read
	// them. Estimates made under the old rate table -- the one that ran about six
	// times high -- were re-priced once on this device, which cut every total
	// containing one. Dropping a number by that much without a word is how a
	// meter loses its reader, so the period says what it used to read.
	//
	// `tot` is the period's total as it stands. What it read before is that
	// total with the touched turns put back at their original guess. Nothing is
	// said when the period holds no repriced turn, nor when the two figures
	// round to the same thing: an explanation of a change nobody can see is
	// noise, and this way the line ages out as the 90-day log retires the old
	// entries.
	function repriceNote(tot) {
		var L = window.DaimondLedger;
		if (!L || typeof L.repriced !== 'function' || !tot) return '';
		var rp;
		try { rp = L.repriced(period); } catch (e) { return ''; }
		if (!rp || !rp.turns) return '';
		var before = (tot.usd || 0) - (rp.usd || 0) + (rp.was || 0);
		var was = fmtUsd(before);
		if (was === fmtUsd(tot.usd || 0)) return '';
		// The old figure was a guess, and says so -- unless the currency
		// conversion has already hung a ≈ on it.
		var approx = (window.DaimondI18n && DaimondI18n.converted()) ? '' : '≈ ';
		return t('spend.repriced', { amount: approx + was });
	}

	// ── Inference section (from DaimondLedger) ─────────────────

	function inferenceSection() {
		var sec = el('section', 'spend-sec');
		sec.appendChild(sectionHead(t('spend.inference'), t('spend.inference_hint')));

		var L = window.DaimondLedger;
		if (!L) { sec.appendChild(el('div', 'spend-empty', t('spend.no_usage'))); return sec; }

		var totals = {};
		try { totals = L.totals() || {}; } catch (e) { totals = {}; }
		var win = totals[period] || { usd: 0, tokens: 0 };

		// The headline: this period's spend, plus session for immediacy.
		var head = el('div', 'spend-totals');
		var periodLbl = period === 'week' ? t('spend.this_week') : t('spend.this_month');
		// A converted figure already carries its own ≈, so the estimate mark is
		// not added a second time.
		var approx = (window.DaimondI18n && DaimondI18n.converted()) ? '' : '≈ ';
		head.appendChild(bigStat(mark(win) + fmtUsd(win.usd), periodLbl));
		if (totals.session) {
			head.appendChild(bigStat(mark(totals.session) + fmtUsd(totals.session.usd), t('spend.session')));
		}
		head.appendChild(bigStat(fmtTokens(win.tokens) + ' ' + t('spend.tok'), periodLbl));
		sec.appendChild(head);

		// Say where the figure came from, once, under the headline. A total the
		// providers themselves billed is a fact, and dressing it in a "≈" was
		// telling the user it was guesswork when it was the opposite.
		var prov = provenance(win);
		if (prov) sec.appendChild(el('div', 'spend-note', prov));

		// And, while the correction is still in view, why the figure fell.
		var rn = repriceNote(win);
		if (rn) sec.appendChild(el('div', 'spend-note spend-reprice', rn));

		// The period toggle.
		var toggle = el('div', 'spend-toggle');
		['week', 'month'].forEach(function (key) {
			var p = [key];
			var b = el('button', 'spend-toggle-btn' + (period === p[0] ? ' on' : ''), t('spend.period_' + key));
			b.onclick = function () { period = p[0]; render(); };
			toggle.appendChild(b);
		});
		sec.appendChild(toggle);

		// The daily time graph.
		var days = period === 'week' ? 7 : 30;
		var ser = [];
		try { ser = L.series(days) || []; } catch (e) { ser = []; }
		var bars = ser.map(function (d) {
			var dd = new Date(d.ts);
			return { value: d.usd, label: dd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
		});
		sec.appendChild(barChart(bars, { fmt: fmtUsd, empty: t('spend.no_turns') }));

		// The by-model table.
		var byModel = [];
		try { byModel = L.perModel(period) || []; } catch (e) { byModel = []; }
		if (byModel.length) {
			var tbl = el('table', 'spend-table');
			var thead = el('tr');
			[t('spend.col_model'), t('spend.col_turns'), t('spend.col_tokens'), t('spend.col_cost')].forEach(function (h, i) {
				var th = el('th', i > 0 ? 'num' : null, h); thead.appendChild(th);
			});
			var thd = el('thead'); thd.appendChild(thead); tbl.appendChild(thd);
			var tb = el('tbody');
			byModel.forEach(function (m) {
				var tr = el('tr');
				tr.appendChild(el('td', 'spend-model', m.model || t('spend.unknown_model')));
				tr.appendChild(el('td', 'num', String(m.turns)));
				tr.appendChild(el('td', 'num', fmtTokens(m.tokens)));
				tr.appendChild(el('td', 'num', fmtUsd(m.usd)));
				tb.appendChild(tr);
			});
			tbl.appendChild(tb);
			sec.appendChild(tbl);
		}

		// What is left on each key, beside what this period drew from it. The
		// credits row has had this since it existed; a user's own key had spend
		// with nothing to measure it against, which is the half of the question
		// that decides whether they can keep working.
		var keys = providerKeys();
		if (keys.length) {
			sec.appendChild(el('div', 'spend-sub', t('spend.provider_keys')));
			var ktbl = el('table', 'spend-table');
			var khead = el('tr');
			[t('spend.col_key'), t('spend.col_left'), t('spend.col_period_spend')].forEach(function (h, i) {
				khead.appendChild(el('th', i > 0 ? 'num' : null, h));
			});
			var kthd = el('thead'); kthd.appendChild(khead); ktbl.appendChild(kthd);
			var ktb = el('tbody');
			keys.forEach(function (k) {
				var tr = el('tr');
				tr.appendChild(el('td', 'spend-model', k.name));
				var left = el('td', 'num', k.left);
				if (k.leftHint) left.title = k.leftHint;
				tr.appendChild(left);
				tr.appendChild(el('td', 'num', fmtUsd(k.spent)));
				ktb.appendChild(tr);
			});
			ktbl.appendChild(ktb);
			sec.appendChild(ktbl);
		}
		return sec;
	}

	// Each provider key, with what is left on it and what this period drew.
	//
	// A key nobody can say anything about shows an em dash, never a zero: "we do
	// not know" and "you have nothing" are opposite messages and the second one
	// would send a working user hunting for a top-up they do not need.
	function providerKeys() {
		var M = window.DaimondModels, L = window.DaimondLedger;
		if (!M || typeof M.providers !== 'function' || !L
			|| typeof L.perProvider !== 'function') return [];
		var from = Date.now() - (period === 'week' ? 7 : 30) * 24 * 60 * 60 * 1000;
		var spentBy = {};
		try {
			L.perProvider(from).forEach(function (row) { spentBy[row.provider] = row.usd || 0; });
		} catch (e) { spentBy = {}; }
		var out = [];
		try {
			M.providers().forEach(function (p) {
				var spent = spentBy[p.id] || 0;
				// A row with neither a balance nor any spend has nothing to say.
				if (!p.balance && spent <= 0) return;
				out.push({
					name:     p.name,
					left:     p.balance || '—',
					leftHint: p.creditMode === 'manual' ? t('spend.left_manual')
						: p.creditMode === 'auto' ? t('spend.left_auto')
						: p.minted ? '' : t('spend.left_unknown'),
					spent:    spent,
				});
			});
		} catch (e) { return []; }
		out.sort(function (a, b) { return b.spent - a.spent; });
		return out;
	}

	function bigStat(value, label) {
		var s = el('div', 'spend-stat');
		s.appendChild(el('span', 'spend-stat-val', value));
		s.appendChild(el('span', 'spend-stat-lbl', label));
		return s;
	}

	// ── Credits section (from /api/ledger) ─────────────────────

	function creditsSection() {
		var sec = el('section', 'spend-sec');
		sec.appendChild(sectionHead(t('spend.credits'), t('spend.credits_hint')));

		var g = window.DaimondGateway;
		var st = (g && g.state) ? g.state() : { authed: false };

		if (!st.authed) {
			var note = el('div', 'spend-note');
			note.textContent = t('spend.no_account');
			sec.appendChild(note);
			return sec;
		}

		// Balance headline.
		var head = el('div', 'spend-totals');
		head.appendChild(bigStat(fmtCredits(st.credits || 0), t('spend.balance')));
		sec.appendChild(head);

		// Category breakdown of spends only (debits are negative deltas).
		var byCat = {};
		var movements = 0;
		creditEntries.forEach(function (e) {
			var d = e.delta_minor || 0;
			if (d < 0) {
				var c = e.category || 'other';
				byCat[c] = (byCat[c] || 0) + (-d);
			}
			movements++;
		});
		var catRows = Object.keys(byCat)
			.map(function (c) { return { label: catLabel(c), value: byCat[c] }; })
			.sort(function (a, b) { return b.value - a.value; });
		sec.appendChild(el('div', 'spend-sub', t('spend.where_credits_went')));
		sec.appendChild(breakdown(catRows, fmtCredits));

		// The movements table: the ledger itself, plainly.
		if (movements) {
			var tbl = el('table', 'spend-table');
			var thead = el('tr');
			[t('spend.col_when'), t('spend.col_what'), t('spend.col_amount'), t('spend.col_balance')].forEach(function (h, i) {
				thead.appendChild(el('th', i > 1 ? 'num' : null, h));
			});
			var thd = el('thead'); thd.appendChild(thead); tbl.appendChild(thd);
			var tb = el('tbody');
			creditEntries.slice(0, 40).forEach(function (e) {
				var tr = el('tr');
				tr.appendChild(el('td', 'spend-when', fmtWhen(e.ts / 1e6)));	// ts is ns
				tr.appendChild(el('td', null, catLabel(e.category || e.kind)));
				var d = e.delta_minor || 0;
				var amt = el('td', 'num ' + (d < 0 ? 'debit' : 'credit'),
					(d < 0 ? '−' : '+') + fmtCredits(Math.abs(d)));
				tr.appendChild(amt);
				tr.appendChild(el('td', 'num', fmtCredits(e.balance || 0)));
				tb.appendChild(tr);
			});
			tbl.appendChild(tb);
			sec.appendChild(tbl);
		} else {
			sec.appendChild(el('div', 'spend-empty', t('spend.no_movements')));
		}
		return sec;
	}

	// ── Render ─────────────────────────────────────────────────

	function render() {
		var host = document.getElementById('spend-view');
		if (!host) return;
		host.innerHTML = '';
		// Frame the two pots before the numbers, so nobody reads them as one sum.
		host.appendChild(el('div', 'spend-intro', t('spend.intro')));
		host.appendChild(inferenceSection());
		host.appendChild(el('div', 'spend-divider'));
		host.appendChild(creditsSection());
		// A meter is an estimate either way, but a converted one is an estimate
		// twice over, so it says which rates it used.
		if (window.DaimondI18n && DaimondI18n.currency() !== 'USD') {
			host.appendChild(el('div', 'spend-note',
				t('spend.rates_note', { date: DaimondI18n.ratesAsOf() })));
		}
	}

	function wireActions() {
		if (wiredActions) return;
		var panel = document.getElementById('panel-spend');
		if (!panel) return;
		// The refresh button re-pulls and re-draws.
		panel.addEventListener('click', function (ev) {
			var b = ev.target.closest && ev.target.closest('[data-act="spend-refresh"]');
			if (b) { ev.preventDefault(); onOpen(); }
		});
		// The header spend meter is the door to this view. Wire it once, at load,
		// so it opens the panel whenever it is visible -- independently of when
		// the meter's figures are (re)drawn.
		var row = document.getElementById('spend-row');
		if (row) {
			row.setAttribute('role', 'button');
			row.setAttribute('tabindex', '0');
			row.title = t('spend.meter_help');
			row.addEventListener('click', show);
			row.addEventListener('keydown', function (ev) {
				if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); show(); }
			});
		}
		wiredActions = true;
	}

	/// Called when the panel is revealed: pull the freshest numbers, then draw.
	/// The inference side is local and instant; the credit side is a fetch, so
	/// the view renders at once and fills the credit table in when it lands.
	async function onOpen() {
		wireActions();
		render();									// instant, from local data
		var g = window.DaimondGateway;
		if (g && g.state && g.state().authed) {
			try { await g.refreshBalance(); } catch (e) {}
			try { creditEntries = await g.ledger(); } catch (e) { creditEntries = []; }
			render();								// redraw with credit history
		}
	}

	/// Open the Spending panel (used by the header meter's click).
	///
	/// When the panel is already open, `DaimondPanels.show` is a no-op and its
	/// render hook does not fire, so refresh explicitly in that case -- a click
	/// on the meter always leaves a freshly-drawn view.
	function show() {
		var P = window.DaimondPanels;
		var wasOpen = !!(P && P.isOpen && P.isOpen('spend'));
		if (P) P.show('spend'); else onOpen();
		if (wasOpen) onOpen();
	}

	window.DaimondSpend = {
		onOpen:  onOpen,
		refresh: onOpen,
		show:    show,
	};

	// A language or currency change redraws the panel if it is on screen; a
	// closed one is rebuilt from scratch when it next opens.
	if (window.DaimondI18n) {
		DaimondI18n.onChange(function () {
			if (document.getElementById('spend-view')) render();
		});
	}

	// Wire the header meter at load, so it opens the view the first time it is
	// clicked, before the panel has ever been shown.
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wireActions);
	} else {
		wireActions();
	}
})();
