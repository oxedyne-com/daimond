// verify_outline_tool.mjs -- `outline` maps a file, in the browser, for each language it reads.
//
// WHAT THIS FILE IS ABOUT. A model that does not know a file had two ways in and neither answered
// the question it was asking. `file_read` of a big file is a 200-line peek -- deliberately, since
// the alternative was 80,016 bytes for one line number -- and `file_search` needs the name the
// reader has not got yet. So a turn read pages of a file looking for a shape that fits in a
// kilobyte. `outline` is that kilobyte: one row per function, method, type, section or heading,
// with the line range to read next.
//
// WHAT IT LOCKS DOWN.
//
//   A. The tool is OFFERED -- in the catalogue the Tools panel reads, with a summary of its own.
//   B. Each language's scanner finds what it is written to find, through the wasm, in the page:
//      Rust items and their nesting, a JS object's methods, a Markdown heading that is NOT inside
//      a code fence, Typst's `=` headings and `#let`, and Python's indentation.
//   C. An extension nobody wrote a scanner for says so and names `file_search` instead.
//   D. Paging: `limit` cuts the rows, `offset` continues, and the header hands back the call that
//      fetches the next page.
//
// THE BREAK, AND WHAT IT PROVES. `--break nojs` wraps `run_tool` in the page so that an `outline`
// of a `.js` path answers with the no-scanner sentence, as a build without the JS scanner would.
// The B checks for JavaScript then go red. That proves those checks CAN fail, which is what a
// break is for. It does not prove anything about the scanner compiled into the wasm; nothing a
// verifier can inject would, because the scanner is compiled in rather than served. The
// instruments for that are the Rust tests in `src/tools.rs` -- among them
// `test_the_outline_of_the_apps_largest_file_is_fast_and_finds_workers_dispatch`, which reads the
// real 46,000-line `www/js/daimond.js`.
//
//   node dev/verify_outline_tool.mjs
//   node dev/verify_outline_tool.mjs --break nojs
//
// It needs a dev world up (`bash dev/world.sh N --up`) and a wasm build of this tree.

import { open } from './harness.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
const BREAKS = ['nojs'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

const bad = [];
const check = (name, pass, detail) => {
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
	if (!pass) bad.push(name);
};

// ── The fixtures, one per language the scanner claims ───────────────
const FILES = {
	'map/thing.rs': [
		'//! A header.',
		'',
		'pub struct Thing {',
		'    a: usize,',
		'}',
		'',
		'impl Thing {',
		'    pub fn one(&self) -> usize { self.a }',
		'    pub async fn two(&self) {}',
		'}',
		'',
		'const MAX: usize = 4;',
		''].join('\n'),
	'map/app.js': [
		'(function () {',
		'\tfunction boot() { return 1; }',
		'\tvar Workers = {',
		'\t\ttakeSlot: function () { return 1; },',
		'\t\tdispatch: function (a, b) { return a + b; },',
		'\t};',
		'})();',
		''].join('\n'),
	'map/readme.md': [
		'# Title',
		'words',
		'```',
		'# not a heading',
		'```',
		'## Second',
		'more',
		''].join('\n'),
	'map/ch.typ': [
		'= Chapter',
		'text',
		'#let box(x) = x + 1',
		'== Section',
		''].join('\n'),
	'map/thing.py': [
		'class Thing:',
		'    def one(self):',
		'        return 1',
		'',
		'    async def two(self):',
		'        return 2',
		'',
		'def free():',
		'    return 3',
		''].join('\n'),
	'map/rows.csv': 'a,b\n1,2\n',
	'map/many.rs': Array.from({ length: 10 }, (_, i) => `fn item${i + 1}() {}`).join('\n') + '\n',
};

const s = await open({ name: 'outlinetool' });

// ── A. the catalogue ────────────────────────────────────────────────
const catalogue = await s.page.evaluate(async () => {
	const W = window.Wasm || await import('/pkg/oxedyne_daimond.js');
	if (!W || typeof W.builtin_tools !== 'function') return null;
	try { return JSON.parse(W.builtin_tools()); } catch (e) { return null; }
});
if (catalogue === null) {
	check('A1 the catalogue can be read at all', false,
		'builtin_tools() was unreachable, so A is untested rather than passing');
} else {
	const entry = catalogue.find(t => t && t.tool === 'outline');
	check('A1 outline is in the catalogue the Tools panel reads', !!entry);
	check('A2 and it carries a summary of its own',
		!!entry && !!entry.blurb && /line range/i.test(entry.blurb), entry ? entry.blurb : '');
}

const got = await s.page.evaluate(async ({ files, brk }) => {
	const m   = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const call = async (tool, args) => {
		// The break, injected where a verifier CAN inject one: between the page and the tool.
		if (brk === 'nojs' && tool === 'outline' && /\.(js|mjs|cjs|ts)$/.test(JSON.parse(args).path)) {
			return "[outline] no scanner for '.js'. It reads Rust, Python, Markdown and Typst. "
				+ "file_search with the query '^\\S' lists the lines of this file that start at "
				+ 'column 0, which is the nearest thing.\n';
		}
		return await app.run_tool(tool, args);
	};
	await app.run_tool('dir_create', JSON.stringify({ path: 'map' }));
	for (const [path, content] of Object.entries(files)) {
		await app.run_tool('file_write', JSON.stringify({ path, content }));
	}
	const out = {};
	out.rs   = await call('outline', JSON.stringify({ path: 'map/thing.rs', depth: 2 }));
	out.js   = await call('outline', JSON.stringify({ path: 'map/app.js', depth: 3 }));
	out.md   = await call('outline', JSON.stringify({ path: 'map/readme.md', depth: 3 }));
	out.typ  = await call('outline', JSON.stringify({ path: 'map/ch.typ', depth: 3 }));
	out.py   = await call('outline', JSON.stringify({ path: 'map/thing.py', depth: 2 }));
	out.csv  = await call('outline', JSON.stringify({ path: 'map/rows.csv' }));
	out.page = await call('outline', JSON.stringify({ path: 'map/many.rs', limit: 3 }));
	out.next = await call('outline', JSON.stringify({ path: 'map/many.rs', offset: 3, limit: 3 }));
	return out;
}, { files: FILES, brk: BREAK });

// ── B. each scanner ─────────────────────────────────────────────────
check('B1 rust: the struct, the impl and the const are rows',
	/struct\tThing/.test(got.rs) && /impl\timpl Thing/.test(got.rs) && /const\tMAX/.test(got.rs),
	got.rs.split('\n').slice(1, 4).join(' | '));
check('B2 rust: the impl block\'s two fns are nested under it',
	/ {2}\d+-\d+\tfn\tone/.test(got.rs) && / {2}\d+-\d+\tfn\ttwo/.test(got.rs),
	got.rs.replace(/\n/g, ' | '));
check('B3 js: a function inside an IIFE is at the top level',
	/^\d+-\d+\tfn\tboot/m.test(got.js), got.js.replace(/\n/g, ' | '));
check('B4 js: an object literal and its methods',
	/var\tWorkers/.test(got.js) && /method\tdispatch/.test(got.js),
	got.js.replace(/\n/g, ' | '));
check('B5 markdown: the headings, and NOT the one inside the fence',
	/h1\tTitle/.test(got.md) && /h2\tSecond/.test(got.md) && !/not a heading/.test(got.md),
	got.md.replace(/\n/g, ' | '));
check('B6 typst: = headings and #let',
	/h1\tChapter/.test(got.typ) && /h2\tSection/.test(got.typ) && /let\tbox/.test(got.typ),
	got.typ.replace(/\n/g, ' | '));
check('B7 python: methods nest under their class by indentation',
	/class\tThing/.test(got.py) && / {2}\d+-\d+\tfn\tone/.test(got.py) && /^\d+-\d+\tfn\tfree/m.test(got.py),
	got.py.replace(/\n/g, ' | '));
// The range is the whole point: a map with no ranges is a list of names.
check('B8 every row carries a line range',
	got.rs.split('\n').filter(l => l && !l.startsWith('[outline]'))
		.every(l => /^\s*\d+-\d+\t/.test(l)),
	got.rs.replace(/\n/g, ' | '));

// ── C. an extension with no scanner ─────────────────────────────────
check('C1 an unknown extension says so', /no scanner for '\.csv'/.test(got.csv), got.csv.trim());
check('C2 and names what to use instead', /file_search/.test(got.csv));

// ── D. paging ───────────────────────────────────────────────────────
const rows = t => t.split('\n').filter(l => l && !l.startsWith('[outline]'));
check('D1 limit cuts the rows', rows(got.page).length === 3, String(rows(got.page).length));
check('D2 the header hands back the next call',
	/Next: \{"path":"map\/many\.rs","offset":3\}/.test(got.page), got.page.split('\n')[0]);
check('D3 offset continues where it left off',
	/fn\titem4/.test(rows(got.next)[0] || ''), rows(got.next)[0]);

await s.close();

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — the instrument is live.' : ' — THE BREAK PROVED NOTHING.'));
	process.exitCode = bad.length ? 0 : 1;
} else {
	console.log('\nVERDICT: ' + (bad.length === 0
		? 'outline maps a file in every language it claims'
		: 'FAILED — ' + bad.join('; ')));
	process.exitCode = bad.length === 0 ? 0 : 1;
}
