// verify_typstbutton.mjs — the ⚙ Compile button compiles the PROJECT.
//
// `typst_compile` shipped a whole multi-file gatherer in seq 116 and NOTHING IN
// PRODUCTION CALLED IT. The model's tool took the single-source arm, and the Doc
// panel's ⚙ Compile button — the other door, the one a person presses — handed
// `DaimondTypst.compile` one file's text. A 63-file book compiled through it came
// back "only the one source was given to the compiler", and the daimon reading
// that concluded the compiler could not resolve imports at all.
//
// The 24-check verifier that covered the gatherer could not see this, and the
// reason is the whole point of this file: IT CALLED THE GATHERER ITSELF. A check
// that reaches for `Wasm.typst_compile_project` passes whether or not anything a
// user can press is wired to it.
//
// So this one presses the button. It seeds a two-file project in the workspace,
// opens the file the way a person opens it, clicks ⚙ Compile, and asks what
// appeared. One property, and it cannot be satisfied by the single-file door:
//
//   THE BUTTON COMPILES A DOCUMENT THAT IMPORTS ANOTHER FILE. The chapter is a
//   separate file; a compiler handed only `main.typ` cannot find it and says so.
//   Asserted on the panel's own message and on the PDF landing in the workspace,
//   not on a return value.
//
//   node dev/verify_typstbutton.mjs --break singlefile   # the button as it was:
//                                                        # one source, and the
//                                                        # import cannot resolve
//   node dev/verify_typstbutton.mjs                      # and then, clean
//
//   eval "$(bash dev/world.sh 5 --up)"
//   node dev/verify_typstbutton.mjs
//
// Needs dev/serve.mjs only. The compiler is the real 30 MB wasm, so this is slow.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, scratch, shot } from './harness.mjs';

const WWW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'www');

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

const BREAKS = {
	// The button exactly as it stood until this seam: read the one file, hand the
	// driver the string. Everything else about the panel is unchanged.
	singlefile: [{
		file: 'js/daimond.js',
		find: '\t\t\t\tvar out = await Wasm.typst_compile_project(path);',
		with: '\t\t\t\tvar out = await window.DaimondTypst.compile(await readBytes(path));',
	}],
};

if (BREAK && !BREAKS[BREAK]) {
	console.error(`unknown break '${BREAK}'; one of: ${Object.keys(BREAKS).join(', ')}`);
	process.exit(2);
}

function damaged(src, spec) {
	const n = src.split(spec.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${spec.file}.`);
		process.exit(2);
	}
	return src.replace(spec.find, spec.with);
}

/// The damaged files, ONE BODY PER FILE.
///
/// Every edit a break names for a file goes into the SAME body, in order, and
/// that one body is what the route serves. A `page.route` per edit spec does not
/// work and does not say so: Playwright hands a request to the LAST route
/// registered for its URL, so a two-edit break shipped only its second edit --
/// and still went red, for half the reason it claims, with nothing to notice it.
function damagedFiles() {
	const byFile = new Map();
	for (const spec of (BREAKS[BREAK] || [])) {
		const src = byFile.has(spec.file) ? byFile.get(spec.file)
			: fs.readFileSync(path.join(WWW, spec.file), 'utf8');
		byFile.set(spec.file, damaged(src, spec));
	}
	return byFile;
}

const routeBreaks = async (pg) => {
	if (!BREAK) return;
	for (const [file, body] of damagedFiles()) {
		await pg.route('**/' + file, r => r.fulfill({
			status: 200, contentType: 'application/javascript', body,
		}));
	}
};

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// A project, not a file: the chapter is somewhere else and the main source has
// to reach it. This is the whole difference between the two doors.
const MAIN = 'tbook/main.typ';
const CHAP = 'tbook/chap01.typ';
const MARK = 'THE CHAPTER RESOLVED';
const MAIN_SRC = '#include "chap01.typ"\n';
const CHAP_SRC = '= Chapter one\n\n' + MARK + '\n';

const PROFILE = scratch('pw', 'typstbutton' + (BREAK ? '-' + BREAK : ''));
fs.rmSync(PROFILE, { recursive: true, force: true });

const s = await open({ name: 'typstbutton', profile: PROFILE, signIn: true, connect: false,
	route: routeBreaks });
const p = s.page;
await p.waitForFunction(() => !!window.DaimondCore && !!window.DaimondPanels,
	null, { timeout: 20000 }).catch(() => {});
await sleep(1500);

try {
	// The account these claims are about holds the typesetting pack, said out
	// loud: a locked pack refuses the compile and the check would be red for a
	// reason that has nothing to do with which door the button uses.
	const held = await p.evaluate(async () => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		mod.set_locked_packs('');
		return { locked: mod.tool_locked('typst_compile'),
			hasProject: typeof mod.typst_compile_project === 'function' };
	});
	check('the account holds the typesetting pack', held.locked === false, 'locked: ' + held.locked);
	check('and this build carries the project door at all', held.hasProject,
		held.hasProject ? '' : 'no typst_compile_project in the wasm: nothing below can pass');

	// Seeded through the file tools, which write into the same workspace root the
	// Files panel reads.
	const seeded = await p.evaluate(async (f) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		await app.run_tool('file_write', JSON.stringify({ path: f.main, content: f.mainSrc }));
		await app.run_tool('file_write', JSON.stringify({ path: f.chap, content: f.chapSrc }));
		return String(await app.run_tool('file_list', JSON.stringify({ path: 'tbook' })));
	}, { main: MAIN, chap: CHAP, mainSrc: MAIN_SRC, chapSrc: CHAP_SRC });
	check('a two-file project is in the workspace',
		/main\.typ/.test(seeded) && /chap01\.typ/.test(seeded), seeded.replace(/\n/g, ' ').slice(0, 90));

	// Opened the way a person opens it: the Work panel, then the file's own row.
	// Closed and reopened rather than merely shown: `DaimondPanels.show` returns
	// early for a panel that is already open, so a tree drawn before the seeding
	// would never list what was just written.
	await p.evaluate(() => { window.DaimondPanels.hide('work'); window.DaimondPanels.show('work'); });
	await sleep(2000);
	const opened = await p.evaluate(async (main) => {
		// The tree draws lazily; the folder has to be entered before the file has
		// a row to click.
		const rows = () => [...document.querySelectorAll('#files-tree [data-path], #work-tree [data-path], .files-row')];
		const byPath = (want) => rows().find((r) => (r.dataset && r.dataset.path) === want);
		const folder = byPath('tbook');
		if (folder) { folder.click(); await new Promise((r) => setTimeout(r, 700)); }
		const row = byPath(main);
		if (!row) return { clicked: false, saw: rows().map((r) => r.dataset && r.dataset.path).filter(Boolean).slice(0, 12) };
		row.click();
		await new Promise((r) => setTimeout(r, 1200));
		return { clicked: true };
	}, MAIN);
	// A compile button on screen is the precondition for the whole file. If it is
	// not there, nothing below means anything, so it is a check of its own.
	const hasBtn = await p.evaluate(() => !!document.querySelector('[data-act="compile"]'));
	check('the document opens with a ⚙ Compile button on it', hasBtn,
		hasBtn ? '' : 'no compile button; rows seen: ' + JSON.stringify(opened.saw || []));

	if (hasBtn) {
		await p.evaluate(() => document.querySelector('[data-act="compile"]').click());
		// The 30 MB compiler is built on first use, so this waits generously — and
		// on the OUTCOME, not on a timer: either a message that is not "compiling"
		// or a PDF in the workspace.
		let said = '';
		for (let i = 0; i < 240; i++) {
			await sleep(1000);
			said = await p.evaluate(() => {
				const m = document.querySelector('.files-view-msg');
				return m ? (m.textContent || '') : '';
			});
			if (said && !/compiling/i.test(said)) break;
		}
		const pdf = await p.evaluate(async (main) => {
			const mod = await import('../pkg/oxedyne_daimond.js');
			const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
			const out = String(await app.run_tool('file_list', JSON.stringify({ path: 'tbook' })));
			return { listing: out, has: /main\.pdf/.test(out) };
		}, MAIN);
		const errored = await p.evaluate(() => {
			const m = document.querySelector('.files-view-msg');
			return !!(m && m.classList.contains('err'));
		});
		check('pressing ⚙ Compile on a document that imports another file produces a PDF',
			pdf.has && !errored, errored ? ('the panel says: ' + said.slice(0, 160)) : said.slice(0, 120));
		check('and the panel says so where the reader is looking',
			/\.pdf/i.test(said) && !errored, said.slice(0, 160));
	}
	await shot(s, 'typst-button');
} catch (e) {
	check('the run finished', false, String(e && e.message || e));
} finally {
	await s.close();
}

console.log(bad.length === 0
	? `\nverify_typstbutton: all ${ok.length} checks pass.`
	: `\nverify_typstbutton: ${bad.length} of ${ok.length + bad.length} failed:\n  ` + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
