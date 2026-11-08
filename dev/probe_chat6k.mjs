// probe_chat6k.mjs -- CHAT-RENDER-6K (08 Nov): the driver tab's renderer crashed opening his
// Daimond diamond, a conversation of ~170 turns and ~6,000 tiles. This puts a synthetic chat of
// that shape on screen in a world (never his account) and measures what opening it costs.
//
// Phase 1, open: the chat is opened as a switch from another (`renderHistory`, not the same chat),
// and the probe reads the synchronous ms, the tiles and DOM elements the thread holds, and the JS
// heap after a forced collection.
// Phase 2, scroll up: the reader walks to the top of the thread, a screen at a time, and the probe
// reads whether earlier turns came into view and what the thread holds at the top.
//
// Gates (exit 1 on any): the open is bounded whatever the chat's length (OPEN_MS, TILES_MAX,
// NODES_MAX, HEAP_MB); the first turn is reachable by scrolling up; at the top the thread still
// holds no more than TILES_MAX tiles; the newest turn comes back on a jump to the end.
// Phase 3 lands a long turn while he reads at the top: the thread stays under SCROLL_MAX, his tile
// stays put, the end button carries the news and tapping it lands on the answer. Phase 4 walks back
// down through the gap: no turn skipped, under SCROLL_MAX, until the gap is gone.
// R6K_DEBUG=1 prints each step of the walk down; DOWN_MAX bounds it.
//
//   eval "$(bash dev/world.sh 90 --env)"; node dev/probe_chat6k.mjs
import { open, newChat, revealComposer } from './harness.mjs';

const TURNS     = Number(process.env.TURNS || 170);	// his Daimond diamond stood at turn 167
const PER_TURN  = 17;					// tool calls a turn: 170 x (1 + 2*17 + 1) ~ 6,000 messages
const OPEN_MS   = 1500;					// a phone must show the latest turns at once
const TILES_MAX = 600;					// tiles the thread holds, opened or scrolled
const NODES_MAX = 30000;				// DOM elements on the whole page
const HEAP_MB   = 150;					// JS heap after the open, collected
const SCROLL_MAX = 1300;				// tiles once scrolled: the window of history and the newest turns
const STEPS_MAX = 400;					// screens of scrolling up before the probe gives up
const LIVE_ROWS = 900;					// rows of a turn landing while he reads at the top: three tails
const LIVE_BATCH = 30;					// rows a hand-off frame carries

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// VIEW=390x844 opens a phone's viewport; SHOT=<prefix> writes <prefix>-gap.png, -answer.png, -end.png.
const view = /^(\d+)x(\d+)$/.exec(process.env.VIEW || '');
// A phone shows the Models panel over the thread until a model is connected.
const s = await open({ name: 'chat6k', connect: !!view, ...(view ? { viewport: { width: +view[1], height: +view[2] } } : {}) });
const pg = s.page;
const cdp = await pg.context().newCDPSession(pg);
const heapMb = async () => {
	await cdp.send('HeapProfiler.collectGarbage');
	const m = await cdp.send('Performance.getMetrics');
	const h = m.metrics.find((x) => x.name === 'JSHeapUsedSize');
	return h ? h.value / 1048576 : -1;
};
try {
	await cdp.send('Performance.enable');
	await pg.waitForFunction(() => !!document.getElementById('chat-output'), null, { timeout: 20000 });
	await newChat(s);
	if (view) await revealComposer(pg);
	await pg.evaluate(async () => {
		const st = await import('/js/page/state.js');
		const tu = await import('/js/page/turns.js');
		window.__c6 = { pg: st.pg, renderHistory: tu.renderHistory };
	});
	const heap0 = await heapMb();
	const opened = await pg.evaluate(([turns, per]) => {
		const T = window.__c6, now = Date.now();
		const para = (i, k) => Array.from({ length: k }, (_, j) => 'Line ' + j + ' of step ' + i
			+ ': the **thread** keeps growing with `code` and words, as his did.').join('\n\n');
		const ms = [];
		let t = now - 30 * 86400e3, n = 0;
		for (let u = 0; u < turns; u++) {
			const it = 'q' + u;
			ms.push({ role: 'user', content: 'Turn ' + u + ': carry on with the next part of the work.', mid: it, ts: t += 1000 });
			ms.push({ role: 'think_log', content: para(n, 2), mid: it + 'k', iturn: it, ts: t += 1000 });
			for (let k = 0; k < per; k++, n++) {
				ms.push({ role: 'assistant', content: 'Step ' + k + ': reading the next file.', mid: it + 'a' + k, iturn: it, ts: t += 1000 });
				ms.push({ role: 'tool_log', name: k % 3 ? 'file_read' : 'run', args: JSON.stringify({ path: 'src/f' + n + '.rs' }),
					content: para(n, 12), outcome: 'done', callId: 'c' + n, mid: it + 't' + k, iturn: it, ts: t += 1000 });
			}
			ms.push({ role: 'assistant', content: 'Turn ' + u + ' done.\n\n' + para(n, 6), mid: it + 'z', iturn: it, ts: t += 1000 });
		}
		const c = T.pg.current;
		c.messages = ms;
		c._loaded = true;
		const out = document.getElementById('chat-output');
		T.pg._renderedChatId = null;
		const t0 = performance.now();
		T.renderHistory(c.messages);
		void document.body.offsetHeight;
		const took = performance.now() - t0;
		return { msgs: ms.length, ms: took, tiles: out.querySelectorAll('.ctile, .chat-msg').length,
			nodes: document.getElementsByTagName('*').length,
			firstTurn: (out.querySelector('[data-turn]') || { dataset: {} }).dataset.turn,
			lastTurn: Array.from(out.querySelectorAll('[data-turn]')).pop().dataset.turn };
	}, [TURNS, PER_TURN]);
	const heap1 = await heapMb();
	console.log(`open: ${opened.msgs} messages; ${opened.ms.toFixed(0)} ms; ${opened.tiles} tiles; ${opened.nodes} elements; `
		+ `heap ${heap0.toFixed(0)} -> ${heap1.toFixed(0)} MB; turns ${opened.firstTurn}..${opened.lastTurn}`);
	check('the open takes no more than ' + OPEN_MS + ' ms', opened.ms <= OPEN_MS, opened.ms.toFixed(0) + ' ms');
	check('the open draws no more than ' + TILES_MAX + ' tiles', opened.tiles <= TILES_MAX, String(opened.tiles));
	check('the page holds no more than ' + NODES_MAX + ' elements', opened.nodes <= NODES_MAX, String(opened.nodes));
	check('the heap grows no more than ' + HEAP_MB + ' MB', heap1 - heap0 <= HEAP_MB, (heap1 - heap0).toFixed(0) + ' MB');
	check('the newest turn is on screen', opened.lastTurn === String(TURNS), 'last ' + opened.lastTurn);

	// Scroll up a screen at a time, as he would, until the first turn is drawn or the probe gives up.
	let steps = 0, top = null;
	for (; steps < STEPS_MAX; steps++) {
		top = await pg.evaluate(() => {
			const out = document.getElementById('chat-output');
			out.scrollTop = 0;
			const first = out.querySelector('[data-turn]');
			return { first: first ? first.dataset.turn : null, at: out.scrollTop,
				tiles: out.querySelectorAll('.ctile, .chat-msg').length };
		});
		if (top.first === '1' && top.at === 0) break;
		// At the top he stops, and the earlier turns load once the scroll has settled.
		await pg.waitForTimeout(top.at === 0 ? 400 : 30);
	}
	console.log(`scroll up: ${steps} screens; first turn drawn ${top.first}; ${top.tiles} tiles at the top`);
	check('the first turn is reached by scrolling up', top.first === '1' && top.at === 0, 'first ' + top.first + ' at ' + top.at);
	check('at the top the thread holds no more than ' + SCROLL_MAX + ' tiles', top.tiles <= SCROLL_MAX, String(top.tiles));

	// Phase 3, a daimon answers while he reads at the top (CHAT-RENDER-6K-b): a long turn lands in
	// batches through the door a hand-off's rows take (`renderHistory`, then `followActivity`).
	// The thread stays bounded, his tile does not move, the end button carries the news, and
	// tapping it lands on the answer.
	const live = [];
	for (let b = 0; b < LIVE_ROWS / LIVE_BATCH; b++) {
		live.push(await pg.evaluate(async ([b, rows, batch, turns]) => {
			const tu = await import('/js/page/turns.js');
			const T = window.__c6, c = T.pg.current, out = document.getElementById('chat-output');
			const at = (el) => el.getBoundingClientRect().top - out.getBoundingClientRect().top;
			const mark = out.querySelector('[data-turn]'), turn0 = mark.dataset.turn, top0 = at(mark);
			const ms = c.messages.slice(), it = 'live', t = Date.now();
			for (let k = 0; k < batch; k++) {
				const n = b * batch + k;
				if (n === 0) ms.push({ role: 'user', content: 'Turn ' + (turns + 1) + ': from another device.', mid: it, ts: t });
				else if (n === rows - 1) ms.push({ role: 'assistant', content: 'LIVE ANSWER: the work is done.', mid: it + 'z', iturn: it, ts: t + n });
				else ms.push({ role: 'tool_log', name: 'run', args: '{"cmd":"cargo check"}', content: 'checking ' + n,
					outcome: 'done', callId: 'lv' + n, mid: it + 't' + n, iturn: it, ts: t + n });
			}
			c.messages = ms;
			const follow = tu.followsEnd();
			T.renderHistory(c.messages);
			tu.followActivity(follow);
			await new Promise((r) => setTimeout(r, 30));
			const mark1 = Array.from(out.querySelectorAll('[data-turn]')).find((e) => e.dataset.turn === turn0);
			return { tiles: out.querySelectorAll('.ctile, .chat-msg').length, nodes: document.getElementsByTagName('*').length,
				moved: mark1 ? Math.abs(at(mark1) - top0) : 1e9 };
		}, [b, LIVE_ROWS, LIVE_BATCH, TURNS]));
	}
	const most = Math.max(...live.map((x) => x.tiles)), drift = Math.max(...live.map((x) => x.moved));
	console.log(`live: ${LIVE_ROWS} rows in ${live.length} batches while at the top; most ${most} tiles, `
		+ `${Math.max(...live.map((x) => x.nodes))} elements; his tile moved at most ${drift.toFixed(0)} px`);
	check('while a turn lands at the top the thread holds no more than ' + SCROLL_MAX + ' tiles', most <= SCROLL_MAX, String(most));
	check('the tile he is reading does not move', drift <= 2, drift.toFixed(0) + ' px');
	const cue = await pg.evaluate(async () => {
		const b = document.getElementById('chat-end');
		const shown = !!b && !b.hidden && b.classList.contains('has-news');
		if (b) b.click();
		await new Promise((r) => setTimeout(r, 300));
		const out = document.getElementById('chat-output');
		const ans = Array.from(out.querySelectorAll('.ctile, .chat-msg')).filter((e) => /LIVE ANSWER/.test(e.textContent)).pop();
		const or = out.getBoundingClientRect(), ar = ans ? ans.getBoundingClientRect() : null;
		return { shown, ans: !!ans, inView: !!ar && ar.bottom > or.top && ar.top < or.bottom,
			gap: out.scrollHeight - out.scrollTop - out.clientHeight };
	});
	check('the end button shows the news', cue.shown);
	if (process.env.SHOT) await pg.screenshot({ path: process.env.SHOT + '-answer.png' });
	check('tapping it lands on the answer', cue.ans && cue.inView && cue.gap < 48,
		'drawn ' + cue.ans + ', in view ' + cue.inView + ', ' + cue.gap.toFixed(0) + ' px short');

	// Phase 4, back down through the gap: from the top, he scrolls down and the window pages the
	// later history back in, no turn skipped and the thread bounded, until the gap is gone.
	let down = 0, walk = { tiles: 0, gap: true }, skipped = null, most4 = 0, lastTop = 0;
	await pg.evaluate(() => { document.getElementById('chat-output').scrollTop = 0; });
	await pg.waitForTimeout(400);
	for (; down < Number(process.env.DOWN_MAX || STEPS_MAX); down++) {
		walk = await pg.evaluate(() => {
			const out = document.getElementById('chat-output'), g = document.getElementById('chat-gap');
			const turns = [];
			for (const k of out.children) {
				if (g && (k === g || (k.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_PRECEDING))) break;
				if (k.dataset && k.dataset.turn != null) turns.push(Number(k.dataset.turn));
			}
			if (g) g.scrollIntoView({ block: 'end' });
			return { top: out.scrollTop, gapAt: g ? Math.round(g.getBoundingClientRect().top - out.getBoundingClientRect().top) : null, gap: !!g, tiles: out.querySelectorAll('.ctile, .chat-msg').length,
				lo: Math.min(...turns), hi: Math.max(...turns) };
		});
		most4 = Math.max(most4, walk.tiles);
		if (process.env.SHOT && down === 1) await pg.screenshot({ path: process.env.SHOT + '-gap.png' });
		if (process.env.R6K_DEBUG) console.log('  down ' + down + ': ' + JSON.stringify(walk));
		if (!walk.gap) break;
		if (down && walk.lo > lastTop + 1) skipped = lastTop + '..' + walk.lo;
		lastTop = walk.hi;
		// Past the render's hold of his place (ANCHOR_HOLD_MS), which a finger would end at once.
		await pg.waitForTimeout(1300);
	}
	console.log(`scroll down: ${down} pages to the end of the window; most ${most4} tiles`);
	check('scrolling down pages the gap away', !walk.gap, down + ' pages');
	check('no turn is skipped on the way down', skipped === null, skipped || '');
	check('on the way down the thread holds no more than ' + SCROLL_MAX + ' tiles', most4 <= SCROLL_MAX, String(most4));

	const end = await pg.evaluate(async () => {
		const tu = await import('/js/page/turns.js');
		tu.jumpEnd();
		await new Promise((r) => setTimeout(r, 300));
		const out = document.getElementById('chat-output');
		return { last: Array.from(out.querySelectorAll('[data-turn]')).pop().dataset.turn,
			gap: out.scrollHeight - out.scrollTop - out.clientHeight };
	});
	check('a jump to the end shows the newest turn', end.last === String(TURNS + 1) && end.gap < 48, 'last ' + end.last + ', ' + end.gap.toFixed(0) + ' px short');
	if (process.env.SHOT) await pg.screenshot({ path: process.env.SHOT + '-end.png' });
} catch (e) {
	console.log('probe error: ' + (e && e.stack || e));
	bad.push('probe error');
} finally {
	await s.close();
}
console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
