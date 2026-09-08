// verify_rosterghost.mjs — the ghost-device-roster / dead-nominee fix (owner trace,
// 2026-09-08, live build e9f7f9b5edbc). Reproduces the MEASURED state on the iOS
// engine (WebKit / JavaScriptCore):
//
//   - the synced roster holds only SUPERSEDED ghost ids, disjoint from the devices
//     that are actually beating — the add-only UNION merge never prunes a dead line;
//   - the NOMINEE points at the argonaut's dead old id, so the election finds it
//     absent from presence and falls through to the FRESHEST peer (gilgamesh) —
//     works by luck when that is argonaut, broken as a mechanism.
//
// It drives the REAL www/js/daimond.js reconcile (DaimondCore.roster) and the REAL
// www/js/peer.js election (autoDispatchDecision) and shows deterministically:
//   (a) rosterLiveness names the dead nominee's line a GHOST and the live same-name
//       device its replacement;
//   (b) reconcileNominee migrates the star onto the live device, and the election
//       then SEATS the turn on it (reason 'nominee') where before it misrouted to
//       the fresher peer;
//   (c) a pruned ghost STAYS pruned across a sync round (the tombstone survives the
//       add-only merge that would otherwise hand it back);
//   (d) NEGATIVE CONTROL: a healthy single-identity fleet is untouched — no ghost,
//       no migration, the nominee seats normally;
//   (e) AMBIGUITY SAFETY: a dead nominee whose name TWO live devices share is never
//       migrated (an ambiguous name is not guessed).
//
// Client-only; no gateway, no mock, no turn is billed. Run:
//   DAIMOND_APP=http://localhost:8795 node dev/verify_rosterghost.mjs

import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

let s;
try {
	s = await open({ name: 'rosterghost', browser: (process.env.NOM_B || 'webkit').toLowerCase(), connect: false });
	await s.page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.roster
		&& DaimondCore.roster.liveness && DaimondCore.roster.reconcileNominee
		&& window.DaimondPeer && DaimondPeer.autoDispatchDecision
		&& window.DaimondPresence && DaimondPresence.beat), null, { timeout: 20000 });

	const ua = await s.page.evaluate(() => navigator.userAgent);
	const isWebkit = /WebKit/.test(ua) && !/Chrome\//.test(ua);
	check('running under WebKit, the iOS engine', isWebkit, ua.slice(0, 70));

	// ── (a)+(b) THE MEASURED STATE, then the fix ───────────────────────────────
	const r = await s.page.evaluate(() => {
		const R = DaimondCore.roster, P = DaimondPeer, PR = DaimondPresence;
		const W = P.DISPATCH_FRESH_MS, now = Date.now();
		// A clean slate: no roster, no nominee, no presence, no tombstones.
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs'].forEach(k => {
			try { localStorage.removeItem(k); } catch (e) {}
		});
		const SELF = DaimondIdentity.deviceId();				// this device = the phone
		const NOM_DEAD = 'a1a1a1a1a1a1a1a1';					// argonaut's dead OLD id (the nominee)
		const LIVE_ARG = 'b2b2b2b2b2b2b2b2';					// argonaut, returned under a NEW id
		const LIVE_GIL = 'c3c3c3c3c3c3c3c3';					// gilgamesh, a fresher peer
		const GHOST_2  = 'd4d4d4d4d4d4d4d4';					// a second superseded ghost
		const ARG_NAME = 'Chrome on Argonaut Linux';
		const GIL_NAME = 'Chrome on Gilgamesh Linux';
		// The DISJOINT roster the trace showed: only dead/superseded lines, none of
		// them beating. `seen` well in the past so nothing reads them as fresh.
		const old = now - 40 * 24 * 3600 * 1000;
		const roster = {};
		roster[SELF]     = { name: 'Safari on iOS',  label: '', created: old, namedAt: 0, seen: now };
		roster[NOM_DEAD] = { name: ARG_NAME,         label: '', created: old, namedAt: 0, seen: old };
		roster[GHOST_2]  = { name: ARG_NAME,         label: '', created: old, namedAt: 0, seen: old };
		try { localStorage.setItem('daimond-devices', JSON.stringify(roster)); } catch (e) {}
		R.nominate(NOM_DEAD);									// the star, on the dead id

		// Presence: the LIVE fleet. The dead nominee does NOT beat. Argonaut beats a
		// touch STALER than gilgamesh, so the freshest-peer fallback picks the WRONG
		// device (gilgamesh) — the owner's argonaut→gilgamesh mismatch exactly.
		PR.beat(SELF,     'Safari on iOS', now,        true,  true);
		PR.beat(LIVE_ARG, ARG_NAME,        now - 5000, false, true);
		PR.beat(LIVE_GIL, GIL_NAME,        now,        false, true);
		const presence = PR.snapshot();

		// The classification, before any change.
		const before = R.liveness(R.load(), presence, R.nominee(), now, W);

		// The election BEFORE the fix: nominee is the dead id.
		const chat = {};
		const dBefore = P.autoDispatchDecision(chat, presence,
			{ selfId: SELF, isPhone: true, nominatedId: R.nominee(), freshWindowMs: W }, now);

		// THE FIX: reconcile the nominee onto the live same-name device.
		const migratedTo = R.reconcileNominee(now, W);
		const nomAfter = R.nominee();

		// The election AFTER the fix: nominee is the live argonaut id.
		const dAfter = P.autoDispatchDecision(chat, presence,
			{ selfId: SELF, isPhone: true, nominatedId: nomAfter, freshWindowMs: W }, now);

		return {
			SELF, NOM_DEAD, LIVE_ARG, LIVE_GIL, GHOST_2,
			ghostDead:   !!before.ghost[NOM_DEAD],
			ghost2:      !!before.ghost[GHOST_2],
			liveArg:     !!before.live[LIVE_ARG],
			nomineeDead: before.nomineeDead,
			replacement: before.nomineeReplacement,
			beforeReason: dBefore.reason,
			beforePeer:   dBefore.peer ? dBefore.peer.deviceId : '',
			migratedTo, nomAfter,
			afterReason:  dAfter.reason,
			afterPeer:    dAfter.peer ? dAfter.peer.deviceId : '',
		};
	});

	check('the dead nominee line is classified a GHOST (stale + a live device shares its name)',
		r.ghostDead, 'ghost=' + r.ghostDead);
	check('a second superseded same-name line is a ghost too', r.ghost2);
	check('the returned argonaut is seen as LIVE', r.liveArg);
	check('the nominee is DEAD (its id is not beating)', r.nomineeDead);
	check('the ghost nominee’s replacement is the live same-name device',
		r.replacement === r.LIVE_ARG, r.replacement.slice(0, 8) + ' == ' + r.LIVE_ARG.slice(0, 8));
	// The RED baseline: before the fix the election ignores the dead nominee and
	// misroutes to the fresher peer (gilgamesh), not to argonaut.
	check('BEFORE: the election does NOT seat on the nominee (the bug)',
		r.beforeReason !== 'nominee', 'reason=' + r.beforeReason + ' peer=' + r.beforePeer.slice(0, 8));
	check('BEFORE: it misroutes to the fresher peer gilgamesh (works-by-luck)',
		r.beforePeer === r.LIVE_GIL, r.beforePeer.slice(0, 8));
	// The GREEN: the star follows the live device and the election seats on it.
	check('reconcileNominee migrates the star onto the live argonaut',
		r.migratedTo === r.LIVE_ARG && r.nomAfter === r.LIVE_ARG,
		'migratedTo=' + r.migratedTo.slice(0, 8) + ' nominee=' + r.nomAfter.slice(0, 8));
	check('AFTER: the election SEATS the turn on the nominee (reason nominee)',
		r.afterReason === 'nominee', 'reason=' + r.afterReason);
	check('AFTER: and it targets the LIVE argonaut, not the fresher peer',
		r.afterPeer === r.LIVE_ARG, r.afterPeer.slice(0, 8));

	// ── (c) A PRUNED GHOST STAYS PRUNED ACROSS A SYNC ROUND ─────────────────────
	const prune = await s.page.evaluate(() => {
		const R = DaimondCore.roster;
		const GHOST = 'd4d4d4d4d4d4d4d4';
		const ARG_NAME = 'Chrome on Argonaut Linux';
		const before = !!R.load()[GHOST];
		R.remove(GHOST);										// tombstones the line
		const afterRemove = !!R.load()[GHOST];
		// A later sync round hands the very same dead line back (add-only union).
		const incoming = {}; incoming[GHOST] = { name: ARG_NAME, label: '',
			created: 0, namedAt: 0, seen: Date.now() - 40 * 24 * 3600 * 1000 };
		R.merge(incoming);
		const afterMerge = !!R.load()[GHOST];
		return { before, afterRemove, afterMerge };
	});
	check('the ghost was present before pruning', prune.before);
	check('removeDevice tombstones it away', !prune.afterRemove);
	check('and it STAYS pruned when a sync round re-offers the same dead line',
		!prune.afterMerge);

	// removing the nominee device clears the nomination (no dangling star).
	const clearNom = await s.page.evaluate(() => {
		const R = DaimondCore.roster;
		const GID = 'e5e5e5e5e5e5e5e5';
		const reg = R.load(); reg[GID] = { name: 'X', label: '', created: 0, namedAt: 0, seen: Date.now() };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		R.nominate(GID);
		const was = R.nominee();
		R.remove(GID);
		return { was, now: R.nominee() };
	});
	check('removing the nominee device clears the nomination',
		clearNom.was === 'e5e5e5e5e5e5e5e5' && clearNom.now === '', 'now="' + clearNom.now + '"');

	// ── (d) NEGATIVE CONTROL: a healthy single-identity fleet is untouched ──────
	const healthy = await s.page.evaluate(() => {
		const R = DaimondCore.roster, P = DaimondPeer, PR = DaimondPresence;
		const W = P.DISPATCH_FRESH_MS, now = Date.now();
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs'].forEach(k => {
			try { localStorage.removeItem(k); } catch (e) {}
		});
		const SELF = DaimondIdentity.deviceId();
		const ARG  = 'f6f6f6f6f6f6f6f6';
		const reg = {};
		reg[SELF] = { name: 'Safari on iOS',        label: '', created: 0, namedAt: 0, seen: now };
		reg[ARG]  = { name: 'Chrome on Argonaut Linux', label: '', created: 0, namedAt: 0, seen: now };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		R.nominate(ARG);
		PR.beat(SELF, 'Safari on iOS', now, true, true);
		PR.beat(ARG,  'Chrome on Argonaut Linux', now, false, true);	// nominee genuinely beating
		const presence = PR.snapshot();
		const live = R.liveness(R.load(), presence, R.nominee(), now, W);
		const migratedTo = R.reconcileNominee(now, W);
		const d = P.autoDispatchDecision({}, presence,
			{ selfId: SELF, isPhone: true, nominatedId: R.nominee(), freshWindowMs: W }, now);
		return {
			ghosts: Object.keys(live.ghost).length,
			nomineeDead: live.nomineeDead,
			migratedTo, nominee: R.nominee(), ARG,
			reason: d.reason, peer: d.peer ? d.peer.deviceId : '',
		};
	});
	check('CONTROL: a healthy fleet shows NO ghost', healthy.ghosts === 0, 'ghosts=' + healthy.ghosts);
	check('CONTROL: its live nominee is not called dead', !healthy.nomineeDead);
	check('CONTROL: reconcileNominee moves nothing', healthy.migratedTo === '' && healthy.nominee === healthy.ARG);
	check('CONTROL: the election seats normally on the nominee',
		healthy.reason === 'nominee' && healthy.peer === healthy.ARG, 'reason=' + healthy.reason);

	// ── (e) AMBIGUITY SAFETY: two live devices share the dead nominee's name ────
	const ambig = await s.page.evaluate(() => {
		const R = DaimondCore.roster, P = DaimondPeer, PR = DaimondPresence;
		const W = P.DISPATCH_FRESH_MS, now = Date.now();
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs'].forEach(k => {
			try { localStorage.removeItem(k); } catch (e) {}
		});
		const SELF = DaimondIdentity.deviceId();
		const DEAD = 'a7a7a7a7a7a7a7a7', L1 = 'b8b8b8b8b8b8b8b8', L2 = 'c9c9c9c9c9c9c9c9';
		const NAME = 'Chrome on macOS';						// a name two machines legitimately share
		const reg = {};
		reg[SELF] = { name: 'Safari on iOS', label: '', created: 0, namedAt: 0, seen: now };
		reg[DEAD] = { name: NAME, label: '', created: 0, namedAt: 0, seen: now - 40 * 24 * 3600 * 1000 };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		R.nominate(DEAD);
		PR.beat(SELF, 'Safari on iOS', now, true, true);
		PR.beat(L1, NAME, now, false, true);
		PR.beat(L2, NAME, now, false, true);				// TWO live devices, same name
		const live = R.liveness(R.load(), PR.snapshot(), R.nominee(), now, W);
		const migratedTo = R.reconcileNominee(now, W);
		return { nomineeDead: live.nomineeDead, replacement: live.nomineeReplacement,
			migratedTo, nominee: R.nominee(), DEAD };
	});
	check('AMBIGUITY: the dead nominee is still seen dead', ambig.nomineeDead);
	check('AMBIGUITY: no replacement is chosen when two live devices share the name',
		ambig.replacement === '', 'replacement="' + ambig.replacement + '"');
	check('AMBIGUITY: reconcileNominee does NOT migrate an ambiguous name',
		ambig.migratedTo === '' && ambig.nominee === ambig.DEAD);

	// ── UI SURFACE (best-effort): the Devices panel marks and offers to prune ───
	// Drives the real renderDevices seam through the admin drawer. Best-effort, so a
	// panel that does not open on this build does not fail the logic proofs above.
	try {
		const uiSeen = await s.page.evaluate(async () => {
			const R = DaimondCore.roster, PR = DaimondPresence;
			const now = Date.now();
			PR.forget();
			['daimond-devices', 'daimond-nominated', 'daimond-device-tombs'].forEach(k => {
				try { localStorage.removeItem(k); } catch (e) {}
			});
			const SELF = DaimondIdentity.deviceId();
			const DEAD = 'a1a1a1a1a1a1a1a1', LIVE = 'b2b2b2b2b2b2b2b2';
			const NAME = 'Chrome on Argonaut Linux';
			const reg = {};
			reg[SELF] = { name: 'Safari on iOS', label: '', created: 0, namedAt: 0, seen: now };
			reg[DEAD] = { name: NAME, label: '', created: 0, namedAt: 0, seen: now - 40 * 24 * 3600 * 1000 };
			try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
			R.nominate(DEAD);
			PR.beat(SELF, 'Safari on iOS', now, true, true);
			PR.beat(LIVE, NAME, now, false, true);
			return { SELF };
		});
		// Open Settings → the home/admin drawer where the Devices list lives.
		const opened = await s.page.evaluate(() => {
			const b = document.getElementById('settings-btn')
				|| document.querySelector('[data-admin="settings"]')
				|| document.getElementById('admin-settings-btn');
			if (b) { b.click(); return true; }
			return false;
		});
		await s.page.waitForTimeout(600);
		const ui = await s.page.evaluate(() => ({
			ghostTag: !!document.querySelector('.device-ghost'),
			pruneBtn: !!document.querySelector('.device-prune-all'),
			starLive: !!document.querySelector('.device-nominate.is-nominee'),
		}));
		check('UI: the Devices panel tags the ghost line (best-effort)', ui.ghostTag, 'opened=' + opened);
		check('UI: it offers a one-tap prune for replaced devices (best-effort)', ui.pruneBtn);
	} catch (e) {
		console.log('  note  UI surface check skipped: ' + (e && e.message || e));
	}

	// No page error anywhere in the run — bar the gateway-proxy 502s this browser-only
	// run makes by design (connect:false, no gateway: /api/* is refused, and the
	// browser-only tiers carry on). Those are the absent gateway, not the app throwing.
	const errs = errors(s).filter(e => !(/\/api\//.test(e) && /\b502\b|Failed to load resource/.test(e)));
	check('no console/page errors during the run (gateway-absence 502s aside)',
		errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
	console.log('  FATAL ' + (e && e.stack || e));
	bad.push('fatal: ' + (e && e.message || e));
} finally {
	if (s && s.close) await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exit(bad.length ? 1 : 0);
