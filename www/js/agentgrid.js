/* ============================================================
   Daimond — the Agents panel's grid, and the rail's credit cylinders
   ------------------------------------------------------------
   D-20261015-10 (approved as mocked, specs/daimond_agents_mock/):
   the panel is split vertically. Above, one small square per agent,
   coloured by state, one row per origin (a Diamond or a chat), the
   origin's own thread first as a small diamond. Below, ONLY the agents
   a person pressed, as detail tiles with a close cross. Nothing goes
   below on its own: an agent waiting on him is amber in the grid and
   stays there until he presses it (rulings §15).

   D-20261015-14: each user-controlled pool of money is one identical
   transparent cylinder at the foot of the rail, beside Today / Week /
   Month. Full height is the balance right after the last top-up; the
   level is the balance now over that.

   Pure: no DOM, no storage. daimond.js draws from what this returns,
   and agentgrid.test.mjs drives it in node.
   ============================================================ */
(function () {
	'use strict';

	/// The grid's colour for one run.
	///
	/// Amber is the only attention colour and it means "you": a run with a
	/// question parked on the Pending panel. Red is a run that failed or was cut
	/// off mid-task; dim grey a run he paused or stopped himself.
	///
	/// # Arguments
	/// * `run` - A Workers run, `{ status }`.
	/// * `waiting` - Whether a question from this run is waiting on him.
	function stateOf(run, waiting) {
		if (waiting) return 'wait';
		switch (run && run.status) {
			case 'running': return 'run';
			case 'queued':  return 'que';
			case 'paused':
			case 'stopped': return 'stop';
			case 'error':
			case 'interrupted':
			case 'blocked':
			case 'capped':
			case 'spend_cap': return 'fail';
			default: return 'done';
		}
	}

	/// Where a run came from, as a row key: its Diamond, else its chat.
	function originKey(run) {
		if (run && run.diamondId) return 'd:' + run.diamondId;
		if (run && run.chatId) return 'c:' + run.chatId;
		return 'x:';
	}

	/// The thread a run came from, for its row's diamonds to open: its Diamond, else the chat
	/// that sent it, else null (nothing to open, so nothing to press).
	function threadOf(run) {
		if (run && run.diamondId) return { kind: 'diamond', id: String(run.diamondId) };
		if (run && run.chatId) return { kind: 'chat', id: String(run.chatId) };
		return null;
	}

	/// The grid: one row per origin, the most recently active first, and within a
	/// row the runs in the order they started.
	///
	/// # Arguments
	/// * `runs` - `Workers.runs`, newest first (dispatch puts a run at the front).
	/// * `waiting` - `{ runId: true }` for every run a question is waiting on.
	///
	/// # Returns
	/// `[{ key, diamondId, chatId, first, orch: { st }, nested: [{ key, at, st, first }], items: [{ id, st, fade, run }] }]`,
	/// where `first` is the newest run of the row (the one that names it) and `fade`
	/// is the opacity of a finished square: the oldest finished is the faintest.
	function rows(runs, waiting, opts) {
		waiting = waiting || {};
		opts = opts || {};
		var now = opts.now || Date.now();
		var out = [], at = {};
		(runs || []).forEach(function (r) {
			var st = stateOf(r, !!waiting[r.id]);
			// THE WORKING SET (think pass, "what it shows by default"): every live run, and
			// every run that ended in the last 24 hours. Older ones leave the grid -- a
			// search still finds them (`keepOld`), and so does the chat's transcript.
			var age = endedAge(r, st, now);
			if (age > DAY_MS && !opts.keepOld) return;
			var k = originKey(r);
			if (!(k in at)) {
				at[k] = out.length;
				out.push({ key: k, diamondId: r.diamondId || '', chatId: r.chatId || '', first: r, items: [] });
			}
			out[at[k]].items.push({ id: String(r.id), st: st, fade: 1, run: r, age: age });
		});
		out.forEach(function (row) {
			row.items.reverse();
			// NESTED ORCHESTRATORS (mock 'o'): each orchestrating turn that sent work -- a chat
			// turn, a gather round one deeper, a Diamond's own fan-out -- is a group under its
			// own small diamond. The first sits under the row's thread diamond; each later one
			// opens with a diamond of its own. Runs from before parents were kept are one group.
			var order = [], groups = {};
			row.items.forEach(function (it) {
				var k = String(it.run.parentId || '');
				if (!(k in groups)) { groups[k] = []; order.push(k); }
				groups[k].push(it);
			});
			row.nested = [];
			if (order.length > 1) {
				row.items = [];
				order.forEach(function (k, gi) {
					var g = groups[k];
					if (gi > 0) row.nested.push({ key: k, at: row.items.length, st: liveOf(g) ? 'run' : 'done', first: g[g.length - 1].run });
					row.items.push.apply(row.items, g);
				});
			}
			// A finished square fades by its age over the day: 0.85 just ended, 0.25 a day on.
			// One saved before end times were kept has no age, and fades by its order instead.
			var legacy = [];
			row.items.forEach(function (it) {
				if (it.st !== 'done') return;
				if (it.age >= 0) it.fade = Math.round((0.85 - Math.min(1, it.age / DAY_MS) * 0.6) * 100) / 100;
				else legacy.push(it);
			});
			legacy.forEach(function (it, i) {
				var o = legacy.length > 1 ? 1 - i / (legacy.length - 1) : 0;
				it.fade = Math.round((0.85 - o * 0.6) * 100) / 100;
			});
			row.items.forEach(function (it) { delete it.age; });
			row.orch = { st: liveOf(row.items) ? 'run' : 'done' };
		});
		return out;
	}

	var DAY_MS = 24 * 3600e3;

	/// Whether any of these grid items is still at work or waiting on him.
	function liveOf(items) {
		return items.some(function (it) { return it.st === 'run' || it.st === 'que' || it.st === 'wait'; });
	}

	/// How long ago a run ended, in ms, or -1 for a run that is live or was never seen ending.
	function endedAge(run, st, now) {
		if (st === 'run' || st === 'que' || st === 'wait' || (run && run.status === 'paused')) return -1;
		var e = Number(run && run.endedAt) || 0;
		return e > 0 ? Math.max(0, now - e) : -1;
	}

	/// A run's `endedAt` after one more look at its status: stamped once when it ends (kept,
	/// not moved, on later looks), and cleared when it lives again -- resumed or requeued.
	function endedAtNext(run, now) {
		var st = run && run.status;
		if (st === 'running' || st === 'queued' || st === 'paused') return 0;
		return Number(run && run.endedAt) || now;
	}

	/// The grid's four questions, in the switch's order (think pass §2). The squares
	/// keep their places under every one; only the colour changes.
	var LENSES = ['state', 'cost', 'rating', 'device'];

	/// A square's colour under a lens, as a CSS colour, or '' to keep its state colour.
	///
	/// * `cost`: one hue, lightness by spend on a log scale -- $0.001 dim, $1 and up
	///   full ink -- so the expensive agents stand out across the fleet (mock costColour).
	/// * `rating`: green for a run rated up, red for one rated down, neutral unrated.
	/// * `device`: one hue per device that ran it, neutral where none was recorded.
	///
	/// # Arguments
	/// * `lens` - One of `LENSES`; anything else is `state`.
	/// * `run` - A Workers run, `{ costUsd, rating, deviceId }`.
	function lensPaint(lens, run) {
		run = run || {};
		if (lens === 'cost') {
			var s = Number(run.costUsd) || 0;
			var t = (Math.log10(Math.max(s, 0.001)) + 3) / 3;
			t = Math.max(0.06, Math.min(1, t));
			var ink = Math.round(8 + Math.pow(t, 1.7) * 92);
			if (s <= 0) ink = 4;
			return 'color-mix(in srgb, var(--text-primary) ' + ink + '%, var(--bg-primary))';
		}
		if (lens === 'rating') {
			var r = Number(run.rating) || 0;
			if (r > 0) return 'var(--success)';
			if (r < 0) return 'var(--danger)';
			return 'var(--agl-neutral)';
		}
		if (lens === 'device') {
			var id = String(run.deviceId || '');
			if (!id) return 'var(--agl-neutral)';
			var h = 0;
			for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
			return 'hsl(' + (h % 360) + ' 55% 58%)';
		}
		return '';
	}

	/// What was spent in the sixty minutes before `now`, in US dollars: the panel's one
	/// fuel figure (think pass §4). Read from the ledger's own entries (`{ t, u }`), so it
	/// is the figure the spend row is built from and the two cannot disagree.
	function lastHourUsd(entries, now) {
		var from = (now || 0) - 3600e3, usd = 0;
		(entries || []).forEach(function (e) {
			if (e && typeof e.t === 'number' && e.t >= from && e.t <= now) usd += Number(e.u) || 0;
		});
		return usd;
	}

	/// What a run's turn has spent against its own cap: `{ spent, cap, f }`, or null for a
	/// run with no recorded cap (one made before caps were kept), which draws no meter.
	///
	/// The cap is per TURN (the engine stops a turn there, `set_spend_cap_usd`), so a resumed
	/// run's earlier legs -- `priorCost` -- are not counted against it. `f` is the share
	/// filled, 0..1: a running square fills bottom-up by it (mock .sq.run --f), and the tile's
	/// meter reads "$spent of $cap".
	function budget(run) {
		run = run || {};
		var cap = Number(run.capUsd) || 0;
		if (cap <= 0) return null;
		var spent = Math.max(0, (Number(run.costUsd) || 0) - (Number(run.priorCost) || 0));
		spent = Math.round(spent * 1e6) / 1e6;
		return { spent: spent, cap: cap, f: Math.min(1, Math.round(spent / cap * 1e4) / 1e4) };
	}

	/// The pinned set after a press on one square: added at the end, or taken out.
	function togglePin(pins, id) {
		id = String(id);
		var p = (pins || []).filter(function (x) { return x !== id; });
		if (p.length === (pins || []).length) p.push(id);
		return p;
	}

	/// The pinned set with the runs that no longer exist taken out. It never ADDS
	/// one: the lower section holds only what a person pressed.
	function prunePins(pins, runs) {
		var have = {};
		(runs || []).forEach(function (r) { have[String(r.id)] = 1; });
		return (pins || []).filter(function (id) { return have[id]; });
	}

	/// The level, 0 to 1: the balance now over the full height.
	function level(usd, peak) {
		if (!(peak > 0) || !(usd > 0)) return 0;
		return Math.min(1, usd / peak);
	}

	// ── The rail's money pools, each an electric car (D-20261020-14) ──
	// One row per pool: a battery for how full it is since its last top-up, a dial for
	// how fast it is going (the 15-min mean), and the range left at that pace.

	/// The battery, as SVG text: an upright cell with a terminal on its lid, filled to
	/// `lvl` (0 to 1) of the pool's balance at its last top-up. `low` tints the charge
	/// amber. Decorative: the row's own title and label say what it shows.
	function batterySvg(lvl, low) {
		var w = 13, h = 32, cap = 3;
		var ry = w * 0.18, rx = w / 2 - 0.5;
		var x0 = 0.5, x1 = w - 0.5, yt = cap + ry + 0.5, yb = h - ry - 0.5;
		var l = Math.max(0, Math.min(1, Number(lvl) || 0)), yl = yb - l * (yb - yt);
		var arc = function (sweep) { return 'A' + rx + ' ' + ry + ' 0 0 ' + sweep + ' '; };
		var body = 'M' + x0 + ' ' + yt + 'L' + x0 + ' ' + yb + arc(0) + x1 + ' ' + yb +
			'L' + x1 + ' ' + yt + arc(1) + x0 + ' ' + yt + 'Z';
		var liq = l > 0
			? '<path class="liq" d="M' + x0 + ' ' + yl.toFixed(2) + 'L' + x0 + ' ' + yb + arc(0) + x1 + ' ' + yb +
				'L' + x1 + ' ' + yl.toFixed(2) + 'Z"/>' +
				'<ellipse class="liqtop" cx="' + w / 2 + '" cy="' + yl.toFixed(2) + '" rx="' + rx + '" ry="' + ry + '"/>'
			: '';
		var cw = w * 0.36, c0 = (w - cw) / 2, cry = ry * 0.4, ct = yt - ry * 0.55;
		var term = '<path class="term" d="M' + c0 + ' ' + ct.toFixed(2) + 'L' + c0 + ' ' + cap + 'A' + cw / 2 + ' ' + cry.toFixed(2) +
			' 0 0 1 ' + (c0 + cw) + ' ' + cap + 'L' + (c0 + cw) + ' ' + ct.toFixed(2) + 'Z"/>';
		return '<svg class="evb' + (low ? ' low' : '') + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
			'" data-level="' + l.toFixed(4) + '" aria-hidden="true"><path class="glass" d="' + body + '"/>' + liq + term +
			'<ellipse class="rim" cx="' + w / 2 + '" cy="' + yt + '" rx="' + rx + '" ry="' + ry + '"/></svg>';
	}

	function polar(cx, cy, r, a) { var t = a * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; }
	function arcPath(cx, cy, r, a0, a1) {
		var s = polar(cx, cy, r, a0), e = polar(cx, cy, r, a1);
		return 'M' + s[0].toFixed(2) + ' ' + s[1].toFixed(2) + 'A' + r + ' ' + r + ' 0 0 1 ' + e[0].toFixed(2) + ' ' + e[1].toFixed(2);
	}

	/// The needle's angle in degrees, 180 (at rest, left) to 360 (full scale, right),
	/// for `rate` against `scale`, both per hour in the pool's currency.
	function needleAngle(rate, scale) {
		if (!(rate > 0) || !(scale > 0)) return 180;
		return 180 + Math.min(1, rate / scale) * 180;
	}

	/// The dial, as SVG text: a half circle in thirds (D-20261022-07), the lower third
	/// uncoloured, the middle orange and the upper red, always shown whatever the pace,
	/// like a rev counter's redline; the needle alone says the pace. The
	/// needle stands at `angle` (`needleAngle`); `rest` greys it, for an idle pool.
	function dialSvg(angle, rest) {
		var w = 44, h = 24, sw = 2.5, cx = w / 2, cy = h - 2.5, r = w / 2 - sw / 2 - 0.5;
		var an = Math.max(180, Math.min(360, Number(angle) || 180)), s = '';
		[[180, 240], [240, 300], [300, 360]].forEach(function (b, i) {
			s += '<path class="band b' + (i + 1) + '" d="' + arcPath(cx, cy, r, b[0], b[1]) + '" stroke-width="' + sw + '"/>';
		});
		for (var i = 0; i <= 4; i++) {
			var ta = 180 + i * 45, ti = polar(cx, cy, r - sw / 2 - 1.5, ta), tt = polar(cx, cy, r - sw / 2 - (i % 2 ? 3.2 : 4.6), ta);
			s += '<line class="tick" x1="' + ti[0].toFixed(2) + '" y1="' + ti[1].toFixed(2) + '" x2="' + tt[0].toFixed(2) + '" y2="' + tt[1].toFixed(2) + '"/>';
		}
		// A tapered needle: wide at the hub, a point at the tip, a short counterweight behind.
		var tip = polar(cx, cy, r - sw / 2 - 2, an), nb = polar(cx, cy, 1.8, an + 90), nc = polar(cx, cy, 1.8, an - 90), bk = polar(cx, cy, 2.6, an + 180);
		s += '<path class="ndl" d="M' + nb[0].toFixed(2) + ' ' + nb[1].toFixed(2) + 'L' + tip[0].toFixed(2) + ' ' + tip[1].toFixed(2) +
			'L' + nc[0].toFixed(2) + ' ' + nc[1].toFixed(2) + 'L' + bk[0].toFixed(2) + ' ' + bk[1].toFixed(2) + 'Z"/>';
		s += '<circle class="hub" cx="' + cx + '" cy="' + cy + '" r="2.2"/>';
		return '<svg class="evd' + (rest ? ' rest' : '') + '" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h +
			'" data-angle="' + an.toFixed(2) + '" aria-hidden="true">' + s + '</svg>';
	}

	/// The range at the present pace in whole units: `{ n, unit }`, unit 'min', 'h' or
	/// 'd', or null for an idle pool. Over 99 days reads as "99+ d".
	function range(minutes) {
		if (!(typeof minutes === 'number' && isFinite(minutes) && minutes >= 0)) return null;
		if (minutes < 60)        return { n: String(Math.max(1, Math.round(minutes))), unit: 'min' };
		if (minutes < 48 * 60)   return { n: String(Math.round(minutes / 60)), unit: 'h' };
		if (minutes < 100 * 1440) return { n: String(Math.round(minutes / 1440)), unit: 'd' };
		return { n: '99+', unit: 'd' };
	}

	/// The rail's pools: one per money pool (`DaimondMoney.pools`), in its own order,
	/// with what the drawing needs. `low` (an amber charge) is under a tenth of a
	/// charge, or a pool that lasts under a day at its 24 h rate, the rule the Status
	/// row's Top Up follows, so a burst never tints a full battery. `short` (an amber
	/// range) is under an hour at the 15-min pace.
	function pools(moneyPools) {
		return (moneyPools || []).filter(function (p) {
			return p && typeof p.amount === 'number' && isFinite(p.amount);
		}).map(function (p) {
			var day = (typeof p.minutesDay === 'number') ? p.minutesDay : null;
			var lv = level(p.amount, p.full);
			var rate = (typeof p.rate15 === 'number' && isFinite(p.rate15)) ? p.rate15 : 0;
			// Idle: nothing spent in the window, or a pace too slow to give a range. An
			// empty pool that is still being spent is not idle: it has no range left.
			var empty = !(p.amount > 0);
			var idle = !(rate > 0) || (!empty && typeof p.minutes !== 'number');
			return { key: p.key, label: p.label, amount: p.amount, currency: p.currency, pool: p,
				level: lv, full: p.full, rate: rate, scale: p.scale, idle: idle,
				today: (typeof p.today === 'number' && isFinite(p.today)) ? p.today : null,
				angle: idle ? 180 : needleAngle(rate, p.scale),
				range: idle ? null : empty ? { n: '0', unit: 'min' } : range(p.minutes),
				low: lv < 0.1 || (day !== null && !empty && day < 1440),
				short: !idle && (empty || p.minutes < 60) };
		});
	}

	var api = {
		pools:       pools,
		batterySvg:  batterySvg,
		dialSvg:     dialSvg,
		needleAngle: needleAngle,
		range:       range,
		stateOf:     stateOf,
		originKey:   originKey,
		rows:        rows,
		LENSES:      LENSES,
		lensPaint:   lensPaint,
		lastHourUsd: lastHourUsd,
		budget:      budget,
		endedAtNext: endedAtNext,
		threadOf:    threadOf,
		togglePin:   togglePin,
		prunePins:   prunePins,
		level:       level,
	};
	if (typeof window !== 'undefined') window.DaimondAgentGrid = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
