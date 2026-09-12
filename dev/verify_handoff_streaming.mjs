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
// And since the progress door (2026-09-12), four more — the door's own properties,
// because "A saw something eventually" was true of the old whole-parcel stream too:
//
//   LATENCY    — A's first STREAMED FRAME is on screen within 5 s of the runner
//                producing its first token. The old path's first sight of a turn was a
//                whole-parcel round trip away, and on a 409 never came at all.
//   FRAME SIZE — every frame on the wire is under the door's 64 KiB ceiling. The old
//                path sent the WHOLE account parcel per frame, so this is the property
//                that says the cost went with the latency.
//   FRAMES     — several frames land during one turn (a stream, not one update), and
//                the runner sends FRAMES rather than mid-turn parcel pushes.
//   SAME TEXT  — A's finished transcript is the runner's, so the streamed view
//                converged on the answer rather than merely looking busy.
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
// The streamed tail as A has it ON SCREEN -- a frame's own destination, which the
// store does not hold, because a frame is a view and not a message.
const streamedOf = (pg) => pg.evaluate(() => {
	const el = document.querySelector('.handoff-stream');
	return el ? String(el.textContent || '') : '';
});
// The thread as a reader sees it, for the "A's transcript is the runner's" property.
const threadText = (pg) => pg.evaluate(() => {
	const out = document.getElementById('chat-output');
	return out ? String(out.innerText || '') : '';
});
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
			if (req.method() === 'GET' && /\/api\/sync(\?|$)/.test(u) && !/presence=/.test(u)
				&& !/[?&]ms=/.test(u) && !/progress=/.test(u)) aPulls++;
		} catch (e) {}
	});

	// THE FRAMES ON THE WIRE. Every PUT the runner makes to the progress door, with the
	// size of its body -- what the 64 KiB property is about -- and separately every
	// mid-turn PARCEL push it makes, which is what the frames are supposed to have
	// replaced. Counted from the requests themselves, so neither number can be the
	// client's opinion of what it did.
	const frames = [];				// { bytes, at } per frame B sent
	let bParcelPushes = 0;			// whole-parcel pushes B made during the turn
	const bParcelBytes = [];		// and what each of them cost, for the comparison
	b.page.on('request', (req) => {
		try {
			const u = req.url(), m = req.method();
			if (!/\/api\/sync(\?|$)/.test(u)) return;
			if (/progress=/.test(u)) {
				if (m === 'PUT' || m === 'POST') {
					let n = 0;
					try { n = (req.postData() || '').length; } catch (e) { n = 0; }
					frames.push({ bytes: n, at: Date.now() });
				}
				return;
			}
			if (m === 'PUT' || m === 'POST') {
				bParcelPushes++;
				try { bParcelBytes.push((req.postData() || '').length); } catch (e) {}
			}
		} catch (e) {}
	});
	// A's reads of the door, so a frame drawn is a frame that was fetched.
	let aFrameReads = 0;
	a.page.on('request', (req) => {
		try { if (/\/api\/sync\?/.test(req.url()) && /progress=/.test(req.url())) aFrameReads++; }
		catch (e) {}
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
	// AND A SLOWLY STREAMED ANSWER after the thinking, because a count is not a
	// transcript. With a short answer the streamed view is `[thinking N chars]` and
	// nothing else, and a first run of this check passed on exactly that -- a reader
	// watching a counter, which is not what the owner asked for. The answer's own words
	// have to reach A while the turn is running, so there have to be some.
	const SAY_N = 60;
	const SAY = Array.from({ length: SAY_N }, (_, i) => 'word' + (i + 1)).join(' ');
	const PROMPT = '@reasonslow ' + THINK + ' ;; ' + SAY + ' ANSWERWORD the slow reasoning is done';
	const tDispatch = Date.now();
	aPulls = 0;
	await a.page.fill('#chat-input', PROMPT);
	await a.page.click('#chat-send', { force: true });

	// Poll A fast, on BOTH paths at once, because the streamed view and the stored
	// transcript are now different things and only one of them is the door:
	//
	//   THE SCREEN — `.handoff-stream`, the tail the runner has sent, which exists only
	//     while the turn is running. This is what the progress door delivers, and it has
	//     to be sampled DURING the turn: after the answer merges the node is gone, so a
	//     check made afterwards would find nothing and report a working door as broken.
	//   THE STORE — the think_log in A's own chats, which arrives with a PARCEL. The
	//     progress tick no longer pushes parcels, so this is no longer the mid-turn
	//     signal; it is the reconciliation, asserted further down.
	let sawScreenBeforeAnswer = false, tFirstScreen = 0, screenGrew = false, screenLen = 0;
	let sawWorkBeforeAnswer = false, tFirstWork = 0, grew = false, prevLen = 0;
	let screened = '';
	for (let i = 0; i < 260; i++) {									// generous budget
		let cs = []; try { cs = await storedChats(a); } catch (e) { cs = []; }
		const tl = thinkLen(cs), ans = answerText(cs).length;
		let shot = ''; try { shot = await streamedOf(a.page); } catch (e) { shot = ''; }
		if (shot) {
			if (!tFirstScreen) { tFirstScreen = Date.now(); screened = shot; }
			if (!ans) sawScreenBeforeAnswer = true;
			if (shot.length > screenLen) { if (screenLen) screenGrew = true; screenLen = shot.length; }
			screened = shot;
		}
		if (tl > 0 && tFirstWork === 0) { tFirstWork = Date.now() - tDispatch; prevLen = tl; }
		if (tl > 0 && ans === 0) sawWorkBeforeAnswer = true;
		if (tl > prevLen && ans === 0) grew = true;					// grew in place, still mid-turn
		if (tl > prevLen) prevLen = tl;
		if (ans >= 1) break;
		await a.page.waitForTimeout(200);
	}
	check('STREAMING: A sees the turn ON SCREEN mid-turn, BEFORE the final answer',
		sawScreenBeforeAnswer, 'first streamed frame on screen at +'
		+ (tFirstScreen ? tFirstScreen - tDispatch : -1) + 'ms, '
		+ JSON.stringify(screened.slice(0, 100)));
	if (screenGrew) console.log('  ..    (the streamed view also GREW in place as frames arrived)');
	if (grew) console.log('  ..    (the stored thinking grew in place mid-turn on A as well)');
	check('CADENCE: the streamed view reached A well under the 45s wake tick',
		tFirstScreen > 0 && (tFirstScreen - tDispatch) < 30000,
		'on screen at +' + (tFirstScreen ? tFirstScreen - tDispatch : -1) + 'ms; '
		+ 'the stored transcript followed at +' + tFirstWork + 'ms');

	// ── The progress door's own four properties ────────────────
	//
	// Measured, and reported as numbers whether they pass or fail: the point of the
	// door is how SOON and how CHEAPLY the watcher sees the turn, and a pass with no
	// figure beside it says nothing about either.
	const tFirstFrame = frames.length ? (frames[0].at - tDispatch) : 0;
	const maxFrame    = frames.reduce((n, f) => Math.max(n, f.bytes), 0);
	// THE DOOR'S LATENCY, measured between two things on ONE clock: the runner's first
	// frame leaving (seen on the wire, in this process) and that frame being on A's
	// screen (seen in the loop above). The runner's own DOM is deliberately NOT the
	// reference -- a runner is a background device and need not be displaying the chat
	// at all, so its screen says nothing about when it had a token. Its FRAME does:
	// the frame is built from the transcript it has rendered.
	const latency = (frames.length && tFirstScreen) ? (tFirstScreen - frames[0].at) : -1;
	check('LATENCY: A has the runner\'s first frame on screen within 5s of it being sent',
		latency >= 0 && latency < 5000,
		'frame sent at +' + tFirstFrame + 'ms, on A\'s screen at +'
		+ (tFirstScreen ? tFirstScreen - tDispatch : -1) + 'ms, latency ' + latency + 'ms');
	check('FRAME SIZE: every frame on the wire is under the door\'s 64 KiB ceiling',
		frames.length > 0 && maxFrame > 0 && maxFrame <= 64 * 1024,
		frames.length + ' frame(s), largest ' + maxFrame + ' bytes, first at +' + tFirstFrame + 'ms');
	check('STREAMED VIEW: what A draws is the turn as the runner rendered it',
		/\[thinking \d+ chars\]/.test(screened),
		'on A\'s screen: ' + JSON.stringify(screened.slice(0, 120)));
	// THE DAIMON'S OWN WORDS, mid-turn, on the device that asked. This is the owner's
	// requirement in one line: the answer being produced elsewhere is readable here
	// while it is being produced. A thinking count alone would satisfy everything above
	// it and none of what was asked for.
	check('STREAMED VIEW: the answer\'s own words reach A while the runner is still writing',
		/\bword1\b/.test(screened) && !/ANSWERWORD/.test(screened),
		'on A\'s screen: ' + JSON.stringify(screened.slice(-120)));

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

	// BACK TO A PHONE'S OWN HEIGHT before anything reads the thread as a reader sees
	// it. The 380px window above exists for ONE property -- the thread has to overflow
	// for "scrolled up" to mean anything -- and no phone is that shape: an iPhone is 844
	// tall. It also defeats the measurement. `innerText` is the rendered text, and at
	// 380px the composer furniture leaves `#chat-output` 39px, which is less than one
	// line of the tile inside it; WebKit then answers `innerText` with '' for the whole
	// subtree while `textContent` holds all 77 KB of it and the answer tile is laid out
	// 332px tall. Measured 2026-09-12: at 420x380 WebKit gives 0 characters and at
	// 420x860 the same DOM gives them all. So every screen read below happens at a
	// height a phone has, and what it finds is the app's doing rather than the engine's
	// clipping -- a check that went red here would otherwise be reporting a viewport.
	await a.page.setViewportSize({ width: 420, height: 860 });
	await a.page.waitForTimeout(400);

	// RECONCILE — the turn finishes: the whole answer is on A, spinner cleared.
	const done = await until(a.page, () => {
		const out = document.getElementById('chat-output');
		const txt = out ? out.innerText : '';
		return /ANSWERWORD/i.test(txt) && !/sent to your other/i.test(txt);
	}, null, RTMS);
	const finalCs = await storedChats(a);
	// AND THE READ WAS CAPABLE OF SEEING SOMETHING. A screen assertion on an empty box
	// proves nothing either way, so the box is asserted to have a line in it: a future
	// layout that collapses the thread again fails HERE, naming the height, instead of
	// arriving as "the answer never rendered".
	const outH = await a.page.evaluate(() => {
		const el = document.getElementById('chat-output');
		return el ? el.clientHeight : -1;
	});
	check('RECONCILE: the reader\'s thread is tall enough for a screen read to mean anything',
		outH >= 100, '#chat-output clientHeight=' + outH + 'px at 420x860');
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

	check('FRAMES: the turn streamed as SEVERAL frames, not one update at the end',
		frames.length >= 2, 'frames the runner sent: ' + frames.length
		+ ' (sizes ' + JSON.stringify(frames.map((f) => f.bytes).slice(0, 8)) + ')');
	check('FRAMES: A actually read the door (a frame drawn is a frame fetched)',
		aFrameReads >= 1, 'A\'s progress reads: ' + aFrameReads);
	// THE COST, in bytes rather than in pushes. A count of parcel pushes is the wrong
	// measure and a first run of this check said so: the ordinary sync engine pushes on
	// its own cadence through a turn, so ten parcel pushes can be nothing to do with
	// the progress tick. What the door changed is the SIZE of what a frame costs -- it
	// used to be a whole parcel -- so that is what is asserted: a frame is a fraction
	// of a parcel push, on this run's own numbers.
	const avgFrame  = frames.length ? Math.round(frames.reduce((n, f) => n + f.bytes, 0) / frames.length) : 0;
	const avgParcel = bParcelBytes.length
		? Math.round(bParcelBytes.reduce((n, b) => n + b, 0) / bParcelBytes.length) : 0;
	check('COST: a frame costs less than a parcel push, and the LARGEST frame still does',
		avgFrame > 0 && avgParcel > 0 && maxFrame < avgParcel,
		'frame ' + avgFrame + ' bytes average, ' + maxFrame + ' bytes largest, against a parcel push of '
		+ avgParcel + ' bytes average -- ' + (avgParcel / Math.max(1, avgFrame)).toFixed(1)
		+ 'x (' + frames.length + ' frames, ' + bParcelBytes.length + ' parcel pushes). The fixture\'s '
		+ 'parcel is a few kilobytes; a real one is hundreds, and a frame does not grow with it.');
	// SAME TEXT — A's finished transcript is the runner's. Compared in the STORES on
	// both sides and not on B's screen: a runner is a background device and need not be
	// displaying the chat it ran, so its thread text says nothing. A's is checked on
	// screen as well, because the reader's thread is where it has to be true.
	const aAnswers = answerText(finalCs).map((m) => String(m.content || '').replace(/\s+/g, ' ').trim());
	let bCs = []; try { bCs = await storedChats(b); } catch (e) { bCs = []; }
	const bAnswers = answerText(bCs).map((m) => String(m.content || '').replace(/\s+/g, ' ').trim());
	const same = aAnswers.length === 1 && bAnswers.length === 1 && aAnswers[0] === bAnswers[0];
	check('SAME TEXT: A\'s transcript holds the runner\'s answer, character for character',
		same, 'on A: ' + JSON.stringify(aAnswers[0] || '')
		+ ' | on the runner: ' + JSON.stringify(bAnswers[0] || ''));
	const aScreen = (await threadText(a.page)).replace(/\s+/g, ' ').trim();
	check('SAME TEXT: and the reader\'s own thread shows it',
		/ANSWERWORD the slow reasoning is done/.test(aScreen),
		'on A\'s screen: ' + JSON.stringify(aScreen.slice(-120)));
	check('RECONCILE: the streamed tail is gone once the answer is in the transcript',
		(await streamedOf(a.page)) === '' || !done,
		'streamed node still on screen after the answer merged');

	console.log('\nMEASURED — ' + frames.length + ' frame(s), average ' + avgFrame
		+ ' bytes, largest ' + maxFrame + ' bytes'
		+ '; first frame sent at +' + tFirstFrame + 'ms and on A\'s screen at +'
		+ (tFirstScreen ? tFirstScreen - tDispatch : -1) + 'ms (latency ' + latency + 'ms)'
		+ '; A read the door ' + aFrameReads + ' time(s)'
		+ '; the runner\'s parcel pushes: ' + bParcelPushes + ' at ' + avgParcel + ' bytes average'
		+ '; A\'s stored transcript caught up at +' + tFirstWork + 'ms');

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
