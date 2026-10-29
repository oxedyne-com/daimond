/* ============================================================
   Test -- ZERO-ROUND: a worker that cannot start says so, and why.
   ------------------------------------------------------------
   34 of 80 workers (8-20 Oct) were logged `capped` at 0 rounds; all were
   the page's 540 s clock, removed in r578c T. What that left: a worker
   whose turn fails ends `error`, and its reason reaches neither its
   report nor either gather heading -- the sentence is the app's, so it is
   subtracted from the report -- so its parent re-dispatches blind into the
   same failure. A worker that got no reply at all is `not_started`; any
   failure carries its reason (`run.why`) to the gather, the payload and
   the lens end row.

   Drives the REAL `Workers.start`, sliced out of daimond.js, over a fake
   engine that fails as `agent.rs` does: an `error` event, then
   `ended{how:failed}`, then a throw.

   Run:  node www/js/workerfail.test.mjs
         WT_SRC=/path/to/old/daimond.js node www/js/workerfail.test.mjs  # red run
   Diagnosis: ~/usr/code/ai/claude/notes/daimond_sync_20261017/diag_zeroround.md
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const GRID = createRequire(import.meta.url)('./agentgrid.js');

const SRC = readPage(process.env.WT_SRC || new URL('./daimond.js', import.meta.url), 'utf8');

let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail !== undefined ? '  -- ' + detail : '')); }
};

const realDelay = (ms) => new Promise((res) => globalThis.setTimeout(res, ms));

// A brace-matched slice from `head` to its closing `}`.
function sliceFrom(at) {
	let i = SRC.indexOf('{', at), depth = 0;
	for (; i < SRC.length; i++) {
		if (SRC[i] === '{') depth++;
		else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
	}
	return SRC.slice(at, i + 1);
}

// A top-level page helper, lifted whole; null where this source has none.
function lift(name) {
	const at = SRC.indexOf('\tfunction ' + name + '(');
	return at < 0 ? null : sliceFrom(at + 1);
}

// A method of `Workers`, as a function expression.
function method(head) {
	const at = SRC.indexOf(head);
	if (at < 0) throw new Error('method not found: ' + head);
	return sliceFrom(at + head.indexOf(':') + 2);	// from `async function` or `function`
}

// A name nothing here supplies: callable, constructible, every property itself,
// and not a thenable, so `await Files.reknow()` and the like pass straight through.
const noop = new Proxy(function () {}, {
	get: (t, k) => (k === 'then' || typeof k === 'symbol') ? undefined : noop,
	apply: () => noop,
	construct: () => noop,
});

const MSG = 'Provider error 400: maximum context length is 65536 tokens, you sent 71234';

// ── The fake engine: `good` rounds that reply, then a refusal ─────────
function fakeClock() { return { setTimeout() { return 0; } }; }
function fakeEngine(good, msg, fault) {
	const MSG_ = msg || MSG;
	return class FakeApp {
		constructor() { this.turn_held = false; this._p = 0; this._c = 0; this._ca = 0; this._cost = 0; }
		get prompt_tokens()     { return this.turn_held ? 0 : this._p; }
		get completion_tokens() { return this.turn_held ? 0 : this._c; }
		get cached_tokens()     { return this.turn_held ? 0 : this._ca; }
		get cost_usd()          { return this.turn_held ? 0 : this._cost; }
		export_session() { return [{ role: 'user', content: 'task' }]; }
		abort() {}
		async run_turn(task, sink) {
			this.turn_held = true;
			try {
				for (let k = 1; k <= good; k++) {
					this._p += 100; this._c += 10; this._cost += 0.01;
					sink({ type: 'round_meta', gen: 'g' + k });
					sink({ type: 'text', content: 'words of round ' + k });
					sink({ type: 'tool_call', name: 'file_write', args: '{}' });
					sink({ type: 'tool_result', outcome: 'done', content: 'ok' });
				}
				sink({ type: 'error', content: MSG_ });
				const end = { type: 'ended', how: 'failed', rounds: good + 1, calls: good, said: MSG_ };
				if (fault) end.fault = fault;	// the engine's class of the failure, from its tags
				sink(end);
				throw new Error(MSG_);
			} finally {
				this.turn_held = false;
			}
		}
	};
}

// ── A model that writes its tool calls as text twice: the engine ends the turn
// `malformed` with its own sentence and RESOLVES, no error and no throw (agent.rs).
const LEAK_SAID = 'The model wrote its tool calls as text twice running, so none of them ran.';
function leakEngine() {
	return class LeakApp {
		constructor() { this.turn_held = false; }
		get prompt_tokens()     { return 0; }
		get completion_tokens() { return 0; }
		get cached_tokens()     { return 0; }
		get cost_usd()          { return 0; }
		export_session() { return [{ role: 'user', content: 'task' }]; }
		abort() {}
		async run_turn(task, sink) {
			for (let k = 1; k <= 2; k++) {
				sink({ type: 'round_meta', gen: 'g' + k });
				sink({ type: 'leaked', fragment: '<tool_call>file_write', recovered: false });
			}
			sink({ type: 'ended', how: 'malformed', rounds: 2, calls: 0, malformed: 2, said: LEAK_SAID });
		}
	};
}

// ── The harness: the real `start` and `stop` over the fakes ───────────
function harness(good, keySlot, engine) {
	const clock = fakeClock();
	const events = [], spends = [];
	const S = {
		window:         {},
		chats:          [],
		DaimondModels:  { held: () => false, CREDITS: 'credits', forgetSlot() {}, keySlot: keySlot || (async () => {}) },
		DaimondApp:     engine || fakeEngine(good),
		Sbj:            { worker_wall_clock_ms: () => 540000 },	// the old page reads it
		setTimeout:     clock.setTimeout,
		clearTimeout:   () => {},
		dsEvent:        (kind, row) => events.push({ kind, row }),
		recordSpend:    (model, p, c, ca, cost) => spends.push({ p, c, ca, cost }),
		friendlyError:  (e) => String(e && e.message || e),
		keyRefused:     () => false,		// no re-mint: the refusal is not a key's
		// The page's one list of endings a worker can be carried on from (`stop` reads it).
		DaimondAgentGrid: GRID,
		RESUMABLE_ENDINGS: ['paused', 'interrupted', 'capped', 'spend_cap', 'timed_out'],
	};
	const scope = new Proxy(S, {
		has: () => true,
		get: (t, k) => {
			if (k in t) return t[k];
			if (k === Symbol.unscopables) return undefined;
			if (typeof k === 'string' && k in globalThis) return globalThis[k];
			return noop;
		},
	});
	// The page's own helpers, real, over the same scope.
	for (const n of ['appSpend', 'workerEndStatus', 'withCommas', 'workerEndingNote',
		'workerWrites', 'workerWroteClause', 'reportBody', 'workerProse',
		'workerKindSaid', 'workerKind', 'workerWhyClause',
		'isFailedEnding', 'workerFoldable', 'failureClass', 'isPassingFailure',
		'statusClass', 'httpStatus', 'stripAnsi', 'isUnreachable']) {
		const src = lift(n);
		if (src) S[n] = new Function('S', 'with (S) { return (' + src + '); }')(scope);
	}
	// The road patterns `failureClass` reads, lifted as the page declares them.
	for (const v of ['CLIENT_ROAD', 'BROWSER_ROAD']) {
		const m = new RegExp('\\tvar ' + v + ' = (/.*/[a-z]*);').exec(SRC);
		if (m) S[v] = new Function('return ' + m[1])();
	}
	const mk = (head) => new Function('S', 'with (S) { return (' + method(head) + '); }')(scope);
	S.window.DaimondModels = S.DaimondModels;
	const W = {
		active: 0, gathered: 0, settled: 0,
		render() {}, touch() {}, nodeOf() { return 'node'; }, persist() {}, pump() {},
		settleAwaits() { this.settled++; }, gather() { this.gathered++; },
		giveSlot() {}, takeSlot() { return 1; }, unseeable() {},
		// The run lock (U3a QRFIX2 F3) guards `load` across tabs; no lock manager here.
		holdRunLock() {}, freeRunLock() {}, persistNow() {},
	};
	W.start = mk('start: async function (run) {');
	W.stop  = mk('stop: function (run) {');
	const run = { id: 'w1', name: 'w', task: 'do the task', model: 'm', provider: 'p',
		diamondId: 'D1', turnId: 't1', text: '', tools: [], said: [], batch: 'b1' };
	return { W, run, clock, events, spends, S };
}

const endRow = (events) => (events.find((e) => e.kind === 'worker' && e.row.at === 'end') || {}).row || {};



// ── (a) refused on its first request: it never started ────────────────
{
	const h = harness(0);
	await h.W.start(h.run);
	const { run, S, events } = h;
	const note = S.workerEndingNote(run);
	check('(a) a worker with no reply is not_started', run.status === 'not_started', run.status);
	check('(a) it carries the refusal as its reason', run.why === MSG, JSON.stringify(run.why));
	check('(a) the gather heading says it could not start, and why',
		note.includes('could not start') && note.includes(MSG), JSON.stringify(note));
	check('(a) and that the same dispatch fails the same way',
		/same way/.test(note), JSON.stringify(note));
	check('(a) never the round cap', !/round cap|capped/.test(note), JSON.stringify(note));
	check('(a) the tile keeps the refusal', run.text.includes(MSG), JSON.stringify(run.text));
	check('(a) the end row says not_started, with the reason',
		endRow(events).out === 'not_started' && endRow(events).why === MSG, JSON.stringify(endRow(events)));
}

// ── (b) refused after two rounds of work: an error, with its reason ───
{
	const h = harness(2);
	await h.W.start(h.run);
	const { run, S, events } = h;
	const note = S.workerEndingNote(run);
	check('(b) a worker that replied, then failed, is error', run.status === 'error', run.status);
	check('(b) it carries the reason', run.why === MSG, JSON.stringify(run.why));
	check('(b) the heading names its rounds and the reason',
		note.includes('error after 3 rounds') && note.includes(MSG), JSON.stringify(note));
	check('(b) and its file writes', note.includes('2 file writes'), JSON.stringify(note));
	check('(b) its report is still its own words, never the app sentence',
		run.report === 'words of round 2', JSON.stringify(run.report));
	check('(b) the end row carries the reason', endRow(events).out === 'error' && endRow(events).why === MSG,
		JSON.stringify(endRow(events)));
}

// ── (c) a key the gateway refuses: it never reached its loop ──────────
{
	const h = harness(0, async () => { throw new Error('The gateway refused a key for this agent: slot floor'); });
	h.run.provider = 'credits';
	await h.W.start(h.run);
	const { run, S, events } = h;
	const note = S.workerEndingNote(run);
	check('(c) a refused key is not_started', run.status === 'not_started', run.status);
	check('(c) with the refusal as its reason', /slot floor/.test(run.why || ''), JSON.stringify(run.why));
	check('(c) the heading says why', /could not start: .*slot floor/.test(note), JSON.stringify(note));
	check('(c) the end row carries it', endRow(events).out === 'not_started' && /slot floor/.test(endRow(events).why || ''),
		JSON.stringify(endRow(events)));
}

// ── (d) a failed worker is never offered Fold in ──────────────────────
{
	const { S } = harness(0);
	const base = { diamondId: 'D1', text: 'Provider error 400', folded: false };
	check('(d) the fold test exists', typeof S.workerFoldable === 'function');
	if (typeof S.workerFoldable === 'function') {
		check('(d) not_started is not foldable', S.workerFoldable(Object.assign({ status: 'not_started' }, base)) === false);
		check('(d) error is not foldable', S.workerFoldable(Object.assign({ status: 'error' }, base)) === false);
		check('(d) blocked is not foldable', S.workerFoldable(Object.assign({ status: 'blocked' }, base)) === false);
		check('(d) a done worker is', S.workerFoldable(Object.assign({ status: 'done' }, base)) === true);
		check('(d) a chat worker is not', S.workerFoldable({ status: 'done', text: 'x' }) === false);
	}
	const SRC2 = readPage(process.env.WT_SRC || new URL('./daimond.js', import.meta.url), 'utf8');
	check('(d) the tile and foldIn both ask workerFoldable',
		(SRC2.match(/workerFoldable\(run\)/g) || []).length >= 2);
}

// ── (f) a passing failure (429) says a retry is right, never "the same way" ──
{
	const RL = 'Provider error 429: rate limited, try again shortly';
	const h = harness(0, null, fakeEngine(0, RL, 'rate_limited'));
	await h.W.start(h.run);
	const { run, S } = h;
	const note = S.workerEndingNote(run);
	check('(f) a 429 before any reply is not_started', run.status === 'not_started', run.status);
	check('(f) it is marked passing', run.whyTransient === true, JSON.stringify(run.whyTransient));
	check('(f) the heading says dispatching it again is right', /passing failure/.test(note), JSON.stringify(note));
	check('(f) and never that the same dispatch fails the same way', !/same way/.test(note), JSON.stringify(note));
	// The lasting one, case (a), keeps the warning and is not marked passing.
	const a = harness(0);
	await a.W.start(a.run);
	check('(f) a 400 is lasting', a.run.whyTransient === false, JSON.stringify(a.run.whyTransient));
}

// ── (e) tool calls written as text twice: an error that says why ──────
{
	const h = harness(0, null, leakEngine());
	await h.W.start(h.run);
	const { run, S, events } = h;
	const note = S.workerEndingNote(run);
	check('(e) a malformed worker is error', run.status === 'error', run.status);
	check('(e) it carries the engine\'s sentence as its reason', run.why === LEAK_SAID, JSON.stringify(run.why));
	check('(e) the gather heading says why', note.includes(LEAK_SAID), JSON.stringify(note));
	check('(e) the end row carries it', endRow(events).out === 'error' && endRow(events).why === LEAK_SAID,
		JSON.stringify(endRow(events)));
}

// ── (g) classed by structure, never by a source line number ─────────
// Every engine error carries `src/…:NNN:` positions, and a bare-number test read a
// framed 400 at line 512 as a 5xx -- a passing failure -- so the parent was told to
// send a lasting one again (ZERO-ROUND run 4).
{
	const F400 = 'LLM: HTTP error: 400 Bad Request | invalid_request_error src/wasm/llm_fetch.rs:512: src/agent.rs:1921:';
	const F503 = 'LLM: HTTP error: 503 Service Unavailable | overloaded src/wasm/llm_fetch.rs:212: src/agent.rs:1921:';
	const { S } = harness(0);
	check('(g) a framed 400 is lasting', S.isPassingFailure(F400) === false, S.failureClass(F400));
	check('(g) a framed 503 is passing', S.isPassingFailure(F503) === true, S.failureClass(F503));
	check('(g) a number in a sentence about no status is no status',
		S.isPassingFailure('crystal write refused: 512 bytes over the 503-byte ceiling src/x.rs:500:') === false);
	// The engine's own class on its ending outranks the words.
	const h = harness(0, null, fakeEngine(0, F400, 'other'));
	await h.W.start(h.run);
	check('(g) a failed ending classed `other` is lasting', h.run.whyTransient === false,
		JSON.stringify(h.run.whyTransient));
	const OPAQUE = 'LLM: the provider failed src/llm.rs:12:';
	const s = harness(0, null, fakeEngine(0, OPAQUE, 'server_error'));
	await s.W.start(s.run);
	check('(g) a failed ending classed `server_error` is passing, whatever its words',
		s.run.whyTransient === true, JSON.stringify(s.run.whyTransient));
	// The HTTP layer's status, where it carries one, outranks the words too.
	const busy = Object.assign(new Error('The gateway is busy src/x.rs:400:'), { status: 503 });
	const k = harness(0, async () => { throw busy; });
	k.run.provider = 'credits';
	await k.W.start(k.run);
	check('(g) a gateway 503 is passing', k.run.whyTransient === true, JSON.stringify(k.run.whyTransient));
	const no = Object.assign(new Error('Refused src/x.rs:502:'), { status: 400 });
	check('(g) a status-400 error is lasting', S.isPassingFailure(no) === false, S.failureClass(no));
}

console.log(`workerfail: ${ok} passed, ${bad} failed`);
if (bad) process.exitCode = 1;
