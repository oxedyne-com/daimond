// verify_handoff_slowparcel.mjs — the LIVE production hand-off failure (build 221):
// a hand-off to a peer whose parcel is still SYNCING past the old fixed 8 s
// reconstruct window. This is the blind spot verify_handoff_newchat missed: it
// delayed B's chats[] REBUILD by only 1200 ms (far under 8000 ms), so it never
// exercised a parcel that takes tens of seconds to reach the peer. The owner's
// gateway log showed the parcel version climbing (6253→6258) with chunk pulls
// landing at +96 s -- the peer CLAIMED the lease 6× and ran NOTHING, because
// `peerReconstruct` gave the pull a FIXED 8 s and then threw + RELEASED the lease
// into a claim-loop (the next device claims, throws, releases, ...).
//
// Two REAL paired browser contexts on the REAL gateway. To make a slow parcel
// deterministic on a single machine (where one pull gets the whole parcel at once),
// B's CONTENT PULL is held at the NETWORK layer with Playwright `page.route`: a plain
// `GET /api/sync` (the content pull -- NOT `?presence=1`, NOT `?lease=1`, NOT the
// POST push) is aborted while `gate.blocking`, so B's version stays put and the chat
// never reaches it -- exactly the gateway-not-yet-delivering shape of the log. Every
// other channel (the errand on /api/post, presence, the lease door) is untouched, and
// the product code under test -- peerReconstruct's progress-based wait/materialise,
// the lease, the runner, the undeliverable→local hand-back -- runs unshimmed in a real
// browser JS engine.
//
//   CASE 1 (SLOW-BUT-ARRIVING): the parcel is withheld ~15 s -- WELL past the old 8 s
//   window -- then delivered. The runner must WAIT IT OUT and run the turn, not give
//   up + claim-loop. (Pre-fix this is RED: B logs "reconstruct ... does not hold yet",
//   releases the lease, and no answer ever appears.)
//
//   CASE 2 (NEVER ARRIVES): the parcel is withheld indefinitely. The runner must
//   detect the STALL, report UNDELIVERABLE, and the DISPATCHER (A) must drop to a
//   LOCAL run AT ONCE -- before the ~95 s backstop -- exactly one run, on A, B never
//   runs. (Pre-fix this is RED: an endless claim-loop, no local recovery.)
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.

import { open, chat, signInAs, newChat, connectMock, shot, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const CASE1_BLOCK_MS = 15000;		// CASE 1: withhold the parcel this long (> the old 8 s window)
const CASE1_MS       = 60000;		// room for the ~15 s wait + the turn
const CASE2_MS       = 88000;		// > the 45 s reconstruct stall + the local run, < the ~95 s backstop
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});

const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());

async function until(pg, fn, arg, ms = 30000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false;
		try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true;
		await pg.waitForTimeout(step);
	}
	return false;
}

async function untilChats(s, pred, ms = 30000, step = 500) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let cs = [];
		try { cs = await storedChats(s); } catch (e) { cs = []; }
		try { if (pred(cs)) return cs; } catch (e) { /* keep polling */ }
		await s.page.waitForTimeout(step);
	}
	try { return await storedChats(s); } catch (e) { return []; }
}
const allMsgs = (cs) => (cs || []).flatMap((c) => (c.messages || []));
const answersMatching = (cs, needle) => allMsgs(cs).filter((m) =>
	m.role === 'assistant' && m.content && m.content.trim() && !m.interrupted
	&& new RegExp(needle, 'i').test(m.content));

// A robust new-chat: the rail's new-session control occasionally needs a second go at
// desktop width (a page animation loses the first click) -- a harness flake unrelated
// to the hand-off under test.
async function newChatRetry(a) {
	for (let i = 0; i < 3; i++) {
		try { const id = await newChat(a); if (id) return id; } catch (e) { /* retry */ }
		await a.page.waitForTimeout(500);
	}
	return await newChat(a);
}

// Is this the CONTENT pull (a plain GET /api/sync with no query)? The presence beat
// (?presence=1), the lease CAS (?lease=1) and the push (POST) must all pass through.
function isContentPull(req) {
	if (req.method() !== 'GET') return false;
	try { const u = new URL(req.url()); return u.pathname.endsWith('/api/sync') && u.search === ''; }
	catch (e) { return false; }
}

let a, b;
try {
	// ── A: the dispatcher (a phone). B: a desktop peer paired to the same account. ──
	a = await open({ name: 'hoflead', touch: true });
	await a.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro (the dispatch path is not refused)', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChatRetry(a);
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	b = await open({ name: 'hofmate', signIn: false, connect: false });
	const bErrs = [];		// B's console errors — the reconstruct signature prints here
	b.page.on('console', (m) => { if (m.type() === 'error') bErrs.push(m.text()); });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'hoflead');
	await b.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.waitForTimeout(2000);
	await settle(b.page);

	// THE NETWORK GATE. A plain GET /api/sync is aborted while blocking; everything
	// else passes. Installed once; the two cases flip `gate.blocking`.
	const gate = { blocking: false, aborted: 0 };
	await b.page.route('**/api/sync*', async (route) => {
		if (gate.blocking && isContentPull(route.request())) { gate.aborted++; return route.abort(); }
		return route.continue();
	});

	// AND THE GATE ACTUALLY BITES ON THIS ENGINE. Every withhold below is a no-op if
	// `page.route` does not intercept, and a no-op reads as the PRODUCT failing: run
	// under `DAIMOND_BROWSER=webkit` this file scored 13 ok / 3 failed on a tree whose
	// default-engine score was 16 / 0, the first red line being "B held the content pull
	// past 8 s -- aborted content pulls: 0" (measured 2026-09-12). That is the gate
	// saying nothing, not the runner giving up. So the interception is proven once, on a
	// throwaway pull, before any property rests on it.
	{
		gate.blocking = true;
		const before = gate.aborted;
		await b.page.evaluate(() => fetch('/api/sync', { credentials: 'same-origin' })
			.then(() => null).catch(() => null));
		gate.blocking = false;
		check('the network gate intercepts this engine\'s requests (the withholds below are real)',
			gate.aborted > before, 'aborted on the probe pull: ' + (gate.aborted - before)
			+ ' (0 means page.route is inert here -- run this file under its default engine)');
		gate.aborted = 0;
	}

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices of one account', !!idA && !!idB && idA !== idB,
		JSON.stringify({ idA, idB }));

	const wakeB = async () => {
		await until(b.page, () => {
			try { return (window.DaimondPost.state && window.DaimondPost.state().parks > 0)
				|| (window.DaimondPost.parks && window.DaimondPost.parks() > 0); } catch (e) { return false; }
		}, null, 8000);
		await b.page.evaluate(() => window.DaimondSync.beatPresence
			&& window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(),
				(window.DaimondIdentity.displayName && window.DaimondIdentity.displayName()) || 'hofmate', false, true));
		await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
		await a.page.waitForTimeout(1500);
	};
	await wakeB();
	const aSeesB = await a.page.evaluate((self) =>
		(window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer', aSeesB >= 1, 'awake peers: ' + aSeesB);

	// ═══════════════════════════════════════════════════════════════════════════
	// CASE 1 — SLOW BUT ARRIVING. The parcel is withheld ~15 s (past the old 8 s
	// window), then delivered. The runner must WAIT and run it, not claim-loop.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\nCASE 1 — the parcel is withheld ~15 s (past the old 8 s reconstruct window), then arrives');
	bErrs.length = 0;
	gate.blocking = true; gate.aborted = 0;

	const newId1 = await newChatRetry(a);
	check('A created a brand-new chat (CASE 1)', !!newId1, 'chat id: ' + newId1);
	const bHadIt1 = await b.page.evaluate((id) => {
		try { return (window.DaimondCore.chatResidency() || []).some((c) => c.id === id); } catch (e) { return false; }
	}, newId1);
	check('B does NOT already hold the brand-new chat', !bHadIt1, 'B held it: ' + bHadIt1);

	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	const PROMPT1 = 'SLOWSYNC what is two plus two';
	const t0 = Date.now();
	await a.page.fill('#chat-input', PROMPT1);
	await a.page.click('#chat-send', { force: true });
	await a.page.waitForTimeout(1000);
	// Let the runner spin against the withheld parcel PAST the old 8 s window, then
	// deliver it. A build with the fixed 8 s window has already thrown by now.
	setTimeout(() => { gate.blocking = false; }, CASE1_BLOCK_MS);

	const bRan1 = await untilChats(b, (cs) => answersMatching(cs, 'SLOWSYNC').length >= 1, CASE1_MS);
	const bAns1 = answersMatching(bRan1, 'SLOWSYNC');
	const claimLoop1 = bErrs.filter((e) => /reconstruct/i.test(e)
		&& (/does not hold yet/i.test(e) || /could not sync/i.test(e) || /undeliverable/i.test(e)));
	check('CASE 1: B held the content pull past 8 s (the withhold was exercised)', gate.aborted > 0,
		'aborted content pulls: ' + gate.aborted);
	check('CASE 1: B did NOT claim-loop / give up on the slow parcel (no reconstruct-fail)',
		claimLoop1.length === 0,
		'reconstruct-fail console lines: ' + claimLoop1.length
		+ (claimLoop1[0] ? ' e.g. ' + JSON.stringify(claimLoop1[0]).slice(0, 100) : ''));
	check('CASE 1: B RAN the turn once the parcel arrived (~' + Math.round((Date.now() - t0) / 1000) + 's)',
		bAns1.length >= 1, 'B answers: ' + bAns1.length);

	const aStore1 = await untilChats(a, (cs) => answersMatching(cs, 'SLOWSYNC').length >= 1, 30000);
	// Match the ANSWER bubble, not the prompt echo. The mock answers "Mock reply to:
	// <prompt>", so "Mock reply to" appears ONLY in the assistant answer (never the
	// user bubble) -- a stranded turn, whose prompt is still on screen, does not match.
	const rendered1 = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /Mock reply to:[^\n]*SLOWSYNC/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, 30000);
	check('CASE 1: the answer synced back to A and rendered (spinner cleared)',
		rendered1 && answersMatching(aStore1, 'SLOWSYNC').length >= 1,
		'in A store: ' + answersMatching(aStore1, 'SLOWSYNC').length + ' rendered: ' + rendered1);
	check('CASE 1: exactly one answer for the hand-off turn (no double-run through the wait)',
		answersMatching(aStore1, 'SLOWSYNC').length === 1,
		'answers: ' + answersMatching(aStore1, 'SLOWSYNC').length);
	await shot(a, 'handoff_slowparcel_case1');

	await a.page.setViewportSize({ width: 1500, height: 950 });
	await a.page.waitForTimeout(300);
	await settle(b.page);
	await wakeB();

	// ═══════════════════════════════════════════════════════════════════════════
	// CASE 2 — NEVER ARRIVES. The parcel is withheld indefinitely. B must STALL,
	// report UNDELIVERABLE, and the DISPATCHER (A) must drop to a LOCAL run at once
	// (before the ~95 s backstop): exactly one run, on A, B never runs.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\nCASE 2 — the parcel never reaches the peer: undeliverable → immediate local run on A');
	bErrs.length = 0;
	const bAll = []; const bAllListener = (m) => bAll.push(m.text());
	b.page.on('console', bAllListener);
	gate.blocking = true; gate.aborted = 0;

	const newId2 = await newChatRetry(a);
	check('A created a brand-new chat (CASE 2)', !!newId2, 'chat id: ' + newId2);
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	const PROMPT2 = 'DEADSYNC what is three plus three';
	const t2 = Date.now();
	await a.page.fill('#chat-input', PROMPT2);
	await a.page.click('#chat-send', { force: true });
	await a.page.waitForTimeout(1000);

	const aStore2 = await untilChats(a, (cs) => answersMatching(cs, 'DEADSYNC').length >= 1, CASE2_MS);
	const elapsed2 = Math.round((Date.now() - t2) / 1000);
	const ans2 = answersMatching(aStore2, 'DEADSYNC');
	const ranA2 = ans2.filter((m) => String(m.ranOn) === String(idA)).length;
	const undeliverableSeen = bAll.filter((e) => /reconstruct undeliverable/i.test(e)
		|| (/undeliverable/i.test(e) && /reconstruct/i.test(e)));
	check('CASE 2: B reported the parcel UNDELIVERABLE (handed the turn back)',
		undeliverableSeen.length >= 1,
		'undeliverable console lines: ' + undeliverableSeen.length
		+ (undeliverableSeen[0] ? ' e.g. ' + JSON.stringify(undeliverableSeen[0]).slice(0, 100) : ''));
	check('CASE 2: A ran the turn LOCALLY (dropped to local, not stranded)', ranA2 >= 1,
		'answers on A: ' + ranA2 + ' / total: ' + ans2.length + '; ranOn=' + JSON.stringify(ans2.map((m) => m.ranOn)));
	check('CASE 2: the local run happened BEFORE the ~95 s backstop (immediate, via the undeliverable report)',
		ans2.length >= 1 && elapsed2 < 90, 'elapsed: ' + elapsed2 + 's');
	check('CASE 2: exactly one answer (no double-run; B never ran)', ans2.length === 1,
		'answers: ' + ans2.length);
	// Match the ANSWER bubble ("Mock reply to: …DEADSYNC…"), not the prompt echo.
	const rendered2 = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /Mock reply to:[^\n]*DEADSYNC/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, 20000);
	check('CASE 2: A rendered the local answer with the spinner cleared',
		rendered2 && ans2.length >= 1, 'ran locally at ~' + elapsed2 + 's; rendered: ' + rendered2);
	await shot(a, 'handoff_slowparcel_case2');
	gate.blocking = false;
	b.page.off('console', bAllListener);

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  FAILED: ' + l); }
process.exit(bad.length ? 1 : 0);
