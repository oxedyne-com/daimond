/* ============================================================
   Test — an equal-stamp Diamond copy is fetched and unioned ONCE, not on
   every pull (UNBLOCK-55, 28 Oct 2026).
   ------------------------------------------------------------
   THE BUG. `applyDiamonds` fetched an equal-stamp arrival whose bytes differ
   from this device's (a `dataRef` under another key) from chunks on every
   pull, to union its tags, links and logs, and recorded nothing once it had.
   On gilgamesh a conflict pull took 256 s; the other device pushed every
   three to four minutes, so the retry's base was always one version behind
   and the device never caught up.
   THE FIX. The copy unioned (`key@stamp`) is recorded per Diamond
   (`daimond-diamond-unioned`); the same copy arriving again is skipped, and a
   different copy, or one whose bytes could not be fetched, is fetched.
   WHAT IS CHECKED, with the real `applyDiamonds` lifted: a second pull of the
   same parcel fetches nothing; a new copy is fetched; a copy whose chunk is
   missing is fetched again next round. The livelock itself: a peer that
   pushes during each conflict pull still lets the retry land, once the pull
   no longer re-fetches.
   Run:  node www/js/diamondunioned.test.mjs
   ============================================================ */
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const T = 1_790_000_000_000;

function device() {
	const w = makeWindow({ now: T });
	let fetches = 0, missing = false;
	w.DaimondChunks = { materialiseBytes: async () => { fetches++; return missing ? null : new TextEncoder().encode('{}'); } };
	w.DaimondCloud = { contentGet: () => ({ key: 'mine' }) };
	const app = {
		list_diamonds: async () => JSON.stringify([{ id: 'd', name: 'd', updated: 500, touched: 500, tags: [], toolkits: [] }]),
	};
	const stubs = {
		ChatStore: { putTombs: () => Promise.resolve(true) }, diamondApp: () => app, trail: () => {}, heapNote: () => '',
		notePeerRef: () => {}, bumpDiamonds: () => {}, onDiamondsChangedElsewhere: async () => {}, signalLinksChanged: () => {},
		setDiamondModel: () => {}, adoptDiamondModel: () => false, renderEffortStep: () => {}, storageAlarm: () => {},
		tOr: (k, x) => x, mergeTombMap: (k, t) => Object.assign({}, t || {}),
		unionDiamondTags: async () => false, unionDiamondLinks: async () => false,
		diamondAdoptsRef: () => false, diamondManifest: () => null,
	};
	const f = loadPage({ window: w, want: ['applyDiamonds', 'diamondData', 'readDiamondUnioned', 'writeDiamondUnioned'], stub: stubs });
	return {
		f,
		get fetches() { return fetches; },
		set missing(v) { missing = v; },
		pull: (key) => f.applyDiamonds({ diamonds: [{ id: 'd', touched: 500, dataRef: { key, chunks: ['c1'] } }] }, 'peer'),
	};
}

// ── 1. The same copy twice: fetched once ───────────────────────────
{
	const D = device();
	await D.pull('theirs');
	await D.pull('theirs');
	check('an equal copy unioned once is not fetched again on the next pull', D.fetches === 1, 'fetches=' + D.fetches);
	await D.pull('theirs-2');
	check('a different equal copy is fetched', D.fetches === 2, 'fetches=' + D.fetches);
}

// ── 2. A copy that could not be fetched is owed ────────────────────
{
	const D = device();
	D.missing = true;
	await D.pull('gone');
	D.missing = false;
	await D.pull('gone');
	check('a copy whose chunks were missing is fetched again', D.fetches === 2, 'fetches=' + D.fetches);
}

// ── 3. The livelock: a peer pushes during every conflict pull ──────
// The push loop's shape (sync.js push(): 409 -> pull -> retry over the version
// the pull returned), driven by a mailbox whose peer pushes every PEER_MS. A
// pull costs CHUNK_MS per Diamond fetch, so a pull that re-fetches is longer
// than the peer's interval and every retry is one version behind.
{
	const PEER_MS = 200, CHUNK_MS = 250, PUSH_MS = 40;
	const D = device();
	let clock = 0, version = 10298, nextPeer = PEER_MS;
	const tick = (ms) => { clock += ms; while (clock >= nextPeer) { version++; nextPeer += PEER_MS; } };
	// The version a pull returns is the one its GET read; the merge after it is
	// where the time goes, and a peer push then lands behind the retry's base.
	async function pull() {
		const before = D.fetches, read = version;
		await D.pull('theirs');
		tick(10 + CHUNK_MS * (D.fetches - before));
		return read;
	}
	await pull();							// the first sight of the copy: one fetch, owed in any build
	let base = version - 1, landed = false, tries = 0;	// the push that met a 409
	for (; tries < 6 && !landed; tries++) {
		tick(PUSH_MS);
		if (base === version) { landed = true; break; }	// the gateway took it
		base = await pull();				// 409: pull, then retry over what it returned
	}
	check('a retry lands on top of a peer that pushes during each conflict pull', landed, 'tries=' + tries + ' base=' + base + ' version=' + version);
}

if (failures) { console.log('\n' + failures + ' failure(s)'); process.exit(1); }
console.log('\nall passed');
