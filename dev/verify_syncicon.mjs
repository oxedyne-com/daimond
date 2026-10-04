// gateway: none
// verify_syncicon.mjs -- the sync icon beside the debug lens (D-20261004-07).
//
// "Syncing should have a circular arrows icon next to the lens icon that pulsates green
// similarly when syncing, in addition to the sync line in the status section of the
// rail, so that it is visible by default on mobile. It should be inert when not
// syncing, and hover text should show sync status."
//
//   1. PLACE.   The icon is in the top bar, visible with the rail shut, at 390x844 and
//               1440x900, and with the lens on it is the lens's next sibling.
//   2. PULSE.   A forced sync (the gateway's fetch held 2.4s) turns it on with the lens's own
//               animation (name, 1.6s, ease-in-out, infinite); a quick one still shows a whole
//               beat (the minimum on-time); at rest nothing animates and a click does nothing.
//   3. WORDS.   Its hover text is the rail's sync line, at rest and mid-sync, and a touch tap shows
//               the same words in `#sync-tip` and nothing else.
//   4. MOTION.  Without a preference both icons pulse (the lens in its red, the sync icon in green);
//               under `prefers-reduced-motion: reduce` BOTH hold still, each on a static ring in its
//               own colour. The owner asked for the two to pulse alike, so they must stop alike.
//   5. LOCALES. The words are the rail's own keys, present in all eight locales.
//
// Run in worlds 96 and 97 only:  DAIMOND_BROWSER=webkit|chromium, after `eval "$(bash dev/world.sh 96 --up)"`.
// Screenshots go to SYNCICON_SHOTS (default: the notes directory of this unit).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { open, checker, errors, BROWSER } from './harness.mjs';

const SHOTS = process.env.SYNCICON_SHOTS
	|| path.join(os.homedir(), 'usr/code/ai/claude/notes/daimond_syncicon_20261004');
fs.mkdirSync(SHOTS, { recursive: true });
const { ok, bad, check } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HERE = path.dirname(new URL(import.meta.url).pathname);

// 5. The locales, read off disk: the rail's own keys, in every language.
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
const KEYS = ['sync.syncing', 'sync.synced', 'sync.last_synced', 'sync.last_never'];
for (const loc of LOCALES) {
	const src = fs.readFileSync(path.join(HERE, '..', 'www', 'i18n', loc + '.js'), 'utf8');
	const miss = KEYS.filter((k) => !new RegExp("'" + k.replace('.', '\\.') + "'\\s*:").test(src));
	check('locale ' + loc + ' carries the sync words', miss.length === 0, miss.join(' '));
}

let s = null, page = null;

const probe = () => page.evaluate(() => {
	const n = document.getElementById('sync-ico');
	if (!n) return null;
	const r = n.getBoundingClientRect(), cs = getComputedStyle(n);
	const chip = document.getElementById('sync-chip');
	const rest = document.getElementById('sync-rest');
	const shown = !!(chip && chip.style.display !== 'none');
	const line = shown ? chip.querySelector('.stext').textContent : (rest ? rest.textContent : '');
	const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
	return {
		tag: n.tagName, on: n.classList.contains('on'), title: n.title, aria: n.getAttribute('aria-label'),
		anim: cs.animationName, dur: cs.animationDuration, ease: cs.animationTimingFunction, iter: cs.animationIterationCount,
		shadow: cs.boxShadow, color: cs.color, cursor: cs.cursor, tab: n.tabIndex, anims: n.getAnimations().length,
		rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
		vis: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && cs.visibility !== 'hidden' && cs.display !== 'none',
		hitOk: !!hit && (hit === n || n.contains(hit)), line, shown, drawer: document.body.classList.contains('drawer-open'),
	};
});
// The lens, read the same way. `ring` is the box-shadow's colour as 0-255 numbers, whichever way the
// engine writes it (rgba() or color(srgb ...)), so a red ring and a green one can be told apart.
const ringRGB = (sh) => {
	const m = String(sh).match(/(?:rgba?|color)\(([^)]*)\)/);
	if (!m) return null;
	const v = m[1].replace(/srgb|\//g, ' ').split(/[\s,]+/).filter(Boolean).map(Number).slice(0, 3);
	return v.map((x) => (v.every((y) => y <= 1) ? x * 255 : x));
};
const redder = (c) => !!c && c[0] > c[1] + 40 && c[0] > c[2] + 40;
const greener = (c) => !!c && c[1] > c[0] + 40 && c[1] > c[2] + 40;
const probeBoth = () => page.evaluate(() => {
	const one = (n) => { const cs = getComputedStyle(n); return { anim: cs.animationName, shadow: cs.boxShadow, anims: n.getAnimations().length }; };
	return { lens: one(document.querySelector('.ds-indicator')), sync: one(document.getElementById('sync-ico')) };
});
// Holds both rings at the same instant of their cycle (25%, the ring half out) for a picture, or lets them run.
const midPulse = (hold) => page.evaluate((hold) => {
	for (const n of [document.querySelector('.ds-indicator'), document.getElementById('sync-ico')]) {
		for (const a of n.getAnimations()) { if (hold) { a.pause(); a.currentTime = 400; } else a.play(); }
	}
}, hold);
const shot = async (label) => {
	await page.screenshot({ path: path.join(SHOTS, label + '.png') });
	const bar = await page.evaluate(() => { const r = document.querySelector('.topbar').getBoundingClientRect(); return { x: 0, y: 0, width: Math.round(innerWidth), height: Math.round(r.bottom) + 4 }; });
	await page.screenshot({ path: path.join(SHOTS, label + '-bar.png'), clip: bar });
};

// A held gateway: pulls and pushes the engine makes take `delay` ms and find an empty mailbox.
const hold = (delay) => page.evaluate((d) => {
	if (!window.__gw) window.__gw = { state: DaimondGateway.state, gwFetch: DaimondGateway.gwFetch };
	DaimondGateway.state = () => ({ authed: true });
	DaimondGateway.gwFetch = async () => {
		await new Promise((r) => setTimeout(r, d));
		return new Response(JSON.stringify({ version: 0, present: false }), { status: 200, headers: { 'content-type': 'application/json' } });
	};
}, delay);
const release = () => page.evaluate(() => {
	if (window.__gw) { DaimondGateway.state = window.__gw.state; DaimondGateway.gwFetch = window.__gw.gwFetch; window.__gw = null; }
});
const startPull = () => page.evaluate(() => { window.__pulled = DaimondSync.pull().then((v) => { window.__pullDone = true; return v; }); });
const settle = async () => { await page.waitForFunction(() => !document.getElementById('sync-ico').classList.contains('on'), null, { timeout: 8000 }); };

// One session per size, opened AT that size: a phone is a page that loaded at 390, not a desktop page
// squeezed (the squeezed one leaves the rail's panel over the bar). The phone is a touch context and
// taps; the desktop is a mouse and hovers.
const SIZES = [[390, 844, true], [1440, 900, false]];

for (const [w, h, touch] of SIZES) {
	const tag = BROWSER + '-' + w + 'x' + h;
	s = await open({ touch, route: (pg) => pg.setViewportSize({ width: w, height: h }) });
	page = s.page;
	// Lens on, so the icon is measured against it. Off again at the end of the session.
	await page.evaluate(() => DEBUG_SHARE.setEnabled(true));
	await page.waitForSelector('.ds-indicator', { timeout: 5000 });
	await sleep(500);

	// 1. Place.
	const rest = await probe();
	check(tag + ' icon exists and is visible with the rail shut', !!rest && rest.vis && !rest.drawer && rest.hitOk, JSON.stringify(rest && rest.rect));
	const next = await page.evaluate(() => {
		const l = document.querySelector('.ds-indicator'), n = document.getElementById('sync-ico');
		const a = l.getBoundingClientRect(), b = n.getBoundingClientRect();
		return { adj: l.nextElementSibling === n, gap: Math.round(b.left - a.right), same: Math.abs(a.top - b.top) < 3 };
	});
	check(tag + ' directly beside the lens', next.adj && next.gap >= 0 && next.gap <= 14 && next.same, JSON.stringify(next));
	check(tag + ' tap area is 44px or more', await page.evaluate(() => { const n = document.getElementById('sync-ico'); const a = getComputedStyle(n, '::after'); return n.getBoundingClientRect().width + 10 >= 44 && a.position === 'absolute'; }));

	// 2. Inert at rest.
	check(tag + ' at rest it is not pulsing', !rest.on && rest.anim === 'none' && rest.anims === 0, rest.anim);
	check(tag + ' at rest it is quiet and inert (not a button, no pointer, no focus stop)', rest.tag !== 'BUTTON' && rest.cursor === 'default' && rest.tab === -1, rest.tag + ' ' + rest.cursor + ' tab' + rest.tab);
	const before = await page.evaluate(() => ({ pops: document.querySelectorAll('.pop:not([hidden]), .modal-card, [role="dialog"]:not([hidden])').length, body: document.body.className, kids: document.body.children.length, url: location.href }));
	const c = rest.rect;
	await page.mouse.click(c[0] + c[2] / 2, c[1] + c[3] / 2);
	await sleep(300);
	const after = await page.evaluate(() => ({ pops: document.querySelectorAll('.pop:not([hidden]), .modal-card, [role="dialog"]:not([hidden])').length, body: document.body.className, kids: document.body.children.length, url: location.href }));
	check(tag + ' a click at rest does nothing', JSON.stringify(before) === JSON.stringify(after), JSON.stringify(before) + ' -> ' + JSON.stringify(after));

	// 3a. Words at rest equal the rail line.
	check(tag + ' at rest the hover text is the rail line', rest.title === rest.line && rest.aria === rest.title && rest.title.length > 0, JSON.stringify(rest.title) + ' vs ' + JSON.stringify(rest.line));
	await midPulse(true);
	await shot(tag + '-rest');
	await midPulse(false);

	// 2b. A forced, long sync.
	await hold(2400);
	await startPull();
	await sleep(350);
	const a1 = await probe();
	await sleep(400);
	const a2 = await probe();
	const l2 = await probeBoth();
	await sleep(400);
	const l3 = await probeBoth();
	check(tag + ' without a preference the lens pulses too, in its red, and moves', l2.lens.anim === 'pulse-ring' && l2.lens.anims === 1 && l2.lens.shadow !== l3.lens.shadow && redder(ringRGB(l2.lens.shadow)), l2.lens.anim + ' ' + l2.lens.shadow + ' -> ' + l3.lens.shadow);
	check(tag + ' during a sync it pulses', a1.on && a1.anims === 1, 'on=' + a1.on + ' animations=' + a1.anims);
	check(tag + ' it pulses with the lens\'s own animation, in green', await page.evaluate(() => {
		const l = getComputedStyle(document.querySelector('.ds-indicator')), n = getComputedStyle(document.getElementById('sync-ico'));
		return l.animationName === 'pulse-ring' && n.animationName === l.animationName && n.animationDuration === l.animationDuration
			&& n.animationTimingFunction === l.animationTimingFunction && n.animationIterationCount === l.animationIterationCount && l.animationDuration === '1.6s';
	}), a1.anim + ' ' + a1.dur + ' ' + a1.ease);
	check(tag + ' the ring is moving and green', a1.shadow !== a2.shadow && a1.shadow !== 'none' && a2.shadow !== 'none', a1.shadow + ' -> ' + a2.shadow);
	const green = await page.evaluate(() => { const n = document.getElementById('sync-ico'); const ok = getComputedStyle(document.documentElement).getPropertyValue('--ok').trim(); const probe = document.createElement('i'); probe.style.color = ok; document.body.appendChild(probe); const want = getComputedStyle(probe).color; probe.remove(); return { want, got: getComputedStyle(n).color }; });
	check(tag + ' the glyph is the app\'s green (--ok)', green.want === green.got, JSON.stringify(green));
	// 3b. Words mid-sync equal the rail line.
	check(tag + ' mid-sync the hover text is the rail line', a1.shown && a1.title === a1.line && a1.line.length > 0, JSON.stringify(a1.title) + ' vs ' + JSON.stringify(a1.line));
	await sleep(250);
	await midPulse(true);
	await shot(tag + '-pulse');
	await midPulse(false);

	// 3c. A touch tap shows the same words and does nothing else.
	if (touch) {
	const t0 = await page.evaluate(() => ({ pops: document.querySelectorAll('.pop:not([hidden]), .modal-card, [role="dialog"]:not([hidden])').length, body: document.body.className }));
	await page.touchscreen.tap(c[0] + c[2] / 2, c[1] + c[3] / 2);
	await sleep(250);
	const tap = await page.evaluate(() => { const t = document.getElementById('sync-tip'); const n = document.getElementById('sync-ico'); const r = t && t.getBoundingClientRect(); return { text: t && t.textContent, title: n.title, inView: !!r && r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, pops: document.querySelectorAll('.pop:not([hidden]), .modal-card, [role="dialog"]:not([hidden])').length, body: document.body.className, toasts: document.querySelectorAll('.toast, .snackbar').length }; });
	check(tag + ' a tap shows the hover words, on screen, and nothing else', tap.text === tap.title && tap.inView && tap.pops === t0.pops && tap.body === t0.body && tap.toasts === 0, JSON.stringify(tap));
	await shot(tag + '-tap');
	await page.touchscreen.tap(5, h - 5);
	await sleep(200);
	check(tag + ' the tap label goes away', await page.evaluate(() => !document.getElementById('sync-tip')));
	}

	// The sync ends: it stops, after its minimum.
	await settle();
	const done = await probe();
	// A standing state (WebKit here keeps no files: "Files not synced here") adds its reason after the line; the line is first.
	check(tag + ' when the sync ends it returns to rest', !done.on && done.anim === 'none' && done.title.split('\n')[0] === done.line, JSON.stringify(done.title.split('\n')[0]));

	// 2c. A quick sync still shows a whole beat (minimum on-time), then stops.
	await hold(30);
	await startPull();
	await sleep(250);
	const q1 = await probe();
	await sleep(700);
	const q2 = await probe();
	await sleep(1300);
	const q3 = await probe();
	check(tag + ' a quick sync shows one whole beat, not a flicker', q1.on && q2.on && !q3.on, 'on@250=' + q1.on + ' on@950=' + q2.on + ' on@2250=' + q3.on);

	// 4. Reduced motion: both icons hold still, each on a static ring in its own colour.
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await hold(1800);
	await startPull();
	await sleep(400);
	const r1 = await probe();
	const b1 = await probeBoth();
	await sleep(500);
	const b2 = await probeBoth();
	check(tag + ' reduced motion: the sync icon holds still and stays green', r1.on && r1.anim === 'none' && r1.anims === 0 && r1.shadow !== 'none' && r1.color === green.want, r1.anim + ' ' + r1.shadow);
	check(tag + ' reduced motion: the lens holds still too (no animation, none running)', b1.lens.anim === 'none' && b1.lens.anims === 0 && b2.lens.anim === 'none' && b2.lens.anims === 0, b1.lens.anim + ' running=' + b1.lens.anims);
	check(tag + ' reduced motion: each ring is static, drawn, and in its own colour (lens red, sync green)',
		b1.lens.shadow !== 'none' && b1.lens.shadow === b2.lens.shadow && redder(ringRGB(b1.lens.shadow))
		&& b1.sync.shadow !== 'none' && b1.sync.shadow === b2.sync.shadow && greener(ringRGB(b1.sync.shadow)),
		'lens ' + b1.lens.shadow + ' | sync ' + b1.sync.shadow);
	check(tag + ' reduced motion: the two rings are the same size', (b1.lens.shadow.match(/\d+(?:\.\d+)?px/g) || []).slice(-1)[0] === (b1.sync.shadow.match(/\d+(?:\.\d+)?px/g) || []).slice(-1)[0], b1.lens.shadow + ' | ' + b1.sync.shadow);
	await shot(tag + '-reduced');
	await settle();
	await release();
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	await hold(1200);
	await startPull();
	await sleep(400);
	const np = await probeBoth();
	check(tag + ' preference lifted: both icons pulse again', np.lens.anims === 1 && np.sync.anims === 1 && np.lens.anim === 'pulse-ring' && np.sync.anim === 'pulse-ring', JSON.stringify(np));
	await settle();
	await release();
	await page.evaluate(() => DEBUG_SHARE.setEnabled(false));
	check(tag + ' no page errors', errors(s).filter((e) => !/Failed to load resource|\/api\//.test(String(e))).length === 0);
	await s.close();
}
console.log('\n' + BROWSER + ': ' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
