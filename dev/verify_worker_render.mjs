// gateway: none
// verify_worker_render.mjs — a streaming worker must not freeze the page under a long history.
//
// THE FREEZE (11 Oct 2026, stack in ~/.cache/daimond/hangcatch/stack_0848.json). Every
// worker stream event went `sink` -> `Workers.render`, which emptied the agents list and
// rebuilt a tile for EVERY run in `Workers.runs` -- and `runs` was the whole persisted
// history, never pruned (the owner's `daimond-workers` key held 81 runs, 2.38 MB). So each
// streamed token redrew 80-odd tiles: O(events x runs), and even a small turn starved the
// page thread on his own device.
//
// FOUR PROPERTIES:
//
//   1. AN OVERSIZED HISTORY IS HEALED ON LOAD: the key is trimmed below the bound, and the
//      finished runs kept are capped.
//   2. A STREAMING WORKER DOES NOT BLOCK THE PAGE: no long task over 200 ms, and a CDP
//      Runtime.evaluate round trip under a second, throughout one worker turn.
//   3. EVERY TILE IS TRUE: each drawn tile is exactly what `Workers.tile` would draw for
//      its run now, mid-stream and at the end, and a finished tile is not redrawn.
//   4. THE BOUND HOLDS AFTER THE TURN: the persisted key is still below it.
//
// RED on 5c212f0f (the build that froze), GREEN after the coalesced render.
//
//   eval "$(bash dev/world.sh 109 --up)"
//   node dev/verify_worker_render.mjs              # Chromium
//   DAIMOND_BROWSER=webkit node dev/verify_worker_render.mjs   # no longtask API there
//
// Needs dev/serve.mjs and the world's mock. No gateway.
import { open, newChat, scratch, checker, BROWSER } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const KEEP      = 40;			// finished runs kept (Workers.FINISHED_KEEP)
const MAX_CHARS = 1000000;		// persisted key bound (Workers.PERSIST_MAX_CHARS)
const SEEDED    = 80;
const WORDS     = 600;			// streamed by the mock at 5 ms a word
const LONG_MS   = 200;
const EVAL_MS   = 1000;

const { ok, bad, check } = checker();

const s = await open({ name: 'worker_render', profile: scratch('pw', 'worker_render-' + BROWSER) });
const { page: p } = s;

try {
	const chatId = await newChat(s);

	// ── 1. Seed the owner's shape and heal it ───────────────────
	const healed = await p.evaluate(({ chatId, SEEDED, WORDS }) => {
		const W = window.DaimondWorkers;
		const para = 'The worker read the file, compared the two versions and wrote what it found. ';
		const runs = [];
		// Newest first, as `runs.unshift` keeps them: the live one on top.
		const answer = Array.from({ length: WORDS }, (_, i) => 'w' + (i + 1)).join(' ');
		runs.push({ id: 'w' + (SEEDED + 1), name: 'live', task: '@text ' + answer,
			diamondId: '', diamondName: '', chatId, chatName: 'render', status: 'interrupted',
			text: '', tools: [], model: 'mock/fast', provider: 'custom',
			promptTokens: 0, completionTokens: 0 });
		for (let i = SEEDED; i >= 1; i--) {
			const tools = Array.from({ length: 150 }, (_, k) => ({
				name: ['read_file', 'write_file', 'search', 'list_dir', 'run'][k % 5],
				status: k % 11 === 0 ? 'failed' : 'done' }));
			runs.push({ id: 'w' + i, name: 'agent-' + i, task: 'Look into part ' + i + ' of the tree.',
				diamondId: '', diamondName: '', chatId, chatName: 'render', status: 'done',
				text: para.repeat(260), tools, model: 'mock/fast', provider: 'custom',
				promptTokens: 12000 + i, completionTokens: 3000 + i, cachedTokens: 0, costUsd: 0.01,
				ended: { how: 'answered', why: '', offered: 3, rounds: 4, calls: 150, refused: 0,
					failed: 14, missing: [] } });
		}
		const raw = JSON.stringify({ v: 2, dropped: 0, runs });
		localStorage.setItem('daimond-workers', raw);
		W.runs = [];
		W.load();
		const after = localStorage.getItem('daimond-workers') || '';
		let kept = 0;
		try { kept = JSON.parse(after).runs.filter((r) => r.status === 'done').length; } catch (e) { kept = -1; }
		return { seededChars: raw.length, chars: after.length, kept, inMemory: W.runs.length };
	}, { chatId, SEEDED, WORDS });
	check('AN OVERSIZED HISTORY IS HEALED ON LOAD — the key is below the bound',
		healed.chars < MAX_CHARS,
		`seeded ${healed.seededChars} chars, now ${healed.chars} (bound ${MAX_CHARS})`);
	check('and the finished runs kept are capped',
		healed.kept >= 1 && healed.kept <= KEEP && healed.inMemory <= KEEP + 1,
		`${healed.kept} finished persisted, ${healed.inMemory} in memory (cap ${KEEP})`);

	// ── 2. One worker turn, measured ────────────────────────────
	await p.evaluate(() => {
		window.DaimondPanels.show('agents');
		window.DaimondWorkers.render();
		window.__long = [];
		try {
			new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration)))
				.observe({ type: 'longtask', buffered: false });
			window.__longOk = true;
		} catch (e) { window.__longOk = false; }
		const W = window.DaimondWorkers;
		W.resume(W.runs.find((r) => r.name === 'live'));
	});

	// While it streams: the evaluate round trip, and the tiles mid-stream.
	let maxEval = 0, samples = 0, midBad = [], midChecked = 0, status = '';
	let snapped = false, fin = { redrawn: 0, kept: 0 };
	const t0 = Date.now();
	while (Date.now() - t0 < 60000) {
		const a = Date.now();
		status = await p.evaluate(() => {
			const r = window.DaimondWorkers.runs.find((x) => x.name === 'live');
			return r ? r.status : 'gone';
		});
		maxEval = Math.max(maxEval, Date.now() - a);
		samples++;
		// The finished tiles as drawn once the stream has begun, and again later in it.
		// A status change (queued -> running -> done) may redraw the list; a streamed
		// token of ANOTHER run must not touch a finished tile.
		if (status === 'running') {
			const f = await p.evaluate((snap) => {
				const W = window.DaimondWorkers;
				const cards = [...document.querySelectorAll('#agents-list .acard')];
				if (snap) {
					window.__fin = [];
					cards.forEach((c, i) => {
						const r = W.runs[i];
						if (r && r.status === 'done') window.__fin.push({ node: c, html: c.outerHTML });
					});
					return null;
				}
				let redrawn = 0;
				window.__fin.forEach((was) => {
					if (!was.node.isConnected || was.node.outerHTML !== was.html) redrawn++;
				});
				return { redrawn, kept: window.__fin.length };
			}, !snapped);
			if (f) fin = { redrawn: Math.max(fin.redrawn, f.redrawn), kept: f.kept };
			snapped = true;
		}
		if (status === 'running' && midChecked < 3) {
			// Two frames, so a coalesced draw has landed, then compare drawn with true.
			const mism = await p.evaluate(() => new Promise((res) => requestAnimationFrame(() =>
				requestAnimationFrame(() => {
					const W = window.DaimondWorkers;
					const out = [];
					const cards = [...document.querySelectorAll('#agents-list .acard')];
					W.runs.forEach((r, i) => {
						const want = W.tile(r).outerHTML;
						if (!cards[i] || cards[i].outerHTML !== want) out.push(r.id);
					});
					res(out);
				}))));
			midChecked++;
			midBad = midBad.concat(mism);
		}
		if (status !== 'running' && status !== 'queued' && status !== 'interrupted') break;
		await new Promise((r) => setTimeout(r, 100));
	}
	const end = await p.evaluate(() => new Promise((res) => requestAnimationFrame(() =>
		requestAnimationFrame(() => {
			const W = window.DaimondWorkers;
			const cards = [...document.querySelectorAll('#agents-list .acard')];
			const wrong = [];
			W.runs.forEach((r, i) => {
				if (!cards[i] || cards[i].outerHTML !== W.tile(r).outerHTML) wrong.push(r.id);
			});
			const live = W.runs.find((x) => x.name === 'live') || {};
			res({ wrong, longOk: window.__longOk, longs: window.__long.slice(),
				text: live.text || '', status: live.status,
				chars: (localStorage.getItem('daimond-workers') || '').length });
		}))));

	check('the worker turn ran to its end', end.status === 'done' && end.text.indexOf('w' + WORDS) !== -1,
		`status ${end.status}, ${end.text.length} chars`);
	const worst = end.longs.length ? Math.max(...end.longs) : 0;
	if (end.longOk) {
		check(`A STREAMING WORKER DOES NOT BLOCK THE PAGE — no long task over ${LONG_MS} ms`,
			worst <= LONG_MS, `${end.longs.length} long task(s), worst ${Math.round(worst)} ms`);
	} else {
		console.log(`  n/a  long tasks (no longtask observer in ${BROWSER})`);
	}
	check(`and a Runtime.evaluate round trip stays under ${EVAL_MS} ms`, maxEval < EVAL_MS,
		`worst ${maxEval} ms over ${samples} samples`);
	check('EVERY TILE IS TRUE mid-stream', midChecked > 0 && midBad.length === 0,
		midChecked ? (midBad.length ? 'stale: ' + midBad.slice(0, 5).join(', ') : `${midChecked} sample(s)`)
			: 'never caught it running');
	check('and at the end', end.wrong.length === 0, end.wrong.slice(0, 5).join(', '));
	check('and a finished tile is not redrawn by another run\'s stream',
		fin.redrawn === 0 && fin.kept > 0, `${fin.redrawn} of ${fin.kept} redrawn mid-stream`);
	check('THE BOUND HOLDS AFTER THE TURN', end.chars < MAX_CHARS, `${end.chars} chars`);
} finally {
	await s.close();
}

guardRan(ok.length + bad.length);
console.log(bad.length ? `\n${bad.length} check(s) FAILED` : '\nall checks passed');
process.exit(bad.length ? 1 : 0);
