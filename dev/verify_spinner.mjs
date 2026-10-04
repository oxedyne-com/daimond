// gateway: none
// verify_spinner.mjs -- the turn spinner is three DIAMONDS, wherever it appears, and
// changing the shape moved nothing (owner, 2026-10-04: "instead of the three small
// circles used for the transcript spinner, can we used three small diamonds?").
//
// One class draws every spinner mark, `.chat-spinner-dot`, and six places in
// www/js/daimond.js build it. The check has two halves.
//
//   SOURCE   finds every place that builds the marks and asserts there are exactly
//            these six, each with three, each with the same markup. A seventh site
//            fails here until it is listed, so the browser half cannot quietly miss it.
//   BROWSER  measures the marks in the real app, in the real stylesheet:
//              live     the thread's turn spinner (an ordinary chat), the same in a
//                       daimon's chat face, and the crystal face's `#crystal-spinner`;
//              mounted  the three that need a hand-off peer or a fold to appear
//                       (`.ti-spin` x3 and `.crystal-dots`), built from the source's own
//                       markup string inside the app's own containers.
//            For each: three marks; a diamond clip and no rounding; the diamond is HIT
//            where a diamond is and MISSED at its corners (clip-path moves hit testing, so
//            this is the shape as an engine draws it, not a declaration); the layout boxes
//            and the row's box equal the old circles' to within 0.5px; the rhythm
//            (duration, delays, easing) is unchanged; it animates, or holds still under
//            `prefers-reduced-motion` at the resting opacities.
//
//   DAIMOND_BROWSER=chromium|webkit DAIMOND_PORT=.. DAIMOND_MOCK_PORT=.. \
//   SPINNER_VW=390 SPINNER_VH=844 node dev/verify_spinner.mjs
//   node dev/verify_spinner.mjs --source            # the source half alone, no server
//   SPINNER_SHOTS=<dir> ... node dev/verify_spinner.mjs   # also the before/after PNG (Chromium)
//
// The old circles are emulated with the two declarations the stylesheet used to carry
// (`border-radius: 50%`, no clip-path) injected over the new rule. A route to the old
// stylesheet would be better, and does not intercept under Playwright-WebKit.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, steerDiamond, errors, BROWSER } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPJS = path.join(HERE, '..', 'www', 'js', 'daimond.js');
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' -- ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' -- ' + detail : ''));
	return pass;
};
const done = () => {
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
	process.exit(bad.length ? 1 : 0);
};

// ── SOURCE ──────────────────────────────────────────────────────────
const lines = fs.readFileSync(APPJS, 'utf8').split('\n');
const DOT = '<span class="chat-spinner-dot"></span>';
const MARKUP = DOT + DOT + DOT;
const sites = [];
lines.forEach((ln, i) => {
	if (!/innerHTML\s*=\s*'<span class="chat-spinner-dot">/.test(ln)) return;
	const joined = ln.trim() + (lines[i + 1] || '').trim();
	const markup = (joined.match(/'([^']*)'\s*\+\s*'([^']*)'/) || []).slice(1).join('');
	let wrap = '?';
	for (let k = i; k >= Math.max(0, i - 4); k--) {
		const m = lines[k].match(/className\s*=\s*'([^']+)'/);
		if (m) { wrap = m[1]; break; }
	}
	sites.push({ line: i + 1, wrap, markup });
});
const byWrap = {};
sites.forEach((s) => { byWrap[s.wrap] = (byWrap[s.wrap] || 0) + 1; });
const WANT = { 'ti-spin': 3, 'chat-spinner': 1, 'chat-spinner crystal-spinner': 1, 'crystal-dots': 1 };
check('source: six places build the spinner marks, and they are the six this file knows',
	sites.length === 6 && JSON.stringify(Object.entries(byWrap).sort()) === JSON.stringify(Object.entries(WANT).sort()),
	JSON.stringify(byWrap));
check('source: every site builds exactly three marks, with the same markup',
	sites.length > 0 && sites.every((s) => s.markup === MARKUP));
const css = fs.readFileSync(path.join(HERE, '..', 'www', 'css', 'app.css'), 'utf8');
const rule = (css.match(/^\.chat-spinner-dot \{[^}]*\}/m) || [''])[0];
check('source: the mark is drawn with the app\'s diamond polygon and carries no radius',
	/clip-path:\s*polygon\(50% 0%, 100% 50%, 50% 100%, 0% 50%\)/.test(rule) && !/border-radius/.test(rule), rule.slice(0, 160));
check('source: reduced motion still rests the marks (animation off, scale 1)',
	/prefers-reduced-motion: reduce\) \{\s*\.chat-spinner-dot \{ animation: none; transform: scale\(1\)/.test(css));
if (process.argv.includes('--source')) done();

// ── BROWSER ─────────────────────────────────────────────────────────
const VW = Number(process.env.SPINNER_VW) || 390, VH = Number(process.env.SPINNER_VH) || 844;
const SHOTS = process.env.SPINNER_SHOTS || '';
const tag = `${BROWSER}@${VW}x${VH}`;
const s = await open({ name: 'spinner', defaults: false, browser: BROWSER });
const p = s.page;
const WIDE = async () => { await p.setViewportSize({ width: 1500, height: 950 }); await p.waitForTimeout(900); };
const NARROW = async () => { await p.setViewportSize({ width: VW, height: VH }); await p.waitForTimeout(500); };

/// Everything about one spinner, read in the page. `sel` finds the container (or the row of marks).
const PROBE = (sel) => {
	const root = document.querySelector(sel);
	if (!root) return { found: false };
	const dots = [...root.querySelectorAll('.chat-spinner-dot')];
	const anims = () => document.getAnimations().filter((a) => a.effect && a.effect.target
		&& a.effect.target.classList && a.effect.target.classList.contains('chat-spinner-dot')
		&& root.contains(a.effect.target));
	const nums = (v) => (v.match(/-?[\d.]+(px|%)?/g) || []);
	const pct = (d) => {
		const cs = getComputedStyle(d);
		const w = d.offsetWidth, h = d.offsetHeight;
		return nums(cs.clipPath).map((t, i) => (/px$/.test(t) ? (parseFloat(t) / ((i % 2) ? h : w)) * 100 : parseFloat(t)));
	};
	// Sizes, and the marks' places RELATIVE to their row: a stream still growing the thread above
	// moves every absolute coordinate between two reads, and that is not the layout changing.
	const size = (el) => { const r = el.getBoundingClientRect(); return [r.width, r.height]; };
	const rel = (el, row) => { const r = el.getBoundingClientRect(), o = row.getBoundingClientRect(); return [r.left - o.left, r.top - o.top, r.width, r.height]; };
	const row = root.classList.contains('chat-spinner') || dots[0] === undefined ? root : dots[0].parentElement;
	const lay = () => dots.map((d) => [d.offsetLeft - row.offsetLeft, d.offsetTop - row.offsetTop, d.offsetWidth, d.offsetHeight]);
	if (dots.length) dots[0].scrollIntoView({ block: 'nearest' });
	const out = { found: true, n: dots.length, clip: dots.map(pct), radius: dots.map((d) => getComputedStyle(d).borderTopLeftRadius),
		duration: dots.map((d) => getComputedStyle(d).animationDuration), delay: dots.map((d) => getComputedStyle(d).animationDelay),
		ease: dots.map((d) => getComputedStyle(d).animationTimingFunction), iter: dots.map((d) => getComputedStyle(d).animationIterationCount),
		name: dots.map((d) => getComputedStyle(d).animationName), live: anims().length, opacity: dots.map((d) => getComputedStyle(d).opacity),
		xf: dots.map((d) => getComputedStyle(d).transform) };
	// Animations in flight: sampled by the caller. Here, freeze at 40% (scale 1) for geometry.
	const frozen = anims();
	frozen.forEach((a) => { a.pause(); a.currentTime = 560 + (a.effect.getTiming().delay || 0); });
	out.lay = lay(); out.rowBox = size(row); out.dotBox = dots.map((d) => rel(d, row)); out.rowLay = [row.offsetWidth, row.offsetHeight];
	const hit = (d, fx, fy) => { const r = d.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy) === d; };
	out.hitCentre = dots.map((d) => hit(d, 0.5, 0.5));
	out.hitApex = dots.map((d) => hit(d, 0.5, 0.14));
	out.hitCorner = dots.map((d) => hit(d, 0.18, 0.18) || hit(d, 0.82, 0.18) || hit(d, 0.18, 0.82) || hit(d, 0.82, 0.82));
	frozen.forEach((a) => a.play());
	return out;
};
const OLD_CSS = '.chat-spinner-dot{border-radius:50% !important;clip-path:none !important}';
const near = (a, b) => a.length === b.length && a.every((v, i) => (Array.isArray(v) ? near(v, b[i]) : Math.abs(v - b[i]) <= 0.5));

async function measure(label, sel) {
	await p.waitForSelector(sel, { timeout: 15000 }).catch(() => {});
	await p.waitForTimeout(250);
	const now = await p.evaluate(PROBE, sel);
	if (!check(`${label}: the spinner is on screen`, now.found)) return;
	// Old circles over the same elements, same moment.
	await p.addStyleTag({ content: OLD_CSS }).then(async (h) => {
		await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		now.old = await p.evaluate(PROBE, sel);
		await p.evaluate((el) => el.remove(), h);
	});
	check(`${label}: three marks`, now.n === 3, 'n=' + now.n);
	check(`${label}: each is the diamond polygon, with no rounding`,
		now.clip.every((c) => c.length === 8 && [50, 0, 100, 50, 50, 100, 0, 50].every((v, i) => Math.abs(c[i] - v) < 0.6))
		&& now.radius.every((r) => parseFloat(r) === 0), JSON.stringify(now.clip[0]) + ' r=' + now.radius[0]);
	check(`${label}: the engine HITS a diamond (centre and apex) and MISSES its corners`,
		now.hitCentre.every(Boolean) && now.hitApex.every(Boolean) && now.hitCorner.every((v) => !v),
		JSON.stringify({ c: now.hitCentre, a: now.hitApex, k: now.hitCorner }));
	check(`${label}: the old circles really were circles (the comparison is not against itself)`,
		now.old && now.old.radius.every((r) => parseFloat(r) > 0) && now.old.hitCorner.every(Boolean),
		'the corner probe lands inside a circle and outside a diamond, so it tells them apart');
	check(`${label}: layout footprint of the marks and the row equals the circles' to 0.5px`,
		now.old && near(now.lay, now.old.lay) && near(now.rowLay, now.old.rowLay)
		&& near(now.rowBox, now.old.rowBox) && near(now.dotBox, now.old.dotBox),
		JSON.stringify({ lay: now.lay[0], row: now.rowBox.map((v) => +v.toFixed(1)), dot0: now.dotBox[0].map((v) => +v.toFixed(1)) }));
	check(`${label}: rhythm unchanged (1.4s, delays -0.32/-0.16/0, ease-in-out, infinite, spinner-bounce)`,
		now.duration.every((d) => d === '1.4s') && now.delay.join() === '-0.32s,-0.16s,0s'
		&& now.ease.every((e) => /ease-in-out|cubic-bezier\(0.42, 0, 0.58, 1\)/.test(e)) && now.iter.every((i) => i === 'infinite')
		&& now.name.every((n) => n === 'spinner-bounce'), JSON.stringify([now.duration[0], now.delay, now.ease[0]]));
	// Motion: sample three times; the marks must not stand still.
	const xs = [];
	for (let i = 0; i < 4; i++) { xs.push(await p.evaluate((q) => [...document.querySelectorAll(q + ' .chat-spinner-dot')].map((d) => getComputedStyle(d).transform).join('|'), sel)); await p.waitForTimeout(260); }
	check(`${label}: it animates`, now.live === 3 && new Set(xs).size > 1, `anims=${now.live} samples=${new Set(xs).size}`);
	// Reduced motion: the marks stay, still, at the resting opacities.
	await p.emulateMedia({ reducedMotion: 'reduce' });
	await p.waitForTimeout(200);
	const rm = await p.evaluate(PROBE, sel);
	await p.emulateMedia({ reducedMotion: 'no-preference' });
	check(`${label}: under reduced motion it holds still (no animation, scale 1, opacity .5/.75/1) and is still diamonds`,
		rm.live === 0 && rm.xf.every((x) => x === 'none' || /^matrix\(1, 0, 0, 1, 0, 0\)$/.test(x))
		&& rm.opacity.map(Number).join() === '0.5,0.75,1' && rm.hitCentre.every(Boolean) && rm.hitCorner.every((v) => !v),
		JSON.stringify({ live: rm.live, xf: rm.xf[0], op: rm.opacity }));
}

/// Mount the source's own markup in the app's own container, for a site a hand-off or a fold draws.
const mount = (where, cls, kind) => p.evaluate(([w, c, k, m]) => {
	const host = document.querySelector(w);
	if (!host) return false;
	const d = document.createElement(k);
	d.className = c; d.id = 'spin-mount-' + c.replace(/\W+/g, '-');
	d.innerHTML = m;
	host.appendChild(d);
	return true;
}, [where, cls, kind, MARKUP]);

try {
	console.log(`\n[${tag}] 1. the thread's turn spinner, in an ordinary chat`);
	await newChat(s);
	await NARROW();
	await p.fill('#chat-input', '@long 600');
	await p.click('#chat-send', { force: true });
	await measure('chat transcript', '#chat-output .chat-spinner');
	if (SHOTS && /chrom/i.test(BROWSER)) {
		const cdp = await p.context().newCDPSession(p);
		await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: VW < 800 ? 3 : 2, mobile: false });
		await p.waitForTimeout(500);
		const box = await p.evaluate(() => {
			const live = document.querySelector('#chat-output .chat-spinner');
			const old = live.cloneNode(true);
			old.classList.add('spin-old');
			const st = document.createElement('style');
			st.textContent = '.spin-old .chat-spinner-dot{border-radius:50% !important;clip-path:none !important}';
			document.head.appendChild(st);
			old.querySelector('.chat-spinner-say').textContent = 'Before: three circles';
			live.querySelector('.chat-spinner-say').textContent = 'After: three diamonds';
			live.parentNode.insertBefore(old, live);
			// One shared frame, so the staggered scales match row to row.
			document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.classList
				&& a.effect.target.classList.contains('chat-spinner-dot')).forEach((a) => { a.pause(); a.currentTime = 240; });
			const o = document.getElementById('chat-output').getBoundingClientRect();
			const r = live.getBoundingClientRect();
			const top = Math.max(o.top, r.top - 190);
			return { x: o.left, y: top, width: o.width, height: Math.min(o.bottom, r.bottom + 24) - top };
		});
		fs.mkdirSync(SHOTS, { recursive: true });
		const file = path.join(SHOTS, `spinner_${VW}.png`);
		await p.screenshot({ path: file, clip: box });
		console.log('  shot ' + file);
		await cdp.send('Emulation.clearDeviceMetricsOverride');
	}
	const stop = () => p.evaluate(() => { const b = document.getElementById('chat-send'); if (b && b.classList.contains('stop')) b.click(); });
	await stop();
	await p.waitForSelector('#chat-output .chat-spinner', { state: 'detached', timeout: 20000 }).catch(() => {});

	if (/chrom/i.test(BROWSER)) {
	console.log(`\n[${tag}] 2. a daimon's transcript (a Diamond's chat face), the mounted hand-off footer, then the crystal face`);
	await WIDE();
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', 'Alpha');
	await p.click('.dlg-ok', { force: true });
	await p.waitForTimeout(1800);
	await p.evaluate(() => { const b = [...document.querySelectorAll('.diamond-box')].find((x) => /Alpha/.test(x.textContent || '')); if (b) b.click(); });
	await p.waitForTimeout(900);
	await p.waitForSelector('#dview-chat', { state: 'visible', timeout: 10000 });
	await p.click('#dview-chat', { force: true });
	await p.waitForTimeout(600);
	await NARROW();
	await steerDiamond(s, '@long 600');
	await measure('daimon transcript', '#chat-output .chat-spinner');
	check('hand-off footer markup mounted in the thread', await mount('#chat-output', 'ti-spin', 'span'));
	await measure('hand-off footer (taking back / sent / blocked: three sites, one class, mounted)', '#spin-mount-ti-spin');
	await p.click('#dview-crystal', { force: true });
	await p.waitForTimeout(700);
	const crystalLive = await p.evaluate(() => !!document.getElementById('crystal-spinner'));
	if (crystalLive) await measure('crystal face spinner', '#crystal-spinner');
	else {
		console.log('  note  #crystal-spinner is not drawn by a turn begun on the chat face; mounted instead');
		check('crystal spinner markup mounted in the crystal body', await mount('#crystal-body', 'chat-spinner crystal-spinner', 'div'));
		await measure('crystal face spinner (mounted)', '#spin-mount-chat-spinner-crystal-spinner');
	}
	check('crystal status markup mounted in the status line', await mount('#crystal-status', 'crystal-dots', 'span'));
	await measure('crystal status line (mounted)', '#spin-mount-crystal-dots');
	await p.click('#dview-chat', { force: true }).catch(() => {});
	await stop();
	} else {
		// WebKit has no file store, so no Diamond reaches it (CRF2): there is no daimon face and no
		// crystal face to open. The four remaining sites are mounted in the thread, where the same
		// stylesheet reaches them.
		console.log(`\n[${tag}] 2. WebKit has no Diamonds: the hand-off footer, crystal spinner and crystal status are mounted in the thread`);
		for (const [cls, kind, label] of [['ti-spin', 'span', 'hand-off footer (mounted)'],
				['chat-spinner crystal-spinner', 'div', 'crystal face spinner (mounted)'],
				['crystal-dots', 'span', 'crystal status line (mounted)']]) {
			check(label + ': markup mounted in the thread', await mount('#chat-output', cls, kind));
			await measure(label, '#spin-mount-' + cls.replace(/\W+/g, '-'));
		}
	}
	const errs = errors(s).filter((e) => !/favicon|404|401|402|403|500|502|Bad Gateway|net::ERR|mock: as requested/.test(e));
	check('and none of it throws', errs.length === 0, errs[0] || '');
	await s.close();
} catch (e) {
	check('the run completed', false, String(e && e.stack || e).slice(0, 400));
	await s.close().catch(() => {});
	done();
}
done();
