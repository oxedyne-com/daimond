/* ============================================================
   Test -- the two shapes of one Diamond converge (the shape law, F3).
   ------------------------------------------------------------
   THE FAULT (soak, `diamonds/12`). A Diamond travels in one of two shapes:
   inline (its export in the parcel) or a reference (`dataRef`, the bytes in
   chunks). The shape is each device's own choice -- a phone's inline room is a
   quarter of a desktop's -- so a ~30 kB Diamond was a reference from the phone
   and inline from the desktop. Neither side ever adopted the other's shape at an
   equal `touched` (equal stamps "keep what is here"), neither owed the other a
   push once it had pushed its own, and the head was whichever pushed last: both
   shapes stood, each stable, for good, and the soak could not settle.

   THE LAW (`diamondRefStands`, `diamondAdoptsRef`, `diamondInlineSet`,
   daimond.js). At an equal `touched` a reference stands over inline, one way and
   never back until `touched` moves:
     collect  a Diamond whose own manifest stands at its current stamp is not in
              the inline set, though it keeps its place in the order and its room;
     apply    an incoming reference is adopted by a device that holds no manifest
              standing at that stamp, once the tag and link unions have found
              nothing to add.
   Two references at one stamp are one copy told twice (the key hashes the bytes;
   only the chunk addresses differ, and the peer slot looks after those).
   A shape is a join-semilattice on { inline < reference }: join is "stands if
   either side stands", so it is commutative, idempotent and associative, and
   the pair of devices ends on its join.

   WHAT IS CHECKED, through the REAL functions lifted from the tree under test
   (dev/syncprobe.mjs, `TREE=<checkout>` to aim it elsewhere):
     A. the join on all the states a device can be in, commutative, idempotent
        and associative, and the apply decision agrees with it;
     B. the protocol, on 600 generated pairs of devices (caps drawn from a
        phone's, a desktop's and a tiny one, Diamonds of 3 to 200 kB, some with a
        manifest standing, some stale, some none): from EITHER device
        stepping first, the pair is quiet within a few passes, with the same
        shape and the same manifest key for every Diamond on both devices and
        on the head, in a bounded number of pushes (no ping-pong); and the
        collect is a fixed point;
     C. what the law must mean: a reference never goes back to inline at its
        stamp however the cap grows, adopting a reference moves no other Diamond
        (the set before the law is a function of sizes and cap alone), and a
        Diamond whose `touched` moved is a candidate again.
   On 05f63268 (no tie law) B and C fail: `--break` puts the old law back in
   (no sticky reference, no adoption) on the same model.
     node www/js/diamondshape.test.mjs            # ALL PASS
     node www/js/diamondshape.test.mjs --break    # the old law: FAILs
   ============================================================ */
import { makeWindow, sliceDaimond, rng, canon } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const BREAK = process.argv.includes('--break');
if (BREAK) console.log('\n*** RUNNING UNDER --break: the old law (no sticky reference, no adoption); failures below are the point ***');

const w = makeWindow({ now: 1_000_000_000 });
const lifted = sliceDaimond(w, ['diamondRefStands', 'diamondAdoptsRef', 'diamondInlineSet']).fns;
// The old law, for --break: every reference may go back to inline, and no reference is adopted at an equal stamp.
const adoptsRef  = BREAK ? () => false : lifted.diamondAdoptsRef;
const inlineSet  = lifted.diamondInlineSet;
// The collect's closure over a device's manifests, as `collectDiamonds` writes it (inline set only).
const standsOf   = (dev) => (d) => lifted.diamondRefStands(dev.man.get(d.id), d.touched) && !BREAK;

const KB = 1024;
const CAPS = { phone: 256 * KB, desk: 1024 * KB, tiny: 64 * KB };

// ── A device, and the three things it does ─────────────────────────

/// A device holds Diamonds `{ touched, size }` and a manifest per Diamond that it has offloaded or adopted.
function device(name, cap) { return { name, cap, held: new Map(), man: new Map(), seen: 0, last: null }; }
const keyOf = (id, touched) => 'k:' + id + ':' + touched;       // hashes the bytes: the same on every device at one stamp
const fresh = (dev) => [...dev.held].map(([id, h]) => ({ id, touched: h.touched, size: h.size }))
	.sort((a, b) => (b.touched - a.touched) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)));

/// What `collectDiamonds` does, on the real inline set: the parcel entries, and the manifests left behind.
function collect(dev) {
	const list = fresh(dev);
	const inline = inlineSet(list, list.map((d) => d.size), dev.cap, standsOf(dev));
	return list.map((d) => {
		if (inline[d.id]) { dev.man.delete(d.id); return { id: d.id, touched: d.touched, data: 'bytes:' + d.id + ':' + d.touched }; }
		let m = dev.man.get(d.id);
		// The reuse check stands apart from the law: a manifest at this stamp is reused, else the Diamond is offloaded afresh.
		if (!(m && m.touched === d.touched)) {
			m = { key: keyOf(d.id, d.touched), chunks: ['c:' + dev.name + ':' + d.id + ':' + d.touched], touched: d.touched };
			dev.man.set(d.id, m);
		}
		return { id: d.id, touched: d.touched, dataRef: { key: m.key, chunks: m.chunks } };
	});
}
/// What `applyDiamonds` does where the unions find nothing to add: a newer copy is imported (its reference adopted),
/// an equal one adopts a reference by the law, an older one is left.
function apply(dev, entries) {
	for (const r of entries) {
		const mine = dev.held.get(r.id);
		if (!mine || r.touched > mine.touched) {
			dev.held.set(r.id, { touched: r.touched, size: SIZE.get(r.id) });
			if (r.dataRef) dev.man.set(r.id, { key: r.dataRef.key, chunks: r.dataRef.chunks, touched: r.touched });
			continue;
		}
		if (r.touched === mine.touched && adoptsRef(r, dev.man.get(r.id), mine.touched)) {
			dev.man.set(r.id, { key: r.dataRef.key, chunks: r.dataRef.chunks, touched: mine.touched });
		}
	}
}
const SIZE = new Map();
/// Each Diamond's shape in a parcel: inline, or the manifest key it names.
const shapes = (entries) => canon(Object.fromEntries(entries.map((e) => [e.id, e.dataRef ? 'ref:' + e.dataRef.key : 'inline'])));

/// The protocol, reduced: a device takes the head if it has not, collects, and pushes only if its parcel moved
/// against its own last push. `first` steps first. Returns the passes it took to go quiet and the pushes made.
function converge(X, Y, first) {
	const order = first === 'X' ? [X, Y] : [Y, X];
	let head = null, version = 0, pushes = 0, pass = 0;
	for (; pass < 8; pass++) {
		let moved = false;
		for (const dev of order) {
			if (head && head.version > dev.seen) { apply(dev, head.entries); dev.seen = head.version; }
			const p = collect(dev), c = canon(p);
			if (c !== dev.last) { head = { version: ++version, entries: p }; dev.last = c; dev.seen = version; pushes++; moved = true; }
		}
		if (!moved) { pass++; break; }
	}
	return { passes: pass, pushes, head, quiet: pass < 8 };
}

// ── A. The join ────────────────────────────────────────────────────

console.log('\nA. the shape is a join-semilattice, and the apply decision is its join\n');
{
	// A device's state is whether a manifest stands at its Diamond's stamp. An entry is a reference or it is inline.
	const standing = (s) => s ? { key: 'k', chunks: ['c'], touched: 7 } : undefined;
	const ref = { id: 'd', touched: 7, dataRef: { key: 'k', chunks: ['c1'] } }, inl = { id: 'd', touched: 7, data: 'x' };
	const after = (s, entry) => { const here = standing(s); return !!here || adoptsRef(entry, here, 7); };
	const joins = [];
	for (const a of [false, true]) for (const b of [false, true]) joins.push([a, b, a || b]);
	const exch = (a, b) => [after(a, b ? ref : inl), after(b, a ? ref : inl)];
	check('the apply decision is the join: a reference stands if either side stands',
		joins.every(([a, b, j]) => { const [x, y] = exch(a, b); return x === j && y === j; }),
		JSON.stringify(joins.map(([a, b]) => [a, b, exch(a, b)])));
	check('commutative: the two devices end the same whichever of them holds which',
		[[false, true], [true, false]].every(([a, b]) => { const p = exch(a, b), q = exch(b, a); return p[0] === q[1] && p[1] === q[0] && p[0] === p[1]; }));
	check('idempotent: a reference meeting a standing reference changes nothing',
		after(true, ref) === true && after(false, inl) === false);
	check('associative: three devices end on the join, whichever pair meets first',
		[false, true].every((a) => [false, true].every((b) => [false, true].every((c) => {
			const j = a || b || c;
			const ab = after(a, b ? ref : inl), bc = after(b, c ? ref : inl);
			return after(ab, c ? ref : inl) === j && after(a, bc ? ref : inl) === j;
		}))));
	check('an inline entry never adopts anything', adoptsRef(inl, undefined, 7) === false && adoptsRef(inl, standing(true), 7) === false);
	check('a reference with no chunks is not adopted', adoptsRef({ id: 'd', touched: 7, dataRef: { key: 'k', chunks: [] } }, undefined, 7) === false);
	check('a manifest at an older stamp does not stand, and is replaced', adoptsRef(ref, { key: 'o', chunks: ['c'], touched: 3 }, 7) === true);
	check('a manifest at this stamp stands, and is left (two references are one copy)', adoptsRef(ref, standing(true), 7) === false);
}

// ── B. The protocol ────────────────────────────────────────────────

console.log('\nB. two devices of different caps reach one shape and one manifest key, from either order\n');
{
	const r = rng(0xf3a11);
	const TRIALS = 600;
	const bad = { quiet: [], same: [], head: [], push: [], fixed: [], lower: [], order: [] };
	let alike = 0;
	for (let t = 0; t < TRIALS; t++) {
		// The first half are two stores already synced (what the soak had): the same Diamonds at the same stamps,
		// no manifest anywhere, nothing but the caps to tell the devices apart. The rest are drawn freely.
		const synced = t < TRIALS / 2;
		const n = 3 + r.int(12), ids = Array.from({ length: n }, (_, i) => 'd' + String(i).padStart(2, '0'));
		const caps = [r.pick(['phone', 'phone', 'tiny']), r.pick(['desk', 'desk', 'phone'])];
		SIZE.clear();
		const st = {};
		for (const id of ids) {
			SIZE.set(id, (r.chance(0.05) ? 140 + r.int(60) : 3 + r.int(58)) * KB);
			st[id] = synced ? { touched: 1000 + r.int(30), who: 'both', mx: 'none', my: 'none' }
				: { touched: 1000 + r.int(30), who: r.pick(['X', 'Y', 'both', 'both']), mx: r.pick(['none', 'none', 'stands', 'stale']), my: r.pick(['none', 'none', 'stands', 'stale']) };
		}
		const build = () => {
			const X = device('X', CAPS[caps[0]]), Y = device('Y', CAPS[caps[1]]);
			for (const id of ids) {
				const s = st[id];
				for (const [dev, here, m] of [[X, s.who !== 'Y', s.mx], [Y, s.who !== 'X', s.my]]) {
					if (!here) continue;
					dev.held.set(id, { touched: s.touched, size: SIZE.get(id) });
					if (m !== 'none') dev.man.set(id, { key: keyOf(id, s.touched), chunks: ['c:' + dev.name + ':' + id], touched: m === 'stands' ? s.touched : s.touched - 1 });
				}
			}
			return [X, Y];
		};
		const final = {};
		for (const first of ['X', 'Y']) {
			const [X, Y] = build();
			const res = converge(X, Y, first);
			const sx = shapes(collect(X)), sy = shapes(collect(Y)), sh = res.head ? shapes(res.head.entries) : '';
			if (!res.quiet) bad.quiet.push(t + first);
			if (sx !== sy) bad.same.push(t + first + ' ' + caps.join('/') + ' X ' + sx.slice(0, 160) + ' Y ' + sy.slice(0, 160));
			if (res.head && (sx !== sh || sy !== sh)) bad.head.push(t + first);
			if (res.pushes > 4) bad.push.push(t + first + ':' + res.pushes);
			// The collect is a fixed point: a second one is the first, byte for byte.
			if (canon(collect(X)) !== canon(collect(X)) || canon(collect(Y)) !== canon(collect(Y))) bad.fixed.push(t + first);
			// Never lower: a reference that stood on either device, or a Diamond too big to ride inline, ends a reference.
			const end = JSON.parse(sx);
			for (const id of ids) {
				const s = st[id], stood = (s.who !== 'Y' && s.mx === 'stands') || (s.who !== 'X' && s.my === 'stands') || SIZE.get(id) > 128 * KB;
				if (stood && end[id] === 'inline') bad.lower.push(t + first + ' ' + id);
			}
			final[first] = sx;
		}
		// Two synced stores have no history: the end is a function of the caps, whichever device steps first.
		if (synced) { alike++; if (final.X !== final.Y) bad.order.push(t); }
	}
	check(`${TRIALS} pairs go quiet within eight passes from either order`, !bad.quiet.length, bad.quiet.slice(0, 5).join(' '));
	check(`the two devices end with one shape and one manifest key for every Diamond (${bad.same.length} of ${2 * TRIALS} runs differ)`, !bad.same.length, bad.same.slice(0, 2).join(' | '));
	check('the head is that shape too', !bad.head.length, bad.head.slice(0, 5).join(' '));
	check('in at most four pushes: no ping-pong', !bad.push.length, bad.push.slice(0, 5).join(' '));
	check('the collect is a fixed point', !bad.fixed.length, bad.fixed.slice(0, 5).join(' '));
	check('a reference that stood anywhere, or a Diamond too big to ride inline, never ends inline', !bad.lower.length, bad.lower.slice(0, 5).join(' '));
	check(`two synced stores end the same whichever device steps first (${bad.order.length} of ${alike} differ)`, !bad.order.length, bad.order.slice(0, 5).join(' '));
}

// ── C. What the law means ──────────────────────────────────────────

console.log('\nC. one way only: a reference does not go back, and a Diamond that moved is a candidate again\n');
{
	SIZE.clear();
	const mk = (cap, ids, stamp) => { const d = device('X', cap); for (const id of ids) { SIZE.set(id, 30 * KB); d.held.set(id, { touched: stamp, size: 30 * KB }); } return d; };
	const ids = ['a', 'b', 'c', 'd'];
	// The desktop carries all four inline; the phone's reference to `c` arrives and is adopted.
	const D = mk(CAPS.desk, ids, 500);
	const before = collect(D).map((e) => e.data ? 'inline' : 'ref').join();
	apply(D, [{ id: 'c', touched: 500, dataRef: { key: keyOf('c', 500), chunks: ['p'] } }]);
	const after = collect(D);
	check('the desktop carried all four inline', before === 'inline,inline,inline,inline', before);
	check('it adopts the phone\'s reference to `c`, and `c` now leaves as that reference',
		after.find((e) => e.id === 'c').dataRef && after.find((e) => e.id === 'c').dataRef.key === keyOf('c', 500) && after.filter((e) => e.data).length === 3,
		JSON.stringify(after.map((e) => e.id + (e.data ? ':i' : ':r'))));
	// However the cap grows, `c` does not return to inline at its stamp.
	let back = false;
	for (const cap of [CAPS.phone, CAPS.desk, 8 * 1024 * KB]) { D.cap = cap; if (collect(D).find((e) => e.id === 'c').data) back = true; }
	check('it does not go back to inline at that stamp, whatever the cap', !back);
	// A standing reference keeps its place and its room: adopting it moves no other Diamond. The cap fits two 30 kB Diamonds.
	const T = mk(70 * KB, ids, 500);
	const setOf = (dev) => Object.keys(inlineSet(fresh(dev), fresh(dev).map((d) => d.size), dev.cap, standsOf(dev))).sort().join();
	const none = setOf(T);
	T.man.set('a', { key: keyOf('a', 500), chunks: ['c'], touched: 500 });
	const set = setOf(T);
	check('without a standing reference the freshest two ride inline (a, b)', none === (BREAK ? 'a,b' : 'a,b'), none);
	check('with `a` a standing reference only `a` leaves the set: `b` stays, `c` does not move into its room', set === (BREAK ? 'a,b' : 'b'), set);
	// Over generated stores: the set a collect picks differs from the plain greedy set by the standing references only.
	{
		const r = rng(77); let ok = true, detail = '';
		for (let i = 0; i < 400 && ok; i++) {
			const d = device('Z', 32 * KB * (1 + r.int(10)));
			const n = 3 + r.int(10);
			for (let k = 0; k < n; k++) { const id = 'z' + String(k).padStart(2, '0'); SIZE.set(id, (4 + r.int(70)) * KB); d.held.set(id, { touched: 900 - k, size: SIZE.get(id) }); }
			const plain = setOf(d);
			for (const id of d.held.keys()) if (r.chance(0.4)) d.man.set(id, { key: 'k', chunks: ['c'], touched: d.held.get(id).touched });
			const withMan = setOf(d);
			const want = plain.split(',').filter((id) => id && !(d.man.get(id) && !BREAK)).join();
			if (withMan !== want) { ok = false; detail = `plain ${plain} manifests ${[...d.man.keys()]} got ${withMan} want ${want}`; }
		}
		check('over 400 generated stores the inline set is the plain greedy set less the standing references', ok, detail);
	}
	// The Diamond moves: its manifest no longer stands at the new stamp, so it is a candidate again.
	D.held.set('c', { touched: 600, size: 30 * KB });
	const moved = collect(D).find((e) => e.id === 'c');
	check('when `touched` moves the Diamond is inline again on a device with room', !!moved.data && D.man.get('c') === undefined);
	// And with no room at all it leaves as a reference, a fresh one at the new stamp.
	D.cap = 1; D.held.set('c', { touched: 700, size: 30 * KB });
	const short = collect(D).find((e) => e.id === 'c');
	check('with no room it leaves as a fresh reference at the new stamp', !!short.dataRef && D.man.get('c').touched === 700);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
if (failures) process.exitCode = 1;
