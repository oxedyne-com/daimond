/* ============================================================
   Test — chat log taps on the poll fallback (sync.js `wakePoll`, LAG-1c).
   ------------------------------------------------------------
   The socket hears `c<chat>:<head>` whenever another device writes a
   chat's log, and hands it to `onLog` listeners (`logTapped`). A device
   whose socket is down parks plain requests instead, and before LAG-1c
   those parks neither asked for log taps nor read any: an iOS PWA on the
   fallback saw a turn run elsewhere only at the next parcel, +190 s,
   measured 30 Oct (alarm lag-a7b34e2-20261030T1623).

   Drives the REAL www/js/sync.js in a simulated tab (the pattern of
   progresstick.test.mjs) on the poll fallback, against a gateway
   stand-in whose parks answer as told, and asserts:

     L1. A page with a log listener parks asking `&log=1`.
     L2. A park answered with `log` hands each tap to the listeners, as
         the socket's `c` message would.
     L3. A park answered without `log` tells the listeners nothing.
     L4. A snapshot tap `s<chat>:<head>` in a park's `log` is not heard as
         a head: the gateway passes each tap with its own prefix (LAG-1d).
     COLD. The page's listener (handoff.js `onLogTap`) reads a chat that is
         closed and not resident when its head passes the cursor, and
         reads nothing for one at or below it, or one it does not hold.

   L1 and L2 fail on the sync.js before LAG-1c (2d52dc173):
     SYNC_JS=<2d52dc173's sync.js> node www/js/logpark.test.mjs   # FAIL
     node www/js/logpark.test.mjs                                  # ALL PASS
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';
import { readPage } from '../../dev/pagesrc.mjs';
import { liftFn } from './testlift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.location = { protocol: 'http:', host: 'logpark.test' };
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		dataset: {},
	};
	const document = {
		readyState: 'complete',
		hidden: false,
		addEventListener: () => {},
		querySelector: () => null,
		querySelectorAll: () => [],
		getElementById: () => null,
		createElement: () => Object.assign({}, noEl),
		body: noEl,
	};

	const tab = {
		win,
		unlocked: false,			// false while sync.js loads, so start() reaches nothing
		parks: [],					// every park's path, query and all
		answers: [],				// what the next parks answer, in order; then they hold
		sockets: [],				// every WebSocket the page opened
		intervals: new Map(),		// id -> { fn, ms }: fired by hand, never by the clock
		timeouts: new Map(),		// id -> fn: the same, fired only by `fireTimeouts`
	};

	// The seal is the identity's: here, the bytes as they are, under the right label.
	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked,
		deviceId: () => '00112233445566aa',
		handle: () => '',
		wrap: async (s) => s,
		unwrap: async (s) => s,
		wrapBytesAad: async (bytes, aad) => bytes,
		unwrapBytesAad: async (bytes, aad) => {
			if (aad !== 'daimond/peer/progress/1') throw new Error('wrong label: ' + aad);
			return bytes;
		},
	};
	const answer = (status, json) => ({ status, json: async () => {
		if (json === undefined) throw new Error('no body');
		return json;
	} });
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: tab.unlocked }),
		gwFetch: async (path) => {
			const q = new URL('http://x' + path).searchParams;
			if (q.has('above')) {
				tab.parks.push(path);
				const a = tab.answers.shift();
				// Nothing more to say: the park holds, as a real one would.
				return a ? answer(200, a) : new Promise(() => {});
			}
			return answer(200, { present: false, version: 0 });
		},
	};
	win.DaimondCore = {
		collectSync: async () => ({ v: 3, chats: [] }),
		syncSelfDeviceId: () => '00112233445566aa',
		busy: () => false,
		deviceSelfName: () => 'Chromium on Linux',
		syncMayCommitChunks: () => false,
		syncCommitBlockedReason: () => '',
		applySync: async () => ({}),
	};
	win.DaimondCloud = {
		// Digested on this thread: `subtle.digest` runs on libuv's pool, in real time, so
		// under load it could outlast the test's settling and a step be read early.
		sha256: async (s) => createHash('sha256').update(s).digest('hex'),
	};
	// The socket the page opens: open when the test says so, and fed by it.
	win.WebSocket = class {
		constructor(url) { this.url = url; this.readyState = 0; tab.sockets.push(this); }
		close() {
			if (this.readyState === 3) return;
			this.readyState = 3;
			if (this.onclose) this.onclose({});
		}
		send() {}
	};

	const body = readFileSync(process.env.SYNC_JS || join(HERE, 'sync.js'), 'utf8');
	const fn = new Function(
		'window', 'document', 'crypto', 'localStorage',
		'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'console',
		'with (window) {\n' + body + '\n}');
	// Timeouts never fire on their own: the page's own retries and backoffs must not run
	// mid-assertion. They are kept, and a test that follows the loop past a wait fires
	// them (`fireTimeouts`). Intervals are kept likewise.
	let nextId = 1;
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		(f) => { const id = nextId++; tab.timeouts.set(id, f); return id; },
		(id) => { tab.timeouts.delete(id); },
		(f, ms) => { const id = nextId++; tab.intervals.set(id, { fn: f, ms }); return id; },
		(id) => { tab.intervals.delete(id); },
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return tab;
}

/// Let every promise the page has in flight settle.
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

/// Fire every timeout the page holds now (a wait of the ladder, the park floor), then settle.
async function fireTimeouts(tab) {
	const due = [...tab.timeouts.entries()];
	due.forEach(([id]) => tab.timeouts.delete(id));
	due.forEach(([, f]) => f());
	await settle();
}

async function run(answers) {
	const tab = makeTab();
	tab.answers = answers;
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	const heard = [];
	S.onLog((chat, head) => heard.push(chat + ':' + head));
	S.wakeVia('poll');
	await settle();
	return { tab, heard, S };
}

console.log('\nA park answered by another device\'s log batches\n');
{
	const { tab, heard, S } = await run([
		{ ok: true, waited: true, version: 0, changed: false, progress: false, lease: false,
			log: ['cC1:5', 'cchat-2:3'] },
	]);
	check('the page is on the poll fallback', S.wake().mode === 'poll', JSON.stringify(S.wake()));
	const first = tab.parks[0] || '';
	check('L1. the park asks for log taps (&log=1)', /[?&]log=1(&|$)/.test(first), first);
	check('L2. each tap reaches the onLog listeners, chat and head',
		heard.join() === 'C1:5,chat-2:3', 'heard: [' + heard.join(',') + ']');
}

console.log('\nA park answered with no log\n');
{
	const { heard } = await run([
		{ ok: true, waited: true, version: 0, changed: false, progress: false, lease: true },
	]);
	check('L3. the listeners hear nothing', heard.length === 0, 'heard: [' + heard.join(',') + ']');
}

console.log('\nA park answered with a snapshot tap among the heads\n');
{
	const { heard } = await run([
		{ ok: true, waited: true, version: 0, changed: false, progress: false, lease: false,
			log: ['schat-1:5', 'cchat-1:6'] },
	]);
	check('L4. the s tap is not heard, the c tap is',
		heard.join() === 'chat-1:6', 'heard: [' + heard.join(',') + ']');
}

// LAG-1f: the gateway served `?above=N&log=1` as a read of chat "1"'s log (`?log=<chat>`),
// whose answer has no `waited`, and the page turned its channel off for the page's life on
// that one answer: B parked 0 times in the 256 s rig run, 31 Oct.
const parked = (log) => ({ ok: true, waited: true, version: 0, changed: false, progress: false,
	lease: false, log });
const logDoor = { ok: true, rows: [], head: 0, low: 0, more: false };	// the log read's answer

console.log('\nP1: a park answered with log taps parks again\n');
{
	const { tab, S } = await run([parked(['cC1:5']), parked(['cC1:6'])]);
	await fireTimeouts(tab);
	await fireTimeouts(tab);
	check('P1. the park loop asks again after a log answer', tab.parks.length >= 3,
		'parks: ' + tab.parks.length);
	check('P1. and the channel is still on the poll fallback', S.wake().mode === 'poll',
		JSON.stringify(S.wake()));
}

console.log('\nP2: one answer that did not park does not end parking for the page\'s life\n');
{
	const { tab, S } = await run([logDoor]);
	const after = tab.parks.length;
	check('P2. the answer without waited takes the channel off for now', S.wake().mode === 'off',
		JSON.stringify(S.wake()));
	await fireTimeouts(tab);
	check('P2. after the wait the channel is back on the poll fallback', S.wake().mode === 'poll',
		JSON.stringify(S.wake()));
	check('P2. and parks again', tab.parks.length > after, 'parks: ' + after + ' -> ' + tab.parks.length);
}

console.log('\nP3: an off asked for is not undone by that wait\n');
{
	const { tab, S } = await run([logDoor]);
	const after = tab.parks.length;
	S.wakeVia('off');
	await fireTimeouts(tab);
	check('P3. wakeVia(\'off\') stays off', S.wake().mode === 'off' && tab.parks.length === after,
		JSON.stringify(S.wake()) + ' parks: ' + after + ' -> ' + tab.parks.length);
}

console.log('\nCOLD: a tap for a closed chat\n');
{
	const src = liftFn(readPage(join(HERE, 'daimond.js'), 'utf8'), 'onLogTap');
	check('COLD the page listener exists', !!src);
	if (src) {
		const read = [];
		const cold = { id: 'C1', _loaded: false, messages: [] };	// on the rail, never opened here
		const open = { id: 'C2', _loaded: true, messages: [] };
		const S = {
			chats:        [open, cold],	// readPage joins the page whole: `pg.chats` reads `chats`
			current:      open,
			loadLogPlace: (c) => { if (c.logSeq == null) c.logSeq = 2; },
			logCursor:    (c) => c.logSeq || 0,
			readChatLog:  (c) => { read.push(c.id); return Promise.resolve(null); },
		};
		const tap = new Function('S', Object.keys(S).map((k) => 'var ' + k + ' = S.' + k + ';').join('\n')
			+ '\n' + src + '\nreturn onLogTap;')(S);
		tap('C1', 5);
		check('COLD a closed chat whose head passed its cursor is read', read.join() === 'C1', '[' + read.join(',') + ']');
		read.length = 0;
		tap('C1', 2);
		tap('C9', 7);
		check('COLD one at its cursor, or a chat not held, is not', read.length === 0, '[' + read.join(',') + ']');
	}
}

console.log(failures ? '\n' + failures + ' FAIL' : '\nALL PASS');
process.exit(failures ? 1 : 0);
