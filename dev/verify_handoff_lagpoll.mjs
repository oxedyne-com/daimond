// gateway: live
// verify_handoff_lagpoll.mjs -- a turn run on A reaches B inside 60 s while B is on the
// poll fallback with the chat closed (LAG-1).
//
// WHAT HAPPENED. 30 Oct 2026 (alarm lag-a7b34e2): a turn run on argonaut reached gilgamesh
// only with argonaut's next parcel, +190 s. A device on the poll fallback (an iOS PWA whose
// socket is down) parked without asking for log taps, and the gateway's park never listened
// on the log door, so the chat log batch that carried the turn woke nobody there.
//
// THE PROPERTY. B parks plain requests (`wakeVia('poll')`), holds A's chat on its rail but
// has another chat open. A runs a turn itself (no nominee). The user row and its answer reach
// B's store inside 60 s of the send. The timings are printed (`LAGPOLL ...`) so a run at the
// base can be read beside one after.
//
// THE PARCEL IS WITHHELD. In the dev world A pushes its parcel the moment a short turn ends, B's plain
// park wakes on its version and B pulls the turn with it, so the base passed too (LAG-1e, 31 Oct, 5.7 s
// on both). Live, argonaut's parcel came 190 s later. So A's parcel push (a plain POST /api/sync, no
// query) is aborted for LAGPOLL_PARCEL_HOLD_MS from the send, the live gap, and A retries it on its
// ladder after. Inside the hold only the log lane (POST /api/sync?log=…) can carry the turn: the base
// reads about the hold, the fix seconds. Withholding B's pull instead was not the live case: B's park
// woke on A's version and B then retried the pull without parking again (B parked 0 times in 90 s).
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   DAIMOND_WAKE=poll node dev/verify_handoff_lagpoll.mjs

import {
	checker,
	pair,
	reload,
	settle,
	until
} from './handoffpair.mjs';
import { chat, newChat } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const REACH_MS = 60000;		// the bound: A's turn in B's store
const WATCH_MS = Number(process.env.LAGPOLL_WATCH_MS || 300000);	// how long a run at the base is watched
const HOLD_MS  = Number(process.env.LAGPOLL_PARCEL_HOLD_MS || 190000);	// A's parcel push withheld this long: the live lag (lag-a7b34e2)
const { ok, bad, check } = checker();

/// When B's store holds the user row carrying `p`, and when its answer, in ms since `t0`.
/// Zero for one not yet held.
const heldAt = (b, chatId, p) => b.page.evaluate(async ({ id, p }) => {
	const cs = window.DaimondCore.chatStore();
	let got = null;
	try { got = await cs.loadMessages(id); } catch (e) { got = null; }
	const ms = (got && got.messages) || [];
	const at = ms.findIndex((m) => m && m.role === 'user' && String(m.content || '').includes(p));
	if (at < 0) return { user: false, answer: false };
	return { user: true, answer: ms.slice(at + 1).some((m) => m && m.role === 'assistant'
		&& !m.provisional && String(m.content || '').trim()) };
}, { id: chatId, p }).catch(() => ({ user: false, answer: false }));

let a = null, b = null;
try {
	const tag = Date.now().toString(36);
	const pr = await pair(check, 'lagpa' + tag.slice(-4), 'lagpb' + tag.slice(-4), { nominate: false });
	a = pr.a; b = pr.b;

	// A's chat, with a first turn run on A, so B's rail holds it.
	const chatId = await newChat(a);
	check('A opened a chat', !!chatId, 'chat: ' + chatId);
	await chat(a, 'lagpoll seed ' + tag, { timeout: 60000 });
	await settle(a.page);
	await a.page.evaluate(() => window.DaimondSync.flush && window.DaimondSync.flush()).catch(() => {});

	// B boots again, which reads the parcel and so the chat onto its rail; then it opens
	// another chat, so A's is closed there, and parks plain requests.
	await reload(b);
	const onRail = await until(b.page, (id) => window.DaimondCore.chatStore().stored().some((s) => s.id === id),
		chatId, 120000, 1000);
	check('B holds A\'s chat on its rail', onRail);
	const other = await newChat(b);
	await b.page.evaluate(() => window.DaimondSync.wakeVia('poll'));
	const view = await b.page.evaluate((id) => {
		let res = null;
		try { res = (window.DaimondCore.chatResidency() || []).find((c) => c.id === id) || null; } catch (e) { res = null; }
		return { mode: window.DaimondSync.wake().mode, res };
	}, chatId);
	check('B is on the poll fallback', view.mode === 'poll', JSON.stringify(view));
	check('B has another chat open, A\'s closed', !!other && other !== chatId, 'open: ' + other);
	console.log('  .. B\'s view of A\'s chat: ' + JSON.stringify(view.res));
	await until(b.page, () => { try { return window.DaimondPost.state().parks > 0; } catch (e) { return false; } },
		null, 15000);
	await b.page.waitForTimeout(3000);	// the park re-armed on poll, asking its log taps

	// The turn on A, and the watch on B, with A's parcel push withheld for the live gap.
	const prompt = 'lagpoll turn ' + tag;
	let held = 0, firstHeld = 0;	// A's parcel pushes aborted, and when the first was
	const t0 = Date.now();
	const plain = (req, m) => {
		if (req.method() !== m) return false;
		try { const u = new URL(req.url()); return u.pathname.endsWith('/api/sync') && u.search === ''; }
		catch (e) { return false; }
	};
	await a.page.route('**/api/sync*', (route) => {
		if (Date.now() - t0 < HOLD_MS && plain(route.request(), 'POST')) {
			if (!held) firstHeld = Date.now() - t0;
			held++;
			return route.abort();
		}
		return route.continue();
	});
	// B's sync requests in the watch, by kind, printed with the timings: a red names which door was quiet.
	const seen = { park: 0, parklog: 0, logread: 0, pull: 0, other: 0 };
	const kind = (req) => {
		try {
			const q = new URL(req.url()).searchParams;
			if (q.has('above')) return q.get('log') === '1' ? 'parklog' : 'park';
			if (q.has('log')) return 'logread';
			return plain(req, 'GET') ? 'pull' : 'other';
		} catch (e) { return 'other'; }
	};
	await b.page.route('**/api/sync*', (route) => { seen[kind(route.request())]++; return route.continue(); });
	await chat(a, prompt, { timeout: 60000 });
	const tA = Date.now() - t0;
	let tUser = 0, tAns = 0;
	while (Date.now() - t0 < WATCH_MS && !tAns) {
		const h = await heldAt(b, chatId, prompt);
		const now = Date.now() - t0;
		if (h.user && !tUser) tUser = now;
		if (h.answer) tAns = now;
		if (!tAns) await b.page.waitForTimeout(500);
	}
	// THE HOLD MUST BE SEEN TO BITE, even when B had the turn first: a B that reads the turn before
	// A has pushed any parcel proves nothing unless A's parcel push then comes and is withheld (LAG-1f's
	// first head run read 750 ms with none aborted, the watch ended before A pushed). So the watch
	// goes on until A's first parcel push is aborted, or the hold ends.
	while (!held && Date.now() - t0 < HOLD_MS) await b.page.waitForTimeout(500);
	console.log('LAGPOLL first_held_ms=' + (firstHeld || 'none') + ' a_answer_ms=' + tA + ' b_user_ms=' + (tUser || 'none') + ' b_answer_ms=' + (tAns || 'none')
		+ ' watch_ms=' + WATCH_MS + ' parcel_hold_ms=' + HOLD_MS + ' parcel_pushes_withheld=' + held + ' b_sync=' + JSON.stringify(seen));
	check('A\'s parcel push was withheld (the hold bit)', held > 0,
		'aborted: ' + held + ', the first at ' + (firstHeld || 'never') + ' ms');
	// Inside the hold no parcel of A's reached the gateway, so a B that had the turn before it ended
	// had it by the log lane.
	check('B had the turn inside the hold, so not by A\'s parcel', held > 0 && tAns > 0 && tAns < HOLD_MS,
		'B at ' + (tAns || 'never') + ' ms, hold ' + HOLD_MS + ' ms');
	check('A\'s user row reached B inside 60 s', tUser > 0 && tUser < REACH_MS, 'at ' + (tUser || 'never') + ' ms');
	check('its answer reached B inside 60 s', tAns > 0 && tAns < REACH_MS, 'at ' + (tAns || 'never') + ' ms');
	if (bad.length || process.env.LAGPOLL_DUMP) {
		const rows = await b.page.evaluate(() => {
			try { return window.DaimondDiag.rows().filter((x) => /wake|park|log|arrive/.test(String(x.tag)))
				.map((x) => x.a + ' ' + String(x.tag) + ' | ' + String(x.data).slice(0, 200)); } catch (e) { return ['diag: ' + e]; }
		}).catch((e) => ['eval: ' + e]);
		for (const r of rows.slice(-30)) console.log('  B ..', r);
	}
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
} finally {
	try { await a?.close(); } catch (e) { /* gone */ }
	try { await b?.close(); } catch (e) { /* gone */ }
}
guardRan(ok.length + bad.length);
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
