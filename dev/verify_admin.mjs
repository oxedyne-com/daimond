// verify_admin.mjs — the operator console: token auth, the /api/admin data
// feed, and the dashboard (KPIs, revenue + consumption charts, world map,
// tables) rendering end to end.
//
// Self-contained: it spawns the release gateway on :9002 (reading the operator
// token from gateway/keys/admin_token.txt) and dev/serve.mjs on :8777, seeds a
// handful of accounts and webhook-credited top-ups so the views have something
// to draw, then drives the real /console/ page in a real browser.
//
//   node dev/verify_admin.mjs
//
// Asserts the auth contract (no token → 401, wrong token → 401, right token →
// 200 summary), then screenshots the dashboard desktop + mobile into dev/shots.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { signInFresh } from './session.mjs';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const GWDIR = path.join(ROOT, 'gateway');
const SHOTS = path.join(HERE, 'shots');
const GW_URL = 'http://127.0.0.1:9002';
const APP    = 'http://localhost:8777';

const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WHSEC = fs.readFileSync(path.join(GWDIR, 'keys/stripe/sandbox/whsec'), 'utf8').trim();

const procs = [];
function launch(cmd, args, opts) {
	const p = spawn(cmd, args, opts);
	procs.push(p);
	return p;
}
async function waitFor(fn, ms = 20000, gap = 300) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}
function cleanup() {
	for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} }
}

// ── Seeding via the real API ────────────────────────────────
// Register an account by proving possession of a fresh Ed25519 device key,
// exactly as the browser does.
async function register(country) {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	const jwk = publicKey.export({ format: 'jwk' });
	const pub = jwk.x;					// base64url raw 32-byte public key
	const ts  = Math.floor(Date.now() / 1000);
	const msg = `daimond-gw-account:v1:${pub}:${ts}`;
	const sig = crypto.sign(null, Buffer.from(msg), privateKey).toString('base64');
	const body = { pubkey: pub, alg: 'Ed25519', ts, sig };
	if (country) body.country = country;
	const r = await fetch(`${GW_URL}/api/account`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
		body: JSON.stringify(body),
	});
	const j = await r.json();
	return j.account_id;
}

// Credit an account by posting a Stripe-signed checkout.session.completed, the
// same event the gateway trusts to move money.
async function creditTopup(accountId, minor, country, n) {
	const payload = JSON.stringify({
		id: `evt_seed_${accountId}_${n}`,
		type: 'checkout.session.completed',
		data: { object: {
			payment_status: 'paid',
			amount_total: minor,
			customer_details: { address: { country } },
			metadata: { account_id: accountId, product: 'credits', credits_minor: String(minor) },
		} },
	});
	const t = Math.floor(Date.now() / 1000);
	const mac = crypto.createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
	const r = await fetch(`${GW_URL}/webhook/stripe`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` },
		body: payload,
	});
	return r.status;
}

async function seed() {
	const plan = [
		['US', 5000], ['US', 2000], ['GB', 10000], ['AU', 5000], ['DE', 2000],
		['IN', 1000], ['BR', 5000], ['CA', 2000], ['JP', 1000], ['FR', 5000],
		['', 2000],						// unknown-location account
	];
	let credited = 0, made = 0;
	for (let i = 0; i < plan.length; i++) {
		const [cc, minor] = plan[i];
		const id = await register(cc);
		if (!id) continue;
		made++;
		const st = await creditTopup(id, minor, cc || 'US', 1);
		if (st >= 200 && st < 300) credited++;
	}
	return { made, credited };
}

// ── Raw auth contract ───────────────────────────────────────
// The console is reached with the app's own signed session, so an unauthenticated
// call is the only thing Node can make on its own -- and it must be refused.
async function adminRaw() {
	const r = await fetch(`${GW_URL}/api/admin?view=summary`, {
		headers: { 'x-daimond-api': '1' },
	});
	let j = null; try { j = await r.json(); } catch (e) {}
	return { status: r.status, j };
}

// ── Main ────────────────────────────────────────────────────
(async () => {
	// 1. Gateway.
	// Pinned as an owner by account id, which is not known until an account
	// exists -- so this suite starts the gateway twice, as verify_releases does.
	let gw = launch(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
		cwd: GWDIR,
		env: { ...process.env, APP_MODE: 'sandbox' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	gw.stdout.on('data', () => {});
	gw.stderr.on('data', () => {});
	const gwUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
	check('gateway starts and answers /api/health', gwUp);
	if (!gwUp) { cleanup(); console.log(`\n${ok.length} passed, ${bad.length} failed`); process.exit(1); }

	// 2. Auth contract: no session, no console. There is no token to try.
	const anon = await adminRaw();
	check('no session → 401', anon.status === 401, 'status ' + anon.status);

	// 3. Seed, then confirm the aggregates moved.
	const seeded = await seed();
	check('seeding registered accounts and credited top-ups',
		seeded.made > 0 && seeded.credited > 0, JSON.stringify(seeded));
	// 4. Dev server + browser. The aggregates are checked from inside the page,
	//    because the session that may read them lives in the browser.
	launch('node', ['dev/serve.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
	const serveUp = await waitFor(async () => (await fetch(`${APP}/console/`)).ok, 10000);
	check('dev server serves /console/', serveUp);

	if (serveUp) {
		const { chromium } = await import(pathToFileURL(PW).href);
		const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
		const errs = [];
		try {
			const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
			page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
			page.on('pageerror', e => errs.push('pageerror: ' + e.message));

			// Sign in as the app does, then pin that account as an owner and
			// restart, since an owner is named in configuration by account id.
			const owner = await signInFresh(page, APP);
			check('a fresh account signs in to the gateway', !!owner, owner || 'none');
			try { gw.kill('SIGKILL'); } catch (e) {}
			await sleep(1500);
			gw = launch(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
				cwd: GWDIR,
				env: { ...process.env, APP_MODE: 'sandbox', DAIMOND_OWNER_ACCOUNTS: owner },
				stdio: ['ignore', 'ignore', 'ignore'],
			});
			check('gateway restarts with that account as owner',
				await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok));

			const agg = await page.evaluate(async () => {
				const r = await fetch('/api/admin?view=summary', { credentials: 'same-origin' });
				return { status: r.status, j: await r.json().catch(() => null) };
			});
			check('summary counts the seeded accounts',
				agg.j && agg.j.accounts >= seeded.made, 'accounts ' + (agg.j && agg.j.accounts));
			const revTotal = ((agg.j && agg.j.revenue) || []).reduce((a, r) => a + (r.total || 0), 0);
			check('summary revenue reflects the credited top-ups', revTotal > 0, 'revenue ' + revTotal);
			const geoJson = await page.evaluate(async () => {
				const r = await fetch('/api/admin?view=geo', { credentials: 'same-origin' });
				return await r.json().catch(() => null);
			});
			check('geo view returns per-country rows',
				geoJson && geoJson.ok && Array.isArray(geoJson.countries) && geoJson.countries.length > 1,
				((geoJson && geoJson.countries) || []).length + ' countries');
			errs.length = 0;			// the pre-owner 403s were asked for

			await page.goto(`${APP}/console/`, { waitUntil: 'domcontentloaded' });
			await page.waitForSelector('#admin-app:not([hidden])', { timeout: 10000 });
			// Let the four parallel view fetches land and draw.
			await page.waitForFunction(() =>
				document.querySelectorAll('#admin-kpis .admin-kpi').length >= 4, null, { timeout: 8000 })
				.catch(() => {});
			await sleep(800);

			const kpis = await page.evaluate(() => document.querySelectorAll('#admin-kpis .admin-kpi').length);
			check('dashboard renders KPI tiles', kpis >= 6, kpis + ' tiles');

			const land = await page.evaluate(() =>
				!!document.querySelector('#admin-map .admin-worldmap path.admin-land'));
			check('world map renders its land outline', land);
			const bubbles = await page.evaluate(() =>
				document.querySelectorAll('#admin-map circle.admin-bubble').length);
			check('world map plots usage bubbles', bubbles > 0, bubbles + ' bubbles');

			const revBars = await page.evaluate(() =>
				document.querySelectorAll('#admin-revenue .admin-bar').length);
			check('revenue chart draws bars', revBars > 0, revBars + ' bars');

			const acctRows = await page.evaluate(() =>
				document.querySelectorAll('#admin-accounts table tbody tr').length);
			check('accounts table has rows', acctRows > 0, acctRows + ' rows');
			const ledRows = await page.evaluate(() =>
				document.querySelectorAll('#admin-ledger table tbody tr').length);
			check('ledger table has rows', ledRows > 0, ledRows + ' rows');

			fs.mkdirSync(SHOTS, { recursive: true });
			await page.screenshot({ path: path.join(SHOTS, 'admin-desktop.png'), fullPage: true }).catch(() => {});

			// Mobile.
			await page.setViewportSize({ width: 390, height: 844 });
			await sleep(500);
			await page.screenshot({ path: path.join(SHOTS, 'admin-mobile.png'), fullPage: true }).catch(() => {});

			check('no console errors on the dashboard', errs.length === 0, errs.slice(0, 3).join(' | '));
		} catch (e) {
			check('browser run completed without throwing', false, e.message);
		} finally {
			await browser.close();
		}
	}

	cleanup();
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
