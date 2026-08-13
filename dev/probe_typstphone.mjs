// probe_typstphone.mjs — the watched live document inside a phone sheet, at 390 px.
//
// `.tl-scroll` is a nested scroller inside a draggable sheet, which is where
// gestures fight: a drag near the top of the pages can either scroll the document
// or move the sheet, and whichever loses becomes impossible. This drives it with
// REAL TOUCH EVENTS and reports; it asserts nothing. The rule it settles is written
// up beside the sheet's own drag handler in `www/js/mobile.js`.
//
//   eval "$(bash dev/world.sh 13 --env)"
//   node dev/probe_typstphone.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = scratch('pw', 'typstphone');

const MAIN = `#set page(width: 120mm, height: 160mm, margin: 12mm)
#set text(size: 10pt)
#set par(justify: true)
= The book
#lorem(400)
#pagebreak()
#lorem(400)
#pagebreak()
#lorem(400)
`;

// `touch: true` so the sheet's pointer handlers see a finger, and the browser does
// its own gesture arbitration between the nested scroller and its ancestors.
const s = await open({ name: 'typstphone', profile: PROFILE, touch: true });
const { page } = s;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const look = (tag) => page.evaluate((tag) => {
	const q = (sel) => document.querySelector(sel);
	const box = (e) => {
		if (!e) return null;
		const r = e.getBoundingClientRect();
		return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
	};
	const sh = document.getElementById('msheet');
	const sb = document.getElementById('msheet-body');
	const sc = q('#typst-live .tl-scroll');
	const w = window.DaimondTypstWatch ? window.DaimondTypstWatch.state() : null;
	return {
		tag,
		sheetH:   sh ? Math.round(sh.getBoundingClientRect().height) : null,
		guest:    window.DaimondSheet ? window.DaimondSheet.guest() : null,
		liveIn:   !!(sb && q('#typst-live') && sb.contains(q('#typst-live'))),
		sheetBody: sb ? { ...box(sb), scrollH: sb.scrollHeight, scrollTop: sb.scrollTop } : null,
		pageY:    Math.round(window.scrollY),
		scroller: sc ? { ...box(sc), scrollH: sc.scrollHeight, scrollTop: Math.round(sc.scrollTop),
			overscroll: getComputedStyle(sc).overscrollBehaviorY,
			touchAction: getComputedStyle(sc).touchAction } : null,
		ask:      box(document.getElementById('msheet-ask')),
		grab:     box(document.getElementById('msheet-grab')),
		watch:    w ? { mode: w.mode, drawn: w.drawn, pages: w.pages,
			at: w.at ? { page: w.at.page, into: Math.round(w.at.into) } : null } : null,
	};
}, tag);

/// A real touch drag through CDP, so the browser's own scrolling and gesture
/// arbitration decide what moves — not a scripted `scrollTop`.
async function swipe(cdp, fromX, fromY, toX, toY, steps = 14) {
	const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), radiusX: 8, radiusY: 8, force: 1, id: 1 }];
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(fromX, fromY) });
	for (let i = 1; i <= steps; i++) {
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove',
			touchPoints: pt(fromX + (toX - fromX) * i / steps, fromY + (toY - fromY) * i / steps) });
		await sleep(18);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await sleep(500);
}

try {
	await page.waitForTimeout(1200);
	await page.evaluate(async (text) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file('proj/main.typ', text);
	}, MAIN);

	// The harness connects the model through the Admin dialog and leaves it up.
	// It covers the whole screen, so every touch below would land on it and the
	// run would report that nothing moves — which is true, and about the dialog.
	await page.keyboard.press('Escape');
	await sleep(500);
	console.log('modal after Escape: ' + await page.evaluate(() =>
		!!document.querySelector('.modal-card')));

	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(600);

	await page.evaluate(() => window.DaimondDoc.show('proj/main.typ'));
	await sleep(1500);
	console.log(JSON.stringify(await look('the .typ open in the sheet'), null, 1));

	// WHAT IS ON TOP OF ⚙ COMPILE. A button a finger cannot reach is a feature that
	// does not exist on a phone, and `elementFromPoint` is the only thing that says
	// so — the button is visible, sized and enabled either way.
	console.log('compile button: ' + JSON.stringify(await page.evaluate(() => {
		const b = document.querySelector('[data-act="compile"]');
		if (!b) return 'ABSENT';
		const r = b.getBoundingClientRect();
		const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
		const stack = document.elementsFromPoint(cx, cy).slice(0, 4).map(e =>
			e.tagName.toLowerCase() + (e.id ? '#' + e.id : '')
			+ (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''));
		return { at: { x: Math.round(cx), y: Math.round(cy) }, stack, reaches: stack[0] };
	})));

	await page.evaluate(() => document.querySelector('[data-act="compile"]').click());
	for (let i = 0; i < 90; i++) {
		const w = await page.evaluate(() => window.DaimondTypstWatch.state());
		if (w.drawn) break;
		await sleep(500);
	}
	await sleep(1000);
	const drawn = await look('live view drawn on a phone');
	console.log(JSON.stringify(drawn, null, 1));
	await shot(s, 'typstphone-drawn');

	const cdp = await page.context().newCDPSession(page);
	if (drawn.scroller) {
		const sc = drawn.scroller;
		const top = sc.y + 30;              // 30px into the pages: the contested band
		const mid = sc.y + Math.round(sc.h / 2);

		// 1. A drag UP from the middle of the pages. Uncontested: it must scroll.
		await swipe(cdp, 195, mid, 195, mid - 280);
		console.log(JSON.stringify(await look('drag UP from the middle of the pages'), null, 1));

		// 2. A drag DOWN from near the TOP of the pages, with the document already
		//    scrolled. The scroller has somewhere to go, so it should take it.
		await swipe(cdp, 195, top, 195, top + 240);
		console.log(JSON.stringify(await look('drag DOWN near the top, document scrolled'), null, 1));

		// 3. The same drag with the document AT the top: the scroller has nowhere to
		//    go, so the gesture chains — to the sheet, the sheet body, or the page.
		await page.evaluate(() => { document.querySelector('#typst-live .tl-scroll').scrollTop = 0; });
		await sleep(300);
		await swipe(cdp, 195, top, 195, top + 300);
		console.log(JSON.stringify(await look('drag DOWN at the very top of the document'), null, 1));

		// 4. The grabber still does what it is for, and the reader keeps his place
		//    across it: a sheet detent is a resize, and a resize is a repaint at a
		//    new scale rather than a rebuild.
		await swipe(cdp, 195, mid, 195, mid - 400);
		const before = await look('scrolled into the book, before the sheet moves');
		console.log(JSON.stringify(before, null, 1));
		const g = drawn.grab;
		await swipe(cdp, 195, g.y + Math.round(g.h / 2), 195, g.y + Math.round(g.h / 2) + 260);
		console.log(JSON.stringify(await look('drag DOWN on the grabber — a smaller sheet'), null, 1));
		const small = await look('x');
		await swipe(cdp, 195, small.grab.y + Math.round(small.grab.h / 2), 195, 120);
		console.log(JSON.stringify(await look('drag UP on the grabber — full again'), null, 1));

		// 5. A rebuild, while the sheet is up: the whole feature, on a phone.
		await page.evaluate(async () => {
			const m = await import('/pkg/oxedyne_daimond.js');
			await m.write_file('proj/main.typ',
				'#set page(width: 120mm, height: 160mm, margin: 12mm)\n'
				+ '#set text(size: 10pt)\n#set par(justify: true)\n= The book\n'
				+ 'ZULU #lorem(400)\n#pagebreak()\n#lorem(400)\n#pagebreak()\n#lorem(400)\n');
		});
		for (let i = 0; i < 30; i++) {
			const w = await page.evaluate(() => window.DaimondTypstWatch.state());
			if (w.drawn > 1) break;
			await sleep(300);
		}
		await sleep(600);
		console.log(JSON.stringify(await look('after a rebuild, sheet up'), null, 1));
	}
	await cdp.detach();
	await shot(s, 'typstphone-end');
} finally {
	await s.close();
}
