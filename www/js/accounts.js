/* accounts.js — several people, one browser, one at a time.
 *
 * An account is a passphrase identity with its own chats, provider keys, credits, mail and
 * workspace. Nobody sees another's. That isolation is achieved by NAMESPACING storage: every
 * `daimond-*` localStorage key, the FSA handle store, and the OPFS workspace are prefixed with the
 * current account — with ONE exception. The first account (the "primary") keeps the raw keys and
 * the OPFS root exactly as a single-user install always had them, so adopting an existing install
 * as account one moves not a single byte, and a browser with one account behaves byte-for-byte as
 * it did before accounts existed. Only a SECOND account brings a prefix into being.
 *
 * This script loads before every other, so the shim over `localStorage` is in place before any
 * module reads or writes. Switching account is a reload: modules read their account's data once,
 * at load, so the clean way to hand them a different account is to start them again.
 *
 * What is NOT namespaced (browser-wide, shared by everyone at this browser): the account registry
 * itself, the theme, the panel layout, and the line-number toggle. These are preferences of the
 * device, not facts about a person.
 */
(function () {
	'use strict';

	var REG = 'daimond-accounts';   // [{ id, name, fp, primary }] — the registry, raw.
	var CUR = 'daimond-current';    // the current account's id, raw.

	// Device-wide, never namespaced: the registry, and pure UI preferences.
	var GLOBAL = {
		'daimond-accounts': 1, 'daimond-current': 1,
		'daimond-theme': 1, 'daimond-layout': 1, 'daimond-files-lineno': 1,
	};

	// The unshimmed methods, captured before the shim shadows them. All raw access below goes
	// through these, so the registry and the sweep in remove() see true, un-prefixed keys.
	var proto  = window.Storage.prototype;
	var rawGet = proto.getItem, rawSet = proto.setItem, rawDel = proto.removeItem, rawKey = proto.key;
	var LS = window.localStorage;
	function rget(k)   { return rawGet.call(LS, k); }
	function rset(k, v){ return rawSet.call(LS, k, v); }
	function rdel(k)   { return rawDel.call(LS, k); }

	function list() { try { return JSON.parse(rget(REG) || '[]') || []; } catch (e) { return []; } }
	function save(a) { rset(REG, JSON.stringify(a)); }
	function find(id) {
		var a = list();
		for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
		return null;
	}

	/// A device-unique account id: 16 hex chars from the CSPRNG.
	function mint() {
		var b = new Uint8Array(8);
		crypto.getRandomValues(b);
		return Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
	}

	// Ensure there is at least one account. An existing single-user install becomes the primary,
	// carrying its name and fingerprint across so the registry can show it without unlocking; a
	// fresh install gets a primary too. Either way the primary uses the RAW keys, so nothing moves.
	(function ensure() {
		if (list().length) return;
		var primary = { id: mint(), name: rget('daimond-id-name') || '', fp: rget('daimond-id-fp') || '', primary: true };
		save([primary]);
		rset(CUR, primary.id);
	})();

	function currentId() {
		var c = rget(CUR);
		if (c && find(c)) return c;
		var a = list();
		var id = a.length ? a[0].id : null;
		if (id) rset(CUR, id);
		return id;
	}
	function account() { return find(currentId()); }

	// The primary keeps raw keys and the OPFS root; every other account is prefixed.
	function prefix() { var x = account(); return (x && !x.primary) ? ('d~' + x.id + '~') : ''; }
	/// The OPFS subdirectory for the current account ('' for the primary, i.e. the root).
	function opfsNs() { var x = account(); return (x && !x.primary) ? ('d~' + x.id) : ''; }

	function nsKey(k) {
		return (typeof k === 'string' && k.indexOf('daimond-') === 0 && !GLOBAL[k]) ? prefix() + k : k;
	}

	// The shim. Shadows the prototype methods on the instance, so every daimond-* read and write in
	// every module lands in the current account's namespace with no call site aware of it.
	LS.getItem    = function (k)    { return rget(nsKey(k)); };
	LS.setItem    = function (k, v) { return rset(nsKey(k), v); };
	LS.removeItem = function (k)    { return rdel(nsKey(k)); };

	// ── Managing accounts ───────────────────────────────────────────

	/// Add a new (non-primary) account and make it current. The caller reloads.
	function add(name) {
		var a = list();
		var na = { id: mint(), name: String(name || '').trim(), fp: '', primary: false };
		a.push(na); save(a); rset(CUR, na.id);
		return na.id;
	}
	function setCurrent(id) { if (find(id)) { rset(CUR, id); return true; } return false; }
	function rename(id, name) {
		var a = list();
		for (var i = 0; i < a.length; i++) if (a[i].id === id) a[i].name = String(name || '').trim();
		save(a);
	}
	/// Record an account's fingerprint, so the picker can show it without unlocking.
	function setFp(id, fp) {
		var a = list();
		for (var i = 0; i < a.length; i++) if (a[i].id === id) a[i].fp = fp || '';
		save(a);
	}

	/// Remove a non-primary account and ALL of its namespaced localStorage. Its OPFS subdirectory
	/// and its FSA handle store are the caller's to clear (they live outside localStorage). The
	/// primary cannot be removed here — it owns the raw keys and the OPFS root, and dropping it is
	/// "Forget this identity", which wipes the raw keys directly.
	function remove(id) {
		var x = find(id);
		if (!x || x.primary) return false;
		var pre = 'd~' + id + '~';
		var kills = [];
		for (var i = 0; i < LS.length; i++) {
			var k = rawKey.call(LS, i);
			if (k && k.indexOf(pre) === 0) kills.push(k);
		}
		kills.forEach(function (k) { rdel(k); });
		var a = list().filter(function (y) { return y.id !== id; });
		save(a);
		if (rget(CUR) === id) rset(CUR, a.length ? a[0].id : '');
		return true;
	}

	window.DaimondAccounts = {
		list:       list,
		current:    currentId,
		account:    account,
		count:      function () { return list().length; },
		add:        add,
		setCurrent: setCurrent,
		rename:     rename,
		setFp:      setFp,
		remove:     remove,
		prefix:     prefix,
		opfsNs:     opfsNs,
	};
})();
