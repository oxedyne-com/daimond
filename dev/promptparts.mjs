// promptparts.mjs — the notes as the app really ships them, read out of the source.
//
// **The words are never copied into a measuring instrument.**  `dev/PROMPTS_PROBE.md`
// makes the argument at length and it is the same one here: a transposed copy of a
// prompt clause drifts from the clause, silently, and the instrument then reports on
// words nothing sends.  So every consumer of this file asks for a const by NAME and is
// handed whatever `src/prompts.rs` says today.
//
// One Rust literal shape is understood, which is the only shape these constants use:
//
//	pub const NAME: &str =
//		"first line\n\n\
//		 continued";
//
// A backslash at the end of a line eats the newline AND the leading whitespace of the
// next, which is why the source can be indented and the string is not.  Anything else --
// a `concat!`, an `r#"…"#`, a `format!` -- is refused by name rather than mis-parsed,
// because a parser that guesses returns text no model was ever sent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPTS = path.join(HERE, '../src/prompts.rs');

/// Turn one Rust string literal, starting at the opening quote, into the text it denotes.
///
/// Returns the text and the index just past the closing quote.
function literalAt(src, open) {
	if (src[open] !== '"') throw new Error(`promptparts: no string literal at ${open}`);
	let out = '';
	let i = open + 1;
	for (;;) {
		if (i >= src.length) throw new Error('promptparts: unterminated string literal');
		const ch = src[i];
		if (ch === '"') return { text: out, end: i + 1 };
		if (ch !== '\\') { out += ch; i++; continue; }
		const nxt = src[i + 1];
		if (nxt === '\n') {
			// The line continuation: the newline and every space or tab after it are eaten.
			i += 2;
			while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++;
			continue;
		}
		const simple = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
		if (nxt in simple) { out += simple[nxt]; i += 2; continue; }
		if (nxt === 'u' && src[i + 2] === '{') {
			const close = src.indexOf('}', i + 3);
			if (close < 0) throw new Error('promptparts: unterminated \\u{…}');
			out += String.fromCodePoint(parseInt(src.slice(i + 3, close), 16));
			i = close + 1;
			continue;
		}
		if (nxt === 'x') {
			out += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
			i += 4;
			continue;
		}
		throw new Error(`promptparts: escape \\${nxt} is not understood`);
	}
}

/// One `pub const NAME: &str = "…";` from a Rust source, as the text it denotes.
export function constText(src, name) {
	const decl = new RegExp(`\\bconst\\s+${name}\\s*:\\s*&(?:'static\\s+)?str\\s*=`);
	const m = decl.exec(src);
	if (!m) throw new Error(`promptparts: no const ${name}: &str in the source`);
	let i = m.index + m[0].length;
	while (i < src.length && /\s/.test(src[i])) i++;
	if (src[i] !== '"') {
		throw new Error(`promptparts: ${name} is not a plain string literal — it starts `
			+ `${JSON.stringify(src.slice(i, i + 24))}. Teach this parser that shape rather `
			+ 'than letting it guess.');
	}
	return literalAt(src, i).text;
}

/// The seven standing notes, by the name `Role::compose` appends them under.
export const NOTES = [
	'VISION_NOTE', 'SHOW_NOTE', 'QUIET_NOTE', 'FOLD_NOTE',
	'VERIFY_NOTE', 'SKILLS_NOTE', 'SEARCH_NOTE', 'SAFETY_CLAUSE', 'CRYSTAL_SCHEMA_NOTE',
];

export function readNotes(file = PROMPTS) {
	const src = fs.readFileSync(file, 'utf8');
	const out = new Map();
	for (const n of NOTES) out.set(n, constText(src, n));
	return out;
}
