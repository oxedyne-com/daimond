/* ============================================================
   Test — the push-skip's comparison key (sync.js `compareKey`).
   ------------------------------------------------------------
   Drives the REAL www/js/sync.js in a simulated tab (a Map-backed
   localStorage, a no-op document, and a counting stand-in for
   DaimondGateway.gwFetch) to prove the one thing that had two idle
   desktops each putting ~8 MB on the wire every 300 seconds:

     A. THE KEY. The parcel's own-device `seen` stamp is masked out
        of the comparison and nothing else is. A PEER's stamp still
        counts as news, a real change still counts as news, and the
        parcel itself is left untouched -- what is sent still carries
        the true stamp.

     B. THE SKIP. An idle device whose ONLY change is that stamp
        sends no POST at all (it takes the throttled idle pull
        instead), and the very next real change still sends.

     C. THE WIRE ESTIMATE, against a REAL AES-GCM encrypt and a real
        base64 of the result -- exactly, not approximately -- and the
        UTF-8 scan it rests on, against TextEncoder, over ASCII,
        two- and three-byte characters, an astral pair and a lone
        surrogate.

     D. THE LOCAL REFUSAL. A parcel over Steel's 8 MiB front door is
        refused HERE: no POST, the too-large state on the chip, the
        section sizes and the two figures on the feed event -- and
        NOTHING dropped from the parcel to get it under the door.

   `touchSelfDevice` (daimond.js) moves that stamp every
   SEEN_REFRESH_MS = 5 min whether or not anything else moved, so on a
   device nobody is typing at it was the only thing that ever did: the
   skip never took, every push woke the other devices, and each of
   those pulled and re-collected.

   Run:  node www/js/synckey.test.mjs
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
			[PEER]: line({ name: 'Chromium on Linux', created: 900, seen: o.peerSeen || 900, build: 'abc' }),
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

console.log('\nA. the comparison key — what counts as news and what does not\n');

{
	const tab = makeTab();
	const key = tab.win.DaimondSync.forTest.compareKey;
	check('sync.js exposes the key it compares on, so this can be measured at all',
		typeof key === 'function');

	const base = key(parcel({ selfSeen: 1000 }));
	const moved = key(parcel({ selfSeen: 1000 + 5 * 60 * 1000 }));
	check('A1. this device\'s own `seen` moving leaves the key UNCHANGED — the idle-churn fix',
		base === moved);

	const peerMoved = key(parcel({ selfSeen: 1000, peerSeen: 900 + 60000 }));
	check('A2. a PEER\'s `seen` moving DOES change it — the mask is this device\'s line alone',
		base !== peerMoved);

	const changed = key(parcel({ selfSeen: 1000, chats: [{ id: 'c1', messages: [] }] }));
	check('A3. a real change still changes it — the skip cannot swallow work',
		base !== changed);

	const alsoChanged = key(parcel({ selfSeen: 1000 + 5 * 60 * 1000, chats: [{ id: 'c1', messages: [] }] }));
	check('A3. and a real change carried ALONGSIDE a moved stamp still changes it',
		base !== alsoChanged && changed === alsoChanged);

	const masked = JSON.parse(base);
	check('A4. the key keeps every other field of the line verbatim — only `seen` is touched',
		masked.devices[SELF].name === 'Chromium on Linux' && masked.devices[SELF].build === 'abc'
		&& masked.devices[SELF].created === 1000 && masked.devices[PEER].seen === 900,
		'seen=' + masked.devices[SELF].seen);
	check('A4. and the key order is the parcel\'s, so two collects give the same bytes',
		Object.keys(masked).join(',') === 'v,chats,files,filesComplete,devices,ledger'
		&& Object.keys(masked.devices).join(',') === SELF + ',' + PEER);

	const noCore = key({ v: 3, chats: [] });
	check('A5. a parcel with no roster in it is its own key — nothing to mask, nothing thrown',
		noCore === JSON.stringify({ v: 3, chats: [] }));
}

console.log('\nB. the push — an idle device with only a seen-refresh sends nothing\n');

{
	const tab = makeTab();
	tab.unlocked = true;
	const S = tab.win.DaimondSync;

	tab.parcel = parcel({ selfSeen: 1000 });
	await S.push();
	check('B1. the first push sends', tab.posts.length === 1, tab.posts.length + ' POST(s)');
	const sent = tab.posts[0];
	check('B1. and what it SENT carries the true stamp — the mask is a comparison, not a rewrite',
		JSON.parse(sent.blob.slice('sealed:'.length)).devices[SELF].seen === 1000);

	// Five minutes on, with nothing else whatever having happened: exactly what
	// touchSelfDevice does to an idle device on every collect past SEEN_REFRESH_MS.
	const before = tab.gets;
	tab.parcel = parcel({ selfSeen: 1000 + 5 * 60 * 1000 });
	await S.push();
	check('B2. A SEEN-REFRESH ALONE SENDS NOTHING — the whole of the idle-churn fix',
		tab.posts.length === 1, tab.posts.length + ' POST(s)');
	check('B2. and the round is not wasted: it takes the throttled idle pull instead',
		tab.gets > before, (tab.gets - before) + ' GET(s)');

	// And again, further on, to prove it is not a one-round coincidence.
	tab.parcel = parcel({ selfSeen: 1000 + 20 * 60 * 1000 });
	await S.push();
	check('B2. nor on the round after that, however far the stamp has moved',
		tab.posts.length === 1, tab.posts.length + ' POST(s)');

	// A real change, with the stamp where the skipped rounds left it.
	tab.parcel = parcel({ selfSeen: 1000 + 20 * 60 * 1000, chats: [{ id: 'c1', messages: [] }] });
	await S.push();
	check('B3. the next REAL change sends, and sends the stamp with it',
		tab.posts.length === 2
		&& JSON.parse(tab.posts[1].blob.slice('sealed:'.length)).devices[SELF].seen === 1000 + 20 * 60 * 1000,
		tab.posts.length + ' POST(s)');

	// The skip must hold across a reload too: that is what the carried digest
	// (K_SIG / bootSig) is for, and it is now taken over the KEY.
	const tab2 = makeTab(tab.store);		// the same browser, a fresh page
	tab2.unlocked = true;
	tab2.mailbox = { version: 2, blob: tab.mailbox.blob };
	tab2.parcel = parcel({ selfSeen: 1000 + 25 * 60 * 1000, chats: [{ id: 'c1', messages: [] }] });
	await tab2.win.DaimondSync.push();
	check('B4. a FRESH PAGE with only a moved stamp sends nothing either — the carried digest is of the key',
		tab2.posts.length === 0, tab2.posts.length + ' POST(s)');
}

console.log('\nC. the wire estimate, against a real encrypt and a real base64\n');

{
	const tab = makeTab();
	const { utf8Len, wireBytes, parcelSizes, door } = tab.win.DaimondSync.forTest;

	check('C0. the door is Steel\'s 8 MiB, in bytes of HTTP body', door === 8 * 1024 * 1024, String(door));

	// The scan, against the encoder it stands in for.
	const samples = [
		['ASCII', 'the quick brown fox'],
		['two-byte (Latin-1 supplement)', 'café, naïve, Ærø'],
		['three-byte (CJK)', '日本語の転写がここにある'],
		['an astral pair', 'a\u{1F600}b'],
		['a LONE high surrogate', 'a\uD83Db'],
		['a LONE low surrogate', 'a\uDE00b'],
		['JSON of a parcel', JSON.stringify(parcel({ chats: [{ id: 'c1', messages: ['日本語', 'ok'] }] }))],
	];
	let scanOk = true, scanWhy = '';
	for (const [what, str] of samples) {
		const real = new TextEncoder().encode(str).length;
		if (utf8Len(str) !== real) { scanOk = false; scanWhy += ' ' + what + ':' + utf8Len(str) + '!=' + real; }
	}
	check('C1. utf8Len matches TextEncoder on every shape a transcript can hold',
		scanOk, scanWhy.trim() || samples.length + ' samples');

	// The estimate, against the real thing. Several sizes, because the base64
	// padding and the 4-per-3 rounding only bite at particular lengths.
	// The envelope as `push` really writes it: this tab's own wake id and the
	// device label its stubbed core answers with. Inventing either would measure
	// the test's arithmetic instead of the engine's.
	const wakeId = tab.win.DaimondSync.wake().id;
	const bodyOf = (b64) => new TextEncoder().encode(JSON.stringify(
		{ base_version: 0, device: 'Chromium on Linux', blob: b64, w: wakeId })).length;
	let exact = true, drift = '';
	for (const n of [0, 1, 2, 3, 4, 5, 1000, 65536]) {
		const plain = 'x'.repeat(n);
		const b64 = await tab.sealReal(plain);
		const est = wireBytes(utf8Len(plain));
		// The envelope the estimate assumed is the one `push` sends; this test's
		// stubbed deviceLabel and WAKE_ID are what it read, so the two agree when
		// the BLOB length does.
		const realBody = bodyOf(b64);
		if (est !== realBody) { exact = false; drift += ' n=' + n + ':' + est + '!=' + realBody; }
	}
	check('C2. the estimate is EXACT against a real seal and base64, not close',
		exact, drift.trim() || '8 lengths, padding boundaries included');

	// Multi-byte content is where a String.length budget and the wire part company,
	// and it is the whole reason this estimate exists rather than `plain.length`.
	const jp = '日'.repeat(10000);
	check('C3. and it counts multi-byte content as the wire does, not as String.length does',
		wireBytes(utf8Len(jp)) > 4 * Math.ceil(jp.length / 3),
		'30,000 UTF-8 bytes from 10,000 UTF-16 units');

	// The census.
	const p = parcel({ chats: [{ id: 'c1', messages: ['hello', 'there'] },
		{ id: 'c2', messages: null, messagesRef: { v: 1, size: 99, key: 'k', chunks: ['aa'] } }] });
	p.ledger = [{ t: 1, c: 2 }];
	p.models = { openai: { models: [] } };
	const plain = JSON.stringify(p);
	const sz = parcelSizes(p, utf8Len(plain));
	check('D0. the census names each section it knows, and leaves out the ones weighing nothing',
		sz.c > 0 && sz.l > 0 && sz.md > 0 && sz.f > 0 && sz.ml === undefined && sz.d === undefined,
		Object.keys(sz).sort().join(','));
	check('D0. the INLINE transcripts are counted apart from the chats section',
		sz.ci === utf8Len(JSON.stringify(['hello', 'there'])) && sz.ci < sz.c,
		'ci=' + sz.ci + ' c=' + sz.c);
	check('D0. a chat that OFFLOADED weighs only its ref — it is not in the inline figure',
		sz.ci === utf8Len(JSON.stringify(['hello', 'there'])));
	const summed = Object.keys(sz).filter((k) => k !== 'ci').reduce((a, k) => a + sz[k], 0);
	check('D0. and the named sections plus `o` account for the whole parcel — nothing unmeasured',
		summed === utf8Len(plain), summed + ' vs ' + utf8Len(plain));
}

console.log('\nD. the refusal — over the door, refused here rather than at the far end\n');

{
	const tab = makeTab();
	tab.unlocked = true;
	const S = tab.win.DaimondSync;
	const events = [];
	tab.win.DEBUG_SHARE = { event: (kind, payload) => { events.push([kind, payload]); return true; } };

	// A round that LANDED first, so the skip below has a cursor to stand on -- a
	// device that has never pushed has nothing to compare against and is entitled
	// to re-measure every round.
	tab.parcel = parcel({ selfSeen: 1000 });
	await S.push();
	check('D0. the fixture starts from a landed push', tab.posts.length === 1 && S.version() > 0,
		'v' + S.version());
	events.length = 0;

	// A parcel genuinely over the door. One chat of ~9 MiB of inline transcript:
	// nothing contrived about the shape, only the size.
	const big = parcel({ selfSeen: 1000 });
	big.chats = [{ id: 'c1', messages: ['y'.repeat(9 * 1024 * 1024)] }];
	tab.parcel = big;
	await S.push();

	check('D1. NOTHING IS SENT — the body is never written, let alone encrypted',
		tab.posts.length === 1, (tab.posts.length - 1) + ' further POST(s)');
	check('D1. and the engine reports the stall, so the chip can say so',
		S.state().stalled === true && S.state().stalledWhy === 'too_big',
		S.state().stalledWhy);
	const ref = events.filter((e) => e[0] === 'sync' && e[1] && e[1].commit === 'refused');
	check('D2. the feed carries one refusal, said as commit/why',
		ref.length === 1 && ref[0][1].why === 'too-large', ref.length + ' event(s)');
	check('D2. with the wire estimate and the door it failed, both in bytes',
		ref.length === 1 && ref[0][1].wire > ref[0][1].door && ref[0][1].door === 8 * 1024 * 1024,
		ref.length ? ref[0][1].wire + ' > ' + ref[0][1].door : 'no event');
	check('D2. and the section sizes, so WHICH section grew is in the event itself',
		ref.length === 1 && ref[0][1].ci > 8 * 1024 * 1024 && ref[0][1].c > 0,
		ref.length ? 'ci=' + ref[0][1].ci : 'no event');
	check('D3. the parcel is untouched — nothing dropped or shed to get under the door',
		big.chats.length === 1 && big.chats[0].messages[0].length === 9 * 1024 * 1024);

	// THE EVENT HAS TO FIT. debugshare.js caps a row at MAX_EVENT_BYTES = 360 and
	// trims the longest STRING to get there -- so a payload that overran would lose
	// `why` before it lost a single figure, and the row would read as a refusal for
	// no reason. Measured with every section present, which is the worst case.
	const worst = { dir: 'push', commit: 'refused', why: 'too-large',
		wire: 99999999, door: 8388608, at: 999999,
		f: 99999999, c: 99999999, ci: 99999999, k: 99999999, d: 99999999,
		l: 99999999, md: 99999999, ml: 99999999, o: 99999999 };
	const worstBytes = new TextEncoder().encode(JSON.stringify(worst)).length;
	check('D3. and the refusal event fits the feed\'s 360-byte row with the base fields to spare',
		worstBytes < 280, worstBytes + ' bytes of payload');

	// And it does not spin: the same oversize state is refused ONCE and left alone,
	// because the refusal records the comparison key the way a 413 does. The round
	// still takes its throttled idle pull, which is a `dir: 'pull'` event and is
	// the point of that path -- so it is the REFUSALS that are counted here.
	await S.push();
	const refs2 = events.filter((e) => e[0] === 'sync' && e[1] && e[1].commit === 'refused');
	check('D4. a second round on the same oversize parcel neither sends nor says it twice',
		tab.posts.length === 1 && refs2.length === 1,
		refs2.length + ' refusal(s), ' + (tab.posts.length - 1) + ' further POST(s)');

	// Under the door again, the same tab: the refusal lifts and the parcel goes.
	tab.parcel = parcel({ selfSeen: 1000, chats: [{ id: 'c1', messages: ['small'] }] });
	// `tooLarge` stands until a push lands, and a push is what lifts it -- so the
	// engine has to be asked again, exactly as a user's next turn would.
	await S.push();
	check('D5. a parcel back under the door sends, and the stall lifts',
		tab.posts.length === 2 && S.state().stalled === false, tab.posts.length + ' POST(s)');
	const landed = events.filter((e) => e[0] === 'sync' && e[1] && e[1].dir === 'push' && e[1].to);
	check('D5. and the push that landed carries BOTH figures — the parcel and the wire',
		landed.length === 1 && landed[0][1].bytes > 0 && landed[0][1].wire > landed[0][1].bytes,
		landed.length ? 'bytes=' + landed[0][1].bytes + ' wire=' + landed[0][1].wire : 'no event');
}

console.log(failures ? '\n' + failures + ' FAILED\n' : '\nall push-skip and parcel-size checks passed\n');
process.exit(failures ? 1 : 0);
