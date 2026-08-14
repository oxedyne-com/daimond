// Does the agent remember its own tool calls across turns?
// Turn 1 makes a tool call. Turn 2 asks a follow-up. What does the model see
// on turn 2 — the earlier assistant tool_call + tool result, or nothing?
//
// THE ROOT PATH IS LEFT ALONE HERE, DELIBERATELY. Since the chat fence landed on
// 2026-08-12 a chat is confined to `chats/<id>/work` (`scopeChatTo`,
// www/js/daimond.js), so `note.txt` at the workspace root is REFUSED by
// `Tool::guard` (src/tools.rs:5490) and nothing is written. Everywhere else in
// this suite that broke the check outright; here it does not, because what is
// asserted is the SHAPE of the conversation and not the file: a refusal is still a
// tool call, and it still comes back as a tool result. The turn below carries both
// either way, which is exactly the memory this file is about. Anything that starts
// asserting on the FILE has to move to the scratch first — see verify_writeguard.
import { open, chat, clearMockLog, mockLog } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

clearMockLog();
const s = await open({ name: 'toolmem' });

await chat(s, '@tool file_write {"path":"note.txt","content":"remember me"}');
await chat(s, '@text What did you just write?');   // a second, separate turn

const reqs = mockLog();
// The model was asked TWICE, or there is no "turn 2" to be reading. A single
// request would satisfy every check below by being its own history.
check('two turns really reached the model', reqs.length >= 2, `${reqs.length} request(s)`);
const last = reqs[reqs.length - 1] || { messages: [] };
console.log('turn-2 request carried', (last.messages || []).length, 'messages:');
for (const m of last.messages || []) {
	const role = m.role;
	const hasToolCalls = !!(m.tool_calls && m.tool_calls.length);
	const isToolResult = role === 'tool';
	const preview = typeof m.content === 'string' ? m.content.slice(0, 50) : '';
	console.log(`  ${role}${hasToolCalls ? ' [+tool_calls]' : ''}${isToolResult ? ' [tool result]' : ''}  ${preview}`);
}
const msgs = last.messages || [];
const sawToolCall   = msgs.some(m => m.tool_calls && m.tool_calls.length);
const sawToolResult = msgs.some(m => m.role === 'tool');
console.log('\nVERDICT: on turn 2 the model',
	(sawToolCall && sawToolResult) ? 'REMEMBERS its turn-1 tool call+result (GOOD)'
	: 'FORGOT its turn-1 tool call/result (BUG CONFIRMED)');
check('on turn 2 the model is shown the tool call it made on turn 1', sawToolCall,
	msgs.map(m => m.role).join(','));
check('and the result that came back from it', sawToolResult,
	msgs.map(m => m.role).join(','));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
