// gateway: live
// verify_mailclaim_sync.mjs — one device per mail arrival, over a real lease door (MO-1,
// D-20261016-17).
//
// Every open device polls the synced mailbox and announces the same arrival, and an off-screen
// mail turn would run on each. `claimMailArrival` (daimond.js) claims the arrival on the lease
// door first, keyed by Diamond, mailbox, folder, uidvalidity and highest uid; this drives that
// claim on two paired devices through this world's own gateway, with the real sealed door:
//
//   C1  A and B claim the same arrival AT ONCE -> exactly one may run it.
//   C2  the winner settles (its turn ran) -> the other, asking again, drops it: no second turn.
//   C3  a later message is a new arrival, which the other device may take.
//   C4  a winner that never settles (it died mid-turn) -> the other holds it owed, rather
//       than running it or forgetting it.
//   C5  the answered mark (r569): it rode the door to the other device, and a claim lives
//       one lease TTL (renewed while its turn runs), not to a fixed 15-minute deadline.
//
// The whole turn path (fire -> claim -> steer -> settle, and the lapse taken over) is
// www/js/mailclaim.test.mjs, over two copies of the real peer.js; this proves the door.
//
// A is Chromium at a desktop size; B is WebKit with an iPhone's UA, touch and viewport.
//
//   eval "$(bash dev/world.sh 79 --env)"; node dev/verify_mailclaim_sync.mjs
//   MC_BREAK=noclaim node dev/verify_mailclaim_sync.mjs     # must FAIL: both devices run C1
import fs from 'node:fs';
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 400) : ''));
};
const DaimondLeaseLive = (r) => !!r && r.mode !== 'released' && +r.expiry > Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

const NAME = 'mcsync';
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROFILE = (x) => scratch('pw', 'mcsync-' + x + '-' + process.pid);

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondMailClaim && window.DaimondGateway
	&& DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});

async function pairedDevice(lead, label, opts) {
	const d = await open(Object.assign({ name: NAME + '-' + label, signIn: false, connect: false, defaults: false,
		profile: PROFILE(label) }, opts || {}));
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, NAME);
	await ready(d);
	await sleep(2500);
	return d;
}

/// Claim one arrival on a device. Holds the claim in the page under `slot`, for `settle`.
const claim = (s, occ, slot) => s.page.evaluate(async ([occ, slot]) => {
	const c = await DaimondMailClaim.claim('dia-email', occ);
	(window.__claims = window.__claims || {})[slot] = c;
	const r = c.tid && window.DaimondLease ? DaimondLease.record(c.tid) : null;
	return { go: !!c.go, drop: !!c.drop, tid: c.tid || '', now: DaimondLease.authorityNow(),
		expiry: r ? +r.expiry || 0 : 0 };
}, [occ, slot]);
// A turn that went here answered (review R569 B-1: only an answered turn raises the mark).
const settle = (s, slot, went) => s.page.evaluate(async ([slot, went]) => {
	await DaimondMailClaim.settle(window.__claims[slot], went, went);
	return true;
}, [slot, went]);

const OCC = { kind: 'mail', mailbox: 'alerts@oxegen.io', folder: 'INBOX', uids: [41, 42], uidValidity: 7 };

let A = null, B = null;
try {
	process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
	A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a'), viewport: { width: 1920, height: 961 } });
	await ready(A);
	const pro = await makePagePro(A.page, GWDIR, GW_URL);
	check('the account holds Pro, so the lease door is open at all', pro.pro === true, J(pro));
	B = await pairedDevice(A, 'phone', { browser: 'webkit', touch: true, ua: IPHONE, viewport: { width: 393, height: 793 } });
	const ids = await Promise.all([A, B].map((s) => s.page.evaluate(() => DaimondIdentity.deviceId())));
	check('B is WebKit, paired, signed in, and a different device', B.page.context().browser().browserType().name() === 'webkit'
		&& await B.page.evaluate(() => !!(window.DaimondGateway && DaimondGateway.state().authed)) && ids[0] && ids[0] !== ids[1], J(ids));
	// THE BREAK: no claim at all, the code as 6d8c1373 shipped it -- every device runs the turn.
	if (process.env.MC_BREAK === 'noclaim') {
		for (const s of [A, B]) await s.page.evaluate(() => { DaimondMailClaim.claim = async () => ({ go: true }); });
	}

	// ── C1 ────────────────────────────────────────────────────────────────────
	const [a1, b1] = await Promise.all([claim(A, OCC, 'c1'), claim(B, OCC, 'c1')]);
	const goes = [a1, b1].filter((x) => x.go).length;
	check('C1. two devices claim the same arrival at once: exactly one runs it', goes === 1, J({ a1, b1 }));
	const [W, L] = a1.go ? [A, B] : [B, A];
	const lost = a1.go ? b1 : a1;
	check('C1. the loser holds it owed, to look again', !lost.go && !lost.drop, J(lost));
	const won = a1.go ? a1 : b1;
	check('C5. the claim lives one lease TTL, renewed while it runs, not a fixed 15 minutes',
		won.expiry > won.now && won.expiry <= won.now + 95e3, J(won));

	// ── C2 ────────────────────────────────────────────────────────────────────
	await settle(W, 'c1', true);
	const l2 = await claim(L, OCC, 'c2');
	check('C2. after the winner\'s turn, the other device asking again drops it', l2.drop === true && !l2.go, J(l2));
	const w2 = await claim(W, OCC, 'c2w');
	check('C2. and so does the winner itself: a settled arrival never runs twice', w2.drop === true && !w2.go, J(w2));
	const mk = await L.page.evaluate(() => DaimondLease.record('mark:mail:dia-email:alerts@oxegen.io:INBOX'));
	check('C5. the answered mark reached the other device: through uid 42 in generation 7',
		!!mk && mk.mark === 42 && mk.gen === 7 && !DaimondLeaseLive(mk), J(mk));

	// ── C3 ────────────────────────────────────────────────────────────────────
	const NEXT = Object.assign({}, OCC, { uids: [43] });
	const l3 = await claim(L, NEXT, 'c3');
	check('C3. a later message is its own arrival, and the other device may take it', l3.go === true && !!l3.tid, J(l3));

	// ── C4 ────────────────────────────────────────────────────────────────────
	const DIES = Object.assign({}, OCC, { uids: [44] });
	const w4 = await claim(W, DIES, 'c4');		// claimed and never settled: its device died
	const l4 = await claim(L, DIES, 'c4');
	check('C4. a live claim nobody settled holds the other device off, owed and not dropped',
		w4.go === true && !l4.go && !l4.drop, J({ w4, l4 }));
	await settle(L, 'c3', true);
} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	for (const s of [A, B]) { try { await s?.close?.(); } catch (e) { /* closing */ } }
	for (const x of ['a', 'phone']) { try { fs.rmSync(PROFILE(x), { recursive: true, force: true }); } catch (e) { /* tidy */ } }
}

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
