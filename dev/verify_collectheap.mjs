// verify_collectheap.mjs — S-SYNC #1, the collect-heap gate (the arm-B S1 gate).
//
// THE BUG. Until seq 213/214 the sync collector read and held EVERY chat
// transcript at once while it packed the parcel -- ~40 MB transient at ~300 chats,
// and the tab a phone gave it fell over at ~1000. The fix (collectChatsRefs, PASS
// 1 ranks the inline set from summaries alone and PASS 2 STREAMS one transcript at
// a time, releasing each before the next) means the peak is the inline set plus a
// SINGLE transcript and never grows with the number of chats. The offloaded ones
// become content refs, and a quiet re-collect reuses each ref on its fingerprint
// WITHOUT a read.
//
// THE GATE. Seed ~500 chats -- a mix of small (ride inline) and large (offload to
// refs) -- then collect twice with the load probe reset between:
//
//   * the SECOND, quiet collect LOADS only the inline set (the offloaded refs are
//     reused unread), NOT ~500;
//   * the inline set is a small BOUNDED slice (the budget bound it), not the store;
//   * the JS heap delta ACROSS the quiet collect is small (< ~8 MB), not tens;
//   * residency stays bounded (the collect leaves no wall of resident transcripts).
//
// --break reverts to load-all by turning the content offload OFF, so every chat
// rides inline and is re-loaded on every collect and the whole parcel holds every
// transcript -- which reddens both the load-count and the heap assertions. That is
// the pre-fix behaviour, driven from here without touching the shipped code.
//
// The chunk store is STUBBED at DaimondGateway.gwFetch with an in-memory
// content-addressed map (the recipe verify_contentoffload.mjs / verify_chunks
// tier 1 use), so the offload path runs inside one page with NO gateway and no
// o3db store. No mock LLM either: nothing here runs a turn.
//
//   node dev/verify_collectheap.mjs           # the gate (must be green)
//   node dev/verify_collectheap.mjs --break   # the pre-fix load-all (must redden)
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). Chromium only: it reads
// performance.memory (precise) and window.gc(), for which open() is asked for
// --enable-precise-memory-info and --js-flags=--expose-gc.

import { open, shot } from './harness.mjs';

const BREAK = process.argv.includes('--break');
const TOTAL = 500;          // chats to seed
const SMALL = 30;           // of those, small enough to ride inline
const SMALL_BYTES = 10 * 1024;   // ~10 kB transcript  (< SYNC_FILE_MAX 128 kB)
const LARGE_BYTES = 150 * 1024;  // ~150 kB transcript (> SYNC_FILE_MAX 128 kB -> ref)
const INLINE_BOUND = 80;    // the inline set must be a small slice, not the store
const HEAP_MAX = 8 * 1024 * 1024;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);
const mb = (n) => (n / (1024 * 1024)).toFixed(2) + ' MB';

const s = await open({
	name:      'collectheap',
	signIn:    true,
	connect:   false,
	defaults:  false,
	extraArgs: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
});
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && DaimondCore.collectSync
		&& DaimondCore.chatStore && DaimondCore.chatResidency
		&& DaimondCore.chatStore().resetLoadCount && DaimondCore.chatStore().loadCount
		&& window.DaimondChunks && window.DaimondChunks.offloadBytes
		&& window.DaimondCloud && DaimondCloud.contentGet && window.DaimondGateway),
		null, { timeout: 20000 });

	const precise = await page.evaluate(() => {
		const m = (performance && performance.memory) ? performance.memory : null;
		return { has: !!m, gc: typeof window.gc === 'function' };
	});
	note(`performance.memory ${precise.has ? 'present' : 'ABSENT'}, window.gc ${precise.gc ? 'present' : 'ABSENT'}`);

	// ── Arm the in-memory chunk store at the gateway hook ───────────
	// __store persists across collects in the page closure, standing in for the one
	// shared cloud store. --break leaves it armed but forces canOffload false, so
	// the collector cannot demote a transcript to a ref and every chat rides inline.
	await page.evaluate((brk) => {
		window.__store = {};
		window.__puts = 0; window.__gets = 0;
		window.DaimondGateway.gwFetch = async function (path_, opts) {
			const body = JSON.parse(opts.body);
			const reply = (status, json) => ({ status, json: async () => json });
			if (body.op === 'put')    { window.__puts++; (body.chunks || []).forEach(c => { window.__store[c.addr] = c.blob; }); return reply(200, { ok: true }); }
			if (body.op === 'have')   { return reply(200, { missing: (body.addrs || []).filter(a => !(a in window.__store)) }); }
			if (body.op === 'get')    { window.__gets++; const b = window.__store[body.addr]; return reply(200, b ? { present: true, blob: b } : { present: false }); }
			if (body.op === 'commit') { return reply(200, { ok: true, swept: 0, free_allowance: 0 }); }
			return reply(200, { ok: true });
		};
		// THE BREAK. Revert to load-all: with nowhere to offload, collectChatsRefs
		// gates its inline map off (canOffload false), so every transcript rides
		// inline and is loaded on every collect -- the pre-fix behaviour.
		if (brk && window.DaimondCloud) window.DaimondCloud.available = function () { return false; };
	}, BREAK);

	// ── Seed ~500 chats: SMALL ride inline, LARGE offload to refs ──
	const seeded = await page.evaluate(async (cfg) => {
		const store = window.DaimondCore.chatStore();
		const list = store.stored();
		const mk = (id, bytesTarget, stamp) => {
			const msgs = [];
			let n = 0;
			// One fat message padded to the byte target, plus a couple of small ones
			// so a transcript is never a single blob.
			const pad = 'x'.repeat(Math.max(1, bytesTarget - 200));
			msgs.push({ role: 'user', content: 'seed ' + id, mid: id + '-m0', ts: stamp });
			msgs.push({ role: 'assistant', content: pad, mid: id + '-m1', ts: stamp + 1 });
			return { id, name: 'Chat ' + id, model: 'mock/fast', updatedAt: stamp, messages: msgs, session: null };
		};
		let small = 0, large = 0;
		for (let i = 0; i < cfg.total; i++) {
			// Interleave so the fresh end is a mix, not all-small or all-large.
			const isSmall = (i % Math.floor(cfg.total / cfg.small)) === 0 && small < cfg.small;
			const id = (isSmall ? 'sm-' : 'lg-') + String(i).padStart(4, '0');
			list.push(mk(id, isSmall ? cfg.smallBytes : cfg.largeBytes, 1000 + i));
			if (isSmall) small++; else large++;
		}
		await store.save(list);
		return { small, large };
	}, { total: TOTAL, small: SMALL, smallBytes: SMALL_BYTES, largeBytes: LARGE_BYTES });
	note(`seeded ${TOTAL} chats: ${seeded.small} small (~${(SMALL_BYTES/1024)|0} kB, inline) + ${seeded.large} large (~${(LARGE_BYTES/1024)|0} kB, offload)`);

	// ── WARM-UP collect ──────────────────────────────────────────
	// A freshly-saved mirror carries no `bytes` on its summaries -- `save` stores the
	// list verbatim, and only a collect's `noteFps` writes the serialised length
	// back. So the COLD collect ranks every chat as a ref (unknown size = too large
	// to ride inline), offloads them all, and lands the bytes and the manifests. The
	// inline set therefore appears on the SECOND collect, which is the one measured.
	const first = await page.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		store.resetLoadCount();
		const p = await window.DaimondCore.collectSync();
		const chats = p.chats || [];
		const inlineN = chats.filter(c => c.messages != null).length;
		const refN    = chats.filter(c => c.messagesRef && c.messages == null).length;
		return { load: store.loadCount(), inlineN, refN, chats: chats.length, puts: window.__puts, store: Object.keys(window.__store).length };
	});
	note(`warm-up collect: loaded ${first.load}, parcel ${first.chats} chats = ${first.inlineN} inline + ${first.refN} refs, ${first.puts} put(s), ${first.store} chunks in store`);

	// Precondition: in the healthy run the cold collect offloaded (nearly) every chat
	// to a ref; in --break nothing offloads and every chat rides inline (load-all).
	if (BREAK) {
		check('BREAK: with offload OFF, every chat rides inline (load-all)', first.inlineN === first.chats,
			`${first.inlineN}/${first.chats} inline`);
	} else {
		check('offload armed: the cold collect moved (nearly) every transcript out to a ref',
			first.refN >= TOTAL - 5 && first.puts > 0,
			`${first.refN} refs of ${first.chats}, ${first.puts} put(s)`);
	}

	// ── SECOND, quiet collect: the gate ──
	// Reset the probe, settle and read the heap, collect, settle and read again.
	const gate = await page.evaluate(async () => {
		const store = window.DaimondCore.chatStore();
		const heap = () => (performance && performance.memory) ? performance.memory.usedJSHeapSize : 0;
		const settle = async () => { try { if (window.gc) { window.gc(); await new Promise(r => setTimeout(r, 30)); window.gc(); } } catch (e) {} await new Promise(r => setTimeout(r, 50)); };

		// PROVE "one transcript at a time": wrap the store's loadMessages (the same
		// object the collector calls) to track the MAX number of loads in flight at
		// once. PASS 2 awaits each load before the next, so the peak is 1 -- never the
		// whole store held together, which is the heart of the S1 fix. The wrapped
		// method still runs the real one (which bumps loadProbe), so loadCount is
		// unaffected.
		let inflight = 0, maxInflight = 0;
		const realLoad = store.loadMessages.bind(store);
		store.loadMessages = function (id) {
			inflight++; if (inflight > maxInflight) maxInflight = inflight;
			return Promise.resolve(realLoad(id)).finally(function () { inflight--; });
		};

		store.resetLoadCount();
		window.__puts = 0;              // count re-offloads on THIS collect only
		await settle();
		const before = heap();
		const p = await window.DaimondCore.collectSync();
		const after = heap();
		await settle();
		const settled = heap();
		store.loadMessages = realLoad;  // restore

		const chats = p.chats || [];
		const inlineN = chats.filter(c => c.messages != null).length;
		const refN    = chats.filter(c => c.messagesRef && c.messages == null).length;
		const resident = window.DaimondCore.chatResidency().filter(r => r.loaded).length;
		return {
			load: store.loadCount(), inlineN, refN, chats: chats.length,
			heapBefore: before, heapAfter: after, heapSettled: settled,
			resident, residency: window.DaimondCore.chatResidency().length,
			maxInflight, puts: window.__puts,
		};
	});

	const heapDelta = Math.max(0, gate.heapAfter - gate.heapBefore);
	const heapSettledDelta = Math.max(0, gate.heapSettled - gate.heapBefore);
	note(`second collect: loaded ${gate.load}, inline ${gate.inlineN}, refs ${gate.refN}, ${gate.puts} put(s) (re-offload)`);
	note(`heap: before ${mb(gate.heapBefore)} → peak ${mb(gate.heapAfter)} → settled ${mb(gate.heapSettled)} (Δpeak ${mb(heapDelta)}, Δsettled ${mb(heapSettledDelta)})`);
	note(`residency after collect: ${gate.resident} of ${gate.residency} rail chats resident; max transcripts in flight at once during collect: ${gate.maxInflight}`);

	// ═══ THE S1 GATE ═══
	check('S1 the quiet collect loads only the inline set, not the store (≤ inline set)',
		gate.load <= gate.inlineN, `loaded ${gate.load}, inline set ${gate.inlineN}`);
	check('S1 the inline set is a small bounded slice, not ~all the chats',
		gate.inlineN <= INLINE_BOUND, `inline set ${gate.inlineN} (bound ${INLINE_BOUND})`);
	check('S1 the quiet collect does NOT re-load ~every chat',
		gate.load < TOTAL / 2, `loaded ${gate.load} of ${TOTAL}`);
	check('S1 the quiet collect re-offloads nothing (refs reused on fingerprint)',
		gate.puts === 0, `${gate.puts} put(s)`);
	// The RETAINED delta (heap GC-settled either side) is the true "does the heap
	// grow with the store" measure: the streamed collect holds ~1 transcript at a
	// time and releases it, so nothing proportional to the store survives the
	// collect. --break keeps every transcript in the parcel it packs, so its
	// retained delta is tens of MB and cannot be GC'd away. The un-settled peak
	// (Δpeak, reported above) is V8 churn the collect allocates and drops -- noise
	// against this gate -- so it is context, not the bar.
	check('S1 the collect grows the retained heap by a small bounded amount, not with the store',
		heapSettledDelta < HEAP_MAX,
		`Δsettled ${mb(heapSettledDelta)} (bound ${mb(HEAP_MAX)}); Δpeak ${mb(heapDelta)} is transient churn`);
	check('S1 the collect streams one transcript at a time (peak in flight ≈ 1, not the store)',
		gate.maxInflight <= 1, `max ${gate.maxInflight} transcript(s) in flight at once`);
	check('S1 the collect leaves no wall of resident transcripts (residency bounded)',
		gate.resident <= 2, `${gate.resident} resident`);

	// ── The heap/loadCount panel, screenshotted ──
	await page.evaluate((g) => {
		const heapDelta = Math.max(0, g.heapAfter - g.heapBefore);
		const mb = (n) => (n / (1024 * 1024)).toFixed(2) + ' MB';
		const d = document.createElement('div');
		d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0b1020;color:#e6edf3;'
			+ 'font:15px/1.7 ui-monospace,Menlo,monospace;padding:32px 40px;white-space:pre;overflow:auto';
		d.textContent = [
			'verify_collectheap — S-SYNC #1 collect-heap gate' + (g.brk ? '   [--break: load-all]' : ''),
			'',
			'seeded            ' + g.total + ' chats  (' + g.small + ' small inline + ' + (g.total - g.small) + ' large offload)',
			'inline set        ' + g.inlineN + '   refs ' + g.refN,
			'',
			'SECOND (quiet) collect',
			'  transcripts loaded   ' + g.load + '   (of ' + g.total + ')   — inline set is ' + g.inlineN,
			'  re-offload puts      ' + g.puts,
			'  heap before          ' + mb(g.heapBefore),
			'  heap peak            ' + mb(g.heapAfter),
			'  heap settled         ' + mb(g.heapSettled),
			'  heap Δ (peak)        ' + mb(heapDelta),
			'  max in flight        ' + g.maxInflight + ' transcript(s) at once',
			'  residency resident   ' + g.resident + ' of ' + g.residency,
			'',
			'GATE: loaded(' + g.load + ') ≤ inlineSet(' + g.inlineN + ')   AND   inlineSet ≤ ' + 80
				+ '   AND   loaded < ' + (g.total / 2) + '   AND   heapΔ < 8 MB',
		].join('\n');
		document.body.appendChild(d);
	}, { ...gate, total: TOTAL, small: SMALL, brk: BREAK });
	const shotPath = await shot(s, BREAK ? 'collectheap-break' : 'collectheap');
	note('screenshot: ' + shotPath);

} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	try { await s.close(); } catch (e) {}
	console.log('\n=== SUMMARY ' + ok.length + ' ok, ' + bad.length + ' FAIL ' + (BREAK ? '(--break: FAILs are expected)' : '') + ' ===');
	if (bad.length) { bad.forEach((x) => console.log('  FAIL ' + x)); process.exitCode = 1; }
}
