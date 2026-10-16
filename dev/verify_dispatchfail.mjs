// gateway: live
// verify_dispatchfail.mjs — UNBLOCK-1 DISPATCH-FAIL (D-20261013-02; rig laws I2 + I9), in
// real browsers on the real gateway: a phone (WebKit, iPhone UA, touch) hands a turn to
// its nominated runner (Chromium desktop), and the errand post is refused (the test
// answers the phone's /api/post with a 500, the rig's T1425 shape). The phone then runs the
// turn itself.
//
// From the refusal on -- the moment the post's answer reaches the phone -- a sampler on
// the phone records, every 50 ms until the answer is drawn, what a person sees:
//   F1  until the answer is drawn, the switch reads Here (pressed), never the runner it
//       never reached (after it, the switch offers the next turn's seat, the runner);
//   F2  the hand-off tile's header and status never name the runner ("Sending to X…",
//       "X is on it"), and name this device once they name anyone;
//   F3  no tile ever reads "hand-off to <this device>";
//   F4  the turn ran here and nowhere else, and its answer is drawn.
// Before the refusal the tile truthfully reads "Sending to <runner>…"; that is not judged.
// On d3c03d21 the tile reads "Sending to <runner>…" until the phone's own claim lands,
// and the switch stays on the runner.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.

import { open, signInAs, newChat, connectMock, checker } from './harness.mjs';
import { settle, until, nominateRunner, ROUTED_SW, switchOn, untilScreen } from './handoffpair.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { guardRan } from './verdict.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const GW_DIR    = new URL('../gateway', import.meta.url).pathname;
const ANSWER_MS = 90000;	// the local run's answer is drawn within this
const SLOW_MS   = 8000;		// the local run holds this long, so the sampler sees it running

const { ok, bad, check } = checker();
const tag = Date.now().toString(36).slice(-6);
const ACCT = 'hdf' + tag;
const RUNNER = 'hdfrun' + tag;

function watchWire(s) {
	s.model = [];
	s.page.on('request', (req) => {
		if (/\/chat\/completions/.test(req.url())) s.model.push({ at: Date.now(), raw: req.postData() || '' });
	});
}
const modelCarrying = (s, words) => s.model.filter((r) => r.raw.includes(words));

async function gateUp(s) {
	await s.page.waitForFunction(() => {
		const btn = document.getElementById('id-primary');
		if (btn && btn.offsetParent !== null) return true;
		try { return !!window.__DAIMOND_READY && window.DaimondIdentity.isUnlocked(); } catch (e) { return false; }
	}, null, { timeout: 90000 }).catch(() => {});
}
const authed = (pg) => pg.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
	&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 30000 }).catch(() => {});

async function joinDesk(a, mate) {
	const s = await open({ name: mate, signIn: false, connect: false, serviceWorkers: ROUTED_SW, browser: 'chromium' });
	s.account = ACCT; s.name = mate;
	watchWire(s);
	await s.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 90000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await s.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await gateUp(s);
	await signInAs(s, ACCT);
	await authed(s.page);
	await s.page.evaluate(() => window.DaimondDiag && DaimondDiag.set(true));
	await makePagePro(s.page, GW_DIR, GW_URL);
	await connectMock(s);
	await s.page.setViewportSize({ width: 1280, height: 900 });
	await s.page.waitForTimeout(2000);
	await settle(s.page);
	await until(s.page, () => { try { return window.DaimondPost.state().parks > 0; } catch (e) { return false; } }, null, 10000);
	await s.page.evaluate((n) => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), n), mate);
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	return s;
}

async function sendPhone(pg, text) {
	await pg.setViewportSize({ width: 420, height: 860 });
	await pg.waitForTimeout(300);
	await pg.fill('#chat-input', text);
	await pg.click('#chat-send');
}

async function dumpDiag(s, what) {
	const rows = await s.page.evaluate(() => (window.DaimondDiag ? DaimondDiag.rows() : [])
		.filter((r) => /dispatch|seat|hand|local|collect|errand/i.test(r.tag)).slice(-16)).catch(() => []);
	for (const r of rows) console.log('  ..    diag ' + what + ': ' + r.tag + ' ' + String(r.data || '').slice(0, 240));
}

let a, b;
try {
	a = await open({ name: ACCT, browser: 'webkit', touch: true, ua: IPHONE, signIn: false, connect: false,
		serviceWorkers: ROUTED_SW });
	a.account = ACCT; a.name = ACCT; a.touch = true;
	watchWire(a);
	await gateUp(a);
	await signInAs(a, ACCT);
	await authed(a.page);
	await a.page.evaluate(() => window.DaimondDiag && DaimondDiag.set(true));
	const pro = await makePagePro(a.page, GW_DIR, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await a.page.setViewportSize({ width: 1280, height: 900 });
	await newChat(a);
	const SEED = 'SEED' + tag + ' ready';
	await sendPhone(a.page, '@text ' + SEED);
	await until(a.page, (w) => document.getElementById('chat-output').innerText.split(w).length > 2, SEED, 30000);
	await settle(a.page);

	b = await joinDesk(a, RUNNER);
	await nominateRunner(check, a, b, RUNNER);
	await newChat(a);
	await a.page.setViewportSize({ width: 420, height: 860 });
	const onRunner = await untilScreen(a, async () => (await switchOn(a.page)) === 'runner', 60000);
	check('the switch offers the runner before the send', onRunner, 'switch ' + (await switchOn(a.page)));

	// THE REFUSAL: the phone's first errand post is answered 500, as the rig's store stall did.
	let refused = 0;
	await a.page.route('**/api/post', (route) => {
		const req = route.request();
		if (req.method() === 'POST' && refused === 0) {
			refused++;
			return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"store timeout"}' });
		}
		return route.continue();
	});
	// The sampler, and the moment the refusal reached the page (wrapping the transport's
	// answer, so every sample after it is judged).
	await a.page.evaluate(() => {
		const P = window.DaimondPost;
		const post0 = P.post;
		window.__df = { failAt: 0, samples: [] };
		P.post = async function () {
			const r = await post0.apply(this, arguments);
			if (r && !r.ok && !window.__df.failAt) window.__df.failAt = Date.now();
			return r;
		};
		const read = () => {
			const out = document.getElementById('chat-output');
			const tiles = out ? Array.from(out.querySelectorAll('.ctile[data-t="handoff"]')).filter((e) => e.getClientRects().length) : [];
			const who = tiles.map((e) => ((e.querySelector('.ctile-who') || {}).textContent || '').trim());
			const lab = tiles.map((e) => ((e.querySelector('.ti-label') || {}).textContent || '').trim());
			const r = document.getElementById('seat-runner'), h = document.getElementById('seat-here');
			const sw = (r && r.getClientRects().length && r.getAttribute('aria-pressed') === 'true') ? 'runner'
				: (h && h.getClientRects().length && h.getAttribute('aria-pressed') === 'true') ? 'here' : '';
			const all = out ? out.innerText.replace(/\s+/g, ' ') : '';
			const ho = (all.match(/hand-off to [^—·\n]*?didn.t finish/gi) || []);
			// `ans`: the answer is drawn, after which the switch offers the seat of the NEXT turn.
			window.__df.samples.push({ t: Date.now(), sw, who, lab, ho, ans: all.includes('Eventually.') });
		};
		window.__df.timer = setInterval(read, 50);
	});

	const W = 'DELTA' + tag + ' ran here';
	await sendPhone(a.page, '@slow ' + SLOW_MS + ' ' + W);
	// `@slow` answers "Eventually." (dev/mockllm.mjs), never the prompt's words, so the answer
	// drawn is that reply in this fresh chat.
	const drawn = await until(a.page, (w) => {
		const out = document.getElementById('chat-output');
		return !!out && out.innerText.includes(w) && out.innerText.includes('Eventually.')
			&& !/sent to your other/i.test(out.innerText);
	}, W, ANSWER_MS);
	await a.page.waitForTimeout(1500);
	const df = await a.page.evaluate(() => { clearInterval(window.__df.timer); return window.__df; });
	const after = df.samples.filter((s) => df.failAt && s.t > df.failAt);
	console.log('  ..    refused posts ' + refused + ', failAt ' + (df.failAt ? 'set' : 'unset') + ', samples after it ' + after.length);

	check('the post was refused and the phone saw it', refused === 1 && !!df.failAt, 'refused ' + refused);
	const running = after.filter((s) => !s.ans);		// from the refusal until the answer is drawn
	const swBad = running.filter((s) => s.sw === 'runner');
	check('F1 from the refusal until the answer the switch never reads the runner', running.length > 0 && swBad.length === 0,
		swBad.length + ' of ' + running.length + ' samples on the runner; first ' + JSON.stringify(swBad[0] || null));
	const swHere = running.filter((s) => s.sw === 'here').length;
	check('F1   and reads Here while the turn runs here', swHere > 0, swHere + ' of ' + running.length);
	const named = after.filter((s) => s.who.concat(s.lab).some((x) => x.includes(RUNNER)));
	check('F2 from the refusal on no hand-off header or status names the runner', after.length > 0 && named.length === 0,
		named.length + ' samples; first ' + JSON.stringify(named[0] || null));
	const allHo = df.samples.flatMap((s) => s.ho).filter((x) => !x.includes(RUNNER));
	check('F3 no tile ever reads "hand-off to <this device>"', allHo.length === 0, JSON.stringify(allHo.slice(0, 3)));
	const onA = modelCarrying(a, W).length, onB = modelCarrying(b, W).length;
	check('F4 the turn ran here, not on the runner, and its answer is drawn', drawn && onA >= 1 && onB === 0,
		'drawn ' + drawn + ', model requests A ' + onA + ' / B ' + onB);
	if (bad.length) {
		const show = after.filter((s, i) => i % 20 === 0).slice(0, 12).map((s) => [s.t - df.failAt, s.sw, s.who.join('|'), s.lab.join('|')]);
		console.log('  ..    samples (ms after refusal, switch, header, status): ' + JSON.stringify(show));
		await dumpDiag(a, 'phone');
	}

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	for (const s of [a, b]) { try { await s?.close(); } catch (e) { /* closing */ } }
}
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
