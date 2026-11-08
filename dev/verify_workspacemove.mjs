// gateway: none
// verify_workspacemove.mjs -- a file is moved in the Workspace panel by dragging it, by a
// folder picker, by cut and paste, or by dropping it in from the desktop -- never by typing
// a path into Rename.
//
// The owner, 2026-11-08: "moving a file in the Workspace panel means renaming it to a typed
// path, which is a stupid UX". What must be true, driven through the real page:
//   A  dragging a row onto a folder row moves it there, and the Undo puts it back;
//   B  the row's ... holds Move to..., whose picker moves it into the folder chosen;
//   C  files dropped on a folder row from OUTSIDE the page are uploaded into that folder;
//   D  Ctrl/Cmd+X then V moves the cut rows into the folder selected, or the open folder;
//   E  Ctrl/Cmd+click selects several rows, and a drag carries all of them;
//   F  Rename renames: a name holding a path is refused in the dialog and nothing moves;
//   G  a move is still undoable after another move has replaced its toast, and after the
//      moved thing has itself been moved again (the Undo follows it).
//
// The panel's rows are the page's own: `.files-row[data-path]` inside `#panel-work .files-tree`.
import { open, errors } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (pass, name, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const rowSel = (p) => `#panel-work .files-tree .files-row[data-path="${p}"]`;

// What is on the disk, asked of the handles and never of the panel: a row that is drawn is
// not a file that is there.
const fileAt = (page, p) => page.evaluate(async (p) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { await m.read_file(p); return true; } catch (e) { return false; }
}, p);
const dirAt = (page, p) => page.evaluate(async (p) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const o = await app.run_tool_outcome('file_list', JSON.stringify({ path: p }));
	return !!o && o.outcome === 'done';
}, p);

const s = await open({ name: 'wsmove' });
const p = s.page;
await wait(1500);

// ── The fixture: a root of files, two folders and one inside a folder ───────────
await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const put = (path, body) => app.run_tool('file_write', JSON.stringify({ path, content: body }));
	const dir = (path) => app.run_tool('dir_create', JSON.stringify({ path }));
	await dir('papers'); await dir('papers/deep'); await dir('f1'); await dir('f2');
	for (const n of ['a.txt', 'b.txt', 'c.txt', 'e1.txt', 'e2.txt', 'h.txt', 'm1.md', 'm2.md', 'other.txt', 'r.txt']) {
		await put(n, n + '\n');
	}
	await put('papers/inside.txt', 'inside\n');
});
await p.evaluate(() => document.getElementById('new-session-btn').click());
await wait(800);
await p.evaluate(() => DaimondPanels.show('work'));
await wait(1200);
const refresh = () => p.evaluate(() => {
	const more = document.querySelector('#panel-work [data-act="ws-more"]');
	if (!more) return false;
	more.click();
	const it = document.querySelector('.railhead-menu [data-act="refresh"]');
	if (it) { it.click(); return true; }
	more.click();
	return false;
});
await refresh();
await wait(1200);

const drawn = async (path) => p.evaluate((sel) => !!document.querySelector(sel), rowSel(path));
check(await drawn('a.txt') && await drawn('papers') && await drawn('f1'),
	'A: the fixture is drawn as rows', JSON.stringify({ a: await drawn('a.txt'), papers: await drawn('papers'), f1: await drawn('f1') }));

// The toast the app offers after an act, and the press on it.
const toast = () => p.evaluate(() => {
	const u = document.getElementById('daimond-undo');
	return !!u && !u.hidden && !!u.querySelector('.daimond-undo-btn');
});
const pressUndo = async () => {
	await p.evaluate(() => { const b = document.querySelector('#daimond-undo .daimond-undo-btn'); if (b) b.click(); });
	await wait(1400);
};
const rowMore = async (path) => {
	await p.hover(rowSel(path));
	await wait(200);
	await p.click(rowSel(path) + ' [data-act="row-more"]');
	await wait(350);
};
const menuActs = () => p.evaluate(() => {
	const m = document.querySelector('.railhead-menu[data-menu="row"]');
	return m ? [...m.querySelectorAll('[data-act]')].map((b) => b.dataset.act) : null;
});
const closeMenu = async () => { await p.keyboard.press('Escape').catch(() => {}); await wait(250); };
const menuPress = async (act) => {
	const did = await p.evaluate((act) => {
		const b = document.querySelector(`.railhead-menu[data-menu="row"] [data-act="${act}"]`);
		if (!b) return false;
		b.click();
		return true;
	}, act);
	await wait(500);
	return did;
};

// ── A. Drag a row onto a folder ────────────────────────────────────────────────
const draggable = await p.evaluate((sel) => {
	const r = document.querySelector(sel);
	return !!r && r.getAttribute('draggable') === 'true';
}, rowSel('a.txt'));
check(draggable, 'A: a tree row is draggable', String(draggable));

await p.dragAndDrop(rowSel('a.txt'), rowSel('papers'));
await wait(1600);
check(await fileAt(p, 'papers/a.txt') && !(await fileAt(p, 'a.txt')),
	'A: dragging a row onto a folder moves the file there',
	JSON.stringify({ inPapers: await fileAt(p, 'papers/a.txt'), stillRoot: await fileAt(p, 'a.txt') }));
check(await toast(), 'A: the move offers an Undo');
await pressUndo();
check(await fileAt(p, 'a.txt') && !(await fileAt(p, 'papers/a.txt')),
	'A: the Undo puts it back',
	JSON.stringify({ root: await fileAt(p, 'a.txt'), inPapers: await fileAt(p, 'papers/a.txt') }));
await wait(300);

// ── B. Move to... in the row's ... ────────────────────────────────────────────
await rowMore('b.txt');
const acts = await menuActs();
check(!!acts && acts.includes('moveto'), 'B: the row ... holds Move to...', JSON.stringify(acts));
check(await menuPress('moveto'), 'B: pressing Move to... opens a folder picker');
const picker = await p.evaluate(() => {
	const d = document.querySelector('.files-move-pick');
	return d ? [...d.querySelectorAll('[data-path]')].map((r) => r.dataset.path) : null;
});
check(!!picker && picker.includes('f1') && picker.includes('papers'),
	'B: the picker lists the folders, not the files', JSON.stringify(picker));
// Into f1, chosen by its row and confirmed.
await p.evaluate(() => {
	const r = [...document.querySelectorAll('.files-move-pick [data-path]')].find((x) => x.dataset.path === 'f1');
	if (r) r.click();
});
await wait(250);
await p.click('.dlg-ok');
await wait(1500);
check(await fileAt(p, 'f1/b.txt') && !(await fileAt(p, 'b.txt')),
	'B: the picker moves the file into the folder chosen',
	JSON.stringify({ inF1: await fileAt(p, 'f1/b.txt'), root: await fileAt(p, 'b.txt') }));
await pressUndo();

// ── C. Files dropped in from the desktop land in the folder dropped on ────────
const dropped = await p.evaluate((sel) => {
	const row = document.querySelector(sel);
	if (!row) return 'no row';
	const dt = new DataTransfer();
	dt.items.add(new File(['from the desktop\n'], 'dropped.txt', { type: 'text/plain' }));
	for (const type of ['dragover', 'drop']) {
		row.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
	}
	return 'sent';
}, rowSel('papers'));
await wait(2000);
check(dropped === 'sent' && await fileAt(p, 'papers/dropped.txt'),
	'C: a file dropped on a folder row is uploaded into that folder',
	JSON.stringify({ dropped, there: await fileAt(p, 'papers/dropped.txt') }));

// ── D. Cut and paste ─────────────────────────────────────────────────────────
const ctrl = (key) => p.keyboard.press(`Control+${key}`);
await p.click(rowSel('c.txt'), { modifiers: ['Control'] });
await wait(250);
const selOne = await p.evaluate((sel) => {
	const r = document.querySelector(sel);
	return !!r && (r.classList.contains('sel') || r.getAttribute('aria-selected') === 'true');
}, rowSel('c.txt'));
check(selOne, 'E: Ctrl+click selects a row without opening it');
check(!(await p.evaluate(() => !!document.querySelector('#doc-view .files-view-head'))),
	'E: a Ctrl+click does not open the file');
await ctrl('x');
await wait(300);
check(await p.evaluate(() => !!document.querySelector('#panel-work .files-row.cut, #panel-work .files-row[data-cut="true"]')),
	'D: Ctrl+X marks the row as cut');
await p.click(rowSel('f2'), { modifiers: ['Control'] });
await wait(250);
await ctrl('v');
await wait(1600);
check(await fileAt(p, 'f2/c.txt') && !(await fileAt(p, 'c.txt')),
	'D: Ctrl+V moves the cut file into the folder selected',
	JSON.stringify({ inF2: await fileAt(p, 'f2/c.txt'), root: await fileAt(p, 'c.txt') }));
await pressUndo();

// ── E. Multi-select, and a drag that carries them all ─────────────────────────
await p.click(rowSel('e1.txt'), { modifiers: ['Control'] });
await wait(200);
await p.click(rowSel('e2.txt'), { modifiers: ['Control'] });
await wait(250);
const selCount = await p.evaluate(() => document.querySelectorAll('#panel-work .files-tree .files-row.sel, #panel-work .files-tree .files-row[aria-selected="true"]').length);
check(selCount >= 2, 'E: Ctrl+click selects several rows', String(selCount));
await p.dragAndDrop(rowSel('e2.txt'), rowSel('f1'));
await wait(1800);
check(await fileAt(p, 'f1/e1.txt') && await fileAt(p, 'f1/e2.txt'),
	'E: dragging one of several selected rows carries all of them',
	JSON.stringify({ e1: await fileAt(p, 'f1/e1.txt'), e2: await fileAt(p, 'f1/e2.txt') }));
await pressUndo();
check(await fileAt(p, 'e1.txt') && await fileAt(p, 'e2.txt'), 'E: and one Undo puts them all back',
	JSON.stringify({ e1: await fileAt(p, 'e1.txt'), e2: await fileAt(p, 'e2.txt') }));

// ── F. Rename only renames ───────────────────────────────────────────────────
await rowMore('r.txt');
await menuPress('rename');
await wait(500);
await p.fill('.dlg-input', 'papers/r.txt');
await p.keyboard.press('Enter');
await wait(500);
const refused = await p.evaluate(() => {
	const d = document.querySelector('.dlg-err');
	return { open: !!document.querySelector('.dlg-input'), said: d ? d.textContent.trim() : '' };
});
check(refused.open && !!refused.said,
	'F: Rename refuses a name that holds a path, and says why in the dialog', JSON.stringify(refused));
await p.keyboard.press('Escape');
await wait(600);
check(await fileAt(p, 'r.txt') && !(await fileAt(p, 'papers/r.txt')),
	'F: and nothing moved',
	JSON.stringify({ root: await fileAt(p, 'r.txt'), inPapers: await fileAt(p, 'papers/r.txt') }));
// A plain name still renames.
await rowMore('r.txt');
await menuPress('rename');
await wait(500);
await p.fill('.dlg-input', 'renamed.txt');
await p.keyboard.press('Enter');
await wait(1400);
check(await fileAt(p, 'renamed.txt') && !(await fileAt(p, 'r.txt')),
	'F: Rename still renames, in place',
	JSON.stringify({ renamed: await fileAt(p, 'renamed.txt'), old: await fileAt(p, 'r.txt') }));
await pressUndo();

// ── G. Undo survives a later move, and follows a thing moved again ───────────
await p.dragAndDrop(rowSel('m1.md'), rowSel('f1'));
await wait(1500);
await p.dragAndDrop(rowSel('m2.md'), rowSel('f2'));
await wait(1500);
check(await fileAt(p, 'f1/m1.md') && await fileAt(p, 'f2/m2.md'), 'G: two moves, each into its own folder',
	JSON.stringify({ m1: await fileAt(p, 'f1/m1.md'), m2: await fileAt(p, 'f2/m2.md') }));
// The toast is now m2's. The ... still offers the move that was made before it.
await rowMore('other.txt');
const gacts = await menuActs();
check(!!gacts && gacts.includes('undo-move'), 'G: the ... still holds Undo move after the toast moved on', JSON.stringify(gacts));
await menuPress('undo-move');
await wait(1500);
check(await fileAt(p, 'm2.md') && !(await fileAt(p, 'f2/m2.md')), 'G: it takes back the newest move first',
	JSON.stringify({ m2: await fileAt(p, 'm2.md'), inF2: await fileAt(p, 'f2/m2.md') }));
await rowMore('other.txt');
await menuPress('undo-move');
await wait(1500);
check(await fileAt(p, 'm1.md') && !(await fileAt(p, 'f1/m1.md')),
	'G: and the one before it, whose toast was gone',
	JSON.stringify({ m1: await fileAt(p, 'm1.md'), inF1: await fileAt(p, 'f1/m1.md') }));

// And the same thing moved twice: the Undo follows it and puts it back at the start.
await p.dragAndDrop(rowSel('h.txt'), rowSel('papers'));
await wait(1500);
await p.click(rowSel('papers'));
await wait(1400);
await p.dragAndDrop(rowSel('papers/h.txt'), rowSel('papers/deep'));
await wait(1600);
const nested = await fileAt(p, 'papers/deep/h.txt');
await p.click('#panel-work .files-tree .files-row[data-act="up"]');
await wait(1200);
await rowMore('other.txt');
await menuPress('undo-move');
await wait(1500);
await rowMore('other.txt');
await menuPress('undo-move');
await wait(1600);
check(nested && await fileAt(p, 'h.txt') && !(await fileAt(p, 'papers/deep/h.txt')),
	'G: a thing moved twice is followed back to where it started',
	JSON.stringify({ nested, root: await fileAt(p, 'h.txt'), deep: await fileAt(p, 'papers/deep/h.txt') }));

const errs = errors(s).filter((e) => !/502|Bad Gateway/.test(e));
check(errs.length === 0, 'nothing threw', errs.slice(0, 3).join(' | '));

await s.close();
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
