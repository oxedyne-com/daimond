// Does the agent remember its own tool calls across turns?
// Turn 1 makes a tool call. Turn 2 asks a follow-up. What does the model see
// on turn 2 — the earlier assistant tool_call + tool result, or nothing?
import { open, chat, clearMockLog, mockLog } from './harness.mjs';

clearMockLog();
const s = await open({ name: 'toolmem' });

await chat(s, '@tool file_write {"path":"note.txt","content":"remember me"}');
await chat(s, '@text What did you just write?');   // a second, separate turn

const reqs = mockLog();
const last = reqs[reqs.length - 1];   // the request for turn 2's reply
console.log('turn-2 request carried', last.messages.length, 'messages:');
for (const m of last.messages) {
	const role = m.role;
	const hasToolCalls = !!(m.tool_calls && m.tool_calls.length);
	const isToolResult = role === 'tool';
	const preview = typeof m.content === 'string' ? m.content.slice(0, 50) : '';
	console.log(`  ${role}${hasToolCalls ? ' [+tool_calls]' : ''}${isToolResult ? ' [tool result]' : ''}  ${preview}`);
}
const sawToolCall   = last.messages.some(m => m.tool_calls && m.tool_calls.length);
const sawToolResult = last.messages.some(m => m.role === 'tool');
console.log('\nVERDICT: on turn 2 the model',
	(sawToolCall && sawToolResult) ? 'REMEMBERS its turn-1 tool call+result (GOOD)'
	: 'FORGOT its turn-1 tool call/result (BUG CONFIRMED)');
await s.close();
