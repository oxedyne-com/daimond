// probe_heldresume.mjs -- a resume after Pause all releases no held triggered action.
//
// The reopen rehearsal of 2026-09-25 found that play on the global light, pressed to
// end a Pause all, released EVERY triggered action on the device, including one the
// person had never pressed: a play on any branch released each action under it, and
// every hold ended the releases under it. The rule since (`releasedHereOnly` in
// pause.js): only play on the action's own light releases it here; a hold on a
// branch suspends a release and its play puts it back as it stood.
//
// One device, one Diamond, two mail actions: "wanted", released on its own light,
// and "old", never pressed. Each property is asserted at the wire (the mock
// provider's log):
//
//   P. Pause all holds "wanted": a mail arrival starts no turn.
//   R. Its resume leaves "old" held, and a mail arrival for it starts no turn,
//      while "wanted" runs again on its next mail, released as it was before.
//   D. A pause and a play on the Diamond's light, and a play there with nothing
//      paused, leave "old" held.
//
//   eval "$(bash dev/world.sh 24 --up)"
//   node dev/probe_heldresume.mjs                       # the fix: every check passes
//   HELDRESUME_BASE=release/r51 node dev/probe_heldresume.mjs
//                                                       # pause.js as at that revision,
//                                                       # served through page.route: R, D fail
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, signInAs, newChat, mockLog, scratch, connectMock } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.join(HERE, '..');
const BASE = process.env.HELDRESUME_BASE || '';
const FILES = ['js/pause.js'];

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const BOX = 'resume@example.test';
const said = (from, nonce) => mockLog().slice(from).some((e) => JSON.stringify(e).includes(nonce));

async function routeBase(page) {
	if (!BASE) return;
	for (const f of FILES) {
		const body = execFileSync('git', ['-C', TREE, 'show', BASE + ':www/' + f], { maxBuffer: 1 << 26 }).toString();
		await page.route('**/' + f + '*', (r) => r.fulfill({ status: 200,
			contentType: 'application/javascript', body }));
	}
}

const s = await open({ name: 'heldresume', defaults: false, route: routeBase,
	profile: scratch('pw', 'heldresume-' + process.pid) });
const p = s.page;
if (BASE) console.log('  ..   serving ' + FILES.join(', ') + ' as at ' + BASE);
for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
	await p.keyboard.press('Escape').catch(() => {});
	await sleep(1500);
	await connectMock(s);
}

const where = (id, aid) => p.evaluate(({ id, aid }) => {
	const T = window.DaimondTriggers;
	const t = (window.DaimondTriggersOf(id) || []).find((x) => x.id === aid);
	if (!t) return { found: false };
	const leaf = T.node(id, t.id);
	return { found: true, held: DaimondPause.isPaused(leaf, T.terms(t)), allowed: T.allowed(id, t),
		released: !!DaimondPause.releasedHere(leaf) };
}, { id, aid });

/// Press a verb on one action's own light, drawn by the widget the Diamond's dialog mounts.
async function pressOwn(id, aid, act) {
	await p.evaluate(({ id, aid }) => {
		for (const x of document.querySelectorAll('[data-probe]')) x.remove();
		const w = window.DaimondUI && DaimondUI.pauseWidget(DaimondTriggers.node(id, aid), 'probe');
		if (!w) return;
		w.dataset.probe = '1';
		w.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647';
		document.body.appendChild(w);
	}, { id, aid });
	let pressed = true;
	try { await p.click('[data-probe] .pptw-' + act, { timeout: 8000 }); } catch (e) { pressed = false; }
	await p.evaluate(() => { for (const x of document.querySelectorAll('[data-probe]')) x.remove(); });
	await sleep(800);
	return pressed;
}

async function click(sel) {
	try { await p.click(sel, { timeout: 8000 }); } catch (e) { return false; }
	await sleep(800);
	return true;
}

/// A mail arrival in one folder, with the screen on a chat.
async function mailArrives(folder, nonce, waitMs) {
	try { await newChat(s); } catch (e) { /* already on one */ }
	await sleep(1500);
	const from = mockLog().length;
	await p.evaluate(({ box, folder }) => window.dispatchEvent(new CustomEvent('daimond:mail-arrived',
		{ detail: { mailbox: box, folder, count: 1, uids: [Date.now() % 100000] } })), { box: BOX, folder });
	for (let i = 0; i < waitMs / 1000; i++) {
		await sleep(1000);
		if (said(from, nonce)) return true;
	}
	return false;
}

try {
	await sleep(1500);
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 20000 });
	await p.fill('.dlg-input', 'Resume probe');
	await p.waitForSelector('.dlg-ok:not([disabled])', { timeout: 10000 });
	await sleep(300);
	await p.click('.dlg-ok:not([disabled])');
	let id = '';
	for (let i = 0; i < 20 && !id; i++) {
		await sleep(1000);
		id = await p.evaluate(() => {
			const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find((x) => /Resume probe/.test(x.getAttribute('aria-label') || x.textContent || ''));
			return b ? b.dataset.id : '';
		});
	}
	check('setup: a Diamond made through the dialog a person uses', !!id, id);

	const NW = 'RES-W-' + RUN, NO = 'RES-O-' + RUN;
	await p.evaluate(async ({ id, box, nw, no }) => {
		for (const [aid, folder, n] of [['wanted', 'Wanted', nw], ['old', 'Old', no]]) {
			await DaimondCore.triggerSet(id, { id: aid, kind: 'mail', mailbox: box, folder,
				instruction: '@text ' + n, offScreen: true });
		}
		await DaimondCore.loadDiamonds();
	}, { id, box: BOX, nw: NW, no: NO });
	await sleep(1500);
	const w0 = await where(id, 'wanted'), o0 = await where(id, 'old');
	check('setup: both actions are loaded and held, as after a reopen',
		w0.found && o0.found && w0.held && o0.held && !w0.allowed && !o0.allowed, JSON.stringify({ w0, o0 }));

	const own = await pressOwn(id, 'wanted', 'play');
	const w1 = await where(id, 'wanted'), o1 = await where(id, 'old');
	check('setup: play on "wanted"\'s own light releases it, and "old" stays held',
		own && w1.allowed && !o1.allowed, JSON.stringify({ w1, o1 }));
	check('setup: and "wanted" runs on a mail', await mailArrives('Wanted', NW, 30000));

	// ── P. Pause all ─────────────────────────────────────────────────
	const paused = await click('#pptw-global .pptw-pause');
	const wP = await where(id, 'wanted');
	check('P. Pause all, pressed on the global light, holds "wanted"', paused && wP.held && !wP.allowed,
		JSON.stringify(wP));
	check('P. and a mail arrival for it starts no turn', !(await mailArrives('Wanted', NW, 15000)));

	// ── R. its resume ───────────────────────────────────────────────
	const resumed = await click('#pptw-global .pptw-play');
	const wR = await where(id, 'wanted'), oR = await where(id, 'old');
	check('R. the resume leaves "old", never pressed, held on this device',
		resumed && oR.held === true && oR.allowed === false && !oR.released, JSON.stringify(oR));
	check('R. so a mail arrival for "old" starts no turn', !(await mailArrives('Old', NO, 15000)),
		'the provider was sent ' + NO + ' if this failed');
	check('R. while "wanted" is released as it was before the pause', wR.allowed === true, JSON.stringify(wR));
	check('R. and runs on its next mail', await mailArrives('Wanted', NW, 30000));

	// ── D. the Diamond's light ───────────────────────────────────────
	const tile = `#diamond-list .diamond-box[data-id="${id}"] .pptw`;
	await p.evaluate((id) => {
		const b = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`);
		if (b) b.scrollIntoView();
	}, id);
	const dp = await click(tile + ' .pptw-pause');
	const dr = await click(tile + ' .pptw-play');
	const oD = await where(id, 'old'), wD = await where(id, 'wanted');
	check('D. a pause and a play on the Diamond\'s light leave "old" held, and "wanted" released',
		dp && dr && oD.held === true && oD.allowed === false && wD.allowed === true, JSON.stringify({ oD, wD }));
	const again = await click(tile + ' .pptw-play');
	const oD2 = await where(id, 'old');
	check('D. and a play there with nothing paused leaves "old" held',
		oD2.held === true && oD2.allowed === false, JSON.stringify({ pressed: again, oD2 }));
	check('D. so a mail arrival for "old" still starts no turn', !(await mailArrives('Old', NO, 15000)));
} catch (err) {
	check('the run finished', false, String(err && err.message || err));
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
