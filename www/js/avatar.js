/* ============================================================
   Daimond — the icon beside a Diamond's or a chat's name (DaimondAvatar)
   ============================================================

   D-20261015-13, ruled 16 Oct: Tabler icons, drawn at the app's own
   `.ic` stroke (1.75, round), one ink line and no box around it.

   A DEFAULT IS A GUESS FROM THE NAME AND THE TAGS, made from the moment
   the thing is created and made again as they change, so a Diamond made
   bare and tagged a minute later still gets the icon its tags say. It is
   never stored: the same name and tags give the same icon on every
   device, so nothing travels until a person picks one: "Fred Hoogland" tagged person is a person, "Ship the
   launch" is a rocket, a chat about a solar aircraft is a plane. With
   nothing to go on, a Diamond is the diamond and a chat is the speech
   bubble. Rows then tell apart at a glance, which one icon per kind
   never could.

   THE CHOICE TRAVELS like the Diamond's tags: a map from `d:<id>` or
   `c:<id>` to `{ i: icon, at: stamp }`, in the sync parcel's `avatars`
   section, freshest stamp wins (js/stamp.js). An empty `i` is "Use
   Default": the guess is made again from the name and tags as they are.
   A parcel without the section is a device that predates it, and
   applies as a no-op.

   The icons a default can be ship with the page (js/avatar_core.js);
   the picker's full set (5,184) is fetched the first time it opens,
   from www/assets/tabler/, inside the sealed bundle. Both are generated
   by dev/tabler.mjs from Tabler Icons 3.49.0 (MIT).
   ============================================================ */
(function (root) {
	'use strict';

	var CORE = (typeof module !== 'undefined' && module.exports)
		? require('./avatar_core.js') : (root.DaimondAvatarCore || {});

	var FALLBACK = { diamond: 'diamond', chat: 'message-circle' };

	/// Words that say nothing about a subject.
	var STOP = {};
	('a an and are as at be but by can do for from has have how i if in into is it its me my no not of on or our '
		+ 'so that the their them then there these this to up us was we what when where which who why will with '
		+ 'you your about after all also any back been before being both could each just like make more most new '
		+ 'one only other out over possible same should some such than too very would small big good best get got '
		+ 'build powered summarise summarize plan chat diamond').split(' ').forEach(function (w) { STOP[w] = 1; });

	/// The words Tabler's tags do not reach, or reach the wrong way for a default: what a
	/// person names a Diamond by, mapped to the icon that reads as it. Checked first.
	var EXTRA = {
		person: 'user', me: 'user', profile: 'user', biography: 'user', people: 'users', team: 'users-group',
		philosophy: 'yin-yang', religion: 'yin-yang', ontology: 'yin-yang', meditation: 'yin-yang', spirituality: 'yin-yang',
		launch: 'rocket', ship: 'rocket', release: 'rocket', startup: 'rocket', deploy: 'rocket',
		checklist: 'list-check', todo: 'list-check', todos: 'list-check', tasks: 'list-check',
		aircraft: 'plane', flight: 'plane', airplane: 'plane', aviation: 'plane', travel: 'plane',
		lifelog: 'notebook', diary: 'notebook', journal: 'notebook', log: 'notebook', notes: 'notebook',
		brand: 'speakerphone', marketing: 'speakerphone', campaign: 'speakerphone', announcement: 'speakerphone',
		garden: 'plant', gardening: 'plant', cooking: 'chef-hat', recipe: 'chef-hat', kitchen: 'chef-hat',
		money: 'coin', finance: 'coin', budget: 'wallet', invest: 'chart-line', investing: 'chart-line',
		research: 'flask', science: 'atom', study: 'school', learning: 'school', course: 'school',
		health: 'heartbeat', fitness: 'barbell', workout: 'barbell', gym: 'barbell', running: 'run',
		home: 'home', house: 'home', kids: 'home-heart', love: 'heart',
		book: 'book', novel: 'book', writing: 'pencil', essay: 'pencil', blog: 'article', newsletter: 'news',
		email: 'mail', inbox: 'mail', legal: 'gavel', law: 'gavel', contract: 'license',
		music: 'music', song: 'music', podcast: 'microphone', video: 'movie', film: 'movie', photo: 'photo',
		design: 'palette', art: 'brush', idea: 'bulb', ideas: 'bulb', brainstorm: 'bulb',
		code: 'code', coding: 'code', programming: 'code', software: 'code', dev: 'code', bug: 'bug',
		server: 'server', data: 'database', ai: 'sparkles', agent: 'robot', bot: 'robot',
		work: 'briefcase', job: 'briefcase', career: 'briefcase', business: 'briefcase', company: 'building',
		shopping: 'shopping-cart', gift: 'gift', party: 'confetti', game: 'device-gamepad-2', games: 'device-gamepad-2',
		football: 'ball-football', soccer: 'ball-football', basketball: 'ball-basketball', yoga: 'yoga',
		coffee: 'coffee', food: 'tools-kitchen-2', holiday: 'beach', vacation: 'beach', trip: 'plane-departure',
		weather: 'cloud', climate: 'cloud-rain', energy: 'bolt', solar: 'sun', security: 'shield', password: 'key',
		dog: 'dog', cat: 'cat', pet: 'paw', pets: 'paw', fish: 'fish', camping: 'tent', hiking: 'mountain',
		car: 'car', bike: 'bike', cycling: 'bike', boat: 'sailboat', sailing: 'sailboat', map: 'map',
		calendar: 'calendar', schedule: 'calendar', meeting: 'calendar', goal: 'target', goals: 'target',
		language: 'language', translation: 'language', website: 'world-www', social: 'share',
	};

	var tagIndex = null;
	/// Tabler's own tags over the core set, word -> the first core icon carrying it.
	function tags() {
		if (tagIndex) return tagIndex;
		tagIndex = {};
		Object.keys(CORE).forEach(function (n) {
			String(CORE[n][1] || '').split(' ').forEach(function (w) {
				if (w && !Object.prototype.hasOwnProperty.call(tagIndex, w)) tagIndex[w] = n;
			});
		});
		return tagIndex;
	}

	function words(s) {
		return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 1 && !STOP[w]; });
	}
	function stems(w) {
		var out = [w];
		if (/ies$/.test(w)) out.push(w.slice(0, -3) + 'y');
		if (/s$/.test(w) && !/ss$/.test(w)) out.push(w.slice(0, -1));
		return out;
	}
	var has = Object.prototype.hasOwnProperty;

	/// What one word points at, and how sure: the curated word (3), an icon of that very name (2),
	/// or an icon whose Tabler tags hold it (1).
	function lookup(w) {
		var ss = stems(w), i;
		for (i = 0; i < ss.length; i++) if (has.call(EXTRA, ss[i]) && CORE[EXTRA[ss[i]]]) return [EXTRA[ss[i]], 3];
		for (i = 0; i < ss.length; i++) if (has.call(CORE, ss[i])) return [ss[i], 2];
		var T = tags();
		for (i = 0; i < ss.length; i++) if (has.call(T, ss[i])) return [T[ss[i]], 1];
		return null;
	}

	/// Every icon the name and tags point at, best first. A word in the NAME counts half again a
	/// tag's, and a later word a little more than an earlier one: English puts the thing a phrase
	/// is about last ("the launch CHECKLIST", "a solar powered AIRCRAFT").
	function ranked(name, tagList) {
		var score = {}, order = [];
		function add(hit, w) {
			if (!hit) return;
			if (!has.call(score, hit[0])) { score[hit[0]] = 0; order.push(hit[0]); }
			score[hit[0]] += hit[1] * w;
		}
		words(name).forEach(function (w, i) { add(lookup(w), 1.5 + 0.01 * (i + 1)); });
		(Array.isArray(tagList) ? tagList : []).forEach(function (t) {
			words(t).forEach(function (w) { add(lookup(w), 1); });
		});
		return order.slice().sort(function (a, b) {
			return (score[b] - score[a]) || (order.indexOf(a) - order.indexOf(b));
		});
	}

	/// The default icon for a thing of `kind` ('diamond' or 'chat') with this name and these tags.
	function pick(name, tagList, kind) {
		var r = ranked(name, tagList);
		return r.length ? r[0] : (FALLBACK[kind] || FALLBACK.diamond);
	}

	var PAD = ['star', 'heart', 'bulb', 'book', 'briefcase', 'home', 'world', 'sparkles', 'user', 'rocket'];
	/// Eight to offer first in the picker: the default, the other icons the words point at, then
	/// the kind's own fallback and a few general ones.
	function suggest(name, tagList, kind) {
		var out = [];
		function push(n) { if (n && CORE[n] && out.indexOf(n) < 0 && out.length < 8) out.push(n); }
		push(pick(name, tagList, kind));
		ranked(name, tagList).forEach(push);
		push(FALLBACK[kind] || FALLBACK.diamond);
		PAD.forEach(push);
		return out;
	}

	function ms(v) { var n = Number(v); return (isFinite(n) && n > 0) ? Math.floor(n) : 0; }
	function validRec(k, r) {
		return /^[dc]:./.test(k) && r && typeof r === 'object' && typeof r.i === 'string'
			&& /^[a-z0-9-]{0,64}$/.test(r.i) && ms(r.at) > 0;
	}
	/// `b` beats `a`: the later stamp, and at a tie the larger name, the same on every device.
	function beats(b, a) {
		if (!a) return true;
		var x = ms(b.at), y = ms(a.at);
		if (x !== y) return x > y;
		return b.i > a.i;
	}

	/// Fold another device's map into this one. `{ next, changed }`; `next` is a fresh object.
	function merge(mine, theirs) {
		var next = {}, changed = false;
		Object.keys(mine || {}).forEach(function (k) { if (validRec(k, mine[k])) next[k] = { i: mine[k].i, at: ms(mine[k].at) }; });
		if (theirs && typeof theirs === 'object') {
			Object.keys(theirs).forEach(function (k) {
				var r = theirs[k];
				if (!validRec(k, r)) return;
				var rr = { i: r.i, at: ms(r.at) };
				if (beats(rr, next[k])) { next[k] = rr; changed = true; }
			});
		}
		return { next: next, changed: changed };
	}

	/// Which icon to draw: the one chosen, unless it is "Use Default" or a name this build
	/// cannot draw; then the guess from the name and tags.
	function resolve(rec, name, tagList, kind, canDraw) {
		var ok = canDraw || function (n) { return !!CORE[n]; };
		if (rec && rec.i && ok(rec.i)) return rec.i;
		return pick(name, tagList, kind);
	}

	/// The picker's search over the full set (`[name, category, tags]` rows): names that are the
	/// query, then names holding it, then a tag that is it, then a tag starting with it.
	function search(set, q) {
		q = String(q || '').trim().toLowerCase();
		if (!q) return [];
		var buckets = [[], [], [], []];
		(set || []).forEach(function (row) {
			var n = row[0], tg = ' ' + String(row[2] || '') + ' ';
			if (n === q) buckets[0].push(n);
			else if (n.indexOf(q) >= 0) buckets[1].push(n);
			else if (tg.indexOf(' ' + q + ' ') >= 0) buckets[2].push(n);
			else if (tg.indexOf(' ' + q) >= 0) buckets[3].push(n);
		});
		return buckets[0].concat(buckets[1], buckets[2], buckets[3]);
	}

	var api = { pick: pick, suggest: suggest, merge: merge, resolve: resolve, search: search, FALLBACK: FALLBACK };
	if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

	// ── In the page ──────────────────────────────────────────────

	var KEY = 'daimond-avatars';
	var full = null, fullAt = null, loading = null;	// the picker's whole set, once fetched

	function store() { return root.DaimondStore || null; }
	function readMap() {
		var m = null;
		try { m = store() ? store().get(KEY, null) : JSON.parse(root.localStorage.getItem(KEY) || 'null'); }
		catch (e) { m = null; }
		return merge(m && typeof m === 'object' ? m : {}, null).next;
	}
	function writeMap(m, merged) {
		var S = store();
		var law = function (held, v) { return merge(held || {}, v).next; };
		if (S) return merged ? S.putMerged(KEY, m, law) : S.put(KEY, m, law);
		try { root.localStorage.setItem(KEY, JSON.stringify(m)); } catch (e) { /* refused */ }
		return true;
	}
	var map = readMap();

	function changed(key) {
		try { root.dispatchEvent(new CustomEvent('daimond:avatars', { detail: { key: key || '' } })); }
		catch (e) { /* no window to tell */ }
	}
	function tell() {
		try { if (root.DaimondSync && root.DaimondSync.nudge) root.DaimondSync.nudge(); } catch (e) { /* next round */ }
	}

	function inner(n) {
		if (CORE[n]) return CORE[n][0];
		if (fullAt && has.call(fullAt, n)) return full.icons[fullAt[n]][3];
		return '';
	}
	function canDraw(n) {
		if (CORE[n] || (fullAt && has.call(fullAt, n))) return true;
		// A name from the full set this page has not fetched yet: draw the default for now, and
		// fetch the set so the next paint has it.
		if (!fullAt) load().then(function () { changed(''); }, function () { /* offline: stays default */ });
		return false;
	}

	/// Fetch the full set, once. Resolves to `{ v, cats, icons: [[name, cat, tags, inner], …] }`.
	function load() {
		if (full) return Promise.resolve(full);
		if (loading) return loading;
		loading = fetch('assets/tabler/icons.json').then(function (r) {
			if (!r.ok) throw new Error('icons ' + r.status);
			return r.json();
		}).then(function (j) {
			full = j; fullAt = {};
			j.icons.forEach(function (row, i) { fullAt[row[0]] = i; });
			return full;
		}, function (e) { loading = null; throw e; });
		return loading;
	}

	function keyOf(kind, id) { return (kind === 'chat' ? 'c:' : 'd:') + id; }

	/// The icon name to draw for this Diamond or chat.
	function iconFor(kind, id, name, tagList) {
		return resolve(map[keyOf(kind, id)] || null, name, tagList, kind, canDraw);
	}

	/// An icon as markup, at `size` pixels, drawn by the app's own `.ic` rule.
	function svg(n, size, cls) {
		var s = size || 16;
		return '<svg class="ic av-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" style="width:' + s + 'px;height:' + s
			+ 'px" aria-hidden="true" data-icon="' + n + '">' + inner(n) + '</svg>';
	}

	/// Set the icon. `icon` '' is "Use Default".
	function choose(kind, id, icon) {
		var k = keyOf(kind, id), prev = map[k];
		var S = root.DaimondStamp;
		var at = S ? S.next(prev && prev.at) : Math.max(Date.now(), (prev ? prev.at : 0) + 1);
		var next = Object.assign({}, map); next[k] = { i: String(icon || ''), at: at };
		map = next;
		writeMap(map, false);
		changed(k);
		tell();
	}

	/// The map as it rides the parcel, keys sorted so the push-skip comparison sees one
	/// serialisation however the entries arrived. Null when nobody ever chose.
	function syncSnapshot() {
		var ks = Object.keys(map).sort();
		if (!ks.length) return null;
		var o = {};
		ks.forEach(function (k) { o[k] = { i: map[k].i, at: map[k].at }; });
		return o;
	}
	function adoptSync(remote) {
		var m = merge(map, remote);
		if (!m.changed) return;
		writeMap(m.next, true);
		map = m.next;
		changed('');
	}

	// ── The picker ───────────────────────────────────────────────

	var pickerEl = null, pickerClose = null;
	function tr(k, fb, vars) {
		try { if (root.tOr) return root.tOr(k, fb, vars); } catch (e) { /* fall through */ }
		var s = fb; Object.keys(vars || {}).forEach(function (v) { s = s.replace('{' + v + '}', vars[v]); }); return s;
	}
	function closePicker() {
		if (pickerClose) pickerClose();
	}

	/// Open the picker for a Diamond or chat, beside `anchor` (a popover on a desktop, a bottom
	/// sheet on a phone). `o`: `{ kind, id, name, tags }`.
	function openPicker(anchor, o) {
		closePicker();
		var cur = iconFor(o.kind, o.id, o.name, o.tags);
		var box = document.createElement('div');
		box.className = 'av-pick';
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-label', tr('avatar.title', 'Icon'));
		var head = document.createElement('div');
		head.className = 'av-pick-head';
		var title = document.createElement('span');
		title.className = 'av-pick-title';
		title.textContent = tr('avatar.title', 'Icon');
		var x = document.createElement('button');
		x.className = 'ui-close av-pick-x';
		x.setAttribute('aria-label', tr('common.close', 'Close'));
		x.innerHTML = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
		head.appendChild(title); head.appendChild(x);
		var q = document.createElement('input');
		q.className = 'av-pick-search';
		q.type = 'search';
		q.placeholder = tr('avatar.search', 'Search {n} icons', { n: '5,184' });
		q.setAttribute('aria-label', q.placeholder);
		var body = document.createElement('div');
		body.className = 'av-pick-body';
		var foot = document.createElement('div');
		foot.className = 'av-pick-foot';
		var credit = document.createElement('span');
		credit.className = 'av-pick-credit';
		credit.textContent = 'Tabler · MIT';
		var def = document.createElement('button');
		def.className = 'av-pick-default';
		def.textContent = tr('avatar.use_default', 'Use Default');
		foot.appendChild(credit); foot.appendChild(def);
		box.appendChild(head); box.appendChild(q); box.appendChild(body); box.appendChild(foot);

		function cell(n) {
			var b = document.createElement('button');
			b.className = 'av-cell' + (n === cur ? ' on' : '');
			b.title = n;
			b.setAttribute('aria-label', n);
			b.dataset.icon = n;
			b.innerHTML = svg(n, 18);
			return b;
		}
		function label(text) {
			var l = document.createElement('div');
			l.className = 'av-pick-label';
			l.textContent = text;
			return l;
		}
		function grid(names) {
			var g = document.createElement('div');
			g.className = 'av-grid';
			names.forEach(function (n) { g.appendChild(cell(n)); });
			return g;
		}
		function drawHome() {
			body.innerHTML = '';
			body.appendChild(label(tr('avatar.suggested', 'From its name and tags')));
			body.appendChild(grid(suggest(o.name, o.tags, o.kind)));
			// The curated set, flat, as av-K-picker-desk draws it. The other five thousand
			// are one search away (the box says how many): drawing them all here put 5,192
			// buttons in the DOM to show the first forty.
			var scr = document.createElement('div');
			scr.className = 'av-pick-scr';
			scr.appendChild(label(tr('avatar.all', 'All')));
			scr.appendChild(grid(Object.keys(CORE)));
			body.appendChild(scr);
		}
		function drawSearch() {
			var v = q.value.trim();
			if (!v) { drawHome(); return; }
			var set = full ? full.icons : Object.keys(CORE).map(function (n) { return [n, 0, CORE[n][1]]; });
			var hits = search(set, v).slice(0, 240);
			body.innerHTML = '';
			if (!hits.length) {
				var none = document.createElement('div');
				none.className = 'av-pick-none';
				none.textContent = tr('avatar.none', 'No icon matches.');
				body.appendChild(none);
				return;
			}
			var scr = document.createElement('div');
			scr.className = 'av-pick-scr av-pick-hits';
			scr.appendChild(grid(hits));
			body.appendChild(scr);
		}
		q.addEventListener('input', drawSearch);
		body.addEventListener('click', function (e) {
			var b = e.target.closest && e.target.closest('.av-cell');
			if (!b) return;
			choose(o.kind, o.id, b.dataset.icon);
			done();
		});
		def.addEventListener('click', function () { choose(o.kind, o.id, ''); done(); });
		x.addEventListener('click', done);

		var phone = root.matchMedia && root.matchMedia('(max-width: 640px)').matches;
		box.classList.toggle('av-sheet', !!phone);
		document.body.appendChild(box);
		if (!phone && anchor && anchor.getBoundingClientRect) {
			var r = anchor.getBoundingClientRect();
			// Beside the rail, not over it (av-K-picker-desk): the tile it names stays in view.
			var rail = anchor.closest && anchor.closest('.panel.rail');
			var edge = rail ? rail.getBoundingClientRect().right : r.right;
			var w = box.offsetWidth || 300, h = box.offsetHeight || 380;
			var left = Math.min(Math.max(8, edge + 8), root.innerWidth - w - 8);
			var top = Math.min(Math.max(8, r.top - 12), root.innerHeight - h - 8);
			box.style.left = left + 'px';
			box.style.top = top + 'px';
		}
		drawHome();
		load().then(function () { if (pickerEl === box && !q.value.trim()) drawHome(); else if (pickerEl === box) drawSearch(); },
			function () { /* offline: the core set stays */ });

		function outside(e) { if (!box.contains(e.target) && !(anchor && anchor.contains && anchor.contains(e.target))) done(); }
		setTimeout(function () { document.addEventListener('pointerdown', outside, true); }, 0);
		// Escape and Back close it through the one layer stack (layers.js), not a key handler of its own.
		if (root.DaimondLayers) root.DaimondLayers.open('avatar', done);
		function done() {
			document.removeEventListener('pointerdown', outside, true);
			if (root.DaimondLayers) root.DaimondLayers.done('avatar');
			if (box.parentNode) box.parentNode.removeChild(box);
			if (pickerEl === box) { pickerEl = null; pickerClose = null; }
			try { if (anchor && anchor.focus) anchor.focus(); } catch (e) { /* gone */ }
		}
		pickerEl = box; pickerClose = done;
		// Not on a phone: focusing the box raises the keyboard over the sheet it opened.
		if (!phone) { try { q.focus({ preventScroll: true }); } catch (e) { /* no focus */ } }
		return box;
	}

	/// A button holding the icon for a rail tile; pressing it opens the picker. `o` as openPicker.
	function button(o) {
		var b = document.createElement('button');
		b.className = 'av-btn';
		b.type = 'button';
		b.title = tr('avatar.change', 'Change icon');
		b.setAttribute('aria-label', b.title);
		b.innerHTML = svg(iconFor(o.kind, o.id, o.name, o.tags), 16);
		b.addEventListener('click', function (e) { e.stopPropagation(); openPicker(b, o); });
		b.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); });
		return b;
	}

	root.DaimondAvatar = Object.assign({}, api, {
		iconFor: iconFor, svg: svg, choose: choose, button: button,
		openPicker: openPicker, closePicker: closePicker, load: load,
		syncSnapshot: syncSnapshot,	// for collectSync
		adoptSync: adoptSync,		// for applySync
		get: function (kind, id) { return map[keyOf(kind, id)] || null; },
	});
})(typeof window !== 'undefined' ? window : globalThis);
