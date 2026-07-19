// verify_turns.mjs — a turn as a thing you can close, choose, fold and walk back to.
//
// The thread was a flat list of messages: an answer had no attachment to the question that
// caused it, so nothing could be collapsed behind it and nothing could be folded but the whole
// chat. A turn now exists — the nth question and everything that came back from it — and this
// drives what that makes possible.
//
// The check that matters most is the last one. It is easy to build a tick-box that LOOKS like it
// chose a turn and then quietly fold the whole chat anyway; the UI would be indistinguishable.
// So the delta is not inspected in the page that produced it — it is read back out of the Diamond
// history, which is the reducer's own record of what it was handed. If the tick did not narrow
// the fold, the marker from an unticked turn shows up there and the test fails.
//
// The answers are deliberately long. The jump exists for a thread taller than the window, and a
// short thread cannot scroll its last question to the top however correct the code is — there is
// nothing beneath it to scroll. Testing the jump against a thread that cannot scroll would prove
// nothing either way.
import { open, chat, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const FILL = 'the quick brown fox jumps over the lazy dog '.repeat(60);   // a tall answer
const MARKS = ['MARK-ALPHA', 'MARK-BETA', 'MARK-GAMMA', 'MARK-DELTA'];

const s = await open({ name: 'turns' });
const p = s.page;

// The Diamond first, so folding into it later needs no navigation away from the chat.
await p.click('#new-diamond-btn');
await p.waitForSelector('.dlg-input', { timeout: 8000 });
await p.fill('.dlg-input', 'Turns Test');
await p.click('.dlg-ok');
await p.waitForTimeout(1200);

// Four turns. The marker rides in the user's own message, which is what the delta carries, and
// the mock echoes it back — so a turn is identifiable from either end.
for (const m of MARKS) await chat(s, `@text ${m} ${FILL}`);

// ── Turns exist, and outputs belong to one ─────────────────────────────

const shape = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const users = [...out.querySelectorAll('.chat-msg-user')];
	const asst  = [...out.querySelectorAll('.chat-msg-assistant')];
	return {
		turns: users.map(u => u.dataset.turn),
		asstTagged: asst.length > 0 && asst.every(a => a.dataset.turn !== undefined),
		asstTurns: asst.map(a => a.dataset.turn),
	};
});
check('every question is a numbered turn',
	shape.turns.join(',') === '1,2,3,4', shape.turns.join(','));
check('and every answer carries the turn it belongs to',
	shape.asstTagged && shape.asstTurns.join(',') === '1,2,3,4', shape.asstTurns.join(','));

// ── A question is the switch for its own answers ───────────────────────

const toggle = await p.evaluate(() => {
	const out  = document.getElementById('chat-output');
	const u    = out.querySelector('.chat-msg-user[data-turn="2"]');
	const kids = () => [...out.querySelectorAll('[data-turn="2"]')].filter(e => e !== u);
	const visible = () => kids().filter(e => e.style.display !== 'none').length;
	const before = visible();
	u.querySelector('.chat-msg-content').click();
	const closed = visible();
	const marked = u.classList.contains('collapsed');
	u.querySelector('.chat-msg-content').click();
	return { before, closed, reopened: visible(), marked };
});
check('clicking a question hides everything it produced',
	toggle.before > 0 && toggle.closed === 0, `${toggle.before} → ${toggle.closed}`);
check('and the closed question says so, rather than standing beside a silent gap',
	toggle.marked === true);
check('clicking it again brings the answer back',
	toggle.reopened === toggle.before, `${toggle.closed} → ${toggle.reopened}`);

// Selecting the text of a question must not fold it away — the box is a switch, but its words
// are still words. A click that ENDS a selection is a click that was selecting.
const selecting = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const u   = out.querySelector('.chat-msg-user[data-turn="3"]');
	const c   = u.querySelector('.chat-msg-content');
	const r   = document.createRange();
	r.selectNodeContents(c);
	const sel = window.getSelection();
	sel.removeAllRanges(); sel.addRange(r);
	c.click();
	const collapsed = u.classList.contains('collapsed');
	sel.removeAllRanges();
	return collapsed;
});
check('selecting the text of a question does not fold it away', selecting === false);

// ── The − collapses all, and latches into select mode ──────────────────

const collapsed = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	document.getElementById('collapse-btn').click();
	const users = [...out.querySelectorAll('.chat-msg-user')];
	const asst  = [...out.querySelectorAll('.chat-msg-assistant')];
	const tick  = out.querySelector('.turn-pick');
	return {
		allClosed:  users.every(u => u.classList.contains('collapsed')),
		asstHidden: asst.every(a => a.style.display === 'none'),
		questionsStillThere: users.every(u => u.offsetParent !== null),
		latched:  document.getElementById('collapse-btn').classList.contains('on'),
		toolsUp:  document.getElementById('select-tools').style.display !== 'none',
		ticksUp:  !!tick && getComputedStyle(tick).display !== 'none',
	};
});
check('the − collapses every answer', collapsed.allClosed && collapsed.asstHidden);
check('leaving the questions, which are what you are choosing between',
	collapsed.questionsStillThere);
check('the button stays depressed, so the mode is visible', collapsed.latched);
check('and select mode brings out its tools and its ticks',
	collapsed.toolsUp && collapsed.ticksUp);

const peek = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const u = out.querySelector('.chat-msg-user[data-turn="1"]');
	u.querySelector('.chat-msg-content').click();
	const open = !u.classList.contains('collapsed');
	u.querySelector('.chat-msg-content').click();
	return open;
});
check('and a question can still be opened while choosing', peek === true);

// ── Select all / Deselect all ──────────────────────────────────────────

const picks = await p.evaluate(() => {
	const out = document.getElementById('chat-output');
	const boxes = () => [...out.querySelectorAll('.turn-pick input')];
	document.getElementById('sel-all').click();
	const all = boxes().filter(b => b.checked).length;
	document.getElementById('sel-none').click();
	const none = boxes().filter(b => b.checked).length;
	return { all, none, total: boxes().length };
});
check('Select all ticks every turn', picks.all === picks.total && picks.total === 4, `${picks.all}/${picks.total}`);
check('Deselect all clears them', picks.none === 0);

// Folding nothing is refused, rather than silently paying a reducer to fold an empty delta.
const refused = await p.evaluate(async () => {
	document.getElementById('sel-fold').click();
	await new Promise(r => setTimeout(r, 500));
	const h = document.querySelector('.dlg-card h2');
	const txt = h ? h.textContent : '';
	const okb = document.querySelector('.dlg-ok');
	if (okb) okb.click();
	await new Promise(r => setTimeout(r, 400));
	return txt;
});
check('folding nothing is refused, not silently paid for',
	/nothing chosen/i.test(refused), refused || '(no dialog)');

await shot(s, 'turns-select');

// ── The jump walks back through the questions ──────────────────────────

const jump = await p.evaluate(async () => {
	const out = document.getElementById('chat-output');
	document.getElementById('collapse-btn').click();     // leave select mode, reopen everything
	await new Promise(r => setTimeout(r, 300));
	out.scrollTop = out.scrollHeight;
	const topOf = n => {
		const u = out.querySelector(`.chat-msg-user[data-turn="${n}"]`);
		return Math.round(u.getBoundingClientRect().top - out.getBoundingClientRect().top);
	};
	const scrollable = out.scrollHeight > out.clientHeight + 100;
	document.getElementById('chat-jump').click();
	await new Promise(r => setTimeout(r, 200));
	const first = topOf(4);
	document.getElementById('chat-jump').click();
	await new Promise(r => setTimeout(r, 200));
	const second = topOf(3);
	document.getElementById('chat-jump').click();
	await new Promise(r => setTimeout(r, 200));
	const third = topOf(2);
	return { first, second, third, scrollable };
});
check('the thread is taller than its window, so a jump has somewhere to go', jump.scrollable);
// "At the top" means within a few pixels of the thread's own top edge.
check('the jump puts the last question at the top',
	Math.abs(jump.first) <= 4, `${jump.first}px from the top`);
check('pressing again walks back to the one before it',
	Math.abs(jump.second) <= 4, `${jump.second}px from the top`);
check('and again, so a long thread is walked by its questions',
	Math.abs(jump.third) <= 4, `${jump.third}px from the top`);

// ── Fold selected really folds only what was selected ──────────────────
//
// The oracle is not the page: it is the Diamond history, which records the delta the reducer was
// handed. Turn 2 (MARK-BETA) is ticked; the other three are not.

const menuHead = await p.evaluate(async () => {
	const out = document.getElementById('chat-output');
	document.getElementById('collapse-btn').click();     // into select mode
	await new Promise(r => setTimeout(r, 300));
	const box = out.querySelector('.chat-msg-user[data-turn="2"] .turn-pick input');
	box.checked = true;
	box.dispatchEvent(new Event('click', { bubbles: true }));
	document.getElementById('sel-fold').click();
	await new Promise(r => setTimeout(r, 500));
	const h = document.querySelector('.fold-menu-head');
	return h ? h.textContent : '(no fold menu)';
});
check('the fold menu says how much is going in, not just "Fold into…"',
	/1 turn/.test(menuHead), menuHead);

await p.evaluate(() => {
	const item = [...document.querySelectorAll('.fold-menu-item')]
		.find(b => b.textContent.trim() === 'Turns Test');
	if (item) item.click();
});
await p.waitForTimeout(7000);
const accept = await p.$('.diff-accept');
if (accept && !(await accept.isDisabled())) { await accept.click(); await p.waitForTimeout(3000); }

// Read the delta back out of the history — the reducer's own record of what it got.
await p.click('button.crystal-act:has-text("History")');
await p.waitForTimeout(900);
const deltaBtn = await p.$('button.crystal-act:has-text("Delta")');
let delta = '';
if (deltaBtn) {
	await deltaBtn.click();
	await p.waitForTimeout(800);
	delta = await p.evaluate(() => (document.querySelector('.dlg-pre') || {}).textContent || '');
}
check('the chosen turn reaches the reducer', /MARK-BETA/.test(delta),
	delta ? `(delta is ${delta.length} chars)` : '(nothing read back)');
check('and the turns NOT chosen do not',
	!!delta && !/MARK-ALPHA/.test(delta) && !/MARK-GAMMA/.test(delta) && !/MARK-DELTA/.test(delta),
	delta ? MARKS.filter(m => delta.includes(m)).join(',') || '(only MARK-BETA)' : '(nothing read back)');

// A fold of some turns is not the chat going anywhere, so the tile must not claim it was.
const tileText = await p.evaluate(() => {
	const f = document.querySelector('.tile-fold');
	return f ? f.textContent.trim() : '(no tile)';
});
check('a partial fold does not mark the whole chat "Folded"',
	tileText !== 'Folded', tileText);

await shot(s, 'turns-folded');

// The gateway is not running for this test — it is a browser-only flow — so its 502s are the
// absence of a server, not a fault in the thread.
const errs = errors(s).filter(e => !/favicon|404|401|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 5));
check('the thread throws nothing while all this happens', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
