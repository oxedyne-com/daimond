/* storewait.js — the one bound on a wait for the page's own stores (IndexedDB),
 * shared by ChatStore (page/chatstore.js) and the key-value store (durable.js).
 *
 * A browser whose store stops answering (Chrome's blob commit that never calls back,
 * Q1108-045) holds every later request on that origin's stores for ever. Each wait
 * is bounded by the policy's figure, so a caller is released and told, and the
 * request itself is left to finish: when it does, the store is answering again.
 * What is bounded is the store's SILENCE, not the whole wait: a cursor walk, or a
 * write of many pieces, that keeps answering is not stalled however long it runs.
 */
(function () {
	'use strict';

	var late      = 0;		// waits that ran out and have not answered yet
	var answerFns = {};		// what to run once a stalled store answers again, by key
	var alarm     = null;	// { stalled(what, ms), answered(), blocked(what) }, told by the page

	/// Race `p` against the store's silence. `p` is a promise, or
	/// `function (alive) { return promise; }` that calls `alive()` on each answer.
	function bounded(p, what) {
		var ms = window.DaimondPolicy.storeWaitMs(), timer = null, over = false, fail = null;
		var stop = new Promise(function (res, rej) { fail = rej; });
		var arm = function () {
			clearTimeout(timer);
			timer = setTimeout(function () {
				over = true;
				late += 1;
				if (alarm) { try { alarm.stalled(what, ms); } catch (e) { /* the bound stands without its notice */ } }
				var e = new Error('the store did not answer while ' + what);
				e.silent = true;
				fail(e);
			}, ms);
		};
		arm();
		if (typeof p === 'function') p = p(function () { if (!over) arm(); });
		var settle = function () {
			clearTimeout(timer);
			if (!over) return;
			late -= 1;
			if (late > 0) return;
			if (alarm) { try { alarm.answered(); } catch (e) { /* one caller's fault stays its own */ } }
			var fns = answerFns; answerFns = {};
			Object.keys(fns).forEach(function (k) { try { fns[k](); } catch (e) { /* one caller's fault stays its own */ } });
		};
		p.then(settle, settle);
		return Promise.race([p, stop]);
	}

	var REQS = ['put', 'add', 'delete', 'clear', 'get', 'getAll', 'getKey', 'getAllKeys', 'count'];
	function quiet() { /* the caller that wants the failure awaits it */ }

	/// Watch transaction `t`: `store(name)` hands out its stores, whose every request is a
	/// promise of its answer that fails with the transaction or its silence, so no caller
	/// holds a request it could wait on past the bound; `done()` waits for the commit. A
	/// `write` transaction offers only `run`, so every write it makes is one `run` can abort.
	/// `walk(range, each)` runs `each(value, key)` on every row in key order and resolves
	/// once the walk ends; a callback that throws aborts the transaction. `run(work)` runs
	/// `work(store)` and answers what it answers once the transaction commits, aborting the
	/// transaction when the work throws or rejects, so a failed write lands none of it.
	/// A request's promise answers inside the request's own event, so a further request
	/// made in its `then` lands in the same transaction.
	function watch(t, what, write) {
		var beat = null;
		var p = new Promise(function (res, rej) {
			t.oncomplete = res;
			t.onerror    = function () { rej(t.error || new Error('the store failed while ' + what)); };
			t.onabort    = function () { rej(t.error || new Error('the store gave up while ' + what)); };
		});
		var bound = bounded(function (alive) { beat = alive; return p; }, what);
		bound.catch(quiet);
		var pulse = function () { if (beat) beat(); };
		var abort = function () { try { t.abort(); } catch (e) { /* already over */ } };
		function answer(r, each) {
			var q = new Promise(function (res, rej) {
				r.onsuccess = function () {
					pulse();
					if (!each) { res(r.result); return; }
					var c = r.result;
					if (!c) { res(); return; }
					try { each(c.value, c.key); c['continue'](); } catch (e) { abort(); rej(e); }
				};
				r.onerror = function () { rej(r.error || new Error('the store failed while ' + what)); };
			});
			var out = Promise.race([q, bound.then(function () { return q; })]);
			out.catch(quiet);
			return out;
		}
		var w = {
			store: function (name) {
				var st = t.objectStore(name), f = {};
				REQS.forEach(function (m) {
					f[m] = function () { return answer(st[m].apply(st, arguments)); };
				});
				f.walk = function (range, each) { return answer(range == null ? st.openCursor() : st.openCursor(range), each); };
				return f;
			},
			done: function () { return bound; },
			run: function (work) {
				var out;
				try { out = Promise.resolve(work(w.store)); } catch (e) { out = Promise.reject(e); }
				out = out.catch(function (e) { abort(); throw e; });
				return Promise.all([out, bound]).then(function (r) { return r[0]; });
			},
		};
		return write ? { run: w.run } : w;
	}

	/// The connection as its owner holds it: `watch(stores, mode, what)` opens a transaction
	/// watched as above, `has(store)`, `close()`, and `ended(fn)` for a close or a
	/// `versionchange` (which closes it). The raw connection is not reachable from it, so
	/// no caller can open a transaction whose requests nothing bounds.
	function held(raw) {
		return {
			watch:  function (names, mode, what) { return watch(raw.transaction(names, mode), what, mode !== 'readonly'); },
			has:    function (store) { return raw.objectStoreNames.contains(store); },
			close:  function () { try { raw.close(); } catch (e) { /* already */ } },
			ended:  function (fn) {
				raw.onclose = fn;
				raw.onversionchange = function () { try { raw.close(); } catch (e) { /* already */ } fn(); };
			},
		};
	}

	/// Open IndexedDB `name` at `version`, bounded as any wait, answering the connection as
	/// `held` hands it out. `upgrade(d, ev)` lays out its stores through `d.has(store)`,
	/// `d.create(store, opts)` and `d.store(store)`, the upgrade's own store watched as
	/// above. A tab at an older version that holds the store makes this refuse at once,
	/// with a notice. A connection that answers after the wait ran out or the open was
	/// refused is closed: nobody holds it to answer `versionchange`, so left open it would
	/// block every later upgrade until this tab closes.
	function open(name, version, upgrade, what) {
		var given = false;	// the caller has had its answer
		var p = new Promise(function (resolve, reject) {
			var ix = null;
			try { ix = window.indexedDB || null; } catch (e) { ix = null; }
			if (!ix) { reject(new Error('this browser offers no IndexedDB')); return; }
			var req = ix.open(name, version);
			req.onupgradeneeded = function (ev) {
				var raw = req.result, w = null;
				upgrade({
					has:    function (store) { return raw.objectStoreNames.contains(store); },
					create: function (store, opts) { raw.createObjectStore(store, opts); },
					store:  function (store) { w = w || watch(req.transaction, what); return w.store(store); },
				}, ev);
			};
			req.onsuccess = function () {
				if (given) { try { req.result.close(); } catch (e) { /* already */ } } else resolve(held(req.result));
			};
			req.onerror   = function () { reject(req.error || new Error('the store would not open while ' + what)); };
			req.onblocked = function () {
				given = true;
				blocked(what);
				var e = new Error('another tab is holding the store open while ' + what);
				e.blocked = true;
				reject(e);
			};
		});
		return bounded(p, what).catch(function (e) { given = true; throw e; });
	}

	function blocked(what) {
		if (alarm && alarm.blocked) { try { alarm.blocked(what); } catch (e) { /* the refusal stands without its notice */ } }
	}

	window.DaimondStoreWait = {
		bounded:     bounded,
		open:        open,
		/// Is a wait outstanding on a store that stopped answering?
		stalled:     function () { return late > 0; },
		whenAnswers: function (key, fn) { if (late > 0) answerFns[key] = fn; else fn(); },
		tell:        function (a) { alarm = a; },
		/// Say that an open was refused because another tab holds the store at an older version.
		blocked:     blocked,
	};
})();
