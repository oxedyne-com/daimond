// verify_doc.mjs — where a document goes when you open it.
//
// The rule this asserts, which was decided rather than inherited:
//
//   The stage holds what you are ATTENDING to -- a web page, a mail message, a
//   document. The dock holds AMBIENT state you want in the corner of your eye,
//   including the file tree. So a file tree is dock furniture and a file you
//   have opened is stage furniture, whatever format it happens to be in.
//
// Before this, text opened inside the ~260px Workspace tile and only a compiled
// PDF reached the wide Doc panel -- a split by file format, which is a fact
// about the implementation and not about the reader. Worse, opening a file hid
// the tree to make room, so reading cost you your bearings.
//
//   node dev/verify_doc.mjs

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as H from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [];
async function waitFor(fn, ms = 15000, gap = 300) {
	const t0 = Date.now();
	for (;;) {
		try { if (await fn()) return true; } catch (e) {}
		if (Date.now() - t0 > ms) return false;
		await sleep(gap);
	}
}
function cleanup(s) {
	if (s) { try { s.browser.close(); } catch (e) {} }
	for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} }
}

/// The state of the two panels, as a reader would see it.
async function surfaces(page) {
	return await page.evaluate(() => {
		const shown = el => !!el && el.offsetParent !== null;
		const doc  = document.getElementById('panel-doc');
		const work = document.getElementById('panel-work');
		const view = document.getElementById('doc-view');
		return {
			docOpen:   shown(doc),
			workOpen:  shown(work),
			treeShown: shown(work && work.querySelector('.files-tree')),
			docName:   (document.getElementById('doc-name') || {}).textContent || '',
			docText:   ((view && view.querySelector('.files-view-body')) || {}).textContent || '',
			viewInDoc: !!(view && view.querySelector('.files-view-body')),
			viewInWork: !!(work && work.querySelector('.files-view-body')),
			embedShown: shown(document.getElementById('doc-embed')),
		};
	});
}

let s = null;
(async () => {
	let served = false;
	try { served = (await fetch(H.APP + '/')).ok; } catch (e) {}
	if (!served) {
		procs.push(spawn('node', ['dev/serve.mjs'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] }));
		served = await waitFor(async () => (await fetch(H.APP + '/')).ok, 10000);
	}
	check('dev server serves the app', served);
	if (!served) { cleanup(null); process.exit(1); }

	s = await H.open({ name: 'doc-panel', connect: false });
	const page = s.page;

	// Write a file straight through the tool the agent uses, so this tests the
	// panels and not the file dialogs.
	const body = 'Chapter one.\nThe document panel is where a document goes.\nLine three.\n';
	await page.evaluate(async (text) => {
		await window.DaimondPanels.show('work');
		const app = window.__daimondToolHost || null;
		// The Workspace panel's own writer, which is what the New File button uses.
		const w = await navigator.storage.getDirectory();
		const fh = await w.getFileHandle('chapter.txt', { create: true });
		const ws = await fh.createWritable();
		await ws.write(new TextEncoder().encode(text));
		await ws.close();
		return !!app;
	}, body);

	await page.evaluate(() => window.DaimondPanels.show('work'));
	await sleep(600);
	await page.evaluate(() => {
		const r = document.querySelector('#panel-work [data-act="refresh"]');
		if (r) r.click();
	});
	await sleep(900);

	const before = await surfaces(page);
	check('the Workspace tile is open with its tree showing',
		before.workOpen && before.treeShown, JSON.stringify(before));
	check('Doc is not open before anything is opened', !before.docOpen);
	// The viewer must not still be built into the Workspace panel.
	check('the Workspace panel no longer contains a document view', !before.viewInWork);

	// Open it the way a person does: click the row in the tree.
	const opened = await page.evaluate(() => {
		const rows = Array.from(document.querySelectorAll('#panel-work .files-row'));
		const row = rows.find(r => /chapter\.txt/.test(r.textContent || ''));
		if (!row) return 'chapter.txt is not in the tree: ' + rows.map(r => r.textContent).join(',');
		row.click();
		return true;
	});
	check('the file is in the tree and can be clicked', opened === true, String(opened));
	await sleep(1200);

	const after = await surfaces(page);
	check('opening a text file raises the Doc panel', after.docOpen, JSON.stringify(after));
	check('the document renders as text in Doc', after.viewInDoc && /Chapter one/.test(after.docText),
		after.docText.slice(0, 40));
	check('Doc names the file', /chapter\.txt/.test(after.docName), after.docName);
	// The whole point of moving it: you keep your bearings while reading.
	check('the file tree is STILL showing while the document is open',
		after.workOpen && after.treeShown, JSON.stringify({ work: after.workOpen, tree: after.treeShown }));
	check('the PDF embed stays out of the way for a text file', !after.embedShown);

	// Editing happens where reading happens, or the split is back.
	const canEdit = await page.evaluate(() => {
		const v = document.getElementById('doc-view');
		return !!(v && v.querySelector('[data-act="edit"]') && v.querySelector('[data-act="download"]'));
	});
	check('the document can be edited and downloaded from Doc', canEdit);

	// ── The button row is one height, not two ──────────────────────────
	// ◈ only shows itself with a Diamond open (it names what that Diamond
	// holds), so one is made here purely to bring the button on screen.
	//
	// Measured, not eyeballed: "consistent" means every visible button in
	// `.files-view-head` reports the SAME `getBoundingClientRect().height`,
	// to within sub-pixel layout rounding. ◈ used to carry a bigger font on
	// the same padding as its neighbours, which grew the whole button by the
	// same fraction as the glyph — 23.6px against their 22.4px, a difference
	// too small to name on sight and exactly the kind a screenshot alone
	// would miss and a measurement catches every time.
	// The new-Diamond dialog refuses to create one with no model chosen, and
	// this suite runs with `connect: false` for everything up to here.
	await H.connectMock(s);
	await sleep(400);
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Doc header probe');
	await page.click('.dlg-ok', { force: true });
	await sleep(900);
	await page.evaluate(() => {
		const r = document.querySelector('#panel-work [data-act="refresh"]');
		if (r) r.click();
	});
	await sleep(700);
	const reopened = await page.evaluate(() => {
		const rows = Array.from(document.querySelectorAll('#panel-work .files-row'));
		const row = rows.find(r => /chapter\.txt/.test(r.textContent || ''));
		if (!row) return false;
		row.click();
		return true;
	});
	check('the file can be reopened with a Diamond in focus', reopened);
	await sleep(900);

	const heights = await page.evaluate(() => {
		return Array.from(document.querySelectorAll('.files-view-head .files-btn'))
			.filter(b => getComputedStyle(b).display !== 'none')
			.map(b => ({ act: b.dataset.act, h: b.getBoundingClientRect().height }));
	});
	// `attach`, not `hold`: the ◈ became the paperclip when attaching stopped
	// meaning "keep with this Diamond" and started meaning "attach to whatever is
	// in focus". The height property is unchanged — this is the button's name.
	const holdShown = heights.some(b => b.act === 'attach');
	check('the attach button is on screen for this measurement', holdShown, JSON.stringify(heights));
	const distinct = Array.from(new Set(heights.map(b => Math.round(b.h * 10) / 10)));
	check('every button in the row reports the same height',
		holdShown && distinct.length === 1,
		`${JSON.stringify(heights)} — ${distinct.length} distinct height(s)`);

	// Closing it puts the panel away and leaves the tree where it was.
	await page.evaluate(() => {
		const b = document.querySelector('#doc-view [data-act="back"]');
		if (b) b.click();
	});
	await sleep(800);
	const closed = await surfaces(page);
	check('closing the document closes Doc', !closed.docOpen, JSON.stringify(closed));
	check('and the tree is untouched', closed.workOpen && closed.treeShown);

	// The gateway is not running for this suite, and the app is meant to work
	// without one, so its 502s are the expected answer rather than a fault.
	const real = s.errs.filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
	check('no page errors', real.length === 0, real.slice(0, 3).join(' | '));

	await H.shot(s, 'doc-panel').catch(() => {});
	cleanup(s);
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(e => { cleanup(s); console.error(e); process.exit(1); });
