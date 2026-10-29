/* ============================================================
   Test -- U3a QRFIX2 F2: a resumed worker's retry after a key re-issue sends the NUDGE.
   ------------------------------------------------------------
   The re-mint retry now runs on the RESTORED seed (`seedSession`), so re-sending `run.task`
   there showed the model [task, progress so far, task]: the task restated after the work, an
   invitation to do it again. The retry sends what the first attempt sent. Runs the REAL
   first-attempt-and-retry block of `start()` with a first attempt that dies on its key.
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';

const D = readPage(process.env.DAIMOND_JS || new URL('./daimond.js', import.meta.url), 'utf8');
let ok = 0, bad = 0;
const check = (name, cond, detail) => {
	if (cond) { ok++; console.log('  ok   ' + name); }
	else { bad++; console.log('  FAIL ' + name + (detail ? '  -- ' + detail : '')); }
};
const A = '\t\t\t\ttry {\n\t\t\t\t\t// Cleared as it is read';
const Z = '\t\t\t\t// A stopped or paused worker keeps whatever it managed to do';
const a = D.indexOf(A), z = D.indexOf(Z, a);
if (a < 0 || z < 0) { console.log('  FAIL could not lift the block'); process.exit(1); }
const seg = D.slice(a, z);
const block = new Function('run', 'state', 'DaimondModels', 'billAttempt', 'self', 'build', 'scope', 'seedSession',
	'turnMeter', 'window', 'RESUME_NUDGE', 'VISION_NUDGE', 'runNode', 'firstAsk', 'ensureWantMinor',
	'var reminted = false, wmeter = null, sink = {}, authFail = false;'
	+ ' state.fail = function () { authFail = true; };'
	+ ' return (async function () {\n' + seg + '\n})();');

async function go(run) {
	const sent = [];
	const state = {};
	let built = 0;
	const mkApp = () => ({ async run_turn(msg) { sent.push(msg); if (sent.length === 1) { state.fail(); throw new Error('402'); } } });
	run.app = mkApp();
	await block(run, state, { remintSlot: async () => ({}) }, () => {}, { render() {} },
		() => { built++; run.app = mkApp(); }, async () => {}, () => {}, () => null, {}, 'RESUME', 'VISION', 'node', (r) => r.task, () => 500);
	return { sent, built };
}
for (const [label, run, want] of [
	['a Resume', { task: 'Survey the notes', resume: true, status: 'running', tools: [] }, 'RESUME'],
	['a vision re-route', { task: 'Survey the notes', resume: true, _vision: true, status: 'running', tools: [] }, 'VISION'],
	['a fresh dispatch', { task: 'Survey the notes', status: 'running', tools: [] }, 'Survey the notes'],
]) {
	console.log(label + ': the first attempt dies on its key, the key is re-issued, the retry runs');
	const r = await go(run);
	check('the retry sends what the first attempt sent (' + want + '), not the task again',
		r.built === 1 && r.sent.length === 2 && r.sent[0] === want && r.sent[1] === want, JSON.stringify(r));
}
console.log(`\nremint nudge (qr2 F2): ${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
