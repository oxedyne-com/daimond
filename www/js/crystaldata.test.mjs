/* ============================================================
   Test -- JSON that does not parse is neither a crystal nor markdown
   (r540 QA 2, S2-2; specs/daimond_r540_qa_opus_2_20261009.md).

   THE BUG. `crystalData` read any text `crystal.js parse` refused as the OLD MARKDOWN FORMAT, so
   `{"title":"T",}` -- JSON with a trailing comma, a daimon's half-written edit -- became one
   section of prose. `crystalJson` is what a History restore, an undo of a fold and a backup
   import write back, so each of them replaced the owner's damaged-but-recoverable file with a
   wrapper around it, and `renderCrystal` drew the wrapper as a crystal with content.

   THE FIX. A text that starts with `{` and fails `parse` answers `null` from `crystalData` (so
   `crystalJson` returns it exactly as it came), and `crystalFile` says why for the face to
   name. Blank and valid JSON read as before; `crystalData` still migrates markdown (a backup,
   an old version), but the LIVE file read through `crystalFile` is JSON or it is unread
   (r544 QA C, F-C1).   `node www/js/crystaldata.test.mjs`
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
let crystalFile = null;
try { crystalFile = lift(['crystalFile', 'crystalLib']).crystalFile; } catch (e) { /* not there yet */ }
const crystalBroken = typeof crystalFile === 'function' ? (t) => crystalFile(t).broken : null;

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
check('markdown: crystalData still migrates it (backups, old versions)', crystalData(md) && Array.isArray(crystalData(md).sections || []));
check('markdown as the live file: unread, no text, no data (F-C1)', typeof crystalFile === 'function'
	&& crystalFile(md).unread === true && crystalFile(md).data === null && crystalFile(md).text === '');
check('blank: an empty crystal, not broken', JSON.stringify(crystalData('')) === '{}'
	&& typeof crystalBroken === 'function' && crystalBroken('  \n') === null);
check('an array is not a crystal: unread, not damaged JSON to mend',
	typeof crystalFile === 'function' && crystalFile('[1,2]').unread === true);

// No library: the text goes back as it came, and nothing is called broken.
const bare = makeWindow({});
const bareFns = sliceDaimond(bare, ['crystalData', 'crystalJson', 'crystalLib'], {}).fns;
let bareBroken = null;
try { const f = sliceDaimond(bare, ['crystalFile', 'crystalLib'], {}).fns.crystalFile; bareBroken = (t) => f(t).broken; } catch (e) { /* not there yet */ }
check('no library: unchanged, and not called broken',
	bareFns.crystalJson('{"title":"T",}') === '{"title":"T",}'
	&& typeof bareBroken === 'function' && bareBroken('{"title":"T",}') === null);

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystaldata: all passed');
