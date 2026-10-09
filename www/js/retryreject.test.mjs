/* ============================================================
   Test -- a retried answer is counted as a rejected answer (Q27).
   ------------------------------------------------------------
   THE FAULT. `retryTurn` (www/js/daimond.js) tombstones the whole turn, so
   the answer the person turned down left nothing behind: no turn in any
   chat's part, and its spend read as "not tied to an answer". The model
   Compare's cost per accepted answer read LOW by exactly what the retries
   cost, and its accept rate never saw a retry at all.

   THE FIX. Before the retraction `retryTurn` marks the turn's ledger spend
   `tr` with the id of the turn that replaces it (`DaimondLedger.markRetried`)
   and runs that turn under the id (`runTurn` `opts.mid`). The ledger syncs
   under its own join law; `DaimondModelCompare.grid` turns a marked turn the
   transcript no longer holds into a rejected answer.

   WHAT IS CHECKED. The REAL `retryTurn` and `turnMessagesOf`, lifted from
   daimond.js, against stubs for the page, with the REAL ledger.js (over an
   in-memory store), provenance.js, ratings.js, ratingroll.js and
   modelcompare.js: the retracted text stays out of the chat, the ledger
   carries the mark, and the grid counts two answers, one accepted, with no
   spend untied. Also the turn whose spend this device does not hold (one
   outcome-only mark), and the mark's bytes under the ledger's merge.

   Run:  node www/js/retryreject.test.mjs
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

// The pure modules and the ledger over an in-memory DaimondStore.
const win = {};
const box = new Map();
win.DaimondStore = {
	get: (k, d) => box.has(k) ? JSON.parse(box.get(k)) : d,
	put: (k, v) => { box.set(k, JSON.stringify(v)); return true; },
	putMerged: (k, v) => { box.set(k, JSON.stringify(v)); return true; },
	remove: (k) => box.delete(k),
};
for (const f of ['provenance.js', 'ratings.js', 'ratingroll.js', 'modelcompare.js', 'ledger.js']) {
	try { new Function('window', readFileSync(join(HERE, f), 'utf8'))(win); }
	catch (e) { console.log('  load ' + f + ': ' + e.message); }
}
const P = win.DaimondProvenance, RR = win.DaimondRatingRoll, MC = win.DaimondModelCompare, L = win.DaimondLedger;

const T0 = 1790000000000;
const ans = (t, mid, ts, model) => ({ role: 'assistant', mid: mid, ts: ts, iturn: t, content: 'the answer ' + mid,
	prod: [P.stamp({ h: 'p1:answer:c1/' + mid, k: 'answer', m: model, pv: 'pv1', role: 'chat', sp: 'sp1:00000000', c: 'c1', t: t, dev: 'D1', at: ts })] });
const ask = (mid, ts, text) => ({ role: 'user', mid: mid, ts: ts, iturn: mid, content: text });

/// The real retryTurn over stubs; `runTurn` stands in for the replacing turn: its question
/// under the id it was given, an answer by `model2`, and that answer's spend.
function doors(sp, model2) {
	const st = {
		DaimondPeer: { isAskAnswer: () => false, dispatchState: () => 'no-peer-awake', dispatchControl: () => '' },
		DaimondLease: { record: () => null }, DaimondJournal: { clearTurn() {} },
		loadMsgTombs: () => ({}), msgTombstone: (mids) => sp.tombstoned.push(...mids), touchChat() {}, persistChats() {}, renderHistory() {},
		ChatStore: { compact() {} }, newMid: () => 'n' + (++sp.seq), peerUiStateFor: () => '', selfDeviceId: () => 'D1', leaseClockNow: () => T0,
		answerAgain() { sp.again++; },
		runTurn: (chat, text, opts) => {
			sp.ran.push({ text, opts });
			const id = (opts && opts.mid) || 'fresh';
			chat.messages.push(ask(id, T0 + 50, text), ans(id, 'a-' + id, T0 + 60, model2));
			L.record({ ts: T0 + 60, model: model2, promptTokens: 100, completionTokens: 10, costUsd: 0.02, provider: 'pv1', turnId: id, outcome: 'completed' });
			return Promise.resolve();
		},
	};
	const body = lift(SRC, 'turnMessagesOf') + '\n' + lift(SRC, 'retryTurn') + '\nreturn retryTurn;';
	const w = Object.assign({}, win, st);
	return new Function('window', ...Object.keys(st), 'DaimondLedger', 'DaimondProvenance', body)(w, ...Object.values(st), L, P);
}

function scene(spendHeld) {
	box.clear();
	const sp = { tombstoned: [], ran: [], seq: 0, again: 0 };
	const chat = { id: 'c1', model: 'model-a', provider: 'pv1', messages: [
		ask('t1', T0, 'an earlier question'), ans('t1', 'a1', T0 + 1, 'model-a'),
		ask('t9', T0 + 2, 'write the summary'), ans('t9', 'a9', T0 + 3, 'model-a'),
	] };
	L.record({ ts: T0 + 1, model: 'model-a', promptTokens: 100, completionTokens: 10, costUsd: 0.01, provider: 'pv1', turnId: 't1', outcome: 'completed' });
	if (spendHeld) L.record({ ts: T0 + 3, model: 'model-a', promptTokens: 300, completionTokens: 30, costUsd: 0.05, provider: 'pv1', turnId: 't9', outcome: 'completed' });
	return { sp, chat, retry: doors(sp, 'model-b') };
}

console.log('retryTurn leaves the turned-down answer counted, and out of the chat');
{
	const { sp, chat, retry } = scene(true);
	retry(chat, 't9', 'write the summary', { person: true });
	const mids = chat.messages.map((m) => m.mid);
	check('the turn is retracted and tombstoned as before', sp.tombstoned.includes('t9') && sp.tombstoned.includes('a9') && !mids.includes('a9') && !mids.includes('t9'), { t: sp.tombstoned, mids });
	check('the retracted words do not come back into the chat', !JSON.stringify(chat.messages).includes('the answer a9'));
	const id = sp.ran.length === 1 && sp.ran[0].opts ? sp.ran[0].opts.mid : null;
	check('the replacing turn runs once, under an id chosen before it, as the person', !!id && sp.ran[0].opts.person === true, sp.ran.map((r) => r.opts));
	const es = L.entries().filter((e) => e.tid === 't9');
	check('the retried turn\'s spend is marked with the turn that replaced it', es.length === 1 && es[0].tr === id && es[0].u === 0.05, es);
	check('the earlier turn\'s spend is not marked', L.entries().filter((e) => e.tid === 't1' && e.tr).length === 0);
	const g = MC.grid([RR.chatPart(chat.messages)], L.entries(), { identify: (m) => ({ cm: m }) });
	const a = g.rows.find((r) => r.cm === 'model-a'), b = g.rows.find((r) => r.cm === 'model-b');
	check('Compare: model-a gave two answers, one accepted, and none of its spend is untied',
		!!a && a.n === 2 && JSON.stringify(a.cells.accept) === JSON.stringify(MC.rate(1, 2)) && a.untied === 0 && g.untied === 0,
		a && { n: a.n, accept: a.cells.accept, untied: a.untied, all: g.untied });
	check('Compare: the cost per accepted answer carries the rejected answer\'s spend',
		!!a && JSON.stringify(a.cells.cost) === JSON.stringify(MC.costRatio([0.01, 0.05], 1)), a && a.cells.cost);
	check('Compare: the replacing answer is model-b\'s, accepted', !!b && b.n === 1 && JSON.stringify(b.cells.accept) === JSON.stringify(MC.rate(1, 1)), b && { n: b.n, accept: b.cells.accept });
	const snap = JSON.stringify(MC.snapshot(g, { weights: MC.PRESETS.balanced }));
	check('the snapshot carries none of the retracted words', !snap.includes('summary') && !snap.includes('the answer'));
}
{
	const { sp, chat, retry } = scene(false);
	retry(chat, 't9', 'write the summary', { person: true });
	const es = L.entries().filter((e) => e.tid === 't9');
	check('spend not held here: one outcome-only mark carries the turn, its model and the replacement',
		es.length === 1 && es[0].ol === 1 && es[0].u === 0 && es[0].m === 'model-a' && es[0].pv === 'pv1' && es[0].tr === sp.ran[0].opts.mid, es);
	const g = MC.grid([RR.chatPart(chat.messages)], L.entries(), { identify: (m) => ({ cm: m }) });
	const a = g.rows.find((r) => r.cm === 'model-a');
	check('and it is still a rejected answer of model-a', !!a && a.n === 2 && JSON.stringify(a.cells.accept) === JSON.stringify(MC.rate(1, 2)), a && { n: a.n, accept: a.cells.accept });
}
{
	// The mark is a ledger field under the join law: either order of two copies gives the same bytes,
	// and `tr` sits last, where a build that has never heard of it puts it.
	const { chat, retry } = scene(true);
	const before = L.entries();
	retry(chat, 't9', 'write the summary', { person: true });
	const after = L.entries();
	const ab = JSON.stringify(L.merge(before, after, T0 + 100)), ba = JSON.stringify(L.merge(after, before, T0 + 100));
	check('the marked and unmarked copies join to the marked one, in either order', ab === ba && ab.includes('"tr":"n1"'), { ab, ba });
	const e = after.find((x) => x.tid === 't9');
	check('`tr` is the entry\'s last key', !!e && Object.keys(e).pop() === 'tr', e && Object.keys(e));
}

console.log(failures ? ('\nFAIL -- ' + failures + '/' + checks + ' checks') : '\nALL PASS -- ' + checks + ' checks');
if (failures) process.exitCode = 1;
