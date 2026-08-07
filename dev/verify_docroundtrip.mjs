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
//   node dev/verify_docroundtrip.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no mock LLM: nothing
// here runs a turn.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'docroundtrip');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const BODY = 'alpha\nbeta\ngamma\na line long enough that it wraps inside the panel and shows where a continuation goes\n';

const s = await open({ name: 'docroundtrip', profile: PROFILE, connect: false });
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

	// ── 3. The round trip is the identity ───────────────────────────
	// Edit, then save, typing nothing. This is the check the whole file exists for.
	await page.getByRole('button', { name: /Edit/ }).first().click();
	await page.waitForTimeout(600);
	const seeded = await page.evaluate(() => {
		const ta = document.querySelector('.files-edit');
		return ta ? ta.value : null;
	});
	check(seeded === BODY, 'the editor is seeded with the file, byte for byte',
		JSON.stringify((seeded || '').slice(0, 40)));
	await page.getByRole('button', { name: /Save/ }).first().click();
	await page.waitForTimeout(1500);
	const after = await raw();
	check(after === BODY, 'and a save that typed nothing changed nothing',
		JSON.stringify(after.slice(0, 60)));

} finally {
	await s.close();
}

console.log(bad === 0 ? '\nall checks passed' : `\n${bad} check(s) FAILED`);
process.exit(bad === 0 ? 0 : 1);
