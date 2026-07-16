// verify_qr.mjs — device pairing shows a scannable QR, and a scanned #pair=
// deep link lands on the redeem dialog with the code filled in.
//
// Drives the real wasm QR encoder (fe2o3_graphics::qr, exposed as
// window.DaimondQR) and the real pairing UI against the live gateway, so it
// needs the dev stack up: the app on :8777 and the gateway on :9002.
//
//   1. DaimondQR.matrix(url) returns a square module grid of a sane size.
//   2. "Link another device" draws a QR canvas with real dark modules.
//   3. Opening the app at /#pair=<code> opens the redeem dialog, code prefilled.
import { open, shot, errors, APP } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const until = async (page, fn, arg, ms = 6000) => {
	const t0 = Date.now();
	for (;;) {
		try { if (await page.evaluate(fn, arg)) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await new Promise(r => setTimeout(r, 60));
	}
};

const s = await open({ name: 'qr', signIn: true, connect: true });
const { page } = s;

await page.waitForFunction(
	() => !!window.DaimondQR && !!window.DaimondPairing && window.DaimondGateway
		&& DaimondGateway.state().authed,
	null, { timeout: 12000 }).catch(() => {});

try {
	// ── 1. The wasm encoder. ──────────────────────────────────────────────────
	const grid = await page.evaluate(() => {
		const m = window.DaimondQR.matrix('https://daimond.oxedyne.com/#pair=ABCDEFGH2345');
		const len = m ? m.length : 0;
		const n = Math.round(Math.sqrt(len));
		let dark = 0;
		for (let i = 0; i < len; i++) if (m[i]) dark++;
		return { len, n, square: n * n === len, dark };
	});
	check('DaimondQR.matrix returns a square grid', grid.square && grid.len > 0, `${grid.n}×${grid.n}`);
	check('the QR is a valid version (side ≥ 21, odd)', grid.n >= 21 && grid.n % 2 === 1, `side ${grid.n}`);
	check('the grid has both dark and light modules',
		grid.dark > 0 && grid.dark < grid.len, `${grid.dark}/${grid.len} dark`);

	// ── 2. The Link dialog draws a QR canvas. ─────────────────────────────────
	await page.evaluate(() => window.DaimondPairing.showLink());
	await until(page, () => document.querySelector('.pair-qr'));
	const qr = await page.evaluate(() => {
		const c = document.querySelector('canvas.pair-qr');
		if (!c) return { present: false };
		// Sample the canvas: a real QR has black pixels on a white ground.
		const ctx = c.getContext('2d');
		const data = ctx.getImageData(0, 0, c.width, c.height).data;
		let black = 0, white = 0;
		for (let i = 0; i < data.length; i += 4) {
			if (data[i] < 40 && data[i + 1] < 40 && data[i + 2] < 40) black++;
			else if (data[i] > 215 && data[i + 1] > 215 && data[i + 2] > 215) white++;
		}
		return { present: true, w: c.width, black, white };
	});
	check('the Link dialog renders a QR canvas', qr.present, qr.present ? `${qr.w}px` : 'missing');
	check('the QR canvas has dark modules on a light ground',
		qr.present && qr.black > 100 && qr.white > 100, `black=${qr.black}, white=${qr.white}`);
	await shot(s, 'pair-qr');

	// ── 3. A scanned #pair= deep link opens redeem, prefilled. ────────────────
	// A scan opens the URL in a fresh tab, so test a brand-new page loaded at the
	// deep link, exactly as the other phone's camera would.
	const CODE = 'TESTCODE2345';
	const page2 = await s.browser.newPage();
	await page2.goto(APP + '/#pair=' + CODE, { waitUntil: 'domcontentloaded' });
	const opened = await (async () => {
		const t0 = Date.now();
		for (;;) {
			try { if (await page2.evaluate(() => !!document.querySelector('.pair-input'))) return true; } catch (e) {}
			if (Date.now() - t0 > 8000) return false;
			await new Promise(r => setTimeout(r, 80));
		}
	})();
	const prefilled = opened ? await page2.evaluate(() =>
		(document.querySelector('.pair-input') || {}).value || '') : '';
	check('a #pair= link opens the redeem dialog prefilled', prefilled === CODE, `"${prefilled}"`);
	const hashCleared = await page2.evaluate(() => location.hash);
	check('the one-time code is stripped from the URL', !/pair=/.test(hashCleared), `hash="${hashCleared}"`);
	await page2.close();

	const errs = errors(s).filter(e => !/status of 401/.test(e));
	check('no console errors (other than ambient sign-in 401s)', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
	check('run completed without throwing', false, e.message);
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
await s.close();
process.exit(bad.length ? 1 : 0);
