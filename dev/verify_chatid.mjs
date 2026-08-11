// verify_chatid.mjs — a new chat is not born in the trash.
//
// WHY THIS FILE EXISTS. Build 664d9f47bd1d could not start an ordinary chat on any
// device where a chat had ever been deleted. Press "New chat", get a sensible name,
// press Start, and about a second later the tile went. The two features were fine
// on their own and lethal together:
//
//   * chat ids were `'c' + seq`, and `seq` was seeded at boot from the chats
//     `loadChats` returned — a list that deliberately LEAVES OUT everything in the
//     trash and everything tombstoned;
//   * the trash (seq 111) keys by id, and `trashed(id)` is asked wherever a list is
//     BUILT — the rail, the finders, the parcel, the backup.
//
// So a device whose last chat had been deleted counted from wherever the visible
// list stopped and minted an id the trash still owned. The tile drew, and the next
// reconciliation — a sync round, a trash redraw, another tab — filtered it straight
// out again. Worse, and invisible: the store is keyed by id, so the new chat had
// already OVERWRITTEN the deleted chat's record. The undo the trash exists to offer
// was destroyed by the act that broke the new chat.
//
// The properties below are therefore not "ids are unique". Each is a way the app
// could still be wrong while `newChat` looks perfectly correct:
//
//   1. A CHAT MADE AFTER A RELOAD IS NOT CLAIMED BY THE TRASH. Asked of the trash
//      record itself, not of the screen: a tile that has not been filtered YET
//      looks exactly like a tile that never will be.
//
//   2. AND IT DID NOT OVERWRITE WHAT WAS IN THE TRASH. Asserted on the STORED
//      record — its id and its name — because a rail that looks right is served
//      by a store that has quietly lost a conversation.
//
//   3. AND IT SURVIVES A SYNC ROUND AND A RE-RENDER. This is the user's symptom,
//      driven through `DaimondSync.parcel()`/`apply()` — the two functions the wire
//      uses — because that is what took the tile away a second after Start.
//
//   4. THE SAME AFTER A PERMANENT DELETE. Destroying for good leaves a TOMBSTONE,
//      which is a second id space that outlives the record, and `storedChats`
//      omits it. A counter reseeded from the stored list rather than the visible
//      one — the obvious near-fix — passes 1-3 and fails here.
//
// EACH CHECK IS PROVED AGAINST BROKEN CODE FIRST. `--break <name>` serves a
// deliberately damaged copy of a source file to the real page (through
// `page.route`, so the browser loads it as it loads any other script) and the run
// is expected to FAIL. A break whose anchor does not appear exactly once aborts
// rather than passing quietly: a check proved against code that was never broken
// is not proved at all.
//
//   node dev/verify_chatid.mjs --break counter  # the shipped bug, restored verbatim
//   node dev/verify_chatid.mjs --break seeded   # the near-fix: seed from the STORED list
//   node dev/verify_chatid.mjs                  # and then, clean
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_chatid.mjs
//
// Needs dev/serve.mjs and the mock only. No gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, shot, scratch, signInAs } from './harness.mjs';

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
const NEW_ID = '\tfunction newChatId() {\n\t\treturn \'c\' + newMid();\n\t}';
const NO_SEED = '\t\t// NOTHING IS SEEDED FROM THIS LIST. A counter used to be, and `loadChats`\n'
	+ '\t\t// omits every chat in the trash — which is how a new chat came back with an\n'
	+ '\t\t// id the trash still owned. See `newChatId`.';

const BREAKS = {
	// The bug as it shipped in 664d9f47bd1d, restored word for word: a counter
	// seeded from the chats that are ON THE RAIL.
	counter: [
		{ file: 'js/daimond.js', find: NEW_ID,
			with: '\tvar seq = 1;\n\tfunction newChatId() {\n\t\treturn \'c\' + (seq++);\n\t}' },
		{ file: 'js/daimond.js', find: NO_SEED,
			with: '\t\tchats.forEach(function (c) { var n = parseInt((c.id || \'\').replace(/^c/, \'\'), 10);'
				+ ' if (n >= seq) seq = n + 1; });' },
	],
	// The near-fix, and the reason a counter was rejected rather than reseeded:
	// `storedChats` DOES include the trashed, so 1-3 go green — and it does not
	// include the tombstoned, so a permanent delete hands the id straight back.
	seeded: [
		{ file: 'js/daimond.js', find: NEW_ID,
			with: '\tvar seq = 1;\n'
				+ '\tfunction newChatId() {\n'
				+ '\t\ttry {\n'
				+ '\t\t\tstoredChats().forEach(function (c) {\n'
				+ '\t\t\t\tvar n = parseInt((c.id || \'\').replace(/^c/, \'\'), 10);\n'
				+ '\t\t\t\tif (n >= seq) seq = n + 1;\n'
				+ '\t\t\t});\n'
				+ '\t\t} catch (e) { /* no store yet */ }\n'
				+ '\t\treturn \'c\' + (seq++);\n'
				+ '\t}' },
	],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

/// The damaged source, or a hard stop. Nothing is served that was not verified to
/// differ from the file on disk.
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

async function breakInto(page) {
	if (!BREAK) return;
	const bodies = {};
	for (const spec of BREAKS[BREAK]) {
		bodies[spec.file] = bodies[spec.file] || fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		// Each spec is checked against the file ON DISK, so two edits to one file
		// cannot mask each other's anchor.
		damaged(spec);
		bodies[spec.file] = bodies[spec.file].replace(spec.find, spec.with);
	}
	for (const file of Object.keys(bodies)) {
		await page.route('**/' + file, (r) => r.fulfill({
			status: 200, contentType: 'application/javascript', body: bodies[file],
		}));
	}
}

// ── Reading the truth, not the screen ────────────────────────────────

/// The chat tile names on the rail, top to bottom.
const railChats = (page) => page.$$eval('#session-list .session-box .tile-label',
	(els) => els.map((e) => e.value));

/// Every chat the STORE holds, unfiltered — id and name. This is where the
/// overwrite shows: the rail cannot report a record that was replaced under it.
const storedChats = (page) => page.evaluate(() => new Promise((res) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onsuccess = () => {
		const all = req.result.transaction('chats', 'readonly').objectStore('chats').getAll();
		all.onsuccess = () => res((all.result || []).map((c) => ({ id: c.id, name: c.name })));
		all.onerror   = () => res([]);
	};
	req.onerror = () => res([]);
}));

/// Every id that can still claim a chat: the trash record and the tombstones.
///
/// Read by key SUFFIX rather than by exact name, because a second account
/// namespaces its storage and a verifier that hardcoded the primary account's
/// key would report an empty trash on a run that had one.
const claimedIds = (page) => page.evaluate(() => {
	const grab = (suffix) => {
		for (let i = 0; i < localStorage.length; i++) {
			const k = localStorage.key(i);
			if (k === suffix || k.endsWith(':' + suffix) || k.endsWith(suffix)) {
				try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
			}
		}
		return null;
	};
	const trash = grab('daimond-trash');
	const tombs = grab('daimond-chats-deleted');
	return {
		trashed: Object.keys((trash && trash.items) || {}),
		tombed:  Object.keys(tombs || {}),
	};
});

/// One sync round against this device's own parcel: collect what it would send
/// and apply it back. `applyChats` runs, which reconciles the rail against the
/// stores — the exact path that took the user's tile away a second after Start.
const syncRound = async (page) => {
	await page.evaluate(async () => {
		const p = await window.DaimondSync.parcel();
		await window.DaimondSync.apply(p);
	});
	await page.waitForTimeout(2000);
};

/// A genuine reload: the counter's whole failure was that it restarted, so a test
/// that never restarts the page cannot see it. Sign-in does not survive the
/// reload, so it is done again — the same thing a returning user does.
const restart = async (s) => {
	await s.page.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'chatid');
	await s.page.waitForTimeout(1800);
};

/// Press "New chat" and then Start, unconditionally.
///
/// NOT the harness's `newChat`, which returns early when a composer is already on
/// screen. After the second reload a chat is restored AND selected, so the
/// composer is up and the harness would quietly make no chat at all — and a
/// section that creates nothing passes every question asked about what it created.
const makeChat = async (page) => {
	const close = page.locator('#admin-close');
	if (await close.isVisible().catch(() => false)) {
		await close.click({ force: true });
		await page.waitForTimeout(200);
	}
	await page.click('#new-session-btn', { force: true });
	await page.waitForTimeout(600);
	const start = page.locator('.tile-start').first();
	if (await start.count()) await start.click({ force: true });
	await page.waitForTimeout(700);
};

/// Delete the named chat the way a user does: the tile's own ✕, no dialog.
const deleteChat = async (page, name) => {
	await page.evaluate((n) => {
		const box = [...document.querySelectorAll('#session-list .session-box')]
			.find((e) => (e.querySelector('.tile-label') || {}).value === n);
		const x = box && box.querySelector('.tile-x');
		if (x) x.click();
	}, name);
	await page.waitForTimeout(900);
};

// ── The run ──────────────────────────────────────────────────────────
const PROFILE = scratch('pw', 'chatid' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'chatid', profile: PROFILE, defaults: false, route: breakInto });
const P = s.page;

try {
	// ── The fixture: one chat, deleted ──────────────────────────────
	await makeChat(P);
	const first = await storedChats(P);
	check('a chat was made and stored', first.length === 1, JSON.stringify(first));
	const doomedId = first.length === 1 ? first[0].id : null;
	const doomedName = first.length === 1 ? first[0].name : null;

	await deleteChat(P, doomedName);
	const afterDelete = await claimedIds(P);
	check('and deleting it put its id in the trash',
		afterDelete.trashed.includes(doomedId),
		`${JSON.stringify(afterDelete.trashed)} vs ${doomedId}`);
	if (!doomedId || !afterDelete.trashed.includes(doomedId)) {
		console.log('\nthe fixture never reached the state under test — refusing to report a vacuous pass.');
		await s.close();
		process.exit(1);
	}

	// ── 1-3. A chat made after a reload ─────────────────────────────
	await restart(s);
	check('the deleted chat is off the rail after the reload',
		(await railChats(P)).length === 0, (await railChats(P)).join(', '));

	await makeChat(P);
	const railNow = await railChats(P);
	const madeName = railNow[0] || null;
	const stored2 = await storedChats(P);
	const madeRec = stored2.find((c) => c.name === madeName);
	const claimed = await claimedIds(P);

	check('a new chat drew a tile at all', !!madeName, railNow.join(', ') || 'empty');
	check('1. THE NEW CHAT\'S ID IS NOT ONE THE TRASH STILL CLAIMS',
		!!madeRec && !claimed.trashed.includes(madeRec.id) && !claimed.tombed.includes(madeRec.id),
		`${madeRec ? madeRec.id : '(no record)'} vs trashed ${JSON.stringify(claimed.trashed)}`);
	check('2. AND THE TRASHED CHAT\'S RECORD IS STILL IN THE STORE, UNDER ITS OWN NAME',
		stored2.some((c) => c.id === doomedId && c.name === doomedName),
		JSON.stringify(stored2));

	await syncRound(P);
	const railAfterSync = await railChats(P);
	check('3. AND THE CHAT IS STILL THERE AFTER A SYNC ROUND AND A RE-RENDER',
		railAfterSync.includes(madeName), railAfterSync.join(', ') || 'empty');
	await shot(s, 'chatid-after-sync' + (BREAK ? '-' + BREAK : ''));

	// ── 4. The same after a permanent delete ────────────────────────
	// Destroying for good leaves a TOMBSTONE, which is a second id space, and one
	// that `storedChats` does not show either — so it is where a counter reseeded
	// from the STORED list (the obvious near-fix, and the `seeded` break) still
	// collides.
	//
	// THE CHAT DESTROYED HERE IS THE NEWEST ONE, deliberately. Destroying an old
	// one leaves a newer record behind for a counter to count past, so the near-fix
	// would survive it and this section would prove nothing about it. The id that
	// has to be tombstoned is the HIGHEST, because that is the one a counter
	// reseeded from what is left would mint next.
	await makeChat(P);
	await P.waitForTimeout(400);
	const storedV = await storedChats(P);
	const victim = storedV.find((c) => c.name !== madeName && c.name !== doomedName) || null;
	const victimName = victim ? victim.name : null;
	check('a second chat was made, and it is the newest record',
		!!victim, JSON.stringify(storedV));

	if (victim) {
		await deleteChat(P, victimName);
		const purged = await P.evaluate((id) => window.DaimondCore.trashPurge(id), victim.id);
		await P.waitForTimeout(900);
		const afterPurge = await claimedIds(P);
		check('destroying it for good leaves a TOMBSTONE for its id',
			purged !== false && afterPurge.tombed.includes(victim.id),
			JSON.stringify(afterPurge.tombed));
	}

	await restart(s);
	await makeChat(P);
	const rail3 = await railChats(P);
	const thirdName = rail3.find((n) => n !== madeName && n !== victimName) || null;
	const stored3 = await storedChats(P);
	const thirdRec = stored3.find((c) => c.name === thirdName);
	const claimed3 = await claimedIds(P);
	check('4. A CHAT MADE AFTER A PERMANENT DELETE IS NOT TOMBSTONED EITHER',
		!!thirdRec && !claimed3.tombed.includes(thirdRec.id) && !claimed3.trashed.includes(thirdRec.id),
		`${thirdRec ? thirdRec.id : '(no record)'} vs tombed ${JSON.stringify(claimed3.tombed)}`);

	await syncRound(P);
	const rail4 = await railChats(P);
	check('   and it too survives a sync round',
		!!thirdName && rail4.includes(thirdName), rail4.join(', ') || 'empty');

	// The ids the app minted, for the record.
	console.log('\n  ids minted: ' + JSON.stringify((await storedChats(P)).map((c) => c.id)));
} finally {
	await s.close();
}

console.log(`\n${ok.length} ok, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `break '${BREAK}' was CAUGHT, which is what this run had to prove.`
		: `break '${BREAK}' PASSED — the checks do not discriminate and prove nothing.`);
	process.exit(bad.length ? 0 : 1);
}
process.exit(bad.length ? 1 : 0);
