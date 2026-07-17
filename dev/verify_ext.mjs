// verify_ext.mjs — the Daimond Verify extension, in a real browser.
//
// verify/ext/fingerprint.js is proven identical to verify/lib.mjs by
// verify/verify.test.mjs. This loads the actual unpacked extension and drives
// its service worker: its check.js runs a real fetch of the served manifest and
// files, and a real fetch of a transparency log, and returns the right verdict —
// green for a sealed build, red for one not in the log.
//
// The log normally lives on GitHub (an origin the site cannot control). Here it
// is served locally (serve.mjs) and passed in, so the check runs offline against
// the same chain. Needs dev/serve.mjs on :8777 and a generated www/manifest.json.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const ROOT = '/home/jason/usr/code/web/apps/oxedyne/daimond';
const EXT = `${ROOT}/verify/ext`;
const PROFILE = '/tmp/daimond-verify-ext';
const APP = 'http://localhost:8777';

const ok = [], bad = [];
const check = (name, pass, detail) => { (pass ? ok : bad).push(name); console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : '')); };

// Serve two logs from www/ (so the extension can fetch them from the app origin):
// the real chain, and an empty one that seals nothing.
const realLog = fs.readFileSync(`${ROOT}/verify/transparency.jsonl`, 'utf8');
fs.writeFileSync(`${ROOT}/www/_vtest_log.jsonl`, realLog);
fs.writeFileSync(`${ROOT}/www/_vtest_empty.jsonl`, '');
const cleanup = () => { for (const f of ['_vtest_log.jsonl', '_vtest_empty.jsonl']) { try { fs.rmSync(`${ROOT}/www/${f}`); } catch (e) {} } };

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const b = await chromium.launchPersistentContext(PROFILE, {
	executablePath: CHROME, headless: false,
	args: ['--no-sandbox', '--disable-dev-shm-usage', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
async function waitSW() { for (let i = 0; i < 80 && !b.serviceWorkers().length; i++) await new Promise(r => setTimeout(r, 100)); return b.serviceWorkers()[0]; }

try {
	const sw = await waitSW();
	check('the extension service worker started', !!sw);
	const extId = sw ? new URL(sw.url()).host : '';
	check('it exposes its checker to the worker scope', await sw.evaluate(() => typeof self.verifyOrigin === 'function'));

	// 1. A sealed build, checked against the real chain → green.
	const v1 = await sw.evaluate(async (args) => await self.verifyOrigin(args.origin, args.log),
		{ origin: APP, log: `${APP}/_vtest_log.jsonl` });
	check('a sealed served build verifies green', v1 && v1.ok === true,
		v1 && v1.checks.map(c => c.name + '=' + c.ok).join(', '));
	check('the "sealed in the public log" check passed',
		v1 && v1.checks.some(c => /sealed in the public log/.test(c.name) && c.ok === true));
	check('every served file matched the manifest',
		v1 && v1.checks.some(c => /every served file/.test(c.name) && c.ok === true));

	// 2. The same build against an EMPTY log → red (it was never sealed).
	const v2 = await sw.evaluate(async (args) => await self.verifyOrigin(args.origin, args.log),
		{ origin: APP, log: `${APP}/_vtest_empty.jsonl` });
	check('a build absent from the log fails', v2 && v2.failed === true);
	check('the failure is the seal check', v2 && v2.checks.some(c => /sealed in the public log/.test(c.name) && c.ok === false));

	// 3. The badge path: a navigation records a verdict for the tab.
	await sw.evaluate((url) => chrome.storage.local.set({ logUrl: url }), `${APP}/_vtest_log.jsonl`);
	const page = await b.newPage();
	await page.goto(APP + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
	let recorded = null;
	for (let i = 0; i < 60; i++) {
		const vs = await sw.evaluate(() => self.__verdicts);
		const vals = Object.values(vs || {});
		if (vals.length) { recorded = vals[0]; break; }
		await new Promise(r => setTimeout(r, 200));
	}
	check('a real navigation records a verdict for the tab', !!recorded && recorded.ok === true,
		recorded ? 'ok=' + recorded.ok : 'no verdict recorded');
} finally {
	await b.close();
	cleanup();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
