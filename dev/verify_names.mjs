// gateway: none
// verify_names.mjs — the two built-in Diamonds are Neil and Lucy, everywhere a person can read.
//
// NAMES (D-20261015-12), the owner verbatim: "Lets rename Daimond Optimiser to Lucy (as in Lucy
// in the Sky with Diamonds) and Daimon Help, Neil as in Neil Diamond." His standing rule is that
// an example means every instance, so the old names must not survive in any label, seed, guide
// page, locale or search index. A rename done by hand misses one; this asks the whole tree.
//
// WHAT IT READS: every file git tracks under www/ (the app and the guide, every locale, and the
// guide's search indexes), as text. Comments are stripped first -- `//` and `/* */` in
// JavaScript and CSS, `<!-- -->` in HTML -- because a comment is not something a person reads,
// and the history in them (the owner's own words about "Daimond Help", quoted verbatim) is
// worth keeping. A line marked `names-gate: legacy` is skipped: that is the one map that has to
// hold the old names so an account seeded under them is still recognised and renamed.
//
// WHAT IT CANNOT SEE: pixels. A screenshot in www/guide/shots that shows an old tile is not text.
//
//   node dev/verify_names.mjs              # this checkout
//   node dev/verify_names.mjs --root DIR   # another tree (how it was seen failing on the base)

import { readPage } from './pagesrc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ai = process.argv.indexOf('--root');
const ROOT = ai > 0 ? path.resolve(process.argv[ai + 1]) : path.join(HERE, '..');

// The old names, and the words each locale's guide used for them. The English proper noun
// "Optimiser" is matched capitalised only: "Daimond's optimiser" describing Lucy is fine.
const OLD = [
	/Daimond Optimi[sz]er/, /Daimond? Help/, /\bOptimi[sz]er\b/,
	/Optimiseur/, /[Oo]ptimizador/, /[Oo]timizador/, /オプティマイザー/, /옵티마이저/, /优化器/,
	/Daimond-Hilfe/, /Ayuda de Daimond/, /Aide de Daimond/, /Ajuda do Daimond/,
	/Daimond ヘルプ/, /Daimond 도움말/, /Daimond 帮助/,
];
const TEXT = /\.(html|js|mjs|css|json|webmanifest|txt|md|svg)$/;

function files() {
	let list;
	try { list = execFileSync('git', ['ls-files', 'www'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n'); }
	catch (e) { list = null; }
	if (!list || !list.filter(Boolean).length) {	// not a checkout: walk it
		list = [];
		const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p); else list.push(p);
		} };
		walk('www');
	}
	return list.filter((f) => f && TEXT.test(f));
}

/// The text with its comments blanked out, line structure kept so a hit names its line.
function strip(f, s) {
	const blank = (m) => m.replace(/[^\n]/g, ' ');
	if (/\.html$/.test(f)) s = s.replace(/<!--[\s\S]*?-->/g, blank);
	if (/\.(js|mjs|css|html)$/.test(f)) {
		s = s.replace(/\/\*[\s\S]*?\*\//g, blank);
		if (!/\.css$/.test(f)) s = s.replace(/(^|[\s;{}(),])\/\/[^\n]*/g, (m, a) => a + blank(m.slice(a.length)));
	}
	return s;
}

const hits = [];
let n = 0;
for (const f of files()) {
	let s;
	try { s = readPage(path.join(ROOT, f), 'utf8'); } catch (e) { continue; }
	n++;
	const raw = s.split('\n'), lines = strip(f, s).split('\n');
	lines.forEach((line, i) => {
		if (/names-gate: legacy/.test(raw[i] || '')) return;
		for (const re of OLD) {
			const m = line.match(re);
			if (m) { hits.push(`${f}:${i + 1}: "${m[0]}"`); break; }
		}
	});
}

if (n < 50) { console.log(`FAIL names: read only ${n} files under www/ -- not the tree this gate is for`); process.exit(1); }
if (hits.length) {
	console.log(`FAIL names: ${hits.length} old built-in name(s) still readable in www/ (${n} files read)`);
	for (const h of hits.slice(0, 40)) console.log('  ' + h);
	if (hits.length > 40) console.log(`  … and ${hits.length - 40} more`);
	process.exit(1);
}
console.log(`PASS names: no "Daimond Help" or "Daimond Optimiser" (or a locale's word for either) in ${n} files under www/`);
