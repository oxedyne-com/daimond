// gateway: none
// shot_runnerqr.mjs — PAIR-QR P1: a computer's pairing claimed from its QR link or its code and
// approved with one tap, photographed at each state (UNBLOCK-35).
//
//   DAIMOND_BROWSER=webkit node dev/shot_runnerqr.mjs <outdir> <width> <height>
//
// The gateway's claim door and the passkey are stood in for in the page, so the shots show the
// page's own drawing of each answer. Not a verifier: it asserts only that each state is drawn
// before it shoots, so a shot of an empty screen cannot be taken for one of the feature.
import fs from 'node:fs';
import path from 'node:path';
import { open, scratch, BROWSER } from './harness.mjs';

const [outdir, w, h] = process.argv.slice(2);
if (!outdir || !w || !h) { console.log('usage: shot_runnerqr.mjs <outdir> <width> <height>'); process.exit(2); }
const width = Number(w), height = Number(h), phone = width < 700;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROFILE = scratch('pw', 'rqshot-' + BROWSER + '-' + width + '-' + process.pid);
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
fs.mkdirSync(outdir, { recursive: true });

const PK = 'BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc';	// [7; 32], base64url

let s = null, code = 0;
async function shot(name, sel) {
	await s.page.waitForTimeout(400);
	const ok = await s.page.evaluate((sel) => !!document.querySelector(sel), sel);
	console.log(BROWSER, width + 'x' + height, name, ok ? 'drawn' : 'MISSING ' + sel);
	if (!ok) code = 1;
	const p = path.join(outdir, 'runnerqr_' + name + '_' + BROWSER + '_' + width + '.png');
	await s.page.screenshot({ path: p });
	console.log('wrote', p);
}
async function stub(claim, approve) {
	await s.page.evaluate(([claim, approve]) => {
		window.__claim = claim;
		if (approve.error && window.DaimondI18n) approve.error = DaimondI18n.t(approve.error);
		window.__approve = approve;
		const real = DaimondGateway.gwFetch;
		DaimondGateway.gwFetch = async (url, o) => {
			if (url !== '/api/runner/pair/claim') return real(url, o);
			const c = window.__claim;
			return new Response(JSON.stringify(c.body), { status: c.status, headers: { 'content-type': 'application/json' } });
		};
		window.DaimondPasskey = Object.assign(window.DaimondPasskey || {}, {
			approveRunner: async () => window.__approve,
		});
		const sc = document.querySelector('.pair-scrim');
		if (sc) sc.remove();
	}, [claim, approve]);
}
const OK = { status: 200, body: { ok: true, device: 'dev_argonaut01', pubkey: PK, name: 'argonaut' } };

try {
	s = await open(Object.assign({ name: 'rqshot', profile: PROFILE, connect: false, defaults: false,
		viewport: { width, height } }, phone ? Object.assign({ touch: true, ua: IPHONE }, BROWSER === 'webkit' ? {} : { isMobile: true }) : {}));
	const kc = await s.page.evaluate((pk) => DaimondPairing.runner.commit(pk), PK);

	// 1. The QR link: the approval card, then approved.
	await stub(OK, { ok: true });
	await s.page.evaluate((kc) => { location.hash = '#runner=Ab3dE5gH7jK9mN1p.' + kc; }, kc);
	await shot('1_qr_approve', '.pair-runner-approve');
	await s.page.click('.pair-runner-approve');
	await shot('2_approved', '.pair-scrim');

	// 2. A cancelled passkey keeps the card.
	await stub(OK, { ok: false, error: 'passkey.err_runner_no_assertion' });
	await s.page.evaluate((kc) => { location.hash = '#runner=Ab3dE5gH7jK9mN1p.' + kc; }, kc);
	await s.page.waitForSelector('.pair-runner-approve');
	await s.page.click('.pair-runner-approve');
	await shot('3_cancelled', '.pair-runner-approve');

	// 3. A substituted key, and a contested claim.
	await stub({ status: 200, body: Object.assign({}, OK.body, { pubkey: PK.replace(/^B/, 'C') }) }, { ok: true });
	await s.page.evaluate((kc) => { location.hash = '#runner=Ab3dE5gH7jK9mN1p.' + kc; }, kc);
	await shot('4_key_mismatch', '.pair-err');
	await stub({ status: 410, body: { ok: false } }, { ok: true });
	await s.page.evaluate((kc) => { location.hash = '#runner=Ab3dE5gH7jK9mN1p.' + kc; }, kc);
	await shot('5_contested', '.pair-err');

	// 4. The code path: entry, then the card with its match line.
	await stub(OK, { ok: true });
	await s.page.evaluate(() => DaimondPairing.runner.enterCode());
	await s.page.waitForSelector('.pair-input');
	await s.page.fill('.pair-input', 'k7m-q2p');
	await shot('6_code_entry', '.pair-runner-claim');
	await s.page.click('.pair-runner-claim');
	await shot('7_code_approve', '.pair-runner-approve');
} catch (e) {
	console.log('SHOT THREW:', e && (e.stack || e.message || e)); code = 1;
} finally {
	try { await s?.close?.(); } catch (e) { /* closing */ }
	try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* tidy */ }
}
process.exit(code);
