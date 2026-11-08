// An in-memory IndexedDB of one database for arms that run the REAL storewait.js and
// durable.js (pagestore_r3, lsfull).
import { enc, dec, cmp, inRange, isRange } from './idbkeys.mjs';

/// An IndexedDB of one database. `how.open`: 'ok', 'silent' (never answers), 'error' (named `how.errName`), 'late'
/// (answers `how.late` ms on) or 'blocked' (an older tab holds it: onblocked, then
/// nothing, or the connection `how.late` ms on when that is set). Each request answers `how.delay` ms
/// after the one before it, or never once `how.stall` is set; `how.failTx(mode)` true fails that transaction; while `how.held` is an array
/// the store is busy and each request waits in it until `release(how)`; `how.failPut(key)` true fails that put,
/// and so its transaction. `how.list` offers
/// `databases()`, which names the database once it has been made.
/// A transaction starts once every earlier one it must follow has ended (a readwrite one
/// follows all, a readonly one the readwrite ones), as IndexedDB orders them.
/// While `how.quota` is above 0, each put is refused as a full disk refuses it, and its
/// transaction aborts.
export function kvIdb(how) {
	const data = new Map();
	let afterAll = Promise.resolve(), afterRw = Promise.resolve();
	const db = {
		objectStoreNames: { contains: () => data.made === true },
		createObjectStore() { data.made = true; },
		close() { data.closed = (data.closed || 0) + 1; },
		transaction(names, mode) {
			if (how.callers) how.callers.push(new Error().stack.split('\n')[2] || '');
			if (how.tx === 'throw' || (how.failTx && how.failTx(mode))) throw new Error('injected');
			const tx = { oncomplete: null, onerror: null, onabort: null };
			let open = 0, last = Date.now(), ended = false, before = null, end;
			const waiting = [], done = new Promise((r) => { end = r; });
			(mode === 'readwrite' ? afterAll : afterRw).then(() => { before = new Map(data); waiting.splice(0).forEach((f) => f()); });
			afterAll = Promise.all([afterAll, done]);
			if (mode === 'readwrite') afterRw = Promise.all([afterRw, done]);
			const commit = () => setTimeout(() => { if (open === 0 && !ended) { ended = true; end(); if (tx.oncomplete) tx.oncomplete(); } }, 0);
			tx.abort = () => {
				if (ended) throw new Error('InvalidStateError');
				ended = true;
				end();
				if (before) { data.clear(); before.forEach((v, k) => data.set(k, v)); }
				setTimeout(() => { if (tx.onabort) tx.onabort(); }, 0);
			};
			const request = (work) => {
				const rq = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); }, onsuccess: null, result: undefined };
				open++;
				if (how.stall) return rq;
				const go = () => {
					last = Math.max(last, Date.now()) + how.delay;
					setTimeout(() => { open--; if (ended) return; work(rq); if (rq.onsuccess) rq.onsuccess(); rq.ls.forEach((f) => f()); commit(); }, last - Date.now());
				};
				const start = () => { if (how.held) how.held.push(go); else go(); };
				if (before) start(); else waiting.push(start);
				return rq;
			};
			tx.objectStore = () => ({
				get: (k) => request((rq) => { rq.result = data.get(enc(k)); }),
				put: (v, k) => {
					if (how.failPut && how.failPut(k)) throw new Error('injected put');
					if (!(how.quota > 0)) return request(() => { data.set(enc(k), structuredClone(v)); });
					how.quota--;
					const rq = { onsuccess: null, onerror: null, error: { name: 'QuotaExceededError' } };
					setTimeout(() => { if (rq.onerror) rq.onerror(); tx.abort(); }, 0);
					return rq;
				},
				delete: (k) => request(() => {
					if (isRange(k)) { for (const x of [...data.keys()]) if (inRange(k, dec(x))) data.delete(x); }
					else data.delete(enc(k));
				}),
				openCursor: (r) => {
					const rq = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); }, onsuccess: null, result: null };
					let lastKey;
					const step = () => { const q = request((q1) => {
						const k = [...data.keys()].map(dec).filter((x) => inRange(r, x) && (lastKey === undefined || cmp(x, lastKey) > 0)).sort(cmp)[0];
						lastKey = k;
						q1.result = k === undefined ? null : { key: k, value: data.get(enc(k)), continue: step };
					}); q.onsuccess = () => { rq.result = q.result; if (rq.onsuccess) rq.onsuccess(); rq.ls.forEach((f) => f()); }; };
					step();
					return rq;
				},
			});
			commit();
			return tx;
		},
	};
	const api = { open() {
			const r = { result: null };
			const answer = () => {
				r.result = db;
				if (!data.made && r.onupgradeneeded) r.onupgradeneeded({ oldVersion: 0 });
				if (r.onsuccess) r.onsuccess();
			};
			queueMicrotask(() => {
				if (how.open === 'silent') return;
				if (how.open === 'error') { r.error = { name: how.errName || 'UnknownError' }; if (r.onerror) r.onerror(); return; }
				if (how.open === 'late') { setTimeout(answer, how.late); return; }
				if (how.open === 'blocked') { if (r.onblocked) r.onblocked(); if (how.late) setTimeout(answer, how.late); return; }
				answer();
			});
			return r;
	} };
	if (how.list) api.databases = () => Promise.resolve(data.made ? [{ name: 'daimond-kv', version: 2 }] : []);
	return { data, db, api };
}

export function release(how) { const go = how.held || []; how.held = null; go.forEach((f) => f()); }
