// gateway: live
// verify_handoff_leasewake.mjs -- the runner's claim, its run and its release reach the
// sender within WAKE_S s (D1 of the 2026-10-11 hand-off diagnosis, unit U1).
//
// The live gateway wakes the other devices with the LEASE door's version as a bare
// number on the parcel channel. The client read every bare number as a parcel version
// and dropped it (555 <= 9536), so a claim reached the sender only on its next ordinary
// pull, tens of seconds on, and its tile went on reading "Sent" on a turn the peer held.
//
// Driven on the gateway this run brings up, which is the live build: the fix is the
// client's, and no gateway change is assumed. B's lease acts go through the REAL lease
// door (DaimondSync.leaseGet/leaseCommit), as a runner's do. A's errands are kept off
// the relay, so B never collects them and the only news A can get is the wake (and its
// own slow pull, which the windows below are far inside). A's service worker is blocked:
// WebKit's page.route never sees a request a worker makes, so its errand went out.
//
// The owner's design (D-20261009-23, restated ~22:00): no Take back; the sender shows
// who is running its turn, and that the runner let it go.
//
//   (1) B claims A's dispatched turn: A's tile leaves `dispatched` and says a device is
//       picking it up, within WAKE_S s.
//   (2) B starts it (claimed -> running): A's tile reads running, within WAKE_S s.
//   (3) B releases it: A's tile leaves claimed/running, within WAKE_S s.
//   RERUN-RETRY (D-20261010-22, that unit's, not this one's; expected red, outside the
//   pass count): the runner reloads holding a claim; the sender shows "Interrupted"
//   with Retry within 2 s.
//
// WAKE_S = 3: the client reads the lease door at most once a second with one read in
// flight and one trailing, so a wake lands in one door round-trip plus at most 1 s.
//
//   node dev/verify_handoff_leasewake.mjs [--webkit]
import './predeploy_guard.mjs';	// first: deploy first, refuses (41) this suite on code that is not live (D-20261023-04)
import { pair, send, until, storedMsgs, placeholders, keepErrandsOff, checker, settle } from './handoffpair.mjs';
import { reload } from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const ENGINE = process.argv.includes('--webkit') || process.env.DAIMOND_ENGINE === 'webkit' ? 'webkit' : 'chromium';
const WAKE_S = 3;							// the claim must reach A within this many seconds
const { ok, bad, check } = checker();
let a = null, b = null, offA = null;
try {

/// The real lease door CAS, as daimond.js `peerSyncShim` wires it.
function claimOn(pg, turnId) {
	return pg.evaluate(async (tid) => {
		try {
			const shim = {
				read:    async () => { try { return await DaimondSync.leaseGet(); } catch (e) { return { version: 0, leases: {} }; } },
				commit:  async (base, proposed) => { try { return await DaimondSync.leaseCommit(base, proposed); } catch (e) { return { ok: false, version: base | 0, leases: {} }; } },
				version: () => { try { return DaimondSync.leaseVersion() | 0; } catch (e) { return 0; } },
				leases:  () => { try { return DaimondLease.snapshot() || {}; } catch (e) { return {}; } },
			};
			const cas = DaimondPeer.syncCas(shim);
			const holder = DaimondIdentity.deviceId();
			return await DaimondLease.take(tid, { holder, eid: 'lw-' + Math.random().toString(36).slice(2),
				deadline: Date.now() + 120000 }, cas, Date.now);
		} catch (e) { return { err: String((e && e.message) || e) }; }
	}, turnId);
}

/// The hand-off tile for `tid` on A: its drawn state, its footer words and its controls.
const tileOf = (pg, tid) => pg.evaluate((t) => {
	const el = document.querySelector('.chat-msg-handoff[data-handoff-turn="' + CSS.escape(t) + '"]');
	if (!el) return null;
	const foot = el.querySelector('.ti-handoff');
	return {
		state:    el.dataset.handoffState || '',
		text:     foot ? foot.textContent : '',
		controls: Array.from(el.querySelectorAll('button')).map((b) => b.textContent.trim()),
	};
}, tid).catch(() => null);

/// Send one prompt from A and answer the new dispatched turn's id. A's errands stay off
/// the relay for the whole run (`offA`, never released mid-arm): a late or retried post
/// reaching B would let B collect, run and settle the turn before the claim under test.
async function dispatchOne(a, prompt, seen) {
	const k0 = offA.kept();
	await send(a.page, prompt);
	let tid = '';
	for (let i = 0; i < 60 && !tid; i++) {
		const ph = placeholders(await storedMsgs(a)).map((m) => String(m.iturn)).filter((t) => !seen.has(t));
		tid = ph[0] || '';
		if (!tid) await a.page.waitForTimeout(250);
	}
	for (let i = 0; tid && offA.kept() === k0 && i < 40; i++) await a.page.waitForTimeout(250);
	check('(0) A\'s errand for ' + (tid || '?') + ' was kept off the relay', offA.kept() > k0, 'kept ' + offA.kept());
	if (tid) seen.add(tid);
	return tid;
}

({ a, b } = await pair(check, 'lw-a-' + ENGINE, 'lw-b-' + ENGINE,
	{ openA: { browser: ENGINE, serviceWorkers: 'block' }, openB: { browser: ENGINE } }));
offA = await keepErrandsOff(a.page);
const seen = new Set(placeholders(await storedMsgs(a)).map((m) => String(m.iturn)));
await settle(a.page);

/// A lease act by B on `tid` through the real door: 'renew' (claimed -> running) or 'release'.
function actOn(pg, act, turnId) {
	return pg.evaluate(async ({ act, tid }) => {
		try {
			const shim = {
				read:    async () => { try { return await DaimondSync.leaseGet(); } catch (e) { return { version: 0, leases: {} }; } },
				commit:  async (base, proposed) => { try { return await DaimondSync.leaseCommit(base, proposed); } catch (e) { return { ok: false, version: base | 0, leases: {} }; } },
				version: () => { try { return DaimondSync.leaseVersion() | 0; } catch (e) { return 0; } },
				leases:  () => { try { return DaimondLease.snapshot() || {}; } catch (e) { return {}; } },
			};
			const cas = DaimondPeer.syncCas(shim);
			return await DaimondLease[act](tid, DaimondIdentity.deviceId(), cas, Date.now);
		} catch (e) { return { err: String((e && e.message) || e) }; }
	}, { act, tid: turnId });
}

/// Wait on A until the tile for `tid` is drawn in a state matching `re`; answer the ms taken.
async function stateWithin(pg, tid, re, ms) {
	const t0 = Date.now();
	const hit = await until(pg, ([t, src]) => {
		const el = document.querySelector('.chat-msg-handoff[data-handoff-turn="' + CSS.escape(t) + '"]');
		return !!el && new RegExp(src).test(el.dataset.handoffState || '');
	}, [tid, re.source], ms, 100);
	return { hit: !!hit, ms: Date.now() - t0 };
}

const timings = [];

// ── (1) the claim reaches A by the wake ──────────────────────────────────────
const t1 = await dispatchOne(a, 'leasewake one: write a haiku about tides', seen);
check('(0) A dispatched turn one', !!t1);
await until(a.page, (t) => !!document.querySelector('.chat-msg-handoff[data-handoff-turn="' + CSS.escape(t) + '"]'), t1, 10000);
const pre1 = await tileOf(a.page, t1);
check('(0) A\'s tile reads dispatched before any claim', !!pre1 && /^dispatched/.test(pre1.state), JSON.stringify(pre1));
const c1 = await claimOn(b.page, t1);
check('(0) B claims turn one through the lease door', !!(c1 && c1.won), JSON.stringify(c1));
const w1 = await stateWithin(a.page, t1, /^(claimed|running)/, WAKE_S * 1000);
const post1 = await tileOf(a.page, t1);
timings.push('claim ' + w1.ms + ' ms');
check('(1) A\'s tile shows B picking it up within ' + WAKE_S + ' s of the claim',
	w1.hit && !!post1 && /picking this up|is doing this|Running on/.test(post1.text),
	'after ' + w1.ms + ' ms: ' + JSON.stringify(post1));

// ── (2) the run reaches A by the wake ────────────────────────────────────────
const r2 = await actOn(b.page, 'renew', t1);
check('(0) B starts turn one (claimed -> running)', !!(r2 && r2.ok), JSON.stringify(r2));
const w2 = await stateWithin(a.page, t1, /^running/, WAKE_S * 1000);
const post2 = await tileOf(a.page, t1);
timings.push('run ' + w2.ms + ' ms');
check('(2) A\'s tile shows B running it within ' + WAKE_S + ' s',
	w2.hit && !!post2 && /is doing this|Running on/.test(post2.text),
	'after ' + w2.ms + ' ms: ' + JSON.stringify(post2));

// ── (3) the release reaches A by the wake ────────────────────────────────────
// A release is only news to a tile that showed the run: wait for that (by the wake or A's
// own slow pull) so a tile that never left `dispatched` cannot pass (3) for free.
const held = w2.hit || (await stateWithin(a.page, t1, /^running/, 60000)).hit;
check('(0) A shows B running turn one before the release', held, JSON.stringify(await tileOf(a.page, t1)));
const r3 = await actOn(b.page, 'release', t1);
check('(0) B releases turn one', !!(r3 && r3.ok), JSON.stringify(r3));
const w3 = await stateWithin(a.page, t1, /^(?!claimed|running)/, WAKE_S * 1000);
const post3 = await tileOf(a.page, t1);
timings.push('release ' + w3.ms + ' ms');
check('(3) A\'s tile leaves claimed/running within ' + WAKE_S + ' s of the release',
	held && w3.hit && !!post3 && !/picking this up|is doing this|Running on/.test(post3.text),
	'after ' + w3.ms + ' ms: ' + JSON.stringify(post3));
console.log('wake timings: ' + timings.join(', '));

// ── RERUN-RETRY (D-20261010-22): expected red, outside the pass count ────────
const t3 = await dispatchOne(a, 'leasewake three: name a constellation', seen);
const c3 = t3 ? await claimOn(b.page, t3) : null;
let rr = 'setup failed: ' + JSON.stringify({ t3, c3 });
if (t3 && c3 && c3.won) {
	await stateWithin(a.page, t3, /^claimed/, 10000);
	await reload(b);
	const t4 = Date.now();
	const intr = await until(a.page, (t) => {
		const el = document.querySelector('.chat-msg-handoff[data-handoff-turn="' + CSS.escape(t) + '"]');
		if (!el) return false;
		return /Interrupted/.test(el.textContent) && Array.from(el.querySelectorAll('button')).some((x) => /Retry/.test(x.textContent));
	}, t3, 2000 + 15000, 100);			// measured to 17 s so a slow pass shows its time
	const ms = Date.now() - t4;
	rr = (intr && ms <= 2000 ? 'GREEN' : 'red') + ' (' + (intr ? 'after ' + ms + ' ms' : 'not within 17 s') + '): '
		+ JSON.stringify(await tileOf(a.page, t3));
}
console.log('RERUN-RETRY (expected red, not counted): ' + rr);

	console.log(`\n${ENGINE}: ${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { await b?.close(); } catch (e) {}
}
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
