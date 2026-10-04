// gateway: none
// verify_stalefp.mjs -- a collect that reads a chat behind a queued save of it does not land a
// stale fingerprint (QA F-1, rc Fable round of 3 Oct 2026; the cure is `9f32e7c3`).
//
// THE BUG. `collectSync` reads each chat's transcript from the store. A save of that chat still
// QUEUED behind a write in flight has already taken its new `seed` in the mirror, but a read made
// now is ordered before it and serves the OLD transcript. That transcript's fingerprint equals the
// stored manifest's, so the collect named the old manifest, and `noteFps` put the old serial's
// `fp` beside the new copy's `seed`. Every later collect reused the old manifest, across reloads,
// until the copy in hand moved again: the far device was served the old transcript.
//
// THE CURE has two parts, and this file is the property of the pair, not a read of either:
//   1. `collectChatsRefs` awaits `ChatStore.settled()` before it reads the mirror, so it reads
//      the store behind its own writes;
//   2. `noteFps`'s database put is a compare-and-set on the row's seed, so a row another tab
//      moved is not overwritten with a fix measured for the old copy.
//
// THE PROPERTY, on one REAL device with a cloud stood up in this process:
//   1. a chat over SYNC_FILE_MAX offloads, and its `fp` is the store's;
//   2. a save W1 is in flight (held behind a transaction on the database, as a slow phone's
//      IndexedDB or a long compaction tail would hold it), the chat moves (W2, queued), and the
//      collect begins in the same tick. The collect names the MOVED transcript, and the
//      mirror's `fp` is the store's for it;
//   3. across a reload, the next collect and the one after it still name the moved transcript;
//   4. the control: the same race with the store settled first is the same answer.
//
// --break nosettle serves a daimond.js without part 1; --break unfix serves one with neither.
// Both must redden 2 and 3 (and leave 1 and 4 green). `nocas` alone is not offered: part 2 guards
// a write by another tab, which this one-device race never makes, so it would stay green and
// "must redden" would be false.
//
//   eval "$(bash dev/world.sh 98 --up)"; node dev/verify_stalefp.mjs         # the gate (green)
//   node dev/verify_stalefp.mjs --break unfix                                # must go red
//
// Options: --fill N (fillers in the first save, default 40), --msgs N, --len N, --hold MS
// (how long the database is held before W1 may run, default 800; 0 is the bare race).
// Needs dev/serve.mjs and a Chromium for --break; no gateway or mock model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, BROWSER } from './harness.mjs';
import { makeWindow, sliceDaimond } from './syncprobe.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' -- ' + detail : ''));
};
const note = (t) => console.log('        . ' + t);
const arg = (flag, dflt) => { const i = process.argv.indexOf(flag); return i > 0 ? String(process.argv[i + 1] || dflt) : dflt; };
const FILL  = parseInt(arg('--fill', '40'), 10);
const MSGS  = parseInt(arg('--msgs', '40'), 10);
const LEN   = parseInt(arg('--len', '300'), 10);
const HOLD  = parseInt(arg('--hold', '800'), 10);
const BREAK = arg('--break', '');

// ── The cure, reverted on request ───────────────────────────────────────
const REVERT = {
	settle: ["try { await ChatStore.settled(); } catch (e) { /* the alarm is up; the read is what there is */ }", '/* --break: no settled() */'],
	cas:    ["if ((s.seed || '') !== (f.seed || '')) return;", '/* --break: no compare-and-set */'],
};
const BREAKS = { nosettle: ['settle'], unfix: ['settle', 'cas'] };
if (BREAK && !BREAKS[BREAK]) { console.error(`unknown break '${BREAK}'; only: ${Object.keys(BREAKS).join(', ')}`); process.exit(2); }
if (BREAK && BROWSER !== 'chromium') { console.error('--break serves an edited file through page.route; run it under Chromium.'); process.exit(2); }

const PATCHED = new Map();
if (BREAK) {
	let src = fs.readFileSync(path.join(WWW, 'js/daimond.js'), 'utf8');
	for (const part of BREAKS[BREAK]) {
		const [find, put] = REVERT[part];
		const n = src.split(find).length - 1;
		if (n !== 1) { console.error(`break anchor '${part}' appears ${n} times (expected 1)`); process.exit(2); }
		src = src.replace(find, put);
	}
	PATCHED.set('js/daimond.js', src);
}
async function patchedSource(page) {
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
}

// ── The cloud, in this process ──────────────────────────────────────────
const cloud = { mailbox: null, chunks: new Map(), pushes: [] };
function serve(dev, rawPath, method, bodyText) {
	const p = String(rawPath).split('?')[0];
	const body = bodyText ? JSON.parse(bodyText) : {};
	if (p === '/api/sync') {
		if (method === 'GET') {
			if (!cloud.mailbox) return { status: 200, json: { present: false, version: 0 } };
			return { status: 200, json: { present: true, version: cloud.mailbox.version, blob: cloud.mailbox.blob, device: cloud.mailbox.device } };
		}
		const cur = cloud.mailbox ? cloud.mailbox.version : 0;
		if ((body.base_version | 0) !== cur) return { status: 409, json: { ok: false, version: cur } };
		cloud.mailbox = { version: cur + 1, blob: body.blob, device: body.device || dev };
		cloud.pushes.push({ dev, version: cur + 1 });
		return { status: 200, json: { ok: true, version: cur + 1 } };
	}
	if (p === '/api/chunk') {
		if (body.op === 'put') { (body.chunks || []).forEach(c => cloud.chunks.set(c.addr, c.blob)); return { status: 200, json: { ok: true } }; }
		if (body.op === 'have') return { status: 200, json: { missing: (body.addrs || []).filter(a => !cloud.chunks.has(a)) } };
		if (body.op === 'get') { const blob = cloud.chunks.get(body.addr); return { status: 200, json: blob ? { present: true, blob } : { present: false } }; }
		if (body.op === 'commit') return { status: 200, json: { ok: true, swept: 0, free_allowance: 0, paid_bytes: 0 } };
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await patchCloud(s, dev);
}
async function patchCloud(s, dev) {
	await s.page.evaluate((dev) => {
		window.__dev = dev;
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
	}, dev);
}
const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.chatStore && window.DaimondCloud && window.DaimondStamp),
	null, { timeout: 20000 });

const { fileHash } = sliceDaimond(makeWindow({ now: 1_000_000_000 }), ['fileHash'], {}).fns;

const T0 = 1758790000000;
const pad = (tag) => Array.from({ length: 15 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user',
	content: tag + ' ' + i + ' ' + 'p'.repeat(10000), mid: tag + 'pad' + i, ts: T0 - 1000 + i }));
const rec = (id, msgs, upd) => ({ id, name: 'Stale fp ' + id, model: 'mock/fast', provider: '', updatedAt: upd, metaAt: T0, messages: msgs, session: null });

// Put FIRST in the mirror's order: the collect reads chats in that order, and only the
// first read made while the write is held is ordered before the queued write.
const putChat = (pg, r) => pg.evaluate((r) => {
	const store = window.DaimondCore.chatStore();
	const list = store.stored().filter(c => c.id !== r.id);
	list.unshift(r);
	store.save(list);
	return store.settled();
}, r);
const collectEntry = (pg, cid) => pg.evaluate(async (cid) => {
	const parcel = await window.DaimondCore.collectSync();
	const e = (parcel.chats || []).find(c => c.id === cid) || null;
	const sum = window.DaimondCore.chatStore().stored().find(c => c.id === cid) || {};
	const mani = window.DaimondCloud.contentGet('@c/' + cid);
	return { ref: !!(e && e.messagesRef), key: e && e.messagesRef ? e.messagesRef.key : '',
		inlineMids: e && Array.isArray(e.messages) ? e.messages.map(m => m.mid) : null,
		fp: sum.fp, seed: sum.seed, maniFp: mani ? mani.fp : '', maniKey: mani ? mani.key : '' };
}, cid);
const served = async (pg, cid) => {
	const r = await pg.evaluate(async (cid) => {
		const store = window.DaimondCore.chatStore();
		await store.settled();
		const got = await store.loadMessages(cid);
		return { bytes: JSON.stringify(got.messages || []), mids: (got.messages || []).map(m => m.mid) };
	}, cid);
	return Object.assign(r, { fp: fileHash(r.bytes) });
};
const fillers = (tag, n) => Array.from({ length: n }, (_, i) => ({
	id: tag + '-' + i, name: 'fill ' + i, model: 'mock/fast', provider: '', updatedAt: T0 + 10 + i, metaAt: T0,
	messages: Array.from({ length: MSGS }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: tag + i + ' ' + k + ' ' + 'x'.repeat(LEN), mid: tag + i + '-' + k, ts: T0 - 500 + k })),
	session: null }));

// The race: W1 (a save that shortens every filler in hand, so its tail runs one compaction
// per filler after the commit) in flight, W2 (the chat moved) queued, and the collect begun
// in the same tick. With `settle` true the collect first awaits the store, which is the control.
const race = (pg, cid, newMsg, fillTag, keep, settle, holdMs) => pg.evaluate(async ({ cid, newMsg, fillTag, keep, settle, holdMs }) => {
	const store = window.DaimondCore.chatStore();
	const marks = {};
	// A HOLD ON THE DATABASE stands in for a slow write: a readwrite transaction on the chunk
	// store kept active for `holdMs`, created before W1, so W1 waits behind it and the
	// collect's own reads, created while it waits, are ordered before the write queued behind W1.
	let hold = null;
	if (holdMs > 0) {
		const dbs = await indexedDB.databases();
		const name = (dbs.map(d => d.name).find(n => /^daimond-chats/.test(n))) || '';
		marks.db = name;
		hold = await new Promise((res, rej) => { const q = indexedDB.open(name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
		await new Promise((res) => {
			const tx = hold.transaction(['msgchunks'], 'readwrite'), st = tx.objectStore('msgchunks');
			const until = performance.now() + holdMs;
			let n = 0;
			const spin = () => { const g = st.count(); g.onsuccess = () => { n++; if (performance.now() < until) spin(); }; };
			spin();
			tx.oncomplete = () => { marks.holdRequests = n; };
			setTimeout(res, 0);		// return to the caller at once; the transaction keeps spinning
		});
	}
	const t0 = performance.now();
	const cut = (c) => c.id.startsWith(fillTag + '-') && Array.isArray(c.messages) && c.messages.length > keep
		? Object.assign({}, c, { messages: c.messages.slice(0, keep), updatedAt: c.updatedAt + 1 }) : c;
	store.save(store.stored().map(cut));						// W1: its transaction is created in this tick; compactions follow it
	const mirror = store.stored();
	const r = mirror.find(c => c.id === cid);
	if (!r || !Array.isArray(r.messages) || !r.messages.length) return { err: 'the mirror entry holds no transcript in hand' };
	// Built as `persistChats` builds every record it saves (`slimChat`): no fp, bytes or seed.
	const r2 = Object.assign({}, r, { messages: r.messages.concat([newMsg]), updatedAt: r.updatedAt + 1 });
	delete r2.fp; delete r2.bytes; delete r2.seed;
	store.save(mirror.map(c => c.id === cid ? r2 : c));			// W2: queued behind W1
	if (settle) await store.settled();
	marks.collectStart = Math.round(performance.now() - t0);
	const parcel = await window.DaimondCore.collectSync();			// persistChats, then the reads
	marks.collectMs = Math.round(performance.now() - t0);
	if (hold) { try { hold.close(); } catch (e) {} }
	const e = (parcel.chats || []).find(c => c.id === cid) || null;
	const sum = store.stored().find(c => c.id === cid) || {};
	return { marks, ref: !!(e && e.messagesRef), key: e && e.messagesRef ? e.messagesRef.key : '',
		inlineMids: e && Array.isArray(e.messages) ? e.messages.map(m => m.mid) : null, fp: sum.fp, seed: sum.seed };
}, { cid, newMsg, fillTag, keep, settle, holdMs });

const PROFILE = scratch('pw', 'stalefp-' + BROWSER + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });
let A = null;
try {
	console.log(`\n-- a collect behind a queued write lands no stale fp (QA F-1)${BREAK ? '  [--break ' + BREAK + ']' : ''} --`);
	A = await open({ name: 'stalefp', profile: PROFILE, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(A); await signInAs(A, 'stalefp'); await ready(A);
	await wireCloud(A, 'A');

	// The fillers, saved whole once; every later save of them shortens the copy in hand, which
	// queues one compaction per filler behind the commit (the write's own tail).
	await A.page.evaluate(async (fill) => { const store = window.DaimondCore.chatStore(); store.save(store.stored().concat(fill)); await store.settled(); }, fillers('f', FILL));

	// ── 1. The chat, seeded and offloaded once: fp, seed and manifest all agree.
	const C = 'stalefp-c';
	const H1 = [...pad('c'), { role: 'user', content: 'what is three plus three', mid: 'u1', iturn: 'u1', ts: T0 - 5, at: T0 - 5 }];
	await putChat(A.page, rec(C, H1, T0));
	const c0 = await collectEntry(A.page, C);
	const s0 = await served(A.page, C);
	check('1. the seeded chat offloads (over SYNC_FILE_MAX) and its fp is the store\'s', c0.ref && !!c0.key && c0.fp === s0.fp && c0.maniFp === s0.fp,
		JSON.stringify({ ref: c0.ref, key: c0.key.slice(0, 12), fpEq: c0.fp === s0.fp }));
	const K0 = c0.key;

	// ── 2. The race: the collect begins while W1 is held and W2 is queued behind it.
	const ans = { role: 'assistant', content: 'THE ANSWER THAT MUST TRAVEL', mid: 'a1', iturn: 'u1', ts: T0 - 4, at: T0 - 4 };
	const newSeed = fileHash(JSON.stringify(H1.concat([ans])));
	const r = await race(A.page, C, ans, 'f', MSGS - 20, false, HOLD);
	if (r.err) throw new Error(r.err);
	const s1 = await served(A.page, C);
	note('race marks (ms from W1 save): ' + JSON.stringify({ collectStart: r.marks.collectStart, collectMs: r.marks.collectMs }));
	if (HOLD > 0) {
		check('2. the race is live: the collect began inside the hold, behind W1 and the queued W2', r.marks.collectStart < HOLD,
			'collect began at ' + r.marks.collectStart + ' ms, hold ' + HOLD + ' ms');
	}
	check('2. the store serves the moved transcript (a1 is on disk)', s1.mids.includes('a1'), s1.mids.slice(-3).join(','));
	const named = r.ref ? r.key !== K0 : !!(r.inlineMids && r.inlineMids.includes('a1'));
	check('2. the collect names the MOVED transcript, not the old manifest', named,
		r.ref ? 'key ' + (r.key || '').slice(0, 12) + (r.key === K0 ? ' is K0, the old manifest' : ' (K0 ' + K0.slice(0, 12) + ')') : 'inline');
	check('2. the mirror\'s fp is the store\'s for the moved copy, on the moved copy\'s seed', r.fp === s1.fp && r.seed === newSeed,
		JSON.stringify({ fp: (r.fp || '').slice(0, 12), storeFp: s1.fp.slice(0, 12), seedIsNewCopy: r.seed === newSeed }));

	// ── 3. It holds across a reload: the collect's persistChats rebuilds every record as it does
	// in life (slimChat, the residency markers), and a quiet collect, and another, name the same.
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(A); await signInAs(A, 'stalefp'); await ready(A); await patchCloud(A, 'A');
	const c2 = await collectEntry(A.page, C);
	const c3 = await collectEntry(A.page, C);
	const s2 = await served(A.page, C);
	check('3. after a reload the next collect names the moved transcript, its fp the store\'s and the manifest\'s',
		c2.ref && c2.key !== K0 && c2.fp === s2.fp && c2.maniFp === s2.fp,
		JSON.stringify({ key: c2.key.slice(0, 12), K0: K0.slice(0, 12), fpEq: c2.fp === s2.fp, maniEq: c2.maniFp === s2.fp }));
	check('3. and the one after it', c3.ref && c3.key === c2.key && c3.fp === s2.fp, c3.key.slice(0, 12));
	check('3. the transcript the parcel names is the one the device holds (a1 included)', s2.mids.includes('a1') && s2.fp === c3.maniFp);

	// ── 4. The control: the same race with the store settled before the collect.
	const D = 'stalefp-d';
	await putChat(A.page, rec(D, [...pad('d'), { role: 'user', content: 'control', mid: 'du1', iturn: 'du1', ts: T0 - 5, at: T0 - 5 }], T0));
	const d0 = await collectEntry(A.page, D);
	const dr = await race(A.page, D, Object.assign({}, ans, { mid: 'da1', iturn: 'du1' }), 'f', MSGS - 30, true, HOLD);
	await A.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(A); await signInAs(A, 'stalefp'); await ready(A); await patchCloud(A, 'A');
	const d2 = await collectEntry(A.page, D);
	const ds = await served(A.page, D);
	check('4. control: with the store settled first, the collect offloads the moved transcript and fp is the store\'s',
		dr.ref && dr.key !== d0.key && dr.fp === ds.fp && d2.key === dr.key,
		JSON.stringify({ key: (dr.key || '').slice(0, 12), d0: (d0.key || '').slice(0, 12), fpEq: dr.fp === ds.fp, afterReload: (d2.key || '').slice(0, 12) }));
} catch (e) {
	console.log('VERIFIER THREW:', e && (e.stack || e.message || e));
	bad.push('verifier threw: ' + (e && e.message));
} finally {
	try { await A?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
