// verify_pickerstore.mjs -- which store the "Add files and folders" picker browses, and
// how a big folder in it is read (D-20261006-32, part 2).
//
// STORE. The picker lists the workspace that is open on THIS device through the page's own
// file tools: the machine folder where one is open (File System Access), browser storage
// otherwise. Neither goes through a hand -- `reach_of` routes to the hand only for a path under
// a turn's mark, and the picker's listing carries none -- so with no hand at all the `+` is
// live and the picker lists. That is asserted here so a later change that routes the picker
// through a hand has to come with the gate the owner asked for.
//
// READS. Every listing asks the browser for each file's `File` (size and stamp). They were asked
// for one at a time, so a 594-file folder was 594 round trips end to end, which on a real disk
// behind an open folder is the seconds of empty picker the owner saw. Each `getFile` is given
// PICKERSTORE_DISK_MS of latency here (default 5 ms, a modest disk) and the most in flight at
// once is counted: one on the old code, more than one and at most the bound on the new.
//
// WebKit: Playwright's WebKit has no OPFS, so there is no workspace to list; probed and said,
// exit 2 (NOT COVERED), never counted as a pass.
//
//   eval "$(bash dev/world.sh N --env)"; node dev/verify_pickerstore.mjs
import { open, shot } from './harness.mjs';

const N_FILES = 594;

let ok = 0, bad = 0;
const check = (name, pass, detail) => {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const s = await open({ name: 'pickerstore', signIn: false, connect: false });
const { page } = s;
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const opfs = await page.evaluate(async () => {
	try { await navigator.storage.getDirectory(); return ''; } catch (e) { return String((e && e.message) || e); }
});
if (opfs) {
	console.log(`  NOT COVERED: this browser has no OPFS (${opfs}), so there is no workspace to list.`);
	await s.close();
	process.exit(2);
}
const { signInAs, connectMock } = await import('./harness.mjs');
await signInAs(s, 'pickerstore');
await connectMock(s);
await page.waitForTimeout(1200);

// The folder of the drive: 594 files, and a Diamond in focus holding a few links,
// as a Diamond in use does.
await page.evaluate(async (n) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	for (let i = 0; i < n; i++) {
		const nm = 'specs/spec_' + String(i).padStart(4, '0') + '.md';
		await app.run_tool('file_write', JSON.stringify({ path: nm, content: '# ' + i + '\n' }));
	}
	await app.run_tool('file_write', JSON.stringify({ path: 'notes/a.md', content: '# a\n' }));
}, N_FILES);

await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Picker store');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
const diamondId = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	// Polled, not slept: WebKit takes longer than Chromium to write a new Diamond.
	let d = null;
	for (let i = 0; i < 80 && !d; i++) {
		d = JSON.parse(await app.list_diamonds()).find(r => r.name === 'Picker store') || null;
		if (!d) await new Promise(r => setTimeout(r, 250));
	}
	if (!d) return null;
	for (let i = 0; i < 12; i++) {
		await app.add_link(d.id, 'diamond:' + d.id, 'file:[browser]notes/held_' + i + '.md', 'holds', '', 'user');
	}
	// One row of the big folder is attached already: it must come back ticked and fixed.
	await app.add_link(d.id, 'diamond:' + d.id, 'file:[browser]specs/spec_0007.md', 'holds', '', 'user');
	return d.id;
});
check('a Diamond in focus', !!diamondId, String(diamondId));
if (!diamondId) { await shot(s, 'pickerstore-0-no-diamond'); await s.close(); process.exit(1); }
await page.evaluate(() => window.DaimondArtefacts && window.DaimondArtefacts.render());
await page.waitForTimeout(400);
await page.evaluate(() => { const b = document.getElementById('arte-strip'); if (b) b.click(); });
await page.waitForTimeout(600);

/// Sample the picker every 25 ms from now until `stop()`: whether the list has rows,
/// whether a status is up inside it, and whether Select would act.

const DISK_MS = Number(process.env.PICKERSTORE_DISK_MS || 5);
const WAVE    = 32;			// opfs.rs LIST_WAVE
const LOAD_MS = Number(process.env.PICKERSTORE_MS || 1500);

// ── Store ──
const store = await page.evaluate(async () => {
	let paired = null;
	try { const st = await window.DaimondHand.status(); paired = !!(st && (typeof st === 'string' ? JSON.parse(st) : st).paired); }
	catch (e) { paired = false; }
	const add = document.querySelector('#arte-list [data-act="attach-add"]');
	return {
		paired,
		folder: !!(window.DaimondFiles && window.DaimondFiles.folder && window.DaimondFiles.folder()),
		add: !!add,
		addOff: !!add && (add.disabled || add.getAttribute('aria-disabled') === 'true'),
	};
});
console.log('  store: ' + JSON.stringify(store));
check('no hand is paired on this device', store.paired === false, String(store.paired));
check('THE + IS LIVE WITHOUT A HAND (it browses this device\'s own workspace)', store.add && !store.addOff,
	JSON.stringify({ add: store.add, off: store.addOff }));

// ── Reads ──
await page.evaluate((ms) => {
	const P = window.FileSystemFileHandle && window.FileSystemFileHandle.prototype;
	const was = P.getFile;
	window.__ps = { calls: 0, now: 0, max: 0, on: false };
	P.getFile = function () {
		const me = window.__ps;
		if (!me.on) return was.apply(this, arguments);
		me.calls++; me.now++; if (me.now > me.max) me.max = me.now;
		const got = was.apply(this, arguments);
		return new Promise((ok, no) => setTimeout(() => got.then(
			(v) => { me.now--; ok(v); }, (e) => { me.now--; no(e); }), ms));
	};
}, DISK_MS);

await page.click('#arte-list [data-act="attach-add"]', { force: true });
await page.waitForSelector('.attach-pick-row', { timeout: 60000 });
let specsBtn = null;
for (const b of await page.$$('.attach-pick-name.dir')) {
	if (/specs/.test(await b.textContent())) { specsBtn = b; break; }
}
check('the picker lists this device\'s workspace (the specs folder is offered)', !!specsBtn);
if (!specsBtn) { await shot(s, 'pickerstore-1-nospecs'); await s.close(); process.exit(1); }

await page.evaluate(() => { window.__ps.on = true; window.__ps.t0 = performance.now(); });
await specsBtn.click();
await page.waitForFunction((n) => document.querySelectorAll('.attach-pick-row').length >= n,
	N_FILES, { timeout: 120000, polling: 20 }).catch(() => {});
const r = await page.evaluate(() => { window.__ps.on = false;
	return { calls: window.__ps.calls, max: window.__ps.max, ms: Math.round(performance.now() - window.__ps.t0),
		rows: document.querySelectorAll('.attach-pick-row').length }; });
await shot(s, 'pickerstore-2-specs');
console.log(`  reads: ${r.calls} getFile, at most ${r.max} at once; ${r.rows} rows in ${r.ms} ms at ${DISK_MS} ms a read`);
check('all ' + N_FILES + ' rows arrive', r.rows === N_FILES, String(r.rows));
check('each file is read for its size (a getFile per file)', r.calls >= N_FILES, String(r.calls));
check('THE READS ARE NOT ONE AT A TIME', r.max > 1, `at most ${r.max} in flight`);
check(`and never more than ${WAVE} at once`, r.max <= WAVE, String(r.max));
check(`A ${N_FILES}-FILE FOLDER LISTS IN UNDER ${LOAD_MS} ms at ${DISK_MS} ms a read`, r.ms < LOAD_MS, `${r.ms} ms`);

// Adding still works: one tick, Select, the link is there.
await page.$eval('.attach-pick-tick[data-path="specs/spec_0003.md"]', i => i.click());
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
const added = await page.evaluate(async (id) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const links = JSON.parse(await app.links_touching('diamond:' + id) || '[]');
	return links.some(l => /specs\/spec_0003\.md$/.test(String(l.other || l.to || '')));
}, diamondId);
check('and Select adds what was ticked, with no hand', added);

console.log(`\n${ok} ok, ${bad} failed (${process.env.DAIMOND_BROWSER || 'chromium'}; ${r.ms} ms, max ${r.max} in flight)`);
await s.close();
process.exit(bad ? 1 : 0);
