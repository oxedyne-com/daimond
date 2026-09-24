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

   Run:   node www/js/diamondconflict.test.mjs
          node www/js/diamondconflict.test.mjs --break deletewrite
          node www/js/diamondconflict.test.mjs --break nobase
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

const KNOWN = ['deletewrite', 'nobase'];
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
// must redden the two-sided assertions.

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
const liftedApply   = lift(SRC, '\tasync function applyDiamonds(remote, from) {');

// ── A fake wasm app modelling the import contract ─────────────────
//
// A Diamond is { touched, tags, links, memory, versions: [...] }. A version is
// a snapshot of the memory/tags/links a keep-before-import captured — the
// "recoverable version" the fix is about.
function pack(id, d) {
	return JSON.stringify({
		id: id, touched: d.touched,
		files: {
			'.daimond/meta.json':   JSON.stringify({ tags: d.tags || [] }),
			'.daimond/links.jsonl': d.links || '',
			'crystal.json':         d.memory || '',
		},
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
				store[id] = { touched: inc.touched, tags: inc.tags.slice(), links: inc.links,
					memory: inc.memory, versions: versions };
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

// ── Build the real applyDiamonds with controllable deps ───────────
function build(harness) {
	const baseStore = harness.baseStore;
	const src =
		'var window = ctx.window;\n' +
		liftedStamp + '\n' + liftedTags + '\n' + liftedLinks + '\n' +
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
		'async function diamondData(r) { return r.data != null ? r.data : null; }\n' +
		'var ChatStore = { putTombs: async function () {} };\n' +
		// This device's record of the marks pressed on it (R2): settled from the copy
		// before the import, which this suite does not assert on (markshere.test.mjs does).
		'var DaimondMarksHere = { settle: function () { return false; }, dropAll: function () { return false; } };\n' +
		'var DIAMOND_TOMBS_KEY = \'daimond-diamond-tombs\';\n' +
		// the fork-store, and — on `nobase` — a base that is always empty
		'function readDiamondBase() { return ctx.readBase(); }\n' +
		'function writeDiamondBase(m) { ctx.writeBase(m); }\n' +
		liftedApply + '\n' +
		'return applyDiamonds;';
	const ctx = {
		app: harness.app,
		window: { DaimondCloud: undefined },
		readBase: () => (BREAK === 'nobase' ? {} : JSON.parse(JSON.stringify(baseStore.map))),
		writeBase: (m) => { if (BREAK !== 'nobase') baseStore.map = JSON.parse(JSON.stringify(m || {})); },
	};
	// eslint-disable-next-line no-new-func
	return new Function('ctx', src)(ctx);
}

// A single incoming Diamond carrying its export INLINE as `data`. The stamp rides
// on the entry (`touched`/`updated`), which is what `diamondStamp` reads for the
// merge, exactly as `collectDiamonds` builds it.
function incoming(id, touched, tags, links, memory) {
	return { id: id, touched: touched, updated: touched, data: pack(id, { touched, tags, links, memory }) };
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

async function main() {
	if (BREAK) console.log('BREAK = ' + BREAK + ' (the two-sided assertions must FAIL)');
	await twoSided();
	await oneSided();
	await freshAdopt();

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
