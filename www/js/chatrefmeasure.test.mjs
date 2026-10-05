/* ============================================================
   Test -- the form of a chat in the parcel is a function of its size and the budget,
   never of whether a bookkeeping field happens to be known (D-20260924-28, 5 Oct 2026).
   ------------------------------------------------------------
   THE FAULT. `collectChatsRefs` ranks the inline set from each summary's `bytes` and read a
   summary with none as `Infinity`, so a small chat with no figure went as a REFERENCE:
   loaded, offloaded as a chunk, and only then measured by `noteFps`. The figure is wiped
   by every merge into a chat not resident (`carryChatFigures` cannot vouch for the copy in
   hand), so the form flipped between reference and inline as a peer's turn arrived. The
   last device to come back online pushed the reference, nothing asked for another round
   while the system was quiet, and the soak's `[converge]` saw one chat inline on every
   device and by reference at the gateway (seed aa9ec2b4, 43/1 four nights out of four).

   THE FIX. Pass 1 measures a summary with no `bytes` from the store, one transcript at a
   time, and hands the figure to `noteFps`. The inline-or-reference choice is then the same
   whatever the mirror knew. A quiet collect still loads nothing for a reference, since
   after the first round every summary is measured.

   WHAT IS CHECKED, on the REAL `collectChatsRefs` lifted from the tree under test
   (dev/syncprobe.mjs, `TREE=<checkout>` to aim it elsewhere), against a store that counts
   loads, tracks the transcripts resident at once and keeps `noteFps`'s seed test:
     1. a merged small chat with no figure rides inline, and nothing is offloaded for it;
     2. the figure is written back, so the next collect measures nothing;
     3. the form of a mixed store is the same whether or not the mirror knew the sizes, over
        generated stores and budgets (the property the bug broke);
     4. a quiet collect loads the inline set and nothing else;
     5. a large unmeasured chat whose manifest still stands is loaded ONCE, not measured and
        then loaded again to fingerprint, and re-offloads nothing;
     6. the measuring pass holds one transcript at a time;
     7. a load that fails in the measuring pass (in the reader's real shape, `failed: true`) is
        neither measured nor packed, and does not fail the collect;
     8. the figures a collect writes back are the serial's length and fileHash, beside the seed
        the summary held when the collect began;
     9. a failed read in the streaming pass reuses a stored manifest, or waits a round, and
        offloads and records nothing (r533 QA A-F1).
     node www/js/chatrefmeasure.test.mjs            # ALL PASS
   ============================================================ */
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const ser = (m) => JSON.stringify(m);
const msgs = (tag, n, len) => Array.from({ length: n }, (_, i) => ({
	role: i % 2 ? 'assistant' : 'user', mid: tag + '-m' + i, ts: 1000 + i,
	content: ((tag + i + ' lorem ipsum ').repeat(Math.ceil(len / 12))).slice(0, len) }));

/// A store of `specs` ({ id, at, msgs, known, manifest }), a collect lifted from the tree,
/// and the instruments. `known` false is the state a merge leaves: no `bytes`, an empty
/// `fp`, the `seed` of the copy in hand.
function world(specs, opts) {
	opts = opts || {};
	const win = makeWindow({ now: 1_000_000_000 });
	const { fileHash } = sliceDaimond(win, ['fileHash'], {}).fns;
	const transcripts = {}, mirror = [], manifests = {}, offloaded = [], writes = [];
	let loads = 0, resident = 0, peak = 0, perId = {}, failOnce = opts.failOnce || null;
	const failReads = Object.assign({}, opts.failReads || {});		// id -> reads still to fail in the reader's own shape
	specs.forEach((s) => {
		transcripts[s.id] = s.msgs;
		const sr = ser(s.msgs);
		const sum = { id: s.id, name: s.id, model: 'm', provider: '', updatedAt: s.at, metaAt: s.at, status: 'active', seed: fileHash(sr) };
		if (s.known) { sum.bytes = sr.length; sum.fp = fileHash(sr); } else { sum.fp = ''; }
		mirror.push(sum);
		if (s.manifest) manifests['@c/' + s.id] = { v: 1, size: sr.length, key: 'K-' + fileHash(sr), chunks: ['k-' + s.id], fp: fileHash(sr) };
	});
	const ChatStore = {
		stored:       () => mirror,
		settled:      () => Promise.resolve(),
		loadMessages: async (id) => {
			if (failOnce === id) { failOnce = null; throw new Error('transient read fault on ' + id); }
			// The REAL reader never throws: a read it could not make is empty and flagged.
			if (failReads[id] > 0) { failReads[id]--; loads++; return { messages: [], session: null, failed: true }; }
			loads++; perId[id] = (perId[id] || 0) + 1; resident++; if (resident > peak) peak = resident;
			const m = transcripts[id];
			await Promise.resolve();			// the caller releases it before the next chat
			resident--;
			return { messages: m.slice() };
		},
		noteFps: (fixes) => {					// the mirror half of the real one, seed test included
			fixes.forEach((f) => {
				writes.push(f);
				const m = mirror.find((x) => x.id === f.id);
				if (m && (m.seed || '') === (f.seed || '')) { if (typeof f.bytes === 'number') m.bytes = f.bytes; if (f.fp) m.fp = f.fp; }
			});
		},
	};
	win.DaimondChunks = { offloadBytes: async (tag, bytes) => {
		const s = new TextDecoder().decode(bytes); offloaded.push(tag);
		return { v: 1, size: s.length, key: 'K-' + fileHash(s), chunks: ['k-' + tag] };
	} };
	win.DaimondCloud = {
		available:     () => true,
		contentGet:    (k) => manifests[k] || null,
		contentSet:    (k, m) => { manifests[k] = m; return true; },
		contentForget: () => {},
		contentReap:   () => {},
	};
	const { collectChatsRefs } = sliceDaimond(win, ['collectChatsRefs'], {
		ChatStore, storedChats: () => ChatStore.stored(), noteCloudIndexStuck: () => {},
	}).fns;
	const form = (parcel) => parcel.map((e) => e.id + (e.messages ? ':I' : (e.messagesRef ? ':R' : ':?'))).sort().join(' ');
	return { collect: collectChatsRefs, form, mirror, offloaded, writes, fileHash,
		stats: () => ({ loads, peak, perId }), reset: () => { loads = 0; peak = 0; perId = {}; offloaded.length = 0; writes.length = 0; } };
}

const ONE = (parcel, id) => parcel.find((e) => e.id === id);

// ── 1 and 2. the fault, as the soak met it ─────────────────────────────────
console.log('1. a merged small chat with no figure');
{
	const specs = [
		{ id: 'o6kv1', at: 30, msgs: msgs('o', 5, 370), known: false },		// ~1.8 kB, the soak's chat 10
		{ id: 'a',     at: 20, msgs: msgs('a', 2, 300), known: false },
		{ id: 'b',     at: 10, msgs: msgs('b', 1, 200), known: false },
	];
	const w = world(specs);
	const first = await w.collect();
	check('every small unmeasured chat rides inline', w.form(first) === 'a:I b:I o6kv1:I', w.form(first));
	check('nothing was offloaded for them', w.offloaded.length === 0, 'offloaded ' + w.offloaded.join(','));
	check('no inline entry names a reference', first.every((e) => !e.messagesRef));
	const o = specs[0], so = ser(o.msgs);
	const fix = w.writes.find((f) => f.id === 'o6kv1');
	check('the figures written back are the serial\'s length and fileHash, beside the seed held',
		!!fix && fix.bytes === so.length && fix.fp === w.fileHash(so) && fix.seed === w.fileHash(so),
		JSON.stringify(fix));
	check('2. the mirror now holds the figures', w.mirror.every((m) => typeof m.bytes === 'number' && m.fp),
		JSON.stringify(w.mirror.map((m) => [m.id, m.bytes])));
	w.reset();
	const second = await w.collect();
	check('2. the next collect has the same form', w.form(second) === 'a:I b:I o6kv1:I', w.form(second));
	check('2. and measures and writes nothing back', w.writes.length === 0, 'wrote ' + w.writes.length);
	check('4. and loads the inline set and nothing else', w.stats().loads === 3, 'loads ' + w.stats().loads);
}

// ── 3. the property ────────────────────────────────────────────────────────
console.log('3. the form does not depend on what the mirror knew');
{
	let s = 12345;
	const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
	let worlds = 0, agreed = 0, firstBad = '';
	for (let t = 0; t < 40; t++) {
		const n = 3 + Math.floor(rnd() * 9);
		const specs = [];
		for (let i = 0; i < n; i++) {
			// Sizes from 100 B to ~200 kB, so some are over the file ceiling and the budget binds.
			const len = Math.floor(Math.pow(10, 2 + rnd() * 3.3));
			specs.push({ id: 'c' + i, at: 1000 + Math.floor(rnd() * 50), msgs: msgs('c' + i, 1 + Math.floor(rnd() * 4), len) });
		}
		const budget = Math.floor(Math.pow(10, 3 + rnd() * 3));
		const known   = world(specs.map((x) => Object.assign({}, x, { known: true,  manifest: false })));
		const unknown = world(specs.map((x) => Object.assign({}, x, { known: false, manifest: false })));
		const a = known.form(await known.collect(budget)), b = unknown.form(await unknown.collect(budget));
		worlds++;
		if (a === b) agreed++; else if (!firstBad) firstBad = 'budget ' + budget + '\n    known   ' + a + '\n    unknown ' + b;
		// The second collect of the unknown world must also agree: the mirror has learned.
		const c = unknown.form(await unknown.collect(budget));
		if (c !== a && !firstBad) firstBad = 'second collect, budget ' + budget + '\n    known   ' + a + '\n    second  ' + c;
	}
	check('over ' + worlds + ' generated stores and budgets, an unmeasured mirror collects the form a measured one does',
		agreed === worlds && !firstBad, firstBad || (agreed + '/' + worlds));
}

// ── 5. a large chat whose manifest stands ──────────────────────────────────
console.log('5. a large unmeasured chat with a manifest it still matches');
{
	const big = msgs('big', 2, 150 * 1024);									// over the 128 kB file ceiling
	const small = msgs('sm', 2, 600);
	const specs = [
		{ id: 'big', at: 5,  msgs: big,   known: false, manifest: true },
		{ id: 'sm',  at: 9,  msgs: small, known: false },
	];
	const w = world(specs);
	const first = await w.collect();
	check('the large chat is a reference and the small one inline', w.form(first) === 'big:R sm:I', w.form(first));
	check('the stored manifest is reused, nothing is offloaded', w.offloaded.length === 0, 'offloaded ' + w.offloaded.join(','));
	check('and the large chat is loaded once, not measured then loaded again', w.stats().perId.big === 1, 'big loaded ' + w.stats().perId.big + ' time(s)');
	w.reset();
	const second = await w.collect();
	check('the quiet collect reuses the reference with no load: only the inline chat is read', w.stats().loads === 1 && w.form(second) === 'big:R sm:I',
		'loads ' + w.stats().loads + ' ' + w.form(second));
	check('and measures and writes nothing', w.writes.length === 0 && w.offloaded.length === 0, 'wrote ' + w.writes.length);
}

// ── 6. one transcript at a time ────────────────────────────────────────────
console.log('6. the measuring pass holds one transcript at a time');
{
	const specs = [];
	for (let i = 0; i < 60; i++) specs.push({ id: 'c' + i, at: i, msgs: msgs('c' + i, 3, 2000 + i * 400), known: false });
	const w = world(specs);
	await w.collect(20 * 1024);
	check('never two transcripts resident at once', w.stats().peak <= 1, 'peak ' + w.stats().peak);
}

// ── 7. a read fault while measuring ────────────────────────────────────────
// `ChatStore.loadMessages` never throws (daimond.js, its own catch): a read it could not make,
// or a cold one that spent its retries on a chat the store says holds messages, comes back as
// `{ messages: [], session: null, failed: true }`. Check 7 first used a stub that THREW, a
// shape the real reader cannot produce, so it passed while a failed read was measured as 2 bytes.
console.log('7. a load that fails while measuring (the reader\'s real failure shape)');
{
	const specs = [
		{ id: 'x', at: 9, msgs: msgs('x', 2, 500), known: false },
		{ id: 'y', at: 8, msgs: msgs('y', 2, 500), known: false },
	];
	const w = world(specs, { failReads: { x: 1 } });
	let first = null, threw = '';
	try { first = await w.collect(); } catch (e) { threw = String((e && e.message) || e); }
	check('the collect still resolves', !!first && !threw, threw);
	check('the chat that could not be measured stays a reference this round (the conservative side)',
		!!first && !!ONE(first, 'x') && !!ONE(first, 'x').messagesRef && !!ONE(first, 'y') && !!ONE(first, 'y').messages,
		first ? w.form(first) : threw);
	const mx = w.mirror.find((m) => m.id === 'x');
	check('no figure was recorded from the failed read', !(mx && mx.bytes === 2) && !w.writes.some((f) => f.id === 'x' && f.bytes === 2),
		JSON.stringify(w.writes.map((f) => [f.id, f.bytes])));
	w.reset();
	const second = first ? await w.collect() : null;
	check('and is inline once measured', !!second && w.form(second) === 'x:I y:I', second ? w.form(second) : '');
}
console.log('7b. a load that throws while measuring (a stub the reader cannot be, kept for the guard)');
{
	const specs = [
		{ id: 'x', at: 9, msgs: msgs('x', 2, 500), known: false },
		{ id: 'y', at: 8, msgs: msgs('y', 2, 500), known: false },
	];
	const w = world(specs, { failOnce: 'x' });
	let first = null, threw = '';
	try { first = await w.collect(); } catch (e) { threw = String((e && e.message) || e); }
	check('a throw leaves the chat a reference and the collect through', !!first && !threw && !!ONE(first, 'x').messagesRef && !!ONE(first, 'y').messages, threw || (first ? w.form(first) : ''));
}

// ── 9. a failed read in the streaming pass ──────────────────────────────────
console.log('9. a failed read in pass 2 is neither fingerprinted nor offloaded');
{
	const big = msgs('big', 2, 150 * 1024);
	// The chat is measured by neither pass (both reads fail), its manifest still stands.
	const withManifest = world([{ id: 'big', at: 5, msgs: big, known: false, manifest: true }, { id: 'sm', at: 9, msgs: msgs('sm', 2, 600), known: false }],
		{ failReads: { big: 2 } });
	const a = await withManifest.collect();
	check('the stored manifest is reused', withManifest.form(a) === 'big:R sm:I', withManifest.form(a));
	check('nothing is offloaded for it', withManifest.offloaded.length === 0, 'offloaded ' + withManifest.offloaded.join(','));
	check('and no figure is recorded for it', !withManifest.writes.some((f) => f.id === 'big'), JSON.stringify(withManifest.writes.map((f) => [f.id, f.bytes])));
	const bare = world([{ id: 'big', at: 5, msgs: big, known: false, manifest: false }, { id: 'sm', at: 9, msgs: msgs('sm', 2, 600), known: false }],
		{ failReads: { big: 2 } });
	const b = await bare.collect();
	check('with no manifest the chat waits a round and no empty transcript is offloaded', bare.form(b) === 'sm:I' && bare.offloaded.length === 0,
		bare.form(b) + ' offloaded ' + bare.offloaded.join(','));
	check('and no figure is recorded for it', !bare.writes.some((f) => f.id === 'big'), JSON.stringify(bare.writes.map((f) => [f.id, f.bytes])));
	bare.reset();
	const c = await bare.collect();
	check('the next round reads it and sends it as a reference', bare.form(c) === 'big:R sm:I' && bare.offloaded.length === 1, bare.form(c) + ' offloaded ' + bare.offloaded.join(','));
}

console.log(failures ? '\nFAILED ' + failures + '/' + checks : '\nALL PASS (' + checks + ' checks)');
process.exit(failures ? 1 : 0);
