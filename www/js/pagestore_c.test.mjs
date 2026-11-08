/* ============================================================
   Test — PAGESTORE C: no row the daimond-kv store writes reaches the piece limit.
   ------------------------------------------------------------
   durable.js wrote the cloud index map WHOLE as one value on every change, and a
   share envelope (up to 3 MiB) as one value: past Chrome's wrap threshold that commit
   went down the blob path that never called back on Chrome 153 (Q1108-045).

   Here the REAL durable.js runs over an in-memory IndexedDB that measures every put
   with V8's own serialiser and, like that Chrome, never commits a transaction holding
   a value over the threshold. Checked: a map over the limit, with one entry over it
   alone, round-trips through `update` and `get` with no put at or over the policy's
   piece size; a change writes only its own entry; an old whole map is split once with
   nothing lost; a 300 KB value round-trips through `set` and is gone after `del`.

     node www/js/pagestore_c.test.mjs
   ============================================================ */
import v8 from 'node:v8';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t27Tree } from './test/t27.mjs';
import { enc, dec, cmp, inRange, isRange } from './test/idbkeys.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAP  = 65536;	// Chrome's kIDBWrapThreshold
const PIECE = 32768;	// the policy's store_piece_bytes as shipped
const KEY   = 'daimond-cloud-index';
const MERGED = 'daimond-cloud-merged';
const TOMBS = 'daimond-cloud-tombs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const first = (k) => Array.isArray(k) ? k[0] : k;

/// One object store in `data` at version `data.ver`; a transaction's writes land when it
/// commits, and one holding a put over WRAP never commits. An open at a lower version
/// fails with VersionError; one at a higher version sends `versionchange` to every open
/// connection and runs the upgrade in its own transaction.
function fakeIdb(data) {
	const puts = [];
	const soon = (fn) => setTimeout(fn, 0);
	if (data.ver === undefined) data.ver = data.size ? 1 : 0;
	data.conns = data.conns || new Set();
	const transaction = (landed) => {	// `landed`: the open's own hook, apart from the page's oncomplete, as a browser keeps it
			const ops = [];
			let open = 0, over = false, wedged = false;
			const tx = {};
			const view = () => { const m = new Map(data); for (const o of ops) o(m); return m; };
			const commit = () => {
				if (over || open) return;
				over = true;
				if (wedged) return;	// Chrome 153: the commit never calls back
				for (const o of ops) o(data);
				if (tx.oncomplete) tx.oncomplete();
				if (landed) landed();
			};
			const request = (work) => {
				const rq = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); }, onsuccess: null, result: undefined };
				open++;
				soon(() => {
					open--;
					work(rq);
					if (rq.onsuccess) rq.onsuccess(); rq.ls.forEach((f) => f());
					soon(commit);
				});
				return rq;
			};
			soon(commit);
			const os = {
				get: (k) => request((rq) => { rq.result = view().get(enc(k)); }),
				put: (v, k) => request(() => {
					const n = v8.serialize(v).length;
					puts.push({ k, n });
					if (n > WRAP) wedged = true;
					ops.push((m) => m.set(enc(k), structuredClone(v)));
				}),
				delete: (k) => request(() => ops.push((m) => {
					if (isRange(k)) { for (const x of [...m.keys()]) if (inRange(k, dec(x))) m.delete(x); }
					else m.delete(enc(k));
				})),
				openCursor: (r) => {
					const rq = { ls: [], addEventListener(e, f) { if (e === 'success') this.ls.push(f); }, onsuccess: null, result: null };
					let last, seen = -1, m = null, keys = null;
					const step = () => { const q = request((q1) => {
						if (seen !== ops.length) { seen = ops.length; m = view(); keys = [...m.keys()].map(dec).filter((x) => inRange(r, x)).sort(cmp); }
						const k = keys.find((x) => last === undefined || cmp(x, last) > 0);
						last = k;
						q1.result = k === undefined ? null : { key: k, value: m.get(enc(k)), continue: step };
					}); q.onsuccess = () => { rq.result = q.result; if (rq.onsuccess) rq.onsuccess(); rq.ls.forEach((f) => f()); }; };
					step();
					return rq;
				},
			};
			tx.objectStore = () => os;
			tx.abort = () => { if (over) return; over = true; if (tx.onabort) tx.onabort(); };
			return tx;
	};
	const connect = () => {
		const db = { objectStoreNames: { contains: () => data.ver > 0 }, createObjectStore() {}, transaction: () => transaction(),
			closed: false, close() { db.closed = true; data.conns.delete(db); } };
		return db;
	};
	return {
		puts,
		api: { open(name, ver) {
			const r = { result: undefined, error: null };
			soon(() => {
				if (ver < data.ver) { r.error = { name: 'VersionError' }; if (r.onerror) r.onerror(); return; }
				const db = connect();
				const ok = () => { data.conns.add(db); r.result = db; if (r.onsuccess) r.onsuccess(); };
				if (ver === data.ver) return ok();
				for (const c of [...data.conns]) if (c.onversionchange) c.onversionchange({ oldVersion: data.ver, newVersion: ver });
				if (data.conns.size) { if (r.onblocked) r.onblocked(); return; }
				r.result = db;
				r.transaction = transaction(() => { data.ver = ver; ok(); });
				if (r.onupgradeneeded) r.onupgradeneeded({ oldVersion: data.ver, newVersion: ver });
			});
			return r;
		} },
	};
}

/// A page holding the REAL durable.js over `data`.
function page(data, root = HERE, box = new Map()) {
	const idb = fakeIdb(data);
	const win = {
		indexedDB: idb.api,
		IDBKeyRange: { bound: (lower, upper, lo, uo) => ({ lower, upper, lowerOpen: !!lo, upperOpen: !!uo }) },
		DaimondPolicy: { storePieceBytes: () => PIECE, storeWaitMs: () => 20000 },
	};
	const local = { getItem: (k) => box.has(k) ? box.get(k) : null, setItem: (k, v) => box.set(k, String(v)), removeItem: (k) => box.delete(k) };
	// t27's tree predates the shared store wait.
	if (existsSync(join(root, 'storewait.js'))) new Function('window', readFileSync(join(root, 'storewait.js'), 'utf8'))(win);
	new Function('window', 'localStorage', readFileSync(join(root, 'durable.js'), 'utf8'))(win, local);
	// The page's own cloud.js over this durable store, booted; the box path is the plain one.
	win.DaimondStore = { get: (k, d) => box.has(k) ? JSON.parse(box.get(k)) : d, set: (k, v) => (box.set(k, JSON.stringify(v)), true) };
	const cloud = async () => {
		const body = readFileSync(join(root, 'cloud.js'), 'utf8');
		new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console',
			'with (window) {\n' + body + '\n}')(win, local, { storage: {} }, setTimeout, clearTimeout,
			{ log() {}, debug() {}, warn() {}, error() {} });
		await win.DaimondCloud.ready();
		return win.DaimondCloud;
	};
	return { D: win.DaimondDurable, puts: idb.puts, cloud };
}
const t27 = (data, box) => page(data, join(t27Tree(), 'www/js'), box);

const manifest = (i, chunks) => ({ size: i * 1000, hash: 'h' + String(i).padStart(63, '0'),
	chunks: Array.from({ length: chunks }, (_, j) => ({ addr: 'a' + i + '-' + String(j).padStart(60, '0'), size: 65536 })) });
const big = () => { const m = {}; for (let i = 0; i < 1500; i++) m['docs/file-' + i + '.md'] = manifest(i, 2); m['video/huge.mp4'] = manifest(9, 900); return m; };
// A wedged commit never calls back: false after 15 s, as a failed write.
const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(false), 15000))]);
const worst = (p) => p.puts.reduce((a, x) => Math.max(a, x.n), 0);
const same = (a, b) => JSON.stringify(a, Object.keys(a || {}).sort()) === JSON.stringify(b, Object.keys(b || {}).sort())
	&& Object.keys(a || {}).every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

// A map over the limit, and one entry over it alone, round-trips.
{
	const data = new Map();
	const want = big();
	check('the map is over the limit whole', v8.serialize(want).length > WRAP, v8.serialize(want).length + ' bytes');
	check('and one entry is over it alone', v8.serialize(want['video/huge.mp4']).length > PIECE);
	const p = page(data);
	const ops = {};
	for (const k of Object.keys(want)) ops[k] = { v: want[k] };
	const r = await within(p.D.update(KEY, ops));
	check('the map is stored', !!(r && r.ok), JSON.stringify(r && r.ok));
	check('update answers the whole stored map', !!(r && r.value) && same(r.value, want));
	check('no put at or over the piece size', worst(p) < PIECE, worst(p) + ' bytes');
	const q = page(data);
	check('a fresh page reads the map back whole', same(await q.D.get(KEY), want));
	// A change writes only its own entry.
	const n0 = q.puts.length;
	const r2 = await q.D.update(KEY, { 'docs/new.md': { v: manifest(7, 1) }, 'docs/file-3.md': { del: 1 } });
	check('a change is stored', !!(r2 && r2.ok));
	check('and writes only its own entry', q.puts.length - n0 === 1, (q.puts.length - n0) + ' puts');
	const after = await page(data).D.get(KEY);
	check('the change reads back', !!after && !!after['docs/new.md'] && !('docs/file-3.md' in after) && Object.keys(after).length === Object.keys(want).length);
}

// The version fence: the upgrade to v2 lays out every row the older build wrote, in
// one transaction; the t27 page open beside it is closed, and can then neither open
// the store nor read or write a piece of it.
{
	const data = new Map();
	const old = {};
	for (let i = 0; i < 40; i++) old['old/' + i] = manifest(i, 1);
	data.set(KEY, structuredClone(old));		// as t27 wrote it, whole
	data.set(MERGED, { v: 7 });					// whole at mailbox version 7
	data.set(TOMBS, { 'old/x': { at: 1 } });
	const box = new Map([['daimond-cloud-merged-seen', '1']]);	// this device wrote the mark
	const T = t27(data, box);
	await T.D.ready();
	check('a t27 tab has the v1 store open', T.D.durable());
	const p = page(data, HERE, box);
	check('the old whole map reads as it stands', same(await p.D.get(KEY), old));
	check('the upgrade closed the t27 tab', !T.D.durable());
	const head = data.get(KEY);
	check('the upgrade laid the map out as entry rows', !!head && head.d === 1 && head.map === 1, JSON.stringify(head).slice(0, 80));
	check('and the mark reads as it was', (await p.D.get(MERGED)).v === 7);
	const r = await p.D.update(KEY, { 'new/1': { v: manifest(1, 1) } });
	check('a change after it is stored', !!(r && r.ok));
	const got = await page(data).D.get(KEY);
	check('with every old entry and the new one', !!got && same(got, Object.assign({}, old, { 'new/1': manifest(1, 1) })));
	check('no put at or over the piece size in the upgrade', worst(p) < PIECE, worst(p) + ' bytes');
	// The t27 tab's next call, or a rollback to t27.
	const rows = JSON.stringify([...data.entries()]);
	check('t27 reads no index from the store', (await T.D.get(KEY)) === null);
	check('t27 cannot open it', !T.D.durable() && data.ver === 2);
	const w = await T.D.update(KEY, (st) => Object.assign({}, st || {}, { 'docs/t27.md': manifest(2, 1) }));
	check('a t27 write lands in its box, not the store', !!(w && w.ok) && JSON.stringify([...data.entries()]) === rows);
	const R = t27(data, box);
	const cloud = await R.cloud();
	check('a rolled-back t27 page is not whole at any version', cloud.wholeAt() === -1, 'wholeAt=' + cloud.wholeAt());
	check('and reads no paths out of the pieces', !Object.keys(cloud.index()).some((k) => k.startsWith('old/') || k === 'd' || k === 'map'), JSON.stringify(cloud.index()).slice(0, 80));
	check('nothing in the store moved', JSON.stringify([...data.entries()]) === rows);
}

// A single value over the limit (a share envelope) round-trips, and goes with `del`.
{
	const data = new Map();
	const env = 'E'.repeat(300 * 1024);
	const p = page(data);
	check('a 300 KB value is stored', await within(p.D.set('shenv/a1', env)));
	check('no put at or over the piece size', worst(p) < PIECE, worst(p) + ' bytes');
	check('it reads back whole', (await page(data).D.get('shenv/a1')) === env);
	check('a neighbour key is untouched', (await p.D.set('shenv/a10', 'x')) && (await p.D.get('shenv/a10')) === 'x');
	await p.D.del('shenv/a1');
	check('del leaves no row of it', ![...data.keys()].some((k) => first(dec(k)) === 'shenv/a1'), [...data.keys()].length + ' rows');
	check('and the neighbour stays', (await p.D.get('shenv/a10')) === 'x');
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
