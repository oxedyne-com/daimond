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
     node www/js/ledger.test.mjs --break swallow        # a refused write is swallowed (SIM-10)
     node www/js/ledger.test.mjs --break noft|notc|note|nostall|zerowritten|norole
                                                        # MC1: one turn fact taken away each
     node www/js/ledger.test.mjs                        # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

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
const KNOWN = ['nomergeprune', 'noanchor', 'nodelegate', 'swallow',
	'noft', 'notc', 'note', 'nostall', 'zerowritten', 'norole'];
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
	const box = { full: false };			// a box with no room: every write refused
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => {
			if (box.full) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; }
			store.set(k, String(v));
		},
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

	if (BREAK === 'swallow') {
		// The save goes back to swallowing a refused write: the spend is gone.
		const needle = 'var ok = window.DaimondStore.put(KEY, entries, law);';
		if (!src.includes(needle)) throw new Error('break target not found: ' + needle);
		src = src.replace(needle, 'var ok = false; try { localStorage.setItem(KEY, JSON.stringify(entries)); ok = true; } catch (e) { /* BROKEN: swallowed */ }');
	}

	// MC1, one break per fact: each takes away one thing the meter or the write does.
	const FACT_BREAKS = {
		noft:        ['if (ft === undefined) ft = Math.max(0, now - t0);', '/* BROKEN: no ft */'],
		notc:        ['tc++;', '/* BROKEN: no tc */'],
		note:        ["if (ev.outcome === 'failed') te++;", '/* BROKEN: no te */'],
		nostall:     ['if (last !== null && now - last >= stallMs) sg++;', '/* BROKEN: no stall */'],
		zerowritten: ['isFinite(v) && v >= 0.5) entry[k]', 'isFinite(v) && v >= 0) entry[k]'],
		norole:      ["if (typeof f.ro === 'string' && ROLES[f.ro]) entry.ro = f.ro;", '/* BROKEN: no ro */'],
	};
	if (FACT_BREAKS[BREAK]) {
		const [needle, by] = FACT_BREAKS[BREAK];
		if (!src.includes(needle)) throw new Error('break target not found: ' + needle);
		src = src.replace(needle, by);
	}

	// eslint-disable-next-line no-new-func
	const S = loadStore(win, localStorage);
	new Function('window', 'localStorage', src)(win, localStorage);
	return { L: win.DaimondLedger, store, localStorage, box, S };
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

	console.log('\nledger: unit -- a shared turn is ONE entry, the repriced copy over the stale one (the join law, ledgerlaw.test)');
	{
		const { L } = load();
		const now = 100 + DAY;
		const repriced = Object.assign(entry(100, 'x', 5), { u0: 999, rp: 1 });	// the figure after the table's correction
		const stale = entry(100, 'x', 999);										// the incoming, stale figure
		const fwd = L.merge([repriced], [stale], now), rev = L.merge([stale], [repriced], now);
		check('one entry, not two', fwd.length === 1, 'len=' + fwd.length);
		check('the repriced copy stands, whichever side held it', fwd[0].u === 5 && rev[0].u === 5, 'u=' + fwd[0].u + ',' + rev[0].u);
		check('and both orders are one set of bytes', JSON.stringify(fwd) === JSON.stringify(rev));
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

	console.log('\nledger: a spend the box refuses is held owed, read back, and lands when there is room (SIM-10)');
	{
		const { L, store, box, S } = load();
		box.full = true;
		const rec = L.record({ ts: 1000 * DAY, model: 'm', promptTokens: 3, completionTokens: 4,
			cachedTokens: 0, costUsd: 0.02, provider: 'p' });
		check('record answers the entry', !!rec && rec.u === 0.02);
		check('the box holds nothing', !store.has('daimond-ledger'));
		check('the ledger still holds the spend, owed', L.entries().length === 1 && S.owed().join() === 'daimond-ledger',
			'entries=' + L.entries().length + ' owed=' + S.owed().join());
		box.full = false;
		S.retry();
		const landed = store.has('daimond-ledger') ? JSON.parse(store.get('daimond-ledger')) : [];
		check('it lands when there is room, and nothing is owed', landed.length === 1 && S.owed().length === 0,
			'stored=' + landed.length + ' owed=' + S.owed().join());
	}

	console.log('\nledger: a merge the box refuses THROWS, and the union is held owed (SIM-16, A5)');
	{
		const { L, box, S } = load();
		box.full = true;
		let threw = false;
		try { L.adopt([entry(1000 * DAY, 'theirs')]); } catch (e) { threw = S.isRefused(e); }
		check('adopt throws a refusal, so the section is reported failed', threw);
		check('the union is held here meanwhile', L.entries().length === 1);
	}

	console.log('\nledger: stored in merge order, so adopting its own ledger moves nothing (SIM-7)');
	{
		const { L, store } = load();
		for (const t of [300, 100, 200]) {
			L.record({ ts: 1000 * DAY + t, model: 'm', promptTokens: t, completionTokens: 1,
				cachedTokens: 0, costUsd: 0.01, provider: 'p' });
		}
		const before = store.get('daimond-ledger');
		const moved = L.adopt(JSON.parse(before));
		check('the stored order is the merge order', JSON.parse(before).map((e) => e.t - 1000 * DAY).join() === '100,200,300',
			JSON.parse(before).map((e) => e.t - 1000 * DAY).join());
		check('adopting its own ledger moves nothing', !moved && store.get('daimond-ledger') === before);
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

		// Since release 5 the apply and the restore go through `DaimondLedger.adopt`,
		// which merges with `merge` and stores through `DaimondStore` (a refusal throws),
		// and the collect reads `DaimondLedger.entries`, which holds an owed spend.
		const sites = [
			["collect (the parcel this device sends)", /ledger:\s*mergeLedgers\(DaimondLedger\.entries\(\), \[\]\)/],
			["apply (a pulled parcel)", /DaimondLedger\.adopt\(remote\.ledger\)/],
			["backup restore", /DaimondLedger\.adopt\(data\.ledger\)/],
		];
		for (const [label, re] of sites) {
			check(label + ' merges through DaimondLedger', re.test(src));
		}
	}

	// MC1 (D-20261009-01): the turn's own facts -- first event, tools, stalls,
	// images, role -- written on the entry by the device that ran the turn, through
	// ONE entry point, `patchTurn`, with zero written as absent.
	console.log('\nMC1: patchTurn writes the turn facts; zero is absent; one entry point');
	{
		const { L, store } = load();
		const now = Date.now();
		check('patchTurn is the one entry point (patchOutcome is gone)',
			typeof L.patchTurn === 'function' && L.patchOutcome === undefined);
		L.record({ ts: now - 5000, model: 'm', promptTokens: 20, completionTokens: 10,
			costUsd: 0.03, provider: 'p', turnId: 'u1' });
		const before = JSON.parse(store.get('daimond-ledger'))[0];
		let patched = null;
		try {
			patched = L.patchTurn('u1', { dur: 4200.4, out: 'completed', ft: 812.4, tc: 3, te: 1,
				sg: 0, im: 0, ro: 'c' });
		} catch (e) { /* red on a build without it */ }
		const e = JSON.parse(store.get('daimond-ledger') || '[]')[0] || {};
		check('a patched entry carries dur, out and the facts',
			!!patched && e.dur === 4200 && e.out === 'completed' && e.ft === 812 && e.tc === 3
			&& e.te === 1 && e.ro === 'c', JSON.stringify(e));
		check('zero facts are absent, not 0', !('sg' in e) && !('im' in e), JSON.stringify(e));
		check('no price field moves', ['u', 'e', 'r', 'p', 'c', 'ca', 'm', 'pv', 't', 'tid']
			.every((k) => JSON.stringify(e[k]) === JSON.stringify(before[k])), JSON.stringify(e));
		check('the patched entry is stored in the one key order',
			Object.keys(e).join(',') === 't,m,p,c,ca,u,e,pv,r,tid,dur,out,ft,ro,tc,te', Object.keys(e).join(','));
		let none = 'threw';
		try { none = L.patchTurn('never-seen', { dur: 1, out: 'failed' }); } catch (x) { /* red */ }
		check('patching an id nobody recorded is a no-op returning null', none === null);
		let bad = null;
		try {
			L.record({ ts: now - 3000, model: 'm2', promptTokens: 5, completionTokens: 5, provider: 'p',
				turnId: 'u2', facts: { ft: -4, tc: NaN, te: 'x', sg: 2.6, im: 1, ro: 'z' } });
			bad = JSON.parse(store.get('daimond-ledger')).find((x) => x.tid === 'u2');
		} catch (x) { /* red */ }
		check('record takes the facts too; a negative, non-number or unknown role is absent',
			!!bad && !('ft' in bad) && !('tc' in bad) && !('te' in bad) && bad.sg === 3 && bad.im === 1
			&& !('ro' in bad), JSON.stringify(bad));
		let w = null;
		try {
			L.record({ ts: now - 2000, model: 'm3', promptTokens: 5, completionTokens: 5, provider: 'p',
				turnId: 'w-run1', facts: { ft: 0, tc: 0, te: 0, sg: 0, im: 0, ro: 'w' } });
			w = JSON.parse(store.get('daimond-ledger')).find((x) => x.tid === 'w-run1');
		} catch (x) { /* red */ }
		// A quiet turn adds only `ft` and `ro`.
		check('a quiet turn adds only ft and ro', !!w && w.ft === 0 && w.ro === 'w'
			&& !['tc', 'te', 'sg', 'im'].some((k) => k in w), JSON.stringify(w));
	}

	console.log('\nMC1: the turn meter -- first event, tool calls, failed tools, stalls');
	{
		const { L } = load();
		let f = null;
		try {
			const t0 = 1000000;
			const m = L.meter(t0, { stallMs: 1000 });
			m.see({ type: 'round_meta' }, t0 + 100);			// not a model event: no ft
			m.see({ type: 'thinking' }, t0 + 800);				// the first model event
			m.see({ type: 'text' }, t0 + 900);
			m.see({ type: 'text' }, t0 + 2100);					// a 1200 ms gap in one call: a stall
			m.see({ type: 'tool_call' }, t0 + 2200);
			m.see({ type: 'tool_result', outcome: 'failed' }, t0 + 9000);	// the tool's own time is not a stall
			m.see({ type: 'text' }, t0 + 9500);					// a new provider call: no gap counted
			m.see({ type: 'tool_call' }, t0 + 9600);
			m.see({ type: 'tool_result', outcome: 'refused' }, t0 + 9700);	// the person's or policy's, not counted
			m.see({ type: 'tool_call' }, t0 + 9800);
			m.see({ type: 'tool_result', outcome: 'done' }, t0 + 9900);
			m.end('silent');									// an ending without an answer: one more
			f = m.facts('d');
		} catch (x) { /* red */ }
		check('ft is send to the first model event', !!f && f.ft === 800, JSON.stringify(f));
		check('tc counts every tool result; te only the failed', !!f && f.tc === 3 && f.te === 1, JSON.stringify(f));
		check('sg counts a gap in one call plus a silent ending, never tool time', !!f && f.sg === 2, JSON.stringify(f));
		check('the role travels; no image means no im', !!f && f.ro === 'd' && !f.im, JSON.stringify(f));
		let q = null;
		try {
			const m = L.meter(0, {});
			m.see({ type: 'text' }, 59000);
			m.see({ type: 'text' }, 118000);				// 59 s: under the 60 s default
			m.end('done');
			q = m.facts('c');
		} catch (x) { /* red */ }
		check('the default stall threshold is 60 s; a done ending is not a stall', !!q && !q.sg && q.ft === 59000,
			JSON.stringify(q));
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

main();
