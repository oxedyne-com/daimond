// probe_focusrestore.mjs — who takes the focus after an admin dialog closes?
//
// `verify_focus` reports that three admin-home dialogs leave the focus on the
// document body. This drives the SAME interaction the verifier does -- its
// `BOX_OF`/`press`/`pressLabel` are copied verbatim below, because an earlier
// version of this probe used its own and passed while the verifier failed -- and
// records every mutation of the panel alongside where the focus was at the time.
//
//   node dev/probe_focusrestore.mjs
import { open, scratch } from './harness.mjs';

// ── The verifier's helpers, copied so the interaction is identical ──
const BOX_OF = ({ rootSel, text }) => {
	const root = rootSel ? document.querySelector(rootSel) : document;
	if (!root) return null;
	const el = text
		? [...root.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === text)
		: root;
	if (!el) return null;
	el.scrollIntoView({ block: 'center', inline: 'center' });
	const r = el.getBoundingClientRect();
	if (!r.width || !r.height) return null;
	return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};
async function press(page, sel) {
	await page.waitForSelector(sel, { timeout: 10000 });
	const box = await page.evaluate(BOX_OF, { rootSel: sel, text: '' });
	if (!box) throw new Error(`${sel} has no box to click`);
	await page.mouse.click(box.x, box.y);
	await page.waitForTimeout(400);
}
async function pressLabel(page, rootSel, text) {
	await page.waitForSelector(rootSel, { timeout: 10000 });
	const box = await page.evaluate(BOX_OF, { rootSel, text });
	if (!box) throw new Error(`no control labelled "${text}" in ${rootSel}`);
	await page.mouse.click(box.x, box.y);
	await page.waitForTimeout(450);
}

const NAME = () => {
	const a = document.activeElement;
	return !a ? '(none)'
		: a.tagName + (a.id ? '#' + a.id : '')
			+ (a.className && typeof a.className === 'string'
				? '.' + a.className.trim().split(/\s+/)[0] : '');
};

const dir = scratch('pw', 'foc-probe-' + Math.random().toString(36).slice(2, 10));
const s = await open({ name: 'focusrestore', connect: false, profile: dir });
const { page } = s;
try {
	await page.waitForTimeout(1500);

	// Watch the panel, and note where the focus is at every mutation of it.
	await page.evaluate(() => {
		window.__trace = [];
		window.__t0 = performance.now();
		const nm = () => {
			const a = document.activeElement;
			return !a ? '(none)' : a.tagName + '.' + String(a.className || '').split(/\s+/)[0];
		};
		const root = document.querySelector('#admin-home');
		if (!root) { window.__trace.push('no #admin-home'); return; }
		new MutationObserver((recs) => {
			window.__trace.push(`+${Math.round(performance.now() - window.__t0)}ms  `
				+ `${recs.length} mutation(s) on #admin-home, focus now ${nm()}`);
		}).observe(root, { childList: true, subtree: true });
		// And a plain sampler, so a focus loss with no mutation is still visible.
		let last = nm();
		setInterval(() => {
			const now = nm();
			if (now !== last) {
				window.__trace.push(`+${Math.round(performance.now() - window.__t0)}ms  `
					+ `focus moved ${last} -> ${now}`);
				last = now;
			}
		}, 40);
	});

	await press(page, '#user-row');
	await pressLabel(page, '#admin-home', 'Change name…');
	console.log('focus once the dialog is up:', await page.evaluate(NAME));

	await press(page, '.modal.dlg .dlg-cancel');
	await page.waitForTimeout(500);          // exactly what the verifier waits
	console.log('focus at the verifier\'s sampling point:', await page.evaluate(NAME));
	await page.waitForTimeout(1500);
	console.log('focus 2s after closing:', await page.evaluate(NAME));

	console.log('\n---- trace ----');
	for (const line of await page.evaluate(() => window.__trace)) console.log('  ' + line);
} finally {
	await s.close();
}
