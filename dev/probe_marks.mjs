// probe_marks.mjs — measure the wordmark and the maker's badge where they now sit.
import { open, shot } from './harness.mjs';
const s = await open({ name: 'marks' });
const { page } = s;
await page.waitForTimeout(1200);
const m = await page.evaluate(() => {
	const px = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
		return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: Math.round(r.x), y: Math.round(r.y) }; };
	const badge = document.querySelector('.made-by img');
	// The AI mark inside the plate, in rendered pixels: the right-hand half.
	let ai = null;
	if (badge) {
		const r = badge.getBoundingClientRect();
		ai = { plate: px(badge), markH: +(r.height * 0.74).toFixed(1) };
	}
	return {
		wordmark: px(document.querySelector('.brand-wordmark:not([style*="display: none"])')),
		badgeInTopBar: !!document.querySelector('.top-actions .made-by'),
		badgeFoot: px(document.querySelector('.made-by-foot')),
		badge: ai,
		// Centred? Compare the gaps either side within its container.
		centred: (() => {
			const f = document.querySelector('.made-by-foot');
			const b = document.querySelector('.made-by');
			if (!f || !b) return null;
			const fr = f.getBoundingClientRect(), br = b.getBoundingClientRect();
			return { left: +(br.left - fr.left).toFixed(1), right: +(fr.right - br.right).toFixed(1) };
		})(),
	};
});
console.log(JSON.stringify(m, null, 1));
await shot(s, 'marks-status-foot');
await s.browser.close();
