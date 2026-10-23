/* ============================================================
   Test -- the client reads the derived presence truth and states its
   posture on change (HT2 part a; design daimond_handoff_truth_design_20261023
   §2.2, §2.4, §9 Device; wire contract wire_ht1.md).
   ------------------------------------------------------------
   The REAL sync.js and peer.js in one simulated tab, against a stand-in for
   the HT1 gateway (presence door with `derived`, `ver`, `mine`; socket frame
   `r<ver>`; park answer `pres`), on a clock the test moves. The tab's pulse
   is daimond.js's: each second, `postureDue(args)` and, when due,
   `beatPresence(args)`. Against a sync.js without `postureDue` the pulse
   beats as daimond.js did before HT2: every 45 s.

     P1  ingest keeps `listening`, `heard_at`, `doors`, `stated` per row and
         `derived`, `ver`, `mine` per answer; without `derived`, as before;
     V1  an `r<ver>` frame above the held version reads presence once;
     V2  one below or equal reads nothing;
     V3  a reconnect reads, whatever the version, naming `device` and `w`;
     M1  posture unchanged for 5 min under `derived: true`: no statement;
     M2  one field changed: one statement, carrying `w`;
     M3  a read whose `mine` is absent: a re-statement;
     L1  `pagehide`: one keepalive `{device_id, w, leaving: true}`;
     L2  and none to a gateway that does not derive;
     B1  an answer without `derived`: the 45 s beat resumes (old gateway);
     S1  a park answer's `pres` above the held version reads presence once,
         and the park asks with `&pres=<held>`.
     G1  a gateway restart: the channel drops and its re-read is not 200, so
         the map is unknown and the switch reads Here though the map last
         named the runner; a read that lands makes it known again;
     G2  a pull answered 200 opens the channel waiting out its backoff now
         [L1], and the presence it reads is the gateway's.
     T1  TABCLOSE: `pagehide` leaves every origin the page holds (its own and
         post.js's park, registered with `presenceOrigin`);
     T2  a page holding the runner flag leaves though the door looks shut,
         under the id it stated, and (T2b) when that statement went before the
         first derived answer; T3 one without it keeps the old gate.

   Red proof:  MM_SRC_REV=e638b372f node www/js/ht2presence.test.mjs
   Breaks:     node www/js/ht2presence.test.mjs --break <name>, names below.
   ============================================================ */
import { source } from './testlift.mjs';
import { webcrypto } from 'node:crypto';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : null; })();
// Each break undoes one part of HT2 in the source; the arms it names go red.
const BREAKS = {
	ingest:    ['p', "if (typeof rec.listening === 'boolean') recOut.listening = rec.listening;", ''],		// P1
	rframe:    ['s', "if (d.charAt(0) === 'r') { presenceHeard(parseInt(d.slice(1), 10)); return; }", ''],		// V1
	held:      ['s', 'if (presHeld != null && v <= presHeld) return;', ''],									// V2
	reconnect: ['s', '// A new connection: read presence whatever its version, and state in full.\n\t\t\tpresenceReconnect();', ''],	// V3
	onchange:  ['s', 'return postureFull || postureOwed || JSON.stringify(body) !== postureSent;', 'return true;'],	// M1
	notab:     ['s', 'body.w = WAKE_ID;', ''],																// M2
	selfcheck: ['s', "if (!mine || typeof mine !== 'object') { postureFull = true; return; }", "if (!mine || typeof mine !== 'object') return;"],	// M3
	keepalive: ['s', 'if (xtra.keepalive) opts.keepalive = true;', ''],									// L1
	oldgw:     ['s', 'presDerived = j.derived === true;', 'if (j.derived === true) presDerived = true;'],		// B1
	pres:      ['s', 'presenceHeard(Number(res.json.pres));', ''],											// S1
	oldleave:  ['s', 'if (!runnerHeld && (!presDerived || !canLeave())) return false;', 'if (!runnerHeld && !canLeave()) return false;'],					// L2
	lockleave: ['s', 'if (!runnerHeld && (!presDerived || !canLeave())) return false;', 'if (!runnerHeld && (!presDerived || !canBeat())) return false;'],
	pagegone:  ['s', "window.addEventListener('pagehide', function () { presenceGone(); });", "window.addEventListener('pagehide', function () { presenceLeaving(); });"],	// T1
	runnerleave: ['s', 'if (!runnerHeld && (!presDerived || !canLeave())) return false;', 'if (!presDerived || !canLeave()) return false;'],	// T2
	runnerfirst: ['s', '(postureDerived || presDerived)', 'postureDerived'],	// T2b
	runnerid:  ['s', "var id = selfDeviceId() || (runnerHeld ? String(postureLast.device_id || '') : '');", 'var id = selfDeviceId();'],	// T2	// L3
	chanback:  ['s', '	function presenceReconnect() {\n\t\tnoteChannelBack();', '	function presenceReconnect() {'],	// V3d
	unread:    ['s', "			else presenceUnread();\n", ''],												// G1
	unknown:   ['p', '		if (o.presenceUnknown) p = {};\n', ''],										// G1b
	pullback:  ['s', '		wakeGatewayBack();				// and the wake channel', '		// wakeGatewayBack();	// and the wake channel'],	// G2
};

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

let SYNC = source('sync.js');
let PEER = source('peer.js');
const STAMP = source('stamp.js');
if (BREAK) {
	const b = BREAKS[BREAK];
	if (!b) { console.log('no such break: ' + BREAK); process.exit(2); }
	const text = b[0] === 's' ? SYNC : PEER;
	if (!text.includes(b[1])) { console.log('the break text moved: ' + BREAK); process.exit(2); }
	if (b[0] === 's') SYNC = SYNC.replace(b[1], b[2]); else PEER = PEER.replace(b[1], b[2]);
}

const SELF = '00112233445566aa';
const PEER_ID = 'ffeeddccbbaa9988';
const BEAT_MS = 45000;
let NOW = 1761200000000;
class FakeDate extends Date {
	constructor(...a) { if (a.length) super(...a); else super(NOW); }
	static now() { return NOW; }
}

// ── One simulated tab against the HT1 stand-in ──
function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const winL = {}, docL = {};
	const on = (m) => (ev, fn) => { (m[ev] = m[ev] || []).push(fn); };
	const evs = [];
	const win = { addEventListener: on(winL), removeEventListener: () => {},
		dispatchEvent: (ev) => { evs.push(ev && ev.type); return true; } };
	win.location = { protocol: 'http:', host: 'ht2.test' };
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, dataset: {},
	};
	const document = {
		readyState: 'complete', hidden: false, visibilityState: 'visible',
		addEventListener: on(docL),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	const tab = {
		win, document, winL, docL, evs,
		unlocked: false,
		derived: true,			// the gateway derives (HT1); false = an older gateway
		ver: NOW,				// the account's presence version
		mine: 'echo',			// 'echo' = the last statement; or an object; or undefined
		stated: null,			// the last posture statement the gateway took
		gets: [], posts: [], parks: [], sockets: [],
	};
	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked,
		deviceId: () => SELF, handle: () => '',
		wrap: async (s) => s, unwrap: async (s) => s,
		wrapBytesAad: async (b) => b, unwrapBytesAad: async (b) => b,
	};
	const answer = (status, json) => ({ status, json: async () => json });
	const row = () => ({ name: 'argonaut', last_seen: NOW, attended: false, runner: true,
		listening: true, heard_at: NOW - 1500, doors: 2, stated: true });
	const presAnswer = () => {
		const j = { ok: true, now: NOW, presence: { [PEER_ID]: row() } };
		if (!tab.derived) {
			for (const k of ['listening', 'heard_at', 'doors', 'stated']) delete j.presence[PEER_ID][k];
			return j;
		}
		j.derived = true;
		j.ver = tab.ver;
		let mine = tab.mine;
		if (mine === 'echo') {
			mine = undefined;
			if (tab.stated) {
				mine = Object.assign({}, tab.stated, { stated: true });
				delete mine.device_id; delete mine.w;
			}
		}
		if (mine !== undefined) j.mine = mine;
		return j;
	};
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: tab.authed != null ? tab.authed : tab.unlocked }),
		gwFetch: async (path, opts) => {
			const q = new URL('http://x' + path).searchParams;
			const method = (opts && opts.method) || 'GET';
			if (tab.down) return answer(502, null);		// the gateway restarting
			if (q.has('presence')) {
				if (method === 'GET') { tab.gets.push(q); return answer(200, presAnswer()); }
				const body = JSON.parse(opts.body);
				tab.posts.push({ body, keepalive: !!opts.keepalive, at: NOW });
				if (!body.leaving) tab.stated = body;
				return answer(200, presAnswer());
			}
			if (q.has('above')) {
				// The probe (short) answers at once; a poll park waits for the test.
				if (q.get('ms') === '1000') return answer(200, { waited: true, changed: false, version: 0 });
				return new Promise((res, rej) => {
					const p = { q, res: (j) => res(answer(200, j)) };
					tab.parks.push(p);
					if (opts && opts.signal) opts.signal.addEventListener('abort', () => rej(new Error('aborted')));
				});
			}
			return answer(200, { present: false, version: 0 });
		},
	};
	win.DaimondCore = {
		collectSync: async () => ({ v: 3, chats: [] }),
		syncSelfDeviceId: () => SELF, busy: () => false,
		deviceSelfName: () => 'Chromium on Linux',
		syncMayCommitChunks: () => false, syncCommitBlockedReason: () => '',
		applySync: async () => ({}),
	};
	win.DaimondCloud = {
		sha256: async (s) => {
			const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
			return Array.from(new Uint8Array(d)).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
		},
	};
	win.WebSocket = class {
		constructor(url) { this.url = url; this.readyState = 0; tab.sockets.push(this); }
		close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({}); }
		send() {}
	};
	let nextId = 1;
	const quiet = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
	for (const body of [STAMP, PEER]) {
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent', 'Date',
			'with (window) {\n' + body + '\n}')(win, document, quiet, localStorage, { storage: {} },
			function () {}, FakeDate);
	}
	new Function('window', 'document', 'crypto', 'localStorage', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'Date',
		'with (window) {\n' + SYNC + '\n}')(win, document, webcrypto, localStorage, TextEncoder, TextDecoder,
		() => nextId++, () => {}, () => nextId++, () => {}, quiet, FakeDate);
	return tab;
}

const settle = async () => { for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r)); };
const fire = (m, ev) => (m[ev] || []).forEach((f) => f({ persisted: false }));

// The tab's posture, as daimond.js's `postureNow().args` gives it.
function posture(o) {
	o = o || {};
	return [SELF, 'argonaut-chrome', o.att !== undefined ? o.att : true, true, false, false,
		true, true, o.busy || 0, o.chats || []];
}

// daimond.js's one-second pulse: before HT2 (no `postureDue`), a beat every 45 s.
let lastOldBeat = -Infinity;
function pulse(tab, args) {
	const S = tab.win.DaimondSync;
	let due;
	if (S.postureDue) due = S.postureDue(...args);
	else { due = NOW - lastOldBeat >= BEAT_MS; if (due) lastOldBeat = NOW; }
	if (due) S.beatPresence(...args);
}
async function run(tab, secs, args) {
	for (let i = 0; i < secs; i++) { NOW += 1000; pulse(tab, args); await settle(); }
}
const statements = (tab, from) => tab.posts.slice(from).filter((p) => !p.body.leaving);

console.log('ht2presence: the derived truth, posture on change (real sync.js + peer.js'
	+ (BREAK ? ', --break ' + BREAK : '') + (process.env.MM_SRC_REV ? ', rev ' + process.env.MM_SRC_REV : '') + ')');

// ── A tab on the socket ──
const tab = makeTab();
tab.unlocked = true;
const S = tab.win.DaimondSync;
const P = tab.win.DaimondPresence;
S.wakeVia('');
await settle();
let sock = tab.sockets[tab.sockets.length - 1];
const g0 = tab.gets.length;
if (sock) { sock.readyState = 1; sock.onopen && sock.onopen({}); }
await settle();
check('V3a. a socket opening reads presence', tab.gets.length - g0 === 1, (tab.gets.length - g0) + ' read(s)');
const q0 = tab.gets[tab.gets.length - 1];
check('V3b. and the read names this device and this tab',
	!!q0 && q0.get('device') === SELF && !!q0.get('w') && q0.get('w') === (S.wake && S.wake().id),
	q0 ? 'device=' + q0.get('device') + ' w=' + q0.get('w') : 'no read');

console.log('\nP. ingest');
const rec = (P.snapshot() || {})[PEER_ID] || {};
check('P1a. a derived row keeps listening, heard_at (skew-adjusted), doors and stated',
	rec.listening === true && rec.heardAt === NOW - 1500 && rec.doors === 2 && rec.stated === true,
	JSON.stringify({ l: rec.listening, h: rec.heardAt && rec.heardAt - NOW, d: rec.doors, s: rec.stated }));
const meta = P.meta ? P.meta() : null;
check('P1b. and the answer\'s derived and ver are kept', !!meta && meta.derived === true && meta.ver === tab.ver,
	JSON.stringify(meta));

console.log('\nV. the presence version on the socket');
let g = tab.gets.length;
sock.onmessage({ data: 'r' + tab.ver });
sock.onmessage({ data: 'r' + (tab.ver - 7) });
await settle();
check('V2. r<ver> at or below the version held reads nothing', tab.gets.length === g, (tab.gets.length - g) + ' read(s)');
tab.ver += 5;
g = tab.gets.length;
sock.onmessage({ data: 'r' + tab.ver });
await settle();
check('V1. r<ver> above the version held reads presence once', tab.gets.length - g === 1, (tab.gets.length - g) + ' read(s)');
g = tab.gets.length;
sock.onmessage({ data: 'r' + tab.ver });
await settle();
check('V2b. and the same frame again reads nothing', tab.gets.length === g, (tab.gets.length - g) + ' read(s)');

console.log('\nM. posture on change');
// The full statement owed at the reconnect goes on the first pulse.
let n = tab.posts.length;
await run(tab, 1, posture());
const first = statements(tab, n);
check('M0. the reconnect\'s full statement goes on the first pulse', first.length === 1, first.length + ' statement(s)');
n = tab.posts.length;
await run(tab, 300, posture());
check('M1. posture unchanged for 5 min under derived: true: no statement', statements(tab, n).length === 0,
	statements(tab, n).length + ' statement(s) in 300 s');
n = tab.posts.length;
await run(tab, 3, posture({ att: false }));
const ch = statements(tab, n);
check('M2. attended decays: one statement', ch.length === 1, ch.length + ' statement(s)');
check('M2b. carrying this tab\'s w', ch.length > 0 && !!ch[0].body.w && ch[0].body.w === (S.wake && S.wake().id),
	ch.length ? 'w=' + ch[0].body.w : 'none sent');
n = tab.posts.length;
tab.mine = undefined;				// the gateway restarted: it holds nothing for this tab
await S.refreshPresence();
await settle();
tab.mine = 'echo';
await run(tab, 2, posture({ att: false }));
check('M3. a read whose mine is absent: a re-statement', statements(tab, n).length === 1,
	statements(tab, n).length + ' statement(s)');
n = tab.posts.length;
tab.mine = { attended: true, runner: false, mobile: false, hand: true, folder: true, busy: 0, busy_chats: [], stated: true };
await S.refreshPresence();
await settle();
tab.mine = 'echo';
await run(tab, 2, posture({ att: false }));
check('M3b. a read whose mine differs: a re-statement', statements(tab, n).length === 1,
	statements(tab, n).length + ' statement(s)');

console.log('\nL. leaving');
n = tab.posts.length;
fire(tab.winL, 'pagehide');
await settle();
const lv = tab.posts.slice(n);
check('L1. pagehide: one keepalive leaving POST',
	lv.length === 1 && lv[0].keepalive === true && lv[0].body.leaving === true,
	lv.length ? JSON.stringify(lv[0]) : 'none');
check('L1b. carrying device_id and w and nothing else',
	lv.length === 1 && lv[0].body.device_id === SELF && !!lv[0].body.w
		&& Object.keys(lv[0].body).sort().join() === 'device_id,leaving,w',
	lv.length ? Object.keys(lv[0].body).sort().join() : 'none');
// H4's device half: post.js's park says it is leaving under its own wake id, at the
// lock, when the identity is already locked.
tab.unlocked = false;
tab.authed = true;		// a lock keeps the gateway session
n = tab.posts.length;
const sentPark = S.presenceLeaving ? S.presenceLeaving('p-park') : false;
await settle();
const lp = tab.posts.slice(n);
check('L3. a leaving for the park\'s origin is sent though locked, under that w',
	sentPark === true && lp.length === 1 && lp[0].body.leaving === true && lp[0].body.w === 'p-park',
	lp.length ? JSON.stringify(lp[0].body) : 'none');
tab.unlocked = true;
tab.authed = null;

console.log('\nV3. a reconnect');
sock.close();
S.wakeVia('');
await settle();
sock = tab.sockets[tab.sockets.length - 1];
g = tab.gets.length;
const e0 = tab.evs.length;
if (sock) { sock.readyState = 1; sock.onopen && sock.onopen({}); }
await settle();
check('V3d. a reconnect tells the park its channel is back [L1]',
	tab.evs.slice(e0).includes('daimond:channel-back'), tab.evs.slice(e0).join());
check('V3c. a reconnect reads presence though the version did not move', tab.gets.length - g === 1,
	(tab.gets.length - g) + ' read(s)');

console.log('\nG. a gateway restart');
{
	const chat = { id: 'c1', messages: [] };
	const swOpts = () => ({ selfId: SELF, nominatedId: PEER_ID, runnerOnly: true, toggle: null,
		freshWindowMs: 90000, presenceUnknown: !!(P.unknown && P.unknown()) });
	const before = tab.win.DaimondPeer.seatSwitch(chat, P.snapshot(), swOpts(), NOW);
	tab.down = true;
	const sk = tab.sockets.length;
	sock.close();
	await settle();
	const after = tab.win.DaimondPeer.seatSwitch(chat, P.snapshot(), swOpts(), NOW);
	check('G1. the channel drops and its re-read is not 200: the map is unknown', !!(P.unknown && P.unknown()),
		'unknown=' + (P.unknown ? P.unknown() : 'absent'));
	check('G1b. and the switch reads Here though the map last named the runner',
		before.choice === 'runner' && after.choice === 'here' && !after.runner, before.choice + ' -> ' + after.choice);
	tab.down = false;
	await S.pull();
	await settle();
	const s2 = tab.sockets[tab.sockets.length - 1];
	check('G2. a pull answered 200 opens the channel at once [L1]', tab.sockets.length > sk && s2 !== sock,
		(tab.sockets.length - sk) + ' socket(s) since the drop');
	sock = s2 || sock;
	const g2 = tab.gets.length;
	if (s2) { s2.readyState = 1; s2.onopen && s2.onopen({}); }
	await settle();
	const back = tab.win.DaimondPeer.seatSwitch(chat, P.snapshot(), swOpts(), NOW);
	check('G1c. the read on reconnect lands: known again, the runner offered',
		tab.gets.length > g2 && !P.unknown() && back.choice === 'runner', 'choice=' + back.choice);
}

console.log('\nB. an older gateway');
tab.derived = false;
await S.refreshPresence();
await settle();
const oldRec = (P.snapshot() || {})[PEER_ID] || {};
check('P1c. a row from an answer without derived carries none of the derived fields',
	!('listening' in oldRec) && !('heardAt' in oldRec) && !('doors' in oldRec) && !('stated' in oldRec)
		&& oldRec.runner === true && oldRec.lastSeen === NOW,
	Object.keys(oldRec).join());
n = tab.posts.length;
await run(tab, 46, posture({ att: false }));
const beats = statements(tab, n);
check('B1. an answer without derived: the 45 s beat resumes', beats.length >= 1 && beats.length <= 2,
	beats.length + ' beat(s) in 46 s');
n = tab.posts.length;
fire(tab.winL, 'pagehide');
await settle();
check('L2. and pagehide sends no leaving to it (it would read as a nameless beat)', tab.posts.length === n,
	(tab.posts.length - n) + ' POST(s)');

// ── A tab on the HTTP park ──
console.log('\nS. the sync park');
const pt = makeTab();
pt.unlocked = true;
const PS = pt.win.DaimondSync;
PS.wakeVia('poll');
await settle();
const park = pt.parks[pt.parks.length - 1];
check('S0. the park loop reads presence as it starts', pt.gets.length === 1, pt.gets.length + ' read(s)');
check('S0b. and parks asking for presence above the version held',
	!!park && park.q.get('pres') === String(pt.ver), park ? 'pres=' + park.q.get('pres') : 'no park');
let pg = pt.gets.length;
NOW += 5000;			// past the park's floor, so the loop parks again at once
if (park) park.res({ waited: true, changed: false, version: 0, pres: pt.ver });
await settle();
check('S1b. pres at the version held reads nothing', pt.gets.length === pg, (pt.gets.length - pg) + ' read(s)');
pt.ver += 3;
pg = pt.gets.length;
const park2 = pt.parks[pt.parks.length - 1];
NOW += 5000;
if (park2 && park2 !== park) park2.res({ waited: true, changed: false, version: 0, pres: pt.ver });
await settle();
check('S1. pres above the version held reads presence once', pt.gets.length - pg === 1, (pt.gets.length - pg) + ' read(s)'
	+ (park2 === park ? ', no second park' : ''));

// ── TABCLOSE: the page's close withdraws every origin it holds ──
console.log('\nT. the page closes (TABCLOSE)');
{
	const tt = makeTab();
	tt.unlocked = true;
	const TS = tt.win.DaimondSync;
	TS.wakeVia('');
	await settle();
	const ts = tt.sockets[tt.sockets.length - 1];
	if (ts) { ts.readyState = 1; ts.onopen && ts.onopen({}); }
	await settle();
	const runnerPosture = () => { const a = posture(); a[4] = true; return a; };
	await run(tt, 3, runnerPosture());
	const said = statements(tt, 0).filter((p) => p.body.runner === true);
	check('T0. the tab states the runner flag', said.length >= 1, said.length + ' runner statement(s)');
	const wk = TS.wake && TS.wake().id;
	if (TS.presenceOrigin) TS.presenceOrigin('p-park');	// post.js's park, as it parks
	let n = tt.posts.length;
	fire(tt.winL, 'pagehide');
	await settle();
	const ws = tt.posts.slice(n).filter((p) => p.body.leaving).map((p) => p.body.w).sort();
	check('T1. pagehide leaves every origin the page holds: its own and the park\'s',
		ws.length === 2 && ws.includes(wk) && ws.includes('p-park'), ws.join() || 'none');
	// A reload whose departure lands as the door looks shut (the session mid-renewal, the
	// identity locking): the runner flag it stated must still leave.
	tt.authed = false;
	tt.win.DaimondIdentity.deviceId = () => '';
	n = tt.posts.length;
	fire(tt.winL, 'pagehide');
	await settle();
	const lr = tt.posts.slice(n).filter((p) => p.body.leaving && p.body.w === wk);
	check('T2. a page holding the runner flag leaves though the door looks shut, under the id it stated',
		lr.length === 1 && lr[0].body.device_id === SELF && lr[0].keepalive === true,
		lr.length ? JSON.stringify(lr[0].body) : 'none');
}
{
	// The runner flag stated as the tab's FIRST word, before any answer said the gateway
	// derives: the answer to it does, so the flag stands there and must still leave.
	const tf = makeTab();
	tf.unlocked = true;
	const FS = tf.win.DaimondSync;
	const runnerPosture = () => { const a = posture(); a[4] = true; return a; };
	await run(tf, 2, runnerPosture());
	const first = tf.posts.filter((p) => !p.body.leaving && p.body.runner === true);
	tf.authed = false;
	const n = tf.posts.length;
	fire(tf.winL, 'pagehide');
	await settle();
	const lf = tf.posts.slice(n).filter((p) => p.body.leaving);
	check('T2b. a runner flag stated before the first derived answer still leaves through a shut door',
		first.length >= 1 && lf.length === 1 && lf[0].body.device_id === SELF,
		first.length + ' runner statement(s), ' + lf.length + ' leaving(s)' + (FS.presenceDerived ? ', derived=' + FS.presenceDerived() : ''));
}
{
	// And a page that never stated the runner flag keeps the old gate.
	const tn = makeTab();
	tn.unlocked = true;
	const NS = tn.win.DaimondSync;
	NS.wakeVia('');
	await settle();
	const ns = tn.sockets[tn.sockets.length - 1];
	if (ns) { ns.readyState = 1; ns.onopen && ns.onopen({}); }
	await settle();
	await run(tn, 3, posture());
	tn.authed = false;
	const n = tn.posts.length;
	fire(tn.winL, 'pagehide');
	await settle();
	check('T3. a page without the runner flag sends nothing through a shut door', tn.posts.length === n,
		(tn.posts.length - n) + ' POST(s)');
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
