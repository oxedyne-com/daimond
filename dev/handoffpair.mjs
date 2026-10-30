// handoffpair.mjs — two paired devices on the real gateway, for the hand-off verifiers.
//
// A is a PHONE (a touch context, sending at a phone's width), which hands its turns to
// its NOMINATED runner; B is that desktop. Since D-20261009-23 a composer send goes to
// the nominated runner or runs here, never to an unnominated desktop, so `pair`
// nominates B unless told not to. Shared by `verify_handoff_noresurrect.mjs` and
// `verify_handoff_progresswatch.mjs`, which drive the same pair to different ends.

import { routeProbe, open, chat, signInAs, newChat, connectMock, mockLog } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

/// The wake transport a run forces: `DAIMOND_WAKE=poll` parks plain requests, and the
/// default is the socket.
export const WAKE = process.env.DAIMOND_WAKE === 'poll' ? 'poll' : '';

// `checker` lives in harness.mjs, so a verifier that only counts checks need not import a file that pairs devices (and be read,
// by run_all.sh's declaration check, as one that needs a gateway). It is re-exported here for the verifiers that already import it.
export { checker } from './harness.mjs';

// A page these verifiers withhold through `page.route` must not be a worker's: on WebKit
// a controlled page's requests never reach the route (harness `open`, 12 Oct 2026).
export const ROUTED_SW = 'block';

export const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});

export async function until(pg, fn, arg, ms = 30000, step = 250) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true;
		await pg.waitForTimeout(step);
	}
	return false;
}

/// Every message the device has stored, read through the chat store's own reader:
/// transcripts live in append-only chunks, not on the chat row.
export const storedMsgs = (s) => s.page.evaluate(async () => {
	const cs = window.DaimondCore.chatStore(), out = [];
	for (const sum of cs.stored()) {
		let got = null;
		try { got = await cs.loadMessages(sum.id); } catch (e) { got = null; }
		((got && got.messages) || []).forEach((m) => out.push(m));
	}
	return out;
}).catch(() => []);

/// The empty dispatched placeholders among `ms`.
export const placeholders = (ms) => (ms || []).filter((m) => m && m.why === 'dispatched'
	&& !(m.content && String(m.content).trim()));

/// The non-empty answers among `ms` for turn `iturn`.
export const answersFor = (ms, iturn) => (ms || []).filter((m) => m && m.role === 'assistant'
	&& String(m.iturn) === String(iturn) && m.content && String(m.content).trim() && !m.why);

/// How many requests the model has been sent that carry `text`.
export const modelSaw = (text) => mockLog().filter((r) => JSON.stringify(r).includes(text)).length;

/// Send one prompt from the composer, as the person would -- at a phone's width, where
/// a turn is handed to an awake desktop. The height is a real phone's, so a screen read
/// reads what is laid out.
export async function send(page, text) {
	await page.setViewportSize({ width: 420, height: 860 });
	await page.waitForTimeout(300);
	await toTurn(page);
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
}

/// Bring the turn page up on a phone, as a person does: since ccp29 a phone is a stack of pages
/// (home, the rail, at the bottom), so the composer is reachable only once the chat is opened over
/// it; a send pressed on home lands on the rail instead (A4m, 30 Oct). The chat in focus is
/// opened by its row's name, else the first chat, else New Chat from home's head; a page without the stack is left as it is.
async function toTurn(page) {
	const top = () => page.evaluate(() => (window.DaimondStack && window.DaimondStack.top()) || 'turn').catch(() => 'turn');
	if ((await top()) === 'turn') return;
	for (let i = 0; i < 4 && (await top()) !== 'home'; i++) { await page.goBack().catch(() => {}); await page.waitForTimeout(400); }
	const sel = await page.evaluate(() => {
		let f = null;
		try { f = window.DaimondAttach.focus(); } catch (e) { /* no focus yet */ }
		const row = (f && f.kind === 'chat' && document.querySelector('.session-box.chat-box[data-id="' + f.id + '"] .session-box-name'))
			|| document.querySelector('.session-box.chat-box .session-box-name');
		if (!row) return '';
		row.setAttribute('data-hp-turn', '1');
		return '[data-hp-turn="1"]';
	});
	if (sel) {
		await page.click(sel);
		await page.evaluate(() => { const e = document.querySelector('[data-hp-turn]'); if (e) e.removeAttribute('data-hp-turn'); });
	} else {
		// No chat yet: home's compose is New Chat, and its start tile, where one is drawn, opens the composer.
		await page.click('#home-compose-btn');
		await page.waitForTimeout(600);
		if ((await top()) !== 'turn') for (const q of ['.tile-start', '.pending-centre .empty-new-session']) {
			const e = await page.$(q);
			if (e && await e.isVisible()) { await e.click(); break; }
		}
	}
	for (let i = 0; i < 20 && (await top()) !== 'turn'; i++) await page.waitForTimeout(150);
	if ((await top()) !== 'turn') throw new Error('handoffpair.send: opening the chat left the phone on ' + (await top()));
}

/// Send one prompt from the composer at a DESKTOP's width, where a quick turn runs here.
/// `send` above narrows the window to a phone's, and a desktop sent from at that width
/// reads itself a phone and hands its own turn to whichever peer is awake -- so a turn
/// that must run on B (B busy on a turn of its own) is sent through this one.
export async function sendDesk(page, text) {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.waitForTimeout(300);
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
}

/// A new chat, from the rail a phone's width hides.
export async function freshChat(s, opts = {}) {
	await s.page.setViewportSize({ width: 1280, height: 900 });
	await s.page.waitForTimeout(300);
	await newChat(s, opts);
}

/// The tab going to the background and coming back, which is what starts the recovery
/// pass (`visibilitychange` -> `peerCollectOnReturn`).
export async function comeBack(page) {
	await page.evaluate(async () => {
		const set = (v) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
		set('hidden');  document.dispatchEvent(new Event('visibilitychange'));
		await new Promise((r) => setTimeout(r, 300));
		set('visible'); document.dispatchEvent(new Event('visibilitychange'));
	});
}

/// Keep a page's errand posts off the relay until `release()`: each is answered in the
/// page, as accepted, and counted (`kept()`). What a hand-off sent days ago looks like
/// now -- its errand long since collected, refused or dropped -- which a post made now
/// cannot stand for (E-R1, 2026-09-23): the relay stamps it now, and a collector ages a
/// turn by that stamp and by the sender's own clock, never by comparing the two, so to
/// every collector it is a FRESH turn from a device whose clock is that far slow, to be
/// run. Only the errand post itself is held (a POST to the bare `/api/post`); an ack, a
/// park and a collect all go through.
export async function keepErrandsOff(page) {
	let kept = 0;
	const handler = (route) => {
		const req = route.request();
		if (req.method() === 'POST' && /\/api\/post$/.test(req.url())) {
			kept++;
			return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"accepted":true}' });
		}
		return route.continue();
	};
	await page.route('**/api/post*', handler);
	return {
		kept: () => kept,
		/// Let go once the post has been made: the errand is sealed and posted just after
		/// the placeholder is marked, so this waits (up to ten seconds) for it first.
		release: async () => {
			for (let i = 0; !kept && i < 40; i++) await page.waitForTimeout(250);
			await page.unroute('**/api/post*', handler);
		},
	};
}

/// Hand off `prompt` from A as if it had been sent `ago` ms before now: A's clock is
/// moved for the send alone, and its errand is kept off the relay (`keepErrandsOff`).
/// Answers the placeholder it leaves, or null.
export async function sendAgo(a, prompt, ago) {
	await freshChat(a);
	const off = ago > 0 ? await keepErrandsOff(a.page) : null;
	await a.page.evaluate((ms) => {
		const real = Date.now.bind(Date);
		window.__verifyRealNow = real;
		Date.now = () => real() - ms;
	}, ago);
	await send(a.page, prompt);
	let ph = null;
	for (let i = 0; i < 120 && !ph; i++) {
		ph = placeholders(await storedMsgs(a)).find((m) => m.itext === prompt) || null;
		if (!ph) await a.page.waitForTimeout(250);
	}
	if (off) { await off.release(); console.log('  ..    errands kept off the relay by the route: ' + off.kept()); }
	await a.page.evaluate(() => { if (window.__verifyRealNow) Date.now = window.__verifyRealNow; });
	await settle(a.page);
	return ph;
}

/// Wait for the boot to reach its gate (or to come back unlocked) before signing in.
/// `signInAs` allows the boot fifteen seconds, and on a loaded machine the gate has
/// been measured at thirty-five; the wait is here so a slow boot is not reported as
/// a broken one.
async function gateUp(s) {
	await s.page.waitForFunction(() => {
		const btn = document.getElementById('id-primary');
		if (btn && btn.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 90000 }).catch(() => {});
}

/// Reload a device, which is what time passing looks like to a page: no timer survives
/// it, only what the store holds.
export async function reload(s) {
	await s.page.evaluate(() => window.DaimondSync.flush && window.DaimondSync.flush()).catch(() => {});
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(s);
	await signInAs(s, s.account);
	await s.page.waitForFunction(() => !!window.DaimondSync && window.DaimondGateway
		&& DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	if (WAKE) await s.page.evaluate((m) => window.DaimondSync.wakeVia(m), WAKE);
}

/// Open a device that was closed, on its own profile, and sign it back in: a machine
/// that was asleep coming back, with its store and its identity as it left them.
export async function reopen(s) {
	const r = await open({ name: s.name, touch: !!s.touch, signIn: false, connect: false, serviceWorkers: ROUTED_SW });
	r.name = s.name; r.touch = s.touch; r.account = s.account;
	await gateUp(r);
	await signInAs(r, r.account);
	await r.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await connectMock(r);
	if (WAKE) await r.page.evaluate((m) => window.DaimondSync.wakeVia(m), WAKE);
	return r;
}

/// Pair one more device of `a`'s account, awake, parked and beating, as `pair` pairs B.
async function joinMate(a, lead, mate, route, extra = {}) {
	const b = await open({ name: mate, signIn: false, connect: false, route, serviceWorkers: ROUTED_SW, ...extra });
	b.account = lead; b.name = mate;
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 90000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(b);
	await signInAs(b, lead);
	await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.waitForTimeout(2000);
	await settle(b.page);
	await until(b.page, () => { try { return window.DaimondPost.state().parks > 0; } catch (e) { return false; } }, null, 8000);
	await beatAsApp(b, mate);
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	return b;
}

/// Beat a device's presence with the values its own `presenceTick` sends: whether it is
/// genuinely listening now (`DaimondPost.servicing`), its runner posture and whether it is a
/// phone. Since UNBLOCK-1 (231e6f01) `servicing` goes on the wire both ways, so a bare
/// `beatPresence(id, name)` says servicing:false, the gateway stores `serviced_at: 0`, and
/// every other device's election (`recGenuine`) reads this device as NOT listening and runs
/// its turns itself. Every verifier beat goes through here (diag HOV, 16 Oct 2026).
///
/// # Arguments
/// * `s` - The session (`{ page }`) or the page itself.
/// * `name` - The presence name; defaults to `s.name`.
///
/// # Returns
/// Whether the device said it was servicing, or null when the page could not beat.
export async function beatAsApp(s, name) {
	const pg = s.page || s;
	const n = name != null ? name : s.name;
	return pg.evaluate(async (nm) => {
		let svc = false, run = false, mob = false;
		try { svc = !!window.DaimondPost.servicing(window.DaimondPeer.DISPATCH_FRESH_MS); } catch (e) {}
		try { run = !!window.DaimondRunner.on(); } catch (e) {}
		try { mob = !!(window.DaimondShell && window.DaimondShell.isMobileDevice && window.DaimondShell.isMobileDevice()); } catch (e) {}
		await window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), nm, false, svc, run, mob);
		return svc;
	}, n).catch(() => null);
}

/// Wait until A's own election reads B as listening (`recGenuine`: a fresh beat AND a
/// fresh `serviced_at`), beating B as the app does and refreshing A's presence each round.
/// A fresh B is not listening until its first park round completes, which took 22-23 s in
/// diag HOV; the app's own pulse is 45 s apart. `name` is B's presence name (default
/// `b.name`). Returns whether A read B listening within `ms`.
export async function untilListening(a, b, idB, ms = 120000, name) {
	const t0 = Date.now();
	const seen = () => a.page.evaluate((id) => {
		try {
			const rec = window.DaimondPresence.snapshot()[id];
			return !!(rec && window.DaimondPeer.recGenuine(rec, Date.now(), window.DaimondPeer.DISPATCH_FRESH_MS));
		} catch (e) { return false; }
	}, idB).catch(() => false);
	while (Date.now() - t0 < ms) {
		await beatAsApp(b, name);
		await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		if (await seen()) return true;
		await a.page.waitForTimeout(1000);
	}
	return false;
}

/// A third device, C, joined to `a`'s account the way `pair` joins B. For an arm that needs
/// two runners beside the sender.
export async function third(check, a, mate, opts = {}) {
	const c = await joinMate(a, a.account, mate, opts.route || null, opts.open || {});
	const idC = await c.page.evaluate(() => window.DaimondIdentity.deviceId());
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const seen = await a.page.evaluate((id) => !!window.DaimondPresence.snapshot()[id], idC);
	check('A sees C as a peer', seen);
	return c;
}

/// Name B the account's runner, as its owner would: nominated on A and on B, and B answers
/// "Make this device the runner?" yes. Since D-20261009-23 a composer send goes to the
/// nominated runner or runs here, so a verifier that hands a turn to B must call this, and
/// it asserts the nomination rather than assuming it: a call to the non-existent
/// `DaimondCore.nominate` (the API is `roster.nominate`) once left no nominee, silently, and
/// every turn ran on A. `mate` is B's presence name.
export async function nominateRunner(check, a, b, mate) {
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	for (const s of [a, b]) await s.page.evaluate((id) => window.DaimondCore.roster.nominate(id), idB);
	// A nominated machine is asked, once, "Make this device the runner?" (runner.js), and
	// the question stays up until answered: left open it sits over B's + and every
	// control under it. B says yes, as the person who nominated it would.
	await b.page.evaluate(() => { window.DaimondRunner.ask(); });
	await b.page.locator('.modal.dlg .dlg-ok').first().click({ timeout: 10000 }).catch(() => {});
	const armed = await until(b.page, () => window.DaimondRunner.on(), null, 10000);
	const onA = await a.page.evaluate(() => window.DaimondCore.roster.nominee()).catch((e) => 'error ' + (e && e.message));
	check('B is the runner, asked and answered yes', armed && onA === idB,
		'nominee on A=' + (onA === idB ? 'B' : onA) + ' '
		+ JSON.stringify(await b.page.evaluate(() => window.DaimondRunner.state()).catch(() => null)));
	// B says what it really is -- listening, the runner, not a phone -- and A waits until its
	// own election reads B listening, so the first send is not raced against B's first park.
	const listening = await untilListening(a, b, idB, 120000, mate);
	check('A reads the runner B as listening', listening);
	return idB;
}

/// A and B: two devices of one Pro account, paired, both awake, A seeing B.
///
/// # Arguments
/// * `lead`, `mate` - Harness names for the two browsers; `lead` is also the account.
/// * `opts.route` - Called with each page before it is navigated, so a verifier can serve a
///   damaged `www/js` file to BOTH devices (a `--break`). Absent, nothing is routed.
/// * `opts.openA`, `opts.openB` - Further `open()` options for one device alone, so a verifier
///   can give A or B another build's www (its own `route`, service workers blocked).
/// * `opts.nominate` - `false` leaves the account with no nominated runner; by default B is
///   nominated on both devices, the only way a send is handed off (D-20261009-23).
export async function pair(check, lead, mate, opts = {}) {
	const route = opts.route || null;
	const a = await open({ name: lead, touch: true, signIn: false, connect: false, route, serviceWorkers: ROUTED_SW, ...(opts.openA || {}) });
	a.account = lead; a.name = lead; a.touch = true;
	await gateUp(a);
	await signInAs(a, lead);
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await routeProbe(check, a.page);
	await connectMock(a);
	if (WAKE) await a.page.evaluate((m) => window.DaimondSync.wakeVia(m), WAKE);
	await newChat(a);
	// A chat and a parcel on the account before a peer joins, as a real account has.
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	const b = await joinMate(a, lead, mate, route, opts.openB || {});
	const idA = await a.page.evaluate(() => window.DaimondIdentity.deviceId());
	if (opts.nominate !== false) await nominateRunner(check, a, b, mate);
	const aSeesB = await a.page.evaluate((self) => (window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer', aSeesB >= 1, 'awake peers: ' + aSeesB);
	return { a, b, idA };
}

/// Which segment of the switch reads as pressed: 'runner', 'here' or ''.
export const switchOn = (pg) => pg.evaluate(() => {
	const r = document.getElementById('seat-runner');
	const h = document.getElementById('seat-here');
	if (r && r.getClientRects().length && r.getAttribute('aria-pressed') === 'true') return 'runner';
	if (h && h.getClientRects().length && h.getAttribute('aria-pressed') === 'true') return 'here';
	return '';
}).catch(() => '');

/// Wait for `pred` over the phone's screen, nudging its presence read each round (the
/// beat cadence is the product's; the read is only brought forward).
export async function untilScreen(a, pred, ms, step = 1000) {
	const t0 = Date.now();
	for (;;) {
		let v = false;
		try { v = await pred(); } catch (e) { v = false; }
		if (v || Date.now() - t0 > ms) return v;
		await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await a.page.waitForTimeout(step);
	}
}
