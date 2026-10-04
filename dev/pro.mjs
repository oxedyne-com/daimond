// pro.mjs — give the account a page is signed in as a Pro licence.
//
// Sync, cloud storage and Email are behind Pro (one door, since 7f8e776), so a
// test that pushes a workspace or fetches a chunk has to hold it or every call
// comes back 402 and the test measures the gate rather than the feature.
//
// There is exactly one way the gateway grants Pro, and this uses it: a signed
// `checkout.session.completed` event on /webhook/stripe, verified against the
// sandbox webhook secret. Writing the licence into the store behind its back
// would prove the client works against a state the gateway never produces.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GW_URL } from './ports.mjs';

/// The account id the page's own identity binds to.
///
/// `/api/account` is idempotent — an existing binding is re-confirmed — so this
/// names the account without disturbing it.
export async function accountOf(page) {
	return await page.evaluate(async () => {
		const pub = window.DaimondIdentity.publicKeyB64url();
		const alg = localStorage.getItem('daimond-id-alg') || 'Ed25519';
		const ts  = Math.floor(Date.now() / 1000);
		const sig = await window.DaimondIdentity.sign('daimond-gw-account:v1:' + pub + ':' + ts);
		const r = await fetch('/api/account', {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '2' },
			body: JSON.stringify({ pubkey: pub, alg: alg, ts: ts, sig: sig }),
		});
		const j = await r.json();
		return (j && j.account_id) || '';
	});
}

/// Mint a Pro licence for `accountId`, the one way the gateway trusts.
///
/// Returns the webhook's HTTP status: 200 is the grant, anything else means the
/// licence was NOT issued and the caller should say so rather than carry on.
///
/// PRO IS A SUBSCRIPTION NOW. Until the subscription cutover Pro was granted on a
/// `checkout.session.completed` event, and this posted that. Since then the gateway
/// grants Pro ONLY through `apply_subscription_event` on a `customer.subscription.*`
/// event (gateway/src/handlers/webhook.rs): the checkout-completed event for a Pro
/// product is a deliberate no-op that merely notes the hosted page finished. So this
/// posts the event the running gateway actually acts on -- a `customer.subscription.created`
/// with `status: "active"`, the account under `metadata.account_id`, and a future
/// `current_period_end` (a stale one is refused as a redelivery). The store's
/// `subscription.grants()` reads Active as Pro, exactly as a live subscription would.
// THE RUN'S OWN GATEWAY, NOT THE FLEET'S. This said `9002` outright, and on
// 2026-08-25 a lane holding its gateway on a port of its own posted a signed Pro
// webhook straight at another lane's gateway, which answered 500. The suite read
// that as "entitled accounts ready: no" and skipped the two mail verifiers -- and
// the stranger had been sent a licence event for an account it had never heard of.
// It is re-exported rather than re-derived: `dev/ports.mjs` is the one place that
// decides where a gateway is, and this file's callers already say `GW_URL`.
export { GW_URL };

export async function grantPro(accountId, gatewayDir, gwUrl = GW_URL) {
	const whsec = fs.readFileSync(
		path.join(gatewayDir, 'keys/stripe/sandbox/whsec'), 'utf8').trim();
	// A year out, so the recency guard (a period end predating the stored one is a
	// stale redelivery) never rejects it whenever the run happens.
	const cpe = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
	const payload = JSON.stringify({
		id: `evt_pro_${accountId}`,
		object: 'event',
		type: 'customer.subscription.created',
		data: { object: {
			id:                 `sub_${accountId}`,
			object:             'subscription',
			customer:           `cus_${accountId}`,
			status:             'active',
			current_period_end: cpe,
			metadata: { account_id: accountId, product: 'pro' },
		} },
	});
	const t   = Math.floor(Date.now() / 1000);
	const mac = crypto.createHmac('sha256', whsec).update(`${t}.${payload}`).digest('hex');
	const r = await fetch(`${gwUrl}/webhook/stripe`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` },
		body: payload,
	});
	return r.status;
}

/// Grant one TOOL PACK to `accountId`, the one way the gateway trusts.
///
/// Pro is a subscription and a pack is a purchase, so they arrive on different
/// events and neither grants the other. The compiler is sold in a pack
/// (`drop01`, `Tool::TypstCompile.pack()`), and this matters to every verifier
/// that compiles WITH A GATEWAY UP: `/api/tools` is the only thing that knows
/// what the account holds, `tools.js pushLocks` hands that answer to the wasm,
/// and `typst.js` refuses before it fetches 30 MB of compiler. A verifier with no
/// gateway locks nothing and compiles freely; the moment one is running, the same
/// verifier is told "Typesetting is part of a tool pack this account has not
/// bought" and measures the till instead of the feature.
///
/// The event is a completed checkout carrying `metadata.product: 'pack'` and the
/// pack key in `metadata.pack`, with `payment_status: 'paid'` -- the gateway
/// refuses to grant a money-moving product on a session that completed unpaid
/// (`apply_event`, gateway/src/handlers/webhook.rs).
///
/// # Arguments
/// * `pack` - the catalogue key, e.g. `drop01` for the typesetting pack.
export async function grantPack(accountId, pack, gatewayDir, gwUrl = GW_URL) {
	const whsec = fs.readFileSync(
		path.join(gatewayDir, 'keys/stripe/sandbox/whsec'), 'utf8').trim();
	const payload = JSON.stringify({
		id: `evt_pack_${pack}_${accountId}`,
		object: 'event',
		type: 'checkout.session.completed',
		data: { object: {
			id:             `cs_${pack}_${accountId}`,
			object:         'checkout.session',
			customer:       `cus_${accountId}`,
			payment_status: 'paid',
			metadata: { account_id: accountId, product: 'pack', pack: pack },
		} },
	});
	const t   = Math.floor(Date.now() / 1000);
	const mac = crypto.createHmac('sha256', whsec).update(`${t}.${payload}`).digest('hex');
	const r = await fetch(`${gwUrl}/webhook/stripe`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${mac}` },
		body: payload,
	});
	return r.status;
}

/// Buy the page's account a pack and let the running app notice.
///
/// The locks are pushed into the wasm from the `/api/tools` answer, which is read
/// once, so a page that was already up goes on refusing the tool until it re-asks.
/// Answers `{ id, status, locked }` -- `locked` being what the ENGINE says about
/// the tool afterwards, which is the thing that actually decides.
export async function makePagePack(page, pack, tool, gatewayDir, gwUrl) {
	const id = await accountOf(page);
	if (!id) return { id: '', status: 0, locked: true };
	const status = await grantPack(id, pack, gatewayDir, gwUrl);
	const locked = await page.evaluate(async (nm) => {
		if (window.DaimondTools && window.DaimondTools.reload) await window.DaimondTools.reload();
		try {
			const m = await import('/pkg/oxedyne_daimond.js');
			return m.tool_locked(nm) === true;
		} catch (e) { return true; }
	}, tool);
	return { id, status, locked };
}

/// Grant Pro from the command line, for a shell that already knows the id:
///
///   node dev/pro.mjs <account_id> [gateway_dir] [gateway_url]
///
/// Prints the webhook status. Used by dev/run_all.sh when it provisions the
/// fixed profile, so the entitled tests do not meet the Pro gate mid-run.
if (process.argv[1] && process.argv[1].endsWith('pro.mjs') && process.argv[2]) {
	const dir = process.argv[3] || new URL('../gateway', import.meta.url).pathname;
	const url = process.argv[4] || GW_URL;
	console.log(await grantPro(process.argv[2], dir, url));
}

/// Sign the page's account up to Pro and let the running app notice.
///
/// The licence is asked for once at unlock and cached, so a page that was
/// already up still believes it is on the free tier until it re-asks.
export async function makePagePro(page, gatewayDir, gwUrl) {
	const id = await accountOf(page);
	if (!id) return { id: '', status: 0, pro: false };
	const status = await grantPro(id, gatewayDir, gwUrl);
	const pro = await page.evaluate(async () => {
		if (window.DaimondGateway && window.DaimondGateway.refreshLicence) {
			await window.DaimondGateway.refreshLicence();
		}
		// Sync stopped pushing on the 402 it met before the licence existed.
		if (window.DaimondSync && window.DaimondSync.recheck) window.DaimondSync.recheck();
		return !!(window.DaimondGateway && window.DaimondGateway.state().pro);
	});
	return { id, status, pro };
}
