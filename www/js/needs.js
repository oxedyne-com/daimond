/* ============================================================
   needs.js — the rail's Status exceptions (D-20261015-15).
   ------------------------------------------------------------
   The Status section says nothing while all is well but one muted
   sync line. What needs the person is one row each: a dot, a short
   sentence, ONE act. Red first (a real risk), then amber (something
   running out or waiting). A row goes when its cause does.

   `compute(facts)` is pure, so the rules are tested without a page
   (needs.test.mjs); `paint(box, rows, tr, onAct)` draws them.

   facts:
     hand          permission rung ('bypass' is the red one)
     pots          [{ key, provider, what, label, minutes }] money pots
                   with their runway in minutes (money.js), or null
     updateReady   a newer build is out (release.js `behind`)
     syncStalledMs how long sync has been stalled, in ms
     noModel       nothing can run
   ============================================================ */
(function (root) {
	'use strict';

	/// A pot with less runway than this raises a row. The design's figure was
	/// "~20 h left": a day is when a top-up is worth doing now, not tomorrow.
	var MONEY_MINUTES = 24 * 60;
	/// A stall shorter than this is a hiccup the next round clears.
	var STALL_MS = 10 * 60e3;

	/// Where each provider takes money. A provider not here gets Settings.
	var TOPUP = { openrouter: 'https://openrouter.ai/settings/credits' };

	function compute(f) {
		f = f || {};
		var out = [];
		if (f.hand === 'bypass') {
			out.push({ id: 'bypass', tone: 'bad', key: 'needs.bypass', fb: 'Bypass: tools run unasked',
				vars: {}, act: 'guard', actKey: 'needs.act_guard', actFb: 'Guard' });
		}
		(f.pots || []).forEach(function (p) {
			if (!p || typeof p.minutes !== 'number' || !isFinite(p.minutes)) return;
			if (p.minutes >= MONEY_MINUTES) return;
			var what = p.what || p.label || '';
			var mins = p.minutes < 60;
			var n = mins ? Math.max(1, Math.round(p.minutes)) : Math.round(p.minutes / 60);
			out.push({ id: 'money:' + (p.key || what), tone: 'warn',
				key: mins ? 'needs.money_mins' : 'needs.money_hours',
				fb: mins ? '{what}: ~{n} min left' : '{what}: ~{n} h left',
				vars: { what: what, n: n }, act: 'topup', actKey: 'needs.act_topup', actFb: 'Top Up',
				url: TOPUP[String(p.provider || '').toLowerCase()] || '', pot: p.key || '' });
		});
		if (f.updateReady) {
			out.push({ id: 'update', tone: 'warn', key: 'needs.update', fb: 'Update ready',
				vars: {}, act: 'reload', actKey: 'needs.act_reload', actFb: 'Reload' });
		}
		if (typeof f.syncStalledMs === 'number' && f.syncStalledMs >= STALL_MS) {
			var h = f.syncStalledMs / 3600e3;
			out.push({ id: 'sync', tone: 'warn',
				key: h >= 1 ? 'needs.sync_hours' : 'needs.sync_mins',
				fb: h >= 1 ? 'Sync stalled {n} h' : 'Sync stalled {n} min',
				vars: { n: h >= 1 ? Math.round(h) : Math.round(f.syncStalledMs / 60e3) },
				act: 'retry', actKey: 'needs.act_retry', actFb: 'Retry' });
		}
		if (f.noModel) {
			out.push({ id: 'model', tone: 'warn', key: 'needs.no_model', fb: 'No model',
				vars: {}, act: 'connect', actKey: 'needs.act_connect', actFb: 'Connect' });
		}
		return out;
	}

	/// Draw `rows` into `box`. `tr(key, fallback, vars)` translates; `onAct(row)`
	/// runs the row's one act. Rebuilt whole each time: there are at most a few.
	function paint(box, rows, tr, onAct) {
		if (!box) return;
		var doc = box.ownerDocument;
		box.innerHTML = '';
		box.hidden = !rows.length;
		rows.forEach(function (r) {
			var line = doc.createElement('div');
			line.className = 'astat-row astat-need';
			line.dataset.need = r.id;
			var d = doc.createElement('span');
			d.className = 'astat-dot ' + r.tone;
			d.setAttribute('aria-hidden', 'true');
			var v = doc.createElement('span');
			v.className = 'astat-val';
			v.textContent = tr(r.key, r.fb, r.vars);
			var b = doc.createElement('button');
			b.type = 'button';
			b.className = 'astat-act';
			b.dataset.act = r.act;
			b.textContent = tr(r.actKey, r.actFb);
			b.addEventListener('click', function (e) { e.stopPropagation(); onAct(r); });
			line.appendChild(d); line.appendChild(v); line.appendChild(b);
			box.appendChild(line);
		});
	}

	var api = { compute: compute, paint: paint, MONEY_MINUTES: MONEY_MINUTES, STALL_MS: STALL_MS };
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
	root.DaimondNeeds = api;
})(typeof window !== 'undefined' ? window : globalThis);
