// verify_tagkill.mjs — a tag can be got rid of, and says who it will affect.
//
// The tag editor's upper box takes a tag OFF this Diamond. Nothing anywhere could
// delete the tag itself, so a mistyped or abandoned tag stayed in the pool for
// ever, offered to every Diamond, for the rest of the account's life.
//
// The pool box can now delete one — which is a different act from detaching it,
// because the pool is the USER'S vocabulary and other Diamonds are filed under
// it. So it asks first, and it says how many Diamonds it will change. The oracle
// for the removal is the store, read back through the wasm, not the chips on
// screen: a paint that merely stopped drawing the tag would look identical.
//
// Kept separate from verify_tags rather than bolted onto it: that file's 49
// checks include the exact sequence of the starter suggestions and the exact
// textContent of a pool chip, and this feature must not disturb either. The last
// check here asserts both, so the two files cannot drift apart silently.
//
//   node dev/verify_tagkill.mjs
//
// Needs dev/serve.mjs (DAIMOND_PORT, default 8777). No gateway; the model is never
// called.

import { open, shot, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The mock model is connected but never called: nothing here reaches a provider.
// It is connected because the rail's "+" refuses to create a Diamond without one.
const s = await open({ name: 'tagkill' });
const p = s.page;

/// The store's own answer: every Diamond and the tags actually written down.
const stored = () => p.evaluate(async () => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	return JSON.parse(await app.list_diamonds()).map(r => ({ name: r.name, tags: r.tags }));
});
const pool = () => p.$$eval('.tag-sug .tag-chip', els => els.map(e => ({
	text: e.textContent, kill: !!e.querySelector('.tag-kill'),
})));
const dlg = () => p.evaluate(() => {
	const c = document.querySelector('.dlg-card');
	return c ? c.textContent : '';
});
async function clickIf(sel) {
	const el = await p.$(sel);
	if (!el) return false;
	await el.click({ force: true });
	await sleep(500);
	return true;
}
/// The pool closer for one named tag.
async function killChip(tag) {
	return p.evaluateHandle((t) => {
		const chip = [...document.querySelectorAll('.tag-sug .tag-chip')]
			.find(e => e.textContent === t);
		return chip ? chip.querySelector('.tag-kill') : null;
	}, tag);
}
async function clickKill(tag) {
	const h = await killChip(tag);
	const el = h.asElement();
	if (!el) return false;
	await el.click({ force: true });
	await sleep(600);
	return true;
}

// ── Seed: three Diamonds, two of them sharing a tag ──────────────────
async function newDiamond(name) {
	await p.click('#new-diamond-btn', { force: true });
	await p.waitForSelector('.dlg-input', { timeout: 10000 });
	await p.fill('.dlg-input', name);
	await p.click('.dlg-ok', { force: true });
	await sleep(800);
}
for (const n of ['Alpha', 'Beta', 'Gamma']) await newDiamond(n);

async function openEditor(name) {
	await p.evaluate((n) => {
		const box = [...document.querySelectorAll('.diamond-box')]
			.find(b => (b.querySelector('.session-box-name') || {}).textContent === n);
		if (box) box.click();
	}, name);
	await sleep(700);
	for (const b of await p.$$('.crystal-act')) {
		if ((await b.textContent()).includes('Tags')) { await b.click({ force: true }); break; }
	}
	await p.waitForSelector('.tag-editor', { timeout: 8000 });
}
async function addTags(name, tags) {
	await openEditor(name);
	for (const t of tags) {
		await p.fill('.tag-input', t);
		await p.keyboard.press('Enter');
		await sleep(500);
	}
}
await addTags('Alpha', ['shared', 'alpha-only']);
await addTags('Beta', ['shared']);
// Gamma carries neither, so both are in ITS pool — which is where a tag is
// deleted from.
await openEditor('Gamma');

// ── 1. The pool offers a closer, except on the starter suggestions ───
const pool1 = await pool();
const shared = pool1.find(x => x.text === 'shared');
const starter = pool1.find(x => x.text === 'person');
check('a tag in the pool carries a closer', !!shared && shared.kill,
	JSON.stringify(pool1));
check('a starter suggestion does not (nothing could remove it)',
	!!starter && starter.kill === false, JSON.stringify(starter));
check('and a pool chip still reads as the bare tag, which is what the rail and the search read',
	!!shared && shared.text === 'shared', JSON.stringify(pool1.map(x => x.text)));
await shot(s, 'tagkill-pool');

// ── 2. The closer asks first, and says who it affects ────────────────
check('clicking the closer opens the app\'s own confirmation', await clickKill('shared'));
const ask = await dlg();
check('the dialog names the tag and counts the Diamonds it is filed on',
	/shared/.test(ask) && /\b2\b/.test(ask), ask ? ask.slice(0, 140) : '(no dialog)');
await shot(s, 'tagkill-confirm');

// ── 3. Cancelling changes nothing at all ─────────────────────────────
await clickIf('.dlg-cancel');
const afterCancel = await stored();
check('cancelling leaves every Diamond exactly as it was',
	afterCancel.filter(d => (d.tags || []).includes('shared')).length === 2,
	JSON.stringify(afterCancel));

// ── 4. Confirming takes it off every Diamond that carried it ─────────
await clickKill('shared');
await clickIf('.dlg-ok');
await sleep(1200);
const afterKill = await stored();
check('confirming deletes the tag from every Diamond, in the STORE',
	afterKill.every(d => !(d.tags || []).includes('shared')), JSON.stringify(afterKill));
check('and leaves their other tags alone',
	(afterKill.find(d => d.name === 'Alpha') || {}).tags.includes('alpha-only'),
	JSON.stringify(afterKill.find(d => d.name === 'Alpha')));
const pool2 = await pool();
check('the deleted tag is gone from the pool',
	!pool2.some(x => x.text === 'shared'), JSON.stringify(pool2.map(x => x.text)));
const railChips = await p.$$eval('.session-box-meta .tag-chip', els => els.map(e => e.textContent));
check('and gone from the rail',
	!railChips.includes('shared'), JSON.stringify(railChips));

// ── 5. A filter on a deleted tag is cleared, not left hiding everything ──
await p.evaluate(() => {
	const chip = [...document.querySelectorAll('.session-box-meta .tag-chip')]
		.find(e => e.textContent === 'alpha-only');
	if (chip) chip.click();
});
await sleep(500);
const filtered = await p.$$eval('.diamond-box', els => els.length);
check('a tag filter narrows the rail (so the next check means something)',
	filtered === 1, `${filtered} Diamonds shown`);
await clickKill('alpha-only');
await clickIf('.dlg-ok');
await sleep(1200);
const shown = await p.$$eval('.diamond-box', els => els.length);
const filterUp = await p.evaluate(() => {
	const f = document.getElementById('diamond-filter');
	return !!f && f.style.display !== 'none' && getComputedStyle(f).display !== 'none';
});
check('deleting the tag that was filtering clears the filter rather than emptying the rail',
	shown === 3 && !filterUp, `${shown} shown, filter chip up=${filterUp}`);

// ── 6. The starter set is untouched, in its own order ────────────────
const starters = (await pool()).map(x => x.text).slice(0, 4);
check('the starter suggestions keep their order (verify_tags asserts this exact sequence)',
	JSON.stringify(starters) === JSON.stringify(['person', 'project', 'topic', 'org']),
	JSON.stringify(starters));

const errs = errors(s).filter(e => !/favicon|404|401|402|502|Bad Gateway|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 5));
check('nothing throws while all this happens', errs.length === 0, errs[0] || '');

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
