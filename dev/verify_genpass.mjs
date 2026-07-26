// verify_genpass.mjs — the generated passphrase, and the login form a password
// manager can actually see.
//
// Two changes are asserted here, and they belong together. The passphrase is now
// GENERATED (eight words from the EFF long list, ~103 bits) rather than chosen,
// which removes the two ways a chosen one fails: guessable, and reused from a
// site that has since been breached. That is what makes the second change safe —
// the login is a REAL form with REAL `type="password"` fields and the right
// autocomplete tokens, so the browser and the OS keychain offer to keep it
// instead of the user retyping a long phrase on a phone all day.
//
//   node dev/verify_genpass.mjs
//
// Needs dev/serve.mjs on :8777. No gateway and no model: this is the gate only.

import { open } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const s = await open({ name: 'genpass-' + Date.now(), connect: false, signIn: false });
const { page } = s;
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(400);

// ── The create screen offers a generated passphrase ──
const gen = await page.evaluate(() => ({
	words:    document.getElementById('id-genwords').textContent,
	field:    document.getElementById('id-pass').value,
	visible:  getComputedStyle(document.getElementById('id-genbox')).display !== 'none',
	confirm:  getComputedStyle(document.getElementById('id-pass2-row')).display,
	disabled: document.getElementById('id-primary').disabled,
	fromList: window.DaimondWords.isFromList(document.getElementById('id-pass').value),
	bits:     Math.round(window.DaimondWords.bits(8)),
	listLen:  window.DaimondWords.count(),
}));
check(gen.visible, 'the create screen shows a generated passphrase');
check(gen.words.trim().split(/\s+/).length === 8, 'it is eight words', gen.words.trim().split(/\s+/).length + ' words');
check(gen.fromList, 'every word comes from the shipped wordlist');
check(gen.listLen === 7776, 'the wordlist is the full EFF long list', gen.listLen + ' words');
check(gen.bits === 103, 'which is ~103 bits, the figure Oxegen settles on', gen.bits + ' bits');
check(gen.words === gen.field, 'the readout shows exactly what the field holds');
check(gen.confirm === 'none', 'no confirm field: the words are on screen to be read');
check(gen.disabled, 'the create button is disabled until it is acknowledged');

// ── The markup is one a password manager recognises ──
const form = await page.evaluate(() => {
	const p = document.getElementById('id-pass');
	const n = document.getElementById('id-name');
	const k = document.getElementById('cfg-api-key');
	return {
		inForm:    !!p.closest('form'),
		passType:  p.type,
		passAuto:  p.getAttribute('autocomplete'),
		nameAuto:  n.getAttribute('autocomplete'),
		submits:   (document.getElementById('id-primary') || {}).type,
		opts:      p.hasAttribute('data-1p-ignore') || p.hasAttribute('data-lpignore')
		           || p.getAttribute('autocomplete') === 'off',
		keyType:   k ? k.type : '(absent)',
		keyIgnored: k ? (k.hasAttribute('data-1p-ignore') && k.getAttribute('autocomplete') === 'off') : false,
	};
});
check(form.inForm, 'the passphrase field is inside a real <form>');
check(form.passType === 'password', 'it is a real type=password input', form.passType);
check(form.passAuto === 'new-password', 'creating tags it autocomplete=new-password', form.passAuto);
check(form.nameAuto === 'username', 'the name field is tagged autocomplete=username', form.nameAuto);
check(form.submits === 'submit', 'the button submits the form', form.submits);
check(!form.opts, 'none of the manager opt-outs are left on the passphrase');
// The provider API key is a different kind of secret and stays out of keychains.
check(form.keyType === 'text' && form.keyIgnored,
	'the provider API key is still masked and opted out', form.keyType);

// ── Choosing your own is still allowed, and still has a floor ──
await page.click('#id-choose');
const ownUi = await page.evaluate(() => ({
	genbox:  getComputedStyle(document.getElementById('id-genbox')).display,
	confirm: getComputedStyle(document.getElementById('id-pass2-row')).display,
	field:   document.getElementById('id-pass').value,
}));
check(ownUi.genbox === 'none', 'choosing your own hides the generated phrase');
check(ownUi.confirm !== 'none', 'and brings back the confirm field, since it is typed blind');
check(ownUi.field === '', 'the generated phrase is cleared rather than left to be edited');

await page.fill('#id-name', 'Own Tester');
await page.fill('#id-pass', 'short');
await page.fill('#id-pass2', 'short');
await page.evaluate(() => document.getElementById('id-primary').click());
await page.waitForTimeout(400);
let ownErr = await page.evaluate(() => document.getElementById('id-error').textContent);
check(/at least 8/.test(ownErr), 'a short chosen passphrase is refused', ownErr);

await page.fill('#id-pass', 'a long enough one');
await page.fill('#id-pass2', 'a different one entirely');
await page.evaluate(() => document.getElementById('id-primary').click());
await page.waitForTimeout(400);
ownErr = await page.evaluate(() => document.getElementById('id-error').textContent);
check(/do not match/.test(ownErr), 'a mismatched confirmation is refused', ownErr);

// Back to a fresh create screen, generated by default again.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(400);
const backToGen = await page.evaluate(() =>
	getComputedStyle(document.getElementById('id-genbox')).display !== 'none');
check(backToGen, 'a fresh visit is back to a generated passphrase by default');

// ── Generating another really changes it ──
const first = await page.evaluate(() => document.getElementById('id-pass').value);
await page.click('#id-regen');
await page.waitForTimeout(150);
const second = await page.evaluate(() => document.getElementById('id-pass').value);
check(second !== first && second.split(' ').length === 8, 'Generate another draws a fresh phrase');
const readoutTracks = await page.evaluate(() =>
	document.getElementById('id-genwords').textContent === document.getElementById('id-pass').value);
check(readoutTracks, 'and the readout follows the field');

// ── Create the account with it ──
const phrase = second;
await page.fill('#id-name', 'Gen Tester');
await page.check('#id-wrote', { force: true });
const enabled = await page.evaluate(() => !document.getElementById('id-primary').disabled);
check(enabled, 'acknowledging it enables the create button');
await page.evaluate(() => document.getElementById('id-primary').click());
const made = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 20000 })
	.then(() => true).catch(() => false);
check(made, 'the account is created from the generated passphrase');

// ── A reload locks it; the same phrase unlocks ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(400);
const unlockUi = await page.evaluate(() => ({
	mode:     document.getElementById('identity-modal').dataset.mode,
	passAuto: document.getElementById('id-pass').getAttribute('autocomplete'),
	nameVal:  document.getElementById('id-name').value,
	nameRO:   document.getElementById('id-name').readOnly,
	genbox:   getComputedStyle(document.getElementById('id-genbox')).display,
	confirm:  getComputedStyle(document.getElementById('id-pass2-row')).display,
	choose:   getComputedStyle(document.getElementById('id-choose')).display,
}));
check(unlockUi.mode === 'unlock', 'a reload comes back locked', unlockUi.mode);
check(unlockUi.passAuto === 'current-password', 'unlocking tags it autocomplete=current-password', unlockUi.passAuto);
check(unlockUi.nameVal === 'Gen Tester', 'the username field carries the account name', unlockUi.nameVal);
check(unlockUi.nameRO, 'and is read-only there, naming the account rather than choosing one');
check(unlockUi.genbox === 'none', 'no passphrase is generated on the unlock screen');
// The confirm field is a new-password input; if it shows on unlock the browser
// offers to GENERATE a passphrase next to a box asking to confirm one, mid-unlock.
check(unlockUi.confirm === 'none', 'no confirm-passphrase box on the unlock screen', unlockUi.confirm);
check(unlockUi.choose === 'none', 'no "choose my own" on the unlock screen', unlockUi.choose);

await page.fill('#id-pass', phrase);
await page.evaluate(() => document.getElementById('id-primary').click());
const opened = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 20000 })
	.then(() => true).catch(() => false);
check(opened, 'the generated passphrase unlocks it again');

// ── A trailing space, as a phone keyboard adds, still unlocks ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(400);
await page.fill('#id-pass', phrase + ' ');
await page.evaluate(() => document.getElementById('id-primary').click());
const padded = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 25000 })
	.then(() => true).catch(() => false);
check(padded, 'a trailing space does not lock the user out');

// ── A wrong passphrase is still refused ──
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(400);
await page.fill('#id-pass', 'not the passphrase at all');
await page.evaluate(() => document.getElementById('id-primary').click());
await page.waitForTimeout(3000);
const refused = await page.evaluate(() => ({
	shown: document.getElementById('identity-modal').style.display !== 'none',
	err:   document.getElementById('id-error').textContent,
}));
check(refused.shown && /did not match/.test(refused.err), 'a wrong passphrase is refused', refused.err);

const hardErrs = s.errs.filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
check(hardErrs.length === 0, 'no console errors', hardErrs.join(' | ') || 'none');

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
await s.close();
process.exit(failures ? 1 : 0);
