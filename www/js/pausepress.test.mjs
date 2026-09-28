/* ============================================================
   Test — a person's press is announced as a press (R53-U8).
   ------------------------------------------------------------
   The reopen rehearsal's U8 (2026-09-25): a play pressed on
   argonaut reached the phone 3.8-5.1 s later, because the press
   waited out the sync's 2.5 s coalescing debounce like any other
   change, and a turn typed on the phone inside that time was
   refused for the pause just ended. sync.js now sends a press at
   once, and tells a press from every other move by what pause.js
   announces: 'press' from `set` when the record moved, nothing
   from an adopted record, another tab or an app write. That line
   is what this holds, over the real pause.js:

     node www/js/pausepress.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readFileSync(process.env.PAUSE_JS || join(HERE, 'pause.js'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

function storage() {
	const m = new Map();
	return {
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => { m.set(k, String(v)); },
		removeItem: (k) => { m.delete(k); },
	};
}

/// One device: the real pause.js over its own window, storage and clock, and every
/// announcement it makes, as sync.js's subscriber receives it.
function device(dev, t0) {
	const ls = storage();
	let now = t0;
	const win = {
		localStorage: ls,
		addEventListener: (type, fn) => { (win.on[type] = win.on[type] || []).push(fn); },
		dispatchEvent: () => true,
		DaimondIdentity: { deviceId: () => dev },
		on: {},
	};
	loadStore(win, ls);
	new Function('window', 'localStorage', 'CustomEvent', 'Date', SRC)(win, ls,
		function CustomEvent(type) { this.type = type; }, { now: () => now });
	const heard = [];
	win.DaimondPause.subscribe((why) => heard.push(why === undefined ? 'undefined' : why));
	return { P: win.DaimondPause, heard, tick: (ms) => { now += ms; } };
}

const A = device('argonaut', 1_000_000);
const B = device('phone', 1_000_000);
const ROOT = A.P.ROOT;

A.P.set(ROOT, false);
check('a Pause all pressed here is announced as a press', A.heard.join() === 'press', JSON.stringify(A.heard));

A.heard.length = 0;
A.P.set(ROOT, false);
check('the same press again moves nothing and announces nothing', A.heard.length === 0, JSON.stringify(A.heard));

B.P.adopt(A.P.snapshot());
check('the press adopted on the other device is announced, and not as a press',
	B.heard.length === 1 && B.heard[0] === '', JSON.stringify(B.heard));
check('and the other device holds it', B.P.isPaused(ROOT) === true);

A.tick(1000);
A.heard.length = 0;
A.P.set(ROOT, true);
check('play pressed here is announced as a press', A.heard.join() === 'press', JSON.stringify(A.heard));

B.heard.length = 0;
B.P.adopt(A.P.snapshot());
check('the play adopted there is announced, not as a press', B.heard.join() === '', JSON.stringify(B.heard));
check('and it plays there', B.P.isPaused(ROOT) === false);

B.heard.length = 0;
B.P.seedPaused(B.P.id('root', 'chats', 'c1'));
check('an app write (a seed) is announced, not as a press', B.heard.join() === '', JSON.stringify(B.heard));

console.log(`\npausepress: ${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
