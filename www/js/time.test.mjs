/* ============================================================
   Test — www/js/time.js, the tile header's Holocene local time.
   ------------------------------------------------------------
   The owner, 2026-09-15: local datetime on every chat transcript tile
   header, `12026-09-15 13:12`, Holocene year (Gregorian + 10000),
   local zone, minutes, no seconds. Pure functions, no DOM, so this
   drives the module directly rather than through a sandboxed page.

   Every check is pinned to a KNOWN LOCAL WALL-CLOCK reading rather than
   to an epoch-ms literal, because the whole point of these functions is
   what the epoch reads as in the zone the test itself is running under
   -- an epoch pinned in the source would only prove the arithmetic for
   whatever zone happened to write it. `epoch(y, m, d, h, mi)` builds an
   epoch for a LOCAL reading the same way `new Date(y, m-1, d, h, mi)`
   does, so the round trip is tautological only in the sense that both
   halves are honest about being local.

     node www/js/time.test.mjs
     node --test www/js/*.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// The module is a browser IIFE that hangs itself on `window`; the pattern
// ignore.test.mjs established is what gives it one.
const win = {};
new Function('window', 'with (window) {\n' + readFileSync(join(HERE, 'time.js'), 'utf8') + '\n}')(win);
const T = win.DaimondTime;

check('the module publishes itself',
	!!T && typeof T.fmtHolocene === 'function' && typeof T.fmtHoloceneShort === 'function'
	&& typeof T.fmtHoloceneFull === 'function');

/// An epoch-ms instant for the LOCAL wall-clock reading (y, m, d, h, mi) --
/// the test's own zone, whatever it is, the same zone `fmtHolocene` reads
/// through the Date object's local getters.
function epoch(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi, 0, 0).getTime(); }

console.log('\n— the ordinary case —');
{
	const ts = epoch(2026, 9, 15, 13, 12);
	check('the Gregorian year is offset by ten thousand',
		T.fmtHolocene(ts) === '12026-09-15 13:12', T.fmtHolocene(ts));
	check('and the short form keeps only the last two digits of it',
		T.fmtHoloceneShort(ts) === '26-09-15 13:12', T.fmtHoloceneShort(ts));
}

console.log('\n— zero-padding, single-digit month/day/hour/minute —');
{
	const ts = epoch(2026, 1, 5, 9, 3);
	check('every field pads to its width',
		T.fmtHolocene(ts) === '12026-01-05 09:03', T.fmtHolocene(ts));
}

console.log('\n— midnight and noon —');
{
	check('midnight is 00:00, not 24:00 or 12:00',
		T.fmtHolocene(epoch(2026, 3, 1, 0, 0)) === '12026-03-01 00:00');
	check('noon is 12:00',
		T.fmtHolocene(epoch(2026, 3, 1, 12, 0)) === '12026-03-01 12:00');
}

console.log('\n— a year boundary, both reckonings —');
{
	check('the last minute of a Gregorian year lands on 12026, not 12027',
		T.fmtHolocene(epoch(2026, 12, 31, 23, 59)) === '12026-12-31 23:59');
	check('the first minute of the next Gregorian year lands on 12027',
		T.fmtHolocene(epoch(2027, 1, 1, 0, 0)) === '12027-01-01 00:00');
}

console.log('\n— no seconds on the tile, ever —');
{
	// A ts carrying a live seconds/ms component must not leak into the string --
	// only date-and-minute is drawn on the tile itself.
	const withSeconds = new Date(2026, 8, 15, 13, 12, 47, 500).getTime();
	check('seconds and milliseconds are truncated away',
		T.fmtHolocene(withSeconds) === '12026-09-15 13:12', T.fmtHolocene(withSeconds));
}

console.log('\n— a tile with no timestamp shows nothing —');
{
	check('undefined answers the empty string', T.fmtHolocene(undefined) === '');
	check('null answers the empty string', T.fmtHolocene(null) === '');
	check('NaN answers the empty string', T.fmtHolocene(NaN) === '');
	check('a non-numeric value answers the empty string', T.fmtHolocene('not a timestamp') === '');
	check('the short form is equally blank', T.fmtHoloceneShort(undefined) === '');
	check('the full form is equally blank', T.fmtHoloceneFull(undefined) === '');
}

console.log('\n— the full hover form: seconds and an explicit zone offset —');
{
	const ts = epoch(2026, 9, 15, 13, 12) + 47000;		// + 47 seconds
	const full = T.fmtHoloceneFull(ts);
	check('it carries the Holocene date, THHmmss and a signed zone',
		/^12026-09-15T13:12:47[Z]|^12026-09-15T13:12:47[+-]\d\d:\d\d$/.test(full), full);
	// The offset this process is actually running under, read the same way the
	// module reads it, so the check holds in whatever zone the suite runs in.
	const d = new Date(ts);
	const offMin = -d.getTimezoneOffset();
	const wantZone = offMin === 0 ? 'Z'
		: (offMin < 0 ? '-' : '+')
			+ String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0') + ':'
			+ String(Math.abs(offMin) % 60).padStart(2, '0');
	check('and the offset is this process\u2019s own zone, not a hard-coded one',
		full === '12026-09-15T13:12:47' + wantZone, full + ' vs expected zone ' + wantZone);
}

console.log('\n— the short form\u2019s year matches the full year\u2019s last two digits at a rollover —');
{
	// 2099 -> Holocene 12099 -> short "99"; 2100 -> 12100 -> short "00". Proves
	// the short form is not simply "the last two characters of the string",
	// which would break the moment the Holocene year gains a sixth digit.
	check('year 2099 shortens to 99', T.fmtHoloceneShort(epoch(2099, 6, 1, 0, 0)).startsWith('99-'));
	check('year 2100 shortens to 00', T.fmtHoloceneShort(epoch(2100, 6, 1, 0, 0)).startsWith('00-'));
}

console.log(`\n${checks - failures} ok, ${failures} failed`);
if (failures) process.exit(1);
