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

   ── AND A CHAT ARRIVES HERE ON ITS OWN ──────────────────────
   A chat is throw-away. Untouched for the operator's few days it
   is trashed without being asked, and from that moment it is an
   ordinary trashed thing: it sits in the panel with Restore beside
   it, and it is destroyed on the same retention rule as everything
   else. The feature is therefore ONE new entry point, `expire`,
   and not a second lifetime running alongside this one.

   `expire` DOES NOT STAMP THE CLOCK, and that is the whole of why
   two devices converge. `put` stamps `Date.now()`, because trashing
   by hand is an act taken here at this moment. Expiry is not an
   act; it is a DEADLINE PASSING, and the deadline is a pure
   function of a stamp both devices already hold:

       at = chat.updatedAt + <expire window>

   So a device that notices on the day and a device that notices
   three weeks later write the SAME record, byte for byte. The
   union is a no-op, the parcel does not differ, and the retention
   clock does not restart on whichever device happened to boot last.
   Had expiry stamped `Date.now()` instead, a device coming back
   from a fortnight away would have raised `at` above a restore the
   user made by hand -- an unattended machine burying somebody's
   decision, and burying it again after every restore.

   `expire` refuses in two cases, and the refusals are the safety
   rather than the arithmetic: it will not touch an item already in
   the trash, so the retention clock cannot be pushed forward; and
   it will not write an `at` that a restore already outranks, so an
   automatic act can never defeat a deliberate one.

   ── THE TWO RETENTIONS HAVE TO OUTLIVE A STALE PEER ─────────
   Both numbers below were seven days, and both were too small by
   the width of the retention itself.

   A tombstone is the only thing that can defeat a peer's copy of a
   record. Destroy an item by hand on day one and the peer still
   holds it, still holds a trash record saying `at` = day nought,
   and will go on packing both into every parcel until ITS own
   thirty days are up. A tombstone pruned on day eight is therefore
   a deletion that the next parcel undoes -- which is exactly what
   was seen. The tombstone has to reach the peer's own verdict, so
   it has to outlive the retention, not the parcel.

   `BACK_TTL` is the same statement about restores. A restore record
   is what stops a peer's stale trashing burying it; the stale
   trashing lives until the peer's own retention date, so the proof
   of the restore must live at least that long too.

   Hence both are RETENTION PLUS A GRACE, and the grace is there for
   a peer that has to boot, sweep and reach the same answer rather
   than for any clock skew. Either branch then converges and there
   is no third: a peer returning inside the term is told, and a peer
   returning after it has already destroyed the item itself.
   ============================================================ */

/* ============================================================
   The operator's policy
   ------------------------------------------------------------
   Two numbers the operator sets in the Dashboard -- how long an
   untouched chat lives, and how long the trash keeps what it is
   given -- served by the gateway at `GET /api/policy` and cached
   here.

   IT LIVES IN THIS FILE BECAUSE THIS FILE ALREADY OWNS THE
   SENTENCE. `RETAIN_MS` was named once and read by the sweep, by
   the tile that shows the date and by the panel's own explanation,
   for the reason that a retention stated in two places is two
   retentions. The expiry window is the same sentence one clause
   earlier -- how long a chat lives before it is given to the trash
   -- and splitting the pair across two modules would put the two
   halves of one policy where they could disagree.

   THE SHIPPED DEFAULTS STAND UNTIL THE GATEWAY SAYS OTHERWISE, and
   they stand for ever on a device that has no gateway at all. A
   user on their own provider keys and no account still has chats
   that expire, because a policy that only worked when the network
   did would be a policy that quietly stopped applying on an
   aeroplane. The cache means the last answer heard is the answer
   used, so a device offline for a month applies the operator's
   figure rather than reverting to the shipped one.

   TWO DEVICES HOLDING DIFFERENT FIGURES STILL CONVERGE on when a
   chat is TRASHED, which is the property that lets this be cached
   at all rather than agreed. The one holding the shorter window
   expires first and writes the record; the other finds the item
   already trashed and `expire` declines to touch it. The earlier
   figure wins, the later device does nothing, and neither writes a
   second record.

   ── A RETENTION THAT CAN BE LOWERED ─────────────────────────
   Making the retention settable breaks something the trash was
   built on, and it has to be paid for rather than lived with.

   The old sentence was "retention is a pure function of `at`" --
   true when thirty days was a constant every device shared. With a
   knob it is a function of `at` AND of whichever figure each device
   last heard, so two devices destroy the same item on different
   days. That is a device deleting somebody's work a week before its
   own panel said it would.

   So THE RETENTION IS PINNED ON THE RECORD, in `r`, as it stood at
   the moment the item was trashed. `at + r` is again a pure
   function of the synced record, every device reads the same
   destruction date off the same bytes, and lowering the knob
   governs what is trashed FROM NOW ON rather than reaching back and
   shortening the term of things already in the bin. That is also
   the honest reading of the setting: an operator lowering it is
   saying what should happen next, not condemning what is already
   there.

   That leaves the tombstone, which is not on any record and so
   cannot be pinned. A tombstone has to outlive whatever a PEER
   still holds, and a peer that has not heard the new figure is
   still working to the old one. Lower the knob from ninety days to
   thirty and a device that adopted the change prunes its
   tombstones sixty days before its peer stops offering the record
   back -- hole one again, with the operator as its cause.

   Hence `tombTtlMs` is a HIGH-WATER: the largest retention this
   device has ever seen, from the policy and from the `r` of every
   record it has ever adopted, plus the grace. Fed by evidence
   rather than by guessing -- a peer's record stamped under the old
   ninety days ARRIVES carrying `r` = 90, and adopting it raises
   this device's tombstone term to cover the peer that sent it.
   It never falls. A tombstone kept too long costs a few bytes in
   the parcel; one dropped too early costs somebody's work, and
   between those two there is no symmetry to trade on.
   ============================================================ */
(function () {
	'use strict';

	var KEY = 'daimond-policy';
	// What Daimond ships believing. The gateway's own fallbacks say the same
	// numbers (gateway/src/settings.rs), so a console never shows a figure the
	// app would not actually apply.
	var CHAT_EXPIRE_DAYS = 3;
	var TRASH_RETAIN_DAYS = 30;
	// How much longer than the retention a tombstone and a restore record are
	// kept. It buys a peer the time to boot, sweep and reach the same verdict;
	// see the header above for why the term is retention PLUS this and not the
	// retention alone.
	var GRACE_DAYS = 7;

	var DAY = 24 * 3600 * 1000;
	var _cache = null;

	function log(/* ...args */) {
		try { if (window.console && console.debug) console.debug.apply(console, ['[policy]'].concat([].slice.call(arguments))); }
		catch (e) { /* no console */ }
	}

	/// A whole number of days, or `dflt`. A policy that arrived as nonsense is
	/// not obeyed: these two numbers decide when somebody's work is destroyed,
	/// and the shipped figure is a better answer than whatever was parsed.
	function days(v, dflt) {
		var n = (typeof v === 'string') ? parseInt(v, 10) : v;
		if (typeof n !== 'number' || !isFinite(n) || n < 1) return dflt;
		return Math.floor(n);
	}

	function load() {
		if (_cache) return _cache;
		_cache = { expire: CHAT_EXPIRE_DAYS, retain: TRASH_RETAIN_DAYS, high: TRASH_RETAIN_DAYS };
		try {
			var raw = JSON.parse(localStorage.getItem(KEY) || '{}') || {};
			_cache.expire = days(raw.expire, CHAT_EXPIRE_DAYS);
			_cache.retain = days(raw.retain, TRASH_RETAIN_DAYS);
			_cache.high   = Math.max(_cache.retain, days(raw.high, TRASH_RETAIN_DAYS));
		} catch (e) { /* nothing cached: the shipped figures stand */ }
		return _cache;
	}

	function save(p) {
		try { localStorage.setItem(KEY, JSON.stringify({ v: 1, expire: p.expire, retain: p.retain, high: p.high })); }
		catch (err) { log('could not cache the policy', err); }
	}

	/// Adopt a policy, from the gateway or from a test. True when it moved,
	/// which is what tells the trash to redraw the dates it has already drawn.
	function set(expireDays, retainDays) {
		var was = load(), e = days(expireDays, was.expire), r = days(retainDays, was.retain);
		var h = Math.max(was.high, r);
		if (e === was.expire && r === was.retain && h === was.high) return false;
		_cache = { expire: e, retain: r, high: h };
		save(_cache);
		return true;
	}

	/// Remember that a retention of `d` days is in force SOMEWHERE -- read off
	/// the `r` of a record that arrived from another device.
	///
	/// This is the whole of how a lowered knob stays safe. The peer that sent
	/// the record is still working to the term the record carries, so this
	/// device's tombstones must reach it, and the record itself is the evidence
	/// of how far. Monotone: it never comes back down, because the peer that
	/// needed the longer term does not stop needing it when the parcel is over.
	function noteRetain(d) {
		var p = load(), n = days(d, 0);
		if (!n || n <= p.high) return false;
		p.high = n;
		save(p);
		return true;
	}

	/// Ask the gateway what the operator has set. Fire and forget: a failure
	/// leaves the cached answer in place, which is the right answer to have.
	///
	/// Unauthenticated, deliberately. It returns two integers the interface
	/// states in plain words anyway, and a device has to be able to learn the
	/// policy before it has an account -- otherwise a fresh install would apply
	/// the shipped figures until somebody signed in, and the one moment the
	/// operator most wants their policy in force is the first boot.
	async function refresh() {
		var j;
		try {
			var res = await fetch('/api/policy', { headers: { 'accept': 'application/json' } });
			if (!res.ok) return false;
			j = await res.json();
		} catch (e) { return false; }		// offline, or no gateway in this build
		if (!j || j.ok !== true) return false;
		return set(j.chat_expire_days, j.trash_retain_days);
	}

	window.DaimondPolicy = {
		/// How long a chat may go untouched before the trash takes it, in ms.
		chatExpireMs:  function () { return load().expire * DAY; },
		/// How long the trash keeps what it is given FROM NOW ON, in ms. What it
		/// is keeping already goes by the term pinned on each record.
		trashRetainMs: function () { return load().retain * DAY; },
		/// The retention to pin on a record being trashed now, in days.
		retainDays:    function () { return load().retain; },
		/// How long a tombstone -- and a restore record -- must be kept: long
		/// enough to outlive the longest-lived peer this device knows of. See
		/// the header on why this is a high-water and not the current figure.
		tombTtlMs:     function () { return (load().high + GRACE_DAYS) * DAY; },
		noteRetain:    noteRetain,
		/// The two figures in days, for the sentences that quote them.
		days:          function () { var p = load(); return { expire: p.expire, retain: p.retain }; },
		set:           set,
		refresh:       refresh,
		/// Drop the cache, for an account switch and for the verifiers.
		reset:         function () { _cache = null; },
	};

	// Ask once per boot. Nothing waits on it: the cached or shipped figures are
	// already in force, and this only replaces them.
	try { refresh(); } catch (e) { /* no fetch in this environment */ }
})();
(function () {
	'use strict';

	var KEY = 'daimond-trash';		// per account: accounts.js namespaces `daimond-*`.
	var DAY = 24 * 3600 * 1000;

	/// How long a thing trashed NOW is to be kept, in days. Pinned onto the
	/// record at that moment; from then on the record's own `r` is the term, so
	/// an operator moving the knob cannot shorten what is already in the bin.
	function retainDays() {
		try { return DaimondPolicy.retainDays(); }
		catch (e) { return 30; }		// no policy module: the shipped figure
	}

	/// How long a RESTORED record is kept after the restore. It is the
	/// counterpart of a tombstone -- proof that a restore happened, so a stale
	/// `at` from another device cannot union its way back in -- and it has to
	/// outlive the peer holding that stale `at`, which holds it until its own
	/// retention is up. Same term as `TOMB_TTL` in daimond.js, for exactly the
	/// same reason, and both come from the one place that works it out.
	function backTtl() {
		try { return DaimondPolicy.tombTtlMs(); }
		catch (e) { return 37 * DAY; }
	}

	var _items = null;			// id -> { k, at, back, a, r }, or null before the first read
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
	///
	/// A record with no `r` predates the retention being settable, or came from
	/// a device that still does. It is given the retention in force here, which
	/// is the best answer available: the alternative is a record with no
	/// destruction date at all.
	function clean(r) {
		if (!r || typeof r !== 'object') return null;
		var k = (r.k === 'd') ? 'd' : 'c';
		var at = ms(r.at), back = ms(r.back);
		if (!at && !back) return null;
		var days = (typeof r.r === 'number' && isFinite(r.r) && r.r >= 1) ? Math.floor(r.r) : retainDays();
		return { k: k, at: at, back: back, a: r.a ? 1 : 0, r: days };
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
			out[id] = { k: r.k, at: r.at, back: r.back, a: r.a ? 1 : 0, r: r.r };
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
		var r = items[id] || { k: 'c', at: 0, back: 0, a: 0, r: retainDays() };
		r.k  = (kind === 'diamond' || kind === 'd') ? 'd' : 'c';
		r.at = Math.max(Date.now(), r.back + 1);	// strictly later than any restore it must outrank
		r.a  = 0;					// a person did this, whatever put it here before
		r.r  = retainDays();		// the term it is going in under, pinned now
		items[id] = r;
		save();
		announce();
		return true;
	}

	/// A chat whose time ran out, put in the trash by the clock rather than by
	/// anybody. `at` is WHEN IT RAN OUT, which is usually in the past.
	///
	/// THE STAMP IS THE CALLER'S AND IS NEVER `Date.now()`. The caller works it
	/// out as `chat.updatedAt + <the expiry window>`, a pure function of a stamp
	/// both devices already hold, so a device that notices on the day and a
	/// device that notices three weeks later write the same record byte for
	/// byte. Their union is a no-op and the retention clock does not restart.
	/// See this file's header for what stamping `Date.now()` here would cost.
	///
	/// It refuses twice, and the refusals are the safety:
	///
	///   * ALREADY IN THE TRASH -- nothing to do, and doing it anyway would push
	///     the destruction date out every time the sweep ran.
	///   * A RESTORE OUTRANKS IT -- `at <= back` means a person took this back
	///     out after the deadline being offered, and an unattended machine does
	///     not overrule that. The chat has to be touched again (which it is, on
	///     restore) before a later deadline can put it here.
	///
	/// Returns true only when the record actually moved.
	function expire(id, kind, at) {
		if (!id) return false;
		var when = ms(at);
		if (!when) return false;
		var items = load();
		var r = items[id];
		if (r && r.at > r.back) return false;		// already in the trash
		if (r && when <= r.back) return false;		// a restore outranks this deadline
		r = r || { k: 'c', at: 0, back: 0, a: 0, r: retainDays() };
		r.k  = (kind === 'diamond' || kind === 'd') ? 'd' : 'c';
		r.at = when;
		r.a  = 1;					// nobody pressed anything; the panel says so
		r.r  = retainDays();
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

	/// Which ids are in the trash, when each went in, when each stops existing,
	/// and whether it was put there by a person or by the clock.
	///
	/// `due` is carried rather than left to the caller because it is a function
	/// of the record's OWN pinned retention and not of anything global -- the
	/// one place that knows it is here.
	function ids() {
		var items = load(), out = [];
		Object.keys(items).forEach(function (id) {
			var r = items[id];
			if (r.at > r.back) out.push({
				id:   id,
				kind: r.k === 'd' ? 'diamond' : 'chat',
				at:   r.at,
				due:  r.at + r.r * DAY,
				auto: !!r.a,
			});
		});
		// Newest first, which is what the panel shows and what a person looking
		// for the thing they just deleted expects to find at the top.
		out.sort(function (a, b) { return b.at - a.at || (a.id < b.id ? -1 : 1); });
		return out;
	}

	/// When one trashed item is destroyed for good, by id.
	///
	/// Read off the RECORD, because the record carries the retention it went in
	/// under. Asking the current policy instead would let an operator lowering
	/// the knob move the destruction date of everything already in the bin --
	/// forward, past dates the panel has already shown people.
	function dueAt(id) {
		var r = load()[id];
		return r ? r.at + r.r * DAY : 0;
	}

	/// Which trashed ids are past their retention, and which restored records
	/// have outlived their usefulness. The caller destroys the first list --
	/// only it knows how to delete a chat or a Diamond -- and this drops the
	/// second on the spot, since a record with nothing left to protect is only
	/// weight in every parcel from now on.
	function sweep() {
		var items = load(), now = Date.now(), expired = [], dropped = 0, ttl = backTtl();
		Object.keys(items).forEach(function (id) {
			var r = items[id];
			if (r.at > r.back) {
				// The record's OWN term, not the current policy's: this item went
				// in under a figure the panel has already shown, and lowering the
				// knob must not bring that date forward.
				if (now >= r.at + r.r * DAY) {
					expired.push({ id: id, kind: r.k === 'd' ? 'diamond' : 'chat', at: r.at, auto: !!r.a });
				}
				return;
			}
			// Restored, and long enough ago that no peer can still be holding the
			// trashing it outranked -- which is its own retention away, not the
			// life of a parcel. See `backTtl`.
			if (now - r.back >= ttl) { delete items[id]; dropped++; }
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
			// Whatever term the sender is working to, this device's tombstones
			// have to outlive it -- so the figure is taken off every record that
			// arrives, whether or not the record itself is news. See the policy
			// header on why the high-water is fed by evidence.
			try { DaimondPolicy.noteRetain(r.r); } catch (e) { /* no policy module */ }
			var mine = items[id];
			if (!mine) { items[id] = r; moved = true; return; }
			// `a` and `r` describe the TRASHING, so they travel with `at` and are
			// taken exactly when it is. Taken independently they would describe a
			// stamp that lost, which is how a record comes to say it was expired
			// by a clock on a date somebody pressed a button.
			if (r.at   > mine.at)   { mine.at = r.at; mine.a = r.a; mine.r = r.r; moved = true; }
			else if (r.at === mine.at) {
				// The same trashing reached here twice. Two devices can only
				// disagree about it if one was a person and the other the clock --
				// which happens when a chat is deleted by hand at the exact
				// moment its deadline passed elsewhere. The person wins, because
				// the panel would otherwise tell them a clock did what they did,
				// and both devices reach that answer whichever way the parcel ran.
				if (mine.a && !r.a) { mine.a = 0; moved = true; }
				// And the LONGER term wins a tie -- the two devices cached
				// different figures across the instant the knob moved. Longer,
				// on the same asymmetry the whole file is built on: keeping
				// something past its date costs a few bytes, destroying it before
				// its date costs the work. It settles as soon as both refresh.
				if (r.r > mine.r) { mine.r = r.r; moved = true; }
			}
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
		expire:   expire,
		back:     back,
		forget:   forget,
		ids:      ids,
		sweep:    sweep,
		dueAt:    dueAt,
		snapshot: snapshot,
		adopt:    adopt,
		reset:    reset,
		subscribe: function (fn) { if (typeof fn === 'function') _subs.push(fn); },
		/// How long a thing trashed NOW would be kept, in ms. Read by the panel
		/// so the sentence a user sees and the rule the sweep applies are one
		/// number. What is already in the bin goes by its own pinned term, which
		/// is why every tile states its own date rather than sharing this one.
		retainMs: function () { return retainDays() * DAY; },
		/// Whether a trashed thing got there by itself.
		isAuto:   function (id) { var r = load()[id]; return !!(r && r.a && r.at > r.back); },
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
	/// A string with the English written at the call site as its fallback.
	///
	/// `t` answers with the KEY when the table has no entry, so a panel built
	/// against a key the locale files have not been given yet reads
	/// "trash.expired_why" on screen. The seven translations are routed
	/// separately from the code that needs them and may land after it, so every
	/// string this release adds goes through here: the English shows until the
	/// tables catch up, and not one moment longer. The Search row in daimond.js
	/// keeps the same discipline for the same reason.
	function tOr(k, fallback, v) {
		var s = t(k, v);
		if (s !== k) return s;
		if (!v) return fallback;
		return String(fallback).replace(/\{(\w+)\}/g, function (whole, name) {
			return v[name] != null ? String(v[name]) : whole;
		});
	}
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
				// WHY it is here, and the two are not the same news. A chat that
				// ran out of time was not deleted by anybody, and telling
				// somebody they deleted something they did not is how they come
				// to distrust the panel that is holding their work.
				reason: it.auto
					? tOr('trash.expired_why', 'Its time ran out. It is only here.')
					: t('trash.deleted_why'),
				// The two facts that VARY per row, and the two the design asks
				// for by name: the day this stops existing, and what it costs to
				// keep. Their own line, below the reason.
				note:  t('trash.until', { date: fmtDate(it.due) }) + ' · ' + fmtBytes(it.bytes),
				// STACK, always. The icon view is the attachment footers' choice
				// and their toggle sets it; an 88px cell cannot show a date and a
				// size, and this panel has no toggle to get back with.
				view:  'stack',
				actions: rowActions(it),
			}));
		});
	}

	/// What may be done to one row.
	///
	/// A TRASHED CHAT CAN STILL BE KEPT, and that is the whole reason this list
	/// is built rather than written out. A chat arrives here on its own now, so
	/// the trash is where somebody meets a conversation they had forgotten and
	/// realises it mattered after all -- and at that moment the useful act is not
	/// to put it back on the rail to expire again in three days, it is to make a
	/// Diamond of it. Restore is still there for the other case.
	///
	/// Not offered on a Diamond: it is one already.
	function rowActions(it) {
		var out = [];
		if (it.kind !== 'diamond' && core() && core().keepAsDiamond) {
			out.push({
				cls:  'trash-keep',
				text: tOr('trash.keep', 'Keep'),
				title: tOr('trash.keep_help',
					'Make a Diamond of this chat, with the whole conversation as its first artefact.'),
				aria: tOr('trash.keep_named', 'Keep {name} as a Diamond', { name: it.name }),
				on:   function () { keep(it); },
			});
		}
		out.push({
			cls:  'trash-restore',
			text: t('trash.restore'),
			title: t('trash.restore'),
			aria: t('trash.restore_named', { name: it.name }),
			on:   function () { restore(it); },
		});
		out.push({
			cls:  'arte-drop trash-purge',
			text: '×',
			title: t('trash.purge'),
			aria: t('trash.purge_named', { name: it.name }),
			on:   function () { purge(it); },
		});
		return out;
	}

	/// Make a Diamond of a trashed chat, carrying its transcript in.
	///
	/// The chat is LEFT IN THE TRASH afterwards, deliberately. Its content is in
	/// the Diamond now, which is the durable thing; putting the chat back on the
	/// rail as well would leave two copies of one conversation and one of them
	/// on a three-day clock. The panel redraws either way, because the act may
	/// have been cancelled at the name.
	async function keep(it) {
		if (!core() || !core().keepAsDiamond) return;
		try { await core().keepAsDiamond(it.id); }
		catch (e) { /* the core has already said so on screen */ }
		await render();
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
