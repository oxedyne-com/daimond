// A fold retains its raw delta; the History must now let you read it back.
import { open, errors } from './harness.mjs';

const s = await open({ name: 'folddelta' });

// New Facet, seed a brief so a fold has something to change.
await s.page.click('#new-facet-btn');
await s.page.waitForSelector('.dlg-input', { timeout: 8000 });
await s.page.fill('.dlg-input', 'Delta Test');
await s.page.click('.dlg-ok');
await s.page.waitForTimeout(1000);

// Fold a distinctive delta in via the fold control, then accept it.
await s.page.fill('#fold-delta', 'DELTA-MARKER-42: ship the thing');
await s.page.click('#fold-propose');
await s.page.waitForTimeout(3000);
const accept = await s.page.$('.diff-accept');
if (accept && !(await accept.isDisabled())) { await accept.click(); await s.page.waitForTimeout(2000); }

// Open History and click the fold record's Delta button.
await s.page.click('button.brief-act:has-text("History")');
await s.page.waitForTimeout(600);
const deltaBtn = await s.page.$('button.brief-act:has-text("Delta")');
let shown = '';
if (deltaBtn) {
	await deltaBtn.click();
	await s.page.waitForTimeout(600);
	shown = await s.page.evaluate(() => (document.querySelector('.dlg-pre') || {}).textContent || '');
}
console.log('delta button present:', !!deltaBtn);
console.log('shows the raw delta:', /DELTA-MARKER-42/.test(shown));
console.log('\nFOLD DELTA VIEWABLE:', !!deltaBtn && /DELTA-MARKER-42/.test(shown));
console.log('errors:', errors(s));
await s.close();
