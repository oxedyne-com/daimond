// verify_sectionsrail.mjs — the section rail's consumer, against both engines'
// `queryProject('heading')` shapes, without a browser or a wasm build.
//
// Live symptom (D-20260922-01 item E3, plan `daimond_austenite_integration_plan_
// 20260923.md`): on the default Austenite engine the section rail is EMPTY. Austenite's
// `queryProject` (`fe2o3_austenite/src/wasm.rs:152-186`) answers `{kind,label,title,
// level,page}` -- typst.ts answers `{kind,body,level}`, no `page`. `refreshToc`
// (www/js/typstwatch.js) read `h.body` through `wordsOf`, never `h.title`, so every
// Austenite row had an empty `text` and the `.filter(e => e.text)` dropped all of
// them. It also ignored the `page` Austenite already resolved and always fell through
// to the renderer locate-scan (`locate`/`scan`, typst.ts only).
//
// `refreshToc` is lifted verbatim from the real file (`grabFn`, brace-matched, not
// retyped) and driven with a mocked `window.DaimondTypst.queryProject` returning each
// engine's real shape, exactly as `verify_draftdup.mjs` drives `mergeAttachPrefix`.
//
//   node dev/verify_sectionsrail.mjs
//   node dev/verify_sectionsrail.mjs --break bodyonly   # restores the shipped defect
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, '..', 'www');
const FILE = path.join(SRC_DIR, 'js', 'typstwatch.js');

// The break restores the code exactly as it shipped: `h.body` only, `page` always 0,
// and the renderer locate-scan run unconditionally. This is applied to the FIXED
// source below, so `--break bodyonly` regresses it and the run must go red.
const BREAKS = {
	bodyonly: [{
		file: FILE,
		find: '\t// Austenite answers with `title` (a plain string) and a 1-based `page` already\n'
			+ '\t// resolved from its ledger; typst.ts answers with `body` (a content tree, see\n'
			+ '\t// `wordsOf`) and no `page`, which the renderer locate-scan below fills in. A row\n'
			+ '\t// with a page needs no scan, so `havePage` tracks whether every row this query\n'
			+ '\t// answered already carries one.\n'
			+ '\tlet havePage = Array.isArray(list) && list.length > 0;\n'
			+ '\tS.toc = Array.isArray(list) ? list.map(function (h) {\n'
			+ '\t\tconst title = h && h.title != null ? String(h.title) : wordsOf(h && h.body);\n'
			+ '\t\tconst page = Math.max(0, Number(h && h.page) || 0);\n'
			+ '\t\tif (!page) havePage = false;\n'
			+ '\t\treturn {\n'
			+ '\t\t\ttext:  title.replace(/\\s+/g, \' \').trim(),\n'
			+ '\t\t\tlevel: Math.max(1, Math.min(6, Number(h && (h.level || h.depth)) || 1)),\n'
			+ '\t\t\tpage:  page,\n'
			+ '\t\t};\n'
			+ '\t}).filter(function (e) { return e.text; }) : [];\n'
			+ '\tif (havePage) {\n'
			+ '\t\t// The query already resolved every page, so the renderer locate-scan --\n'
			+ '\t\t// typst.ts only, and pointless work on a document Austenite already placed --\n'
			+ '\t\t// is skipped outright by marking this build already scanned.\n'
			+ '\t\tS.scanned = S.drawn;\n'
			+ '\t\tdrawRail();\n'
			+ '\t\treturn;\n'
			+ '\t}\n'
			+ '\tS.scanned = 0;\n'
			+ '\tdrawRail();\n'
			+ '\tlocate();\n',
		with: '\t// [break:bodyonly] the defect as it shipped: only `body` is read, `page`\n'
			+ '\t// is never taken from the answer, and the locate-scan always runs.\n'
			+ '\tS.toc = Array.isArray(list) ? list.map(function (h) {\n'
			+ '\t\treturn {\n'
			+ '\t\t\ttext:  wordsOf(h && h.body).replace(/\\s+/g, \' \').trim(),\n'
			+ '\t\t\tlevel: Math.max(1, Math.min(6, Number(h && (h.level || h.depth)) || 1)),\n'
			+ '\t\t\tpage:  0,\n'
			+ '\t\t};\n'
			+ '\t}).filter(function (e) { return e.text; }) : [];\n'
			+ '\tS.scanned = 0;\n'
			+ '\tdrawRail();\n'
			+ '\tlocate();\n',
	}],
};
const BREAK = process.argv.find(a => a.startsWith('--break='))?.slice(8)
	|| (process.argv[2] === '--break' ? process.argv[3] : null);
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; known: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

// The damaged source, loaded BEFORE any check reads it, and restored on exit, always
// -- the same device as verify_draftdup.mjs.
const PATCHES = BREAK ? BREAKS.bodyonly : [];
const PRISTINE = fs.readFileSync(FILE, 'utf8');
for (const p of PATCHES) {
	if (!PRISTINE.includes(p.find)) {
		console.error(`break '${BREAK}': anchor not found in ${path.basename(FILE)}`);
		process.exit(2);
	}
	fs.writeFileSync(FILE, PRISTINE.replace(p.find, p.with));
}
process.on('exit', () => { if (PATCHES.length) fs.writeFileSync(FILE, PRISTINE); });

const WATCH_SRC = fs.readFileSync(FILE, 'utf8');

let bad = 0, ran = 0;
const check = (pass, name, detail) => {
	ran++;
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// Same device as verify_draftdup.mjs's grabFn: a function found by its declaration
// and brace-matched from the opening `{`, so a rename or a move throws here rather
// than silently testing a stale copy.
function grabFn(src, sig) {
	const start = src.indexOf(sig);
	if (start < 0) { console.error(`could not find '${sig}'`); process.exit(2); }
	const open = src.indexOf('{', start);
	let depth = 0, i = open;
	for (; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

const WORDS_OF_SRC   = grabFn(WATCH_SRC, 'function wordsOf(');
const REFRESH_TOC_SRC = grabFn(WATCH_SRC, 'async function refreshToc()');

// `refreshToc` closes over `wordsOf` as a free identifier in the same scope, so both
// are declared together in the factory body; `window`, `S`, `drawRail` and `locate`
// are the file's other free identifiers it touches, passed in as mocks.
const buildRefreshToc = new Function('window', 'S', 'drawRail', 'locate',
	WORDS_OF_SRC + '\n' + REFRESH_TOC_SRC + '\nreturn refreshToc;');

function scenario(queryProjectImpl) {
	const S = { toc: [], scanned: -1, drawn: 7 };
	let drawn = 0, located = 0;
	const window = { DaimondTypst: queryProjectImpl ? { queryProject: queryProjectImpl } : null };
	const refreshToc = buildRefreshToc(window, S, () => { drawn++; }, () => { located++; });
	return { S, refreshToc, calls: () => ({ drawn, located }) };
}

console.log('refreshToc — the section rail\'s consumer, both engines\' query shapes'
	+ (BREAK ? ` (--break ${BREAK})` : ''));

// ── Austenite: {kind,label,title,level,page}, three real headings ───────────
{
	const AUST_ROWS = [
		{ kind: 'heading', label: 'h1', title: 'Front matter',      level: 1, page: 1 },
		{ kind: 'heading', label: 'h2', title: 'Chapter one',       level: 1, page: 2 },
		{ kind: 'heading', label: 'h3', title: 'Section one point one', level: 2, page: 3 },
	];
	const { S, refreshToc, calls } = scenario(async () => AUST_ROWS);
	await refreshToc();
	check(S.toc.length === 3, 'Austenite: all three headings survive (none read as empty)',
		JSON.stringify(S.toc));
	check(S.toc.map(e => e.text).join('|') === 'Front matter|Chapter one|Section one point one',
		'Austenite: `title` is read, not the (absent) `body`', JSON.stringify(S.toc.map(e => e.text)));
	check(S.toc.map(e => e.page).join(',') === '1,2,3',
		'Austenite: the resolved 1-based `page` is taken as-is', JSON.stringify(S.toc.map(e => e.page)));
	check(S.toc.map(e => e.level).join(',') === '1,1,2', 'Austenite: `level` carries through');
	check(S.scanned === S.drawn, 'Austenite: marked already-scanned (page is already known)');
	check(calls().located === 0, 'Austenite: the renderer locate-scan is skipped entirely');
	check(calls().drawn === 1, 'Austenite: the rail is drawn once, with the real entries');
}

// ── typst.ts: {kind,body,level}, no `page` -- the locate-scan must still run ──
{
	const TS_ROWS = [
		{ kind: 'heading', body: { text: 'Front matter' }, level: 1 },
		{ kind: 'heading', body: [{ text: 'Chapter ' }, { text: 'two' }], level: 1 },
	];
	const { S, refreshToc, calls } = scenario(async () => TS_ROWS);
	await refreshToc();
	check(S.toc.length === 2, 'typst.ts: both headings survive, via `body`', JSON.stringify(S.toc));
	check(S.toc.map(e => e.text).join('|') === 'Front matter|Chapter two',
		'typst.ts: `wordsOf(body)` still reconstructs a split run', JSON.stringify(S.toc.map(e => e.text)));
	check(S.toc.every(e => e.page === 0), 'typst.ts: page starts unresolved (no `page` in the answer)');
	check(S.scanned === 0, 'typst.ts: NOT marked already-scanned');
	check(calls().located === 1, 'typst.ts: the renderer locate-scan still runs, exactly as before');
}

// ── A partial answer (some rows carry `page`, one does not) still scans ─────
// -- a defensive case: any row missing its page means the rail cannot skip the walk.
{
	const MIXED_ROWS = [
		{ kind: 'heading', title: 'One', level: 1, page: 1 },
		{ kind: 'heading', title: 'Two', level: 1 },
	];
	const { S, calls, refreshToc } = scenario(async () => MIXED_ROWS);
	await refreshToc();
	check(S.toc.length === 2, 'mixed: both rows still come through');
	check(S.scanned === 0 && calls().located === 1,
		'mixed: one missing `page` is enough to fall back to the locate-scan');
}

// ── No headings at all: an empty rail, no scan started ───────────────────────
{
	const { S, calls, refreshToc } = scenario(async () => []);
	await refreshToc();
	check(S.toc.length === 0, 'empty: no rows, no rail entries');
	check(calls().drawn === 1 && calls().located === 1,
		'empty: drawn once and a scan is (harmlessly) started, matching the pre-fix shape');
}

// ── An older driver with no `queryProject` at all: degrades to an empty rail ──
{
	const { S, calls, refreshToc } = scenario(null);
	await refreshToc();
	check(S.toc.length === 0 && calls().drawn === 1 && calls().located === 0,
		'no driver: empty rail, drawn once, no scan (unaffected by this fix)');
}

console.log(`\n${ran - bad}/${ran} checks passed`);
if (bad) { console.log(`${bad} FAILED`); process.exit(1); }
console.log('verify_sectionsrail: all checks passed');
