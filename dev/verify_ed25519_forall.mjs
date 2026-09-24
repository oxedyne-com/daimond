// verify_ed25519_forall.mjs — every Daimond account is Ed25519, on every browser.
//
// The owner's ruling of 2026-09-23 (D-20260923-46, "Ed25519 for all"). Until it,
// `identity.js` made an ECDSA P-256 key whenever WebCrypto's Ed25519 call
// rejected, for any reason at all, and that account signed P-256 for good on
// every device linked to it. Now an engine without WebCrypto Ed25519 gets the
// SAME kind of key from the pure-JS fallback (curvefallback.js), and a failure
// that is not a missing feature is an error.
//
// It drives the REAL app in Chromium, with `crypto.subtle` wrapped before any
// page script runs so that Ed25519 and X25519 are refused exactly as an old
// engine refuses them: a DOMException named NotSupportedError, which is what
// Chrome before 137, Firefox before 129 and Safari before 17 answer. What each
// block settles:
//
//   A  An account created through the create screen on such a browser is
//      Ed25519, made by the fallback; no ECDSA key is ever asked for. Its
//      public key is 32 raw bytes, its pkcs8 at rest is what WebCrypto emits
//      (Node's WebCrypto imports it, and the JWK x/d match), and its signature
//      verifies under OpenSSL. It mints its identity card, which P-256 could not.
//   B  The same browser registers with, and signs in to, a real gateway --
//      the gateway's own Ed25519 verifier accepting both the account binding
//      and the login challenge. Runs only when a gateway answers.
//   C  A trust edge it signs verifies on the replay there: trust.js checks it
//      through DaimondIdentity.verifySig, which carries the fallback, rather
//      than through a WebCrypto call of its own that the browser refuses.
//   D  With the fallback ALSO withheld, the create screen says the browser
//      cannot do the cryptography, and nothing is stored.
//   E  A genuine WebCrypto failure (OperationError) is "could not create", and
//      nothing is stored -- never an account of another kind.
//   F  A passkey unlock on a browser that cannot load the key says so, rather
//      than "This passkey is out of date".
//   G  The normal path: a modern Chromium makes the key in WebCrypto and never
//      touches the pure-JS code.
//   H  Firefox and WebKit, the other two engines, import the fallback-made
//      account's key unchanged: the same raw public key, the same JWK, and
//      their signatures and the fallback's verify both ways.
//
// Needs the dev server (DAIMOND_PORT). Block B needs a gateway behind it
// (DAIMOND_GW_PORT); without one it says it did not run rather than passing.

import { pathToFileURL } from 'node:url';
import { webcrypto, createPublicKey, verify as osslVerify } from 'node:crypto';
import { open, signInAs, PASS, PW, APP } from './harness.mjs';
import { GW_URL, GW_PORT } from './ports.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (s) => console.log('  note ' + s);

const b64url = (u8) => Buffer.from(u8).toString('base64url');
const unb64  = (s) => new Uint8Array(Buffer.from(String(s), 'base64'));
const eqBytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const MSG = 'daimond-gw-account:v1:a-string-shaped-like-what-the-gateway-checks:1790000000';

/// OpenSSL's verdict on an Ed25519 signature: node:crypto, independent of every
/// engine under test and of noble.
function opensslVerifies(pub, sig, data) {
	try {
		const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(pub) }, format: 'jwk' });
		return osslVerify(null, Buffer.from(data), key, Buffer.from(sig));
	} catch (e) { return false; }
}

/// The browser-side wrap of `crypto.subtle`. Runs before any page script.
///
/// `noEd` / `noX` refuse the curve as an old engine does; `fail` makes Ed25519
/// key generation fail with that DOMException name instead, the genuine-error
/// case. Every algorithm a key is generated or imported for is recorded in
/// `window.__cryptoCalls`, so the page can be asked whether ECDSA was ever
/// requested. With no flags set it only records.
function wrapSubtle(mode) {
	const s = crypto.subtle;
	const calls = window.__cryptoCalls = [];
	const nameOf = (a) => (typeof a === 'string') ? a : (a && a.name);
	const refused = (n) => (mode.noEd && n === 'Ed25519') || (mode.noX && n === 'X25519');
	const refuse = () => Promise.reject(new DOMException('Algorithm: Unrecognized name', 'NotSupportedError'));
	// Which argument names the algorithm, per method.
	const at = { generateKey: 0, importKey: 2, deriveBits: 0, sign: 0, verify: 0 };
	for (const fn of Object.keys(at)) {
		const orig = s[fn].bind(s);
		s[fn] = function () {
			const n = nameOf(arguments[at[fn]]);
			calls.push(fn + ':' + n + (fn === 'importKey' ? ':' + arguments[0] + ':' + arguments[3] : ''));
			if (refused(n)) return refuse();
			if (fn === 'generateKey' && n === 'Ed25519' && mode.fail) {
				return Promise.reject(new DOMException('the engine failed', mode.fail));
			}
			return orig.apply(null, arguments);
		};
	}
}

/// Count the pure-JS fallback's key-making and signing, so a block can say
/// which engine did the work. The fallback is a plain object, so its methods
/// can be wrapped in place once it has loaded.
async function countFallback(page) {
	await page.evaluate(() => {
		const f = window.DaimondCurveFallback;
		window.__fbUse = { randomEdSeed: 0, edPublicKey: 0, edSign: 0, edSeedFromPkcs8: 0 };
		if (!f) return;
		for (const k of Object.keys(window.__fbUse)) {
			if (typeof f[k] !== 'function') continue;
			const orig = f[k];
			f[k] = function () { window.__fbUse[k]++; return orig.apply(this, arguments); };
		}
	});
}

/// The pkcs8 an account holds, opened with the passphrase exactly as unlock()
/// opens it -- PBKDF2 over the stored salt, then AES-GCM -- in Node's WebCrypto.
async function storedPkcs8(page, pass) {
	const st = await page.evaluate(() => ({
		salt: localStorage.getItem('daimond-id-salt'),
		priv: localStorage.getItem('daimond-id-priv'),
	}));
	if (!st.salt || !st.priv) return null;
	const base = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(pass),
		{ name: 'PBKDF2' }, false, ['deriveKey']);
	const key = await webcrypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt: unb64(st.salt), iterations: 600000, hash: 'SHA-256' },
		base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
	const blob = unb64(st.priv);
	return new Uint8Array(await webcrypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12)));
}

/// What the page's identity says about itself.
const identityFacts = (page) => page.evaluate(async () => {
	const pub = await window.DaimondIdentity.publicKeyRaw();
	return {
		alg:   localStorage.getItem('daimond-id-alg'),
		pub:   pub ? Array.from(pub) : null,
		calls: window.__cryptoCalls || [],
		fb:    window.__fbUse || null,
		unlocked: window.DaimondIdentity.isUnlocked(),
	};
});

/// The text the create screen shows for a key, read from the page's own table.
const said = (page, key) => page.evaluate((k) => window.DaimondI18n ? window.DaimondI18n.t(k) : k, key);

/// Try to create an account through the create screen, and answer what the
/// screen then says, or '' when it took.
///
/// The gate is waited for first, and generously. On a loaded machine the boot
/// has taken up to a minute to draw it (measured 2026-09-23 at a load average of
/// 31 on 16 cores), and the harness's own 15-second wait then fails a block on
/// the boot's speed rather than on what the screen says. A failure with nothing
/// on the screen answers the harness's own reason, never a bare "no message".
async function createThroughScreen(s) {
	await s.page.waitForFunction(() => {
		const b = document.getElementById('id-primary');
		return !!b && b.offsetParent !== null;
	}, null, { timeout: 120000 }).catch(() => { /* signInAs says what it found */ });
	try {
		await signInAs(s, s.name);
		return '';
	} catch (e) {
		const shown = await s.page.evaluate(() =>
			(document.getElementById('id-error') || {}).textContent || '').catch(() => '');
		return shown || '(nothing on screen: ' + String(e && e.message || e).split('\n')[0] + ')';
	}
}

const sessions = [];
async function session(opts) {
	const route = opts.route;
	const s = await open(Object.assign({ connect: false }, opts, {
		// Two minutes for a page load, not Playwright's thirty seconds. Under disk
		// pressure (IO "some" at 40-65% on 2026-09-23) a fresh profile's first
		// navigation took longer than thirty, and this file is about what the page
		// does once it is there, not about how fast it came.
		route: async (page) => {
			page.setDefaultNavigationTimeout(120000);
			if (route) await route(page);
		},
	}));
	sessions.push(s);
	return s;
}

let gatewayUp = false;
try {
	const r = await fetch(`${GW_URL}/api/policy`, { signal: AbortSignal.timeout(3000) });
	gatewayUp = r.ok;
} catch (e) { gatewayUp = false; }

let oldPkcs8 = null, oldPub = null, oldSig = null;
let A = null;			// block A's session, which B and C drive on

/// Run one block, so that a block which throws -- on a tree that makes a
/// different kind of account, say -- is a failure of that block and not the end
/// of the run: every later block still runs and still reports.
async function block(label, fn) {
	try {
		await fn();
	} catch (e) {
		check('block ' + label + ' ran to completion', false,
			String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
	}
}

try {
	// ── A ────────────────────────────────────────────────────────────
	await block('A', async () => {
		console.log(`\n── A. Created on a browser without WebCrypto Ed25519 ${'─'.repeat(16)}`);
		A = await session({
			name: 'ed25519-old', signIn: false,
			route: (page) => page.addInitScript(wrapSubtle, { noEd: true, noX: true }),
		});
		await A.page.waitForFunction(() => !!window.DaimondIdentity && !!window.DaimondCurveFallback,
			null, { timeout: 20000 });
		await countFallback(A.page);
		const aSaid = await createThroughScreen(A);
		check('the create screen took', aSaid === '', aSaid);
		const af = await identityFacts(A.page);
		check('the account is Ed25519', af.alg === 'Ed25519', 'daimond-id-alg = ' + af.alg);
		check('no ECDSA key was ever asked for', !af.calls.some((c) => /ECDSA/.test(c)),
			af.calls.filter((c) => /ECDSA/.test(c)).join(', '));
		check('WebCrypto Ed25519 was asked first, and refused',
			af.calls.includes('generateKey:Ed25519'));
		check('the key was made by the pure-JS fallback',
			!!af.fb && af.fb.randomEdSeed === 1 && af.fb.edPublicKey >= 1, JSON.stringify(af.fb));
		check('the public key is 32 raw bytes', !!af.pub && af.pub.length === 32,
			af.pub ? af.pub.length + ' bytes' : 'none');
		oldPub = af.pub ? new Uint8Array(af.pub) : null;

		oldPkcs8 = await storedPkcs8(A.page, PASS);
		check('the pkcs8 at rest is 48 bytes with WebCrypto\'s Ed25519 header',
			!!oldPkcs8 && oldPkcs8.length === 48
				&& Buffer.from(oldPkcs8.slice(0, 16)).toString('hex') === '302e020100300506032b657004220420',
			oldPkcs8 ? Buffer.from(oldPkcs8.slice(0, 16)).toString('hex') : 'unreadable');
		if (oldPkcs8 && oldPkcs8.length === 48) {
			let jwk = null;
			try {
				const k = await webcrypto.subtle.importKey('pkcs8', oldPkcs8, { name: 'Ed25519' }, true, ['sign']);
				jwk = await webcrypto.subtle.exportKey('jwk', k);
			} catch (e) { jwk = null; }
			check('Node\'s WebCrypto imports it, and its JWK x is the stored public key',
				!!jwk && !!oldPub && jwk.x === b64url(oldPub), jwk ? jwk.x : 'not imported');
		}

		oldSig = unb64(await A.page.evaluate((m) => window.DaimondIdentity.sign(m), MSG));
		check('it signs, and OpenSSL verifies the signature', !!oldPub && opensslVerifies(oldPub, oldSig, MSG));
		check('the pure-JS code did the signing',
			(await A.page.evaluate(() => window.__fbUse.edSign)) >= 1);
		const aCard = await A.page.evaluate(async () => {
			await window.DaimondIdentity.ensureSealingKey();
			return window.DaimondIdentity.mintCard();
		});
		check('it mints its identity card, which a P-256 account cannot', !!aCard && aCard.ok === true,
			aCard ? (aCard.why || '') : 'no answer');
	});

	// ── B ────────────────────────────────────────────────────────────
	await block('B', async () => {
		console.log(`\n── B. The gateway's own verifier ${'─'.repeat(36)}`);
		if (!gatewayUp) {
			note(`block B did not run: no gateway answered on :${GW_PORT}. It is not counted as a pass.`);
		} else {
			const g = await A.page.evaluate(async () => {
				let authed = false;
				try { authed = await window.DaimondGateway.bootstrap(); } catch (e) { authed = 'threw: ' + e.message; }
				const st = window.DaimondGateway.state();
				return { authed, account: st.accountId || '', offline: !!st.offline, refused: st.refused || '' };
			});
			check('the gateway accepted the account-binding signature and bound an account',
				!!g.account, g.account ? 'account ' + g.account.slice(0, 8) + '…' : JSON.stringify(g));
			check('and the login challenge: a session exists', g.authed === true, JSON.stringify(g));
		}
	});

	// ── C ────────────────────────────────────────────────────────────
	await block('C', async () => {
		console.log(`\n── C. A trust edge verifies on the replay there ${'─'.repeat(21)}`);
		const N = await session({ name: 'ed25519-new', signIn: true });
		await N.page.waitForFunction(() => !!window.DaimondCrypto && !!window.DaimondTrust, null, { timeout: 20000 });
		const nCard = await N.page.evaluate(async () => {
			await window.DaimondIdentity.ensureSealingKey();
			const m = await window.DaimondIdentity.mintCard();
			return m && m.ok ? window.DaimondTrust.cardText() : null;
		});
		const nKey = await N.page.evaluate(async () => {
			const p = await window.DaimondIdentity.publicKeyRaw();
			return Array.from(p).map((b) => (b + 256).toString(16).slice(1)).join('');
		});
		await A.page.waitForFunction(() => !!window.DaimondCrypto && !!window.DaimondTrust, null, { timeout: 20000 });
		const edge = await A.page.evaluate(async ({ text, key }) => {
			const T = window.DaimondTrust;
			const card = T.parse(text);
			if (!card) return { err: 'card did not parse' };
			await T.record(card, T.ROUTE.QR);
			const e = await T.markMatched(key, T.METHOD.QR);
			T.forget();
			const p = await T.person(key);
			return { wrote: !!(e && e.sig), state: p ? p.state : 'none' };
		}, { text: nCard, key: nKey });
		check('the old browser wrote a signed edge', !!edge.wrote, edge.err || '');
		check('and its own replay reads the person as matched', edge.state === 'matched',
			'state "' + edge.state + '"');
	});

	// ── D ────────────────────────────────────────────────────────────
	await block('D', async () => {
		console.log(`\n── D. Neither WebCrypto Ed25519 nor the fallback ${'─'.repeat(20)}`);
		const D = await session({
			name: 'ed25519-none', signIn: false,
			route: async (page) => {
				await page.addInitScript(wrapSubtle, { noEd: true, noX: true });
				// The vendored noble bundle withheld, so the fallback cannot load.
				await page.route('**/js/vendor/noble-curves.min.js', (r) => r.fulfill({
					status: 200, contentType: 'text/javascript', body: '/* withheld by the verifier */' }));
			},
		});
		await D.page.waitForFunction(() => !!window.DaimondIdentity, null, { timeout: 20000 });
		const dFb = await D.page.evaluate(() => !!(window.DaimondCurveFallback && window.DaimondCurveFallback.available()));
		check('the fallback is unavailable here, as intended', dFb === false);
		const dSaid = await createThroughScreen(D);
		const dWant = await said(D.page, 'identity.err_create_unsupported');
		check('the create screen says the browser cannot do the cryptography',
			dSaid === dWant && dWant !== 'identity.err_create_unsupported', '"' + dSaid + '"');
		const df = await identityFacts(D.page);
		check('nothing was stored', df.alg === null && !df.pub, 'daimond-id-alg = ' + df.alg);
		check('no ECDSA key was ever asked for', !df.calls.some((c) => /ECDSA/.test(c)));
	});

	// ── E ────────────────────────────────────────────────────────────
	await block('E', async () => {
		console.log(`\n── E. A genuine WebCrypto failure ${'─'.repeat(35)}`);
		const E = await session({
			name: 'ed25519-fail', signIn: false,
			route: (page) => page.addInitScript(wrapSubtle, { fail: 'OperationError' }),
		});
		await E.page.waitForFunction(() => !!window.DaimondIdentity, null, { timeout: 20000 });
		const eSaid = await createThroughScreen(E);
		const eWant = await said(E.page, 'identity.err_create');
		check('the create screen says the account could not be created', eSaid === eWant, '"' + eSaid + '"');
		const ef = await identityFacts(E.page);
		check('nothing was stored', ef.alg === null && !ef.pub, 'daimond-id-alg = ' + ef.alg);
		check('no ECDSA key was ever asked for', !ef.calls.some((c) => /ECDSA/.test(c)),
			ef.calls.filter((c) => /ECDSA/.test(c)).join(', '));
	});

	// ── F ────────────────────────────────────────────────────────────
	await block('F', async () => {
		console.log(`\n── F. A passkey unlock that cannot load the key ${'─'.repeat(21)}`);
		const F = await session({ name: 'ed25519-passkey', signIn: true });
		const cdp = await F.browser.newCDPSession(F.page);
		await cdp.send('WebAuthn.enable');
		let authId = null;
		for (const extra of [{ ctap2Version: 'ctap2_1', hasPrf: true }, { hasPrf: true }]) {
			try {
				const r = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: Object.assign({
					protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
					hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
				}, extra) });
				authId = r.authenticatorId;
				break;
			} catch (e) { /* the next option set */ }
		}
		const enrolled = authId ? await F.page.evaluate((p) => window.DaimondPasskey.enrol(p), PASS) : null;
		if (!enrolled || !enrolled.ok) {
			note('block F did not run: the virtual authenticator could not enrol a PRF passkey here ('
				+ JSON.stringify(enrolled) + '). It is not counted as a pass.');
		} else {
			// The same profile, reloaded as a browser that cannot load the account's
			// key at all: no WebCrypto Ed25519, and the fallback withheld.
			await F.page.addInitScript(wrapSubtle, { noEd: true, noX: true });
			await F.page.route('**/js/vendor/noble-curves.min.js', (r) => r.fulfill({
				status: 200, contentType: 'text/javascript', body: '/* withheld by the verifier */' }));
			await F.page.evaluate(() => window.DaimondIdentity.lock());
			await F.page.reload({ waitUntil: 'domcontentloaded' });
			await F.page.waitForFunction(() => !!window.DaimondPasskey && !!window.DaimondIdentity, null, { timeout: 20000 });
			const fr = await F.page.evaluate(() => window.DaimondPasskey.unlockWithPasskey());
			const fWant = await said(F.page, 'identity.err_unsupported_crypto');
			const fStale = await said(F.page, 'passkey.err_out_of_date');
			check('the passkey unlock fails', !!fr && fr.ok === false);
			check('and says the browser cannot do the cryptography', !!fr && fr.error === fWant,
				'"' + (fr && fr.error) + '"');
			check('not that the passkey is out of date', !!fr && fr.error !== fStale);
		}
	});

	// ── G ────────────────────────────────────────────────────────────
	await block('G', async () => {
		console.log(`\n── G. The normal path, on a modern Chromium ${'─'.repeat(25)}`);
		const G = await session({
			name: 'ed25519-modern', signIn: false,
			route: (page) => page.addInitScript(wrapSubtle, {}),
		});
		await G.page.waitForFunction(() => !!window.DaimondIdentity && !!window.DaimondCurveFallback,
			null, { timeout: 20000 });
		await countFallback(G.page);
		const gSaid = await createThroughScreen(G);
		check('the create screen took', gSaid === '', gSaid);
		const gf = await identityFacts(G.page);
		check('the account is Ed25519', gf.alg === 'Ed25519');
		check('made by WebCrypto', gf.calls.includes('generateKey:Ed25519'));
		check('never touching the pure-JS code',
			!!gf.fb && Object.values(gf.fb).every((n) => n === 0), JSON.stringify(gf.fb));
		check('held non-extractable after create, as unlock holds it',
			gf.calls.includes('importKey:Ed25519:pkcs8:false'));
		const gPub = new Uint8Array(gf.pub || []);
		const gSig = unb64(await G.page.evaluate((m) => window.DaimondIdentity.sign(m), MSG));
		check('OpenSSL verifies its signature', opensslVerifies(gPub, gSig, MSG));
	});

	// ── H ────────────────────────────────────────────────────────────
	await block('H', async () => {
		console.log(`\n── H. Firefox and WebKit take the fallback-made key unchanged ${'─'.repeat(7)}`);
		if (!oldPkcs8 || oldPkcs8.length !== 48 || !oldPub || !oldSig) {
			check('a fallback-made Ed25519 key from block A to carry across', false);
		} else {
			process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
			const pw = await import(pathToFileURL(PW).href);
			const env = Object.assign({}, process.env);
			delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
			for (const [label, engine] of [['Firefox', pw.firefox], ['WebKit', pw.webkit]]) {
				let br = null;
				try {
					br = await engine.launch({ headless: true, env });
					const page = await br.newPage();
					// Any page of the dev server: localhost is a secure context, so
					// `crypto.subtle` is there.
					await page.goto(APP + '/js/curvefallback.js');
					const got = await page.evaluate(async ({ pk8, pub, sig, msg }) => {
						const out = {};
						try {
							const s = crypto.subtle;
							const priv = await s.importKey('pkcs8', new Uint8Array(pk8), { name: 'Ed25519' }, true, ['sign']);
							const jwk = await s.exportKey('jwk', priv);
							const pubKey = await s.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
								{ name: 'Ed25519' }, true, ['verify']);
							out.raw = Array.from(new Uint8Array(await s.exportKey('raw', pubKey)));
							out.jwkX = jwk.x;
							const data = new TextEncoder().encode(msg);
							out.sig = Array.from(new Uint8Array(await s.sign({ name: 'Ed25519' }, priv, data)));
							out.theirs = await s.verify({ name: 'Ed25519' }, pubKey, new Uint8Array(sig), data);
							out.ua = navigator.userAgent;
						} catch (e) { out.err = e.name + ': ' + e.message; }
						return out;
					}, { pk8: Array.from(oldPkcs8), pub: Array.from(oldPub), sig: Array.from(oldSig), msg: MSG });
					if (got.err) {
						check(label + ' imports the pkcs8', false, got.err);
						continue;
					}
					check(label + ' imports the pkcs8, and its raw public key is the stored one',
						eqBytes(got.raw, oldPub));
					check(label + '\'s JWK x is the stored public key', got.jwkX === b64url(oldPub));
					check(label + ' verifies the fallback\'s signature', got.theirs === true);
					check('OpenSSL verifies ' + label + '\'s signature with that key',
						opensslVerifies(oldPub, new Uint8Array(got.sig), MSG));
					note(label + (eqBytes(got.sig, oldSig)
						? ' signed the same bytes as the fallback (deterministic).'
						: ' signed different bytes from the fallback (randomised signatures).'));
				} catch (e) {
					check(label + ' launches and runs the import', false, String(e.message || e).split('\n')[0]);
				} finally {
					if (br) await br.close().catch(() => {});
				}
			}
		}
	});
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
} finally {
	for (const s of sessions) { try { await s.close(); } catch (e) { /* already gone */ } }
	if (oldPkcs8) oldPkcs8.fill(0);
}

console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed');
if (bad.length) {
	for (const b of bad) console.log('  FAILED: ' + b);
	process.exitCode = 1;
}
