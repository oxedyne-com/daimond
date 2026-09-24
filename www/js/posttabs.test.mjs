/* ============================================================
   Test -- a mailbox-locked section saves the record it folded into
   (www/js/post.js `withMailboxLock`, `save`, the `storage` handler;
   SIM-1, 2026-09-25).
   ------------------------------------------------------------
   The mailbox lock serialises collects across the tabs of a device,
   but the previous holder's write reaches this tab as a `storage`
   event a task later -- mid-collect, if this tab took the lock at
   once. The handler replaced the cached record with a fresh read,
   `collect` went on folding into the record it had read at its
   start, and `save()` wrote the cached one: the fold was lost, the
   next pass folded the same rows again, and their side effects ran
   twice (the simulator's relay r0: a consent grant posted twice).

     T1  a sibling tab's `storage` event arriving mid-collect: every
         row is folded once over two passes (release 4: twice), and the
         record on disk holds the fold (`seen`);
     T2  a sibling tab that wrote before this tab took the lock, whose
         event has not arrived: the section reads the disk at its door,
         so the sibling's write is kept, not overwritten.

   The REAL post.js on a clock the test owns (ackspin.test.mjs's
   harness), with one localStorage the "sibling" writes into.

     node www/js/posttabs.test.mjs
     POST_JS=<release/r4>/www/js/post.js node www/js/posttabs.test.mjs   # T1, T2 fail
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE    = dirname(fileURLToPath(import.meta.url));
const POST_JS = process.env.POST_JS || join(HERE, 'post.js');
const LS      = 'daimond-post';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 20) { for (let i = 0; i < n; i++) await drain(); }

/// One tab of a device: the real post.js over a box of `rows`, one localStorage, and a
/// hook run while the collect's read is in flight (`onCollect`).
function makeTab(rows, onCollect) {
	const local = new Map();
	const listeners = {};
	const folds = {};
	let collects = 0;
	const answer = (s, j) => Promise.resolve({ status: s, headers: { get: () => '' }, json: () => Promise.resolve(j) });
	const gwFetch = async (url, o) => {
		const p = new URLSearchParams(String(url).split('?')[1] || '');
		if (p.has('since')) {
			collects++;
			if (onCollect) await onCollect(collects);
			const since = Number(p.get('since'));
			return answer(200, { ok: true, seq: rows.length, rows: rows.filter((r) => r.seq > since), more: false });
		}
		if (p.get('op') === 'ack') return answer(200, { ok: true, dropped: 0 });
		return answer(200, { ok: true });
	};
	const document = { readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {}, setAttribute() {},
			appendChild(c) { return c; }, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
	const win = {
		addEventListener(type, f) { (listeners[type] = listeners[type] || []).push(f); },
		dispatchEvent: () => true, Date: { now: () => 1757000000000 },
		location: { origin: 'https://example.test', href: 'https://example.test/' }, navigator: { onLine: true },
		localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)),
			removeItem: (k) => local.delete(k) },
		DaimondIdentity: { isUnlocked: () => true, deviceId: () => 'dev-self', publicKeyB64url: () => 'pub-self',
			sealingKeyRaw: () => null, wrap: async (s) => s, unwrap: async (s) => s },
		DaimondGateway: { clientApi: () => 9, gwFetch },
		// Every row is a peer envelope this stub will not open; the fold is counted here.
		DaimondPeer: { peek: async (x) => {
			const k = typeof x === 'string' ? x : String((x && (x.addr || x.envelope)) || '?');
			folds[k] = (folds[k] | 0) + 1;
			return null;
		} },
	};
	win.window = win;
	const fn = new Function('window', 'document', 'with (window) {\n' + readFileSync(POST_JS, 'utf8') + '\n}');
	fn(win, document);
	return {
		win, local, folds, P: () => win.DaimondPost,
		/// A sibling tab of this device wrote the record: storage now holds `raw`, and the
		/// `storage` event is delivered here.
		siblingWrote(raw) {
			if (raw !== undefined) local.set(LS, raw);
			(listeners.storage || []).forEach((f) => f({ key: LS }));
		},
		disk: () => { try { return JSON.parse(local.get(LS) || 'null'); } catch (e) { return null; } },
	};
}
const rows3 = () => [1, 2, 3].map((s) => ({ seq: s, kind: 'post', addr: 'a' + s, envelope: 'e' + s, ts: 1757000000 }));

// ── T1 ─────────────────────────────────────────────────────────
{
	console.log('\nT1: a sibling tab\'s storage event arrives in the middle of a collect\n');
	let tab = null;
	tab = makeTab(rows3(), async (n) => {
		// The previous lock holder's write, heard a task later: the same record, re-saved.
		if (n === 1) tab.siblingWrote(tab.local.get(LS));
	});
	await tab.P().read();
	await tab.P().collect(); await settle();
	const d1 = tab.disk();
	await tab.P().collect(); await settle();
	const twice = Object.keys(tab.folds).filter((a) => tab.folds[a] > 1);
	check('T1. every row is folded once over two passes (release 4: each twice)', twice.length === 0
		&& Object.keys(tab.folds).length === 3, JSON.stringify(tab.folds));
	check('T1. and the record on disk holds the first pass\'s fold', !!d1 && d1.seen === 3,
		'seen on disk ' + (d1 && d1.seen));
}

// ── T2 ─────────────────────────────────────────────────────────
{
	console.log('\nT2: a sibling tab wrote before this tab took the lock, and its event has not arrived\n');
	const tab = makeTab(rows3().slice(0, 2), null);
	const st = await tab.P().read();						// this tab's cached copy, seen 0
	// The sibling folded rows 1 and 2 and marked a message read, and let the lock go;
	// its storage event is still in flight when this tab collects.
	const theirs = JSON.parse(JSON.stringify(st));
	theirs.seen = 2; theirs.through = 2; theirs.acked = 2;
	theirs.msgs = { m1: { addr: 'm1', dir: 'in', from: 'x', body: 'hi', ts: 1, read: 1, tray: 0 } };
	tab.local.set(LS, JSON.stringify(theirs));
	await tab.P().collect(); await settle();
	const d = tab.disk();
	check('T2. the sibling\'s write is kept, not overwritten from the stale cache (release 4: lost)',
		!!d && !!d.msgs && !!d.msgs.m1 && d.seen === 2, JSON.stringify({ seen: d && d.seen, msgs: d && Object.keys(d.msgs || {}) }));
	check('T2. and the rows it folded are not folded again here', Object.keys(tab.folds).length === 0,
		JSON.stringify(tab.folds));
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
