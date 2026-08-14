// A file open in the Workspace viewer must not go stale when an agent edits it.
// Open a file, have the agent rewrite it on the next turn, and confirm the
// viewer reloads to the agent's new content rather than showing the old.
//
// THE FILE LIVES IN A FOLDER THE USER MARKED INTO THE CHAT, and that is not
// decoration. Until 2026-08-12 the agent was asked to write `live.txt` at the
// workspace ROOT; since the chat fence landed a chat is confined to
// `chats/<id>/work` (`scopeChatTo`, www/js/daimond.js) and `Tool::guard`
// (src/tools.rs:5490) refuses a root path outright -- the refusal arriving as an
// ordinary tool result, so nothing was written and nothing threw.
//
// THE SCRATCH IS NOT A DROP-IN HERE, which is why this file is marked rather than
// re-pathed: `chats/` is not a row in the Workspace panel, and this test is about
// what the PANEL shows. So the fixture does what a user does -- a folder is marked
// into the chat with the paperclip (`chatToggle` + `chatWs`, the mark being the
// permission) -- and the folder is then both writable by the agent and visible in
// the tree. Moving the path back to the root makes every check below vacuous.
import { open, chat, newChat, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'viewer' });
await newChat(s);

// ── The fixture: a folder in the browser workspace, marked into this chat ──
const FOLDER = 'live';
const FILE   = FOLDER + '/live.txt';
const marked = await s.page.evaluate(async (folder) => {
	const root = await navigator.storage.getDirectory();
	await root.getDirectoryHandle(folder, { create: true });
	const f = window.DaimondAttach.focus();
	if (!f || !f.id) return { id: '', scope: [] };
	// `[browser]` is the sandbox root this test runs in -- see `rootedRef`. The
	// paperclip attaches, and the MARK is the separate press that widens the fence.
	const ref = 'dir:[browser]' + folder;
	window.DaimondAttach.chatToggle(f.id, ref, true, folder);
	window.DaimondAttach.chatWs(f.id, ref, true);
	return { id: f.id, scope: await window.DaimondAttach.chatScope(f.id) };
}, FOLDER);
check('the folder is marked into the chat\'s workspace, which is what lets the agent write in it',
	(marked.scope || []).includes(FOLDER), JSON.stringify(marked));

// 1. Agent creates a file.
const wrote = await chat(s, `@tool file_write {"path":"${FILE}","content":"ORIGINAL CONTENT"}`);
check('the agent really wrote it — a refused write leaves nothing to open',
	!/Refused/.test(wrote) && /Wrote \d+ bytes/.test(wrote),
	wrote.slice(-140).replace(/\n/g, ' | '));

// 2. Open the Workspace panel and the file in its viewer.
await s.page.evaluate(() => {
	// Open the Workspace dock panel the real way, so DaimondPanels registers it
	// as open (which the panel's own isOpen() gate checks).
	if (window.DaimondPanels && DaimondPanels.show) DaimondPanels.show('work');
});
await s.page.waitForTimeout(500);
/// Click the row for a path, wherever the tree currently is.
///
/// THE VIEWER IS `#doc-view`, NOT the Workspace panel. `Files.open` shows a text
/// file in the DOC panel (`DaimondPanels.show('doc')`, www/js/daimond.js), and this
/// file went on asking `#panel-work` for a `.files-view-body` that has not been
/// there for as long as the doc panel has existed — a second way the checks below
/// could only ever have printed a red nobody read.
///
/// Rows are found by `data-path` and inside `.files-tree`, never by their text:
/// the panel draws a SECOND tree of its own (`.sys-tree`, the system folders),
/// whose rows are also `.files-row`, and `live` is a substring of `live.txt`. A
/// matcher that cannot tell those apart clicks the wrong row and reports the file
/// as missing — a green-looking red, which is the thing this whole pass is about.
const clickRow = (p) => s.page.evaluate(async (p) => {
	const rows = [...document.querySelectorAll('#panel-work .files-tree .files-row')];
	const row = rows.find(r => r.dataset.path === p);
	if (!row) return { ok: false, rows: rows.map(r => r.dataset.path || r.textContent.trim()) };
	row.click();
	await new Promise(r => setTimeout(r, 700));
	const body = document.querySelector('#doc-view .files-view-body');
	return { ok: true, body: body ? body.textContent : '(no body)' };
}, p);
// Into the folder first: the file is one level down, because the top level is
// where the fence does not let a chat write.
const intoFolder = await clickRow(FOLDER);
check('the marked folder is a row in the Workspace tree', intoFolder.ok, JSON.stringify(intoFolder).slice(0, 200));
const opened = await clickRow(FILE);
console.log('opened viewer:', JSON.stringify(opened).slice(0, 200));
check('the file opens in the viewer, showing what the agent first wrote',
	opened.ok && /ORIGINAL CONTENT/.test(opened.body || ''), JSON.stringify(opened).slice(0, 200));

// 3. Agent rewrites the file on a fresh turn (triggers Files.refresh()).
await chat(s, `@tool file_write {"path":"${FILE}","content":"AGENT REWROTE THIS"}`);
await s.page.waitForTimeout(600);

// 4. The viewer should now show the agent's new content.
const after = await s.page.evaluate(() => {
	const body = document.querySelector('#doc-view .files-view-body');
	const msg  = document.querySelector('#doc-view .files-view-msg');
	return { body: body ? body.textContent : '(none)', msg: msg ? msg.textContent : '' };
});
await shot(s, 'viewer-after-agent-edit');
console.log('viewer after agent edit:', JSON.stringify(after));
check('VIEWER RELOADED to the agent\'s new content', /AGENT REWROTE THIS/.test(after.body),
	JSON.stringify(after).slice(0, 200));
// And it is not merely showing both: the stale copy has to be gone.
check('and the old content is no longer on screen', !/ORIGINAL CONTENT/.test(after.body),
	JSON.stringify(after).slice(0, 200));

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
