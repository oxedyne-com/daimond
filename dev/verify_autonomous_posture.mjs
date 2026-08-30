// verify_autonomous_posture.mjs — the per-computer "autonomous" posture, the
// device-local switch that lets THIS machine finish work dispatched to it
// without asking, reaching the web and running commands on its own. The bound is
// the account's provider and Daimond credit, not a dialog; there is no spend gate
// by the owner's decision, so the only thing to prove here is the SHAPE of the
// gate, not a cap on it.
//
// It runs entirely in one page against the static server — no gateway, no o3db,
// no mock provider. The egress gate `egressAllowed` is driven through the same
// `window.__daimondEgressAllowed` hook the wasm tools call, and the parked-vs-
// allowed outcome is read three ways that cannot lie: whether the promise
// resolved, whether a consent tile landed in `daimond-pending`, and whether a
// real `.modal.dlg` was raised.
//
//   node dev/verify_autonomous_posture.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM.
//
// The four claims, in the task's order:
//   a. OFF — a dispatched worker's web act (alone, nobody able to answer) still
//      PARKS on the Pending panel: unresolved, a consent tile written, no auto-allow.
//   b. ON  — the same act returns 'allow' at once: no park, no dialog, no tile.
//   c. STRICT — a `strict:true` navigation is NEVER auto-allowed, even with the
//      posture on: it still raises the dialog and does not resolve to 'allow'.
//   d. NO SYNC — the posture key appears nowhere in `DaimondCore.collectSync()`
//      nor in `DaimondSync.parcel()`, so arming one machine cannot arm another.
import { open } from './harness.mjs';

const KEY = 'daimond-autonomous-posture';		// must match daimond.js/handmode.js

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail !== undefined && detail !== '' ? ' — ' + detail : ''));
};
const note = (t) => console.log('        · ' + t);

const s = await open({ name: 'autonomous', signIn: true, connect: false, defaults: false });
const { page } = s;

/// Drive the gate and watch it for `ms`. Returns whether the promise resolved in
/// that window and, if so, the verdict — plus the DELTA in consent tiles on the
/// Pending panel and in real `.modal.dlg` dialogs, measured across the call so
/// nothing an earlier phase left behind is counted. The tagged stand-in modal for
/// "nobody can answer" is never counted as a dialog.
async function drive(payload, opts, ms) {
	return await page.evaluate(async (args) => {
		const consentCount = () => {
			try { return (JSON.parse(localStorage.getItem('daimond-pending') || '[]') || [])
				.filter(it => it && it.kind === 'consent').length; }
			catch (e) { return 0; }
		};
		const dialogCount = () => document.querySelectorAll('.modal.dlg:not([data-fake])').length;
		const consentBefore = consentCount(), dialogBefore = dialogCount();
		let done = false, verdict = null;
		const p = Promise.resolve(window.__daimondEgressAllowed(JSON.stringify(args.payload), args.opts))
			.then(v => { done = true; verdict = v; }, e => { done = true; verdict = 'ERR:' + (e && e.message || e); });
		await Promise.race([p, new Promise(r => setTimeout(r, args.ms))]);
		return { done, verdict, consent: consentCount() - consentBefore, dialogs: dialogCount() - dialogBefore };
	}, { payload, opts, ms });
}

/// Set the posture, and raise or clear the "nobody can answer" condition — a
/// tagged `.modal.dlg` makes `someoneCanAnswer()` false without being mistaken
/// for a dialog the gate itself put up.
async function setup(postureOn, blockAnswer) {
	await page.evaluate((args) => {
		if (args.postureOn) localStorage.setItem(args.KEY, '1');
		else localStorage.removeItem(args.KEY);
		document.querySelectorAll('.modal.dlg[data-fake]').forEach(n => n.remove());
		if (args.blockAnswer) {
			const m = document.createElement('div');
			m.className = 'modal dlg';
			m.setAttribute('data-fake', '1');
			document.body.appendChild(m);
		}
	}, { postureOn, blockAnswer, KEY });
}

try {
	await page.waitForFunction(() =>
		!!(window.__daimondEgressAllowed && window.DaimondCore && DaimondCore.collectSync),
		null, { timeout: 15000 });

	const act = { tool: 'web_click', url: 'https://shop.example/checkout', alone: true };

	// ═══════════════════════════════════════════════════════════════
	// a. POSTURE OFF — the dispatched worker still parks
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— a: posture OFF, a dispatched worker\'s web act still parks —');
	await setup(false, true);
	const offPosture = await page.evaluate((k) => localStorage.getItem(k), KEY);
	check('the posture reads OFF (silence, or explicitly cleared)', offPosture !== '1', `stored=${offPosture}`);
	const a = await drive(act, undefined, 800);
	note(`resolved=${a.done} verdict=${a.verdict} consentTiles=${a.consent} dialogs=${a.dialogs}`);
	check('OFF: the worker\'s act does NOT auto-allow (it waits)', a.done === false && a.verdict !== 'allow');
	check('OFF: it PARKS — a consent tile is raised on the Pending panel', a.consent === 1, `${a.consent} tile(s)`);
	check('OFF: and it does so by parking, not by a dialog into an empty room', a.dialogs === 0, `${a.dialogs} dialog(s)`);

	// ═══════════════════════════════════════════════════════════════
	// b. POSTURE ON — the same act is allowed at once
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— b: posture ON, the same act is allowed with no dialog and no park —');
	await setup(true, true);
	const onPosture = await page.evaluate((k) => localStorage.getItem(k), KEY);
	check('the posture reads ON for this computer', onPosture === '1', `stored=${onPosture}`);
	const b = await drive(act, undefined, 800);
	note(`resolved=${b.done} verdict=${b.verdict} consentTiles=${b.consent} dialogs=${b.dialogs}`);
	check('ON: the worker\'s act resolves to \'allow\'', b.done === true && b.verdict === 'allow', String(b.verdict));
	check('ON: nothing is parked — no consent tile', b.consent === 0, `${b.consent} tile(s)`);
	check('ON: and nothing is asked — no dialog', b.dialogs === 0, `${b.dialogs} dialog(s)`);

	// ═══════════════════════════════════════════════════════════════
	// c. STRICT is never auto-allowed, even with the posture on
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— c: strict:true is never auto-allowed, posture on or not —');
	await setup(true, false);				// posture on, no stand-in modal: a real dialog is expected
	const c = await drive({ url: 'https://elsewhere.example/' }, { strict: true }, 800);
	note(`resolved=${c.done} verdict=${c.verdict} dialogs=${c.dialogs}`);
	check('STRICT: the posture does NOT wave it through', !(c.done === true && c.verdict === 'allow'), String(c.verdict));
	check('STRICT: it still asks — a dialog is raised', c.dialogs >= 1, `${c.dialogs} dialog(s)`);
	// Clear the dialog we raised, so it cannot bleed into the next phase's counts.
	await page.evaluate(() => document.querySelectorAll('.modal.dlg').forEach(n => n.remove()));

	// ═══════════════════════════════════════════════════════════════
	// d. the posture key never enters the sync parcel
	// ═══════════════════════════════════════════════════════════════
	console.log('\n— d: the posture is device-local — it never enters the sync parcel —');
	await page.evaluate((k) => { try { localStorage.setItem(k, '1'); } catch (e) {} }, KEY);
	const sync = await page.evaluate(async () => {
		const collectJson = JSON.stringify(await window.DaimondCore.collectSync());
		let parcelJson = '', parcelErr = '';
		try {
			if (window.DaimondSync && DaimondSync.parcel) parcelJson = JSON.stringify(await DaimondSync.parcel());
		} catch (e) { parcelErr = String(e && e.message || e); }
		return { collectJson, parcelJson, parcelErr };
	});
	const inCollect = sync.collectJson.includes('daimond-autonomous-posture') || sync.collectJson.includes('autonomousPosture');
	check('the posture key is ABSENT from DaimondCore.collectSync()', !inCollect,
		`collect parcel is ${sync.collectJson.length} B`);
	if (sync.parcelJson) {
		const inParcel = sync.parcelJson.includes('daimond-autonomous-posture') || sync.parcelJson.includes('autonomousPosture');
		check('the posture key is ABSENT from DaimondSync.parcel() output', !inParcel,
			`sealed parcel is ${sync.parcelJson.length} B`);
	} else {
		// The sealed parcel only ever wraps what collectSync() returns, so absence
		// there is absence here; the offline seal did not run, which is noted, not failed.
		note(`DaimondSync.parcel() did not run offline (${sync.parcelErr || 'no output'}); collectSync() is the binding evidence`);
		check('the posture key is ABSENT from the sync parcel (via collectSync, its only source)', !inCollect);
	}

} catch (e) {
	check('no exception during the run', false, String(e && e.stack || e).slice(0, 400));
} finally {
	await s.close();
}

console.log('\n' + ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
