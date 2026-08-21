// verify_delivery.mjs — the in-page delivery check, in a real browser.
//
// verify/lib.mjs + verify/check.mjs are unit-tested (verify/verify.test.mjs),
// and the browser shares their fingerprint algorithm (asserted identical there).
// This drives the actual www/verify.html page to prove the browser wiring: a
// clean served build reports a green verdict, and a tampered served file is
// caught and named.
//
// The public transparency log lives on GitHub (a different origin, the whole
// point). Here it is routed to the LOCAL verify/transparency.jsonl, so the
// "sealed in the public log" check can pass offline against the same chain.
//
// WHAT IS BEING MEASURED, AND WHAT IS NOT. `www/manifest.json` and the chain are
// written by `node dev/stamp-build.mjs "note" && node verify/manifest.mjs`, which runs
// when a release is SEALED — so between seals the working tree legitimately does
// not match the manifest that is committed beside it. From 2026-08-12 that made
// this file fail on every commit that was not itself a seal (4e13bbc, 40e6ed4,
// 5a0bcbf: "3 ok, 2 failed" each), and the page was right every time: the served
// build really did not match the published source, and it said so.
//
// That is the release state, and `dev/repro-check.sh` is what gates it. THIS
// file exists to prove the BROWSER WIRING — that the page fetches a manifest,
// re-derives the bundle hash, finds it in a chain on a foreign origin, rehashes
// every served byte, and draws the right verdict. So when the tree is between
// seals, the manifest and the chain entry for it are computed HERE, from the
// served tree, with `verify/lib.mjs` — the same functions `verify/manifest.mjs`
// seals with, not a copy of them — and routed into the page. Every check the
// page makes still runs over the real served bytes; only the requirement that
// the repository be sitting on a seal is lifted. A sealed tree is left entirely
// alone, and the run says which of the two it was.
//
//   node dev/verify_delivery.mjs
//   node dev/verify_delivery.mjs --break=stale      # the pre-2026-08-13 state
//   node dev/verify_delivery.mjs --break=serve      # a clean build that is not
//   node dev/verify_delivery.mjs --break=notamper   # a tamper that never happens
//
// The `--break` modes are the red proof: each one must turn a named check red,
// so a green run cannot be a check that had stopped being able to fail.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777).
import { open, APP } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashTree, bundleHash, parseLog, nextEntry } from '../verify/lib.mjs';

const LOG = fileURLToPath(new URL('../verify/transparency.jsonl', import.meta.url));
const WWW = fileURLToPath(new URL('../www', import.meta.url));
const logText = await readFile(LOG, 'utf8');

/// Which fault to inject, so every check below can be shown going red.
const BREAK = (process.argv.find(a => a.startsWith('--break=')) || '').slice(8);

const ok = [], bad = [];
const check = (name, pass, detail) => { (pass ? ok : bad).push(name); console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : '')); };

// ── The manifest the page will be asked to verify against ───────────
//
// Read the tree the dev server is serving and seal it exactly as a release
// would. If that comes out identical to the committed manifest, this tree IS a
// sealed one and nothing is substituted.
const files    = await hashTree(WWW);
const bundle   = bundleHash(files);
const onDisk   = await readFile(`${WWW}/manifest.json`, 'utf8').then(JSON.parse).catch(() => null);
const sealed   = !!onDisk && onDisk.bundle === bundle;
const build    = (onDisk && onDisk.build) || bundle.slice(0, 12);
const manifest = { algo: 'sha-256', build, bundle, files };

// The chain the page fetches from the foreign origin. When the bundle is not a
// released one, its entry is appended here — through `nextEntry`, so the hash
// chain the page re-walks is a real one and check 2 still means what it says.
const entries = parseLog(logText);
const chainText = sealed || BREAK === 'stale'
	? logText
	: logText + (logText.endsWith('\n') ? '' : '\n')
		+ JSON.stringify(nextEntry(entries, {
			ts: new Date().toISOString(), build, bundle, note: 'verify_delivery, not a release',
		})) + '\n';

console.log(sealed
	? `  note  this tree IS sealed (bundle ${bundle.slice(0, 12)}…); the committed manifest is used as it stands`
	: `  note  this tree is between seals; the manifest and one chain entry are computed here `
		+ `over ${Object.keys(files).length} served files (bundle ${bundle.slice(0, 12)}…)`);
if (BREAK) console.log(`  note  --break=${BREAK}: a fault is being injected on purpose`);

const s = await open({ name: 'delivery', signIn: false, connect: false });
const { page } = s;

// The public log, served from its real (foreign) origin — routed to the local chain.
await page.route('https://raw.githubusercontent.com/**', r => r.fulfill({
	status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: chainText,
}));
// The manifest for the tree as served, unless this tree is already a sealed one
// or the run is deliberately reproducing the old failure.
if (!sealed && BREAK !== 'stale') {
	await page.route('**/manifest.json', r => r.fulfill({
		status: 200, contentType: 'application/json', body: JSON.stringify(manifest),
	}));
}

const waitVerdict = async () => {
	await page.waitForFunction(() => {
		const d = document.getElementById('dot');
		return d && (d.classList.contains('ok') || d.classList.contains('no') || d.classList.contains('warn'));
	}, { timeout: 60000 });
	return page.evaluate(() => {
		const d = document.getElementById('dot');
		return {
			klass: d.className,
			headline: document.getElementById('headline').textContent,
			checks: [...document.querySelectorAll('#checks li')].map(li => li.textContent),
		};
	});
};

/// A check the page drew, and whether it drew it GREEN.
///
/// The page marks each line ✓ / ✗ / ?, and reading only the NAME was how this
/// file reported "the per-file check passed" while the page was showing that
/// same line with a ✗ and twenty-four differing files against it. A check that
/// only asks whether a line exists is a check that cannot fail.
const passed = (checks, re) => checks.some(c => re.test(c) && c.trim().startsWith('✓'));
const line   = (checks, re) => checks.find(c => re.test(c)) || '(no such check)';

// ── 1. A clean served build verifies green ──────────────────────────
if (BREAK === 'serve') {
	await page.route('**/js/render.js', r => r.fulfill({
		status: 200, contentType: 'text/javascript', body: '/* BREAK=serve */\n' }));
}
await page.goto(`${APP}/verify.html`, { waitUntil: 'domcontentloaded' });
let v = await waitVerdict();
check('a clean served build reports OK', /\bok\b/.test(v.klass), v.headline);
check('the public-log seal check passed', passed(v.checks, /sealed in the public log/),
	line(v.checks, /log/));
check('the per-file check passed', passed(v.checks, /every served file matches/),
	line(v.checks, /every served file/));

// ── 2. A tampered served file is caught ─────────────────────────────
if (BREAK !== 'notamper') {
	await page.route('**/js/render.js', r => r.fulfill({
		status: 200, contentType: 'text/javascript', body: '/* TAMPERED */\n' }));
}
await page.goto(`${APP}/verify.html`, { waitUntil: 'domcontentloaded' });
v = await waitVerdict();
check('a tampered served file fails the verdict', /\bno\b/.test(v.klass), v.headline);
check('the tampered file is named as differing',
	v.checks.some(c => /every served file matches/.test(c) && /js\/render\.js/.test(c)),
	line(v.checks, /every served file/));

await s.close();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
