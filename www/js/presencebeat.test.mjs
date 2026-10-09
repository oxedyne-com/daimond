/* ============================================================
   Test: the presence beat is ONE timer, started and stopped as one (r545, FA; r544 QA-A F-A3).

   r544 added a 1 s busy/idle edge read beside the 45 s beat as a second
   `setInterval` whose handle was dropped, so nothing could stop it and a
   second start would have stacked another, each walking every chat once a
   second. The edge now drives the beat: one interval reads the edge each
   second and beats on an edge or once the beat interval has passed.

   Lifts the REAL beat block out of daimond.js (from `var _beatBusy` to the
   unlock listener) with a fake clock, counted timers and a counting
   `presenceTick`.

     ONE      start: exactly one live timer, and a beat at once
     TWICE    a second start adds nothing
     CADENCE  no beat inside the interval; one at it
     EDGE     busy flips: a beat within a second, and none while it holds
     STOP     stop: no live timer; a pulse after it beats nothing
     RESTART  start after stop: one live timer again

   Run:  node www/js/presencebeat.test.mjs
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

const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const from = src.indexOf('\n\tvar _beatBusy = null;');
const to = src.indexOf("\ttry { window.addEventListener('daimond:unlock', startPresenceBeat);", from);
if (from < 0 || to < 0) throw new Error('presence beat block not found in daimond.js');
const block = src.slice(from, to);

function rig() {
	const st = { now: 1000000, busy: 0, ticks: 0, timers: new Map(), next: 1 };
	const fakeDate = { now: () => st.now };
	const setI = (fn, ms) => { const h = st.next++; st.timers.set(h, { fn, ms, at: st.now }); return h; };
	const clearI = (h) => { st.timers.delete(h); };
	const win = { DaimondPresence: { BEAT_MS: 45000 } };
	const make = new Function('Date', 'setInterval', 'clearInterval', 'window', 'DaimondPresence', 'busyForChat', 'st',
		'var _presenceTimer = null;\n'
		+ 'function presenceTick() { st.ticks++; _beatBusy = st.busy > 0; _beatAt = Date.now(); }\n'
		+ block
		+ '\nreturn { start: startPresenceBeat, stop: typeof stopPresenceBeat === "function" ? stopPresenceBeat : null };');
	const api = make(fakeDate, setI, clearI, win, win.DaimondPresence, () => st.busy, st);
	// Advance the fake clock by `ms`, firing each live timer as its period comes round.
	st.run = (ms) => {
		const end = st.now + ms;
		while (st.now < end) {
			st.now += 250;
			for (const [h, t] of [...st.timers]) {
				if (!st.timers.has(h)) continue;
				if (st.now - t.at >= t.ms) { t.at = st.now; t.fn(); }
			}
		}
	};
	return { st, api };
}

{
	const { st, api } = rig();
	api.start();
	check('ONE: start leaves exactly one live timer', st.timers.size === 1, 'live ' + st.timers.size);
	check('ONE: start beats at once', st.ticks === 1, 'ticks ' + st.ticks);
	api.start();
	check('TWICE: a second start adds no timer', st.timers.size === 1, 'live ' + st.timers.size);
	check('TWICE: and no beat', st.ticks === 1, 'ticks ' + st.ticks);
	st.run(40000);
	check('CADENCE: no beat inside the 45 s interval', st.ticks === 1, 'ticks ' + st.ticks);
	st.run(6000);
	check('CADENCE: one beat once it has passed', st.ticks === 2, 'ticks ' + st.ticks);
	st.busy = 1;
	st.run(1250);
	check('EDGE: going busy beats within a second', st.ticks === 3, 'ticks ' + st.ticks);
	st.run(10000);
	check('EDGE: no beat while busy holds', st.ticks === 3, 'ticks ' + st.ticks);
	st.busy = 0;
	st.run(1250);
	check('EDGE: going idle beats within a second', st.ticks === 4, 'ticks ' + st.ticks);
	check('STOP: there is a stop', typeof api.stop === 'function');
	if (api.stop) {
		api.stop();
		check('STOP: stop leaves no live timer', st.timers.size === 0, 'live ' + st.timers.size);
		st.busy = 1;
		st.run(60000);
		check('STOP: nothing beats after it', st.ticks === 4, 'ticks ' + st.ticks);
		api.start();
		check('RESTART: start after stop leaves one live timer', st.timers.size === 1, 'live ' + st.timers.size);
		check('RESTART: and beats at once', st.ticks === 5, 'ticks ' + st.ticks);
	}
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
