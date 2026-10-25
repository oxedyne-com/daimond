/* ============================================================
   Test -- a tab below the gateway's API floor updates at the first safe moment.
   ------------------------------------------------------------
   D-20261025-06 (owner, 25 Oct): his gilgamesh tab woke on build ee7eb7af46f0, a page older
   than the runner-offer ABI, and offered him nothing but "Here". The one server-side signal
   that tab's own code already honours is the gateway's API floor: every reply carries
   `x-daimond-min-api`, and a floor above the tab's `CLIENT_API` fires `daimond:stale`, which
   the updater turns into a forced reload -- in the foreground too, at once on an idle page,
   held over a running turn.

   This drives the REAL `gateway.js` (`probeVersion`, `CLIENT_API`) and the REAL `updater.js`
   of two builds in a simulated tab, through `testlift.mjs`'s `source(file, rev)`:

     ee7eb7af46f0 (record 0f6a321d7)  the tab he had: a floor of 3 must reload it at once
                                      when idle, and hold over a running turn until it ends;
     this tree                        speaks API 3, so a floor of 3 leaves it alone, and
                                      when it is held over a turn its banner says why in a
                                      few words.

   Run:  node www/js/stalefloor.test.mjs
   ============================================================ */
import { source, liftFn } from './testlift.mjs';

let failures = 0, passes = 0;
function check(name, cond, info) {
	if (cond) { console.log('  ok   ' + name); passes++; }
	else { console.log('  FAIL ' + name + (info !== undefined ? '  (' + info + ')' : '')); failures++; }
}

const OLD = '0f6a321d7';				// release: record build ee7eb7af46f0
const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 12) { for (let i = 0; i < n; i++) await drain(); }

// A clock the test owns (the method of updater.test.mjs, without the throttle).
function makeClock(t0) {
	let now = t0, seq = 0;
	const timers = new Map();
	return {
		Date: { now: () => now },
		setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; },
		setInterval(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: Math.max(1, ms || 1) }); return id; },
		clearTimeout(id) { timers.delete(id); },
		clearInterval(id) { timers.delete(id); },
		async advance(ms) {
			const target = now + ms;
			for (let guard = 0; guard < 100000; guard++) {
				let pick = null;
				for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
				if (!pick) break;
				now = Math.max(now, pick[1].at);
				if (pick[1].every) pick[1].at = now + pick[1].every; else timers.delete(pick[0]);
				try { pick[1].fn(); } catch (e) { console.log('  timer threw: ' + e); }
				await settle(4);
			}
			now = target;
			await settle(4);
		},
	};
}

function makeNode(tag) {
	return {
		tagName: tag, className: '', id: '', title: '', type: '', textContent: '',
		hidden: false, dataset: {}, _attrs: {}, _on: {}, children: [], style: {},
		setAttribute(k, v) { this._attrs[k] = v; if (k === 'id') this.id = v; },
		getAttribute(k) { return this._attrs[k]; },
		addEventListener(k, fn) { (this._on[k] = this._on[k] || []).push(fn); },
		click() { (this._on.click || []).forEach((f) => f({})); },
		appendChild(c) { this.children.push(c); return c; },
		classList: { toggle() {}, add() {}, remove() {} },
	};
}

/// The gateway's version check of build `rev`, as a function of a reply: `gateway.js`'s own
/// `probeVersion` with its `CLIENT_API` and header name, dispatching on the tab's window.
function probeOf(rev, win) {
	const src = source('gateway.js', rev);
	// `var X = …;` to its semicolon (the declarations carry a trailing comment).
	const decl = (n) => (new RegExp('\\n\\t+(var ' + n + ' = [^;]*;)').exec(src) || [])[1] || '';
	const body = [decl('CLIENT_API'), decl('HDR_MIN_API'), liftFn(src, 'probeVersion')].join('\n');
	if (body.indexOf('function probeVersion') < 0) throw new Error('probeVersion not found at ' + (rev || 'tree'));
	const Event = function (type) { this.type = type; };
	return new Function('window', 'Event', body + '\nreturn { probe: probeVersion, api: CLIENT_API };')(win, Event);
}

/// A gateway reply carrying the floor `min` (the header every reply carries).
const reply = (min) => ({ status: 200, headers: { get: (k) => (k === 'x-daimond-min-api' ? String(min) : null) } });

/// One foreground tab of build `rev`, booted on `mine`, the server now serving `live`.
async function tab(rev, st) {
	const clock = makeClock(1792922864000);
	const local = new Map(), session = new Map();
	const mk = (m) => ({ getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) });
	const chip = makeNode('button');
	chip.id = 'update-chip';
	const body = makeNode('body');
	const on = {};
	const reloads = { n: 0 };
	const stamps = [{ build: 'ee7eb7af46f0' }, { build: 'd02f3d7b0778' }];
	let at = 0;
	const document = {
		readyState: 'complete', hidden: false, body,
		createElement: (tag) => makeNode(tag),
		getElementById: (id) => (id === 'update-chip' ? chip : null),
		addEventListener() {}, querySelector: () => null,
	};
	const win = {
		Date: clock.Date,
		addEventListener: (k, fn) => { (on[k] = on[k] || []).push(fn); },
		dispatchEvent: (ev) => { (on[ev.type] || []).forEach((f) => f(ev)); return true; },
		location: { reload() { reloads.n++; } },
		navigator: {}, localStorage: mk(local), sessionStorage: mk(session),
		DaimondI18n: { t: (k) => k },
		DaimondCore: { busy: () => !!st.busy, composerHasText: () => false, composerHasUnsavedText: () => false },
		DaimondTrail: { note() {}, setBuild() {} },
		DaimondSync: { state: () => ({ quiet: true }) },
		DaimondIdentity: { isUnlocked: () => true, deviceId: () => 'a7b34e2d5181' },
		DaimondLease: { heldBy: () => false },
		fetch() { const s = stamps[Math.min(at++, stamps.length - 1)]; return Promise.resolve({ ok: true, json: () => Promise.resolve(s) }); },
	};
	win.window = win;
	new Function('window', 'document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'with (window) {\n' + source('updater.js', rev) + '\n}')(win, document, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval);
	await settle();
	const gw = probeOf(rev, win);
	return {
		clock, reloads, gw, win,
		idle: () => (on['daimond:idle'] || []).forEach((f) => f({ type: 'daimond:idle' })),
		banner: () => {
			const b = body.children.find((c) => c.className === 'update-banner');
			return (!b || b.hidden) ? null : b.children.map((c) => c.textContent).join('|');
		},
	};
}

async function main() {
	console.log('stalefloor: ee7eb7af46f0, the tab he had, against a floor of 3');
	{
		const t = await tab(OLD, {});
		check('ee7eb7af46f0 speaks API 2', t.gw.api === 2, t.gw.api);
		await t.clock.advance(5000);			// woken a few seconds: inside the boot guard, input just now
		t.gw.probe(reply(2));
		await t.clock.advance(1000);
		check('floor 2 (the gateway today): nothing happens', t.reloads.n === 0, t.reloads.n);
		t.gw.probe(reply(3));
		await t.clock.advance(1000);
		check('floor 3: an idle foreground tab reloads at once', t.reloads.n === 1, t.reloads.n);
	}
	{
		const st = { busy: true };
		const t = await tab(OLD, st);
		await t.clock.advance(5000);
		t.gw.probe(reply(3));
		await t.clock.advance(60000);
		check('floor 3 over a running turn: held, no reload', t.reloads.n === 0, t.reloads.n);
		st.busy = false;
		t.idle();
		await t.clock.advance(1000);
		check('the turn ends: it reloads then', t.reloads.n === 1, t.reloads.n);
	}

	console.log('\nstalefloor: this tree against a floor of 3');
	{
		const t = await tab(undefined, {});
		check('this tree speaks API 3', t.gw.api === 3, t.gw.api);
		await t.clock.advance(5000);
		t.gw.probe(reply(3));
		await t.clock.advance(1000);
		check('floor 3 leaves a tab of this tree alone', t.reloads.n === 0 && t.banner() === null, t.reloads.n + ' ' + t.banner());
		t.gw.probe(reply(4));
		await t.clock.advance(1000);
		check('a floor above it still reloads it at once', t.reloads.n === 1, t.reloads.n);
	}
	{
		const st = { busy: true };
		const t = await tab(undefined, st);
		await t.clock.advance(5000);
		t.gw.probe(reply(4));
		await t.clock.advance(1000);
		const b = t.banner() || '';
		check('held over a turn, the banner says why in a few words', /^update\.stale_short — update\.held_turn\|/.test(b), b);
		st.busy = false;
		t.idle();
		await t.clock.advance(1000);
		check('and it reloads when the turn ends', t.reloads.n === 1, t.reloads.n);
	}

	console.log('\n' + (passes + failures) + ' checks, ' + failures + ' failed');
	process.exit(failures ? 1 : 0);
}

main();
