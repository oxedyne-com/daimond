// C2-N2 (QA r572z-A N2): a turn is folded only when the engine held its answer as well as its prompt.
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';
const F = sliceDaimond(makeWindow({}), ['daimonPrior', 'foldFrom', 'mergeFold', 'foldCover', 'foldGap', 'tailAfter', 'sessionDoubt', 'dedupeSession'], { diag() {} }).fns;
const J = JSON.stringify, said = (l) => l.map((m) => m.content);
let fail = 0; const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fail++; };
const FOLD = '[Daimond folded the earlier part] summary';
const q1 = { role: 'user', content: 'q1', mid: 'u1', ts: 10 }, a1 = { role: 'assistant', content: 'a1', mid: 'a1', iturn: 'u1', ts: 20 };
const q2 = { role: 'user', content: 'q2 from B', mid: 'u2', ts: 30 }, a2 = { role: 'assistant', content: 'a2 from B', mid: 'a2', iturn: 'u2', ts: 35 };
const q3 = { role: 'user', content: 'q3', mid: 'u3', ts: 40 };
const after = [{ role: 'user', content: FOLD }, { role: 'user', content: 'q3', mid: 'u3' }];
// 1. QA's repro: B's prompt reached A before B's answer; A folds, then B's answer lands.
const T = [q1, a1, q2, q3];
const before = F.daimonPrior({ messages: T }, 'u3');
const f = F.foldFrom({ messages: T }, after, 'u3', null, 1, 'A', before);
check('a prompt whose answer had not arrived is not covered', J(f.turns) === J(['u1']), J(f.turns));
const T2 = [q1, a1, q2, a2, q3];
const re = said(F.daimonPrior({ messages: T2, fold: f }, 'u3'));
check('the answer that lands later is laid by the rebuild', J(re) === J([FOLD, 'q2 from B', 'a2 from B']), J(re));
// 2. The answer reached the transcript after the engine's list was built: still not held, not covered.
const g = F.foldFrom({ messages: T2 }, after, 'u3', null, 1, 'A', before);
check('an answer in the transcript the engine never held is not covered', J(g.turns) === J(['u1']), J(g.turns));
// 3. Interleaved rows: B's prompt stands between A's prompt and A's answer; A's answer is not B's.
const T3 = [q1, q2, a1, q3];
const g3 = F.foldFrom({ messages: T3 }, after, 'u3', null, 1, 'A', F.daimonPrior({ messages: T3 }, 'u3'));
check('another turn\'s answer beside a prompt does not cover it', J(g3.turns) === J(['u1']), J(g3.turns));
// 4. The engine's own history (its answer in its own form) still covers its turn.
const own = [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1 as the engine holds it' }];
const g4 = F.foldFrom({ messages: [q1, a1, q3] }, after, 'u3', null, 1, 'A', own);
check('the engine\'s own answer covers its turn', J(g4.turns) === J(['u1']), J(g4.turns));
// 5. With no list, the transcript stands for it: a prompt without an answer is not covered.
const g5 = F.foldFrom({ messages: T }, after, 'u3', null, 1, 'A');
check('no list: an unanswered prompt is not covered', J(g5.turns) === J(['u1']), J(g5.turns));
console.log(fail ? fail + ' FAILED' : 'all ok');
process.exit(fail ? 1 : 0);
