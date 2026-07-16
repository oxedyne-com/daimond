// What happens when a chat is started?
import { open, shot } from './harness.mjs';

const s = await open({ name: 'probe2' });
await shot(s, 'q0-connected');

await s.page.click('#new-session-btn');
await s.page.waitForTimeout(1500);
await shot(s, 'q1-after-newchat');

const st = await s.page.evaluate(() => {
	const vis = (el) => {
		if (!el) return 'absent';
		const r = el.getBoundingClientRect(); const c = getComputedStyle(el);
		return (r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden')
			? 'visible' : 'hidden';
	};
	const ai = document.querySelector('[data-panel="ai"][data-zone="stage"]');
	return {
		chatInput:  vis(document.getElementById('chat-input')),
		chatSend:   vis(document.getElementById('chat-send')),
		composer:   vis(document.querySelector('.composer, .chat-composer, #chat-composer')),
		aiPanel:    vis(ai),
		aiHTML:     ai ? ai.innerText.slice(0, 400) : '(no ai panel)',
		modal:      vis(document.querySelector('.modal:not([style*="display:none"])')),
		openModals: [...document.querySelectorAll('.modal')]
			.filter(m => getComputedStyle(m).display !== 'none').map(m => m.id),
		chatList:   (document.querySelector('#session-list, .chat-list') || {}).innerText || '(none)',
	};
});
console.log(JSON.stringify(st, null, 2));
console.log('ERRORS:', s.errs);
await s.close();
