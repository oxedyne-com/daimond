/* ============================================================
   Test — the mailbox ack on a local durable commit (post.js).
   ------------------------------------------------------------
   The S1 this proves fixed: `ackThrough` used to gate the ack on
   `DaimondSync.push()` moving the parcel version. Once the parcel
   was over Steel's door (sync.js `tooLarge`) the version never
   moved, so the device never acked, the relay box filled to
   `max_rows`, and EVERY sender to the account was refused. Two
   growth axes locked each other.

   The fix, www-only: the ack is a watermark by REFERENCE (a seq).
   It commits the folded rows to THIS device's wrapped record,
   reads the record back to prove the fold is durably on disk, and
   acks on THAT -- never on the size of the unrelated account
   parcel. `save()` now answers false on a write throw (a quota
   over-run) instead of swallowing it, and the read-back is what
   makes "durable" mean written rather than intended.

   Drives the REAL post.js against the postspin gateway box and a
   DaimondSync stub whose push NEVER moves the version (the 413).
   A `--break unfixed` reverts the durable-commit gate to the old
   push-commit gate by a string replace, so the brick reproduces.

   Proven able to fail:
     node www/js/postack.test.mjs --break unfixed  # old gate restored
     node www/js/postack.test.mjs                  # clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
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
// `nopush`/`nolock`/`nosnapshot` revert the three WS-BRICK audit fixes below, each on
// its own tab (opt in per `makeTab` call) rather than globally -- see each test.
const KNOWN = ['unfixed', 'nopush', 'nolock', 'nosnapshot'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await drain(); }

/// A real (if minimal) EventTarget, in place of the no-op stub the original harness
/// used: post.js registers a `storage` listener at load time (the cross-tab `_st`
/// invalidation) and this is what lets a test actually fire one.
function makeEventBus() {
	const listeners = new Map();
	return {
		addEventListener(type, fn) {
			if (!listeners.has(type)) listeners.set(type, []);
			listeners.get(type).push(fn);
		},
		removeEventListener(type, fn) {
			const arr = listeners.get(type);
			if (!arr) return;
			const i = arr.indexOf(fn);
			if (i >= 0) arr.splice(i, 1);
		},
		dispatchEvent(evt) {
			(listeners.get(evt.type) || []).slice().forEach((fn) => { try { fn(evt); } catch (e) { /* one tab's listener throwing must not sink another's */ } });
			return true;
		},
	};
}

/// A gate for an async mock call the test wants to hold open and release on its own
/// terms rather than let resolve on whatever tick the engine happens to pick. `hold()`
/// returns the promise a held call is given; `release()` settles the OLDEST one still
/// waiting, FIFO, mirroring the order the calls actually came in.
function makeGate() {
	const waiting = [];
	return {
		hold(value) { return new Promise((resolve) => waiting.push(() => resolve(value))); },
		release() { const fn = waiting.shift(); if (fn) fn(); },
		get pending() { return waiting.length; },
	};
}

/// A single mailbox lock, shared by every tab that is passed the same instance --
/// mirroring `navigator.locks` being ORIGIN-wide, not per-window. Exclusive-only and
/// one name is all these tests need: a strict FIFO queue per name, `fn` invoked only
/// once it is that request's turn (never synchronously at `request()`-call time, just
/// as the real API defers to the browser granting the lock).
function makeSharedLocks() {
	const queues = new Map();
	return {
		request(name, opts, fn) {
			const prev = queues.get(name) || Promise.resolve();
			const run = () => Promise.resolve().then(fn);
			const next = prev.then(run, run);
			queues.set(name, next.catch(() => {}));
			return next;
		},
	};
}

/// The gateway box: rows `{seq, addr, envelope}`. `?since=X` returns rows above X;
/// `?op=ack` DROPS rows up to `through`, as the relay does on an ack -- so a box that
/// still holds its rows is a device that never acked.
function makeBox(rows) {
	const box = {
		rows,
		top: () => box.rows.reduce((m, r) => Math.max(m, r.seq | 0), 0),
		since: (x) => box.rows.filter((r) => (r.seq | 0) > (x | 0)),
		dropThrough: (t) => { box.rows = box.rows.filter((r) => (r.seq | 0) > (t | 0)); },
	};
	return box;
}

// A tab that loads the REAL post.js. `opts.sync` is the DaimondSync stub (absent -> no
// parcel, the solo path); `opts.peer` adds the errand HOLD routing; `ctl` exposes the
// failure injections the invariant checks need. `opts.local`/`opts.locks` let several
// tabs share one origin's storage and mailbox lock, as real tabs do; `opts.holdCollect`/
// `opts.slowWrap`/`opts.slowUnwrap` gate the named async call so a test can sequence a
// race deterministically instead of hoping the engine schedules it a particular way.
function makeTab(box, opts) {
	opts = opts || {};
	const local = opts.local || new Map();
	const stat = { collect: 0, ack: 0 };
	const ctl = { throwSetItemOnce: false, garbageUnwrapOnce: false };
	const collectGate = makeGate();
	const wrapGate = makeGate();
	const unwrapGate = makeGate();

	const gwFetch = (url, o) => {
		const q = String(url).split('?')[1] || '';
		const params = new URLSearchParams(q);
		if (params.get('op') === 'ack') {
			stat.ack++;
			const body = JSON.parse(o.body);
			box.dropThrough(body.through | 0);
			return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, dropped: 0 }) });
		}
		if (params.has('since')) {
			stat.collect++;
			const since = Number(params.get('since'));
			// Read lazily (`box.since` inside the resolved value, not before it): a held
			// gate must see the relay AS IT STANDS WHEN RELEASED, not as it stood when the
			// request was first issued.
			const answer = () => ({ status: 200,
				json: () => Promise.resolve({ ok: true, rows: box.since(since), more: false }) });
			return opts.holdCollect ? collectGate.hold(0).then(answer) : Promise.resolve(answer());
		}
		return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
	};

	const bus = makeEventBus();
	const document = {
		readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {},
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {},
			classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
	};
	const win = {
		addEventListener: bus.addEventListener, removeEventListener: bus.removeEventListener,
		dispatchEvent: bus.dispatchEvent,
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: opts.locks ? { onLine: true, locks: opts.locks } : { onLine: true },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => {
				if (ctl.throwSetItemOnce) { ctl.throwSetItemOnce = false; throw new Error('QuotaExceededError'); }
				local.set(k, String(v));
			},
			removeItem: (k) => local.delete(k),
		},
		// Unlocked, pass-through wrap. `unwrap` can be armed to return garbage once, to
		// drive the read-back refusal; either side can also be held open on a gate.
		DaimondIdentity: {
			isUnlocked: () => true, deviceId: () => 'dev-self',
			publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
			wrap: async (s) => (opts.slowWrap ? wrapGate.hold(s) : s),
			unwrap: async (s) => {
				if (ctl.garbageUnwrapOnce) { ctl.garbageUnwrapOnce = false; return '}{not json'; }
				return opts.slowUnwrap ? unwrapGate.hold(s) : s;
			},
		},
		DaimondGateway: { clientApi: () => 9, gwFetch },
		DEBUG_SHARE: { event: () => {} },
	};
	if (opts.sync) win.DaimondSync = opts.sync;
	if (opts.peer) {
		win.DaimondPeer = {
			peek: async (env) => (String(env).startsWith('ERRAND:') ? { own: true, env } : null),
			isOwnDispatch: (p) => !!(p && p.own),
			verifyEnvelope: async () => true,
			absorb: async () => null,
		};
	}
	win.window = win;

	let src = readFileSync(join(HERE, 'post.js'), 'utf8');
	if (opts.unfixed) {
		// The pre-fix gate: ack only after DaimondSync.push() MOVES the version. With a
		// push that never moves it (the 413), the device never acks -- the brick. Reverts
		// the durable-commit proof line to the old push-commit proof.
		const from = "if ((await storedThrough()) < want) return { acked: 0, why: 'not_saved' };";
		const to   = "{ var __b = DaimondSync.version(); await DaimondSync.push();"
			+ " if (DaimondSync.version() <= __b) return { acked: 0, why: 'not_committed' }; }";
		src = src.replace(from, to);
		if (src.indexOf(to) < 0) throw new Error('postack: could not find the durable-commit line to revert');
	}
	if (opts.nopush) {
		// Fix A reverted: a collect that folds rows schedules no push at all.
		const from = "\t\t// SCHEDULE a push, never gate the ack on one: an idle always-on receiver that\n"
			+ "\t\t// folds rows and acks them off the relay is now the only copy until this fires.\n"
			+ "\t\t// `nudge` only arms sync's own debounced timer -- it is a no-op with no parcel,\n"
			+ "\t\t// no entitlement or no sync module at all, so this is safe unconditionally.\n"
			+ "\t\tif (got || notes) {\n"
			+ "\t\t\ttry { if (window.DaimondSync && DaimondSync.nudge) DaimondSync.nudge(); }\n"
			+ "\t\t\tcatch (e) { /* no sync module, or it declined: the ack below still stands */ }\n"
			+ "\t\t}\n";
		if (src.indexOf(from) < 0) throw new Error('postack: could not find the nudge block to revert');
		src = src.replace(from, '');
	}
	if (opts.nolock) {
		// Fix B.2 reverted: the mailbox lock is a no-op, so two tabs' collect/fold/save/ack
		// sequences can interleave exactly as before the fix.
		const from = "\tfunction withMailboxLock(fn) {\n"
			+ "\t\tif (window.navigator && navigator.locks && navigator.locks.request) {\n"
			+ "\t\t\treturn navigator.locks.request('daimond-post-mailbox', { mode: 'exclusive' }, fn);\n"
			+ "\t\t}\n"
			+ "\t\treturn fn();\n"
			+ "\t}";
		const to = "\tfunction withMailboxLock(fn) {\n\t\treturn fn();\n\t}";
		if (src.indexOf(from) < 0) throw new Error('postack: could not find withMailboxLock to revert');
		src = src.replace(from, to);
	}
	if (opts.nosnapshot) {
		// Fix B.1 reverted: `_st` is read live INSIDE the queued `.then`, not snapshotted
		// at `save()`'s own entry.
		const from = "\tasync function save() {\n\t\tif (!_st) return false;\n"
			+ "\t\t// Captured HERE, not inside the queued `.then` below. This call can sit behind\n"
			+ "\t\t// an earlier write on `_writing` for a tick or more, and the `storage` handler\n"
			+ "\t\t// (below) nulls `_st` the moment ANOTHER tab writes -- so reading `_st` inside\n"
			+ "\t\t// the `.then` can find it already null and stringify that, wrapping the four\n"
			+ "\t\t// bytes \"null\". `read()` then unwraps \"null\" into a record that fails the\n"
			+ "\t\t// version check and answers `blank()`, discarding the store. The snapshot at\n"
			+ "\t\t// the door is what this device actually had when `save()` was called.\n"
			+ "\t\tvar snapshot = JSON.stringify(_st);\n"
			+ "\t\tvar mine = _writing = (_writing || Promise.resolve()).then(async function () {\n"
			+ "\t\t\ttry {\n"
			+ "\t\t\t\tlocalStorage.setItem(LS, await DaimondIdentity.wrap(snapshot));\n"
			+ "\t\t\t\treturn true;\n"
			+ "\t\t\t} catch (e) { log('store write failed', e); return false; }\n"
			+ "\t\t});";
		const to = "\tasync function save() {\n\t\tif (!_st) return false;\n"
			+ "\t\tvar mine = _writing = (_writing || Promise.resolve()).then(async function () {\n"
			+ "\t\t\ttry {\n"
			+ "\t\t\t\tlocalStorage.setItem(LS, await DaimondIdentity.wrap(JSON.stringify(_st)));\n"
			+ "\t\t\t\treturn true;\n"
			+ "\t\t\t} catch (e) { log('store write failed', e); return false; }\n"
			+ "\t\t});";
		if (src.indexOf(from) < 0) throw new Error('postack: could not find save() snapshot to revert');
		src = src.replace(from, to);
	}

	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
		'setInterval', 'clearInterval',
		'with (window) {\n' + src + '\n}');
	fn(win, document, setTimeout, clearTimeout, () => 0, () => {});

	return { win, stat, ctl, local, P: () => win.DaimondPost,
		releaseCollect: () => collectGate.release(),
		releaseWrap:    () => wrapGate.release(),
		releaseUnwrap:  () => unwrapGate.release() };
}

/// A DaimondSync whose push never moves the version -- the parcel over the door.
/// `nudgeCalls` counts Fix A's push-schedule so a test can assert it fired (or didn't).
function stubSync(over) {
	over = over || {};
	const s = {
		entitled: () => (over.entitled === undefined ? true : over.entitled),
		parcel:   async () => ({ post: { through: 999999 } }),
		version:  () => 7,
		push:     async () => {},
		nudgeCalls: 0,
	};
	s.nudge = function () { s.nudgeCalls++; };
	return s;
}

/// The plaintext record in storage (pass-through wrap), or null.
function stored(local) {
	const raw = local.get('daimond-post');
	if (!raw) return null;
	try { return JSON.parse(raw); } catch (e) { return null; }
}

const seedRows = () => ([
	{ seq: 1, kind: 'post', addr: 'a1', envelope: 'MSG:one' },
	{ seq: 2, kind: 'post', addr: 'a2', envelope: 'MSG:two' },
	{ seq: 3, kind: 'post', addr: 'a3', envelope: 'MSG:three' },
]);

async function main() {
	console.log('post ack — the durable-commit path acks; the push-gated path bricks\n');
	{
		const box = makeBox(seedRows());
		const top = box.top();
		const tab = makeTab(box, { sync: stubSync(), unfixed: BREAK === 'unfixed' });
		await settle();
		const P = tab.P();
		check('the module loaded', !!P && typeof P.round === 'function');

		const r = await P.round();
		check('collect and fold succeeded', r.ok === true, JSON.stringify(r));

		// These assert the FIX. Under `--break unfixed` the ack is gated on the push
		// moving the version -- which the stub never does -- so nothing acks and the rows
		// stay on the relay: these go RED, the brick reproduced (inverted exit -> pass).
		check('exactly one ack was sent', tab.stat.ack === 1, 'acks=' + tab.stat.ack);
		check('the ack watermark is the top of the box', r.acked === top, 'acked=' + r.acked);
		check('the relay was told to let go of all three rows', box.since(0).length === 0,
			'rows left=' + box.since(0).length);
		const rec = stored(tab.local);
		check('the stored record carries the watermark, durably on disk',
			!!rec && (rec.through | 0) === top, 'through=' + (rec && rec.through));
		check('and all three folded rows are durably in it',
			!!rec && Object.keys(rec.msgs).length === 3,
			rec ? Object.keys(rec.msgs).length + ' msgs' : 'no record');
		check('the report is not solo (the account has a parcel)', r.solo !== true);
	}

	// The invariant/held/solo checks exercise the fix's own guards. They run in both
	// modes; under --break the reverted gate makes several go red too, which only adds
	// to the failures the inverted exit is looking for.
	{
		console.log('\ninvariant: a write that did not complete does not ack\n');
		{
			const box = makeBox(seedRows());
			const tab = makeTab(box, { sync: stubSync() });
			await settle();
			const P = tab.P();
			const top = box.top();
			const c = await P.collect();				// folds, and saves once
			check('collect succeeded', c.ok === true);
			tab.stat.ack = 0;
			tab.ctl.throwSetItemOnce = true;			// the next save() throws (quota)
			const a1 = await P.ack();
			check('a save that threw answers not_saved', a1.why === 'not_saved', JSON.stringify(a1));
			check('and nothing was acked', tab.stat.ack === 0, 'acks=' + tab.stat.ack);
			const a2 = await P.ack();					// setItem restored
			check('the next ack, with the store writable again, acks', a2.acked === top && tab.stat.ack === 1,
				JSON.stringify(a2));
		}

		console.log('\ninvariant: a read-back that will not parse does not ack\n');
		{
			const box = makeBox(seedRows());
			const tab = makeTab(box, { sync: stubSync() });
			await settle();
			const P = tab.P();
			await P.collect();
			tab.stat.ack = 0;
			tab.ctl.garbageUnwrapOnce = true;			// storedThrough cannot prove the write
			const a = await P.ack();
			check('a read-back that will not parse answers not_saved', a.why === 'not_saved', JSON.stringify(a));
			check('and nothing was acked', tab.stat.ack === 0, 'acks=' + tab.stat.ack);
		}

		console.log('\na held errand pins the watermark below it, and the ack names the row before\n');
		{
			const box = makeBox([
				{ seq: 1, kind: 'post', addr: 'a1', envelope: 'MSG:one' },
				{ seq: 2, kind: 'post', addr: 'a2', envelope: 'MSG:two' },
				{ seq: 3, kind: 'post', addr: 'e3', envelope: 'ERRAND:three' },
			]);
			const tab = makeTab(box, { sync: stubSync(), peer: true });
			await settle();
			const P = tab.P();
			const r = await P.round();
			check('the round succeeded', r.ok === true, JSON.stringify(r));
			check('the watermark stopped below the held errand', r.acked === 2, 'acked=' + r.acked);
			check('the held errand is still on the relay for the peer', box.since(0).some((x) => x.seq === 3));
			const rec = stored(tab.local);
			check('the stored record acked through 2, not 3', !!rec && (rec.acked | 0) === 2,
				'acked=' + (rec && rec.acked));
		}

		console.log('\na non-entitled account acks solo (one copy, honestly reported)\n');
		{
			const box = makeBox(seedRows());
			const top = box.top();
			const tab = makeTab(box, { sync: stubSync({ entitled: false }) });
			await settle();
			const P = tab.P();
			await P.collect();
			const a = await P.ack();			// ack directly, so `solo` is visible (round() drops it)
			check('it still acks', tab.stat.ack === 1 && a.acked === top, JSON.stringify(a));
			check('and reports solo', a.solo === true, JSON.stringify(a));
		}
	}

	// ── The WS-BRICK audit's two findings ──────────────────────
	//
	// Fix A: `collect()` folding rows scheduled no push, so an idle always-on receiver
	// held the only copy indefinitely. Fix B: two tabs racing their own collect/save/ack
	// could lose a fold entirely -- disk, relay and memory all end up without it. Each
	// `--break` reverts exactly one of the three edits (see `makeTab`), so each new check
	// below can be shown to go red against the unfixed line before trusting it green.
	{
		console.log('\nFix A: a collect that folds rows schedules a push; an empty one does not\n');
		{
			// `kind: 'notice'` (not 'post') takes the safety-field branch straight to a
			// ROSTER note -- no envelope to open, no crypto needed -- so this exercises the
			// push-schedule on `notes` without a real sealed message.
			const box = makeBox([
				{ seq: 1, kind: 'notice', addr: 'n1', ts: 0 },
				{ seq: 2, kind: 'notice', addr: 'n2', ts: 0 },
				{ seq: 3, kind: 'notice', addr: 'n3', ts: 0 },
			]);
			const sync = stubSync();
			const tab = makeTab(box, { sync, nopush: BREAK === 'nopush' });
			await settle();
			const P = tab.P();
			const r = await P.collect();
			check('the collect folded the three notices', r.notes === 3, JSON.stringify(r));
			check('a push was scheduled after the fold (DaimondSync.nudge called)',
				sync.nudgeCalls === 1, 'nudgeCalls=' + sync.nudgeCalls);
			check('collect itself acks nothing -- the rows are still on the relay',
				box.since(0).length === 3, 'rows left=' + box.since(0).length);
		}
		{
			const box = makeBox([]);
			const sync = stubSync();
			const tab = makeTab(box, { sync });
			await settle();
			const P = tab.P();
			const r = await P.collect();
			check('an empty collect folded nothing', r.got === 0 && r.notes === 0, JSON.stringify(r));
			check('and scheduled no push -- nothing changed to send', sync.nudgeCalls === 0,
				'nudgeCalls=' + sync.nudgeCalls);
		}

		console.log('\nFix B.2: a second tab cannot clobber what the first just committed\n');
		{
			const box = makeBox(seedRows());
			const top = box.top();
			const local = new Map();
			const locks = makeSharedLocks();		// one lock, shared, exactly as navigator.locks is
			const nolock = BREAK === 'nolock';
			const A = makeTab(box, { sync: stubSync(), local, locks, nolock });
			const B = makeTab(box, { sync: stubSync(), local, locks, nolock, holdCollect: true });
			await settle();

			// Tab A's round enters the mailbox lock queue first; tab B's own collect is
			// queued right behind it, so -- locked -- B's `read()` cannot run (and cache a
			// pre-A record) until A's round has fully committed and acked. `holdCollect`
			// then holds B's OWN GET open so the test decides exactly when it resolves,
			// rather than the engine.
			const aPromise = A.P().round();
			const bPromise = B.P().collect();
			await settle();

			const aResult = await aPromise;
			check('tab A folded and acked all three rows', aResult.ok === true && aResult.acked === top,
				JSON.stringify(aResult));

			B.releaseCollect();			// B's GET resolves against the relay AS IT NOW STANDS
			const bResult = await bPromise;
			await settle();

			check('tab B\'s own collect ran to completion', bResult.ok === true, JSON.stringify(bResult));
			const rec = stored(local);
			check('tab A\'s three folded rows survive tab B\'s own save',
				!!rec && Object.keys(rec.msgs).length === 3,
				rec ? Object.keys(rec.msgs).length + ' msgs' : 'no record');
			check('the watermark is not rolled back by tab B', !!rec && (rec.through | 0) === top,
				'through=' + (rec && rec.through));
		}

		console.log('\nFix B.1: save() never wraps the literal string "null" when _st is nulled mid-flight\n');
		{
			const box = makeBox([]);
			const nosnapshot = BREAK === 'nosnapshot';
			const tab = makeTab(box, { sync: stubSync(), slowWrap: true, slowUnwrap: true, nosnapshot });
			await settle();
			const P = tab.P();

			// Bootstrap: one clean record on disk, its own gate released at once -- nothing
			// racing yet.
			const pBoot = P.collect();
			await settle();
			tab.releaseWrap();
			await pBoot;
			await settle();
			check('the bootstrap record landed on disk', !!stored(tab.local), 'no record');

			// The race: a first save is held open on `wrap` (so it stays the OLDEST thing on
			// `_writing`), and a second is queued straight behind it on that same chain --
			// sequenced by the gate, not by hoping the clock lands it a particular way.
			const p1 = P.collect();
			const p2 = P.collect();
			await settle();

			// A `storage` listener on THIS SAME window -- exactly what fires when ANOTHER
			// tab writes -- nulls `_st` right now. Its own self-heal read is held open on a
			// SEPARATE gate (`unwrap`), so it cannot repopulate `_st` before the two queued
			// saves above run.
			tab.win.dispatchEvent({ type: 'storage', key: 'daimond-post' });
			await settle();

			tab.releaseWrap();			// the first save's write proceeds and completes
			await settle();
			tab.releaseWrap();			// the second save -- the one under test -- proceeds
			await Promise.all([p1, p2]);
			await settle();

			const raw = tab.local.get('daimond-post');
			check('the store was never written as the literal string "null"', raw !== 'null', 'raw=' + raw);
			let parsed = null;
			try { parsed = JSON.parse(raw); } catch (e) { /* left as null */ }
			check('the write is a real record, not something read() will discard as blank()',
				!!parsed && typeof parsed === 'object' && parsed.v === 5, 'parsed=' + JSON.stringify(parsed));

			tab.releaseUnwrap();			// let the self-heal settle so nothing is left hanging
			await settle();
		}
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the brick failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

await main();
