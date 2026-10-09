/* ============================================================
   Daimond — the Workspace panel's focus section (DaimondRecent)
   ------------------------------------------------------------
   Workspace round 2, P2 + E4 (specs/daimond_workspace_firstprinciples
   _20261009.md §3.2, §5 E4, §6 N1). Two lists under the diamond (or
   chat) in focus:

   RECENT is a ring of the last 20 files its daimon, a worker it sent,
   or the chat wrote, newest first, one row per path and place. A
   diamond's ring is the file `diamonds/<id>/recent.json`: its own
   folder, so it travels with the diamond and is fenced already, and
   NOT under `.daimond/` or `versions/`, whose keeper record never
   travels. It is a record and never a grant: `Files.bounds` does not
   read it.

   CAN CHANGE is drawn from the fence's own inputs (`Files.bounds`), so
   a row and the fence cannot disagree (N1).

   Attaches `window.DaimondRecent`, and exports the same for Node.
   ============================================================ */
(function () {
	'use strict';

	var CAP = 20;

	// Write tools and the argument naming the file they leave behind.
	var WRITES = {
		file_write:	'path',
		file_edit:	'path',
		file_move:	'to',
	};

	function str(v) { return typeof v === 'string' ? v : ''; }

	function clean(p) {
		var s = str(p).trim();
		while (s.indexOf('./') === 0) s = s.slice(2);
		return s;
	}

	/// The file a tool call wrote, or '' for anything that is not a write.
	function pathOf(tool, args) {
		var arg = WRITES[str(tool)];
		if (!arg) return '';
		var o = args;
		if (typeof o === 'string') {
			try { o = JSON.parse(o); } catch (e) { return ''; }
		}
		if (!o || typeof o !== 'object') return '';
		return clean(o[arg]);
	}

	function keyOf(e) { return e.place + '\n' + e.path; }

	function valid(e) {
		return !!e && typeof e === 'object' && typeof e.path === 'string' && e.path !== ''
			&& typeof e.at === 'number' && isFinite(e.at);
	}

	function norm(e) { return { path: e.path, place: str(e.place), at: e.at }; }

	function order(a, b) {
		if (a.at !== b.at) return b.at - a.at;
		var ka = keyOf(a), kb = keyOf(b);
		return ka < kb ? -1 : (ka > kb ? 1 : 0);
	}

	/// The union of two rings, newest per path and place, newest first. The same
	/// from either side, so two devices merging each other's copy agree.
	function merge(a, b, cap) {
		var best = {};
		[a || [], b || []].forEach(function (ring) {
			ring.forEach(function (e) {
				if (!valid(e)) return;
				var n = norm(e), k = keyOf(n);
				if (!best[k] || best[k].at < n.at) best[k] = n;
			});
		});
		var out = Object.keys(best).map(function (k) { return best[k]; });
		out.sort(order);
		return out.slice(0, cap || CAP);
	}

	/// A new ring with `e` at the top, its older row for the same file gone.
	function append(ring, e, cap) {
		if (!valid(e)) return merge(ring, [], cap);
		var n = norm(e), k = keyOf(n);
		var rest = (ring || []).filter(function (x) { return valid(x) && keyOf(norm(x)) !== k; });
		return [n].concat(rest.map(norm)).slice(0, cap || CAP);
	}

	function parse(text) {
		var v;
		try { v = JSON.parse(str(text)); } catch (e) { return []; }
		if (!Array.isArray(v)) return [];
		return v.filter(valid).map(norm).slice(0, CAP);
	}

	function serialise(ring) { return JSON.stringify((ring || []).filter(valid).map(norm)); }

	function ringPath(id) { return id ? 'diamonds/' + id + '/recent.json' : ''; }

	/// A short time: `justNow` under a minute, then minutes, hours, a weekday within
	/// the week and a month and day after. No string of its own; Intl words the
	/// minutes and hours, and a day goes through `fmtLocal` (DaimondTime's, F-C3), so
	/// it is on the account's calendar like every other date in the app.
	function when(at, now, locale, justNow, fmtLocal) {
		var d = Math.max(0, now - at);
		var nf = function (n, unit) {
			try { return new Intl.NumberFormat(locale, { style: 'unit', unit: unit, unitDisplay: 'short' }).format(n); }
			catch (e) { return String(n); }
		};
		if (d < 60e3) return justNow;
		if (d < 3600e3) return nf(Math.floor(d / 60e3), 'minute');
		if (d < 86400e3) return nf(Math.floor(d / 3600e3), 'hour');
		return fmtLocal(at, d < 7 * 86400e3 ? 'dow' : 'dayMonth');
	}

	/// The Can change rows, from the fence's inputs: its own folder, each mark in
	/// force here (read only where consulted), each mark waiting for a press here,
	/// and each toolchain granted.
	function canChange(b) {
		if (!b || !str(b.own_dir)) return [];
		var rows = [{ kind: 'own', path: b.own_dir, ro: false }];
		var ro = {};
		(b.read_only || []).forEach(function (p) { ro[p] = true; });
		var held = {};
		(b.attached || []).forEach(function (p) {
			held[p] = true;
			rows.push({ kind: 'mark', path: p, ro: !!ro[p] });
		});
		(b.unconfirmed || []).forEach(function (p) {
			if (!held[p]) rows.push({ kind: 'ghost', path: p, ro: false });
		});
		(b.toolkits || []).forEach(function (k) { rows.push({ kind: 'kit', kit: k, ro: false }); });
		return rows;
	}

	function sorted(list) {
		var seen = {}, out = [];
		list.forEach(function (k) { if (!seen[k]) { seen[k] = true; out.push(k); } });
		return out.sort();
	}

	/// The rows as a set of keys, and the fence's inputs as the same set: N1 asks
	/// these to be equal.
	function rowKeys(rows) {
		return sorted((rows || []).map(function (r) {
			return r.kind === 'kit' ? 'kit:' + r.kit : r.kind + ':' + r.path + (r.ro ? ':ro' : '');
		}));
	}
	function boundsKeys(b) {
		if (!b || !str(b.own_dir)) return [];
		var ro = {}, held = {}, out = ['own:' + b.own_dir];
		(b.read_only || []).forEach(function (p) { ro[p] = true; });
		(b.attached || []).forEach(function (p) { held[p] = true; out.push('mark:' + p + (ro[p] ? ':ro' : '')); });
		(b.unconfirmed || []).forEach(function (p) { if (!held[p]) out.push('ghost:' + p); });
		(b.toolkits || []).forEach(function (k) { out.push('kit:' + k); });
		return sorted(out);
	}

	var api = {
		CAP:		CAP,
		pathOf:		pathOf,
		append:		append,
		merge:		merge,
		parse:		parse,
		serialise:	serialise,
		ringPath:	ringPath,
		when:		when,
		canChange:	canChange,
		rowKeys:	rowKeys,
		boundsKeys:	boundsKeys,
	};
	if (typeof window !== 'undefined') window.DaimondRecent = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
