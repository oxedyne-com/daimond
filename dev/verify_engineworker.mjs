// gateway: none
// verify_engineworker.mjs -- the starvation probe: does a big daimon turn starve the page?
// (U5 of the engine-worker design, specs/daimond_engine_worker_design_20261011.md §7.2.)
//
// The engine runs on the page's main thread, so a turn with workers searching a large granted
// folder holds the thread the page needs to paint, take a press and answer the devtools. On
// the owner's machine that is the tab that will not take Stop. This drives exactly that load
// and measures what the page could still do while it ran:
//
//   - the folder: a stand-in grant of ~40,000 files none of which is ignored
//     (`dev/engineworker_fixture.mjs`), so the FIRE fixes to the walk do not make it go away;
//   - the turn: the main daimon `spawn_agent`s six workers, each streaming prose and running
//     `file_search` over the whole root round after round (the mock's `@grind`), and searches
//     the root itself;
//   - the window: WINDOW_S seconds of that, then Stop.
//
// Measured in the window, with the thresholds of §7.2:
//   L1 longest long task < 200 ms               L2 main-thread busy fraction < 50% (trace)
//   L3 input-to-handler delay p99 < 100 ms      L4 event-loop lag p99 < 100 ms
//   L5 requestAnimationFrame advances in every 5 s slice
//   L6 CDP Runtime.evaluate answers in < 1 s    L7 lens beats keep their 30 s cadence within 5 s
//   S1 Stop: the page marks the turn stopped within 100 ms of the press
//   S2 Stop: the engine ends the turn within 1 s
//   W1 the .wasm is fetched by the worker only (the page's own resource timing never lists it)
// RED on today's build (the engine is on the page), and on `?engine=page` once the worker
// exists; GREEN on the worker, same build.
//
// `--profile` also records one Chrome Performance profile of the window -- CDP Profiler samples
// plus a CDP trace, in this probe's own headless browser -- and prints the G1 split of the
// main thread's busy time: the engine (wasm and the JS glue it runs through, which is where
// `getFile` and the chunk reads are called from), page handlers (the app's own JS, including
// what the engine calls back into), GC, and native work (style, layout, paint, parsing). The
// raw `.cpuprofile` and trace land in the scratch root for DevTools. The busy denominator is the
// trace's: the union of every event on the page renderer's CrRendererMain, over the part of the
// window the trace actually covers (a full trace buffer stops recording early, and the coverage
// is checked). The profile's `(program)` is not used as busy time.
//
// `--reanalyse <run dir>` re-runs L2 and the G1 split on a saved run's meta.json, cpuprofile and
// trace, with no world and no browser.
//
// Not built here: the hidden-tab arm (judged by the engine's own beat, which only exists once
// the engine is in a worker) and sync under load (a world has no gateway); both arrive with U6.
//
//   bash dev/world.sh N --up ; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_engineworker.mjs [--profile] [--engine page|worker] [--window 90] [--workers 6]
//   node dev/verify_engineworker.mjs --reanalyse <run dir>
import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { open, newChat, chat, scratch, mockLog, clearMockLog, standInFolders } from './harness.mjs';
import { FIXTURE, seedFixture } from './engineworker_fixture.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const PROFILE  = process.argv.includes('--profile');
const ENGINE   = arg('--engine', '');
const WINDOW_S = Number(arg('--window', '120'));
const WORKERS  = Number(arg('--workers', '6'));
const REDO     = arg('--reanalyse', '');
const r0   = (x) => Math.round(x);
if (REDO) {
	const meta = JSON.parse(fs.readFileSync(REDO + '/meta.json', 'utf8'));
	const prof = JSON.parse(fs.readFileSync(REDO + '/window.cpuprofile', 'utf8'));
	const a = analyse(prof, REDO + '/window.trace.json', meta.tSend, meta.tStop, meta.profWall);
	const fails = g1Report(a, meta.dataLoss);
	fs.writeFileSync(REDO + '/g1r.json', JSON.stringify(a, null, 1));
	console.log(`\nreanalysed: ${REDO}/g1r.json` + (fails.length ? '; FAIL ' + fails.join('; ') : ''));
	process.exit(fails.length ? 1 : 0);
}
const OUT      = scratch('engwork', 'run-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(OUT, { recursive: true });

const bad = [];
const check = (name, pass, detail) => {
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
	if (!pass) bad.push(name);
};
const pct  = (xs, q) => { if (!xs.length) return NaN; const a = [...xs].sort((x, y) => x - y);
	return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };

const s = await open({ name: 'engwork', profile: scratch('pw', 'engwork-' + process.pid) });
const { page } = s;
if (ENGINE) {
	const u = new URL(page.url());
	u.searchParams.set('engine', ENGINE);
	await page.goto(u.toString());
	await page.waitForFunction(() => !!window.DaimondFiles, null, { timeout: 60000 });
}

// ── The folder ─────────────────────────────────────────────────────────────────
const { pick } = await standInFolders(s, { tag: 'engwork', which: ['a'] });
const shape = await seedFixture(page, { tag: 'engwork', name: 'usr' });
console.log(`fixture: ${shape.files} files (${shape.needles} carry the needle), written in ${shape.ms} ms`);
const picked = await pick('a');
await newChat(s);
// The fixture is checked before anything is concluded from it: the chat's own file_list has to
// see the tree, or every number below is the cost of searching nothing.
clearMockLog();
await chat(s, '@tool file_list {"path":"."}', { timeout: 60000 });
const sees = mockLog().some((m) => (m.messages || []).some((x) => x.role === 'tool'
	&& typeof x.content === 'string' && x.content.includes('top-00')));
check('F1 the chat sees the granted fixture folder', picked.landed && sees,
	`picked=${picked.how}/${picked.landed}, file_list names top-00: ${sees}`);
if (!sees) {
	console.error('the turn would search a folder without the fixture in it; this run proves nothing.');
	await s.close();
	process.exit(2);
}

// ── Instruments, in the page ───────────────────────────────────────────────────
const send = await page.locator('#chat-send').boundingBox();
// ONE CLOCK (rc-b, 26 Oct): every time the page records is on its native timeline, the one its events' timeStamp and
// its long-task entries carry, read with `nnow()`. harness open() pins the page's Date and performance.now() at the run
// clock (Playwright's page.clock.install), which the native timeline is not, so a press timed by node's Date.now() and a
// flip by the page's Date.now() were two clocks; so was performance.timeOrigin + a long task's startTime. The window is
// the two presses as the page saw them (W.press: Send, then Stop); node times only its own work, with performance.now().
await page.evaluate(async () => {
	const nnow = () => new Event('t').timeStamp;	// the native high-resolution now (the pinned clock fakes performance.now)
	const W = window.__ew = { lt: [], lag: [], raf: 0, inp: [], flips: [], turns: [], outMut: [], press: [],
		base: { d: Date.now(), n: nnow() } };	// base: the page's Date against its native now, for the lens beats' Date stamps
	window.addEventListener('mousedown', (e) => W.press.push(e.timeStamp), true);
	new PerformanceObserver((l) => { for (const e of l.getEntries()) W.lt.push([e.startTime, e.duration]); })
		.observe({ type: 'longtask' });
	let due = performance.now() + 50;
	setInterval(() => { const n = performance.now(); W.lag.push(Math.max(0, n - due)); due = n + 50; }, 50);
	const tick = () => { W.raf++; requestAnimationFrame(tick); };
	requestAnimationFrame(tick);
	document.addEventListener('pointermove', (e) => W.inp.push(nnow() - e.timeStamp), true);
	const b = document.getElementById('chat-send');
	const busy = () => /stop/i.test((b.getAttribute('title') || '') + (b.className || '')) || b.disabled;
	let was = busy();
	new MutationObserver(() => { const n = busy(); if (n !== was) { was = n; W.flips.push([nnow(), n]); } })
		.observe(b, { attributes: true, childList: true, subtree: true });
	// SA: when the button first says "Stopping…", and the frame after that against the
	// handler's own start (the click's capture phase), all on the native timeline.
	W.sa = { click: 0, clickTs: 0, label: 0, raf: 0, f0: 0, f1: 0 };	// f0/f1: frame counts
	// The last press before the label is the Stop; the Send press came first.
	window.addEventListener('click', (e) => {
		if (!W.sa.label && b.contains(e.target)) { W.sa.click = nnow(); W.sa.clickTs = e.timeStamp; W.sa.f0 = W.raf; }
	}, true);
	new MutationObserver(() => {
		if (W.sa.label || !/^Stopping/.test(b.getAttribute('aria-label') || '')) return;
		W.sa.label = nnow();
		requestAnimationFrame(() => { W.sa.raf = nnow(); W.sa.f1 = W.raf; });
	}).observe(b, { attributes: true });
	new MutationObserver((ms) => { W.outMut.push([nnow(), ms.length]); })
		.observe(document.getElementById('chat-output'), { childList: true, subtree: true, characterData: true });
	// The engine's own end of a turn: a `run_turn` settling, timed on every instance.
	const mod = await import('/pkg/oxedyne_daimond.js');
	const P = mod.DaimondApp.prototype;
	const real = P.run_turn;
	P.run_turn = function (...a) {
		const rec = { t0: nnow(), t1: 0 };
		W.turns.push(rec);
		const r = real.apply(this, a);
		Promise.resolve(r).finally(() => { rec.t1 = nnow(); }).catch(() => {});
		return r;
	};
	window.DEBUG_SHARE.setEnabled(true);
});

// ── Profile ───────────────────────────────────────────────────────────────────
const cdp = await page.context().newCDPSession(page);
let profWall = 0;					// node's performance.now() at Profiler.start (the window's bounds are on it too)
if (PROFILE) {
	await cdp.send('Profiler.enable');
	await cdp.send('Profiler.setSamplingInterval', { interval: 250 });
	await cdp.send('Profiler.start');
	profWall = performance.now();
	// `toplevel` across every process filled the default buffer in 29 s of a 120 s window
	// (11 Oct), so ask for the largest preset; the analysis checks the coverage either way.
	await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: {
		recordMode: 'recordAsMuchAsPossible',
		includedCategories: ['toplevel', 'devtools.timeline'], excludedCategories: ['*'] } });
}

// ── The turn ──────────────────────────────────────────────────────────────────
const SEARCH = JSON.stringify({ query: FIXTURE.needle, path: '.', fixed: true, limit: 1000 });
const task = `@grind 200/40/25 file_search ${SEARCH}`;
const spawns = Array.from({ length: WORKERS }, (_, i) =>
	`spawn_agent ${JSON.stringify({ name: 'grind' + (i + 1), task })}`);
clearMockLog();
await page.fill('#chat-input', '@tools ' + spawns.concat(['file_search ' + SEARCH]).join(' ;; '));
const tSend = performance.now();			// node's own clock: the probe's loop and the profile's window
await page.click('#chat-send', { force: true });

const evalMs = [], ackMs = [], rafAt = [];
let anims = null;
const tEnd = tSend + WINDOW_S * 1000;
let lastRaf = -1;
while (performance.now() < tEnd) {
	const a = performance.now();
	await cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true });
	evalMs.push(performance.now() - a);
	const b = performance.now();
	await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10 + (evalMs.length % 50), y: 10 });
	ackMs.push(performance.now() - b);
	if (!anims && performance.now() - tSend > WINDOW_S * 500) {
		// What is animating half-way through: a running animation repaints every frame.
		anims = (await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `document.getAnimations()
			.filter((a) => a.playState === 'running').map((a) => { const t = a.effect && a.effect.target;
				return (a.animationName || a.constructor.name) + ' on ' + (t ? t.tagName.toLowerCase()
					+ (t.id ? '#' + t.id : '') + (t.className && typeof t.className === 'string'
					? '.' + t.className.trim().split(/\\s+/).join('.') : '') : '?'); })` })).result.value;
	}
	if (performance.now() - (rafAt.length ? rafAt[rafAt.length - 1][0] : tSend) >= 5000) {
		const n = (await cdp.send('Runtime.evaluate', { expression: '__ew.raf', returnByValue: true })).result.value;
		rafAt.push([performance.now(), n - lastRaf]);
		lastRaf = n;
	}
	const spare = 1000 - (performance.now() - a);
	if (spare > 0) await new Promise((r) => setTimeout(r, spare));
}

// ── Stop ──────────────────────────────────────────────────────────────────────
const stillBusy = (await cdp.send('Runtime.evaluate', { returnByValue: true,
	expression: `(() => { const b = document.getElementById('chat-send');
		return /stop/i.test((b.getAttribute('title') || '') + (b.className || '')) || b.disabled; })()` })).result.value;
const tStop = performance.now();
await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: send.x + send.width / 2,
	y: send.y + send.height / 2, button: 'left', clickCount: 1 });
await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: send.x + send.width / 2,
	y: send.y + send.height / 2, button: 'left', clickCount: 1 });
await page.waitForTimeout(8000);

let prof = null, traceFile = null, dataLoss = false;
if (PROFILE) {
	prof = (await cdp.send('Profiler.stop')).profile;
	fs.writeFileSync(OUT + '/window.cpuprofile', JSON.stringify(prof));
	const done = new Promise((r) => cdp.once('Tracing.tracingComplete', r));
	await cdp.send('Tracing.end');
	const { stream, dataLossOccurred } = await done;
	dataLoss = !!dataLossOccurred;
	traceFile = OUT + '/window.trace.json';
	const fd = fs.openSync(traceFile, 'w');
	for (;;) {
		const { data, eof, base64Encoded } = await cdp.send('IO.read', { handle: stream, size: 1 << 20 });
		fs.writeSync(fd, base64Encoded ? Buffer.from(data, 'base64') : data);
		if (eof) break;
	}
	fs.closeSync(fd);
	await cdp.send('IO.close', { handle: stream });
	fs.writeFileSync(OUT + '/meta.json', JSON.stringify({ tSend, tStop, profWall, dataLoss }));
}

const W = await page.evaluate(() => {
	const W = window.__ew;
	// A beat is stamped with the page's Date: onto the native timeline through the one base pair, so it meets the presses.
	const beats = window.DEBUG_SHARE._outbox().filter((r) => r.tag === 'ev beat').map((r) => [r.ts - W.base.d + W.base.n, r.data]);
	const wasmByPage = performance.getEntriesByType('resource').filter((e) => /\.wasm(\?|$)/.test(e.name)).map((e) => e.name);
	return { lt: W.lt, lag: W.lag, inp: W.inp, flips: W.flips, turns: W.turns, outMut: W.outMut, sa: W.sa, press: W.press,
		beats, wasmByPage };
});
const calls = mockLog().length;
await s.close();

// ── Results ───────────────────────────────────────────────────────────────────
// The window on the page's timeline: from the Send press to the Stop press, as its mousedown events stamped them.
if (W.press.length < 2) { console.error(`the page saw ${W.press.length} press(es), not Send and Stop; this run proves nothing.`); process.exit(2); }
const pSend = W.press[0], pStop = W.press[W.press.length - 1];
const inWin = (t) => t >= pSend && t <= pStop;
const lts = W.lt.filter(([t]) => inWin(t));
const ltMax = lts.reduce((m, [, d]) => Math.max(m, d), 0);
const ltSum = lts.reduce((m, [, d]) => m + d, 0);
console.log(`\nwindow ${r0((pStop - pSend) / 1000)} s, ${WORKERS} workers, ${calls} provider calls; `
	+ `turn still running at Stop: ${stillBusy}`);
check('L1 the longest long task is under 200 ms', ltMax < 200,
	`max ${r0(ltMax)} ms, ${lts.length} long tasks, ${r0(ltSum)} ms in them (${r0(100 * ltSum / (pStop - pSend))}% of the window)`);

let g1 = null;
if (PROFILE) {
	g1 = analyse(prof, traceFile, tSend, tStop, profWall);
} else {
	console.log('  --   L2 busy fraction needs --profile (the trace); long-task share above stands in');
}
const lag99 = pct(W.lag, 0.99), inp99 = pct(W.inp, 0.99);
check('L3 input-to-handler delay p99 is under 100 ms', inp99 < 100,
	`p99 ${r0(inp99)} ms, max ${r0(Math.max(0, ...W.inp))} ms over ${W.inp.length} moves; CDP input ack p99 ${r0(pct(ackMs, 0.99))} ms, max ${Math.max(...ackMs)} ms`);
check('L4 event-loop lag p99 is under 100 ms', lag99 < 100, `p99 ${r0(lag99)} ms, max ${r0(Math.max(...W.lag))} ms`);
const stalls = rafAt.filter(([, d]) => d < 1).length;
check('L5 requestAnimationFrame advances in every 5 s slice', stalls === 0,
	`frames per slice: ${rafAt.map(([, d]) => d).join(',')}`);
check('L6 CDP Runtime.evaluate answers in under 1 s', Math.max(...evalMs) < 1000,
	`p50 ${r0(pct(evalMs, 0.5))} ms, p99 ${r0(pct(evalMs, 0.99))} ms, max ${Math.max(...evalMs)} ms, ${evalMs.filter((x) => x >= 1000).length} over 1 s of ${evalMs.length}`);
const bt = W.beats.map(([ts]) => ts).filter(inWin);
const gaps = bt.slice(1).map((t, i) => t - bt[i]);
check('L7 lens beats keep their 30 s cadence within 5 s', bt.length >= 2 && gaps.every((g) => g <= 35000),
	`${bt.length} beats, gaps ${gaps.map((g) => r0(g / 1000) + 's').join(',')}; `
	+ `lag/ltmax per beat ${W.beats.map(([, d]) => { try { const b = JSON.parse(d); return b.lag + '/' + b.ltmax; } catch (e) { return '?'; } }).join(',')}`);
const flip = W.flips.find(([t, busy]) => t >= pStop && !busy);
const mainTurn = W.turns.find((t) => t.t0 >= pSend - 50);
check('S1 the page marks the turn stopped within 100 ms of the press', !!flip && flip[0] - pStop <= 100,
	flip ? `${r0(flip[0] - pStop)} ms` : 'never within 8 s');
check('S2 the engine ends the turn within 1 s', !!(mainTurn && mainTurn.t1) && mainTurn.t1 - pStop <= 1000,
	mainTurn ? (mainTurn.t1 ? `${r0(mainTurn.t1 - pStop)} ms` : 'not ended within 8 s') : 'no run_turn seen');
// SA: the acknowledgement, which the engine on the page can delay only by the task the press lands in.
const sa = W.sa, pressPerf = pStop;
const saOver = W.lt.filter(([t, d]) => t <= (sa.clickTs || pressPerf) + 1 && t + d >= pressPerf);
check('SA press-to-visible: the button says "Stopping…" within 200 ms of the press', stillBusy && !!sa.label && sa.label - pStop < 200,
	!stillBusy ? 'no turn was running at the press (shorten --window)' : sa.label ? `${r0(sa.label - pStop)} ms; long task over the press: ${saOver.length ? saOver.map(([t, d]) => r0(d) + ' ms').join(',') : 'none'}`
		: 'never within 8 s');
check('SA handler-to-visible: the label is up by the frame after the handler (<= 1 frame)', !!sa.raf && sa.f1 - sa.f0 <= 1,
	sa.raf ? `handler->label ${r0(sa.label - sa.click)} ms, handler->frame ${r0(sa.raf - sa.click)} ms (${sa.f1 - sa.f0} frame(s)), `
		+ `event->handler ${r0(sa.click - sa.clickTs)} ms` : 'no frame after the label');
const late = flip ? W.outMut.filter(([t]) => t > flip[0] + 100).reduce((m, [, n]) => m + n, 0) : NaN;
console.log(`  --   Send/Stop flips after the send: ${W.flips.map(([t, b]) => (b ? 'busy' : 'idle') + '@' + r0((t - pSend) / 1000) + 's').join(' ')}`);
console.log(`  --   run_turn calls: ${W.turns.map((t) => r0((t.t0 - pSend) / 1000) + 's->' + (t.t1 ? r0((t.t1 - pSend) / 1000) + 's' : 'open')).join(' ')}`);
console.log(`  --   running animations mid-window: ${(anims || []).length} ${JSON.stringify((anims || []).slice(0, 12))}`);
console.log(`  --   after the stop mark the chat's DOM took ${late} further mutation(s)`);
check('W1 the .wasm is fetched by the worker only', W.wasmByPage.length === 0,
	W.wasmByPage.length ? 'the page fetched ' + W.wasmByPage.join(', ') : 'not by the page');

if (g1) {
	bad.push(...g1Report(g1, dataLoss));
	fs.writeFileSync(OUT + '/g1.json', JSON.stringify({ ...g1, anims, ltMax, ltSum, lag99, inp99,
		evalMs, ackMs, windowWall: [tSend, tStop] }, null, 1));
}
console.log(`\nartefacts: ${OUT}`);
console.log('VERDICT: ' + (bad.length === 0 ? 'the page stays responsive under a big turn'
	: 'STARVED — ' + bad.join('; ')));
process.exit(bad.length ? 1 : 0);

/// Prints L2 and the G1 split of `analyse`'s result; gives back the names of the checks that failed.
function g1Report(a, dataLoss) {
	const fails = [];
	const say = (name, pass, detail) => {
		console.log((pass ? '  ok   ' : '  FAIL ') + name + ' — ' + detail);
		if (!pass) fails.push(name);
	};
	if (!a.main) { say('L2 the trace has the page\'s main thread', false, 'no CrRendererMain with events'); return fails; }
	const c = a.cov, w = a.window;
	say('L2 the trace covers the window', c.span >= 0.95 * w.span,
		`${r0(c.span / 1000)} s of ${r0(w.span / 1000)} s (${r0(100 * c.span / w.span)}%)`
		+ (dataLoss ? ', Chrome reports data loss' : '') + `; main thread ${a.main} of ${a.mains.join(', ')}`);
	say('L2 the main thread is busy under 50% of the window', a.busyFrac < 0.5,
		`${r0(100 * a.busyFrac)}% (${r0(c.busy)} ms of ${r0(c.span)} ms covered; union of every main-thread event)`);
	// The three-way split: JS from the profile's samples, and the rest of the trace's busy time,
	// over the same covered span.
	const p = (x) => (100 * x / c.busy).toFixed(1) + '%';
	console.log(`\nG1 split of main-thread busy time over the covered ${r0(c.span / 1000)} s (${r0(c.busy)} ms busy, trace):`);
	console.log(`  engine (wasm + its JS glue/edges)  ${r0(c.engine)} ms  ${p(c.engine)}`);
	console.log(`  page handlers (app JS)             ${r0(c.page)} ms  ${p(c.page)}`
		+ `   of which called back from the engine ${r0(c.pageFromEngine)} ms`);
	console.log(`  rest (GC, paint, layout, mojo)     ${r0(c.rest)} ms  ${p(c.rest)}   of which GC ${r0(c.gc)} ms`);
	const js = c.engine + c.page;
	console.log(`  page handlers / JS = ${(100 * c.page / js).toFixed(1)}%; page handlers / busy = ${p(c.page)}  -> G1 verdict: `
		+ (c.page / c.busy > 0.2 ? 'ABOVE ~20%: S0b (U5b) ships before U6' : 'under ~20%: S0b not needed'));
	console.log(`  profile over the same span: (program) ${r0(c.program)} ms, (idle) ${r0(c.idle)} ms, `
		+ `non-idle ${r0(c.engine + c.page + c.gc + c.program)} ms against the trace's ${r0(c.busy)} ms busy`);
	const W = a.whole;
	console.log(`  profile, whole window ${r0(w.span / 1000)} s: engine ${r0(W.engine)} ms, page ${r0(W.page)} ms`
		+ ` (from engine ${r0(W.pageFromEngine)}), GC ${r0(W.gc)} ms, (program) ${r0(W.program)} ms, (idle) ${r0(W.idle)} ms;`
		+ ` page handlers / JS = ${(100 * W.page / (W.engine + W.page)).toFixed(1)}%`);
	for (const k of ['engine', 'page', 'pageFromEngine']) {
		console.log(`  top self time, ${k} (whole window):`);
		for (const [n, ms] of a.top[k].slice(0, 12)) console.log(`    ${String(r0(ms)).padStart(7)} ms  ${n}`);
	}
	console.log(`  trace top-level events by name, covered span (ms): ${a.traceTop.map(([n, ms]) => n + ' ' + r0(ms)).join(', ')}`);
	console.log(`  trace self time by name, covered span (ms): ${a.traceSelf.map(([n, ms]) => n + ' ' + r0(ms)).join(', ')}`);
	return fails;
}

/// L2 and the G1 split for the window [t0, t1] (wall ms). The busy time is the trace's: the
/// union of every complete event on the page renderer's CrRendererMain, clipped to the part of
/// the window the trace covers. The profile's samples split that time into the engine's JS,
/// the page's JS and GC; the rest of the busy time is native (paint, layout, mojo dispatch).
/// The profile's `(program)` is not busy time: it is every sample the thread was neither in JS
/// nor marked idle, and it runs well past what the trace shows the thread doing.
function analyse(prof, traceFile, t0, t1, startWall) {
	// Profile timestamps are microseconds on the trace's monotonic clock; the window is located
	// by node's clock through the profile's start (`startWall`, its performance.now() at Profiler.start).
	const w0 = prof.startTime + (t0 - startWall) * 1000, w1 = prof.startTime + (t1 - startWall) * 1000;
	const tr = readTrace(traceFile);
	// The page's main thread: the CrRendererMain that runs the most script (FunctionCall), which
	// is the app's renderer and not a spare renderer, the browser or a worker.
	const js = (k) => (tr.byThread.get(k) || []).reduce((m, e) => m + (e.name === 'FunctionCall' ? e.dur : 0), 0);
	const mains = tr.mains.filter((k) => tr.byThread.has(k)).sort((a, b) => js(b) - js(a));
	const out = { window: { w0, w1, span: (w1 - w0) / 1000 }, mains, main: mains[0] || null };
	if (!out.main) return out;
	const evs = tr.byThread.get(out.main).sort((a, b) => a.ts - b.ts || b.dur - a.dur);
	// Coverage: a full buffer stops every thread at once, so the trace's last timestamp ends it.
	const c0 = Math.max(w0, tr.first), c1 = Math.min(w1, tr.last);
	let busy = 0, end = -Infinity;
	const named = new Map();
	const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
	for (const e of evs) {
		const a = Math.max(e.ts, c0, end), b = Math.min(e.ts + e.dur, c1);
		if (b > a) busy += b - a;
		// Top level: not nested in an earlier event, so a name's time is counted once.
		if (e.ts >= end && e.ts >= c0 && e.ts < c1) add(named, e.name, e.dur / 1000);
		end = Math.max(end, e.ts + e.dur);
	}
	// Self time by name: each event less the events nested in it, so native work (paint, mojo
	// dispatch, the microtask checkpoint's own share) shows where the non-JS busy time goes.
	const self = new Map(), stack = [];
	for (const e of evs) {
		if (e.ts < c0 || e.ts >= c1) continue;
		while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) stack.pop();
		if (stack.length) add(self, stack[stack.length - 1].name, -e.dur / 1000);
		add(self, e.name, e.dur / 1000);
		stack.push(e);
	}
	const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
	out.traceTop = sorted(named).slice(0, 14);
	out.traceSelf = sorted(self).slice(0, 16);
	out.busyFrac = busy / (c1 - c0);
	const p = profileSplit(prof, w0, w1, c0, c1);
	out.whole = p.whole;
	out.top = p.top;
	const cv = p.cov;
	out.cov = { ...cv, c0, c1, span: (c1 - c0) / 1000, busy: busy / 1000 };
	out.cov.rest = out.cov.busy - cv.engine - cv.page;
	return out;
}

/// The profile's samples in [w0, w1] (and in its sub-span [c0, c1]), by owner: the engine
/// (wasm, its glue, and the builtins it calls), page handlers, GC, `(program)` and `(idle)`.
function profileSplit(prof, w0, w1, c0, c1) {
	const byId = new Map(prof.nodes.map((n) => [n.id, n]));
	const parent = new Map();
	for (const n of prof.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
	const isEngine = (cf) => /\.wasm$|^wasm:\/\//.test(cf.url) || cf.url.includes('/pkg/oxedyne_daimond')
		|| /^\$|^wasm-function\[/.test(cf.functionName);
	const name = (cf) => (cf.functionName || '(anon)') + ' ' + cf.url.replace(/^https?:\/\/[^/]+/, '')
		+ ':' + (cf.lineNumber + 1);
	const zero = () => ({ engine: 0, page: 0, pageFromEngine: 0, gc: 0, program: 0, idle: 0 });
	const whole = zero(), cov = zero();
	const top = { engine: new Map(), page: new Map(), pageFromEngine: new Map() };
	const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
	let t = prof.startTime;
	for (let i = 0; i < prof.samples.length; i++) {
		t += prof.timeDeltas[i];
		if (t < w0 || t > w1) continue;
		const dt = (i + 1 < prof.timeDeltas.length ? prof.timeDeltas[i + 1] : 0) / 1000;
		const inC = t >= c0 && t <= c1;
		const put = (k) => { whole[k] += dt; if (inC) cov[k] += dt; };
		const leaf = byId.get(prof.samples[i]);
		const fn = leaf.callFrame.functionName;
		if (fn === '(idle)') { put('idle'); continue; }
		if (fn === '(garbage collector)') { put('gc'); continue; }
		if (fn === '(program)' || fn === '(root)') { put('program'); continue; }
		// A browser builtin (`getFile`, `getDirectoryHandle`, `entries`, `slice`: no url) is charged
		// to whoever called it, so the engine's own reads through its glue count as the engine's
		// edges and a page handler's DOM work as the page's.
		let id = leaf.id;
		while (!byId.get(id).callFrame.url && byId.get(id).callFrame.functionName !== 'wasm-to-js'
			&& parent.has(id)) id = parent.get(id);
		const owner = byId.get(id).callFrame;
		if (isEngine(owner) || owner.functionName === 'wasm-to-js') {
			put('engine'); add(top.engine, name(leaf.callFrame), dt); continue;
		}
		let fromEngine = false;
		while (parent.has(id)) {
			id = parent.get(id);
			if (isEngine(byId.get(id).callFrame)) { fromEngine = true; break; }
		}
		put('page');
		add(top.page, name(leaf.callFrame) + ' <- ' + name(owner), dt);
		if (fromEngine) { put('pageFromEngine'); add(top.pageFromEngine, name(owner), dt); }
	}
	const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
	return { whole, cov, top: { engine: sorted(top.engine), page: sorted(top.page),
		pageFromEngine: sorted(top.pageFromEngine) } };
}

/// The trace read a line at a time: Chrome writes one event per line, and two minutes of
/// `toplevel` across every process is past the longest string node will make (0.8 GB). Kept:
/// the complete events of CrRendererMain threads, compactly, and the span of all timestamps.
function readTrace(file) {
	const fd = fs.openSync(file, 'r');
	const buf = Buffer.alloc(1 << 22);
	const dec = new StringDecoder('utf8');
	const names = new Map(), byThread = new Map(), mains = [];
	let first = Infinity, last = -Infinity, rest = '';
	const take = (line) => {
		line = line.trim().replace(/,$/, '');
		if (!line.startsWith('{"')) return;
		let e;
		try { e = JSON.parse(line); } catch (x) { return; }	// the array's own brackets
		const k = e.pid + ':' + e.tid;
		if (e.name === 'thread_name') {
			names.set(k, e.args && e.args.name);
			if (e.args && e.args.name === 'CrRendererMain') mains.push(k);
			return;
		}
		if (e.ph === 'M' || !(e.ts > 0)) return;
		if (e.ts < first) first = e.ts;
		const z = e.ts + (e.dur || 0);
		if (z > last) last = z;
		// Thread names lead the file; an event on a thread not yet named is kept until it is.
		if (e.ph !== 'X' || (names.has(k) && names.get(k) !== 'CrRendererMain')) return;
		if (!byThread.has(k)) byThread.set(k, []);
		byThread.get(k).push({ ts: e.ts, dur: e.dur || 0, name: e.name });
	};
	for (;;) {
		const n = fs.readSync(fd, buf, 0, buf.length, null);
		if (n <= 0) break;
		const lines = (rest + dec.write(buf.subarray(0, n))).split('\n');
		rest = lines.pop();
		for (const l of lines) take(l);
	}
	take(rest);
	fs.closeSync(fd);
	for (const k of [...byThread.keys()]) if (names.get(k) !== 'CrRendererMain') byThread.delete(k);
	return { byThread, mains, first, last };
}
