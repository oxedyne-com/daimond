/* ============================================================
   Test -- no collect, reap or commit over a chat store whose read never
   landed, and no push while the last pull refused a section
   (COLLECT-GATE, UNBLOCK-111, 09 Nov 2026).
   ------------------------------------------------------------
   THE FAULT (live on t27c, notes/quality_x/live_collect_diag_20261108.md):
   the boot's chat read fails, the page unlocks on the legacy mirror, the
   first pull refuses the chats merge at the version adopted last session,
   and the next save's push passed every gate: collectChatsRefs reaped the
   `@c/` manifest of every chat it had not read, and the commit declared the
   reaped index, so the gateway swept their transcripts. The narrower route:
   a write that landed vouched for the unread store.

   The REAL ChatStore, storedChats, collectChatsRefs, mayCommitChunks and
   cloud.js, on an in-memory IndexedDB, and the REAL sync.js on the same
   window against a stub mailbox. `applySync` stands in for parcel_apply's
   merge by its one gate on this path: chats are refused while
   `ChatStore.read()` is false (parcel_apply.js `applyChats`).

     S. the store (QA's probe, qa_livecollect/probe.log): five chats, a boot
        read that throws once or answers empty, one save --
        S1 a healthy boot reads, and its collect drops nothing;
        S2 an unread store stays unread after a landed save: not vouched,
           the alarm stands, and the collect refuses and drops no `@c/`;
        S3 once the store answers (the save's re-read), it is read, and the
           collect names every chat and drops nothing.
     E. end to end (the diag's route 3a): the open fails once at boot, the
        mailbox holds nothing newer than the adopted version, he renames a
        chat --
        E1 the push holds: no collect, no POST, no commit, every `@c/` kept;
        E2 a flush stops at the refused round and collects nothing;
        E3 the store answers, is re-read, the re-read pulls once and the pull
           merges, and the next save pushes and commits an index that still
           names every chat.
     R. a read store whose refresh throws once after another tab saved c7:
        R2 the store is unread, the commit gate is closed, the collect
           refuses and `@c/c7` is kept.

   Run:  node www/js/collectgate.test.mjs
   Red replay: dev/red/collectgate/red_collectgate.sh
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, webcrypto } from 'node:crypto';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { fakeIdb } from './test/fakeidb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PEER = '0123456789abcdef0123456789abcdef';
const OLD = ['c1', 'c2', 'c3', 'c4', 'c5'];
const chat = (id, n) => ({ id, name: id, diamondId: '', updatedAt: n, metaAt: n,
	messages: [{ role: 'user', content: 'turn of ' + id, mid: 'm-' + id }] });

/// The real cloud.js on `win`, its index `ix` (box mode, no OPFS).
function cloudOn(win, ls, ix) {
	ls.setItem('daimond-cloud-index', JSON.stringify(ix));
	win.DaimondStore = { get: (k, d) => { const v = ls.getItem(k); return v === null ? d : JSON.parse(v); },
		set: (k, v) => (ls.setItem(k, JSON.stringify(v)), true), put: (k, v) => (ls.setItem(k, JSON.stringify(v)), true) };
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	class CE { constructor(type, o) { this.type = type; this.detail = o && o.detail; } }
	const w2 = { addEventListener: () => {}, dispatchEvent: () => true, DaimondStore: win.DaimondStore };
	new Function('window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console', 'CustomEvent',
		'with (window) {\n' + body + '\n}')(w2, ls, { storage: {} }, setTimeout, clearTimeout,
		{ log() {}, debug() {}, warn() {}, error() {} }, CE);
	return w2.DaimondCloud;
}

const index = () => {
	const ix = { 'docs/a.md': { size: 1, hash: 'h', chunks: [{ addr: 'd1', size: 1 }] } };
	OLD.forEach((id) => { ix['@c/' + id] = { v: 1, size: 10, key: 'k-' + id, chunks: [{ addr: 'a-' + id, size: 10 }] }; });
	ix['@c/c3.peer.' + PEER] = { v: 1, size: 10, chunks: [{ addr: 'p-c3', size: 10 }], peer: true, dev: PEER };
	return ix;
};
const cKeys = (cloud) => Object.keys(cloud.index()).filter((k) => k.startsWith('@c/')).sort();
const readOf = (cs) => (typeof cs.read === 'function' ? cs.read() : 'none');

/// A tab on `data`, sharing `ls`: the real page, its chat store faulted by `fx`.
function tab(data, ls, fx, cloud) {
	const w = makeWindow({ now: 1_800_000_000_000, ls });
	w.DaimondCloud = undefined; w.DaimondChunks = undefined;
	if (cloud) {
		w.DaimondCloud = cloudOn(w, ls, cloud);
		w.DaimondChunks = { offloadBytes: async (tag, bytes) => ({ v: 1, size: bytes.length, key: 'k-new', chunks: [{ addr: 'a-new-' + bytes.length, size: bytes.length }] }) };
	}
	w.indexedDB = fakeIdb(data, fx); w.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
	w.setTimeout = setTimeout; w.clearTimeout = clearTimeout;
	loadScript(w, 'trash.js');	// DaimondPolicy: storewait.js bounds each wait by its storeWaitMs
	// The store's bounded waits (PAGESTORE): every chat store request is raced against the policy's wait.
	w.DaimondPolicy = { ...(w.DaimondPolicy || {}), storeWaitMs: () => 2000, storePieceBytes: () => 32768, tombTtlMs: () => 37 * 86400e3 };
	loadScript(w, 'storewait.js');	// ChatStore opens through it, as index.html loads it before the page
	w.DaimondTime = { fmtLocal: () => '' };	// the re-read's re-render formats times
	const P = loadPage({ window: w, want: ['ChatStore', 'storedChats', 'collectChatsRefs', 'mayCommitChunks', 'offloadBlockedReason', 'pg'],
		stub: { noteCloudIndexStuck: () => {}, t: (k) => k, tOr: (k, d) => d,
			filesSyncable: () => true, indexWhole: () => true,
			storageAlarm: (why) => { w.alarms = (w.alarms || []).concat([String(why)]); },
			storageAlarmClear: () => { w.cleared = (w.cleared || 0) + 1; } } });
	return { w, P };
}

/// The store his healthy tab left: c1..c5 on disk and the watermark at 5.
async function seeded() {
	const data = new Map();
	const ls = makeWindow().localStorage;
	const A = tab(data, ls, { n: 0, open: 0 });
	await A.P.ChatStore.boot();
	A.P.ChatStore.save(OLD.map((id, i) => chat(id, i + 1)));
	await A.P.ChatStore.settled();
	await sleep(20);
	return { data, ls };
}

async function collect(P) {
	try { return { out: await P.collectChatsRefs(1 << 20) }; }
	catch (e) { return { refused: String(e && e.message) }; }
}

// ── S. the store ───────────────────────────────────────────────
async function storeCase(name, fx) {
	console.log('\nS. ' + name);
	const { data, ls } = await seeded();
	check('[seed] disk holds c1..c5', [...data.get('chats').keys()].sort().join() === OLD.join());
	const B = tab(data, ls, fx, index());
	const cs = B.P.ChatStore;
	const booted = await cs.boot();
	const before = cKeys(B.w.DaimondCloud);
	return { B, cs, booted, before };
}

{
	const { B, cs, booted, before } = await storeCase('S1 control: a healthy boot', { n: 0, open: 0 });
	check('S1. a healthy boot reads and vouches', readOf(cs) === true, 'read=' + readOf(cs));
	cs.save(booted.concat([chat('c-new', 99)]));
	await cs.settled(); await sleep(20);
	const r = await collect(B.P);
	check('S1. its collect names every chat', r.out && r.out.length === 6, r.out ? r.out.length + ' chats' : r.refused);
	check('S1. and drops no @c/ entry', cKeys(B.w.DaimondCloud).join() === before.join());
}

for (const [label, fx] of [['THROW: every read throws until the store answers', { mode: 'throw', n: 1e6, open: 0 }],
	['EMPTY: every read answers nothing against a watermark of 5 until the store answers', { mode: 'empty', n: 1e6, open: 0 }]]) {
	const { B, cs, booted, before } = await storeCase('S2/S3 ' + label, fx);
	check('S2. the boot is not read and not vouched', readOf(cs) === false,
		'read=' + readOf(cs));
	const cleared0 = B.w.cleared || 0;
	cs.save(booted.concat([chat('c-new', 99)]));
	await cs.settled();
	const mid = { read: readOf(cs), cleared: (B.w.cleared || 0) - cleared0 };
	const r = await collect(B.P);
	check('S2. a landed save does not vouch for the unread store', mid.read === false, JSON.stringify(mid));
	check('S2. nor clear its "not read" alarm', mid.cleared === 0, JSON.stringify(mid));
	check('S2. the collect refuses while the store is unread', !!r.refused, JSON.stringify(r).slice(0, 160));
	const dropped = before.filter((k) => !cKeys(B.w.DaimondCloud).includes(k));
	check('S2. AND NO @c/ ENTRY OF AN UNREAD CHAT IS DROPPED', dropped.length === 0, JSON.stringify(dropped));
	// The store answers; the next save that lands re-reads it.
	fx.n = 0;
	cs.save(B.P.storedChats().map((c) => (c.id === 'c-new' ? Object.assign({}, c, { name: 'renamed', metaAt: 100 }) : c)));
	await cs.settled();
	for (let i = 0; i < 50 && readOf(cs) !== true; i++) await sleep(10);
	check('S3. the store answered, so the save re-read it: read and vouched', readOf(cs) === true,
		'read=' + readOf(cs));
	check('S3. the mirror holds every chat again', B.P.storedChats().map((c) => c.id).sort().join() === OLD.concat(['c-new']).sort().join(),
		JSON.stringify(B.P.storedChats().map((c) => c.id)));
	const r2 = await collect(B.P);
	check('S3. the collect then names every chat', r2.out && r2.out.length === 6, r2.out ? r2.out.length + ' chats' : r2.refused);
	check('S3. and drops no @c/ entry', before.every((k) => cKeys(B.w.DaimondCloud).includes(k)));
}

// ── E. end to end: the open fails once at boot, then a rename ──────────────
/// The real sync.js on the page's window `w`, its timers on a virtual clock, against a
/// mailbox at `v` that holds a parcel this device adopted last session.
function syncOn(w, P, v) {
	const S = { gets: 0, posts: [], commits: [], collects: 0, timers: [], vnow: 0,
		mailbox: { version: v, blob: 'sealed:' + JSON.stringify({ v: 3, chats: [], note: 'phone v' + v }) } };
	w.localStorage.setItem('daimond-sync-version', String(v));
	w.DaimondIdentity = { isUnlocked: () => true, wrap: async (p) => 'sealed:' + p,
		unwrap: async (b) => String(b).slice('sealed:'.length), handle: () => '', deviceId: () => '00112233445566aa' };
	const answer = (status, json) => ({ status, json: async () => json });
	w.DaimondGateway = { clientApi: () => 1, state: () => ({ authed: true }),
		gwFetch: async (path, opts) => {
			const q = new URL('http://x' + path).searchParams;
			if (q.has('above')) return new Promise(() => {});
			if (q.has('presence') || q.has('lease') || q.has('progress')) return answer(200, { ok: true });
			if (!opts || opts.method === 'GET') { S.gets++; return answer(200, { present: true, version: S.mailbox.version, blob: S.mailbox.blob, device: 'Phone' }); }
			const body = JSON.parse(opts.body);
			if ((body.base_version | 0) !== S.mailbox.version) { S.posts.push({ ok: false }); return answer(409, { ok: false, version: S.mailbox.version }); }
			S.posts.push({ ok: true });
			S.mailbox = { version: S.mailbox.version + 1, blob: body.blob };
			return answer(200, { ok: true, version: S.mailbox.version });
		} };
	w.DaimondCore = {
		// parcel_apply's applyChats gate, the one this route turns on.
		applySync: async () => (P.ChatStore.read() ? {} : { failed: ['chats'] }),
		collectSync: async () => {
			S.collects++;
			const chats = await P.collectChatsRefs(1 << 20);
			return { v: 3, chats, chunked: w.DaimondCloud.index() };
		},
		syncSelfDeviceId: () => '00112233445566aa', busy: () => false, deviceSelfName: () => 'Phone',
		syncMayCommitChunks: () => P.mayCommitChunks(), syncCommitBlockedReason: () => '',
	};
	w.DaimondChunks.commit = async (live) => { S.commits.push(Object.keys(live || {}).filter((k) => k.startsWith('@c/')).sort()); return true; };
	w.DaimondCloud.sha256 = async (s) => createHash('sha256').update(s).digest('hex');
	const body = readFileSync(join(HERE, 'sync.js'), 'utf8');
	let id = 1;
	new Function('window', 'document', 'crypto', 'localStorage', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console',
		'with (window) {\n' + body + '\n}')(w, w.document, webcrypto, w.localStorage, TextEncoder, TextDecoder,
		(f, ms) => { const i = id++; S.timers.push({ id: i, f, due: S.vnow + (ms | 0) }); return i; },
		(i) => { S.timers = S.timers.filter((t) => t.id !== i); }, () => 0, () => {},
		{ log() {}, debug() {}, info() {}, warn() {}, error() {} });
	return S;
}

{
	console.log('\nE. end to end: the open fails once at boot, nothing new in the mailbox, a rename');
	const { data, ls } = await seeded();
	const fx = { mode: 'throw', n: 1e6, open: 1 };	// the open fails at boot; no read lands until it answers
	const B = tab(data, ls, fx, index());
	const cs = B.P.ChatStore;
	const booted = await cs.boot();
	B.P.pg.chats = booted;
	const before = cKeys(B.w.DaimondCloud);
	const S = syncOn(B.w, B.P, 4);
	const DS = B.w.DaimondSync;
	check('E0. the boot read failed: the store is unread, the page on the legacy mirror', readOf(cs) !== true && booted.length === 0,
		'read=' + readOf(cs) + ' mirror=' + booted.length);
	await DS.pull();
	check('E0. the first pull refused the chats merge at the adopted version', DS.version() === 4 && S.gets >= 1);
	// Only the page calls DaimondSync.pull from here (push pulls through its own closure),
	// so every call counted is the re-read's.
	const rereadPulls = [];
	let onPull = null;
	const pulled = new Promise((res) => { onPull = res; });
	{ const op = DS.pull; DS.pull = function () { rereadPulls.push(readOf(cs)); const p = op.apply(this, arguments); onPull({ p }); return p; }; }
	// He renames a chat: a save that lands, then the push it schedules.
	cs.save(booted.concat([chat('c-new', 99)]));
	await cs.settled();
	const r = await DS.push().catch((e) => ({ threw: String(e) }));
	await sleep(5);
	check('E1. the push holds over the refused merge', !!(r && r.held), JSON.stringify(r));
	check('E1. it collects nothing and sends nothing', S.collects === 0 && S.posts.length === 0,
		'collects=' + S.collects + ' posts=' + S.posts.length);
	check('E1. NO COMMIT of the chats index', S.commits.length === 0, JSON.stringify(S.commits));
	check('E1. AND NO @c/ ENTRY IS DROPPED', before.every((k) => cKeys(B.w.DaimondCloud).includes(k)),
		JSON.stringify(before.filter((k) => !cKeys(B.w.DaimondCloud).includes(k))));
	const c0 = S.collects;
	const f = DS.flush ? await DS.flush().catch((e) => ({ threw: String(e) })) : null;
	check('E2. a flush stops at the refused round and collects nothing', f && f.ok === false && S.collects === c0,
		JSON.stringify(f) + ' collects=' + (S.collects - c0));
	// The store answers; his next save lands, re-reads it and pulls, and the merge goes
	// through. The page's own timers (the re-pull's backoff) never fire here, so only that
	// pull can.
	fx.n = 0;
	cs.save(B.P.storedChats().map((c) => (c.id === 'c-new' ? Object.assign({}, c, { name: 'renamed', metaAt: 100 }) : c)));
	await cs.settled();
	// The re-read's own pull, awaited; the deadline is reached only when no pull starts (a fault), never by load.
	let dl = null;
	const got = await Promise.race([pulled, new Promise((r) => { dl = setTimeout(() => r(null), 10000); })]);
	clearTimeout(dl);
	if (got) await got.p.catch(() => null);
	check('E3. the store answered: read, vouched, every chat back', readOf(cs) === true
		&& B.P.storedChats().length === 6, 'read=' + readOf(cs) + ' chats=' + B.P.storedChats().length);
	check('E3. the store, read again, pulled once', rereadPulls.length === 1 && rereadPulls[0] === true, JSON.stringify(rereadPulls));
	check('E3. the pull merged: nothing refused', !(DS.state().failedParts || []).length, JSON.stringify(DS.state().failedParts));
	cs.save(B.P.storedChats().map((c) => (c.id === 'c2' ? Object.assign({}, c, { name: 'renamed', metaAt: 200 }) : c)));
	await cs.settled();
	await DS.push().catch(() => null);
	for (let i = 0; i < 100 && !S.posts.some((p) => p.ok); i++) await sleep(10);
	check('E3. the next save syncs normally: collected, pushed and committed', S.collects > c0 && S.posts.some((p) => p.ok) && S.commits.length >= 1,
		'collects=' + S.collects + ' posts=' + JSON.stringify(S.posts) + ' commits=' + S.commits.length);
	const last = S.commits[S.commits.length - 1] || [];
	check('E3. and the committed index still names every chat', OLD.every((id) => last.includes('@c/' + id)), JSON.stringify(last));
}

{
	console.log('\nR. a read store whose refresh throws once, after another tab saved c7');
	const { data, ls } = await seeded();
	const fx = { mode: 'throw', n: 0, open: 0 };
	const ix = index();
	ix['@c/c7'] = { v: 1, size: 10, key: 'k-c7', chunks: [{ addr: 'a-c7', size: 10 }] };
	const B = tab(data, ls, fx, ix);
	const cs = B.P.ChatStore;
	await cs.boot();
	const A = tab(data, ls, { n: 0, open: 0 });
	await A.P.ChatStore.boot();
	A.P.ChatStore.save(OLD.map((id, i) => chat(id, i + 1)).concat([chat('c7', 50)]));
	await A.P.ChatStore.settled();
	await sleep(20);
	fx.n = 1;
	await cs.refresh();
	const before = cKeys(B.w.DaimondCloud);
	check('R2. the failed refresh leaves the store unread', readOf(cs) === false,
		'read=' + readOf(cs));
	check('R2. and closes the commit gate', B.P.mayCommitChunks() === false && B.P.offloadBlockedReason() === 'chats-unread',
		String(B.P.offloadBlockedReason()));
	const r = await collect(B.P);
	check('R2. the collect refuses', !!r.refused, r.refused ? '' : r.out.length + ' chats');
	check('R2. AND @c/c7 IS NOT DROPPED', before.includes('@c/c7') && cKeys(B.w.DaimondCloud).includes('@c/c7'),
		JSON.stringify(cKeys(B.w.DaimondCloud)));
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
