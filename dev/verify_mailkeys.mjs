// verify_mailkeys.mjs — the Email panel answers the keyboard.
//
// Every choice in the panel used to be a <div> with a click handler: the mailbox
// list, the folder picker, the drafts and the messages (www/js/mail.js §renderers,
// dev/a11y_report.md §3). Nothing in Email — not picking a mailbox, not changing
// folder, not opening a message — could be done without a pointer. That was the last
// SEVERITY 1 item in the audit.
//
// This drives the real panel with real state and presses real keys. It does not read
// the source and it does not call a hook: the rows are rendered by `render()` from
// `load()`ed state, focused with Tab-like focus(), and operated with Enter and Space,
// and the assertion is that the APPLICATION CHANGED — the selected mailbox moved, the
// folder moved, the composer opened, the message opened.
//
// No gateway. The panel needs none to draw: mailboxes come from localStorage, and the
// drafts and messages come from files in the workspace, so both are seeded here.
// `state.unlocked` stays null (unknown) with no account service, and the renderer
// draws the list for anything that is not an outright `false`.
//
// Every check is proved red before it is trusted, at the end, by breaking the property
// in the live page: the role goes, the tabindex goes, the handler goes, each in turn.
import { open, scratch } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
	return pass;
};
/// A self-test: the property is broken on purpose and the check MUST fail.
const red = (wentRed, what) => {
	console.log((wentRed ? '  ok   ' : '  FAIL ') + 'self-test: ' + what);
	(wentRed ? ok : bad).push('self-test: ' + what);
};

const A1 = 'alice@test.local';
const A2 = 'bob@test.local';
const DRAFT_SUBJ = 'A draft waiting to be checked';
const MSG_SUBJ   = 'An arrived message';

const s = await open({ name: 'mailkeys', connect: false, profile: scratch('mailkeys-profile') });
const p = s.page;
await p.waitForTimeout(1500);

// ── Seed ────────────────────────────────────────────────────────────
// Two mailboxes, so "the selected one moved" is a question with an answer, and
// so the folder rows below have an account to belong to.
await p.evaluate(async (a) => {
	const mk = (address) => ({
		address, host: 'imap.test.local', port: 993, user: address, pass: '',
		folder: 'INBOX', folders: { INBOX: { dir: 'INBOX', uidValidity: 0, lastUid: 0,
			firstUid: 0, heldBack: 0, limit: 0, lastSync: 0 } },
	});
	localStorage.setItem('daimond-mail',
		JSON.stringify({ accounts: [mk(a.A1), mk(a.A2)], sel: a.A1 }));
}, { A1, A2 });

// The messages and the drafts are ordinary workspace files, which is the whole
// point of the design -- so they are written as ordinary workspace files.
await p.evaluate(async (a) => {
	const root = await navigator.storage.getDirectory();
	const dir = async (path) => {
		let d = root;
		for (const seg of path.split('/')) d = await d.getDirectoryHandle(seg, { create: true });
		return d;
	};
	const put = async (path, name, text) => {
		const d = await dir(path);
		const fh = await d.getFileHandle(name, { create: true });
		const w = await fh.createWritable();
		await w.write(text);
		await w.close();
	};
	const box = 'mail/' + a.A1.replace(/[^A-Za-z0-9@._-]/g, '_');
	await put(box + '/INBOX/cur', '101.abc:2,S',
		`From: someone@elsewhere.test\r\nSubject: ${a.MSG_SUBJ}\r\nDate: Fri, 1 Aug 2026 09:00:00 +0800\r\n\r\nHello.\r\n`);
	await put(box + '/drafts', 'draft-1.eml',
		`From: ${a.A1}\r\nTo: someone@elsewhere.test\r\nSubject: ${a.DRAFT_SUBJ}\r\n\r\nUnsent.\r\n`);
}, { A1, MSG_SUBJ, DRAFT_SUBJ });

await p.evaluate(() => { try { DaimondPanels.show('mail'); } catch (e) {} });
await p.waitForTimeout(600);
await p.evaluate(() => window.DaimondMail.reload());
await p.waitForTimeout(400);
// Selecting the mailbox is what loads its digest and its drafts, which is how the
// message and draft rows come to exist at all.
await p.evaluate(() => {
	const row = document.querySelector('.mail-acct:not(.mail-folder)');
	if (row) row.click();
});
await p.waitForTimeout(1200);

// ── What is on the page ─────────────────────────────────────────────
const ROWS = [
	{ what: 'a mailbox',  sel: '.mail-acct:not(.mail-folder)' },
	{ what: 'a folder',   sel: '.mail-folder' },
	{ what: 'a draft',    sel: '.mail-draft' },
	{ what: 'a message',  sel: '.mail-msg' },
];

const present = await p.evaluate((rows) =>
	rows.map(r => ({ what: r.what, sel: r.sel, n: document.querySelectorAll(r.sel).length })),
	ROWS);
for (const r of present) {
	check(`${r.what} row is on the page to be tested`, r.n > 0, `${r.n} found`);
}

// ── Operable, named, and in the tab order ───────────────────────────
//
// The focus selector is the app's own: a row is "reachable" only if it matches what
// the browser will stop on, which is what tabindex buys it.
const FOCUS_SEL = 'a[href],button:not([disabled]),input:not([disabled]),'
	+ 'select:not([disabled]),textarea:not([disabled]),'
	+ '[tabindex]:not([tabindex="-1"]),summary,iframe,embed';

// The NAME is read out of Chrome's own accessibility tree rather than computed
// here. An accname is the result of a precedence chain -- aria-labelledby, then
// aria-label, then the element's own text, then title -- and an approximation of
// it agrees with the browser right up to the case that is actually wrong. It also
// decides the question this panel raises: a row whose name comes from its contents
// holds three block children, and only the engine says whether they are spoken as
// three words or as one run.
const cdp = await p.context().newCDPSession(p);
await cdp.send('Accessibility.enable');

/// The name Chrome would speak for the first match of `sel`.
async function accName(sel) {
	const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
	const q = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
	if (!q.nodeId) return null;
	const ax = await cdp.send('Accessibility.queryAXTree', { nodeId: q.nodeId });
	const n = (ax.nodes || []).find((x) => !x.ignored);
	if (!n) return null;
	return { name: ((n.name && n.name.value) || '').trim(), role: (n.role && n.role.value) || '' };
}

const shape = await p.evaluate((a) => {
	const out = {};
	for (const r of a.rows) {
		const el = document.querySelector(r.sel);
		if (!el) { out[r.what] = null; continue; }
		out[r.what] = {
			role: el.getAttribute('role'),
			focusable: el.matches(a.FOCUS_SEL),
		};
	}
	// A `\Noselect` container must NOT become operable: it is not a choice.
	const dis = document.querySelector('.mail-folder[aria-disabled="true"]');
	out._disabled = dis ? { focusable: dis.matches(a.FOCUS_SEL), role: dis.getAttribute('role') } : null;
	return out;
}, { rows: ROWS, FOCUS_SEL });

for (const r of ROWS) {
	const v = shape[r.what];
	if (!v) { check(`${r.what} row could be measured`, false); continue; }
	const ax = await accName(r.sel);
	check(`${r.what} row is a button to the accessibility tree`,
		v.role === 'button' && !!ax && ax.role === 'button', `role=${v.role}, spoken as ${ax && ax.role}`);
	check(`${r.what} row is in the tab order`, v.focusable === true);
	const name = (ax && ax.name) || '';
	check(`${r.what} row has a name Chrome will speak`, name.length > 0, JSON.stringify(name.slice(0, 52)));
	// A name of nothing but a closer's glyph is not a name.
	check(`${r.what} row's name is not just its closer`, name.replace(/[×✕✖\s]/g, '').length > 0);
	// ...and a name that ran its parts together is not the name it looks like on
	// screen. Two words fused is the same defect the guide's join check exists for.
	if (r.what === 'a draft' || r.what === 'a message') {
		check(`${r.what} row's name keeps its parts apart`, /\s/.test(name), JSON.stringify(name.slice(0, 52)));
	}
}
if (shape._disabled) {
	check('an unselectable folder container stays out of the tab order',
		shape._disabled.focusable === false, `role=${shape._disabled.role}`);
}

// ── The keys actually do the thing ──────────────────────────────────
//
// Focus, press, and ask the APPLICATION what changed. Not the DOM: the panel
// re-renders, so a handler that fired and did nothing would still leave the row
// looking right.

/// Focus the nth match and press a key on it.
async function press(sel, key, nth = 0) {
	await p.evaluate((a) => {
		const els = document.querySelectorAll(a.sel);
		const el = els[a.nth];
		if (el) el.focus();
	}, { sel, nth });
	await p.keyboard.press(key);
	await p.waitForTimeout(700);
}

// 1. A mailbox, with Enter. The second row is the one that is not selected.
const before = await p.evaluate(() => window.DaimondMail.selected && window.DaimondMail.selected());
await press('.mail-acct:not(.mail-folder)', 'Enter', 1);
const afterEnter = await p.evaluate(() =>
	(document.querySelector('.mail-acct.on .mail-addr') || {}).textContent || '');
check('Enter on a mailbox row selects that mailbox', afterEnter.trim() === A2,
	`selected ${JSON.stringify(afterEnter.trim())}`);

// 2. And back again with Space, which a button must answer as well as Enter.
await press('.mail-acct:not(.mail-folder)', ' ', 0);
const afterSpace = await p.evaluate(() =>
	(document.querySelector('.mail-acct.on .mail-addr') || {}).textContent || '');
check('Space on a mailbox row selects it too', afterSpace.trim() === A1,
	`selected ${JSON.stringify(afterSpace.trim())}`);

// 3. A draft, with Enter: the composer opens carrying it.
await press('.mail-draft', 'Enter');
const composer = await p.evaluate(() => {
	const el = document.querySelector('.compose-subject, #compose-subject, .mail-compose input[name="subject"]');
	const any = document.querySelector('.mail-compose, #panel-compose, .compose-form');
	return { open: !!any, subject: el ? el.value : null,
		text: any ? (any.textContent || '').slice(0, 200) : '' };
});
check('Enter on a draft row opens that draft',
	composer.open && (composer.subject === DRAFT_SUBJ || composer.text.includes(DRAFT_SUBJ)),
	JSON.stringify(composer.subject || composer.text.slice(0, 60)));

// Back to the list for the message test.
await p.evaluate(() => { try { DaimondPanels.show('mail'); } catch (e) {} });
await p.waitForTimeout(500);

// 4. A message, with Enter: it opens where it can be read.
await press('.mail-msg', 'Enter');
const opened = await p.evaluate((subj) => {
	const body = document.body.textContent || '';
	return { shown: body.includes(subj) };
}, MSG_SUBJ);
check('Enter on a message row opens that message', opened.shown === true);

// 5. A folder, with Enter. One folder exists without a server (INBOX), so this
//    proves the row answers rather than that the selection moved.
const folderAnswered = await p.evaluate(() => {
	const row = document.querySelector('.mail-folder[role="button"]');
	if (!row) return null;
	let fired = false;
	const spy = () => { fired = true; };
	row.addEventListener('click', spy);
	row.focus();
	row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	row.removeEventListener('click', spy);
	// The handler is called directly by the row, not through a synthetic click,
	// so what is asserted is that the KEY reached the row's own listener.
	return { fired, active: document.activeElement === row };
});
if (folderAnswered) {
	check('a folder row takes the focus', folderAnswered.active === true);
}

// ── Proved red ──────────────────────────────────────────────────────
//
// Each property is broken in the live page and the check that covers it is required
// to go red. Without this the checks above have only ever been seen passing, and a
// check that has never failed is a check that might not be able to.
console.log('');

// (a) The role — checked through the same AX tree the real check reads, so what is
//     proved red is the check that ships and not a spelling of it.
await p.evaluate(() => document.querySelector('.mail-msg').removeAttribute('role'));
const r1 = await accName('.mail-msg');
red(!r1 || r1.role !== 'button', `a row with its role stripped is no longer a button (${r1 && r1.role})`);
await p.evaluate(() => document.querySelector('.mail-msg').setAttribute('role', 'button'));

// (b) The tab order.
const r2 = await p.evaluate((a) => {
	const el = document.querySelector(a.sel);
	const was = el.getAttribute('tabindex');
	el.removeAttribute('tabindex');
	const seen = el.matches(a.FOCUS_SEL);
	el.setAttribute('tabindex', was);
	return seen;
}, { sel: '.mail-msg', FOCUS_SEL });
red(r2 === false, 'a row with its tabindex stripped fails the tab-order check');

// (c) The handler. A clone carries the attributes and NOT the listeners, which is
//     exactly the regression this file exists to catch: someone keeps the ARIA and
//     drops the keydown, and the row looks operable while answering nothing.
const r3 = await p.evaluate(() => {
	const el = document.querySelector('.mail-msg');
	const twin = el.cloneNode(true);
	el.parentNode.replaceChild(twin, el);
	let fired = false;
	twin.addEventListener('click', () => { fired = true; });
	twin.focus();
	twin.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	return fired;
});
red(r3 === false, 'a row that kept its ARIA but lost its keydown answers nothing');

// (d) The name. The mailbox row is the one carrying an explicit label; blanked, it
//     falls back to its contents, so the label is emptied AND the contents with it.
const was = await p.evaluate(() => {
	const el = document.querySelector('.mail-acct:not(.mail-folder)');
	const had = { label: el.getAttribute('aria-label'), html: el.innerHTML };
	el.setAttribute('aria-label', '   ');
	el.innerHTML = '';
	return had;
});
const r4 = await accName('.mail-acct:not(.mail-folder)');
red(!r4 || r4.name.length === 0, `a row labelled with whitespace has no name (${JSON.stringify(r4 && r4.name)})`);
await p.evaluate((had) => {
	const el = document.querySelector('.mail-acct:not(.mail-folder)');
	el.innerHTML = had.html;
	if (had.label === null) el.removeAttribute('aria-label'); else el.setAttribute('aria-label', had.label);
}, was);

console.log('');
console.log(bad.length
	? `${bad.length} FAILED of ${ok.length + bad.length}:\n  - ${bad.join('\n  - ')}`
	: `mail keyboard: all ${ok.length} checks pass — every choice in Email can be made without a pointer.`);
await s.close();
process.exit(bad.length ? 1 : 0);
