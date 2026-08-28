// verify_toolbatch.mjs — a round of reads takes ONE read's time, and still answers
// in the order the model asked.
//
// Daimond ran a round's tool calls one after another: `for tc in &resp.tool_calls`
// in src/agent.rs awaited each call before starting the next, so a round's wall
// clock was the SUM of its calls where it could be the MAXIMUM. A frontier model
// routinely emits several tool-use blocks in one reply, and doing so is a large
// part of why one feels fast.
//
// WHAT MAY RUN TOGETHER IS NOT "ANYTHING": src/batch.rs holds the rule and the
// reasons, and the short version is that only a call which reads, asks nothing and
// changes nothing may share a batch. Everything else is a batch of one, exactly as
// before. That is why §3 exists — a check that only measured speed would go green
// on a build that batched the writes too.
//
//   §1  a round of reads answers all of them, in the order the model gave
//   §2  the round takes less than a queue of the same calls
//   §3  a write among the reads keeps its place
//   §4  the page still sees one call announced, then its result, then the next
//
// §4 is the one that looks like tidiness and is not. `www/js/daimond.js` keeps ONE
// `pendingTool` and ONE `pendingCallId` — in the chat, in the worker dock and in
// the daimon alike — and files each result against whichever call was announced
// last. Announce a batch up front and the first result is filed under the last
// call while every result after it is dropped, out of the transcript and out of
// the write-ahead journal both. The engine therefore keeps the wire strictly
// alternating and a batch is invisible on it.
//
// ── HOW THE TIMING IS MADE HONEST ────────────────────────────────────────────
//
// A figure from one engine is not a measurement of a change; it is a measurement
// of a machine. So `--against <dir>` loads a SECOND engine into the same page and
// runs the same rounds on both, alternating, and reports both medians. The two
// numbers then differ by the change and by nothing else — same browser, same OPFS,
// same fixture, same minute. `dev/breakproof_toolbatch.sh` builds that second
// engine, with `batch::may_run_beside` answering no to everything, which is the
// loop exactly as it stood.
//
// IT MUST BE A RELEASE BUILD. `wasm-pack build --dev` is three or four times
// slower at everything, so a dev-built comparison engine would report the change
// as an enormous win and the number would be about the optimiser.
//
//   node dev/verify_toolbatch.mjs
//   node dev/verify_toolbatch.mjs --against pkg-serial
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open as openApp, MOCK } from './harness.mjs';
import { whyStaleWasm, refuse } from './staleguard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const note = (s) => console.log('  ·    ' + s);

const argOf = (flag, fallback) => {
	const i = process.argv.indexOf(flag);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
/// Which directory under `www/` the page imports the engine under test from.
const ENGINE  = argOf('--engine', 'pkg');
/// A second engine to run the same rounds against, or none.
const AGAINST = argOf('--against', '');

// Six, because that is what a model asking for a batch of reads actually asks for,
// and because it is under the engine's own cap of eight — a round split into two
// batches would be measuring the cap rather than the batching.
const READS  = 6;
// Big enough that a read is a real read, small enough that six stay inside the
// turn's output budget: past it the results are cut, and the two engines would then
// be doing different amounts of work.
const BYTES  = 8 * 1024;
// A tree for the searches to walk. A search is the slowest thing in the batch rule
// and the one a model most often asks for several of at once.
const TREE   = 300;
const ROUNDS = 5;

const readArgs   = (n) => JSON.stringify({ path: `src/file${n}.txt` });
const searchArgs = (n) => JSON.stringify({ path: 'tree', query: `needle${n % 6}`, fixed: true });

/// The prompt that asks for a round of `n` calls of one tool.
const roundOf = (tool, args, n) =>
	'@tools ' + Array.from({ length: n }, (_, i) => `${tool} ${args(i)}`).join(' ;; ');

// The whole of this file is a claim about the ENGINE, and it drives the engine
// module directly rather than through the page -- so a stale bundle would not show
// up as a broken app, it would show up as yesterday's dispatch reporting today's
// timing.
refuse(whyStaleWasm(path.join(ROOT, `www/${ENGINE}/oxedyne_daimond_bg.wasm`),
	path.join(ROOT, 'src'), {
		subject: 'What the round dispatches together',
		holds:   '`agent::batch` and the loop that uses it',
	}));

async function main() {
	const s = await openApp({ name: 'toolbatch' });
	const page = s.page;
	try {
		if (ENGINE !== 'pkg') {
			console.log(`\n  !!!! the engine under test is www/${ENGINE}, not the app's own bundle.\n`);
		}
		// The engine module, whichever package it comes from. `www/pkg` is the one
		// the app booted, so it is already initialised; any other package has never
		// been, and wasm-bindgen's exports are inert until it is.
		await page.evaluate(() => {
			const done = {};
			window.__mod = async (name) => {
				const mod = await import(`../${name}/oxedyne_daimond.js`);
				if (name !== 'pkg' && !done[name]) { await mod.default(); done[name] = true; }
				return mod;
			};
			window.__app = async (engine) => {
				const mod = await window.__mod(engine);
				const app = new mod.DaimondApp(window.__mock, 'k', 'mock/fast', 4096, '', true);
				app.set_max_rounds(3);
				return app;
			};
			// The span of the ROUND, from the first call being announced to the last
			// result landing -- not of the turn, which also carries two provider
			// requests that have nothing to do with what is being measured.
			window.__round = async (app, prompt) => {
				const ev = [];
				const began = performance.now();
				await app.run_turn(prompt, (e) => ev.push({
					type: e.type, name: e.name, content: e.content, at: performance.now() - began }));
				const first = ev.find((e) => e.type === 'tool_call');
				const last  = ev.filter((e) => e.type === 'tool_result').pop();
				return { took: (first && last) ? last.at - first.at : NaN, events: ev };
			};
			window.__median = (xs) => {
				const v = xs.slice().sort((a, b) => a - b);
				return v[Math.floor(v.length / 2)];
			};
		});
		await page.evaluate((m) => { window.__mock = m; }, MOCK);

		// The fixture, written through the engine's own file tools, so the reads come
		// out of the same OPFS everything else uses.
		const built = await page.evaluate(async ({ engine, reads, bytes, tree }) => {
			const app = await window.__app(engine);
			window.__fixture = app;
			const body = 'x'.repeat(bytes);
			for (let i = 0; i < reads; i++) {
				// Each file opens with its own word, so a result in the wrong place is
				// caught by what it says and not merely by where it is.
				await app.run_tool('file_write', JSON.stringify({
					path: `src/file${i}.txt`, content: `MARK-${i}\n` + body }));
			}
			for (let i = 0; i < tree; i++) {
				await app.run_tool('file_write', JSON.stringify({
					path: `tree/d${i % 12}/leaf${i}.txt`,
					content: `needle${i % 6} in a haystack of ${i}\n` }));
			}
			return reads;
		}, { engine: ENGINE, reads: READS, bytes: BYTES, tree: TREE });
		check(`${READS} files and a tree of ${TREE} are in the workspace`, built === READS,
			`built ${built}`);

		// ── §1: the round answers, and answers in order ─────────────
		const batch = await page.evaluate(async ({ engine, prompt }) => {
			const app = await window.__app(engine);
			return await window.__round(app, prompt);
		}, { engine: ENGINE, prompt: roundOf('file_read', readArgs, READS) });

		const results = batch.events.filter((e) => e.type === 'tool_result');
		check(`§1 all ${READS} reads answered`, results.length === READS,
			`${results.length} result(s)`);
		const order = results.map((r, i) => (r.content || '').includes(`MARK-${i}`));
		check('§1 and each answer is the answer to its own call, in the order the model gave',
			order.every(Boolean),
			order.map((v, i) => (v ? '' : `call ${i}`)).filter(Boolean).join(', ') || 'all in place');

		// ── §2: the wall clock ──────────────────────────────────────
		//
		// Both engines, alternating, so a machine that gets busy half way through
		// spoils both medians equally instead of one of them.
		const engines = AGAINST ? [ENGINE, AGAINST] : [ENGINE];
		const work = [
			[`${READS} reads of ${BYTES / 1024}KB`, roundOf('file_read', readArgs, READS)],
			[`4 searches over ${TREE} files`,       roundOf('file_search', searchArgs, 4)],
		];
		for (const [what, prompt] of work) {
			const took = await page.evaluate(async ({ engines, prompt, rounds }) => {
				const apps = {};
				for (const e of engines) apps[e] = await window.__app(e);
				const runs = {};
				for (const e of engines) runs[e] = [];
				// One warm round each before anything is recorded: the first walk of a
				// tree pays for handles nothing else pays for.
				for (const e of engines) await window.__round(apps[e], prompt);
				for (let i = 0; i < rounds; i++) {
					for (const e of engines) {
						runs[e].push((await window.__round(apps[e], prompt)).took);
					}
				}
				const out = {};
				for (const e of engines) out[e] = window.__median(runs[e]);
				return out;
			}, { engines, prompt, rounds: ROUNDS });
			const mine = took[ENGINE];
			if (AGAINST) {
				const theirs = took[AGAINST];
				// Named by the engine each figure came from rather than "batched" and
				// "serial": the two can be given the other way round -- which is exactly
				// what the breakproof does -- and a fixed label would then read as a lie.
				note(`${what}: ${mine.toFixed(1)} ms on ${ENGINE}, ${theirs.toFixed(1)} ms on `
					+ `${AGAINST} — ${(theirs - mine).toFixed(1)} ms saved, `
					+ `${(mine / theirs * 100).toFixed(0)}% of the round on ${AGAINST}`);
				check(`§2 ${what} is quicker on ${ENGINE} than on ${AGAINST}`, mine < theirs,
					`${mine.toFixed(1)} ms against ${theirs.toFixed(1)} ms`);
			} else {
				note(`${what}: ${mine.toFixed(1)} ms per round`);
			}
		}
		if (!AGAINST) {
			note('no --against engine, so §2 reports figures and asserts nothing;'
				+ ' run dev/breakproof_toolbatch.sh for the comparison');
		}

		// ── §3: a write keeps its place ─────────────────────────────
		const mixed = await page.evaluate(async ({ engine, prompt }) => {
			const app = await window.__app(engine);
			return (await window.__round(app, prompt)).events;
		}, { engine: ENGINE, prompt: '@tools file_read ' + readArgs(0)
			+ ' ;; file_read ' + readArgs(1)
			+ ' ;; file_write ' + JSON.stringify({ path: 'src/out.txt', content: 'written' })
			+ ' ;; file_read ' + readArgs(2) });
		const names = mixed.filter((e) => e.type === 'tool_call').map((e) => e.name);
		check('§3 a write among the reads keeps the place the model gave it',
			JSON.stringify(names) === JSON.stringify(
				['file_read', 'file_read', 'file_write', 'file_read']),
			names.join(', '));

		// ── §4: the page's contract ─────────────────────────────────
		const wire = batch.events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result');
		const alternates = wire.length === READS * 2
			&& wire.every((e, i) => e.type === (i % 2 === 0 ? 'tool_call' : 'tool_result'));
		check('§4 one call is announced, then its result, then the next', alternates,
			wire.map((e) => (e.type === 'tool_call' ? 'C' : 'R')).join(''));
	} finally {
		await s.close();
	}
}

main().then(() => {
	console.log(`\n  ${ok.length} ok, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
}).catch((e) => {
	console.error('ABORT: ' + (e && e.stack || e));
	process.exit(2);
});
