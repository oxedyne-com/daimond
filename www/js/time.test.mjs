/* ============================================================
   Test — www/js/time.js, the date and time every surface draws.
   ------------------------------------------------------------
   The owner, 2026-09-15: local datetime on every chat transcript tile
   header, `12026-09-15 13:12`, Holocene year (Gregorian + 10000), local
   zone. 2026-10-06 (D-20261006-34, D-20261006-30b): the person CHOOSES
   the calendar, Holocene or Common Era; a new account starts on Common
   Era, an account that was already in use stays on Holocene, and the
   choice is an account fact that rides sync and reaches every Diamond
   page through the frame's own `DaimondTime`.

   Every check is pinned to a KNOWN LOCAL WALL-CLOCK reading rather than
   to an epoch-ms literal, because the whole point of these functions is
   what the epoch reads as in the zone the test itself is running under.

     node www/js/time.test.mjs
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

/// A fresh page: its own localStorage (seeded with `seed`), store.js and stamp.js as
/// index.html loads them ahead of time.js, then time.js. Returns the window.
function boot(seed, events) {
	const data = new Map(Object.entries(seed || {}));
	const localStorage = {
		getItem: (k) => (data.has(k) ? data.get(k) : null),
		setItem: (k, v) => { data.set(k, String(v)); },
		removeItem: (k) => { data.delete(k); },
	};
	const win = { localStorage, _data: data,
		dispatchEvent: (e) => { if (events) events.push(e.type); return true; } };
	const CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
	for (const f of ['store.js', 'stamp.js', 'time.js']) {
		new Function('window', 'localStorage', 'setTimeout', 'clearTimeout', 'CustomEvent',
			readFileSync(join(HERE, f), 'utf8'))(win, localStorage, setTimeout, clearTimeout, CustomEvent);
	}
	return win;
}

const API = ['fmt', 'fmtShort', 'fmtFull', 'fmtDate', 'fmtIso', 'year', 'calendar', 'setCalendar',
	'syncSnapshot', 'adoptSync', 'frameTag'];
const win = boot({});
const T = win.DaimondTime || {};
const missing = API.filter((k) => typeof T[k] !== 'function');
check('the module publishes ' + API.join(', '), !missing.length, missing.length ? 'missing ' + missing.join(', ') : '');
if (missing.length) { console.log(`\n${checks - failures} ok, ${failures} failed`); process.exit(1); }

console.log('\n— a new account starts on the Common Era —');
{
	const ts = new Date(2026, 8, 15, 13, 12, 47).getTime();
	check('no record and no earlier use: Common Era', T.calendar() === 'ce', T.calendar());
	check('the year is the Gregorian one', T.fmt(ts) === '2026-09-15 13:12:47', T.fmt(ts));
	check('the full form too', T.fmtFull(ts).startsWith('2026-09-15T13:12:47'), T.fmtFull(ts));
	check('the date alone', T.fmtDate(ts) === '2026-09-15', T.fmtDate(ts));
	check('a stored ISO instant reads as its LOCAL date', T.fmtDate(new Date(2026, 8, 15, 23, 30).toISOString()) === '2026-09-15');
	check('a bare day stays that day, never shifted by UTC', T.fmtDate('2026-09-15') === '2026-09-15', T.fmtDate('2026-09-15'));
	check('year(d) is the Gregorian year', T.year(new Date(2026, 0, 1)) === 2026);
	check('a fresh account has nothing to say to sync', T.syncSnapshot() === null, JSON.stringify(T.syncSnapshot()));
	check('nothing that is not a date draws as one', T.fmtDate('soon') === '' && T.fmtDate(undefined) === '' && T.fmt('x') === '');
}

console.log('\n— an account already in use stays on Holocene —');
{
	const used = boot({ 'daimond-id-pub': 'AAAA' });
	const U = used.DaimondTime;
	check('a device that already held an identity reads Holocene', U.calendar() === 'he', U.calendar());
	const snap = U.syncSnapshot();
	check('and says so to sync at the lowest stamp, so any explicit choice wins', !!snap && snap.cal === 'he' && snap.at === 1, JSON.stringify(snap));
	const again = boot(Object.fromEntries(used._data));
	check('the migration is once: a later load keeps the record as it is', again.DaimondTime.syncSnapshot().at === 1);
	const fresh = boot({ 'daimond-cal-checked': '1', 'daimond-id-pub': 'AAAA' });
	check('an account checked before (that chose nothing) is not migrated after the fact', fresh.DaimondTime.calendar() === 'ce');
	U.adoptSync({ cal: 'ce', at: 5 });
	check('a later Common Era choice from another device beats the migration', U.calendar() === 'ce', U.calendar());
	const late = boot({ 'daimond-id-pub': 'AAAA' });
	late.DaimondTime.adoptSync({ cal: 'ce', at: 5 });
	check('and a late-migrating device cannot take it back', late.DaimondTime.calendar() === 'ce');
}

console.log('\n— choosing, and sync —');
{
	const ev = [];
	const w = boot({}, ev);
	const D = w.DaimondTime;
	D.setCalendar('he');
	const ts = new Date(2026, 8, 15, 13, 12, 47).getTime();
	check('the choice takes at once', D.calendar() === 'he' && D.fmt(ts) === '12026-09-15 13:12:47', D.fmt(ts));
	check('the date alone follows it', D.fmtDate(ts) === '12026-09-15', D.fmtDate(ts));
	check('the page is told the calendar moved', ev.includes('daimond:calendar'), ev.join(','));
	const s = D.syncSnapshot();
	check('the choice rides sync as {cal, at}', !!s && s.cal === 'he' && s.at > 1, JSON.stringify(s));
	D.adoptSync({ cal: 'ce', at: s.at - 1 });
	check('an older choice from another device is ignored', D.calendar() === 'he');
	D.adoptSync({ cal: 'ce', at: s.at + 1 });
	check('a fresher one is adopted', D.calendar() === 'ce');
	const n = ev.length;
	D.adoptSync({ cal: 'ce', at: s.at + 1 });
	check('re-adopting what is held moves nothing and tells nobody', ev.length === n && D.syncSnapshot().at === s.at + 1);
	D.adoptSync({ cal: 'julian', at: s.at + 9 });
	check('a calendar this build does not know is refused', D.calendar() === 'ce');
	D.setCalendar('nonsense');
	check('setCalendar takes only he or ce', D.calendar() === 'ce');
}

console.log('\n— the frame gets the same clock, fixed to the account\u2019s calendar —');
{
	const w = boot({});
	w.DaimondTime.setCalendar('he');
	const tag = w.DaimondTime.frameTag();
	const m = /^<script>([\s\S]*)<\/script>$/.exec(tag);
	check('frameTag is one inline script', !!m && !/<\/script/i.test(m[1]), tag.slice(0, 60));
	const fw = {};
	new Function('window', m ? m[1] : '')(fw);
	const F = fw.DaimondTime || {};
	const ts = new Date(2026, 8, 15, 13, 12, 47).getTime();
	check('a page reads the calendar', F.calendar && F.calendar() === 'he');
	check('and formats with it', F.fmtDate && F.fmtDate(ts) === '12026-09-15' && F.fmt(ts) === '12026-09-15 13:12:47');
	check('year(d) in the frame', F.year && F.year(new Date(2026, 0, 1)) === 12026);
	check('a page cannot change the account\u2019s choice', typeof F.setCalendar !== 'function');
}

console.log('\n\u2014 an ISO value from a crystal is shown on the account\u2019s calendar (#2) \u2014');
{
	// The crystal contract: crystal.json STORES a date or time as ISO 8601 and its page
	// DISPLAYS it with DaimondTime.fmtIso, on the calendar the person chose.
	const w = boot({});
	const D = w.DaimondTime;
	const at = new Date(2026, 8, 15, 13, 12, 47).getTime();
	const iso = new Date(at).toISOString();
	for (const cal of ['ce', 'he']) {
		D.setCalendar(cal);
		const y = cal === 'he' ? '12026' : '2026', name = cal === 'he' ? 'Holocene' : 'Common Era';
		const f = typeof D.fmtIso === 'function' ? D.fmtIso : () => null;
		check(`${name}: an ISO instant reads as the local time`, f(iso) === y + '-09-15 13:12:47', f(iso));
		check(`${name}: a local ISO instant with no zone too`, f('2026-09-15T13:12:47') === y + '-09-15 13:12:47', f('2026-09-15T13:12:47'));
		check(`${name}: a calendar date keeps its day`, f('2026-10-09') === y + '-10-09', f('2026-10-09'));
		check(`${name}: epoch milliseconds are accepted too`, f(at) === y + '-09-15 13:12:47', f(at));
		const m = /^<script>([\s\S]*)<\/script>$/.exec(D.frameTag());
		const fw = {};
		new Function('window', m ? m[1] : '')(fw);
		const F = fw.DaimondTime || {};
		check(`${name}: the page frame formats the same instant the same way`, typeof F.fmtIso === 'function' && F.fmtIso(iso) === y + '-09-15 13:12:47');
	}
	const f = typeof D.fmtIso === 'function' ? D.fmtIso : () => null;
	check('text that is not ISO is shown as it was stored, never reinterpreted', f('9 Oct') === '9 Oct' && f('2026-13-45') === '2026-13-45', f('9 Oct'));
	check('nothing shows nothing', f(undefined) === '' && f(null) === '' && f('') === '');
	check('and fmtDate gives no date for a day the calendar does not have', D.fmtDate('2026-02-30') === '' && D.fmtDate('2026-13-01') === '');
	D.setCalendar('ce');
}

console.log('\n— the tile forms under Holocene —');
win.DaimondTime.setCalendar('he');
/// An epoch-ms instant for the LOCAL wall-clock reading (y, m, d, h, mi) --
/// the test's own zone, whatever it is, the same zone `fmt` reads
/// through the Date object's local getters.
function epoch(y, m, d, h, mi) { return new Date(y, m - 1, d, h, mi, 0, 0).getTime(); }

console.log('\n— the ordinary case —');
{
	const ts = epoch(2026, 9, 15, 13, 12);
	check('the Gregorian year is offset by ten thousand',
		T.fmt(ts) === '12026-09-15 13:12:00', T.fmt(ts));
	check('and the short form keeps only the last two digits of it',
		T.fmtShort(ts) === '26-09-15 13:12:00', T.fmtShort(ts));
}

console.log('\n— zero-padding, single-digit month/day/hour/minute —');
{
	const ts = epoch(2026, 1, 5, 9, 3);
	check('every field pads to its width',
		T.fmt(ts) === '12026-01-05 09:03:00', T.fmt(ts));
}

console.log('\n— midnight and noon —');
{
	check('midnight is 00:00:00, not 24:00 or 12:00',
		T.fmt(epoch(2026, 3, 1, 0, 0)) === '12026-03-01 00:00:00');
	check('noon is 12:00:00',
		T.fmt(epoch(2026, 3, 1, 12, 0)) === '12026-03-01 12:00:00');
}

console.log('\n— a year boundary, both reckonings —');
{
	check('the last minute of a Gregorian year lands on 12026, not 12027',
		T.fmt(epoch(2026, 12, 31, 23, 59)) === '12026-12-31 23:59:00');
	check('the first minute of the next Gregorian year lands on 12027',
		T.fmt(epoch(2027, 1, 1, 0, 0)) === '12027-01-01 00:00:00');
}

console.log('\n— seconds on the tile, milliseconds never (owner, 2026-09-29) —');
{
	// The tile reads to the second; a live millisecond component must not leak.
	const withSeconds = new Date(2026, 8, 15, 13, 12, 47, 500).getTime();
	check('seconds are drawn and milliseconds truncated away',
		T.fmt(withSeconds) === '12026-09-15 13:12:47', T.fmt(withSeconds));
	check('and the short form carries the seconds too',
		T.fmtShort(withSeconds) === '26-09-15 13:12:47', T.fmtShort(withSeconds));
}

console.log('\n— a tile with no timestamp shows nothing —');
{
	check('undefined answers the empty string', T.fmt(undefined) === '');
	check('null answers the empty string', T.fmt(null) === '');
	check('NaN answers the empty string', T.fmt(NaN) === '');
	check('a non-numeric value answers the empty string', T.fmt('not a timestamp') === '');
	check('the short form is equally blank', T.fmtShort(undefined) === '');
	check('the full form is equally blank', T.fmtFull(undefined) === '');
}

console.log('\n— the full hover form: seconds and an explicit zone offset —');
{
	const ts = epoch(2026, 9, 15, 13, 12) + 47000;		// + 47 seconds
	const full = T.fmtFull(ts);
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
	check('year 2099 shortens to 99', T.fmtShort(epoch(2099, 6, 1, 0, 0)).startsWith('99-'));
	check('year 2100 shortens to 00', T.fmtShort(epoch(2100, 6, 1, 0, 0)).startsWith('00-'));
}

console.log(`\n${checks - failures} ok, ${failures} failed`);
if (failures) process.exit(1);
