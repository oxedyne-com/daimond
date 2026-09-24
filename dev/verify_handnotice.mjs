// verify_handnotice.mjs — with an old Hand paired, the notice is a tile and the
// attach picker's + still reaches it.
//
// `dev/verify_handrun.mjs` already asserts "nothing stands over the +" against its
// own stand-in, which has said `meter:deletes` since the 2026-09-24 H1 fix and so
// never raises the notice this file is about at all — that check is trivially true
// there for a different reason (nothing was ever put up) and cannot also prove the
// positive: that with the notice actually showing, the picker still opens.
// `dev/verify_handmeterless.mjs` already proves the notice itself, word for word,
// but never opens a chat or touches the attach group. This file is the missing
// combination of the two, kept separate rather than bent into either: nobody
// reading either of those two files should have to learn a second thing they are
// not about.
//
// Reuses `dev/handbridge.mjs` to pair a REAL, deliberately OLD hand binary
// (`plant`/`fakeExtension`/`bridge`, extracted out of `dev/verify_handmeterless.mjs`
// for this) rather than a second copy of the native-messaging wire.
//
//   eval "$(bash dev/world.sh N --env)"
//   node dev/verify_handnotice.mjs
//
//   HD_OLD_BIN=<path>  the hand older than the deletion meter; default the base
//                      build in the slot's `lane-bc-base` target (the same one
//                      `dev/verify_handmeterless.mjs` defaults `HD_OLD_BINS` to).
//
// And, since the R2 QA of 2026-09-24 (`~/usr/code/ai/claude/specs/daimond_r2_qa_20260924.md`):
//
//   F4  in a window 760px wide or less the notice does not rise as a sheet over the
//       composer: it counts on the Pending chip and the input and Send stay reachable;
//   F5  it is not marked told when raised, survives another tab's Pending write, is not
//       raised twice by a second hello while it is up, and once taken down is not raised
//       by the next one.
//
// The fixtures are keyed by the RUN, not only by `$RC_SLOT`: two runs sharing a slot
// wiped each other's on 2026-09-24.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { open, connectMock, newChat, scratch } from './harness.mjs';
import { plant, fakeExtension, bridge } from './handbridge.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SLOT = process.env.RC_SLOT || 'solo';
const BIN  = process.env.HD_OLD_BIN
	|| path.join(os.homedir(), '.cache/cargo-targets', SLOT, 'lane-bc-base/release/daimond-hand');
// A SIBLING of ~/.cache/daimond, never a child of it -- see verify_handdelete.mjs's
// own note on the same rule: the meter treats that path as a toolchain cache.
const RUN    = process.pid.toString(36) + '-' + Date.now().toString(36);
const FIX    = path.join(os.homedir(), '.cache/daimond-handdelete', SLOT, 'notice-picker-' + RUN);
const EXT_ID = 'fake-ext-verify-handnotice';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(BIN)) {
	console.log(`verify_handnotice: no hand binary at ${BIN} -- build it or set HD_OLD_BIN`);
	process.exit(1);
}

fs.rmSync(FIX, { recursive: true, force: true });
const root = path.join(FIX, 'old');
plant(path.join(root, 'grant', 'proj'), 5);

let br = null;
const s = await open({
	name: 'handnotice', connect: false,
	profile: scratch('pw', 'handnotice-' + process.pid),
	route: async (page) => {
		br = bridge(page, BIN, root);
		await page.exposeBinding('__toHand', (src, raw) => br.fromPage(raw));
		await page.addInitScript(fakeExtension, EXT_ID);
	},
});
const { page } = s;
try {
	// BYO, exactly as `typed_turn_control.mjs` and `verify_typedpause.mjs` connect --
	// this file is about the notice and the picker, not about which key a turn runs
	// on, so the simplest account (none at all) is the right one.
	for (let i = 0; i < 4 && !(s.cfg && s.cfg.baseUrl); i++) {
		await page.keyboard.press('Escape').catch(() => {});
		await sleep(1000);
		await connectMock(s);
	}
	await page.evaluate((id) => window.DaimondHand.setExtId(id), EXT_ID);

	// The hand's real hello, taken by the relay. `status()` is what opens the link
	// (see its own comment in daimond.js) — this binary predates the deletion
	// meter, so its hello names no `meter:deletes` and `onMeterless` fires from
	// `adopt()` regardless of `paired`, which stays false in every headless run
	// (there is no native dialog here to grant a real folder — see
	// `verify_handmeterless.mjs`'s own §1.14 note).
	const real = JSON.parse(await page.evaluate(() => window.DaimondHand.status()));
	const caps = Array.isArray(real.caps) ? real.caps : [];
	check('the stand-in old hand said hello', caps.length > 0, JSON.stringify(real).slice(0, 200));
	check('and it does not say meter:deletes — the case this file is about',
		caps.length > 0 && !caps.includes('meter:deletes'), caps.join(' '));

	// The notice, raised the moment that hello was adopted — before any chat exists.
	const staleTitle = await page.evaluate(() =>
		window.DaimondI18n ? window.DaimondI18n.t('hand.stale_title') : '');
	let notice = null;
	for (const t0 = Date.now(); Date.now() - t0 < 10000; ) {
		notice = await page.evaluate((title) => {
			const items = window.DaimondPendingView ? window.DaimondPendingView.items() : [];
			const it = items.find((x) => x.kind === 'notice' && x.headline === title);
			return it ? { headline: it.headline, detail: it.detail } : null;
		}, staleTitle);
		if (notice) break;
		await sleep(200);
	}
	check('the notice is a Pending tile', !!notice, JSON.stringify(notice));
	check('naming the deletion meter, not a dialog\'s worth of nothing',
		!!notice && /older than the deletion meter/.test(notice.detail), notice && notice.detail.slice(0, 160));

	// An ordinary chat -- not a Diamond, which needs a model dialog this file has
	// no reason to drive -- reaching the same attach group `verify_handrun.mjs`
	// presses. The notice above is already on the Pending panel, a fixed side
	// list, so nothing about opening a chat should move it or cover it.
	await newChat(s, { reuse: true });
	await page.waitForSelector('#chat-input', { timeout: 10000 });

	const cover = await page.evaluate(() => {
		const btn = document.querySelector('#chat-attachments .ws-group [data-act="attach-add"]');
		if (!btn) return 'there is no + in the workspace group';
		btn.scrollIntoView({ block: 'nearest' });
		const r = btn.getBoundingClientRect();
		const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
		if (top && (top === btn || btn.contains(top))) return '';
		const card = top && top.closest('.dlg');
		const head = card && card.querySelector('h2');
		if (head) return 'a dialog stands over it: ' + head.textContent;
		return top ? 'it is under ' + top.outerHTML.slice(0, 160) : 'it is not on screen';
	});
	check('with the notice showing, nothing stands over the +', cover === '', cover);

	await page.click('#chat-attachments .ws-group [data-act="attach-add"]', { force: true });
	const opened = await page.waitForSelector('.attach-pick-row', { timeout: 10000 }).then(() => true, () => false);
	check('and the click still opens the picker', opened);

	// Still there afterwards: opening the picker did not read as acting on the
	// notice, and the notice did not close the picker either — two unrelated
	// pieces of UI, which is the whole point of moving it off the composer.
	const stillThere = await page.evaluate((title) => {
		const items = window.DaimondPendingView ? window.DaimondPendingView.items() : [];
		return items.some((x) => x.kind === 'notice' && x.headline === title);
	}, staleTitle);
	check('and the notice is still on the panel, untouched by any of that', stillThere);

	// ── F5: told once, and marked told only when it is taken down ─────────
	const handTiles = (pg) => pg.evaluate((title) => (window.DaimondPendingView.items() || [])
		.filter((x) => x.kind === 'notice' && x.headline === title).map((x) => ({ id: x.id, key: x.key })), staleTitle);
	const told = () => page.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-pending-noticed') || '[]'); } catch (e) { return []; }
	});
	const hello = async () => {
		await page.evaluate((id) => window.DaimondHand.setExtId(id), EXT_ID);
		await page.evaluate(() => window.DaimondHand.status()).catch(() => {});
		await sleep(2500);
	};
	const up0 = await handTiles(page);
	check('F5: the notice carries its (host, version) key, and is not marked told while it is up',
		up0.length === 1 && /^hand-stale\|/.test(up0[0].key || '')
			&& !(await told()).some((k) => /^hand-stale\|/.test(k)),
		JSON.stringify({ up0, told: await told() }));

	// A second tab of the same account, acting on the same panel.
	const p2 = await page.context().newPage();
	await p2.goto(page.url(), { waitUntil: 'domcontentloaded' });
	await p2.waitForFunction(() => !!window.DaimondPendingView, null, { timeout: 60000 });
	await sleep(2500);
	await p2.evaluate(() => window.DaimondPendingView.add({ kind: 'proposal', headline: 'handnotice proposal from tab 2', detail: 'x' }));
	await sleep(800);
	const seen1 = await page.evaluate(() => window.DaimondPendingView.items().map((x) => x.kind + ':' + x.headline));
	check('F5: another tab\'s Pending write arrives here without a reload, and keeps the notice',
		seen1.some((x) => /tab 2/.test(x)) && (await handTiles(page)).length === 1, JSON.stringify(seen1));
	await p2.close();
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => !!window.DaimondPendingView, null, { timeout: 60000 });
	await sleep(1500);
	check('F5: and after a reload the notice is still there', (await handTiles(page)).length === 1,
		JSON.stringify(await page.evaluate(() => window.DaimondPendingView.items().map((x) => x.kind + ':' + x.headline))));
	// A new page's hello, the tile still up: told already, not told twice.
	await hello();
	check('F5: a second hello while the notice is up does not raise a second one',
		(await handTiles(page)).length === 1, JSON.stringify(await handTiles(page)));
	// Taken down: marked told now, and the next page's hello raises nothing.
	const up1 = await handTiles(page);
	if (up1.length) await page.evaluate((id) => window.DaimondPendingView.drop(id), up1[0].id);
	check('F5: taking it down marks it told', (await told()).some((k) => k === (up1[0] && up1[0].key)),
		JSON.stringify(await told()));
	await page.reload({ waitUntil: 'domcontentloaded' });
	await page.waitForFunction(() => !!window.DaimondPendingView, null, { timeout: 60000 });
	await sleep(1500);
	await hello();
	check('F5: and the next hello from the same hand raises nothing', (await handTiles(page)).length === 0,
		JSON.stringify(await handTiles(page)));

	// ── F4: a narrow window ──────────────────────────────────────────────
	await newChat(s, { reuse: true });
	await page.waitForSelector('#chat-input', { timeout: 10000 });
	await page.setViewportSize({ width: 720, height: 900 });
	await sleep(2000);
	const reach = () => page.evaluate(() => {
		const res = {};
		for (const [k, sel] of [['input', '#chat-input'], ['send', '#chat-send']]) {
			const el = document.querySelector(sel);
			if (!el) { res[k] = 'absent'; continue; }
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height) { res[k] = 'not drawn'; continue; }
			const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			res[k] = (top && (top === el || el.contains(top))) ? '' : ('under ' + (top ? (top.id || top.className || top.tagName) : 'nothing'));
		}
		res.narrow = window.matchMedia('(max-width: 760px)').matches;
		res.chip = window.DaimondBadge ? window.DaimondBadge.count('pending') : -1;
		return res;
	});
	const n0 = await reach();
	check('F4: at 720px the composer is reachable before the notice', n0.narrow && n0.input === '' && n0.send === '',
		JSON.stringify(n0));
	// What `noteHandStale` does once it has decided to speak.
	await page.evaluate(() => window.DaimondPendingView.add({ kind: 'notice', headline: 'handnotice narrow', detail: 'x' }));
	await sleep(1500);
	const n1 = await reach();
	check('F4: a notice arriving at 720px leaves the input and Send uncovered', n1.input === '' && n1.send === '',
		JSON.stringify(n1));
	check('F4: and counts on the Pending chip instead', n1.chip === n0.chip + 1, JSON.stringify({ before: n0.chip, after: n1.chip }));
} finally {
	if (br) br.close();
	await s.close();
	fs.rmSync(FIX, { recursive: true, force: true });
}

console.log('');
console.log(ok.length + ' ok, ' + bad.length + ' failed');
if (bad.length) process.exit(1);
