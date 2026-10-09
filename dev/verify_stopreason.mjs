// gateway: live
// verify_stopreason.mjs -- every stop says why, after the last tile, with Continue
// where Continue is the thing to do (D-20261006-30 (a), lane E6, r539).
//
// WHAT THE OWNER SAW (21:48, 2026-10-07): a handed-off turn that outran the 30-minute
// lease cap ended with "Stopped" drawn ABOVE the last tile, and nothing said why. Two
// faults, one screenshot:
//
//   (1) ORDER. `endLogOf` stamped the end record when the engine's `ended` event came, and
//       the record was pushed after the answer or partial, which took a later stamp. A
//       transcript is merged by (ts, mid), so on every merged device the end line sorted
//       above the tile it closes.
//   (2) REASON. The abort that stopped the turn carried no reason, so the line said
//       "Stopped" for a stop the person never asked for.
//
// THE PROPERTIES, each false of 27d05f87:
//
//   (a) A lease-cap stop draws its reason (`data-why="lease_cap"`) and is the LAST message
//       of the thread on the asker, and the stored record carries the same `why` on both
//       devices and sorts after the partial answer.
//   (b) It offers Continue (`.ti-continue`), once, on that stop only. Pressing it sends the
//       house nudge, a new answer lands, and no stop line higher in the thread offers
//       Continue afterwards -- on screen and again after a reload.
//   (c) A stop the person made says plain "Stopped" (`data-why="user"`), last, no Continue.
//   (d) An end record stored before `why` existed still draws "Stopped", with no Continue.
//
// The cap is shrunk with no production hook: B's `DaimondPeer.runErrand` is wrapped to
// pass `maxLeaseLifeMs`, which the runner already reads from its deps, and a `setTimer` that
// ticks the liveness check every 1.5 s instead of every 30 s (the cap is only tested when the
// check runs, and a one-round turn emits few journal events, so at 30 s the ~20 s mock turn
// finishes first and the cap never bites).
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.
//   node dev/verify_stopreason.mjs

import {
	checker,
	pair,
	until,
	settle,
	send,
	freshChat,
	reload,
	modelSaw,
} from './handoffpair.mjs';

const { ok, bad, check } = checker();
const NUDGE = 'Carry on from exactly';

const SAY = Array.from({ length: 160 }, (_, i) => 'word' + (i + 1)).join(' ');

/// The chat (id and messages, from the chat store) whose transcript holds `marker`.
const chatWith = (s, marker) => s.page.evaluate(async (mk) => {
	const cs = window.DaimondCore.chatStore();
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		const ms = (got && got.messages) || [];
		if (ms.some((m) => m && String(m.content || '').includes(mk))) return { id: sum.id, messages: ms };
	}
	return null;
}, marker).catch(() => null);

/// What the thread on screen ends with.
const tail = (page) => page.evaluate(() => {
	const out = document.getElementById('chat-output');
	// Every tile is a direct child of the thread (`.ctile`, `.crollup`, the stop line itself);
	// `.chat-msg` alone would match only the stop line and make "last" vacuous.
	const all = out ? Array.from(out.children).filter((el) => !el.classList.contains('empty-state')) : [];
	const last = all[all.length - 1] || null;
	const ended = Array.from(out ? out.querySelectorAll('.chat-msg-ended') : []).map((el) => ({
		why:  el.dataset.why || '',
		text: ((el.querySelector('.end-line') || {}).textContent || '').trim(),
		btn:  el.querySelectorAll('button.ti-continue').length,
		last: el === last,
	}));
	return { n: all.length, ended, lastIsEnded: !!(last && last.classList.contains('chat-msg-ended')) };
}).catch(() => ({ n: 0, ended: [], lastIsEnded: false }));

/// Messages in transcript order: where the first end_log sits, against the last
/// assistant message, and their stamps.
const order = (ms) => {
	const iEnd = ms.findIndex((m) => m && m.role === 'end_log');
	let iAsk = -1;
	ms.forEach((m, i) => { if (m && m.role === 'assistant' && String(m.content || '').trim()) iAsk = i; });
	const end = iEnd >= 0 ? ms[iEnd] : null;
	return { iEnd, iAsk, endTs: end ? +end.ts : 0, askTs: iAsk >= 0 ? +ms[iAsk].ts : 0, end };
};

let a, b;
try {
	({ a, b } = await pair(check, 'srlead', 'srmate'));

	// ── (c) A stop the person made ───────────────────────────────
	console.log('\n(c) B runs a slow turn and the person presses Stop');
	await freshChat(b);
	await b.page.fill('#chat-input', '@reasonslow STOPUSERMARK quick ;; ' + SAY);
	await b.page.click('#chat-send', { force: true });
	await until(b.page, () => {
		const out = document.getElementById('chat-output');
		const btn = document.getElementById('chat-send');
		return !!btn && btn.classList.contains('stop') && /word1\b/.test(out ? out.textContent : '');
	}, null, 30000);
	await b.page.waitForTimeout(1500);
	await b.page.click('#chat-send.stop', { force: true }).catch(() => {});
	await until(b.page, () => !!document.querySelector('.chat-msg-ended'), null, 20000);
	const cTail = await tail(b.page);
	const cLine = cTail.ended[0] || { why: '', text: '', btn: 0 };
	check('(c) a user Stop says exactly "Stopped"', cLine.text === 'Stopped', JSON.stringify(cTail.ended));
	check('(c) and names no other reason (data-why="user")', cLine.why === 'user', 'data-why=' + JSON.stringify(cLine.why));
	check('(c) and offers no Continue', cLine.btn === 0, cLine.btn + ' button(s)');
	check('(c) and is the last message of the thread', cTail.lastIsEnded, 'tail: ' + JSON.stringify(cTail.ended));
	await settle(b.page);
	const cChat = await chatWith(b, 'STOPUSERMARK');
	const cOrd = order((cChat && cChat.messages) || []);
	check('(c) stored: the end record sits after the partial answer, with the later stamp',
		cOrd.iEnd > cOrd.iAsk && cOrd.iAsk >= 0 && cOrd.endTs > cOrd.askTs && cOrd.end && cOrd.end.why === 'user',
		JSON.stringify({ iEnd: cOrd.iEnd, iAsk: cOrd.iAsk, endTs: cOrd.endTs, askTs: cOrd.askTs, why: cOrd.end && cOrd.end.why }));

	// ── (a) A lease-cap stop, on the asker and the runner ────────
	console.log('\n(a) A hands a slow turn to B whose cap is six seconds');
	await freshChat(a);
	await b.page.evaluate(() => {
		const o = window.DaimondPeer.runErrand;
		window.__srOrigRun = o;
		window.DaimondPeer.runErrand = (e, d) => o.call(window.DaimondPeer, e, Object.assign({}, d, { maxLeaseLifeMs: 6000, setTimer: (fn, ms) => setInterval(fn, ms === 30000 ? 1500 : ms) }));
	});
	await send(a.page, '@reasonslow STOPCAPMARK quick ;; ' + SAY + ' ANSWERWORD done');
	// Whatever line closes the turn on A, within a minute of the send.
	await until(a.page, () => !!document.querySelector('.chat-msg-ended'), null, 75000);
	await a.page.waitForTimeout(1500);
	await settle(a.page);
	const aTail = await tail(a.page);
	const aLine = aTail.ended[0] || { why: '', text: '', btn: 0 };
	check('(a) A draws a stop line at all', aTail.ended.length === 1, JSON.stringify(aTail.ended));
	check('(a) the line carries its reason (data-why="lease_cap")', aLine.why === 'lease_cap',
		'data-why=' + JSON.stringify(aLine.why) + ' text=' + JSON.stringify(aLine.text));
	check('(a) the line says why in words, not "Stopped" alone',
		aLine.text !== '' && aLine.text !== 'Stopped' && /^Stopped/.test(aLine.text), JSON.stringify(aLine.text));
	check('(a) it is the LAST message of the thread on A', aTail.lastIsEnded, JSON.stringify(aTail.ended));
	const aChat = await chatWith(a, 'STOPCAPMARK');
	const aOrd = order((aChat && aChat.messages) || []);
	check('(a) A stored: the end record sorts after the last answer, with the later stamp',
		aOrd.iAsk >= 0 && aOrd.iEnd > aOrd.iAsk && aOrd.endTs > aOrd.askTs,
		JSON.stringify({ iEnd: aOrd.iEnd, iAsk: aOrd.iAsk, endTs: aOrd.endTs, askTs: aOrd.askTs }));
	check('(a) A stored: the record carries why === "lease_cap"', !!aOrd.end && aOrd.end.why === 'lease_cap',
		'end=' + JSON.stringify(aOrd.end) + ' roles=' + JSON.stringify(((aChat && aChat.messages) || []).map((m) => m && m.role)));
	const bChat = await chatWith(b, 'STOPCAPMARK');
	const bOrd = order((bChat && bChat.messages) || []);
	check('(a) B (the runner) stored: why === "lease_cap", after its last answer',
		!!bOrd.end && bOrd.end.why === 'lease_cap' && bOrd.iEnd > bOrd.iAsk && bOrd.iAsk >= 0,
		JSON.stringify({ iEnd: bOrd.iEnd, iAsk: bOrd.iAsk, end: bOrd.end }) + ' roles=' + JSON.stringify(((bChat && bChat.messages) || []).map((m) => m && m.role)));
	// And drawn on B, which has to open the chat to see it.
	if (bChat) await b.page.click('.session-box[data-id="' + bChat.id + '"]', { force: true }).catch(() => {});
	await b.page.waitForTimeout(1500);
	const bTail = await tail(b.page);
	check('(a) B draws the same line, last, with its reason',
		bTail.lastIsEnded && bTail.ended.length === 1 && bTail.ended[0].why === 'lease_cap',
		JSON.stringify(bTail.ended));

	// ── (b) Continue ─────────────────────────────────────────────
	console.log('\n(b) Continue on the latest stop');
	check('(b) the stop offers exactly one Continue', aLine.btn === 1, aLine.btn + ' button(s)');
	// B is let go of its cap, so the turn Continue starts is not cut short in its turn.
	await b.page.evaluate(() => { if (window.__srOrigRun) window.DaimondPeer.runErrand = window.__srOrigRun; });
	const saw0 = modelSaw(NUDGE);
	const nAsk0 = (aChat ? aChat.messages : []).filter((m) => m && m.role === 'assistant' && String(m.content || '').trim()).length;
	await a.page.click('.chat-msg-ended button.ti-continue', { force: true }).catch(() => {});
	const sent = await (async () => {
		for (let i = 0; i < 80; i++) { if (modelSaw(NUDGE) > saw0) return true; await a.page.waitForTimeout(500); }
		return false;
	})();
	check('(b) pressing Continue sends the house nudge to the model', sent, 'requests carrying it: ' + (modelSaw(NUDGE) - saw0));
	// A new answer lands in A's store.
	let nAsk1 = nAsk0;
	for (let i = 0; i < 120 && nAsk1 <= nAsk0; i++) {
		const c = await chatWith(a, 'STOPCAPMARK');
		nAsk1 = ((c && c.messages) || []).filter((m) => m && m.role === 'assistant' && String(m.content || '').trim()).length;
		if (nAsk1 <= nAsk0) await a.page.waitForTimeout(500);
	}
	check('(b) a new answer lands', nAsk1 > nAsk0, nAsk0 + ' -> ' + nAsk1 + ' assistant message(s)');
	await settle(a.page);
	const after = await tail(a.page);
	check('(b) afterwards no stop line offers Continue (on screen)', after.ended.every((e) => e.btn === 0),
		JSON.stringify(after.ended));
	await reload(a);
	await a.page.waitForTimeout(1500);
	const re = await tail(a.page);
	check('(b) nor after a reload: a stop line higher in the thread never offers it',
		re.ended.length >= 1 && re.ended.every((e) => e.btn === 0 && !e.last), JSON.stringify(re.ended));

	// ── (d) An end record from before `why` ──────────────────────
	console.log('\n(d) An old stop, stored with no why');
	const seeded = await a.page.evaluate(() => new Promise((resolve) => {
		const req = indexedDB.open('daimond-chats');
		req.onerror = () => resolve(-1);
		req.onsuccess = () => {
			try {
				const db = req.result;
				const t = db.transaction('chats', 'readwrite');
				const st = t.objectStore('chats');
				let n = 0;
				st.getAll().onsuccess = (ev) => {
					(ev.target.result || []).forEach((r) => {
						let hit = false;
						(r.messages || []).forEach((m) => {
							if (m && m.role === 'end_log' && m.why) { delete m.why; hit = true; n++; }
						});
						if (hit) st.put(r);
					});
				};
				t.oncomplete = () => resolve(n);
				t.onerror = () => resolve(-2);
			} catch (e) { resolve(-3); }
		};
	}));
	check('(d) the stored end record was rewritten without its why (so this check means something)',
		seeded > 0, 'records rewritten: ' + seeded);
	if (seeded > 0) {
		await reload(a);
		await a.page.waitForTimeout(1500);
		const old = await tail(a.page);
		check('(d) an end record with no why still draws "Stopped", with no Continue',
			old.ended.length >= 1 && old.ended.every((e) => e.text === 'Stopped' && e.btn === 0), JSON.stringify(old.ended));
	}

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
