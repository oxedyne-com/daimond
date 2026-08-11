// verify_attachfocus.mjs — the paperclip: one control, two behaviours, decided
// by what is in focus and never by which row it sits on.
//
// ATTACH_CONTRACT.md is the design; dev/ATTACH_CONTRACT.md §10 lists seven
// properties. Stage one builds the control and the states (§4, §6, §7), not
// the footer's cap and scroll (§5, stage two), so this covers six of the
// seven — everything but "past the cap the footer scrolls and the composer
// does not move".
//
//   1. The control appears on a FILE row, a FOLDER row and in the Doc header,
//      and is absent with nothing in focus.
//   2. With a Diamond in focus it writes a `holds` link carrying the workspace.
//   3. With a chat in focus it writes NOTHING to the store, and the footer
//      clears when the turn is sent.
//   4. Note generates the note prefix, Read generates the read prefix, and the
//      text is in the composer where the user can edit it before sending.
//   5. Note is what an attachment starts as.
//   7. An unreachable attachment is not in the generated prefix.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of daimond.js to the real page through
// `page.route`, and the run below is then expected to FAIL. A break whose
// anchor does not match aborts rather than passing quietly.
//
//   node dev/verify_attachfocus.mjs --break hidden       # 1 fails: never hides
//   node dev/verify_attachfocus.mjs --break diamondlink  # 2 fails: no link written
//   node dev/verify_attachfocus.mjs --break chatclear    # 3 fails: footer survives send
//   node dev/verify_attachfocus.mjs --break prefix       # 4 fails: no prefix generated
//   node dev/verify_attachfocus.mjs --break notedefault  # 5 fails: starts as Read
//   node dev/verify_attachfocus.mjs --break unreachable  # 7 fails: away path in prefix
//   node dev/verify_attachfocus.mjs                      # and then, clean
//
//   eval "$(bash dev/world.sh 4 --up)"
//   eval "$(bash dev/world.sh 4 --env)"
//   node dev/verify_attachfocus.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, newChat, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The control is offered no matter what -- so it would sit on a row even
	// with nothing in focus, which the contract says must never happen.
	hidden: {
		file: 'js/daimond.js',
		find: `	function attachFocus() {
		if (currentDiamond) return { kind: 'diamond', id: currentDiamond.id, name: currentDiamond.name };
		if (current && !current.diamondId) return { kind: 'chat', id: current.id };
		return null;
	}`,
		with: `	function attachFocus() {
		if (currentDiamond) return { kind: 'diamond', id: currentDiamond.id, name: currentDiamond.name };
		if (current && !current.diamondId) return { kind: 'chat', id: current.id };
		return { kind: 'chat', id: 'ghost' };
	}`,
	},
	// Pressing the paperclip on a Diamond in focus no longer writes the link.
	diamondlink: {
		file: 'js/daimond.js',
		find: `				else await diamondApp().add_link(id, 'diamond:' + id, ref, 'holds', '', 'user');`,
		with: `				else { /* the write silently does not happen */ }`,
	},
	// The chat footer's promise -- cleared when the turn is sent -- stops
	// being kept, so what was queued is still sitting there afterwards.
	chatclear: {
		file: 'js/daimond.js',
		find: `		clearChatAttach(chat.id);`,
		with: `		/* clearChatAttach(chat.id); */`,
	},
	// No prefix is ever generated, so Note and Read stop doing anything a
	// person can see.
	prefix: {
		file: 'js/daimond.js',
		find: `	function attachPrefixText(list) {
		var notes = [], reads = [];
		(list || []).forEach(function (a) {
			if (!refReachable(a.ref)) return;
			(a.state === 'read' ? reads : notes).push(a.path);
		});
		var out = [];
		if (notes.length) out.push(t('attach.prefix_note', { paths: notes.join(', ') }));
		if (reads.length) out.push(t('attach.prefix_read', { paths: reads.join(', ') }));
		return out.length ? out.join('\\n') + '\\n' : '';
	}`,
		with: `	function attachPrefixText(list) {
		return '';
	}`,
	},
	// A fresh attachment starts as Read, which spends the user's money without
	// being asked -- the wrong default the contract exists to prevent.
	notedefault: {
		file: 'js/daimond.js',
		find: `		list.push({ ref: ref, dir: !!dir, path: path, state: 'note' });`,
		with: `		list.push({ ref: ref, dir: !!dir, path: path, state: 'read' });`,
	},
	// The reachability guard is removed, so a path from a workspace that is not
	// open goes into the prefix anyway -- a turn spent apologising.
	unreachable: {
		file: 'js/daimond.js',
		find: `		(list || []).forEach(function (a) {
			if (!refReachable(a.ref)) return;
			(a.state === 'read' ? reads : notes).push(a.path);
		});`,
		with: `		(list || []).forEach(function (a) {
			(a.state === 'read' ? reads : notes).push(a.path);
		});`,
	},
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let ok = 0, bad = 0;
const check = (name, pass, detail) => {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const s = await open({ name: 'attachfocus', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file, r => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
}

await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs, connectMock } = await import('./harness.mjs');
await signInAs(s, 'attachfocus');
await connectMock(s);
await page.waitForTimeout(1200);

const T = (k, v) => page.evaluate(([k, v]) => DaimondI18n.t(k, v || undefined), [k, v || null]);

// A file to point at, written the way a person's own would be.
await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: 'notes/spec.md', content: '# Spec\n' }));
	await app.run_tool('file_write', JSON.stringify({ path: 'docs/plan.md', content: '# Plan\n' }));
});
await page.waitForTimeout(300);

async function openWorkspace() {
	await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await page.waitForTimeout(500);
	await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
	await page.waitForTimeout(800);
}

/// The row for a top-level entry by name, ignoring the leading glyph.
async function rowFor(name) {
	for (const row of await page.$$('#panel-work .files-row')) {
		const nm = await row.$eval('.files-name', e => e.textContent).catch(() => '');
		if (nm.replace(/^[^A-Za-z0-9._-]+/, '').trim() === name) return row;
	}
	return null;
}

/// Back to the top of the tree and the file list, whatever a previous section
/// left it doing. "up" from a file view first closes the view; "up" from any
/// directory that is not root goes up one; both are no-ops once there,  so a
/// few unconditional presses always land at the root.
async function gotoRoot() {
	const back = await page.$('[data-act="back"]');
	if (back) { await back.click({ force: true }).catch(() => {}); await page.waitForTimeout(400); }
	await page.fill('.files-filter-input', '').catch(() => {});
	for (let i = 0; i < 4; i++) {
		await page.click('[data-act="up"]', { force: true }).catch(() => {});
		await page.waitForTimeout(250);
	}
}

// ── 1. Nothing in focus: the control is offered nowhere ────────────────
await openWorkspace();
const docsRow0 = await rowFor('docs');   // a folder row, at the root
check('a folder row exists to check', !!docsRow0, docsRow0 ? '' : 'no "docs" row');
const folderBtnHidden = docsRow0
	? await docsRow0.$eval('.attach-btn', b => b.style.display === 'none').catch(() => 'no .attach-btn at all')
	: 'no row';
check('WITH NOTHING IN FOCUS, the folder row’s control is hidden', folderBtnHidden === true,
	JSON.stringify(folderBtnHidden));

// Into "notes" for the file row -- the gap this work closes.
const notesRow0 = await rowFor('notes');
if (notesRow0) { await notesRow0.$eval('.files-name', e => e.click()); await page.waitForTimeout(600); }
const specRow0 = await rowFor('spec.md');
check('a file row exists to check', !!specRow0, specRow0 ? '' : 'no "spec.md" row');
const fileBtnHidden = specRow0
	? await specRow0.$eval('.attach-btn', b => b.style.display === 'none').catch(() => 'no .attach-btn at all')
	: 'no row';
check('WITH NOTHING IN FOCUS, the FILE row’s control is hidden too', fileBtnHidden === true,
	JSON.stringify(fileBtnHidden));

// Open the file itself: the Doc header's control.
if (specRow0) { await specRow0.$eval('.files-name', e => e.click()); await page.waitForTimeout(700); }
const docBtnHidden = await page.$eval('[data-act="attach"]', b => b.style.display === 'none').catch(() => 'not found');
check('WITH NOTHING IN FOCUS, the Doc header’s control is hidden', docBtnHidden === true,
	JSON.stringify(docBtnHidden));
await shot(s, 'attachfocus-1-nothing-in-focus');
await gotoRoot();

// ── A Diamond, and a chat, to focus on in turn ──────────────────────────
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Ship a CSV parser');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
const diamondId = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const rows = JSON.parse(await app.list_diamonds());
	return rows.find(d => d.name === 'Ship a CSV parser').id;
});
check('a Diamond to focus on', !!diamondId, diamondId);

// ── 2. A Diamond in focus: the FOLDER row's paperclip writes a `holds` ──
// link carrying the workspace -- the FILE case is already proved end to end
// by dev/verify_hold.mjs, so this covers the folder row through the same
// unified control (ATTACH_CONTRACT.md §4 says it is one control).
await openWorkspace();
const docsRow = await rowFor('docs');
check('the "docs" row is offered now a Diamond is in focus', !!docsRow, docsRow ? '' : 'no row');
if (docsRow) {
	const shown = await docsRow.$eval('.attach-btn', b => b.style.display !== 'none').catch(() => false);
	check('and its control is no longer hidden', shown === true, String(shown));
	await docsRow.$eval('.attach-btn', b => b.click());
	await page.waitForTimeout(900);
}
const dLinks = await page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return JSON.parse(await app.links_touching('diamond:' + id) || '[]');
}, diamondId);
const docsLink = dLinks.find(l => /docs$/.test(String(l.other)) && l.other.indexOf('dir:') === 0);
check('WITH A DIAMOND IN FOCUS the folder writes a `holds` link', !!docsLink && docsLink.rel === 'holds',
	JSON.stringify(docsLink));
check('carrying the workspace it was made in', !!docsLink && /^dir:\[browser\]docs$/.test(docsLink.other),
	docsLink && docsLink.other);
await shot(s, 'attachfocus-2-diamond-folder-row');

// Take it off again, so it does not linger into the chat scenario below.
await page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const links = JSON.parse(await app.links_touching('diamond:' + id) || '[]');
	for (const l of links) await app.remove_link(l.owner, l.id).catch(() => {});
}, diamondId);
// Attaching a folder to a brand-new Diamond is ALSO "a new agent being
// initialised" (§6), so it seeded the ONE shared composer with its own
// prefix. That is correct behaviour -- an unsent draft is not this app's to
// discard on a mere switch -- but it is not what properties 3-5 below are
// about, so the draft is cleared explicitly here, the way a person would
// before starting a different conversation.
await page.fill('#chat-input', '');

// ── An ordinary chat, in focus from here on ─────────────────────────────
await newChat(s);
await page.waitForTimeout(400);
const chatFocus = await page.evaluate(() => window.DaimondAttach.focus());
check('a chat is now the focus', chatFocus && chatFocus.kind === 'chat', JSON.stringify(chatFocus));
const chatId = chatFocus && chatFocus.id;

// ── 3. A chat in focus: the control writes NOTHING to the store ────────
// Counted before and after, as a DELTA -- an account can carry seeded default
// Diamonds with links of their own, so "zero links anywhere" is the wrong
// oracle; "no MORE links than before" is the one this property actually
// makes.
const totalDiamondLinks = () => page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const rows = JSON.parse(await app.list_diamonds());
	let total = 0;
	for (const d of rows) total += JSON.parse(await app.links_touching('diamond:' + d.id) || '[]').length;
	return total;
});
const linksBeforeChatAttach = await totalDiamondLinks();

await openWorkspace();
const specRow = await rowFor('spec.md');
if (!specRow) {
	// The tree may still be at the top level; open "notes" first.
	const notesRow = await rowFor('notes');
	if (notesRow) { await notesRow.$eval('.files-name', e => e.click()); await page.waitForTimeout(600); }
}
const specRow2 = (await rowFor('spec.md')) || specRow;
check('the file row is reachable to attach', !!specRow2, specRow2 ? '' : 'no row');
if (specRow2) { await specRow2.$eval('.attach-btn', b => b.click()); await page.waitForTimeout(600); }

const linksAfterChatAttach = await totalDiamondLinks();
check('WITH A CHAT IN FOCUS, attaching writes NOTHING to any Diamond’s store',
	linksAfterChatAttach === linksBeforeChatAttach,
	`${linksBeforeChatAttach} link(s) before, ${linksAfterChatAttach} after`);

const footerShown = await page.$eval('#chat-attachments', e => e.style.display !== 'none');
check('and it shows in the chat footer instead', footerShown === true, String(footerShown));
const tileText = await page.$eval('#chat-attachments .arte-open', e => e.textContent);
check('the tile names the path', /notes\/spec\.md/.test(tileText), tileText);
await shot(s, 'attachfocus-3-chat-footer');

// The Doc header's own paperclip, LIT this time -- shot 1 only proved it
// hidden. Same file, same chat still in focus, opened from its row.
if (specRow2) { await specRow2.$eval('.files-name', e => e.click()); await page.waitForTimeout(700); }
const docBtnLit = await page.$eval('[data-act="attach"]', b => ({
	shown: b.style.display !== 'none', on: b.classList.contains('on'), title: b.title,
})).catch(() => null);
check('the Doc header’s control is offered and lit with the chat in focus',
	!!docBtnLit && docBtnLit.shown && docBtnLit.on, JSON.stringify(docBtnLit));
check('and says the same thing as the row did', docBtnLit && docBtnLit.title === await T('attach.to_focus'),
	docBtnLit && docBtnLit.title);
await shot(s, 'attachfocus-3b-doc-header-lit');
if (await page.$('[data-act="back"]')) { await page.click('[data-act="back"]', { force: true }); await page.waitForTimeout(400); }

// ── 5. Note is what an attachment starts as ─────────────────────────────
const startState = await page.$eval('#chat-attachments .attach-state', e => ({
	text: e.textContent, read: e.classList.contains('read'),
}));
check('THE TILE STARTS AS "Note"', startState.read === false, JSON.stringify(startState));
check('in the app’s own word for it', startState.text === await T('attach.note'), startState.text);

// ── 4. Note generates the note prefix, editable in the composer ────────
const notePrefix = await T('attach.prefix_note', { paths: 'notes/spec.md' });
let composerVal = await page.$eval('#chat-input', e => e.value);
check('NOTE PUTS THE NOTE PREFIX IN THE COMPOSER', composerVal.indexOf(notePrefix) === 0,
	`want prefix "${notePrefix}", got "${composerVal}"`);

// Flip it to Read on the tile.
await page.click('#chat-attachments .attach-state', { force: true });
await page.waitForTimeout(400);
const readState = await page.$eval('#chat-attachments .attach-state', e => ({
	text: e.textContent, read: e.classList.contains('read'),
}));
check('the tile now reads Read', readState.read === true && readState.text === await T('attach.read'),
	JSON.stringify(readState));
const readPrefix = await T('attach.prefix_read', { paths: 'notes/spec.md' });
composerVal = await page.$eval('#chat-input', e => e.value);
check('AND THE COMPOSER NOW CARRIES THE READ PREFIX', composerVal.indexOf(readPrefix) === 0,
	`want prefix "${readPrefix}", got "${composerVal}"`);

// It is ordinary, editable text: typing after it is kept. Control+End, not
// End -- the prefix carries its own trailing newline, so a plain End only
// reaches the end of the FIRST line of a two-line box. Compared against what
// was actually there a moment ago, not a re-derived string: the prefix's
// trailing newline is the generator's choice to keep or drop, not this
// check's to assume.
const beforeTyping = composerVal;
await page.click('#chat-input');
await page.keyboard.press('Control+End');
await page.keyboard.type('please');
composerVal = await page.$eval('#chat-input', e => e.value);
check('IT IS VISIBLE, EDITABLE TEXT -- typing after it is kept, not overwritten',
	composerVal === beforeTyping + 'please', JSON.stringify(composerVal));

// ── 7. An unreachable attachment is never put into the generated prefix ─
// Written directly through the test surface, exactly as verify_attachroot.mjs
// writes a cross-root Diamond link directly: the native folder picker that
// makes one for real cannot be driven headless.
await page.evaluate((id) => window.DaimondAttach.chatToggle(id, 'dir:[machine:elsewhere]nope', true, 'nope'), chatId);
await page.waitForTimeout(300);
const awayTile = await page.$$eval('#chat-attachments .arte-row', rows => rows.map(r => ({
	text: (r.querySelector('.arte-open') || {}).textContent || '',
	away: !!(r.querySelector('.arte-open.away')),
})));
const stray = awayTile.find(t => /nope/.test(t.text));
check('the unreachable one is still SHOWN, marked away', !!stray && stray.away === true, JSON.stringify(awayTile));
composerVal = await page.$eval('#chat-input', e => e.value);
check('BUT IT IS NOT IN THE GENERATED PREFIX', !/nope/.test(composerVal), JSON.stringify(composerVal));
// Take it off again so it does not confuse the send check below.
await page.evaluate((id) => window.DaimondAttach.chatToggle(id, 'dir:[machine:elsewhere]nope', true, 'nope'), chatId);
await page.waitForTimeout(300);

// ── 3 (second half). The footer clears when the turn is sent ───────────
await page.fill('#chat-input', 'go');
await page.click('#chat-send', { force: true });
await page.waitForTimeout(1500);
const footerAfterSend = await page.$eval('#chat-attachments', e => e.style.display).catch(() => 'gone');
check('THE FOOTER CLEARS WHEN THE TURN IS SENT', footerAfterSend === 'none', footerAfterSend);
const listAfterSend = await page.evaluate((id) => window.DaimondAttach.chatList(id).length, chatId);
check('and the queue behind it is actually empty, not just hidden', listAfterSend === 0, String(listAfterSend));
await shot(s, 'attachfocus-4-cleared-after-send');

// 502s are the local gateway proxy (/api) not running in this world -- see
// dev/verify_compact.mjs and dev/verify_credits.mjs for the same exclusion.
const errs = errors(s).filter(e => !/502 \(Bad Gateway\)/.test(e));
check('nothing threw along the way', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(`\n${ok} ok, ${bad} failed`);
if (BREAK) {
	console.log(bad ? `break '${BREAK}' correctly failed ${bad} check(s)`
		: `break '${BREAK}': NOTHING FAILED, so the checks above prove nothing`);
	await s.close();
	process.exit(bad ? 0 : 1);		// a break MUST fail something
}
await s.close();
process.exit(bad ? 1 : 0);
