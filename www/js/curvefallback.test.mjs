/* ============================================================
   Test — crypto-capability fallback for Daimond identity.
   ------------------------------------------------------------
   Drives the REAL www/js/identity.js in a simulated browser whose
   WebCrypto can be made to lack Ed25519 and X25519 on demand, so
   every half of the fallback is exercised end to end:

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

     (c) ED25519 FOR EVERY ACCOUNT (D-20260923-46): an account CREATED
         on an engine without WebCrypto Ed25519 is Ed25519, made by the
         fallback. Its public key and pkcs8 are the bytes WebCrypto's
         own raw, pkcs8 and JWK exports hold for that key; its
         signatures verify under OpenSSL and under real WebCrypto,
         over the exact strings the gateway checks; and it opens
         natively on a full engine afterwards. No ECDSA key is ever
         asked for.

     (d) A GENUINE ERROR IS AN ERROR: a WebCrypto failure that is not
         NotSupportedError makes create() throw that error, write
         nothing, and never switch to another curve.

     (e) NEITHER WEBCRYPTO ED25519 NOR THE FALLBACK: create() throws
         with reason 'unsupported' and writes nothing.

     (f) THE NORMAL PATH IS UNCHANGED: on a full engine create() makes
         the key in WebCrypto, never touches the pure-JS code, and
         holds the key non-extractable, as unlock() does.

     (g) A CREATE OVER AN UNLOCKED FALLBACK IDENTITY signs with the NEW
         key, not the seed of the one it replaced.

   Before D-20260923-46, (c), (d), (e) and (g) failed: create() made an
   ECDSA P-256 key on ANY Ed25519 error.

   Run:  node www/js/curvefallback.test.mjs
   (Node 20+, whose own WebCrypto implements Ed25519 and X25519 —
    that is the "real" engine the fallback is checked against, and
    node:crypto's OpenSSL is the independent native verifier.)
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto, createPublicKey, verify as osslVerify } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const real = webcrypto;
let failures = 0, passes = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); passes++; }
	else { console.log('  FAIL ' + line); failures++; }
}
const eqBytes = (a, b) => {
	const x = new Uint8Array(a), y = new Uint8Array(b);
	if (x.length !== y.length) return false;
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
};
const b64    = (u8) => Buffer.from(u8).toString('base64');
const b64url = (u8) => Buffer.from(u8).toString('base64url');
const unb64  = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));

// A WebCrypto proxy whose Ed25519/X25519 support is toggled by `flags`.
// Everything else (PBKDF2, AES-GCM, exportKey, verify) passes straight through.
//
// A missing algorithm is refused the way a browser refuses it: a DOMException
// NAMED NotSupportedError, which is what WebCrypto's algorithm normalisation
// answers for a name the engine does not know (Chrome before 137, Firefox before
// 129, Safari before 17). `edFail` and `exportFail` are the other kind -- a
// genuine failure of an engine that DOES implement Ed25519 -- so the test can
// tell the two apart the way identity.js must.
const flags = { noEd: false, noX: false, edFail: null, exportFail: null };
const calls = [];				// every algorithm a key was generated or imported for.
function blocked(name) {
	return (name === 'Ed25519' && flags.noEd) || (name === 'X25519' && flags.noX);
}
const unsupported = (name) => Promise.reject(
	new DOMException('Algorithm: Unrecognized name', 'NotSupportedError'));
const cryptoShim = {
	getRandomValues: (a) => real.getRandomValues(a),
	subtle: {
		generateKey: (algo, ex, u) => {
			const name = algo && algo.name;
			calls.push({ op: 'generateKey', name, ex });
			if (blocked(name)) return unsupported(name);
			if (name === 'Ed25519' && flags.edFail) {
				return Promise.reject(new DOMException('the engine failed', flags.edFail));
			}
			return real.subtle.generateKey(algo, ex, u);
		},
		importKey: (fmt, data, algo, ex, u) => {
			const name = algo && algo.name;
			calls.push({ op: 'importKey', fmt, name, ex });
			return blocked(name) ? unsupported(name) : real.subtle.importKey(fmt, data, algo, ex, u);
		},
		deriveBits: (algo, key, len) => blocked(algo && algo.name)
			? unsupported(algo.name) : real.subtle.deriveBits(algo, key, len),
		sign: (algo, key, data) => blocked(algo && algo.name)
			? unsupported(algo.name) : real.subtle.sign(algo, key, data),
		exportKey: (fmt, key) => {
			if (flags.exportFail && fmt === flags.exportFail) {
				return Promise.reject(new DOMException('the engine failed', 'OperationError'));
			}
			return real.subtle.exportKey(fmt, key);
		},
		deriveKey: (...a) => real.subtle.deriveKey(...a),
		encrypt:   (...a) => real.subtle.encrypt(...a),
		decrypt:   (...a) => real.subtle.decrypt(...a),
		verify:    (...a) => real.subtle.verify(...a),
	},
};
const askedEcdsa = () => calls.some((c) => c.name === 'ECDSA');

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

// Count every use of the pure-JS Ed25519, so a check can say which engine did
// the work. The bundle's objects are frozen, so the global is replaced by one
// that calls through; curvefallback.js reads `window.DaimondNoble` at every
// call, so it uses these.
const nobleUse = { getPublicKey: 0, sign: 0 };
{
	const orig = win.DaimondNoble;
	win.DaimondNoble = {
		ed25519: {
			getPublicKey: (...a) => { nobleUse.getPublicKey++; return orig.ed25519.getPublicKey(...a); },
			sign:         (...a) => { nobleUse.sign++; return orig.ed25519.sign(...a); },
			verify:       (...a) => orig.ed25519.verify(...a),
		},
		x25519: orig.x25519,
	};
}
const nobleCalls = () => nobleUse.getPublicKey + nobleUse.sign;

/// The pkcs8 an account holds, opened the way unlock() opens it: PBKDF2 of the
/// passphrase over the stored salt, then AES-GCM. Real WebCrypto throughout, so
/// what is read is exactly what is at rest.
async function storedPkcs8(pass) {
	const salt = unb64(store.get('daimond-id-salt'));
	const base = await real.subtle.importKey('raw', new TextEncoder().encode(pass),
		{ name: 'PBKDF2' }, false, ['deriveKey']);
	const key = await real.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
		base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
	const blob = unb64(store.get('daimond-id-priv'));
	return new Uint8Array(await real.subtle.decrypt(
		{ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12)));
}

/// OpenSSL's verdict on an Ed25519 signature: node:crypto, not WebCrypto and not
/// noble, so a third implementation stands behind every "verifies".
function opensslVerifies(pub, sig, data) {
	try {
		const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(pub) }, format: 'jwk' });
		return osslVerify(null, Buffer.from(data), key, Buffer.from(sig));
	} catch (e) { return false; }
}

/// Real WebCrypto's verdict, as a modern browser would give it.
async function webcryptoVerifies(pub, sig, data) {
	try {
		const k = await real.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
		return await real.subtle.verify({ name: 'Ed25519' }, k, sig, data);
	} catch (e) { return false; }
}

/// Forget every identity key between phases, as a fresh browser profile would.
function freshStore() {
	ID.lock();
	for (const k of [...store.keys()]) store.delete(k);
	calls.length = 0;
}

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

	// ── Phase C — an account CREATED without WebCrypto Ed25519 ──
	console.log('\nPhase C — create on an engine without WebCrypto Ed25519');
	freshStore();
	flags.noEd = true; flags.noX = true;
	let cErr = null;
	try { await ID.create('Old phone', PASS); } catch (e) { cErr = e; }
	check('create succeeds', cErr === null, cErr ? String(cErr && cErr.message) : '');
	const cAlg = localStorage.getItem('daimond-id-alg');
	check('the account is Ed25519, not P-256', cAlg === 'Ed25519', 'daimond-id-alg = ' + cAlg);
	check('no ECDSA key was ever asked for', !askedEcdsa(),
		calls.filter((c) => c.name === 'ECDSA').map((c) => c.op).join(', '));
	check('WebCrypto Ed25519 was asked first, and refused',
		calls.some((c) => c.op === 'generateKey' && c.name === 'Ed25519'));
	check('the identity is unlocked after create', ID.isUnlocked());

	const cPub = await ID.publicKeyRaw();
	check('the public key is 32 raw bytes', !!cPub && cPub.length === 32, cPub ? cPub.length + ' bytes' : 'none');
	check('publicKeyB64url is the unpadded 43-character form the gateway binds',
		ID.publicKeyB64url() === b64url(cPub) && ID.publicKeyB64url().length === 43);

	// What is at rest is what WebCrypto itself would have stored.
	if (cAlg === 'Ed25519') {
		const pk8 = await storedPkcs8(PASS);
		const ref = await real.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
		const refPk8 = new Uint8Array(await real.subtle.exportKey('pkcs8', ref.privateKey));
		check('the stored pkcs8 is 48 bytes, as WebCrypto emits', pk8.length === 48, pk8.length + ' bytes');
		check('its 16-byte header is byte-identical to a WebCrypto Ed25519 pkcs8',
			eqBytes(pk8.slice(0, 16), refPk8.slice(0, 16)),
			Buffer.from(pk8.slice(0, 16)).toString('hex'));
		let imported = null;
		try {
			imported = await real.subtle.importKey('pkcs8', pk8, { name: 'Ed25519' }, true, ['sign']);
		} catch (e) { imported = null; }
		check('real WebCrypto imports it unchanged', !!imported);
		if (imported) {
			const jwk = await real.subtle.exportKey('jwk', imported);
			check('its JWK is OKP / Ed25519', jwk.kty === 'OKP' && jwk.crv === 'Ed25519');
			check('the JWK public half x is the stored raw public key', jwk.x === b64url(cPub));
			check('the JWK private half d is the seed the pkcs8 carries', jwk.d === b64url(pk8.slice(16)));
			// A key re-imported from that JWK exports the same raw public key.
			const fromJwk = await real.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
				{ name: 'Ed25519' }, true, ['verify']);
			check('WebCrypto raw export of the key is the stored public key',
				eqBytes(new Uint8Array(await real.subtle.exportKey('raw', fromJwk)), cPub));
		}
		pk8.fill(0);
	} else {
		check('the stored key is an Ed25519 pkcs8 (skipped: the account is not Ed25519)', false);
	}

	// It signs, and three independent verifiers agree.
	const cSig = unb64(await ID.sign(MSG));
	check('the signature is 64 raw bytes', cSig.length === 64, cSig.length + ' bytes');
	check('OpenSSL verifies it', opensslVerifies(cPub, cSig, MSG));
	check('real WebCrypto verifies it', await webcryptoVerifies(cPub, cSig, MSG));
	check('DaimondIdentity.verifySig verifies it on this crippled engine',
		await ID.verifySig(cPub, b64(cSig), MSG));
	check('and refuses it over a changed message',
		!(await ID.verifySig(cPub, b64(cSig), new TextEncoder().encode('sign me across the two code pathz'))));

	// The exact strings the gateway checks (gateway/src/auth.rs): the account
	// binding at registration and the login challenge, signed as UTF-8 text.
	const ts = Math.floor(Date.now() / 1000);
	const acct = 'daimond-gw-account:v1:' + ID.publicKeyB64url() + ':' + ts;
	const chal = 'daimond-gw-auth:v1:acct_test:nonce123:' + ts;
	const acctSig = unb64(await ID.sign(acct));
	const chalSig = unb64(await ID.sign(chal));
	check('OpenSSL verifies the gateway account-binding signature',
		opensslVerifies(cPub, acctSig, new TextEncoder().encode(acct)));
	check('OpenSSL verifies the gateway login-challenge signature',
		opensslVerifies(cPub, chalSig, new TextEncoder().encode(chal)));

	// A sealing key, from the same fallback, so the account can be messaged.
	const cSeal = ID.sealingKeyRaw();
	check('an X25519 sealing key was made too', !!cSeal && cSeal.length === 32);

	// The account opens NATIVELY on a modern engine, and signs the same bytes.
	ID.lock();
	flags.noEd = false; flags.noX = false;
	const before = nobleCalls();
	const cOpen = await ID.unlock(PASS);
	check('a full engine unlocks the account', !!cOpen && cOpen.ok === true);
	const cSigNative = unb64(await ID.sign(MSG));
	check('and signs through WebCrypto, not the fallback', nobleCalls() === before,
		(nobleCalls() - before) + ' pure-JS call(s)');
	check('the native signature is byte-identical to the fallback\'s (Ed25519 is deterministic)',
		eqBytes(cSigNative, cSig));

	// And again on the crippled engine: the same account, through the fallback.
	ID.lock();
	flags.noEd = true; flags.noX = true;
	const cAgain = await ID.unlock(PASS);
	check('the crippled engine unlocks it again', !!cAgain && cAgain.ok === true);
	check('and signs the same bytes', eqBytes(unb64(await ID.sign(MSG)), cSig));

	// ── Phase D — a genuine failure is an error, not a curve switch ──
	console.log('\nPhase D — a WebCrypto failure that is not NotSupportedError');
	freshStore();
	flags.noEd = false; flags.noX = false;
	flags.edFail = 'OperationError';
	let dErr = null;
	try { await ID.create('Flaky', PASS); } catch (e) { dErr = e; }
	check('create throws', dErr !== null,
		dErr ? '' : 'it returned, holding a ' + localStorage.getItem('daimond-id-alg') + ' key');
	check('the error is WebCrypto\'s own, passed through', !!dErr && dErr.name === 'OperationError',
		dErr ? dErr.name : '');
	check('and is not dressed as "unsupported"', !dErr || dErr.reason !== 'unsupported');
	check('no ECDSA key was ever asked for', !askedEcdsa());
	check('nothing was written', !store.has('daimond-id-priv') && !store.has('daimond-id-alg')
		&& !store.has('daimond-id-salt') && !store.has('daimond-id-pub'),
		[...store.keys()].join(', '));
	check('the identity stays locked', !ID.isUnlocked());
	flags.edFail = null;

	// The same for a failed export, on an engine that made the key.
	freshStore();
	flags.exportFail = 'pkcs8';
	let dErr2 = null;
	try { await ID.create('Flaky export', PASS); } catch (e) { dErr2 = e; }
	check('a failed pkcs8 export throws too', dErr2 !== null && dErr2.name === 'OperationError');
	check('and writes nothing', !store.has('daimond-id-priv') && !store.has('daimond-id-alg'));
	check('and asks for no ECDSA key', !askedEcdsa());
	flags.exportFail = null;

	// ── Phase E — neither WebCrypto Ed25519 nor the fallback ──
	console.log('\nPhase E — no WebCrypto Ed25519 and no fallback');
	freshStore();
	flags.noEd = true; flags.noX = true;
	win.DaimondNoble = undefined;
	let eErr = null;
	try { await ID.create('Ancient', PASS); } catch (e) { eErr = e; }
	check('create throws', eErr !== null,
		eErr ? '' : 'it returned, holding a ' + localStorage.getItem('daimond-id-alg') + ' key');
	check('with reason "unsupported", for the create screen to word',
		!!eErr && eErr.reason === 'unsupported', eErr ? String(eErr.reason) : '');
	check('no ECDSA key was ever asked for', !askedEcdsa());
	check('nothing was written', !store.has('daimond-id-priv') && !store.has('daimond-id-alg')
		&& !store.has('daimond-id-salt'));
	win.DaimondNoble = savedNoble;

	// ── Phase F — the normal path is unchanged ──
	console.log('\nPhase F — create on a full engine');
	freshStore();
	flags.noEd = false; flags.noX = false;
	const fBefore = nobleCalls();
	await ID.create('Modern', PASS);
	check('the account is Ed25519', localStorage.getItem('daimond-id-alg') === 'Ed25519');
	check('made by WebCrypto generateKey',
		calls.some((c) => c.op === 'generateKey' && c.name === 'Ed25519'));
	check('never touching the pure-JS code', nobleCalls() === fBefore,
		(nobleCalls() - fBefore) + ' pure-JS call(s)');
	check('the key held after create is NON-extractable, as unlock holds it',
		calls.some((c) => c.op === 'importKey' && c.fmt === 'pkcs8' && c.name === 'Ed25519' && c.ex === false));
	check('no ECDSA key was ever asked for', !askedEcdsa());
	const fPub = await ID.publicKeyRaw();
	const fSig = unb64(await ID.sign(MSG));
	check('it signs, still through WebCrypto', nobleCalls() === fBefore);
	check('OpenSSL verifies it', opensslVerifies(fPub, fSig, MSG));

	// ── Phase G — a create over an unlocked fallback identity ──
	console.log('\nPhase G — create over an identity unlocked through the fallback');
	// The first identity is made anywhere and then OPENED through the fallback, so
	// its pure-JS seed is what is in memory when the second create runs.
	freshStore();
	flags.noEd = false; flags.noX = false;
	await ID.create('First', PASS);
	const gPubA = await ID.publicKeyRaw();
	ID.lock();
	flags.noEd = true; flags.noX = true;
	const gOpen = await ID.unlock(PASS);
	check('the first identity is unlocked on the fallback', !!gOpen && gOpen.ok === true && ID.isUnlocked());
	await ID.create('Second', PASS);				// no lock in between.
	const gPubB = await ID.publicKeyRaw();
	const gSig = unb64(await ID.sign(MSG));
	check('the second identity has a different key', !eqBytes(gPubA, gPubB));
	check('its signature verifies under ITS key', opensslVerifies(gPubB, gSig, MSG));
	check('and not under the key it replaced', !opensslVerifies(gPubA, gSig, MSG));
	ID.lock();

	console.log('');
	console.log(passes + ' passed, ' + failures + ' failed');
	console.log(failures === 0 ? 'ALL PASS' : (failures + ' FAILURE(S)'));
	if (failures) process.exitCode = 1;
}
main().catch((e) => { console.error('test crashed:', e); process.exitCode = 1; });
