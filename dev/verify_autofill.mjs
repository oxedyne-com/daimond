// verify_autofill.mjs — the passphrase box and a password manager's fill.
//
// The gate is a real login form (see verify_genpass.mjs), so a browser or OS
// keychain may fill the passphrase on page load. A fill is not typing: it
// replaces the whole value at once and fires one `input` event, and it lands
// whenever the manager gets round to it — which on a cold load is BEFORE the
// gate is drawn, because the gate waits on the wasm engine. This asserts the
// box survives that, and that a redraw still clears it.
//
//   node dev/verify_autofill.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway and no model: this is
// the gate only.

import { open, PASS, APP } from './harness.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const s = await open({ name: 'autofill-' + Date.now(), connect: false });
const { page } = s;

/// Back to the lock screen, and wait for it.
async function relock() {
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForSelector('#id-primary', { timeout: 20000 });
	await page.waitForFunction(() =>
		document.getElementById('identity-modal').dataset.mode === 'unlock', null, { timeout: 20000 });
	await page.waitForTimeout(200);
}

/// Press Unlock and say whether the gate went away.
async function submit() {
	await page.evaluate(() => document.getElementById('id-primary').click());
	return page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 25000 })
		.then(() => true).catch(() => false);
}

// ── The field a manager is handed ──────────────────────────
await relock();
const shape = await page.evaluate(() => {
	const p = document.getElementById('id-pass');
	return {
		type:     p.type,
		auto:     p.getAttribute('autocomplete'),
		masked:   !!p._secretMasked,
		hasReal:  p._real != null,
		optedOut: p.hasAttribute('data-1p-ignore') || p.hasAttribute('data-lpignore'),
	};
});
check(shape.type === 'password', 'the passphrase box is a real password input', shape.type);
check(!shape.masked && !shape.hasReal,
	'it is NOT the JS bullet mask: its value is its value', 'masked=' + shape.masked + ' _real=' + shape.hasReal);
check(!shape.optedOut, 'no manager opt-out is set on it');
check(shape.auto === 'current-password', 'unlocking tags it current-password', shape.auto);

// The token a manager reads is in the served markup, so it is right from the
// moment the form is parsed — the JS in showIdentity only re-states it.
const markup = await (await fetch(`${APP}/index.html`)).text();
const tag = (markup.match(/<input[^>]*id="id-pass"[^>]*>/) || [''])[0];
check(/type="password"/.test(tag) && /autocomplete="current-password"/.test(tag),
	'and the served HTML carries both before any script runs', tag.slice(0, 90) + '…');

// ── A whole-value fill, drawn gate ─────────────────────────
const filled = await page.evaluate((pass) => {
	const p = document.getElementById('id-pass');
	p.value = pass;
	p.dispatchEvent(new Event('input', { bubbles: true }));
	return { value: p.value, real: p._real };
}, PASS);
check(filled.value === PASS, 'a whole-value fill is held verbatim', JSON.stringify(filled.value));
check(filled.real === undefined, 'and no shadow copy is invented for it', String(filled.real));
check(await submit(), 'the filled passphrase unlocks');

// ── The event sequence Chrome actually emits ───────────────
await relock();
await page.evaluate((pass) => {
	const p = document.getElementById('id-pass');
	p.focus();
	p.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertReplacementText', data: pass }));
	p.value = pass;
	p.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: pass }));
	p.dispatchEvent(new Event('change', { bubbles: true }));
}, PASS);
const afterEvents = await page.evaluate(() => document.getElementById('id-pass').value);
check(afterEvents === PASS, 'a beforeinput/input/change fill is held verbatim too', JSON.stringify(afterEvents));
check(await submit(), 'and unlocks');

// ── A fill that lands BEFORE the gate is drawn ─────────────
//
// The real case. The form is in the served HTML, so a manager can fill it as
// soon as the document parses; the gate is drawn later, after the wasm engine
// has loaded. On a hard refresh that engine is refetched, so the gap is wide.
await page.addInitScript((pass) => {
	window.__gateAt = null;
	window.__fillAt = null;
	const m = new MutationObserver(() => {
		const el = document.getElementById('identity-modal');
		if (el && el.dataset.mode && window.__gateAt == null) window.__gateAt = performance.now();
	});
	document.addEventListener('DOMContentLoaded', () => {
		// Iframes (the Web panel, the terminal) run this script too, and have no gate.
		const el = document.getElementById('identity-modal');
		if (el) m.observe(el, { attributes: true });
	});
	const t = setInterval(() => {
		const p = document.getElementById('id-pass');
		if (!p) return;
		clearInterval(t);
		p.value = pass;
		p.dispatchEvent(new Event('input', { bubbles: true }));
		window.__fillAt = performance.now();
	}, 4);
}, PASS);
await relock();
const race = await page.evaluate(() => ({
	value:  document.getElementById('id-pass').value,
	fillAt: window.__fillAt,
	gateAt: window.__gateAt,
}));
check(race.fillAt != null && race.gateAt != null && race.fillAt < race.gateAt,
	'the fill lands before the gate is drawn, as on a cold load',
	'fill ' + Math.round(race.fillAt) + 'ms, gate ' + Math.round(race.gateAt) + 'ms');
check(race.value === PASS, 'and the gate does not wipe it', JSON.stringify(race.value));
check(await submit(), 'so the app opens without the passphrase being retyped');

// ── A REDRAW still clears the box ──────────────────────────
//
// What the clear is for: logging out, or switching account, must never leave
// the last passphrase sitting in the field for the next person at the browser.
await sleep(1200);
await page.evaluate(() => { document.getElementById('id-pass').value = 'left over from before'; });
const loggedOut = await page.evaluate(() => {
	if (window.DaimondPanels && DaimondPanels.activate) DaimondPanels.activate('home');
	const it = Array.from(document.querySelectorAll('.admin-item'))
		.find(b => (b.textContent || '').trim() === 'Log out');
	if (!it) return false;
	it.click();
	return true;
});
check(loggedOut, 'the Log out control is there and clicks');
await page.waitForFunction(() =>
	document.getElementById('identity-modal').style.display !== 'none', null, { timeout: 15000 });
await page.waitForTimeout(300);
const afterLogout = await page.evaluate(() => document.getElementById('id-pass').value);
check(afterLogout === '', 'a redraw of the gate clears whatever was in the box', JSON.stringify(afterLogout));

const hardErrs = s.errs.filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
check(hardErrs.length === 0, 'no console errors', hardErrs.join(' | ') || 'none');

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
await s.close();
process.exit(failures ? 1 : 0);
