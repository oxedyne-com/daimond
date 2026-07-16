// verify_journal.mjs — the write-ahead log reconstructs exactly what was in flight.
//
// verify_durability.mjs drives a real turn to a real crash; this drives the JOURNAL directly, so
// the reconstruction can be checked deterministically in cases the mock cannot time reliably: a
// tool that finished vs one caught in the act, several turns at once, event ordering, coalescing
// across a tool boundary, per-turn pruning, and account isolation. Events are keyed per TURN (not
// per chat), so successive turns of one chat never conflate and one turn's prune never wipes
// another's.
import { open, signInAs, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'journal', connect: false, signIn: false, profile: '/tmp/daimond-journal-profile' });
const p = s.page;
await p.waitForTimeout(1500);
await signInAs(s, 'Jo');
await p.waitForTimeout(600);

// Everything below runs in the page against the real DaimondJournal. Signatures:
//   turnOpen(turnId, chatId, text, meta) · delta(turnId, chatId, text)
//   toolOpen(turnId, chatId, callId, name, args) · toolDone(turnId, chatId, callId, result, failed)
//   turnClose(turnId, chatId, pTok, cTok) · recover() -> { turns:[...], agents:[...] }
const r1 = await p.evaluate(async () => {
	const J = window.DaimondJournal;
	await J.init();
	// Turn tA in chat cA: text, a completed tool, and a tool still open when the "tab died".
	await J.turnOpen('tA', 'cA', 'do the thing', { model: 'm' });
	await J.delta('tA', 'cA', 'Wor');
	await J.toolOpen('tA', 'cA', 'tc1', 'file_write', '{"path":"x"}');
	await J.toolDone('tA', 'cA', 'tc1', 'wrote x', false);
	await J.delta('tA', 'cA', 'king');
	await J.toolOpen('tA', 'cA', 'tc2', 'file_read', '{"path":"y"}');   // never returns
	await J.delta('tA', 'cA', ' on it');
	// A second, independent turn in a different chat.
	await J.turnOpen('tB', 'cB', 'other prompt', { model: 'm' });
	await J.delta('tB', 'cB', 'second');
	const rec = await J.recover();
	const by = {}; rec.turns.forEach(t => by[t.turnId] = t);
	return { tA: by.tA, tB: by.tB, count: rec.turns.length };
});

check('a turn is reconstructed with its prompt, turn id and chat',
	r1.tA && r1.tA.userText === 'do the thing' && r1.tA.turnId === 'tA' && r1.tA.chatId === 'cA',
	JSON.stringify(r1.tA && { u: r1.tA.userText, t: r1.tA.turnId, c: r1.tA.chatId }));
check('the streamed text is whole and in order, across the tool boundary',
	r1.tA && r1.tA.text === 'Working on it', r1.tA && r1.tA.text);
check('a completed tool carries its result and is marked done',
	r1.tA && r1.tA.tools[0] && r1.tA.tools[0].name === 'file_write' && r1.tA.tools[0].done === true && r1.tA.tools[0].result === 'wrote x',
	JSON.stringify(r1.tA && r1.tA.tools[0]));
check('a tool still open when the tab died is marked NOT done',
	r1.tA && r1.tA.tools[1] && r1.tA.tools[1].name === 'file_read' && r1.tA.tools[1].done === false,
	JSON.stringify(r1.tA && r1.tA.tools[1]));
check('two in-flight turns are recovered independently',
	r1.count === 2 && r1.tB && r1.tB.text === 'second', String(r1.count));

// ── Per-turn pruning: closing one turn removes only its events ──────────

const r2 = await p.evaluate(async () => {
	const J = window.DaimondJournal;
	await J.turnClose('tA', 'cA', 100, 50);       // tA completes
	const rec = await J.recover();
	return { ids: rec.turns.map(t => t.turnId) };
});
check('closing a turn prunes only it', r2.ids.indexOf('tA') === -1 && r2.ids.indexOf('tB') !== -1, r2.ids.join(','));

// ── Two turns of the SAME chat do not conflate; the first's close does not
//    mask the second's interruption (the chatId-multiplexing bug) ────────

const r3 = await p.evaluate(async () => {
	const J = window.DaimondJournal;
	await J.turnOpen('t1', 'cSame', 'first turn', { model: 'm' });
	await J.delta('t1', 'cSame', 'first answer');
	await J.turnClose('t1', 'cSame', 5, 5);        // first turn completes cleanly
	await J.turnOpen('t2', 'cSame', 'second turn', { model: 'm' });
	await J.delta('t2', 'cSame', 'second answer');  // ...and the tab dies here
	const rec = await J.recover();
	const same = rec.turns.filter(t => t.chatId === 'cSame');
	return { n: same.length, turnId: same[0] && same[0].turnId, text: same[0] && same[0].text, userText: same[0] && same[0].userText };
});
check('a completed turn does not mask a later interrupted turn of the same chat',
	r3.n === 1 && r3.turnId === 't2' && r3.text === 'second answer' && r3.userText === 'second turn',
	JSON.stringify(r3));

// ── A buffered event does not survive its turn being closed and pruned ──

const r4 = await p.evaluate(async () => {
	const J = window.DaimondJournal;
	J.delta('tB', 'cB', ' thoughts');             // deliberately not awaited: still buffered
	await J.turnClose('tB', 'cB', 10, 5);
	const rec = await J.recover();
	return { tBGone: !rec.turns.some(t => t.turnId === 'tB'), ids: rec.turns.map(t => t.turnId) };
});
check('a buffered event does not survive its turn being closed and pruned',
	r4.tBGone === true, r4.ids.join(',') || '(none left)');

// ── Agents ──────────────────────────────────────────────────────────────

const r5 = await p.evaluate(async () => {
	const J = window.DaimondJournal;
	await J.agentOpen('w1', { name: 'agent-1', task: 'research X' });
	await J.agentDelta('w1', 'found ');
	await J.agentDelta('w1', 'something');
	await J.agentOpen('w2', { name: 'agent-2', task: 'research Y' });
	await J.agentDelta('w2', 'other');
	await J.agentClose('w2', 'done', 20, 10);      // w2 finished
	const rec = await J.recover();
	return { agents: rec.agents.map(a => ({ id: a.runId, task: a.rec && a.rec.task, text: a.text })) };
});
check('an interrupted agent keeps its task and partial output',
	r5.agents.length === 1 && r5.agents[0].id === 'w1' && r5.agents[0].text === 'found something',
	JSON.stringify(r5.agents));
check('a completed agent is pruned, not recovered', !r5.agents.some(a => a.id === 'w2'));

// ── Account isolation: a second account's journal is a different store ───

const r6 = await p.evaluate(async () => {
	const J = window.DaimondJournal;
	await J.turnOpen('tKeep', 'cKeep', 'primary secret', { model: 'm' });
	await J.delta('tKeep', 'cKeep', 'primary only');
	const primaryHas = (await J.recover()).turns.some(t => t.turnId === 'tKeep');
	const before = window.DaimondAccounts.opfsNs();
	window.DaimondAccounts.add('Second');          // becomes current
	const after = window.DaimondAccounts.opfsNs();
	const secondSees = (await J.recover()).turns.some(t => t.turnId === 'tKeep');
	window.DaimondAccounts.setCurrent(window.DaimondAccounts.list().filter(x => x.primary)[0].id);
	const primaryStillHas = (await J.recover()).turns.some(t => t.turnId === 'tKeep');
	return { primaryHas, before, after, secondSees, primaryStillHas };
});
check('the primary account holds its own interrupted turn', r6.primaryHas === true);
check('a second account gets its OWN namespace', r6.before === '' && r6.after !== '', r6.before + ' -> ' + r6.after);
check('a second account cannot see the primary account\'s journal', r6.secondSees === false);
check('and switching back finds the primary account\'s turn intact', r6.primaryStillHas === true);

const errs = errors(s).filter(e => !/favicon|404|401|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
check('nothing throws', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
