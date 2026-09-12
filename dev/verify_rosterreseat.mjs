// verify_rosterreseat.mjs — the ghost-roster / dead-nominee fix, WIRED (owner task,
// 2026-09-09; live build 8eeef65c27fe carried the reconcile logic but the roster was
// STILL all ghosts and the star STILL on a dead id in the gateway trace). The 7cc8
// reconcile was correct but reached neither the DISPATCH election nor an automatic
// prune: `reconcileNominee` ran only on the sync merge and the Devices panel, and it
// swept nothing. This proves the wiring that closes that:
//
//   (a) a roster of only SUPERSEDED ids plus a live successor, with the migration's
//       records to say so: after reconcileRoster the star sits on the LIVE id, the
//       superseded lines are gone, and they do NOT resurrect when a later add-only sync
//       re-offers them (the tombstone survives the merge);
//   (b) a genuinely-offline REAL device is preserved — both the plain-asleep case and
//       the one that used to be swept: a live device SHARES its name. A name is not
//       evidence of supersession (two of a user's Linux Chromes derive the same one),
//       so the silent device is STALE and keeps the label its owner typed;
//   (c) a chat that syncs while document.hidden is rendered on the rail regardless of
//       visibility, and is repainted again on the next visibilitychange -> visible;
//   (d) the ELECTION resolves a superseded nominee to its recorded successor
//       deterministically: flipping which peer beats fresher changes the RAW outcome
//       (the lottery) but never the reconciled one — the successor is seated either way.
//
// Drives the REAL www/js/daimond.js (DaimondCore.roster) and www/js/peer.js
// (autoDispatchDecision). Client-only; no gateway, no turn billed. Run:
//   DAIMOND_APP=http://localhost:8779 node dev/verify_rosterreseat.mjs

import { open, errors, newChat } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

let s;
try {
	s = await open({ name: 'rosterreseat', browser: (process.env.NOM_B || 'webkit').toLowerCase() });
	await s.page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.roster
		&& DaimondCore.roster.reconcileRoster && DaimondCore.roster.pruneGhosts
		&& window.DaimondPeer && DaimondPeer.autoDispatchDecision
		&& window.DaimondPresence && DaimondPresence.beat), null, { timeout: 20000 });

	const DAY = 24 * 3600 * 1000;

	// ── (a) A ROSTER OF ONLY GHOSTS + A LIVE SUCCESSOR ──────────────────────────
	const a = await s.page.evaluate((DAY) => {
		const R = DaimondCore.roster, PR = DaimondPresence, P = DaimondPeer;
		const W = P.DISPATCH_FRESH_MS, now = Date.now();
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();
		const NOM_DEAD = 'a1a1a1a1a1a1a1a1';		// argonaut's retired 16-hex id (the star)
		const GHOST_2  = 'a2a2a2a2a2a2a2a2';		// a second retired argonaut line
		const GHOST_3  = 'a3a3a3a3a3a3a3a3';		// a third
		const LIVE_ARG = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';	// argonaut, under its identity id
		const LIVE_GIL = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';	// a genuinely different machine
		const ARG = 'Chrome on Argonaut Linux', GIL = 'Chrome on Gilgamesh Linux';
		const old = now - 40 * DAY;					// long dead; the sweep does not consult age
		const reg = {};
		reg[SELF]     = { name: 'Safari on iOS', label: '', created: old, namedAt: 0, seen: now };
		reg[NOM_DEAD] = { name: ARG, label: '', created: old, namedAt: 0, seen: old };
		reg[GHOST_2]  = { name: ARG, label: '', created: old, namedAt: 0, seen: old };
		reg[GHOST_3]  = { name: ARG, label: '', created: old, namedAt: 0, seen: old };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		// THE EVIDENCE: the one-shot id migration's own records, saying the live argonaut
		// took all three retired lines' place. Without them nothing here is a ghost, which
		// is the point -- a sweep acts on a record, never on a name.
		try { localStorage.setItem('daimond-device-super', JSON.stringify({
			[NOM_DEAD]: { to: LIVE_ARG, at: now }, [GHOST_2]: { to: LIVE_ARG, at: now },
			[GHOST_3]: { to: LIVE_ARG, at: now },
		})); } catch (e) {}
		R.nominate(NOM_DEAD);
		// The live fleet: the roster is 100% disjoint from who is beating.
		PR.beat(SELF,     'Safari on iOS', now, true,  true);
		PR.beat(LIVE_ARG, ARG,             now, false, true);
		PR.beat(LIVE_GIL, GIL,             now, false, true);

		const before = Object.keys(R.load());
		const res    = R.reconcileRoster(now, W);
		const nomAfter = R.nominee();
		const afterIds = Object.keys(R.load());

		// A later add-only sync re-offers the very dead lines. The tombstones must hold.
		const incoming = {};
		[NOM_DEAD, GHOST_2, GHOST_3].forEach(id => {
			incoming[id] = { name: ARG, label: '', created: old, namedAt: 0, seen: old };
		});
		R.merge(incoming);
		const afterMerge = Object.keys(R.load());

		return {
			SELF, NOM_DEAD, GHOST_2, GHOST_3, LIVE_ARG,
			before, moved: res.moved, pruned: res.pruned, nomAfter, afterIds, afterMerge,
		};
	}, DAY);

	check('(a) the roster began as only superseded ids, disjoint from who is beating',
		[a.NOM_DEAD, a.GHOST_2, a.GHOST_3].every(id => a.before.indexOf(id) !== -1)
			&& a.before.indexOf(a.LIVE_ARG) === -1,
		'ids=' + a.before.map(x => x.slice(0, 4)).join(','));
	check('(a) reconcileRoster migrates the star onto the LIVE successor',
		a.moved === a.LIVE_ARG && a.nomAfter === a.LIVE_ARG,
		'moved=' + a.moved.slice(0, 8) + ' nominee=' + a.nomAfter.slice(0, 8));
	check('(a) every recorded-superseded line is swept from the roster',
		[a.NOM_DEAD, a.GHOST_2, a.GHOST_3].every(id => a.afterIds.indexOf(id) === -1),
		'left=' + a.afterIds.map(x => x.slice(0, 4)).join(','));
	check('(a) the roster no longer holds any superseded id (the sweep was total)',
		a.afterIds.every(id => [a.NOM_DEAD, a.GHOST_2, a.GHOST_3].indexOf(id) === -1),
		'left=' + a.afterIds.map(x => x.slice(0, 4)).join(','));
	check('(a) the swept lines do NOT resurrect when a sync re-offers them (tombstone holds)',
		[a.NOM_DEAD, a.GHOST_2, a.GHOST_3].every(id => a.afterMerge.indexOf(id) === -1),
		'after re-merge=' + a.afterMerge.map(x => x.slice(0, 4)).join(','));

	// ── (b) A GENUINELY-OFFLINE REAL DEVICE IS PRESERVED ────────────────────────
	const b = await s.page.evaluate((DAY) => {
		const R = DaimondCore.roster, PR = DaimondPresence, P = DaimondPeer;
		const W = P.DISPATCH_FRESH_MS, now = Date.now();
		PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF   = DaimondIdentity.deviceId();
		const ASLEEP = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';		// a real machine, uniquely named, just asleep
		const TWIN_OFF = 'd5d5d5d5d5d5d5d5d5d5d5d5d5d5d5d5';	// asleep, but a live device SHARES its name
		const TWIN_ON  = 'e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6';	// that live same-name device
		const MAC = 'Chrome on macOS';			// a name two of the user's machines share
		const reg = {};
		reg[SELF]     = { name: 'Safari on iOS',   label: '', created: 0, namedAt: 0, seen: now };
		// Asleep two days: no live twin of "MacBook Pro (home)", so merely STALE, not a ghost.
		reg[ASLEEP]   = { name: 'MacBook Pro (home)', label: '', created: 0, namedAt: 0, seen: now - 2 * DAY };
		// Asleep only an hour, and a live device carries its name. That used to be read as
		// the re-mint signature and swept the line; it is a COINCIDENCE two of a user's
		// machines produce by default, and sweeping on it cost this device the label its
		// owner typed. With no record against it the line is STALE and stays.
		reg[TWIN_OFF] = { name: MAC, label: 'Spare MacBook', created: 0, namedAt: now - 9e8, seen: now - 3600 * 1000 };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		PR.beat(SELF,    'Safari on iOS', now, true,  true);
		PR.beat(TWIN_ON, MAC,            now, false, true);		// the live same-name machine

		const live   = R.liveness(R.load(), PR.snapshot(), R.nominee(), now, W);
		const pruned = R.pruneGhosts(now, W);
		const ids    = Object.keys(R.load());
		return {
			ASLEEP, TWIN_OFF,
			asleepIsGhost:  !!live.ghost[ASLEEP],		// expected false: no record against it
			twinIsGhost:    !!live.ghost[TWIN_OFF],		// expected false: a shared name is not a record
			twinIsStale:    !!live.stale[TWIN_OFF],
			pruned,
			asleepKept: ids.indexOf(ASLEEP) !== -1,
			twinKept:   ids.indexOf(TWIN_OFF) !== -1,
			twinLabel:  (R.load()[TWIN_OFF] || {}).label,
		};
	}, DAY);

	check('(b) a uniquely-named asleep device is not classified a ghost', !b.asleepIsGhost);
	check('(b) INVARIANT: a lone asleep device is PRESERVED', b.asleepKept);
	check('(b) a device whose name a LIVE device shares is STALE, not replaced',
		b.twinIsStale && !b.twinIsGhost, 'stale=' + b.twinIsStale + ' ghost=' + b.twinIsGhost);
	check('(b) it is NOT swept -- a shared derived name is a coincidence, not evidence',
		b.twinKept && b.pruned.indexOf(b.TWIN_OFF) === -1,
		'pruned=' + b.pruned.map(x => x.slice(0, 4)).join(','));
	check('(b) and it keeps the label its owner typed, which the sweep used to cost it',
		b.twinLabel === 'Spare MacBook', String(b.twinLabel));

	// ── (d) THE ELECTION RESOLVES A GHOST NOMINEE DETERMINISTICALLY (no lottery) ─
	// Run the whole thing twice, swapping which live peer beats fresher. The RAW
	// election (nominee still the ghost) follows the freshest peer — a different device
	// each time, the lottery. The reconciled election (reconcileRoster first, as the
	// dispatch path now does) seats the SUCCESSOR both times.
	const d = await s.page.evaluate((DAY) => {
		const R = DaimondCore.roster, PR = DaimondPresence, P = DaimondPeer;
		const W = P.DISPATCH_FRESH_MS;

		function run(argFresher) {
			const now = Date.now();
			PR.forget();
			['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
				.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
			const SELF = DaimondIdentity.deviceId();
			const DEAD = 'a1a1a1a1a1a1a1a1';		// argonaut's retired id (the star)
			const ARGV = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';	// argonaut under its identity id (the successor)
			const GILV = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';	// gilgamesh, a genuinely different peer
			const ARG = 'Chrome on Argonaut Linux', GIL = 'Chrome on Gilgamesh Linux';
			const old = now - 40 * DAY;
			const reg = {};
			reg[SELF] = { name: 'Safari on iOS', label: '', created: old, namedAt: 0, seen: now };
			reg[DEAD] = { name: ARG, label: '', created: old, namedAt: 0, seen: old };
			try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
			try { localStorage.setItem('daimond-device-super',
				JSON.stringify({ [DEAD]: { to: ARGV, at: now } })); } catch (e) {}
			R.nominate(DEAD);
			PR.beat(SELF, 'Safari on iOS', now, true, true);
			// Whichever we make fresher wins the RAW freshest-peer fallthrough.
			PR.beat(ARGV, ARG, argFresher ? now : now - 8000, false, true);
			PR.beat(GILV, GIL, argFresher ? now - 8000 : now, false, true);
			const presence = PR.snapshot();

			// RAW: the election on the ghost nominee still on record.
			const raw = P.autoDispatchDecision({}, presence,
				{ selfId: SELF, isPhone: true, nominatedId: R.nominee(), freshWindowMs: W }, now);

			// RECONCILED: what maybeAutoDispatch now does before the election — reseat, then
			// read the effective nominee, then decide.
			R.reconcileRoster(now, W);
			const eff = R.nominee();
			const rec = P.autoDispatchDecision({}, presence,
				{ selfId: SELF, isPhone: true, nominatedId: eff, freshWindowMs: W }, now);

			return {
				ARGV, GILV,
				rawReason: raw.reason, rawPeer: raw.peer ? raw.peer.deviceId : '',
				eff, recReason: rec.reason, recPeer: rec.peer ? rec.peer.deviceId : '',
			};
		}

		return { argFresh: run(true), gilFresh: run(false) };
	}, DAY);

	// The raw election is a lottery: it follows whichever peer beats fresher.
	check('(d) RAW: with argonaut fresher, the superseded nominee falls through to argonaut',
		d.argFresh.rawReason !== 'nominee' && d.argFresh.rawPeer === d.argFresh.ARGV,
		'reason=' + d.argFresh.rawReason + ' peer=' + d.argFresh.rawPeer.slice(0, 8));
	check('(d) RAW: with gilgamesh fresher, it falls through to gilgamesh instead (the lottery)',
		d.gilFresh.rawReason !== 'nominee' && d.gilFresh.rawPeer === d.gilFresh.GILV,
		'reason=' + d.gilFresh.rawReason + ' peer=' + d.gilFresh.rawPeer.slice(0, 8));
	check('(d) the raw outcome actually CHANGED with the freshness ordering (proves it was a lottery)',
		d.argFresh.rawPeer !== d.gilFresh.rawPeer);
	// The reconciled election is deterministic: the successor is seated either way.
	check('(d) RECONCILED: the star is reseated onto the live successor (argonaut), both orderings',
		d.argFresh.eff === d.argFresh.ARGV && d.gilFresh.eff === d.gilFresh.ARGV);
	check('(d) RECONCILED: the election SEATS the nominee (reason nominee), argonaut fresher',
		d.argFresh.recReason === 'nominee' && d.argFresh.recPeer === d.argFresh.ARGV,
		'reason=' + d.argFresh.recReason + ' peer=' + d.argFresh.recPeer.slice(0, 8));
	check('(d) RECONCILED: it STILL seats argonaut when gilgamesh beats fresher (no lottery)',
		d.gilFresh.recReason === 'nominee' && d.gilFresh.recPeer === d.gilFresh.ARGV,
		'reason=' + d.gilFresh.recReason + ' peer=' + d.gilFresh.recPeer.slice(0, 8));

	// ── (c) A CHAT SYNCED WHILE HIDDEN IS RENDERED, AND REPAINTED ON RETURN ──────
	// Drives the REAL production paths: the cross-tab CHATS_REV storage listener (the
	// door a background sync merge rings) and the visibilitychange handler. A hidden tab
	// that clears its unpainted rail must repopulate it when the merge handler runs, and
	// again when it becomes visible.
	const cid = await newChat(s);
	const railHas = () => s.page.evaluate((id) => {
		const list = document.getElementById('session-list');
		if (!list) return false;
		// A tile carries the chat id somewhere on it (dataset or an attribute); fall back
		// to any rendered row when the id is not stamped, since the rail is otherwise empty.
		const txt = list.innerHTML || '';
		return txt.indexOf(id) !== -1 || !!list.querySelector('.session-item, .chat-tile, [data-chat-id]');
	}, cid);

	check('(c) a chat is on the rail to begin with', await railHas(), 'chat=' + String(cid).slice(0, 8));

	// Go hidden, empty the rail DOM (a hidden tab that painted nothing), then ring the
	// merge door. The render must run despite document.hidden.
	const hiddenRender = await s.page.evaluate(() => {
		try {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
		} catch (e) { return 'cannot-override-visibility'; }
		const list = document.getElementById('session-list');
		if (list) list.innerHTML = '';			// simulate the unpainted background tab
		// The exact event a background sync merge fires for other tabs.
		try {
			window.dispatchEvent(new StorageEvent('storage', { key: 'daimond-chats-rev', newValue: String(Date.now()) }));
		} catch (e) {
			// WebKit's StorageEvent constructor can be strict; fall back to a plain Event with the key.
			const ev = new Event('storage'); ev.key = 'daimond-chats-rev'; window.dispatchEvent(ev);
		}
		return 'fired';
	});
	await s.page.waitForTimeout(700);
	check('(c) visibility override took', hiddenRender === 'fired', hiddenRender);
	check('(c) the merge handler renders the rail even though document.hidden', await railHas());

	// Now clear the rail again and become visible: the catch-up must repaint.
	await s.page.evaluate(() => {
		const list = document.getElementById('session-list');
		if (list) list.innerHTML = '';
		try {
			Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
			Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
		} catch (e) {}
		document.dispatchEvent(new Event('visibilitychange'));
	});
	await s.page.waitForTimeout(700);
	check('(c) becoming visible repaints the rail from the store (catch-up)', await railHas());

	// No page errors bar the gateway-absence noise this browser-only run makes.
	const errs = errors(s).filter(e => !(/\/api\//.test(e) && /\b50\d\b|Failed to load resource/.test(e)));
	check('no console/page errors during the run (gateway-absence aside)',
		errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
	console.log('  FATAL ' + (e && e.stack || e));
	bad.push('fatal: ' + (e && e.message || e));
} finally {
	if (s && s.close) await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exit(bad.length ? 1 : 0);
