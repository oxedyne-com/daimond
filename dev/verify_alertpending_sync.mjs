// gateway: live
// verify_alertpending_sync.mjs — an alert raised on one device is seen, counted, cleared and
// dismissed on the other, over a real sync (ALERT-PENDING, D-20261016-17).
//
// The owner's rule (rulings §16): the person looks in ONE place for system alerts, the Pending
// panel. A daimon's `pending_raise` writes a record into `DaimondAlerts`, which rides the sync
// parcel (`alerts`), and every device draws it there. This drives that across two devices of one
// account, paired, through this world's own gateway:
//
//   A1  A raises needs:true  -> B shows it, as "needs", and B's Pending count counts it.
//   A2  A raises needs:false -> B shows it quietly, and the count does not move.
//   A3  A clears the needs:true one -> it is gone on B, and B's count is empty.
//   A4  B dismisses the quiet one (its ✕) -> it is gone on A, and A's OLDER copy of the raise,
//       pushed afterwards, does not bring it back on either device; nor does A raising the very
//       same words again.
//   A5  The 24 h lapse, on a driven clock: a quiet alert carries `expires = raise + 24 h` in the
//       synced item itself, so B (which never raised it) drops it with A once the clock passes.
//
// ENGINES. A is Chromium at a desktop size; B is WebKit with an iPhone's UA, touch and a phone's
// viewport, because the phone is where the person reads the panel on the move. An alert needs no
// Diamond on the receiving device (the tile falls back to "the Diamond"), so WebKit's missing
// OPFS does not stand in the way here as it does in verify_markshere_sync.
//
// Needs the dev stack with a gateway on DAIMOND_GW_PORT; sync is Pro-gated, so the account is
// granted Pro the way the gateway trusts (dev/pro.mjs).
//
//   eval "$(bash dev/world.sh 77 --env)"; node dev/verify_alertpending_sync.mjs
//   AP_BREAK=nosync node dev/verify_alertpending_sync.mjs     # must FAIL: B drops the alerts section
//
// AN OLDER BUILD (review AP, 16 Oct 2026). `AP_OLD=<dir>` names a www tree of a build that
// predates the `alerts` section (`git archive d26e2aaa www | tar -x -C <dir>`; pass <dir>/www).
// A third device C is served that tree through `route` (service workers blocked, so nothing
// answers behind the route's back), paired, and is the ONLY device to push while A and B are
// offline -- the parcel in the mailbox is then C's. Then:
//   O1  C is the older build (no DaimondAlerts), and its push lands.
//   O2  A and B come back, and a fresh device E paired afterwards sees both alerts: the section
//       an older build left out of its parcel is restored by a device that knows it, without
//       anyone raising, clearing or editing anything.
import fs from 'node:fs';
import { open, signInAs, scratch } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { guardRan } from './verdict.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + String(detail).slice(0, 400) : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);

const NAME = 'apsync';
const GWDIR = new URL('../gateway', import.meta.url).pathname;
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROFILE = (x) => scratch('pw', 'apsync-' + x + '-' + process.pid);
const SHOTS = process.env.AP_SHOTS || '';

const ready = (s) => s.page.waitForFunction(() => !!(window.DaimondSync && window.DaimondCore && window.DaimondGateway
	&& DaimondGateway.state().authed), null, { timeout: 30000 }).catch(() => {});

/// What one device's Pending panel shows of alerts: each alert tile's headline and kind, and the count.
const panel = (s) => s.page.evaluate(() => {
	const cards = [...document.querySelectorAll('#pending-list .pend-card.pend-alert')].map((c) => ({
		text: c.textContent, needs: c.classList.contains('pend-needs'), quiet: c.classList.contains('pend-quiet') }));
	const live = window.DaimondAlerts ? DaimondAlerts.live() : null;
	return { cards, count: (document.getElementById('pending-count') || {}).textContent || '', live,
		badge: window.DaimondAlerts ? DaimondAlerts.count() : -1 };
});
const shows = (p, head) => p.cards.find((c) => c.text.includes(head));
const raise = (s, id, p) => s.page.evaluate(([id, p]) => JSON.parse(DaimondPendingTool.raise(id, JSON.stringify(p))), [id, p]);
const clear = (s, id, key) => s.page.evaluate(([id, key]) => JSON.parse(DaimondPendingTool.clear(id, JSON.stringify({ key }))), [id, key]);

/// One sync round from one device to another, until `until` holds on the receiver.
async function round(from, to, until, ms = 40000) {
	const t0 = Date.now();
	do {
		await from.page.evaluate(() => window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push()).catch(() => {});
		await to.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		await sleep(700);
		if (!until || await until()) return true;
	} while (Date.now() - t0 < ms);
	return false;
}

async function pairedDevice(lead, label, opts) {
	const d = await open(Object.assign({ name: NAME + '-' + label, signIn: false, connect: false, defaults: false,
		profile: PROFILE(label) }, opts || {}));
	await d.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 30000 }).catch(() => {});
	const code = await lead.page.evaluate(() => DaimondPairing.create());
	await d.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await d.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(d, NAME);
	await ready(d);
	await sleep(2500);
	return d;
}

/// Serve every file the older tree holds from that tree; the rest (the wasm, which is not
/// tracked) from this world.
const OLD = process.env.AP_OLD || '';
const oldRoute = (dir) => async (page) => {
	page.setDefaultNavigationTimeout(120000);
	await page.route('**/*', async (r) => {
		const u = new URL(r.request().url());
		if (u.origin !== new URL(page.url() === 'about:blank' ? u.href : page.url()).origin || u.pathname.startsWith('/api/')) return r.fallback();
		const rel = decodeURIComponent(u.pathname === '/' ? '/index.html' : u.pathname);
		const f = dir + rel;
		if (!rel.includes('..') && fs.existsSync(f) && fs.statSync(f).isFile()) {
			const ext = rel.split('.').pop();
			const type = { html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json',
				svg: 'image/svg+xml', webmanifest: 'application/manifest+json', wasm: 'application/wasm' }[ext] || 'application/octet-stream';
			return r.fulfill({ status: 200, contentType: type, body: fs.readFileSync(f) });
		}
		return r.fallback();
	});
};
const flush = (s) => s.page.evaluate(() => window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push()).catch((e) => ({ threw: String(e) }));

const openPending = (s) => s.page.evaluate(() => DaimondPanels.show('pending')).catch(() => {});

let A = null, B = null, C = null, E = null;
try {
	process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
	A = await open({ name: NAME, connect: false, defaults: false, profile: PROFILE('a'), viewport: { width: 1920, height: 961 } });
	await ready(A);
	const pro = await makePagePro(A.page, GWDIR, GW_URL);
	check('the account holds Pro, so sync can run at all', pro.pro === true, J(pro));
	const D = await A.page.evaluate(async () => { const id = await DaimondCore.diamondApp().create_diamond('Email'); await DaimondCore.loadDiamonds(); return id; });
	B = await pairedDevice(A, 'phone', { browser: 'webkit', touch: true, ua: IPHONE, viewport: { width: 393, height: 793 } });
	check('B is WebKit, paired, and signed in', B.page.context().browser().browserType().name() === 'webkit'
		&& await B.page.evaluate(() => !!(window.DaimondGateway && DaimondGateway.state().authed)), '');
	await openPending(A); await openPending(B);
	// THE BREAK: `AP_BREAK=nosync` makes B ignore the parcel's `alerts` section, so every check
	// that needs an alert to travel must go red (A1-A3, A5's second raise) while A's own stay green.
	if (process.env.AP_BREAK === 'nosync') await B.page.evaluate(() => { DaimondAlerts.adoptSync = () => false; });

	// ── A1 ────────────────────────────────────────────────────────────────────
	const N = { key: 'reply-acme', headline: 'Acme asks for a quote by Friday', detail: 'From jo@acme.example, 09:12. It wants an answer.', needs: true };
	const r1 = await raise(A, D, N);
	check('A1. A raises a needs:true alert', r1.ok === true, J(r1));
	const got1 = await round(A, B, async () => !!shows(await panel(B), N.headline));
	const b1 = await panel(B);
	check('A1. it shows on B as "needs you"', got1 && !!shows(b1, N.headline) && shows(b1, N.headline).needs, J(b1.cards));
	check('A1. and B\'s Pending count counts it', b1.count === '1' && b1.badge === 1, J({ count: b1.count, badge: b1.badge }));

	// ── A2 ────────────────────────────────────────────────────────────────────
	const Q = { key: 'fyi-newsletter', headline: 'Three newsletters filed under Reading', detail: 'Nothing to answer.', needs: false };
	const r2 = await raise(A, D, Q);
	check('A2. A raises a needs:false alert', r2.ok === true, J(r2));
	const got2 = await round(A, B, async () => !!shows(await panel(B), Q.headline));
	const b2 = await panel(B);
	check('A2. it shows on B quietly', got2 && !!shows(b2, Q.headline) && shows(b2, Q.headline).quiet, J(b2.cards));
	check('A2. and the count does not move', b2.count === '1' && b2.badge === 1, J({ count: b2.count, badge: b2.badge }));
	const qB = (b2.live || []).find((a) => a.key === Q.key);
	const qA = ((await panel(A)).live || []).find((a) => a.key === Q.key);
	check('A5. the quiet alert carries its 24 h lapse in the synced item, the same on both devices',
		!!qA && !!qB && qA.expires === qB.expires && qA.expires > Date.now() + 23.9 * 3600e3 && qA.expires <= Date.now() + 24 * 3600e3,
		J({ a: qA && qA.expires, b: qB && qB.expires, now: Date.now() }));

	if (OLD) {
		const offline2 = (s, on) => on ? s.page.route('**/api/sync**', (r) => r.abort()) : s.page.unroute('**/api/sync**');
		C = await pairedDevice(A, 'old', { serviceWorkers: 'block', route: oldRoute(OLD) });
		await offline2(A, true); await offline2(B, true);
		const cOld = await C.page.evaluate(() => typeof window.DaimondAlerts === 'undefined' && !!window.DaimondSync);
		await C.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		// A change of C's own, so its parcel is new and goes on the wire.
		await C.page.evaluate(() => { try { localStorage.setItem('ap-old-touch', String(Date.now())); } catch (e) { /* */ } });
		const fc = await flush(C);
		check('O1. C is the older build (no alerts module) and its push lands', cOld && !!fc && fc.ok !== false, J({ cOld, fc }));
		await C.close().catch(() => {}); C = null;
		// E pairs while A and B are still away, so what it reads is exactly the parcel C left.
		E = await pairedDevice(A, 'fresh', {});
		await offline2(E, true); await offline2(E, false);
		const eKeys = () => E.page.evaluate(() => (window.DaimondAlerts ? DaimondAlerts.live() : []).map((a) => a.key).sort());
		await E.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		const left = await eKeys();
		const lacks = await E.page.evaluate(() => window.DaimondSync.lastPulledLacks ? DaimondSync.lastPulledLacks() : null);
		console.log('  info O1. the mailbox after the older build pushed holds alerts: ' + J(left) + '; sections it lacked: ' + J(lacks));
		await offline2(A, false); await offline2(B, false);
		// A and B hear C's parcel, as any device does on its next round -- PULL ONLY: nothing of
		// theirs changes, so a push of theirs happens only if hearing it owes one.
		const listen = async () => {
			for (const s of [A, B]) {
				await s.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
				await sleep(2500);
			}
		};
		let seen = [];
		for (let i = 0; i < 6; i++) {
			await listen();
			await E.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
			seen = await eKeys();
			if (seen.length >= 2) break;
		}
		check('O2. after the older build pushed, a device that knows the section puts it back: E sees both alerts',
			J(seen) === J([Q.key, N.key].sort()), J({ seen, left }));
		await E.close().catch(() => {}); E = null;
	}

	if (SHOTS) {
		for (const [s, tag] of [[A, 'chromium_1920x961'], [B, 'webkit_393x793']]) {
			await openPending(s); await sleep(600);
			await s.page.screenshot({ path: SHOTS + '/pending_' + tag + '.png' });
		}
	}

	// ── A3 ────────────────────────────────────────────────────────────────────
	const r3 = await clear(A, D, N.key);
	check('A3. A clears the needs:true alert', r3.ok === true && r3.cleared === true, J(r3));
	const got3 = await round(A, B, async () => !shows(await panel(B), N.headline));
	const b3 = await panel(B);
	check('A3. it is gone on B', got3 && !shows(b3, N.headline), J(b3.cards));
	check('A3. and B\'s count is empty', b3.count === '' && b3.badge === 0, J({ count: b3.count, badge: b3.badge }));
	check('A3. the quiet one is still there on B', !!shows(b3, Q.headline), J(b3.cards));

	// ── A4 ────────────────────────────────────────────────────────────────────
	const offline = (s, on) => on ? s.page.route('**/api/sync**', (r) => r.abort()) : s.page.unroute('**/api/sync**');
	await offline(A, true);	// A keeps its older copy (the raise) while B dismisses
	const pressed = await B.page.evaluate((head) => {
		const card = [...document.querySelectorAll('#pending-list .pend-card.pend-alert')].find((c) => c.textContent.includes(head));
		const x = card && card.querySelector('.pend-no');
		if (!x) return false;
		x.click();
		return true;
	}, Q.headline);
	await sleep(300);
	const b4 = await panel(B);
	check('A4. B\'s ✕ takes the quiet alert down on B', pressed && !shows(b4, Q.headline), J(b4.cards));
	await B.page.evaluate(() => window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push()).catch(() => {});
	await sleep(1500);
	check('A4. (A, offline meanwhile, still holds its older raise)', !!shows(await panel(A), Q.headline), '');
	await offline(A, false);
	// A pushes its older copy FIRST, then pulls: the dismiss must win either way.
	await A.page.evaluate(() => window.DaimondSync.flush ? window.DaimondSync.flush() : window.DaimondSync.push()).catch(() => {});
	const got4 = await round(B, A, async () => !shows(await panel(A), Q.headline));
	check('A4. the dismiss reaches A', got4, J((await panel(A)).cards));
	await round(A, B, null);
	await round(A, B, null);
	const b4b = await panel(B);
	check('A4. A\'s older raise, pushed after, does not bring it back on B', !shows(b4b, Q.headline), J(b4b.cards));
	const r4 = await raise(A, D, Q);
	await round(A, B, null);
	const a4 = await panel(A), b4c = await panel(B);
	check('A4. A raising the very same words again leaves it down on both', r4.ok === true && r4.was === 'dismissed'
		&& !shows(a4, Q.headline) && !shows(b4c, Q.headline), J({ r4, a: a4.cards.length, b: b4c.cards.length }));

	// ── A5: the lapse, on a driven clock ─────────────────────────────────────
	const L = { key: 'fyi-receipt', headline: 'A receipt from the hosting company', detail: 'Filed.', needs: false };
	await raise(A, D, L);
	const got5 = await round(A, B, async () => !!shows(await panel(B), L.headline));
	check('A5. a second quiet alert reaches B', got5, '');
	// Drive both clocks 24 h and a minute on, then fire what the armed timer fires.
	const drive = (s) => s.page.evaluate(() => {
		const real = Date.now.bind(Date), off = 24 * 3600e3 + 60e3;
		Date.now = () => real() + off;
		window.dispatchEvent(new CustomEvent('daimond:alerts'));
	});
	const before = { a: !!shows(await panel(A), L.headline), b: !!shows(await panel(B), L.headline) };
	await drive(A); await drive(B); await sleep(400);
	const a5 = await panel(A), b5 = await panel(B);
	check('A5. 24 h on, the quiet alert is gone on BOTH devices without a sync or a press',
		before.a && before.b && !shows(a5, L.headline) && !shows(b5, L.headline), J({ before, a: a5.cards, b: b5.cards }));
} catch (e) {
	console.log('VERIFY THREW:', e && (e.stack || e.message || e));
	bad.push('verify threw: ' + (e && e.message));
} finally {
	for (const s of [A, B, C, E]) { try { await s?.close?.(); } catch (e) { /* closing */ } }
	for (const x of ['a', 'phone', 'old', 'fresh']) { try { fs.rmSync(PROFILE(x), { recursive: true, force: true }); } catch (e) { /* tidy */ } }
}

guardRan(ok.length + bad.length);
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
