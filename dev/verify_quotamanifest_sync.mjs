// gateway: none
// verify_quotamanifest_sync.mjs — S-SYNC #2, the two-device frozen-index driver.
//
// THE BUG. `cloud.js writeJson` returns false on quota and every index writer
// ignored it. A chat over the inline threshold offloads its transcript to chunks
// and records the manifest with `contentSet` — but if that index write is lost to
// a full localStorage, the parcel still carries a `messagesRef` naming the uploaded
// chunks, while `state.chunked` (the index the ONE commit declares live) does not.
// The gateway sweeps every chunk the committed index does not name, so the far
// device gets an EMPTY chat, re-swept every round: a transcript stranded off every
// other device, silently and permanently.
//
// THE FIX (committed 092fb0e9), two belts, both exercised here on two REAL devices
// over one shared cloud whose commit sweeps exactly as the gateway does:
//   * a commit is declared only from a DURABLE index — `syncMayCommitChunks()` is
//     false while `indexDurable()` is (arm 3), so a quota-stuck device sweeps
//     nothing and its collector rides the transcript INLINE that round, which is
//     how the chat still reaches the peer;
//   * when a device DOES commit, the live set is `parcelRefs(state)` — the index
//     UNION every `messagesRef`/`dataRef`/`msgRef` the parcel names (arm 4), so the
//     declared set can never omit an address the pushed parcel points at.
//
// WHERE THE INDEX LIVES NOW (2026-09-27, release 5.2 triage). The index left the
// localStorage box for IndexedDB on 2026-09-21 (531d38e4), and fix/r52-del (98134aa5,
// SIM-24) made a write ops on paths, joined into the stored map in one transaction
// (`DaimondDurable.update`) and held `dirty` until that transaction commits. A full box
// therefore no longer touches the index: Phase B's old `setItem` block stopped biting
// on 2026-09-21, so its two arm-3 checks read "indexDurable=true" through release
// 5.1.1, and 5.2's two-path `indexDurable` broke the seam this file matched, so it exited
// 2 before it ran. The loss is now injected at the door the index is really written
// through: the index key's put in the `kv` store aborts its transaction, which is how a
// QuotaExceededError arrives. The box is blocked as well, for a device on the fallback.
//
// THE PROPERTY:
//   Phase A (durable): a large chat offloads; the commit-declared live set names
//     every chunk the parcel's `messagesRef` points at (arm 4, read live), and still
//     names them from an index that lost the chat's manifest (arm 4, alone); the
//     chunks survive the commit.
//   Phase B (a lost write): with A's index write refused, the write is held dirty,
//     not forgotten (arm 3), A refuses to commit, the chat PROPAGATES to B with its
//     whole body and HOLDS across a second sync round (never re-swept to empty), and
//     once the door opens the held write lands in the store.
//
// --break reverts BOTH belts (cloud.js answers every index durable; daimond.js commits
// the bare index), and the checks that read each belt redden: Phase A's lost-manifest
// check and Phase B's arm-3 pair. B's copy no longer goes EMPTY under it: the durable
// path's mirror names the manifest the store refused, so the live set carries it
// anyway. The empty chat needed the box path, which a browser with IndexedDB does not
// take; `www/js/quotamanifest.test.mjs` drives that path.
//
//   node dev/verify_quotamanifest_sync.mjs           # the gate (must be green)
//   node dev/verify_quotamanifest_sync.mjs --break    # both belts undone (must redden)
//
// Chromium only for --break (page.route). Needs dev/serve.mjs; no gateway, no mock.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, scratch, BROWSER } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);

const BREAK = process.argv.includes('--break');
if (BREAK && BROWSER !== 'chromium') {
	console.error(`--break serves edited files through page.route, which does not fire under ${BROWSER}. Run under Chromium.`);
	process.exit(2);
}

// ── The seams must be present, or a green run would prove nothing ─────
const SEAM = [
	{ file: 'js/cloud.js',   want: 'else indexDirty = indexDirty || { at: Date.now() };', why: 'the box path does not remember a lost write (arm 3)' },
	{ file: 'js/cloud.js',   want: 'if (!Object.keys(km.pend).length) km.dirty = null;', why: 'the durable path does not hold a write dirty until it commits (arm 3)' },
	{ file: 'js/cloud.js',   want: 'function indexDurable() { return _durableMode ? !IXM.dirty : !indexDirty; }', why: 'indexDurable is missing, or does not read the path the index is on' },
	{ file: 'js/daimond.js', want: 'function parcelRefs(state) {',                         why: 'parcelRefs is missing (arm 4)' },
	{ file: 'js/daimond.js', want: 'DaimondCloud.indexDurable && !DaimondCloud.indexDurable()', why: 'the commit gate does not consult indexDurable' },
];
for (const s of SEAM) {
	const src = fs.readFileSync(path.join(WWW, s.file), 'utf8');
	if (!src.includes(s.want) && !BREAK) { console.error(`seam missing: ${s.file}: ${s.why}`); process.exit(2); }
}

// ── The break: revert BOTH belts (the whole #2 invariant) ─────────────
const PATCHED = new Map();
function patchOnce(file, find, repl) {
	const cur = PATCHED.get(file) || fs.readFileSync(path.join(WWW, file), 'utf8');
	const n = cur.split(find).length - 1;
	if (n !== 1) { console.error(`break anchor in ${file} appears ${n} times (expected 1)`); process.exit(2); }
	PATCHED.set(file, cur.replace(find, repl));
}
if (BREAK) {
	// Arm 3 undone: a write that did not land is forgotten, so `indexDurable()` never
	// goes false on either path and the device commits over an index the store lacks.
	patchOnce('js/cloud.js',
		'function indexDurable() { return _durableMode ? !IXM.dirty : !indexDirty; }',
		'function indexDurable() { return true; }   // --break: a lost write forgotten (arm 3 undone)');
	// Arm 4 undone: the commit declares the bare index, not the parcel's refs, so a
	// ref the frozen index never recorded is omitted from the live set and swept.
	patchOnce('js/daimond.js',
		'function add(key, ref) {\n\t\t\tif (!ref || !Array.isArray(ref.chunks) || !ref.chunks.length) return;',
		'function add(key, ref) {\n\t\t\treturn;   // --break: the bare index alone (arm 4 undone)\n\t\t\tif (!ref || !Array.isArray(ref.chunks) || !ref.chunks.length) return;');
}
async function patchedSource(page) {
	if (!PATCHED.size) return;
	for (const [f, body] of PATCHED) {
		await page.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'application/javascript', body }));
	}
}

// ═══════════════════════════════════════════════════════════════════════
// THE CLOUD, in this process, shared by both contexts. The commit sweeps the
// un-graced way: everything the committing live set does not name goes.
// ═══════════════════════════════════════════════════════════════════════
const cloud = { mailbox: null, chunks: new Map(), pushes: [], commits: [] };
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
		if (body.op === 'commit') {
			const live = new Set((body.chunks || []).map(c => c.addr));
			let swept = 0;
			for (const a of [...cloud.chunks.keys()]) { if (!live.has(a)) { cloud.chunks.delete(a); swept++; } }
			cloud.commits.push({ dev, live: live.size, swept });
			return { status: 200, json: { ok: true, swept, free_allowance: 0, paid_bytes: 0 } };
		}
		return { status: 200, json: { ok: true } };
	}
	return { status: 200, json: { ok: true } };
}
async function wireCloud(s, dev) {
	await s.page.exposeFunction('__cloudCall', async (p, method, body) => serve(dev, p, method, body));
	await s.page.evaluate((dev) => {
		window.__dev = dev; window.__ds = [];
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
		window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
		window.DaimondGateway.gwFetch = async function (p, opts) {
			const r = await window.__cloudCall(String(p), (opts && opts.method) || 'GET', String((opts && opts.body) || ''));
			return { status: r.status, json: async () => r.json };
		};
	}, dev);
}

const ready = (s) => s.page.waitForFunction(
	() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.applySync && DaimondCore.chatStore
		&& DaimondCore.parcelRefs && DaimondCore.syncMayCommitChunks
		&& window.DaimondSync && window.DaimondChunks && window.DaimondChunks.offloadBytes
		&& window.DaimondCloud && DaimondCloud.indexDurable && window.DaimondGateway && window.DaimondIdentity),
	null, { timeout: 20000 });
const push = async (s) => { await s.page.evaluate(() => window.DaimondSync.push()); await s.page.waitForTimeout(600); };
const pull = async (s) => { await s.page.evaluate(() => window.DaimondSync.pull()); await s.page.waitForTimeout(600); };

/// A big message so the chat is over SYNC_FILE_MAX (128 KiB) and must offload,
/// but under the 2 MiB inline-chat budget so it can ride inline when offload fails.
const BIG = (marker) => marker + ' ' + 'w'.repeat(200 * 1024);

/// B's copy of a chat: how many messages it holds and whether the big body arrived.
const bChat = (pg, id, marker) => pg.evaluate(async ({ cid, mk }) => {
	const store = window.DaimondCore.chatStore();
	const rec = (store.stored() || []).find(c => c.id === cid) || null;
	if (!rec) return { present: false, count: 0, body: false };
	let msgs = [];
	try { const got = await store.loadMessages(cid); msgs = (got && got.messages) || []; } catch (e) { msgs = []; }
	return { present: true, count: msgs.length, body: msgs.some(m => String(m.content || '').indexOf(mk) !== -1) };
}, { cid: id, mk: marker });

const PROFILE_A = scratch('pw', 'qman-a-' + BROWSER + (BREAK ? '-break' : ''));
const PROFILE_B = scratch('pw', 'qman-b-' + BROWSER + (BREAK ? '-break' : ''));
for (const d of [PROFILE_A, PROFILE_B]) fs.rmSync(d, { recursive: true, force: true });

const C1 = 'quota-chat-1', C2 = 'quota-chat-2';
const MK1 = 'phaseA-marker-3d1f', MK2 = 'phaseB-marker-8be0';

let A = null, B = null;
try {
	console.log(`\n— S-SYNC #2: a quota-stuck device does not strand a transcript${BREAK ? '  [--break]' : ''} —`);

	A = await open({ name: 'qman-a', profile: PROFILE_A, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(A); await signInAs(A, 'qman'); await ready(A);
	const bundle = await A.page.evaluate(() => window.DaimondIdentity.exportBundle());
	B = await open({ name: 'qman-b', profile: PROFILE_B, signIn: false, connect: false, defaults: false, route: patchedSource });
	await ready(B);
	await B.page.evaluate((b) => window.DaimondIdentity.importBundle(b), bundle);
	await B.page.reload({ waitUntil: 'domcontentloaded' });
	await ready(B); await signInAs(B, 'qman'); await ready(B);
	await wireCloud(A, 'A'); await wireCloud(B, 'B');

	const bMay = await A.page.evaluate(() => window.DaimondCore.syncMayCommitChunks());
	check('A is a committer (a sandbox, may declare the live set)', bMay === true, 'mayCommit=' + bMay);

	// ═══ PHASE A — the durable path: the commit names every ref the parcel points at ═══
	console.log('\n— Phase A: a large chat offloads; the live set names its chunks (arm 4) —');
	await A.page.evaluate(({ cid, body }) => {
		const store = window.DaimondCore.chatStore();
		const now = Date.now();
		const list = store.stored();
		list.push({ id: cid, name: 'Phase A', model: 'mock/fast', updatedAt: now, metaAt: now,
			messages: [{ role: 'user', content: body, mid: 'a0', ts: now }], session: null });
		store.save(list);
	}, { cid: C1, body: BIG(MK1) });

	const invA = await A.page.evaluate(async (cid) => {
		const state = await window.DaimondCore.collectSync();
		const chat = (state.chats || []).find(c => c.id === cid) || null;
		const ref = chat && chat.messagesRef;
		const pr = window.DaimondCore.parcelRefs(state);
		const prAddrs = new Set();
		Object.keys(pr).forEach(k => ((pr[k] || {}).chunks || []).forEach(c => prAddrs.add(c.addr)));
		const refAddrs = ref ? (ref.chunks || []).map(c => c.addr) : [];
		// The belt on its own. The durable index names the manifest, so the check above
		// passes on the index alone; the index this parcel was collected with, less the
		// chat's manifest, is the index a lost write leaves, and the ref must still be
		// declared from it.
		const lost = Object.assign({}, state.chunked || {});
		const hadKey = Object.prototype.hasOwnProperty.call(lost, '@c/' + cid);
		delete lost['@c/' + cid];
		const pl = window.DaimondCore.parcelRefs(Object.assign({}, state, { chunked: lost }));
		const plAddrs = new Set();
		Object.keys(pl).forEach(k => ((pl[k] || {}).chunks || []).forEach(c => plAddrs.add(c.addr)));
		return { hasRef: !!ref, refAddrs, allNamed: refAddrs.length > 0 && refAddrs.every(a => prAddrs.has(a)),
			hadKey, lostNamed: refAddrs.length > 0 && refAddrs.every(a => plAddrs.has(a)),
			indexDurable: window.DaimondCloud.indexDurable() };
	}, C1);
	check('Phase A: the large chat offloaded to a messagesRef', invA.hasRef === true, `${invA.refAddrs.length} chunk(s)`);
	check('Phase A: parcelRefs names every chunk the parcel\'s messagesRef points at (arm 4)',
		invA.allNamed === true, `${invA.refAddrs.length} ref chunk(s), all named=${invA.allNamed}`);
	check('Phase A: and names them from an index that lost the chat\'s manifest (arm 4, alone)',
		invA.hadKey === true && invA.lostNamed === true,
		`the index held the manifest=${invA.hadKey}, named without it=${invA.lostNamed}`);

	await push(A); await pull(B);
	const b1 = await bChat(B.page, C1, MK1);
	check('Phase A: B received the chat with its full body', b1.present && b1.count >= 1 && b1.body === true,
		`present=${b1.present} count=${b1.count} body=${b1.body}`);
	const survived = await A.page.evaluate(async (addrs) => {
		const r = await window.DaimondChunks.presence(addrs);
		return { ok: r.ok, missing: r.missing.length };
	}, invA.refAddrs);
	check('Phase A: the commit did NOT sweep the chunks the parcel referenced', survived.ok === true && survived.missing === 0,
		`${survived.missing} of ${invA.refAddrs.length} missing`);

	// ═══ PHASE B — a lost index write does not lose the transcript ═══
	console.log('\n— Phase B: A\'s index write is lost; the chat still reaches B —');

	// Seed the second large chat while there is still room to hold it in IndexedDB.
	await A.page.evaluate(({ cid, body }) => {
		const store = window.DaimondCore.chatStore();
		const now = Date.now();
		const list = store.stored();
		list.push({ id: cid, name: 'Phase B', model: 'mock/fast', updatedAt: now, metaAt: now,
			messages: [{ role: 'user', content: body, mid: 'b0', ts: now }], session: null });
		store.save(list);
	}, { cid: C2, body: BIG(MK2) });

	// The lost write, made deterministic and scoped: the index key
	// (`daimond-cloud-index`) can no longer be written, while every other write -- the
	// sync cursors, the tombstones beside it in the same store, the chat's own store --
	// still lands. The growing index is the one key that no longer fits, which is the
	// frozen-index committer's exact condition.
	//
	// AT THE DOOR THE INDEX IS ON. In IndexedDB (durable.js `update`) the put is issued
	// and its transaction aborted, which is how a quota refusal arrives there: the
	// request fails, the transaction aborts, nothing throws in the page. In the box
	// (the fallback, no IndexedDB) the instance's `setItem` throws, as before.
	const armed = await A.page.evaluate(async () => {
		window.__blockIndex = true;
		window.__ixRefused  = 0;
		if (!window.__idbRealPut) window.__idbRealPut = IDBObjectStore.prototype.put;
		IDBObjectStore.prototype.put = function (val, key) {
			const rq = window.__idbRealPut.apply(this, arguments);
			if (window.__blockIndex && this.name === 'kv' && String(key).indexOf('daimond-cloud-index') !== -1) {
				window.__ixRefused++;
				try { this.transaction.abort(); } catch (e) { /* already over */ }
			}
			return rq;
		};
		// accounts.js installs an INSTANCE-OWN setItem (the per-account namespacer) and
		// calls the raw prototype method it captured earlier, so a prototype patch is
		// bypassed. Wrap the instance method the app actually calls; the key here is the
		// un-prefixed one the module passes (`daimond-cloud-index`).
		const inst = window.localStorage;
		// A Storage object coerces an assignment to an unknown property into a stored
		// string (`storage.foo = fn` is setItem('foo', String(fn))), so the original
		// setItem is kept in `window`, not on the instance. Assigning `setItem` itself
		// DOES shadow the method (accounts.js relies on the same).
		if (!window.__lsRealSet) window.__lsRealSet = inst.setItem.bind(inst);
		inst.setItem = function (k, v) {
			if (window.__blockIndex && String(k).indexOf('daimond-cloud-index') !== -1) {
				const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
			}
			return window.__lsRealSet(k, v);
		};
		// Prove the block bites at the door this device's index is written through. The
		// write is the stored map unchanged, so nothing moves if it does land.
		const durable = !!(window.DaimondDurable && DaimondDurable.durable && DaimondDurable.durable());
		let bit = '';
		if (durable) {
			const r = await DaimondDurable.update('daimond-cloud-index', (v) => v || {});
			bit = (r && r.ok === false) ? 'refused' : 'landed';
		} else {
			try { localStorage.setItem('daimond-cloud-index', '{}'); bit = 'landed'; }
			catch (e) { bit = (e.name === 'QuotaExceededError') ? 'refused' : (e.name || String(e)); }
		}
		return { durable, bit };
	});
	note(`A keeps its index in ${armed.durable ? 'IndexedDB (the durable path)' : 'the localStorage box (the fallback)'}`);
	check('Phase B: the index key can no longer be written, at the door it is written through',
		armed.bit === 'refused', `${armed.durable ? 'DaimondDurable.update' : 'setItem'}(index) -> ${armed.bit}`);

	// The push: the collector offloads C2 but the index write is lost.
	await A.page.evaluate(() => { window.__ds = []; window.__ixRefused = 0; });
	await push(A);
	const aState = await A.page.evaluate(async (cid) => {
		const ds = (window.__ds || []).filter(e => e.kind === 'sync' && e.payload && e.payload.commit);
		let stored = null;
		try { stored = window.DaimondDurable ? await DaimondDurable.get('daimond-cloud-index') : null; } catch (e) { stored = null; }
		return { indexDurable: window.DaimondCloud.indexDurable(), mayCommit: window.DaimondCore.syncMayCommitChunks(),
			reason: (window.DaimondCore.syncCommitBlockedReason && window.DaimondCore.syncCommitBlockedReason()) || '',
			commitEvents: ds.map(e => ({ commit: e.payload.commit, why: e.payload.why || '' })),
			refused: window.__ixRefused | 0,
			mirrorHas: !!(window.DaimondCloud.index() || {})['@c/' + cid],
			storeHas:  !!(stored && stored['@c/' + cid]) };
	}, C2);
	note(`A after the lost write: indexDurable=${aState.indexDurable} mayCommit=${aState.mayCommit} reason=${aState.reason} refused=${aState.refused} mirror=${aState.mirrorHas} store=${aState.storeHas} events=${JSON.stringify(aState.commitEvents)}`);
	check('Phase B: the push\'s index write really was refused, so the checks below are not vacuous',
		armed.durable ? (aState.refused > 0 && aState.mirrorHas && !aState.storeHas) : true,
		armed.durable ? `${aState.refused} refused, C2's manifest in the mirror=${aState.mirrorHas}, in the store=${aState.storeHas}` : 'the box path');
	check('Phase B: A\'s index went non-durable — the lost write is held, not forgotten (arm 3)',
		aState.indexDurable === false, 'indexDurable=' + aState.indexDurable);
	check('Phase B: A REFUSES to commit a live set from a non-durable index (arm 3)',
		aState.mayCommit === false && aState.commitEvents.some(e => e.commit === 'refused' && e.why === 'index-not-durable'),
		`mayCommit=${aState.mayCommit} reason=${aState.reason}`);

	// The chat must still have reached B: by reference on the durable path, whose chunks
	// no commit has swept, or inline on the box path, whose collector gave up the ref.
	await pull(B);
	const b2 = await bChat(B.page, C2, MK2);
	check('Phase B: the chat PROPAGATED to B with its body despite the lost index write',
		b2.present && b2.count >= 1 && b2.body === true, `present=${b2.present} count=${b2.count} body=${b2.body}`);

	// And it HOLDS across a further round — never re-offloaded to a ref the next
	// commit sweeps, so B does not lose it on the round after.
	await push(A); await pull(B); await push(B); await pull(A);
	const b3 = await bChat(B.page, C2, MK2);
	check('Phase B: and it HOLDS across a second sync round (not re-swept to empty)',
		b3.present && b3.count >= 1 && b3.body === true, `present=${b3.present} count=${b3.count} body=${b3.body}`);

	// Lift the block. The write the store refused is still queued (cloud.js `flush`
	// queues it again), so it lands with the next write or the next `settle`, and
	// durability recovers; on the box path the next collect records it again.
	const recovered = await A.page.evaluate(async (cid) => {
		window.__blockIndex = false;
		await window.DaimondCore.collectSync();
		if (window.DaimondCloud.settle) await window.DaimondCloud.settle();
		let stored = null;
		try { stored = window.DaimondDurable ? await DaimondDurable.get('daimond-cloud-index') : null; } catch (e) { stored = null; }
		return { durable: window.DaimondCloud.indexDurable(), storeHas: !!(stored && stored['@c/' + cid]) };
	}, C2);
	check('Phase B: with the index writable again, the write lands and durability recovers',
		recovered.durable === true, 'indexDurable=' + recovered.durable);
	if (armed.durable) {
		check('Phase B: and the manifest the refused write held is in the store now, not lost with it',
			recovered.storeHas === true, 'in the store=' + recovered.storeHas);
	}

} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await A?.close?.(); } catch (e) {}
	try { await B?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
