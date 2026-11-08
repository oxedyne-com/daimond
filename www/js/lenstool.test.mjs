/* lenstool.test.mjs -- LENS-TOOL (Q1106-023): a Kimberlite turn's tool calls reach the lens.

   Kimberlite's tool calls reached the lens only as `tool_log` rows drawn on the page, so a
   refusal showed only as text and no `tool` row named the call. The log reader now sends one
   `tool` event per call whose result has landed (`lensToolLog`, beside `onLogRows`), built by the
   Here seat's own `lensToolRow`. This drives the real functions, then puts the event through
   the lens (`dev/lens.mjs pull` and `events --kind tool`) as the gateway writes it.

   node www/js/lenstool.test.mjs
   MM_SRC_REV=ebafe6996 node www/js/lenstool.test.mjs   (the live record: red) */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lift, source } from './testlift.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail ? ': ' + detail : '')); }
}

const L = lift(source('daimond.js'), ['lensToolRow', 'lensToolLog']);
check('the functions exist', !L.missing.length, 'missing ' + L.missing.join(','));

const sent = [];
const api = L.missing.length ? null : new Function('dsEvent', 'var _toolLensed = Object.create(null), _toolSteps = Object.create(null);\n' + L.body + '\nreturn { lensToolLog: lensToolLog };')(
	(kind, payload) => sent.push([kind, payload]));

const REFUSAL = 'refused: notes/plan.md is outside the folders this Diamond may write.';
const chat = { id: 'c1', diamondId: 'D1' };
const call = { mid: 'r1', role: 'tool_log', name: 'file_write', args: '{"path":"notes/plan.md","content":"x"}',
	content: '', outcome: '' };
if (api) {
	api.lensToolLog(chat, 'T1', [call, { mid: 'r0', role: 'assistant', content: 'working' }], []);
	check('a call logged before its result sends nothing yet', sent.length === 0, JSON.stringify(sent));
	const done = Object.assign({}, call, { content: REFUSAL, outcome: 'refused' });
	api.lensToolLog(chat, 'T1', [], [done]);
	api.lensToolLog(chat, 'T1', [done], [done]);
	const tools = sent.filter((s) => s[0] === 'tool');
	check('one refused Kimberlite call is one tool event', tools.length === 1, JSON.stringify(sent));
	const p = (tools[0] || [])[1] || {};
	check('it names the tool, the outcome, the chat and the Diamond, and is marked Kimberlite',
		p.name === 'file_write' && p.out === 'refused' && p.chat === 'c1' && p.dia === 'D1' && p.src === 'kimb'
			&& p.turn === 'T1' && p.r === 1, JSON.stringify(p));
	check('it carries the refusal sentence and never the arguments or the content written',
		p.full === REFUSAL && !JSON.stringify(p).includes('"content"') && p.ab === call.args.length, JSON.stringify(p));
	const ok = { mid: 'r2', role: 'tool_log', name: 'file_read', args: '{"path":"a.md"}', content: 'secret body', outcome: 'done' };
	api.lensToolLog(chat, 'T1', [ok], []);
	const q = (sent.filter((s) => s[0] === 'tool')[1] || [])[1] || {};
	check('a done call is the next step and carries no result', q.r === 2 && q.out === 'done' && q.full === undefined
		&& !JSON.stringify(q).includes('secret'), JSON.stringify(q));

	// Through the lens, as the gateway files it: `lens events --kind tool` shows the refusal.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lenstool-test-'));
	try {
		const D = 'k'.repeat(32), T0 = 1700000000000;
		fs.mkdirSync(path.join(root, 'traces'), { recursive: true });
		const ev = Object.assign({ v: 1, d: D.slice(0, 12), n: 1, b: 'fx', t: T0 + 1 }, p);
		delete ev.full;
		ev.msg = REFUSAL;
		fs.writeFileSync(path.join(root, 'traces', 'acct-' + D + '.log'),
			'\n===== ' + (T0 + 2) + ' account=acct device=' + D + ' rows=1 =====\n'
			+ '  ' + (T0 + 1) + '  ev tool  ' + JSON.stringify(ev) + '\n');
		const env = Object.assign({}, process.env, { DAIMOND_LENS_HOME: root, DAIMOND_LENS_REMOTE: '' });
		const lens = path.join(HERE, '..', '..', 'dev', 'lens.mjs');
		execFileSync('node', [lens, 'pull', '--no-rsync', '--json'], { env, encoding: 'utf8' });
		const rows = JSON.parse(execFileSync('node', [lens, 'events', '--kind', 'tool', '--since', 'all', '--json'],
			{ env, encoding: 'utf8' }).trim());
		const r = rows.find((x) => x.ev && x.ev.name === 'file_write');
		check('lens events --kind tool shows the refused Kimberlite call',
			!!r && r.ev.out === 'refused' && r.ev.src === 'kimb' && r.ev.chat === 'c1', JSON.stringify(rows));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

console.log(`\n${checks - failures}/${checks} ok`);
process.exit(failures ? 1 : 0);
