// Mock LLM provider — an OpenAI-compatible endpoint that answers to a script.
//
// The agent loop is the one part of Daimond that could never be driven in a
// test, because it needs a real provider and a real key.  This stands in for
// one: it speaks the same wire format (streaming and not, tool calls and not),
// but what it says is dictated by a directive in the user's own message, so a
// test can ask for exactly the reply it wants to exercise.
//
//   node dev/mockllm.mjs [port]        # default 9099
//
// Point Daimond at it with provider "Custom" and base URL
//   http://127.0.0.1:9099/v1/chat/completions
// Any key is accepted.
//
// ── The directive language ────────────────────────────────────────────────
// A user message beginning with `@` is a directive to the mock, not a prompt.
//
//   @text <words>            plain assistant reply
//   @long <n>                stream <n> chunks slowly (exercises Stop/abort)
//   @tool <name> <json>      one tool call, then a text reply once it returns
//   @tools <name> <json> ;; <name> <json>   several tool calls in one turn
//   @chain <name> <json>     tool call, then a second call, then text
//   @usage <in> <out>        reply reporting those token counts (the meter)
//   @err <code>              fail with that HTTP status (the error path)
//   @slow <ms>               reply after a delay
//
// Anything else gets a short generic reply.  Every request is appended to
// dev/mockllm.log as JSON lines, so a test can assert on what the model was
// actually shown — the system prompt, the tool results, the whole transcript.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG  = path.join(HERE, 'mockllm.log');
const PORT = Number(process.argv[2] || 9099);

const MODELS = [
	'mock/fast',
	'mock/thinker',
	'accounts/fireworks/models/glm-5p2',
];

// Requests are logged for assertion, newest last.  A test truncates the file
// first, then reads it back to see what the model saw.
const log = (entry) => {
	try {
		fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
	} catch (e) {
		console.error('mockllm: could not write log:', e.message);
	}
};

const cors = (res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

// The last thing the user actually typed, which is where a directive lives.
const lastUser = (messages) => {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			const c = messages[i].content;
			return typeof c === 'string' ? c
				: Array.isArray(c) ? c.map(p => p.text || '').join(' ')
				: '';
		}
	}
	return '';
};

// How many tool results have come back WITHIN the current turn — that is, since
// the last user message. Counting the whole conversation would be wrong now that
// tool calls persist across turns: a later @tool directive would see an earlier
// turn's results and wrongly believe its own round had already happened.
const toolRounds = (messages) => {
	let lastUserIdx = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') { lastUserIdx = i; break; }
	}
	return messages.slice(lastUserIdx + 1).filter(m => m.role === 'tool').length;
};

const parseDirective = (text) => {
	const t = (text || '').trim();
	if (!t.startsWith('@')) return { kind: 'plain', text: t };
	const sp   = t.indexOf(' ');
	const verb = (sp === -1 ? t : t.slice(0, sp)).slice(1);
	const rest = sp === -1 ? '' : t.slice(sp + 1).trim();
	return { kind: verb, rest };
};

// A tool call as the wire format wants it: the arguments are a JSON *string*,
// which is the detail most hand-rolled clients get wrong.
const toolCall = (id, name, args) => ({
	id,
	type: 'function',
	function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

// Split "<name> <json>" — the JSON may itself contain spaces.
const splitCall = (s) => {
	const i = s.indexOf(' ');
	if (i === -1) return { name: s.trim(), args: {} };
	const name = s.slice(0, i).trim();
	const raw  = s.slice(i + 1).trim();
	try {
		return { name, args: JSON.parse(raw) };
	} catch {
		return { name, args: {} };
	}
};

// Decide the turn: text, or calls, or a failure — from the directive and how
// many tool rounds have already come back.
const plan = (messages) => {
	const d      = parseDirective(lastUser(messages));
	const rounds = toolRounds(messages);

	switch (d.kind) {
		case 'text':
			return { text: d.rest || 'Right.' };

		case 'long': {
			const n = Math.max(1, Number(d.rest) || 40);
			return { text: Array.from({ length: n }, (_, i) => `chunk-${i + 1}`).join(' ') , slowChunks: true };
		}

		case 'usage': {
			const [i, o] = d.rest.split(/\s+/).map(Number);
			return { text: 'Counted.', usage: { prompt_tokens: i || 100, completion_tokens: o || 50 } };
		}

		case 'err':
			return { httpError: Number(d.rest) || 500 };

		case 'slow':
			return { text: 'Eventually.', delayMs: Number(d.rest) || 2000 };

		case 'tool': {
			if (rounds > 0) return { text: 'Tool done.' };
			const { name, args } = splitCall(d.rest);
			return { calls: [toolCall('call_1', name, args)] };
		}

		case 'tools': {
			if (rounds > 0) return { text: 'Tools done.' };
			const calls = d.rest.split(';;').map((part, i) => {
				const { name, args } = splitCall(part.trim());
				return toolCall(`call_${i + 1}`, name, args);
			});
			return { calls };
		}

		case 'chain': {
			// Two rounds of one call each, then a text reply — the shape a real
			// agentic turn takes, and the one the UI has to keep up with.
			if (rounds === 0) {
				const { name, args } = splitCall(d.rest);
				return { calls: [toolCall('call_1', name, args)] };
			}
			if (rounds === 1) {
				return { calls: [toolCall('call_2', 'file_list', { path: '.' })] };
			}
			return { text: 'Chain done.' };
		}

		default:
			if (rounds > 0) return { text: 'Done.' };
			return { text: `Mock reply to: ${d.text || d.rest || '(empty)'}` };
	}
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const sendJson = (res, obj, code = 200) => {
	const body = JSON.stringify(obj);
	cors(res);
	res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	res.end(body);
};

const completion = (model, { text, calls, usage }) => ({
	id: 'chatcmpl-mock',
	object: 'chat.completion',
	created: 1700000000,
	model,
	choices: [{
		index: 0,
		message: calls
			? { role: 'assistant', content: null, tool_calls: calls }
			: { role: 'assistant', content: text },
		finish_reason: calls ? 'tool_calls' : 'stop',
	}],
	usage: usage || { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 },
});

// Stream the same turn as SSE deltas.  Tool calls stream as fragments of their
// argument JSON, because that is how the providers do it and it is where an
// accumulator breaks.
const stream = async (res, model, p) => {
	cors(res);
	res.writeHead(200, {
		'content-type':  'text/event-stream',
		'cache-control': 'no-cache',
		'connection':    'keep-alive',
	});
	const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
	const frame = (delta, finish = null) => ({
		id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1700000000, model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	});

	send(frame({ role: 'assistant', content: '' }));

	if (p.calls) {
		p.calls.forEach((c, i) => {
			send(frame({ tool_calls: [{ index: i, id: c.id, type: 'function',
				function: { name: c.function.name, arguments: '' } }] }));
		});
		// Dribble the arguments out in two pieces, so an accumulator that only
		// keeps the last fragment is caught.
		for (const [i, c] of p.calls.entries()) {
			const a   = c.function.arguments;
			const cut = Math.max(1, Math.floor(a.length / 2));
			send(frame({ tool_calls: [{ index: i, function: { arguments: a.slice(0, cut) } }] }));
			await sleep(10);
			send(frame({ tool_calls: [{ index: i, function: { arguments: a.slice(cut) } }] }));
		}
		send(frame({}, 'tool_calls'));
	} else {
		const words = (p.text || '').split(' ');
		for (const w of words) {
			if (res.writableEnded || res.destroyed) return;	// the client aborted
			send(frame({ content: w + ' ' }));
			await sleep(p.slowChunks ? 120 : 5);
		}
		send(frame({}, 'stop'));
	}

	send({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', model, choices: [],
		usage: p.usage || { prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 } });
	res.write('data: [DONE]\n\n');
	res.end();
};

const server = http.createServer((req, res) => {
	if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

	if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
		// A test can drive the rejected-key path with the sentinel key "reject".
		const auth = req.headers.authorization || '';
		if (/\breject\b/.test(auth)) {
			return sendJson(res, { error: { message: 'mock: invalid api key' } }, 401);
		}
		return sendJson(res, { object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) });
	}

	if (req.method !== 'POST') { cors(res); res.writeHead(404); return res.end(); }

	let body = '';
	req.on('data', c => { body += c; });
	req.on('end', async () => {
		let payload;
		try {
			payload = JSON.parse(body);
		} catch {
			return sendJson(res, { error: { message: 'mock: body was not JSON' } }, 400);
		}

		const messages = payload.messages || [];
		log({
			at:        new Date().toISOString(),
			model:     payload.model,
			stream:    !!payload.stream,
			tools:     (payload.tools || []).map(t => t.function?.name).filter(Boolean),
			auth:      !!(req.headers.authorization),
			messages,	// the whole transcript, so a test can assert what was sent
		});

		const p = plan(messages);

		if (p.httpError) {
			return sendJson(res, { error: { message: 'mock: as requested' } }, p.httpError);
		}
		if (p.delayMs) await sleep(p.delayMs);

		if (payload.stream) return stream(res, payload.model || 'mock/fast', p);
		return sendJson(res, completion(payload.model || 'mock/fast', p));
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`mockllm: http://127.0.0.1:${PORT}/v1/chat/completions  (log: ${LOG})`);
});
