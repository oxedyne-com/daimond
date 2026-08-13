// shot_stage.mjs — the stage as the author will see it: the source, its pages,
// and the daimon, all at once.
import { open, shot } from './harness.mjs';

const MAIN = `#import "one.typ": one
#set page(width: 120mm, height: 160mm, margin: 12mm)
#set text(size: 10pt)
#set par(justify: true)
= The book
#one
`;
const ONE = `#let one = [
== Chapter one
Alpha lorem ipsum dolor sit amet, consectetur adipiscing elit.

#lorem(120)
]
`;

const s = await open({ name: 'stageshot', connect: false });
const p = s.page;
await p.setViewportSize({ width: 1920, height: 1080 });
await p.waitForTimeout(1000);

const put = (path, text) => p.evaluate(async ({ path, text }) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	await m.write_file(path, text);
}, { path, text });
await put('book/main.typ', MAIN);
await put('book/one.typ', ONE);

await p.evaluate(() => window.DaimondDoc.show('book/main.typ'));
await p.waitForTimeout(1200);
await p.click('[data-act="compile"]', { force: true });
const st = () => p.evaluate(() => window.DaimondTypstWatch.state());
for (let i = 0; i < 80 && !(await st()).drawn; i++) await p.waitForTimeout(500);
await p.waitForTimeout(1500);
await shot(s, 'stage-source-and-pages');
console.log(JSON.stringify(await p.evaluate(() => [...document.getElementById('stage').children]
	.filter((k) => k.getClientRects().length)
	.map((k) => (k.dataset.panel || 'handle') + ':' + Math.round(k.getBoundingClientRect().width)))));
await s.close();
