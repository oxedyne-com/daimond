// A steer turn that answers in words (no brief edit, no dispatch) must SHOW those
// words, not silently bill and vanish.
import { open, shot, errors } from './harness.mjs';

const s = await open({ name: 'steer' });

// Create a Focus via the real button + prompt dialog.
await s.page.click('#new-focus-btn');
await s.page.waitForSelector('.dlg-input', { timeout: 8000 });
await s.page.fill('.dlg-input', 'Test Focus');
await s.page.click('.dlg-ok');
await s.page.waitForTimeout(1200);
await shot(s, 'steer-0-after-newfocus');

const state = await s.page.evaluate(() => ({
	steer: !!document.getElementById('steer-input'),
	reply: !!document.getElementById('brief-reply'),
}));
console.log('state after new focus:', JSON.stringify(state));

// If we have a steer input, drive a text-only steer.
if (state.steer) {
	await s.page.fill('#steer-input', '@text I need one clarification: which platform first?');
	await s.page.keyboard.press('Enter');
	await s.page.waitForTimeout(4000);
	const r = await s.page.evaluate(() => {
		const el = document.getElementById('brief-reply');
		return { shown: el && el.style.display !== 'none', text: el ? el.textContent : '' };
	});
	await shot(s, 'steer-1-reply');
	console.log('reply shown:', r.shown, 'text:', JSON.stringify((r.text||'').slice(0,120)));
	console.log('\nTEXT-ONLY STEER SURFACED:', r.shown && /clarification|platform/i.test(r.text));
} else {
	console.log('could not reach steer input — see screenshot');
}
console.log('errors:', errors(s));
await s.close();
