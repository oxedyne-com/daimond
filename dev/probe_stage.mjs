// probe_stage.mjs — a look at the stage while it is being built. Not a verifier.
import { open } from './harness.mjs';

const s = await open({ name: 'stageprobe', connect: false });
const p = s.page;

const geom = () => p.evaluate(() => {
	const st = document.getElementById('stage');
	const kids = [...st.children].filter((k) => k.getClientRects().length);
	return {
		stage: Math.round(st.getBoundingClientRect().width),
		max:   DaimondPanels.model().stageMax,
		order: kids.map((k) => (k.dataset.panel || k.className) + ':'
			+ Math.round(k.getBoundingClientRect().width)),
		open:  DaimondPanels.panels().filter((x) => x.zone === 'stage')
			.filter((x) => DaimondPanels.isOpen(x.id)).map((x) => x.id),
	};
});

for (const w of [2400, 1900, 1500, 1100]) {
	await p.setViewportSize({ width: w, height: 950 });
	await p.waitForTimeout(500);
	await p.evaluate(() => { ['web', 'doc', 'msg'].forEach((x) => DaimondPanels.show(x)); });
	await p.waitForTimeout(600);
	console.log(w, JSON.stringify(await geom()));
}
// Now narrow with everything open.
await p.setViewportSize({ width: 2400, height: 950 });
await p.waitForTimeout(400);
await p.evaluate(() => { ['web', 'doc', 'msg'].forEach((x) => DaimondPanels.show(x)); });
await p.waitForTimeout(500);
console.log('wide again', JSON.stringify(await geom()));
for (const w of [1800, 1400, 1000]) {
	await p.setViewportSize({ width: w, height: 950 });
	await p.waitForTimeout(600);
	console.log('narrowed to', w, JSON.stringify(await geom()));
}
await p.setViewportSize({ width: 2400, height: 950 });
await p.waitForTimeout(600);
console.log('widened back', JSON.stringify(await geom()));

console.log('errors:', s.errs.slice(0, 5));
await s.close();
