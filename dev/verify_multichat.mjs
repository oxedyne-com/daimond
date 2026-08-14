// You must be able to work in a second chat while the first is still running.
//
// THE HEADER USED TO SAY "and Stop must hit the chat you are looking at -- not
// whichever started last". Nothing below has ever pressed Stop, so the sentence
// has gone: a claim in a comment is not a check, and this one had been read as
// one for as long as the file has existed.
//
// WHAT THE SECOND CHAT'S REPLY IS LOOKED FOR IN. `bSent` used to be
// `/Reply in B/.test(#chat-output innerText)`, and the phrase it looked for is
// the one this file TYPES: the transcript renders the user's own message, so the
// check passed on a turn that never got an answer at all -- the same defect
// verify_backup had. The reply is now a nonce the mock is asked to say back, and
// it is looked for in `.chat-msg-assistant` alone.
//
// PROVED AGAINST TWO BREAKS FIRST:
//   --break noreply   B's message is sent with `@err 500`, so the user's line is
//                     rendered and no assistant message ever arrives. The old
//                     check went green on exactly that; this one must go red.
//   --break shorta    A's turn is short enough to be over before B's finishes,
//                     which is the state every run of this file could have been
//                     in without anybody knowing.
//
//   node dev/verify_multichat.mjs --break noreply   # expected to FAIL
//   node dev/verify_multichat.mjs --break shorta    # expected to FAIL
//   node dev/verify_multichat.mjs                   # and then, clean
import { open, newChat, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && !['noreply', 'shorta'].includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; known: noreply, shorta`);
	process.exit(2);
}

const s = await open({ name: 'multichat' });
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

// Chat A: start a LONG turn (streams slowly), do not wait for it.
await newChat(s);
// `shorta` gives A a turn that is over before B's is: still running when the
// first check looks (2.4s of chunks), finished long before the last one does.
await s.page.fill('#chat-input', BREAK === 'shorta' ? '@long 20' : '@long 200');
await s.page.click('#chat-send');
await s.page.waitForTimeout(800);

const aRunning = await s.page.evaluate(() => {
	const b = document.getElementById('chat-send');
	return { stopMode: /stop/i.test((b.getAttribute('title') || '') + (b.className || '')), disabled: document.getElementById('chat-input').disabled };
});
// The composer is NOT disabled mid-turn any more: a turn cannot be interrupted, but the next
// thing to say can be typed while the answer arrives and is sent when the turn ends. Stop-mode on
// the send button is the signal that a turn is running; an unusable box never was.
check('A LONG TURN IN CHAT A IS RUNNING — stop-mode on the send button, composer still live',
	aRunning.stopMode && !aRunning.disabled, JSON.stringify(aRunning));

// Start a SECOND chat while A still streams.
await s.page.click('#new-session-btn');
await s.page.waitForTimeout(400);
// Start the pending tile. `.tile-start` by class, NOT has-text("Start") —
// the substring match also hits the BYOK form's hidden "Save & start".
const startBtn = s.page.locator('.tile-start').first();
const started = await startBtn.count();
// This used to be a bare `if`: with no Start button the file went on to measure
// chat A a second time and printed three greens about it.
check('a second chat can be started while the first one runs', !!started, `${started} .tile-start on the rail`);
if (started) await startBtn.click();
await s.page.waitForTimeout(600);

const bComposer = await s.page.evaluate(() => {
	const inp = document.getElementById('chat-input');
	const b = document.getElementById('chat-send');
	return { inputDisabled: inp.disabled, stopMode: /stop/i.test((b.getAttribute('title') || '') + (b.className || '')) };
});
check('CHAT B IS USABLE WHILE A RUNS — input enabled, and its send button is in send-mode not stop-mode',
	!bComposer.inputDisabled && !bComposer.stopMode, JSON.stringify(bComposer));

// Type and send in B while A still runs. The nonce is what the mock is asked to
// say back, so finding it in an ASSISTANT bubble is the answer arriving.
const NONCE = 'replyB-' + Math.random().toString(36).slice(2, 8);
let b = { user: false, asst: false, text: '' };
if (!bComposer.inputDisabled) {
	await s.page.fill('#chat-input', BREAK === 'noreply' ? `@err 500 ${NONCE}` : `@text ${NONCE}`);
	await s.page.click('#chat-send');
	await s.page.waitForTimeout(4000);
	b = await s.page.evaluate((nonce) => {
		const txt = (sel) => [...document.querySelectorAll(sel)].map(e => e.textContent).join('\n');
		const asst = txt('#chat-output .chat-msg-assistant .chat-msg-content');
		return {
			user: txt('#chat-output .chat-msg-user .chat-msg-content').includes(nonce),
			asst: asst.includes(nonce),
			text: asst.slice(-120),
		};
	}, NONCE);
}
await shot(s, 'multichat-B-active');

check('B\'s message was accepted into B\'s transcript', b.user, `looking for ${NONCE} in .chat-msg-user`);
check('B\'S TURN ANSWERED WHILE A RAN — the answer is in an assistant bubble, not merely the line we typed',
	b.asst, `looking for ${NONCE} in .chat-msg-assistant, which holds ${JSON.stringify(b.text)}`);

// "WHILE A RAN" WAS NEVER CHECKED. A's turn was seen to start and was never
// looked at again, so a run in which it had finished before B was even opened
// read exactly the same. It streams 200 chunks at 120ms each in the mock (24s of
// server-side sleep, whatever this machine's speed), and everything above takes
// about eight -- so it must still be going, and the composer says so when the
// tile is selected again.
const idle = s.page.locator('#session-list .session-box:not(.active)');
const others = await idle.count();
check('chat A is still on the rail, unselected', others === 1, `${others} unselected chat tiles`);
let back = { stopMode: null };
if (others === 1) {
	await idle.first().click();
	await s.page.waitForTimeout(700);
	back = await s.page.evaluate(() => {
		const b = document.getElementById('chat-send');
		return { stopMode: /stop/i.test((b.getAttribute('title') || '') + (b.className || '')) };
	});
}
check('AND A WAS STILL RUNNING THROUGHOUT — its own composer is still in stop-mode',
	back.stopMode === true, `stop-mode=${back.stopMode}`);

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
