// verify_typstproject.mjs — a book is a project, and every file it names must arrive.
//
// The author tried to compile a 17-chapter book by the Doc panel's Compile button and
// by asking his daimon, and both failed on line one with
//
//     failed to load file (access denied), hints: cannot read file outside of project
//     root, you can adjust the project root with the --root argument
//
// Two defects, one session.  The compiler was handed EXACTLY ONE FILE and its shadow
// filesystem was wiped before every compile, so an `#import` could never resolve; and
// the message it failed with describes a setting that does not exist here, so the
// daimon reading it concluded the book's images were out of bounds and spent the hour
// hunting assets that were never the problem.
//
// This file asserts the properties that had to become true, and it asserts them by
// TAKING A FILE AWAY.  Compiling the whole fixture proves only that something worked;
// withholding each file in turn and demanding that the refusal NAME THE FILE is what
// proves the project is really being gathered and the message is really being composed
// from what this side knows.
//
// Run it red before you believe it green:
//
//     node dev/verify_typstproject.mjs              # the code as it stands
//     TYPST_BROKEN=1 node dev/verify_typstproject.mjs
//
// `TYPST_BROKEN=1` compiles through `window.DaimondTypst.compile(sourceText)` -- which
// is not a simulation of the old code, it IS the old code, still exported for a source
// with no project behind it.  Every project claim below must fail under it.  A check
// that stays green there is checking nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';
import { open, shot } from './harness.mjs';

const HERE  = dirname(fileURLToPath(import.meta.url));
const FIX   = pjoin(HERE, 'fixtures', 'typstproj');
const BROKEN = process.env.TYPST_BROKEN === '1';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
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

/// Seed a private workspace with `files`, then compile `main` in it.
///
/// Each variant gets its own account namespace, so withholding a file in one cannot
/// leave a stale copy behind for the next -- a shared workspace is exactly how a
/// withheld-file check would go green for the wrong reason.
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
		let out;
		if (broken) {
			// The pre-fix path, verbatim: read the one file, hand the driver a string.
			const text = await app.run_tool('file_read', JSON.stringify({ path: main }));
			out = await window.DaimondTypst.compile(text);
		} else {
			out = await mod.typst_compile_project(main);
		}
		mod.set_account_ns('');
		const pdf = out && out.pdf ? out.pdf : null;
		return {
			error: (out && out.error) || '',
			bytes: pdf ? pdf.length : 0,
			magic: pdf ? String.fromCharCode.apply(null, Array.from(pdf.slice(0, 5))) : '',
			// A PDF names every font it embeds in its descriptors, so this is a direct
			// question about which family was actually drawn with -- not about which
			// one the source asked for.
			radley: pdf ? new TextDecoder('latin1').decode(pdf).indexOf('Radley') >= 0 : false,
		};
	}, { tag, files, main, broken });
}

const all = () => FILES.map(([rel]) => [rel, CONTENT[rel]]);
const without = (drop) => FILES.filter(([rel]) => rel !== drop).map(([rel]) => [rel, CONTENT[rel]]);
const MAIN = 'books/proj/main.typ';

// ── 1. The whole project ────────────────────────────────────────────────────
const whole = await compileIn('whole', all(), MAIN, BROKEN);
check('a multi-file project compiles to a real PDF',
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

// ── 6. Reaching above the attached folder ───────────────────────────────────
//
// The author's attachment was one level too deep, and "cannot read file outside of
// project root" is a terrible way to be told so.  This asks for the fix by name.
const solo = await compileIn('solo', [['solo/main.typ', SOLO]], 'solo/main.typ', BROKEN);
check('a project that reaches above the attached folder says to attach the parent',
	solo.bytes === 0 && /parent/i.test(solo.error) && solo.error.indexOf('../../above.typ') >= 0,
	solo.bytes ? `it compiled anyway (${solo.bytes} bytes)` : solo.error.slice(0, 240));

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

await shot(s, 'typstproject');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed` + (BROKEN ? '   (TYPST_BROKEN=1)' : ''));
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
