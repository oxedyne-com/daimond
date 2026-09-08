// verify_handoff_streaming.mjs — the incremental-streaming + cadence hand-off.
//
// The owner's two live complaints:
//   1. NON-STREAMING: a peer watching a handed-off turn sat BLANK until the runner
//      finished the WHOLE turn, then the completed turn synced over at once.
//   2. SLOW SYNC: the answer took minutes to reach the watching device.
//
// This drives two REAL paired WebKit contexts (the iOS engine) on the REAL gateway.
// A (a phone) dispatches a turn whose runner B streams a TOOL CALL and then a slow
// ~7 s answer (mock `@toolslow`). The properties proven:
//
//   STREAMING  — A sees the turn's TOOL tile in its store WHILE B is still streaming
//                the answer, i.e. BEFORE the final answer lands. On the old code A
//                saw nothing until the turn finished.
//   CADENCE    — the first streamed content reaches A well under the 45 s wake tick,
//                and A issues several /api/sync GETs during the run (the in-flight
//                expedite poll + the runner's progress-push wakes), not one at the end.
//   NO SHAKING — with A scrolled UP (not pinned to the bottom) during the stream, its
//                scrollTop is NOT yanked as the mid-turn re-renders arrive.
//   RECONCILE  — when the turn finishes, A shows the whole answer, the spinner clears,
//                and the tool tile is not duplicated.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs. Run under WebKit:
//   DAIMOND_BROWSER=webkit node dev/verify_handoff_streaming.mjs

import { open, chat, signInAs, newChat, connectMock, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

const RTMS = Number(process.env.RESCUE_MS || 90000);
const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});
const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());
async function until(pg, fn, arg, ms = 30000, step = 250) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true;
		await pg.waitForTimeout(step);
	}
	return false;
}
const allMsgs = (cs) => (cs || []).flatMap((c) => (c.messages || []));
// The streamed WORKING tile for the turn (a think_log), wherever it sits, and its length.
const thinkLogs = (cs) => allMsgs(cs).filter((m) => m && m.role === 'think_log');
const thinkLen = (cs) => thinkLogs(cs).reduce((n, m) => n + String(m.content || '').length, 0);
const answerText = (cs) => allMsgs(cs).filter((m) => m && m.role === 'assistant'
	&& m.content && /ANSWERWORD/i.test(m.content));

let a, b;
try {
	a = await open({ name: 'strlead', touch: true });
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	b = await open({ name: 'strmate', signIn: false, connect: false });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'strlead');
	await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.waitForTimeout(2000);
	await settle(b.page);

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices', !!idA && !!idB && idA !== idB, JSON.stringify({ idA, idB }));

	// B parked and awake so it collects and A sees it.
	await until(b.page, () => { try { return window.DaimondPost.state().parks > 0; } catch (e) { return false; } }, null, 8000);
	await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'strmate'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const aSeesB = await a.page.evaluate((self) => (window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer', aSeesB >= 1, 'awake peers: ' + aSeesB);

	// Count A's content pulls (GET /api/sync without ?presence) during the run — the
	// cadence signal. Wake polls (ms=) and presence GETs are excluded.
	let aPulls = 0;
	a.page.on('request', (req) => {
		try {
			const u = req.url();
			if (req.method() === 'GET' && /\/api\/sync(\?|$)/.test(u) && !/presence=/.test(u) && !/[?&]ms=/.test(u)) aPulls++;
		} catch (e) {}
	});

	console.log('\nStreaming — A dispatches a slow-thinking turn and watches it unfold');
	const newId = await newChat(a);
	// A SHORT phone viewport, so even the growing thinking tile overflows and the
	// thread can genuinely be scrolled up — the state the no-shake property is about.
	await a.page.setViewportSize({ width: 420, height: 380 });
	await a.page.waitForTimeout(300);

	// `@reasonslow <think> ;; <answer>`: ~50 thinking words stream at 120ms each (~6s),
	// growing ONE think_log tile in place (the harder receive path: a same-mid message
	// that lengthens, converging by the mergeMessages prefix rule and redrawn by a full
	// rebuild that must not yank the scroll), THEN the answer. So for ~6s a growing
	// WORKING tile is in the transcript and the answer is not — the watcher's window.
	const THINK_N = 100;
	const THINK = Array.from({ length: THINK_N }, (_, i) => 'reasoning' + (i + 1)).join(' ');
	const PROMPT = '@reasonslow ' + THINK + ' ;; ANSWERWORD the slow reasoning is done';
	const tDispatch = Date.now();
	aPulls = 0;
	await a.page.fill('#chat-input', PROMPT);
	await a.page.click('#chat-send', { force: true });

	// Poll A's STORE fast: catch a moment where the thinking is present and GROWING while
	// the final answer is not yet there.
	let sawWorkBeforeAnswer = false, tFirstWork = 0, grew = false, prevLen = 0;
	for (let i = 0; i < 200 && !grew; i++) {						// generous budget
		let cs = []; try { cs = await storedChats(a); } catch (e) { cs = []; }
		const tl = thinkLen(cs), ans = answerText(cs).length;
		if (tl > 0 && tFirstWork === 0) { tFirstWork = Date.now() - tDispatch; prevLen = tl; }
		if (tl > 0 && ans === 0) sawWorkBeforeAnswer = true;
		if (tl > prevLen && ans === 0) grew = true;					// grew in place, still mid-turn
		if (tl > prevLen) prevLen = tl;
		if (ans >= 1) break;
		await a.page.waitForTimeout(200);
	}
	check('STREAMING: A sees the turn\'s thinking mid-turn, BEFORE the final answer',
		sawWorkBeforeAnswer, 'first working tile at ' + tFirstWork + 'ms');
	if (grew) console.log('  ..    (also observed the thinking grow in place mid-turn on A)');
	check('CADENCE: streamed content reached A well under the 45s wake tick',
		tFirstWork > 0 && tFirstWork < 30000, 'first streamed tile at ' + tFirstWork + 'ms');

	// NO SHAKING — scroll A UP now (mid-stream) and hold; assert scrollTop is not yanked
	// as further mid-turn re-renders (full rebuilds of the growing thinking tile) arrive.
	const scrollable = await a.page.evaluate(() => {
		const el = document.getElementById('chat-output');
		if (!el) return false;
		el.scrollTop = 0;							// jump to the very top (scrolled up, not pinned)
		return el.scrollHeight - el.clientHeight > 20;
	});
	let scrollStable = true, scrollSamples = [];
	if (scrollable) {
		const top0 = await a.page.evaluate(() => document.getElementById('chat-output').scrollTop);
		for (let i = 0; i < 18; i++) {				// ~4s of watching while it streams
			await a.page.waitForTimeout(220);
			const st = await a.page.evaluate(() => document.getElementById('chat-output').scrollTop);
			scrollSamples.push(st);
			if (Math.abs(st - top0) > 24) scrollStable = false;		// a yank moved us
		}
		check('NO SHAKING: A\'s scrollTop is stable while scrolled up during the stream',
			scrollStable, 'top0=' + top0 + ' samples=' + JSON.stringify(scrollSamples.slice(0, 10)));
	} else {
		console.log('  ..    (thread not tall enough to scroll; scroll assertion inconclusive here)');
		bad.push('NO SHAKING: thread not scrollable (inconclusive)');
	}

	// RECONCILE — the turn finishes: the whole answer is on A, spinner cleared.
	const done = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /ANSWERWORD/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, RTMS);
	const finalCs = await storedChats(a);
	check('RECONCILE: A shows the whole answer and the spinner cleared', done,
		'answerMsgs=' + answerText(finalCs).length);
	// Exactly one think tile for the turn on A (the streamed copy is not doubled by the final push).
	const nThink = thinkLogs(finalCs).length;
	check('RECONCILE: the streamed thinking tile is not duplicated (exactly one)', nThink === 1, 'think_logs=' + nThink);
	// CONVERGENCE — the single think tile holds the WHOLE thinking, not a frozen partial
	// push. If the streamed-growth merge had frozen it at a first-seen length, the last
	// reasoning word would be missing. This is the deterministic end-to-end proof of the
	// mergeMessages prefix-growth rule through the real sync path.
	const finalThink = thinkLogs(finalCs).map((m) => String(m.content || '')).join(' ');
	const hasFirst = /\breasoning1\b/.test(finalThink), hasLast = new RegExp('\\breasoning' + THINK_N + '\\b').test(finalThink);
	check('CONVERGENCE: the reconciled thinking holds the WHOLE stream (not frozen partial)',
		hasFirst && hasLast, 'first=' + hasFirst + ' last(reasoning' + THINK_N + ')=' + hasLast
		+ ' len=' + finalThink.length);

	check('CADENCE: A issued multiple content pulls during the hand-off (not one at the end)',
		aPulls >= 2, 'A /api/sync content GETs during the run: ' + aPulls);

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { await b?.close(); } catch (e) {}
}
process.exit(bad.length ? 1 : 0);
