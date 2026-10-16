// gateway: live
// verify_handoff_first.mjs — UNBLOCK-1 HANDOFF-FIRST (D-20261013-02), in real browsers on
// the real gateway: a phone (WebKit, iPhone UA, touch) hands its turns to a desktop runner
// (Chromium), and in case 3 a second idle desktop (Chromium) sits beside them.
//
// Every check reads what a person would see or what a device actually did on the wire:
// the switch's rendered words, the answer drawn in the phone's transcript, the errand
// post leaving the phone, and which page sent the model request. No `force: true` here;
// the harness's own sign-in and new-chat plumbing is not under test.
//
//   CASE 1 (errand first). After a completed hand-off whose placeholder is dropped, the
//   person presses Retry on that turn and then sends a second turn while the phone's
//   parcel push is held (the flush never finishes). The errand must leave within 1 s,
//   the runner must run it, and the turn it sends the model must not carry the rows the
//   Retry removed (they reach the runner only as `gone`, the parcel being held).
//   On 289a2eb6 the post waits behind the flush (7ae6427e), so nothing leaves.
//
//   CASE 2 (one "reachable" test). The switch reads "Here | <runner>" while the runner
//   beats and listens, and plain "Here" once it still beats but has stopped listening
//   (its park loop stopped with `DaimondPost.parkStop`, the dead-listener shape).
//
//   CASE 3 (only the named runner). With the switch on a runner busy with this chat, a
//   turn sent from the phone queues there; a second idle desktop never takes it (the
//   14:03 fault, 13 Oct). 3d: two turns sent while one runs both run there.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs.

import { open, signInAs, newChat, connectMock, checker } from './harness.mjs';
import { settle, until, storedMsgs, nominateRunner, ROUTED_SW, switchOn, untilScreen } from './handoffpair.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { guardRan } from './verdict.mjs';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
	+ '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const GW_DIR    = new URL('../gateway', import.meta.url).pathname;
const POST_MS   = 1000;		// the errand must leave within this of the press
const ANSWER_MS = 60000;	// a handed-off answer reaches the phone within this
const DEAF_MS   = 180000;	// a stopped listener ages out of the 90 s window, plus beats
const BUSY_SLOW = 25000;	// case 3: the runner's first turn holds it this long

const { ok, bad, check } = checker();
const tag = Date.now().toString(36).slice(-6);
const ACCT = 'hff' + tag;

// ── what a person sees ──────────────────────────────────────────────────────────────

/// The words the switch shows, or '' when it is not drawn. Rendered-box test, then the
/// rendered text: a segment that is not laid out contributes nothing.
const switchText = (pg) => pg.evaluate(() => {
	const el = document.getElementById('seat-switch');
	if (!el || !el.getClientRects().length) return '';
	return el.innerText.replace(/\s+/g, ' ').trim();
}).catch(() => '');

/// How many times the transcript on screen shows `words` as an answer (not inside the
/// prompt that asked for it, which carries them after "@text ").
const answersShown = (pg, words) => pg.evaluate((w) => {
	const out = document.getElementById('chat-output');
	if (!out) return 0;
	const txt = out.innerText;
	let n = 0, at = txt.indexOf(w);
	while (at >= 0) {
		if (!/@text\s*$/.test(txt.slice(Math.max(0, at - 8), at))) n++;
		at = txt.indexOf(w, at + w.length);
	}
	return n;
}, words).catch(() => 0);

const placeholderShown = (pg) => pg.evaluate(() => {
	const out = document.getElementById('chat-output');
	return !!out && /sent to your other/i.test(out.innerText);
}).catch(() => false);

/// Send from the composer as the person does, at a phone's width. A real click: a
/// control the person could not press fails here rather than being pressed for them.
async function sendPhone(pg, text) {
	await pg.setViewportSize({ width: 420, height: 860 });
	await pg.waitForTimeout(300);
	await pg.fill('#chat-input', text);
	await pg.click('#chat-send');
}

// ── what each device did on the wire ────────────────────────────────────────────────

/// Every model request a page sends, with its body, and every errand post it makes.
function watchWire(s) {
	s.model = []; s.posts = [];
	s.page.on('request', (req) => {
		const u = req.url();
		if (/\/chat\/completions/.test(u)) {
			let body = null;
			try { body = JSON.parse(req.postData() || 'null'); } catch (e) { body = null; }
			s.model.push({ at: Date.now(), body, raw: req.postData() || '' });
		} else if (req.method() === 'POST' && /\/api\/post$/.test(u)) {
			s.posts.push(Date.now());
		}
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

/// A desktop (Chromium) paired to the phone's account, awake, parked and beating.
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


/// The phone's dispatch decisions, printed where a hand-off check fails.
async function dumpDiag(s, what) {
	const rows = await s.page.evaluate(() => (window.DaimondDiag ? DaimondDiag.rows() : [])
		.filter((r) => /dispatch|seat|hand|queue|local|reconstruct|collect|errand|retry|gone/i.test(r.tag)).slice(-16)).catch(() => []);
	for (const r of rows) console.log('  ..    diag ' + what + ': ' + r.tag + ' ' + String(r.data || '').slice(0, 280));
}

let a, b, c;
try {
	// ── A: the phone. WebKit, an iPhone's UA, touch. ──
	a = await open({ name: ACCT, browser: 'webkit', touch: true, ua: IPHONE, signIn: false, connect: false,
		serviceWorkers: ROUTED_SW });
	a.account = ACCT; a.name = ACCT; a.touch = true;
	watchWire(a);
	await gateUp(a);
	await signInAs(a, ACCT);
	await authed(a.page);
	// The phone's own decision log, read back where a hand-off check fails.
	await a.page.evaluate(() => window.DaimondDiag && DaimondDiag.set(true));
	const pro = await makePagePro(a.page, GW_DIR, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await a.page.setViewportSize({ width: 1280, height: 900 });
	await newChat(a);
	// A chat and a parcel on the account before a peer joins, as a real account has.
	const SEED = 'SEED' + tag + ' ready';
	await sendPhone(a.page, '@text ' + SEED);
	await until(a.page, (w) => document.getElementById('chat-output').innerText.split(w).length > 2, SEED, 30000);
	await settle(a.page);

	// ── B: the runner. Chromium desktop, nominated and armed. ──
	b = await joinDesk(a, 'hffrun' + tag);
	const idB = await nominateRunner(check, a, b, 'hffrun' + tag);
	const mobileA = await a.page.evaluate(() => {
		try { return window.DaimondPresence.snapshot()[window.DaimondIdentity.deviceId()]; } catch (e) { return null; }
	});
	console.log('  ..    A presence row: ' + JSON.stringify(mobileA));

	// ═══════════════════════════════════════════════════════════════════════════
	// CASE 1 — the errand goes first, and the runner drops what Retry removed.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n— case 1: errand first after a completed hand-off and a Retry —');
	await a.page.setViewportSize({ width: 1280, height: 900 });
	await newChat(a);
	const W1 = 'ALPHA' + tag + ' first answer';
	// As a person would: send once the switch offers the runner. A runner that has just
	// joined is not offered until its first listening beat reaches the phone.
	await a.page.setViewportSize({ width: 420, height: 860 });
	const onRunner1 = await untilScreen(a, async () => (await switchOn(a.page)) === 'runner', 30000);
	if (!onRunner1) console.log('  ..    switch before turn 1: ' + JSON.stringify(await switchText(a.page)));
	await sendPhone(a.page, '@text ' + W1);
	const done1 = await until(a.page, (w) => {
		const out = document.getElementById('chat-output');
		if (!out || /sent to your other/i.test(out.innerText)) return false;
		return out.innerText.split(w).length > 2;
	}, W1, ANSWER_MS);
	const ranOnB1 = modelCarrying(b, W1).length, ranOnA1 = modelCarrying(a, W1).length;
	check('1a hand-off 1 completes on the runner: answer on the phone, placeholder gone',
		done1 && ranOnB1 >= 1 && ranOnA1 === 0,
		'answers on A ' + (await answersShown(a.page, W1)) + ', placeholder shown ' + (await placeholderShown(a.page))
		+ ', model requests from B ' + ranOnB1 + ' / A ' + ranOnA1);
	if (!(done1 && ranOnB1 >= 1 && ranOnA1 === 0)) await dumpDiag(a, 'turn 1');
	await settle(a.page);
	await settle(b.page);
	await a.page.waitForTimeout(2000);

	// The rows Retry is about to remove, as A holds them (turn 1's question and answer).
	const before1 = (await storedMsgs(a)).filter((m) => String(m.content || '').includes(W1) && !m.why);
	const oldMids = before1.map((m) => String(m.mid));
	const bHeld = (await storedMsgs(b)).filter((m) => oldMids.includes(String(m.mid))).length;
	console.log('  ..    turn-1 rows on A: ' + oldMids.length + ', of which B holds ' + bHeld);

	// THE STALL. Every push from A (a non-GET to /api/sync) is held,
	// unanswered, until the case ends: the flush never finishes. Reads pass.
	const held = [];
	const stall = (route) => {
		const req = route.request();
		if (req.method() !== 'GET') { held.push(route); return; }
		return route.continue();
	};
	await a.page.route('**/api/sync**', stall);

	// Retry, pressed on the last question's own control, as the person does.
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(300);
	const retryBtn = a.page.locator('#chat-output .chat-msg-user .ctile-retry').last();
	let retried = true;
	try { await retryBtn.click({ timeout: 10000 }); } catch (e) { retried = false; console.log('  ..    retry press: ' + (e && e.message || e).split('\n')[0]); }
	// The retry runs here (the ↻ path is not routed) and answers again.
	const reAnswered = await until(a.page, () => {
		const b0 = document.getElementById('chat-send');
		const t = b0 ? (b0.getAttribute('title') || '') + b0.className : '';
		return !/stop/i.test(t);
	}, null, 30000);
	await a.page.waitForTimeout(1500);
	const tombed = await a.page.evaluate((ids) => {
		try { const t = window.DaimondCore && window.DaimondCore.msgTombs ? window.DaimondCore.msgTombs() : null; return t ? ids.filter((i) => t[i]).length : -1; }
		catch (e) { return -1; }
	}, oldMids);
	const afterRetry = (await storedMsgs(a)).filter((m) => oldMids.includes(String(m.mid))).length;
	check('1b Retry removed turn 1\'s rows on the phone, and its parcel is held',
		retried && reAnswered && oldMids.length >= 2 && afterRetry === 0,
		'pressed ' + retried + ', old rows left on A ' + afterRetry + ' of ' + oldMids.length
		+ ', tombstoned ' + tombed + ', pushes held so far ' + held.length
		+ ', answers on A ' + (await answersShown(a.page, W1)));

	const rowsOf = async (s, w) => (await storedMsgs(s)).filter((m) => String(m.content || '').includes(w) || String(m.itext || '').includes(w))
		.map((m) => [m.role, String(m.mid || '').slice(0, 14), String(m.iturn || '').slice(0, 14), m.why || '', String(m.content || '').slice(0, 12)].join('/'));
	console.log('  ..    W1 rows before send 2: A ' + JSON.stringify(await rowsOf(a, W1)) + ' B ' + JSON.stringify(await rowsOf(b, W1)) + ' old ' + JSON.stringify(oldMids));
	// The second send, with the flush still held.
	const W2 = 'BRAVO' + tag + ' second answer';
	const postsBefore = a.posts.length;
	const t2 = Date.now();
	await sendPhone(a.page, '@text ' + W2);
	for (let i = 0; i < 40 && a.posts.length === postsBefore; i++) await a.page.waitForTimeout(100);
	const firstPost = a.posts.length > postsBefore ? a.posts[postsBefore] - t2 : -1;
	check('1c the errand leaves the phone within 1 s of Send, the flush still held',
		firstPost >= 0 && firstPost <= POST_MS,
		firstPost >= 0 ? 'errand posted at +' + firstPost + ' ms' : 'no errand post within 4 s; pushes held ' + held.length);

	const done2 = await until(a.page, (w) => {
		const out = document.getElementById('chat-output');
		if (!out || /sent to your other/i.test(out.innerText)) return false;
		return out.innerText.split(w).length > 2;
	}, W2, ANSWER_MS);
	const reqB2 = modelCarrying(b, W2), reqA2 = modelCarrying(a, W2);
	check('1d the runner answers it: the answer is drawn on the phone, and B (not A) asked the model',
		done2 && reqB2.length >= 1 && reqA2.length === 0,
		'answers on A ' + (await answersShown(a.page, W2)) + ', model requests from B ' + reqB2.length + ' / A ' + reqA2.length
		+ ', pushes held ' + held.length);

	// What the runner sent the model for turn 2: turn 1 once (the retry's), never the
	// removed copy beside it.
	const msgs2 = (reqB2[0] && reqB2[0].body && reqB2[0].body.messages) || [];
	const said = (m) => typeof m.content === 'string' ? m.content
		: Array.isArray(m.content) ? m.content.map((p) => p && (p.text || '')).join(' ') : '';
	const q1 = msgs2.filter((m) => m.role === 'user' && said(m).includes(W1)).length;
	const a1 = msgs2.filter((m) => m.role === 'assistant' && said(m).includes(W1)).length;
	const bStill = (await storedMsgs(b)).filter((m) => oldMids.includes(String(m.mid))).length;
	if (!(q1 === 1 && a1 === 1)) {
		console.log('  ..    turn-2 request: ' + JSON.stringify(msgs2.map((m) => m.role + ':' + said(m).slice(0, 48))));
		console.log('  ..    W1 rows after turn 2: A ' + JSON.stringify(await rowsOf(a, W1)) + ' B ' + JSON.stringify(await rowsOf(b, W1)));
		await dumpDiag(b, 'B turn 2');
	}
	check('1e the runner\'s rebuilt turn leaves out the rows Retry removed',
		reqB2.length >= 1 && q1 === 1 && a1 <= 1 && bStill === 0,
		'turn-2 request: turn-1 question ' + q1 + 'x, answer ' + a1 + 'x, ' + msgs2.length
		+ ' messages; removed rows still on B ' + bStill + ' (held before: ' + bHeld + ')');

	// Release the parcel.
	await a.page.unroute('**/api/sync**', stall);
	for (const r of held) { try { await r.continue(); } catch (e) { /* the page moved on */ } }
	await settle(a.page);

	// ═══════════════════════════════════════════════════════════════════════════
	// CASE 2 — the switch offers the runner only while it listens.
	// ═══════════════════════════════════════════════════════════════════════════
	if (process.env.HFF_ONLY === '1') throw new Error('HFF_ONLY=1: stopped after case 1');
	if (process.env.HFF_SKIP2 !== '1') {
	console.log('\n— case 2: "Here | <runner>" only while the runner listens —');
	await a.page.setViewportSize({ width: 420, height: 860 });
	const label = await a.page.evaluate((id) => {
		try { return (window.DaimondPresence.snapshot()[id] || {}).name || ''; } catch (e) { return ''; }
	}, idB);
	const offered = await untilScreen(a, async () => / /.test(await switchText(a.page))
		&& (await switchText(a.page)).startsWith('Here'), 20000);
	const sw2a = await switchText(a.page);
	check('2a the switch reads "Here | <runner>" while B beats and listens',
		offered && sw2a !== 'Here' && sw2a.length > 'Here'.length, 'switch: ' + JSON.stringify(sw2a) + ' (B is ' + JSON.stringify(label) + ')');

	await b.page.evaluate(() => window.DaimondPost.parkStop());
	const tDeaf = Date.now();
	const deaf = await untilScreen(a, async () => (await switchText(a.page)) === 'Here', DEAF_MS, 3000);
	const sw2b = await switchText(a.page);
	const bState = await b.page.evaluate(() => ({ parking: window.DaimondPost.parking().on,
		servicing: window.DaimondPost.servicing() })).catch(() => null);
	const beatAge = await a.page.evaluate((id) => {
		try { const r = window.DaimondPresence.snapshot()[id]; return r ? Date.now() - r.lastSeen : -1; } catch (e) { return -1; }
	}, idB);
	const svAt = await a.page.evaluate((id) => {
		try { const r = window.DaimondPresence.snapshot()[id]; return r && r.servicedAt != null ? Date.now() - r.servicedAt : 'absent'; } catch (e) { return 'err'; }
	}, idB);
	check('2b the switch reads plain "Here" once B beats but no longer listens',
		deaf && beatAge >= 0 && beatAge <= 90000,
		'switch ' + JSON.stringify(sw2b) + ' after ' + Math.round((Date.now() - tDeaf) / 1000) + ' s; B on A: beat '
		+ Math.round(beatAge / 1000) + ' s ago, serviced ' + (typeof svAt === 'number' ? Math.round(svAt / 1000) + ' s ago' : svAt)
		+ '; B itself ' + JSON.stringify(bState));

	await b.page.evaluate(() => window.DaimondPost.parkStart());
	const back = await untilScreen(a, async () => (await switchText(a.page)) === sw2a, DEAF_MS, 3000);
	check('2c control: the runner is offered again once it listens again', back,
		'switch: ' + JSON.stringify(await switchText(a.page)));
	}	// HFF_SKIP2=1 skips case 2 (a diagnostic run of case 3 alone)

	// ═══════════════════════════════════════════════════════════════════════════
	// CASE 3 — a second idle desktop never takes a turn named for the busy runner.
	// ═══════════════════════════════════════════════════════════════════════════
	console.log('\n— case 3: the named runner, busy; a second idle desktop —');
	c = await joinDesk(a, 'hffidle' + tag);
	const cSeen = await a.page.evaluate(() => Object.keys(window.DaimondPresence.snapshot()).length);
	console.log('  ..    presence rows on A: ' + cSeen);
	await a.page.setViewportSize({ width: 420, height: 860 });
	const W3 = 'CHARLIE' + tag + ' busy turn';
	const onRunner3 = await untilScreen(a, async () => (await switchOn(a.page)) === 'runner', 20000);
	await sendPhone(a.page, '@slow ' + BUSY_SLOW + ' ' + W3);
	const busy = await (async () => {
		for (let i = 0; i < 60; i++) { if (modelCarrying(b, W3).length) return true; await b.page.waitForTimeout(500); }
		return false;
	})();
	// Let B's beat say it is busy, so the phone and C both read it so.
	await b.page.waitForTimeout(3000);
	const sw3 = await switchText(a.page), on3 = await switchOn(a.page);
	check('3a the runner is running this chat\'s turn, and the switch still names it',
		onRunner3 && busy && on3 === 'runner' && sw3.length > 'Here'.length,
		'switch ' + JSON.stringify(sw3) + ' on ' + on3 + '; busy turn asked by B ' + modelCarrying(b, W3).length
		+ ' / C ' + modelCarrying(c, W3).length + ' / A ' + modelCarrying(a, W3).length);

	const W4 = 'DELTA' + tag + ' queued answer';
	await sendPhone(a.page, '@text ' + W4);
	const done4 = await until(a.page, (w) => {
		const out = document.getElementById('chat-output');
		return !!out && out.innerText.split(w).length > 2;
	}, W4, BUSY_SLOW + ANSWER_MS);
	await a.page.waitForTimeout(3000);
	const r4 = { B: modelCarrying(b, W4).length, C: modelCarrying(c, W4).length, A: modelCarrying(a, W4).length };
	check('3b the queued turn runs on the named runner and is drawn on the phone',
		done4 && r4.B >= 1 && r4.A === 0, 'answers on A ' + (await answersShown(a.page, W4)) + ', model requests ' + JSON.stringify(r4));
	if (!(done4 && r4.B >= 1 && r4.A === 0)) { await dumpDiag(a, 'turn 4'); await dumpDiag(b, 'B turn 4'); }
	check('3c the second idle desktop never takes it', r4.C === 0,
		'model requests from C ' + r4.C);

	// 3d: TWO follow-ups queued behind one running turn. The phone sends W6 and then W7
	// while W5 still runs on B, so W7's thread lacks both W5's and W6's answers; B must
	// run both, and neither the phone nor C runs either (check_fix2 claim 4).
	await settle(a.page);
	const W5 = 'ECHO' + tag + ' busy again';
	// What the phone's screen shows over the case, once a second: the busy answer and W6's.
	const seen = [], t5 = Date.now();
	let sampling = true;
	const sampler = (async () => {
		while (sampling) {
			const n = await a.page.evaluate(() => ((document.getElementById('chat-output') || {}).innerText || '').split('Eventually').length - 1).catch(() => -1);
			const row = [Math.round((Date.now() - t5) / 1000), n, await answersShown(a.page, 'FOXTROT' + tag)];
			if (!seen.length || seen[seen.length - 1][1] !== row[1] || seen[seen.length - 1][2] !== row[2]) seen.push(row);
			await a.page.waitForTimeout(1000);
		}
	})();
	const onRunner5 = await untilScreen(a, async () => (await switchOn(a.page)) === 'runner', 20000);
	await sendPhone(a.page, '@slow ' + BUSY_SLOW + ' ' + W5);
	const busy5 = await (async () => {
		for (let i = 0; i < 60; i++) { if (modelCarrying(b, W5).length) return true; await b.page.waitForTimeout(500); }
		return false;
	})();
	await b.page.waitForTimeout(3000);
	const W6 = 'FOXTROT' + tag + ' first queued', W7 = 'GOLF' + tag + ' second queued';
	await sendPhone(a.page, '@text ' + W6);
	await a.page.waitForTimeout(1500);
	await sendPhone(a.page, '@text ' + W7);
	const drawn = (w) => until(a.page, (x) => {
		const out = document.getElementById('chat-output');
		return !!out && out.innerText.split(x).length > 2;
	}, w, BUSY_SLOW + ANSWER_MS);
	const done6 = await drawn(W6), done7 = await drawn(W7);
	await a.page.waitForTimeout(3000);
	const ran = (w) => ({ B: modelCarrying(b, w).length, C: modelCarrying(c, w).length, A: modelCarrying(a, w).length });
	sampling = false; await sampler;
	const r6 = ran(W6), r7 = ran(W7);
	const shown6 = await answersShown(a.page, W6), shown7 = await answersShown(a.page, W7);
	const ok3d = onRunner5 && busy5 && done6 && done7 && shown6 === 1 && shown7 === 1
		&& r6.B >= 1 && r7.B >= 1 && r6.A + r6.C + r7.A + r7.C === 0;
	check('3d two follow-ups queued behind one running turn both run on the runner and are drawn on the phone',
		ok3d, 'busy ' + busy5 + ', drawn ' + done6 + '/' + done7 + ' (answers on A ' + shown6 + '/' + shown7
		+ '), model requests W6 ' + JSON.stringify(r6) + ', W7 ' + JSON.stringify(r7));
	if (!ok3d) {
		const screen = await a.page.evaluate((t) => (document.getElementById('chat-output') || {}).innerText || '', tag).catch(() => '');
		console.log('  ..    screen from ECHO: ' + JSON.stringify(screen.slice(Math.max(0, screen.indexOf('ECHO' + tag) - 10)).slice(0, 900)));
		console.log('  ..    screen over time [s, "Eventually" count, W6 answers]: ' + JSON.stringify(seen));
		for (const [who, s] of [['A', a], ['B', b]]) {
			const rows = (await storedMsgs(s)).filter((m) => (m.ts || 0) >= t5 - 5000).map((m) => [m.role, String(m.mid || '').slice(0, 10),
				String(m.iturn || '').slice(0, 10), m.why || '', m.interrupted ? 'int' : '', m.ranOn ? 'on' + String(m.ranOn).slice(0, 6) : '',
				String(m.content || '').slice(0, 24)].join('/'));
			console.log('  ..    ' + who + ' stored rows since W5: ' + JSON.stringify(rows));
		}
		await dumpDiag(a, 'turns 6-7'); await dumpDiag(b, 'B turns 6-7');
	}

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	for (const s of [a, b, c]) { try { await s?.close(); } catch (e) { /* closing */ } }
}
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
