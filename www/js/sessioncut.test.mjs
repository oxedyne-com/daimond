/* ============================================================
   Test -- a retracted turn leaves the model's stored session too (UNBLOCK-1 1e).
   ------------------------------------------------------------
   THE FAULT. `chat.session` is the model's own conversation, stored at a turn's end, and a cache of the transcript.
   The sender's removals that ride an errand (`gone`) took the rows out of the runner's transcript and set
   `chat.app = null`, and `seedEngine` then laid the stored session back in, the retracted pair still in it: the model
   was fed q1, a1, q1', a1', q2. `retryTurn` (and `continueTurn`'s empty-partial path) did the same to a finished turn.

   THE FIX. `sessionCut` runs before the rows leave: where the session accounts for one of them (at or before its
   marker) it is emptied to the cleared form, so the next engine is laid from the transcript that remains. A row only
   in its tail, which it never held, leaves it alone. The `gone` branch is `honourGone`, lifted out of the reconstruct.

   WHAT IS CHECKED. The REAL `honourGone`, `retryTurn`, `sessionCut`, `tailAfter` and `seedEngine`, lifted from
   daimond.js over stubs, and an engine stand-in that keeps what it is seeded with.

   Run:  node www/js/sessioncut.test.mjs
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

class Engine {
	constructor() { this.msgs = []; }
	restore(hist) { this.msgs = hist.map((m) => (m.role === 'user' ? { role: m.role, content: m.content, mid: m.mid } : { role: m.role, content: m.content })); }
	restore_session(msgs) { this.msgs = msgs.map((x) => Object.assign({}, x)); return this.msgs.length; }
	append_message(role, content, pre, mid) { this.msgs.push(role === 'user' && mid ? { role, content, mid } : { role, content }); }
}

const T0 = 1790000000000;
const ask = (t, ts, text) => ({ role: 'user', mid: t, iturn: t, ts, content: text });
const ans = (t, mid, ts, text) => ({ role: 'assistant', mid, iturn: t, ts, content: text });
/// The chat after turn 1 ran here (and so stored its session), then q1' a1' and q2 asked.
function chatWithSession() {
	return {
		id: 'c1', messages: [ask('u1', T0, 'q1'), ans('u1', 'a1', T0 + 1, 'a1-words')],
		session: { v: 1, upto: 'a1', uptoTs: T0 + 1, msgs: [
			{ role: 'user', content: 'q1' },
			{ role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
			{ role: 'tool', content: 'ran', tool_call_id: 'call_1' },
			{ role: 'assistant', content: 'a1-words' },
		] },
	};
}
const sp = { tombs: [], ran: [] };
const st = {
	diag() {}, msgTombstone: (mids) => sp.tombs.push(...mids), touchChat() {}, persistChats() {}, renderHistory() {},
	dedupeSession: (m) => m, loadMsgTombs: () => ({}), ChatStore: { compact() {} }, newMid: () => 'n1',
	peerUiStateFor: () => '', selfDeviceId: () => 'D1', leaseClockNow: () => T0, answerAgain() {},
	diamonds: [], currentDiamond: null, runSteer: () => Promise.resolve(),
	maybeAutoDispatch: async () => false,		// the election keeps the retry here
	runTurn: (chat, text) => { sp.ran.push({ text, session: JSON.parse(JSON.stringify(chat.session || null)) }); return Promise.resolve(); },
};
const names = ['captureSession', 'tailAfter', 'sessionDoubt', 'sessionMarker', 'sessionCut', 'seedEngine', 'turnMessagesOf', 'askAgain', 'retryTurn', 'retryRouted', 'honourGone']
	.filter((n) => n !== 'sessionCut' || lift(SRC, n));	// absent before the fix, so the red is the behaviour below
const missing = names.filter((n) => !lift(SRC, n));
check('the gone removal is a function of daimond.js', missing.length === 0, missing);
const F = missing.length ? null : new Function('window', ...Object.keys(st),
	names.map((n) => lift(SRC, n)).join('\n') + '\nreturn { ' + names.join(', ') + ' };')({}, ...Object.values(st));

/// What the model would be fed by an engine rebuilt now, less the turn about to be sent.
function fed(chat, except) {
	chat.app = new Engine();
	F.seedEngine(chat, except, false);
	return chat.app.msgs.filter((m) => m.content && (m.role === 'user' || m.role === 'assistant')).map((m) => m.content);
}

if (F) {
	console.log('the gone removal on a runner that ran the retracted turn');
	{
		const chat = chatWithSession();
		chat._loaded = true;
		// The sender retracted u1 and asked q1' (u1b) and then q2 (u2); the runner holds q1 a1 q1' a1'.
		chat.messages.push(ask('u1b', T0 + 2, 'q1-again'), ans('u1b', 'a1b', T0 + 3, 'a1b-words'));
		F.honourGone(chat, { turnId: 'u2', gone: ['u1', 'a1'] });
		const mids = chat.messages.map((m) => m.mid);
		check('the retracted rows leave the transcript and are tombstoned', !mids.includes('u1') && !mids.includes('a1')
			&& sp.tombs.includes('u1') && sp.tombs.includes('a1'), { mids, t: sp.tombs });
		chat.messages.push(ask('u2', T0 + 4, 'q2'));
		const words = fed(chat, 'u2');
		check('the model is fed the sender\'s thread, not the retracted pair', JSON.stringify(words) === JSON.stringify(['q1-again', 'a1b-words']), words);
	}
	{
		const chat = chatWithSession();
		chat.messages.push(ask('u1b', T0 + 2, 'q1-again'), ans('u1b', 'a1b', T0 + 3, 'a1b-words'));
		const before = JSON.stringify(chat.session);
		F.honourGone(chat, { turnId: 'u2', gone: ['u1b', 'a1b'] });
		check('rows only in the session\'s tail leave it as it was (its tool-call ids kept)', JSON.stringify(chat.session) === before);
		check('and the model is fed the session alone', JSON.stringify(fed(chat, 'u2')) === JSON.stringify(['q1', 'a1-words']));
	}
	{
		const chat = chatWithSession();
		const before = JSON.stringify(chat.session);
		F.honourGone(chat, { turnId: 'u2', gone: ['nothere'] });
		check('a gone list naming nothing here changes nothing', JSON.stringify(chat.session) === before && chat.messages.length === 2);
	}
	console.log('retryTurn on a turn the stored session holds');
	{
		sp.ran.length = 0;
		const chat = chatWithSession();
		await F.retryTurn(chat, 'u1', 'q1', { person: true });
		const s = sp.ran.length === 1 ? sp.ran[0].session : 'not run';
		check('the replacing turn runs with no session that holds the retracted answer', sp.ran.length === 1 && !JSON.stringify(s).includes('a1-words'), s);
		check('and the session left is the cleared form, which a stored copy does not refill',
			!!chat.session && Array.isArray(chat.session.msgs) && chat.session.msgs.length === 0, chat.session);
	}

	// ── The cut is exact (check_fix2 item 3): only the retracted turn leaves the session. ──
	/// Turns 1 and 2 ran here, each with a tool call; the session is stored as `captureSession` stores it.
	const twoTurns = () => {
		const chat = {
			id: 'c2', messages: [ask('u1', T0, 'q1'), ans('u1', 'a1', T0 + 1, 'a1-words'),
				ask('u2', T0 + 2, 'q2'), ans('u2', 'a2', T0 + 3, 'a2-words')],
		};
		const list = [
			{ role: 'user', content: 'q1', mid: 'u1' },
			{ role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
			{ role: 'tool', content: 'ran', tool_call_id: 'call_1' },
			{ role: 'assistant', content: 'a1-words' },
			{ role: 'user', content: 'q2', mid: 'u2' },
			{ role: 'assistant', content: '', tool_calls: [{ id: 'call_2' }] },
			{ role: 'tool', content: 'ran2', tool_call_id: 'call_2' },
			{ role: 'assistant', content: 'a2-words' },
		];
		F.captureSession(chat, { export_session: () => list });
		return chat;
	};
	console.log('captureSession records where each turn starts');
	{
		const chat = twoTurns();
		check("each turn's prompt is marked at its place in the stored list",
			chat.session.marks.u1 === 0 && chat.session.marks.u2 === 4 && Object.keys(chat.session.marks).length === 2, chat.session.marks);
		const folded = { id: 'c3', messages: twoTurns().messages };
		F.captureSession(folded, { export_session: () => [
			{ role: 'system', content: 'summary of q1 and a1-words' },
			{ role: 'user', content: 'q2', mid: 'u2' }, { role: 'assistant', content: 'a2-words' }] });
		check('a folded turn is not marked; the turns after the fold are',
			JSON.stringify(folded.session.marks) === JSON.stringify({ u2: 1 }), folded.session.marks);
		const strange = { id: 'c4', messages: twoTurns().messages };
		F.captureSession(strange, { export_session: () => [
			{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1-words' },
			{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2-words' }] });
		check('a list whose prompts carry no ids (an older build) is not marked, whatever their words',
			JSON.stringify(strange.session.marks) === '{}', strange.session.marks);
	}
	console.log('retryTurn on the last of two turns');
	{
		sp.ran.length = 0;
		const chat = twoTurns();
		await F.retryTurn(chat, 'u2', 'q2', { person: true });
		const s = chat.session;
		check('the session keeps turn 1 whole, its tool-call ids included',
			s.msgs.length === 4 && s.msgs[2].tool_call_id === 'call_1' && s.upto === 'a1' && s.uptoTs === T0 + 1, s);
		check('and holds nothing of the retracted turn', !JSON.stringify(s.msgs).includes('q2') && !JSON.stringify(s.msgs).includes('call_2')
			&& s.marks && s.marks.u2 === undefined && s.marks.u1 === 0, s.marks);
		check('the replacing turn runs on that session', sp.ran.length === 1 && sp.ran[0].session && sp.ran[0].session.msgs.length === 4,
			sp.ran.length && sp.ran[0].session);
		check('and the model is fed turn 1 once, not turn 2', JSON.stringify(fed(chat, '')) === JSON.stringify(['q1', 'a1-words']), fed(chat, ''));
	}
	console.log('the gone removal of a middle turn');
	{
		const chat = twoTurns();
		chat.messages.push(ask('u3', T0 + 4, 'q3'), ans('u3', 'a3', T0 + 5, 'a3-words'));
		F.honourGone(chat, { turnId: 'u4', gone: ['u2', 'a2'] });
		check('the session is cut at turn 2 and turn 3 rides the tail as prose',
			chat.session.msgs.length === 4 && chat.session.upto === 'a1'
			&& JSON.stringify(fed(chat, '')) === JSON.stringify(['q1', 'a1-words', 'q3', 'a3-words']), [chat.session, fed(chat, '')]);
	}
	// ── F1 (check_fix3): marks are built from the engine's ids, never from the prompt's words. ──
	console.log('two queued turns that say the same thing');
	{
		// The runner's order for a handed-off turn: P4, A4, P5 "continue", P6 "continue" (queued, lands before A5), A5.
		const chat = {
			id: 'c7', messages: [ask('u4', T0, 'q4'), ans('u4', 'a4', T0 + 1, 'a4-words'),
				ask('u5', T0 + 2, 'continue'), ask('u6', T0 + 3, 'continue'), ans('u5', 'a5', T0 + 4, 'a5-words')],
		};
		F.captureSession(chat, { export_session: () => [
			{ role: 'user', content: 'q4', mid: 'u4' }, { role: 'assistant', content: 'a4-words' },
			{ role: 'user', content: 'continue', mid: 'u5' }, { role: 'assistant', content: 'a5-words' }] });
		check('each prompt is marked under its own id, the queued one not at all',
			chat.session.marks.u4 === 0 && chat.session.marks.u5 === 2 && Object.keys(chat.session.marks).length === 2, chat.session.marks);
		F.honourGone(chat, { turnId: 'u7', gone: ['u6'] });
		const kept = chat.session.msgs.map((m) => m.content);
		check("retracting the queued turn leaves the first one's prompt in the stored session",
			JSON.stringify(kept) === JSON.stringify(['q4', 'a4-words', 'continue', 'a5-words']), chat.session);
		check('and the model is fed both earlier turns',
			JSON.stringify(fed(chat, '')) === JSON.stringify(['q4', 'a4-words', 'continue', 'a5-words']), fed(chat, ''));
	}
	{
		// A mark that no longer stands on its own prompt (a stale index) is no mark.
		const chat = twoTurns();
		chat.session.marks = { u1: 0, u2: 3 };
		await F.retryTurn(chat, 'u2', 'q2', { person: true });
		check('a mark that stands on another entry falls back to the cleared form', chat.session.msgs.length === 0, chat.session);
	}
	// ── F3 (check_fix3): a held row's turn is its tag's, by position only when it has none. ──
	console.log("a tagged row is cut with its own turn, wherever it stands");
	{
		// Turn 5's answer lands after the queued prompt of turn 6; retracting turn 5 cuts at turn 5's prompt.
		const chat = {
			id: 'c8', messages: [ask('u4', T0, 'q4'), ans('u4', 'a4', T0 + 1, 'a4-words'),
				ask('u5', T0 + 2, 'q5'), ask('u6', T0 + 3, 'q6'), ans('u5', 'a5', T0 + 4, 'a5-words'),
				ans('u6', 'a6', T0 + 5, 'a6-words')],
		};
		F.captureSession(chat, { export_session: () => [
			{ role: 'user', content: 'q4', mid: 'u4' }, { role: 'assistant', content: 'a4-words' },
			{ role: 'user', content: 'q5', mid: 'u5' }, { role: 'assistant', content: 'a5-words' },
			{ role: 'user', content: 'q6', mid: 'u6' }, { role: 'assistant', content: 'a6-words' }] });
		F.honourGone(chat, { turnId: 'u7', gone: ['a5'] });
		check("turn 5's answer, standing below turn 6's prompt, is cut at turn 5's prompt",
			chat.session.msgs.length === 2 && chat.session.upto === 'a4', chat.session);
	}
	{
		// An untagged row (a build before every row was tagged) has no turn by id, and the nearest prompt above it is
		// no witness (check_fix5 H1): the session is laid again from the transcript.
		const chat = twoTurns();
		chat.messages[3] = { role: 'assistant', mid: 'a2', ts: T0 + 3, content: 'a2-words' };
		F.honourGone(chat, { turnId: 'u3', gone: ['a2'] });
		check('an untagged held row falls back to the cleared form', chat.session.msgs.length === 0, chat.session);
	}
	// ── G1 and G2 (check_fix4): a queued prompt above the marker, its answer below it. ──
	// R ran turn 5; P6 was queued and landed above A5; turn 6 ran on another device and A6 synced in below A5.
	const queued = () => ({
		id: 'c9', messages: [ask('u4', T0, 'q4'), ans('u4', 'a4', T0 + 1, 'a4-words'), ask('u5', T0 + 2, 'q5'),
			ask('u6', T0 + 3, 'SECRET-six'), ans('u5', 'a5', T0 + 4, 'a5-words'), ans('u6', 'a6', T0 + 5, 'a6-words')],
	});
	console.log('a turn whose prompt the engine never heard is laid on whole');
	{
		const chat = queued();
		F.captureSession(chat, { export_session: () => [
			{ role: 'user', content: 'q4', mid: 'u4' }, { role: 'assistant', content: 'a4-words' },
			{ role: 'user', content: 'q5', mid: 'u5' }, { role: 'assistant', content: 'a5-words' }] });
		chat.session.upto = 'a5'; chat.session.uptoTs = T0 + 4;	// stored before A6 arrived
		chat.messages.push(ask('u7', T0 + 6, 'q7'));
		check('the queued prompt above the marker goes in ahead of its answer',
			JSON.stringify(fed(chat, 'u7')) === JSON.stringify(['q4', 'a4-words', 'q5', 'a5-words', 'SECRET-six', 'a6-words']), fed(chat, 'u7'));
		const plain = { id: 'c10', messages: queued().messages.slice(0, 5) };
		F.captureSession(plain, { export_session: () => [
			{ role: 'user', content: 'q4' }, { role: 'assistant', content: 'a4-words' },
			{ role: 'user', content: 'q5' }, { role: 'assistant', content: 'a5-words' }] });
		check('a list from an older build (no ids) still goes by the marker alone',
			JSON.stringify(fed(plain, '')) === JSON.stringify(['q4', 'a4-words', 'q5', 'a5-words']), fed(plain, ''));
	}
	console.log("a retracted turn's answer leaves the session even when its prompt never reached the engine");
	{
		// An older build laid A6 on by position without P6, then R ran turn 7; the person retracts turn 6.
		const chat = queued();
		chat.messages.push(ask('u7', T0 + 6, 'q7'), ans('u7', 'a7', T0 + 7, 'a7-words'));
		F.captureSession(chat, { export_session: () => [
			{ role: 'user', content: 'q4', mid: 'u4' }, { role: 'assistant', content: 'a4-words' },
			{ role: 'user', content: 'q5', mid: 'u5' }, { role: 'assistant', content: 'a5-words' },
			{ role: 'assistant', content: 'a6-words' },
			{ role: 'user', content: 'q7', mid: 'u7' }, { role: 'assistant', content: 'a7-words' }] });
		// No text rule hides the orphan any longer (check_fix5 H2): turn 6 is unheard by id and stands before turn 7,
		// so the engine is laid from the transcript, in the chat's order, each row once (L1).
		check('the orphaned answer is not laid twice, nor its prompt after turn 7',
			JSON.stringify(fed(chat, '')) === JSON.stringify(['q4', 'a4-words', 'q5', 'SECRET-six', 'a5-words', 'a6-words', 'q7', 'a7-words']), fed(chat, ''));
		F.honourGone(chat, { turnId: 'u8', gone: ['u6', 'a6'] });
		check("turn 6's answer leaves the stored session", !JSON.stringify(chat.session.msgs).includes('a6-words'), chat.session);
		check('and the model is not fed it', !fed(chat, '').includes('a6-words') && !fed(chat, '').includes('SECRET-six'), fed(chat, ''));
	}
	// ── H1, H2, H3 (check_fix5): a local turn's answer is tagged, and no row is placed by words or by the prompt above. ──
	// P5, P6 (queued while A5 streamed), A5 (the marker), A6. The stored list holds turns 4 and 5 by id.
	const local = (a5tag, a6words) => ({
		id: 'c11', messages: [ask('u4', T0, 'q4'), ans('u4', 'a4', T0 + 1, 'Done.'), ask('u5', T0 + 2, 'q5'), ask('u6', T0 + 3, 'q6'),
			a5tag ? ans(a5tag, 'a5', T0 + 4, 'five') : { role: 'assistant', mid: 'a5', ts: T0 + 4, content: 'five' },
			{ role: 'assistant', mid: 'a6', ts: T0 + 5, content: a6words }],
		session: { v: 1, upto: 'a5', uptoTs: T0 + 4, marks: { u4: 0, u5: 2 }, msgs: [
			{ role: 'user', content: 'q4', mid: 'u4' }, { role: 'assistant', content: 'Done.' },
			{ role: 'user', content: 'q5', mid: 'u5' }, { role: 'assistant', content: 'five' }] },
	});
	const tailOf = (chat) => F.tailAfter(chat, chat.session).map((m) => m.mid);
	console.log('a queued prompt above a local answer');
	{
		check('the queued prompt goes in ahead of the answer below the marker (P5, P6 local)',
			JSON.stringify(tailOf(local('u5', 'six'))) === JSON.stringify(['u6', 'a6']), tailOf(local('u5', 'six')));
		check('an answer whose words the session already holds is still laid on with its prompt (the repeated "Done.")',
			JSON.stringify(tailOf(local('u5', 'Done.'))) === JSON.stringify(['u6', 'a6']), tailOf(local('u5', 'Done.')));
		check('an untagged answer above the marker goes by the marker alone, never into the queued turn (A5, A6 local)',
			JSON.stringify(tailOf(local(undefined, 'six'))) === JSON.stringify(['u6', 'a6']), tailOf(local(undefined, 'six')));
		const twice = fed(local(undefined, 'six'), '');
		check('and A5 is fed once (H3)', twice.filter((c) => c === 'five').length === 1
			&& JSON.stringify(twice) === JSON.stringify(['q4', 'Done.', 'q5', 'five', 'q6', 'six']), twice);
	}
	console.log('a whole turn above the marker that the engine never heard');
	{
		// Turn 6 ran elsewhere and its answer is another "Done."; turn 7 then ran here.
		const chat = {
			id: 'c12', messages: [ask('u4', T0, 'q4'), ans('u4', 'a4', T0 + 1, 'Done.'), ask('u5', T0 + 2, 'q5'), ans('u5', 'a5', T0 + 3, 'five'),
				ask('u6', T0 + 4, 'q6'), ans('u6', 'a6', T0 + 5, 'Done.'), ask('u7', T0 + 6, 'q7'), ans('u7', 'a7', T0 + 7, 'seven')],
			session: { v: 1, upto: 'a7', uptoTs: T0 + 7, marks: { u4: 0, u5: 2, u7: 4 }, msgs: [
				{ role: 'user', content: 'q4', mid: 'u4' }, { role: 'assistant', content: 'Done.' },
				{ role: 'user', content: 'q5', mid: 'u5' }, { role: 'assistant', content: 'five' },
				{ role: 'user', content: 'q7', mid: 'u7' }, { role: 'assistant', content: 'seven' }] },
		};
		check('the turn is laid on whole, not dropped by its words', JSON.stringify(tailOf(chat)) === JSON.stringify(['u6', 'a6']), tailOf(chat));
		const f = fed(chat, '');
		check('and the engine is laid out in the chat\'s order, turn 6 before turn 7 (L1)',
			JSON.stringify(f) === JSON.stringify(['q4', 'Done.', 'q5', 'five', 'q6', 'Done.', 'q7', 'seven']), f);
	}
	console.log("an old-build peer's untagged answer above the marker (check_fix6 M1)");
	{
		// Two devices sent at once: P6 ran on an old-build peer, whose answer A6 carries no tag, and landed above this
		// device's answer A5 (the marker). The tail lays P6 on by id and cannot place A6, so the engine is laid from
		// the transcript rather than read q6 with no answer.
		const mixed = (a6tag) => ({
			id: 'c13', messages: [ask('u4', T0, 'q4'), ans('u4', 'a4', T0 + 1, 'four'), ask('u5', T0 + 2, 'q5'), ask('u6', T0 + 3, 'q6'),
				a6tag ? ans(a6tag, 'a6', T0 + 4, 'six') : { role: 'assistant', mid: 'a6', ts: T0 + 4, content: 'six' },
				ans('u5', 'a5', T0 + 5, 'five')],
			session: { v: 1, upto: 'a5', uptoTs: T0 + 5, marks: { u4: 0, u5: 2 }, msgs: [
				{ role: 'user', content: 'q4', mid: 'u4' }, { role: 'assistant', content: 'four' },
				{ role: 'user', content: 'q5', mid: 'u5' }, { role: 'assistant', content: 'five' }] },
		});
		const old = fed(mixed(undefined), '');
		check('the old peer\'s answer is fed with its prompt, laid from the transcript',
			JSON.stringify(old) === JSON.stringify(['q4', 'four', 'q5', 'q6', 'six', 'five']), old);
		const tagged = fed(mixed('u6'), '');
		check('a tagged answer is still laid on by id behind the stored session',
			JSON.stringify(tagged) === JSON.stringify(['q4', 'four', 'q5', 'five', 'q6', 'six']), tagged);
	}
	console.log('a session with no marks (an older build) or a cut before its first mark');
	{
		const chat = twoTurns();
		delete chat.session.marks;
		await F.retryTurn(chat, 'u2', 'q2', { person: true });
		check('without marks it falls back to the cleared form', chat.session.msgs.length === 0, chat.session);
		const folded = { id: 'c5', messages: twoTurns().messages };
		F.captureSession(folded, { export_session: () => [
			{ role: 'system', content: 'summary' }, { role: 'user', content: 'q2', mid: 'u2' }, { role: 'assistant', content: 'a2-words' }] });
		await F.retryTurn(folded, 'u2', 'q2', { person: true });
		check('cutting the first unfolded turn keeps the fold', folded.session.msgs.length === 1
			&& folded.session.msgs[0].content === 'summary' && folded.session.upto === 'a1', folded.session);
		const early = { id: 'c6', messages: twoTurns().messages };
		F.captureSession(early, { export_session: () => [
			{ role: 'system', content: 'summary' }, { role: 'user', content: 'q2', mid: 'u2' }, { role: 'assistant', content: 'a2-words' }] });
		await F.retryTurn(early, 'u1', 'q1', { person: true });
		check('cutting a folded turn empties the session', early.session.msgs.length === 0, early.session);
	}
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS') + ' (' + checks + ' checks)');
process.exit(failures ? 1 : 0);
