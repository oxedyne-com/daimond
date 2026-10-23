/* ============================================================
   Test — every device reads promptly after a gateway outage
   (www/js/sync.js `armUnsent`, `wakeWait`; SYNC-READ-TIME, 2026-10-23).
   ------------------------------------------------------------
   The defect: two retry ladders stopped reading at the outage's
   own pace well before a deploy's outage could be over.

   - Owed work waiting on a read (`armUnsent('read')`) was read at
     most UNSENT_READ_MAX_MS apart for its first EIGHT TRIES, a
     count, which is 13.5-40.5 s of an outage depending on the dice.
     Past it the next wait was the wire's ladder, 2^8 s x (0.5..1.5)
     = 128-384 s, so after a 30 s outage 85% of devices with owed
     work waited minutes for their next read.
   - The wake channel's reconnect (`wakeRetry`, and the park loop's
     own sleeps) doubled to 30 s from the first failure, so a device
     on parked requests -- where the catch-up stands down, because a
     park loop is the channel carrying -- went up to 45 s after the
     gateway was back before it asked again, owed work or none.

   The fix: both ladders hold the read cadence for a TIME, the first
   OUTAGE_READ_MS (60 s) of failure, and only then climb. 60 s is
   five times the longest deploy outage measured (SIGTERM to
   "listening", 79 restarts in Sep-Oct 2026: 2-11 s), and inside it
   every wait is at most READ_MAX_MS (4 s) x 1.5 = 6 s, so every
   device reads within B = 6 s of the gateway coming back.

   Drives the REAL www/js/sync.js in a simulated tab: the wake
   channel's socket or park, the catch-up's interval, the owed retry,
   all on one virtual clock, against a gateway that goes away (Steel
   answers 502, and every socket and park is cut) and comes back.

     T. owed work, socket channel, 30 s outage at pins 0, 0.5, 0.9999
     U. owed work, parked channel, 30 s outage at the same pins
     V. no owed work, parked channel, 30 s outage at the same pins
     X. no owed work, socket channel, 30 s outage at pin 0
     Y. W = 60 s outage at pin 0, owed and not, on both channels
     Z. an hour-long outage: the owed retry's GETs stay bounded
     P. SYNCREAD-R2 MED-2: past the window. Owed work, parked channel, 70 s
        and 90 s outages: lands within L(T) = 3 x (T - 60 s) + 12 s (42 s,
        102 s); idle, parked, 70 s: reads within C(T) = 3 x (T - 60 s) + 6 s
     Q. SYNCREAD-R2 LOW-3: 30 s down, 8 s of reads landing and POSTs
        answering 502, 30 s down: lands within B = 6 s, both channels
     K. SYNCREAD-R2 LOW-4: the wall clock stepped +-1 h 20 s into an outage
        moves neither window: owed and idle still read within B after a
        50 s outage, and a five-minute outage costs the GETs it costs unstepped

   A device with nothing owed has read once its next request reaches
   the gateway: an answered pull, or a park TAKEN, which the gateway
   answers at once had the mailbox moved. Owed work has read only
   when a GET is answered and the answer lands.

   Red on the SUHT record 4c94152fd, 10 checks: T and Y's owed answer
   never lands in the minute after (socket channel: the catch-up
   reads, but the retry sits on its 128-384 s rung), U pins 0 and 0.5
   and Y owed parked (45 s to the first read), and V pin 0.9999
   (16.5 s). Green on the record, by the dice or the catch-up: T and
   U pin 0.9999, V pins 0 and 0.5, X, Y idle, and Z, a cost ceiling
   rather than a regression (head 322 GETs/h at pin 0, 162 at 0.5;
   the record 275 and 143). All green on head:
     SYNC_JS=<4c94152fd's sync.js> node www/js/syncread.test.mjs
     node www/js/syncread.test.mjs                     # ALL PASS

   SYNCREAD-R2 (rc review of SYNC-READ-TIME, 2026-10-23). Past the window
   the one shared try count leapt to the wire's ceiling: 141-444 s after a
   70 s outage. Each ladder now counts its own tries. Red on the record
   0bc3afb93, 13 checks: P owed at every pin (141.5-444.5 s), P idle pin
   0.9999 (39.5 s), Q at every pin on both channels (113.5-263 s). Each
   fix put back alone turns its arms red again:
     node www/js/syncread.test.mjs --break shared     # one try count: P, Q
     node www/js/syncread.test.mjs --break landed     # a landed read keeps the window: Q
     node www/js/syncread.test.mjs --break wakeclimb  # the channel resumes at 30 s: P idle
   LOW-4 (the windows on performance.now): red on fc467b831, 5 checks:
   K +1 h owed (lands 30 s after the return) and all four K costs (owed
   153 / 31 GETs against 48, idle 76 / 18 against 26); on the record the
   same 5 (none in 60 s; 152 / 24 against 41, 76 / 16 against 24).
     node www/js/syncread.test.mjs --break wall       # the windows on Date.now: K
   LOW-6 (a landed read resets the read ladders' counts): red on d01169adf,
   6 checks, R owed: T = 61 s parked and socket pin 0 (64 s against 15 s),
   T = 70 s parked at every pin and socket pin 0.9999 (55-120 s against 42 s). R idle pins the live 61 s miss (srt-measure c62d09887366):
   61.6 s pin 0 and 63.1 s pin 0.5 red on the record 0bc3afb93 (14.9 s, 29.9 s)
   and under --break wakeclimb; green from 6360ead10.
     node www/js/syncread.test.mjs --break readcount  # a landed read keeps the counts: R

   Run:  node www/js/syncread.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
// --break <name>: put one SYNCREAD-R2 fix back, to show the arm that holds it goes red.
const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : null; })();
const BREAKS = {
	shared:    ['var n    = ladderTries[ladder] | 0;', 'var n    = unsentTries;'],
	landed:    ['readSince = 0;					// the outage is over', '					// the outage is over'],
	wakeclimb: ['wakeBackoff = Math.min(cap, wakeBackoff * 2);', 'wakeBackoff = Math.min(WAKE_RETRY_MAX_MS, wakeBackoff * 2);'],
	wall:      ["var p = window.performance;", "var p = null;"],
	readcount: ['ladderTries.read = ladderTries.readpast = 0;', ''],
};
function broken(src) {
	if (!BREAK) return src;
	const b = BREAKS[BREAK];
	if (!b) { console.log('no such break: ' + BREAK); process.exit(2); }
	for (let i = 0; i < b.length; i += 2) {
		if (!src.includes(b[i])) { console.log('the break text moved: ' + BREAK); process.exit(2); }
		src = src.replace(b[i], b[i + 1]);
	}
	return src;
}
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

const SELF  = '00112233445566aa';
const BASE  = Date.UTC(2026, 9, 23, 12, 0, 0);
const B_MS  = 6000;		// the bound: READ_MAX_MS (4 s) x the jitter's top (1.5)
const W_MS  = 60000;	// the outage the bound holds for: OUTAGE_READ_MS
const drain = () => new Promise((r) => setImmediate(r));
const sealed = (o) => 'sealed:' + JSON.stringify(o);

/// A tab running the whole of sync.js on a virtual clock: timers, intervals, the wake
/// channel's socket or park, and a gateway the test takes away and brings back.
function makeTab({ sockets }) {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { location: { protocol: 'https:', host: 'daimond.test' } };
	const listeners = {};
	win.addEventListener = (type, f) => { (listeners[type] = listeners[type] || []).push(f); };
	win.dispatchEvent = () => true;
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		dataset: {},
	};
	const document = {
		readyState: 'complete', hidden: false, addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};

	const tab = {
		win,
		unlocked: false,			// false while sync.js loads, so start() reaches nothing
		parcel: { v: 3, chats: [], note: 'boot' },
		down: false,				// the gateway is away: Steel answers 502, sockets and parks are cut
		withhold: false,			// the content pull alone fails (the gateway is up)
		postsDown: false,			// the parcel POST alone answers 502: reads land, writes do not (LOW-3)
		skew: 0,					// a wall-clock step: Date moves by it, the page's monotonic clock does not
		posts: [],					// every parcel POST: { base, ok }
		reads: [],					// the virtual time of every /api/sync GET the gateway ANSWERED
		heard: [],					// ...and of every park it TOOK: it compares the version on arrival
		gets: 0,					// every /api/sync GET asked, answered or not
		mailbox: { version: 4, blob: sealed({ v: 3, chats: [], note: 'phone v4' }) },
		socks: new Set(),
		parks: new Set(),
		fire: (type) => (listeners[type] || []).forEach((f) => f({ type })),
		vnow: 0,
		timers: [],
	};
	const at = (ms, f) => { const id = nextId++; tab.timers.push({ id, f, due: tab.vnow + Math.max(0, ms | 0) }); return id; };
	let nextId = 1;

	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked,
		wrap: async (plain) => 'sealed:' + plain,
		unwrap: async (blob) => String(blob).slice('sealed:'.length),
		handle: () => '',
		deviceId: () => SELF,
	};
	const answer = (status, json) => ({ status, headers: { get: () => null }, json: async () => json });
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: tab.unlocked }),
		gwFetch: (path, opts) => {
			const u = new URL('http://x' + path);
			const q = u.searchParams;
			const get = !opts || !opts.method || opts.method === 'GET';
			if (u.pathname !== '/api/sync') return Promise.resolve(answer(200, {}));
			if (q.has('presence') || q.has('lease') || q.has('progress')) return Promise.resolve(answer(200, { ok: true }));
			if (get) tab.gets++;
			if (tab.down) return Promise.resolve(answer(502, null));
			if (get && q.has('above')) {
				// A park: answered at once with news, else held for its window or until cut.
				const above = Number(q.get('above')) | 0;
				// A park taken is a read of the version: news since `above` answers it at once.
				tab.heard.push(tab.vnow);
				if (tab.mailbox.version > above) {
					tab.reads.push(tab.vnow);
					return Promise.resolve(answer(200, { waited: true, changed: true, version: tab.mailbox.version }));
				}
				return new Promise((res, rej) => {
					const p = {
						cut: () => { tab.parks.delete(p); clearT(p.t); rej(new TypeError('connection reset')); },
						t: at(Number(q.get('ms')) || 45000, () => {
							tab.parks.delete(p);
							tab.reads.push(tab.vnow);
							res(answer(200, { waited: true, changed: false, version: tab.mailbox.version }));
						}),
					};
					tab.parks.add(p);
					if (opts && opts.signal) opts.signal.addEventListener('abort', () => p.cut());
				});
			}
			if (get) {
				if (tab.withhold) return Promise.resolve(answer(502, null));
				tab.reads.push(tab.vnow);
				return Promise.resolve(answer(200, { present: true, version: tab.mailbox.version,
					blob: tab.mailbox.blob, device: 'Phone' }));
			}
			const body = JSON.parse(opts.body);
			if (tab.postsDown) { tab.posts.push({ base: body.base_version | 0, ok: false, status: 502 }); return Promise.resolve(answer(502, null)); }
			if ((body.base_version | 0) !== tab.mailbox.version) {
				tab.posts.push({ base: body.base_version | 0, ok: false });
				return Promise.resolve(answer(409, { ok: false, version: tab.mailbox.version }));
			}
			tab.posts.push({ base: body.base_version | 0, ok: true });
			tab.mailbox = { version: tab.mailbox.version + 1, blob: body.blob };
			return Promise.resolve(answer(200, { ok: true, version: tab.mailbox.version }));
		},
	};
	const clearT = (id) => { tab.timers = tab.timers.filter((t) => t.id !== id); };
	// No socket through this door: `new WebSocket` throws, and the channel parks requests.
	win.WebSocket = undefined;
	if (sockets) {
		win.WebSocket = class {
			constructor() {
				this.readyState = 0;
				const down = tab.down;
				at(0, () => {
					if (down || tab.down) { this.readyState = 3; this.onclose && this.onclose(); return; }
					this.readyState = 1;
					tab.socks.add(this);
					this.onopen && this.onopen();
				});
			}
			close() {
				if (this.readyState === 3) return;
				this.readyState = 3;
				tab.socks.delete(this);
				at(0, () => this.onclose && this.onclose());
			}
		};
	}
	win.DaimondCore = {
		collectSync: async () => JSON.parse(JSON.stringify(tab.parcel)),
		syncSelfDeviceId: () => SELF,
		busy: () => false,
		deviceSelfName: () => 'Chromium on Linux',
		syncMayCommitChunks: () => false,
		syncCommitBlockedReason: () => '',
		applySync: async () => ({}),
	};
	// On the event loop, so the settle below sees all of the page's work (diag §Root fixes 2).
	win.DaimondCloud = { sha256: async (s) => createHash('sha256').update(s).digest('hex') };

	class VDate extends Date {
		constructor(...a) { if (a.length) super(...a); else super(BASE + tab.vnow + tab.skew); }
		static now() { return BASE + tab.vnow + tab.skew; }
	}
	// The page's monotonic clock: the virtual time, which no wall-clock step moves.
	win.performance = { now: () => tab.vnow };

	const body = broken(readFileSync(process.env.SYNC_JS || join(HERE, 'sync.js'), 'utf8'));
	const fn = new Function(
		'window', 'document', 'crypto', 'localStorage',
		'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'console', 'Date',
		'with (window) {\n' + body + '\n}');
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		(f, ms) => at(ms, f),
		clearT,
		(f, ms) => { const id = nextId++; tab.timers.push({ id, f, due: tab.vnow + ms, every: ms }); return id; },
		clearT,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, VDate);
	return tab;
}

/// Let what the page has in flight settle. Every await it makes is on the event loop.
async function quiet() { for (let i = 0; i < 60; i++) await drain(); }

/// Run the page's timers and intervals on the virtual clock for `ms`, earliest first.
async function advance(tab, ms) {
	const end = tab.vnow + ms;
	for (;;) {
		await quiet();
		let due = null;
		for (const t of tab.timers) if (t.due <= end && (!due || t.due < due.due)) due = t;
		if (!due) break;
		if (due.every) due.due += due.every;
		else tab.timers = tab.timers.filter((t) => t !== due);
		tab.vnow = Math.max(tab.vnow, due.due - (due.every || 0));
		due.f();
	}
	tab.vnow = end;
	await quiet();
}

function pinJitter(tab, r) {
	tab.win.Math = Object.create(Math, { random: { value: () => r } });
}

/// The gateway goes: Steel answers 502, every socket and park is cut.
function gatewayDown(tab) {
	tab.down = true;
	for (const s of [...tab.socks]) { s.readyState = 3; tab.socks.delete(s); s.onclose && s.onclose(); }
	for (const p of [...tab.parks]) p.cut();
}

const landed = (tab) => tab.posts.filter((p) => p.ok).length;
const holds = (tab, note) => {
	try { return JSON.parse(tab.mailbox.blob.slice('sealed:'.length)).note === note; } catch (e) { return false; }
};

/// A device signed in, its channel up, and idle long enough that the catch-up is due.
async function settled(sockets, pin) {
	const tab = makeTab({ sockets });
	pinJitter(tab, pin);
	tab.unlocked = true;
	tab.fire('daimond:authed');
	await advance(tab, 60000);
	return { tab, S: tab.win.DaimondSync };
}

/// The same device as the gateway goes: the runner's answer is pushed into the outage, so
/// it is owed, and the mailbox holds no news the channel could wake it with.
async function owing(sockets, pin) {
	const { tab, S } = await settled(sockets, pin);
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	gatewayDown(tab);
	await S.push();
	await quiet();
	return { tab, S };
}

/// Take the gateway away for `outMs`, bring it back, and measure from its return.
async function outage(tab, outMs) {
	gatewayDown(tab);
	await advance(tab, outMs);
	tab.down = false;
	const back = tab.vnow, r0 = tab.reads.length, h0 = tab.heard.length, g0 = tab.gets;
	await advance(tab, 60000);
	// A device with nothing owed has read once its next request reaches the gateway: an
	// answered pull, or a park taken, which would answer at once had the mailbox moved.
	const first = [...tab.reads.slice(r0), ...tab.heard.slice(h0)].filter((t) => t >= back)
		.sort((a, b) => a - b)[0];
	return { firstRead: first === undefined ? Infinity : first - back, getsAfter: tab.gets - g0 };
}

const PINS = [0, 0.5, 0.9999];
const s = (ms) => (ms === Infinity ? 'none in 60 s' : (ms / 1000) + ' s');

async function owedCase(tag, sockets, outMs, pin) {
	const { tab, S } = await owing(sockets, pin);
	const p0 = tab.posts.length, l0 = landed(tab);
	check(tag + ' setup: the answer is owed', S.state().stalled && !holds(tab, 'runner answer'),
		JSON.stringify({ stalled: S.state().stalled, why: S.state().stalledWhy, posts: tab.posts }));
	await advance(tab, outMs);
	tab.down = false;
	const back = tab.vnow, r0 = tab.reads.length;
	await advance(tab, 60000);
	const first = tab.reads.slice(r0).find((t) => t >= back);
	const lp = tab.posts.slice(p0).findIndex((p) => p.ok);
	check(tag + ' reads within B = 6 s of the gateway\'s return', first !== undefined && first - back <= B_MS,
		'first read ' + s(first === undefined ? Infinity : first - back));
	check(tag + ' and the owed answer lands, once', holds(tab, 'runner answer') && landed(tab) === l0 + 1 && lp >= 0,
		JSON.stringify(tab.posts.slice(p0)));
}

async function idleCase(tag, sockets, outMs, pin) {
	const { tab } = await settled(sockets, pin);
	const r = await outage(tab, outMs);
	check(tag + ' reads within B = 6 s of the gateway\'s return', r.firstRead <= B_MS, 'first read ' + s(r.firstRead));
}

console.log('\nT. owed work, socket channel, 30 s outage\n');
for (const pin of PINS) await owedCase('T pin ' + pin + '.', true, 30000, pin);

console.log('\nU. owed work, parked channel (no socket through the door), 30 s outage\n');
for (const pin of PINS) await owedCase('U pin ' + pin + '.', false, 30000, pin);

console.log('\nV. no owed work, parked channel, 30 s outage\n');
for (const pin of PINS) await idleCase('V pin ' + pin + '.', false, 30000, pin);

console.log('\nX. no owed work, socket channel, 30 s outage\n');
await idleCase('X pin 0.', true, 30000, 0);

console.log('\nY. an outage of W = 60 s, at pin 0\n');
await owedCase('Y owed socket.', true, W_MS, 0);
await owedCase('Y owed parked.', false, W_MS, 0);
await idleCase('Y idle parked.', false, W_MS, 0);
await idleCase('Y idle socket.', true, W_MS, 0);

console.log('\nZ. an hour-long outage: the cost stays bounded\n');
for (const pin of [0, 0.5]) {
	// The owed retry's own GETs: the channel and the catch-up are the parked channel's,
	// whose park loop counts separately below.
	const { tab } = await owing(false, pin);
	const g0 = tab.gets, l0 = landed(tab);
	await advance(tab, 3600000);
	const n = tab.gets - g0;
	// Stated cost (sync.js 'READ'): at most OUTAGE_READ_MS / (READ_MAX_MS x 0.5) reads in the
	// window, then the climb to the ceiling (SYNCREAD-R2: owed work's 8, 16, 32, 64, 128 s,
	// five rungs; the channel's 4, 8, 16 s, three) and the ceiling at its shortest for the rest
	// of the hour (300 s and 30 s x 0.5), per ladder; the parked channel's own loop is the
	// second ladder.
	const owedMax = Math.ceil(W_MS / 2000) + 2 + 5 + Math.ceil(3600000 / 150000);
	const wakeMax = Math.ceil(W_MS / 2000) + 2 + 3 + Math.ceil(3600000 / 15000);
	check('Z pin ' + pin + '. an hour of outage costs at most ' + (owedMax + wakeMax) + ' GETs (owed ' + owedMax
		+ ' + channel ' + wakeMax + ')', n <= owedMax + wakeMax, n + ' GETs in 60 min');
	tab.down = false;
	const back = tab.vnow, r0 = tab.reads.length;
	await advance(tab, 460000);
	check('Z pin ' + pin + '. and once it ends the owed answer still lands, once', holds(tab, 'runner answer')
		&& landed(tab) === l0 + 1, 'first read ' + s((tab.reads.slice(r0)[0] ?? Infinity) - back));
}

// ── SYNCREAD-R2 (rc review of SYNC-READ-TIME, 2026-10-23: MED-2, LOW-3, LOW-4) ──
// Past the window each ladder climbs on its own count from UNSENT_READ_MAX_MS: 8, 16, 32 s
// ... x the jitter (0.5..1.5) to the wire's 300 s ceiling. The k-th wait past the window
// begins no earlier than 4 x (2^k - 1) s into it and is at most 12 x 2^k s long, so the
// read that is waiting when the gateway returns, T - W into the climb, comes within
//   L(T) = 3 x (T - W) + 12 s   (at most the ceiling's 450 s), whatever the dice:
// 42 s after a 70 s outage, 102 s after a 90 s one. On the record it was the wire ladder's
// rung after fifteen shared tries, 150-450 s.
const L_MS = (outMs) => (outMs <= W_MS ? B_MS : Math.min(450000, 3 * (outMs - W_MS) + 12000));

/// How long after the gateway's return `back` the owed answer landed, from the landings
/// `watchLand` noted.
function landTime(tab, back) {
	const t = tab.landedAt.find((x) => x >= back);
	return t === undefined ? Infinity : t - back;
}
function watchLand(tab) {
	tab.landedAt = [];
	const push = tab.posts.push.bind(tab.posts);
	tab.posts.push = (p) => { if (p.ok) tab.landedAt.push(tab.vnow); return push(p); };
}

console.log('\nP. MED-2: owed work, parked channel, an outage past the window, at pins 0, 0.5, 0.9999\n');
for (const outMs of [70000, 90000]) {
	for (const pin of PINS) {
		const { tab } = await owing(false, pin);
		watchLand(tab);
		await advance(tab, outMs);
		tab.down = false;
		const back = tab.vnow;
		await advance(tab, 500000);
		const t = landTime(tab, back);
		check('P ' + (outMs / 1000) + ' s pin ' + pin + '. the owed answer lands within L = ' + (L_MS(outMs) / 1000)
			+ ' s of the return', t <= L_MS(outMs) && tab.landedAt.length === 1, 'landed ' + s(t)
			+ ', ' + tab.landedAt.length + ' landing(s)');
	}
}

// The channel's own climb past the window, 4, 8, 16 s to its 30 s ceiling: the k-th wait
// starts no earlier than 2 x (2^k - 1) s into it and lasts at most 6 x 2^k s, so
//   C(T) = 3 x (T - W) + 6 s, at most 45 s.
const C_MS = (outMs) => (outMs <= W_MS ? B_MS : Math.min(45000, 3 * (outMs - W_MS) + 6000));
console.log('\nP. MED-2: no owed work, parked channel, a 70 s outage\n');
for (const pin of PINS) {
	const { tab } = await settled(false, pin);
	const r = await outage(tab, 70000);
	check('P idle 70 s pin ' + pin + '. the channel reads within C = ' + (C_MS(70000) / 1000) + ' s of the return',
		r.firstRead <= C_MS(70000), 'first read ' + s(r.firstRead));
}

console.log('\nQ. LOW-3: 30 s down, 8 s of reads landing and POSTs answering 502, 30 s down again\n');
for (const sockets of [false, true]) {
	for (const pin of PINS) {
		const { tab } = await owing(sockets, pin);
		watchLand(tab);
		await advance(tab, 30000);
		tab.down = false; tab.postsDown = true;
		await advance(tab, 8000);
		gatewayDown(tab); tab.postsDown = false;
		await advance(tab, 30000);
		tab.down = false;
		const back = tab.vnow;
		await advance(tab, 500000);
		const t = landTime(tab, back);
		check('Q ' + (sockets ? 'socket' : 'parked') + ' pin ' + pin + '. the owed answer lands within L = '
			+ (L_MS(30000) / 1000) + ' s of the second return', t <= L_MS(30000) && tab.landedAt.length === 1,
			'landed ' + s(t) + ', ' + tab.landedAt.length + ' landing(s)');
	}
}

// LOW-6 (rc review of SYNCREAD-R2): a landed read proves the gateway answered, so the next
// failed read is a new outage and climbs from the bottom. Its counts were kept until paid(),
// so a second long outage after an unpaid push resumed at the first outage's rung: up to the
// ceiling's 450 s. A 120 s outage climbs readpast; a read lands and its POST answers 502;
// then a second outage of T > 60 s, and the owed answer lands within L(T) of its return.
console.log('\nR. LOW-6: 120 s down, up until a read lands and its POST answers 502, then T s down again\n');
for (const outMs of [61000, 70000, 120000]) {
	for (const sockets of [false, true]) {
		for (const pin of PINS) {
			const { tab } = await owing(sockets, pin);
			watchLand(tab);
			await advance(tab, 120000);
			tab.down = false; tab.postsDown = true;
			// Up until the owed retry's read lands and its POST answers 502: the first
			// outage's own climb may hold that read up to L(120 s) after the return.
			const r0 = tab.reads.length, p0 = tab.posts.length;
			for (let i = 0; i < 400 && !(tab.reads.length > r0 && tab.posts.slice(p0).some((p) => !p.ok)); i++) await advance(tab, 500);
			check('R ' + (outMs / 1000) + ' s ' + (sockets ? 'socket' : 'parked') + ' pin ' + pin + ' setup: a read landed, the POST failed',
				tab.reads.length > r0 && tab.posts.slice(p0).some((p) => !p.ok) && !holds(tab, 'runner answer'), JSON.stringify(tab.posts.slice(p0)));
			gatewayDown(tab); tab.postsDown = false;
			await advance(tab, outMs);
			tab.down = false;
			const back = tab.vnow;
			await advance(tab, 500000);
			const t = landTime(tab, back);
			check('R ' + (outMs / 1000) + ' s ' + (sockets ? 'socket' : 'parked') + ' pin ' + pin
				+ '. the owed answer lands within L = ' + (L_MS(outMs) / 1000) + ' s of the second return',
				t <= L_MS(outMs) && tab.landedAt.length === 1, 'landed ' + s(t) + ', ' + tab.landedAt.length + ' landing(s)');
		}
	}
}

// The live rig's miss (srt-measure c62d09887366): parked channel, nothing owed, a 60.6-61 s
// outage, read 31-37 s after the return on 0bc3afb93. Here the channel's retries fall on the
// dice's own phase, so the outages just past 61 s that the record misses are pinned beside
// 61 s itself: 61.6 s at pin 0 (14.9 s on the record) and 63.1 s at pin 0.5 (29.9 s).
console.log('\nR. the live case: no owed work, parked channel, a 61-63 s outage\n');
for (const outMs of [61000, 61600, 63100]) {
	for (const pin of PINS) {
		const { tab } = await settled(false, pin);
		const r = await outage(tab, outMs);
		check('R idle ' + (outMs / 1000) + ' s pin ' + pin + '. the channel reads within C = ' + (C_MS(outMs) / 1000)
			+ ' s of the return', r.firstRead <= C_MS(outMs), 'first read ' + s(r.firstRead));
	}
}

console.log('\nK. LOW-4: a wall-clock step of 1 h inside the window moves neither window\n');
for (const step of [3600000, -3600000]) {
	// Owed work, parked channel, a 50 s outage, the wall clock stepped 20 s into it.
	const { tab } = await owing(false, 0.5);
	watchLand(tab);
	await advance(tab, 20000);
	tab.skew += step;
	await advance(tab, 30000);
	tab.down = false;
	const back = tab.vnow;
	await advance(tab, 60000);
	const t = landTime(tab, back);
	check('K ' + (step > 0 ? '+' : '-') + '1 h owed. the owed answer still lands within B = 6 s', t <= B_MS, 'landed ' + s(t));
	// No owed work, parked channel: the wake window alone.
	const { tab: t2 } = await settled(false, 0.5);
	gatewayDown(t2);
	await advance(t2, 20000);
	t2.skew += step;
	const r = await outage(t2, 30000);
	check('K ' + (step > 0 ? '+' : '-') + '1 h idle. the channel still reads within B = 6 s', r.firstRead <= B_MS, 'first read ' + s(r.firstRead));
}
for (const owed of [true, false]) {
	for (const step of [-3600000, 3600000]) {
		// A five-minute outage with the wall clock stepped 20 s into it costs what one without
		// does: each window still ends 60 s after its first failure. Owed work counts both
		// ladders' GETs; with nothing owed, the channel's alone.
		const run = async (st) => {
			const { tab } = owed ? await owing(false, 0.5) : await settled(false, 0.5);
			if (!owed) gatewayDown(tab);
			const g0 = tab.gets;
			await advance(tab, 20000);
			tab.skew += st;
			await advance(tab, 280000);
			return tab.gets - g0;
		};
		const base = await run(0), moved = await run(step);
		check('K ' + (step > 0 ? '+' : '-') + '1 h cost, ' + (owed ? 'owed' : 'idle') + '. a five-minute outage costs the same GETs as without the step',
			moved === base, moved + ' GETs against ' + base);
	}
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
