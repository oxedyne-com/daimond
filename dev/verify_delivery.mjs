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
// Needs dev/serve.mjs on :8777 and a generated www/manifest.json
// (node dev/stamp-build.mjs && node verify/manifest.mjs).
import { open } from './harness.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const LOG = fileURLToPath(new URL('../verify/transparency.jsonl', import.meta.url));
const logText = await readFile(LOG, 'utf8');

const ok = [], bad = [];
const check = (name, pass, detail) => { (pass ? ok : bad).push(name); console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : '')); };

const s = await open({ name: 'delivery', signIn: false, connect: false });
const { page } = s;

// The public log, served from its real (foreign) origin — routed to the local chain.
await page.route('https://raw.githubusercontent.com/**', r => r.fulfill({
	status: 200, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: logText,
}));

const waitVerdict = async () => {
	await page.waitForFunction(() => {
		const d = document.getElementById('dot');
		return d && (d.classList.contains('ok') || d.classList.contains('no') || d.classList.contains('warn'));
	}, { timeout: 30000 });
	return page.evaluate(() => {
		const d = document.getElementById('dot');
		return {
			klass: d.className,
			headline: document.getElementById('headline').textContent,
			checks: [...document.querySelectorAll('#checks li')].map(li => li.textContent),
		};
	});
};

// ── 1. A clean served build verifies green ──────────────────────────
await page.goto('http://localhost:8777/verify.html', { waitUntil: 'domcontentloaded' });
let v = await waitVerdict();
check('a clean served build reports OK', /\bok\b/.test(v.klass), v.headline);
check('the public-log seal check passed', v.checks.some(c => /sealed in the public log/.test(c) && !/NOT/.test(c)),
	v.checks.find(c => /log/.test(c)) || '(no log check)');
check('the per-file check passed', v.checks.some(c => /every served file matches/.test(c)),
	v.checks.find(c => /every served file/.test(c)) || '(no file check)');

// ── 2. A tampered served file is caught ─────────────────────────────
await page.route('**/js/render.js', r => r.fulfill({
	status: 200, contentType: 'text/javascript', body: '/* TAMPERED */\n' }));
await page.goto('http://localhost:8777/verify.html', { waitUntil: 'domcontentloaded' });
v = await waitVerdict();
check('a tampered served file fails the verdict', /\bno\b/.test(v.klass), v.headline);
check('the tampered file is named as differing',
	v.checks.some(c => /every served file matches/.test(c) && /js\/render\.js/.test(c)),
	v.checks.find(c => /every served file/.test(c)) || '(no file check)');

await s.close();
console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
