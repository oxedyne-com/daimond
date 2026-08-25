// probe_console.mjs — open the operator console as an owner and say what the
// page actually did: every admin response, every console message, and what
// each panel holds afterwards.
//
//   node dev/probe_console.mjs
//
// Written to tell an empty panel that FAILED from an empty panel that was
// never filled. `verify_releases` can only report that a wait expired; this
// reports the responses behind it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireFreshGateway, procLog } from './gwbin.mjs';
import { signInFresh } from './session.mjs';
import { GW_URL } from './ports.mjs';

const HERE   = path.dirname(fileURLToPath(import.meta.url));
const ROOT   = path.join(HERE, '..');
const GWDIR  = path.join(ROOT, 'gateway');
const GW_LOG = procLog('probe_console');
const SERVE_LOG = procLog('probe_console', 'serve');
const APP    = process.env.DAIMOND_APP || `http://localhost:${process.env.DAIMOND_PORT || 8777}`;
const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
function launch(cmd, args, opts) { const p = spawn(cmd, args, opts); procs.push(p); return p; }
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } }
async function waitFor(fn, ms = 30000, gap = 300) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

// This is a diagnostic, not a gate, and it is the one thing here that may
// deliberately drive a binary older than the tree: the question it answers is
// what the PAGE did with a reply, and the library underneath is beside the
// point. `DAIMOND_PROBE_ANY_BUILD=1` says so out loud, and prints the build's
// age so nothing read from this run can be mistaken for a measurement of the
// current source. Every verifier still refuses.
if (process.env.DAIMOND_PROBE_ANY_BUILD === '1') {
	const bin = path.join(GWDIR, 'target/release/daimond_gateway');
	console.log('  NOTE driving ' + bin + ' as it stands, whatever its age — this is a probe.');
} else {
	requireFreshGateway();
}

let gw = null;
async function startGateway(owner) {
	if (gw) { try { gw.kill('SIGKILL'); } catch (e) {} await sleep(1500); }
	gw = launch(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
		cwd: GWDIR,
		env: { ...process.env, APP_MODE: 'sandbox',
			...(owner ? { DAIMOND_OWNER_ACCOUNTS: owner } : {}) },
		stdio: GW_LOG.stdio,
	});
	return await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
}

(async () => {
	if (!await startGateway(null)) { console.log('gateway did not start'); GW_LOG.report(); process.exit(1); }
	let already = false;
	try { already = (await fetch(`${APP}/console/`)).ok; } catch (e) {}
	if (!already) launch('node', ['dev/serve.mjs'], { cwd: ROOT, stdio: SERVE_LOG.stdio });
	if (!await waitFor(async () => (await fetch(`${APP}/console/`)).ok, 15000)) {
		console.log('dev server did not serve'); cleanup(); process.exit(1);
	}

	const { chromium } = await import(pathToFileURL(PW).href);
	// DISPLAY is dropped, and it is the reason a wait for content here could
	// expire over a panel that was filled thirty seconds earlier. This session's
	// DISPLAY is an X display forwarded over SSH; a headless Chrome still
	// consults it, and when nothing answers the compositor never produces a
	// frame -- so `requestAnimationFrame` never fires, and `waitForFunction`
	// polls on rAF by default. `dev/harness.mjs` drops it for the same reason,
	// and this file launches its own browser rather than using the harness, so
	// it has to know the same thing.
	const env = { ...process.env };
	delete env.DISPLAY;
	const browser = await chromium.launch({
		executablePath: CHROME, headless: true, args: ['--no-sandbox'], env });
	try {
		const ctx  = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
		const page = await ctx.newPage();
		const acct = await signInFresh(page, APP);
		await startGateway(acct);

		const said = [], errs = [], responses = [];
		page.on('console', m => said.push(m.type() + ': ' + m.text()));
		page.on('pageerror', e => errs.push(e.message));
		page.on('response', async r => {
			const u = r.url();
			if (u.includes('/api/admin') || u.includes('transparency')) {
				responses.push(r.status() + ' ' + u.replace(APP, '').slice(0, 80));
			}
		});

		fs.mkdirSync(path.join(HERE, 'shots'), { recursive: true });
		const t0 = Date.now();
		await page.goto(`${APP}/console/`, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('#admin-app:not([hidden])', { timeout: 15000 });
		const filled = await page.waitForFunction(() => {
			const el = document.getElementById('admin-rel-declared');
			return !!el && el.children.length > 0;
		}, null, { timeout: 40000 }).then(() => true).catch(() => false);
		console.log(`\n  releases list filled: ${filled} after ${Date.now() - t0} ms`);

		const state = await page.evaluate(() => ({
			relChildren: (document.getElementById('admin-rel-declared') || {}).children?.length ?? -1,
			relHint:  (document.getElementById('admin-rel-hint') || {}).textContent || '',
			relStat:  (document.getElementById('admin-rel-status') || {}).textContent || '',
			relErr:   (document.getElementById('admin-rel-err') || {}).textContent || '',
			status:   (document.getElementById('admin-status') || {}).textContent || '',
			kpis:     document.querySelectorAll('#admin-kpis .admin-kpi').length,
			ops:      document.querySelectorAll('#admin-ops-list .admin-rel-row, #admin-ops-list .admin-op-row').length,
			accounts: document.querySelectorAll('#admin-accounts tbody tr').length,
			ledger:   document.querySelectorAll('#admin-ledger tbody tr').length,
		}));
		console.log('  page state: ' + JSON.stringify(state, null, 1));

		// What Refresh does now: ask for a fresh reading of the store, wait a
		// bounded time for it, and say which of those two happened.
		const before = await page.evaluate(() =>
			(document.getElementById('admin-health') || {}).textContent || '');
		const t1 = Date.now();
		await page.click('#admin-refresh');
		await page.waitForFunction(() => {
			const h = (document.getElementById('admin-health') || {}).textContent || '';
			return /just now|fresh reading/.test(h);
		}, null, { timeout: 30000 }).catch(() => {});
		const after = await page.evaluate(() =>
			(document.getElementById('admin-health') || {}).textContent || '');
		console.log(`\n  health line before refresh: "${before}"`);
		console.log(`  health line after refresh:  "${after}" (${Date.now() - t1} ms)`);
		await page.locator('#admin-kpis').screenshot({ path: path.join(HERE, 'shots', 'console-kpis.png') })
			.catch(() => {});
		await page.locator('#admin-health').screenshot({ path: path.join(HERE, 'shots', 'console-health.png') })
			.catch(() => {});
		console.log('\n  admin responses:');
		for (const r of responses) console.log('    ' + r);
		if (errs.length) { console.log('\n  page errors:'); for (const e of errs) console.log('    ' + e); }
		if (said.length) { console.log('\n  console said:'); for (const s of said.slice(-20)) console.log('    ' + s); }
	} catch (e) {
		console.error(e);
		GW_LOG.report();
	} finally {
		await browser.close();
		cleanup();
	}
	process.exit(0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
