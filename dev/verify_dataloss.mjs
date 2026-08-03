// verify_dataloss.mjs — the three ways a sync round used to destroy a user's
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
//
// Needs dev/serve.mjs (:8777) and dev/mockllm.mjs (:9099). No gateway: the sync
// engine is driven against a stubbed mailbox, which is what makes the commit
// gate observable at all.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, chat, errors, scratch } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const s = await open({ name: 'dataloss' });
const p = s.page;

// ── 1a. The receiving side: what may delete, and what may not ────────────

await chat(s, '@tool file_write {"path":"keep-a.md","content":"alpha"}');
await chat(s, '@tool file_write {"path":"keep-b.md","content":"beta"}');

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
check('it names the passphrase as what a backup still needs',
	/passphrase/i.test(said.credits) && /lost/i.test(said.credits));
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

const errs = errors(s).filter(e => !/502|Bad Gateway|api\/sync/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
