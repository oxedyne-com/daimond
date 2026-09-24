/* store.js -- DaimondStore: the one checked write every synced record goes through.
 *
 * WHY THIS EXISTS (P3 SIM-10, 11, 13, 16; P1b STO-1, A5; 2026-09-25). Every module
 * that keeps a synced record in localStorage used to write it inside a
 * `try { setItem } catch (e) { best effort }`. Under a full box that swallow made a
 * write that never happened count as done, four ways over:
 *
 *   - a turn's spend and a nomination were lost where they were made (SIM-10);
 *   - a pause pressed on a full device lived in one tab's memory, and a sibling
 *     tab's read or a reload undid it (SIM-11);
 *   - a merge that could not store its result reported its section applied, so
 *     sync adopted the version, never walked it again, and the device re-published
 *     the stale value everyone then agreed on (SIM-16);
 *   - support consent wrote its stamp and its value as two keys, and a box that
 *     took one and refused the other kept them apart for ever (SIM-13).
 *
 * THE RULE, once, here. A record is ONE value under ONE key, stamp and all, written
 * in one `setItem`. A write the box refuses is not done and is not dropped:
 *
 *   - it is HELD in this tab as work owed, merged over whatever the box holds by
 *     the kind's own law, so every read in this tab -- the module, the parcel the
 *     tab collects, the screen -- sees it at once;
 *   - it is RETRIED, on a backoff, whenever another write lands (there is room
 *     again) and whenever another tab writes (it may have freed some);
 *   - it is SAID: `subscribe` hears the set of owed keys move, and the app raises
 *     the standing storage alarm while anything is owed;
 *   - and a MERGE's write (`putMerged`) that is refused also throws, so the
 *     section that ran it is reported failed, sync keeps the version un-adopted and
 *     re-pulls it. A merge whose result is not stored is not a merge that happened.
 *
 * A kind needs nothing else: `get`/`put`/`putMerged` with its law, and it has all
 * four. The law is `law(stored, owed) -> record`: pure, `stored` null when the box
 * holds nothing, and the answer written in place of both. With no law the owed
 * record simply stands, which is right for a record this tab writes whole.
 *
 * What is owed lives in this tab's memory: a reload before the box has room loses
 * the local copy, which is what the alarm says. By then the tab's pushes have
 * carried it to the account, and the next pull that can store brings it back.
 */
(function () {
	'use strict';

	var RETRY_MIN_MS = 2000;
	var RETRY_MAX_MS = 60000;

	var owed    = Object.create(null);	// key -> { value, law }: refused, still owed
	var subs    = [];
	var timer   = null;
	var backoff = 0;

	function clone(v) { return (v === undefined) ? undefined : JSON.parse(JSON.stringify(v)); }

	/// What the box holds under `key`, parsed, or null (absent, unreadable, corrupt).
	function stored(key) {
		var raw = null;
		try { raw = localStorage.getItem(key); } catch (e) { return null; }
		if (raw === null || raw === undefined) return null;
		try { return JSON.parse(raw); } catch (e) { return null; }
	}

	/// The record as this tab must see it: the box's, with anything this tab still
	/// owes merged over it by the kind's law. `fallback` for nothing at all.
	function get(key, fallback) {
		var o = owed[key], v = stored(key);
		if (o) v = o.law ? o.law(v, clone(o.value)) : clone(o.value);
		return (v === null || v === undefined) ? fallback : v;
	}

	function ownedKeys() { return Object.keys(owed).sort(); }

	function tell() {
		var keys = ownedKeys();
		for (var i = 0; i < subs.length; i++) {
			try { subs[i](keys); } catch (e) { /* a listener must not stop the others */ }
		}
	}

	function arm() {
		if (timer) return;
		backoff = backoff ? Math.min(backoff * 2, RETRY_MAX_MS) : RETRY_MIN_MS;
		timer = setTimeout(retry, backoff);
		if (timer && timer.unref) timer.unref();			// node: a test ends with its work
	}

	/// Try every owed record again, merged over what the box holds now.
	function retry() {
		if (timer) { clearTimeout(timer); timer = null; }
		var keys = ownedKeys();
		if (!keys.length) { backoff = 0; return; }
		var moved = false;
		for (var i = 0; i < keys.length; i++) {
			var k = keys[i], o = owed[k];
			if (!o) continue;
			var v = o.law ? o.law(stored(k), clone(o.value)) : o.value;
			try { localStorage.setItem(k, JSON.stringify(v)); delete owed[k]; moved = true; }
			catch (e) { /* still no room */ }
		}
		if (ownedKeys().length) arm(); else backoff = 0;
		if (moved) tell();
	}

	/// Hold a refused record as owed, and say so.
	function hold(key, value, law) {
		owed[key] = { value: clone(value), law: law || null };
		arm();
		tell();
	}

	/// Write a record this tab made -- a person's press, the app's own record. True
	/// when it landed; false when the box refused it, and it is then held owed,
	/// retried and said (see the header). Never throws.
	function put(key, value, law) {
		try { localStorage.setItem(key, JSON.stringify(value)); }
		catch (e) { hold(key, value, law); return false; }
		var was = !!owed[key];
		if (was) delete owed[key];			// this record was built over the owed one
		if (ownedKeys().length) retry();		// there is room: try the rest now
		else if (was) { backoff = 0; tell(); }
		return true;
	}

	/// Take a record out of the box, and anything owed for it with it, so a retry
	/// cannot write back what a person just erased.
	function remove(key) {
		if (owed[key]) { delete owed[key]; tell(); }
		try { localStorage.removeItem(key); } catch (e) { /* nothing to remove */ }
	}

	/// A write this tab refused: the error `putMerged` throws, for a merge that has
	/// to finish its own work (a redraw) before it reports the refusal.
	function refusal(key) {
		var e = new Error('storage refused ' + key + ': the merged record could not be stored');
		e.name = 'StoreRefused';
		e.key  = key;
		return e;
	}

	/// Write the result of merging another device's record. As `put`, and a refusal
	/// THROWS as well, so the section applier reports the section failed and sync
	/// re-pulls the version instead of adopting it (A5).
	function putMerged(key, value, law) {
		if (!put(key, value, law)) throw refusal(key);
		return true;
	}

	/// Is this error a refused write?
	function isRefused(e) { return !!e && e.name === 'StoreRefused'; }

	/// Hear the set of owed keys each time it moves: `fn(keys)`, sorted.
	function subscribe(fn) { if (typeof fn === 'function') subs.push(fn); }

	/// Resolves once nothing is owed: at once when nothing is. What a page's own
	/// reload waits on (F-S2), since what is owed lives only in this tab's memory.
	function settled() {
		if (!ownedKeys().length) return Promise.resolve();
		return new Promise(function (resolve) {
			var done = false;
			subscribe(function (keys) { if (!done && !keys.length) { done = true; resolve(); } });
		});
	}

	/// Forget what is owed, for an account switch: one account's owed record must
	/// never be written under another's namespace.
	function reset() {
		owed = Object.create(null);
		if (timer) { clearTimeout(timer); timer = null; }
		backoff = 0;
		tell();
	}

	/// A sibling tab ERASED what this tab still owes (F-S4): a Forget, a sign-out, a
	/// `clear()`. The erasure is the later word, so the owed copy goes with it rather
	/// than a retry writing back what a person just removed. True when one went.
	function dropErased(e) {
		if (!e || e.newValue !== null) return false;
		try { if (e.storageArea && e.storageArea !== localStorage) return false; }
		catch (x) { return false; }
		var keys = (e.key === null) ? ownedKeys() : (owed[e.key] ? [e.key] : []);
		for (var i = 0; i < keys.length; i++) delete owed[keys[i]];
		return keys.length > 0;
	}

	// Another tab wrote: it may have freed room, so an owed record tries at once.
	if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
		window.addEventListener('storage', function (e) {
			var dropped = dropErased(e);
			if (ownedKeys().length) retry();
			else if (dropped) { if (timer) { clearTimeout(timer); timer = null; } backoff = 0; }
			if (dropped) tell();
		});
		window.addEventListener('pagehide', function () { if (ownedKeys().length) retry(); });
	}

	var api = {
		get:       get,
		put:       put,
		putMerged: putMerged,
		remove:    remove,
		refusal:   refusal,
		isRefused: isRefused,
		owed:      ownedKeys,
		retry:     retry,
		subscribe: subscribe,
		settled:   settled,
		reset:     reset,
	};
	if (typeof window !== 'undefined') window.DaimondStore = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
