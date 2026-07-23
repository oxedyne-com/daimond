// verify_pro.mjs -- the Pro tier, end to end through the REAL gateway.
//
// Pro is a one-time licence that unlocks cross-device sync, cloud storage and
// Email. This drives the contract that matters: without Pro those three refuse,
// a webhook-minted licence turns all three on, and the licence endpoint reports
// the price a buy button needs. It signs its own Stripe events with the sandbox
// webhook secret, exactly as verify_admin does, so no real Stripe is touched.
//
//   node dev/verify_pro.mjs
//
// Needs the release gateway (it starts its own on :9002) and dev/serve.mjs :8777.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE  = path.dirname(fileURLToPath(import.meta.url));
const ROOT  = path.join(HERE, '..');
const GWDIR = path.join(ROOT, 'gateway');
const GW    = 'http://127.0.0.1:9002';
const WHSEC = fs.readFileSync(path.join(GWDIR, 'keys/stripe/sandbox/whsec'), 'utf8').trim();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const procs = [];
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } }
async function waitFor(fn, ms = 20000, gap = 300) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}

const b64url = b => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Register an account by proving a fresh Ed25519 key, as the browser does, and
// take a session; returns { id, cookie } so the test can call as that account.
async function account() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
	const jwk = publicKey.export({ format: 'jwk' });
	const pub = jwk.x;
	const sign = msg => b64url(crypto.sign(null, Buffer.from(msg), privateKey));

	const ts  = Math.floor(Date.now() / 1000);
	const reg = await fetch(`${GW}/api/account`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
		body: JSON.stringify({ pubkey: pub, alg: 'Ed25519', ts, sig: sign(`daimond-gw-account:v1:${pub}:${ts}`) }),
	});
	if (!reg.ok) return null;
	const regJ = await reg.json();
	const accountId = regJ.account_id;
	const ch = await (await fetch(`${GW}/api/auth/challenge`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
		body: JSON.stringify({ pubkey: pub, alg: 'Ed25519' }),
	})).json();
	const ver = await fetch(`${GW}/api/auth/verify`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
		body: JSON.stringify({ challenge_id: ch.challenge_id, sig: sign(ch.challenge) }),
	});
	const cookie = (ver.headers.get('set-cookie') || '').split(';')[0];
	return { id: accountId, cookie };
}

const authed = (cookie, path_, opts = {}) => fetch(`${GW}${path_}`, {
	...opts, headers: { ...(opts.headers || {}), cookie, 'x-daimond-api': '1' },
});

// Mint a Pro licence the one way the gateway trusts: a signed checkout event.
async function grantPro(accountId) {
	const payload = JSON.stringify({
		id: `evt_pro_${accountId}`,
		type: 'checkout.session.completed',
		data: { object: {
			payment_status: 'paid', amount_total: 4500, payment_intent: `pi_pro_${accountId}`,
			metadata: { account_id: accountId, product: 'pro' },
		} },
	});
	const t = Math.floor(Date.now() / 1000);
	const mac = crypto.createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
	return (await fetch(`${GW}/webhook/stripe`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` },
		body: payload,
	})).status;
}

// Refund that Pro purchase, the event that should revoke the licence.
async function refundPro(accountId) {
	const payload = JSON.stringify({
		id: `evt_refund_${accountId}`, type: 'charge.refunded',
		data: { object: { payment_intent: `pi_pro_${accountId}`, amount_refunded: 4500 } },
	});
	const t = Math.floor(Date.now() / 1000);
	const mac = crypto.createHmac('sha256', WHSEC).update(`${t}.${payload}`).digest('hex');
	return (await fetch(`${GW}/webhook/stripe`, {
		method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` },
		body: payload,
	})).status;
}

(async () => {
	const gw = spawn(path.join(GWDIR, 'target/release/daimond_gateway'), [], {
		cwd: GWDIR, env: { ...process.env, APP_MODE: 'sandbox' }, stdio: ['ignore', 'ignore', 'ignore'],
	});
	procs.push(gw);
	check('gateway comes up', await waitFor(async () => (await fetch(`${GW}/api/health`)).ok));

	const a = await account();
	check('a fresh account registers and signs in', !!(a && a.id), a && a.id);

	// ── Without Pro, the three capabilities refuse ──
	const licBefore = await (await authed(a.cookie, '/api/licence')).json();
	check('licence endpoint reports no Pro held', licBefore.held === false && !licBefore.licence);
	check('and names the price a buy button needs',
		licBefore.pro_price_minor === 4500, 'price ' + licBefore.pro_price_minor);

	const syncNo = await authed(a.cookie, '/api/sync', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ base_version: 0, blob: 'x', device: 'test' }),
	});
	check('sync refuses without Pro (402)', syncNo.status === 402, 'status ' + syncNo.status);

	const chunkNo = await authed(a.cookie, '/api/chunk', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ op: 'put', chunks: [] }),
	});
	check('cloud storage upload refuses without Pro (402)', chunkNo.status === 402, 'status ' + chunkNo.status);

	const mailNo = await authed(a.cookie, '/api/mail/accounts');
	const mailNoJ = await mailNo.json();
	check('email reports locked without Pro', mailNoJ.unlocked === false, 'unlocked ' + mailNoJ.unlocked);

	// ── A Pro licence turns all three on ──
	check('a Pro purchase mints a licence (webhook 200)', await grantPro(a.id) === 200);

	const licAfter = await (await authed(a.cookie, '/api/licence')).json();
	check('licence endpoint now reports Pro held', licAfter.held === true && !!licAfter.licence);

	const syncYes = await authed(a.cookie, '/api/sync', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ base_version: 0, blob: 'aGVsbG8=', device: 'test' }),
	});
	check('sync is accepted with Pro (not 402)', syncYes.status !== 402, 'status ' + syncYes.status);

	// A put of nothing is a well-formed request the gate now lets through: it is
	// no longer 402. (An empty batch stores nothing, which is fine.)
	const chunkYes = await authed(a.cookie, '/api/chunk', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ op: 'put', chunks: [] }),
	});
	check('cloud storage upload passes the gate with Pro (not 402)',
		chunkYes.status !== 402, 'status ' + chunkYes.status);

	const mailYes = await (await authed(a.cookie, '/api/mail/accounts')).json();
	check('email reports unlocked with Pro', mailYes.unlocked === true, 'unlocked ' + mailYes.unlocked);

	// ── Buying Pro twice is refused, not double-charged ──
	const twice = await authed(a.cookie, '/api/checkout/pro', {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
	});
	check('a second Pro purchase is refused (409)', twice.status === 409, 'status ' + twice.status);

	// ── A refund revokes Pro, and the three lock again ──
	check('a refund is accepted (webhook 200)', await refundPro(a.id) === 200);
	const licRefunded = await (await authed(a.cookie, '/api/licence')).json();
	check('licence is revoked after the refund', licRefunded.held === false);
	const syncGone = await authed(a.cookie, '/api/sync', {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ base_version: 1, blob: 'x', device: 'test' }),
	});
	check('sync refuses again after the refund (402)', syncGone.status === 402, 'status ' + syncGone.status);

	cleanup();
	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
