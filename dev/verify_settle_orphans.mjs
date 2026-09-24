// verify_settle_orphans.mjs — `dev/settle_stale_orphans.js` closes a stale orphan
// hand-off on a build that would otherwise replay it, in every tab its report reaches,
// and this measures which tabs those are.
//
// Run it against a world serving the OLD page (48aa5913), which is the build the tool
// exists for: its recovery replays any unsettled orphan, and counts an `aborted` report
// as settled -- but keeps the report in page memory alone, filled only as its post box
// is collected, while the relay drops the row for the whole account at the first ack.
// A leaves three five-day-old hand-offs, and B, the desktop, holds all three.
//
//   (1) the dry run lists the orphan and posts nothing;
//   (2) the applied run posts one `aborted` report, for that orphan alone, and a post
//       the relay refuses is answered as not posted, with the refusal;
//   (3) B, AWAKE when the report went out (its post box collecting, its page never
//       reloaded), does not run the settled orphan when it comes back;
//   (4) the control, never settled, IS replayed on 48aa5913, which is what makes (3)
//       the tool's doing; on a page with the replay fix it is not;
//   (5) THE LIMIT. An orphan settled while B was ASLEEP -- its post box and wake channel
//       stopped until A had collected the report and acked it off the relay -- is
//       replayed on 48aa5913 when B wakes: nothing is left on the relay for B, and the
//       old page knows no report it did not collect. On a page with the replay fix it is
//       not run.
//   (6) THE REMEDY for (5): B woken with its network off first. Its recovery pass runs,
//       and runs neither the control nor the orphan it slept through: with no gateway it
//       can take no lease. So a device asleep when the tool runs is woken off the
//       network and its Daimond closed before it reconnects (reopen plan, item 4); a
//       fresh open then loads the fixed page. Only then is B put back on the network,
//       which is where (4) and (5) are measured.
//
// (4) and (5) are asserted either way, by whether the page has
// `DaimondPeer.handoffExpired`, the replay fix's own gate.
//
// B IS NEVER RELOADED between a post and its return. A reload with a network loads the
// fixed page (the service worker is network-first), so an old page reloaded after the
// post is not a state a device reaches -- and the reload empties the page's reports. The
// first cut of this check did reload B, and on 2026-09-23 it read as the tool failing:
// B had collected the report and acked it, the reload emptied its memory, and it replayed
// the settled orphan like the control (audit F3,
// ~/usr/code/ai/claude/specs/daimond_handoff_replay_fix_audit_20260923.md).
//
// `SETTLE_TOOL=<file>` drives another copy of the tool, to show a check failing before
// a fix.
//
//   eval "$(bash <old tree>/dev/world.sh N --env)"; node dev/verify_settle_orphans.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	checker,
	pair,
	storedMsgs,
	answersFor,
	placeholders,
	modelSaw,
	comeBack,
	sendAgo,
	reload,
	until,
	WAKE,
} from './handoffpair.mjs';

const HERE      = path.dirname(fileURLToPath(import.meta.url));
const TOOL      = fs.readFileSync(process.env.SETTLE_TOOL || path.join(HERE, 'settle_stale_orphans.js'), 'utf8');
const FIVE_DAYS = 5 * 86400000;
const QUIET_MS  = 30000;
const P_SETTLE  = 'Sweep the settled orphan from the workspace';
const P_CTRL    = 'Sweep the control orphan from the workspace';
const P_SLEPT   = 'Sweep the orphan settled while the desktop slept';
const { ok, bad, check } = checker();

const load  = (s) => s.page.evaluate((src) => { (0, eval)(src); return typeof window.settleStaleOrphans; }, TOOL);
const apply = (s, tid) => s.page.evaluate((only) => window.settleStaleOrphans({ apply: true, only }), [String(tid)]);
const cursor = (s) => s.page.evaluate(() => window.DaimondPost.state().through | 0).catch(() => -1);

/// Answers for `ph`, stored on either device.
async function answered(ph, a, b) {
	return answersFor(await storedMsgs(a), ph.iturn).length + answersFor(await storedMsgs(b), ph.iturn).length;
}

let a, b;
try {
	({ a, b } = await pair(check, 'solead', 'somate'));
	const saw = [modelSaw(P_SETTLE), modelSaw(P_CTRL), modelSaw(P_SLEPT)];
	const phS = await sendAgo(a, P_SETTLE, FIVE_DAYS);
	const phC = await sendAgo(a, P_CTRL, FIVE_DAYS);
	const phZ = await sendAgo(a, P_SLEPT, FIVE_DAYS);
	check('three five-day-old hand-offs stand on A', !!phS && !!phC && !!phZ);
	// Five days on there is no backstop timer on A, only what its store holds.
	await reload(a);
	let bHas = false;
	for (let i = 0; i < 60 && !bHas; i++) {
		await b.page.evaluate(() => window.DaimondSync.pull()).catch(() => {});
		const ids = placeholders(await storedMsgs(b)).map((m) => String(m.iturn));
		bHas = [phS, phC, phZ].every((p) => ids.includes(String(p.iturn)));
		if (!bHas) await b.page.waitForTimeout(500);
	}
	check('B holds all three placeholders', bHas);
	check('the tool loads in a signed-in tab', (await load(a)) === 'function');

	const dry = await a.page.evaluate((only) => window.settleStaleOrphans({ only }), [String(phS.iturn)]);
	check('(1) the dry run lists the orphan and posts nothing',
		Array.isArray(dry) && dry.length === 1 && dry[0].iturn === String(phS.iturn) && dry[0].posted === false,
		JSON.stringify(dry));
	const all = await a.page.evaluate(() => window.settleStaleOrphans());
	check('(1) and a dry run with no `only` lists all three', Array.isArray(all)
		&& [phS, phC, phZ].every((p) => all.some((r) => r.iturn === String(p.iturn))),
		JSON.stringify((all || []).map((r) => r.iturn)));

	// (2) A refusal is an ANSWER from `DaimondPost.post`, never a throw: a full box here.
	const refused = await a.page.evaluate(async (tid) => {
		const real = window.DaimondPost.post;
		window.DaimondPost.post = async () => ({ ok: false, status: 507, why: 'The box is full.' });
		try { return await window.settleStaleOrphans({ apply: true, only: [tid] }); }
		finally { window.DaimondPost.post = real; }
	}, String(phC.iturn));
	check('(2) a post the relay refuses is answered as not posted, with the refusal',
		Array.isArray(refused) && refused.length === 1 && refused[0].posted === false
		&& /full/.test(String(refused[0].error || '')), JSON.stringify(refused));

	// (3) B awake: its post box is parked on the relay when the report goes out.
	const bAwake = await cursor(b);
	const done = await apply(a, phS.iturn);
	check('(2) the applied run posts one `aborted` report, for that orphan alone',
		Array.isArray(done) && done.length === 1 && done[0].iturn === String(phS.iturn) && done[0].posted === true,
		JSON.stringify(done));
	const bGot = await until(b.page, (c) => window.DaimondPost.state().through > c, bAwake, 15000);
	check('(3) B, awake, collected the report: its post-box cursor passed the row', bGot,
		'cursor ' + bAwake + ' -> ' + (await cursor(b)));

	// (5) B asleep: no park, no wake channel, so nothing it could collect with.
	await b.page.evaluate(() => { window.DaimondPost.parkStop(); window.DaimondSync.wakeVia('off'); });
	await b.page.waitForTimeout(1500);
	const bAsleep = await cursor(b);
	const slept = await apply(a, phZ.iturn);
	check('(5) a second applied run posts the report for the orphan B sleeps through',
		Array.isArray(slept) && slept.length === 1 && slept[0].posted === true, JSON.stringify(slept));
	// A is awake, so it collects and acks, as its park would on its own a little later.
	await a.page.evaluate(() => window.DaimondPost.round());
	const left = await b.page.evaluate(async (c) => {
		const r = await window.DaimondPost.call('GET', undefined, '?since=' + c);
		return r && r.json && Array.isArray(r.json.rows) ? r.json.rows.length : -1;
	}, bAsleep).catch(() => -1);
	check('(5) by the time B wakes the relay holds nothing for it: A\'s ack took the report',
		left === 0 && (await cursor(b)) === bAsleep, 'rows above B\'s cursor: ' + left);

	// (6) B wakes with its network off. Its recovery pass is counted where it would run a
	// turn, so a pass that never started cannot read as one that ran nothing.
	const fixed = await a.page.evaluate(() => !!(window.DaimondPeer
		&& typeof window.DaimondPeer.handoffExpired === 'function')).catch(() => false);
	await b.page.context().setOffline(true);
	await b.page.evaluate(() => {
		const P = window.DaimondPeer;
		window.__runs = { began: 0, ended: 0 };
		const real = P.runErrand;
		P.runErrand = async function () {
			window.__runs.began++;
			try { return await real.apply(this, arguments); } finally { window.__runs.ended++; }
		};
	});
	const off = [modelSaw(P_CTRL), modelSaw(P_SLEPT)];
	await comeBack(b.page);
	// Until every attempt the pass began has ended, so none is still in flight when the
	// network comes back.
	let runs = { began: 0, ended: 0 };
	for (let i = 0, still = 0; i < 80 && still < 12; i++) {
		await b.page.waitForTimeout(250);
		runs = await b.page.evaluate(() => window.__runs).catch(() => runs);
		still = runs.began > 0 && runs.ended === runs.began ? still + 1 : 0;
	}
	const offRan = modelSaw(P_CTRL) - off[0] + modelSaw(P_SLEPT) - off[1];
	if (fixed) {
		check('(6) woken off the network, B runs nothing (the replay fix refuses before a take)',
			offRan === 0, 'model requests: ' + offRan + ', run attempts: ' + JSON.stringify(runs));
	} else {
		check('(6) THE REMEDY: woken off the network, the old page\'s recovery pass tries the unsettled orphans and runs neither',
			runs.began >= 2 && runs.ended === runs.began && offRan === 0,
			'run attempts: ' + JSON.stringify(runs) + ', model requests: ' + offRan);
	}
	await b.page.context().setOffline(false);
	await b.page.evaluate((m) => { window.DaimondPost.parkStart(); window.DaimondSync.wakeVia(m); }, WAKE);

	await comeBack(b.page);
	await comeBack(a.page);
	await a.page.waitForTimeout(QUIET_MS);
	const ranS = modelSaw(P_SETTLE) - saw[0];
	const ranC = modelSaw(P_CTRL)   - saw[1];
	const ranZ = modelSaw(P_SLEPT)  - saw[2];
	const ansS = await answered(phS, a, b);
	check('(3) the orphan settled while B was awake is run by no device', ranS === 0 && ansS === 0,
		'model requests carrying it: ' + ranS + ', answers stored: ' + ansS);
	// (4) and (5), ASSERTED EITHER WAY by the build in front of them. On a page older than
	// the replay fix the unsettled control MUST be replayed: that is the danger the tool
	// exists for, and without it (3) could pass on a world that never replays anything.
	if (fixed) {
		check('(4) the unsettled control is not replayed either: this page holds the replay fix',
			ranC === 0, 'model requests carrying it: ' + ranC);
		check('(5) nor the orphan settled while B slept', ranZ === 0, 'model requests carrying it: ' + ranZ);
	} else {
		check('(4) the unsettled control IS replayed on this old build, so (3) is the tool\'s doing',
			ranC > 0, 'model requests carrying it: ' + ranC);
		check('(5) THE LIMIT: the orphan settled while B slept IS replayed on this old build (the report never reached it)',
			ranZ > 0, 'model requests carrying it: ' + ranZ);
	}

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
