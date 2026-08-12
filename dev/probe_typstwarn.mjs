// probe_typstwarn.mjs — does a SUCCESSFUL compile carry warnings, and does an
// unknown font family produce one?
//
// This decides how fonts are policed.  A scanner over the source that guesses at
// which families a document asks for will always be approximate; typst's own
// "unknown font family" warning, if it reaches us, is authoritative and cannot
// be fooled by a family named through a variable.
import { open } from './harness.mjs';

const s = await open({ name: 'typstwarnprobe' });
const p = s.page;
await p.waitForTimeout(1200);

const out = await p.evaluate(async () => {
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
	const shape = (r) => ({
		keys: r && typeof r === 'object' && !(r instanceof Uint8Array) ? Object.keys(r) : String(typeof r),
		diag: r && r.diagnostics ? JSON.stringify(r.diagnostics).slice(0, 700) : '(none)',
		bytes: (r instanceof Uint8Array ? r : (r && (r.result || r.artifact)))?.length || 0,
	});
	const res = {};
	c.reset_shadow();
	// A family the compiler has never heard of, named directly.
	c.add_source('/a.typ', '#set text(font: "Radley")\n= Hello\n\nBody text here.\n');
	res.unknownDirect = shape(c.compile('/a.typ', undefined, 'pdf', 3));
	// The same family reached through a variable, which no source scanner sees.
	c.add_source('/b.typ', '#let f = "Radley"\n#set text(font: f)\n= Hello\n\nBody.\n');
	res.unknownViaVar = shape(c.compile('/b.typ', undefined, 'pdf', 3));
	// A clean document, for the control.
	c.add_source('/c.typ', '= Hello\n\nBody.\n');
	res.clean = shape(c.compile('/c.typ', undefined, 'pdf', 3));
	// And a package import, which this build has no registry for.
	c.add_source('/d.typ', '#import "@preview/cetz:0.3.4"\n= Hello\n');
	res.packageImport = shape(c.compile('/d.typ', undefined, 'pdf', 3));
	return res;
});

console.log(JSON.stringify(out, null, 2));
await s.close();
