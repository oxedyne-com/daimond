/* ============================================================
   Test — the runner's boot recovery retries a turn whose work
   claim is busy, rather than dropping it (RUNNER-READY F3,
   www/js/daimond.js `recoverRunnerTurns`, 2026-10-16).
   ------------------------------------------------------------
   The defect (reconstruct_diag.md): at boot a reloaded runner's
   collect held the work claim on its own turn, so the recovery's
   `claimTurnHere` answered null and the recovery `continue`d past
   it for good. When that collect then failed and released the
   lease unsettled, nothing ever folded the journal's partial run:
   both devices ended `lost 0`.

   The fix: a turn whose claim is busy is asked again later, on the
   same bounded schedule an unread door is; once the lease is no
   longer this device's live claim, the retry leaves it, as before.

   Drives the REAL `recoverRunnerTurns`, lifted from daimond.js.
     node www/js/runnerrecover.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

function extractFn(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}
const APP = readPage(join(HERE, 'daimond.js'), 'utf8');
const drain = () => new Promise((r) => setImmediate(r));
async function ticks(n = 30) { for (let i = 0; i < n; i++) await drain(); }

/// A world: the lease door, the claim (busy or free), the timers set, the turns ended.
function makeWorld(leases) {
	const w = { leases, busy: new Set(), timers: [], ended: [] };
	const scope = {
		DaimondPeer: {
			readTwice: async () => ({ leases: JSON.parse(JSON.stringify(w.leases)), unread: false }),
			syncCas: (x) => x,
		},
		DaimondLease: { live: (r, now) => !!r && r.mode !== 'released' && r.expiry > now },
		peerSyncShim: () => ({}),
		selfDeviceId: () => 'SELF',
		leaseClockNow: () => 1000,
		claimTurnHere: async (tid) => (w.busy.has(tid) ? null : { release() {} }),
		endRunnerTurn: async (tid) => { w.ended.push(tid); return true; },
		setTimeout: (fn, ms) => { w.timers.push({ fn, ms }); return w.timers.length; },
	};
	scope.window = scope;
	const fn = new Function('scope', 'with (scope) {\n' + extractFn(APP, 'recoverRunnerTurns')
		+ '\nreturn recoverRunnerTurns;\n}')(scope);
	return { w, recover: fn };
}
const LIVE = { holder: 'SELF', mode: 'claimed', expiry: 99999 };

async function main() {
	console.log('a turn whose work claim is busy at boot is asked again, and ended once it is free');
	{
		const { w, recover } = makeWorld({ T1: { ...LIVE } });
		w.busy.add('T1');				// the boot's collect holds the claim
		await recover(['T1'], 0);
		check('nothing is ended while the claim is busy', w.ended.length === 0, w.ended);
		check('a retry is armed', w.timers.length === 1, w.timers.length);
		w.busy.delete('T1');			// the collect let go; the lease is still this device's
		if (w.timers[0]) w.timers[0].fn();
		await ticks();
		check('the retry ends the turn', JSON.stringify(w.ended) === '["T1"]', w.ended);
	}
	console.log('\nthe retry leaves a turn whose lease is no longer this device\'s live claim');
	{
		const { w, recover } = makeWorld({ T1: { ...LIVE } });
		w.busy.add('T1');
		await recover(['T1'], 0);
		w.busy.delete('T1');
		w.leases.T1 = { holder: 'SELF', mode: 'released', settled: 1, expiry: 0 };	// the collect settled it
		if (w.timers[0]) w.timers[0].fn();
		await ticks();
		check('nothing is ended', w.ended.length === 0, w.ended);
		check('and no further retry is armed', w.timers.length === 1, w.timers.length);
	}
	console.log('\nthe retries are bounded');
	{
		const { w, recover } = makeWorld({ T1: { ...LIVE } });
		w.busy.add('T1');
		await recover(['T1'], 0);
		for (let i = 0; i < 20 && w.timers[i]; i++) { w.timers[i].fn(); await ticks(); }
		check('at most six retries', w.timers.length > 0 && w.timers.length <= 6, w.timers.length);
	}
	console.log('\n[ctl] a free claim ends the turn at once, with no retry');
	{
		const { w, recover } = makeWorld({ T1: { ...LIVE }, T2: { holder: 'OTHER', mode: 'claimed', expiry: 99999 } });
		await recover(['T1', 'T2'], 0);
		check('T1 ended, T2 (another device\'s) left', JSON.stringify(w.ended) === '["T1"]', w.ended);
		check('no retry', w.timers.length === 0, w.timers.length);
	}
	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	process.exit(failures > 0 ? 1 : 0);
}
await main();
