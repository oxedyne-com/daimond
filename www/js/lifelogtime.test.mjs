/* ============================================================
   Test — the Life log template draws its dates on the account's calendar.
   ------------------------------------------------------------
   The owner (D-20261006-34, D-20261006-30b): Life log's dates were wrong on
   his phone. A native `type="date"` or `datetime-local` field draws the
   browser's own Gregorian picker, which no calendar choice can reach, and a
   year the template computes for itself is always the Common Era one. So the
   template takes every year it shows from the frame's `DaimondTime`
   (crystal.js puts it there), keeps ISO in what it stores, and never asks the
   browser to draw a date.

   Run:  node www/js/lifelogtime.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR  = join(HERE, '..', 'capps', 'lifelog');
const page = readFileSync(join(DIR, 'crystal.html'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

check('no native date, time, month or week field anywhere in the template',
	!/type\s*=\s*\\?["']?(date|datetime-local|month|week|time)\b/i.test(page));

/// The template's own function `name`, as text, cut at the first line that closes it.
function fn(name) {
	const at = page.indexOf('function ' + name + '(');
	if (at < 0) return '';
	const one = page.indexOf('\n', at);
	const line = page.slice(at, one);
	if (/\}\s*$/.test(line) && (line.match(/\{/g) || []).length === (line.match(/\}/g) || []).length) return line;
	const end = page.indexOf('\n}', at);
	return end < 0 ? '' : page.slice(at, end + 2);
}

const NEED = ['p2', 'ymd', 'tms', 'dnum', 'dstr', 'blabel', 'yr', 'when'];
const src = NEED.map(fn);
const lost = NEED.filter((n, i) => !src[i]);
check('the template carries its date helpers, yr and when among them', !lost.length, lost.length ? 'missing ' + lost.join(', ') : '');

if (!lost.length) {
	const PRE = "var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];"
		+ "var DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; var IDX = null;";
	const make = (T) => new Function('window', PRE + src.join('\n') + '\nreturn { blabel: blabel, when: when, yr: yr };')(T ? { DaimondTime: T } : {});
	const at = '2026-10-09T13:12:47+10:00';
	const he = { calendar: () => 'he', year: (d) => d.getFullYear() + 10000, fmt: () => 'HE-FMT' };
	const ce = { calendar: () => 'ce', year: (d) => d.getFullYear(), fmt: () => 'CE-FMT' };
	check('a month heading takes its year from DaimondTime (Holocene)', make(he).blabel('2026-10-01', 'month') === 'Oct 12026', make(he).blabel('2026-10-01', 'month'));
	check('and (Common Era)', make(ce).blabel('2026-10-01', 'month') === 'Oct 2026', make(ce).blabel('2026-10-01', 'month'));
	check('"recorded at" is drawn by DaimondTime, not the stored ISO', make(he).when(at) === 'HE-FMT', make(he).when(at));
	check('a frame without DaimondTime still draws a date', make(null).blabel('2026-10-01', 'month') === 'Oct 2026' && make(null).when(at) === at);
}

const ver = JSON.parse(readFileSync(join(DIR, 'capp.json'), 'utf8')).v;
check('the template version moved past 3, so an existing Life log takes the fix', ver > 3, 'v ' + ver);

console.log(`\n${checks - failures} ok, ${failures} failed`);
if (failures) process.exit(1);
