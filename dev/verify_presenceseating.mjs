/* ============================================================
   verify_presenceseating.mjs — PRESENT-DERIVED hand-off seating
   (owner redesign, Phase A, 2026-09-09).
   ------------------------------------------------------------
   The proven live bug: routing resolved its target from the STORED,
   add-only device list (ghost re-mint ids, ZERO overlap with the live
   presence set), so the "worker" star pointed at a dead id, the election
   returned generic, and a turn ran LOCALLY on the phone though a fresh
   live desktop (argonaut) was right there.

   This drives the REAL www/js/peer.js `handoffTarget` / `autoDispatchDecision`
   in pure node (both are pure over their inputs -- no DOM, no crypto, no
   gateway) and asserts the owner's binding fallback chain and its meaning:

     (a) a live preferred worker (argonaut) is SEATED on argonaut;
     (b) argonaut ABSENT, gilgamesh (live, non-mobile) present -> seats
         GILGAMESH -- the exact gap the owner hit, never a fall to local;
     (c) only mobile-view devices live -> LOCAL (last resort);
     (d) a stored list full of GHOST ids with the real devices only in
         presence -> routing ignores the ghosts and seats the live desktop,
         resolved by the star's LABEL (never the dead id);
     (e) a seated desktop that never claims (exclude it) -> the NEXT live
         desktop is resolved, NOT immediate local; exclude both -> local;
     plus: a mobile-view device is never seated even as the preferred worker,
     and a serviced-stale phantom desktop is never seated over local (seq 217).

   Case (f) -- a background device repaints a chat synced while hidden -- is a
   DOM behaviour and is proven by dev/verify_rosterreseat.mjs (c); it is a
   KEEP from acd46f and is untouched here.

   Run:  node dev/verify_presenceseating.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// Load the REAL peer.js as the classic IIFE it is, resolving its bare sibling
// references against a fresh `window` via `with` (the same construct peer.test.mjs
// uses). handoffTarget/autoDispatchDecision are pure, so no other app script is needed.
function loadPeer() {
	const win = {};
	win.addEventListener = () => {};
	const body = readFileSync(join(HERE, '..', 'www', 'js', 'peer.js'), 'utf8');
	const fn = new Function(
		'window', 'crypto', 'console', 'TextEncoder', 'TextDecoder',
		'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'with (window) {\n' + body + '\n}');
	fn(win, webcrypto, console, TextEncoder, TextDecoder,
		setTimeout, clearTimeout, setInterval, clearInterval);
	return win.DaimondPeer;
}

try {
	const P = loadPeer();
	if (!P || !P.handoffTarget || !P.autoDispatchDecision) throw new Error('peer.js did not expose the routing surface');
	const W   = P.DISPATCH_FRESH_MS;
	const now = Date.now();
	const IOS = 'i0000000000000000';		// the phone (the dispatcher)
	const ARG = 'a0000000000000000';		// argonaut, a desktop
	const GIL = 'g0000000000000000';		// gilgamesh, a desktop
	const GHOST1 = 'dead111111111111', GHOST2 = 'dead222222222222';

	// A live, servicing, non-mobile desktop beat.
	const desk = (name, ageMs, extra) => Object.assign(
		{ name, lastSeen: now - (ageMs || 0), servicedAt: now - (ageMs || 0), attended: false, mobileView: false }, extra || {});
	// A live mobile-view beat (a phone in the foreground).
	const phone = (name, ageMs) => ({ name, lastSeen: now - (ageMs || 0), servicedAt: now - (ageMs || 0), attended: true, mobileView: true });

	const decide = (presence, opts) => P.autoDispatchDecision({}, presence,
		Object.assign({ selfId: IOS, isPhone: true, freshWindowMs: W }, opts || {}), now);

	// ── (a) A LIVE PREFERRED WORKER IS SEATED ───────────────────────────────────
	{
		const pres = {}; pres[IOS] = phone('iPhone', 1000); pres[ARG] = desk('argonaut', 2000); pres[GIL] = desk('gilgamesh', 500);
		// By raw nominated id (argonaut live) -> reason nominee, peer argonaut.
		const byId = P.handoffTarget(pres, { selfId: IOS, windowMs: W, nominatedId: ARG }, now);
		check('(a) live nominated worker is seated by id (reason nominee, argonaut)',
			byId.reason === 'nominee' && byId.target && byId.target.deviceId === ARG,
			'reason=' + byId.reason + ' peer=' + (byId.target && byId.target.deviceId));
		// By label (the star as a label) even though gilgamesh beats fresher -> still argonaut.
		const byLabel = P.handoffTarget(pres, { selfId: IOS, windowMs: W, preferredLabel: 'argonaut' }, now);
		check('(a) the star resolved as a LABEL seats argonaut, not the fresher gilgamesh (no lottery)',
			byLabel.reason === 'worker' && byLabel.target && byLabel.target.deviceId === ARG,
			'reason=' + byLabel.reason + ' peer=' + (byLabel.target && byLabel.target.deviceId));
		const d = decide(pres, { nominatedId: ARG });
		check('(a) the election DISPATCHES to argonaut (the worker takes every turn)',
			d.dispatch === true && d.reason === 'nominee' && d.peer && d.peer.deviceId === ARG,
			'reason=' + d.reason + ' peer=' + (d.peer && d.peer.deviceId));
	}

	// ── (b) WORKER ABSENT, ANOTHER LIVE DESKTOP PRESENT -> SEAT IT ───────────────
	{
		// The owner's exact gap: argonaut (the star) is NOT beating; gilgamesh is live and
		// non-mobile. The turn must go to gilgamesh, never fall to local on the phone.
		const pres = {}; pres[IOS] = phone('iPhone', 1000); pres[GIL] = desk('gilgamesh', 1500);
		const res = P.handoffTarget(pres, { selfId: IOS, windowMs: W, nominatedId: ARG, preferredLabel: 'argonaut' }, now);
		check('(b) worker absent -> the OTHER live non-mobile desktop (gilgamesh) is seated',
			res.reason === 'other-desktop' && res.target && res.target.deviceId === GIL,
			'reason=' + res.reason + ' peer=' + (res.target && res.target.deviceId));
		const d = decide(pres, { nominatedId: ARG, preferredLabel: 'argonaut' });
		check('(b) the election DISPATCHES to gilgamesh -- it does NOT run local while a desktop is live',
			d.dispatch === true && d.peer && d.peer.deviceId === GIL,
			'reason=' + d.reason + ' peer=' + (d.peer && d.peer.deviceId));
	}

	// ── (c) ONLY MOBILE-VIEW DEVICES LIVE -> LOCAL ──────────────────────────────
	{
		// A second phone is beating (foreground), but a mobile-view device is never seated
		// as another device's worker, so the only resort is local on this phone.
		const pres = {}; pres[IOS] = phone('iPhone', 1000); pres['p2222222222222222'] = phone('iPad', 800);
		const res = P.handoffTarget(pres, { selfId: IOS, windowMs: W, preferredLabel: 'iPad' }, now);
		check('(c) only mobile-view devices live -> target is null (run local)',
			res.reason === 'local' && res.target === null, 'reason=' + res.reason);
		const d = decide(pres, {});
		check('(c) the election does NOT dispatch -- the phone runs local (last resort)',
			d.dispatch === false, 'reason=' + d.reason);
	}

	// ── (d) GHOST STORED IDS ARE IGNORED; THE LIVE DESKTOP IS SEATED BY LABEL ────
	{
		// The stored list (as it would be passed as a raw nominated id) is a dead ghost.
		// Presence holds the REAL devices only. Routing must ignore the ghost id entirely
		// and seat the live device carrying the worker's label.
		const pres = {}; pres[IOS] = phone('iPhone', 1000); pres[ARG] = desk('argonaut', 1200); pres[GIL] = desk('gilgamesh', 400);
		const res = P.handoffTarget(pres, { selfId: IOS, windowMs: W, nominatedId: GHOST1, preferredLabel: 'argonaut' }, now);
		check('(d) a ghost nominated id is ignored (never seated) and the LIVE argonaut is seated by label',
			res.reason === 'worker' && res.target && res.target.deviceId === ARG,
			'reason=' + res.reason + ' peer=' + (res.target && res.target.deviceId));
		check('(d) the seated device is one that is actually BEATING (present in the live set)',
			res.target && !!pres[res.target.deviceId], 'peer=' + (res.target && res.target.deviceId));
		// And a ghost id NOT resolvable to any live label falls to the generic desktop, never local.
		const res2 = P.handoffTarget(pres, { selfId: IOS, windowMs: W, nominatedId: GHOST2, preferredLabel: 'a-machine-that-is-gone' }, now);
		check('(d) an unresolvable ghost star still seats a live desktop, not local',
			res2.target && !!pres[res2.target.deviceId] && res2.reason === 'other-desktop',
			'reason=' + res2.reason + ' peer=' + (res2.target && res2.target.deviceId));
	}

	// ── (e) A SEATED DESKTOP THAT NEVER CLAIMS -> RETRY THE NEXT DESKTOP ─────────
	{
		// Two live desktops. Seat argonaut; it never claims. Excluding it must resolve to
		// gilgamesh (the retry), NOT to local. Excluding BOTH must then fall to local.
		const pres = {}; pres[IOS] = phone('iPhone', 1000); pres[ARG] = desk('argonaut', 300); pres[GIL] = desk('gilgamesh', 1500);
		const first = P.handoffTarget(pres, { selfId: IOS, windowMs: W }, now);
		check('(e) first seat is a live desktop (argonaut, the freshest)',
			first.target && first.target.deviceId === ARG, 'peer=' + (first.target && first.target.deviceId));
		const retry = P.handoffTarget(pres, { selfId: IOS, windowMs: W, exclude: { [ARG]: true } }, now);
		check('(e) excluding the non-claiming desktop resolves the NEXT desktop (gilgamesh), NOT local',
			retry.target && retry.target.deviceId === GIL && retry.reason !== 'local',
			'reason=' + retry.reason + ' peer=' + (retry.target && retry.target.deviceId));
		const exhausted = P.handoffTarget(pres, { selfId: IOS, windowMs: W, exclude: { [ARG]: true, [GIL]: true } }, now);
		check('(e) only when every live desktop has been tried does it fall to local',
			exhausted.reason === 'local' && exhausted.target === null, 'reason=' + exhausted.reason);
	}

	// ── EXTRA: a mobile-view device is never the worker, even when nominated ──────
	{
		const pres = {}; pres[IOS] = phone('iPhone', 1000); pres['m3333333333333333'] = phone('Pixel', 500); pres[ARG] = desk('argonaut', 1500);
		// Nominate the mobile Pixel: it must NOT be seated; routing falls to the desktop.
		const res = P.handoffTarget(pres, { selfId: IOS, windowMs: W, nominatedId: 'm3333333333333333', preferredLabel: 'Pixel' }, now);
		check('EXTRA: a nominated MOBILE device is never seated -- routing falls to the live desktop',
			res.target && res.target.deviceId === ARG && res.reason === 'other-desktop',
			'reason=' + res.reason + ' peer=' + (res.target && res.target.deviceId));
	}

	// ── EXTRA: seq-217 -- a serviced-stale phantom desktop is not seated over local ──
	{
		// A desktop that BEATS but stopped servicing (serviced_at aged out): recGenuine
		// excludes it, so with no other candidate the phone runs local rather than seat a
		// tab that will never collect the errand.
		const pres = {}; pres[IOS] = phone('iPhone', 1000);
		pres['ph444444444444444'] = { name: 'ghost-tab', lastSeen: now - 1000, servicedAt: now - (W + 30000), attended: false, mobileView: false };
		const res = P.handoffTarget(pres, { selfId: IOS, windowMs: W }, now);
		check('EXTRA (seq 217): a beating-but-serviced-stale phantom desktop is NOT seated -> local',
			res.reason === 'local' && res.target === null, 'reason=' + res.reason);
	}
} catch (e) {
	check('the run finished without throwing', false, String((e && e.stack) || e));
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exit(bad.length ? 1 : 0);
