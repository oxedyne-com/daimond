// You must be able to work in a second chat while the first is still running,
// and Stop must hit the chat you are looking at — not whichever started last.
import { open, newChat, shot, errors } from './harness.mjs';

const s = await open({ name: 'multichat' });

// Chat A: start a LONG turn (streams slowly), do not wait for it.
await newChat(s);
await s.page.fill('#chat-input', '@long 200');
await s.page.click('#chat-send');
await s.page.waitForTimeout(800);

const aRunning = await s.page.evaluate(() => {
	const b = document.getElementById('chat-send');
	return { stopMode: /stop/i.test((b.getAttribute('title')||'') + (b.className||'')), disabled: document.getElementById('chat-input').disabled };
});
console.log('chat A running:', JSON.stringify(aRunning));

// Start a SECOND chat while A still streams.
await s.page.click('#new-session-btn');
await s.page.waitForTimeout(400);
// Start the pending tile. `.tile-start` by class, NOT has-text("Start") —
// the substring match also hits the BYOK form's hidden "Save & start".
const startBtn = s.page.locator('.tile-start').first();
if (await startBtn.count()) await startBtn.click();
await s.page.waitForTimeout(600);

const bComposer = await s.page.evaluate(() => {
	const inp = document.getElementById('chat-input');
	const b = document.getElementById('chat-send');
	return { inputDisabled: inp.disabled, stopMode: /stop/i.test((b.getAttribute('title')||'') + (b.className||'')) };
});
console.log('chat B composer (should be usable, send-mode):', JSON.stringify(bComposer));

// Type and send in B while A still runs.
let bSent = false;
if (!bComposer.inputDisabled) {
	await s.page.fill('#chat-input', '@text Reply in B');
	await s.page.click('#chat-send');
	await s.page.waitForTimeout(3000);
	const bText = await s.page.evaluate(() => document.getElementById('chat-output').innerText);
	bSent = /Reply in B/.test(bText);
}
await shot(s, 'multichat-B-active');

// The composer is NOT disabled mid-turn any more: a turn cannot be interrupted, but the next
// thing to say can be typed while the answer arrives and is sent when the turn ends. Stop-mode on
// the send button is the signal that a turn is running; an unusable box never was.
console.log('\nA STARTED (stop-mode + composer live):', aRunning.stopMode && !aRunning.disabled);
console.log('B USABLE WHILE A RUNS (input enabled, send-mode):', !bComposer.inputDisabled && !bComposer.stopMode);
console.log('B TURN COMPLETED WHILE A RAN:', bSent);
console.log('errors:', errors(s));
await s.close();
