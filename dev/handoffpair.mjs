// handoffpair.mjs — two paired devices on the real gateway, for the hand-off verifiers.
//
// A is a PHONE (a touch context, sending at a phone's width), which hands its turns to
// an awake desktop; B is that desktop. Shared by `verify_handoff_noresurrect.mjs` and
// `verify_handoff_progresswatch.mjs`, which drive the same pair to different ends.

import { open, chat, signInAs, newChat, connectMock, mockLog } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

/// The wake transport a run forces: `DAIMOND_WAKE=poll` parks plain requests, and the
/// default is the socket.
export const WAKE = process.env.DAIMOND_WAKE === 'poll' ? 'poll' : '';

// `checker` lives in harness.mjs, so a verifier that only counts checks need not import a file that pairs devices (and be read,
// by run_all.sh's declaration check, as one that needs a gateway). It is re-exported here for the verifiers that already import it.
export { checker } from './harness.mjs';

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
	await page.fill('#chat-input', text);
	await page.click('#chat-send', { force: true });
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
export async function freshChat(s) {
	await s.page.setViewportSize({ width: 1280, height: 900 });
	await s.page.waitForTimeout(300);
	await newChat(s);
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
	if (off) await off.release();
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
	const r = await open({ name: s.name, touch: !!s.touch, signIn: false, connect: false });
	r.name = s.name; r.touch = s.touch; r.account = s.account;
	await gateUp(r);
	await signInAs(r, r.account);
	await r.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await connectMock(r);
	if (WAKE) await r.page.evaluate((m) => window.DaimondSync.wakeVia(m), WAKE);
	return r;
}

/// A and B: two devices of one Pro account, paired, both awake, A seeing B.
///
/// # Arguments
/// * `lead`, `mate` - Harness names for the two browsers; `lead` is also the account.
/// * `opts.route` - Called with each page before it is navigated, so a verifier can serve a
///   damaged `www/js` file to BOTH devices (a `--break`). Absent, nothing is routed.
export async function pair(check, lead, mate, opts = {}) {
	const route = opts.route || null;
	const a = await open({ name: lead, touch: true, signIn: false, connect: false, route });
	a.account = lead; a.name = lead; a.touch = true;
	await gateUp(a);
	await signInAs(a, lead);
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	if (WAKE) await a.page.evaluate((m) => window.DaimondSync.wakeVia(m), WAKE);
	await newChat(a);
	// A chat and a parcel on the account before a peer joins, as a real account has.
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	const b = await open({ name: mate, signIn: false, connect: false, route });
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
	await b.page.evaluate((n) => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), n), mate);
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const idA = await a.page.evaluate(() => window.DaimondIdentity.deviceId());
	const aSeesB = await a.page.evaluate((self) => (window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer', aSeesB >= 1, 'awake peers: ' + aSeesB);
	return { a, b, idA };
}
