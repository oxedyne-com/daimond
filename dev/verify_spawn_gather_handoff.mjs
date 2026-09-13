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
//                duplicates nothing: the run comes back `interrupted`, and A's
//                transcript never holds the same report twice.
//
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway
// (DAIMOND_GW_PORT). Pro-gated via pro.mjs. Run under WebKit:
//   DAIMOND_BROWSER=webkit node dev/verify_spawn_gather_handoff.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_spawn_gather_handoff.mjs --break noline
import { open, chat, signInAs, newChat, connectMock, storedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';

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
const streamedOf = (pg) => pg.evaluate(() => {
	const el = document.querySelector('.handoff-stream');
	return el ? String(el.textContent || '') : '';
});
const allMsgs = (cs) => (cs || []).flatMap((c) => (c.messages || []));
/// How many stored messages carry `needle`, which is how a DUPLICATE is counted.
const carrying = (cs, needle) => allMsgs(cs)
	.filter((m) => m && typeof m.content === 'string' && m.content.includes(needle)).length;
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
	// phone's frame has to be able to describe.
	console.log('\nWorkers on the runner — A dispatches, B runs, A watches');
	await newChat(a);
	await a.page.setViewportSize({ width: 420, height: 520 });
	await a.page.waitForTimeout(300);
	const tDispatch = Date.now();
	await a.page.fill('#chat-input',
		'@tools spawn_agent {"name":"alpha","task":"@text ALPHAFOUND"}'
		+ ' ;; spawn_agent {"name":"beta","task":"@slow 6000"}'
		+ ' ;; gather {"names":["alpha","beta"],"timeout_s":60}');
	await a.page.click('#chat-send', { force: true });

	// The break: the runner keeps its workers to itself. Without the `[workers: …]`
	// line a frame says `[tool spawn_agent …]` and nothing about whether the worker
	// is still going -- which is what the phone had before this and what a reader
	// waiting on a fan-out cannot use.
	// A RELOAD RESTORES IT, so it is applied through a function that is called again
	// after the reload as well -- a break that survives only until the page comes
	// back is a break that proves nothing.
	const applyBreak = async () => {
		if (BREAK !== 'noline') return;
		await b.page.evaluate(() => {
			if (window.DaimondWorkers) window.DaimondWorkers.liveLine = function () { return ''; };
		}).catch(() => {});
	};
	await applyBreak();
	let reloaded = false;

	// Sample both sides while the turn runs: the frame on A's screen, and the runs
	// B is holding. A frame is gone the moment the answer merges, so it has to be
	// caught during the turn rather than looked for afterwards.
	let sawWorkersLine = '', sawSpawnLine = false, liveWhenSeen = 0, ranOnB = 0;
	for (let i = 0; i < 200; i++) {
		let shot = ''; try { shot = await streamedOf(a.page); } catch (e) { shot = ''; }
		if (shot) {
			if (/\[tool spawn_agent/.test(shot)) sawSpawnLine = true;
			const m = shot.match(/\[workers:[^\]]*\]/);
			if (m && !sawWorkersLine) sawWorkersLine = m[0];
		}
		let rs = []; try { rs = await runsOn(b.page); } catch (e) { rs = []; }
		if (rs.length > ranOnB) ranOnB = rs.length;
		const live = rs.filter((r) => r.status === 'running' || r.status === 'queued').length;
		if (live > liveWhenSeen) liveWhenSeen = live;
		// PARK: reload B while it is genuinely inside a gather. Any earlier and the
		// turn had not started; any later and there is nothing to interrupt.
		if (!reloaded) {
			let waiting = 0;
			try {
				waiting = await b.page.evaluate(() => (window.DaimondWorkers
					&& window.DaimondWorkers.awaiting) ? window.DaimondWorkers.awaiting.length : 0);
			} catch (e) { waiting = 0; }
			if (waiting > 0) {
				reloaded = true;
				await b.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
				await b.page.waitForFunction(() => !!window.DaimondWorkers,
					null, { timeout: 15000 }).catch(() => {});
				await applyBreak();
			}
		}
		let cs = []; try { cs = await storedChats(a); } catch (e) { cs = []; }
		if (carrying(cs, '### alpha') > 0) break;
		await a.page.waitForTimeout(250);
	}

	check('the workers ran on the RUNNER, and only there',
		ranOnB >= 1, `${ranOnB} run(s) on B`);
	const onA = await runsOn(a.page);
	check('and no copy of them ran on the phone, so one task is billed once',
		onA.filter((r) => r.name === 'alpha' || r.name === 'beta').length === 0,
		JSON.stringify(onA.map((r) => r.name)));
	check('a progress frame told the phone a worker had been dispatched',
		sawSpawnLine, sawSpawnLine ? 'yes' : 'no [tool spawn_agent line reached A');
	check('and where each worker had got to, which the transcript alone cannot say',
		!!sawWorkersLine, sawWorkersLine || 'no [workers: …] line reached A');

	if (reloaded) {
		const after = await runsOn(b.page);
		check('the reload left the interrupted run saying so, rather than vanishing',
			after.some((r) => r.status === 'interrupted'),
			JSON.stringify(after.map((r) => `${r.name}:${r.status}`)));
	}

	// ── What A ends up with ──────────────────────────────────────────────
	//
	// Given up to a minute: a parked turn is re-dispatched, and the second attempt
	// runs the whole thing again.
	await until(a.page, () => {
		try {
			const raw = window.DaimondSync ? 1 : 1;
			return raw === 1;
		} catch (e) { return true; }
	}, null, 500);
	let cs = [];
	for (let i = 0; i < 200; i++) {
		try { cs = await storedChats(a); } catch (e) { cs = []; }
		if (carrying(cs, '### alpha') > 0) break;
		await a.page.waitForTimeout(300);
	}
	const copies = carrying(cs, '### alpha');
	check('the gather\'s own result crossed the hand-off into A\'s transcript',
		copies >= 1, `${copies} message(s) carry it, ${Math.round((Date.now() - tDispatch) / 1000)}s`);
	check('and it is there ONCE, so a park did not deliver the same report twice',
		copies <= 1, `${copies} copies`);

	// SETTLED: by the time A has the report, no worker of that turn is still going
	// on B. `runErrand` posts `done` only after `drainAgenticRounds` settles, and a
	// report on A's side is downstream of that post.
	const finalRuns = await runsOn(b.page);
	check('no worker was left running once the errand had reported',
		finalRuns.every((r) => r.status !== 'running' && r.status !== 'queued'),
		JSON.stringify(finalRuns.map((r) => `${r.name}:${r.status}`)));

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
process.exit(bad.length ? 1 : 0);
