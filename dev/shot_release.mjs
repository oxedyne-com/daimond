// shot_release.mjs — the version row, and the history it opens.
import { open, shot, signInAs, errors } from './harness.mjs';
const s = await open({ name: 'release-shot2', connect: false });
const p = s.page;
await p.waitForTimeout(3000);
await shot(s, 'rel-1-strip');
await p.evaluate(() => {
	const r = document.getElementById('astat-release');
	r.scrollIntoView({ block: 'center' });
	r.click();
});
await p.waitForTimeout(1200);
await shot(s, 'rel-2-history');
console.log('row text:', await p.$eval('#astat-release', e => e.textContent.trim()));
console.log('rows:', await p.$$eval('.rel-row', e => e.length));
console.log('errors:', JSON.stringify(errors(s).filter(x => !/502|Failed to load/.test(x))));
await s.close();
