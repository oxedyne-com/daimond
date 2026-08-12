// probe_typstproj.mjs — establish, empirically, what the vendored compiler will accept.
//
// Not a verifier.  Four questions had to be answered before any design could be
// written, and guessing at them is how the single-file bug got shipped:
//
//   1. Where is the compiler's project root?  `compile()` takes no root argument,
//      so the answer decides whether "/" is the root and shadow paths are
//      root-relative.
//   2. Does a relative import that climbs (`../style/x.typ`) resolve against the
//      IMPORTING file's directory, as it does on the CLI?
//   3. Does an absolute reference (`/assets/x.svg`) resolve against the root?
//   4. Does this build accept font bytes AFTER `build()` -- `TypstFontResolverBuilder`
//      plus `TypstCompiler.set_fonts` -- and what does `get_font_info` report?
import { open } from './harness.mjs';

const s = await open({ name: 'typstprobe' });
const p = s.page;
await p.waitForTimeout(1200);
await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	mod.set_locked_packs('');
});

const out = await p.evaluate(async () => {
	const VENDOR = new URL('/vendor/typst/', location.href);
	const mod = await import(new URL('typst_ts_web_compiler.mjs', VENDOR).href);
	await mod.default(new URL('typst_ts_web_compiler_bg.wasm', VENDOR));
	const b = new mod.TypstCompilerBuilder();
	b.set_dummy_access_model();
	const FONTS = ['LibertinusSerif-Regular.otf', 'LibertinusSerif-Bold.otf',
		'LibertinusSerif-Italic.otf', 'LibertinusSerif-BoldItalic.otf', 'NewCMMath-Regular.otf'];
	const bytes = {};
	for (const n of FONTS) {
		const r = await fetch(new URL('fonts/' + n, VENDOR));
		bytes[n] = new Uint8Array(await r.arrayBuffer());
		await b.add_raw_font(bytes[n]);
	}
	const c = await b.build();
	const res = {};

	const run = (main) => {
		try {
			const r = c.compile(main, undefined, 'pdf', 3);
			const pdf = r instanceof Uint8Array ? r : (r && (r.result || r.artifact));
			if (pdf && pdf.length > 4) return { bytes: pdf.length };
			return { err: JSON.stringify(r && r.diagnostics ? r.diagnostics : r).slice(0, 400) };
		} catch (e) { return { err: 'threw: ' + (e && e.message ? e.message : e) }; }
	};

	// Q1+Q2+Q3 in one document: main sits in a sub-directory, imports a sibling,
	// climbs to a sibling directory, and names an asset absolutely.
	c.reset_shadow();
	c.add_source('/book/main.typ', [
		'#import "tpl.typ": tag',
		'#import "../style/glo.typ": glo',
		'= #tag() #glo()',
		'#include "chap01.typ"',
		'#image("/assets/dot.svg", width: 10pt)',
	].join('\n'));
	c.add_source('/book/tpl.typ', '#let tag() = [T]\n');
	c.add_source('/book/chap01.typ', '== Chapter one\n\nText.\n');
	c.add_source('/style/glo.typ', '#let glo() = [G]\n');
	c.map_shadow('/assets/dot.svg', new TextEncoder().encode(
		'<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>'));
	res.projectAtSlashRoot = run('/book/main.typ');

	// The same, with the asset withheld: does it say something usable?
	c.unmap_shadow('/assets/dot.svg');
	res.assetWithheld = run('/book/main.typ');

	// Q4: fonts after build.
	try {
		const fb = new mod.TypstFontResolverBuilder();
		res.fontInfo = JSON.stringify(fb.get_font_info(bytes['LibertinusSerif-Regular.otf'])).slice(0, 600);
		for (const n of FONTS) fb.add_raw_font(bytes[n]);
		const rr = await fb.build();
		c.set_fonts(rr);
		res.setFonts = 'ok';
		res.loaded = c.get_loaded_fonts().slice(0, 12);
	} catch (e) { res.setFonts = 'threw: ' + (e && e.message ? e.message : e); }

	// And does a document naming an unknown font still compile (silent fallback)?
	c.reset_shadow();
	c.add_source('/m.typ', '#set text(font: "Radley")\n= Hello\n');
	res.unknownFont = run('/m.typ');

	return res;
});

console.log(JSON.stringify(out, null, 2));
await s.close();
