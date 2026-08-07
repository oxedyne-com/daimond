// Does the Home drawer show the console link to an account that holds a role?
// The network path is the gateway's and is already proven by the console page
// itself; what is under test here is the drawer's own logic.
import { open, shot } from './harness.mjs';

const s = await open({ name: 'consolelink' });
const { page } = s;
page.on('request', r => { if (r.url().includes('/api/admin')) console.log('REQ ', r.url()); });
page.on('response', r => { if (r.url().includes('/api/admin')) console.log('RESP', r.status(), r.url()); });
page.on('console', m => { const t = m.text(); if (/console|whoami|admin/i.test(t)) console.log('LOG ', t); });
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

// Answer whoami as the gateway would for an owner, before the drawer is opened.
await page.route('**/api/admin*', route => route.fulfill({
	status: 200,
	contentType: 'application/json',
	body: JSON.stringify({ ok: true, account_id: 'acct', client_fp: 'aaaa bbbb', role: 'owner', can_grant: true }),
}));

// Open the Home drawer by the cog, which is what a user reaches for.
await page.click('#settings-btn', { force: true });
await page.waitForTimeout(900);
await page.waitForTimeout(800);
let seen = await page.$(".admin-console-link");
check(!!seen, 'the console link is in the drawer for a role-holder');
if (seen) {
	const info = await page.$eval('.admin-console-link', a => ({ href: a.getAttribute('href'), text: a.textContent, target: a.target }));
	console.log(JSON.stringify(info));
	check(info.href === '/console/', `it points at the console (${info.href})`);
}
// What the drawer actually contains, when it does not.
const state = await page.evaluate(() => ({
  unlocked: !!(window.DaimondIdentity && DaimondIdentity.isUnlocked()),
  exists: !!(window.DaimondIdentity && DaimondIdentity.exists()),
}));
console.log('identity:', JSON.stringify(state));
const secs = await page.$$eval('.admin-sec', els => els.map(e => e.textContent));
console.log('drawer sections:', JSON.stringify(secs));
await shot(s, 'console-link');
console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
await s.close();
