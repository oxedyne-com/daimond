// probe_typstoutline.mjs — where a section rail's entries could come from.
//
// The live view is asked for a toggled rail of hyperlinked sections. A rail needs
// three things per entry and the document has to answer all three: the words, the
// level, and THE PAGE. This asks every route the vendored pair offers, and reports
// what each one actually hands back.
//
// It asserts nothing and is not a verifier.
//
//     eval "$(bash dev/world.sh 5 --env)"
//     node dev/probe_typstoutline.mjs
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const WORK = scratch('typstoutline');
fs.mkdirSync(WORK, { recursive: true });

const DOC = `#set page(width: 200pt, height: 160pt, margin: 14pt)
#set text(size: 9pt)
= Front matter
#lorem(40)
= Chapter one
== Section one point one
#lorem(120)
== Section one point two
#lorem(120)
= Chapter two
#lorem(200)
== Section two point one
#lorem(60)
`;

const s = await open({ name: 'typstoutline' });
const p = s.page;
await p.waitForTimeout(1200);

const r = await p.evaluate(async (src) => {
	const out = {};
	const m = await import('/pkg/oxedyne_daimond.js');
	m.set_locked_packs('');
	await m.write_file('outprobe/main.typ', src);
	const c = await m.typst_compile_project_vector('outprobe/main.typ');
	if (!c.vector) return { error: String(c.error || 'nothing').slice(0, 400) };

	// ── 1. the renderer, on the artifact the view already holds ──
	const g = await import('/vendor/typst/typst_ts_renderer.mjs');
	await g.default('/vendor/typst/typst_ts_renderer_bg.wasm');
	const rr = await new g.TypstRendererBuilder().build();
	const ses = rr.session_from_artifact(c.vector, 'vector');
	out.pages = ses.pages_info.page_count;
	try {
		const cu = rr.get_customs(ses);
		out.customs = cu ? cu.map((x) => {
			try { return [String(x[0]), (x[1] && x[1].length) || 0]; }
			catch (e) { return String(x).slice(0, 80); }
		}) : null;
	} catch (e) { out.customs = 'threw: ' + (e && e.message); }
	// What one page's markup carries that could name a heading.
	const info = ses.pages_info;
	const pg0 = info.page(0);
	out.page0 = { h: pg0.height_pt, off: pg0.page_off };
	ses.free();
	const ses2 = rr.session_from_artifact(c.vector, 'vector');
	const svg = ses2.render_in_window(0, 0, info.width(), 1e6);
	ses2.free();
	out.svgKB = +(svg.length / 1024).toFixed(1);
	out.svgHas = {};
	for (const k of ['data-tid', 'typst-group', 'typst-text', 'tsel', 'pseudo-link',
		'handleTypstLocation', 'typst-page', 'data-page', '<a ', 'xlink:href']) {
		out.svgHas[k] = svg.split(k).length - 1;
	}
	out.svgFirstA = (svg.match(/<a [^>]{0,200}/) || [''])[0];
	out.svgPageGroups = (svg.match(/class="typst-page[^"]*"[^>]{0,140}/g) || []).slice(0, 4);

	// ── 2. the compiler, asked about the document rather than for it ──
	// A SECOND compiler off the SAME wasm module, so this costs no second 27 MB.
	const heap0 = window.DaimondTypst.heapMB();
	const cg = await import('/vendor/typst/typst_ts_web_compiler.mjs');
	const init = await cg.default('/vendor/typst/typst_ts_web_compiler_bg.wasm');
	const b = new cg.TypstCompilerBuilder();
	b.set_dummy_access_model();
	for (const n of ['LibertinusSerif-Regular.otf', 'LibertinusSerif-Bold.otf',
		'LibertinusSerif-Italic.otf', 'LibertinusSerif-BoldItalic.otf',
		'NewCMMath-Regular.otf']) {
		try {
			const resp = await fetch('/vendor/typst/fonts/' + n);
			if (resp.ok) await b.add_raw_font(new Uint8Array(await resp.arrayBuffer()));
		} catch (e) { /* whichever are there */ }
	}
	const comp = await b.build();
	comp.reset_shadow();
	comp.add_source('/main.typ', src);
	out.query = {};
	const ask = (sel, field) => {
		const t0 = performance.now();
		try {
			const j = comp.query('/main.typ', undefined, sel, field);
			return { ms: +(performance.now() - t0).toFixed(1), out: String(j).slice(0, 900) };
		} catch (e) { return { ms: +(performance.now() - t0).toFixed(1), err: String(e && e.message).slice(0, 200) }; }
	};
	out.query.heading      = ask('heading', undefined);
	out.query.headingBody  = ask('heading', 'body');
	out.query.headingLoc   = ask('heading', 'location');
	out.query.headingPage  = ask('heading', 'page');
	out.query.metadata     = ask('<toc>', undefined);
	out.heapAfter = { before: heap0, after: window.DaimondTypst.heapMB(),
		second: init && init.memory ? init.memory.buffer.byteLength / 1048576 : 0 };
	return out;
}, DOC);

if (r.error) { console.log('REFUSED: ' + r.error); await s.close(); process.exit(1); }
fs.writeFileSync(`${WORK}/probe.json`, JSON.stringify(r, null, 2));
console.log(JSON.stringify(r, null, 2).slice(0, 12000));
console.log('\nwritten to ' + WORK);
await s.close();
