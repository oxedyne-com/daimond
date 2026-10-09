/* ============================================================
   Test -- JSON that does not parse is neither a crystal nor markdown
   (r540 QA 2, S2-2; specs/daimond_r540_qa_opus_2_20261009.md).

   THE BUG. `crystalData` read any text `crystal.js parse` refused as the OLD MARKDOWN FORMAT, so
   `{"title":"T",}` -- JSON with a trailing comma, a daimon's half-written edit -- became one
   section of prose. `crystalJson` is what a History restore, an undo of a fold and a backup
   import write back, so each of them replaced the owner's damaged-but-recoverable file with a
   wrapper around it, and `renderCrystal` drew the wrapper as a crystal with content.

   THE FIX. A text that starts with `{` and fails `parse` answers `null` from `crystalData` (so
   `crystalJson` returns it exactly as it came), and `crystalBroken` says why for the face to
   name. Markdown, blank and valid JSON read as before.   `node www/js/crystaldata.test.mjs`
   ============================================================ */

import { makeWindow, loadScript, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const win = makeWindow({});
loadScript(win, 'crystal.js');
const lift = (names) => sliceDaimond(win, names, {}).fns;
const { crystalData, crystalJson } = lift(['crystalData', 'crystalJson', 'crystalLib']);
let crystalBroken = null;
try { crystalBroken = lift(['crystalBroken', 'crystalLib']).crystalBroken; } catch (e) { /* not there yet */ }

const damaged = {
	'trailing comma':   '{"title":"T",}',
	'cut off':          '{"title":"Ontheism",\n"summary":"half a cry',
	'single quotes':    "{'title':'T'}",
	'a byte order mark': '﻿{"title":"T","sections":[1,}',
	'comment':          '{"title":"T", // c\n"body":"B"}',
	'padded':           '  \n{"title":"T" "body":"B"}\n',
};
for (const [what, text] of Object.entries(damaged)) {
	check(what + ': crystalData is null, not a one-section crystal', crystalData(text) === null,
		JSON.stringify(crystalData(text)).slice(0, 80));
	check(what + ': crystalJson hands the text back unchanged', crystalJson(text) === text,
		crystalJson(text).slice(0, 80));
	check(what + ': crystalBroken says why', typeof crystalBroken === 'function' && !!crystalBroken(text),
		String(crystalBroken && crystalBroken(text)));
}

// Everything else reads as it always did.
const ok = '{"title":"T","summary":"S"}';
check('valid JSON: parsed, and written back pretty', crystalData(ok).title === 'T'
	&& crystalJson(ok) === JSON.stringify(JSON.parse(ok), null, 2));
check('valid JSON: not broken', typeof crystalBroken === 'function' && crystalBroken(ok) === null);
const md = '# Title\n\nsome prose\n\n## Heading\n\nbody\n';
check('markdown: still migrated, not broken', crystalData(md) && Array.isArray(crystalData(md).sections || [])
	&& typeof crystalBroken === 'function' && crystalBroken(md) === null);
check('blank: an empty crystal, not broken', JSON.stringify(crystalData('')) === '{}'
	&& typeof crystalBroken === 'function' && crystalBroken('  \n') === null);
check('an array is not JSON that failed: left to the old reading',
	typeof crystalBroken === 'function' && crystalBroken('[1,2]') === null);

// No library: the text goes back as it came, and nothing is called broken.
const bare = makeWindow({});
const bareFns = sliceDaimond(bare, ['crystalData', 'crystalJson', 'crystalLib'], {}).fns;
let bareBroken = null;
try { bareBroken = sliceDaimond(bare, ['crystalBroken', 'crystalLib'], {}).fns.crystalBroken; } catch (e) { /* not there yet */ }
check('no library: unchanged, and not called broken',
	bareFns.crystalJson('{"title":"T",}') === '{"title":"T",}'
	&& typeof bareBroken === 'function' && bareBroken('{"title":"T",}') === null);

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystaldata: all passed');
