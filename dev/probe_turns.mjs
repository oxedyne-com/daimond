// A ruler, not a test: what the turn controls actually measure in the page.
import { open, chat, shot } from './harness.mjs';

const s = await open({ name: 'probe-turns' });
const p = s.page;
await chat(s, '@text hello there');
await chat(s, '@text and again, at slightly greater length so the thread has some height');

const r = () => p.evaluate(() => {
	const box = el => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top) }; };
	const head  = document.querySelector('.panel.ai .chead');
	const title = document.getElementById('current-session-name');
	const tick  = document.querySelector('.turn-pick');
	return {
		inputH: box(document.getElementById('chat-input')).h,
		sendH:  box(document.getElementById('chat-send')).h,
		jumpH:  box(document.getElementById('chat-jump')).h,
		sendTop: box(document.getElementById('chat-send')).top,
		inputTop: box(document.getElementById('chat-input')).top,
		headOverflow: head.scrollWidth - head.clientWidth,
		titleW: title ? box(title).w : 0,
		titleText: title ? title.textContent : '',
		titleTruncated: title ? title.scrollWidth > title.clientWidth + 1 : null,
		tickW: tick ? box(tick).w : 0,
		selecting: document.getElementById('collapse-btn').classList.contains('on'),
	};
});

console.log('normal  ', JSON.stringify(await r()));
await p.evaluate(() => document.getElementById('collapse-btn').click());
await p.waitForTimeout(300);
console.log('selecting', JSON.stringify(await r()));
await shot(s, 'turns-probe');
await s.close();
