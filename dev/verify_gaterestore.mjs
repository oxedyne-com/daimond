// verify_gaterestore.mjs — restoring a backup at the gate makes the account FROM
// the backup's own identity, in a browser that has never held one.
//
// THE DEFECT (audit 2026-09-15, A12; UX run T05b). Export and Import lived only on
// the account panel (`renderHomeBody` in www/js/daimond.js), which draws nothing
// but a "Create account" button while `!DaimondIdentity.exists()` — so "Skip for
// now" on a fresh browser left a stranger with an empty panel and no Import at
// all. Recovering into a NEW browser therefore meant making a throwaway account
// FIRST, and `doImport`'s own rule — adopt the bundle's identity only when this
// browser holds NONE, otherwise leave the current one alone and say so — then
// left the THROWAWAY standing, because by the time Import was reachable an
// identity already existed to protect.
//
// THE FIX adds a fourth door under the Create button, beside "I have a passcode"
// (`#id-door-backup`, index.html), wired in `syncDoors` (www/js/daimond.js) to the
// SAME `doImport` the account panel calls. `doImport`'s no-identity branch was
// already correct — `importBundle` adopts the backup's identity — it was simply
// unreachable before an account existed to host a button that could call it.
//
// FOUR PROPERTIES:
//
//   1. A STRANGER SEES THE DOOR. `#id-doors` shows only when creating and this
//      browser has never held an identity (`neverHeldAnIdentity`) — exactly the
//      recovery case — and "Restore from a backup" is one of its three siblings.
//   2. THE IDENTITY NOTICE NAMES THE BACKUP'S OWN ACCOUNT, not this device's (it
//      has none yet).
//   3. THE ACCOUNT THAT UNLOCKS AFTERWARDS IS THE BACKUP'S OWN — same fingerprint
//      as the browser that exported it — not a throwaway this browser minted.
//   4. AND THE WORKSPACE CAME WITH IT, in the same restore.
//
// PROVED AGAINST THE DOOR UNWIRED FIRST: `--break unwired` drops the one
// `addEventListener` call `syncDoors` adds for `#id-door-backup` — the button is
// still on screen (it is markup, not script), but pressing it does nothing,
// which is the state before this fix as truly as removing the button would be.
//
//   node dev/verify_gaterestore.mjs --break unwired   # expected to FAIL
//   node dev/verify_gaterestore.mjs                   # and then, clean
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and dev/mockllm.mjs
// (DAIMOND_MOCK_PORT, default 9099). No gateway.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, errors, signInAs, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	unwired: {
		file: 'js/daimond.js',
		find: "\t\t\tbackup.addEventListener('click', function () { doImport(); });\n",
		with: "",
	},
};
if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const stub = async (page) => {
	if (!BREAK) return;
	const spec = BREAKS[BREAK];
	const src  = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	// An anchor that is not there exactly once patches nothing and the run would
	// pass quietly, which is worse than a red.
	if (src.split(spec.find).length !== 2) {
		console.error(`break '${BREAK}': its anchor is not in ${spec.file} exactly once`);
		process.exit(2);
	}
	const body = src.replace(spec.find, spec.with);
	await page.route('**/' + spec.file, (r) => r.fulfill({
		status: 200, contentType: 'application/javascript', body,
	}));
};

const WS_PATH = 'keep/gaterestore.txt';
// Never typed into a chat, never in a name: the only way this string is found
// anywhere is if the FILE was carried and restored, exactly as verify_backup.mjs
// argues for its own marker.
const MARKER  = 'GATE-RESTORE-MARKER-7c2b';

const opfsRead = (s, p) => s.page.evaluate(async (p) => {
	const parts = p.split('/');
	let d = await navigator.storage.getDirectory();
	for (const seg of parts.slice(0, -1)) d = await d.getDirectoryHandle(seg);
	const fh = await d.getFileHandle(parts[parts.length - 1]);
	return await (await fh.getFile()).text();
}, p).catch((e) => '(' + String(e).split('\n')[0] + ')');

// ── Session A: an ordinary account, holding an identity and a file ───────
const a = await open({ name: 'gaterestoreA' });
if (errors(a).length) console.log('A load errors:', errors(a));
const idA = await a.page.evaluate(() => ({
	name: window.DaimondIdentity.displayName(),
	fp:   window.DaimondIdentity.fingerprint(),
}));
await a.page.evaluate(async ([p, body]) => {
	const mod = await import('/pkg/oxedyne_daimond.js');
	await mod.write_file(p, body);
}, [WS_PATH, MARKER]);

await a.page.click('#user-row');
await a.page.waitForTimeout(400);
const dl = a.page.waitForEvent('download', { timeout: 15000 });
await a.page.click('button.admin-item:has-text("Export a backup")');
const file = scratch('gaterestore-backup.json');
await (await dl).saveAs(file);
await a.close();

// ── Session B: a stranger. No account has ever existed here. ─────────────
const b = await open({ name: 'gaterestoreB', signIn: false, route: stub });
const p = b.page;
if (BREAK) console.log(`\n*** RUNNING UNDER --break ${BREAK}: failures below are the point ***\n`);

try {
	await p.waitForSelector('#id-primary', { timeout: 15000 });

	// ── 1. A stranger sees the door ───────────────────────────────
	check(await p.evaluate(() => !!document.getElementById('id-doors').getClientRects().length),
		'A STRANGER SEES THE DOORS STRIP', '#id-doors');
	const doorText = await p.evaluate(() => {
		const b = document.getElementById('id-door-backup');
		return b ? (b.textContent || '').trim() : null;
	});
	check(!!doorText, 'AND "RESTORE FROM A BACKUP" IS ONE OF ITS THREE SIBLINGS', JSON.stringify(doorText));

	// The strip is a CLOSED `<details>` under the Create button (audit GATE-01/03):
	// one line until it is opened, same as dev/l11_doors.mjs walks the other three.
	await p.evaluate(() => { const d = document.getElementById('id-doors'); if (d && 'open' in d) d.open = true; });

	const chooser = p.waitForEvent('filechooser', { timeout: 15000 });
	await p.click('#id-door-backup');
	await (await chooser).setFiles(file);

	// ── 2. The identity notice names the backup's own account ────
	await p.waitForSelector('.dlg-ok', { timeout: 15000 });
	const noticeNamesA = await p.evaluate((name) => {
		const c = document.querySelector('.dlg-card');
		return !!(c && (c.textContent || '').includes(name));
	}, idA.name);
	check(noticeNamesA, "THE IDENTITY NOTICE NAMES THE BACKUP'S OWN ACCOUNT, not a throwaway", idA.name);
	await p.click('.dlg-ok');

	// The restore notice, then the reload it warns about.
	await p.waitForSelector('.dlg-ok', { timeout: 15000 });
	await p.click('.dlg-ok');

	// NOT a raw wait for '#id-primary': this browser has never unlocked anything,
	// so there is no stay-unlocked session to come back through either way — but
	// `signInAs` is the one door every other file in this suite trusts for this,
	// and staying consistent with it is the point, not a workaround.
	await signInAs(b, idA.name);

	// ── 3. The account that unlocked is the backup's own ─────────
	const idB = await p.evaluate(() => ({
		name: window.DaimondIdentity.displayName(),
		fp:   window.DaimondIdentity.fingerprint(),
	}));
	check(!!idB.fp && idB.fp === idA.fp,
		"THE ACCOUNT IS THE BACKUP'S OWN IDENTITY, not one this browser minted",
		`A fp=${idA.fp} B fp=${idB.fp}`);
	check(idB.name === idA.name, 'under the backup\'s own name', `A=${idA.name} B=${idB.name}`);

	// ── 4. And the workspace came with it ─────────────────────────
	const restored = await opfsRead(b, WS_PATH);
	check(restored === MARKER, 'AND THE WORKSPACE CAME WITH IT, in the same restore', JSON.stringify(restored));

	const errs = errors(b).filter(e => !/502|Bad Gateway/.test(e));
	check(errs.length === 0, 'nothing threw', errs.slice(0, 2).join(' | '));
} finally {
	await b.close();
}

console.log(bad ? `\n${bad} check(s) FAILED` : '\nall checks passed');
process.exit(bad ? 1 : 0);
