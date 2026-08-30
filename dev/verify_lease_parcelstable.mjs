// verify_lease_parcelstable.mjs — the LEASE section of the parcel must be a fixed
// point too, and the renew heartbeat must not make it churn for ever.
//
// verify_parcelstable.mjs measures DaimondCore.collectSync() -- the CORE parcel,
// which the lease is NOT part of: the lease is hung on the parcel by sync.js's
// collectParcel (state.leases = DaimondLease.snapshot()). So the lease churn that
// drove two devices to push at each other every 30s is invisible to that verifier.
// This one measures DaimondSync.parcel() (collectParcel itself), and shows:
//
//   1. A HELD, renewing lease is NOT a fixed point -- two collects around a renew
//      differ in exactly the lease's renewedAt/expiry. This is the loop.
//   2. A RELEASED lease (the state runErrand leaves on every clean exit after the
//      fix) IS a fixed point -- two collects are byte-identical.
//   3. The published cap DaimondLease.MAX_LEASE_LIFE_MS exists and is finite, so a
//      renew heartbeat can never run for ever (proven behaviourally in peer.test.mjs).
//
//   DAIMOND_PORT=... node dev/verify_lease_parcelstable.mjs
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'leaseparcel');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'leaseparcel', profile: PROFILE });
const { page } = s;
try {
	await page.waitForFunction(() => !!(window.DaimondSync && DaimondSync.parcel && window.DaimondLease),
		null, { timeout: 15000 });
	await page.waitForTimeout(500);

	const out = await page.evaluate(async () => {
		const L = window.DaimondLease;
		// collectParcel is async, so the parcel is a Promise -- await it.
		const bytes = async () => JSON.stringify(((await DaimondSync.parcel()) || {}).leases || null);
		const r = { steps: {} };

		// ── 1. A held, renewing lease churns the parcel ─────────────
		L.forget();
		const now = 1_700_000_000_000;
		// Install a live running lease, as a held turn would.
		L.install({ 'turn-x': { turnId: 'turn-x', eid: 'e', holder: 'DESK', mode: 'running',
			expiry: now + L.LEASE_TTL_MS, renewedAt: now } });
		const beforeRenew = await bytes();
		// A renew bumps renewedAt/expiry -- exactly what the 30s heartbeat did.
		L.install({ 'turn-x': { turnId: 'turn-x', eid: 'e', holder: 'DESK', mode: 'running',
			expiry: now + L.RENEW_EVERY_MS + L.LEASE_TTL_MS, renewedAt: now + L.RENEW_EVERY_MS } });
		const afterRenew = await bytes();
		r.steps.heldChurns = (beforeRenew !== afterRenew);
		r.steps.churnFields = (() => {
			try {
				const a = JSON.parse(beforeRenew)['turn-x'], b = JSON.parse(afterRenew)['turn-x'];
				return Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).join(',');
			} catch (e) { return ''; }
		})();

		// ── 2. A released lease is a fixed point ────────────────────
		L.forget();
		L.install({ 'turn-x': { turnId: 'turn-x', eid: 'e', holder: 'DESK', mode: 'released',
			expiry: 0, renewedAt: now } });
		const rel1 = await bytes();
		const rel2 = await bytes();			// nothing renews a released lease
		r.steps.releasedFixed = (rel1 === rel2);

		// ── 3. No-lease is a fixed point ────────────────────────────
		L.forget();
		const none1 = await bytes();
		const none2 = await bytes();
		r.steps.vacantFixed = (none1 === none2 && (none1 === 'null' || none1 === '{}'));

		// ── 4. The heartbeat cap is finite ──────────────────────────
		r.steps.capFinite = (typeof L.MAX_LEASE_LIFE_MS === 'number' && isFinite(L.MAX_LEASE_LIFE_MS) && L.MAX_LEASE_LIFE_MS > 0);
		r.steps.cap = L.MAX_LEASE_LIFE_MS;

		L.forget();
		return r;
	});

	check(out.steps.heldChurns === true,
		'LOOP (before): a held, renewing lease is NOT a fixed point (churns every renew)',
		'changed fields: ' + out.steps.churnFields);
	check(out.steps.releasedFixed === true,
		'FIXED (after): a RELEASED lease collects byte-identical twice (fixed point)');
	check(out.steps.vacantFixed === true,
		'FIXED: no lease held collects byte-identical twice (fixed point)');
	check(out.steps.capFinite === true,
		'the renew heartbeat has a FINITE published cap (no forever-renew)', 'MAX_LEASE_LIFE_MS=' + out.steps.cap);

} finally {
	await s.close();
}
console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
