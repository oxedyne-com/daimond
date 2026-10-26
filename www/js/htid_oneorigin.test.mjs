/* ============================================================
   Test -- HT-ID: one tab, one origin (QA-HT-A F1, F3; design
   daimond_handoff_truth_design_20261023 §2.2 "origin = the tab's WAKE_ID").
   ------------------------------------------------------------
   The REAL sync.js, peer.js and post.js wired together in one simulated
   tab, as the page wires them: sync.js states the posture, post.js parks
   the errand door. The gateway's side is presence.rs's origin book, ported
   rule for rule (`Origin::posture_gone`, `live_until`, `state`, `door`,
   `leaving`): a posture is filed under the statement's `w`, a door under
   the park's `w`, and a posture whose origin never held a door is the old
   client's, kept only to TTL (5 min). The clock is the test's.

     I1  the park's `w` is the posture's `w`;
     I2  a runner tab idle 6 min with no posture change: the device row
         keeps stated, runner and listening at every second (red on
         aeb8a3f11: stated goes false at stated_at + 5 min + 1 ms);
     I3  the page's close is ONE `leaving`, and it ends both the doors and
         the posture of that origin within the 2 s grace;
     F3  a phone going hidden: one `leaving`, and no re-statement while it
         stays hidden; back in view, a full statement.
     R   RELOAD-ID: a reload keeps the tab's id (sessionStorage), so the new
         page's early park holds the old page's posture across the gap before
         it states (red on c05d1ba3a: stated false at leaving + 2 s); a copy
         of a running tab mints its own id, and both are listed; a bfcache
         hide/show keeps the tab live.

   Red proof:  MM_SRC_REV=aeb8a3f11 node www/js/htid_oneorigin.test.mjs   (I2)
               MM_SRC_REV=c05d1ba3a node www/js/htid_oneorigin.test.mjs   (R)
   ============================================================ */
import { source } from './testlift.mjs';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const SYNC = source('sync.js'), PEER = source('peer.js'), STAMP = source('stamp.js'), POST = source('post.js');
const SELF = '00112233445566aa';
const T0 = 1761200000000;

// presence.rs constants.
const TTL_MS = 5 * 60 * 1000, G_MS = 10000, LEAVING_GRACE_MS = 2000;

/// presence.rs's book for one device: origins by `w`.
function makeBook(clock) {
	const origins = new Map();
	let ver = T0, key = 0;
	const o = (w) => {
		if (!origins.has(w)) origins.set(w, { open: [], left: [], held: false, closed_at: 0, leaving_at: null, posture: null });
		return origins.get(w);
	};
	// Origin::posture_gone (presence.rs:113-125).
	const gone = (x, now) => {
		const p = x.posture; if (!p) return false;
		const shut = x.open.length === 0;
		return (shut && x.held && x.closed_at > 0 && now >= x.closed_at + G_MS)
			|| (shut && x.leaving_at != null && p.stated_at <= x.leaving_at && now >= x.leaving_at + LEAVING_GRACE_MS)
			|| (!x.held && now - p.stated_at > TTL_MS);
	};
	// Origin::live_until (presence.rs:101-110).
	const liveUntil = (x) => {
		if (x.open.length) return Infinity;
		let end = x.closed_at > 0 ? x.closed_at + G_MS : 0;
		if (x.leaving_at != null) end = Math.min(end, x.leaving_at + LEAVING_GRACE_MS);
		return end;
	};
	const reconcile = (now) => { for (const x of origins.values()) if (gone(x, now)) x.posture = null; };
	/// Is origin `w`'s posture held at `now`? Read without dropping anything.
	const holds = (w, now) => { const x = origins.get(w); return !!(x && x.posture && !gone(x, now)); };
	return {
		origins, holds,
		bump() { ver = Math.max(clock.now(), ver + 1); return ver; },
		ver: () => ver,
		state(w, body) {			// Presence::state (presence.rs:625-649)
			const now = clock.now(); reconcile(now);
			const x = o(w);
			x.held = x.open.length > 0;
			x.posture = { stated_at: now, attended: !!body.attended, runner: !!body.runner, mobile: body.mobile,
				hand: body.hand, folder: body.folder, busy: body.busy | 0, busy_chats: body.busy_chats || [] };
		},
		leaving(w) {				// Presence::leaving (presence.rs:678-695)
			const now = clock.now(); reconcile(now);
			const x = o(w);
			if (x.open.length) { x.left.push(...x.open); x.open = []; x.closed_at = now; }
			x.leaving_at = now;
		},
		open(w) {					// Presence::door Open (presence.rs:718-723)
			const x = o(w); const k = ++key;
			x.leaving_at = null; x.held = true; x.open.push(k);
			return k;
		},
		close(w, k) {				// Presence::door Close (presence.rs:725-737)
			const now = clock.now(); const x = o(w);
			const i = x.open.indexOf(k);
			if (i >= 0) { x.open.splice(i, 1); if (!x.open.length) x.closed_at = now; }
			else { const j = x.left.indexOf(k); if (j >= 0) x.left.splice(j, 1); }
		},
		mine(w) { reconcile(clock.now()); const x = origins.get(w); return x && x.posture ? x.posture : null; },
		/// The device's merged row at `now`, as rows_of gives it.
		row(now) {
			reconcile(now);
			let stated = false, runner = false, listening = false, doors = 0;
			for (const x of origins.values()) {
				if (x.posture) { stated = true; runner = runner || x.posture.runner; }
				if (liveUntil(x) > now) listening = true;
				doors += x.open.length;
			}
			return { stated, runner, listening, doors };
		},
	};
}

/// A clock the test owns.
function makeClock() {
	let now = T0, seq = 0;
	const timers = new Map();
	const drain = () => new Promise((r) => setImmediate(r));
	const settle = async (n = 8) => { for (let i = 0; i < n; i++) await drain(); };
	return {
		now: () => now, settle,
		setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
		clearTimeout(id) { timers.delete(id); },
		async advance(ms) {
			const target = now + ms;
			for (let guard = 0; guard < 100000; guard++) {
				let pick = null;
				for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
				if (!pick) break;
				now = pick[1].at; timers.delete(pick[0]);
				try { pick[1].fn(); } catch (e) { /* as a browser would */ }
				await settle();
			}
			now = target;
			await settle();
		},
	};
}

/// One tab: the real sync.js, peer.js and post.js against the book.
function makeTab(opts) {
	opts = opts || {};
	const clock = opts.clock || makeClock();
	const book = opts.book || makeBook(clock);
	class FakeDate extends Date {
		constructor(...a) { if (a.length) super(...a); else super(clock.now()); }
		static now() { return clock.now(); }
	}
	const store = opts.store || new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
	};
	const winL = {}, docL = {};
	const on = (m) => (ev, fn) => { (m[ev] = m[ev] || []).push(fn); };
	const win = { addEventListener: on(winL), removeEventListener: () => {}, dispatchEvent: (ev) => {
		for (const fn of (winL[ev && ev.type] || [])) { try { fn(ev); } catch (e) { /* as a browser */ } }
		return true;
	} };
	win.location = { protocol: 'http:', host: 'htid.test', origin: 'http://htid.test', href: 'http://htid.test/' };
	win.localStorage = localStorage;
	// The tab's session: a reload's new page shares it; a duplicated tab gets a copy.
	if (opts.session) {
		const ss = opts.session;
		win.sessionStorage = {
			getItem: (k) => (ss.has(k) ? ss.get(k) : null),
			setItem: (k, v) => ss.set(k, String(v)), removeItem: (k) => ss.delete(k),
		};
	}
	const noEl = {
		addEventListener: () => {}, appendChild: (c) => c, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {}, children: [],
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} }, dataset: {},
	};
	const document = {
		readyState: 'complete', hidden: false, visibilityState: 'visible',
		addEventListener: on(docL),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	// `dead`: the page is gone (a reload unloaded it); its requests never reach the gateway.
	const tab = { win, document, winL, docL, clock, book, posts: [], parks: [], sockets: [], unlocked: true, dead: false };
	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked, deviceId: () => SELF, handle: () => '',
		publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
		wrap: async (s) => s, unwrap: async (s) => s,
		wrapBytesAad: async (b) => b, unwrapBytesAad: async (b) => b,
	};
	win.DaimondRunner = { KEY: 'daimond-runner-posture', on: () => true };
	const answer = (status, json) => ({ status, json: async () => json });
	const presAnswer = (w) => {
		const r = book.row(clock.now());
		const j = { ok: true, now: clock.now(), derived: true, ver: book.ver(), presence: {
			[SELF]: { name: 'argonaut', last_seen: clock.now(), attended: false, runner: r.runner,
				listening: r.listening, heard_at: clock.now(), doors: r.doors, stated: r.stated } } };
		const m = book.mine(w);
		if (m) j.mine = { attended: m.attended, runner: m.runner, mobile: m.mobile, hand: m.hand, folder: m.folder,
			busy: m.busy, busy_chats: m.busy_chats, stated: true };
		return j;
	};
	win.DaimondGateway = {
		clientApi: () => 9,
		state: () => ({ authed: true }),
		gwFetch: async (path, o) => {
			if (tab.dead) return new Promise(() => {});
			const u = new URL('http://x' + path);
			const q = u.searchParams;
			const method = (o && o.method) || 'GET';
			if (u.pathname === '/api/sync' && q.has('presence')) {
				if (method === 'GET') return answer(200, presAnswer(q.get('w') || ''));
				const body = JSON.parse(o.body);
				tab.posts.push({ body, at: clock.now(), keepalive: !!o.keepalive });
				if (body.leaving) book.leaving(String(body.w || '')); else book.state(String(body.w || ''), body);
				book.bump();
				return answer(200, presAnswer(String(body.w || '')));
			}
			if (u.pathname === '/api/post' && q.has('above')) {
				// The errand door (post.rs:740-756): a door under the park's `w`, held for `ms`.
				const w = q.get('w') || '', ms = Number(q.get('ms'));
				const k = book.open(w);
				const park = { w, ms, at: clock.now(), end: 0 };
				tab.parks.push(park);
				return new Promise((res, rej) => {
					let done = false;
					const end = (fn) => { if (done) return; done = true; park.end = clock.now(); book.close(w, k); fn(); };
					clock.setTimeout(() => end(() => res(answer(200, { ok: true, waited: true, changed: false, seq: 0 }))), ms);
					if (o && o.signal) o.signal.addEventListener('abort', () => end(() => rej(new Error('aborted'))));
				});
			}
			if (u.pathname === '/api/post' && q.has('since')) return answer(200, { ok: true, rows: [], more: false });
			if (u.pathname === '/api/post') return answer(200, { ok: true });
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
		// Digested on this thread: `subtle.digest` runs on libuv's pool, in real time, so
		// under load it could outlast the test's settling and a step be read early.
		sha256: async (s) => createHash('sha256').update(s).digest('hex'),
	};
	win.WebSocket = class {
		constructor(url) { this.url = url; this.readyState = 0; tab.sockets.push(this); }
		close() { if (this.readyState === 3) return; this.readyState = 3; if (this.onclose) this.onclose({}); }
		send() {}
	};
	class Ctl {
		constructor() { this.signal = { aborted: false, _on: [], addEventListener(k, fn) { this._on.push(fn); } }; }
		abort() { if (this.signal.aborted) return; this.signal.aborted = true; this.signal._on.forEach((f) => { try { f({}); } catch (e) { /* */ } }); }
	}
	win.AbortController = Ctl;
	win.DEBUG_SHARE = { event: () => {} };
	const quiet = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
	let nextId = 1;
	for (const body of [STAMP, PEER]) {
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent', 'Date',
			'with (window) {\n' + body + '\n}')(win, document, quiet, localStorage, { storage: {} }, function () {}, FakeDate);
	}
	// sync.js's own loops are not driven (as ht2presence): the test is its pulse and its socket.
	new Function('window', 'document', 'crypto', 'localStorage', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'Date',
		'with (window) {\n' + SYNC + '\n}')(win, document, webcrypto, localStorage, TextEncoder, TextDecoder,
		() => nextId++, () => {}, () => nextId++, () => {}, quiet, FakeDate);
	win.window = win;
	new Function('window', 'document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'Date', 'AbortController', 'console', 'with (window) {\n' + POST + '\n}')(win, document,
		clock.setTimeout, clock.clearTimeout, clock.setTimeout, clock.clearTimeout, FakeDate, Ctl, quiet);
	return tab;
}

const fire = (m, ev) => (m[ev] || []).forEach((f) => f({ persisted: false }));

/// daimond.js's posture args: a desktop runner tab, or a phone.
function posture(o) {
	o = o || {};
	return [SELF, 'argonaut-chrome', o.att !== undefined ? o.att : true, true, !!o.runner, !!o.mobile,
		true, true, 0, []];
}
/// daimond.js's one-second pulse, and the socket frame a moved version sends.
async function second(tab, args) {
	const S = tab.win.DaimondSync;
	const v0 = tab.book.ver();
	await tab.clock.advance(1000);
	if (S.postureDue(...args)) S.beatPresence(...args);
	await tab.clock.settle(30);
	const sock = tab.sockets[tab.sockets.length - 1];
	if (sock && tab.book.ver() > v0 && sock.onmessage) sock.onmessage({ data: 'r' + tab.book.ver() });
	await tab.clock.settle(30);
}
async function boot(tab) {
	const S = tab.win.DaimondSync;
	S.wakeVia('');
	await tab.clock.settle(30);
	const sock = tab.sockets[tab.sockets.length - 1];
	if (sock) { sock.readyState = 1; sock.onopen && sock.onopen({}); }
	await tab.clock.settle(30);
	tab.win.DaimondPost.parkStart();
	await tab.clock.settle(60);
}

console.log('htid one origin (real sync.js + peer.js + post.js'
	+ (process.env.MM_SRC_REV ? ', rev ' + process.env.MM_SRC_REV : '') + ')');

// ── I1, I2: a runner tab idle past the TTL ──
{
	const tab = makeTab();
	await boot(tab);
	const args = posture({ runner: true });
	for (let i = 0; i < 3; i++) await second(tab, args);
	const said = tab.posts.filter((p) => !p.body.leaving);
	const sw = said.length ? said[said.length - 1].body.w : '';
	const pw = [...new Set(tab.parks.map((p) => p.w))];
	check('I1. the park\'s w is the posture\'s w', said.length >= 1 && pw.length === 1 && pw[0] === sw,
		'posture w=' + sw + ' park w=' + pw.join());
	const statedAt = said.length ? said[said.length - 1].at : T0;
	let firstBad = null, bad = 0;
	const n0 = tab.posts.length;
	let atTtl = null, atTtl1 = null;
	for (let i = 0; i < 360; i++) {
		if (tab.clock.now() === statedAt + TTL_MS) {
			atTtl = tab.book.holds(sw, statedAt + TTL_MS);
			atTtl1 = tab.book.holds(sw, statedAt + TTL_MS + 1);
		}
		await second(tab, args);
		const r = tab.book.row(tab.clock.now());
		if (!(r.stated && r.runner && r.listening)) { bad++; if (firstBad == null) firstBad = { at: tab.clock.now(), r }; }
	}
	// Pin the instant: a probe at stated_at + TTL + 1 ms, from the book alone.
	const probe = (() => {
		const x = [...tab.book.origins.entries()].find(([w]) => w === sw);
		return x ? x[1] : null;
	})();
	check('I2a. its posture is still held at stated_at + 5 min + 1 ms', atTtl === true && atTtl1 === true,
		'at +5 min ' + atTtl + ', at +5 min +1 ms ' + atTtl1);
	check('I2. a runner tab idle 6 min, no posture change: stated, runner and listening at every second',
		bad === 0, bad === 0 ? 'held ' + tab.parks.length + ' parks, ' + (tab.posts.length - n0) + ' statement(s)'
			: bad + ' s bad; stated went false at stated_at + ' + (firstBad.at - statedAt) + ' ms '
				+ JSON.stringify(firstBad.r) + ', origin held=' + (probe && probe.held));
	tab.win.DaimondPost.parkStop();
}

// ── I3: the page's close is one `leaving`, and it ends doors and posture ──
{
	const tab = makeTab();
	await boot(tab);
	const args = posture({ runner: true });
	for (let i = 0; i < 3; i++) await second(tab, args);
	const n = tab.posts.length;
	fire(tab.winL, 'pagehide');
	await tab.clock.settle(30);
	const lv = tab.posts.slice(n).filter((p) => p.body.leaving);
	check('I3. pagehide: one leaving, under the tab\'s one origin', lv.length === 1
		&& lv[0].body.w === tab.win.DaimondSync.wake().id, lv.map((p) => p.body.w).join() || 'none');
	tab.win.DaimondPost.parkStop();
	const at = tab.clock.now();
	const r = tab.book.row(at + LEAVING_GRACE_MS);
	check('I3b. 2 s after it: not listening, no posture', !r.listening && !r.stated && !r.runner, JSON.stringify(r));
}

// ── F3: a phone going hidden leaves, and does not re-state while hidden ──
{
	const tab = makeTab();
	await boot(tab);
	const args = posture({ mobile: true, att: true });
	for (let i = 0; i < 3; i++) await second(tab, args);
	const n = tab.posts.length;
	tab.document.visibilityState = 'hidden'; tab.document.hidden = true;
	fire(tab.docL, 'visibilitychange');
	await tab.clock.settle(30);
	// Its JS still runs (Android), its posture unchanged: nothing is owed but a change.
	const hidArgs = args;
	for (let i = 0; i < 20; i++) await second(tab, hidArgs);
	const after = tab.posts.slice(n);
	const lv = after.filter((p) => p.body.leaving);
	const re = after.filter((p) => !p.body.leaving);
	check('F3. a phone going hidden: one leaving, under the tab\'s one origin',
		lv.length === 1 && lv[0].body.w === tab.win.DaimondSync.wake().id, lv.map((p) => p.body.w).join() || 'none');
	check('F3b. and no full re-statement undoing it while hidden', lv.length === 1 && re.length === 0,
		re.map((p) => '+' + (p.at - (lv[0] ? lv[0].at : 0)) + 'ms').join() || 'none');
	tab.document.visibilityState = 'visible'; tab.document.hidden = false;
	fire(tab.docL, 'visibilitychange');
	const m = tab.posts.length;
	await second(tab, posture({ mobile: true, att: true }));
	check('F3c. back in view: a full statement', tab.posts.slice(m).filter((p) => !p.body.leaving).length === 1,
		(tab.posts.length - m) + ' POST(s)');
	tab.win.DaimondPost.parkStop();
}

// ── R: a reload keeps the tab's id; a copied tab mints its own ──
{
	const clock = makeClock(), book = makeBook(clock), session = new Map(), store = new Map();
	const A = makeTab({ clock, book, session, store });
	await boot(A);
	const args = posture({ runner: true });
	for (let i = 0; i < 3; i++) await second(A, args);
	const aId = A.win.DaimondSync.wakeId();
	// The reload: the old page hides (its one `leaving`), is torn down, and is gone.
	fire(A.winL, 'pagehide');
	await clock.settle(30);
	A.win.DaimondPost.parkStop();
	await clock.settle(30);
	A.dead = true;
	const leftAt = clock.now();
	await clock.advance(200);
	// The new page: same tab session, parks at +200 ms, states only seconds later.
	const B = makeTab({ clock, book, session, store });
	await boot(B);
	const bId = B.win.DaimondSync.wakeId();
	check('R1. the reloaded page keeps the tab\'s id', bId === aId, 'old ' + aId + ' new ' + bId);
	let bad = 0, firstBad = null;
	while (clock.now() < leftAt + 3200) {
		await clock.advance(100);
		const r = book.row(clock.now());
		if (!(r.stated && r.runner && r.listening)) { bad++; if (!firstBad) firstBad = { at: clock.now() - leftAt, r }; }
	}
	check('R2. across the reload, before the new page states: stated, runner and listening at every 100 ms',
		bad === 0, bad === 0 ? 'held to leaving + ' + (clock.now() - leftAt) + ' ms'
			: bad + ' bad reads; first at leaving + ' + firstBad.at + ' ms ' + JSON.stringify(firstBad.r));
	await second(B, args);
	const r = book.row(clock.now());
	check('R2b. and after it states', r.stated && r.runner && r.listening, JSON.stringify(r));

	// A duplicated tab: its session is a copy taken while B runs, so the live mark is set.
	const C = makeTab({ clock, book, session: new Map(session), store });
	await boot(C);
	await second(C, args);
	await second(B, args);
	const cId = C.win.DaimondSync.wakeId();
	const held = [bId, cId].filter((w) => book.holds(w, clock.now()));
	check('R3. a duplicated tab mints its own id, and both are listed', cId !== bId && held.length === 2,
		'B ' + bId + ' C ' + cId + ', held ' + held.length);

	// bfcache: hide and show again (persisted) leaves the tab live, so a copy taken now is fresh.
	fire(B.winL, 'pagehide');
	(B.winL.pageshow || []).forEach((f) => f({ persisted: true }));
	await clock.settle(30);
	check('R4. a bfcache hide/show keeps the tab live', session.get('daimond-wake-live') === '1'
		&& session.get('daimond-wake-id') === bId, JSON.stringify([...session]));
	B.win.DaimondPost.parkStop(); C.win.DaimondPost.parkStop();
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
