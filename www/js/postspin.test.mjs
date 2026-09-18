/* ============================================================
   Test — the held-row park spin (www/js/post.js).
   ------------------------------------------------------------
   A dispatched errand this device posted, or one it stood down
   for the account's nominee, is HELD on the relay: `takeRow`
   answers HOLD so `collect` keeps the ack watermark `through`
   just BELOW the held row's seq, and the relay keeps it for the
   peer to run.

   The bug this proves gone: `parkOnce` used to park `?above=
   st.through`. The gateway answers a park the instant the box's
   high-water passes `above` (gateway/src/handlers/post.rs:608).
   With `through` pinned below the held row, the box's own
   high-water is ALWAYS past it, so every park returned at once
   with `changed:true`, `round()` re-folded the same rows
   (~254 KB on the wire), the PARK_FLOOR_MS floor slept one
   second, and it repeated -- a 1 Hz re-collect storm that, from
   one home NAT with three devices and the pull amplifiers,
   tripped Steel's AddressGuard and looked like broken sync.

   The fix parks `?above=max(through, seen)`, where `seen` is the
   highest seq FOLDED, held rows included -- so the cursor climbs
   past the held row and the park WAITS for a genuinely new row.

   This drives the REAL module against a `gwFetch` that is a
   faithful stand-in for the gateway's post box and its park rule
   (the three lines at post.rs:608). Two tabs load the SAME
   post.js: one as shipped, one with the park cursor reverted to
   `through` -- the pre-fix code -- so the before/after is one
   run.

   Proven able to fail:
     node www/js/postspin.test.mjs --break unfixed  # fix removed
     node www/js/postspin.test.mjs                  # clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['unfixed'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await drain(); }

/// A clock the test owns, so the 1 s PARK_FLOOR and the 45 s park hold are
/// stepped through rather than waited out. Copied from park.test.mjs.
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

/// THE GATEWAY'S POST BOX, reduced to its park-relevant shape. A row is
/// `{ seq, addr, envelope }`. `?since=X` returns rows above `X`; the park rule is
/// exactly post.rs:608 -- answer at once with `changed:true` when the box's
/// high-water is past `above`, otherwise HOLD the request for `ms` and answer
/// `changed:false`.
const PARK_MS = 45000;
function makeBox(rows) {
	const top = () => rows.reduce((m, r) => Math.max(m, r.seq | 0), 0);
	return { rows, top, since: (x) => rows.filter((r) => (r.seq | 0) > (x | 0)) };
}

function makeTab(box, opts) {
	opts = opts || {};
	const clock = makeClock(1757000000000);
	const local = new Map();
	const stat = { park: [], collect: 0, ack: 0, changedTrue: 0 };

	class Ctl {
		constructor() { this.signal = { aborted: false, _on: [], addEventListener(k, fn) { this._on.push(fn); } }; }
		abort() {
			if (this.signal.aborted) return;
			this.signal.aborted = true;
			this.signal._on.forEach((f) => { try { f({}); } catch (e) {} });
		}
	}

	// The faithful stand-in for /api/post: the collect read, the park rule, the ack.
	const gwFetch = (url, o) => {
		const q = String(url).split('?')[1] || '';
		const params = new URLSearchParams(q);
		if (params.has('above')) {
			const above = Number(params.get('above'));
			stat.park.push(above);
			if (box.top() > above) {						// post.rs:608 — news, answer at once
				stat.changedTrue++;
				return Promise.resolve({ status: 200,
					json: () => Promise.resolve({ ok: true, waited: true, changed: true, seq: box.top() }) });
			}
			// Nothing past `above`: HOLD for the window, then answer quietly. The real
			// gateway blocks here; the client's next park is one PARK_MS away, not one
			// PARK_FLOOR away, which is the whole request-rate difference.
			return new Promise((res) => {
				clock.setTimeout(() => res({ status: 200,
					json: () => Promise.resolve({ ok: true, waited: true, changed: false, seq: box.top() }) }), PARK_MS);
			});
		}
		if (params.has('since')) {
			stat.collect++;
			const since = Number(params.get('since'));
			return Promise.resolve({ status: 200,
				json: () => Promise.resolve({ ok: true, rows: box.since(since), more: false }) });
		}
		if (params.get('op') === 'ack') { stat.ack++; return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) }); }
		return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true }) });
	};

	const document = {
		readyState: 'complete', visibilityState: 'hidden',
		addEventListener() {}, createElement: () => ({ className: '', textContent: '', dataset: {}, style: {},
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {},
			classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
	};
	const win = {
		addEventListener() {}, dispatchEvent: () => true,
		Date: { now: clock.now },
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: { onLine: true },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k),
		},
		// Unlocked, pass-through wrap, so `read`/`save` work in plaintext with no passphrase.
		DaimondIdentity: {
			isUnlocked: () => true, deviceId: () => 'dev-self',
			publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
			wrap: async (s) => s, unwrap: async (s) => s,
		},
		DaimondGateway: { clientApi: () => 9, gwFetch },
		// The peer seam `takeRow` routes an errand through. An 'ERRAND:' envelope is
		// this device's OWN dispatch -> verified ours -> HOLD (post.js:1772-1775). Any
		// other envelope peeks to null and falls through to the ordinary message read.
		DaimondPeer: {
			peek: async (env) => (String(env).startsWith('ERRAND:') ? { own: true, env } : null),
			isOwnDispatch: (p) => !!(p && p.own),
			verifyEnvelope: async () => true,
			absorb: async () => null,
		},
		DEBUG_SHARE: { event: () => {} },
		AbortController: Ctl,
	};
	win.window = win;

	let src = readFileSync(join(HERE, 'post.js'), 'utf8');
	if (opts.unfixed) {
		// The pre-fix park cursor: `?above=st.through`, which is pinned below the held
		// row. This is the line the fix changed; reverting it here is what makes the
		// spin reappear in the `unfixed` tab (and, under --break unfixed, in both).
		src = src.replace("'?above=' + above", "'?above=' + st.through");
	}

	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
		'setInterval', 'clearInterval', 'Date', 'AbortController',
		'with (window) {\n' + src + '\n}');
	fn(win, document, clock.setTimeout, clock.clearTimeout, clock.setInterval,
		clock.clearInterval, { now: clock.now }, Ctl);

	return { win, clock, stat, P: () => win.DaimondPost };
}

async function main() {
	// The box the diagnosis describes: rows folded up to seq 141, one HELD errand at
	// 142 that never advances the ack watermark.
	const seedRows = () => [
		{ seq: 141, kind: 'post', addr: 'a141', envelope: 'NORMAL:141' },
		{ seq: 142, kind: 'post', addr: 'e142', envelope: 'ERRAND:142' },
	];

	// ── The fix: cursor advances past the held row, the park HOLDS ──
	console.log('post spin — the SHIPPED module: seen climbs past the held row, the park waits');
	{
		// --break unfixed reverts the fix here too, so these no-spin checks go red --
		// which is the proof that they are really testing the fix and not passing blind.
		const tab = makeTab(makeBox(seedRows()), { unfixed: BREAK === 'unfixed' });
		await settle();
		const P = tab.P();
		check('the module loaded', !!P && typeof P.parkStart === 'function');

		const col = await P.collect();
		check('the initial collect succeeded', col.ok === true, JSON.stringify(col));
		// read() answers the live record (with `seen`); snapshot() deliberately strips it,
		// since `seen` is a local park cursor that must never ride the sync parcel.
		const st = await P.read();
		check('through stopped BELOW the held errand (relay keeps it for the peer)',
			st.through === 141, 'through=' + st.through);
		check('seen CLIMBED PAST the held errand',
			st.seen === 142, 'seen=' + st.seen);
		check('seen is NOT on the sync snapshot (a local cursor, never on the parcel)',
			P.snapshot().seen === undefined, 'snapshot.seen=' + P.snapshot().seen);

		tab.stat.collect = 0; tab.stat.changedTrue = 0; tab.stat.park = [];
		P.parkStart();
		await settle(20);
		check('the first park is keyed on seen (142), not the watermark (141)',
			tab.stat.park[0] === 142, 'above=' + tab.stat.park[0]);
		await tab.clock.advance(6000);				// six seconds of wall-clock
		check('NO re-collect storm: the park is not answered instantly on a held row',
			tab.stat.changedTrue === 0, 'changedTrue=' + tab.stat.changedTrue);
		check('the held rows are NOT re-folded every second',
			tab.stat.collect === 0, 'collects in 6 s=' + tab.stat.collect);
		check('at most one park in six seconds (the gateway holds it ~45 s)',
			tab.stat.park.length <= 1, 'parks in 6 s=' + tab.stat.park.length);
		P.parkStop();
	}

	// ── The pre-fix code, for contrast: the 1 Hz spin ──
	console.log('\npost spin — the PRE-FIX module (?above=through): the 1 Hz re-collect storm');
	{
		const tab = makeTab(makeBox(seedRows()), { unfixed: true });
		await settle();
		const P = tab.P();
		const col = await P.collect();
		check('the initial collect succeeded', col.ok === true);
		tab.stat.collect = 0; tab.stat.changedTrue = 0; tab.stat.park = [];
		P.parkStart();
		await settle(20);
		check('the pre-fix park is keyed on the watermark (141), below the held row',
			tab.stat.park[0] === 141, 'above=' + tab.stat.park[0]);
		await tab.clock.advance(6000);
		// The floor is one second, so six seconds is about six instant re-answers.
		check('the pre-fix park IS answered instantly on the held row (the spin)',
			tab.stat.changedTrue >= 4, 'changedTrue=' + tab.stat.changedTrue);
		check('the pre-fix code re-folds the held rows about once a second',
			tab.stat.collect >= 4, 'collects in 6 s=' + tab.stat.collect);
		P.parkStop();
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': the no-spin failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

await main();
