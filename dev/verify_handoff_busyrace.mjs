// gateway: live
// verify_handoff_busyrace.mjs -- a runner busy before its beat says so hands the turn back (H1).
//
// WHAT HAPPENED (r543 QA, F-A1). A desktop that starts a turn of its own reads idle to
// every other device until its next 45 s beat. A chat sent in that window is seated on
// it; it collects the errand busy and answered with a `busy` report. No sender counted
// `busy` as a hand-back: the turn read as settled, the immediate fallback and the 95 s
// backstop both stood down, and the turn never ran. The tile said "couldn't finish".
//
// THE PROPERTIES:
//
//   (1) B going busy on a turn of its own beats at once, so A reads it busy inside
//       5 s, and B going idle again beats at once too (the window, mostly closed).
//   (2) THE RACE ITSELF, forced: B's beats are held back at the network, so A still
//       reads B idle when B is already running a long turn of its own. A seats B,
//       B hands the turn back, and A's turn reaches the model inside 5 s of the send,
//       its answer reaches A, and each turn reaches the model exactly once.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_busyrace.mjs

import {
	checker,
	pair,
	until,
	storedMsgs,
	placeholders,
	modelSaw,
	send,
	sendDesk,
	freshChat,
} from './handoffpair.mjs';

const EDGE_MS   = 5000;			// the bound on a busy or idle edge reaching A
const EDGE_SLOW = 12000;		// B's first local turn
const RACE_SLOW = 60000;		// B's second local turn, running through the race
const RUN_MS    = 5000;			// the bound on A's turn reaching the model
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

/// A's view of B's busy depth, after a fresh presence read; null when A holds no record.
const aViewBusy = (a, idB) => a.page.evaluate(async (id) => {
	try { await window.DaimondSync.refreshPresence(); } catch (e) { /* the snapshot stands */ }
	const r = window.DaimondPresence.snapshot()[id] || null;
	return r ? (r.busy == null ? -1 : r.busy | 0) : null;
}, idB).catch(() => null);

/// Wait until A reads B's busy depth as `want` (> 0 or 0); the ms it took, or -1.
async function aReads(a, idB, busy, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const v = await aViewBusy(a, idB);
		if (v != null && (busy ? v > 0 : v === 0)) return Date.now() - t0;
		await a.page.waitForTimeout(250);
	}
	return -1;
}

const sawUntil = async (pg, text, ms) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (modelSaw(text) > 0) return Date.now() - t0;
		await pg.waitForTimeout(100);
	}
	return -1;
};

let a, b;
try {
	({ a, b } = await pair(check, 'raceload', 'racemate'));
	for (const s of [a, b]) {
		await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'busyrace'); } catch (e) { /* none */ } });
	}
	const tag = Math.random().toString(36).slice(2, 8);
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());

	// ── (1) The busy and idle edges beat at once ────────────────
	console.log('\n(1) B goes busy on a turn of its own, then idle');
	await freshChat(b);
	const edge = '@slow ' + EDGE_SLOW + ' b edge turn ' + tag;
	await sendDesk(b.page, edge);
	check('(1) B is running its own turn', (await sawUntil(b.page, 'b edge turn ' + tag, 10000)) >= 0);
	const tBusy = await aReads(a, idB, true, EDGE_MS);
	check('(1) A reads B busy inside ' + EDGE_MS / 1000 + ' s', tBusy >= 0, tBusy >= 0 ? 'at +' + tBusy + 'ms' : 'still idle');
	const done = await until(b.page, () => {
		try { return !window.DaimondCore.busy(); } catch (e) { return false; }
	}, null, EDGE_SLOW + 20000);
	check('(1) B\'s own turn ended', done);
	const tIdle = done ? await aReads(a, idB, false, EDGE_MS) : -1;
	check('(1) and A reads B idle again inside ' + EDGE_MS / 1000 + ' s', tIdle >= 0, tIdle >= 0 ? 'at +' + tIdle + 'ms' : 'still busy');

	// ── (2) The race: B busy, its beat held back ─────────────────
	console.log('\n(2) B busy before any beat says so; A sends');
	// Every beat B sends from here is lost on the way, which is what the 45 s gap and a
	// slow relay do: A goes on reading B's last word, idle.
	await b.page.route(/[?&]presence=1/, (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
	await freshChat(b);
	const local = '@slow ' + RACE_SLOW + ' b local race turn ' + tag;
	await sendDesk(b.page, local);
	check('(2) B is running its own long turn', (await sawUntil(b.page, 'b local race turn ' + tag, 10000)) >= 0);
	const bBusy = await b.page.evaluate(() => { try { return window.DaimondCore.busy(); } catch (e) { return String(e); } });
	check('(2) B reads itself busy', bBusy === true, String(bBusy));
	if (bBusy !== true) {
		const dump = await b.page.evaluate(() => { try { return window.DaimondDiag.rows().slice(-40)
			.map((x) => String(x.tag) + ' | ' + String(x.data).slice(0, 160)); } catch (e) { return ['diag: ' + e]; } });
		for (const r of dump) console.log('  B tail ..', r);
	}
	const view = await aViewBusy(a, idB);
	check('(2) A still reads B idle', view === 0 || view === -1, 'busy=' + view);

	await freshChat(a);
	const second = 'race second chat ' + tag;
	const t0 = Date.now();
	await send(a.page, second);
	// When the model first sees it, timed from the send, watched apart from the checks below.
	let reachedAt = -1;
	const watch = (async () => {
		while (reachedAt < 0 && Date.now() - t0 < RUN_MS + ANSWER_MS) {
			if (modelSaw(second) > 0) reachedAt = Date.now() - t0;
			else await new Promise((r) => setTimeout(r, 100));
		}
	})();
	let ph = null;
	for (let i = 0; i < 60 && !ph; i++) {
		ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(tag)) || null;
		if (!ph) await a.page.waitForTimeout(100);
	}
	check('(2) A handed the chat to B', !!ph, ph ? 'tid=' + ph.iturn : 'ran locally (B not seated: the race was not forced)');
	const tid = ph ? String(ph.iturn) : '';
	const handed = tid ? await until(b.page, (t) => {
		try { return window.DaimondDiag.rows().some((r) => /collect busy/.test(r.tag) && String(r.data).includes(t)); } catch (e) { return false; }
	}, tid, 15000) : false;
	check('(2) B collected it busy and handed it back', handed);
	while (reachedAt < 0 && Date.now() - t0 < RUN_MS + 1000) await a.page.waitForTimeout(100);
	check('(2) A\'s turn reached the model inside ' + RUN_MS / 1000 + ' s of the send', reachedAt >= 0 && reachedAt <= RUN_MS,
		reachedAt >= 0 ? 'at +' + reachedAt + 'ms' : 'not inside ' + (RUN_MS + 1000) + 'ms');
	let ans = false;
	for (const tA = Date.now(); !ans && Date.now() - tA < ANSWER_MS;) {
		ans = await answered(a, second);
		if (!ans) await a.page.waitForTimeout(500);
	}
	check('(2) its answer reached A', !!ans);
	await watch;
	check('(2) A\'s turn reached the model exactly once', modelSaw(second) === 1, 'seen ' + modelSaw(second));
	check('(2) and B\'s own turn exactly once', modelSaw('b local race turn ' + tag) === 1, 'seen ' + modelSaw('b local race turn ' + tag));
	if (bad.length) {
		const rows = (s, re) => s.page.evaluate((src) => {
			const r = new RegExp(src);
			try { return window.DaimondDiag.rows().filter((x) => r.test(String(x.tag)))
				.map((x) => String(x.tag) + ' | ' + String(x.data).slice(0, 200)); } catch (e) { return ['diag: ' + e]; }
		}, re.source).catch((e) => ['eval: ' + e]);
		for (const r of await rows(a, /handoff|fallback|recover|elect|handback/)) console.log('  A ..', r);
		for (const r of await rows(b, /collect/)) console.log('  B ..', r);
	}
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
}
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
