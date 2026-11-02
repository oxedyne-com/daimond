/* ============================================================
   U86 (CPU half) -- the links mark and the one read of the graph.
   ------------------------------------------------------------
   THE BURST (1 Nov 2026). A sync collect asked for every Diamond's
   links once per Diamond (`Files.shareRoots`), and each ask read every
   sidecar: 31 Diamonds, ~961 sidecar opens per collect, and the tab at
   40-90% CPU through a sync while a turn ran. The wasm now keeps one
   index and trusts it while `localStorage['daimond-links-mark']` stands
   (`diamond::indexed_links`; its native arm is links_index_tests.rs).

   Asserted, over the REAL www/js/filelock.js and files_tree.js:
   (a) a page write that lands on a link sidecar moves the mark, after
       its close, to a value never seen before; one elsewhere does not;
   (b) a held removal and a discarded write's removal move it too;
   (c) `bearsOnLinks` is the wasm's `bears_on_links`, over its table;
   (d) `linksByDiamond` gives each Diamond exactly what
       `links_touching('diamond:<id>')` answers, `other` included;
   (e) `shareRoots`, which read the links once per Diamond, is gone (UNBLOCK-82).

   Run:   node www/js/u86links.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';

const LOCK = readFileSync(new URL('./filelock.js', import.meta.url), 'utf8');
const TREE = readFileSync(new URL('./page/files_tree.js', import.meta.url), 'utf8');
const VIEW = readFileSync(new URL('./page/files_view.js', import.meta.url), 'utf8');
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

function fakeStorage() {
	const m = new Map();
	return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k) };
}
function load(ls) {
	const win = {};
	new Function('window', 'navigator', 'AbortSignal', 'localStorage', LOCK)(win, {}, AbortSignal, ls);
	return win.DaimondFileLock;
}
const fakeWritable = (rec) => ({
	write: async () => {}, close: async () => { rec.push('close'); }, abort: async () => { rec.push('abort'); },
});
const KEY = 'daimond-links-mark';
const SIDE = 'diamonds/d1/.daimond/links.jsonl';

// (a) A write's close moves the mark once it has landed, to a fresh value.
{
	const ls = fakeStorage();
	const L = load(ls);
	check('(a) filelock publishes bearsOnLinks and linksChanged',
		L && typeof L.bearsOnLinks === 'function' && typeof L.linksChanged === 'function');
	const seen = new Set();
	for (let i = 0; i < 3; i++) {
		const rec = [];
		const w = await L.writable(SIDE, async () => fakeWritable(rec));
		const before = ls.getItem(KEY);
		await w.write('x');
		check('(a) not moved before the close, write ' + i, ls.getItem(KEY) === before);
		await w.close();
		const after = ls.getItem(KEY);
		check('(a) moved after the close to a value never seen, write ' + i,
			after !== null && after !== before && !seen.has(after), String(after));
		seen.add(after);
	}
	const still = ls.getItem(KEY);
	const w = await L.writable('diamonds/d1/.daimond/log', async () => fakeWritable([]));
	await w.close();
	check('(a) a write that is no sidecar leaves the mark', ls.getItem(KEY) === still);
	const ab = await L.writable(SIDE, async () => fakeWritable([]));
	await ab.abort();
	check('(a) an aborted write leaves the mark', ls.getItem(KEY) === still);

	// (b) Removals.
	await L.hold(SIDE, async () => true);
	const held = ls.getItem(KEY);
	check('(b) a held act on a sidecar moves the mark', held !== still);
	const d = await L.writable('diamonds/d2/.daimond/links.jsonl', async () => fakeWritable([]));
	await d.discard(async () => true);
	check('(b) a discarded write that removes its stub moves the mark', ls.getItem(KEY) !== held);
}

// (c) The wasm's rule, over the table of links_index_tests.rs.
{
	const L = load(fakeStorage());
	const yes = ['', 'diamonds', 'diamonds/x', 'diamonds/x/.daimond', 'diamonds/x/.daimond/links.jsonl',
		'/diamonds/x/.daimond/links.jsonl'];
	const no = ['diamonds/x/.daimond/log', 'diamonds/x/notes.md', 'other/x', 'diamonds/x/y/.daimond'];
	for (const k of yes) check('(c) bears: ' + JSON.stringify(k), typeof L.bearsOnLinks === "function" && L.bearsOnLinks(k) === true);
	for (const k of no) check('(c) does not bear: ' + JSON.stringify(k), typeof L.bearsOnLinks === "function" && L.bearsOnLinks(k) === false);
}

// (d) linksByDiamond against links_touching's answer, per Diamond.
{
	const m = TREE.match(/export function linksByDiamond\(rows\) \{[\s\S]*?\n\}\n/);
	check('(d) files_tree.js has linksByDiamond', !!m);
	if (m) {
		const linksByDiamond = new Function(m[0].replace('export ', '') + '\nreturn linksByDiamond;')();
		const rows = [
			{ owner: 'a', id: '1', from: 'diamond:a', to: 'file:docs/x.md', share: true },
			{ owner: 'a', id: '2', from: 'diamond:a', to: 'diamond:b' },
			{ owner: 'b', id: '3', from: 'url:https://e.org', to: 'diamond:b' },
			{ owner: 'c', id: '4', from: 'diamond:c', to: 'diamond:c' },
			{ owner: 'c', id: '5', from: 'file:y', to: 'dir:z' },
		];
		// What links_touching('diamond:<id>') answers: each row touching it, in store order, with
		// `other` the end that is not it (from first, as `Link::other`).
		function touching(id) {
			const n = 'diamond:' + id;
			return rows.filter((l) => l.from === n || l.to === n)
				.map((l) => Object.assign({}, l, { other: l.from === n ? l.to : l.from }));
		}
		const by = linksByDiamond(rows);
		for (const id of ['a', 'b', 'c', 'zz']) {
			const got = JSON.stringify(by[id] || []), want = JSON.stringify(touching(id));
			check('(d) Diamond ' + id + ' as links_touching answers', got === want, got + ' vs ' + want);
		}
	}
}

// (e) The per-Diamond read is gone with the folder-share walk (UNBLOCK-82 removed `shareRoots`).
{
	check('(e) no Files method walks the Diamonds for their links', VIEW.indexOf('shareRoots:') < 0);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall ok');
process.exit(failures ? 1 : 0);
