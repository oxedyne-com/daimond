// verify/verify.test.mjs — the delivery-verify chain, proven.
//
// The claim these tools make is strong — "the code your browser runs is the
// published source" — so the tools themselves are tested hard: a good build
// passes, a single changed byte fails and is named, a build that was never
// sealed fails, a rewritten history is caught, and the fingerprint Node computes
// is byte-for-byte the one the browser's Web Crypto path computes.
//
//   node verify/verify.test.mjs
//
// No dependencies; a throwaway fixture tree under the OS temp dir.

import { mkdtemp, writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
	hashTree, bundleHash, manifestText, verifyChain, nextEntry, entryHash, diffFiles, GENESIS_PREV,
} from './lib.mjs';
import * as extFp from './ext/fingerprint.js';

const CHECK = fileURLToPath(new URL('./check.mjs', import.meta.url));
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Build a small sealed fixture: files, a matching manifest.json, and a
/// transparency log with one entry that seals the bundle.
async function sealedFixture() {
	// The served tree and the transparency log live in SEPARATE places, as they
	// do in the repo (www/ and verify/) — the log must never be one of the files
	// the manifest covers, or it would change its own fingerprint.
	const base = await mkdtemp(join(tmpdir(), 'daimond-verify-'));
	const dir  = join(base, 'www');
	await mkdir(join(dir, 'js'), { recursive: true });
	await mkdir(join(dir, 'pkg'), { recursive: true });
	await writeFile(join(dir, 'index.html'), '<!doctype html><title>x</title>');
	await writeFile(join(dir, 'js', 'app.js'), 'console.log("hi");');
	await writeFile(join(dir, 'pkg', 'core.wasm'), Buffer.from([0, 1, 2, 3, 4, 5]));
	// Excluded files must NOT change the fingerprint.
	await writeFile(join(dir, 'build.json'), JSON.stringify({ build: 'abc123def456', note: 'x' }));

	const files  = await hashTree(dir);
	const bundle = bundleHash(files);
	await writeFile(join(dir, 'manifest.json'),
		JSON.stringify({ algo: 'sha-256', build: 'abc123def456', bundle, files }));

	const log = join(base, 'log.jsonl');
	const entry = nextEntry([], { ts: '2026-07-18T00:00:00Z', build: 'abc123def456', bundle });
	await writeFile(log, JSON.stringify(entry) + '\n');
	return { base, dir, log, bundle, files };
}

const run = (args) => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
/// `check.mjs` colours its output, so a test that matches a whole line has to take the
/// escapes off first. Without this every line-anchored assertion below passes or fails on
/// the presence of a colour code rather than on what was printed.
const plain = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

// ── The happy path ─────────────────────────────────────────────────
{
	const { base, dir, log } = await sealedFixture();
	const r = run(['--dir', dir, '--log', log]);
	check('a sealed, unchanged build passes', r.status === 0, r.stdout.trim().split('\n').pop());
	await rm(base, { recursive: true, force: true });
}

// ── A changed file is caught and named ──────────────────────────────
{
	const { base, dir, log } = await sealedFixture();
	await writeFile(join(dir, 'js', 'app.js'), 'console.log("TAMPERED");');
	const r = run(['--dir', dir, '--log', log]);
	check('a single changed byte fails the check', r.status === 1);
	check('the changed file is named', /^\s+· js\/app\.js$/m.test(plain(r.stdout)), 'output did not name js/app.js');
	await rm(base, { recursive: true, force: true });
}

// ── A file the manifest does not cover is named even when a hundred others changed ──
//
// The failure this is written from: on 2026-08-17 `--dir www` reported 111 problems and
// printed forty, off ONE flat list ordered changed-then-missing-then-unexpected. The
// hundred-odd changed files used up the forty, so the file the manifest named and no
// longer had, and the seven served files it did not cover — the whole social client —
// were counted and never shown. The reader saw a wall of "changed", which is the normal
// state of a tree between deploys.
//
// So the assertion is not "something was printed". It is that the two categories a wall
// of changed files can bury are BOTH named, with more changed files than the old cap.
{
	const { base, dir, log } = await sealedFixture();
	for (let i = 0; i < 60; i++) {
		await writeFile(join(dir, 'js', `bulk${i}.js`), `// ${i}\n`);
	}
	// Seal THAT, so the sixty are covered and can then be changed rather than unexpected.
	const files  = await hashTree(dir);
	const bundle = bundleHash(files);
	await writeFile(join(dir, 'manifest.json'),
		JSON.stringify({ algo: 'sha-256', build: 'abc123def456', bundle, files }));
	await writeFile(log,
		JSON.stringify(nextEntry([], { ts: '2026-07-18T00:00:00Z', build: 'abc123def456', bundle }))
		+ '\n');
	for (let i = 0; i < 60; i++) {
		await writeFile(join(dir, 'js', `bulk${i}.js`), `// ${i} TAMPERED\n`);
	}
	await writeFile(join(dir, 'js', 'smuggled.js'), 'console.log("not in the manifest");');
	await rm(join(dir, 'index.html'));

	const r = run(['--dir', dir, '--log', log]);
	check('sixty changed files, one smuggled and one removed: it fails', r.status === 1);
	check('the smuggled file is named, not buried under the changed ones',
		/^\s+· js\/smuggled\.js$/m.test(plain(r.stdout)), 'output did not name js/smuggled.js');
	check('the file the manifest names and no longer has is named too',
		/^\s+· index\.html$/m.test(plain(r.stdout)), 'output did not name index.html');
	check('and the changed files are counted rather than all listed',
		/60 changed:/.test(plain(r.stdout)) && /… and 40 more/.test(plain(r.stdout)),
		'the changed group was not counted and trimmed');
	await rm(base, { recursive: true, force: true });
}

// ── An unsealed build (not in the log) is caught ────────────────────
{
	const { base, dir, log } = await sealedFixture();
	await writeFile(log, '');   // empty chain: nothing was ever sealed
	const r = run(['--dir', dir, '--log', log]);
	check('a build that was never sealed fails', r.status === 1);
	check('the failure says it was never sealed', /never sealed|not in the transparency log|no transparency log/.test(r.stdout));
	await rm(base, { recursive: true, force: true });
}

// ── An excluded file does not move the fingerprint ──────────────────
{
	const { base, dir, log } = await sealedFixture();
	await writeFile(join(dir, 'build.json'), JSON.stringify({ build: 'abc123def456', note: 'CHANGED NOTE' }));
	const r = run(['--dir', dir, '--log', log]);
	check('changing build.json alone still passes (it is excluded)', r.status === 0);
	await rm(base, { recursive: true, force: true });
}

// ── The chain ───────────────────────────────────────────────────────
{
	let entries = [];
	for (let i = 0; i < 4; i++) {
		entries.push(nextEntry(entries, { ts: `t${i}`, build: `b${i}`, bundle: `bundle${i}`.padEnd(64, '0') }));
	}
	check('a well-formed chain verifies', verifyChain(entries).ok);
	check('the first entry chains onto genesis', entries[0].prev === GENESIS_PREV);

	// Tamper a past entry's bundle without fixing the hashes after it.
	const forged = entries.map(e => ({ ...e }));
	forged[1].bundle = 'evil'.padEnd(64, '0');
	check('a rewritten past entry breaks the chain', !verifyChain(forged).ok);

	// Even fixing entry 1's own hash is not enough — entry 2 still chains on the old one.
	forged[1].entry = entryHash(forged[1]);
	check('re-hashing the forged entry alone does not repair the chain', !verifyChain(forged).ok);
}

// ── Node and the browser compute the SAME fingerprint ───────────────
{
	const files = { 'a.js': 'aa'.repeat(32), 'b/c.wasm': 'bb'.repeat(32) };
	const nodeHash = bundleHash(files);
	// The browser path: crypto.subtle.digest over the identical manifest text.
	const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestText(files)));
	const subtleHash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
	check('Node crypto and Web Crypto agree on the bundle hash', nodeHash === subtleHash,
		`${nodeHash.slice(0, 12)} vs ${subtleHash.slice(0, 12)}`);

	// And the browser-extension's own copy of the algorithm agrees too — its
	// whole value is being an independent checker, so it must compute the
	// identical fingerprint or it verifies nothing.
	const extHash = await extFp.bundleHash(files);
	check('the verify extension agrees on the bundle hash', nodeHash === extHash,
		`${nodeHash.slice(0, 12)} vs ${extHash.slice(0, 12)}`);
}

// ── diffFiles reports each kind of difference ───────────────────────
{
	const d = diffFiles({ a: '1', b: '2', c: '3' }, { a: '1', b: 'X', d: '9' });
	check('diffFiles finds changed/missing/unexpected',
		d.changed.includes('b') && d.missing.includes('c') && d.unexpected.includes('d'));
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
