// gateway: live
// verify_beat_after_reload.mjs — a device that reloads is seen again at once, idle (r545 QA-C2 F-C2-1).
//
// WHAT HAPPENED. B ran a handed-off turn and reloaded in the middle of it. Its first beat after
// the reload came at unlock, before the gateway had signed it in, so it sent nothing, and the
// next beat was a whole interval (45 s) away. For that long every other device read B's beat
// from BEFORE the reload: busy with the turn the reload had ended. The election passed B over
// and the phone ran its next turn itself (verify_handoff_rerun AT=5, "ran locally").
//
// THE PROPERTY: within a few seconds of B being back and signed in, A's presence map holds a
// beat B made after the reload, and it says B is idle.
//
// RED on 436db66f, the base (B's record stays the pre-reload one: busy, and as old as the wait).
// Needs the dev stack: app (DAIMOND_PORT), mock (DAIMOND_MOCK_PORT), gateway.
//   node dev/verify_beat_after_reload.mjs

import {
	checker,
	pair,
	reload,
} from './handoffpair.mjs';

const { ok, bad, check } = checker();
const WITHIN = 8000;		// the wait for the post-reload beat; the interval it replaces is 45 s

let a, b;
try {
	({ a, b } = await pair(check, 'bra' + Date.now().toString(36), 'brb' + Date.now().toString(36)));
	const idB = await b.page.evaluate(() => window.DaimondIdentity.deviceId());
	// B as it stood the moment a reload cut its turn short: its last beat said busy.
	await b.page.evaluate(() => window.DaimondSync.beatPresence(window.DaimondIdentity.deviceId(), 'brb',
		true, true, false, false, undefined, undefined, 1));
	const seen = (id) => a.page.evaluate(async (id) => {
		await window.DaimondSync.refreshPresence();
		const r = (window.DaimondPresence.snapshot() || {})[id] || {};
		const ms = (v) => (v && v.toNumber) ? v.toNumber() : (+v || 0);
		return { busy: r.busy, at: ms(r.lastSeen) };
	}, id);
	const pre = await seen(idB);
	check('[ctl] A reads B busy before the reload', pre.busy > 0, JSON.stringify(pre));
	await a.page.waitForTimeout(3000);
	await reload(b);
	const back = Date.now();
	let now = pre;
	while (Date.now() - back < WITHIN) {
		now = await seen(idB);
		if (now.at > pre.at && !(now.busy > 0)) break;
		await a.page.waitForTimeout(500);
	}
	check('A holds a beat B made after its reload', now.at > pre.at,
		'beat ' + Math.round((Date.now() - now.at) / 1000) + 's old, ' + Math.round((Date.now() - back) / 1000) + 's after B was back');
	check('and it says B is idle, so the next turn can go to B', !(now.busy > 0), 'busy=' + now.busy);
} catch (e) {
	check('verifier ran', false, String(e && e.stack || e).slice(0, 600));
} finally {
	for (const s of [a, b]) { try { await s?.close(); } catch (e) { /* gone */ } }
	console.log('\n' + ok.length + ' passed, ' + bad.length + ' failed' + (bad.length ? ': ' + JSON.stringify(bad) : ''));
	process.exit(bad.length ? 1 : 0);
}
