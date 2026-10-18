// FOLDIDS (QA r572w A F1/F2): the fold record lists the message ids the engine held; answers link their prompt.
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';
const F = sliceDaimond(makeWindow({}), ['daimonPrior', 'foldFrom', 'mergeFold', 'foldCover', 'foldGap', 'tailAfter', 'sessionDoubt', 'dedupeSession'], { diag() {} }).fns;
const J = JSON.stringify, said = (l) => l.map((m) => m.content);
let fail = 0; const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fail++; };
const FOLD = '[Daimond folded the earlier part] summary';
const after = [{ role: 'user', content: FOLD }, { role: 'user', content: 'q3', mid: 'u3' }];
const fold = (T, prev, before) => F.foldFrom({ messages: T, fold: prev }, after, 'u3', prev || null, 1, 'A', before || F.daimonPrior({ messages: T, fold: prev }, 'u3'));
const q1 = { role: 'user', content: 'q1', mid: 'u1', ts: 10 };
const q2 = { role: 'user', content: 'q2 from B', mid: 'u2', ts: 12 };
const a2 = { role: 'assistant', content: 'a2 from runner', mid: 'a2', iturn: 'u2', ts: 35 };
const q3 = { role: 'user', content: 'q3', mid: 'u3', ts: 40 };

// (a) B's prompt sorts between A's prompt and A's answer; A folds before B's runner answers.
for (const [how, a1] of [['linked', { role: 'assistant', content: 'a1 local', mid: 'a1', iturn: 'u1', ranOn: 'A', ts: 20 }],
	['unlinked (saved before the fix)', { role: 'assistant', content: 'a1 local', mid: 'a1', ranOn: 'A', ts: 20 }]]) {
	const f = fold([q1, q2, a1, q3]);
	const re = said(F.daimonPrior({ messages: [q1, q2, a1, a2, q3], fold: f }, 'u3'));
	check('(a) ' + how + ': B\'s later answer is laid, A\'s answered prompt is covered', J(re) === J([FOLD, 'a2 from runner']), J(re));
}

// (b) An errored turn (an error row, no answer) is covered once and not laid again; the session is trusted.
const p0 = { role: 'user', content: 'q0 failed', mid: 'u0', ts: 5 };
const e0 = { role: 'error_log', content: 'too large', mid: 'e0', iturn: 'u0', ts: 6 };
const b1 = { role: 'assistant', content: 'a1', mid: 'b1', iturn: 'u1', ts: 20 };
const a3 = { role: 'assistant', content: 'a3', mid: 'b3', iturn: 'u3', ts: 50 };
const sess = { v: 1, msgs: after.concat([{ role: 'assistant', content: 'a3' }]), upto: 'b3', uptoTs: 50 };
const g = fold([p0, e0, q1, b1, q3]);
const U = [p0, e0, q1, b1, q3, a3];
check('(b) an errored prompt is covered by the fold', J(said(F.daimonPrior({ messages: U, fold: g }, 'u4'))) === J([FOLD, 'q3', 'a3']), J(said(F.daimonPrior({ messages: U, fold: g }, 'u4'))));
check('(b) the session after the fold is trusted', F.foldGap({ messages: U, fold: g }, sess, 'u4') === '', F.foldGap({ messages: U, fold: g }, sess, 'u4'));
const q4 = { role: 'user', content: 'q4', mid: 'u4', ts: 60 };
const prior2 = F.daimonPrior({ messages: U.concat([q4]), fold: g, session: sess }, 'u4');
const g2 = F.foldFrom({ messages: U.concat([q4]), fold: g }, [{ role: 'user', content: FOLD + ' 2' }, { role: 'user', content: 'q4', mid: 'u4' }], 'u4', g, 2, 'A', prior2);
check('(b) a refold keeps it covered', (g2.ids || []).includes('u0') && J(said(F.daimonPrior({ messages: U.concat([q4]), fold: g2 }, 'u4'))) === J([FOLD + ' 2']), J(g2));

// (c) A stopped turn (an empty interrupted row, no words) likewise.
const s0 = { role: 'assistant', content: '', mid: 's0', iturn: 'u0', interrupted: true, ts: 6 };
const h = fold([p0, s0, q1, b1, q3]);
const V = [p0, s0, q1, b1, q3, a3];
check('(c) a stopped prompt is covered by the fold', J(said(F.daimonPrior({ messages: V, fold: h }, 'u4'))) === J([FOLD, 'q3', 'a3']), J(said(F.daimonPrior({ messages: V, fold: h }, 'u4'))));
check('(c) the session after the fold is trusted', F.foldGap({ messages: V, fold: h }, sess, 'u4') === '', F.foldGap({ messages: V, fold: h }, sess, 'u4'));

// (d) A late answer for a covered prompt is laid.
const k = fold([q1, q3]);
const late = { role: 'assistant', content: 'a1 late', mid: 'al', iturn: 'u1', ts: 45 };
const re = said(F.daimonPrior({ messages: [q1, q3, late], fold: k }, 'u4'));
check('(d) the late answer of a covered prompt is laid, its prompt is not', J(re) === J([FOLD, 'q3', 'a1 late']), J(re));

// (e) A record of the old shape (whole turns) still covers what it covered, and a refold reads it into ids.
const a1t = { role: 'assistant', content: 'a1', mid: 'a1', iturn: 'u1', ts: 20 };
const a1u = { role: 'assistant', content: 'a1 untagged', mid: 'a1u', ts: 21 };
const oldRec = { through: 'a1u', throughTs: 21, turns: ['u1'], at: 1, dev: 'B', text: FOLD };
const W = [q1, a1t, a1u, q2, a2, q3];
const ro = said(F.daimonPrior({ messages: W, fold: oldRec }, 'u3'));
check('(e) an old-shape record covers its turn\'s prompt and answers', J(ro) === J([FOLD, 'q2 from B', 'a2 from runner']), J(ro));
const shed = { through: 'a1', throughTs: 20, turns: [], floorTs: 10, at: 1, dev: 'B', text: FOLD };
check('(e) an old-shape floor covers a shed turn', J(said(F.daimonPrior({ messages: W, fold: shed }, 'u3'))) === J([FOLD, 'a1 untagged', 'q2 from B', 'a2 from runner']), J(said(F.daimonPrior({ messages: W, fold: shed }, 'u3'))));
const conv = F.foldFrom({ messages: W, fold: oldRec }, [{ role: 'user', content: FOLD + ' 2' }, { role: 'user', content: 'q3', mid: 'u3' }], 'u3', oldRec, 2, 'A',
	[{ role: 'user', content: FOLD }]);
check('(e) a refold over it writes the exact ids it covered', Array.isArray(conv.ids) && !conv.turns && J(conv.ids.slice().sort()) === J(['a1', 'a1u', 'u1']), J(conv));

// (f) The bound: 1000 answered turns stay within 16 KiB of ids, and the shed rows still read as covered.
const many = [];
for (let i = 0; i < 1000; i++) many.push({ role: 'user', content: 'p' + i, mid: 'lq3x2k1a-' + i.toString(36) + '-abcde', ts: 100 + 2 * i },
	{ role: 'assistant', content: 'r' + i, mid: 'lq3x2k1b-' + i.toString(36) + '-fghij', iturn: 'lq3x2k1a-' + i.toString(36) + '-abcde', ts: 101 + 2 * i });
many.push({ role: 'user', content: 'now', mid: 'now', ts: 9999 });
const fm = F.foldFrom({ messages: many }, [{ role: 'user', content: FOLD }], 'now', null, 3, 'd');
check('(f) the ids list stays within 16 KiB, the rest shed into floorTs', J(fm.ids || fm.turns).length <= 16384 && !!fm.ids && fm.floorTs > 0, J(fm.ids || fm.turns).length);
check('(f) every shed row is still covered', J(said(F.daimonPrior({ messages: many, fold: fm }, 'now'))) === J([FOLD]), '');

// (g) A turn's changed-files note, held by the engine's session without its id, is covered: the session stays trusted.
const NOTE = '[changed files] x.rs';
const n1 = { role: 'user', content: NOTE, mid: 'n1', ts: 21 };
const s1 = { v: 1, msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: NOTE }], upto: 'n1', uptoTs: 21 };
const N = [q1, b1, n1, q3];
const fn = F.foldFrom({ messages: N }, after, 'u3', null, 1, 'A', F.daimonPrior({ messages: N, session: s1 }, 'u3'));
const sn = { v: 1, msgs: after.concat([{ role: 'assistant', content: 'a3' }]), upto: 'b3', uptoTs: 50 };
check('(g) a held note is listed and the session after the fold is trusted', (fn.ids || []).includes('n1') && F.foldGap({ messages: N.concat([a3]), fold: fn }, sn, 'u4') === '', J(fn));
console.log(fail ? fail + ' FAILED' : 'all ok');
process.exit(fail ? 1 : 0);
