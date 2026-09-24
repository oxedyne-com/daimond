/* ============================================================
   Test -- the owed-push retry does not pull while the push must wait
   (www/js/sync.js `retryUnsent`/`pushWaits`, hand-off QA F2,
   2026-09-24).
   ------------------------------------------------------------
   `c9ce5f3a`'s `retryUnsent` pulled before every push, forever,
   whatever stopped the push. When the push cannot land for a reason a
   pull does not change, each retry is a WHOLE-PARCEL GET (~1.4 MB
   typical, up to 8 MB) plus decrypt and parse:

     E. an owed push over this device's own live turn (DaimondCore.busy)
     F. an owed push whose pull lands but whose merge keeps failing (a
        section throws): the re-pull of that version is bounded at
        REAPPLY_MAX_TRIES; the retry was not
     G. an owed push over another device's live hand-off (deferPushFor)
     H. the device locks: the retry stops

   The fix: one `pushWaits()` shared by `push()` and `retryUnsent()`;
   a retry whose push must wait does not pull (the push's own re-arm
   and the turn's end send it), and a pull that lands but will not
   merge is left to the bounded re-pull. On `4823e327`: E ~77, F ~230,
   G ~75 GETs (the backoff is jittered). Here: 0, 7, 0, and the owed
   parcel lands once the wait ends (E2, G2).

   Drives the REAL sync.js on a virtual clock, on pushretry.test.mjs's
   harness.

   Run:  node www/js/retrycost.test.mjs
         WWW=<tree>/www/js node www/js/retrycost.test.mjs
         SYNC_JS=<file> node www/js/retrycost.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = process.env.WWW || dirname(fileURLToPath(import.meta.url));
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


/// A runner whose push was refused and could not reconcile: owed.
async function owed() {
	const { tab, S } = await runnerBehindThePhone();
	tab.parcel = { v: 3, chats: [], note: 'runner answer' };
	tab.withhold = true;
	await S.push();
	await quiet(tab);
	return { tab, S };
}

console.log('\nE. owed, then a live turn on this device for 10 minutes\n');
{
	const { tab, S } = await owed();
	tab.withhold = false;
	tab.win.DaimondCore.busy = () => true;
	const g0 = tab.gets;
	await advance(tab, 600000);
	const n = tab.gets - g0;
	check('E1. a push that must wait for the turn does not pull the parcel over and over', n <= 3,
		n + ' whole-parcel GETs in 10 min of one live turn (0 before c9ce5f3a)');
	tab.win.DaimondCore.busy = () => false;
	await advance(tab, 5000);
	check('E2. and the owed parcel lands once the turn is over', landed(tab) === 2 && holds(tab, 'runner answer'),
		JSON.stringify(tab.posts.slice(-2)));
}

console.log('\nF. owed, then a pull that lands but will not merge, for 30 minutes\n');
{
	const { tab, S } = await owed();
	tab.withhold = false;
	tab.win.DaimondGraph = { adopt: () => { throw new Error('a section this build cannot merge'); } };
	const g0 = tab.gets;
	await advance(tab, 1800000);
	const n = tab.gets - g0;
	check('F1. the re-pull of an unmergeable version stays bounded (REAPPLY_MAX_TRIES = 6)', n <= 8,
		n + ' whole-parcel GETs in 30 min');
}

console.log('\nG. owed, then another device runs a hand-off for 10 minutes\n');
{
	const { tab, S } = await owed();
	tab.withhold = false;
	tab.win.DaimondPeer = { deferPushFor: () => 'turn-on-another-device' };
	tab.win.DaimondLease = { snapshot: () => ({}) };
	const g0 = tab.gets;
	await advance(tab, 600000);
	const n = tab.gets - g0;
	check('G1. a push deferred for another device\'s turn does not pull the parcel over and over', n <= 3,
		n + ' whole-parcel GETs in 10 min');
	tab.win.DaimondPeer = { deferPushFor: () => '' };
	await advance(tab, 5000);
	check('G2. and the owed parcel lands once that turn is over', landed(tab) === 2 && holds(tab, 'runner answer'),
		JSON.stringify(tab.posts.slice(-2)));
}

console.log('\nH. owed, then the device locks\n');
{
	const { tab, S } = await owed();
	tab.unlocked = false;
	const g0 = tab.gets, p0 = tab.posts.length;
	await advance(tab, 600000);
	check('H1. nothing is sent or fetched while locked', tab.gets === g0 && tab.posts.length === p0,
		(tab.gets - g0) + ' GETs, ' + (tab.posts.length - p0) + ' POSTs');
	check('H2. and no retry timer is left armed', tab.timers.length === 0, tab.timers.length + ' timer(s)');
}

console.log('\n' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
