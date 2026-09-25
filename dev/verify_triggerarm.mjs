// verify_triggerarm.mjs -- only a person on this device makes a triggered action live.
//
// The final re-check of Deploy 1 (F1, 2026-09-24) found a daimon could arm a LIVE
// triggered action by writing its own `diamonds/<id>/triggers.json`. The `+` button
// seeded the action's pause leaf held; a file write did not, a leaf that appears later
// plays, and the next mail to arrive started a turn nobody sent. The same held for a
// synced copy of the file and for an import.
//
// The rule now (`releasedHereOnly` in pause.js): a triggered action's leaf is held
// until a person releases it ON THIS DEVICE, the release never travels, and it is
// bound to what the action does -- so an edit made anywhere but the app's own editor
// holds it again. Each property below is asserted at the wire (the mock provider's
// log), where the money is:
//
//   A. A daimon's own `file_write` of `triggers.json` lands, and the action it
//      wrote is HELD: its light reads held, `allowed` refuses, and a mail arrival
//      starts no turn. So is one whose id carries a slash (D1 of the delta
//      re-check, 2026-09-24): its leaf was joined raw and read as no trigger's.
//   B. A person's press of play on the action's own light arms it, and the same
//      arrival then does start the turn. Play on the Diamond's light, or on the
//      global one, arms nothing (the reopen rehearsal of 2026-09-25).
//   C. The release persists across a reload on this device.
//   D. A daimon rewriting the released action's instruction holds it again.
//   E. The app's own editor carries a release across the person's own edit.
//   F. An action that arrives by sync, released on the other device, arrives HELD,
//      and the release is not in the sync parcel.
//   G. Upgrade: an action that was live before the per-device rule arrives held, and
//      ONE notice names it; a second load does not repeat it.
//   H. A crystal page's `save` refuses `triggers.json` (static: the frame's own
//      guard, read from the served file).
//
//   eval "$(bash dev/world.sh 83 --up)"
//   node dev/verify_triggerarm.mjs            # the fix: every check passes
//   node dev/verify_triggerarm.mjs --base     # the four files as they were at aaf54d3a,
//                                             # served through page.route: A, D, F, G, H fail
//   TRIGARM_BASE=b32be427 node dev/verify_triggerarm.mjs
//                                             # any revision: there, the slash rows of A fail
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, signInAs, newChat, mockLog, scratch, connectMock } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.join(HERE, '..');
// `--base`, or TRIGARM_BASE=1 for a runner that passes only the environment; any
// other TRIGARM_BASE is a revision to serve the four files from.
const ENV_BASE = process.env.TRIGARM_BASE || '';
const BASE = (process.argv.includes('--base') || ENV_BASE === '1') ? 'aaf54d3a' : ENV_BASE;
const FILES = ['js/pause.js', 'js/triggers.js', 'js/daimond.js', 'js/crystal.js'];

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail != null ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const BOX = 'arm@example.test';
const said = (from, nonce) => mockLog().slice(from).some((e) => JSON.stringify(e).includes(nonce));

/// The four files as they stood at the base, served in place of the working tree's.
async function routeBase(page) {
	if (!BASE) return;
	for (const f of FILES) {
		const body = execFileSync('git', ['-C', TREE, 'show', BASE + ':www/' + f], { maxBuffer: 1 << 26 }).toString();
		await page.route('**/' + f + '*', (r) => r.fulfill({ status: 200,
			contentType: 'application/javascript', body }));
	}
}

// ── H. static: the crystal page's guard ──────────────────────────────────────
{
	const src = BASE
		? execFileSync('git', ['-C', TREE, 'show', BASE + ':www/js/crystal.js']).toString()
		: fs.readFileSync(path.join(TREE, 'www/js/crystal.js'), 'utf8');
	const m = src.match(/var PAGE_NEVER_WRITES = (\/.*\/);/);
	let re = null;
	try { re = m ? eval(m[1]) : null; } catch (e) { re = null; }
	check('H. a crystal page may not write the Diamond\'s triggers.json',
		!!re && re.test('triggers.json') && !re.test('log/triggers.json.txt') && !re.test('notes.json'),
		re ? String(re) : 'no guard found');
}

const s = await open({ name: 'trigarm', defaults: false, route: routeBase,
	profile: scratch('pw', 'trigarm-' + process.pid) });
const p = s.page;
if (BASE) console.log('  ..   serving ' + FILES.join(', ') + ' as at ' + BASE);
// The harness's form-driven connect waits fixed times and misses under load, which
// leaves no model connected and a New-diamond dialog that cannot create.
for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
	await p.keyboard.press('Escape').catch(() => {});
	await sleep(1500);
	await connectMock(s);
}

/// Where one action stands, as the app itself would judge it.
const where = (id, aid) => p.evaluate(({ id, aid }) => {
	const T = window.DaimondTriggers;
	const t = (window.DaimondTriggersOf(id) || []).find((x) => x.id === aid);
	if (!t) return { found: false };
	const leaf = T.node(id, t.id);
	const terms = T.terms ? T.terms(t) : undefined;
	const tile = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"] .pptw`);
	return {
		found: true,
		held: DaimondPause.isPaused(leaf, terms),
		allowed: T.allowed(id, t),
		light: DaimondPause.state(leaf),
		tile: tile ? tile.dataset.state : '(no light)',
	};
}, { id, aid });

/// Press play or pause on ONE action's own light: the control the Diamond's
/// dialog mounts beside its pulldown, drawn by the same `DaimondUI.pauseWidget`,
/// placed on the page and clicked as a person clicks it.
async function pressOwn(id, aid, act) {
	await p.evaluate(({ id, aid }) => {
		for (const x of document.querySelectorAll('[data-armprobe]')) x.remove();
		const leaf = DaimondTriggers.node(id, aid);
		const w = window.DaimondUI && DaimondUI.pauseWidget(leaf, 'probe');
		if (!w) return;
		w.dataset.armprobe = '1';
		w.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647';
		document.body.appendChild(w);
	}, { id, aid });
	let ok = true;
	try { await p.click('[data-armprobe] .pptw-' + act, { timeout: 8000 }); } catch (e) { ok = false; }
	await p.evaluate(() => { for (const x of document.querySelectorAll('[data-armprobe]')) x.remove(); });
	await sleep(800);
	return ok;
}

/// A turn the daimon takes because the person typed it: here, a `file_write`.
async function daimonWrites(id, content, marker) {
	await p.evaluate((id) => {
		const b = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`);
		if (b) b.click();
	}, id);
	await sleep(1200);
	await p.evaluate(() => { const b = document.getElementById('dview-chat'); if (b) b.click(); });
	await sleep(500);
	await p.waitForSelector('#chat-input', { timeout: 15000 });
	await p.fill('#chat-input', '@tool file_write ' + JSON.stringify({
		path: 'diamonds/' + id + '/triggers.json', content }));
	await p.click('#chat-send', { force: true });
	let disk = '';
	for (let i = 0; i < 60; i++) {
		await sleep(1000);
		disk = await p.evaluate(async (id) => {
			const M = await import('/pkg/oxedyne_daimond.js');
			try { return await M.store_read('diamonds/' + id + '/triggers.json'); } catch (e) { return ''; }
		}, id);
		const busy = await p.evaluate((id) => {
			try { return !!DaimondCore.diamondBusy(id); } catch (e) { return false; }
		}, id);
		if (disk.includes(marker) && !busy) break;
	}
	await p.evaluate(() => DaimondCore.loadDiamonds());
	await sleep(1200);
	return disk;
}

/// A mail arrival, with the screen on a chat -- a desktop left open on a conversation.
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

/// Back to the app after a reload, which comes back unlocked.
async function reload() {
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'trigarm');
	await sleep(2500);
	await p.evaluate(() => DaimondCore.loadDiamonds());
	await sleep(1500);
}

try {
	await sleep(1500);
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 20000 });
	await p.fill('.dlg-input', 'Arm probe');
	await p.waitForSelector('.dlg-ok:not([disabled])', { timeout: 10000 });
	await sleep(300);
	await p.click('.dlg-ok:not([disabled])');
	let id = '';
	for (let i = 0; i < 20 && !id; i++) {
		await sleep(1000);
		id = await p.evaluate(() => {
			const b = [...document.querySelectorAll('#diamond-list .diamond-box')]
				.find((x) => /Arm probe/.test(x.getAttribute('aria-label') || x.textContent || ''));
			return b ? b.dataset.id : '';
		});
	}
	check('setup: a Diamond made through the dialog a person uses', !!id, id);

	// ── A. the daimon writes its own triggers file ──────────────────────
	const NA = 'ARM-A-' + RUN;
	const act = (instruction, extra) => Object.assign({ id: 'm-arm', kind: 'mail', mailbox: BOX,
		folder: 'INBOX', instruction, offScreen: true }, extra || {});
	// Beside it, one whose id carries a slash, watching a folder of its own.
	const NS = 'ARM-S-' + RUN;
	const slashAct = act('@text ' + NS, { id: 'm/slash', folder: 'Slash' });
	const disk = await daimonWrites(id, JSON.stringify({ v: 1, actions: [act('@text ' + NA), slashAct] }), 'm/slash');
	check('A. the daimon\'s file_write of its own triggers.json lands', disk.includes(NA) && disk.includes(NS),
		disk.replace(/\s+/g, ' ').slice(0, 90));
	const a = await where(id, 'm-arm');
	check('A. the action it wrote is loaded, and HELD on this device', a.found && a.held === true && a.allowed === false,
		JSON.stringify(a));
	check('A. and its light and its Diamond\'s both say so', a.light === 'pause' && a.tile === 'pause',
		JSON.stringify(a));
	const firedA = await mailArrives('INBOX', NA, 20000);
	check('A. a mail arrival starts NO turn from the daimon-written action', !firedA,
		firedA ? 'the provider was sent ' + NA : 'nothing reached the provider in 20 s');
	const as = await where(id, 'm/slash');
	check('A. the one with a slash in its id is HELD as well, and its light says so',
		as.found && as.held === true && as.allowed === false && as.light === 'pause', JSON.stringify(as));
	const firedS = await mailArrives('Slash', NS, 20000);
	check('A. and a mail arrival starts NO turn from it', !firedS,
		firedS ? 'the provider was sent ' + NS + ' -- an unbidden turn' : 'nothing reached the provider in 20 s');

	// ── B. a person releases it on this device ─────────────────────────
	await p.evaluate((id) => {
		const b = document.querySelector(`#diamond-list .diamond-box[data-id="${id}"]`);
		if (b) b.scrollIntoView();
	}, id);
	// Play on the Diamond's light, and on the global one, releases no action: each
	// waits for play on its own light (the reopen rehearsal of 2026-09-25).
	const play = `#diamond-list .diamond-box[data-id="${id}"] .pptw .pptw-play`;
	let onTile = true;
	try { await p.click(play, { timeout: 8000 }); } catch (e) { onTile = false; }
	await sleep(800);
	let onRoot = true;
	try { await p.click('#pptw-global .pptw-play', { timeout: 8000 }); } catch (e) { onRoot = false; }
	await sleep(800);
	const b0 = await where(id, 'm-arm'), b0s = await where(id, 'm/slash');
	check('B. play pressed on the Diamond\'s light, and on the global one, releases neither action',
		onTile && onRoot && b0.held === true && b0.allowed === false && b0s.held === true && b0s.allowed === false,
		JSON.stringify({ onTile, onRoot, b0, b0s }));
	const pressed = await pressOwn(id, 'm-arm', 'play');
	const b = await where(id, 'm-arm');
	check('B. play pressed on the action\'s own light releases it here', pressed && b.held === false && b.allowed === true,
		JSON.stringify(b));
	const firedB = await mailArrives('INBOX', NA, 30000);
	check('B. and the same arrival now starts its turn', firedB,
		firedB ? 'the provider was sent ' + NA : 'nothing in 30 s');
	const pressedS = await pressOwn(id, 'm/slash', 'play');
	const bs = await where(id, 'm/slash');
	check('B. play on the slash-id action\'s own light releases it too: a person can still arm it',
		pressedS && bs.held === false && bs.allowed === true, JSON.stringify(bs));

	// ── C. the release persists on this device ─────────────────────────
	await reload();
	const c = await where(id, 'm-arm');
	check('C. after a reload the release is still here: no nag, no re-arm', c.held === false && c.allowed === true && c.light === 'play',
		JSON.stringify(c));

	// ── D. the daimon rewrites the released action ─────────────────────
	const ND = 'ARM-D-' + RUN;
	await daimonWrites(id, JSON.stringify({ v: 1, actions: [act('@text ' + ND)] }), ND);
	const d = await where(id, 'm-arm');
	check('D. a daimon that rewrites a released action\'s instruction holds it again',
		d.found && d.held === true && d.allowed === false && d.light === 'pause', JSON.stringify(d));
	const firedD = await mailArrives('INBOX', ND, 20000);
	check('D. and its instruction reaches nobody', !firedD,
		firedD ? 'the provider was sent ' + ND : 'nothing in 20 s');

	// ── E. the app's own editor carries the person's release ───────────
	await pressOwn(id, 'm-arm', 'play');	// judged below
	const NE = 'ARM-E-' + RUN;
	await p.evaluate(async ({ id, ne }) => {
		const t = (window.DaimondTriggersOf(id) || []).find((x) => x.id === 'm-arm');
		await DaimondCore.triggerSet(id, Object.assign({}, t, { instruction: '@text ' + ne }));
	}, { id, ne: NE });
	await sleep(500);
	await p.evaluate(() => DaimondCore.loadDiamonds());
	await sleep(1200);
	const e = await where(id, 'm-arm');
	check('E. an edit made in the app\'s own editor keeps the release the person gave here',
		e.held === false && e.allowed === true, JSON.stringify(e));

	// ── F. an action arrives by sync, released on the other device ─────
	//
	// What a sync delivers is the file and the pause record: the other device's
	// release took the leaf out of the paused set and moved its stamp. Both are
	// applied through the doors the sync uses -- the store write and `adopt`.
	const NF = 'ARM-F-' + RUN;
	await p.evaluate(async ({ id, box, nf }) => {
		const M = await import('/pkg/oxedyne_daimond.js');
		const cur = JSON.parse(await M.store_read('diamonds/' + id + '/triggers.json'));
		cur.actions.push({ id: 'm-sync', kind: 'mail', mailbox: box, folder: 'Synced',
			instruction: '@text ' + nf, offScreen: true });
		await M.store_write('diamonds/' + id + '/triggers.json', JSON.stringify(cur));
		const rec = DaimondPause.snapshot();
		DaimondPause.adopt({ paused: rec.paused.filter((k) => !/m-sync/.test(k)), stamp: Date.now() + 5000 });
		await DaimondCore.loadDiamonds();
	}, { id, box: BOX, nf: NF });
	await sleep(1500);
	const f = await where(id, 'm-sync');
	check('F. an action that arrives by sync, released elsewhere, arrives HELD here',
		f.found && f.held === true && f.allowed === false, JSON.stringify(f));
	const firedF = await mailArrives('Synced', NF, 20000);
	check('F. and a mail arrival starts no turn from it', !firedF,
		firedF ? 'the provider was sent ' + NF : 'nothing in 20 s');
	const parcel = await p.evaluate(() => JSON.stringify(DaimondPause.snapshot()));
	check('F. the release given here is not in the sync parcel',
		!parcel.includes('ARM-') && !/"here"|terms/.test(parcel), parcel.slice(0, 160));
	const stillE = await where(id, 'm-arm');
	check('F. while the action released here stays live', stillE.allowed === true, JSON.stringify(stillE));

	// ── G. upgrade: live before the rule, held after it, said once ─────
	//
	// The device as the previous release left it: an action ready and unpaused, and
	// no release recorded here, because releases were not recorded anywhere.
	const NG = 'ARM-G-' + RUN;
	await p.evaluate(async ({ id, box, ng }) => {
		const M = await import('/pkg/oxedyne_daimond.js');
		const cur = JSON.parse(await M.store_read('diamonds/' + id + '/triggers.json'));
		cur.actions.push({ id: 'm-old', kind: 'mail', mailbox: box, folder: 'Old',
			instruction: '@text ' + ng, offScreen: true });
		await M.store_write('diamonds/' + id + '/triggers.json', JSON.stringify(cur));
		localStorage.removeItem('daimond-pause-here');
		localStorage.removeItem('daimond-trig-here-notice');
	}, { id, box: BOX, ng: NG });
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'trigarm');
	const notice = await p.waitForFunction(() => {
		const h = [...document.querySelectorAll('.dlg-card h2')].map((x) => x.textContent).join(' ');
		const body = [...document.querySelectorAll('.dlg-card .dlg-pre, .dlg-card .dlg-msg')].map((x) => x.textContent).join(' ');
		return /held on this device/i.test(h) ? body : null;
	}, null, { timeout: 25000 }).then((h) => h.jsonValue()).catch(() => '');
	check('G. the first load after the upgrade says ONCE which actions are held here',
		!!notice && /Old/.test(notice) && /Arm probe/.test(notice), (notice || '(no notice)').replace(/\s+/g, ' ').slice(0, 160));
	try { await p.click('.dlg-card .dlg-ok', { timeout: 3000 }); } catch (e) { /* no notice to close */ }
	await sleep(1000);
	const g = await where(id, 'm-old');
	check('G. and the action that was live before is held until released here',
		g.found && g.held === true && g.allowed === false, JSON.stringify(g));
	// SHOWN, as well as held: the boot draws the rail before it reads the actions,
	// so this is asked of the rail as the boot left it, with nothing redrawn by hand.
	check('G. and its Diamond\'s tile shows the held light as the boot left it', g.tile === 'pause',
		JSON.stringify(g));
	const firedG = await mailArrives('Old', NG, 20000);
	check('G. so a mail arrival starts no turn from it', !firedG,
		firedG ? 'the provider was sent ' + NG : 'nothing in 20 s');
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'trigarm');
	await sleep(6000);
	const again = await p.evaluate(() => [...document.querySelectorAll('.dlg-card h2')]
		.some((x) => /held on this device/i.test(x.textContent)));
	check('G. and the next load does not say it again', !again, again ? 'shown twice' : 'not repeated');
} catch (err) {
	check('the run finished', false, String(err && err.message || err));
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
