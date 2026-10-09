// gateway: none
// verify_decision_last.mjs — a Decision that awaits the user is the LAST tile of the thread, and
// once it is answered it goes back to its place (D-20261007-05).
//
// THE OWNER'S WORDS (2026-10-07): "Decision tiles should go to the end of the transcript whilst
// active, the end of a transcript is where the user is looking for the latest output and anything
// they as a user must do. once it is completed, the Decision tile then should go back into its
// original order in the transcript."
//
// WHAT AWAITS (lead ruling 2026-10-08): an unanswered ask card whose question is current, or the
// hand-off tile while it carries a blocker. They are drawn after the last content tile, in their
// own order, above the turn indicator and the queue box. They return to their stored place when
// answered, or when the blocker goes. Display only: the stored messages are the same either way.
//
// THE ARMS, all on the real DOM, from seeded chats (the same `renderHistory` the live turn,
// a reload and a hand-off viewer share):
//   1. ONE ASK across a Thinking-and-Tools run: active it is last, below the group and the reply;
//      answered by a tap it sits where the question was asked, and the group has split in two.
//   2. TWO ASKS keep their own order at the foot; answered in the reverse order each returns to
//      its own place.
//   3. THE HAND-OFF TILE held on a blocker is last; with the blocker gone it is back in place.
//   4. A STALE ASK (asked hours ago) is not awaiting: it stands where it was asked.
//   5. NOTHING AWAITING: a thread with no ask is unchanged.
//   6. THE NEXT MESSAGE ANSWERS IT (owner ruling D-20261009-20, superseding the r541 QA B F5
//      ruling): a message the person sent after the ask closes the card "answered in your own
//      words", in its place, its buttons dead and no option marked.
//   8. A SECOND QUESTION after a typed answer (r543 QA-B2 F-B2-1 T2): only the newest is open and
//      last. Two questions with no message between: the older closes as replaced.
//   9. LIVE, THE HELD QUEUE: a message queued during the asking turn waits in the queue box under
//      the card and is not sent; sent from there, it is the answer. A reload keeps it all.
//  10. LIVE, THE IDLE BOUND (F-B2-2): after a typed answer the idle default never fires. The page's
//      own clock hook (`__daimondDialogIdleMs`) shortens the half hour to seconds.
//
//   eval "$(bash dev/world.sh N --up)" ; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_decision_last.mjs
import { open, shot, errors, signInAs, scratch, chat, newChat } from './harness.mjs';
import fs from 'node:fs';

const PROFILE = scratch('pw', 'decision-last');
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};

const s = await open({ name: 'decision-last', profile: PROFILE, connect: true, defaults: true });
const { page } = s;

// The thread as units, top-level and in order. An ask is `ask:open:<q>` or `ask:done:<q>`; a
// rollup is `group:N` or `plain:<t>`; any other tile is its own type. The spinner, the queue
// box and the System band are not content.
const read = () => page.evaluate(() => {
	const out = document.getElementById('chat-output');
	return [...out.children].filter((n) => n.id !== 'chat-queued' && n.id !== 'wire-head'
		&& !(n.classList && n.classList.contains('chat-spinner'))).map((n) => {
		if (n.classList.contains('ask-card')) {
			return 'ask:' + (n.dataset.answered ? 'done' : 'open') + ':' + n.querySelector('.ask-q').textContent.slice(0, 2);
		}
		if (n.classList.contains('crollup')) {
			const t = (n.querySelector('.ctile') || { dataset: {} }).dataset.t;
			return n.classList.contains('solo') ? 'plain:' + t : 'group:' + n.querySelectorAll(':scope > .crollup-body > .ctile').length;
		}
		return n.dataset.t || n.className.split(' ')[0];
	});
});
const lastIs = (u, tag) => u.length > 0 && u[u.length - 1].startsWith(tag);
// One card's closed state, found by the start of its question.
const cardState = (q2) => page.evaluate((q2) => {
	const card = [...document.querySelectorAll('#chat-output .ask-card')]
		.find((x) => x.querySelector('.ask-q').textContent.startsWith(q2));
	if (!card) return null;
	const opts = [...card.querySelectorAll('.ask-opt')];
	return { done: (card.querySelector('.ask-done') || {}).textContent || '', dead: opts.length > 0 && opts.every((b) => b.disabled),
		chosen: card.querySelectorAll('.ask-opt.chosen').length, other: !!card.querySelector('.ask-other') };
}, q2);
const OWN  = 'Answered in your own words';
const HELD = 'Held while the question above is open. What you send next answers it';

const putRow = (rec) => page.evaluate((rec) => new Promise((res, rej) => {
	const req = indexedDB.open('daimond-chats');
	req.onsuccess = () => {
		const db = req.result, t = db.transaction('chats', 'readwrite');
		t.objectStore('chats').put(rec);
		t.oncomplete = () => res(); t.onerror = () => rej(t.error);
	};
	req.onerror = () => rej(req.error);
}), rec);
const NOW = Date.now();
const m = (role, i, extra) => Object.assign({ role, mid: 'd' + i, ts: NOW + i, content: role + i }, extra || {});
const Q = (q, n) => ({ question: q, options: [
	{ label: 'Alpha', means: 'The first way.' }, { label: 'Beta', means: 'The second way.' }],
	recommend: 'Alpha', why: 'It is simpler.', if_silent: 'Alpha.', n: n || 1, of: 1 });
const ask = (i, q, ago) => m('tool_log', i, { name: 'ask', args: JSON.stringify(Q(q)), outcome: 'done',
	content: 'Asked.', ts: NOW - (ago || 0) + i, callId: 'a' + i });
const tool = (i) => m('tool_log', i, { name: 'file_list', args: '{"path":"."}', outcome: 'done' });
const chatRow = (id, name, messages) => ({
	id, name, model: 'mock/fast', provider: 'mock', status: 'active',
	promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
	prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
	updatedAt: NOW + 5000, messages,
});

// Arm 1: one ask asked in the middle of a working run; the run goes on after it.
await putRow(chatRow('dl1', 'DL one ask', [
	m('user', 0, { content: 'Plan the parcel.' }),
	m('think_log', 1), tool(2),
	ask(3, 'Where first?'),
	m('think_log', 4), tool(5),
	m('assistant', 6, { content: 'My view, meanwhile.' }),
]));
// Arm 2: two asks, a run between them, a reply after.
await putRow(chatRow('dl2', 'DL two asks', [
	m('user', 0, { content: 'Two questions.' }),
	ask(1, 'Pa'),
	m('think_log', 2), tool(3),
	ask(4, 'Qb'),
	m('assistant', 5, { content: 'Reply after both.' }),
]));
// Arm 3: a hand-off placeholder in the middle of a run, held on a blocker by the stub below.
await putRow(chatRow('dl3', 'DL hand-off', [
	m('user', 0, { content: 'Do it elsewhere.' }),
	m('think_log', 1), tool(2),
	m('assistant', 3, { content: '', interrupted: true, why: 'dispatched', iturn: 'TD1', itext: 'Do it elsewhere.',
		deadline: NOW + 900000, toName: 'Gilgamesh', toDevice: 'peerdev' }),
	m('think_log', 4), tool(5),
]));
// Arm 4: an ask from three hours ago, so not current.
// The WHOLE chat is three hours old: a stamp older than its neighbours would sort the ask to the top.
const AGED = 3 * 3600 * 1000;
await putRow(chatRow('dl4', 'DL stale ask', [
	m('user', 0, { content: 'An old question.' }),
	m('think_log', 1), tool(2),
	ask(3, 'Old?'),
	m('think_log', 4), tool(5),
	m('assistant', 6, { content: 'Later reply.' }),
].map((x) => Object.assign(x, { ts: x.ts - AGED }))));
// Arm 5: no ask at all.
await putRow(chatRow('dl5', 'DL no ask', [
	m('user', 0, { content: 'Plain.' }),
	m('think_log', 1), tool(2), m('think_log', 3),
	m('assistant', 4, { content: 'Plain reply.' }),
]));

// Arm 6: an ask, then the person's next message, typed in the composer.
await putRow(chatRow('dl6', 'DL interjection', [
	m('user', 0, { content: 'Start the parcel.' }),
	m('think_log', 1), tool(2),
	ask(3, 'In which order?'),
	m('user', 4, { content: 'Also check the fence.' }),
	m('assistant', 5, { content: 'Fence checked.' }),
]));

// Arm 8: the QA-B2 T2 thread: a typed answer, more turns, then a second question.
await putRow(chatRow('dl8', 'DL second ask', [
	m('user', 0, { content: 'Begin.' }),
	ask(1, 'First which?'),
	m('user', 2, { content: 'Beta, but go slowly.' }),
	m('assistant', 3, { content: 'Going slowly.' }),
	m('user', 4, { content: 'Now the fence.' }),
	m('assistant', 5, { content: 'Fence next.' }),
	ask(6, 'Second which?'),
]));

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'decision-last');
await page.waitForTimeout(800);
const openByName = (nm) => page.evaluate((nm) => {
	const hit = [...document.querySelectorAll('#session-list .session-box')].find((b) => (b.textContent || '').includes(nm));
	if (hit) { (hit.querySelector('.tile-label, .tile-when, button') || hit).click(); return true; }
	return false;
}, nm);
// The card is found by the start of its question: the cards change places as they are answered.
const pickOpt = (q2, label) => page.evaluate(({ q2, label }) => {
	const card = [...document.querySelectorAll('#chat-output .ask-card')]
		.find((c) => c.querySelector('.ask-q').textContent.startsWith(q2));
	if (!card) return false;
	const b = [...card.querySelectorAll('.ask-opt')].find((x) => x.querySelector('.ask-label').textContent === label);
	if (b) b.click();
	return !!b;
}, { q2, label });

// ── 1. ONE ASK across a group ──
check('1 the seeded chat opens', await openByName('DL one ask'));
await page.waitForTimeout(900);
let u = await read();
check('1a active: the ask is the LAST tile, below the group and the reply',
	lastIs(u, 'ask:open:') && u.length === 4 && u[1] === 'group:4' && u[2] === 'reply', JSON.stringify(u));
await shot(s, 'decision-last-active');
check('1b the card is a live card (its options are buttons)', await pickOpt('Wh', 'Beta'));
await page.waitForTimeout(1500);
u = await read();
check('1c answered: it sits where it was asked, and the group has split in two around it',
	u.slice(0, 5).join('|') === 'user|group:2|ask:done:Wh|group:2|reply', JSON.stringify(u));
await shot(s, 'decision-last-answered');

// ── 2. TWO ASKS ──
check('2 the seeded chat opens', await openByName('DL two asks'));
await page.waitForTimeout(900);
u = await read();
check('2a only the newer ask is open and last; the older is closed in its place',
	u.join('|') === 'user|ask:done:Pa|group:2|reply|ask:open:Qb', JSON.stringify(u));
let c = await cardState('Pa');
check('2b the older says a later question replaced it, its buttons dead and none marked',
	c && c.done === 'A later question replaced this one' && c.dead && c.chosen === 0 && !c.other, JSON.stringify(c));
await pickOpt('Qb', 'Alpha');
await page.waitForTimeout(1500);
u = await read();
check('2c the newer answered: each stands where it was asked',
	u.slice(0, 5).join('|') === 'user|ask:done:Pa|group:2|ask:done:Qb|reply', JSON.stringify(u));

// ── 3. THE HAND-OFF TILE held on a blocker ──
await page.evaluate(() => {
	window.__blk = { TD1: { kind: 'ask', detail: 'Which way?', options: ['Alpha', 'Beta'], cid: 'c1', since: Date.now() } };
	const L = window.DaimondLease;
	L.record  = (id) => ({ mode: 'running', holder: 'peerdev', expiry: Date.now() + 600000, blocker: window.__blk[id] });
	L.blocker = (id) => window.__blk[id] || null;
	L.holder  = () => 'peerdev';
});
check('3 the seeded chat opens', await openByName('DL hand-off'));
await page.waitForTimeout(900);
u = await read();
check('3a blocked: the hand-off tile is the LAST tile, below the group that spans it',
	lastIs(u, 'handoff') && u[1] === 'group:4', JSON.stringify(u));
await shot(s, 'decision-last-handoff');
await page.evaluate(() => { window.__blk = {}; });
await openByName('DL hand-off');
await page.waitForTimeout(900);
u = await read();
check('3b the blocker gone: the tile is back in place and the group has split',
	u.slice(0, 4).join('|') === 'user|group:2|handoff|group:2', JSON.stringify(u));

// ── 4. A STALE ASK is not awaiting ──
check('4 the seeded chat opens', await openByName('DL stale ask'));
await page.waitForTimeout(900);
u = await read();
check('4 a question asked hours ago stands where it was asked',
	u.slice(0, 5).join('|') === 'user|group:2|ask:open:Ol|group:2|reply', JSON.stringify(u));

// ── 5. NOTHING AWAITING ──
check('5 the seeded chat opens', await openByName('DL no ask'));
await page.waitForTimeout(900);
u = await read();
check('5 a thread with no ask is unchanged', u.join('|') === 'user|group:3|reply', JSON.stringify(u));

// ── 6. THE NEXT MESSAGE ANSWERS IT ──
check('6 the seeded chat opens', await openByName('DL interjection'));
await page.waitForTimeout(900);
u = await read();
check('6a the message after the ask answered it: the card stands where it was asked',
	u.join('|') === 'user|group:2|ask:done:In|user|reply', JSON.stringify(u));
await shot(s, 'decision-last-interject');
c = await cardState('In');
check('6b closed "answered in your own words", buttons dead, none marked, no box',
	c && c.done === OWN && c.dead && c.chosen === 0 && !c.other, JSON.stringify(c));

// ── 8. A SECOND QUESTION after a typed answer ──
check('8 the seeded chat opens', await openByName('DL second ask'));
await page.waitForTimeout(900);
u = await read();
check('8a only the newest question is open, and it is last; the typed answer closed the first',
	u.join('|') === 'user|ask:done:Fi|user|reply|user|reply|ask:open:Se', JSON.stringify(u));
c = await cardState('Fi');
check('8b the first closed in your own words', c && c.done === OWN && c.dead, JSON.stringify(c));

// ── 9. LIVE: a message queued during the asking turn is held, then sent as the answer ──
const AQ = (q) => JSON.stringify({ question: q, options: [{ label: 'Alpha', means: 'a' }, { label: 'Beta', means: 'b' }],
	recommend: 'Alpha', why: 'w', if_silent: 'Alpha.', n: 1, of: 1 });
const busy = () => page.evaluate(() => { const b = document.getElementById('chat-send');
	return /stop/i.test((b.getAttribute('title') || '') + b.className); });
const settle = async (min) => {
	for (let i = 0; i < 60; i++) { if (!(await busy()) && i >= (min || 0)) break; await page.waitForTimeout(500); }
	await page.waitForTimeout(1200);
};
const users = () => page.evaluate(() => [...document.querySelectorAll('#chat-output .chat-msg-user .chat-msg-content')]
	.map((n) => n.textContent.trim()));
const queued = () => page.evaluate(() => { const q = document.getElementById('chat-queued');
	return q ? { head: [...q.querySelectorAll('.chat-queued-head')].map((h) => h.textContent).join('|'),
		items: [...q.querySelectorAll('.chat-msg-queued .chat-msg-content')].map((n) => n.textContent) } : null; });
await newChat(s);
await page.fill('#chat-input', '@rounds 1/3500 ask ' + AQ('Held which?'));
await page.click('#chat-send', { force: true });
await page.waitForTimeout(1200);
await page.fill('#chat-input', '@text Fence checked too.');
await page.click('#chat-send', { force: true });
await settle(12);
u = await read();
let qd = await queued(), us = await users();
check('9a the turn ended on the question: the card is open and last', lastIs(u, 'ask:open:He'), JSON.stringify(u));
check('9b the queued message waits in the queue box, under the card, held for the answer',
	!!qd && qd.items.length === 1 && /Fence checked too/.test(qd.items[0]) && qd.head === HELD, JSON.stringify(qd));
check('9c and it was not sent', us.length === 1, JSON.stringify(us));
await shot(s, 'decision-last-held');
// Taken from the box into the composer and sent: the answer.
await page.evaluate(() => { const b = document.querySelector('#chat-queued .chat-msg-queued .chat-msg-content'); if (b) b.click(); });
await page.waitForTimeout(300);
await page.click('#chat-send', { force: true });
await settle(2);
u = await read(); us = await users(); c = await cardState('He');
check('9d sent from the box, it answered the card: closed in your own words, in its place, buttons dead',
	c && c.done === OWN && c.dead && c.chosen === 0 && !lastIs(u, 'ask:'), JSON.stringify({ u, c }));
check('9e the held message is the message after the card', us.length === 2 && /Fence checked too/.test(us[1]),
	JSON.stringify(us));
check('9f nothing is left waiting', !(await queued()), JSON.stringify(await queued()));
const liveId = await page.evaluate(() => (document.querySelector('#session-list .session-box.active') || { dataset: {} }).dataset.id || '');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 }).catch(() => {});
await signInAs(s, 'decision-last');
await page.waitForTimeout(1200);
await page.evaluate((id) => {
	const b = [...document.querySelectorAll('#session-list .session-box')].find((x) => (id && x.dataset.id === id) || /rounds|Held/.test(x.textContent));
	if (b) (b.querySelector('.tile-label, .tile-when, button') || b).click();
}, liveId);
await page.waitForTimeout(1200);
u = await read(); c = await cardState('He');
check('9g a reload keeps it all: closed in your own words, in its place, buttons dead',
	c && c.done === OWN && c.dead && !lastIs(u, 'ask:'), JSON.stringify({ u, c, liveId }));

// ── 10. LIVE: the idle default never fires after a typed answer ──
await newChat(s);
await page.evaluate(() => { window.__daimondDialogIdleMs = 4000; });
await chat(s, '@tool ask ' + AQ('Idle which?'), { timeout: 20000 });
await chat(s, '@text Beta then, going ahead.', { timeout: 20000 });
await page.waitForTimeout(12000);			// three idle windows, the page untouched
us = await users(); c = await cardState('Id');
check('10a no answer on silence was sent after the typed answer',
	!us.some((x) => /^Other:/.test(x)) && us.length === 2, JSON.stringify(us));
check('10b the card closed in your own words', c && c.done === OWN && c.dead, JSON.stringify(c));
await page.evaluate(() => { delete window.__daimondDialogIdleMs; });

const errs = errors(s).filter((e) => !/502|\/api\//.test(e));
check('7 nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
