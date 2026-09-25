/* ============================================================
   Test: a runner's catch-up with no version to reach pulls on a backoff
   (r52d QA F4), counted.

   `peerReconstruct` waits for an errand's chat to be resident. An errand
   whose parcel-first flush was unconfirmed carries want 0 (7509b8d7), and
   the loop pulled the whole parcel every 150 ms until the chat appeared or
   45 s passed with nothing moving. It now pulls from the wake floor (1 s)
   up to 4 s apart, back to the floor on movement; a known target keeps
   its 400 ms pace.

   Lifts the REAL `peerReconstruct` out of daimond.js with its stall window
   cut to 6 s, a chat that never arrives, and a counting `DaimondSync.pull`.

     BLIND   want 0: at most 6 pulls in 6 s (7ca624dd: 40)
     MOVED   want 0, the wake channel moves the version: the stall window
             restarts, the pulls go back to the floor
     [ctl]   want ahead of the device: the 400 ms pace is unchanged

   Run:  node www/js/catchup.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
function extractFn(src, name) {
	const start = src.indexOf('\n\tfunction ' + name + '(');
	const at = start >= 0 ? start : src.indexOf('\n\tasync function ' + name + '(');
	if (at < 0) throw new Error('function not found: ' + name);
	const brace = src.indexOf('{', at);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(at + 1, i);
}

const src = readFileSync(process.env.DAIMOND_JS || join(HERE, 'daimond.js'), 'utf8');
const STALL = 6000;
function runner(sync) {
	return new Function('env', [
		'var window = { DaimondSync: env.sync }, DaimondSync = env.sync;',
		'var RECONSTRUCT_STALL_MS = ' + STALL + ', RECONSTRUCT_ABS_CAP_MS = 60000;',
		'var RECONSTRUCT_PULL_MIN_MS = 1000, RECONSTRUCT_PULL_MAX_MS = 4000;',
		'var chats = [];',
		'var DaimondPeer = { holdsThread: function () { return false; } };',
		'function diag() {}',
		'async function graftSeed() { return false; }',
		'async function onChatsChangedElsewhere() {}',
		'async function loadChatMessages() {}',
		extractFn(src, 'peerReconstruct'),
		'return peerReconstruct;',
	].join('\n'))({ sync });
}
function counting(start, move) {
	const s = { v: start, pulls: [], t0: Date.now() };
	s.version = () => s.v;
	s.pull = async () => { s.pulls.push(Date.now() - s.t0); if (move) move(s); return s.v; };
	return s;
}

console.log('\nBLIND: want 0, a chat that never arrives\n');
{
	const s = counting(7);
	let err = null;
	try { await runner(s)({ chatId: 'c-none', turnId: 't1', parcelVersion: 0 }); } catch (e) { err = e; }
	check('the catch-up ends undeliverable, as before', !!err && err.undeliverable === true, String(err));
	check('at most 6 pulls in the ' + STALL / 1000 + ' s window (7ca624dd: 40)', s.pulls.length <= 6, s.pulls.length + ' at ' + s.pulls.join(','));
	check('the first pull at once, the next no sooner than the 1 s floor', s.pulls[0] < 200 && (s.pulls.length < 2 || s.pulls[1] - s.pulls[0] >= 1000), s.pulls.join(','));
}

console.log('\nMOVED: want 0, the wake channel moves the version at 2.5 s\n');
{
	const s = counting(7);
	setTimeout(() => { s.v = 9; }, 2500);
	let err = null;
	const t0 = Date.now();
	try { await runner(s)({ chatId: 'c-none', turnId: 't2', parcelVersion: 0 }); } catch (e) { err = e; }
	const took = Date.now() - t0;
	check('the movement restarts the stall window (ends past ' + (2.5 + STALL / 1000) + ' s)', took >= 2500 + STALL - 300, took + ' ms');
	const after = s.pulls.filter((t) => t > 2500);
	check('and the next pull comes within the floor of it, not the 4 s ceiling', after.length > 0 && after[0] - 2500 <= 1500, after.join(','));
}

console.log('\n[ctl] want ahead of the device: the 400 ms pace\n');
{
	const s = counting(3);
	let err = null;
	try { await runner(s)({ chatId: 'c-none', turnId: 't3', parcelVersion: 50 }); } catch (e) { err = e; }
	check('a known target is still pulled for at its own pace (>= 10 pulls in ' + STALL / 1000 + ' s)', s.pulls.length >= 10, s.pulls.length + '');
}

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);
