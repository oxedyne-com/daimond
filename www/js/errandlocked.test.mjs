/* ============================================================
   Test -- the errand says which packs the account has not bought (U13a PACK-CARRY).
   ------------------------------------------------------------
   The pack gate is the wasm's `LOCKED_PACKS`, which only the page sets (tools.js `pushLocks`).
   A handed-off turn runs on the runner, which never hears it, so the errand carries the list:
   `locked`, read from `Wasm.locked_packs()` as the tab holds it. The runner reads a MISSING
   list as every pack locked, so the page sends nothing rather than a guess when it cannot read
   its own: the module not up, or a throw. The real `errandLocked` is lifted out of daimond.js by
   source (`dev/syncprobe.mjs` `sliceDaimond`) over a `Wasm` stand-in; the real peer.js
   `buildDispatch` and `makeErrand` build the envelope.

   Run:  node www/js/errandlocked.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── The page reads its own list, or sends none ───────────────────────────
{
	let answer = () => 'drop01,email';
	const Wasm = { locked_packs: () => answer() };
	let F = null;
	try { F = sliceDaimond(makeWindow({}), ['errandLocked'], { Wasm }).fns; }
	catch (e) { check('errandLocked is in daimond.js', false, String(e && e.message)); }
	if (F) {
		check('two locked packs read as a list', same(F.errandLocked(), ['drop01', 'email']));
		answer = () => 'drop01';
		check('one locked pack reads as a list of one', same(F.errandLocked(), ['drop01']));
		answer = () => '';
		check('nothing locked reads as an empty list', same(F.errandLocked(), []));
		answer = () => ' DROP01 , ,';
		check('blanks are dropped and case is folded', same(F.errandLocked(), ['drop01']));
		answer = () => { throw new Error('module not up'); };
		check('a throw sends no list (the runner locks all)', F.errandLocked() === undefined);
		answer = () => undefined;
		check('no answer sends no list', F.errandLocked() === undefined);
	}
	let G = null;
	try { G = sliceDaimond(makeWindow({}), ['errandLocked'], { Wasm: {} }).fns; } catch (e) {}
	check('a module without the export sends no list', !!G && G.errandLocked() === undefined);
}
// ── The dispatch door passes it ──────────────────────────────────────────
{
	const src = readPage(new URL('./daimond.js', import.meta.url), 'utf8');
	check('dispatchToPeer sends errandLocked() as locked', /locked:\s*errandLocked\(\),/.test(src));
}
// ── The envelope ─────────────────────────────────────────────────────────
{
	const body = readPage(new URL('./peer.js', import.meta.url), 'utf8');
	const pw = { addEventListener() {}, dispatchEvent() { return true; } };
	new Function('window', 'document', 'with (window) {\n' + body + '\n}')(pw, { addEventListener() {} });
	const P = pw.DaimondPeer;
	check('makeErrand keeps a locked list', same(P.makeErrand({ locked: ['drop01'] }).locked, ['drop01']));
	check('and an empty one, which unlocks', same(P.makeErrand({ locked: [] }).locked, []));
	check('no list writes no key', !('locked' in P.makeErrand({})));
	check('a string is no list', !('locked' in P.makeErrand({ locked: 'drop01' })));
	const chat = { id: 'c9', messages: [{ role: 'user', content: 'go', mid: 't9', ts: 1 }] };
	const sent = (extra) => P.buildDispatch(chat, Object.assign({ turnId: 't9', prompt: 'go', now: 2 }, extra)).errand(0);
	check('a dispatch carries its locked list', same(sent({ locked: ['drop01'] }).locked, ['drop01']));
	check('a dispatch with none carries no key', !('locked' in sent({})));
	check('an errand made again keeps the list', same(P.makeErrand(sent({ locked: ['email'] })).locked, ['email']));
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) process.exit(1);
