/* ============================================================
   Test -- the mend box and the daimon are given one place for one fault (r546 D-26 F5).

   THE BUG. The page's `fault` (crystal.js) and the engine's `crystal_json_fault` (tools.rs, the
   K0 gate) each said where a crystal stops being JSON, by different rules: `{"a":1,\n}` was
   line 2, column 1 to the owner (the `}`) and line 1, column 7 to the daimon (the `,`); a
   truncated string, a bad escape and a misspelt `true` differed too. So the owner and the
   daimon were pointed at different places for the same file.

   THE FIX. One convention, the engine's: the place named is the start of what is wrong -- the
   trailing comma, the backslash of a bad escape, the start of a misspelt literal, the last
   character of a text cut off inside a string. Both suites run the one table,
   dev/fixtures/crystal_json_faults.json.   `node www/js/crystalfault.test.mjs`
   ============================================================ */

import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const win = makeWindow({ extra: {} });
loadScript(win, 'crystal.js');
const C = win.DaimondCrystal;
const rows = JSON.parse(readFileSync(new URL('../../dev/fixtures/crystal_json_faults.json', import.meta.url), 'utf8'));
check('the shared table read', Array.isArray(rows) && rows.length >= 20, String(rows && rows.length));

for (const [text, where] of rows) {
	const m = /^line (\d+), column (\d+)$/.exec(where);
	const r = C.parse(text);
	const at = r && r.at;
	const ok = !!m && r && !r.ok && !!at && at.line === Number(m[1]) && at.column === Number(m[2]);
	check(JSON.stringify(text) + ' is named at ' + where, ok,
		at ? 'line ' + at.line + ', column ' + at.column : 'no place');
	// The caret's offset is the same place, in UTF-16 units.
	if (ok) {
		const head = text.slice(0, at.offset);
		const col = Array.from(head.slice(head.lastIndexOf('\n') + 1)).length + 1;
		check(JSON.stringify(text) + ': the offset is that place', col === at.column, String(at.offset));
	}
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystalfault: all passed');
