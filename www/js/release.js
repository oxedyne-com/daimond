// release.js — which Daimond you are running, and what came before it.
//
// The app could always tell you a NEW version existed -- the refresh chip in the
// header does that -- but never which one you were on, when it arrived, or what
// changed in it. This is that missing half.
//
// The history is the transparency log itself, the same file the delivery check
// verifies, rather than a changelog kept beside it. A second file would be a
// second thing to maintain and the first thing to fall out of date; and the log
// already has an entry per release, dated, in order, and impossible to rewrite
// quietly. The human "what changed" line was added to each entry OUTSIDE its
// hashed preimage, so the notes can be written and corrected without disturbing
// what the chain attests.
//
// What this deliberately does NOT offer is a way back. A user pinned to an old
// build walks straight into the gateway's own "too old" refusal, can hold a
// build with a security fault that has since been fixed, and risks an old build
// meeting newer local data. Change-aversion is answered at the change -- by
// saying plainly what changed -- not by keeping every past version alive.
(function () {
	'use strict';

	// The same public log the delivery check reads, on an origin this server does
	// not control, and overridable by the same meta tag so a fork points at its
	// own. It is NOT served from inside the bundle: the log entry for a build is
	// written after that build's manifest has been hashed, so a copy sealed
	// alongside would always be one release stale and would fail the check it
	// was meant to support.
	var LOG_DEFAULT = 'https://raw.githubusercontent.com/oxedyne-com/daimond/main/verify/transparency.jsonl';
	/// Resolved when the history is read rather than when this file loads, so a
	/// test can point it at a log of its own without a network round trip.
	function logUrl() {
		var m = document.querySelector('meta[name="daimond-log"]');
		return (m && m.content) || LOG_DEFAULT;
	}
	var RELEASES = 'releases.json';
	var STAMP    = 'build.json';

	var state = { entries: [], releases: null, build: null, loaded: false };

	function el(tag, cls, text) {
		var e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text != null) e.textContent = text;
		return e;
	}

	async function getJson(url) {
		var r = await fetch(url, { cache: 'no-store' });
		if (!r.ok) throw new Error(url + ' → ' + r.status);
		return await r.json();
	}

	/// Load the history once. A failure here must not take the status strip with
	/// it: not knowing the version is a smaller problem than a blank panel.
	async function load() {
		if (state.loaded) return state;
		try {
			var text = await (await fetch(logUrl(), { cache: 'no-store' })).text();
			state.entries = text.split('\n').map(function (l) { return l.trim(); })
				.filter(Boolean)
				.map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } })
				.filter(Boolean);
		} catch (e) { state.entries = []; }
		try { state.releases = await getJson(RELEASES); } catch (e) { state.releases = null; }
		try { state.build = await getJson(STAMP); } catch (e) { state.build = null; }
		state.loaded = true;
		return state;
	}

	/// The milestone a sequence number falls under, or nothing if it predates
	/// every named one.
	function milestoneAt(seq) {
		var ms = (state.releases && state.releases.milestones) || [];
		var found = null;
		ms.forEach(function (m) { if (seq >= m.from) found = m; });
		return found;
	}

	function current() {
		return state.entries.length ? state.entries[state.entries.length - 1] : null;
	}

	/// "today", "yesterday", "3 days ago". Days rather than hours, because the
	/// question this answers is how current you are, not what time it landed.
	function ago(iso) {
		var then = new Date(iso), now = new Date();
		if (isNaN(then)) return '';
		var days = Math.floor((now - then) / 86400000);
		// Compare calendar days, so a build from 23:50 last night reads as
		// yesterday rather than as today.
		var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		var d1 = new Date(then.getFullYear(), then.getMonth(), then.getDate());
		days = Math.round((d0 - d1) / 86400000);
		if (days <= 0) return 'today';
		if (days === 1) return 'yesterday';
		if (days < 31) return days + ' days ago';
		if (days < 365) return Math.round(days / 30) + ' months ago';
		return Math.round(days / 365) + ' years ago';
	}

	function dateOf(iso) {
		var d = new Date(iso);
		if (isNaN(d)) return '';
		return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
	}

	// ── The status row ──────────────────────────────────────────────────

	/// Fill the row in the status strip: the release you are on, and how long it
	/// has been there.
	async function paintRow() {
		var r = document.getElementById('astat-release');
		if (!r) return;
		await load();
		var cur = current();
		var m = cur ? milestoneAt(cur.seq) : null;
		var name = (m && m.name) || (state.build && state.build.build) || 'Unsealed';
		var when = cur ? ago(cur.ts) : '';

		r.innerHTML = '';
		r.appendChild(el('span', 'astat-dot ok'));
		r.appendChild(el('span', 'astat-label', 'Version'));
		r.appendChild(el('span', 'astat-val', name));
		if (when) r.appendChild(el('span', 'astat-aside', when));
		r.title = cur
			? name + ' — build ' + cur.build + ', published ' + dateOf(cur.ts) + '. Click for what changed.'
			: 'Version history';
	}

	// ── The timeline ────────────────────────────────────────────────────

	/// Build the history: what is coming, what you are on, and what came before.
	///
	/// The planned entry is drawn first and drawn differently, because it is the
	/// one line here that is a promise rather than a record. Everything below it
	/// is sealed and checkable; it is neither, and must not borrow their
	/// authority.
	async function render(into) {
		await load();
		into.innerHTML = '';

		var cur = current();
		var planned = state.releases && state.releases.planned;

		if (planned) {
			var p = el('div', 'rel-row rel-planned');
			var ph = el('div', 'rel-head');
			ph.appendChild(el('span', 'rel-name', planned.name));
			ph.appendChild(el('span', 'rel-tag', 'planned'));
			p.appendChild(ph);
			if (planned.blurb) p.appendChild(el('div', 'rel-blurb', planned.blurb));
			p.appendChild(el('div', 'rel-meta', 'Not built yet, and not promised for a date.'));
			into.appendChild(p);
		}

		if (!state.entries.length) {
			into.appendChild(el('div', 'rel-empty', 'No published history could be read.'));
			return;
		}

		var seen = {};
		state.entries.slice().reverse().forEach(function (e, i) {
			var isCur = cur && e.seq === cur.seq;
			var row = el('div', 'rel-row' + (isCur ? ' rel-current' : ''));

			var head = el('div', 'rel-head');
			var m = milestoneAt(e.seq);
			// The milestone's name is written once, on the newest build that
			// carries it, so a run of builds does not repeat one word twelve times.
			if (m && !seen[m.name]) {
				seen[m.name] = true;
				head.appendChild(el('span', 'rel-name', m.name));
			}
			if (isCur) head.appendChild(el('span', 'rel-tag rel-here', 'you are here'));
			head.appendChild(el('span', 'rel-when', dateOf(e.ts)));
			row.appendChild(head);

			if (e.note) row.appendChild(el('div', 'rel-note', e.note));
			var meta = el('div', 'rel-meta');
			meta.appendChild(el('code', null, e.build));
			meta.appendChild(el('span', null, ' · sealed #' + e.seq));
			row.appendChild(meta);

			if (m && seen[m.name] && m.blurb && !seen[m.name + ':blurb'] ) {
				seen[m.name + ':blurb'] = true;
				row.insertBefore(el('div', 'rel-blurb', m.blurb), row.children[1] || null);
			}
			into.appendChild(row);
		});

		var foot = el('div', 'rel-foot');
		foot.textContent = 'Every line below the first is a published build, recorded in a chain that '
			+ 'cannot be rewritten without breaking. There is no way back to an older one, on purpose.';
		into.appendChild(foot);
	}

	window.DaimondRelease = {
		reset: function () { state = { entries: [], releases: null, build: null, loaded: false }; },
		paintRow: paintRow,
		render: render,
		load: load,
		current: current,
		milestoneAt: milestoneAt,
		ago: ago,
	};
})();
