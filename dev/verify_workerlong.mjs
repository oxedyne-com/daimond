// gateway: none
// U3a INT-C (UNBLOCK-16): a worker is held to its PROGRESS, not to a wall clock.
//
// Three arms, each a worker spawned from an ordinary chat, read back from `DaimondWorkers.runs`
// and from the debug feed, which is captured here with a timestamp on every row:
//
//   long   a worker on `@rounds 61/15000 file_list {}`, about 15.3 minutes of paced, live
//          rounds, at the default liveness limit, gathered by its chat (two gathers of 600 s).
//          It ends `done` after 61 rounds, billed, and never `timed_out`. Red at 2dd11547:
//          the page raced `run_turn` against `WORKER_WALL_CLOCK_MS` (540 s) and cut it there.
//   silent with the liveness limit at 3 s (`window.__livenessMs`), a worker whose model sends
//          nothing after its headers (`@hush 600000`) is asked once more and then ends
//          `timed_out`, between 6 s and 9 s after it started: one retry (`stall`, retried),
//          the model asked twice. (Not `@slow`: the wait for headers is held outside the
//          liveness race, see `ReplyHold`, so a provider that has not answered is not silence.)
//   stall  the same limit, a stream that sends one chunk and then nothing (`@stall 600000`).
//          A round that has said something is never asked again (`Agent::stalled_live`: the
//          page would show the text twice), so it ends `timed_out` at the first expiry,
//          between 3 s and 6 s, with exactly one `stall` event and that one not retried.
//
// The engine's `stall` events reach no feed row, so they are counted by wrapping
// `DaimondLedger.meter`, which every sink feeds each event (`wmeter.see`). Test-only.
//
//   node dev/verify_workerlong.mjs                 # all three (about 16 minutes)
//   WL_ONLY=stall node dev/verify_workerlong.mjs   # one of them
import { open, newChat, mockLog, clearMockLog } from './harness.mjs';
import { armFilter, guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const want = armFilter('WL_ONLY');
const TERMINAL = ['done', 'error', 'stopped', 'interrupted', 'capped', 'spend_cap', 'blocked',
	'timed_out', 'paused'];

/// Opens a page, sets the liveness limit (0: the default), starts one worker named `name` on
/// `task`, and waits up to `waitMs` for it to end. Returns its run, its feed rows and timings.
async function oneWorker(label, name, task, liveMs, waitMs, then = '') {
	const s = await open({ name: 'workerlong-' + label });
	const { page } = s;
	await page.evaluate((ms) => {
		if (ms > 0) window.__livenessMs = ms;
		window.__ds = [];
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload, t: Date.now() }) };
		window.__stalls = [];
		const L = window.DaimondLedger, real = L && L.meter;
		if (real) L.meter = function () {
			const m = real.apply(this, arguments), see = m.see;
			m.see = function (ev) {
				if (ev && ev.type === 'stall') window.__stalls.push({ retried: !!ev.retried, t: Date.now() });
				return see.apply(this, arguments);
			};
			return m;
		};
	}, liveMs);
	await newChat(s);
	clearMockLog();
	await page.fill('#chat-input', (then ? '@seq' : '@tools') + ' spawn_agent '
		+ JSON.stringify({ name, task }) + then);
	await page.keyboard.press('Enter');
	const t0 = Date.now();
	let run = null, lastLog = 0;
	while (Date.now() - t0 < waitMs) {
		run = await page.evaluate((n) => {
			const r = (window.DaimondWorkers ? window.DaimondWorkers.runs : []).find((x) => x.name === n);
			return r ? { id: String(r.id), status: r.status, ended: r.ended || null } : null;
		}, name);
		if (run && TERMINAL.includes(run.status)) break;
		if (Date.now() - lastLog > 60000) {
			lastLog = Date.now();
			console.log(`  ..   ${label}: ${Math.round((Date.now() - t0) / 1000)} s, ${run ? run.status : 'not started'}`);
		}
		await page.waitForTimeout(run ? 500 : 100);
	}
	const ds = await page.evaluate(() => window.__ds || []);
	const mine = run ? ds.filter((r) => r.payload && r.payload.w === run.id) : [];
	const start = mine.find((r) => r.kind === 'worker' && r.payload.at === 'start');
	const end = mine.find((r) => r.kind === 'worker' && r.payload.at === 'end');
	const stalls = await page.evaluate(() => window.__stalls || []);
	const asked = mockLog().filter((m) => (m.messages || []).some((x) => x.role === 'user'
		&& typeof x.content === 'string' && x.content.includes(task.split(' @usage')[0]) && !x.content.includes('spawn_agent'))).length;
	await s.close();
	return { run, mine, start, end, stalls, asked, took: start && end ? end.t - start.t : -1 };
}

// ── long: 61 live rounds over 15 minutes end done ───────────────────────────
if (want('long')) {
	// Waited for, as a worker that long always is: a worker no turn waits on is held to
	// `ORPHAN_GRACE_ROUNDS` and ends `capped`. One gather waits at most `GATHER_TIMEOUT_S`
	// (600 s), so the chat gathers twice, the second after the first has come back.
	const gather = ' ;; gather {"names":["long"],"timeout_s":600}';
	const w = await oneWorker('long', 'long', '@rounds 61/15000 file_list {} @usage 100 50 0.01', 0,
		25 * 60 * 1000, gather + gather);
	const { run, end } = w;
	check('LONG. a worker on 61 rounds of 15 s ends done', run && run.status === 'done',
		run ? `${run.status} after ${Math.round(w.took / 1000)} s` : 'never started');
	check('LONG. and it ran past the old 540 s wall clock', w.took > 600000, `${w.took} ms`);
	check('LONG. and it ran all 61 rounds', !!(run && run.ended && run.ended.calls === 61),
		JSON.stringify(run && run.ended ? { rounds: run.ended.rounds, calls: run.ended.calls } : null));
	check('LONG. and it was billed', !!(end && (end.payload.usd > 0 || end.payload.p > 0)),
		end ? JSON.stringify({ p: end.payload.p, c: end.payload.c, usd: end.payload.usd }) : 'no end row');
	check('LONG. and it was never timed out',
		!!run && run.status !== 'timed_out' && !(run.ended && run.ended.why === 'timed_out')
			&& !w.mine.some((r) => r.kind === 'stalled'),
		run && run.ended ? `${run.ended.how}/${run.ended.why}` : '');
}

// ── silent / stall: a quiet model at N = 3 s ends timed_out ──────────────
const quiet = async (label, task, lo, hi, retries, asks) => {
	const w = await oneWorker(label, 'quiet', task, 3000, 60 * 1000);
	const { run } = w;
	const L = label.toUpperCase();
	check(`${L}. ${task} at N = 3 s ends timed_out`, !!run && run.status === 'timed_out',
		run ? `${run.status}${run.ended ? ` (${run.ended.how}/${run.ended.why})` : ''}` : 'never started');
	check(`${L}. between ${lo / 1000} s and ${hi / 1000} s after it started`, w.took >= lo && w.took < hi,
		`${w.took} ms`);
	check(`${L}. with ${retries ? 'one retry' : 'exactly one stall event, not retried'}`,
		retries ? w.stalls.filter((x) => x.retried).length === 1
			: w.stalls.length === 1 && !w.stalls[0].retried, JSON.stringify(w.stalls));
	check(`${L}. and the model was asked ${asks === 1 ? 'once' : 'twice'}`, w.asked === asks, `${w.asked}`);
	check(`${L}. and no stalled round_meta row (the round never finished)`,
		!w.mine.some((r) => r.kind === 'stalled'), '');
};
if (want('silent')) await quiet('silent', '@hush 600000', 6000, 9000, true, 2);
if (want('stall')) await quiet('stall', '@stall 600000', 3000, 6000, false, 1);

guardRan(ok.length + bad.length, want);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
