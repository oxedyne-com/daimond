// probe_skillsau4.mjs — a daimon drafts, the owner installs, in the real page.
//
// The draft is written with the FILE TOOLS a fenced turn already has, into the chat's own
// folder, exactly as the standing note tells a daimon to. Then the `/` menu is opened, the
// draft row is tapped, and the dialog answered — and what a `/name` then reaches is checked.
import { open, chat, mockLog, clearMockLog, contentText, connectMock } from './harness.mjs';

const s = await open({ name: 'skillsau4', defaults: false });
const { page } = s;
const msgs = [];
page.on('console', m => { if (/AUD/.test(m.text())) msgs.push(m.text()); });
page.on('pageerror', e => msgs.push('PAGEERROR ' + String(e).slice(0,160)));
await page.waitForTimeout(2000);
await connectMock(s);
await chat(s, 'hello');           // a chat exists and is in focus
await page.waitForTimeout(600);

const out = {};
const DRAFT = '---\nname: brief\ndescription: Brief a worker properly.\n---\n'
	+ '# Brief\n\nName the files, the command that proves it, and what to do when it fails.\n';

// A daimon writes the draft the way the standing note tells it to, through the ordinary
// file tools and inside the fence — never into .daimond/.
out.wrote = await page.evaluate(async (text) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const f = window.DaimondAttach.focus();
	const own = (f.kind === 'diamond') ? ('diamonds/' + f.id) : window.DaimondAttach.chatScratch(f.id);
	const dir = own + '/' + m.skill_drafts_dir();
	await m.store_write(dir + '/brief.md', text);
	return { focus: f.kind, path: dir + '/brief.md', install: m.skill_install_path('brief'),
		refusal: m.skill_draft_refusal('brief', text) };
}, DRAFT);

// Before: /brief resolves to nothing at all.
clearMockLog();
const before = await chat(s, '/brief');
out.before = { refused: /no skill called/i.test(before), reachedModel: mockLog().length };

// The `/` menu, and the draft row in it.
await page.fill('#chat-input', '/');
await page.waitForTimeout(1500);
out.menu = await page.evaluate(() => {
	const rows = [...document.querySelectorAll('.skill-menu .skill-item')];
	return { rows: rows.map(r => r.textContent),
		drafts: rows.filter(r => r.hasAttribute('data-draft')).map(r => r.getAttribute('data-draft')) };
});

// One tap on the draft row, and one on Install.
out.listing = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const f = window.DaimondAttach.focus();
	const dir = window.DaimondAttach.chatScratch(f.id) + '/' + m.skill_drafts_dir();
	let raw = 'ERR';
	try { raw = String(await m.store_list(dir) || ''); } catch (e) { raw = 'THREW ' + e; }
	let up = 'ERR';
	try { up = String(await m.store_list(window.DaimondAttach.chatScratch(f.id)) || ''); } catch (e) { up = 'THREW ' + e; }
	return { dir, raw, up };
});
out.aud = msgs.slice(-8);
if (!out.menu.drafts.length) { console.log(JSON.stringify(out, null, 1)); await s.browser.close(); process.exit(1); }
await page.evaluate(() => document.querySelector('.skill-menu .skill-item[data-draft]').click());
await page.waitForTimeout(900);
out.dialog = await page.evaluate(() => {
	const d = document.querySelector('.modal.dlg');
	return d ? { text: d.innerText.slice(0, 400), buttons: [...d.querySelectorAll('button')].map(b => b.textContent) } : null;
});
await page.evaluate(() => {
	const d = document.querySelector('.modal.dlg');
	const b = [...d.querySelectorAll('button')].find(x => /install/i.test(x.textContent));
	if (b) b.click();
});
await page.waitForTimeout(1500);

out.installed = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	let at = ''; try { at = String(await m.store_read('.daimond/skills/brief.md') || ''); } catch (e) { at = 'ERR ' + e; }
	let draft = 'still there';
	try { draft = String(await m.store_read((window.DaimondAttach.chatScratch(window.DaimondAttach.focus().id)) + '/' + m.skill_drafts_dir() + '/brief.md') || ''); } catch (e) { draft = ''; }
	return { bytes: at.length, matches: at === '---\nname: brief\ndescription: Brief a worker properly.\n---\n# Brief\n\nName the files, the command that proves it, and what to do when it fails.\n',
		draftLeft: draft.length === 0 ? 'gone or emptied' : draft.slice(0, 20) };
});

// After: /brief now reaches the model carrying the installed file's own text.
await page.fill('#chat-input', '');
clearMockLog();
await chat(s, '/brief the sync bug');
const log = mockLog();
const usr = (r) => (r.messages || []).filter(m => m.role === 'user').map(m => contentText(m.content)).join('\n');
out.after = log.length ? {
	requests: log.length,
	named:    /\.daimond\/skills\/brief\.md/.test(usr(log[0])),
	body:     /Name the files, the command that proves it/.test(usr(log[0])),
	request:  /User request: the sync bug/.test(usr(log[0])),
} : { requests: 0 };

console.log(JSON.stringify(out, null, 1));
await s.browser.close();
