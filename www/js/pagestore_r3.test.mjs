/* ============================================================
   Test — PAGESTORE r3: one store wait (storewait.js) for ChatStore and durable.js.
   ------------------------------------------------------------
   H1     durable.js's open and transactions come back within the wait when the store
          stops answering, so the cloud index never holds a sync for ever.
   H1 request  a request watch() hands out is a promise that fails with the store's silence.
   H4     what is bounded is the store's silence: a write of many pieces, each answering
          inside the wait but together far over it, is not called stalled.
   H5     the piece size has a floor from the policy, so a served size of one byte
          cannot cut a value into one row per character.
   H6     every ChatStore transaction is opened by storewait.js (the caller of each, as the
          page runs), whose stores answer each request as a bounded promise, never a raw
          request; and a save over a store that stops anywhere comes back within the wait.
   H1 gate  so is every durable.js transaction, and the connection storewait.js hands out
          holds nothing that reaches a transaction, so no spelling can open one.
   F1     a read that outruns the wait is not an empty store: the boot neither calls the
          index whole nor durable until a read of it lands, and the next refresh reads it.
   drop   once a connection has opened in this page, a reopen that does not answer is not
          the box: a read rejects and a write stays queued, so the index is never called
          whole or durable on what the box holds, and the write lands when the store answers.
   F2     a readwrite transaction whose work fails lands none of it: an update that throws
          part way, and a walk whose callback throws, abort the transaction.
   firstref  a device whose store has taken over keeps the box out of it in a page whose
          FIRST open is refused (silent, an error, an older tab): a marker kept at the first
          connection says so, and a device from before the marker is known by the refusal
          or the browser's list of stores, or, with no list, by an open that errors. A device
          whose store never opened, or a browser refusing IndexedDB outright, keeps the box.
   nolandmig  the box's index is dropped only on the store's record of its move, written in
          the move's own transaction: a move that did not land leaves the index neither whole
          nor durable, a write landed meanwhile does not make it so, and the next boot lays the
          box under the store. An update with no ops writes nothing (QA r6 F4). An index write
          waits for the move: until it lands the write stays owed and the alarm up, so the store
          never holds part of the index (QA r7 F7). Where an older build moved it, the store's
          entry wins on a shared path, and a box value that is not a map is dropped (QA r7 F8).
   rollback  an older build, which drops the box once the store holds an index, finds the whole one.
   delunmoved  a path deleted while the move had not landed stays deleted.
   quiet  a page whose move fails and that writes nothing raises the alarm, and clears it once
          the move lands and the index is read (QA r8 F9).
   twotabs  a tab whose owed write lands after a sibling moved and wrote takes the sibling's
          write from the stored map, with no channel to hear it on (QA r8 G1).
   scalar  a box index that is not a map never seeds the mirror (QA r8 O1).
   unread  a pulled index is not merged over a mirror whose read never landed (a refused open,
          reads that aborted): the merge and the parcel's chunked section refuse, the section
          stays owed, and this device's own newer manifest survives (QA r6 F5).
   F4     an open that answers after its wait or its refusal is closed, by the one opener
          both stores use (storewait.js), so it cannot block a later upgrade.
   block  a tab at the older version that never lets go of daimond-kv makes the open
          refuse at once, with a notice, rather than wait out the bound.
   dev/pagestore_r3_red.sh deletes each guard and names the arm that goes red.
     node www/js/pagestore_r3.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { page } from './test/chatidb.mjs';
import { loadPage } from './test/page.mjs';
import { enc } from './test/idbkeys.mjs';
import { kvIdb, release } from './test/kvidb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WAIT = 60;	// ms: the policy's store wait for this test
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const within = (p, ms) => Promise.race([p.then((v) => ({ v })), new Promise((r) => setTimeout(() => r(null), ms))]);

/// A tab holding the REAL storewait.js and durable.js over `how`'s store, or over the
/// store and box of the tab `on` (the same device).
function kvTab(how, piece = 32768, on = null) {
	const idb = on ? on.idb : kvIdb(how);
	const box = on ? on.box : new Map();
	const notices = [];
	const win = {
		indexedDB: idb.api,
		IDBKeyRange: { bound: (lower, upper, lo, uo) => ({ lower, upper, lowerOpen: !!lo, upperOpen: !!uo }) },
		DaimondPolicy: { storeWaitMs: () => WAIT, storePieceBytes: () => piece },
		localStorage: { getItem: (k) => box.has(k) ? box.get(k) : null, setItem: (k, v) => box.set(k, String(v)), removeItem: (k) => box.delete(k) },
	};
	win.window = win;
	loadScript(win, 'storewait.js');
	win.DaimondStoreWait.tell({
		stalled: (what) => { notices.push('stalled ' + what); if (how.onStall) how.onStall(); },
		answered: () => {},
		blocked: (what) => notices.push('blocked ' + what),
	});
	loadScript(win, 'durable.js');
	return { D: win.DaimondDurable, W: win.DaimondStoreWait, idb, notices, win, box };
}

// ── H1: durable.js is bounded ───────────────────────────────────────

{
	const t = kvTab({ open: 'silent', delay: 0 });
	const r = await within(t.D.ready(), WAIT * 4);
	check('H1 open: an open that never answers comes back within the wait, on the box', !!r && !t.D.durable(), r ? 'durable ' + t.D.durable() : 'still waiting');
}
{
	const how = { open: 'ok', delay: 0 };
	const t = kvTab(how);
	await t.D.ready();
	how.stall = true;
	const set = await within(t.D.set('k', { a: 1 }), WAIT * 4);
	const upd = await within(t.D.update('m', { e: { v: 1 } }), WAIT * 4);
	check('H1 tx: a set and an update on a store that stopped come back within the wait, failed',
		!!set && set.v === false && !!upd && upd.v.ok === false, JSON.stringify({ set, upd }));
}

{
	const how = { open: 'ok', delay: 0, stall: true };
	const t = kvTab(how);
	const st = (await t.W.open('daimond-kv', 2, () => {}, 'reading')).watch('kv', 'readonly', 'reading').store('kv');
	const one = (p) => within(p.then(() => 'answered', () => 'failed'), WAIT * 4);
	const got = await one(st.get('k'));
	const walked = await one(st.walk(null, () => {}));
	check('H1 request: a request and a walk handed out by watch() on a store that stopped come back within the wait, failed',
		got && got.v === 'failed' && walked && walked.v === 'failed', JSON.stringify({ got, walked }));
}

// ── F1: a read that outruns the wait is not an empty store ─────────

{
	const IX = 'daimond-cloud-index', MK = 'daimond-cloud-merged', SEEN = 'daimond-cloud-merged-seen';
	const how = { open: 'ok', delay: 0 };
	const t = kvTab(how);
	await t.D.ready();
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	await t.D.set(IX, old); await t.D.update(IX, {}); await t.D.set(MK, { v: 7 });
	t.box.set(SEEN, '1');
	t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: (k, v) => (t.box.set(k, JSON.stringify(v)), true) };
	loadScript(t.win, 'cloud.js');
	const C = t.win.DaimondCloud;
	// Busy (a sibling tab's long write) past the index read's wait, answering again after it.
	how.held = [];
	how.onStall = () => { how.onStall = null; release(how); };
	await within(C.ready(), WAIT * 20);
	const boot = { n: Object.keys(C.index()).length, whole: C.wholeAt(), durable: C.indexDurable() };
	check('F1 busy: a boot whose index read outran the wait holds the 40, or is neither whole nor durable',
		boot.n === 40 || (!(typeof boot.whole === 'number' && boot.whole >= 0) && !boot.durable), JSON.stringify(boot));
	await within(C.refresh(), WAIT * 20);
	const later = { n: Object.keys(C.index()).length, whole: C.wholeAt(), durable: C.indexDurable() };
	check('F1 retry: the next refresh, the store answering, loads the 40 and the mark 7',
		later.n === 40 && later.whole === 7 && later.durable, JSON.stringify(later));
}

// ── F2: a readwrite transaction whose work fails lands none of it ──

{
	const t = kvTab({ open: 'ok', delay: 0 });
	await t.D.ready();
	await t.D.update('K', { a: { v: 1 }, b: { v: 2 } });
	const r = await within(t.D.update('K', { a: { v: 3 }, b: { v: 10n } }), WAIT * 4);	// JSON refuses a BigInt
	const back = await t.D.get('K');
	check('F2 atom: an update that fails part way answers not ok and lands none of its ops',
		!!r && r.v.ok === false && back && back.a === 1 && back.b === 2, JSON.stringify({ ok: r && r.v.ok, back }));
}
{
	const t = kvTab({ open: 'ok', delay: 0 });
	await t.D.ready();
	await t.D.set('w', 1);
	const w = (await t.W.open('daimond-kv', 2, () => {}, 'walking')).watch('kv', 'readwrite', 'walking');
	let walk = null;	// the walk's own answer: the work hands back its failure as a value, so only the walk can abort
	const ran = w.run((store) => {
		const st = store('kv');
		st.put(2, ['w2']);
		walk = st.walk(null, () => { throw new Error('a callback fault'); }).then(() => 'answered', () => 'failed');
		return walk;
	}).catch(() => null);
	const walked = await within(walk, WAIT * 4);
	await within(ran, WAIT * 4);
	check('F2 walk: a walk whose callback throws fails and aborts its transaction',
		!!walked && walked.v === 'failed' && !t.idb.data.has(enc(['w2'])) && [...t.idb.data.keys()].length === 1, JSON.stringify({ walked, keys: [...t.idb.data.keys()] }));
}

// ── F2 chat: a ChatStore write that throws part way lands none of it ──

{
	const msg = (i) => ({ mid: 'x' + i, role: i % 2 ? 'assistant' : 'user', content: 'kept ' + i, ts: 1700000000000 + i });
	const data = new Map();
	const A = page(data, undefined, undefined, undefined, WAIT);
	await within(A.ChatStore.boot(), WAIT * 25);
	A.ChatStore.save([{ id: 'xc', name: 'x', messages: [0, 1, 2, 3].map(msg), session: { msgs: [] }, updatedAt: Date.now(), _loaded: true }]);
	await within(A.ChatStore.settled(), WAIT * 25);
	const mids = () => [...data.get('msgchunks').values()].flatMap((r) => (r.msgs || r.messages || []).map((m) => m.mid)).sort().join(',');
	const before = mids();
	// The heal deletes the chat's chunks, then a put of the rewritten ones throws.
	A.window.localStorage.setItem('daimond-msgs-deleted', JSON.stringify({ x1: Date.now() }));
	data.failPut = (name) => name === 'msgchunks';
	await within(A.ChatStore.compact('xc'), WAIT * 25);
	await new Promise((ok) => setTimeout(ok, WAIT * 2));	// what the transaction does once its caller has failed
	const after = mids();
	data.failPut = (name, v) => name === 'tombs' && v.id === 'b';
	const r = await within(A.ChatStore.putTombs('m', { a: 1, b: 2 }), WAIT * 25);
	await new Promise((ok) => setTimeout(ok, WAIT * 2));
	data.failPut = null;
	const tombs = [...data.get('tombs').keys()];
	check('F2 chat: a heal or a tomb write whose put throws after its deletes or first put lands none of it',
		before.length > 0 && after === before && !!r && r.v === false && tombs.length === 0, JSON.stringify({ before, after, put: r && r.v, tombs }));
}

// ── drop: a reopen that fails after a connection opened is not the box ──

{
	const IX = 'daimond-cloud-index', MK = 'daimond-cloud-merged', SEEN = 'daimond-cloud-merged-seen';
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	const seeded = async (how) => {
		const t = kvTab(how);
		await t.D.ready();
		await t.D.set(IX, old); await t.D.update(IX, {}); await t.D.set(MK, { v: 7 });
		t.box.set(SEEN, '1');
		t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: (k, v) => (t.box.set(k, JSON.stringify(v)), true) };
		return t;
	};
	const st = (C) => ({ n: Object.keys(C.index()).length, whole: C.wholeAt(), durable: C.indexDurable() });
	const short = (s, n) => s.n < n && ((typeof s.whole === 'number' && s.whole >= 0) || s.durable);
	// Safari drops the connection, and the reopen never answers.
	const drop = (t, how) => { how.open = 'silent'; t.idb.db.onclose(); };

	{
		const how = { open: 'ok', delay: 0 };
		const t = await seeded(how);
		how.tx = 'throw';	// the boot's read of the index does not land
		loadScript(t.win, 'cloud.js');
		const C = t.win.DaimondCloud;
		await within(C.ready(), WAIT * 20);
		how.tx = null;
		drop(t, how);
		await within(C.refresh(), WAIT * 20);
		const r = st(C);
		await within(C.noteWhole(7), WAIT * 20);
		const w = st(C);
		// The commit gate (parcel_collect.js mayCommitChunks) needs the index durable AND whole.
		check('drop: a refresh over a dropped store whose reopen fails leaves the index unread, and a mark noted then is not stored nor durable',
			!short(r, 40) && !(r.whole >= 0) && !w.durable && !t.box.has(MK), JSON.stringify({ r, w, box: [...t.box.keys()] }));
		how.open = 'ok';
		await within(C.refresh(), WAIT * 20);
		const back = st(C);
		check('drop: once the store answers, the next refresh loads the 40 and the mark 7',
			back.n === 40 && back.whole === 7 && back.durable, JSON.stringify(back));
	}
	{
		const how = { open: 'ok', delay: 0 };
		const t = await seeded(how);
		loadScript(t.win, 'cloud.js');
		const C = t.win.DaimondCloud;
		await within(C.ready(), WAIT * 20);
		const boot = st(C);
		drop(t, how);
		C.contentSet('~c/new', { size: 1, hash: 'hn' });
		await within(C.settle(), WAIT * 20);
		const after = st(C);
		check('dropw: a write over a dropped store whose reopen fails stays queued, off the box, the index neither shrunk nor durable',
			boot.n === 40 && boot.durable && after.n === 41 && !after.durable && !t.box.has(IX), JSON.stringify({ boot, after, box: [...t.box.keys()] }));
		how.open = 'ok';
		await within(C.settle(), WAIT * 20);
		const held = await within(t.D.get(IX), WAIT * 4);
		const landed = st(C);
		check('dropw: once the store answers, the queued write lands beside the 40',
			!!held && !!held.v && Object.keys(held.v).length === 41 && !!held.v['~c/new'] && landed.n === 41 && landed.durable,
			JSON.stringify({ landed, held: held && held.v && Object.keys(held.v).length }));
	}
}

// ── firstref: a device whose store took over, in a page whose first open is refused ──

{
	const IX = 'daimond-cloud-index', MK = 'daimond-cloud-merged', SEEN = 'daimond-cloud-merged-seen';
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	const st = (C) => ({ n: Object.keys(C.index()).length, whole: C.wholeAt(), durable: C.indexDurable() });
	const cloudOn = async (t) => {
		const put = (k, v) => (t.box.set(k, JSON.stringify(v)), true);
		t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: put, put };
		loadScript(t.win, 'cloud.js');
		await within(t.win.DaimondCloud.ready(), WAIT * 20);
		return t.win.DaimondCloud;
	};
	// A device seeded and booted as normal: the index (40, mark 7) in the store, none in the box.
	const device = async (list) => {
		const how = { open: 'ok', delay: 0, list };
		const s = kvTab(how);
		await s.D.ready();
		await s.D.set(IX, old); await s.D.update(IX, {}); await s.D.set(MK, { v: 7 });
		s.box.set(SEEN, '1');
		const C0 = await cloudOn(kvTab(how, 32768, s));
		return { how, s, boot: st(C0) };
	};
	for (const [name, refuse, list, legacy, errName] of [
		['firstref', 'silent', false, false],		// QA r5's case
		['firstref error', 'error', false, false, 'InvalidStateError'],	// only the marker can tell
		['firstref legacy blocked', 'blocked', false, true],
		['firstref legacy listed', 'error', true, true],
		['firstref lost error', 'error', false, true],	// the marker cleared alone, no list to ask (QA r6 F6)
	]) {
		const { how, s, boot } = await device(list);
		if (legacy) s.box.delete('daimond-kv-took');	// an older build kept no marker
		how.open = refuse; how.errName = errName;
		const P = kvTab(how, 32768, s);
		const C = await cloudOn(P);
		C.contentSet('~c/box', { size: 3, hash: 'hb' });
		await within(C.settle(), WAIT * 20);
		const after = st(C);
		check(name + ': a page whose first open is refused (' + refuse + ') writes nothing to the box, and calls the index neither whole nor durable',
			boot.n === 40 && boot.durable && !s.box.has(IX) && !after.durable && !(after.whole >= 0), JSON.stringify({ boot, after, box: [...s.box.keys()] }));
		how.open = 'ok';
		await within(C.settle(), WAIT * 20);
		const N = kvTab(how, 32768, s);
		const C2 = await cloudOn(N);
		const next = st(C2);
		check(name + ': once the store answers the write lands, and the next boot has it beside the 40',
			next.n === 41 && !!C2.index()['~c/box'] && next.durable, JSON.stringify(next));
	}
	{
		const how = { open: 'error', delay: 0, list: true };
		const t = kvTab(how);
		const ok = await within(t.D.set('k', { a: 1 }), WAIT * 4);
		check('firstref fresh: a device whose store never opened keeps the box when the open errors',
			!!ok && ok.v === true && t.box.has('k'), JSON.stringify({ ok, box: [...t.box.keys()] }));
	}
	for (const name of ['InvalidStateError', 'SecurityError']) {
		const t = kvTab({ open: 'error', errName: name, delay: 0 });
		const ok = await within(t.D.set('k', { a: 1 }), WAIT * 4);
		check('firstref private: an open refused as ' + name + ' with no list keeps the box',
			!!ok && ok.v === true && t.box.has('k') && !t.D.tookOver(), JSON.stringify({ ok, box: [...t.box.keys()] }));
	}
}

// ── nolandmig: the box's index is dropped only once the store records its move ──

{
	const IX = 'daimond-cloud-index', SEEN = 'daimond-cloud-merged-seen';
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	const st = (C) => ({ n: Object.keys(C.index()).length, whole: C.wholeAt(), durable: C.indexDurable() });
	const cloudOn = async (t) => {
		const put = (k, v) => (t.box.set(k, JSON.stringify(v)), true);
		t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: put, put };
		loadScript(t.win, 'cloud.js');
		await within(t.win.DaimondCloud.ready(), WAIT * 20);
		return t.win.DaimondCloud;
	};
	const alarm = (t) => { t.win.DaimondCore = { noteCloudIndexStuck: () => t.alarms.push('up'), clearStorageAlarm: () => t.alarms.push('clear') }; t.alarms = []; return t; };
	const isMoved = (k) => Array.isArray(k) && Array.isArray(k[0]) && k[0].length === 0 && k[1] === IX;
	// The move's write fails (a quota error on the one large write) while the index's own writes would land.
	const how = { open: 'ok', delay: 0, failPut: isMoved };
	const t = alarm(kvTab(how));
	t.box.set(IX, JSON.stringify(old)); t.box.set(SEEN, '1');
	const C = await cloudOn(t);
	const boot = st(C);
	C.contentSet('~c/new', { size: 1, hash: 'hn' });
	await within(C.settle(), WAIT * 20);
	const after = st(C);
	const stored = await t.D.get(IX);
	check('nolandmig: a boot whose move of the box index did not land keeps the box copy and the 40, neither whole nor durable',
		boot.n === 40 && !boot.durable && !(boot.whole >= 0) && after.n === 41 && !after.durable && !(after.whole >= 0) && t.box.has(IX),
		JSON.stringify({ boot, after, box: [...t.box.keys()] }));
	check('nolandmig owed: an index write waits for the move, so the store holds no part of the index and the alarm stays up',
		stored === null && t.alarms.length > 0 && !t.alarms.includes('clear'), JSON.stringify({ stored, alarms: t.alarms }));
	how.failPut = null;
	await within(C.settle(), WAIT * 20);
	const landed = st(C);
	check('nolandmig landed: once the move lands the owed write lands over it, and the index is durable',
		landed.n === 41 && landed.durable && !t.box.has(IX) && t.alarms[t.alarms.length - 1] === 'clear',
		JSON.stringify({ landed, alarms: t.alarms, box: [...t.box.keys()] }));
	const C2 = await cloudOn(kvTab(how, 32768, t));
	const next = st(C2);
	check('nolandmig next: the next boot has the 40 and the write, durable',
		next.n === 41 && !!C2.index()['~c/new'] && next.durable && !t.box.has(IX), JSON.stringify({ next, box: [...t.box.keys()] }));
	// An older tab writes the box index again: the store's record of the move drops it unread.
	C2.contentForget('docs/0.md');
	await within(C2.settle(), WAIT * 20);
	t.box.set(IX, JSON.stringify(old));
	const C3 = await cloudOn(kvTab(how, 32768, t));
	const third = st(C3);
	check('nolandmig moved: a box copy written after the move is dropped unread, and a path forgotten since stays gone',
		third.n === 40 && !C3.index()['docs/0.md'] && third.durable && !t.box.has(IX), JSON.stringify({ third, box: [...t.box.keys()] }));
	const u = await t.D.update('nokey', {});
	const held = await t.D.get('nokey');
	check('nolandmig empty: an update with no ops writes nothing', u.ok === true && held === null, JSON.stringify({ u, held }));
}
{
	// The boot's move aborts once; a deletion and a set are made before the next try.
	const IX = 'daimond-cloud-index', SEEN = 'daimond-cloud-merged-seen';
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	const cloudOn = async (t) => {
		const put = (k, v) => (t.box.set(k, JSON.stringify(v)), true);
		t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: put, put };
		loadScript(t.win, 'cloud.js');
		await within(t.win.DaimondCloud.ready(), WAIT * 20);
		return t.win.DaimondCloud;
	};
	let n = 0;
	const how = { open: 'ok', delay: 0, failTx: (m) => m === 'readwrite' && n++ === 0 };
	const t = kvTab(how);
	t.box.set(IX, JSON.stringify(old)); t.box.set(SEEN, '1');
	const C = await cloudOn(t);
	C.contentForget('docs/0.md');
	C.contentSet('~c/new', { size: 1, hash: 'hn' });
	await within(C.settle(), WAIT * 20);
	// An older build (r6) drops the box unread once the store holds an index at all.
	const s = await t.D.get(IX);
	const r6 = (s && typeof s === 'object') ? s : (t.box.has(IX) ? JSON.parse(t.box.get(IX)) : {});
	check('rollback: an older build booting now finds the whole index, never a part of it with the box dropped',
		Object.keys(r6).length === 40 && !!r6['~c/new'] && !r6['docs/0.md'], JSON.stringify({ n: Object.keys(r6).length, box: t.box.has(IX) }));
	const C2 = await cloudOn(kvTab(how, 32768, t));
	const ix = C2.index();
	check('delunmoved: a path deleted while the move had not landed stays deleted on the next boot',
		Object.keys(ix).length === 40 && !ix['docs/0.md'] && !!ix['~c/new'] && C2.indexDurable(), JSON.stringify({ n: Object.keys(ix).length, del: !!ix['docs/0.md'] }));
}
{
	// An older build's move: the store holds the index with no record of the move, and the box a copy.
	const IX = 'daimond-cloud-index', SEEN = 'daimond-cloud-merged-seen';
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	const cloudOn = async (t) => {
		const put = (k, v) => (t.box.set(k, JSON.stringify(v)), true);
		t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: put, put };
		loadScript(t.win, 'cloud.js');
		await within(t.win.DaimondCloud.ready(), WAIT * 20);
		return t.win.DaimondCloud;
	};
	const how = { open: 'ok', delay: 0 };
	const t = kvTab(how);
	await t.D.ready();
	await t.D.update(IX, { 'docs/1.md': { v: { size: 1, hash: 'h1new' } }, '~c/old': { v: { size: 2, hash: 'ho' } } });
	t.box.set(IX, JSON.stringify(old)); t.box.set(SEEN, '1');
	const C = await cloudOn(kvTab(how, 32768, t));
	const ix = C.index();
	check('nolandmig older: the box is laid under an older build\'s moved index, whose entry wins on a shared path',
		Object.keys(ix).length === 41 && !!ix['~c/old'] && ix['docs/1.md'] && ix['docs/1.md'].hash === 'h1new' && C.indexDurable() && !t.box.has(IX),
		JSON.stringify({ n: Object.keys(ix).length, d1: ix['docs/1.md'], box: t.box.has(IX) }));
	// A box value that is not a map (corrupt, or foreign) over the same kind of store.
	const t2 = kvTab(how);
	await t2.D.ready();
	await t2.D.update(IX, { '~c/old': { v: { size: 2, hash: 'ho' } } });
	t2.box.set(IX, 'null'); t2.box.set(SEEN, '1');
	const C2 = await cloudOn(kvTab(how, 32768, t2));
	const ix2 = C2.index();
	check('nolandmig nonmap: a box index that is not a map is dropped, never written over the stored map',
		Object.keys(ix2).length === 1 && !!ix2['~c/old'] && C2.indexDurable() && !t2.box.has(IX), JSON.stringify({ ix2, box: t2.box.has(IX) }));
}

// ── quiet, twotabs, scalar: the handover's alarm, a sibling's write, a box that is no map ──

{
	const IX = 'daimond-cloud-index', SEEN = 'daimond-cloud-merged-seen';
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	const st = (C) => ({ n: Object.keys(C.index()).length, durable: C.indexDurable(), read: C.indexRead() });
	const cloudOn = async (t) => {
		const put = (k, v) => (t.box.set(k, JSON.stringify(v)), true);
		t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: put, put };
		t.alarms = [];
		t.win.DaimondCore = { noteCloudIndexStuck: () => t.alarms.push('up'), clearStorageAlarm: () => t.alarms.push('clear') };
		loadScript(t.win, 'cloud.js');
		await within(t.win.DaimondCloud.ready(), WAIT * 20);
		return t.win.DaimondCloud;
	};
	const isMoved = (k) => Array.isArray(k) && Array.isArray(k[0]) && k[0].length === 0 && k[1] === IX;

	// The move fails and the page writes nothing: each round reads, none writes.
	const how = { open: 'ok', delay: 0, failPut: isMoved };
	const t = kvTab(how);
	t.box.set(IX, JSON.stringify(old)); t.box.set(SEEN, '1');
	const C = await cloudOn(t);
	await within(C.refresh(), WAIT * 20);
	await within(C.refresh(), WAIT * 20);
	const held = st(C);
	check('quiet: a page whose move fails and that writes nothing has the alarm up, never cleared',
		!held.read && !held.durable && t.box.has(IX) && t.alarms.includes('up') && !t.alarms.includes('clear'),
		JSON.stringify({ held, alarms: t.alarms }));
	how.failPut = null;
	await within(C.refresh(), WAIT * 20);
	const freed = st(C);
	check('quiet lifted: once the move lands and the index is read the alarm is cleared',
		freed.read && freed.durable && freed.n === 40 && !t.box.has(IX) && t.alarms[t.alarms.length - 1] === 'clear',
		JSON.stringify({ freed, alarms: t.alarms }));

	// Two tabs and no channel: B owes a write while the move fails; A moves and writes; B lands.
	const how2 = { open: 'ok', delay: 0, failPut: isMoved };
	const tb = kvTab(how2);
	tb.box.set(IX, JSON.stringify(old)); tb.box.set(SEEN, '1');
	const B = await cloudOn(tb);
	B.contentSet('~c/b', { size: 1, hash: 'hb' });
	await within(B.settle(), WAIT * 20);
	how2.failPut = null;
	const ta = kvTab(how2, 32768, tb);
	const A = await cloudOn(ta);
	A.contentSet('~c/a', { size: 1, hash: 'ha' });
	await within(A.settle(), WAIT * 20);
	await within(B.settle(), WAIT * 20);
	const bx = B.index();
	check('twotabs: a tab whose owed write lands after a sibling moved and wrote holds the sibling\'s write too',
		Object.keys(bx).length === 42 && !!bx['~c/a'] && !!bx['~c/b'] && B.indexDurable() && tb.alarms[tb.alarms.length - 1] === 'clear',
		JSON.stringify({ n: Object.keys(bx).length, a: !!bx['~c/a'], alarms: tb.alarms }));

	// A box index that is a number, over a store that holds a map.
	const ts = kvTab({ open: 'ok', delay: 0 });
	await ts.D.ready();
	await ts.D.update(IX, { '~c/old': { v: { size: 2, hash: 'ho' } } });
	ts.box.set(IX, '7'); ts.box.set(SEEN, '1');
	const S = await cloudOn(kvTab({ open: 'ok', delay: 0 }, 32768, ts));
	let threw = null;
	try { S.contentSet('~c/new', { size: 1, hash: 'hn' }); } catch (e) { threw = String(e); }
	await within(S.settle(), WAIT * 20);
	const sx = S.index();
	check('scalar: a box index that is a number never seeds the mirror, and a write lands over the stored map',
		threw === null && typeof sx === 'object' && !!sx['~c/old'] && !!sx['~c/new'] && S.indexDurable(),
		JSON.stringify({ threw, sx, durable: S.indexDurable() }));
}

// ── unread: no merge over an index this page never read ──

{
	const IX = 'daimond-cloud-index', MK = 'daimond-cloud-merged', SEEN = 'daimond-cloud-merged-seen';
	const old = {};
	for (let i = 0; i < 40; i++) old['docs/' + i + '.md'] = { size: i, hash: 'h' + i };
	const L = { size: 9, hash: 'hL' }, R = { size: 8, hash: 'hR' };
	const cloudOn = async (t) => {
		const put = (k, v) => (t.box.set(k, JSON.stringify(v)), true);
		t.win.DaimondStore = { get: (k, d) => t.box.has(k) ? JSON.parse(t.box.get(k)) : d, set: put, put, refusal: () => new Error('refused') };
		loadScript(t.win, 'cloud.js');
		await within(t.win.DaimondCloud.ready(), WAIT * 20);
		return t.win.DaimondCloud;
	};
	for (const read of [true, false, 'ro']) {
		const how = { open: 'ok', delay: 0 };
		const s = kvTab(how);
		await s.D.ready();
		await s.D.set(IX, Object.assign({}, old, { 'notes/p.md': L })); await s.D.set(MK, { v: 7 });
		s.box.set(SEEN, '1');
		if (read === false) how.open = 'silent';
		if (read === 'ro') how.failTx = (m) => m === 'readonly';	// the open lands, the boot's reads do not
		const C = await cloudOn(kvTab(how, 32768, s));
		let threw = null;
		try { C.merge({ 'notes/p.md': R }, { 'notes/p.md': 'h0' }, 'devD', 'devE', {}); } catch (e) { threw = e.message; }
		how.open = 'ok'; how.failTx = null;
		await within(C.refresh(), WAIT * 20); await within(C.settle(), WAIT * 20);
		const C2 = await cloudOn(kvTab(how, 32768, s));
		const ix = C2.index(), copies = Object.keys(ix).filter((k) => k.indexOf('notes/p') === 0);
		check('unread read=' + read + ': this device\'s own manifest of p (hL) survives the merge' + (read === true ? ', the remote filed beside it' : ', which refuses'),
			ix['notes/p.md'] && ix['notes/p.md'].hash === 'hL' && (read === true ? copies.some((k) => ix[k].hash === 'hR') && !threw : !!threw),
			JSON.stringify({ threw, p: ix['notes/p.md'], copies }));
	}
}
for (const read of [false, true]) {
	const asked = [], merged = [];
	const w = makeWindow({});
	w.DaimondTools = {};
	w.DaimondChunks = { chunkSizeFor: () => 1 << 20 };
	w.DaimondCloud = {
		indexRead:     () => read,
		index:         () => ({}),
		isPreviewKey:  (k) => { asked.push(k); return false; },
		merge:         (inc) => { merged.push(Object.keys(inc || {})); },
		refreshPaths:  async () => {},
		localState:    async () => ({ state: 'unknown' }),
		mayDrop:       () => false,
		isContentKey:  () => false,
		forget:        () => {},
		JUDGED_ABSENT: {},
	};
	const P = loadPage({ window: w, stub: { syncWalkPlan: async () => ({ roots: [''], app: {}, loc: 'browser' }) }, want: ['applyChunked'] });
	let threw = null;
	try { await P.applyChunked({ 'proj/a.txt': { hash: 'h1', size: 3 } }, {}, 'dev-b', {}); } catch (e) { threw = e.message; }
	check('unread section' + (read ? ' [ctl]' : '') + ': the chunked section ' + (read ? 'merges a read index' : 'refuses, unmerged and no peer ref weighed, over an unread index'),
		read ? !threw && merged.length === 1 : !!threw && merged.length === 0 && asked.length === 0, JSON.stringify({ threw, merged, asked }));
}

// ── H4: the bound is on silence, not on the whole write ─────────────

{
	const how = { open: 'ok', delay: WAIT / 2 };
	const t = kvTab(how, 200);	// 68 characters a piece: a 1200-character value is ~20 requests
	await t.D.ready();
	const t0 = Date.now();
	const ok = await within(t.D.set('big', 'x'.repeat(1200)), WAIT * 40);
	const took = Date.now() - t0;
	check('H4 silence: a write answering every ' + (WAIT / 2) + ' ms for ' + took + ' ms lands, not stalled',
		!!ok && ok.v === true && took > WAIT * 3 && !t.notices.some((n) => n.startsWith('stalled')), JSON.stringify({ ok, took, notices: t.notices }));
	const back = await t.D.get('big');
	check('H4 silence: and reads back whole', back === 'x'.repeat(1200));
}

// ── H5: a floor under the piece size ────────────────────────────────

{
	const w = makeWindow({ now: Date.now() });
	loadScript(w, 'trash.js');
	const P = w.DaimondPolicy;
	P.setPiece(1);	// as adopt() takes the gateway's store_piece_bytes
	const one = P.storePieceBytes();
	P.setPieceMin(8192);
	const served = P.storePieceBytes();
	P.setPiece(50000);
	const big = P.storePieceBytes();
	check('H5 floor: a served piece of 1 byte is held at the floor (shipped, then served)',
		one >= 1024 && served === 8192 && big === 50000, JSON.stringify({ one, served, big }));
}

// ── block: an older tab holding daimond-kv ──────────────────────────

{
	const t = kvTab({ open: 'blocked', delay: 0 });
	const t0 = Date.now();
	const r = await within(t.D.ready(), WAIT * 4);
	const took = Date.now() - t0;
	check('block: a blocked open refuses at once, on the box, with a notice',
		!!r && took < WAIT / 2 && !t.D.durable() && t.notices.some((n) => n.startsWith('blocked')), JSON.stringify({ took, notices: t.notices }));
}

// ── F4: an open that answers after its wait, or after its refusal, is closed ──

for (const [label, how] of [['after its wait', { open: 'late', late: WAIT * 2, delay: 0 }], ['after its refusal', { open: 'blocked', late: WAIT, delay: 0 }]]) {
	const t = kvTab(how);
	await within(t.D.ready(), WAIT * 4);
	const onBox = !t.D.durable();
	await new Promise((r) => setTimeout(r, WAIT * 3));
	check('F4 late: a connection that answers ' + label + ' is closed, and the tab stays on the box',
		onBox && !t.D.durable() && t.idb.data.closed === 1, JSON.stringify({ onBox, durable: t.D.durable(), closed: t.idb.data.closed }));
}
{
	const own = ['page/chatstore.js', 'durable.js'].filter((f) => /\bindexedDB\)?\.open\(|\bidb\(\)\.open\(/.test(readFileSync(join(HERE, f), 'utf8')));
	check('F4 one opener: ChatStore and durable.js open through DaimondStoreWait.open', own.length === 0, own.join(', '));
}

// ── H6: every ChatStore store wait is bounded ───────────────────────

// A transaction opened anywhere but storewait.js would hand out raw requests, which nothing bounds.
const outside = (calls) => calls.filter((f) => !/storewait\.js/.test(f));

{
	const data = new Map();
	data.callers = [];
	const rows = [...Array(6).keys()].map((i) => ({ mid: 'g' + i, role: 'user', content: 'gate ' + i, ts: 1700000000000 + i }));
	const A = page(data, undefined, undefined, undefined, WAIT);
	await within(A.ChatStore.boot(), WAIT * 25);
	A.ChatStore.save([{ id: 'g1', name: 'gate', messages: rows, session: { msgs: [] }, updatedAt: Date.now(), _loaded: true }]);
	await within(A.ChatStore.settled(), WAIT * 25);
	const B = page(data, undefined, undefined, undefined, WAIT);
	await within(B.ChatStore.boot(), WAIT * 25);
	const bad = outside(data.callers);
	check('H6 gate: every ChatStore transaction is opened by storewait.js, so no request outside its bound is reachable',
		data.callers.length > 0 && bad.length === 0, bad.length ? 'opened at ' + bad.join('; ') : data.callers.length + ' transactions');
}
{
	const how = { open: 'ok', delay: 0, callers: [] };
	const t = kvTab(how);
	await t.D.ready();
	await t.D.set('k', { a: 1 }); await t.D.get('k'); await t.D.update('m', { e: { v: 1 } }); await t.D.del('k');
	t.box.set('mv', '{"x":1}'); await t.D.migrate('mv');
	const bad = outside(how.callers);
	// What a caller holds: the connection, a watched transaction and its store, each walked by every key.
	const h = await t.W.open('daimond-kv', 2, () => {}, 'gate'), w = h.watch('kv', 'readonly', 'gate');
	const raw = [t.idb.db];
	const reach = (o, depth) => {
		if (o === null || (typeof o !== 'object' && typeof o !== 'function') || depth > 3) return [];
		if (raw.includes(o)) return ['the raw connection'];
		const out = [];
		for (let p = o; p && p !== Object.prototype && p !== Function.prototype; p = Object.getPrototypeOf(p)) {
			for (const k of Object.getOwnPropertyNames(p)) {
				if (k === 'transaction') out.push(k);
				else if (!['caller', 'callee', 'arguments'].includes(k)) out.push(...reach(Object.getOwnPropertyDescriptor(p, k).value, depth + 1).map((x) => k + '.' + x));
			}
		}
		return out;
	};
	const held = [...reach(h, 0), ...reach(w, 0), ...reach(w.store('kv'), 0)];
	check('H1 gate: every durable.js transaction is opened by storewait.js, and the connection it hands out reaches none',
		how.callers.length > 0 && bad.length === 0 && held.length === 0, (bad.length ? 'opened at ' + bad.join('; ') : '') + (held.length ? ' held: ' + held.join(', ') : ''));
}
{
	const msg = (i) => ({ mid: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: 'line ' + i, ts: 1700000000000 + i });
	const data = new Map();
	const BOUND = WAIT * 25;
	const chat = (n) => [{ id: 'c1', name: 'one', messages: [...Array(n).keys()].map(msg), session: { msgs: [] }, updatedAt: Date.now() + n, _loaded: true }];
	const A = page(data, undefined, undefined, undefined, WAIT);
	await A.ChatStore.boot();
	A.ChatStore.save(chat(4));
	await within(A.ChatStore.settled(), BOUND);
	// A save over a store that answers k more callbacks after boot, then none.
	let grow = 6;
	const saveAfter = async (k) => {
		let left = Infinity, n = 0;
		const P = page(data, undefined, undefined, (fn) => { n++; if (left > 0) { left--; fn(); } }, WAIT);
		await within(P.ChatStore.boot(), BOUND);
		const before = n;
		left = k;
		P.ChatStore.save(chat(grow++));	// each save adds to what is on disk
		const r = await within(P.ChatStore.settled(), BOUND);
		return { r, used: n - before };
	};
	const full = await saveAfter(Infinity);
	const total = full.used;
	const hung = [];
	for (let k = 0; k <= total; k++) if (!(await saveAfter(k)).r) hung.push(k);
	check('H6 save: a save comes back wherever the store stops (k = 0..' + total + ')', !!full.r && total > 0 && hung.length === 0, 'hung after k = ' + hung.join(','));
}
{
	// A boot's reads over a store that answers k callbacks, then none: each read's wait for
	// its transaction to end is bounded as its requests are.
	const msg = (i) => ({ mid: 'r' + i, role: i % 2 ? 'assistant' : 'user', content: 'read ' + i, ts: 1700000000000 + i });
	const data = new Map();
	const BOUND = WAIT * 25;
	const A = page(data, undefined, undefined, undefined, WAIT);
	await A.ChatStore.boot();
	A.ChatStore.save([{ id: 'r1', name: 'read', messages: [0, 1, 2].map(msg), session: { msgs: [] }, updatedAt: Date.now(), _loaded: true }]);
	await within(A.ChatStore.settled(), BOUND);
	const bootAfter = async (k) => {
		let left = k, n = 0;
		const P = page(data, undefined, undefined, (fn) => { n++; if (left > 0) { left--; fn(); } }, WAIT);
		return { r: await within(P.ChatStore.boot(), BOUND), n };
	};
	const total = (await bootAfter(Infinity)).n;
	const hung = [];
	for (let k = 0; k <= total; k++) if (!(await bootAfter(k)).r) hung.push(k);
	check('H6 read: a boot comes back wherever the store stops (k = 0..' + total + ')', total > 0 && hung.length === 0, 'hung after k = ' + hung.join(','));
}

// ── U1: update takes an op map, nothing else ───────────────────────

{
	const t = kvTab({ open: 'ok', delay: 0 });
	await t.D.ready();
	await t.D.update('K', { a: { v: 1 } });
	const bad = [() => ({ a: { v: 2 } }), null, [{ v: 2 }], 'a', 2];
	const rs = [];
	for (const ops of bad) rs.push(await t.D.update('K', ops).then((r) => r.ok, (e) => 'threw ' + e.message));
	const back = await t.D.get('K');
	const B = kvTab({ open: 'error', delay: 0 });
	await B.D.ready();
	B.box.set('K', '{"a":1}');
	const rb = await B.D.update('K', () => ({ a: { v: 2 } })).catch((e) => ({ ok: 'threw ' + e.message }));
	const keep = await t.D.update('K', {});
	check('U1 contract: an update whose ops are not an op map answers not ok and writes nothing, in the store and in the box',
		t.D.durable() && rs.every((ok) => ok === false) && back && back.a === 1 && !B.D.durable() && rb.ok === false && B.box.get('K') === '{"a":1}' && keep.ok === true,
		JSON.stringify({ durable: t.D.durable(), rs, back, boxDurable: B.D.durable(), rb, box: B.box.get('K'), keep }));
}

console.log(failures ? failures + ' FAILED' : 'all passed');
process.exit(failures ? 1 : 0);
