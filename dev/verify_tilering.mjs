// The selected chat tile under the Breathe spacing: is its ring inside the box
// the list is entitled to clip?
//
// It counted its own reds all along and then exited 0, so the count reached
// nobody: `run_all.sh` reads the exit code. It exits on the count now.
//
// PROVED AGAINST TWO BREAKS FIRST, both applied as a stylesheet over the app's
// own — nothing on disk is touched:
//   --break outerring   the selected tile's ring is painted OUTSIDE its box,
//                       which is the defect this file is named for.
//   --break flush       the tiles are pushed flush to the list's edges, so the
//                       ring has nowhere to sit and the clip eats it.
//
//   node dev/verify_tilering.mjs --break outerring   # expected to FAIL
//   node dev/verify_tilering.mjs --break flush       # expected to FAIL
//   node dev/verify_tilering.mjs                     # and then, clean
import { open, shot, newChat, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = {
	outerring: '#session-list .session-box.active, #session-list .session-box.active:hover'
		+ '{ box-shadow: 0 0 0 2px rgb(210,96,79) !important; }',
	flush: '#session-list { padding-left: 0 !important; padding-right: 0 !important; }'
		+ '#session-list .session-box { margin-left: 0 !important; margin-right: 0 !important; }',
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

const SP = new URL('shots/', import.meta.url).pathname;
const s = await open({ name: 'tile' });
const { page } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

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
if (BREAK) await page.addStyleTag({ content: BREAKS[BREAK] });
// A CHAT tile, named by its list. `boxes[0]` was the first `.session-box` in the
// document, and the Diamonds rail is above the chats — so on any account with a
// Diamond this selected a Diamond tile, whose `closest('.session-list')` is null,
// and every measurement below came back null. It has been failing that way, on a
// file whose first line says "the selected chat tile".
await page.waitForSelector('#session-list .session-box', { timeout: 8000 }).catch(() => {});
const boxes = await page.$$('#session-list .session-box');
if (boxes.length) { await boxes[0].click({ force: true }); await page.waitForTimeout(500); }

const m = await page.evaluate(() => {
	const box = document.querySelector('#session-list .session-box.active')
		|| document.querySelector('#session-list .session-box');
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

// Without a tile in the CHAT list there is nothing under test, and every
// measurement below would be `undefined` — which is not a pass.
check('there is a chat tile in the chat list to measure', !m.err && m.listLeft !== null,
	m.err || `list ${m.listLeft}..${m.listRight}, tile ${m.boxLeft}..${m.boxRight}`);
check('the tile the ring belongs to is the selected one', !!m.active, `active=${m.active}`);
check('the Breathe spacing is on', m.skin === 'warm', `data-skin=${m.skin}`);
check('THE SELECTED TILE\'S RING IS DRAWN INSIDE ITS BOX', !!m.inset, m.shadow);
check('and the tiles have room for their lift either side',
	m.leftRoom >= 2 && m.rightRoom >= 2, `left ${m.leftRoom}, right ${m.rightRoom}, list clips ${m.overflowX}`);

const box = await page.$('.session-box.active') || (await page.$('.session-box'));
if (box) await box.screenshot({ path: `${SP}/tile-after.png` });
await shot(s, 'tile-warm');

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
