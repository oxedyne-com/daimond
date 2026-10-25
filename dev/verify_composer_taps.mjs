// gateway: none
/* ============================================================
   verify_composer_taps.mjs — NO TAP AREA IN THE COMPOSER ROW
   REACHES DOWN OVER THE MESSAGE BOX (SEAT-LABELS 4, 25 Oct).
   ------------------------------------------------------------
   On a phone the composer row sits 4px above the message box
   (responsive.css, D-20261016-04). Its switches, the provider
   button and "Here", are 30px boxes that each wear an invisible
   44px tap area (skin-daylight.css). Centred on the box, that area
   reached 7px down and took the top 3px of the message box: in
   WebKit the box's tap area read 61x43, and a tap on the box's top
   edge under either button pressed the button instead. The row is
   his picked layout, so the fix is in the tap areas, not the gap.

   In the real page at 390x845 (touch), with a runner named so
   "Here" is drawn beside the provider button, it asserts:
     (a) every pixel along the message box's top three rows, inside
         its rounded corners, is the message box, wherever a composer
         control sits above it;
     (b) the provider button and "Here" each keep a 44x44 tap area.

     eval "$(bash dev/world.sh N --env)"; node dev/verify_composer_taps.mjs
   ============================================================ */
import { open, newChat } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const RID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';	// a runner id the roster names "argonaut"
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass || !detail ? '' : '  (' + detail + ')'));
};

/// What covers the message box's top rows, and each control's tap cross (as verify_consistency's F10 walks it).
const measure = (page) => page.evaluate(() => {
	const ci = document.getElementById('chat-input');
	const c = ci.getBoundingClientRect();
	const name = (e) => e ? (e.id || e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).split(' ')[0] : '')) : 'nothing';
	const cover = {};
	// Inside the rounded corners, which a hit test leaves to whatever is under them.
	const cs = getComputedStyle(ci), rl = parseFloat(cs.borderTopLeftRadius) || 0, rr = parseFloat(cs.borderTopRightRadius) || 0;
	for (let y = Math.floor(c.top); y < Math.floor(c.top) + 3; y++)
		for (let x = Math.ceil(c.left + rl); x < Math.floor(c.right - rr); x++) {
			const h = document.elementFromPoint(x + 0.5, y + 0.5);
			if (h === ci || (h && ci.contains(h))) continue;
			const k = name(h); cover[k] = (cover[k] || 0) + 1;
		}
	const cross = (id) => {
		const el = document.getElementById(id);
		if (!el || !el.offsetParent) return null;
		const r = el.getBoundingClientRect();
		const nx = Math.floor(r.left + r.width / 2), ny = Math.floor(r.top + r.height / 2);
		const on = (x, y) => { const h = document.elementFromPoint(x + 0.5, y + 0.5); return !!h && (h === el || el.contains(h)); };
		const walk = (dx, dy) => { let n = 0; for (let i = 1; i <= 30; i++) { if (!on(nx + dx * i, ny + dy * i)) break; n++; } return n; };
		return [walk(-1, 0) + walk(1, 0) + 1, walk(0, -1) + walk(0, 1) + 1];
	};
	const R = (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(','); };
	return { cover, box: R(ci), src: cross('source-btn'), here: cross('seat-here'),
		srcBox: R(document.getElementById('source-btn')), hereBox: R(document.getElementById('seat-here')) };
});

try {
	const s = await open({ name: 'composertaps', viewport: { width: 390, height: 845 }, touch: true, isMobile: true });
	const page = s.page;
	try {
		await newChat(s);
		await page.evaluate((rid) => {
			const r = DaimondStore.get('daimond-devices', {}) || {};
			const n = Date.now();
			r[rid] = { name: 'argonaut', label: 'argonaut', created: n, namedAt: n, seen: n };
			DaimondStore.put('daimond-devices', r);
			window.dispatchEvent(new Event('daimond:view'));
		}, RID);
		await page.waitForTimeout(400);
		const m = await measure(page);
		check('(a) the message box\'s top three rows are the message box', Object.keys(m.cover).length === 0,
			'box ' + m.box + ', covered by ' + JSON.stringify(m.cover) + '; provider ' + m.srcBox + ', Here ' + m.hereBox);
		check('(b) the provider button keeps a 44x44 tap area', !!m.src && m.src[0] >= 44 && m.src[1] >= 44, JSON.stringify(m.src));
		check('(b) "Here" keeps a 44x44 tap area', !!m.here && m.here[0] >= 44 && m.here[1] >= 44, JSON.stringify(m.here));
	} finally {
		await s.close();
	}
} catch (e) {
	bad.push('crashed: ' + (e && e.message || e));
	console.log('  FAIL crashed — ' + (e && e.stack || e));
}

guardRan(ok.length + bad.length);
console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exitCode = bad.length ? 1 : 0;
