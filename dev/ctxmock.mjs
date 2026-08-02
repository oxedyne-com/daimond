// A mock provider that behaves like a real one about its context window.
//
// dev/mockllm.mjs accepts a request of any size, so nothing in the suite has ever
// exercised the failure this compactor exists to fix.  This one refuses, with the
// status and the wording an OpenAI-compatible provider actually uses:
//
//   400 {"error":{"message":"This model's maximum context length is N tokens,
//        however you requested M tokens", "code":"context_length_exceeded"}}
//
//   node ctxmock.mjs [port] [limit-tokens]
//
// Directives, as dev/mockllm.mjs spells them, plus:
//   @big <kb>       a reply of roughly <kb> kilobytes, streamed fast
//
// Every request is logged as a JSON line to ctxmock.log, whole, so a test can check
// what the model was really shown -- including whether the tool calls in it were paired.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const LOG   = path.join(HERE, 'ctxmock.log');
const PORT  = Number(process.argv[2] || 9188);
const LIMIT = Number(process.argv[3] || 12000);   // tokens

const MODELS = ['mock/fast', 'mock/thinker'];

const log = (e) => { try { fs.appendFileSync(LOG, JSON.stringify(e) + '\n'); } catch {} };

const cors = (res) => {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Headers', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
};

// The provider's own tokeniser, standing in: four bytes to a token, applied to the
// whole request body exactly as a provider would count what it was sent.
const countTokens = (payload) => Math.ceil(JSON.stringify(payload).length / 4);

const lastUser = (messages) => {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') return String(messages[i].content || '');
	}
	return '';
};

const toolRounds = (messages) => {
	let at = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') { at = i; break; }
	}
	return messages.slice(at + 1).filter(m => m.role === 'tool').length;
};

const toolCall = (id, name, args) => ({
	id, type: 'function',
	function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

const splitCall = (s) => {
	const i = s.indexOf(' ');
	if (i === -1) return { name: s.trim(), args: {} };
	try { return { name: s.slice(0, i).trim(), args: JSON.parse(s.slice(i + 1).trim()) }; }
	catch { return { name: s.slice(0, i).trim(), args: {} }; }
};

const plan = (payload) => {
	const messages = payload.messages || [];
	const system   = (messages[0] && messages[0].role === 'system') ? String(messages[0].content) : '';

	// The compaction call, answered as a summariser would. Recognised by its own
	// prompt, so a test can prove the summary reached the conversation.
	if (system.includes('folding the earlier part')) {
		return { text: 'SUMMARY-FROM-MODEL: the user asked for two files; both were written.' };
	}

	const t = lastUser(messages).trim();
	const rounds = toolRounds(messages);
	if (!t.startsWith('@')) return { text: rounds > 0 ? 'Done.' : `Mock reply to: ${t.slice(0, 60)}` };
	const sp   = t.indexOf(' ');
	const verb = (sp === -1 ? t : t.slice(0, sp)).slice(1);
	const rest = sp === -1 ? '' : t.slice(sp + 1).trim();

	switch (verb) {
		case 'text': return { text: rest || 'Right.' };
		case 'big': {
			const kb = Math.max(1, Number(rest) || 8);
			const chunk = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do '
				+ 'eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
			return { text: chunk.repeat(Math.ceil(kb * 1024 / chunk.length)).slice(0, kb * 1024) };
		}
		case 'tool': {
			if (rounds > 0) return { text: 'Tool done.' };
			const { name, args } = splitCall(rest);
			return { calls: [toolCall('call_' + Date.now(), name, args)] };
		}
		default: return { text: rounds > 0 ? 'Done.' : `Mock reply to: ${t.slice(0, 60)}` };
	}
};

const sendJson = (res, obj, code = 200) => {
	const body = JSON.stringify(obj);
	cors(res);
	res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
	res.end(body);
};

const stream = (res, model, p, used) => {
	cors(res);
	res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
	const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
	const frame = (delta, finish = null) => ({
		id: 'chatcmpl-ctxmock', object: 'chat.completion.chunk', model,
		choices: [{ index: 0, delta, finish_reason: finish }],
	});
	send(frame({ role: 'assistant', content: '' }));
	if (p.calls) {
		p.calls.forEach((c, i) => send(frame({ tool_calls: [{ index: i, id: c.id, type: 'function',
			function: { name: c.function.name, arguments: c.function.arguments } }] })));
		send(frame({}, 'tool_calls'));
	} else {
		// Big replies in a handful of frames rather than word by word: this mock exists to
		// make conversations long, not to make tests slow.
		const text = p.text || '';
		for (let i = 0; i < text.length; i += 2048) send(frame({ content: text.slice(i, i + 2048) }));
		send(frame({}, 'stop'));
	}
	send({ id: 'chatcmpl-ctxmock', object: 'chat.completion.chunk', model, choices: [],
		usage: { prompt_tokens: used, completion_tokens: 20, total_tokens: used + 20 } });
	res.write('data: [DONE]\n\n');
	res.end();
};

const server = http.createServer((req, res) => {
	if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
	if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
		return sendJson(res, { object: 'list', data: MODELS.map(id => ({ id, object: 'model' })) });
	}
	if (req.method !== 'POST') { cors(res); res.writeHead(404); return res.end(); }

	let body = '';
	req.on('data', c => { body += c; });
	req.on('end', () => {
		let payload;
		try { payload = JSON.parse(body); }
		catch { return sendJson(res, { error: { message: 'not JSON' } }, 400); }

		const used = countTokens(payload);
		const over = used > LIMIT;
		log({ at: new Date().toISOString(), used, limit: LIMIT, refused: over,
			messages: payload.messages || [], tools: (payload.tools || []).length });
		if (over) {
			return sendJson(res, { error: {
				message: `This model's maximum context length is ${LIMIT} tokens, however you `
					+ `requested ${used} tokens. Please reduce the length of the messages.`,
				type: 'invalid_request_error', code: 'context_length_exceeded',
			} }, 400);
		}
		const p = plan(payload);
		if (payload.stream) return stream(res, payload.model || 'mock/fast', p, used);
		return sendJson(res, {
			id: 'chatcmpl-ctxmock', object: 'chat.completion', model: payload.model || 'mock/fast',
			choices: [{ index: 0, message: p.calls
				? { role: 'assistant', content: null, tool_calls: p.calls }
				: { role: 'assistant', content: p.text },
				finish_reason: p.calls ? 'tool_calls' : 'stop' }],
			usage: { prompt_tokens: used, completion_tokens: 20, total_tokens: used + 20 },
		});
	});
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`ctxmock: http://127.0.0.1:${PORT}/v1/chat/completions  limit=${LIMIT} tokens  log=${LOG}`);
});
