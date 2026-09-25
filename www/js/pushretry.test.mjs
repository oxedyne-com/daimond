/* ============================================================
   Test — work a refused push left unsent goes without a further
   change (www/js/sync.js `owe`/`retryUnsent`, 2026-09-24).
   ------------------------------------------------------------
   The defect: a push the mailbox refused (409) pulls, merges and
   retries; when the pull cannot land, or the retries run out, the
   device jams "busy" -- "It goes on the next change" -- and nothing
   retries it. On a runner that has just finished a hand-off there
   is no next change: its answer sat in its store while the phone
   that sent the turn waited on a parcel that never came
   (`verify_handoff_slowparcel` CASE 1, 2026-09-24: 409 behind the
   phone's push, the content pull slow, eight tries in three
   seconds, then silence).

   The fix: a refused push that could not be reconciled is owed, and
   retried on a backoff (UNSENT_RETRY_MIN_MS doubling to
   UNSENT_RETRY_MAX_MS, no try limit) that PULLS FIRST and pushes
   only once the pull lands; a pull that lands on any other trigger
   sends it on the next push. A landed push pays it off.

   Drives the REAL www/js/sync.js in a simulated tab (the pattern of
   synckey.test.mjs) against a compare-and-set mailbox, with timers
   the test fires on a virtual clock, so nothing depends on load.

     A. The pull cannot land: the push is refused and owed, and while
        the pull still fails a retry sends no parcel.
     B. The pull lands: the owed parcel is committed with NO further
        change, and the retry stands down.
     C. Contention: every retry of one push is refused because the
        mailbox keeps moving; once it stops, the owed parcel lands.
     D. A pull on another trigger lands first: the owed parcel goes
        on the next push.

   A-D fail on the sync.js before the fix, where nothing retries:
     SYNC_JS=<d3283a04's sync.js> node www/js/pushretry.test.mjs
     node www/js/pushretry.test.mjs                    # ALL PASS

   S2 (R3 sync QA, 2026-09-24): a retry whose own pull fails climbs the
   wire's ladder to UNSENT_WIRE_MAX_MS, not the conflict's 8 s, and a
   device the browser knows is offline sends nothing until `online`.

     W. owed, then every content pull fails for an hour: about twenty
        GETs, not 450, and the gap grows to 300 s +-50%.
     O. owed and offline: no request at all, and `online` starts it.

   R, S (CASE 1, 2026-09-25): owed work whose read failed waits on a read.

     R. the runner's answer is refused and its pull fails for 15 s while it keeps
        pushing: no POST until a read lands, and it lands within the read cadence
        (4 s x1.5) of the release, not the wire's 9-17 s.
     S. a pull on another trigger lands between two retries: sent at once.

   S5, S6 (R3 sync QA, 2026-09-24): work is owed from the moment a push
   has news until one lands, so every exit that did not land is retried.
   Before, only a 409 whose pull failed, or eight 409s, owed it.

     Q6. one POST fails -- thrown, 502, 503, 500, 429 -- and the wire is
         healthy after: the chip says 'unsent', and one retry lands it.
     Q7. a 409 whose reconciling merge fails once or three times: it
         lands after the clean re-pull, and the retry does not pull
         again while the merge is failing.
     Q8. flush() through eight 502s: 'not_confirmed', then the ladder
         lands it once the outage ends.
     P.  the POST fails on the wire for an hour: about twenty POSTs and
         twenty GETs, the gap grows to 300 s, one success pays it.
     R.  a 429 or 503 with Retry-After: no POST before it.

   Q6, Q7 and Q8 fail with the mark, the `finally` arm and the jam-only
   chip reverted (steps 1-3 of the S5 brief).

   S3 (R3 sync QA, 2026-09-24): the re-pull of a version that will not
   merge gives up after REAPPLY_MAX_TRIES; owed work then went nowhere.

     M. owed, pulls land but will not merge for five minutes, then they
        do: the owed parcel lands on its own, the retry at its ceiling.

   Run:  node www/js/pushretry.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

const SELF = '00112233445566aa';
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drain = () => new Promise((r) => setImmediate(r));
const BASE = Date.UTC(2026, 8, 24, 12, 0, 0);

function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	const listeners = {};
	win.addEventListener = (type, f) => { (listeners[type] = listeners[type] || []).push(f); };
	win.dispatchEvent = () => true;
	const noEl = {
		addEventListener: () => {}, appendChild: () => {}, setAttribute: () => {},
		querySelector: () => null, querySelectorAll: () => [], remove: () => {},
		style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
		dataset: {},
	};
	const document = {
		readyState: 'complete', hidden: false, addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};

	const tab = {
		win,
		unlocked: false,			// false while sync.js loads, so start() reaches nothing
		parcel: { v: 3, chats: [], note: 'boot' },
		withhold: false,			// the content pull fails on the wire, as a slow parcel's did
		moveOnRead: 0,				// the mailbox moves under this many more pushes (another device)
		posts: [],					// every POST: { base, ok }
		gets: 0,
		getAt: [],					// the virtual time of every content GET
		postAt: [],					// and of every parcel POST, landed, refused or failed
		fire: (type) => (listeners[type] || []).forEach((f) => f({ type })),
		mailbox: { version: 4, blob: 'sealed:' + JSON.stringify({ v: 3, chats: [], note: 'phone v4' }) },
		// A virtual clock: every timer the page sets waits here until the test runs it.
		vnow: 0,
		timers: [],
	};

	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked,
		wrap: async (plain) => 'sealed:' + plain,
		unwrap: async (blob) => String(blob).slice('sealed:'.length),
		handle: () => '',
		deviceId: () => SELF,
	};
	const answer = (status, json) => ({ status, json: async () => json });
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: tab.unlocked }),
		gwFetch: async (path, opts) => {
			const q = new URL('http://x' + path).searchParams;
			if (q.has('above')) return new Promise(() => {});		// a wake park: never answers here
			if (q.has('presence') || q.has('lease') || q.has('progress')) return answer(200, { ok: true });
			if (!opts || opts.method === 'GET') {
				tab.gets++;
				tab.getAt.push(tab.vnow);
				if (tab.withhold) throw new TypeError('Failed to fetch');
				return answer(200, { present: true, version: tab.mailbox.version, blob: tab.mailbox.blob,
					device: 'Phone' });
			}
			tab.postAt.push(tab.vnow);
			const body = JSON.parse(opts.body);
			// Another device's push lands first, as the phone's did behind the runner's.
			if (tab.moveOnRead > 0) {
				tab.moveOnRead--;
				tab.mailbox = { version: tab.mailbox.version + 1,
					blob: 'sealed:' + JSON.stringify({ v: 3, chats: [], note: 'phone v' + (tab.mailbox.version + 1) }) };
			}
			if ((body.base_version | 0) !== tab.mailbox.version) {
				tab.posts.push({ base: body.base_version | 0, ok: false });
				return answer(409, { ok: false, version: tab.mailbox.version });
			}
			tab.posts.push({ base: body.base_version | 0, ok: true });
			tab.mailbox = { version: tab.mailbox.version + 1, blob: body.blob };
			return answer(200, { ok: true, version: tab.mailbox.version });
		},
	};
	win.DaimondCore = {
		collectSync: async () => JSON.parse(JSON.stringify(tab.parcel)),
		syncSelfDeviceId: () => SELF,
		busy: () => false,
		deviceSelfName: () => 'Chromium on Linux',
		syncMayCommitChunks: () => false,
		syncCommitBlockedReason: () => '',
		applySync: async () => ({}),
	};
	win.DaimondCloud = {
		sha256: async (s) => {
			const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
			return Array.from(new Uint8Array(d)).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
		},
	};

	// A virtual `Date` alongside the virtual timers (F-S5-5 / R): `holdUntil` is
	// compared against `Date.now()` inside sync.js, and a real Date barely moves
	// while `advance()` below fires timers on the virtual clock, so a Retry-After
	// wait that virtual time has cleared would still read as standing.
	class VDate extends Date {
		constructor(...a) { if (a.length) super(...a); else super(BASE + tab.vnow); }
		static now() { return BASE + tab.vnow; }
	}

	const body = readFileSync(process.env.SYNC_JS || join(HERE, 'sync.js'), 'utf8');
	const fn = new Function(
		'window', 'document', 'crypto', 'localStorage',
		'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'console', 'Date',
		'with (window) {\n' + body + '\n}');
	let nextId = 1;
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		(f, ms) => { const id = nextId++; tab.timers.push({ id, f, due: tab.vnow + (ms | 0) }); return id; },
		(id) => { tab.timers = tab.timers.filter((t) => t.id !== id); },
		() => 0, () => {},
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} }, VDate);
	return tab;
}

/// Let what the page has in flight settle: the seal and the digest are WebCrypto,
/// which answers off the event loop, so this waits on the real clock for the page to
/// go quiet (no POST or GET for a few turns in a row).
async function quiet(tab) {
	let last = -1, still = 0;
	for (let i = 0; i < 400 && still < 4; i++) {
		for (let j = 0; j < 10; j++) await drain();
		await realSleep(2);
		const now = tab.posts.length * 1000 + tab.gets;
		if (now === last) still++; else { still = 0; last = now; }
	}
}

/// Run the page's timers on the virtual clock for `ms`, earliest first, settling after
/// each one.
async function advance(tab, ms) {
	const end = tab.vnow + ms;
	for (;;) {
		await quiet(tab);
		const due = tab.timers.filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
		if (!due) break;
		tab.timers = tab.timers.filter((t) => t !== due);
		tab.vnow = Math.max(tab.vnow, due.due);
		due.f();
	}
	tab.vnow = end;
	await quiet(tab);
}

/// Pin the page's jitter, so a count over an hour is the ladder's and not the dice's.
/// 0.5 is the middle of every jittered wait (x1.0), 0 the shortest (x0.5).
function pinJitter(tab, r) {
	tab.win.Math = Object.create(Math, { random: { value: () => r } });
}

/// The gaps between successive times.
const gaps = (at) => at.slice(1).map((t, i) => t - at[i]);

const landed = (tab) => tab.posts.filter((p) => p.ok).length;
const holds = (tab, note) => {
	try { return JSON.parse(tab.mailbox.blob.slice('sealed:'.length)).note === note; } catch (e) { return false; }
};

/// A runner that has pushed once, and whose account the phone then moved on.
async function runnerBehindThePhone() {
	const tab = makeTab();
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	await S.pull();
	await quiet(tab);
	tab.parcel = { v: 3, chats: [], note: 'runner v5' };
	await S.push();
	await quiet(tab);
	// The phone pushes: the mailbox is at v6 and the runner still believes v5.
	tab.mailbox = { version: tab.mailbox.version + 1,
		blob: 'sealed:' + JSON.stringify({ v: 3, chats: [], note: 'phone v6' }) };
	return { tab, S };
}

console.log('\nA. the pull cannot land: the refused push is owed, and a retry sends no parcel\n');
const a = await runnerBehindThePhone();
{
	const { tab, S } = a;
	check('A0. the runner is set up: one push landed, then the phone moved the mailbox on',
		landed(tab) === 1 && tab.mailbox.version === 6, JSON.stringify({ posts: tab.posts, v: tab.mailbox.version }));
	// The turn's answer, and a content pull that fails on the wire.
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	tab.withhold = true;
	await S.push();
	await quiet(tab);
	check('A1. the push is refused and the reconcile cannot pull', tab.posts.length === 2 && !tab.posts[1].ok,
		JSON.stringify(tab.posts));
	check('A1. and the chip says the work has not been sent', S.state().stalled && S.state().stalledWhy === 'busy',
		JSON.stringify({ stalled: S.state().stalled, why: S.state().stalledWhy }));
	const g0 = tab.gets, p0 = tab.posts.length;
	await advance(tab, 20000);
	check('A2. it is retried without a further change: the mailbox is read again', tab.gets > g0,
		(tab.gets - g0) + ' GET(s) in 20 s');
	check('A3. and while the pull still fails, no parcel is sent', tab.posts.length === p0,
		(tab.posts.length - p0) + ' POST(s) in 20 s');
}

console.log('\nB. the pull lands: the owed parcel is committed with no further change\n');
{
	const { tab, S } = a;
	tab.withhold = false;
	// Longer than the widest step the ladder can have reached. A's twenty seconds of
	// failed pulls climb the WIRE's ladder (S2), whose fifth step is 16 s and sixth
	// 32 s, so the retry already armed is due within 32 s x 1.5 of A's end.
	await advance(tab, 60000);
	check('B1. THE RUNNER\'S ANSWER LANDS, with nothing changed since the refusal',
		landed(tab) === 2 && holds(tab, 'runner answer'),
		JSON.stringify({ posts: tab.posts, v: tab.mailbox.version }));
	check('B2. and the chip no longer says it is stuck', !S.state().stalled,
		JSON.stringify({ stalled: S.state().stalled, why: S.state().stalledWhy }));
	const g1 = tab.gets, p1 = tab.posts.length;
	await advance(tab, 60000);
	check('B3. the retry stands down once it has landed', tab.gets === g1 && tab.posts.length === p1,
		(tab.gets - g1) + ' GET(s), ' + (tab.posts.length - p1) + ' POST(s) in the next 60 s');
}

console.log('\nC. contention: every try of one push is refused, then the mailbox stops moving\n');
{
	const { tab, S } = await runnerBehindThePhone();
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	tab.moveOnRead = 1000;			// another device lands first on every try
	// Its jittered waits run on the virtual clock below; what it left is read the moment
	// it gives up, before the retry it armed comes round.
	let atEnd = null;
	const pushing = S.push().then(() => {
		atEnd = { why: S.state().stalledWhy, refused: tab.posts.filter((p) => !p.ok).length, landed: landed(tab) };
	});
	await advance(tab, 3000);		// the push's own eight tries
	await pushing;
	check('C1. the push used its tries and was refused each time',
		!!atEnd && atEnd.refused >= 8 && atEnd.landed === 1, JSON.stringify(atEnd));
	check('C1. and says so', !!atEnd && atEnd.why === 'busy', JSON.stringify(atEnd));
	tab.moveOnRead = 0;
	await advance(tab, 13000);
	check('C2. once the mailbox stops moving, the owed parcel lands with no further change',
		landed(tab) === 2 && holds(tab, 'runner answer'), JSON.stringify(tab.posts.slice(-3)));
}

console.log('\nD. a pull on another trigger lands first: the owed parcel goes on the next push\n');
{
	const { tab, S } = await runnerBehindThePhone();
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	tab.withhold = true;
	await S.push();
	await quiet(tab);
	tab.withhold = false;
	// A wake, a focus or an expedite pull, before the backoff comes round.
	await S.pull();
	await quiet(tab);
	await advance(tab, 3000);		// the push debounce, not the backoff
	check('D1. the landed pull sends the owed parcel', landed(tab) === 2 && holds(tab, 'runner answer'),
		JSON.stringify(tab.posts));
}

/// A runner whose push was refused and whose reconcile could not pull: owed.
async function owed() {
	const { tab, S } = await runnerBehindThePhone();
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	tab.withhold = true;
	await S.push();
	await quiet(tab);
	return { tab, S };
}

console.log('\nW. owed, then every content pull fails on the wire for an hour (S2)\n');
{
	const { tab, S } = await owed();
	pinJitter(tab, 0.5);
	const g0 = tab.gets;
	await advance(tab, 3600000);
	const at = tab.getAt.slice(g0);
	const gp = gaps(at);
	check('W1. an hour of failed pulls costs about twenty GETs, not one every 8 s', at.length <= 20,
		at.length + ' GETs in 60 min (450 at the old 8 s ceiling)');
	check('W2. the gap grows to the wire\'s ceiling, 300 s', gp.length > 0 && gp[gp.length - 1] === 300000,
		'last gaps ' + gp.slice(-3).map((g) => g / 1000 + 's').join(', '));
	check('W3. and no parcel is sent while the pull cannot land', tab.posts.length === 2,
		(tab.posts.length - 2) + ' POST(s)');
	pinJitter(tab, 0);
	const g1 = tab.gets;
	await advance(tab, 3600000);
	const gw = gaps(tab.getAt.slice(g1));
	check('W4. with every wait at its shortest the gap is still half the ceiling, 150 s',
		gw.length > 0 && Math.min(...gw) >= 150000, 'shortest ' + Math.min(...gw) / 1000 + 's');
	tab.withhold = false;
	await advance(tab, 450000);	// the ceiling x 1.5
	check('W5. once the pull lands, one round sends the owed parcel', landed(tab) === 2 && holds(tab, 'runner answer'),
		JSON.stringify(tab.posts.slice(-2)));
	// Paid off: the ladder is back at the bottom, so the next owed work goes in ~1 s.
	pinJitter(tab, 1);
	tab.mailbox = { version: tab.mailbox.version + 1,
		blob: 'sealed:' + JSON.stringify({ v: 3, chats: [], note: 'phone moved again' }) };
	tab.parcel = { v: 3, chats: [], note: 'runner second answer' };
	tab.withhold = true;
	await S.push();
	await quiet(tab);
	const g2 = tab.gets;
	await advance(tab, 1500);		// the first step, UNSENT_RETRY_MIN_MS x 1.5
	check('W6. and a landed push resets the ladder: the next owed work is retried within the first step',
		tab.gets === g2 + 1, (tab.gets - g2) + ' GET(s) in 1.5 s');
}

console.log('\nO. owed, and the browser knows it is offline\n');
{
	const { tab, S } = await owed();
	tab.win.navigator = { onLine: false };
	tab.withhold = false;				// the gateway is fine; this device cannot reach it
	const g0 = tab.gets, p0 = tab.posts.length;
	await advance(tab, 600000);
	check('O1. no request leaves a device with no link', tab.gets === g0 && tab.posts.length === p0,
		(tab.gets - g0) + ' GET(s), ' + (tab.posts.length - p0) + ' POST(s) in 10 min');
	check('O2. and no retry is left ticking', tab.timers.length === 0, tab.timers.length + ' timer(s)');
	tab.win.navigator = { onLine: true };
	tab.fire('online');
	await advance(tab, 1500);			// the ladder is reset: the first step
	check('O3. the link coming back sends the owed parcel at once', landed(tab) === 2 && holds(tab, 'runner answer'),
		JSON.stringify(tab.posts.slice(-2)));
}

/// A tab that has pulled once and holds the runner's answer, not yet pushed.
async function holdingTheAnswer() {
	const tab = makeTab();
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	await S.pull();
	await quiet(tab);
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	return { tab, S };
}

/// Answer the parcel POSTs with `fail` while `on()` holds; everything else goes to the mailbox.
function failPosts(tab, on, fail) {
	const orig = tab.win.DaimondGateway.gwFetch;
	tab.failedPosts = 0;
	tab.win.DaimondGateway.gwFetch = async (path, opts) => {
		const parcelPost = opts && opts.method === 'POST' && !/presence|lease|progress/.test(path);
		if (parcelPost && on()) {
			tab.failedPosts++;
			tab.postAt.push(tab.vnow);
			return fail();
		}
		return orig(path, opts);
	};
}

const failWith = (mode, retryAfter) => () => {
	if (mode === 'throw') throw new TypeError('network error');
	return { status: mode, headers: { get: (k) => (k === 'retry-after' && retryAfter) ? retryAfter : null },
		json: async () => ({ ok: false }) };
};

for (const mode of ['throw', 502, 503, 500, 429]) {
	console.log('\nQ6 ' + mode + '. the answer\'s one POST fails, then the wire is healthy, and nothing else happens\n');
	const { tab, S } = await holdingTheAnswer();
	pinJitter(tab, 1);				// every wait at its longest: one step is 1.5 s
	let once = true;
	failPosts(tab, () => { const f = once; once = false; return f; }, failWith(mode));
	await S.push();
	await quiet(tab);
	const st = S.state();
	check('Q6 ' + mode + '. the POST failed, and the chip says the work has not been sent',
		tab.failedPosts === 1 && st.stalled && st.stalledWhy === 'unsent',
		JSON.stringify({ failed: tab.failedPosts, stalled: st.stalled, why: st.stalledWhy }));
	const g0 = tab.gets, p0 = tab.posts.length;
	await advance(tab, 1500);		// one ladder step
	check('Q6 ' + mode + '. THE ANSWER LANDS within one step of the ladder, with no further change',
		holds(tab, 'runner answer'), JSON.stringify(tab.posts));
	check('Q6 ' + mode + '. with exactly one retry GET and one retry POST',
		tab.gets - g0 === 1 && tab.posts.length - p0 === 1,
		(tab.gets - g0) + ' GET(s), ' + (tab.posts.length - p0) + ' POST(s)');
	check('Q6 ' + mode + '. and the chip is clear again', !S.state().stalled, S.state().stalledWhy);
	await advance(tab, 600000);
	check('Q6 ' + mode + '. and nothing more is sent or fetched', tab.gets - g0 === 1 && tab.posts.length - p0 === 1,
		(tab.gets - g0) + ' GET(s), ' + (tab.posts.length - p0) + ' POST(s) in 10 min');
}

for (const fails of [1, 3]) {
	console.log('\nQ7 x' + fails + '. a 409, then the reconciling merge fails ' + fails + ' time(s) before it takes\n');
	const { tab, S } = await runnerBehindThePhone();
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	let left = fails;
	tab.win.DaimondGraph = { adopt: () => { if (left > 0) { left--; throw new Error('transient merge fault'); } } };
	const g0 = tab.gets;
	await S.push();
	await quiet(tab);
	check('Q7 x' + fails + '. the push is refused and the merge did not finish, and the chip says so',
		S.state().stalled && S.state().stalledWhy === 'merge', S.state().stalledWhy);
	await advance(tab, 600000);
	check('Q7 x' + fails + '. THE ANSWER LANDS once the merge takes, with no further change',
		holds(tab, 'runner answer') && left === 0, JSON.stringify(tab.posts.slice(-2)) + ' left=' + left);
	// One reconciling pull, one per failed re-pull, one clean one: fails + 1. The owed retry
	// may add one pull of its own, which finds the merge failing and leaves it to the re-pull.
	check('Q7 x' + fails + '. and the retry does not keep pulling while the merge fails',
		tab.gets - g0 <= fails + 2, (tab.gets - g0) + ' GET(s)');
	check('Q7 x' + fails + '. and the chip is clear', !S.state().stalled, S.state().stalledWhy);
}

for (const n of [3, 8]) {
	console.log('\nQ8 ' + n + 'x502. the runner\'s report path: flush() while the next ' + n + ' POSTs are 502s\n');
	const { tab, S } = await holdingTheAnswer();
	pinJitter(tab, 0.5);
	let left = n;
	failPosts(tab, () => left-- > 0, failWith(502));
	let res = null;
	S.flush().then((r) => { res = r; });
	await advance(tab, 3000);		// flush's six rounds, 300 ms apart
	if (n > 6) {
		check('Q8 ' + n + 'x502. flush gives up with the outage still running', !!res && res.ok === false
			&& res.why === 'not_confirmed', JSON.stringify(res));
	} else {
		check('Q8 ' + n + 'x502. flush lands it inside its own rounds', !!res && res.ok === true, JSON.stringify(res));
	}
	await advance(tab, 600000);
	check('Q8 ' + n + 'x502. THE ANSWER LANDS once the outage ends, with no further change',
		holds(tab, 'runner answer'), 'failed=' + tab.failedPosts + ' ' + JSON.stringify(tab.posts));
	check('Q8 ' + n + 'x502. and the chip is clear', !S.state().stalled, S.state().stalledWhy);
}

console.log('\nP. the POST fails on the wire for an hour, then the wire is healthy\n');
{
	const { tab, S } = await holdingTheAnswer();
	pinJitter(tab, 0.5);
	let broken = true;
	failPosts(tab, () => broken, failWith('throw'));
	await S.push();
	await quiet(tab);
	const g0 = tab.gets;
	await advance(tab, 3600000);
	const gp = gaps(tab.postAt);
	check('P1. an hour of failed uploads costs about twenty POSTs', tab.failedPosts <= 20,
		tab.failedPosts + ' POSTs in 60 min');
	check('P2. and about twenty GETs', tab.gets - g0 <= 20, (tab.gets - g0) + ' GETs in 60 min');
	check('P3. the gap grows to the wire\'s ceiling, 300 s', gp.length > 0 && gp[gp.length - 1] === 300000,
		'last gaps ' + gp.slice(-3).map((g) => g / 1000 + 's').join(', '));
	check('P4. and the work is still owed, and says so', S.state().stalledWhy === 'unsent', S.state().stalledWhy);
	broken = false;
	await advance(tab, 450000);		// the ceiling x 1.5
	check('P5. one round that gets through lands it', holds(tab, 'runner answer') && landed(tab) === 1,
		JSON.stringify(tab.posts));
	pinJitter(tab, 1);
	tab.parcel = { v: 3, chats: [], note: 'runner second answer' };
	let once = true;
	failPosts(tab, () => { const f = once; once = false; return f; }, failWith('throw'));
	await S.push();
	await quiet(tab);
	await advance(tab, 1500);
	check('P6. and the landing reset the ladder: the next failure is retried within the first step',
		holds(tab, 'runner second answer'), JSON.stringify(tab.posts.slice(-1)));
}

for (const [mode, ra] of [[429, '120'], [503, '120'], [503, 'date']]) {
	console.log('\nR ' + mode + ' ' + ra + '. the POST is answered ' + mode + ' with Retry-After: ' + ra + '\n');
	const { tab, S } = await holdingTheAnswer();
	pinJitter(tab, 0);				// the ladder at its shortest: 0.5 s on its own
	const header = ra === 'date' ? new Date(BASE + tab.vnow + 120000).toUTCString() : ra;
	let once = true;
	failPosts(tab, () => { const f = once; once = false; return f; }, failWith(mode, header));
	await S.push();
	await quiet(tab);
	const t0 = tab.vnow, g0 = tab.gets;
	await advance(tab, 119000);		// an HTTP date is whole seconds, so a hair under 120
	check('R ' + mode + ' ' + ra + '. nothing is sent or fetched before the gateway said to come back',
		tab.posts.length === 0 && tab.gets === g0 && tab.failedPosts === 1,
		tab.posts.length + ' POST(s), ' + (tab.gets - g0) + ' GET(s) in 119 s');
	await advance(tab, 61000);		// Retry-After x 1.5, its jitter's top
	check('R ' + mode + ' ' + ra + '. and then it lands', holds(tab, 'runner answer'),
		'at ' + ((tab.postAt[tab.postAt.length - 1] - t0) / 1000) + ' s');
}

console.log('\nM. owed, then the pulls land but will not merge until the re-pull has given up (S3)\n');
{
	const { tab, S } = await owed();
	tab.withhold = false;
	let broken = true;
	tab.win.DaimondGraph = { adopt: () => { if (broken) throw new Error('a section that will not merge yet'); } };
	await advance(tab, 300000);		// the re-pull's six tries take ~95 s (x1.5 at most)
	check('M1. the re-pull has given up and the work is still owed', !holds(tab, 'runner answer')
		&& S.state().stalled, JSON.stringify({ why: S.state().stalledWhy, posts: tab.posts.length }));
	broken = false;					// a new build, or a parcel from the other device that merges
	const g0 = tab.gets;
	await advance(tab, 450000);		// UNSENT_WIRE_MAX_MS x 1.5
	check('M2. THE OWED PARCEL LANDS with no further change, on the retry\'s own clock',
		holds(tab, 'runner answer'), (tab.gets - g0) + ' GET(s); ' + JSON.stringify(tab.posts.slice(-1)));
	check('M3. and the chip is clear', !S.state().stalled, S.state().stalledWhy);
}

console.log('\nR. CASE 1: owed on a read that fails for 15 s, while the runner keeps pushing\n');
{
	// The runner's answer, refused behind the phone's push, with the content pull failing:
	// verify_handoff_slowparcel CASE 1. Every wait at its longest (x1.5), the worst case.
	const { tab, S } = await owed();
	pinJitter(tab, 0.9999);
	const p0 = tab.posts.length, g0 = tab.gets;
	// The runner's flush and the store's own saves keep asking for pushes meanwhile.
	for (let i = 0; i < 6; i++) { await S.push(); await advance(tab, 300); }
	check('R1. no parcel is sent over a base a 409 proved stale: those pushes read instead',
		tab.posts.length === p0 && tab.gets > g0, (tab.posts.length - p0) + ' POST(s), ' + (tab.gets - g0) + ' GET(s)');
	await advance(tab, 15000 - 1800);
	const gRel = tab.gets, tRel = tab.vnow;
	tab.withhold = false;			// the pull is let through, 15 s in
	await advance(tab, 8000);
	const landedAt = landed(tab) === 2 ? tab.postAt[tab.postAt.length - 1] - tRel : -1;
	check('R2. the owed parcel lands within the read cadence of the release, not a wire backoff',
		holds(tab, 'runner answer') && landedAt >= 0 && landedAt <= 6000,
		'landed ' + (landedAt / 1000) + ' s after the release; ' + (tab.gets - g0) + ' GETs, '
		+ (tab.posts.length - p0) + ' POST(s) in all');
	check('R3. and it took one POST once the read landed', tab.posts.length - p0 === 1, JSON.stringify(tab.posts.slice(p0)));
}

console.log('\nS. owed on a failed read: a pull on another trigger sends it at once, not after the debounce\n');
{
	const { tab, S } = await owed();
	pinJitter(tab, 0.9999);
	await advance(tab, 20000);			// the read ladder is on a 6 s wait now
	tab.withhold = false;
	await S.pull();					// a wake or a focus pull, between two retries
	await advance(tab, 200);
	check('S1. the landed pull sent the owed parcel inside 200 ms', holds(tab, 'runner answer'),
		JSON.stringify(tab.posts.slice(-1)));
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
