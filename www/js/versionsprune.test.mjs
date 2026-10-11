/* ============================================================
   Test -- History says what a prune removed, where it removed it (PRUNE, 10 Oct 2026).

   The prune of 10 Oct removed v9-v15, v18 and v19 of a Diamond and History showed only
   the gap. The engine now keeps a record of every prune (`versions/pruned.json`, read
   through `versions_state().pruned`); the page draws each one as a row where the removed
   versions stood, states the limit under the list, and tells the Lens once per record.
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const rec = { ts: 900, on: 'record', versions: [9, 10, 11, 12, 13, 14, 15, 18, 19], first: 90,
	last: 190, bodies: 4, orphans: 0, bytes: 1234 };
const state = { bytes: 10, cap: 100, manifests: 3, manifests_cap: 200, file_max: 5, pruned: [rec] };
let answer = JSON.stringify(state);
const fakeApp = { versions_list() { return '[]'; }, versions_state() { return answer; } };
const win = makeWindow({ extra: { DaimondCore: { diamondApp: () => fakeApp } } });
loadScript(win, 'versions.js');
const V = win.DaimondVersions;

check('spans: runs collapse, pairs and singles stay', V.versionSpans([9,10,11,12,13,14,15,18,19]) ===
	'v9–v15, v18, v19', V.versionSpans([9,10,11,12,13,14,15,18,19]));
check('spans: a pair is two names', V.versionSpans([3, 4]) === 'v3, v4');
check('spans: one', V.versionSpans([7]) === 'v7');

// Rows newest first; the record's newest removed version was made at 190.
const rows = [{ v: 22, ts: 300 }, { v: 20, ts: 200 }, { v: 17, ts: 170 }, { v: 8, ts: 80 }];
const out = V.withPrunes(rows, [rec]).map(e => e.row ? 'v' + e.row.v : 'P');
check('the prune row stands where its versions stood', out.join(',') === 'v22,v20,P,v17,v8',
	out.join(','));
check('a prune older than every row goes last',
	V.withPrunes([{ v: 50, ts: 5000 }], [rec]).map(e => e.row ? 'r' : 'P').join('') === 'rP');
check('no records, rows unchanged', V.withPrunes(rows, []).length === rows.length);

// The gauge carries the records, sorted and cleaned, and an older engine's answer has none.
const g = await V.gauge('d1');
check('gauge returns the prune records', g.pruned.length === 1 && g.pruned[0].versions.length === 9
	&& g.pruned[0].last === 190, JSON.stringify(g.pruned));
answer = JSON.stringify({ bytes: 1, cap: 2, manifests: 1 });
check('an older engine: no records, no throw', (await V.gauge('d1')).pruned.length === 0);

// A renumbering (D-26 B F2) is its own row: each old number beside its new one, standing
// where it happened, and History words it as a renumbering, never as a prune.
answer = JSON.stringify({ bytes: 1, cap: 2, manifests: 1, pruned: [rec,
	{ ts: 250, on: 'renumber', versions: [16, 14, 15], to: [22, 20, 21], first: 140, last: 160 }] });
const g2 = (await V.gauge('d1')).pruned;
const ren = g2.find(r => r.on === 'renumber');
check('a renumbering keeps old beside new', ren && ren.versions.join() === '14,15,16' && ren.to.join() === '20,21,22',
	JSON.stringify(ren));
check('a prune carries no new numbers', g2.find(r => r.on === 'record').to.length === 0);
const placed = V.withPrunes(rows, g2).map(e => e.row ? 'v' + e.row.v : (e.prune.on === 'renumber' ? 'N' : 'P')).join(',');
check('a renumbering stands where it happened', placed === 'v22,N,v20,P,v17,v8', placed);

// The page: a prune row, a limit line, and the Lens event.
const d = readFileSync(new URL('./daimond.js', import.meta.url), 'utf8');
check('History draws prune rows', /withPrunes\(rows, g0\.pruned/.test(d) && /histPrunedRow\(e\.prune\)/.test(d));
check('History states the limit', /t\('versions\.limit_note'/.test(d) && /histFoot\(g0\)/.test(d));
check('the Lens hears each prune', /dsEvent\('versions\.pruned'/.test(d));
check('History words a renumbering as one', /'versions\.renumbered_kind'/.test(d) && /'versions\.renumbered_row'/.test(d));
const calls = (d.match(/notePrunes\((diamondId|r\.id|f\.id|id|id, g0\.pruned)\)/g) || []).length;
check('notePrunes after a turn, an arrival, a backup restore, a template copy and History', calls === 5, String(calls));

const en = readFileSync(new URL('../i18n/en.js', import.meta.url), 'utf8');
['versions.pruned_kind', 'versions.pruned_row.one', 'versions.pruned_row.other', 'versions.limit_note',
	'versions.renumbered_kind', 'versions.renumbered_row.one', 'versions.renumbered_row.other']
	.forEach(k => check('en carries ' + k, en.includes("'" + k + "'")));

if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('versionsprune: all ok');
