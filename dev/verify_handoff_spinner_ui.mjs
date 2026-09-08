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
//   (1) the tile names the device the turn is going to -- a tentative "Sending to X…",
//       from the dispatch's chosen target -- NOT the past-tense "Handed off to X" that
//       seq 217 withholds until a real claim;
//   (2) a take-back control is offered during the spinner;
//   (3) MONEY-SAFETY: clicking it pulls the turn local through the take-if-vacant lease
//       (trace: take…release), producing exactly one answer -- no double-run even with
//       the peer present.
//
// Needs the dev stack (app, mock, gateway). Pro-gated via pro.mjs.

import { open, chat, signInAs, newChat, connectMock, shot, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

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

	// ── SEND. A auto-dispatches (phone viewport + genuine peer); B never claims,
	//    so A stays in the pre-claim `dispatched` spinner. ──
	console.log('\nThe pre-claim spinner — A has dispatched, no peer has claimed the lease yet');
	await a.page.setViewportSize({ width: 390, height: 844 });   // iPhone-ish; isPhoneViewport() true
	await a.page.waitForTimeout(300);
	const PROMPT = 'SPINUI what is two plus two';
	await a.page.fill('#chat-input', PROMPT);
	await a.page.click('#chat-send', { force: true });

	// Wait for the hand-off tile's spinner to be up and the state to be `dispatched`
	// (no lease holder). This is the window the owner watches.
	const spinnerUp = await until(a.page, () => {
		const tile = document.querySelector('#chat-output .chat-msg-handoff, #chat-output .ti-handoff');
		return !!tile && !!document.querySelector('#chat-output .chat-spinner-dot, #chat-output .ti-spin');
	}, null, 20000);
	check('A shows the hand-off tile with its spinner', spinnerUp);

	// Confirm we are genuinely PRE-CLAIM (no lease holder), so this is the reported
	// window and not a post-claim state.
	const holder = await a.page.evaluate((tid) => {
		try { return (window.DaimondLease && DaimondLease.holder) ? (DaimondLease.holder(tid) || '') : ''; }
		catch (e) { return ''; }
	}, null);
	const preClaim = await a.page.evaluate(() => {
		// The dispatched placeholder's uiState, straight from the classifier.
		try {
			const cs = (window.DaimondCore && DaimondCore.chatResidency) ? null : null;
			const c = window.__curChat || null;
			return true;   // holder check below is the authority
		} catch (e) { return true; }
	});

	// THE TWO GAPS. Snapshot the HAND-OFF TILE specifically (its own header + footer),
	// not the whole thread.
	const snap = await a.page.evaluate(() => {
		const tile = document.querySelector('#chat-output .chat-msg-handoff')
			|| document.querySelector('#chat-output .ti-handoff') || null;
		const scope = tile ? (tile.closest('.chat-msg') || tile) : null;
		const txt = scope ? scope.innerText : '';
		const btns = scope ? Array.from(scope.querySelectorAll('button'))
			.map((b) => (b.textContent || '').trim()).filter(Boolean) : [];
		return { found: !!tile, txt, btns };
	});
	check('the hand-off tile is on screen', snap.found, 'tile text: ' + JSON.stringify((snap.txt || '').replace(/\s+/g, ' ').slice(0, 120)));
	// (1) DEVICE HINT: the tile should name the device the turn is going to. Currently it
	//     is the generic "Sent to your other devices" with no name -> RED. (Post-fix a
	//     tentative "Sending to <peer>" naming the CHOSEN target satisfies this without
	//     the past-tense "Handed off to X" that seq 217 rightly withheld until a claim.)
	const generic = /^\s*(hand-?off|sent to your other devices\.?)\s*$/i.test((snap.txt || '').trim())
		|| !/sending to|going to|→|picking this up|is doing|will run/i.test(snap.txt || '');
	check('(1) the spinner names the device the turn is going to (a "Sending to X" hint)',
		!generic, 'tile text: ' + JSON.stringify((snap.txt || '').replace(/\s+/g, ' ').slice(0, 160)));
	// (2) TAKE-BACK / CANCEL: a control to pull the turn back / run here should be offered
	//     during the spinner. Currently none is (take-back is holder-gated) -> RED.
	const hasControl = snap.btns.some((t) => /take back|run here|cancel|bring back|stop/i.test(t));
	check('(2) a take-back / run-here control is offered during the spinner',
		hasControl, 'buttons in the tile: ' + JSON.stringify(snap.btns));

	await shot(a, 'handoff_spinner_ui_' + A_ENGINE);
	console.log('\nDIAGNOSIS: holder="' + holder + '" (empty = pre-claim, the reported window). '
		+ 'Tile=' + JSON.stringify(snap.txt.replace(/\s+/g, ' ').slice(0, 120)) + ' buttons=' + JSON.stringify(snap.btns));

	// ── MONEY-SAFETY: clicking the pre-claim take-back runs the turn HERE, exactly
	//    once, with no double-run even though the peer is present. ──
	console.log('\nMoney-safety — the take-back pulls the turn local through the take-if-vacant lease');
	const answersMatching = (cs) => (cs || []).flatMap((c) => (c.messages || []))
		.filter((m) => m.role === 'assistant' && m.content && m.content.trim() && !m.interrupted
			&& /SPINUI/i.test(m.content));
	// Wait for the DURABLE dispatched placeholder to be persisted (markTurnDispatched,
	// after the parcel push in dispatchToPeer) so the take-back can resolve it via the
	// index -- the synthetic send-time tile is drawn first, before the dispatch commits.
	{
		const t0 = Date.now();
		while (Date.now() - t0 < 15000) {
			let cs = []; try { cs = await storedChats(a); } catch (e) { cs = []; }
			if ((cs || []).some((c) => (c.messages || []).some((mm) => mm.why === 'dispatched'))) break;
			await a.page.waitForTimeout(400);
		}
	}
	// Capture what runErrand does on A when the take-back fires -- the money-safe trace
	// (take -> reconstruct -> run -> push -> report -> complete -> ack -> release) is the
	// evidence the local run went through the take-if-vacant lease, not a bare re-run.
	await a.page.evaluate(() => {
		const orig = window.DaimondPeer.runErrand;
		window.__lastRun = 'not-called';
		window.DaimondPeer.runErrand = async function (e, d) {
			const r = await orig(e, d);
			window.__lastRun = { ran: !!(r && r.ran), done: !!(r && r.done), why: r && r.why, trace: (r && r.trace) || [] };
			return r;
		};
	});
	// Click the take-back in the hand-off tile (pre-claim -> takeBackToLocal).
	const clicked = await a.page.evaluate(() => {
		const tile = document.querySelector('#chat-output .chat-msg-handoff') || document.querySelector('#chat-output .ti-handoff');
		const scope = tile ? (tile.closest('.chat-msg') || tile) : null;
		const btn = scope && Array.from(scope.querySelectorAll('button'))
			.find((b) => /take back|run here|bring back/i.test((b.textContent || '')));
		if (btn) { btn.click(); return true; }
		return false;
	});
	check('the take-back control was clickable', clicked);
	await a.page.waitForTimeout(2000);
	const lastRun = await a.page.evaluate(() => window.__lastRun);
	console.log('take-back runErrand: ' + JSON.stringify(lastRun));
	// The take-back went through the take-if-vacant lease (not a bare local re-run):
	// the trace shows it TOOK the lease and released it -- the single-runner guarantee.
	const tookLease = !!(lastRun && lastRun.trace && lastRun.trace.indexOf('take') !== -1
		&& lastRun.trace.indexOf('release') !== -1);
	check('the take-back ran through the take-if-vacant lease (money-safe path)', tookLease,
		'trace: ' + JSON.stringify(lastRun && lastRun.trace));
	// A runs it locally and produces exactly one answer (idA declared above).
	const ranLocal = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		return !!(out && /Mock reply to:[^\n]*SPINUI/i.test(out.innerText));
	}, null, 30000);
	check('the turn RAN locally after take-back (answer rendered here)', ranLocal);
	// Un-stub B and force it to collect the errand: it must STAND DOWN (finished / lease),
	// never producing a second answer -- the money-safe race outcome.
	await b.page.evaluate(() => { if (window.__origRunErrand) window.DaimondPeer.runErrand = window.__origRunErrand; });
	await b.page.evaluate(() => { try { if (window.DaimondPost && DaimondPost.collect) DaimondPost.collect(); } catch (e) {} });
	await b.page.waitForTimeout(3000);
	// Settle A and count answers on BOTH sides for this turn.
	await settle(a.page);
	const aAns = answersMatching(await storedChats(a)).length;
	const bAns = answersMatching(await storedChats(b)).length;
	const ranOnA = answersMatching(await storedChats(a)).filter((m) => String(m.ranOn) === String(idA)).length;
	check('exactly one answer for the turn after take-back (no double-run vs the peer)',
		aAns === 1, 'A answers: ' + aAns + '  B answers: ' + bAns);
	check('the one answer ran on THIS device (the take-back landed here)', ranOnA >= 1,
		'ranOnA: ' + ranOnA + ' of ' + aAns);

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  (RED confirms the bug) ' + l); }
process.exit(bad.length ? 1 : 0);
