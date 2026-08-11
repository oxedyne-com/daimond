// verify_attachfocus.mjs — the paperclip: one control, two behaviours, decided
// by what is in focus and never by which row it sits on.
//
// ATTACH_CONTRACT.md is the design; dev/ATTACH_CONTRACT.md §10 lists seven
// properties, and this covers all seven — stage one's control and states
// (§4, §6, §7) and stage two's footer chrome (§5).
//
//   1. The control appears on a FILE row, a FOLDER row and in the Doc header,
//      and is absent with nothing in focus.
//   2. With a Diamond in focus it writes a `holds` link carrying the workspace.
//   3. With a chat in focus it writes nothing to the DIAMOND store, and what it
//      holds SURVIVES the turn. (§4 originally made a chat's attachment good for
//      one turn only. A chat now carries persistent scope, as a Diamond does —
//      two lifetimes, one meaning — so this asserts the reverse of what it first
//      did, deliberately. See the section itself.)
//   4. Note generates the note prefix, Read generates the read prefix, and the
//      text is in the composer where the user can edit it before sending.
//   5. Note is what an attachment starts as.
//   6. Past the cap the footer scrolls and the composer does not move.
//   7. An unreachable attachment is not in the generated prefix, is shown
//      anyway, and SAYS WHY in words rather than in a hover title.
//
// And §5's other two additions, which arrive with the cap: the view toggle,
// remembered per user, and the `+` that attaches without leaving the page.
//
// WHAT AN UNCAPPED STACK DOES, measured under `--break nocap` rather than
// asserted: at 22 attachments the footer's box grows from 259px to 777px, what
// is left of the panel above it falls from 537px to 240px, the box stops
// scrolling at all (777px of tiles in a 777px box, and `scrollTop` will not
// move off zero), and the composer is pushed from y=841 to y=1444 — off the
// bottom of a 950px window. On the crystal face the same stack squeezes the
// crystal itself to 32px and is then clipped by `.crystal-view`, so the tiles
// past the fold cannot be reached at all.
//
// The composer is measured against UNREACHABLE attachments, which §7 keeps out
// of the generated prefix. With reachable ones the composer moves for a reason
// that is not the footer: each further path lengthens the prefix, the prefix is
// in the textarea, and the textarea grows. That movement is the user's own text
// and is theirs to edit; conflating it with the footer's would make the check
// unfailable in one direction and untrue in the other.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a file to the real page through `page.route`,
// and the run below is then expected to FAIL. A break whose anchor does not
// match aborts rather than passing quietly.
//
//   node dev/verify_attachfocus.mjs --break hidden       # 1 fails: never hides
//   node dev/verify_attachfocus.mjs --break diamondlink  # 2 fails: no link written
//   node dev/verify_attachfocus.mjs --break chatclear    # 3 fails: the scope is emptied
//   node dev/verify_attachfocus.mjs --break prefix       # 4 fails: no prefix generated
//   node dev/verify_attachfocus.mjs --break notedefault  # 5 fails: starts as Read
//   node dev/verify_attachfocus.mjs --break unreachable  # 7 fails: away path in prefix
//   node dev/verify_attachfocus.mjs --break nocap        # 6 fails: the stack has no cap
//   node dev/verify_attachfocus.mjs --break viewforget   # 5b fails: the view is not remembered
//   node dev/verify_attachfocus.mjs --break silentaway   # 7b fails: a shut tile says nothing
//   node dev/verify_attachfocus.mjs --break pickdrops    # 5c fails: `+` attaches nothing
//   node dev/verify_attachfocus.mjs                      # and then, clean
//
//   eval "$(bash dev/world.sh 7 --up)"
//   eval "$(bash dev/world.sh 7 --env)"
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
	// A chat's scope is emptied when a turn is sent -- which is what the app used
	// to do, and is now the bug: the user attaches a folder, asks a question, and
	// the folder is gone before they can ask a second one.
	chatclear: {
		file: 'js/daimond.js',
		find: `		text = conciseText(chat, text);`,
		with: `		chat.holds = []; attachChanged(); persistChats();
		text = conciseText(chat, text);`,
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
	// The cap is taken off the stack, so the footer grows with every tile and
	// eats the panel above it -- the state stage two exists to end.
	nocap: {
		file: 'css/app.css',
		find: `.attach-body { max-height: calc(var(--attach-cap) * var(--attach-row-h) + var(--attach-peek));
	overflow-y: auto; scrollbar-gutter: stable; scrollbar-width: thin; }`,
		with: `.attach-body { overflow-y: auto; }`,
	},
	// The choice of view is never written down, so it lasts until the tab is
	// reloaded and no longer.
	viewforget: {
		file: 'js/daimond.js',
		find: `		try { localStorage.setItem(ATTACH_VIEW_KEY, attachViewNow); }
		catch (e) { /* private mode: the choice holds for this session only */ }`,
		with: `		/* the choice is never written down */`,
	},
	// A tile that cannot be opened stops saying why, and is back to reading as
	// an empty folder -- what §7 and §9 both exist to prevent.
	silentaway: {
		file: 'js/daimond.js',
		find: `				reason: away ? t('dws.not_here', { where: refWhere(a.ref) }) : '',`,
		with: `				reason: '',`,
	},
	// The picker asks the Workspace panel's CACHE what is attached instead of
	// asking the store. The cache is filled when the tree is listed, so
	// anything attached since reads as unattached -- and a tick on one of those
	// would have taken it off rather than put it on.
	pickstale: {
		file: 'js/daimond.js',
		find: `			attached:      attachedTruly,`,
		with: `			attached:      function (p, d) { return attachStateOf(p, !!d).on; },`,
	},
	// The picker forgets what was ticked, so `+` opens, closes and attaches
	// nothing.
	pickdrops: {
		file: 'js/daimond.js',
		find: `			return { read: function () { return ticked; } };`,
		with: `			return { read: function () { return {}; } };`,
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

// No fixed profile is wanted, and none is needed for the reload below: the
// harness opens a PERSISTENT context on a directory of its own, so
// localStorage survives a reload inside one run while still being this run's
// alone.
const s = await open({ name: 'attachfocus', signIn: false, connect: false });
const { page } = s;

/// Serve one deliberately damaged file in place of the real one. Installed
/// before the app is loaded, and again after any reload, because a route
/// only takes effect on a load that happens after it.
async function installBreak() {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	// A stylesheet served as JavaScript is dropped by the browser, and the run
	// would then be testing an app with no CSS at all rather than the one break
	// it names.
	const type = /\.css$/.test(spec.file) ? 'text/css' : 'application/javascript';
	await page.route('**/' + spec.file, r => r.fulfill({ status: 200, contentType: type, body }));
}
await installBreak();

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

// ── §5. The crystal footer is the SAME component as the chat's ─────────
// Not "looks like": the same chrome, drawn by the same function. A few more
// links so the stack is worth looking at, then the strip that opens it.
await page.evaluate(async ([id, paths]) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	for (const p of paths) await app.add_link(id, 'diamond:' + id, 'file:[browser]' + p, 'holds', '', 'user');
	// One from the other workspace, so a shut tile is in the picture here too.
	await app.add_link(id, 'diamond:' + id, 'dir:[machine:elsewhere]books/x', 'holds', '', 'user');
}, [diamondId, ['notes/spec.md', 'docs/plan.md']]);
await page.evaluate(() => window.DaimondArtefacts.render());
await page.waitForTimeout(400);
await page.evaluate(() => { const b = document.getElementById('arte-strip'); if (b) b.click(); });
await page.waitForTimeout(600);
const crystalStack = await page.evaluate(() => ({
	head:  !!document.querySelector('#arte-list .attach-head'),
	view:  (document.querySelector('#arte-list [data-act="attach-view"]') || {}).textContent || '',
	add:   !!document.querySelector('#arte-list [data-act="attach-add"]'),
	box:   Math.round((document.querySelector('#arte-list .attach-body') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
	tiles: [...document.querySelectorAll('#arte-list .arte-row')].map(r => ({
		path:  (r.querySelector('.arte-open') || {}).textContent || '',
		state: (r.querySelector('.attach-state') || {}).textContent || '',
		why:   (r.querySelector('.arte-why') || {}).textContent || '',
	})),
}));
check('THE CRYSTAL FOOTER WEARS THE SAME CHROME: a view toggle and a `+`',
	crystalStack.head && crystalStack.add && crystalStack.view === await T('attach.view_icons'),
	JSON.stringify({ head: crystalStack.head, view: crystalStack.view, add: crystalStack.add }));
const wordNote = await T('attach.note');
check('and its tile for notes/spec.md reads Note',
	!!crystalStack.tiles.find(t => t.path === 'notes/spec.md' && t.state === wordNote),
	JSON.stringify(crystalStack.tiles));
check('and its tile for the folder that is elsewhere says so on the tile',
	!!crystalStack.tiles.find(t => t.path === 'books/x' && /elsewhere/.test(t.why)),
	JSON.stringify(crystalStack.tiles.map(t => [t.path, t.why.slice(0, 40)])));
check('and it is capped by the same rule the chat footer is',
	crystalStack.box > 0 && crystalStack.box <= 260, String(crystalStack.box));
await shot(s, 'attachfocus-2b-crystal-footer-stack');
await page.click('#arte-list [data-act="attach-view"]', { force: true });
await page.waitForTimeout(500);
const crystalIcons = await page.evaluate(() => [...document.querySelectorAll('#arte-list .attach-icon')].map(c => ({
	name:  (c.querySelector('.arte-open') || {}).textContent || '',
	state: (c.querySelector('.attach-state') || {}).textContent || '',
	shut:  c.classList.contains('shut'),
})));
check('AND THE ICON VIEW IS THE ONE CONTROL, not one per footer -- the crystal turns too',
	!!crystalIcons.find(c => c.name === 'spec.md' && c.state === wordNote),
	JSON.stringify(crystalIcons));
check('with the unreachable one still marked as shut', !!crystalIcons.find(c => c.name === 'x' && c.shut),
	JSON.stringify(crystalIcons));
await shot(s, 'attachfocus-2c-crystal-footer-icons');
await page.click('#arte-list [data-act="attach-view"]', { force: true });
await page.waitForTimeout(400);

// ── §5. The `+` never takes anything OFF ───────────────────────────────
// The two links above were written straight to the store, after the Workspace
// panel had listed its tree — so the panel's cached idea of what this Diamond
// holds is out of date, which is exactly the state in which a picker that
// consults the cache shows an attached file as unattached. Ticking one would
// then have DETACHED it. The row must be ticked and fixed.
await page.click('#arte-list [data-act="attach-add"]', { force: true });
await page.waitForSelector('.attach-pick-row', { timeout: 10000 });
for (const b of await page.$$('.attach-pick-name.dir')) {
	if (/notes/.test(await b.textContent())) { await b.click(); break; }
}
await page.waitForTimeout(700);
const stalePick = await page.$$eval('.attach-pick-row', rows => rows.map(r => ({
	name:   r.querySelector('.attach-pick-name').textContent.replace(/^\S+\s/, ''),
	ticked: r.querySelector('input').checked,
	fixed:  r.querySelector('input').disabled,
})));
const specPick = stalePick.find(r => r.name === 'spec.md');
check('THE PICKER KNOWS notes/spec.md IS ALREADY HELD, and will not offer to undo it',
	!!specPick && specPick.ticked && specPick.fixed, JSON.stringify(stalePick));
await page.click('.dlg-cancel', { force: true });
await page.waitForTimeout(400);

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

// ── 7b. And it SAYS WHY, in words on the tile ──────────────────────────
// A hover title is not available to a touch, and an item that is silently
// inert on a phone is the empty-folder failure this exists to end. §9 wants
// the same capability for a Diamond in the trash, so it is the tile that
// carries it, not the away case.
const shutTile = await page.$$eval('#chat-attachments .arte-row', rows => rows.map(r => ({
	text: (r.querySelector('.arte-open') || {}).textContent || '',
	why:  (r.querySelector('.arte-why') || {}).textContent || '',
	// A `span`, not a `button`: there is nothing to press, and offering a
	// press that cannot work is the distrust §4 warns about.
	openable: !!r.querySelector('button.arte-open'),
}))).then(rows => rows.find(r => /nope/.test(r.text)));
const notHere = await T('dws.not_here', { where: await T('dws.in_machine', { name: 'elsewhere' }) });
check('THE SHUT TILE SAYS WHY IN WORDS ON THE TILE, not only on hover',
	!!shutTile && shutTile.why === notHere, JSON.stringify(shutTile && shutTile.why));
check('and offers no way to open what cannot be opened',
	!!shutTile && shutTile.openable === false, JSON.stringify(shutTile));
await shot(s, 'attachfocus-5-shut-tile');
// Take it off again so it does not confuse the checks below.
await page.evaluate((id) => window.DaimondAttach.chatToggle(id, 'dir:[machine:elsewhere]nope', true, 'nope'), chatId);
await page.waitForTimeout(300);

// ── §5. The view toggle: the stack, or rows of sizeable icons ──────────
// One control, two positions, and its word is the view it will GIVE you.
const viewBtn = '#chat-attachments [data-act="attach-view"]';
const toIcons = await page.$eval(viewBtn, b => ({ text: b.textContent, view: b.dataset.view }));
check('the footer offers ONE view control, which offers the icon view',
	toIcons.view === 'icons' && toIcons.text === await T('attach.view_icons'), JSON.stringify(toIcons));
await page.click(viewBtn, { force: true });
await page.waitForTimeout(400);
// Assert MEANING: the tile for notes/spec.md is now an icon, its name is the
// leaf of that path, and it still reads Read -- the state survives the view,
// because the view is how it is drawn and not what it is.
const iconTile = await page.$$eval('#chat-attachments .attach-icon', cells => cells.map(c => ({
	name:  (c.querySelector('.arte-open') || {}).textContent || '',
	state: (c.querySelector('.attach-state') || {}).textContent || '',
	w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height),
}))).then(cells => cells.find(c => c.name === 'spec.md'));
check('IN THE ICON VIEW, the tile for notes/spec.md is an icon named spec.md',
	!!iconTile, JSON.stringify(iconTile));
check('and it still reads Read', !!iconTile && iconTile.state === await T('attach.read'),
	JSON.stringify(iconTile && iconTile.state));
// "sizeable icons -- not button-sized" (§5). The buttons beside them on a tile
// are 26px, so anything in that neighbourhood has missed the point.
check('and the icon is SIZEABLE -- not button-sized',
	!!iconTile && iconTile.w >= 64 && iconTile.h >= 64, JSON.stringify(iconTile && [iconTile.w, iconTile.h]));
const stackGone = await page.$$eval('#chat-attachments .arte-row', r => r.length);
check('the stack is not drawn underneath it as well', stackGone === 0, String(stackGone));
await shot(s, 'attachfocus-6-icon-view');

// Back to the stack for the measurements below, which are in tiles. That the
// choice is REMEMBERED is proved at the end of this file, through a reload.
await page.click(viewBtn, { force: true });
await page.waitForTimeout(400);

// ── §5. The `+`: attach without leaving what you are reading ───────────
// docs/plan.md is not attached and is in another folder, so the picker has to
// be walked into rather than merely opened.
await page.click('#chat-attachments [data-act="attach-add"]', { force: true });
await page.waitForSelector('.attach-pick-row', { timeout: 10000 });
for (const b of await page.$$('.attach-pick-name.dir')) {
	if (/docs/.test(await b.textContent())) { await b.click(); break; }
}
await page.waitForTimeout(700);
const pickRows = await page.$$eval('.attach-pick-row', rows => rows.map(r => ({
	name: r.querySelector('.attach-pick-name').textContent.replace(/^\S+\s/, ''),
	fixed: r.querySelector('input').disabled,
})));
check('the picker walks into a folder and lists what is in it',
	pickRows.some(r => r.name === 'plan.md'), JSON.stringify(pickRows));
for (const r of await page.$$('.attach-pick-row')) {
	if (/plan\.md/.test(await r.$eval('.attach-pick-name', e => e.textContent))) {
		await r.$eval('input', i => i.click());
		break;
	}
}
await shot(s, 'attachfocus-7-picker');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
const afterPick = await page.$$eval('#chat-attachments .arte-row', rows => rows.map(r => ({
	path:  (r.querySelector('.arte-open') || {}).textContent || '',
	state: (r.querySelector('.attach-state') || {}).textContent || '',
})));
const planTile = afterPick.find(r => r.path === 'docs/plan.md');
check('THE `+` ATTACHES WHAT WAS TICKED -- the tile for docs/plan.md is there',
	!!planTile, JSON.stringify(afterPick));
// Note is the default, and a route in that quietly chose Read would be the
// one that spends the user's money unasked.
check('and it reads Note, like anything else newly attached',
	!!planTile && planTile.state === await T('attach.note'), JSON.stringify(planTile));
const afterPickComposer = await page.$eval('#chat-input', e => e.value);
check('and the generated prefix names that path',
	/docs\/plan\.md/.test(afterPickComposer), JSON.stringify(afterPickComposer));

// ── 6. Past the cap the footer scrolls, and the composer does not move ─
// Twenty-two files, so the stack is well past six either way. They are
// REACHABLE, so every tile is an ordinary one tile tall and the cap is being
// measured against the thing it is expressed in.
const many = [];
for (let i = 0; i < 22; i++) many.push(`bulk/item-${String(i).padStart(2, '0')}.md`);
await page.evaluate(async (many) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	for (const p of many) await app.run_tool('file_write', JSON.stringify({ path: p, content: '# x\n' }));
}, many);

/// Everything the cap is about, in one read: the footer's own box, what is
/// left of the conversation above it, and where the composer sits.
const geom = () => page.evaluate(() => {
	const body = document.querySelector('#chat-attachments .attach-body');
	const bar  = document.querySelector('.chat-input-bar');
	const out  = document.querySelector('.chat-output');
	const r = el => el ? el.getBoundingClientRect() : { height: 0, top: 0 };
	return {
		box:    Math.round(r(body).height),
		inside: body ? body.scrollHeight : 0,
		tiles:  document.querySelectorAll('#chat-attachments .arte-row').length,
		talk:   Math.round(r(out).height),
		bar:    Math.round(r(bar).top),
		barH:   Math.round(r(bar).height),
	};
});

/// Attach `many[from..to)` -- a RANGE, because the control is a toggle and
/// re-attaching what is already attached takes it off again.
const attachRange = async (from, to) => {
	for (const p of many.slice(from, to)) {
		await page.evaluate(([id, p]) => window.DaimondAttach.chatToggle(id, `file:[browser]${p}`, false, p), [chatId, p]);
	}
	await page.waitForTimeout(500);
	return geom();
};
const atSix = await attachRange(0, 6);
const atAll = await attachRange(6, 22);
check('twenty-two tiles are in the footer', atAll.tiles >= 22, JSON.stringify(atAll));
check('PAST THE CAP THE FOOTER STOPS GROWING',
	atAll.box === atSix.box, `${atSix.box}px at 6 tiles, ${atAll.box}px at 22`);
// The conversation and the composer measured TOGETHER: everything the panel
// has that is not the footer. Separately, the conversation shrinks here for an
// honest reason -- each further attachment lengthens the generated prefix, the
// prefix is in the textarea, and the textarea grows into the space above it.
// The PAIR is what the footer is taking, and past the cap it must stop taking.
check('and it stops taking room from the rest of the panel',
	atAll.talk + atAll.barH === atSix.talk + atSix.barH,
	`${atSix.talk}+${atSix.barH} at 6 tiles, ${atAll.talk}+${atAll.barH} at 22`);
check('AND IT SCROLLS: there is more inside the box than the box shows',
	atAll.inside > atAll.box + 10, `${atAll.inside}px of tiles in a ${atAll.box}px box`);

// Not "there is a scrollbar" but "the last tile can be got to". Measured
// against the box, twice: below it before scrolling, inside it after.
const lastTilePos = () => page.evaluate(() => {
	const body = document.querySelector('#chat-attachments .attach-body');
	const rows = [...body.querySelectorAll('.arte-row')];
	const last = rows.find(r => /item-21\.md/.test(r.textContent));
	if (!last) return null;
	const b = body.getBoundingClientRect(), t = last.getBoundingClientRect();
	return { below: Math.round(t.top - b.bottom), scrollTop: Math.round(body.scrollTop) };
});
const before = await lastTilePos();
check('the last tile starts out below the fold', !!before && before.below > 0, JSON.stringify(before));
await page.evaluate(() => {
	const body = document.querySelector('#chat-attachments .attach-body');
	body.scrollTop = body.scrollHeight;
});
await page.waitForTimeout(300);
const after = await lastTilePos();
check('AND SCROLLING BRINGS IT INTO VIEW', !!after && after.scrollTop > 0 && after.below <= 0,
	JSON.stringify(after));
await shot(s, 'attachfocus-8-capped-and-scrolled');

// Everything the cap section queued, off again: what follows is about the
// composer alone, and then about the footer clearing.
for (const p of many) {
	await page.evaluate(([id, p]) => window.DaimondAttach.chatToggle(id, `file:[browser]${p}`, false, p), [chatId, p]);
}
await page.evaluate((id) => window.DaimondAttach.chatToggle(id, 'file:[browser]docs/plan.md', false, 'docs/plan.md'), chatId);
await page.waitForTimeout(400);

// ── 6 (second half). And the composer does not move ────────────────────
// Measured against UNREACHABLE attachments, which §7 keeps out of the
// generated prefix: the footer fills, the composer's own text does not change,
// and anything that moved is then the footer's doing and nothing else. Without
// the cap, measured, the composer goes from y=841 to y=1444 -- off the bottom
// of the window.
const awayRange = async (from, to) => {
	for (let i = from; i < to; i++) {
		await page.evaluate(([id, i]) => window.DaimondAttach.chatToggle(
			id, `dir:[machine:elsewhere]far/${i}`, true, `far/${i}`), [chatId, i]);
	}
	await page.waitForTimeout(400);
	return geom();
};
const awaySix = await awayRange(0, 6);
const awayAll = await awayRange(6, 22);
const composerText = await page.$eval('#chat-input', e => e.value);
check('with the composer’s own text unchanged, twenty-two shut tiles are queued',
	awayAll.tiles >= 22 && !/far\//.test(composerText),
	`${awayAll.tiles} tiles, composer ${JSON.stringify(composerText)}`);
check('THE COMPOSER HAS NOT MOVED', awayAll.bar === awaySix.bar,
	`${awaySix.bar} at 6 tiles, ${awayAll.bar} at 22`);
// Off again, leaving notes/spec.md queued -- the send check below is only
// worth anything with something in the footer to clear.
for (let i = 0; i < 22; i++) {
	await page.evaluate(([id, i]) => window.DaimondAttach.chatToggle(
		id, `dir:[machine:elsewhere]far/${i}`, true, `far/${i}`), [chatId, i]);
}
await page.waitForTimeout(400);
check('and one ordinary attachment is still queued, for the send check below',
	await page.evaluate((id) => window.DaimondAttach.chatList(id).length, chatId) === 1);

// ── 3 (second half). The scope SURVIVES the turn ───────────────────────
//
// THIS CHECK USED TO ASSERT THE OPPOSITE, and the reversal is a decision and not
// a regression. ATTACH_CONTRACT.md §4 originally made a chat's attachment good
// for one turn: the footer was emptied at the send, and `clearChatAttach` did
// it. A chat now carries PERSISTENT SCOPE, exactly as a Diamond does — the user
// brings files into a conversation by hand and they stay there — because the
// paperclip cannot mean two different things on two surfaces and be understood
// on either.
//
// Two lifetimes, one meaning: a Diamond's holdings persist because a Diamond
// does, a chat's expire with the chat. So what is asserted here is that sending
// a turn is not an event that empties anything, and the old wording is left
// above so a reader who remembers the contract can see which way it went.
await page.fill('#chat-input', 'go');
await page.click('#chat-send', { force: true });
await page.waitForTimeout(1500);
const listAfterSend = await page.evaluate((id) => window.DaimondAttach.chatList(id).length, chatId);
check('A CHAT KEEPS WHAT IT HOLDS WHEN A TURN IS SENT', listAfterSend === 1, String(listAfterSend));
const footerAfterSend = await page.$eval('#chat-attachments', e => e.style.display).catch(() => 'gone');
check('and the footer still shows it, because it is still true',
	footerAfterSend !== 'none', footerAfterSend);
await shot(s, 'attachfocus-4-kept-after-send');

// ── §5. The view is remembered PER USER, across a reload ───────────────
// Last, because it is the only thing here that needs the page to go away and
// come back. Read afterwards through the app's own answer and through what
// the footer DRAWS, not by peeking at a key: a string in a store that nothing
// reads is not a remembered preference.
// Whatever the section above left behind -- a break may well have left the
// footer as it was -- there must be exactly something in it for the toggle to
// be on screen at all. Asked, not assumed: a run that dies here reports
// nothing, and a break that reports nothing proves nothing.
if (!await page.evaluate((id) => window.DaimondAttach.chatList(id).length, chatId)) {
	await page.evaluate((id) => window.DaimondAttach.chatToggle(id, 'file:[browser]notes/spec.md', false, 'notes/spec.md'), chatId);
	await page.waitForTimeout(400);
}
check('a footer is on screen to turn', await page.$(viewBtn) !== null);
await page.click(viewBtn, { force: true }).catch(() => {});
await page.waitForTimeout(400);
check('the icon view is chosen before the reload',
	await page.evaluate(() => window.DaimondAttach.view()) === 'icons');
await installBreak();		// a route only bites on a load made after it
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'attachfocus');
await page.waitForTimeout(1500);
check('THE VIEW SURVIVES A RELOAD',
	await page.evaluate(() => window.DaimondAttach.view()) === 'icons',
	await page.evaluate(() => window.DaimondAttach.view()));
await newChat(s);
await page.waitForTimeout(600);
const reborn = await page.evaluate(() => window.DaimondAttach.focus().id);
await page.evaluate((id) => window.DaimondAttach.chatToggle(id, 'file:[browser]notes/spec.md', false, 'notes/spec.md'), reborn);
await page.waitForTimeout(500);
const drawnAfterReload = await page.evaluate(() => ({
	icons: document.querySelectorAll('#chat-attachments .attach-icon').length,
	rows:  document.querySelectorAll('#chat-attachments .arte-row').length,
	name:  (document.querySelector('#chat-attachments .attach-icon .arte-open') || {}).textContent || '',
}));
check('and a footer drawn AFTER it comes back in the icon view, naming spec.md',
	drawnAfterReload.icons === 1 && drawnAfterReload.rows === 0 && drawnAfterReload.name === 'spec.md',
	JSON.stringify(drawnAfterReload));
await shot(s, 'attachfocus-9-view-after-reload');

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
