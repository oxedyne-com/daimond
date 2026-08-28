// Replay a real agentic loop's requests at a REAL provider, and read the clock.
//
// The mock can say what Daimond sends and what Daimond's own overhead costs.  It
// cannot say what the provider does with a 57 KB request twelve times in a row --
// whether the prefix is served from a cache, and what the first token costs when
// it is not.  So the bodies captured by dev/latmock.mjs (LAT_KEEP_BODY=1) are
// replayed verbatim, in order, with only the model swapped.
//
//   node dev/probe_provider.mjs <captured.log> <model> [--rounds 13] [--pass 2]
//
// The key is read from the environment and from nowhere else:
//
//   OPENROUTER_API_KEY=$(cat ~/.config/oxedyne/daimond/openrouter.key) \
//     node dev/probe_provider.mjs dev/latmock-x.log z-ai/glm-5.2
//
// Every round reports time to first token, total time, the prompt tokens the
// provider counted, how many of them it served from its cache, and what it says
// the call cost.  Nothing is written to the log but numbers.

import fs from 'node:fs';

const LOG   = process.argv[2];
const MODEL = process.argv[3];
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const ROUNDS = Number(arg('rounds', 99));
const PASSES = Number(arg('pass', 1));
const MAXTOK = Number(arg('maxtok', 200));
const URL_   = arg('url', 'https://openrouter.ai/api/v1/chat/completions');

if (!LOG || !MODEL) {
	console.error('usage: probe_provider.mjs <captured.log> <model> [--rounds n] [--pass n]');
	process.exit(2);
}
const KEY = process.env.OPENROUTER_API_KEY;
if (!KEY) {
	console.error('Set OPENROUTER_API_KEY before running this probe.');
	process.exit(2);
}

const bodies = fs.readFileSync(LOG, 'utf8').trim().split('\n')
	.filter(Boolean).map(l => JSON.parse(l)).filter(l => l.raw).map(l => JSON.parse(l.raw))
	.slice(0, ROUNDS);
if (!bodies.length) {
	console.error(`${LOG} holds no captured bodies -- run the probe with LAT_KEEP_BODY=1.`);
	process.exit(2);
}

const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

/// One replayed round: the same messages and the same tool schemas, at a real model.
async function round(body) {
	const send = {
		...body,
		model: MODEL,
		max_tokens: MAXTOK,
		stream: true,
		stream_options: { include_usage: true },
		// OpenRouter reports what the call cost in the final usage chunk when asked.
		usage: { include: true },
	};
	const raw = JSON.stringify(send);
	const t0 = now();
	const r = await fetch(URL_, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` },
		body: raw,
	});
	if (!r.ok) {
		const t = await r.text();
		return { err: `${r.status} ${t.slice(0, 200)}` };
	}
	let first = 0, usage = null, out = 0;
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!first) first = now();
		buf += dec.decode(value, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith('data: ')) continue;
			const d = line.slice(6);
			if (d === '[DONE]') continue;
			let j; try { j = JSON.parse(d); } catch { continue; }
			if (j.usage) usage = j.usage;
			const ch = (j.choices || [])[0];
			if (ch && ch.delta) out += ((ch.delta.content || '') + (ch.delta.reasoning || '')).length;
		}
	}
	const end = now();
	const u = usage || {};
	const det = u.prompt_tokens_details || {};
	return {
		bytes:  Buffer.byteLength(raw, 'utf8'),
		ttft:   +(first - t0).toFixed(0),
		total:  +(end - t0).toFixed(0),
		ptok:   u.prompt_tokens || 0,
		cached: det.cached_tokens || 0,
		ctok:   u.completion_tokens || 0,
		cost:   u.cost || 0,
		chars:  out,
	};
}

console.log(`model ${MODEL}   rounds ${bodies.length}   pass(es) ${PASSES}`);
let spend = 0;
for (let p = 1; p <= PASSES; p++) {
	console.log(`\npass ${p}`);
	console.log('round  reqKB  promptTok  cached  %cached  ttft   total  outTok   cost');
	for (let i = 0; i < bodies.length; i++) {
		const r = await round(bodies[i]);
		if (r.err) { console.log(`${String(i + 1).padStart(5)}  ERROR ${r.err}`); continue; }
		spend += r.cost;
		const pc = r.ptok ? (100 * r.cached / r.ptok) : 0;
		console.log([
			String(i + 1).padStart(5),
			(r.bytes / 1024).toFixed(1).padStart(7),
			String(r.ptok).padStart(11),
			String(r.cached).padStart(8),
			pc.toFixed(0).padStart(8),
			String(r.ttft).padStart(6),
			String(r.total).padStart(7),
			String(r.ctok).padStart(8),
			r.cost.toFixed(5).padStart(8),
		].join(''));
	}
}
console.log(`\nspent on ${MODEL}: $${spend.toFixed(4)}`);
