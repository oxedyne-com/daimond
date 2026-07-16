// shot_mobile.mjs — capture the phone shell for the eye, not the assertion.
import { open } from './harness.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const s = await open({ signIn: true, connect: true, name: 'mobileshots' });
const { page } = s;
// Never let a hung webfont fetch stall document.fonts.ready (and the screenshot).
await page.route('**/*.{woff,woff2,ttf,otf}', r => r.abort());
await page.setViewportSize({ width: 390, height: 844 });
await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
await sleep(300);
// connectMock leaves the settings modal up; take it down for a clean floor.
await page.evaluate(() => { try { window.DaimondAdmin.closeModal(); } catch (e) {} const m = document.getElementById('settings-modal'); if (m) m.style.display = 'none'; });
await sleep(200);

// A started chat, so the floor is a real conversation.
await page.evaluate(() => { try { document.getElementById('new-session-btn').click(); } catch (e) {} });
await sleep(300);
await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => /^Start$/.test(x.textContent.trim())); if (b) b.click(); });
await sleep(400);
await page.evaluate(() => {
	// A couple of turns of copy so the floor reads like a conversation.
	const out = document.getElementById('chat-output'); if (!out) return;
	out.insertAdjacentHTML('beforeend',
		'<div class="chat-msg chat-msg-user"><div class="chat-msg-content">What did the invoice from Acme say?</div></div>' +
		'<div class="chat-msg chat-msg-assistant"><div class="chat-msg-content">It totals £1,240, due on the 30th. Want me to open it beside us?</div></div>');
});
await sleep(200);
// Playwright's screenshot waits on document.fonts.ready, which never settles
// here; CDP's captureScreenshot does not, so use it directly.
import { writeFileSync } from 'node:fs';
const cdp = await s.browser.newCDPSession(page);
const shot = async (p) => {
	try {
		const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(p, Buffer.from(data, 'base64'));
		console.log('shot ' + p);
	} catch (e) { console.log('SKIP ' + p + ' — ' + e.message.split('\n')[0]); }
};

await shot('shots/mobile-1-floor.png');

// The drawer.
await page.evaluate(() => document.getElementById('drawer-btn').click());
await sleep(400);
await shot('shots/mobile-2-drawer.png');
await page.evaluate(() => document.getElementById('scrim').click());
await sleep(400);

// A message, risen as a sheet at its half detent — the thing beside the daimon.
await page.evaluate(() => {
	const head = document.getElementById('msg-head'), body = document.getElementById('msg-body');
	if (head) head.innerHTML = '<div class="msg-subject" style="font-weight:600;font-size:16px;margin-bottom:6px">Invoice #4021 — Acme Ltd</div><div style="color:var(--text-muted);font-size:13px">accounts@acme.example · 14 Jul</div>';
	if (body) body.innerHTML = '<p>Dear customer,</p><p>Please find attached invoice #4021 for services rendered in June, totalling <b>£1,240.00</b>, payable by 30 July.</p><p>Kind regards,<br>Acme Ltd Accounts</p>';
	window.DaimondPanels.show('msg');
});
await sleep(500);
await shot('shots/mobile-3-sheet-half.png');

// Raised to full for immersive reading.
await page.evaluate(() => { const g = document.getElementById('msheet-grab'); /* nudge to full via API-free path */ });
await sleep(100);
await s.close();
console.log('done');
