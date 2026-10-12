// gateway: live
// verify_handoff_spinner_ui.mjs — ISSUE 2 (owner, seq 222 live): during the
// "Sent to your other devices" spinner, BEFORE any peer claims the lease, the
// hand-off tile shows NO device hint and offers NO take-back/cancel control. Both
// were present before seq 217 (commit 7737941) tightened handoffClaimLabel to a
// HOLDER-ONLY name and left the take-back gated on the holder states
// (running/claimed/awaiting-consent). seq 222 made the hand-off reliably reach a
// peer, so this pre-claim window is now a real, visible spinner and the gap shows.
//
// The DISPATCHER is driven under both WEBKIT (Playwright's JavaScriptCore build -- the
// engine the owner's iPhone runs; SPINUI_A=webkit, the default) and CHROMIUM
// (SPINUI_A=chromium) at a 390x844 mobile viewport, so isPhoneViewport() is true and a
// send auto-dispatches. A genuine Chromium PEER is present (beating, servicing) so the
// election picks it, but its DaimondPeer.runErrand is stubbed so it NEVER claims the
// lease -- holding the dispatcher in the pre-claim `dispatched` state (page.route does
// not intercept under Playwright-WebKit, so the pending condition is fabricated by
// stubbing the peer, not the network).
//
// Verifies the seq-2xx fix (RED before it, GREEN after):
//   (1a) NOMINEE ARM: with a runner nominated (DaimondCore.roster.nominate(B)), the tile names
//        it -- a tentative "Sending to B…" (`turn.peer_sending_named`) -- NOT the
//        past-tense "Handed off to X" that seq 217 withholds until a real claim;
//   (1b) NO-NOMINEE ARM: with none nominated, the turn runs HERE -- no hand-off tile,
//        no device named. The 2026-09-07 ruling (a3bdf814: "never a guessed device")
//        is now held by the owner's switch (D-20261009-23): only a nominated runner may
//        take a turn, so with none there is no hand-off to name;
//   (2) NO take-back / run-here / cancel control on the pre-claim tile (D-20261009-23:
//       no Take back at all; "Run here" only as failure recovery). Re-aimed from
//       "a take-back is offered";
//   (3) MONEY-SAFETY, re-aimed from the take-back click: the no-nominee turn yields
//       exactly one answer, ran on this device, and the peer never answers it.
//
// Needs the dev stack (app, mock, gateway). Pro-gated via pro.mjs.

import { open, chat, signInAs, newChat, connectMock, shot, servedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});
const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());
async function until(pg, fn, arg, ms = 20000, step = 400) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true; await pg.waitForTimeout(step);
	}
	return false;
}

// The dispatcher's engine, so this runs under BOTH WebKit (the iOS engine) and
// Chromium. SPINUI_A=webkit|chromium (default webkit).
const A_ENGINE = (process.env.SPINUI_A || 'webkit').toLowerCase();
// A FRESH account per run: this test leaves un-answered dispatched turns on the
// account (the peer is stubbed to never claim), so reusing one name across runs
// pollutes the parcel and the local-recovery decision. A unique identity isolates it.
const A_NAME = 'spin_' + A_ENGINE + '_' + Date.now().toString(36);

let a, b;
try {
	// ── A: the DISPATCHER. Wide for the rail (the new-chat control is in a drawer at
	//    phone width); narrowed to 390x844 just before the send, which is where
	//    isPhoneViewport() is read (maybeAutoDispatch). ──
	a = await open({ name: A_NAME, browser: A_ENGINE });   // width-based isPhone, so no touch needed
	await a.page.setViewportSize({ width: 1500, height: 950 });
	await a.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const engine = await a.page.evaluate(() => navigator.userAgent);
	const isWebkit = /WebKit/.test(engine) && !/Chrome\//.test(engine);
	check('A runs under the requested engine (' + A_ENGINE + ')',
		A_ENGINE === 'webkit' ? isWebkit : /Chrome\//.test(engine), engine.slice(0, 80));
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro (the dispatch path is not refused)', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the account has a parcel');
	await settle(a.page);

	// ── B: a genuine Chromium peer, paired, Pro, servicing -- but it NEVER claims. ──
	b = await open({ name: 'hofmate', signIn: false, connect: false });   // default: chromium
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, A_NAME);
	await b.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	// STUB B's runner: it stays present + servicing (so the election calls it genuine),
	// but it never takes the lease, so the dispatcher sits in the pre-claim spinner.
	await b.page.evaluate(() => {
		if (window.DaimondPeer) {
			window.__origRunErrand = window.DaimondPeer.runErrand;
			window.DaimondPeer.runErrand = async () => ({ ran: false, why: 'stubbed-no-claim' });
		}
	});
	await b.page.waitForTimeout(1500);
	await settle(b.page);

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices', !!idA && !!idB && idA !== idB, JSON.stringify({ idA, idB }));

	// B beats presence servicing=true; A refreshes and sees it genuine.
	await b.page.evaluate(() => window.DaimondSync.beatPresence
		&& window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(),
			(window.DaimondIdentity.displayName && window.DaimondIdentity.displayName()) || 'hofmate', false, true));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const genuine = await a.page.evaluate((self) => {
		try { const p = DaimondPeer.freshestGenuinePeer(DaimondPresence.snapshot(), self, Date.now(), DaimondPeer.DISPATCH_FRESH_MS);
			return p ? { deviceId: p.deviceId, name: p.name } : null; } catch (e) { return { err: String(e) }; }
	}, idA);
	check('A sees B as a GENUINE peer the election will pick', !!(genuine && genuine.deviceId === idB),
		JSON.stringify(genuine));

	// THE HAND-OFF TILE, snapshotted specifically (its own header + footer), not the thread.
	const snapTile = () => a.page.evaluate(() => {
		const tile = document.querySelector('#chat-output .chat-msg-handoff')
			|| document.querySelector('#chat-output .ti-handoff') || null;
		const scope = tile ? (tile.closest('.chat-msg') || tile) : null;
		const txt = scope ? scope.innerText : '';
		const btns = scope ? Array.from(scope.querySelectorAll('button'))
			.map((b) => (b.textContent || '').trim()).filter(Boolean) : [];
		return { found: !!tile, txt, btns };
	});
	// One arm: a fresh chat (the new-chat control is in the rail at desktop width), then
	// the send at an iPhone-ish 390x844 so isPhoneViewport() is true and A auto-dispatches;
	// B never claims, so A stays in the pre-claim `dispatched` spinner -- the window the
	// owner watches.
	const sendArm = async (prompt) => {
		await a.page.setViewportSize({ width: 1500, height: 950 });
		await newChat(a);
		await a.page.setViewportSize({ width: 390, height: 844 });
		await a.page.waitForTimeout(300);
		await a.page.fill('#chat-input', prompt);
		await a.page.click('#chat-send', { force: true });
		const up = await until(a.page, () => {
			const tile = document.querySelector('#chat-output .chat-msg-handoff, #chat-output .ti-handoff');
			return !!tile && !!document.querySelector('#chat-output .chat-spinner-dot, #chat-output .ti-spin');
		}, null, 20000);
		return { up, snap: await snapTile() };
	};
	const flat = (t) => (t || '').replace(/\s+/g, ' ').trim();
	const bLabel = await b.page.evaluate(() => (window.DaimondIdentity.displayName
		&& window.DaimondIdentity.displayName()) || 'hofmate');

	// ── (1a) NOMINEE ARM. A nominates B, so the dispatch has a chosen target to name. ──
	console.log('\n(1a) Nominee arm — A has nominated B; the pre-claim spinner names it');
	const nom = await a.page.evaluate((id) => {
		try { const r = window.DaimondCore.roster.nominate(id); return { ok: !!r, now: window.DaimondCore.roster.nominee() }; }
		catch (e) { return { err: String(e) }; }
	}, idB);
	check('A nominated B as its runner', !!(nom && nom.ok && nom.now === idB), JSON.stringify(nom));
	await a.page.waitForTimeout(1500);
	const armN = await sendArm('NOMARM what is three plus three');
	check('(1a) A shows the hand-off tile with its spinner', armN.up);
	check('(1a) with a nominee, the spinner names it: "Sending to ' + bLabel + '…"',
		/sending to/i.test(armN.snap.txt) && armN.snap.txt.indexOf(bLabel) !== -1
			&& !/handed off to/i.test(armN.snap.txt),
		'tile text: ' + JSON.stringify(flat(armN.snap.txt).slice(0, 160)));

	// (2) NO TAKE-BACK (owner, D-20261009-23): the pre-claim tile offers no take-back,
	//     cancel or run-here control. The switch by the input box is where the person
	//     chooses where a turn runs; "Run here" exists only as failure recovery, and a
	//     tile still waiting for its runner is not a failure. Re-aimed from the seq-2xx
	//     "(2) a take-back is offered" arm, which tested the control the owner removed.
	check('(2) the pre-claim tile offers no take-back / run-here / cancel control',
		!armN.snap.btns.some((t) => /take back|run here|cancel|bring back/i.test(t)),
		'buttons in the tile: ' + JSON.stringify(armN.snap.btns));
	const holder = await a.page.evaluate(() => {
		try { return (window.DaimondLease && DaimondLease.holder) ? (DaimondLease.holder() || '') : ''; }
		catch (e) { return ''; }
	});
	await shot(a, 'handoff_spinner_ui_' + A_ENGINE);
	console.log('\nDIAGNOSIS: holder="' + holder + '" (empty = pre-claim). '
		+ 'Tile=' + JSON.stringify(flat(armN.snap.txt).slice(0, 120)) + ' buttons=' + JSON.stringify(armN.snap.btns));

	// ── (1b) NO-NOMINEE ARM. The nomination is cleared. Under the owner's switch (Here |
	//    runner, D-20261009-23) only a nominated runner may take a turn, so the send runs
	//    HERE: no hand-off tile, no guessed device (the 2026-09-07 ruling's intent, now
	//    held by never handing off at all), the answer rendered on this device. ──
	console.log('\n(1b) No-nominee arm — nothing nominated; the turn runs here and names no device');
	const cleared = await a.page.evaluate(() => {
		try { window.DaimondCore.roster.nominate(''); return window.DaimondCore.roster.nominee() || ''; }
		catch (e) { return 'ERR ' + e; }
	});
	check('A cleared its nomination', cleared === '', JSON.stringify(cleared));
	await a.page.waitForTimeout(1500);
	await a.page.setViewportSize({ width: 1500, height: 950 });
	await newChat(a);
	await a.page.setViewportSize({ width: 390, height: 844 });
	await a.page.waitForTimeout(300);
	await a.page.fill('#chat-input', 'SPINUI what is two plus two');
	await a.page.click('#chat-send', { force: true });
	const ranHere = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		return !!(out && /Mock reply to:[^\n]*SPINUI/i.test(out.innerText));
	}, null, 30000);
	check('(1b) with no nominee, the turn RAN here (answer rendered on A)', ranHere);
	const snap = await snapTile();
	check('(1b) with no nominee, no hand-off tile is drawn and no device is named',
		!snap.found && !/sent to your other devices|sending to|handed off to/i.test(snap.txt),
		'tile: ' + JSON.stringify({ found: snap.found, txt: flat(snap.txt).slice(0, 160) }));

	// ── (3) MONEY-SAFETY, re-aimed from the take-back click: the no-nominee turn runs
	//    exactly once, here, and the peer -- un-stubbed and made to collect -- never
	//    produces a second answer for it. ──
	console.log('\n(3) Money-safety — one answer, on this device, none from the peer');
	const answersMatching = (cs) => (cs || []).flatMap((c) => (c.messages || []))
		.filter((m) => m.role === 'assistant' && m.content && m.content.trim() && !m.interrupted
			&& /SPINUI/i.test(m.content));
	await b.page.evaluate(() => { if (window.__origRunErrand) window.DaimondPeer.runErrand = window.__origRunErrand; });
	await b.page.evaluate(() => { try { if (window.DaimondPost && DaimondPost.collect) DaimondPost.collect(); } catch (e) {} });
	await b.page.waitForTimeout(3000);
	await settle(a.page);
	await settle(b.page);
	const aList = answersMatching(await servedChats(a));
	const bList = answersMatching(await servedChats(b));
	const ranOnA = aList.filter((m) => String(m.ranOn) === String(idA)).length;
	const ranOnB = aList.concat(bList).filter((m) => String(m.ranOn) === String(idB)).length;
	check('(3) exactly one answer for the turn (no double-run vs the peer)',
		aList.length === 1, 'A answers: ' + aList.length + '  B answers: ' + bList.length);
	check('(3) the one answer ran on THIS device, none on the peer', ranOnA === 1 && ranOnB === 0,
		'ranOnA: ' + ranOnA + '  ranOnB: ' + ranOnB);

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}

guardRan(ok.length + bad.length);
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  (RED confirms the bug) ' + l); }
process.exit(bad.length ? 1 : 0);
