// looptext.test.mjs -- a reply is its last round's prose, every round's words stay apart, and every
// turn is told what day it is (drive 2026-10-12, D-20261011-34).
//
//	node --test www/js/looptext.test.mjs
//	LOOPTEXT_PKG=/path/to/www/pkg node --test www/js/looptext.test.mjs	# the date against a given build
//
// The daimon's reply read "…unchanged.Now let me verify…", "…for v3.Done —", and printed a sentence
// twice: every round's prose ran on into one answer with nothing between them. `runTurn` had kept
// the rule since 2026-09-13 -- prose before a tool call is working, the answer is the round after
// the last tool -- and the daimon's loop, the worker's narration and the journal's recovery had
// not. The three event handlers are LIFTED from the real sources by a scan that skips strings and
// comments, and run in a scope that stubs every name the test does not care about, so an edit that
// lets a round run on into the next fails here. The date is read from the real engine's briefing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP  = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const JRNL = readFileSync(join(HERE, 'journal.js'), 'utf8');

// The balanced `{…}` that opens at or after `from`, skipping strings, templates and comments.
function block(src, from) {
	let i = src.indexOf('{', from), depth = 0;
	for (; i < src.length; i++) {
		const c = src[i], n = src[i + 1];
		if (c === '/' && n === '/') { i = src.indexOf('\n', i); continue; }
		if (c === '/' && n === '*') { i = src.indexOf('*/', i) + 1; continue; }
		if (c === '"' || c === "'" || c === '`') {
			for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
			continue;
		}
		if (c === '{') depth++;
		else if (c === '}' && --depth === 0) return src.slice(src.indexOf('{', from), i + 1);
	}
	throw new Error('unbalanced from ' + from);
}

// The `function (ev) {…}` assigned to `head`, in the occurrence whose body names `marker`.
function liftHandler(src, head, marker) {
	let at = -1;
	while ((at = src.indexOf(head, at + 1)) !== -1) {
		const body = block(src, at);
		if (body.includes(marker)) return 'function (ev) ' + body;
	}
	throw new Error('no ' + head + ' naming ' + marker);
}

function liftFn(src, name) {
	const at = src.indexOf('function ' + name + '(');
	if (at === -1) throw new Error('no function ' + name);
	return src.slice(at, at + ('function ' + name).length) + src.slice(at + ('function ' + name).length, src.indexOf('{', at)) + block(src, at);
}

// Anything the handler reaches for and the test did not name: callable, indexable, truthy, and ''
// as a string, so a caption or a feed row costs nothing and asserts nothing.
const STUB = new Proxy(function () {}, {
	get: (t, k) => k === Symbol.toPrimitive ? () => '' : STUB,
	apply: () => STUB,
	set: () => true,
});

// A sloppy-mode `with` over a scope that answers every free name: the test's own where it named
// one, the real global for the language's own (`String`, `JSON`, `Date`), and the stub otherwise.
function run(code, own) {
	const scope = new Proxy(own, {
		has: (o, k) => k in o || !(k in globalThis),
		get: (o, k) => k in o ? o[k] : (k === Symbol.unscopables ? undefined : STUB),
		set: (o, k, v) => { o[k] = v; return true; },
	});
	return new Function('scope', 'with (scope) { return (' + code + '); }')(scope);
}

const ROUNDS = [
	{ type: 'text', content: "Metro 10M to 12M changes three numbers." },
	{ type: 'text', content: " The capture's outline shows the table." },
	{ type: 'tool_call', name: 'file_read', args: '{"path":"x"}', id: 'c1' },
	{ type: 'tool_result', name: 'file_read', content: 'ok', outcome: 'done' },
	{ type: 'text', content: "The capture's outline shows the table." },
	{ type: 'tool_call', name: 'file_edit', args: '{"path":"STATE.md"}', id: 'c2' },
	{ type: 'tool_result', name: 'file_edit', content: 'ok', outcome: 'done' },
	{ type: 'text', content: 'Done: three numbers changed.' },
];

test("the daimon's reply is its last round's prose, and the rounds before are working", () => {
	const msgs = [];
	const own = { replyText: '', detached: null, rec: { messages: msgs, app: null },
		touchMsg: () => {}, newMid: () => 'm' + msgs.length };
	own.logThinking = run(liftFn(APP, 'logThinking'), own);
	const onEvent = run(liftHandler(APP, 'var onEvent = function (ev)', 'replyText +='), own);
	for (const ev of ROUNDS) onEvent(ev);
	// The answer, once, and only the answer.
	assert.equal(own.replyText, 'Done: three numbers changed.');
	assert.doesNotMatch(own.replyText, /\.\S/, 'one round ran on into the next');
	// The working is on the record, each run of it before the call it led to.
	assert.deepEqual(msgs.map((m) => m.role), ['think_log', 'tool_log', 'think_log', 'tool_log']);
	assert.equal(msgs[0].content, "Metro 10M to 12M changes three numbers. The capture's outline shows the table.");
	assert.equal(msgs[2].content, "The capture's outline shows the table.");
});

test("a worker's narration keeps each round a paragraph of its own, on the tile and in the journal", () => {
	const sent = [];
	const J = { agentDelta: (id, t) => { sent.push(t); } };
	const run0 = { id: 'r1', text: '', tools: [] };
	const own = { run: run0, wstep: 0, chats: [], DaimondJournal: J, window: { DaimondJournal: J } };
	const sink = run(liftHandler(APP, 'var sink = function (ev)', 'run._tail'), own);
	for (const ev of ROUNDS) sink(ev);
	assert.equal(run0.text, "Metro 10M to 12M changes three numbers. The capture's outline shows the table."
		+ "\n\nThe capture's outline shows the table.\n\nDone: three numbers changed.");
	// What a recovered run rebuilds is what the tile showed.
	assert.equal(sent.join(''), run0.text);
	// And the report the daimon is sent is still the last round alone.
	assert.equal(run0._tail, 'Done: three numbers changed.');
});

test('a recovered turn answers with the prose after its last tool, and keeps the rest as working', () => {
	let k = 0;
	const rows = [{ type: 'turn_open', stream: 't1', chatId: 'c', text: 'go' }];
	for (const ev of ROUNDS) {
		if (ev.type === 'text') rows.push({ type: 'delta', stream: 't1', chatId: 'c', text: ev.content });
		if (ev.type === 'tool_call') rows.push({ type: 'tool_open', stream: 't1', chatId: 'c', callId: ev.id, name: ev.name, args: ev.args });
		if (ev.type === 'tool_result') rows.push({ type: 'tool_done', stream: 't1', chatId: 'c', callId: 'c' + (++k), result: 'ok', outcome: 'done' });
	}
	const own = { turns: {}, agents: {} };
	const at = JRNL.indexOf('rows.forEach(function (e)');
	run('function () { rows.forEach(function (e) ' + block(JRNL, at) + '); }', Object.assign(own, { rows }))();
	const t = own.turns.t1;
	assert.equal(t.text, 'Done: three numbers changed.');
	assert.deepEqual(t.tools.map((x) => x.said), [
		"Metro 10M to 12M changes three numbers. The capture's outline shows the table.",
		"The capture's outline shows the table."]);
	// And the page puts each `said` on the record as working, before its call.
	const rec = block(APP, APP.indexOf('(t.tools || []).forEach(function (tl)'));
	const said = rec.indexOf('logThinking(chat, tl.said, iturn)'), log = rec.indexOf("role: 'tool_log'");
	assert.ok(said !== -1 && said < log, 'the recovered working is not put before its call');
});

// ── Today, in every conversation's opening turn note (the real engine) ──────────
// r578 (rulings §17): the date changes daily, so it rides in the turn note's <today> block, not
// the frozen system message; the block is restated whenever its text differs from its last copy
// and after a fold (prompts::turn_note, agent::restate_blocks).
const PKG = process.env.LOOPTEXT_PKG || join(HERE, '..', 'pkg');

test("every conversation's first turn note carries today's date in ISO and the user's zone", { skip: !existsSync(join(PKG, 'oxedyne_daimond_bg.wasm')) && 'no www/pkg wasm here' }, async () => {
	const m = await import(join(PKG, 'oxedyne_daimond.js'));
	m.initSync({ module: readFileSync(join(PKG, 'oxedyne_daimond_bg.wasm')) });
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'test-model', 4096, '', true);
	// A chat's own wire is wire_chat_system's: wire_system is a Diamond's and takes no lists from the page (HIST-SAFE U2).
	// `note` is what the next turn sends; with no conversation yet it is the opening note, every block.
	const wire = JSON.parse(await app.wire_chat_system());
	const m2 = wire.note.match(/^<today>\n([\s\S]*?)\n<\/today>$/m);
	assert.ok(m2, "the opening turn note carries no <today> block:\n" + wire.note);
	const brief = m2[1];
	// And not in the frozen system message, which would break the cached prefix every day.
	assert.ok(!wire.machine.includes('## Today'), 'the date is back in the system message:\n' + wire.machine);
	const d = new Date();
	const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
	assert.ok(brief.includes(iso), "the briefing does not say today's date:\n" + brief);
	assert.ok(brief.includes(Intl.DateTimeFormat().resolvedOptions().timeZone), 'nor where:\n' + brief);
	assert.ok(brief.includes('ISO 8601'), brief);
	// ISO for the model whatever the page shows: never a Holocene year.
	assert.ok(!brief.includes('1' + iso), brief);
});
