/* ============================================================
   Test — HT2 part c: the runner's park and its round (www/js/post.js),
   design §2.3 [H3], H4's device half and [L1].
   ------------------------------------------------------------
   The REAL post.js against a stand-in for /api/post: a park
   answers at once when the box's top is above `above`, else it is
   HELD for its `ms` and answered by a new row (a wake) or the end
   of its hold; a collect `?since=X` answers the rows above X. A
   round is made slow by the row it folds (the peer seam waits).

     P1 a 15 s round with 3 wakes inside it: parks <= wakes + 1, a
        receipt collect within 1 s of each wake, no gap in parks
        over 1 s.
     P2 a park answering at once with `seq`: the next park asks
        above = seq, within the floor, and no 1 Hz loop.
     P3 round owed: three wakes in a round re-run it exactly once,
        and every row is folded.
     P4 locked: no park after it, one `leaving` within 1 s, under
        the park's own wake id.
     P5 a round past 30 s: parking stops, one `leaving`; the round
        ending parks again.
     P6 five failed parks, then the channel comes back: a park at
        once, and the next wait is 5 s.
     P7 the runner parks 20 s; any other device 45 s.
     P8 arming the runner cuts a 45 s park in flight: a 20 s park
        within 1 s, so the 30 s bound holds from the arming (in this
        tab, and from another tab's storage write).
     P9 TABCLOSE: the park registers its wake id with sync.js, so the
        page's close (`presenceGone`) leaves it too.

   Red proof:  MM_SRC_REV=e638b372f node www/js/ht2park.test.mjs
   Breaks:     node www/js/ht2park.test.mjs --break <name>
   ============================================================ */
import { source } from './testlift.mjs';

const BREAK = (() => { const i = process.argv.indexOf('--break'); return i > 0 ? process.argv[i + 1] : null; })();
// Each break undoes one part of HT2c in the source; the arms it names go red.
const BREAKS = {
	beside:  ['if (_roundRun) parkReceipt(seq);\n\t\t\t\troundBeside();', 'await roundBeside();'],	// P1
	receipt: ['if (_roundRun) parkReceipt(seq);', ''],											// P1
	cursor:  ['Math.max(st.through | 0, st.seen | 0, _parkAbove | 0)', 'Math.max(st.through | 0, st.seen | 0)'],	// P2
	owed:    ['if (_roundRun) { _roundOwed = true; return _roundRun; }', 'if (_roundRun) return _roundRun;'],	// P3
	lock:    ["if (_parking) { parkStop(''); parkLeave(); }", ''],								// P4
	hung:    ['if (roundHung()) {', 'if (false) {'],											// P5
	reset:   ["window.addEventListener('daimond:channel-back', function () { parkRecover(); });", ''],	// P6
	runner:  ['return parkAsRunner() ? PARK_RUNNER_MS : PARK_MS;', 'return PARK_MS;'],			// P7
	posture: ["window.addEventListener('daimond:posture', function () { parkPosture(); });", ''],	// P8
	cut:     ['if (!h || !h.cut || h.ms <= parkMs()) return false;', 'return false;'],		// P8, P8b
	origin:  ['if (window.DaimondSync && DaimondSync.presenceOrigin) DaimondSync.presenceOrigin(WAKE_ID);', ''],	// P9
};
if (BREAK && !BREAKS[BREAK]) {
	console.error('unknown break ' + BREAK + '; known: ' + Object.keys(BREAKS).join(', '));
	process.exit(2);
}

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

let POST = source('post.js');
if (BREAK) {
	const [from, to] = BREAKS[BREAK];
	if (!POST.includes(from)) { console.error('break ' + BREAK + ': its text is not in post.js'); process.exit(2); }
	POST = POST.replace(from, to);
}

const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await drain(); }

/// A clock the test owns (as park.test.mjs's).
function makeClock(t0) {
	let now = t0, seq = 0;
	const timers = new Map();
	return {
		now: () => now,
		setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
		clearTimeout(id) { timers.delete(id); },
		setInterval(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: Math.max(1, ms || 1) }); return id; },
		clearInterval(id) { timers.delete(id); },
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
				await settle(6);
			}
			now = target;
			await settle(6);
		},
	};
}

const T0 = 1757000000000;

/// One tab: the module, its gateway stand-in, and what was asked of it.
function makeTab(opts) {
	opts = opts || {};
	const clock = makeClock(T0);
	const local = new Map();
	const rows = (opts.rows || []).slice();
	const top = () => rows.reduce((m, r) => Math.max(m, r.seq | 0), 0);
	const held = [];				// parks the stand-in is holding
	const log = { parks: [], collects: [], leavings: [], origins: [] };
	let down = false;				// parks answer 500 while set
	let unlocked = true;
	const listeners = {};

	const ok = (j) => ({ status: 200, json: () => Promise.resolve(j) });
	const gwFetch = (url, o) => {
		const q = String(url).split('?')[1] || '';
		const p = new URLSearchParams(q);
		const at = clock.now();
		if (p.has('above')) {
			const above = Number(p.get('above')), ms = Number(p.get('ms'));
			const park = { at, above, ms, end: 0 };
			log.parks.push(park);
			if (down) { park.end = at; return Promise.resolve({ status: 500, json: () => Promise.resolve({ ok: false }) }); }
			if (top() > above) { park.end = at; return Promise.resolve(ok({ ok: true, waited: true, changed: true, seq: top() })); }
			return new Promise((res, rej) => {
				const h = { above, answer: (changed) => {
					const i = held.indexOf(h); if (i < 0) return;
					held.splice(i, 1); park.end = clock.now();
					res(ok({ ok: true, waited: true, changed, seq: top() }));
				} };
				held.push(h);
				// An aborted request ends its park here as the browser's would.
				if (o && o.signal) o.signal.addEventListener('abort', () => {
					const i = held.indexOf(h); if (i < 0) return;
					held.splice(i, 1); park.end = clock.now();
					rej(new Error('aborted'));
				});
				clock.setTimeout(() => h.answer(false), ms);
			});
		}
		if (p.has('since')) {
			const since = Number(p.get('since'));
			log.collects.push({ at, since });
			return Promise.resolve(ok({ ok: true, rows: rows.filter((r) => (r.seq | 0) > since), more: false }));
		}
		return Promise.resolve(ok({ ok: true }));
	};
	const wake = (seq, envelope) => {
		rows.push({ seq, kind: 'post', addr: 'a' + seq, envelope: envelope || ('NORMAL:' + seq) });
		for (const h of held.slice()) if (top() > h.above) h.answer(true);
	};

	const document = {
		readyState: 'complete', visibilityState: 'hidden',
		addEventListener() {}, createElement: () => ({ className: '', textContent: '', dataset: {}, style: {},
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {},
			classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
	};
	class Ctl {
		constructor() { this.signal = { aborted: false, _on: [], addEventListener(k, fn) { this._on.push(fn); } }; }
		abort() { if (this.signal.aborted) return; this.signal.aborted = true; this.signal._on.forEach((f) => { try { f({}); } catch (e) {} }); }
	}
	const win = {
		addEventListener(k, fn) { (listeners[k] = listeners[k] || []).push(fn); },
		removeEventListener() {},
		dispatchEvent(ev) { for (const fn of (listeners[ev.type] || [])) { try { fn(ev); } catch (e) {} } return true; },
		Date: { now: clock.now },
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: { onLine: true },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k),
		},
		DaimondIdentity: {
			isUnlocked: () => unlocked, deviceId: () => 'dev-self',
			publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
			wrap: async (s) => s, unwrap: async (s) => s,
		},
		DaimondGateway: { clientApi: () => 9, gwFetch },
		DaimondRunner: { KEY: 'daimond-runner-posture', on: () => !!opts.runner },
		DaimondSync: { presenceLeaving: (w) => { log.leavings.push({ at: clock.now(), w }); return true; },
			presenceOrigin: (w) => { log.origins.push(w); } },
		// A row whose envelope is SLOW:<ms> takes that long to fold: the slow round.
		DaimondPeer: {
			peek: (env) => {
				const m = /^SLOW:(\d+)/.exec(String(env));
				if (!m) return Promise.resolve(null);
				return new Promise((r) => clock.setTimeout(() => r(null), Number(m[1])));
			},
			isOwnDispatch: () => false, verifyEnvelope: async () => true, absorb: async () => null,
		},
		DEBUG_SHARE: { event: () => {} },
		AbortController: Ctl,
	};
	win.window = win;
	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
		'setInterval', 'clearInterval', 'Date', 'AbortController', 'with (window) {\n' + POST + '\n}');
	fn(win, document, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval,
		{ now: clock.now }, Ctl);
	class Ev { constructor(type) { this.type = type; } }
	return {
		win, clock, log, wake, P: () => win.DaimondPost,
		setDown: (v) => { down = v; },
		lock: () => { unlocked = false; win.dispatchEvent(new Ev('daimond:lock')); },
		emit: (type, f) => win.dispatchEvent(Object.assign(new Ev(type), f || {})),
		arm: () => { opts.runner = true; },
		parksBetween: (a, b) => log.parks.filter((p) => p.at > a && p.at < b),
	};
}

/// Was a park held at every moment of [a, b], gaps of at most `gap` ms apart?
function maxGap(parks, a, b) {
	let worst = 0, cover = a;
	for (const p of parks.slice().sort((x, y) => x.at - y.at)) {
		if (p.at > b) break;
		if (p.at > cover) worst = Math.max(worst, p.at - cover);
		cover = Math.max(cover, p.end || b);
	}
	if (cover < b) worst = Math.max(worst, b - cover);
	return worst;
}

console.log('HT2c park and round (' + (BREAK ? '--break ' + BREAK : 'clean')
	+ (process.env.MM_SRC_REV ? ', rev ' + process.env.MM_SRC_REV : '') + ')');

// ── P1, P3: a 15 s round with three wakes inside it ──
{
	const tab = makeTab({ rows: [{ seq: 1, kind: 'post', addr: 'a1', envelope: 'SLOW:15000' }] });
	await settle();
	tab.P().parkStart();
	await settle(20);
	const r0 = T0;
	for (const [t, seq] of [[3000, 2], [7000, 3], [11000, 4]]) {
		await tab.clock.advance(T0 + t - tab.clock.now());
		tab.wake(seq);
		await settle(20);
	}
	await tab.clock.advance(T0 + 16000 - tab.clock.now());
	const inRound = tab.parksBetween(r0, r0 + 15000);
	check('P1 a 15 s round with 3 wakes: no park spin (parks in it <= wakes + 1)',
		inRound.length >= 1 && inRound.length <= 4, inRound.length + ' parks');
	const receipts = [3000, 7000, 11000].map((t) => tab.log.collects.find(
		(c) => c.at >= T0 + t && c.at <= T0 + t + 1000));
	check('P1 a receipt collect within 1 s of each wake', receipts.every(Boolean),
		receipts.map((c) => c ? (c.at - T0) + 'ms@' + c.since : 'none').join(', '));
	const gap = maxGap(tab.log.parks, T0, T0 + 15000);
	check('P1 never a gap in parks over 1 s through the round', gap <= 1000, 'worst ' + gap + ' ms');
	await tab.clock.advance(5000);
	const pk = tab.P().parking();
	check('P3 round owed: the round re-ran exactly once', pk.rounds === 2, 'rounds ' + pk.rounds);
	const st = await tab.P().read();
	check('P3 the re-run folded every row the wakes brought', (st.seen | 0) === 4, 'seen ' + st.seen);
	tab.P().parkStop();
}

// ── P2: a park answering at once with seq ──
{
	const tab = makeTab({ rows: [{ seq: 5, kind: 'post', addr: 'a5', envelope: 'SLOW:30000' }] });
	await settle();
	tab.P().parkStart();
	await settle(20);
	await tab.clock.advance(10000);
	const ps = tab.log.parks;
	check('P2 the first park answered at once (the box above it)', ps.length >= 1 && ps[0].end === ps[0].at);
	check('P2 the next park asks above = seq, within the floor',
		ps.length >= 2 && ps[1].above === 5 && ps[1].at - T0 <= 1500,
		ps.length >= 2 ? 'above ' + ps[1].above + ' at ' + (ps[1].at - T0) + ' ms' : 'no second park');
	check('P2 no 1 Hz loop: at most 2 parks in 10 s', ps.length <= 2, ps.length + ' parks');
	const og = [...new Set(tab.log.origins)];
	check('P9 TABCLOSE: the park registers its own wake id to leave with the page',
		og.length === 1 && /^p/.test(String(og[0])) && (!ps[0].w || ps[0].w === og[0]), og.join() || 'none');
	tab.P().parkStop();
}

// ── P4: locked ──
{
	const tab = makeTab();
	await settle();
	tab.P().parkStart();
	await settle(20);
	await tab.clock.advance(5000);
	const n = tab.log.parks.length;
	const at = tab.clock.now();
	tab.lock();
	await settle(20);
	await tab.clock.advance(1000);
	const soon = tab.log.leavings.filter((l) => l.at <= at + 1000);
	check('P4 locked: one `leaving` within 1 s', soon.length === 1, soon.length + ' leavings');
	check('P4 the leaving names the park\'s own wake id', soon.length === 1 && /^p/.test(String(soon[0].w)),
		soon.length ? 'w ' + soon[0].w : '');
	await tab.clock.advance(120000);
	check('P4 locked: no park after it', tab.log.parks.length === n, (tab.log.parks.length - n) + ' parks after');
	check('P4 exactly one `leaving` in all', tab.log.leavings.length === 1, tab.log.leavings.length + ' leavings');
}

// ── P5: a round past 30 s ──
{
	const tab = makeTab({ runner: true, rows: [{ seq: 1, kind: 'post', addr: 'a1', envelope: 'SLOW:100000' }] });
	await settle();
	tab.P().parkStart();
	await settle(20);
	await tab.clock.advance(55000);
	const n = tab.log.parks.length;
	await tab.clock.advance(40000);			// to 95 s: the round still running
	check('P5 a round past 30 s: parking stops', tab.log.parks.length === n && n <= 3,
		n + ' parks by 55 s, ' + (tab.log.parks.length - n) + ' more by 95 s');
	check('P5 and says it is leaving, once', tab.log.leavings.length === 1, tab.log.leavings.length + ' leavings');
	const last = tab.log.parks[tab.log.parks.length - 1];
	check('P5 no park is held past 30 s + one hold', !last || (last.end && last.end - T0 <= 30000 + 20000 + 1000),
		last ? 'last park ends ' + (last.end - T0) + ' ms' : '');
	await tab.clock.advance(10000);			// the round ends at 100 s
	check('P5 the round ending parks again', tab.log.parks.length > n, (tab.log.parks.length - n) + ' parks after');
	tab.P().parkStop();
}

// ── P6: the backoff returns to its floor ──
{
	const tab = makeTab();
	await settle();
	tab.setDown(true);
	tab.P().parkStart();
	await settle(20);
	await tab.clock.advance(5000 + 10000 + 20000 + 40000 + 1000);	// five failures, the sixth wait (60 s) begun
	const n = tab.log.parks.length;
	check('P6 five failed parks', n === 5, n + ' parks');
	const at = tab.clock.now();
	tab.emit('daimond:channel-back');
	await settle(20);
	await tab.clock.advance(1000);
	check('P6 the channel back: a park at once', tab.log.parks.length === n + 1
		&& tab.log.parks[n].at - at <= 1000, (tab.log.parks.length - n) + ' parks within 1 s');
	await tab.clock.advance(6000);
	const p7 = tab.log.parks[n + 1];
	check('P6 the next wait is 5 s', !!p7 && p7.at - tab.log.parks[n].at === 5000,
		p7 ? (p7.at - tab.log.parks[n].at) + ' ms' : 'no park');
	tab.P().parkStop();
}

// ── P7: the runner parks 20 s ──
for (const runner of [true, false]) {
	const tab = makeTab({ runner });
	await settle();
	tab.P().parkStart();
	await settle(20);
	const ms = tab.log.parks.length ? tab.log.parks[0].ms : 0;
	check('P7 ' + (runner ? 'the runner parks 20 s' : 'another device parks 45 s'),
		ms === (runner ? 20000 : 45000), 'ms ' + ms);
	tab.P().parkStop();
}

// ── P8: arming the runner cuts the park in flight ──
for (const how of ['daimond:posture', 'storage']) {
	const tab = makeTab({ runner: false });
	await settle();
	tab.P().parkStart();
	await settle(20);
	await tab.clock.advance(5000);
	const n = tab.log.parks.length;
	const at = tab.clock.now();
	tab.arm();
	if (how === 'storage') tab.emit('storage', { key: 'daimond-runner-posture', newValue: '1' });
	else tab.emit(how);
	await settle(20);
	await tab.clock.advance(1000);
	const first = tab.log.parks[0];
	const next = tab.log.parks[n];
	const label = how === 'storage' ? 'P8b armed in another tab' : 'P8 armed in this tab';
	check(label + ': the 45 s park in flight ends within 1 s', !!first && first.ms === 45000
		&& !!first.end && first.end - at <= 1000, first ? 'ms ' + first.ms + (first.end ? ', ends at +' + (first.end - at) + ' ms' : ', still held') : 'no park');
	check(label + ': and a 20 s park begins within 1 s', !!next && next.ms === 20000 && next.at - at <= 1000,
		next ? 'ms ' + next.ms + ' at +' + (next.at - at) + ' ms' : 'no park after');
	await tab.clock.advance(40000);
	check(label + ': no park spin after the cut', tab.log.parks.length - n <= 3, (tab.log.parks.length - n) + ' parks in 41 s');
	tab.P().parkStop();
}
{
	const tab = makeTab({ runner: true });
	await settle();
	tab.P().parkStart();
	await settle(20);
	await tab.clock.advance(5000);
	tab.emit('daimond:posture');
	await settle(20);
	await tab.clock.advance(1000);
	check('P8c a runner already armed: its 20 s park is not cut', tab.log.parks.length === 1 && !tab.log.parks[0].end,
		tab.log.parks.length + ' parks');
	tab.P().parkStop();
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILURE(S)' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
