/* ============================================================
   Test -- a note the engine writes on a version reads as a sentence in every locale
   (HIST-NOTE-CASE-b).

   History showed the engine's own stored words, "kept before sync — a local edit the merge
   replaced", "restore v3", "file_revert notes.md": lower case where a sentence starts and
   English in every locale. The stored notes stay as they are (the heal still matches them),
   and the page names each in the reader's language. A note the person or the daimon wrote is
   theirs and is shown as written.
   ============================================================ */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const marks = src('./page/marks.js');

// The engine's words, as it writes them: the arm goes red if one changes and the page does not.
const pagelog = src('../../src/diamond_pagelog.rs');
const store = src('../../src/store/diamond.rs');
const dispatch = src('../../src/tools/dispatch.rs');
check('engine: KEPT_NOTE', pagelog.includes('const KEPT_NOTE: &str = "kept before sync";'));
check('engine: HEAL_NOTE', pagelog.includes('pub const HEAL_NOTE: &str = "rows an earlier sync dropped, put back";'));
check('engine: the kept note', store.includes('"kept before sync — a local edit the merge replaced"'));
check('engine: both kept', store.includes('"rows from both devices kept"'));
check('engine: restore, undo', store.includes('fmt!("restore v{}", n)') && store.includes('fmt!("undo v{}", n)'));
check('engine: before', store.includes('fmt!("before {}", plan.note())'));
check('engine: file_revert', dispatch.includes('fmt!("file_revert {}", raw)'));

// What History draws as a version's note: `histNote` where the page has it, else the stored
// note itself, as the base drew it.
const row = marks.slice(marks.indexOf('export function histRow('));
const at = marks.indexOf('function histNote(');
const end = marks.indexOf('\n}\n', at);
const drawn = at >= 0 && end > at;
check('History draws a version\'s note through histNote',
	drawn && row.includes('note.textContent = histNote(r);'));
if (!drawn) check('base: History draws the stored note', row.includes('note.textContent = r.note;'));

const ENGINE = [
	{ cause: 'restore', note: 'kept before sync — a local edit the merge replaced', keeps: [] },
	{ cause: 'restore', note: 'kept before sync', keeps: [] },                // an older stored note
	{ cause: 'restore', note: 'rows an earlier sync dropped, put back', keeps: [] },
	{ cause: 'share',   note: 'rows from both devices kept', keeps: [] },
	{ cause: 'restore', note: 'restore v3', keeps: ['3'] },
	{ cause: 'restore', note: 'undo v15', keeps: ['15'] },
	{ cause: 'restore', note: 'before restore v3', keeps: ['3'] },
	{ cause: 'restore', note: 'before undo v15', keeps: ['15'] },
	{ kind: 'restore',  note: 'restore v7', keeps: ['7'] },                    // a log record's row
	{ cause: 'restore', note: 'file_revert notes/plan.md', keeps: ['notes/plan.md'] },
];
const THEIRS = [
	{ cause: 'turn', note: 'undo v5' },
	{ cause: 'save', note: 'kept before sync, by hand' },
	{ cause: 'fold', note: 'folded the week' },
];

for (const loc of ['en', 'de', 'fr', 'es', 'pt-BR', 'ja', 'ko', 'zh-Hans']) {
	let table = {};
	const win = { DaimondI18n: { register(code, tb) { table = tb; } } };
	vm.runInNewContext(src('../i18n/' + loc + '.js'), { window: win });
	const t = (k, v) => {
		const s = Object.prototype.hasOwnProperty.call(table, k) ? table[k] : k;
		return v ? s.replace(/\{(\w+)\}/g, (w, n) => (n in v ? String(v[n]) : w)) : s;
	};
	const ctx = { t };
	if (drawn) vm.runInNewContext(marks.slice(at, end + 2), ctx);
	const show = drawn ? ctx.histNote : (r) => r.note;
	for (const r of ENGINE) {
		const s = show(r);
		check(loc + ' "' + r.note + '" starts with a capital', !/^\p{Ll}/u.test(s), s);
		check(loc + ' "' + r.note + '" is named, not the stored words',
			s !== r.note && !s.includes('versions.') && !/before sync|file_revert|both devices/.test(loc === 'en' ? '' : s), s);
		for (const k of r.keeps) check(loc + ' "' + r.note + '" keeps ' + k, s.includes(k), s);
	}
	for (const r of THEIRS) check(loc + ' ' + r.cause + ' note "' + r.note + '" shown as written', show(r) === r.note, show(r));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('all ok');
