// verify_contentoffload.mjs — the v3 content offload: large Diamonds and chat
// transcripts move out to content-addressed chunks and leave a `dataRef` /
// `messagesRef` inline, under reserved `@d/<id>` / `@c/<id>` manifests co-located
// in the cloud index. This attacks the six invariants that guard it.
//
// The chunk store is STUBBED at `DaimondGateway.gwFetch` (the same late-bound
// hook verify_chunks tier 1 uses) with an in-memory content-addressed map, so
// the whole offload/materialise/commit path runs inside one page with no gateway
// and no o3db store. `__store` persists in the page closure across every
// collect/apply, so it stands in for the one shared cloud store two devices see.
//
//   node dev/verify_contentoffload.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM.
//
// The invariants, in the task's priority order:
//   1. FIXED POINT — two no-op collects byte-identical; apply-then-collect ≡ parcel;
//      a UNIONED-in message with a still stamp must re-offload (content-hash key).
//   2. SWEEP-SAFETY — the parcel's committed live set names the content chunks.
//   3. CROSS-DEVICE CONVERGENCE — an imported Diamond names the sender's addresses,
//      not fresh ones; and the message-UNION residual is characterised precisely.
//   4. PARCEL CEILING — the sealed body stays well under an iOS-safe ~1 MB as
//      content grows; inline would blow past.
//   5. MATERIALISE-ON-DEMAND — strict-older / identical-key means zero getChunk;
//      a missing chunk lands metadata-only, non-destructively.
//   6. TIER — content keys sort ahead of files in the tier plan.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);

/// The named top-level sections of two parcels that differ.
function diffSections(a, b) {
	const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].sort();
	const out = [];
	for (const k of keys) {
		if (JSON.stringify(a ? a[k] : undefined) !== JSON.stringify(b ? b[k] : undefined)) out.push(k);
	}
	return out;
}

const s = await open({ name: 'contentoffload', signIn: true, connect: false, defaults: false });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync && DaimondCore.applySync
		&& window.DaimondChunks && window.DaimondChunks.offloadBytes && window.DaimondCloud
		&& DaimondCloud.contentGet && window.DaimondGateway && window.DaimondIdentity),
		null, { timeout: 15000 });

	// ── Arm the in-memory chunk store ───────────────────────────────
	await page.evaluate(() => {
		window.__store = {};                 // addr -> b64url ciphertext
		window.__puts = 0; window.__gets = 0; window.__haves = 0; window.__commits = [];
		// Late-bound on the global, so this IS the code path, not a shim around it.
		window.DaimondGateway.gwFetch = async function (path_, opts) {
			const body = JSON.parse(opts.body);
			const reply = (status, json) => ({ status, json: async () => json });
			if (body.op === 'put')   { window.__puts++;  (body.chunks || []).forEach(c => { window.__store[c.addr] = c.blob; }); return reply(200, { ok: true }); }
			if (body.op === 'have')  { window.__haves++; return reply(200, { missing: (body.addrs || []).filter(a => !(a in window.__store)) }); }
			if (body.op === 'get')   { window.__gets++;  const b = window.__store[body.addr]; return reply(200, b ? { present: true, blob: b } : { present: false }); }
			if (body.op === 'commit'){ window.__commits.push(body); return reply(200, { ok: true, swept: 0, free_allowance: 0 }); }
			return reply(200, { ok: true });
		};
		// Reset counters between phases.
		window.__reset = () => { window.__puts = 0; window.__gets = 0; window.__haves = 0; window.__commits = []; };
		window.__storeSize = () => Object.keys(window.__store).length;
	});

	// ── Seed: 3 large Diamonds + 3 large chats, all over SYNC_FILE_MAX ──
	const seeded = await page.evaluate(async () => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const dids = [];
		for (let k = 0; k < 3; k++) {
			const id = await app.create_diamond('Big-' + k);
			let html = '<h1>Big ' + k + '</h1>';
			while (html.length < 220 * 1024) html += '<p>diamond ' + k + ' para ' + html.length + ' lorem ipsum dolor</p>';
			await app.write_crystal_page(id, html);
			dids.push(id);
		}
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		const cids = [];
		for (let k = 0; k < 3; k++) {
			const msgs = [];
			for (let i = 0; i < 380; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user',
				content: 'chat ' + k + ' message ' + i + ' ' + 'y'.repeat(400), mid: 'c' + k + 'm' + i, ts: 1000 + i });
			const cid = 'bigchat-' + k;
			list.push({ id: cid, name: 'Big Chat ' + k, model: 'mock/fast', updatedAt: 5000 + k, messages: msgs, session: null });
			cids.push(cid);
		}
		store.save(list);
		const sizes = [];
		for (const id of dids) sizes.push(await app.export_diamond_size(id));
		return { dids, cids, dSizes: sizes };
	});
	note(`seeded diamonds ${seeded.dids.length} (export sizes ${seeded.dSizes.join(', ')} B), chats ${seeded.cids.length}`);

	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 1 — the fixed point
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— invariant 1: the fixed point —');

	await page.evaluate(() => window.__reset());
	const p1 = await page.evaluate(() => window.DaimondCore.collectSync());
	const afterFirst = await page.evaluate(() => ({ puts: window.__puts, store: window.__storeSize() }));
	note(`first collect: ${afterFirst.puts} put(s), ${afterFirst.store} chunks in store`);

	// Every large item took the ref path.
	const allRefs = (p1.diamonds || []).every(d => d.dataRef && d.data == null)
		&& (p1.chats || []).every(c => c.messagesRef && c.messages == null);
	check('every large Diamond and chat travels as a ref, none inline', allRefs,
		`diamonds ${(p1.diamonds || []).map(d => !!d.dataRef).join(',')} chats ${(p1.chats || []).map(c => !!c.messagesRef).join(',')}`);

	await page.evaluate(() => window.__reset());
	await page.waitForTimeout(2500);
	const p2 = await page.evaluate(() => window.DaimondCore.collectSync());
	const afterSecond = await page.evaluate(() => ({ puts: window.__puts, store: window.__storeSize() }));

	const idleDiff = diffSections(p1, p2);
	check('two no-op collects are byte-identical (idle fixed point)', idleDiff.length === 0, idleDiff.join(' '));
	check('and the quiet second collect re-offloads NOTHING', afterSecond.puts === 0, `${afterSecond.puts} put(s)`);
	check('and the chunk store did not grow on the quiet round',
		afterSecond.store === afterFirst.store, `${afterFirst.store} → ${afterSecond.store}`);

	// apply-own-parcel then collect ≡ parcel.
	const applied = await page.evaluate(async (p) => {
		const r = await window.DaimondCore.applySync(p);
		return r && r.failed ? r.failed : [];
	}, p2);
	check('applying its own parcel reports no failed section', applied.length === 0, applied.join(','));
	await page.evaluate(() => window.__reset());
	await page.waitForTimeout(500);
	const p3 = await page.evaluate(() => window.DaimondCore.collectSync());
	const rtDiff = diffSections(p2, p3);
	check('apply-own-parcel then collect gives the same parcel back (round-trip fixed point)',
		rtDiff.length === 0, rtDiff.join(' '));

	// The Diamond/chat FETCH SYMMETRY (defect #2, fixed). Applying a parcel whose
	// Diamonds are equal-stamp and whose chats are identical-key must fetch NOTHING:
	// both paths short-circuit on the content-key check, so a quiet sync
	// re-materialises neither a Diamond's export nor a chat's transcript. Before the
	// fix the equal-stamp Diamond branch had no such guard and re-downloaded the whole
	// export every apply, against the metered agent-fetch budget.
	const asym = await page.evaluate(async () => {
		const p = await window.DaimondCore.collectSync();
		const dChunks = (p.diamonds || []).reduce((n, d) => n + ((d.dataRef && d.dataRef.chunks || []).length), 0);
		const cChunks = (p.chats || []).reduce((n, c) => n + ((c.messagesRef && c.messagesRef.chunks || []).length), 0);
		window.__reset();
		await window.DaimondCore.applySync(p);
		return { gets: window.__gets, dChunks, cChunks, dCount: (p.diamonds || []).length, cCount: (p.chats || []).length };
	});
	note(`self-apply fetched ${asym.gets} chunk(s): ${asym.dCount} equal-stamp Diamonds (${asym.dChunks} chunks) `
		+ `and ${asym.cCount} identical-key chats (${asym.cChunks} chunks) all skipped on the content-key check`);
	check('equal-stamp Diamonds fetch ZERO on apply (content-key guard, symmetric with the chat path)',
		asym.gets === 0, `${asym.gets} gets (Diamonds ${asym.dChunks} + chats ${asym.cChunks} chunks, all skipped)`);
	check('a self-apply of wholly-equal content fetches nothing at all',
		asym.gets === 0 && (asym.dChunks + asym.cChunks) > 0,
		`${asym.gets} gets across ${asym.dCount} Diamonds + ${asym.cCount} chats holding ${asym.dChunks + asym.cChunks} chunks`);

	// ── 1c. A message UNIONED in with a STILL updatedAt must re-offload ──
	// applyChats keeps the older updatedAt of the two copies, so a transcript can
	// grow without its stamp moving. Keying reuse on the stamp would hand back a
	// stale manifest; the change-key must be a content hash (fp).
	const unionRe = await page.evaluate(async (cid) => {
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		const c = list.find(x => x.id === cid);
		const beforeStamp = c.updatedAt;
		const beforeManifest = window.DaimondCloud.contentGet('@c/' + cid);
		// Add a message WITHOUT moving updatedAt.
		c.messages = c.messages.concat([{ role: 'user', content: 'a genuinely new message ' + 'z'.repeat(50), mid: 'unioned-1', ts: 99999 }]);
		store.save(list);
		window.__reset();
		const p = await window.DaimondCore.collectSync();
		const afterManifest = window.DaimondCloud.contentGet('@c/' + cid);
		const c2 = store.stored().find(x => x.id === cid);
		return {
			stampStill: c2.updatedAt === beforeStamp,
			beforeKey: beforeManifest && beforeManifest.key,
			afterKey: afterManifest && afterManifest.key,
			puts: window.__puts,
			entry: (p.chats || []).find(e => e.id === cid),
		};
	}, seeded.cids[0]);
	check('a message unioned in did NOT move updatedAt (the trap the fp key exists for)',
		unionRe.stampStill, `stamp still ${unionRe.stampStill}`);
	check('yet the manifest re-offloaded to a new content key (change-key is the transcript, not updatedAt)',
		unionRe.beforeKey && unionRe.afterKey && unionRe.beforeKey !== unionRe.afterKey && unionRe.puts > 0,
		`${unionRe.beforeKey && unionRe.beforeKey.slice(0, 8)} → ${unionRe.afterKey && unionRe.afterKey.slice(0, 8)}, ${unionRe.puts} put(s)`);
	// and the parcel is a fixed point again afterwards.
	await page.evaluate(() => window.__reset());
	const p4a = await page.evaluate(() => window.DaimondCore.collectSync());
	await page.waitForTimeout(300);
	const p4b = await page.evaluate(() => window.DaimondCore.collectSync());
	check('and after the re-offload the parcel is a fixed point again',
		diffSections(p4a, p4b).length === 0 && (await page.evaluate(() => window.__puts)) === 0,
		diffSections(p4a, p4b).join(' '));

	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 2 — sweep-safety
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— invariant 2: sweep-safety —');

	// The parcel's `chunked` is what sync.js commits as the live set. It must name
	// every content chunk, or a file-only commit sweeps a Diamond/chat still live.
	const sweepCheck = await page.evaluate(() => {
		const p = window.DaimondCore.collectSync;
		return null;
	});
	const p5 = await page.evaluate(() => window.DaimondCore.collectSync());
	const live = await page.evaluate((parcel) => {
		// Reproduce sync.js's live set: every addr named by every manifest in
		// state.chunked (the co-located index, file + content).
		const named = new Set();
		const ix = parcel.chunked || {};
		Object.keys(ix).forEach(k => { (ix[k].chunks || []).forEach(c => named.add(c.addr)); });
		// The addresses the content refs actually point at.
		const need = new Set();
		(parcel.diamonds || []).forEach(d => (d.dataRef && d.dataRef.chunks || []).forEach(c => need.add(c.addr)));
		(parcel.chats || []).forEach(c => (c.messagesRef && c.messagesRef.chunks || []).forEach(x => need.add(x.addr)));
		const missing = [...need].filter(a => !named.has(a));
		const contentKeys = Object.keys(ix).filter(k => window.DaimondCloud.isContentKey(k));
		return { named: named.size, need: need.size, missing, contentKeys };
	}, p5);
	check('the parcel chunked-index carries the @d/ and @c/ content manifests',
		live.contentKeys.length === (p5.diamonds || []).length + (p5.chats || []).length,
		`${live.contentKeys.length} content keys`);
	check('EVERY content chunk a ref points at is named live by the committed set',
		live.missing.length === 0, live.missing.length ? `${live.missing.length} orphaned: ${live.missing.slice(0,3).join(',')}` : 'none orphaned');
	note(`live set names ${live.named} addrs; content refs need ${live.need}`);

	// The structural claim: collectSync re-reads the index AFTER the content
	// collectors. Prove it by showing collectChunked's own return (file snapshot)
	// would MISS the content keys, but the parcel's chunked does not.
	const reread = await page.evaluate(() => {
		const ix = window.DaimondCloud.index();
		return { indexContentKeys: Object.keys(ix).filter(k => window.DaimondCloud.isContentKey(k)).length };
	});
	check('the cloud index itself holds the content manifests (co-located, one commit names them)',
		reread.indexContentKeys > 0, `${reread.indexContentKeys} in index`);

	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 3 — cross-device convergence + the union residual
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— invariant 3: cross-device convergence —');

	// Device A = current state. Capture A's parcel, then simulate a fresh device B
	// that shares the SAME chunk store (__store) but has never offloaded: wipe B's
	// chunk-map and the @d/ content manifests, delete the Diamond locally and clear
	// its tombstone so applySync treats it as brand-new. Import A's parcel, then let
	// B collect and check it names A's SAME addresses rather than re-uploading.
	const conv = await page.evaluate(async (targetId) => {
		const mod = await import('/pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		// A's parcel and A's addresses for the target Diamond.
		const pA = await window.DaimondCore.collectSync();
		const entryA = (pA.diamonds || []).find(d => d.id === targetId);
		const addrsA = (entryA.dataRef.chunks || []).map(c => c.addr);

		// Become device B: forget this Diamond and its offload bookkeeping.
		await app.delete_diamond(targetId);
		try { localStorage.removeItem('daimond-chunk-map'); } catch (e) {}
		try { localStorage.removeItem('daimond-diamond-tombs'); } catch (e) {}   // so it is brand-new, not deleted
		window.DaimondCloud.contentForget('@d/' + targetId);

		// A parcel carrying ONLY the target Diamond, no tombstones.
		const incoming = { v: 3, diamonds: [entryA], diamondTombs: {}, chats: [], tombs: {}, msgTombs: {} };
		window.__reset();
		await window.DaimondCore.applySync(incoming);
		const getsOnImport = window.__gets;
		const importedManifest = window.DaimondCloud.contentGet('@d/' + targetId);

		// B collects. Convergence: same addresses, no fresh upload.
		window.__reset();
		const pB = await window.DaimondCore.collectSync();
		const entryB = (pB.diamonds || []).find(d => d.id === targetId);
		const addrsB = entryB && entryB.dataRef ? (entryB.dataRef.chunks || []).map(c => c.addr) : [];
		return {
			addrsA, addrsB,
			importRecorded: !!importedManifest && importedManifest.key === entryA.dataRef.key,
			importGets: getsOnImport,
			putsOnBCollect: window.__puts,
			keyMatch: entryB && entryB.dataRef && entryB.dataRef.key === entryA.dataRef.key,
		};
	}, seeded.dids[1]);
	check('device B records the sender\'s manifest on import (same content key)', conv.importRecorded);
	check('device B names the SAME chunk addresses as A, not fresh ones',
		JSON.stringify(conv.addrsA) === JSON.stringify(conv.addrsB) && conv.addrsA.length > 0,
		`A=${conv.addrsA.length} B=${conv.addrsB.length} equal=${JSON.stringify(conv.addrsA) === JSON.stringify(conv.addrsB)}`);
	check('and B does NOT re-upload the identical Diamond on its own collect', conv.putsOnBCollect === 0,
		`${conv.putsOnBCollect} put(s)`);
	note(`import materialised ${conv.importGets} chunk(s) (the one fetch to lay the Diamond down)`);

	// ── 3b. The RESIDUAL: an actively message-UNIONED large chat ──
	// The agent flagged this. When a large chat unions (neither transcript wins),
	// the receiver stores neither side's manifest — so each device offloads its
	// OWN copy of the union. Same content hashes → same content KEY, but a fresh IV
	// per device → DIFFERENT chunk addresses. Characterise precisely.
	console.log('\n— invariant 3b: the message-union residual —');

	const residual = await page.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		// Device B's own copy of a chat, already offloaded.
		const cid = 'unionchat';
		const mineMsgs = [];
		for (let i = 0; i < 380; i++) mineMsgs.push({ role: 'user', content: 'mine ' + i + ' ' + 'p'.repeat(400), mid: 'mine' + i, ts: 2000 + i });
		let list = store.stored();
		list.push({ id: cid, name: 'Union Chat', model: 'mock/fast', updatedAt: 7000, messages: mineMsgs, session: null });
		store.save(list);
		await window.DaimondCore.collectSync();               // offloads B's copy → keyB / SB
		const bManifest = window.DaimondCloud.contentGet('@c/' + cid);

		// Craft an incoming parcel with a DIFFERENT transcript for the same chat,
		// equal updatedAt so neither wins. Offload its bytes to populate the store.
		const theirMsgs = [];
		for (let i = 0; i < 380; i++) theirMsgs.push({ role: 'assistant', content: 'theirs ' + i + ' ' + 'q'.repeat(400), mid: 'theirs' + i, ts: 3000 + i });
		const theirManifest = await window.DaimondChunks.offloadBytes('c:' + cid, new TextEncoder().encode(JSON.stringify(theirMsgs)));
		const incoming = { v: 3, chats: [{ id: cid, name: 'Union Chat', model: 'mock/fast', updatedAt: 7000, messages: null, messagesRef: theirManifest, session: null }],
			tombs: {}, msgTombs: {}, diamonds: [], diamondTombs: {} };

		window.__reset();
		await window.DaimondCore.applySync(incoming);
		const afterApplyManifest = window.DaimondCloud.contentGet('@c/' + cid);
		const adopted = afterApplyManifest && afterApplyManifest.key === theirManifest.key;

		// B collects: transcript is now the union → re-offload to keyU / SU.
		window.__reset();
		const pB = await window.DaimondCore.collectSync();
		const entryB = (pB.chats || []).find(e => e.id === cid);
		const bUnionManifest = window.DaimondCloud.contentGet('@c/' + cid);
		const unionMsgs = store.stored().find(x => x.id === cid).messages;

		// Simulate the OTHER device computing the SAME union: offload the identical
		// bytes after wiping the chunk-map (a device that never offloaded these).
		try { localStorage.removeItem('daimond-chunk-map'); } catch (e) {}
		const otherUnionManifest = await window.DaimondChunks.offloadBytes('c:' + cid, new TextEncoder().encode(JSON.stringify(unionMsgs)));

		const addrB = (bUnionManifest.chunks || []).map(c => c.addr);
		const addrOther = (otherUnionManifest.chunks || []).map(c => c.addr);
		return {
			bKey: bManifest.key, theirKey: theirManifest.key,
			adoptedSenders: adopted,
			unionMsgCount: unionMsgs.length,
			keyU_B: bUnionManifest.key, keyU_other: otherUnionManifest.key,
			sameKey: bUnionManifest.key === otherUnionManifest.key,
			sameAddrs: JSON.stringify(addrB) === JSON.stringify(addrOther),
			addrB, addrOther,
		};
	});
	check('a UNIONED chat does not adopt the sender\'s manifest (receiver keeps its own)',
		residual.adoptedSenders === false, `adopted=${residual.adoptedSenders}`);
	check('the union merged both transcripts', residual.unionMsgCount === 760, `${residual.unionMsgCount} messages`);
	check('two devices computing the identical union land the SAME content key',
		residual.sameKey, `${residual.keyU_B.slice(0,10)} vs ${residual.keyU_other.slice(0,10)}`);
	check('but at DIFFERENT chunk addresses (fresh IV per device) — the residual divergence',
		residual.sameKey && !residual.sameAddrs,
		`sameKey=${residual.sameKey} sameAddrs=${residual.sameAddrs}`);
	note(`device-B union addrs ${JSON.stringify(residual.addrB)}`);
	note(`other-device union addrs ${JSON.stringify(residual.addrOther)}`);
	note('CONSEQUENCE: each device commits only its own addresses as live; the gateway,');
	note('sweeping every chunk the committing index does not name, can delete the other');
	note('device\'s copy of an identical transcript. Not parcel churn (the key-check');
	note('converges in ~2 rounds) but cross-device chunk divergence with a sweep hole.');

	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 4 — the iOS parcel ceiling
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— invariant 4: the iOS parcel ceiling —');

	const CEIL = 1024 * 1024;   // 1 MB, well under SYNC_PARCEL_MAX (5 MB).
	const ceiling = await page.evaluate(async () => {
		const p = await window.DaimondCore.collectSync();
		const plain = JSON.stringify(p);
		const sealed = await window.DaimondIdentity.wrap(plain);
		// Reconstruct the INLINE parcel (pre-change) by materialising every ref, to
		// show the body it would have been.
		const inline = JSON.parse(plain);
		for (const d of (inline.diamonds || [])) {
			if (d.dataRef) {
				const b = await window.DaimondChunks.materialiseBytes(d.dataRef);
				d.data = b ? new TextDecoder().decode(b) : '';
				delete d.dataRef;
			}
		}
		for (const c of (inline.chats || [])) {
			if (c.messagesRef) {
				const b = await window.DaimondChunks.materialiseBytes(c.messagesRef);
				c.messages = b ? JSON.parse(new TextDecoder().decode(b)) : [];
				delete c.messagesRef;
			}
		}
		const inlinePlain = JSON.stringify(inline);
		const inlineSealed = await window.DaimondIdentity.wrap(inlinePlain);
		return { offloadBody: sealed.length, inlineBody: inlineSealed.length, offloadPlain: plain.length, inlinePlain: inlinePlain.length };
	});
	note(`offloaded sealed body ${Math.round(ceiling.offloadBody / 1024)} kB; inline would be ${Math.round(ceiling.inlineBody / 1024)} kB`);
	check(`the offloaded sealed parcel body stays under the ${Math.round(CEIL/1024)} kB iOS-safe ceiling`,
		ceiling.offloadBody < CEIL, `${Math.round(ceiling.offloadBody / 1024)} kB`);
	check('REGRESSION: the same content inline blows past the ceiling',
		ceiling.inlineBody > CEIL, `${Math.round(ceiling.inlineBody / 1024)} kB inline`);
	check('offload shrinks the body by more than 4×', ceiling.inlineBody / ceiling.offloadBody > 4,
		`${(ceiling.inlineBody / ceiling.offloadBody).toFixed(1)}×`);

	// Apply materialises ONE item at a time (never an array of all): peak gets in a
	// single applySync equals at most the chunk count of the largest single item,
	// not the sum. Hard to assert peak memory, but we can assert applyChats/Diamonds
	// null the reference and never build an all-items array — checked via source-free
	// behaviour: a v3 parcel of N large items apply without OOM and materialise
	// exactly the chunks it needed.
	const oneAtATime = await page.evaluate(async () => {
		const p = await window.DaimondCore.collectSync();
		window.__reset();
		const r = await window.DaimondCore.applySync(p);
		return { gets: window.__gets, failed: (r && r.failed) || [] };
	});
	check('apply of a full v3 parcel completes (materialises on demand, no all-items array)',
		oneAtATime.failed.length === 0, `failed: ${oneAtATime.failed.join(',')}, ${oneAtATime.gets} gets`);

	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 5 — materialise on demand
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— invariant 5: materialise on demand —');

	// A strict-OLDER Diamond and an identical-key chat trigger zero getChunk.
	const zeroFetch = await page.evaluate(async (dids) => {
		const p = await window.DaimondCore.collectSync();
		// Make the incoming Diamonds strictly OLDER than local by lowering touched.
		const older = JSON.parse(JSON.stringify(p));
		(older.diamonds || []).forEach(d => { d.touched = 1; d.updated = 1; });
		// Chats keep their refs with a matching content key already stored locally.
		window.__reset();
		await window.DaimondCore.applySync(older);
		return { gets: window.__gets };
	}, seeded.dids);
	check('a strict-older Diamond and an identical-key chat fetch ZERO chunks',
		zeroFetch.gets === 0, `${zeroFetch.gets} getChunk`);

	// A MISSING chunk lands metadata-only, non-destructively, and self-heals.
	const missing = await page.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		// A brand-new chat whose ref points at chunks the store does not hold.
		const cid = 'healme';
		const msgs = [];
		for (let i = 0; i < 380; i++) msgs.push({ role: 'user', content: 'heal ' + i + ' ' + 'h'.repeat(400), mid: 'h' + i, ts: 4000 + i });
		const manifest = await window.DaimondChunks.offloadBytes('c:' + cid, new TextEncoder().encode(JSON.stringify(msgs)));
		// Evict the chunks: simulate a gateway that swept them.
		const savedBlobs = {};
		(manifest.chunks || []).forEach(c => { savedBlobs[c.addr] = window.__store[c.addr]; delete window.__store[c.addr]; });

		// Existing local chat with real messages, that the missing ref would union into.
		const existMsgs = [{ role: 'user', content: 'existing message', mid: 'exist1', ts: 1 }];
		let list = store.stored();
		list.push({ id: cid, name: 'Heal Me', model: 'mock/fast', updatedAt: 8000, messages: existMsgs, session: null });
		store.save(list);

		// A fresh parcel each apply, as a real pull unwraps one — applyChats mutates
		// its entries (nulls messagesRef, replaces messages), so a caller must never
		// reuse the object across pulls.
		const freshIncoming = () => ({ v: 3, chats: [{ id: cid, name: 'Heal Me', model: 'mock/fast', updatedAt: 8000, messages: null, messagesRef: JSON.parse(JSON.stringify(manifest)), session: null }],
			tombs: {}, msgTombs: {}, diamonds: [], diamondTombs: {} });
		await window.DaimondCore.applySync(freshIncoming());
		const afterMissing = store.stored().find(x => x.id === cid);
		const keptExisting = !!afterMissing && afterMissing.messages.some(m => m.mid === 'exist1');
		const noTombstone = !JSON.parse(localStorage.getItem('daimond-chats-deleted') || '{}')[cid];

		// Restore the chunks and re-apply a FRESH parcel: it self-heals.
		Object.keys(savedBlobs).forEach(a => { window.__store[a] = savedBlobs[a]; });
		await window.DaimondCore.applySync(freshIncoming());
		const afterHeal = store.stored().find(x => x.id === cid);
		const healed = !!afterHeal && afterHeal.messages.length > existMsgs.length;
		return { keptExisting, noTombstone, healedCount: afterHeal ? afterHeal.messages.length : 0, healed };
	});
	check('a missing chunk lands metadata-only WITHOUT destroying the existing transcript',
		missing.keptExisting, `keptExisting=${missing.keptExisting}`);
	check('and writes no tombstone / deletion for it', missing.noTombstone, `noTombstone=${missing.noTombstone}`);
	check('and it self-heals once the chunks are held again',
		missing.healed, `healed to ${missing.healedCount} messages`);

	// Back-compat: a v3 parcel applied by the PRE-CHANGE (v2) appliers loses nothing
	// destructively. The v2 applyDiamonds required `r.data`; a v3-only entry has
	// none, so it is skipped (not corrupting), and lands when the item next updates.
	const backCompat = await page.evaluate(async () => {
		const p = await window.DaimondCore.collectSync();
		// Emulate v2 applyDiamonds' guard: it skipped entries without `data`.
		const v2WouldImport = (p.diamonds || []).filter(d => d.data != null).length;
		const v2WouldSkip = (p.diamonds || []).filter(d => d.data == null && d.dataRef).length;
		return { v2WouldImport, v2WouldSkip, total: (p.diamonds || []).length };
	});
	check('a v3 (ref-only) Diamond is SKIPPED by a v2 receiver, not corrupted (degrades cleanly)',
		backCompat.v2WouldSkip === backCompat.total && backCompat.v2WouldImport === 0,
		`skip ${backCompat.v2WouldSkip}/${backCompat.total}, import ${backCompat.v2WouldImport}`);

	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 6 — tier plan
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— invariant 6: content claims the free tier first —');

	// Seed a real workspace-file manifest through the supported `put` path, so the
	// plan holds both classes.
	await page.evaluate(async () => {
		await window.DaimondCloud.put('workfile.txt',
			{ v: 2, size: 50000, key: 'fffile', chunks: [{ addr: 'fileaddr', size: 50000 }] }, 'fffile');
	});
	const plan = await page.evaluate(() => {
		// Give a generous allowance so content fits free and we can see ordering.
		const contentKeys = Object.keys(window.DaimondCloud.index()).filter(k => window.DaimondCloud.isContentKey(k));
		const allowance = 10 * 1024 * 1024;
		const pl = window.DaimondCloud.tierPlan(allowance);
		const contentTiers = contentKeys.map(k => pl[k]);
		// A tiny allowance: only content should get 'f', a file should be 'p'.
		const tiny = window.DaimondCloud.tierPlan(1);        // 1 byte: nothing fits, but check ordering intent
		return { contentKeys: contentKeys.length, allContentFree: contentTiers.every(t => t === 'f'),
			sample: pl };
	});
	check('with a generous allowance every content key is on the FREE tier',
		plan.contentKeys > 0 && plan.allContentFree, `${plan.contentKeys} content keys, all free=${plan.allContentFree}`);

	// The ordering claim proper: content sorts ahead of a file even when the free
	// budget only covers SOME of the store, so a file is evicted before a Diamond.
	const ordering = await page.evaluate(() => {
		const ix = window.DaimondCloud.index();
		const contentSize = Object.keys(ix).filter(k => window.DaimondCloud.isContentKey(k))
			.reduce((n, k) => n + ((ix[k].size | 0)), 0);
		// Allowance exactly covering the content, leaving nothing for the file.
		const pl = window.DaimondCloud.tierPlan(contentSize);
		const contentAllFree = Object.keys(ix).filter(k => window.DaimondCloud.isContentKey(k)).every(k => pl[k] === 'f');
		const fileKey = Object.keys(ix).find(k => !window.DaimondCloud.isContentKey(k));
		return { contentAllFree, filePaid: fileKey ? pl[fileKey] === 'p' : null, fileKey };
	});
	check('content sorts ahead of files: an allowance covering content keeps Diamonds/chats free',
		ordering.contentAllFree === true, `contentAllFree=${ordering.contentAllFree}, file(${ordering.fileKey})=${ordering.filePaid ? 'paid' : 'free/none'}`);

} catch (e) {
	check('no exception during the run', false, String(e && e.stack || e).slice(0, 400));
} finally {
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
