// www/js/test/page.mjs -- the page's real module graph, loaded fresh for a test.
//
//   import { loadPage } from './test/page.mjs';
//   const P = loadPage({ window: w, stub: { syncWalkPlan: async () => plan }, want: ['collectFiles'] });
//   await P.collectFiles(budget);
//
// Each call makes a new instance of `www/js/page/*.js` (one instance per call: a
// tab), so nothing is shared between two calls but the compiled code. Then it runs,
// in the entry's order, the DECLARING statements of every install (the
// `/* var */ X = …` initialisers the generator moved out of the module bodies), and
// never the others: what a test gets is the page declared, not the page booted. An
// initialiser that throws in the test's window (most often for want of the wasm)
// leaves its name unset and is listed in `P.$faults`.
//
// The modules are not loaded as vm.SourceTextModules: Node (22.22) never collects
// one, so every load kept its whole graph, ~2.2 MB, for the life of the process
// (P1.5d, 29 Oct). The page was one file with one scope, and the generator keeps
// every top-level name unique across the modules, so the modules are joined in
// their evaluation order into the body of one function, compiled once per tree and
// stubbed set: each call of it is a fresh page, and a page nobody holds is
// collected. `import`/`export` syntax is blanked, `import.meta` and `import()`
// routed through the load, and each module's `install` named as the entry imports
// it (`files_install`). A stack's line is the bundle's; `P.$where(line)` names the
// module and its own line (every edit is made within a line).
//
// Three kinds of name can be swapped, all by the one `stub` map:
//   a declaration (exported or the module's own)
//                 its declaration is renamed and a `let` of the stub takes its name,
//                 so every caller sees the stub;
//   a `pg` field  set on `pg` after the declaring statements ran;
//   a page global one of the names the page reads from `window` (free_today.json),
//                 bound to the stub instead of the window's value.
// Any other name is refused: a stub of something the page does not have is a stub
// that outlived its law.
//
// The page's globals come from `window` (a makeWindow, usually), and a name it does
// not hold is undefined unless the language defines it. They are `let`s of the
// bundle, and an own property of the window is turned into an accessor that keeps
// them in step, so a test that sets `w.DaimondCloud` after loading is seen as it
// was under `with (window)`. The window holds each loaded page weakly.
//
// The code runs in this realm (no vm context), so what it makes is deepStrictEqual
// to what a test writes.

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const require	= createRequire(import.meta.url);
const acorn	= require('/usr/share/nodejs/acorn');
const walk	= require('/usr/share/nodejs/acorn-walk');
const HERE	= dirname(fileURLToPath(import.meta.url));
const ROOT	= join(HERE, '..', '..', '..');
const STUBBED	= '$stubbed';
const INSTALL	= /^install(_\d+)?$/;
const NOT_BOUND	= new Set(['undefined', 'Infinity', 'NaN']);	// fixed: the language's own constants

// The language's own globals, which every realm has; any other the window does not
// give, the page does not have (a host API of this process is not the page's).
const LANGUAGE	= new Set(Object.getOwnPropertyNames(vm.runInNewContext('globalThis')));
const trees = new Map();	// root -> the parsed tree

/// The parsed page under `root`: per module its text, top-level names, declarations
/// and install statements; the install order; the page globals.
function tree(root) {
	if (trees.has(root)) return trees.get(root);
	const js = join(root, 'www', 'js');
	const entry = readFileSync(join(js, 'daimond.js'), 'utf8');
	const order = (entry.match(/^\/\/ page-split: order (.*)$/m) || [])[1];
	if (!order) throw new Error('loadPage: ' + root + ' holds a one-file page (no www/js/page/); it cannot be loaded as modules');
	const calls = [...entry.matchAll(/^([a-z_]+?)_(install(?:_\d+)?)\(\);$/gm)].map((m) => [m[1], m[2]]);
	const free = JSON.parse(readFileSync(join(root, 'dev', 'pagesplit', 'free_today.json'), 'utf8'))
		.filter((n) => !NOT_BOUND.has(n));
	const mods = new Map();
	for (const f of readdirSync(join(js, 'page')).filter((f) => f.endsWith('.js')).sort())
		mods.set(f.slice(0, -3), parse(f.slice(0, -3), join(js, 'page', f)));
	const t = { root, mods, calls, free: new Set(free) };
	trees.set(root, t);
	return t;
}

function parse(name, file) {
	const text = readFileSync(file, 'utf8');
	const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
	const top = new Set();		// every name the module scope binds
	const decls = new Map();	// name -> { id, exported } of a top-level declaration
	const installs = new Map();	// install name -> its body's statements
	const ids = (p, out) => {
		if (!p) return out;
		if (p.type === 'Identifier') out.push(p);
		else if (p.type === 'ObjectPattern') p.properties.forEach((q) => ids(q.type === 'RestElement' ? q.argument : q.value, out));
		else if (p.type === 'ArrayPattern') p.elements.forEach((q) => ids(q, out));
		else if (p.type === 'RestElement') ids(p.argument, out);
		else if (p.type === 'AssignmentPattern') ids(p.left, out);
		return out;
	};
	const declare = (d, exported) => {
		if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') {
			top.add(d.id.name);
			decls.set(d.id.name, { id: d.id, exported });
			if (exported && d.type === 'FunctionDeclaration' && INSTALL.test(d.id.name)) installs.set(d.id.name, d.body.body);
		} else if (d.type === 'VariableDeclaration') {
			for (const v of d.declarations) for (const id of ids(v.id, [])) {
				top.add(id.name);
				if (v.id === id) decls.set(id.name, { id, exported });
			}
		}
	};
	const deps = [];	// the modules it imports, in source order
	const cuts = [];	// [start, end, text]: the module syntax a function body cannot hold
	const blank = (a, b) => cuts.push([a, b, text.slice(a, b).replace(/[^\n]/g, ' ')]);
	for (const s of ast.body) {
		if (s.type === 'ImportDeclaration' || s.type === 'ExportAllDeclaration' || (s.type === 'ExportNamedDeclaration' && !s.declaration)) {
			if (s.source) deps.push(s.source.value);
			for (const x of s.specifiers || []) {
				// One scope cannot alias: an import is the exporter's own binding.
				if (s.type === 'ImportDeclaration' && (x.type !== 'ImportSpecifier' || x.imported.name !== x.local.name))
					throw new Error('loadPage: ' + file + ' imports ' + text.slice(x.start, x.end) + ', which one scope cannot alias');
				if (s.type === 'ImportDeclaration') top.add(x.local.name);
			}
			blank(s.start, s.end);
		} else if (s.type === 'ExportNamedDeclaration') {
			blank(s.start, s.declaration.start);
			declare(s.declaration, true);
		} else if (s.type === 'ExportDefaultDeclaration') {
			throw new Error('loadPage: ' + file + ' has a default export, which one scope cannot hold');
		} else declare(s, false);
	}
	const url = pathToFileURL(file).href;
	walk.simple(ast, {
		ImportExpression: (n) => cuts.push([n.start, n.start + 6, '$page.import']),	// fixed: `import`
		MetaProperty: (n) => { if (n.meta.name === 'import') cuts.push([n.start, n.end, '$page.meta(' + JSON.stringify(url) + ')']); },
	});
	const targets = new Set();	// what the install declarations initialise (`X`, `pg.x` as `x`)
	for (const body of installs.values()) for (const s of body) { const d = declares(text, s); if (d) targets.add(d.replace(/^pg\./, '')); }
	return { name, file, text, top, decls, installs, targets, deps, cuts };
}

/// Is the install statement `s` a declaration the generator moved (`/* var */ X = …`)?
/// Answers the name it initialises (`X`, or the `pg` field), or null for a statement
/// that does something.
function declares(text, s) {
	const kw = /\/\* (?:var|let|const) \*\/ $/.test(text.slice(Math.max(0, s.start - 12), s.start));
	if (!kw || s.type !== 'ExpressionStatement' || s.expression.type !== 'AssignmentExpression') return null;
	const l = s.expression.left;
	if (l.type === 'Identifier') return l.name;
	if (l.type === 'MemberExpression' && !l.computed && l.object.type === 'Identifier' && l.object.name === 'pg') return 'pg.' + l.property.name;
	return null;
}

/// The module's text for the bundle: a stubbed declaration renamed (the `let` of
/// the stub is answered as `head`), each install named as the entry imports it, and
/// in each install every statement that is not a declaration (or declares a stubbed
/// name) put behind `if (0)`.
function edited(m, stubbed) {
	const ed = [...m.cuts];		// [start, end, text], applied in order
	let head = '';
	for (const [n, d] of m.decls) {
		if (m.installs.has(n)) { ed.push([d.id.start, d.id.start, m.name + '_']); continue; }
		if (!stubbed.has(n)) continue;
		ed.push([d.id.end, d.id.end, STUBBED]);
		head += 'let ' + n + ' = $page.stub[' + JSON.stringify(n) + ']; ';
	}
	for (const body of m.installs.values()) for (const s of body) {
		const d = declares(m.text, s);
		if (d && !stubbed.has(d) && !stubbed.has(d.replace(/^pg\./, ''))) {
			// An initialiser this window cannot run (the wasm is not bound) leaves its
			// name unset, as the page would be had it stopped there; P.$faults says so.
			ed.push([s.start, s.start, 'try { ']);
			ed.push([s.end, s.end, ' } catch (e) { $page.fault(' + JSON.stringify(d) + ', e); }']);
			continue;
		}
		ed.push([s.start, s.start, 'if (0) { ']);
		ed.push([s.end, s.end, ' }']);
	}
	ed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const parts = [];
	let at = 0;
	for (const [a, b, s] of ed) { parts.push(m.text.slice(at, a), s); at = b; }
	parts.push(m.text.slice(at));
	return { head, text: parts.join('') };
}

/// The page as one function of `$page`, for this stubbed set: compiled once, each
/// call a fresh page. The page globals are `let`s of the outer function, read through
/// `$page.value` and kept in step by `$page.set`; the modules, in their evaluation
/// order (all.js's, depth first), are the body of the inner one it answers, which
/// runs them and answers a getter of their names. The two scopes keep a window's
/// hold on `$page.set` off the modules' state.
function bundle(t, stubbed) {
	const key = [...stubbed].sort().join(' ');
	t.bundles = t.bundles || new Map();
	if (t.bundles.has(key)) return t.bundles.get(key);
	const order = [];
	const seen = new Set();
	const visit = (mn) => {
		if (seen.has(mn)) return;
		seen.add(mn);
		const m = t.mods.get(mn);
		if (!m) throw new Error('loadPage: a page module imports ./' + mn + '.js, which is not under ' + join(t.root, 'www', 'js', 'page'));
		for (const d of m.deps) visit(d.replace(/^\.\//, '').replace(/\.js$/, ''));
		if (mn !== 'all') order.push(mn);
	};
	visit('all');
	const tops = new Set();
	for (const mn of order) for (const n of t.mods.get(mn).top) tops.add(n);
	const env = [...t.free].filter((n) => !tops.has(n));
	let head = "'use strict'; let " + env.map((n) => n + ' = $page.value(' + JSON.stringify(n) + ')').join(', ')
		+ '; $page.set = function (k, v) { switch (k) { ' + env.map((n) => 'case ' + JSON.stringify(n) + ': ' + n + ' = v; break; ').join('') + '} }; return function () { ';
	const parts = [];
	const lines = [];	// [first bundle line, module]
	let line = 2;
	const names = [...owners(t).keys()];
	for (const mn of order) {
		const m = t.mods.get(mn);
		const e = edited(m, stubbed);
		head += e.head;
		parts.push(e.text);
		lines.push([line, mn]);
		line += e.text.split('\n').length;
		for (const n of m.installs.keys()) names.push(mn + '_' + n);
	}
	if (!names.includes('pg')) names.push('pg');
	const body = head + '\n' + parts.join('\n') + '\nreturn function (n) { switch (n) { '
		+ names.map((n) => 'case ' + JSON.stringify(n) + ': return ' + n + '; ').join('') + '} };\n};\n';
	const b = { fn: vm.compileFunction(body, ['$page'], { filename: pathToFileURL(join(t.root, 'www', 'js', 'page', '(bundle)')).href }), lines, env };
	t.bundles.set(key, b);
	return b;
}

/// A window's own data property `k` as an accessor, so a later write reaches every
/// loaded page's binding of it. The window holds each page's setter, which holds
/// the page's globals and not its state (a WeakRef would hold the page itself to the
/// end of the job, and a test's synchronous loop of loads with it).
const windows = new WeakMap();	// window -> { vals, sets }
function watch(win, names) {
	let w = windows.get(win);
	if (!w) { w = { vals: new Map(), sets: new Set() }; windows.set(win, w); }
	for (const k of names) {
		if (w.vals.has(k)) continue;
		const p = Object.getOwnPropertyDescriptor(win, k);
		if (!p || !('value' in p) || !p.configurable) continue;
		w.vals.set(k, p.value);
		Object.defineProperty(win, k, {
			get: () => w.vals.get(k),
			set: (v) => {
				w.vals.set(k, v);
				for (const s of w.sets) s(k, v);
			},
			enumerable: p.enumerable, configurable: true,
		});
	}
	return w;
}

/// The page under `opts.root` (the tree under test: `TREE`, else this one), its
/// globals from `opts.window`, `opts.stub` swapped in, and the names of `opts.want`
/// required to exist. Answers an object whose properties are the page's
/// declarations and `pg` fields, live.
export function loadPage(opts) {
	opts = opts || {};
	const t = tree(opts.root || process.env.TREE || ROOT);
	const win = opts.window || globalThis;
	const stub = opts.stub || {};
	const pgFields = pgOf(t);
	const owner = owners(t);
	const kinds = { export: new Set(), pg: new Set(), global: new Set() };
	const none = [];
	for (const k of Object.keys(stub)) {
		if (owner.has(k)) kinds.export.add(k);
		else if (pgFields.has(k)) kinds.pg.add(k);
		else if (t.free.has(k)) kinds.global.add(k);
		else none.push(k);
	}
	if (none.length) throw new Error('loadPage: no page declaration, pg field or page global is named ' + none.join(', '));
	const b = bundle(t, kinds.export);
	const faults = [];
	const page = pageOf(t, win, stub, kinds.global, faults);
	const w = watch(win, b.env);
	const get = b.fn(page)();
	w.sets.add(page.sink);
	// The declaring statements, in the entry's order; then the pg stubs.
	for (const [mn, fn] of t.calls) {
		if (!t.mods.has(mn) || !t.mods.get(mn).installs.has(fn)) throw new Error('loadPage: the entry calls ' + mn + '_' + fn + ' of no page module');
		get(mn + '_' + fn)();
	}
	const pg = get('pg');
	for (const k of kinds.pg) pg[k] = stub[k];
	const out = {};
	for (const n of owner.keys()) Object.defineProperty(out, n, { get: () => get(n), enumerable: true });
	for (const f of pgFields) if (!(f in out)) Object.defineProperty(out, f, { get: () => pg[f], enumerable: true });
	Object.defineProperty(out, '$faults', { value: faults });
	Object.defineProperty(out, '$where', { value: (line) => {
		let at = null;
		for (const l of b.lines) if (l[0] <= line) at = l;
		return at ? at[1] + '.js:' + (line - at[0] + 1) : '(bundle head)';
	} });
	for (const n of opts.want || []) if (!(n in out)) throw new Error('loadPage: the page declares no ' + n);
	return out;
}

/// The `$page` a bundle is called with. Made apart from loadPage, so that its
/// closures hold none of the page's state.
function pageOf(t, win, stub, global, faults) {
	const dir = pathToFileURL(join(t.root, 'www', 'js', 'page') + '/').href;
	const p = {
		stub, set: null,
		sink: (k, v) => { if (!global.has(k)) p.set(k, v); },
		// `window` is the window given, whether or not it names itself.
		value: (n) => global.has(n) ? stub[n] : n in win ? win[n] : n === 'window' ? win
			: LANGUAGE.has(n) ? globalThis[n] : undefined,
		// The stack is formatted now: an unformatted one holds its frames' closures,
		// and so the whole page, for as long as the fault (the window's setter) lives.
		fault: (n, e) => { if (e instanceof Error) void e.stack; faults.push({ name: n, error: e }); },
		import: (spec) => import(new URL(spec, dir).href),
		meta: (url) => ({ url }),
	};
	return p;
}

/// Every top-level declaration of the page and the module that makes it. A name two
/// modules declare (each to itself) is refused: the one-file page had one scope.
function owners(t) {
	if (t.owner) return t.owner;
	const o = new Map();
	for (const [mn, m] of t.mods) {
		if (mn === 'all') continue;
		for (const n of m.decls.keys()) {
			if (INSTALL.test(n)) continue;
			if (o.has(n)) throw new Error('loadPage: ' + n + ' is declared by both ' + o.get(n) + '.js and ' + mn + '.js');
			o.set(n, mn);
		}
	}
	return (t.owner = o);
}

/// The `pg` fields: the keys of state.js's ctx block.
function pgOf(t) {
	const s = t.mods.get('state');
	if (!t.pg) t.pg = new Set([...(s.text.match(/^\/\/ page-split: ctx\n[\s\S]*?^\/\/ page-split: end ctx$/m) || [''])[0]
		.matchAll(/^\t([\w$]+): undefined,$/gm)].map((m) => m[1]));
	return t.pg;
}

/// Is `root` a split page that loadPage can load?
export function isSplit(root) {
	const e = join(root || process.env.TREE || ROOT, 'www', 'js', 'daimond.js');
	return existsSync(e) && /^\/\/ page-split: order /m.test(readFileSync(e, 'utf8'));
}
