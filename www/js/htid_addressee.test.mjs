/* ============================================================
   Test -- HT-ID (QA-HT-B F2): an errand that names a runner is that
   runner's alone, whatever the runner's presence (rulings §1 l.9, l.15).
   ------------------------------------------------------------
   The REAL peer.js (rc's probe qa-ht-b/probe/qahtb_f2.probe.mjs, made a test).

     F2-ctl  old gateway, argonaut silent 11 s: gilgamesh stands down;
     F2a     derived gateway, argonaut not listening 11 s: gilgamesh stands down;
     F2b     derived gateway, argonaut re-parked and unstated: stands down;
     F2c     the addressee itself claims; an errand with no addressee is the
             nomination's; a runner that handed it back no longer holds it.

   Red proof:  MM_SRC_REV=aeb8a3f11 node www/js/htid_addressee.test.mjs
   ============================================================ */
import { source, liftFn } from './testlift.mjs';
import { webcrypto } from 'node:crypto';


let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

let PEER = source('peer.js');
const MARKS = source('markshere.js');
const STAMP = source('stamp.js');

// ── One simulated tab ──
function makeTab() {
	const store = new Map();
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { localStorage };
	win.addEventListener = () => {};
	win.dispatchEvent = () => true;
	win.DaimondIdentity = { isUnlocked: () => true };
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
	const quiet = { debug: () => {}, log: () => {}, warn: () => {}, error: console.error };
	for (const body of [STAMP, PEER, MARKS]) {
		const fn = new Function(
			'window', 'document', 'crypto', 'localStorage',
			'TextEncoder', 'TextDecoder', 'CustomEvent', 'Blob',
			'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
			'console', 'globalThis', 'navigator', 'module',
			'with (window) {\n' + body + '\n}');
		fn(win, document, webcrypto, localStorage,
			TextEncoder, TextDecoder, CustomEventShim, Blob,
			setTimeout, clearTimeout, setInterval, clearInterval,
			quiet, globalThis, { storage: {} }, undefined);
	}
	return win;
}

const NOW  = 1_800_000_000_000;
const MIN  = 60_000;
const SELF = 's0000000000000000000000000000000';
const RUN  = 'a0000000000000000000000000000000';		// the nominated runner (argonaut)
const GIL  = 'g0000000000000000000000000000000';		// a desktop no tab has stated for (gilgamesh)
const PHN  = 'p0000000000000000000000000000000';		// the phone the person is at
const FID  = '0123456789abcdef0123456789abcdef';		// the asker's folder id
const DIA  = '18f0a0b0c0d0e0f';						// the chat's Diamond
const CHAT = { id: 'c1', diamondId: DIA, messages: [] };

const tab = makeTab();
const P = tab.DaimondPeer;
const M = tab.DaimondMarksHere;
const W = P.DISPATCH_FRESH_MS;

// A row from a deriving gateway: the posture stated 5 min ago, the doors held now.
function derived(f) {
	return Object.assign({ name: 'argonaut', lastSeen: NOW - 5 * MIN, runner: true, folder: true, mobile: false,
		listening: true, heardAt: NOW - 1000, doors: 1, stated: true }, f);
}
// A row from a gateway before HT1: the beat and nothing derived.
function old(f) {
	return Object.assign({ name: 'argonaut', lastSeen: NOW - 5000, runner: true, folder: true, mobile: false }, f);
}
const seatOpts = (f) => Object.assign({ selfId: SELF, nominatedId: RUN, freshWindowMs: W, runnerOnly: true,
	toggle: null }, f);
const sw  = (p, f) => P.seatSwitch(CHAT, p, seatOpts(f), NOW);
const ad  = (p, f) => P.autoDispatchDecision(CHAT, p, seatOpts(f), NOW);
// ── QA-HT-B probe F2: a non-addressee desktop and a turn the switch sent to argonaut ──
// Rulings §1 l.9 ("If argonaut is selected, it runs there") and l.15 ("only the named
// runner takes the turn"): gilgamesh, collecting an errand addressed to argonaut, must
// stand down (addr === true) or the nomination must hold it down.
{
	const e = { turnId: 't1', chatId: 'c1', to: RUN, dispatchedBy: PHN, tried: [] };
	const gil = { name: 'gilgamesh', lastSeen: NOW, runner: false, folder: true, mobile: false,
		listening: true, heardAt: NOW, doors: 1, stated: true };
	function claims(pres) {
		const addr = P.addresseeStandDown(e, GIL, pres, NOW, W);
		if (addr === true) return false;
		if (addr === null && P.nominationStandDown(RUN, GIL, pres, NOW, W)) return false;
		return true;
	}
	// The same 11 s of silence from argonaut, under each gateway.
	const oldPres = { [RUN]: old({ lastSeen: NOW - 11000, servicedAt: NOW - 11000 }), [GIL]: old({ name: 'gilgamesh', runner: false }) };
	const drvPres = { [RUN]: derived({ listening: false, doors: 0, heardAt: NOW - 11000 }), [GIL]: gil };
	check('F2-ctl. old gateway, argonaut silent 11 s: gilgamesh stands down', claims(oldPres) === false,
		'claims=' + claims(oldPres));
	check('F2a. derived gateway, argonaut not listening 11 s: gilgamesh stands down', claims(drvPres) === false,
		'claims=' + claims(drvPres) + ' addr=' + P.addresseeStandDown(e, GIL, drvPres, NOW, W));
	// argonaut reloading: its new tab parked (listening) before it stated a posture.
	const reload = { [RUN]: derived({ stated: false }), [GIL]: gil };
	check('F2b. derived gateway, argonaut re-parked unstated: gilgamesh stands down', claims(reload) === false,
		'claims=' + claims(reload) + ' addr=' + P.addresseeStandDown(e, GIL, reload, NOW, W));
}
{
	const e = { turnId: 't2', chatId: 'c1', to: RUN, dispatchedBy: PHN, tried: [] };
	const pres = { [RUN]: derived({ listening: false, doors: 0 }) };
	check('F2c. the addressee itself claims, live or not', P.addresseeStandDown(e, RUN, pres, NOW, W) === false);
	check('F2c. an errand with no addressee: the nomination decides',
		P.addresseeStandDown({ turnId: 't3', to: '' }, GIL, pres, NOW, W) === null);
	check('F2c. a runner that handed it back no longer holds it',
		P.addresseeStandDown(Object.assign({}, e, { tried: [RUN] }), GIL, pres, NOW, W) === null);
}
console.log('\nhtid_addressee: ' + checks + ' checks, ' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
