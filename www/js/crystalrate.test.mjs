/* ============================================================
   Test — no crystal page can drive a resize loop (CFP-RATE, UNBLOCK-81).
   ------------------------------------------------------------
   THE BUG. crystal.js onHeight's echo rule stops a page that answers the frame's
   move by the same amount, but a page whose report swings with the frame by a
   different amount (frame+50 below a size, frame-200 above it) has no size it
   settles at: the frame moved every animation frame, the screen flickered, and in
   full screen the tab stopped drawing.

   THE FIX. heightGate: at most `writes` frame-height writes in any `windowMs`;
   past that the frame holds until the page's report has been still for the hold,
   and a page still moving the frame right after a release doubles the hold.

   This drives the REAL www/js/crystal.js's gate on a fake clock, and policy.js's
   reading of the budget from `/api/policy`.   `node www/js/crystalrate.test.mjs`
   ============================================================ */

import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const win = makeWindow({ extra: {} });
loadScript(win, 'crystal.js');
const C = win.DaimondCrystal;
check('the gate is exposed', typeof C.heightGate === 'function');
const N = C.HEIGHT_WRITES, MS = C.HEIGHT_WINDOW_MS;
check('a shipped budget', N >= 1 && MS >= 1, N + ' in ' + MS + ' ms');

/// Run a page against the gate on a fake clock for `span` ms. `report(frame)` is the
/// page's answer to the frame's height; a report follows each frame move by one
/// animation frame, and a held frame does not move, so the page says nothing more.
function run(gate, report, span, floor) {
	let t = 0, frame = floor, min = 0, writes = [], due = -1, timer = 0;
	const set = (px) => { min = px; const to = Math.max(floor, min); const moved = to !== frame; frame = to; writes.push(t); return moved; };
	let next = 0;	// time of the page's next report, or -1
	while (t < span) {
		if (due >= 0 && (next < 0 || due <= next)) {
			t = due; due = -1;
			const px = gate.release(t);
			next = (px !== min && set(px)) ? t + 16 : -1;
			continue;
		}
		if (next < 0) break;
		t = next;
		const px = report(frame);
		if (px === min) { next = -1; continue; }
		const wait = gate.offer(px, t);
		if (wait) { due = t + wait; next = -1; continue; }
		next = set(px) ? t + 16 : -1;
	}
	return writes;
}

// (a) The oscillating page: frame+50 below a size just above the floor, frame-200 at it.
const F = 1100, S = F + 25;
const swing = (fr) => fr < S ? fr + 50 : fr - 200;
const ungated = { offer: () => 0, release: () => 0 };
const loose = run(ungated, swing, 10000, F);
check('without the gate the swinging page loops (the fault)', loose.length > 100, loose.length + ' writes in 10 s');
const w = run(C.heightGate({ writes: N, windowMs: MS }), swing, 10000, F);
const inWin = (ws, a, b) => ws.filter(x => x >= a && x < b).length;
let worst = 0;
for (let a = 0; a < 10000; a += 50) worst = Math.max(worst, inWin(w, a, a + MS));
check('with it, no window holds more than the budget', worst <= N, worst + ' > ' + N);
check('and the swinging page moves the frame ever more rarely', inWin(w, 5000, 10000) <= 2, inWin(w, 5000, 10000) + ' writes in the last 5 s');

// (b) A page that grows with its content: a report every 200 ms, each taller, is
// followed every time and at once.
{
	const g = C.heightGate({ writes: N, windowMs: MS });
	let ok = true;
	for (let i = 0; i < 40; i++) if (g.offer(600 + 20 * i, i * 200) !== 0) ok = false;
	check('a page growing with its content is followed at once, every time', ok);
	// and a page that shrinks, likewise.
	for (let i = 0; i < 10; i++) if (g.offer(1400 - 50 * i, 8000 + i * 300) !== 0) ok = false;
	check('and shrinking too', ok);
}

// (c) The budget: N in a window, then a hold of one window; offers during a hold
// restart it; the release answers the last report.
{
	const g = C.heightGate({ writes: 3, windowMs: 1000 });
	check('three writes go ahead', g.offer(100, 0) === 0 && g.offer(200, 10) === 0 && g.offer(300, 20) === 0);
	check('the fourth in the window is held for one window', g.offer(400, 30) === 1000);
	check('a report during the hold keeps it held', g.offer(500, 500) === 1000 && g.held);
	check('the release takes the last report', g.release(1500) === 500 && !g.held);
	check('moving again within a window of the release doubles the hold', g.offer(600, 1600) === 2000);
	g.release(3600);
	check('and again, doubles again', g.offer(700, 3700) === 4000);
	g.release(7700);
	check('one still window after a release forgets the trips', g.offer(800, 8700) === 0);
}

// (d) The hold never overflows setTimeout (a page tripping for ever).
{
	const g = C.heightGate({ writes: 1, windowMs: 1000 });
	let t = 0, wait = 0;
	g.offer(1, t);
	for (let i = 0; i < 80; i++) { wait = g.offer(2 + i, ++t); t += wait; g.release(t); t += 1; }
	check('the hold is capped at setTimeout\'s limit', wait > 0 && wait <= 2147483647, String(wait));
}

// (e) The budget comes from /api/policy through policy.js.
{
	const pw = makeWindow({ extra: {} });
	pw.localStorage && pw.localStorage.setItem && pw.localStorage.setItem('daimond-net',
		JSON.stringify({ network: 'live', crystalHeight: { writes: 5, windowMs: 3000 } }));
	loadScript(pw, 'policy.js');
	const h = pw.DaimondNet && pw.DaimondNet.crystalHeight();
	check('policy.js carries the operator\'s budget', !!h && h.writes === 5 && h.windowMs === 3000, JSON.stringify(h));
	let res = null;
	pw.fetch = async () => ({ ok: true, json: async () => ({ ok: true, network: 'live',
		crystal_height_writes: 7, crystal_height_window_secs: 2 }) });
	pw.DaimondGateway = { clientApi: () => 1 };
	try { res = await pw.DaimondNet.refresh(); } catch (e) { res = null; }
	const h2 = pw.DaimondNet.crystalHeight();
	check('an answer from /api/policy sets it', !!res && !!h2 && h2.writes === 7 && h2.windowMs === 2000, JSON.stringify(h2));
}

if (failures) { console.log(failures + ' failed'); process.exit(1); }
console.log('crystalrate: all passed');
