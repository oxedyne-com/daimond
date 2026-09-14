/* ============================================================
   Test — the two wire halves of the placement.
   ------------------------------------------------------------
   The placement's DECISION is proved in dev/verify_place.mjs.
   What is proved here is the two things that have to travel for
   the decision to be taken at all, driven against the real
   www/js/peer.js and www/js/cloud.js in a simulated tab:

     A. `hand` and `folder` on the beat are TRI-STATE, end to end
        through `presenceBeat`, `presenceIngest` and
        `presenceAdopt`. Absent must never collapse to a stale
        `false`: a peer on a build that cannot say is NAMED as
        unknown by the placement and struck out by nobody, which
        is the seq-218 rollout rule. An EXPLICIT false must reach
        the far side as a false, because a hand unplugged and a
        folder grant withdrawn are live changes and only an
        explicit answer can carry them.

     B. A `@p/` live preview is the ONE content key that crosses a
        device on its stamp. Every other content manifest belongs
        to the device that offloaded it; a preview is one fact
        about one document in one folder, and the device holding
        it is often exactly the one that can never commit an index
        (a folder-mounted runner). Without the crossing the phone
        cannot draw the pages the desktop laid out.

   Run:  node www/js/place.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

// ── One simulated tab, the pattern peer.test.mjs established ──
function makeTab(scripts) {
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
		readyState: 'complete', addEventListener: () => {},
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
		createElement: () => Object.assign({}, noEl), body: noEl,
	};
	function CustomEventShim(t, o) { this.type = t; this.detail = o && o.detail; }
	const quiet = { debug: () => {}, log: () => {}, warn: console.warn, error: console.error };
	for (const rel of scripts) {
		const body = readFileSync(join(HERE, rel), 'utf8');
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
	win.__localStorage = localStorage;
	return win;
}

console.log('\n— A: `hand` and `folder` are tri-state end to end —');
{
	const win = makeTab(['peer.js']);
	const P = win.DaimondPeer, Pr = win.DaimondPresence;
	const now = Date.now();
	const ARG = 'a0000000000000000000000000000000';
	const OLD = 'o0000000000000000000000000000000';

	// A device that SAYS both, and one on a build that cannot.
	Pr.beat(ARG, 'argonaut', now, false, true, 'b1', true, false, true, true);
	Pr.beat(OLD, 'oldbox',   now, false, true, 'b0', true, false);
	let snap = Pr.snapshot();
	check('A1 a device that says both carries both',
		snap[ARG].hand === true && snap[ARG].folder === true,
		JSON.stringify({ hand: snap[ARG].hand, folder: snap[ARG].folder }));
	check('A1 a device that cannot say carries NEITHER FIELD — not a false',
		!('hand' in snap[OLD]) && !('folder' in snap[OLD]),
		JSON.stringify(snap[OLD]));

	// The election must skip the one that cannot say, and seat the one that can.
	const opts = { selfId: 'self', windowMs: P.DISPATCH_FRESH_MS };
	check('A2 `require` seats the device that said true',
		P.handoffTarget(snap, Object.assign({ require: 'hand' }, opts), now).target.deviceId === ARG);
	const onlyOld = { [OLD]: snap[OLD] };
	check('A2 and skips the one that could not say, rather than guessing',
		!P.handoffTarget(onlyOld, Object.assign({ require: 'hand' }, opts), now).target);

	// A LIVE CHANGE. The hand is unplugged; the next beat says so explicitly, and
	// the far side must read a false rather than keeping the last true.
	Pr.beat(ARG, 'argonaut', now + 1000, false, true, 'b1', true, false, false, true);
	snap = Pr.snapshot();
	check('A3 an explicit false REPLACES a remembered true',
		snap[ARG].hand === false && snap[ARG].folder === true,
		JSON.stringify({ hand: snap[ARG].hand, folder: snap[ARG].folder }));
	check('A3 and the election stops seating it for a hand-bearing task',
		!P.handoffTarget(snap, Object.assign({ require: 'hand' }, opts), now + 1000).target);

	// A BEAT THAT COULD NOT ASK is not the device saying no: it keeps what it said.
	Pr.beat(ARG, 'argonaut', now + 2000, false, true, 'b1', true, false);
	snap = Pr.snapshot();
	check('A4 a beat carrying neither field keeps the last answers',
		snap[ARG].hand === false && snap[ARG].folder === true,
		JSON.stringify({ hand: snap[ARG].hand, folder: snap[ARG].folder }));

	// THE GATEWAY'S MAP. A relayed row carrying the fields sets them; one that omits
	// them leaves them absent, so `recGenuine`-style fallbacks still apply and the
	// placement names the peer as a maybe.
	Pr.forget();
	Pr.ingest({
		[ARG]: { name: 'argonaut', last_seen: now, hand: true, folder: false },
		[OLD]: { name: 'oldbox', last_seen: now },
	}, now);
	snap = Pr.snapshot();
	check('A5 ingest relays an explicit pair verbatim',
		snap[ARG].hand === true && snap[ARG].folder === false);
	check('A5 and OMITS what the gateway did not send',
		!('hand' in snap[OLD]) && !('folder' in snap[OLD]), JSON.stringify(snap[OLD]));

	// THE PARCEL MERGE. An incoming line without the fields must not blank what we
	// know; one with them wins on the freshest stamp, like every other scalar here.
	Pr.adopt({ [ARG]: { name: 'argonaut', lastSeen: now + 5000 } });
	snap = Pr.snapshot();
	check('A6 adopt preserves absent rather than clobbering to false',
		snap[ARG].hand === true && snap[ARG].folder === false,
		JSON.stringify({ hand: snap[ARG].hand, folder: snap[ARG].folder }));
	Pr.adopt({ [ARG]: { name: 'argonaut', lastSeen: now + 9000, hand: false, folder: true } });
	snap = Pr.snapshot();
	check('A6 and takes an explicit pair from a fresher line',
		snap[ARG].hand === false && snap[ARG].folder === true);
}

console.log('\n— B: a `@p/` preview is the one content key that crosses —');
{
	const win = makeTab(['chunks.js', 'cloud.js']);
	const C = win.DaimondCloud;
	const KEY = '@p/' + 'd'.repeat(32);
	const chunk = (a) => [{ addr: String(a).padStart(64, '0'), size: 16 }];

	check('B1 the content-key test admits the preview prefix beside the other three',
		C.isContentKey('@p/x') && C.isContentKey('@c/x') && C.isContentKey('@d/x')
		&& C.isContentKey('@m/x') && !C.isContentKey('book/main.typ'));
	check('B1 and the preview test picks out only the preview',
		C.isPreviewKey('@p/x') && !C.isPreviewKey('@c/x') && !C.isPreviewKey('book/main.typ'));

	// A RUNNER'S PREVIEW, PULLED BY A DEVICE THAT HAS NONE. Adopted: without this
	// the phone holds a report naming chunks its own index never declares, and the
	// commit that follows sweeps the pages it is looking at.
	C.merge({ [KEY]: { v: 2, size: 9, key: 'k', chunks: chunk(1), ts: 1000, pages: 48 } },
		{}, 'self');
	check('B2 a preview this device has never seen is adopted from a peer',
		!!C.contentGet(KEY) && C.contentGet(KEY).pages === 48,
		JSON.stringify(C.contentGet(KEY) && C.contentGet(KEY).ts));

	// A FRESHER ONE REPLACES IT; a staler one does not. Whichever device laid the
	// document out last holds the true answer about what it costs.
	C.merge({ [KEY]: { v: 2, size: 9, key: 'k', chunks: chunk(2), ts: 2000, pages: 49 } }, {}, 'self');
	check('B3 a FRESHER preview replaces it', C.contentGet(KEY).pages === 49,
		String(C.contentGet(KEY).pages));
	C.merge({ [KEY]: { v: 2, size: 9, key: 'k', chunks: chunk(3), ts: 500, pages: 12 } }, {}, 'self');
	check('B3 a STALER one does not', C.contentGet(KEY).pages === 49,
		String(C.contentGet(KEY).pages));
	C.merge({}, {}, 'self');
	check('B3 and a parcel that does not mention it leaves it alone',
		!!C.contentGet(KEY) && C.contentGet(KEY).pages === 49);

	// AND NOTHING ELSE CROSSED. A chat's or a Diamond's manifest belongs to the
	// device that offloaded it, and adopting one would name addresses this device
	// cannot vouch for -- the rule the preview is the deliberate exception to.
	C.merge({ '@c/chat1': { v: 2, size: 4, key: 'k', chunks: chunk(4) },
		'@d/dia1': { v: 2, size: 4, key: 'k', chunks: chunk(5) } }, {}, 'self');
	check('B4 a peer’s chat and Diamond manifests are still dropped',
		!C.contentGet('@c/chat1') && !C.contentGet('@d/dia1'));

	// A PEER SIDECAR ON A PREVIEW still behaves as a sidecar -- it is the naming of
	// somebody else's addresses, not a preview, and the owner rule decides it.
	const SIDE = KEY + '.peer.' + 'a'.repeat(32);
	C.merge({ [SIDE]: { v: 2, size: 4, chunks: chunk(6), peer: true, dev: 'a'.repeat(32) } },
		{}, 'self');
	check('B5 a peer sidecar on a preview key crosses as a sidecar, not as a preview',
		!!C.contentGet(SIDE) && C.contentGet(SIDE).peer === true);
}

console.log(failures ? `\n${failures} FAILED` : '\nall placement wire checks passed');
if (failures) process.exit(1);
