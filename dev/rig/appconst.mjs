// appconst.mjs -- read one of the app's own numeric constants from its source, so a seed
// sized against an app threshold moves with the app instead of carrying a copy of it.
//
// The constants live inside daimond.js's closure, out of reach of the page, so they are read
// from the file: `var NAME = <product of integers>;`, the only shape the sync ceilings take.
// Anything else is refused rather than guessed. A prompt the app sends a model is a Rust `&str`
// constant in src/prompts.rs, read the same way (`strIn`, `appStr`): a law that tells a request
// by the app's words moves with them (rigfix7: r578c's fork hand-off broke law MDL's copy).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_JS = path.join(HERE, '..', '..', 'www', 'js', 'daimond.js');
export const PROMPTS_RS = path.join(HERE, '..', '..', 'src', 'prompts.rs');

/// The value of `var NAME = a * b * …;` in `src` (integers only), or a thrown error.
export function constIn(src, name) {
	const m = new RegExp(`\\bvar\\s+${name}\\s*=\\s*([0-9\\s*]+);`).exec(src);
	if (!m) throw new Error(`appconst: no integer constant ${name}`);
	const v = m[1].split('*').map((t) => t.trim()).filter(Boolean).reduce((a, t) => a * Number(t), 1);
	if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`appconst: ${name} = ${m[1].trim()} is not a size`);
	return v;
}

/// The constant `name` of the app tree the rig runs from (www/js/daimond.js).
export function appConst(name, file = APP_JS) { return constIn(fs.readFileSync(file, 'utf8'), name); }

/// The text of `pub const NAME: &str = "…";` in Rust source `src`, its escapes and line
/// continuations undone; null when the source has no such constant (an app before it). A
/// constant that is there but not one plain literal is refused.
export function strIn(src, name) {
	const head = new RegExp(`\\bpub\\s+const\\s+${name}\\s*:\\s*&(?:'static\\s+)?str\\s*=\\s*`).exec(src);
	if (!head) return null;
	let i = head.index + head[0].length, out = '';
	if (src[i] !== '"') throw new Error(`appconst: ${name} is not one string literal`);
	for (i++; i < src.length; i++) {
		const c = src[i];
		if (c === '"') {
			if (!/^\s*;/.test(src.slice(i + 1))) throw new Error(`appconst: ${name} is not one string literal`);
			return out;
		}
		if (c !== '\\') { out += c; continue; }
		const e = src[++i];
		if (e === '\n') { while (/\s/.test(src[i + 1] || '')) i++; continue; }	// continuation: the next line's indent goes too
		const plain = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" }[e];
		if (plain === undefined) throw new Error(`appconst: ${name} holds an escape \\${e} the rig does not read`);
		out += plain;
	}
	throw new Error(`appconst: ${name} is not closed`);
}

/// The string constant `name` of the app tree the rig runs from (src/prompts.rs), or null.
export function appStr(name, file = PROMPTS_RS) { return strIn(fs.readFileSync(file, 'utf8'), name); }
