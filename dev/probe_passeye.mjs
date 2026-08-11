// probe_passeye.mjs — does the typed passphrase run under the reveal eye?
import { open, shot } from './harness.mjs';
const s = await open({ name: 'passeye', signIn: false, connect: false });
const { page } = s;
await page.waitForTimeout(1500);
// The warm skin is the one whose input padding shorthand wiped the reservation,
// so it is the one to measure under.
await page.evaluate(() => document.documentElement.setAttribute('data-skin', 'warm'));
await page.waitForTimeout(300);
const el = await page.$('#id-pass');
if (el) {
	await el.fill('correct-horse-battery-staple-correct-horse-battery-staple');
	await page.waitForTimeout(400);
}
const m = await page.evaluate(() => {
	const inp = document.getElementById('id-pass');
	const eye = document.querySelector('#id-pass-row .pass-eye');
	if (!inp || !eye) return { missing: !inp ? 'input' : 'eye' };
	const ir = inp.getBoundingClientRect(), er = eye.getBoundingClientRect();
	const cs = getComputedStyle(inp);
	// Where the text may actually reach: the content box's right edge.
	const textRight = ir.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
	// And how wide the value really is, measured rather than guessed.
	const c = document.createElement('canvas').getContext('2d');
	c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
	const inkW = c.measureText(inp.value).width;
	return {
		padRight: cs.paddingRight,
		input: { l: Math.round(ir.left), r: Math.round(ir.right), w: Math.round(ir.width) },
		eye: { l: Math.round(er.left), r: Math.round(er.right), w: Math.round(er.width) },
		textRightEdge: Math.round(textRight),
		overlap: +(textRight - er.left).toFixed(1),   // > 0 means the text can run under the eye
		inkWidth: Math.round(inkW),
		scrolls: inp.scrollWidth > inp.clientWidth,
		shown: inp.type,
		// WHICH RULE WINS, asked of the browser rather than inferred from the file.
		rules: (() => {
			const out = [];
			for (const sheet of document.styleSheets) {
				let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
				for (const r of rules) {
					if (!r.selectorText || !r.style || !r.style.padding && !r.style.paddingRight) continue;
					try { if (!inp.matches(r.selectorText)) continue; } catch (e) { continue; }
					out.push(`${(sheet.href || '').split('/').pop()} :: ${r.selectorText} { padding:${r.style.padding || '-'} padding-right:${r.style.paddingRight || '-'} }`);
				}
			}
			return out;
		})(),
	};
});
console.log(JSON.stringify(m, null, 1));
await shot(s, 'passeye');
await s.browser.close();
