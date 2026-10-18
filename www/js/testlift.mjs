// www/js/testlift.mjs -- D-20261018-09. Lift the REAL functions out of an app source for a node
// sandbox, by a brace-balanced scan (the method of diamondmodel.test.mjs), from the working tree
// or, with MM_SRC_REV set, from that commit: `MM_SRC_REV=14ef947b node www/js/<t>.test.mjs` runs a
// test against the live record's code, which is how a failing-first arm is shown red.
// Copy this file byte for byte: three wave-1 lanes add it, and identical adds merge clean.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/// The source of `www/js/<file>`, at MM_SRC_REV when it is set.
export function source(file, rev) {
	const r = rev === undefined ? (process.env.MM_SRC_REV || '') : rev;
	if (!r) return readFileSync(join(HERE, file), 'utf8');
	return execFileSync('git', ['show', r + ':www/js/' + file], { cwd: join(HERE, '..', '..'), encoding: 'utf8', maxBuffer: 1 << 28 });
}

/// `function name(...) { ... }` at any tab depth; '' when absent.
export function liftFn(src, name) {
	const m = new RegExp('\\n\\t+(?:async )?function ' + name + '\\(').exec(src);
	if (!m) return '';
	const start = m.index + 1;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}

/// `var name = ...;` to the first line ending in `;`; '' when absent.
export function liftVar(src, name) {
	const m = new RegExp('\\n\\t+var ' + name + '\\b').exec(src);
	if (!m) return '';
	const end = src.indexOf(';\n', m.index);
	return src.slice(m.index + 1, end + 1);
}

/// Every named var, then every named function, as one body for `new Function` or `vm`. A name
/// that is absent is listed in `missing`, so a test can say which function a revision lacks
/// rather than throwing on a ReferenceError.
export function lift(src, fns, vars) {
	const missing = [];
	const parts = (vars || []).map(function (v) { const s = liftVar(src, v); if (!s) missing.push(v); return s; })
		.concat((fns || []).map(function (f) { const s = liftFn(src, f); if (!s) missing.push(f); return s; }));
	return { body: parts.join('\n'), missing: missing };
}
