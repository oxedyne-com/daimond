// verify_queue.mjs — you may type while the answer is still arriving.
//
// The composer used to be disabled for the whole turn, so the next thing you
// wanted to say had to be held in your head until the model finished. It is held
// by the app now: queued, shown, and sent as its OWN turn the moment the turn
// lock is free. A turn cannot be joined mid-flight -- the wasm side holds the
// session for its whole length -- so this is queue-and-send-after, not injection.
//
// The check that matters most is the third one. A turn is the unit a fold picks
// and the unit the numbering counts, so a queued bubble that wore `.chat-msg-user`
// would be a turn that does not exist: every ticked turn would map one message
// out, and a fold would quietly send the wrong text to the reducer. So the queue
// is asserted to leave `userDivs()` and every `data-turn` exactly as they were.
//
//   node dev/verify_queue.mjs
//
// Needs dev/serve.mjs on :8777 and dev/mockllm.mjs on :9099. No gateway.

import { open, newChat, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const s = await open({ name: 'queue' });
const p = s.page;

// Record toasts as they appear: they remove themselves after ~4s.
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

/// The shape of the thread: the real turns, and the queue beside them.
const shape = () => p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const users = [...out.querySelectorAll('.chat-msg-user')];
	const q = [...out.querySelectorAll('.chat-msg-queued')];
	const box = document.getElementById('chat-queued');
	return {
		users: users.length,
		turns: users.map(u => u.dataset.turn).join(','),
		userText: users.map(u => u.querySelector('.chat-msg-content').textContent).join(' | '),
		queued: q.map(e => e.querySelector('.chat-msg-content').textContent),
		queuedAreUsers: q.filter(e => e.classList.contains('chat-msg-user')).length,
		boxIsLast: !!box && box === out.lastElementChild,
		inputDisabled: document.getElementById('chat-input').disabled,
		composer: document.getElementById('chat-input').value,
		stopMode: /stop/i.test((document.getElementById('chat-send').getAttribute('title') || '')
			+ (document.getElementById('chat-send').className || '')),
		busy: !!(window.DaimondCore && window.DaimondCore.busy()),
	};
});
/// Wait until the send button offers Send again — the app's own idea of "done".
async function idle(timeout = 60000) {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		if (!(await shape()).stopMode) return true;
		await sleep(250);
	}
	return false;
}
/// Type into the composer and press Enter, which is how a message is sent — and,
/// mid-turn, how it is queued.
async function type(text) {
	await p.fill('#chat-input', text);
	await p.press('#chat-input', 'Enter');
	await sleep(400);
}
/// Click something if it is there. A verifier has to be able to RUN against the
/// code before the fix, where these controls do not exist at all — a hard click
/// would abort the pass with a Playwright timeout instead of failing the check
/// that is meant to catch it.
async function clickIf(sel) {
	const el = await p.$(sel);
	if (!el) return false;
	await el.click({ force: true });
	await sleep(400);
	return true;
}

await newChat(s);

// ── 1. The composer stays live while a turn runs ─────────────────────
// `@long` streams 120 chunks at 120ms, so there is a good half-minute of turn
// to type into.
await p.fill('#chat-input', '@long 120');
await p.click('#chat-send', { force: true });
await sleep(1500);
const running = await shape();
check('the composer is not disabled while the answer arrives',
	running.inputDisabled === false, `disabled=${running.inputDisabled}`);
check('and Send still means Stop while it runs (the signal everything else reads)',
	running.stopMode === true);
const ph = await p.$eval('#chat-input', e => e.placeholder);
check('the box invites the next message rather than looking dead',
	/next/i.test(ph), ph);

// ── 2/3. Queueing adds a bubble and NOT a turn ───────────────────────
const before = await shape();
await type('QUEUED-ONE');
const after = await shape();
check('a message typed mid-turn appears as a queued bubble',
	after.queued.length === 1 && after.queued[0] === 'QUEUED-ONE', JSON.stringify(after.queued));
check('the bubble is not a user message: no new .chat-msg-user',
	after.users === before.users && after.queuedAreUsers === 0,
	`users ${before.users} → ${after.users}, queued-wearing-user=${after.queuedAreUsers}`);
check('and every existing turn number is untouched',
	after.turns === before.turns, `${before.turns} → ${after.turns}`);
check('the composer is cleared, as it is on an ordinary send',
	after.composer === '', JSON.stringify(after.composer));
check('the queue sits at the bottom of the thread, under what has happened',
	after.boxIsLast === true);
check('a queue on its own counts as work in flight (the updater must not reload it away)',
	after.busy === true);
const qhead = await p.$eval('.chat-queued-head', e => e.textContent).catch(() => '');
check('and the queue says when what is in it will be sent',
	/finish/i.test(qhead), qhead || '(no head line)');
await shot(s, 'queue-waiting');

// ── 4. A second one queues behind the first, in order ────────────────
await type('QUEUED-TWO');
const two = await shape();
check('a second message queues behind the first, in order',
	JSON.stringify(two.queued) === JSON.stringify(['QUEUED-ONE', 'QUEUED-TWO']), JSON.stringify(two.queued));

// ── 5. Both are sent, as two separate turns, in order ────────────────
await idle(90000);
await sleep(1200);
await idle(90000);          // the second queued turn
await sleep(1500);
const drained = await shape();
check('every queued message became a real turn of its own',
	drained.users === before.users + 2, `${before.users} → ${drained.users} user turns`);
check('in the order they were typed',
	/QUEUED-ONE[\s\S]*QUEUED-TWO/.test(drained.userText), drained.userText.slice(0, 160));
check('and the turns are numbered without a gap, so a fold still maps them',
	drained.turns === Array.from({ length: drained.users }, (_, i) => i + 1).join(','), drained.turns);
check('nothing is left queued once it has been sent',
	drained.queued.length === 0 && drained.busy === false, JSON.stringify(drained.queued));
await shot(s, 'queue-drained');

// ── 6. The × drops one without sending it ────────────────────────────
await p.fill('#chat-input', '@long 60');
await p.click('#chat-send', { force: true });
await sleep(1200);
await type('CANCEL-ME');
await clickIf('.chat-msg-queued .queue-x');
const cancelled = await shape();
check('the × takes a queued message back out',
	cancelled.queued.length === 0, JSON.stringify(cancelled.queued));
await idle(90000);
await sleep(1000);
const afterCancel = await shape();
check('and a cancelled message is never sent',
	!/CANCEL-ME/.test(afterCancel.userText), afterCancel.userText.slice(-80));

// ── 7. Clicking a queued bubble puts it back in the composer to edit ─
await p.fill('#chat-input', '@long 60');
await p.click('#chat-send', { force: true });
await sleep(1200);
await type('EDIT-ME');
await clickIf('.chat-msg-queued .chat-msg-content');
const edited = await shape();
check('clicking a queued message puts it back in the box to be changed',
	edited.composer === 'EDIT-ME' && edited.queued.length === 0,
	`composer=${JSON.stringify(edited.composer)} queued=${JSON.stringify(edited.queued)}`);
// That turn is still streaming, and the next check needs the button to mean Send
// when it presses it: clicking Stop-by-accident is how this test lied the first
// time it was written.
await p.fill('#chat-input', '');
await idle(90000);
await sleep(1000);

// ── 8. Stop hands the queue back rather than sending it ──────────────
const beforeStop = await shape();
await p.fill('#chat-input', '@long 120');
await p.click('#chat-send', { force: true });
await sleep(1500);
await type('AFTER-STOP');
await p.click('#chat-send', { force: true });        // in stop-mode: kills the turn
await sleep(2500);
const stopped = await shape();
check('Stop returns what was queued to the composer, unsent',
	stopped.composer === 'AFTER-STOP' && stopped.queued.length === 0,
	`composer=${JSON.stringify(stopped.composer)} queued=${JSON.stringify(stopped.queued)}`);
check('and says so, rather than leaving the text to be wondered about',
	(await toasts()).some(x => x.err && /unsent|back in the box/i.test(x.text)),
	JSON.stringify((await toasts()).slice(-2)));
await sleep(3000);
const afterStop = await shape();
check('nothing queued behind a stopped turn is sent',
	afterStop.users === beforeStop.users + 1, `${beforeStop.users} → ${afterStop.users} (the stopped turn only)`);
await shot(s, 'queue-stopped');

const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 5));
check('nothing throws while all this happens', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
