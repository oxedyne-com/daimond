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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = join(HERE, '..', '..');
const SRC  = readFileSync(join(HERE, 'daimond.js'), 'utf8');
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
const adoptFork  = build('adoptFork', ['forkable'])(forkable);
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

kase('the start event carries cx, the kind it starts as', () => {
	const at = START.indexOf("at:    'start',");
	const ev = START.slice(at, START.indexOf('});', at));
	ok(/cx:\s+forkable\(run\) \? 'full' : 'brief'/.test(ev), 'no cx: ' + ev);
});

kase('reports name the kind: both gather report rows and the later-turn heading', () => {
	eq((SRC.match(/context: workerKind\(r\),/g) || []).length, 2, 'gather report rows');
	ok(SRC.indexOf("var head = '### ' + (r.name || r.id) + ' [' + workerKind(r) + ']' + workerEndingNote(r);") > 0,
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
	ok(START.indexOf('await run.app.run_turn(firstAsk(run), sink);') > 0, 'the re-mint does not reopen with firstAsk');
	ok(START.indexOf('await run.app.run_turn(run.task, sink);') < 0, 'a path still opens on the bare task');
	// The brief start is still built: the worker role and crystal as the constructor's system.
	eq((START.match(/Instructions\.compose\(Prompts\.role\('worker', run\.model\), crystal\)/g) || []).length,
		2, 'the brief worker\'s system prompt');
});

kase('the copy is forgotten on both endings: closeEarly and the finally block', () => {
	ok(/var closeEarly = function \(\) \{\n\t\t\t\tforkForget\(run\);/.test(START), 'closeEarly');
	ok(/\} finally \{\n\t\t\t\tforkForget\(run\);/.test(START), 'finally');
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
	mod.initSync({ module: readFileSync(join(APP, 'www', 'pkg', 'oxedyne_daimond_bg.wasm')) });
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
