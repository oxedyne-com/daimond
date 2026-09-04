// verify_dataloss.mjs — the four ways a sync round used to destroy a user's
// work, each asserted where it was destroyed.
//
//  1. WORKSPACE FILES DELETED BY ABSENCE. Every other store here deletes on a
//     tombstone; files deleted on a path missing from the parcel. Four innocent
//     things produce a parcel with no files in it -- a real folder open, tools
//     not up, a directory that would not list, a file left out for budget -- and
//     each of them read as "the user deleted everything", account-wide. A parcel
//     now carries `filesComplete`, and NOTHING is deleted without it.
//  2. THE CLOUD CHUNKS SWEPT BY THE SAME PUSH. A device that refused to merge
//     the other device's chunk index (same condition) still committed its own as
//     the account's live set, and the gateway swept every chunk it did not name.
//     The commit is now gated on the merge.
//  3. A BACKUP WITH NO IDENTITY IN IT. The Forget flow told the user their
//     credits were recoverable from a backup; the backup carried no key, so the
//     balance and the Pro licence went with the identity. The export carries the
//     wrapped identity now, and the string says what it can and cannot do.
//  4. ONE CONVERSATION CLEARED, EVERY OTHER ONE SHORTENED. Clearing a daimon
//     tombstones the messages it discards, by id, in a map that is global and
//     travels in the parcel. A message stored before message-ids existed is
//     given one on the way in -- and that id was minted from its POSITION
//     ALONE, so message one of every old conversation carried the same id.
//     Clearing one therefore deleted the opening messages of all of them, on
//     every device, with nothing said. Shipped 2026-08-14.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway: the sync engine is driven against a
// stubbed mailbox, which is what makes the commit gate observable at all.
//
// CHECK 4 CLEARS A DAIMON AND PROVES, AGAINST BROKEN CODE, THAT DOING SO LEAVES
// EVERY OTHER CONVERSATION WHOLE. "Fresh daimon" was removed (owner decision
// 2026-09-04); its clear moved onto the daimon Fold button, which absorbs the
// conversation into the crystal and THEN clears it — so check 4 reaches the same
// guarded clear (`clearDaimonSession`) through Fold rather than the old control.
//
//   node dev/verify_dataloss.mjs --break shipped     # 4b+4d fail: the defect as it shipped
//   node dev/verify_dataloss.mjs --break stamp-only  # 4c+4e fail: the clear stops sticking
//   node dev/verify_dataloss.mjs                     # and then, clean
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, errors, scratch, signInAs, storedChats } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');
const SRC  = 'js/daimond.js';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// ── The breaks ──────────────────────────────────────────────────────────
//
// A break names every site it damages, and every one of them has to land: an
// anchor that has drifted is a break that quietly stopped applying, and a green
// run under it proves nothing.
const STAMP = "\t\tvar at = scope || 'nochat';\t// Absent only for a record with no id, which is never stored\n"
	+ "\t\t(msgs || []).forEach(function (m, i) {\n"
	+ "\t\t\tif (!m.mid)                  m.mid = 'legacy-' + at + '-' + ('0000' + i).slice(-4);\n"
	+ "\t\t\telse if (OLD_LEGACY.test(m.mid)) m.mid = 'legacy-' + at + '-' + m.mid.slice(7);";
// The stamp as it shipped: the position, and nothing that says WHICH conversation.
const UNSCOPED = "\t\t(msgs || []).forEach(function (m, i) {\n"
	+ "\t\t\tif (!m.mid) m.mid = 'legacy-' + ('0000' + i).slice(-4);";
const DROP_OLD = "\t\t\tif (OLD_LEGACY.test(id)) return;\n";

const BREAKS = {
	// The defect exactly as it shipped, and it takes BOTH sites — a break at the
	// stamp alone does not reproduce it, because the read filter that now drops an
	// unscoped tombstone would catch the colliding ids on their way back out and
	// quietly protect the very chat this check is about. See `stamp-only`.
	shipped: [
		{ file: SRC, find: STAMP,    with: UNSCOPED },
		{ file: SRC, find: DROP_OLD, with: '' },
	],
	// Only the stamp. The colliding ids come back, the filter still refuses to
	// honour them, so nothing is deleted from anybody else's conversation — but
	// nothing is deleted from the folded one either, and it comes straight back.
	// This is why 4c and 4e are here: without them the property could be satisfied
	// by never tombstoning anything at all.
	'stamp-only': [
		{ file: SRC, find: STAMP, with: UNSCOPED },
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

/// Serve the damaged file to the page, before anything navigates.
async function breakInto(page) {
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

const s = await open({ name: 'dataloss', route: BREAK ? breakInto : null });
const p = s.page;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

// ── 1a. The receiving side: what may delete, and what may not ────────────

// Seeded through the engine's own door and NOT through a turn, which is the
// repair and not a shortcut. These two lines were `@tool file_write` of a
// workspace-root path, and since 2026-08-11 every chat is fenced to
// `chats/<id>/work` (`scopeChatTo`, www/js/daimond.js) -- so the engine refused
// both writes, said so in the tool result, and the turn finished normally. The
// census below then measured the system-seeded docs and nothing else, and three
// checks went red for a reason that had nothing to do with sync.
//
// What this section is about is the deletion guard, so the files go where the
// census will meet them by the shortest route that puts them there. `write_file`
// resolves against the active Workspace root, which here is the OPFS sandbox.
await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	await mod.write_file('keep-a.md', 'alpha');
	await mod.write_file('keep-b.md', 'beta');
});

/// The workspace as the sync census sees it.
const census = () => p.evaluate(async () => {
	const st = await window.DaimondCore.collectSync();
	return { paths: Object.keys(st.files || {}).sort(), complete: st.filesComplete };
});

/// Merge one parcel, then say which of the two seeded files survive.
const applyAndList = (parcel) => p.evaluate(async (parcel) => {
	const rep = await window.DaimondCore.applySync(parcel);
	const st  = await window.DaimondCore.collectSync();
	return { failed: rep.failed, paths: Object.keys(st.files || {}).sort() };
}, parcel);

const seeded = await census();
check('the sandbox census sees both seeded files',
	seeded.paths.includes('keep-a.md') && seeded.paths.includes('keep-b.md'), seeded.paths.join(' '));
check('and reports itself complete', seeded.complete === true, String(seeded.complete));

// Both devices now agree on both files: that is the baseline the deletion pass
// measures absence against, and without it there is nothing to delete.
await p.evaluate(() => window.DaimondCore.syncCommitBaseline());

const empty = await applyAndList({ v: 2, chats: [], files: {}, filesComplete: false });
check('a parcel of no files whose census was INCOMPLETE deletes nothing',
	empty.paths.includes('keep-a.md') && empty.paths.includes('keep-b.md'),
	empty.paths.join(' ') || '(workspace emptied)');

const old = await applyAndList({ v: 2, chats: [], files: {} });
check('and neither does one from a device too old to say (no flag at all)',
	old.paths.includes('keep-a.md') && old.paths.includes('keep-b.md'),
	old.paths.join(' ') || '(workspace emptied)');

// The other half of the property: a COMPLETE census still propagates a real
// deletion, or the guard has simply switched deletions off.
const real = await applyAndList({ v: 2, chats: [], files: { 'keep-a.md': 'alpha' }, filesComplete: true });
check('a complete census still deletes what the other device really deleted',
	real.paths.includes('keep-a.md') && !real.paths.includes('keep-b.md'),
	real.paths.join(' '));

// ── 3. The backup carries the identity, and the string is honest ─────────

await p.click('#user-row');
await p.waitForTimeout(400);
const dl = p.waitForEvent('download', { timeout: 15000 });
await p.click('button.admin-item:has-text("Export a backup")');
const file = scratch('dataloss-backup.json');
await (await dl).saveAs(file);
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
await p.keyboard.press('Escape');
await p.waitForTimeout(200);

const id = backup.identity || null;
check('the backup carries the identity', !!(id && id.priv && id.salt && id.pub),
	id ? Object.keys(id).join(',') : 'no identity field');
check('and carries it WRAPPED, exactly as it is at rest — no passphrase, no derived key',
	!!id && !JSON.stringify(id).includes('testpass'),
	'bundle is the localStorage values');
const adoptable = await p.evaluate((b) => {
	// Would a fresh browser be able to take this account over? Ask the importer,
	// without writing anything: a bundle it rejects restores nothing.
	return !!(b && b.v === 1 && b.salt && b.pub && b.priv);
}, id);
check('and in the shape importBundle accepts', adoptable);

const said = await p.evaluate(() => ({
	credits: window.DaimondI18n.t('forget.credits_body', { amount: 'a balance of $10.00' }),
	kept:    window.DaimondI18n.t('backup.identity_kept', { name: 'Someone' }),
}));
check('the Forget flow no longer promises a backup alone brings the money back',
	!/no way to get it back without a backup/i.test(said.credits), said.credits.slice(0, 90) + '…');
// THE PROPERTY. A user standing in front of this dialog must not walk away
// believing the file alone reaches their money: the copy has to name the
// passphrase, say the backup does not carry it, and say that losing it costs
// the balance for good.
//
// This was `/passphrase/ && /lost/`, and it went red when the copy inflected
// "Lose" instead of "lost". An inflection is not a property. Three clauses are
// asked for because one is not enough -- a sentence can name the passphrase and
// still promise the backup is sufficient, which is the exact harm.
const backupNeedsPassphrase = (s) => {
	const bits = s.split(/(?<=[.!?])\s+/);
	const neg  = /\b(not|no|never|nothing|only|without|alone|cannot)\b|n[’']t\b/i;
	return {
		names:  /passphrase/i.test(s),
		// Somewhere it says the backup by itself does not open the account.
		short:  bits.some(b => /backup|file|export/i.test(b) && /passphrase/i.test(b) && neg.test(b)),
		// Somewhere it says that losing the passphrase is final, for the money.
		final:  bits.some(b => /\b(lose|loses|losing|lost|forget|forgets|forgotten|without|gone)\b/i.test(b)
			&& /\b(nothing|never|no way|cannot|unrecoverable|irrecoverable|for good|gone)\b/i.test(b)
			&& /\b(balance|credits?|money|funds?|it)\b/i.test(b)),
	};
};
const cred = backupNeedsPassphrase(said.credits);
check('it names the passphrase, says the backup does not carry it, and says losing it is final',
	cred.names && cred.short && cred.final,
	Object.entries(cred).filter(([, v]) => !v).map(([k]) => 'no ' + k).join(', '));
check('and the import says plainly when it left an identity alone',
	/left alone/i.test(said.kept) && /\{name\}/.test(said.kept) === false, said.kept.slice(0, 70) + '…');

// ── 2a. A device that DID merge the index commits a live set ─────────────

/// Stub the mailbox and count commits, then push once.
const pushWithStubs = () => p.evaluate(async () => {
	window.__commits = 0;
	if (!window.DaimondChunks) window.DaimondChunks = {};
	window.DaimondChunks.commit = async function () { window.__commits++; return { swept: 0 }; };
	if (!window.DaimondCloud) window.DaimondCloud = {};
	if (!window.DaimondCloud.tierPlan) window.DaimondCloud.tierPlan = function () { return null; };
	if (!window.DaimondCloud.allowance) window.DaimondCloud.allowance = function () { return 0; };
	window.DaimondGateway.state = function () { return { authed: true, credits: 0, pro: false }; };
	if (!window.__realFetch) window.__realFetch = window.fetch;
	window.__version = (window.__version || 0);
	window.fetch = function (url, opts) {
		if (String(url).indexOf('/api/sync') === 0 || String(url).indexOf('/api/sync') > -1) {
			window.__version++;
			return Promise.resolve(new Response(
				JSON.stringify({ ok: true, version: window.__version }),
				{ status: 200, headers: { 'content-type': 'application/json' } }));
		}
		return window.__realFetch.apply(window, arguments);
	};
	await window.DaimondSync.push();
	return { commits: window.__commits, mayCommit: window.DaimondCore.syncMayCommitChunks() };
});

const sandboxPush = await pushWithStubs();
check('in the sandbox, where the chunk index IS merged, a push commits the live set',
	sandboxPush.mayCommit === true && sandboxPush.commits === 1,
	`mayCommit=${sandboxPush.mayCommit} commits=${sandboxPush.commits}`);

// ── 1b. A census truncated by the byte budget is not a deletion ──────────

// Eighty files of 120 KB: over the 8 MB inline budget, under the 128 KB
// per-file ceiling, so they are skipped for BUDGET and not offloaded.
const budget = await p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle('bulk', { create: true });
	const body = 'x'.repeat(120 * 1024);
	for (let i = 0; i < 80; i++) {
		const fh = await dir.getFileHandle('f' + i + '.txt', { create: true });
		const w  = await fh.createWritable();
		await w.write(body);
		await w.close();
	}
	const st = await window.DaimondCore.collectSync();
	return { n: Object.keys(st.files || {}).length, complete: st.filesComplete };
});
check('a census truncated by the byte budget says it is INCOMPLETE',
	budget.complete === false, `${budget.n} files carried, complete=${budget.complete}`);
check('while still carrying the files it did read — truncation is not silence',
	budget.n > 0, `${budget.n} files`);

// ── 1c + 2b. Folder mode: the census that started all this ───────────────

const folder = await p.evaluate(async () => {
	// Stand a real folder up out of OPFS and hand it to the picker, which is the
	// only door into folder mode. Permission is granted the way a user grants it.
	const root = await navigator.storage.getDirectory();
	const dir  = await root.getDirectoryHandle('picked', { create: true });
	dir.queryPermission   = async () => 'granted';
	dir.requestPermission = async () => 'granted';
	window.showDirectoryPicker = async () => dir;
	return true;
});
check('a folder is ready to be picked', folder === true);

// Open the Workspace panel and press the Machine chip, which is where the mode
// row puts "open a folder".
await p.evaluate(() => window.DaimondPanels && window.DaimondPanels.open && window.DaimondPanels.open('work'));
await p.waitForTimeout(600);
await p.evaluate(() => {
	const chips = [...document.querySelectorAll('.files-mode-chip')];
	const machine = chips.find(c => /machine/.test(c.className) || c.querySelector('[data-icon="machine"]')) || chips[1];
	if (machine) machine.click();
});
await p.waitForTimeout(1200);

const mode = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const st  = await window.DaimondCore.collectSync();
	return {
		mode:     mod.workspace_mode(),
		files:    Object.keys(st.files || {}).length,
		complete: st.filesComplete,
	};
});
check('the app is really in real-folder mode', mode.mode === 'folder', mode.mode);
check('a device in folder mode sends no files AND says so — the parcel cannot delete',
	mode.files === 0 && mode.complete === false,
	`${mode.files} files, complete=${mode.complete}`);

// And the same device must not declare the account's live chunk set.
const folderPush = await pushWithStubs();
check('a device that did not merge the chunk index does not commit one',
	folderPush.mayCommit === false && folderPush.commits === 0,
	`mayCommit=${folderPush.mayCommit} commits=${folderPush.commits}`);

// Prove the parcel a folder-mode device sends is harmless on the far side, by
// feeding it to the merge on a device that holds files.
// Back to the sandbox the way a user goes back: the Browser chip in the mode row.
await p.evaluate(() => {
	const chips = [...document.querySelectorAll('.files-mode-chip')];
	if (chips[0]) chips[0].click();
});
await p.waitForTimeout(900);
const afterFolderParcel = await applyAndList({ v: 2, chats: [], files: {}, filesComplete: mode.complete });
check('and merging that very parcel leaves the other device\'s workspace intact',
	afterFolderParcel.paths.includes('keep-a.md'), afterFolderParcel.paths.slice(0, 3).join(' '));

// ── 4. Clearing one conversation must not shorten another ───────────────
//
// THE PROPERTY, and it is written without reference to how a message is named:
// CLEARING ONE CONVERSATION MUST NEVER REMOVE A MESSAGE FROM A DIFFERENT ONE.
// Nothing below asserts an id, a shape, or the presence of any constant. The
// shipped defect was in the ids, but the next one need not be, and a check
// written against the repair would have gone green the day the repair moved.
//
// WHAT FOOLED THE LAST PERSON. Every check that watched this control watched the
// CONVERSATION IT WAS PRESSED ON — the thread emptied, the store agreed, it
// survived a reload — and all of that was true. The harm was in the conversations
// nobody was looking at, and no test had two of them. So the fixture here is two
// chats and the assertion is on the one that was never touched.
//
// The seeded transcripts carry NO `mid` FIELD AT ALL. That is the whole of what
// "predates message-ids" means, and it is the only way to reach the stamping path
// where the collision was: a chat whose messages already have ids never goes near
// it, which is why a fixture built by sending real turns cannot see this at all.
// (Seeded straight into the store rather than through `chat()`, which is how the
// chat fixtures elsewhere in this suite are built. The workspace seeding at the
// top of this file goes through `chat()` and cannot: a real turn mints real ids.)

const KEEP_ID   = 'dl-keep';
const DAIMON_ID = 'dl-daimon';
const KEEP = [
	'the pump seal on the boat',
	'Fit a new one before the season.',
	'and the bilge switch',
	'That is a separate part, and it is cheap.',
];
const DAIMON = [
	'the mooring line has chafed through',
	'Replace it this weekend.',
];

/// A Diamond to hang the daimon's conversation on. The rail's first will do — the
/// app seeds two on a first boot — and one is made if the rail is empty.
async function aDiamond() {
	const ids = () => p.$$eval('.diamond-box', (els) => els.map((e) => e.dataset.id || '').filter(Boolean));
	const have = await ids();
	if (have.length) return have[0];
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', 'Dataloss');
	await p.click('.dlg-ok', { force: true });
	await p.waitForTimeout(1800);
	return (await ids())[0] || '';
}

/// Two conversations written straight into the store, neither of them carrying a
/// single message id. `updatedAt` is now, so nothing here is old enough for the
/// expiry sweep to have an opinion about it.
function record(id, diamondId, lines) {
	const now = Date.now();
	return {
		id, name: '', diamondId,
		messages: lines.map((content, i) => ({
			role: i % 2 ? 'assistant' : 'user',
			content,
			ts: now - (lines.length - i) * 1000,
			// NO `mid`. See above.
		})),
		model: 'mock/fast', provider: 'mock', status: 'active',
		promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0,
		prevPrompt: 0, prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0,
		updatedAt: now,
	};
}

const seedChats = (recs) => p.evaluate((rs) => new Promise((resolve, reject) => {
	const req = indexedDB.open('daimond-chats', 1);
	req.onupgradeneeded = () => {
		const d = req.result;
		if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'id' });
	};
	req.onsuccess = () => {
		const t = req.result.transaction('chats', 'readwrite');
		const store = t.objectStore('chats');
		rs.forEach((r) => store.put(r));
		t.oncomplete = () => resolve(true);
		t.onerror    = () => reject(t.error);
	};
	req.onerror = () => reject(req.error);
}), recs);

/// What a stored conversation actually holds, as text, in order.
const held = (all, id) => ((all.find((c) => c.id === id) || {}).messages || [])
	.map((m) => String(m.content == null ? '' : m.content));

/// The same conversation, word for word and in the same order.
///
/// NOT A COUNT. A count is green on a transcript that lost its opening message
/// and gained another in its place, which is the shape a merge fails in — and it
/// is the shape this defect had: the messages that went were the FIRST ones.
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

const dId = await aDiamond();
check('there is a Diamond to hold a daimon\'s conversation', !!dId, dId || '(none on the rail)');
await seedChats([record(DAIMON_ID, dId, DAIMON), record(KEEP_ID, '', KEEP)]);

// Read back through the app, which is what makes these two PRE-MID chats and not
// merely two rows: the boot is where a message without an id is given one.
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'dataloss');
await p.waitForSelector('.diamond-box', { timeout: 20000 });
await p.waitForTimeout(1500);

const before = await storedChats(s);
check('4a. the fixture is two conversations, neither of which the other wrote',
	held(before, DAIMON_ID).length === DAIMON.length && held(before, KEEP_ID).length === KEEP.length,
	`daimon:${held(before, DAIMON_ID).length} other:${held(before, KEEP_ID).length}`);

// THE CLEAR NOW HAPPENS VIA THE DAIMON FOLD BUTTON (owner decision 2026-09-04).
// "Fresh daimon" was removed; its clear-conversation capability moved onto Fold,
// which absorbs the conversation into the Diamond's crystal and THEN clears it
// (`foldChatInto` -> `clearDaimonSession`). So the guard is exercised through the
// real control now: open the daimon's chat face, press Fold, and assert the OTHER
// conversation is whole. `clearDaimonSession` is the single guarded clear path,
// so this proves the property wherever it is reached from.
await p.evaluate((id) => {
	const box = document.querySelector('.diamond-box[data-id="' + id + '"]');
	if (box) box.click();
}, dId);
await p.waitForTimeout(700);
await p.click('#dview-chat', { force: true }).catch(() => {});
await p.waitForTimeout(700);
const folded = await p.evaluate(() => {
	const b = document.getElementById('chat-fold-btn');
	if (!b || getComputedStyle(b).display === 'none') return false;
	b.click();
	return true;
});
check('the daimon offers Fold, which now carries the clear', folded);
// The reducer is a real round trip; the clear runs once it has proposed.
await p.waitForTimeout(3800);

const after = await storedChats(s);
check('4b. CLEARING ONE CONVERSATION LEAVES ANOTHER WHOLE — every message, by content',
	same(held(after, KEEP_ID), KEEP),
	`${held(after, KEEP_ID).length}/${KEEP.length} held, opens with "${(held(after, KEEP_ID)[0] || '(nothing)').slice(0, 40)}"`);
check('4c. and the conversation that WAS folded is now cleared',
	held(after, DAIMON_ID).length === 0,
	`${held(after, DAIMON_ID).length} messages, "${(held(after, DAIMON_ID)[0] || '').slice(0, 40)}"`);

// The other half of the harm, and the half that reached the other devices: the
// tombstones travel in the parcel, so a peer that still holds both transcripts
// whole hands them back into the same merge. It must restore neither the folded
// conversation nor a hole in the one that was not.
const peer = {
	v: 2, files: {}, filesComplete: false,
	chats: [
		{ ...record(DAIMON_ID, dId, DAIMON), updatedAt: Date.now() - 60000 },
		{ ...record(KEEP_ID,   '',  KEEP),   updatedAt: Date.now() - 60000 },
	],
};
const merged = await p.evaluate(async (parcel) => (await window.DaimondCore.applySync(parcel)).failed, peer);
await p.waitForTimeout(1200);
const synced = await storedChats(s);
check('4d. AND A SYNC MERGE FROM A PEER THAT HOLDS BOTH WHOLE DOES NOT SHORTEN THE OTHER ONE',
	same(held(synced, KEEP_ID), KEEP),
	`${held(synced, KEEP_ID).length}/${KEEP.length} held, sections that failed: ${merged.join(',') || 'none'}`);
check('4e. while the folded conversation stays cleared THROUGH that same merge',
	held(synced, DAIMON_ID).length === 0,
	`${held(synced, DAIMON_ID).length} messages back from the peer`);

const errs = errors(s).filter(e => !/502|Bad Gateway|api\/sync/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
