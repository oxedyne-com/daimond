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
// THE PROPERTY:
//   Phase A (durable): a large chat offloads; the commit-declared live set names
//     every chunk the parcel's `messagesRef` points at (arm 4, read live), and the
//     chunks survive the commit.
//   Phase B (quota): with A's localStorage FULL, a large chat's index write is
//     lost — A refuses to commit (arm 3) and rides the transcript inline — the chat
//     PROPAGATES to B with its whole body, and HOLDS across a second sync round
//     (never re-swept to empty).
//
// --break reverts BOTH belts (cloud.js forgets the lost write; daimond.js commits
// the bare index): A then commits a frozen index that omits the stranded chunk and
// sweeps it, so B's chat arrives EMPTY — the pre-fix stranding, driven from here.
//
//   node dev/verify_quotamanifest_sync.mjs           # the gate (must be green)
//   node dev/verify_quotamanifest_sync.mjs --break    # pre-fix stranding (must redden)
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
	{ file: 'js/cloud.js',   want: 'else indexDirty = indexDirty || { at: Date.now() };', why: 'setIndex does not remember a lost write (arm 3)' },
	{ file: 'js/cloud.js',   want: 'function indexDurable() { return !indexDirty; }',     why: 'indexDurable is missing' },
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
	// Arm 3 undone: setIndex forgets a write it could not land, so `contentSet`
	// always answers true and `indexDurable()` never goes false -> the device
	// commits a frozen index and rides the transcript as a REF, not inline.
	patchOnce('js/cloud.js',
		'var ok = writeJson(IX_KEY, ix || {});\n\t\tif (ok) indexDirty = null;\n\t\telse indexDirty = indexDirty || { at: Date.now() };\n\t\treturn ok;',
		'writeJson(IX_KEY, ix || {});\n\t\treturn true;   // --break: quota forgotten (arm 3 undone)');
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
		return { hasRef: !!ref, refAddrs, allNamed: refAddrs.length > 0 && refAddrs.every(a => prAddrs.has(a)),
			indexDurable: window.DaimondCloud.indexDurable() };
	}, C1);
	check('Phase A: the large chat offloaded to a messagesRef', invA.hasRef === true, `${invA.refAddrs.length} chunk(s)`);
	check('Phase A: parcelRefs names every chunk the parcel\'s messagesRef points at (arm 4)',
		invA.allNamed === true, `${invA.refAddrs.length} ref chunk(s), all named=${invA.allNamed}`);

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

	// ═══ PHASE B — the quota path: a stranded write does not lose the transcript ═══
	console.log('\n— Phase B: A\'s localStorage is full; the chat still reaches B —');

	// Seed the second large chat while there is still room to hold it in IndexedDB.
	await A.page.evaluate(({ cid, body }) => {
		const store = window.DaimondCore.chatStore();
		const now = Date.now();
		const list = store.stored();
		list.push({ id: cid, name: 'Phase B', model: 'mock/fast', updatedAt: now, metaAt: now,
			messages: [{ role: 'user', content: body, mid: 'b0', ts: now }], session: null });
		store.save(list);
	}, { cid: C2, body: BIG(MK2) });

	// The quota moment, made deterministic and scoped: the index key
	// (`daimond-cloud-index`, whatever the per-account prefix) can no longer be
	// written, while every other write — the sync cursors, the chat's own store —
	// still lands. This is precisely "a manifest write lost to quota": the growing
	// index is the one key that no longer fits, which is the frozen-index committer's
	// exact condition and what the fill in verify_chatdelete_sync's quota arm models
	// for a smaller key. A blanket-full localStorage frees a slice big enough for the
	// tiny index and never reproduces it.
	const armed = await A.page.evaluate(() => {
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
		window.__blockIndex = true;
		inst.setItem = function (k, v) {
			if (window.__blockIndex && String(k).indexOf('daimond-cloud-index') !== -1) {
				const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
			}
			return window.__lsRealSet(k, v);
		};
		// Prove the block bites: a direct write of the index key must throw now.
		let threw = '';
		try { localStorage.setItem('daimond-cloud-index', '{}'); }
		catch (e) { threw = e.name || String(e); }
		return { threw };
	});
	check('Phase B: the index key can no longer be written (quota on the growing index)',
		armed.threw === 'QuotaExceededError', 'setItem(index) -> ' + armed.threw);

	// The push: the collector offloads C2 but the index write is lost.
	await A.page.evaluate(() => { window.__ds = []; });
	await push(A);
	const aState = await A.page.evaluate(() => {
		const ds = (window.__ds || []).filter(e => e.kind === 'sync' && e.payload && e.payload.commit);
		return { indexDurable: window.DaimondCloud.indexDurable(), mayCommit: window.DaimondCore.syncMayCommitChunks(),
			reason: (window.DaimondCore.syncCommitBlockedReason && window.DaimondCore.syncCommitBlockedReason()) || '',
			commitEvents: ds.map(e => ({ commit: e.payload.commit, why: e.payload.why || '' })) };
	});
	note(`A after quota push: indexDurable=${aState.indexDurable} mayCommit=${aState.mayCommit} reason=${aState.reason} events=${JSON.stringify(aState.commitEvents)}`);
	check('Phase B: A\'s index went non-durable — the lost write is remembered (arm 3)', aState.indexDurable === false, 'indexDurable=' + aState.indexDurable);
	check('Phase B: A REFUSES to commit a live set from a non-durable index (arm 3)',
		aState.mayCommit === false && aState.commitEvents.some(e => e.commit === 'refused' && e.why === 'index-not-durable'),
		`mayCommit=${aState.mayCommit} reason=${aState.reason}`);

	// The chat must still have reached B — the transcript rode inline rather than
	// being declared as a swept-away reference.
	await pull(B);
	const b2 = await bChat(B.page, C2, MK2);
	check('Phase B: the chat PROPAGATED to B with its body despite the full localStorage',
		b2.present && b2.count >= 1 && b2.body === true, `present=${b2.present} count=${b2.count} body=${b2.body}`);

	// And it HOLDS across a further round — never re-offloaded to a ref the next
	// commit sweeps, so B does not lose it on the round after.
	await push(A); await pull(B); await push(B); await pull(A);
	const b3 = await bChat(B.page, C2, MK2);
	check('Phase B: and it HOLDS across a second sync round (not re-swept to empty)',
		b3.present && b3.count >= 1 && b3.body === true, `present=${b3.present} count=${b3.count} body=${b3.body}`);

	// Lift the block; the next collect records the manifest it could not, and
	// durability recovers (indexDirty is sticky until a setIndex lands).
	const recovered = await A.page.evaluate(async () => {
		window.__blockIndex = false;
		await window.DaimondCore.collectSync();   // re-offloads C2 -> contentSet -> setIndex lands
		return window.DaimondCloud.indexDurable();
	});
	check('Phase B: with the index writable again, the write lands and durability recovers', recovered === true, 'indexDurable=' + recovered);

} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await A?.close?.(); } catch (e) {}
	try { await B?.close?.(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
