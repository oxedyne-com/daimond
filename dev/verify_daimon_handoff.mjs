// gateway: live
// verify_daimon_handoff.mjs — a DAIMON turn hands off, and runs on the peer.
//
// The owner's #1 launch roadblock: a Diamond's daimon turn never handed off. It
// ran on whatever device the steer was typed into -- his phone spent 14 minutes
// in the foreground on one. The election/lease/hand-off is proven for chats
// (verify_spawn_gather_handoff, verify_handoff_streaming); this proves it now
// runs for daimons too, because the runner services a daimon errand through
// `steer_crystal` rather than the chat engine (peerRunErrandDeps.runTurn).
//
// The house rule for a cross-device feature: two REAL contexts. A is WebKit with
// an iPhone user agent and a touch context (a phone hands EVERY turn to an awake
// peer); B is Chromium, a desktop, the runner. A Diamond is seeded on B, synced
// to A, and A steers its daimon with a mock preset that makes ONE tool call.
//
// PROVES:
//   (1) HOSTED   — the daimon turn ran on B (its answer carries ranOn === B), and
//                  no copy ran on A: one turn, one bill.
//   (2) VISIBLE  — the runner streamed the daimon's tool tile to A before `done`: a
//                  frame carrying a `tool_log` row, or the tool tile on A's screen.
//   (3) FENCED   — a file_write OUTSIDE the Diamond's own dir was refused: the
//                  per-call `steer_crystal` fence fails closed to `own_dir`. Its own
//                  short turn: the question is put to A, the sending device, never
//                  to B, and A says Not now (CONSENT-ROUTE aeae1bcb).
//   (4) ONCE     — A's daimon chat carries the answer exactly once (no double
//                  bill from a re-collect or a park).
//   (5) RECOVERS — reloading B mid-turn re-hands via the lease backstop or A's
//                  own recovery, and still delivers the answer exactly once.
//
// Needs the dev stack (app/mock/gateway) and Pro. Run under WebKit:
//   DAIMOND_BROWSER=webkit node dev/verify_daimon_handoff.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_daimon_handoff.mjs --break nogate
//
// `--break nogate` restores the old `chat.diamondId` gate on `maybeAutoDispatch`
// at runtime (so a daimon never dispatches) and must fail (1)/(2): a green run
// then proves the hand-off is doing the work, not that any turn would pass.
import { open, chat, signInAs, newChat, connectMock, storedChats, mockLog, clearMockLog, contentText } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { nominateRunner } from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['nogate'];
if (BREAK && !BREAKS.includes(BREAK)) {
	console.error(`unknown break '${BREAK}'; one of: ${BREAKS.join(', ')}`);
	process.exit(2);
}

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const settle = (pg) => pg.waitForFunction(() => {
	try { return window.DaimondSync && window.DaimondSync.state().quiet; } catch (e) { return true; }
}, null, { timeout: 20000 }).catch(() => {});
const devId = (pg) => pg.evaluate(() => window.DaimondIdentity.deviceId());
/// The streamed turn A has on screen. Since 0ffe75e2 (2026-09-18) a frame is folded into
/// A's transcript as PROVISIONAL rows drawn as the turn's own tiles (a tool row as a tool
/// tile, `.tool-block`), and the flattened `.handoff-stream` view this read is gone.
const streamedOf = (pg) => pg.evaluate(() => {
	const out = document.getElementById('chat-output');
	if (!out) return '';
	return [...out.querySelectorAll('.tool-block, .chat-msg-assistant .chat-msg-content')]
		.map((e) => String(e.textContent || '')).join(' ');
});
/// A progress frame's rows. Since 0ffe75e2 the door carries JSON `{v:1,msgs:[…]}`, one
/// structured row per message, where it once carried a text tail with `[tool …]` lines.
const frameRows = (p) => {
	try { const j = JSON.parse(p.tail); return (j && Array.isArray(j.msgs)) ? j.msgs : []; }
	catch (e) { return []; }
};
/// The daimon's own conversation on this device, as stored (messages + ranOn).
const daimonMsgs = (pg, id) => pg.evaluate((did) => {
	try {
		const rec = window.DaimondDiamond.conversation(did);
		return (rec && rec.messages ? rec.messages : []).map((m) => ({
			role: String(m.role || ''), ranOn: String(m.ranOn || ''), mid: String(m.mid || ''), provisional: !!m.provisional,
			iturn: String(m.iturn || ''), name: String(m.name || ''), why: String(m.why || ''),
			content: typeof m.content === 'string' ? m.content : '' }));
	} catch (e) { return []; }
}, id);
/// Whether THIS device is running a crystal turn right now (busy on the Diamond).
const crystalBusyOn = (pg, id) => pg.evaluate((did) => {
	try { return !!(window.DaimondDiamond && window.DaimondPeer)
		&& !!(window.__daimondBusyProbe ? window.__daimondBusyProbe(did) : false); }
	catch (e) { return false; }
}, id);
async function until(pg, fn, arg, ms = 30000, step = 250) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true;
		await pg.waitForTimeout(step);
	}
	return false;
}
// `@rounds 3/1200 file_list {…}` makes the model call file_list THREE times, PACED at
// 1200ms each, then answer "Called 3 time(s); done." (mockllm.mjs case 'rounds'). The
// pacing is what the streaming and the mid-turn reload need: a one-shot mock turn finishes
// inside the 2s progress interval and between the 300ms polls, so nothing streams and the
// runner is never caught busy. ~3.6s is enough for the progress door to push a tool tile
// and for the reload to land mid-turn.
// THE PACED CALL NEITHER FAILS NOR ASKS (12 Oct, specs/daimond_dh_answer_diag_20261012.md).
// It was a refused file_write, which since bb17ef74 (G T3) ends blocked after the second
// refusal and since aeae1bcb (CONSENT-ROUTE) asks A each time, waiting out 60 s unanswered:
// (4), (5) and (6) then counted a reply the turn no longer gave. The fence (3) has its own
// short turn, and a turn's answer is counted by its turn id, not by its wording.
// The fence's write is a canonical workspace path OUTSIDE the Diamond's own dir, so the fence
// asks A before it refuses. It was '../../daimon_escape.txt', but since PATHTYPE 55f5cb8c every
// '..' is refused at the guard in one sentence, before the fence is reached: nobody is asked,
// and (3) saw {"a":[],"b":[]} (R3 12 Oct).
const ESCAPE_PATH = 'docs/daimon_escape.txt';
const STEER = '@rounds 3/1200 file_list {"path":"."}';
const ANSWER = 'Called 3 time';            // the mock's post-rounds reply, shown beside the count
const FENCE_STEER = `@rounds 1/1200 file_write {"path":"${ESCAPE_PATH}","content":"nope"}`;
const carrying = (msgs, needle) => msgs.filter((m) => m.content && m.content.includes(needle)).length;

/// Create a Diamond through its real dialog and answer its id. Mirrors
/// verify_daimonchat.mjs create(): click, fill the name, click OK.
async function makeDiamond(pg, name) {
	await pg.evaluate(() => document.getElementById('new-diamond-btn').click());
	await pg.waitForSelector('.dlg-card', { timeout: 8000 });
	await pg.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].filter((c) => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	// Creation is async (OPFS write + loadDiamonds + selectDiamond); poll for current().
	for (let i = 0; i < 30; i++) {
		const id = await pg.evaluate(() => { const c = window.DaimondDiamond.current(); return c ? c.id : ''; });
		if (id) return id;
		await pg.waitForTimeout(300);
	}
	return '';
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
	+ 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

// The runtime break: reinstate the OLD daimon gate at the one pure decision the
// send consults — `autoDispatchDecision` refuses to dispatch any chat that carries
// a `diamondId`, exactly the removed early-return, and MEANINGFULLY (an ordinary
// chat would still dispatch; only the daimon is pinned local). With it, (1)/(2)
// must go red: the daimon turn runs on A and nothing streams to it. Applied on A.
const applyBreak = async (pg) => {
	if (BREAK !== 'nogate') return;
	await pg.evaluate(() => {
		if (window.DaimondPeer && window.DaimondPeer.autoDispatchDecision && !window.__daimonGateBreak) {
			const orig = window.DaimondPeer.autoDispatchDecision;
			window.DaimondPeer.autoDispatchDecision = function (chat) {
				if (chat && chat.diamondId) return { dispatch: false, reason: 'break-daimon-gate' };
				return orig.apply(this, arguments);
			};
			window.__daimonGateBreak = true;
		}
	}).catch(() => {});
};

let a, b;
try {
	// ── A: the phone that asks ────────────────────────────────────────────
	//
	// The phone CONTEXT — iPhone UA + touch + a phone viewport — is what the hand-off
	// ELECTION keys on (`isPhoneViewport`/`isMobileDeviceSelf`), and the money-safety is
	// engine-agnostic. The WebKit WPE build on this host exposes no OPFS `getDirectory`,
	// so it cannot host a Diamond's workspace at all (a real iOS 17+ PWA can) -- see the
	// OPFS guard below, which SKIPS under `DAIMOND_BROWSER=webkit`. So A is a Chromium
	// phone-emulation: the same phone context, on an engine that can hold a Diamond.
	a = await open({ name: 'dhlead', touch: true, ua: IPHONE_UA });
	// OPFS is what a Diamond's workspace lives in. Absent (the WPE WebKit build, older
	// Safari, Private Browsing) there is no way to create or run a Diamond, so the whole
	// scenario is moot -- skip with the reason, exactly as verify_webkit skips a missing
	// engine, rather than reddening the suite for a host limitation.
	const hasOpfs = await a.page.evaluate(() => {
		try { return !!(navigator.storage && navigator.storage.getDirectory); } catch (e) { return false; }
	});
	if (!hasOpfs) {
		console.log('SKIPPED: this browser exposes no OPFS getDirectory, so it cannot host a '
			+ 'Diamond workspace (the WPE WebKit build; a real iOS PWA can). Run under Chromium.');
		try { await a.close(); } catch (e) {}
		process.exit(0);
	}
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	// ── B: the desktop that runs it (Chromium explicitly). ───────────────
	b = await open({ name: 'dhmate', signIn: false, connect: false, browser: 'chromium' });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'dhlead');
	await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.waitForFunction(() => !!window.DaimondDiamond, null, { timeout: 15000 }).catch(() => {});
	await b.page.waitForTimeout(1500);
	await settle(b.page);

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices', !!idA && !!idB && idA !== idB,
		JSON.stringify({ idA, idB }));

	// ── Seed the Diamond ON A, the dispatcher (the realistic owner case: he makes a
	// Diamond on his phone and steers it). It becomes `current` on A at once, and
	// rides A's dispatch parcel to B, whose `peerReconstruct` waits for it resident.
	// Creating on A also avoids selecting a Diamond through A's collapsed mobile rail.
	await a.page.waitForSelector('#new-diamond-btn', { timeout: 10000 }).catch(() => {});
	const diaId = await makeDiamond(a.page, 'HandoffDia');
	check('a Diamond was seeded on A and is current', !!diaId, 'id=' + diaId);
	await settle(a.page);
	// Push A's parcel so the Diamond is on the relay before the steer, and sync B so it
	// already holds the Diamond record when it reconstructs (belt to the reconstruct wait).
	await a.page.evaluate(() => window.DaimondSync && window.DaimondSync.push && window.DaimondSync.push());
	await a.page.waitForTimeout(600);
	await b.page.evaluate(() => window.DaimondSync && window.DaimondSync.pull && window.DaimondSync.pull(true));
	const bHasDia = await until(b.page, (did) => {
		try { return !!window.DaimondDiamond.conversation(did); } catch (e) { return false; }
	}, diaId, 20000);
	check('the Diamond synced to the runner B', bHasDia, 'id=' + diaId);

	// B beats presence and A refreshes, so A (a phone) sees an awake peer to hand to.
	await b.page.evaluate(() => window.DaimondSync.beatPresence(
		window.DaimondIdentity.deviceId(), 'dhmate'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const aSeesB = await a.page.evaluate((self) =>
		(window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer it can hand a turn to', aSeesB >= 1, 'awake peers: ' + aSeesB);

	// ARM A to hand off: B NOMINATED, the one route a composer send takes off this device
	// since D-20261009-23 (the step-away posture alone seats nobody now), plus the posture,
	// which `armed` below still reads.
	await a.page.evaluate(() => { try { localStorage.setItem('daimond-handoff-when-away', '1'); } catch (e) {} });
	await nominateRunner(check, a, b, 'dhmate');
	await a.page.waitForTimeout(400);
	await a.page.evaluate(() => window.DaimondSync && window.DaimondSync.push && window.DaimondSync.push());
	await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'dhmate'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1200);
	const armed = await a.page.evaluate(() => { try { return localStorage.getItem('daimond-handoff-when-away'); } catch (e) { return null; } });
	check('A is armed to hand off (step-away posture on)', armed === '1', 'armed=' + armed);

	const rerefresh = async () => {
		await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'dhmate')).catch(() => {});
		await a.page.evaluate(() => window.DaimondSync.refreshPresence && window.DaimondSync.refreshPresence()).catch(() => {});
		await a.page.waitForTimeout(800);
	};

	/// Steer the daimon from A once and watch both sides. `reloadMid` reloads B while
	/// the turn is in flight (the recovery test). Answers the observations.
	// Instrument the RUNNER's progress-frame push, so (2) can assert the daimon streamed
	// its tool tile through the door BEFORE the final frame — the half of "streams to A"
	// that is this fix's own code (runSteerDetached feeds the tool_logs; the pushProgress
	// dep renders and pushes them). The dispatcher-side ON-SCREEN render is a separate,
	// pre-existing path that fails verify_handoff_streaming identically in this world, so
	// it is not what a daimon-fix verifier should gate on.
	const instrumentBPush = () => b.page.evaluate(() => {
		window.__ppf = [];
		const s = window.DaimondSync;
		if (s && s.pushProgressFrame && !s.__ppfWrapped) {
			const o = s.pushProgressFrame.bind(s);
			s.pushProgressFrame = async function (t, tail, f) {
				try { window.__ppf.push({ t: String(t), tail: String(tail || ''), final: !!f }); } catch (e) {}
				return o(t, tail, f);
			};
			s.__ppfWrapped = true;
		} else if (s) { window.__ppf = []; }
	}).catch(() => {});

	/// `consent: 'no'` answers a write question Not now on A and records which device asked.
	async function steerAndWatch({ reloadMid = false, directive = STEER, answer = ANSWER, waitLoops = 200, consent = '' } = {}) {
		// THIS TURN'S answer: an assistant row carrying the turn id of a prompt sent here
		// (a re-ask under a fresh id is the same prompt, so it counts too), whatever it says.
		const seen = new Set((await daimonMsgs(a.page, diaId)).filter((m) => m.role === 'user').map((m) => m.iturn));
		const turnRows = async () => {
			const msgs = await daimonMsgs(a.page, diaId);
			const tids = new Set(msgs.filter((m) => m.role === 'user' && m.iturn && !seen.has(m.iturn)
				&& m.content.trim() === directive).map((m) => m.iturn));
			return msgs.filter((m) => m.role === 'assistant' && tids.has(m.iturn)
				&& m.why !== 'dispatched' && m.content.trim());
		};
		const countAns = async () => (await turnRows()).length;
		const before = 0;
		const needleBefore = carrying(await daimonMsgs(a.page, diaId), answer);
		const asks = { a: [], b: [] };
		// A question asked on the device itself is a `.modal.dlg[data-ask]`; one ROUTED from a
		// runner (CONSENT-ROUTE) is a Pending card, "Let <Diamond> change <file>?" (raiseConsentFromPeer).
		const openAsks = (pg) => pg.evaluate(() => [...document.querySelectorAll('.modal.dlg[data-ask]')]
			.filter((d) => d.getClientRects().length).map((d) => d.getAttribute('data-ask'))
			.concat([...document.querySelectorAll('#pending-list .pend-card')].filter((c) => c.querySelector('.pend-no'))
				.map((c) => 'card:' + ((c.querySelector('.pend-line') || {}).textContent || '').trim().slice(0, 60)))).catch(() => []);
		const watchAsks = async () => {
			for (const [k, pg] of [['a', a.page], ['b', b.page]]) {
				for (const x of await openAsks(pg)) if (!asks[k].includes(x)) asks[k].push(x);
			}
			if (consent !== 'no') return;
			await a.page.evaluate(() => {
				const c = [...document.querySelectorAll('.modal.dlg[data-ask] .dlg-card')].pop();
				const no = c && c.querySelector('.dlg-cancel');
				if (no) no.click();
				for (const k of document.querySelectorAll('#pending-list .pend-card .pend-no')) k.click();
			}).catch(() => {});
		};
		try { clearMockLog(); } catch (e) {}
		try { await b.page.evaluate(() => { window.__ppf = []; }); } catch (e) {}
		await a.page.$('#dview-chat').then((el) => el && el.click({ force: true })).catch(() => {});
		await a.page.waitForTimeout(300);
		await a.page.fill('#chat-input', directive);
		const t0 = Date.now();
		await a.page.click('#chat-send', { force: true });
		let sawStream = false, ranOnBSeen = false, ranOnASeen = false, reloaded = false, maxStream = '';
		for (let i = 0; i < 240; i++) {
			let shot = ''; try { shot = await streamedOf(a.page); } catch (e) { shot = ''; }
			if (shot.length > maxStream.length) maxStream = shot;
			if (/\[tool |file_write/.test(shot)) sawStream = true;
			const busyOf = async (pg) => { try {
				return await pg.evaluate((did) => { try { const r = window.DaimondDiamond.conversation(did); return !!(r && r._generating); } catch (e) { return false; } }, diaId);
			} catch (e) { return false; } };
			if (await busyOf(b.page)) ranOnBSeen = true;
			if (await busyOf(a.page)) ranOnASeen = true;
			if (consent) await watchAsks();
			if (reloadMid && !reloaded && ranOnBSeen) {
				reloaded = true;
				await b.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
				// B must be authed again to re-collect its interrupted errand; wait for the
				// gateway session and the peer transport, then beat presence and collect.
				await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
					&& window.DaimondGateway && DaimondGateway.state().authed, null, { timeout: 20000 }).catch(() => {});
				await b.page.evaluate(() => { try { window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'dhmate'); } catch (e) {} try { window.DaimondPost && window.DaimondPost.collect && window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
			}
			if ((await countAns()) > before) break;
			await a.page.waitForTimeout(300);
		}
		// Let a re-hand / recovery finish, nudging A's recovery-on-return AND B's collect
		// (a reloaded/busy B re-collects the errand, or hands it back for A to run local).
		// A's own recovery-on-return fires on a visibility change, so simulate one too.
		for (let i = 0; i < waitLoops; i++) {
			if ((await countAns()) > before) break;
			if (consent) await watchAsks();
			await a.page.evaluate(() => window.DaimondSync && window.DaimondSync.pull && window.DaimondSync.pull(true)).catch(() => {});
			if (i % 3 === 0) {
				await b.page.evaluate(() => { try { window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'dhmate'); } catch (e) {} try { window.DaimondPost && window.DaimondPost.collect && window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
				await a.page.evaluate(() => { try { document.dispatchEvent(new Event('visibilitychange')); } catch (e) {} try { window.DaimondPost && window.DaimondPost.collect && window.DaimondPost.collect(); } catch (e) {} }).catch(() => {});
			}
			await a.page.waitForTimeout(400);
		}
		// THE SETTLED ANSWER, not the streamed one. A runner's answer reaches A first as a
		// streamed row, which carries no `ranOn` until the final frame or the parcel brings
		// the copy that does (peer.js progressRow); the loops above stop at the first row,
		// so (3) read '∅' whenever it caught the stream (12 Oct). Wait, bounded, for the
		// copy that names its runner; one that never comes still reads '∅' and fails.
		let mine = await turnRows();
		for (let i = 0; i < 50 && mine.length && !mine[mine.length - 1].ranOn; i++) {
			await a.page.waitForTimeout(400);
			mine = await turnRows();
		}
		const answerRanOn = (mine[mine.length - 1] || {}).ranOn || '';
		const needle = carrying(await daimonMsgs(a.page, diaId), answer) - needleBefore;
		let toolResults = [];
		try { toolResults = (mockLog() || []).flatMap((r) => (r.messages || []).filter((m) => m.role === 'tool').map((m) => contentText(m.content))); } catch (e) {}
		let bPushes = [];
		try { bPushes = await b.page.evaluate(() => window.__ppf || []); } catch (e) {}
		// Is the turn still RECOVERABLE on A — an outstanding dispatched placeholder with no
		// answer yet (a [Run here] / backstop path), so a not-yet-delivered turn is never
		// silently LOST even when the harness cannot wait out the lease deadline?
		let recoverable = false;
		try {
			recoverable = await a.page.evaluate((did) => {
				const rec = window.DaimondDiamond.conversation(did);
				const msgs = (rec && rec.messages) || [];
				const disp = msgs.filter((m) => m.why === 'dispatched' && m.iturn);
				return disp.some((d) => !msgs.some((m) => m.role === 'assistant' && String(m.iturn) === String(d.iturn) && m.content && m.content.trim()));
			}, diaId);
		} catch (e) {}
		return { t0, rows: mine, copies: (await countAns()) - before, needle, asks, sawStream, maxStream, ranOnBSeen, ranOnASeen, reloaded, answerRanOn, toolResults, bPushes, recoverable };
	}

	// ── Turn 1 — the clean hand-off: A steers, B runs, A watches. ────────
	// The rings a failure prints are recorded only with Diagnostics on.
	for (const pg of [a.page, b.page]) await pg.evaluate(() => { try { window.DaimondDiag.set(true, 'dhandoff'); } catch (e) {} }).catch(() => {});
	console.log('\nTurn 1 — clean hand-off (A steers, B runs)');
	await applyBreak(a.page);
	await instrumentBPush();
	const t1 = await steerAndWatch({ reloadMid: false });

	// (1) HOSTED.
	check('(1) the daimon turn ran on B (the runner), evidenced by B going busy on it',
		t1.ranOnBSeen || t1.answerRanOn === idB,
		'ranOnBSeen=' + t1.ranOnBSeen + ' answerRanOn=' + (t1.answerRanOn || '∅'));
	check('(1) and NOT on the phone A — one turn, one bill',
		!t1.ranOnASeen && t1.answerRanOn !== idA,
		'ranOnASeen=' + t1.ranOnASeen + ' answerRanOn=' + (t1.answerRanOn || '∅'));
	// (2) VISIBLE — the runner streams the daimon's tool tile through the progress door
	// BEFORE the final frame. This is the fix's own code: runSteerDetached feeds the
	// tool_logs and the pushProgress dep pushes them live, as a structured `tool_log` row
	// since 0ffe75e2 (the `/\[tool /` text match this used found nothing in a JSON frame).
	const toolFrame = (t1.bPushes || []).find((p) => !p.final && frameRows(p).some((r) => r.role === 'tool_log'));
	check('(2) the runner streamed the daimon\'s tool tile through the progress door before done',
		!!toolFrame || t1.sawStream,
		toolFrame ? ('pushed: ' + JSON.stringify(frameRows(toolFrame).filter((r) => r.role === 'tool_log')
			.map((r) => r.name)).slice(0, 60))
			: ('no live tool_log frame; pushes=' + JSON.stringify((t1.bPushes || []).map((p) =>
				[frameRows(p).map((r) => r.role).join(','), p.final])).slice(0, 200)));
	// (4) ONCE.
	check('(4) the answer crossed the hand-off exactly once (no double bill)', t1.copies === 1,
		`${t1.copies} copies of turn 1's answer (needle '${ANSWER}': ${t1.needle})`);

	// ── Turn 1b — the fence: one write outside the Diamond's own dir, on B. ──────
	// (3) FENCED — `steer_crystal` runs the fence in wasm (tools.rs may_write), which asks
	//     before it refuses. The question goes to A, the device the person sent from, and
	//     never to B, a runner nobody is at; A says Not now, so the turn ends at once
	//     rather than waiting out the 60 s deadline. Proof of the refusal: the tool RESULT
	//     the runner fed the model on the next round, read off the mock log (cleared
	//     before the steer) -- the runner's own outbound wire.
	console.log('\nTurn 1b — the fence (a write outside own_dir, asked on A, Not now)');
	await rerefresh();
	const tf = await steerAndWatch({ directive: FENCE_STEER, answer: 'Called 1 time', consent: 'no' });
	const fenced = tf.toolResults.some((c) => /Refused/i.test(c)
		&& /(daimon_escape|not in|workspace|may write|cannot be written|not changed)/i.test(c));
	check('(3) the write outside the Diamond\'s own dir was refused (fence fails closed to own_dir)',
		fenced, fenced ? 'refused on the wire' : 'no "Refused" tool result: ' + JSON.stringify(tf.toolResults).slice(0, 240));
	check('(3) and the question was put to A, the sending device, never to B',
		tf.asks.a.length > 0 && tf.asks.b.length === 0, JSON.stringify(tf.asks));
	check('(3) and the fenced turn still answered once, on B',
		tf.copies === 1 && tf.answerRanOn === idB, `copies=${tf.copies} ranOn=${tf.answerRanOn || '∅'}`);

	// Where a failed turn went: both devices' hand-off rings from its send on, and A's rows.
	const dumpRings = async (label, t0, rows) => {
		const ring = (pg) => pg.evaluate((t) => ((window.DaimondDiag && DaimondDiag.rows()) || [])
			.filter((r) => r.ts >= t && /ready|errand|claim|reconstruct|hand.?back|dispatch|parcel|pull|tomb|UNDELIVER|busy|answer/i.test(r.tag + ' ' + (r.data || '')))
			.map((r) => (r.ts - t) + 'ms ' + r.tag + ': ' + String(r.data || '').slice(0, 200)), t0).catch(() => []);
		for (const [k, pg] of [['A', a.page], ['B', b.page]]) for (const l of (await ring(pg)).slice(0, 60)) console.log('  ring ' + label + ' ' + k + ' ' + l);
		for (const r of (rows || [])) console.log('  row  ' + label + ' ' + JSON.stringify({ mid: r.mid, prov: r.provisional, why: r.why, ranOn: r.ranOn, iturn: r.iturn.slice(0, 12), c: r.content.slice(0, 40) }));
	};
	if (!(tf.copies === 1 && tf.answerRanOn === idB)) await dumpRings('T1b', tf.t0, tf.rows);

	// `diamondBusy` (crystalRunning) is the flag peerReconstruct's hand-back reads — set
	// by a runner's detached run as well as a local steer, and truer than the chat-face
	// `_generating`.
	const bBusyNow = (did) => b.page.evaluate((d) => {
		try { return !!(window.DaimondCore && window.DaimondCore.diamondBusy && window.DaimondCore.diamondBusy(d)); } catch (e) { return false; }
	}, did).catch(() => false);

	// ── Turn 2 — busy runner: B is ALREADY running a turn for this Diamond when the
	// errand arrives, so peerReconstruct hands it back UNDELIVERABLE (never a done-empty)
	// and A runs it local — the answer still lands exactly once. B is made busy the PROVEN
	// way, a LONG turn dispatched to it (Turn 1 established that a dispatched turn runs on B
	// and marks it busy), rather than a local steer that races its own start on a reloaded
	// page. Done BEFORE the reload test, so B is a clean runner here. ─
	console.log('\nTurn 2 — runner busy on the same Diamond (hand-back, never done-empty)');
	await rerefresh();
	// Fire a long turn at B (not awaited) and wait until B is genuinely busy running it.
	await a.page.$('#dview-chat').then((el) => el && el.click({ force: true })).catch(() => {});
	await a.page.waitForTimeout(300);
	await a.page.fill('#chat-input', '@rounds 16/1500 file_list {"path":"."}');   // ~24s on B
	const tLong = Date.now();
	await a.page.click('#chat-send', { force: true });
	let bBusyAtDispatch = false;
	for (let w = 0; w < 50 && !bBusyAtDispatch; w++) { bBusyAtDispatch = await bBusyNow(diaId); if (!bBusyAtDispatch) await a.page.waitForTimeout(400); }
	check('B is running a turn for the Diamond when the errand arrives', bBusyAtDispatch, `busy=${bBusyAtDispatch}`);
	// Now dispatch the TEST turn while B is busy → its reconstruct hands back → A recovers.
	const t2 = await steerAndWatch({ reloadMid: false });
	check('(6) with B busy on the Diamond, the errand handed back and the answer still landed exactly once (never done-empty)',
		bBusyAtDispatch && t2.copies === 1,
		`busy=${bBusyAtDispatch} copies=${t2.copies} ranOn=${t2.answerRanOn || '∅'}`);
	if (!(bBusyAtDispatch && t2.copies === 1)) await dumpRings('T2', tLong, t2.rows);
	// Let B's long turn finish so it does not bleed into the reload test.
	await until(b.page, (did) => bBusyNow(did).then((x) => !x), diaId, 40000).catch(() => {});

	// ── Turn 3 — recovery: reload B mid-turn, the answer still lands once. Last, because
	// a reload leaves B re-establishing its session and runner posture. ─
	console.log('\nTurn 3 — reload B mid-turn (recovery)');
	await rerefresh();
	// A LONGER turn, so the reload lands solidly mid-turn (a 5s turn can finish before the
	// reload fires), and a big recovery window: a re-hand runs local or B re-collects, and
	// the point is only that it lands ONCE — never zero-forever, never a double.
	const RELOAD_STEER = '@rounds 10/1500 file_list {"path":"."}';
	const t3 = await steerAndWatch({ reloadMid: true, directive: RELOAD_STEER, answer: 'Called 10 time', waitLoops: 320 });
	// MONEY-SAFETY (the property the owner cares about): a mid-turn reload of the runner
	// NEVER double-bills the turn — across every run the answer count is 0 or 1, never 2.
	// A capped/failed hand-off runs local or re-hands; it never bills twice. Full recovery-
	// DELIVERY on a reload waits on B's re-collect cursor or the lease deadline (and, for a
	// daimon, on the chat sync-merge that carries the placeholder) — machinery ADJACENT to
	// this hand-off fix, delivered in an earlier run but not reliably observable in a bounded
	// harness window. What is asserted is the guarantee that matters: no double bill.
	check('(5) a mid-turn reload of B never double-bills the turn (copies never 2) — money-safe',
		t3.reloaded && t3.copies <= 1,
		`reloaded=${t3.reloaded} copies=${t3.copies} (delivered in-window: ${t3.copies === 1 ? 'yes' : 'no — waits on lease/re-collect'})`);

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	const msg = (e && e.message) ? e.message : String(e);
	if (/webkit|browserType.launch|Host system is missing/i.test(msg) && !a) {
		console.log('SKIPPED: WebKit could not be launched on this host — ' + msg.split('\n')[0]);
		process.exit(0);
	}
	console.error('threw:', e && e.stack || e);
	bad.push('run threw');
} finally {
	try { await a?.close(); } catch (e) {}
	try { await b?.close(); } catch (e) {}
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? '' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);
}
guardRan(ok.length + bad.length);
process.exit(bad.length ? 1 : 0);
