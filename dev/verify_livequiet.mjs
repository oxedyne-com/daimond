// gateway: none
// U3a LV2, A3: a quiet that is not a silent model is never cut by liveness.
//
// Liveness races ONLY the model call. A tool is held to its own ceiling, and a person's wait
// beats the call it holds. So with the turn's liveness limit at 3 s (`window.__livenessMs`), three
// waits of about 9 s must each end well:
//
//   (a) a chat's `gather` waits ~9 s on a worker kept alive by `@trickle`, and the worker ends
//       `done`                                             -- here, in an ordinary chat;
//   (b) `run` with `timeout_ms` 10000 on a command quiet for 9 s ends ok
//                                                          -- `verify_handrun.mjs`, HR_LIVE=1;
//   (c) a delete held 9 s at the person's question, then answered, goes on, and the beat is in
//       the console                                        -- `verify_deletekeep.mjs`, DK_ONLY=LQC.
//
// (b) and (c) run as arms of the files that own their worlds (a mock hand; a marked folder and a
// Diamond), so neither world is copied here.
//
// Red: point `Agent::one_call`'s race at the liveness limit with no margin and take the person's
// beat away (`deadline::held_every`), rebuild www/pkg, and all three fail.
//
//   node dev/verify_livequiet.mjs              # (a), (b), (c)
//   LQ_ONLY=a node dev/verify_livequiet.mjs    # one of them
//   (b) is headed: under no display, run the whole file in xvfb-run -a.
import { spawnSync } from 'node:child_process';
import { open, newChat, mockLog, clearMockLog } from './harness.mjs';
import { armFilter, guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const want = armFilter('LQ_ONLY');

// ── (a) a gather waits on a live worker ─────────────────────────────────────
if (want('a')) {
	const s = await open({ name: 'livequiet' });
	const { page } = s;
	// Before the chat's agent is built: `applyLiveness` reads it there.
	await page.evaluate(() => { window.__livenessMs = 3000; });
	await newChat(s);
	clearMockLog();
	const t0 = Date.now();
	await page.fill('#chat-input',
		'@tools spawn_agent {"name":"a","task":"@trickle 8/500 9000"}'
		+ ' ;; gather {"names":["a"],"timeout_s":60}');
	await page.keyboard.press('Enter');
	// The round after the gather carries the worker's report back to the model.
	let back = 0;
	for (let i = 0; i < 300 && !back; i++) {
		const wire = mockLog();
		if (wire.some((m) => (m.messages || []).some((x) => x.role === 'tool'
			&& typeof x.content === 'string' && x.content.includes('### a')))) back = Date.now();
		else await page.waitForTimeout(100);
	}
	const runs = await page.evaluate(() => (window.DaimondWorkers
		? window.DaimondWorkers.runs.map((r) => ({ name: r.name, status: r.status })) : []));
	const took = back ? back - t0 : 0;
	check('LQ(a). with liveness at 3 s, a gather waits ~9 s on a trickling worker and reads it',
		took >= 8500 && took < 45000, back ? `${took} ms` : 'the report never came back');
	check('LQ(a). and the worker ended done',
		runs.some((r) => r.name === 'a' && r.status === 'done'), JSON.stringify(runs));
	// The gather's own answer, not a later wake: a gather cut at its ceiling answers with the
	// cut, and the report then reaches the model only on the wake turn, so the timing alone passes.
	const cut = mockLog().flatMap((m) => m.messages || []).filter((x) => x.role === 'tool'
		&& typeof x.content === 'string' && /within its own limit/.test(x.content));
	check('LQ(a). and the gather was not cut at a ceiling', cut.length === 0,
		cut.length ? cut[0].content.slice(0, 160) : '');
	const tail = await page.evaluate(() => [...document.querySelectorAll('.msg')].slice(-1)
		.map((m) => m.textContent || '').join(''));
	check('LQ(a). and the chat\'s turn was not ended for want of progress',
		!/no progress for/.test(tail), tail.slice(0, 160));
	await s.close();
}

// ── (b) and (c): arms of the files that own their worlds ─────────────────────
const arm = (label, file, env) => {
	const r = spawnSync('node', [file], { env: { ...process.env, ...env }, encoding: 'utf8',
		timeout: 15 * 60 * 1000 });
	const lines = String(r.stdout || '').split('\n').filter((l) => /^\s+(ok|FAIL)\s+LQ/.test(l));
	for (const l of lines) console.log(l);
	const fails = lines.filter((l) => /FAIL/.test(l)).length;
	check(`LQ(${label}). ${file} ran its arm and it held`, lines.length > 0 && fails === 0,
		`${lines.length} checks, ${fails} failed, exit ${r.status}`
		+ (lines.length ? '' : '; ' + String(r.stderr || r.stdout || '').slice(-300)));
};
if (want('b')) arm('b', 'dev/verify_handrun.mjs', { HR_LIVE: '1' });
if (want('c')) arm('c', 'dev/verify_deletekeep.mjs', { DK_ONLY: 'LQC' });

guardRan(ok.length + bad.length, want);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
