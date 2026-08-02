// verify_announce.mjs — a screen reader is told when an answer arrives, once.
//
// dev/a11y_report.md §8: nothing that changes on its own is announced. The chat
// was the worst of it -- press Send and a screen-reader user hears nothing, ever,
// neither the arrival of an answer nor its end.
//
// The obvious fix is the wrong one, which is why this file exists to pin the
// right one. `aria-live` on the thread reads EVERY change, and an answer arrives
// a few characters at a time, so the reader would hear it re-read at them in
// fragments for as long as the model kept typing. What is checked here is
// therefore two things at once:
//
//   1. The answer IS announced, once per turn, with the word count.
//   2. The thread itself is NOT live -- because a future change that "improves"
//      this by marking the thread live would pass a naive test and make the app
//      unusable for exactly the person it was meant to help.
//
// And the two popovers, from the same round: both are role="dialog", both cover
// the app, and Tab used to walk out of them into the page behind.
import { open, newChat, chat as sendChat } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};

const s = await open({ name: 'announce' });
const p = s.page;
await p.waitForTimeout(1500);
await newChat(s);

// ── 1. The thread is silent ─────────────────────────────────────────
const thread = await p.evaluate(() => {
	const el = document.getElementById('chat-output');
	return el ? {
		live: el.getAttribute('aria-live'),
		role: el.getAttribute('role'),
	} : null;
});
check('the streaming thread is NOT a live region', !!thread && !thread.live && thread.role !== 'log',
	JSON.stringify(thread));

// ── 2. There is a status line, and it starts empty ──────────────────
const before = await p.evaluate(() => {
	const el = document.getElementById('chat-say');
	return el ? { live: el.getAttribute('aria-live'), role: el.getAttribute('role'),
		text: (el.textContent || '').trim(),
		painted: el.getClientRects().length > 0 && el.clientWidth > 1 } : null;
});
check('there is a polite status line for the chat', !!before && before.live === 'polite',
	JSON.stringify(before && before.live));
check('it is a status role', !!before && before.role === 'status');
check('it says nothing before a turn', !!before && before.text === '',
	JSON.stringify(before && before.text));
check('and it is not drawn on screen', !!before && before.painted === false);

// ── 3. One turn, one announcement, with the count ───────────────────
await sendChat(s, '@text One two three four five');
await p.waitForTimeout(1200);

const said = await p.evaluate(() =>
	(document.getElementById('chat-say').textContent || '').trim());
check('the answer is announced when it lands', /answered/i.test(said), JSON.stringify(said));
const n = (said.match(/(\d+)/) || [])[1];
check('the announcement carries a word count', !!n && Number(n) > 0, String(n));

// It must match what was actually said, not a guess.
const words = await p.evaluate(() => {
	const msgs = [...document.querySelectorAll('.chat-msg-content')];
	const last = msgs[msgs.length - 1];
	return last ? (last.textContent || '').trim().split(/\s+/).filter(Boolean).length : 0;
});
check('the count is the answer\'s own length', Math.abs(Number(n) - words) <= 1,
	`announced ${n}, on screen ${words}`);

// ── 4. A second turn of the same length still announces ─────────────
//
// The trap in a status line: writing the identical string is not a change, so the
// second announcement would be silent. This is the case that catches it.
await sendChat(s, '@text One two three four five');
await p.waitForTimeout(1200);
const second = await p.evaluate(() => {
	const el = document.getElementById('chat-say');
	return { text: (el.textContent || '').trim() };
});
check('a second answer of the same length is still announced',
	/answered/i.test(second.text), JSON.stringify(second.text));

// ── 5. The two popovers hold Tab ────────────────────────────────────
//
// Walked, not read: open the popover, press Tab past its last stop, and ask
// whether the focus is still inside it.
async function trapped(openSel, popSel, label) {
	await p.evaluate((sel) => {
		const b = document.querySelector(sel);
		if (b) b.click();
	}, openSel);
	await p.waitForTimeout(500);
	const stops = await p.evaluate((sel) => {
		const pop = document.querySelector(sel);
		if (!pop || pop.hidden) return 0;
		return pop.querySelectorAll('input,button,select,textarea,a[href],[tabindex]:not([tabindex="-1"])').length;
	}, popSel);
	if (!stops) { check(`${label} opened so its Tab can be walked`, false, '0 stops'); return; }
	for (let i = 0; i < stops + 3; i++) await p.keyboard.press('Tab');
	const inside = await p.evaluate((sel) => {
		const pop = document.querySelector(sel);
		return !!pop && pop.contains(document.activeElement);
	}, popSel);
	check(`${label} keeps Tab inside it (${stops} stops, walked ${stops + 3})`, inside === true);
	await p.keyboard.press('Escape');
	await p.waitForTimeout(300);
}

await trapped('#settings-menu-btn', '#settings-menu', 'the appearance menu');
// The ⋯ that opens the gallery exists only when the chip row has had to hide
// something, so the window is narrowed until it does. Opening the gallery by
// reaching into the module would test a door nobody walks through.
await p.setViewportSize({ width: 900, height: 800 });
await p.waitForTimeout(600);
const haveMore = await p.evaluate(() => !!document.getElementById('panel-more'));
check('the chip row hid something, so the gallery has an opener', haveMore === true);
if (haveMore) await trapped('#panel-more', '#panel-gallery', 'the panel gallery');

console.log('');
console.log(bad.length
	? `${bad.length} FAILED of ${ok.length + bad.length}:\n  - ${bad.join('\n  - ')}`
	: `announce: all ${ok.length} checks pass — one announcement per answer, and the popovers hold Tab.`);
await s.close();
process.exit(bad.length ? 1 : 0);
