/* ============================================================
   Daimond — the marks pressed on this device (DaimondMarksHere)
   ------------------------------------------------------------
   A mark is a row in a Diamond's link sidecar, or a holding on a
   chat record, and both travel whole in the sync parcel. Until R2
   (2026-09-24) a row that said `by:"user"` and named this device was
   a grant here, so anything that could write those bytes -- another
   device on an older bundle, a replayed export, a forged parcel --
   could write a grant. The account's key cannot tell devices apart,
   since pairing copies it to every browser, and a MAC in the row is
   replayed with the row. So the grant is split in two:

     THE GRANT HERE IS THE INTERSECTION OF THE SYNCED ROW AND THIS
     DEVICE'S OWN RECORD OF WHAT WAS PRESSED ON IT.

   The record is one localStorage entry per account, never synced, and
   written only by a person's press here. A removal or a narrowing of a
   row travels from any device and is applied to the record when the
   copy carrying it arrives (`settle`); a widening never travels, so a
   row that arrives shared, or `holds` where it was `consulted`, gains
   nothing here until it is pressed here. The design is
   `specs/daimond_signed_marks_design_20260923.md`.

   The storage discipline is pause.js's since D2: no copy in memory,
   every change a read-modify-write in one synchronous block that is
   read back, and another tab's write heard through `storage`. The
   record is read and written only while the identity is unlocked,
   because an unlock proves the storage area has loaded; a cold iOS
   tab can read it empty before then.

   Attaches `window.DaimondMarksHere`, and exports the same for Node.
   ============================================================ */
(function () {
	'use strict';

	var KEY = 'daimond-marks-here';	// per account, by accounts.js; never synced

	// ── Sharing: owner decision O2 ─────────────────────────────
	//
	// Is a share counted here only where ⇄ was pressed on this device as well?
	// Yes, as recommended: sharing lets other devices change and delete files on
	// this disk, and a share that travelled would let an older copy of a Diamond,
	// from before sharing was turned off, turn it back on here. Turning it off
	// anywhere still turns it off everywhere, because a row that arrives unshared
	// narrows the entry (`narrow`). Should the owner rule the other way, this one
	// line is the edit.
	var SHARE_NEEDS_PRESS_HERE = true;

	// ── Pure core ──────────────────────────────────────────────
	// No DOM, no storage. A record is
	//   { v: 1, d: { <diamond>: [ { id, to, rel, share, root } ] },
	//           c: { <chat>:    [ { ref, path, ws, read, root } ] } }

	/// The devices a machine reference was made on, after the folder's name:
	/// `usr@<id>` or `usr@<id>,<id>`. Hex ids only, so a folder whose own name
	/// has an `@` in it keeps it.
	var REF_DEVICES_RE = /@((?:[0-9a-f]{16}|[0-9a-f]{32})(?:,(?:[0-9a-f]{16}|[0-9a-f]{32}))*)$/;

	/// Split a reference into its kind, its workspace, and its path -- and, for a
	/// machine reference, the folder's name and the devices it was made on. A
	/// reference written before roots were recorded comes back with `root: null`.
	/// The one parse of a reference; daimond.js calls this one.
	function parseRef(ref) {
		var s = String(ref || '');
		var i = s.indexOf(':');
		if (i <= 0) return { kind: '', root: null, name: '', devices: [], path: '' };
		var kind = s.slice(0, i), rest = s.slice(i + 1);
		var m = /^\[(browser|machine)(?::([^\]]*))?\]/.exec(rest);
		if (!m) return { kind: kind, root: null, name: '', devices: [], path: rest.trim() };
		var name = m[2] || '', devices = [];
		var d = REF_DEVICES_RE.exec(name);
		if (d) {
			devices = d[1].split(',');
			name = name.slice(0, d.index);
		}
		return { kind: kind, root: m[1], name: name, devices: devices, path: rest.slice(m[0].length).trim() };
	}

	/// The workspace as the record names it: `browser`, or `machine:<folder name>`.
	function rootKey(r) {
		return (r && r.kind === 'machine') ? 'machine:' + String(r.name || '') : 'browser';
	}

	function rootOf(key) {
		var s = String(key || '');
		return s.indexOf('machine:') === 0 ? { kind: 'machine', name: s.slice(8) } : { kind: 'browser', name: '' };
	}

	/// Can a reference be opened from the workspace named by `key`? The same root
	/// kind, and for a machine folder the same name where the reference carries
	/// one. A reference from before roots were recorded fits either. Whether it is
	/// IN FORCE there is `force`'s question, not this one's.
	function fits(ref, key) {
		var p = parseRef(ref), r = rootOf(key);
		if (p.kind !== 'file' && p.kind !== 'dir') return false;
		if (!p.root) return true;
		if (p.root !== r.kind) return false;
		return p.root !== 'machine' || !p.name || p.name === r.name;
	}

	function str(v) { return typeof v === 'string' ? v : ''; }

	/// A reference as the store spells it -- `Node::parse`, then `to_ref` -- or
	/// null where the store would not read one.
	function canonRef(s) {
		var t = str(s).trim(), i = t.indexOf(':');
		if (i <= 0 || i === t.length - 1) return null;
		var kind = t.slice(0, i);
		if (!/^[A-Za-z0-9_-]+$/.test(kind)) return null;
		return kind.toLowerCase() + ':' + t.slice(i + 1);
	}

	/// A relation as the store holds it (`normalise_rel`).
	function normRel(rel) {
		var s = str(rel).split(/\s+/).filter(Boolean).map(function (w) { return w.toLowerCase(); }).join(' ');
		return Array.from(s).slice(0, 32).join('');
	}

	/// One sidecar line as `Link::from_json` reads it, or null where it reads no
	/// link: a line without `from` or `to` is none, and a user's row whose note is
	/// the word `share` and that has no `share` of its own reads as shared.
	function parseRow(line) {
		var j = null;
		try { j = JSON.parse(line); } catch (e) { return null; }
		if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
		var from = canonRef(j.from), to = canonRef(j.to);
		if (!from || !to) return null;
		var by = str(j.by);
		var share = (typeof j.share === 'boolean') ? j.share : (by === 'user' && str(j.note) === 'share');
		return { id: str(j.id), from: from, to: to, rel: normRel(j.rel), by: by, share: share };
	}

	/// Every link in a sidecar's text. `facet:` reads as `diamond:`, as the
	/// store's own read rewrites it.
	function parseSidecar(text) {
		return str(text).replace(/"facet:/g, '"diamond:').split('\n')
			.map(function (l) { return l.trim(); })
			.filter(Boolean)
			.map(parseRow)
			.filter(Boolean);
	}

	/// Is this row a mark at all: `holds` or `consulted`, on a file or a folder,
	/// and the user's or from before rows said who wrote them? A row a model or a
	/// fold wrote is a record and never a grant.
	function isMark(row) {
		if (!row) return false;
		var rel = row.rel || '', by = row.by || '';
		if (rel !== 'holds' && rel !== 'consulted') return false;
		if (by !== 'user' && by !== '') return false;
		var kind = parseRef(row.to).kind;
		return kind === 'file' || kind === 'dir';
	}

	/// Is this row stored as `owner`'s own? `links_touching` hands back a row
	/// from ANY sidecar either of whose ends names the Diamond, so a row kept in
	/// another Diamond's sidecar, or with its ends reversed, would otherwise count.
	function ownedBy(owner, row) {
		return !!owner && !!row && row.owner === owner && row.from === 'diamond:' + owner;
	}

	function own(map, k) {
		return (map && Object.prototype.hasOwnProperty.call(map, k) && Array.isArray(map[k])) ? map[k] : null;
	}

	// ── Ids ────────────────────────────────────────────────────
	// The record is keyed by id, and a key the store never mints is refused on the
	// way in and skipped on the way out. A chat id arrives in a parcel unchecked,
	// and one named `constructor` or `__proto__` shadowed an `Object` member, so
	// every read threw (QA 2026-09-24, F6). The maps are prototype-free as well.
	var DIAMOND_ID_RE = /^[0-9a-f]+$/;		// `generate_session_id`: hex time and counter
	var CHAT_ID_RE    = /^c(?:[0-9]+|[0-9a-z]+-[0-9a-z]+-[0-9a-z]*)$/;	// `c` and `newMid`, or an old `c` and count

	function isDiamondId(id) { return typeof id === 'string' && DIAMOND_ID_RE.test(id); }
	function isChatId(id) { return typeof id === 'string' && CHAT_ID_RE.test(id); }

	function isMap(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }

	function empty() { return { v: 1, d: Object.create(null), c: Object.create(null) }; }

	/// A stored record, normalised; null where it does not parse. An entry that
	/// is not well formed is dropped, and so is every entry under a key that is not
	/// an id, which errs towards waiting.
	function readRecord(raw) {
		var j = null;
		try { j = JSON.parse(raw); } catch (e) { return null; }
		if (!isMap(j) || j.v !== 1) return null;
		var rec = empty(), keys, n, k, i, list;
		keys = isMap(j.d) ? Object.keys(j.d) : [];
		for (n = 0; n < keys.length; n++) {
			k = keys[n];
			list = isDiamondId(k) ? (own(j.d, k) || []) : [];
			for (i = 0; i < list.length; i++) {
				var e = list[i];
				if (!e || typeof e.id !== 'string' || typeof e.to !== 'string' || typeof e.root !== 'string') continue;
				if (e.rel !== 'holds' && e.rel !== 'consulted') continue;
				(own(rec.d, k) || (rec.d[k] = [])).push({ id: e.id, to: e.to, rel: e.rel, share: e.share === true, root: e.root });
			}
		}
		keys = isMap(j.c) ? Object.keys(j.c) : [];
		for (n = 0; n < keys.length; n++) {
			k = keys[n];
			list = isChatId(k) ? (own(j.c, k) || []) : [];
			for (i = 0; i < list.length; i++) {
				var c = list[i];
				if (!c || typeof c.ref !== 'string' || typeof c.path !== 'string' || typeof c.root !== 'string') continue;
				if (c.ws !== true && c.read !== true) continue;
				(own(rec.c, k) || (rec.c[k] = [])).push({ ref: c.ref, path: c.path, ws: c.ws === true, read: c.read === true, root: c.root });
			}
		}
		return rec;
	}

	// Is the Diamond's share counted here? See `SHARE_NEEDS_PRESS_HERE`.
	function shareHere(entry, row) {
		return row.share === true && (!SHARE_NEEDS_PRESS_HERE || entry.share === true);
	}

	/// The two default Diamonds' read-only sight of their folders (`grantConsulted`
	/// in daimond.js). Seeded once per account and synced to every device, so a
	/// stored entry would leave them blind on every device but the first; covered
	/// here instead, `consulted` only and never shared, under any root.
	function seeded(owner, row, seeds) {
		var p = parseRef(row.to);
		for (var i = 0; i < (seeds || []).length; i++) {
			if (seeds[i].owner === owner && p.kind === 'dir' && p.path === seeds[i].path) return true;
		}
		return false;
	}

	/// THE TEST OF A DIAMOND'S GRANT HERE. `{ rel, share }` where the row is in
	/// force on this device in the workspace `root`, and null where it is not.
	/// `rel` is `holds` only where both the row and the entry say so; the share
	/// is on only where both do.
	function force(rec, owner, row, root, seeds) {
		if (!isMark(row) || !ownedBy(owner, row) || !fits(row.to, root)) return null;
		var list = (rec && own(rec.d, owner)) || [];
		for (var i = 0; i < list.length; i++) {
			var e = list[i];
			if (e.id !== (row.id || '') || e.to !== row.to || e.root !== root) continue;
			return { rel: (e.rel === 'holds' && row.rel === 'holds') ? 'holds' : 'consulted', share: shareHere(e, row) };
		}
		if (seeded(owner, row, seeds)) return { rel: 'consulted', share: false };
		return null;
	}

	/// Is this row a mark of `owner`'s, not in force here, that one press here
	/// would bring into force? A row whose root is another workspace is neither
	/// in force nor waiting: it lives elsewhere.
	function waiting(rec, owner, row, root, seeds) {
		return isMark(row) && ownedBy(owner, row) && fits(row.to, root) && !force(rec, owner, row, root, seeds);
	}

	/// A chat holding's grant here, `{ ws, read }`, or null. The record's `path`
	/// must be the path inside its `ref`, so a record cannot show one folder and
	/// grant another.
	function chatForce(rec, chatId, a, root) {
		if (!a || typeof a.ref !== 'string' || !a.path || parseRef(a.ref).path !== a.path) return null;
		if (!fits(a.ref, root)) return null;
		var list = (rec && own(rec.c, chatId)) || [];
		for (var i = 0; i < list.length; i++) {
			var e = list[i];
			if (e.ref !== a.ref || e.path !== a.path || e.root !== root) continue;
			var ws = !!a.ws && e.ws, read = a.state === 'read' && e.read;
			return (ws || read) ? { ws: ws, read: read } : null;
		}
		return null;
	}

	/// Does this holding claim a workspace mark or a Read that is not in force
	/// here, on a root that fits?
	function chatWaiting(rec, chatId, a, root) {
		if (!a || typeof a.ref !== 'string' || !a.path || parseRef(a.ref).path !== a.path) return false;
		if (!fits(a.ref, root)) return false;
		var f = chatForce(rec, chatId, a, root) || { ws: false, read: false };
		return (!!a.ws && !f.ws) || (a.state === 'read' && !f.read);
	}

	// ── Changes to a record ────────────────────────────────────
	// Each takes a record it may change in place and returns it.

	function putEntry(rec, owner, row, root, rel, share) {
		if (!isDiamondId(owner)) return rec;
		var list = (own(rec.d, owner) || []).filter(function (e) {
			return !(e.id === (row.id || '') && e.to === row.to && e.root === root);
		});
		list.push({ id: row.id || '', to: row.to, rel: rel, share: !!share, root: root });
		rec.d[owner] = list;
		return rec;
	}

	function dropEntry(rec, owner, id, to) {
		var list = own(rec.d, owner);
		if (!list) return rec;
		var kept = list.filter(function (e) { return !(e.id === (id || '') && e.to === to); });
		if (kept.length) rec.d[owner] = kept; else delete rec.d[owner];
		return rec;
	}

	function dropOwner(rec, owner) {
		if (own(rec.d, owner)) delete rec.d[owner];
		return rec;
	}

	/// Narrow an entry to what its row now says. Never widens.
	function narrow(e, row) {
		e.rel = (e.rel === 'holds' && row.rel === 'holds') ? 'holds' : 'consulted';
		e.share = e.share && row.share === true;
	}

	/// Settle `owner`'s entries against the rows a copy arriving from another
	/// device carries: an entry whose `(id, to)` is absent from them is dropped,
	/// one whose row is no longer a mark is dropped, and one whose row arrives
	/// narrower is narrowed. `rows` are read from the copy's bytes, never from the
	/// store, so a store caught mid-import cannot read as a removal.
	function settleRows(rec, owner, rows) {
		var list = own(rec.d, owner);
		if (!list) return rec;
		var kept = [];
		for (var i = 0; i < list.length; i++) {
			var e = list[i], row = null;
			for (var j = 0; j < rows.length && !row; j++) {
				if (rows[j].id === e.id && rows[j].to === e.to) row = rows[j];
			}
			if (!row || !isMark(row)) continue;
			narrow(e, row);
			kept.push(e);
		}
		if (kept.length) rec.d[owner] = kept; else delete rec.d[owner];
		return rec;
	}

	function putChat(rec, chatId, a, root, opts) {
		if (!isChatId(chatId)) return rec;
		var list = own(rec.c, chatId) || [], at = -1;
		for (var i = 0; i < list.length; i++) {
			if (list[i].ref === a.ref && list[i].path === a.path && list[i].root === root) { at = i; break; }
		}
		var e = at >= 0 ? list[at] : { ref: a.ref, path: a.path, ws: false, read: false, root: root };
		if (opts.ws !== undefined) e.ws = !!opts.ws;
		if (opts.read !== undefined) e.read = !!opts.read;
		if (at >= 0) list.splice(at, 1);
		if (e.ws || e.read) list.push(e);
		if (list.length) rec.c[chatId] = list; else delete rec.c[chatId];
		return rec;
	}

	function dropChat(rec, chatId, a) {
		var list = own(rec.c, chatId);
		if (!list) return rec;
		var kept = a ? list.filter(function (e) { return !(e.ref === a.ref && e.path === a.path); }) : [];
		if (kept.length) rec.c[chatId] = kept; else delete rec.c[chatId];
		return rec;
	}

	/// Settle a chat's entries against its holdings as a merge has just formed
	/// them: a holding gone drops its entry, and one no longer marked in, or no
	/// longer Read, narrows it.
	function settleChatHolds(rec, chatId, holds) {
		var list = own(rec.c, chatId);
		if (!list) return rec;
		var kept = [];
		for (var i = 0; i < list.length; i++) {
			var e = list[i], h = null;
			for (var j = 0; j < (holds || []).length && !h; j++) {
				var x = holds[j];
				if (x && x.ref === e.ref && x.path === e.path) h = x;
			}
			if (!h) continue;
			e.ws = e.ws && !!h.ws;
			e.read = e.read && h.state === 'read';
			if (e.ws || e.read) kept.push(e);
		}
		if (kept.length) rec.c[chatId] = kept; else delete rec.c[chatId];
		return rec;
	}

	// ── Storage ────────────────────────────────────────────────
	// None of this runs under Node without a window handed in.

	var _seeds = [];
	var _seeded = false;
	var _subs = [];

	/// May the record be read and written now? Only while the identity is
	/// unlocked: an unlock reads the wrapped key from this same storage area,
	/// which proves the area has loaded. Before that every mark reads as waiting
	/// and every write is refused.
	function open() {
		try { return !!(window.DaimondIdentity && window.DaimondIdentity.isUnlocked()); }
		catch (e) { return false; }
	}

	/// The record as stored, parsed afresh: nothing is kept between reads, so a
	/// tab never acts on a record another tab has changed. `ok` is false where the
	/// record may not be read; `absent` where the key is not there at all.
	function read() {
		if (!open()) return { rec: empty(), ok: false, absent: false };
		var raw = null;
		try { raw = window.localStorage.getItem(KEY); }
		catch (e) { return { rec: empty(), ok: false, absent: false }; }
		if (raw === null) return { rec: empty(), ok: true, absent: true };
		return { rec: readRecord(raw) || empty(), ok: true, absent: false };
	}

	/// One read-modify-write, with nothing awaited between the read and the
	/// write, read back afterwards. `{ ok, moved }`: `ok` false where the write
	/// was refused or did not land.
	function change(fn) {
		var cur = read();
		if (!cur.ok) return { ok: false, moved: false };
		var before = JSON.stringify(cur.rec);
		// A fresh copy through the same normalising read, so a change works on
		// prototype-free maps too.
		var text = JSON.stringify(fn(readRecord(before) || empty()));
		if (text === before) return { ok: true, moved: false };
		var back = null;
		try {
			window.localStorage.setItem(KEY, text);
			back = window.localStorage.getItem(KEY);
		} catch (e) { /* quota or blocked storage: reported below */ }
		return { ok: back === text, moved: back === text };
	}

	function here(root) { return typeof root === 'string' ? root : 'browser'; }

	function announce() {
		for (var i = 0; i < _subs.length; i++) {
			try { _subs[i](); } catch (e) { /* a listener must not stop the others */ }
		}
		try {
			if (window.dispatchEvent) window.dispatchEvent(new CustomEvent('daimond:markshere'));
		} catch (e) { /* no CustomEvent in this context */ }
	}

	/// Is this `storage` event about this account's record? A null key is the
	/// whole store cleared.
	function ours(key) {
		if (key === null) return true;
		var pre = '';
		try { if (window.DaimondAccounts) pre = window.DaimondAccounts.prefix() || ''; }
		catch (e) { /* no accounts module: the raw key */ }
		return key === pre + KEY;
	}

	/// Another tab changed the record: every reader reads it afresh anyway, so
	/// what is left is to tell the page to redraw and re-scope.
	function onStorage(e) {
		if (e && ours(e.key)) announce();
	}

	var api = {
		KEY: KEY,
		parseRef: parseRef,
		rootKey: rootKey,
		fits: fits,
		isMark: isMark,
		parseSidecar: parseSidecar,
		/// The built-in entries, given once by daimond.js beside `DEFAULT_IDS`.
		seeds: function (list) {
			if (_seeded) return false;
			_seeded = true;
			_seeds = (list || []).map(function (s) { return { owner: str(s.owner), path: str(s.path) }; });
			return true;
		},
		force: function (owner, row, root) { return force(read().rec, owner, row, here(root), _seeds); },
		waiting: function (owner, row, root) { return waiting(read().rec, owner, row, here(root), _seeds); },
		/// Record a press here that brings `row` into force. The entry is written
		/// from the row as stored and with the share off unless `opts.share` says
		/// otherwise: a confirmation never carries the share flag.
		grant: function (owner, row, root, opts) {
			if (!isDiamondId(owner) || !isMark(row) || !ownedBy(owner, row) || !fits(row.to, here(root))) return false;
			return change(function (rec) {
				return putEntry(rec, owner, row, here(root), row.rel, !!(opts && opts.share));
			}).ok;
		},
		/// ⇄ here, on a mark this device already holds. Never touches `rel`.
		setShare: function (owner, row, root, on) {
			var r = here(root);
			if (on && !force(read().rec, owner, row, r, [])) return false;
			return change(function (rec) {
				var list = own(rec.d, owner) || [];
				for (var i = 0; i < list.length; i++) {
					if (list[i].id === (row.id || '') && list[i].to === row.to && list[i].root === r) list[i].share = !!on;
				}
				return rec;
			}).ok;
		},
		/// Move this device's entry from a row to the row that replaces it (a legacy
		/// row written once as the user's), never wider than it was.
		carry: function (owner, from, to, root, share) {
			var r = here(root);
			var was = force(read().rec, owner, from, r, []);
			if (!isDiamondId(owner) || !was || !isMark(to) || !ownedBy(owner, to)) return false;
			return change(function (rec) {
				dropEntry(rec, owner, from.id, from.to);
				return putEntry(rec, owner, to, r, (was.rel === 'holds' && to.rel === 'holds') ? 'holds' : 'consulted', share);
			}).ok;
		},
		drop: function (owner, id, to) {
			return change(function (rec) { return dropEntry(rec, owner, id, to); }).moved;
		},
		dropAll: function (owners) {
			var list = Array.isArray(owners) ? owners : [owners];
			return change(function (rec) {
				list.forEach(function (o) { dropOwner(rec, o); });
				return rec;
			}).moved;
		},
		/// Settle `owner`'s entries against the sidecar text a copy carries, and the
		/// loser's own where the change was two-sided. True where anything moved.
		settle: function (owner, text, loser) {
			var rows = parseSidecar(text).concat(parseSidecar(loser || ''));
			return change(function (rec) { return settleRows(rec, owner, rows); }).moved;
		},
		chatForce: function (chatId, a, root) { return chatForce(read().rec, chatId, a, here(root)); },
		chatWaiting: function (chatId, a, root) { return chatWaiting(read().rec, chatId, a, here(root)); },
		/// Record a press here on a chat holding: `opts.ws` and `opts.read`, each
		/// where given. An entry left granting neither is dropped.
		chatGrant: function (chatId, a, root, opts) {
			if (!isChatId(chatId) || !a || typeof a.ref !== 'string' || !a.path || parseRef(a.ref).path !== a.path) return false;
			if (!fits(a.ref, here(root))) return false;
			return change(function (rec) { return putChat(rec, chatId, a, here(root), opts || {}); }).ok;
		},
		chatDrop: function (chatId, a) {
			return change(function (rec) { return dropChat(rec, chatId, a); }).moved;
		},
		chatDropAll: function (chatIds) {
			var list = Array.isArray(chatIds) ? chatIds : [chatIds];
			return change(function (rec) {
				list.forEach(function (id) { dropChat(rec, id, null); });
				return rec;
			}).moved;
		},
		chatSettle: function (chatId, holds) {
			return change(function (rec) { return settleChatHolds(rec, chatId, holds); }).moved;
		},
		/// Is there no record on this device at all -- the first start after R2, or
		/// cleared site data? False while it cannot be read.
		absent: function () { return read().absent; },
		subscribe: function (fn) { if (typeof fn === 'function') _subs.push(fn); },
		// Pure core, for the tests.
		_core: {
			parseRow: parseRow,
			canonRef: canonRef,
			normRel: normRel,
			readRecord: readRecord,
			force: force,
			waiting: waiting,
			chatForce: chatForce,
			chatWaiting: chatWaiting,
			putEntry: putEntry,
			dropEntry: dropEntry,
			settleRows: settleRows,
			putChat: putChat,
			dropChat: dropChat,
			isDiamondId: isDiamondId,
			isChatId: isChatId,
			settleChatHolds: settleChatHolds,
			consts: { KEY: KEY, SHARE_NEEDS_PRESS_HERE: SHARE_NEEDS_PRESS_HERE },
		},
	};

	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('storage', onStorage);
	}
	if (typeof window !== 'undefined') window.DaimondMarksHere = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
