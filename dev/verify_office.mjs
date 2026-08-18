// verify_office.mjs — a Word document opens as what it SAYS, and never as a hex dump.
//
// THE DEFECT THIS CLOSES WAS LIVE, NOT MISSING. `oxedyne_fe2o3_stds::media` has
// named `.docx` correctly since it was written -- `Media::Docx`, "Word document"
// -- and `KIND_HANDLERS` in `www/js/viewer.js` had no entry for it. So clicking
// somebody's CV filled the Doc panel with a PAGED HEX DUMP, under a header
// naming the format it had just declined to draw. Every other tier in that file
// exists to stop exactly this, and the commonest document format on earth fell
// through the one gap in the table.
//
// The checks read the RENDERED DOM, on a document THIS PROJECT DID NOT WRITE:
// the fixture is a `.docx` LibreOffice produced from HTML whose content we
// chose, so the intent is ours and the bytes are somebody else's. A verifier
// that rendered our own writer's output would prove that the writer and the
// reader share their assumptions, which is the thing worth doubting.
//
//   * a `.docx` routes to the `office` tier and NOT to `hex`;
//   * its headings arrive as headings and its list as a list, in the DOM;
//   * the panel SAYS it is a reading view, because a rendering that claimed to
//     be the document would be claiming something it cannot do;
//   * an encrypted document is NAMED and falls to the honest floor, rather than
//     being shown as the rubble it decodes to;
//   * and the hex dump is still what an unknown ZIP gets, so the fix routed one
//     format rather than opening a door for every archive.
//
// TO SEE THESE FAIL, break it like this:
//
//   * `viewer.js`, `KIND_HANDLERS`: remove the `Docx: 'office'` line. The first
//     three checks go red and the panel is a hex dump again -- that line IS the
//     defect, and this is it reproduced.
//   * `viewer.js`, `office`: drop the `fileview.office_reading` paragraph and
//     the "says it is a reading view" check goes red.
//   * `wasm/office.rs`, `office_read_docx`: return the markdown without calling
//     `say_undrawn`, and the band check stays green while the app stops being
//     able to tell anyone what it left out. That check is therefore ALSO in the
//     Rust suite, over the counting itself, where breaking it is visible.
//
// Run: node dev/verify_office.mjs

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'office');

let pass = 0, fail = 0;
const check = (ok, name, detail) => {
	if (ok) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name + (detail ? '  — ' + detail : '')); }
};

/// The fixture, shared with the Rust suite so one document is the subject of
/// both. It is LibreOffice's output, not ours.
const FIXTURE = new URL(
	'../../../../../rust/fe2o3/fe2o3_file/tests/data/rich.docx', import.meta.url);
const DOCX = Array.from(fs.readFileSync(FIXTURE));

/// The same writer's output, holding a picture: the one thing in this set a
/// reading view genuinely cannot draw, and therefore the one that proves the
/// band says so rather than merely being able to.
const WITHPIC = Array.from(fs.readFileSync(new URL(
	'../../../../../rust/fe2o3/fe2o3_file/tests/data/withpic.docx', import.meta.url)));

/// A `.xlsx` LibreOffice wrote, holding a formula whose cached value is what
/// everyone sees, a date stored as a serial under a custom number format, and a
/// row that skips two columns.
const XLSX = Array.from(fs.readFileSync(new URL(
	'../../../../../rust/fe2o3/fe2o3_file/tests/data/foreign.xlsx', import.meta.url)));

/// The OpenDocument pair, both written by LibreOffice. They reach the SAME two
/// tiers as their Microsoft counterparts, which is the claim worth checking:
/// what a reader wants out of a text document does not depend on which
/// vocabulary it was written in.
const ODT = Array.from(fs.readFileSync(new URL(
	'../../../../../rust/fe2o3/fe2o3_file/tests/data/foreign.odt', import.meta.url)));
const ODS = Array.from(fs.readFileSync(new URL(
	'../../../../../rust/fe2o3/fe2o3_file/tests/data/foreign.ods', import.meta.url)));

/// The two decks. They are here to prove an ABSENCE: both can be read, and
/// neither may be offered an edit, because a slide is a position on a canvas and
/// changing the words without knowing the geometry puts text over other text.
const PPTX = Array.from(fs.readFileSync(new URL(
	'../../../../../rust/fe2o3/fe2o3_file/tests/data/foreign.pptx', import.meta.url)));
const ODP = Array.from(fs.readFileSync(new URL(
	'../../../../../rust/fe2o3/fe2o3_file/tests/data/foreign.odp', import.meta.url)));

/// The leading bytes of an OLE compound file, which is what an encrypted Office
/// document is: the real document is inside it and there is no password here.
const ENCRYPTED = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
	.concat(new Array(512).fill(0x00));

/// A ZIP that is not an Office document, so the floor is still the floor.
const PLAIN_ZIP = Array.from(Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64'));

const s = await open({ name: 'office', profile: PROFILE, connect: false, defaults: false });
const { page } = s;

const put = (path, bytes) => page.evaluate(async ({ path, bytes }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	await app.write_bytes(path, new Uint8Array(bytes));
}, { path, bytes });

/// Renders one file into a host of this test's own and answers what the probe
/// said, so a check reads the viewer rather than the panel around it.
const view = (path) => page.evaluate(async (path) => {
	let host = document.getElementById('ov-host');
	if (!host) {
		host = document.createElement('div');
		host.id = 'ov-host';
		host.style.cssText = 'position:fixed;left:0;bottom:0;width:520px;height:420px;'
			+ 'display:flex;flex-direction:column;z-index:99999';
		document.body.appendChild(host);
	}
	const info = await window.DaimondViewer.probe(path, {});
	await window.DaimondViewer.show(host, path, info, {
		t: (k, v) => (window.DaimondI18n ? DaimondI18n.t(k, v) : k),
		onError: (e) => { window.__ovLastError = String(e && e.message ? e.message : e); },
	});
	return info;
}, path);

/// What is on screen, read by meaning rather than by the viewer's bookkeeping.
const seen = () => page.evaluate(() => {
	const root = document.querySelector('#ov-host .fileview');
	if (!root) return null;
	const md = root.querySelector('.fv-md');
	const grid = Array.from(root.querySelectorAll('.fv-table tr')).map(
		(tr) => Array.from(tr.children).map((c) => c.textContent));
	return {
		grid: grid,
		sheetNames: Array.from(root.querySelectorAll('.fv-sheetname')).map(n => n.textContent),
		handler:	root.getAttribute('data-viewer'),
		notes:	Array.from(root.querySelectorAll('.fv-note, .fv-warn')).map(n => n.textContent),
		headings:	Array.from(root.querySelectorAll('.fv-md h1, .fv-md h2'))
			.map(n => n.tagName + ':' + n.textContent.trim()),
		items:	Array.from(root.querySelectorAll('.fv-md li')).map(n => n.textContent.trim()),
		links:	Array.from(root.querySelectorAll('.fv-md a')).map(n => n.getAttribute('href')),
		strong:	Array.from(root.querySelectorAll('.fv-md strong')).map(n => n.textContent),
		text:	md ? md.textContent : '',
		hasHex:	!!root.querySelector('.fv-hex, .fv-hexpage'),
		all:	root.textContent,
	};
});

console.log('\n-- a Word document is drawn as what it says --');
await put('office/report.docx', DOCX);
const info = await view('office/report.docx');
const got = await seen();
check(info.media === 'Docx', 'the probe names it a Word document', info.media);
check(!!got && got.handler === 'office', 'and it routes to the office tier, not the hex dump',
	got ? got.handler : 'nothing rendered');
check(!!got && !got.hasHex, 'there is no hex dump on screen', got && got.hasHex ? 'a dump' : '');
check(!!got && got.headings.includes('H1:Quarterly Review'),
	'its title arrives as a heading', got ? JSON.stringify(got.headings) : 'nothing');
check(!!got && got.headings.includes('H2:Findings'),
	'and so does its second-level heading', got ? JSON.stringify(got.headings) : 'nothing');
check(!!got && got.items.some(t => t.startsWith('First finding')),
	'its list arrives as a list', got ? JSON.stringify(got.items.slice(0, 3)) : 'nothing');
check(!!got && got.links.includes('https://example.org/detail'),
	'a link keeps the target the relationships part gave it',
	got ? JSON.stringify(got.links) : 'nothing');
check(!!got && got.strong.some(t => t.indexOf('bold words') !== -1),
	'and bold text is bold rather than a font size',
	got ? JSON.stringify(got.strong) : 'nothing');

console.log('\n-- and it says what it is --');
check(!!got && got.notes.some(t => /reading view/i.test(t)),
	'the panel says this is a reading view, not how the document prints',
	got ? JSON.stringify(got.notes) : 'nothing');
// This fixture has nothing undrawable in it, so the band must NOT invent one.
check(!!got && !got.notes.some(t => /not drawn/i.test(t)),
	'and it claims nothing is missing only when nothing is',
	got ? JSON.stringify(got.notes) : 'nothing');

console.log('\n-- and it says what it could not draw, by name and by count --');
await put('office/withpic.docx', WITHPIC);
await view('office/withpic.docx');
const pic = await seen();
check(!!pic && pic.notes.some(t => /1 thing.*not drawn/i.test(t)),
	'a document with a picture says one thing is not drawn',
	pic ? JSON.stringify(pic.notes) : 'nothing');
check(!!pic && pic.notes.some(t => /1 image/i.test(t)),
	'and names WHAT, because the kind is half the information',
	pic ? JSON.stringify(pic.notes) : 'nothing');
check(!!pic && /Text after the picture/.test(pic.text),
	'the prose after the drawing is still there', pic ? pic.text.slice(0, 120) : 'nothing');

console.log('\n-- a spreadsheet is drawn as the grid it is, with the STORED values --');
await put('office/ledger.xlsx', XLSX);
const xinfo = await view('office/ledger.xlsx');
const grid = await seen();
check(xinfo.media === 'Xlsx', 'the probe names it a spreadsheet', xinfo.media);
check(!!grid && grid.handler === 'sheet', 'and it routes to the sheet tier, not the hex dump',
	grid ? grid.handler : 'nothing rendered');
check(!!grid && !grid.hasHex, 'there is no hex dump on screen', grid && grid.hasHex ? 'a dump' : '');
// Both sheets, because a workbook whose second sheet is silently absent is one a
// person makes a decision on without knowing what they missed.
check(!!grid && grid.sheetNames.join(',') === 'Sales,Notes', 'every sheet is drawn under its name',
	grid ? JSON.stringify(grid.sheetNames) : 'nothing');
// The column letters and row numbers, which are how a person names a cell to
// somebody else and how sheet_read takes a range.
// The guard is `&&`-chained all the way to the indexing, and the DETAIL is too.
// A check that throws where it should report FAIL stops the run, and every later
// check then reports nothing at all -- which reads as a smaller failure than it
// is. Reaching into `grid.grid[0]` in the detail argument did exactly that the
// first time this was driven red.
const head = (grid && grid.grid.length ? grid.grid[0] : []).slice(0, 4);
check(!!grid && grid.grid.length > 1 && head.join('') === 'ABC',
	'the column letters and row numbers are drawn', JSON.stringify(head));
const flat = grid ? grid.grid.map(r => r.join('|')).join('\n') : '';
check(/North\|120\|3\.4\|408\b/.test(flat), 'a formula shows the value STORED in the file',
	flat.split('\n').slice(0, 4).join(' / '));
check(!/B2\*C2/.test(flat), 'and never the formula in place of it',
	flat.indexOf('B2*C2') !== -1 ? 'the formula is in the grid' : '');
// The date trap: a serial with no style applied would read as 46095.
check(/2026-03-14/.test(flat), 'a date is a date and not a five-digit number',
	/46095/.test(flat) ? 'the serial number is on screen' : flat.slice(0, 80));
check(/Total\|\|\|1343/.test(flat), 'a row that skips columns keeps its alignment',
	flat.split('\n').find(l => l.indexOf('Total') !== -1) || 'no total row');
check(!!grid && grid.notes.some(t => /not recalculated/i.test(t)),
	'and the panel says the values are stored rather than computed',
	grid ? JSON.stringify(grid.notes) : 'nothing');

console.log('\n-- and OpenDocument reaches the same two tiers --');
await put('office/report.odt', ODT);
const oinfo = await view('office/report.odt');
const odt = await seen();
check(oinfo.media === 'Odt', 'a .odt is named as one and not as a bare archive', oinfo.media);
check(!!odt && odt.handler === 'office', 'and it goes to the same tier a .docx does',
	odt ? odt.handler : 'nothing rendered');
check(!!odt && odt.headings.includes('H1:A Report On Something'),
	'its headings arrive as headings', odt ? JSON.stringify(odt.headings) : 'nothing');
check(!!odt && odt.strong.some(t => t.indexOf('bold words') !== -1),
	'and its bold text is bold -- which needs the style resolved by its PROPERTIES',
	odt ? JSON.stringify(odt.strong) : 'nothing');
check(!!odt && odt.items.some(t => t.startsWith('First bullet')),
	'its list arrives as a list', odt ? JSON.stringify(odt.items.slice(0, 2)) : 'nothing');

await put('office/ledger.ods', ODS);
const sinfo = await view('office/ledger.ods');
const ods = await seen();
check(sinfo.media === 'Ods', 'a .ods is named as one, from its own opening bytes', sinfo.media);
check(!!ods && ods.handler === 'sheet', 'and it goes to the same tier a .xlsx does',
	ods ? ods.handler : 'nothing rendered');
const oflat = ods ? ods.grid.map(r => r.join('|')).join('\n') : '';
check(/North\|120\|3\.4\|408\b/.test(oflat), 'showing the value STORED in the file',
	oflat.split('\n').slice(0, 4).join(' / '));
check(/2026-03-14/.test(oflat), 'and a date rather than a serial number', oflat.slice(0, 80));

// A file somebody renamed is still what it is: the format is read from the
// archive's own `mimetype` member, which OpenDocument requires to be first and
// stored for exactly this purpose.
await put('office/holiday.zip', ODT);
const renamed = await view('office/holiday.zip');
check(renamed.media === 'Odt', 'a renamed .odt is still a .odt, by its own bytes', renamed.media);

console.log('\n-- what cannot be read is named, not guessed at --');
await put('office/secret.docx', ENCRYPTED);
await view('office/secret.docx');
const enc = await seen();
check(!!enc && /encrypted/i.test(enc.all),
	'an encrypted document says it is encrypted', enc ? enc.all.slice(0, 160) : 'nothing');
check(!!enc && enc.hasHex,
	'and falls to the honest floor rather than a blank panel', enc ? 'no dump' : 'nothing');

console.log('\n-- the floor is still the floor --');
await put('office/plain.zip', PLAIN_ZIP);
const zinfo = await view('office/plain.zip');
const zip = await seen();
check(zinfo.media === 'Zip', 'an ordinary archive is still an ordinary archive', zinfo.media);
check(!!zip && zip.handler === 'hex',
	'and it is shown as its bytes, so one format was routed and not every archive',
	zip ? zip.handler : 'nothing rendered');

const table = await page.evaluate(() => window.DaimondViewer.KIND_HANDLERS);
check(table.Docx === 'office', 'the table routes Docx', 'KIND_HANDLERS.Docx = ' + table.Docx);
check(table.Xlsx === 'sheet', 'and Xlsx, now that one can genuinely be read',
	'KIND_HANDLERS.Xlsx = ' + table.Xlsx);
check(table.Odt === 'office' && table.Ods === 'sheet',
	'and the OpenDocument pair share those two tiers',
	'Odt = ' + table.Odt + ', Ods = ' + table.Ods);
// Both CAN be read; what they lack is a tier that draws slides rather than
// paragraphs, and the wording for one. Until that exists the dump is the honest
// answer, because it tells a person that nothing was interpreted for them.
check(!table.Pptx && !table.Odp,
	'and neither presentation format is claimed yet: a handler that opens and then apologises '
	+ 'is worse than the dump',
	'Pptx = ' + table.Pptx + ', Odp = ' + table.Odp);

// ── AND WHAT A READER MAY DO TO IT ───────────────────────────────────
//
// Reading was the whole of it. `office_write_docx` and `office_write_left` were
// exported from the wasm with NO CALLER IN `www/js/` AT ALL: the app could turn
// Markdown into a real document, and nothing a person could press asked it to.
// That is the third time this project has listed a capability as done with no
// production caller, so these checks are about REACH first and correctness
// second -- a control that is absent, or 0x0, or wired to nothing, is the defect.
//
// TO SEE THESE FAIL:
//
//   * `viewer.js`, `actions`: return before appending `save`. Every "a copy
//     reaches the user" check goes red.
//   * `viewer.js`, `markdown`: drop the `saveAsRow` call and the writer has no
//     caller again -- which is the state this section was written against.
//   * `viewer.js`, `KIND_HANDLERS`: add `Pptx: 'office'` and the routing check
//     goes red. `EDIT_DOOR`: add `Pptx` and the table check goes red. Neither
//     break moves the OTHER one, and that is why both are here: a deck reaches
//     no reading tier, so it reaches no controls, so a DOM check alone would
//     stay green while an editor sat waiting behind a routing line one commit
//     from changing.

const SOFFICE = '/usr/bin/soffice';

/// Click `sel` if it is on screen, and say whether it was. A check that THROWS
/// where it should report FAIL stops the run, and every later check then reports
/// nothing at all -- which reads as a smaller failure than it is. This file
/// already carries that lesson about an index into a grid; a control that has
/// been removed is the same trap wearing a different hat.
const clickIf = async (sel) => {
	if (!(await page.$(sel))) return false;
	await page.click(sel);
	return true;
};

/// Fill `sel` if it is on screen.
const fillIf = async (sel, text) => {
	if (!(await page.$(sel))) return false;
	await page.fill(sel, text);
	return true;
};

/// The bytes of the next download, and the name the browser was given.
const saved = async (click) => {
	const wait = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
	if (!(await click())) return null;
	const dl = await wait;
	if (!dl) return null;
	const out = scratch('office-out', dl.suggestedFilename());
	await dl.saveAs(out);
	return { name: dl.suggestedFilename(), bytes: fs.readFileSync(out), path: out };
};

/// What LibreOffice reads out of a file this code wrote. THE ORACLE: a verifier
/// that read our own output back with our own reader would prove the writer and
/// the reader share their assumptions, which is the thing worth doubting.
const oracleText = (file) => {
	const dir = scratch('office-lo', 'out');
	fs.mkdirSync(dir, { recursive: true });
	const r = spawnSync(SOFFICE, ['--headless',
		'-env:UserInstallation=file://' + scratch('office-lo', 'profile'),
		'--convert-to', 'txt:Text', file, '--outdir', dir], { timeout: 180000 });
	if (r.status !== 0) return null;
	const txt = path.join(dir, path.basename(file).replace(/\.[^.]+$/, '.txt'));
	return fs.existsSync(txt) ? fs.readFileSync(txt, 'utf8') : null;
};

/// What LibreOffice makes of a workbook this code wrote. CSV rather than text
/// because a cell is the unit: the conversion recalculates on load, so a formula
/// written with unbracketed references comes back as `Err:510` here and as a
/// perfectly good stored number in any reader of ours.
const oracleCsv = (file) => {
	const dir = scratch('office-lo', 'csv');
	fs.mkdirSync(dir, { recursive: true });
	const r = spawnSync(SOFFICE, ['--headless',
		'-env:UserInstallation=file://' + scratch('office-lo', 'profile'),
		'--convert-to', 'csv:Text - txt - csv (StarCalc)', file, '--outdir', dir],
		{ timeout: 180000 });
	if (r.status !== 0) return null;
	const out = path.join(dir, path.basename(file).replace(/\.[^.]+$/, '.csv'));
	return fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
};

/// The controls on screen, with their measured boxes. A control the DOM has and
/// the screen does not is the failure `daimond.js:8323` records, and reading
/// `querySelector` alone would report it as present.
const controls = () => page.evaluate(() => {
	const root = document.querySelector('#ov-host .fileview');
	if (!root) return null;
	const box = (n) => { const r = n.getBoundingClientRect();
		return { text: n.textContent, w: Math.round(r.width), h: Math.round(r.height) }; };
	const row = root.querySelector('.fv-editrow');
	return {
		save: Array.from(root.querySelectorAll('.fv-save')).map(box),
		edit: Array.from(root.querySelectorAll('.fv-edit')).map(box),
		row:  row ? { hidden: row.hidden, fields:
			Array.from(row.querySelectorAll('[data-edit]')).map(n => n.getAttribute('data-edit')) } : null,
	};
});

console.log('\n-- a copy of the document reaches the user --');
await view('office/report.docx');
const dcon = await controls();
check(!!dcon && dcon.save.length === 1, 'a text document offers to save a copy',
	dcon ? JSON.stringify(dcon.save) : 'nothing rendered');
// NOT `querySelector` alone. A settings-pane control that could not be found on
// screen is already recorded in this tree, and a lane put a switch in the same
// place last session and had to move it.
check(!!dcon && dcon.save[0] && dcon.save[0].w > 40 && dcon.save[0].h > 12,
	'and the control has a box on screen rather than being 0x0',
	dcon && dcon.save[0] ? dcon.save[0].w + 'x' + dcon.save[0].h : 'no button');
const copy = await saved(() => clickIf('#ov-host .fv-save'));
check(!!copy, 'pressing it hands a file over', copy ? copy.name : 'no download');
check(!!copy && copy.name === 'report.docx', 'under the name it already had', copy ? copy.name : '');
// THE SAME BYTES. An unedited save is the file, not a re-encoding of it: the
// contract's whole rule about a stranger's document surviving intact is void if
// the copy is already different before anybody has edited anything.
check(!!copy && copy.bytes.length === DOCX.length
	&& Buffer.compare(copy.bytes, Buffer.from(DOCX)) === 0,
	'and the copy is the file, byte for byte, not a re-encoding of it',
	copy ? copy.bytes.length + ' vs ' + DOCX.length : 'no download');

await view('office/ledger.xlsx');
const scon = await controls();
check(!!scon && scon.save.length === 1, 'a spreadsheet offers the same',
	scon ? JSON.stringify(scon.save) : 'nothing rendered');

console.log('\n-- and Markdown becomes a real document --');
const MD = '# Quarterly Review\n\nAn opening paragraph with **bold words**.\n\n'
	+ '## Findings\n\n- First finding\n- Second finding\n';
await put('office/notes.md', Array.from(Buffer.from(MD)));
await view('office/notes.md');
const mcon = await controls();
check(!!mcon && mcon.save.length >= 1,
	'a Markdown file offers to be written out as a document — the writer had no caller at all',
	mcon ? JSON.stringify(mcon.save.map(b => b.text)) : 'nothing rendered');
check(!!mcon && mcon.save.some(b => b.w > 40 && b.h > 12),
	'and that control has a box on screen too',
	mcon ? JSON.stringify(mcon.save) : 'nothing');
// The FORMAT IS CHOSEN and then one control saves it. Six buttons became one
// picker plus one button: six labels in eight languages, and 1400px of chrome
// above a document that is 380px wide on a phone.
const chooseFmt = async (media) => {
	if (!(await page.$('#ov-host [data-media-pick]'))) return false;
	await page.selectOption('#ov-host [data-media-pick]', media);
	return true;
};
await chooseFmt('Docx');
const doc = await saved(() => clickIf('#ov-host .fv-save'));
check(!!doc, 'pressing it hands a document over', doc ? doc.name : 'no download');
check(!!doc && doc.name === 'notes.docx',
	'named after the text it came from, with the document’s own suffix', doc ? doc.name : '');
check(!!doc && doc.bytes.length > 1000 && doc.bytes[0] === 0x50 && doc.bytes[1] === 0x4B,
	'and it is a real ZIP, not text with a new name',
	doc ? doc.bytes.length + ' bytes, starts ' + doc.bytes.slice(0, 2).toString('hex') : '');

// THE EXTERNAL ORACLE. LibreOffice is not ours and did not write this file; if
// it can read the heading, the bold run and the list back out, a real reader
// agrees with what the app claims to have written.
if (doc && fs.existsSync(SOFFICE)) {
	const read = oracleText(doc.path);
	check(!!read && /Quarterly Review/.test(read),
		'LibreOffice reads the heading back out of it', read ? read.slice(0, 60) : 'no conversion');
	check(!!read && /bold words/.test(read),
		'and the prose', read ? read.slice(0, 80) : 'no conversion');
	check(!!read && /First finding/.test(read) && /Second finding/.test(read),
		'and both list items', read ? JSON.stringify(read.slice(0, 120)) : 'no conversion');
} else {
	console.log('  --   LibreOffice is not on this machine; the oracle checks did not run');
}

await chooseFmt('Odt');
const opendoc = await saved(() => clickIf('#ov-host .fv-save'));
if (opendoc) {
	check(opendoc.name === 'notes.odt', 'and the same text becomes an OpenDocument too', opendoc.name);
	if (fs.existsSync(SOFFICE)) {
		const read = oracleText(opendoc.path);
		check(!!read && /Quarterly Review/.test(read) && /First finding/.test(read),
			'which LibreOffice reads back with its heading and its list',
			read ? JSON.stringify(read.slice(0, 90)) : 'no conversion');
	}
} else {
	console.log('  --   office_write is not in this bundle, so only Word is offered');
}

console.log('\n-- and it says what the document does NOT carry, per kind and per name --');
// `office_write_left` used to hand back a finished English sentence, which was the
// one string in this panel a translation pass could not reach -- in a file whose
// own header says it holds none. It now answers `[{kind, n, names}]` and the panel
// composes the wording, exactly as the reading view does for `undrawn`.
//
// `names` is what `undrawn` has no equivalent for: a document being READ has no
// source names for what it could not draw, and Markdown does -- they are paths the
// author wrote. So the picture can be NAMED rather than counted.
const withPic = '# Trip\n\n![The harbour](photos/harbour.png)\n\nSome prose.\n';
await put('office/withpic.md', Array.from(Buffer.from(withPic)));
await view('office/withpic.md');
const shapes = await page.evaluate(async ({ md }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const out = {};
	for (const media of ['Docx', 'Odt', 'Xlsx', 'Ods', 'Pptx', 'Odp']) {
		try { out[media] = m.office_write_left(md, media); }
		catch (e) { out[media] = 'threw: ' + e.message; }
	}
	return out;
}, { md: withPic });
check(shapes.Docx !== null && Array.isArray(shapes.Docx),
	'a Word document reports what it leaves out as a LIST, not a sentence',
	JSON.stringify(shapes.Docx));
check(Array.isArray(shapes.Docx) && shapes.Docx.length === 1
	&& shapes.Docx[0].kind === 'image' && shapes.Docx[0].n === 1,
	'one image, named by kind and counted', JSON.stringify(shapes.Docx));
// The names are the AUTHOR'S OWN PATHS out of their Markdown, so the sentence can
// say which picture rather than how many.
check(Array.isArray(shapes.Docx) && shapes.Docx[0].names
	&& shapes.Docx[0].names.join(',').indexOf('harbour') !== -1,
	'and the source it was written with, so the sentence can name it',
	JSON.stringify(shapes.Docx[0].names));
check(shapes.Xlsx === null && shapes.Ods === null,
	'a spreadsheet written from prose has nothing to say and says nothing',
	JSON.stringify({ Xlsx: shapes.Xlsx, Ods: shapes.Ods }));
// NO ENGLISH ANYWHERE IN THE ANSWER. That is the whole of the change: a phrase
// built in Rust is English no locale can reach.
const flatShape = JSON.stringify(shapes);
check(!/is not carried|are not carried|image is|images are/.test(flatShape),
	'and none of it is an English sentence built in Rust', flatShape.slice(0, 200));

// The panel's own wording, composed from that shape, on screen.
const leftSaid = await (async () => {
	await view('office/withpic.md');
	await page.selectOption('#ov-host [data-media-pick]', 'Docx');
	const got = await saved(() => clickIf('#ov-host .fv-save'));
	return { file: got, notes: await page.evaluate(() =>
		Array.from(document.querySelectorAll('#ov-host .fv-bar ~ .fv-note, #ov-host .fv-bar ~ .fv-warn'))
			.filter(n => !n.hidden).map(n => n.textContent).join(' | ')) };
})();
check(!!leftSaid.file, 'the picker writes the format that is chosen',
	leftSaid.file ? leftSaid.file.name : 'no download');
check(/image/i.test(leftSaid.notes) && /harbour/.test(leftSaid.notes),
	'and the panel says one image did not reach the document, and which',
	leftSaid.notes.slice(0, 200));
check(!/\{n\}|\{names\}|\{parts\}/.test(leftSaid.notes),
	'with every placeholder filled — a raw {n} on screen is the composition failing',
	leftSaid.notes.slice(0, 160));

// A deck reports unwritten speaker's notes, which the old English never mentioned
// at all. Reachable only because all six formats are offered from prose.
const deckMd = '# One\n\nFirst slide.\n\n# Two\n\nSecond slide.\n';
const deckLeft = await page.evaluate(async ({ md }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	try { return m.office_write_left(md, 'Pptx'); } catch (e) { return 'threw: ' + e.message; }
}, { md: deckMd });
check(deckLeft === null || Array.isArray(deckLeft),
	'a deck answers the same shape', JSON.stringify(deckLeft));

console.log('\n-- the six formats a picker offers, and what a refusal says --');
const picker = await page.evaluate(() => {
	const sel = document.querySelector('#ov-host [data-media-pick]');
	if (!sel) return null;
	const r = sel.getBoundingClientRect();
	return { values: Array.from(sel.options).map(o => o.value),
		labels: Array.from(sel.options).map(o => o.textContent),
		w: Math.round(r.width), h: Math.round(r.height),
		aria: sel.getAttribute('aria-label') };
});
check(!!picker && picker.values.join(',') === 'Docx,Odt,Xlsx,Ods,Pptx,Odp',
	'all six formats the writer supports are offered from prose',
	picker ? picker.values.join(',') : 'no picker');
check(!!picker && picker.w > 40 && picker.h > 12,
	'the picker has a box on screen', picker ? picker.w + 'x' + picker.h : 'no picker');
// One control, not six buttons: six would be about 1400px of chrome above a
// document that is 380px wide on a phone, and six labels in eight languages.
const savers = await page.evaluate(() =>
	document.querySelectorAll('#ov-host .fv-save').length);
check(savers === 1, 'through ONE control rather than one button per format',
	savers + ' save control(s)');
check(!!picker && !!picker.aria,
	'and the picker has an accessible name', picker ? String(picker.aria) : '');
// The labels come from the open `fileview.fmt.` family, which is why six formats
// cost one new key rather than eight.
check(!!picker && picker.labels.some(l => /Word/.test(l))
	&& picker.labels.some(l => /OpenDocument/.test(l)),
	'named from the library\'s own labels, through the family the header reads',
	picker ? JSON.stringify(picker.labels) : '');

console.log('\n-- a deck gets neither control, and not by an `if` --');
await put('office/deck.pptx', PPTX);
const pinfo = await view('office/deck.pptx');
const pcon = await controls();
check(pinfo.media === 'Pptx', 'a .pptx is named as one', pinfo.media);
check(!!pcon && pcon.save.length === 0 && pcon.edit.length === 0,
	'and offers neither save nor edit: a slide is a position on a canvas',
	pcon ? JSON.stringify(pcon) : 'nothing rendered');
await put('office/deck.odp', ODP);
await view('office/deck.odp');
const ocon = await controls();
check(!!ocon && ocon.save.length === 0 && ocon.edit.length === 0,
	'nor does the OpenDocument deck', ocon ? JSON.stringify(ocon) : 'nothing rendered');
// AND THE SECOND LOCK, ON ITS OWN. The two checks above are the observable
// consequence of the ROUTING table -- a deck reaches no reading tier, so it
// reaches no controls either -- and they would stay green if somebody gave a
// deck an editor without also routing it. That is two locks a test can only see
// together, which is one lock. This reads the table itself.
const door = await page.evaluate(() => window.DaimondViewer.EDIT_DOOR);
check(!!door && !door.Pptx && !door.Odp,
	'and no deck has an editor in the table either: an edit that changes the words '
	+ 'without knowing the geometry puts text over other text',
	'Pptx = ' + (door && door.Pptx) + ', Odp = ' + (door && door.Odp));
check(!!door && door.Docx === 'office_edit_doc' && door.Odt === 'office_edit_doc'
	&& door.Xlsx === 'office_edit_sheet' && door.Ods === 'office_edit_sheet',
	'while the four formats the contract allows each name their own door',
	JSON.stringify(door));
const doors = await page.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	return ['office_write', 'office_write_docx', 'office_write_left',
		'office_edit_doc', 'office_edit_sheet'].filter(n => typeof m[n] === 'function');
});
console.log('  --   wasm doors in this bundle: ' + (doors.join(', ') || 'none'));

console.log('\n-- and an edit is applied to the archive, not to a rendering of it --');
if (doors.indexOf('office_edit_doc') !== -1) {
	await view('office/report.docx');
	await clickIf('#ov-host .fv-edit');
	const opened = await controls();
	check(!!opened && opened.row && !opened.row.hidden,
		'the edit control opens a row of fields', opened ? JSON.stringify(opened.row) : 'nothing');
	check(!!opened && opened.row && opened.row.fields.join(',') === 'find,replace,nth,apply',
		'find, replace, which one, and apply',
		opened && opened.row ? opened.row.fields.join(',') : 'no row');
	await fillIf('#ov-host [data-edit="find"]', 'Findings');
	await fillIf('#ov-host [data-edit="replace"]', 'Conclusions');
	await clickIf('#ov-host [data-edit="apply"]');
	await page.waitForTimeout(300);
	const done = await seen();
	check(!!done && done.headings.includes('H2:Conclusions'),
		'the word is changed, read back out of the archive the editor produced',
		done ? JSON.stringify(done.headings) : 'nothing');
	check(!!done && done.notes.some(t => /has not changed/i.test(t)),
		'and the panel says the file itself has not changed',
		done ? JSON.stringify(done.notes) : 'nothing');
	const edited = await saved(() => clickIf('#ov-host .fv-save'));
	check(!!edited && edited.bytes.length > 1000,
		'saving now hands over the EDITED bytes', edited ? edited.bytes.length + ' bytes' : 'no download');
	if (edited && fs.existsSync(SOFFICE)) {
		const read = oracleText(edited.path);
		check(!!read && /Conclusions/.test(read) && !/Findings/.test(read),
			'and LibreOffice reads the change out of the saved copy',
			read ? JSON.stringify(read.slice(0, 120)) : 'no conversion');
		check(!!read && /Quarterly Review/.test(read),
			'while the rest of the document is still there', read ? read.slice(0, 60) : 'no conversion');
	}
	// An unmatched `find` is an error naming the string, never a silent no-op.
	await fillIf('#ov-host [data-edit="find"]', 'nothing in this document says this');
	await clickIf('#ov-host [data-edit="apply"]');
	await page.waitForTimeout(200);
	const missed = await page.evaluate(() =>
		Array.from(document.querySelectorAll('#ov-host .fv-warn')).map(n => n.textContent).join(' | '));
	check(/not made/i.test(missed) && /nothing in this document says this/.test(missed),
		'a find that matches nothing is refused, and the string is named',
		missed.slice(0, 160) || 'nothing said');
} else {
	check(false, 'office_edit_doc is in the bundle',
		'not built yet — the client half is checked below against a stand-in');
}

console.log('\n-- and a cell is written into the workbook, not into a copy of the grid --');
if (doors.indexOf('office_edit_sheet') !== -1) {
	// ODS, because OpenFormula is where the trap is: a reference written
	// unbracketed makes LibreOffice recalculate and store `Err:510` over the
	// value. Only a real reader can say whether it happened, which is why this
	// check ends in LibreOffice and not in our own reader.
	await put('office/foreign.ods', ODS);
	await view('office/foreign.ods');
	await clickIf('#ov-host .fv-edit');
	await fillIf('#ov-host [data-edit="ref"]', 'a9');
	await fillIf('#ov-host [data-edit="value"]', 'Edited here');
	await clickIf('#ov-host [data-edit="apply"]');
	await page.waitForTimeout(400);
	const cells = await seen();
	const flat9 = cells ? cells.grid.map(r => r.join('|')).join('\n') : '';
	check(/Edited here/.test(flat9),
		'a value lands in the cell that was named, read back out of the workbook',
		flat9.split('\n').slice(0, 12).join(' / '));
	await fillIf('#ov-host [data-edit="ref"]', 'b9');
	await fillIf('#ov-host [data-edit="value"]', '=B2*C2');
	await clickIf('#ov-host [data-edit="apply"]');
	await page.waitForTimeout(400);
	const book = await saved(() => clickIf('#ov-host .fv-save'));
	check(!!book && book.name === 'foreign.ods', 'and the workbook saves as itself',
		book ? book.name : 'no download');
	if (book && fs.existsSync(SOFFICE)) {
		const csv = oracleCsv(book.path);
		check(!!csv && /Edited here/.test(csv),
			'LibreOffice reads the written value out of the saved workbook',
			csv ? JSON.stringify(csv.slice(0, 120)) : 'no conversion');
		// THE WHOLE POINT OF THIS SECTION. `Err:510` is what LibreOffice stores
		// when it recalculates a formula whose references were not bracketed, and
		// it is invisible to any reader of ours that shows the STORED value.
		check(!!csv && !/Err:5\d\d/.test(csv),
			'and the formula is not Err:510 — OpenFormula wants of:=[.B2]*[.C2]',
			csv ? (csv.match(/Err:\d+/) || ['no error'])[0] : 'no conversion');
		check(!!csv && /\b408\b/.test(csv),
			'it computes 408, which is 120 x 3.4 out of the cells it points at',
			csv ? JSON.stringify(csv.slice(0, 200)) : 'no conversion');
	}
	// A sheet the workbook has not got is an error naming what it has, and the
	// bytes are left alone.
	await fillIf('#ov-host [data-edit="ref"]', 'ZZZ99999');
	await fillIf('#ov-host [data-edit="value"]', 'x');
	await clickIf('#ov-host [data-edit="apply"]');
	await page.waitForTimeout(200);
} else {
	check(false, 'office_edit_sheet is in the bundle', 'not built yet');
}

console.log('\n-- and the panel’s own wiring, with the editor stood in for --');
// WHAT THIS PROVES AND WHAT IT DOES NOT. The stand-in returns the bytes of a
// DIFFERENT real document, so it proves the panel hands over the file, takes
// what comes back, re-READS it and redraws from the archive rather than
// painting the replacement into the old markdown. It proves nothing whatever
// about the editor, which is checked above, in the Rust suite, and against
// LibreOffice. It is here so the client half is provable while the wasm half is
// still being built, and it stays afterwards because it is the half that breaks
// when somebody rearranges this file.
const viewStandIn = (path, replacement) => page.evaluate(async ({ path, replacement }) => {
	const real = await import('/pkg/oxedyne_daimond.js');
	const stand = {};
	for (const k of Object.keys(real)) stand[k] = real[k];
	window.__editCalls = [];
	stand.office_edit_doc = function (bytes, media, edits) {
		window.__editCalls.push({ media: media, edits: edits, given: bytes.length });
		return new Uint8Array(replacement);
	};
	let host = document.getElementById('ov-host');
	const info = await window.DaimondViewer.probe(path, { wasm: stand });
	await window.DaimondViewer.show(host, path, info, {
		wasm: stand,
		t: (k, v) => (window.DaimondI18n ? DaimondI18n.t(k, v) : k),
	});
	return info;
}, { path, replacement });

await viewStandIn('office/report.docx', WITHPIC);
const wcon = await controls();
check(!!wcon && wcon.edit.length === 1,
	'the edit control appears exactly when the wasm door behind it does',
	wcon ? JSON.stringify(wcon.edit) : 'nothing rendered');
check(!!wcon && wcon.edit[0] && wcon.edit[0].w > 40 && wcon.edit[0].h > 12,
	'and it has a box on screen', wcon && wcon.edit[0]
		? wcon.edit[0].w + 'x' + wcon.edit[0].h : 'no button');
await clickIf('#ov-host .fv-edit');
const wrow = await controls();
check(!!wrow && wrow.row && !wrow.row.hidden, 'pressing it opens the fields',
	wrow ? JSON.stringify(wrow.row) : 'nothing');
const rowBox = await page.evaluate(() => {
	const r = document.querySelector('#ov-host .fv-editrow').getBoundingClientRect();
	return { w: Math.round(r.width), h: Math.round(r.height) };
});
check(rowBox.w > 100 && rowBox.h > 12, 'and the row itself is on screen, not 0x0',
	rowBox.w + 'x' + rowBox.h);
await fillIf('#ov-host [data-edit="find"]', 'Findings');
await fillIf('#ov-host [data-edit="replace"]', 'Conclusions');
await fillIf('#ov-host [data-edit="nth"]', '2');
await clickIf('#ov-host [data-edit="apply"]');
await page.waitForTimeout(300);
const calls = await page.evaluate(() => window.__editCalls);
check(calls.length === 1, 'apply calls the editor once', JSON.stringify(calls.map(c => c.given)));
check(calls.length === 1 && calls[0].media === 'Docx',
	'with the media label the reader was given', calls.length ? calls[0].media : '');
check(calls.length === 1 && calls[0].given === DOCX.length,
	'and the WHOLE archive, because the edit is made in the archive',
	calls.length ? calls[0].given + ' of ' + DOCX.length : '');
const sentEdits = calls.length ? JSON.parse(calls[0].edits) : [];
check(sentEdits.length === 1 && sentEdits[0].find === 'Findings'
	&& sentEdits[0].replace === 'Conclusions' && sentEdits[0].nth === 2,
	'the edits are the contract’s own shape, with `nth` 1-based',
	JSON.stringify(sentEdits));
const after = await seen();
check(!!after && /Text after the picture/.test(after.text),
	'and the panel redraws from what came BACK, not from what it already had',
	after ? after.text.slice(0, 100) : 'nothing');
check(!!after && after.notes.some(t => /has not changed/i.test(t)),
	'saying the file itself has not changed', after ? JSON.stringify(after.notes) : 'nothing');
const standCopy = await saved(() => clickIf('#ov-host .fv-save'));
check(!!standCopy && standCopy.bytes.length === WITHPIC.length,
	'and saving hands over the bytes the editor returned, not the ones it was given',
	standCopy ? standCopy.bytes.length + ' vs ' + WITHPIC.length + ' / ' + DOCX.length : 'no download');

// `nth` absent means EVERY occurrence, which is the format's rule; a blank box
// must therefore send no `nth` rather than a zero.
await viewStandIn('office/report.docx', WITHPIC);
await clickIf('#ov-host .fv-edit');
await fillIf('#ov-host [data-edit="find"]', 'Findings');
await clickIf('#ov-host [data-edit="apply"]');
await page.waitForTimeout(200);
const blank = await page.evaluate(() => JSON.parse(window.__editCalls[0].edits));
check(blank.length === 1 && !('nth' in blank[0]),
	'a blank “which one” sends no `nth` at all, which is what means every one',
	JSON.stringify(blank));

console.log('\n-- a cell is named the way the workbook names it --');
const viewSheetStandIn = (path) => page.evaluate(async (path) => {
	const real = await import('/pkg/oxedyne_daimond.js');
	const stand = {};
	for (const k of Object.keys(real)) stand[k] = real[k];
	window.__sheetCalls = [];
	stand.office_edit_sheet = function (bytes, media, edits) {
		window.__sheetCalls.push({ media: media, edits: edits });
		return bytes;			// unchanged, so the redraw is the same workbook
	};
	const host = document.getElementById('ov-host');
	const info = await window.DaimondViewer.probe(path, { wasm: stand });
	await window.DaimondViewer.show(host, path, info, {
		wasm: stand,
		t: (k, v) => (window.DaimondI18n ? DaimondI18n.t(k, v) : k),
	});
	return info;
}, path);

await viewSheetStandIn('office/ledger.xlsx');
await clickIf('#ov-host .fv-edit');
const sheetRow = await page.evaluate(() => {
	const r = document.querySelector('#ov-host .fv-editrow');
	const sel = r.querySelector('[data-edit="sheet"]');
	return { fields: Array.from(r.querySelectorAll('[data-edit]')).map(n => n.getAttribute('data-edit')),
		sheets: sel ? Array.from(sel.options).map(o => o.value) : [] };
});
check(sheetRow.fields.join(',') === 'sheet,ref,value,apply',
	'a spreadsheet asks for a sheet, a cell and a value', sheetRow.fields.join(','));
// The tab names are read OFF THE FILE. A sheet name is the one part of a cell
// reference nobody can guess, and a free-text box for it is a box people get
// wrong.
check(sheetRow.sheets.join(',') === 'Sales,Notes',
	'and the sheet names come off the workbook rather than being typed',
	JSON.stringify(sheetRow.sheets));
await fillIf('#ov-host [data-edit="ref"]', 'b2');
await fillIf('#ov-host [data-edit="value"]', '3.5');
await clickIf('#ov-host [data-edit="apply"]');
await page.waitForTimeout(200);
const cell = await page.evaluate(() => JSON.parse(window.__sheetCalls[0].edits));
check(cell.length === 1 && cell[0].sheet === 'Sales' && cell[0].ref === 'B2'
	&& cell[0].value === '3.5' && !('formula' in cell[0]),
	'an ordinary value goes as a value, and the reference is upper-cased',
	JSON.stringify(cell));
await fillIf('#ov-host [data-edit="value"]', '=B2*C2');
await clickIf('#ov-host [data-edit="apply"]');
await page.waitForTimeout(200);
const formula = await page.evaluate(() => JSON.parse(window.__sheetCalls[1].edits));
check(formula.length === 1 && formula[0].formula === '=B2*C2' && !('value' in formula[0]),
	'and a leading “=” makes it a formula — the convention every spreadsheet already taught',
	JSON.stringify(formula));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
await s.close();
process.exit(fail ? 1 : 0);
