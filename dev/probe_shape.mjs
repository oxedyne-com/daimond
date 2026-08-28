// What does the SIZE of Daimond's request cost, at a real model?
//
// dev/probe_provider.mjs replays the loop as it is.  This asks the counterfactual:
// the same model, the same moment, with the request cut down.  Four shapes, in
// order of what they take away:
//
//   bare      a two-line conversation and no tools -- the model at its fastest
//   convo     Daimond's conversation, no tool schemas
//   half      Daimond's conversation with half the schemas
//   full      what Daimond actually sends
//
// The gap between `bare` and `full` is what the app's own prompt costs in time,
// separated from anything the provider or the network does.
//
//   OPENROUTER_API_KEY=... node dev/probe_shape.mjs <captured.log> <model> [--reps 3]

import fs from 'node:fs';

const LOG   = process.argv[2];
const MODEL = process.argv[3];
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const REPS = Number(arg('reps', 3));
const URL_ = arg('url', 'https://openrouter.ai/api/v1/chat/completions');
const KEY  = process.env.OPENROUTER_API_KEY;
if (!LOG || !MODEL || !KEY) {
	console.error('usage: OPENROUTER_API_KEY=... probe_shape.mjs <captured.log> <model>');
	process.exit(2);
}
const first = fs.readFileSync(LOG, 'utf8').trim().split('\n')
	.filter(Boolean).map(l => JSON.parse(l)).find(l => l.raw);
const body = JSON.parse(first.raw);
const now = () => Number(process.hrtime.bigint() / 1000n) / 1000;

const shapes = {
	bare:  { messages: [{ role: 'user', content: 'Reply with the single word: ok.' }] },
	convo: { messages: body.messages },
	half:  { messages: body.messages, tools: body.tools.slice(0, Math.ceil(body.tools.length / 2)),
	         tool_choice: 'auto' },
	full:  { messages: body.messages, tools: body.tools, tool_choice: 'auto' },
};

async function once(shape) {
	const send = { model: MODEL, max_tokens: 32, stream: true,
		stream_options: { include_usage: true }, usage: { include: true }, ...shape };
	const raw = JSON.stringify(send);
	const t0 = now();
	const r = await fetch(URL_, { method: 'POST',
		headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEY}` }, body: raw });
	if (!r.ok) return { err: `${r.status} ${(await r.text()).slice(0, 120)}` };
	const reader = r.body.getReader();
	const dec = new TextDecoder();
	let ttft = 0, buf = '', usage = null;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!ttft) ttft = now();
		buf += dec.decode(value, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) !== -1) {
			const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
			if (!line.startsWith('data: ')) continue;
			const d = line.slice(6); if (d === '[DONE]') continue;
			try { const j = JSON.parse(d); if (j.usage) usage = j.usage; } catch {}
		}
	}
	const u = usage || {}, det = u.prompt_tokens_details || {};
	return { kb: +(Buffer.byteLength(raw, 'utf8') / 1024).toFixed(1), ttft: Math.round(ttft - t0),
		total: Math.round(now() - t0), ptok: u.prompt_tokens || 0, cached: det.cached_tokens || 0,
		cost: u.cost || 0 };
}

console.log(`model ${MODEL}`);
console.log('shape   reqKB  promptTok  cached  ttft(ms, each rep)');
let spend = 0;
for (const [name, shape] of Object.entries(shapes)) {
	const runs = [];
	let last = {};
	for (let i = 0; i < REPS; i++) {
		const r = await once(shape);
		if (r.err) { console.log(`${name.padEnd(7)} ERROR ${r.err}`); break; }
		spend += r.cost; runs.push(r.ttft); last = r;
	}
	if (!runs.length) continue;
	console.log([name.padEnd(7), String(last.kb).padStart(6), String(last.ptok).padStart(10),
		String(last.cached).padStart(8), '  ' + runs.join(', ')].join(''));
}
console.log(`\nspent on ${MODEL}: $${spend.toFixed(4)}`);
