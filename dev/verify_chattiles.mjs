// verify_chattiles.mjs — notes4 "= Chats", items 1 and 2, plus the ordering fix.
//
// Three properties, each traced to a real complaint in notes4:
//
//   1. THE CLOSER CAME BACK. A chat tile carries a × again (a Diamond tile does
//      not — verify_tiledlg covers that half). It does not remove the tile on
//      its own click: a chat is ephemeral but not disposable, so it asks first,
//      NAMING THE CHAT, and only removes it on "yes".
//
//   2. DELETE ALL CHATS lives behind the Chats section's own overflow (the ⋯ /
//      `#chats-menu-btn`), never as a second cross beside "+". The confirm it
//      opens NAMES THE COUNT — "Delete all 14 chats?", not a generic warning —
//      because the author's ruling was that bulk delete wants a STRONGER
//      confirmation than one chat's, not a lighter one.
//
//   3. ORDERING. Tiles list newest-touched first. Before this file's fix,
//      `renderSessionList` drew `chats` in plain array order, which was never a
//      sort: `newChat` unshifts a fresh chat to the front, but a reload reads
//      IndexedDB with a bare `openCursor()`, walking the store ascending BY ID
//      STRING — lexicographic, not numeric, so a tenth chat ('c10') sorted
//      before a second ('c2'). The fix sorts explicitly on `updatedAt`, which
//      is proved here by seeding chats whose ids and creation order say one
//      thing and whose `updatedAt` says another, so a check that only reads
//      row order or id order cannot pass by accident.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of js/daimond.js to the real page (through
// `page.route`) and the run is expected to FAIL. A break that does not apply
// cleanly aborts rather than passing quietly.
//
//   node dev/verify_chattiles.mjs --break nocross     # 1: no × on a chat tile
//   node dev/verify_chattiles.mjs --break noconfirm   # 1: × deletes without asking
//   node dev/verify_chattiles.mjs --break nomenu      # 2: the overflow does nothing
//   node dev/verify_chattiles.mjs --break weakcount   # 2: the confirm drops the count
//   node dev/verify_chattiles.mjs --break noorder     # 3: tiles are not sorted
//   node dev/verify_chattiles.mjs                     # and then, clean
//
//   eval "$(bash dev/world.sh 2 --up)"
//   eval "$(bash dev/world.sh 2 --env)"
//   node dev/verify_chattiles.mjs
//
// Needs dev/serve.mjs only. Chats are seeded straight into IndexedDB (the same
// store `daimond-chats` the app itself reads on boot) rather than clicked into
// existence one at a time, so `updatedAt` and `id` can be set to exactly the
// values that expose the ordering bug, and a run stays fast with a dozen tiles.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const PROFILE = scratch('pw', 'chattiles' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
const BREAKS = {
	// The × never gets onto the tile at all.
	nocross: [{
		file: 'js/daimond.js',
		find: '\t\theader.appendChild(tileCloser(s.name, function () { deleteChat(s); }));',
		with: '',
	}],
	// The × is there, but it removes the chat on click rather than asking —
	// the exact regression the confirm exists to prevent.
	noconfirm: [{
		file: 'js/daimond.js',
		find: '\t\theader.appendChild(tileCloser(s.name, function () { deleteChat(s); }));',
		with: '\t\theader.appendChild(tileCloser(s.name, function () { removeChat(s); }));',
	}],
	// The overflow button is in the markup but wired to nothing.
	nomenu: [{
		file: 'js/daimond.js',
		find: 'openChatsMenu(chatsMenuBtn);',
		with: '',
	}],
	// "Delete all chats" still asks, but the question no longer says how much
	// it is about to take — the generic confirm a single delete already gives.
	weakcount: [{
		file: 'js/daimond.js',
		find: "\t\tvar msg = tn('rail.delete_all_chats_confirm', n, { n: n });",
		with: "\t\tvar msg = t('rail.delete_all_chats');",
	}],
	// The tile list draws in whatever order `chats` happens to hold, which is
	// what "the ordering is weird" was about.
	noorder: [{
		file: 'js/daimond.js',
		find: '\t\tloose.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });',
		with: '',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified
/// to differ from the file on disk.
function damaged(spec) {
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

// ── The fixture: eleven chats, seeded so id order, creation order and
// updatedAt order all disagree ──────────────────────────────────────────
//
// Names are NATO letters so a glance at the tile list reads as a word order,
// not a guess at what a timestamp meant. `updatedAt` is the permutation that
// matters; `id` is assigned in a DIFFERENT order again, so a check that
// happens to pass by reading row/id order instead of `updatedAt` is caught by
// this file rather than by a user filing a second "weird" report.
const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot',
	'Golf', 'Hotel', 'India', 'Juliet', 'Kilo'];
// Touched-most-recently-first, i.e. the order the tiles MUST render in.
const TOUCH_ORDER = ['Foxtrot', 'Alpha', 'Kilo', 'Charlie', 'India', 'Echo',
	'Juliet', 'Bravo', 'Hotel', 'Delta', 'Golf'];
// Ids assigned in yet another order, so ascending-by-id (what a bare
// `openCursor()` returns, and what `newChat`'s `seq++` would give a fresh
// chat) does not coincide with TOUCH_ORDER either. Includes the c9/c10 pair
// that sorts backwards as strings, matching the real bug's shape.
const ID_ORDER = ['Delta', 'Kilo', 'Bravo', 'Golf', 'Alpha', 'Hotel',
	'Foxtrot', 'Charlie', 'India', 'Juliet', 'Echo'];

const BASE_T = Date.parse('2026-08-01T00:00:00Z');

function seedRecords() {
	const idOf = {};
	ID_ORDER.forEach((name, i) => { idOf[name] = 'c' + (i + 1); });		// c1..c11
	const touchRank = {};
	TOUCH_ORDER.forEach((name, i) => { touchRank[name] = i; });
	return NAMES.map((name) => ({
		id: idOf[name],
		name,
		messages: [{ role: 'user', content: 'hello from ' + name }],
		model: 'mock/fast',
		provider: 'mock',
		status: 'active',
		promptTokens: 1, completionTokens: 1, cachedTokens: 0, costUsd: 0,
		prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
		// Latest TOUCH_ORDER entry gets the largest stamp.
		updatedAt: BASE_T + (TOUCH_ORDER.length - touchRank[name]) * 1000,
	}));
}

/// Write straight into `daimond-chats`, the same IndexedDB store `loadChats`
/// reads on boot — not through the UI, which would only ever create chats in
/// creation order and could never set up the id/touch mismatch this file needs.
async function seedChats(page, records) {
	await page.evaluate((recs) => new Promise((resolve, reject) => {
		const req = indexedDB.open('daimond-chats', 1);
		req.onupgradeneeded = () => {
			const d = req.result;
			if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
		};
		req.onsuccess = () => {
			const db = req.result;
			const t = db.transaction('chats', 'readwrite');
			const store = t.objectStore('chats');
			recs.forEach((r) => store.put(r));
			t.oncomplete = () => resolve();
			t.onerror = () => reject(t.error);
		};
		req.onerror = () => reject(req.error);
	}), records);
}

/// The tile names as drawn, top to bottom. The label lives in an `<input>`
/// (double-click to rename), so it is read by VALUE, not textContent.
const tileNames = (page) => page.$$eval('#session-list .session-box .tile-label',
	(els) => els.map((e) => e.value));

/// The one visible confirm dialog's message, or null if none is open.
const openDialogMsg = (page) => page.evaluate(() => {
	const card = [...document.querySelectorAll('.modal.dlg .dlg-card')]
		.find((c) => c.getClientRects().length);
	return card ? (card.querySelector('.dlg-msg') || {}).textContent || '' : null;
});
const clickDialog = (page, cls) => page.evaluate((c) => {
	const btns = [...document.querySelectorAll('.modal.dlg .' + c)]
		.filter((b) => b.getClientRects().length);
	const b = btns[btns.length - 1];
	if (b) b.click();
}, cls);

const s = await open({
	name: 'chattiles', profile: PROFILE, connect: false, defaults: false,
});
const { page } = s;

if (BREAK) {
	for (const spec of BREAKS[BREAK]) {
		const body = damaged(spec);
		await page.route('**/' + spec.file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
	// The stub only takes effect on a load after it is installed, and
	// `clearDiamonds` inside `open()` already reloaded once with the routes
	// absent — so the page is reloaded again, now with the broken file served.
	await page.reload({ waitUntil: 'domcontentloaded' });
	const { signInAs } = await import('./harness.mjs');
	await signInAs(s, 'chattiles');
}

try {
	await seedChats(page, seedRecords());
	// A fresh load, through the real boot path (`chats = await loadChats()`),
	// not a poke at the DOM: this is what proves the fix reads the STORE
	// correctly and does not merely happen to sort whatever the UI built.
	await page.reload({ waitUntil: 'domcontentloaded' });
	const { signInAs } = await import('./harness.mjs');
	await signInAs(s, 'chattiles');
	await page.waitForTimeout(1000);

	// ── 0. The gate ────────────────────────────────────────────────
	const seeded = await tileNames(page);
	check('all eleven seeded chats reached the rail', seeded.length === 11,
		`${seeded.length}: ${seeded.join(', ')}`);
	if (seeded.length !== 11) {
		console.log('\nnothing to test against — refusing to report a vacuous pass.');
		await s.close();
		process.exit(1);
	}
	await shot(s, 'chattiles-seeded' + (BREAK ? '-' + BREAK : ''));

	// ── 3. ORDERING: newest-touched first ─────────────────────────
	// The MEANING asserted is "the tile at the top is the one most recently
	// touched, named Foxtrot" — not a count and not "the list changed shape".
	const drawn = await tileNames(page);
	check(`the top tile is the most recently touched chat, "${TOUCH_ORDER[0]}"`,
		drawn[0] === TOUCH_ORDER[0], `top was "${drawn[0]}"`);
	check(`the bottom tile is the least recently touched, "${TOUCH_ORDER[TOUCH_ORDER.length - 1]}"`,
		drawn[drawn.length - 1] === TOUCH_ORDER[TOUCH_ORDER.length - 1],
		`bottom was "${drawn[drawn.length - 1]}"`);
	check('the WHOLE order is newest-touched-first, not merely its two ends',
		JSON.stringify(drawn) === JSON.stringify(TOUCH_ORDER),
		`drawn: ${drawn.join(', ')}\n         want: ${TOUCH_ORDER.join(', ')}`);
	// And it does not just happen to equal id order or seeding order — if it
	// did, the check above could pass by accident on unsorted code.
	check('the id-ascending order is a DIFFERENT sequence from the drawn one — proof this is not accidental',
		JSON.stringify(ID_ORDER) !== JSON.stringify(TOUCH_ORDER));

	// ── 1. THE CLOSER CAME BACK ────────────────────────────────────
	// The top tile — "Foxtrot" — is the one a user reaches for first, so it is
	// the one this half of the file acts on.
	//
	// Clicked through `page.evaluate`, not a Playwright locator: a locator's
	// `.click()` auto-waits up to 30s for the element to appear and then
	// THROWS, which under `--break nocross` (no × at all) would abort the
	// script before it reached its own `bad.length` report — a break that
	// crashes the harness instead of failing a check proves nothing more than
	// the break above proved. `clickCross` returns false when there is
	// nothing to click, and every check below reads that as a plain FAIL.
	const clickCross = () => page.evaluate(() => {
		const box = document.querySelector('#session-list .session-box');
		const x = box && box.querySelector('.tile-x');
		if (!x) return false;
		x.click();
		return true;
	});
	const crossCount = await page.evaluate(() => {
		const box = document.querySelector('#session-list .session-box');
		return box ? box.querySelectorAll('.tile-x').length : -1;
	});
	check('the top chat tile carries a × ', crossCount === 1, String(crossCount));

	const clicked1 = await clickCross();
	await page.waitForTimeout(300);
	const askMsg = clicked1 ? await openDialogMsg(page) : null;
	check('the × does not delete on its own click — it opens a confirm first',
		askMsg !== null,
		!clicked1 ? 'no × to click' : askMsg === null ? 'no dialog appeared; the tile may already be gone' : 'a dialog opened');
	check('and the confirm NAMES THE CHAT ("Foxtrot"), not a generic warning',
		!!(askMsg && askMsg.includes('Foxtrot')), JSON.stringify(askMsg));
	await shot(s, 'chattiles-close-confirm' + (BREAK ? '-' + BREAK : ''));

	// Say no: the tile must still be there, in the same place.
	await clickDialog(page, 'dlg-cancel');
	await page.waitForTimeout(400);
	const afterNo = await tileNames(page);
	check('answering "no" leaves the chat exactly where it was',
		JSON.stringify(afterNo) === JSON.stringify(TOUCH_ORDER),
		`${afterNo.join(', ')}`);

	// Say yes: Foxtrot, and only Foxtrot, is gone.
	const clicked2 = await clickCross();
	await page.waitForTimeout(300);
	if (clicked2) await clickDialog(page, 'dlg-ok');
	await page.waitForTimeout(500);
	const afterYes = await tileNames(page);
	const wantAfterYes = clicked2 ? TOUCH_ORDER.filter((n) => n !== 'Foxtrot') : TOUCH_ORDER;
	check('answering "yes" removes THAT chat — the list is everyone else, still newest-first',
		clicked2 && JSON.stringify(afterYes) === JSON.stringify(wantAfterYes),
		`${afterYes.join(', ')}`);

	// ── 2. DELETE ALL CHATS ─────────────────────────────────────────
	// Reachable from the section's own overflow, and nowhere beside "+".
	const railButtons = await page.evaluate(() => {
		const head = document.querySelector('#new-session-btn').closest('.railhead');
		return [...head.querySelectorAll('button')].map((b) => ({
			id: b.id,
			// A cross by SHAPE: two crossing diagonal strokes, the same test
			// `verify_tiledlg` uses. The overflow must not be one of these.
			crossy: /M6 6l12 12M18 6L6 18/.test(b.innerHTML),
			dots: (b.innerHTML.match(/<circle/g) || []).length,
		}));
	});
	check('the Chats railhead has exactly two buttons: "+" and the overflow — no second cross beside "+"',
		railButtons.length === 2 && railButtons.every((b) => !b.crossy),
		JSON.stringify(railButtons));
	check('the overflow button is drawn as dots (⋯), not as a cross',
		(railButtons.find((b) => b.id === 'chats-menu-btn') || {}).dots === 3,
		JSON.stringify(railButtons));

	// Every menu lookup below is guarded against `.railhead-menu` not existing
	// at all — under `--break nomenu` the button is clickable but wired to
	// nothing, and a bare `m.querySelectorAll` on a null menu would crash the
	// harness the same way an un-guarded × click did above.
	const menuItemText = () => page.evaluate(() => {
		const m = document.querySelector('.railhead-menu');
		if (!m) return null;
		const btn = [...m.querySelectorAll('button')].find((b) => /delete all/i.test(b.textContent));
		return btn ? btn.textContent.trim() : null;
	});
	const clickDeleteAllItem = () => page.evaluate(() => {
		const m = document.querySelector('.railhead-menu');
		if (!m) return false;
		const btn = [...m.querySelectorAll('button')].find((b) => /delete all/i.test(b.textContent));
		if (!btn) return false;
		btn.click();
		return true;
	});

	let n = (await tileNames(page)).length;		// 10, after Foxtrot's removal above
	await page.click('#chats-menu-btn');
	await page.waitForTimeout(300);
	const menuItem = await menuItemText();
	check('the overflow menu offers "Delete all chats"', !!menuItem, String(menuItem));

	const pickedItem1 = await clickDeleteAllItem();
	await page.waitForTimeout(300);
	const bulkMsg = pickedItem1 ? await openDialogMsg(page) : null;
	check(`the bulk confirm NAMES THE COUNT — "…all ${n} chat…", not a generic warning`,
		!!(bulkMsg && new RegExp('all\\s+' + n + '\\s+chats?', 'i').test(bulkMsg)),
		!pickedItem1 ? 'no menu item to click' : JSON.stringify(bulkMsg));
	await shot(s, 'chattiles-deleteall-confirm' + (BREAK ? '-' + BREAK : ''));

	// Say no first: nothing is touched.
	await clickDialog(page, 'dlg-cancel');
	await page.waitForTimeout(400);
	const afterBulkNo = await tileNames(page);
	check('answering "no" to the bulk confirm leaves every chat standing',
		afterBulkNo.length === n, `${afterBulkNo.length} of ${n}`);

	// Say yes: every ordinary chat is gone, and the rail says so.
	await page.click('#chats-menu-btn');
	await page.waitForTimeout(300);
	const pickedItem2 = await clickDeleteAllItem();
	await page.waitForTimeout(300);
	if (pickedItem2) await clickDialog(page, 'dlg-ok');
	await page.waitForTimeout(600);
	const afterBulkYes = await tileNames(page);
	check('answering "yes" empties the Chats rail entirely',
		pickedItem2 && afterBulkYes.length === 0,
		`${afterBulkYes.length} left: ${afterBulkYes.join(', ')}`);
	const emptyNote = await page.evaluate(() =>
		(document.querySelector('#session-list .rail-note') || {}).textContent || '');
	check('and the rail says there are no chats, rather than showing an empty list with no explanation',
		/no chats/i.test(emptyNote), JSON.stringify(emptyNote));

	const errs = errors(s).filter((e) => !/favicon/i.test(e) && !/502 \(Bad Gateway\)/.test(e));
	check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

	await shot(s, 'chattiles-empty' + (BREAK ? '-' + BREAK : ''));
} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
