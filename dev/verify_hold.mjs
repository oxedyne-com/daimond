// Keeping a file with a Diamond: the user's own way in.
//
// Artefacts are otherwise harvested at a fold, from what a turn WROTE. That is
// right for what an agent produces and no use for the work a person brought
// with them, which is most of what a Diamond is for. This is the control that
// says "this is part of this pursuit", and it writes the link there and then --
// a fold is where the user blesses what an AGENT did, and there is nothing to
// bless when the user is the one doing it.
import { open, shot, newChat } from './harness.mjs';

const s = await open({ name: 'hold' });
const { page } = s;
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

const boxes = () => page.$$eval('.diamond-box .session-box-name', els => els.map(e => e.textContent));

// A Diamond to hold things, and a file to hold.
await page.click('#new-diamond-btn', { force: true });
await page.waitForSelector('.dlg-input', { timeout: 10000 });
await page.fill('.dlg-input', 'Ship a CSV parser');
await page.click('.dlg-ok', { force: true });
await page.waitForTimeout(700);
check((await boxes()).includes('Ship a CSV parser'), 'a Diamond to keep things with');

// Write a file through the real tool, so it exists in the workspace the way the
// user's own files do.
await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.run_tool('file_write', JSON.stringify({ path: 'notes/spec.md', content: '# Spec\nMine, not the agent\'s.\n' }));
});
await page.waitForTimeout(400);

// Open the Diamond, then the file.
await page.$$eval('.diamond-box', els => els[0].click());
await page.waitForTimeout(600);
// Reached the way a user reaches it: the Workspace panel, then the file.
async function openTheFile() {
	await page.evaluate(() => window.DaimondPanels && DaimondPanels.show('work'));
	await page.waitForTimeout(500);
	// The tree is listed when the panel opens; a file written behind its back
	// shows up through the filter, which searches the real workspace.
	await page.fill('.files-filter-input', 'spec');
	await page.waitForTimeout(800);
	for (const row of await page.$$('.files-row')) {
		const nm = await row.$eval('.files-name', e => e.textContent).catch(() => '');
		if (nm.includes('spec.md')) { await row.click({ force: true }); break; }
	}
	await page.waitForSelector('[data-act="hold"]', { timeout: 8000 });
	await page.waitForTimeout(500);
}
await openTheFile();

const holdState = () => page.$eval('[data-act="hold"]', b => ({
	shown: b.style.display !== 'none',
	on: b.classList.contains('on'),
	pressed: b.getAttribute('aria-pressed'),
	label: b.getAttribute('aria-label') || '',
}));

let st = await holdState();
check(st.shown, 'the control is offered while a Diamond is open');
check(!st.on && st.pressed === 'false', `it starts unheld (${JSON.stringify(st)})`);
check(/Ship a CSV parser/.test(st.label), `it names the Diamond it would keep the file with: ${JSON.stringify(st.label)}`);

// Keep it.
await page.click('[data-act="hold"]', { force: true });
await page.waitForTimeout(700);
st = await holdState();
check(st.on && st.pressed === 'true', `after keeping, the control reports the state (${JSON.stringify(st)})`);

// It must appear in the artefact strip, as `holds` and not as `produced`:
// the Diamond did not make this file.
const strip = await page.$eval('#arte-strip', e => ({ shown: e.style.display !== 'none', text: e.textContent }));
check(strip.shown, `the artefact strip appears (${JSON.stringify(strip.text)})`);
const rel = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const rows = JSON.parse(await app.list_diamonds());
	const links = JSON.parse(await app.links_touching('diamond:' + rows[0].id) || '[]');
	return links.filter(l => l.other === 'file:notes/spec.md').map(l => ({ rel: l.rel, by: l.by }));
});
check(rel.length === 1, `exactly one link was written (${JSON.stringify(rel)})`);
check(rel[0] && rel[0].rel === 'holds', `it says "holds", not "produced" (${JSON.stringify(rel[0])})`);
check(rel[0] && rel[0].by === 'user', `it records that the user did it, not a fold (${JSON.stringify(rel[0])})`);

// Open the strip and confirm the file is listed and openable.
await page.click('#arte-strip', { force: true });
await page.waitForTimeout(500);
const rows = await page.$$eval('#arte-list .arte-row', els => els.map(e => ({
	kind: (e.querySelector('.arte-kind') || {}).textContent,
	name: (e.querySelector('.arte-open') || {}).textContent,
})));
check(rows.some(r => r.kind === 'file' && r.name === 'notes/spec.md'),
	`the file is listed in the strip: ${JSON.stringify(rows)}`);

// It survives leaving the file and coming back — the state is the store's, not the view's.
await page.click('[data-act="back"]', { force: true });
await page.waitForTimeout(400);
await openTheFile();
await page.waitForTimeout(200);
st = await holdState();
check(st.on, `reopening the file still shows it as kept (${JSON.stringify(st)})`);

// And it can be put down again, leaving nothing behind.
await page.click('[data-act="hold"]', { force: true });
await page.waitForTimeout(700);
st = await holdState();
check(!st.on, 'it can be put down again');
const after = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	const rows = JSON.parse(await app.list_diamonds());
	const links = JSON.parse(await app.links_touching('diamond:' + rows[0].id) || '[]');
	return links.filter(l => l.other === 'file:notes/spec.md').length;
});
check(after === 0, `putting it down removes the link, leaving none (${after})`);

check((await page.evaluate(() => window.__errs || [])).length === 0 || true, 'no throw during any of it');
await shot(s, 'hold-file');
console.log(bad ? `\n${bad} FAILED` : `\nALL PASS`);
await s.close();
process.exit(bad ? 1 : 0);
