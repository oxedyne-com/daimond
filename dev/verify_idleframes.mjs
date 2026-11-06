// gateway: none
// verify_idleframes.mjs — an idle page draws nothing on its main thread (TAB-MEM-5D).
//
// THE DEFECT. On 5 Nov 2026 his idle Daimond tab held 88% of a core for hours with no turn and
// no drive running. A 30 s CPU profile put 78% of the main thread in "(program)" and under 9% in
// any script; the timeline said why: 421 BeginMainFrame in 10 s (42 a second, ~18 ms each:
// Paint 6.0 s, PrePaint 2.7 s, CompositingInputs 2.6 s), every one repainting the whole
// 152k-element document. The driver was the debug-share lens's `pulse-ring`, an INFINITE
// animation of `box-shadow`. A paint property cannot run on the compositor, so each frame of
// it is a main-thread frame, and the cost of a frame is the size of the page around it. The
// setup prompt's `astat-pulse` (background + box-shadow, until a model is set) and the sync
// icon's pulse were the same fault. Fixed by drawing each glow once (the icons' on a clipped
// `.pulse-ring` span, the setup row's on a `::before`) and animating only its transform and
// opacity, which the compositor runs on its own.
//
// WHAT IS CHECKED, on a real boot with the lens on (the real `setEnabled`), the sync icon
// pulsing and the setup prompt up (no model is connected):
//   1. the pulses are still there and still moving (the fix must not just switch them off);
//   2. over an idle window the renderer's main thread begins (almost) no frames, where the
//      fault began one per display frame;
//   3. the renderer's CPU over the window stays near idle;
//   4. the renderer's /dev/shm mappings do not grow over the window (TAB-MEM-5D's leak).
//
//   node dev/verify_idleframes.mjs            # IDLE_S (default 20) seconds of idle window
import fs from 'node:fs';
import { open } from './harness.mjs';
import { guardRan } from './verdict.mjs';

const IDLE_S = +(process.env.IDLE_S || 20);
// A frame a second is slack for the odd timer that touches the DOM (a clock tick, a status
// line); the fault was a frame every display frame, 40-60 a second.
const MAX_FRAMES_PER_S = 1;
// Renderer CPU over the window, as a share of one core. The fault was 0.5-0.9 here.
const MAX_CPU_SHARE = 0.15;

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'idleframes', connect: false });
const p = s.page;
await p.waitForTimeout(2500);

// The three standing pulses, by the page's own paths where it has one.
await p.evaluate(() => {
	// The lens's own switch (js/debugshare.js exports it as `window.DEBUG_SHARE`).
	if (window.DEBUG_SHARE && DEBUG_SHARE.setEnabled) DEBUG_SHARE.setEnabled(true);
	// A sync in flight is the icon's `.on` (js/syncicon.js `pulse`); a world with no gateway
	// never syncs, so it is set as syncicon.js sets it.
	const ico = document.getElementById('sync-ico');
	if (ico) ico.classList.add('on');
});
await p.waitForTimeout(1500);

const anims = await p.evaluate(() => document.getAnimations()
	.filter(a => a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity)
	.map(a => {
		const t = a.effect.target, kf = a.effect.getKeyframes();
		const props = [...new Set(kf.flatMap(k => Object.keys(k)))]
			.filter(k => !['offset', 'computedOffset', 'easing', 'composite'].includes(k));
		const pe = a.effect.pseudoElement || '';
		// The icons' ring is a `.pulse-ring` span inside the icon, so name it by the icon that holds it.
		const host = t && !t.id && t.parentElement && t.parentElement.id ? '#' + t.parentElement.id + ' ' : '';
		return { name: a.animationName, props, on: t ? (t.id ? '#' + t.id : host + t.className) + pe : '' };
	}));
console.log('  infinite animations running:', JSON.stringify(anims));
const names = anims.map(a => a.name);
check('the debug-share lens still pulses', names.includes('pulse-ring') && anims.some(a => /ds-indicator/.test(a.on)));
check('the sync icon still pulses while on', anims.some(a => a.name === 'pulse-ring' && /sync-ico/.test(a.on)));
// The setup prompt's row is on the Admin page; it is only checked where it is drawn (a row
// that is not rendered runs no animation on any tree).
const setup = await p.evaluate(() => [...document.querySelectorAll('.astat-pulse')].some(e => e.getClientRects().length));
if (setup) check('the setup prompt still glows', names.includes('astat-pulse'));

// ── The idle window ──────────────────────────────────────────────────────
const cdp = await p.context().newCDPSession(p);
const bcdp = await p.context().browser()?.newBrowserCDPSession?.().catch(() => null);
const procs = async () => {
	if (!bcdp) return [];
	try { return (await bcdp.send('SystemInfo.getProcessInfo')).processInfo; } catch { return []; }
};
const shm = (pid) => { try { return fs.readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n').filter(l => l.includes('/dev/shm')).length; } catch { return null; } };
// The page's renderer is the renderer whose CPU moves with this page; with one page open it is
// the only one that is not the extension's. Taken as the busiest renderer over the window.
const p0 = await procs();
const sh0 = new Map(p0.filter(x => x.type === 'renderer').map(x => [x.id, shm(x.id)]));
const events = [];
cdp.on('Tracing.dataCollected', (e) => { for (const v of e.value) events.push(v); });
const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['cc', 'devtools.timeline'] } });
await p.waitForTimeout(IDLE_S * 1000);
await cdp.send('Tracing.end'); await done;
const p1 = await procs();

const tname = new Map();
for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') tname.set(e.pid + ':' + e.tid, e.args.name);
const bmf = new Map();
// One frame is one event: a complete ('X') or a begin ('B'), never its 'E' as well.
for (const e of events) if (e.name === 'ProxyMain::BeginMainFrame' && (e.ph === 'X' || e.ph === 'B') && tname.get(e.pid + ':' + e.tid) === 'CrRendererMain') bmf.set(e.pid, (bmf.get(e.pid) || 0) + 1);
const frames = Math.max(0, ...bmf.values());
check(`an idle page begins at most ${MAX_FRAMES_PER_S} main-thread frame a second`, frames <= MAX_FRAMES_PER_S * IDLE_S,
	`${frames} BeginMainFrame in ${IDLE_S} s (${(frames / IDLE_S).toFixed(1)}/s)`);

if (p0.length && p1.length) {
	const cpu0 = new Map(p0.map(x => [x.id, x.cpuTime]));
	const rs = p1.filter(x => x.type === 'renderer' && cpu0.has(x.id)).map(x => ({ id: x.id, d: x.cpuTime - cpu0.get(x.id) }));
	rs.sort((a, b) => b.d - a.d);
	const r = rs[0];
	check(`the idle renderer stays under ${MAX_CPU_SHARE * 100}% of a core`, r && r.d / IDLE_S <= MAX_CPU_SHARE,
		r ? `${(100 * r.d / IDLE_S).toFixed(0)}% (${r.d.toFixed(1)} s CPU in ${IDLE_S} s)` : 'no renderer');
	if (r && sh0.get(r.id) != null) {
		const a = sh0.get(r.id), b = shm(r.id);
		check('and its /dev/shm mappings do not grow while idle', b - a <= 2, `${a} -> ${b}`);
	}
} else console.log('  (no browser CDP session: CPU and /dev/shm not read)');

await s.close();
guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
