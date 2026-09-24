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

function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.addEventListener = () => {};
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
				if (tab.withhold) throw new TypeError('Failed to fetch');
				return answer(200, { present: true, version: tab.mailbox.version, blob: tab.mailbox.blob,
					device: 'Phone' });
			}
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

	const body = readFileSync(process.env.SYNC_JS || join(HERE, 'sync.js'), 'utf8');
	const fn = new Function(
		'window', 'document', 'crypto', 'localStorage',
		'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'console',
		'with (window) {\n' + body + '\n}');
	let nextId = 1;
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		(f, ms) => { const id = nextId++; tab.timers.push({ id, f, due: tab.vnow + (ms | 0) }); return id; },
		(id) => { tab.timers = tab.timers.filter((t) => t.id !== id); },
		() => 0, () => {},
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
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
	await advance(tab, 13000);		// longer than the backoff's widest step (UNSENT_RETRY_MAX_MS x 1.5)
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

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
