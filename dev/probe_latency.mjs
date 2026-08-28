// Where an agentic turn's wall clock actually goes, measured in the browser.
//
// The question this answers is the owner's: models that are fast elsewhere feel
// slow in Daimond on tool-using work.  That is a comparison, so what is wanted is
// a number per STAGE per ROUND, not a list of things that could be slow.
//
//   node dev/probe_latency.mjs [--rounds 12] [--tool file_list] [--wide 1] [--size 2048]
//
// Three instruments, none of which changes the engine:
//
//   the FETCH clock.  `window.fetch` is wrapped before the app loads, and the
//   response body is handed back through a proxy stream, so the moment each SSE
//   chunk reaches the page is recorded as well as the request's size and when it
//   went out.  That is request-sent, first-byte and last-byte, per round.
//
//   the EVENT clock.  `DaimondApp.prototype.run_turn` is wrapped, so every
//   `AgentEvent` the engine emits is stamped as it crosses out of the wasm.  Tool
//   dispatch is the gap between `tool_call` and `tool_result`; the wasm's own work
//   is what is left over when the fetch and the tools are taken out.
//
//   the PROVIDER log.  dev/latmock.mjs writes one line per request with the body
//   size, the bytes per role and the schema array, so prompt growth is measured
//   from what was SENT rather than estimated from the transcript.
//
// The mock's own latency defaults to zero, so a run measures what Daimond adds.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, newChat, connectMock, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const arg = (name, dflt) => {
	const i = process.argv.indexOf('--' + name);
	return i === -1 ? dflt : process.argv[i + 1];
};
const ROUNDS = Number(arg('rounds', 12));
const TOOL   = String(arg('tool', 'file_list'));
const WIDE   = Number(arg('wide', 1));
const SIZE   = Number(arg('size', 2048));
const LABEL  = String(arg('label', `${TOOL}-r${ROUNDS}-w${WIDE}`));
// A REAL model, at a real provider, driven by a real task.  The mock says what
// Daimond's own overhead is; only this says what the whole thing costs, and the
// two together say which of them the user is waiting on.
const REAL   = arg('real', '');
const TASK   = String(arg('task',
	'Read each of these twelve files with file_read, one call per file, and reply with the total '
	+ 'number of characters across all of them. Read them one at a time, waiting for each result '
	+ 'before asking for the next. The files are '
	+ '%DIR%/f0.txt %DIR%/f1.txt %DIR%/f2.txt %DIR%/f3.txt %DIR%/f4.txt %DIR%/f5.txt '
	+ '%DIR%/f6.txt %DIR%/f7.txt %DIR%/f8.txt %DIR%/f9.txt %DIR%/f10.txt %DIR%/f11.txt'));
const KEY    = process.env.OPENROUTER_API_KEY || '';
const REALURL = String(arg('realurl', 'https://openrouter.ai/api/v1/chat/completions'));
const PORT   = Number(process.env.LAT_PORT || 9906);
const LOG    = path.join(HERE, `latmock-${LABEL}.log`);
const OUT    = path.join(HERE, `latency-${LABEL}.json`);

const log = (...a) => console.log(...a);

// ── the provider fixture ────────────────────────────────────────────────
try { fs.unlinkSync(LOG); } catch {}
const mock = spawn(process.execPath, [path.join(HERE, 'latmock.mjs'), String(PORT), LOG], {
	stdio: ['ignore', 'inherit', 'inherit'],
	env: { ...process.env, LAT_KEEP_BODY: process.env.LAT_KEEP_BODY || '' },
});
const stop = () => { try { mock.kill('SIGTERM'); } catch {} };
process.on('exit', stop);
await new Promise(r => setTimeout(r, 500));

// ── the page ────────────────────────────────────────────────────────────
const s = await open({
	name: 'lat',
	// Before navigation, which is the only moment `fetch` can be wrapped ahead of
	// the app: the engine takes its own reference to it when the module loads.
	route: async (page) => {
		await page.addInitScript(() => {
			window.__lat = { fetches: [], events: [], t0: performance.now() };
			const real = window.fetch.bind(window);
			window.fetch = async function (input, init) {
				const url = typeof input === 'string' ? input : (input && input.url) || '';
				if (!/chat\/completions|v1\/messages/.test(url)) return real(input, init);
				const body = (init && init.body) || (input && input.body) || '';
				const rec = {
					sent:  performance.now(),
					bytes: typeof body === 'string' ? new TextEncoder().encode(body).length : 0,
					// A `Request` carries its body as a stream, so the size is taken from a
					// clone and lands a tick later.  Not awaited: the request must not wait
					// on the instrument.

					first: 0, last: 0, chunks: 0, bytesIn: 0,
				};
				window.__lat.fetches.push(rec);
				if (!rec.bytes && input && typeof input.clone === 'function') {
					try { input.clone().arrayBuffer().then(b => { rec.bytes = b.byteLength; }); }
					catch (e) {}
				}
				const resp = await real(input, init);
				rec.head = performance.now();
				if (!resp.body) { rec.first = rec.last = rec.head; return resp; }
				// The body is handed on through a proxy, so each chunk is stamped as
				// it reaches the page rather than as the engine gets round to it.
				const reader = resp.body.getReader();
				const proxied = new ReadableStream({
					async pull(ctrl) {
						const { done, value } = await reader.read();
						if (done) { rec.last = performance.now(); ctrl.close(); return; }
						if (!rec.first) rec.first = performance.now();
						rec.chunks += 1;
						rec.bytesIn += value.byteLength;
						ctrl.enqueue(value);
					},
					cancel(r) { try { reader.cancel(r); } catch (e) {} },
				});
				return new Response(proxied, {
					status: resp.status, statusText: resp.statusText, headers: resp.headers,
				});
			};
		});
	},
});

if (REAL && !KEY) { console.error('--real needs OPENROUTER_API_KEY in the environment.'); process.exit(2); }
await connectMock(s, REAL
	? { baseUrl: REALURL, model: REAL, apiKey: KEY }
	: { baseUrl: `http://127.0.0.1:${PORT}/v1/chat/completions`, model: 'lat/fast' });
await newChat(s);

// The event clock, installed on the module the page has already loaded.  Wrapped
// here rather than in the init script because the wasm module is imported by the
// app, and its class only exists once that import has resolved.
await s.page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const proto = m.DaimondApp.prototype;
	if (proto.__latWrapped) return;
	proto.__latWrapped = true;
	const inner = proto.run_turn;
	proto.run_turn = function (msg, onEvent) {
		window.__lat.turnStart = performance.now();
		const sink = function (ev) {
			try {
				window.__lat.events.push({
					t:    performance.now(),
					type: (ev && ev.type) || '',
					name: (ev && ev.name) || '',
					// The SIZE of what crossed, never the content: a result may be a
					// file the user owns and this file is read by a person.
					n:    (ev && ev.content) ? String(ev.content).length : 0,
				});
			} catch (e) {}
			// Stamped again after the page's own handler, so the cost of the page's
			// rendering and journalling is separable from the engine's.
			const r = onEvent(ev);
			try {
				const last = window.__lat.events[window.__lat.events.length - 1];
				if (last) last.done = performance.now();
			} catch (e) {}
			return r;
		};
		return inner.call(this, msg, sink);
	};
});

// ── the fixture files ───────────────────────────────────────────────────
//
// Written straight into OPFS rather than through a turn: seeding through the tool
// loop is the very thing being measured, and twelve seeding turns would be twelve
// turns of noise in the log.
const SCRATCHDIR = await s.page.evaluate(async ({ size }) => {
	const f = window.DaimondAttach.focus();
	const dir = window.DaimondAttach.chatScratch(f.id);
	const parts = dir.split('/');
	let d = await navigator.storage.getDirectory();
	for (const seg of parts) d = await d.getDirectoryHandle(seg, { create: true });
	for (let i = 0; i < 12; i++) {
		const h = await d.getFileHandle(`f${i}.txt`, { create: true });
		const w = await h.createWritable();
		await w.write('x'.repeat(size));
		await w.close();
	}
	return dir;
}, { size: SIZE });
log(`seeded 12 files of ${SIZE} B in ${SCRATCHDIR}`);

// ── the turn ────────────────────────────────────────────────────────────
const spec = TOOL === 'file_list'
	? `file_list {"path":"${SCRATCHDIR}"}`
	: `file_read {"path":"${SCRATCHDIR}/f%.txt"}`;
// `%DIR%` is the chat's own scratch folder, which is the only place a chat may
// write and the only place the fixture files can be.  A task naming a bare
// filename is refused by the fence before the tool runs, and the turn then
// measures an apology rather than twelve reads.
const directive = REAL ? TASK.replace(/%DIR%/g, SCRATCHDIR) : (WIDE > 1
	? `@latp ${ROUNDS} ${WIDE} ${spec}`
	: `@lat ${ROUNDS} ${spec}`);
log(`turn: ${directive}`);

await s.page.fill('#chat-input', directive);
const wall0 = Date.now();
await s.page.click('#chat-send', { force: true });

// Wait for the turn to finish: the send button stops offering Stop.
const deadline = Date.now() + (REAL ? 600000 : 180000);
while (Date.now() < deadline) {
	const busy = await s.page.evaluate(() => {
		const b = document.getElementById('chat-send');
		if (!b) return false;
		const t = (b.getAttribute('title') || '') + (b.className || '');
		return /stop/i.test(t) || b.disabled;
	});
	if (!busy) break;
	await s.page.waitForTimeout(120);
}
const wall = Date.now() - wall0;
await s.page.waitForTimeout(600);

const seen = await s.page.evaluate(() => window.__lat);
await s.close();
stop();

// ── the report ──────────────────────────────────────────────────────────
const provider = fs.existsSync(LOG)
	? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
	: [];

const evs = seen.events || [];
const fetches = seen.fetches || [];
const rounds = [];
for (let i = 0; i < fetches.length; i++) {
	const f = fetches[i];
	const nxt = fetches[i + 1];
	const end = nxt ? nxt.sent : (f.last || f.head);
	// The tool calls of this round: everything between this round's last byte and
	// the next request going out.
	// From THIS request going out to the next one, which is the whole round: a
	// `tool_call` is emitted while the stream reader still has a `done` to
	// collect, so a window opening at the last byte misses every call.
	const win = evs.filter(e => e.t >= f.sent && e.t <= end);
	let tools = 0, dispatch = [];
	for (let k = 0; k < win.length; k++) {
		if (win[k].type === 'tool_call') {
			const done = win.slice(k + 1).find(e => e.type === 'tool_result');
			if (done) { tools += done.t - win[k].t; dispatch.push({ name: win[k].name, ms: done.t - win[k].t, out: done.n }); }
		}
	}
	const p = provider[i] || {};
	rounds.push({
		round:      i + 1,
		reqBytes:   p.bodyB || f.bytes,
		promptTok:  Math.round((p.bodyB || f.bytes) / 4),
		msgs:       p.msgs || 0,
		roleB:      p.roleB || {},
		toolsB:     p.toolsB || 0,
		ttfbMs:     +( (f.first || f.head) - f.sent ).toFixed(1),
		streamMs:   +( (f.last || f.head) - (f.first || f.head) ).toFixed(1),
		toolMs:     +tools.toFixed(1),
		// What the round cost that was neither the provider nor a tool: the wasm's
		// own work, the page's rendering and the journal's writes.
		gapMs:      nxt ? +(nxt.sent - f.sent - ((f.first || f.head) - f.sent)
			- ((f.last || f.head) - (f.first || f.head)) - tools).toFixed(1) : null,
		roundMs:    +(end - f.sent).toFixed(1),
		dispatch,
	});
}

const sum = (k) => rounds.reduce((a, r) => a + (r[k] || 0), 0);
const report = {
	label: LABEL, tool: TOOL, wide: WIDE, rounds: ROUNDS, fixtureBytes: SIZE, model: REAL || 'lat/fast',
	wallMs: wall,
	totals: {
		ttfb:   +sum('ttfbMs').toFixed(1),
		stream: +sum('streamMs').toFixed(1),
		tools:  +sum('toolMs').toFixed(1),
		gap:    +rounds.reduce((a, r) => a + (r.gapMs || 0), 0).toFixed(1),
	},
	rounds,
	events: evs,
	fetches,
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

log('');
log(`round  reqKB  promptTok  msgs  ttfb   stream  tools   gap    round`);
for (const r of rounds) {
	log([
		String(r.round).padStart(5),
		(r.reqBytes / 1024).toFixed(1).padStart(7),
		String(r.promptTok).padStart(10),
		String(r.msgs).padStart(6),
		r.ttfbMs.toFixed(0).padStart(6),
		r.streamMs.toFixed(0).padStart(8),
		r.toolMs.toFixed(0).padStart(7),
		(r.gapMs == null ? '-' : r.gapMs.toFixed(0)).padStart(7),
		r.roundMs.toFixed(0).padStart(8),
	].join(''));
}
log('');
log(`wall ${wall} ms; ttfb ${report.totals.ttfb} ms, stream ${report.totals.stream} ms, ` +
	`tools ${report.totals.tools} ms, gap ${report.totals.gap} ms`);
log(`written ${OUT}`);
log(`provider log ${LOG}`);
