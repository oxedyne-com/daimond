/* ============================================================
   Test — the dead-lease drain (www/js/peer.js, www/js/sync.js).
   ------------------------------------------------------------
   The S1 this proves fixed: the lease door is one sealed blob
   holding EVERY lease record ever written, and nothing ages one
   out. At ~200-300 dispatched turns the CAS body passes the
   gateway's 64 KiB (LEASE_MAX_BYTES), every claim is refused 413,
   and hand-off is dead for the account for good -- the map can
   only grow.

   The fix, all www-only:
     - `deadLease(r, now)` beside `liveLease`: vacant, and past the
       last moment ANY copy could read live, by one TTL of grace.
       The grace's max INCLUDES `deadline`, so a released tombstone
       (expiry 0) outlives the stale running copy it supersedes.
     - `mergeLeases` drains dead records at its one choke point, so
       every proposal and every local view stays bounded.
     - `sync.js` `leaseCommit` WEIGHS the sealed blob against
       DaimondWire.fits('lease', …) before the CAS, and maps a real
       413 to `why:'too_large'` at the base version (not 0), so the
       take loop stands down at once instead of spinning ten times.

   Drives the REAL peer.js (its DaimondLease) against a CAS that
   models the door's size refusal, and the REAL sync.js leaseCommit
   against a counting gwFetch. A `--break unfixed` reverts the drain
   by a string replace, so the brick reproduces in the same file.

   Proven able to fail:
     node www/js/leasedrain.test.mjs --break unfixed  # drain removed
     node www/js/leasedrain.test.mjs                  # clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const real = webcrypto;
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['unfixed'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const DOOR    = 65536;			// gateway LEASE_MAX_BYTES, and DaimondWire's fallback
const TTL      = 90000;			// LEASE_TTL_MS
const NOW      = 1757000000000;
const MIN      = 60 * 1000;

// ── The peer.js device (DaimondLease), the peer.test.mjs loader ──
//
// The five scripts peer.test.mjs loads, into one `window`. `--break unfixed` reverts
// the drain by neutralising `deadLease(out[k], now)` in `mergeLeases` to `false`, the
// pre-fix behaviour (the union that never shrinks), exactly as postspin.test.mjs
// reverts its one-line fix.
function loadLease() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
	};
	const document = {
		readyState: 'complete', addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');
	function EventShim(t) { this.type = t; }

	function loadScript(rel, extra, mutate) {
		let body = readFileSync(join(HERE, rel), 'utf8');
		if (mutate) body = mutate(body);
		if (extra) body += extra;
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder', 'Event',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis',
			'with (window) {\n' + body + '\n}');
		fn(win, document, real, localStorage, btoa, atob,
			TextEncoder, TextDecoder, EventShim,
			setTimeout, clearTimeout, setInterval, clearInterval,
			console, globalThis);
	}
	loadScript('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	loadScript('curvefallback.js');
	loadScript('identity.js');
	loadScript('post.js');
	loadScript('peer.js', null, (src) => {
		if (BREAK !== 'unfixed') return src;
		// Revert the drain: the union no longer shrinks, so the dead records pile up and
		// the sealed proposal grows past the door -- the pre-fix brick.
		const out = src.replace('deadLease(out[k], now)) delete out[k];', 'false) delete out[k];');
		if (out === src) throw new Error('leasedrain: could not find the drain line to revert');
		return out;
	});
	return win.DaimondLease;
}

// A CAS that models /api/sync's lease door, WITH the size refusal: `write` answers
// `{ ok:false, why:'too_large' }` when the proposed map serialises past the door (a
// stand-in for the sealed size; the real seal adds a constant). Copies throughout,
// as makeCas (peer.test.mjs:2709) does, so a caller cannot mutate the server's state.
function makeCasDoor(initialLeases) {
	let version = 5;
	let leases = JSON.parse(JSON.stringify(initialLeases || {}));
	return {
		read: async () => ({ version, leases: JSON.parse(JSON.stringify(leases)) }),
		write: async (base, next) => {
			if (base !== version) return { ok: false, version, leases: JSON.parse(JSON.stringify(leases)) };
			if (JSON.stringify(next).length > DOOR) return { ok: false, why: 'too_large' };
			version += 1;
			leases = JSON.parse(JSON.stringify(next));
			return { ok: true, version };
		},
		peekVersion: () => version,
		peekLeases: () => JSON.parse(JSON.stringify(leases)),
	};
}

const L = loadLease();

async function main() {
	check('peer.js published DaimondLease with the drain predicate',
		!!L && typeof L.dead === 'function' && typeof L.merge === 'function');

	console.log('\n1-2. the bricked door drains and the claim lands (the S1 fix)\n');
	{
		L.forget();
		// 300 vacant tombstones, each with a 200-char eid: ~96 KB serialised, well past
		// the 64 KiB door. deadline/renewedAt ~20 min ago, so every one is DEAD.
		const seed = {};
		for (let i = 0; i < 300; i++) {
			seed['turn-' + i] = {
				turnId: 'turn-' + i, holder: 'OLD', eid: 'x'.repeat(200),
				mode: 'released', expiry: 0,
				deadline: NOW - 20 * MIN, renewedAt: NOW - 19 * MIN,
			};
		}
		check('the seeded door is over the gateway ceiling (the brick precondition)',
			JSON.stringify(seed).length > DOOR, JSON.stringify(seed).length + ' bytes');

		const cas = makeCasDoor(seed);
		const res = await L.take('turn-new',
			{ holder: 'PHONE', eid: 'e', deadline: NOW + 15 * MIN }, cas, () => NOW);

		// These assert the FIX. Under `--break unfixed` the drain is gone, the proposal
		// stays 301-strong and over the door, the CAS refuses it for size, and these two
		// go RED -- the brick, reproduced (the inverted exit below makes that a pass).
		check('the claim WON: the drain shrank the proposal under the door',
			res.won === true, 'won=' + res.won + ' why=' + res.why);
		check('the door now holds exactly the one live claim',
			Object.keys(cas.peekLeases()).length === 1 && !!cas.peekLeases()['turn-new'],
			Object.keys(cas.peekLeases()).length + ' records');
	}

	console.log('\n3. a recently-released tombstone survives the merge (regression guard)\n');
	{
		// peer.test.mjs:1352's shape: a released record whose renewedAt is 30 s ago is
		// NOT dead, so a merge keeps it.
		const rec = { turnId: 't', holder: 'H', eid: 'e', mode: 'released', expiry: 0,
			deadline: NOW - 30000, renewedAt: NOW - 30000 };
		check('deadLease is FALSE for a 30 s-old tombstone', L.dead(rec, NOW) === false);
		const merged = L.merge({ t: rec }, {}, NOW);
		check('and the merge keeps it', !!merged.t && merged.t.mode === 'released');
	}

	console.log('\n4. no resurrection: the deadline is in the grace, not expiry alone\n');
	{
		// A released tombstone with expiry 0 but a FUTURE deadline (released moments ago,
		// mid-turn). If the grace were `now - expiry` alone, expiry 0 looks ancient and
		// the tombstone would be dropped -- then a stale running copy still circulating
		// would win the merge and RESURRECT the released turn. The deadline in the max is
		// what stops that.
		const tomb = { turnId: 't', holder: 'H', eid: 'e', mode: 'released', expiry: 0,
			deadline: NOW + 10 * MIN, renewedAt: NOW - 30000 };
		check('deadLease is FALSE for a fresh tombstone with expiry 0 (deadline in the grace)',
			L.dead(tomb, NOW) === false);
		// The stale running copy arrives as incoming; the tombstone must still win.
		const staleRun = { turnId: 't', holder: 'H', eid: 'e', mode: 'running',
			expiry: NOW + 5 * MIN, deadline: NOW + 10 * MIN, renewedAt: NOW - 60000 };
		const merged = L.merge({ t: tomb }, { t: staleRun }, NOW);
		check('the released tombstone beats the stale running copy -- no resurrection',
			!!merged.t && merged.t.mode === 'released' && !L.live(merged.t, NOW));

		// And once EVERY copy is genuinely past its deadline by a TTL, the tombstone IS
		// dead and drains -- the door cannot grow for ever.
		const old = { turnId: 't', holder: 'H', eid: 'e', mode: 'released', expiry: 0,
			deadline: NOW - 20 * MIN, renewedAt: NOW - 20 * MIN };
		check('deadLease is TRUE once the deadline is a TTL past', L.dead(old, NOW) === true);
		check('and the merge drains it', L.merge({ t: old }, {}, NOW).t === undefined);
	}

	console.log('\n5. a done record (expiry = deadline in the future) is KEPT (live)\n');
	{
		const done = { turnId: 't', holder: 'H', eid: 'e', mode: 'done',
			expiry: NOW + 5 * MIN, deadline: NOW + 5 * MIN, renewedAt: NOW - 1000 };
		check('liveLease is TRUE for a done record with a future expiry', L.live(done, NOW) === true);
		check('deadLease is FALSE for it', L.dead(done, NOW) === false);
		check('the merge keeps it', L.merge({ t: done }, {}, NOW).t !== undefined);
	}

	console.log('\n6. weigh-before-CAS on the REAL sync.js leaseCommit\n');
	await leaseCommitChecks();

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the brick failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

// ── sync.js loader for leaseCommit ──
//
// Loads wire.js (for DaimondWire) and sync.js, with an identity that seals as a
// pass-through and a gwFetch that COUNTS the POSTs to ?lease=1 and answers a status
// the test sets. Only leaseCommit is driven, so push()/start() and their siblings are
// never reached; the other Daimond* globals are thin stubs sufficient for load.
function loadSyncLease() {
	const win = {};
	win.window = win;
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
	};
	const document = {
		readyState: 'complete', hidden: false, addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} },
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {}, dataset: {} }),
		body: { appendChild() {} },
	};
	const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
	const atob = (s) => Buffer.from(s, 'base64').toString('binary');

	const state = { posts: [], leaseStatus: 200, leaseVersion: 6 };
	win.DaimondIdentity = {
		isUnlocked: () => true,
		wrapBytesAad:   async (bytes) => bytes,		// pass-through: the sealed blob is the plaintext bytes
		unwrapBytesAad: async (bytes) => bytes,
		deviceId: () => 'dev-self', handle: () => '',
		wrap: async (s) => s, unwrap: async (s) => s,
	};
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: true }),
		gwFetch: async (path, opts) => {
			const q = String(path).split('?')[1] || '';
			if (opts && opts.method === 'POST' && q.indexOf('lease=1') >= 0) {
				state.posts.push(JSON.parse(opts.body));
				return { status: state.leaseStatus,
					json: async () => ({ ok: state.leaseStatus === 200, version: state.leaseVersion }) };
			}
			return { status: 200, json: async () => ({}) };
		},
	};
	win.DaimondCore = {
		collectSync: async () => ({}), syncSelfDeviceId: () => 'dev-self', busy: () => false,
		deviceSelfName: () => 'dev', syncMayCommitChunks: () => false,
		syncCommitBlockedReason: () => '', applySync: async () => ({}),
	};
	win.DaimondLease = { snapshot: () => ({}) };
	win.DaimondPeer  = { deferPushFor: () => false };
	win.DaimondCloud = { sha256: async () => '0'.repeat(64) };

	function loadScript(rel) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
			'TextEncoder', 'TextDecoder',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
			'with (window) {\n' + body + '\n}');
		fn(win, document, real, localStorage, btoa, atob,
			TextEncoder, TextDecoder,
			setTimeout, clearTimeout, () => 0, () => {},
			{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	}
	loadScript('wire.js');
	loadScript('sync.js');
	return { S: win.DaimondSync, state };
}

async function leaseCommitChecks() {
	const { S, state } = loadSyncLease();
	check('sync.js exposes leaseCommit', !!S && typeof S.leaseCommit === 'function');

	// A big map: ~90 KB serialised. Sealed (pass-through) then base64 -> ~120 KB of b64,
	// which fits('lease', …) refuses. The weigh must answer too_large with ZERO POSTs.
	const bigMap = {};
	for (let i = 0; i < 400; i++) bigMap['t' + i] = { turnId: 't' + i, holder: 'H', eid: 'y'.repeat(200), mode: 'running' };
	check('the big map is over 90 KB serialised', JSON.stringify(bigMap).length > 90000,
		JSON.stringify(bigMap).length + ' bytes');
	state.posts = [];
	const big = await S.leaseCommit(5, bigMap);
	check('leaseCommit refuses the over-large blob with why:too_large',
		big.ok === false && big.why === 'too_large', JSON.stringify(big));
	check('and it sent ZERO requests (weighed before the CAS)', state.posts.length === 0,
		state.posts.length + ' POST(s)');
	check('the base version is held, not zeroed', big.version === 5, String(big.version));

	// A small map fits: exactly one POST, and it succeeds.
	state.posts = []; state.leaseStatus = 200; state.leaseVersion = 6;
	const smallMap = { t0: { turnId: 't0', holder: 'H', eid: 'e', mode: 'running', expiry: NOW } };
	const small = await S.leaseCommit(5, smallMap);
	check('a small map fits and is sent exactly once', state.posts.length === 1,
		state.posts.length + ' POST(s)');
	check('and it commits', small.ok === true && small.version === 6, JSON.stringify(small));

	// A gateway 413 on a blob that DID fit the client weigh: mapped to too_large at the
	// base version, not read as a 409 with version 0.
	state.posts = []; state.leaseStatus = 413;
	const refused = await S.leaseCommit(5, smallMap);
	check('a real 413 yields why:too_large', refused.ok === false && refused.why === 'too_large',
		JSON.stringify(refused));
	check('and the version is the base (5), NOT 0', refused.version === 5, String(refused.version));
}

await main();
