// gateway: live
// verify_handoff_mutualhold.mjs -- two busy desktops that read each other idle do not hold
// a turn for each other (r545, Q22).
//
// WHAT HAPPENED. A desktop that starts a turn of its own reads idle to every other device
// until its next beat lands. With no nominee, B and C both busy, and each reading the other
// idle, a turn A sent was collected busy by both, and each held the row for the other, the
// idle desk it could see. Neither handed it back, so `tried` (Q19) never grew, and A waited
// out its 95 s backstop before running the turn itself.
//
// THE PROPERTY. The busy desks break the tie in one order both compute alike (peer.js
// `busyHoldsFor`): the first in id order hands the turn back, A re-seats it with that desk
// in `tried`, the second then hands back too, and A runs it -- inside 15 s of the send, not
// 95 s. Exactly one run, and the answer reaches A.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_mutualhold.mjs

import {
	checker,
	pair,
	storedMsgs,
	placeholders,
	modelSaw,
	send,
	sendDesk,
	freshChat,
	third,
} from './handoffpair.mjs';

const OWN_SLOW  = 120000;		// B's and C's own turns, running through the send
const RUN_MS    = 15000;		// the bound on A's turn reaching the model
const ANSWER_MS = 30000;		// and its answer reaching A's store
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
		return ms.slice(at + 1).some((m) => m && m.role === 'assistant' && !m.interrupted && !m.provisional
			&& String(m.content || '').trim());
	}
	return false;
}, prompt).catch(() => false);

/// A's view of a device's busy depth, after a fresh presence read; null when A holds no record.
const aViewBusy = (a, id) => a.page.evaluate(async (d) => {
	try { await window.DaimondSync.refreshPresence(); } catch (e) { /* the snapshot stands */ }
	const r = window.DaimondPresence.snapshot()[d] || null;
	return r ? (r.busy == null ? -1 : r.busy | 0) : null;
}, id).catch(() => null);

const sawUntil = async (pg, text, ms) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (modelSaw(text) > 0) return Date.now() - t0;
		await pg.waitForTimeout(100);
	}
	return -1;
};

/// The `collect busy` rows a device logged for a turn.
const busyRows = (s, tid) => s.page.evaluate((t) => {
	try { return window.DaimondDiag.rows().filter((r) => /collect busy/.test(r.tag) && String(r.data).includes(t))
		.map((r) => String(r.data)); } catch (e) { return []; }
}, tid).catch(() => []);

let a, b, c;
try {
	({ a, b } = await pair(check, 'mutualload', 'mutualb'));
	c = await third(check, a, 'mutualc');
	for (const s of [a, b, c]) {
		await s.page.evaluate(() => { try { window.DaimondDiag.set(true, 'mutualhold'); } catch (e) { /* none */ } });
	}
	const tag = Math.random().toString(36).slice(2, 8);
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	const idC = await c.page.evaluate(() => window.DaimondIdentity.deviceId());

	console.log('\nB and C both busy, each read idle, no nominee; A sends');
	for (const s of [a, b, c]) await s.page.evaluate(() => window.DaimondCore.roster.nominate(''));
	const noms = [];
	for (const s of [a, b, c]) noms.push(await s.page.evaluate(() => window.DaimondCore.roster.nominee()));
	check('no device names a nominee', noms.every((x) => !x), noms.map((x) => String(x || '-').slice(0, 8)).join(','));
	// A fresh idle beat from each, then every later beat lost on the way: the 45 s gap.
	for (const [s, n] of [[b, 'mutualb'], [c, 'mutualc']]) {
		await s.page.evaluate((nm) => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), nm), n);
		await s.page.route(/[?&]presence=1/, (r) => (r.request().method() === 'POST' ? r.abort() : r.continue()));
	}
	for (const [s, w] of [[b, 'b mutual turn '], [c, 'c mutual turn ']]) {
		await freshChat(s);
		await sendDesk(s.page, '@slow ' + OWN_SLOW + ' ' + w + tag);
	}
	check('B is running a turn of its own', (await sawUntil(b.page, 'b mutual turn ' + tag, 10000)) >= 0);
	check('C is running a turn of its own', (await sawUntil(c.page, 'c mutual turn ' + tag, 10000)) >= 0);
	const bBusy = await b.page.evaluate(() => { try { return window.DaimondCore.busy(); } catch (e) { return String(e); } });
	const cBusy = await c.page.evaluate(() => { try { return window.DaimondCore.busy(); } catch (e) { return String(e); } });
	check('B and C each read themselves busy', bBusy === true && cBusy === true, 'B=' + bBusy + ' C=' + cBusy);
	const vB = await aViewBusy(a, idB), vC = await aViewBusy(a, idC);
	check('A still reads both idle', (vB === 0 || vB === -1) && (vC === 0 || vC === -1), 'B=' + vB + ' C=' + vC);

	await freshChat(a);
	const prompt = 'mutual hold chat ' + tag;
	const t0 = Date.now();
	await send(a.page, prompt);
	let at = -1;
	const watch = (async () => {
		while (at < 0 && Date.now() - t0 < RUN_MS + ANSWER_MS + 100000) {
			if (modelSaw(prompt) > 0) at = Date.now() - t0;
			else await new Promise((r) => setTimeout(r, 100));
		}
	})();
	let ph = null;
	for (let i = 0; i < 60 && !ph; i++) {
		ph = placeholders(await storedMsgs(a)).find((m) => String(m.itext || '').includes(prompt)) || null;
		if (!ph) await a.page.waitForTimeout(100);
	}
	check('A handed the chat off', !!ph, ph ? 'tid=' + ph.iturn + ' to=' + String(ph.toDevice || '').slice(0, 8) : 'ran locally');
	const tid = ph ? String(ph.iturn) : '';
	let collected = false;
	for (const tB = Date.now(); tid && !collected && Date.now() - tB < 15000;) {
		collected = (await busyRows(b, tid)).length > 0 && (await busyRows(c, tid)).length > 0;
		if (!collected) await a.page.waitForTimeout(250);
	}
	check('B and C both collected it busy', collected);
	while (at < 0 && Date.now() - t0 < RUN_MS + 1000) await a.page.waitForTimeout(100);
	check('A\'s turn reached the model inside ' + RUN_MS / 1000 + ' s of the send, not at the 95 s backstop',
		at >= 0 && at <= RUN_MS, at >= 0 ? 'at +' + at + 'ms' : 'not inside ' + (RUN_MS + 1000) + 'ms');
	const rowsB = tid ? await busyRows(b, tid) : [], rowsC = tid ? await busyRows(c, tid) : [];
	const first = idB < idC ? 'B' : 'C';
	const handedBack = (rs) => rs.some((r) => /ANSWER busy/.test(r));
	check('the first in id order (' + first + ') handed it back rather than hold',
		handedBack(first === 'B' ? rowsB : rowsC), 'B: ' + rowsB.join(' / ').slice(0, 160) + ' || C: ' + rowsC.join(' / ').slice(0, 160));
	let ans = false;
	for (const tA = Date.now(); !ans && Date.now() - tA < ANSWER_MS + 100000;) {
		ans = await answered(a, prompt);
		if (!ans) await a.page.waitForTimeout(500);
	}
	check('its answer reached A', !!ans);
	await watch;
	check('A\'s turn reached the model exactly once', modelSaw(prompt) === 1, 'seen ' + modelSaw(prompt));
	check('B\'s and C\'s own turns ran once each', modelSaw('b mutual turn ' + tag) === 1 && modelSaw('c mutual turn ' + tag) === 1,
		'B ' + modelSaw('b mutual turn ' + tag) + ', C ' + modelSaw('c mutual turn ' + tag));
	if (bad.length || process.env.MUTUAL_DUMP) {
		const rows = (s, re) => s.page.evaluate((src) => {
			const r = new RegExp(src);
			try { return window.DaimondDiag.rows().filter((x) => r.test(String(x.tag)))
				.map((x) => x.a + ' ' + String(x.tag) + ' | ' + String(x.data).slice(0, 200)); } catch (e) { return ['diag: ' + e]; }
		}, re.source).catch((e) => ['eval: ' + e]);
		for (const r of (await rows(a, /handoff|fallback|recover|handback|retry|collect|local|lease/)).slice(-40)) console.log('  A ..', r);
		for (const r of (await rows(b, /collect/)).slice(-15)) console.log('  B ..', r);
		for (const r of (await rows(c, /collect/)).slice(-15)) console.log('  C ..', r);
	}
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
	try { await c?.close(); } catch (e) { /* gone */ }
}
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
