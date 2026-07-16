// A long-lived HEADED browser on the user's screen (:0), launched by Playwright
// (which gets the sandbox flags right) and left alive with CDP exposed so other
// scripts can attach and drive it. Real Fireworks key, from the gitignored
// testcfg. Signs in (skips the passphrase), connects the value model, and then
// waits — the user can watch, and grant a real folder when asked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PW = path.join(os.homedir(), '.red-pw/node_modules/playwright-core/index.mjs');
const { chromium } = await import(pathToFileURL(PW).href);
const CHROME = `${os.homedir()}/.cache/ms-playwright/chromium-1229/chrome-linux64/chrome`;
const cfg = JSON.parse(fs.readFileSync(path.join(HERE, '.secrets/testcfg.json'), 'utf8'));
const MODEL = cfg.models.value;
const CDP_PORT = 9223;

const browser = await chromium.launchPersistentContext('/tmp/daimond-real-profile', {
	executablePath: CHROME,
	headless: false,
	args: [
		'--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
		`--remote-debugging-port=${CDP_PORT}`,
		'--window-size=1600,1000', '--window-position=40,40',
	],
	viewport: null,
});
const page = browser.pages()[0] || await browser.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('PAGEERR:', m.text().slice(0, 200)); });

await page.goto('http://localhost:8777', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 20000 });

// Skip the passphrase (browser-only mode) so the key is simply set; a throwaway
// test profile, so plaintext-in-localStorage is fine here.
const skip = await page.$('#id-skip');
if (skip && await skip.isVisible()) await skip.click();
await page.waitForTimeout(800);

// Set the real provider config directly, then reload so the app adopts it.
await page.evaluate((c) => {
	localStorage.setItem('daimond-byok', JSON.stringify({
		baseUrl: c.baseUrl, apiKey: c.apiKey, apiKeyEnc: '', model: c.model, maxTokens: 4096, tools: true,
	}));
}, { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: MODEL });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const ready = await page.evaluate(() => {
	try { const j = JSON.parse(localStorage.getItem('daimond-byok') || '{}');
		return { model: j.model, hasKey: !!j.apiKey, base: j.baseUrl }; } catch { return null; }
});
console.log('KEEPER READY on :0 — CDP on', CDP_PORT, '— cfg:', JSON.stringify(ready));
console.log('Attach with: connectOverCDP("http://localhost:' + CDP_PORT + '")');

// Stay alive. Other scripts attach over CDP and drive this same browser.
await new Promise(() => {});
