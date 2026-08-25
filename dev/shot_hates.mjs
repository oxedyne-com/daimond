// shot_hates.mjs — photograph the two surfaces dev/HATES.md is about.
//
// The owner photographed his own screen on 2026-08-24 and the picture is the
// brief: the chat footer split into `Workspace · Machine` and `In front of the
// model`, a `+ Mark a folder in` button where a `+` used to be, and the
// Workspace panel's parent-folder arrow up in the header away from the listing.
//
// TWO THINGS THIS CANNOT REPRODUCE, and both are honest rather than gaps:
//
//   The heading reads `Workspace · Browser`, not `· Machine`. A page holds a
//   real folder only through `showDirectoryPicker()`, a native dialog no
//   automated browser can answer, so every harness run has an OPFS workspace.
//   The word after the dot is the ONLY difference; the layout under test is the
//   same element with the same class either way (`workspaceTitle`).
//
//   The paths are this file's own fixtures rather than his. The state that
//   matters is the SHAPE — two folders marked in with `Note` + `Workspace`, one
//   file merely attached with `Read` — and that is built below.
//
//   node dev/shot_hates.mjs --tag before
//
//   --tag NAME   what to call the pair, default `now`
//   --world N    dev server port 8777 + n, matching DAIMOND_PORT
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat } from './harness.mjs';

const SHOTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');

const argv = process.argv.slice(2);
const flag = (n, d) => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const TAG = flag('tag', 'now');

const s = await open({ name: 'hates' });
const { page } = s;
const sleep = (ms) => page.waitForTimeout(ms);

// The tree the panel will list, and the files the footer will hold. Written
// through the real tool, so they exist the way the user's own do.
await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const w = (p, c) => app.run_tool('file_write', JSON.stringify({ path: p, content: c }));
	await w('books/ontheism/ch1.md', '# One\n');
	await w('books/elearnity/writing_spec.md', '# Spec\nthe sentence in the file\n');
	await w('code/ai/context/dump/skills/note.md', '# Skills\n');
	await w('code/rust/fe2o3/README.md', '# fe2o3\n');
});

await newChat(s);
await sleep(700);
const focus = await page.evaluate(() => window.DaimondAttach.focus());
const chatId = focus && focus.id;
if (!chatId) throw new Error('no chat in focus');

// The state his screenshot shows: two folders marked in, one file merely read,
// one folder attached without a mark.
await page.evaluate((id) => {
	const A = window.DaimondAttach;
	A.chatToggle(id, 'dir:[browser]books/ontheism', true, 'books/ontheism');
	A.chatToggle(id, 'dir:[browser]books/elearnity', true, 'books/elearnity');
	A.chatToggle(id, 'file:[browser]books/elearnity/writing_spec.md', false,
		'books/elearnity/writing_spec.md');
	A.chatToggle(id, 'dir:[browser]code/ai/context/dump/skills', true,
		'code/ai/context/dump/skills');
}, chatId);
await sleep(400);
await page.evaluate((id) => {
	const A = window.DaimondAttach;
	A.chatWs(id, 'dir:[browser]books/ontheism', true);
	A.chatWs(id, 'dir:[browser]books/elearnity', true);
	A.chatState(id, 'file:[browser]books/elearnity/writing_spec.md', 'read');
}, chatId);
await sleep(900);

fs.mkdirSync(SHOTS, { recursive: true });
const shotOf = async (sel, label) => {
	const el = await page.$(sel);
	if (!el) { console.log(`  MISSING  ${sel}`); return ''; }
	const p = path.join(SHOTS, `hates-${TAG}-${label}.png`);
	await el.screenshot({ path: p, timeout: 8000 });
	console.log(`  wrote    ${p}`);
	return p;
};

await shotOf('#chat-attachments', 'footer');

// And the Workspace panel, listed one folder deep so the parent control has
// something to do.
await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
await sleep(700);
await page.click('#panel-work [data-act="refresh"]', { force: true }).catch(() => {});
await sleep(800);
await page.evaluate(() => {
	const row = [...document.querySelectorAll('#panel-work .files-row')]
		.find((r) => r.dataset.path === 'books');
	if (row) row.click();
});
await sleep(900);
await shotOf('#panel-work', 'panel');

// What is actually on screen, in words, so a reader who cannot open a PNG can
// still tell the two states apart.
const said = await page.evaluate(() => {
	const heads = [...document.querySelectorAll('#chat-attachments .attach-group-title')]
		.map((e) => e.textContent);
	const add = document.querySelector('#chat-attachments [data-act="attach-add"]');
	const rows = [...document.querySelectorAll('#chat-attachments .arte-row')].map((r) => ({
		path:  (r.querySelector('.arte-open') || {}).textContent || '',
		chips: [...r.querySelectorAll('.attach-state, .attach-ws')].map((c) => c.textContent),
	}));
	// Two different questions about the same action: is it a button in the panel's
	// HEADER, and is it a row at the top of the LISTING?  The point of the change is
	// that the first is false and the second is true, and one selector cannot say so.
	const up = document.querySelector('#panel-work .railhead [data-act="up"]');
	const first = [...document.querySelectorAll('#panel-work .files-tree .files-row')]
		.slice(0, 3).map((r) => (r.querySelector('.files-name') || {}).textContent || '');
	return {
		headings: heads,
		add: add ? { text: (add.textContent || '').trim(), title: add.title } : null,
		rows,
		parentButtonInHeader: !!up,
		parentRowInListing: (() => {
			const r = document.querySelector('#panel-work .files-tree .files-row');
			if (!r) return null;
			return { text: r.textContent.trim(), act: r.dataset.act || (r.querySelector('[data-act]') || {}).dataset ? 'yes' : '' };
		})(),
		firstRows: first,
	};
});
console.log(JSON.stringify(said, null, 1));
fs.writeFileSync(path.join(SHOTS, `hates-${TAG}.json`), JSON.stringify(said, null, 1) + '\n');
await s.browser.close();
