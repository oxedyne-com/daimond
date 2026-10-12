// gateway: live
// verify_spawn_gather_handoff.mjs — workers started INSIDE a handed-off turn.
//
// The house rule for any cross-device feature: two real contexts on a dev world,
// a WebKit phone and a desktop, before it ships. What is under test here is the
// in-turn pair (`spawn_agent` -> `DaimondWorkers.spawn`, `gather` ->
// `awaitReports`) on the one path where the turn is NOT running on the device
// that asked for it.
//
// A (WebKit, an iPhone's user agent, a touch context) dispatches a turn that
// starts two workers and gathers them. B (Chromium, a desktop) takes the errand
// and runs it. `Workers` is per page, so the workers run on B and nothing about
// them exists on A -- which is exactly why the phone has to be able to SEE them.
//
// The properties:
//
//   HOSTED     — the workers run on the runner, not on the phone. Two copies of a
//                worker is two bills for one task.
//   VISIBLE    — a progress frame reaching A names the dispatch and says where each
//                worker has got to, while B's workers are still live. The phone's
//                tile showed `[tool spawn_agent …]` before this and nothing about
//                whether the worker was still going, which is the one thing a
//                reader waiting on a fan-out wants.
//   IN-TURN    — A's finished transcript holds the gather's own result, so the
//                report crossed the hand-off as part of the turn rather than as a
//                second one.
//   SETTLED    — the errand is not reported done with a worker still running.
//   PARKED     — B reloading mid-gather loses nothing that was not already lost and
//                duplicates nothing: the run comes back `interrupted`, the turn is
//                not run again (r545 F-C2-1: no worker started twice), and A ends
//                with the runner's "Interrupted" rather than a second run's report.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs. Run under WebKit:
//   DAIMOND_BROWSER=webkit node dev/verify_spawn_gather_handoff.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_spawn_gather_handoff.mjs --break noline
import { open, chat, signInAs, newChat, connectMock, servedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { nominateRunner } from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['noline'];
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
/// The streamed tail A has on screen. A frame is a view, not a message, so the
/// store does not hold it and it exists only while the turn is running.
// The streamed turn on A's screen. Since 0ffe75e2 (2026-09-18) a frame is folded into A's
// transcript as PROVISIONAL rows drawn as the turn's own tiles -- the `spawn_agent` call as
// a tool tile (`.tool-block`) -- and the flattened `.handoff-stream` view is gone.
const streamedOf = (pg) => pg.evaluate(() => {
	const out = document.getElementById('chat-output');
	if (!out) return '';
	return [...out.querySelectorAll('.tool-block, .chat-msg-assistant .chat-msg-content, .ti-handoff')]
		.map((e) => String(e.textContent || '')).join('\n');
});
/// The worker row on A's hand-off tile, drawn from the runner's frame (`workers`), as
/// `name:pillclass` pairs, or ''.
const workersOf = (pg) => pg.evaluate(() => {
	const row = document.querySelector('#chat-output .handoff-workers');
	return row ? [...row.querySelectorAll('.hw')].map((w) => {
		const n = w.querySelector('.hw-name'), p = w.querySelector('.pill');
		return (n ? n.textContent : '?') + ':' + (p ? p.className.replace(/^pill\s*/, '') : '?');
	}).join(' ') : '';
});
const allMsgs = (cs) => (cs || []).flatMap((c) => (c.messages || []));
/// How many stored messages carry `needle`, which is how a DUPLICATE is counted.
/// The prompt carries the same words, so a user row is never counted.
const carrying = (cs, needle) => allMsgs(cs)
	.filter((m) => m && m.role !== 'user' && typeof m.content === 'string' && m.content.includes(needle)).length;
async function until(pg, fn, arg, ms = 30000, step = 250) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		let v = false; try { v = await pg.evaluate(fn, arg); } catch (e) { v = false; }
		if (v) return true;
		await pg.waitForTimeout(step);
	}
	return false;
}
/// Every worker run B is holding, as the pump has them.
const runsOn = (pg) => pg.evaluate(() => (window.DaimondWorkers
	? window.DaimondWorkers.runs.map((r) => ({ id: r.id, name: r.name, status: r.status,
		inTurn: !!r.inTurn, turnId: String(r.turnId || ''),
		gathered: String(r.gathered || '') }))
	: []));

// An iPhone's own statement about itself, which `detectMobile` reads first and
// treats as final. WebKit offers no `isMobile` -- that is Chromium's -- so the
// user agent is the only way to give the engine one.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) '
	+ 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let a, b;
try {
	// ── A: the phone that asks ────────────────────────────────────────────
	a = await open({ name: 'sglead', touch: true, ua: IPHONE_UA });
	await a.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	const pro = await makePagePro(a.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	check('A holds Pro', pro.pro === true, JSON.stringify(pro));
	await connectMock(a);
	await newChat(a);
	await chat(a, 'seed turn so the account has a chat and a parcel');
	await settle(a.page);

	// ── B: the desktop that runs it. CHROMIUM explicitly, whatever the suite
	// set: the pair is a phone and a desktop, and two WebKits would be one
	// engine wearing two viewports.
	b = await open({ name: 'sgmate', signIn: false, connect: false, browser: 'chromium' });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'sglead');
	await b.page.waitForFunction(() => !!window.DaimondSync && !!window.DaimondPeer
		&& window.DaimondGateway && DaimondGateway.state().authed,
		null, { timeout: 20000 }).catch(() => {});
	await makePagePro(b.page, new URL('../gateway', import.meta.url).pathname, GW_URL);
	await connectMock(b);
	await b.page.waitForTimeout(2000);
	await settle(b.page);

	const idA = await devId(a.page), idB = await devId(b.page);
	check('A and B are distinct paired devices', !!idA && !!idB && idA !== idB,
		JSON.stringify({ idA, idB }));

	await until(b.page, () => { try { return window.DaimondPost.state().parks > 0; }
		catch (e) { return false; } }, null, 8000);
	// B NOMINATED: since D-20261009-23 a send goes to the nominated runner or runs here,
	// so a phone with no nominee runs the workers itself.
	await nominateRunner(check, a, b, 'sgmate');
	await b.page.evaluate(() => window.DaimondSync.beatPresence(
		window.DaimondIdentity.deviceId(), 'sgmate'));
	await a.page.evaluate(() => window.DaimondSync.refreshPresence
		&& window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const aSeesB = await a.page.evaluate((self) =>
		(window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer it can hand a turn to', aSeesB >= 1, 'awake peers: ' + aSeesB);

	// ── The turn: two workers and a gather, dispatched from the phone ─────
	//
	// `alpha` answers at once; `beta` takes six seconds, so there is a window in
	// which one worker is finished and the other is live -- which is the window the
	// phone's frame has to be able to describe. Sent twice: once left to finish
	// (HOSTED, VISIBLE, IN-TURN, SETTLED), and once with B reloaded mid-gather (PARKED).
	const vp0 = a.page.viewportSize();
	const turn = async (park) => {
		const tag = (park ? 'park' : 'run') + Date.now().toString(36);
		// A new chat at the page's own size: at the phone's 420x520 the rail's New Chat
		// button is off screen, and the second turn starts from there.
		if (vp0) await a.page.setViewportSize(vp0);
		await newChat(a);
		await a.page.setViewportSize({ width: 420, height: 520 });
		await a.page.waitForTimeout(300);
		const tDispatch = Date.now();
		await a.page.fill('#chat-input',
			'@tools spawn_agent {"name":"alpha","task":"@text ALPHAFOUND ' + tag + '"}'
			+ ' ;; spawn_agent {"name":"beta","task":"@slow 6000"}'
			+ ' ;; gather {"names":["alpha","beta"],"timeout_s":60}');
		await a.page.click('#chat-send', { force: true });

		// The break: the runner keeps its workers to itself. Without the frame's `workers`
		// A's tile shows the `spawn_agent` call and nothing about whether the worker
		// is still going -- which is what the phone had before this and what a reader
		// waiting on a fan-out cannot use.
		// A RELOAD RESTORES IT, so it is applied through a function that is called again
		// after the reload as well -- a break that survives only until the page comes
		// back would prove nothing about the run that follows.
		const applyBreak = async () => {
			if (BREAK !== 'noline') return;
			await b.page.evaluate(() => {
				if (window.DaimondWorkers) window.DaimondWorkers.frameList = function () { return []; };
			}).catch(() => {});
		};
		await applyBreak();
		let reloaded = false, runsAtReload = 0;
		const before = new Set((await runsOn(b.page).catch(() => [])).map((r) => r.id));
		const mine = (rs) => rs.filter((r) => !before.has(r.id));
		// The turn's ending on A: the gather's report, or (parked) the runner's badge.
		const ended = (cs) => carrying(cs, 'ALPHAFOUND ' + tag) > 0
			|| allMsgs(cs).some((m) => m && m.interrupted && m.why === 'runner');

		// Sample both sides while the turn runs: the frame on A's screen, and the runs
		// B is holding. A frame is gone the moment the answer merges, so it has to be
		// caught during the turn rather than looked for afterwards.
		let sawWorkersLine = '', sawSpawnLine = false, ranOnB = 0;
		for (let i = 0; i < 200; i++) {
			let shot = ''; try { shot = await streamedOf(a.page); } catch (e) { shot = ''; }
			if (shot) {
				if (/\[tool spawn_agent|spawn_agent/.test(shot)) sawSpawnLine = true;
			}
			let wl = ''; try { wl = await workersOf(a.page); } catch (e) { wl = ''; }
			if (wl && !sawWorkersLine) sawWorkersLine = wl;
			let rs = []; try { rs = mine(await runsOn(b.page)); } catch (e) { rs = []; }
			if (rs.length > ranOnB) ranOnB = rs.length;
			// PARK: reload B while it is genuinely inside a gather. Any earlier and the
			// turn had not started; any later and there is nothing to interrupt.
			if (park && !reloaded) {
				let waiting = 0;
				try {
					waiting = await b.page.evaluate(() => (window.DaimondWorkers
						&& window.DaimondWorkers.awaiting) ? window.DaimondWorkers.awaiting.length : 0);
				} catch (e) { waiting = 0; }
				if (waiting > 0) {
					reloaded = true; runsAtReload = ranOnB;
					await b.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
					await b.page.waitForFunction(() => !!window.DaimondWorkers,
						null, { timeout: 15000 }).catch(() => {});
					await applyBreak();
				}
			}
			let cs = []; try { cs = await servedChats(a); } catch (e) { cs = []; }
			if (ended(cs)) break;
			await a.page.waitForTimeout(250);
		}

		// ── What A ends up with ──────────────────────────────────────────────
		let cs = [];
		for (let i = 0; i < 200; i++) {
			try { cs = await servedChats(a); } catch (e) { cs = []; }
			if (ended(cs)) break;
			await a.page.waitForTimeout(300);
		}
		const copies = carrying(cs, 'ALPHAFOUND ' + tag);
		const secs = Math.round((Date.now() - tDispatch) / 1000);
		if (!park) {
			check('the workers ran on the RUNNER, and only there', ranOnB >= 1, `${ranOnB} run(s) on B`);
			const onA = await runsOn(a.page);
			check('and no copy of them ran on the phone, so one task is billed once',
				onA.filter((r) => r.name === 'alpha' || r.name === 'beta').length === 0,
				JSON.stringify(onA.map((r) => r.name)));
			check('a progress frame told the phone a worker had been dispatched',
				sawSpawnLine, sawSpawnLine ? 'yes' : 'no [tool spawn_agent line reached A');
			check('and where each worker had got to, which the transcript alone cannot say',
				!!sawWorkersLine, sawWorkersLine || 'no worker row reached A\'s hand-off tile');
			check('the gather\'s own result crossed the hand-off into A\'s transcript',
				copies === 1, `${copies} message(s) carry it, ${secs}s`);
		} else {
			check('B was reloaded inside the gather', reloaded, reloaded ? `${runsAtReload} run(s) by then` : 'B never reached the gather');
			const after = mine(await runsOn(b.page));
			check('the reload left the interrupted run saying so, rather than vanishing',
				after.some((r) => r.status === 'interrupted'),
				JSON.stringify(after.map((r) => `${r.name}:${r.status}`)));
			// A run the runner lost ends interrupted and is not run again (r545 F-C2-1): no
			// worker is started a second time, and no report of a second run reaches A.
			check('no worker was started again after the reload', after.length <= runsAtReload,
				`${after.length} run(s) now, ${runsAtReload} at the reload`);
			const badge = allMsgs(cs).filter((m) => m && m.interrupted && m.why === 'runner').length;
			check('A ends with the runner\'s "Interrupted" and no report of a second run',
				badge === 1 && copies === 0, `badge=${badge} copies=${copies}, ${secs}s`);
		}
		// SETTLED: by the time A has the turn's ending, no worker of that turn is still
		// going on B. `runErrand` posts `done` only after `drainAgenticRounds` settles, and
		// the ending on A's side is downstream of that post.
		const finalRuns = mine(await runsOn(b.page));
		check((park ? '(parked) ' : '') + 'no worker was left running once the errand had reported',
			finalRuns.every((r) => r.status !== 'running' && r.status !== 'queued'),
			JSON.stringify(finalRuns.map((r) => `${r.name}:${r.status}`)));
	};
	console.log('\nWorkers on the runner — A dispatches, B runs, A watches');
	await turn(false);
	console.log('\nB reloads inside the gather — the run ends interrupted, not run again');
	await settle(a.page);
	await turn(true);

	console.log(`\n${ok.length} ok, ${bad.length} failed`);
	if (bad.length) console.log('  FAILED: ' + bad.join(' | '));
} catch (e) {
	// WebKit may simply not launch on this host -- the WPE build targets an older
	// Ubuntu. That is a missing ENGINE and not a failing product, so it skips, the
	// way `verify_webkit.mjs` does: a red suite that means "the host lacks a
	// browser" teaches everyone to ignore red.
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
