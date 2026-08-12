// probe_typstfont.mjs — does a font supplied at compile time actually get USED?
//
// `set_fonts` accepted a resolver in the first probe, but acceptance is not use:
// the compiler renders an unknown family with a silent fallback, so a PDF comes
// out either way and the byte count alone proves nothing.  This asks the only
// question that matters for correctness -- is the family named in the source the
// family embedded in the PDF -- and whether `set_fonts` REPLACES the set it was
// built with, which decides whether the bundled fonts must be re-added.
import { readFileSync } from 'node:fs';
import { open } from './harness.mjs';

// The fixture's copy, not the author's tree: a probe that only runs on one machine
// is a probe nobody reruns.
const RADLEY = Array.from(readFileSync(new URL(
	'./fixtures/typstproj/books/assets/fonts/Radley-Regular.ttf', import.meta.url)));

const s = await open({ name: 'typstfontprobe' });
const p = s.page;
await p.waitForTimeout(1200);

const out = await p.evaluate(async (radley) => {
	const VENDOR = new URL('/vendor/typst/', location.href);
	const mod = await import(new URL('typst_ts_web_compiler.mjs', VENDOR).href);
	await mod.default(new URL('typst_ts_web_compiler_bg.wasm', VENDOR));
	const FONTS = ['LibertinusSerif-Regular.otf', 'LibertinusSerif-Bold.otf',
		'LibertinusSerif-Italic.otf', 'LibertinusSerif-BoldItalic.otf', 'NewCMMath-Regular.otf'];
	const bundled = [];
	for (const n of FONTS) {
		const r = await fetch(new URL('fonts/' + n, VENDOR));
		bundled.push(new Uint8Array(await r.arrayBuffer()));
	}
	const b = new mod.TypstCompilerBuilder();
	b.set_dummy_access_model();
	for (const f of bundled) await b.add_raw_font(f);
	const c = await b.build();

	// A PDF names every embedded font in its descriptors, so grepping the bytes
	// for the family is a direct question about what was actually drawn with.
	const names = (pdf) => {
		const t = new TextDecoder('latin1').decode(pdf);
		const hits = new Set();
		for (const m of t.matchAll(/\/BaseFont\s*\/([A-Za-z0-9+\-_]+)/g)) hits.add(m[1]);
		return Array.from(hits);
	};
	const run = (main) => {
		const r = c.compile(main, undefined, 'pdf', 3);
		const pdf = r instanceof Uint8Array ? r : (r && (r.result || r.artifact));
		if (pdf && pdf.length > 4) return { fonts: names(pdf) };
		return { err: JSON.stringify(r && r.diagnostics ? r.diagnostics : r).slice(0, 300) };
	};
	const res = {};
	c.reset_shadow();
	c.add_source('/m.typ', '#set text(font: "Radley")\n= Hello there, Radley\n\nSome body text.\n');
	res.beforeAdding = run('/m.typ');

	const rad = new Uint8Array(radley);
	// Project fonts only -- does the bundled set survive?
	const fbOnly = new mod.TypstFontResolverBuilder();
	fbOnly.add_raw_font(rad);
	c.set_fonts(await fbOnly.build());
	res.radleyOnly = run('/m.typ');
	c.add_source('/l.typ', '#set text(font: "Libertinus Serif")\n= Hello\n\nBody.\n');
	res.radleyOnlyLibertinus = run('/l.typ');

	// Bundled plus project, which is what the driver will actually do.
	const fbAll = new mod.TypstFontResolverBuilder();
	for (const f of bundled) fbAll.add_raw_font(f);
	fbAll.add_raw_font(rad);
	c.set_fonts(await fbAll.build());
	res.both = run('/m.typ');
	res.bothLibertinus = run('/l.typ');
	res.info = JSON.parse(JSON.stringify(new mod.TypstFontResolverBuilder().get_font_info(rad)))
		.info.map(i => ({ family: i.family, variant: i.variant }));
	return res;
}, RADLEY);

console.log(JSON.stringify(out, null, 2));
await s.close();
