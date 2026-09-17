// verify_docroundtrip.mjs — the Doc panel shows the FILE, and saving it changes nothing.
//
// `file_read` is a tool that renders a file FOR A MODEL. It numbers every line
// (`1\t`), it says so when it truncates, and it explains itself when the bytes
// are in cloud storage. All three are right for an agent and none of them is the
// file. The viewer read the file that way and showed the result as the document.
//
// Two consequences, and the second is data loss:
//
//   1. With the line-number toggle on, the reader saw TWO columns of numbers --
//      the tool's, baked into the text, and the viewer's own gutter beside it.
//   2. The editor was seeded with the same string, so OPENING A FILE AND PRESSING
//      SAVE WITHOUT TYPING ANYTHING wrote the line numbers into it, and did it
//      again over the top on every repeat. A truncated read would have written
//      the truncation the same way.
//
// So the property is not "the viewer looks right". It is that **a round trip
// through the viewer is the identity function**, which is the thing a person
// betting their files on this app needs to be true.
//
// The second half of the file holds forge #14: the guard inside `file_write`
// compares the disk against what the last TOOL-layer read saw. The anchor it
// defends was set by the DAIMON'S OWN read of the file in an earlier turn --
// which is exactly how it stood for the reporter -- and a write the guard cannot
// see (sync landing the file from a peer, a Restore) drifts the disk out from
// under it. The user's next save was then refused as "another agent edited it"
// even though the panel was showing the disk as it stood. The panel's save now
// re-anchors first; the declared break serves the code that did not.
//
//   node dev/verify_docroundtrip.mjs                          # clean
//   node dev/verify_docroundtrip.mjs --break driftrefusal     # the defect as it shipped
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777) and the mock LLM for the one
// @tool turn that sets the anchor. No gateway.
import fs from 'node:fs';
import { open, connectMock, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'docroundtrip');
const SHOT = new URL('./shots/p14-docsave.png', import.meta.url).pathname;
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BODY = 'alpha\nbeta\ngamma\na line long enough that it wraps inside the panel and shows where a continuation goes\n';

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// Each break is a real edit to a real file, served in place of it through route
// interception, exactly as verify_askdrawn.mjs does it. The working tree is
// never touched. `find` must appear exactly once in the file.
const BREAKS = {
	// THE DEFECT AS IT SHIPPED, restored exactly: the panel's save went straight
	// to file_write over whatever anchor the daimon's last read had left behind,
	// so a drift the guard could not see turned the user's very next save into a
	// refusal -- "changed on disk since you read it" over a file that matched
	// what the user was looking at.
	driftrefusal: [{
		file: 'js/daimond.js',
		find: "\t\t\treturn tools().run_tool_outcome('file_read',\n"
			+ "\t\t\t\tJSON.stringify({ path: path })).then(function () {\n"
			+ "\t\t\t\treturn tools().run_tool_outcome('file_write',\n"
			+ "\t\t\t\t\tJSON.stringify({ path: path, content: content }));\n"
			+ "\t\t\t});",
		with: "\t\t\treturn tools().run_tool_outcome('file_write',\n"
			+ "\t\t\t\tJSON.stringify({ path: path, content: content }));",
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}, expected 1 — the break is stale, fix the anchor`);
		process.exit(2);
	}
	return src.replace(spec.find, () => spec.with);
}

function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(new URL('../www/' + spec.file, import.meta.url), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

async function serveBreaks(page) {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await page.route('**/' + file, r => r.fulfill({ status: 200, contentType: 'text/javascript', body }));
	}
}

const s = await open({ name: 'docroundtrip', profile: PROFILE, connect: false, route: BREAK ? serveBreaks : null });
const { page } = s;

try {
	await page.waitForTimeout(1500);

	/// The bytes as they actually sit in the account's OPFS, read past the app.
	const raw = () => page.evaluate(async () => {
		const dir = await DaimondCloud.opfsRoot();
		return await (await (await dir.getFileHandle('round.md')).getFile()).text();
	});

	await page.evaluate(async (body) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: 'round.md', content: body }));
	}, BODY);
	check(await raw() === BODY, 'the fixture is on disk as written');

	// THE ANCHOR, set the way the reporter's was: the daimon read this file in a
	// turn. One @tool read through the real app's tool context is that read. The
	// break below proves the anchor took -- if it had not, the break would fail
	// nothing and say so.
	await connectMock(s);
	await page.evaluate(() => document.getElementById('new-diamond-btn').click());
	await page.waitForSelector('.dlg-card', { timeout: 8000 });
	await page.evaluate(() => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = 'Docroundtrip';
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	});
	await page.waitForTimeout(1200);
	await page.fill('#chat-input', '@tool file_read ' + JSON.stringify({ path: 'round.md' }));
	await page.click('#chat-send');
	await page.waitForTimeout(6000);

	// Open it the way a person does, from the tree. `Files` is closure-scoped and
	// not reachable from here, so the row is the door -- and the tree's listing
	// races the write that made the file, so the panel is re-opened until the row
	// is there rather than once with a hopeful pause. A verifier that flakes on
	// its own fixture says nothing about the property it exists for.
	let row = null;
	for (let i = 0; i < 10 && !row; i++) {
		await page.evaluate(() => {
			try { DaimondPanels.hide('work'); DaimondPanels.show('work'); } catch (e) {}
		});
		await page.waitForTimeout(600);
		row = await page.$('text=round.md');
	}
	check(!!row, 'the file is listed in the Workspace tree');
	if (!row) throw new Error('fixture never appeared in the tree');
	await row.click();
	await page.waitForTimeout(1400);

	// ── 1. What is on screen is the file ────────────────────────────
	const shown = await page.evaluate(() => {
		const b = document.querySelector('.files-view-body');
		return b ? b.textContent : '';
	});
	check(shown.indexOf('alpha') !== -1, 'the document is on screen', JSON.stringify(shown.slice(0, 40)));
	check(!/(^|\n)\s*\d+\t/.test(shown),
		'and carries none of file_read\'s line-number prefixes',
		JSON.stringify(shown.slice(0, 60)));

	// ── 2. One gutter, not two ──────────────────────────────────────
	const btn = await page.$('#doc-lineno');
	check(!!btn && await btn.isVisible(), 'the line-number toggle is offered over a text file');
	if (btn && await btn.isVisible()) {
		if (await btn.getAttribute('aria-pressed') !== 'true') { await btn.click(); await page.waitForTimeout(600); }
		const rows = await page.evaluate(() => [...document.querySelectorAll('.lnrow')].slice(0, 3).map(r => ({
			gutter: (r.querySelector('.ln') || {}).textContent || '',
			text:   [...r.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(''),
		})));
		check(rows.length >= 3, 'the numbered view renders a row per line', JSON.stringify(rows.length));
		check(rows.every(r => !/^\d+\t/.test(r.text)),
			'and each row\'s text is the line, not a second number',
			JSON.stringify(rows));
		check(rows[0] && rows[0].gutter === '1' && rows[1] && rows[1].gutter === '2',
			'with the gutter counting from one', JSON.stringify(rows.map(r => r.gutter)));
	}

	// The Doc panel’s own Edit/Save button — the chat face opened by the @tool turn
	// carries its own Edit control, and getByRole matched that one first.
	const docEdit = () => page.locator('.files-view-head [data-act="edit"]').first();
	// ── 3. The round trip is the identity ───────────────────────────
	// Edit, then save, typing nothing. The anchor is live and matches, so this
	// save passes the guard in BOTH the clean and the broken build.
	await docEdit().click();
	await page.waitForTimeout(600);
	const seeded = await page.evaluate(() => {
		const ta = document.querySelector('.files-edit');
		return ta ? ta.value : null;
	});
	check(seeded === BODY, 'the editor is seeded with the file, byte for byte',
		JSON.stringify((seeded || '').slice(0, 40)));
	await docEdit().click();
	await page.waitForTimeout(1500);
	const after = await raw();
	check(after === BODY, 'and a save that typed nothing changed nothing',
		JSON.stringify(after.slice(0, 60)));

	// ── 5. The save-over-sync loop (forge #14) ───────────────
	// The reporter's exact loop. The daimon read this file in a real @tool turn, so
	// the guard's anchor is the PRE-SYNC bytes. Sync then lands the peer's edit
	// directly into OPFS -- a door the guard cannot see -- and only THEN does the
	// user open the file: the panel seeds from the bytes now on disk, so what the
	// user is looking at IS the file. The only stale thing is the anchor. Pre-fix,
	// the save went straight to file_write over it and was refused as "another
	// agent edited it" -- and a REFUSED write refreshes nothing, so every save
	// after was refused too, repeatedly, with no underlying change. The
	// re-anchoring save passes; the break serves the code that did not.
	const SYNCED = BODY + 'synced from a peer\n';
	// The drift lands through DaimondCloud.writeBlob -- the app's own write
	// door, the one sync uses -- so the panel's read sees the post-sync bytes;
	// a raw OPFS write under the same root was invisible to the file cache and
	// the lane read pre-sync text.
	await page.evaluate(async (txt) => {
		if (window.DaimondCloud && DaimondCloud.writeBlob) {
			await DaimondCloud.writeBlob('round.md', new Blob([txt], { type: 'text/plain' }));
			return;
		}
		const dir = await DaimondCloud.opfsRoot();
		const h = await dir.getFileHandle('round.md', { create: true });
		const w = await h.createWritable();
		await w.write(txt);
		await w.close();
	}, SYNCED);

	// Re-open the file the way a person does, AFTER the drift, so the panel seeds
	// from the bytes now on disk. The same retry shape as the first open: the
	// tree's listing races whatever last touched the file.
	//
	// Two doors are ruled out, each for a reason this lane depends on:
	//  * page.reload() would defeat the whole lane -- the read_seen anchor that
	//    the guard checks (tools.rs:16412) lives in the live wasm app's memory,
	//    set by the @tool file_read above, and a reloaded page boots a fresh app
	//    with an empty cache, so the broken save would find nothing to conflict
	//    with and PASS. Reload is the one re-open this lane must never use.
	//  * page.$('text=round.md') matches the DOC-PANEL header's #doc-name first:
	//    the file is still open from step 3, so that element now says `round.md`
	//    and precedes the tree in the DOM. The click lands on a bare span with no
	//    handler, openFile never runs, and the panel keeps the pre-sync curContent
	//    -- the stale seed this lane exists to catch. The ROW is the door (its
	//    data-path is set at daimond.js:35621, and openFile always re-reads disk
	//    through Wasm.read_file, which has no cache), so the re-open selects the
	//    row by that data-path and nothing else.
	let row2 = null;
	for (let i = 0; i < 10 && !row2; i++) {
		await page.evaluate(() => {
			try { DaimondPanels.hide('work'); DaimondPanels.show('work'); } catch (e) {}
		});
		await page.waitForTimeout(600);
		row2 = await page.$('.files-row[data-path="round.md"], .files-row[data-path$="/round.md"]');
	}
	check(!!row2, 'the file is still listed after the sync');
	if (!row2) throw new Error('file never re-appeared in the tree');
	await row2.click();
	await page.waitForTimeout(1400);
	const shown2 = await page.evaluate(() => {
		const b = document.querySelector('.files-view-body');
		return b ? b.textContent : '';
	});
	check(shown2.indexOf('synced from a peer') !== -1,
		'the panel seeds from the POST-SYNC bytes -- what the user sees is the file',
		JSON.stringify(shown2.slice(-40)));

	// The save over the drifted disk. Clean: re-anchored first, lands. Broken:
	// the stale anchor refuses it as another agent's edit.
	const EDIT1 = SYNCED + 'a line the user typed\n';
	const EDIT2 = EDIT1 + 'and another\n';
	await docEdit().click();
	await page.waitForTimeout(600);
	const seeded3 = await page.evaluate(() => {
		const ta = document.querySelector('.files-edit');
		return ta ? ta.value : null;
	});
	check(seeded3 === SYNCED, 'the editor seeds from the post-sync file, byte for byte',
		JSON.stringify((seeded3 || '').slice(-40)));
	if (seeded3 !== SYNCED) throw new Error('editor seeded from stale bytes -- the re-open door did not re-read the file');
	await page.evaluate((txt) => {
		const ta = document.querySelector('.files-edit');
		ta.value = txt;
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	}, EDIT1);
	await docEdit().click();
	await page.waitForTimeout(1500);
	const savedDrift = await raw();
	check(savedDrift === EDIT1, 'the save over the synced file LANDS -- no false "changed on disk" (forge #14)',
		JSON.stringify(savedDrift.slice(-60)));
	const refused = await page.evaluate(() =>
		document.body.textContent.includes('changed on disk since you read it'));
	check(refused === false, 'and the refusal banner is not on screen',
		refused ? 'the refusal text is on screen' : 'no refusal on screen');

	// The "repeatedly" half: a second save, seeded from what is now on disk.
	// Pre-fix, the first refusal left the anchor as stale as ever, so this one
	// was refused too -- the reporter's forever loop.
	await docEdit().click();
	await page.waitForTimeout(600);
	await page.evaluate((txt) => {
		const ta = document.querySelector('.files-edit');
		ta.value = txt;
		ta.dispatchEvent(new Event('input', { bubbles: true }));
	}, EDIT2);
	await docEdit().click();
	await page.waitForTimeout(1500);
	check(await raw() === EDIT2, 'save #2 lands too -- the loop the reporter was stuck in',
		JSON.stringify((await raw()).slice(-40)));
	// The CLEAN run's shot only -- the driftrefusal break run would overwrite this
	// file with the broken build's banner, so under a break the shot goes to a
	// -break suffixed name and the clean evidence survives.
	await page.screenshot({ path: BREAK ? SHOT.replace(/\.png$/, '-break.png') : SHOT, fullPage: false });
	console.log('shot: ' + (BREAK ? SHOT.replace(/\.png$/, '-break.png') : SHOT));

} finally {
	await s.close();
}

if (BREAK) {
	console.log(`\nbreak '${BREAK}': ${bad} check(s) failed`
		+ (bad ? ' — ' + 'the defect is visible to this lane' : ' — NOTHING FAILED, so the checks above prove nothing'));
	process.exit(bad ? 0 : 1);		// a break MUST fail something
}
console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
