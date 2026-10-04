// codemap.mjs -- a map of one source file, computed from the file as it is NOW.
//
// WHY. `www/js/daimond.js` is 63,000 lines and the front end is 215,000 over `www/js/*.js`.
// A build agent that has to change one function reads the file wide to find it, and that read
// costs 100k-300k tokens before the first edit. The fix is not a document that says where
// things are -- any such file is stale by the next commit -- but a tool that works it out from
// the tree each time it is asked, and so cannot disagree with it.
//
//   node dev/codemap.mjs www/js/daimond.js                 # the outline (see BUDGET below)
//   node dev/codemap.mjs www/js/daimond.js --sections      # section banners only
//   node dev/codemap.mjs www/js/daimond.js --section Turns # one section's members (regex or a line)
//   node dev/codemap.mjs www/js/daimond.js --full          # every member of every section
//   node dev/codemap.mjs www/js/daimond.js ensureApp       # where it is, its range, who calls it
//   node dev/codemap.mjs www/js/daimond.js --at 14900      # what a line sits in
//   node dev/codemap.mjs --all drawHistoryMessage          # search every www/js/*.js and src/*.rs
//   node dev/codemap.mjs src/tools.rs --check              # does the scanner balance on this file?
//
// Then read ONLY the range it gives: `sed -n '14850,15200p' www/js/daimond.js`.
//
// HOW. Two steps, neither of which is a parser.
//
//   1. MASK. Comments, strings, template-literal text and regex literals are overwritten with
//      blanks (or `·` for string-ish interiors), keeping every newline and every index. What is
//      left is only code, so a `{` is a brace and a `//` inside a URL is not a comment. The
//      mask is the whole trick: brace matching on the raw text is wrong the first time a regex
//      holds a `{`.
//   2. MATCH. Definition heads are found with line-anchored patterns over the masked text, and
//      the end of each is its matching bracket, which one pass has already paired up. So a
//      range is a bracket match and not a guess about indentation.
//
// WHAT IT KNOWS. JavaScript: `function`, `async function`, `var|let|const x = function|=>`,
// `x = function`, `window.X = {` / `= (function () {` modules, `key: function`/`key(…) {` object
// members, `class`, and `window.addEventListener('evt', …)` at statement level. Rust: `fn`,
// `impl`, `mod`, `struct`, `enum`, `trait`, `type`, `const`/`static`, `macro_rules!`. Sections
// are the `// ── Title ──` banners (also `// === Title ===` and `// --- Title ---`).
//
// WHAT IT DOES NOT. It is not a parser, and says so rather than guessing: a definition that
// does not START a line (`}); function f() {`), a quoted object key (`'a-b': function`), a
// destructured binding, and a function built by a call (`const f = wrap(function () {`) are not
// found. A name that is only ever called is found by the call-site count, not the map.
// `--check` reports whether the brackets balance, which is the cheapest sign the mask held.
//
// BUDGET. A bare `codemap <file>` prints the full outline when that is under ~14,000 characters
// (about 3.5k tokens) and the section list otherwise, with a line saying how to go on. The
// full outline of `daimond.js` is ~14x that; nobody should be handed it by accident.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const BUDGET = 14000;		// characters of full outline a bare invocation will print

// ── Masking ──────────────────────────────────────────────────────────────────────────────

const isId = c => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36 || c > 127;

// After these a `/` begins a regex; after any other word it divides.
const REGEX_AFTER = new Set([
	'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
	'case', 'do', 'else', 'yield', 'await',
]);

/// Overwrite everything in JavaScript that is not code, keeping length, newlines and indices.
/// Comments become spaces; string, template-text and regex interiors become `·`.
export function maskJs(src) {
	const n = src.length;
	const out = [];
	let mark = 0;			// start of the code run not yet copied
	let last = '';			// 'v' after a value, else the last significant code character
	let word = '';			// the last identifier read, for the regex-or-divide call
	const stk = [];			// '{' for a block, '$' for a template expression
	const put = (a, b, fill) => {
		if (a > mark) out.push(src.slice(mark, a));
		out.push(src.slice(a, b).replace(/[^\n]/g, fill));
		mark = b;
	};
	// Template text from `i`; returns where code resumes. A `${` pushes and resumes code.
	const tpl = i => {
		const from = i;
		while (i < n) {
			const c = src.charCodeAt(i);
			if (c === 92) { i += 2; continue; }
			if (c === 96) { put(from, i, '·'); last = 'v'; return i + 1; }
			if (c === 36 && src.charCodeAt(i + 1) === 123) {
				put(from, i, '·');
				stk.push('$');
				last = '{';
				return i + 2;
			}
			i++;
		}
		put(from, n, '·');
		return n;
	};
	let i = 0;
	while (i < n) {
		const c = src.charCodeAt(i);
		if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
		if (c === 47) {
			const d = src.charCodeAt(i + 1);
			if (d === 47) {
				let e = src.indexOf('\n', i);
				if (e < 0) e = n;
				put(i, e, ' ');
				i = e;
				continue;
			}
			if (d === 42) {
				let e = src.indexOf('*/', i + 2);
				e = e < 0 ? n : e + 2;
				put(i, e, ' ');
				i = e;
				continue;
			}
			const value = last === 'v' || last === ')' || last === ']'
				|| (last === 'w' && !REGEX_AFTER.has(word));
			if (!value) {
				let j = i + 1;
				let cls = false;
				let ok = false;
				while (j < n) {
					const e = src.charCodeAt(j);
					if (e === 10) break;
					if (e === 92) { j += 2; continue; }
					if (e === 91) cls = true;
					else if (e === 93) cls = false;
					else if (e === 47 && !cls) { ok = true; break; }
					j++;
				}
				if (ok) {
					put(i + 1, j, '·');
					i = j + 1;
					while (i < n && isId(src.charCodeAt(i))) i++;		// flags
					last = 'v';
					continue;
				}
			}
			last = '/';
			i++;
			continue;
		}
		if (c === 39 || c === 34) {
			let j = i + 1;
			while (j < n) {
				const e = src.charCodeAt(j);
				if (e === 92) { j += 2; continue; }
				if (e === c || e === 10) break;
				j++;
			}
			put(i + 1, Math.min(j, n), '·');
			i = j + 1;
			last = 'v';
			continue;
		}
		if (c === 96) { i = tpl(i + 1); continue; }
		if (c === 123) { stk.push('{'); last = '{'; i++; continue; }
		if (c === 125) {
			if (stk.pop() === '$') { i = tpl(i + 1); continue; }
			last = '}';
			i++;
			continue;
		}
		if (isId(c)) {
			let j = i + 1;
			while (j < n && isId(src.charCodeAt(j))) j++;
			word = src.slice(i, j);
			last = (c >= 48 && c <= 57) ? 'v' : 'w';
			i = j;
			continue;
		}
		last = String.fromCharCode(c);
		i++;
	}
	if (mark < n) out.push(src.slice(mark));
	return out.join('');
}

/// The same for Rust: comments (block ones nest), strings, raw strings, char literals.
/// A lifetime (`'a`) is not a char literal and is left alone.
export function maskRs(src) {
	const n = src.length;
	const out = [];
	let mark = 0;
	const put = (a, b, fill) => {
		if (a > mark) out.push(src.slice(mark, a));
		out.push(src.slice(a, b).replace(/[^\n]/g, fill));
		mark = b;
	};
	let i = 0;
	while (i < n) {
		const c = src.charCodeAt(i);
		if (c === 47) {
			const d = src.charCodeAt(i + 1);
			if (d === 47) {
				let e = src.indexOf('\n', i);
				if (e < 0) e = n;
				put(i, e, ' ');
				i = e;
				continue;
			}
			if (d === 42) {
				let depth = 1;
				let j = i + 2;
				while (j < n && depth > 0) {
					if (src.charCodeAt(j) === 47 && src.charCodeAt(j + 1) === 42) { depth++; j += 2; }
					else if (src.charCodeAt(j) === 42 && src.charCodeAt(j + 1) === 47) { depth--; j += 2; }
					else j++;
				}
				put(i, j, ' ');
				i = j;
				continue;
			}
			i++;
			continue;
		}
		if (c === 34) {
			let j = i + 1;
			while (j < n && src.charCodeAt(j) !== 34) j += src.charCodeAt(j) === 92 ? 2 : 1;
			put(i + 1, Math.min(j, n), '·');
			i = j + 1;
			continue;
		}
		if (c === 39) {
			if (src.charCodeAt(i + 1) === 92) {		// '\n', '\'', '\u{…}'
				let j = i + 3;
				while (j < n && src.charCodeAt(j) !== 39) j++;
				put(i + 1, Math.min(j, n), '·');
				i = j + 1;
			} else if (src.charCodeAt(i + 2) === 39) {	// 'x'
				put(i + 1, i + 2, '·');
				i += 3;
			} else {
				i++;						// a lifetime or a label
			}
			continue;
		}
		if (isId(c)) {
			let j = i + 1;
			while (j < n && isId(src.charCodeAt(j))) j++;
			const w = src.slice(i, j);
			if ((w === 'r' || w === 'br') && (src[j] === '"' || src[j] === '#')) {
				let h = 0;
				while (src[j + h] === '#') h++;
				if (src[j + h] === '"') {
					const close = '"' + '#'.repeat(h);
					let e = src.indexOf(close, j + h + 1);
					e = e < 0 ? n : e;
					put(j + h + 1, e, '·');
					i = Math.min(n, e + close.length);
					continue;
				}
			}
			i = j;
			continue;
		}
		i++;
	}
	if (mark < n) out.push(src.slice(mark));
	return out.join('');
}

/// Pair every `{ ( [` with its closer in one pass. `strays` counts closers with no opener and
/// openers never closed: zero means the mask held and the brackets balance.
export function pairUp(m) {
	const n = m.length;
	const pair = new Int32Array(n).fill(-1);
	const stack = [];
	let strays = 0;
	for (let i = 0; i < n; i++) {
		const c = m.charCodeAt(i);
		if (c === 123 || c === 40 || c === 91) {
			stack.push(i);
		} else if (c === 125 || c === 41 || c === 93) {
			const want = c === 125 ? 123 : c === 41 ? 40 : 91;
			let k = stack.length - 1;
			while (k >= 0 && m.charCodeAt(stack[k]) !== want) k--;
			if (k < 0) { strays++; continue; }
			strays += stack.length - 1 - k;
			const o = stack[k];
			stack.length = k;
			pair[o] = i;
			pair[i] = o;
		}
	}
	return { pair, strays: strays + stack.length };
}

// ── Finding definitions ──────────────────────────────────────────────────────────────────

const CALLABLE = new Set(['fn']);
const CONTAINER = new Set(['obj', 'mod', 'class', 'impl', 'trait']);

// A line ending in one of these goes on; so does one beginning with one of those.
const CONT_END = '+-*/%&|^?:=<>!.,([{~·';
const CONT_START = '.,?:+-*/%&|^=<>';

/// Where a statement that begins before `i` ends (the index of its last character).
/// `asi` lets a newline end it where JavaScript would; Rust sets it false and waits for `;`.
function stmtEnd(m, pair, i, stopComma, asi) {
	const n = m.length;
	while (i < n) {
		const c = m.charCodeAt(i);
		if (c === 123 || c === 40 || c === 91) {
			const p = pair[i];
			if (p < 0) { const e = m.indexOf('\n', i); return e < 0 ? n - 1 : e - 1; }
			i = p + 1;
			continue;
		}
		if (c === 125 || c === 41 || c === 93) return i - 1;
		if (c === 59) return i;
		if (c === 44 && stopComma) return i - 1;
		if (c === 10 && asi) {
			let a = i - 1;
			while (a >= 0 && /\s/.test(m[a])) a--;
			let b = i + 1;
			while (b < n && /\s/.test(m[b])) b++;
			if (a >= 0 && !CONT_END.includes(m[a]) && !CONT_START.includes(m[b] || ';')
				&& !(m[b] === '(' || m[b] === '[' || m[b] === '`')) return a;
		}
		i++;
	}
	return n - 1;
}

const skipWs = (m, i) => { while (i < m.length && /\s/.test(m[i])) i++; return i; };

const NOT_METHOD = new Set([
	'if', 'for', 'while', 'switch', 'catch', 'function', 'with', 'return', 'typeof', 'await',
	'new', 'delete', 'void', 'throw', 'super', 'do', 'else', 'yield', 'in', 'of', 'import',
	'export', 'case',
]);

const reTrim = s => s.length - s.trimStart().length;

/// Every definition head in a masked JavaScript file, unsorted and unpruned.
function findJs(src, m, pair) {
	const defs = new Map();		// head index -> def, so two patterns cannot report one head
	const add = (kind, full, head, end, extra = {}) => {
		if (end < head || defs.has(head)) return;
		defs.set(head, { kind, full, head, end, ...extra });
	};
	const rx = (re, f) => { re.lastIndex = 0; let x; while ((x = re.exec(m))) f(x); };

	// function declarations.
	rx(/^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?(async[ \t]+)?function\b[ \t]*\*?[ \t]*([A-Za-z_$][\w$]*)[ \t]*\(/gm, x => {
		const head = x.index + reTrim(x[0]);
		const cl = pair[x.index + x[0].length - 1];
		if (cl < 0) return;
		const j = skipWs(m, cl + 1);
		if (m[j] !== '{' || pair[j] < 0) return;
		add('fn', x[2], head, pair[j], { async: !!x[1] });
	});

	// assignments: functions, arrows, modules, objects, arrays, and declared values.
	rx(/^[ \t]*(?:export[ \t]+)?(?:(var|let|const)[ \t]+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)[ \t]*=(?![=>])[ \t]*/gm, x => {
		const head = x.index + reTrim(x[0]);
		const p = x.index + x[0].length;
		const decl = x[1];
		const full = x[2];
		const rest = m.slice(p, p + 160);
		let y;
		if ((y = /^(async[ \t]+)?function\b/.exec(rest))) {
			const q = m.indexOf('(', p);
			const cl = q < 0 ? -1 : pair[q];
			const j = cl < 0 ? -1 : skipWs(m, cl + 1);
			if (j >= 0 && m[j] === '{' && pair[j] >= 0) add('fn', full, head, pair[j], { async: !!y[1] });
		} else if ((y = /^(async[ \t]+)?\(/.exec(rest))) {
			const q = p + y[0].length - 1;
			const cl = pair[q];
			if (cl < 0) return;
			const j = skipWs(m, cl + 1);
			if (m.startsWith('=>', j)) {		// arrow with a parameter list
				const b = skipWs(m, j + 2);
				const end = m[b] === '{' && pair[b] >= 0 ? pair[b] : stmtEnd(m, pair, b, false, true);
				add('fn', full, head, end, { async: !!y[1] });
			} else if (/^\(\s*(async\s+)?(function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/.test(rest)) {
				add('mod', full, head, stmtEnd(m, pair, p, false, true));
			}
		} else if ((y = /^(async[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*=>/.exec(rest))) {
			const b = skipWs(m, p + y[0].length);
			const end = m[b] === '{' && pair[b] >= 0 ? pair[b] : stmtEnd(m, pair, b, false, true);
			add('fn', full, head, end, { async: !!y[1] });
		} else if (rest[0] === '{' && pair[p] >= 0) {
			add('obj', full, head, stmtEnd(m, pair, p, false, true));
		} else if (rest[0] === '[' && pair[p] >= 0) {
			add('arr', full, head, stmtEnd(m, pair, p, false, true));
		} else if (decl) {
			add('var', full, head, stmtEnd(m, pair, p, false, true));
		}
	});

	// object-literal members written `key: function`, `key: async (…) =>`, `key: x =>`.
	rx(/^[ \t]*(?:(async)[ \t]+)?([A-Za-z_$][\w$]*)[ \t]*:[ \t]*(?=async\b|function\b|\(|[A-Za-z_$][\w$]*[ \t]*=>)/gm, x => {
		const head = x.index + reTrim(x[0]);
		let p = x.index + x[0].length;
		let isAsync = !!x[1];
		let y;
		if ((y = /^async[ \t]+/.exec(m.slice(p, p + 8)))) { isAsync = true; p += y[0].length; }
		const rest = m.slice(p, p + 160);
		if (/^function\b/.test(rest)) {
			const q = m.indexOf('(', p);
			const cl = q < 0 ? -1 : pair[q];
			const j = cl < 0 ? -1 : skipWs(m, cl + 1);
			if (j >= 0 && m[j] === '{' && pair[j] >= 0) add('fn', x[2], head, pair[j], { async: isAsync, member: true });
		} else if (rest[0] === '(') {
			const cl = pair[p];
			if (cl < 0) return;
			const j = skipWs(m, cl + 1);
			if (!m.startsWith('=>', j)) return;
			const b = skipWs(m, j + 2);
			const end = m[b] === '{' && pair[b] >= 0 ? pair[b] : stmtEnd(m, pair, b, true, true);
			add('fn', x[2], head, end, { async: isAsync, member: true });
		} else if ((y = /^[A-Za-z_$][\w$]*[ \t]*=>/.exec(rest))) {
			const b = skipWs(m, p + y[0].length);
			const end = m[b] === '{' && pair[b] >= 0 ? pair[b] : stmtEnd(m, pair, b, true, true);
			add('fn', x[2], head, end, { async: isAsync, member: true });
		}
	});

	// methods: `name(args) {`, `async name(args) {`, `get name() {`, `static name() {`.
	rx(/^[ \t]*((?:(?:async|static|get|set)[ \t]+)*)\*?[ \t]*([A-Za-z_$][\w$]*)[ \t]*\(/gm, x => {
		const name = x[2];
		if (NOT_METHOD.has(name)) return;
		const head = x.index + reTrim(x[0]);
		const q = x.index + x[0].length - 1;
		const cl = pair[q];
		if (cl < 0) return;
		const j = skipWs(m, cl + 1);
		if (m[j] !== '{' || pair[j] < 0) return;
		add('fn', name, head, pair[j], { async: /\basync\b/.test(x[1]), member: true });
	});

	// classes.
	rx(/^[ \t]*(?:export[ \t]+(?:default[ \t]+)?)?class[ \t]+([A-Za-z_$][\w$]*)[^{;]*\{/gm, x => {
		const q = x.index + x[0].length - 1;
		if (pair[q] < 0) return;
		add('class', x[1], x.index + reTrim(x[0]), pair[q]);
	});

	// `window.addEventListener('daimond:mail-arrived', …)` at statement level.
	rx(/^[ \t]*(?:window|document|globalThis)\.addEventListener[ \t]*\([ \t]*(['"`])/gm, x => {
		const head = x.index + reTrim(x[0]);
		const s = x.index + x[0].length;
		const e = src.indexOf(x[1], s);
		if (e < 0) return;
		const open = m.indexOf('(', head);
		const cl = open < 0 ? -1 : pair[open];
		if (cl < 0) return;
		add('on', src.slice(s, e), head, stmtEnd(m, pair, cl + 1, false, true));
	});

	return [...defs.values()];
}

const RS_VIS = '(?:pub(?:\\([^)]*\\))?[ \\t]+)?';

/// Skip a generic parameter list `<…>` starting at `i` (if there is one). `->` is not a bracket.
function skipAngles(m, i) {
	i = skipWs(m, i);
	if (m[i] !== '<') return i;
	let d = 0;
	for (; i < m.length; i++) {
		if (m[i] === '<') d++;
		else if (m[i] === '>' && m[i - 1] !== '-') { d--; if (d === 0) return i + 1; }
		else if (m[i] === '{' || m[i] === ';') return i;
	}
	return i;
}

/// From `i`, the first `{` (a body) or `;` (none) outside any `( )`/`[ ]`; -1 if neither.
function bodyOrSemi(m, pair, i) {
	for (; i < m.length; i++) {
		const c = m[i];
		if (c === '{' || c === ';') return i;
		if (c === '(' || c === '[') { if (pair[i] < 0) return -1; i = pair[i]; }
	}
	return -1;
}

/// Every definition head in a masked Rust file.
function findRs(src, m, pair) {
	const defs = new Map();
	const add = (kind, full, head, end, extra = {}) => {
		if (end < head || defs.has(head)) return;
		defs.set(head, { kind, full, head, end, ...extra });
	};
	const rx = (re, f) => { re.lastIndex = 0; let x; while ((x = re.exec(m))) f(x); };

	rx(new RegExp('^[ \\t]*' + RS_VIS + '(?:(default|const|async|unsafe|extern(?:[ \\t]+"[^"]*")?)[ \\t]+)*fn[ \\t]+([A-Za-z_]\\w*)', 'gm'), x => {
		const head = x.index + reTrim(x[0]);
		let i = skipAngles(m, x.index + x[0].length);
		if (m[i] !== '(' || pair[i] < 0) return;
		const b = bodyOrSemi(m, pair, pair[i] + 1);
		if (b < 0) return;
		add('fn', x[2], head, m[b] === '{' ? pair[b] : b, { async: /\basync\b/.test(x[0]) });
	});
	rx(new RegExp('^[ \\t]*(?:unsafe[ \\t]+)?impl\\b', 'gm'), x => {
		const head = x.index + reTrim(x[0]);
		const b = bodyOrSemi(m, pair, x.index + x[0].length);
		if (b < 0 || m[b] !== '{' || pair[b] < 0) return;
		let t = m.slice(skipAngles(m, x.index + x[0].length), b).replace(/\bwhere\b[\s\S]*$/, '');
		t = t.replace(/\s+/g, ' ').trim();
		add('impl', t, head, pair[b]);
	});
	rx(new RegExp('^[ \\t]*' + RS_VIS + 'mod[ \\t]+(\\w+)[ \\t]*\\{', 'gm'), x => {
		const q = x.index + x[0].length - 1;
		if (pair[q] >= 0) add('mod', x[1], x.index + reTrim(x[0]), pair[q]);
	});
	rx(new RegExp('^[ \\t]*' + RS_VIS + '(?:unsafe[ \\t]+)?(struct|enum|trait|union)[ \\t]+(\\w+)', 'gm'), x => {
		const head = x.index + reTrim(x[0]);
		const b = bodyOrSemi(m, pair, skipAngles(m, x.index + x[0].length));
		if (b < 0) return;
		const kind = x[1] === 'trait' ? 'trait' : x[1] === 'union' ? 'struct' : x[1];
		add(kind, x[2], head, m[b] === '{' ? pair[b] : b);
	});
	rx(new RegExp('^[ \\t]*' + RS_VIS + 'type[ \\t]+(\\w+)', 'gm'), x => {
		add('type', x[1], x.index + reTrim(x[0]), stmtEnd(m, pair, x.index + x[0].length, false, false));
	});
	rx(new RegExp('^[ \\t]*' + RS_VIS + '(?:const|static)[ \\t]+(?:mut[ \\t]+)?([A-Z_][A-Z0-9_]*)\\b', 'gm'), x => {
		add('var', x[1], x.index + reTrim(x[0]), stmtEnd(m, pair, x.index + x[0].length, false, false));
	});
	rx(/^[ \t]*macro_rules![ \t]*([A-Za-z_]\w*)/gm, x => {
		add('macro', x[1], x.index + reTrim(x[0]), stmtEnd(m, pair, x.index + x[0].length, false, false));
	});
	return [...defs.values()];
}

// ── The map ──────────────────────────────────────────────────────────────────────────────

const BANNER = /^([─━═]{2,}|={3,}|-{3,})[ \t]*(.*?)[ \t]*(?:[─━═]+|[=\-–]{2,})?[ \t]*$/;

/// Map one source file: every definition with its range, nested by containment, and the section
/// banners. `lang` is 'js' or 'rs'. Pure: nothing is read from disk.
export function mapSource(src, lang) {
	const m = lang === 'rs' ? maskRs(src) : maskJs(src);
	const { pair, strays } = pairUp(m);
	const starts = [0];
	for (let i = src.indexOf('\n'); i >= 0; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
	const nlines = src[src.length - 1] === '\n' ? starts.length - 1 : starts.length;
	const lineOf = idx => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (starts[mid] <= idx) lo = mid; else hi = mid - 1;
		}
		return lo + 1;
	};
	const srcLines = src.split('\n');
	const mLines = m.split('\n');

	// Comment-only lines: blank once masked, not blank in the source. They carry banners and
	// the one-line gloss above a definition.
	const comment = new Array(srcLines.length + 2).fill(null);
	const banners = [];
	for (let i = 0; i < srcLines.length; i++) {
		const t = srcLines[i].trim();
		if (!t || mLines[i].trim()) continue;
		const own = t.startsWith('//');
		const one = /^\/\*.*\*\/$/.test(t);
		const text = t.replace(/^\/\/[\/!]?[ \t]?/, '').replace(/^\/\*+[ \t]?/, '')
			.replace(/[ \t]?\*+\/$/, '').replace(/^\*+[ \t]?/, '').trim();
		comment[i + 1] = { text, banner: own || one };
		if (own || one) {
			const b = BANNER.exec(own ? t.replace(/^\/\/[ \t]?/, '') : text);
			if (b && b[2] && /[\p{L}\p{N}]/u.test(b[2])) {
				const ind = srcLines[i].match(/^[ \t]*/)[0];
				banners.push({
					line:	i + 1,
					title:	b[2],
					indent:	(ind.match(/\t/g) || []).length + Math.floor(ind.replace(/\t/g, '').length / 4),
				});
			}
		}
	}

	// Definitions, nested by containment, then pruned of what is not worth a name.
	const raw = (lang === 'rs' ? findRs(src, m, pair) : findJs(src, m, pair))
		.sort((a, b) => a.head - b.head || b.end - a.end);
	const defs = [];
	const stack = [];
	for (const d of raw) {
		while (stack.length && !(d.head >= stack[stack.length - 1].head && d.end <= stack[stack.length - 1].end)) stack.pop();
		const up = stack[stack.length - 1] || null;
		// Inside a function only functions are worth a name; locals are noise.
		if (up && (up.kind === 'fn' || up.inFn) && !CALLABLE.has(d.kind)) continue;
		d.parent = up;
		d.level = up ? up.level + 1 : 0;
		d.inFn = !!up && (up.kind === 'fn' || up.inFn);
		d.sl = lineOf(d.head);
		d.el = lineOf(d.end);
		d.children = [];
		if (up) up.children.push(d);
		defs.push(d);
		stack.push(d);
	}

	// A single container wrapping most of the file (`var X = (function () {` … `})()`) is the
	// file's own wrapper and not a member of it: lift its children one level.
	let wrapper = null;
	const tops = defs.filter(d => d.level === 0 && CONTAINER.has(d.kind));
	if (tops.length === 1 && tops[0].el - tops[0].sl >= 0.8 * nlines) {
		wrapper = tops[0];
		const lift = d => { d.level--; d.children.forEach(lift); };
		wrapper.children.forEach(c => { c.parent = null; lift(c); });
		defs.splice(defs.indexOf(wrapper), 1);
	}
	for (const d of defs) {
		d.name = d.full.replace(/^(?:window|globalThis|this)\./, '');
		d.short = d.name.replace(/^.*\./, '');
		d.title = d.full === d.name ? d.name : d.name;
	}

	// Who owns each banner: the innermost definition it sits inside, or nobody (a section).
	for (const b of banners) {
		let own = null;
		for (const d of defs) {
			if (d.sl < b.line && b.line <= d.el && (!own || d.sl >= own.sl)) own = d;
		}
		b.owner = own;
	}
	const top = banners.filter(b => !b.owner).sort((a, b) => a.line - b.line);
	const level0 = defs.filter(d => d.level === 0);
	const sections = top.map(b => ({ title: b.title, start: b.line, end: 0, defs: [] }));
	if (!sections.length || (level0.length && level0[0].sl < sections[0].start)) {
		sections.unshift({ title: sections.length ? '(before the first banner)' : '(whole file)', start: 1, end: 0, defs: [] });
	}
	// The last non-blank, non-closer line is where the final section stops.
	let tail = nlines;
	while (tail > 1 && /^[\s})\];,]*$/.test(mLines[tail - 1] || '')) tail--;
	sections.forEach((s, i) => {
		let e = i + 1 < sections.length ? sections[i + 1].start - 1 : tail;
		while (e > s.start && !(mLines[e - 1] || '').trim() && !comment[e]) e--;
		s.end = Math.max(e, s.start);
		s.idx = i;
	});
	const secOf = line => {
		let k = 0;
		for (let i = 0; i < sections.length; i++) if (sections[i].start <= line) k = i;
		return sections[k];
	};
	for (const d of level0) secOf(d.sl).defs.push(d);

	return {
		lang, src, masked: m, pair, strays, starts, nlines, lineOf, srcLines, mLines, comment,
		defs, banners, sections, secOf, wrapper,
	};
}

/// The first line of the comment block directly above a definition, if there is one.
export function gloss(map, d, max = 72) {
	let l = d.sl - 1;
	while (l >= 1 && /^\s*#\[/.test(map.srcLines[l - 1])) l--;		// Rust attributes
	const block = [];
	while (l >= 1 && map.comment[l] && !isBannerText(map.comment[l].text)) {
		block.unshift(map.comment[l].text);
		l--;
	}
	const first = block.find(t => t && /[\p{L}\p{N}]/u.test(t));
	if (!first) return '';
	let t = first.replace(/`/g, '');
	const cut = t.search(/[.!?](?:\s|$)/);
	if (cut > 12 && cut < max) t = t.slice(0, cut + 1);
	return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

const isBannerText = t => { const b = BANNER.exec(t); return !!(b && b[2]); };

// ── Rendering ────────────────────────────────────────────────────────────────────────────

const rng = d => `${d.sl}-${d.el}`;
const tag = d => d.kind === 'fn' ? (d.async ? 'async ' : '') : d.kind + ' ';
const plural = (n, w) => `${n} ${w}`;

/// A definition is worth a line in the outline if it is code, or a data block big enough to skip.
const worth = d => !(d.kind === 'var' || d.kind === 'arr' || (d.kind === 'obj' && !d.children.some(c => c.kind === 'fn')))
	|| d.el - d.sl >= 6;

function itemLine(d, indent, withGloss, map) {
	let s = ' '.repeat(indent) + rng(d).padEnd(11) + ' ' + tag(d) + d.name;
	if (withGloss) { const g = gloss(map, d); if (g) s += '   ' + g; }
	return s;
}

/// Is this child shown at the requested depth? With no depth, a container's members are shown
/// and a function's inner functions are not.
function shown(d, depth) {
	if (!worth(d)) return false;
	if (depth != null) return d.level <= depth;
	for (let p = d.parent; p; p = p.parent) if (!CONTAINER.has(p.kind)) return false;
	return true;
}

function emit(map, d, out, opts, indent) {
	out.push(itemLine(d, indent, opts.gloss, map));
	// Landmarks: the banners that sit inside this definition and not inside a child of it.
	const subs = map.banners.filter(b => b.owner === d);
	const kids = d.children.filter(c => shown(c, opts.depth));
	const rows = [
		...kids.map(c => ({ line: c.sl, c })),
		...subs.map(b => ({ line: b.line, b })),
	].sort((a, b) => a.line - b.line);
	for (const r of rows) {
		if (r.c) emit(map, r.c, out, opts, indent + 2);
		else out.push(' '.repeat(indent + 2) + `§ ${r.b.line} ${r.b.title}`);
	}
}

function sectionHead(s) {
	const c = {};
	for (const d of s.defs) if (worth(d) || d.kind === 'fn') c[d.kind] = (c[d.kind] || 0) + 1;
	const parts = Object.entries(c).map(([k, n]) => plural(n, k));
	return `§ ${(s.start + '-' + s.end).padEnd(11)} ${s.title}` + (parts.length ? `   [${parts.join(', ')}]` : '');
}

function header(map, file) {
	const n = map.defs.length;
	return `# ${file}  ${map.nlines} lines, ${n} definitions, ${map.sections.length} sections`
		+ (map.strays ? `  (WARNING: ${map.strays} unbalanced brackets, ranges may be wrong)` : '');
}

/// The section list alone.
export function renderSections(map, file) {
	return [header(map, file), ...map.sections.map(sectionHead)];
}

/// Members of the sections in `list`, or of every section.
export function renderMembers(map, file, list, opts = {}) {
	const out = [header(map, file)];
	for (const s of list) {
		out.push(sectionHead(s));
		for (const d of s.defs) if (shown(d, opts.depth)) emit(map, d, out, opts, 2);
	}
	return out;
}

/// The outline: in full when it fits the budget, the section list when it does not.
export function renderOutline(map, file, opts = {}) {
	const full = renderMembers(map, file, map.sections, opts);
	const size = full.join('\n').length;
	if (opts.full || size <= (opts.budget || BUDGET)) return full;
	return [
		...renderSections(map, file),
		`(full outline is ${size.toLocaleString('en')} chars, about ${Math.round(size / 4000)}k tokens; this is the section list.`,
		` Next: --section <title or line> for one section's members, <name> to find a definition, --at <line>.)`,
	];
}

/// Sections whose title matches `q` (a regex, case-insensitive), or the one holding line `q`.
export function pickSections(map, q) {
	if (/^\d+$/.test(q)) return [map.secOf(Number(q))];
	let re;
	try { re = new RegExp(q, 'i'); } catch { re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
	return map.sections.filter(s => re.test(s.title));
}

function queryRe(q) {
	const lit = /^\/(.+)\/([a-z]*)$/.exec(q);
	if (lit) return new RegExp(lit[1], lit[2]);
	if (/[\^$*+?()[\]{}|\\]/.test(q)) return new RegExp(q);
	return null;
}

/// Definitions matching `q`: an exact name (or `Parent.name`), else a regex, else a substring.
export function findDefs(map, q) {
	const re = queryRe(q);
	const chain = d => { const a = []; for (let p = d; p; p = p.parent) a.unshift(p.name); return a.join('.'); };
	if (re) return { how: 'regex', hits: map.defs.filter(d => re.test(d.name) || re.test(chain(d))) };
	const exact = map.defs.filter(d => d.name === q || d.short === q || chain(d) === q || chain(d).endsWith('.' + q));
	if (exact.length) return { how: 'exact', hits: exact };
	const low = q.toLowerCase();
	return { how: 'substring', hits: map.defs.filter(d => d.name.toLowerCase().includes(low)) };
}

/// Lines that call (`name(`) or mention each name outside its own definition head.
export function usage(map, names) {
	const want = new Set(names);
	const res = new Map([...want].map(n => [n, { calls: [], refs: [] }]));
	const heads = new Set(map.defs.map(d => d.short + '@' + d.sl));
	const re = /[A-Za-z_$][\w$]*/g;
	const m = map.masked;
	let x;
	while ((x = re.exec(m))) {
		const w = x[0];
		if (!want.has(w)) continue;
		const ln = map.lineOf(x.index);
		if (heads.has(w + '@' + ln)) continue;
		let k = re.lastIndex;
		while (m[k] === ' ' || m[k] === '\t') k++;
		const bucket = res.get(w)[m[k] === '(' ? 'calls' : 'refs'];
		if (bucket[bucket.length - 1] !== ln) bucket.push(ln);
	}
	return res;
}

// A name a call can be searched for: not `Default for Limits`, not an event.
const ident = d => d.kind !== 'on' && /^[\w$]+$/.test(d.short);

const lines = (a, cap) => a.length <= cap ? a.join(' ') : a.slice(0, cap).join(' ') + ` +${a.length - cap}`;

/// How a definition is placed: its section, then its parents, then the nearest landmark.
function place(map, d) {
	const s = map.secOf(d.sl);
	const parts = [];
	for (let p = d.parent; p; p = p.parent) parts.unshift(p.name);
	let at = `§ ${s.title}`;
	if (parts.length) at += ' > ' + parts.join(' > ');
	const sub = map.banners.filter(b => b.owner === d.parent && b.line < d.sl).pop();
	if (sub && d.parent) at += ` > § ${sub.title}`;
	return at;
}

export function renderFind(map, file, q) {
	const { how, hits } = findDefs(map, q);
	const out = [];
	const secs = /^[\w$.]+$/.test(q) ? map.sections.filter(s => s.title.toLowerCase().includes(q.toLowerCase())) : [];
	if (!hits.length && !secs.length) return { out: [`${file}: nothing matches '${q}'.`], found: false };
	if (hits.length) {
		const shownHits = hits.slice(0, 40);
		const use = usage(map, [...new Set(shownHits.filter(d => ident(d)).map(d => d.short))]);
		out.push(`# ${file}  ${hits.length} definition${hits.length === 1 ? '' : 's'} (${how} '${q}')`);
		for (const d of shownHits) {
			const u = ident(d) ? use.get(d.short) : null;
			let s = rng(d).padEnd(11) + ' ' + tag(d) + d.name + `   in ${place(map, d)}`;
			if (u) {
				s += `   calls ${u.calls.length}` + (u.calls.length ? ` [${lines(u.calls, 6)}]` : '');
				if (u.refs.length) s += `  refs ${u.refs.length} [${lines(u.refs, 4)}]`;
			}
			out.push(s);
			const g = gloss(map, d, 110);
			if (g) out.push('            ' + g);
			if (d.el - d.sl >= 150) {
				const sub = map.banners.filter(b => b.owner === d).map(b => `${b.line} ${b.title}`);
				if (sub.length) out.push('            inside: ' + sub.slice(0, 10).join(' | ') + (sub.length > 10 ? ` | +${sub.length - 10}` : ''));
			}
		}
		if (hits.length > 40) out.push(`(${hits.length - 40} more; narrow the pattern.)`);
	}
	for (const s of secs.slice(0, 8)) out.push(`§ ${(s.start + '-' + s.end).padEnd(11)} ${s.title}   (section title)`);
	return { out, found: true };
}

export function renderAt(map, file, line) {
	const out = [`# ${file}:${line}`];
	if (line < 1 || line > map.nlines) return { out: [`${file} has ${map.nlines} lines; ${line} is outside it.`], found: false };
	const s = map.secOf(line);
	out.push(`§ ${(s.start + '-' + s.end).padEnd(11)} ${s.title}`);
	const inside = map.defs.filter(d => d.sl <= line && line <= d.el).sort((a, b) => a.level - b.level || a.sl - b.sl);
	// Keep the one chain that ends at the innermost definition.
	let leaf = inside[inside.length - 1];
	const chain = [];
	for (let p = leaf; p; p = p.parent) chain.unshift(p);
	chain.forEach((d, i) => {
		out.push(' '.repeat(2 + i * 2) + rng(d).padEnd(11) + ' ' + tag(d) + d.name);
		// The landmark this definition last passed before the line, if it has banners inside.
		const near = map.banners.filter(b => b.owner === d && b.line <= line).pop();
		if (near) out.push(' '.repeat(4 + i * 2) + `after § ${near.line} ${near.title}`);
	});
	if (leaf) {
		const g = gloss(map, leaf, 110);
		if (g) out.push(' '.repeat(2 + chain.length * 2) + g);
	} else {
		const above = map.defs.filter(d => d.el < line).sort((a, b) => b.el - a.el)[0];
		const below = map.defs.filter(d => d.sl > line).sort((a, b) => a.sl - b.sl)[0];
		out.push('  (between definitions)');
		if (above) out.push('  above: ' + rng(above) + ' ' + tag(above) + above.name);
		if (below) out.push('  below: ' + rng(below) + ' ' + tag(below) + below.name);
	}
	return { out, found: true };
}

// ── Command line ─────────────────────────────────────────────────────────────────────────

const langOf = f => /\.rs$/.test(f) ? 'rs' : /\.(m|c)?js$/.test(f) ? 'js' : null;

function load(file) {
	const abs = path.isAbsolute(file) ? file : (fs.existsSync(file) ? path.resolve(file) : path.join(ROOT, file));
	const lang = langOf(abs);
	if (!lang) throw new Error(`${file}: only .js, .mjs and .rs files are mapped.`);
	return mapSource(fs.readFileSync(abs, 'utf8'), lang);
}

function allFiles() {
	const list = [];
	for (const [dir, ext] of [['www/js', /\.js$/], ['src', /\.rs$/]]) {
		const d = path.join(ROOT, dir);
		if (!fs.existsSync(d)) continue;
		for (const f of fs.readdirSync(d).sort()) if (ext.test(f)) list.push(dir + '/' + f);
	}
	return list;
}

const USAGE = `usage: node dev/codemap.mjs <file> [--sections | --full | --section <title|line> | <name-or-regex> | --at <line>]
       node dev/codemap.mjs --all <name-or-regex>      search every www/js/*.js and src/*.rs
       options: --depth <n>  --gloss  --no-gloss  --budget <chars>  --check`;

function main(argv) {
	const opt = { gloss: undefined };
	const pos = [];
	let section = null;
	let at = null;
	let all = false;
	let check = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
		else if (a === '--full') opt.full = true;
		else if (a === '--sections') opt.sections = true;
		else if (a === '--section') section = argv[++i];
		else if (a === '--at') at = Number(argv[++i]);
		else if (a === '--depth') opt.depth = Number(argv[++i]);
		else if (a === '--budget') opt.budget = Number(argv[++i]);
		else if (a === '--gloss') opt.gloss = true;
		else if (a === '--no-gloss') opt.gloss = false;
		else if (a === '--all') all = true;
		else if (a === '--check') check = true;
		else if (a.startsWith('--')) { console.error(`unknown option ${a}\n${USAGE}`); return 2; }
		else pos.push(a);
	}
	try {
		if (all) {
			const q = pos[0];
			if (!q) { console.error(USAGE); return 2; }
			let any = false;
			for (const f of allFiles()) {
				const r = renderFind(load(f), f, q);
				if (r.found) { any = true; console.log(r.out.join('\n')); }
			}
			if (!any) console.log(`nothing matches '${q}' in www/js/*.js or src/*.rs.`);
			return any ? 0 : 1;
		}
		const file = pos[0];
		if (!file) { console.error(USAGE); return 2; }
		const map = load(file);
		if (check) {
			console.log(`${file}: ${map.nlines} lines, ${map.defs.length} definitions, ${map.sections.length} sections, `
				+ (map.strays ? `${map.strays} UNBALANCED brackets` : 'brackets balance'));
			return map.strays ? 1 : 0;
		}
		if (at != null) {
			const r = renderAt(map, file, at);
			console.log(r.out.join('\n'));
			return r.found ? 0 : 1;
		}
		if (section != null) {
			const list = pickSections(map, section);
			if (!list.length) { console.log(`${file}: no section title matches '${section}'.`); return 1; }
			const cap = list.slice(0, 6);
			console.log(renderMembers(map, file, cap, { ...opt, gloss: opt.gloss ?? true }).join('\n'));
			if (list.length > cap.length) console.log(`(${list.length - cap.length} more sections match; narrow the pattern.)`);
			return 0;
		}
		if (pos[1] != null) {
			const r = renderFind(map, file, pos[1]);
			console.log(r.out.join('\n'));
			return r.found ? 0 : 1;
		}
		if (opt.sections) { console.log(renderSections(map, file).join('\n')); return 0; }
		console.log(renderOutline(map, file, { ...opt, gloss: opt.gloss ?? false }).join('\n'));
		return 0;
	} catch (e) {
		console.error(String(e.message || e));
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}
