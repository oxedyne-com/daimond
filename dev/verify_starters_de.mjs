// The starter tags in a language that is not English: are they offered, and
// does adopting one file the word the chip showed?
import { open, shot } from './harness.mjs';

const s = await open({ name: 'starters' });
const { page } = s;
let bad = 0;
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; };

const boxes = () => page.$$eval('.diamond-box .session-box-name', els => els.map(e => e.textContent));

async function newDiamond(name) {
	await page.click('#new-diamond-btn', { force: true });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', name);
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(700);
}
await newDiamond('Ein Diamant');

// Switch the app to German through its own service.
await page.evaluate(async () => { await window.DaimondI18n.setLocale('de'); });
await page.waitForTimeout(900);
const loc = await page.evaluate(() => window.DaimondI18n.locale());
check(loc === 'de', `the app is in German (${loc})`);

// Open the tag editor.
await page.$$eval('.diamond-box', els => els[0].click());
await page.waitForTimeout(500);
for (const b of await page.$$('.crystal-act')) {
	const t = await b.textContent();
	if (/Tags|Schlagw/i.test(t)) { await b.click({ force: true }); break; }
}
await page.waitForSelector('.tag-editor', { timeout: 5000 });

const sugs = await page.$$eval('.tag-sug .tag-chip', els => els.map(e => e.textContent));
console.log('offered:', JSON.stringify(sugs));
check(JSON.stringify(sugs.slice(0, 4)) === JSON.stringify(['person', 'projekt', 'thema', 'organisation']),
	'the German starters are offered, in order');

// Adopt one: the chip's own word must be the tag that gets filed.
const before = sugs[1];
const chips = await page.$$('.tag-sug .tag-chip');
await chips[1].click({ force: true });
await page.waitForTimeout(700);
const on = await page.$$eval('.tag-row:not(.tag-sug) .tag-chip', els => els.map(e => e.textContent.replace('×', '')));
console.log('on the Diamond:', JSON.stringify(on));
check(on.includes(before), `adopting ${JSON.stringify(before)} files exactly that word`);

// And it must not be offered again, which is what a chip/tag mismatch would do.
const after = await page.$$eval('.tag-sug .tag-chip', els => els.map(e => e.textContent));
check(!after.includes(before), `${JSON.stringify(before)} is no longer offered once adopted`);

// A starter carries no closer; a tag the user made does.
const closers = await page.$$eval('.tag-sug .tag-chip', els =>
	els.map(e => ({ tag: e.textContent, kill: !!e.querySelector('.tag-kill') })));
check(closers.filter(c => c.kill).length === 0,
	`the remaining starters carry no delete control: ${JSON.stringify(closers)}`);

await shot(s, 'starters-de');
console.log(bad ? `\n${bad} FAILED` : '\nALL PASS');
await s.close();
process.exit(bad ? 1 : 0);
