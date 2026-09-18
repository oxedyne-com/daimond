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
//   --break click    restores the broken openFile call (chat closure, not Files)
//   --break sbs      removes the side-by-side diff (flat .hist-diff restored)
//   --break tool     restores the 'user' tile for the tail note
const BIDX = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.slice(8) : (BIDX > -1 ? process.argv[BIDX + 1] : '');
let s = src;
if (BREAK === 'divert') s = s.replace(/_tailNoteTable/g, '_tailNoteTableGone');
if (BREAK === 'fold') s = s.replace(/var _TAIL_MORE = 6;/, 'var _TAIL_MORE = 6000;');
if (BREAK === 'deltas') s = s.replace(/DaimondVersions\.diff/g, 'DaimondVersionsX.diff');
if (BREAK === 'click') s = s.replace(/var open = \(window\.DaimondFiles && DaimondFiles\.open\) \|\| \(typeof openFile === 'function' \? openFile : null\);/, 'var open = openFile;');
if (BREAK === 'sbs') s = s.replace("wrap.className = 'tf-sbs';", "wrap.className = 'x';").replace(/function paintDiff\(d\) \{/, 'function paintDiffGone(d) {');
if (BREAK === 'tool') s = s.replace(/buildTile\('tool', \{ expanded: true, copy: text, ts: ts \}\)/, "buildTile('user', { expanded: true, copy: text, ts: ts })");
if (BREAK === 'foldkey') s = s.replace("more.textContent = t('chat.turn_files_more', { n: restCount });", "more.textContent = tn('chat.turn_files_more', restCount, { n: restCount });");
if (BREAK === 'newadd') s = s.replace("if (now && !was) {", "if (false) {");
const checks = [];
const ok = (name, pass) => checks.push([name, !!pass]);

function red(msg) { process.stdout.write(msg + '\n'); }
function grn(msg) { process.stdout.write(msg + '\n'); }

// 1. the engine's exact tail-note parses: files, version, the fold
(function () {
	const p = parseTailNote('[Daimond: this turn changed 2 files (v54): STATE.md, notes/dev.md. The user can restore any of them from History, and file_revert does the same when they ask.]');
	ok('engine tail note parses (files, v)', p && p.count === 2 && p.v === 54 && p.files.length === 2 && p.files[0] === 'STATE.md');
	ok('the fold parses ("and N more")', parseTailNote('[Daimond: this turn changed 9 files (v7): a.md, b.md, c.md, d.md, e.md, f.md and 3 more. The user can restore any of them from History, and file_revert does the same when they ask.]').rest === 3);
})();

// 2. the tile diverts the tail note into the table, and the tile is TOOL-styled
(function () {
	const i = s.indexOf("function appendUserMessage(text, ts)");
	ok('appendUserMessage carries the #22 diversion', i > 0 && /_tailNoteTable\(/.test(s.slice(i, i + 2000)));
	const j = s.indexOf("function appendUserMessage(text, ts)");
	ok('the tail note renders as a tool tile, not a user tile', j > 0 && /buildTile\('tool'/.test(s.slice(j, j + 600)) && /this turn changed/.test(s.slice(j, j + 600)));
})();

// 3. the table builder exists with its contract parts
(function () {
	const i = s.indexOf('function _tailNoteTable');
	ok('the table builder exists (name _tailNoteTable)', i > 0);
	ok('the table folds past ~6 files', /var _TAIL_MORE = 6;/.test(s));
	ok('the name click opens the file via the Files module door (DaimondFiles.open)', /DaimondFiles && DaimondFiles\.open/.test(s.slice(i, i + 6000)));
	const k = s.indexOf('function paintDiff');
	const kdiff = s.indexOf('DaimondVersions.diff', k);
	ok('the delta click shows the diff (side-by-side .tf-sbs)', k > 0 && /tf-sbs/.test(s.slice(k, k + 600)) && kdiff > k && kdiff < k + 4000);
})();

// 3b. the two defects the 2026-09-18 vision pass found (keep them red-first):
//   --break foldkey  the fold label calls the plural tn() (raw key on screen)
//   --break newadd   a new file (no was) never paints its all-add count
(function () {
	const i = s.indexOf('function _tailNoteTable');
	const body = s.slice(i, i + 8000);
	ok('the fold label uses the flat key (t), never plural tn()', /t\('chat\.turn_files_more'/.test(body) && !/tn\('chat\.turn_files_more'/.test(body));
	ok('a new file (no was) still paints its all-add count', /if \(now && !was\) \{/.test(body) && /DaimondVersions\.diff\(id, '', now\)/.test(body));
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
	ok('css: the name is one horizontal line (no per-character stack)', !/\.turn-file-name \{[^}]*writing-mode/.test(s) && !/\.turn-file-name \{[^}]*flex-direction: column/.test(s));
	ok('css: additions green, deletions red', /\.tf-add \{ color: var\(--ok/.test(s) && /\.tf-del \{ color: var\(--danger/.test(s));
	ok('css: the side-by-side diff grid', /\.tf-sbs-row \{ display: grid; grid-template-columns: 1fr 1fr; \}/.test(s));
	ok('css: the fold bar (.tf-fold) is styled', /\.tf-fold/.test(s));
})();

let fails = 0;
for (const [n, p] of checks) { if (p) grn(`ok   ${n}`); else { red(`FAIL ${n}`); fails++; } }
console.log(BREAK ? `break ${BREAK}: ${fails} FAIL of ${checks.length}` : `CLEAN            ${checks.length - fails} passed, ${fails} failed, exit ${fails ? 1 : 0}, 0 ms`);
process.exit(fails ? 1 : 0);
