// probe_emptychip.mjs — the empty chip over the lower mobile viewport.
// Hypothesis: `.left-banner { display:flex }` defeats the `hidden` attribute
// (there is no `[hidden]{display:none}` in the app CSS and no `.left-banner[hidden]`
// guard), so renderLeftBanner's `b.hidden = true` does not hide an empty banner.
// Reports whether a `.left-banner` exists, is VISIBLE, and its text content.

import { open, connectMock } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

let a;
try {
	a = await open({ name: 'chiptester' });
	await a.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(a);
	// Mobile viewport.
	await a.page.setViewportSize({ width: 390, height: 844 });
	// Force the code path that creates the banner element with an EMPTY set — exactly
	// what a sync with nothing stranded does. noteDiamondsLeft([]) clears and, in
	// doing so, creates the (hidden) banner element via renderLeftBanner.
	await a.page.evaluate(() => {
		try { window.DaimondSync.push(); } catch (e) {}
	});
	await a.page.waitForTimeout(1500);
	const info = await a.page.evaluate(() => {
		const b = document.querySelector('.left-banner');
		if (!b) return { present: false };
		const cs = getComputedStyle(b);
		const r = b.getBoundingClientRect();
		return {
			present: true,
			hiddenAttr: b.hidden,
			display: cs.display,
			visibility: cs.visibility,
			text: (b.textContent || '').trim(),
			rows: b.querySelectorAll('.left-banner-row').length,
			visibleBox: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
			rect: { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(window.innerHeight - r.bottom) },
		};
	});
	console.log('left-banner:', JSON.stringify(info, null, 2));
	if (info.present && info.hiddenAttr && info.visibleBox) {
		console.log('  RED: an EMPTY .left-banner is VISIBLE despite hidden=true (' + info.rows + ' rows, text="' + info.text + '")');
	} else if (info.present && info.hiddenAttr && !info.visibleBox) {
		console.log('  GREEN: hidden .left-banner is not shown');
	} else if (!info.present) {
		console.log('  (no .left-banner element at all)');
	} else {
		console.log('  banner present and shown WITH content (hiddenAttr=' + info.hiddenAttr + ')');
	}
} catch (e) {
	console.log('PROBE THREW:', e && (e.stack || e.message || e));
} finally {
	try { await a.close(); } catch (e) {}
}
