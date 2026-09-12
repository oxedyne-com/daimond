// verify_devicespanel.mjs — the Devices panel display/UX fixes (owner trace,
// 2026-09-10, live build fbc1c7cf6cb1). Three defects, all panel-only:
//
//   1. TWO LIVE DESKTOPS SHOWED UNDER ONE NAME. The panel rested on each roster
//      line's stored `name`, which is a generic self-description ("Chrome on Linux")
//      two machines derive identically, so two live desktops collapsed onto one
//      indistinguishable row -- even though each broadcasts its OWN distinct label on
//      its presence beat ("Chrome on Argonaut Linux" vs "Chrome on Gilgamesh Linux").
//   2. A REPLACED/tombstoned line must carry a remove control that actually drops it
//      and stays dropped across the add-only union merge (the tombstone path).
//   3. THE RENAME PENCIL DID NOTHING on a live device shown only from its presence
//      beat (the disjoint-roster case): askDeviceName found no stored line and
//      returned before it drew the dialog.
//
// Drives the REAL www/js/daimond.js panel (renderDevices, through the admin drawer)
// and the REAL roster primitives (DaimondCore.roster). Client-only; no gateway, no
// mock, no turn is billed. Run under the iOS engine:
//   DAIMOND_APP=http://localhost:8795 DAIMOND_BROWSER=webkit node dev/verify_devicespanel.mjs

import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

let s;
try {
	s = await open({ name: 'devicespanel', browser: (process.env.NOM_B || 'webkit').toLowerCase(), connect: false });
	await s.page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.roster
		&& DaimondCore.roster.liveness && DaimondCore.roster.remove && DaimondCore.roster.rename
		&& window.DaimondPresence && DaimondPresence.beat), null, { timeout: 20000 });

	const ua = await s.page.evaluate(() => navigator.userAgent);
	const isWebkit = /WebKit/.test(ua) && !/Chrome\//.test(ua);
	check('running under WebKit, the iOS engine', isWebkit, ua.slice(0, 70));

	// A FRESH render every time, through the app's own entry point. `DaimondAdmin.home()`
	// runs renderHomeBody (which clears and rebuilds the whole home view) then shows the
	// drawer -- so a read never sees the previous section's rows, the trap a settings-btn
	// TOGGLE falls into (a second click hides the drawer without rebuilding, and the DOM
	// nodes linger for a stale read).
	const rows = () => s.page.evaluate(() => [...document.querySelectorAll('.device-row')].map(r => ({
		name:  (r.querySelector('.device-name') || {}).textContent || '',
		idsuf: (r.querySelector('.device-id') || {}).textContent || '',
		ghost: r.classList.contains('is-ghost'),
		stale: r.classList.contains('is-stale'),
		rm:    !!r.querySelector('.device-remove'),
		ren:   !!r.querySelector('.device-rename'),
	})));
	const render = async () => {
		await s.page.evaluate(() => { try { window.DaimondAdmin && DaimondAdmin.home(); } catch (e) {} });
		await s.page.waitForTimeout(400);
		return rows();
	};
	// Keep the whole fixture fleet beating, so a re-render never reads a device as gone
	// mid-test just because its one beat aged past the freshness window.
	const beatAll = (map) => s.page.evaluate((m) => {
		const now = Date.now();
		Object.keys(m).forEach(id => DaimondPresence.beat(id, m[id], now, false, true));
	}, map);

	// ── (a) TWO LIVE DEVICES RENDER WITH THEIR DISTINCT NAMES, NOT COLLAPSED ─────
	const A = await s.page.evaluate(() => {
		const PR = DaimondPresence; const now = Date.now(); PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();
		const ARG = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2', GIL = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
		const GENERIC = 'Chrome on Linux';			// what BOTH desktops store as their `name`
		const reg = {};
		reg[SELF] = { name: 'Safari on macOS', label: '', created: now, namedAt: 0, seen: now };
		reg[ARG]  = { name: GENERIC, label: '', created: now, namedAt: 0, seen: now };
		reg[GIL]  = { name: GENERIC, label: '', created: now, namedAt: 0, seen: now };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		// Each beats under its OWN distinct label -- what the gateway relays and what the
		// panel must show.
		PR.beat(SELF, 'Safari on macOS', now, true, true);
		PR.beat(ARG, 'Chrome on Argonaut Linux', now, false, true);
		PR.beat(GIL, 'Chrome on Gilgamesh Linux', now, false, true);
		return { SELF, ARG, GIL };
	});
	const aRows = await render();
	const argRow = aRows.find(r => r.idsuf === A.ARG.slice(-4));
	const gilRow = aRows.find(r => r.idsuf === A.GIL.slice(-4));
	check('both live desktops render as rows', !!argRow && !!gilRow, JSON.stringify(aRows.map(r => r.name)));
	check('the two live desktops show DISTINCT names, not one collapsed label',
		argRow && gilRow && argRow.name !== gilRow.name,
		(argRow ? argRow.name : '?') + ' vs ' + (gilRow ? gilRow.name : '?'));
	check('each shows its OWN broadcast (presence) label',
		argRow && gilRow && argRow.name === 'Chrome on Argonaut Linux' && gilRow.name === 'Chrome on Gilgamesh Linux',
		(argRow ? argRow.name : '?') + ' / ' + (gilRow ? gilRow.name : '?'));

	// ── (b) A REPLACED LINE HAS A REMOVE CONTROL, AND REMOVING IT STAYS DROPPED ──
	const B = await s.page.evaluate(() => {
		const R = DaimondCore.roster, PR = DaimondPresence; const now = Date.now(); PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();
		const LIVE = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4', GHOST = 'a1a1a1a1a1a1a1a1';	// legacy width: what was migrated
		const NAME = 'Chrome on Argonaut Linux';
		const reg = {};
		reg[SELF]  = { name: 'Safari on macOS', label: '', created: now, namedAt: 0, seen: now };
		reg[LIVE]  = { name: NAME, label: '', created: now, namedAt: 0, seen: now };			// the machine here now
		reg[GHOST] = { name: NAME, label: '', created: now, namedAt: 0, seen: now - 40 * 24 * 3600 * 1000 };	// its superseded old line
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		// THE RECORD is what makes it REPLACED -- the one-shot migration's own note that
		// LIVE took GHOST's place. A shared name does not, and must not: two of a user's
		// machines derive the same name.
		try { localStorage.setItem('daimond-device-super',
			JSON.stringify({ [GHOST]: { to: LIVE, at: now } })); } catch (e) {}
		PR.beat(SELF, 'Safari on macOS', now, true, true);
		PR.beat(LIVE, NAME, now, false, true);				// GHOST does NOT beat
		const live = R.liveness(R.load(), PR.snapshot(), R.nominee(), now, DaimondPeer.DISPATCH_FRESH_MS);
		return { SELF, LIVE, GHOST, isGhost: !!live.ghost[GHOST] };
	});
	check('a line a MIGRATION RECORD says was superseded is classified REPLACED', B.isGhost);
	// The panel RECONCILES BEFORE IT READS THE ROSTER, so a superseded line is swept by
	// the very draw that would have shown it -- read in the SAME synchronous tick, which
	// is the tick that used to draw it one last time with a "replaced" tag and a prune
	// button beside it. Nothing to tag and nothing to prune by hand is the better answer.
	const ghostRow = await s.page.evaluate((suf) => {
		try { window.DaimondAdmin && DaimondAdmin.home(); } catch (e) {}
		const row = [...document.querySelectorAll('.device-row')].find(r => (r.querySelector('.device-id') || {}).textContent === suf);
		return { drawn: !!row, pruneAll: !!document.querySelector('.device-prune-all') };
	}, B.GHOST.slice(-4));
	check('the panel sweeps the REPLACED line AS it draws — it is never shown again',
		!ghostRow.drawn, JSON.stringify(ghostRow));
	check('so no hand prune is offered, and the sweep tombstoned it',
		!ghostRow.pruneAll && !(await s.page.evaluate((g) => !!DaimondCore.roster.load()[g], B.GHOST)),
		JSON.stringify(ghostRow));
	// Remove it through the real remove/tombstone path, then prove it stays gone when
	// the add-only union re-offers the very same dead line on a later sync round.
	const bDrop = await s.page.evaluate((GHOST) => {
		const R = DaimondCore.roster;
		R.remove(GHOST);							// tombstones the line
		const afterRemove = !!R.load()[GHOST];
		const inc = {}; inc[GHOST] = { name: 'Chrome on Argonaut Linux', label: '', created: 0, namedAt: 0, seen: Date.now() - 40 * 24 * 3600 * 1000 };
		R.merge(inc);								// the union hands the dead line back
		const afterMerge = !!R.load()[GHOST];
		return { afterRemove, afterMerge };
	}, B.GHOST);
	check('removing the REPLACED line drops it', !bDrop.afterRemove);
	check('and it does NOT resurrect when a sync round re-offers it', !bDrop.afterMerge);
	await beatAll({ [B.SELF]: 'Safari on macOS', [B.LIVE]: 'Chrome on Argonaut Linux' });
	const bAfter = await render();
	check('the panel no longer lists the removed REPLACED line',
		!bAfter.some(r => r.idsuf === B.GHOST.slice(-4)), JSON.stringify(bAfter.map(r => r.idsuf)));

	// ── (b2) TWO DEVICES WITH THE SAME DERIVED NAME BOTH STAY LIVE AND LABELLED ──
	// `deviceName()` reads the browser and the platform and nothing else, so two Linux
	// Chromes derive "Google Chrome on Linux" identically. A ghost inferred from a shared
	// name therefore tombstoned LIVE peers, and `touchSelfDevice` re-minted their lines
	// with an empty label -- the user's own name for the machine, lost every round.
	const B2 = await s.page.evaluate(() => {
		const R = DaimondCore.roster, PR = DaimondPresence; const now = Date.now(); PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();
		const T1 = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1', T2 = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';
		const SAME = 'Google Chrome on Linux';		// what BOTH machines derive, unaided
		const reg = {};
		reg[SELF] = { name: 'Safari on macOS', label: '', created: now, namedAt: 0, seen: now };
		reg[T1]   = { name: SAME, label: 'Argonaut',  created: now, namedAt: now, seen: now };
		reg[T2]   = { name: SAME, label: 'Gilgamesh', created: now, namedAt: now, seen: now };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		PR.beat(SELF, 'Safari on macOS', now, true, true);
		PR.beat(T1, SAME, now, false, true);
		PR.beat(T2, SAME, now, false, true);			// both BEATING, under one derived name
		const live = R.liveness(R.load(), PR.snapshot(), R.nominee(), now, DaimondPeer.DISPATCH_FRESH_MS);
		const pruned = R.pruneGhosts(now, DaimondPeer.DISPATCH_FRESH_MS);
		const after = R.load();
		return { SELF, T1, T2, SAME,
			ghosts: Object.keys(live.ghost), pruned,
			l1: after[T1] ? after[T1].label : null, l2: after[T2] ? after[T2].label : null };
	});
	check('(b2) two live devices sharing a derived name produce NO ghost', B2.ghosts.length === 0,
		'ghosts=' + B2.ghosts.map(x => x.slice(0, 4)).join(','));
	check('(b2) neither is swept', B2.pruned.length === 0, 'pruned=' + B2.pruned.length);
	check('(b2) and both keep the label their owner typed',
		B2.l1 === 'Argonaut' && B2.l2 === 'Gilgamesh', B2.l1 + ' / ' + B2.l2);
	// The SLEEPING twin too: one of the pair goes quiet for an hour. It is STALE, which
	// is all the panel should say -- not replaced, and never swept.
	const B3 = await s.page.evaluate(() => {
		const R = DaimondCore.roster, PR = DaimondPresence; const now = Date.now(); PR.forget();
		const SELF = DaimondIdentity.deviceId();
		const T1 = 'f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1', T2 = 'f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2f2';
		const SAME = 'Google Chrome on Linux';
		PR.beat(SELF, 'Safari on macOS', now, true, true);
		PR.beat(T2, SAME, now, false, true);			// only ONE of the twins beats now
		const live = R.liveness(R.load(), PR.snapshot(), R.nominee(), now, DaimondPeer.DISPATCH_FRESH_MS);
		const pruned = R.pruneGhosts(now, DaimondPeer.DISPATCH_FRESH_MS);
		return { stale: !!live.stale[T1], ghost: !!live.ghost[T1], pruned,
			kept: !!R.load()[T1], label: (R.load()[T1] || {}).label };
	});
	check('(b3) the sleeping twin is STALE, not replaced', B3.stale && !B3.ghost,
		'stale=' + B3.stale + ' ghost=' + B3.ghost);
	check('(b3) it is preserved, with its label intact',
		B3.kept && B3.label === 'Argonaut' && B3.pruned.length === 0, B3.label);

	// ── (c) THE RENAME PENCIL CHANGES THE SHOWN LABEL — even presence-only ───────
	// The hardest case, and the reported one: a live device on the panel from its
	// presence beat ALONE, with no stored roster line. The pencil used to do nothing.
	const C = await s.page.evaluate(() => {
		const PR = DaimondPresence; const now = Date.now(); PR.forget();
		['daimond-devices', 'daimond-nominated', 'daimond-device-tombs', 'daimond-device-super']
			.forEach(k => { try { localStorage.removeItem(k); } catch (e) {} });
		const SELF = DaimondIdentity.deviceId();
		const PO = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';				// present in PRESENCE only, not in the roster
		const reg = {};
		reg[SELF] = { name: 'Safari on macOS', label: '', created: now, namedAt: 0, seen: now };
		try { localStorage.setItem('daimond-devices', JSON.stringify(reg)); } catch (e) {}
		PR.beat(SELF, 'Safari on macOS', now, true, true);
		PR.beat(PO, 'Chrome on Gilgamesh Linux', now, false, true);
		return { SELF, PO, inRosterBefore: !!DaimondCore.roster.load()[PO] };
	});
	check('the rename target is a live PRESENCE-ONLY device (no stored line)', !C.inRosterBefore);
	await beatAll({ [C.SELF]: 'Safari on macOS', [C.PO]: 'Chrome on Gilgamesh Linux' });
	const cRows0 = await render();
	const poRow0 = cRows0.find(r => r.idsuf === C.PO.slice(-4));
	check('the presence-only device renders with a rename pencil', !!poRow0 && poRow0.ren, JSON.stringify(poRow0 || null));
	// Click the pencil and answer the dialog the way a person does.
	const clicked = await s.page.evaluate((PO) => {
		const suf = PO.slice(-4);
		const row = [...document.querySelectorAll('.device-row')].find(r => (r.querySelector('.device-id') || {}).textContent === suf);
		if (!row) return 'no-row';
		const pen = row.querySelector('.device-rename'); if (!pen) return 'no-pencil';
		pen.click(); return 'clicked';
	}, C.PO);
	await s.page.waitForTimeout(300);
	const dlgUp = await s.page.evaluate(() => !!document.querySelector('.dlg input.dlg-input'));
	check('the pencil OPENS the rename dialog (it used to do nothing here)', dlgUp, 'clicked=' + clicked);
	await s.page.evaluate(() => {
		const inp = document.querySelector('.dlg input.dlg-input');
		if (inp) { inp.value = 'Study desktop'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
		const ok = document.querySelector('.dlg .dlg-ok'); if (ok) ok.click();
	});
	await s.page.waitForTimeout(400);
	const named = await s.page.evaluate((PO) => {
		const d = DaimondCore.roster.load()[PO];
		return { label: d ? d.label : null, seeded: !!d };
	}, C.PO);
	check('the rename persists as the device label', named.seeded && named.label === 'Study desktop',
		JSON.stringify(named));
	await beatAll({ [C.SELF]: 'Safari on macOS', [C.PO]: 'Chrome on Gilgamesh Linux' });
	const cRows1 = await render();
	const poRow1 = cRows1.find(r => r.idsuf === C.PO.slice(-4));
	check('the panel now shows the chosen name on that device', !!poRow1 && poRow1.name === 'Study desktop',
		JSON.stringify(poRow1 || null));
	// The data-path proof too: renaming an absent id with a derived name seeds a line.
	const seed = await s.page.evaluate(() => {
		const R = DaimondCore.roster;
		const ID = 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5';
		const noArg  = R.rename(ID, 'Phone');					// no derived name, no line: refused
		const seeded = R.rename(ID, 'Phone', 'Chrome on Android');	// derived given: seeds + names
		const d = R.load()[ID];
		return { refused: noArg === null, label: d ? d.label : null };
	});
	check('rename refuses an unknown id with no derived name to seed from', seed.refused);
	check('rename seeds a line for a presence-derived device and names it', seed.label === 'Phone', JSON.stringify(seed));

	// A user label still WINS over the live presence label (rename is not undone by a beat).
	const winRows = await render();
	const poWin = winRows.find(r => r.idsuf === C.PO.slice(-4));
	check('the user label keeps winning over the live presence label after a beat',
		!!poWin && poWin.name === 'Study desktop', JSON.stringify(poWin || null));

	const errs = errors(s).filter(e => !(/\/api\//.test(e) && (/\b502\b/.test(e) || /Failed to load resource/.test(e))));
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
