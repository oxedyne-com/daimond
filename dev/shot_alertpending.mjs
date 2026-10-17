// gateway: none
// shot_alertpending.mjs — the Pending panel holding one needs:true and one needs:false alert,
// photographed in one engine at one size (ALERT-PENDING, D-20261016-17).
//
//   DAIMOND_BROWSER=webkit node dev/shot_alertpending.mjs <out.png> <width> <height>
//
// Not a verifier: it asserts only that the two tiles are drawn before it shoots, so a shot of an
// empty panel cannot be taken for one of the feature.
import fs from 'node:fs';
import { open, scratch, BROWSER } from './harness.mjs';

const [out, w, h] = process.argv.slice(2);
if (!out || !w || !h) { console.log('usage: shot_alertpending.mjs <out.png> <width> <height>'); process.exit(2); }
const width = Number(w), height = Number(h), phone = width < 700;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROFILE = scratch('pw', 'apshot-' + BROWSER + '-' + width + '-' + process.pid);
process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';

let s = null, code = 0;
try {
	s = await open(Object.assign({ name: 'apshot', profile: PROFILE, connect: false, defaults: false,
		viewport: { width, height } }, phone ? Object.assign({ touch: true, ua: IPHONE }, BROWSER === 'webkit' ? {} : { isMobile: true }) : {}));
	const D = await s.page.evaluate(async () => {
		try { const id = await DaimondCore.diamondApp().create_diamond('Email'); await DaimondCore.loadDiamonds(); return id; }
		catch (e) { return '0ebb17000002'; }	// WebKit has no OPFS, so no Diamond: the tile names "the Diamond"
	});
	await s.page.evaluate((D) => {
		DaimondPendingTool.raise(D, JSON.stringify({ key: 'reply-acme', headline: 'Acme asks for a quote by Friday',
			detail: 'From jo@acme.example, 09:12. It wants an answer before the weekend.', needs: true }));
		DaimondPendingTool.raise(D, JSON.stringify({ key: 'fyi-newsletter', headline: 'Three newsletters filed under Reading',
			detail: 'Nothing to answer. They go from here in 24 hours.', needs: false }));
		DaimondPanels.show('pending');
	}, D);
	await s.page.waitForTimeout(900);
	const n = await s.page.evaluate(() => ({
		needs: document.querySelectorAll('#pending-list .pend-alert.pend-needs').length,
		quiet: document.querySelectorAll('#pending-list .pend-alert.pend-quiet').length,
		count: (document.getElementById('pending-count') || {}).textContent }));
	console.log(BROWSER, width + 'x' + height, JSON.stringify(n));
	if (n.needs !== 1 || n.quiet !== 1) code = 1;
	await s.page.screenshot({ path: out });
	console.log('wrote', out);
} catch (e) {
	console.log('SHOT THREW:', e && (e.stack || e.message || e)); code = 1;
} finally {
	try { await s?.close?.(); } catch (e) { /* closing */ }
	try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* tidy */ }
}
process.exit(code);
