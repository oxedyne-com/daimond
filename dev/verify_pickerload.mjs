// gateway: none
// verify_pickerload.mjs — the `+` picker shows that it is loading, its yes acts only
// on a choice that is there, and a big folder is listed in about a second
// (D-20261006-32; drive-oxegen-streams item 5, 12 Oct 2026).
//
// THE FAULT, measured on 6f82b971: `attachPicker` drew nothing while a folder was
// read, then asked whether each row was already attached ONE ROW AT A TIME, awaiting
// each before the next -- and for a Diamond each ask re-read and re-parsed every link
// touching it (`linkTo` -> `links_touching`). A 594-file folder was 594 store reads in
// series behind an empty list with no sign of life, and Select pressed meanwhile
// added nothing and closed as though it had.
//
//   1. While the folder is read the list says so, by role: a `status` in the list.
//   2. Select is disabled while the folder is read, and while nothing is ticked;
//      one tick enables it, unticking disables it again.
//   3. The 594 rows arrive, and the time from the press on the folder to the rows is
//      recorded and held under LOAD_MS.
//   4. A row already attached is drawn ticked and fixed (the batch read asks the
//      store the same question the per-row read did).
//
//   eval "$(bash dev/world.sh N --up)"; eval "$(bash dev/world.sh N --env)"
//   node dev/verify_pickerload.mjs                       # Chromium
//
// WEBKIT CANNOT RUN THIS: Playwright's WebKit has no OPFS (`navigator.storage.getDirectory`),
// so it has no workspace to list and cannot create the Diamond ("Could not create
// diamond: OPFS ..."; measured 12 Oct 2026, both trees). The run stops at the first
// check rather than pass on a picker it never opened.
import { open, shot } from './harness.mjs';

const N_FILES = 594;
const LOAD_MS = Number(process.env.PICKERLOAD_MS || 3000);

let ok = 0, bad = 0;
const check = (name, pass, detail) => {
	if (pass) { ok++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
	else { bad++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

const s = await open({ name: 'pickerload', signIn: false, connect: false });
const { page } = s;
await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
const { signInAs, connectMock } = await import('./harness.mjs');
await signInAs(s, 'pickerload');
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
await page.fill('.dlg-input', 'Picker load');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(900);
const diamondId = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	// Polled, not slept: WebKit takes longer than Chromium to write a new Diamond.
	let d = null;
	for (let i = 0; i < 80 && !d; i++) {
		d = JSON.parse(await app.list_diamonds()).find(r => r.name === 'Picker load') || null;
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
if (!diamondId) { await shot(s, 'pickerload-0-no-diamond'); await s.close(); process.exit(1); }
await page.evaluate(() => window.DaimondArtefacts && window.DaimondArtefacts.render());
await page.waitForTimeout(400);
await page.evaluate(() => { const b = document.getElementById('arte-strip'); if (b) b.click(); });
await page.waitForTimeout(600);

/// Sample the picker every 25 ms from now until `stop()`: whether the list has rows,
/// whether a status is up inside it, and whether Select would act.
const startSampler = (n) => page.evaluate((n) => {
	window.__pl = { t0: performance.now(), samples: [], rowsAt: null };
	window.__plTimer = setInterval(() => {
		const list = document.querySelector('.attach-pick');
		const okb  = document.querySelector('.dlg-ok');
		const rows = list ? list.querySelectorAll('.attach-pick-row').length : 0;
		const st   = list ? list.querySelector('[role="status"]') : null;
		const vis  = !!st && st.getBoundingClientRect().height > 0;
		const t    = performance.now() - window.__pl.t0;
		// Timed to the folder's OWN rows: the folder left behind is still drawn for
		// the first few ms after the press.
		if (rows >= n && window.__pl.rowsAt === null) window.__pl.rowsAt = t;
		// Off by the answer rule (aria-disabled with a reason) or by a bare `disabled`.
		const off = !!okb && (okb.disabled || okb.getAttribute('aria-disabled') === 'true');
		window.__pl.samples.push({ t: Math.round(t), rows, status: vis, okOff: off });
	}, 25);
}, n);
const stopSampler = () => page.evaluate(() => { clearInterval(window.__plTimer); return window.__pl; });

await page.click('#arte-list [data-act="attach-add"]', { force: true });
await page.waitForSelector('.attach-pick-row', { timeout: 60000 });
const specsBtn = await (async () => {
	for (const b of await page.$$('.attach-pick-name.dir')) {
		if (/specs/.test(await b.textContent())) return b;
	}
	return null;
})();
check('the picker offers the specs folder', !!specsBtn);

await startSampler(N_FILES);
await specsBtn.click();
await page.waitForFunction((n) => document.querySelectorAll('.attach-pick-row').length >= n,
	N_FILES, { timeout: 120000, polling: 50 }).catch(() => {});
await page.waitForTimeout(200);
const rec = await stopSampler();
await shot(s, 'pickerload-1-specs');

const waiting = rec.samples.filter(x => x.rows === 0);
const loadMs  = rec.rowsAt === null ? null : Math.round(rec.rowsAt);
console.log(`  load: ${loadMs} ms from the press to all ${N_FILES} rows; ${waiting.length} samples with an empty list`);
check('THE ROWS ARRIVE -- all ' + N_FILES,
	rec.samples.length && rec.samples[rec.samples.length - 1].rows === N_FILES,
	String(rec.samples.length && rec.samples[rec.samples.length - 1].rows));
check('the wait was seen at all (an empty list sampled)', waiting.length > 0, String(waiting.length));
check('WHILE THE LIST IS EMPTY IT SAYS IT IS LOADING (a status in the list)',
	waiting.length > 0 && waiting.every(x => x.status),
	`${waiting.filter(x => x.status).length}/${waiting.length} empty samples had a status`);
check('AND SELECT IS DISABLED WHILE IT LOADS',
	waiting.length > 0 && waiting.every(x => x.okOff),
	`${waiting.filter(x => x.okOff).length}/${waiting.length}`);
check('the status is gone once the rows are in',
	rec.samples.filter(x => x.rows > 0).every(x => !x.status));
check(`A ${N_FILES}-FILE FOLDER LISTS IN UNDER ${LOAD_MS} ms`, loadMs !== null && loadMs < LOAD_MS,
	`${loadMs} ms`);

const held = await page.evaluate(() => {
	const box = document.querySelector('.attach-pick-tick[data-path="specs/spec_0007.md"]');
	return box ? { on: box.checked, fixed: box.disabled } : null;
});
check('a row already attached is drawn ticked and fixed', !!held && held.on && held.fixed,
	JSON.stringify(held));

const okOff = () => page.$eval('.dlg-ok', b => b.disabled || b.getAttribute('aria-disabled') === 'true');
const okWhy = () => page.$eval('.dlg-ok', b => b.getAttribute('title') || '');
check('SELECT IS OFF WITH NOTHING TICKED, and says why', await okOff() && !!(await okWhy()),
	JSON.stringify(await okWhy()));
// A press that still arrives (a tap shows no title) is ANSWERED and adds nothing.
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(300);
const answered = await page.evaluate(() => {
	const e = document.querySelector('.dlg-err');
	return { open: !!document.querySelector('.attach-pick'), say: e ? e.textContent : '' };
});
check('A PRESS ON IT THEN IS ANSWERED in the card, which stays open', answered.open && !!answered.say,
	JSON.stringify(answered));
if (answered.open) {
	await page.$eval('.attach-pick-tick[data-path="specs/spec_0003.md"]', i => i.click());
	check('one tick turns it on', !(await okOff()));
	await page.$eval('.attach-pick-tick[data-path="specs/spec_0003.md"]', i => i.click());
	check('and unticking turns it off again', await okOff());
	await page.$eval('.attach-pick-tick[data-path="specs/spec_0003.md"]', i => i.click());
	await shot(s, 'pickerload-2-ticked');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(900);
	const added = await page.evaluate(async (id) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		const links = JSON.parse(await app.links_touching('diamond:' + id) || '[]');
		return links.some(l => /specs\/spec_0003\.md$/.test(String(l.other || l.to || '')));
	}, diamondId);
	check('and Select adds what was ticked', added);
} else {
	check('the card closed on a press with nothing ticked, so the rest is not reached', false);
}

console.log(`\n${ok} ok, ${bad} failed (${process.env.DAIMOND_BROWSER || 'chromium'}; load ${loadMs} ms)`);
await s.close();
process.exit(bad ? 1 : 0);
