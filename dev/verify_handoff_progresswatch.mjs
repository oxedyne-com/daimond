// verify_handoff_progresswatch.mjs — watching handed-off turns holds no connection
// per turn, and stops for a turn nothing can answer.
//
// WHAT HAPPENED. On 2026-09-22 gilgamesh logged 2,534 aborted `/api/sync` reads and
// its parcel pulls slowed from 0.23 s to 10.7 s for twelve hours. Every watched
// hand-off parked a 25 s read of its own at the progress door, the front door is
// HTTP/1.1 (six connections per origin in Chrome), and `rebuildDispatchedIndex`
// re-watched a hand-off that never returned after every reload, for ever. See
// ~/usr/code/ai/claude/specs/daimond_gilgamesh_sync_aborts_20260923.md.
//
// THE THREE PROPERTIES, each of which is false of 48aa5913:
//
//   (a) ONE HELD REQUEST AT MOST. With three hand-offs outstanding and watched, the
//       device never holds more than one long-lived `/api/sync` request -- the wake
//       park, where the channel is not a socket -- however many turns it watches.
//   (b) A STALE HAND-OFF IS NOT WATCHED AFTER A RELOAD. Placeholders sent twenty
//       minutes ago, past their errand deadline with no device holding them, are not
//       read at the progress door at all once A has reloaded and rebuilt its index.
//   (c) LIVE PROGRESS STILL ARRIVES. A real hand-off run by a paired device streams
//       onto the dispatcher's screen before the answer lands, and no read of the
//       progress door asks the gateway to park: the frames arrive on the wake tap.
//
// `DAIMOND_WAKE=poll` forces the park transport, where (a) means exactly the one wake
// park; the default is the socket, where it means none.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_handoff_progresswatch.mjs

import {
	checker,
	pair,
	until,
	settle,
	storedMsgs,
	placeholders,
	send,
	freshChat,
	sendAgo,
	reload,
} from './handoffpair.mjs';

const HELD_MS  = 3000;				// a request in flight longer than this is being HELD
const STALE_MS = 20 * 60 * 1000;	// past the 15-minute errand deadline
const { ok, bad, check } = checker();

/// Every /api/sync request the page makes, with when it began and ended, so "how
/// many are held right now" is read off the wire and not off the client's opinion.
function tapWire(page) {
	const live = new Map();			// request -> its record
	const log  = [];				// { url, at, end, method }
	page.on('request', (req) => {
		const u = req.url();
		if (!/\/api\/sync(\?|$)/.test(u)) return;
		const rec = { url: u, at: Date.now(), end: 0, method: req.method(), status: 0 };
		live.set(req, rec); log.push(rec);
	});
	page.on('response', (res) => { const r = live.get(res.request()); if (r) r.status = res.status(); });
	const done = (req) => { const r = live.get(req); if (r) { r.end = Date.now(); live.delete(req); } };
	page.on('requestfinished', done);
	page.on('requestfailed', done);
	return {
		log,
		/// The requests in flight now that have been for longer than HELD_MS, among those
		/// the gateway may HOLD: the wake park (`above=`) and the progress door. A lease
		/// read or a parcel pull that is merely slow on a loaded machine is not a hold.
		held: () => [...live.values()].filter((r) => Date.now() - r.at > HELD_MS
			&& /[?&](above|progress)=/.test(r.url)),
	};
}

/// Sample the held count every 250 ms for `ms`, answering the largest seen and the
/// URLs held at that moment.
async function maxHeld(page, wire, ms) {
	let max = 0, at = [];
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const h = wire.held();
		if (h.length > max) { max = h.length; at = h.map((r) => r.url.replace(/^.*\/api\/sync/, '')); }
		await page.waitForTimeout(250);
	}
	return { max, at };
}

let a, b;
try {
	({ a, b } = await pair(check, 'pwlead', 'pwmate'));
	console.log('  ..    A\'s wake channel: ' + (await a.page.evaluate(() => window.DaimondSync.wake().mode) || '(probing)'));
	const wire = tapWire(a.page);

	// ── (c) Live progress for a real hand-off ────────────────────
	console.log('\n(c) A hands a slow turn to B and watches it stream');
	// THE ANSWER OUTLASTS SEVERAL TICKS. Against a gateway that never taps, the page reads
	// frames on its own 4 s tick (sync.js PROGRESS_TICK_MS), so a streamed answer can only
	// be seen if it streams for longer than a tick. Forty words stream in about five
	// seconds, which one tick can miss by its phase alone: measured 2026-09-23, the tick
	// read at +12.3 s the frame stored just before the answer began, and the answer landed
	// at +15.8 s. At 160 words (about twenty seconds) the streamed answer was on screen at
	// +16.3 s and landed at +30.7 s; a tapping gateway showed 40 words by +12.6 s either way.
	const THINK = Array.from({ length: 80 }, (_, i) => 'reasoning' + (i + 1)).join(' ');
	const SAY   = Array.from({ length: 160 }, (_, i) => 'word' + (i + 1)).join(' ');
	await freshChat(a);
	const cFrom = wire.log.length;
	const tDispatch = Date.now();
	await send(a.page, '@reasonslow ' + THINK + ' ;; ' + SAY + ' ANSWERWORD done');
	// The prompt itself is on screen in A's own bubble, and the head of it again on the
	// hand-off tile, so a streamed row is told apart by a SECOND copy of a word from the
	// ANSWER, which the tile's head does not reach: the runner's answer, drawn as a
	// provisional row while it is still being written. Sampled with A's store, so a
	// pass cannot be the parcel arriving.
	// When the answer reached A's store, sampled beside the screen watch below.
	let answeredAt = 0;
	const ansWatch = (async () => {
		for (let i = 0; i < 600 && !answeredAt; i++) {
			const ms = await storedMsgs(a);
			if (ms.some((m) => m && m.role === 'assistant' && !m.provisional
				&& /ANSWERWORD/.test(String(m.content || '')))) answeredAt = Date.now();
			else await a.page.waitForTimeout(250);
		}
	})();
	const copies = (text, w) => (text.match(new RegExp('\\b' + w + '\\b', 'g')) || []).length;
	let streamedAt = 0, streamed = '';
	for (let i = 0; i < 300 && !streamedAt; i++) {
		const ms = await storedMsgs(a);
		const answered = ms.some((m) => m && m.role === 'assistant' && !m.provisional
			&& /ANSWERWORD/.test(String(m.content || '')));
		const screen = await a.page.evaluate(() => {
			const el = document.getElementById('chat-output');
			return el ? String(el.textContent || '') : '';
		}).catch(() => '');
		if (!answered && copies(screen, 'word5') >= 2) { streamedAt = Date.now(); streamed = screen; }
		if (answered) break;
		await a.page.waitForTimeout(200);
	}
	const done = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		return /ANSWERWORD/.test(out ? out.textContent : '');
	}, null, 90000);
	const cReads  = wire.log.slice(cFrom).filter((r) => r.method === 'GET' && /progress=/.test(r.url));
	const cParked = cReads.filter((r) => /[?&]wait=/.test(r.url));
	check('(c) A has B\'s streamed turn on screen BEFORE the answer reached its store',
		streamedAt > 0, streamedAt ? 'on screen at +' + (streamedAt - tDispatch) + 'ms: '
		+ copies(streamed, 'word5') + ' copies of word5' : 'nothing streamed before the answer');
	check('(c) and the frames came by the wake tap: A read the door, and never asked it to park',
		cReads.length >= 1 && cParked.length === 0,
		cReads.length + ' progress read(s), ' + cParked.length + ' of them parked (wait=)');
	check('(c) the answer then lands on A', done);
	// THE STREAM KEPT MOVING, not one frame and then silence until the answer merged:
	// more than one frame read off the door while B was still running it. This is what a
	// page ahead of its gateway lost (audit F1): an older gateway never taps, and a page
	// that waited for a tap read the first frame and nothing after it.
	await ansWatch;
	const cEnd    = answeredAt || Date.now();
	const cFrames = cReads.filter((r) => r.status === 200 && r.end && r.end <= cEnd);
	check('(c) the stream kept moving: A read more than one frame before the answer landed',
		cFrames.length >= 2, cFrames.length + ' frame(s) read before the answer, of '
		+ cReads.length + ' progress read(s)');
	await settle(a.page);

	// ── (a) Three hand-offs outstanding: one held request at most ──
	console.log('\n(a) B goes away; A hands off three turns nobody takes');
	await b.close(); b = null;
	const before = new Set(placeholders(await storedMsgs(a)).map((m) => String(m.iturn)));
	for (let i = 1; i <= 3; i++) {
		await freshChat(a);
		await send(a.page, 'handed off turn number ' + i + ' for a device that has gone');
		await until(a.page, () => {
			const out = document.getElementById('chat-output');
			return /sent to your other|handed off|sending to/i.test(out ? out.textContent : '');
		}, null, 15000);
		await a.page.waitForTimeout(500);
	}
	await settle(a.page);
	const fresh = placeholders(await storedMsgs(a)).filter((m) => !before.has(String(m.iturn)));
	check('(a) A holds three outstanding hand-off placeholders', fresh.length >= 3,
		fresh.length + ' placeholder(s)');
	const aFrom = wire.log.length;
	const aHeld = await maxHeld(a.page, wire, 20000);
	check('(a) at most ONE long-lived /api/sync request is held with three turns watched',
		aHeld.max <= 1, 'most held at once: ' + aHeld.max + (aHeld.at.length ? ' ' + JSON.stringify(aHeld.at) : ''));
	console.log('  ..    progress reads in the 20 s window: '
		+ wire.log.slice(aFrom).filter((r) => /progress=/.test(r.url)).length);

	// ── (b) Hand-offs past their deadline, after a reload: nothing is watched ──
	console.log('\n(b) Hand-offs sent twenty minutes ago, nobody took them, and A reloads');
	const stale = [];
	for (let i = 1; i <= 3; i++) {
		const ph = await sendAgo(a, 'stale hand-off number ' + i + ' nobody took', STALE_MS);
		if (ph) stale.push(String(ph.iturn));
	}
	await reload(a);
	const stillThere = placeholders(await storedMsgs(a)).filter((m) => stale.includes(String(m.iturn)));
	check('(b) placeholders twenty minutes old survive the reload (so the next check means something)',
		stale.length >= 2 && stillThere.length === stale.length,
		stillThere.length + ' of ' + stale.length + ' handed off are stored');
	// AND THE INDEX IS REBUILT, as it is on every sync merge and every cross-tab write
	// of a device in use: a second tab of A's says the chat store moved. Without this a
	// quiet page might simply never have looked again, and a pass would prove nothing.
	const APP = process.env.DAIMOND_APP || ('http://localhost:' + (process.env.DAIMOND_PORT || 8777));
	const nudge = await a.page.context().newPage();
	try {
		await nudge.goto(APP + '/__progresswatch_nudge', { waitUntil: 'domcontentloaded' }).catch(() => {});
		await nudge.evaluate(() => localStorage.setItem('daimond-chats-rev', 'nudge-' + Math.random()));
	} finally { await nudge.close(); }
	const bFrom = wire.log.length;
	const bHeld = await maxHeld(a.page, wire, 15000);
	const bReads = wire.log.slice(bFrom).filter((r) => /progress=/.test(r.url)
		&& stale.some((t) => r.url.includes(encodeURIComponent(t))));
	check('(b) no stale hand-off is read at the progress door after the reload',
		bReads.length === 0, bReads.length + ' read(s) for the stale turns'
		+ (bReads.length ? ', e.g. ' + bReads[0].url.replace(/^.*\/api\/sync/, '') : ''));
	check('(b) and nothing is held open for them', bHeld.max <= 1,
		'most held at once: ' + bHeld.max + (bHeld.at.length ? ' ' + JSON.stringify(bHeld.at) : ''));

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { await b?.close(); } catch (e) {}
}
process.exit(bad.length ? 1 : 0);
