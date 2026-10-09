// gateway: live
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
//   FOLLOW     — A reads the door within 1 s of each frame B stores: the gateway taps
//                the watcher, so it is not left to its 4 s fallback tick (Q7, 2026-10-09).
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs. Run under WebKit:
//   DAIMOND_BROWSER=webkit node dev/verify_handoff_streaming.mjs

import { open, chat, signInAs, newChat, connectMock, servedChats } from './harness.mjs';
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
// THE TURN AS A HAS IT ON SCREEN: the text of the tiles after the prompt's own tile.
// Since 0ffe75e2 (2026-09-18) a frame is no longer a separate `.handoff-stream` view:
// its rows fold into the transcript as PROVISIONAL messages and draw as ordinary tiles
// (daimond.js `onProgressFrame` -> `applyProvisional`), so the streamed view is the
// thread itself and is read there. Read only AFTER the prompt: the prompt holds
// `reasoning1`, `word1` and `ANSWERWORD` itself, so any whole-thread test is always
// true. The anchor is `<last thought> ;; word1`, which only the prompt contains.
const turnTextOf = (pg, anchor, end) => pg.evaluate(([anchor, end]) => {
	const out = document.getElementById('chat-output');
	const txt = out ? String(out.textContent || '') : '';
	const at = txt.lastIndexOf(anchor);
	if (at < 0) return '';
	const fin = txt.indexOf(end, at);
	return fin < 0 ? '' : txt.slice(fin + end.length);
}, [anchor, end]);
// The thread as a reader sees it, for the "A's transcript is the runner's" property.
// THE TURN'S ORDER ON A'S SCREEN, by the tiles themselves (r545 item 18): where the
// last THINKING tile of the turn ends and where the answer's first word sits, as
// offsets into the thread's text. Not by the word "reasoning": the mock answer ends
// "the slow reasoning is done", so once its tail is drawn a word search finds the
// answer and reads it as thinking (chain1, 9 Oct 2026: every ABOVE was that).
const turnOrderOf = (pg, anchor, end) => pg.evaluate(([anchor, end]) => {
	const out = document.getElementById('chat-output');
	if (!out) return { thinkEnd: -1, word1: -1, tiles: 0 };
	const txt = String(out.textContent || '');
	const at = txt.lastIndexOf(anchor);
	const fin = at < 0 ? -1 : txt.indexOf(end, at);
	if (fin < 0) return { thinkEnd: -1, word1: -1, tiles: 0 };
	const start = fin + end.length;
	const offOf = (el, atEnd) => {
		const r = document.createRange();
		r.setStart(out, 0);
		if (atEnd) r.setEndAfter(el); else r.setEndBefore(el);
		return r.toString().length;
	};
	let thinkEnd = -1, tiles = 0;
	out.querySelectorAll('.chat-msg-thinking').forEach((el) => {
		if (offOf(el, false) < start) return;		// a tile before this turn
		tiles++; thinkEnd = Math.max(thinkEnd, offOf(el, true));
	});
	const w = txt.indexOf('word1 ', start);
	return { thinkEnd: thinkEnd < 0 ? -1 : thinkEnd - start, word1: w < 0 ? -1 : w - start, tiles };
}, [anchor, end]);
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
	const aReadAts = [];			// when A read the door, for the follow property
	a.page.on('request', (req) => {
		try {
			if (req.method() === 'GET' && /\/api\/sync\?/.test(req.url()) && /progress=/.test(req.url())) {
				aFrameReads++; aReadAts.push(Date.now());
			}
		} catch (e) {}
	});

	// THE FRAMES AS THE RUNNER HANDED THEM TO THE DOOR (Q20, D-20261006-13): when each
	// left and what it said. The wire carries sealed blobs, so a repeat cannot be told
	// there; the door's own entry can, and its clock is the one the cadence is kept on.
	await b.page.evaluate(() => {
		const S = window.DaimondSync, put = S.pushProgressFrame;
		window.__q20frames = [];
		S.pushProgressFrame = function (turnId, tail, final) {
			window.__q20frames.push({ at: Date.now(), turn: String(turnId), tail: String(tail || ''), final: !!final });
			return put.apply(this, arguments);
		};
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
	const ANCHOR = 'reasoning' + THINK_N + ' ;; word1 ', PEND = 'the slow reasoning is done';
	const streamedOf = (pg) => turnTextOf(pg, ANCHOR, PEND);
	// The turn's own content on screen: a thought or a word of the answer, past the
	// hand-off chrome ("Sent to your other devices") that is drawn before any frame.
	// No leading \b: textContent joins a tile's label to its body with no space.
	const hasTurn = (t) => /reasoning\d+\b|word\d+\b|ANSWERWORD/.test(t);
	const tDispatch = Date.now();
	aPulls = 0;
	await a.page.fill('#chat-input', PROMPT);
	await a.page.click('#chat-send', { force: true });

	// Poll A fast, on BOTH paths at once, because the streamed view and the stored
	// transcript are now different things and only one of them is the door:
	//
	//   THE SCREEN — the turn's tiles after the prompt, which the runner's frames fill as
	//     provisional rows while the turn runs. This is what the progress door delivers,
	//     and it has to be sampled DURING the turn: once the answer lands, "mid-turn" can
	//     no longer be told apart from "after".
	//   THE STORE — the think_log in A's own chats, which arrives with a PARCEL. The
	//     progress tick no longer pushes parcels, so this is no longer the mid-turn
	//     signal; it is the reconciliation, asserted further down.
	let sawScreenBeforeAnswer = false, tFirstScreen = 0, screenGrew = false, screenLen = 0;
	let sawWorkBeforeAnswer = false, tFirstWork = 0, grew = false, prevLen = 0;
	let screened = '';
	let tFirstWord = 0;				// when the answer's first word was on A's screen
	let midTurn = '';				// the last screen read taken before B's final frame (set after the loop)
	let midOrd = null;				// the tile order on that read
	const reads = [];				// { at, shot, ord }: every read that showed the turn
	const thinkSeen = [];			// { at, n }: the highest thought A shows, per screen read
	// Only a thought with a space after it: textContent runs a tile's last thought into
	// the stamp that follows ("reasoning2" + "1 2026-10-09" reads as 212026, measured
	// 9 Oct when the first frame came at +0.4 s), so the last thought is not counted
	// and the count lags one thought, which a growth test does not mind.
	const thoughtOf = (t) => (String(t).match(/reasoning\d+(?=\s)/g) || [])
		.reduce((n, w) => Math.max(n, +w.slice(9)), 0);
	for (let i = 0; i < 260; i++) {									// generous budget
		let cs = []; try { cs = await servedChats(a); } catch (e) { cs = []; }
		const tl = thinkLen(cs), ans = answerText(cs).length;
		let shot = ''; try { shot = await streamedOf(a.page); } catch (e) { shot = ''; }
		thinkSeen.push({ at: Date.now(), n: thoughtOf(shot) });
		if (hasTurn(shot)) {
			let ord = null; try { ord = await turnOrderOf(a.page, ANCHOR, PEND); } catch (e) { ord = null; }
			reads.push({ at: Date.now(), shot, ord });
			if (!tFirstScreen) { tFirstScreen = Date.now(); screened = shot; }
			if (!tFirstWord && /word1\b/.test(shot)) tFirstWord = Date.now();
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
	// MID-TURN = before the runner's FINAL frame left B (r545 item 18), on the frames
	// B's door entry logged. A's own store is no measure: with the 750 ms cadence the
	// final frame's tail is on A's screen before the parcel brings the answer.
	{
		const lg = await b.page.evaluate(() => window.__q20frames || []);
		const finAt = lg.filter((f) => f.final).reduce((n, f) => Math.min(n, f.at), Infinity);
		const pre = reads.filter((r) => r.at < finAt);
		const last = pre[pre.length - 1];
		if (last) { midTurn = last.shot; midOrd = last.ord; }
		console.log('  ..    mid-turn reads (before B\'s final frame): ' + pre.length + ' of ' + reads.length
			+ (Number.isFinite(finAt) ? ', final frame at +' + (finAt - tDispatch) + 'ms' : ', no final frame logged'));
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
	// The thinking itself, as the runner rendered it, not a count of it: the retired
	// flattened view drew `[thinking N chars]` here.
	check('STREAMED VIEW: what A draws is the turn as the runner rendered it (its thinking, word for word)',
		/reasoning1\b/.test(screened) && !/\[thinking \d+ chars\]/.test(screened),
		'on A\'s screen: ' + JSON.stringify(screened.slice(0, 120)));
	// THE DAIMON'S OWN WORDS, mid-turn, on the device that asked. This is the owner's
	// requirement in one line: the answer being produced elsewhere is readable here
	// while it is being produced. A thinking count alone would satisfy everything above
	// it and none of what was asked for.
	// Read from `midTurn`, the last screen taken before B's final frame left. A streamed
	// frame may already carry the answer's tail (ANSWERWORD), which is correct streaming.
	check('STREAMED VIEW: the answer\'s own words reach A while the runner is still writing',
		/word1\b/.test(midTurn),
		'on A\'s screen: ' + JSON.stringify(midTurn.slice(-120)));
	// And in the runner's order: the answer under the thinking that came before it,
	// not drawn above it until the parcel merge swaps them (a visible jump).
	check('STREAMED VIEW: mid-turn, the answer is drawn BELOW the thinking that preceded it',
		!!midOrd && midOrd.tiles > 0 && midOrd.thinkEnd >= 0 && midOrd.word1 >= midOrd.thinkEnd,
		'thinking tile(s) ' + (midOrd ? midOrd.tiles : 0) + ' end at ' + (midOrd ? midOrd.thinkEnd : -1)
		+ ', word1 at ' + (midOrd ? midOrd.word1 : -1));

	// THE THINKING GROWS ON A WITH EACH FRAME. A frame larger than the one before it,
	// sent while the thinking was still being written, carries more thinking; within a
	// second of it A must show a later thought than it did before it. The tile used to
	// be redrawn only when a NEW row arrived or A's ~8 s parcel pull forced it, so a
	// reasoning round sat still on A between rows (Q7 diag 2, 9 Oct 2026).
	const growth = [];
	for (let f = 1; f < frames.length; f++) {
		const fr = frames[f];
		if (fr.bytes < frames[f - 1].bytes + 16) continue;				// did not grow
		const before = thinkSeen.filter((s) => s.at <= fr.at).reduce((n, s) => Math.max(n, s.n), 0);
		if (before >= THINK_N) break;									// the thinking was whole
		const win = thinkSeen.filter((s) => s.at > fr.at && s.at <= fr.at + 1000);
		if (!win.length) continue;										// no read in the window
		growth.push({ at: fr.at - tDispatch, before, after: win.reduce((n, s) => Math.max(n, s.n), 0) });
	}
	const stalled = growth.filter((g) => g.after <= g.before);
	check('STREAMED VIEW: A\'s thinking grows within 1 s of each frame that grew it',
		growth.length >= 2 && stalled.length === 0,
		growth.length + ' growing frame(s), ' + stalled.length + ' left A\'s thinking still: '
		+ JSON.stringify(growth.slice(0, 10)) + '; A\'s reads (at, thought) '
		+ JSON.stringify(thinkSeen.slice(0, 40).map((x) => [x.at - tDispatch, x.n]))
		+ '; frames at ' + JSON.stringify(frames.slice(0, 20).map((f) => f.at - tDispatch)));

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
	const finalCs = await servedChats(a);
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
	// CADENCE (Q20, D-20261006-13): the runner frames at most every 750 ms, and only when
	// the turn changed since its last frame -- no empty frame, none repeating the one
	// before it. The final flush is exempt from the spacing: it is the turn ending, and
	// holding it back would delay the finished answer for a cadence that has stopped.
	const log = await b.page.evaluate(() => window.__q20frames || []);
	const byTurn = {};
	for (const f of log) (byTurn[f.turn] = byTurn[f.turn] || []).push(f);
	const turnLog = Object.values(byTurn).sort((x, y) => y.length - x.length)[0] || [];
	const stream = turnLog.filter((f) => !f.final);
	const gaps = stream.slice(1).map((f, i) => f.at - stream[i].at);
	const fin = turnLog.find((f) => f.final);
	const finGap = (fin && stream.length) ? fin.at - stream[stream.length - 1].at : -1;
	check('CADENCE: no two of the runner\'s streaming frames went out under 750 ms apart',
		stream.length >= 2 && gaps.every((g) => g >= 750),
		stream.length + ' streaming frame(s) + ' + (fin ? 1 : 0) + ' final; gaps ms ' + JSON.stringify(gaps)
		+ '; final ' + finGap + ' ms after the last');
	const repeats = turnLog.filter((f, i) => !f.tail || (i > 0 && f.tail === turnLog[i - 1].tail && f.final === turnLog[i - 1].final));
	check('CADENCE: no frame is empty or repeats the frame before it (sent only when the turn grew)',
		turnLog.length >= 2 && repeats.length === 0,
		repeats.length + ' empty or repeated of ' + turnLog.length);
	const wordFrame = turnLog.find((f) => /word1\b/.test(f.tail));
	// FOLLOW (Q7, D-20261006-13): A's reads FOLLOW B's frames, within a second of each.
	// The gateway taps every watcher when a frame is stored (`p<seq>` on the wake socket,
	// `progress:true` on a park asked with `&prog=1`), and the watcher reads the door on
	// the tap. Without the tap the watcher reads only on its 4 s fallback tick: measured
	// 2026-10-09, B framed every 2.0 s, A read every 4.0 s like a clock, so half the
	// frames were never seen and each change was 0-4 s late. Counted over the frames
	// that have a read after them (the last frame closes the watch).
	const follow = frames.filter((f) => aReadAts.some((r) => r >= f.at)).map((f) => {
		const r = aReadAts.find((x) => x >= f.at);
		return r - f.at;
	});
	const quick = follow.filter((d) => d <= 1000).length;
	check('FOLLOW: A reads the door within 1 s of each of B\'s frames (tapped, not on the 4 s tick)',
		follow.length >= 2 && quick >= Math.ceil(follow.length * 0.8),
		quick + ' of ' + follow.length + ' frames read within 1 s; lags ms '
		+ JSON.stringify(follow.slice(0, 12)));
	// THE COST, in bytes rather than in pushes. A count of parcel pushes is the wrong
	// measure and a first run of this check said so: the ordinary sync engine pushes on
	// its own cadence through a turn, so ten parcel pushes can be nothing to do with
	// the progress tick. What the door changed is the SIZE of what a frame costs -- it
	// used to be a whole parcel -- so that is what is asserted, on this run's own numbers.
	//
	// AGAINST THE PARCEL THAT CARRIED THE TURN, not the average push. Most of B's pushes
	// in a run are a few hundred bytes of bookkeeping (measured 9 Oct: 485, 485, 189, 497,
	// 489, 189 beside one 13696), so the average rose and fell with how many of them a
	// run happened to make, and the check flipped between runs on an unchanged build. The
	// largest push is the one holding the finished turn: a frame carries that same turn's
	// tail, so every frame must cost less than it, and that parcel grows with the chat
	// while a frame does not.
	const avgFrame  = frames.length ? Math.round(frames.reduce((n, f) => n + f.bytes, 0) / frames.length) : 0;
	const turnParcel = bParcelBytes.reduce((n, b) => Math.max(n, b), 0);
	check('COST: every frame, the largest included, costs less than the parcel push that carried the turn',
		avgFrame > 0 && turnParcel > 0 && maxFrame < turnParcel,
		'frame ' + avgFrame + ' bytes average, ' + maxFrame + ' bytes largest, against the turn\'s parcel push of '
		+ turnParcel + ' bytes -- ' + (turnParcel / Math.max(1, maxFrame)).toFixed(1) + 'x the largest frame ('
		+ frames.length + ' frames; parcel pushes ' + JSON.stringify(bParcelBytes) + '). The fixture\'s '
		+ 'parcel is a few kilobytes; a real one is hundreds, and a frame does not grow with it.');
	// SAME TEXT — A's finished transcript is the runner's. Compared in the STORES on
	// both sides and not on B's screen: a runner is a background device and need not be
	// displaying the chat it ran, so its thread text says nothing. A's is checked on
	// screen as well, because the reader's thread is where it has to be true.
	const aAnswers = answerText(finalCs).map((m) => String(m.content || '').replace(/\s+/g, ' ').trim());
	let bCs = []; try { bCs = await servedChats(b); } catch (e) { bCs = []; }
	const bAnswers = answerText(bCs).map((m) => String(m.content || '').replace(/\s+/g, ' ').trim());
	const same = aAnswers.length === 1 && bAnswers.length === 1 && aAnswers[0] === bAnswers[0];
	check('SAME TEXT: A\'s transcript holds the runner\'s answer, character for character',
		same, 'on A: ' + JSON.stringify(aAnswers[0] || '')
		+ ' | on the runner: ' + JSON.stringify(bAnswers[0] || ''));
	const aScreen = (await threadText(a.page)).replace(/\s+/g, ' ').trim();
	check('SAME TEXT: and the reader\'s own thread shows it',
		/ANSWERWORD the slow reasoning is done/.test(aScreen),
		'on A\'s screen: ' + JSON.stringify(aScreen.slice(-120)));
	// The provisional rows gave way to the runner's copies by mid, not beside them.
	const after = await streamedOf(a.page);
	const nAns = after.split('ANSWERWORD the slow reasoning is done').length - 1;
	check('RECONCILE: the streamed rows gave way to the answer (it is on A\'s screen once)',
		done && nAns === 1, 'answer occurrences after the prompt: ' + nAns);

	console.log('\nMEASURED — ' + frames.length + ' frame(s), average ' + avgFrame
		+ ' bytes, largest ' + maxFrame + ' bytes'
		+ '; first frame sent at +' + tFirstFrame + 'ms and on A\'s screen at +'
		+ (tFirstScreen ? tFirstScreen - tDispatch : -1) + 'ms (latency ' + latency + 'ms)'
		+ '; A read the door ' + aFrameReads + ' time(s), ' + quick + ' of ' + follow.length + ' frames within 1 s'
		+ '; the runner\'s parcel pushes: ' + bParcelPushes + ', the turn\'s ' + turnParcel + ' bytes'
		+ '; A\'s stored transcript caught up at +' + tFirstWork + 'ms');
	// THE Q20 FIGURES, one line, for the before/after comparison.
	const wireBytes = frames.reduce((n, f) => n + f.bytes, 0);
	console.log('Q20 — frames/turn ' + frames.length + ' (door entries ' + turnLog.length + ', ' + stream.length
		+ ' streaming + ' + (fin ? 1 : 0) + ' final); bytes/turn ' + wireBytes
		+ '; relay pushes to A (door reads) ' + aFrameReads
		+ '; streaming gap ms min ' + (gaps.length ? Math.min(...gaps) : -1) + ' median '
		+ (gaps.length ? gaps.slice().sort((x, y) => x - y)[gaps.length >> 1] : -1)
		+ '; first word on A at +' + (tFirstWord ? tFirstWord - tDispatch : -1) + 'ms from dispatch, '
		+ ((tFirstWord && wordFrame) ? (tFirstWord - wordFrame.at) : -1) + 'ms after the runner framed it'
		+ ' (framed at +' + (wordFrame ? wordFrame.at - tDispatch : -1) + 'ms)');

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
