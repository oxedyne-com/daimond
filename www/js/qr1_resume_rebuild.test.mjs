/* ============================================================
   Test -- U3a release QA (qr1), surface A: a Resume or a continuation must
   reach the model WITH its transcript, whichever app the turn runs on.
   ------------------------------------------------------------
   `Workers.start` restores the seed (Resume) or the prior session
   (continuation) onto the app `build()` made, and only THEN runs the F1
   TURN START `ensure`. A dead key -- or the first call to a gateway without
   `ensure` -- answers with a fresh key, and the page calls `build()` again:
   a NEW app, with nothing restored. `run_turn` then sends RESUME_NUDGE
   ("Continue the task from where you left off ...") with no task and no
   transcript, or a continuation's brief with no prior conversation.
   Runs the REAL segment of start(), from the restore to `Files.reknow`.
   ============================================================ */
import { readFileSync } from 'node:fs';

const D = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};
const A = 'if (run._priorSession && run._priorSession.length && run.app.restore_session) {';
const Z = 'await Files.reknow();';
const a = D.indexOf(A), z = D.indexOf(Z, a);
if (a < 0 || z < 0) { console.log('  FAIL could not lift the segment'); process.exit(1); }
const seg = D.slice(a, z);
const wp = D.slice(D.indexOf('\tfunction workerProse('), D.indexOf('\n\t}\n', D.indexOf('\tfunction workerProse(')) + 3);

class App {
	constructor(n) { this.n = n; this.session = null; this.prompt_tokens = 0; this.completion_tokens = 0; }
	restore(seed) { this.session = { kind: 'seed', seed }; }
	restore_session(s) { this.session = { kind: 'prior', s }; }
}
const run_ = new Function('run', 'build', 'scope', 'onCredits', 'DaimondModels', 'ensureWantMinor',
	'dsRounds', 'WakeLock', 'recordSpend', 'appSpend', 'Files', 'window', 'runNode',
	wp + '\nreturn (async function () {\n' + seg + '\n})();');

async function go(label, run, ensureReply) {
	let made = 0;
	const build = () => { run.app = new App(++made); };
	build();
	const DM = { ensureActive: () => true, ensure: async () => ensureReply };
	await run_(run, build, async () => {}, true, DM, () => 100, () => 100,
		{ hold() {}, release() {} }, () => null, () => ({ p: 0, c: 0, ca: 0, cost: 0 }), {}, {}, 'self');
	return { app: run.app, made };
}

for (const [why, reply] of [['ensure raised the key in place', { raised_minor: 100 }],
	['ensure found the key dead and minted a fresh one', { raised_minor: 0, key: 'k2', url: 'u' }]]) {
	console.log('a timed_out worker resumed; ' + why);
	const r = await go(why, { task: 'Survey the notes', text: 'I read three of the five files.', said: [],
		resume: true, tools: [] }, reply);
	check('the app run_turn is called on holds the resume seed (apps built: ' + r.made + ')',
		r.app.session && r.app.session.kind === 'seed'
			&& JSON.stringify(r.app.session.seed).includes('Survey the notes'),
		'session=' + JSON.stringify(r.app.session));
	console.log('a continuation (dispatched by name); ' + why);
	const c = await go(why, { task: 'Now finish the table', text: '', said: [], tools: [],
		_priorSession: [{ role: 'user', content: 'Survey the notes' }] }, reply);
	check('the app run_turn is called on holds the prior session (apps built: ' + c.made + ')',
		c.app.session && c.app.session.kind === 'prior', 'session=' + JSON.stringify(c.app.session));
}
console.log(ok + ' ok, ' + bad + ' failed');
process.exit(bad ? 1 : 0);
