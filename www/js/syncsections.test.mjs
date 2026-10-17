/* ============================================================
   Test — sections a parcel loses, and sections this build does not know
   (sync.js `KNOWN_SECTIONS`, `carried`, `lastPulledLacks`). Review fix 5,
   ALERT-PENDING, 16 Oct 2026.
   ------------------------------------------------------------
   An older build collects only the sections it knows, so its push drops a
   newer one (`alerts`) from the mailbox, and before this fix nothing put it
   back: the devices that knew it pulled, found nothing of their own changed,
   and skipped their push. Two rules, both for EVERY section:

     H. HEAL. A device that last sent a section and pulls a parcel without it
        sends again -- but only a section this build produces itself.
     C. CARRY. A pulled section this build does not know rides on, verbatim,
        in its pushes, and is never itself a reason to push (no echo).
     P. A KNOWN section deliberately left out of a round (`post`, whose
        refs keep chunks alive) is NEVER echoed back from a pulled parcel.

   Harness copied from synckey.test.mjs (the same simulated tab).
   Run:  node www/js/syncsections.test.mjs
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

const SELF = '00112233445566aa';		// this device's roster id (16 hex, as DEVICE_ID_RE wants)
const PEER = 'ffeeddccbbaa9988';

/// One roster line in the parcel's fixed field order, as `deviceEntry` builds it.
function line(o) {
	return { name: o.name || '', label: o.label || '', created: o.created || 0,
		namedAt: o.namedAt || 0, seen: o.seen || 0, build: o.build || '' };
}

/// A parcel of the shape collectSync returns, with only what this test reads.
function parcel(o) {
	return {
		v: 3,
		chats: o.chats || [],
		files: {},
		filesComplete: true,
		devices: {
			// Sorted by id, as `saveDevices` writes them.
			[SELF]: line({ name: 'Chromium on Linux', created: 1000, seen: o.selfSeen || 1000, build: 'abc' }),
			[PEER]: line({ name: 'Chromium on Linux', created: 900, seen: o.peerSeen || 900,
				build: o.peerBuild || 'abc' }),
		},
		ledger: [],
	};
}

// ── One simulated tab, the pattern peer.test.mjs established ──
function makeTab(seed) {
	// Seeded BEFORE sync.js loads, because `start()` reads the cursor and the
	// carried digest the moment it runs: a store filled afterwards is a reload that
	// remembers nothing, which is a different test from the one below.
	const store = new Map(seed || []);
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
		readyState: 'complete',
		hidden: false,
		addEventListener: () => {},
		querySelector: () => null,
		querySelectorAll: () => [],
		getElementById: () => null,
		createElement: () => Object.assign({}, noEl),
		body: noEl,
	};

	// ── The account, as sync.js finds it ──
	const tab = {
		win,
		store,
		unlocked: false,			// false while sync.js loads, so start() reaches nothing
		parcel: parcel({}),
		posts: [],					// every body a push actually sent
		gets: 0,
		mailbox: null,				// what the gateway holds: { version, blob }
	};

	win.DaimondIdentity = {
		isUnlocked: () => tab.unlocked,
		// What travels: the sealed parcel. Kept verbatim so the test can read back
		// WHICH bytes were sent, which is how it tells the mask from a rewrite.
		wrap: async (plain) => 'sealed:' + plain,
		unwrap: async (blob) => String(blob).slice('sealed:'.length),
		handle: () => '',
		deviceId: () => SELF,
	};
	// The REAL seal, for section C: AES-GCM under a throwaway key, base64 of
	// `IV(12) || ciphertext || tag(16)`, byte for byte what identity.js `seal`
	// does. The estimate is checked against this rather than against a restatement
	// of its own arithmetic.
	tab.sealReal = async (plain) => {
		const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 },
			false, ['encrypt']);
		const iv = webcrypto.getRandomValues(new Uint8Array(12));
		const ct = new Uint8Array(await webcrypto.subtle.encrypt(
			{ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
		const out = new Uint8Array(iv.length + ct.length);
		out.set(iv, 0);
		out.set(ct, iv.length);
		return Buffer.from(out).toString('base64');
	};
	win.DaimondGateway = {
		clientApi: () => 1,
		state: () => ({ authed: tab.unlocked }),
		gwFetch: async (path, opts) => {
			if (!opts || opts.method === 'GET') {
				tab.gets++;
				// THE MAILBOX HOLDS WHAT THIS TAB LAST SENT, at the version it landed
				// at. An empty-mailbox answer would be wrong here and not merely thin:
				// `present: false` zeroes the cursor (adoptVersion), and the skip in
				// push() is gated on `serverVersion > 0` -- so a fixture that answered
				// "empty" would have the NEXT round send for a reason that has nothing
				// to do with what is being measured.
				if (!tab.mailbox) return { status: 200, json: async () => ({ present: false, version: 0 }) };
				return { status: 200, json: async () => ({ present: true,
					version: tab.mailbox.version, blob: tab.mailbox.blob }) };
			}
			var body = JSON.parse(opts.body);
			tab.posts.push(body);
			tab.mailbox = { version: tab.posts.length, blob: body.blob };
			return { status: 200, json: async () => ({ ok: true, version: tab.posts.length }) };
		},
	};
	win.DaimondCore = {
		collectSync: async () => JSON.parse(JSON.stringify(tab.parcel)),
		syncSelfDeviceId: () => SELF,
		busy: () => false,
		deviceSelfName: () => 'Chromium on Linux',
		syncMayCommitChunks: () => false,
		syncCommitBlockedReason: () => 'tools are not up',
		// A pull of this device's own parcel back merges nothing, which is the
		// honest outcome: what arrived is what it sent.
		applySync: async () => ({}),
	};
	// sigOf() digests through cloud.js in the app; one function of it is all that
	// is wanted here, and it has to be the SAME digest for the carried fixed point
	// to mean anything.
	// THE LEASE VIEW AND THE PURE DECISION over it. `push()` consults these before it
	// sends, so a device that is no part of a live hand-off stands off the door rather
	// than 409-ing the runner's answer. Empty by default, so every other check here
	// sees the behaviour it always saw.
	tab.leases = {};
	win.DaimondLease = { snapshot: () => tab.leases };
	win.DaimondPeer  = {
		// The REAL function, read out of peer.js rather than restated: a stand-off the
		// test agreed with but the app did not would prove nothing.
		deferPushFor: (function () {
			const src = readFileSync(join(HERE, 'peer.js'), 'utf8');
			const m = /\n\tfunction deferPushFor\(leases, selfId, now, isOriginatorOf\) \{[\s\S]*?\n\t\}\n/.exec(src);
			if (!m) throw new Error('synckey.test: deferPushFor not found in peer.js -- has it been renamed?');
			// `liveLease` is the one sibling it calls; lifted the same way.
			const lv = /\n\tfunction liveLease\([\s\S]*?\n\t\}\n/.exec(src);
			if (!lv) throw new Error('synckey.test: liveLease not found in peer.js');
			const ms = /\n\tfunction leaseMs\([\s\S]*?\n\t\}\n/.exec(src);
			if (!ms) throw new Error('synckey.test: leaseMs not found in peer.js');
			return new Function('return (function(){' + ms[0] + lv[0] + m[0]
				+ 'return deferPushFor; })()')();
		})(),
	};
	win.DaimondCloud = {
		sha256: async (s) => {
			const d = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
			return Array.from(new Uint8Array(d)).map((b) => ('0' + b.toString(16)).slice(-2)).join('');
		},
	};

	const body = readFileSync(join(HERE, 'sync.js'), 'utf8');
	// `with (window)`, as peer.test.mjs explains: the app scripts read their
	// siblings as bare identifiers after a `window.X &&` guard, and `new Function`
	// gives them no global to find them on.
	//
	// setInterval is a NO-OP here and deliberately: start() arms the wake watcher
	// and the catch-up tick on it, and neither has anything to do with the push
	// skip -- letting them fire would have them reaching a gateway mid-assertion.
	const fn = new Function(
		'window', 'document', 'crypto', 'localStorage',
		'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'console',
		'with (window) {\n' + body + '\n}');
	fn(win, document, webcrypto, localStorage,
		TextEncoder, TextDecoder,
		setTimeout, clearTimeout, () => 0, () => {},
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return tab;
}

const unseal = (b) => JSON.parse(String(b).slice('sealed:'.length));
const seal = (o) => 'sealed:' + JSON.stringify(o);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/// Another writer's parcel lands in the mailbox at the next version.
function foreign(tab, o) {
	const v = (tab.mailbox ? tab.mailbox.version : 0) + 1;
	tab.posts.push({ foreign: true });		// keeps the fixture's version arithmetic in step
	tab.mailbox = { version: v, blob: seal(o) };
}
const own = (tab) => tab.posts.filter((p) => !p.foreign);

console.log('\nH. a section this device sent, missing from a pulled parcel, is sent again\n');
{
	const tab = makeTab();
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	tab.parcel = Object.assign(parcel({}), { alerts: { items: { 'd:k': { state: 'up' } }, floor: 0 } });
	await S.push();
	check('H0. the first push sends alerts', own(tab).length === 1 && !!unseal(own(tab)[0].blob).alerts);
	// An older build, which has never heard of `alerts`, pushes over it.
	const old = parcel({ chats: [{ id: 'c-old', messages: [] }] });
	foreign(tab, old);
	await S.pull();
	const lacks = S.lastPulledLacks ? S.lastPulledLacks() : null;
	check('H1. the pull says which of its own sections the parcel lacked', JSON.stringify(lacks) === '["alerts"]',
		JSON.stringify(lacks));
	await S.push();
	const last = own(tab)[own(tab).length - 1];
	check('H2. and the next round SENDS AGAIN, with the section back in the mailbox',
		own(tab).length === 2 && !!unseal(last.blob).alerts, own(tab).length + ' POST(s)');
	// Its own parcel back: nothing lacked, nothing owed.
	await S.pull();
	await S.push();
	check('H3. pulling its own healed parcel owes nothing more (no loop)', own(tab).length === 2,
		own(tab).length + ' POST(s); lacks ' + JSON.stringify(S.lastPulledLacks && S.lastPulledLacks()));
}

console.log('\nC/P. an unknown section rides on verbatim; a known one left out is not echoed\n');
{
	const tab = makeTab();
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	tab.parcel = parcel({});			// this round collects no `post` (identity locked, say)
	await S.push();
	const newer = Object.assign(parcel({}), {
		zeta: { from: 'a newer build', n: 1 },
		post: { refs: ['@m/abc'], stale: true },
	});
	foreign(tab, newer);
	await S.pull();
	check('P1. a known section this device did not send is not "lacked" either',
		JSON.stringify(S.lastPulledLacks ? S.lastPulledLacks() : null) === '[]');
	// A change of this device's own.
	tab.parcel = parcel({ chats: [{ id: 'c1', messages: [] }] });
	await S.push();
	const sent = unseal(own(tab)[own(tab).length - 1].blob);
	check('C1. the unknown section rides on, verbatim', JSON.stringify(sent.zeta) === JSON.stringify(newer.zeta),
		JSON.stringify(sent.zeta));
	check('P2. the KNOWN section deliberately left out (post) is NOT echoed back', !('post' in sent),
		JSON.stringify(sent.post));
	// The newer build moves its section; nothing of ours changes.
	const n = own(tab).length;
	foreign(tab, Object.assign(parcel({ chats: [{ id: 'c1', messages: [] }] }), { zeta: { from: 'a newer build', n: 2 } }));
	await S.pull();
	await S.push();
	check('C2. a carried section moving is not a reason to push (no echo)', own(tab).length === n,
		(own(tab).length - n) + ' extra POST(s)');
	// But the next real change carries the NEW value.
	tab.parcel = parcel({ chats: [{ id: 'c2', messages: [] }] });
	await S.push();
	const s2 = unseal(own(tab)[own(tab).length - 1].blob);
	check('C3. and the next real change carries its latest value', s2.zeta && s2.zeta.n === 2, JSON.stringify(s2.zeta));
	// A section this build produces itself is never treated as carried, even if a pull had it first.
	tab.parcel = Object.assign(parcel({ chats: [{ id: 'c2', messages: [] }] }), { alerts: { items: {}, floor: 1 } });
	foreign(tab, Object.assign(parcel({ chats: [{ id: 'c2', messages: [] }] }), { alerts: { items: {}, floor: 9 } }));
	await S.pull();
	await S.push();
	const s3 = unseal(own(tab)[own(tab).length - 1].blob);
	check('C4. a known section is always this device\'s own value, never the pulled one', s3.alerts && s3.alerts.floor === 1,
		JSON.stringify(s3.alerts));
}

console.log('\nR. (QA r569qa1) after a reload, an unknown section still rides on in the first push\n');
{
	const tab = makeTab();
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	tab.parcel = parcel({});
	await S.push();
	const newer = Object.assign(parcel({}), { zeta: { from: 'a newer build', n: 1 } });
	foreign(tab, newer);
	await S.pull();
	// The page reloads: the same storage, the same mailbox, nothing pulled yet this life
	// (the boot pull's GET failed on a flaky network, or is still in flight).
	const re = makeTab(new Map(tab.store));
	re.mailbox = tab.mailbox;
	re.posts = tab.posts.slice();
	re.unlocked = true;
	re.parcel = parcel({ chats: [{ id: 'c-after-reload', messages: [] }] });	// a change of its own
	await re.win.DaimondSync.push();
	const sentR = own(re).length > own(tab).length ? unseal(own(re)[own(re).length - 1].blob) : null;
	check('R1. the reloaded page pushed its change', !!sentR, own(re).length + ' POST(s)');
	check('R2. and the newer build\'s section is still in the mailbox', !!sentR && !!sentR.zeta,
		sentR ? JSON.stringify(Object.keys(sentR)) : '');
}

await wait(10);
console.log('\n' + (failures ? failures + ' FAILED' : 'all passed') + '\n');
process.exit(failures ? 1 : 0);
