// gateway: none
// verify_logo.mjs — no copy of a retired Daimond mark is left anywhere it is served or printed.
//
// The mark is his finished drawing, installed byte for byte from
// ~/usr/complement/brands/projects/oxedyne/daimond/logo/svg/: daimond_logo_opt.svg is
// www/assets/daimond_mark.svg (and landing/, ext/), daimond_logo_word_right_opt.svg is
// www/assets/daimond_word*.svg. A retired mark is found by its path data, which no later
// drawing shares, so a copy that kept an old drawing under a current name is still caught.
//
//   node dev/verify_logo.mjs [dir ...]   # tracked files, plus any extra trees (e.g. the docs' assets)
//
// It also runs `dev/icons.mjs --check`, so the home-screen PNGs are proved to be renders of
// the current mark rather than of whatever the SVG said when they were last drawn.
// Exit 0 when nothing retired remains, 1 otherwise.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const RETIRED = [
	['m29.879 0-29.879 42.136 5.2e-4 5.1e-4 29.878-12.258',	'29 Oct 2026 one-red mark'],
	['v-42.137l-29.879 42.137z',				'pale four-facet mark, facet'],
	['-29.879 12.258 29.879 12.258 29.879-12.258z',		'pale four-facet mark, band'],
	['M 0,-42.137 -29.879,0 0,0 Z',				'pale mark as the splash symbol'],
];

// His illustration, not the logo: its diamond is drawn from the pale mark, and redrawing a
// figure of his is his call. A hold whose file no longer carries a retired mark fails, so
// the list cannot outlive the ruling.
const HELD = {
	'www/assets/splash.svg':	'splash artwork (ruling asked, D-20261106-10)',
	'landing/assets/splash.svg':	'splash artwork (ruling asked, D-20261106-10)',
};

const TEXT = /\.(svg|html?|css|m?js|json|webmanifest|typ|md|txt)$/i;

function tracked() {
	const out = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' });
	return out.split('\0').filter(f => f && TEXT.test(f)).map(f => [f, path.join(ROOT, f)]);
}

function walk(dir, acc = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) { if (e.name !== 'archive') walk(p, acc); }
		else if (TEXT.test(e.name)) acc.push([p, p]);
	}
	return acc;
}

const files = tracked();
for (const d of process.argv.slice(2)) files.push(...walk(path.resolve(d)));

let found = 0;
let held = 0;
for (const [name, file] of files) {
	if (name === 'dev/verify_logo.mjs') continue;
	if (!fs.existsSync(file)) continue;
	const src = fs.readFileSync(file, 'utf8');
	const hits = RETIRED.filter(([sig]) => src.includes(sig)).map(([, what]) => what);
	if (HELD[name]) {
		if (hits.length) { held++; console.log(`  HELD     ${name}: ${HELD[name]}`); }
		else { found++; console.log(`  STALE HOLD ${name}: carries no retired mark, drop it from HELD`); }
		continue;
	}
	if (hits.length) { found++; console.log(`  RETIRED  ${name}: ${hits.join('; ')}`); }
}

const icons = spawnSync('node', [path.join(ROOT, 'dev', 'icons.mjs'), '--check'], { encoding: 'utf8' });
if (icons.status !== 0) {
	found++;
	console.log(`  RETIRED  www/assets/icons: not renders of the current mark\n${icons.stdout}${icons.stderr}`);
}

console.log(`\nverify_logo: ${found} retired, ${held} held, ${files.length} files read`);
process.exit(found ? 1 : 0);
