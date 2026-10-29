/* ============================================================
   Test -- a worker's two starts (r578c, D-20261020-05).

   A FORK worker carries the id of the engine's copy of its
   parent's request and adopts it after every build, then sends
   one hand-off message (role + task). A BRIEF worker -- no id, a
   copy gone, a continuation or a resume -- keeps the old start:
   the worker role as its system prompt and the task as its first
   message. Both are measured here from the REAL www/js/daimond.js
   (functions extracted from source, driven against stubs), and,
   where a www/pkg engine is present, against the real exports.

   Run:  node www/js/workerfork.test.mjs
   ============================================================ */

import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = join(HERE, '..', '..');
const SRC  = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0, cases = 0, bad = null;

function ok(cond, detail) { if (!cond && !bad) bad = detail || 'assertion'; }
function eq(got, want, what) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	if (a !== b && !bad) bad = (what || 'value') + ': got ' + a + ' want ' + b;
}
function kase(name, fn) {
	cases++; bad = null;
	try { fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

async function akase(name, fn) {
	cases++; bad = null;
	try { await fn(); } catch (e) { if (!bad) bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

// A top-level `function NAME(args) { ... }`, brace-matched, as an expression.
function fnSource(name) {
	const m = new RegExp('\\n\\tfunction ' + name + '\\s*\\(([^)]*)\\)\\s*\\{').exec(SRC);
	if (!m) throw new Error('function not found: ' + name);
	let i = m.index + m[0].length - 1, depth = 0;
	for (; i < SRC.length; i++) {
		const c = SRC[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) break; }
	}
	return SRC.slice(m.index + 1, i + 1);
}
function build(name, free) {
	// A function the page lacks fails the cases that call it, not the whole file.
	if (!new RegExp('\\n\\tfunction ' + name + '\\s*\\(').test(SRC)) {
		return () => () => { throw new Error('function not found: ' + name); };
	}
	// eslint-disable-next-line no-new-func
	return new Function(...free, 'return (' + fnSource(name) + ');');
}

// The text of `Workers.start`, from its opening to the next method.
const START = (function () {
	const at = SRC.indexOf('var closeEarly = function () {');
	const end = SRC.indexOf('\n\t\t},', SRC.indexOf('forkForget(run);\n\t\t\t\tWakeLock.release();'));
	if (at < 0 || end < 0) throw new Error('Workers.start not found');
	return SRC.slice(at, end);
})();

function stubApp(filed) {
	const app = { adopted: [] };
	app.adopt_fork = function (id) {
		if (!filed.has(id)) throw new Error('no parent copy is filed under ' + id);
		app.adopted.push(id);
		return 1234;
	};
	return app;
}

const forgot = [];
const Wasm = {
	worker_handoff: (role, task) => (role || 'DEFAULT-HANDOFF') + '\n\n## Your task\n\n' + task,
	fork_forget: id => { forgot.push(id); },
};
const Prompts = { md: {} };
const forkable   = build('forkable', [])();
const workerKind = build('workerKind', [])();
// n1: the kind is settled at adoption, and whoever asked for it is answered then.
const settleKind  = build('settleKind', ['workerKind'])(workerKind);
const startedKind = build('startedKind', ['workerKind'])(workerKind);
const adoptFork  = build('adoptFork', ['forkable', 'settleKind'])(forkable, settleKind);
const firstAsk   = build('firstAsk', ['Wasm', 'Prompts'])(Wasm, Prompts);
const forkForget = build('forkForget', ['Wasm'])(Wasm);

kase('a fork worker adopts its copy and opens on the hand-off, role then task', () => {
	const run = { fork: 'f1', task: 'count the files', app: stubApp(new Set(['f1'])) };
	adoptFork(run);
	eq(run.forked, true, 'forked');
	eq(run.app.adopted, ['f1'], 'adopted');
	const ask = firstAsk(run);
	ok(ask.startsWith('DEFAULT-HANDOFF'), 'the hand-off does not lead with the role: ' + ask);
	ok(ask.endsWith('count the files'), 'the hand-off does not carry the task: ' + ask);
	Prompts.md.worker = 'MY-WORKER-ROLE';
	ok(firstAsk(run).startsWith('MY-WORKER-ROLE'), 'the user\'s own worker role was not used');
	delete Prompts.md.worker;
});

kase('a brief worker (no id) adopts nothing and opens on its task alone', () => {
	const run = { fork: '', task: 'count the files', app: stubApp(new Set(['f1'])) };
	adoptFork(run);
	eq(run.forked, false, 'forked');
	eq(run.app.adopted, [], 'adopted');
	eq(firstAsk(run), 'count the files', 'first message');
});

kase('a copy that is gone, a continuation and a resume all fall back to the brief start', () => {
	const gone = { fork: 'f9', task: 't', app: stubApp(new Set()) };
	adoptFork(gone);
	eq([gone.forked, firstAsk(gone)], [false, 't'], 'copy gone');
	const cont = { fork: 'f1', task: 't', _priorSession: [{}], app: stubApp(new Set(['f1'])) };
	adoptFork(cont);
	eq([cont.forked, cont.app.adopted], [false, []], 'continuation');
	const res = { fork: 'f1', task: 't', resume: true, app: stubApp(new Set(['f1'])) };
	adoptFork(res);
	eq([res.forked, res.app.adopted], [false, []], 'resume');
	const old = { fork: 'f1', task: 't', app: {} };
	adoptFork(old);
	eq(old.forked, false, 'an engine without adopt_fork');
});

// A1 (QA-A r578c): a continuation is keyed by the conversation, and only `continue:` asks for one.
const priorSessionRun = build('priorSessionRun', [])();

kase('a worker never continues another chat\'s copy, whatever its name (A1)', () => {
	// Chat A's "researcher" finished holding A's whole conversation.
	const runs = [{ diamondId: '', chatId: 'chatA', name: 'researcher', _session: ['A-conversation'] }];
	eq(priorSessionRun(runs, '', 'chatB', 'researcher', 'look into it'), null, 'chat B, same name');
	eq(priorSessionRun(runs, '', 'chatB', 'researcher', 'continue: look into it'), null, 'chat B, continue:');
	eq(priorSessionRun(runs, '', 'chatB', '', 'continue: carry on'), null, 'chat B, continue: with no name');
	eq(priorSessionRun(runs, '', '', 'researcher', 'continue: x'), null, 'no conversation at all');
});

kase('a name alone never continues: the same Diamond\'s worker takes the current copy (A1)', () => {
	const old = { diamondId: 'D1', chatId: '', name: 'researcher', _session: ['stale'] };
	eq(priorSessionRun([old], 'D1', '', 'researcher', 'look into it'), null, 'same Diamond, same name');
	const run = { fork: 'f1', task: 'look into it', _priorSession: null, app: stubApp(new Set(['f1'])) };
	adoptFork(run);
	eq(run.forked, true, 'the current copy is adopted');
});

kase('continue: picks up the same conversation\'s run, by name first (A1)', () => {
	const mine  = { diamondId: 'D1', chatId: '', name: 'researcher', _session: ['mine'] };
	const other = { diamondId: 'D1', chatId: '', name: 'writer', _session: ['other'] };
	const elsew = { diamondId: 'D2', chatId: '', name: 'researcher', _session: ['elsewhere'] };
	eq(priorSessionRun([elsew, other, mine], 'D1', '', 'researcher', 'continue: go on'), mine, 'by name');
	eq(priorSessionRun([elsew, other, mine], 'D1', '', '', 'Continue: go on'), other, 'newest of this Diamond');
	const chat = { diamondId: '', chatId: 'chatA', name: 'researcher', _session: ['A'] };
	eq(priorSessionRun([chat], '', 'chatA', 'researcher', 'continue: go on'), chat, 'the same chat');
});

// QA r578d-A (LOW, failing-first): a NAMED continue: whose name matches no run of this
// conversation must not pick up a differently named worker's thread. Claude Code resumes an
// agent only by its own id; a name that names nobody continues nobody.
kase('QA r578d-A: a named continue: with no run of that name continues nothing', () => {
	const other = { diamondId: 'D1', chatId: '', name: 'writer', _session: ['other'] };
	eq(priorSessionRun([other], 'D1', '', 'researcher', 'continue: go on'), null,
		'researcher picked up the writer\'s conversation');
});

kase('dispatch passes the run\'s chat to priorSessionRun (A1)', () => {
	// The spec's own name (D3): `run.name` is 'agent-N' for a nameless worker, which
	// would make every nameless `continue:` a named one that matches nothing.
	ok(SRC.indexOf("priorSessionRun(self.runs, diamondId, chatId, spec.name || '', run.task)") > 0, 'dispatch call');
});

kase('the kind a worker ran as: full after an adoption, brief otherwise (D-20261020-05)', () => {
	const full = { fork: 'f1', task: 't', app: stubApp(new Set(['f1'])) };
	adoptFork(full);
	eq([forkable(full), workerKind(full)], [true, 'full'], 'full');
	const brief = { fork: '', task: 't', app: stubApp(new Set(['f1'])) };
	adoptFork(brief);
	eq([forkable(brief), workerKind(brief)], [false, 'brief'], 'brief');
	const gone = { fork: 'f9', task: 't', app: stubApp(new Set()) };
	adoptFork(gone);
	eq(workerKind(gone), 'brief', 'a copy that was gone ran brief');
	eq(workerKind({ fork: 'f1' }), 'brief', 'a run that never started');
});

kase('cx is the kind adopted: on both end rows, never guessed on the start row (A6)', () => {
	const at = START.indexOf("at:    'start',");
	const ev = START.slice(at, START.indexOf('});', at));
	ok(!/\bcx:/.test(ev), 'the start row guesses the kind before the copy is adopted: ' + ev);
	const early = START.slice(START.indexOf('var closeEarly = function () {'));
	const er = early.slice(early.indexOf("at:    'end',"), early.indexOf('});'));
	ok(/cx:\s+workerKind\(run\)/.test(er), 'closeEarly end row: ' + er);
	const last = SRC.lastIndexOf("at:    'end',", SRC.indexOf('rb:    run.reportRaw, sb: run.reportSent,'));
	const lr = SRC.slice(last, SRC.indexOf('});', last));
	ok(/cx:\s+workerKind\(run\)/.test(lr), 'final end row: ' + lr);
});

kase('the spawn answer says the kind the page set the run to, for the STARTED line (A6)', () => {
	ok(/return JSON\.stringify\(\{ started: true, id: ids\[0\], name: name,\s+cx: /.test(SRC),
		'the spawn answer carries no cx');
});

// n1: THE KIND IS SAID WHEN IT IS KNOWN. A worker that starts now is announced once its copy is
// adopted (or its start fell short), so "STARTED full" is never said of one that will run brief.
// A queued one is announced as queued, and the kind it ran as is in its report.
const kindSaid    = build('workerKindSaid', ['workerKind'])(workerKind);

await akase('n1: the started kind is answered at adoption, not at dispatch', async () => {
	const gone = { fork: 'f9', task: 't', app: stubApp(new Set()) };
	let said = null;
	const p = startedKind(gone).then(k => { said = k; });
	eq(said, null, 'answered before the copy was adopted');
	adoptFork(gone);
	await p;
	eq(said, 'brief', 'a copy gone by adoption was announced');
	const full = { fork: 'f1', task: 't', app: stubApp(new Set(['f1'])) };
	adoptFork(full);
	eq(await startedKind(full), 'full', 'an adopted copy, asked after');
	const died = { fork: 'f1', task: 't' };
	const q = startedKind(died);
	settleKind(died);
	eq(await q, 'brief', 'a start that fell short before adoption');
});

kase('n1: a copy that was gone by adoption says so in its report heading', () => {
	const gone = { fork: 'f9', task: 't', app: stubApp(new Set()) };
	adoptFork(gone);
	ok(/^brief\b.*copy.*gone/.test(kindSaid(gone)), 'the fallback is not said: ' + kindSaid(gone));
	const full = { fork: 'f1', task: 't', app: stubApp(new Set(['f1'])) };
	adoptFork(full);
	eq(kindSaid(full), 'full', 'full');
	eq(kindSaid({ fork: '', task: 't' }), 'brief', 'asked brief');
});

kase('n1: spawn waits for a running worker\'s kind and says a queued one is queued', () => {
	const at = SRC.indexOf('var made = self.runs.find(function (r) { return r.id === ids[0]; });');
	const body = SRC.slice(at, SRC.indexOf('.catch(function (e) {', at));
	ok(/made\.status === 'queued'/.test(body), 'no queued branch: ' + body.slice(0, 200));
	ok(/startedKind\(made\)/.test(body), 'the answer does not wait for adoption');
	ok(!/forkable\(made\) \? 'full'/.test(body) || /queued: true/.test(body), 'a running worker is announced at dispatch');
	const early = START.slice(START.indexOf('var closeEarly = function () {'));
	ok(/settleKind\(run\)/.test(early.slice(0, early.indexOf('};'))), 'closeEarly leaves the spawn waiting');
});

kase('reports name the kind: both gather report rows and the later-turn heading', () => {
	eq((SRC.match(/context: workerKindSaid\(r\),/g) || []).length, 2, 'gather report rows');
	ok(SRC.indexOf("var head = '### ' + (r.name || r.id) + ' [' + workerKindSaid(r) + ']' + workerEndingNote(r);") > 0,
		'later-turn heading');
});

kase('the copy is forgotten for a fork worker and not asked about for a brief one', () => {
	forgot.length = 0;
	forkForget({ fork: 'f3' });
	forkForget({ fork: '' });
	forkForget(null);
	eq(forgot, ['f3'], 'forgotten');
});

kase('Workers.start adopts after EVERY build (scope) and opens with firstAsk, the re-mint too', () => {
	ok(/adoptFork\(run\);\n\t\t\t\};/.test(START), 'scope does not end by adopting the copy');
	ok(START.indexOf(': firstAsk(run);') > 0, 'the first message is not firstAsk');
	// The re-mint re-sends what the first attempt sent (U3a QRFIX2 F2): `nudge`, which is firstAsk(run) for a
	// fresh dispatch or a continuation, so both sends go out as `nudge`.
	eq((START.match(/await run\.app\.run_turn\(nudge, sink\);/g) || []).length, 2, 'the re-mint does not reopen with firstAsk');
	ok(START.indexOf('await run.app.run_turn(run.task, sink);') < 0, 'a path still opens on the bare task');
	// The brief start is still built: the worker role and crystal as the constructor's system.
	eq((START.match(/Instructions\.compose\(Prompts\.role\('worker', run\.model\), crystal\)/g) || []).length,
		2, 'the brief worker\'s system prompt');
});

kase('the copy is forgotten on both endings: closeEarly and the finally block', () => {
	ok(/var closeEarly = function \(\) \{\n(\t\t\t\tself2\.freeRunLock\(run\);\n)?\t\t\t\tforkForget\(run\);/.test(START), 'closeEarly');
	ok(/\} finally \{\n\t\t\t\tforkForget\(run\);/.test(START), 'finally');
});

kase('a queued or paused worker that is Stopped drops its copy (A5)', () => {
	const at = SRC.indexOf('\t\tstop: function (run) {');
	const body = SRC.slice(at, SRC.indexOf('\n\t\t},', at));
	const queued = body.slice(body.indexOf("if (run.status === 'queued')"), body.indexOf('return;'));
	ok(queued.indexOf('forkForget(run);') > 0, 'the queued branch of stop keeps the copy');
	const held = body.slice(body.indexOf('if (RESUMABLE_ENDINGS.indexOf(run.status) >= 0)'));
	ok(held.slice(0, held.indexOf('return;')).indexOf('forkForget(run);') > 0,
		'the paused branch of stop keeps the copy');
});

kase('the start event carries ab (task bytes) and pb (the copy\'s bytes)', () => {
	const at = START.indexOf("at:    'start',");
	const ev = START.slice(at, START.indexOf('});', at));
	ok(/ab:\s+jsonBytes\(run\.task/.test(ev), 'no ab: ' + ev);
	ok(/pb:\s+run\.forkBytes \| 0/.test(ev), 'no pb: ' + ev);
});

kase('spawn hands the engine\'s fork id and size to dispatch, and dispatch puts them on the run', () => {
	ok(/fork: String\(\(o && o\.fork\) \|\| ''\), fb: \(o && o\.fb\) \| 0/.test(SRC), 'spawn');
	ok(/fork: spec\.fork \|\| '',\n\t+forkBytes: spec\.fb \| 0,/.test(SRC), 'dispatch');
});

let ENGINE = null;
try {
	const mod = await import(join(APP, 'www', 'pkg', 'oxedyne_daimond.js'));
	mod.initSync({ module: readPage(join(APP, 'www', 'pkg', 'oxedyne_daimond_bg.wasm')) });
	if (typeof mod.worker_handoff === 'function' && typeof mod.fork_forget === 'function') ENGINE = mod;
} catch (e) { ENGINE = null; }

if (!ENGINE) {
	console.log('  SKIP the real engine cases: no www/pkg wasm with worker_handoff here');
} else {
	kase('ENGINE: the hand-off is the default fork role, then the task', () => {
		const h = ENGINE.worker_handoff('', 'count the files');
		ok(/^You are now a worker agent, dispatched from the conversation above/.test(h), h.slice(0, 80));
		ok(h.endsWith('## Your task\n\ncount the files'), h.slice(-60));
		ok(ENGINE.worker_handoff('MY ROLE', 't').startsWith('MY ROLE\n\n## Your task'), 'own role');
		// The arms' mock reads a worker's directive past this separator (dev/mockllm.mjs HANDOFF): a reworded
		// hand-off must redden here, not as four verify_actor money arms.
		const lit = /const HANDOFF = '([^']*)';/.exec(readPage(join(APP, 'dev', 'mockllm.mjs'), 'utf8'));
		ok(lit, 'dev/mockllm.mjs declares HANDOFF');
		const sep = lit[1].replace(/\\n/g, '\n');
		ok(ENGINE.worker_handoff('', 'T').endsWith(sep + 'T'), JSON.stringify(ENGINE.worker_handoff('', 'T').slice(-40)));
	});
	kase('ENGINE: the brief worker\'s default role is the old one, its own context', () => {
		const d = ENGINE.default_prompt('worker');
		ok(/^You are a worker agent dispatched to carry out exactly one task/.test(d), d.slice(0, 80));
		ok(d.indexOf('not this conversation') > 0, 'the brief role no longer says it cannot see it');
	});
	kase('ENGINE: forgetting an id nobody filed is harmless', () => {
		ENGINE.fork_forget('f-none');
	});
}

console.log('\n' + cases + ' cases, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
