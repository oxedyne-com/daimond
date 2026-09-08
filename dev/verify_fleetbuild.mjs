// verify_fleetbuild.mjs — the fleet's build spread is VISIBLE and self-correcting.
//
// A mixed-build fleet (some devices silently on a days-old build behind a stale
// service worker) once made deployed fixes look broken for hours, because nobody
// could SEE which build each device ran. These four safeguards make the invisible
// visible and, where they can, self-correct. This drives the REAL page and proves
// each one:
//
//   1/2. THE DEVICES PANEL shows each device's build, flags any device on a build
//        behind THIS one ("on an old build — reload"), and shows a one-line
//        fleet-skew banner when two or more builds are in play. The build travels
//        in the gateway-OPAQUE sync parcel (the device roster), so this needs no
//        gateway change. A same-build fleet shows neither flag nor banner.
//   3.   THE STALE-WORKER ESCAPE: when a reload we performed lands back on the SAME
//        build under a controlling service worker (the pre-206 trap), the updater
//        counts it and, after a couple in a row, PROMPTS the one escape a reload
//        cannot do — close and reopen / clear site data. It never auto-wipes and
//        never loops (it heeds the existing forced-reload loop guard), and a normal
//        boot does not trip it.
//   4.   THE HAND-OFF SKEW GUARD: the election PREFERS a peer on the current build
//        over a fresher-but-superseded one, and FLAGS (never excludes) a stale peer
//        it still has to use — so a mixed-build fleet does not silently trust a
//        stale runner, but a rollout is never stranded. The lease is untouched.
//
//   node dev/verify_fleetbuild.mjs                 # chromium
//   DAIMOND_BROWSER=webkit node dev/verify_fleetbuild.mjs   # the iOS engine
//
// Needs dev/serve.mjs (DAIMOND_PORT). No gateway, no mock: connect:false, and the
// panel + the pure election logic are all client-side.

import { open, errors, signInAs, scratch } from './harness.mjs';
import fs from 'node:fs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
	return pass;
};

const P1 = 'aaaa1111bbbb2222';		// a fabricated peer, on an OLD build
const P2 = 'cccc3333dddd4444';		// a fabricated peer, on THIS build
const OLD_BUILD = 'old0build0aaa';

const PROFILE = scratch('pw', 'fleetbuild-' + process.pid);
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'fleetbuild', connect: false, profile: PROFILE });
const { page } = s;

try {
	await page.waitForFunction(
		() => !!(window.DaimondCore && window.DaimondCore.applySync && window.DaimondPeer
			&& window.DaimondUpdater && window.DaimondAdmin),
		null, { timeout: 12000 });
	// The tab has to know its own build before any of this means anything: it is
	// read from build.json, which dev/serve.mjs serves. Poll for it.
	const gotBuild = await page.waitForFunction(
		() => { try { return !!window.DaimondUpdater.booted(); } catch (e) { return false; } },
		null, { timeout: 8000 }).then(() => true).catch(() => false);
	const selfBuild = await page.evaluate(() => { try { return window.DaimondUpdater.booted(); } catch (e) { return ''; } });
	check('this tab knows the build it is running (from build.json)', gotBuild && !!selfBuild, selfBuild);

	// ── 1 + 2. The Devices panel: build per row, stale flag, skew banner ──
	await page.evaluate(async ([P1, P2, OLD]) => {
		const now = Date.now();
		// A peer on an OLD build, and a peer on THIS build. Distinct names, so the
		// roster reconcile cannot read either as a ghost of the self device.
		await DaimondCore.applySync({ v: 2, devices: {
			[P1]: { name: 'Peer One', created: now - 9e6, seen: now - 30e3, build: OLD },
			[P2]: { name: 'Peer Two', created: now - 9e6, seen: now - 30e3,
				build: (window.DaimondUpdater.booted() || '') },
		} });
	}, [P1, P2, OLD_BUILD]);

	const view = await page.evaluate(([P1, P2]) => {
		DaimondAdmin.home();
		const rowFor = (id) => [...document.querySelectorAll('#admin-home .device-row')]
			.find(r => ((r.querySelector('.device-id') || {}).textContent || '') === id.slice(-4));
		const read = (id) => {
			const r = rowFor(id);
			if (!r) return null;
			return {
				build:     (r.querySelector('.device-build') || {}).textContent || '',
				buildFull: (r.querySelector('.device-build') || {}).title || '',
				oldTag:    !!r.querySelector('.device-oldbuild'),
				oldClass:  r.classList.contains('is-oldbuild'),
			};
		};
		const self = localStorage.getItem('daimond-device-id');
		return {
			self:  read(self),
			p1:    read(P1),
			p2:    read(P2),
			skew:  (document.querySelector('#admin-home .device-skew') || {}).textContent || '',
		};
	}, [P1, P2]);

	check('every device row shows its build id', !!(view.self && view.self.build)
		&& !!(view.p1 && view.p1.build) && !!(view.p2 && view.p2.build),
		JSON.stringify({ self: view.self && view.self.build, p1: view.p1 && view.p1.build, p2: view.p2 && view.p2.build }));
	check('the peer on an OLD build is flagged "on an old build" (tag + class)',
		!!(view.p1 && view.p1.oldTag && view.p1.oldClass), JSON.stringify(view.p1));
	check('the old peer\'s tag carries its FULL build id for support',
		!!(view.p1 && view.p1.buildFull === OLD_BUILD), view.p1 && view.p1.buildFull);
	check('the peer on THIS build is NOT flagged', !!(view.p2 && !view.p2.oldTag && !view.p2.oldClass),
		JSON.stringify(view.p2));
	check('this device is NOT flagged as old', !!(view.self && !view.self.oldClass), JSON.stringify(view.self));
	check('a one-line fleet-skew banner names the number of builds',
		/2/.test(view.skew) && /build/i.test(view.skew), JSON.stringify(view.skew));

	// Negative control: a same-build fleet shows NO skew banner and NO old flag.
	const same = await page.evaluate(async ([P1, P2]) => {
		const now = Date.now();
		const cur = window.DaimondUpdater.booted() || '';
		// Bring the old peer up to the current build (a fresher line wins on seen).
		await DaimondCore.applySync({ v: 2, devices: {
			[P1]: { name: 'Peer One', created: now - 9e6, seen: now, build: cur },
			[P2]: { name: 'Peer Two', created: now - 9e6, seen: now, build: cur },
		} });
		DaimondAdmin.home();
		return {
			skew:  !!document.querySelector('#admin-home .device-skew'),
			anyOld: document.querySelectorAll('#admin-home .device-oldbuild').length,
		};
	}, [P1, P2]);
	check('NEGATIVE: a same-build fleet shows no skew banner', same.skew === false, String(same.skew));
	check('NEGATIVE: and flags no device as old', same.anyOld === 0, String(same.anyOld));

	// ── 4. The hand-off skew guard (pure DaimondPeer logic) ──────────────
	const guard = await page.evaluate(() => {
		const now = Date.now();
		const CUR = 'cur0build0new';
		const OLD = 'old0build0xxx';
		const self = 'self000000000000';
		const genuine = (build, lastSeenAgo) => ({
			name: 't', lastSeen: now - (lastSeenAgo || 0), attended: true, attendedAt: now,
			servicedAt: now - (lastSeenAgo || 0), build,
		});
		const F = window.DaimondPeer.freshestGenuinePeer;
		const A = window.DaimondPeer.autoDispatchDecision;

		// (a) A CURRENT-build peer is preferred over a FRESHER superseded one.
		const presA = { pcur: genuine(CUR, 5000), pold: genuine(OLD, 0) };  // pold fresher
		const withGuard = F(presA, self, now, 90000, CUR);
		const noGuard   = F(presA, self, now, 90000, '');   // no currentBuild = old behaviour
		// (b) Only a stale peer available: chosen, FLAGGED, never excluded.
		const presB = { pold: genuine(OLD, 0) };
		const onlyStale = F(presB, self, now, 90000, CUR);
		// (c) Two current-build peers: freshest wins, no false stale flag.
		const presC = { pa: genuine(CUR, 5000), pb: genuine(CUR, 0) };
		const bothCur = F(presC, self, now, 90000, CUR);
		// (d) An UNKNOWN-build peer is neutral, never flagged stale.
		const presD = { punk: genuine('', 0) };
		const unknown = F(presD, self, now, 90000, CUR);
		// (e) autoDispatchDecision on a phone with only a stale peer: dispatches, flagged.
		const decStale = A({}, presB, { selfId: self, isPhone: true, currentBuild: CUR }, now);
		// (f) …and with a current-build peer present, prefers it, unflagged.
		const decCur   = A({}, presA, { selfId: self, isPhone: true, currentBuild: CUR }, now);

		return {
			withGuardId: withGuard && withGuard.deviceId, withGuardStale: !!(withGuard && withGuard.staleBuild),
			noGuardId:   noGuard && noGuard.deviceId,
			onlyStaleId: onlyStale && onlyStale.deviceId, onlyStaleFlag: !!(onlyStale && onlyStale.staleBuild),
			bothCurId:   bothCur && bothCur.deviceId, bothCurFlag: !!(bothCur && bothCur.staleBuild),
			unknownId:   unknown && unknown.deviceId, unknownFlag: !!(unknown && unknown.staleBuild),
			decStaleDispatch: !!decStale.dispatch, decStaleFlag: !!decStale.staleBuild, decStalePeer: decStale.peer && decStale.peer.deviceId,
			decCurDispatch: !!decCur.dispatch, decCurFlag: !!decCur.staleBuild, decCurPeer: decCur.peer && decCur.peer.deviceId,
		};
	});
	check('the guard PREFERS the current-build peer over a fresher superseded one',
		guard.withGuardId === 'pcur' && !guard.withGuardStale, JSON.stringify(guard));
	check('without a currentBuild, the OLD (fresher) peer would have been chosen — the guard is what changed it',
		guard.noGuardId === 'pold', guard.noGuardId);
	check('a stale peer is still CHOSEN when it is the only one — flagged, never excluded (no fleet stranding)',
		guard.onlyStaleId === 'pold' && guard.onlyStaleFlag === true, JSON.stringify(guard));
	check('a same-build election is unbroken: freshest wins, no false stale flag',
		guard.bothCurId === 'pb' && guard.bothCurFlag === false, JSON.stringify(guard));
	check('an unknown-build peer is neutral, never flagged stale (fail-safe pre-relay)',
		guard.unknownId === 'punk' && guard.unknownFlag === false, JSON.stringify(guard));
	check('autoDispatchDecision dispatches to a stale peer but FLAGS it (staleBuild)',
		guard.decStaleDispatch && guard.decStaleFlag && guard.decStalePeer === 'pold', JSON.stringify(guard));
	check('autoDispatchDecision prefers the current-build peer, unflagged',
		guard.decCurDispatch && !guard.decCurFlag && guard.decCurPeer === 'pcur', JSON.stringify(guard));

	// ── 3. The stale-worker escape ───────────────────────────────────────
	// The detection only means anything under a CONTROLLING service worker (a tab
	// with none always fetches fresh). The app's own sw.js claims clients on
	// activate, so wait for it to take control.
	const controlled = await page.waitForFunction(
		() => { try { return !!(navigator.serviceWorker && navigator.serviceWorker.controller); } catch (e) { return false; } },
		null, { timeout: 10000 }).then(() => true).catch(() => false);
	check('a controlling service worker is present (the trap only exists under one)', controlled,
		String(controlled));

	// NEGATIVE first: a normal boot is not stuck.
	const normalStuck = await page.evaluate(() => { try { return window.DaimondUpdater.stuck(); } catch (e) { return null; } });
	check('NEGATIVE: a normally-booted tab is NOT stuck', normalStuck === false, String(normalStuck));
	check('NEGATIVE: and shows no stuck banner', !(await page.$('.update-banner[data-state="stuck"]')));

	if (controlled) {
		// Seed the evidence of ONE prior non-advancing reload, then perform a reload
		// that also does not advance (the build on disk is unchanged), so the count
		// reaches the threshold and the escape prompt shows. This is exactly the
		// pre-206-worker trap: a reload that comes back on the same build.
		const bootB = await page.evaluate(() => {
			try { return (window.DaimondTrail.rows() || []).filter(r => r.w === 'boot').length; } catch (e) { return -1; }
		});
		await page.evaluate(() => {
			const b = window.DaimondUpdater.booted();
			try { localStorage.setItem('daimond-stuck-n', '1'); localStorage.setItem('daimond-stuck-build', b); } catch (e) {}
			try { sessionStorage.setItem('daimond-reload-from', b); } catch (e) {}   // "we just reloaded away from b"
		});
		await page.reload({ waitUntil: 'domcontentloaded' });
		// Land past the lock screen the way a person does.
		const gate = await page.$('#id-pass');
		if (gate && await gate.isVisible().catch(() => false)) {
			await signInAs(s, 'fleetbuild').catch(() => {});
		}
		await page.waitForFunction(() => !!window.DaimondUpdater, null, { timeout: 8000 }).catch(() => {});
		await page.waitForTimeout(1200);

		const stuck = await page.evaluate(() => { try { return window.DaimondUpdater.stuck(); } catch (e) { return null; } });
		check('a reload that did not advance under a controlling worker marks the tab STUCK', stuck === true, String(stuck));

		const banner = await page.evaluate(() => {
			const b = document.querySelector('.update-banner[data-state="stuck"]');
			if (!b || b.hidden) return null;
			return {
				msg: (b.querySelector('.update-banner-msg') || {}).textContent || '',
				go:  (b.querySelector('.update-banner-go') || {}).textContent || '',
			};
		});
		check('the stuck escape prompt is shown', !!banner, JSON.stringify(banner));
		check('and it names the sure escape (close/reopen or clear site data), not just another reload',
			!!banner && /close|reopen|clear/i.test(banner.msg), banner && banner.msg);

		// It must NOT loop: no reload storm. Boots climbed by exactly the one reload
		// we performed, and no more after settling.
		const bootA1 = await page.evaluate(() => {
			try { return (window.DaimondTrail.rows() || []).filter(r => r.w === 'boot').length; } catch (e) { return -1; }
		});
		await page.waitForTimeout(1500);
		const bootA2 = await page.evaluate(() => {
			try { return (window.DaimondTrail.rows() || []).filter(r => r.w === 'boot').length; } catch (e) { return -1; }
		});
		check('the stuck prompt does NOT loop (boot count is stable, not climbing)',
			bootA2 === bootA1 && (bootA1 - bootB) <= 1, `boots ${bootB} -> ${bootA1} -> ${bootA2}`);

		// A reload that ADVANCES clears the stuck state (self-correction).
		await page.evaluate(() => {
			// Simulate the next boot landing on a DIFFERENT build: reload-from != booted.
			try { sessionStorage.setItem('daimond-reload-from', 'some-other-build-id'); } catch (e) {}
		});
		await page.reload({ waitUntil: 'domcontentloaded' });
		const g2 = await page.$('#id-pass');
		if (g2 && await g2.isVisible().catch(() => false)) {
			await signInAs(s, 'fleetbuild').catch(() => {});
		}
		await page.waitForFunction(() => !!window.DaimondUpdater, null, { timeout: 8000 }).catch(() => {});
		await page.waitForTimeout(800);
		const afterClear = await page.evaluate(() => {
			try { return { stuck: window.DaimondUpdater.stuck(),
				n: localStorage.getItem('daimond-stuck-n') }; } catch (e) { return null; }
		});
		check('a reload that ADVANCES to another build clears the stuck state (self-correcting)',
			!!afterClear && afterClear.stuck === false && !afterClear.n, JSON.stringify(afterClear));
	} else {
		console.log('  note  no controlling service worker in this engine/run — the stuck-positive '
			+ 'assertions were skipped (the negative controls still ran).');
	}

	const errs = errors(s).filter(e => !/favicon|ERR_|Failed to load resource|401|402|426|502|Unauthorized|Payment/i.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('the verifier ran to completion', false, String(e && e.stack || e));
} finally {
	await s.close();
	try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* gone */ }
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
