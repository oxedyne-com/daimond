// shot_release.mjs — the version row, and the history it opens.
import { open, shot, signInAs, errors } from './harness.mjs';
const s = await open({ name: 'release-shot', connect: false });
const p = s.page;
await p.waitForTimeout(3000);
await shot(s, 'rel-1-strip');
await p.click('#astat-release');
await p.waitForTimeout(900);
await shot(s, 'rel-2-history');
console.log('row text:', await p.$eval('#astat-release', e => e.textContent.trim()));
console.log('rows:', await p.$$eval('.rel-row', e => e.length));
console.log('errors:', JSON.stringify(errors(s).filter(x => !/502|Failed to load/.test(x))));
await s.close();
