/* ============================================================
   Test — the two halves of "a reference is not a holding".
   ------------------------------------------------------------
   Drives the REAL www/js/chunks.js and www/js/cloud.js in a
   simulated tab (a Map-backed localStorage, a no-op document, and
   a `DaimondGateway.gwFetch` standing in for /api/chunk) to prove
   the parts of the manifest-presence fix that are theirs:

     A. `presence` puts ONE question per batch of HAVE_QUERY_BATCH
        addresses, never a larger one than the gateway's `have`
        accepts, and it distinguishes "the store does not hold
        this" from "the store did not answer" -- which is the whole
        of the fail-safe. `missing` keeps the older, fail-open
        reading, because a re-upload costs bytes and never a file.

     B. `contentReap` reaps a `.peer` sidecar WITH ITS CHAT and
        never instead of it. The chat collector enumerates chat
        ids, so without the suffix rule the reap deleted every peer
        entry on the collect that was meant to commit it.

     C. A slot is PER DEVICE -- `@c/<id>.peer.<device>` -- so two
        peers' refs for ONE chat both stand, a Diamond gets the same
        treatment, and a device taken off the roster loses its slots
        and only its own.

     D. A peer slot is the ONE content key `merge` carries across a
        device, because it is the one the holder is not the author
        of. Our own manifest, and a peer's record of OUR addresses,
        are still dropped.

   The collectors themselves are proven in the browser, against the
   real cloud index and a real commit: dev/verify_contentoffload.mjs,
   invariants 7 and 8.

   Run:  node www/js/presence.test.mjs
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

// ── One simulated tab, the pattern peer.test.mjs established ──
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
	};
	const document = {
		readyState: 'complete',
		addEventListener: () => {},
		querySelector: () => null,
		querySelectorAll: () => [],
		getElementById: () => null,
		createElement: () => Object.assign({}, noEl),
		body: noEl,
	};
	function CustomEventShim(t, o) { this.type = t; this.detail = o && o.detail; }
	const quiet = { debug: () => {}, log: () => {}, warn: console.warn, error: console.error };

	function loadScript(rel) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		// See peer.test.mjs: `with (window)` is what resolves a sibling module's
		// bare global the way a browser's global object does.
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage',
			'TextEncoder', 'TextDecoder', 'CustomEvent', 'Blob',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis', 'navigator',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage,
			TextEncoder, TextDecoder, CustomEventShim, Blob,
			setTimeout, clearTimeout, setInterval, clearInterval,
			quiet, globalThis, { storage: {} });
	}
	loadScript('chunks.js');
	loadScript('cloud.js');
	win.__localStorage = localStorage;
	return win;
}

/// A gateway that answers `have` from a set it holds, recording every batch it
/// was asked about — or refuses with `status`, for the fail-safe half.
function armGateway(win, held, opts) {
	const o = opts || {};
	const seen = [];
	win.DaimondGateway = {
		clientApi: () => 1,
		gwFetch: async (path_, init) => {
			const body = JSON.parse(init.body);
			if (body.op === 'have') {
				seen.push(body.addrs.length);
				if (o.status && o.status !== 200) return { status: o.status, json: async () => ({ error: 'nope' }) };
				if (o.garbage) return { status: 200, json: async () => ({ ok: true }) };
				return { status: 200, json: async () => ({ ok: true, missing: body.addrs.filter((a) => !held.has(a)) }) };
			}
			return { status: 200, json: async () => ({ ok: true }) };
		},
	};
	return seen;
}

const addr = (i) => String(i).padStart(64, '0');

console.log('\n— A: presence batches, and tells absence from silence —');
{
	const win = makeTab();
	// 4,500 addresses, of which 7 are genuinely gone.
	const all = [];
	for (let i = 0; i < 4500; i++) all.push(addr(i));
	const gone = new Set(all.slice(100, 107));
	const held = new Set(all.filter((a) => !gone.has(a)));
	const seen = armGateway(win, held);

	const res = await win.DaimondChunks.presence(all);
	check('presence answers ok when the gateway answered', res.ok === true);
	check('and names exactly the addresses it no longer holds', res.missing.length === 7
		&& res.missing.every((a) => gone.has(a)), `${res.missing.length} missing`);
	check('the question is split into batches, none over the cap', seen.length === 3
		&& Math.max(...seen) <= 2000, `batches ${seen.join(',')}`);
	check('and the batches account for every address', seen.reduce((a, b) => a + b, 0) === 4500);

	// One address per batch is well under the gateway's MAX_HAVE_BATCH of 20,000
	// and its 16 MiB body — and under Steel's tighter 8 MiB front door.
	const worstBody = JSON.stringify({ op: 'have', addrs: all.slice(0, Math.max(...seen)) }).length;
	check('the largest body one batch can make stays far under the front door',
		worstBody < 1024 * 1024, `${Math.round(worstBody / 1024)} kB`);

	const empty = await win.DaimondChunks.presence([]);
	check('nothing to ask about asks nothing', empty.ok === true && empty.missing.length === 0 && seen.length === 3);
}

{
	const win = makeTab();
	const all = [addr(1), addr(2), addr(3)];
	armGateway(win, new Set(all), { status: 503 });
	const res = await win.DaimondChunks.presence(all);
	check('a REFUSED have is not evidence of absence: ok is false', res.ok === false);
	check('and the caller that stands still can see every address is unvouched',
		res.missing.length === 3, `${res.missing.length}`);
	const m = await win.DaimondChunks._missing(all);
	check('while `missing` keeps its fail-OPEN reading, for the re-upload path', m.length === 3);
}

{
	const win = makeTab();
	const all = [addr(4), addr(5)];
	armGateway(win, new Set(all), { garbage: true });
	const res = await win.DaimondChunks.presence(all);
	check('a 200 whose body is not a list is unanswered too', res.ok === false && res.missing.length === 2);
}

console.log('\n— B: a peer sidecar is reaped with its chat, not instead of it —');
{
	const win = makeTab();
	const C = win.DaimondCloud;
	check('the peer key is the chat key with a suffix', C.peerKey('abc') === '@c/abc.peer');
	check('and it reads as content, so the file merge and the residency list skip it',
		C.isContentKey(C.peerKey('abc')) === true);

	C.contentSet('@c/live', { v: 2, size: 10, key: 'k1', chunks: [{ addr: addr(1), size: 10 }], fp: 'f' });
	C.contentSet(C.peerKey('live'), { v: 2, size: 10, key: 'k2', chunks: [{ addr: addr(2), size: 10 }], peer: true });
	C.contentSet('@c/gone', { v: 2, size: 10, key: 'k3', chunks: [{ addr: addr(3), size: 10 }], fp: 'f' });
	C.contentSet(C.peerKey('gone'), { v: 2, size: 10, key: 'k4', chunks: [{ addr: addr(4), size: 10 }], peer: true });

	C.contentReap('@c/', { live: 1 });
	const ix = C.index();
	check('the live chat keeps its own manifest', !!ix['@c/live']);
	check('AND keeps the peer refs beside it — the reap that used to eat them',
		!!ix[C.peerKey('live')]);
	check('the deleted chat loses its manifest', !ix['@c/gone']);
	check('and its peer entry goes with it — bounded, never orphaned',
		!ix[C.peerKey('gone')]);
}

console.log('\n— C: a slot PER DEVICE, reaped with the roster —');
{
	const win = makeTab();
	const C = win.DaimondCloud;
	const A = 'a1a1a1a1a1a1a1a1', B = 'b2b2b2b2b2b2b2b2';
	check('a device-keyed slot is the item key, the suffix and the device',
		C.peerKey('abc', A) === '@c/abc.peer.' + A
			&& C.peerKeyFor('@d/xyz', B) === '@d/xyz.peer.' + B);
	check('and a Diamond slot still reads as content, so every file mechanism skips it',
		C.isContentKey(C.peerKeyFor('@d/xyz', B)) === true);
	check('the owner is readable back off the key, and a bare item is not a slot',
		C.peerOwner(C.peerKey('abc', A)) === A && C.peerOwner(C.peerKey('abc')) === ''
			&& C.peerOwner('@c/abc') === null);

	// Two peers holding different addresses for ONE chat, which is what a single
	// slot could not express: pulling B's parcel forgot A's refs, and the next
	// commit swept them.
	C.contentSet('@c/live', { v: 2, size: 10, key: 'k1', chunks: [{ addr: addr(1), size: 10 }], fp: 'f' });
	C.contentSet(C.peerKey('live', A), { v: 2, size: 10, chunks: [{ addr: addr(2), size: 10 }], peer: true, dev: A });
	C.contentSet(C.peerKey('live', B), { v: 2, size: 10, chunks: [{ addr: addr(3), size: 10 }], peer: true, dev: B });
	C.contentSet(C.peerKeyFor('@d/dia', A), { v: 2, size: 10, chunks: [{ addr: addr(4), size: 10 }], peer: true, dev: A });

	C.contentReap('@c/', { live: 1 });
	let ix2 = C.index();
	check('a reap keyed on the chat id keeps BOTH devices\' slots',
		!!ix2[C.peerKey('live', A)] && !!ix2[C.peerKey('live', B)]);

	const reaped = C.peerReap({ [B]: 1 });
	ix2 = C.index();
	check('a device off the roster loses its slots, chat and Diamond alike',
		reaped === true && !ix2[C.peerKey('live', A)] && !ix2[C.peerKeyFor('@d/dia', A)]);
	check('and the device still on it keeps its own', !!ix2[C.peerKey('live', B)]);
	check('our own manifest is never a peer slot, so the reap cannot touch it',
		!!ix2['@c/live']);
	check('a reap that changes nothing writes nothing', C.peerReap({ [B]: 1 }) === false);
}

console.log('\n— D: a peer slot is the one content key that crosses a merge —');
{
	const win = makeTab();
	const C = win.DaimondCloud;
	const SELF = 'd4d4d4d4d4d4d4d4', X = 'c3c3c3c3c3c3c3c3', B = 'b2b2b2b2b2b2b2b2';
	C.contentSet('@c/chat', { v: 2, size: 10, key: 'mine', chunks: [{ addr: addr(1), size: 10 }], fp: 'f' });
	C.contentSet(C.peerKey('chat', B), { v: 2, size: 10, chunks: [{ addr: addr(2), size: 10 }], peer: true, dev: B });

	const remote = {};
	remote['@c/chat'] = { v: 2, size: 9, key: 'theirs', chunks: [{ addr: addr(7), size: 9 }], fp: 'g' };
	remote[C.peerKey('chat', X)] = { v: 2, size: 9, chunks: [{ addr: addr(8), size: 9 }], peer: true, dev: X };
	remote[C.peerKey('chat', B)] = { v: 2, size: 9, chunks: [{ addr: addr(9), size: 9 }], peer: true, dev: B };
	remote[C.peerKey('chat', SELF)] = { v: 2, size: 9, chunks: [{ addr: addr(6), size: 9 }], peer: true, dev: SELF };
	remote['@c/unknown'] = { v: 2, size: 9, key: 'u', chunks: [{ addr: addr(5), size: 9 }], fp: 'h' };

	const out = C.merge(remote, {}, SELF);
	check('a slot for a device this one has never pulled from is CARRIED',
		!!out[C.peerKey('chat', X)]
			&& out[C.peerKey('chat', X)].chunks[0].addr === addr(8));
	check('a slot this device already holds keeps its own observation',
		out[C.peerKey('chat', B)].chunks[0].addr === addr(2));
	check('a peer\'s slot ABOUT THIS DEVICE is refused', !out[C.peerKey('chat', SELF)]);
	check('a remote copy of a manifest we hold is still dropped',
		out['@c/chat'].key === 'mine');
	check('and a remote manifest we do not hold at all is still dropped',
		!out['@c/unknown']);
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
