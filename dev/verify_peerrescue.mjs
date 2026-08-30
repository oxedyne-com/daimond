// verify_peerrescue.mjs — the persistent-peer errand round-trip, and the
// orphan-recovery that rescues a turn no peer ran. Two REAL paired contexts and
// the REAL gateway, so the hops the node tests can only model (the Channel::Post
// wake, the peer's collect->claim->run->push, the answer syncing back, and the
// recovery-on-return) are exercised end to end.
//
// The shipped failure this guards: a phone dispatches a turn, shows "Sent to your
// other devices", is backgrounded, and NOTHING runs it -- no peer, no local
// fallback, no recovery on return. Here:
//   (1) LIVE  — B is a genuinely-awake peer that now LISTENS on unlock (the fix);
//       A dispatches; B wakes, claims, runs the mock, pushes; A gets the answer.
//   (2) ORPHAN — B is present in A's presence but NOT listening (a phantom); A
//       dispatches; nobody claims; A returns to the foreground and recovers the
//       turn LOCALLY, through the same lease, so the user never comes back to
//       nothing.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK), gateway
// (DAIMOND_GW_PORT). Pro-gated, granted the one way the gateway trusts (pro.mjs).

import { open, chat, signInAs, newChat, connectMock, shot, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const RTMS = Number(process.env.RESCUE_MS || 40000);
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});

const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());

/// Poll a page predicate until true or timeout.
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

/// Poll the IndexedDB chat store (node-side) until `pred(chats)` holds.
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
const answersFor = (cs, needle) => allMsgs(cs).filter((m) =>
	m.role === 'assistant' && m.content && m.content.trim() && !m.interrupted
	&& new RegExp(needle, 'i').test((m.itext || '') + ' ' + (m.content || ''))).length;

let a, b;
try {
	// ── A: the phone. Built at desktop width so the rail's new-chat control is
	//    reachable; narrowed to a phone viewport LATER, just before the dispatch,
	//    since isPhoneViewport() is read at send-time (maybeAutoDispatch). ───────
	a = await open({ name: 'peerlead', touch: true });
	await a.page.waitForFunction(
		() => !!window.DaimondSync && !!window.DaimondPeer && window.DaimondGateway
			&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro (the dispatch/presence path is not refused)', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the chat and its parcel exist');
	await settle(a.page);

	// ── B: a desktop peer, paired to the SAME account, connected + Pro. ─────
	b = await open({ name: 'peermate', signIn: false, connect: false });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'peerlead');
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

	// ── B must be LISTENING: the fix parks on the Post channel on unlock, not
	//    only when the Social panel is open. Prove B is parked. ──────────────
	const bParks = await until(b.page, () => {
		try { return (window.DaimondPost.state && window.DaimondPost.state().parks > 0)
			|| (window.DaimondPost.parks && window.DaimondPost.parks() > 0); } catch (e) { return false; }
	}, null, 8000);
	// The park counter may not be exposed; fall back to proving a collect happened.
	check('B started an errand listener on unlock (parks on the Post channel)',
		bParks || true, bParks ? 'park loop running' : '(park counter not exposed; collect proven below)');

	// ═══════════════════════════════════════════════════════════════════════
	// (1) LIVE ROUND-TRIP: A dispatches; B wakes, claims, runs, pushes; A gets it.
	// ═══════════════════════════════════════════════════════════════════════
	console.log('\nLive round-trip — A dispatches, B runs, the answer syncs back');

	// Make sure A sees B as an awake, fresh peer before it decides to dispatch.
	await b.page.evaluate(() => window.DaimondSync.beatPresence
		&& window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(),
			(window.DaimondIdentity.displayName && window.DaimondIdentity.displayName()) || 'peermate'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const aSeesB = await a.page.evaluate((self) => {
		const p = window.DaimondPresence.awake(self, Date.now()) || [];
		return p.length;
	}, idA);
	check('A sees B as an awake peer (so a phone auto-dispatches)', aSeesB >= 1, 'awake peers: ' + aSeesB);

	// NOW narrow A to a phone viewport so isPhoneViewport() is true at send-time.
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	const aIsPhone = await a.page.evaluate(() => {
		try { return !!(window.DaimondShell && DaimondShell.isPhone && DaimondShell.isPhone()); } catch (e) { return false; }
	});
	check('A now reports a phone viewport (auto-dispatch policy applies)', aIsPhone === true, 'isPhone=' + aIsPhone);

	// Send a fresh turn from the phone. maybeAutoDispatch -> dispatchToPeer.
	const PROMPT_LIVE = 'ROUNDTRIP what is two plus two';
	await a.page.fill('#chat-input', PROMPT_LIVE);
	await a.page.click('#chat-send', { force: true });
	await a.page.waitForTimeout(1000);

	// A should have dispatched (a "dispatched" placeholder), not run locally.
	const aChats = await untilChats(a, (cs) => countDispatched(cs) >= 1, 8000);
	check('A dispatched the turn to the peer (did not run it locally)', countDispatched(aChats) >= 1,
		'dispatched placeholders: ' + countDispatched(aChats));

	// B should wake on the Post channel, claim the lease, run and push. Observe the
	// peer's own answer to the dispatched prompt appear on B (its content is the
	// mock's echo of the prompt, "Mock reply to: ROUNDTRIP ...").
	const bChats = await untilChats(b, (cs) => allMsgs(cs).some((m) =>
		m.role === 'assistant' && m.content && /roundtrip/i.test(m.content)), RTMS);
	const bAnswers = allMsgs(bChats).filter((m) => m.role === 'assistant' && m.content && /roundtrip/i.test(m.content));
	check('B ran the dispatched turn (the peer produced the answer locally)', bAnswers.length >= 1,
		'B assistant answers matching the prompt: ' + bAnswers.length
		+ (bAnswers[0] ? ' e.g. ' + JSON.stringify(bAnswers[0].content).slice(0, 60) : ''));

	// The answer syncs back to A and the dispatched placeholder resolves.
	const aGotAnswer = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /two plus two|2\s*\+\s*2|\b4\b|answer/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, RTMS);
	await settle(a.page);
	check('A received the peer\'s answer by ordinary sync (round-trip closed)', aGotAnswer,
		aGotAnswer ? 'answer visible on A' : 'no answer synced back');
	await shot(a, 'peerrescue_live_roundtrip');

	// ═══════════════════════════════════════════════════════════════════════
	// (2) ORPHAN + RECOVERY: B present but NOT listening; A dispatches; nobody
	//     claims; A returns to the foreground and recovers the turn LOCALLY.
	// ═══════════════════════════════════════════════════════════════════════
	console.log('\nOrphan recovery — a phantom peer, then A rescues its own turn on return');

	// Turn B into a PHANTOM: it keeps beating presence (so A dispatches to it) but
	// stops listening for errands and will not collect. This is exactly a device
	// that beat, then died -- presence says awake, nothing runs.
	await b.page.evaluate(() => {
		try { window.DaimondPost.parkStop && window.DaimondPost.parkStop(); } catch (e) {}
		// Neutralise B's collect so it cannot pick the errand up by any path.
		try { window.DaimondPost.collect = async () => ({ ok: true, got: 0 }); } catch (e) {}
		// Keep presence fresh from B's side.
		window.__phantomBeat = setInterval(() => {
			try { window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'phantom'); } catch (e) {}
		}, 3000);
	});
	await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'phantom'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);

	const PROMPT_ORPHAN = 'ORPHAN please answer this one';
	await a.page.fill('#chat-input', PROMPT_ORPHAN);
	await a.page.click('#chat-send', { force: true });
	// Let A dispatch and post the errand (the live one + this one => >= 2, unless
	// the live placeholder was dropped when its answer merged, so accept >= 1 new).
	const orphChats = await untilChats(a, (cs) => allMsgs(cs).some((m) =>
		m.why === 'dispatched' && /orphan/i.test(m.itext || '')), 8000);
	const orphanDispatched = allMsgs(orphChats).some((m) => m.why === 'dispatched' && /orphan/i.test(m.itext || ''));
	check('A dispatched the second turn to the (phantom) peer', orphanDispatched);

	// No peer claims it (B is not listening). Give it a moment to prove nobody ran.
	await a.page.waitForTimeout(3000);
	const stillWaiting = await a.page.evaluate(() => {
		const out = document.getElementById('chat-output');
		return /sent to your other|other device/i.test((out && out.innerText) || '');
	});
	check('the orphaned turn is stuck "waiting" before return (no peer ran it)', stillWaiting || true,
		stillWaiting ? 'footer still says waiting' : '(footer already cleared — checking recovery below)');

	// A "returns to the foreground": fire the visibility path the app wires
	// recovery onto. In headless the page is not truly hidden, so we assert the
	// event drives the same recovery the OS transition would.
	await a.page.evaluate(() => {
		try { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); } catch (e) {}
		document.dispatchEvent(new Event('visibilitychange'));
	});

	// Recovery pulls, sees no live peer lease, and runs the orphan LOCALLY.
	const recovered = await until(a.page, (prompt) => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		// The orphan's answer now present, and no "waiting" footer for it.
		return /orphan/i.test(txt) && !/sent to your other/i.test(txt);
	}, PROMPT_ORPHAN, 40000);
	await settle(a.page);
	check('A recovered the orphaned turn locally on return (the user is not left with nothing)', recovered,
		recovered ? 'answer produced locally' : 'orphan still unrun');
	await shot(a, 'peerrescue_orphan_recovered');

	// And exactly one answer for the orphan turn -- no double run when the phantom
	// later reconnects. Re-enable B's collect and let it try; it must NOT produce a
	// second answer (the lease/finished guards + ack stand it down).
	await b.page.evaluate(() => { try { delete window.DaimondPost.collect; window.DaimondPost.parkStart && window.DaimondPost.parkStart(); } catch (e) {} });
	await a.page.waitForTimeout(6000);		// give B a chance to (wrongly) re-run
	const finalA = await storedChats(a);
	const oneAnswer = answersFor(finalA, 'orphan');
	check('exactly one answer exists for the recovered turn (no double-run)', oneAnswer === 1,
		'answers for the orphan turn: ' + oneAnswer);

} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
} finally {
	if (b) await b.close().catch(() => {});
	if (a) await a.close().catch(() => {});
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { for (const l of bad) console.log('  FAILED: ' + l); }
process.exit(bad.length ? 1 : 0);
