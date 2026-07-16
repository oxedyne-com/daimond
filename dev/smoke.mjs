// The first end-to-end drive: sign in, connect a model, take a turn with a tool.
import { open, chat, shot, errors, clearMockLog, mockLog } from './harness.mjs';

clearMockLog();
const s = await open({ name: 'smoke' });
console.log('cfg after connect:', JSON.stringify(s.cfg));
await shot(s, '01-connected');

const t1 = await chat(s, '@text Hello from the mock.');
console.log('--- plain turn ---\n' + t1.slice(-400));
await shot(s, '02-plain');

const t2 = await chat(s, '@tool file_write {"path":"mock.txt","content":"written by the agent"}');
console.log('--- tool turn ---\n' + t2.slice(-600));
await shot(s, '03-tool');

const seen = mockLog();
console.log('\nmock saw', seen.length, 'requests');
for (const r of seen) {
	console.log('  model=%s stream=%s tools=%d msgs=%d roles=%s',
		r.model, r.stream, r.tools.length, r.messages.length,
		r.messages.map(m => m.role).join(','));
}
console.log('\nconsole errors:', errors(s));
await s.close();
