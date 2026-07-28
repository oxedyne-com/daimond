// verify_errnames.mjs — when a form refuses, it says WHICH box is wrong.
//
// The fourth property search, after reversible, escapable and focus. A form that
// answers "that didn't work" has told the user nothing they did not already
// know; a form that names a box they did not touch is worse, because they will
// go and change it. The property is narrow and checkable: submit a form with
// exactly ONE thing wrong, and the message that comes back has to mention that
// thing.
//
// It is a search rather than a script because the interesting failures are the
// ones nobody wrote a case for. The BYOK form validated that a base URL was
// PRESENT but never that it was a URL, so "http:/typo" sailed past, the model
// list could not load from it, and the refusal that finally came back read
// "Choose a model, or wait a moment for the list to load" — naming the one box
// the user had filled in correctly.
//
//   node dev/verify_errnames.mjs
//   node dev/verify_errnames.mjs byok-badurl
//
// Needs dev/serve.mjs on :8777. No gateway.

import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

let failures = 0, skips = 0;
const skipped = [];
const check = (cond, msg, detail) => {
	console.log((cond ? '    ok   ' : '    FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const skip = (name, why) => {
	console.log('  SKIP ' + name + ' — ' + why);
	skipped.push(name + ': ' + why);
	skips++;
};

async function press(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	await page.evaluate((s) => { const e = document.querySelector(s); if (e) e.click(); }, sel);
	await page.waitForTimeout(350);
}

/// Press the control inside `rootSel` whose text is exactly `text`.
async function pressLabel(page, rootSel, text) {
	await page.waitForSelector(rootSel, { timeout: 10000 });
	const hit = await page.evaluate(({ rootSel, text }) => {
		const root = document.querySelector(rootSel);
		if (!root) return false;
		const b = [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === text);
		if (!b) return false;
		b.click();
		return true;
	}, { rootSel, text });
	if (!hit) throw new Error(`no control labelled "${text}" in ${rootSel}`);
	await page.waitForTimeout(450);
}

/// Set a field the way a person does — the app listens for `input`, and a value
/// assigned without one is a value it never hears about.
async function fill(page, sel, value) {
	await page.evaluate(({ sel, value }) => {
		const el = document.querySelector(sel);
		if (!el) throw new Error('no field ' + sel);
		if (el.tagName === 'SELECT') { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); return; }
		el.value = value;
		el.dispatchEvent(new Event('input',  { bubbles: true }));
		el.dispatchEvent(new Event('change', { bubbles: true }));
	}, { sel, value });
	await page.waitForTimeout(120);
}

// ── One wrong box at a time ─────────────────────────────────────────────
//
// `field` is the box deliberately made wrong; `wants` is what the message has
// to mention for the user to know where to look. `settle` is for forms that go
// and ask a provider something before they answer.
const CASES = [
	{
		id:    'create-noname',
		name:  'Create account, no name',
		field: 'the name',
		open:  { connect: false, signIn: false },
		reach: async () => {},
		act:   async (page) => {
			await fill(page, '#id-name', '');
			// Tick it the way a person does. Setting `.checked` alone leaves the
			// create button disabled -- it is enabled by the `change` the tick
			// fires -- and a disabled button swallows the click, so the form looks
			// silent when it was never asked anything.
			await page.evaluate(() => {
				const w = document.getElementById('id-wrote');
				if (w && !w.checked) { w.checked = true; w.dispatchEvent(new Event('change', { bubbles: true })); }
			});
			await page.evaluate(() => document.getElementById('id-primary').click());
		},
		err:   '#id-error',
		wants: /\bname\b/i,
	},
	{
		id:    'create-shortpass',
		name:  'Create account, passphrase too short',
		field: 'the passphrase',
		open:  { connect: false, signIn: false },
		reach: async (page) => { await press(page, '#id-choose'); },   // type my own
		act:   async (page) => {
			await fill(page, '#id-name', 'Someone');
			await fill(page, '#id-pass', 'abc');
			await fill(page, '#id-pass2', 'abc');
			await page.evaluate(() => document.getElementById('id-primary').click());
		},
		err:   '#id-error',
		wants: /passphrase/i,
	},
	{
		id:    'create-mismatch',
		name:  'Create account, confirmation does not match',
		field: 'the passphrase',
		open:  { connect: false, signIn: false },
		reach: async (page) => { await press(page, '#id-choose'); },
		act:   async (page) => {
			await fill(page, '#id-name', 'Someone');
			await fill(page, '#id-pass', 'correcthorsebattery');
			await fill(page, '#id-pass2', 'correcthorsebatteryX');
			await page.evaluate(() => document.getElementById('id-primary').click());
		},
		err:   '#id-error',
		wants: /passphrase/i,
	},
	{
		id:    'byok-noprovider',
		name:  'Models, no provider chosen',
		field: 'the provider',
		open:  { connect: false },
		reach: openByok,
		act:   async (page) => { await pressLabel(page, '#admin-models', 'Save & start'); },
		err:   '#byok-note',
		wants: /provider/i,
	},
	{
		id:    'byok-nourl',
		name:  'Models, custom provider with no base URL',
		field: 'the base URL',
		open:  { connect: false },
		reach: openByok,
		act:   async (page) => {
			await fill(page, '#cfg-provider', 'custom');
			await fill(page, '#cfg-base-url', '');
			await pressLabel(page, '#admin-models', 'Save & start');
		},
		err:   '#byok-note',
		wants: /\burl\b|address/i,
	},
	{
		id:    'byok-nokey',
		name:  'Models, no API key',
		field: 'the API key',
		open:  { connect: false },
		reach: openByok,
		act:   async (page) => {
			await fill(page, '#cfg-provider', 'custom');
			await fill(page, '#cfg-base-url', 'http://127.0.0.1:9099/v1/chat/completions');
			await fill(page, '#cfg-api-key', '');
			await pressLabel(page, '#admin-models', 'Save & start');
		},
		err:   '#byok-note',
		wants: /\bkey\b/i,
	},
	{
		// The one the exploration found. Everything else is filled in correctly.
		id:     'byok-badurl',
		name:   'Models, base URL that is not a URL',
		field:  'the base URL',
		open:   { connect: false },
		reach:  openByok,
		act:    async (page) => {
			await fill(page, '#cfg-provider', 'custom');
			await fill(page, '#cfg-base-url', 'not a url');
			await fill(page, '#cfg-api-key', 'some-key');
			await page.waitForTimeout(1200);          // it goes off to list models first
			await pressLabel(page, '#admin-models', 'Save & start');
			await page.waitForTimeout(600);
		},
		err:    '#byok-note',
		wants:  /\burl\b|address/i,
	},
	{
		id:    'mail-bademail',
		name:  'Add a mailbox, address that is not one',
		field: 'the email address',
		open:  { connect: false },
		reach: async (page) => {
			await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('mail'));
			await page.waitForTimeout(300);
			await press(page, '#panel-mail [data-act="mail-add"]');
			await page.waitForSelector('#admin-form .dlg-input', { timeout: 8000 });
		},
		act:   async (page) => {
			await fill(page, '#admin-form .dlg-input', 'definitely-not-an-address');
			await pressLabel(page, '#admin-form', 'Add and sync');
		},
		err:   '#admin-form .dlg-err',
		wants: /e-?mail|address/i,
	},
	{
		id:    'pass-wrongcurrent',
		name:  'Change passphrase, wrong current one',
		field: 'the current passphrase',
		open:  { connect: false },
		reach: async (page) => {
			await press(page, '#user-row');
			await pressLabel(page, '#admin-home', 'Change passphrase…');
			await page.waitForSelector('.dlg-card', { timeout: 8000 });
		},
		act:   async (page) => {
			await fill(page, '.dlg .dlg-input', 'not-the-passphrase');
			await page.evaluate(() => { const i = document.querySelector('.dlg .dlg-input'); if (i) i.focus(); });
			await page.keyboard.type('x');
			await page.keyboard.press('Backspace');
			await pressLabel(page, '.modal.dlg', 'Next');
			await page.waitForTimeout(900);           // deriving a key takes a moment
		},
		err:   '.modal.dlg .dlg-err',
		wants: /passphrase/i,
	},
];

/// Open the Models view with the add-a-provider form showing. Several cases
/// start here, so the walk lives once.
async function openByok(page) {
	await press(page, '#astat-model');
	await page.waitForSelector('#admin-models', { timeout: 8000 });
	await page.evaluate(() => { const f = document.getElementById('byok-form'); if (f) f.style.display = ''; });
	await page.waitForTimeout(250);
}

const only = process.argv[2] || '';

for (const c of CASES) {
	if (only && c.id !== only) continue;
	console.log(`\n── ${c.name}`);
	const dir = scratch('pw', 'err-' + Math.random().toString(36).slice(2, 10));
	let s = null;
	try {
		s = await open({ ...c.open, name: 'errnames', profile: dir });
		await c.reach(s.page);
		await s.page.waitForTimeout(300);
		await c.act(s.page);
		await s.page.waitForTimeout(500);
		const msg = (await s.page.evaluate((sel) => {
			const el = document.querySelector(sel);
			return el ? (el.textContent || '').trim() : '';
		}, c.err)) || '';
		if (!msg) {
			check(false, `refusing names ${c.field}`, 'it said NOTHING AT ALL — the form simply did not respond');
		} else {
			check(c.wants.test(msg), `refusing names ${c.field}`, JSON.stringify(msg));
		}
	} catch (e) {
		skip(c.name, String(e && e.message ? e.message : e).split('\n')[0]);
	} finally {
		if (s) { try { await s.close(); } catch (e) { /* already gone */ } }
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* gone */ }
	}
}

if (skipped.length) console.log('\nskipped: ' + skipped.join('; '));
console.log(failures === 0
	? `\nerrnames: every refusal names the box that caused it${skips ? ` (${skips} SKIPPED)` : ''}.`
	: `\nerrnames: ${failures} message(s) that do not name the failing field${skips ? `, ${skips} SKIPPED` : ''}.`);
process.exit(failures === 0 && skips === 0 ? 0 : 1);
