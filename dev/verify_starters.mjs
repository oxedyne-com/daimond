// The starter tags, in every language.
//
// They are the one place the interface puts a word INTO the user's data. A tag
// is lowercased and space-collapsed by the store, so a starter that is not
// already in that form would draw a chip reading one thing and file another --
// and the chip would then not match the tag it just made, so clicking it again
// would offer to add it a second time. The app normalises them defensively;
// this makes sure no locale is relying on that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const I18N = path.join(HERE, '..', 'www', 'i18n');
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];

let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

/// What the store would make of a tag: trimmed, inner whitespace collapsed,
/// lowercased. Mirrors normalise_tags in src/diamond_meta.rs.
const norm = (s) => s.split(/\s+/).filter(Boolean).join(' ').toLowerCase();

const MAX_TAG_LEN = 32;   // src/diamond_meta.rs

for (const loc of LOCALES) {
	const src = fs.readFileSync(path.join(I18N, `${loc}.js`), 'utf8');
	const m = src.match(/'tag\.starters':\s*'((?:[^'\\]|\\.)*)'/);
	check(!!m, `${loc}: declares tag.starters`);
	if (!m) continue;
	const raw = m[1].replace(/\\'/g, "'").split(',').map(s => s.trim()).filter(Boolean);
	check(raw.length === 4, `${loc}: offers four starters (${raw.length}): ${raw.join(' / ')}`);
	for (const tag of raw) {
		check(norm(tag) === tag,
			`${loc}: ${JSON.stringify(tag)} is already as the store would file it${norm(tag) === tag ? '' : ` (would become ${JSON.stringify(norm(tag))})`}`);
		check([...tag].length <= MAX_TAG_LEN,
			`${loc}: ${JSON.stringify(tag)} fits the ${MAX_TAG_LEN}-character cap (${[...tag].length})`);
	}
	// Distinct after normalisation, or the pool would offer the same tag twice.
	const set = new Set(raw.map(norm));
	check(set.size === raw.length, `${loc}: the four are distinct`);
}

console.log(bad ? `\n${bad} FAILED` : `\nALL PASS`);
process.exit(bad ? 1 : 0);
