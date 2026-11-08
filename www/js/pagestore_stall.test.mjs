/* ============================================================
   Test — PAGESTORE A: every ChatStore wait is bounded, wherever the store stops.
   ------------------------------------------------------------
   pagestore.test.mjs stalls the store from its first request, so only the first wait
   on each path is ever reached. Here the real ChatStore boots and reads a saved chat
   over a store that answers its first k callbacks (opens, requests, cursor steps,
   commits) and then never answers again, for every k up to the number an unstalled
   boot and read take. Each run must come back within a bound of the policy's wait.

     node www/js/pagestore_stall.test.mjs
   ============================================================ */
import { page } from './test/chatidb.mjs';

const WAIT = 40;	// ms: the policy's store wait for this test
const BOUND = WAIT * 25;	// a stalled run makes a few waits in turn, each bounded

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const within = (p, ms) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r(null), ms))]);
const msg = (i) => ({ mid: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: 'line ' + i, ts: 1700000000000 + i });

const data = new Map();
const A = page(data, undefined, undefined, undefined, WAIT);
await A.ChatStore.boot();
A.ChatStore.save([{ id: 'c1', name: 'one', messages: [0, 1, 2, 3].map(msg), session: { msgs: [] }, updatedAt: Date.now(), _loaded: true }]);
check('the chat is saved', !!(await within(A.ChatStore.settled(), BOUND)));

const run = async (P) => {
	try { await P.ChatStore.boot(); } catch (e) { /* a stalled boot may throw: it came back */ }
	try { return await P.ChatStore.loadMessages('c1'); } catch (e) { return { threw: true }; }
};
let total = 0;
const all = await within(run(page(data, undefined, undefined, (fn) => { total++; fn(); }, WAIT)), BOUND);
check('an answering store serves the chat', !!all && all.v.messages && all.v.messages.length === 4, all && JSON.stringify(all.v).slice(0, 80));

const hung = [];
for (let k = 0; k <= total; k++) {
	let left = k;
	const P = page(data, undefined, undefined, (fn) => { if (left > 0) { left--; fn(); } }, WAIT);
	if (!(await within(run(P), BOUND))) hung.push(k);
}
check('boot and a chat read come back wherever the store stops (k = 0..' + total + ')', hung.length === 0, 'hung after k = ' + hung.join(','));

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
