// verify_lens_scrolled — a Lens picture of a scrolled chat shows the chat, not empty bars (UNBLOCK-104).
//
// The owner's Lens picture of his phone's Stack chat (03 Nov 2026, archive shot Lmw02yt2qqc97ab) drew the header
// and the tab bar and nothing between: the chat is a scrolled container, and the viewport rasteriser
// (`www/js/selfshot.js` cloneView) moved each child by the scroll with `translate(..) <its transform>`.
// A child with no transform of its own has the computed transform `none`, and `translate(0px,-Npx) none` is not
// CSS, so the move was dropped: the clone stood unscrolled, and the window showed the transcript's top, whose
// tiles were off screen at the capture and so drawn as their emptied boxes, the bars.
//
// This draws the REAL selfshot.js in Chromium over a chat of 200 tiles scrolled to its foot, and holds:
//   1. the tile the window centre shows live is the one the picture shows there (each tile its own colour);
//   2. that tile's words are drawn (dark text pixels inside it), not an emptied box;
//   3. a chat not scrolled is drawn as before.
//
//   node dev/verify_lens_scrolled.mjs

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import('./pw.mjs');
const SRC  = fs.readFileSync(path.join(HERE, '..', 'www', 'js', 'selfshot.js'), 'utf8');

// fixed: the test's own page, a phone-sized window
const W = 390, H = 780, TILES = 200, TILE_H = 60;

function tileColour(i) { return [40 + (i % 50) * 4, 120, 200 - (i % 50) * 3]; }

const html = `<!doctype html><html><head><style>
html,body{margin:0;height:100%;background:#f4f2f3;font:16px sans-serif}
#head{height:50px;background:#ddd} #foot{position:fixed;bottom:0;left:0;right:0;height:50px;background:#ccc}
#chat{position:absolute;top:50px;bottom:50px;left:0;right:0;overflow-y:auto}
.t{height:${TILE_H}px;box-sizing:border-box;padding:8px 12px;color:#000;font:bold 28px sans-serif}
</style></head><body><div id="head">head</div><div id="chat">${
	Array.from({ length: TILES }, (_, i) => `<div class="t" style="background:rgb(${tileColour(i).join(',')})">tile ${i} WWWW</div>`).join('')
}</div><div id="foot">foot</div></body></html>`;

let fails = 0;
function check(ok, what) { console.log((ok ? 'PASS ' : 'FAIL ') + what); if (!ok) fails++; }

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
	await page.setContent(html);
	await page.addScriptTag({ content: SRC });
	for (const scrolled of [true, false]) {
		const got = await page.evaluate(async ({ scrolled, W, H }) => {
			const c = document.getElementById('chat');
			c.scrollTop = scrolled ? c.scrollHeight : 0;
			const y = Math.round(H / 2);
			const live = document.elementFromPoint(Math.round(W / 2), y);
			const lr = live.getBoundingClientRect();
			const m = await window.DaimondShot.rasterise(document.body, { viewport: true, scale: 1 });
			const img = new Image();
			await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = m.dataUrl; });
			const cv = document.createElement('canvas');
			cv.width = m.w; cv.height = m.h;
			const g = cv.getContext('2d');
			g.drawImage(img, 0, 0);
			const px = Array.from(g.getImageData(W - 60, y, 1, 1).data.slice(0, 3));
			// Dark pixels in the live tile's text band: its words, which an emptied box has none of.
			const band = g.getImageData(8, Math.max(0, Math.round(lr.top) + 8), 200, 36).data;
			let dark = 0;
			for (let i = 0; i < band.length; i += 4) if (band[i] + band[i + 1] + band[i + 2] < 120) dark++;
			return { text: live.textContent, bg: getComputedStyle(live).backgroundColor, px, dark };
		}, { scrolled, W, H });
		const want = got.bg.match(/\d+/g).map(Number);
		const near = want.every((v, i) => Math.abs(v - got.px[i]) <= 3);
		const tag = scrolled ? 'scrolled' : 'unscrolled';
		check(near, `${tag}: the picture shows '${got.text}' where the window does (live ${want}, drawn ${got.px})`);
		check(got.dark > 40, `${tag}: '${got.text}' has its words drawn (${got.dark} dark pixels)`);
	}
} finally {
	await browser.close();
}
console.log(fails ? `verify_lens_scrolled: ${fails} FAILED` : 'verify_lens_scrolled: all passed');
process.exit(fails ? 1 : 0);
