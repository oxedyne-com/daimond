// UNDO-NOTE-WORDS (TRAIN-21b, 06 Nov): "Undo this turn" removed ~/t21undo.txt, a file the turn
// had created, and the chat's note read "/home/jason/t21undo.txt put back" while the model's copy
// said "Removed". The note he sees names each file by what was done to it, from the same `undone`
// record the model's copy reads, in every locale.   `node www/js/undonotewords.test.mjs`
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
let fail = 0; const check = (n, c, d) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c ? '' : '  ' + d)); if (!c) fail++; };
const J = JSON.stringify;
const LOCALES = ['en', 'de', 'es', 'fr', 'pt-BR', 'ja', 'ko', 'zh-Hans'];
const T = {};
for (const loc of LOCALES) {
	const window = { DaimondI18n: { register: (code, table) => { T[code] = table; } } };
	vm.runInNewContext(readFileSync(join(HERE, '..', 'i18n', loc + '.js'), 'utf8'), { window });
}
let cur = 'en';
const fill = (s, vars) => String(s).replace(/\{(\w+)\}/g, (whole, k) => (vars && vars[k] != null ? String(vars[k]) : whole));
const tr = (k, vars) => { const s = T[cur][k] != null ? T[cur][k] : T.en[k]; return s == null ? k : fill(s, vars); };

const w = makeWindow({});
w.DaimondI18n = { t: tr };
const P = loadPage({ window: w, want: ['undoNoteShown', 'noteUndone'], stub: { persistChats() {}, touchChat() {}, renderHistory() {} } });
const phrase = (k, list) => (T[cur][k] == null ? '<no ' + k + '>' : fill(T[cur][k], { list }));
function note(how, restored, removed, skipped = []) {
	const chat = { id: 'c1', messages: [{ role: 'user', content: 'make a file', mid: 'u1', ts: 10 }] };
	return P.noteUndone(chat, 'e-' + how + restored.length + removed.length, { how, turn: 'u1', restored, removed, skipped });
}

// The TRAIN-21b record: the undo removed the one file the turn made.
const GONE = '/home/jason/t21undo.txt', BACK = '/w/notes.txt';
{
	const row = note('undo', [], [GONE]);
	cur = 'en';
	const shown = P.undoNoteShown(row);
	check('en, TRAIN-21b: the model copy says Removed', /Removed[^:]*: \/home\/jason\/t21undo\.txt/.test(row.content), row.content);
	check('en, TRAIN-21b: the shown note does not say "put back"', !/put back/.test(shown), shown);
	check('en, TRAIN-21b: the shown note says the file was removed', shown.includes(GONE + ' removed'), shown);
}
for (const loc of LOCALES) {
	cur = loc;
	for (const how of ['undo', 'restore', 'redo']) {
		const fam = how === 'redo' ? 'chat.redone_' : 'chat.undone_';
		const gone = P.undoNoteShown(note(how, [], [GONE]));
		check(loc + ' ' + how + ', removed only: named as removed', gone.includes(phrase(fam + 'removed', GONE)), gone);
		check(loc + ' ' + how + ', removed only: not named as put back', !gone.includes(phrase(fam + 'restored', GONE)), gone);
		const both = P.undoNoteShown(note(how, [BACK], [GONE]));
		check(loc + ' ' + how + ', both: each file by its own action',
			both.includes(phrase(fam + 'restored', BACK)) && both.includes(phrase(fam + 'removed', GONE))
			&& !both.includes(phrase(fam + 'restored', GONE)) && !both.includes(phrase(fam + 'removed', BACK)), both);
	}
	// UNDO-NOTE-WORDS-b: every file left alone, so no colon over an empty list.
	for (const how of ['undo', 'restore', 'redo']) {
		const key = how === 'redo' ? 'chat.redo_note' : how === 'restore' ? 'chat.restore_note' : 'chat.undo_note';
		const kept = P.undoNoteShown(note(how, [], [], [{ path: BACK, why: 'changed since' }]));
		const head = T[cur][key + '_none'] == null ? '<no ' + key + '_none>' : fill(T[cur][key + '_none'], { ask: 'make a file' });
		check(loc + ' ' + how + ', all left alone: the head-only note, no empty list',
			kept.startsWith(head) && !/[:：]\s*[.。;；、]/.test(kept) && !/[:：]\s*$/.test(head) && kept.includes(BACK), kept);
	}
	if (loc !== 'en') check(loc + ': its note words are its own, not the English',
		['chat.undo_note', 'chat.undone_restored', 'chat.undone_removed', 'chat.redone_removed', 'chat.undo_note_none'].every((k) => T[loc][k] && T[loc][k] !== T.en[k]), J(loc));
}
console.log(fail ? fail + ' FAILED' : 'all passed');
process.exit(fail ? 1 : 0);
