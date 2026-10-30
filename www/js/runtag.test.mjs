/* ============================================================
   Test -- every row a handed-off run writes carries its turn's tag (UNBLOCK-1, check_fix3 F2).
   ------------------------------------------------------------
   THE FAULT. A runner's errand run tagged its answer with `iturn` and nothing else: the `tool_log`, `error_log`,
   `fold_log`, `vision_log`, `leak_log`, files and end rows it wrote went untagged. When a queued prompt landed before
   the running turn's answer (P5, P6, turn 5's tool row, A5), `turnSpan` read the untagged tool row by position as
   turn 6's: turn 5's frame lacked it, and turn 6's drew it, one run stamp away from being tombstoned.

   THE FIX. `runTurn` writes every row through `pushRunRow`, which tags it with the errand's `turnId`, as the answer
   row is tagged. Since check_fix5 H1 a local turn tags its rows too, with its prompt's id (`umid`, which is the
   errand's `turnId` when there is one): an untagged local answer below a queued prompt was put in that prompt's turn.

   WHAT IS CHECKED. The REAL `pushRunRow` lifted from daimond.js, the REAL `turnSpan` from peer.js, and, because
   `runTurn` is too large to run here (see prenote.test.mjs), its source: no row may reach `chat.messages` but
   through `pushRunRow`.

   Run:  node www/js/runtag.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}

/// The source of `function name(...) {...}`, brace-balanced, or null.
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return null;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

function loadPeer() {
	const store = new Map();
	const win = {
		addEventListener: () => {}, dispatchEvent: () => true,
		localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
	};
	const document = { readyState: 'complete', addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
	const body = readPage(join(HERE, 'peer.js'), 'utf8');
	new Function('window', 'document', 'localStorage', 'console', 'with (window) {\n' + body + '\n}')(
		win, document, win.localStorage, { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return win.DaimondPeer;
}

const run = lift(SRC, 'runTurn');
check('runTurn is a function of daimond.js', !!run);
const helper = lift(SRC, 'pushRunRow');
check('pushRunRow is a function of daimond.js', !!helper);

if (run) {
	console.log('runTurn writes its rows through one door');
	const direct = (run.match(/chat\.messages\.push\(/g) || []).length;
	check('no row reaches chat.messages but through pushRunRow', direct === 0, direct + ' direct push(es)');
	check('and the door is used', /pushRunRow\(chat, umid, /.test(run));
	check('every row is tagged with the prompt\'s id, a local turn\'s too (check_fix5 H1)',
		!/pushRunRow\(chat, opts\.turnId/.test(run) && !/if \(opts\.turnId\) amsg\.iturn/.test(run));
	check('the turn\'s working is tagged as well', /logThinking\(chat, [^;]*, umid\)/.test(run));
}

// A local turn's rows now carry its id while it runs, so a tab that dies after a tool row was saved holds rows tagged
// with the journalled turn. Recovery took any such row for "already recovered" and dropped the turn's journal entry.
const recover = lift(SRC, 'recoverInterrupted') || '';
check('recovery is not fooled by a running turn\'s own tagged rows',
	!!recover && !/some\(function \(m\) \{ return m\.iturn === iturn; \}\)/.test(recover)
	&& /m\.iturn === iturn && m\.interrupted/.test(recover));

if (helper) {
	const pushRunRow = new Function('logTurnRows', helper + '\nreturn pushRunRow;')(() => {});	// the log writer is turnwrite.test's
	console.log('the tag');
	const chat = { messages: [] };
	const tool = pushRunRow(chat, 't5', { role: 'tool_log', mid: 'k5' });
	check('an errand run tags its row with the turn', tool.iturn === 't5' && chat.messages[0] === tool, chat.messages);
	const own = pushRunRow(chat, 't5', { role: 'assistant', mid: 'x', iturn: 'other' });
	check('a row already tagged keeps its own tag', own.iturn === 'other');
	const loc = pushRunRow(chat, 'u9', { role: 'error_log', mid: 'e1' });
	check("a local turn's row carries its prompt's id", loc.iturn === 'u9' && chat.messages.length === 3);

	console.log("the runner's 3d order: P5, P6 (queued), turn 5's tool row, A5");
	const P = loadPeer();
	const rows = [
		{ role: 'user', mid: 't5', iturn: 't5', content: 'continue' },
		{ role: 'user', mid: 't6', iturn: 't6', content: 'continue' },
	];
	const c = { messages: rows };
	pushRunRow(c, 't5', { role: 'tool_log', mid: 'k5' });
	pushRunRow(c, 't5', { role: 'assistant', mid: 'a5', iturn: 't5', content: 'done' });
	const s5 = P.turnSpan(c.messages, 't5').map((m) => m.mid), s6 = P.turnSpan(c.messages, 't6').map((m) => m.mid);
	check("turn 5's frame holds its tool row", JSON.stringify(s5) === JSON.stringify(['k5', 'a5']), s5);
	check("and turn 6's does not draw it", s6.indexOf('k5') < 0, s6);
}

// check_fix6 M2: a turn that pauses or fails with a partial answer tagged every row from its prompt to the chat's end
// with its own id. A prompt another device sent during the run, and that prompt's answer, became this turn's, and
// Retry, Continue or Answer-again tombstoned them on every device. Since H1 every row the turn writes carries its id,
// so the prompt alone is tagged.
const tagger = lift(SRC, 'tagPrompt');
check('tagPrompt is a function of daimond.js', !!tagger);
if (run) {
	check('runTurn re-tags no row by position (pause and failed-with-partial paths)',
		// Three since UNBLOCK-7 F2: the engine killed under the turn hands it back as the road does.
		!/\.iturn = umid/.test(run) && (run.match(/tagPrompt\(chat, umid\)/g) || []).length === 3,
		(run.match(/[^\n]*\.iturn = umid[^\n]*/g) || []).map((l) => l.trim()));
}
if (tagger) {
	console.log("a peer's turn synced in during this turn's run (check_fix6 M2)");
	const touched = [];
	const tagPrompt = new Function('touchMsg', tagger + '\nreturn tagPrompt;')((m) => touched.push(m.mid));
	const P = loadPeer();
	const chat = { messages: [
		{ role: 'user', mid: 'u4', content: 'q4' }, { role: 'assistant', mid: 'a4', iturn: 'u4', content: 'four' },
		{ role: 'user', mid: 'u5', content: 'q5' }, { role: 'tool_log', mid: 't5', iturn: 'u5', content: 'x' },
		{ role: 'user', mid: 'u6', content: 'q6 (from the other device)' }, { role: 'assistant', mid: 'a6', iturn: 'u6', content: 'six' }] };
	const um = tagPrompt(chat, 'u5');
	check('the prompt is tagged with its own id', um === chat.messages[2] && um.iturn === 'u5' && touched.join() === 'u5', touched);
	check("the other device's prompt and answer keep their own turn", chat.messages[4].iturn === undefined && chat.messages[5].iturn === 'u6');
	const span = P.turnSpan(chat.messages, 'u5').map((m) => m.mid);
	check("turn 5's span does not draw turn 6's rows", span.indexOf('u6') < 0 && span.indexOf('a6') < 0, span);
	check('no prompt, nothing tagged', tagPrompt(chat, 'nope') === null && touched.length === 1);
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS') + ' (' + checks + ' checks)');
process.exit(failures ? 1 : 0);
