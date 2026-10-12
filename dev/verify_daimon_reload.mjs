// gateway: none
// verify_daimon_reload.mjs -- a reload mid-way through a daimon turn keeps the turn (D-20261012-07).
//
// ── WHY ──────────────────────────────────────────────────────────────────────
//
// `runSteer` pushed the person's message to the daimon chat in memory and saved
// it only when the turn ended. Nothing journalled a daimon turn, so a reload part
// way through took the message, the rounds that had run and any steer queued
// behind it; the provider had already been billed for those rounds (FIRE-B QA F2).
//
// ── THE PROPERTY ─────────────────────────────────────────────────────────────
//
// After a reload mid-turn: the message is still in the Diamond's conversation,
// the cut-off turn says "Interrupted" with Retry (D-20261010-22: Retry now,
// Resume later), the queued steer is back in the composer and was NOT sent, and
// Retry asks the question again and finishes it. A second reload after that
// shows the turn once, finished. And an ordinary chat gets its queued message
// back the same way: one rule for every turn.
//
//   node dev/verify_daimon_reload.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT) and dev/mockllm.mjs (DAIMOND_MOCK_PORT).
// WebKit cannot open a Diamond here (no OPFS), so this runs on Chromium only.

import { open, steerDiamond, newChat, shot, errors, mockLog, servedChats, signInAs, connectMock } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const tag   = () => Math.random().toString(36).slice(2, 9);

// Sync needs Pro on this gateway: without it /api/sync answers 402 and the
// console check below reads that as the app throwing. So sign in by hand and grant
// Pro before the first push, as verify_handoff_permit does -- the 402 is prevented,
// never filtered. No clearDiamonds: a fresh profile holds only the seeded Diamonds,
// and its reload pushed (and, with Pro, synced away) the very rail this picks from.
const s = await open({ name: 'daimonreload', signIn: false, connect: false });
await signInAs(s, 'daimonreload');
const pro = await makePagePro(s.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
console.log('  note  setup Pro: ' + JSON.stringify(pro));
await connectMock(s);
const p = s.page;

const openDiamond = (id) => p.evaluate((want) => {
	const el = want ? document.querySelector('#diamond-list [data-id="' + want + '"]')
		: document.querySelector('#diamond-list [data-id]');
	if (!el) return '';
	el.click();
	return el.dataset.id || '';
}, id);
const busy = () => p.evaluate(() => !!(document.getElementById('chat-fold-btn') || {}).disabled);
const daimonChatOf = async (dia) => {
	const all = await servedChats(s);
	return all.find(c => c && c.diamondId === dia) || null;
};

const picked = await openDiamond('');
check('0 a Diamond is open', !!picked, picked);
await sleep(800);

// ── A turn of eight paced tool rounds, a steer queued behind it, then a reload ─
const ASK    = 'ask-' + tag();
const QUEUED = 'queued-' + tag();
await steerDiamond(s, '@rounds 8/1500 file_list {} ' + ASK);
await sleep(4000);
check('1 the turn is in flight', await busy() === true);
await p.fill('#chat-input', QUEUED);
await p.click('#chat-send', { force: true });
await sleep(600);
const queuedSeen = await p.evaluate((q) => document.body.innerText.includes(q)
	&& !((document.getElementById('chat-input') || {}).value || '').includes(q), QUEUED);
check('2 the steer is queued, not in the box', queuedSeen === true);

const logBefore = mockLog().length;
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(3000);
await openDiamond(picked);
await sleep(2500);
await shot(s, 'daimonreload-after');

const after = await p.evaluate(() => {
	const foot = document.querySelector('.chat-msg-assistant.interrupted .turn-interrupted');
	const btn  = foot ? foot.querySelector('.ti-continue') : null;
	return {
		text:  document.body.innerText,
		label: foot ? (foot.querySelector('.ti-label') || {}).textContent || '' : '',
		btn:   btn ? btn.textContent : '',
		box:   (document.getElementById('chat-input') || {}).value || '',
	};
});
const stored = await daimonChatOf(picked);
const storedAsk = stored ? (stored.messages || []).filter(m => m && m.role === 'user' && String(m.content || '').includes(ASK)) : [];
check('3a HIS MESSAGE SURVIVES THE RELOAD in the stored conversation', storedAsk.length === 1,
	'user rows carrying it: ' + storedAsk.length);
check('3b and it is on screen', after.text.includes(ASK));
if (!/Interrupted/.test(after.label)) {
	// Diagnosis: what the store and the screen hold for this turn.
	const rows = stored ? (stored.messages || []).slice(-6).map(m => ({ r: m.role, i: !!m.interrupted, it: m.iturn || '', n: String(m.content || '').length })) : [];
	const tiles = await p.evaluate(() => Array.from((document.getElementById('chat-output') || { children: [] }).children).slice(-6).map(e => e.className));
	console.log('  diag stored', JSON.stringify(rows), '\n  diag tiles', JSON.stringify(tiles));
}
// The order the turn ran in: its tools, then the answer cut off after them. The
// recovered answer drawn above its own tools would tell the story backwards.
const iRows = stored ? (stored.messages || []) : [];
const iAns  = iRows.findIndex(m => m && m.role === 'assistant' && m.interrupted);
const iTurn = iAns >= 0 ? iRows[iAns].iturn : '';
const iTools = iRows.map((m, i) => (m && m.role === 'tool_log' && m.iturn && m.iturn === iTurn) ? i : -1).filter(i => i >= 0);
check('4a the stored turn reads tools first, then the cut-off answer',
	iAns >= 0 && iTools.length > 0 && iTools.every(i => i < iAns),
	'answer at ' + iAns + ', tools at ' + JSON.stringify(iTools) + ' -- rows '
	+ JSON.stringify(iRows.slice(0, 8).map(m => [m.role, m.ts, String(m.mid || '').slice(-6), String(m.iturn || '').slice(-6)])));
const drawnOrder = await p.evaluate(() => {
	const ans = document.querySelector('.chat-msg-assistant.interrupted');
	const tools = Array.from(document.querySelectorAll('#chat-output .tool-args'));
	if (!ans || !tools.length) return { ans: !!ans, tools: tools.length, after: 0 };
	return { ans: true, tools: tools.length,
		after: tools.filter(t => ans.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).length };
});
check('4b and on screen no tool is drawn below the cut-off answer', drawnOrder.ans && drawnOrder.after === 0,
	JSON.stringify(drawnOrder));
check('4 the cut-off turn says Interrupted', /Interrupted/.test(after.label), JSON.stringify(after.label));
check('5 with Retry', after.btn.trim() === 'Retry', JSON.stringify(after.btn));
check('6a THE QUEUED STEER IS BACK IN THE COMPOSER', after.box.includes(QUEUED), JSON.stringify(after.box.slice(0, 60)));
await sleep(2000);
const sentQueued = mockLog().slice(logBefore).some(l => JSON.stringify(l).includes(QUEUED));
check('6b and it was NOT sent', sentQueued === false);
check('6c and the box is not also showing it as queued',
	after.text.split(QUEUED).length - 1 === 0, 'on-screen copies outside the box: ' + (after.text.split(QUEUED).length - 1));

// ── Retry asks again and finishes ────────────────────────────────────────────
await p.fill('#chat-input', '');		// the steer stays his; clear it so it cannot ride along
const logRetry = mockLog().length;
const pressed = await p.evaluate(() => {
	const b = document.querySelector('.chat-msg-assistant.interrupted .turn-interrupted .ti-continue');
	if (!b) return false;
	b.click();
	return true;
});
check('7a Retry can be pressed', pressed);
await sleep(1500);
const askedAgain = mockLog().slice(logRetry).some(l => JSON.stringify(l).includes(ASK));
check('7b Retry asks the question again', askedAgain);
for (let i = 0; i < 40 && await busy(); i++) await sleep(1000);
check('7c and the turn finishes', await busy() === false);
await sleep(1500);

await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(3000);
await openDiamond(picked);
await sleep(2500);
const final = await p.evaluate(() => ({
	badges: document.querySelectorAll('.chat-msg-assistant.interrupted').length,
	text:   document.body.innerText,
}));
const stored2 = await daimonChatOf(picked);
const asks2 = stored2 ? (stored2.messages || []).filter(m => m && m.role === 'user' && String(m.content || '').includes(ASK)) : [];
check('8a after a second reload the turn is there once', asks2.length === 1, 'user rows: ' + asks2.length);
check('8b and nothing is badged interrupted', final.badges === 0, 'badges: ' + final.badges);
await shot(s, 'daimonreload-final');

// ── An ordinary chat: one rule for every turn (lead ruling 12 Oct, D-20261010-22) ─
// What he queued behind a chat's turn comes back to that chat's box after a reload,
// unsent, exactly as it does for a daimon turn.
await newChat(s);
await sleep(600);
const chatId = await p.evaluate(() => {
	try { const f = window.DaimondAttach && window.DaimondAttach.focus(); return (f && f.kind === 'chat') ? String(f.id) : ''; }
	catch (e) { return ''; }
});
check('10a an ordinary chat is open', !!chatId, chatId);
const CASK    = 'cask-' + tag();
const CQUEUED = 'cqueued-' + tag();
await p.fill('#chat-input', '@slow 15000 ' + CASK);
await p.click('#chat-send', { force: true });
await sleep(2500);
const sendBusy = () => p.evaluate(() => {
	const b = document.getElementById('chat-send');
	const t = b ? (b.getAttribute('title') || '') + (b.className || '') : '';
	return !!b && (/stop/i.test(t) || b.disabled);
});
check('10b its turn is in flight', await sendBusy() === true);
await p.fill('#chat-input', CQUEUED);
await p.click('#chat-send', { force: true });
await sleep(600);
const cBoxBefore = await p.evaluate(() => (document.getElementById('chat-input') || {}).value || '');
check('10c the message is queued, not in the box', !cBoxBefore.includes(CQUEUED));
const cLog = mockLog().length;
await p.reload({ waitUntil: 'domcontentloaded' });
await sleep(3000);
await p.evaluate((c) => { const b = document.querySelector('#chat-list [data-id="' + c + '"], .session-box[data-id="' + c + '"]'); if (b) b.click(); }, chatId);
await sleep(2500);
const cAfter = await p.evaluate(() => ({
	box:  (document.getElementById('chat-input') || {}).value || '',
	text: document.body.innerText,
}));
check('10d THE QUEUED MESSAGE IS BACK IN THE CHAT\'S BOX', cAfter.box.includes(CQUEUED), JSON.stringify(cAfter.box.slice(0, 60)));
check('10e and his question is still on screen', cAfter.text.includes(CASK));
await sleep(2000);
check('10f and the queued message was NOT sent', !mockLog().slice(cLog).some(l => JSON.stringify(l).includes(CQUEUED)));
await p.fill('#chat-input', '');

const errs = errors(s).filter(e => !/502|401|Account service|favicon/.test(e));
check('9 nothing was raised in the console', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
