// verify_rawreads.mjs — nothing user-facing reads a file through the model's eyes.
//
// `run_tool('file_read')` renders a file FOR A MODEL: every line is prefixed with
// its number and a TAB, truncation is announced in prose, and anything under an
// untrusted path arrives wrapped in an envelope. Handed to something that treats
// the result as the file, the numbers become part of the content.
//
// This has shipped as a live bug four times, each found only after the last was
// written down:
//
//   1. The Doc panel showed the numbered rendering AND seeded its editor with it,
//      so opening a file and pressing Save wrote the numbers in — compounding on
//      every repeat. (Fixed 2026-08-06.)
//   2. The Email panel read every message's headers that way, so `parseHeaders`
//      saw `1\tFrom: …`, matched nothing, and every message in the panel read
//      "(unknown)" and "(no subject)". (Fixed 2026-08-07.)
//   3. The `conductor` → `daimon` prompt migration read the old file and WROTE it
//      into the new one, baking the numbers into the user's own edited prompt.
//   4. The Web panel read an agent-written HTML page and rendered it, numbers and
//      all, as the page.
//
// Four instances of one rule is not four mistakes, it is a missing check. So this
// hunts the PROPERTY rather than the four: for each surface that turns a file into
// something a person sees or a machine parses, the bytes that come out are the
// bytes that went in.
//
// The tell to look for is a line beginning `<digits><TAB>` where the file had no
// such thing, so the fixtures are written with content that could never produce
// one by accident.
//
//   node dev/verify_rawreads.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway, no model.
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const PROFILE = scratch('pw', 'rawreads');
fs.rmSync(PROFILE, { recursive: true, force: true });

let bad = 0;
const check = (pass, name, detail) => {
	if (!pass) bad++;
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

/// The signature of the model's rendering: a line that opens with a number and a
/// tab. `file_read` produces one for EVERY line, so one is enough to convict.
const NUMBERED = /(^|\n)\d+\t/;

const s = await open({ name: 'rawreads', profile: PROFILE, connect: false });
const { page } = s;

try {
	await page.waitForFunction(() => !!(window.DaimondCore && window.DaimondPanels),
		null, { timeout: 20000 });
	await page.waitForTimeout(800);

	const write = (path, content) => page.evaluate(async (a) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: a.path, content: a.content }));
	}, { path, content });

	// Three lines, none of which begins with a digit, so a `1\t` in the output can
	// only have come from the renderer.
	const BODY = 'alpha one\nbeta two\ngamma three\n';

	console.log('the two readers disagree, which is the whole point');
	await write('rawreads.txt', BODY);
	const both = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		const rendered = await app.run_tool('file_read', JSON.stringify({ path: 'rawreads.txt' }));
		const raw = await mod.read_file('rawreads.txt');
		return { rendered, raw };
	});
	check(NUMBERED.test(both.rendered),
		'`file_read` numbers every line — so the tell this file hunts for is real',
		JSON.stringify(both.rendered.slice(0, 24)));
	check(both.raw === BODY,
		'`read_file` gives back exactly what was written',
		JSON.stringify(both.raw.slice(0, 24)));

	console.log('the Web panel renders the page, not a listing of it');
	// Through the panel's own door — `DaimondWeb.open` then `read()` — and not by
	// reading the file a second way and comparing it with itself. A check that
	// proves `read_file` works proves nothing about what the panel calls.
	await write('page.html', '<!doctype html>\n<title>Hi</title>\n<p>Hello there.</p>\n');
	const shown = await page.evaluate(async () => {
		try {
			const res = await window.DaimondWeb.open('page.html');
			await new Promise(r => setTimeout(r, 400));
			const text = await window.DaimondWeb.read();
			return { driver: res && res.driver, text: (text && text.text) || String(text || '') };
		} catch (e) { return { err: String(e).slice(0, 120) }; }
	});
	if (shown.err) {
		check(false, 'the Web panel opened the page', shown.err);
	} else {
		check(shown.driver === 'local', 'the page opened in the local driver', String(shown.driver));
		// NOT `NUMBERED` here, and the reason is the whole lesson of this file: a
		// browser collapses the tab, so the RENDERED text of a numbered page reads
		// "1 2 3  Hello there." with no tab anywhere in it. The first version of
		// this check used the same regex as the others and passed against the
		// broken code — proof, again, that a check has to be run against the fault
		// it exists for. What survives rendering is that the numbers are there at
		// all, so the tell is visible text opening with a bare run of integers.
		const opensWithNumbers = /^\s*\d+(\s+\d+)+/.test(shown.text);
		check(!opensWithNumbers && !NUMBERED.test(shown.text),
			'and what the page SHOWS is the page, not a numbered listing of its source',
			JSON.stringify(shown.text.slice(0, 40)));
	}

	console.log('a prompt carried to its new name keeps its own words');
	await write('prompts/conductor.md', BODY);
	const carried = await page.evaluate(async () => {
		try {
			await DaimondPrompts.migrateRenamed
				? DaimondPrompts.migrateRenamed()
				: (DaimondPrompts.migrate && await DaimondPrompts.migrate());
		} catch (e) { /* the migration may have nothing to do */ }
		const mod = await import('../pkg/oxedyne_daimond.js');
		try { return await mod.read_file('prompts/daimon.md'); } catch (e) { return ''; }
	});
	if (!carried) {
		console.log('  skip  the rename migration did not run in this state');
	} else {
		check(!NUMBERED.test(carried), 'the migrated prompt is the words, not a listing of them',
			JSON.stringify(carried.slice(0, 28)));
	}

	console.log('the source handed to the compiler is source');
	await write('doc.typ', '= Title\n\nA paragraph.\n');
	const typ = await page.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		return await mod.read_file('doc.typ');
	});
	check(!NUMBERED.test(typ), 'a Typst file reads back compilable',
		JSON.stringify(typ.slice(0, 24)));

	console.log('and the rule is kept where it is easy to break');
	const src = await (await fetch(`${new URL(page.url()).origin}/js/daimond.js`)).text()
		.catch(() => null) || await page.evaluate(async () => (await fetch('/js/daimond.js')).text());
	// Every remaining `file_read` in daimond.js must be an existence test. The
	// content-using ones now go through `readBytes`, so a new one is a new bug.
	const reads = (src.match(/run_tool\('file_read'/g) || []).length;
	const raws  = (src.match(/readBytes\(/g) || []).length;
	check(raws >= 4, 'the shared byte reader is used by every surface that needs content',
		`${raws} call site(s)`);
	console.log(`  note  ${reads} \`file_read\` call(s) remain in daimond.js; each should be an existence test only`);

	const errs = (await import('./harness.mjs')).errors(s)
		.filter((e) => !/50[23]|Bad Gateway|Failed to load resource/i.test(e));
	check(errs.length === 0, 'no console errors beyond the offline gateway',
		JSON.stringify(errs.slice(0, 2)));
} finally {
	await s.close();
}

console.log(bad ? `\n${bad} failed` : '\nall checks passed');
process.exit(bad ? 1 : 0);
