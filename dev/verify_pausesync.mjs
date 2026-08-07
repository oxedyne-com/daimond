// verify_pausesync.mjs — the pause tree travels between devices, and carrying it
// does not turn the sync into a loop.
//
// Two properties, and the second is the dangerous one.
//
// TRAVELS. What may spend is a fact about the ACCOUNT, not about the browser it
// was set in. A Diamond paused on the laptop that spends freely on the phone is
// the control not working, so the pause tree rides in the sync parcel: sync.js
// hangs `DaimondPause.snapshot()` on what `collectSync()` gathers, and feeds
// what arrives to `DaimondPause.adopt()`.
//
// DOES NOT LOOP. `push()` skips the wire only when the parcel byte-matches what
// it LAST SENT -- never what it last received (`www/js/sync.js`). So a section
// that differs between two collects, or that rewrites itself on the way in,
// makes the device permanently have news: A pushes, B merges, B now differs, B
// pushes, A merges, and round it goes at about a second a lap with neither
// device doing anything wrong. That has happened here twice; the second time it
// was reported from an iPhone freshly paired by QR.
//
// `dev/verify_parcelstable.mjs` pins the same property on the core parcel and
// `dev/verify_pausecore.mjs` pins the pure merge. Neither can see this: the
// former compares `DaimondCore.collectSync()`, which does not carry what sync.js
// hangs on it, and the latter never packs a parcel. So the checks here go
// through `DaimondSync.parcel()` and `DaimondSync.apply()` -- the very functions
// `push()` and `pull()` use -- and the merge checks are only the ones that need
// a page or a second device.
//
// AND THE ONE VERIFY_SYNC §12 NEVER MADE. That section drives two real paired
// profiles and asserts the CONTENT converges. It never asserts the mailbox
// version stops moving, so an unbounded push loop passes it green: content
// converges on every lap of the loop. §D below leaves both devices idle and
// requires the version to sit still. It belongs in §12; it is here because
// verify_sync.mjs is not this agent's to edit.
//
//   node dev/verify_pausesync.mjs
//
// Sections A-C need dev/serve.mjs only (DAIMOND_PORT, default 8777).
// Section D needs a gateway on :9002 as well, and SKIPS with a line rather than
// failing when there is none -- :9002 holds one account store and is shared.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const GWDIR = path.resolve(HERE, '..', 'gateway');
const GWURL = 'http://127.0.0.1:9002';

let bad = 0, skipped = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const skip = (name, why) => { skipped++; console.log('  SKIP ' + name + ' — ' + why); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Which top-level sections of two parcels differ, and which fields inside them.
/// "The parcel differs" is not a finding anybody can act on.
function differences(a, b) {
	const out = [];
	const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
	for (const k of keys) {
		const x = JSON.stringify(a ? a[k] : undefined);
		const y = JSON.stringify(b ? b[k] : undefined);
		if (x === y) continue;
		out.push(`${k}(${String(x).slice(0, 60)} → ${String(y).slice(0, 60)})`);
	}
	return out;
}

/// Is a gateway answering on :9002? Section D is the only part that needs one,
/// and :9002 is shared -- so this asks rather than assuming, and never starts one.
async function gatewayUp() {
	try {
		const r = await fetch(GWURL + '/api/health', { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch (e) { return false; }
}

// Two leaf ids that no tree in the app has to know about: `DaimondPause.set`
// falls back to treating an unknown id as a leaf, which is precisely the shape
// of the thing this is about -- one node that may or may not spend.
const LEAF_A = 'root/diamonds/pausesync-a/self';
const LEAF_B = 'root/diamonds/pausesync-b/self';

const PROFILE = scratch('pw', 'pausesync');
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'pausesync', profile: PROFILE, defaults: false });
const { page } = s;
let child = null;

try {
	await page.waitForFunction(
		() => !!(window.DaimondSync && DaimondSync.parcel && window.DaimondPause
			&& window.DaimondCore && DaimondCore.collectSync),
		null, { timeout: 15000 });
	await page.waitForTimeout(800);

	const parcel = () => page.evaluate(() => DaimondSync.parcel());

	// ── A. The parcel carries it, and carrying it is stable ─────────
	// Order matters: an empty pause section is stable for the trivial reason
	// that there is nothing in it, so the pauses go on FIRST and every check
	// below runs with a non-empty set.
	await page.evaluate((ids) => {
		DaimondPause.set(ids.a, false);		// false = paused
		DaimondPause.set(ids.b, false);
	}, { a: LEAF_A, b: LEAF_B });

	const p1 = await parcel();
	const carried = (p1.pause && p1.pause.paused) || [];
	check(carried.length === 2 && carried.indexOf(LEAF_A) !== -1 && carried.indexOf(LEAF_B) !== -1,
		'the parcel carries the paused leaves', JSON.stringify(p1.pause));
	check(!!(p1.pause && p1.pause.stamp > 0),
		'and a stamp that says when the set last moved', String(p1.pause && p1.pause.stamp));
	// Everything below reads `parcel.pause`. A build that carries no such section
	// must say so in one line rather than throwing a TypeError over the top of
	// the two checks that just named the real fault.
	if (!p1.pause) throw new Error('no `pause` section in the parcel — nothing below can be measured');

	// A gap between the two, because a stamp taken at collect time with second
	// resolution sits still inside one millisecond and moves inside two.
	await page.waitForTimeout(2500);
	const p2 = await parcel();
	const drift = differences(p1, p2);
	check(drift.length === 0, 'two collects with pauses set are byte-identical', drift.join(' '));

	// ── B. The fixed point ──────────────────────────────────────────
	// Apply this device's OWN parcel. Nothing in it is news, so what it would
	// send next must be exactly what it just took in. This is the check the
	// loop is made of: a section that stamps on apply passes A and fails here.
	const failedOwn = await page.evaluate(p => DaimondSync.apply(p), p2);
	check(failedOwn.indexOf('pause') === -1, 'applying its own parcel does not fail the pause section',
		failedOwn.join(','));
	await page.waitForTimeout(600);
	const p3 = await parcel();
	const fixed = differences(p2, p3);
	check(fixed.length === 0, 'and leaves the next parcel unchanged (the fixed point)',
		fixed.join(' '));

	// A parcel that IS news, from a device whose stamp is later. The record wins
	// whole -- and this device must then send back exactly what it received, not
	// a restamped copy of it. A restamp here is the `touchSelfDevice` bug.
	// `Number(...)`, never `| 0`: a millisecond stamp is well past 2^31, and
	// truncating it to 32 bits makes the "later" record the earlier one. The
	// check below caught that when this file did it.
	const NEWS = { paused: [LEAF_B, 'root/mail/someone%40example.com/INBOX'].sort(),
		stamp: Number(p3.pause.stamp) + 60000 };
	await page.evaluate(async (arg) => {
		const p = await DaimondSync.parcel();
		p.pause = arg.news;
		await DaimondSync.apply(p);
	}, { news: NEWS });
	const p4 = await parcel();
	check(JSON.stringify(p4.pause) === JSON.stringify(NEWS),
		'a later record is adopted whole, and sent back unrestamped', JSON.stringify(p4.pause));
	await page.waitForTimeout(1200);
	const p5 = await parcel();
	check(differences(p4, p5).length === 0, 'and the parcel is still a fixed point after adopting news',
		differences(p4, p5).join(' '));

	// A resume, which is the direction a union merge gets wrong. The other
	// device un-paused everything at a later stamp; a merge that unioned would
	// keep this device's leaves paused for ever and no resume would ever travel.
	const RESUMED = { paused: [], stamp: NEWS.stamp + 60000 };
	await page.evaluate(async (arg) => {
		const p = await DaimondSync.parcel();
		p.pause = arg.rec;
		await DaimondSync.apply(p);
	}, { rec: RESUMED });
	const stillPaused = await page.evaluate(ids => ({
		a: DaimondPause.isPaused(ids.a), b: DaimondPause.isPaused(ids.b),
	}), { a: LEAF_A, b: LEAF_B });
	check(stillPaused.a === false && stillPaused.b === false,
		'a resume at a later stamp travels — the merge is not a union',
		JSON.stringify(stillPaused));

	// An equal stamp errs the other way, towards paused, and the device then has
	// news EXACTLY ONCE: the union is a fixed point of the next collect.
	await page.evaluate((ids) => { DaimondPause.set(ids.a, false); }, { a: LEAF_A });
	const eqBase = await parcel();
	const EQUAL = { paused: [LEAF_B], stamp: eqBase.pause.stamp };
	await page.evaluate(async (arg) => {
		const p = await DaimondSync.parcel();
		p.pause = arg.rec;
		await DaimondSync.apply(p);
	}, { rec: EQUAL });
	const p6 = await parcel();
	check(JSON.stringify(p6.pause.paused) === JSON.stringify([LEAF_A, LEAF_B].sort()),
		'two records at the same stamp merge to the union', JSON.stringify(p6.pause.paused));
	await page.evaluate(p => DaimondSync.apply(p), p6);
	await page.waitForTimeout(600);
	const p7 = await parcel();
	check(differences(p6, p7).length === 0,
		'and the union settles in one round rather than oscillating',
		differences(p6, p7).join(' '));

	// ── C. Across a reload ──────────────────────────────────────────
	// A device that restarts and immediately has something to send pushes on
	// every launch: the same loop with a slower clock.
	await page.reload({ waitUntil: 'domcontentloaded' });
	// Unlocked again, because a reload locks the identity and section D needs a
	// key to seal a parcel with. The pause set is read from localStorage either
	// way, so this does not soften the check -- it makes it a device that has
	// really been picked up again rather than one sitting at its gate.
	await signInAs(s, 'pausesync');
	await page.waitForFunction(() => !!(window.DaimondSync && DaimondSync.parcel),
		null, { timeout: 15000 });
	await page.waitForTimeout(1500);
	const p8 = await parcel();
	check(JSON.stringify(p8.pause) === JSON.stringify(p7.pause),
		'a reload does not change the pause section this device would send',
		JSON.stringify(p8.pause) + ' vs ' + JSON.stringify(p7.pause));

	// ── D. Two real devices, and a version that stops moving ────────
	if (!(await gatewayUp())) {
		skip('two real devices converge, both ways', 'no gateway on :9002');
		skip('the mailbox version stops moving when both devices are idle', 'no gateway on :9002');
	} else {
		const lic = await makePagePro(page, GWDIR, GWURL);
		check(lic.pro === true, 'the account holds Pro, so sync may run at all',
			`webhook ${lic.status}, pro=${lic.pro}`);

		// A second REAL device on its own profile, paired in as verify_sync §12
		// does it. Two windows both open and both focused is the case that broke
		// in the field; nothing below touches either window.
		child = await open({ name: 'pausemate', signIn: false, connect: false });
		await child.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 })
			.catch(() => {});
		const code = await page.evaluate(() => DaimondPairing.create());
		await child.page.evaluate(c => DaimondPairing.redeem(c), code.code);
		await child.page.reload({ waitUntil: 'domcontentloaded' });
		await signInAs(child, 'pausesync');
		await child.page.waitForFunction(
			() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed,
			null, { timeout: 15000 }).catch(() => {});
		const mine = await page.evaluate(() => DaimondIdentity.publicKeyB64url());
		const mate = await child.page.evaluate(() => ({
			authed: DaimondGateway.state().authed, same: DaimondIdentity.publicKeyB64url(),
		}));
		check(mate.authed === true && mate.same === mine,
			'a second REAL device holds the same account and an authed session',
			JSON.stringify(mate).slice(0, 80));

		/// Push until the mailbox version actually advances. One `push()` call
		/// proves nothing: one that finds the app busy or a round in flight only
		/// reschedules and returns.
		const pushLanded = async (pg) => pg.evaluate(async () => {
			const v0 = DaimondSync.state().version;
			const t0 = Date.now();
			while (DaimondSync.state().version <= v0 && Date.now() - t0 < 10000) {
				await DaimondSync.push();
				await new Promise(r => setTimeout(r, 200));
			}
			return DaimondSync.state().version;
		});

		// Bring both devices onto one shared base, and quiesce the mate: whatever
		// it would send, it has already sent. That is the state every idle device
		// is in, and the state §D's last check measures.
		await pushLanded(page);
		await child.page.evaluate(() => DaimondSync.pull());
		await pushLanded(child.page);
		await page.evaluate(() => DaimondSync.pull());
		await page.evaluate(() => DaimondSync.push());
		await sleep(800);
		await child.page.evaluate(() => DaimondSync.push());
		await sleep(800);

		const pausedOn = (pg, id) => pg.evaluate(x => DaimondPause.isPaused(x), id);

		// (D1) This device pauses a leaf. The other one learns it.
		const LIVE = 'root/diamonds/pausesync-live/self';
		await page.evaluate(x => DaimondPause.set(x, false), LIVE);
		await pushLanded(page);
		await child.page.evaluate(() => DaimondSync.pull());
		check(await pausedOn(child.page, LIVE) === true,
			'a pause set on one device arrives paused on the other');

		// (D2) And the other one resumes it, which is the direction that matters:
		// a merge that unioned would leave this device paused for ever.
		await child.page.evaluate(x => DaimondPause.set(x, true), LIVE);
		await pushLanded(child.page);
		await page.evaluate(() => DaimondSync.pull());
		check(await pausedOn(page, LIVE) === false,
			'and a resume on the other device travels back — not swallowed by a union');

		// (D3) THE ASSERTION §12 NEVER MADE.
		//
		// Once both devices are idle and agreed, the mailbox version must sit
		// still. If it climbs, the two are pushing at each other -- which is what
		// the iPhone did, and which every convergence check in verify_sync passes
		// happily, because content converges on every lap of the loop.
		//
		// Nothing is done to either window: no focus, no reload, no event. What
		// runs is the engine's own scheduling, which is exactly what ran in the
		// field.

		/// Wait until the version has been unchanged on BOTH devices for
		/// `quietMs`, and say whether it ever was.
		///
		/// The pause that just travelled schedules one more push behind a 2.5s
		/// debounce, so a measurement started the instant D2 returns catches a
		/// straggler and reports a loop that is not there. Waiting for quiet is
		/// not softening the check: a build that really loops never goes quiet,
		/// so this arm fails first and says how long it watched.
		const settle = async (quietMs, capMs) => {
			const read = async () => [
				await page.evaluate(() => DaimondSync.state().version),
				await child.page.evaluate(() => DaimondSync.state().version),
			].join('/');
			let last = '', since = Date.now();
			const t0 = Date.now();
			while (Date.now() - t0 < capMs) {
				const v = await read();
				if (v !== last) { last = v; since = Date.now(); }
				else if (Date.now() - since >= quietMs) return { quiet: true, v: last, took: Date.now() - t0 };
				await sleep(1000);
			}
			return { quiet: false, v: last, took: Date.now() - t0 };
		};
		const settled = await settle(5000, 40000);
		check(settled.quiet === true,
			'the account goes quiet after a pause has travelled both ways',
			`versions ${settled.v} after ${Math.round(settled.took / 1000)}s`);

		// And then STAYS quiet. Fifteen seconds is many laps of a one-second loop.
		const v0 = { a: await page.evaluate(() => DaimondSync.state().version),
			b: await child.page.evaluate(() => DaimondSync.state().version) };
		await sleep(15000);
		const v1 = { a: await page.evaluate(() => DaimondSync.state().version),
			b: await child.page.evaluate(() => DaimondSync.state().version) };
		check(v1.a === v0.a && v1.b === v0.b,
			'the mailbox version stops moving when both devices are idle',
			`this ${v0.a}→${v1.a}, mate ${v0.b}→${v1.b}`);

		// And they still agree afterwards: a version that sat still because sync
		// had quietly died would pass the check above for the wrong reason.
		const agree = {
			mine: await page.evaluate(() => DaimondSync.parcel().then(p => JSON.stringify(p.pause))),
			mate: await child.page.evaluate(() => DaimondSync.parcel().then(p => JSON.stringify(p.pause))),
		};
		check(agree.mine === agree.mate,
			'and the two devices hold the same pause tree at the end of it',
			agree.mine + ' vs ' + agree.mate);
		// And neither of them is stuck: a version that sat still because sync had
		// given up would pass the check above for the wrong reason, and the two
		// agreeing above would then be two devices agreeing about nothing new.
		const stalls = {
			mine: await page.evaluate(() => DaimondSync.state().stalledWhy),
			mate: await child.page.evaluate(() => DaimondSync.state().stalledWhy),
		};
		check(!stalls.mine && !stalls.mate, 'and neither device is stalled',
			JSON.stringify(stalls));
	}

} catch (e) {
	// A throw part-way through must still land as a FAIL line and a summary. A
	// stack trace over the top of the checks that already named the fault sends
	// the reader looking in the wrong file.
	check(false, 'the run got to the end', String((e && e.message) || e));
} finally {
	if (child) await child.close();
	await s.close();
}

console.log(bad === 0
	? `\nall checks passed${skipped ? ` (${skipped} skipped)` : ''}`
	: `\n${bad} check(s) FAILED${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(bad === 0 ? 0 : 1);
