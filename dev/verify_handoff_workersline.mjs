// gateway: live
// verify_handoff_workersline.mjs — the asker sees the runner's workers, live.
//
// A (WebKit or Chromium, an iPhone's user agent) dispatches a turn that starts two
// workers and gathers them; B (Chromium, a desktop) runs it. The workers exist only
// on B, so the one way A can know where each has got to is the runner's progress
// frame. Since 0ffe75e2 (18 Sep) frames are `{v:1,msgs}` rows and nothing carried
// worker state, so A's hand-off tile said nothing about a fan-out in flight.
//
// The properties:
//
//   LIVE   — while B's `beta` is still running, A's hand-off tile names it as running,
//            drawn with the agents panel's own status pill.
//   FINAL  — the last worker line A drew before the answer merged has every worker
//            finished, so the line converges rather than freezing on "running".
//   HOSTED — the workers ran on B and no copy ran on A.
//
// A's worker line is recorded by a MutationObserver on A's page, so a state shown for
// a few hundred milliseconds between the gather and the merge is not missed by a poll.
//
//   DAIMOND_BROWSER=webkit   node dev/verify_handoff_workersline.mjs
//   DAIMOND_BROWSER=chromium node dev/verify_handoff_workersline.mjs
//   DAIMOND_BROWSER=webkit   node dev/verify_handoff_workersline.mjs --break noframe
import { open, chat, signInAs, newChat, connectMock, servedChats } from './harness.mjs';
import { makePagePro } from './pro.mjs';
import { GW_URL } from './ports.mjs';
import { nominateRunner, beatAsApp } from './handoffpair.mjs';
import { guardRan } from './verdict.mjs';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : '';
})();
const BREAKS = ['noframe'];
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
	a = await open({ name: 'wllead', touch: true, ua: IPHONE_UA });
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
	b = await open({ name: 'wlmate', signIn: false, connect: false, browser: 'chromium' });
	await b.page.waitForFunction(() => !!window.DaimondPairing, null, { timeout: 15000 }).catch(() => {});
	const code = await a.page.evaluate(() => DaimondPairing.create());
	await b.page.evaluate((c) => DaimondPairing.redeem(c), code.code);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'wllead');
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
	await nominateRunner(check, a, b, 'wlmate');
	await beatAsApp(b, 'wlmate');
	await a.page.evaluate(() => window.DaimondSync.refreshPresence
		&& window.DaimondSync.refreshPresence());
	await a.page.waitForTimeout(1500);
	const aSeesB = await a.page.evaluate((self) =>
		(window.DaimondPresence.awake(self, Date.now()) || []).length, idA);
	check('A sees B as an awake peer it can hand a turn to', aSeesB >= 1, 'awake peers: ' + aSeesB);

	// ── The turn: two workers and a gather, dispatched from the phone ─────
	//
	// `alpha` answers at once; `beta` takes six seconds, which is the window in which
	// A has to be able to say one worker is finished and the other is still going.
	console.log('\nWorkers on the runner — A dispatches, B runs, A watches the worker line');
	await newChat(a);
	await a.page.setViewportSize({ width: 420, height: 520 });
	await a.page.waitForTimeout(300);

	// Record every worker line A draws, as `name:pillclass` pairs.
	await a.page.evaluate(() => {
		window.__hwSeen = [];
		const out = document.getElementById('chat-output') || document.body;
		const snap = () => {
			for (const row of out.querySelectorAll('.handoff-workers')) {
				const s = [...row.querySelectorAll('.hw')].map((w) => {
					const n = w.querySelector('.hw-name'), p = w.querySelector('.pill');
					return (n ? n.textContent : '?') + ':' + (p ? p.className.replace(/^pill\s*/, '') : '?');
				}).join(' ');
				const seen = window.__hwSeen;
				if (s && seen[seen.length - 1] !== s) seen.push(s);
			}
		};
		new MutationObserver(snap).observe(out, { childList: true, subtree: true, characterData: true, attributes: true });
	});

	// The break: the runner leaves its workers out of its frames.
	const applyBreak = async () => {
		if (BREAK !== 'noframe') return;
		await b.page.evaluate(() => {
			if (window.DaimondWorkers) window.DaimondWorkers.frameList = function () { return []; };
		}).catch(() => {});
	};
	await applyBreak();

	const tDispatch = Date.now();
	await a.page.fill('#chat-input',
		'@tools spawn_agent {"name":"alpha","task":"@text ALPHAFOUND"}'
		+ ' ;; spawn_agent {"name":"beta","task":"@slow 6000"}'
		+ ' ;; gather {"names":["alpha","beta"],"timeout_s":60}');
	await a.page.click('#chat-send', { force: true });

	// LIVE: a line naming beta as running reached A while beta was running on B.
	let liveLine = '', betaLiveOnB = false, ranOnB = 0;
	for (let i = 0; i < 240; i++) {
		let rs = []; try { rs = await runsOn(b.page); } catch (e) { rs = []; }
		if (rs.length > ranOnB) ranOnB = rs.length;
		const betaRunning = rs.some((r) => r.name === 'beta' && r.status === 'running');
		if (betaRunning) betaLiveOnB = true;
		let seen = []; try { seen = await a.page.evaluate(() => window.__hwSeen.slice()); } catch (e) { seen = []; }
		const hit = seen.find((s) => /\bbeta:run\b/.test(s));
		if (hit && betaRunning && !liveLine) liveLine = hit;
		let cs = []; try { cs = await servedChats(a); } catch (e) { cs = []; }
		if (carrying(cs, '### alpha') > 0) break;
		await a.page.waitForTimeout(250);
	}
	check('the workers ran on the RUNNER', ranOnB >= 2, `${ranOnB} run(s) on B`);
	const onA = await runsOn(a.page);
	check('and no copy of them ran on the phone',
		onA.filter((r) => r.name === 'alpha' || r.name === 'beta').length === 0,
		JSON.stringify(onA.map((r) => r.name)));
	check('B held beta running for a window A could see', betaLiveOnB);
	check('LIVE: A drew beta as running while it ran on B',
		!!liveLine, liveLine || 'no worker line naming beta as running reached A');

	let cs = [];
	for (let i = 0; i < 120; i++) {
		try { cs = await servedChats(a); } catch (e) { cs = []; }
		if (carrying(cs, '### alpha') > 0) break;
		await a.page.waitForTimeout(300);
	}
	check('the gather\'s result crossed the hand-off into A\'s transcript',
		carrying(cs, '### alpha') >= 1, `${Math.round((Date.now() - tDispatch) / 1000)}s`);
	const seen = await a.page.evaluate(() => window.__hwSeen.slice());
	const last = seen[seen.length - 1] || '';
	check('FINAL: A\'s last worker line had alpha and beta both finished',
		/\balpha:ok\b/.test(last) && /\bbeta:ok\b/.test(last), last || 'no worker line at all');
	console.log('  lines A drew: ' + JSON.stringify(seen));

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
