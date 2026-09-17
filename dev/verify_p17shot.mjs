// #17 vision pass — screenshot the fold running on the chat face.
// Reuses world 4 (app :8781, mock :9103). Delays the reducer round so the
// "Fold: reducing" stage is visible, then screenshots.
import fs from 'node:fs';
import { open, connectMock, scratch, shot } from './harness.mjs';

// Tell the world-4 mock to answer the fold with a STRUCTURED note, so the fold
// actually commits and settles rather than echoing the transcript back.
fs.writeFileSync('/home/jason/usr/code/web/apps/oxedyne/daimond/dev/mockllm-4.log.fold', 'structured');

process.env.DAIMOND_APP = process.env.DAIMOND_APP || 'http://localhost:8781';
process.env.DAIMOND_MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9103/v1/chat/completions';
process.env.DAIMOND_SCRATCH = process.env.DAIMOND_SCRATCH
	|| '/home/jason/usr/code/web/apps/oxedyne/daimond/.scratch';

const s = await open({ name: 'p17shot', profile: scratch('pw', 'p17shot-' + process.pid) });
const { page: p } = s;
await connectMock(s, { model: 'deepseek/deepseek-v4-pro' });

// A diamond + a daimon chat with one message, so the fold has something to reduce.
await p.evaluate(() => document.getElementById('new-diamond-btn').click());
await p.waitForSelector('.dlg-card', { timeout: 8000 });
await p.evaluate(() => {
	const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
	const inp = card.querySelector('input.dlg-input');
	inp.value = 'P17'; inp.dispatchEvent(new Event('input', { bubbles: true }));
	card.querySelector('.dlg-ok').click();
});
await p.waitForTimeout(1400);
const id = await p.evaluate(() => {
	const box = [...document.querySelectorAll('.diamond-box')].find((b) => (b.textContent || '').includes('P17'));
	return box ? box.dataset.id : '';
});
await p.evaluate((i) => { document.querySelector(`.diamond-box[data-id="${i}"]`).click(); }, id);
await p.waitForTimeout(600);
await p.click('#dview-chat', { force: true });
await p.waitForTimeout(600);
await p.fill('#chat-input', 'remember the word ORTOLAN for me');
await p.click('#chat-send', { force: true });
await p.waitForTimeout(3000);   // the turn answers (fast mock)

// Now slow the reducer round so the "reducing" stage is on screen long enough.
await p.route('**/v1/chat/completions', async (route) => {
	await new Promise((r) => setTimeout(r, 6000));
	await route.continue();
});

const foldVisible = await p.evaluate(() => {
	const b = document.getElementById('chat-fold-btn');
	return b && getComputedStyle(b).display !== 'none';
});
console.log('fold button visible:', foldVisible);

await p.click('#chat-fold-btn', { force: true });
await p.waitForTimeout(1500);   // inside the reducer round -> "Fold: reducing"
const during = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const tile = out && [...out.querySelectorAll('.tool-block.running')].pop();
	return {
		out: out ? out.innerText : '',
		tile: tile ? tile.innerText : '',
		cls: tile ? tile.className : '',
		lbl: tile && tile._lbl ? tile._lbl.textContent : '',
		body: tile && tile._body ? tile._body.textContent : '',
	};
});
console.log('DURING FOLD transcript:', JSON.stringify(during.out));
console.log('DURING FOLD tile:', JSON.stringify(during.tile), 'class:', during.cls);
await shot(s, 'p17-fold');

// Let the fold finish, then screenshot the settled state.
await p.waitForTimeout(7000);
const after = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const tiles = out ? [...out.querySelectorAll('.tool-block')].map((t) => t.innerText) : [];
	return { out: out ? out.innerText : '', tiles };
});
console.log('AFTER FOLD transcript:', JSON.stringify(after.out));
console.log('AFTER FOLD tiles:', JSON.stringify(after.tiles));
await shot(s, 'p17-fold-after');

await s.close();
process.exit(0);
