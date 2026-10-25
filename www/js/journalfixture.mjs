// www/js/journalfixture.mjs -- the REAL journal.js in a node sandbox, over an in-memory IndexedDB
// (QA ccp3 A R2: a test that stubbed `journalQueue` could not see a queue that never reached disk).
//   fakeIDB()                 one database per name, one store with a `by_stream` index
//   tabJournal(idb, locks)    a tab's DaimondJournal; `locks` is the Set of Web Lock names held,
//                             shared between the tabs of one test (a tab dies when its name goes)
//   journalQueueOver(src, J)  daimond.js's real `journalQueue` writing to journal `J`
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { liftFn } from './testlift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const JSRC = readFileSync(join(HERE, 'journal.js'), 'utf8');

export function fakeIDB() {
	const dbs = {};
	const cursor = (list, rows) => {
		const req = {};
		let i = 0;
		const step = () => {
			if (i < list.length) {
				const row = list[i];
				req.result = { value: row, delete() { const at = rows.indexOf(row); if (at >= 0) rows.splice(at, 1); }, continue() { i++; setTimeout(step, 0); } };
			} else req.result = null;
			if (req.onsuccess) req.onsuccess();
		};
		setTimeout(step, 0);
		return req;
	};
	const makeDb = () => {
		const rows = []; let k = 0, made = false;
		return { rows,
			objectStoreNames: { contains: () => made },
			createObjectStore() { made = true; return { createIndex() {} }; },
			transaction() {
				const t = {};
				const store = {
					add(e) { rows.push(Object.assign({}, e, { k: ++k })); },
					clear() { rows.length = 0; },
					openCursor() { return cursor(rows.slice(), rows); },
					index() { return { openCursor: (range) => cursor(rows.filter((r) => r.stream === range.only), rows) }; },
				};
				t.objectStore = () => store;
				setTimeout(() => { if (t.oncomplete) t.oncomplete(); }, 0);
				return t;
			},
			close() {} };
	};
	return { dbs, open(name) {
		const req = {};
		setTimeout(() => {
			let d = dbs[name]; const fresh = !d;
			if (!d) d = dbs[name] = makeDb();
			req.result = d;
			if (fresh && req.onupgradeneeded) req.onupgradeneeded();
			if (req.onsuccess) req.onsuccess();
		}, 0);
		return req;
	} };
}
/// A tab's journal: journal.js run over `idb`, with Web Locks shared through `locks` (the names held).
export function tabJournal(idb, locks) {
	const win = {};
	const nav = { locks: {
		request(name, fn) { locks.add(name); return Promise.resolve(fn({ name })); },
		query: async () => ({ held: [...locks].map((name) => ({ name })) }),
	} };
	new Function('window', 'indexedDB', 'IDBKeyRange', 'navigator', JSRC)(win, idb, { only: (v) => ({ only: v }) }, nav);
	return win.DaimondJournal;
}

/// The real `journalQueue` (and `queuedText`), lifted from `src`, writing to journal `J`.
export function journalQueueOver(src, J) {
	return new Function('window', 'DaimondJournal', liftFn(src, 'queuedText') + '\n' + liftFn(src, 'journalQueue') + '\nreturn journalQueue;')({ DaimondJournal: J }, J);
}
