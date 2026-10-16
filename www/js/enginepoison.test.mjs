/* ============================================================
   Test -- a poisoned engine ends every turn waiting on it (UNBLOCK-7 F2).

   THE BUG. A wasm trap (a panic, or a JS throw through an import the engine was inside)
   leaves the engine's RefCell borrowed for ever: every await on it never settles, so the
   turn's own catch never runs, `_generating` and the crystal's busy flag stay up, and a
   runner holds its errand until the lease runs out. The phone saw "no peer awake".

   THE FIX. Each engine await is raced against a kill (`turnKill`). A trap -- the window
   `error` / `unhandledrejection` with a `WebAssembly.RuntimeError`, or the panic hook's
   trail note -- poisons the engine once: the runs end through the runner's door
   (`DaimondPeer.poisonRuns`), every in-flight await rejects with an interrupted error so
   the existing catch exits run, and the page reloads within 4 s.

   The helpers are LIFTED from daimond.js (devicename.test.mjs's method), so the real
   source is what runs.   `node www/js/enginepoison.test.mjs`
   ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) throw new Error('function not found in daimond.js: ' + name);
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}
function extractVar(src, name) {
	const m = new RegExp('\\n\\tvar ' + name + '\\s*=[^\\n]*;').exec(src);
	if (!m) throw new Error('var not found in daimond.js: ' + name);
	return m[0].trim();
}

const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const lifted = [
	extractVar(src, '_enginePoison'), extractVar(src, '_engineAwaits'), extractVar(src, 'POISON_RELOAD_MS'), extractVar(src, 'ENGINE_HUNG_MS'),
	extractFn(src, 'isWasmTrap'), extractFn(src, 'engineKillError'), extractFn(src, 'turnKill'),
	extractFn(src, 'killEngineAwaits'), extractFn(src, 'endTurnEngine'), extractFn(src, 'poisonEngine'),
].join('\n');

function harness() {
	const env = { runs: [], reloads: [], timers: [], diags: [] };
	const window = { DaimondPeer: { poisonRuns: (why) => { env.runs.push(why); return 1; } } };
	const location = { reload: () => env.reloads.push(1) };
	const setTimeout = (fn, ms) => { env.timers.push({ fn, ms }); return env.timers.length; };
	const diag = (a, b) => env.diags.push(a + ' ' + b);
	const api = new Function('window', 'location', 'setTimeout', 'diag', 'WebAssembly',
		lifted + '\nreturn { isWasmTrap, turnKill, killEngineAwaits, endTurnEngine, poisonEngine, poisoned: function () { return _enginePoison; } };')(
		window, location, setTimeout, diag, WebAssembly);
	return { api, env };
}

const tick = () => new Promise((r) => globalThis.setTimeout(r, 0));

{
	const { api } = harness();
	check('isWasmTrap: a WebAssembly.RuntimeError is a trap', api.isWasmTrap(new WebAssembly.RuntimeError('unreachable')));
	check('isWasmTrap: an ordinary Error is not', !api.isWasmTrap(new Error('x')) && !api.isWasmTrap(null));
	const v = await api.turnKill(Promise.resolve(7), {});
	check('turnKill: a settling await passes through', v === 7);
	let rej = null;
	try { await api.turnKill(Promise.reject(new Error('own')), {}); } catch (e) { rej = e; }
	check('turnKill: and its own failure too', !!rej && rej.message === 'own');
}

{
	const { api } = harness();
	const a = {}, b = {};
	let ea = null, eb = null;
	const pa = api.turnKill(new Promise(() => {}), a).catch((e) => { ea = e; });
	const pb = api.turnKill(new Promise(() => {}), b).catch((e) => { eb = e; });
	check('killEngineAwaits: kills only the named turn', api.killEngineAwaits(a, 'deadline') === 1);
	await pa; await tick();
	check('killEngineAwaits: its await rejects as interrupted', !!ea && ea.interrupted === true, String(ea));
	check('killEngineAwaits: the other turn is untouched', eb === null);
	void pb;
}

{
	const { api, env } = harness();
	const a = {}, b = {};
	const errs = [];
	const ps = [api.turnKill(new Promise(() => {}), a), api.turnKill(new Promise(() => {}), b)]
		.map((p) => p.catch((e) => { errs.push(e); }));
	api.poisonEngine('panic: already borrowed');
	await Promise.all(ps);
	check('poisonEngine: every in-flight engine await rejects', errs.length === 2 && errs.every((e) => e.interrupted && e.poisoned));
	check('poisonEngine: the runs end through the runner door, once', env.runs.length === 1 && env.runs[0] === 'poison');
	check('poisonEngine: a reload is scheduled within 4 s', env.timers.length === 1 && env.timers[0].ms > 0 && env.timers[0].ms <= 4000);
	env.timers[0].fn();
	check('poisonEngine: and it reloads the page', env.reloads.length === 1);
	api.poisonEngine('again');
	check('poisonEngine: once only', env.runs.length === 1 && env.timers.length === 1);
	let late = null;
	try { await api.turnKill(new Promise(() => {}), {}); } catch (e) { late = e; }
	check('turnKill: after the poison a new engine await fails at once', !!late && late.poisoned === true);
}

// check_f234 Q3: a run ended on its deadline whose engine call never settles leaves the
// engine borrowed, so the next turn on it traps. After a grace the engine is poisoned.
{
	const { api, env } = harness();
	const a = {};
	let ea = null;
	const pa = api.turnKill(new Promise(() => {}), a).catch((e) => { ea = e; });
	check('endTurnEngine: kills the turn\'s awaits', api.endTurnEngine(a, 'deadline') === 1);
	await pa;
	check('endTurnEngine: its await rejects as interrupted', !!ea && ea.interrupted === true);
	check('endTurnEngine: a grace timer is armed, not a poison at once',
		env.timers.length === 1 && env.timers[0].ms > 0 && env.timers[0].ms <= 10000 && !api.poisoned());
	env.timers[0].fn();
	check('endTurnEngine: an engine call still unsettled after the grace poisons the engine',
		/^hung: deadline/.test(api.poisoned()) && env.runs.length === 1, api.poisoned());
}
{
	const { api, env } = harness();
	const a = {};
	let done = null;
	const own = new Promise((r) => { done = r; });
	const pa = api.turnKill(own, a).catch(() => {});
	api.endTurnEngine(a, 'deadline');
	await pa;
	done(1); await tick();
	env.timers[0].fn();
	check('endTurnEngine: an engine call that settles within the grace does not poison', api.poisoned() === '');
	check('endTurnEngine: a turn with nothing in flight arms nothing', api.endTurnEngine({}, 'x') === 0 && env.timers.length === 1);
}
const endLocalSrc = src.slice(src.indexOf('async function endRunnerLocal('), src.indexOf('async function endRunnerLocal(') + 2500);
check('wiring: endLocal starts endTurnEngine', /endTurnEngine\(chat, why\)/.test(endLocalSrc));
check('wiring: endLocal labels a \'user\' end as a Stop before it ends the engine (check_f1stop P2)',
	endLocalSrc.indexOf("why === 'user'") >= 0 && endLocalSrc.indexOf("why === 'user'") < endLocalSrc.indexOf('endTurnEngine(chat, why)'));

// check_f234 Q5: a trap thrown back through an engine await (a rejection the window's
// `error` listener never hears) poisons the engine as well.
{
	const { api, env } = harness();
	const other = {};
	let eo = null;
	const po = api.turnKill(new Promise(() => {}), other).catch((e) => { eo = e; });
	let rej = null;
	try { await api.turnKill(Promise.reject(new WebAssembly.RuntimeError('unreachable')), {}); } catch (e) { rej = e; }
	await po;
	check('turnKill: a trap is rethrown as itself', !!rej && rej instanceof WebAssembly.RuntimeError, String(rej));
	check('turnKill: and it poisons the engine', /^trap: unreachable/.test(api.poisoned()) && env.runs.length === 1, api.poisoned());
	check('turnKill: so the other turn\'s await ends too', !!eo && eo.poisoned === true);
}

// check_f234 Q4: the poison's own reload must not be held by a "leave site?" prompt, nor
// hand off the turn it has just ended (the run's end already reported it).
{
	const bus = [...src.matchAll(/addEventListener\('beforeunload', function \(e\) \{[^\n]*\n[^\n]*\n[^\n]*\n/g)].map((m) => m[0]);
	check('wiring: neither beforeunload prompt holds a poisoned page', bus.length === 2
		&& /if \(!anyGen\(\) \|\| _enginePoison\) return;/.test(src)
		&& /if \(!Workers\.busy\(\) \|\| _enginePoison\) return;/.test(src), bus.join(' || '));
	check('wiring: pagehide hands nothing off from a poisoned page',
		/if \(!\(e && e\.persisted\) && !_enginePoison\) handoffInFlightOnStepAway\(\);/.test(src));
}

// The wiring, read from the source: the awaits that wedged are the ones raced.
check('wiring: the daimon turn races steer_crystal', /turnKill\(fa\.steer_crystal\(/.test(src));
check('wiring: every chat run_turn is raced', (src.match(/turnKill\(app\.run_turn\(/g) || []).length === 3
	&& !/[^(]await app\.run_turn\(/.test(src));
check('wiring: the runner deps carry endLocal', /endLocal: function \(e, why\) \{ return endRunnerLocal\(ctx && ctx\.chat, e, why\); \}/.test(src));
check('wiring: a trap on the window poisons', /isWasmTrap\(/.test(src.slice(src.indexOf("addEventListener('unhandledrejection'"), src.indexOf("addEventListener('unhandledrejection'") + 2000)));
check('wiring: the panic note poisons', /onNote\(/.test(src) && /'WASM PANIC'/.test(src));
const bc = readFileSync(join(HERE, 'breadcrumb.js'), 'utf8');
check('wiring: the trail offers onNote', /onNote:\s*onNote/.test(bc));

if (failures) { console.log(failures + ' FAILURE(S)'); process.exitCode = 1; }
else console.log('all passed');
