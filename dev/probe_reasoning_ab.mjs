// What `reasoning: {exclude: true}` is actually worth — the A/B, 2026-08-28.
//
// A single sample of each had suggested that asking OpenRouter to omit the reasoning
// made a round twice as fast.  It also showed the reasoning-token count moving between
// runs, which is enough to explain the whole difference on its own, so the wall clock
// was confounded and could not be quoted.  This runs the pair INTERLEAVED -- default and
// then excluded, back to back, same task, same minute -- so provider load drifts across
// both arms rather than into one, and it reports the reasoning-token count beside every
// timing so the confound is visible rather than assumed.
//
// It reports, per arm: seconds, bytes on the wire, SSE chunks, prompt/completion/reasoning
// tokens, and the cost OpenRouter itself charged.  Bytes and cost are what the arms can be
// compared on honestly.  Seconds are printed and should be read with the token counts.
//
// IT SPENDS REAL MONEY.  About a third of a cent a round.  Not part of dev/run_all.sh.
//
//   OPENROUTER_KEY=... node dev/probe_reasoning_ab.mjs [--n 5] [--models a,b]

const KEY = process.env.OPENROUTER_KEY;
if (!KEY) {
	console.error('Set OPENROUTER_KEY. This spends real money and no key lives in this file.');
	process.exit(2);
}
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const N = Number(arg('n', 5));
const MODELS = String(arg('models', 'z-ai/glm-5.2,deepseek/deepseek-v4-pro')).split(',');

// One task, fixed, and hard enough that the model actually reasons. Every arm of every
// sample sends exactly this.
const TASK = 'A shop sells pens at 43p and pencils at 27p. Someone spends exactly £10.00 '
	+ 'on 30 items. How many of each? Show your working.';

async function once(model, exclude) {
	const body = {
		model,
		messages: [{ role: 'user', content: TASK }],
		stream: true,
		max_tokens: 2000,
		stream_options: { include_usage: true },
	};
	if (exclude) body.reasoning = { exclude: true };
	const t0 = Date.now();
	const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
		method: 'POST',
		headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
	const reader = res.body.getReader();
	let bytes = 0, chunks = 0, buf = '', usage = null, firstByteMs = null;
	const dec = new TextDecoder();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (firstByteMs === null) firstByteMs = Date.now() - t0;
		bytes += value.length;
		buf += dec.decode(value, { stream: true });
		let i;
		while ((i = buf.indexOf('\n\n')) !== -1) {
			const ev = buf.slice(0, i); buf = buf.slice(i + 2);
			const line = ev.split('\n').find(l => l.startsWith('data: '));
			if (!line) continue;
			const data = line.slice(6);
			if (data === '[DONE]') continue;
			chunks++;
			try { const j = JSON.parse(data); if (j.usage) usage = j.usage; } catch {}
		}
	}
	const ms = Date.now() - t0;
	const u = usage || {};
	return {
		ms, firstByteMs, bytes, chunks,
		prompt:     u.prompt_tokens || 0,
		completion: u.completion_tokens || 0,
		reasoning:  (u.completion_tokens_details || {}).reasoning_tokens || 0,
		cost:       u.cost || 0,
	};
}

const rows = [];
for (const model of MODELS) {
	for (let i = 0; i < N; i++) {
		// INTERLEAVED, and in this order every time: whatever the provider is doing at
		// this minute, both arms are inside it.
		for (const exclude of [false, true]) {
			let r;
			try { r = await once(model, exclude); }
			catch (e) { console.error('  ' + e.message); continue; }
			rows.push({ model, arm: exclude ? 'exclude' : 'default', i, ...r });
			console.log(`${model.padEnd(26)} ${(exclude ? 'exclude' : 'default').padEnd(8)}`
				+ ` #${i + 1}  ${(r.ms / 1000).toFixed(1)}s  ${(r.bytes / 1024).toFixed(0)}KB`
				+ `  ${String(r.chunks).padStart(5)} chunks`
				+ `  reason ${String(r.reasoning).padStart(5)}  out ${String(r.completion).padStart(5)}`
				+ `  $${r.cost.toFixed(6)}`);
		}
	}
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
console.log('\n════ medians, and the total billed ════');
console.log('model                      arm       n   median s  median KB  median chunks  median reasoning tok  billed $');
for (const model of MODELS) {
	for (const arm of ['default', 'exclude']) {
		const r = rows.filter(x => x.model === model && x.arm === arm);
		if (!r.length) continue;
		console.log(`${model.padEnd(26)} ${arm.padEnd(8)} ${String(r.length).padStart(2)}`
			+ `  ${(med(r.map(x => x.ms)) / 1000).toFixed(1).padStart(8)}`
			+ `  ${(med(r.map(x => x.bytes)) / 1024).toFixed(0).padStart(9)}`
			+ `  ${String(med(r.map(x => x.chunks))).padStart(13)}`
			+ `  ${String(med(r.map(x => x.reasoning))).padStart(20)}`
			+ `  ${sum(r.map(x => x.cost)).toFixed(5).padStart(8)}`);
	}
}
console.log(`\ntotal billed this run: $${sum(rows.map(r => r.cost)).toFixed(5)}`);
console.log('\n' + JSON.stringify(rows));
