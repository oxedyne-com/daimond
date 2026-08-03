// verify_gwretry.mjs — the four files that hold their own gateway `fetch` meet a
// 401 with one re-authentication and one retry, and the two that must NOT do
// that still do not.
//
// THE BUG THIS EXISTS FOR. The gateway's session lives exactly an hour
// (SESSION_TTL_SECS, gateway/src/handlers/common.rs) and nothing refreshes it on
// use. `DaimondGateway.reauth()` was written for precisely this and wired into
// sync.js alone; mail.js, tools.js, pairing.js and passkey.js each kept their own
// `fetch` and each treated the 401 as something else entirely. An hour into a
// sitting: the Tools panel said the account service could not be reached, the
// mail panel said it could not tell whether Email was unlocked and offered the
// Pro pitch to an account holding Pro, "Link another device" said "Sign in on
// this device before linking another" with no control anywhere that would do
// that, and removing a passkey left the gateway's copy of its sealed bundle in
// place — a passkey the user believes they revoked, still able to adopt the
// account. Nothing recovered short of a reload.
//
// HOW HONESTLY THIS REPRODUCES IT. The session is ended SERVER-SIDE with a raw
// POST to /api/auth/logout — not `DaimondGateway.logout()`, which would tell the
// client. That leaves precisely the production state: a live page that believes
// it is signed in, holding a cookie that names nothing. Every check below runs
// against the REAL gateway on :9002 over that state, through the real panels,
// and asserts on the REQUEST TRACE — the endpoint was refused, and then it was
// served — rather than on any flag the app keeps about itself. `state.authed` is
// the flag that was lying, so it is never the evidence.
//
// The two stubbed checks are marked as stubbed, and they are stubbed for a
// reason: what they prove is that a path was DELIBERATELY LEFT OUT of the
// retry, and the gateway will not produce the 401 that would show it. See (7).
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

/// Is the gateway answering?
async function gatewayUp() {
	try {
		const r = await fetch('http://127.0.0.1:9002/api/health', { signal: AbortSignal.timeout(2000) });
		return r.ok;
	} catch (e) { return false; }
}

if (!await gatewayUp()) {
	console.log('SKIP verify_gwretry — no gateway on :9002 (build it: cd gateway && cargo build --release)');
	process.exit(0);
}

const s = await open({ name: 'gwretry', signIn: true, connect: true });
const { page } = s;

/// End the session on the GATEWAY without telling the client — what an expiry
/// looks like from inside the page.
const killSession = () => page.evaluate(async () => {
	await window.__realFetch('/api/auth/logout', {
		method: 'POST', credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
	});
});

/// Every request the page made since the trace was last cleared, with the status
/// it came back with. This is what the checks below read: an endpoint that was
/// refused and then served is the wiring working, and it is visible from outside
/// whatever the app believes about itself.
const trace = () => page.evaluate(() => window.__seen.slice());
const clearTrace = () => page.evaluate(() => { window.__seen.length = 0; });

/// The statuses seen for one endpoint, in order. `method` narrows it where an
/// endpoint is used more than one way.
function statuses(tr, path, method) {
	return tr.filter(e => e.url.indexOf(path) !== -1 && (!method || e.method === method))
		.map(e => e.status);
}

/// Refused, then served: the shape a wired caller leaves behind. A single 200
/// is NOT a pass — it would mean the request never met the expiry this test set
/// up, and the check would be proving nothing.
function retried(st) {
	return st.length === 2 && st[0] === 401 && st[1] !== 401;
}

/// Wait until an endpoint has been asked at least `n` times, or give up.
async function until(path, n, ms = 8000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		const tr = await trace();
		if (statuses(tr, path).length >= n) return true;
		await sleep(150);
	}
	return false;
}

try {
	await page.waitForFunction(
		() => !!window.DaimondGateway && !!window.DaimondTools && !!window.DaimondMail
			&& !!window.DaimondPairing && !!window.DaimondPasskey
			&& DaimondGateway.state().authed,
		null, { timeout: 15000 },
	).catch(() => {});
	check('a gateway session exists to begin with',
		await page.evaluate(() => DaimondGateway.state().authed));

	// The instrument. `__realFetch` is kept back so this file can ask the gateway
	// things without its own questions landing in its own trace.
	await page.evaluate(() => {
		window.__gwRetryPage = 'alive';
		window.__seen = [];
		const real = window.fetch;
		window.__realFetch = real;
		window.fetch = async function (u, o) {
			const url    = String((u && u.url) || u || '');
			const method = (o && o.method) || (u && u.method) || 'GET';
			const r = await real.apply(this, arguments);
			if (url.indexOf('/api/') !== -1) window.__seen.push({ url, method, status: r.status });
			return r;
		};
	});
	// Sync is a caller like any other and would mint a session of its own in the
	// middle of a measurement. It is turned off throughout.
	await page.evaluate(() => { try { window.DaimondSync.wakeVia('off'); } catch (e) {} });

	// ── (1) The session really is gone, and the page does not notice ───
	await killSession();
	const unaware = await page.evaluate(async () => {
		const r = await window.__realFetch('/api/tools', {
			credentials: 'same-origin', headers: { 'x-daimond-api': '1' },
		});
		return { status: r.status, authed: DaimondGateway.state().authed };
	});
	check('the session really is gone on the gateway (a bare /api/tools is 401)',
		unaware.status === 401, 'status=' + unaware.status);
	check('and the page still believes it is signed in — which is the bug',
		unaware.authed === true);

	// ── (2) tools.js ───────────────────────────────────────────────────
	await clearTrace();
	await page.evaluate(() => window.DaimondTools.reload());
	await until('/api/tools', 2);
	const tools = await page.evaluate(() => ({
		err:  (document.querySelector('#tools-body .tools-err') || {}).textContent || '',
		page: window.__gwRetryPage,
	}));
	const trTools = statuses(await trace(), '/api/tools');
	check('tools: the refused read is re-authenticated and asked again',
		retried(trTools), 'statuses ' + JSON.stringify(trTools));
	check('tools: and the panel does not tell the user the service is unreachable',
		tools.err === '', tools.err.slice(0, 90));
	check('tools: it was the SAME page throughout — no reload',
		tools.page === 'alive');

	// ── (3) mail.js ────────────────────────────────────────────────────
	await killSession();
	await clearTrace();
	await page.evaluate(() => window.DaimondMail.onOpen());
	await until('/api/mail/accounts', 2);
	await sleep(300);
	const trMail = statuses(await trace(), '/api/mail/accounts');
	check('mail: the refused entitlement read is re-authenticated and asked again',
		retried(trMail), 'statuses ' + JSON.stringify(trMail));
	const mailSaid = await page.evaluate(() =>
		((document.getElementById('mail-state') || {}).textContent || '').replace(/\s+/g, ' ').trim());
	check('mail: and the panel does not say it cannot tell whether Email is unlocked',
		!/cannot tell whether/i.test(mailSaid), mailSaid.slice(0, 90) || '(empty)');

	// ── (4) pairing.js — a real side effect, over a dead session ───────
	// The strongest of the four: the retried request MINTS something, and the
	// proof it worked is that the thing it minted can be spent.
	await killSession();
	await clearTrace();
	const paired = await page.evaluate(async () => {
		try { return { ok: true, res: await window.DaimondPairing.create() }; }
		catch (e) { return { ok: false, err: (e && e.message) || String(e) }; }
	});
	const trPair = statuses(await trace(), '/api/pair', 'POST');
	check('pairing: the refused park is re-authenticated and asked again',
		retried(trPair), 'statuses ' + JSON.stringify(trPair));
	check('pairing: and a code comes back rather than "sign in on this device first"',
		paired.ok === true && !!(paired.res && paired.res.code),
		paired.ok ? 'code ' + (paired.res.code || '').length + ' chars' : paired.err);
	check('pairing: exactly ONE code was minted, not one per attempt',
		trPair.filter(x => x === 200).length === 1, JSON.stringify(trPair));
	// The bundle really is parked: the code is redeemed against the gateway from
	// outside the page. A code that redeems is a request that was actually served.
	const spent = await page.evaluate(async (code) => {
		const r = await window.__realFetch('/api/pair/redeem', {
			method: 'POST', credentials: 'same-origin',
			headers: { 'content-type': 'application/json', 'x-daimond-api': '1' },
			body: JSON.stringify({ code }),
		});
		const j = r.status === 200 ? await r.json() : {};
		return { status: r.status, bundle: !!(j && j.bundle) };
	}, (paired.res && paired.res.code) || '');
	check('pairing: and the code the retry produced really opens a parked bundle',
		spent.status === 200 && spent.bundle === true, JSON.stringify(spent));

	// ── (5) passkey.js — the revocation really lands ───────────────────
	// A planted record, so `remove()` has a handle to drop without a biometric
	// gesture. What is under test is the DELETE reaching the gateway, not the
	// authenticator.
	await page.evaluate(() => {
		localStorage.setItem('daimond-passkey', JSON.stringify({ v: 2, cred: 'AAAA', blob: 'x' }));
	});
	await killSession();
	await clearTrace();
	await page.evaluate(() => window.DaimondPasskey.remove());
	await until('/api/passkey-blob', 2);
	const trBlob = statuses(await trace(), '/api/passkey-blob', 'DELETE');
	check('passkey: the refused revocation is re-authenticated and sent again',
		retried(trBlob), 'statuses ' + JSON.stringify(trBlob));

	// ── (6) One renewal, however many files are refused at once ────────
	await page.evaluate(() => {
		localStorage.setItem('daimond-passkey', JSON.stringify({ v: 2, cred: 'AAAA', blob: 'x' }));
	});
	await killSession();
	await clearTrace();
	await page.evaluate(async () => {
		await Promise.all([
			window.DaimondTools.reload(),
			window.DaimondPairing.create().catch(() => {}),
			window.DaimondPasskey.remove(),
			Promise.resolve(window.DaimondMail.onOpen()),
		]);
	});
	await sleep(800);
	const trAll = await trace();
	const minted = statuses(trAll, '/api/auth/verify', 'POST').length;
	check('four files refused in the same moment mint ONE session between them',
		minted === 1, minted + ' /api/auth/verify calls');
	check('and all four end up on a session the gateway will actually serve',
		retried(statuses(trAll, '/api/tools'))
		&& retried(statuses(trAll, '/api/mail/accounts'))
		&& retried(statuses(trAll, '/api/pair', 'POST'))
		&& retried(statuses(trAll, '/api/passkey-blob', 'DELETE')),
		JSON.stringify({
			tools:   statuses(trAll, '/api/tools'),
			mail:    statuses(trAll, '/api/mail/accounts'),
			pair:    statuses(trAll, '/api/pair', 'POST'),
			passkey: statuses(trAll, '/api/passkey-blob', 'DELETE'),
		}));

	// ── (7) What must NOT be retried ───────────────────────────────────
	// Both of these endpoints are UNauthenticated at the gateway (pair.rs's
	// `redeem_impl`, passkey_blob.rs's `read`), so the real gateway will never
	// answer them 401 and the omission cannot be shown against it. The 401 is
	// therefore stubbed — and a stub is the right instrument here, because what
	// is being proved is that a path was deliberately left out of the retry, not
	// that the retry works.
	//
	// A redeem code is single-use: a blanket wrapper would offer it a second
	// time. And both run on a device MID-ADOPTION, which has no unlocked identity
	// and no account — `reauth()` there does nothing except stamp `state.authed`
	// false on a device whose gateway account does not yet exist.
	// It takes TWO probes, because the two things a wrongly-wired redeem would do
	// are only visible under opposite conditions. With the way back OPEN a
	// renewal succeeds and the code is offered a second time; with it BLOCKED no
	// second offer happens, but the failed renewal stamps `state.authed` false.
	// One probe would leave half of this untested — and passing for the wrong
	// reason, which is the same as not testing it.

	// (7a) The way back is open: a wrongly-wired redeem renews and re-offers.
	const heldOpen = await page.evaluate(async () => {
		const gated = window.fetch;
		let calls = { redeem: 0, renew: 0 };
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			// `/api/account` is the FIRST call `bootstrap()` makes, so it is what
			// says a renewal was attempted at all. `/api/auth/verify` is the last,
			// and would miss a renewal that fell over before it.
			if (url.indexOf('/api/account') !== -1) calls.renew++;
			if (url.indexOf('/api/pair/redeem') !== -1) {
				calls.redeem++;
				return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'stubbed' }),
					{ status: 401, headers: { 'content-type': 'application/json' } }));
			}
			return gated.apply(this, arguments);
		};
		try { await window.DaimondPairing.redeem('ZZZZZZ'); } catch (e) { /* expected */ }
		window.fetch = gated;
		return calls;
	});
	check('a refused redeem does NOT re-authenticate — there is nothing to authenticate with',
		heldOpen.renew === 0, heldOpen.renew + ' renewal attempts');
	check('and the single-use code is offered exactly once, never a second time',
		heldOpen.redeem === 1, heldOpen.redeem + ' redeem attempts');

	// (7b) The way back is blocked: a wrongly-wired redeem signs the device out.
	const heldShut = await page.evaluate(async () => {
		const gated = window.fetch;
		let blob = 0;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/auth/') !== -1 || url.indexOf('/api/account') !== -1) {
				return Promise.reject(new TypeError('blocked for the test'));
			}
			if (url.indexOf('/api/pair/redeem') !== -1
				|| (url.indexOf('/api/passkey-blob') !== -1 && (!o || !o.method || o.method === 'GET'))) {
				blob++;
				return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'stubbed' }),
					{ status: 401, headers: { 'content-type': 'application/json' } }));
			}
			return gated.apply(this, arguments);
		};
		const before = DaimondGateway.state().authed;
		try { await window.DaimondPairing.redeem('ZZZZZZ'); } catch (e) { /* expected */ }
		// The read sits behind `adoptWithPasskey`, which would need an
		// authenticator; the endpoint is reached the same way a stub reaches it.
		try { await window.fetch('/api/passkey-blob?h=' + 'A'.repeat(22), { headers: {} }); }
		catch (e) { /* expected */ }
		window.fetch = gated;
		return { before, after: DaimondGateway.state().authed, blob };
	});
	check('and neither path signs the device out on the way past — nothing to sign out of yet',
		heldShut.before === heldShut.after,
		heldShut.before + ' -> ' + heldShut.after + ', ' + heldShut.blob + ' refusals seen');

	// ── (8) gateway.js's OWN callers keep the round they paid for ──────
	// The file that owns the renewal was the last one still throwing its answer
	// away: `post()`/`get()` called `reauth()` on a 401 and fell straight through
	// to the `throw`, so refreshBalance, refreshLicence, ledger, autoReload and
	// operatorRole each lost their round at the hour mark HAVING JUST PAID for a
	// new session. Two of those losses are worse than a blank — `state.pro` going
	// null HIDES the Pro row, and `operatorRole()` caches its null for the rest of
	// the unlock — so the checks below read the answer as well as the trace.
	// `/api/balance` and `/api/licence` are the two reads `bootstrap()` makes at
	// the end of ITSELF, so the renewal puts a 200 of its own into the trace
	// beside the retry and "refused, then served" no longer tells the two apart.
	// For these two the evidence is the ANSWER — which is the user-visible thing
	// in any case, since `state.pro` coming back null is what hides the Pro row.
	await killSession();
	await clearTrace();
	const lic = await page.evaluate(async () => {
		const pro = await DaimondGateway.refreshLicence();
		return { ret: pro, state: DaimondGateway.state().pro };
	});
	check('licence: a refused read still ANSWERS, so the Pro row is drawn rather than hidden',
		lic.ret !== null && lic.state !== null, JSON.stringify(lic));

	await killSession();
	await clearTrace();
	const bal = await page.evaluate(() => DaimondGateway.refreshBalance());
	check('balance: a refused read still answers with a figure rather than "unknown"',
		bal !== null, String(bal));

	// The ledger is asked by nobody but the Spending view, so its trace is clean.
	await killSession();
	await clearTrace();
	const led = await page.evaluate(() => DaimondGateway.ledger().then(e => e.length));
	const trLed = statuses(await trace(), '/api/ledger');
	check('ledger: the refused read is re-authenticated and asked again',
		retried(trLed), 'statuses ' + JSON.stringify(trLed) + ', ' + led + ' entries');

	// So is the auto-reload read, and it has the same shape of loss: a null here
	// is the settings panel saying there is no card and no standing instruction,
	// on an account that may have both.
	await killSession();
	await clearTrace();
	const ar = await page.evaluate(() => DaimondGateway.autoReload());
	const trAr = statuses(await trace(), '/api/autoreload', 'GET');
	check('auto-reload: the refused read is re-authenticated and asked again',
		retried(trAr), 'statuses ' + JSON.stringify(trAr));
	check('auto-reload: and the settings come back rather than null',
		ar !== null, JSON.stringify(ar).slice(0, 60));

	// The console entry. `operatorRole()` remembers its answer for the whole
	// unlock, so a null taken from a refusal is not re-asked — a signed-in
	// operator's way into the console simply disappeared until they locked and
	// unlocked again. The answer for this account is legitimately null, so what is
	// asserted is that the question REACHED a session that would answer it.
	await page.evaluate(() => DaimondGateway.logout());
	await page.evaluate(() => DaimondGateway.bootstrap());
	await killSession();
	await clearTrace();
	await page.evaluate(() => DaimondGateway.operatorRole());
	const trWho = statuses(await trace(), '/api/admin');
	check('operator role: the refused read is re-authenticated and asked again',
		retried(trWho), 'statuses ' + JSON.stringify(trWho));

	// ── (9) buyPro — a payment path, retried once and only once ────────
	// A raw `fetch` with no 401 handling at all, so an expired session on the Pro
	// button ended the purchase then and there. What the user was shown is the
	// gateway's own "No valid session." — the 401 body carries an `error`
	// (`common::err_response`), so the file's "came back without a URL" fallback
	// is only reached when something between here and the gateway refuses without
	// one. Either way it is a purchase lost to a session that could have been
	// renewed in a round trip.
	//
	// The RETRY is real: the 401 comes from the live gateway and the renewal is
	// the live renewal. Only the SECOND response is stubbed, and only because a
	// served one would create a hosted Stripe session and navigate this page away
	// mid-test. What is under test is that the request went again at all.
	await killSession();
	await clearTrace();
	const pro = await page.evaluate(async () => {
		const gated = window.fetch;
		let asked = 0;
		window.fetch = function (u, o) {
			const url = String((u && u.url) || u || '');
			if (url.indexOf('/api/checkout/pro') !== -1 && ++asked > 1) {
				window.__seen.push({ url, method: 'POST', status: 500 });
				return Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'stubbed' }),
					{ status: 500, headers: { 'content-type': 'application/json' } }));
			}
			return gated.apply(this, arguments);
		};
		let err = '';
		try { await DaimondGateway.buyPro(); } catch (e) { err = (e && e.message) || String(e); }
		window.fetch = gated;
		return { err, asked };
	});
	const trPro = statuses(await trace(), '/api/checkout/pro', 'POST');
	check('buyPro: the refused checkout is re-authenticated and asked again',
		retried(trPro), 'statuses ' + JSON.stringify(trPro));
	check('buyPro: and asked exactly twice, never a third time',
		pro.asked === 2, pro.asked + ' attempts');
	check('buyPro: and the purchase is not ended by the gateway\'s bare refusal',
		!/No valid session|without a URL/i.test(pro.err), pro.err);

	// ── (10) One renewal that threw must not wedge the tab ─────────────
	// `reauthing` was cleared on the way past a VALUE. An attempt that threw left
	// the rejected promise standing, and every later `reauth()` took the
	// single-flight arm and re-threw it — no session again, ever, short of a
	// reload. `bootstrap()` catches broadly, but the lines before its `try` do not:
	// `publicKeyB64url()` is one of them, and it reads localStorage, which throws
	// outright where storage access is denied. That is what is simulated here.
	const wedge = await page.evaluate(async () => {
		const real = DaimondIdentity.publicKeyB64url;
		DaimondIdentity.publicKeyB64url = function () { throw new Error('storage denied'); };
		let first = '';
		try { await DaimondGateway.reauth(); } catch (e) { first = (e && e.message) || String(e); }
		DaimondIdentity.publicKeyB64url = real;
		let second = null, threw = '';
		try { second = await DaimondGateway.reauth(); } catch (e) { threw = (e && e.message) || String(e); }
		return { first, second, threw };
	});
	check('a renewal that THREW does not wedge every renewal after it',
		wedge.threw === '', 'the next reauth() threw: ' + wedge.threw);
	check('and the very next renewal takes a session, on the same page',
		wedge.second === true && await page.evaluate(() => DaimondGateway.state().authed),
		'reauth() returned ' + JSON.stringify(wedge.second));

	// ── (11) sync.js, the fifth copy ───────────────────────────────────
	// Sync held its own version of the retry in a different shape (`once()` plus a
	// 401 arm in `call()`) and now goes through the same one helper. Checked here
	// rather than left to verify_sessionrenew, which passes either way: the engine
	// re-schedules its own rounds, so a pull that was refused and never re-sent is
	// covered by the NEXT pull a second later. That is recovery, but it is not
	// this rule, and a test that cannot tell them apart cannot protect it.
	// The evidence is the ROUND's own outcome as well as the trace, because the
	// renewal raises `daimond:authed` and the engine answers that with a pull of
	// its own — so a second 200 in the trace proves nothing about the first
	// request. `pull()` returns -1 for a round that learned nothing, which is
	// exactly what a refusal that was never re-sent leaves behind.
	await killSession();
	await clearTrace();
	const v = await page.evaluate(() => window.DaimondSync.pull());
	const trSync = statuses(await trace(), '/api/sync', 'GET');
	check('sync: the refused pull is re-authenticated and finishes its OWN round',
		v >= 0 && trSync[0] === 401 && trSync.indexOf(200) > 0,
		'pull() returned ' + v + ', statuses ' + JSON.stringify(trSync));

	// ── (12) Nothing was raised over the app ───────────────────────────
	// Four callers each putting up their own "you are signed out" dialog would be
	// worse than the silence being fixed. The telling is `state.authed` going
	// false, which the Admin drawer's Account row and the sync chip already draw.
	const modals = await page.evaluate(() => [...document.querySelectorAll('.modal, .pair-scrim')]
		.filter(m => getComputedStyle(m).display !== 'none')
		.map(m => (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)));
	check('nothing was raised over the app through the whole recovery',
		modals.length === 0, modals.join(' | '));

	const errs = s.errs.filter(e =>
		!/favicon|ERR_|Failed to load resource|401|402|404|409|413|426|502|Unauthorized|stubbed/.test(e)
		&& !/WebSocket connection to '[^']*\/api\/sync\/ws/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
