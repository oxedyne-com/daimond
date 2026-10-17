// The rail's Balance cell (CREDIT-CYL, D-20261015-14) at 1920x961 and 393x793, drawn
// from two stubbed pools -- Daimond credits empty, an OpenRouter key under a day at the
// present rate -- the mock's own figures, so the shot sits beside after-gilgamesh.png.
//
//   node dev/shot_credcyl.mjs            # asserts the cell, writes credcyl-*.png
import { open, shot } from './harness.mjs';

const phone = process.argv.includes('--phone');
const vp = phone ? { width: 393, height: 793 } : { width: 1920, height: 961 };
const s = await open({ name: 'credcyl', viewport: vp, isMobile: phone });
const { page } = s;
const got = await page.evaluate(async () => {
	localStorage.setItem('daimond-credcyl', JSON.stringify({ own: { peak: 50, last: 50 }, credits: { peak: 10, last: 10 } }));
	const gs = DaimondGateway.state.bind(DaimondGateway);
	DaimondGateway.state = () => Object.assign({}, gs(), { authed: true, credits: 0, currency: 'USD' });
	DaimondGovernor.status = () => ({ level: 'ok', rateUsdMin: 1.84 / 60 });
	DaimondModels.providers = () => [{ id: 'openrouter', name: 'OpenRouter', hasKey: true, paid: false, credit: { mode: 'auto', usd: 37.18 } }];
	DaimondI18n.setCurrency('USD');
	await new Promise((r) => setTimeout(r, 300));
	const el = document.getElementById('spend-row');
	return {
		cells: [...el.querySelectorAll('.spend-label')].map((x) => x.textContent),
		cyls: el.querySelectorAll('.spend-cyls svg.cyl').length,
		low: el.querySelectorAll('.spend-cyls svg.low').length,
		runway: (el.querySelector('.spend-runway') || {}).textContent || '',
		titles: [...el.querySelectorAll('.spend-cyls title')].map((x) => x.textContent),
	};
});
console.log(JSON.stringify(got));
const ok = got.cells.join('|') === 'Today|Week|Month|Balance' && got.cyls === 2 && got.low === 1
	&& /OpenRouter key runs out in ~20 h/.test(got.runway);
if (phone) {
	// Sign-in leaves the Settings drawer open on a phone; put it away first.
	await page.keyboard.press('Escape'); await page.waitForTimeout(300);
	await page.evaluate(() => { if (!document.body.classList.contains('drawer-open')) document.getElementById('drawer-btn').click(); });
	await page.waitForTimeout(400);
}
console.log('shot', await shot(s, 'credcyl-' + (phone ? 'phone' : 'desk') + '-' + (process.env.DAIMOND_BROWSER || 'chromium')));
await s.browser?.close?.();
console.log(ok ? 'PASS credcyl' : 'FAIL credcyl');
process.exit(ok ? 0 : 1);
