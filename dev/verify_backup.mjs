// A backup must contain the workspace, and must restore it. Session A puts a file
// in the workspace, exports a backup, and we read the download. Session B (a fresh
// profile) imports it and we confirm the file is back.
//
// TWO REPAIRS, 2026-08-14, and the second matters more than the first.
//
// THE SEED IS OUT OF BAND. It used to be `@tool file_write {"path":"keep/important.txt"}`
// typed into a chat. Since the chat fence landed on 2026-08-12 a chat is confined to
// `chats/<id>/work` (`scopeChatTo`, www/js/daimond.js), and `Tool::guard`
// (src/tools.rs:5490) refuses a workspace-ROOT path before anything is written. The
// refusal came back as an ordinary tool result: nothing was written, nothing threw,
// and the export below packed an empty workspace. The seed now goes through the
// engine's own door instead, which is where a fixture that is not ABOUT a turn belongs.
//
// AND THE RESTORE IS NO LONGER READ OUT OF A TRANSCRIPT, which is the older and worse
// defect: this file has never once proved a restore. The check was
// `/DO NOT LOSE THIS/.test(session B's visible transcript)` — and that phrase was the
// USER'S OWN TYPED TEXT, the first message of session A's chat, restored with the
// CONVERSATION. So it passed with an export carrying zero workspace files and an
// import restoring zero, which is exactly the state it was in. The marker below is
// therefore never typed by anybody, the restore is read from OPFS in session B, and a
// check further down asserts the marker is absent from the backup's chats — so if a
// later hand moves the seed back into a turn, that check goes red and says why.
import fs from 'node:fs';
import { open, errors, signInAs, scratch } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const WS_PATH = 'keep/important.txt';
// Never typed into a chat, never in a prompt, never in a name: the ONLY way this
// string can be found anywhere is if the FILE was carried and restored.
const MARKER  = 'DO-NOT-LOSE-THIS-9f3a1c';

/// A workspace file read straight out of OPFS, outside the app entirely.
const opfsRead = (s, p) => s.page.evaluate(async (p) => {
	const parts = p.split('/');
	let d = await navigator.storage.getDirectory();
	for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
	const fh = await d.getFileHandle(parts[parts.length - 1]);
	return await (await fh.getFile()).text();
}, p).catch((e) => '(' + String(e).split('\n')[0] + ')');

// ── Session A: put a file in the workspace, export ───────────────────────
const a = await open({ name: 'backupA' });
if (errors(a).length) console.log('A load errors:', errors(a));
await a.page.evaluate(async ([p, body]) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	await mod.write_file(p, body);
}, [WS_PATH, MARKER]);
check('session A really has the file in its workspace',
	await opfsRead(a, WS_PATH) === MARKER, JSON.stringify(await opfsRead(a, WS_PATH)));

// Open the account menu and click Export, capturing the download.
await a.page.click('#user-row');
await a.page.waitForTimeout(400);
const dl = a.page.waitForEvent('download', { timeout: 15000 });
await a.page.click('button.admin-item:has-text("Export a backup")');
const download = await dl;
const path = scratch('backup-test.json');
await download.saveAs(path);
const backup = JSON.parse(fs.readFileSync(path, 'utf8'));

const ws = backup.workspace || [];
const found = ws.find(f => f.path === WS_PATH);
console.log('backup format:', backup.format, 'workspace files:', ws.length);
check('EXPORT CONTAINS WORKSPACE — the file is an entry in the backup',
	!!found, `${ws.length} workspace file(s): ${ws.map(f => f.path).slice(0, 5).join(', ')}`);
const packed = found ? Buffer.from(found.b64, 'base64').toString('utf8') : '';
check('and its bytes round-trip through the backup, not just its name',
	packed === MARKER, JSON.stringify(packed));
// The guard that keeps this file honest. If the marker is in the conversation, the
// restore check below could be satisfied by the CHAT coming back and would prove
// nothing about the workspace — which is how this test passed for months.
check('the marker is nowhere in the backup\'s chats, so only the FILE can carry it',
	!JSON.stringify(backup.chats || []).includes(MARKER),
	'chats bytes: ' + JSON.stringify(backup.chats || []).length);
await a.close();

// ── Session B: fresh profile, import, confirm the file is back ───────────
const b = await open({ name: 'backupB' });
check('session B starts without the file', /^\(/.test(await opfsRead(b, WS_PATH)),
	JSON.stringify(await opfsRead(b, WS_PATH)));
await b.page.click('#user-row');
await b.page.waitForTimeout(400);
// The file input is created on click; set its files via the chooser.
const chooser = b.page.waitForEvent('filechooser', { timeout: 15000 });
await b.page.click('button.admin-item:has-text("Import a backup")');
const fc = await chooser;
await fc.setFiles(path);

// A restore rewrites the workspace out from under the running engine, so the app
// confirms and then reloads to bring every restored surface back consistent.
// Acknowledge the notice, let it reload, and unlock the fresh session.
await b.page.waitForSelector('.dlg-ok', { timeout: 15000 });
await b.page.click('.dlg-ok');
await b.page.waitForSelector('#id-primary', { timeout: 15000 });
await signInAs(b, 'backupB');       // unlock the reloaded session

// READ FROM OPFS, not from the thread: the store is what a restore has to reach.
const restored = await opfsRead(b, WS_PATH);
console.log('\nSession B, after import, the file on disk:', JSON.stringify(restored));
check('IMPORT RESTORES WORKSPACE — the file is on disk in session B, with its bytes',
	restored === MARKER, JSON.stringify(restored));

const errs = errors(b).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw in session B', errs.length === 0, errs.slice(0, 2).join(' | '));
await b.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(x => console.log('  FAILED: ' + x)); process.exit(1); }
