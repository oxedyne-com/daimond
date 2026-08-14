// Does the Home drawer show the console link to an account that holds a role?
// The network path is the gateway's and is already proven by the console page
// itself; what is under test here is the drawer's own logic.
//
// It counted its own reds all along and then exited 0, so the count reached
// nobody: `run_all.sh` reads the exit code. It exits on the count now.
//
// PROVED AGAINST A ROLE-LESS ANSWER FIRST. `--break norole` has whoami answer as
// the gateway would for an account holding nothing, and the run is expected to
// FAIL — a check that has only ever been shown the owner cannot tell whether it
// is reading the drawer's logic or just finding a link that is always there.
//
//   node dev/verify_consolelink.mjs --break norole   # expected to FAIL
//   node dev/verify_consolelink.mjs                  # and then, clean
import { open, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && BREAK !== 'norole') {
	console.error(`unknown break '${BREAK}'; known: norole`);
	process.exit(2);
}

const s = await open({ name: 'consolelink' });
const { page } = s;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);
page.on('request', r => { if (r.url().includes('/api/admin')) console.log('REQ ', r.url()); });
page.on('response', r => { if (r.url().includes('/api/admin')) console.log('RESP', r.status(), r.url()); });
page.on('console', m => { const t = m.text(); if (/console|whoami|admin/i.test(t)) console.log('LOG ', t); });

// Answer whoami as the gateway would for an owner, before the drawer is opened.
let asked = 0;
await page.route('**/api/admin*', route => {
	asked++;
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		body: JSON.stringify(BREAK === 'norole'
			? { ok: true, account_id: 'acct', client_fp: 'aaaa bbbb', role: null, can_grant: false }
			: { ok: true, account_id: 'acct', client_fp: 'aaaa bbbb', role: 'owner', can_grant: true }),
	});
});

// Open the Home drawer by the cog, which is what a user reaches for.
//
// The cog TOGGLES, so this first puts the drawer away. `open()` does not leave
// it in a known state: `connectMock` drives the model form through the same
// cog and does not close it afterwards. This test used to click once and find
// the drawer open, but only because a bug elsewhere -- unlocking reopened it,
// so connectMock's click was closing rather than opening. Fixing that bug
// flipped the parity and failed this test, which was never really testing the
// cog. Normalise, then open.
await page.evaluate(() => {
	document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
});
await page.waitForTimeout(400);
await page.click('#settings-btn', { force: true });
await page.waitForTimeout(1700);

// The drawer has to be open, or "no link" below means "no drawer" and the check
// reads as a pass for the wrong reason under --break.
const secs = await page.$$eval('.admin-sec', els => els.map(e => e.textContent));
check('the cog opened the Home drawer', secs.length > 0, `${secs.length} sections: ${JSON.stringify(secs)}`);
check('and the drawer asked the gateway who we are', asked > 0, `${asked} calls to /api/admin`);

const seen = await page.$('.admin-console-link');
check('THE CONSOLE LINK IS IN THE DRAWER FOR A ROLE-HOLDER', !!seen, '.admin-console-link');
if (seen) {
	const info = await page.$eval('.admin-console-link', a => ({ href: a.getAttribute('href'), text: a.textContent, target: a.target }));
	check('and it points at the console', info.href === '/console/', JSON.stringify(info));
}

// What the drawer actually contains, when it does not.
const state = await page.evaluate(() => ({
	unlocked: !!(window.DaimondIdentity && DaimondIdentity.isUnlocked()),
	exists: !!(window.DaimondIdentity && DaimondIdentity.exists()),
}));
console.log('identity:', JSON.stringify(state));
await shot(s, 'console-link');

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
