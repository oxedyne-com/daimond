// probe_typstink.mjs — photograph what the live view really draws.
//
// Three faults were reported together: ghosted/double-struck glyphs on all body
// text, solid black bars where the contents entries belong, and filled black boxes
// over inline `#link` spans. This drives the shipped path — the Doc panel's Compile
// button, which is what arms the live view — and photographs the pages, then counts
// what is in the shadow root and what colour the browser has resolved for it.
//
// It asserts nothing and is not a verifier.
//
//     eval "$(bash dev/world.sh 5 --env)"
//     node dev/probe_typstink.mjs
import fs from 'node:fs';
import { open, scratch } from './harness.mjs';

const WORK = scratch('typstink');
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

const s = await open({ name: 'typstink' });
const p = s.page;
await p.setViewportSize({ width: 1600, height: 1000 });
await p.waitForTimeout(1200);
await p.evaluate(async (src) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	m.set_locked_packs('');
	await m.write_file('inkprobe/main.typ', src);
}, DOC);
await p.evaluate(() => window.DaimondDoc.show('inkprobe/main.typ'));
await p.waitForTimeout(1200);
await p.click('[data-act="compile"]', { force: true });
for (let i = 0; i < 120; i++) {
	const st = await p.evaluate(() => window.DaimondTypstWatch.state());
	if (st.drawn) break;
	await new Promise(r => setTimeout(r, 500));
}
await p.waitForTimeout(1200);

const seen = await p.evaluate(() => {
	const h = document.getElementById('typst-live');
	const sr = h.querySelector('.tl-pages').shadowRoot;
	const tsel = sr.querySelectorAll('.tsel');
	const link = sr.querySelectorAll('.pseudo-link');
	const glyph = sr.querySelectorAll('.outline_glyph');
	const cs = (el) => el ? getComputedStyle(el) : null;
	const a = cs(tsel[0]), b = cs(link[0]);
	return {
		state: window.DaimondTypstWatch.state(),
		styles: sr.querySelectorAll('style').length,
		styleText: Array.from(sr.querySelectorAll('style')).map(s => s.textContent.length),
		tsel: tsel.length, link: link.length, glyph: glyph.length,
		tselColour: a ? a.color : null,
		tselSize:   a ? a.fontSize : null,
		tselBox:    tsel[0] ? JSON.stringify(tsel[0].getBoundingClientRect()) : null,
		linkFill:   b ? b.getAttribute ? getComputedStyle(link[0]).fill : null : null,
		linkBox:    link[0] ? JSON.stringify(link[0].getBoundingClientRect()) : null,
		onclicks:   sr.querySelectorAll('[onclick]').length,
	};
});
console.log(JSON.stringify(seen, null, 1));

// ── And the settings the view now offers ───────────────────────
const set = await p.evaluate(() => {
	const w = window.DaimondTypstWatch;
	const bar = document.querySelector('#typst-live .tl-bar');
	return { bar: bar ? bar.textContent.replace(/\s+/g, ' ').trim() : null,
		buttons: Array.from(bar.querySelectorAll('button')).map(b => b.textContent + '|' + b.title),
		state: (({ zoom, dark, pages }) => ({ zoom, dark, pages }))(w.state()) };
});
console.log('bar: ' + JSON.stringify(set, null, 1));
await p.evaluate(() => { window.DaimondTypstWatch.dark(true); window.DaimondTypstWatch.zoom(1.5); });
await p.waitForTimeout(600);
const nightBox = await p.evaluate(() => {
	const r = document.querySelector('#typst-live .tl-scroll').getBoundingClientRect();
	return { x: r.x, y: r.y, width: r.width, height: r.height,
		state: window.DaimondTypstWatch.state() };
});
await p.screenshot({ path: `${WORK}/night.png`, clip: {
	x: Math.floor(nightBox.x), y: Math.floor(nightBox.y),
	width: Math.floor(nightBox.width), height: Math.floor(Math.min(nightBox.height, 500)) } });
console.log(`night+zoom: zoom ${nightBox.state.zoom}, dark ${nightBox.state.dark}, `
	+ `at page ${nightBox.state.at ? nightBox.state.at.page + 1 : '?'}`);
await p.evaluate(() => { window.DaimondTypstWatch.dark(false); window.DaimondTypstWatch.zoom(1); });
await p.waitForTimeout(400);

const box = await p.evaluate(() => {
	const r = document.querySelector('#typst-live .tl-scroll').getBoundingClientRect();
	return { x: r.x, y: r.y, width: r.width, height: r.height };
});
await p.screenshot({ path: `${WORK}/live.png`, clip: {
	x: Math.floor(box.x), y: Math.floor(box.y),
	width: Math.floor(box.width), height: Math.floor(Math.min(box.height, 700)) } });
console.log('wrote ' + WORK + '/live.png');
await s.close();
