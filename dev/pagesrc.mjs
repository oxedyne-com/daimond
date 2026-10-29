// dev/pagesrc.mjs -- the page's modules re-assembled into the old one-file shape.
//
// The page was one file, `www/js/daimond.js`: a module head and one IIFE over 80k lines.
// Since the cut-over (30 Oct 2026) it is `www/js/page/*.js`, edited by hand; the
// generator that wrote the modules from the one-file base is gone, and this view runs
// one way only: modules -> text. Some 400 dev scripts and slice tests still read the
// page's SOURCE TEXT (lift a function by name, assert a string is in it), and the break
// arms of the browser verifiers patch this view and serve it as js/daimond.js; they read
// the text they were written against: imports and `export ` gone, the top level back
// inside the IIFE at one tab, the `/* let */` keywords and the `pg.` rewrites undone,
// each install body back at the top level. A test that imports the modules
// (`www/js/test/page.mjs`, loadPage) does not need it.
//
// Statement order is module by module, each module in the entry's order.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shiftIndent } from './pagesplit/lex.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARK = 'page-split';
const cache = new Map();

const HEADER	= new RegExp('^// ' + MARK + ': imports[^\\n]*\\n[\\s\\S]*?^// ' + MARK + ': end imports\\n', 'm');
const HOISTED	= new RegExp('^(export )?let [^;]*; // ' + MARK + ': hoisted\\n', 'gm');
const CTXBLOCK	= new RegExp('^// ' + MARK + ': ctx\\n[\\s\\S]*?^// ' + MARK + ': end ctx\\n', 'm');
const BIND	= new RegExp('\\nexport function bindWasm[\\s\\S]*?^\\} // ' + MARK + ': end bind\\n', 'm');
const INSTALL	= new RegExp('\\nexport function install(?:_\\d+)?\\(\\) \\{ // ' + MARK + ': install\\n([\\s\\S]*?)^\\} // ' + MARK + ': end install\\n', 'gm');
const RUN	= new RegExp('^\\t// ' + MARK + ': install ', 'm');
const EXPORT	= /^export (?=(?:async\s+)?function\b|let\b|const\b|var\b|class\b)/gm;
const KEYWORD	= /\/\* (let|const|var) \*\/ /g;
// A module-relative specifier the generator moved one directory down: '../x' was './x'.
const REBASED	= new RegExp("(['\"])\\.\\./([^'\"\\n]*)\\1 /\\* " + MARK + ': rebased \\*/', 'g');
const unRebase	= (t) => t.replace(REBASED, (_, q, p) => q + (p.startsWith('../') ? p : './' + p) + q);

/// The old one-file page, from the modules under `root` (an app tree; this one by
/// default). Cached per root for the life of the process.
export function pageSource(root) {
	root = root || ROOT;
	if (!cache.has(root)) cache.set(root, assemble((f) => readFileSync(join(root, 'www', 'js', f), 'utf8')));
	return cache.get(root);
}

/// The same view of the page as committed at `rev` in the app tree `root` (this one by
/// default), read from git, so a test can run its arms against another revision's code
/// whether that revision's page is one file or the modules.
export function pageSourceAt(rev, root) {
	root = root || ROOT;
	const key = rev + '\0' + root;
	if (!cache.has(key)) cache.set(key, assemble((f) => execFileSync('git', ['show', rev + ':./www/js/' + f],
		{ cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })));
	return cache.get(key);
}

/// The view, from `js(f)`, the text of `www/js/<f>`.
function assemble(js) {
	const entry = js('daimond.js');
	const cut = entry.indexOf('\n// ' + MARK + ': modules');
	// A one-file page (a build before the split, checked out for comparison) is its own view.
	if (cut < 0) return entry;
	const imports = entry.slice(0, cut).split(/(?<=^(?:import [^\n]*|\}) from '[^']+';\n)/m).filter((t) => t.trim());
	const order = (entry.match(new RegExp('^// ' + MARK + ': order (.*)$', 'm')) || [])[1];
	if (!order) throw new Error('pageSource: the entry names no module order');
	const state = js('page/state.js');
	const cb = state.match(CTXBLOCK);
	const pg = cb ? cb[0].match(/export const (\w+) = \{/)[1] : 'pg';
	const fields = cb ? [...cb[0].matchAll(/^\t(\w+): undefined,$/gm)].map((m) => m[1]) : [];
	const unCtx = (t) => {
		if (!fields.length) return t;
		const alt = fields.map((f) => f.replace(/\$/g, '\\$')).join('|');
		return t.replace(new RegExp('(?<![\\w$.])(' + alt + '): ' + pg + '\\.\\1(?![\\w$])', 'g'), '$1')
			.replace(new RegExp('(?<![\\w$.])' + pg + '\\.(' + alt + ')(?![\\w$])', 'g'), '$1');
	};
	const strip = (t) => t.replace(HEADER, '').replace(HOISTED, '').replace(CTXBLOCK, '');
	let head = strip(js('page/wasm.js')).replace(BIND, '').replace(EXPORT, '');
	head = head.replace(new RegExp('^// ' + MARK + ': import (\\d+) \\(in js/daimond.js\\)\\n', 'gm'), (_, n) => imports[+n]);
	let out = head + '(function () {\n\t\'use strict\';\n';
	for (const m of order.split(' ')) {
		const t = strip(js('page/' + m + '.js'));
		// Each install run goes back where its statements stood.
		const runs = new Map();
		const top = t.replace(INSTALL, (_, b) => {
			for (const r of b.split(RUN).slice(1)) { const nl = r.indexOf('\n'); runs.set(r.slice(0, nl), r.slice(nl + 1)); }
			return '';
		});
		out += shiftIndent(top.replace(EXPORT, ''), +1).replace(new RegExp('^\\t// ' + MARK + ': install (\\d+)\\n', 'gm'), (_, n) => runs.get(n));
	}
	return unLift(unRebase(unCtx(out).replace(KEYWORD, '$1 '))) + '})();\n';
}

// An inner module the generator lifted to the top level (`lift` in the manifest): from
// its marker line to `var <name> = <value>; // page-split: end lift`, put back in its
// closure a tab in, `<value>` returned, and the renames the marker names undone.
const LIFTED	= new RegExp('^\\t// ' + MARK + ': lift (\\w+)((?: \\w+=\\w+)*)\\n([\\s\\S]*?)^\\tvar \\1 = ([\\s\\S]*?); // '
	+ MARK + ': end lift$', 'gm');
function unLift(t) {
	return t.replace(LIFTED, (_, name, renames, body, val) => {
		let inner = shiftIndent(body, +1) + shiftIndent('\treturn ' + val + ';', +1);
		for (const r of renames.trim().split(' ').filter(Boolean)) {
			const [from, to] = r.split('=');
			inner = inner.replace(new RegExp('(?<![\\w$])' + to + '(?![\\w$])', 'g'), from);
		}
		return '\tvar ' + name + ' = (function () {\n' + inner + '\n\t})();';
	});
}

/// `readFileSync` for a test that walks www/js file by file: the page entry reads as
/// the view, and the modules under www/js/page/ read as nothing (they are in the view),
/// so a walker sees the page once, under its old name.
export function readPage(p, enc) {
	const s = String(p instanceof URL ? fileURLToPath(p) : p);
	if (/(^|[\\/])www[\\/]js[\\/]daimond\.js$/.test(s)) return pageSource(s.replace(/[\\/]www[\\/]js[\\/]daimond\.js$/, '') || ROOT);
	if (/(^|[\\/])www[\\/]js[\\/]page[\\/][^\\/]+\.js$/.test(s)) return '';
	if (/(^|[\\/])src[\\/][^\\/]+\.rs$/.test(s) && !existsSync(s) && existsSync(s.replace(/\.rs$/, '/mod.rs'))) return engineSource(s);
	return readFileSync(p, enc);
}

/// DATED INTERIM, 29 Oct 2026 (review P1.2): a Rust module that was one file, `src/<m>.rs`, and
/// is now the directory `src/<m>/`, read back as one text for the readers written against the
/// file. `mod.rs` with each `mod x;` replaced by `x.rs` in declared order, and each
/// `#[path = "…"] mod t;` (the tests P1.1 moved to `tests/unit/`) by `mod t { … }`, so product
/// code comes first and the test modules after it, as in the old file. Read only: a script that
/// WRITES `src/<m>.rs` must be moved to the directory itself.
export function engineSource(file) {
	const dir = file.replace(/\.rs$/, '');
	return readFileSync(join(dir, 'mod.rs'), 'utf8')
		.replace(/^#\[path = "([^"]+)"\]\n((?:pub(?:\([a-z]+\))? )?)mod (\w+);$/gm,
			(_, rel, vis, m) => vis + 'mod ' + m + ' {\n' + readFileSync(join(dir, rel), 'utf8') + '}')
		.replace(/^(#\[macro_use\] )?((?:pub(?:\([a-z]+\))? )?)mod (\w+);([^\n]*)$/gm,
			(all, mu, vis, m) => existsSync(join(dir, m + '.rs')) ? readFileSync(join(dir, m + '.rs'), 'utf8') : all);
}
