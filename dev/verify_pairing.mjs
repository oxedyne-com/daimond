// verify_pairing.mjs — an identity travels to a second device through a one-time
// gateway code, so the new device becomes the SAME account.
//
// Needs the dev stack up (app :8777, gateway :9002). Device B is simulated by
// wiping the local identity and redeeming the code in the same page.
import { open } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'pair', signIn: true, connect: false });
const { page } = s;

await page.waitForFunction(
	() => !!window.DaimondPairing && !!window.DaimondGateway && DaimondGateway.state().authed,
	null, { timeout: 12000 },
).catch(() => {});

try {
	const p1 = await page.evaluate(() => DaimondIdentity.publicKeyB64url());
	const authed = await page.evaluate(() => DaimondGateway.state().authed);
	check('device A has an identity and an authed session', !!p1 && authed);

	// Device A creates a pairing code.
	const created = await page.evaluate(async () => {
		try { return await DaimondPairing.create(); } catch (e) { return { error: e.message }; }
	});
	check('create() returns a pairing code', !!(created && created.code && created.code.length >= 8),
		created && (created.code || created.error));

	// Device B: wipe the identity, then redeem the code to get it back.
	const redeemed = await page.evaluate(async (code) => {
		DaimondIdentity.reset();
		const goneBefore = DaimondIdentity.exists();
		let ok = false, err = null;
		try { ok = await DaimondPairing.redeem(code); } catch (e) { err = e.message; }
		return { goneBefore, ok, err, existsAfter: DaimondIdentity.exists(), pub: DaimondIdentity.publicKeyB64url() };
	}, created.code);
	check('resetting cleared the local identity (a fresh device)', redeemed.goneBefore === false);
	check('redeem imports the identity — same account on device B',
		redeemed.ok === true && redeemed.existsAfter === true && redeemed.pub === p1,
		redeemed.err || ('pub-match=' + (redeemed.pub === p1)));

	// The code is single-use.
	const second = await page.evaluate(async (code) => {
		try { await DaimondPairing.redeem(code); return 'redeemed-again'; } catch (e) { return e.message; }
	}, created.code);
	check('a pairing code cannot be redeemed twice', /invalid|expired/i.test(second), second);

	// A bad code fails cleanly.
	const bogus = await page.evaluate(async () => {
		try { await DaimondPairing.redeem('not-a-real-code'); return 'redeemed'; } catch (e) { return e.message; }
	});
	check('an unknown code is rejected', /invalid|expired/i.test(bogus), bogus);

	// The UI entry points were injected without any bespoke markup.
	const ui = await page.evaluate(() => ({
		redeem: !!document.getElementById('pair-redeem-entry'),
		link:   !!document.getElementById('pair-link-btn'),
	}));
	check('redeem entry button is present on the identity screen', ui.redeem);
	check('link-a-device button is present in the top actions', ui.link);

	const errs = s.errs.filter(e => !/favicon|ERR_|Failed to load resource|401|404|426|502|Unauthorized/.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('verify_pairing ran without throwing', false, String(e && e.message || e));
} finally {
	await s.close?.().catch?.(() => {});
}

console.log('\n' + (bad.length ? `FAIL: ${bad.length} failed, ${ok.length} passed` : `ok: all ${ok.length} passed`));
process.exit(bad.length ? 1 : 0);
