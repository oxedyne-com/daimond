// An IndexedDB stand-in for page tests that run the real ChatStore.
/// An IndexedDB held in `data` (store -> Map), shared by every tab made on it. `fx.open`
/// fails that many opens; `fx.mode` 'throw' or 'empty' faults the next `fx.n` read
/// transactions on the chat stores (a read that throws, or WebKit's empty read).
export function fakeIdb(data, fx) {
	const PATHS = { chats: 'id', chatsum: 'id', msgchunks: 'k' };
	const keyOf = (name, v) => PATHS[name] ? v[PATHS[name]] : v.map + '\u0000' + v.id;
	const inRange = (q, k) => q && typeof q === 'object' ? (k >= q.lower && k <= q.upper) : k === q;
	for (const n of ['chats', 'chatsum', 'msgchunks', 'tombs']) if (!data.has(n)) data.set(n, new Map());
	const db = {
		objectStoreNames: { contains: () => true },
		close() {},
		transaction(names, mode) {
			const read = mode !== 'readwrite' && [].concat(names).some((s) => s === 'chats' || s === 'chatsum');
			let empty = false;
			if (read && fx.n > 0) {
				fx.n--;
				if (fx.mode === 'throw') throw Object.assign(new Error('injected read failure'), { name: 'UnknownError' });
				empty = fx.mode === 'empty';
			}
			const ops = [];
			let pending = 0, done = false;
			const t = {};
			const view = (name) => {
				if (empty) return new Map();
				const m = new Map(data.get(name));
				for (const o of ops) if (o.name === name) o.apply(m);
				return m;
			};
			const tryCommit = () => setTimeout(() => {
				if (pending || done) return;
				done = true;
				for (const o of ops) o.apply(data.get(o.name));
				if (t.oncomplete) t.oncomplete();
			}, 0);
			const request = (fn) => {
				const r = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); } };
				pending++;
				queueMicrotask(() => { r.result = fn(); pending--; if (r.onsuccess) r.onsuccess(); r.ls.forEach((f) => f()); tryCommit(); });
				return r;
			};
			t.objectStore = (name) => ({
				get: (k) => request(() => structuredClone(view(name).get(k))),
				getAllKeys: () => request(() => [...view(name).keys()].sort()),
				put(v) { const c = structuredClone(v); ops.push({ name, apply: (m) => m.set(keyOf(name, c), c) }); return request(() => undefined); },
				delete(q) { ops.push({ name, apply: (m) => { for (const k of [...m.keys()]) if (inRange(q, k)) m.delete(k); } }); return request(() => undefined); },
				clear() { ops.push({ name, apply: (m) => m.clear() }); return request(() => undefined); },
				openCursor(q) {
					const r = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); } };
					const rows = [...view(name).entries()].filter(([k]) => q === undefined || inRange(q, k))
						.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => structuredClone(v));
					let i = 0;
					const step = () => {
						pending++;
						queueMicrotask(() => {
							r.result = i < rows.length ? { value: rows[i], continue() { i++; step(); } } : null;
							pending--;
							if (r.onsuccess) r.onsuccess();
							r.ls.forEach((f) => f());
							tryCommit();
						});
					};
					step();
					return r;
				},
			});
			tryCommit();
			return t;
		},
	};
	return { open() {
		const r = { result: undefined, error: null };
		queueMicrotask(() => {
			if (fx.open > 0) { fx.open--; r.error = Object.assign(new Error('Internal error opening backing store'), { name: 'UnknownError' }); if (r.onerror) r.onerror(); return; }
			r.result = Object.create(db);
			if (r.onsuccess) r.onsuccess();
		});
		return r;
	} };
}
