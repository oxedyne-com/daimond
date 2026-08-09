// A fold retains its raw delta; the History must let you read it back.
//
// This used to type a delta straight into the crystal's own `#fold-delta` box
// and press Propose. Both are gone: a Diamond has ONE composer, in the chat
// face, and the crystal carries no input of its own. The property is unchanged
// -- a fold keeps the words that caused it, and History shows them -- so the
// fold is now made the way one is actually made, by selecting turns of a chat
// and folding them into the Diamond.
//
//   node dev/verify_folddelta.mjs
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import { open, errors, chat } from './harness.mjs';

const MARKER = 'DELTA-MARKER-42: ship the thing';
const DIAMOND = 'Delta Test';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const s = await open({ name: 'folddelta' });
const p = s.page;

// A Diamond for the fold to land in.
await p.click('#new-diamond-btn', { force: true });
await p.waitForSelector('.dlg-input', { timeout: 8000 });
await p.fill('.dlg-input', DIAMOND);
await p.click('.dlg-ok', { force: true });
await sleep(1200);

// A chat carrying the marker, so the delta the fold records contains it.
// Through the harness helper, which knows that a new chat needs its Start
// pressed and that a visible composer may belong to a Diamond rather than a chat.
await chat(s, MARKER);

// Select every turn and fold them into the Diamond -- the surviving path, and
// the one a person uses.
await p.evaluate(() => {
	const c = document.getElementById('collapse-btn');
	if (c && !c.classList.contains('on')) c.click();
});
await sleep(400);
await p.click('#sel-all', { force: true });
await sleep(200);
await p.click('#sel-fold', { force: true });
await p.waitForSelector('.fold-menu', { timeout: 8000 });
await p.evaluate((name) => {
	const item = [...document.querySelectorAll('.fold-menu-item')]
		.find(b => b.textContent.trim() === name);
	if (item) item.click();
}, DIAMOND);
await sleep(4000);

const accept = await p.$('.diff-accept');
if (accept && !(await accept.isDisabled())) { await accept.click(); await sleep(2000); }

// History, then the fold record's Delta button.
const hist = await p.$('button.crystal-act:has-text("History")');
if (hist) { await hist.click(); await sleep(700); }
const deltaBtn = await p.$('button.crystal-act:has-text("Delta")');
let shown = '';
if (deltaBtn) {
	await deltaBtn.click();
	await sleep(700);
	shown = await p.evaluate(() => (document.querySelector('.dlg-pre') || {}).textContent || '');
}

const ok = !!deltaBtn && shown.indexOf('DELTA-MARKER-42') >= 0;
console.log('delta button present:', !!deltaBtn);
console.log('shows the raw delta:', shown.indexOf('DELTA-MARKER-42') >= 0);
console.log('');
console.log('FOLD DELTA VIEWABLE:', ok);
console.log('errors:', errors(s));
await s.close();
process.exit(ok ? 0 : 1);
