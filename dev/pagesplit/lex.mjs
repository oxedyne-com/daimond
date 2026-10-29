// dev/pagesplit/lex.mjs -- which lines of a JavaScript text begin inside a literal.
//
// The page split moves the page's top level out of one IIFE, so every top-level line
// loses one tab, and `pageSource()` puts it back. A line that begins INSIDE a
// template literal (or a string continued with a backslash) must be left alone both
// ways: its leading tabs are part of a value the page uses. This answers which lines
// those are, with no parser, so the compatibility view needs nothing outside this
// tree. `modcheck.mjs` proves the answer equal to acorn's on every page module.
//
// The one guess is a `/`: a regular expression after an operator, an opening
// bracket, a keyword that takes an expression or a `}`; a division after a name, a
// number, `)` or `]`.

const REGEX_AFTER_KW = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new',
	'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

/// The 0-based indices of the lines whose first character lies inside a string or
/// template literal.
export function literalLines(text) {
	const out = new Set();
	const n = text.length;
	const tpl = []; // brace depth at each open `${`
	let depth = 0, i = 0, line = 0, regexOk = true;
	const inside = () => {}; // marker for readability
	const nl = (k) => { // a newline at k inside a literal
		line++; out.add(line);
	};
	while (i < n) {
		const c = text[i];
		if (c === '\n') { line++; i++; continue; }
		if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
		if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
		if (c === '/' && text[i + 1] === '*') {
			i += 2;
			while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
			i += 2; continue;
		}
		if (c === '\'' || c === '"') {
			i++;
			while (i < n && text[i] !== c) {
				if (text[i] === '\\') { if (text[i + 1] === '\n') nl(); i += 2; continue; }
				if (text[i] === '\n') { line++; break; } // unterminated: let the parser say so
				i++;
			}
			i++; regexOk = false; continue;
		}
		if (c === '`' || (c === '}' && tpl.length && tpl[tpl.length - 1] === depth)) {
			if (c === '}') tpl.pop();
			i++;
			for (;;) {
				if (i >= n) break;
				const d = text[i];
				if (d === '\\') { if (text[i + 1] === '\n') nl(); i += 2; continue; }
				if (d === '\n') { nl(); i++; continue; }
				if (d === '`') { i++; regexOk = false; break; }
				if (d === '$' && text[i + 1] === '{') { i += 2; tpl.push(depth); regexOk = true; break; }
				i++;
			}
			continue;
		}
		if (c === '/' && regexOk) {
			i++; let cls = false;
			while (i < n) {
				const d = text[i];
				if (d === '\\') { i += 2; continue; }
				if (d === '\n') break;
				if (cls) { if (d === ']') cls = false; }
				else if (d === '[') cls = true;
				else if (d === '/') { i++; break; }
				i++;
			}
			while (i < n && /[A-Za-z]/.test(text[i])) i++;
			regexOk = false; continue;
		}
		if (/[A-Za-z_$\\]/.test(c) || c.charCodeAt(0) > 127) {
			let j = i + 1;
			while (j < n && (/[\w$\\]/.test(text[j]) || text.charCodeAt(j) > 127)) j++;
			const w = text.slice(i, j);
			regexOk = REGEX_AFTER_KW.has(w);
			i = j; continue;
		}
		if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] || ''))) {
			let j = i + 1;
			while (j < n && /[\w.]/.test(text[j])) j++;
			i = j; regexOk = false; continue;
		}
		if (c === '{') depth++;
		else if (c === '}') depth--;
		regexOk = !(c === ')' || c === ']');
		i++;
	}
	return out;
}

/// Add or remove one leading tab on every line that does not begin inside a literal.
/// `dir` is +1 or -1; a removal touches only lines that begin with a tab, an addition
/// only lines that are not empty.
export function shiftIndent(text, dir) {
	const lit = literalLines(text);
	return text.split('\n').map((l, k) => {
		if (lit.has(k)) return l;
		if (dir < 0) return l[0] === '\t' ? l.slice(1) : l;
		return l.length ? '\t' + l : l;
	}).join('\n');
}
