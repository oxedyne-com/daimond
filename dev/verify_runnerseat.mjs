// verify_runnerseat.mjs — AN ARMED RUNNER IS THE SEAT, WITH NOTHING STORED ON THE
// PHONE (owner, 2026-09-13).
//
// THE LIVE FAULT. The owner's iPhone, on build ea8174ff76f6, showed "Runs here —
// keep this screen open" under the composer with the reason `no-desktop`, while
// argonaut was starred as the runner and had its runner posture armed. Two things
// were true at once and each on its own was enough:
//
//   - THE STAR IS NOT WHERE THE PHONE CAN SEE IT. `daimond-nominated` is the
//     nominating device's localStorage; it reaches another device only on a full
//     content-parcel round, which on that account is ~7.7 MB. Until one lands, the
//     phone's `nominatedId` is '' and the nominee branch of the election cannot
//     fire at all.
//   - `runner: true` RODE EVERY BEAT AND WAS READ BY NOBODY. presenceBeat wrote
//     it, presenceAdopt and presenceIngest relayed it, the gateway stored and
//     returned it — and no line of the election ever looked at it. The one machine
//     that had said in as many words "I am arranged to take a turn" was the one
//     machine the decision ignored, so a lapsed `serviced_at` was enough to strike
//     it out as a phantom.
//
// So the posture is now a SEAT IN ITS OWN RIGHT, between the star and the generic
// desktop scan. This proves it where it broke: two real paired contexts, one a
// DESKTOP that arms the posture, one a MOBILE device (WebKit — the engine an
// iPhone runs — with touch, so `DaimondShell.isMobileDevice` answers true from
// real signals rather than from a viewport width).
//
//   (a) the mobile device holds NO nomination record of its own;
//   (b) the desktop beats with `runner: true` and `mobile: false`, and the gateway
//       relays both to the mobile device;
//   (c) the mobile device's seat plan names the desktop, as the RUNNER
//       (`seat.on_runner`, reason `runner-posture`) — not `local`/`no-desktop`;
//   (d) the line UNDER THE COMPOSER says so, within one beat interval;
//   (e) and the line is one short clause, with the reason on its `title` and not
//       appended to the text (the copy the owner called overly verbose).
//
// Needs the dev stack: the app (DAIMOND_PORT), the mock, and a gateway on
// DAIMOND_GW_PORT. Presence rides the Pro-gated /api/sync door, so the account is
// granted Pro the way the gateway trusts (dev/pro.mjs).

import { open, signInAs, newChat } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());

/// One presence beat, passed exactly what daimond.js's presenceTick passes --
/// including the posture and the mobility answer, which is the point of this file.
const beatAs = (pg, runner) => pg.evaluate((run) => {
	const id = window.DaimondIdentity.deviceId();
	const nm = (window.DaimondCore && window.DaimondCore.deviceSelfName
		&& window.DaimondCore.deviceSelfName(id)) || 'a device';
	const mob = !!(window.DaimondShell && window.DaimondShell.isMobileDevice
		&& window.DaimondShell.isMobileDevice());
	window.DaimondPresence.beat(id, nm, Date.now(), true, false, null, run, mob);
	return window.DaimondSync.beatPresence(id, nm, true, false, run, mob);
}, runner);

let desk = null, phone = null;
try {
	// ── The DESKTOP: Chromium, a mouse, a wide window. ────────────────
	desk = await open({ name: 'runnerdesk', signIn: true, connect: true, defaults: false });
	await desk.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPresence && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(desk.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('the account holds Pro, so the presence path is not refused before it is measured',
		pro.pro === true, JSON.stringify(pro));

	// ── The MOBILE device: WebKit + touch, paired to the SAME account. ──
	// WebKit is the engine the owner's iPhone runs, and `touch` gives it the coarse
	// pointer / no-hover / touch-points triple that mobile.js decides on. Nothing
	// here sets a width: the whole point of the `mobile` flag is that the answer is
	// about the MACHINE, not the window.
	// The UA is an iPhone's. mobile.js reads a device's OWN statement about itself
	// first and treats it as final, and WebKit offers no `isMobile` switch (that is
	// Chromium's), so the UA is how this engine makes the statement a real iPhone makes.
	phone = await open({ name: 'runnerphone', signIn: false, connect: false,
		browser: 'webkit', touch: true,
		ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
			+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
	await phone.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 20000 }).catch(() => {});
	const code = await desk.page.evaluate(() => DaimondPairing.create());
	await phone.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await phone.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(phone, 'runnerdesk');
	await phone.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPresence && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 25000 }).catch(() => {});
	await phone.page.waitForTimeout(3000);
	// A CHAT MUST BE OPEN: the seat line is about the next turn of the chat on screen,
	// and `seatPlanNow` answers null with nothing open (which is correct, and is not
	// the thing under test).
	await newChat(phone);

	const idDesk  = await devId(desk.page);
	const idPhone = await devId(phone.page);
	check('the two paired contexts hold DISTINCT per-device ids',
		!!idDesk && !!idPhone && idDesk !== idPhone, JSON.stringify({ idDesk, idPhone }));
	const selfMobile = await phone.page.evaluate(() =>
		!!(window.DaimondShell && DaimondShell.isMobileDevice && DaimondShell.isMobileDevice()));
	check('the WebKit + touch context reads as a MOBILE DEVICE from real signals',
		selfMobile === true, 'isMobileDevice=' + selfMobile);

	// ── (a) THE PHONE KNOWS NOTHING ABOUT A RUNNER. ───────────────────
	// Cleared explicitly, because a parcel round may have carried one: the claim
	// under test is that the posture seats WITHOUT this record, so the record must
	// be provably absent rather than merely unlikely.
	await phone.page.evaluate(() => { try { localStorage.removeItem('daimond-nominated'); } catch (e) {} });
	const nomOnPhone = await phone.page.evaluate(() =>
		(window.DaimondCore && DaimondCore.roster && DaimondCore.roster.nominee)
			? DaimondCore.roster.nominee() : '');
	check('(a) the mobile device holds NO nomination record of its own',
		!nomOnPhone, 'nominatedId=' + JSON.stringify(nomOnPhone));

	// ── (b) THE DESKTOP BEATS THE POSTURE, AND THE GATEWAY RELAYS IT. ──
	await beatAs(desk.page, true);
	await desk.page.waitForTimeout(500);
	await phone.page.evaluate(() => window.DaimondSync.refreshPresence());
	const seen = await phone.page.evaluate((id) => {
		const snap = window.DaimondPresence.snapshot() || {};
		const r = snap[id];
		return r ? { runner: r.runner, mobile: r.mobile, name: r.name, hasRec: true } : { hasRec: false };
	}, idDesk);
	check('(b) the desktop reaches the phone with `runner:true` on its beat',
		seen.hasRec === true && seen.runner === true, JSON.stringify(seen));
	check('(b) and with `mobile:false`, so it is seatable at all',
		seen.mobile === false, JSON.stringify(seen));

	// ── (c) THE ELECTION SEATS IT, AS THE RUNNER. ─────────────────────
	const plan = await phone.page.evaluate(() => {
		return (window.DaimondCore && DaimondCore.seat && DaimondCore.seat.planNow)
			? DaimondCore.seat.planNow() : null;
	});
	check('(c) the phone’s seat plan names the desktop as the RUNNER',
		!!plan && plan.where === 'runner' && plan.key === 'seat.on_runner'
			&& plan.reason === 'runner-posture', JSON.stringify(plan));
	check('(c) and it is NOT the line the owner saw (local / no-desktop)',
		!!plan && !(plan.where === 'local' && plan.why === 'no-desktop'), JSON.stringify(plan));

	// ── (d) THE LINE UNDER THE COMPOSER SAYS SO, WITHIN ONE BEAT. ─────
	// `renderSeatLine` is wired to `daimond:presence`, which every ingest raises, so
	// a redraw must already have happened by the time the plan above was readable.
	const line = await phone.page.evaluate(() => {
		const el = document.getElementById('seat-line');
		if (!el) return null;
		return { hidden: !!el.hidden, text: el.textContent || '', title: el.getAttribute('title') || '',
			warn: el.classList.contains('seat-warn') };
	});
	check('(d) the seat line is shown and names the desktop',
		!!line && line.hidden === false && /runnerdesk|Chrom|device/i.test(line.text)
			&& /Next turn/i.test(line.text), JSON.stringify(line));
	check('(d) and it is no longer a warning asking for this screen',
		!!line && line.warn === false && !/keep this open/i.test(line.text), JSON.stringify(line));

	// ── (e) ONE SHORT CLAUSE, THE REASON ON THE TOOLTIP. ─────────────
	check('(e) the line is one short clause (no second sentence appended)',
		!!line && line.text.length <= 48 && !/\.\s/.test(line.text),
		JSON.stringify(line && line.text));
	check('(e) and no `.seat-why` span is appended to it any more',
		await phone.page.evaluate(() => !document.querySelector('#seat-line .seat-why')));

	// ── THE REGRESSION, MEASURED: disarm the posture and the line falls back. ──
	// Proof the seat came from the posture and from nothing else.
	await beatAs(desk.page, false);
	await desk.page.waitForTimeout(500);
	await phone.page.evaluate(() => window.DaimondSync.refreshPresence());
	const after = await phone.page.evaluate(() => {
		const d = DaimondCore.seat.planNow();
		return { where: d && d.where, reason: d && d.reason };
	});
	check('DISARMED: the same fleet without the posture no longer seats on it',
		!!after && after.reason !== 'runner-posture', JSON.stringify(after));
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	try { if (phone) await phone.close(); } catch (e) { /* closing */ }
	try { if (desk)  await desk.close();  } catch (e) { /* closing */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exit(bad.length ? 1 : 0);
