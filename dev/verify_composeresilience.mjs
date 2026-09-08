// verify_composeresilience.mjs — a new chat must NEVER be a dead-end.
//
// SEV-1 (recurred on the owner's iPhone): after a refresh a new chat showed NO
// text input box and no recourse. A pending chat hides the composer and offers a
// "▶ Start" control; `startChat` gated on `DaimondModels.resolve()` and, on null,
// SILENTLY `openSettings()`-ed and returned — so with unreadable provider keys
// (a wrong-salt/duplicate identity, or a locked store) the box never appeared and
// there was no way forward from the chat.
//
// The fix (client-only, www/js/daimond.js + i18n): when a pending chat cannot
// start because its keys will not read, `renderPendingCentre` REVEALS the
// composer and draws an inline message with a direct action, instead of a Start
// button that bounces. The good-key path is unchanged: Start hidden until pressed,
// then the box appears and the chat runs.
//
// The properties, each of which would be invisible if it were wrong:
//
//   1. GOOD KEY, PENDING: Start is shown and the composer is hidden — today's
//      behaviour, unchanged.
//   2. GOOD KEY, START WORKS: pressing Start activates the chat and the box
//      appears. The path the owner uses every day still works.
//   3. UNREADABLE KEY, THE BOX IS BACK: a new pending chat with keys that will not
//      read shows the composer — the whole point of the fix.
//   4. UNREADABLE KEY, INLINE RECOURSE: the centre says the device can't read the
//      keys and offers an action (not a Start button that would bounce), and the
//      action opens the key-entry form.
//   5. AFTER A REFRESH, WITH A GENUINE MISMATCHED-SALT IDENTITY: seal a provider
//      key under identity A, re-mint the identity (fresh salt B) leaving the key
//      orphaned, reload, unlock, open a NEW chat — the box shows and the inline
//      recourse renders. This is the actual SEV-1 condition, reproduced, across a
//      reload.
//
//   eval "$(bash dev/world.sh 0 --up)"   # or set DAIMOND_PORT / DAIMOND_MOCK_PORT
//   DAIMOND_BROWSER=webkit node dev/verify_composeresilience.mjs
//
// WebKit (Playwright's JavaScriptCore build) is the iOS Safari engine the owner
// runs, so the box is proved on the engine that lost it.

import { open, newChat, PASS } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// Open a fresh PENDING chat without starting it: click the + and stop. `newChat`
/// presses Start, which is exactly what a pending state must be observed before.
async function newPending(page) {
	const drawerClose = page.locator('#admin-close');
	if (await drawerClose.isVisible().catch(() => false)) {
		await drawerClose.click({ force: true });
		await page.waitForTimeout(150);
	}
	await page.click('#new-session-btn', { force: true });
	await page.waitForTimeout(400);
}

/// What the centre placeholder and the composer are showing right now.
function centreState(page) {
	return page.evaluate(() => {
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		const bar   = document.querySelector('.chat-input-bar');
		const input = document.getElementById('chat-input');
		const btn   = document.querySelector('.pending-centre .empty-new-session');
		const para  = document.querySelector('.pending-centre p');
		return {
			boxShown:  vis(bar) && vis(input),
			pending:   !!document.querySelector('.pending-centre'),
			btnText:   btn ? (btn.textContent || '').trim() : '',
			message:   para ? (para.textContent || '').trim() : '',
		};
	});
}

const run = async () => {
	// ── 1 & 2: the good-key path is untouched ────────────────────────────
	const s = await open({ browser: 'webkit', name: 'resilience' });   // signs in + connects the mock

	await newPending(s.page);
	let st = await centreState(s.page);
	check('1 good key: Start shown, composer hidden',
		st.pending && /Start/i.test(st.btnText) && !st.boxShown,
		`btn="${st.btnText}" box=${st.boxShown}`);

	// Press Start and confirm the chat runs and the box appears.
	await s.page.click('.pending-centre .empty-new-session', { force: true });
	await s.page.waitForSelector('#chat-input', { state: 'visible', timeout: 8000 }).catch(() => {});
	const started = await s.page.evaluate(() => {
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		return { box: vis(document.getElementById('chat-input')),
			pending: !!document.querySelector('.pending-centre') };
	});
	check('2 good key: Start activates the chat and the box appears',
		started.box && !started.pending,
		`box=${started.box} stillPending=${started.pending}`);

	// ── 3 & 4: keys present but unreadable → the box is back, with recourse ──
	// Forget the readable keys (the store keeps its sealed keyEnc, so the provider
	// reads as present-but-sealed — `resolve` goes null, exactly the dead-end).
	await s.page.evaluate(() => window.DaimondModels.lock());
	await newPending(s.page);
	st = await centreState(s.page);
	check('3 unreadable key: the composer is shown on a new pending chat',
		st.boxShown, `box=${st.boxShown} pending=${st.pending}`);
	check('4 unreadable key: inline recourse, not a Start button',
		st.pending && !!st.message && !/^▶/.test(st.btnText) && !/Start/i.test(st.btnText) && !!st.btnText,
		`msg="${st.message.slice(0, 60)}" btn="${st.btnText}"`);
	// The action opens the key-entry / settings form.
	await s.page.click('.pending-centre .empty-new-session', { force: true });
	await s.page.waitForTimeout(400);
	const opened = await s.page.evaluate(() => {
		const vis = e => !!e && !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
		// `openSettings` expands the add-a-provider / key-entry form.
		return vis(document.getElementById('byok-form')) || vis(document.getElementById('cfg-api-key'));
	});
	check('4b the action opens the key-entry / settings form', !!opened, `opened=${opened}`);
	await s.close();

	// ── 5: a genuine mismatched-salt identity, across a REFRESH ────────────
	// Seal a key under identity A, re-mint (fresh salt B) leaving the key orphaned,
	// reload, unlock under B, open a new chat. This is the SEV-1 as it happens.
	const profile = '/tmp/claude-1000/-home-jason-usr/acd49ac1-d25e-472b-b2d0-48eaaea0c5dc/scratchpad/pw-resilience-remint';
	const fs = await import('node:fs');
	fs.rmSync(profile, { recursive: true, force: true });
	const s2 = await open({ browser: 'webkit', name: 'remint', profile });   // A: key sealed under A

	// Sanity: the good key resolves before the re-mint.
	const before = await s2.page.evaluate(() => !!window.DaimondModels.resolve('', ''));
	// Re-mint the device identity with the SAME passphrase — a fresh random salt,
	// the provider keyEnc left sealed under the old one. Exactly a duplicate iOS
	// identity: unlock will still succeed, but the saved key no longer unwraps.
	await s2.page.evaluate(async (pass) => {
		await window.DaimondIdentity.create('remint', pass);   // overwrites salt/keypair
	}, PASS);
	await s2.page.reload({ waitUntil: 'domcontentloaded' });
	// Unlock under the NEW identity B (same passphrase).
	await s2.page.waitForSelector('#id-primary', { timeout: 10000 });
	await s2.page.fill('#id-pass', PASS);
	await s2.page.evaluate(() => document.getElementById('id-primary').click());
	await s2.page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 10000 }).catch(() => {});
	await s2.page.waitForTimeout(600);

	const afterRemint = await s2.page.evaluate(() => ({
		resolves: !!window.DaimondModels.resolve('', ''),
		anySealed: window.DaimondModels.providers().some(p => p.hasKey && p.sealed),
	}));
	check('5a re-mint orphans the saved key (resolve null, provider sealed)',
		before && !afterRemint.resolves && afterRemint.anySealed,
		`before=${before} after=${afterRemint.resolves} sealed=${afterRemint.anySealed}`);

	await newPending(s2.page);
	st = await centreState(s2.page);
	check('5b after refresh with a mismatched-salt identity: the box shows',
		st.boxShown, `box=${st.boxShown}`);
	check('5c after refresh: the inline key-error renders',
		st.pending && !!st.message && !/Start/i.test(st.btnText),
		`msg="${st.message.slice(0, 60)}" btn="${st.btnText}"`);

	const errs = (s2.errs || []).filter(e => !/Failed to load resource/i.test(e));
	check('5d no page/console errors on the resilience path', errs.length === 0,
		errs.slice(0, 3).join(' | '));
	await s2.close();

	console.log(`\n${ok.length} ok, ${bad.length} FAIL`);
	if (bad.length) { console.error('FAILED: ' + bad.join(', ')); process.exit(1); }
};

run().catch(e => { console.error(e); process.exit(2); });
