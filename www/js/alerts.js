/* alerts.js -- DaimondAlerts: what a Diamond has raised on the Pending panel, on every device.
 *
 * D-20261016-17, the owner's words: "why not use the Pending panel? The Email diamond will
 * mostly sit in the background." A Diamond that watches something runs on its triggers while
 * nobody has it open, so a fault it found was a line in a log nobody read. Its daimon now calls
 * `pending_raise {key, headline, detail, needs}` for each alert, and
 * `pending_clear {key}` when it is over (src/tools.rs, `pending_step`; src/wasm/pending.rs).
 *
 * THE KEY IS THE DIAMOND'S, NEVER THE MODEL'S WORD. The engine passes the turn's own Diamond
 * id beside the payload, and every record is held under `<diamond>:<key>`, so one Diamond can
 * neither clear nor overwrite another's alert. Raising a key already up updates that item in
 * place: there is one record per name, so there is no second item to add.
 *
 * ONE RECORD, ONE KEY, ONE WRITE (store.js). The whole map lives under `daimond-alerts` and
 * rides the sync parcel as `alerts` (daimond.js `collectSync` / `applySync`). Each item is a
 * register: `{diamond, key, headline, detail, needs, expires, state, at}`, `state` one of `up`, `clear` and
 * `dismissed`, `at` stamped by `DaimondStamp.next` over the stamp it replaces. The merge keeps,
 * per item, the later stamp -- so a clear always beats an older raise, and a person's dismiss
 * on one device is not undone by another device's older raise. At an equal stamp the taken-down
 * states outrank `up`: a tie is the one place two devices could disagree for ever, and the safe
 * side of an alert is the side that stops nagging.
 *
 * A TAKEN-DOWN ITEM IS KEPT, as a tombstone, for the reason every tombstone is kept: an absent
 * item is "nothing to say", and a device that still held the raise would put it back. Kept
 * bounded (`TOMB_MAX_MS`, `ITEM_MAX`): tombstones are shed first, and a live item only when live
 * items alone pass the cap, which a parcel from a peer -- or an older build -- could carry.
 *
 * NO UP ITEM OUTLIVES ITS TOMBSTONE (review AP-2). A shed tombstone is a device that forgot, and a
 * stale device still holding the raise would put it back on every panel. Two rules keep it out:
 *   - by age: an `up` item whose stamp is older than `TOMB_MAX_MS` has lapsed, everywhere, by the
 *     same rule that sheds a tombstone of that age -- and a tombstone is always younger than the
 *     raise it took down. A condition that persists keeps its alert: the daimon raising the same
 *     words again after `RESTAMP_MS` re-stamps it.
 *   - by count: shedding a tombstone past the cap raises the map's `floor` to that tombstone's
 *     stamp, and the floor rides the parcel; an `up` item stamped at or under it has lapsed. An
 *     alert still up on the device that sheds is kept over the floor by `seen`, a keep-alive the
 *     merge honours for the floor only: it never wins against a take-down, so a stale device's
 *     clear still beats the copy the cap kept.
 *
 * LIVE ALERTS ARE BOUNDED AT THE DOOR TOO (review AP-1, 16 Oct 2026). A daimon that named a new
 * key for every message and never cleared one grew the section, and the sync parcel with it,
 * without limit, until the parcel met the gateway's door and sync failed for the whole account.
 * One Diamond holds at most `LIVE_MAX` live alerts; a NEW key past that is refused with the
 * reason, so the model updates or clears one instead. A key already up may always be updated.
 *
 * THE PAGE'S OWN ALERTS STAND OUTSIDE THAT LIMIT (review R569 R5). `turn-failed` is raised by the
 * page when a background turn fails (daimond.js `judgeTriggeredTurn`), `mail-note` holds the words
 * a mail turn wrote, which never reach its chat (`quietTurnEnd`), and a Diamond whose daimon
 * had filled its twenty would otherwise lose that failure without trace. A page key is reserved:
 * the model may neither raise nor clear one, so its cap is its own, one item per key per Diamond.
 *
 * ONE PLACE FOR EVERY ALERT (owner ruling, D-20261016-17 rulings section 16: "require the user to
 * look in only a single place for system alerts, the Pending panel"). Each alert says whether it
 * `needs` the person. `needs: true` counts on the Pending badge and stays until cleared or
 * dismissed. `needs: false` shows quietly, counts on nothing, and lapses 24 hours after it was
 * raised: the lapse is `expires`, a wall-clock time held IN the synced item, so every device
 * drops it at the same moment rather than each from when it happened to hear of it.
 *
 * THE RUNNER'S UPDATE IS ONE OF THE PAGE'S OWN (lead ruling L3, KS-P release port). A runner on
 * this machine that built a new version of itself waits for his passkey on the approve page;
 * `runnerSettle` in daimond.js raises that request here, under `RUNNER` and the page keys
 * `runner.<nonce>.<seq>.<commit>` (the tile) and `runner-alarm.<nonce>` (a witness alarm), both
 * `needs: true`, so it reaches every device he has -- his phone above all. It is the one writer.
 *
 * A DISMISS IS NOT A CLEAR. The person took it down; the condition may well still hold, and the
 * daimon -- which runs again on its next trigger -- will raise it again. Raised again with the
 * SAME words, it stays down (`raise` answers `dismissed`, and the model is told so): the person
 * has read exactly that. Raised with different words, something changed, and it comes back up.
 *
 * Loaded after stamp.js and store.js and before daimond.js; see index.html.
 */
(function () {
	'use strict';

	var REC_KEY      = 'daimond-alerts';
	var KEY_MAX      = 64;				// as src/tools.rs PENDING_KEY_MAX
	var HEADLINE_MAX = 120;				// PENDING_HEADLINE_MAX
	var DETAIL_MAX   = 600;				// PENDING_DETAIL_MAX
	var ITEM_MAX     = 200;				// live and tombstoned, all Diamonds together
	var LIVE_MAX     = 20;				// live alerts one Diamond may hold (src/tools.rs PENDING_LIVE_MAX)
	var TOMB_MAX_MS  = 30 * 24 * 3600 * 1000;	// a taken-down item is remembered a month; an up one lives as long
	var RESTAMP_MS   = 7 * 24 * 3600 * 1000;	// an alert raised again in the same words after this is re-stamped
	var STATES       = { up: 0, clear: 1, dismissed: 2 };
	var KEY_RE       = /^[A-Za-z0-9._-]+$/;
	var QUIET_MS     = 24 * 3600 * 1000;		// a needs:false alert lapses a day after it is raised
	var PAGE_KEYS    = { 'turn-failed': 1, 'mail-note': 1, 'runner': 1, 'runner-alarm': 1 };	// the page's own: outside LIVE_MAX, never the model's
	// The runner's own items (daimond.js `runnerSettle`, KS-p4) are held under this name in
	// place of a Diamond's id: a runner update is the machine's, not any Diamond's. No Diamond id
	// starts with `@`, so no Diamond's alert can sit under it.
	var RUNNER       = '@runner';

	function ms(v) { var n = Number(v); return (isFinite(n) && n > 0) ? Math.floor(n) : 0; }
	function now() { return Date.now(); }
	function store() { return window.DaimondStore || null; }
	function chars(s) { return Array.from(s).length; }
	function nsKey(diamond, key) { return String(diamond) + ':' + String(key); }

	/// One item, checked, or null. Anything another build wrote may arrive here, so nothing is
	/// trusted: a field out of bounds makes the item unreadable rather than clipped, because a
	/// clipped fix is a fix with its last step missing.
	function clean(it) {
		if (!it || typeof it !== 'object') return null;
		var d = typeof it.diamond === 'string' ? it.diamond : '';
		var k = typeof it.key === 'string' ? it.key : '';
		var h = typeof it.headline === 'string' ? it.headline : '';
		var x = typeof it.detail === 'string' ? it.detail : '';
		if (!d || d.indexOf(':') >= 0 || !k || k.length > KEY_MAX || !KEY_RE.test(k)) return null;
		// In characters (code points), as src/tools.rs counts them with `chars()`: a headline the
		// engine passed must not be refused here for being emoji (review AP-5).
		if (chars(h) > HEADLINE_MAX || chars(x) > DETAIL_MAX) return null;
		if (!Object.prototype.hasOwnProperty.call(STATES, it.state) || !ms(it.at)) return null;
		if (it.state === 'up' && !h) return null;
		// Absent `needs` reads as true: the side of a doubt that is seen is the safe one.
		var n = it.needs !== false;
		return { diamond: d, key: k, headline: h, detail: x, needs: n, expires: n ? 0 : ms(it.expires),
			state: it.state, at: ms(it.at), seen: ms(it.seen) };
	}

	/// How recent an item is known to be, for the horizon and the floor: its stamp, or the
	/// keep-alive a shedding device gave it. Never used to pick a winner.
	function age(it) { return Math.max(it.at, it.seen || 0); }

	/// Is this item on the panel now? Up, and not past its lapse.
	function isLive(it, t) {
		return it.state === 'up' && !(it.expires && (t === undefined ? now() : t) >= it.expires);
	}

	/// The tie-break: taken-down beats up, then the canonical form, the same on every device.
	function rank(it) { return STATES[it.state] + ':' + JSON.stringify([it.diamond, it.key, it.headline, it.detail, it.needs, it.expires]); }

	/// Does `b` beat `a`, for one item?
	function wins(b, a) {
		if (!b) return false;
		if (!a) return true;
		var S = window.DaimondStamp;
		if (S) return S.beats(b.at, b, a.at, a, rank);
		return b.at !== a.at ? b.at > a.at : rank(b) > rank(a);
	}

	/// Two maps into one: per item, the winner. Pure, and the law the store retries an owed
	/// write by, so a write refused under a full box is merged over what landed meanwhile.
	function merge(a, b) {
		var out = {}, floor = 0;
		[a, b].forEach(function (m) {
			if (!m || typeof m !== 'object') return;
			floor = Math.max(floor, ms(m.floor));
			var items = m.items && typeof m.items === 'object' ? m.items : {};
			Object.keys(items).forEach(function (id) {
				var it = clean(items[id]);
				if (!it || id !== nsKey(it.diamond, it.key)) return;
				var held = out[id];
				if (wins(it, held)) out[id] = it;
				else if (held && !wins(held, it)) held.seen = Math.max(held.seen, it.seen);	// one item, two keep-alives
			});
		});
		var t = now();
		Object.keys(out).forEach(function (id) {
			if (out[id].state === 'up' && age(out[id]) <= floor) delete out[id];
		});
		return shed({ items: out, floor: floor }, t);
	}

	/// Bounded at `ITEM_MAX`, live and taken-down together: tombstones older than a month go,
	/// then the oldest tombstones past the cap, and then -- only when live items alone pass it --
	/// the oldest live ones. The door (`raise`) keeps one Diamond to `LIVE_MAX`, so that last
	/// step is for a parcel from a peer, which nothing else bounds.
	///
	/// Takes and answers the whole record, `{items, floor}`: a tombstone shed by count raises the
	/// floor to its stamp, and every item still live here is kept over it by `seen`.
	function shed(rec, t) {
		var items = rec.items, floor = ms(rec.floor);
		if (t === undefined) t = now();
		var ids = Object.keys(items);
		ids.forEach(function (id) {
			if (t - age(items[id]) > TOMB_MAX_MS) delete items[id];	// up or down: past the horizon
		});
		ids = Object.keys(items);
		if (ids.length <= ITEM_MAX) return { items: items, floor: floor };
		function oldest(x, y) { return items[x].at - items[y].at || (x < y ? -1 : 1); }
		var drop = ids.filter(function (id) { return !isLive(items[id], t); }).sort(oldest);
		drop = drop.concat(ids.filter(function (id) { return isLive(items[id], t); }).sort(oldest));
		drop.slice(0, ids.length - ITEM_MAX).forEach(function (id) {
			if (items[id].state !== 'up') floor = Math.max(floor, items[id].at);
			delete items[id];
		});
		Object.keys(items).forEach(function (id) {
			if (items[id].state === 'up' && age(items[id]) <= floor) items[id].seen = Math.max(t, floor + 1);
		});
		return { items: items, floor: floor };
	}

	/// Is `key` one of the page's own, which the model may not touch and `LIVE_MAX` does not count?
	// A page key, or a page key's per-device form `<key>.<device>` (see `note`).
	function pageKey(key) {
		var k = String(key || ''), dot = k.indexOf('.');
		return Object.prototype.hasOwnProperty.call(PAGE_KEYS, dot > 0 ? k.slice(0, dot) : k);
	}

	/// Does `diamond` already hold `LIVE_MAX` live alerts of its daimon's?
	function full(diamond) {
		var items = read().items, t = now(), n = 0;
		Object.keys(items).forEach(function (id) {
			if (items[id].diamond === diamond && !pageKey(items[id].key) && isLive(items[id], t)) n++;
		});
		return n >= LIVE_MAX;
	}

	function read() {
		var r = null;
		try { r = store() ? store().get(REC_KEY, null) : JSON.parse(window.localStorage.getItem(REC_KEY) || 'null'); }
		catch (e) { r = null; }
		return merge(r, null);
	}

	function write(rec, merged) {
		var S = store();
		if (S) return merged ? S.putMerged(REC_KEY, rec, merge) : S.put(REC_KEY, rec, merge);
		try { window.localStorage.setItem(REC_KEY, JSON.stringify(rec)); } catch (e) { /* refused */ }
		return true;
	}

	function tell() {
		try { if (window.DaimondSync && window.DaimondSync.nudge) window.DaimondSync.nudge(); } catch (e) { /* next round */ }
	}
	function changed() {
		try { window.dispatchEvent(new CustomEvent('daimond:alerts')); }
		catch (e) { /* no window to tell */ }
	}

	/// Set one item by a local act, stamped past the one it replaces.
	function set(id, next) {
		var rec = read(), prev = rec.items[id];
		var S = window.DaimondStamp;
		next.at = S ? S.next(prev && prev.at) : Math.max(now(), (prev ? prev.at : 0) + 1);
		next.seen = 0;
		rec.items[id] = next;
		write(shed(rec), false);
		changed();
		tell();
	}

	/// Raise one alert of `diamond`'s, or update it in place. Answers what happened:
	/// `new`, `updated`, `same` (already up in these words: nothing written), `dismissed`
	/// (the person took down these very words: it stays down) or `full` (a new key, and the
	/// Diamond already holds `LIVE_MAX` live alerts: nothing written). Null for an argument out of
	/// bounds -- the engine has checked them already, so that is a caller that did not.
	/// `needs` false makes it quiet: off the badge, and lapsing `QUIET_MS` from now.
	function raise(diamond, key, headline, detail, needs) {
		if (typeof needs !== 'boolean') return null;
		var next = clean({ diamond: String(diamond || ''), key: String(key || ''), headline: String(headline || '').trim(),
			detail: String(detail || '').trim(), needs: needs, expires: needs ? 0 : now() + QUIET_MS, state: 'up', at: 1 });
		if (!next) return null;
		var id = nsKey(next.diamond, next.key), prev = read().items[id];
		var up = prev && isLive(prev);
		var same = prev && prev.headline === next.headline && prev.detail === next.detail && prev.needs === next.needs;
		if (up && same && now() - prev.at < RESTAMP_MS) return 'same';
		if (up && same) { set(id, next); return 'same'; }		// still so, a week on: re-stamped, so it does not lapse
		if (prev && prev.state === 'dismissed' && same) return 'dismissed';
		if (!up && !pageKey(next.key) && full(next.diamond)) return 'full';
		set(id, next);
		return up ? 'updated' : 'new';
	}

	/// Add `text` to the page's quiet note `key` of `diamond`'s, under `headline`, rather than
	/// replacing it (check B3): a finding written as prose survives the next talkative turn. The
	/// words still up are kept ahead of the new ones, a blank line between, and past `DETAIL_MAX`
	/// characters the oldest are dropped first, so the newest always shows. A note taken down or
	/// lapsed starts afresh. Answers as `raise` does; null for a key that is not the page's.
	///
	/// ONE NOTE PER DEVICE (QA r569qa1 #2). The note is held under `<key>.<device>`: a register
	/// per key, so two devices appending to one note before either synced lost the earlier
	/// device's words to the later stamp. Each device appends only to its own. Bounded at
	/// `NOTE_DEVICES` live notes per Diamond and key: past that, the oldest other device's note
	/// is taken down, stamped, as a clear.
	function note(diamond, key, headline, text) {
		var base = String(key || '');
		if (!pageKey(base) || base.indexOf('.') >= 0) return null;
		var add = String(text || '').trim();
		if (!add) return null;
		var NOTE_DEVICES = 4;
		var dmd = String(diamond || ''), mine = base + '.' + noteDevice();
		var items = read().items, prev = items[nsKey(dmd, mine)];
		var held = (prev && isLive(prev)) ? prev.detail : '';
		var cps = Array.from(held ? held + '\n\n' + add : add);
		if (cps.length > DETAIL_MAX) cps = ['\u2026'].concat(cps.slice(cps.length - DETAIL_MAX + 1));
		var others = Object.keys(items).filter(function (id) {
			var it = items[id];
			return it.diamond === dmd && it.key !== mine && it.key.indexOf(base + '.') === 0 && isLive(it);
		}).sort(function (x, y) { return items[x].at - items[y].at || (x < y ? -1 : 1); });
		others.slice(0, Math.max(0, others.length - (NOTE_DEVICES - 1))).forEach(function (id) {
			clear(dmd, items[id].key);
		});
		return raise(dmd, mine, headline, cps.join(''), false);
	}

	// This device's part of a note key: the identity's device id (updater.js `selfId`), or,
	// with none, a random one kept on this device. Cut to what a key may hold.
	function noteDevice() {
		var id = '';
		try { id = String((window.DaimondIdentity && DaimondIdentity.deviceId && DaimondIdentity.deviceId()) || ''); }
		catch (e) { id = ''; }
		if (!id) { try { id = String(localStorage.getItem('daimond-id-device') || ''); } catch (e) { id = ''; } }
		if (!id) {
			try {
				id = String(localStorage.getItem('daimond-alerts-device') || '');
				if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('daimond-alerts-device', id); }
			} catch (e) { id = 'here'; }
		}
		return id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16) || 'here';
	}

	/// Take one alert of `diamond`'s down because the condition is over. True if one was up.
	function clear(diamond, key) {
		var id = nsKey(diamond, key), prev = read().items[id];
		if (!prev || prev.state !== 'up') return false;
		var was = isLive(prev);
		set(id, { diamond: prev.diamond, key: prev.key, headline: prev.headline, detail: prev.detail,
			needs: prev.needs, expires: prev.expires, state: 'clear' });
		return was;
	}

	/// The person took it down. By its namespaced id, which is what a tile holds.
	function dismiss(id) {
		var prev = read().items[id];
		if (!prev || !isLive(prev)) return false;
		set(id, { diamond: prev.diamond, key: prev.key, headline: prev.headline, detail: prev.detail,
			needs: prev.needs, expires: prev.expires, state: 'dismissed' });
		return true;
	}

	/// The items that are up, oldest first: what the Pending panel draws.
	/// Also arms one timer for the next lapse, so a quiet alert leaves the panel on time with
	/// nobody touching it.
	function live() {
		var items = read().items, t = now(), soon = 0;
		var out = Object.keys(items).filter(function (id) { return isLive(items[id], t); })
			.map(function (id) {
				var it = items[id];
				if (it.expires && (!soon || it.expires < soon)) soon = it.expires;
				return { id: id, diamond: it.diamond, key: it.key, headline: it.headline, detail: it.detail,
					needs: it.needs, expires: it.expires, at: it.at };
			})
			.sort(function (a, b) { return a.at - b.at || (a.id < b.id ? -1 : 1); });
		arm(soon, t);
		return out;
	}

	/// The badge's number: live alerts that need the person. A quiet one is seen, not counted.
	function count() {
		return live().filter(function (a) { return a.needs; }).length;
	}

	var timer = null, timerAt = 0;
	function arm(at, t) {
		if (!at || at === timerAt || typeof setTimeout !== 'function') return;
		if (timer) clearTimeout(timer);
		timerAt = at;
		// Capped, so a sleeping laptop's clock jump is caught within the hour.
		timer = setTimeout(function () { timer = null; timerAt = 0; changed(); }, Math.min(Math.max(at - t, 0) + 50, 3600 * 1000));
	}

	/// What this device's parcel carries: the whole map, tombstones and all.
	function syncSnapshot() { return read(); }

	/// A peer's map lands: merged per item over what is held, written under the store's
	/// merge law (so a write that lands meanwhile is merged rather than lost), and the
	/// panel told only when something changed. Answers whether it did.
	function adoptSync(remote) {
		if (!remote || typeof remote !== 'object') return false;
		var have = read(), next = merge(have, remote);
		if (JSON.stringify(next) === JSON.stringify(have)) return false;
		write(next, true);
		changed();
		return true;
	}

	// ANOTHER TAB'S WRITE: the panel in this tab redraws as it lands.
	if (typeof window.addEventListener === 'function') {
		window.addEventListener('storage', function (e) {
			var pre = '';
			try { if (window.DaimondAccounts) pre = DaimondAccounts.prefix() || ''; } catch (err) { /* the raw key */ }
			if (e && (e.key === null || e.key === pre + REC_KEY)) changed();
		});
	}

	window.DaimondAlerts = {
		raise:   raise,
		note:    note,		// the page's quiet notes, appended (mail-note)
		clear:   clear,
		dismiss: dismiss,
		live:    live,
		count:   count,
		merge:   merge,		// pure, for the tests and the store's law
		syncSnapshot: syncSnapshot,	// collectSync
		adoptSync:    adoptSync,	// applySync
		KEY:     REC_KEY,
		RUNNER:  RUNNER,	// the runner's items, raised by daimond.js `runnerSettle` only
	};

	/// The engine's door (src/wasm/pending.rs). `diamond` is the turn's own Diamond, passed by the
	/// engine and never by the model; `payload` is the checked JSON `pending_step` composed. Each
	/// answers JSON text, `ok` false with a `reason` when nothing was done.
	function parse(payload) {
		try { var p = JSON.parse(payload); return (p && typeof p === 'object') ? p : null; }
		catch (e) { return null; }
	}
	window.DaimondPendingTool = {
		raise: function (diamond, payload) {
			var p = parse(payload);
			if (!diamond || !p) return JSON.stringify({ ok: false, reason: 'the call could not be read' });
			if (typeof p.needs !== 'boolean') return JSON.stringify({ ok: false, reason: "'needs' must be true or false" });
			if (pageKey(p.key)) return JSON.stringify({ ok: false, reason: "the key '" + p.key + "' is the app's own; choose another" });
			var was = raise(diamond, p.key, p.headline, p.detail, p.needs);
			if (!was) return JSON.stringify({ ok: false, reason: 'the key, headline or detail is out of bounds' });
			if (was === 'full') return JSON.stringify({ ok: false, full: true, max: LIVE_MAX, reason: 'this Diamond already has ' +
				LIVE_MAX + ' alerts up on the Pending panel; update one of them (raise its key again) or clear one with pending_clear before raising a new key' });
			return JSON.stringify({ ok: true, was: was === 'same' ? 'updated' : was });
		},
		clear: function (diamond, payload) {
			var p = parse(payload);
			if (!diamond || !p || typeof p.key !== 'string') return JSON.stringify({ ok: false, reason: 'the call could not be read' });
			if (pageKey(p.key)) return JSON.stringify({ ok: false, reason: "the key '" + p.key + "' is the app's own; the app takes it down" });
			return JSON.stringify({ ok: true, cleared: clear(diamond, p.key) });
		},
	};
})();
