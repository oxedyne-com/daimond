/* ============================================================
   Test -- dev/codemap.mjs gives RIGHT ranges, not plausible ones.
   ------------------------------------------------------------
   The map is only worth having if an agent can `sed -n 'a,bp'` the
   range it prints and get the whole function and nothing else. A
   range that is a few lines out is worse than no map, because it
   is trusted.

   Two kinds of proof, because two things can be wrong:

     * FIXTURES for every construct that fools a brace counter: a
       `}` in a string, a template literal, a regex, a comment, a
       character literal, a raw string; nested functions; object
       members written four ways.
     * THE REAL SOURCE. Every definition the map finds in the real
       `daimond.js` must slice out as a COMPLETE syntactic unit,
       which `vm.Script` decides, not this file. That is a check
       the scanner cannot agree with itself about. The sample is
       twenty random definitions on a fixed seed, plus the four
       named ones the brief fixes, plus balance over every file.

     node --test www/js/codemap.test.mjs
   ============================================================ */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
	mapSource, findDefs, renderOutline, renderAt, renderFind, renderMembers, pickSections,
} from '../../dev/codemap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/// name -> "start-end" for the definitions in a fixture, repeated names last-wins.
const ranges = (src, lang = 'js') => Object.fromEntries(mapSource(src, lang).defs.map(d => [d.name, `${d.sl}-${d.el}`]));

test('nested functions: the inner range sits inside the outer and both close on their own brace', () => {
	const src = [
		'function outer(a) {',		// 1
		'\tfunction inner(b) {',	// 2
		'\t\treturn b;',		// 3
		'\t}',				// 4
		'\treturn inner(a);',		// 5
		'}',				// 6
		'function after() {}',		// 7
	].join('\n');
	assert.deepEqual(ranges(src), { outer: '1-6', inner: '2-4', after: '7-7' });
	const map = mapSource(src, 'js');
	const inner = map.defs.find(d => d.name === 'inner');
	assert.equal(inner.parent.name, 'outer');
	assert.equal(inner.level, 1);
});

test('a template literal with braces in its text and in its expressions does not move the end', () => {
	const src = [
		'function a() {',					// 1
		'\tvar s = `{ not code } ${ {x: 1}.x + `${ "}" }` } }}`;',	// 2
		'\treturn s;',						// 3
		'}',							// 4
		'function b() {',					// 5
		'\treturn `multi',					// 6
		'line { with',						// 7
		'braces`;',						// 8
		'}',							// 9
	].join('\n');
	assert.deepEqual(ranges(src), { a: '1-4', b: '5-9' });
	assert.equal(mapSource(src, 'js').strays, 0);
});

test('a regex holding a brace, and a division that is not a regex', () => {
	const src = [
		'function r() {',				// 1
		'\treturn /\\{+[}]/g.test(x) && /}/.test(y);',	// 2
		'}',						// 3
		'function d(a, b, c) {',			// 4
		'\tvar q = a / b / c;',			// 5
		'\tvar w = (a) / 2 + { k: 1 }.k / 3;',		// 6
		'\treturn q;',				// 7
		'}',						// 8
	].join('\n');
	assert.deepEqual(ranges(src), { r: '1-3', d: '4-8' });
	assert.equal(mapSource(src, 'js').strays, 0);
});

test('braces in comments and strings are not braces', () => {
	const src = [
		'function c() {',			// 1
		'\t// } closes nothing',		// 2
		'\t/* { opens nothing',		// 3
		'\t   } */',				// 4
		'\tvar u = "http://x/}";',		// 5
		'\tvar v = \'\\\'}\';',		// 6
		'\treturn 1;',			// 7
		'}',					// 8
	].join('\n');
	assert.deepEqual(ranges(src), { c: '1-8' });
});

test('object-literal members written four ways, and the module that holds them', () => {
	const src = [
		'window.Mod = {',				// 1
		'\tone: function (a) {',			// 2
		'\t\treturn a;',				// 3
		'\t},',					// 4
		'\ttwo(b) {',				// 5
		'\t\treturn b;',				// 6
		'\t},',					// 7
		'\tthree: async (c) => {',			// 8
		'\t\treturn c;',				// 9
		'\t},',					// 10
		'\tfour: x => x + 1,',			// 11
		'\tdata: { not: "a function" },',		// 12
		'};',						// 13
		...Array.from({ length: 40 }, () => '// padding, so the module is not the whole file'),
	].join('\n');
	const map = mapSource(src, 'js');
	const r = Object.fromEntries(map.defs.map(d => [d.name, `${d.sl}-${d.el}`]));
	assert.deepEqual(r, { Mod: '1-13', one: '2-4', two: '5-7', three: '8-10', four: '11-11' });
	assert.equal(map.defs.find(d => d.name === 'three').async, true);
	assert.equal(map.defs.find(d => d.name === 'one').parent.name, 'Mod');
});

test('an IIFE module, a named arrow, a class, and a listener are found with their ends', () => {
	const src = [
		'var Files = (function () {',			// 1
		'\tfunction open() {',			// 2
		'\t}',					// 3
		'\treturn { open: open };',		// 4
		'})();',					// 5
		'const add = (a, b) => {',			// 6
		'\treturn a + b;',			// 7
		'};',					// 8
		'const inc = n => n + 1;',			// 9
		'class K extends Base {',			// 10
		'\tgo() {',				// 11
		'\t}',					// 12
		'}',					// 13
		'window.addEventListener(\'daimond:ready\', function (ev) {',	// 14
		'\tinit(ev);',				// 15
		'});',					// 16
	].join('\n');
	const r = ranges(src);
	assert.equal(r.Files, '1-5');
	assert.equal(r.open, '2-3');
	assert.equal(r.add, '6-8');
	assert.equal(r.inc, '9-9');
	assert.equal(r.K, '10-13');
	assert.equal(r.go, '11-12');
	assert.equal(r['daimond:ready'], '14-16');
});

test('keywords are not methods, and locals inside a function are not named', () => {
	const src = [
		'function f(x) {',			// 1
		'\tif (x) {',				// 2
		'\t\tvar tmp = { a: function () {} };',	// 3
		'\t}',					// 4
		'\twhile (x) {',			// 5
		'\t}',					// 6
		'\tswitch (x) {',			// 7
		'\t}',					// 8
		'\tvar local = 5;',			// 9
		'}',					// 10
	].join('\n');
	const names = mapSource(src, 'js').defs.map(d => d.name);
	assert.deepEqual(names.filter(n => n !== 'a'), ['f']);		// the function inside a local object is still a function
	for (const bad of ['if', 'while', 'switch', 'tmp', 'local']) assert.ok(!names.includes(bad), bad);
});

test('banners make sections; a banner inside a module is a landmark of that module', () => {
	const src = [
		'(function () {',				// 1
		'\t// ── First ──────────',			// 2
		'\tfunction a() {',			// 3
		'\t}',					// 4
		'',						// 5
		'\t// === Second ===',			// 6
		'\tvar M = {',				// 7
		'\t\t// ── Inner ──',			// 8
		'\t\tgo: function () {},',		// 9
		'\t};',					// 10
		'})();',					// 11
	].join('\n');
	const map = mapSource(src, 'js');
	assert.deepEqual(map.sections.map(s => [s.title, s.start]), [['First', 2], ['Second', 6]]);
	assert.equal(map.sections[0].end, 4);
	const inner = map.banners.find(b => b.title === 'Inner');
	assert.equal(inner.owner.name, 'M');
	assert.equal(renderAt(map, 'x.js', 9).out.some(l => /after § 8 Inner/.test(l)), true);
});

test('Rust: braces in strings, chars, raw strings and nested comments; impl, mod, struct, enum', () => {
	const src = [
		'/// A thing.',						// 1
		'pub struct Thing<\'a> { name: &\'a str }',		// 2
		'pub enum Mode {',					// 3
		'\tA,',						// 4
		'\tB { n: u8 },',					// 5
		'}',							// 6
		'impl<\'a> Thing<\'a> {',				// 7
		'\tpub fn open(&self) -> Result<(), String> {',		// 8
		'\t\tlet s = "}{";',					// 9
		'\t\tlet c = \'{\';',					// 10
		'\t\tlet r = r#"} "quoted" {"#;',			// 11
		'\t\t/* outer { /* nested } */ still } comment */',	// 12
		'\t\tOk(())',						// 13
		'\t}',							// 14
		'\tfn sig(&self);',					// 15
		'}',							// 16
		'mod inner {',						// 17
		'\tpub(crate) async fn go<F: Fn(i32) -> i32>(f: F) -> i32 where F: Copy {',	// 18
		'\t\tf(1)',						// 19
		'\t}',							// 20
		'}',							// 21
	].join('\n');
	const map = mapSource(src, 'rs');
	assert.equal(map.strays, 0);
	const r = Object.fromEntries(map.defs.map(d => [d.kind + ' ' + d.name, `${d.sl}-${d.el}`]));
	assert.deepEqual(r, {
		'struct Thing': '2-2', 'enum Mode': '3-6', 'impl Thing<\'a>': '7-16', 'fn open': '8-14',
		'fn sig': '15-15', 'mod inner': '17-21', 'fn go': '18-20',
	});
	assert.equal(map.defs.find(d => d.name === 'go').async, true);
});

test('find: exact name, Parent.name, regex, substring; a miss says so', () => {
	const src = 'window.Core = {\n\tbusy: function () {},\n};\nfunction busyBody() {}\nfunction other() {}\n';
	const map = mapSource(src, 'js');
	assert.deepEqual(findDefs(map, 'busy').hits.map(d => d.name), ['busy']);
	assert.equal(findDefs(map, 'busy').how, 'exact');
	assert.deepEqual(findDefs(map, 'Core.busy').hits.map(d => d.name), ['busy']);
	assert.deepEqual(findDefs(map, '^busy').hits.map(d => d.name).sort(), ['busy', 'busyBody']);
	assert.equal(findDefs(map, 'usyB').how, 'substring');
	assert.equal(renderFind(map, 'x.js', 'nothing_here').found, false);
});

test('call sites are counted from code, not from comments or strings', () => {
	const src = 'function go() {}\n// go() in a comment\nvar s = "go()";\ngo();\nif (x) { go(); }\nlist.push(go);\n';
	const out = renderFind(mapSource(src, 'js'), 'x.js', 'go').out.join('\n');
	assert.match(out, /calls 2 \[4 5\]/);
	assert.match(out, /refs 1 \[6\]/);
});

test('a bare outline gives the section list when the full outline is over budget', () => {
	let src = '';
	for (let s = 0; s < 30; s++) {
		src += `// ── Section ${s} ──\n`;
		for (let f = 0; f < 10; f++) src += `function f${s}_${f}() {\n}\n`;
	}
	const map = mapSource(src, 'js');
	const small = renderOutline(map, 'x.js', { budget: 100000 }).join('\n');
	assert.match(small, /f29_9/);
	const big = renderOutline(map, 'x.js', { budget: 500 }).join('\n');
	assert.doesNotMatch(big, /f29_9/);
	assert.match(big, /Section 29/);
	assert.match(big, /Next: --section/);
	assert.equal(pickSections(map, 'Section 2').length, 11);		// 2, 20..29
	assert.deepEqual(pickSections(map, '5').map(s => s.title), ['Section 0']);	// the section holding line 5
});

// ── The real source ──────────────────────────────────────────────────────────────────────

const DAIMOND = path.join(ROOT, 'www/js/daimond.js');
const real = fs.existsSync(DAIMOND) ? fs.readFileSync(DAIMOND, 'utf8') : null;
const rmap = real ? mapSource(real, 'js') : null;

/// Does `text` parse as a whole program, a whole object member, or a whole class member?
/// (`import.meta` and `export` are module-only and `vm.Script` is not a module, so they are
/// let through: the brackets, not the module grammar, are what is on trial.)
function parses(text) {
	if (/import\.meta|^export\b/.test(text)) return true;
	for (const wrap of [t => t, t => '({' + t + '})', t => 'class Q {' + t + '}', t => '(' + t + ')']) {
		try { new vm.Script(wrap(text)); return true; } catch { /* next wrapping */ }
	}
	return false;
}

test('real daimond.js: the brackets balance, so the mask held', { skip: !real }, () => {
	assert.equal(rmap.strays, 0);
	assert.ok(rmap.defs.length > 2000, `only ${rmap.defs.length} definitions`);
	assert.ok(rmap.sections.length > 100, `only ${rmap.sections.length} sections`);
});

test('real daimond.js: twenty random definitions slice out as complete syntactic units', { skip: !real }, () => {
	let seed = 20261002;
	const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
	const pool = rmap.defs.slice();
	for (let i = 0; i < 20; i++) {
		const d = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
		const text = real.slice(d.head, d.end + 1);
		assert.ok(parses(text), `${d.kind} ${d.name} ${d.sl}-${d.el} does not parse: ${JSON.stringify(text.slice(0, 80))}`);
		assert.equal(real.slice(0, d.head).split('\n').length, d.sl, `${d.name} start line`);
		assert.equal(real.slice(0, d.end + 1).split('\n').length, d.el, `${d.name} end line`);
	}
});

test('real daimond.js: every function the map finds is a whole unit (all of them, not a sample)', { skip: !real }, () => {
	const bad = rmap.defs.filter(d => d.kind === 'fn' && !parses(real.slice(d.head, d.end + 1)));
	assert.deepEqual(bad.map(d => `${d.name} ${d.sl}-${d.el}`), []);
});

test('real daimond.js: every `function name(` declaration is on the map', { skip: !real }, () => {
	const have = new Set(rmap.defs.map(d => d.sl));
	const lines = real.split('\n');
	const missed = [];
	lines.forEach((l, i) => {
		if (/^\s*(async\s+)?function\s*\*?\s*[\w$]+\s*\(/.test(l) && !have.has(i + 1)) missed.push(i + 1);
	});
	assert.deepEqual(missed, []);
});

test('real daimond.js: known names land where their source says', { skip: !real }, () => {
	const lines = real.split('\n');
	const want = {
		ensureApp:		{ head: /^\s*function ensureApp\(/,			min: 20 },
		runTurn:		{ head: /^\s*async function runTurn\(/,		min: 300 },
		drawHistoryMessage:	{ head: /^\s*function drawHistoryMessage\(/,		min: 20 },
		pushUserRecord:		{ head: /^\s*function pushUserRecord\(/,		min: 3 },
	};
	for (const [name, w] of Object.entries(want)) {
		const hits = findDefs(rmap, name).hits.filter(d => w.head.test(lines[d.sl - 1]));
		assert.ok(hits.length >= 1, `${name} not found with its own head line`);
		const d = hits.sort((a, b) => (b.el - b.sl) - (a.el - a.sl))[0];
		assert.ok(d.el - d.sl + 1 >= w.min, `${name} is only ${d.el - d.sl + 1} lines`);
		// The last line of a function declared at tab depth n is a lone `}` at tab depth n.
		const indent = lines[d.sl - 1].match(/^\s*/)[0];
		assert.equal(lines[d.el - 1], indent + '}', `${name} ends on ${JSON.stringify(lines[d.el - 1])}`);
	}
});

test('real daimond.js: --at names the function a line is in, and its section', { skip: !real }, () => {
	const d = findDefs(rmap, 'pushUserRecord').hits[0];
	const out = renderAt(rmap, 'daimond.js', d.sl + 1).out.join('\n');
	assert.match(out, /pushUserRecord/);
	assert.match(out, new RegExp(`§ ${rmap.secOf(d.sl).start}-`));
	assert.equal(renderAt(rmap, 'daimond.js', 0).found, false);
});

test('real daimond.js: the section list is small enough to hand an agent', { skip: !real }, () => {
	const out = renderOutline(rmap, 'www/js/daimond.js').join('\n');
	assert.ok(out.length < 14000, `${out.length} chars`);
	assert.match(out, /Next: --section/);
});

test('every www/js/*.js and src/*.rs balances', () => {
	const files = [];
	for (const [dir, re] of [['www/js', /\.js$/], ['src', /\.rs$/]]) {
		const d = path.join(ROOT, dir);
		if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (re.test(f)) files.push([path.join(d, f), re.test('x.rs') ? 'rs' : 'js']);
	}
	assert.ok(files.length > 20, `${files.length} files`);
	const bad = files.filter(([f, lang]) => mapSource(fs.readFileSync(f, 'utf8'), lang).strays > 0).map(([f]) => path.basename(f));
	assert.deepEqual(bad, []);
});
