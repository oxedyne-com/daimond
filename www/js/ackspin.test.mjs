/* ============================================================
   Test -- the post park does not spin (www/js/post.js `collect`,
   `parkOnce`; P1a H1 and M3, 2026-09-25).
   ------------------------------------------------------------
   The post box keeps `next_seq` across acks (schema.rs
   `PostBox::high_water = next_seq - 1`), and a park answers at once
   while the high-water is above `above` (post.rs:608). A device
   parks on `seen`, which only a collect moves.

     H1  A device returning to a box another device acked empty: its
         `seen` is below the high-water and no row is left to fold, so
         every park answered at once and every collect found nothing.
         Release 4: 300 parks and 300 collects in 5 min, `seen` 0 of 3.
         Now: at most 7 parks and no collect, `seen` at the high-water;
         and a new row is still collected at once.
     M3  A park that works over a collect that does not (502, or 429
         as AddressGuard answers): release 4, 301 parks and 301
         collects in 5 min. Now: at most 8 of each, and the first
         healthy collect reads the box.

   Two REAL post.js tabs share one faithful box, on a clock the test
   owns (the harness of park.test.mjs).

     node www/js/ackspin.test.mjs
     POST_JS=<release/r4>/www/js/post.js node www/js/ackspin.test.mjs   # H1, M3 fail
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE    = dirname(fileURLToPath(import.meta.url));
const POST_JS = process.env.POST_JS || join(HERE, 'post.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	const line = name + (detail !== undefined && detail !== '' ? ' -- ' + detail : '');
	if (cond) console.log('  ok   ' + line);
	else { console.log('  FAIL ' + line); failures++; }
}
const drain = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await drain(); }

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
			for (let g = 0; g < 400000; g++) {
				let pick = null;
				for (const [id, t] of timers) if (t.at <= target && (!pick || t.at < pick[1].at)) pick = [id, t];
				if (!pick) break;
				now = pick[1].at;
				if (pick[1].every) pick[1].at = now + pick[1].every; else timers.delete(pick[0]);
				try { pick[1].fn(); } catch (e) { console.log('  timer threw ' + e); }
				await settle(8);
			}
			now = target;
			await settle(8);
		},
	};
}

/// The faithful box: `next_seq` survives an ack, a collect answers the high-water as
/// `seq`, a park answers at once while the high-water is above `above`. `collectStatus`,
/// where set, is what every collect answers instead.
function makeBox(clock) {
	const box = { nextSeq: 1, rows: [], parked: [], collectStatus: 200 };
	box.hw = () => box.nextSeq - 1;
	box.deliver = (env) => {
		box.rows.push({ seq: box.nextSeq, kind: 'post', addr: 'a' + box.nextSeq, envelope: env, ts: Math.floor(clock.now() / 1000) });
		box.nextSeq++;
		box.parked.splice(0).forEach((f) => f());
	};
	return box;
}

function makeTab(box, clock, name) {
	const local = new Map();
	const stat = { park: 0, parkNow: 0, collect: 0, ack: 0 };
	class Ctl {
		constructor() { this.signal = { aborted: false, _on: [], addEventListener(k, fn) { this._on.push(fn); } }; }
		abort() { if (this.signal.aborted) return; this.signal.aborted = true; this.signal._on.forEach((f) => { try { f({}); } catch (e) {} }); }
	}
	const answer = (s, j) => Promise.resolve({ status: s, headers: { get: () => '' }, json: () => Promise.resolve(j) });
	const gwFetch = (url, o) => {
		const p = new URLSearchParams(String(url).split('?')[1] || '');
		if (p.has('above')) {
			stat.park++;
			const above = Number(p.get('above'));
			if (box.hw() > above) { stat.parkNow++; return answer(200, { ok: true, waited: true, changed: true, seq: box.hw() }); }
			return new Promise((res) => {
				let done = false;
				const fire = () => { if (done) return; done = true;
					res({ status: 200, headers: { get: () => '' },
						json: () => Promise.resolve({ ok: true, waited: true, changed: box.hw() > above, seq: box.hw() }) }); };
				box.parked.push(fire);
				clock.setTimeout(fire, 45000);
			});
		}
		if (p.has('since')) {
			stat.collect++;
			if (box.collectStatus !== 200) return answer(box.collectStatus, { ok: false });
			const since = Number(p.get('since'));
			return answer(200, { ok: true, seq: box.hw(), rows: box.rows.filter((r) => r.seq > since), more: false });
		}
		if (p.get('op') === 'ack') {
			stat.ack++;
			const through = JSON.parse(o.body).through | 0;
			const before = box.rows.length;
			box.rows = box.rows.filter((r) => r.seq > through);
			return answer(200, { ok: true, dropped: before - box.rows.length });
		}
		return answer(200, { ok: true });
	};
	const document = { readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {}, setAttribute() {},
			appendChild(c) { return c; }, addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
	const win = { addEventListener() {}, dispatchEvent: () => true, Date: { now: clock.now },
		location: { origin: 'https://example.test', href: 'https://example.test/' }, navigator: { onLine: true },
		localStorage: { getItem: (k) => (local.has(k) ? local.get(k) : null), setItem: (k, v) => local.set(k, String(v)),
			removeItem: (k) => local.delete(k) },
		DaimondIdentity: { isUnlocked: () => true, deviceId: () => 'dev-' + name, publicKeyB64url: () => 'pub-self',
			sealingKeyRaw: () => null, wrap: async (s) => s, unwrap: async (s) => s },
		DaimondGateway: { clientApi: () => 9, gwFetch },
		DaimondPeer: { peek: async () => null },
		AbortController: Ctl };
	win.window = win;
	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
		'Date', 'AbortController', 'with (window) {\n' + readFileSync(POST_JS, 'utf8') + '\n}');
	fn(win, document, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval, { now: clock.now }, Ctl);
	return { win, stat, P: () => win.DaimondPost };
}

// ── H1 ─────────────────────────────────────────────────────────
{
	console.log('\nH1: a device returns to a box another device acked empty\n');
	const clock = makeClock(1757000000000);
	const box = makeBox(clock);
	const desk = makeTab(box, clock, 'desk'), phone = makeTab(box, clock, 'phone');
	await settle(20);
	desk.P().parkStart(); await settle(20);
	box.deliver('M1'); box.deliver('M2'); box.deliver('M3');	// while the phone sleeps
	await clock.advance(5000);
	const d = await desk.P().read();
	check('[ctl] the desk collected and acked the box empty', d.seen === 3 && box.rows.length === 0 && box.hw() === 3,
		JSON.stringify({ seen: d.seen, rows: box.rows.length, hw: box.hw() }));
	phone.P().parkStart(); await settle(20);
	const s0 = { ...phone.stat };
	await clock.advance(300000);
	const parks = phone.stat.park - s0.park, now = phone.stat.parkNow - s0.parkNow, cols = phone.stat.collect - s0.collect;
	const p = await phone.P().read();
	console.log('  note phone, 5 min after waking: ' + parks + ' parks (' + now + ' answered at once), ' + cols
		+ ' collects; seen ' + p.seen + ' of ' + box.hw());
	check('the returning phone parks, it does not spin: at most 7 parks in 5 min (release 4: 300)', parks <= 7, parks + ' parks');
	check('and collects at most once (release 4: 300)', cols <= 1, cols + ' collects');
	check('its cursor is at the box\'s high-water (release 4: 0 of 3)', p.seen === box.hw(), 'seen ' + p.seen);
	const s1 = { ...phone.stat };
	box.deliver('M4');
	await clock.advance(5000);
	const p2 = await phone.P().read();
	check('a new row is still collected at once', phone.stat.collect - s1.collect === 1 && p2.seen === 4,
		JSON.stringify({ collects: phone.stat.collect - s1.collect, seen: p2.seen }));
}

// ── M3 ─────────────────────────────────────────────────────────
for (const status of [502, 429]) {
	console.log('\nM3 ' + status + ': the park answers, and every collect is refused ' + status + ', for 5 min\n');
	const clock = makeClock(1757000000000);
	const box = makeBox(clock);
	box.deliver('M1'); box.deliver('M2');
	box.collectStatus = status;
	const tab = makeTab(box, clock, 'phone');
	await settle(20);
	tab.P().parkStart(); await settle(20);
	await clock.advance(300000);
	console.log('  note ' + tab.stat.park + ' parks, ' + tab.stat.collect + ' collects (' + ((tab.stat.park + tab.stat.collect) / 300).toFixed(2) + ' req/s)');
	check('M3 ' + status + '. at most 8 parks in 5 min (release 4: 301)', tab.stat.park <= 8, tab.stat.park + ' parks');
	check('M3 ' + status + '. and at most 8 collects (release 4: 301)', tab.stat.collect <= 8, tab.stat.collect + ' collects');
	box.collectStatus = 200;
	const c0 = tab.stat.collect;
	await clock.advance(120000);
	const st = await tab.P().read();
	check('M3 ' + status + '. once the door answers, the box is read', st.seen === 2 && tab.stat.collect > c0,
		JSON.stringify({ seen: st.seen, collects: tab.stat.collect - c0 }));
}

console.log('\n' + checks + ' checks, ' + (failures ? failures + ' FAILED' : 'ALL PASS'));
process.exit(failures ? 1 : 0);
