// mockcap.mjs — a mock provider that HONOURS max_tokens, and says what it saw.
//
// dev/mockllm.mjs ignores `max_tokens` entirely, so nothing driven through it
// can show what the reply-length cap actually does to a turn.  This one obeys
// it, which is the whole point: a reply longer than the cap is CUT, and when
// the thing being cut is a tool call's arguments — themselves a JSON string —
// what the client receives is a malformed tool call, not a short file.  That is
// the failure a 4096-token cap produced on any real file_write, and it can only
// be demonstrated against a provider that enforces the cap.
//
//   node dev/mockcap.mjs [port]        # default 9098
//
// The port is `DAIMOND_CAP_PORT` (or argv[2]) and the log `DAIMOND_CAP_LOG`, so
// this can be one fixture of a numbered world -- see dev/world.sh.  A shared log
// is the trap the ports alone do not close: two suites appending to one file make
// every assertion read another agent's traffic.
//
// Every request is appended to the log as one JSON line carrying the
// `max_tokens` the client asked for, so a test can assert on what Daimond SENT
// as well as on what it did with the reply.
//
// ── Directives (in the user's message, as with mockllm) ───────────────────
//
//   @write <lines> [path]    one `file_write` call whose content is <lines>
//                            numbered lines.  Cut at the cap if it does not fit.
//   @rounds <n>              an n-round tool loop: n-1 `file_list` calls then a
//                            text reply.  Round k reports prompt_tokens of
//                            ROUND_PROMPT*(k+1), so the rounds are all different
//                            and a meter that sums them is obvious.
//   @refuse-cap <n>          refuse any request asking for more than <n>, with
//                            the wording a real provider uses; answer the rest.
//   @text <words>            a plain reply.
//
// Tokens are counted at CHARS_PER_TOKEN characters each.  That is a stand-in for
// a real tokeniser, and it is the right kind of stand-in: the property under
// test is "the cap is enforced and the cut lands mid-string", which does not
// depend on the tokeniser being exact.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG  = process.env.DAIMOND_CAP_LOG || path.join(HERE, 'mockcap.log');
const PORT = Number(process.argv[2] || process.env.DAIMOND_CAP_PORT || 9098);

/// Characters per token, for the cap arithmetic.
const CHARS_PER_TOKEN = 4;

/// Prompt tokens round 0 reports; round k reports this times (k+1).
export const ROUND_PROMPT = 5000;

const MODELS = ['cap/plain', 'claude-opus-4-1', 'claude-opus-5'];

const log = (entry) => {
	try { fs.appendFileSync(LOG, JSON.stringify(entry) + '\n'); }
	catch (e) { console.error('mockcap: could not write log:', e.message); }
};

const cors = (res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

const lastUser = (messages) => {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			const c = messages[i].content;
			return typeof c === 'string' ? c
				: Array.isArray(c) ? c.map(p => p.text || '').join(' ') : '';
		}
	}
	return '';
};

// Tool replies since the last user message — the round number within this turn.
const toolRounds = (messages) => {
	let at = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') { at = i; break; }
	}
	return messages.slice(at + 1).filter(m => m.role === 'tool').length;
};

const parseDirective = (text) => {
	const t = (text || '').trim();
	if (!t.startsWith('@')) return { kind: 'plain', rest: t };
	const sp = t.indexOf(' ');
	return {
		kind: (sp === -1 ? t : t.slice(0, sp)).slice(1),
		rest: sp === -1 ? '' : t.slice(sp + 1).trim(),
	};
};

/// A file body of `n` numbered lines — long enough that its own length, not the
/// wrapper, is what decides whether the reply fits.
const body = (n) => Array.from({ length: n },
	(_, i) => `\tconst line_${i + 1} = compute(${i + 1});   // generated line ${i + 1}`).join('\n');

const sendJson = (res, obj, code = 200) => {
	const s = JSON.stringify(obj);
	cors(res);
	res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
	res.end(s);
};

/// Decide the turn from the directive, the round, and the cap the client asked
/// for.  `cut` is true when the cap bit — the client should see `length`.
const plan = (messages, maxTokens) => {
	const d      = parseDirective(lastUser(messages));
	const rounds = toolRounds(messages);
	const budget = Math.max(1, (maxTokens || 4096)) * CHARS_PER_TOKEN;

	switch (d.kind) {
		case 'write': {
			if (rounds > 0) return { text: 'Written.', prompt: ROUND_PROMPT };
			const [linesRaw, pathRaw] = d.rest.split(/\s+/);
			const lines = Math.max(1, Number(linesRaw) || 400);
			const file  = pathRaw || 'generated.js';
			const args  = JSON.stringify({ path: file, content: body(lines) });
			const cut   = args.length > budget;
			return {
				calls:  [{ id: 'call_1', type: 'function',
					function: { name: 'file_write', arguments: cut ? args.slice(0, budget) : args } }],
				cut,
				prompt: ROUND_PROMPT,
			};
		}

		case 'rounds': {
			const n = Math.max(1, Number(d.rest) || 3);
			// Round k's prompt is (k+1) times the base, so every round differs and
			// the sum is unmistakably not the last one.
			const prompt = ROUND_PROMPT * (rounds + 1);
			if (rounds < n - 1) {
				return {
					calls: [{ id: `call_${rounds + 1}`, type: 'function',
						function: { name: 'file_list', arguments: JSON.stringify({ path: '.' }) } }],
					prompt,
				};
			}
			return { text: `Done after ${n} rounds.`, prompt };
		}

		case 'refuse-cap': {
			const limit = Math.max(1, Number(d.rest) || 8192);
			if ((maxTokens || 0) > limit) return { refuse: limit };
			if (rounds > 0) return { text: 'Fine at this length.', prompt: ROUND_PROMPT };
			return { text: 'Fine at this length.', prompt: ROUND_PROMPT };
		}

		case 'text':
		default:
			if (rounds > 0) return { text: 'Done.', prompt: ROUND_PROMPT };
			return { text: d.rest || 'Right.', prompt: ROUND_PROMPT };
	}
};

const usageOf = (p, outChars) => ({
	prompt_tokens:     p.prompt || ROUND_PROMPT,
	completion_tokens: Math.ceil(outChars / CHARS_PER_TOKEN),
	total_tokens:      (p.prompt || ROUND_PROMPT) + Math.ceil(outChars / CHARS_PER_TOKEN),
});

/// Stream the turn as SSE, in the shape the OpenAI-compatible wire uses.
const stream = async (res, model, p, maxTokens) => {
	cors(res);
	res.writeHead(200, {
		'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive',
	});
	const send  = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
	const frame = (delta, finish = null) => ({
		id: 'chatcmpl-cap', object: 'chat.completion.chunk', created: 1700000000, model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	});

	send(frame({ role: 'assistant', content: '' }));
	let outChars = 0;

	if (p.calls) {
		p.calls.forEach((c, i) => {
			send(frame({ tool_calls: [{ index: i, id: c.id, type: 'function',
				function: { name: c.function.name, arguments: '' } }] }));
		});
		for (const [i, c] of p.calls.entries()) {
			const a = c.function.arguments;
			outChars += a.length;
			// Dribbled in pieces, as a provider does, so an accumulator that keeps
			// only the last fragment is caught here too.
			const step = Math.max(1, Math.ceil(a.length / 6));
			for (let at = 0; at < a.length; at += step) {
				send(frame({ tool_calls: [{ index: i, function: { arguments: a.slice(at, at + step) } }] }));
			}
		}
		// `length` when the cap bit — the same finish reason a real provider sends,
		// and the one nothing in the client currently reads.
		send(frame({}, p.cut ? 'length' : 'tool_calls'));
	} else {
		const words = (p.text || '').split(' ');
		for (const w of words) {
			if (res.writableEnded || res.destroyed) return;
			outChars += w.length + 1;
			send(frame({ content: w + ' ' }));
		}
		send(frame({}, 'stop'));
	}

	send({ id: 'chatcmpl-cap', object: 'chat.completion.chunk', model, choices: [],
		usage: usageOf(p, outChars) });
	res.write('data: [DONE]\n\n');
	res.end();
};

const server = http.createServer((req, res) => {
	if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

	if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
		return sendJson(res, { object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) });
	}
	if (req.method !== 'POST') { cors(res); res.writeHead(404); return res.end(); }

	let raw = '';
	req.on('data', c => { raw += c; });
	req.on('end', async () => {
		let payload;
		try { payload = JSON.parse(raw); }
		catch { return sendJson(res, { error: { message: 'mockcap: body was not JSON' } }, 400); }

		const messages  = payload.messages || [];
		const maxTokens = payload.max_tokens;
		// The whole point of the log: what the client ASKED FOR, per request.
		log({ at: new Date().toISOString(), model: payload.model, max_tokens: maxTokens,
			stream: !!payload.stream, rounds: toolRounds(messages) });

		const p = plan(messages, maxTokens);

		if (p.refuse) {
			// The wording a real OpenAI-compatible provider uses when the reply
			// length asked for is above what the model will generate.
			return sendJson(res, { error: {
				message: `max_tokens is too large: ${maxTokens}. This model supports at most ${p.refuse} completion tokens.`,
				type: 'invalid_request_error', param: 'max_tokens',
			} }, 400);
		}
		if (payload.stream) return stream(res, payload.model || 'cap/plain', p, maxTokens);
		return sendJson(res, {
			id: 'chatcmpl-cap', object: 'chat.completion', created: 1700000000,
			model: payload.model || 'cap/plain',
			choices: [{ index: 0,
				message: p.calls ? { role: 'assistant', content: null, tool_calls: p.calls }
					: { role: 'assistant', content: p.text },
				finish_reason: p.cut ? 'length' : (p.calls ? 'tool_calls' : 'stop') }],
			usage: usageOf(p, 0),
		});
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`mockcap: http://127.0.0.1:${PORT}/v1/chat/completions  (log: ${LOG})`);
});
