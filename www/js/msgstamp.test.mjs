/* ============================================================
   Test -- an in-place edit of a stored message is stamped AFTER its last write
   (the message law's audit, F1, 2026-10-02).
   ------------------------------------------------------------
   `touchMsg` stamps `at` and forgets the message's fingerprint, so it has to come
   after the edit it stands for: a stamp taken before a later write of the same message
   would order the copy below one that held less. The live line added one in-place edit the
   law did not know (since 5.2.1) -- a filed mail draft names a product (`prod`) on the
   tool log that carried the draft -- in `runTurn` and in the daimon's loop. Merged beside
   the law's own `touchMsg(pendingTool)` the two collided; the resolution puts the stamp
   after the `prod` write.

   WHAT IS CHECKED, in the text of the tree under test (`TREE=<checkout>`): each
   `mail_draft` block that writes `.prod` is followed, as the next statement after its
   closing brace, by `touchMsg` of the same message; and there are exactly two such
   blocks, so a third has to be read before the count is changed.
     node www/js/msgstamp.test.mjs     # ALL PASS
   ============================================================ */
import { readFileSync } from 'node:fs';
import { js } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const lines = readFileSync(js('daimond.js'), 'utf8').split('\n');

// The blocks that file a mail draft's product onto a message in place.
const blocks = [];
for (let i = 0; i < lines.length; i++) {
	if (!/ev\.name === 'mail_draft' && ev\.outcome === 'done'/.test(lines[i])) continue;
	let depth = 0, j = i, wrote = null;
	for (; j < lines.length; j++) {
		for (const ch of lines[j].replace(/'(?:[^'\\]|\\.)*'/g, "''")) { if (ch === '{') depth++; else if (ch === '}') depth--; }
		const w = /\b(\w+)\.prod = \[/.exec(lines[j]);
		if (w) wrote = w[1];
		if (depth === 0) break;
	}
	let k = j + 1;
	while (k < lines.length && (/^\s*$/.test(lines[k]) || /^\s*\/\//.test(lines[k]))) k++;
	blocks.push({ at: i + 1, wrote, next: (lines[k] || '').trim() });
}

check('two mail-draft blocks file a product in place (runTurn, the daimon\'s loop)',
	blocks.filter((b) => b.wrote).length === 2, JSON.stringify(blocks));
for (const b of blocks.filter((x) => x.wrote)) {
	check('line ' + b.at + ': `' + b.wrote + '.prod` is written, then stamped as the next statement',
		b.next === 'touchMsg(' + b.wrote + ');', 'next statement is: ' + b.next);
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
