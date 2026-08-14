// verify_trash.mjs — deleting is reversible, and the reversal travels.
//
// WHY THIS FILE EXISTS. "Delete all chats" shipped with a dialog and no trash.
// A user pressed it expecting to be able to undo, and could not. So the
// properties below are not a feature checklist; each one is a way that promise
// could still be false while the panel looks perfectly correct.
//
//   1. DELETING ASKS NOTHING AND TAKES NOTHING. The chat leaves the rail with no
//      dialog in the way, and it is in the Trash panel. Both halves: no dialog
//      alone is a data-loss bug, and a trash entry alone is a rail that did not
//      update.
//
//   2. A RESTORE BRINGS THE CONVERSATION BACK, NOT THE NAME. Asserted on the
//      MESSAGES — their text, in order — because a chat restored as an empty
//      record with the right label would pass every count.
//
//   3. THE TWO IRREVERSIBLE ACTS ASK, AND EMPTY NAMES THE COUNT. That is where
//      the ceremony went when it came off the reversible act, and a question
//      that does not say how much it is about to destroy is the question the
//      old "Delete all 14 chats?" dialog was, attached to the wrong act.
//
//   4. A TRASHED THING IS GONE FROM EVERYWHERE, not merely from the rail. Out of
//      the finders a person uses to reach a Diamond (the fold picker, the graph)
//      and out of `Files.bounds` — the ONE input to the fence a daimon runs
//      inside. Half-alive is worse than either state: a daimon that can still
//      read a Diamond you deleted is a surprise nobody wants.
//
//   5. THE STATE SYNCS, AND NEITHER SIDE CAN LOSE. This is the hard one and the
//      reason the whole feature is more than a filter. Deleting already
//      propagates through tombstones, so a local-only trash would be WORSE than
//      none: a restore here would be silently undone by the other device, which
//      had buried the same chat and never heard otherwise. Driven through the
//      parcel — collect on one device, apply on another — and asserted in both
//      directions:
//        * trashed here → trashed there;
//        * restored on either → restored on both, INCLUDING when the other
//          device is still carrying the older trashing (the burial);
//        * destroyed for good → gone on both, and a restore pressed afterwards
//          on the device that still had it does NOT bring it back (the
//          resurrection).
//      Two real devices are two browser profiles: the parcel is carried between
//      them by this file, which is exactly what the gateway does with it.
//
//   6. RETENTION IS A FUNCTION OF THE STAMP. An item trashed 31 days ago is
//      destroyed on the next boot, by the device that finds it, with nobody
//      having told it to. That is what makes a device offline past the retention
//      period converge rather than resurrect.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file to the real page (through
// `page.route`, so the browser loads it as it loads any other script) and the
// run is expected to FAIL. A break whose anchor does not appear exactly once
// aborts rather than passing quietly: a check proved against code that was never
// broken is not proved at all.
//
//   node dev/verify_trash.mjs --break nodialogless  # 1: deleting asks again
//   node dev/verify_trash.mjs --break notrashed     # 1: deleting destroys
//   node dev/verify_trash.mjs --break emptyrestore  # 2: restore loses the transcript
//   node dev/verify_trash.mjs --break silentpurge   # 3: "Delete permanently" asks nothing
//   node dev/verify_trash.mjs --break countless     # 3: "Empty trash" drops the count
//   node dev/verify_trash.mjs --break stolenview    # 1: the shared tile ignores the
//                                                   #    view this panel asked for
//   node dev/verify_trash.mjs --break stillfound    # 4: a trashed Diamond is still in the finders
//   node dev/verify_trash.mjs --break fenced        # 4: and still inside a daimon's fence
//   node dev/verify_trash.mjs --break nosync        # 5: the state never leaves the device
//   node dev/verify_trash.mjs --break buryrestore   # 5: a stale trashing buries a restore
//   node dev/verify_trash.mjs --break resurrect     # 5: a restore undoes a permanent delete
//   node dev/verify_trash.mjs --break nobackuptrash # 5: a backup un-deletes on restore
//   node dev/verify_trash.mjs --break nokeep        # 6: retention never fires
//   node dev/verify_trash.mjs                       # and then, clean
//
//   eval "$(bash dev/world.sh 3 --up)"
//   node dev/verify_trash.mjs
//
// Needs dev/serve.mjs only. No gateway: the parcel is collected and applied
// through `DaimondSync.parcel()` / `DaimondSync.apply()`, which sync.js publishes
// precisely so a test measures the fixed point THROUGH the two functions the
// wire uses rather than around them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, errors, signInAs, transcript } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// ── The breaks ───────────────────────────────────────────────────────
// Each is a real edit to a real file, served in place of it.
const BREAKS = {
	// The dialog is back in front of an act that takes nothing away.
	nodialogless: [{
		file: 'js/daimond.js',
		find: '\tfunction deleteChat(chat) {\n\t\tremoveChat(chat);',
		with: '\tasync function deleteChat(chat) {\n'
			+ '\t\tif (!await confirmDialog(\'Delete this chat?\', \'Delete\')) return false;\n'
			+ '\t\tremoveChat(chat);',
	}],
	// Deleting destroys rather than trashing: the app as it was when somebody
	// lost fourteen chats. The "no dialog" check still passes here, which is why
	// the trash half is asked as well.
	notrashed: [{
		file: 'js/daimond.js',
		find: '\t\ttry { DaimondTrash.put(chat.id, \'chat\'); }',
		with: '\t\ttry { throw new Error(\'broken on purpose\'); }',
	}],
	// Trashing "tidies up" the messages on its way past — a tombstone per turn,
	// which is a thing somebody would plausibly write and which the transcript
	// union then honours for ever. The chat comes back with its name, its size,
	// its tile and nothing in it. A count-based check would not see this;
	// asserting the MESSAGES does. This one proves the ON-SCREEN half red; the
	// stored half is proved by `notrashed`, where there is no record to restore
	// and the transcript check fails at the store.
	emptyrestore: [{
		file: 'js/daimond.js',
		find: '\t\tdetachChat(chat);\n\t\ttry { DaimondTrash.put(chat.id, \'chat\'); }',
		with: '\t\tdetachChat(chat);\n'
			+ '\t\tmsgTombstone((chat.messages || []).map(function (m) { return m.mid; }));\n'
			+ '\t\ttry { DaimondTrash.put(chat.id, \'chat\'); }',
	}],
	// "Delete permanently" destroys without asking — the one place in this flow
	// where a question is owed.
	silentpurge: [{
		file: 'js/trash.js',
		find: '\t\tvar ok = await core().confirm(\n'
			+ '\t\t\tt(\'trash.purge_ask\', { name: it.name }),\n'
			+ '\t\t\tt(\'trash.purge_ok\'),\n'
			+ '\t\t\t{ title: t(\'trash.purge\') });',
		with: '\t\tvar ok = true;',
	}],
	// "Empty trash" still asks, but the question no longer says how much it is
	// about to destroy.
	countless: [{
		file: 'js/trash.js',
		find: '\t\t\ttn(\'trash.empty_ask\', items.length, { n: items.length }),',
		with: '\t\t\tt(\'trash.empty\'),',
	}],
	// The trash asks for its own view and is given the user's instead. Whoever
	// last pressed the attachment footers' toggle then decides whether the Trash
	// panel shows dates and sizes at all -- in a panel with no toggle to get
	// back with. It is the one way the shared component can quietly stop serving
	// the caller that has no chrome of its own.
	stolenview: [{
		file: 'js/daimond.js',
		find: '\t\tvar icons = (item.view || attachView()) === \'icons\';',
		with: '\t\tvar icons = true;',
	}],
	// A trashed Diamond is still handed to the fence and still in the finders:
	// the half-alive state, which is the one this feature refuses.
	stillfound: [{
		file: 'js/daimond.js',
		find: '\t\t\t\t\tdiamonds = JSON.parse(json).filter(function (d) {\n'
			+ '\t\t\t\t\t\treturn d && d.id && !trashed(d.id);\n'
			+ '\t\t\t\t\t});',
		with: '\t\t\t\t\tdiamonds = JSON.parse(json);',
	}],
	// The fence still hands a trashed Diamond its own directory, so an agent
	// dispatched into a Diamond the user deleted runs in it. `stillfound` above
	// does not reach this: `bounds` has a guard of its own, which is the point —
	// the two ways in are closed separately and are broken separately.
	fenced: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tif (trashed(did)) return { own_dir: \'\', attached: [], read_only: [], toolkits: [] };',
		with: '',
	}],
	// The state never gets into the parcel, so the trash is local: exactly the
	// design this file's section 5 exists to refuse.
	nosync: [{
		file: 'js/sync.js',
		find: '\t\ttry { if (window.DaimondTrash) state.trash = DaimondTrash.snapshot(); }',
		with: '\t\ttry { if (false) state.trash = DaimondTrash.snapshot(); }',
	}],
	// The merge takes the arriving record wholesale instead of the later of each
	// stamp, so a device still carrying yesterday's trashing buries today's
	// restore. The state still syncs, so `nosync`'s checks pass here.
	buryrestore: [{
		file: 'js/trash.js',
		find: '\t\t\tif (r.at   > mine.at)   { mine.at   = r.at;   moved = true; }\n'
			+ '\t\t\tif (r.back > mine.back) { mine.back = r.back; moved = true; }',
		with: '\t\t\tif (r.at !== mine.at || r.back !== mine.back) { mine.at = r.at; mine.back = r.back; moved = true; }',
	}],
	// A permanent deletion that does not travel. The Diamond is destroyed here
	// and no tombstone goes with it, so the other device — which still holds it
	// in its own trash — restores it and hands it straight back. This is the
	// resurrection, and it is the reason permanent deletion stays a tombstone
	// rather than becoming another state in the trash record.
	resurrect: [{
		file: 'js/daimond.js',
		find: '\t\tdiamondTombstone(id);',
		with: '',
	}],
	// A backup that carries the trashed things and not the state that says they
	// are deleted. Restoring it un-deletes everything the user had deleted.
	nobackuptrash: [{
		file: 'js/daimond.js',
		find: '\t\t\ttrash: (function () {',
		with: '\t\t\ttrash: (function () { if (true) return null;',
	}],
	// Retention never fires: the trash grows for ever, and the date on every
	// tile is a promise nothing keeps.
	nokeep: [{
		file: 'js/trash.js',
		find: '\t\t\t\tif (now - r.at >= RETAIN_MS) expired.push({ id: id, kind: r.k === \'d\' ? \'diamond\' : \'chat\', at: r.at });',
		with: '\t\t\t\tif (false) expired.push({ id: id, kind: r.k === \'d\' ? \'diamond\' : \'chat\', at: r.at });',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// `src` with `spec` applied, or a hard stop. Nothing is served that was not
/// verified to differ from what it was given.
function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// The damaged files, ONE BODY PER FILE.
///
/// Every edit a break names for a file goes into the SAME body, in order, and
/// that one body is what the route serves. A `page.route` per edit spec does not
/// work and does not say so: Playwright hands a request to the LAST route
/// registered for its URL, so a two-edit break shipped only its second edit --
/// and still went red, for half the reason it claims, with nothing to notice it.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

async function breakInto(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
}

// ── The fixture ──────────────────────────────────────────────────────
// Two chats with transcripts whose exact words are the oracle for the restore,
// and two Diamonds so that "gone from the rail" can be told apart from "the
// rail is empty".
const SAID = {
	Ledger: ['what does the ledger owe', 'four pounds and ninepence', 'and to whom'],
	Recipe: ['how long do I proof it', 'ninety minutes, covered'],
};

const seedChats = (page, records) => page.evaluate((rows) => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const db = req.result;
		const t = db.transaction('chats', 'readwrite');
		rows.forEach((r) => t.objectStore('chats').put(r));
		t.oncomplete = () => res(true);
		t.onerror    = () => res(false);
	};
	req.onerror = () => res(false);
}), records);

function chatRecords() {
	const base = Date.parse('2026-08-01T00:00:00Z');
	return Object.keys(SAID).map((name, i) => ({
		id: 'tc' + (i + 1),
		name,
		messages: SAID[name].map((text, j) => ({
			role: j % 2 === 0 ? 'user' : 'assistant',
			content: text,
			mid: `m-${i}-${j}`,
			ts: base + j,
		})),
		model: 'mock/fast', provider: '', diamondId: '', status: 'active',
		promptTokens: 0, completionTokens: 0, updatedAt: base + 1000 * (i + 1),
	}));
}

/// The tile names on the rail, top to bottom.
///
/// `.tile-when` carries a chat's identity — the user's own name where one is
/// set, and the derived relative time where none is. Every chat in this
/// fixture is given a name, so here it is always the name. Read as TEXT: the
/// label stopped being an `<input>` when the rename gesture left the tile, and
/// a button has no `.value`.
const railChats = (page) => page.$$eval('#session-list .session-box .tile-when',
	(els) => els.map((e) => (e.textContent || '').trim()));
/// The Diamond names on the rail, which is a filtered view of the store.
const railDiamonds = (page) => page.evaluate(() =>
	[...document.querySelectorAll('#diamond-list .diamond-box')]
		.map((e) => e.getAttribute('aria-label')));

/// What the STORE holds, unfiltered — read through a wasm app of its own, the
/// way `clearDiamonds` in the harness does. This is how "trashed is a state,
/// not a deletion" is asserted: the bytes are still on disk while the rail
/// says the Diamond is gone.
const storedDiamonds = (page) => page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	try { return JSON.parse(await app.list_diamonds()).map((d) => ({ id: d.id, name: d.name })); }
	catch (e) { return []; }
});

/// What the Trash panel actually draws. These are the ATTACHMENT tile's own
/// class names, not a set this panel invented (ATTACH_CONTRACT.md §9): `shut`
/// for an item that cannot be opened, `.arte-why` for the reason it draws in
/// words, `.arte-note` for the facts under it. Reading them here is half of
/// what says the two callers are one component -- if the trash grew a renderer
/// of its own, this selector would stop finding anything.
const panelTiles = (page) => page.$$eval('#trash-list .arte-row', (els) => els.map((e) => ({
	kind:  (e.querySelector('.arte-kind') || {}).textContent || '',
	label: (e.querySelector('.arte-open') || {}).textContent || '',
	why:   (e.querySelector('.arte-why') || {}).textContent || '',
	note:  (e.querySelector('.arte-note') || {}).textContent || '',
	shut:  e.classList.contains('shut'),
	// A tile that cannot be opened must not be a button either: a label that
	// looks pressable and is not is the empty-folder failure in another coat.
	openable: !!e.querySelector('button.arte-open'),
	acts:  [...e.querySelectorAll('button')].map((b) => b.className.split(' ')[0]),
})));

/// The one visible dialog's message, or null if none is open.
const dialogMsg = (page) => page.evaluate(() => {
	const card = [...document.querySelectorAll('.modal.dlg .dlg-card')]
		.find((c) => c.getClientRects().length);
	return card ? (card.querySelector('.dlg-msg') || {}).textContent || '' : null;
});
const answer = (page, cls) => page.evaluate((c) => {
	const btns = [...document.querySelectorAll('.modal.dlg .' + c)]
		.filter((b) => b.getClientRects().length);
	const b = btns[btns.length - 1];
	if (b) b.click();
	return !!b;
}, cls);

/// The transcript a chat holds now, read from the store rather than the screen:
/// what has to survive a restore is what is on disk.
const storedSaid = (page, name) => page.evaluate((n) => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const all = req.result.transaction('chats', 'readonly').objectStore('chats').getAll();
		all.onsuccess = () => {
			const c = (all.result || []).find((x) => x.name === n);
			res(c ? (c.messages || []).map((m) => m.content) : null);
		};
		all.onerror = () => res(null);
	};
	req.onerror = () => res(null);
}), name);

const newDiamond = async (page, name) => {
	await page.click('#new-diamond-btn', { timeout: 8000 });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(900);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// Ask the panel to redraw, tolerating a break that has taken the module out
/// altogether. A break that CRASHES the harness proves no more than one that
/// does nothing: the run has to reach its own report.
const redraw = (page) => page.evaluate(() => {
	try { window.DaimondTrashPanel.render(); } catch (e) { /* broken on purpose */ }
});

// ── Device A ─────────────────────────────────────────────────────────
const PROFILE_A = scratch('pw', 'trash-a' + (BREAK ? '-' + BREAK : ''));
const PROFILE_B = scratch('pw', 'trash-b' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE_A, { recursive: true, force: true });
fs.rmSync(PROFILE_B, { recursive: true, force: true });

const a = await open({ name: 'trash', profile: PROFILE_A, defaults: false });
await breakInto(a.page);
await a.page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(a, 'trash');
await a.page.waitForTimeout(600);

let b = null;		// the second device, opened only for the sync section

try {
	const A = a.page;
	await seedChats(A, chatRecords());
	await A.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(a, 'trash');
	await A.waitForTimeout(1200);

	await newDiamond(A, 'Kept');
	await newDiamond(A, 'Doomed');

	const seededChats = await railChats(A);
	const seededDiamonds = await A.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .diamond-box')]
			.map((e) => e.getAttribute('aria-label')));
	check('the fixture is on the rail: two chats and two Diamonds',
		seededChats.length === 2 && seededDiamonds.length === 2,
		`${seededChats.join(', ')} | ${seededDiamonds.join(', ')}`);
	if (seededChats.length !== 2 || seededDiamonds.length !== 2) {
		console.log('\nnothing to test against — refusing to report a vacuous pass.');
		await a.close();
		process.exit(1);
	}

	// ── 1. Deleting asks nothing and takes nothing ──────────────────
	await A.evaluate(() => {
		const box = [...document.querySelectorAll('#session-list .session-box')]
			.find((e) => ((e.querySelector('.tile-when') || {}).textContent || '').trim() === 'Ledger');
		const x = box && box.querySelector('.tile-x');
		if (x) x.click();
	});
	await A.waitForTimeout(700);
	const askedOnDelete = await dialogMsg(A);
	check('deleting a chat asks NOTHING', askedOnDelete === null,
		`a dialog opened: ${JSON.stringify(askedOnDelete)}`);
	// A dialog left standing under a break would swallow every click after it.
	if (askedOnDelete !== null) { await answer(A, 'dlg-cancel'); await A.waitForTimeout(300); }

	const railAfterDelete = await railChats(A);
	check('and the chat leaves the rail — by NAME, with the other one still there',
		!railAfterDelete.includes('Ledger') && railAfterDelete.includes('Recipe'),
		railAfterDelete.join(', ') || 'empty');

	await A.evaluate(() => window.DaimondPanels.show('trash'));
	await A.waitForTimeout(700);
	let tiles = await panelTiles(A);
	check('IT IS IN THE TRASH PANEL, named, as a chat',
		tiles.length === 1 && tiles[0].label === 'Ledger' && /chat/i.test(tiles[0].kind),
		JSON.stringify(tiles));
	check('the tile is drawn as something that cannot be opened — and not as a button',
		!!(tiles[0] && tiles[0].shut && tiles[0].openable === false),
		JSON.stringify(tiles[0]));
	check('and it SAYS WHY in words on the tile, not in a title a touch cannot reach',
		!!(tiles[0] && /delet/i.test(tiles[0].why)), JSON.stringify(tiles[0] && tiles[0].why));
	check('and the tile says when it stops existing, and what it weighs',
		!!(tiles[0] && /\d/.test(tiles[0].note) && /B|KB|MB/.test(tiles[0].note)),
		tiles[0] && tiles[0].note);
	const head = await A.evaluate(() => (document.getElementById('trash-note') || {}).textContent || '');
	check('the panel says what the trash is holding, in bytes',
		/\d/.test(head) && /B|KB|MB/.test(head), JSON.stringify(head));
	await shot(a, 'trash-one' + (BREAK ? '-' + BREAK : ''));

	// ── 2. A restore brings the CONVERSATION back ───────────────────
	await A.evaluate(() => {
		const r = document.querySelector('#trash-list .trash-restore');
		if (r) r.click();
	});
	await A.waitForTimeout(1500);
	const railAfterRestore = await railChats(A);
	check('restoring puts the chat back on the rail', railAfterRestore.includes('Ledger'),
		railAfterRestore.join(', ') || 'empty');
	const restored = await storedSaid(A, 'Ledger');
	check('AND ITS TRANSCRIPT, WORD FOR WORD — not a chat with the right name',
		JSON.stringify(restored) === JSON.stringify(SAID.Ledger),
		JSON.stringify(restored));
	// The screen, not only the store: a restore that never reached the thread is
	// a restore the user cannot see.
	await A.evaluate(() => {
		const box = [...document.querySelectorAll('#session-list .session-box')]
			.find((e) => ((e.querySelector('.tile-when') || {}).textContent || '').trim() === 'Ledger');
		if (box) box.click();
	});
	await A.waitForTimeout(1000);
	const thread = await transcript(a);
	check('and the restored conversation is on screen, with what was said in it',
		SAID.Ledger.every((line) => thread.includes(line)),
		JSON.stringify(thread.slice(0, 200)));
	check('the trash is empty again after the restore',
		(await panelTiles(A)).length === 0 || (await panelTiles(A)).every((x) => x.label !== 'Ledger'),
		JSON.stringify(await panelTiles(A)));

	// ── 3. "Delete permanently" asks, and names what it destroys ────
	await A.evaluate(() => {
		const box = [...document.querySelectorAll('#session-list .session-box')]
			.find((e) => ((e.querySelector('.tile-when') || {}).textContent || '').trim() === 'Ledger');
		const x = box && box.querySelector('.tile-x');
		if (x) x.click();
	});
	await A.waitForTimeout(900);
	await redraw(A);
	await A.waitForTimeout(600);
	await A.evaluate(() => {
		const p = document.querySelector('#trash-list .trash-purge');
		if (p) p.click();
	});
	await A.waitForTimeout(800);
	const purgeAsk = await dialogMsg(A);
	check('"Delete permanently" ASKS FIRST, and names what it is about to destroy',
		!!(purgeAsk && purgeAsk.includes('Ledger')), JSON.stringify(purgeAsk));
	if (purgeAsk !== null) { await answer(A, 'dlg-cancel'); await A.waitForTimeout(500); }
	check('and answering no leaves it in the trash',
		(await panelTiles(A)).some((x) => x.label === 'Ledger'),
		JSON.stringify(await panelTiles(A)));

	// ── A Diamond is deleted the same way, from its tile's dialog ───
	await A.evaluate(() => {
		const box = [...document.querySelectorAll('#diamond-list .diamond-box')]
			.find((e) => (e.getAttribute('aria-label') || '') === 'Doomed');
		const cog = box && box.querySelector('.tile-cog');
		if (cog) cog.click();
	});
	await A.waitForTimeout(800);
	await A.evaluate(() => {
		const del = [...document.querySelectorAll('.tile-dlg-delete')]
			.filter((btn) => btn.getClientRects().length).pop();
		if (del) del.click();
	});
	await A.waitForTimeout(1600);
	const askedOnDiamond = await dialogMsg(A);
	check('deleting a Diamond asks NOTHING either', askedOnDiamond === null,
		`a dialog opened: ${JSON.stringify(askedOnDiamond)}`);
	if (askedOnDiamond !== null) { await answer(A, 'dlg-ok'); await A.waitForTimeout(1200); }
	const railDsNow = await railDiamonds(A);
	check('and it leaves the rail, with the Diamond that was not deleted still on it',
		!railDsNow.includes('Doomed') && railDsNow.includes('Kept'),
		railDsNow.join(', ') || 'empty');
	// TRASHED IS A STATE, NOT A DELETION. The store still has every byte, which
	// is the only reason a restore on this or any other device can work at all.
	const onDisk = await storedDiamonds(A);
	check('THE DIAMOND IS STILL IN THE STORE — nothing was destroyed by deleting it',
		onDisk.some((d) => d.name === 'Doomed') && onDisk.some((d) => d.name === 'Kept'),
		JSON.stringify(onDisk.map((d) => d.name)));

	await redraw(A);
	await A.waitForTimeout(700);
	let tiles2 = await panelTiles(A);
	check('the panel holds both, NEWEST FIRST — the Diamond above the chat',
		tiles2.length === 2 && tiles2[0].label === 'Doomed' && tiles2[1].label === 'Ledger',
		JSON.stringify(tiles2.map((x) => x.label)));
	check('and the Diamond is badged as a Diamond, not as a chat',
		!!(tiles2[0] && /diamond/i.test(tiles2[0].kind)), JSON.stringify(tiles2[0]));
	await shot(a, 'trash-two' + (BREAK ? '-' + BREAK : ''));

	// ── 4. Gone from the finders, and gone from the fence ───────────
	const doomedId = (onDisk.find((d) => d.name === 'Doomed') || {}).id || '';
	const keptId   = (onDisk.find((d) => d.name === 'Kept') || {}).id || '';

	const fold = await A.evaluate(() => {
		const box = [...document.querySelectorAll('#session-list .session-box')][0];
		const f = box && box.querySelector('.tile-fold');
		if (f) f.click();
		return [...document.querySelectorAll('.fold-menu-item')].map((e) => e.textContent.trim());
	});
	check('a trashed Diamond is not offered as somewhere to fold a chat, while a live one is',
		!fold.includes('Doomed') && fold.includes('Kept'), JSON.stringify(fold));
	await A.evaluate(() => { const m = document.querySelector('.fold-menu'); if (m) m.remove(); });

	const deadBounds = await A.evaluate((id) => window.DaimondDiamond.bounds(id), doomedId)
		.catch(() => null);
	const liveBounds = await A.evaluate((id) => window.DaimondDiamond.bounds(id), keptId)
		.catch(() => null);
	check('AND IT IS OUT OF THE FENCE: a trashed Diamond names no directory to confine an agent to',
		!!(deadBounds && deadBounds.own_dir === ''), JSON.stringify(deadBounds));
	// The other half, so the check above cannot pass because `bounds` is broken
	// for everything.
	check('while a Diamond that was NOT deleted still has its own directory',
		!!(liveBounds && liveBounds.own_dir === 'diamonds/' + keptId),
		JSON.stringify(liveBounds));

	// ── 3b. Empty trash names the count ─────────────────────────────
	const n = (await panelTiles(A)).length;
	await A.evaluate(() => { const e = document.getElementById('trash-empty'); if (e) e.click(); });
	await A.waitForTimeout(900);
	const emptyAsk = await dialogMsg(A);
	check(`"Empty trash" ASKS, and the question NAMES THE COUNT (${n})`,
		!!(emptyAsk && new RegExp('\\b' + n + '\\b').test(emptyAsk)),
		JSON.stringify(emptyAsk));
	await shot(a, 'trash-empty-ask' + (BREAK ? '-' + BREAK : ''));
	if (emptyAsk !== null) { await answer(A, 'dlg-cancel'); await A.waitForTimeout(600); }
	const afterEmptyNo = (await panelTiles(A)).length;
	check('and answering no leaves the trash exactly as it was',
		afterEmptyNo === n, `${afterEmptyNo} of ${n}`);

	// ── 5. The state syncs, and neither side can lose ───────────────
	// The parcel is collected here and applied on a second, independent browser
	// profile — the same two calls sync.js makes at the wire.
	b = await open({ name: 'trash', profile: PROFILE_B, defaults: false });
	await breakInto(b.page);
	await b.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(b, 'trash');
	await b.page.waitForTimeout(1000);
	const B = b.page;

	const carry = async (from, to) => {
		const parcel = await from.evaluate(() => window.DaimondSync.parcel().then(JSON.stringify));
		await to.evaluate((p) => window.DaimondSync.apply(JSON.parse(p)), parcel);
		await to.waitForTimeout(1500);
		return JSON.parse(parcel);
	};

	const parcelA = await carry(A, B);
	check('the parcel carries the trash at all',
		!!(parcelA.trash && parcelA.trash.items
			&& Object.keys(parcelA.trash.items).length >= 2),
		JSON.stringify(parcelA.trash || null).slice(0, 200));

	const bTrash = await B.evaluate(async () =>
		(await window.DaimondCore.trashList()).map((x) => x.name).sort());
	check('THE SECOND DEVICE SEES BOTH IN ITS OWN TRASH, by name',
		JSON.stringify(bTrash) === JSON.stringify(['Doomed', 'Ledger']),
		JSON.stringify(bTrash));
	const bRail = await railChats(B);
	const bDiamonds = await B.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .diamond-box')]
			.map((e) => e.getAttribute('aria-label')));
	check('and they are NOT on its rail, while what was not deleted is',
		!bRail.includes('Ledger') && bRail.includes('Recipe')
			&& !bDiamonds.includes('Doomed') && bDiamonds.includes('Kept'),
		`${bRail.join(', ')} | ${bDiamonds.join(', ')}`);
	await shot(b, 'trash-deviceb' + (BREAK ? '-' + BREAK : ''));

	// The parcel B would send RIGHT NOW, kept aside. It carries the trashing and
	// nothing else, and it is what the burial below is made of: a parcel already
	// in flight when somebody presses Restore on the other device.
	const staleFromB = await B.evaluate(() => window.DaimondSync.parcel().then(JSON.stringify));

	// A RESTORE ON ONE IS A RESTORE ON BOTH.
	await B.evaluate(async () => {
		const list = await window.DaimondCore.trashList();
		const led = list.find((x) => x.name === 'Ledger');
		if (led) await window.DaimondCore.trashRestore(led.id);
	});
	await B.waitForTimeout(900);
	await carry(B, A);
	const aTrashAfter = await A.evaluate(async () =>
		(await window.DaimondCore.trashList()).map((x) => x.name).sort());
	const aRailAfter = await railChats(A);
	check('A RESTORE ON THE OTHER DEVICE IS A RESTORE HERE — the chat is back on this rail',
		aRailAfter.includes('Ledger'), aRailAfter.join(', ') || 'empty');
	check('and it is no longer in this device\'s trash, while the Diamond still is',
		JSON.stringify(aTrashAfter) === JSON.stringify(['Doomed']),
		JSON.stringify(aTrashAfter));
	await carry(A, B);
	const bRailBack = await railChats(B);
	check('and pushing this device\'s state back keeps it restored there too',
		bRailBack.includes('Ledger'), bRailBack.join(', ') || 'empty');

	// THE BURIAL, asked directly. `staleFromB` was collected before the restore
	// and still says "trashed"; a merge that took an arriving record wholesale —
	// or that let a trashing outrank a later restore — would put the chat
	// straight back in the bin, and the user would watch their undo undone by a
	// device nobody had touched. Taking the LATER of each stamp is what refuses
	// it, and this is the check that says so.
	await A.evaluate((p) => window.DaimondSync.apply(JSON.parse(p)), staleFromB);
	await A.waitForTimeout(1800);
	const aRailStale = await railChats(A);
	const aTrashStale = await A.evaluate(async () =>
		(await window.DaimondCore.trashList()).map((x) => x.name));
	check('A STALE PARCEL STILL CARRYING THE OLD TRASHING CANNOT BURY THE RESTORE',
		aRailStale.includes('Ledger') && !aTrashStale.includes('Ledger'),
		`rail: ${aRailStale.join(', ')} | trash: ${JSON.stringify(aTrashStale)}`);

	// A DELETION CANNOT BE RESURRECTED. Device A destroys the Diamond for good;
	// device B, which still has it in its trash, presses Restore — and it must
	// stay gone.
	await A.evaluate(async () => {
		const list = await window.DaimondCore.trashList();
		const doomed = list.find((x) => x.name === 'Doomed');
		if (doomed) await window.DaimondCore.trashPurge(doomed.id);
	});
	await A.waitForTimeout(1200);
	const aGone = await A.evaluate(async () =>
		(await window.DaimondCore.trashList()).map((x) => x.name));
	check('destroying a Diamond for good empties this device\'s trash',
		aGone.length === 0, JSON.stringify(aGone));

	const bRestoredDead = await B.evaluate(async () => {
		const list = await window.DaimondCore.trashList();
		const doomed = list.find((x) => x.name === 'Doomed');
		if (doomed) await window.DaimondCore.trashRestore(doomed.id);
		return !!doomed;
	});
	await B.waitForTimeout(900);
	await carry(A, B);			// the tombstone arrives
	const bDiamondsEnd = await B.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .diamond-box')]
			.map((e) => e.getAttribute('aria-label')));
	check('A PERMANENT DELETION IS NOT UNDONE BY A RESTORE ON THE OTHER DEVICE',
		bRestoredDead && !bDiamondsEnd.includes('Doomed'),
		`${bDiamondsEnd.join(', ')} | restore was pressed: ${bRestoredDead}`);
	// And the parcel it would now send agrees, rather than this device merely
	// drawing a rail that disagrees with what it holds.
	await carry(B, A);
	const aDiamondsEnd = await A.evaluate(() =>
		[...document.querySelectorAll('#diamond-list .diamond-box')]
			.map((e) => e.getAttribute('aria-label')));
	check('and the device that pressed Restore does not push it back to the one that destroyed it',
		!aDiamondsEnd.includes('Doomed'), aDiamondsEnd.join(', ') || 'empty');

	// The parcel is a fixed point: two collects with nothing between them are
	// byte-identical, and applying one does not change what would be sent next.
	// A section that failed this would push the two devices at each other for
	// ever, which the pause tree has already taught this app once.
	const fixed = await A.evaluate(async () => {
		const x = JSON.stringify((await window.DaimondSync.parcel()).trash);
		const y = JSON.stringify((await window.DaimondSync.parcel()).trash);
		const whole = await window.DaimondSync.parcel();
		await window.DaimondSync.apply(whole);
		const z = JSON.stringify((await window.DaimondSync.parcel()).trash);
		return { x, y, z };
	});
	check('the trash section is the same bytes on two collects', fixed.x === fixed.y,
		`${fixed.x}\n vs \n${fixed.y}`);
	check('and applying the parcel does not change what would be sent next',
		fixed.x === fixed.z, `${fixed.x}\n vs \n${fixed.z}`);

	// ── 6. Retention is a function of the stamp ─────────────────────
	// A chat trashed thirty-one days ago, written straight into the record: the
	// point is that NOTHING TELLS THIS DEVICE to destroy it. It works the date
	// out from a stamp it already holds, which is what lets a device that was
	// switched off past the retention period converge instead of resurrecting.
	await A.evaluate(() => {
		const box = [...document.querySelectorAll('#session-list .session-box')]
			.find((e) => ((e.querySelector('.tile-when') || {}).textContent || '').trim() === 'Recipe');
		const x = box && box.querySelector('.tile-x');
		if (x) x.click();
	});
	await A.waitForTimeout(900);
	// ── A BACKUP CARRIES THE STATE TOO ──────────────────────────────
	// A backup already carries every trashed chat and Diamond, because trashing
	// destroys nothing. Without the STATE beside them, restoring one would
	// quietly un-delete everything the user had deleted — the same failure a
	// local-only trash has, arriving by a different road.
	// Any dialog a break has left standing goes first: the admin menu is
	// unreachable underneath one, and the export below would then time out and
	// take the whole run with it. A break that CRASHES the harness proves no
	// more than one that does nothing.
	await A.evaluate(() => {
		document.querySelectorAll('.modal').forEach((m) => m.remove());
		document.body.classList.remove('modal-open');
	});
	await A.waitForTimeout(400);
	let backup = null, why = '';
	try {
		const dl = A.waitForEvent('download', { timeout: 20000 });
		await A.click('#user-row');
		await A.waitForTimeout(500);
		await A.click('button.admin-item:has-text("Export a backup")');
		const file = scratch('trash-backup' + (BREAK ? '-' + BREAK : '') + '.json');
		await (await dl).saveAs(file);
		backup = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) { why = String((e && e.message) || e).split('\n')[0]; }
	const recipeId = await A.evaluate(async () => {
		const list = await window.DaimondCore.trashList();
		return (list.find((x) => x.name === 'Recipe') || {}).id || '';
	});
	const inBackup = backup && backup.trash && backup.trash.items && backup.trash.items[recipeId];
	check('a backup carries WHAT WAS IN THE TRASH, not only the things themselves',
		!!(inBackup && inBackup.at > inBackup.back),
		backup ? JSON.stringify(backup.trash || null).slice(0, 200) : `no backup: ${why}`);
	check('and it carries the trashed chat whole, so the restore has something to restore',
		!!backup && (backup.chats || []).some((c) => c.id === recipeId && (c.messages || []).length),
		backup ? `${(backup.chats || []).length} chat(s) in the backup` : `no backup: ${why}`);
	await A.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => m.remove()); });
	await A.keyboard.press('Escape');
	await A.waitForTimeout(500);

	// Aged BY NAME, not by taking whichever record happens to be first: the map
	// still carries restored records for things this run destroyed, and winding
	// one of those back would age an entry the sweep is right to ignore — which
	// is a test that passes while proving nothing.
	const aged = await A.evaluate(async () => {
		const list = await window.DaimondCore.trashList();
		const it = list.find((x) => x.name === 'Recipe');
		if (!it) return null;
		const raw = JSON.parse(localStorage.getItem('daimond-trash') || '{}');
		if (!raw.items || !raw.items[it.id]) return null;
		raw.items[it.id].at = Date.now() - 31 * 24 * 3600 * 1000;
		localStorage.setItem('daimond-trash', JSON.stringify(raw));
		return it.id;
	});
	check('the chat to age is in the trash, and its stamp is now 31 days old', !!aged, String(aged));
	// A reload, so the sweep runs on the boot path a returning device takes.
	await A.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(a, 'trash');
	await A.waitForTimeout(2500);
	const afterSweep = await A.evaluate(async () =>
		(await window.DaimondCore.trashList()).map((x) => x.name));
	const stillStored = await storedSaid(A, 'Recipe');
	check('AN ITEM PAST ITS THIRTY DAYS IS DESTROYED ON THE NEXT BOOT, unprompted',
		!afterSweep.includes('Recipe') && stillStored === null,
		`trash: ${JSON.stringify(afterSweep)}, store: ${JSON.stringify(stillStored)}`);
	const railEnd = await railChats(A);
	check('and it does not come back to the rail either',
		!railEnd.includes('Recipe'), railEnd.join(', ') || 'empty');

	await A.evaluate(() => window.DaimondPanels.show('trash'));
	await A.waitForTimeout(600);
	await shot(a, 'trash-swept' + (BREAK ? '-' + BREAK : ''));

	const errs = errors(a).filter((e) => !/favicon/i.test(e)
		&& !/Failed to load resource/.test(e) && !/502 \(Bad Gateway\)/.test(e));
	check('nothing was done by way of an unhandled error', errs.length === 0,
		errs.slice(0, 3).join(' | ') || 'none');
} finally {
	if (b) await b.close();
	await a.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad.length} check(s) failed`
		+ (bad.length ? ' — ' + bad.join('; ') : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad.length ? 0 : 1);		// a break MUST fail something
}
console.log(bad.length === 0 ? '\nall checks passed' : `\n${bad.length} check(s) FAILED`);
process.exit(bad.length === 0 ? 0 : 1);
