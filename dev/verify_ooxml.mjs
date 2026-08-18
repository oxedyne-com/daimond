// verify_ooxml.mjs — a THIRD instrument over the Office writers, because two
// were not enough and one of the two has never read a Microsoft format.
//
// WHAT WAS ACTUALLY BEING RELIED ON. Every claim about `.docx`, `.xlsx` and
// `.pptx` rested on LibreOffice: `soffice --headless --convert-to` round-trips a
// file and a real reader says whether it agrees. It earned that place at once —
// it found a `.ods` string cell written without `<text:p>` that showed as EMPTY
// in LibreOffice while a numeric cell showed fine, so the cells hardest to notice
// losing were exactly the ones lost. But the reader the Microsoft formats are FOR
// is Excel, and there is no Excel and no Windows on this machine. Leading with
// `.docx` because "most other users use MS formats, I do not, I want to cater to
// them" put the one reader the work targets outside the test.
//
// An oracle also checks your OUTPUT and is silent about your INPUT. LibreOffice
// could never have found the OpenFormula bracketing bug, because there the file
// was right and our READER was wrong. Two instruments, two classes of defect.
// This is a third: the SPECIFICATION as the judge, plus four readers written by
// strangers.
//
//   1. the ECMA-376 4th edition TRANSITIONAL schemas — `wml.xsd`, `sml.xsd`,
//      `pml.xsd`, `dml-main.xsd` and the OPC pair — through libxml2, which is
//      the closest thing to an authority a Linux box holds;
//   2. the OPC package graph, from ECMA-376 Part 2, checked directly: every
//      `r:id` resolves, every part has a content type, no relationship dangles,
//      no part is stranded. Excel's "we found a problem with some content" is
//      very often exactly one of these and names none of them;
//   3. `openpyxl`, `python-docx`, `python-pptx` and `odfpy` — four codebases that
//      have never seen ours or LibreOffice's — opening the files and giving back
//      the words that went in;
//   4. the four things ECMA-376 says about `xl/calcChain.xml`, which is the part
//      the `.xlsx` editor DELETES and which no reader on this machine reads;
//   5. the OASIS OpenDocument RELAX NG grammars, 1.2 and 1.3, for the other three
//      formats — OpenDocument is normatively a grammar and not a schema, and
//      libxml2 validates against it, so the `.odt` / `.ods` / `.odp` side gets an
//      authority too rather than only a reader;
//   6. three things Excel enforces that NO schema states: two tabs may not share
//      a name, `<dimension>` must cover the cells, and a `count` on the shared
//      string table means the number of references and not the number of strings.
//
// The name says OOXML because that was the hole. It grew the OpenDocument half
// because the same instrument reached, and (5) found two defects in ten minutes.
//
// THE CONTROL SET IS THE POINT. Every rule is also run over `rich.docx`,
// `foreign.xlsx` and `foreign.pptx`, which LibreOffice wrote and we did not, so
// the instrument's own false positives are visible instead of being argued about.
// Two survive after ECMA-376 Part 3 markup-compatibility preprocessing, both
// places where the ECMA schemas disagree with every real file, and both named in
// `ooxml_check.py`. A finding that the control set also produces is reported as
// noise. Anything our output produces and the control does not is ours.
//
// AND THE INSTRUMENT IS PROVED TO GO RED. `--selftest` damages a good package in
// five known ways — a part loses its content type, an `r:id` points at nothing, a
// relationship target leaves the package, a cell a chain names loses its formula,
// an attribute takes a value its type forbids — and reports whether the rule that
// should catch each one did. A rule that cannot fail is not a check.
//
// WHAT THIS CANNOT DO. It cannot tell you Excel opens the file. Schema validity
// is necessary and not sufficient: Excel refuses things the schema permits — the
// `styles.xml` fill table is in the writer for exactly that reason — and repairs
// things the schema forbids. The one honest answer to "does Excel open it" is to
// open one in Excel.
//
// Run: node dev/verify_ooxml.mjs [--selftest] [--keep]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE  = path.dirname(new URL(import.meta.url).pathname);
const ROOT  = path.resolve(HERE, '..');
const CACHE = path.join(os.homedir(), '.cache', 'daimond', 'laneE');
const OUT   = path.join(CACHE, 'out');
const XSD   = path.join(CACHE, 'schemas', 'xsd');
const PYLIB = path.join(CACHE, 'pylibs');
const CHECK = path.join(HERE, 'fixtures', 'ooxml', 'ooxml_check.py');
const DATA  = path.resolve(ROOT, '../../../../rust/fe2o3/fe2o3_file/tests/data');

const args = process.argv.slice(2);

let pass = 0, fail = 0, noted = 0;
const check = (ok, name, detail) => {
	if (ok) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); }
};
const note = (name, detail) => {
	noted++;
	console.log('  note ' + name + (detail ? '\n         ' + detail : ''));
};

// ---------------------------------------------------------------------------
// The instruments have to BE there, and the run says so before anything else
// ---------------------------------------------------------------------------

// NEITHER OF THESE LIVES IN THE REPO. The ECMA schemas are a 46 MB download and
// the Python readers are four packages, so both sit in `~/.cache/daimond/laneE/`
// and `--fetch` puts them there. That makes a missing instrument the most
// dangerous state this file can be in: a run that silently skipped the schemas
// and the second readers would print a page of `ok` and mean nothing, which is
// how a green suite comes to certify a format nobody validated. So a missing
// instrument is a FAILURE with the exact command to fix it, never a skip.
//
// WHAT `--fetch` DOWNLOADS, EXACTLY:
//
//  * https://ecma-international.org/wp-content/uploads/ECMA-376_4th_edition_december_2012.zip
//    (46,635,356 bytes) — ECMA's own publication. Part 4 of it holds
//    `OfficeOpenXML-XMLSchema-Transitional.zip`, which is the schema set for the
//    `schemas.openxmlformats.org/...2006/...` namespaces every file here uses.
//    The STRICT set shipped with Part 1 is the wrong one: it carries the
//    `purl.oclc.org` namespaces and matches nothing we write.
//  * https://ecma-international.org/wp-content/uploads/ECMA-376-2_5th_edition_december_2021.zip
//    (1,899,204 bytes) — Part 2, for `opc-contentTypes.xsd` and
//    `opc-relationships.xsd`.
//  * https://www.w3.org/2001/xml.xsd — because ECMA's `wml.xsd` declares
//    `<xsd:import namespace=".../XML/1998/namespace"/>` with NO `schemaLocation`,
//    and libxml2 will not resolve `xml:space` without one. `--fetch` adds the
//    location to a copy. That is the only edit made to any ECMA file, and it adds
//    nothing to the schema's meaning.
//  * the OASIS OpenDocument RELAX NG grammars, 1.2 and 1.3, from
//    docs.oasis-open.org. BOTH, because OpenDocument is normatively a RELAX NG
//    grammar rather than an XML Schema and the version is chosen by what the file
//    declares: LibreOffice still writes 1.2, and validating a 1.2 file against the
//    1.3 grammar reports the version attribute and then cascades through the
//    interleave — dozens of findings about nothing. Picking by `office:version`
//    took the control set from 40 errors to none.
//  * openpyxl, python-docx, python-pptx and odfpy from PyPI, into
//    `~/.cache/daimond/laneE/pylibs` with `pip3 install --target`. Nothing is
//    installed into the system or into the project.

const NEEDED = ['transitional/sml.xsd', 'transitional/wml.xsd',
	'transitional/pml.xsd', 'transitional/dml-main.xsd', 'transitional/xml.xsd',
	'opc/opc-contentTypes.xsd', 'opc/opc-relationships.xsd',
	'../rng/OpenDocument-v1.2-schema.rng', '../rng/OpenDocument-v1.3-schema.rng',
	'../rng/OpenDocument-v1.2-manifest-schema.rng',
	'../rng/OpenDocument-v1.3-manifest-schema.rng'];
const missing = NEEDED.filter((f) => !fs.existsSync(path.join(XSD, f)));
const readers = spawnSync('python3', ['-c',
	'import openpyxl, docx, pptx, odf, lxml; print("all four")'],
	{ env: { ...process.env, PYTHONPATH: PYLIB }, encoding: 'utf8' });

if (args.includes('--fetch')) {
	const sh = (cmd) => {
		console.log('  $ ' + cmd.replace(/\s+/g, ' ').slice(0, 110));
		const r = spawnSync('bash', ['-c', cmd], { stdio: 'inherit' });
		if (r.status !== 0) { console.log('  FAILED'); process.exit(1); }
	};
	const S = path.join(CACHE, 'schemas');
	sh(`mkdir -p ${S}/x ${XSD}`);
	sh(`cd ${S} && curl -sSf --max-time 600 -o ecma376-4e.zip `
		+ `https://ecma-international.org/wp-content/uploads/ECMA-376_4th_edition_december_2012.zip`);
	sh(`cd ${S} && curl -sSf --max-time 300 -o ecma376-2-5e.zip `
		+ `https://ecma-international.org/wp-content/uploads/ECMA-376-2_5th_edition_december_2021.zip`);
	sh(`cd ${S}/x && unzip -oq ../ecma376-4e.zip && unzip -oq ../ecma376-2-5e.zip `
		+ `&& unzip -oq "ECMA-376, Fourth Edition, Part 4 - Transitional Migration Features.zip" `
		+ `&& unzip -oq OfficeOpenXML-XMLSchema-Transitional.zip -d ${XSD}/transitional `
		+ `&& unzip -oq OpenPackagingConventions-XMLSchema.zip -d ${XSD}/opc`);
	sh(`chmod -R u+w ${XSD}`);
	sh(`curl -sSf --max-time 120 -o ${XSD}/transitional/xml.xsd https://www.w3.org/2001/xml.xsd`);
	sh(`python3 - <<'PY'
p = '${XSD}/transitional/wml.xsd'
s = open(p, encoding='utf-8').read()
old = '<xsd:import namespace="http://www.w3.org/XML/1998/namespace"/>'
new = '<xsd:import namespace="http://www.w3.org/XML/1998/namespace" schemaLocation="xml.xsd"/>'
open(p, 'w', encoding='utf-8').write(s.replace(old, new))
print('wml.xsd: xml namespace import given a schemaLocation')
PY`);
	sh(`mkdir -p ${S}/rng`);
	for (const [v, leaf] of [
			['v1.3/os', 'OpenDocument-v1.3-schema.rng'],
			['v1.3/os', 'OpenDocument-v1.3-manifest-schema.rng']]) {
		sh(`curl -sSf --max-time 240 -o ${S}/rng/${leaf} `
			+ `https://docs.oasis-open.org/office/OpenDocument/${v}/schemas/${leaf}`);
	}
	for (const [remote, leaf] of [
			['OpenDocument-v1.2-os-schema.rng', 'OpenDocument-v1.2-schema.rng'],
			['OpenDocument-v1.2-os-manifest-schema.rng',
				'OpenDocument-v1.2-manifest-schema.rng']]) {
		sh(`curl -sSf --max-time 240 -o ${S}/rng/${leaf} `
			+ `https://docs.oasis-open.org/office/v1.2/os/${remote}`);
	}
	sh(`pip3 install -q --disable-pip-version-check --target=${PYLIB} `
		+ `openpyxl python-docx python-pptx odfpy`);
	console.log('\ninstruments fetched; run again without --fetch');
	process.exit(0);
}

if (missing.length || readers.status !== 0) {
	console.log('\n  FAIL the instruments are not installed, so this run would '
		+ 'mean nothing');
	if (missing.length) {
		console.log('         no schemas at ' + XSD + ': missing ' + missing.join(', '));
	}
	if (readers.status !== 0) {
		console.log('         no independent readers at ' + PYLIB + ': '
			+ (readers.stderr || '').trim().split('\n').pop());
	}
	console.log('\n       node dev/verify_ooxml.mjs --fetch\n');
	console.log('       downloads the ECMA-376 schemas and the four Python readers '
		+ 'into\n       ~/.cache/daimond/laneE/. See the header for exactly what and '
		+ 'from where.');
	process.exit(1);
}
console.log('instruments: ECMA-376 4th edition transitional schemas, '
	+ readers.stdout.trim() + ' independent readers, LibreOffice not consulted');

// ---------------------------------------------------------------------------
// The wasm, loaded straight into node
// ---------------------------------------------------------------------------

// The bundle the app ships, not a rebuild of it: `wasm-bindgen`'s glue takes the
// module bytes as an argument, so nothing here needs a browser, a profile or a
// server. It is also the reason this verifier is seconds rather than minutes —
// and the reason it must NOT build: another lane owns `www/pkg`.
const PKG = path.join(ROOT, 'www', 'pkg');
if (!fs.existsSync(path.join(PKG, 'oxedyne_daimond_bg.wasm'))) {
	console.log('  FAIL www/pkg holds no wasm bundle; nothing to test');
	process.exit(1);
}
const wasm = await import(path.join(PKG, 'oxedyne_daimond.js'));
await wasm.default({ module_or_path: fs.readFileSync(
	path.join(PKG, 'oxedyne_daimond_bg.wasm')) });

// ---------------------------------------------------------------------------
// The specimens
// ---------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });

/// Markdown with one of everything a writer has to carry: two heading levels,
/// emphasis, a link, both kinds of list, a quotation, code, and a table — which
/// is what `Book::from_doc` turns into a sheet and `Deck::from_doc` into slides.
const MD = [
	'# Quarterly Review',
	'',
	'The **margin** held at *11 per cent*, and the [note](https://example.org/n)',
	'says why. A string of deliberate spaces:  and a value of 3.50 that is not a',
	'number.',
	'',
	'## Findings',
	'',
	'- Sales rose',
	'- Costs held',
	'  - Freight fell',
	'',
	'1. Reprice',
	'2. Restock',
	'',
	'> A quotation, kept as one.',
	'',
	'`inline code` and a block:',
	'',
	'```',
	'let x = 1;',
	'```',
	'',
	'| Region | Units | Price | Total |',
	'| --- | --- | --- | --- |',
	'| North | 120 | 3.4 | =B2*C2 |',
	'| South | 85 | 11 | =B3*C3 |',
	'',
	'## Notes',
	'',
	'Nothing further.',
	'',
].join('\n');

const specimens = [];
const put = (name, bytes) => {
	const p = path.join(OUT, name);
	fs.writeFileSync(p, Buffer.from(bytes));
	specimens.push(p);
	return p;
};

console.log('\nwritten from Markdown');
for (const [media, ext] of [['Docx', 'docx'], ['Xlsx', 'xlsx'], ['Pptx', 'pptx'],
		['Odt', 'odt'], ['Ods', 'ods'], ['Odp', 'odp']]) {
	try {
		const bytes = wasm.office_write(MD, media);
		put('written.' + ext, bytes);
		check(bytes.length > 0, `office_write(${media}) produced ${bytes.length} bytes`);
	} catch (e) {
		check(false, `office_write(${media})`, String(e && e.message ? e.message : e));
	}
}
try {
	const bytes = wasm.office_write_docx(MD);
	put('legacy.docx', bytes);
	check(bytes.length > 0, `office_write_docx produced ${bytes.length} bytes`);
} catch (e) {
	check(false, 'office_write_docx', String(e));
}

/// Two tables under headings that reduce to ONE tab name. `Book::from_doc` names a
/// sheet by the heading above its table and `xlsx::write::sheet_name` strips the
/// characters Excel refuses and truncates at 31, and neither step looks at the
/// names already handed out. Excel refuses a workbook with two tabs of one name,
/// and refuses the FILE rather than the name.
const CLASH = [
	'## Q1/Q2',
	'',
	'| A | B |',
	'| --- | --- |',
	'| 1 | 2 |',
	'',
	'## Q1:Q2',
	'',
	'| A | B |',
	'| --- | --- |',
	'| 3 | 4 |',
	'',
	'## A very long heading that runs past the thirty-one character limit, one',
	'',
	'| A | B |',
	'| --- | --- |',
	'| 5 | 6 |',
	'',
	'## A very long heading that runs past the thirty-one character limit, two',
	'',
	'| A | B |',
	'| --- | --- |',
	'| 7 | 8 |',
	'',
].join('\n');
try {
	const bytes = wasm.office_write(CLASH, 'Xlsx');
	put('clash.xlsx', bytes);
	check(bytes.length > 0, `a workbook from four clashing headings — ${bytes.length} bytes`);
} catch (e) {
	check(false, 'office_write(Xlsx) on clashing headings', String(e));
}

// ---------------------------------------------------------------------------
// The edits, on files this project did not write
// ---------------------------------------------------------------------------

const read = (p) => new Uint8Array(fs.readFileSync(p));

console.log('\nedited, on somebody else\'s bytes');

const edits = [
	// A surgical document edit. The rest of the archive must survive it.
	['edited.docx', () => wasm.office_edit_doc(read(path.join(DATA, 'rich.docx')),
		'Docx', JSON.stringify([{ find: 'Findings', replace: 'Conclusions' }]))],
	// A plain value into an empty cell of a sheet that has no calculation chain.
	['cell.xlsx', () => wasm.office_edit_sheet(read(path.join(DATA, 'foreign.xlsx')),
		'Xlsx', JSON.stringify([{ sheet: 'Sales', ref: 'B4', value: '42' }]))],
	// A FORMULA into a workbook that HAS a chain. The chain must go.
	['chain-formula.xlsx', () => wasm.office_edit_sheet(
		read(path.join(HERE, 'fixtures', 'ooxml', 'withchain.xlsx')),
		'Xlsx', JSON.stringify([{ sheet: 'Sales', ref: 'D4', formula: '=B2+B3' }]))],
	// A PLAIN VALUE over a cell that HELD a formula and IS in the chain. The
	// chain is now wrong in the other direction, and this is the case the
	// writer's own reasoning does not cover.
	['chain-plainover.xlsx', () => wasm.office_edit_sheet(
		read(path.join(HERE, 'fixtures', 'ooxml', 'withchain.xlsx')),
		'Xlsx', JSON.stringify([{ sheet: 'Sales', ref: 'D2', value: '999' }]))],
	// A cell far outside the declared dimension, which must widen.
	['grown.xlsx', () => wasm.office_edit_sheet(read(path.join(DATA, 'foreign.xlsx')),
		'Xlsx', JSON.stringify([{ sheet: 'Sales', ref: 'K40', value: 'edge' }]))],
	// A string that is nothing but spaces, and one that looks like a number.
	['spaces.xlsx', () => wasm.office_edit_sheet(read(path.join(DATA, 'foreign.xlsx')),
		'Xlsx', JSON.stringify([
			{ sheet: 'Sales', ref: 'A6', value: '   ' },
			{ sheet: 'Sales', ref: 'B6', value: '3.50' },
			{ sheet: 'Notes', ref: 'A1', value: 'moved' }]))],
];

for (const [name, run] of edits) {
	try {
		const bytes = run();
		put(name, bytes);
		check(bytes.length > 0, `${name} — ${bytes.length} bytes`);
	} catch (e) {
		check(false, name, String(e && e.message ? e.message : e));
	}
}

// ---------------------------------------------------------------------------
// The control set: the same rules over files nobody here wrote
// ---------------------------------------------------------------------------

const controls = ['rich.docx', 'loffice.docx', 'withpic.docx', 'foreign.xlsx',
	'foreign.pptx', 'foreign.odt', 'foreign.ods', 'foreign.odp']
	.map((n) => path.join(DATA, n))
	.filter((p) => fs.existsSync(p));

const WORDS = {
	'written.docx':  ['Quarterly Review', 'Findings', 'Sales rose', 'Reprice'],
	'legacy.docx':   ['Quarterly Review', 'Findings'],
	'written.xlsx':  ['North', 'South'],
	'written.pptx':  ['Quarterly Review', 'Findings'],
	'written.odt':   ['Quarterly Review', 'Sales rose'],
	'written.ods':   ['North'],
	'written.odp':   ['Findings'],
	'edited.docx':   ['Conclusions'],
	'cell.xlsx':     ['42'],
	'grown.xlsx':    ['edge'],
	'spaces.xlsx':   ['3.50', 'moved'],
};

const run = (files, extra = []) => {
	const r = spawnSync('python3', [CHECK, '--schemas', XSD,
		'--expect', JSON.stringify(WORDS), ...extra, ...files],
		{ env: { ...process.env, PYTHONPATH: PYLIB },
			maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
	if (r.status !== 0) {
		console.log('  FAIL the checker did not run\n' + (r.stderr || '').slice(0, 2000));
		process.exit(1);
	}
	return JSON.parse(r.stdout);
};

console.log('\nthe instrument, over the control set (LibreOffice\'s output, not ours)');
const ctl = run(controls);
/// A finding reduced to what it is ABOUT, so the same divergence in two files is
/// one entry: the message with every number, quoted value and part name taken out.
const shape = (f) => f.rule + ' :: ' + f.detail
	.replace(/line \d+: /, '')
	.replace(/'[^']*'/g, "'…'")
	.replace(/\d+/g, 'N')
	.slice(0, 160);

const noise = new Set();
for (const file of ctl.files) {
	for (const f of file.findings) {
		if (f.severity === 'error' || f.severity === 'known') noise.add(shape(f));
	}
}
let ctlErrors = 0, ctlKnown = 0;
for (const file of ctl.files) {
	for (const f of file.findings) {
		if (f.severity === 'error') ctlErrors++;
		if (f.severity === 'known') ctlKnown++;
	}
}
check(ctlErrors === 0,
	`the control set produces ${ctlErrors} unexplained errors and ${ctlKnown} `
	+ `known schema divergences over ${ctl.files.length} files`,
	ctlErrors === 0 ? '' : 'every one of these is the INSTRUMENT, not the code — '
		+ 'triage them before trusting a finding below');
if (ctlErrors > 0) {
	for (const file of ctl.files) {
		for (const f of file.findings) {
			if (f.severity === 'error') {
				note('control ' + file.name + ' ' + f.rule, f.part + ': ' + f.detail.slice(0, 220));
			}
		}
	}
}

// ---------------------------------------------------------------------------
// And over ours
// ---------------------------------------------------------------------------

console.log('\nthe instrument, over ours');
const ours = run(specimens);

let realErrors = 0;
for (const file of ours.files) {
	const errs   = file.findings.filter((f) => f.severity === 'error');
	const shared = errs.filter((f) => noise.has(shape(f)));
	const mine   = errs.filter((f) => !noise.has(shape(f)));
	const warns  = file.findings.filter((f) => f.severity === 'warn');
	const known  = file.findings.filter((f) => f.severity === 'known');
	realErrors += mine.length;
	check(mine.length === 0,
		`${file.name} — ${file.parts.length} parts, ${mine.length} findings `
		+ `(${shared.length} also in the control set, ${known.length} known `
		+ `schema divergences, ${warns.length} warnings)`);
	for (const f of mine) {
		console.log('         ' + f.rule + ' | ' + (f.part || '(package)')
			+ '\n           ' + f.detail);
	}
	for (const f of warns) note(file.name + ' ' + f.rule, f.part + ': ' + f.detail);
}

// The readers' own verdicts, which are worth printing whether or not they failed:
// "openpyxl opened it" is the sentence this lane exists to be able to say.
console.log('\nwhat the independent readers said');
for (const file of ours.files) {
	for (const f of file.findings) {
		if (f.rule.startsWith('reader.') && f.severity === 'info') {
			console.log('  ' + file.name.padEnd(24) + f.rule.replace('reader.', '')
				+ ': ' + f.detail);
		}
	}
}

// ---------------------------------------------------------------------------
// "Surgical means the original bytes survive" — checked rather than believed
// ---------------------------------------------------------------------------

// The contract says an edit "rewrites the runs it was asked to change and leaves
// every other part of the archive byte-identical". That is a claim about bytes,
// and bytes can be compared. Nothing else in the suite compares them: LibreOffice
// re-serialises everything it opens, so an oracle that round-trips a file cannot
// tell a surgical edit from a full rewrite that happens to land on the same words.
console.log('\nthe surgical claim, part by part');
const digests = (p) => {
	const r = spawnSync('python3', ['-c', `
import hashlib,json,sys,zipfile
z=zipfile.ZipFile(sys.argv[1])
print(json.dumps([[n, hashlib.sha256(z.read(n)).hexdigest()] for n in z.namelist()]))
`, p], { encoding: 'utf8' });
	return JSON.parse(r.stdout);
};

for (const [src, out, expect] of [
		[path.join(DATA, 'rich.docx'),    'edited.docx', ['word/document.xml']],
		[path.join(DATA, 'foreign.xlsx'), 'cell.xlsx',   ['xl/worksheets/sheet1.xml']],
		[path.join(DATA, 'foreign.xlsx'), 'grown.xlsx',  ['xl/worksheets/sheet1.xml']],
		[path.join(DATA, 'foreign.xlsx'), 'spaces.xlsx',
			['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']]]) {
	const p = path.join(OUT, out);
	if (!fs.existsSync(p)) continue;
	const before = digests(src), after = digests(p);
	const bn = before.map(([n]) => n), an = after.map(([n]) => n);
	check(JSON.stringify(bn) === JSON.stringify(an),
		`${out} keeps every part of the original, in the original order`,
		'added: ' + an.filter((n) => !bn.includes(n)).join(', ')
		+ ' | lost: ' + bn.filter((n) => !an.includes(n)).join(', '));
	const changed = before
		.filter(([n, h], i) => after[i] && after[i][0] === n && after[i][1] !== h)
		.map(([n]) => n);
	check(JSON.stringify(changed.sort()) === JSON.stringify([...expect].sort()),
		`${out} changed exactly ${expect.join(', ')} and nothing else`,
		'changed: ' + (changed.join(', ') || '(nothing)'));
}

// ---------------------------------------------------------------------------
// The calculation chain, by itself, because it is the untested decision
// ---------------------------------------------------------------------------

console.log('\nthe calculation chain');
const held = (p, name) => {
	const r = spawnSync('unzip', ['-l', p], { encoding: 'utf8' });
	return (r.stdout || '').includes(name);
};
const declares = (p, needle) => {
	const r = spawnSync('unzip', ['-p', p, '[Content_Types].xml'], { encoding: 'utf8' });
	const s = spawnSync('unzip', ['-p', p, 'xl/_rels/workbook.xml.rels'], { encoding: 'utf8' });
	return (r.stdout || '').includes(needle) || (s.stdout || '').includes(needle);
};

const FIX = path.join(HERE, 'fixtures', 'ooxml', 'withchain.xlsx');
check(held(FIX, 'calcChain.xml'),
	'the fixture HAS a calculation chain, so the removal path is reachable at all',
	'without this the whole calcChain decision is untested by construction — no '
	+ 'file in fe2o3_file/tests/data has one, because LibreOffice never writes it');

const formulaOut = path.join(OUT, 'chain-formula.xlsx');
if (fs.existsSync(formulaOut)) {
	check(!held(formulaOut, 'calcChain.xml'),
		'writing a FORMULA removed xl/calcChain.xml');
	check(!declares(formulaOut, 'calcChain'),
		'and removed the content-type override and the relationship with it',
		'a part gone while [Content_Types].xml still names it is a package Excel '
		+ 'refuses outright');
}

const plainOut = path.join(OUT, 'chain-plainover.xlsx');
if (fs.existsSync(plainOut)) {
	const gone = !held(plainOut, 'calcChain.xml');
	check(gone,
		'writing a PLAIN VALUE over a cell that HELD a formula also removed the chain',
		'it did not. D2 held <f>B2*C2</f> and is named by xl/calcChain.xml; the '
		+ 'edit replaced the cell, so the formula is gone and the chain still '
		+ 'names it. ECMA-376 §18.6.1: a c in the chain is "a single cell, which '
		+ 'shall contain a formula". fe2o3_file/src/office/xlsx/edit.rs:155 sets '
		+ 'the drop flag from `s.formula.is_some()`, which is the formulas being '
		+ 'WRITTEN and not the formulas being DESTROYED.');
}

// ---------------------------------------------------------------------------
// Prove the instrument can fail
// ---------------------------------------------------------------------------

// Always, not behind a flag. A verifier that only proves it can go red when asked
// is one whose rules quietly stop working between the days somebody asks.
console.log('\nthe instrument, damaged on purpose');
const st = run([], ['--selftest', FIX]);
for (const c of st.selftest) {
	check(c.went_red, `breaking a package the ${c.expected} way turns ${c.expected} red`,
		'it stayed green; the rule cannot fail and is therefore not a check. '
		+ 'What did fire: ' + (c.errors.join(', ') || 'nothing'));
}

// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed, ${noted} noted`);
console.log(`specimens in ${OUT}`);
process.exit(fail === 0 ? 0 : 1);
