// A browser harness for driving Daimond the way a user does.
//
// Every flow worth testing runs through the real page: the wasm, the panels,
// the agent loop, the tools.  This opens a browser on the dev server, gets
// past the passphrase gate, points the app at the mock provider, and hands
// back a page you can drive.  Console errors and page crashes are collected
// throughout, because a flow that "works" while throwing is not working.
//
//   import { open, chat, shot, errors } from './harness.mjs';
//   const s = await open();                       // signed in, model connected
//   await chat(s, '@tool file_write {"path":"a.txt","content":"hi"}');
//   await shot(s, 'after-write');
//   await s.close();
//
// Headless by default.  Pass { headed: true } for the extension flows, which
// need real rendering — and run those under xvfb, never on the user's display.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// playwright-core lives outside the repo, so it is resolved by path, not by
// package name — nothing here is installed into the app.
const PW = process.env.DAIMOND_PW
	|| path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'shots');

export const APP   = 'http://localhost:8777';
export const MOCK  = 'http://127.0.0.1:9099/v1/chat/completions';
export const MODEL = 'mock/fast';
export const PASS  = 'testpass1234';
export const CHROME = process.env.DAIMOND_CHROME
	|| `${process.env.HOME}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;

const MOCK_LOG = path.join(HERE, 'mockllm.log');

/// Everything the model was sent, since `clearMockLog()` was last called.
export const mockLog = () => {
	if (!fs.existsSync(MOCK_LOG)) return [];
	return fs.readFileSync(MOCK_LOG, 'utf8').split('\n')
		.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
		.filter(Boolean);
};
export const clearMockLog = () => { try { fs.writeFileSync(MOCK_LOG, ''); } catch {} };

/// Launch a browser, sign in, and connect the mock model.
///
/// `name` seeds a distinct identity so parallel sessions never share state;
/// each gets its own browser profile, so OPFS and localStorage are its own.
export async function open(opts = {}) {
	const {
		headed    = false,
		name      = 'tester',
		extension = null,		// path to an unpacked extension, headed only
		connect   = true,		// skip to test the disconnected state
		signIn    = true,		// skip to test the gate itself
		// A fixed profile directory, so a run keeps the identity — and therefore the
		// GATEWAY ACCOUNT — of the run before it. Without one, every run mints a new
		// account, and nothing that needs an entitlement (mail, a pack) can be tested
		// twice: the grant would land on an account the next run does not have.
		profile   = null,
	} = opts;

	const args = ['--no-sandbox', '--disable-dev-shm-usage'];
	if (extension) {
		args.push(`--disable-extensions-except=${extension}`, `--load-extension=${extension}`);
	}
	if (!headed) args.push('--headless=new');

	// A persistent context per session, on its own profile: OPFS, localStorage
	// and identity are that session's alone, so sessions may run in parallel.
	const profileDir = profile || path.join('/tmp/daimond-pw', `${name}-${process.pid}`);
	fs.mkdirSync(profileDir, { recursive: true });
	const browser = await chromium.launchPersistentContext(profileDir, {
		executablePath: CHROME,
		headless:       false,		// the flag above decides; MV3 needs a real browser
		args,
		viewport:       { width: 1500, height: 950 },
	});

	const page = browser.pages()[0] || await browser.newPage();
	const errs   = [];
	const logs   = [];
	page.on('console', m => {
		logs.push(`${m.type()}: ${m.text()}`);
		if (m.type() === 'error') errs.push(m.text());
	});
	page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
	page.on('crash', () => errs.push('PAGE CRASHED'));

	await page.goto(APP, { waitUntil: 'domcontentloaded' });

	const s = { browser, page, errs, logs, name };

	if (signIn) await signInAs(s, name);
	if (signIn && connect) await connectMock(s);

	s.close = async () => { await browser.close(); };
	return s;
}

/// Get past the passphrase gate, creating the identity on first run.
export async function signInAs(s, name) {
	const { page } = s;
	await page.waitForSelector('#id-primary', { timeout: 15000 });
	const nameBox = await page.$('#id-name');
	if (nameBox && await nameBox.isVisible()) await nameBox.fill(name);
	await page.fill('#id-pass', PASS);
	const confirm = await page.$('#id-pass2');
	if (confirm && await confirm.isVisible()) await confirm.fill(PASS);	// first run only
	// A direct DOM click, not page.click: the modal's fade keeps failing
	// Playwright's "stable" actionability check, so the normal click can hang
	// on a button that is perfectly clickable. The gate has no interception to
	// worry about (verified), so bypassing actionability is safe here.
	await page.evaluate(() => document.getElementById('id-primary').click());
	// The identity modal closes when it takes; if it does not, say why.
	await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 })
		.catch(async () => {
			const why = await page.evaluate(() =>
				(document.getElementById('id-error') || {}).textContent || '(no message)');
			throw new Error(`sign-in did not take: ${why}`);
		});
	await page.waitForTimeout(400);
}

/// Start a chat, which is what makes the composer appear.
///
/// A new chat is a *pending tile*: it carries a model and a Start button, and
/// becomes a live chat only when Start is pressed.  The harness presses it.
export async function newChat(s) {
	const { page } = s;
	if (await page.isVisible('#chat-input')) return;
	// force:true throughout — a page animation keeps failing Playwright's
	// "stable" actionability check, hanging otherwise-fine clicks.
	await page.click('#new-session-btn', { force: true });
	await page.waitForTimeout(500);
	const start = page.locator('button:has-text("Start")').first();
	if (await start.count()) {
		await start.click({ force: true });
	}
	await page.waitForSelector('#chat-input', { state: 'visible', timeout: 10000 });
	await page.waitForTimeout(300);
}

/// Point the app at the mock provider through the real Settings form.
export async function connectMock(s, { baseUrl = MOCK, model = MODEL } = {}) {
	const { page } = s;
	await page.evaluate(async ({ baseUrl, model }) => {
		// Drive the form the user drives, so its own save path is exercised.
		const open = document.getElementById('settings-btn')
			|| document.querySelector('[data-admin="settings"]')
			|| document.querySelector('#admin-settings-btn');
		if (open) open.click();
		await new Promise(r => setTimeout(r, 200));
		const prov = document.getElementById('cfg-provider');
		if (prov) {
			prov.value = 'custom';
			prov.dispatchEvent(new Event('change', { bubbles: true }));
		}
		await new Promise(r => setTimeout(r, 200));
		const url = document.getElementById('cfg-base-url');
		if (url) {
			url.value = baseUrl;
			url.dispatchEvent(new Event('input', { bubbles: true }));
			url.dispatchEvent(new Event('change', { bubbles: true }));
		}
		const key = document.getElementById('cfg-api-key');
		if (key) {
			key.value = 'mock-key';
			key.dispatchEvent(new Event('input', { bubbles: true }));
			key.dispatchEvent(new Event('change', { bubbles: true }));
		}
		await new Promise(r => setTimeout(r, 600));	// the model list is fetched
		const sel = document.getElementById('cfg-model');
		const cus = document.getElementById('cfg-model-custom');
		if (sel && [...sel.options].some(o => o.value === model)) {
			sel.value = model;
			sel.dispatchEvent(new Event('change', { bubbles: true }));
		} else if (cus) {
			cus.style.display = '';
			cus.value = model;
			cus.dispatchEvent(new Event('input', { bubbles: true }));
			cus.dispatchEvent(new Event('change', { bubbles: true }));
		}
		const save = document.getElementById('byok-save');
		if (save) save.click();
	}, { baseUrl, model });
	await s.page.waitForTimeout(1200);

	// Whatever the form did, the app is only connected if it says it is.
	const ready = await s.page.evaluate(() => {
		try {
			const raw = localStorage.getItem('daimond-byok');
			if (!raw) return null;
			const j = JSON.parse(raw);
			return { baseUrl: j.baseUrl, model: j.model, hasKey: !!(j.apiKey || j.apiKeyEnc) };
		} catch { return null; }
	});
	s.cfg = ready;
	return ready;
}

/// Connect a real provider (from dev/.secrets/testcfg.json) through the real
/// Settings form. `tier` selects value|mid|power. Returns the saved cfg.
export async function connectReal(s, tier = 'value') {
	const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '.secrets/testcfg.json'), 'utf8'));
	const model = cfg.models[tier] || cfg.models.value;
	await s.page.evaluate(async (c) => {
		document.getElementById('settings-btn')?.click();
		await new Promise(r => setTimeout(r, 250));
		const prov = document.getElementById('cfg-provider');
		prov.value = 'custom'; prov.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise(r => setTimeout(r, 200));
		const url = document.getElementById('cfg-base-url');
		url.value = c.baseUrl; url.dispatchEvent(new Event('input', { bubbles: true })); url.dispatchEvent(new Event('change', { bubbles: true }));
		const key = document.getElementById('cfg-api-key');
		key.value = c.apiKey; key.dispatchEvent(new Event('input', { bubbles: true })); key.dispatchEvent(new Event('change', { bubbles: true }));
		await new Promise(r => setTimeout(r, 1500));
		const cus = document.getElementById('cfg-model-custom');
		if (cus) { cus.style.display = ''; cus.value = c.model; cus.dispatchEvent(new Event('input', { bubbles: true })); }
		const sel = document.getElementById('cfg-model');
		if (sel && [...sel.options].some(o => o.value === c.model)) { sel.value = c.model; sel.dispatchEvent(new Event('change', { bubbles: true })); }
		document.getElementById('byok-save')?.click();
	}, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model });
	await s.page.waitForTimeout(1500);
	s.model = model;
	return model;
}

/// Cumulative USD spend recorded in the client ledger for this session.
export function spend(s) {
	return s.page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-ledger') || '[]').reduce((a, e) => a + (e.u || 0), 0); }
		catch { return 0; }
	});
}

/// Send a message and wait for the turn to finish.
///
/// "Finished" means the send button is offering Send again, not Stop — the
/// only signal the UI itself trusts.
export async function chat(s, text, { timeout = 30000 } = {}) {
	const { page } = s;
	await newChat(s);
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
	await page.waitForTimeout(300);
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const busy = await page.evaluate(() => {
			const b = document.getElementById('chat-send');
			if (!b) return false;
			const t = (b.getAttribute('title') || '') + (b.className || '');
			return /stop/i.test(t) || b.disabled;
		});
		if (!busy) break;
		await page.waitForTimeout(250);
	}
	await page.waitForTimeout(400);
	return transcript(s);
}

/// The visible conversation, as text.
export async function transcript(s) {
	return s.page.evaluate(() => {
		const out = document.getElementById('chat-output');
		return out ? out.innerText : '';
	});
}

/// A screenshot, kept in dev/shots.
export async function shot(s, label) {
	fs.mkdirSync(SHOTS, { recursive: true });
	const p = path.join(SHOTS, `${label}.png`);
	// Non-fatal and time-boxed: a headless render can hang on a live animation,
	// and a missing screenshot must never fail a test that otherwise passed.
	await s.page.screenshot({ path: p, fullPage: false, timeout: 8000 }).catch(() => {});
	return p;
}

/// Console errors seen so far, minus the noise a dev server always makes.
export function errors(s) {
	const skip = [/favicon/i, /net::ERR_ABORTED.*hot/i];
	return s.errs.filter(e => !skip.some(r => r.test(e)));
}
