// The selected chat tile under the Breathe spacing: is its ring inside the box
// the list is entitled to clip?
import { open, shot, newChat } from '/home/jason/usr/code/web/apps/oxedyne/daimond/dev/harness.mjs';

const SP = new URL('shots/', import.meta.url).pathname;
const s = await open({ name: 'tile' });
const { page } = s;
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

// A chat first, while the app is in the state open() left it in, then the
// Breathe spacing applied in place -- a reload here loses the mock connection
// and the chat input never appears.
await newChat(s);
await page.waitForTimeout(400);
await page.evaluate(() => {
	localStorage.setItem('daimond-skin', 'warm');
	document.documentElement.setAttribute('data-skin', 'warm');
});
await page.waitForTimeout(500);
await page.waitForSelector('.session-box', { timeout: 8000 }).catch(() => {});
const boxes = await page.$$('.session-box');
if (boxes.length) { await boxes[0].click({ force: true }); await page.waitForTimeout(500); }

const m = await page.evaluate(() => {
	const box = document.querySelector('.session-box.active') || document.querySelector('.session-box');
	if (!box) return { err: 'no session box' };
	const list = box.closest('.session-list');
	const cs = getComputedStyle(box);
	const b = box.getBoundingClientRect();
	const l = list ? list.getBoundingClientRect() : null;
	const lcs = list ? getComputedStyle(list) : null;
	return {
		skin: document.documentElement.getAttribute('data-skin'),
		shadow: cs.boxShadow,
		// An inset ring paints within these edges; an outer one does not.
		inset: cs.boxShadow.includes('inset'),
		boxLeft: +b.left.toFixed(2), boxRight: +b.right.toFixed(2),
		listLeft: l ? +l.left.toFixed(2) : null, listRight: l ? +l.right.toFixed(2) : null,
		overflowX: lcs ? lcs.overflowX : null,
		leftRoom: l ? +(b.left - l.left).toFixed(2) : null,
		rightRoom: l ? +(l.right - b.right).toFixed(2) : null,
		active: box.classList.contains('active'),
	};
});
console.log(JSON.stringify(m, null, 1));
check(m.skin === 'warm', 'the Breathe spacing is on');
check(m.inset, `the selected tile's ring is drawn inside its box (${m.shadow})`);
check(m.leftRoom >= 2 && m.rightRoom >= 2,
	`the tiles have room for their lift either side (left ${m.leftRoom}, right ${m.rightRoom})`);

const box = await page.$('.session-box.active') || (await page.$('.session-box'));
if (box) await box.screenshot({ path: `${SP}/tile-after.png` });
await shot(s, 'tile-warm');
console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
await s.close();
