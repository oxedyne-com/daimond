/* ============================================================
   Test -- the conversation comes back from a runner (KT-5, binding 16).
   ------------------------------------------------------------
   A runner's turn ran its engine there: its tool calls, their ids and any fold were the runner's
   alone, and the tab's `chat.session` kept the conversation from before the turn. The runner's
   report now carries the session after the turn (`session`: `{msgs, turnStart, base, upto,
   uptoTs}`), and the tab's hand-off settle (`settleRunnerSession`) stores it through the same
   `captureSession` path a local turn takes, as the chat's session or the Diamond's.

   WHAT IS CHECKED. The REAL `settleRunnerSession`, `captureSession`, `keepChatTaint` and
   `sessionMarker`, lifted from daimond.js over stubs:
     (b) a chat's and a Diamond's session are stored, marked on the final frame's row, and a
         chat's engine is dropped so the next Here turn is laid from it; a Diamond's next turn is
         laid by the REAL `daimonPrior` from the stored session, tool calls kept;
     (c) a stored session that moved meanwhile (`upto` is not the errand's `base`) is left alone,
         and the diagnostics say the engine is laid from the transcript;
     (d) a report that says the session stayed on the runner changes nothing, and says so.

   Run:  node www/js/kt5session.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
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

const T0 = 1790000000000;
const ask = (t, ts, text) => ({ role: 'user', mid: t, iturn: t, ts, content: text });
const ans = (t, mid, ts, text) => ({ role: 'assistant', mid, iturn: t, ts, content: text });
/// The runner's session after turn t2: the prior turn, then t2 with its tool call and answer.
const RUN_MSGS = [
	{ role: 'user', content: 'q1', mid: 'u1' },
	{ role: 'assistant', content: 'a1-words' },
	{ role: 'user', content: 'read it', mid: 't2' },
	{ role: 'assistant', content: '', tool_calls: [{ id: 'call_9', name: 'file_read', arguments: '{}' }] },
	{ role: 'tool', content: 'ran', tool_call_id: 'call_9' },
	{ role: 'assistant', content: 'it says 7' },
];
/// A chat that ran turn 1 here, then handed t2 to a runner, whose final row has landed.
function chat(over) {
	return Object.assign({
		id: 'c1', _loaded: true, app: { stale: true },
		messages: [ask('u1', T0, 'q1'), ans('u1', 'a1', T0 + 1, 'a1-words'), ask('t2', T0 + 2, 'read it'),
			ans('t2', 'e-k5-final', T0 + 3, 'it says 7')],
		session: { v: 1, upto: 'a1', uptoTs: T0 + 1, marks: { u1: 0 },
			msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' }] },
	}, over || {});
}
function report(over) {
	return Object.assign({ t: 'report', status: 'done', turnId: 't2', chatId: 'c1', finalTail: 1,
		session: { v: 1, msgs: RUN_MSGS, turnStart: 2, base: 'a1', upto: 'e-k5-final', uptoTs: T0 + 3 } }, over || {});
}

const st = { diags: [], held: null, saved: 0 };
const stubs = {
	diag: (tag, d) => st.diags.push(tag + ' ' + d),
	chatHoldingTurn: () => st.held,
	touchChat() {}, persistChats: () => { st.saved++; },
	markChatTainted: () => false,
	loadMsgTombs: () => ({}),
};
const names = ['settleRunnerSession', 'staleEngine', 'captureSession', 'sessionHeld', 'keepChatTaint', 'sessionMarker', 'engineHolds'];
const missing = names.filter((n) => !lift(SRC, n));
check('the hand-off settle stores the session through daimond.js', missing.length === 0, missing);
const F = missing.length ? null : new Function('window', ...Object.keys(stubs),
	names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { settleRunnerSession, captureSession };');
const win = { DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' && r.status !== 'parked' } };
const api = F ? F(win, ...Object.values(stubs)) : null;
// The daimon's history, as a Diamond turn lays it (`daimonPrior`), lifted with what it calls.
const priorNames = ['daimonPrior', 'dedupeSession', 'tailAfter', 'sessionDoubt', 'foldGap', 'foldCover', 'foldHeld', 'sessionMarker'];
const priorMissing = priorNames.filter((n) => !lift(SRC, n));
check('the daimon\'s history is laid by daimond.js', priorMissing.length === 0, priorMissing);
const prior = priorMissing.length ? null : new Function('diag', priorNames.map((n) => lift(SRC, n)).join('\n')
	+ '\nreturn { daimonPrior };')((tag, d) => st.diags.push(tag + ' ' + d));
function settle(c, r) {
	st.held = c; st.diags = []; st.saved = 0;
	try { return api ? api.settleRunnerSession(r) : ''; } catch (e) { return 'threw ' + e.message; }
}

// (b) A chat: the runner's session is the chat's, marked on the final row; its engine goes.
{
	const c = chat();
	const out = settle(c, report());
	check('(b) a chat stores the runner\'s session', out === 'stored'
		&& JSON.stringify(c.session.msgs) === JSON.stringify(RUN_MSGS), { out, session: c.session });
	check('(b) its marker stands on the final frame\'s row', c.session.upto === 'e-k5-final' && c.session.uptoTs === T0 + 3,
		c.session);
	check('(b) each prompt is marked where it starts, as captureSession marks a local turn\'s',
		c.session.marks && c.session.marks.t2 === 2 && c.session.marks.u1 === 0, c.session.marks);
	check('(b) the chat\'s engine is dropped, so the next Here turn is laid from the session', c.app === null, c.app);
	check('(b) the record is saved', st.saved > 0);
}
// (b) A Diamond's record: the daimon's session is the runner's.
{
	const d = chat({ id: 'dc1', diamondId: 'd1', app: undefined });
	const out = settle(d, report({ chatId: 'dc1' }));
	check('(b) a Diamond\'s record stores the runner\'s session', out === 'stored'
		&& JSON.stringify(d.session.msgs) === JSON.stringify(RUN_MSGS) && d.session.upto === 'e-k5-final', { out, s: d.session });
}
// (b) A Diamond, on to its next turn: the daimon has no engine of its own to drop (it runs on the
// Diamond's), and each turn lays it by `daimonPrior` from the record `settleRunnerSession` stored on,
// which is the record a Diamond turn reads (`runSteerHeld`'s `rec`, `daimonChat`: the chat whose
// `diamondId` is the Diamond, the one `chatHoldingTurn` finds by the turn's prompt).
{
	const kept = { daimon: true };
	const d = chat({ id: 'dc2', diamondId: 'd1', app: kept });
	const out = settle(d, report({ chatId: 'dc2' }));
	check('(b) a Diamond\'s record keeps what it holds as app', out === 'stored' && d.app === kept, { out, app: d.app });
	d.messages.push(ask('t3', T0 + 4, 'and now?'));
	let laid = null;
	try { laid = prior ? prior.daimonPrior(d, 't3') : null; } catch (e) { laid = 'threw ' + e.message; }
	check('(b) the daimon\'s next turn is laid from the runner\'s session, its tool call kept',
		JSON.stringify(laid) === JSON.stringify(RUN_MSGS), laid);
}
// (c) The stored session moved meanwhile: left alone, and said.
{
	const c = chat();
	c.session = Object.assign({}, c.session, { upto: 'a9' });
	const before = JSON.stringify(c.session);
	const out = settle(c, report());
	check('(c) a moved session is left as it is', out === 'moved' && JSON.stringify(c.session) === before, { out, s: c.session });
	check('(c) the chat\'s engine, from before the turn, is dropped (QA ccp1 H1)', c.app === null, c.app);
	check('(c) the diagnostics say the engine is laid from the transcript',
		st.diags.some((d) => /moved/.test(d) && /transcript/.test(d)), st.diags);
}
// (d) The session stayed on the runner (over the door): nothing stored, and said.
{
	const c = chat();
	const before = JSON.stringify(c.session);
	const out = settle(c, report({ session: undefined, sessionStayed: 1 }));
	check('(d) a stayed session stores nothing', out === 'stayed' && JSON.stringify(c.session) === before, { out });
	check('(d) the diagnostics say the session stayed on the runner and the transcript lays the engine',
		st.diags.some((d) => /stayed/.test(d) && /transcript/.test(d)), st.diags);
}
// A hand-back or a parked report carries no session to store.
{
	const c = chat();
	const before = JSON.stringify(c.session);
	settle(c, report({ status: 'parked' }));
	check('a parked report stores nothing', JSON.stringify(c.session) === before);
}
// A local turn's capture is unchanged by the runner's path.
{
	const c = chat();
	if (api) api.captureSession(c, { export_session: () => RUN_MSGS.slice(0, 2) });
	check('a local captureSession still marks the last row it holds', c.session.upto === 'e-k5-final'
		&& c.session.msgs.length === 2, c.session);
}

console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
