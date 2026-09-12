// verify_rosterghost.mjs — superseded roster lines and a stranded nominee, on the
// iOS engine (WebKit / JavaScriptCore). The measured state (owner trace, 2026-09-08,
// live build e9f7f9b5edbc) was a synced roster holding only SUPERSEDED ids, disjoint
// from the devices actually beating — the add-only UNION merge never prunes a dead
// line — with the NOMINEE on one of them, so the election found the star absent from
// presence and fell through to the freshest peer.
//
// WHAT MAKES A LINE SUPERSEDED IS A RECORD, NOT A NAME. It was a name match until
// 2026-09-12: a stale line was called a ghost when a live device under another id
// carried the same name. `deviceName()` reads the browser and the platform and nothing
// else, so two of a user's Linux Chromes derive the same words — and the test therefore
// tombstoned LIVE peers and cost them the labels their owner had typed. The evidence now
// is the one-shot id migration's own supersession record (`daimond-device-super`).
//
// It drives the REAL www/js/daimond.js reconcile (DaimondCore.roster) and the REAL
// www/js/peer.js election (autoDispatchDecision) and shows deterministically:
//   (a) rosterLiveness names a RECORDED-superseded line a ghost and its recorded
//       successor the replacement — and names a same-name line with no record STALE;
//   (b) reconcileNominee migrates the star onto that successor, and the election then
//       SEATS the turn on it where before it misrouted to the fresher peer;
//   (c) a pruned line STAYS pruned across a sync round (the tombstone survives the
//       add-only merge that would otherwise hand it back);
//   (d) NEGATIVE CONTROL: a healthy single-identity fleet is untouched — no ghost,
//       no migration, the nominee seats normally;
//   (e) NO GUESSING: a dead nominee with no record is never reseated, whether one live
//       device shares its name or two.
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
		// A clean slate: no roster, no nominee, no presence, no tombstones, no records.
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();				// this device = the phone
		const NOM_DEAD = 'a1a1a1a1a1a1a1a1';					// argonaut's retired 16-hex id (the nominee)
		const LIVE_ARG = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';	// argonaut, under its identity id
		const LIVE_GIL = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';	// gilgamesh, a fresher peer
		const GHOST_2  = 'd4d4d4d4d4d4d4d4';					// a second retired line, recorded
		const TWIN_OFF = 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5';	// asleep, NO record, shares argonaut's name
		const ARG_NAME = 'Chrome on Argonaut Linux';
		const GIL_NAME = 'Chrome on Gilgamesh Linux';
		// The DISJOINT roster the trace showed: only dead/superseded lines, none of
		// them beating. `seen` well in the past so nothing reads them as fresh.
		const old = now - 40 * 24 * 3600 * 1000;
		const roster = {};
		roster[SELF]     = { name: 'Safari on iOS',  label: '', created: old, namedAt: 0, seen: now };
		roster[NOM_DEAD] = { name: ARG_NAME,         label: '', created: old, namedAt: 0, seen: old };
		roster[GHOST_2]  = { name: ARG_NAME,         label: '', created: old, namedAt: 0, seen: old };
		roster[TWIN_OFF] = { name: ARG_NAME,         label: 'Spare Linux box', created: old, namedAt: old, seen: old };
		try { localStorage.setItem('daimond-devices', JSON.stringify(roster)); } catch (e) {}
		// THE EVIDENCE. Both retired lines were migrated onto the live argonaut, and it
		// says so. TWIN_OFF has no record and must survive every sweep below, though it
		// carries exactly the name the old inference keyed on.
		try { localStorage.setItem('daimond-device-super', JSON.stringify({
			[NOM_DEAD]: { to: LIVE_ARG, at: now }, [GHOST_2]: { to: LIVE_ARG, at: now },
		})); } catch (e) {}
		R.nominate(NOM_DEAD);									// the star, on the retired id

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
			SELF, NOM_DEAD, LIVE_ARG, LIVE_GIL, GHOST_2, TWIN_OFF,
			ghostDead:   !!before.ghost[NOM_DEAD],
			ghost2:      !!before.ghost[GHOST_2],
			twinGhost:   !!before.ghost[TWIN_OFF],
			twinStale:   !!before.stale[TWIN_OFF],
			twinLabel:   (R.load()[TWIN_OFF] || {}).label,
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

	check('the dead nominee line is a GHOST because a RECORD says it was superseded',
		r.ghostDead, 'ghost=' + r.ghostDead);
	check('a second recorded-superseded line is a ghost too', r.ghost2);
	// The negative that the old name match could not make: this line carries exactly the
	// argonaut's name and the argonaut is live, and it is still not a ghost.
	check('a same-name line with NO record is STALE, never a ghost — nothing is guessed',
		r.twinStale && !r.twinGhost, 'stale=' + r.twinStale + ' ghost=' + r.twinGhost);
	check('and it keeps the label its owner typed', r.twinLabel === 'Spare Linux box',
		String(r.twinLabel));
	check('the returned argonaut is seen as LIVE', r.liveArg);
	check('the nominee is DEAD (its id is not beating)', r.nomineeDead);
	check('the ghost nominee’s replacement is the device the record names',
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
		const GHOST = 'd4d4d4d4d4d4d4d4';		// the second retired line, still on the roster
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
		const GID = 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6';
		const reg = R.load(); reg[GID] = { name: 'X', label: '', created: 0, namedAt: 0, seen: Date.now() };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		R.nominate(GID);
		const was = R.nominee();
		R.remove(GID);
		return { was, now: R.nominee() };
	});
	check('removing the nominee device clears the nomination',
		clearNom.was === 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6' && clearNom.now === '', 'now="' + clearNom.now + '"');

	// ── (d) NEGATIVE CONTROL: a healthy single-identity fleet is untouched ──────
	const healthy = await s.page.evaluate(() => {
		const R = DaimondCore.roster, P = DaimondPeer, PR = DaimondPresence;
		const W = P.DISPATCH_FRESH_MS, now = Date.now();
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();
		const ARG  = 'a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7a7';
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

	// ── (e) NO GUESSING: a dead nominee with no record is never reseated ────────
	// One live device sharing the name is the case the old inference acted on, and two
	// was the case it refused. Both are refused now: a name is not evidence.
	const ambig = await s.page.evaluate(() => {
		const R = DaimondCore.roster, P = DaimondPeer, PR = DaimondPresence;
		const W = P.DISPATCH_FRESH_MS, now = Date.now();
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();
		const DEAD = 'a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8';
		const L1 = 'b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8b8', L2 = 'c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9c9';
		const NAME = 'Chrome on macOS';						// a name two machines legitimately share
		function run(howManyLive) {
			PR.forget();
			['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
				.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
			const reg = {};
			reg[SELF] = { name: 'Safari on iOS', label: '', created: 0, namedAt: 0, seen: now };
			reg[DEAD] = { name: NAME, label: '', created: 0, namedAt: 0, seen: now - 40 * 24 * 3600 * 1000 };
			try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
			R.nominate(DEAD);
			PR.beat(SELF, 'Safari on iOS', now, true, true);
			PR.beat(L1, NAME, now, false, true);
			if (howManyLive > 1) PR.beat(L2, NAME, now, false, true);
			const live = R.liveness(R.load(), PR.snapshot(), R.nominee(), now, W);
			const migratedTo = R.reconcileNominee(now, W);
			return { nomineeDead: live.nomineeDead, ghost: !!live.ghost[DEAD],
				replacement: live.nomineeReplacement, migratedTo, nominee: R.nominee() };
		}
		return { one: run(1), two: run(2), DEAD };
	});
	check('NO GUESSING: the dead nominee is still seen dead',
		ambig.one.nomineeDead && ambig.two.nomineeDead);
	check('NO GUESSING: ONE live device sharing the name is not its replacement',
		ambig.one.replacement === '' && ambig.one.migratedTo === ''
			&& ambig.one.nominee === ambig.DEAD, 'replacement="' + ambig.one.replacement + '"');
	check('NO GUESSING: nor are TWO', ambig.two.replacement === ''
		&& ambig.two.migratedTo === '' && ambig.two.nominee === ambig.DEAD,
		'replacement="' + ambig.two.replacement + '"');
	check('NO GUESSING: and the nominee\'s own line is not called replaced either',
		!ambig.one.ghost && !ambig.two.ghost);

	// ── UI SURFACE (best-effort): the Devices panel SWEEPS as it draws ──────────
	// Drives the real renderDevices seam through the admin drawer. It reconciles BEFORE
	// it reads the roster, so a recorded-superseded line is gone by the time the rows are
	// built -- it used to be drawn one last time with a "replaced" tag and a prune button
	// beside it. Best-effort, so a panel that does not open on this build does not fail
	// the logic proofs above.
	try {
		const uiSeen = await s.page.evaluate(async () => {
			const R = DaimondCore.roster, PR = DaimondPresence;
			const now = Date.now();
			PR.forget();
			['daimond-devices', 'daimond-nominated', 'daimond-device-tombs'].forEach(k => {
				try { localStorage.removeItem(k); } catch (e) {}
			});
			const SELF = DaimondIdentity.deviceId();
			const DEAD = 'a1a1a1a1a1a1a1a1', LIVE = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
			const NAME = 'Chrome on Argonaut Linux';
			const reg = {};
			reg[SELF] = { name: 'Safari on iOS', label: '', created: 0, namedAt: 0, seen: now };
			reg[DEAD] = { name: NAME, label: '', created: 0, namedAt: 0, seen: now - 40 * 24 * 3600 * 1000 };
			reg[LIVE] = { name: NAME + ' \u00b7 b2b2', label: '', created: 0, namedAt: 0, seen: now };
			try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
			try { localStorage.setItem('daimond-device-super',
				JSON.stringify({ [DEAD]: { to: LIVE, at: now } })); } catch (e) {}
			R.nominate(DEAD);
			PR.beat(SELF, 'Safari on iOS', now, true, true);
			PR.beat(LIVE, NAME + ' \u00b7 b2b2', now, false, true);
			return { SELF, DEAD, LIVE };
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
		const ui = await s.page.evaluate((ids) => ({
			deadRow:  [...document.querySelectorAll('.device-row')]
				.some(r => (r.querySelector('.device-id') || {}).textContent === ids.DEAD.slice(-4)),
			ghostTag: !!document.querySelector('.device-ghost'),
			pruneBtn: !!document.querySelector('.device-prune-all'),
			starLive: !!document.querySelector('.device-nominate.is-nominee'),
			nominee:  DaimondCore.roster.nominee(),
			onRoster: !!DaimondCore.roster.load()[ids.DEAD],
		}), uiSeen);
		check('UI: the superseded line is swept BY the draw, not drawn with a tag on it',
			!ui.deadRow && !ui.onRoster && !ui.ghostTag && !ui.pruneBtn,
			'opened=' + opened + ' ' + JSON.stringify(ui));
		check('UI: and the star is drawn on the live successor the record named',
			ui.starLive && ui.nominee === uiSeen.LIVE, 'nominee=' + ui.nominee.slice(0, 8));
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
