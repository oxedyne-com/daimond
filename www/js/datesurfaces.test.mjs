/* ============================================================
   Test — every date the app draws follows the account's calendar.
   ------------------------------------------------------------
   D-20261006-34: the person reads dates in the calendar they chose,
   Holocene (12026) or Common Era (2026). r544 QA (F-C3) found about ten
   surfaces that formatted their own dates and so printed 2026 whatever
   the choice. The root fix is one formatter, `DaimondTime.fmtLocal`,
   and this test holds both halves of it:

   1. `fmtLocal` itself: the year follows the calendar in every locale,
      and the switch to Common Era and back is followed at once.
   2. The surfaces: each one named below reaches `fmtLocal`, and no file
      in www/js formats a date any other way. A use of the year that is
      not a display (a bucket key, a file name, a mail header) is named
      with its reason, so a new one has to be argued for.

     node www/js/datesurfaces.test.mjs
   ============================================================ */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const HERE = process.env.DATESURF_DIR || dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

function boot(seed, locale) {
	const data = new Map(Object.entries(seed || {}));
	const localStorage = {
		getItem: (k) => (data.has(k) ? data.get(k) : null),
		setItem: (k, v) => { data.set(k, String(v)); },
		removeItem: (k) => { data.delete(k); },
	};
	const win = { localStorage, dispatchEvent: () => true,
		DaimondI18n: { locale: () => win._loc }, _loc: locale || 'en' };
	const CustomEvent = class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } };
	for (const f of ['store.js', 'stamp.js', 'time.js']) {
		new Function('window', 'localStorage', 'setTimeout', 'clearTimeout', 'CustomEvent',
			readFileSync(join(HERE, f), 'utf8'))(win, localStorage, setTimeout, clearTimeout, CustomEvent);
	}
	return win;
}

console.log('\n— the one formatter —');
{
	const win = boot({ 'daimond-calendar': JSON.stringify({ cal: 'he', at: 5 }) });
	const T = win.DaimondTime || {};
	const ok = typeof T.fmtLocal === 'function';
	check('DaimondTime.fmtLocal exists', ok);
	if (ok) {
		const ts = new Date(2026, 9, 9, 15, 4, 0).getTime();
		const he = {};
		for (const loc of ['en', 'de', 'fr', 'ja', 'zh', 'ar', 'th']) {
			win._loc = loc;
			he[loc] = T.fmtLocal(ts, 'day');
			const digits = new Intl.NumberFormat(loc, { useGrouping: false }).format(12026);
			check('Holocene, ' + loc + ': the year is 12026', he[loc].includes(digits) && !/(^|[^0-9])2026([^0-9]|$)/.test(he[loc]), he[loc]);
		}
		win._loc = 'en';
		check('every shape with a year carries 12026',
			['day', 'dayLong', 'weekday', 'whenFull'].every((s) => T.fmtLocal(ts, s).includes('12026')),
			['day', 'dayLong', 'weekday', 'whenFull'].map((s) => T.fmtLocal(ts, s)).join(' | '));
		check('a shape with no year has none to change', !/2026/.test(T.fmtLocal(ts, 'dayMonth') + T.fmtLocal(ts, 'when') + T.fmtLocal(ts, 'clock')));
		check('a bare day is that local day', T.fmtLocal('2026-10-09', 'day') === T.fmtLocal(ts, 'day'), T.fmtLocal('2026-10-09', 'day'));
		check('a mail header parses', T.fmtLocal('Fri, 09 Oct 2026 15:04:00 +0000', 'whenFull').includes('12026'));
		check('nothing readable draws nothing', T.fmtLocal('soon', 'day') === '' && T.fmtLocal(undefined, 'day') === '' && T.fmtLocal('2026-13-45', 'day') === '');
		T.setCalendar('ce');
		const ce = T.fmtLocal(ts, 'day');
		check('switched to Common Era: 2026 at once', /2026/.test(ce) && !/12026/.test(ce), ce);
		T.setCalendar('he');
		check('and back to Holocene', T.fmtLocal(ts, 'day') === he.en, T.fmtLocal(ts, 'day'));
		check('the frame copy has it too', /fmtLocal/.test(T.frameTag()));
	}
}

console.log('\n— the surfaces, each through fmtLocal —');
// [file, what the person sees, the shape it must ask for].
const SURFACES = [
	['daimond.js', 'steering-note dates',        'day'],
	['daimond.js', 'Pro renewal date',           'dayLong'],
	['daimond.js', 'mail message dates',         'whenFull'],
	['daimond.js', 'chat rail, earlier days',    'dayMonth'],
	['daimond.js', 'chat rail, yesterday',       'clock'],
	['mail.js',    'reply quote date',           'weekday'],
	['release.js', 'release notes dates',        'day'],
	['trash.js',   'Trash keep-until date',      'day'],
	['lapse.js',   'Pro lapse dates',            'dayLong'],
	['trust.js',   'key-match dates',            'dayMonthLong'],
	['improve.js', 'proposal dates',             'dayMonth'],
	['tracker.js', 'tracker dates',              'dayMonth'],
	['spend.js',   'ledger row times',           'when'],
	['spend.js',   'ledger graph day labels',    'dayMonth'],
	['models.js',  'credit and list as-of times', 'when'],
];
const src = {};
const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && !f.endsWith('.min.js'));
for (const f of files) src[f] = readFileSync(join(HERE, f), 'utf8');
for (const [f, what, shape] of SURFACES) {
	const re = new RegExp("DaimondTime\\.fmtLocal\\([^;]*'" + shape + "'");
	check(what + ' (' + f + ') through fmtLocal ' + shape, re.test(src[f] || ''));
}

console.log('\n— no other way to format a date —');
const BAN = [
	[/\.toLocaleDateString\(/,  'toLocaleDateString'],
	[/\.toLocaleTimeString\(/,  'toLocaleTimeString'],
	[/\.toDateString\(/,        'toDateString'],
	[/new Intl\.DateTimeFormat\(|Intl\.DateTimeFormat\((?!\)\.resolvedOptions\(\)\.timeZone)/, 'Intl.DateTimeFormat'],
];
for (const f of files) {
	if (f === 'time.js') continue;
	src[f].split('\n').forEach((line, i) => {
		for (const [re, name] of BAN) {
			if (re.test(line)) check(f + ':' + (i + 1) + ' formats a date itself (' + name + ')', false, line.trim().slice(0, 100));
		}
	});
}
// Options can run over several lines, so this one reads the whole file.
for (const f of files) {
	if (f === 'time.js') continue;
	const m = /\.toLocale(?:String)\([^)]*?\{[^}]*?\b(year|month|weekday|day|hour)\s*:/s.exec(src[f]);
	if (m) check(f + ':' + (src[f].slice(0, m.index).split('\n').length) + ' formats a date itself (toLocaleString with date fields)', false);
}
// A year read for something other than display, by file, with the reason.
const YEAR_OK = {
	'release.js':   [2, 'whole-day difference for "3 days ago"'],
	'lapse.js':     [1, 'the term end, date arithmetic'],
	'ledger.js':    [1, 'the graph bucket key'],
	'workspace.js': [1, 'the calendar picker shows both years by design'],
	'mail.js':      [1, 'the RFC 5322 Date header: a wire format, Gregorian by law'],
	'daimond.js':   [2, 'day bucket arithmetic; a new note\'s file name (stored ISO)'],
};
for (const f of files) {
	if (f === 'time.js') continue;
	const n = (src[f].match(/\.getFullYear\(\)/g) || []).length;
	const allow = YEAR_OK[f] ? YEAR_OK[f][0] : 0;
	if (n > allow) check(f + ' reads the year ' + n + ' times, ' + allow + ' argued for', false);
}
check('every file scanned (' + files.length + ')', files.length > 50);

console.log(`\n${checks - failures} ok, ${failures} failed`);
process.exit(failures ? 1 : 0);
