/* ============================================================
   Test -- r578c T: a worker's turn has no page wall clock, and a stopped
   worker is billed and reported from its settled turn.
   ------------------------------------------------------------
   33 of 70 workers (8-18 Oct) were killed by the page's 540 s race on
   `run_turn` while they worked. The cleanup then ran under the live turn:
   the bill read 0, the report became "stopped after 540s, no result", the
   rounds read 0 and the session export failed.

   This drives the REAL `Workers.start` and `Workers.stop`, sliced out of
   daimond.js and run under a `with` scope that supplies a fake engine and a
   fake clock, so the assertions bite on behaviour rather than on spelling.

   Run:  node www/js/workertimer.test.mjs
         WT_SRC=/path/to/old/daimond.js node www/js/workertimer.test.mjs  # red run
   ============================================================ */
import { readFileSync } from 'node:fs';

const SRC = readFileSync(process.env.WT_SRC || new URL('./daimond.js', import.meta.url), 'utf8');

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

// ── The fake clock: the page's `setTimeout`, advanced by hand ─────────
function fakeClock() {
	let now = 0;
	const timers = [];
	return {
		setTimeout(fn, ms) { timers.push({ at: now + (Number(ms) || 0), fn }); return timers.length; },
		advance(ms) {
			now += ms;
			for (const t of timers.splice(0)) {
				if (t.at <= now) t.fn(); else timers.push(t);
			}
		},
	};
}

// ── The fake engine ───────────────────────────────────────────────────
//
// Each round bills on its start, as a provider call does, and the session's
// counters read zero while a turn holds it -- the `try_borrow` the real getters
// fail on. `after(k, app)` is the test's hook at the round's midpoint.
const ROUND = { p: 100, c: 10, ca: 5, cost: 0.01 };
function fakeEngine(rounds, after) {
	return class FakeApp {
		constructor() {
			this.turn_held = false; this.aborted = false;
			this._p = 0; this._c = 0; this._ca = 0; this._cost = 0;
		}
		get prompt_tokens()     { return this.turn_held ? 0 : this._p; }
		get completion_tokens() { return this.turn_held ? 0 : this._c; }
		get cached_tokens()     { return this.turn_held ? 0 : this._ca; }
		get cost_usd()          { return this.turn_held ? 0 : this._cost; }
		export_session() {
			if (this.turn_held) throw new Error('session held by a turn');
			return [{ role: 'user', content: 'task' }];
		}
		abort() { this.aborted = true; }
		async run_turn(task, sink) {
			this.turn_held = true;
			try {
				for (let k = 1; k <= rounds; k++) {
					this._p += ROUND.p; this._c += ROUND.c; this._ca += ROUND.ca; this._cost += ROUND.cost;
					sink({ type: 'round_meta', gen: 'g' + k });
					const last = k === rounds;
					sink({ type: 'text', content: last ? 'FINAL WORDS' : 'words of round ' + k });
					await after(k, this);
					// An abort lands at the next seam, and the turn settles a moment later.
					if (this.aborted) {
						await realDelay(20);
						sink({ type: 'ended', how: 'stopped', rounds: k, calls: k - 1 });
						return;
					}
					if (last) {
						sink({ type: 'ended', how: 'answered', rounds: k, calls: k - 1 });
						return;
					}
					sink({ type: 'tool_call', name: 'file_write', args: '{}' });
					sink({ type: 'tool_result', outcome: 'done', content: 'ok' });
				}
			} finally {
				this.turn_held = false;
			}
		}
	};
}

// ── The harness: the real `start` and `stop` over the fakes ───────────
function harness(rounds, after) {
	const clock = fakeClock();
	const events = [], spends = [];
	const S = {
		window:         {},
		chats:          [],
		DaimondModels:  { held: () => false, CREDITS: 'credits' },
		DaimondApp:     fakeEngine(rounds, after),
		Sbj:            { worker_wall_clock_ms: () => 540000 },	// the old page reads it
		setTimeout:     clock.setTimeout,
		clearTimeout:   () => {},
		dsEvent:        (kind, row) => events.push({ kind, row }),
		recordSpend:    (model, p, c, ca, cost) => spends.push({ p, c, ca, cost }),
		friendlyError:  (e) => String(e && e.message || e),
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
		'workerWrites', 'workerWroteClause']) {
		const src = lift(n);
		if (src) S[n] = new Function('S', 'with (S) { return (' + src + '); }')(scope);
	}
	const mk = (head) => new Function('S', 'with (S) { return (' + method(head) + '); }')(scope);
	const W = {
		active: 0, gathered: 0, settled: 0,
		render() {}, touch() {}, nodeOf() { return 'node'; }, persist() {}, pump() {},
		settleAwaits() { this.settled++; }, gather() { this.gathered++; },
		giveSlot() {}, takeSlot() { return 1; }, unseeable() {},
	};
	W.start = mk('start: async function (run) {');
	W.stop  = mk('stop: function (run) {');
	const run = { id: 'w1', name: 'w', task: 'do the task', model: 'm', provider: 'p',
		diamondId: 'D1', turnId: 't1', text: '', tools: [], said: [], batch: 'b1' };
	return { W, run, clock, events, spends, S };
}

const endRow = (events) => (events.find((e) => e.kind === 'worker' && e.row.at === 'end') || {}).row || {};

// ── (a) a worker past 540 s is not killed ─────────────────────────────
{
	let h;
	h = harness(3, async (k) => {
		if (k === 2) { h.clock.advance(600 * 1000); await realDelay(5); }
	});
	await h.W.start(h.run);
	const { run, spends, events } = h;
	check('(a) a worker 600 s in is not aborted', run.app && run.app.aborted === false);
	check('(a) it ends done, not capped', run.status === 'done', run.status);
	check('(a) its report is its own final words', run.report === 'FINAL WORDS', JSON.stringify(run.report));
	check('(a) it is billed once', spends.length === 1, spends.length);
	check('(a) the bill is its three rounds', spends[0] && spends[0].p === 300
		&& Math.abs(spends[0].cost - 0.03) < 1e-9, JSON.stringify(spends));
	check('(a) the end row carries 3 rounds, engine and page', endRow(events).r === 3 && endRow(events).wr === 3,
		JSON.stringify(endRow(events)));
}

// ── (b) a stop mid-round waits for the turn to settle ─────────────────
{
	let h;
	h = harness(5, async (k) => { if (k === 3) h.W.stop(h.run); });
	await h.W.start(h.run);
	const { run, spends, events } = h;
	check('(b) the stopped worker stays stopped', run.status === 'stopped', run.status);
	check('(b) billed once', spends.length === 1, spends.length);
	check('(b) the bill is the three rounds it ran', spends[0] && spends[0].p === 300
		&& spends[0].c === 30 && Math.abs(spends[0].cost - 0.03) < 1e-9, JSON.stringify(spends));
	check('(b) run cost equals the bill', Math.abs((run.costUsd || 0) - 0.03) < 1e-9, run.costUsd);
	check('(b) the engine\'s rounds are the rounds run', run.ended && run.ended.rounds === 3,
		JSON.stringify(run.ended));
	check('(b) the end row says 3 rounds, engine and page',
		endRow(events).r === 3 && endRow(events).wr === 3, JSON.stringify(endRow(events)));
	check('(b) the end row bills the real spend', endRow(events).p === 300, endRow(events).p);
	check('(b) the report is its words, then the stop reason',
		run.report === 'words of round 3\n\n(stopped: the person pressed Stop)', JSON.stringify(run.report));
	check('(b) the session is exported', Array.isArray(run._session) && run._session.length === 1,
		JSON.stringify(run._session));
}

// ── (c) the gather text for a stopped worker is true ──────────────────
{
	const { S } = harness(1, async () => {});
	const note = S.workerEndingNote({ status: 'stopped', costUsd: 0.02,
		ended: { how: 'stopped', rounds: 2, calls: 1 },
		tools: [{ name: 'file_write', status: 'done' }] });
	check('(c) a stopped worker\'s note states rounds, spend and writes',
		note.includes('stopped after 2 rounds, US$0.0200, 1 file write'), JSON.stringify(note));
	check('(c) never "0 rounds, US$0.0000" for a worker that ran',
		!note.includes('0 rounds, US$0.0000'), JSON.stringify(note));
}

// ── (d) a held app's spend is not read ────────────────────────────────
{
	const { S } = harness(1, async () => {});
	check('(d) appSpend of a held app is null',
		S.appSpend({ turn_held: true, prompt_tokens: 0, cost_usd: 0 }) === null);
	const s = S.appSpend({ turn_held: false, prompt_tokens: 7, completion_tokens: 2, cached_tokens: 1, cost_usd: 0.5 });
	check('(d) appSpend of a settled app reads its counters', s && s.p === 7 && s.cost === 0.5, JSON.stringify(s));
}

console.log(`workertimer: ${ok} passed, ${bad} failed`);
if (bad) process.exitCode = 1;
