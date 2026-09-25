/* ============================================================
   Test — the progress tick (sync.js `progressTick`, audit F1).
   ------------------------------------------------------------
   A page deployed ahead of its gateway follows a handed-off turn's
   progress frames with no help from the gateway: the gateway of
   48aa5913 sends only parcel versions on the wake socket, never the
   `p<seq>` tap the watch was built to wait for. Before F1 such a page
   read a watched turn's door once, when the watch began, and then
   nothing until the answer merged -- the stream stopped at its first
   frame, on a socket that was open the whole time.

   Drives the REAL www/js/sync.js in a simulated tab (the pattern of
   synckey.test.mjs), with a fake WebSocket, a gateway stand-in that
   holds frames at the progress door, and timers the test fires by
   hand, and asserts:

     A. OPEN SOCKET, NO TAP: every tick reads the watched turn's door
        and delivers the frames stored since, so the stream moves.
     B. A TAP STANDS IT DOWN: once the gateway has tapped this channel
        (`p<seq>`), the tap carries the stream and a tick reads nothing.
     C. A SHUT CHANNEL: with the socket closed, the tick reads again.
     D. NOTHING WATCHED: the tick is gone and reads nothing.

   A and C fail on the sync.js before F1 (f3941d9a), where nothing ticks
   and the socket is trusted to tap, and B1 with them: the tap there
   reads the newest frame and the ones A never read are gone. Measured:
     SYNC_JS=<f3941d9a's sync.js> node www/js/progresstick.test.mjs  # 4 FAIL
     node www/js/progresstick.test.mjs                                 # ALL PASS

   Run:  node www/js/progresstick.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

const TURN = 'mu9turn-1-tick';

// ── One simulated tab ──
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
	win.location = { protocol: 'http:', host: 'tick.test' };
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
		frames: [],					// the progress door's frames for TURN: { seq, tail }
		reads: [],					// every progress GET: the `since` it asked with
		sockets: [],				// every WebSocket the page opened
		intervals: new Map(),		// id -> { fn, ms }: fired by hand, never by the clock
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
	const sealFrame = (f) => Buffer.from(JSON.stringify({ k: 'dprog1',
		v: { turn: TURN, seq: f.seq, tail: f.tail, final: false } })).toString('base64');
	const answer = (status, json) => ({ status, json: async () => {
		if (json === undefined) throw new Error('no body');
		return json;
	} });
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: tab.unlocked }),
		gwFetch: async (path) => {
			const q = new URL('http://x' + path).searchParams;
			// The wake probe: a gateway that parks, with nothing new.
			if (q.has('above')) return answer(200, { waited: true, changed: false, version: 0 });
			// The progress door, as 48aa5913's gateway answers a read with no `wait`: at
			// once, the newest frame past `since`, or 204.
			if (q.has('progress')) {
				const since = Number(q.get('since') || 0);
				tab.reads.push(since);
				const f = tab.frames.filter((x) => x.seq > since).pop();
				return f ? answer(200, { blob: sealFrame(f), seq: f.seq }) : answer(204);
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
		sha256: async (s) => {
			const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
			return Array.from(new Uint8Array(d)).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
		},
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
	// Timeouts never fire: nothing here waits on one, and the page's own retries and
	// backoffs must not run on their own mid-assertion. Intervals are kept, and the
	// test fires the progress tick itself.
	let nextId = 1;
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		() => nextId++, () => {},
		(f, ms) => { const id = nextId++; tab.intervals.set(id, { fn: f, ms }); return id; },
		(id) => { tab.intervals.delete(id); },
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return tab;
}

/// Let every promise the page has in flight settle.
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

/// Fire the progress tick, where the page has one.
function tick(tab) {
	let fired = 0;
	for (const it of tab.intervals.values()) {
		if (it.fn && it.fn.name === 'progressTick') { it.fn(); fired++; }
	}
	return fired;
}

const tab = makeTab();
tab.unlocked = true;
const S = tab.win.DaimondSync;
S.wakeVia('');
await settle();
const sock = tab.sockets[tab.sockets.length - 1];
check('the page probed, then opened a wake socket', !!sock, tab.sockets.length + ' socket(s)');
if (sock) { sock.readyState = 1; if (sock.onopen) sock.onopen({}); }
await settle();
check('and the channel reads as open, on the socket', S.wake().open === true && S.wake().mode === 'ws',
	JSON.stringify({ open: S.wake().open, mode: S.wake().mode }));

console.log('\nA. an open socket from a gateway that never taps\n');
const got = [];
tab.frames.push({ seq: 1, tail: 'first words' });
S.watchProgress(TURN, (f) => got.push(f.seq));
await settle();
check('A1. a new watch reads the door once, and delivers the first frame', got.join() === '1',
	'frames delivered: [' + got.join(',') + '], reads: ' + tab.reads.length);
const r0 = tab.reads.length;
for (let s = 2; s <= 4; s++) {
	tab.frames.push({ seq: s, tail: 'more words ' + s });
	tick(tab);
	await settle();
}
check('A2. each tick reads the door again, with no tap from the gateway',
	tab.reads.length - r0 === 3, (tab.reads.length - r0) + ' read(s) over three ticks');
check('A3. and the stream moves: every frame stored since is delivered, in order',
	got.join() === '1,2,3,4', 'frames delivered: [' + got.join(',') + ']');

console.log('\nB. the gateway taps this channel\n');
tab.frames.push({ seq: 5, tail: 'tapped' });
if (sock && sock.onmessage) sock.onmessage({ data: 'p5' });
await settle();
check('B1. the tap reads the door at once', got.join() === '1,2,3,4,5', 'frames delivered: [' + got.join(',') + ']');
const r1 = tab.reads.length;
tick(tab); tick(tab);
await settle();
check('B2. and from then on a tick reads nothing: the tap carries the stream',
	tab.reads.length === r1, (tab.reads.length - r1) + ' read(s) over two ticks');

console.log('\nC. the channel shuts\n');
if (sock) sock.close();
await settle();
tab.frames.push({ seq: 6, tail: 'after the socket went' });
const r2 = tab.reads.length;
tick(tab);
await settle();
check('C1. with no channel the tick reads again, and the frame arrives',
	tab.reads.length - r2 === 1 && got[got.length - 1] === 6,
	(tab.reads.length - r2) + ' read(s), frames delivered: [' + got.join(',') + ']');

console.log('\nD. nothing watched\n');
S.unwatchProgress(TURN);
const r3 = tab.reads.length;
const fired = tick(tab);
await settle();
check('D1. the tick is gone with the last watch, and nothing reads the door',
	fired === 0 && tab.reads.length === r3, fired + ' tick(s) left, ' + (tab.reads.length - r3) + ' read(s)');

// E. A WATCH ENDS WITH ONE LAST READ (2026-09-25). The runner stores its final frame
// before its report and its lease release, and either of those ends the watch, so on
// a gateway that does not tap the frame is on the door and unread when the watch ends.
// Fails on 82a0e52f's sync.js, whose unwatch takes no last read: E1 and E2.
console.log('\nE. the watch ends between a frame and the tick that would read it\n');
const got2 = [];
tab.frames.push({ seq: 7, tail: 'the watched turn again' });
S.watchProgress(TURN, (f) => got2.push(f.seq));
await settle();
tab.frames.push({ seq: 8, tail: 'the finished answer' });		// stored; no tick has run
const last = [];
S.unwatchProgress(TURN, (f) => last.push(f.seq));
await settle();
check('E1. the unwatch reads the door once more, from the last frame seen',
	tab.reads[tab.reads.length - 1] === 7, 'last read since=' + tab.reads[tab.reads.length - 1]);
check('E2. and hands the frame stored after it to the last-read callback, not the watcher',
	last.join() === '8' && got2.join() === '7', 'last: [' + last.join(',') + '], watcher: [' + got2.join(',') + ']');
const r4 = tab.reads.length;
S.watchProgress(TURN, () => {});
await settle();
S.unwatchProgress(TURN);
await settle();
check('E3. an unwatch with no callback reads nothing more', tab.reads.length - r4 === 1,
	(tab.reads.length - r4) + ' read(s): the new watch\'s own, and none at the unwatch');

console.log(failures ? '\n' + failures + ' FAILURE(S)' : '\nALL PASS');
process.exit(failures ? 1 : 0);
