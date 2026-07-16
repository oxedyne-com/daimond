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
	function fmtUsd(v) {
		v = v || 0;
		if (v > 0 && v < 0.0995) return '$' + v.toFixed(4);
		if (v > 0 && v < 0.995)  return '$' + v.toFixed(3);
		return '$' + v.toFixed(2);
	}

	// Credits are gateway minor units; reuse the gateway's own formatter.
	function fmtCredits(minor) {
		var g = window.DaimondGateway;
		var cur = (g && g.state && g.state().currency) || 'usd';
		return (g && g.fmtMoney) ? g.fmtMoney(minor, cur) : ('$' + ((minor || 0) / 100).toFixed(2));
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

	// A friendly label for a credit category / kind.
	var CAT_LABEL = {
		web:    'Web pages',
		mail:   'Mail',
		sync:   'Cross-device sync',
		other:  'Other services',
		topup:  'Credits bought',
		refund: 'Refunds',
		grant:  'Gifts & grants',
		adjust: 'Adjustments',
	};
	function catLabel(c) { return CAT_LABEL[c] || c || 'Other'; }

	// ── The SVG bar chart ──────────────────────────────────────
	// Bars are laid out in a 0..100 × 0..100 viewBox and stretched to the
	// container, so the CSS owns the size and the SVG owns only the shape.
	// Colour comes from `currentColor` and a muted track, so it themes for free.

	function barChart(bars, opts) {
		opts = opts || {};
		var W = 100, H = 100, n = bars.length;
		var wrap = el('div', 'spend-chart');
		if (!n) { wrap.appendChild(el('div', 'spend-empty', opts.empty || 'Nothing yet.')); return wrap; }

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
				var t = document.createElementNS(svg.namespaceURI, 'title');
				t.textContent = (bars[k].label ? bars[k].label + ': ' : '') + (opts.fmt ? opts.fmt(v) : v);
				r.appendChild(t);
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
		if (total <= 0) { wrap.appendChild(el('div', 'spend-empty', 'Nothing spent here yet.')); return wrap; }
		for (i = 0; i < rows.length; i++) {
			var v = Math.abs(rows[i].value || 0);
			if (v <= 0) continue;
			var row = el('div', 'spend-bd-row');
			row.appendChild(el('span', 'spend-bd-label', rows[i].label));
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

	// ── Inference section (from DaimondLedger) ─────────────────

	function inferenceSection() {
		var sec = el('section', 'spend-sec');
		sec.appendChild(sectionHead('Inference', 'billed to your own provider key'));

		var L = window.DaimondLedger;
		if (!L) { sec.appendChild(el('div', 'spend-empty', 'No usage recorded.')); return sec; }

		var totals = {};
		try { totals = L.totals() || {}; } catch (e) { totals = {}; }
		var win = totals[period] || { usd: 0, tokens: 0 };

		// The headline: this period's spend, plus session for immediacy.
		var head = el('div', 'spend-totals');
		head.appendChild(bigStat(
			(win.estimated ? '≈ ' : '') + fmtUsd(win.usd),
			period === 'week' ? 'this week' : 'this month'));
		if (totals.session) {
			head.appendChild(bigStat(
				(totals.session.estimated ? '≈ ' : '') + fmtUsd(totals.session.usd), 'this session'));
		}
		head.appendChild(bigStat(fmtTokens(win.tokens) + ' tok', period === 'week' ? 'this week' : 'this month'));
		sec.appendChild(head);

		// The period toggle.
		var toggle = el('div', 'spend-toggle');
		[['week', 'Week'], ['month', 'Month']].forEach(function (p) {
			var b = el('button', 'spend-toggle-btn' + (period === p[0] ? ' on' : ''), p[1]);
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
		sec.appendChild(barChart(bars, { fmt: fmtUsd, empty: 'No turns in this window yet.' }));

		// The by-model table.
		var byModel = [];
		try { byModel = L.perModel(period) || []; } catch (e) { byModel = []; }
		if (byModel.length) {
			var tbl = el('table', 'spend-table');
			var thead = el('tr');
			['Model', 'Turns', 'Tokens', 'Cost'].forEach(function (h, i) {
				var th = el('th', i > 0 ? 'num' : null, h); thead.appendChild(th);
			});
			var thd = el('thead'); thd.appendChild(thead); tbl.appendChild(thd);
			var tb = el('tbody');
			byModel.forEach(function (m) {
				var tr = el('tr');
				tr.appendChild(el('td', 'spend-model', m.model || '(unknown)'));
				tr.appendChild(el('td', 'num', String(m.turns)));
				tr.appendChild(el('td', 'num', fmtTokens(m.tokens)));
				tr.appendChild(el('td', 'num', fmtUsd(m.usd)));
				tb.appendChild(tr);
			});
			tbl.appendChild(tb);
			sec.appendChild(tbl);
		}
		return sec;
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
		sec.appendChild(sectionHead('Credits', 'gateway services — web, mail, sync'));

		var g = window.DaimondGateway;
		var st = (g && g.state) ? g.state() : { authed: false };

		if (!st.authed) {
			var note = el('div', 'spend-note');
			note.textContent = 'No gateway account yet. Credits pay for the few things that leave the '
				+ 'browser — fetching a web page, syncing or sending mail, cross-device sync. Add a '
				+ 'passphrase and credits to begin.';
			sec.appendChild(note);
			return sec;
		}

		// Balance headline.
		var head = el('div', 'spend-totals');
		head.appendChild(bigStat(fmtCredits(st.credits || 0), 'balance'));
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
		sec.appendChild(el('div', 'spend-sub', 'Where credits went'));
		sec.appendChild(breakdown(catRows, fmtCredits));

		// The movements table: the ledger itself, plainly.
		if (movements) {
			var tbl = el('table', 'spend-table');
			var thead = el('tr');
			['When', 'What', 'Amount', 'Balance'].forEach(function (h, i) {
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
			sec.appendChild(el('div', 'spend-empty', 'No credit movements yet.'));
		}
		return sec;
	}

	// ── Render ─────────────────────────────────────────────────

	function render() {
		var host = document.getElementById('spend-view');
		if (!host) return;
		host.innerHTML = '';
		// Frame the two pots before the numbers, so nobody reads them as one sum.
		host.appendChild(el('div', 'spend-intro',
			'Two pots, kept apart: inference runs on your own provider key, and '
			+ 'credits pay the gateway for the few things that leave the browser.'));
		host.appendChild(inferenceSection());
		host.appendChild(el('div', 'spend-divider'));
		host.appendChild(creditsSection());
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
			row.title = 'See where your spending goes';
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

	// Wire the header meter at load, so it opens the view the first time it is
	// clicked, before the panel has ever been shown.
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wireActions);
	} else {
		wireActions();
	}
})();
