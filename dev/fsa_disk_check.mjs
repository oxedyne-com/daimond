// fsa_disk_check.mjs — the one thing an OPFS stand-in cannot prove: the bytes are on real disk.
//
// `verify_fsa.mjs` drives all of real-folder mode headlessly by standing an OPFS subdirectory
// handle in for a picked folder — the types are identical, so every line of the code is exercised.
// What it cannot show is that a *picked* folder is a real directory on the user's disk, because
// showDirectoryPicker opens a native dialog that automation cannot answer.
//
// So this asks for exactly one human gesture, and then does the rest: it opens a real browser,
// waits for the folder to be picked, has the AGENT write a file through its ordinary file tool,
// and reads it back. The proof is not in this script — it is in the shell afterwards, where the
// file either is on disk or is not.
//
//   node dev/fsa_disk_check.mjs            (then pick ~/daimond-fsa-test in the dialog)
//
// The browser profile is kept, so the grant persists and a later run reconnects with no gesture.
import { open, signInAs } from './harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FOLDER = path.join(os.homedir(), 'daimond-fsa-test');
const STAMP  = 'written-by-the-agent-' + process.pid + '.md';
const BODY   = 'The agent wrote this through its ordinary file_write tool, into a real folder.';

console.log('\n  Opening a browser on your display.');
console.log('  In the WORKSPACE panel, next to the "🗄 OPFS (sandbox)" chip,');
console.log('  press "📂 Open a folder…" and pick:\n');
console.log('      ' + FOLDER + '\n');

const s = await open({
	name:    'fsa-real',
	headed:  true,                       // a native dialog needs a real window
	connect: false,
	profile: '/tmp/daimond-fsa-real',    // keep the grant, so the next run needs no gesture
});
const p = s.page;
await p.waitForTimeout(1500);

// Poll until the folder is open. The gesture is the user's; everything after it is not.
const t0 = Date.now();
let mode = 'opfs', folder = '';
while (Date.now() - t0 < 240000) {
	const st = await p.evaluate(async () => {
		const mod  = await import('../pkg/oxedyne_daimond.js');
		const chip = document.querySelector('.files-mode-chip');
		return { mode: mod.workspace_mode(), chip: chip ? chip.textContent.trim() : '' };
	}).catch(() => ({ mode: 'opfs', chip: '' }));
	if (st.mode === 'folder') { mode = st.mode; folder = st.chip; break; }
	await p.waitForTimeout(1000);
}

if (mode !== 'folder') {
	console.log('  No folder was picked (timed out). Nothing was written.');
	await s.close();
	process.exit(2);
}
console.log('  Folder is open: ' + folder);

// The agent's own tool, not a test back door: this is the path a real turn takes.
const wrote = await p.evaluate(async ({ stamp, body }) => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	const w = await app.run_tool('file_write', JSON.stringify({ path: stamp, content: body }));
	const r = await app.run_tool('file_read',  JSON.stringify({ path: stamp }));
	const l = await app.run_tool('file_list',  JSON.stringify({ path: '.' }));
	return { w, r, l };
}, { stamp: STAMP, body: BODY });

console.log('  Agent wrote:  ' + (wrote.w || '').trim());
console.log('  Agent read:   ' + (wrote.r || '').trim().slice(0, 60));
console.log('  Agent listed: ' + (wrote.l || '').trim().split('\n').join(' | '));

// The claim, checked where it actually matters.
const onDisk = path.join(FOLDER, STAMP);
const exists = fs.existsSync(onDisk);
const disk   = exists ? fs.readFileSync(onDisk, 'utf8').trim() : '(absent)';
const sawExisting = /existing\.md/.test(wrote.l || '');

console.log('\n  ── on real disk ──');
console.log('  ' + onDisk);
console.log('  exists: ' + exists);
console.log('  content matches what the agent wrote: ' + (disk === BODY));
console.log('  the agent could see the file that was already there: ' + sawExisting);

await s.close();
const pass = exists && disk === BODY && sawExisting;
console.log('\n  ' + (pass ? 'PASS — real-folder mode reaches real disk.' : 'FAIL'));
process.exit(pass ? 0 : 1);
