/* ============================================================
   Test — a Diamond edit is replaced by another device's copy only when
   that copy was built on it, and a two-sided merge carries what either
   side took off (lanes DIA, DIA2, 2026-09-27; split checks D1, D2; QDIA
   F1, F2, F4, F5, F6).
   ------------------------------------------------------------
   THE BUG. `applyDiamonds` read an arrival as one-sided when this
   device's stamp equalled its fork point, and the fork point moved on
   every landed push. D1: the landing read the live store, so an edit
   made while the push flew was recorded as agreed and the other device's
   next copy replaced it with nothing kept. D2: even from the parcel, a
   landed push says "the mailbox took my copy", not "the other device
   holds it". Round 1's one-hop `base` then read a copy two hops down from
   this device's edit, or reaching a creator that never received one, as
   a conflict (F1); and every conflict UNIONED tags and links, so a mark
   taken off on one device came back (F2), and a rename in the losing edit
   survived nowhere (F4).

   THE FIX. Each entry carries its copy's lineage (`anc`, the stamps it
   descends from, at most 16); a device records its copy's lineage and what
   it last received (`daimond-diamond-recv`, `[s, c, anc]`). An arrival is
   two-sided when this device moved since its receipt and the arrival's
   lineage holds no copy this device is holding. The tags, links, name and
   grants of the copies a device sent and received are recorded
   (`daimond-diamond-seen`), and a conflict settles them three-way against
   the newest copy in the arrival's lineage it holds a record of.

   WHAT IS CHECKED, with the real daimond.js closure lifted
   (`applyDiamonds`, `entryLineage`, `recordDiamondCopies`, `syncForkPoint`,
   `commitDiamondBaseline`, `readDiamondRecv`) over a fake store that
   models the import contract (`keep_conflict` keeps the loser as a
   version; a tag, name, grant or link write moves the stamp). Devices
   exchange parcels by hand, so each shape is exactly the one named.

   Run:  node www/js/diamondrecv.test.mjs
         node www/js/diamondrecv.test.mjs --break legacy     (5.2.1: no lineage, fork from the live list)
         node www/js/diamondrecv.test.mjs --break equalmeet  (an equal copy counts as received)
         node www/js/diamondrecv.test.mjs --break onehop     (round 1: a lineage one copy deep)
         node www/js/diamondrecv.test.mjs --break union      (no common copy: the conflict unions)
         node www/js/diamondrecv.test.mjs --break absent     (a malformed lineage reads as none)
         node www/js/diamondrecv.test.mjs --break keeprecords (a tomb leaves the records)
   ============================================================ */
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';
import { readFileSync } from 'node:fs';

/// The page's own sidecar read (markshere.js), so a row is named here as `settle` names it.
const MH = (() => {
	const win = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, addEventListener() {}, dispatchEvent: () => true };
	new Function('window', 'CustomEvent', readFileSync(new URL('./markshere.js', import.meta.url), 'utf8'))(win, function () {});
	return win.DaimondMarksHere;
})();

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const KNOWN = ['legacy', 'equalmeet', 'onehop', 'union', 'absent', 'keeprecords'];
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

// One clock for the account, so "later" means later; a device may run slow (CLK-1).
let T = 1_000_000;
const tick = () => (T += 1000);

/// A mark row as the store writes it: one JSON line with its own id.
const mark = (id, path) => JSON.stringify({ id: 'l-' + path, from: 'diamond:' + id, to: 'dir:' + path, rel: 'holds', by: 'user' });
const rowsOf = (text) => String(text || '').split('\n').filter(Boolean);
/// Tags as the store keeps them: lower case (`normalise_tags`).
const tagIn = (d, t) => d.tags.map((x) => String(x).toLowerCase()).includes(String(t).toLowerCase());
const hasMark = (text, path) => rowsOf(text).some((l) => l.indexOf('"dir:' + path + '"') !== -1);

function pack(id, d) {
	return JSON.stringify({
		id: id, touched: d.touched,
		files: {
			'.daimond/meta.json':   JSON.stringify({ name: d.name, touched: d.touched, tags: d.tags || [], toolkits: d.kits || [] }),
			'.daimond/links.jsonl': d.links || '',
			'crystal.json':         d.memory || '',
		},
	});
}
function unpack(json) {
	const v = JSON.parse(json), files = v.files || {};
	let m = {};
	try { m = JSON.parse(files['.daimond/meta.json'] || '{}'); } catch (e) {}
	return { touched: v.touched, name: m.name || '', tags: m.tags || [], kits: m.toolkits || [],
		links: String(files['.daimond/links.jsonl'] || ''), memory: String(files['crystal.json'] || '') };
}

/// A device: its own storage, its own store, the real merge lifted over them.
function device(name, skew) {
	const w = makeWindow({ now: T });
	const store = {};
	const settled = {};
	const drops = [], raw = [];					// entries dropped; rows taken off without theirs
	const bump = (id) => { store[id].touched = Math.max(tick() + (skew || 0), store[id].touched + 1); };
	const app = {
		list_diamonds: async () => JSON.stringify(Object.keys(store).map((id) => ({
			id, name: store[id].name, updated: store[id].touched, touched: store[id].touched,
			tags: store[id].tags.slice(), toolkits: store[id].kits.slice() }))),
		export_diamond: async (id) => pack(id, store[id]),
		import_diamond: async (json, keep) => {
			const inc = unpack(json), id = JSON.parse(json).id, had = store[id];
			const versions = had ? had.versions.slice() : [];
			if (had && keep) versions.push({ memory: had.memory, tags: had.tags.slice(), note: 'kept before sync' });
			store[id] = { touched: inc.touched, name: inc.name, tags: inc.tags.slice(), kits: inc.kits.slice(),
				links: inc.links, memory: inc.memory, versions };
		},
		set_tags: async (id, j) => { store[id].tags = JSON.parse(j); bump(id); },
		set_toolkits: async (id, j) => { store[id].kits = JSON.parse(j); bump(id); },
		rename_diamond: async (id, n) => { store[id].name = n; bump(id); },
		union_links: async (id, side) => {
			const cur = rowsOf(store[id].links), ids = cur.map((l) => JSON.parse(l).id);
			let grew = false;
			rowsOf(side).forEach((l) => { const k = JSON.parse(l).id; if (!ids.includes(k)) { cur.push(l); ids.push(k); grew = true; } });
			if (grew) { store[id].links = cur.join('\n'); bump(id); }
			return grew;
		},
		remove_link: async (id, lid) => {
			const cur = rowsOf(store[id].links), kept = cur.filter((l) => JSON.parse(l).id !== lid);
			// The one door (P5): this device's entry for the row goes first.
			const gone = MH.parseSidecar(cur.filter((l) => JSON.parse(l).id === lid).join('\n'))[0];
			if (gone && !drops.includes(id + ' ' + lid + ' ' + gone.to)) raw.push(id + ' ' + lid);
			if (kept.length === cur.length) return false;
			store[id].links = kept.join('\n'); bump(id); return true;
		},
		delete_diamond: async (id) => { delete store[id]; },
	};
	const stubs = {
		ChatStore: { putTombs: () => Promise.resolve(true) }, diamondApp: () => app, trail: () => {}, heapNote: () => '',
		DaimondMarksHere: { dropAll: () => false, settle: (owner, text, loser) => { settled[owner] = String(text || '') + '\n' + String(loser || ''); return false; },
			drop: (owner, lid, to) => { drops.push(owner + ' ' + lid + ' ' + to); return false; }, parseSidecar: MH.parseSidecar },
		notePeerRef: () => {}, bumpDiamonds: () => {},
		onDiamondsChangedElsewhere: async () => {}, signalLinksChanged: () => {}, setDiamondModel: () => {},
		storageAlarm: () => {}, tOr: (k, x) => x, DaimondCloud: undefined, DaimondChunks: undefined,
		mergeTombMap: (k, t) => Object.assign({}, t || {}),
	};
	if (BREAK === 'equalmeet') {
		// An equal copy counted as received: the author stops keeping its copy once
		// it has seen it relayed back.
		stubs.unionDiamondTags = async () => true;
		stubs.unionDiamondLinks = async () => false;
	}
	if (BREAK === 'onehop') {
		// Round 1: an entry names only the one copy it was built on.
		stubs.diamondAncOf = (rv, stamp) => (!rv ? [] : (stamp === rv.c ? rv.anc.slice(-1) : (rv.c > 0 ? [rv.c] : [])));
	}
	if (BREAK === 'union') stubs.seenAncestor = () => null;
	if (BREAK === 'absent') {
		stubs.sentAnc = (r) => {
			if (!r || r.anc === undefined) return null;
			const ok = Array.isArray(r.anc) && r.anc.every((x) => typeof x === 'number' && isFinite(x) && x > 0);
			return ok ? r.anc.slice(-16) : null;
		};
	}
	if (BREAK === 'keeprecords') stubs.dropDiamondRecords = () => {};
	const f = sliceDaimond(w, ['applyDiamonds', 'entryLineage', 'recordDiamondCopies', 'readDiamondRecv', 'readDiamondSeen',
		'syncForkPoint', 'commitDiamondBaseline', 'readDiamondBase', 'diamondAncOf', 'recvOf'], stubs).fns;
	const dev = {
		name, store, w, f, settled, drops, raw,
		create(id, memory) {
			store[id] = { touched: tick() + (skew || 0), name: id, tags: ['common'], kits: [], links: '', memory, versions: [] };
		},
		/// One change, one stamp: the memory, and whatever of tags, name, grants and marks `o` names.
		edit(id, memory, tag, o) {
			const d = store[id]; o = o || {};
			if (memory != null) d.memory = memory;
			if (tag) d.tags = d.tags.concat([tag]);
			if (o.dropTag) d.tags = d.tags.filter((x) => x !== o.dropTag);
			if (o.name) d.name = o.name;
			if (o.kit) d.kits = d.kits.concat([o.kit]);
			if (o.dropKit) d.kits = d.kits.filter((x) => x !== o.dropKit);
			if (o.mark) d.links = rowsOf(d.links).concat([mark(id, o.mark)]).join('\n');
			if (o.unmark) d.links = rowsOf(d.links).filter((l) => !hasMark(l, o.unmark)).join('\n');
			d.touched = tick() + (skew || 0);
		},
		/// The parcel this device would push now, collected as `collectDiamonds` does.
		parcel() {
			const recv = f.readDiamondRecv(), seen = f.readDiamondSeen(), ch = {}, add = {};
			const p = { diamondTombs: Object.assign({}, dev.tombs || {}), diamonds: Object.keys(store).sort().map((id) => {
				const s = store[id].touched, data = pack(id, store[id]);
				const e = { id, touched: s, updated: s, data };
				const anc = f.entryLineage(recv, seen, id, s, data, ch, add);
				if (BREAK !== 'legacy') e.anc = anc;
				return e;
			}) };
			f.recordDiamondCopies(ch, recv, add, null);
			return p;
		},
		/// The 200 for parcel `p`: the fork point from what it carried (5.2.1: from the live list).
		async land(p) { await f.commitDiamondBaseline(BREAK === 'legacy' ? undefined : f.syncForkPoint(p)); },
		async push() { const p = this.parcel(); await this.land(p); return p; },
		async pull(p) { await f.applyDiamonds(p, 'x'); },
		fork(id) { return JSON.parse(w.localStorage.getItem('daimond-diamond-base') || '{}')[id]; },
		rec(key) { return JSON.parse(w.localStorage.getItem(key) || '{}'); },
		kept(id, mk) { return (store[id].versions || []).some((v) => v.note === 'kept before sync' && v.memory.includes(mk)); },
		keptAny(id) { return (store[id].versions || []).filter((v) => v.note === 'kept before sync').length; },
		keeps(id, mk) { return store[id].memory.includes(mk) || dev.kept(id, mk); },
	};
	return dev;
}

/// Two devices that agree on X at one copy, as a full round leaves them.
async function agreed(id) {
	const A = device('A'), B = device('B');
	A.create(id, 'agreed');
	await B.pull(await A.push());
	await A.pull(await B.push());
	return { A, B };
}

console.log('\ndiamondrecv: D1, an edit made while the push flies' + (BREAK ? '  [--break ' + BREAK + ']' : ''));
{
	const { A, B } = await agreed('X');
	// The creator received nothing and its receiver relays what the creator sent: one copy, one entry.
	check('two devices at one copy send the same entry, lineage included (the creator\'s empty one)',
		JSON.stringify(A.parcel()) === JSON.stringify(B.parcel()),
		JSON.stringify(A.parcel().diamonds.map((e) => e.anc)) + ' vs ' + JSON.stringify(B.parcel().diamonds.map((e) => e.anc)));
	A.edit('X', 'A pre-push', 'pre');
	const p = A.parcel();				// collected; the POST flies
	A.edit('X', 'A in-flight flight-4e2', 'flightTag');
	const inflight = A.store.X.touched;
	await A.land(p);					// the 200
	check('the fork point is the stamp the parcel carried, not the unsent edit', A.fork('X') === p.diamonds[0].touched && A.fork('X') !== inflight,
		'fork ' + A.fork('X') + ', carried ' + p.diamonds[0].touched + ', in flight ' + inflight);
	await B.pull(p);
	B.edit('X', 'B later desk-8b1', 'deskTag');
	await A.pull(await B.push());
	check('D1: the other device\'s later copy is live on A', A.store.X.memory.includes('desk-8b1'));
	check('D1: A\'s in-flight edit is kept before sync', A.kept('X', 'flight-4e2'), JSON.stringify(A.store.X.versions));
	check('D1: A\'s in-flight tag is unioned onto the live copy', tagIn(A.store.X, 'flightTag'), JSON.stringify(A.store.X.tags));
	// A's union travels back and B takes it one-sided.
	await B.pull(await A.push());
	check('D1: B converges on the union with no copy of its own kept', tagIn(B.store.X, 'flightTag') && B.keptAny('X') === 0,
		JSON.stringify(B.store.X.tags) + ' kept ' + B.keptAny('X'));
}

console.log('\ndiamondrecv: D2, both edit between syncs and the earlier edit lands first');
{
	const { A, B } = await agreed('Y');
	A.edit('Y', 'A phone-2c9', 'aTag');
	const pA = await A.push();			// lands
	B.edit('Y', 'B desk-5f0', 'bTag');	// later, not yet pulled
	await B.pull(pA);					// the 409's pull: A's copy is strictly older, skipped
	await A.pull(await B.push());
	check('D2: B\'s later copy is live on A', A.store.Y.memory.includes('desk-5f0'));
	check('D2: A\'s edit is kept before sync on A', A.kept('Y', 'phone-2c9'), JSON.stringify(A.store.Y.versions));
	check('D2: A\'s tag survives on the live copy', tagIn(A.store.Y, 'aTag'), JSON.stringify(A.store.Y.tags));
}

console.log('\ndiamondrecv: the ordinary relay keeps nothing (six rounds of ping-pong)');
{
	const { A, B } = await agreed('R');
	for (let i = 0; i < 3; i++) {
		A.edit('R', 'A ' + i); await B.pull(await A.push());
		B.edit('R', 'B ' + i); await A.pull(await B.push());
	}
	check('no kept copy on A', A.keptAny('R') === 0, String(A.keptAny('R')));
	check('no kept copy on B', B.keptAny('R') === 0, String(B.keptAny('R')));
	check('both hold the last edit', A.store.R.memory === 'B 2' && B.store.R.memory === 'B 2');
	check('and both would send the same entry for it, lineage included', JSON.stringify(A.parcel()) === JSON.stringify(B.parcel()),
		JSON.stringify(A.parcel().diamonds.map((e) => e.anc)) + ' vs ' + JSON.stringify(B.parcel().diamonds.map((e) => e.anc)));
	// The fixed point: two collects of an unchanged store are the same bytes.
	check('the parcel is a fixed point once quiet', JSON.stringify(A.parcel()) === JSON.stringify(A.parcel()));
	const before = JSON.stringify(A.parcel());
	await A.pull(B.parcel());			// an equal copy: nothing moves
	check('an equal copy changes neither the store nor the parcel', JSON.stringify(A.parcel()) === before);
}

console.log('\ndiamondrecv: a device that missed a run of the other\'s edits keeps nothing');
{
	const { A, B } = await agreed('M');
	A.edit('M', 'A1'); await A.push();
	A.edit('M', 'A2'); await A.push();
	A.edit('M', 'A3'); const p3 = await A.push();
	await B.pull(p3);
	check('B takes the last of the run one-sided', B.store.M.memory === 'A3' && B.keptAny('M') === 0);
	B.edit('M', 'B after'); await A.pull(await B.push());
	check('A takes B\'s edit on the run one-sided', A.store.M.memory === 'B after' && A.keptAny('M') === 0);
}

console.log('\ndiamondrecv: an edit on a slow clock after adopting a fast copy (CLK-1)');
{
	const F = device('F', 300_000), S = device('S', 0);
	F.create('K', 'fast v0');
	await S.pull(await F.push());
	F.edit('K', 'fast v1'); await S.pull(await F.push());
	S.edit('K', 'slow v2 slow-77');	// stamped below v1
	F.edit('K', 'fast v3');			// built on v1, not on v2
	await S.pull(await F.push());
	const survives = S.store.K.memory.includes('slow-77') || S.kept('K', 'slow-77');
	check('the slow edit survives (live or kept)', survives, JSON.stringify(S.store.K));
}

console.log('\ndiamondrecv: three devices');
{
	// A relay of a copy built on T's: T takes it one-sided (the relay carries the parent).
	const A = device('A'), B = device('B'), Tt = device('T');
	Tt.create('Z', 'z0');
	const p0 = await Tt.push();
	await A.pull(p0); await B.pull(p0);
	await Tt.pull(await A.push()); await Tt.pull(await B.push());
	Tt.edit('Z', 'T authored t1');
	const pT = await Tt.push();
	await A.pull(pT);
	A.edit('Z', 'A on t1');
	await B.pull(await A.push());
	await Tt.pull(await B.push());		// B relays A's copy
	check('T takes a relay of a copy built on its own one-sided', Tt.store.Z.memory === 'A on t1' && Tt.keptAny('Z') === 0,
		Tt.store.Z.memory + ' kept ' + Tt.keptAny('Z'));

	// The equal-meet hazard: A's copy relayed back must not stop A keeping it.
	const A2 = device('A2'), B2 = device('B2'), T2 = device('T2');
	A2.create('W', 'w0');
	const q0 = await A2.push();
	await B2.pull(q0); await T2.pull(q0);
	await A2.pull(await B2.push()); await A2.pull(await T2.push());
	A2.edit('W', 'A authored a1-3f');
	const qA = await A2.push();
	await B2.pull(qA);
	await A2.pull(await B2.push());		// A meets its own copy, relayed by B
	T2.edit('W', 'T concurrent t1');		// built on w0, later by clock
	const qT = await T2.push();
	await B2.pull(qT);					// B had not moved: takes T's
	await A2.pull(await B2.push());		// T's copy reaches A through B
	check('A keeps its edit against a concurrent third copy arriving through a relay', A2.kept('W', 'a1-3f'),
		JSON.stringify(A2.store.W.versions));
}

console.log('\ndiamondrecv: a 5.2.1 sender (no lineage)');
{
	const { A, B } = await agreed('L');
	A.edit('L', 'A pre');
	const p = A.parcel();
	A.edit('L', 'A in-flight legacy-9d', 'lTag');
	await A.land(p);
	await B.pull(p);
	B.edit('L', 'B later');
	const q = B.parcel(); q.diamonds.forEach((e) => { delete e.anc; });	// the old page's entry
	await A.pull(q);
	check('an in-flight edit is kept against an old sender too (the fork from the parcel)', A.kept('L', 'legacy-9d'),
		JSON.stringify(A.store.L.versions));
}

console.log('\ndiamondrecv: F1, three devices, two hops down from this device\'s edit (relay3 (b))');
{
	const A = device('A'), B = device('B'), C = device('C');
	A.create('R', 'r0');
	const p0 = await A.push();
	await B.pull(p0); await C.pull(p0);
	await A.pull(await B.push()); await A.pull(await C.push());
	A.edit('R', 'A r3e-a', 'r3eA', { mark: 'r3e-mark' });
	await B.pull(await A.push());
	B.edit('R', 'B r3e-b', null, { dropTag: 'r3eA', unmark: 'r3e-mark' });
	await C.pull(await B.push());
	C.edit('R', 'C r3e-c', 'r3eC');
	await A.pull(await C.push());
	check('F1: A takes C\'s copy one-sided (it descends from A\'s edit through B)', A.store.R.memory === 'C r3e-c' && A.keptAny('R') === 0,
		A.store.R.memory + ' kept ' + A.keptAny('R'));
	check('F1: the tag B took off stays off on A', !tagIn(A.store.R, 'r3eA'), JSON.stringify(A.store.R.tags));
	check('F1: the mark B took off stays off on A, and A\'s marks-here record is settled without it',
		!hasMark(A.store.R.links, 'r3e-mark') && !hasMark(A.settled.R, 'r3e-mark'), A.store.R.links + ' | ' + A.settled.R);
	const q = await A.push(); await B.pull(q); await C.pull(q);
	check('F1: no device keeps a spurious copy, and all three converge', [A, B, C].every((d) => d.keptAny('R') === 0)
		&& B.store.R.touched === A.store.R.touched && C.store.R.touched === A.store.R.touched,
		[A, B, C].map((d) => d.name + ' ' + d.store.R.touched + ' kept ' + d.keptAny('R')).join(', '));
}

console.log('\ndiamondrecv: F1, the creator that never received a copy (miss3)');
{
	const A = device('A'), B = device('B'), C = device('C');
	A.create('M3', 'm0');
	const p0 = await A.push();
	await B.pull(p0); await C.pull(p0);
	B.edit('M3', 'B ms3-b', 'ms3B', { dropTag: 'common' });
	await C.pull(await B.push());
	C.edit('M3', 'C ms3-c', 'ms3C');
	await A.pull(await C.push());
	check('F1: the idle creator takes two hops of edits one-sided', A.store.M3.memory === 'C ms3-c' && A.keptAny('M3') === 0,
		A.store.M3.memory + ' kept ' + A.keptAny('M3'));
	check('F1: and brings back no tag B took off', !tagIn(A.store.M3, 'common') && tagIn(A.store.M3, 'ms3B'),
		JSON.stringify(A.store.M3.tags));
}

console.log('\ndiamondrecv: F1, the bound (a lineage longer than 16 copies)');
{
	const { A, B } = await agreed('LB');
	for (let i = 0; i < 12; i++) {
		A.edit('LB', 'A ' + i); await B.pull(await A.push());
		B.edit('LB', 'B ' + i); await A.pull(await B.push());
	}
	const e = A.parcel().diamonds.find((x) => x.id === 'LB');
	check('the lineage an entry carries is bounded at 16', BREAK === 'legacy' || (Array.isArray(e.anc) && e.anc.length === 16),
		JSON.stringify(e.anc && e.anc.length));
	check('and a long ping-pong still keeps nothing', A.keptAny('LB') === 0 && B.keptAny('LB') === 0,
		A.keptAny('LB') + ' / ' + B.keptAny('LB'));
}

console.log('\ndiamondrecv: F2, a page edit against a mark taken off (rmconf), each order');
for (const first of ['A', 'B']) {
	const { A, B } = await agreed('RM' + first);
	const id = 'RM' + first;
	A.edit(id, null, null, { mark: 'rmc' });
	await B.pull(await A.push()); await A.pull(await B.push());
	const doA = async () => { A.edit(id, 'A rmc-a'); return A.push(); };
	const doB = async () => { B.edit(id, null, null, { unmark: 'rmc' }); return B.push(); };
	if (first === 'A') {
		const pa = await doA(); tick(); const pb = await doB();
		await B.pull(pa); await A.pull(pb);
	} else {
		const pb = await doB(); tick(); const pa = await doA();
		await A.pull(pb); await B.pull(pa);
	}
	for (let k = 0; k < 2; k++) { await B.pull(await A.push()); await A.pull(await B.push()); }
	check(`F2 ${first}-first: A's page edit survives on A (live or kept)`, A.keeps(id, 'rmc-a'), JSON.stringify(A.store[id]));
	check(`F2 ${first}-first: the mark taken off on B is off on both`, !hasMark(A.store[id].links, 'rmc') && !hasMark(B.store[id].links, 'rmc'),
		A.store[id].links + ' | ' + B.store[id].links);
	check(`F2 ${first}-first: A's marks-here record was settled without it`, !hasMark(A.settled[id], 'rmc'), String(A.settled[id]));
	// B-first, B's merge takes A's copy of the row off again; A-first, nothing is taken off.
	check(`F2 ${first}-first: a row the merge takes off takes this device's entry with it (P5's one door)`,
		!A.raw.length && !B.raw.length && (first === 'A' || B.drops.includes(id + ' l-rmc dir:rmc')),
		JSON.stringify({ rawA: A.raw, rawB: B.raw, dropsB: B.drops }));
	check(`F2 ${first}-first: both converge`, A.store[id].touched === B.store[id].touched, A.store[id].touched + ' / ' + B.store[id].touched);
}

console.log('\ndiamondrecv: F2, tags and grants three-way; an addition on the losing side stays');
{
	const { A, B } = await agreed('TG');
	A.edit('TG', null, 'old', { kit: 'rust' });
	await B.pull(await A.push()); await A.pull(await B.push());
	A.edit('TG', 'A tg-a', 'aNew');				// A adds a tag
	const pa = await A.push();
	B.edit('TG', 'B tg-b', null, { dropTag: 'old', dropKit: 'rust' });	// B takes a tag and a grant off, later
	await B.pull(pa);
	await A.pull(await B.push());
	check('F2: the tag B took off stays off', !tagIn(A.store.TG, 'old'), JSON.stringify(A.store.TG.tags));
	check('F2: the tag A added stays on', tagIn(A.store.TG, 'aNew'), JSON.stringify(A.store.TG.tags));
	check('F2 (sweep): the grant B took off stays off', !A.store.TG.kits.includes('rust'), JSON.stringify(A.store.TG.kits));
	check('F2: A\'s page is kept before sync', A.kept('TG', 'tg-a'));
	// The removal on the LOSING side: B takes a grant off and lands first; A's later page edit wins.
	const { A: A2, B: B2 } = await agreed('TK');
	A2.edit('TK', null, null, { kit: 'node' });
	await B2.pull(await A2.push()); await A2.pull(await B2.push());
	B2.edit('TK', null, null, { dropKit: 'node', dropTag: 'common' });
	const pb = await B2.push();
	A2.edit('TK', 'A tk-a');
	await A2.pull(pb);
	await B2.pull(await A2.push());
	check('F2 (sweep): a grant and a tag taken off on the losing side stay off', !B2.store.TK.kits.includes('node') && !tagIn(B2.store.TK, 'common'),
		JSON.stringify(B2.store.TK.kits) + ' ' + JSON.stringify(B2.store.TK.tags));
	check('F2 (sweep): and the winner\'s page is live', B2.store.TK.memory === 'A tk-a', B2.store.TK.memory);
}

console.log('\ndiamondrecv: F4, a rename in the losing edit');
{
	const { A, B } = await agreed('CB');
	A.edit('CB', 'A cmb-a', 'cmbA', { name: 'Combo renamed on A' });
	const pa = await A.push();
	B.edit('CB', 'B cmb-b');
	await B.pull(pa);
	await A.pull(await B.push());
	check('F4: A\'s rename is live after the conflict', A.store.CB.name === 'Combo renamed on A', A.store.CB.name);
	check('F4: with A\'s tag, and A\'s page kept', tagIn(A.store.CB, 'cmbA'), JSON.stringify(A.store.CB.tags));
	await B.pull(await A.push());
	check('F4: B takes the renamed copy one-sided', B.store.CB.name === 'Combo renamed on A' && B.keptAny('CB') === 0, B.store.CB.name);
	// Both renamed: the winner's name stands.
	const { A: A2, B: B2 } = await agreed('CB2');
	A2.edit('CB2', 'A', null, { name: 'A name' });
	const qa = await A2.push();
	B2.edit('CB2', 'B', null, { name: 'B name' });
	await B2.pull(qa);
	await A2.pull(await B2.push());
	check('F4: both renamed, the winner\'s name stands', A2.store.CB2.name === 'B name', A2.store.CB2.name);
}

console.log('\ndiamondrecv: F2 residual, no common copy recorded: the conflict unions as before');
{
	const { A, B } = await agreed('NR');
	A.edit('NR', 'A nr-a', 'nrA');
	const pa = await A.push();
	B.edit('NR', 'B nr-b', 'nrB');
	await B.pull(pa);
	A.w.localStorage.removeItem('daimond-diamond-seen');
	await A.pull(await B.push());
	check('no record: the loser\'s tag is unioned on and its page kept', tagIn(A.store.NR, 'nrA') && A.kept('NR', 'nr-a'),
		JSON.stringify(A.store.NR.tags));
}

console.log('\ndiamondrecv: F5, a malformed lineage reads as built on nothing');
for (const [label, bad] of [['string', '12x'], ['negative', [-1]], ['object', { a: 1 }], ['null', null], ['mixed', [5, 'x']]]) {
	const { A, B } = await agreed('F5' + label);
	const id = 'F5' + label;
	A.edit(id, 'A f5-' + label, 'f5A');
	const pa = await A.push();
	B.edit(id, 'B f5b');
	await B.pull(pa);
	const q = B.parcel(); q.diamonds.forEach((e) => { if (e.id === id) e.anc = bad; });
	await A.pull(q);
	check(`F5 ${label}: A's edit is kept`, BREAK === 'legacy' || A.kept(id, 'f5-' + label), JSON.stringify(A.store[id].versions.map((v) => v.memory)));
}

console.log('\ndiamondrecv: the records');
{
	const S = device('S');
	S.w.localStorage.setItem('daimond-diamond-base', JSON.stringify({ a: 10, b: 20 }));
	const seeded = S.f.readDiamondRecv();
	check('the record is seeded once from the fork point on the update',
		JSON.stringify(seeded) === JSON.stringify({ a: [10, 10, []], b: [20, 20, []] })
		&& S.w.localStorage.getItem('daimond-diamond-recv') !== null, JSON.stringify(seeded));
	S.w.localStorage.setItem('daimond-diamond-base', JSON.stringify({ a: 99 }));
	check('and not reseeded afterwards', JSON.stringify(S.f.readDiamondRecv()) === JSON.stringify(seeded));
	const rv = S.f.recvOf({ x: [100, 100, [40, 70]] }, 'x');
	check('a device at the recorded copy passes on its lineage', JSON.stringify(S.f.diamondAncOf(rv, 100)) === '[40,70]');
	check('a device that moved adds the recorded copy', JSON.stringify(S.f.diamondAncOf(rv, 130)) === '[40,70,100]');
	check('nothing recorded: an empty lineage', JSON.stringify(S.f.diamondAncOf(null, 7)) === '[]');
	check('round 1\'s [s, p] reads as a receipt with no lineage', JSON.stringify(S.f.recvOf({ y: [50, 20] }, 'y')) === JSON.stringify({ s: 50, c: 50, anc: [] }));
	// The landing: carried stamps; held out keeps its fork; tombed leaves it.
	S.w.localStorage.setItem('daimond-diamond-base', JSON.stringify({ a: 1, held: 2, dead: 3 }));
	await S.f.commitDiamondBaseline(S.f.syncForkPoint({ diamonds: [{ id: 'a', touched: 11 }], diamondTombs: { dead: 5 } }));
	check('the landing sets the carried stamp, keeps a Diamond held out, drops a tombed one',
		JSON.stringify(JSON.parse(S.w.localStorage.getItem('daimond-diamond-base'))) === JSON.stringify({ a: 11, held: 2 }),
		S.w.localStorage.getItem('daimond-diamond-base'));
	// One fork point, two parts (release 5.2.2, FB4 beside DAF): the files are the census's
	// location's, the Diamonds the device's. A parcel whose census named no location agrees
	// no file and still carries every Diamond it holds.
	const fk = S.f.syncForkPoint({ files: { 'n.md': 'x' }, diamonds: [{ id: 'a', touched: 12 }], diamondTombs: { dead: 6 } });
	check('a fork with no census location still carries its Diamonds and names no location',
		fk.taken === false && fk.loc === null && fk.diamonds.a === 12 && fk.diamondTombs.dead === 1 && !!fk.files['n.md'],
		JSON.stringify(fk));
	// F6: a tombstone takes the records with the Diamond, on the receiver and on the destroyer.
	const { A, B } = await agreed('G');
	await B.pull({ diamonds: [], diamondTombs: { G: tick() } });
	check('a tombstone arriving drops the records', !B.rec('daimond-diamond-recv').G && !B.rec('daimond-diamond-seen').G,
		JSON.stringify(B.rec('daimond-diamond-recv').G) + ' ' + JSON.stringify(B.rec('daimond-diamond-seen').G));
	await A.pull({ diamonds: [], diamondTombs: {} });
	delete A.store.G; A.tombs = { G: tick() };
	await A.push();
	check('F6: the destroyer\'s landing drops its records', !A.rec('daimond-diamond-recv').G && !A.rec('daimond-diamond-seen').G,
		JSON.stringify(A.rec('daimond-diamond-recv').G) + ' ' + JSON.stringify(A.rec('daimond-diamond-seen').G));
	// The copy records are bounded, and the copy last received is never the one evicted.
	const { A: A3, B: B3 } = await agreed('SB');
	const got = B3.f.recvOf(B3.rec('daimond-diamond-recv'), 'SB');
	for (let i = 0; i < 12; i++) { B3.edit('SB', 'B ' + i); B3.parcel(); }
	const list = B3.rec('daimond-diamond-seen').SB || [];
	check('the copy records are bounded at 8, the one received kept', list.length === 8 && list.some((x) => x[0] === got.s),
		list.length + ' ' + JSON.stringify(list.map((x) => x[0])) + ' recv ' + got.s);
	void A3;
}

console.log('');
if (BREAK) {
	if (failures > 0) { console.log('EXPECTED: ' + failures + ' failure(s) under --break ' + BREAK + '. The guard works.'); process.exit(0); }
	console.log('BUG: --break ' + BREAK + ' changed nothing; the test does not prove the fix.');
	process.exit(1);
}
console.log(failures ? failures + ' FAILED' : 'all diamondrecv checks passed');
process.exit(failures ? 1 : 0);
