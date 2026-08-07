// Does a long session die?
//
// The failure being fixed is not subtle: the provider refuses the request for being
// longer than its window, the turn dies, and every turn after it sends the same
// oversized history and dies the same way.  The chat is then unusable forever.
//
// So this drives the real app against a provider that really does refuse -- see
// ctxmock.mjs, which counts the request the way a provider does and answers 400 with
// `context_length_exceeded` -- and then asks the only question that matters: after the
// refusal, does the chat still work, and does it still know what it did?
//
// dev/mockllm.mjs accepts a request of any size, which is why nothing else in the suite
// has ever exercised this.  The mock is started and stopped here rather than by hand, so
// this runs from `run_all.sh` like everything else.
//
// Every check is made against the mock's own log, which is what the model was really
// sent, not against anything the compactor says about itself.
//
//   node dev/verify_compact.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const { open, newChat, transcript, shot, connectMock } = await import(path.join(HERE, 'harness.mjs'));

// The refusing provider follows the world, so two worlds neither fight over the
// port nor read one another's log.  A world is numbered by its offset from 8777.
const WORLD = Number(process.env.DAIMOND_PORT || 8777) - 8777;
const LOG   = process.env.DAIMOND_CTX_LOG
	|| path.join(HERE, WORLD ? `ctxmock-${WORLD}.log` : 'ctxmock.log');
const PORT  = Number(process.env.DAIMOND_CTX_PORT || 9188 + WORLD);
const LIMIT = 12000;
const MOCK  = `http://127.0.0.1:${PORT}/v1/chat/completions`;
const MODEL = 'mock/fast';

const log = (...a) => console.log(...a);
const line = (t) => log('\n════════ ' + t + ' ════════');

let failures = 0, pending = 0;
const check = (ok, what, detail = '') => {
	log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '  -- ' + detail : ''));
	if (!ok) failures++;
};

// Whether the browser half draws the fold at all yet.  The fold stopped borrowing the
// tool surface and became its own event; until `www/js/daimond.js` handles
// `ev.type === 'compacted'` there is nothing in the thread to look for.
let rendersCompacted = false;
try {
	rendersCompacted = /'compacted'|"compacted"/.test(
		fs.readFileSync(path.join(ROOT, 'www', 'js', 'daimond.js'), 'utf8'));
} catch (e) { /* no www tree: treat as not rendered */ }

// A check whose subject is that browser-side edit.  It becomes a real check the moment
// the edit lands, and says so plainly until then -- rather than passing quietly, which
// would hide the gap, or failing, which would report another lane's unfinished work as
// a defect in this one.
const whenRendered = (ok, what, detail = '') => {
	if (rendersCompacted) return check(ok, what, detail);
	log('  PEND  ' + what + '  -- www/js/daimond.js does not handle ev.type === \'compacted\' yet');
	pending++;
};

const requests = () => fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
	.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

/// An independent reading of the rule a provider enforces: an assistant message with
/// tool_calls must be followed by one tool reply per call, in order, and a tool reply
/// must answer a call.  Written here rather than imported so it agrees with nothing.
function orphans(msgs) {
	let n = 0, i = 0;
	while (i < msgs.length) {
		const m = msgs[i];
		if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
			let k = 0;
			while (k < m.tool_calls.length) {
				const r = msgs[i + 1 + k];
				if (r && r.role === 'tool' && r.tool_call_id === m.tool_calls[k].id) k++;
				else break;
			}
			n += m.tool_calls.length - k;
			i += 1 + k;
		} else if (m.role === 'tool') { n++; i++; }
		else i++;
	}
	return n;
}

const say = async (s, text, waitMs = 6000) => {
	await s.page.fill('#chat-input', text);
	await s.page.click('#chat-send');
	await s.page.waitForTimeout(waitMs);
};

/// Start the mock and wait for it to answer, so a slow start is not read as a refusal.
async function startMock() {
	const child = spawn('node', [path.join(HERE, 'ctxmock.mjs'), String(PORT), String(LIMIT)],
		{ stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, DAIMOND_CTX_LOG: LOG } });
	for (let i = 0; i < 50; i++) {
		try {
			const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
			if (r.ok) return child;
		} catch (e) { /* not up yet */ }
		await new Promise(r => setTimeout(r, 100));
	}
	child.kill();
	throw new Error(`ctxmock did not come up on ${PORT}; is something else already listening?`);
}

// ── go ───────────────────────────────────────────────────────────────────────
try { fs.writeFileSync(LOG, ''); } catch {}
const mock = await startMock();

const s = await open({ name: 'compact', connect: false });
const cfg = await connectMock(s, { baseUrl: MOCK, model: MODEL });
log('connected:', JSON.stringify(cfg));
await newChat(s);

line('1. do some work worth remembering');
await say(s, '@tool file_write {"path":"alpha.txt","content":"the first file"}', 7000);
await say(s, '@tool file_write {"path":"beta.txt","content":"the second file"}', 7000);
log('after two writes:', (await transcript(s)).slice(-120).replace(/\n/g, ' | '));

line('2. fill the window');
// Each of these is about 20 KB of assistant text, so the conversation crosses the
// mock's 12,000-token ceiling within a few turns.
for (let i = 0; i < 5; i++) {
	await say(s, `@big 20`, 9000);
	const r = requests();
	const last = r[r.length - 1] || {};
	log(`  turn ${i + 1}: last request ${last.used} tokens, refused=${!!last.refused}, ` +
		`${(last.messages || []).length} messages`);
	if (r.some(x => x.refused)) { log('  the provider has started refusing'); break; }
}

line('3. keep going -- this is where the old build died');
await say(s, '@text REPLY-AFTER-FOLD-ONE', 12000);
await say(s, '@text REPLY-AFTER-FOLD-TWO', 12000);
const tail = await transcript(s);

// ── what the mock actually saw ───────────────────────────────────────────────
line('what the model was really sent');
const reqs = requests();
const refused = reqs.filter(r => r.refused);
const after   = reqs.slice(reqs.findIndex(r => r.refused) + 1);
const peak    = Math.max(...reqs.map(r => r.used));
log(`requests: ${reqs.length}, refused: ${refused.length}, peak: ${peak} tokens, ` +
	`last: ${reqs[reqs.length - 1].used} tokens`);

check(refused.length > 0,
	'the provider really did refuse an oversized request',
	`${refused.length} refusals, first at ${(refused[0] || {}).used} tokens`);

check(after.length > 0 && after.every(r => !r.refused),
	'every request after the first refusal was accepted',
	`${after.filter(r => r.refused).length} of ${after.length} still refused`);

// The mock's own log, not the transcript: the transcript echoes what the user typed,
// so a dead chat still "contains" the words. What proves the chat is alive is that the
// provider ACCEPTED a request carrying them and the reply came back.
const answered = reqs.some(r => !r.refused && (r.messages || []).some(
	m => m.role === 'user' && /REPLY-AFTER-FOLD-TWO/.test(String(m.content || ''))));
check(answered && /REPLY-AFTER-FOLD-TWO/.test(tail),
	'the chat still answers after the refusal',
	tail.slice(-160).replace(/\n/g, ' | '));

const last = reqs[reqs.length - 1];
check(last.used < peak,
	'the conversation was actually made smaller',
	`peak ${peak} -> last ${last.used} tokens`);

const folded = reqs.find(r => (r.messages || []).some(m => /Daimond folded/.test(String(m.content || ''))));
check(!!folded, 'a fold notice reached the model');

if (folded) {
	const note = folded.messages.find(m => /Daimond folded/.test(String(m.content || '')));
	check(note.role === 'user',
		'the fold notice is not in the assistant\'s own voice', `role=${note.role}`);
	check(/alpha\.txt/.test(note.content) && /beta\.txt/.test(note.content),
		'the fold still knows which files were written',
		note.content.replace(/\n/g, ' | ').slice(0, 200));
	check(/SUMMARY-FROM-MODEL/.test(note.content),
		'the summarising call\'s answer is in the notice');
}

const broken = reqs.filter(r => orphans(r.messages || []) > 0);
check(broken.length === 0,
	'every request the browser sent was a whole conversation (no orphaned tool calls)',
	`${broken.length} of ${reqs.length} were not`);

check(!/HTTP error/.test(tail),
	'the user was never shown the refusal',
	(tail.match(/LLM: HTTP error[^|]*/g) || []).join(' | '));

// The fold used to borrow the tool surface and appear as a `context_compaction` row.
// It is its own event now, so what the user sees is the notice itself -- and until the
// browser handles `ev.type === 'compacted'` there is nothing to see at all.
whenRendered(/[Ff]olded \d+ earlier messages/.test(tail),
	'the user WAS shown that the conversation had been folded',
	tail.slice(-200).replace(/\n/g, ' | '));
check(!/context_compaction/.test(tail),
	'the fold no longer masquerades as a tool the model called');

// 502s are the local gateway proxy (/api) not running.  A 400 is the deliberate
// refusal this whole audit is built around: the browser logs the failed fetch, and
// what matters is that the app recovered from it, which the checks above establish.
const errs = s.errs.filter(e => !/favicon|manifest|502|Bad Gateway|400 \(Bad Request\)/i.test(e));
check(errs.length === 0, 'no unexpected console errors', errs.slice(0, 3).join(' | '));
const four00 = s.errs.filter(e => /400 \(Bad Request\)/.test(e));
check(four00.length === refused.length,
	'the browser saw exactly the refusals the provider issued and no more',
	`${four00.length} console 400s against ${refused.length} refusals`);

await shot(s, 'compact-final');
await s.close();
mock.kill();

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}` +
	(pending ? `  (${pending} pending a browser-side edit)` : ''));
process.exit(failures === 0 ? 0 : 1);
