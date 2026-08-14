// The stale-write guard: an agent that read a file, then finds it changed on
// disk (another agent), must have its whole-file write REFUSED, not clobber.
//
// THE FIXTURE LIVES IN THE CHAT'S OWN SCRATCH, and moving it back to the workspace
// root would make this file vacuous again. Until 2026-08-12 it seeded and wrote
// `g.txt` at the root. Since the chat fence landed, a chat is confined to
// `chats/<id>/work` (`scopeChatTo`, www/js/daimond.js), and `Tool::guard`
// (src/tools.rs:5490) refuses a root path BEFORE the `Tool::FileWrite` arm at :5894,
// which is where the `read_seen` hash comparison and the stale-write refusal live.
// The fence preempted the guard, so nothing was written and `AGENT B WORK PRESERVED`
// was true for the wrong reason: it passed with the entire stale-write guard deleted,
// because the write never reached it. Seeded and written inside the scratch, the guard
// is reachable again and the check has a subject.
import { open, chat, newChat, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'writeguard' });
await newChat(s);

// Where this chat may write, asked of the app: the fence is BUILT from
// `chatScratch`, so a path composed here would be a second opinion about it.
const dir = await s.page.evaluate(() => {
	const f = window.DaimondAttach.focus();
	return f && f.id ? window.DaimondAttach.chatScratch(f.id) : '';
});
check('the chat has a scratch folder, which is what the fence lets it write in',
	!!dir, dir || '(no chat in focus)');
const G = dir + '/g.txt';

/// Write a file straight into OPFS, creating the folders on the way — this is the
/// OTHER agent, so it goes nowhere near a turn.
const putFile = (p, body) => s.page.evaluate(async ([p, body]) => {
	const parts = p.split('/');
	let d = await navigator.storage.getDirectory();
	for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
	const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
	const w = await fh.createWritable(); await w.write(body); await w.close();
	return true;
}, [p, body]);

const readFile = (p) => s.page.evaluate(async (p) => {
	const parts = p.split('/');
	let d = await navigator.storage.getDirectory();
	for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
	const fh = await d.getFileHandle(parts[parts.length - 1]);
	return await (await fh.getFile()).text();
}, p).catch((e) => '(' + String(e).split('\n')[0] + ')');

// Seed g.txt = v1, then have the agent READ it (records its hash in read_seen).
await putFile(G, 'ORIGINAL-v1');
const readOut = await chat(s, `@tool file_read {"path":"${G}"}`);
// THE READ HAS TO LAND. Nothing below means anything if the agent never saw the
// file: with no entry in `read_seen` a whole-file write is not stale, it is simply
// a write, and the refusal this test is about could not arise however broken the
// guard was.
check('the agent really read the file, so the guard has something to compare against',
	/ORIGINAL-v1/.test(readOut) && !/Refused/.test(readOut),
	readOut.slice(-160).replace(/\n/g, ' | '));

// Another agent changes g.txt underneath (simulated via OPFS directly).
await putFile(G, 'AGENT-B-WROTE-THIS');

// The first agent now writes a stale whole-file over it.
const out = await chat(s, `@tool file_write {"path":"${G}","content":"STALE-CLOBBER"}`);
const after = await readFile(G);
console.log('--- write-turn transcript tail ---\n' + out.slice(-300));
console.log('file after stale write:', JSON.stringify(after));

check('GUARD REFUSED THE STALE WRITE', /changed on disk/.test(out),
	out.slice(-200).replace(/\n/g, ' | '));
check('AGENT B WORK PRESERVED — the other agent\'s bytes are still on disk',
	after === 'AGENT-B-WROTE-THIS', JSON.stringify(after));
// The other half, and the reason a refusal is not enough on its own: the guard
// must refuse THIS write and not writing in general.
const fresh = await chat(s, `@tool file_write {"path":"${dir}/h.txt","content":"UNRELATED"}`);
check('and a file this agent never read is still written — the guard refuses staleness, not writing',
	await readFile(dir + '/h.txt') === 'UNRELATED', fresh.slice(-140).replace(/\n/g, ' | '));

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
