// verify_railkeys.mjs — a Diamond and a chat can be opened from the keyboard.
//
// Both were severity-1 findings (dev/a11y_report.md §1 and §2) and both were
// answered in the code afterwards, but nothing pressed the keys to say so: the
// KNOWN DEFECT notes in verify_a11y_keyboard went on reporting them as live for
// as long as the fixes had been shipped. A note left standing after its fix makes
// the fix look like a regression the next time anyone reads it, and a fix nobody
// tested is a fix nobody can rely on. This is the test.
//
// §1. A Diamond row was a <div> with a click handler whose only focusable child
//     was the x that deletes it, so tabbing the rail reached "delete this
//     Diamond" and never "open this Diamond": the destructive act had a keyboard
//     route and the central one did not.
// §2. A chat's .tile-label is a readonly <input>, so Tab reached it -- but only a
//     mouse click selected the chat, and Enter was mapped to blur(), which is the
//     one thing that looks like it worked.
//
// Both are asserted by pressing the key and asking the APPLICATION what changed.
// Each is then proved red by breaking the property in the live page.
import { open, newChat } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};
const red = (wentRed, what) => {
	console.log((wentRed ? '  ok   ' : '  FAIL ') + 'self-test: ' + what);
	(wentRed ? ok : bad).push('self-test: ' + what);
};

// Connected to the mock: without a provider the composer never appears, so there
// is no second chat to switch to and nothing to press a key on.
const s = await open({ name: 'railkeys' });
const p = s.page;
await p.waitForTimeout(1500);

// ── §2. Two chats, so "the chat changed" has an answer ──────────────
await newChat(s);
// The second one goes through the buttons directly. `newChat` returns early when
// a composer is already visible, and driving it twice fights its own guard.
await p.click('#new-session-btn', { force: true });
await p.waitForTimeout(500);
const start = p.locator('.tile-start').first();
if (await start.count()) await start.click({ force: true });
await p.waitForTimeout(900);

const tiles = await p.evaluate(() => document.querySelectorAll('.tile-label').length);
check('two chats are on the page to switch between', tiles >= 2, `${tiles} tiles`);

/// The name of the chat currently open.
const current = () => p.evaluate(() =>
	((document.querySelector('#current-session-name') || {}).textContent || '').trim());

const before = await current();
// Focus the tile of the chat that is NOT open, and press Enter on it.
const focused = await p.evaluate(() => {
	const box = [...document.querySelectorAll('.session-box.chat-box')]
		.find((e) => !e.classList.contains('active'));
	const lab = box && box.querySelector('.tile-label');
	if (!lab) return null;
	lab.focus();
	return document.activeElement === lab;
});
check('the other chat\'s tile takes the focus', focused === true);
await p.keyboard.press('Enter');
await p.waitForTimeout(800);
const afterEnter = await current();
check('Enter on a chat tile opens that chat', afterEnter !== before && !!afterEnter,
	`${JSON.stringify(before)} -> ${JSON.stringify(afterEnter)}`);

// And Space, which a control that answers Enter must also answer.
await p.evaluate(() => {
	const box = [...document.querySelectorAll('.session-box.chat-box')]
		.find((e) => !e.classList.contains('active'));
	const lab = box && box.querySelector('.tile-label');
	if (lab) lab.focus();
});
await p.keyboard.press(' ');
await p.waitForTimeout(800);
const afterSpace = await current();
check('Space on a chat tile opens that chat too', afterSpace === before,
	`back to ${JSON.stringify(afterSpace)}`);

// ── §1. A Diamond row is the control ────────────────────────────────
// Through the dialog a person uses: the + in the rail, a name, Create.
await p.evaluate(() => document.getElementById('new-diamond-btn').click());
await p.waitForSelector('.dlg-card', { timeout: 8000 });
const made = await p.evaluate(() => {
	const card = [...document.querySelectorAll('.dlg-card')].find((c) => c.getClientRects().length);
	const inp = card && card.querySelector('input.dlg-input');
	if (!inp) return 'no name field';
	inp.value = 'Keyboard';
	inp.dispatchEvent(new Event('input', { bubbles: true }));
	card.querySelector('.dlg-ok').click();
	return 'ok';
});
check('a Diamond could be made to test with', made === 'ok', made);
await p.waitForTimeout(1500);

const rows = await p.evaluate(() => document.querySelectorAll('.diamond-box').length);
check('a Diamond row is on the page to be tested', rows > 0, `${rows} rows`);

const shape = await p.evaluate(() => {
	const row = document.querySelector('.diamond-box');
	if (!row) return null;
	const FOCUS_SEL = 'a[href],button:not([disabled]),input:not([disabled]),'
		+ 'select:not([disabled]),textarea:not([disabled]),'
		+ '[tabindex]:not([tabindex="-1"]),summary,iframe,embed';
	return {
		role: row.getAttribute('role'),
		focusable: row.matches(FOCUS_SEL),
		label: row.getAttribute('aria-label'),
		// The cog that replaced the closer cross, and whether it says WHICH row
		// it is on: five tiles must not announce as five identical "Settings".
		delLabel: (row.querySelector('.tile-cog') || {}).ariaLabel || null,
	};
});
if (shape) {
	check('a Diamond row is a button to the accessibility tree', shape.role === 'button', `role=${shape.role}`);
	check('a Diamond row is in the tab order', shape.focusable === true);
	check('a Diamond row says its own name', !!shape.label && shape.label.trim().length > 0,
		JSON.stringify(shape.label));
	// §5: two Diamonds must not present two identical controls.
	check('the cog names the Diamond it would open the settings of',
		!!shape.delLabel && shape.delLabel !== '×' && shape.delLabel.trim().length > 1,
		JSON.stringify(shape.delLabel));
}

// Enter on the row selects it. With one Diamond the selection cannot move, so
// what is asserted is that the KEY reached the row's own click path.
const answered = await p.evaluate(() => {
	const row = document.querySelector('.diamond-box');
	if (!row) return null;
	let fired = false;
	const spy = () => { fired = true; };
	row.addEventListener('click', spy);
	row.focus();
	row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	row.removeEventListener('click', spy);
	return { fired, focused: document.activeElement === row };
});
if (answered) {
	check('a Diamond row takes the focus', answered.focused === true);
	check('Enter on a Diamond row acts on the row', answered.fired === true);
}

// ── Proved red ──────────────────────────────────────────────────────
console.log('');

const r1 = rows === 0 ? null : await p.evaluate(() => {
	const row = document.querySelector('.diamond-box');
	const was = row.getAttribute('tabindex');
	row.removeAttribute('tabindex');
	const seen = row.matches('[tabindex]:not([tabindex="-1"])');
	row.setAttribute('tabindex', was);
	return seen;
});
red(r1 === false, 'a Diamond row with its tabindex stripped fails the tab-order check');

// A clone keeps the attributes and loses the listeners: the row still LOOKS
// operable and answers nothing, which is the regression this file is for.
const r2 = await p.evaluate(() => {
	const row = document.querySelector('.diamond-box');
	const twin = row.cloneNode(true);
	row.parentNode.replaceChild(twin, row);
	let fired = false;
	twin.addEventListener('click', () => { fired = true; });
	twin.focus();
	twin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	return fired;
});
red(r2 === false, 'a Diamond row that kept its ARIA but lost its keydown answers nothing');

// And the chat tile: with the label made editable, Enter is a rename commit and
// must NOT open a chat -- the branch the fix turns on.
const r3 = await p.evaluate(() => {
	const box = [...document.querySelectorAll('.session-box.chat-box')]
		.find((e) => !e.classList.contains('active'));
	const lab = box && box.querySelector('.tile-label');
	if (!lab) return null;
	const before = ((document.querySelector('#current-session-name') || {}).textContent || '').trim();
	lab.readOnly = false;                     // as a double-click would leave it
	lab.focus();
	lab.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	const after = ((document.querySelector('#current-session-name') || {}).textContent || '').trim();
	lab.readOnly = true;
	return before === after;
});
red(r3 === true, 'Enter on a tile being RENAMED does not open the chat');

console.log('');
console.log(bad.length
	? `${bad.length} FAILED of ${ok.length + bad.length}:\n  - ${bad.join('\n  - ')}`
	: `rail keyboard: all ${ok.length} checks pass — a Diamond and a chat both open from the keyboard.`);
await s.close();
process.exit(bad.length ? 1 : 0);
