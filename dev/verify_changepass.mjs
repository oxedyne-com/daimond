// verify_changepass.mjs — changing the passphrase now GENERATES the new one.
//
// The create screen already generates the passphrase (verify_genpass.mjs). The
// account a person already has, though, still carries the old user-chosen — and
// so probably short and reused — passphrase. This asserts that Change passphrase
// now offers a generated one by default, gates it behind the same "written it
// down" acknowledgement, keeps a "choose my own" escape hatch with the old floor
// and confirm, and that whichever passphrase is set actually becomes the one that
// unlocks the account (and the old one stops working).
//
//   node dev/verify_changepass.mjs
//
// Needs dev/serve.mjs on :8777. No gateway and no model: this is the login only.

import { open, PASS } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Open the account section of the admin home, where "Change passphrase…" lives.
async function openChangePassphrase(page) {
	await page.evaluate(() => document.getElementById('user-row').click());
	await sleep(200);
	await page.evaluate(() => {
		const b = [...document.querySelectorAll('#admin-home .admin-item')]
			.find(x => /Change passphrase/.test(x.textContent));
		if (b) b.click();
	});
	// The first dialog asks for the CURRENT passphrase (a promptDialog).
	await page.waitForSelector('.dlg-input', { timeout: 8000 });
}

// Answer the current-passphrase prompt, after which the generated-new dialog
// (#cp-modal) opens.
async function passCurrent(page, cur) {
	await page.fill('.dlg-input', cur);           // secret mask tracks input events.
	await page.click('.dlg-ok');
	await page.waitForSelector('#cp-modal', { timeout: 8000 });
	await sleep(150);
}

const s = await open({ name: 'changepass-' + Date.now(), connect: false });
const { page } = s;
await page.waitForSelector('#user-row', { timeout: 15000 });

// ── The new-passphrase dialog offers a generated phrase by default ──
await openChangePassphrase(page);
await passCurrent(page, PASS);

let gen = await page.evaluate(() => {
	const w = document.getElementById('cp-words');
	return {
		words:    w ? w.textContent : '',
		genShown: !!document.querySelector('#cp-modal .pass-gen'),
		typedHid: getComputedStyle(document.querySelector('#cp-modal #cp-pass').parentNode).display === 'none'
		          || document.querySelector('#cp-modal #cp-pass').offsetParent === null,
		disabled: document.querySelector('#cp-modal .dlg-ok').disabled,
		fromList: window.DaimondWords.isFromList((w ? w.textContent : '').trim()),
		note:     (document.querySelector('#cp-modal .pass-gen-note') || {}).textContent || '',
	};
});
check(gen.genShown, 'changing the passphrase offers a generated one');
check(gen.words.trim().split(/\s+/).length === 8, 'it is eight words', gen.words.trim().split(/\s+/).length + ' words');
check(gen.fromList, 'every word comes from the shipped wordlist');
check(/\b103 bits\b/.test(gen.note), 'the note names ~103 bits', /(\d+) bits/.exec(gen.note)?.[0]);
check(gen.typedHid, 'the typed confirm fields are hidden while generating');
check(gen.disabled, 'the change button is disabled until it is acknowledged');

// Generating another really changes the phrase and clears the acknowledgement.
const before = gen.words;
await page.click('#cp-modal .pass-gen-btn');      // "Generate another".
await sleep(150);
const after = await page.evaluate(() => ({
	words:   document.getElementById('cp-words').textContent,
	checked: document.getElementById('cp-wrote').checked,
	disabled: document.querySelector('#cp-modal .dlg-ok').disabled,
}));
check(after.words !== before && after.words.trim().split(/\s+/).length === 8, 'Generate another draws a fresh phrase');
check(!after.checked && after.disabled, 'and re-arms the acknowledgement gate');

// ── The escape hatch: choose your own, with the old floor and confirm ──
await page.click('#cp-modal .id-choose');
await sleep(120);
const own = await page.evaluate(() => ({
	genHid:  !document.querySelector('#cp-modal .pass-gen') ||
	         getComputedStyle(document.querySelector('#cp-modal .pass-gen')).display === 'none',
	newShown: document.querySelector('#cp-modal #cp-pass').offsetParent !== null,
}));
check(own.genHid, 'choosing your own hides the generated phrase');
check(own.newShown, 'and shows a typed new-passphrase field');

// A passphrase equal to the current one is refused.
await page.fill('#cp-modal #cp-pass', PASS);
await page.fill('#cp-modal #cp-pass2', PASS);
await page.click('#cp-modal .dlg-ok');
await sleep(150);
let err = await page.evaluate(() => document.querySelector('#cp-modal .dlg-err').textContent);
check(/current passphrase/.test(err), 'the current passphrase is refused as the new one', err);

// Too short is refused.
await page.fill('#cp-modal #cp-pass', 'short');
await page.fill('#cp-modal #cp-pass2', 'short');
await page.click('#cp-modal .dlg-ok');
await sleep(150);
err = await page.evaluate(() => document.querySelector('#cp-modal .dlg-err').textContent);
check(/at least 8/.test(err), 'a short chosen passphrase is refused', err);

// A mismatched confirmation is refused.
await page.fill('#cp-modal #cp-pass', 'a fine new passphrase');
await page.fill('#cp-modal #cp-pass2', 'a different one entirely');
await page.click('#cp-modal .dlg-ok');
await sleep(150);
err = await page.evaluate(() => document.querySelector('#cp-modal .dlg-err').textContent);
check(/do not match/.test(err), 'a mismatched confirmation is refused', err);

// A valid typed passphrase goes through.
const TYPED = 'a fine new passphrase';
await page.fill('#cp-modal #cp-pass', TYPED);
await page.fill('#cp-modal #cp-pass2', TYPED);
await page.click('#cp-modal .dlg-ok');
const typedTook = await page.waitForSelector('#cp-modal', { state: 'detached', timeout: 8000 })
	.then(() => true).catch(() => false);
check(typedTook, 'a valid typed passphrase is accepted');
// Dismiss the "Passphrase changed" notice.
await page.waitForSelector('.dlg-ok', { timeout: 8000 });
await page.click('.dlg-ok');
await sleep(200);

// ── The typed change took: the OLD passphrase no longer unlocks ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(300);
await page.fill('#id-pass', PASS);
await page.evaluate(() => document.getElementById('id-primary').click());
await page.waitForTimeout(2500);
let stillLocked = await page.evaluate(() => document.getElementById('identity-modal').style.display !== 'none');
check(stillLocked, 'the original passphrase no longer unlocks after the change');
// The new typed one does.
await page.fill('#id-pass', TYPED);
await page.evaluate(() => document.getElementById('id-primary').click());
let openedTyped = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 })
	.then(() => true).catch(() => false);
check(openedTyped, 'the new typed passphrase unlocks the account');

// ── Now change again, taking the GENERATED default, and prove it unlocks ──
await page.waitForSelector('#user-row', { timeout: 10000 });
await openChangePassphrase(page);
await passCurrent(page, TYPED);
const GENERATED = await page.evaluate(() =>
	window.DaimondWords.normalise(document.getElementById('cp-words').textContent));
check(GENERATED.split(' ').length === 8, 'the generated new passphrase is eight words');
await page.check('#cp-modal #cp-wrote', { force: true });
const nowEnabled = await page.evaluate(() => !document.querySelector('#cp-modal .dlg-ok').disabled);
check(nowEnabled, 'acknowledging it enables the change button');
await page.click('#cp-modal .dlg-ok');
const genTook = await page.waitForSelector('#cp-modal', { state: 'detached', timeout: 8000 })
	.then(() => true).catch(() => false);
check(genTook, 'the generated passphrase change goes through');
await page.waitForSelector('.dlg-ok', { timeout: 8000 });
await page.click('.dlg-ok');
await sleep(200);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(300);
// The previous (typed) passphrase is now stale.
await page.fill('#id-pass', TYPED);
await page.evaluate(() => document.getElementById('id-primary').click());
await page.waitForTimeout(2500);
stillLocked = await page.evaluate(() => document.getElementById('identity-modal').style.display !== 'none');
check(stillLocked, 'the previous passphrase no longer unlocks after generating a new one');
// The generated one does — proving the generated phrase on screen is the real key.
await page.fill('#id-pass', GENERATED);
await page.evaluate(() => document.getElementById('id-primary').click());
const openedGen = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 15000 })
	.then(() => true).catch(() => false);
check(openedGen, 'the generated passphrase unlocks the account');

const hardErrs = s.errs.filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
check(hardErrs.length === 0, 'no console errors', hardErrs.join(' | ') || 'none');

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
await s.close();
process.exit(failures ? 1 : 0);
