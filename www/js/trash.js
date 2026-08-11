/* ============================================================
   Daimond — the Trash (trash.js)
   ------------------------------------------------------------
   WHY THIS EXISTS. "Delete all chats" shipped without it. A user
   pressed it expecting to be able to undo, and could not: every
   chat was tombstoned, the tombstone travelled, and both devices
   agreed the work was gone. The dialog in front of it did not
   help — it named a count, which is what somebody about to delete
   fourteen chats already believes they want.

   So deleting stops being an act and becomes a STATE. A chat or a
   Diamond that is deleted is TRASHED: still stored, still synced,
   out of the rail, out of the finders, out of every daimon's
   reach, and listed in one panel with Restore beside it.

   WHERE THE CEREMONY WENT. A reversible act needs LESS of it, so
   trashing asks nothing at all. The two questions moved to the two
   acts that cannot be taken back — "Delete permanently" on one
   item, and "Empty trash", which names the count. A dialog in
   front of a reversible act only teaches people to click through
   dialogs, and then the irreversible one is clicked through too.

   ── THE SYNC MODEL ──────────────────────────────────────────
   Trashed here is trashed everywhere; restored here is restored
   everywhere. Neither can be a bare flag on the record, because
   two devices act at once and one of them has to lose.

   So each item carries TWO monotone stamps:

       { k: 'c' | 'd', at: <ms last trashed>, back: <ms last restored> }

   and the item is in the trash exactly when `at > back`. Merging
   two records takes the LATER of each stamp independently, which
   makes the merge commutative, associative and idempotent: two
   devices converge whatever order the parcels arrive in, and a
   parcel applied twice changes nothing.

   That is what stops the two failures worth naming:

     * A DELETION CANNOT BE RESURRECTED. Permanent deletion is a
       TOMBSTONE, exactly as it was before this file existed, and a
       tombstone is honoured unconditionally by the chat and
       Diamond merges. Nothing here outranks one. Restoring an item
       another device has already destroyed raises `back` on a
       record whose subject is gone, and the sweep below drops it.

     * A RESTORE CANNOT BE BURIED. A device still holding `at` from
       yesterday cannot re-trash what was restored today: `back` is
       the later stamp, and taking the later of each is the whole
       rule. Only a NEW trashing — a real act, with a stamp later
       than the restore — puts it back, which is a person deciding
       twice and is meant to work.

   RETENTION IS A PURE FUNCTION OF `at`, deliberately. Thirty days
   after it was trashed an item is destroyed for good, and every
   device works that out from the same synced stamp without being
   told. A device that was offline for six weeks therefore sweeps
   its own trash on the boot it comes back on, and reaches the same
   answer the others reached while it was away, rather than
   depending on a tombstone that may have expired meanwhile.
   ============================================================ */
(function () {
	'use strict';

	var KEY = 'daimond-trash';		// per account: accounts.js namespaces `daimond-*`.
	// How long a trashed thing is kept. Named once, read by the sweep, by the
	// tile that shows the date, and by the panel's own explanation.
	var RETAIN_MS = 30 * 24 * 3600 * 1000;
	// How long a RESTORED record is kept after the restore. It is the counterpart
	// of a tombstone -- proof that a restore happened, so a stale `at` from
	// another device cannot union its way back in -- and it needs to outlive any
	// parcel still in flight. Seven days, which is what `TOMB_TTL` is in
	// daimond.js and for the same reason.
	var BACK_TTL = 7 * 24 * 3600 * 1000;

	var _items = null;			// id -> { k, at, back }, or null before the first read
	var _subs  = [];			// redraw callbacks

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[trash]'].concat([].slice.call(arguments))); }
		catch (e) { /* no console */ }
	}

	/// A millisecond stamp, or 0. NOT `n | 0`: an epoch-ms value is far past 32
	/// bits and the truncation is inconsistently wrong, so a fresher stamp can
	/// come out smaller than an older one and the freshest side loses. daimond.js
	/// keeps its own copy of this rule for the same reason.
	function ms(v) {
		return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.floor(v) : 0;
	}

	/// One record, defended against whatever arrived. A parcel is another
	/// device's work and a merge must never be the thing that throws.
	function clean(r) {
		if (!r || typeof r !== 'object') return null;
		var k = (r.k === 'd') ? 'd' : 'c';
		var at = ms(r.at), back = ms(r.back);
		if (!at && !back) return null;
		return { k: k, at: at, back: back };
	}

	function load() {
		if (_items) return _items;
		_items = {};
		try {
			var raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
			var items = raw.items || {};
			Object.keys(items).forEach(function (id) {
				var r = clean(items[id]);
				if (r) _items[id] = r;
			});
		} catch (e) { _items = {}; }
		return _items;
	}

	function save() {
		try { localStorage.setItem(KEY, JSON.stringify({ v: 1, items: sorted(load()) })); }
		catch (e) { log('could not write the trash record', e); }
	}

	/// The map with its ids in order and each record's fields in a fixed order.
	///
	/// The parcel is compared byte-for-byte against the last one pushed, so a
	/// section whose serialisation followed storage's enumeration order would
	/// push for ever. This is the same discipline `DaimondPause.snapshot` keeps
	/// and for exactly the same reason.
	function sorted(items) {
		var out = {};
		Object.keys(items).sort().forEach(function (id) {
			var r = items[id];
			out[id] = { k: r.k, at: r.at, back: r.back };
		});
		return out;
	}

	function announce() {
		_subs.forEach(function (f) { try { f(); } catch (e) { log('subscriber threw', e); } });
	}

	/// Is this id in the trash right now?
	function has(id) {
		if (!id) return false;
		var r = load()[id];
		return !!r && r.at > r.back;
	}

	/// Move something to the trash. `kind` is 'chat' or 'diamond'.
	///
	/// The stamp is always NOW, never carried from anywhere: trashing is an act
	/// taken on this device at this moment, and a stamp copied from an older
	/// record would be a trashing that a restore elsewhere could not outrank.
	function put(id, kind) {
		if (!id) return false;
		var items = load();
		var r = items[id] || { k: 'c', at: 0, back: 0 };
		r.k  = (kind === 'diamond' || kind === 'd') ? 'd' : 'c';
		r.at = Math.max(Date.now(), r.back + 1);	// strictly later than any restore it must outrank
		items[id] = r;
		save();
		announce();
		return true;
	}

	/// Take something back out. The mirror image of `put`, and the reason the
	/// record survives the restore rather than being deleted: the record IS the
	/// evidence that stops another device's stale trashing burying it.
	function back(id) {
		if (!id) return false;
		var items = load();
		var r = items[id];
		if (!r) return false;
		r.back = Math.max(Date.now(), r.at + 1);
		save();
		announce();
		return true;
	}

	/// Forget the record entirely: the thing it is about no longer exists,
	/// because it was destroyed for good or because it never arrived here.
	function forget(id) {
		var items = load();
		if (!(id in items)) return false;
		delete items[id];
		save();
		announce();
		return true;
	}

	/// Which ids are in the trash, and when each went in.
	function ids() {
		var items = load(), out = [];
		Object.keys(items).forEach(function (id) {
			var r = items[id];
			if (r.at > r.back) out.push({ id: id, kind: r.k === 'd' ? 'diamond' : 'chat', at: r.at });
		});
		// Newest first, which is what the panel shows and what a person looking
		// for the thing they just deleted expects to find at the top.
		out.sort(function (a, b) { return b.at - a.at || (a.id < b.id ? -1 : 1); });
		return out;
	}

	/// When a trashed item is destroyed for good.
	function dueAt(at) { return ms(at) + RETAIN_MS; }

	/// Which trashed ids are past their retention, and which restored records
	/// have outlived their usefulness. The caller destroys the first list --
	/// only it knows how to delete a chat or a Diamond -- and this drops the
	/// second on the spot, since a record with nothing left to protect is only
	/// weight in every parcel from now on.
	function sweep() {
		var items = load(), now = Date.now(), expired = [], dropped = 0;
		Object.keys(items).forEach(function (id) {
			var r = items[id];
			if (r.at > r.back) {
				if (now - r.at >= RETAIN_MS) expired.push({ id: id, kind: r.k === 'd' ? 'diamond' : 'chat', at: r.at });
				return;
			}
			// Restored, and long enough ago that no parcel still in flight can be
			// carrying the trashing it outranked.
			if (now - r.back >= BACK_TTL) { delete items[id]; dropped++; }
		});
		if (dropped) { save(); announce(); }
		return expired;
	}

	// ── The sync parcel ────────────────────────────────────────

	/// What travels. Stable bytes for stable state — see `sorted`.
	function snapshot() { return { v: 1, items: sorted(load()) }; }

	/// Merge a record from another device. True when this device moved.
	///
	/// LATER OF EACH STAMP, INDEPENDENTLY. That is the whole merge, and it is
	/// what makes the result the same whichever device runs it and whichever
	/// order the parcels arrive in. Nothing here stamps on the way in: a device
	/// that restamped what it adopted would push it straight back, and two
	/// devices would tell each other about the same trashing for ever.
	function adopt(rec) {
		if (!rec || typeof rec !== 'object') return false;
		var incoming = rec.items || {};
		var items = load(), moved = false;
		Object.keys(incoming).forEach(function (id) {
			var r = clean(incoming[id]);
			if (!r) return;
			var mine = items[id];
			if (!mine) { items[id] = r; moved = true; return; }
			if (r.at   > mine.at)   { mine.at   = r.at;   moved = true; }
			if (r.back > mine.back) { mine.back = r.back; moved = true; }
			// A record that arrived naming a Diamond where this device thinks a
			// chat is disagrees about the thing itself, not about its state. The
			// far end is as likely to be right as this one, and the kind is only
			// used to decide which store to look in — so the arriving one is taken
			// and the lookup, which asks both stores anyway, settles it.
			if (r.k !== mine.k) { mine.k = r.k; moved = true; }
		});
		if (moved) { save(); announce(); }
		return moved;
	}

	/// Drop everything held, for an account switch: one account's trash must
	/// never show in another's panel.
	function reset() { _items = null; }

	// Another tab moved the trash. localStorage fires this in the OTHER tabs
	// only, which is exactly what is wanted: this one has already redrawn.
	window.addEventListener('storage', function (e) {
		if (e.key !== KEY && !(e.key && e.key.indexOf(KEY) !== -1)) return;
		_items = null;
		announce();
	});

	window.DaimondTrash = {
		has:      has,
		put:      put,
		back:     back,
		forget:   forget,
		ids:      ids,
		sweep:    sweep,
		dueAt:    dueAt,
		snapshot: snapshot,
		adopt:    adopt,
		reset:    reset,
		subscribe: function (fn) { if (typeof fn === 'function') _subs.push(fn); },
		/// How long a trashed thing is kept, in ms. Read by the panel so the
		/// sentence a user sees and the rule the sweep applies are one number.
		retainMs: function () { return RETAIN_MS; },
		/// Every record, trashed or restored, for a verifier and for the sync
		/// tests. The live API above answers questions; this shows the workings.
		raw:      function () { return sorted(load()); },
	};
})();

/* ============================================================
   The Trash panel
   ------------------------------------------------------------
   A dock panel like the others: tiles NEWEST FIRST, Restore and
   Delete permanently on each, Restore all and Empty trash for the
   lot, and — at the head — how much the trash is actually holding.

   THE HEADER'S TOTAL IS NOT DECORATION. A trash that grows in
   silence is how somebody's storage fills up with things they
   believe they deleted, and the browser's quota does not care what
   the user believes. So the panel says the number, and every tile
   says the day its item stops existing.

   THE TILES ARE THE ATTACHMENT TILES (ATTACH_CONTRACT.md §9). That
   component already had to render an item that cannot be opened
   and say why, for an attachment recorded against a workspace that
   is not open; a trashed thing is the same shape of thing, and the
   contract said in advance to build it once.

   THE TWO QUESTIONS LIVE HERE, and nowhere else in the flow.
   Deleting to the trash asks nothing at all. Destroying one item
   asks, naming it; emptying the trash asks, naming the count. That
   is the whole of the ceremony, spent where it buys something.
   ============================================================ */
(function () {
	'use strict';

	function t(k, v) { return window.DaimondI18n ? DaimondI18n.t(k, v) : k; }
	function tn(k, n, v) { return window.DaimondI18n ? DaimondI18n.tn(k, n, v) : k; }
	function core() { return window.DaimondCore || null; }

	var listEl = null, noteEl = null, countEl = null;
	var drawing = false;		// one render at a time; the store reads are async

	function el(id) { return document.getElementById(id); }

	/// A size, in the units a person reads. The twin of `fmtBytes` in
	/// daimond.js -- this file is a classic script and cannot reach into that
	/// closure, and a panel about how much storage is being held cannot be the
	/// one that says "2411008".
	function fmtBytes(n) {
		if (!n) return '0 B';
		var u = ['B', 'KB', 'MB', 'GB'], i = 0;
		while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
		return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
	}

	/// The day something stops existing, in the language the APP is in. A date
	/// and not "in 27 days": the question a person asks of a trash is whether
	/// the thing will still be there when they get back on Monday.
	///
	/// The locale comes from `DaimondI18n`, not from `undefined`. Left to the
	/// browser, a reader who has put Daimond into German reads every other word
	/// on this row in German and the date in whatever their browser was
	/// installed as — which was "Sep 10, 2026" in the first screenshot of the
	/// finished panel.
	function fmtDate(ms) {
		var loc;
		try { loc = window.DaimondI18n ? DaimondI18n.locale() : undefined; }
		catch (e) { loc = undefined; }
		try { return new Date(ms).toLocaleDateString(loc || undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
		catch (e) { return ''; }
	}

	/// Draw the panel from the store. Safe to call at any time; it is what every
	/// action here ends with.
	async function render() {
		listEl  = el('trash-list');
		noteEl  = el('trash-note');
		countEl = el('trash-count');
		if (!listEl || !core() || !core().trashList) return;
		if (drawing) return;
		drawing = true;
		var items;
		try { items = await core().trashList(); }
		catch (e) { items = []; }
		finally { drawing = false; }

		listEl.innerHTML = '';
		var bytes = items.reduce(function (a, i) { return a + (i.bytes || 0); }, 0);
		var days  = Math.round(DaimondTrash.retainMs() / 86400000);

		if (countEl) countEl.textContent = items.length ? String(items.length) : '';
		if (noteEl) {
			// What it holds comes FIRST, before the rule: the number is the news
			// and the retention is the standing explanation beside it.
			noteEl.textContent = items.length
				? tn('trash.holding', items.length, { n: items.length, bytes: fmtBytes(bytes) })
					+ ' · ' + t('trash.kept_days', { days: days })
				: t('trash.kept_days', { days: days });
		}
		// The two bulk controls are pressable exactly when there is something for
		// them to act on -- disabled rather than hidden, so the head does not
		// change shape as the list empties.
		['trash-restore-all', 'trash-empty'].forEach(function (id) {
			var b = el(id);
			if (b) b.disabled = !items.length;
		});

		if (!items.length) {
			var none = document.createElement('div');
			none.className = 'rail-note';
			none.textContent = t('trash.nothing');
			listEl.appendChild(none);
			return;
		}

		items.forEach(function (it) {
			listEl.appendChild(core().attachTile({
				kind:  t(it.kind === 'diamond' ? 'trash.kind_diamond' : 'trash.kind_chat'),
				// A name, where an attachment passes a path. The component shows
				// whatever it is given and does not care which.
				path:  it.name,
				// There is no opening this one, and the component's own word for
				// that is `shut` -- the same state an attachment wears when the
				// workspace it was made in is not open. Built once, per §9.
				shut:  true,
				reason: t('trash.deleted_why'),
				// The two facts that VARY per row, and the two the design asks
				// for by name: the day this stops existing, and what it costs to
				// keep. Their own line, below the reason.
				note:  t('trash.until', { date: fmtDate(it.due) }) + ' · ' + fmtBytes(it.bytes),
				// STACK, always. The icon view is the attachment footers' choice
				// and their toggle sets it; an 88px cell cannot show a date and a
				// size, and this panel has no toggle to get back with.
				view:  'stack',
				actions: [{
					cls:  'trash-restore',
					text: t('trash.restore'),
					title: t('trash.restore'),
					aria: t('trash.restore_named', { name: it.name }),
					on:   function () { restore(it); },
				}, {
					cls:  'arte-drop trash-purge',
					text: '×',
					title: t('trash.purge'),
					aria: t('trash.purge_named', { name: it.name }),
					on:   function () { purge(it); },
				}],
			}));
		});
	}

	/// Put one thing back. No question: it is the undo.
	async function restore(it) {
		if (!core() || !core().trashRestore) return;
		await core().trashRestore(it.id);
		await render();
	}

	/// Destroy one thing, ASKING FIRST and naming it. This is where the
	/// ceremony that used to sit in front of an ordinary delete has gone.
	async function purge(it) {
		if (!core() || !core().trashPurge) return;
		var ok = await core().confirm(
			t('trash.purge_ask', { name: it.name }),
			t('trash.purge_ok'),
			{ title: t('trash.purge') });
		if (!ok) return;
		await core().trashPurge(it.id);
		await render();
	}

	/// Everything back on the rail, in one press.
	async function restoreAll() {
		if (!core() || !core().trashList) return;
		var items = await core().trashList();
		for (var i = 0; i < items.length; i++) await core().trashRestore(items[i].id);
		await render();
	}

	/// Destroy the lot, ASKING FIRST and NAMING THE COUNT.
	///
	/// The count is in the question because it is the only thing that
	/// distinguishes emptying a trash holding one abandoned draft from emptying
	/// one holding a fortnight's work. This is the same reasoning the deleted
	/// "Delete all 14 chats?" dialog was written from -- it was simply attached
	/// to the wrong act, where there was still a way back.
	async function empty() {
		if (!core() || !core().trashList) return;
		var items = await core().trashList();
		if (!items.length) return;
		var ok = await core().confirm(
			tn('trash.empty_ask', items.length, { n: items.length }),
			t('trash.empty_ok'),
			{ title: t('trash.empty') });
		if (!ok) return;
		for (var i = 0; i < items.length; i++) await core().trashPurge(items[i].id);
		await render();
	}

	/// The panel was opened. Retention is applied here as well as at the boot:
	/// this is the moment somebody is reading the dates, so it is the last
	/// moment a date that has passed may still be on screen.
	function onOpen() {
		if (core() && core().trashSweep) { core().trashSweep().then(render, render); return; }
		render();
	}

	// The head's own two controls, bound once by delegation so a panel that has
	// not been drawn yet still answers.
	document.addEventListener('click', function (e) {
		var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
		if (!b) return;
		if (b.dataset.act === 'trash-restore-all') { e.preventDefault(); restoreAll(); }
		else if (b.dataset.act === 'trash-empty')  { e.preventDefault(); empty(); }
	});

	// Something was trashed or restored somewhere else -- another tab, or a
	// parcel that has just landed. The panel is the one surface that must agree
	// with the record at all times, since it is the only place the record is
	// visible at all.
	try {
		DaimondTrash.subscribe(function () {
			if (window.DaimondPanels && DaimondPanels.isOpen && DaimondPanels.isOpen('trash')) render();
		});
	} catch (e) { /* the store is not up; nothing to draw from */ }

	// Say the panel's own words again in a new language. Every string on a tile
	// is built here rather than marked up in the HTML — the reason, the date,
	// the size, both buttons — so a language change reaches none of them unless
	// this surface is registered. `surface` redraws only while the panel is
	// showing, which is what it is for.
	try {
		// A function, not the node: this file is a classic script and the panel
		// it draws into is markup further up the same document, so looking the
		// node up at registration time is a bet on parse order.
		DaimondI18n.surface(function () { return document.getElementById('panel-trash'); },
			function () { render(); });
	} catch (e) { /* no i18n in this build */ }

	window.DaimondTrashPanel = {
		onOpen:     onOpen,
		render:     render,
		restore:    function (id) { return restore({ id: id }); },
		restoreAll: restoreAll,
		empty:      empty,
	};
})();
