// shot_typescale.mjs — the reading-size control, at every step of the scale.
//
// The claim the first shot exists to test is that moving 253 literal px sizes onto
// tokens changed NOTHING at scale 1. That is checkable rather than arguable: shoot
// the app with the tokens in place, shoot it again with the stylesheets reverted,
// and diff. The rest of the shots are the point of the exercise -- the type growing
// while the frame stays where it is.
import { open, shot, signInAs } from './harness.mjs';

const s = await open({ name: 'typescale', connect: false });
const p = s.page;
await p.waitForTimeout(2500);

// Something to read, so the scale has text to act on rather than empty panels.
await p.evaluate(async () => {
	const mod = await import('../pkg/oxedyne_daimond.js');
	const app = new mod.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 256, '', true);
	await app.create_facet('Ship the launch');
	await app.create_facet('Brand voice');
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'typescale');
await p.waitForTimeout(3000);

const label = process.env.SHOT_LABEL || 'scale';

for (const step of ['0.85', '1', '1.15', '1.3']) {
	await p.evaluate((v) => {
		document.documentElement.style.setProperty('--fs-scale', v);
	}, step);
	await p.waitForTimeout(400);
	await shot(s, `${label}-${step.replace('.', '_')}`);
}

await s.close();
console.log('shots written');
