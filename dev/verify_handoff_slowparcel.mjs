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
//   SINCE SEQ 223 the errand carries the thread (`seedFrom`, peer.js), so a runner
//   does not need the parcel to read the prompt. Both cases keep their property --
//   a withheld parcel never strands a turn -- but the WAY it is satisfied changed:
//   the peer can now run the turn from the envelope it claimed, and the hand-back
//   remains the net for a turn whose reconstruct genuinely needs the workspace. The
//   checks below assert the property, not the mechanism, for exactly that reason.
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
	// THE WITHHOLD NO LONGER HAS TO BITE (seq 223). The errand carries the thread, so
	// a runner does not need a content pull to read the prompt -- `gate.aborted` can
	// legitimately be 0 because B never asked. What still matters, and is what this
	// file exists for, is that a WITHHELD PARCEL DOES NOT STRAND THE TURN: either the
	// withhold was exercised and B waited it out, or B never needed the parcel at all.
	// Both are the property; only a stranded turn is not.
	check('CASE 1: a withheld parcel either bit and was waited out, or was not needed',
		gate.aborted > 0 || bAns1.length >= 1,
		'aborted content pulls: ' + gate.aborted + ', B answers: ' + bAns1.length);
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
	// THE TURN IS ANSWERED. That is the property, and since seq 223 there are TWO ways
	// to satisfy it, because the errand now carries the thread:
	//
	//   B RUNS IT ANYWAY -- the better outcome, and the new ordinary one: the prompt
	//   and the conversation are on the envelope B claimed, so a parcel that never
	//   arrives costs the turn nothing. B answers, it syncs back, A shows it.
	//
	//   B HANDS IT BACK and A runs locally -- the old outcome, and still the net for a
	//   turn the seed genuinely cannot supply (a reconstruct that needs the workspace).
	//
	// Asserted as a disjunction rather than rewritten to the new case alone, because
	// BOTH are correct and which one happens depends on what the turn needs -- and a
	// test that demanded the hand-back would be demanding the slower answer.
	const ranB2 = ans2.filter((m) => String(m.ranOn) === String(idB)).length;
	check('CASE 2: the turn was ANSWERED despite the parcel never arriving',
		ans2.length >= 1,
		'answers: ' + ans2.length + '; ranOn=' + JSON.stringify(ans2.map((m) => m.ranOn)));
	check('CASE 2: either B ran it from the errand, or it was handed back and A ran it',
		ranB2 >= 1 || ranA2 >= 1,
		'on B: ' + ranB2 + ', on A: ' + ranA2
		+ ', undeliverable lines: ' + undeliverableSeen.length);
	check('CASE 2: and it happened BEFORE the ~95 s backstop',
		ans2.length >= 1 && elapsed2 < 90, 'elapsed: ' + elapsed2 + 's');
	check('CASE 2: exactly one answer -- one device ran it, never both',
		ans2.length === 1, 'answers: ' + ans2.length);
	// Match the ANSWER bubble ("Mock reply to: …DEADSYNC…"), not the prompt echo.
	const rendered2 = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /Mock reply to:[^\n]*DEADSYNC/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, 20000);
	check('CASE 2: A rendered the answer with the spinner cleared',
		rendered2 && ans2.length >= 1, 'answered at ~' + elapsed2 + 's; rendered: ' + rendered2);
	await shot(a, 'handoff_slowparcel_case2');
	gate.blocking = false;
	b.page.off('console', bAllListener);

	// ═══════════════════════════════════════════════════════════════════════════
	// CASE 3 — STALE RUNNER (WS-HAND #3). B is synced, then A's chat gains extra
	// messages (three ~20 KiB tool rows among them) while B's content pull is HELD.
	// A dispatches: the seed is CLIPPED (fits the door), but B's copy of the thread is
	// behind, so B's readiness (`holdsThread`) FAILS -- B hands the turn back
	// UNDELIVERABLE and never runs the model against the stale thread; A runs it.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\nCASE 3 — a runner whose thread is behind hands back UNDELIVERABLE (does not run stale)');
	const bAll3 = []; const bAll3Listener = (m) => bAll3.push(m.text());
	b.page.on('console', bAll3Listener);

	const newId3 = await newChatRetry(a);
	check('A created a brand-new chat (CASE 3)', !!newId3, 'chat id: ' + newId3);
	await a.page.setViewportSize({ width: 1500, height: 950 });
	await a.page.waitForTimeout(300);
	// Seed the chat and let B sync it, so B holds a KNOWN, EARLIER thread.
	await chat(a, 'CASE3 base turn');
	await settle(a.page);
	await wakeB();
	await b.page.waitForTimeout(2500);
	await settle(b.page);

	// HOLD B's content pull, then grow A's thread by six model-facing rows (three of
	// them ~20 KiB tool outputs) that B will not see while gated.
	gate.blocking = true;
	await a.page.evaluate(async () => {
		await new Promise((res) => {
			const req = indexedDB.open('daimond-chats');
			req.onsuccess = () => {
				const t = req.result.transaction('chats', 'readwrite');
				const store = t.objectStore('chats');
				const all = store.getAll();
				all.onsuccess = () => {
					const cs = (all.result || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
					const c = cs[0];
					if (c) {
						c.messages = c.messages || [];
						const big = 'T'.repeat(20 * 1024);
						for (let i = 0; i < 6; i++) {
							const isTool = i % 2 === 1;
							c.messages.push({ role: isTool ? 'tool' : 'assistant',
								content: isTool ? big : ('row ' + i), mid: 'grow-' + i, ts: Date.now() + i });
						}
						c.updatedAt = Date.now(); store.put(c);
					}
				};
				t.oncomplete = () => res(); t.onerror = () => res();
			};
			req.onerror = () => res();
		});
	});
	// Reload A so the grown thread is the live one it dispatches from.
	await a.page.reload({ waitUntil: 'domcontentloaded' });
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer, null, { timeout: 20000 }).catch(() => {});
	await a.page.waitForTimeout(1500);
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);

	const PROMPT3 = 'STALERUN answer against the whole thread';
	await a.page.fill('#chat-input', PROMPT3);
	await a.page.click('#chat-send', { force: true });

	const aStore3 = await untilChats(a, (cs) => answersMatching(cs, 'STALERUN').length >= 1, CASE2_MS);
	const ans3 = answersMatching(aStore3, 'STALERUN');
	const ranA3 = ans3.filter((m) => String(m.ranOn) === String(idA)).length;
	const ranB3 = ans3.filter((m) => String(m.ranOn) === String(idB)).length;
	const undeliverable3 = bAll3.filter((e) => /reconstruct undeliverable/i.test(e) && /incomplete/i.test(e));
	const stalePromptRun = bAll3.filter((e) => /reconstruct prompt from errand/i.test(e));
	check('CASE 3: B logged reconstruct UNDELIVERABLE … incomplete (refused the stale thread)',
		undeliverable3.length >= 1, 'undeliverable-incomplete lines: ' + undeliverable3.length);
	check('CASE 3: B NEVER ran the stale prompt-from-errand', stalePromptRun.length === 0,
		'prompt-from-errand lines: ' + stalePromptRun.length);
	check('CASE 3: the turn was answered exactly once, on A (B did not run the stale thread)',
		ans3.length === 1 && ranA3 === 1 && ranB3 === 0,
		'answers: ' + ans3.length + ' onA: ' + ranA3 + ' onB: ' + ranB3);
	await shot(a, 'handoff_slowparcel_case3');
	gate.blocking = false;
	b.page.off('console', bAll3Listener);

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  FAILED: ' + l); }
process.exit(bad.length ? 1 : 0);
