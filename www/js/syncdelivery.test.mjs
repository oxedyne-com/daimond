/* ============================================================
   Test — the delivery layer of www/js/sync.js (P1a review,
   2026-09-25, `specs/daimond_sync_review_delivery_20260925.md`).
   ------------------------------------------------------------
   Drives the REAL sync.js in the sandbox pushretry.test.mjs uses,
   against a compare-and-set mailbox, on a virtual clock AND a
   virtual `Date`, so every throttle the page reads on `Date.now()`
   runs on the test's time and nothing depends on load.

   One case per finding, each with the count the review measured on
   the release 4 page (`909d9ea8`) beside the bound it asserts:

     WAKELOOP  H2. A poll-mode wake channel and a version this device
               cannot merge, 10 min: at most 7 whole-parcel GETs (565).
               A version genuinely newer still pulls at once.
     HANG      H3. A push POST nothing ever answers, a focus every 60 s
               for 10 min: no round holds the gate past its deadline,
               pulls go on (0), the chip says 'unsent' between tries,
               and the work lands once the link heals (never).
     STORED    H3. The gateway stored the POST whose answer was lost:
               the retry lands one redundant version and loses nothing.
     PROGHANG  H3. A progress frame nothing answers: the final push
               still gets the gate (never).
     FLUSHDOOR M1. flush() over a parcel refused at the 8 MiB front
               door: ok:false, 'too_large' (ok:true at the old version).
     FLUSH413  M1. The same for a parcel the gateway answers 413.
     WIRECONFLICT  owed on the wire's ladder at its ceiling, then two conflicts on another
               trigger: the retry follows the conflict's ceiling (a minute), not the
               wire's five (the simulator's seed p-fmufx0w9y6t90as).
     FLUSHOK   [ctl] flush() over a push that lands: ok:true at the
               version it landed at.
     CONTEND   M2 (D110). Another device lands before every POST, for
               30 min: at most 76 POSTs (1,552) and 110 GETs (1,745); the
               work lands within 2 min of the contention stopping.
     CONTENDW  M2, the same, and the other device also lands every 5 s on
               a poll-mode wake channel, which pulls on each landing: at
               most 76 POSTs (2,912), and GETs at most 110 beyond one per
               landing heard (3,276 in all).
     RAWPULL   M4. `DaimondSync.pull()` called while a push reconciles a
               409: never two merges at once (2), and it still pulls.
     OWEDPULL  SIM-8. Owed work, then focus pulls every 3 s through 2 min
               with the link down, and a landed pull after: the chip shows
               the stall after every round (it rested on "Last synced").
     MERGEHOLD A version that will not merge, owed work, a turn every 20 s and a
               hand-off flush every 30 s for 10 min: no POST at all (release 5.1:
               a 409 per trigger and six per flush, the reopen rehearsal's storm),
               the bounded re-pull and the ladder re-read it, and the work lands
               once it merges.
     FILESTORE A browser that keeps no files (cloud.js `fileStore`): the chip reads
               'partial' with the reason, `state()` says so, pushes land, and a store
               that comes back re-merges the adopted version once.
     CHIP      M7 (D072). `DaimondSync.chip()` is the chip's one word and
               `state()` the engine's object, and the rail is told when
               the word changes: through a failed push it reads 'stalled'
               (release 4: `state()` was the object, so the rail read no
               word at all and said "This device only").

   Each case fails on the release 4 page:
     SYNC_JS=<release/r4>/www/js/sync.js node www/js/syncdelivery.test.mjs
     node www/js/syncdelivery.test.mjs            # ALL PASS
     node www/js/syncdelivery.test.mjs WAKELOOP   # one case
   ============================================================ */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE    = dirname(fileURLToPath(import.meta.url));
const SYNC_JS = process.env.SYNC_JS || join(HERE, 'sync.js');
const WANT    = process.argv.slice(2).filter((a) => /^[A-Z0-9]+$/.test(a));
const want    = (c) => !WANT.length || WANT.includes(c);

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

const SELF      = '00112233445566aa';
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain     = () => new Promise((r) => setImmediate(r));
const sealed    = (o) => 'sealed:' + JSON.stringify(o);

/// One tab: the real sync.js over a stubbed page, a mailbox and a clock the test owns.
function makeTab(cfg) {
	cfg = cfg || {};
	const store = new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	const T0  = 1758700000000;
	win.Date = class extends Date {
		constructor(...a) { if (a.length) super(...a); else super(T0 + (win.__tab ? win.__tab.vnow : 0)); }
		static now() { return T0 + (win.__tab ? win.__tab.vnow : 0); }
	};
	const listeners = {};
	win.addEventListener = (type, f) => { (listeners[type] = listeners[type] || []).push(f); };
	win.dispatchEvent    = (ev) => { (listeners[ev.type] || []).forEach((f) => f(ev)); return true; };
	win.Event            = class { constructor(type) { this.type = type; } };
	win.CustomEvent      = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
	// A DOM just deep enough for the chip: elements are found by id once appended.
	const byId = new Map();
	const mkEl = () => {
		const el = {
			style: {}, dataset: {}, children: [], title: '', id: '', textContent: '',
			classList: { add: () => {}, remove: () => {}, toggle: () => {} },
			setAttribute: () => {}, addEventListener: () => {}, remove: () => {},
			querySelectorAll: () => [],
			appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; },
			querySelector(sel) {
				if (!this._parts) this._parts = {};
				return (this._parts[sel] = this._parts[sel] || { textContent: '' });
			},
		};
		Object.defineProperty(el, 'innerHTML', { set() {}, get() { return ''; } });
		return el;
	};
	if (cfg.dom) byId.set('astat-sync', mkEl());
	const document = {
		readyState: 'complete', hidden: false, addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [],
		getElementById: (id) => byId.get(id) || null,
		createElement: mkEl, body: mkEl(),
	};
	const tab = {
		win, unlocked: false,
		parcel:  { v: 3, chats: [], note: 'boot' },
		postMode: 'normal',		// 'normal' | 'hang' | 'hang-stored' | '413' | '502'
		moveOnRead: 0,			// another device lands before each of this many POSTs
		posts: [], gets: 0, parks: 0, getBytes: 0,
		mailbox: { version: 4, blob: sealed({ v: 3, chats: [], note: 'phone v4', pad: cfg.pad || '' }) },
		vnow: 0, timers: [], parkIds: 0,
		fire: (type) => (listeners[type] || []).forEach((f) => f({ type })),
		events: [], waiters: [], hangs: [],
		/// Another device lands `v`: the mailbox moves and every park below it is answered.
		land(v, obj) {
			tab.mailbox = { version: v, blob: sealed(obj) };
			tab.waiters.filter((w) => w.above < v).forEach((w) => w.wake());
		},
	};
	win.__tab = tab;
	win.__doc = document;
	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked,
		wrap:       async (plain) => 'sealed:' + plain,
		unwrap:     async (blob) => String(blob).slice('sealed:'.length),
		handle:     () => '', deviceId: () => SELF,
	};
	const answer = (status, json) => ({ status, json: async () => json, headers: { get: () => '' } });
	const hangOn = (opts) => new Promise((res, rej) => {
		// Black-holed: nothing answers. Only the caller's signal ends it, as fetch's does.
		const h = { at: tab.vnow, end: -1 };
		tab.hangs.push(h);
		const sig = opts && opts.signal;
		if (!sig) return;
		const gone = () => { h.end = tab.vnow; rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
		if (sig.aborted) { gone(); return; }
		sig.addEventListener('abort', gone);
	});
	win.DaimondGateway = {
		clientApi: () => 1,
		state:     () => ({ authed: tab.unlocked }),
		gwFetch:   async (path, opts) => {
			const q = new URL('http://x' + path).searchParams;
			if (q.has('above')) {
				tab.parks++;
				if (tab.mailbox.version > (Number(q.get('above')) | 0)) {
					return answer(200, { ok: true, waited: true, changed: true, version: tab.mailbox.version });
				}
				// Nothing new: held for `ms` of virtual time and answered quietly, or answered
				// `changed` the moment the mailbox moves above it, as sync.rs does.
				const ms = Math.min(55000, Math.max(1000, Number(q.get('ms')) || 55000));
				const above = Number(q.get('above')) | 0;
				return new Promise((res) => {
					const id = -(++tab.parkIds);
					const done = (changed) => {
						tab.timers  = tab.timers.filter((t) => t.id !== id);
						tab.waiters = tab.waiters.filter((w) => w.id !== id);
						res(answer(200, { ok: true, waited: true, changed, version: tab.mailbox.version }));
					};
					tab.timers.push({ id, due: tab.vnow + ms, f: () => done(false) });
					tab.waiters.push({ id, above, wake: () => done(true) });
				});
			}
			if (q.has('presence') || q.has('lease') || q.has('progress')) return answer(200, { ok: true });
			if (!opts || !opts.method || opts.method === 'GET') {
				if (tab.getFails) { tab.getFailed = (tab.getFailed || 0) + 1; throw new TypeError('Failed to fetch'); }
				tab.gets++;
				tab.getBytes += tab.mailbox.blob.length;
				return answer(200, { present: true, version: tab.mailbox.version, blob: tab.mailbox.blob, device: 'Phone' });
			}
			const body = JSON.parse(opts.body);
			if (tab.postMode === 'hang') { tab.posts.push({ hang: true }); return hangOn(opts); }
			if (tab.postMode === 'hang-stored') {
				// The gateway stored it; the answer is what never came back.
				tab.posts.push({ hang: true, stored: true, base: body.base_version | 0 });
				if ((body.base_version | 0) === tab.mailbox.version) {
					tab.mailbox = { version: tab.mailbox.version + 1, blob: body.blob };
				}
				return hangOn(opts);
			}
			if (tab.postMode === '413') { tab.posts.push({ ok: false, s: 413 }); return answer(413, { ok: false }); }
			if (tab.postMode === '502') { tab.posts.push({ ok: false, s: 502, at: tab.vnow }); return answer(502, { ok: false }); }
			if (tab.moveOnRead > 0) {
				tab.moveOnRead--;
				tab.land(tab.mailbox.version + 1, { v: 3, chats: [], note: 'other v' + (tab.mailbox.version + 1), pad: cfg.pad || '' });
			}
			if ((body.base_version | 0) !== tab.mailbox.version) {
				tab.posts.push({ base: body.base_version | 0, ok: false, at: tab.vnow });
				return answer(409, { ok: false, version: tab.mailbox.version });
			}
			tab.posts.push({ base: body.base_version | 0, ok: true, at: tab.vnow });
			tab.mailbox = { version: tab.mailbox.version + 1, blob: body.blob };
			return answer(200, { ok: true, version: tab.mailbox.version });
		},
	};
	win.DaimondCore = {
		collectSync: async () => JSON.parse(JSON.stringify(tab.parcel)),
		syncSelfDeviceId: () => SELF, busy: () => false,
		deviceSelfName: () => 'Chromium on Linux',
		syncMayCommitChunks: () => false, syncCommitBlockedReason: () => '',
		applySync: async () => {
			tab.applyActive = (tab.applyActive || 0) + 1;
			tab.applyMax    = Math.max(tab.applyMax || 0, tab.applyActive);
			tab.applies     = (tab.applies || 0) + 1;
			if (tab.slowApply) await realSleep(40);
			tab.applyActive--;
			return tab.mergeFails ? { failed: ['chats'] } : {};
		},
	};
	win.DaimondCloud = {
		sha256: async (s) => {
			const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
			return Array.from(new Uint8Array(d)).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
		},
	};
	const src = readFileSync(SYNC_JS, 'utf8');
	const fn = new Function('window', 'document', 'crypto', 'localStorage', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
		'with (window) {\n' + src + '\n}');
	let nextId = 1;
	fn(win, document, webcrypto, localStorage, TextEncoder, TextDecoder,
		(f, ms) => { const id = nextId++; tab.timers.push({ id, f, due: tab.vnow + (ms | 0) }); return id; },
		(id) => { tab.timers = tab.timers.filter((t) => t.id !== id); },
		() => 0, () => {},
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	win.Math = Object.create(Math, { random: { value: () => 0.5 } });	// jitter pinned to its mean
	return tab;
}

/// Let every promise the page has in flight settle, in real time, until nothing moves.
async function quiet(tab) {
	let last = -1, still = 0;
	for (let i = 0; i < 400 && still < 4; i++) {
		for (let j = 0; j < 10; j++) await drain();
		await realSleep(2);
		const now = tab.posts.length * 1e6 + tab.gets * 1e3 + tab.parks;
		if (now === last) still++; else { still = 0; last = now; }
	}
}

/// Run the virtual clock on by `ms`, firing each timer at its time; `every` fires a
/// callback on its own period as well (a focus, say).
async function advance(tab, ms, every) {
	const end = tab.vnow + ms;
	let nextEvery = every ? tab.vnow + every.ms : Infinity;
	for (;;) {
		await quiet(tab);
		const due   = tab.timers.filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
		const dueAt = due ? due.due : Infinity;
		if (nextEvery <= end && nextEvery <= dueAt) {
			tab.vnow = Math.max(tab.vnow, nextEvery);
			every.fn();
			nextEvery += every.ms;
			continue;
		}
		if (!due) break;
		tab.timers = tab.timers.filter((t) => t !== due);
		tab.vnow   = Math.max(tab.vnow, due.due);
		due.f();
	}
	tab.vnow = end;
	await quiet(tab);
}

/// What the chip shows, read off the element, so a build without `chip()` is judged too.
function chipOf(tab) {
	const c = tab.win.__doc.getElementById('sync-chip');
	if (c && c.style.display !== 'none') return String(c.dataset.state || '');
	return 'rest';
}

/// A tab signed in, with the mailbox at v4 pulled and merged.
async function booted(cfg) {
	const tab = makeTab(cfg);
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	await S.pull();
	await quiet(tab);
	return { tab, S };
}

// ── H2 ─────────────────────────────────────────────────────────
if (want('WAKELOOP')) {
	console.log('\nWAKELOOP (H2): a poll-mode wake channel and a version that will not merge, 10 min\n');
	const { tab, S } = await booted({ pad: 'y'.repeat(64 * 1024) });
	S.wakeVia('poll');
	await advance(tab, 5000);
	check('[ctl] the channel is parked by poll', S.wake().mode === 'poll' && tab.parks > 0,
		JSON.stringify(S.wake()));
	// Another device lands a version whose chats section will not merge here.
	tab.mergeFails = true;
	tab.land(5, { v: 3, chats: [1], note: 'other v5' });
	const g0 = tab.gets, pk0 = tab.parks;
	await advance(tab, 600000);
	const gets = tab.gets - g0, parks = tab.parks - pk0;
	console.log('  note 10 min: ' + gets + ' whole-parcel GETs, ' + parks + ' parks; v' + S.state().version
		+ ' ' + JSON.stringify(S.state().stalledWhy));
	check('the version that will not merge is pulled as the re-pull pulls it: at most 7 GETs (release 4: 565)',
		gets <= 7, gets + ' GETs');
	check('and the channel parks rather than spins: at most 30 parks in 10 min (release 4: 699)',
		parks <= 30, parks + ' parks');
	check('the version is not adopted, and the chip says why', S.state().version === 4
		&& S.state().stalledWhy === 'merge', JSON.stringify({ v: S.state().version, why: S.state().stalledWhy }));
	// A genuinely newer version, which merges: the channel pulls it at once.
	tab.mergeFails = false;
	tab.land(6, { v: 3, chats: [], note: 'other v6' });
	const g1 = tab.gets;
	await advance(tab, 3000);
	check('a newer version is still pulled at once, and adopted', tab.gets - g1 >= 1 && S.state().version === 6,
		(tab.gets - g1) + ' GETs in 3 s; v' + S.state().version);
	check('and the chip clears', S.state().stalled === false, JSON.stringify(S.state().stalledWhy));
}

// ── H3 ─────────────────────────────────────────────────────────
/// Sample `state()` every `step` ms for `ms`, firing a focus every 60 s, and answer how
/// many samples said the work was owed and stalled.
async function watch(tab, S, ms, step) {
	let unsent = 0, n = 0, sinceFocus = 0;
	const end = tab.vnow + ms;
	while (tab.vnow < end) {
		await advance(tab, step);
		sinceFocus += step;
		if (sinceFocus >= 60000) { sinceFocus = 0; tab.fire('focus'); }
		const st = S.state();
		n++;
		if (st.stalled && st.stalledWhy === 'unsent') unsent++;
	}
	return { unsent, n };
}

if (want('HANG')) {
	console.log('\nHANG (H3): a push POST nothing ever answers, then the link heals\n');
	const { tab, S } = await booted();
	tab.parcel = { v: 3, chats: [], note: 'answer' };
	tab.postMode = 'hang';
	S.push();
	const g0 = tab.gets;
	const w = await watch(tab, S, 600000, 5000);
	const held = tab.hangs.map((h) => (h.end < 0 ? tab.vnow : h.end) - h.at);
	console.log('  note 10 min: ' + tab.posts.length + ' POSTs tried, ' + (tab.gets - g0) + ' GETs; each hung POST ended after '
		+ held.map((x) => Math.round(x / 1000) + ' s').join(', ') + '; ' + w.unsent + ' of ' + w.n + ' samples said unsent');
	check('every hung POST ends at its deadline, 61 s for this parcel (release 4: never)',
		held.length >= 1 && held.every((x) => x <= 61000), held.map((x) => Math.round(x / 1000)).join(','));
	check('pulls go on while the pushes hang (release 4: 0)', tab.gets - g0 >= 5, (tab.gets - g0) + ' GETs');
	check('between tries the chip says the work is owed (release 4: never)', w.unsent >= 10,
		w.unsent + ' of ' + w.n + ' samples');
	check('the hung push was tried again, on the wire ladder: at most 10 POSTs in 10 min',
		tab.posts.length >= 2 && tab.posts.length <= 10, tab.posts.length + ' POSTs');
	tab.postMode = 'normal';
	await watch(tab, S, 600000, 5000);
	const landed = tab.posts.filter((p) => p.ok);
	check('once the link heals the work lands (release 4: never)', landed.length === 1
		&& JSON.parse(tab.mailbox.blob.slice(7)).note === 'answer', JSON.stringify(tab.posts.slice(-2)));
	check('and nothing is owed', S.state().stalled === false, JSON.stringify(S.state().stalledWhy));
}

if (want('STORED')) {
	console.log('\nSTORED (H3): the gateway stored the POST, and its answer never came back\n');
	const { tab, S } = await booted();
	tab.parcel = { v: 3, chats: ['c1'], note: 'answer' };
	tab.postMode = 'hang-stored';
	S.push();
	await advance(tab, 3000);
	check('[ctl] the POST reached the mailbox (v5 is this device\'s parcel)', tab.mailbox.version === 5
		&& JSON.parse(tab.mailbox.blob.slice(7)).note === 'answer', 'v' + tab.mailbox.version);
	tab.postMode = 'normal';
	await advance(tab, 180000);
	const top = JSON.parse(tab.mailbox.blob.slice(7));
	check('the retry lands exactly one redundant version', tab.mailbox.version === 6
		&& tab.posts.filter((p) => p.ok).length === 1, 'v' + tab.mailbox.version + ' ' + JSON.stringify(tab.posts));
	check('and loses nothing: the mailbox holds this device\'s parcel', top.note === 'answer'
		&& JSON.stringify(top.chats) === '["c1"]', JSON.stringify(top));
	check('and nothing is owed, at the version it landed', S.state().stalled === false && S.state().version === 6,
		JSON.stringify({ why: S.state().stalledWhy, v: S.state().version }));
}

if (want('PROGHANG')) {
	console.log('\nPROGHANG (H3): a progress frame nothing answers, then the final push\n');
	const { tab, S } = await booted();
	tab.parcel = { v: 3, chats: [], note: 'half an answer' };
	tab.postMode = 'hang';
	S.pushProgress();
	await advance(tab, 5000);
	check('[ctl] the frame is hanging and holds the gate', S.state().busyWith === 'a round is running',
		JSON.stringify(S.state().busyWith));
	tab.postMode = 'normal';
	tab.parcel = { v: 3, chats: [], note: 'the whole answer' };
	S.push();
	await advance(tab, 120000);
	check('the final push lands once the frame passes its deadline (release 4: never)',
		JSON.parse(tab.mailbox.blob.slice(7)).note === 'the whole answer', 'v' + tab.mailbox.version
		+ ' ' + JSON.stringify(tab.posts));
}

// ── M1 ─────────────────────────────────────────────────────────
if (want('FLUSHDOOR')) {
	console.log('\nFLUSHDOOR (M1): flush() over a parcel refused at the front door (wire > 8 MiB)\n');
	const { tab, S } = await booted();
	tab.parcel = { v: 3, chats: [], note: 'new chat', big: 'x'.repeat(9 * 1024 * 1024) };
	let res = null;
	S.flush().then((r) => { res = r; });
	await advance(tab, 5000);
	check('[ctl] no POST was sent (refused here)', tab.posts.length === 0, 'posts=' + tab.posts.length);
	check('[ctl] state() says too_big', S.state().stalledWhy === 'too_big', JSON.stringify(S.state().stalledWhy));
	check('flush() does not claim the parcel committed (release 4: ok:true at v4)',
		!!res && res.ok === false && res.why === 'too_large',
		JSON.stringify(res) + ' with the mailbox at v' + tab.mailbox.version);
	check('flush() names no version it cannot vouch for: 0 (1640b9a0: the mailbox\'s v4)',
		!!res && res.version === 0, JSON.stringify(res));
}

if (want('FLUSH413')) {
	console.log('\nFLUSH413 (M1): flush() over a parcel the gateway answers 413\n');
	const { tab, S } = await booted();
	tab.parcel = { v: 3, chats: [], note: 'new chat' };
	tab.postMode = '413';
	let res = null;
	S.flush().then((r) => { res = r; });
	await advance(tab, 5000);
	check('[ctl] one POST, refused 413', tab.posts.length === 1 && tab.posts[0].s === 413, JSON.stringify(tab.posts));
	check('flush() does not claim the parcel committed (release 4: ok:true at v4)',
		!!res && res.ok === false && res.why === 'too_large',
		JSON.stringify(res) + ' with the mailbox at v' + tab.mailbox.version);
	check('flush() names no version it cannot vouch for: 0 (1640b9a0: the mailbox\'s v4)',
		!!res && res.version === 0, JSON.stringify(res));
}

if (want('FLUSHOK')) {
	console.log('\nFLUSHOK [ctl]: flush() over a push that lands\n');
	const { tab, S } = await booted();
	tab.parcel = { v: 3, chats: [], note: 'new chat' };
	let res = null;
	S.flush().then((r) => { res = r; });
	await advance(tab, 5000);
	check('[ctl] flush() answers ok at the version it landed at', !!res && res.ok === true && res.version === 5
		&& tab.mailbox.version === 5, JSON.stringify(res));
}

// ── M2 (D110) ──────────────────────────────────────────────────
async function contend(wake) {
	const PAD = 'y'.repeat(1400 * 1024);
	const { tab, S } = await booted({ pad: PAD });
	if (wake) { S.wakeVia('poll'); await advance(tab, 3000); }
	tab.parcel = { v: 3, chats: [], note: 'answer', pad: 'z'.repeat(1400 * 1024) };
	tab.moveOnRead = 1e9;
	// With the channel, the other device also lands on its own clock, every 5 s, so every
	// landing wakes this one: a pull, and owed work sent at once on the next push.
	let beating = !!wake, landings = 0;
	const beat = () => {
		if (!beating) return;
		landings++;
		tab.land(tab.mailbox.version + 1, { v: 3, chats: [], note: 'other v' + (tab.mailbox.version + 1), pad: PAD });
		tab.timers.push({ id: -(++tab.parkIds), due: tab.vnow + 5000, f: beat });
	};
	if (wake) tab.timers.push({ id: -(++tab.parkIds), due: tab.vnow + 5000, f: beat });
	const g0 = tab.gets, p0 = tab.posts.length;
	S.push();
	await advance(tab, 1800000);
	beating = false;
	const gets = tab.gets - g0, posts = tab.posts.length - p0;
	const mb = (gets + posts) * 1.4;
	console.log('  note 30 min: ' + posts + ' POSTs, ' + gets + ' whole-parcel GETs, about ' + Math.round(mb) + ' MB at 1.4 MB a parcel');
	check('bounded: at most 76 POSTs in 30 min (release 4: ' + (wake ? '2,912' : '1,552') + ')', posts <= 76, posts + ' POSTs');
	// With the channel each landing is pulled once, which is the channel's job (whole-parcel
	// pulls are D111, a gateway release); what is bounded is everything on top of that.
	check('and at most 110 GETs beyond one per landing heard (release 4: ' + (wake ? '3,276' : '1,745') + ')',
		gets <= 110 + landings, gets + ' GETs, ' + landings + ' landings');
	check('the work is owed and says so throughout', S.state().stalled === true, JSON.stringify(S.state().stalledWhy));
	tab.moveOnRead = 0;
	await advance(tab, 120000);
	check('once the other device stops, the work lands within 2 min', JSON.parse(tab.mailbox.blob.slice(7)).note === 'answer'
		&& S.state().stalled === false, JSON.stringify({ why: S.state().stalledWhy, v: tab.mailbox.version }));
}
if (want('CONTEND')) {
	console.log('\nCONTEND (M2, D110): another device lands before every POST, 30 min\n');
	await contend(false);
}
if (want('CONTENDW')) {
	console.log('\nCONTENDW (M2, D110): the same, with a poll-mode wake channel\n');
	await contend(true);
}

// ── M4 ─────────────────────────────────────────────────────────
if (want('RAWPULL')) {
	console.log('\nRAWPULL (M4): the exported pull() beside a round that holds the gate\n');
	const { tab, S } = await booted();
	tab.slowApply = true;
	tab.applyMax  = 0;
	// A push whose compare-and-set is refused once: its own reconciling pull runs inside the gate.
	tab.parcel = { v: 3, chats: [], note: 'answer' };
	tab.moveOnRead = 1;
	const a0 = tab.applies || 0, g0 = tab.gets;
	S.push();
	await realSleep(5);
	// The hand-off waits and the return recovery call DaimondSync.pull() directly.
	let got = null;
	S.pull(true).then((v) => { got = v; });
	await advance(tab, 5000);
	check('never two merges at once (release 4: 2)', tab.applyMax <= 1, 'max concurrent applySync = ' + tab.applyMax);
	// Its own GET, after the reconcile's; it finds the push's version already merged.
	check('and the exported pull still ran, after the round, at the landed version', got === tab.mailbox.version
		&& tab.gets - g0 >= 2, JSON.stringify({ got, v: tab.mailbox.version, gets: tab.gets - g0, applies: (tab.applies || 0) - a0 }));
	check('and the push it waited for landed', tab.posts.some((p) => p.ok), JSON.stringify(tab.posts));
}

// ── SIM-8 ──────────────────────────────────────────────────────
if (want('OWEDPULL')) {
	console.log('\nOWEDPULL (SIM-8): owed work, then pull rounds on other triggers\n');
	const { tab, S } = await booted({ dom: true });
	tab.parcel = { v: 3, chats: [], note: 'answer' };
	tab.postMode = '502';
	S.push();
	await advance(tab, 500);
	check('[ctl] the push failed and the work is owed', S.state().stalledWhy === 'unsent' && chipOf(tab) === 'stalled',
		JSON.stringify({ why: S.state().stalledWhy, chip: chipOf(tab) }));
	// The link goes for 2 min: focus pulls every 3 s fail inside the owed wait. Sampled
	// every 250 ms: a sample where the engine holds the work owed and the chip rests is
	// the lie.
	tab.getFails = true;
	let lies = 0, samples = 0, sinceFocus = 0;
	for (let t = 0; t < 120000; t += 250) {
		await advance(tab, 250);
		sinceFocus += 250;
		if (sinceFocus >= 3000) { sinceFocus = 0; tab.fire('focus'); }
		samples++;
		if (S.state().stalledWhy === 'unsent' && chipOf(tab) === 'rest') lies++;
	}
	check('[ctl] pulls ran and failed', (tab.getFailed || 0) >= 10, 'failed GETs ' + (tab.getFailed || 0));
	check('while the work is owed the chip never rests after a failed pull round', lies === 0,
		lies + ' of ' + samples + ' samples rested with the work owed');
	// The link returns for reads only: a pull lands, the upload still fails.
	tab.getFails = false;
	const g0 = tab.gets;
	await S.pull();
	await advance(tab, 100);
	check('[ctl] the exported pull landed', tab.gets > g0, (tab.gets - g0) + ' GETs');
	check('after a landed pull round the chip shows the stall, not Synced', chipOf(tab) === 'stalled',
		JSON.stringify({ chip: chipOf(tab), why: S.state().stalledWhy }));
	tab.postMode = 'normal';
	await advance(tab, 400000);
	check('once the upload works the work lands and the chip clears', S.state().stalled === false
		&& chipOf(tab) !== 'stalled', JSON.stringify({ chip: chipOf(tab), why: S.state().stalledWhy }));
}

// ── M7 (D072) ──────────────────────────────────────────────────
if (want('CHIP')) {
	console.log('\nCHIP (M7, D072): the rail\'s word for the chip, through a push that fails\n');
	const { tab, S } = await booted({ dom: true });
	const heard = [];
	tab.win.addEventListener('daimond:sync-chip', (ev) => heard.push(ev.detail && ev.detail.state));
	check('state() is the engine\'s facts, an object', typeof S.state() === 'object' && 'stalled' in S.state(),
		typeof S.state());
	check('chip() is the chip\'s one word (release 4: no chip())', typeof S.chip === 'function'
		&& typeof S.chip() === 'string', typeof S.chip);
	tab.parcel = { v: 3, chats: [], note: 'answer' };
	tab.postMode = '502';
	S.push();
	await advance(tab, 500);
	const word = typeof S.chip === 'function' ? S.chip() : '(none)';
	check('[ctl] the push failed and the work is owed', S.state().stalledWhy === 'unsent', JSON.stringify(S.state().stalledWhy));
	check('through the stall the rail reads "stalled"', word === 'stalled', JSON.stringify(word));
	check('and was told so as it changed', heard.includes('stalled'), JSON.stringify(heard));
	tab.postMode = 'normal';
	await advance(tab, 30000);
	const after = typeof S.chip === 'function' ? S.chip() : '(none)';
	check('once it lands the rail reads "synced", and was told', after === 'synced' && heard[heard.length - 1] === 'synced',
		JSON.stringify({ after, heard }));
}

// ── The ladder's ceiling follows the latest failure ────────────
if (want('WIRECONFLICT')) {
	console.log('\nWIRECONFLICT: owed on the wire\'s long ceiling, then beaten by conflicts on another trigger\n');
	const { tab, S } = await booted({ dom: true });
	tab.parcel = { v: 3, chats: [], note: 'answer' };
	tab.postMode = '502';
	S.push();
	// The wire's ladder climbs towards its five-minute ceiling (jitter pinned to its
	// mean); stop a second after a failure, with the next wire retry minutes away.
	for (let t = 0; t < 1800 && tab.posts.length < 9; t++) await advance(tab, 1000);
	const wired = tab.posts.length, failedAt = tab.posts[wired - 1].at;
	await advance(tab, 1000);
	check('[ctl] the wire failures climbed the ladder', wired === 9 && S.state().stalledWhy === 'unsent',
		wired + ' POSTs, the last at ' + Math.round(failedAt / 1000) + ' s');
	// The link is back; another device lands before each of this device's next two
	// POSTs, and a new trigger sends: two conflicts, the owed round's two tries.
	tab.postMode = 'normal';
	tab.moveOnRead = 2;
	await advance(tab, 1000);
	S.push();
	await advance(tab, 1000);
	const conflictAt = tab.vnow;
	check('[ctl] the new round met two conflicts', tab.posts.slice(wired).filter((p) => p.ok === false).length === 2,
		JSON.stringify(tab.posts.slice(wired)));
	let landedAt = -1;
	for (let t = 0; t < 400 && landedAt < 0; t++) {
		await advance(tab, 1000);
		if (tab.posts.slice(wired).some((p) => p.ok)) landedAt = tab.vnow;
	}
	const waited = landedAt < 0 ? -1 : Math.round((landedAt - conflictAt) / 1000);
	// The conflict's longest jittered wait is 90 s; its retry reads the mailbox first.
	check('the owed work goes on the conflict\'s ladder: lands within 95 s (1640b9a0: the wire\'s, 256 s)',
		waited >= 0 && waited <= 95, waited + ' s; ' + JSON.stringify(tab.posts.slice(wired - 1).map((p) => [p.ok, Math.round(p.at / 1000)])));
	check('and lands, owing nothing', S.state().stalledWhy === '' && chipOf(tab) !== 'stalled',
		JSON.stringify({ why: S.state().stalledWhy, chip: chipOf(tab) }));
}

// ── A version that will not merge is not knocked on ────────────
if (want('MERGEHOLD')) {
	console.log('\nMERGEHOLD: a version that will not merge, owed work, a turn every 20 s and a hand-off flush every 30 s, 10 min\n');
	const { tab, S } = await booted({ dom: true });
	// Another device lands a version whose merge fails here, for good (the reopen
	// rehearsal's WebKit iPhone: the chunk index's merge threw on a browser with no OPFS).
	tab.mergeFails = true;
	tab.land(5, { v: 3, chats: [1], note: 'other v5' });
	await S.pull();
	await quiet(tab);
	check('[ctl] the version was pulled and not adopted', S.state().version === 4 && S.state().stalledWhy === 'merge',
		JSON.stringify({ v: S.state().version, why: S.state().stalledWhy }));
	tab.parcel = { v: 3, chats: [], note: 'this device\'s own work' };
	const p0 = tab.posts.length, g0 = tab.gets;
	let tick = 0;
	await advance(tab, 600000, { ms: 10000, fn: () => {
		tick++;
		if (tick % 2 === 0) tab.fire('daimond:idle');		// a turn ending, every 20 s
		if (tick % 3 === 0) S.flush().catch(() => {});		// a hand-off's flush, every 30 s
	} });
	const posts = tab.posts.length - p0, gets = tab.gets - g0;
	const refused = tab.posts.slice(p0).filter((p) => !p.ok).length;
	console.log('  note 10 min: ' + posts + ' POSTs (' + refused + ' refused 409), ' + gets + ' whole-parcel GETs');
	check('no POST over a version it could not merge: 0 in 10 min (release 5.1: one 409 a trigger, six a flush)',
		posts === 0, posts + ' POSTs, ' + refused + ' refused');
	check('and the version is re-read on the bounded re-pull, then the ladder: at most 9 GETs in 10 min',
		gets <= 9, gets + ' GETs');
	check('the chip says why the work waits', chipOf(tab) === 'stalled' && S.state().stalledWhy === 'merge',
		JSON.stringify({ chip: chipOf(tab), why: S.state().stalledWhy }));
	const fl = await S.flush();
	check('a flush over it answers at once, ok:false and why', fl && fl.ok === false && fl.why === 'merge', JSON.stringify(fl));
	// The cause clears: the next re-read merges, adopts and sends the owed work.
	tab.mergeFails = false;
	const clearAt = tab.vnow, p1 = tab.posts.length;
	let landed = -1;
	for (let t = 0; t < 480 && landed < 0; t++) {
		await advance(tab, 1000);
		if (tab.posts.slice(p1).some((p) => p.ok)) landed = tab.vnow;
	}
	const waited = landed < 0 ? -1 : Math.round((landed - clearAt) / 1000);
	check('once it merges, the owed work lands within the ladder\'s wait (at most 460 s)', waited >= 0 && waited <= 460,
		waited + ' s; ' + JSON.stringify(tab.posts.slice(p1)));
	check('and nothing is owed or stalled after', S.state().stalled === false && S.state().version >= 6,
		JSON.stringify({ v: S.state().version, why: S.state().stalledWhy }));
}

// ── A browser that keeps no files says so, and still syncs ─────
if (want('FILESTORE')) {
	console.log('\nFILESTORE: a browser that keeps no files: the chip says so and everything else travels\n');
	const { tab, S } = await booted({ dom: true });
	tab.fileStore = 'none';
	tab.win.DaimondCloud.fileStore = () => ({ state: tab.fileStore, why: '' });
	tab.parcel = { v: 3, chats: [], note: 'a chat on the device with no files' };
	S.push();
	await advance(tab, 5000);
	check('[ctl] the push landed', tab.posts.length > 0 && tab.posts[tab.posts.length - 1].ok === true, JSON.stringify(tab.posts));
	const c = tab.win.__doc.getElementById('sync-chip');
	check('the chip reads "partial", not synced and not stalled', chipOf(tab) === 'partial', chipOf(tab));
	check('and names the reason in words', !!c && /sync\.files_none_reason/.test(c.title) && c.querySelector('.stext').textContent === 'sync.files_not_here',
		JSON.stringify(c && { text: c.querySelector('.stext').textContent, title: c.title }));
	check('state() says files are not held, and why, and nothing is stalled',
		S.state().filesHeld === false && S.state().filesWhy === 'none' && S.state().stalled === false,
		JSON.stringify({ held: S.state().filesHeld, why: S.state().filesWhy, stalled: S.state().stalled }));
	tab.fileStore = 'refused';
	tab.win.dispatchEvent(new tab.win.CustomEvent('daimond:file-store', { detail: { state: 'refused', was: 'none' } }));
	await advance(tab, 500);
	check('a refusal has its own reason', !!c && /sync\.files_refused_reason/.test(c.title), c && c.title);
	// The store comes back: the version already adopted is merged again, for the files.
	const a0 = tab.applies || 0, g0 = tab.gets;
	tab.fileStore = 'held';
	tab.win.dispatchEvent(new tab.win.CustomEvent('daimond:file-store', { detail: { state: 'held', was: 'refused' } }));
	await advance(tab, 3000);
	check('a store that comes back re-merges the adopted version once', tab.gets - g0 === 1 && (tab.applies || 0) - a0 === 1,
		(tab.gets - g0) + ' GETs, ' + ((tab.applies || 0) - a0) + ' merges');
	check('and the chip rests', chipOf(tab) === 'rest' && S.state().filesHeld === true, chipOf(tab));
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
