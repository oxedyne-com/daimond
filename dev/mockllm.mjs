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
//   @narrate <words> ;; <name> <json>
//   @reason <working> ;; <answer>
//                           the model THINKS before it answers, on the wire the way
//                           OpenRouter sends it: `delta.reasoning` with the same words
//                           repeated in `delta.reasoning_details`, and `content` empty
//                           until the working is done. A client that reads both fields
//                           shows every word twice, which is what this is for.
//   @reasonslow <working> ;; <answer>
//                           the same as @reason, paced the way a real reasoning round
//                           is paced, so a check can look at the page while the model
//                           is still thinking rather than only after.
//   @reasonc <working> ;; <answer>
//                           the same, spelled `delta.reasoning_content` -- which is
//                           what DeepSeek's own endpoint calls it, and the reason the
//                           accumulator reads two field names.
//   @reasontool <working> ;; <name> <json>
//                           working, then a tool call and no text at all: the round
//                           that spends a minute and a half thinking and then says one
//                           word, which is the round this was all built for.
//                            PROSE AND THEN A TOOL CALL, in one assistant message,
//                            then a text reply once the tool returns. Every other
//                            directive here emits `content: null` beside its calls,
//                            so until 2026-08-23 NO fixture in this repository
//                            produced the shape a real provider produces constantly
//                            -- the model saying "let me check the line numbers"
//                            and then checking them. That is the shape the owner
//                            read twenty of in one turn while asking where the
//                            folding was, and nothing could have caught it, because
//                            nothing could make it happen.
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
//   @drop <n>                stream n words, then DESTROY the socket -- the road
//                            failing part way through an answer, which is not the
//                            same event as the provider refusing and must not be
//                            treated as one. There was no way to produce it, so
//                            the branch that tells them apart could not be tested.
//   @slow <ms>               reply after a delay
//   @look <path>             the model that keeps trying to LOOK. It answers with
//                            `file_read {"path":…,"as":"image"}` until a tool result
//                            has come back, and with words afterwards. Unlike every
//                            directive above it is read from the WHOLE transcript
//                            rather than from the last user message, because a worker
//                            moved to another model is RESUMED -- its new session is
//                            seeded with its own task and text and the last thing in
//                            it is the app's nudge. A mock that only read the last
//                            message would answer that nudge with prose, the second
//                            leg would carry no picture, and a verifier could not
//                            tell a correct re-route from a broken one.
//
// ── Two roles are answered by their SYSTEM prompt, not by a directive ─────
//
// A reducer and a triage both have a fixed ANSWER SHAPE that the app parses, so
// a mock replying with prose could not drive either feature at all.  Both are
// recognised the way a real one is -- by the role they were given -- and both
// still lose to `@text`, so a test that wants a malformed answer can ask for one.
//
//   reducer   system prompt mentions "crystal"; answered with a crystal whose
//             summary is the delta's own words.
//   triage    system prompt opens "triaging one person's notes"; answered with a
//             plan for www/js/triage.js.  `MOCK_TRIAGE_PLAN=<file>` answers with
//             that file, so a test can replay a real model's clustering; without
//             it, one draft per note id found in the brief.
//
// Anything else gets a short generic reply.  Every request is appended to
// dev/mockllm.log as JSON lines, so a test can assert on what the model was
// actually shown — the system prompt, the tool results, the whole transcript.
//
// ── Blindness is a property of the MODEL NAME ─────────────────────────────
//
// A model whose id contains `blind` refuses any request that carries a picture, with
// the 400 and the words a real provider uses; `mock/eyes` takes it.  Both answer at
// THIS endpoint, with this key, at the same time, which is the whole point: a test of
// vision routing has to watch the work move from one model to another, and if
// blindness were a directive or a flag it would be a property of the REQUEST — the
// very thing the app under test is being asked to change.  So it is a property of the
// name, which is what it is in the real world.
//
// The refusal's shape is not decorative.  `LlmClient::stream_turn` (src/llm.rs, the
// `!started && !retried_blind && images > 0` arm) learns that an endpoint is blind by
// being refused ONCE: it calls `mark_blind`, takes the pictures out, and sends the same
// turn again.  A 200 saying no, or a refusal before the pictures are logged, teaches it
// nothing.  Hence: log first, then refuse, with `image_url` in the provider's own words.
//
// Every logged request carries `images` — how many picture parts it held, in either
// dialect — and a refused one carries `refusedImages`.  Those two fields are what let a
// verifier say "the second leg named the other model AND carried the picture", which is
// what a re-route looks like from outside.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The log is per-world, not per-repo: two mocks appending to one file make every
// assertion that reads it see another agent's traffic.  See dev/world.sh.
const LOG  = process.env.DAIMOND_MOCK_LOG || path.join(HERE, 'mockllm.log');
const PORT = Number(process.argv[2] || process.env.DAIMOND_MOCK_PORT || 9099);

// ── WHICH REVISION OF THIS FILE IS ANSWERING ────────────────────────────────
//
// A port is not evidence of anything, and neither is a log path. `world.sh --up`
// deliberately ADOPTS a mock it finds already listening, and `requireOwnMock` in
// dev/harness.mjs then asks it which file it writes -- which settles whether it is
// this WORLD'S mock and says nothing about whether it is this TREE'S.
//
// Those two questions came apart on 2026-08-28. A world was brought up, the tree
// under it was then merged forward, and the mock from before the merge kept
// answering: same port, same log path, so every existing guard passed. It did not
// know the directives the merge had added, so it fell through to `Mock reply to:
// <the whole directive line>` -- and `dev/verify_thinking.mjs` went red on twelve
// checks, one of which reported that the model's reasoning had been stored as its
// answer. Nothing of the sort had happened. The mock had echoed the prompt, the
// prompt contained the markers the check looks for, and the most alarming message
// the suite can print was produced by a fixture rather than by the product.
//
// The exact-source question is the one that catches it, and it catches every other
// version of it at the same time -- a directive whose meaning changed, a bug fixed
// in the fixture, an argument parsed differently -- where a capability list would
// only catch a name that was missing.
//
// `directives` rides along because a hash cannot say WHAT is different. It is read
// out of this file's own `case` labels rather than written down beside them, so it
// cannot drift from what the switch actually answers to.
const SELF = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
const SHA  = crypto.createHash('sha256').update(SELF).digest('hex');
const DIRECTIVES = [...new Set(
	[...SELF.matchAll(/^\t\tcase '([a-z0-9]+)':/gm)].map(m => m[1]))].sort();

const MODELS = [
	'mock/fast',
	'mock/thinker',
	'accounts/fireworks/models/glm-5p2',
	// Appended, never inserted: dev/verify_diamondmodels.mjs picks "the first model
	// in the pulldown that is not the one already chosen", so the order of the three
	// above is load-bearing for a file that is not about vision at all.
	'mock/blind',
	'mock/eyes',
];

/// Is this a model that cannot be shown pictures?
///
/// Substring, like [`model_can_see`]'s deny-list in src/llm.rs, so a test can mint a
/// second blind model — `mock/blind-too` — without touching this file. That is what
/// the no-ping-pong check needs: a Diamond whose IMAGE model is itself blind.
const isBlindModel = (model) => /blind/i.test(String(model || ''));

/// How many picture parts a request carries, in either wire dialect.
///
/// OpenAI puts them in the content array as `{"type":"image_url",…}` and the Messages
/// API as `{"type":"image","source":{…}}`; both are counted because the mock does not
/// know which dialect the caller configured.
const imageCount = (messages) => (messages || []).reduce((n, m) => {
	const c = m && m.content;
	if (!Array.isArray(c)) return n;
	return n + c.filter((p) => p && (p.type === 'image_url' || p.type === 'image')).length;
}, 0);

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

// The path a `@look` named, from ANY user message in the conversation, or ''.
//
// The whole transcript rather than the last message, and see the header for why: a
// resumed worker's last user message is the app's own nudge, not its task. The last
// occurrence wins, so a second `@look` in a later turn replaces the first.
const lookPath = (messages) => {
	let found = '';
	for (const m of messages || []) {
		if (!m || m.role !== 'user') continue;
		const c = typeof m.content === 'string' ? m.content
			: Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join(' ')
			: '';
		const hit = /(^|\s)@look\s+(\S+)/.exec(c);
		if (hit) found = hit[2];
	}
	return found;
};

// Has this session already been handed a tool result?  Anywhere in the transcript,
// not just since the last user message, because a look that already happened must not
// happen again inside the same session however many nudges follow it.
const hasLooked = (messages) => (messages || []).some(m => m && m.role === 'tool');

const parseDirective = (text) => {
	const t = (text || '').trim();
	if (!t.startsWith('@')) return { kind: 'plain', text: t };
	const sp   = t.indexOf(' ');
	const verb = (sp === -1 ? t : t.slice(0, sp)).slice(1);
	const rest = sp === -1 ? '' : t.slice(sp + 1).trim();
	return { kind: verb, rest };
};

// A directive argument that cannot be read is REFUSED, never defaulted.
//
// This was `Number(d.rest)`, and `d.rest` is the whole of the line after the verb.
// So `@slow 9000 A-ANSWER` was `Number('9000 A-ANSWER')` -- NaN -- and the `|| 2000`
// beside it turned that into the two-second default. A check that asked for a nine
// second delay got two, silently, and went green for a reason unconnected to what it
// was testing. `dev/verify_daimonconc.mjs` lost an afternoon to it and left a comment
// warning the next reader off the label rather than fixing the mock.
//
// A trailing label is legitimate and stays legal: it is how a caller makes one prompt
// distinguishable from the next in the mock's log. So the FIRST token is the number,
// and the rest is the caller's business.
//
// What is not legal is an argument that is not a number. That throws, becomes a 400,
// and reddens the run. A harness that fails quietly is worse than one that fails
// loudly, because it launders a broken check into a green result.
class DirectiveError extends Error {}

const numArg = (rest, dflt, verb) => {
	const head = String(rest == null ? '' : rest).trim().split(/\s+/)[0];
	if (head === '') return dflt;
	const n = Number(head);
	if (!Number.isFinite(n)) {
		throw new DirectiveError(
			`@${verb} wants a number as its first word, got ${JSON.stringify(head)}`);
	}
	return n;
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

/// Whether this request is a triage of somebody's notes into proposals.
///
/// The Social panel's drafting (`www/js/triage.js`) has a fixed answer shape --
/// one JSON object holding `drafts` and `left` -- which the panel then parses,
/// so a mock answering it with prose could not drive the feature at all. Matched
/// on the system prompt's own opening sentence, which is the role.
const isTriage = (messages) => (messages || []).some((m) =>
	m && m.role === 'system' && /triaging one person's notes/i.test(String(m.content || '')));

/// A plan, as `www/js/triage.js` parses one.
///
/// `MOCK_TRIAGE_PLAN` names a file holding the plan to answer with, and a test
/// that wants to assert on a REAL model's clustering points it at one that a
/// real model produced. Without it, a draft per note id found in the brief --
/// which asserts nothing about clustering and everything about the notes having
/// reached the model at all, the way `crystalReply` echoes the delta's words
/// rather than answering a fixed string.
const triageReply = (brief) => {
	const named = process.env.MOCK_TRIAGE_PLAN;
	if (named) {
		try { return fs.readFileSync(named, 'utf8'); }
		catch { /* fall through to the derived plan, which says so in its titles */ }
	}
	const ids = [...String(brief || '').matchAll(/^id (\S+)$/gm)].map(m => m[1]);
	return JSON.stringify({
		drafts: ids.map((id) => ({
			kind:  'new',
			title: `Mock draft from ${id}`,
			body:  'Derived by dev/mockllm.mjs from the brief it was given.',
			from:  [id],
			why:   'One draft per note, because no plan file was named.',
		})),
		left: [],
	}, null, 2);
};

const plan = (messages) => {
	const d      = parseDirective(lastUser(messages));
	const rounds = toolRounds(messages);

	// A worker that was told to look keeps trying until it has looked.  Before the
	// switch, so a RESUMED session -- whose last user message is the app's nudge and
	// whose task is buried two messages up -- still asks for the picture.  Reached only
	// by a conversation that actually carries `@look`: every other transcript takes the
	// path it took yesterday, byte for byte.
	//
	// AND BEFORE THE REDUCER, which is not where it was first put.  `isReducer` matches
	// any conversation whose SYSTEM prompt says "crystal", and a worker's does: its role
	// prompt is composed with the Diamond's crystal.  So every worker request whose last
	// user message is not a directive -- the tool-result round, and the app's own nudge
	// on a resumed leg -- was being answered with a crystal proposal.  Harmless while the
	// re-route does not exist, and fatal the moment it does: the second leg's first
	// request would have been answered with JSON instead of a `file_read`, no picture
	// would ever have reached the sighted model, and dev/verify_vision.mjs's first check
	// would have failed against a working fix.  A worker is not a reducer, and a
	// conversation carrying `@look` is never a fold.
	if (d.kind === 'look' || d.kind === 'plain') {
		const look = lookPath(messages);
		if (look) {
			if (!hasLooked(messages)) {
				return { calls: [toolCall(nextCallId(), 'file_read', { path: look, as: 'image' })] };
			}
			// Names the file, so a resumed session's seeded assistant message is
			// recognisable as THIS worker's own earlier words and not a generic reply.
			return { text: `Looked at ${look}.` };
		}
	}

	// Before the directives: a reducer answered with prose is a fold that cannot
	// land. `@text` and the rest still win, so a test that wants to exercise a
	// MALFORMED proposal -- and one does -- can still ask for one.
	if (isReducer(messages) && d.kind === 'plain') {
		return { text: crystalReply(d.text || d.rest || '') };
	}

	// And a triage answered with prose is a plan the Social panel cannot read.
	// Recognised by ROLE, exactly as the reducer above is and for the same
	// reason: a real triage is recognisable the same way, and every test that
	// drafts from a list of notes needs the same answer. `@text` still wins, so
	// a test that wants an unreadable plan -- and one does -- can ask for one.
	if (isTriage(messages) && d.kind === 'plain') {
		return { text: triageReply(lastUser(messages)) };
	}

	switch (d.kind) {
		case 'text':
			return { text: d.rest || 'Right.' };

		case 'long': {
			const n = Math.max(1, numArg(d.rest, 40, 'long'));
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
			return { httpError: numArg(d.rest, 500, 'err') };

		// A connection that dies mid-answer. `n` words arrive first so the partial
		// reply is a real one -- a drop before the first token is a different and
		// much easier case, and the app retries THAT one on its own.
		case 'drop': {
			const n = Math.max(1, numArg(d.rest, 3, 'drop'));
			return { text: Array.from({ length: n }, (_, i) => `word-${i + 1}`).join(' '),
				dropAfter: n };
		}

		case 'slow':
			return { text: 'Eventually.', delayMs: numArg(d.rest, 2000, 'slow') };

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

		// ── The model's own working ──────────────────────────────────────
		//
		// `reasoning` is streamed BEFORE any content, which is the order every
		// reasoning provider sends it in and the order that makes a round look like
		// a hang: the wire is busy for the whole of it and the page has nothing.
		case 'reason':
		case 'reasonc':
		case 'reasonslow': {
			const [think, said] = d.rest.split(';;');
			return {
				think:      (think || 'Let me work this out.').trim(),
				thinkKey:   d.kind === 'reasonc' ? 'reasoning_content' : 'reasoning',
				text:       (said || 'Done thinking.').trim(),
				// A REAL ROUND SPENDS MINUTES HERE. A check that wants to look at the
				// page WHILE the model is thinking cannot do it at five milliseconds a
				// word, so the slow form exists to be looked at.
				slowChunks: d.kind === 'reasonslow',
			};
		}

		case 'reasontool': {
			if (rounds > 0) return { text: 'Reasoned and done.' };
			const [think, call] = d.rest.split(';;');
			const { name, args } = splitCall((call || 'file_list {"path":"."}').trim());
			return {
				think:    (think || 'I should look first.').trim(),
				thinkKey: 'reasoning',
				text:     '',
				calls:    [toolCall(nextCallId(), name, args)],
			};
		}

		// Reason, CALL a tool, then reason AGAIN before answering — the real DeepSeek
		// shape the owner hit (a tool between two reasoning steps). Round 0 streams
		// reasoning then a tool call; round 1 streams MORE reasoning then the answer.
		// Used to prove a Tool tile renders BETWEEN the two Thinking tiles.
		//   @rtr <think1> ;; <name> <json> ;; <think2>
		case 'rtr': {
			const [t1, call, t2] = d.rest.split(';;');
			if (rounds > 0) {
				return {
					think:    (t2 || 'Now I can answer.').trim(),
					thinkKey: 'reasoning',
					text:     'Reasoned and done.',
				};
			}
			const { name, args } = splitCall((call || 'file_list {"path":"."}').trim());
			return {
				think:    (t1 || 'Let me use a tool first.').trim(),
				thinkKey: 'reasoning',
				text:     '',
				calls:    [toolCall(nextCallId(), name, args)],
			};
		}

		// Prose, then a call, in ONE message. See the directive list.
		case 'narrate': {
			if (rounds > 0) return { text: 'Narration done.' };
			const [say, call] = d.rest.split(';;');
			const { name, args } = splitCall((call || 'file_list {"path":"."}').trim());
			return { text: (say || '').trim(), calls: [toolCall(nextCallId(), name, args)] };
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
		// BOTH, when a turn has both. `content: null` beside `tool_calls` was the only
		// shape this mock could make, and a real provider sends prose alongside a call
		// all the time -- which is how the narration fault stayed invisible to every
		// fixture here. `text` stays null when there is none, so nothing else moves.
		message: calls
			? { role: 'assistant', content: text || null, tool_calls: calls }
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

	// The working first, word by word, with `content` empty throughout -- which is
	// exactly what a real provider sends and exactly what used to reach the page as
	// nothing at all. `reasoning_details` carries the same words a second time, as
	// OpenRouter's does, so a client reading both is caught here rather than in front
	// of a user.
	if (p.think) {
		const key = p.thinkKey || 'reasoning';
		let at = 0;
		for (const w of p.think.split(' ').filter(Boolean)) {
			if (res.writableEnded || res.destroyed) return;
			const piece = w + ' ';
			const delta = { content: '', role: 'assistant' };
			delta[key] = piece;
			if (key === 'reasoning') {
				delta.reasoning_details = [
					{ type: 'reasoning.text', text: piece, format: 'unknown', index: at++ }];
			}
			send(frame(delta));
			await sleep(p.slowChunks ? 120 : 5);
		}
		// And the null the providers send once the working is over.
		send(frame({ content: '', role: 'assistant', [key]: null }));
	}

	if (p.calls) {
		// The preamble, word by word, BEFORE the call frames -- which is the order a
		// provider sends it in and the order the app has to cope with.
		for (const w of (p.text || '').split(' ').filter(Boolean)) {
			if (res.writableEnded || res.destroyed) return;
			send(frame({ content: w + ' ' }));
			await sleep(5);
		}
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
		let sent = 0;
		for (const w of words) {
			if (res.writableEnded || res.destroyed) return;	// the client aborted
			send(frame({ content: w + ' ' }));
			sent++;
			// THE SOCKET IS DESTROYED, not ended: an `end()` is a well-formed stream
			// that stops, which the client reads as a finished turn. A destroy is the
			// road going away mid-sentence, with no `[DONE]` and no finish reason,
			// which is what a laptop lid or a lost access point actually does.
			if (p.dropAfter && sent >= p.dropAfter) {
				res.destroy();
				return;
			}
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
		// `sha` and `directives` say which REVISION is answering; see the note beside
		// them. `log` says which world. A caller needs both and they are different
		// questions.
		return sendJson(res, { log: LOG, port: PORT, pid: process.pid,
			sha: SHA, directives: DIRECTIVES });
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
		// A blind model refuses a picture; the count is needed either way, because a
		// verifier reads it back to say which leg carried one.
		const images  = imageCount(messages);
		const refused = images > 0 && isBlindModel(payload.model);
		log({
			at:        new Date().toISOString(),
			model:     payload.model,
			stream:    !!payload.stream,
			tools:     (payload.tools || []).map(t => t.function?.name).filter(Boolean),
			auth:      !!(req.headers.authorization),
			images,		// picture parts in this request, either dialect
			...(refused ? { refusedImages: true } : {}),
			messages,	// the whole transcript, so a test can assert what was sent
		});

		// THE REFUSAL A REAL PROVIDER SENDS, and it is logged before it is sent: the
		// request that was turned away is the evidence that the app was on the wrong
		// model, so a mock that refused before logging would hide the very thing.
		//
		// 400 with the provider's own words about `image_url`. `stream_turn` does not
		// read them -- it retries on any refusal of a turn that carried pictures -- but
		// `vision_error` (src/llm.rs) does, and it only names the model when the
		// provider's sentence is about images. So the wording is part of the fixture.
		if (refused) {
			return sendJson(res, { error: {
				message: 'this model does not support image_url content',
				type:    'invalid_request_error',
				param:   'messages',
				code:    'unsupported_content',
			} }, 400);
		}

		// A directive the mock cannot read is a fault in the CHECK, not in the app,
		// and it is reported where a lane will actually see it: on stderr, which
		// world.sh keeps in the world's `mock.out`, and as a 400 that fails the turn.
		// The old behaviour -- substitute the default and carry on -- is what made
		// `@slow 9000 A-ANSWER` a two-second delay for weeks.
		let p;
		try {
			p = plan(messages);
		} catch (e) {
			if (e instanceof DirectiveError) {
				console.error(`mockllm: REFUSED a directive it could not read -- ${e.message}`);
				return sendJson(res, { error: {
					message: `mockllm: ${e.message}`,
					type:    'invalid_request_error',
				} }, 400);
			}
			throw e;
		}

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
