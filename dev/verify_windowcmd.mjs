// gateway: none
// verify_windowcmd.mjs -- a command's file is credited to the chat's agent with `via: "command"` (5.3.0, J2).
//
// A chat's turn that runs a command used to leave no record of the file the command wrote: nothing captured
// it, and the turn-end walk covered Diamonds only. Now every call whose file effects no capture records is
// looked at before and after (`open_window`, `close_window`, `drain_windows`), and what it moved is recorded
// against the author whose context ran it.
//
// The command is a stand-in `window.DaimondHand` whose `run` writes `chats/<id>/work/out.txt` while the call is
// open. A real command cannot do that: `run` refuses any cwd in Daimond's storage, and a window looks at
// browser storage only. So this proves the glue (open, close, drain, attribute, record), which no native test
// reaches, and is X1's world-testable caller.
//
// Needs a world for the mock provider (`eval "$(bash dev/world.sh N --env)"`).
//
//   node dev/verify_windowcmd.mjs
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};

const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
const s = await open({ name: 'windowcmd', connect: false });
const p = s.page;
await p.waitForTimeout(1500);
const msgs = [];
p.on('console', (m) => { const t = m.text(); if (/window|panick|already borrowed|unreachable|RuntimeError/i.test(t)) msgs.push(t.slice(0, 200)); });
p.on('pageerror', (e) => msgs.push('pageerror ' + String(e).slice(0, 200)));
const r = await p.evaluate(async ({ mock }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const CHAT = 'cw1', DIR = 'chats/' + CHAT + '/work', KEEP = 'chat:' + CHAT;
	const out = {};
	let calls = 0;
	window.DaimondHand = {
		hasHand: () => true,
		status:  async () => JSON.stringify({ paired: true, link: 1, os: 'linux', root: '/granted', caps: ['fence:landlock', 'meter:deletes', 'host:probe'] }),
		run:     async (spec) => {
			calls++;
			out.spec = String(spec).slice(0, 200);
			// The stand-in command's effect: a file in the chat's own folder, written while the call runs.
			await mod.write_file(DIR + '/out.txt', 'made by the command');
			return JSON.stringify({ exit: 0, stdout: 'ok', stderr: '', out_bytes: 2, err_bytes: 0, timed_out: false });
		},
		runs: async () => '[]', held: async () => '{}', signal: async () => '{}',
	};
	const eng = new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
	eng.set_chat_scope(DIR, JSON.stringify(['vault']));
	eng.set_provenance('chat', 'mockprov', 'sp1:probe', '');
	const seen = []; let ver = null;
	try {
		await eng.run_turn('@tool run ' + JSON.stringify({ argv: ['touch', 'x'], cwd: 'vault' }), (ev) => {
			if (ev.type === 'tool_result') seen.push(String(ev.content || '').slice(0, 300));
			if (ev.type === 'versions') ver = { keeper: ev.keeper, version: ev.version, files: Array.from(ev.files || []) };
		});
	} catch (e) { seen.push('THREW ' + String(e && e.message || e)); }
	out.calls = calls; out.seen = seen; out.ver = ver;
	try { out.list = JSON.parse(await app.versions_list(KEEP)); } catch (e) { out.listThrew = String(e); }
	return out;
}, { mock: MOCK });
const row = (((r.list || [])[0] || {}).files || []).find((f) => f.path === 'chats/cw1/work/out.txt') || null;
const by = (row && row.by) || null;
check('the stand-in hand ran the command once', r.calls === 1, JSON.stringify({ calls: r.calls, seen: r.seen }));
check('the chat turn recorded one version naming the file the command wrote',
	!!r.ver && r.ver.keeper === 'chat:cw1' && JSON.stringify(r.ver.files) === JSON.stringify(['chats/cw1/work/out.txt']),
	JSON.stringify(r.ver));
check('the row holds the file by its hash', !!row && /^[0-9a-f]{64}$/.test(row.hash || '') && row.bytes === 19,
	JSON.stringify(row));
check('the row names the chat\'s agent, credited through a command',
	!!by && by.role === 'chat' && by.m === 'mock/fast' && by.pv === 'mockprov' && by.sp === 'sp1:probe' && by.via === 'command',
	JSON.stringify(by));
check('the window glue raised nothing on the console', msgs.length === 0, JSON.stringify(msgs));
console.log('\nwindowcmd: ' + ok.length + ' ok, ' + bad.length + ' failed');
await s.close();
process.exit(bad.length ? 1 : 0);
