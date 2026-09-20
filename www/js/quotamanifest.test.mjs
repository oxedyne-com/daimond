/* ============================================================
   Test — a manifest write lost to quota does not strand content
   (S-SYNC #2, the frozen-index committer).
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js, the REAL DaimondCore.parcelRefs
   (lifted out of daimond.js by source), and the REAL
   www/js/chunks.js `commit`, over one localStorage that runs out of
   room mid-collect.

   THE BUG. `cloud.js writeJson` returns false on quota and every
   caller ignored it. A chat over the inline threshold offloads its
   transcript to chunks, and the collector records the manifest with
   `contentSet` -- but if that index write is lost to quota, the
   parcel still carries a `messagesRef` naming the uploaded chunks,
   while `state.chunked` (the index the ONE commit declares live) does
   not. The gateway sweeps every chunk the committed index does not
   name, so the far device gets an EMPTY chat, re-swept every round.

   THE FIX, in three real pieces this file exercises:
     1. cloud.js remembers a lost index write: `contentSet` returns
        false and `indexDurable()` goes false until a write lands
        (`--break ignorequota` reverts `setIndex` to the old
        always-true and reddens this).
     2. DaimondCore.parcelRefs(state) = the index UNION every
        `messagesRef`/`dataRef`/`msgRef` the parcel names, so the
        committed live set can never omit an address the parcel points
        at (`--break noindexrefs` reverts it to the index alone).
     3. chunks.js `commit` declares every address in the map it is
        given, so committing `parcelRefs` names the stranded chunk
        live where committing the bare index would have swept it.

   Run:   node www/js/quotamanifest.test.mjs
          node www/js/quotamanifest.test.mjs --break ignorequota
          node www/js/quotamanifest.test.mjs --break noindexrefs
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

const KNOWN = ['ignorequota', 'noindexrefs'];
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

// ── A localStorage with a quota that can be turned on and off ──────
// `full` makes every write throw, as a browser does at the quota. It models the
// growing case that matters here: the index is ONE key that gets larger as a
// manifest is added, so the over-write no longer fits and is refused whole -- which
// is exactly why a lost index write strands the manifest it could not record. The
// toggle makes the moment of pressure deterministic; a read always works.
function makeStorage() {
	const store = new Map();
	let full = false;
	return {
		api: {
			getItem:    (k) => (store.has(k) ? store.get(k) : null),
			setItem:    (k, v) => {
				if (full) {
					const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
				}
				store.set(k, String(v));
			},
			removeItem: (k) => store.delete(k),
		},
		setFull: (v) => { full = v; },
		store,
	};
}

/// One simulated tab holding cloud.js, the peer.test.mjs / peerkey.test.mjs pattern.
function makeCloudTab(storageApi) {
	let body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	if (BREAK === 'ignorequota') {
		// The bug: `setIndex` never remembers a write it could not land, so
		// `contentSet` always answers true and `indexDurable()` never goes false.
		const needle = 'var ok = writeJson(IX_KEY, ix || {});\n\t\tif (ok) indexDirty = null;'
			+ '\n\t\telse indexDirty = indexDirty || { at: Date.now() };\n\t\treturn ok;';
		if (!body.includes(needle)) throw new Error('break target not found: setIndex tracking');
		body = body.replace(needle,
			'writeJson(IX_KEY, ix || {});\n\t\treturn true; // BROKEN: quota forgotten');
	}
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	const fn = new Function(
		'window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console',
		'with (window) {\n' + body + '\n}');
	fn(win, storageApi, { storage: {} }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return win.DaimondCloud;
}

/// The REAL `parcelRefs` from daimond.js, lifted out by source so the test drives
/// the shipped function rather than a copy of it. `--break noindexrefs` swaps in
/// the frozen-index behaviour -- the committed set is the index alone.
function loadParcelRefs() {
	if (BREAK === 'noindexrefs') {
		return function parcelRefs(state) {
			// BROKEN: the index alone, so a ref the index never recorded is omitted.
			const out = {};
			if (state && state.chunked) Object.keys(state.chunked).forEach((k) => { out[k] = state.chunked[k]; });
			return out;
		};
	}
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const start = src.indexOf('\tfunction parcelRefs(state) {');
	if (start < 0) throw new Error('parcelRefs not found in daimond.js');
	// The function body ends at the first line that is exactly a tab + `}`.
	const end = src.indexOf('\n\t}\n', start);
	if (end < 0) throw new Error('parcelRefs end not found');
	const text = src.slice(start, end + 3);
	// eslint-disable-next-line no-new-func
	return new Function(text + '\nreturn parcelRefs;')();
}

/// A tab holding the REAL chunks.js `commit`, with the gateway mocked so the test
/// can read back exactly which addresses the commit declared live.
function makeChunksTab() {
	const body = readFileSync(join(HERE, 'chunks.js'), 'utf8');
	let lastCommit = null;
	const gateway = {
		clientApi: () => 1,
		gwFetch: async (_path, opts) => {
			const b = JSON.parse(opts.body);
			if (b.op === 'commit') lastCommit = b;
			return { status: 200, json: async () => ({ ok: true, swept: 0, free_allowance: 0 }) };
		},
	};
	// chunks.js touches `document` on boot (the status chip) and `DaimondI18n`; a
	// document whose lookups all answer null makes `chip()` return null and the
	// boot draw a no-op, which is all this test needs.
	const doc = { getElementById: () => null, querySelector: () => null,
		createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {},
			addEventListener: () => {}, querySelector: () => null }),
		head: { appendChild: () => {} }, body: { appendChild: () => {} } };
	const win = { addEventListener: () => {}, dispatchEvent: () => true,
		DaimondGateway: gateway, document: doc };
	const fn = new Function(
		'window', 'document', 'DaimondGateway', 'localStorage', 'setTimeout', 'clearTimeout', 'console', 'crypto',
		'with (window) {\n' + body + '\n}');
	const ls = makeStorage().api;
	fn(win, doc, gateway, ls, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, { subtle: {} });
	return { commit: win.DaimondChunks.commit, lastCommit: () => lastCommit };
}

// Two chunk addresses: one the index will name, one only the parcel will (the
// stranded transcript's).
const ADDR_INDEXED  = 'aa'.repeat(32);
const ADDR_STRANDED = 'bb'.repeat(32);

async function main() {
	// ── 1. cloud.js remembers a lost index write ──────────────────
	const s = makeStorage();
	const C = makeCloudTab(s.api);

	// Room to spare: an ordinary offload records its manifest and the index is durable.
	check('1a. a normal contentSet lands', C.contentSet('@c/ok', { v: 2, size: 4, key: 'k1',
		chunks: [{ addr: ADDR_INDEXED, size: 4 }], fp: 'f1' }) === true);
	check('1b. and the index is durable', C.indexDurable() === true);

	// Now the store is full: the chat offloaded (chunks uploaded) but the index write
	// cannot land.
	s.setFull(true);
	const landed = C.contentSet('@c/strand', { v: 2, size: 4, key: 'k2',
		chunks: [{ addr: ADDR_STRANDED, size: 4 }], fp: 'f2' });
	check('1c. contentSet reports the lost write', landed === false);
	check('1d. indexDurable() goes false', C.indexDurable() === false);
	check('1e. the index does NOT name the un-written manifest',
		C.index()['@c/strand'] === undefined,
		'@c/strand ' + (C.index()['@c/strand'] ? 'present (leaked)' : 'absent'));

	// Space is freed: the collector retries, the write lands, durability returns.
	s.setFull(false);
	const relanded = C.contentSet('@c/strand', { v: 2, size: 4, key: 'k2',
		chunks: [{ addr: ADDR_STRANDED, size: 4 }], fp: 'f2' });
	check('1f. the write lands once there is room', relanded === true);
	check('1g. indexDurable() recovers', C.indexDurable() === true);

	// ── 2. parcelRefs unions the parcel's own references ──────────
	const parcelRefs = loadParcelRefs();

	// The quota moment, as the parcel sees it: `state.chunked` is the durable index,
	// which took `@c/ok` but LOST `@c/strand`; the parcel still carries the stranded
	// chat as a `messagesRef`. This is the frozen-index committer's exact state.
	const frozenIndex = { '@c/ok': { v: 2, size: 4, key: 'k1',
		chunks: [{ addr: ADDR_INDEXED, size: 4 }] } };
	const state = {
		chunked: frozenIndex,
		chats: [
			{ id: 'ok',     messagesRef: { v: 2, size: 4, key: 'k1', chunks: [{ addr: ADDR_INDEXED, size: 4 }] } },
			{ id: 'strand', messagesRef: { v: 2, size: 4, key: 'k2', chunks: [{ addr: ADDR_STRANDED, size: 4 }] } },
		],
		diamonds: [],
		post: null,
	};
	const live = parcelRefs(state);
	const liveAddrs = new Set();
	Object.keys(live).forEach((k) => (live[k].chunks || []).forEach((c) => liveAddrs.add(c.addr)));
	check('2a. parcelRefs keeps the index it was given', liveAddrs.has(ADDR_INDEXED));
	check('2b. parcelRefs adds the stranded ref the index lost', liveAddrs.has(ADDR_STRANDED),
		'the parcel names @c/strand; the committed set must too');

	// The fixed point: when the index IS durable (it names every ref), parcelRefs is
	// the index unchanged, so a quiet round commits byte-identically.
	const durableIndex = {
		'@c/ok':     { v: 2, size: 4, key: 'k1', chunks: [{ addr: ADDR_INDEXED, size: 4 }] },
		'@c/strand': { v: 2, size: 4, key: 'k2', chunks: [{ addr: ADDR_STRANDED, size: 4 }] },
	};
	const durableState = { chunked: durableIndex, chats: state.chats, diamonds: [], post: null };
	const durableLive = parcelRefs(durableState);
	check('2c. a durable round is the index unchanged (fixed point)',
		JSON.stringify(durableLive) === JSON.stringify(durableIndex));

	// ── 3. commit declares the union live, not the bare index ─────
	const chunks = makeChunksTab();

	await chunks.commit(live, 1, null);
	const committed = new Set((chunks.lastCommit().chunks || []).map((e) => e.addr));
	check('3a. the commit declares the stranded chunk live', committed.has(ADDR_STRANDED),
		'committing parcelRefs must name every address the parcel points at');
	check('3b. and the indexed chunk', committed.has(ADDR_INDEXED));

	// The contrast that shows the belt matters: committing the FROZEN INDEX alone
	// omits the stranded address, which is the deletion the fix prevents.
	await chunks.commit(frozenIndex, 1, null);
	const indexOnly = new Set((chunks.lastCommit().chunks || []).map((e) => e.addr));
	check('3c. committing the bare index would have OMITTED the stranded chunk',
		!indexOnly.has(ADDR_STRANDED),
		'this is the sweep the parcelRefs belt prevents');

	console.log('');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the failures above are the point — the bug is reproduced)');
		process.exit(failures > 0 ? 0 : 1);	// a break that reddens nothing is itself a failure
	}
	if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
	console.log('all ok');
}

main().catch((e) => { console.error(e); process.exit(1); });
