/* ============================================================
   Test — the peer sidecar's device segment (cloud.js `PEER_RE`).
   ------------------------------------------------------------
   Drives the REAL www/js/cloud.js in a simulated tab (a Map-backed
   localStorage and a bare window) over the one character that decided
   whether three devices could keep each other's chunks alive.

   A `.peer.<device>` slot names the addresses ONE PEER's parcel carried
   for an item, so the committing device declares them live and the
   gateway's sweep leaves them. `notePeerRef` (daimond.js) keys those
   slots by `parcelSender` -- the ROSTER id -- and every roster id on the
   owner's fleet is thirty-two hex characters. `PEER_RE` admitted sixteen
   and nothing else, so on the real fleet:

     `peerOwner` answered null for every slot ever written, which is
     "not a sidecar at all";
     `contentReap` therefore judged the slot by the WHOLE key, found no
     chat of that id, and deleted it -- on the very collect that was
     about to commit it (`collectChatsRefs`);
     `peerReap` skipped it, so nothing would have reaped it if the
     device had left;
     `merge` dropped it rather than crossing it, so a peer's refs never
     reached a third device.

   Measured on the owner's account 2026-09-13: the phone's commit swept
   the two desktops' fresh uploads every round, and each desktop
   re-offloaded the same five items minutes later, for ever.

   Sixteen hex is still admitted -- `DEVICE_ID_RE` (daimond.js:3620)
   allows both widths, and this file is the second half of that rule.

   Run:  node www/js/peerkey.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); }
	else { console.log('  FAIL ' + line); failures++; }
}

const WIDE  = '96a1474270a784f8d7ba6f1bf9dc434d';	// a REAL roster id: 32 hex
const WIDE2 = 'b7c2e01144d9a6f3081bb5cc2ef91a77';
const NARROW = 'a1a1a1a1a1a1a1a1';					// the legacy width, still legal
const SELF  = 'ffeeddccbbaa99887766554433221100';

/// One simulated tab holding cloud.js, the pattern peer.test.mjs established.
function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { addEventListener: () => {}, dispatchEvent: () => true };
	const body = readFileSync(join(HERE, 'cloud.js'), 'utf8');
	// `with (window)`, as peer.test.mjs explains: the app scripts read their
	// siblings as bare identifiers after a `window.X &&` guard, and `new Function`
	// gives them no global to find them on.
	const fn = new Function(
		'window', 'localStorage', 'navigator', 'setTimeout', 'clearTimeout', 'console',
		'with (window) {\n' + body + '\n}');
	loadStore(win, localStorage);
	fn(win, localStorage, { storage: {} }, setTimeout, clearTimeout,
		{ log: () => {}, debug: () => {}, warn: () => {}, error: () => {} });
	return { win, store, C: win.DaimondCloud, localStorage };
}

/// A manifest of one chunk, the shape `notePeerRef` writes.
const slot = (addr, dev) => ({ v: 3, size: 8, chunks: [{ addr, size: 8 }], peer: true, dev: dev || '' });
const mine = (addr) => ({ v: 3, size: 8, key: 'k', fp: 'f', chunks: [{ addr, size: 8 }] });

console.log('\nA. peerOwner — which device a slot speaks for\n');

{
	const { C } = makeTab();
	check('A1. a 32-hex device id is the slot\'s owner — the width the roster actually uses',
		C.peerOwner('@c/cmszd1052-1-qya52.peer.' + WIDE) === WIDE,
		String(C.peerOwner('@c/cmszd1052-1-qya52.peer.' + WIDE)));
	check('A2. a 16-hex id still is — the legacy width is not dropped to make room',
		C.peerOwner('@c/chat.peer.' + NARROW) === NARROW);
	check('A3. the unattributed slot answers \'\', not null — a parcel that did not say who it was',
		C.peerOwner('@c/chat.peer') === '');
	check('A4. an ordinary manifest is not a sidecar at all',
		C.peerOwner('@c/chat') === null && C.peerOwner('notes/a.md') === null);
	check('A5. and a hex tail of some other width does not pass as a device',
		C.peerOwner('@c/chat.peer.deadbeef') === null
		&& C.peerOwner('@c/chat.peer.' + WIDE + 'ab') === null);
}

console.log('\nB. contentReap — the slot is reaped WITH ITS ITEM, never on its own\n');

{
	const { C } = makeTab();
	const cid = 'cmszd1052-1-qya52';
	C.contentSet('@c/' + cid, mine('aa'.repeat(32)));
	C.contentSet(C.peerKey(cid, WIDE), slot('bb'.repeat(32), WIDE));
	C.contentSet(C.peerKey(cid, NARROW), slot('cc'.repeat(32), NARROW));
	// The chat collector enumerates CHAT IDS, which is what the slot key is not.
	const live = {}; live[cid] = 1;
	C.contentReap('@c/', live);
	check('B1. a live chat\'s 32-hex peer slot survives the collect that commits it',
		!!C.contentGet(C.peerKey(cid, WIDE)),
		'index now: ' + Object.keys(C.index()).join(', '));
	check('B1. and so does its 16-hex one, and its own manifest',
		!!C.contentGet(C.peerKey(cid, NARROW)) && !!C.contentGet('@c/' + cid));

	// The other half of the rule: a slot for a chat that is GONE goes with it.
	C.contentReap('@c/', {});
	check('B2. a deleted chat takes its peer slots with it — the sidecar outlives nothing',
		!C.contentGet(C.peerKey(cid, WIDE)) && !C.contentGet(C.peerKey(cid, NARROW))
		&& !C.contentGet('@c/' + cid));
}

console.log('\nC. peerReap — a device off the roster stops naming addresses\n');

{
	const { C } = makeTab();
	C.contentSet('@c/x', mine('11'.repeat(32)));
	C.contentSet(C.peerKey('x', WIDE),  slot('22'.repeat(32), WIDE));
	C.contentSet(C.peerKey('x', WIDE2), slot('33'.repeat(32), WIDE2));
	C.contentSet(C.peerKey('x'),        slot('44'.repeat(32), ''));
	const roster = {}; roster[WIDE] = 1;
	C.peerReap(roster);
	check('C1. a 32-hex device still on the roster keeps its slot',
		!!C.contentGet(C.peerKey('x', WIDE)));
	check('C2. one that has left loses it — the one way the scheme could grow without bound',
		!C.contentGet(C.peerKey('x', WIDE2)));
	check('C3. the unattributed slot is never reaped here — no device on it to judge',
		!!C.contentGet(C.peerKey('x')));
	check('C4. and our own manifest is untouched',
		!!C.contentGet('@c/x'));
}

console.log('\nD. merge — a peer sidecar is the one content key that crosses\n');

{
	const { C } = makeTab();
	C.contentSet('@c/y', mine('55'.repeat(32)));
	const remote = {};
	remote[C.peerKey('y', WIDE)] = slot('66'.repeat(32), WIDE);
	remote[C.peerKey('y', SELF)] = slot('77'.repeat(32), SELF);
	remote['@c/y'] = mine('88'.repeat(32));
	const out = C.merge(remote, {}, SELF);
	check('D1. a third device adopts a 32-hex peer\'s slot it has never pulled itself',
		JSON.stringify((out[C.peerKey('y', WIDE)] || {}).chunks) === JSON.stringify(slot('66'.repeat(32)).chunks),
		Object.keys(out).join(', '));
	check('D2. a slot keyed by OURSELVES is never adopted — our manifest is the authority',
		!out[C.peerKey('y', SELF)]);
	check('D3. and our own content manifest is kept, not overwritten by the remote copy',
		out['@c/y'].chunks[0].addr === '55'.repeat(32));
}

console.log('');
if (failures) { console.log(failures + ' FAILED'); process.exit(1); }
console.log('all ok');
