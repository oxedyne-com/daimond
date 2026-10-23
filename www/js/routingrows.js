/* routingrows.js -- a model's OpenRouter routing as rows of hosts, one choice each (D-20261018-09 U5b,
   D-20261020-10).

   The stored routing text is unchanged ("Novita, -DeepInfra, !", read by `DaimondModels.parseRouting`
   and by the engine), so an older build reads what these rows write.  This file is the mapping
   between that text and the rows, and nothing else: it takes the parsed `{ order, ignore, only }`,
   never the text, so there is one parser.

       Prefer  -> the host joins `order`, after any already preferred
       Avoid   -> `-host`, into `ignore`
       Auto    -> the host is in neither, and the measurement decides
       Only    -> `!`, held only while something is preferred

   A stored value the rows cannot say (a host both preferred and avoided, a name twice, `!` with
   nothing preferred) is `expressible() === false`: the page shows it as typed, with a Clear, and
   never rewrites it.
*/
(function () {
	'use strict';

	function copy(p) {
		p = p || {};
		return {
			order:  (p.order  || []).slice(),
			ignore: (p.ignore || []).slice(),
			only:   !!p.only,
		};
	}

	function dupes(a) {
		var seen = {};
		for (var i = 0; i < a.length; i++) {
			if (seen['$' + a[i]]) return true;
			seen['$' + a[i]] = 1;
		}
		return false;
	}

	/// Can the rows show this parsed value exactly, so a click rewrites nothing the person meant?
	function expressible(p) {
		p = copy(p);
		if (dupes(p.order) || dupes(p.ignore)) return false;
		for (var i = 0; i < p.order.length; i++) if (p.ignore.indexOf(p.order[i]) >= 0) return false;
		if (p.only && !p.order.length) return false;
		return true;
	}

	/// 'prefer', 'avoid' or 'auto' for `host`.
	function choice(p, host) {
		p = copy(p);
		if (p.order.indexOf(host) >= 0) return 'prefer';
		if (p.ignore.indexOf(host) >= 0) return 'avoid';
		return 'auto';
	}

	/// The value with `host` set to `what`; a host newly preferred goes last, so an order already
	/// chosen keeps its head.
	function set(p, host, what) {
		var q = copy(p);
		host = String(host || '').trim();
		if (!host) return q;
		q.order  = q.order.filter(function (h) { return h !== host; });
		q.ignore = q.ignore.filter(function (h) { return h !== host; });
		if (what === 'prefer') q.order.push(host);
		else if (what === 'avoid') q.ignore.push(host);
		if (!q.order.length) q.only = false;	// "only these" of nothing would refuse every host
		return q;
	}

	function setOnly(p, on) {
		var q = copy(p);
		q.only = !!on && q.order.length > 0;
		return q;
	}

	/// The stored text for a value: preferred in order, then avoided, then `!`.
	function text(p) {
		p = copy(p);
		var toks = p.order.concat(p.ignore.map(function (h) { return '-' + h; }));
		if (p.only && p.order.length) toks.push('!');
		return toks.join(', ');
	}

	/// The rows for `model`: every host measured for it (from `DaimondHostSpeed.figures()`), then
	/// every host OpenRouter says serves it (`hosts`, from its endpoints list, in OpenRouter's order)
	/// that has no figures yet, then any host the stored value names that is in neither.  The host
	/// OpenRouter answered on most recently is `last`.  Measured hosts run quickest first.
	function rows(p, figs, model, hosts) {
		p = copy(p);
		var mine = (figs || []).filter(function (f) { return f && f.model === model && f.host; });
		mine.sort(function (a, b) {
			var x = a.tps == null ? -1 : a.tps, y = b.tps == null ? -1 : b.tps;
			return y - x || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0);
		});
		var lastAt = 0, lastHost = '';
		mine.forEach(function (f) { if (f.lastAt > lastAt) { lastAt = f.lastAt; lastHost = f.host; } });
		var best = null;
		mine.forEach(function (f) { if (f.tps != null && (best == null || f.tps > best)) best = f.tps; });
		var out = mine.map(function (f) {
			return { host: f.host, fig: f, choice: choice(p, f.host), last: f.host === lastHost, best: best };
		});
		(hosts || []).concat(p.order, p.ignore).forEach(function (h) {
			if (out.some(function (r) { return r.host === h; })) return;
			out.push({ host: h, fig: null, choice: choice(p, h), last: false, best: best });
		});
		return out;
	}

	/// Is this row's host being left out by the measurement?  Never when the person chose for it:
	/// their Prefer outranks a slow figure (the engine leaves ordered hosts out of its ignore), and
	/// under "only these" the measurement adds nothing.
	function avoided(row, only) {
		return !!(row && row.fig && row.fig.slow && row.choice === 'auto' && !only);
	}

	/// The reason a measured-slow host is slow: its kind, the rounds behind it, and the figures.
	function reason(row) {
		var f = row && row.fig;
		if (!f || !f.slow) return null;
		var n = f.rounds;
		var tps = f.tps == null ? 0 : Math.round(f.tps);
		switch (f.why) {
			case 'stalls':	return { kind: 'stalls', n: n, vars: { k: Math.round(f.stallShare * n) } };
			case 'behind':	return { kind: 'behind', n: n, vars: { tps: tps, best: Math.round(row.best || 0) } };
			case 'wait':	return { kind: 'wait', n: n, vars: { s: Math.round((f.firstMs || 0) / 1000) } };
			default:		return { kind: 'rate', n: n, vars: { tps: tps } };
		}
	}

	/// The host names in an OpenRouter `/models/{id}/endpoints` reply, once each, in its order.
	/// `provider_name` is the name provider routing (`order`, `ignore`) and the measurement use.
	function hostsFrom(json) {
		var eps = json && json.data && Array.isArray(json.data.endpoints) ? json.data.endpoints : [];
		var out = [];
		eps.forEach(function (e) {
			var h = e && typeof e.provider_name === 'string' ? e.provider_name.trim() : '';
			if (h && out.indexOf(h) === -1) out.push(h);
		});
		return out;
	}

	/// The hosts serving each model, asked of OpenRouter only when that model's routing is opened,
	/// never for every row.  Bounds: held in memory only (a reload asks again); an answer is kept
	/// `ttlMs` (30 min: OpenRouter's host list for a model changes over days, not minutes); a failed
	/// ask is not repeated for `failMs` (2 min), so an open detail on a dead network does not spin;
	/// at most `max` models (64) are held, the one asked longest ago dropped first; one request per
	/// model in flight at a time.  `ask(model)` is the caller's fetch, resolving to the reply's JSON
	/// or throwing; `done(model)` is called once the entry changes.
	function hostCache(opt) {
		opt = opt || {};
		var ttl  = opt.ttlMs  || 30 * 60 * 1000;
		var fail = opt.failMs || 2 * 60 * 1000;
		var max  = opt.max    || 64;
		var now  = opt.now    || Date.now;
		var map  = new Map();	// model -> { state: 'busy'|'ok'|'failed', hosts, at }, oldest first
		function get(model) { return map.get(model) || null; }
		function fresh(e) {
			if (!e) return false;
			if (e.state === 'busy') return true;
			return now() - e.at < (e.state === 'ok' ? ttl : fail);
		}
		function want(model, ask, done) {
			var e = map.get(model);
			if (fresh(e)) return e;
			var mine = { state: 'busy', hosts: e && e.hosts ? e.hosts : [], at: now() };
			map.delete(model);
			map.set(model, mine);
			while (map.size > max) map.delete(map.keys().next().value);
			Promise.resolve().then(function () { return ask(model); }).then(function (json) {
				mine.state = 'ok'; mine.hosts = hostsFrom(json); mine.at = now();
			}, function () {
				mine.state = 'failed'; mine.at = now();
			}).then(function () { if (done) done(model); });
			return mine;
		}
		return { get: get, want: want, size: function () { return map.size; } };
	}

	var api = {
		expressible: expressible,
		choice:      choice,
		set:         set,
		setOnly:     setOnly,
		text:        text,
		rows:        rows,
		avoided:     avoided,
		reason:      reason,
		hostsFrom:   hostsFrom,
		hostCache:   hostCache,
	};
	if (typeof window !== 'undefined') window.DaimondRoutingRows = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
