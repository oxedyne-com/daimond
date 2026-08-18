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
//   @usage <in> <out> [cost] [cached]
//                            reply reporting those token counts, and -- when the
//                            trailing two are given -- the USD the provider says
//                            the call cost and the prompt tokens it served from
//                            its cache. The trailing pair is what a router
//                            actually sends (`cost`, and `cached_tokens` nested
//                            in `prompt_tokens_details`), and it is the only way
//                            a test can prove the app bills the REPORTED figure
//                            rather than its own table's guess.
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
// The log is per-world, not per-repo: two mocks appending to one file make every
// assertion that reads it see another agent's traffic.  See dev/world.sh.
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');
const PORT = Number(process.argv[2] || process.env.DAIMOND_MOCK_PORT || 9099);

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

// A fresh tool-call id, unique for the life of this mock.
//
// It used to mint `call_1` on every turn, which meant two separate turns of one
// conversation both carried a call with the SAME id. No real provider does that,
// and a test asserting that a reloaded conversation is well formed cannot tell a
// duplicate the app caused from a duplicate the fixture caused. So the fixture
// stopped causing them. Nothing asserts on the literal value.
let callSeq = 0;
const nextCallId = () => `call_${++callSeq}`;

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
/// Whether this request is the crystal reducer's.
///
/// The reducer is a role of its own, with its own system prompt, and since the
/// crystal became `crystal.json` it must emit ONE WHOLE JSON OBJECT and nothing
/// else -- `crystal_proposal` refuses anything else before the user can accept it,
/// because accepting an unparseable proposal replaces the Diamond's memory with
/// something no reader downstream can open.
///
/// So a mock that answers every request with prose cannot drive a fold at all. It
/// is recognised here rather than in each verifier because a real reducer is
/// recognisable the same way -- by the role it was given -- and because every test
/// that folds needs the same answer.
const isReducer = (messages) => (messages || []).some((m) =>
	m && m.role === 'system' && /crystal/i.test(String(m.content || '')));

/// A crystal carrying `words`, as the core schema wants it.
///
/// The delta's own text goes in, because what the fold verifiers assert is that
/// the words a user typed reached the crystal -- a fixed reply would pass the
/// parse gate and prove nothing.
const crystalReply = (words) => JSON.stringify({
	title:   'Mock crystal',
	summary: String(words || '').slice(0, 400),
}, null, 2);

const plan = (messages) => {
	const d      = parseDirective(lastUser(messages));
	const rounds = toolRounds(messages);

	// Before the directives: a reducer answered with prose is a fold that cannot
	// land. `@text` and the rest still win, so a test that wants to exercise a
	// MALFORMED proposal -- and one does -- can still ask for one.
	if (isReducer(messages) && d.kind === 'plain') {
		return { text: crystalReply(d.text || d.rest || '') };
	}

	switch (d.kind) {
		case 'text':
			return { text: d.rest || 'Right.' };

		case 'long': {
			const n = Math.max(1, Number(d.rest) || 40);
			return { text: Array.from({ length: n }, (_, i) => `chunk-${i + 1}`).join(' ') , slowChunks: true };
		}

		case 'usage': {
			const [i, o, cost, cached] = d.rest.split(/\s+/).map(Number);
			const usage = { prompt_tokens: i || 100, completion_tokens: o || 50 };
			// Only when asked for. A `cost` of zero means "nobody said", and an
			// unconditional `cost: 0` would make every @usage turn claim the
			// provider had reported the call as free.
			if (isFinite(cost) && cost > 0) usage.cost = cost;
			// Where a router puts it: nested, not alongside the token counts.
			if (isFinite(cached) && cached > 0) usage.prompt_tokens_details = { cached_tokens: cached };
			return { text: 'Counted.', usage };
		}

		case 'err':
			return { httpError: Number(d.rest) || 500 };

		case 'slow':
			return { text: 'Eventually.', delayMs: Number(d.rest) || 2000 };

		case 'tool': {
			if (rounds > 0) return { text: 'Tool done.' };
			const { name, args } = splitCall(d.rest);
			return { calls: [toolCall(nextCallId(), name, args)] };
		}

		case 'tools': {
			if (rounds > 0) return { text: 'Tools done.' };
			const calls = d.rest.split(';;').map((part, i) => {
				const { name, args } = splitCall(part.trim());
				return toolCall(nextCallId(), name, args);
			});
			return { calls };
		}

		case 'chain': {
			// Two rounds of one call each, then a text reply — the shape a real
			// agentic turn takes, and the one the UI has to keep up with.
			if (rounds === 0) {
				const { name, args } = splitCall(d.rest);
				return { calls: [toolCall(nextCallId(), name, args)] };
			}
			if (rounds === 1) {
				return { calls: [toolCall(nextCallId(), 'file_list', { path: '.' })] };
			}
			return { text: 'Chain done.' };
		}

		case 'toolslow': {
			// One tool call, then a slow stream — so a running tile has booked
			// usage from round one (the meter) while still streaming round two.
			// Exercises live per-tile cost on a worker that is still running.
			if (rounds === 0) return { calls: [toolCall(nextCallId(), 'file_list', { path: '.' })] };
			return { text: Array.from({ length: 60 }, (_, i) => `chunk-${i + 1}`).join(' '), slowChunks: true };
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

	// WHICH LOG THIS MOCK WRITES TO, so a caller can identify the process holding
	// the port instead of trusting that it is the one it started.
	//
	// The log path is the whole of a world's mock identity: a verifier asserts on
	// what the model was sent by READING THE FILE, so a mock answering this port
	// while appending somewhere else makes every such assertion read an empty
	// file. That is not hypothetical. On 2026-08-17 a gate found :9108 already
	// held by an earlier gate's mock, left it alone, and set DAIMOND_MOCK_LOG to
	// its own worktree's copy -- which stayed 0 bytes for two hours. Eighteen or
	// more verifiers then reported "the provider was reached: no", "0 requests",
	// "nothing in the mock log", about turns that had in fact been answered
	// perfectly well by a mock writing to a path nobody was reading.
	if (req.method === 'GET' && req.url.startsWith('/__world')) {
		return sendJson(res, { log: LOG, port: PORT, pid: process.pid });
	}

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
