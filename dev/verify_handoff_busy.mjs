// gateway: live
// verify_handoff_busy.mjs — a second chat is not handed to a machine already running one (H1).
//
// WHAT HAPPENED (r540 C1). A desk running a handed-off turn collects the next errand
// only when that turn ends. The election seated it anyway -- 28% of elections chose a
// device whose beat said busy -- so a second chat sent seconds after the first sat on
// the relay until the sender's ~100 s backstop gave up and ran it locally.
//
// THE PROPERTIES:
//
//   (1) A hands B a long first turn (`@slow`), and B claims it.
//   (2) A SECOND CHAT, sent while B is running the first, reaches the model inside
//       5 s -- not after the ~100 s backstop -- and its answer reaches A.
//   (3) Each turn reaches the model exactly once (nothing ran twice).
//
// Holds whether or not the gateway relays the beat's `busy`: A also sees B's live
// claim on the first turn, which is what passes B over the moment the claim lands.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_busy.mjs

import {
	checker,
	pair,
	until,
	storedMsgs,
	placeholders,
	modelSaw,
	send,
	freshChat,
} from './handoffpair.mjs';

const SLOW_MS   = 30000;		// the first turn's length on B
const CLAIM_MS  = 30000;		// B claims the first turn this soon
const SECOND_MS = 5000;			// the bound on the second chat reaching the model
const ANSWER_MS = 20000;		// and its answer reaching A's store
const { ok, bad, check } = checker();

/// Does A hold a non-empty answer after the user message `prompt`, in its chat?
const answered = (a, prompt) => a.page.evaluate(async (p) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		const ms = (got && got.messages) || [];
		const at = ms.findIndex((m) => m && m.role === 'user' && String(m.content || '').includes(p));
		if (at < 0) continue;
		return ms.slice(at + 1).some((m) => m && m.role === 'assistant' && !m.interrupted
			&& String(m.content || '').trim());
	}
	return false;
}, prompt).catch(() => false);

let a, b;
try {
	({ a, b } = await pair(check, 'busylead', 'busymate'));
	for (const s of [a, b]) {
		await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'busy'); } catch (e) { /* none */ } });
	}

	// ── (1) The first, long turn goes to B ─────────────────────
	console.log('\n(1) A hands B a long first turn');
	const tag = Math.random().toString(36).slice(2, 8);
	const first = '@slow ' + SLOW_MS + ' first busy turn ' + tag;
	await freshChat(a);
	const sent1 = Date.now();
	await send(a.page, first);
	let ph = null;
	for (let i = 0; i < 120 && !ph; i++) {
		ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(tag)) || null;
		if (!ph) await a.page.waitForTimeout(250);
	}
	const tid = ph ? String(ph.iturn) : '';
	check('(1) A handed the first turn off', !!tid, tid || 'no dispatched placeholder');
	const claimed = tid ? await until(b.page, (t) => {
		try { return window.DaimondDiag.rows().some((r) => r.tag === 'collect CLAIMED' && String(r.data).includes(t)); }
		catch (e) { return false; }
	}, tid, CLAIM_MS) : false;
	check('(1) B claimed it', claimed, claimed ? 'at +' + (Date.now() - sent1) + 'ms' : 'no claim in ' + CLAIM_MS + 'ms');
	// The person sends the second chat a few seconds later; by then A has seen B's claim.
	const seen = tid ? await until(a.page, (t) => {
		try { return !!window.DaimondLease.holder(t); } catch (e) { return false; }
	}, tid, 15000) : false;
	check('(1) A sees B holding the first turn', seen);

	// ── (2) The second chat does not wait on B ─────────────────
	console.log('\n(2) A sends a second chat while B is busy');
	const second = 'second busy chat ' + tag;
	await freshChat(a);
	const sent2 = Date.now();
	await send(a.page, second);
	let reached = 0;
	while (!reached && Date.now() - sent2 < SECOND_MS + 20000) {
		if (modelSaw(second) > 0) reached = Date.now() - sent2;
		else await a.page.waitForTimeout(200);
	}
	check('(2) the second chat reached the model inside ' + (SECOND_MS / 1000) + ' s',
		reached > 0 && reached <= SECOND_MS, reached ? 'at +' + reached + 'ms' : 'not at all');
	let got2 = false;
	for (const t0 = Date.now(); !got2 && Date.now() - t0 < ANSWER_MS; ) {
		got2 = await answered(a, second);
		if (!got2) await a.page.waitForTimeout(500);
	}
	check('(2) and its answer reached A', got2);
	const elect = await a.page.evaluate((s) => {
		try {
			return window.DaimondDiag.rows().filter((r) => String(r.tag).includes('handoff') || String(r.tag).includes('elect'))
				.map((r) => String(r.tag) + ' ' + String(r.data).slice(0, 160)).slice(-3);
		} catch (e) { return []; }
	}, second).catch(() => []);
	for (const e of elect) console.log('  ..    ' + e);

	// ── (3) Exactly once each ──────────────────────────────────
	console.log('\n(3) each turn ran once');
	const done1 = await (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < SLOW_MS + 30000) {
			if (await answered(a, 'first busy turn ' + tag)) return true;
			await a.page.waitForTimeout(1000);
		}
		return false;
	})();
	check('(3) the first turn still finished', done1);
	check('(3) the first turn reached the model once', modelSaw('first busy turn ' + tag) === 1, 'seen ' + modelSaw('first busy turn ' + tag));
	check('(3) the second chat reached the model once', modelSaw(second) === 1, 'seen ' + modelSaw(second));
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
