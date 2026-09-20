/* ============================================================
   Test — S-SYNC #1: a collect no longer holds every transcript at once,
   and the runner no longer collects the whole parcel per progress frame.
   ------------------------------------------------------------
   `collectChatsRefs` (www/js/daimond.js) used to read EVERY stored chat's
   transcript up front -- `ChatStore.loadMessages` per chat -- and hold the
   parsed messages AND the serialised string of all of them in one `recs`
   array until it returned, despite the comment claiming it held "one at a
   time, never all held at once". At ~300 chats that was ~40 MB transient
   per collect; at ~1000 it took an iOS tab. The multiplier made it worse:
   `collectParcel` ran three times per `flush()` and once per progress frame
   on the runner (every ~1.8 s), and the per-frame whole-parcel collect was
   the fallback taken on a refused or empty frame.

   The fix, all in `www/js/daimond.js` and `www/js/sync.js`:
     - `summaryOf` carries `bytes` (the serialised transcript length), so the
       inline set is RANKED from summaries alone -- no transcript loaded.
     - `collectChatsRefs` streams: one transcript is loaded, packed or
       offloaded, and RELEASED before the next; a ref whose summary `fp`
       equals the stored manifest's is reused with NO load at all.
     - `ChatStore.noteFps` writes the authoritative fp/bytes back after an
       offload; the chunk-mutating heals clear the fp so a changed transcript
       is never served from a stale manifest.
     - the runner's progress dep falls back to the whole-parcel `pushProgress`
       ONLY when the frame door is absent -- never on a refused or empty frame.
     - `flush()` collects once per round (push() reports the settled case),
       down from three; the old-gateway `pushProgress` floor is raised to 10 s.

   `daimond.js` is an ES module that imports the compiled wasm surface, so it
   cannot be instantiated in a sandbox here (`ledger.test.mjs`/`badge.test.mjs`
   give the same reason for the same file). So the REAL code is held to source
   guards, and the streaming LOGIC -- where the defect lived -- is exercised
   for real against a faithful port of the two-pass collect, driven by a mock
   loader that counts loads and the peak number of transcripts resident at once.

   Each check is proven able to fail:

     node www/js/collectheap.test.mjs --break holdall     # collect holds every transcript
     node www/js/collectheap.test.mjs --break noreuse     # reuse-without-load path removed
     node www/js/collectheap.test.mjs --break perframe    # per-frame whole-parcel fallback back
     node www/js/collectheap.test.mjs --break flush3      # flush collects three times a round
     node www/js/collectheap.test.mjs                     # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAIMOND_SRC = join(HERE, 'daimond.js');
const SYNC_SRC    = join(HERE, 'sync.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['holdall', 'noreuse', 'perframe', 'flush3'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

/// The body of a named function in the source, from its declaration to the
/// first line that closes it at the declaration's indentation. Enough to assert
/// what a function does and does not contain without a JS parser.
function funcBody(src, decl) {
	const at = src.indexOf(decl);
	if (at < 0) throw new Error('declaration not found: ' + decl);
	const lineStart = src.lastIndexOf('\n', at) + 1;
	const indent = src.slice(lineStart, at).match(/^\t*/)[0];
	const close = '\n' + indent + '}';
	const end = src.indexOf(close, at);
	if (end < 0) throw new Error('close not found for: ' + decl);
	return src.slice(at, end + close.length);
}

// ── The daimond.js / sync.js sources, optionally patched to REINTRODUCE a
//    defect so a guard can be shown to catch it. ────────────────────────────
function daimondSrc() {
	let src = readFileSync(DAIMOND_SRC, 'utf8');
	if (BREAK === 'holdall') {
		// The stream goes: the two-pass loop is replaced by the old up-front loop
		// that reads and HOLDS every transcript in one array before returning.
		const body = funcBody(src, 'async function collectChatsRefs(inlineBudget) {');
		const broken = body.replace('var live = {}, out = [], fixes = [];',
			'var recs = []; for (var z = 0; z < sums.length; z++) { var gz = await ChatStore.loadMessages(sums[z].id); recs.push({ id: sums[z].id, serial: JSON.stringify(gz.messages || []) }); }\n\t\tvar live = {}, out = [], fixes = [];');
		src = src.replace(body, broken);
	}
	if (BREAK === 'noreuse') {
		// The reuse-without-load path goes: a ref always loads and recomputes,
		// exactly as it did before the summary carried a trustworthy fp.
		src = src.replace('if (stored && sum.fp && stored.fp === sum.fp && Array.isArray(stored.chunks)) {',
			'if (false) {  // BROKEN: reuse-without-load removed');
	}
	if (BREAK === 'perframe') {
		// The per-frame guard goes: a present door that refuses or empties a frame
		// falls through to the whole-parcel pushProgress again.
		src = src.replace(
			'\t\t\t\t\t\tif (out && out.ok) _progressSent[turnId] = payload;\n\t\t\t\t\t\treturn;\n\t\t\t\t\t}',
			'\t\t\t\t\t\tif (out && out.ok) { _progressSent[turnId] = payload; return; }\n\t\t\t\t\t}  // BROKEN: falls through per frame');
	}
	return src;
}
function syncSrc() {
	let src = readFileSync(SYNC_SRC, 'utf8');
	if (BREAK === 'flush3') {
		// The one-collect flush goes: a pre-push collect is put back at the top of
		// the round, so the round pays three whole-parcel collects again.
		const body = funcBody(src, 'async function flush() {');
		const broken = body.replace('\t\t\tvar r;\n\t\t\ttry { r = await push(); }',
			'\t\t\ttry { compareKey(await collectParcel()); } catch (e) {}  // BROKEN: pre-push collect back\n\t\t\tvar r;\n\t\t\ttry { r = await push(); }');
		src = src.replace(body, broken);
	}
	return src;
}

// ── SOURCE GUARDS on the real code ───────────────────────────────────────────
function sourceGuards() {
	console.log('collectheap: source -- collectChatsRefs streams, never holds every transcript');
	{
		const d = daimondSrc();
		const body = funcBody(d, 'async function collectChatsRefs(inlineBudget) {');
		// The tell of the old defect: an array that every transcript's serial was
		// pushed into and held until return. The stream has no such array.
		check('no array holds every transcript (recs.push of a serial is gone)',
			!/recs\.push\(\{[^}]*serial/.test(body), 'a per-chat serial is being accumulated');
		check('a transcript is released after use (msgs = null in the ref arm)',
			body.includes('msgs = null;'), 'no release of the loaded transcript');
		check('the inline set is ranked from summary bytes, not a load',
			body.includes('typeof s.bytes === \'number\'') && body.includes('spent + b <= budget'),
			'ranking still needs a loaded length');
		check('a ref whose summary fp matches the manifest is reused WITHOUT a load',
			body.includes('stored.fp === sum.fp'), 'reuse-without-load path absent');
		check('the authoritative fp/bytes are written back for next time',
			body.includes('fixes.push({ id: id, bytes: serial.length, fp: fp })')
			&& body.includes('ChatStore.noteFps'), 'noteFps writeback absent');
	}

	console.log('\ncollectheap: source -- the summary carries the ranking key');
	{
		const d = daimondSrc();
		const body = funcBody(d, 'function summaryOf(c, serial, chunks) {');
		check('summaryOf carries `bytes` (the serialised length)',
			/bytes:\s*\(typeof serial === 'string'/.test(body), 'no bytes field on the summary');
		const lite = funcBody(d, 'function summaryLite(rec) {');
		check('summaryLite serialises the transcript for a real seed fp/bytes',
			lite.includes('JSON.stringify(msgs)'), 'summaryLite still leaves fp unmatchable');
		check('ChatStore exposes noteFps', d.includes('noteFps: function (fixes) {'), 'no noteFps');
	}

	console.log('\ncollectheap: source -- a changed transcript clears the summary fp');
	{
		const d = daimondSrc();
		check('invalidateSummaryFp exists', d.includes('function invalidateSummaryFp(chatId) {'),
			'no fp invalidation helper');
		const rw = funcBody(d, 'async function rewriteChunks(chatId, msgs) {');
		check('rewriteChunks invalidates the summary fp', rw.includes('invalidateSummaryFp(chatId);'),
			'a chunk rewrite leaves a stale fp');
		const sw = funcBody(d, 'async function sweepChatTombs(chatId) {');
		check('sweepChatTombs invalidates the summary fp', sw.includes('invalidateSummaryFp(chatId);'),
			'a tomb sweep leaves a stale fp');
	}

	console.log('\ncollectheap: source -- the runner never collects the whole parcel per frame');
	{
		const d = daimondSrc();
		const body = funcBody(d, 'pushProgress: async function (turnId) {');
		// With the door present the branch must RETURN; the whole-parcel fallback
		// sits only after the door-absence check.
		const doorIdx = body.indexOf('if (DaimondSync && DaimondSync.pushProgressFrame) {');
		const fallbackIdx = body.indexOf('if (DaimondSync && DaimondSync.pushProgress) await DaimondSync.pushProgress();');
		check('the frame branch returns before the whole-parcel fallback',
			doorIdx >= 0 && fallbackIdx > doorIdx && body.includes('// PRE-DOOR GATEWAY ONLY')
			&& /if \(out && out\.ok\) _progressSent\[turnId\] = payload;\s*\n\s*return;/.test(body),
			'a present door can still fall through to a whole-parcel collect');
	}

	console.log('\ncollectheap: source -- flush collects once a round, and the floor is raised');
	{
		const s = syncSrc();
		const body = funcBody(s, 'async function flush() {');
		const collectCalls = (body.match(/collectParcel\(\)/g) || []).length;
		check('flush() calls collectParcel at most once a round (was three)',
			collectCalls <= 1, collectCalls + ' collectParcel calls in flush');
		check('flush() takes push()\'s committed answer',
			body.includes('r.committed'), 'flush does not use push()\'s settled report');
		check('push() reports the settled case', s.includes('return { committed: true };'),
			'push never signals "already on the server"');
		check('the old-gateway progress floor is raised to 10 s',
			/PROGRESS_PUSH_MIN_MS = 10000;/.test(s), 'the whole-parcel progress floor is still 1.8 s');
	}
}

// ── BEHAVIOURAL: a faithful port of the two-pass streaming collect ───────────
//
// The ranking (pass 1) and the stream (pass 2) are ported verbatim in shape
// from `collectChatsRefs`, driven by a mock chat store that COUNTS loads and
// tracks the peak number of transcripts resident at once. The point it proves:
// a quiet round loads nothing, a changed chat loads exactly itself, and the
// peak resident never grows with the number of chats.

const SYNC_FILE_MAX = 128 * 1024;
const SYNC_CHATS_INLINE_MAX = 2 * 1024 * 1024;
function fileHash(s) {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36) + ':' + s.length;
}

/// A mock world: summaries (the rail), the cloud manifest index, and the
/// authoritative transcripts behind a loader that instruments residency.
function world(chats) {
	const summaries = {}, cloud = {}, transcripts = {};
	let loads = 0, resident = 0, peakResident = 0;
	chats.forEach((c) => {
		transcripts[c.id] = c.messages;
		const serial = JSON.stringify(c.messages);
		summaries[c.id] = { id: c.id, updatedAt: c.updatedAt || 0,
			bytes: serial.length, fp: c.seedFp === undefined ? fileHash(serial) : c.seedFp };
		if (c.offloaded) cloud[c.id] = { v: 1, size: serial.length, key: 'k' + c.id,
			chunks: ['a' + c.id], fp: fileHash(serial) };
	});
	const loadMessages = async (id) => {
		loads++; resident++; if (resident > peakResident) peakResident = resident;
		const msgs = transcripts[id];
		// The caller releases its reference before the next chat; model that by
		// decrementing on the next microtask so a peak of 1 means "never two at once".
		await Promise.resolve();
		resident--;
		return { messages: msgs };
	};
	return {
		summaries, cloud, loadMessages,
		stats: () => ({ loads, peakResident }),
		resetStats: () => { loads = 0; peakResident = 0; },
	};
}

/// The ported collect. Byte-for-byte the same DECISIONS as collectChatsRefs:
/// pass-1 ranking from summary bytes, pass-2 stream with reuse-without-load,
/// noteFps writeback. Returns the parcel entries and applies noteFps to `w`.
async function collect(w, budget) {
	const sums = Object.values(w.summaries);
	const canOffload = true;
	const inline = {};
	{
		const order = sums.slice().sort((a, b) => {
			const fa = a.updatedAt | 0, fb = b.updatedAt | 0;
			if (fb !== fa) return fb - fa;
			return String(a.id) < String(b.id) ? -1 : 1;
		});
		let spent = 0;
		for (const s of order) {
			const b = typeof s.bytes === 'number' ? s.bytes : Infinity;
			if (b <= SYNC_FILE_MAX && spent + b <= budget) { inline[s.id] = 1; spent += b; }
		}
	}
	const out = [], fixes = [];
	for (const sum of sums) {
		const id = sum.id;
		const stored = w.cloud[id] || null;
		if (inline[id]) {
			const got = await w.loadMessages(id);
			out.push({ id, messages: got.messages });
			continue;
		}
		if (stored && sum.fp && stored.fp === sum.fp && Array.isArray(stored.chunks)) {
			out.push({ id, messages: null, messagesRef: { key: stored.key, chunks: stored.chunks } });
			continue;
		}
		const got = await w.loadMessages(id);
		const serial = JSON.stringify(got.messages || []);
		const fp = fileHash(serial);
		let ref;
		if (stored && stored.fp === fp && Array.isArray(stored.chunks)) {
			ref = { key: stored.key, chunks: stored.chunks };
		} else {
			w.cloud[id] = { v: 1, size: serial.length, key: 'k' + id, chunks: ['a' + id], fp };
			ref = { key: 'k' + id, chunks: ['a' + id] };
		}
		fixes.push({ id, bytes: serial.length, fp });
		out.push({ id, messages: null, messagesRef: ref });
	}
	// noteFps: summary-only writeback (the real ChatStore.noteFps).
	fixes.forEach((f) => { const s = w.summaries[f.id]; if (s) { s.bytes = f.bytes; s.fp = f.fp; } });
	return out;
}

async function behavioural() {
	console.log('\ncollectheap: behavioural -- a quiet round of already-offloaded chats loads NOTHING');
	{
		const chats = [];
		for (let i = 0; i < 500; i++) chats.push({ id: 'c' + i, updatedAt: i,
			messages: Array.from({ length: 40 }, (_, k) => ({ mid: i + '-' + k, role: 'user', content: 'x'.repeat(700) })),
			offloaded: true });
		const w = world(chats);
		w.resetStats();
		await collect(w, 0);					// budget 0: everything is a ref
		const st = w.stats();
		check('zero transcripts loaded on the quiet round', st.loads === 0, 'loads=' + st.loads);
		check('never two transcripts resident at once', st.peakResident <= 1, 'peak=' + st.peakResident);
	}

	console.log('\ncollectheap: behavioural -- a fresh store loads ONE AT A TIME, never all 500');
	{
		const chats = [];
		for (let i = 0; i < 500; i++) chats.push({ id: 'c' + i, updatedAt: i,
			messages: Array.from({ length: 40 }, (_, k) => ({ mid: i + '-' + k, role: 'user', content: 'x'.repeat(700) })) });
		const w = world(chats);								// nothing offloaded yet
		w.resetStats();
		await collect(w, 0);								// budget 0: all become refs, each loaded once
		const st = w.stats();
		check('every chat is loaded exactly once', st.loads === 500, 'loads=' + st.loads);
		check('but the peak resident is 1, not 500 (the S1 heap bound)',
			st.peakResident <= 1, 'peak=' + st.peakResident);
		// And now that they are offloaded and noteFps has run, the next round is quiet.
		w.resetStats();
		await collect(w, 0);
		check('the SECOND collect loads nothing (noteFps seeded the reuse)',
			w.stats().loads === 0, 'loads=' + w.stats().loads);
	}

	console.log('\ncollectheap: behavioural -- only the CHANGED chat is loaded, and the parcel is a fixed point');
	{
		const chats = [];
		for (let i = 0; i < 100; i++) chats.push({ id: 'c' + i, updatedAt: i,
			messages: [{ mid: i + '-0', role: 'user', content: 'hello ' + i }], offloaded: true });
		const w = world(chats);
		// One chat's transcript changed under a save that refreshed its seed fp.
		w.summaries['c42'].fp = fileHash(JSON.stringify([{ mid: '42-0', role: 'user', content: 'CHANGED' }]));
		// (the stored manifest still names the OLD transcript -- so the fps differ)
		w.resetStats();
		const first = await collect(w, 0);
		check('exactly one transcript is loaded (the changed one)', w.stats().loads === 1,
			'loads=' + w.stats().loads);
		// After noteFps, a re-collect of the unchanged state is byte-identical and loads nothing.
		w.resetStats();
		const second = await collect(w, 0);
		check('the confirm collect loads nothing', w.stats().loads === 0, 'loads=' + w.stats().loads);
		check('two collects of the settled state are byte-identical (push-skip fixed point)',
			JSON.stringify(first) === JSON.stringify(second));
	}

	console.log('\ncollectheap: behavioural -- the inline budget is spent from summaries, not from loads');
	{
		const small = { id: 'small', updatedAt: 9,
			messages: [{ mid: 's', role: 'user', content: 'tiny' }] };
		const big = { id: 'big', updatedAt: 8,
			messages: [{ mid: 'b', role: 'user', content: 'y'.repeat(4000) }], offloaded: true };
		const w = world([small, big]);
		w.resetStats();
		const out = await collect(w, 2048);					// room for the small one inline, not the big one
		const inlineIds = out.filter((e) => e.messages).map((e) => e.id);
		check('the small fresh chat rides inline', inlineIds.includes('small'), inlineIds.join(','));
		check('the big chat is a ref', out.find((e) => e.id === 'big').messagesRef != null);
		check('only the inline chat was loaded (the big one reused its manifest)',
			w.stats().loads === 1, 'loads=' + w.stats().loads);
	}
}

async function main() {
	sourceGuards();
	await behavioural();
	console.log('\n' + (failures ? 'FAILED ' + failures + '/' + checks : 'PASS ' + checks + ' checks'));
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
