/* ============================================================
   Test -- the parcel `collectSync` measures is the parcel it sends (DOORBUDGET, 24 Oct 2026).
   ------------------------------------------------------------
   `syncParcelBase` builds the sync parcel once, inline sections empty, so the room the
   door leaves for them is measured from the very sections that travel. Its first cut
   carried `chunked: chunked` out of `collectSync`'s body, a local it no longer had, so
   every collect threw "chunked is not defined" and no device synced (arms run 135025).

   WHAT IS CHECKED, on a window with no chunk store, no sync engine and a bare store:
     A. it builds at all, quiet and not, with every inline section empty;
     B. `quiet` leaves out the two sections that act when read (the roster saves, the
        debug flag decides), and not-quiet reads them;
     C. the chunk index it measures is the store's own, when there is a store;
     D. `syncInlineRoom` is the door's room less that parcel's JSON-UTF-8 weight, less
        `SYNC_DOOR_RESERVE`.

     node www/js/parcelbase.test.mjs            # ALL PASS
   ============================================================ */
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';

let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}

/// The parcel's builders over `win`, every store reader stubbed to an empty answer.
function lift(win, seen) {
	return loadPage({ window: win, want: ['syncParcelBase', 'syncInlineRoom', 'jsonBytes', 'SYNC_DOOR_RESERVE'], stub: {
		loadTombs:          () => ({}),
		loadMsgTombs:       () => ({}),
		fileTombs:          () => ({}),
		indexWhole:         () => false,
		loadDiamondTombs:   () => ({}),
		mergeLedgers:       () => [],
		collectDevices:     () => { seen.devices++; return { d1: { name: 'é' } }; },
		loadTombMap:        () => ({}),
		nominationSnapshot: () => null,
	} });
}

function world(extra) {
	const win = makeWindow({ now: 1_000_000_000 });
	win.DaimondLedger = { entries: () => [] };
	win.DEBUG_SHARE   = { syncSnapshot: () => { seen.debug++; return { on: true, at: 1 }; } };
	Object.assign(win, extra || {});
	const seen = { devices: 0, debug: 0 };
	return { win, seen, fns: lift(win, seen) };
}

console.log('A. it builds on a bare store, quiet and not');
{
	const { fns, seen } = world();
	let b = null, err = '';
	try { b = fns.syncParcelBase({ 'DAIMOND.md': { s: 'x', at: 1 } }, true); } catch (e) { err = String(e); }
	check('A. quiet: no throw', !!b, err);
	let n = null; err = '';
	try { n = fns.syncParcelBase({}, false); } catch (e) { err = String(e); }
	check('A. not quiet: no throw', !!n, err);
	check('A. the inline sections are empty and say they are not complete', !!b
		&& Array.isArray(b.chats) && !b.chats.length && Array.isArray(b.diamonds) && !b.diamonds.length
		&& b.files && !Object.keys(b.files).length && b.filesComplete === false && b.diamondsComplete === false,
		b && JSON.stringify({ c: b.chats, f: b.files, d: b.diamonds }));
	check('A. and the own files are the ones handed in', !!b && b.own && b.own['DAIMOND.md'].s === 'x');
	check('A. with no chunk store the index is empty, not absent', !!b && b.chunked && !Object.keys(b.chunked).length,
		b && JSON.stringify(b.chunked));
	console.log('B. quiet leaves out what acts when read');
	check('B. quiet: no roster, no debug flag, and neither was read', !!b && b.devices === null && b.debugShare === null
		&& seen.devices === 1 && seen.debug === 1, JSON.stringify(seen));
	check('B. not quiet: both carried', !!n && n.devices && n.devices.d1 && n.debugShare && n.debugShare.on === true);
}

console.log('C. the index measured is the store\'s');
{
	const ix = { 'notes/a.md': { v: 1, size: 9, chunks: [{ addr: 'k1', size: 9 }] } };
	const { fns } = world({ DaimondCloud: { index: () => ix, tombs: () => ({}) } });
	const b = fns.syncParcelBase({}, true);
	check('C. chunked is the chunk index', JSON.stringify(b.chunked) === JSON.stringify(ix), JSON.stringify(b.chunked));
}

console.log('D. the inline room is the door\'s less the parcel\'s weight and the reserve');
{
	const ROOM = 6_000_000;
	const { fns } = world({ DaimondSync: { parcelRoom: () => ROOM, foreignAt: () => 0, oldAt: () => -1 } });
	const weight = fns.jsonBytes(JSON.stringify(fns.syncParcelBase(null, true)));
	const got = fns.syncInlineRoom();
	check('D. room = door - parcel - reserve', got === ROOM - weight - fns.SYNC_DOOR_RESERVE,
		got + ' vs ' + (ROOM - weight - fns.SYNC_DOOR_RESERVE));
}

console.log(failures ? '\nFAILED ' + failures : '\nALL PASS');
process.exit(failures ? 1 : 0);
