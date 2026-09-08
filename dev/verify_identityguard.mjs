// verify_identityguard.mjs — the boot identity gate must NEVER re-mint over a
// stored identity because a cold tab read its keys as empty.
//
// THE SEV-1: on a freshly opened iOS/WebKit tab, localStorage.getItem(K_PRIV/
// K_PUB) can return EMPTY before the storage area has loaded from disk. The old
// boot gate read `exists()` once, trusted the empty read, and offered "Create
// passphrase". Completing that create() minted a fresh random salt + keypair and
// ORPHANED every provider key the real identity had sealed — the composer then
// had no readable key and no input box (the recurring SEV-1). No new device row
// appeared, matching the owner's "still only 4 devices".
//
// THE FIX (two layers, primary first):
//   1. PRIMARY — the boot gate awaits `DaimondIdentity.existsSettled()`, which
//      re-reads the keypair across a few ticks and only concludes "no identity"
//      once the keys have had their chance to appear. A transient empty read no
//      longer falls through to create.
//   2. GUARD — even if the keys still will not read, a bare create is refused
//      when there is ORPHAN EVIDENCE this account already held an identity (a
//      durable `everExisted()` marker, or a sealed provider keyEnc). A RECOVER
//      screen is shown instead, and create()'s modal submit requires an explicit
//      "replace this device's identity" acknowledgement and then reconciles the
//      now-unreadable keys in daimond-models-v2.
//
// The properties, each invisible if wrong:
//   (a) GENUINE FIRST RUN (no identity) still offers Create and works end to end.
//   (b) COLD-READ-EMPTY, keypair actually present → after the retry the gate is
//       UNLOCK, never Create. This is the PRIMARY fix in isolation (no provider
//       connected, so no evidence and no guard — only the retry can save it).
//   (c) KEYS GONE + ORPHAN EVIDENCE → a RECOVER screen with a Try-again and a
//       Start-over action, NOT a bare Create.
//   (d) A normal present+valid identity unlocks normally (no regression).
//   (g) From RECOVER, Start-over → Create demands the replace acknowledgement and
//       reconciles the dead sealed key (it becomes keyless, not sealed-forever).
//
// Run with the fix present (the default): expects (a)-(g) to pass.
// Run with `--expect-create` against REVERTED code (the negative control): it
// signs in, cold-reads the keys empty on a reload, and asserts the gate wrongly
// offers CREATE — proving the fix is load-bearing.
//
//   DAIMOND_BROWSER=webkit DAIMOND_PORT=… DAIMOND_MOCK_PORT=… \
//     node dev/verify_identityguard.mjs
//
// WebKit (Playwright's JavaScriptCore) is the iOS Safari engine the owner runs,
// so the gate is proved on the engine that lost the identity.

import { open, connectMock, PASS, scratch, errors } from './harness.mjs';
import fs from 'node:fs';

const NEG = process.argv.includes('--expect-create');
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// A document-start shim that reproduces the cold iOS tab: the identity keypair
/// reads EMPTY for a window that OPENS ON THE FIRST READ of the private key and
/// stays open for `ms`, then passes through. Arming on the first read — not on
/// page load — is what makes the window still be open when the boot gate reads,
/// which is long after the wasm has loaded; a fixed-from-load window closes before
/// boot ever looks, so the bug never shows. It overrides `Storage.prototype.
/// getItem` before accounts.js captures it, so the namespaced reads the whole app
/// makes flow through it. Optionally also blanks the orphan-evidence marker, for a
/// faithful WHOLE-store cold read where the guard's inputs are empty too.
///
/// `window.__COLD` records how it behaved (armed, and how many empties it served),
/// so a test can PROVE the boot read was actually served empty rather than passing
/// because the window had already closed.
function coldShim(ms, alsoEvidence) {
	const keys = ['daimond-id-priv', 'daimond-id-pub'];
	if (alsoEvidence) keys.push('daimond-id-ever');
	return `(function(){
		var proto = window.Storage.prototype;
		var realGet = proto.getItem;
		var ARM_KEY = 'daimond-id-priv';   // the boot gate reads this first
		var COLD_MS = ${ms};
		var TARGETS = ${JSON.stringify(keys)};
		var t0 = 0;
		window.__COLD = { armed: false, empties: 0, armAt: 0 };
		proto.getItem = function(k){
			if (TARGETS.indexOf(k) >= 0) {
				if (!t0 && k === ARM_KEY) { t0 = Date.now(); window.__COLD.armed = true; window.__COLD.armAt = t0; }
				if (t0 && (Date.now() - t0) < COLD_MS) { window.__COLD.empties++; return null; }
			}
			return realGet.call(this, k);
		};
	})();`;
}

/// How the cold shim behaved this page: was it armed, and did it serve empties?
function coldReport(page) {
	return page.evaluate(() => window.__COLD || { armed: false, empties: 0 }).catch(() => ({ armed: false, empties: 0 }));
}

/// What the boot gate settled on. Waits for the modal (both unlock and create end
/// there) or, for a genuine unlock, its disappearance.
async function gateState(page) {
	// The gate has decided once the modal is visible with a mode set. Every case
	// here ends on the modal (create / unlock / recover), so this is the settle
	// point — NOT `__DAIMOND_READY`, which can flip true a beat before the modal
	// is drawn and read back a mode of "".
	await page.waitForFunction(() => {
		const m = document.getElementById('identity-modal');
		return !!(m && getComputedStyle(m).display !== 'none' && m.dataset.mode);
	}, { timeout: 15000 }).catch(() => {});
	return page.evaluate(() => {
		const m = document.getElementById('identity-modal');
		const vis = e => !!e && getComputedStyle(e).display !== 'none';
		return {
			shown:    vis(m),
			mode:     m ? (m.dataset.mode || '') : '',
			recover:  !!document.getElementById('id-recover'),
			again:    !!document.getElementById('id-recover-again'),
			over:     !!document.getElementById('id-recover-over'),
			title:    (document.getElementById('id-title') || {}).textContent || '',
			primary:  (document.getElementById('id-primary') || {}).textContent || '',
		};
	});
}

/// Unlock with the passphrase through the real form, and say whether it took.
async function unlockWith(page, pass) {
	await page.fill('#id-pass', pass);
	await page.evaluate(() => document.getElementById('id-primary').click());
	const hidden = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 12000 })
		.then(() => true).catch(() => false);
	await page.waitForTimeout(300);
	return hidden;
}

const run = async () => {
	// ── The NEGATIVE CONTROL, run against reverted code ──────────────────
	if (NEG) {
		const profile = scratch('pw', 'idguard-neg');
		fs.rmSync(profile, { recursive: true, force: true });
		const s = await open({ browser: 'webkit', name: 'idneg', profile, connect: false });
		// No provider and no marker: a WHOLE-store cold read, so nothing but the
		// (reverted-away) retry could save it.
		await s.page.evaluate(() => { try { localStorage.removeItem('daimond-id-ever'); } catch (e) {} });
		// Identity now exists in storage. Reload with the keys reading cold-empty.
		await s.page.addInitScript(coldShim(260, true));
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		const st = await gateState(s.page);
		const cold = await coldReport(s.page);
		check('NEG the boot gate really got a cold (empty) key read',
			cold.armed && cold.empties > 0, `armed=${cold.armed} empties=${cold.empties}`);
		// Reverted boot trusts the single empty read → wrongly offers CREATE.
		check('NEG cold read on reverted code wrongly offers Create',
			st.shown && st.mode === 'create',
			`mode="${st.mode}" recover=${st.recover}`);
		await s.close();
		console.log(`\n${ok.length} ok, ${bad.length} FAIL`);
		if (bad.length) { console.error('FAILED: ' + bad.join(', ')); process.exit(1); }
		return;
	}

	// ── (a) genuine first run still offers Create and works end to end ────
	{
		const profile = scratch('pw', 'idguard-first');
		fs.rmSync(profile, { recursive: true, force: true });
		// signIn:false — reach the gate with NO identity and drive create by hand.
		const s = await open({ browser: 'webkit', name: 'idfirst', profile, signIn: false, connect: false });
		const st = await gateState(s.page);
		check('a1 genuine first run offers Create (no identity, no evidence)',
			st.shown && st.mode === 'create' && !st.recover,
			`mode="${st.mode}" recover=${st.recover}`);
		// Complete the create the way signInAs does, and confirm it takes.
		await s.page.waitForSelector('#id-primary', { timeout: 10000 });
		const nameBox = await s.page.$('#id-name');
		if (nameBox && await nameBox.isEditable()) await nameBox.fill('idfirst');
		await s.page.fill('#id-pass', PASS);
		const confirm = await s.page.$('#id-pass2');
		if (confirm && await confirm.isVisible()) await confirm.fill(PASS);
		const wrote = await s.page.$('#id-wrote');
		if (wrote && await wrote.isVisible() && !(await wrote.isChecked())) await wrote.check({ force: true });
		await s.page.evaluate(() => document.getElementById('id-primary').click());
		const took = await s.page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 12000 })
			.then(() => true).catch(() => false);
		check('a2 genuine first run: create completes and the app opens', took, `took=${took}`);
		// And no spurious replace acknowledgement stood in the way.
		const hadDlg = await s.page.$('.dlg-card').then(e => !!e).catch(() => false);
		check('a3 genuine first run: no replace acknowledgement (nothing to orphan)', !hadDlg, `dlg=${hadDlg}`);
		await s.close();
	}

	// ── (b) COLD-READ-EMPTY, keys present → UNLOCK, never Create ──────────
	//    No provider connected: no evidence, so the guard cannot help. Only the
	//    existsSettled retry can turn this from Create into Unlock — the PRIMARY
	//    fix, in isolation.
	{
		const profile = scratch('pw', 'idguard-cold');
		fs.rmSync(profile, { recursive: true, force: true });
		const s = await open({ browser: 'webkit', name: 'idcold', profile, connect: false });
		// Prove there is genuinely no readable provider key (no evidence route).
		const noEvidence = await s.page.evaluate(() => {
			try {
				const raw = localStorage.getItem('daimond-models-v2');
				if (!raw) return true;
				const ps = (JSON.parse(raw).providers) || {};
				return !Object.keys(ps).some(id => ps[id] && ps[id].keyEnc);
			} catch (e) { return true; }
		});
		// Blank the durable marker too, so ONLY the retry — not the guard — is in play.
		await s.page.evaluate(() => { try { localStorage.removeItem('daimond-id-ever'); } catch (e) {} });
		await s.page.addInitScript(coldShim(260, true));   // keys AND marker read cold
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		const st = await gateState(s.page);
		const cold = await coldReport(s.page);
		// The shim must have actually served the boot gate an empty read; otherwise
		// this passes for the wrong reason (the keys were readable all along).
		check('b0 the boot gate really got a cold (empty) key read',
			cold.armed && cold.empties > 0, `armed=${cold.armed} empties=${cold.empties}`);
		check('b1 cold read + keys present → UNLOCK, not Create (retry alone)',
			st.shown && st.mode === 'unlock' && !st.recover,
			`mode="${st.mode}" recover=${st.recover} noEvidence=${noEvidence}`);
		// And it is a REAL unlock screen: the passphrase actually opens it.
		const opened = await unlockWith(s.page, PASS);
		check('b2 cold read: the recovered unlock screen actually unlocks', opened, `opened=${opened}`);
		const errs = errors(s).filter(e => !/Failed to load resource/i.test(e));
		check('b3 cold read: no page/console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
		await s.close();
	}

	// ── (c) keys GONE + orphan evidence → RECOVER, not Create ────────────
	let recoverProfile;
	{
		const profile = recoverProfile = scratch('pw', 'idguard-recover');
		fs.rmSync(profile, { recursive: true, force: true });
		const s = await open({ browser: 'webkit', name: 'idrec', profile, connect: false });
		// Seal a provider key under this identity, so models-v2 carries a keyEnc.
		await connectMock(s);
		const sealed = await s.page.evaluate(() => {
			try {
				const ps = (JSON.parse(localStorage.getItem('daimond-models-v2')).providers) || {};
				return Object.keys(ps).some(id => ps[id] && ps[id].keyEnc);
			} catch (e) { return false; }
		});
		// Now the keys are truly GONE — delete them — while the sealed key and the
		// durable marker remain. This is the orphan state, at its starkest.
		await s.page.evaluate(() => {
			localStorage.removeItem('daimond-id-priv');
			localStorage.removeItem('daimond-id-pub');
		});
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		const st = await gateState(s.page);
		check('c1 keys gone + evidence → RECOVER screen, not Create',
			st.shown && st.mode !== 'create' && st.recover,
			`mode="${st.mode}" recover=${st.recover} sealed=${sealed}`);
		check('c2 recover offers Try-again and Start-over (a locked-retry state)',
			st.again && st.over, `again=${st.again} over=${st.over}`);
		// It must NOT read as the welcome-back unlock; the recover copy is shown.
		check('c3 recover screen is titled as recovery, not a bare unlock',
			/locked|account/i.test(st.title), `title="${st.title}"`);
		await s.close();
	}

	// ── (g) Start-over demands the replace acknowledgement and reconciles ──
	{
		// signIn:false — the keys are gone, so the harness sign-in would try to
		// unlock deleted keys and fail; we only want to observe the recover screen.
		const s = await open({ browser: 'webkit', name: 'idrec', profile: recoverProfile, signIn: false, connect: false });
		// Boot lands on RECOVER again (keys still gone, evidence still present).
		const st = await gateState(s.page);
		check('g1 recover persists across reload (idempotent)',
			st.recover && st.mode !== 'create', `mode="${st.mode}" recover=${st.recover}`);
		// Press Start-over → the create screen.
		await s.page.evaluate(() => document.getElementById('id-recover-over').click());
		await s.page.waitForTimeout(300);
		const create = await s.page.evaluate(() => document.getElementById('identity-modal').dataset.mode);
		check('g2 Start-over moves to the create screen', create === 'create', `mode="${create}"`);
		// Fill and submit — the replace acknowledgement must intercept.
		await s.page.fill('#id-name', 'idrec');
		await s.page.fill('#id-pass', PASS);
		const c2 = await s.page.$('#id-pass2');
		if (c2 && await c2.isVisible()) await c2.fill(PASS);
		const wrote = await s.page.$('#id-wrote');
		if (wrote && await wrote.isVisible() && !(await wrote.isChecked())) await wrote.check({ force: true });
		await s.page.evaluate(() => document.getElementById('id-primary').click());
		await s.page.waitForTimeout(400);
		const ackShown = await s.page.evaluate(() => {
			const c = document.querySelector('.dlg-card');
			return c ? (c.textContent || '') : '';
		});
		check('g3 create over an orphan demands a replace acknowledgement',
			/replace/i.test(ackShown), `dlg="${ackShown.slice(0, 60)}"`);
		// Confirm the replace, and the identity is remade and the dead key reconciled.
		await s.page.evaluate(() => {
			const b = document.querySelector('.dlg-card .dlg-ok');
			if (b) b.click();
		});
		const took = await s.page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 12000 })
			.then(() => true).catch(() => false);
		check('g4 after acknowledgement the new identity is created', took, `took=${took}`);
		// The orphaned keyEnc is gone: the provider now reads keyless, not sealed-forever.
		await s.page.waitForTimeout(400);
		const reconciled = await s.page.evaluate(() => {
			try {
				const ps = (JSON.parse(localStorage.getItem('daimond-models-v2')).providers) || {};
				const anySealed = Object.keys(ps).some(id => ps[id] && ps[id].keyEnc);
				return !anySealed;
			} catch (e) { return false; }
		});
		check('g5 the now-unreadable sealed key is cleared (reconciled)', reconciled, `noSealedLeft=${reconciled}`);
		await s.close();
	}

	// ── (d) a normal present+valid identity unlocks, no regression ───────
	{
		const profile = scratch('pw', 'idguard-normal');
		fs.rmSync(profile, { recursive: true, force: true });
		const s = await open({ browser: 'webkit', name: 'idnorm', profile, connect: false });
		await s.page.reload({ waitUntil: 'domcontentloaded' });
		const st = await gateState(s.page);
		check('d1 normal identity boots to a plain UNLOCK (no recover, no create)',
			st.shown && st.mode === 'unlock' && !st.recover,
			`mode="${st.mode}" recover=${st.recover}`);
		const opened = await unlockWith(s.page, PASS);
		check('d2 normal identity unlocks and the app opens', opened, `opened=${opened}`);
		const errs = errors(s).filter(e => !/Failed to load resource/i.test(e));
		check('d3 normal unlock: no page/console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
		await s.close();
	}

	console.log(`\n${ok.length} ok, ${bad.length} FAIL`);
	if (bad.length) { console.error('FAILED: ' + bad.join(', ')); process.exit(1); }
};

run().catch(e => { console.error(e); process.exit(2); });
