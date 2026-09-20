/* ============================================================
   Test — S-SYNC #3: the ledger's 90-day prune holds ACROSS sync.
   ------------------------------------------------------------
   `DaimondLedger.record` pruned entries older than ~90 days, but only on
   the device that calls it. `mergeLedgers` in `www/js/daimond.js` --
   used by the sync collect, the sync apply and a backup restore -- unioned
   with no cutoff at all. A dispatch-only device (a phone that only reads,
   never runs a turn) never calls `record`, so every entry another device
   had already pruned away kept arriving back on its next pull; the runner
   pruned them again on its next `record`, pushed, and the phone handed
   them straight back on the round after. The ledger never actually
   shrank.

   The fix moves the prune into `DaimondLedger.merge(mine, theirs, now)`
   -- union, then prune, then a deterministic sort -- and every call site
   in daimond.js (`collectSync`, `applySync`, backup restore) now delegates
   `mergeLedgers` to it. The cutoff is anchored to the NEWEST entry the
   union holds, `min(now, newest.t + 1 day) - retentionMs()`, so a device
   whose clock has drifted into the future cannot prune entries that are
   genuinely recent.

   `daimond.js` is an ES module that imports the compiled wasm surface, so
   it cannot be instantiated in a `with (window)` sandbox the way `ledger.js`
   is here (`badge.test.mjs` gives the same reason for the same file). What
   is asserted about it below is a SOURCE guard: the three call sites still
   route through `mergeLedgers`, and `mergeLedgers` itself delegates to
   `DaimondLedger.merge` rather than carrying its own union. The merge
   LOGIC -- the part this defect lives in -- is exercised for real, against
   the actual `ledger.js`.

   Each check is proven able to fail:

     node www/js/ledger.test.mjs --break nomergeprune   # merge unions, never prunes
     node www/js/ledger.test.mjs --break noanchor       # cutoff is `now - 90d`, unanchored
     node www/js/ledger.test.mjs --break nodelegate     # daimond.js keeps its own union
     node www/js/ledger.test.mjs                        # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const LEDGER_SRC = join(HERE, 'ledger.js');
const DAIMOND_SRC = join(HERE, 'daimond.js');

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
const KNOWN = ['nomergeprune', 'noanchor', 'nodelegate'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const DAY = 24 * 60 * 60 * 1000;
const RETENTION = 90 * DAY;

/// A fresh `DaimondLedger`, loaded from the real source (optionally patched
/// for `--break`), backed by an in-memory localStorage so tests never touch
/// the real one and never share state with each other.
function load() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => { store.set(k, String(v)); },
		removeItem: (k) => { store.delete(k); },
	};
	const win = {};

	let src = readFileSync(LEDGER_SRC, 'utf8');
	if (BREAK === 'nomergeprune') {
		// The prune step goes: merge is a plain union again, exactly the shape
		// `mergeLedgers` had before the fix.
		const needle = 'out = out.filter(function (e) { return e.t >= cutoff; });';
		if (!src.includes(needle)) throw new Error('break target not found: ' + needle);
		src = src.replace(needle, 'out = out; // BROKEN: prune removed');
	}
	if (BREAK === 'noanchor') {
		// The anchor goes: the cutoff is measured against the caller's raw
		// clock, so a clock that has drifted into the future prunes entries
		// that are genuinely recent.
		const needle = 'var cutoff = Math.min(now, newest + DAY_MS) - PRUNE_MS;';
		if (!src.includes(needle)) throw new Error('break target not found: ' + needle);
		src = src.replace(needle, 'var cutoff = now - PRUNE_MS; // BROKEN: unanchored');
	}

	// eslint-disable-next-line no-new-func
	new Function('window', 'localStorage', src)(win, localStorage);
	return { L: win.DaimondLedger, store, localStorage };
}

/// A minimal ledger entry. Distinct `(t, m, p, c, ca, pv)` gives a distinct
/// `ledgerKey`, which is all a union needs to tell two entries apart.
function entry(t, tag, u) {
	return { t: t, m: tag, p: 1, c: 1, ca: 0, pv: 'x', u: (typeof u === 'number' ? u : 1) };
}

function main() {
	console.log('ledger: unit -- merge unions and sorts');
	{
		const { L } = load();
		const a = [entry(100, 'a'), entry(300, 'c')];
		const b = [entry(200, 'b')];
		const now = 300 + DAY;	// well within retention of everything here
		const out = L.merge(a, b, now);
		check('all three survive', out.length === 3, 'len=' + out.length);
		check('sorted by time', out.map((e) => e.t).join(',') === '100,200,300',
			out.map((e) => e.t).join(','));
	}

	console.log('\nledger: unit -- a shared turn keeps the LOCAL (mine) copy');
	{
		const { L } = load();
		const now = 100 + DAY;
		const mine = [entry(100, 'x', 5)];		// this device's re-priced figure
		const theirs = [entry(100, 'x', 999)];	// the incoming, stale figure
		const out = L.merge(mine, theirs, now);
		check('one entry, not two', out.length === 1, 'len=' + out.length);
		check('mine wins the tie', out[0].u === 5, 'u=' + out[0].u);
	}

	console.log('\nledger: unit -- output order does not depend on input order');
	{
		const { L } = load();
		const now = 300 + DAY;
		const fwd = L.merge([entry(100, 'a'), entry(200, 'b')], [entry(300, 'c')], now);
		const rev = L.merge([entry(300, 'c'), entry(200, 'b')], [entry(100, 'a')], now);
		check('same sequence whichever order the callers built their lists in',
			JSON.stringify(fwd) === JSON.stringify(rev));
	}

	console.log('\nledger: unit -- a genuinely stale entry is dropped by merge itself');
	{
		const { L } = load();
		const newest = 1000 * DAY;
		const now = newest + DAY;
		const mine = [entry(newest, 'recent')];
		const theirs = [entry(newest - RETENTION - DAY, 'ancient')];	// 91 days behind the newest
		const out = L.merge(mine, theirs, now);
		check('the ancient entry does not survive a merge', out.length === 1, 'len=' + out.length);
		check('the recent one does', out[0].m === 'recent');
	}

	console.log('\nledger: cross-device -- a pruned entry does not come back from a stale peer');
	{
		// Day 0: A holds 20 "old" turns and B pulls them while they are still
		// well within the retention window -- an ordinary early sync.
		const T_OLD = 0;
		const NOW_EARLY = 10 * DAY;
		let aLedger = [];
		for (let i = 0; i < 20; i++) aLedger.push(entry(T_OLD, 'old-' + i));
		const { L: LA } = load();
		let bLedger = LA.merge([], aLedger, NOW_EARLY);
		check('B picked up all 20 old turns while they were fresh', bLedger.length === 20,
			'len=' + bLedger.length);

		// Time passes. A now records 5 real turns, long after the old 20 have
		// aged past the retention window -- and, as today, A's own `record`
		// already prunes them locally.
		const T_RECENT = 91 * DAY;
		const { L: LA2 } = load();
		for (let i = 0; i < 5; i++) aLedger.push(entry(T_RECENT + i, 'recent-' + i));
		// A's own prune-on-record (unchanged by this fix, and exercised for
		// real in the `record()` check below) drops the old 20 the moment A
		// next records a turn. `merge` gives the same answer here, which is
		// the point: the same rule now runs wherever a ledger is merged.
		aLedger = LA2.merge(aLedger, [], T_RECENT + 4);
		check('A is left holding only the 5 recent turns', aLedger.length === 5,
			'len=' + aLedger.length + ' ' + JSON.stringify(aLedger.map((e) => e.m)));

		// A pushes; B applies the parcel against ITS OWN stale copy, which
		// still holds the 20 old entries nobody ever told it to drop.
		const now = T_RECENT + 4;
		bLedger = LA2.merge(bLedger, aLedger, now);
		check('B prunes the resurrected-looking old entries on APPLY, not on record',
			bLedger.length === 5, 'len=' + bLedger.length);

		// B pushes its now-pruned copy back; A pulls it.
		aLedger = LA2.merge(aLedger, bLedger, now);
		check('the old entries do NOT come back to A either', aLedger.length === 5,
			'len=' + aLedger.length);
		check('and the survivors are the 5 recent ones, not a mix',
			aLedger.every((e) => e.m.indexOf('recent-') === 0), JSON.stringify(aLedger.map((e) => e.m)));
	}

	console.log('\nledger: unit -- a clock skewed into the future cannot drop a recent entry');
	{
		const { L } = load();
		const now = 1000 * DAY;
		const skewed = now + 400 * DAY;			// this device's clock is 400 days fast
		const recent = [entry(now - DAY, 'today'), entry(now - 2 * DAY, 'yesterday')];
		const out = L.merge(recent, [], skewed);
		check('both recent entries survive a future-skewed clock', out.length === 2,
			'len=' + out.length + ' ' + JSON.stringify(out.map((e) => e.m)));
	}

	console.log('\nledger: unit -- record() still prunes on write (unchanged behaviour)');
	{
		const { L, store } = load();
		store.set('daimond-ledger', JSON.stringify([entry(0, 'ancient')]));
		const rec = L.record({ ts: 1000 * DAY, model: 'm', promptTokens: 1,
			completionTokens: 1, cachedTokens: 0, costUsd: 0.01, provider: 'p' });
		check('the new turn was recorded', !!rec && rec.u === 0.01);
		const stored = JSON.parse(store.get('daimond-ledger'));
		check('the ancient entry was pruned on write, as before', stored.length === 1,
			'len=' + stored.length);
	}

	console.log('\nledger: source guard -- daimond.js routes every merge point through DaimondLedger.merge');
	{
		let src = readFileSync(DAIMOND_SRC, 'utf8');
		if (BREAK === 'nodelegate') {
			// daimond.js goes back to carrying its own union, with no prune.
			src = src.replace('DaimondLedger.merge(mine, theirs, Date.now());',
				'/* BROKEN: no delegate */ mine.concat(theirs);');
		}
		const delegates = src.includes('DaimondLedger.merge(mine, theirs, Date.now());');
		check('mergeLedgers delegates to DaimondLedger.merge', delegates);

		const sites = [
			["collect (the parcel this device sends)", /ledger:\s*mergeLedgers\(readJson\('daimond-ledger', \[\]\), \[\]\)/],
			["apply (a pulled parcel)", /mergeLedgers\(readJson\('daimond-ledger', \[\]\), remote\.ledger\)/],
			["backup restore", /mergeLedgers\(readJson\('daimond-ledger', \[\]\), data\.ledger\)/],
		];
		for (const [label, re] of sites) {
			check(label + ' calls mergeLedgers', re.test(src));
		}
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

main();
