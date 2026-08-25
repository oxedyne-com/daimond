// verify_passkey_blob.mjs — the /api/passkey-blob contract, from node.
//
// The sealed-bundle endpoint has an unusual shape: reading needs NO session,
// because the device asking has none and getting one is what it is here to do.
// That makes its access rules worth stating explicitly rather than inferring
// from the browser flow, and two accounts cannot be driven from one browser
// (one cookie jar), so this drives them from node instead.
//
// What must hold:
//   - GET is open, because the value is inert without the authenticator.
//   - POST needs a session, and binds the handle to that account.
//   - Another account cannot overwrite a handle that is already bound.
//   - DELETE needs a session, and only the owner's.
//   - Malformed handles and oversized blobs are refused.
//
//   node dev/verify_passkey_blob.mjs        (needs the gateway on :9002)

import crypto from 'node:crypto';
import { requireFreshGateway, SUITE_GW_LOG } from './gwbin.mjs';
import { GW_URL as GW } from './ports.mjs';

let failures = 0;
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};

const b64url = b => Buffer.from(b).toString('base64')
	.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/// Register an account by proving a fresh Ed25519 key, as the browser does, and
/// take a session. Returns { id, cookie }.
async function account() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	const pub  = publicKey.export({ format: 'jwk' }).x;
	const sign = msg => b64url(crypto.sign(null, Buffer.from(msg), privateKey));
	const ts   = Math.floor(Date.now() / 1000);
	const reg  = await fetch(`${GW}/api/account`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
		body: JSON.stringify({ pubkey: pub, alg: 'Ed25519', ts,
			sig: sign(`daimond-gw-account:v1:${pub}:${ts}`) }),
	});
	if (!reg.ok) return null;
	const id = (await reg.json()).account_id;
	const ch = await (await fetch(`${GW}/api/auth/challenge`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
		body: JSON.stringify({ pubkey: pub, alg: 'Ed25519' }),
	})).json();
	const ver = await fetch(`${GW}/api/auth/verify`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
		body: JSON.stringify({ challenge_id: ch.challenge_id, sig: sign(ch.challenge) }),
	});
	return { id, cookie: (ver.headers.get('set-cookie') || '').split(';')[0] };
}

const put = (cookie, handle, blob) => fetch(`${GW}/api/passkey-blob`, {
	method: 'POST',
	headers: Object.assign({ 'content-type': 'application/json', 'x-daimond-api': '1' },
		cookie ? { cookie } : {}),
	body: JSON.stringify({ handle, blob }),
});
const get = handle => fetch(`${GW}/api/passkey-blob?h=${encodeURIComponent(handle)}`,
	{ headers: { 'x-daimond-api': '1' } });
const del = (cookie, handle) => fetch(`${GW}/api/passkey-blob?h=${encodeURIComponent(handle)}`,
	{ method: 'DELETE', headers: Object.assign({ 'x-daimond-api': '1' }, cookie ? { cookie } : {}) });

/// A well-formed handle: 43 chars of base64url, as SHA-256 produces.
const handleOf = seed => b64url(crypto.createHash('sha256').update(seed).digest());

(async () => {
	requireFreshGateway();
	const health = await fetch(`${GW}/api/health`).then(r => r.ok).catch(() => false);
	check(health, 'the gateway is up');
	if (!health) { console.log('\nstart it: cd gateway && APP_MODE=sandbox ./target/release/daimond_gateway'); process.exit(1); }

	const a = await account();
	const b = await account();
	check(!!(a && a.id && b && b.id), 'two accounts register and sign in');

	const hA = handleOf('credential-of-a-' + a.id);
	const blobA = 'sealed-bundle-for-a';

	// ── Writing needs a session ──
	check((await put(null, hA, blobA)).status === 401,
		'storing a bundle without a session is refused (401)');

	// ── The owner may store, and anyone may read ──
	check((await put(a.cookie, hA, blobA)).status === 200, 'the account stores its sealed bundle');
	const r1 = await get(hA);
	const j1 = await r1.json();
	check(r1.status === 200 && j1.blob === blobA,
		'and ANY caller may read it back, with no session at all');

	// ── The value is all a reader gets: nothing names the account ──
	check(!JSON.stringify(j1).includes(a.id),
		'the response names no account, so a reader learns nothing but the ciphertext');

	// ── Another account cannot take over the handle ──
	const steal = await put(b.cookie, hA, 'sealed-bundle-for-b');
	check(steal.status === 409, 'another account cannot overwrite that handle (409)', 'HTTP ' + steal.status);
	const j2 = await (await get(hA)).json();
	check(j2.blob === blobA, 'and the original bundle is untouched');

	// ── The owner may re-store: a passphrase change re-seals ──
	check((await put(a.cookie, hA, 'resealed-bundle')).status === 200,
		'the owner may re-seal the same handle');
	check((await (await get(hA)).json()).blob === 'resealed-bundle', 'and the new bundle is served');

	// ── Shape checks ──
	check((await put(a.cookie, 'too-short', 'x')).status === 400, 'a malformed handle is refused (400)');
	check((await put(a.cookie, handleOf('sized'), 'x'.repeat(9000))).status === 413,
		'an oversized bundle is refused (413)');
	check((await get('nonsense')).status === 400, 'a malformed handle on read is refused (400)');
	check((await get(handleOf('never-stored'))).status === 404, 'an unknown handle reads 404');

	// ── Deleting ──
	check((await del(null, hA)).status === 401, 'deleting without a session is refused (401)');
	check((await del(b.cookie, hA)).status === 401, 'deleting another account\'s bundle is refused (401)');
	check((await del(a.cookie, hA)).status === 200, 'the owner may delete it');
	check((await get(hA)).status === 404, 'and it is gone');

	// This file starts no gateway of its own -- it is run against the one the
	// suite brings up for phase 2 -- so it has no log to quote. It can still say
	// WHERE the answer is: a 401 that should have been a 200 was explained by
	// the gateway, in that file, and nowhere in this output.
	if (failures) console.log('  ── what the gateway said is in ' + SUITE_GW_LOG + ' ──');
	console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
	process.exit(failures ? 1 : 0);
})().catch(e => {
	console.error(e);
	console.log('  ── what the gateway said is in ' + SUITE_GW_LOG + ' ──');
	process.exit(1);
});
