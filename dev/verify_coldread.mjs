// verify_coldread.mjs -- the client-only fix bundle for the iOS/desktop cold-read
// family (transcript loss, permanent data loss, updater login-on-focus, release
// "not published" false alarm).
//
// All four faults share one shape: a store read that came back EMPTY on a cold
// tab, or a fetch that failed once, was then trusted as the truth. The fixes make
// each read distrust a cold-empty result the way identity.js's existsSettled
// already does, and stop a failed read being written back as fact.
//
// The proofs, each of which would be invisible if the fix were absent:
//
//   1  COLD-READ RETRY (Fix 1, www/js/daimond.js loadMessages). A transcript read
//      that comes back empty WHILE the chat's summary says msgCount>0 is retried
//      over a bounded budget rather than returned empty -- so a chunk write that
//      lands mid-retry is picked up. A genuinely empty chat still returns at once.
//   2  NO BLANK-OVER-NON-EMPTY (Fix 2, www/js/daimond.js write). A save carrying an
//      EMPTY resident transcript is unioned against disk, so it can never blank a
//      legacy row / summary that still holds the messages (the tag-loss family).
//   3  RELEASE LOG NOT MEMOISED (Fix 5, www/js/release.js). A failed log fetch is
//      not remembered as "loaded", so the next open retries; an unreachable log
//      says so (rel.log_unreachable) rather than libelling a build as not_published.
//   4  UPDATER LEAVES AN UNLOCKED TAB ALONE (Fix 4, www/js/updater.js). A pending
//      build does NOT silently reload an UNLOCKED tab (which would re-seal the
//      passphrase key and drop it to login); it leaves the banner to offer Reload.
//      A LOCKED tab, with nothing to lose, still auto-updates.
import { open, errors, APP } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'coldread' });
const p = s.page;
await p.waitForTimeout(1500);

// ── Fix 1: a cold-empty transcript read retries when the summary says otherwise ──
// The chat's summary is a tiny row that settles first on a cold tab; its chunks
// are the large rows that lag. So a summary saying msgCount>0 over an empty chunk
// read is the tell of a cold read, and loadMessages must wait for the chunks
// rather than draw an empty chat. Reproduced by seeding only the summary, then
// writing the chunks 180ms into the read's retry budget.
{
	const got = await p.evaluate(async () => {
		const DB = 'daimond-chats', CID = 'coldread-1';
		function idb() { return new Promise((res, rej) => {
			const r = indexedDB.open(DB);
			r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
		}); }
		function put(db, store, row) { return new Promise((res, rej) => {
			const t = db.transaction(store, 'readwrite');
			t.objectStore(store).put(row);
			t.oncomplete = res; t.onerror = () => rej(t.error);
		}); }
		const db = await idb();
		// The summary alone: says three messages, with no chunks and no legacy row.
		await put(db, 'chatsum', { id: CID, v: 1, msgCount: 3, name: 'CR' });
		const msgs = [0, 1, 2].map((i) => ({ role: i % 2 ? 'assistant' : 'user',
			mid: 'cr-m' + i, ts: i + 1, content: 'cold ' + i }));
		// The read starts against an empty chunk store; its retry budget is ~600ms.
		const readP = window.DaimondCore.chatStore().loadMessages(CID);
		// The chunks land mid-retry -- a settled cold read arriving late.
		setTimeout(() => { put(db, 'msgchunks',
			{ k: CID + '#000000000000-a', chatId: CID, seq: 0, msgs }).catch(() => {}); }, 180);
		const out = await readP;
		return out.messages.length;
	});
	check('a cold-empty read whose summary says msgCount>0 waits for the chunks', got === 3,
		'recovered ' + got + '/3 messages');
}

// The control: a chat with nothing on disk -- no summary, no chunks, no row -- is
// genuinely empty and returns AT ONCE, never spending the retry budget.
{
	const r = await p.evaluate(async () => {
		const t0 = performance.now();
		const out = await window.DaimondCore.chatStore().loadMessages('coldread-absent');
		return { n: out.messages.length, ms: performance.now() - t0 };
	});
	check('a genuinely empty chat returns empty without spinning the budget',
		r.n === 0 && r.ms < 400, r.n + ' msgs in ' + Math.round(r.ms) + 'ms');
}

// ── Fix 2: an empty resident save cannot blank a non-empty chat on disk ──────
// A cold read can leave a chat marked resident yet empty; the old resident branch
// blind-put that empty transcript over the legacy row and summary. Seed a full
// chat through the real write path, then save it AGAIN carrying an empty
// transcript, and prove the row, chunks and summary still hold the messages.
{
	const res = await p.evaluate(async () => {
		const CID = 'dataloss-1';
		const store = window.DaimondCore.chatStore();
		const full = [0, 1, 2].map((i) => ({ role: i % 2 ? 'assistant' : 'user',
			mid: 'dl-m' + i, ts: i + 1, content: 'keep ' + i }));
		const base = { id: CID, name: 'DL', model: 'mock/fast', provider: 'mock',
			status: 'active', holds: [], foldedInto: null, session: null,
			diamondId: '', workerModel: '', workerProvider: '',
			promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0 };
		// Seed the chat FULL and resident, through the ordinary save path.
		let list = store.stored().filter((c) => c.id !== CID)
			.concat([Object.assign({}, base, { messages: full, updatedAt: Date.now() })]);
		store.save(list);
		await store.settled();
		// Now save it again with an EMPTY transcript but still resident (the cold
		// state). A newer updatedAt makes the stamp differ so the write is not skipped.
		list = store.stored().map((c) => c.id === CID
			? Object.assign({}, c, { messages: [], updatedAt: Date.now() + 5000 }) : c);
		store.save(list);
		await store.settled();
		// Read back from disk, not from the mirror.
		function rawRow(id) { return new Promise((res) => {
			const r = indexedDB.open('daimond-chats');
			r.onsuccess = () => { const db = r.result;
				const g = db.transaction('chats', 'readonly').objectStore('chats').get(id);
				g.onsuccess = () => res(g.result || null); g.onerror = () => res(null); };
			r.onerror = () => res(null);
		}); }
		const row  = await rawRow(CID);
		const sum  = await store.summary(CID);
		const chks = await store.chunks(CID);
		const chunkMsgs = (chks || []).reduce((n, r) => n + ((r.msgs || []).length), 0);
		return { rowLen: row && row.messages ? row.messages.length : -1,
			sumCount: sum ? sum.msgCount : -1, chunkMsgs };
	});
	check('the empty resident save did not blank the legacy row', res.rowLen === 3, 'row has ' + res.rowLen);
	check('nor the summary count', res.sumCount === 3, 'summary msgCount ' + res.sumCount);
	check('nor the chunks', res.chunkMsgs === 3, 'chunks hold ' + res.chunkMsgs);
}

// ── Fix 5: a failed log fetch is not memoised, and an unreachable log says so ──
{
	const strings = await p.evaluate(() => ({
		unreachable: window.DaimondI18n.t('rel.log_unreachable'),
		notPublished: window.DaimondI18n.t('rel.not_published'),
	}));
	check('the log_unreachable string exists and is not its own key',
		strings.unreachable && strings.unreachable !== 'rel.log_unreachable', strings.unreachable);

	// A first fetch that FAILS must not stick: loaded stays false so the next open
	// retries. Point the log meta at a refused port, load, then at a good log.
	const memo = await p.evaluate(async () => {
		function setMeta(name, content) {
			let m = document.querySelector('meta[name="' + name + '"]');
			if (!m) { m = document.createElement('meta'); m.name = name; document.head.appendChild(m); }
			m.content = content;
		}
		const good = 'data:text/plain,' + encodeURIComponent(
			JSON.stringify({ seq: 0, ts: '2026-01-01T00:00:00.000Z', build: 'deadbeef0001',
				bundle: 'x'.repeat(64), prev: '0'.repeat(64), entry: 'e'.repeat(64) }));
		window.DaimondRelease.reset();
		setMeta('daimond-log', 'http://127.0.0.1:1/never');       // refused
		const s1 = await window.DaimondRelease.load();
		const afterFail = { loaded: s1.loaded, entries: s1.entries.length };
		setMeta('daimond-log', good);                             // now reachable
		const s2 = await window.DaimondRelease.load();            // no reset: must retry
		return { afterFail, afterGood: { loaded: s2.loaded, entries: s2.entries.length } };
	});
	check('a failed log fetch is NOT memoised as loaded', memo.afterFail.loaded === false,
		'loaded=' + memo.afterFail.loaded + ' entries=' + memo.afterFail.entries);
	check('so the next load retries and picks the log up', memo.afterGood.entries === 1,
		'entries=' + memo.afterGood.entries + ' loaded=' + memo.afterGood.loaded);

	// The status row: an UNREACHABLE log says so; a populated log missing THIS build
	// says "not published". The two must not be confused.
	const asideUnreachable = await p.evaluate(async () => {
		document.querySelector('meta[name="daimond-log"]').content = 'http://127.0.0.1:1/never';
		window.DaimondRelease.reset();
		await window.DaimondRelease.paintRow();
		const r = document.getElementById('astat-release');
		return r.querySelector('.astat-aside').textContent;
	});
	check('an unreachable log reads "log unreachable", not "not published"',
		asideUnreachable === strings.unreachable, asideUnreachable);

	const asideNotPub = await p.evaluate(async () => {
		// A populated log that does NOT carry the build this tab runs.
		document.querySelector('meta[name="daimond-log"]').content = 'data:text/plain,'
			+ encodeURIComponent(JSON.stringify({ seq: 0, ts: '2026-01-01T00:00:00.000Z',
				build: 'notthisbuild', bundle: 'x'.repeat(64), prev: '0'.repeat(64), entry: 'e'.repeat(64) }));
		window.DaimondRelease.reset();
		await window.DaimondRelease.paintRow();
		const r = document.getElementById('astat-release');
		return r.querySelector('.astat-aside').textContent;
	});
	check('a populated log missing this build reads "not published"',
		asideNotPub === strings.notPublished, asideNotPub);
}

// ── Fix 4: the updater leaves an UNLOCKED tab alone, but auto-updates a LOCKED one ──
// Driven through the real DaimondUpdater. A hidden tab is emulated so apply()'s
// quiet-time guard passes and only the lock state decides. build.json is faked to
// a new id so a pending build is discovered.
{
	// UNLOCKED: a pending build must NOT reload -- the tab stays put, pending stands,
	// and the banner is shown to offer Reload.
	const unlockedKept = await p.evaluate(async () => {
		window.__coldMark = 1;                                 // a reload would clear this
		try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); } catch (e) {}
		window.DaimondPWA = window.DaimondPWA || {};
		window.DaimondPWA.freshenWorker = () => Promise.resolve();
		window.DaimondPWA.clearShell    = () => Promise.resolve();
		window.DaimondIdentity.isUnlocked = () => true;
		const real = window.fetch;
		window.__realFetch = real;
		window.fetch = (u, o) => (String(u).indexOf('build.json') >= 0)
			? Promise.resolve(new Response(JSON.stringify({ build: 'coldtest-newbuild', note: 'n' }),
				{ status: 200, headers: { 'content-type': 'application/json' } }))
			: real(u, o);
		window.DaimondUpdater.check();                         // discovers the pending build
		await new Promise((r) => setTimeout(r, 1300));
		const banner = document.querySelector('.update-banner');
		return { mark: window.__coldMark, pending: window.DaimondUpdater.pending(),
			bannerShown: !!(banner && !banner.hidden) };
	});
	check('an unlocked tab with a pending build does NOT reload', unlockedKept.mark === 1,
		'marker ' + unlockedKept.mark);
	check('the pending update stands so the banner can offer Reload',
		unlockedKept.pending === 'coldtest-newbuild' && unlockedKept.bannerShown,
		'pending=' + unlockedKept.pending + ' banner=' + unlockedKept.bannerShown);

	// LOCKED: nothing to lose, so it auto-updates. The pending build is already
	// known; flipping the lock and re-checking must reload (which clears the marker).
	await p.evaluate(() => { window.DaimondIdentity.isUnlocked = () => false; window.DaimondUpdater.check(); });
	await p.waitForTimeout(4000);   // doReload's own safety timer fires at 3s
	const lockedReloaded = await p.evaluate(() => window.__coldMark).catch(() => undefined);
	check('a locked tab still auto-updates (reloaded)', lockedReloaded !== 1,
		'marker after = ' + JSON.stringify(lockedReloaded));
}

{
	const errs = errors(s).filter((e) => !/502|Bad Gateway|Failed to load resource|127\.0\.0\.1:1/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.join(' | ') || 'clean');
}

await s.close();
console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed');
if (bad.length) { bad.forEach((b) => console.log('  FAILED: ' + b)); process.exit(1); }
