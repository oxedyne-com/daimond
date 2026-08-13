// probe_typstsvg.mjs — what the renderer actually hands back, whole against window.
//
// The author reported ghosted/double-struck glyphs on every line and solid black
// bars where the contents entries and three inline spans belong. Both are the shape
// of typst.ts's INVISIBLE TEXT LAYER becoming visible: it emits real `<text>` on top
// of the glyph outlines so a reader can select and search, and the only thing that
// makes it invisible is a rule in the stylesheet it emits beside it. So this asks
// the renderer for the same document twice — whole (`svg_data`) and windowed
// (`render_in_window`) — and reports what each one carries.
//
// It asserts nothing and is not a verifier.
//
//     eval "$(bash dev/world.sh 5 --env)"
//     node dev/probe_typstsvg.mjs
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const WORK = scratch('typstsvg');
fs.mkdirSync(WORK, { recursive: true });

const DOC = `#set page(width: 400pt, height: 300pt, margin: 24pt)
#set text(size: 11pt)
= A heading
#outline()
Some ordinary body text, long enough to wrap onto a second line so that a
double-struck run would be obvious to anybody looking at it.
Created using #link("https://typst.app")[Typst] and #link("https://rust-lang.org")[Rust].
== Another heading
More text under it.
`;

const s = await open({ name: 'typstsvg' });
const p = s.page;
await p.waitForTimeout(1200);

const r = await p.evaluate(async (src) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	m.set_locked_packs('');
	await m.write_file('svgprobe/main.typ', src);
	const out = await m.typst_compile_project_vector('svgprobe/main.typ');
	if (!out.vector) return { error: String(out.error || 'nothing').slice(0, 400) };
	const g = await import('/vendor/typst/typst_ts_renderer.mjs');
	await g.default('/vendor/typst/typst_ts_renderer_bg.wasm');
	const rr = await new g.TypstRendererBuilder().build();
	const ses = rr.session_from_artifact(out.vector, 'vector');
	const info = ses.pages_info;
	const whole = rr.svg_data(ses);
	const ses2 = rr.session_from_artifact(out.vector, 'vector');
	const win = ses2.render_in_window(0, 0, info.width(), info.height());
	ses.free(); ses2.free();
	return { whole, win, w: info.width(), h: info.height(), pages: info.page_count };
}, DOC);

if (r.error) { console.log('REFUSED: ' + r.error); await s.close(); process.exit(1); }

const look = (name, svg) => {
	fs.writeFileSync(`${WORK}/${name}.svg`, svg);
	const styles = svg.match(/<style[\s\S]*?<\/style>/g) || [];
	console.log(`\n=== ${name} — ${(svg.length / 1024).toFixed(1)} KB ===`);
	console.log(`  <style> blocks: ${styles.length}`);
	for (const st of styles) console.log('    ' + st.replace(/\s+/g, ' ').slice(0, 300));
	for (const k of ['tsel', 'typst-text', 'typst-doc', '<text', 'class="typst', 'data-tid',
		'<script', 'pseudo-link', 'typst-link', 'fill="#000000"', 'fill: none']) {
		const n = svg.split(k).length - 1;
		if (n) console.log(`  ${JSON.stringify(k)} x${n}`);
	}
	const t = svg.match(/<text[^>]*>[\s\S]{0,80}/);
	if (t) console.log('  first <text>: ' + t[0].replace(/\s+/g, ' ').slice(0, 240));
	console.log('  head: ' + svg.slice(0, 400).replace(/\s+/g, ' '));
};

console.log(`document ${r.w.toFixed(1)} x ${r.h.toFixed(1)} pt, ${r.pages} page(s)`);
look('whole', r.whole);
look('window', r.win);
console.log(`\nwrote ${WORK}/whole.svg and ${WORK}/window.svg`);
await s.close();
