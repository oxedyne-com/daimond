// verify_handoff_newchat.mjs — the hand-off of a turn in a BRAND-NEW chat, which
// verify_peerrescue does not exercise and which was the shipped failure.
//
// verify_peerrescue seeds a chat on A, pairs B (so B pulls that chat), and only
// THEN dispatches a turn in it -- so B always already holds the chat, and the
// receiver-materialise path is never taken. The live failure was different: the
// user starts an ORDINARY chat on the phone, its very first turn is dispatched,
// and the peer has never seen that chat. The errand reaches the peer over the
// Post channel BEFORE the peer's own sync poll has pulled the new chat's parcel,
// so the runner has to pull-and-materialise the chat inside `peerReconstruct`.
// When that fails the runner throws "the errand names a chat this device does not
// hold yet", releases the lease, and the next device claims and throws in turn --
// the claim-loop with no completion and no answer that the production log showed.
//
// Here A and B are two REAL paired contexts on the REAL gateway. A holds a seed
// chat (so the pairing/sync path is ordinary), then A creates a genuinely NEW
// chat and dispatches its first turn to B. The checks below separate the two
// defects:
//   (1) does the runner RUN the turn (no reconstruct-fail claim-loop), so exactly
//       one answer is produced;
//   (2) does that answer reach A's STORE and RENDER on A (the placeholder
//       reconciled, the spinner cleared), rather than the store holding an answer
//       the screen never shows.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK), gateway
// (DAIMOND_GW_PORT). Pro-gated, granted the one way the gateway trusts (pro.mjs).

import { open, chat, signInAs, newChat, connectMock, shot, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const RTMS = Number(process.env.RESCUE_MS || 90000);
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
const countDispatched = (cs) => allMsgs(cs).filter((m) => m.why === 'dispatched').length;
// A real assistant answer to the dispatched prompt, wherever it sits and whatever
// its iturn: the peer's answer syncs back with no iturn on it.
const answersMatching = (cs, needle) => allMsgs(cs).filter((m) =>
	m.role === 'assistant' && m.content && m.content.trim() && !m.interrupted
	&& new RegExp(needle, 'i').test(m.content));

// A's rendered thread as text, and whether the "sent to your other devices"
// spinner footer is still up. The store/DOM split is what tells defect 2 (answer
// present in the store, never drawn) from a genuine sync gap.
const domState = (pg, needle) => pg.evaluate((needle) => {
	const out = document.getElementById('chat-output');
	const txt = out ? out.innerText : '';
	return {
		hasAnswer: new RegExp(needle, 'i').test(txt),
		stillWaiting: /sent to your other|other device/i.test(txt),
		spinner: !!document.querySelector('#chat-output .ti-spin, #chat-output .chat-spinner-dot'),
	};
}, needle);

let a, b;
try {
	// ── A: the phone, at desktop width for the rail control, narrowed later. ──
	a = await open({ name: 'hoflead', touch: true });
	await a.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro (the dispatch/presence path is not refused)', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	// ── B: a desktop peer, paired to the SAME account, connected + Pro. ─────
	b = await open({ name: 'hofmate', signIn: false, connect: false });
	// Capture B's console: the reconstruct-fail signature prints here.
	const bErrs = [];
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

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices of one account', !!idA && !!idB && idA !== idB,
		JSON.stringify({ idA, idB }));

	// B must be parked (listening) so it collects the errand.
	await until(b.page, () => {
		try { return (window.DaimondPost.state && window.DaimondPost.state().parks > 0)
			|| (window.DaimondPost.parks && window.DaimondPost.parks() > 0); } catch (e) { return false; }
	}, null, 8000);

	// Make sure A sees B awake before it decides to dispatch.
	await b.page.evaluate(() => window.DaimondSync.beatPresence
		&& window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(),
			(window.DaimondIdentity.displayName && window.DaimondIdentity.displayName()) || 'hofmate'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const aSeesB = await a.page.evaluate((self) =>
		(window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer', aSeesB >= 1, 'awake peers: ' + aSeesB);

	// ═══════════════════════════════════════════════════════════════════════
	// THE BRAND-NEW CHAT. A opens a chat B has never seen and dispatches its
	// FIRST turn. B has to pull-and-materialise the chat inside peerReconstruct.
	// ═══════════════════════════════════════════════════════════════════════
	console.log('\nBrand-new chat — A opens a fresh chat and dispatches its first turn');
	const newId = await newChat(a);
	check('A created a brand-new chat', !!newId, 'chat id: ' + newId);
	const bHadIt = await b.page.evaluate((id) => {
		try { return (window.DaimondCore && DaimondCore.chatResidency
			? DaimondCore.chatResidency() : []).some((c) => c.id === id); } catch (e) { return false; }
	}, newId);
	check('B does NOT already hold the brand-new chat (the receiver-materialise path)', !bHadIt,
		'B held it: ' + bHadIt);

	// Narrow A to a phone so the first turn auto-dispatches.
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);

	const PROMPT = 'NEWCHAT what is two plus two';
	await a.page.fill('#chat-input', PROMPT);
	await a.page.click('#chat-send', { force: true });
	await a.page.waitForTimeout(1000);

	// A must HAND OFF, not run locally. The dispatched placeholder is transient now --
	// the reconcile drops it the instant the peer's answer merges -- so the hand-off is
	// proven by PROVENANCE (the answer ran on B) as well as by catching the placeholder
	// while it still stands. Either is a pass; an answer that ran on A (ranOn === idA)
	// is the failure the check exists to catch.
	const aChats = await untilChats(a, (cs) => countDispatched(cs) >= 1
		|| answersMatching(cs, 'NEWCHAT').some((m) => String(m.ranOn) === String(idB)), 10000);
	const ranB = answersMatching(aChats, 'NEWCHAT').filter((m) => String(m.ranOn) === String(idB)).length;
	const ranA = answersMatching(aChats, 'NEWCHAT').filter((m) => String(m.ranOn) === String(idA)).length;
	check('A handed the first turn to the peer (did not run it locally)',
		(countDispatched(aChats) >= 1 || ranB >= 1) && ranA === 0,
		'dispatched=' + countDispatched(aChats) + ' ranOnB=' + ranB + ' ranOnA=' + ranA);

	// (1) DEFECT 1 — the runner runs the turn instead of claim-looping. Pre-fix
	//     this is RED: B throws "does not hold yet", releases, re-claims, loops.
	const bRan = await untilChats(b, (cs) => answersMatching(cs, 'NEWCHAT').length >= 1, RTMS);
	const bAnswers = answersMatching(bRan, 'NEWCHAT');
	const reconstructFailed = bErrs.filter((e) => /reconstruct failed/i.test(e)
		&& /does not hold yet/i.test(e));
	check('B RAN the dispatched turn in the brand-new chat (no reconstruct-fail claim-loop)',
		bAnswers.length >= 1,
		'B answers: ' + bAnswers.length + '; reconstruct-fail console lines: ' + reconstructFailed.length
		+ (reconstructFailed[0] ? ' e.g. ' + JSON.stringify(reconstructFailed[0]).slice(0, 90) : ''));

	// (2) The answer reaches A's STORE, then RENDERS on A — the store/DOM split
	//     that separates defect 2 (present, never drawn) from a sync gap.
	const aStore = await untilChats(a, (cs) => answersMatching(cs, 'NEWCHAT').length >= 1, RTMS);
	const inStore = answersMatching(aStore, 'NEWCHAT').length >= 1;
	check('the answer synced back into A\'s store', inStore,
		'answers in A store: ' + answersMatching(aStore, 'NEWCHAT').length);

	const rendered = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /NEWCHAT|two plus two|2\s*\+\s*2|\b4\b/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, RTMS);
	const ds = await domState(a.page, 'NEWCHAT|two plus two');
	check('A RENDERS the answer and clears the "sent to your other devices" spinner', rendered,
		JSON.stringify(ds));
	await settle(a.page);
	await shot(a, 'handoff_newchat');

	// Money-safety: exactly one answer for the turn, no double-run.
	const finalA = await storedChats(a);
	const oneAnswer = answersMatching(finalA, 'NEWCHAT').length;
	check('exactly one answer exists for the hand-off turn (no double-run)', oneAnswer === 1,
		'answers: ' + oneAnswer);

	// ═══════════════════════════════════════════════════════════════════════
	// (2) THE RECONSTRUCT RACE. peerReconstruct pulls the errand's parcel into
	//     the STORE, but `applyChats` fires `onChatsChangedElsewhere` WITHOUT
	//     awaiting it, so `chats[]` is rebuilt a beat later -- and the rebuild's
	//     first step is a real async IndexedDB summaries read (ChatStore.refresh).
	//     On a loaded phone that read had not finished when the runner read
	//     `chats[]`, so the brand-new chat was absent, reconstruct threw "the
	//     errand names a chat this device does not hold yet", released the lease,
	//     and the next device claimed and threw in turn -- the claim-loop.
	//
	//     In a fast single-machine world B usually pre-pulls the chat before it
	//     collects, so the race never shows. To make the real race deterministic
	//     we widen the window that already exists: B's ChatStore.refresh (the
	//     rebuild's IndexedDB read, and ONLY that) is delayed, exactly as a slow
	//     device would delay it. Nothing else is touched -- the same product code
	//     runs, only the async read it already awaits takes longer.
	console.log('\nReconstruct race — B\'s chats[] rebuild lags the errand (as on a loaded phone)');
	bErrs.length = 0;
	await b.page.evaluate(() => {
		const cs = window.DaimondCore.chatStore();
		if (!cs.__origRefresh) cs.__origRefresh = cs.refresh.bind(cs);
		cs.refresh = async function () {
			await new Promise((r) => setTimeout(r, 1200));   // the slow IndexedDB read
			return cs.__origRefresh();
		};
	});

	// Widen A back to desktop so the rail's new-chat control is on screen, make the
	// chat, then narrow to a phone again just before the dispatch (isPhoneViewport is
	// read at send-time, maybeAutoDispatch).
	await a.page.setViewportSize({ width: 1500, height: 950 });
	await a.page.waitForTimeout(300);
	const newId2 = await newChat(a);
	const bHadIt2 = await b.page.evaluate((id) => {
		try { return (window.DaimondCore.chatResidency() || []).some((c) => c.id === id); }
		catch (e) { return false; }
	}, newId2);
	check('B does NOT hold the second brand-new chat either', !bHadIt2, 'B held it: ' + bHadIt2);

	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	const PROMPT2 = 'RACECHAT what is three plus three';
	await a.page.fill('#chat-input', PROMPT2);
	await a.page.click('#chat-send', { force: true });
	await a.page.waitForTimeout(1000);

	// The runner must MATERIALISE the chat and run it, not throw + claim-loop.
	const bRan2 = await untilChats(b, (cs) => answersMatching(cs, 'RACECHAT').length >= 1, RTMS);
	const reconstructFail2 = bErrs.filter((e) => /reconstruct failed/i.test(e)
		&& /does not hold yet/i.test(e));
	check('B did NOT throw the reconstruct claim-loop (materialised the chat instead)',
		reconstructFail2.length === 0,
		'reconstruct-fail console lines: ' + reconstructFail2.length
		+ (reconstructFail2[0] ? ' e.g. ' + JSON.stringify(reconstructFail2[0]).slice(0, 90) : ''));
	check('B RAN the second turn once the chat was materialised',
		answersMatching(bRan2, 'RACECHAT').length >= 1,
		'B answers: ' + answersMatching(bRan2, 'RACECHAT').length);

	// The answer reaches A and renders, spinner cleared, exactly one answer.
	const aStore2 = await untilChats(a, (cs) => answersMatching(cs, 'RACECHAT').length >= 1, RTMS);
	const rendered2 = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /RACECHAT|three plus three|\b6\b/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, RTMS);
	await settle(a.page);
	check('A rendered the second answer with the spinner cleared', rendered2,
		JSON.stringify(await domState(a.page, 'RACECHAT|three plus three')));
	check('exactly one answer for the raced turn (no double-run through the retries)',
		answersMatching(aStore2, 'RACECHAT').length === 1,
		'answers: ' + answersMatching(aStore2, 'RACECHAT').length);

	// Restore B's refresh so teardown is clean.
	await b.page.evaluate(() => {
		try { const cs = window.DaimondCore.chatStore(); if (cs.__origRefresh) cs.refresh = cs.__origRefresh; }
		catch (e) {}
	});

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  FAILED: ' + l); }
process.exit(bad.length ? 1 : 0);
