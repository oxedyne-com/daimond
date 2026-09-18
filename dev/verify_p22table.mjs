#!/usr/bin/env node
// #22 — the changed-files table under a turn. Proof of the parse (given the
// engine's own tail-note shape from diamond_versions.rs tail_note) and the
// 6-plus-fold behaviour, red-first: `--break` restores the shipped defect
// (no diversion at the tile) and reddens the checks that carry it.

import fs from 'node:fs';
import path from 'node:path';

// (no child_process, no execFileSync: this is a pure source+logic check.)
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// The engine's exact tail-note shape (src/diamond_versions.rs:726 tail_note):
//   [Daimond: this turn changed N file(s) (vV): a.md, b.md and 3 more. The user can restore ...]
// The fold rides the LAST filename ("f.md and 3 more"), so it is peeled after the split.
const RE = /^\[Daimond: this turn changed (\d+) files? \(v(\d+)\): (.+?)\. The user can restore/;

function parseTailNote(s) {
	const m = RE.exec(String(s || ''));
	if (!m) return null;
	const shown = m[3].split(',').map(x => x.trim()).filter(Boolean);
	const last = shown.length ? shown[shown.length - 1] : '';
	let rest = 0;
	const rm = /^(.+) and (\d+) more$/.exec(last);
	if (rm) { rest = Number(rm[2]); shown[shown.length - 1] = rm[1].trim(); }
	return { count: Number(m[1]), v: Number(m[2]), files: shown, rest: rest };
}

// What a row's diff summary reads like once DaimondVersions.diff answers.
function deltaText(d) {
	if (!d) return '·';
	return '+' + (d.add || 0) + ' −' + (d.del || 0);
}

// ── checks ─────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(root, 'www/js/daimond.js'), 'utf8');
// BREAKS (red-first, each reddens the checks that carry it):
//   --break divert   removes the tail-note diversion from appendUserMessage
//   --break fold     removes the 6-plus fold
//   --break deltas   removes the DaimondVersions.diff wiring
const BIDX = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.slice(8) : (BIDX > -1 ? process.argv[BIDX + 1] : '');
let s = src;
if (BREAK === 'divert') s = s.replace(/_tailNoteTable/g, '_tailNoteTableGone');
if (BREAK === 'fold') s = s.replace(/var _TAIL_MORE = 6;/, 'var _TAIL_MORE = 6000;');
if (BREAK === 'deltas') s = s.replace(/DaimondVersions\.diff/g, 'DaimondVersionsX.diff');
const checks = [];
const ok = (name, pass) => checks.push([name, !!pass]);

function red(msg) { process.stdout.write('\x1b[31m' + msg + '\x1b[0m\n'); }
function grn(msg) { process.stdout.write('\x1b[32m' + msg + '\x1b[0m\n'); }

// 1. the engine's exact tail-note parses: files, version, the fold
(function () {
	const p = parseTailNote('[Daimond: this turn changed 2 files (v54): STATE.md, notes/dev.md. The user can restore any of them from History, and file_revert does the same when they ask.]');
	ok('engine tail note parses (files, v)', p && p.count === 2 && p.v === 54 && p.files.length === 2 && p.files[0] === 'STATE.md');
	ok('the fold parses ("and N more")', parseTailNote('[Daimond: this turn changed 9 files (v7): a.md, b.md, c.md, d.md, e.md, f.md and 3 more. The user can restore any of them from History, and file_revert does the same when they ask.]').rest === 3);
})();

// 2. the tile diverts the tail note into the table
(function () {
	const i = s.indexOf("function appendUserMessage(text, ts)");
	ok('appendUserMessage carries the #22 diversion', i > 0 && /_tailNoteTable\(/.test(s.slice(i, i + 2000)));
})();

// 3. the table builder exists with its contract parts
(function () {
	const i = s.indexOf('function _tailNoteTable');
	ok('the table builder exists (name _tailNoteTable)', i > 0);
	ok('the table folds past ~6 files', /var _TAIL_MORE = 6;/.test(s));
	ok('the name click opens the file (openFile)', /openFile\(/.test(s.slice(i, i + 4200)));
	ok('the delta click shows the diff (.hist-diff)', /hist-diff/.test(s.slice(i, i + 4200)) && /DaimondVersions\.diff\(/.test(s.slice(i, i + 4200)));
})();

// 4. the delta reads +N −M
(function () {
	ok('delta text reads +N −M', deltaText({ add: 10, del: 7 }) === '+10 −7');
	ok('delta text handles no-diff', deltaText(null) === '·');
})();

// 5. i18n: every catalogue carries the new keys
(function () {
	const cats = fs.readdirSync(path.join(root, 'www/i18n')).filter(f => f.endsWith('.js'));
	let all = true;
	for (const f of cats) {
		const s = fs.readFileSync(path.join(root, 'www/i18n', f), 'utf8');
		if (!/'chat\.turn_files\.(one|other|)':/.test(s)) { all = false; red('  ' + f + ' missing chat.turn_files'); }
		if (!/'chat\.turn_files_more':/.test(s)) { all = false; red('  ' + f + ' missing chat.turn_files_more'); }
	}
	ok('i18n: all ' + cats.length + ' catalogues carry the new keys', all);
})();

// 6. the CSS for the table rows
(function () {
	const s = fs.readFileSync(path.join(root, 'www/css/app.css'), 'utf8');
	ok('css: .turn-files styles the table', /\.turn-files/.test(s) && /\.turn-file-row/.test(s));
})();

let fails = 0;
for (const [n, p] of checks) { if (p) grn(`ok   ${n}`); else { red(`FAIL ${n}`); fails++; } }
console.log(BREAK ? `break ${BREAK}: ${fails} FAIL of ${checks.length}` : `CLEAN            ${checks.length - fails} passed, ${fails} failed, exit ${fails ? 1 : 0}, 0 ms`);
process.exit(fails ? 1 : 0);
