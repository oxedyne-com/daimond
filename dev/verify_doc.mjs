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
// And what the panel does when it is ASKED FOR with nothing to show, which until
// now was nothing at all: no hook, a blank title and an empty `display:none`
// body. It offers a new document instead, and the checks below require it to
// name itself, to name which of the two filesystems Save will write it to, and
// then to write exactly the bytes typed and no others.
//
//   node dev/verify_doc.mjs

import fs from 'node:fs';
import os from 'node:os';
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

/// A screenshot of one element, PROVEN to exist. `H.shot` swallows a failed
/// capture, and a clean run is otherwise no evidence that anything was taken.
async function shotOf(page, name, sel) {
	const dir = path.join(os.homedir(), '.cache/daimond/lane-v-shots');
	const out = path.join(dir, name + '.png');
	try {
		fs.mkdirSync(dir, { recursive: true });
		const el = await page.$(sel);
		if (!el) { console.log(`  note  no ${sel} to photograph`); return null; }
		await el.screenshot({ path: out, timeout: 8000 });
	} catch (e) { console.log(`  note  screenshot ${name} failed: ${String(e).split('\n')[0]}`); return null; }
	if (!fs.existsSync(out) || fs.statSync(out).size < 500) { console.log(`  note  ${name} is not on disk`); return null; }
	console.log('  shot  ' + out);
	return out;
}
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

	// ── The panel asked for with nothing to show ───────────────────────
	//
	// It held NOTHING. `#doc-view` starts empty and `display:none`, the title
	// starts blank, and `DaimondPanels.show` carried an onOpen hook for the
	// Workspace, Mail, Spending, the Terminal, the Trash and Social -- and none
	// for this panel. So the Doc chip opened a rectangle with a close button in
	// it and no other mark, which reads as broken rather than as empty.
	//
	// What it does now is offer a NEW DOCUMENT, and the three things a new
	// document must not leave unsaid are each asserted rather than admired:
	// what it is called, that it is Save and not time that writes it, and WHICH
	// FILESYSTEM it lands in -- the last being the confusion this project has
	// paid most for, so the sentence is required to name the place in the same
	// words the Workspace panel's own mode chip uses.
	const coldPath = 'notes-' + new Date().toISOString().slice(0, 10) + '.md';
	// The panel names the cold document by TODAY, computed when it opens -- not
	// when this line runs. A run that straddles midnight sees the date advance in
	// between, so the name the panel shows may be this day's or the next. Both are
	// covered here, and the file is read back below under the name it ACTUALLY
	// showed, so a rollover mid-run is a fact about the clock and not a red.
	const nextPath = 'notes-'
		+ new Date(Date.parse(coldPath.slice(6, 16)) + 86400000).toISOString().slice(0, 10) + '.md';
	// It must not exist BEFORE the panel is opened, or "Save created it" is a
	// claim about a file that was already there. Neither candidate name may be on
	// disk, so whichever the panel picks, Save is what wrote it.
	const existedBefore = await page.evaluate(async (rels) => {
		for (const rel of rels) {
			try { const m = await import('/pkg/oxedyne_daimond.js'); await m.read_file(rel); return rel; }
			catch (e) { /* good: not on disk */ }
		}
		return '';
	}, [coldPath, nextPath]);
	check('the document this will propose is not on disk yet', !existedBefore,
		existedBefore || (coldPath + ' / ' + nextPath));

	await page.evaluate(() => {
		window.DaimondPanels.markUsed('doc');
		window.DaimondPanels.show('doc');
		window.DaimondPanels.reflow();
	});
	await sleep(1500);
	const cold = await page.evaluate(() => {
		const view = document.getElementById('doc-view');
		const shown = (sel) => {
			const e = view && view.querySelector(sel);
			return !!e && e.getClientRects().length > 0;
		};
		return {
			name:    (document.getElementById('doc-name') || {}).textContent || '',
			editing: !!(view && view.querySelector('.files-edit')),
			said:    ((view && view.querySelector('.files-view-msg')) || {}).textContent || '',
			saidShown: shown('.files-view-msg'),
			// The Browser chip's own word, read off the mode row rather than
			// restated here: the check is that the two agree, and hard-coding the
			// word would let them drift apart while it went on passing.
			place:   ((document.querySelector('#panel-work .files-mode-chip.active')) || {}).textContent || '',
			saveBtn: ((view && view.querySelector('[data-act="edit"]')) || {}).textContent || '',
			download: shown('[data-act="download"]'),
			attach:   shown('[data-act="attach"]'),
		};
	});
	check('opening Doc cold puts an editable document in it, not nothing',
		cold.editing, JSON.stringify(cold));
	check('and it is named, so it can be found again', cold.name === coldPath || cold.name === nextPath,
		cold.name + (cold.name === nextPath ? ' (the clock rolled to the next day mid-run)' : ''));
	check('the panel says where the document will land, in the mode row\'s own word',
		cold.saidShown && !!cold.place.trim() && cold.said.includes(cold.place.trim()),
		JSON.stringify({ said: cold.said, place: cold.place }));
	check('the button says which state it is in: there are edits to write',
		/Save/i.test(cold.saveBtn), cold.saveBtn);
	// The picture, because the checks above say the panel is not empty and only a
	// picture says whether what replaced the emptiness is worth looking at.
	await shotOf(page, 'doc-cold', '#panel-doc');
	check('nothing that acts on a file is offered before there is one',
		cold.editing && !cold.download && !cold.attach,
		JSON.stringify({ editing: cold.editing, download: cold.download, attach: cold.attach }));

	// And it really saves, at the name it showed, with the bytes that were typed
	// and no others -- the property `verify_docroundtrip` asserts for a file that
	// already exists, asserted here for the one this panel invents.
	const NEW_BODY = '# Cold open\n\nTyped into a document that did not exist.\n';
	await page.evaluate((text) => {
		const ta = document.querySelector('#doc-view .files-edit');
		if (ta) { ta.value = text; ta.dispatchEvent(new Event('input', { bubbles: true })); }
	}, NEW_BODY);
	await page.evaluate(() => {
		const b = document.querySelector('#doc-view [data-act="edit"]');
		if (b) b.click();
	});
	await sleep(2500);
	// Read back under the name the panel ACTUALLY showed, not the one guessed
	// before it opened: on a midnight-straddling run those differ, and the round
	// trip is about the bytes at the panel's own name.
	const saved = await page.evaluate(async (rel) => {
		const view = document.getElementById('doc-view');
		let onDisk = null;
		try { const m = await import('/pkg/oxedyne_daimond.js'); onDisk = await m.read_file(rel); }
		catch (e) { onDisk = 'READ FAILED: ' + e; }
		const shown = (sel) => {
			const e = view && view.querySelector(sel);
			return !!e && e.getClientRects().length > 0;
		};
		return {
			onDisk,
			said:   ((view && view.querySelector('.files-view-msg')) || {}).textContent || '',
			editBtn: ((view && view.querySelector('[data-act="edit"]')) || {}).textContent || '',
			download: shown('[data-act="download"]'),
			attach:   shown('[data-act="attach"]'),
		};
	}, cold.name);
	check('Save writes exactly what was typed, at the name the panel showed',
		saved.onDisk === NEW_BODY, JSON.stringify(saved.onDisk));
	check('and the button flips back, so the user can tell it is written',
		/Edit/i.test(saved.editBtn) && /Saved/i.test(saved.said),
		JSON.stringify({ btn: saved.editBtn, said: saved.said }));
	check('the file controls come back now that there is a file',
		saved.download && saved.attach,
		JSON.stringify({ download: saved.download, attach: saved.attach }));
	await shotOf(page, 'doc-cold-saved', '#panel-doc');

	// The gateway is not running for this suite, and the app is meant to work
	// without one, so its 502s are the expected answer rather than a fault.
	const real = s.errs.filter(e => !/502|Bad Gateway|Failed to load resource/.test(e));
	check('no page errors', real.length === 0, real.slice(0, 3).join(' | '));

	await H.shot(s, 'doc-panel').catch(() => {});
	cleanup(s);
	console.log(`\n${ok.length} passed, ${bad.length} failed`);
	process.exit(bad.length ? 1 : 0);
})().catch(e => { cleanup(s); console.error(e); process.exit(1); });
