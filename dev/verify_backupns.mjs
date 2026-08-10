// verify_backupns.mjs — a backup belongs to ONE account, and a restore adds to
// what is already here.
//
// Three properties, each of which was false:
//
//  1. AN EXPORT CARRIES ONE ACCOUNT'S FILES. `collectOpfsFiles` walked the OPFS
//     origin root, which is the PRIMARY account's workspace and the parent of
//     every other account's. So a backup taken from any account carried every
//     account's files at that browser — one person's private workspace handed
//     out in another person's backup file — and the taker's own files came out
//     under their internal `d~<id>/` prefix rather than at the paths they use.
//  2. A RESTORE LANDS WHERE THE ACCOUNT CAN SEE IT. `writeOpfsBytes` wrote to
//     the same raw root, so restoring into a secondary account put every file
//     in the PRIMARY's workspace: invisible to the account that asked for it,
//     reported as a success, and mixed into a workspace that was not asked.
//  3. A RESTORE MERGES THE LEDGER. The docstring said "merged"; the code did
//     `setItem`, so restoring a backup taken this morning erased every turn
//     recorded since. Spend history is a record of money that actually moved:
//     the only merge that cannot lose it is the union.
//
// A backup written before the namespace fix holds files from several accounts
// with nothing to say so. What the restore does with them is asserted here too:
// a `d~<id>/` subtree belonging to the CURRENT account is brought home with the
// prefix stripped, one belonging to any other account is skipped (there is no
// destination for it that is not either a fake folder in this workspace or a
// write into a stranger's storage at this browser), and everything un-prefixed
// is restored as it always was.
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.
import fs from 'node:fs';
import { open, errors, signInAs, scratch } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'backupns' });
const p = s.page;

/// Write a file through the wasm's own OPFS edge — the door the file tools use,
/// and the one that resolves the account namespace.
const write = (path, body) => p.evaluate(async ([path, body]) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	await mod.write_file(path, body);
}, [path, body]);

/// Read one back through the same door: null when this account cannot see it.
const read = (path) => p.evaluate(async (path) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	return await mod.read_file(path).catch(() => null);
}, path);

/// Every top-level name in the OPFS origin root, whichever account is current.
const rootNames = () => p.evaluate(async () => {
	const root = await navigator.storage.getDirectory();
	const out = [];
	for await (const ent of root.entries()) out.push(ent[0] + (ent[1].kind === 'directory' ? '/' : ''));
	return out.sort();
});

const ledger = () => p.evaluate(() => {
	try { return JSON.parse(localStorage.getItem('daimond-ledger') || '[]'); } catch (e) { return []; }
});
const setLedger = (rows) => p.evaluate((rows) => {
	localStorage.setItem('daimond-ledger', JSON.stringify(rows));
}, rows);

/// Take a backup the way a user does: the account row, then Export a backup.
async function exportBackup(file) {
	await p.click('#user-row');
	await p.waitForTimeout(400);
	const dl = p.waitForEvent('download', { timeout: 20000 });
	await p.click('button.admin-item:has-text("Export a backup")');
	await (await dl).saveAs(file);
	await p.keyboard.press('Escape');
	await p.waitForTimeout(300);
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/// Restore one the way a user does: the account row, Import a backup, the file
/// chooser, then acknowledge the notice and let the app reload.
async function importBackup(file, name) {
	await p.click('#user-row');
	await p.waitForTimeout(400);
	const chooser = p.waitForEvent('filechooser', { timeout: 20000 });
	await p.click('button.admin-item:has-text("Import a backup")');
	await (await chooser).setFiles(file);
	await p.waitForSelector('.dlg-ok', { timeout: 20000 });
	await p.click('.dlg-ok');
	await p.waitForSelector('#id-primary', { timeout: 20000 });
	await signInAs(s, name);
	await p.waitForTimeout(600);
}

// ── The primary account, holding something private ───────────────────────

const primaryId = await p.evaluate(() => window.DaimondAccounts.current());
await write('primary-secret.md', 'PRIMARY-ONLY-PAYLOAD');
check('the primary account holds its file', (await read('primary-secret.md')) === 'PRIMARY-ONLY-PAYLOAD');

// ── A second account at the same browser ─────────────────────────────────

await p.evaluate(() => { window.DaimondAccounts.add('Bob'); });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1200);
await signInAs(s, 'Bob');
await p.waitForTimeout(800);

const nsB = await p.evaluate(() => window.DaimondAccounts.opfsNs());
check('the second account has an OPFS namespace of its own', /^d~[0-9a-f]{16}$/.test(nsB), nsB);
await write('second-note.md', 'SECOND-ACCOUNT-PAYLOAD');
check('and cannot see the primary\'s file', (await read('primary-secret.md')) === null);

// Two turns of spend, both provider-reported so nothing is re-priced under us.
const L1 = { t: 1750000000000, m: 'mock/fast', p: 100, c: 20, ca: 0, u: 0.010, pv: 'custom', r: 1 };
const L2 = { t: 1750000001000, m: 'mock/fast', p: 200, c: 30, ca: 0, u: 0.020, pv: 'custom', r: 1 };
await setLedger([L1, L2]);

// ── 1. What the export carries ───────────────────────────────────────────

const file = scratch('backupns-export.json');
const backup = await exportBackup(file);
const paths = (backup.workspace || []).map(f => f.path);
const blob = JSON.stringify(backup);

check('a backup taken in one account carries NO other account\'s files',
	!blob.includes('PRIMARY-ONLY-PAYLOAD') && !paths.includes('primary-secret.md'),
	paths.filter(x => !/^bulk\//.test(x)).slice(0, 6).join(' ') || '(none)');
check('and carries its own, at the paths that account actually uses',
	paths.includes('second-note.md'),
	paths.find(x => /second-note/.test(x)) || '(absent)');
check('so no file in it is under another account\'s internal prefix',
	!paths.some(x => x.indexOf('d~') === 0), paths.filter(x => x.indexOf('d~') === 0).slice(0, 3).join(' '));
check('and the file says its paths are account-rooted, so a restore knows',
	backup.workspaceScope === 'account', String(backup.workspaceScope));
check('the export carries the ledger it was taken with',
	(backup.ledger || []).length === 2, String((backup.ledger || []).length));

// ── 3. What a restore does to the ledger ─────────────────────────────────

// Spend since the backup was taken: L2 re-priced by the correction pass (same
// turn, a different figure), and L3, which the backup has never heard of.
const L2r = { t: L2.t, m: L2.m, p: L2.p, c: L2.c, ca: L2.ca, u: 0.005, pv: L2.pv, r: 1, rp: 1, u0: 0.020 };
const L3  = { t: 1750000002000, m: 'mock/fast', p: 300, c: 40, ca: 0, u: 0.030, pv: 'custom', r: 1 };
await setLedger([L2r, L3]);

// A backup file of the same shape the app writes, holding one workspace file
// under a plain path and the ledger as it stood at L1+L2.
const newFile = scratch('backupns-new.json');
fs.writeFileSync(newFile, JSON.stringify({
	format: 'daimond-backup', version: 1, exported: new Date().toISOString(),
	name: 'Bob', identity: null, chats: [], diamonds: [],
	workspaceScope: 'account',
	workspace: [{ path: 'restored-here.md', b64: Buffer.from('RESTORED-PAYLOAD').toString('base64') }],
	ledger: [L1, L2],
}, null, 2));

await importBackup(newFile, 'Bob');

check('a restore puts the files where the account that asked for them can see them',
	(await read('restored-here.md')) === 'RESTORED-PAYLOAD', String(await read('restored-here.md')));

const merged = await ledger();
const at = (t) => merged.filter(e => e.t === t);
check('a restore MERGES the ledger — the backup\'s older turn comes back',
	at(L1.t).length === 1, `${at(L1.t).length} entries at L1`);
check('and the spend since the backup was taken is still there',
	at(L3.t).length === 1, `${at(L3.t).length} entries at L3`);
check('a turn both ledgers hold is held once, not twice',
	at(L2.t).length === 1, `${at(L2.t).length} entries at L2`);
check('and the local record of it wins, so a re-priced turn is not un-re-priced',
	at(L2.t).length === 1 && at(L2.t)[0].u === 0.005, JSON.stringify(at(L2.t)[0] || null));
check('nothing else was invented', merged.length === 3, `${merged.length} entries`);

// ── The other account is untouched by any of it ──────────────────────────

check('the primary\'s workspace did not gain the restored file',
	(await p.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		return await root.getFileHandle('restored-here.md').then(() => 'FOUND').catch(() => 'not-found');
	})) === 'not-found');

// ── An OLD backup, from before any of this was true ──────────────────────

const legacy = scratch('backupns-legacy.json');
fs.writeFileSync(legacy, JSON.stringify({
	format: 'daimond-backup', version: 1, exported: new Date().toISOString(),
	name: 'Bob', identity: null, chats: [], ledger: [],
	// A Diamond whose raw store is in the part of the backup that belongs to
	// somebody else. Its files cannot be restored, so the summary is the only way
	// it comes back at all — and the restore must not mistake a path it declined
	// to write for a Diamond it has already brought back.
	diamonds: [{ id: 'did-foreign-1', name: 'Fallback Diamond', crystal: 'FALLBACK-CRYSTAL', tags: [] }],
	// No `workspaceScope`: the raw origin root, exactly as the old export walked
	// it — this account's files under its own prefix, a stranger's under theirs,
	// and the primary's at the top.
	workspace: [
		{ path: 'legacy-plain.md', b64: Buffer.from('LEGACY-PLAIN').toString('base64') },
		{ path: nsB + '/legacy-mine.md', b64: Buffer.from('LEGACY-MINE').toString('base64') },
		{ path: 'd~deadbeefdeadbeef/legacy-foreign.md', b64: Buffer.from('LEGACY-FOREIGN').toString('base64') },
		// `crystal.md`, and it stays that way: this is a `version: 1` backup, and a
		// backup of that vintage is exactly where the markdown crystal is still
		// found. Nothing here writes it -- it is the foreign subtree the restore
		// must decline -- so the format it is in is the fixture's whole point.
		{ path: 'd~deadbeefdeadbeef/diamonds/did-foreign-1/crystal.md',
			b64: Buffer.from('# Fallback Diamond').toString('base64') },
	],
}, null, 2));

await importBackup(legacy, 'Bob');

check('an old backup\'s un-prefixed files restore into the account that asked',
	(await read('legacy-plain.md')) === 'LEGACY-PLAIN', String(await read('legacy-plain.md')));
check('and a subtree under THIS account\'s own prefix comes home, prefix stripped',
	(await read('legacy-mine.md')) === 'LEGACY-MINE', String(await read('legacy-mine.md')));
check('while another account\'s subtree is not written into this workspace',
	(await read('d~deadbeefdeadbeef/legacy-foreign.md')) === null);
const names = await rootNames();
check('nor into a namespace at this browser that belongs to nobody here',
	!names.includes('d~deadbeefdeadbeef/'), names.filter(n => n.indexOf('d~') === 0).join(' '));
check('and the prefixed file is not restored under its prefix either',
	(await read(nsB + '/legacy-mine.md')) === null);

const rows = await p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return JSON.parse(await app.list_diamonds()).map(r => r.name);
});
check('a Diamond whose store was left out still comes back from the summary',
	rows.filter(n => n === 'Fallback Diamond').length === 1, rows.join(', ') || '(no diamonds)');

// ── The same rule, between two devices ───────────────────────────────────
// The provider keys and the credit base a user types in already sync, and the
// ledger did not — so "left on this key" was the same base minus a different
// device's spend, and the two devices disagreed about the user's money. The
// parcel carries the ledger now, merged by the same union.

const L4 = { t: 1750000003000, m: 'mock/fast', p: 400, c: 50, ca: 0, u: 0.040, pv: 'custom', r: 1 };
const parcelled = await p.evaluate(() => window.DaimondCore.collectSync().then(st => st.ledger || []));
check('the sync parcel carries this device\'s ledger',
	parcelled.length === 3 && parcelled[0].t < parcelled[2].t, `${parcelled.length} entries`);

const pulled = await p.evaluate(async (L4) => {
	await window.DaimondCore.applySync({ v: 2, chats: [], ledger: [L4] });
	const first = JSON.parse(localStorage.getItem('daimond-ledger') || '[]');
	// The same parcel again: a pull that repeats must not charge the user twice.
	await window.DaimondCore.applySync({ v: 2, chats: [], ledger: [L4] });
	return { first: first.length, again: JSON.parse(localStorage.getItem('daimond-ledger') || '[]').length };
}, L4);
check('a pulled parcel adds the other device\'s turns', pulled.first === 4, String(pulled.first));
check('and pulling it again adds nothing', pulled.again === 4, String(pulled.again));

const kept = await p.evaluate((L2t) => {
	// The other device's copy of a turn THIS one has already re-priced.
	const stale = { t: L2t, m: 'mock/fast', p: 200, c: 30, ca: 0, u: 0.020, pv: 'custom', r: 1 };
	return window.DaimondCore.applySync({ v: 2, chats: [], ledger: [stale] }).then(() => {
		const rows = JSON.parse(localStorage.getItem('daimond-ledger') || '[]').filter(e => e.t === L2t);
		return { n: rows.length, u: rows.length ? rows[0].u : null };
	});
}, L2.t);
check('and a remote copy of a turn we already hold does not un-re-price it',
	kept.n === 1 && kept.u === 0.005, JSON.stringify(kept));

// A gateway is not part of this: a fresh account has no session at one, so its
// calls answer 401 when a gateway happens to be up and 502 when it is not.
// Either is the environment, not the app.
const errs = errors(s).filter(e =>
	!/Failed to load resource.*\b(401|402|404|426|502|503)\b/.test(e)
	&& !/favicon|net::ERR|api\/sync/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
