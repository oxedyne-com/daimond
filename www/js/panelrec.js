/* panelrec.js — what each conversation's panels held, kept on this device.
 *
 * UNBLOCK-14 (D-20261015-17): *"panel state is not kept when switching between
 * daimons and chats"*. Three things each owned a piece of it and none owned the
 * whole: the layout (one per device, so per nobody), the viewer's `deferred`
 * (a show made off screen, TAKEN on arrival and so gone after the first visit),
 * and `followConversation` (which closed the panels on a switch and remembered
 * nothing). A Diamond could also carry a "saved arrangement", by hand only, and
 * only its layout, never what the panels held.
 *
 * Now there is one owner: a RECORD PER CONVERSATION KEY (`convKey()`: a Diamond's
 * id or `chat:<id>`), written when the person leaves the conversation and put
 * back when they arrive. It holds
 *
 *   layout  which panels are open and where (open, stage, dock, widths, seats, grid)
 *   doc     the Doc panel's file, its door (`store`), and its aim (page, scroll)
 *   preview the Preview panel's file, its door and its page
 *   web     the Web panel's address
 *   shows   files a turn asked to show while the conversation was off screen
 *
 * The Terminal is a panel of the layout like any other: its session is fenced to
 * one Diamond and so is never carried, but whether it is open is.
 *
 * A show made off screen is WRITTEN INTO THE RECORD, not taken once. Arriving
 * opens it; leaving again records it as what the panel holds, so it survives
 * every later round trip until the person closes the panel themselves.
 *
 * LOCAL. Never synced and never paired: what is open on this desk is this desk's
 * (D-20261006-27, a turn's panels open on the asking device). The key is not one
 * of `accounts.js`'s GLOBAL keys, so the account shim gives each account its own;
 * it is not one of `pairing.js`'s LOOK_KEYS, so a paired device never receives it.
 *
 * BOUND: one record per conversation, at most MAX_RECS of them (the least
 * recently left goes first), each at most MAX_REC bytes serialised (its oldest
 * shows, then its least needed fields, shed to fit), and so the whole at most
 * MAX_RECS × MAX_REC = 800 KiB. SHED: dropped with the conversation's deletion
 * (`drop`), and by the cap for a conversation deleted where this device never saw
 * it go.
 *
 * Pure: the storage is handed in, so `panelrec.test.mjs` proves it under node.
 */
(function () {
	'use strict';

	var KEY = 'daimond-panel-recs';
	/// How many conversations keep a record. A record is a few hundred bytes, so
	/// this holds the whole under a hundred KiB in use, and at most 800 KiB at
	/// MAX_REC each.
	var MAX_RECS = 200;
	/// A path or address longer than this many UTF-8 bytes is not one a panel was showing.
	var MAX_STR = 2048;
	/// One record's serialised JSON, in UTF-8 bytes, at most.
	var MAX_REC = 4096;
	/// A layout's serialised JSON, in UTF-8 bytes, at most: the seats table is the
	/// part that grows, and it goes first.
	var MAX_LAYOUT = 2048;
	/// How many off-screen shows one conversation holds: a turn shows a source
	/// and its rendering, rarely more, and the newest are the ones that matter.
	var MAX_SHOWS = 4;

	/// The UTF-8 length of `s`, counted without an encoder so this stays pure.
	function bytes(s) {
		var n = 0;
		for (var i = 0; i < s.length; i++) {
			var c = s.charCodeAt(i);
			if (c < 0x80) n += 1;
			else if (c < 0x800) n += 2;
			else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
			else n += 3;
		}
		return n;
	}
	function size(v) { try { return bytes(JSON.stringify(v)); } catch (e) { return Infinity; } }

	function str(s) { return (typeof s === 'string' && s && bytes(s) <= MAX_STR) ? s : ''; }
	function num(n) { n = Math.floor(Number(n) || 0); return n > 0 ? n : 0; }

	/// A file entry as kept: a path, its door, its page and its scroll, or null.
	function fileEntry(f) {
		if (!f || !str(f.path)) return null;
		var out = { path: f.path };
		if (f.store) out.store = true;
		if (num(f.page)) out.page = num(f.page);
		if (num(f.top)) out.top = num(f.top);
		return out;
	}

	/// A layout as kept: the shape `DaimondPanels.snapshot` answers, copied so a
	/// later change to the live layout cannot reach into the record.
	function layoutEntry(l) {
		if (!l || typeof l !== 'object' || !l.open || typeof l.open !== 'object') return null;
		var out = null;
		try { out = JSON.parse(JSON.stringify(l)); } catch (e) { return null; }
		if (size(out) <= MAX_LAYOUT) return out;
		delete out.seats;     // shares are a refinement; which panels are open is the layout
		return size(out) <= MAX_LAYOUT ? out : null;
	}

	/// `r` cut to MAX_REC: the oldest shows first, then what is cheapest to lose.
	function fit(r) {
		while (r.shows && r.shows.length && size(r) > MAX_REC) {
			r.shows.shift();
			if (!r.shows.length) delete r.shows;
		}
		['web', 'preview', 'doc', 'layout'].forEach(function (k) {
			if (size(r) > MAX_REC) delete r[k];
		});
		return r;
	}

	/// A record as kept, from anything: unknown fields are dropped, bad ones nulled.
	function clean(r) {
		r = r || {};
		var out = { at: num(r.at) };
		var l = layoutEntry(r.layout);   if (l) out.layout = l;
		var d = fileEntry(r.doc);        if (d) out.doc = d;
		var p = fileEntry(r.preview);    if (p) out.preview = p;
		if (r.web && str(r.web.url)) out.web = { url: r.web.url };
		var sh = (Array.isArray(r.shows) ? r.shows : []).map(fileEntry).filter(Boolean);
		if (sh.length) out.shows = sh.slice(-MAX_SHOWS);
		return fit(out);
	}

	/// How arriving puts `rec` back: the layout to restore, and `filled`, the panels
	/// the arrival fills itself (so their open hooks are not run). A panel the
	/// layout names open but the record holds nothing for is closed instead, so no
	/// panel reopens empty: a blob or guide page was never recorded, for one. The
	/// Doc stays as the layout has it, because its own open hook starts its note.
	function arrival(rec) {
		if (!rec || !rec.layout || !rec.layout.open) return null;
		var layout = layoutEntry(rec.layout);
		if (!layout) return null;
		var shows = Array.isArray(rec.shows) && rec.shows.length > 0;
		var filled = [];
		if (rec.doc || shows) filled.push('doc');
		if (rec.preview) filled.push('preview'); else layout.open.preview = false;
		if (rec.web) filled.push('web'); else layout.open.web = false;
		return { layout: layout, filled: filled };
	}

	/// The record store over `storage` (anything with getItem and setItem).
	///
	/// # Arguments
	/// * `storage` - Where the records live. The page passes `localStorage`, which
	///   the account shim namespaces; a test passes a map.
	/// * `now` - The clock, for the order the cap sheds in.
	function make(storage, now) {
		var clock = (typeof now === 'function') ? now : function () { return Date.now(); };
		var last = 0;
		function stamp() { var t = clock(); last = t > last ? t : last + 1; return last; }

		function readAll() {
			var raw = null;
			try { raw = storage.getItem(KEY); } catch (e) { raw = null; }
			if (!raw) return {};
			try {
				var v = JSON.parse(raw);
				return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
			} catch (e) { return {}; }
		}

		function writeAll(all) {
			var keys = Object.keys(all);
			if (keys.length > MAX_RECS) {
				keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
				keys.slice(0, keys.length - MAX_RECS).forEach(function (k) { delete all[k]; });
			}
			try { storage.setItem(KEY, JSON.stringify(all)); return true; }
			catch (e) { return false; }   // a full store loses a nicety, never the page
		}

		/// The record for `key`, or null.
		function get(key) {
			if (!key) return null;
			var all = readAll();
			return all[key] ? clean(all[key]) : null;
		}

		/// Keep `rec` as `key`'s whole record: what the panels hold NOW replaces what
		/// they held, shows included, because a show already opened is now held.
		function put(key, rec) {
			if (!key) return false;
			var all = readAll();
			var r = clean(rec);
			r.at = stamp();
			all[key] = fit(r);
			return writeAll(all);
		}

		/// Write a show `key` asked for while off screen into its record.
		///
		/// # Arguments
		/// * `kind` - `'file'` for a file show (`{ path, page }`), `'web'` for an
		///   address (`{ url }`).
		function fold(key, kind, val) {
			if (!key || !val) return false;
			var all = readAll();
			var r = clean(all[key]);
			if (kind === 'web') {
				if (!str(val.url)) return false;
				r.web = { url: val.url };
				if (r.layout) r.layout.open.web = true;
			} else {
				var f = fileEntry(val);
				if (!f) return false;
				r.shows = (r.shows || []).filter(function (s) { return s.path !== f.path; });
				r.shows.push(f);
				r.shows = r.shows.slice(-MAX_SHOWS);
			}
			r.at = stamp();
			all[key] = fit(r);
			return writeAll(all);
		}

		/// Forget `key`'s record: its conversation has been deleted.
		function drop(key) {
			if (!key) return false;
			var all = readAll();
			if (!all[key]) return false;
			delete all[key];
			return writeAll(all);
		}

		function keys() { return Object.keys(readAll()); }

		return { get: get, put: put, fold: fold, drop: drop, keys: keys };
	}

	var api = { make: make, arrival: arrival, KEY: KEY, MAX_RECS: MAX_RECS, MAX_SHOWS: MAX_SHOWS,
		MAX_REC: MAX_REC, MAX_LAYOUT: MAX_LAYOUT, bytes: bytes };
	var ls = null;
	try { ls = window.localStorage || null; } catch (e) { ls = null; }
	if (ls) {
		var live = make(ls);
		Object.keys(live).forEach(function (k) { api[k] = live[k]; });
	}
	window.DaimondPanelRec = api;
})();
