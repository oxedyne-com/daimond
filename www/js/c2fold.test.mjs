// QA r572y C2a: fold record vs a turn from another device that the fold never summarised.
import { makeWindow, declLine } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
const names = ['daimonPrior', 'foldFrom', 'mergeFold', 'tailAfter', 'sessionDoubt', 'dedupeSession', 'sessionMarker'];
const have = names.filter((n) => declLine(n) > 0);
const F = loadPage({ window: makeWindow({}), want: have, stub: { diag() {} } });
const J = JSON.stringify, said = (l) => l.map((m) => m.content);
let fail = 0; const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fail++; };
const FOLD = '[Daimond folded the earlier part of this conversation] A asked q1 and q2; we chose blue';

// A's transcript when its engine folded: q1 a1 q2 a2, then the turn q3 whose run folded.
const onA = [
	{ role: 'user', content: 'q1', mid: 'u1', ts: 10 },
	{ role: 'assistant', content: 'a1', mid: 'a1', iturn: 'u1', ts: 20 },
	{ role: 'user', content: 'q2', mid: 'u2', ts: 40 },
	{ role: 'assistant', content: 'a2', mid: 'a2', iturn: 'u2', ts: 50 },
	{ role: 'user', content: 'q3', mid: 'u3', ts: 60 },
];
const after = [ { role: 'user', content: FOLD }, { role: 'user', content: 'q3', mid: 'u3' }, { role: 'assistant', content: 'a3' } ];
const foldA = F.foldFrom({ messages: onA }, after, 'u3', null, 100, 'devA');
check('A folds through a2', foldA && foldA.through === 'a2', J(foldA));

// B ran a turn at ts 30/35 (between a1 and q2) that reached A only after A's fold.
const bTurn = [
	{ role: 'user', content: 'B: make the widget', mid: 'ub', ts: 30 },
	{ role: 'assistant', content: 'B: widget built', mid: 'ab', iturn: 'ub', ts: 35 },
];
const merged = onA.concat([{ role: 'assistant', content: 'a3', mid: 'a3', iturn: 'u3', ts: 70 }], bTurn,
	[{ role: 'user', content: 'what did we build?', mid: 'u4', ts: 80 }]).sort((x, y) => x.ts - y.ts);

// 1. A third device (or B after its session was evicted) rebuilds from the fold.
const w1 = said(F.daimonPrior({ id: 'c', messages: merged, session: null, fold: foldA }, 'u4'));
check('rebuild from the fold keeps B\'s turn, which the fold never summarised', w1.includes('B: widget built'), J(w1));

// 2. A itself, holding the folded session, after B's turn synced in below the fold point.
const sessA = { v: 1, upto: 'a3', uptoTs: 70, msgs: after };
const w2 = said(F.daimonPrior({ id: 'c', messages: merged, session: sessA, fold: foldA }, 'u4'));
check('A\'s folded session hears B\'s late turn', w2.includes('B: widget built'), J(w2));

// 3. Two folds: B's covers B's turn (through ab, ts 35); A's covers more range (through a2, ts 50) but not B's turn.
const foldB = { through: 'ab', throughTs: 35, at: 90, dev: 'devB', text: '[Daimond folded the earlier part] B built the widget' };
const win = F.mergeFold(foldA, foldB);
const w3 = said(F.daimonPrior({ id: 'c', messages: merged, session: null, fold: win }, 'u4'));
check('after mergeFold the rebuild still knows of B\'s widget', w3.some((s) => /widget/.test(s)), J(w3));
console.log(fail ? fail + ' FAILED' : 'all ok');
process.exit(fail ? 1 : 0);
