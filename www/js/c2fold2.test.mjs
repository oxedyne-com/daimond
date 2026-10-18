// C2-FOLD: the fold record's coverage list, its merge and its bound, beside the QA repro (c2fold.test.mjs).
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';
const F = sliceDaimond(makeWindow({}), ['daimonPrior', 'foldFrom', 'mergeFold', 'foldCover', 'foldGap', 'tailAfter', 'sessionDoubt', 'dedupeSession'], { diag() {} }).fns;
const J = JSON.stringify, said = (l) => l.map((m) => m.content);
let fail = 0; const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fail++; };
const FOLD = '[Daimond folded the earlier part] summary';
const T = [
	{ role: 'user', content: 'q1', mid: 'u1', ts: 10 }, { role: 'assistant', content: 'a1', iturn: 'u1', ts: 20 },
	{ role: 'user', content: 'q2', mid: 'u2', ts: 40 }, { role: 'assistant', content: 'a2', mid: 'a2', iturn: 'u2', ts: 50 },
	{ role: 'user', content: 'q3', mid: 'u3', ts: 60 },
];
// 1. `before` decides: a turn in the transcript the engine never held is not covered.
const before = [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1' }];
const f1 = F.foldFrom({ messages: T }, [{ role: 'user', content: FOLD }, { role: 'user', content: 'q3', mid: 'u3' }], 'u3', null, 1, 'd', before);
check('the record names only the turns the engine held', J(f1.turns) === J(['u1']), J(f1));
check('the rebuild lays the uncovered turn, not the covered one', J(said(F.daimonPrior({ messages: T, fold: f1 }, 'u3'))) === J([FOLD, 'q2', 'a2']), J(said(F.daimonPrior({ messages: T, fold: f1 }, 'u3'))));
// 2. A refold that held the previous summary carries its turns.
const f2 = F.foldFrom({ messages: T }, [{ role: 'user', content: FOLD + ' 2' }, { role: 'user', content: 'q3', mid: 'u3' }], 'u3', f1, 2, 'd',
	[{ role: 'user', content: FOLD }, { role: 'user', content: 'q2', mid: 'u2' }]);
check('a refold carries the previous record\'s turns', J(f2.turns.slice().sort()) === J(['u1', 'u2']), J(f2));
// 3. mergeFold: the superset wins whatever its range; a listed record beats an unlisted one; both orders agree.
const big = { through: 'a2', throughTs: 50, turns: ['u1'], at: 1, dev: 'a', text: 'x' };
const sup = { through: 'a1', throughTs: 20, turns: ['u1', 'u2'], at: 2, dev: 'b', text: 'y' };
check('the record covering the other\'s turns wins', F.mergeFold(big, sup) === sup && F.mergeFold(sup, big) === sup, '');
const old = { through: 'a2', throughTs: 90, at: 0, dev: 'c', text: 'z' };
check('a listed record beats an unlisted one', F.mergeFold(old, big) === big && F.mergeFold(big, old) === big, '');
// 4. An unlisted record covers nothing: every turn is laid behind it.
check('an unlisted record proves nothing', J(said(F.daimonPrior({ messages: T, fold: old }, 'u3'))) === J(['z', 'q1', 'a1', 'q2', 'a2']), '');
// 5. The bound: a long chat's ids shed into floorTs, and the shed turns still read as covered.
const many = [];
for (let i = 0; i < 600; i++) many.push({ role: 'user', content: 'p' + i, mid: 'mid-long-id-' + i, ts: 100 + i });
many.push({ role: 'user', content: 'now', mid: 'now', ts: 9999 });
const f3 = F.foldFrom({ messages: many }, [{ role: 'user', content: FOLD }], 'now', null, 3, 'd');
check('the turns list stays under 8 KiB', J(f3.turns).length <= 8192 && f3.floorTs > 0, J(f3).length);
check('a shed turn is still covered', J(said(F.daimonPrior({ messages: many, fold: f3 }, 'now'))) === J([FOLD]), '');
console.log(fail ? fail + ' FAILED' : 'all ok');
process.exit(fail ? 1 : 0);
