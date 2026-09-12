/* ============================================================
   Test — the park watchdog (www/js/post.js).
   ------------------------------------------------------------
   `fetch` has no timeout. A parked GET whose request is
   black-holed -- accepted and then nothing, which is what a
   front door being restarted behind a proxy looks like -- hangs
   for as long as the operating system keeps the socket. A phone
   once sat forty-one minutes on a dead `/api/post`, beating
   presence and servicing nothing, so every errand handed to it
   was handed into a hole.

   So this drives the REAL module against a `gwFetch` that NEVER
   RESOLVES, and asserts the loop gets out anyway.

     (a) the park carries an AbortController signal, and the
         deadline is the gateway's own window plus slack;
     (b) a request nothing answers is aborted at the deadline,
         not left hanging;
     (c) the abort is reported to the debug feed as a
         `fetch.fail` saying `park-timeout` -- and through
         `event`, not `noteFetchFail`, which would file it as an
         ordinary navigation abort on the hidden window a runner
         always has;
     (d) it then tries AGAIN rather than turning parking off, so
         a hole in the channel is survivable;
     (e) the wait between tries DOUBLES to a one-minute cap, so a
         front door that is down is not hammered;
     (f) an answered park clears the backoff.

   post.js is a classic script, so it is loaded into a
   `with (window)` sandbox with a clock the test owns. Identity
   is stubbed unlocked with no stored record, which is the one
   path that gives the park loop a record to read without a
   passphrase.

   Each check is proven able to fail:

     node www/js/park.test.mjs --break notimeout  # the deadline goes
     node www/js/park.test.mjs --break flatwait   # the doubling goes
     node www/js/park.test.mjs --break silent     # the feed is not told
     node www/js/park.test.mjs                    # and then, clean
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
const KNOWN = ['notimeout', 'flatwait', 'silent'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await drain(); }

/// A clock the test owns. post.js waits with `setTimeout` and the watchdog arms
/// one, so a test on the real clock would take the best part of a minute per
/// scenario. `advance` fires every timer inside the window, draining microtasks
/// after each so a promise a timer settled has landed before the next fires.
function makeClock(t0) {
	let now = t0, seq = 0;
	const timers = new Map();
	return {
		now: () => now,
		setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
		clearTimeout(id) { timers.delete(id); },
		setInterval(fn, ms) { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: Math.max(1, ms || 1) }); return id; },
		clearInterval(id) { timers.delete(id); },
		armed() { return [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b); },
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

/// One simulated tab with a relay that NEVER ANSWERS. `cfg.answerAfter`, where
/// given, is the number of requests to swallow before answering properly.
function makeTab(cfg) {
	cfg = cfg || {};
	const clock = makeClock(1757000000000);
	const local = new Map();
	const calls = [];		// { url, opts, aborted }
	const events = [];
	let answered = 0;

	class Ctl {
		constructor() {
			this.signal = { aborted: false, _on: [], addEventListener(k, fn) { this._on.push(fn); } };
		}
		abort() {
			if (this.signal.aborted) return;
			this.signal.aborted = true;
			this.signal._on.forEach((f) => { try { f({}); } catch (e) {} });
			if (this._reject) this._reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
		}
	}

	const gwFetch = (url, opts) => {
		const rec = { url, opts, aborted: false };
		calls.push(rec);
		const swallow = cfg.answerAfter === undefined ? Infinity : cfg.answerAfter;
		if (answered < swallow) {
			answered++;
			// NEVER RESOLVES. The only way out is the signal.
			return new Promise((res, rej) => {
				if (!opts || !opts.signal) return;		// nothing can ever free it
				if (opts.signal.aborted) { rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
				opts.signal.addEventListener('abort', () => {
					rec.aborted = true;
					rej(Object.assign(new Error('aborted'), { name: 'AbortError' }));
				});
			});
		}
		answered++;
		return Promise.resolve({ status: 200, json: () => Promise.resolve({ ok: true, waited: true, changed: false }) });
	};

	const docOn = {};
	const document = {
		readyState: 'complete', visibilityState: 'hidden',
		addEventListener(k, fn) { (docOn[k] = docOn[k] || []).push(fn); },
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {},
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {},
			classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [],
		getElementById: () => null,
	};
	const win = {
		addEventListener() {},
		Date: { now: clock.now },
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: { onLine: true },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)),
			removeItem: (k) => local.delete(k),
		},
		// The one path that gives the park loop a record with no passphrase: unlocked,
		// nothing stored, so `read()` answers a blank record.
		DaimondIdentity: {
			isUnlocked: () => true,
			publicKeyB64url: () => 'pub-self',
			sealingKeyRaw: () => null,
			wrap: async (s) => s,
			unwrap: async (s) => s,
		},
		DaimondGateway: { clientApi: () => 9, gwFetch: gwFetch },
		DEBUG_SHARE: { event: (kind, payload) => events.push({ kind, payload }) },
		AbortController: Ctl,
	};
	win.window = win;

	let src = readFileSync(join(HERE, 'post.js'), 'utf8');
	if (BREAK === 'notimeout') {
		// The deadline goes: the park is made with no signal, as it was before.
		src = src.replace("+ '&ms=' + PARK_MS + '&w=' + encodeURIComponent(WAKE_ID), PARK_DEADLINE_MS);",
			"+ '&ms=' + PARK_MS + '&w=' + encodeURIComponent(WAKE_ID));");
	}
	if (BREAK === 'flatwait') {
		// The doubling goes: every failure waits the same five seconds.
		src = src.replace('var ms = PARK_BACKOFF_MS * Math.pow(2, k);', 'var ms = PARK_BACKOFF_MS;');
	}
	if (BREAK === 'silent') {
		// The feed is not told, so a dead channel is indistinguishable from a quiet one.
		src = src.replace("if (e && e.timedOut) { _parkTimeouts++; noteParkTimeout(Date.now() - began); }",
			"if (e && e.timedOut) { _parkTimeouts++; }");
	}

	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
		'setInterval', 'clearInterval', 'Date', 'AbortController',
		'with (window) {\n' + src + '\n}');
	fn(win, document, clock.setTimeout, clock.clearTimeout, clock.setInterval,
		clock.clearInterval, { now: clock.now }, Ctl);

	return { win, clock, calls, events, P: () => win.DaimondPost,
		feedKinds: () => events.map((e) => e.kind) };
}

async function boot(cfg) { const tab = makeTab(cfg); await settle(); return tab; }

async function main() {
	console.log('park: the watchdog cuts a request nothing will ever answer');
	{
		const tab = await boot({});
		const P = tab.P();
		check('the module loaded', !!P && typeof P.parkStart === 'function');
		check('nothing is parking yet', P.parking().on === false);
		P.parkStart();
		await settle(20);
		check('one park is in flight', tab.calls.length === 1, 'calls=' + tab.calls.length);
		check('it carries an abort signal', !!(tab.calls[0].opts && tab.calls[0].opts.signal));
		check('the deadline is the gateway window plus slack',
			P.parking().deadlineMs === 55000, 'deadlineMs=' + P.parking().deadlineMs);
		// Just short of the deadline: still hanging, nothing reported.
		await tab.clock.advance(54000);
		check('it is still hanging just short of the deadline', tab.calls[0].aborted === false);
		check('nothing is reported yet', P.parking().timeouts === 0);
		await tab.clock.advance(2000);
		check('the request is aborted at the deadline', tab.calls[0].aborted === true);
		check('the timeout is counted', P.parking().timeouts === 1, 'timeouts=' + P.parking().timeouts);
		check('the feed heard a fetch.fail', tab.feedKinds().includes('fetch.fail'));
		const ev = tab.events.find((e) => e.kind === 'fetch.fail');
		check('and it says park-timeout', !!ev && ev.payload.err === 'park-timeout',
			JSON.stringify(ev && ev.payload));
		check('it carries no request body', !!ev && ev.payload.body === undefined);
		check('parking was NOT turned off', P.parking().off === '' && P.parking().on === true,
			JSON.stringify(P.parking()));
	}

	console.log('\npark: it tries again, and the wait doubles');
	{
		const tab = await boot({});
		const P = tab.P();
		P.parkStart();
		await settle(20);
		await tab.clock.advance(56000);			// first park cut
		check('one failure is recorded', P.parking().fails === 1, 'fails=' + P.parking().fails);
		check('the next try has not been made yet', tab.calls.length === 1);
		await tab.clock.advance(5000);			// the first backoff
		await settle(20);
		check('a second park was made after five seconds', tab.calls.length === 2,
			'calls=' + tab.calls.length);
		await tab.clock.advance(56000);			// second park cut
		check('two failures are recorded', P.parking().fails === 2);
		await tab.clock.advance(5000);
		check('the second wait is longer than five seconds', tab.calls.length === 2,
			'calls=' + tab.calls.length);
		await tab.clock.advance(5000);			// ten in total
		await settle(20);
		check('a third park was made after ten seconds', tab.calls.length === 3,
			'calls=' + tab.calls.length);
		check('three parks, three timeouts, none lost', P.parking().timeouts === 2,
			'timeouts=' + P.parking().timeouts);
	}

	console.log('\npark: the backoff schedule');
	{
		const P = (await boot({})).P();
		check('the first wait is five seconds', P.parkBackoff(1) === 5000);
		check('the second is ten', P.parkBackoff(2) === 10000);
		check('the third is twenty', P.parkBackoff(3) === 20000);
		check('the fourth is forty', P.parkBackoff(4) === 40000);
		check('it caps at a minute', P.parkBackoff(5) === 60000 && P.parkBackoff(50) === 60000,
			P.parkBackoff(5) + '/' + P.parkBackoff(50));
	}

	console.log('\npark: an answered park clears the outage');
	{
		const tab = await boot({ answerAfter: 1 });		// swallow one, then answer
		const P = tab.P();
		P.parkStart();
		await settle(20);
		await tab.clock.advance(56000);			// the first is cut
		check('one failure', P.parking().fails === 1);
		await tab.clock.advance(5000);			// the backoff, then a real answer
		await settle(20);
		check('the second park answered', tab.calls.length >= 2);
		check('the failure count is cleared', P.parking().fails === 0, 'fails=' + P.parking().fails);
		check('the timeout count is KEPT -- it happened', P.parking().timeouts === 1);
	}

	console.log('\n' + checks + ' checks, ' + failures + ' failed');
	if (BREAK) {
		console.log('(--break ' + BREAK + ': failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures > 0 ? 1 : 0);
}

await main();
