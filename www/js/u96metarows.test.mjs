/* ============================================================
   Test -- History shows every change to a diamond's name or record as its own row (UNBLOCK-96).

   02 Nov 2026 his phone rebuilt Fred Hoogland's lost meta.json as "The Hoogland Family
   Stories" and nothing anywhere said so. The engine now writes each change to the activity
   record (`meta_changes`); History reads it and stands each change where it happened, a row
   of its own, never tied to a file version.
   ============================================================ */
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { readFileSync } from 'node:fs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

let answer = '[]';
const fakeApp = { meta_changes() { return Promise.resolve(answer); } };
const win = makeWindow({ extra: { DaimondCore: { diamondApp: () => fakeApp } } });
loadScript(win, 'versions.js');
const V = win.DaimondVersions;

check('the page reads the record changes', typeof V.metaChanges === 'function' && typeof V.withMeta === 'function');
answer = JSON.stringify([
	{ at: 150, dev: 'phone-1', by: 'rebuild', field: 'name', old: '', new: 'The Hoogland Family Stories' },
	{ at: 250, dev: 'laptop-1', by: 'user', field: 'name', old: 'The Hoogland Family Stories', new: 'Fred Hoogland' },
]);
const ms = await V.metaChanges('d');
check('two changes, newest first', ms.length === 2 && ms[0].at === 250 && ms[1].by === 'rebuild',
	JSON.stringify(ms));
const rows = [{ row: { v: 3, ts: 300 } }, { row: { v: 2, ts: 200 } }, { row: { v: 1, ts: 100 } }];
const out = V.withMeta(rows, ms).map(e => e.meta ? 'M' + e.meta.at : 'v' + e.row.v);
check('each change stands where it happened, not on a version', out.join(',') === 'v3,M250,v2,M150,v1',
	out.join(','));
answer = '[]';
check('no change, no row', (await V.metaChanges('d')).length === 0 && V.withMeta(rows, []).length === 3);

// The panel draws the row, and every locale names it.
const crystal = readFileSync(new URL('./page/crystal.js', import.meta.url), 'utf8');
check('History draws a record-change row', /histMetaRow\(e\.meta\)/.test(crystal));
for (const loc of ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'ko', 'zh-Hans']) {
	const s = readFileSync(new URL('../i18n/' + loc + '.js', import.meta.url), 'utf8');
	const keys = ['meta_renamed_kind', 'meta_kind', 'meta_row', 'meta_none', 'meta_by_user',
		'meta_by_daimon', 'meta_by_sync', 'meta_by_rebuild', 'meta_by_app'];
	check(loc + ' names the row', keys.every(k => s.includes("'versions." + k + "'")));
}

// Daimond's own naming of its built-in diamonds is writer "app", never "rebuild" (UNBLOCK-96).
const diamonds = readFileSync(new URL('./page/diamonds.js', import.meta.url), 'utf8');
check('the built-in naming says writer app', !/_built_in\([^)]*'rebuild'\)/.test(diamonds)
	&& (diamonds.match(/_built_in\([^)]*'app'\)/g) || []).length === 3);
check('History names writer app', /\['user', 'daimon', 'sync', 'rebuild', 'app'\]/.test(crystal));

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all ok');
