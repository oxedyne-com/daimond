// verify_contentoffload.mjs — the v3 content offload: large Diamonds and chat
// transcripts move out to content-addressed chunks and leave a `dataRef` /
// `messagesRef` inline, under reserved `@d/<id>` / `@c/<id>` manifests co-located
// in the cloud index. This attacks the eight invariants that guard it.
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
//   7. PRESENCE — a manifest reused on its change-key is checked against the store
//      before its addresses are re-sent; an unanswered check reuses it as before; and
//      what is missing is reported by kind, by restorability, by the id of each lost
//      chat or Diamond, and only once per sitting while the set stands still.
//   8. THE PEER'S REFS — a device that unions a peer's chat names the peer's chunk
//      addresses in the index it commits, so its own sweep does not delete them.
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
		// Add a message WITHOUT moving updatedAt. The mirror holds SUMMARIES (lazy read,
		// seq 213), so load the transcript before appending and mark the entry resident.
		const curMsgs = (await store.loadMessages(cid)).messages || [];
		c.messages = curMsgs.concat([{ role: 'user', content: 'a genuinely new message ' + 'z'.repeat(50), mid: 'unioned-1', ts: 99999 }]);
		c._loaded = true;
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
		const unionMsgs = (await store.loadMessages(cid)).messages;   // lazy mirror: load, don't read the summary

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
	note('CONSEQUENCE: each device offloads the union under addresses of its own, so two');
	note('copies of one transcript sit in the store. The SWEEP half of that is closed —');
	note('the committing index now names the peer\'s addresses too (invariant 8) — and what');
	note('is left is the duplication itself, which costs storage and never a transcript.');

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
		const afterMissingMsgs = (await store.loadMessages(cid)).messages || [];   // lazy mirror: load the transcript
		const keptExisting = afterMissingMsgs.some(m => m.mid === 'exist1');
		const noTombstone = !JSON.parse(localStorage.getItem('daimond-chats-deleted') || '{}')[cid];

		// Restore the chunks and re-apply a FRESH parcel: it self-heals.
		Object.keys(savedBlobs).forEach(a => { window.__store[a] = savedBlobs[a]; });
		await window.DaimondCore.applySync(freshIncoming());
		const afterHealMsgs = (await store.loadMessages(cid)).messages || [];
		const healed = afterHealMsgs.length > existMsgs.length;
		return { keptExisting, noTombstone, healedCount: afterHealMsgs.length, healed };
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


	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 7 — a reused manifest is checked for PRESENCE
	// ═══════════════════════════════════════════════════════════════
	//
	// The collectors reuse a stored manifest on a change-key -- `touched` for a
	// Diamond, the transcript fingerprint for a chat, size-and-mtime for a file --
	// and until now never asked whether the store still held what it named. A swept
	// chunk therefore had its dead address re-sent on every push for ever, and every
	// device that pulled the item showed it empty. One account's committed index
	// named eighteen such addresses.
	console.log('\n— invariant 7: a reused manifest is checked for presence —');

	// A quiet round first, so every manifest is stored and nothing is owed.
	await page.evaluate(() => window.DaimondCore.collectSync());
	await page.evaluate(() => window.__reset());
	const quiet = await page.evaluate(async () => {
		const p = await window.DaimondCore.collectSync();
		return { puts: window.__puts, haves: window.__haves, chats: (p.chats || []).length };
	});
	check('A3. everything present: the presence question is asked and NOTHING is re-uploaded',
		quiet.puts === 0 && quiet.haves > 0, `${quiet.puts} put(s), ${quiet.haves} have call(s)`);

	// Sweep one address out from under a chat whose manifest the collector reuses.
	const swept = await page.evaluate(() => {
		const ix = window.DaimondCloud.index();
		const key = Object.keys(ix).find(k => /^@c\//.test(k) && !/\.peer$/.test(k)
			&& (ix[k].chunks || []).length);
		const before = (ix[key].chunks || []).map(c => c.addr);
		delete window.__store[before[0]];			// the gateway swept it
		window.__ds = [];
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
		return { key, before };
	});
	note(`swept ${swept.before[0].slice(0, 12)}… from under ${swept.key}`);

	await page.evaluate(() => window.__reset());
	const healed = await page.evaluate(async (sw) => {
		const parcel = await window.DaimondCore.collectSync();
		const cid = sw.key.slice('@c/'.length);
		const entry = (parcel.chats || []).find(c => c.id === cid);
		const now = (window.DaimondCloud.contentGet(sw.key) || {}).chunks || [];
		return {
			puts:      window.__puts,
			refAddrs:  ((entry && entry.messagesRef && entry.messagesRef.chunks) || []).map(c => c.addr),
			nowAddrs:  now.map(c => c.addr),
			allHeld:   now.every(c => c.addr in window.__store),
			ds:        window.__ds,
		};
	}, swept);
	check('A1. the manifest naming a swept chunk is re-offloaded',
		healed.puts > 0 && healed.nowAddrs[0] !== swept.before[0],
		`${healed.puts} put(s), ${swept.before[0].slice(0, 8)}… → ${(healed.nowAddrs[0] || '').slice(0, 8)}…`);
	check('A1. and the parcel carries the NEW address, every piece of it held',
		healed.refAddrs.length > 0
			&& JSON.stringify(healed.refAddrs) === JSON.stringify(healed.nowAddrs)
			&& healed.allHeld,
		`ref ${healed.refAddrs.length} addr(s), all held=${healed.allHeld}`);
	const ev = (healed.ds || []).find(e => e.kind === 'sync' && e.payload && e.payload.refs_missing);
	check('A1. and the feed is told how much was missing and how much moved',
		!!ev && ev.payload.dir === 'push' && ev.payload.refs_missing >= 1 && ev.payload.reoffload >= 1,
		ev ? `refs_missing=${ev.payload.refs_missing} reoffload=${ev.payload.reoffload}` : 'no event');

	// FAIL SAFE. Sweep another address, then refuse the `have`. An unanswered
	// question is not evidence of absence: re-uploading the account on a network
	// hiccup is a far worse round than the one this fixes.
	const refused = await page.evaluate(async () => {
		const ix = window.DaimondCloud.index();
		const key = Object.keys(ix).find(k => /^@c\//.test(k) && !/\.peer$/.test(k)
			&& (ix[k].chunks || []).length);
		const before = (ix[key].chunks || []).map(c => c.addr);
		delete window.__store[before[0]];
		const real = window.DaimondGateway.gwFetch;
		window.DaimondGateway.gwFetch = async function (path_, opts) {
			const body = JSON.parse(opts.body);
			if (body.op === 'have') { window.__haves++; return { status: 503, json: async () => ({ error: 'busy' }) }; }
			return real.call(this, path_, opts);
		};
		window.__reset();
		const parcel = await window.DaimondCore.collectSync();
		window.DaimondGateway.gwFetch = real;
		const cid = key.slice('@c/'.length);
		const entry = (parcel.chats || []).find(c => c.id === cid);
		return {
			puts:  window.__puts,
			kept:  JSON.stringify(((entry && entry.messagesRef && entry.messagesRef.chunks) || []).map(c => c.addr))
					=== JSON.stringify(before),
			still: JSON.stringify((window.DaimondCloud.contentGet(key) || {}).chunks.map(c => c.addr)) === JSON.stringify(before),
		};
	});
	check('A2. a `have` that could not be answered leaves every manifest reused, unchanged',
		refused.kept === true && refused.still === true, `ref kept=${refused.kept} index kept=${refused.still}`);
	check('A2. and re-uploads NOTHING — the world is not pushed over a network hiccup',
		refused.puts === 0, `${refused.puts} put(s)`);

	// And the very next round, once the gateway answers again, does the healing.
	await page.evaluate(() => window.__reset());
	const later = await page.evaluate(async () => {
		await window.DaimondCore.collectSync();
		const ix = window.DaimondCloud.index();
		// The Diamonds and chats only: a `.peer` entry is the peer's to heal, and a
		// workspace path with no file on this device has nothing here to offload
		// again — both are skipped by the sweep, on purpose.
		const bad = Object.keys(ix).filter(k => /^@[dc]\/[^.]*$/.test(k))
			.filter(k => (ix[k].chunks || []).some(c => !(c.addr in window.__store)));
		return { puts: window.__puts, bad };
	});
	check('A2. and the next answered round heals what the refused one left',
		later.puts > 0 && later.bad.length === 0,
		`${later.puts} put(s), ${later.bad.length} manifest(s) still naming a missing chunk`);

	// A count that leaves out the kinds it cannot fix is a count nobody can reason
	// from: the first live run said "refs missing: 65, re-offloading 0" and nothing
	// in the line told the owner whether that was a bug or the truth.
	const census = await page.evaluate(async () => {
		// A chat whose manifest survives its text: the shape of the owner's loss.
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		list.push({ id: 'lostchat-aaaabbbbcccc', name: 'Lost', model: 'mock/fast', updatedAt: 9000, messages: [], session: null });
		store.save(list);
		window.DaimondCloud.contentSet('@c/lostchat-aaaabbbbcccc', {
			v: 2, size: 900, key: 'lostkey', fp: 'lostfp',
			chunks: [{ addr: 'dead0'.padEnd(64, '0'), size: 900 }] });
		// And a mail manifest, which no collect could ever rebuild from here.
		window.DaimondCloud.contentSet('@m/deadmail', {
			v: 2, size: 10, key: 'mk', chunks: [{ addr: 'dead1'.padEnd(64, '1'), size: 10 }] });

		window.__ds = [];
		window.__lines = [];
		window.DEBUG_SHARE = { event: (kind, payload) => window.__ds.push({ kind, payload }) };
		const realDebug = console.debug;
		console.debug = function (...a) { if (String(a[0]).indexOf('[chunks]') === 0) window.__lines.push(a.join(' ')); realDebug.apply(console, a); };
		window.__reset();
		await window.DaimondCore.collectSync();
		const first = { lines: window.__lines.slice(), ds: window.__ds.slice() };
		// The lost chat's entry is dropped by the collector on that very round (an
		// empty transcript rides inline), so the set MOVES once. Settle it, then
		// measure a push whose unrestorable set is the one before it, unchanged.
		window.__lines = []; window.__ds = [];
		await window.DaimondCore.collectSync();
		const settling = { lines: window.__lines.slice(), ds: window.__ds.slice() };
		window.__lines = []; window.__ds = [];
		await window.DaimondCore.collectSync();
		const second = { lines: window.__lines.slice(), ds: window.__ds.slice() };
		console.debug = realDebug;
		return { first, settling, second };
	});
	const line = (census.first.lines.find(l => l.indexOf('refs missing:') >= 0) || '');
	const evc  = (census.first.ds.find(e => e.kind === 'sync' && e.payload && e.payload.refs_missing) || { payload: {} }).payload;
	note(line);
	check('A4. the line breaks the missing refs down by kind AND restorability',
		/@m\/ \d+ unrestorable/.test(line) && /@c\/ \d+ no-local-text/.test(line), line || 'no line');
	check('A4. and the parts sum to the total it opens with',
		(() => {
			const total = Number((/refs missing: (\d+)/.exec(line) || [])[1]);
			const parts = [...line.matchAll(/[\w@./-]+ (\d+) [a-z-]+/g)].map(m => Number(m[1]));
			// The leading "missing: N" is not a part; the parts live inside the brackets.
			const inner = (/\(([^)]*)\)/.exec(line) || ['', ''])[1];
			const sum = [...inner.matchAll(/ (\d+) /g)].map(m => Number(m[1])).reduce((a, b) => a + b, 0);
			return total > 0 && sum === total && parts.length > 0;
		})(), line);
	check('A4. the event carries the same census and an unrestorable total',
		!!evc.miss_kinds && (evc.miss_kinds['@m'] | 0) >= 1 && (evc.miss_kinds['@c'] | 0) >= 1
			&& evc.unrestorable >= 2,
		`miss_kinds=${JSON.stringify(evc.miss_kinds)} unrestorable=${evc.unrestorable}`);
	const named = (census.first.lines.find(l => l.indexOf('no local text for:') >= 0) || '');
	check('A5. a chat whose text is gone is named by id, so the owner can look it up',
		named.indexOf('c/lostchat-aaa') >= 0, named || 'no line');
	check('A5. and the id travels in the feed event too, capped at ten',
		Array.isArray(evc.miss_ids) && evc.miss_ids.length >= 1 && evc.miss_ids.length <= 10
			&& evc.miss_ids.some(x => x.indexOf('c/lostchat') === 0),
		`${(evc.miss_ids || []).length} id(s)`);
	check('A6. a set that MOVED is said again — the lost chat leaves it on its own round',
		census.settling.lines.some(l => l.indexOf('refs missing:') >= 0),
		`${census.settling.lines.length} line(s)`);
	check('A6. and then the SAME unrestorable set, push after push, says nothing again',
		census.second.lines.length === 0
			&& !census.second.ds.some(e => e.payload && e.payload.refs_missing),
		`${census.second.lines.length} line(s), ${census.second.ds.length} event(s)`);

	// A set that CHANGES is news, and is said again.
	const changed = await page.evaluate(async () => {
		window.DaimondCloud.contentSet('@m/deadmail2', {
			v: 2, size: 10, key: 'mk2', chunks: [{ addr: 'dead2'.padEnd(64, '2'), size: 10 }] });
		window.__lines = [];
		const realDebug = console.debug;
		console.debug = function (...a) { if (String(a[0]).indexOf('[chunks]') === 0) window.__lines.push(a.join(' ')); realDebug.apply(console, a); };
		await window.DaimondCore.collectSync();
		console.debug = realDebug;
		return window.__lines.slice();
	});
	check('A6. but one more unrestorable manifest makes it news again',
		changed.some(l => l.indexOf('refs missing:') >= 0), `${changed.length} line(s)`);

	// The cap proper: twelve lost chats name ten and COUNT the rest, because a
	// line nobody reads to the end names nothing.
	const capped = await page.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		for (let k = 0; k < 12; k++) {
			const id = 'lost-' + String(k).padStart(2, '0') + '-yyyyyyyyyy';
			list.push({ id, name: 'Lost ' + k, model: 'mock/fast', updatedAt: 9100 + k, messages: [], session: null });
			window.DaimondCloud.contentSet('@c/' + id, { v: 2, size: 900, key: 'lk' + k, fp: 'lf' + k,
				chunks: [{ addr: ('bad' + k).padEnd(64, '9'), size: 900 }] });
		}
		store.save(list);
		window.__lines = []; window.__ds = [];
		const realDebug = console.debug;
		console.debug = function (...a) { if (String(a[0]).indexOf('[chunks]') === 0) window.__lines.push(a.join(' ')); realDebug.apply(console, a); };
		await window.DaimondCore.collectSync();
		console.debug = realDebug;
		const named = window.__lines.find(l => l.indexOf('no local text for:') >= 0) || '';
		const ev = (window.__ds.find(e => e.payload && e.payload.miss_ids) || { payload: {} }).payload;
		return { named, ids: (ev.miss_ids || []).length };
	});
	check('A5. twelve lost chats name ten and count the remainder',
		(capped.named.match(/[cd]\//g) || []).length === 10 && /\(\+\d+ more\)/.test(capped.named)
			&& capped.ids === 10,
		capped.named.slice(0, 150) || 'no line');

	// ═══════════════════════════════════════════════════════════════
	// INVARIANT 8 — a peer's refs are NAMED by the committing index
	// ═══════════════════════════════════════════════════════════════
	//
	// Invariant 3b's residual: two devices that compute the identical union land
	// the same content key at DIFFERENT addresses, because a seal draws a fresh IV
	// per device. The device that commits names only its own, and the gateway
	// sweeps the rest -- so the phone's push deleted the desktops' uploads of the
	// very same conversation. The peer's refs are now recorded beside our own.
	console.log('\n— invariant 8: the committing index names the peer\'s refs —');

	const peerRefs = await page.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		const cid = 'peerchat';
		const mine = [];
		for (let i = 0; i < 380; i++) mine.push({ role: 'user', content: 'mine ' + i + ' ' + 'p'.repeat(400), mid: 'pm' + i, ts: 2000 + i });
		const list = store.stored();
		list.push({ id: cid, name: 'Peer Chat', model: 'mock/fast', updatedAt: 7000, messages: mine, session: null });
		store.save(list);
		await window.DaimondCore.collectSync();				// our own manifest exists

		const theirs = [];
		for (let i = 0; i < 380; i++) theirs.push({ role: 'assistant', content: 'theirs ' + i + ' ' + 'q'.repeat(400), mid: 'pt' + i, ts: 3000 + i });
		const theirRef = await window.DaimondChunks.offloadBytes('c:' + cid, new TextEncoder().encode(JSON.stringify(theirs)));
		await window.DaimondCore.applySync({ v: 3, tombs: {}, msgTombs: {}, diamonds: [], diamondTombs: {},
			chats: [{ id: cid, name: 'Peer Chat', model: 'mock/fast', updatedAt: 7000, messages: null, messagesRef: theirRef, session: null }] });

		const pk = window.DaimondCloud.peerKey(cid);
		const entry = window.DaimondCloud.index()[pk] || null;
		const ours  = window.DaimondCloud.contentGet('@c/' + cid) || {};
		return {
			cid, pk,
			theirAddrs: (theirRef.chunks || []).map(c => c.addr),
			peerAddrs:  ((entry && entry.chunks) || []).map(c => c.addr),
			ownAddrs:   (ours.chunks || []).map(c => c.addr),
			adopted:    ours.key === theirRef.key,
		};
	});
	check('B1. after unioning a peer\'s chat the index NAMES the peer\'s refs',
		peerRefs.peerAddrs.length > 0
			&& JSON.stringify(peerRefs.peerAddrs) === JSON.stringify(peerRefs.theirAddrs),
		`peer ${peerRefs.peerAddrs.length} addr(s) under ${peerRefs.pk}`);
	check('B1. and they are the peer\'s, not ours — the union is still our own manifest',
		peerRefs.adopted === false
			&& peerRefs.peerAddrs.every(a => peerRefs.ownAddrs.indexOf(a) < 0),
		`adopted=${peerRefs.adopted}`);

	const committed = await page.evaluate(async (pr) => {
		window.__reset();
		const parcel = await window.DaimondCore.collectSync();
		const tiers = window.DaimondCloud.tierPlan(window.DaimondCloud.allowance());
		await window.DaimondChunks.commit(parcel.chunked, 1, tiers);
		const body = window.__commits[window.__commits.length - 1] || { chunks: [] };
		const named = new Set((body.chunks || []).map(c => c.addr));
		const ours = (window.DaimondCloud.contentGet('@c/' + pr.cid) || {}).chunks || [];
		return {
			peerNamed: pr.peerAddrs.every(a => named.has(a)),
			ownNamed:  ours.map(c => c.addr).every(a => named.has(a)),
			entries:   (body.chunks || []).length,
		};
	}, peerRefs);
	check('B2. the commit payload names the peer\'s addresses, so the sweep leaves them',
		committed.peerNamed === true, `${committed.entries} live entries`);
	check('B2. alongside our own union\'s — both copies survive the same commit',
		committed.ownNamed === true);

	const pruned = await page.evaluate(async (pr) => {
		// The peer's NEXT parcel carries a different reference for the same chat:
		// the entry is replaced, never appended to.
		const other = [];
		for (let i = 0; i < 400; i++) other.push({ role: 'assistant', content: 'later ' + i + ' ' + 'z'.repeat(400), mid: 'pl' + i, ts: 4000 + i });
		const ref2 = await window.DaimondChunks.offloadBytes('c:' + pr.cid, new TextEncoder().encode(JSON.stringify(other)));
		await window.DaimondCore.applySync({ v: 3, tombs: {}, msgTombs: {}, diamonds: [], diamondTombs: {},
			chats: [{ id: pr.cid, name: 'Peer Chat', model: 'mock/fast', updatedAt: 7001, messages: null, messagesRef: ref2, session: null }] });
		const after2 = window.DaimondCloud.index()[pr.pk] || null;
		const addrs2 = ((after2 && after2.chunks) || []).map(c => c.addr);

		// And a parcel that carries the transcript INLINE names no chunk at all,
		// so the entry goes: the peer no longer refers to anything.
		await window.DaimondCore.applySync({ v: 3, tombs: {}, msgTombs: {}, diamonds: [], diamondTombs: {},
			chats: [{ id: pr.cid, name: 'Peer Chat', model: 'mock/fast', updatedAt: 7002, messages: other, session: null }] });
		const after3 = window.DaimondCloud.index()[pr.pk] || null;
		return {
			replaced: JSON.stringify(addrs2) === JSON.stringify((ref2.chunks || []).map(c => c.addr)),
			kept:     addrs2.length,
			carried:  (ref2.chunks || []).length,
			held:     pr.peerAddrs.some(a => addrs2.indexOf(a) >= 0),
			gone:     after3 === null,
		};
	}, peerRefs);
	check('B3. the peer\'s next parcel REPLACES the entry — never more than it carries',
		pruned.replaced === true && pruned.held === false,
		`${pruned.kept} kept of ${pruned.carried} carried, stale addrs held=${pruned.held}`);
	check('B3. and a parcel that references nothing for the chat prunes it away',
		pruned.gone === true);

} catch (e) {
	check('no exception during the run', false, String(e && e.stack || e).slice(0, 400));
} finally {
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
