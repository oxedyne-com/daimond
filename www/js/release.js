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
	/// Overridable the same way the log is, and resolved just as late, so a test
	/// can declare a release without writing a file into the served tree.
	function releasesUrl() {
		var m = document.querySelector('meta[name="daimond-releases"]');
		return (m && m.content) || 'releases.json';
	}
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
		try { state.releases = await getJson(releasesUrl()); } catch (e) { state.releases = null; }
		try { state.build = await getJson(STAMP); } catch (e) { state.build = null; }
		state.loaded = true;
		return state;
	}

	/// The milestone a sequence number falls under, or nothing if it predates
	/// every named one.
	function milestoneAt(seq) {
		var ms = (state.releases && state.releases.milestones) || [];
		// Sorted here rather than assumed: the lookup takes the LAST milestone a
		// sequence falls into, which is only the right answer if they ascend. A
		// file authored newest-first would otherwise return the wrong name, and
		// silently.
		var sorted = ms.slice().sort(function (a, b) { return (a.from || 0) - (b.from || 0); });
		var found = null;
		sorted.forEach(function (m) { if (seq >= m.from) found = m; });
		return found;
	}

	/// The build THIS TAB is running, which is not the same thing as the newest
	/// one published. A tab open since before the last deploy is running an older
	/// build, and that is exactly the case this whole surface exists to make
	/// visible.
	function runningBuild() {
		try {
			if (window.DaimondUpdater && DaimondUpdater.booted()) return DaimondUpdater.booted();
		} catch (e) { /* the updater may not have polled yet */ }
		return null;
	}

	/// The log entry for the running build, or nothing if it is not in the log.
	///
	/// Taking the last entry instead -- the newest RELEASE -- was wrong, and
	/// wrong in the direction that flatters: a user who had not refreshed since a
	/// deploy would be told they were on the newest build, on the same screen
	/// where the update chip was telling them a new one existed.
	function current() {
		var id = runningBuild();
		if (!id) return null;
		for (var i = state.entries.length - 1; i >= 0; i--) {
			if (state.entries[i].build === id) return state.entries[i];
		}
		return null;                    // running something not in the published log
	}

	/// The newest published release, whether or not it is the one running.
	function newest() {
		return state.entries.length ? state.entries[state.entries.length - 1] : null;
	}

	/// "today", "yesterday", "3 days ago". Days rather than hours, because the
	/// question this answers is how current you are, not what time it landed.
	function ago(iso) {
		var then = new Date(iso), now = new Date();
		if (isNaN(then)) return '';
		// Compare calendar days, so a build from 23:50 last night reads as
		// yesterday rather than as today.
		var d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		var d1 = new Date(then.getFullYear(), then.getMonth(), then.getDate());
		var days = Math.round((d0 - d1) / 86400000);
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
		var tip = newest();
		var m = cur ? milestoneAt(cur.seq) : null;
		// Behind means the tab is running something older than the tip. Saying so
		// is the point: the alternative is a row that reassures a stale tab.
		var behind = !!(cur && tip && cur.seq < tip.seq);
		// Before any release is declared, the app says so and names the build. It
		// must not present a deployment as a release: several are sealed a day,
		// and none of them is an announcement.
		var name = m ? m.name : (cur ? 'Pre-release' : (runningBuild() || 'Unsealed'));
		var when = cur ? ago(cur.ts) : '';

		r.innerHTML = '';
		r.appendChild(el('span', 'astat-dot' + (cur ? (behind ? ' warn' : ' ok') : '')));
		r.appendChild(el('span', 'astat-label', 'Version'));
		r.appendChild(el('span', 'astat-val', name));
		r.appendChild(el('span', 'astat-aside',
			cur ? (behind ? 'update ready' : (m ? when : cur.build)) : 'not published'));
		r.title = cur
			? (m ? name + ' — build ' + cur.build : 'Pre-release, build ' + cur.build)
				+ ', published ' + dateOf(cur.ts)
				+ (behind ? '. A newer build has been published; reload to take it.' : '.')
				+ ' Click for what changed.'
			: 'This build is not in the published log. Click for the history.';
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
		var ms = (state.releases && state.releases.milestones) || [];

		if (planned) {
			var pl = el('div', 'rel-row rel-planned');
			var ph = el('div', 'rel-head');
			ph.appendChild(el('span', 'rel-name', planned.name));
			ph.appendChild(el('span', 'rel-tag', ms.length ? 'planned' : 'next'));
			pl.appendChild(ph);
			if (planned.blurb) pl.appendChild(el('div', 'rel-blurb', planned.blurb));
			pl.appendChild(el('div', 'rel-meta', 'Not released yet, and not promised for a date.'));
			into.appendChild(pl);
		}

		if (!state.entries.length) {
			into.appendChild(el('div', 'rel-empty', 'No published history could be read.'));
			return;
		}

		// Releases, newest first. A release is something declared, not something
		// deployed: builds are sealed several times a day and listing them all
		// would bury the few entries a reader actually wants.
		var byNewest = ms.slice().sort(function (a, b) { return (b.from || 0) - (a.from || 0); });
		byNewest.forEach(function (m) {
			var first = state.entries.filter(function (e) { return e.seq >= m.from; })[0];
			var here = !!(cur && milestoneAt(cur.seq) && milestoneAt(cur.seq).name === m.name);
			var row = el('div', 'rel-row' + (here ? ' rel-current' : ''));
			var head = el('div', 'rel-head');
			head.appendChild(el('span', 'rel-name', m.name));
			if (here) head.appendChild(el('span', 'rel-tag rel-here', 'you are here'));
			if (first) head.appendChild(el('span', 'rel-when', dateOf(first.ts)));
			row.appendChild(head);
			if (m.blurb) row.appendChild(el('div', 'rel-blurb', m.blurb));
			into.appendChild(row);
		});

		if (!ms.length) {
			var none = el('div', 'rel-row rel-current');
			var nh = el('div', 'rel-head');
			nh.appendChild(el('span', 'rel-name', 'Pre-release'));
			nh.appendChild(el('span', 'rel-tag rel-here', 'you are here'));
			if (cur) nh.appendChild(el('span', 'rel-when', dateOf(cur.ts)));
			none.appendChild(nh);
			none.appendChild(el('div', 'rel-blurb',
				'No release has been declared yet. You are running a build ahead of the first one.'));
			if (cur) {
				var nm = el('div', 'rel-meta');
				nm.appendChild(el('code', null, cur.build));
				nm.appendChild(el('span', null, ' \u00b7 sealed #' + cur.seq));
				none.appendChild(nm);
			}
			into.appendChild(none);
		}

		// Every sealed build, behind a disclosure. They are the verifiable part
		// and must stay reachable, but they are a deployment record rather than
		// a version history, so they do not lead.
		var det = document.createElement('details');
		det.className = 'rel-builds';
		var sum = document.createElement('summary');
		sum.textContent = state.entries.length + ' sealed build'
			+ (state.entries.length === 1 ? '' : 's');
		det.appendChild(sum);
		state.entries.slice().reverse().forEach(function (e) {
			var b = el('div', 'rel-build' + (cur && e.seq === cur.seq ? ' rel-build-here' : ''));
			var bh = el('div', 'rel-build-head');
			bh.appendChild(el('code', null, e.build));
			bh.appendChild(el('span', 'rel-when', dateOf(e.ts)));
			b.appendChild(bh);
			if (e.note) b.appendChild(el('div', 'rel-build-note', e.note));
			det.appendChild(b);
		});
		into.appendChild(det);

		var foot = el('div', 'rel-foot');
		foot.textContent = 'A release is declared; a build is deployed. Every build above is '
			+ 'recorded in a chain that cannot be rewritten without breaking. There is no way '
			+ 'back to an older one, on purpose.';
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
