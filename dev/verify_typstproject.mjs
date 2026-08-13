// verify_typstproject.mjs — a book is a project, and every file it names must arrive.
//
// The author tried to compile a 17-chapter book by the Doc panel's Compile button and
// by asking his daimon, and both failed on line one with
//
//     failed to load file (access denied), hints: cannot read file outside of project
//     root, you can adjust the project root with the --root argument
//
// Three defects, one feature.  The compiler was handed EXACTLY ONE FILE and its shadow
// filesystem was wiped before every compile, so an `#import` could never resolve; the
// message it failed with described a setting that does not exist here, so the daimon
// reading it concluded the book's images were out of bounds and spent the hour hunting
// assets that were never the problem; and when the gatherer was built to fix both, IT
// WAS NEVER WIRED IN.  `Tool::TypstCompile` went on reading one file and handing the
// string to the single-source door for a whole release, so the user's next attempt
// failed the same way, the daimon concluded the compiler "can only handle self-contained
// single files", and told him to attach a folder that was already in the workspace.
//
// That is why every project claim below is now made THROUGH THE MODEL'S TOOL, by wire
// name, with the arguments a model sends.  The first version of this file called the
// gatherer directly and passed twenty-four checks while production compiled one string.
// A check that does not go through the door the user goes through is checking a room
// nobody enters.
//
// This file asserts the properties that had to become true, and it asserts most of them
// by TAKING A FILE AWAY.  Compiling the whole fixture proves only that something worked;
// withholding each file in turn and demanding that the refusal NAME THE FILE is what
// proves the project is really being gathered and the message is really being composed
// from what this side knows.
//
// Run it red before you believe it green:
//
//     node dev/verify_typstproject.mjs              # the code as it stands
//     TYPST_BROKEN=1 node dev/verify_typstproject.mjs
//
// `TYPST_BROKEN=1` reads the one file and compiles it through
// `window.DaimondTypst.compile(text)`.  That is not a simulation of the old code: it is
// what `Tool::TypstCompile` did, line for line, until seq 117, and it is still the right
// door for a source with no project behind it.  Every project claim below must fail
// under it.  A check that stays green there is checking nothing.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';
import { open, shot } from './harness.mjs';

const HERE  = dirname(fileURLToPath(import.meta.url));
const FIX   = pjoin(HERE, 'fixtures', 'typstproj');
const BROKEN = process.env.TYPST_BROKEN === '1';

// The author's own book, which is the external oracle for everything below: nothing in
// it was written to make a test pass.  Skipped, loudly, on a machine that has not got it.
const BOOK = process.env.DAIMOND_BOOK || `${process.env.HOME}/usr/books/elearnity`;
const BOOK_MAIN = 'CheapThinking/thinking.typ';

const ok = [], bad = [], skipped = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const skip = (name, why) => {
	skipped.push(name);
	console.log('  skip ' + name + ' — ' + why);
};

// The fixture, read once on this side.  `text` files go in as strings so a failure
// message can quote them; the font goes in as bytes.
const FILES = [
	['books/proj/main.typ',        'text'],
	['books/proj/template.typ',    'text'],
	['books/proj/parts/util.typ',  'text'],
	['books/proj/chap01.typ',      'text'],
	['books/shared/glo.typ',       'text'],
	['books/assets/mark.svg',      'text'],
	['books/assets/fonts/Radley-Regular.ttf', 'bytes'],
];
const CONTENT = {};
for (const [rel, kind] of FILES) {
	CONTENT[rel] = kind === 'text'
		? readFileSync(pjoin(FIX, rel), 'utf8')
		: Array.from(readFileSync(pjoin(FIX, rel)));
}
const SOLO = readFileSync(pjoin(FIX, 'solo/main.typ'), 'utf8');

const s = await open({ name: 'typstproject' });
const p = s.page;
await p.waitForTimeout(1500);

// Every claim below is about an account that HOLDS the typesetting pack, which is the
// condition under which "it compiles" was ever true.  Stated and asserted rather than
// inherited from a fresh profile that happened to be told nothing.
const held = await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_locked_packs('');
	return mod.tool_locked('typst_compile');
});
check('the account these claims are made about holds the typesetting pack',
	held === false, `typst_compile locked: ${held}`);

/// Seed a private workspace with `files`, then compile `main` in it AS THE MODEL DOES:
/// by calling the tool `typst_compile` by wire name with a `path` argument.
///
/// Each variant gets its own account namespace, so withholding a file in one cannot
/// leave a stale copy behind for the next -- a shared workspace is exactly how a
/// withheld-file check would go green for the wrong reason.
///
/// The PDF is read back out of the workspace rather than taken from a return value,
/// because writing it there is part of what the tool promises.
async function compileIn(tag, files, main, broken) {
	return await p.evaluate(async ({ tag, files, main, broken }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		mod.set_account_ns('d~tp_' + tag);
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		for (const f of files) {
			if (typeof f[1] === 'string') {
				await app.run_tool('file_write', JSON.stringify({ path: f[0], content: f[1] }));
			} else {
				await app.write_bytes(f[0], new Uint8Array(f[1]));
			}
		}
		let said = '';
		if (broken) {
			// `Tool::TypstCompile` as it stood until seq 117, verbatim: read the one file,
			// hand the driver the string.
			const text = await app.run_tool('file_read', JSON.stringify({ path: main }));
			const out = await window.DaimondTypst.compile(text);
			said = (out && out.error) ? 'Error: ' + out.error : '';
			if (out && out.pdf) await app.write_bytes(main.replace(/\.typ$/i, '.pdf'), out.pdf);
		} else {
			said = await app.run_tool('typst_compile', JSON.stringify({ path: main }));
		}
		let pdf = null;
		if (said.indexOf('Error:') !== 0) {
			try { pdf = await mod.read_bytes(main.replace(/\.typ$/i, '.pdf'), 0, 40000000); }
			catch (e) { pdf = null; }
		}
		mod.set_account_ns('');
		return {
			said: said,
			error: said.indexOf('Error:') === 0 ? said.slice(6).trim() : '',
			bytes: pdf ? pdf.length : 0,
			magic: pdf ? String.fromCharCode.apply(null, Array.from(pdf.slice(0, 5))) : '',
			// A PDF names every font it embeds in its descriptors, so this is a direct
			// question about which family was actually drawn with -- not about which
			// one the source asked for.
			radley: pdf ? new TextDecoder('latin1').decode(pdf).indexOf('Radley') >= 0 : false,
		};
	}, { tag, files, main, broken });
}

/// The same, by the Doc panel's door, which returns a structured refusal.
async function panelIn(tag, files, main) {
	return await p.evaluate(async ({ tag, files, main }) => {
		const mod = await import('../pkg/oxedyne_daimond.js');
		mod.set_account_ns('d~tpp_' + tag);
		const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
		for (const f of files) {
			if (typeof f[1] === 'string') {
				await app.run_tool('file_write', JSON.stringify({ path: f[0], content: f[1] }));
			} else {
				await app.write_bytes(f[0], new Uint8Array(f[1]));
			}
		}
		const out = await mod.typst_compile_project(main);
		mod.set_account_ns('');
		return {
			error: (out && out.error) || '',
			bytes: out && out.pdf ? out.pdf.length : 0,
			remedy: (out && out.remedy) ? { action: out.remedy.action, path: out.remedy.path, line: out.remedy.line } : null,
		};
	}, { tag, files, main });
}

const all = () => FILES.map(([rel]) => [rel, CONTENT[rel]]);
const without = (drop) => FILES.filter(([rel]) => rel !== drop).map(([rel]) => [rel, CONTENT[rel]]);
const MAIN = 'books/proj/main.typ';

// ── 1. The whole project, through the tool the model calls ──────────────────
const whole = await compileIn('whole', all(), MAIN, BROKEN);
check('the MODEL\'S TOOL compiles a multi-file project to a real PDF',
	whole.error === '' && whole.magic === '%PDF-' && whole.bytes > 1000,
	whole.error ? whole.error.slice(0, 260) : `${whole.bytes} bytes, magic "${whole.magic}"`);

// The root is the claim underneath that one.  `main.typ` imports `../shared/glo.typ`,
// so a compile that succeeds can only have put the root at `books/` -- one level ABOVE
// the directory the compiled file sits in, which is what `typst --root` is passed on the
// author's command line and what his attachment got wrong.
check('the project root climbs above the compiled file when an import climbs',
	whole.error === '' && whole.bytes > 1000,
	whole.error ? whole.error.slice(0, 200) : 'compiled with ../shared/glo.typ resolved');

// ── 2. The font is the one the source asked for ─────────────────────────────
check('the family the source names is the family embedded in the PDF',
	whole.radley === true,
	`Radley in the PDF: ${whole.radley}`);

// ── 3. Withhold each file, and demand the refusal name it ───────────────────
//
// The old message named nothing at all: it said "cannot read file outside of project
// root" whatever was missing, which is why one wrong sentence produced one wrong
// diagnosis.  These assert the PROPERTY -- the name of the thing that is absent appears
// in the reason -- and never a fixed string, so rewording the explanation cannot make
// them lie.
const WITHHELD = [
	['books/proj/template.typ',   'template.typ',       'a sibling import'],
	['books/proj/parts/util.typ', 'parts/util.typ',     'a sub-directory import'],
	['books/shared/glo.typ',      '../shared/glo.typ',  'an import that climbs'],
	['books/assets/mark.svg',     '/assets/mark.svg',   'an absolute asset path'],
	['books/proj/chap01.typ',     'chap01.typ',         'a chapter include'],
];
//
// Each one carries TWO conditions beyond "it failed and said the name", because on the
// single-file compiler the first import fails whatever is missing -- so "withholding
// template.typ names template.typ" would go green on the very bug this file exists to
// catch.  The refusal must therefore also name NOTHING THAT WAS SUPPLIED, and the whole
// project must have compiled when nothing was withheld.  Neither is true of a compiler
// that only ever sees one file, and neither depends on a word of the wording.
for (const [drop, named, what] of WITHHELD) {
	const tag = drop.replace(/[^a-z0-9]/gi, '');
	const r = await compileIn(tag, without(drop), MAIN, BROKEN);
	const others = WITHHELD.map(w => w[1]).filter(n => n !== named && named.indexOf(n) < 0);
	const wrong = others.filter(n => r.error.indexOf(n) >= 0);
	check(`withholding ${what} fails, and the reason names "${named}" and nothing present`,
		whole.error === '' && r.bytes === 0 && r.error.indexOf(named) >= 0 && wrong.length === 0,
		r.bytes ? `it compiled anyway (${r.bytes} bytes)`
			: (wrong.length ? `it blamed a file that was supplied: ${wrong.join(', ')}`
				: r.error.slice(0, 200)));
	// And it must not lead with the sentence that misled the author: typst's own words
	// are kept, but underneath, after an explanation of what actually happened here.
	const said = r.error.indexOf('typst said:');
	const root = r.error.indexOf('--root argument');
	check(`  and does not lead with typst's "--root" hint`,
		r.bytes === 0 && (root < 0 || (said >= 0 && root > said)),
		`explanation at ${said}, typst's hint at ${root}`);
}

// ── 4. The root the refusal quotes ──────────────────────────────────────────
const noAsset = await compileIn('rootquote', without('books/assets/mark.svg'), MAIN, BROKEN);
check('a refusal says where the project root was put',
	noAsset.bytes === 0 && /root was put at books\b/.test(noAsset.error),
	noAsset.error.slice(0, 200));
// And where it LOOKED for the picture, which is not the root: the search runs from the
// compiled file's own folder outward.  Naming only the root sent the author looking in
// the wrong folder for something that was never expected to be there.
check('  and names the folders a root-relative name was looked for in',
	noAsset.bytes === 0 && /books\/proj/.test(noAsset.error),
	noAsset.error.slice(0, 260));

// ── 5. Fonts: refuse rather than approximate ────────────────────────────────
//
// This is a correctness claim, not a nicety.  The control below shows what silence
// looks like: the same document, with no Radley anywhere, compiles happily through the
// single-file door and returns a PDF nobody would question.  Line breaks, last lines
// and page count all come from the metrics of whatever got substituted, so a book
// proofread against that PDF is a book proofread against a document that will never
// print.  Nothing in typst says a word about it -- measured: this build reports
// diagnostics only when a compile FAILS, and a missing family does not fail.
const noFont = await compileIn('nofont', without('books/assets/fonts/Radley-Regular.ttf'), MAIN, BROKEN);
check('a project whose font cannot be loaded is refused, not approximated',
	noFont.bytes === 0 && /Radley/.test(noFont.error),
	noFont.bytes ? `it compiled in a substitute font (${noFont.bytes} bytes)` : noFont.error.slice(0, 220));
check('  and the refusal says where to put the font',
	noFont.bytes === 0 && /fonts/.test(noFont.error),
	noFont.error.slice(0, 200));

// The control goes STRAIGHT TO THE VENDORED COMPILER, underneath both doors, because
// that is where the silence lives.  Same source, same fonts, nothing in the way: a PDF
// comes back, no diagnostic comes with it, and the family the source asked for is not
// the family in the file.  This is the behaviour the two refusals above exist to stop,
// and if it ever changes -- if typst starts warning -- this check going red is how we
// find out that the refusals could be replaced by something better.
const silent = await p.evaluate(async () => {
	const VENDOR = new URL('/vendor/typst/', location.href);
	const mod = await import(new URL('typst_ts_web_compiler.mjs', VENDOR).href);
	await mod.default(new URL('typst_ts_web_compiler_bg.wasm', VENDOR));
	const b = new mod.TypstCompilerBuilder();
	b.set_dummy_access_model();
	for (const n of ['LibertinusSerif-Regular.otf', 'LibertinusSerif-Bold.otf',
		'LibertinusSerif-Italic.otf', 'LibertinusSerif-BoldItalic.otf', 'NewCMMath-Regular.otf']) {
		const r = await fetch(new URL('fonts/' + n, VENDOR));
		await b.add_raw_font(new Uint8Array(await r.arrayBuffer()));
	}
	const c = await b.build();
	c.reset_shadow();
	c.add_source('/m.typ', '#set text(font: "Radley")\n= Hello\n\nBody text.\n');
	const ret = c.compile('/m.typ', undefined, 'pdf', 3);
	const pdf = ret instanceof Uint8Array ? ret : (ret && (ret.result || ret.artifact));
	return {
		bytes: pdf ? pdf.length : 0,
		diag: ret && ret.diagnostics ? JSON.stringify(ret.diagnostics).length : 0,
		radley: pdf ? new TextDecoder('latin1').decode(pdf).indexOf('Radley') >= 0 : false,
	};
});
check('CONTROL: typst itself substitutes a missing font in silence — a PDF, no warning, wrong face',
	silent.bytes > 1000 && silent.diag === 0 && silent.radley === false,
	`${silent.bytes} bytes, ${silent.diag} bytes of diagnostics, Radley embedded: ${silent.radley}`);

// And the single-file door refuses the same document, because a lone source can never
// bring a font with it -- there is nothing it could be satisfied by.
const oneFile = await p.evaluate(async () => {
	const r = await window.DaimondTypst.compile('#set text(font: "Radley")\n= Hello\n\nBody text.\n');
	return { bytes: r && r.pdf ? r.pdf.length : 0, error: (r && r.error) || '' };
});
check('the single-file door refuses a font it could never have',
	oneFile.bytes === 0 && /Radley/.test(oneFile.error),
	oneFile.bytes ? `it compiled in a substitute (${oneFile.bytes} bytes)` : oneFile.error.slice(0, 200));

// ── 5b. A registry package is a fourth kind of failure ──────────────────────
//
// The four ways a compile can fail need four different actions from whoever reads the
// message, and telling them apart is the whole point of composing it here.  A missing
// file wants finding; a path above the root wants a different folder attached; a font
// wants a font file; and a `@preview/…` package wants NONE OF THOSE -- it is fetched
// from Typst Universe over a network this compiler does not have, and no rearrangement
// of files will ever satisfy it.  In the session that prompted this work the daimon
// spent several turns hunting assets and then rewrote the author's book source to work
// around a message that never said which of the four it was.
const pkg = await compileIn('pkg',
	[['pkgproj/main.typ', '#import "@preview/cetz:0.3.4"\n\n= Drawing\n']],
	'pkgproj/main.typ', BROKEN);
check('a registry package is refused as a package, not as a missing file',
	whole.error === '' && pkg.bytes === 0
		&& pkg.error.indexOf('@preview/cetz:0.3.4') >= 0
		&& /registry/i.test(pkg.error) && /network/i.test(pkg.error),
	pkg.bytes ? `it compiled anyway (${pkg.bytes} bytes)` : pkg.error.slice(0, 240));
check('  and says plainly that moving files will not fix it',
	whole.error === '' && pkg.bytes === 0 && /not a (missing file|path problem)/i.test(pkg.error),
	pkg.error.slice(0, 200));

// ── 6. Reaching above the marked folder, and what to DO about it ────────────
//
// The author's attachment was one level too deep, and "cannot read file outside of
// project root" is a terrible way to be told so.  This asks for the fix by name -- and
// then asks for it as an ACTION, because prose is what the daimon got wrong: it read a
// correct refusal, concluded the compiler could not do imports at all, and told the
// user to attach a folder that was already open and named in the same sentence.
const solo = await compileIn('solo', [['solo/main.typ', SOLO]], 'solo/main.typ', BROKEN);
check('a project that reaches above the marked folder says to mark the one above it',
	// "mark", not "above": the fixture's own import is literally `../../above.typ`, so a
	// test for the word "above" passes on a message that merely quotes the line -- which
	// is exactly what the single-source refusal does.
	solo.bytes === 0 && /\bmark\b/i.test(solo.error) && solo.error.indexOf('../../above.typ') >= 0,
	solo.bytes ? `it compiled anyway (${solo.bytes} bytes)` : solo.error.slice(0, 240));
check('  and carries a machine-readable remedy, not only advice',
	solo.bytes === 0 && /\bREMEDY mark-above folder=\S+ because=\S+ needs=\S+/.test(solo.error),
	solo.error.slice(-160));
// The same refusal by the panel's door arrives STRUCTURED, so the page can draw it as a
// button instead of asking the reader to translate a paragraph into a click.
const soloPanel = BROKEN ? null : await panelIn('solo', [['solo/main.typ', SOLO]], 'solo/main.typ');
if (soloPanel) {
	check('  and the panel gets it as a field it can draw as a button',
		soloPanel.bytes === 0 && soloPanel.remedy !== null
			&& soloPanel.remedy.action === 'mark-above' && soloPanel.remedy.path === 'solo',
		JSON.stringify(soloPanel.remedy));
} else {
	skip('  and the panel gets it as a field it can draw as a button', 'the panel door is not the broken path');
}

// ── 7. The walk is bounded, and says so rather than compiling a part ────────
//
// A cap that truncates is worse than no cap: the PDF comes out, a chapter is missing,
// and nobody is told.  So the claim is not "it stops" but "it stops WITHOUT producing
// a PDF, and names the limit".  The control immediately after is a project of the same
// shape, comfortably under the cap, which must still compile -- otherwise this check
// would pass just as well on a compiler that had stopped working altogether.
function chain(n) {
	const files = [];
	let main = '';
	for (let i = 0; i < n; i++) {
		files.push([`cap/f${i}.typ`, `#let v${i}() = [${i}]\n`]);
		main += `#import "f${i}.typ": v${i}\n`;
	}
	files.push(['cap/main.typ', main + '= Capped\n']);
	return files;
}
const over = await compileIn('capover', chain(520), 'cap/main.typ', BROKEN);
check('past the file cap the compile refuses and names the limit',
	over.bytes === 0 && /\b500\b/.test(over.error),
	over.bytes ? `it compiled a partial project (${over.bytes} bytes)` : over.error.slice(0, 200));
const under = await compileIn('capunder', chain(60), 'cap/main.typ', BROKEN);
check('CONTROL: the same shape under the cap still compiles',
	under.error === '' && under.bytes > 1000,
	under.error ? under.error.slice(0, 200) : `${under.bytes} bytes`);

// ── 8. The root is not the search path ──────────────────────────────────────
//
// The second fault, and the one that made the author's book uncompilable BOTH ways
// round.  His book imports `../style/…`, so the root must sit above the book; his fonts
// and his root-relative pictures live INSIDE the book.  While the font and asset search
// hung off the computed root, the arrangement that made the imports resolve was the
// arrangement that lost every font, and the compile was refused for a missing family
// that was sitting in the project all along.
//
// Same fixture, re-laid out: `inner/book/` reaching up to `inner/shared/`, with the
// pictures and fonts inside the book rather than beside the shared folder.  The root
// must come out at `inner` for the import, and `"/assets/mark.svg"` and the fonts must
// still be found at `inner/book/assets/…`.
const inner = (drop) => FILES.filter(([rel]) => rel !== drop).map(([rel]) => [
	rel.startsWith('books/assets/') ? 'inner/book/assets/' + rel.slice('books/assets/'.length)
		: rel.startsWith('books/proj/') ? 'inner/book/' + rel.slice('books/proj/'.length)
		: 'inner/shared/' + rel.slice('books/shared/'.length),
	CONTENT[rel],
]);
const nest = await compileIn('inner', inner(''), 'inner/book/main.typ', BROKEN);
check('a book that carries its own assets and fonts compiles with the root ABOVE it',
	nest.error === '' && nest.magic === '%PDF-' && nest.bytes > 1000,
	nest.error ? nest.error.slice(0, 300) : `${nest.bytes} bytes`);
check('  and the font came from the book\'s own folder, not from the root',
	nest.radley === true, `Radley in the PDF: ${nest.radley}`);
// The picture is the other half of the same claim, and it is asserted by absence: take
// it away and the compile must fail naming it, so its presence above cannot be an
// accident of a compiler that ignores pictures.
const nestNoPic = await compileIn('innernopic', inner('books/assets/mark.svg'), 'inner/book/main.typ', BROKEN);
check('  and a root-relative picture inside the book is really being gathered',
	nest.error === '' && nestNoPic.bytes === 0 && nestNoPic.error.indexOf('/assets/mark.svg') >= 0,
	nestNoPic.bytes ? `it compiled without the picture (${nestNoPic.bytes} bytes)` : nestNoPic.error.slice(0, 200));

// ── 9. A project that declares its own root is taken at its word ────────────
//
// `typst.toml` is typst's own manifest, and where a project has one it says where the
// project starts.  The closure here sits entirely inside `tt/book`, so the root would
// otherwise be inferred as `tt/book`; the manifest one level up moves it, which is
// visible in the folder a refusal quotes.
const MANIFEST = [
	['tt/typst.toml', '[package]\nname = "demo"\nversion = "0.1.0"\nentrypoint = "book/main.typ"\n'],
	['tt/book/main.typ', '#import "part.typ": bit\n\n= Declared\n\n#bit\n\n#image("/assets/mark.svg", width: 20pt)\n'],
	['tt/book/part.typ', '#let bit = [a part]\n'],
];
const manifest = await compileIn('manifest', MANIFEST, 'tt/book/main.typ', BROKEN);
check('a typst.toml above the file declares the root, and the refusal quotes it',
	manifest.bytes === 0 && /root was put at tt\b/.test(manifest.error),
	manifest.error.slice(0, 220));

// ── 10. The author's own book ───────────────────────────────────────────────
//
// Everything above is a fixture written by the same hand that wrote the code, which
// proves consistency and not correctness.  This is the oracle: 63 sources, 24 fonts and
// three pictures, none of them arranged for this file, laid out the two ways the author
// might mark the folder in.
if (!existsSync(pjoin(BOOK, BOOK_MAIN))) {
	skip('the author\'s real book gathers', `no book at ${BOOK}`);
} else {
	const lits = (t) => Array.from(t.matchAll(/"([^"\n]*)"/g)).map(m => m[1]);
	const seen = new Set([BOOK_MAIN]);
	const q = [BOOK_MAIN];
	const pics = new Set();
	while (q.length) {
		const f = q.pop();
		const dir = f.indexOf('/') >= 0 ? f.slice(0, f.lastIndexOf('/')) : '';
		let text; try { text = readFileSync(pjoin(BOOK, f), 'utf8'); } catch { continue; }
		for (const l of lits(text)) {
			if (l.startsWith('@')) continue;
			const e = (l.split('/').pop().split('.').pop() || '').toLowerCase();
			if (e === 'typ') {
				if (l.startsWith('/')) continue;
				const segs = (dir ? dir + '/' + l : l).split('/');
				const out = [];
				let bad = false;
				for (const sg of segs) {
					if (sg === '' || sg === '.') continue;
					if (sg === '..') { if (!out.length) { bad = true; break; } out.pop(); continue; }
					out.push(sg);
				}
				const path = out.join('/');
				if (bad || seen.has(path) || !existsSync(pjoin(BOOK, path))) continue;
				seen.add(path); q.push(path);
			} else if (['svg', 'png', 'jpg', 'jpeg', 'webp'].includes(e) && l.startsWith('/')) {
				pics.add(l.slice(1));
			}
		}
	}
	const fontFiles = [];
	(function walk(d) {
		for (const n of readdirSync(pjoin(BOOK, d))) {
			const rel = d + '/' + n;
			if (statSync(pjoin(BOOK, rel)).isDirectory()) walk(rel);
			else if (/\.(ttf|otf|ttc)$/i.test(n)) fontFiles.push(rel);
		}
	})('assets/fonts');

	// The book's sources, verbatim except for two lines that no rearrangement of files
	// could ever satisfy: `book_template.typ` imports `@preview/cetz` and
	// `@preview/cetz-plot` and uses neither, and the chapter-two figures are drawn with
	// cetz.  Those are a REGISTRY problem, refused correctly and separately (§5b), and
	// they would otherwise stop this compile before it reached a single question about
	// roots, pictures or fonts.  Everything else -- 63 files, a glossary, an index, 17
	// chapters -- is the author's own.
	const STUB = '// Registry figures stubbed for this check; see verify_typstproject.mjs §10.\n'
		+ '#let fig-ceilings = rect(width: 100%, height: 4cm)[]\n'
		+ '#let fig-thinking-time = rect(width: 100%, height: 4cm)[]\n';
	const bookSrc = [...seen].map((rel) => {
		let text = readFileSync(pjoin(BOOK, rel), 'utf8');
		if (rel.endsWith('thinking_chap_02_figures.typ')) text = STUB;
		else text = text.split('\n').filter(l => !/^#import\s+"@preview\//.test(l)).join('\n');
		return [rel, text];
	});
	const bookBin = [...pics, ...fontFiles].map(rel => [rel, Array.from(readFileSync(pjoin(BOOK, rel)))]);
	console.log(`  ..   the real book: ${bookSrc.length} sources, ${pics.size} pictures, ${fontFiles.length} fonts`);

	// (a) The folder above the book is marked in -- the arrangement that makes the
	//     `../style/…` imports resolve -- and the book's own `assets` is what a copy of
	//     it looks like when the symlink has not been followed: inside the book, one
	//     level below the root the imports force.  This is the shape that lost every
	//     font, and it is where the author's book actually failed.
	const inBook = bookSrc.concat(bookBin.map(([rel, b]) => ['CheapThinking/' + rel, b]));
	const real = await compileIn('realbook', inBook, BOOK_MAIN, BROKEN);
	check('THE REAL BOOK compiles with the root above it and its assets inside it',
		real.error === '' && real.magic === '%PDF-' && real.bytes > 20000,
		real.error ? real.error.slice(0, 400) : `${real.bytes} bytes`);
	check('  and it is set in the family the book asks for',
		real.radley === true, `Radley in the PDF: ${real.radley}`);

	// (b) The same book with the shared tree's assets where the disk really keeps them,
	//     beside the book rather than inside it. Both must work, because which one the
	//     user gets depends on whether a symlink was followed by whatever copied it.
	const beside = bookSrc.concat(bookBin);
	const real2 = await compileIn('realbook2', beside, BOOK_MAIN, BROKEN);
	check('  and again with the shared assets beside the book instead of inside it',
		real2.error === '' && real2.bytes > 20000,
		real2.error ? real2.error.slice(0, 300) : `${real2.bytes} bytes`);

	// (c) The book folder marked in on its own, which is the mistake anybody would make.
	//     There is no reading above a marked folder -- the mark IS the permission -- so
	//     the only honest answer is a refusal that names the import that reaches out and
	//     carries the action to take.
	const onlyBook = inBook
		.filter(([rel]) => rel.startsWith('CheapThinking/'))
		.map(([rel, c]) => [rel.slice('CheapThinking/'.length), c]);
	const tooDeep = await compileIn('realbookdeep', onlyBook, 'thinking.typ', BROKEN);
	check('  and marking only the book folder is refused by name, with the remedy attached',
		tooDeep.bytes === 0
			&& tooDeep.error.indexOf('../style/glossary_index.typ') >= 0
			&& /REMEDY mark-above/.test(tooDeep.error),
		tooDeep.error.slice(0, 300));
}

await shot(s, 'typstproject');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed, ${skipped.length} skipped`
	+ (BROKEN ? '   (TYPST_BROKEN=1)' : ''));
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
