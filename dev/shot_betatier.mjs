// shot_betatier.mjs — the Beta passcodes panel, driven as an operator, with the
// tier control used both ways.
//
//   node dev/shot_betatier.mjs
//
// The panel is the only place a Pro code can be asked for, and the control that
// asks is a `<select>` inside `.admin-rel-add`, where the console's own CSS sets
// `appearance: none` on every input. A pulldown that renders as a blank box, or
// a tick nobody can see, is a control that exists in the source and not on the
// screen -- so this drives it and photographs what it did.
//
// What it reports:
//
//   * the mint form holds a tier control, and what its options say;
//   * minting with it left alone produces a FREE row, drawn as one;
//   * minting with it set to Pro produces a Pro row, drawn as one;
//   * both rows come back from the gateway with the tier the panel asked for.
//
// A gateway and a dev server of its own, on ports of their own, so this can run
// while other lanes hold :9002 and :8777. The store is empty, because the rows
// it counts would otherwise be somebody else's afternoon.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireFreshGateway, procLog, GWDIR, GWBIN, openBeta } from './gwbin.mjs';
import { signInFresh } from './session.mjs';

const HERE    = path.dirname(fileURLToPath(import.meta.url));
const ROOT    = path.join(HERE, '..');
// 9418/8793 rather than 9412/8791: verify_redeem.mjs owns :9412 and
// verify_ptyedge.mjs owns :9422/:8797, so both the original pair and the obvious
// replacement collide inside one suite run.  These two are unused across dev/.
const GW_PORT = Number(process.env.DAIMOND_GW_PORT || 9418);
const APP_PORT = Number(process.env.DAIMOND_PORT || 8793);
const GW      = `http://127.0.0.1:${GW_PORT}`;
const APP     = `http://localhost:${APP_PORT}`;
const SCRATCH = process.env.DAIMOND_SCRATCH || path.join(os.homedir(), '.cache/daimond');
const LANE    = path.join(SCRATCH, 'laneA');
const WORK    = path.join(LANE, 'shot_betatier-gw');
const SHOTS   = path.join(LANE, 'shots');
const GW_LOG  = procLog('shot_betatier');
const SRV_LOG = procLog('shot_betatier', 'serve');
const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
function launch(cmd, args, opts) { const p = spawn(cmd, args, opts); procs.push(p); return p; }
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } }
async function waitFor(fn, ms = 30000, gap = 250) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

requireFreshGateway();

/// The working directory: the deployed config with its port moved, registration
/// open, and the licence key symlinked in -- a gifted Pro licence has to be
/// signed with the same key a bought one is.
function buildWorkDir() {
	fs.rmSync(WORK, { recursive: true, force: true });
	fs.mkdirSync(path.join(WORK, 'keys'), { recursive: true });
	fs.mkdirSync(SHOTS, { recursive: true });
	for (const k of ['licence', 'stripe', 'openrouter']) {
		const from = path.join(GWDIR, 'keys', k);
		if (fs.existsSync(from)) fs.symlinkSync(from, path.join(WORK, 'keys', k));
	}
	const cfg = fs.readFileSync(path.join(GWDIR, 'app.jdat'), 'utf8')
		.replace(/"listen_port":\s*\(u16\|\d+\)/, `"listen_port": (u16|${GW_PORT})`);
	if (!cfg.includes(`(u16|${GW_PORT})`)) {
		console.log('  FAIL could not set the listen port in the copied app.jdat.');
		process.exit(1);
	}
	fs.writeFileSync(path.join(WORK, 'app.jdat'), openBeta(cfg, 'shot_betatier'));
	return WORK;
}

let gw = null;
async function startGateway(cwd, owner) {
	if (gw) { try { gw.kill('SIGKILL'); } catch (e) {} await sleep(1200); }
	gw = launch(GWBIN, [], {
		cwd,
		env: { ...process.env, APP_MODE: 'sandbox',
			...(owner ? { DAIMOND_OWNER_ACCOUNTS: owner } : {}) },
		stdio: GW_LOG.stdio,
	});
	return await waitFor(async () => (await fetch(`${GW}/api/health`)).ok, 25000);
}

(async () => {
	const cwd = buildWorkDir();
	if (!await startGateway(cwd, null)) {
		console.log('  FAIL the gateway did not start'); GW_LOG.report(); cleanup(); process.exit(1);
	}
	launch('node', ['dev/serve.mjs'], {
		cwd: ROOT,
		env: { ...process.env, DAIMOND_PORT: String(APP_PORT), DAIMOND_GW_PORT: String(GW_PORT) },
		stdio: SRV_LOG.stdio,
	});
	if (!await waitFor(async () => (await fetch(`${APP}/console/`)).ok, 20000)) {
		console.log('  FAIL the dev server did not serve'); SRV_LOG.report(); cleanup(); process.exit(1);
	}

	const { chromium } = await import(pathToFileURL(PW).href);
	// DISPLAY is dropped for the reason dev/harness.mjs drops it: a forwarded X
	// display that nobody answers leaves headless Chrome producing no frames, so
	// every rAF-based wait expires over a page that was ready long before.
	const env = { ...process.env };
	delete env.DISPLAY;
	const browser = await chromium.launch({
		executablePath: CHROME, headless: true, args: ['--no-sandbox'], env });
	try {
		const ctx  = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
		const page = await ctx.newPage();
		const errs = [];
		page.on('pageerror', e => errs.push(e.message));
		const acct = await signInFresh(page, APP);
		// The owner is pinned in configuration, which is what makes the mint form
		// appear at all: `buildBetaMint` draws nothing for anybody else.
		if (!await startGateway(cwd, acct)) {
			console.log('  FAIL the gateway did not restart with the owner pinned');
			GW_LOG.report(); cleanup(); process.exit(1);
		}

		await page.goto(`${APP}/console/#beta`, { waitUntil: 'domcontentloaded' });
		await page.waitForSelector('#admin-app:not([hidden])', { timeout: 20000 });
		const formed = await waitFor(async () => await page.evaluate(
			() => !!document.getElementById('admin-beta-tier')), 30000);
		check('the mint form holds a tier control', formed);
		if (!formed) {
			await page.screenshot({ path: path.join(SHOTS, 'betatier-nopanel.png') });
			throw new Error('no tier control was drawn');
		}

		const opts = await page.evaluate(() => {
			const s = document.getElementById('admin-beta-tier');
			return { value: s.value, texts: Array.from(s.options).map(o => o.value + ': ' + o.textContent) };
		});
		check('it opens on the free tier', opts.value === 'free', JSON.stringify(opts.texts));

		/// Mint through the panel itself: type the label, set the tier, press Mint,
		/// and wait for the status line to settle.
		async function mintThroughPanel(label, tier) {
			await page.fill('#admin-beta-label', label);
			if (tier) await page.selectOption('#admin-beta-tier', tier);
			await page.click('#admin-beta-mint');
			await waitFor(async () => await page.evaluate(() => {
				const s = (document.getElementById('admin-beta-status') || {}).textContent || '';
				return s !== '' && s !== 'Minting…';
			}), 25000);
			return await page.evaluate(() =>
				(document.getElementById('admin-beta-status') || {}).textContent || '');
		}

		const freeSaid = await mintThroughPanel('Sam, free cohort', null);
		check('minting with the control untouched says it was free',
			/free passcode/.test(freeSaid), freeSaid);
		const proSaid = await mintThroughPanel('Sam, mail cohort', 'pro');
		check('minting with it set to Pro says so', /Pro passcode/.test(proSaid), proSaid);

		// What the rows now SAY, read off the drawn panel rather than off the
		// reply: the pill is the only thing that tells an operator which of two
		// codes in front of them gifts a licence.
		const rows = await page.evaluate(() => Array.from(
			document.querySelectorAll('#admin-beta-list .admin-rel-row')).map(r => ({
				label: (r.querySelector('.admin-rel-blurb') || {}).textContent || '',
				pills: Array.from(r.querySelectorAll('.admin-pill')).map(p => p.textContent),
			})));
		const freeRow = rows.find(r => r.label === 'Sam, free cohort');
		const proRow  = rows.find(r => r.label === 'Sam, mail cohort');
		check('the free row is drawn as free',
			!!freeRow && freeRow.pills.includes('free'), JSON.stringify(freeRow));
		check('the Pro row is drawn as Pro',
			!!proRow && proRow.pills.includes('Pro'), JSON.stringify(proRow));

		// And the gateway agrees, which is what says the control reached it rather
		// than only the panel's own sentence.
		const seen = await page.evaluate(async () => {
			const r = await fetch('/api/admin?view=passcodes', {
				credentials: 'same-origin', headers: { 'x-daimond-api': '1' } });
			const j = await r.json();
			return (j.passcodes || []).map(p => p.label + ': ' + p.pro);
		});
		check('the gateway holds the tier the panel asked for',
			seen.includes('Sam, free cohort: false') && seen.includes('Sam, mail cohort: true'),
			JSON.stringify(seen));

		await page.locator('#admin-beta-card').screenshot(
			{ path: path.join(SHOTS, 'betatier-panel.png') }).catch(() => {});
		await page.locator('#admin-beta-add').screenshot(
			{ path: path.join(SHOTS, 'betatier-form.png') }).catch(() => {});
		if (errs.length) {
			check('the page threw nothing', false, errs.join(' · '));
		} else {
			check('the page threw nothing', true);
		}
		console.log('\n  shots under ' + SHOTS);
	} catch (e) {
		console.error(e);
		GW_LOG.report();
		bad.push('the run finished');
	} finally {
		await browser.close();
		cleanup();
	}
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
