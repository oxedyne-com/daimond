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

const TOKEN = fs.readFileSync(path.join(GWDIR, 'keys/admin_token.txt'), 'utf8').trim();
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
async function adminRaw(auth) {
	const headers = { 'x-daimond-api': '1' };
	if (auth) headers['Authorization'] = auth;
	const r = await fetch(`${GW_URL}/api/admin?view=summary`, { headers });
	let j = null; try { j = await r.json(); } catch (e) {}
	return { status: r.status, j };
}

// ── Main ────────────────────────────────────────────────────
(async () => {
	// 1. Gateway.
	const gw = launch(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
		cwd: GWDIR,
		env: { ...process.env, APP_MODE: 'sandbox' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	gw.stdout.on('data', () => {});
	gw.stderr.on('data', () => {});
	const gwUp = await waitFor(async () => (await fetch(`${GW_URL}/api/health`)).ok);
	check('gateway starts and answers /api/health', gwUp);
	if (!gwUp) { cleanup(); console.log(`\n${ok.length} passed, ${bad.length} failed`); process.exit(1); }

	// 2. Auth contract.
	const noTok = await adminRaw(null);
	check('no token → 401', noTok.status === 401, 'status ' + noTok.status);
	const wrong = await adminRaw('Bearer not-the-token');
	check('wrong token → 401', wrong.status === 401, 'status ' + wrong.status);
	const right = await adminRaw('Bearer ' + TOKEN);
	check('right token → 200 with summary', right.status === 200
		&& right.j && right.j.ok === true && typeof right.j.accounts === 'number',
		'status ' + right.status);

	// 3. Seed, then confirm the aggregates moved.
	const seeded = await seed();
	check('seeding registered accounts and credited top-ups',
		seeded.made > 0 && seeded.credited > 0, JSON.stringify(seeded));
	const sum = await adminRaw('Bearer ' + TOKEN);
	check('summary counts the seeded accounts', sum.j && sum.j.accounts >= seeded.made,
		'accounts ' + (sum.j && sum.j.accounts));
	const revTotal = ((sum.j && sum.j.revenue) || []).reduce((a, r) => a + (r.total || 0), 0);
	check('summary revenue reflects the credited top-ups', revTotal > 0, 'revenue ' + revTotal);
	const geoRes = await fetch(`${GW_URL}/api/admin?view=geo`, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
	const geoJson = await geoRes.json();
	check('geo view returns per-country rows',
		geoJson.ok && Array.isArray(geoJson.countries) && geoJson.countries.length > 1,
		(geoJson.countries || []).length + ' countries');

	// 4. Dev server + browser.
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

			await page.goto(`${APP}/console/`, { waitUntil: 'domcontentloaded' });
			await page.waitForSelector('#admin-token', { timeout: 8000 });
			await page.fill('#admin-token', TOKEN);
			await page.click('#admin-login-btn');
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
