// The stale-write guard must not get in the way of ordinary work: a new file, a
// read, and then the agent's own update of what it read, all in one chat.
//
// THE PATHS ARE THE CHAT'S OWN SCRATCH, and must stay that way. Until 2026-08-12
// this wrote `n.txt` at the workspace ROOT. Since the chat fence landed, every
// chat is confined to `chats/<id>/work` (`scopeChatTo`, www/js/daimond.js), and
// `Tool::guard` (src/tools.rs:5490) refuses a root path BEFORE the `Tool::FileWrite`
// arm at :5894 ever runs. The refusal comes back as an ordinary tool result: nothing
// is written, nothing throws, and the OPFS read below then died on a file that had
// never been created. Nothing about the stale-write guard was measured at all.
import { open, chat, newChat, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'normalwrite' });
await newChat(s);

// Where this chat may write, asked of the app rather than composed here: the fence
// is built from `chatScratch`, so anything else is a second opinion about it.
const dir = await s.page.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return f && f.id ? window.DaimondAttach.chatScratch(f.id) : '';
});
check('the chat has a scratch folder to work in', !!dir, dir || '(no chat in focus)');
const N = dir + '/n.txt';

const first  = await chat(s, `@tool file_write {"path":"${N}","content":"first"}`);
check('a new file inside the workspace is written, not refused',
	!/Refused/.test(first), first.slice(-160).replace(/\n/g, ' | '));

await chat(s, `@tool file_read {"path":"${N}"}`);                       // read: records the hash
const out = await chat(s, `@tool file_write {"path":"${N}","content":"second"}`);  // its own update

const after = await s.page.evaluate(async (p) => {
	const parts = p.split('/');
	let d = await navigator.storage.getDirectory();
	for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
	const f = await d.getFileHandle(parts[parts.length - 1]);
	return await (await f.getFile()).text();
}, N).catch((e) => '(' + String(e).split('\n')[0] + ')');

console.log('normal write chain result:', JSON.stringify(after), '| refused?', /changed on disk/.test(out));
check('NORMAL WRITES UNAFFECTED — the agent\'s own update of a file it read lands',
	after === 'second', JSON.stringify(after));
check('and the stale-write guard said nothing, because nothing changed underneath',
	!/changed on disk/.test(out), out.slice(-160).replace(/\n/g, ' | '));

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
