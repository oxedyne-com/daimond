// verify_crystalmemory.mjs — a Diamond's MEMORY is visible and editable, and an edit
// reaches the next daimon's system message.
//
// THE FEATURE THIS IS WRITTEN FROM, in the owner's words: "I used to be able to click to
// expand and view the memory part of a crystal, I can't see that anymore." The crystal is
// drawn by a page it owns (see verify_crystalpage), and the page RENDERS the memory but
// gave no way to see or edit the memory itself. This restores a click-to-expand raw view
// of `crystal.json`, with an inline editor, on the crystal face.
//
// THE PROPERTIES:
//
//   1. The crystal face carries a Memory disclosure, and its editor holds the memory as
//      it sits on disk — the raw `crystal.json`, not a rendering of it.
//   2. An edit made there and SAVED persists: `read_crystal_data` returns the new bytes.
//      This is the check that matters — a disclosure that showed the memory and dropped
//      an edit would look right and lose the user's words.
//   3. The saved memory reaches a fresh daimon's system message: `wire_system` composes
//      the "Diamond" band from `crystal.json` as it stands, so the edited fact is IN the
//      `local` string the next turn is sent. Persisting to a file nothing reads would be
//      the same nothing as before.
//
// EACH CHECK PROVED AGAINST BROKEN CODE FIRST:
//
//   node dev/verify_crystalmemory.mjs --break nopanel   # 1: the disclosure is not drawn
//   node dev/verify_crystalmemory.mjs --break nosave     # 2, 3: Save writes nothing
//   node dev/verify_crystalmemory.mjs                    # and then, clean
//
// `nopanel` turns check 1 red and leaves the rest unreachable; `nosave` leaves the
// disclosure standing and turns the persistence and wire checks red — which is what
// pins the memory→prompt path to the SAVE and not to the mere presence of a box.
//
// Needs the live gate: the dev server at :8777 and the mock provider, like every harness
// verifier here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs, connectMock, errors } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW  = path.join(HERE, '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The disclosure is never appended, so the crystal face carries no memory view at all.
	nopanel: {
		file: 'js/daimond.js',
		find: "\t\tcrystalBody.appendChild(crystalMemoryPanel(id, text));",
		with: "\t\tvoid crystalMemoryPanel;",
	},
	// Save resolves without writing, so the box is there and an edit vanishes on Save.
	nosave: {
		file: 'js/daimond.js',
		find: "\t\t\ttry { await diamondApp().write_crystal_data(id, JSON.stringify(d, null, 2)); }",
		with: "\t\t\ttry { await Promise.resolve(void d); }",
	},
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

// A crystal with a fact the editor can find and a summary the box must show verbatim.
const CRYSTAL = {
	title:   'Memory',
	summary: 'A crystal to read and edit through the Memory disclosure.',
	facts:   [{ k: 'Seed', v: 'the value that was there before the edit' }],
};
// The words the edit adds. Distinctive, so finding them in the wire proves the path.
const ADDED = 'edited-memory-marker-42';

const s = await open({ name: 'crystalmemory', signIn: false, connect: false });
const { page } = s;

if (BREAK) {
	const spec = BREAKS[BREAK];
	if (!spec) {
		console.error('no such break: ' + BREAK + '\nhave: ' + Object.keys(BREAKS).join(' '));
		process.exit(2);
	}
	const src = fs.readFileSync(path.join(WWW, spec.file), 'utf8');
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, `
			+ 'so nothing was broken and the run below would prove nothing.');
		process.exit(2);
	}
	await page.route('**/' + spec.file, r => r.fulfill({
		status: 200, contentType: 'application/javascript', body: src.replace(spec.find, spec.with),
	}));
	console.log(`  (running with the app broken: ${BREAK})`);
}

const memText = () => page.$eval('.crystal-memory-ta', el => el.value).catch(() => null);

try {
	await page.goto(process.env.DAIMOND_APP || 'http://localhost:8777', { waitUntil: 'domcontentloaded' });
	await signInAs(s, 'crystalmemory');
	await connectMock(s);
	await page.waitForTimeout(1500);

	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Memory');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(1800);

	const id = await page.evaluate(async () => {
		const m = await import('/pkg/oxedyne_daimond.js');
		const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
		window.__free = app;
		const d = JSON.parse(await app.list_diamonds()).find(x => x.name === 'Memory');
		return d ? d.id : '';
	});
	check('a Diamond to watch', !!id, id);

	// Only the memory is written; the page stays the shipped one.
	await page.evaluate(async (a) => {
		await window.__free.run_tool('file_write', JSON.stringify({
			path: 'diamonds/' + a.id + '/crystal.json', content: a.crystal }));
	}, { id, crystal: JSON.stringify(CRYSTAL) });
	await page.$$eval('.diamond-box', els => els[0] && els[0].click());
	await page.waitForTimeout(2500);

	// ── 1. The disclosure is there, and it holds the memory as it stands.
	const present = await page.$('.crystal-memory');
	check('the crystal face carries a Memory disclosure', !!present);
	const shown = await memText();
	check('and its editor holds the memory as it sits on disk',
		!!shown && shown.indexOf(CRYSTAL.summary) >= 0, JSON.stringify(shown && shown.slice(0, 60)));

	// ── 2. An edit made there and saved persists.
	// Open the disclosure, add a fact carrying the marker, then Save through its button.
	await page.evaluate(() => { const d = document.querySelector('.crystal-memory'); if (d) d.open = true; });
	await page.waitForTimeout(200);
	const edited = JSON.stringify({
		title: CRYSTAL.title,
		summary: CRYSTAL.summary,
		facts: [{ k: 'Added', v: ADDED }],
	}, null, 2);
	await page.$eval('.crystal-memory-ta', (el, v) => {
		el.value = v; el.dispatchEvent(new Event('input', { bubbles: true }));
	}, edited);
	await page.click('.crystal-memory .crystal-act.primary', { force: true });
	await page.waitForTimeout(2000);

	const onDisk = await page.evaluate(a => window.__free.read_crystal_data(a.id), { id });
	check('an edit made in the Memory editor and saved persists',
		!!onDisk && onDisk.indexOf(ADDED) >= 0, JSON.stringify(onDisk && onDisk.slice(0, 80)));

	// ── 3. The saved memory reaches a fresh daimon's system message.
	const wire = await page.evaluate(async (a) => {
		try {
			const w = JSON.parse(await window.__free.wire_system(a.id, '[]', '[]', '[]'));
			return String(w && w.local || '');
		} catch (e) { return 'ERR:' + String(e && e.message || e); }
	}, { id });
	check('and the saved memory is in the system message a fresh daimon is composed with',
		wire.indexOf(ADDED) >= 0, JSON.stringify(wire.slice(0, 100)));

	const errs = errors(s).filter(e => !/502|Bad Gateway|account/i.test(e));
	check('no unexpected console errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'clean');
} catch (e) {
	check('the run completed', false, String((e && e.message) || e));
} finally {
	await s.close?.().catch(() => {});
}

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (BREAK) {
	console.log(bad.length
		? `\nbreak '${BREAK}' produced failures, as it must.`
		: `\nBREAK '${BREAK}' CHANGED NOTHING — the check it targets is not proving anything.`);
}
process.exit(bad.length ? 1 : 0);
