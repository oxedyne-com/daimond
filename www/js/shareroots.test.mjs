/* ============================================================
   Test -- `Files.shareRoots` reads the link sidecars once, not once per Diamond
   (UNBLOCK-86 U86-SYNC8, 2 Nov 2026).
   ------------------------------------------------------------
   Runs the REAL `linksByDiamond` and `attachmentsOf` cut out of page/files_tree.js and the REAL `shareRoots` cut
   out of page/files_view.js, over a stand-in wasm app that keeps the store's
   link sidecars and answers `links_touching` and `all_links` as
   src/store/diamond.rs does (the same walk, `other` set by `Link::other`),
   counting every sidecar it reads.

   THE BUG. `shareRoots` called `attachmentsOf` for every Diamond, and each
   `links_touching` walks EVERY Diamond's sidecar: D^2 OPFS reads per call
   (37 Diamonds: 1,369, ~2.6 ms each), twice per sync round (`syncLocNow`, push's
   location check), ~7 s of each gilgamesh round.

   THE FIX. `shareRoots` reads `all_links()` once and groups it per Diamond
   (`linksByDiamond`, bb7e15da9); `attachmentsOf(id, rows)` applies the same rules
   (R2, M1, M3, the trashed Diamond, the nested collapse) to the group. U86R's own
   fix (2232c5277) duplicated it; only this arm is kept, aimed at bb7e15da9's API
   (lead ruling 2 Nov 07:28).

   Asserted: one `shareRoots` over 37 Diamonds reads each sidecar at most once
   (red on b1e262a1e: 37 x 37); and the control, the roots are identical to the
   per-Diamond answer (`attachmentsOf` for each, the old body), and so is each
   Diamond's attachment list, over a fixture with marks in and out of force, a
   daimon's flag, a reversed row, a row in another Diamond's sidecar, nested and
   duplicated paths, an unreachable path, a trashed Diamond and a self-link.
   Run:   node www/js/shareroots.test.mjs [--src <dir holding page/>]
   ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = (() => {
	const i = process.argv.indexOf('--src');
	return i > 0 ? process.argv[i + 1] : HERE;
})();
const D = 37; // his Diamonds on gilgamesh, 2 Nov 2026
const TRASHED = 'd05';
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
function cut(s, from, to) {
	const a = s.indexOf(from), b = s.indexOf(to, a);
	if (a < 0 || b <= a) throw new Error('cannot cut ' + JSON.stringify(from));
	return s.slice(a, b);
}

/// The store: `sidecars[owner]` is that Diamond's `links.jsonl`, in walk order.
function fixture() {
	const ids = [];
	for (let i = 0; i < D; i++) ids.push('d' + String(i).padStart(2, '0'));
	const sc = {};
	const granted = new Set();
	let n = 0;
	const row = (owner, from, to, rel, by, share, grant) => {
		const id = 'l' + (n++);
		(sc[owner] = sc[owner] || []).push({ id, ts: n, from, to, rel, note: '', by, share });
		if (grant) granted.add(id);
	};
	ids.forEach((d, i) => {
		const me = 'diamond:' + d, next = ids[(i + 1) % D];
		row(d, me, 'dir:work/p' + i, 'holds', 'user', true, i % 3 !== 0);         // his mark, waiting on every third
		row(d, me, 'dir:work/p' + i + '/sub', 'holds', 'user', true, true);      // nested under it
		row(d, me, 'file:work/f' + i + '.md', 'consulted', 'user', true, true);  // a file
		row(d, me, 'dir:work/agent' + i, 'holds', 'agent:x', true, true);        // a daimon's flag: no mark
		row(d, 'dir:work/rev' + i, me, 'holds', 'user', true, true);             // reversed row (R2)
		row(next, me, 'dir:work/other' + i, 'holds', 'user', true, true);        // in another's sidecar (R2)
		row(d, me, 'diamond:' + next, 'related', 'user', false, false);          // Diamond to Diamond
		row(d, me, me, 'related', 'user', false, false);                         // self-link
		row(d, me, 'file:diamonds/' + d + '/notes.md', 'holds', 'user', true, true); // own dir (M1)
		row(d, me, 'dir:diamonds/' + TRASHED + '/x', 'holds', 'user', true, true); // under the trashed one
		row(d, me, 'dir:away/p' + i, 'holds', 'user', true, true);               // not reachable here
		row(d, me, 'dir:work/shared', 'holds', 'user', true, i % 2 === 0);       // one path, many Diamonds
		row(d, me, 'dir:work/dup' + i, 'holds', '', true, false);                // pre-`by`, waiting
		row(d, me, 'dir:work/dup' + i, 'holds', 'user', i % 4 !== 0, true);      // same thing, in force (M3)
		row(d, me, 'dir:work/noshare' + i, 'consulted', 'user', false, true);    // no flag
	});
	return { ids, sc, granted };
}

/// One page: the cut source over the stand-in app; `reads` counts sidecars read.
function page(fx) {
	const FT = readFileSync(join(SRC, 'page/files_tree.js'), 'utf8');
	const FV = readFileSync(join(SRC, 'page/files_view.js'), 'utf8');
	const tree = cut(FT, 'export function linksByDiamond', '/// The last `n` segments').replace(/^export /gm, '');
	const roots = cut(FV, 'shareRoots:    async function () {', '\t\tbounds:')
		.replace(/^shareRoots:\s*/, 'var shareRoots = ').replace(/,\s*$/, ';');
	const st = { reads: 0, touching: 0, all: 0 };
	const walk = (f) => { for (const o of Object.keys(fx.sc)) { st.reads++; for (const l of fx.sc[o]) f(o, l); } };
	const app = {
		// diamond.rs `links_touching` + `links_json_among`: `other` per `Link::other`.
		links_touching: async (node) => {
			st.touching++;
			const out = [];
			walk((o, l) => {
				if (l.from !== node && l.to !== node) return;
				out.push(Object.assign({ owner: o }, l, { other: l.from === node ? l.to : l.from }));
			});
			return JSON.stringify(out);
		},
		all_links: async () => {
			st.all++;
			const out = [];
			walk((o, l) => out.push(Object.assign({ owner: o }, l)));
			return JSON.stringify(out);
		},
	};
	const trashed = (id) => id === TRASHED;
	const parseRef = (ref) => {
		const i = (ref || '').indexOf(':');
		return i > 0 ? { kind: ref.slice(0, i), path: ref.slice(i + 1), root: '' } : { kind: '', path: '', root: '' };
	};
	const underPath = (p, r) => !!r && (p === r || p.indexOf(r + '/') === 0);
	// markshere.js `isMark`: the user's holds or consulted on a file or folder, not in its own directory.
	const isUsersMark = (l) => {
		if (!l || (l.rel !== 'holds' && l.rel !== 'consulted')) return false;
		if (l.by !== 'user' && l.by !== '' && l.by !== undefined) return false;
		const p = parseRef(l.to);
		return (p.kind === 'file' || p.kind === 'dir') && !underPath(p.path, 'diamonds/' + l.owner);
	};
	// `markForce`: the owner's own row, pressed on this device; the share needs both.
	const markForce = (owner, l) => {
		if (!owner || !l || trashed(owner) || !isUsersMark(l)) return null;
		if (l.owner !== owner || l.from !== 'diamond:' + owner || !fx.granted.has(l.id)) return null;
		return { rel: l.rel, share: l.share === true };
	};
	const ctx = {
		pg: { diamonds: fx.ids.map((id) => ({ id })) },
		diamondApp: () => app, trashed, parseRef, underPath, isUsersMark, markForce,
		markInForce: (l) => !!l && !!markForce(l.owner, l),
		markWaiting: (l) => isUsersMark(l) && !trashed(l.owner) && l.from === 'diamond:' + l.owner && !markForce(l.owner, l),
		refReachable: (ref) => parseRef(ref).path.indexOf('away/') !== 0,
		refWhere: () => '',
		underTrashedDiamond: (p) => underPath(p, 'diamonds/' + TRASHED),
	};
	vm.createContext(ctx);
	vm.runInContext(tree + '\n' + roots + '\nthis.api = { attachmentsOf, shareRoots,'
		+ ' linksByDiamond: typeof linksByDiamond === "function" ? linksByDiamond : null };', ctx);
	return { api: ctx.api, st, pg: ctx.pg, ctx };
}

const fx = fixture();
const sidecars = Object.keys(fx.sc).length;
const p = page(fx);
const got = await p.api.shareRoots();
const reads = p.st.reads;
console.log('  shareRoots over ' + D + ' Diamonds: ' + reads + ' sidecar reads (' + p.st.touching
	+ ' links_touching, ' + p.st.all + ' all_links); ~' + Math.round(reads * 2.6) + ' ms at 2.6 ms a read; roots '
	+ createHash('sha256').update(JSON.stringify(got)).digest('hex').slice(0, 12));
check('one shareRoots reads each sidecar at most once', reads <= sidecars, reads + ' reads of ' + sidecars + ' sidecars');

// The control: the per-Diamond answer, `attachmentsOf` for each, as the old body asked it.
const q = page(fx);
const want = [];
for (const d of q.pg.diamonds) {
	if (q.ctx.trashed(d.id)) continue;
	for (const a of await q.api.attachmentsOf(d.id)) {
		if (a.here === false || !a.path || !a.share || !q.ctx.markInForce(a.link)) continue;
		if (want.indexOf(a.path) < 0) want.push(a.path);
	}
}
want.sort();
const wantRoots = want.filter((x, i) => !want.slice(0, i).some((y) => x === y || x.indexOf(y + '/') === 0));
check('the roots are identical to the per-Diamond answer', JSON.stringify(got) === JSON.stringify(wantRoots),
	'got ' + got.length + ', want ' + wantRoots.length);
check('the fixture exercises the rules', got.length > D && got.indexOf('work/shared') >= 0
	&& !got.some((x) => /agent|rev|other|away|diamonds\//.test(x)) && got.indexOf('work/p0') < 0
	&& got.indexOf('work/p0/sub') >= 0 && got.indexOf('work/p1') >= 0 && got.indexOf('work/p1/sub') < 0
	&& got.indexOf('work/dup1') >= 0 && got.indexOf('work/dup0') < 0 && got.indexOf('work/noshare1') < 0,
	got.length + ' roots');

// Each Diamond's list from the one read equals its own `links_touching` answer, row for row.
if (q.api.linksByDiamond) {
	const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x))
		? Object.keys(x).sort().reduce((o, kk) => { o[kk] = x[kk]; return o; }, {}) : x);
	const by = q.api.linksByDiamond(JSON.parse(await q.ctx.diamondApp().all_links() || '[]'));
	const diff = [];
	for (const d of q.pg.diamonds) {
		if (canon(await q.api.attachmentsOf(d.id, by[d.id] || [])) !== canon(await q.api.attachmentsOf(d.id))) diff.push(d.id);
		const raw = JSON.parse(await q.ctx.diamondApp().links_touching('diamond:' + d.id));
		if (canon(raw) !== canon(by[d.id] || [])) diff.push(d.id + '(links)');
	}
	check('each Diamond\'s attachments and links from the one read equal its own answer', diff.length === 0, diff.join(' '));
} else check('linksByDiamond exists', false, 'not in this source');

if (failures) { console.log(failures + ' FAIL'); process.exit(1); }
console.log('all ok');
