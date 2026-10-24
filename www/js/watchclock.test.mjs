/* ============================================================
   Test — the Typst watch's clock (`www/js/watchclock.js`).
   ------------------------------------------------------------
   OPFSLEAK run 4. The watch asked every watched file for its
   stamp once a second, and each answer is a `getFile()`: Chrome
   keeps a region per File it hands out, so a visible tab grew by
   eleven regions in three minutes with nothing being edited.
   The root fix is to stop reading files that have not changed:

     A. polled, a quiet project is asked less and less often:
        1 s, then doubling, never more than 5 s apart.
     B. a change the poll finds puts the gap back to 1 s.
     C. an edit the app made (`edited`) brings the next ask
        within 1 s, however far the gap had backed off.
     D. a hidden tab is neither polled nor observed: no tick at
        all, and no timer left pending.
     E. on coming back the watch takes ONE full reading at once,
        then resumes at 1 s.
     F. a watch started in a hidden tab waits for it to show.
     G. observed, the files are asked on a timer only as a safety
        net, every 5 s and never sooner; the other ticks only LOOK
        (is the panel on screen). Hiding the tab disconnects the
        observer, showing it observes again.

   WHY A SAFETY NET UNDER THE OBSERVER (run 4 follow-up). Does
   `FileSystemObserver` see a write that bypasses `touched()`?
   This tree has two such writers: cloud sync (`cloud.js`
   l.1069, l.1190, `createWritable`) and, not yet built, a
   Worker's `createSyncAccessHandle` (`src/wasm/opfs.rs` l.55,
   TODO wasm-opfs-sync). Neither has been proved reported in
   Chrome's OPFS here, and a sync access handle writes from the
   renderer without the browser process seeing each write, so the
   answer is UNKNOWN. A missed write would leave stale pages with
   nothing to say so; a 5 s full reading bounds that at 5 s for
   one fifth of the old reads (+1 region over 180 s measured
   with the observer; +11 at 1 s).
     H. an observer that is lost falls back to the poll.
     I. `stop` ends everything: no tick, observer disconnected.
     J. typstwatch.js drives the clock: no `setInterval` poll left,
        `visibilitychange` reaches it, a write calls `edited`, and
        a write still nudges a rebuild without waiting on a tick.

   Run:  node www/js/watchclock.test.mjs   [--break]
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const C = await import('./watchclock.js');

const brk = process.argv.includes('--break');
let failures = 0;
function check(name, cond, detail) {
	const line = name + (detail !== undefined && detail !== '' ? ' — ' + detail : '');
	if (cond) { console.log('  ok   ' + line); return; }
	console.log('  FAIL ' + line);
	failures++;
	if (brk) { console.log(`\n${failures} FAILED (stopped on first, --break)`); process.exit(1); }
}

/// Fake timers and a fake page: `advance(ms)` runs every timer due, in order,
/// letting the promises each one starts settle before the next.
function rig(o) {
	o = o || {};
	const R = {
		t: 0, q: [], seq: 0, hidden: !!o.hidden,
		ticks: [],			// { at, files }
		changeAt: new Set(o.changeAt || []),
		observes: 0, unobserves: 0, lost: null,
		canObserve: !!o.observe,
	};
	R.clock = C.watchClock({
		tick: async function (files) {
			R.ticks.push({ at: R.t, files: files });
			return { asked: files, changed: files && R.changeAt.has(R.t) };
		},
		observe: async function (onLost) {
			R.observes++;
			R.lost = onLost;
			if (!R.canObserve) return null;
			return function () { R.unobserves++; };
		},
		hidden: function () { return R.hidden; },
		set: function (fn, ms) { const id = ++R.seq; R.q.push({ id: id, at: R.t + ms, fn: fn }); return id; },
		clear: function (id) { R.q = R.q.filter(function (e) { return e.id !== id; }); },
		now: function () { return R.t; },
	});
	R.settle = async function () { for (let i = 0; i < 20; i++) await Promise.resolve(); };
	R.advance = async function (ms) {
		const end = R.t + ms;
		await R.settle();
		for (;;) {
			R.q.sort(function (a, b) { return a.at - b.at || a.id - b.id; });
			const e = R.q[0];
			if (!e || e.at > end) break;
			R.q.shift();
			R.t = e.at;
			e.fn();
			await R.settle();
		}
		R.t = end;
	};
	R.asks = function () { return R.ticks.filter(function (k) { return k.files; }).map(function (k) { return k.at; }); };
	return R;
}

function gaps(xs) { const g = []; for (let i = 1; i < xs.length; i++) g.push(xs[i] - xs[i - 1]); return g; }

console.log('\n— A: a quiet project is asked less and less often —');
{
	const R = rig();
	R.clock.start();
	await R.advance(40000);
	const a = R.asks();
	const g = gaps(a);
	check('the first reading is taken at once', a[0] === 0, String(a[0]));
	check('the first gap is 1 s', g[0] === 1000, JSON.stringify(g.slice(0, 5)));
	check('the gaps never shrink', g.every(function (x, i) { return i === 0 || x >= g[i - 1]; }), JSON.stringify(g));
	check('no gap is over 5 s', g.every(function (x) { return x <= 5000; }), JSON.stringify(g));
	check('the gap reaches 5 s', g[g.length - 1] === 5000, JSON.stringify(g));
	check('40 s quiet is at most a dozen asks (was 41)', a.length <= 12, String(a.length));
	R.clock.stop();
}

console.log('\n— B: a change found puts the gap back to 1 s —');
{
	const R = rig({ changeAt: [12000] });
	R.clock.start();
	await R.advance(12000);
	const before = R.asks();
	check('an ask lands at 12 s', before[before.length - 1] === 12000, JSON.stringify(before));
	await R.advance(1000);
	const a = R.asks();
	check('the next ask is 1 s later', a[a.length - 1] === 13000, JSON.stringify(a));
	R.clock.stop();
}

console.log('\n— C: an edit brings the next ask within 1 s —');
{
	const R = rig();
	R.clock.start();
	await R.advance(30000);
	const n = R.asks().length;
	R.clock.edited();
	await R.advance(1000);
	const a = R.asks();
	check('one ask within 1 s of the edit', a.length === n + 1 && a[a.length - 1] <= 31000, JSON.stringify(a.slice(-3)));
	await R.advance(1000);
	check('then back-off starts again from 1 s', R.asks()[R.asks().length - 1] === 32000, JSON.stringify(R.asks().slice(-3)));
	R.clock.stop();
}

console.log('\n— D/E: a hidden tab is not polled; showing it reads once, then resumes —');
{
	const R = rig();
	R.clock.start();
	await R.advance(3000);
	R.hidden = true;
	R.clock.visibility();
	const n = R.ticks.length;
	await R.advance(60000);
	check('no tick while hidden', R.ticks.length === n, String(R.ticks.length - n));
	check('no timer pending while hidden', R.q.length === 0, String(R.q.length));
	R.hidden = false;
	R.clock.visibility();
	await R.settle();
	const k = R.ticks[R.ticks.length - 1];
	check('one full reading at once on showing', R.ticks.length === n + 1 && k.files && k.at === R.t, JSON.stringify(k));
	await R.advance(1000);
	const a = R.asks();
	check('then the next ask at 1 s', a[a.length - 1] === R.t, JSON.stringify(a.slice(-3)));
	R.clock.stop();
}

console.log('\n— F: a watch started hidden waits —');
{
	const R = rig({ hidden: true });
	R.clock.start();
	await R.advance(10000);
	check('nothing while hidden', R.ticks.length === 0 && R.observes === 0, R.ticks.length + '/' + R.observes);
	R.hidden = false;
	R.clock.visibility();
	await R.settle();
	check('reads on showing', R.asks().length === 1, JSON.stringify(R.asks()));
	R.clock.stop();
}

console.log('\n— G: observed, the files are asked only every 5 s —');
{
	const R = rig({ observe: true });
	R.clock.start();
	await R.advance(30000);
	const a = R.asks();
	check('a reading at the start, then one each 5 s', a[0] === 0 && gaps(a).every(function (x) { return x === 5000; }) && a.length === 7, JSON.stringify(a));
	check('the panel is still looked at each second', R.ticks.length >= 29, String(R.ticks.length));
	check('observing', R.clock.state().mode === 'observe' && R.observes === 1, JSON.stringify(R.clock.state()));
	R.hidden = true;
	R.clock.visibility();
	check('hiding disconnects the observer', R.unobserves === 1, String(R.unobserves));
	const n = R.ticks.length;
	await R.advance(30000);
	check('and nothing ticks', R.ticks.length === n && R.q.length === 0, String(R.ticks.length - n));
	R.hidden = false;
	R.clock.visibility();
	await R.settle();
	const shown = R.t;
	check('showing reads once and observes again', R.asks()[R.asks().length - 1] === shown && R.observes === 2, R.asks().slice(-2) + '/' + R.observes);
	await R.advance(20000);
	const b = R.asks().filter(function (x) { return x >= shown; });
	check('then still only every 5 s', gaps(b).every(function (x) { return x === 5000; }) && b.length === 5, JSON.stringify(b));
	R.clock.stop();
	check('stop disconnects', R.unobserves === 2, String(R.unobserves));
}

console.log('\n— H: a lost observer falls back to the poll —');
{
	const R = rig({ observe: true });
	R.clock.start();
	await R.advance(5000);
	R.lost();
	await R.advance(3000);
	check('polled again', R.clock.state().mode === 'poll' && R.asks().length >= 2, JSON.stringify(R.asks()));
	R.clock.stop();
}

console.log('\n— I: stop ends everything —');
{
	const R = rig();
	R.clock.start();
	await R.advance(3000);
	R.clock.stop();
	const n = R.ticks.length;
	await R.advance(30000);
	check('no tick after stop', R.ticks.length === n && R.q.length === 0, String(R.ticks.length - n));
	R.clock.visibility();
	await R.settle();
	check('a visibility change after stop does nothing', R.ticks.length === n, String(R.ticks.length - n));
}

console.log('\n— J: typstwatch.js drives the clock —');
{
	const here = path.dirname(url.fileURLToPath(import.meta.url));
	const src = fs.readFileSync(path.join(here, 'typstwatch.js'), 'utf8');
	check('imports watchClock', /import\s*\{[^}]*watchClock[^}]*\}\s*from\s*'\.\/watchclock\.js'/.test(src));
	check('no setInterval poll left', !/setInterval\(/.test(src), (src.match(/setInterval\(/g) || []).length + ' found');
	check('visibilitychange reaches the clock', /visibilitychange[\s\S]{0,400}clock\.visibility\(\)/.test(src));
	const t = src.slice(src.indexOf('async function touched('), src.indexOf('function rebuild('));
	check('a write tells the clock', /clock\.edited\(\)/.test(t));
	check('a write still nudges at once', /nudge\('write', p\)/.test(t));
	check('the observer is feature-detected', /FileSystemObserver/.test(src));
}

console.log(failures ? `\n${failures} FAILED` : '\nall ok');
if (failures) process.exit(1);
