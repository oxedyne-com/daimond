// A backup must contain the workspace, and must restore it. Session A writes a
// file via the agent, exports a backup, and we read the download. Session B (a
// fresh profile) imports it and we confirm the file is back.
import fs from 'node:fs';
import { open, chat, errors } from './harness.mjs';

// ── Session A: write a file, export ──────────────────────────────────────
const a = await open({ name: 'backupA' });
if (errors(a).length) console.log('A load errors:', errors(a));
await chat(a, '@tool file_write {"path":"keep/important.txt","content":"DO NOT LOSE THIS"}');

// Open the account menu and click Export, capturing the download.
await a.page.click('#user-row');
await a.page.waitForTimeout(400);
const dl = a.page.waitForEvent('download', { timeout: 15000 });
await a.page.click('button.admin-item:has-text("Export a backup")');
const download = await dl;
const path = '/tmp/daimond-backup-test.json';
await download.saveAs(path);
const backup = JSON.parse(fs.readFileSync(path, 'utf8'));

const ws = backup.workspace || [];
const found = ws.find(f => f.path === 'keep/important.txt');
console.log('backup format:', backup.format, 'workspace files:', ws.length);
console.log('contains our file:', !!found);
if (found) {
	const txt = Buffer.from(found.b64, 'base64').toString('utf8');
	console.log('  content round-trips:', txt === 'DO NOT LOSE THIS', `(${JSON.stringify(txt)})`);
}
await a.close();

// ── Session B: fresh profile, import, confirm the file is back ───────────
const b = await open({ name: 'backupB' });
await b.page.click('#user-row');
await b.page.waitForTimeout(400);
// The file input is created on click; set its files via the chooser.
const chooser = b.page.waitForEvent('filechooser', { timeout: 15000 });
await b.page.click('button.admin-item:has-text("Import a backup")');
const fc = await chooser;
await fc.setFiles(path);
await b.page.waitForTimeout(1500);

// Ask the agent to read it back — the truest check the file is really in OPFS.
const t = await chat(b, '@tool file_read {"path":"keep/important.txt"}');
const restored = /DO NOT LOSE THIS/.test(t);
console.log('\nSession B, after import, agent reads the file:', restored ? 'RESTORED' : 'MISSING');
console.log('B console errors:', errors(b));
await b.close();

console.log('\nEXPORT CONTAINS WORKSPACE:', !!found);
console.log('IMPORT RESTORES WORKSPACE:', restored);
