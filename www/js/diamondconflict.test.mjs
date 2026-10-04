/* ============================================================
   Test — a resume-pull never silently discards a two-sided Diamond
   edit (S-SYNC #4).
   ------------------------------------------------------------
   Drives the REAL `applyDiamonds` from www/js/daimond.js, lifted out
   by source, over a fake wasm app that models the two behaviours the
   wasm change gives `import_diamond`: it PRESERVES the version store
   across a replace, and on a two-sided change it KEEPS the local copy
   as a recoverable version before the replace. The fork-stamp logic,
   the conflict detection and the tags/links union are the real ones.

   THE BUG. `import_diamond` deleted the whole Diamond directory and
   wrote the export over it, so a phone that edited a Diamond's memory,
   backgrounded before its push, then pulled the desktop's copy on
   resume had its edit replaced wholesale — no conflict copy, nothing
   in the trail — and then pushed the desktop's copy back.

   THE FIX, in the three pieces this file exercises:
     1. A per-Diamond fork point (`daimond-diamond-base`) lets
        `applyDiamonds` tell a two-sided change (both sides moved since
        the last agreement) from a one-sided one.
     2. On a two-sided change the import is asked to KEEP the loser as
        a recoverable version (`keep_conflict`), and the loser's tags
        and links are unioned onto the winner.
     3. A one-sided pull is unchanged: no conflict copy, the fork point
        advances, and a further quiet round imports nothing.

   ROUND F (QA pair 2, Fable F1 = Opus B F1): the Diamond's note file `.daimond/steering.md` is
   not a versioned file either, so the import replaced it whole: a note added on the losing
   side vanished, and a Remove flipped back to active. Case 5 drives the REAL `applyDiamonds`,
   the REAL `Notes` (daimond.js) and the REAL steering.js over a fake store that models the
   import (the file is deleted and the arriving pack's laid down).

   Run:   node www/js/diamondconflict.test.mjs
          node www/js/diamondconflict.test.mjs --break deletewrite
          node www/js/diamondconflict.test.mjs --break nobase
          node www/js/diamondconflict.test.mjs --break nonotes
          node www/js/diamondconflict.test.mjs --break nolock    (Case 6 only)
          node www/js/diamondconflict.test.mjs --break stale     (Case 6 only)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

const KNOWN = ['deletewrite', 'nobase', 'nonotes', 'nolock', 'stale'];
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}
// `deletewrite` reverts the wasm side to the old delete-then-write: the fake
// import ignores `keep_conflict` and keeps no version, so the loser's edit is
// lost. `nobase` reverts the JS fork-stamp: `applyDiamonds` never sees a base,
// so a two-sided change reads as one-sided and asks for no conflict copy. Each
// must redden the two-sided assertions. `nonotes` takes the note file's join out of the page, so the
// import's whole replacement stands, and must redden Case 5. `nolock` lets the lock admit everyone at once, and
// `stale` decides from the list read at the top of the pull and not from the Diamond as it stands under the lock;
// each must redden Case 6 and nothing else.

// ── Lift a function out of daimond.js by source ───────────────────
function lift(src, marker) {
	const start = src.indexOf(marker);
	if (start < 0) throw new Error(marker + ' not found in daimond.js');
	const end = src.indexOf('\n\t}\n', start);
	if (end < 0) throw new Error('end of ' + marker + ' not found');
	return src.slice(start, end + 3);
}

const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const liftedStamp   = lift(SRC, '\tfunction diamondStamp(d) {');
const liftedTags    = lift(SRC, '\tfunction packTags(data) {');
const liftedLinks   = lift(SRC, '\tfunction packLinks(data) {');
const liftedPackAt  = lift(SRC, '\tfunction packStamp(data) {');
const liftedPackNotes = lift(SRC, '\tfunction packNotes(data) {');
let liftedApply     = lift(SRC, '\tasync function applyDiamonds(remote, from) {');
if (BREAK === 'nonotes') {
	const needle = 'await window.DaimondNotes.uniteHeld(', n = liftedApply.split(needle).length - 1;
	if (n !== 1) { console.error('break nonotes: target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
	liftedApply = liftedApply.replace(needle, 'await (async function () { return false; })(');
}
if (BREAK === 'stale') {
	const needle = 'mine = cur; local[r.id] = cur;', n = liftedApply.split(needle).length - 1;
	if (n !== 1) { console.error('break stale: target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
	liftedApply = liftedApply.replace(needle, 'void cur;');
	const g = 'if (!(diamondStamp(r) > diamondStamp(cur))) return 0;', m = liftedApply.split(g).length - 1;
	if (m !== 1) { console.error('break stale: target matched ' + m + ' times, not once: ' + g); process.exit(2); }
	liftedApply = liftedApply.replace(g, '');
}
// The page's one lock per Diamond, as written (round F, R1).
let liftedLock = lift(SRC, '\tvar DIAMOND_LOCKS = {};');
if (BREAK === 'nolock') {
	const needle = 'var prior = q.tail,', n = liftedLock.split(needle).length - 1;
	if (n !== 1) { console.error('break nolock: target matched ' + n + ' times, not once: ' + needle); process.exit(2); }
	liftedLock = liftedLock.replace(needle, 'var prior = Promise.resolve(),');
}
// The page's note writer, as written: the object from `var Notes = {` to its closing `};`.
const liftedNotes = (() => {
	const a = SRC.indexOf('\tvar Notes = {');
	if (a < 0) throw new Error('var Notes not found in daimond.js');
	const b = SRC.indexOf('\n\t};\n', a);
	return SRC.slice(a, b + 5);
})();
const STEERING = (() => {
	const win = {};
	new Function('window', readFileSync(join(HERE, 'steering.js'), 'utf8'))(win);
	return win.DaimondSteering;
})();
// The shape law's apply side (F3): no `DaimondCloud` here, so no manifest stands and none is adopted.
const liftedShape   = ['\tfunction diamondRefStands(', '\tfunction diamondAdoptsRef(', '\tfunction diamondManifest(',
	'\tfunction adoptDiamondRef('].map((m) => lift(SRC, m)).join('\n');
// The two-sided rule, the lineage record it reads and the conflict's settling of what
// lives outside the versioned files (lanes DIA, DIA2). An entry here carries no `anc`,
// which is a 5.2.1 sender's shape, so these cases exercise the fork point's rule and
// the conflict with no common copy, which unions as it always did.
const liftedDia = [
	'\tfunction ancList(a) {', '\tfunction recvOf(recv, id) {', '\tfunction sentAnc(r) {',
	'\tfunction diamondTwoSided(r, mine, recv, dbase) {', '\tfunction packFacets(data) {',
	'\tfunction sidecarRows(text) {', '\tfunction seenEntry(stamp, f) {', '\tfunction noteSeen(list, entry, keep, only) {',
	'\tfunction seenAncestor(list, anc) {', '\tfunction diamondMergePlan(w, l, a) {',
	'\tfunction recordDiamondCopies(recvCh, was, seenAdd, only) {', '\tfunction patchDiamondRecord(read, write, changes) {',
	'\tfunction dropDiamondRecords(ids) {', '\tfunction fileHash(s) {', '\tasync function removeLinkHere(link) {',
].map((m) => lift(SRC, m)).join('\n');

// ── A fake wasm app modelling the import contract ─────────────────
//
// A Diamond is { touched, tags, links, memory, versions: [...] }. A version is
// a snapshot of the memory/tags/links a keep-before-import captured — the
// "recoverable version" the fix is about.
function pack(id, d) {
	return JSON.stringify({
		id: id, touched: d.touched,
		files: Object.assign({
			'.daimond/meta.json':   JSON.stringify(d.metaAt ? { tags: d.tags || [], touched: d.metaAt } : { tags: d.tags || [] }),
			'.daimond/links.jsonl': d.links || '',
			'crystal.json':         d.memory || '',
		}, d.notes != null ? { '.daimond/steering.md': d.notes } : {}),
	});
}
function unpack(json) {
	const v = JSON.parse(json);
	const files = (v.files) || {};
	let tags = [];
	try { tags = (JSON.parse(files['.daimond/meta.json'] || '{}').tags) || []; } catch (e) {}
	return {
		touched: v.touched | 0,
		tags:    Array.isArray(tags) ? tags : [],
		links:   String(files['.daimond/links.jsonl'] || ''),
		memory:  String(files['crystal.json'] || ''),
		notes:   typeof files['.daimond/steering.md'] === 'string' ? files['.daimond/steering.md'] : null,
	};
}

function makeApp() {
	const store = {};              // id -> Diamond
	const calls = { import: [] };  // [{id, keepConflict}]
	return {
		store, calls,
		seed(id, d) { store[id] = Object.assign({ tags: [], links: '', memory: '', versions: [] }, d); },
		app: {
			async list_diamonds() {
				return JSON.stringify(Object.keys(store).map((id) => ({
					id: id, updated: store[id].touched, touched: store[id].touched,
					tags: store[id].tags.slice(),
				})));
			},
			async export_diamond(id) {
				if (!store[id]) throw new Error('no diamond ' + id);
				return pack(id, store[id]);
			},
			async import_diamond(json, keepConflict) {
				const v = JSON.parse(json);
				const id = v.id;
				const inc = unpack(json);
				calls.import.push({ id: id, keepConflict: !!keepConflict });
				const had = store[id];
				// PRESERVE the version store across the replace; on `deletewrite` the
				// old behaviour drops it and keeps nothing.
				const versions = (had && BREAK !== 'deletewrite') ? had.versions.slice() : [];
				if (had && keepConflict && BREAK !== 'deletewrite') {
					// KEEP THE LOSER: the local copy, before it is replaced.
					versions.push({ memory: had.memory, tags: had.tags.slice(), links: had.links,
						note: 'kept before sync' });
				}
				// `delete_except_versions`, then every pack file written: `.daimond/steering.md` is not a
				// versioned file, so the arriving pack's is all there is (a pack without one leaves none).
				store[id] = { touched: inc.touched, tags: inc.tags.slice(), links: inc.links,
					memory: inc.memory, versions: versions, notes: inc.notes };
			},
			async set_tags(id, tagsJson) {
				if (!store[id]) return;
				store[id].tags = JSON.parse(tagsJson);
				store[id].touched += 1;          // a write moves the stamp, as the engine does
			},
			async union_links(id, sidecar) {
				if (!store[id]) return false;
				const cur = store[id].links ? store[id].links.split('\n').filter(Boolean) : [];
				const add = String(sidecar || '').split('\n').filter(Boolean);
				let grew = false;
				add.forEach((l) => { if (cur.indexOf(l) === -1) { cur.push(l); grew = true; } });
				if (grew) { store[id].links = cur.join('\n'); store[id].touched += 1; }
				return grew;
			},
			async delete_diamond(id) { delete store[id]; },
		},
	};
}

// The store doors `Notes` reads and writes the note file through (`Wasm.store_read`, `store_write`) and
// `touch_diamond`, over the same Diamonds the fake app holds.
function makeWasm(h) {
	const m = /^diamonds\/([^/]+)\/\.daimond\/steering\.md$/;
	const calls = { writes: [], touches: [] };
	return {
		calls,
		async store_read(path) {
			const k = m.exec(path), d = k && h.store[k[1]];
			if (!d || d.notes == null) throw new Error('no such file ' + path);
			return d.notes;
		},
		async store_write(path, text) {
			const k = m.exec(path);
			if (!k || !h.store[k[1]]) throw new Error('no such Diamond for ' + path);
			if (h.failNoteWrite) throw new Error('the store refused the write');
			h.store[k[1]].notes = text;
			calls.writes.push([k[1], text]);
		},
		async touch_diamond(id) {
			if (!h.store[id]) throw new Error('no Diamond ' + id);
			h.store[id].touched += 1;
			calls.touches.push(id);
		},
	};
}

// ── Build the real applyDiamonds with controllable deps ───────────
function build(harness) {
	const baseStore = harness.baseStore;
	const src =
		'var window = ctx.window;\n' +
		liftedStamp + '\n' + liftedTags + '\n' + liftedLinks + '\n' + liftedPackAt + '\n' + liftedPackNotes + '\n' +
		liftedDia + '\n' + liftedShape + '\n' + 'var DIAMOND_ANC_MAX = 16, DIAMOND_SEEN_MAX = 8;\n' +
		// deps applyDiamonds reaches for, stubbed to the harness
		'function diamondApp() { return ctx.app; }\n' +
		'function trail() {}\n' +
		'function heapNote() { return \'\'; }\n' +
		'function mergeTombMap() { return {}; }\n' +
		'function notePeerRef() {}\n' +
		'function setDiamondModel() {}\n' +
		'function bumpDiamonds() {}\n' +
		'async function onDiamondsChangedElsewhere() {}\n' +
		'function signalLinksChanged() {}\n' +
		'async function unionDiamondTags() { return false; }\n' +
		'async function unionDiamondLinks() { return false; }\n' +
		'async function diamondData(r) { if (ctx.onFetch) await ctx.onFetch(r); return r.data != null ? r.data : null; }\n' +
		'var ChatStore = { putTombs: async function () {} };\n' +
		// This device's record of the marks pressed on it (R2): settled from the copy
		// before the import, which this suite does not assert on (markshere.test.mjs does).
		'var DaimondMarksHere = { settle: function () { return false; }, dropAll: function () { return false; },\n' +
		'\tdrop: function () { return false; }, parseSidecar: function () { return []; } };\n' +
		'var DIAMOND_TOMBS_KEY = \'daimond-diamond-tombs\';\n' +
		// the fork-store, and — on `nobase` — a base that is always empty
		'function readDiamondBase() { return ctx.readBase(); }\n' +
		'function writeDiamondBase(m) { ctx.writeBase(m); }\n' +
		'function readDiamondRecv() { return ctx.readRecv(); }\n' +
		'function writeDiamondRecv(m) { ctx.writeRecv(m); }\n' +
		'function readDiamondSeen() { return ctx.readSeen(); }\n' +
		'function writeDiamondSeen(m) { ctx.writeSeen(m); }\n' +
		// The page's note writer and the pure module under it, as the page holds them.
		'var DaimondSteering = window.DaimondSteering;\n' +
		'var Wasm = ctx.wasm;\n' +
		'var DEFAULT_IDS = ctx.ids;\n' +
		'var diamonds = ctx.diamonds, chats = [];\n' +
		liftedLock + '\n' +
		liftedNotes + '\n' +
		'window.DaimondNotes = Notes;\n' +
		liftedApply + '\n' +
		'return applyDiamonds;';
	const ctx = {
		app: harness.app,
		wasm: harness.wasm || null,
		diamonds: harness.diamonds || [],
		onFetch: harness.onFetch || null,
		ids: { 'Daimond Optimiser': 'OPT' },
		window: { DaimondCloud: undefined, DaimondSteering: STEERING },
		readBase: () => (BREAK === 'nobase' ? {} : JSON.parse(JSON.stringify(baseStore.map))),
		writeBase: (m) => { if (BREAK !== 'nobase') baseStore.map = JSON.parse(JSON.stringify(m || {})); },
		readRecv: () => JSON.parse(JSON.stringify(baseStore.recv || {})),
		writeRecv: (m) => { baseStore.recv = JSON.parse(JSON.stringify(m || {})); },
		readSeen: () => JSON.parse(JSON.stringify(baseStore.seen || {})),
		writeSeen: (m) => { baseStore.seen = JSON.parse(JSON.stringify(m || {})); },
	};
	// eslint-disable-next-line no-new-func
	const fn = new Function('ctx', src)(ctx);
	fn.window = ctx.window;
	return fn;
}

// A single incoming Diamond carrying its export INLINE as `data`. The stamp rides
// on the entry (`touched`/`updated`), which is what `diamondStamp` reads for the
// merge, exactly as `collectDiamonds` builds it.
function incoming(id, touched, tags, links, memory, notes) {
	return { id: id, touched: touched, updated: touched, data: pack(id, { touched, tags, links, memory, notes }) };
}

// ══ Case 1 — a two-sided change keeps the loser ═══════════════════
async function twoSided() {
	console.log('\ntwo-sided change (phone edited, desktop edited, phone resumes):');
	const h = makeApp();
	h.seed('X', { touched: 20, tags: ['a', 'phoneTag'], links: 'L_phone', memory: 'MEM_phone_T20' });
	const baseStore = { map: { X: 10 } };   // both last agreed at stamp 10
	const apply = build({ app: h.app, baseStore });

	await apply({ diamonds: [ incoming('X', 30, ['a', 'deskTag'], 'L_desk', 'MEM_desk_T30') ] }, 'desktop');

	const x = h.store['X'];
	const kept = (x.versions || []).some((v) => v.memory === 'MEM_phone_T20');
	check('import was asked to keep the conflict', h.calls.import.some((c) => c.id === 'X' && c.keepConflict === true));
	check('the winner (desktop memory) is live', x.memory === 'MEM_desk_T30', x.memory);
	check('the LOSER (phone memory) is kept as a recoverable version', kept,
		'versions: ' + JSON.stringify((x.versions || []).map((v) => v.memory)));
	check('tags are the union of both sides',
		['a', 'deskTag', 'phoneTag'].every((t) => x.tags.indexOf(t) !== -1), JSON.stringify(x.tags));
	check('links carry the loser’s line', x.links.indexOf('L_phone') !== -1 && x.links.indexOf('L_desk') !== -1,
		JSON.stringify(x.links));
	check('the fork point advanced to the winner', baseStore.map['X'] === 30, JSON.stringify(baseStore.map));
}

// ══ Case 2 — a one-sided change is unchanged, and settles ═════════
async function oneSided() {
	console.log('\none-sided change (only the desktop edited):');
	const h = makeApp();
	h.seed('X', { touched: 10, tags: ['a'], links: 'L', memory: 'MEM_T10' });   // == the base
	const baseStore = { map: { X: 10 } };
	const apply = build({ app: h.app, baseStore });

	await apply({ diamonds: [ incoming('X', 30, ['a'], 'L', 'MEM_desk_T30') ] }, 'desktop');

	let x = h.store['X'];
	check('import was NOT asked to keep a conflict', h.calls.import.some((c) => c.id === 'X') && !h.calls.import[0].keepConflict);
	check('no conflict version was written', (x.versions || []).length === 0, JSON.stringify(x.versions));
	check('the desktop copy is live', x.memory === 'MEM_desk_T30');
	check('the fork point advanced', baseStore.map['X'] === 30);

	// The push-skip fixed point: a further quiet round (local == remote, equal
	// stamps) imports nothing and writes no new version.
	const before = h.calls.import.length;
	await apply({ diamonds: [ incoming('X', 30, ['a'], 'L', 'MEM_desk_T30') ] }, 'desktop');
	x = h.store['X'];
	check('a quiet round imports nothing (fixed point)', h.calls.import.length === before, 'imports: ' + h.calls.import.length);
	check('the fork point holds at the winner', baseStore.map['X'] === 30);
}

// ══ Case 3 — a fresh adopt is never a conflict ════════════════════
async function freshAdopt() {
	console.log('\nfresh adopt (a Diamond this device never had):');
	const h = makeApp();
	const baseStore = { map: {} };
	const apply = build({ app: h.app, baseStore });

	await apply({ diamonds: [ incoming('Y', 30, ['a'], 'L', 'MEM_T30') ] }, 'desktop');

	const y = h.store['Y'];
	check('import was NOT asked to keep a conflict', !h.calls.import[0].keepConflict);
	check('no conflict version', (y.versions || []).length === 0);
	check('the copy landed', y.memory === 'MEM_T30');
	check('the fork point records it', baseStore.map['Y'] === 30);
}

// ══ Case 4 — the fork point is the copy STORED (B1) ═══════════════
// A sender lists a Diamond (stamp 30) and exports it after an edit lands (its pack,
// and so the copy an import lays down, carries 31). The fork point must be 31: at
// 30, the next arrival reads this device as having moved and unions back a mark
// the sender has since removed.
async function storedStamp() {
	console.log('\nfork point from the stored copy (entry 30, pack 31):');
	const h = makeApp();
	h.seed('X', { touched: 10, tags: ['a'], links: 'L', memory: 'MEM_T10' });
	const baseStore = { map: { X: 10 } };
	const apply = build({ app: h.app, baseStore });
	const r = { id: 'X', touched: 30, updated: 30, data: pack('X', { touched: 31, metaAt: 31, tags: ['a', 'b'], links: 'L', memory: 'MEM_T31' }) };
	await apply({ diamonds: [ r ] }, 'desktop');
	check('the fork point is the stamp the stored copy carries', baseStore.map['X'] === 31, JSON.stringify(baseStore.map));
}


// ══ Case 5 — the note file is joined, not replaced (round F: Fable F1, Opus B F1) ══
// `.daimond/steering.md` is in the Diamond's export but not among the versioned files, so the import
// replaced it with the arriving copy's: a note added here vanished, a Remove made here flipped back to
// active. The two copies are now joined by entry id, with the status moving only forward, and the result
// is written through the note writer and stamped so that it travels on.
const SEP = ' \xb7 ';
const NOTE = (id, o) => Object.assign({ id: id, status: 'active', cm: 'glm-5.2', tag: 'long', level: 2, scope: 'X', at: { t: 1, n: 2 }, kept: 0, line: 'Line of ' + id + '.', to: '' }, o || {});
const FILE = (list, own, acct) => STEERING.serialise(list.reduce((d, e) => STEERING.put(d, e), STEERING.parse('', own || 'X', !!acct).doc));
const IDS = (text, own, acct) => STEERING.parse(text || '', own || 'X', !!acct).entries.map((e) => e.id + ':' + e.status).sort();
async function noteFile() {
	console.log('\nthe note file on a two-sided change (round F):');
	const mk = (local, remote, o) => {
		o = o || {};
		const h = makeApp();
		h.seed(o.id || 'X', { touched: 20, tags: ['a'], links: 'L', memory: 'MEM_here', notes: local });
		h.wasm = makeWasm(h);
		const baseStore = { map: {} }; baseStore.map[o.id || 'X'] = 10;
		const apply = build({ app: h.app, wasm: h.wasm, baseStore });
		return { h, apply, baseStore, id: o.id || 'X', run: () => apply({ diamonds: [ incoming(o.id || 'X', 30, ['a'], 'L', 'MEM_there', remote) ] }, 'desktop') };
	};
	const common = NOTE('n-c');

	// S1: both devices add between syncs. The arriving copy wins the import; the note added here must survive.
	let t = mk(FILE([common, NOTE('n-y')]), FILE([common, NOTE('n-z')]));
	await t.run();
	check('S1 the import was a conflict', t.h.calls.import.some((c) => c.keepConflict === true));
	check('S1 the note added here survives', IDS(t.h.store.X.notes).includes('n-y:active'), JSON.stringify(IDS(t.h.store.X.notes)));
	check('S1 the note added there stands', IDS(t.h.store.X.notes).includes('n-z:active'));
	check('S1 and the common one', IDS(t.h.store.X.notes).includes('n-c:active'));
	check('S1 the join is stamped so that it travels on', t.h.store.X.touched > 30 && t.h.wasm.calls.touches.length === 1,
		'touched ' + t.h.store.X.touched + ', touches ' + t.h.wasm.calls.touches.length);
	const before = t.h.wasm.calls.writes.length;
	await t.run();
	check('S1 a further round writes nothing (the join settles)', t.h.wasm.calls.writes.length === before, 'writes ' + t.h.wasm.calls.writes.length);

	// S2: a Remove made here; the arriving copy still holds the note active. The note must stay removed.
	t = mk(FILE([NOTE('n-r', { status: 'retired', at: { t: 4, n: 40 } })]), FILE([NOTE('n-r')]));
	await t.run();
	check('S2 the note stays retired', JSON.stringify(IDS(t.h.store.X.notes)) === '["n-r:retired"]', JSON.stringify(IDS(t.h.store.X.notes)));
	check('S2 with the figures it was closed at', STEERING.parse(t.h.store.X.notes, 'X', false).entries[0].at.n === 40);
	check('S2 stamped, so the Remove travels back', t.h.wasm.calls.touches.length === 1);

	// S3: the other way: the arriving copy holds the Remove, this device the active note. Nothing to write.
	t = mk(FILE([NOTE('n-r')]), FILE([NOTE('n-r', { status: 'retired', at: { t: 4, n: 40 } })]));
	await t.run();
	check('S3 the arriving Remove stands', JSON.stringify(IDS(t.h.store.X.notes)) === '["n-r:retired"]');
	check('S3 nothing written, nothing stamped', t.h.wasm.calls.writes.length === 0 && t.h.wasm.calls.touches.length === 0);

	// S4: the arriving copy has no note file (a Diamond whose notes were never written there).
	t = mk(FILE([NOTE('n-y')]), null);
	await t.run();
	check('S4 the file is not deleted by an import of a copy without one', IDS(t.h.store.X.notes).join() === 'n-y:active', JSON.stringify(t.h.store.X.notes));

	// S5: one-sided (this device had not moved since the base): the arriving file is taken as it is.
	t = mk(FILE([common]), FILE([common, NOTE('n-z')]));
	t.h.store.X.touched = 10;
	await t.run();
	check('S5 a one-sided pull is not joined and writes nothing', t.h.wasm.calls.writes.length === 0 && t.h.wasm.calls.touches.length === 0
		&& JSON.stringify(IDS(t.h.store.X.notes)) === '["n-c:active","n-z:active"]');

	// S6: the Optimiser's file holds the account's notes (level 3), and they join too.
	const acc = (id, o) => NOTE(id, Object.assign({ level: 3, scope: '', cm: 'all' }, o || {}));
	t = mk(FILE([acc('n-a1'), acc('n-a2')], 'OPT', true), FILE([acc('n-a1', { status: 'retired', at: { t: 0, n: 22 } }), acc('n-a3')], 'OPT', true), { id: 'OPT' });
	await t.run();
	check('S6 the account\'s notes join: a Remove, an Add there and an Add here',
		JSON.stringify(IDS(t.h.store.OPT.notes, 'OPT', true)) === '["n-a1:retired","n-a2:active","n-a3:active"]', JSON.stringify(IDS(t.h.store.OPT.notes, 'OPT', true)));

	// S7: a store that refuses the write must not stop the sync, and nothing is lost on the next try.
	t = mk(FILE([common, NOTE('n-y')]), FILE([common, NOTE('n-z')]));
	t.h.failNoteWrite = true;
	let threw = false;
	try { await t.run(); } catch (e) { threw = true; }
	check('S7 a refused write does not fail the pull', !threw);
	check('S7 the fork point still advanced to the arriving copy', t.baseStore.map.X === 30);

	// S8: the page's own list sees the joined file (Notes.by is the cache the prompt is built from).
	t = mk(FILE([common, NOTE('n-y')]), FILE([common, NOTE('n-z')]));
	await t.run();
	const listed = await window_notes(t);
	check('S8 the writer\'s own view is the joined file', JSON.stringify(listed) === '["n-c","n-y","n-z"]', JSON.stringify(listed));
}
async function window_notes(t) {
	const N = t.apply.window.DaimondNotes;
	return N && N.by[t.id] ? N.by[t.id].entries.map((e) => e.id).sort() : null;
}

// ══ Case 6 — a press made while a pull applies the same Diamond (round F, R1) ══
// `applyDiamonds` decided "two-sided" from the list it read at its top, and the import sat outside the queue the
// note writes share: a note pressed after the list read as a one-sided change and the import replaced the file
// under it. The Diamond now has one lock, held by the note writes and by the apply from the decision to the join,
// and the decision is made on the Diamond as it stands under it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function lockCases() {
	console.log('\na press made while a pull applies the same Diamond (round F, R1):');
	const mk = (local, remote, o) => {
		o = o || {};
		const h = makeApp(), events = [];
		h.seed('X', { touched: o.touched || 10, tags: ['a'], links: 'L', memory: 'MEM_here', notes: local });
		h.seed('OPT', { touched: 5, tags: [], links: '', memory: '', notes: '' });
		h.wasm = makeWasm(h);
		const wr = h.wasm.store_write;
		h.wasm.store_write = async (path, text) => { events.push('write ' + path.split('/')[1]); return wr(path, text); };
		h.diamonds = Object.keys(h.store).map((k) => ({ id: k }));
		const baseStore = { map: {} }; baseStore.map.X = o.base || o.touched || 10;
		const t = { h, events, baseStore };
		h.onFetch = async () => { if (t.onFetch) await t.onFetch(); };
		t.apply = build({ app: h.app, wasm: h.wasm, baseStore, diamonds: h.diamonds, onFetch: h.onFetch });
		const note = (level, line) => t.apply.window.DaimondNotes.add({ level, scope: level === 2 ? 'X' : '', cm: 'all', tag: level === 2 ? 'wrong' : 'long', line, at: { t: 0, n: 0 } });
		t.press = (line) => note(2, line || 'Pressed mid-pull, n-press.');
		t.pressOpt = (line) => note(3, line || 'Pressed on the account, n-acct.');
		const oi = h.app.import_diamond;
		h.app.import_diamond = async function (json, keep) { events.push('import-start'); if (t.onImport) await t.onImport(); const r = await oi.call(this, json, keep); events.push('import-end'); return r; };
		t.run = () => Promise.race([t.apply({ diamonds: [ incoming('X', o.arrive || 30, ['a'], 'L', 'MEM_there', remote) ] }, 'desktop'),
			sleep(4000).then(() => { throw new Error('the pull did not finish in 4 s: a deadlock'); })]);
		return t;
	};
	const common = NOTE('n-c'), lines = (t) => STEERING.parse(t.h.store.X.notes || '', 'X', false).entries.map((e) => e.line).sort();

	// 6a: the press completes after the pull listed the Diamonds and before the import, and the arrival is still the later copy.
	let t = mk(FILE([common]), FILE([common, NOTE('n-z')]));
	t.onFetch = async () => { if (!t.fired) { t.fired = true; await t.press(); } };
	await t.run();
	check('6a a press made during the fetch reads as a change this device made: the import is two-sided', t.h.calls.import.length === 1 && t.h.calls.import[0].keepConflict === true,
		JSON.stringify(t.h.calls.import));
	check('6a the pressed note stands, with the common one and the one that arrived', lines(t).includes('Pressed mid-pull, n-press.') && IDS(t.h.store.X.notes).includes('n-c:active') && IDS(t.h.store.X.notes).includes('n-z:active'),
		JSON.stringify(lines(t)) + ' ' + JSON.stringify(IDS(t.h.store.X.notes)));

	// 6b: the press carries this device's stamp to the arrival's: the arrival is no longer the strictly newer copy.
	t = mk(FILE([common]), FILE([common, NOTE('n-z')]), { touched: 11, arrive: 12 });
	t.onFetch = async () => { if (!t.fired) { t.fired = true; await t.press(); } };
	await t.run();
	check('6b a press that makes this copy the newer is not overwritten: nothing is imported', t.h.calls.import.length === 0 && lines(t).includes('Pressed mid-pull, n-press.'),
		JSON.stringify(t.h.calls.import) + ' ' + JSON.stringify(lines(t)));

	// 6c: the press is made as the import starts and the import takes its time (the wasm import is a directory replace).
	t = mk(FILE([common]), FILE([common, NOTE('n-z')]));
	t.onImport = async () => { t.pressed = t.press(); t.pressed.then(() => t.events.push('press-done')); await sleep(15); };
	await t.run();
	const answered = await Promise.race([t.pressed.then(() => true), sleep(2000).then(() => false)]);
	check('6c the press that waited for the import answers', answered === true);
	check('6c and it is laid on the imported file, not under it', lines(t).includes('Pressed mid-pull, n-press.') && IDS(t.h.store.X.notes).includes('n-z:active'), JSON.stringify(lines(t)));
	const iEnd = t.events.indexOf('import-end'), wAfter = t.events.indexOf('write X', iEnd);
	check('6c its write is after the import ended', iEnd !== -1 && wAfter !== -1, JSON.stringify(t.events));

	// 6d: the lock is the Diamond's own: a press on another Diamond (the account) is not held up by this import.
	t = mk(FILE([common]), FILE([common, NOTE('n-z')]));
	t.onImport = async () => { t.other = false; t.pressedOpt = t.pressOpt().then(() => { t.other = true; }); await sleep(15); t.otherDuring = t.other; };
	await t.run();
	await t.pressedOpt;
	check('6d a press on another Diamond is answered while this one is applied', t.otherDuring === true);

	// 6e: the import then the join, both inside the lock, finish (the join must not ask the lock again).
	t = mk(FILE([common, NOTE('n-y')]), FILE([common, NOTE('n-z')]), { touched: 20, base: 10 });
	await t.run();
	check('6e a two-sided pull with a join finishes and joins', IDS(t.h.store.X.notes).join() === 'n-c:active,n-y:active,n-z:active', JSON.stringify(IDS(t.h.store.X.notes)));
}

async function main() {
	if (BREAK) console.log('BREAK = ' + BREAK + ' (the two-sided assertions must FAIL)');
	await twoSided();
	await oneSided();
	await freshAdopt();
	await storedStamp();
	await noteFile();
	await lockCases();

	console.log('');
	if (BREAK) {
		// Under a break the two-sided edit is lost: the run is EXPECTED to have
		// failed. A break that leaves every check green is the fault the break exists
		// to catch, so it is the error exit.
		if (failures > 0) {
			console.log('EXPECTED: ' + failures + ' failure(s) under --break ' + BREAK + '. The guard works.');
			process.exit(0);
		}
		console.log('BUG: --break ' + BREAK + ' changed nothing; the test does not prove the fix.');
		process.exit(1);
	}
	if (failures > 0) { console.log(failures + ' failure(s).'); process.exit(1); }
	console.log('all ok.');
}

main().catch((e) => { console.error(e); process.exit(1); });
