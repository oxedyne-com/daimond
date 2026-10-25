// gateway: none
/* ============================================================
   verify_seatreason_open.mjs — THE SEAT REASON, TAPPED OPEN, TAKES
   NO ROOM FROM THE CONTROLS BESIDE IT (SEAT-LABELS 3, 25 Oct).
   ------------------------------------------------------------
   A seat reason is a 2-4 word label beside a plain "Here"; a tap
   opens its sentence in place, wrapped (rulings §7, "Seat reasons
   are short"). On a phone the opened sentence took its whole width
   as its flex basis, and the seat switch, which gives way first so
   a long runner name is cut before anything else, shrank to nothing:
   "Here" was drawn under the sentence and the source name was cut
   to "Custom ...". The sentence must wrap into the room the row has
   left, not take room from the controls.

   In the real page at 390x845 (touch) and 1440x900, with a runner
   named but not listening, it taps the label open and asserts:
     (a) the sentence is shown, wrapped;
     (b) "Here" and its switch keep the width they had with the label;
     (c) the source switch keeps the width it had with the label;
     (d) the sentence overlaps neither control;
     (e) a second tap gives the label back.

     eval "$(bash dev/world.sh N --env)"; node dev/verify_seatreason_open.mjs
   ============================================================ */
import { open, newChat } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const RID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';	// a runner id the roster names "argonaut"
const SW = { runner: null, choice: 'here', until: 0, why: 'runner-silent', runnerId: RID };
const VIEWS = [
	{ tag: '390',  w: 390,  h: 845, o: { touch: true, isMobile: true } },
	{ tag: '1440', w: 1440, h: 900, o: {} },
];
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass || !detail ? '' : '  (' + detail + ')'));
};

/// The seat line's boxes, rounded to the pixel.
const measure = (page) => page.evaluate(() => {
	const box = (id) => {
		const e = document.getElementById(id);
		if (!e || e.hidden) return null;
		const r = e.getBoundingClientRect();
		return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width) };
	};
	const why = document.getElementById('seat-reason');
	return { here: box('seat-here'), sw: box('seat-switch'), src: box('source-switch'), why: box('seat-reason'),
		text: why.textContent, open: why.getAttribute('aria-expanded'), wrap: getComputedStyle(why).whiteSpace };
});
const overlap = (a, b) => !!a && !!b && a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

try {
	for (const v of VIEWS) {
		const s = await open({ name: 'seatopen', viewport: { width: v.w, height: v.h }, ...v.o });
		const page = s.page;
		try {
			await newChat(s);
			// The runner is named in the roster, and the switch's decision is this one: everything
			// after it (seatWhyKey, seatReason, renderSeatSwitch, the DOM and CSS) is the page's own.
			await page.evaluate(({ rid, sw }) => {
				const r = DaimondStore.get('daimond-devices', {}) || {};
				const n = Date.now();
				r[rid] = { name: 'argonaut', label: 'argonaut', created: n, namedAt: n, seen: n };
				DaimondStore.put('daimond-devices', r);
				window.DaimondPeer.seatSwitch = () => JSON.parse(JSON.stringify(sw));
				window.dispatchEvent(new Event('daimond:view'));
			}, { rid: RID, sw: SW });
			await page.waitForTimeout(300);
			const shut = await measure(page);
			const tap = () => v.o.touch ? page.tap('#seat-reason') : page.click('#seat-reason');
			await tap();
			await page.waitForTimeout(300);
			const opened = await measure(page);
			check(v.tag + ' (a) the sentence is shown, wrapped', opened.open === 'true' && /listening for chats/.test(opened.text) && opened.wrap === 'normal',
				opened.open + ' ' + opened.wrap + ' "' + opened.text + '"');
			check(v.tag + ' (b) "Here" and its switch keep their width', !!shut.sw && !!opened.sw && opened.sw.w >= shut.sw.w && opened.here.w >= shut.here.w,
				JSON.stringify([shut.sw, opened.sw]));
			check(v.tag + ' (c) the source switch keeps its width', !shut.src || (!!opened.src && opened.src.w >= shut.src.w),
				JSON.stringify([shut.src, opened.src]));
			check(v.tag + ' (d) the sentence overlaps neither control', !overlap(opened.why, opened.here) && !overlap(opened.why, opened.src),
				JSON.stringify(opened));
			await tap();
			await page.waitForTimeout(300);
			const again = await measure(page);
			check(v.tag + ' (e) a second tap gives the label back', again.open === 'false' && again.text === shut.text, '"' + again.text + '"');
		} finally {
			await s.close();
		}
	}
} catch (e) {
	bad.push('crashed: ' + (e && e.message || e));
	console.log('  FAIL crashed — ' + (e && e.stack || e));
}

guardRan(ok.length + bad.length);
console.log('\n' + ok.length + ' ok, ' + bad.length + ' fail');
process.exitCode = bad.length ? 1 : 0;
