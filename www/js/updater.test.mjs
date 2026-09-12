/* ============================================================
   Test — the self-updating tab (www/js/updater.js).
   ------------------------------------------------------------
   Drives the REAL module in a simulated tab: a fake clock the
   test advances by hand, Map-backed session and local storage,
   a fake DOM just wide enough for the chip and the banner, and
   a `fetch` that serves whatever build.json the scenario wants.
   No browser. `location.reload` is counted rather than done.

   The properties under test are the ones a reload can get wrong:

     (a) the same build id does nothing at all;
     (b) a newer id never reloads over a running turn, a half-
         typed prompt, or a sync round in flight -- and keeps
         watching while any of those hold;
     (c) a newer id on a safe, quiet tab counts down in front of
         the user, says so, and then reloads;
     (d) Cancel defers it, and the defer expires;
     (e) the three blanket guards hold: nothing within a minute
         of boot, nothing twice in ten minutes, nothing while
         this tab's own build id is unknown;
     (f) half an hour of never being safe leaves a button, not
         a reload;
     (g) a failed check is silent.

   The browser-side companion is dev/verify_updates.mjs, which
   covers the chip, the forced (stale) path and the loop guard
   against a real page. This file covers the scheduler, which
   needs a clock a test can move.

   Run:  node www/js/updater.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, passes = 0;
function check(name, cond) {
	if (cond) { console.log('  ok   ' + name); passes++; }
	else { console.log('  FAIL ' + name); failures++; }
}

const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 12) { for (let i = 0; i < n; i++) await drain(); }

// ── A clock the test owns ───────────────────────────────────
//
// updater.js reads `Date.now()` and arms timers at 1 s, 10 s and two minutes;
// a test on the real clock would take the best part of an hour. The shim is a
// priority queue keyed on the fake now, and `advance` runs every timer that
// falls inside the window, draining microtasks after each so a `fetch` that a
// timer started has landed before the next one fires.
function makeClock(t0) {
	let now = t0, seq = 0;
	const timers = new Map();
	const api = {
		Date: { now: () => now },
		now: () => now,
		setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; },
		setInterval(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: Math.max(1, ms || 1) }); return id; },
		clearTimeout(id) { timers.delete(id); },
		clearInterval(id) { timers.delete(id); },
		pending() { return timers.size; },
		async advance(ms) {
			const target = now + ms;
			for (let guard = 0; guard < 100000; guard++) {
				let pick = null;
				for (const [id, t] of timers) {
					if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
				}
				if (!pick) break;
				now = pick[1].at;
				if (pick[1].every) pick[1].at = now + pick[1].every; else timers.delete(pick[0]);
				try { pick[1].fn(); } catch (e) { console.log('  timer threw: ' + e); }
				await settle(4);
			}
			now = target;
			await settle(4);
		},
	};
	return api;
}

// ── A fake DOM, only as wide as updater.js reaches ──────────
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

function emitter() {
	const on = {};
	return {
		on,
		addEventListener(k, fn) { (on[k] = on[k] || []).push(fn); },
		fire(k, ev) { (on[k] || []).forEach((f) => f(ev || { type: k })); },
	};
}

/// One simulated tab. `cfg.stamps` is the sequence of build.json bodies the
/// server gives back (the last one repeats); `null` is a 404, `'error'` a
/// network failure. `cfg.store` reuses a previous tab's localStorage Map,
/// which is what surviving a reload means.
function makeTab(cfg) {
	cfg = cfg || {};
	const clock = makeClock(cfg.t0 || 1757000000000);
	const local = cfg.store || new Map();
	const session = new Map();
	const mkStore = (m) => ({
		getItem: (k) => (m.has(k) ? m.get(k) : null),
		setItem: (k, v) => m.set(k, String(v)),
		removeItem: (k) => m.delete(k),
	});

	// The runner exemption reads this device's id straight out of localStorage, so a
	// tab that is to be treated as a runner needs one.
	if (cfg.selfId) local.set('daimond-device-id', cfg.selfId);

	const chip = makeNode('button');
	chip.id = 'update-chip';
	const body = makeNode('body');
	const docEv = emitter();
	const winEv = emitter();

	const document = {
		readyState: 'complete',
		hidden: cfg.hidden !== false,
		body,
		createElement: (tag) => makeNode(tag),
		getElementById: (id) => (id === 'update-chip' ? chip : null),
		addEventListener: docEv.addEventListener,
	};

	let stampAt = 0;
	const served = cfg.stamps || [{ build: 'aaaaaaaaaaaa' }];
	const fetched = [];
	const nextStamp = () => served[Math.min(stampAt++, served.length - 1)];
	const fetchCalls = [];

	const reloads = { n: 0 };
	const events = [];
	const win = {
		Date: clock.Date,
		addEventListener: winEv.addEventListener,
		location: { reload() { reloads.n++; } },
		navigator: {},
		localStorage: mkStore(local),
		sessionStorage: mkStore(session),
		DaimondI18n: { t: (k, v) => k + (v && v.s !== undefined ? ':' + v.s : '') },
		DaimondCore: {
			busy: () => !!cfg.state.busy,
			composerHasText: () => !!cfg.state.typed,
		},
		DaimondSync: { state: () => ({ quiet: cfg.state.quiet !== false }) },
		// The unlock gate, and the two things the runner exemption needs to be sure
		// of. Absent by default, so every scenario that is not about the runner sees
		// the tab it always saw: locked, no posture, no exemption.
		DaimondIdentity: { isUnlocked: () => !!cfg.state.unlocked },
		DaimondRunner:   { on: () => !!cfg.state.runner },
		DEBUG_SHARE: { event: (kind, payload) => events.push({ kind, payload }) },
		fetch(url, opts) {
			fetchCalls.push({ url, opts });
			const s = nextStamp();
			if (s === 'error') return Promise.reject(new Error('offline'));
			if (s === null) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
			return Promise.resolve({ ok: true, json: () => Promise.resolve(s) });
		},
	};
	// Left OFF deliberately in the `noLease` scenario: a runner that cannot find out
	// whether it holds a lease must not be reloaded.
	if (!cfg.noLease) win.DaimondLease = { heldBy: () => !!cfg.state.lease };
	win.window = win;
	cfg.state = cfg.state || {};

	const body_ = readFileSync(join(HERE, 'updater.js'), 'utf8');
	// `with (window)` is the one construct that puts an object in the scope chain,
	// so the module's bare `document`, `fetch`, `localStorage` and `Date` resolve
	// to this tab's. The timer functions are deliberately NOT on the fake window,
	// so they fall through to the named parameters and land on the fake clock.
	const fn = new Function(
		'window', 'document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'with (window) {\n' + body_ + '\n}');
	fn(win, document, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval);

	return {
		win, document, chip, clock, reloads, events, fetchCalls, local, session,
		state: cfg.state,
		U: () => win.DaimondUpdater,
		fireWin: winEv.fire,
		fireDoc: docEv.fire,
		banner: () => body.children.find((c) => c.className === 'update-banner') || null,
		bannerText: () => {
			const b = body.children.find((c) => c.className === 'update-banner');
			if (!b || b.hidden) return null;
			return b.children.map((c) => c.textContent).join('|');
		},
		evKinds: () => events.map((e) => e.kind),
	};
}

// The clock starts past every guard's window, so a scenario that is not about
// the boot or gap guards is not accidentally about them.
const BOOTED = { build: 'aaaaaaaaaaaa', note: 'first' };
const NEWER  = { build: 'bbbbbbbbbbbb', note: 'second' };
const MIN = 60000;

async function boot(cfg) {
	const tab = makeTab(cfg);
	await settle();
	return tab;
}

/// Drive one stamp read by hand and let it land. The scheduler evaluates safety
/// as soon as it is armed, so a tab that is already safe is counting down by the
/// time this returns.
async function learn(tab) {
	tab.U().check();
	await settle();
}

async function main() {
	console.log('updater: an unchanged build id does nothing');
	{
		const tab = await boot({ stamps: [BOOTED], state: {} });
		check('the tab knows its own build', tab.U().booted() === BOOTED.build);
		await tab.clock.advance(20 * MIN);
		check('no update is pending', tab.U().pending() === null);
		check('nothing reloaded', tab.reloads.n === 0);
		check('no banner is shown', tab.bannerText() === null);
		check('an unchanged check says nothing to the feed', tab.evKinds().length === 0);
	}

	console.log('\nupdater: a newer build on a safe, hidden tab counts down and reloads');
	{
		// The check is driven by hand rather than waited for. The poll is jittered on
		// purpose (a fleet must not read the stamp in lockstep), so waiting on it
		// would make every assertion below depend on a random number.
		const tab = await boot({ stamps: [BOOTED, NEWER], state: {} });
		await tab.clock.advance(65000);            // past the boot guard, before the first poll
		await learn(tab);
		check('the newer build is pending', tab.U().pending() === NEWER.build);
		check('the feed heard the ids differ', tab.evKinds().includes('update.check'));
		const ready = tab.events.find((e) => e.kind === 'update' && e.payload.at === 'ready');
		check('the feed heard "ready" with both ids',
			!!ready && ready.payload.live === NEWER.build && ready.payload.mine === BOOTED.build);
		check('a countdown is running', tab.U().countdown() === 20);
		check('the banner names the countdown', /update\.reloading_in/.test(tab.bannerText() || ''));
		check('the banner counts in seconds', /update\.reloading_in:20/.test(tab.bannerText() || ''));
		check('the banner offers Reload now', /update\.reload_now/.test(tab.bannerText() || ''));
		check('the banner offers Cancel', /update\.cancel/.test(tab.bannerText() || ''));
		await tab.clock.advance(19000);
		check('it has not reloaded while the countdown runs', tab.reloads.n === 0);
		check('the countdown is counting down', tab.U().countdown() === 1);
		await tab.clock.advance(2000);
		check('it reloaded once the countdown ran out', tab.reloads.n === 1);
		const gone = tab.events.find((e) => e.kind === 'update' && e.payload.at === 'reload');
		check('the feed heard "reload" just before it went', !!gone && gone.payload.live === NEWER.build);
		check('the once-per-ten-minutes stamp was written before reloading',
			tab.local.has('daimond-soft-at'));
	}

	console.log('\nupdater: a running turn holds it off, and it keeps watching');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], state: { busy: true } });
		await tab.clock.advance(5 * MIN);
		check('the update is pending', tab.U().pending() === NEWER.build);
		check('it did not reload over a running turn', tab.reloads.n === 0);
		check('no countdown started', tab.U().countdown() === 0);
		check('the safety predicate says unsafe', tab.U().safe() === false);
		tab.state.busy = false;
		await tab.clock.advance(11000 + 21000);
		check('it reloads once the turn ends', tab.reloads.n === 1);
	}

	console.log('\nupdater: unsent composer text holds it off');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], state: { typed: true } });
		await tab.clock.advance(5 * MIN);
		check('a half-typed prompt is not safe', tab.U().safe() === false);
		check('it did not reload over unsent text', tab.reloads.n === 0);
		tab.state.typed = false;
		await tab.clock.advance(11000 + 21000);
		check('it reloads once the prompt is gone', tab.reloads.n === 1);
	}

	console.log('\nupdater: a sync round in flight holds it off');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], state: { quiet: false } });
		await tab.clock.advance(5 * MIN);
		check('a sync round in flight is not safe', tab.U().safe() === false);
		check('it did not reload over a push', tab.reloads.n === 0);
		tab.state.quiet = true;
		await tab.clock.advance(11000 + 21000);
		check('it reloads once sync is quiet', tab.reloads.n === 1);
	}

	console.log('\nupdater: a turn that starts DURING the countdown stops it');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], state: {} });
		await tab.clock.advance(65000);
		await learn(tab);
		check('the countdown is running', tab.U().countdown() === 20);
		tab.state.busy = true;
		await tab.clock.advance(25000);
		check('the countdown was abandoned', tab.U().countdown() === 0);
		check('nothing reloaded', tab.reloads.n === 0);
	}

	console.log('\nupdater: Cancel defers for ten minutes, then it goes');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], state: {} });
		await tab.clock.advance(65000);
		await learn(tab);
		const b = tab.banner();
		check('the banner exists to cancel', !!b);
		b.children[2].click();                     // the third child is the ×/Cancel button
		check('the countdown stopped', tab.U().countdown() === 0);
		await tab.clock.advance(9 * MIN);
		check('nothing reloaded during the defer', tab.reloads.n === 0);
		await tab.clock.advance(2 * MIN + 25000);
		check('it reloads once the defer expires', tab.reloads.n === 1);
	}

	console.log('\nupdater: the three blanket guards');
	{
		// Boot guard: the newer build is known within the first minute and must wait.
		const tab = await boot({ stamps: [BOOTED, NEWER], state: {} });
		tab.U().noteLiveBuild(NEWER.build);
		await settle();
		check('the wake-channel seam sets the pending build', tab.U().pending() === NEWER.build);
		await tab.clock.advance(45000);
		check('nothing reloads inside the first minute', tab.reloads.n === 0);
		await tab.clock.advance(45000);
		check('it reloads once the tab is past a minute old', tab.reloads.n === 1);
	}
	{
		// Gap guard: localStorage says this device reloaded itself two minutes ago.
		const store = new Map([['daimond-soft-at', String(1757000000000 - 2 * MIN)]]);
		const tab = await boot({ stamps: [BOOTED, NEWER], state: {}, store });
		await tab.clock.advance(7 * MIN);
		check('a reload eight minutes ago blocks another', tab.reloads.n === 0);
		await tab.clock.advance(5 * MIN);
		check('it reloads once ten minutes have passed', tab.reloads.n === 1);
	}
	{
		// The tab's own build id was never readable, so there is no "newer" to be sure of.
		const tab = await boot({ stamps: [null, NEWER], state: {} });
		check('the build id is unknown', tab.U().booted() === null);
		await tab.clock.advance(20 * MIN);
		check('a tab that does not know its own build never reloads', tab.reloads.n === 0);
	}

	console.log('\nupdater: half an hour of never being safe leaves a button, not a reload');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], state: { busy: true } });
		await tab.clock.advance(35 * MIN);
		check('it gave up watching', tab.U().gaveUp() === true);
		check('it still never reloaded', tab.reloads.n === 0);
		check('the banner offers a manual Reload',
			/update\.reload\|/.test(tab.bannerText() || ''));
		tab.state.busy = false;
		await tab.clock.advance(5 * MIN);
		check('having given up, it does not resume on its own', tab.reloads.n === 0);
		const b = tab.banner();
		b.children[1].click();                     // the Reload button
		await settle();
		check('the manual button reloads at once', tab.reloads.n === 1);
	}

	console.log('\nupdater: a failed check is silent');
	{
		const tab = await boot({ stamps: ['error'], state: {} });
		check('no build id was learned', tab.U().booted() === null);
		await tab.clock.advance(10 * MIN);
		check('nothing reloaded', tab.reloads.n === 0);
		check('no banner appeared', tab.bannerText() === null);
		check('the chip is hidden with no stamp', tab.chip.hidden === true);
	}
	{
		const tab = await boot({ stamps: [BOOTED, 'error'], state: {} });
		await tab.clock.advance(5 * MIN);
		check('a failed re-check reports itself to the feed once it is on',
			tab.events.some((e) => e.kind === 'update.check' && e.payload.status === 'fail'));
		check('a failed re-check reloads nothing', tab.reloads.n === 0);
	}

	console.log('\nupdater: the seam refuses rubbish');
	{
		const tab = await boot({ stamps: [BOOTED], state: {} });
		tab.U().noteLiveBuild('');
		tab.U().noteLiveBuild('a b');
		tab.U().noteLiveBuild(null);
		await settle();
		check('an empty, spaced or absent id is not an update', tab.U().pending() === null);
	}

	console.log('\nupdater: becoming visible, and coming back online, both check at once');
	{
		const tab = await boot({ stamps: [BOOTED, BOOTED, NEWER], state: {} });
		const n0 = tab.fetchCalls.length;
		tab.document.hidden = false;
		tab.fireDoc('visibilitychange');
		await settle();
		check('being shown re-reads the stamp', tab.fetchCalls.length === n0 + 1);
		check('the stamp is read past every cache',
			tab.fetchCalls[n0].opts && tab.fetchCalls[n0].opts.cache === 'no-store');
		const n1 = tab.fetchCalls.length;
		tab.fireWin('online');
		await settle();
		check('coming back online re-reads the stamp', tab.fetchCalls.length === n1 + 1);
		check('and the newer build it found is pending', tab.U().pending() === NEWER.build);
	}

	console.log('\nupdater: an UNLOCKED tab is still left alone unless it is an idle runner');
	{
		// The condition that was always here: unlocked means no silent reload, because
		// the tab comes back at the unlock gate in front of somebody who did not ask.
		const tab = await boot({ stamps: [BOOTED, NEWER], state: { unlocked: true } });
		await tab.clock.advance(65000);
		await learn(tab);
		check('the newer build is pending', tab.U().pending() === NEWER.build);
		check('no countdown started on an unlocked tab', tab.U().countdown() === 0);
		await tab.clock.advance(10 * MIN);
		check('and it never reloaded', tab.reloads.n === 0);
	}

	console.log('\nupdater: an idle nominated runner IS reloaded, unlocked and all');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], selfId: 'd-aaa',
			state: { unlocked: true, runner: true } });
		await tab.clock.advance(65000);
		await learn(tab);
		check('the newer build is pending', tab.U().pending() === NEWER.build);
		check('a countdown is running', tab.U().countdown() === 20);
		check('the countdown is still announced', /update\.reloading_in/.test(tab.bannerText() || ''));
		await tab.clock.advance(21000);
		check('the runner reloaded onto the new build', tab.reloads.n === 1);
	}

	console.log('\nupdater: a runner holding a turn lease is NOT reloaded');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], selfId: 'd-aaa',
			state: { unlocked: true, runner: true, lease: true } });
		await tab.clock.advance(65000);
		await learn(tab);
		check('the newer build is pending', tab.U().pending() === NEWER.build);
		check('no countdown while it is running somebody\'s turn', tab.U().countdown() === 0);
		await tab.clock.advance(10 * MIN);
		check('and it never reloaded', tab.reloads.n === 0);
		// Letting the lease go lets the update through, so the refusal is the LEASE and
		// not the posture.
		tab.state.lease = false;
		await tab.clock.advance(11000);		// one tick of "is it safe yet?"
		check('letting the lease go lets the update through', tab.U().countdown() > 0,
			'countdown=' + tab.U().countdown());
	}

	console.log('\nupdater: a runner that cannot tell is not reloaded');
	{
		const tab = await boot({ stamps: [BOOTED, NEWER], selfId: 'd-aaa', noLease: true,
			state: { unlocked: true, runner: true } });
		await tab.clock.advance(65000);
		await learn(tab);
		check('no countdown with no way to read the lease', tab.U().countdown() === 0);
		await tab.clock.advance(10 * MIN);
		check('and it never reloaded', tab.reloads.n === 0);
	}
	{
		// No device id: the lease question cannot be asked of anybody, so the ordinary
		// refusal stands.
		const tab = await boot({ stamps: [BOOTED, NEWER], state: { unlocked: true, runner: true } });
		await tab.clock.advance(65000);
		await learn(tab);
		check('no countdown with no device id', tab.U().countdown() === 0);
		await tab.clock.advance(10 * MIN);
		check('and it never reloaded', tab.reloads.n === 0);
	}

	console.log('\nupdater: the poll is jittered, so a fleet does not read in lockstep');
	{
		const src = readFileSync(join(HERE, 'updater.js'), 'utf8');
		check('the poll interval carries jitter', /POLL_MS \+ Math\.floor\(Math\.random\(\)/.test(src));
		check('a reconnection triggers a check', /addEventListener\('online', poll\)/.test(src));
	}

	console.log('');
	console.log(passes + ' passed, ' + failures + ' failed');
	if (failures) process.exit(1);
	console.log('all updater checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
