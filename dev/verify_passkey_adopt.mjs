// verify_passkey_adopt.mjs — a passkey brings the whole account to a device
// that holds nothing.
//
// This is the capability a passkey did NOT have before. The credential syncs
// through iCloud Keychain or Google Password Manager, but the sealed copy of the
// identity lived in one browser's localStorage, so every new device still needed
// a pairing code typed from a device that was already open. The sealed bundle
// now lives on the gateway too, keyed by a hash of the credential id, so:
//
//   one discoverable assertion  →  credential id + its PRF secret
//   →  fetch the sealed bundle  →  open it  →  import the identity  →  unlocked
//
// with nothing typed and no pairing code.
//
//   node dev/verify_passkey_adopt.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) AND the gateway on :9002 — the whole
// point is that the bundle round-trips through the gateway.
//
// HARNESS LIMIT: a virtual authenticator's hmac-secret cannot be exported, so a
// genuinely second browser cannot be given the same PRF secret. The "new device"
// here is therefore the same authenticator with the browser's stored state
// wiped — which exercises every step above except the credential sync itself,
// the one part the platform does rather than us.

import { open, errors, PASS } from './harness.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const s = await open({ name: 'adopt-' + Date.now(), connect: false });
const { page } = s;

// ── A virtual platform authenticator with PRF ──
const cdp = await s.browser.newCDPSession(page);
await cdp.send('WebAuthn.enable');
let authId = null;
for (const extra of [{ ctap2Version: 'ctap2_1', hasPrf: true }, { hasPrf: true }, {}]) {
	try {
		const r = await cdp.send('WebAuthn.addVirtualAuthenticator', {
			options: Object.assign({
				protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
				hasUserVerification: true, isUserVerified: true,
				automaticPresenceSimulation: true,
			}, extra),
		});
		authId = r.authenticatorId;
		break;
	} catch (e) { /* try the next option shape */ }
}
if (!authId) { console.log('FAIL could not create a virtual authenticator'); await s.close(); process.exit(1); }

// ── The account must have a gateway session, or the bundle cannot be stored ──
await page.waitForFunction(() => window.DaimondGateway
	&& DaimondGateway.state().authed === true, { timeout: 20000 })
	.catch(() => {});
const authed = await page.evaluate(() => !!(window.DaimondGateway && DaimondGateway.state().authed));
check(authed, 'the signed-in account has a gateway session to store against');
if (!authed) {
	console.log('  (is the gateway running on :9002? this test needs it)');
	await s.close();
	process.exit(1);
}

const before = await page.evaluate(() => ({
	fp:   DaimondIdentity.fingerprint(),
	name: DaimondIdentity.displayName(),
}));

// ── Enrol a passkey; the sealed bundle should reach the gateway ──
const enrolled = await page.evaluate(async (pass) => {
	const r = await window.DaimondPasskey.enrol(pass).catch(e => ({ ok: false, error: String(e) }));
	return r;
}, PASS);
check(enrolled && enrolled.ok, 'a passkey enrols', enrolled && enrolled.error);
if (!enrolled || !enrolled.ok) {
	console.log('  (the virtual authenticator did not surface PRF; nothing further can be exercised)');
	await s.close();
	process.exit(1);
}
check(enrolled.synced === true, 'and its sealed bundle reaches the gateway');

// It really is on the gateway: ask for it the way a bare device would, with no
// session and no identity — just the handle.
const rec = await page.evaluate(() => JSON.parse(localStorage.getItem('daimond-passkey')));
check(rec && rec.v === 2 && !rec.salt, 'the local record is v2 and carries no salt');

const served = await page.evaluate(async () => {
	// Recompute the handle exactly as passkey.js does, then fetch it cold.
	const r  = JSON.parse(localStorage.getItem('daimond-passkey'));
	const id = Uint8Array.from(atob(r.cred.replace(/-/g, '+').replace(/_/g, '/')
		+ '==='.slice((r.cred.length + 3) % 4)), c => c.charCodeAt(0));
	const lab = new TextEncoder().encode('daimond-passkey-handle-v1');
	const buf = new Uint8Array(lab.length + id.length);
	buf.set(lab, 0); buf.set(id, lab.length);
	const h = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	const res = await fetch('/api/passkey-blob?h=' + encodeURIComponent(h));
	const j = await res.json().catch(() => null);
	return { status: res.status, hasBlob: !!(j && j.blob), sameBlob: !!(j && j.blob === r.blob) };
});
check(served.status === 200 && served.hasBlob, 'the gateway serves it back without a session', 'HTTP ' + served.status);
check(served.sameBlob, 'and it is byte-for-byte the blob that was sealed');

// A handle nobody has stored is a plain 404, not a hint.
const missing = await page.evaluate(async () => {
	const h = 'A'.repeat(43);
	const res = await fetch('/api/passkey-blob?h=' + h);
	return res.status;
});
check(missing === 404, 'an unknown handle is a flat 404', 'HTTP ' + missing);
const malformed = await page.evaluate(async () =>
	(await fetch('/api/passkey-blob?h=nonsense')).status);
check(malformed === 400, 'a malformed handle is refused before any lookup', 'HTTP ' + malformed);

// ── Now become a device that holds nothing ──
// Everything this browser knows about the account goes, keeping only the
// authenticator — which is what a new phone with a synced passkey actually has.
await page.evaluate(async () => {
	localStorage.clear();
	try {
		const root = await navigator.storage.getDirectory();
		for await (const ent of root.entries()) {
			await root.removeEntry(ent[0], { recursive: true }).catch(() => {});
		}
	} catch (e) { /* OPFS may be unavailable */ }
});
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#id-primary', { timeout: 15000 });
await page.waitForTimeout(600);

const fresh = await page.evaluate(() => ({
	mode:     document.getElementById('identity-modal').dataset.mode,
	exists:   DaimondIdentity.exists(),
	enrolled: window.DaimondPasskey.isEnrolled(),
	btnText:  (document.querySelector('#id-passkey span') || {}).textContent,
	btnShown: getComputedStyle(document.getElementById('id-passkey')).display !== 'none',
}));
check(fresh.mode === 'create', 'the wiped browser comes up as a new device', fresh.mode);
check(!fresh.exists && !fresh.enrolled, 'with no identity and no local passkey record');
check(fresh.btnShown, 'and it OFFERS the passkey as a way in');
check(/I have a passkey/.test(fresh.btnText || ''), 'worded as bringing an account across', fresh.btnText);

// ── The one gesture ──
await page.click('#id-passkey');
const adopted = await page.waitForSelector('#identity-modal', { state: 'hidden', timeout: 20000 })
	.then(() => true).catch(() => false);
check(adopted, 'the passkey alone brings the account to this device');

const after = await page.evaluate(() => ({
	fp:       DaimondIdentity.fingerprint(),
	name:     DaimondIdentity.displayName(),
	unlocked: DaimondIdentity.isUnlocked(),
	locked:   document.body.classList.contains('locked'),
	rec:      JSON.parse(localStorage.getItem('daimond-passkey') || 'null'),
}));
check(after.unlocked, 'the identity is unlocked, with nothing typed');
check(!after.locked, 'and the app is open');
check(after.fp === before.fp, 'it is the SAME identity, not a new one', after.fp + ' vs ' + before.fp);
check(after.name === before.name, 'carrying its name across', after.name);
check(after.rec && after.rec.v === 2, 'and the sealed blob is cached locally for next time');

// ── Removing it revokes the gateway copy too ──
await page.evaluate(async () => { await window.DaimondPasskey.remove(); });
await sleep(400);
const revoked = await page.evaluate(async () => {
	const lab = new TextEncoder().encode('daimond-passkey-handle-v1');
	return { local: localStorage.getItem('daimond-passkey') };
});
check(!revoked.local, 'remove() clears the local record');
const goneFromGateway = await page.evaluate(async (h) => {
	const res = await fetch('/api/passkey-blob?h=' + encodeURIComponent(h));
	return res.status;
}, await page.evaluate(async () => {
	// The handle is recomputed from the credential the authenticator still holds.
	const got = await navigator.credentials.get({ publicKey: {
		rpId: location.hostname,
		challenge: crypto.getRandomValues(new Uint8Array(32)),
		userVerification: 'required',
	}}).catch(() => null);
	if (!got) return 'A'.repeat(43);
	const id  = new Uint8Array(got.rawId);
	const lab = new TextEncoder().encode('daimond-passkey-handle-v1');
	const buf = new Uint8Array(lab.length + id.length);
	buf.set(lab, 0); buf.set(id, lab.length);
	return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))))
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}));
check(goneFromGateway === 404, 'and the gateway no longer serves the bundle', 'HTTP ' + goneFromGateway);

const errs = errors(s).filter(e => !/Failed to load resource/i.test(e));
check(errs.length === 0, 'no unexpected console errors', errs.join(' | ') || 'none');

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
await s.close();
process.exit(failures ? 1 : 0);
