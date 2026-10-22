/* ============================================================
   Test -- a command the page gives up on is told to stop (QA r578d D1).

   The engine's half is `wasm::hand::run`, whose drop guard sends `term` when a Stop or its
   ceiling abandons the call. The page's own waits are the other half: `hand.js` gives a run up
   when the hand never acknowledges it, or never says how it ended, and until r578e the command
   went on to its own timeout -- fifteen minutes for a `run`, two hours for a `verify`. The REAL
   www/js/hand.js is loaded into a bare `window` with a stub extension port; a file operation
   given up the same way sends no signal, since there is no process behind it.

   Run:  node www/js/handabandon.test.mjs
   ============================================================ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, cases = 0;

async function kase(name, fn) {
	cases++;
	let bad = null;
	try { bad = await fn(); } catch (e) { bad = 'threw ' + (e && e.message); }
	if (bad) { failures++; console.log('  FAIL ' + name + '  (' + bad + ')'); }
	else { console.log('  ok   ' + name); }
}

/// The real relay, over a port that greets and then says nothing about any run.
function load() {
	const posted = [];
	const listeners = {};
	const port = {
		onMessage:    { addListener: f => { port.recv = f; } },
		onDisconnect: { addListener: () => {} },
		postMessage:  m => {
			// A file request the port cannot carry: the relay gives it up at once.
			if (m.t === 'file') throw new Error('port closed');
			posted.push(m);
			if (m.t === 'hello') setTimeout(() => port.recv({ t: 'hello', host: 'stub', caps: [], root: '/w' }), 0);
			// A command the hand starts and then never says the end of.
			if (m.t === 'exec' && m.started) setTimeout(() => port.recv({ t: 'started', id: m.id, pid: 1 }), 0);
		},
	};
	const win = {
		addEventListener: (t, f) => { listeners[t] = f; },
		chrome: { runtime: { connect: () => port, lastError: null } },
	};
	win.window = win;
	new Function('window', 'chrome', 'document', readFileSync(join(HERE, 'hand.js'), 'utf8'))(
		win, win.chrome, { documentElement: { dataset: { daimondHands: 'ext-id' } } });
	win.DaimondHand._setWaitsForTest({ grace: 20, slack: 20 });
	return { hand: win.DaimondHand, posted };
}

const settle = p => p.then(() => 'resolved', e => String(e && e.message));
const signals = (posted, id) => posted.filter(m => m.t === 'signal' && m.id === id);

await kase('a command never acknowledged is given up and told to stop', async () => {
	const { hand, posted } = load();
	const got = await settle(hand.run(JSON.stringify({ t: 'exec', id: 'cargo-1', argv: ['cargo'] })));
	if (got === 'resolved') return 'the run resolved with no answer from the hand';
	await new Promise(r => setTimeout(r, 10));
	const s = signals(posted, 'cargo-1');
	if (s.length !== 1) return 'signals for the given-up run: ' + JSON.stringify(s);
	if (s[0].sig !== 'term') return 'not a term: ' + s[0].sig;
	return null;
});

await kase('a command that started and never ended is given up and told to stop', async () => {
	const { hand, posted } = load();
	const got = await settle(hand.run(JSON.stringify({ t: 'exec', id: 'verify-2', timeout_ms: 10, started: 1 })));
	if (got === 'resolved') return 'the run resolved with no end from the hand';
	if (!/started the command/.test(got)) return 'not given up after starting: ' + got;
	await new Promise(r => setTimeout(r, 10));
	return signals(posted, 'verify-2').length === 1 ? null : 'no term for the given-up run';
});

await kase('a file operation given up sends no signal, having no process behind it', async () => {
	const { hand, posted } = load();
	await settle(hand.file(JSON.stringify({ t: 'file', id: 'f-1', op: 'read', path: 'a' })));
	await new Promise(r => setTimeout(r, 10));
	return signals(posted, 'f-1').length === 0 ? null : 'a file operation was signalled';
});

console.log(`\n${cases - failures}/${cases} passed`);
if (failures) process.exit(1);
