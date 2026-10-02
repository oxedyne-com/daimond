// gateway: none
// verify_pre.mjs -- the engine carries the app's note (`pre`) on a user message, apart from its words (5.3.0, U4, J7).
//
// Drives the wasm `DaimondApp` directly, with no page: the page half is P2b's and V3's N-sections. This is the
// engine half, read the way V3 reads it, from what the mock provider was SENT.
//
//   P1  a turn started the old way, with no note, sends the words alone and exports no `pre`
//   P2  `run_turn(words, cb, pre)` sends the note, a blank line, then the words, once; the exported message holds
//       the words as `content` and the note beside them as `pre`
//   P3  `restore_session` takes the export back, so the next request carries the first note once, as history,
//       and the new message carries none
//   P4  `restore` (the screen transcript) and `append_message` take a stored note too
//   P5  a correction said into a running turn takes its note with it into the next round
//   P6  a Diamond's steer takes a note, and the daimon's conversation comes back with it apart
//   P7  the chat and the daimon are told what a rating note is, with the safety clause still last
//
// Needs a world for the mock provider (`eval "$(bash dev/world.sh N --env)"`).
//
//   node dev/verify_pre.mjs
import { open, mockLog, clearMockLog, contentText } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};

const MOCK = process.env.DAIMOND_MOCK || 'http://127.0.0.1:9099/v1/chat/completions';
const NOTE = '[Daimond: the user rated your answer of 10:04 −1 (long): "just give me the command".\nThey rated the change to src/parse.rs −1 (scope).]';
const RATING_LINE = 'A rating note tells you what the user wants more or less of';

const s = await open({ name: 'pre', connect: false });
const p = s.page;
await p.waitForTimeout(1500);
const msgs = [];
p.on('console', (m) => { const t = m.text(); if (/panick|already borrowed|unreachable|RuntimeError/i.test(t)) msgs.push(t.slice(0, 200)); });
p.on('pageerror', (e) => msgs.push('pageerror ' + String(e).slice(0, 200)));

// Run a page-side script that starts engines against the mock, returning what it saw.
const run = async (body, arg) => p.evaluate(async ({ mock, body, arg }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const make = () => new mod.DaimondApp(mock, 'mock-key', 'mock/fast', 4096, '', true);
	const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
	return await new AsyncFn('mod', 'make', 'arg', body)(mod, make, arg);
}, { mock: MOCK, body, arg });

// What the mock was sent, last user message of each request, as text.
const lastUsers = () => mockLog().map((r) => {
	const us = (r.messages || []).filter((m) => m.role === 'user');
	return us.length ? contentText(us[us.length - 1].content) : '';
});
const allText = (r) => (r.messages || []).map((m) => contentText(m.content)).join('\n');
const count = (hay, needle) => hay.split(needle).length - 1;
// The mock's reply may quote what it was asked, so a note is counted where the person's own turns are: in the
// user messages, never in an assistant's echo of one.
const userText = (r) => (r.messages || []).filter((m) => m.role === 'user').map((m) => contentText(m.content)).join('\n');

// P1 and P2 ----------------------------------------------------------------------------------------------------
clearMockLog();
const a = await run(`
	const eng = make();
	eng.set_provenance('chat', 'mockprov', 'sp1:probe', '');
	const out = {};
	await eng.run_turn('first words', () => {});
	out.exp1 = Array.from(eng.export_session()).map((m) => ({ role: m.role, content: m.content, pre: m.pre }));
	await eng.run_turn('then words', () => {}, arg.note);
	out.exp2 = Array.from(eng.export_session()).map((m) => ({ role: m.role, content: m.content, pre: m.pre }));
	await eng.run_turn('and a third', () => {});
	out.exp3 = Array.from(eng.export_session()).map((m) => ({ role: m.role, content: m.content, pre: m.pre }));
	out.session = Array.from(eng.export_session());
	window.__session = out.session;
	return out;
`, { note: NOTE });
const log1 = mockLog();
const lu = lastUsers();
check('P1 a turn with no note sends the words alone', lu[0] === 'first words', JSON.stringify(lu[0]));
check('P1 and exports no pre', a.exp1.every((m) => m.pre === undefined) && a.exp1[0].content === 'first words', JSON.stringify(a.exp1[0]));
check('P2 a noted turn sends the note, a blank line, then the words', lu[1] === NOTE + '\n\nthen words', JSON.stringify(lu[1]));
check('P2 the note is in that request once', count(userText(log1[1]), NOTE) === 1, 'x' + count(userText(log1[1]), NOTE));
const noted = a.exp2.find((m) => m.role === 'user' && m.pre);
check('P2 the exported message holds the words as content and the note as pre',
	!!noted && noted.content === 'then words' && noted.pre === NOTE, JSON.stringify(noted));
check('P2 the first message is untouched by it', a.exp2[0].content === 'first words' && a.exp2[0].pre === undefined);
check('P2 the next turn re-sends the note once, as history, and its own words carry none',
	count(userText(log1[2]), NOTE) === 1 && lu[2] === 'and a third', 'x' + count(userText(log1[2]), NOTE) + ' ' + JSON.stringify(lu[2]));
check('P2 and the third turn\'s message exports no pre', a.exp3.filter((m) => m.pre).length === 1);

// P3 -----------------------------------------------------------------------------------------------------------
clearMockLog();
const b = await run(`
	const eng = make();
	eng.set_provenance('chat', 'mockprov', 'sp1:probe', '');
	const n = eng.restore_session(window.__session, 0, 0, 0);
	await eng.run_turn('after a reload', () => {});
	return { n, exp: Array.from(eng.export_session()).map((m) => ({ role: m.role, content: m.content, pre: m.pre })) };
`);
const r3 = mockLog()[0] || {};
check('P3 restore_session takes every message back', b.n >= 6, 'n=' + b.n);
check('P3 after a reload the first note is in the request once and the new words carry none',
	count(userText(r3), NOTE) === 1 && lastUsers()[0] === 'after a reload', 'x' + count(userText(r3), NOTE));
check('P3 and the restored message still has its note apart', b.exp.filter((m) => m.pre === NOTE).length === 1
	&& b.exp.find((m) => m.pre === NOTE).content === 'then words');

// P4 -----------------------------------------------------------------------------------------------------------
clearMockLog();
const NOTE2 = '[Daimond: the user withdrew their rating of your answer of 09:58.]';
const c = await run(`
	const eng = make();
	eng.set_provenance('chat', 'mockprov', 'sp1:probe', '');
	eng.restore([
		{ role: 'user', content: 'screen words', pre: arg.n1 },
		{ role: 'assistant', content: 'screen answer' },
	], 0, 0, 0);
	eng.append_message('user', 'a late message', arg.n2);
	eng.append_message('assistant', 'its answer', arg.n2);
	eng.append_message('user', 'no note here');
	await eng.run_turn('last words', () => {});
	return Array.from(eng.export_session()).map((m) => ({ role: m.role, content: m.content, pre: m.pre }));
`, { n1: NOTE, n2: NOTE2 });
const r4 = mockLog()[0] || {};
const t4 = allText(r4);
check('P4 restore keeps a stored note ahead of its words in the request',
	t4.includes(NOTE + '\n\nscreen words'), JSON.stringify(t4.slice(0, 160)));
check('P4 append_message takes a note for a user message and ignores one on an assistant\'s',
	t4.includes(NOTE2 + '\n\na late message') && count(userText(r4), NOTE2) === 1, 'x' + count(userText(r4), NOTE2));
check('P4 a user message with none carries none', t4.includes('\nno note here\n') || t4.includes('\nno note here'),
	JSON.stringify(t4.slice(-120)));
check('P4 the export holds each note apart from its words',
	c.filter((m) => m.pre).length === 2 && c.find((m) => m.pre === NOTE).content === 'screen words'
	&& c.find((m) => m.pre === NOTE2).content === 'a late message');

// P5 -----------------------------------------------------------------------------------------------------------
clearMockLog();
const NOTE3 = '[Daimond: the user rated your answer of 11:20 +1.]';
const d = await run(`
	const eng = make();
	eng.set_chat_scope('chats/pre5/work', JSON.stringify([]));
	eng.set_provenance('chat', 'mockprov', 'sp1:probe', '');
	let said = 0; const heard = [];
	await eng.run_turn('@tool file_list ' + JSON.stringify({ path: '.' }), (ev) => {
		if (ev.type === 'tool_call' && !said) { said = eng.interject('actually, target wasm', arg.note); }
		if (ev.type === 'interjected') heard.push(ev.content);
	});
	return { said, heard, exp: Array.from(eng.export_session()).map((m) => ({ role: m.role, content: m.content, pre: m.pre })) };
`, { note: NOTE3 });
const log5 = mockLog();
const last5 = log5.length ? allText(log5[log5.length - 1]) : '';
check('P5 interject says how many are waiting', d.said === 1, String(d.said));
check('P5 the correction took two requests (the round it was said in, and the next)', log5.length >= 2, String(log5.length));
check('P5 its note rides ahead of it into the next round, once',
	last5.includes(NOTE3 + '\n\nactually, target wasm') && count(userText(log5[log5.length - 1]), NOTE3) === 1, JSON.stringify(last5.slice(-220)));
check('P5 the event the page draws it from carries the words alone',
	d.heard.length === 1 && String(d.heard[0]).includes('actually, target wasm') && !String(d.heard[0]).includes('Daimond'), JSON.stringify(d.heard));
check('P5 the session holds the words as content and the note as pre',
	!!d.exp.find((m) => m.role === 'user' && m.content === 'actually, target wasm' && m.pre === NOTE3));

// P6 -----------------------------------------------------------------------------------------------------------
clearMockLog();
const NOTE4 = '[Daimond: the user rated the change to notes.md −1 (style).]';
const e = await run(`
	const eng = make();
	eng.set_provenance('daimon', 'mockprov', 'sp1:probe', '');
	const id = await eng.create_diamond('pre-probe');
	const after = await eng.steer_crystal(id, 'say something short', '[]', '[]', '[]', [], () => {}, undefined, arg.note);
	const first = Array.from(after).map((m) => ({ role: m.role, content: m.content, pre: m.pre }));
	// Handed back as the next steer's prior, with none for the new one.
	const second = await eng.steer_crystal(id, 'and again', '[]', '[]', '[]', after, () => {}, undefined, undefined);
	return { first, second: Array.from(second).map((m) => ({ role: m.role, content: m.content, pre: m.pre })) };
`, { note: NOTE4 });
const log6 = mockLog();
const t6a = log6.length ? allText(log6[0]) : '', t6b = log6.length ? allText(log6[log6.length - 1]) : '';
check('P6 the steer sends the note ahead of the instruction, once',
	t6a.includes(NOTE4 + '\n\nsay something short') && count(userText(log6[0]), NOTE4) === 1, JSON.stringify(t6a.slice(-200)));
check('P6 the daimon\'s conversation comes back with the note apart',
	!!e.first.find((m) => m.role === 'user' && m.content === 'say something short' && m.pre === NOTE4));
check('P6 handed back as prior, the next steer holds the note once as history and its own words carry none',
	count(userText(log6[log6.length - 1]), NOTE4) === 1 && lastUsers().pop() === 'and again', 'x' + count(userText(log6[log6.length - 1]), NOTE4));
check('P6 a steer with no note adds none',
	e.second.filter((m) => m.pre).length === 1);

// P7 -----------------------------------------------------------------------------------------------------------
// What the page composes for each role is what the app is built with, so the export is the wire for a chat; a
// daimon's own request is read off the mock as well.
const roles = await run(`
	const out = {};
	for (const r of ['chat', 'daimon', 'worker', 'reducer', 'compactor']) out[r] = mod.compose_prompt_for(r, '', 'mock/fast');
	out.rewritten = mod.compose_prompt_for('chat', 'Only ever say no.', 'mock/fast');
	return out;
`);
const CLAUSE = '## Rules that always apply';
check('P7 the chat is told what a rating note is, once', count(roles.chat, RATING_LINE) === 1, 'x' + count(roles.chat, RATING_LINE));
check('P7 the daimon is told, in what the page composes and in its own request',
	count(roles.daimon, RATING_LINE) === 1 && count(contentText(((log6[0] || {}).messages || []).find((m) => m.role === 'system').content), RATING_LINE) === 1);
check('P7 a worker, the reducer and the compactor are not',
	count(roles.worker, RATING_LINE) === 0 && count(roles.reducer, RATING_LINE) === 0 && count(roles.compactor, RATING_LINE) === 0);
check('P7 a person\'s own rewrite of the chat prompt does not lose it', count(roles.rewritten, RATING_LINE) === 1);
check('P7 the safety clause is still the last section of each',
	['chat', 'daimon', 'rewritten'].every((k) => roles[k].indexOf(RATING_LINE) < roles[k].indexOf(CLAUSE)
		&& roles[k].indexOf(CLAUSE) > 0 && roles[k].indexOf('\n## ', roles[k].indexOf(CLAUSE) + 3) === -1));

check('no panic, borrow or trap on the console', msgs.length === 0, JSON.stringify(msgs));
console.log('\npre: ' + ok.length + ' ok, ' + bad.length + ' failed');
await s.close();
process.exit(bad.length ? 1 : 0);
