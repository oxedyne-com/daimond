// probe_typstheader.mjs — what the Doc panel's header says while the live view is up.
//
// Not a verifier: it asserts nothing and prints what is on screen, so the two seams
// in `showDoc` and `syncLineNo` can be read off the real panel rather than reasoned
// about from the source.
//
//   eval "$(bash dev/world.sh 13 --env)"
//   node dev/probe_typstheader.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = scratch('pw', 'typstheader');

const MAIN = `#set page(width: 120mm, height: 160mm, margin: 12mm)
#set text(size: 10pt)
= The book
#lorem(200)
#pagebreak()
#lorem(200)
`;

const s = await open({ name: 'typstheader', profile: PROFILE });
const { page } = s;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const look = (tag) => page.evaluate((tag) => {
	const d = (id) => {
		const e = document.getElementById(id);
		return e ? (getComputedStyle(e).display + '/' + (e.style.display || '(unset)')) : 'absent';
	};
	const w = window.DaimondTypstWatch ? window.DaimondTypstWatch.state() : null;
	return {
		tag,
		name:   (document.getElementById('doc-name') || {}).textContent,
		lineno: d('doc-lineno'),
		view:   d('doc-view'),
		embed:  d('doc-embed'),
		live:   !!document.getElementById('typst-live'),
		watch:  w ? { mode: w.mode, path: w.path, drawn: w.drawn } : null,
	};
}, tag);

try {
	await page.waitForTimeout(1200);
	await page.evaluate(async (text) => {
		const m = await import('/pkg/oxedyne_daimond.js');
		await m.write_file('proj/main.typ', text);
		await m.write_file('proj/notes.md', '# notes\n\nsome text\n');
	}, MAIN);
	await page.setViewportSize({ width: 1600, height: 950 });

	await page.evaluate(() => window.DaimondDoc.show('proj/main.typ'));
	await page.waitForTimeout(1200);
	console.log(JSON.stringify(await look('the .typ open in the editor'), null, 1));

	await page.click('[data-act="compile"]', { force: true });
	await sleep(1500);
	console.log(JSON.stringify(await look('just after Compile'), null, 1));

	for (let i = 0; i < 60; i++) {
		const w = await page.evaluate(() => window.DaimondTypstWatch.state());
		if (w.drawn) break;
		await sleep(500);
	}
	await sleep(800);
	console.log(JSON.stringify(await look('live view drawn'), null, 1));

	// Closing the DOC PANEL (not the document) is what ends the watch: the poll
	// finds the panel gone and calls `stop()`, which puts the text view back on
	// display. Nothing re-asks the header what it should be offering.
	await page.click('#panel-doc [data-close="doc"]', { force: true });
	await sleep(2500);
	await page.evaluate(() => window.DaimondPanels.show('doc'));
	await sleep(600);
	console.log(JSON.stringify(await look('doc panel closed and reopened'), null, 1));

	// A second file opened while the live view is up: the text view comes back and
	// the live pages are still in the panel under it.
	await page.evaluate(() => window.DaimondDoc.show('proj/main.typ'));
	await sleep(1200);
	await page.click('[data-act="compile"]', { force: true });
	for (let i = 0; i < 60; i++) {
		const w = await page.evaluate(() => window.DaimondTypstWatch.state());
		if (w.drawn) break;
		await sleep(500);
	}
	await sleep(800);
	await page.evaluate(() => window.DaimondDoc.show('proj/notes.md'));
	await sleep(1200);
	console.log(JSON.stringify(await look('another file opened over the live view'), null, 1));
} finally {
	await s.close();
}
