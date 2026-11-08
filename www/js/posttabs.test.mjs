/* ============================================================
   Test -- a mailbox-locked section saves the record it folded into
   (www/js/post.js `withMailboxLock`, `save`, the `storage` handler;
   SIM-1, 2026-09-25).
   ------------------------------------------------------------
   The mailbox lock serialises collects across the tabs of a device,
   but the previous holder's write reaches this tab as a `storage`
   event a task later -- mid-collect, if this tab took the lock at
   once. The handler replaced the cached record with a fresh read,
   `collect` went on folding into the record it had read at its
   start, and `save()` wrote the cached one: the fold was lost, the
   next pass folded the same rows again, and their side effects ran
   twice (the simulator's relay r0: a consent grant posted twice).

     T1  a sibling tab's `storage` event arriving mid-collect: every
         row is folded once over two passes (release 4: twice), and the
         record on disk holds the fold (`seen`);
     T2  a sibling tab that wrote before this tab took the lock, whose
         event has not arrived: the section reads the disk at its door,
         so the sibling's write is kept, not overwritten.

   A Kimberlite report settles the turn in the tab that holds it (PD2-TABS,
   UNBLOCK-108, 08 Nov). Three tabs of one device (one localStorage, one
   device id, one BroadcastChannel bus) and a runner, over one relay; the
   REAL identity.js, post.js and peer.js, and the page's own onReport and
   session settle lifted from daimond.js:

     T3  tab A sends turn T, tab B collects T's report: A leaves `running`
         at once, and B, holding nothing, settles nothing of its own;
     T4  the holding tab is closed: B, which collects it, loads the turn's
         chat and the report's session lands in the store;
     T5  two tabs hold T: each settles it once, and none twice.

   The REAL post.js on a clock the test owns (ackspin.test.mjs's
   harness), with one localStorage the "sibling" writes into.

     node www/js/posttabs.test.mjs
     POST_JS=<release/r4>/www/js/post.js node www/js/posttabs.test.mjs   # T1, T2 fail
     dev/red/pd2tabs/red_pd2tabs.sh     # without the hand-on, T3-T5 fail
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { loadSeal, installSeal } from './sealfixture.mjs';
await loadSeal();

const HERE    = dirname(fileURLToPath(import.meta.url));
const POST_JS = process.env.POST_JS || join(HERE, 'post.js');
const LS      = 'daimond-post';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 20) { for (let i = 0; i < n; i++) await drain(); }

/// One tab of a device: the real post.js over a box of `rows`, one localStorage, and a
/// hook run while the collect's read is in flight (`onCollect`).
function makeTab(rows, onCollect) {
	const local = new Map();
	const listeners = {};
	const folds = {};
	let collects = 0;
	const answer = (s, j) => Promise.resolve({ status: s, headers: { get: () => '' }, json: () => Promise.resolve(j) });
	const gwFetch = async (url, o) => {
		const p = new URLSearchParams(String(url).split('?')[1] || '');
		if (p.has('since')) {
			collects++;
			if (onCollect) await onCollect(collects);
			const since = Number(p.get('since'));
			return answer(200, { ok: true, seq: rows.length, rows: rows.filter((r) => r.seq > since), more: false });
		}
		if (p.get('op') === 'ack') return answer(200, { ok: true, dropped: 0 });
		return answer(200, { ok: true });
	};
	const document = { readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {}, setAttribute() {},
			appendChild(c) { return c; }, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
	const win = {
		addEventListener(type, f) { (listeners[type] = listeners[type] || []).push(f); },
		dispatchEvent: () => true, Date: { now: () => 1757000000000 },
		location: { origin: 'https://example.test', href: 'https://example.test/' }, navigator: { onLine: true },
		localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)),
			removeItem: (k) => local.delete(k) },
		DaimondIdentity: { isUnlocked: () => true, deviceId: () => 'dev-self', publicKeyB64url: () => 'pub-self',
			sealingKeyRaw: () => null, wrap: async (s) => s, unwrap: async (s) => s },
		DaimondGateway: { clientApi: () => 9, gwFetch },
		// Every row is a peer envelope this stub will not open; the fold is counted here.
		DaimondPeer: { peek: async (x) => {
			const k = typeof x === 'string' ? x : String((x && (x.addr || x.envelope)) || '?');
			folds[k] = (folds[k] | 0) + 1;
			return null;
		} },
	};
	win.window = win;
	installSeal(win);	// the wasm seal post.js opens through (S1 SEAL)
	const fn = new Function('window', 'document', 'with (window) {\n' + readFileSync(POST_JS, 'utf8') + '\n}');
	fn(win, document);
	return {
		win, local, folds, P: () => win.DaimondPost,
		/// A sibling tab of this device wrote the record: storage now holds `raw`, and the
		/// `storage` event is delivered here.
		siblingWrote(raw) {
			if (raw !== undefined) local.set(LS, raw);
			(listeners.storage || []).forEach((f) => f({ key: LS }));
		},
		disk: () => { try { return JSON.parse(local.get(LS) || 'null'); } catch (e) { return null; } },
	};
}
const rows3 = () => [1, 2, 3].map((s) => ({ seq: s, kind: 'post', addr: 'a' + s, envelope: 'e' + s, ts: 1757000000 }));

// ── T1 ─────────────────────────────────────────────────────────
{
	console.log('\nT1: a sibling tab\'s storage event arrives in the middle of a collect\n');
	let tab = null;
	tab = makeTab(rows3(), async (n) => {
		// The previous lock holder's write, heard a task later: the same record, re-saved.
		if (n === 1) tab.siblingWrote(tab.local.get(LS));
	});
	await tab.P().read();
	await tab.P().collect(); await settle();
	const d1 = tab.disk();
	await tab.P().collect(); await settle();
	const twice = Object.keys(tab.folds).filter((a) => tab.folds[a] > 1);
	check('T1. every row is folded once over two passes (release 4: each twice)', twice.length === 0
		&& Object.keys(tab.folds).length === 3, JSON.stringify(tab.folds));
	check('T1. and the record on disk holds the first pass\'s fold', !!d1 && d1.seen === 3,
		'seen on disk ' + (d1 && d1.seen));
}

// ── T2 ─────────────────────────────────────────────────────────
{
	console.log('\nT2: a sibling tab wrote before this tab took the lock, and its event has not arrived\n');
	const tab = makeTab(rows3().slice(0, 2), null);
	const st = await tab.P().read();						// this tab's cached copy, seen 0
	// The sibling folded rows 1 and 2 and marked a message read, and let the lock go;
	// its storage event is still in flight when this tab collects.
	const theirs = JSON.parse(JSON.stringify(st));
	theirs.seen = 2; theirs.through = 2; theirs.acked = 2;
	theirs.msgs = { m1: { addr: 'm1', dir: 'in', from: 'x', body: 'hi', ts: 1, read: 1, tray: 0 } };
	tab.local.set(LS, JSON.stringify(theirs));
	await tab.P().collect(); await settle();
	const d = tab.disk();
	check('T2. the sibling\'s write is kept, not overwritten from the stale cache (release 4: lost)',
		!!d && !!d.msgs && !!d.msgs.m1 && d.seen === 2, JSON.stringify({ seen: d && d.seen, msgs: d && Object.keys(d.msgs || {}) }));
	check('T2. and the rows it folded are not folded again here', Object.keys(tab.folds).length === 0,
		JSON.stringify(tab.folds));
}

// ── T3-T5: a report reaches the tab that holds its turn ────────
const until = async (cond, ms = 10000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (cond()) return true; await new Promise((r) => setTimeout(r, 5)); }
	return !!cond();
};
function balanced(src, open) {
	let depth = 0, i = open;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
	}
	return i;
}
const PAGE = readPage(join(HERE, 'daimond.js'), 'utf8');
function lift(name) {
	const m = new RegExp('\\n\\t(async )?function ' + name + '\\(').exec(PAGE);
	return m ? PAGE.slice(m.index + 1, balanced(PAGE, PAGE.indexOf('{', m.index))) : '';
}
function reportHandler() {
	const at = PAGE.indexOf('DaimondPeer.onReport(');
	const open = PAGE.indexOf('function', at);
	return at < 0 ? 'null' : '(' + PAGE.slice(PAGE.lastIndexOf('async', open), balanced(PAGE, PAGE.indexOf('{', open))) + ')';
}
const SETTLE = ['chatHoldingTurn', 'chatHoldsTurn', 'chatHoldingReport', 'fetchRunnerSession', 'settleRunnerSession', 'sessionGate', 'sessionUpto', 'dropSessionStayed', 'staleEngine',
	'captureSession', 'sessionHeld', 'keepChatTaint'].map(lift).join('\n');

/// The browser's BroadcastChannel over one bus: a message reaches every OTHER open channel
/// of its name, a task later, as a structured clone.
function makeBus() {
	const open = [];
	return class {
		constructor(name) { this.name = name; this.onmessage = null; open.push(this); }
		postMessage(d) {
			const copy = structuredClone(d);
			open.filter((c) => c !== this && c.name === this.name)
				.forEach((c) => setImmediate(() => { if (c.onmessage) c.onmessage({ data: copy }); }));
		}
		close() { const i = open.indexOf(this); if (i >= 0) open.splice(i, 1); }
	};
}

function makeRelay() {
	let seq = 0;
	const relay = { rows: [] };
	relay.put = (b) => { seq++; relay.rows.push({ seq, kind: 'post', to: b.to, addr: b.addr, envelope: b.envelope, ts: Math.floor(Date.now() / 1000) }); };
	return relay;
}

/// One page load: the real identity.js, post.js and peer.js over `local` (shared by the tabs
/// of one device), and, on a device tab, the page's onReport over its own memory.
function makeWin(relay, local, BC) {
	const localStorage = { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)),
		removeItem: (k) => local.delete(k) };
	const noEl = { addEventListener() {}, appendChild() {}, setAttribute() {}, querySelector: () => null,
		querySelectorAll: () => [], remove() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } };
	const document = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null, createElement: () => Object.assign({}, noEl), body: noEl };
	const on = {};
	const win = { BroadcastChannel: BC, matchMedia: () => ({ matches: false, addListener() {}, addEventListener() {} }),
		addEventListener: (n, f) => { (on[n] = on[n] || []).push(f); },
		dispatchEvent: (ev) => { (on[ev.type] || []).slice().forEach((f) => f(ev)); return true; } };
	const ok = (json) => ({ status: 200, json: async () => json });
	win.DaimondGateway = { clientApi: () => 1, gwFetch: async (path, o) => {
		const q = new URLSearchParams(String(path).split('?')[1] || '');
		if (q.get('op') === 'ack') {
			const through = JSON.parse(o.body).through | 0;
			relay.rows = relay.rows.filter((r) => r.seq > through);
			return ok({ ok: true, dropped: 0 });
		}
		if (o && o.method === 'POST') { relay.put(JSON.parse(o.body)); return ok({ ok: true }); }
		if (q.has('since')) return ok({ ok: true, rows: relay.rows.filter((r) => r.seq > Number(q.get('since'))), more: false });
		if (q.has('above')) return new Promise(() => {});
		return ok({ ok: true });
	} };
	const btoa = (x) => Buffer.from(x, 'binary').toString('base64');
	const atob = (x) => Buffer.from(x, 'base64').toString('binary');
	const load = (rel, extra) => new Function('window', 'document', 'crypto', 'localStorage', 'btoa', 'atob',
		'TextEncoder', 'TextDecoder', 'setInterval', 'clearInterval', 'console', 'with (window) {\n'
		+ readFileSync(join(HERE, rel), 'utf8') + (extra || '') + '\n}')(win, document, webcrypto, localStorage, btoa, atob,
		TextEncoder, TextDecoder, () => 0, () => {}, { log() {}, debug() {}, warn() {}, error: console.error });
	load('store.js');
	load('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
	load('curvefallback.js');
	load('identity.js');
	installSeal(win);
	load('post.js');
	load('peer.js');
	win.DaimondPresence.ingest({}, Date.now());
	return win;
}

const T_SID = 'T1', CID = 'c1';
const RUN = [{ role: 'user', content: 'q0', mid: 'u0' }, { role: 'assistant', content: 'a0' },
	{ role: 'user', content: 'ask', mid: T_SID }, { role: 'assistant', content: 'answer' }];

/// A device tab: its own chats in memory (`held`: the turn's chat resident, its placeholder
/// indexed), the page's onReport, and a count of what it settled.
function deviceTab(win, disk, held) {
	const P = win.DaimondPeer;
	const fromDisk = () => JSON.parse(JSON.stringify(disk.get(CID)));
	const chat = Object.assign({ id: CID, _loaded: !!held }, held ? fromDisk() : { messages: [] });
	const t = { win, P, chat, heard: 0, booked: 0, diags: [], pg: { chats: [chat] }, peerReports: {} };
	const stubs = {
		window: win, DaimondPeer: P, DaimondPresence: win.DaimondPresence, pg: t.pg, chats: t.pg.chats, peerReports: t.peerReports, _openAsk: {}, _handBack: {}, _handBackCause: {},
		diag: (g, d) => t.diags.push(g + ' ' + d),
		dispatchedChat: (tid) => (held && tid === T_SID ? chat : null),
		loadChatMessages: async (c) => { Object.assign(c, fromDisk()); c._loaded = true; return c; },
		touchChat() {}, persistChats() { disk.set(CID, JSON.parse(JSON.stringify({ messages: chat.messages, session: chat.session }))); },
		markChatTainted: () => false, loadMsgTombs: () => ({}), Wasm: { words_file: async () => '' },
		otherErrandReport: () => false, refuseAbiTurn() {}, takeReportTaint() {},
		settleRunnerWords: async () => true, settleRunnerAlerts: async () => 0, settleRunnerAsk: async () => false,
		recordCarriedTurn() {}, bookReportCost: () => { t.booked++; return 1; }, requeueUnheard: () => 0,
		drainAfterHeld() {}, noteHandBack() {}, reclaimHandBack: async () => {}, runDispatchFallback() {},
		markPlaceholderParked() {}, updateExpedite() {}, renderDispatchedBadges() {},
	};
	const onReport = new Function('stubs', 'with (stubs) {\n' + SETTLE + '\nreturn ' + reportHandler() + ';\n}')(stubs);
	t.handler = async (r, row, from) => { t.heard++; await onReport(r, row, from); };
	P.onReport(t.handler);
	/// The footer state of T's placeholder here, read as the page reads it: the runner's lease
	/// says the run finished, its end not yet folded into the log.
	t.ui = () => P.uiState({ why: 'dispatched', iturn: T_SID }, { mode: 'done', holder: 'runner' },
		t.peerReports[T_SID] || null, win.DaimondIdentity.deviceId(), Date.now(), null, false, null);
	return t;
}

/// A device of `n` tabs and a runner over one relay; `holds[i]` says whether tab i holds T.
async function device(holds) {
	const relay = makeRelay(), local = new Map(), BC = makeBus();
	const disk = new Map([[CID, { messages: RUN.slice(0, 3), session: { v: 1, upto: 'a0', msgs: RUN.slice(0, 2) } }]]);
	const PASS = 'correct horse battery staple frigate';
	const wins = holds.map(() => makeWin(relay, local, BC));
	await wins[0].DaimondIdentity.create('Desk', PASS);
	for (const w of wins.slice(1)) await w.DaimondIdentity.unlock(PASS);
	const runner = makeWin(relay, new Map(), makeBus());
	runner.DaimondIdentity.importBundle(wins[0].DaimondIdentity.exportBundle());
	await runner.DaimondIdentity.unlock(PASS);
	const tabs = wins.map((w, i) => deviceTab(w, disk, holds[i]));
	const rep = runner.DaimondPeer.makeReport({ eid: 'e1', to: wins[0].DaimondIdentity.deviceId(), turnId: T_SID,
		chatId: CID, status: 'done', session: { v: 1, msgs: RUN, base: 'a0', upto: 'e-T1', uptoTs: Date.now() } });
	await runner.DaimondPost.post(await runner.DaimondPeer.sealForSelf(rep));
	return { relay, disk, tabs, wins, runner, PASS };
}

{
	console.log('\nT3: tab A sends turn T, tab B collects its report\n');
	const d = await device([true, false]);
	const [A, B] = d.tabs;
	check('T3. the tabs are one device', A.win.DaimondIdentity.deviceId() === B.win.DaimondIdentity.deviceId());
	check('T3. before the report A shows T running', A.ui() === 'running', A.ui());
	await B.win.DaimondPost.round();
	await until(() => B.heard > 0 && d.relay.rows.length === 0, 5000);
	check('T3. B collected the report and acked it off the relay', B.heard === 1 && d.relay.rows.length === 0,
		'B heard ' + B.heard + ', relay rows ' + d.relay.rows.length);
	const left = await until(() => A.ui() !== 'running', 1000);
	check('T3. A leaves running within one beat (base: A never hears it)', left && A.ui() === 'done', A.ui());
	check('T3. the diag names the tab that collected it', A.diags.some((x) => x.includes('from=' + B.P.tabId()))
		&& B.diags.some((x) => x.includes('tab=' + B.P.tabId() + ' collected')), JSON.stringify(A.diags.concat(B.diags)));
}

{
	console.log('\nT4: the holding tab is closed; the collector settles into the store\n');
	const d = await device([true, false]);
	const [A, B] = d.tabs;
	A.win.DaimondPeer.onReport(null);				// A is closed: its channel hears nothing
	await B.win.DaimondPost.round();
	await until(() => B.heard > 0 && d.relay.rows.length === 0, 5000);
	await until(() => (d.disk.get(CID).session || {}).upto === 'e-T1', 1000);
	check('T4. B, which did not hold the chat, loaded it and stored the report\'s session (base: lost)',
		(d.disk.get(CID).session || {}).upto === 'e-T1', JSON.stringify(d.disk.get(CID).session && d.disk.get(CID).session.upto));
	check('T4. the report was booked once, by B', B.booked === 1 && A.booked === 0, 'A ' + A.booked + ' B ' + B.booked);
}

{
	console.log('\nT5: two tabs hold T, a third collects, a fourth only hears\n');
	const d = await device([true, true, false, false]);
	const [A, C, B, D] = d.tabs;
	await B.win.DaimondPost.round();
	await until(() => A.ui() === 'done' && C.ui() === 'done', 2000);
	await settle(40);
	check('T5. both holding tabs leave running (base: neither)', A.ui() === 'done' && C.ui() === 'done', A.ui() + ' ' + C.ui());
	check('T5. each tab heard the report once, none twice', A.heard === 1 && C.heard === 1 && B.heard === 1 && D.heard === 1,
		[A.heard, C.heard, B.heard, D.heard].join(' '));
	check('T5. the tab that neither holds nor collects settles nothing (it loads no chat, books nothing)',
		!D.chat._loaded && D.booked === 0 && !D.diags.some((x) => x.startsWith('handoff report turn=')),
		'loaded ' + D.chat._loaded + ', booked ' + D.booked + ', ' + JSON.stringify(D.diags));
	check('T5. the session is in the store once, at the report\'s', (d.disk.get(CID).session || {}).upto === 'e-T1'
		&& d.disk.get(CID).session.msgs.length === RUN.length, JSON.stringify(d.disk.get(CID).session));
}

{
	console.log('\nT6: tab A holds T and locks; B collects\n');
	const d = await device([true, false]);
	const [A, B] = d.tabs;
	A.win.DaimondIdentity.lock();
	await B.win.DaimondPost.round();
	await until(() => B.heard > 0 && d.relay.rows.length === 0, 5000);
	await settle(40);
	check('T6. the locked tab hears nothing and settles nothing (it closed the channel)',
		B.heard === 1 && A.heard === 0 && A.booked === 0 && A.ui() === 'running',
		'A heard ' + A.heard + ', booked ' + A.booked + ', ui ' + A.ui() + '; B heard ' + B.heard);
	await A.win.DaimondIdentity.unlock(d.PASS);
	A.P.onReport(A.handler);					// the page registers again on unlock
	const rep = d.runner.DaimondPeer.makeReport({ eid: 'e2', to: A.win.DaimondIdentity.deviceId(), turnId: T_SID,
		chatId: CID, status: 'done', session: { v: 1, msgs: RUN, base: 'a0', upto: 'e-T1', uptoTs: Date.now() } });
	await d.runner.DaimondPost.post(await d.runner.DaimondPeer.sealForSelf(rep));
	await B.win.DaimondPost.round();
	await until(() => A.heard > 0, 2000);
	check('T6. unlocked again, A hears the next report handed on', A.heard === 1 && A.ui() === 'done',
		'A heard ' + A.heard + ', ui ' + A.ui());
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
