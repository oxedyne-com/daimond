// verify_lease_parcelstable.mjs — the LEASE must NOT ride the content parcel, so a
// held, renewing lease can never make the parcel churn.
//
// This test used to prove the OPPOSITE — that a held lease churned the parcel every
// renew — because the lease was a parcel section (collectParcel: state.leases =
// DaimondLease.snapshot()). That churn made a lease CLAIM a whole-parcel
// compare-and-set, which stormed the gateway with 409s under multi-device hand-off
// races. The lease now has its OWN lightweight CAS door (DaimondSync.leaseGet /
// leaseCommit), off the parcel entirely, exactly as presence does. So this verifier
// is now the regression guard for that move, and shows:
//
//   1. A HELD, renewing lease does NOT appear in the parcel at all, and the parcel
//      is byte-identical across a renew -- the churn is gone because the lease left.
//   2. The lease door exists (DaimondSync.leaseGet / leaseCommit), which is where a
//      lease now lives.
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
		// collectParcel is async, so the parcel is a Promise -- await it. Measure the
		// WHOLE parcel, and separately its (now absent) lease section.
		const whole   = async () => JSON.stringify((await DaimondSync.parcel()) || {});
		const leaseOf = async () => JSON.stringify(((await DaimondSync.parcel()) || {}).leases || null);
		const r = { steps: {} };

		// ── 1. A held, renewing lease is OFF the parcel and does not churn it ──
		L.forget();
		const now = 1_700_000_000_000;
		// Install a live running lease, as a held turn would.
		L.install({ 'turn-x': { turnId: 'turn-x', eid: 'e', holder: 'DESK', mode: 'running',
			expiry: now + L.LEASE_TTL_MS, renewedAt: now } });
		const wholeBefore = await whole();
		r.steps.leaseAbsent = ((await leaseOf()) === 'null');	// the lease is not a parcel section
		// A renew bumps renewedAt/expiry -- exactly what the 30s heartbeat did. It must
		// NOT move the parcel, because the lease no longer rides it.
		L.install({ 'turn-x': { turnId: 'turn-x', eid: 'e', holder: 'DESK', mode: 'running',
			expiry: now + L.RENEW_EVERY_MS + L.LEASE_TTL_MS, renewedAt: now + L.RENEW_EVERY_MS } });
		const wholeAfter = await whole();
		r.steps.parcelStableAcrossRenew = (wholeBefore === wholeAfter);

		// ── 2. The lease lives on its own door now ──────────────────
		r.steps.doorExists = (typeof DaimondSync.leaseGet === 'function'
			&& typeof DaimondSync.leaseCommit === 'function');

		// ── 3. The heartbeat cap is finite ──────────────────────────
		r.steps.capFinite = (typeof L.MAX_LEASE_LIFE_MS === 'number' && isFinite(L.MAX_LEASE_LIFE_MS) && L.MAX_LEASE_LIFE_MS > 0);
		r.steps.cap = L.MAX_LEASE_LIFE_MS;

		L.forget();
		return r;
	});

	check(out.steps.leaseAbsent === true,
		'OFF THE PARCEL: a held lease is NOT a parcel section (collectParcel has no leases)');
	check(out.steps.parcelStableAcrossRenew === true,
		'NO CHURN: the parcel is byte-identical across a lease renew (the storm cause is gone)');
	check(out.steps.doorExists === true,
		'the lease lives on its own door now (DaimondSync.leaseGet / leaseCommit)');
	check(out.steps.capFinite === true,
		'the renew heartbeat has a FINITE published cap (no forever-renew)', 'MAX_LEASE_LIFE_MS=' + out.steps.cap);

} finally {
	await s.close();
}
console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
