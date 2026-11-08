// The in-memory IndexedDB the ChatStore arms run the real page against (PAGESTORE B,
// and the stall arm), and a page (a tab) built on it.
import v8 from 'node:v8';
import { makeWindow, loadScript } from '../../../dev/syncprobe.mjs';
import { loadPage } from './page.mjs';
import { t27Tree } from './t27.mjs';

export const WRAP = 65536;	// Chrome's kIDBWrapThreshold
export const WAIT = 200;	// ms: the policy's store wait for these arms

/// An IndexedDB held in `data` (store -> Map), shared by every page made on it. A
/// transaction's writes land when it commits; one holding a put over WRAP never does, nor
/// one aborted. While `data.failPut(store, value)` answers true, that put throws at once,
/// as IndexedDB's does on a value it cannot clone.
export function fakeIdb(data, gate = (fn) => fn()) {
	const puts = [];
	const PATHS = { chats: 'id', chatsum: 'id', msgchunks: 'k' };
	const keyOf = (name, v) => PATHS[name] ? v[PATHS[name]] : v.map + '\u0000' + v.id;
	const inRange = (q, k) => q && typeof q === 'object' ? (k >= q.lower && k <= q.upper) : k === q;
	for (const n of ['chats', 'chatsum', 'msgchunks', 'tombs']) if (!data.has(n)) data.set(n, new Map());
	const db = {
		objectStoreNames: { contains: () => true },
		close() {},
		transaction(names) {
			if (data.callers) data.callers.push(new Error().stack.split('\n')[2] || '');	// the gate's: who opened it
			const ops = [];
			let pending = 0, over = false, done = false, aborted = false;
			const t = {};
			const view = (name) => {
				const m = new Map(data.get(name));
				for (const o of ops) if (o.name === name) o.apply(m);
				return m;
			};
			const tryCommit = () => setTimeout(() => gate(() => {
				if (pending || done || over) return;
				done = true;
				for (const o of ops) o.apply(data.get(o.name));
				if (t.oncomplete) t.oncomplete();
			}), 0);
			const request = (fn) => {
				const r = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); } };
				pending++;
				queueMicrotask(() => gate(() => { r.result = fn(); pending--; if (r.onsuccess) r.onsuccess(); r.ls.forEach((f) => f()); tryCommit(); }));
				return r;
			};
			t.abort = () => {
				if (done || aborted) throw Object.assign(new Error('the transaction is over'), { name: 'InvalidStateError' });
				over = aborted = true;
				t.error = null;
				setTimeout(() => { if (t.onabort) t.onabort(); }, 0);
			};
			t.objectStore = (name) => ({
				get: (k) => request(() => structuredClone(view(name).get(k))),
				getAllKeys: () => request(() => [...view(name).keys()].sort()),
				put(v) {
					if (data.failPut && data.failPut(name, v)) { const e = new Error('could not be cloned'); e.name = 'DataCloneError'; throw e; }
					const size = v8.serialize(v).length;
					puts.push({ name, key: keyOf(name, v), size });
					if (size >= WRAP) over = true;
					const c = structuredClone(v);
					ops.push({ name, apply: (m) => m.set(keyOf(name, c), c) });
					return request(() => undefined);
				},
				delete(q) {
					ops.push({ name, apply: (m) => { for (const k of [...m.keys()]) if (inRange(q, k)) m.delete(k); } });
					return request(() => undefined);
				},
				clear() { ops.push({ name, apply: (m) => m.clear() }); return request(() => undefined); },
				openCursor(q) {
					const r = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); } };
					const rows = [...view(name).entries()].filter(([k]) => q === undefined || inRange(q, k))
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => structuredClone(v));
					let i = 0;
					const step = () => {
						pending++;
						queueMicrotask(() => gate(() => {
							r.result = i < rows.length ? { value: rows[i], continue() { i++; step(); } } : null;
							pending--;
							if (r.onsuccess) r.onsuccess();
							r.ls.forEach((f) => f());
							tryCommit();
						}));
					};
					step();
					return r;
				},
			});
			tryCommit();
			return t;
		},
	};
	return {
		puts,
		// At `data.ver` (an untouched store is a v3 one); a lower version fails with
		// VersionError, a higher one closes every open connection and upgrades.
		idb: { open(name, ver) {
			const r = { result: undefined, error: null };
			if (data.ver === undefined) data.ver = 3;
			data.conns = data.conns || new Set();
			queueMicrotask(() => gate(() => {
				if (ver < data.ver) { r.error = { name: 'VersionError' }; if (r.onerror) r.onerror(); return; }
				const c = Object.assign(Object.create(db), { close() { data.conns.delete(c); } });
				if (ver > data.ver) {
					for (const o of [...data.conns]) if (o.onversionchange) o.onversionchange({ oldVersion: data.ver, newVersion: ver });
					if (data.conns.size) { if (r.onblocked) r.onblocked(); return; }
					r.result = c;
					if (r.onupgradeneeded) r.onupgradeneeded({ oldVersion: data.ver, newVersion: ver });
					data.ver = ver;
				}
				data.conns.add(c);
				r.result = c;
				if (r.onsuccess) r.onsuccess();
			}));
			return r;
		} },
	};
}

/// A fresh page (a tab) on the database `data`, built from `makeWindow` and `loadPage`
/// (this tree's, or an older build's).
export function page(data, mk = makeWindow, load = loadPage, gate, wait = WAIT) {
	const fake = fakeIdb(data, gate);
	const errors = [];
	const w = mk({ now: Date.now() });
	w.indexedDB = fake.idb;
	w.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
	w.setTimeout = setTimeout;
	w.clearTimeout = clearTimeout;
	w.DaimondI18n = { t: (k) => k };
	w.DaimondPolicy = { storeWaitMs: () => wait, storePieceBytes: () => 32768, tombTtlMs: () => 37 * 86400e3 };
	loadScript(w, 'storewait.js');	// this tree's: t27's ChatStore does not read it
	w.console = { log() {}, debug() {}, info() {}, warn() {}, error(...a) { errors.push(a.join(' ')); } };
	const el = () => ({ style: {}, children: [], setAttribute() {}, addEventListener() {},
		appendChild(c) { this.children.push(c); return c; }, removeChild(c) { return c; }, querySelector: () => null });
	w.document = { body: el(), createElement: el, hidden: false, visibilityState: 'visible', cookie: '' };
	const P = load({ window: w, want: ['ChatStore'] });
	return { ChatStore: P.ChatStore, puts: fake.puts, errors, window: w };
}
/// A t27 page on `data`: the build a rollback went to.
export async function t27Page(data) {
	const root = t27Tree();
	const { makeWindow: mk } = await import(root + '/dev/syncprobe.mjs');
	const { loadPage: load } = await import(root + '/www/js/test/page.mjs');
	return page(data, mk, load);
}

