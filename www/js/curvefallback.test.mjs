/* ============================================================
   Test — crypto-capability fallback for Daimond identity.
   ------------------------------------------------------------
   Drives the REAL www/js/identity.js in a simulated browser whose
   WebCrypto can be made to lack Ed25519 and X25519 on demand, so
   both halves of the fix are exercised end to end:

     (a) INTEROP: an account made on a full-WebCrypto engine unlocks
         on a crippled one via the pure-JS fallback, and the
         signature it makes there is bit-identical to WebCrypto's and
         verifies under real WebCrypto; an X25519 shared secret it
         computes equals the one a real-WebCrypto peer derives — so a
         message sealed by one opens on the other.

     (b) HONEST ERROR: with the fallback ALSO removed, unlocking with
         the RIGHT passphrase returns { ok:false, reason:'unsupported' }
         (not "wrong passphrase"), while a genuinely WRONG passphrase
         returns { ok:false } with NO 'unsupported' reason.

   Run:  node www/js/curvefallback.test.mjs
   (Node 20+, whose own WebCrypto implements Ed25519 and X25519 —
    that is the "real" engine the fallback is checked against.)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const real = webcrypto;
let failures = 0;
function check(name, cond) {
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name); failures++; }
}
const eqBytes = (a, b) => {
	const x = new Uint8Array(a), y = new Uint8Array(b);
	if (x.length !== y.length) return false;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
};

// A WebCrypto proxy whose Ed25519/X25519 support is toggled by `flags`.
// Everything else (PBKDF2, AES-GCM, exportKey, verify) passes straight through.
const flags = { noEd: false, noX: false };
function blocked(name) {
	return (name === 'Ed25519' && flags.noEd) || (name === 'X25519' && flags.noX);
}
const cryptoShim = {
	getRandomValues: (a) => real.getRandomValues(a),
	subtle: {
		generateKey: (algo, ex, u) => blocked(algo && algo.name)
			? Promise.reject(new Error('NotSupportedError')) : real.subtle.generateKey(algo, ex, u),
		importKey: (fmt, data, algo, ex, u) => blocked(algo && algo.name)
			? Promise.reject(new Error('NotSupportedError')) : real.subtle.importKey(fmt, data, algo, ex, u),
		deriveBits: (algo, key, len) => blocked(algo && algo.name)
			? Promise.reject(new Error('NotSupportedError')) : real.subtle.deriveBits(algo, key, len),
		sign: (algo, key, data) => blocked(algo && algo.name)
			? Promise.reject(new Error('NotSupportedError')) : real.subtle.sign(algo, key, data),
		deriveKey: (...a) => real.subtle.deriveKey(...a),
		encrypt:   (...a) => real.subtle.encrypt(...a),
		decrypt:   (...a) => real.subtle.decrypt(...a),
		exportKey: (...a) => real.subtle.exportKey(...a),
		verify:    (...a) => real.subtle.verify(...a),
	},
};

// Minimal browser sandbox: a Map-backed localStorage, event stubs, the
// encoders, base64, and the toggleable crypto. The three app scripts attach
// their globals onto `window`.
const store = new Map();
const localStorage = {
	getItem: (k) => (store.has(k) ? store.get(k) : null),
	setItem: (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
// The three app scripts are classic-script IIFEs that read the bare globals
// `window`, `crypto`, `localStorage`, `btoa`, `atob`, `TextEncoder`, `Event`.
// Run each in the MAIN realm (not a vm sandbox) so every built-in — Uint8Array,
// BigInt, Object.prototype — is the real one and the vendored bundle's own
// type checks pass; the named parameters supply the browser host objects, with
// `crypto` pointed at the toggleable shim.
const win = {};
win.dispatchEvent = () => true;
const btoa = (s) => Buffer.from(s, 'binary').toString('base64');
const atob = (s) => Buffer.from(s, 'base64').toString('binary');
function EventShim(t) { this.type = t; }
function loadScript(rel, extra) {
	let body = readFileSync(join(HERE, rel), 'utf8');
	if (extra) body += extra;
	const fn = new Function(
		'window', 'crypto', 'localStorage', 'btoa', 'atob',
		'TextEncoder', 'TextDecoder', 'Event', 'console', 'globalThis',
		body);
	fn(win, cryptoShim, localStorage, btoa, atob,
		TextEncoder, TextDecoder, EventShim, console, globalThis);
}
// The bundle's top-level `var DaimondNoble` is a wrapper-local here (a real
// browser turns it into a window property), so publish it explicitly.
loadScript('vendor/noble-curves.min.js', '\n;window.DaimondNoble = DaimondNoble;');
loadScript('curvefallback.js');
loadScript('identity.js');
const ID = win.DaimondIdentity;
const FB = win.DaimondCurveFallback;

async function main() {
	const PASS = 'correct horse battery staple frigate';

	// ── Phase A — interop, fallback forced ─────────────────────
	console.log('Phase A — pure-JS fallback interop');
	flags.noEd = false; flags.noX = false;			// full engine to create.
	check('fallback module loaded', !!FB && FB.available());
	check('WebCrypto Ed25519 present on this Node', await ID.signingAvailable());

	await ID.create('Tester', PASS);
	check('account created as Ed25519', localStorage.getItem('daimond-id-alg') === 'Ed25519');
	const pubRaw    = await ID.publicKeyRaw();
	const sealPub   = ID.sealingKeyRaw();
	check('sealing key present after create', !!sealPub && sealPub.length === 32);

	const MSG = new TextEncoder().encode('sign me across the two code paths');
	const sigWc = ID.sign ? await ID.sign(MSG) : null;		// via WebCrypto Ed25519.

	ID.lock();
	// Cripple the engine: no Ed25519, no X25519. Unlock must use the fallback.
	flags.noEd = true; flags.noX = true;
	const r = await ID.unlock(PASS);
	check('unlock succeeds on crippled engine via fallback', !!r && r.ok === true);
	check('isUnlocked() true after fallback unlock', ID.isUnlocked());

	const sigJs = await ID.sign(MSG);						// via pure-JS Ed25519.
	check('fallback signature is bit-identical to WebCrypto', sigJs === sigWc);

	// The fallback signature verifies under REAL WebCrypto.
	const wcPub = await real.subtle.importKey('raw', pubRaw, { name: 'Ed25519' }, false, ['verify']);
	const sigBytes = Uint8Array.from(Buffer.from(sigJs, 'base64'));
	check('real WebCrypto verifies the fallback signature',
		await real.subtle.verify({ name: 'Ed25519' }, wcPub, sigBytes, MSG));

	// X25519: a real-WebCrypto peer and the crippled Daimond derive the same secret.
	const peer = await real.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
	const peerPub = new Uint8Array(await real.subtle.exportKey('raw', peer.publicKey));
	const daimondSide = await ID.sharedSecret(peerPub);		// fallback X25519.
	const daimondPubWc = await real.subtle.importKey('raw', sealPub, { name: 'X25519' }, false, []);
	const peerSide = new Uint8Array(await real.subtle.deriveBits(
		{ name: 'X25519', public: daimondPubWc }, peer.privateKey, 256));
	check('sealed-by-one opens-by-other (X25519 shared secret matches)',
		eqBytes(daimondSide, peerSide));

	ID.lock();

	// ── Phase B — honest error, no fallback ────────────────────
	console.log('Phase B — honest unsupported-crypto error');
	// Remove the fallback entirely, keep the engine crippled for Ed25519.
	const savedNoble = win.DaimondNoble;
	win.DaimondNoble = undefined;							// FB.available() now false.
	check('fallback now reports unavailable', !FB.available());
	flags.noEd = true; flags.noX = true;

	const rRight = await ID.unlock(PASS);
	check('right passphrase, no fallback -> reason "unsupported"',
		!!rRight && rRight.ok === false && rRight.reason === 'unsupported');

	const rWrong = await ID.unlock(PASS + ' wrong');
	check('wrong passphrase -> ok:false with NO "unsupported" reason',
		!!rWrong && rWrong.ok === false && rWrong.reason !== 'unsupported');

	win.DaimondNoble = savedNoble;

	console.log(failures === 0 ? '\nALL PASS' : ('\n' + failures + ' FAILURE(S)'));
	if (failures) process.exitCode = 1;
}
main().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
