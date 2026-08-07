// verify_interject.mjs — you can speak into a turn that is already running.
//
// A turn is not one request; it is a round of them, each carrying the last
// round's tool results. Nothing can be added to a request already in flight, but
// the message list is rebuilt BETWEEN rounds, and the agent drains an
// interjection queue at exactly that seam -- after the tool replies go back (the
// API requires every tool_call to be answered by a tool message) and before the
// next request goes out. So a model twenty tool calls into the wrong approach can
// be corrected without stopping it and without waiting for it to finish.
//
// Four promises are checked here, and they are not the same promise:
//
//   1. It ARRIVES IN THAT TURN. The proof is the mock's own log, not the screen:
//      one request carries the original question, a tool reply, and the
//      interjection, in that order. Before the fix the interjection could only
//      ever appear in a request of its own, after the turn had ended.
//   2. It is DRAWN WHERE IT LANDED. A correction shown at the bottom, under the
//      work it was meant to redirect, reads as one that was ignored.
//   3. The QUEUE still behaves as it did. A turn with no tool call in it has no
//      seam, so what was typed is still waiting when the turn ends -- and then it
//      falls back to the queue, which sends it as its own turn, or hands it back
//      to the composer if the turn failed or was stopped. A chat left in the
//      background keeps its badge and drains on return, exactly as before.
//   4. STOP still means stop. A turn the user killed hands back what they typed
//      rather than spending money on it.
//
//   node dev/verify_interject.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). A verifier that reports "Daimond could not answer"
// is missing the mock, not finding a bug.

import { open, newChat, shot, errors, signInAs } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const s = await open({ name: 'interject' });
const p = s.page;

// Toasts remove themselves after ~4s, so they are recorded as they appear.
await p.evaluate(() => {
	window.__toasts = [];
	new MutationObserver(muts => {
		for (const m of muts) for (const n of m.addedNodes) {
			if (n.nodeType === 1 && n.classList && n.classList.contains('daimond-toast')) {
				window.__toasts.push({ text: n.textContent, err: n.classList.contains('err') });
			}
		}
	}).observe(document.body, { childList: true });
});
const toasts = () => p.evaluate(() => window.__toasts.slice());

// What actually went out on the wire, captured by wrapping the page's own
// `fetch`. The claim being checked is about the request the model received, and
// nothing the app draws is evidence of that -- the DOM is the app marking its own
// homework. The mock's own log holds the same thing from the server's side, but a
// suite that does not set DAIMOND_MOCK_LOG shares one file with every other on the
// machine, and a concurrent run truncates it mid-pass; this reads the bytes this
// page sent.
await p.evaluate(() => {
	window.__sent = [];
	const orig = window.fetch;
	window.fetch = function (req) {
		try {
			if (req && req.url && /chat\/completions/.test(req.url) && typeof req.clone === 'function') {
				req.clone().text().then((txt) => {
					try { window.__sent.push(JSON.parse(txt)); } catch (e) { /* not JSON */ }
				});
			}
		} catch (e) { /* capture must never break the request */ }
		return orig.apply(this, arguments);
	};
});
const sent = () => p.evaluate(() => (window.__sent || []).slice());

/// The shape of the thread: the real turns, what landed mid-turn, and what is
/// still waiting to.
const shape = () => p.evaluate(() => {
	const out  = document.getElementById('chat-output');
	const send = document.getElementById('chat-send');
	const kind = (n) =>
		  n.classList.contains('chat-msg-user')        ? 'user'
		: n.classList.contains('chat-msg-interjected') ? 'cut'
		: n.classList.contains('tool-block')           ? 'tool'
		: n.classList.contains('chat-msg-assistant')   ? 'asst'
		: n.id === 'chat-queued'                       ? 'waiting'
		: '';
	const users = [...out.querySelectorAll('.chat-msg-user')];
	const cuts  = [...out.querySelectorAll('.chat-msg-interjected')];
	return {
		order:      [...out.children].map(kind).filter(Boolean).join(','),
		users:      users.length,
		turns:      users.map(u => u.dataset.turn).join(','),
		userText:   users.map(u => u.querySelector('.chat-msg-content').textContent).join(' | '),
		cuts:       cuts.map(c => c.querySelector('.chat-msg-content').textContent),
		cutTurns:   cuts.map(c => c.dataset.turn).join(','),
		cutsAreUsers: cuts.filter(c => c.classList.contains('chat-msg-user')).length,
		waiting:    [...out.querySelectorAll('.chat-msg-queued')]
						.map(e => e.querySelector('.chat-msg-content').textContent),
		heads:      [...out.querySelectorAll('.chat-queued-head')].map(e => e.textContent),
		composer:   document.getElementById('chat-input').value,
		sendTitle:  send.getAttribute('title') || '',
		stopMode:   send.classList.contains('stop'),
		text:       out.innerText,
		busy:       !!(window.DaimondCore && window.DaimondCore.busy()),
	};
});

/// Wait until the button offers Send again with an empty box — the app's own idea
/// of "this turn is over".
async function idle(timeout = 90000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (!(await shape()).stopMode) return true;
		await sleep(250);
	}
	return false;
}

/// Type into the composer and press Enter, which is how a message is sent — and,
/// mid-turn, how it is said into the turn.
async function type(text) {
	await p.fill('#chat-input', text);
	await p.press('#chat-input', 'Enter');
	await sleep(400);
}

/// Arrange for `text` to be typed the instant the first tool step appears.
///
/// This is the only way to be sure the message is typed while a tool is actually
/// running: an OPFS tool returns in milliseconds, so a sleep long enough to be
/// reliable is far longer than the window it is aiming at. The observer fires
/// synchronously on the DOM write that `renderToolCall` makes, which is before
/// the tool has returned and long before the round's seam.
async function typeWhenToolRuns(text) {
	await p.evaluate((msg) => {
		window.__cutAt = null;
		const out = document.getElementById('chat-output');
		const obs = new MutationObserver(() => {
			if (window.__cutAt) return;
			if (!out.querySelector('.tool-block')) return;
			window.__cutAt = Date.now();
			obs.disconnect();
			const box = document.getElementById('chat-input');
			box.value = msg;
			box.dispatchEvent(new Event('input', { bubbles: true }));
			box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
		});
		obs.observe(out, { childList: true, subtree: true });
	}, text);
}

/// Click something if it is there. A verifier has to be able to RUN against the
/// code before the fix, where these controls do not exist — a hard click would
/// abort the pass with a Playwright timeout instead of failing the check that is
/// meant to catch it.
async function clickIf(sel) {
	const el = await p.$(sel);
	if (!el) return false;
	await el.click({ force: true });
	await sleep(400);
	return true;
}

await newChat(s);

// ── 1. It reaches the model IN the turn it was typed into ────────────
//
// `@chain` is the shape a real agentic turn takes: a tool call, then a second
// one, then a text reply. The interjection is typed on the first tool step, so
// it has a seam to land in without waiting for the turn to end.
const CUT = 'NUDGE-MIDTURN';
await typeWhenToolRuns(CUT);
await p.fill('#chat-input', '@chain file_list {"path":"."}');
await p.click('#chat-send', { force: true });
await sleep(1200);
const cutAt = await p.evaluate(() => window.__cutAt);
check('the message was typed while a tool step was running, not after the turn',
	!!cutAt, cutAt ? 'yes' : 'the tool step never appeared');
await idle();
await sleep(800);

const log = await sent();
/// A request that carries the interjection AT THE SEAM.
///
/// The message immediately before it must be a tool reply. That is the whole
/// claim, and it is what separates landing in the turn from merely appearing in
/// the transcript afterwards: a message queued and sent as its own turn also ends
/// up in a request with the question and the tool replies above it -- but with the
/// turn's final answer sitting between them. Only a delivery at the seam puts the
/// user's words directly after the last tool result, before the model has spoken
/// again.
const atSeam = log.filter(r => {
	const ms = r.messages || [];
	const iCut   = ms.findIndex(m => m.role === 'user' && String(m.content || '').trim() === CUT);
	const iAsked = ms.findIndex(m => m.role === 'user' && String(m.content || '').startsWith('@chain'));
	if (iCut <= 0 || iAsked === -1 || iAsked >= iCut) return false;
	return ms[iCut - 1].role === 'tool';
});
check('the model was sent the message IN that turn, straight after a tool reply',
	atSeam.length > 0,
	`${atSeam.length} of ${log.length} requests carried it at the seam`);
check('and it went as a user turn, which is the only role a correction can wear',
	atSeam.length > 0 && atSeam[0].messages
		.filter(m => String(m.content || '').trim() === CUT)
		.every(m => m.role === 'user'));

const one = await shape();
check('no second turn was started for it: it joined the one already running',
	one.users === 1, `${one.users} user turns — ${one.userText.slice(0, 90)}`);
check('the model answered the interjection, so it really had it',
	one.text.includes(CUT) && /Mock reply to: NUDGE-MIDTURN/.test(one.text),
	one.text.slice(-120).replace(/\n/g, ' '));

// ── 2. It is drawn WHERE it landed ───────────────────────────────────
check('it is drawn in the thread as a message that arrived',
	one.cuts.length === 1 && one.cuts[0] === CUT, JSON.stringify(one.cuts));
check('after the tool step it cut into, and before the answer that followed it',
	/tool,(tool,)*cut,asst/.test(one.order), one.order);
check('nothing is left drawn as waiting once it has landed',
	one.waiting.length === 0, JSON.stringify(one.waiting));
check('it belongs to the turn it cut into, not a turn of its own',
	one.cutTurns === '1' && one.turns === '1',
	`cut@${one.cutTurns} users@${one.turns}`);
check('and it is not a .chat-msg-user, which is what the numbering counts',
	one.cutsAreUsers === 0);
await shot(s, 'interject-landed');

// ── 3. Waiting is drawn as waiting, and says what will happen ────────
//
// `@long` writes prose straight through with no tool call, so there is no seam
// in it at all. That is the honest limit, and the app has to say so rather than
// promise a delivery it cannot make.
await p.fill('#chat-input', '@long 60');
await p.click('#chat-send', { force: true });
await sleep(1200);
const empty = await shape();
check('with nothing typed, the button is still Stop — the signal everything reads',
	empty.stopMode === true, empty.sendTitle);
await p.fill('#chat-input', 'WAITING-ONE');
await p.dispatchEvent('#chat-input', 'input');
await sleep(200);
const typed = await shape();
check('but with a correction typed into it, the button is Send, not Stop',
	typed.stopMode === false && /send/i.test(typed.sendTitle), typed.sendTitle);
await p.click('#chat-send', { force: true });
await sleep(600);
const waiting = await shape();
check('pressing it sends rather than killing the turn it was steering',
	waiting.busy === true && waiting.waiting.length === 1
	&& waiting.waiting[0] === 'WAITING-ONE', JSON.stringify(waiting.waiting));
check('a message not yet delivered is drawn as waiting, not as part of the thread',
	waiting.cuts.length === 1, `${waiting.cuts.length} landed so far`);
check('and the line above it says both when it goes in and that it may have to wait',
	waiting.heads.some(h => /step/i.test(h) && /finish/i.test(h)),
	JSON.stringify(waiting.heads));
check('the composer is cleared, as it is on an ordinary send',
	waiting.composer === '', JSON.stringify(waiting.composer));
await shot(s, 'interject-waiting');

// ── 4. A turn with no seam falls back to the queue, and is not lost ──
await idle();
await sleep(2500);
await idle();
await sleep(1200);
const fell = await shape();
check('a message that found no seam is sent as its own turn rather than dropped',
	/WAITING-ONE/.test(fell.userText), fell.userText.slice(-120));
check('nothing is left waiting once it has gone',
	fell.waiting.length === 0 && fell.busy === false, JSON.stringify(fell.waiting));
check('and the turn numbering still has no gap, so a fold maps through it',
	fell.turns === Array.from({ length: fell.users }, (_, i) => i + 1).join(','), fell.turns);

// ── 5. The × takes a waiting message back out ────────────────────────
await p.fill('#chat-input', '@long 60');
await p.click('#chat-send', { force: true });
await sleep(1200);
await type('CANCEL-ME');
await clickIf('#chat-queued .queue-x');
const cancelled = await shape();
check('the × takes a waiting message back out',
	cancelled.waiting.length === 0, JSON.stringify(cancelled.waiting));
await idle();
await sleep(1500);
const afterCancel = await shape();
check('and a cancelled message is never sent, to the turn or after it',
	!/CANCEL-ME/.test(afterCancel.text), afterCancel.text.slice(-80).replace(/\n/g, ' '));

// ── 6. Stop still hands back what was typed ──────────────────────────
const beforeStop = await shape();
await p.fill('#chat-input', '@long 120');
await p.click('#chat-send', { force: true });
await sleep(1500);
await type('AFTER-STOP');
await p.click('#chat-send', { force: true });        // box empty: this is Stop
await sleep(2500);
const stopped = await shape();
check('Stop returns what was said into the turn to the composer, unsent',
	stopped.composer === 'AFTER-STOP' && stopped.waiting.length === 0,
	`composer=${JSON.stringify(stopped.composer)} waiting=${JSON.stringify(stopped.waiting)}`);
check('and says so, rather than leaving the text to be wondered about',
	(await toasts()).some(x => x.err && /unsent|back in the box/i.test(x.text)),
	JSON.stringify((await toasts()).slice(-2)));
await sleep(3000);
const afterStop = await shape();
check('nothing said into a stopped turn is sent after it',
	afterStop.users === beforeStop.users + 1,
	`${beforeStop.users} → ${afterStop.users} (the stopped turn only)`);
await p.fill('#chat-input', '');
await shot(s, 'interject-stopped');

// ── 7. A chat left in the background is unchanged ────────────────────
//
// The queue is still the right answer for a conversation the user has walked
// away from: runTurn draws into the live thread, so a turn started for a chat in
// the background would write itself into the one on screen. It waits there,
// badged, and drains on return -- which is what it did before any of this.
const tiles = () => p.evaluate(() => [...document.querySelectorAll('#session-list .session-box')]
	.map(b => ({
		id:    b.dataset.id,
		badge: (b.querySelector('.queue-badge') || {}).textContent || '',
	})));
async function addChat() {
	await p.click('#new-session-btn', { force: true });
	await sleep(400);
	const start = p.locator('.tile-start').first();
	if (await start.count()) await start.click({ force: true });
	await sleep(500);
}
async function openTile(id) {
	await p.evaluate((cid) => {
		const box = [...document.querySelectorAll('#session-list .session-box')]
			.find(b => b.dataset.id === cid);
		if (box) box.click();
	}, id);
	await sleep(600);
}

const beforeB = (await tiles()).map(x => x.id);
await addChat();
const chatB = (await tiles()).map(x => x.id).find(id => beforeB.indexOf(id) === -1) || '';
const chatA = beforeB[0] || '';
check('a second chat can be opened beside the first', !!chatA && !!chatB && chatA !== chatB,
	`A=${chatA} B=${chatB}`);

await openTile(chatA);
await p.fill('#chat-input', '@long 30');
await p.click('#chat-send', { force: true });
await sleep(1200);
await type('LEFT-BEHIND');
await openTile(chatB);
const away = await tiles();
check('the tile of the chat left behind still says something is waiting on it',
	!!(away.find(x => x.id === chatA) || {}).badge,
	JSON.stringify((away.find(x => x.id === chatA) || {}).badge));
check('and the chat being looked at is not badged for someone else’s',
	!(away.find(x => x.id === chatB) || {}).badge);
await sleep(7000);
const stillAway = await tiles();
check('it is still there once that turn has finished — nothing is sent behind your back',
	!!(stillAway.find(x => x.id === chatA) || {}).badge,
	JSON.stringify((stillAway.find(x => x.id === chatA) || {}).badge));

await openTile(chatA);
await idle();
await sleep(1500);
const returned = await shape();
const cleared  = await tiles();
check('going back to the chat sends what was left on it, as a real turn',
	/LEFT-BEHIND/.test(returned.userText), returned.userText.slice(-120));
check('as a turn, not a bubble, with the numbering still unbroken',
	returned.waiting.length === 0
	&& returned.turns === Array.from({ length: returned.users }, (_, i) => i + 1).join(','),
	`waiting=${JSON.stringify(returned.waiting)} turns=${returned.turns}`);
check('and the badge clears once it has gone',
	!(cleared.find(x => x.id === chatA) || {}).badge,
	JSON.stringify((cleared.find(x => x.id === chatA) || {}).badge));
await shot(s, 'interject-background');

// ── 8. It survives a reload, drawn where it landed ───────────────────
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(1500);
await signInAs(s, 'interject');      // a reload lands on the passphrase gate
await sleep(1500);
await openTile(chatA);
await sleep(800);
const reloaded = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	if (!out) return { cuts: [], users: 0 };
	return {
		cuts:  [...out.querySelectorAll('.chat-msg-interjected .chat-msg-content')].map(e => e.textContent),
		users: out.querySelectorAll('.chat-msg-user').length,
	};
});
check('a landed message is still in the transcript after a reload',
	reloaded.cuts.includes(CUT), JSON.stringify(reloaded.cuts));
check('and is still not counted as a question of its own',
	reloaded.users > 0 && !reloaded.cuts.some(c => c === ''), `${reloaded.users} user turns`);

const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 5));
check('nothing throws while all this happens', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
