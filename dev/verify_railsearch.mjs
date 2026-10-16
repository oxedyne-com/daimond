// gateway: none
// RAIL-SEARCH (D-20261015-11): the "Search diamonds" field above "Filter by tag".
//
// Ruled 16 Oct 2026, variant A: the field is the Agents panel's own find block
// (`#agent-search` over `#agent-filter`) drawn in the rail, and it searches NAMES
// (substring) and TAGS (prefix) only -- never the pages inside a Diamond. It
// composes with the tag filter: the filter decides which Diamonds are in the list
// and the search narrows that list (AND). Nothing left reads "No match".
//
// The rail had a search box until 6 Aug 2026 (488aaea2), removed as one way too
// many to narrow a short list. A live rail of nineteen tags and a growing list
// reversed that, so this file asserts the field is BACK, which is the opposite of
// what `shot_phasea.mjs` photographed at the time.
//
// Red on d26e2aaa (there is no field); green with the change. Run it in a world:
//   eval "$(bash dev/world.sh 95 --env)"; node dev/verify_railsearch.mjs
//   DAIMOND_BROWSER=webkit node dev/verify_railsearch.mjs

import { open, errors, signInAs } from './harness.mjs';

const s = await open({ name: 'railsearch', defaults: false });
const { page } = s;
const out = [];
let bad = 0;
const check = (ok, what) => { out.push(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) bad++; return ok; };

// The owner's live rail, in small: names that share letters, tags that share prefixes.
const WANT = [
	['Cornelis Hoogland', ['person', 'family']],
	['Ship the launch', ['project', 'work']],
	['Brand voice', ['work', 'writing']],
	['Lifelog', []],
	['Ontheism', ['philosophy', 'religion', 'project']],
	['Fred Hoogland', ['family', 'person']],
];
await page.evaluate(async (want) => {
	const m = await import('/pkg/oxedyne_daimond.js');
	const app = new m.DaimondApp('http://127.0.0.1/v1/chat/completions', '', 'none', 4096, '', true);
	for (const [n] of want) await app.create_diamond(n);
	const list = JSON.parse(await app.list_diamonds());
	for (const [n, t] of want) {
		const d = list.find((x) => x.name === n);
		if (d && t.length) await app.set_tags(d.id, JSON.stringify(t));
	}
}, WANT);
await page.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'railsearch');
await page.waitForTimeout(1500);

const names = () => page.$$eval('#diamond-list .diamond-box .session-box-name', (els) => els.map((e) => e.textContent).sort());
const note  = () => page.$$eval('#diamond-list .rail-note', (els) => els.map((e) => e.textContent.trim()));
const type  = async (q) => { await page.fill('#diamond-search', q); await page.waitForTimeout(300); };
const poolClick = async (tag) => {
	const tg = await page.$('#diamond-filter .tagf-toggle');
	if (tg && (await tg.getAttribute('aria-expanded')) !== 'true') { await tg.click(); await page.waitForTimeout(300); }
	const hit = await page.$$eval('#diamond-filter .tagf-pool .tag-chip', (els, n) => {
		for (const e of els) if (e.textContent === n) { e.click(); return true; }
		return false;
	}, tag);
	await page.waitForTimeout(400);
	return hit;
};

check((await names()).length === 6, `six Diamonds on the rail before any search: ${JSON.stringify(await names())}`);

// ── The field: the Agents panel's own find block, above the tag row ──────────
const field = await page.evaluate(() => {
	const f = document.getElementById('diamond-search');
	if (!f) return null;
	const find = f.parentElement, filt = document.getElementById('diamond-filter');
	const a = document.getElementById('agent-search');
	const cs = (e) => { const c = getComputedStyle(e); return [c.fontSize, c.paddingTop, c.paddingLeft, c.borderTopWidth,
		c.borderTopStyle, c.borderTopColor, c.backgroundColor, c.borderTopLeftRadius, c.color].join('|'); };
	return {
		tag: f.tagName, type: f.type, cls: f.className, ph: f.placeholder, aria: f.getAttribute('aria-label'),
		inFind: find.classList.contains('diamond-find'),
		beforeFilter: !!(f.compareDocumentPosition(filt) & Node.DOCUMENT_POSITION_FOLLOWING) && filt.parentElement === find,
		sameLook: a ? cs(f) === cs(a) : null, look: cs(f), agentLook: a ? cs(a) : null,
		shown: f.getBoundingClientRect().height > 0,
	};
});
check(!!field, 'there is a "Search diamonds" field on the rail (#diamond-search)');
check(!!field && field.tag === 'INPUT' && field.type === 'search' && field.cls === 'diamond-search',
	`it is a search input with the Agents field's class: ${JSON.stringify(field && [field.tag, field.type, field.cls])}`);
check(!!field && field.ph === 'Search diamonds', `placeholder "Search diamonds": ${field && field.ph}`);
check(!!field && !!field.aria, `it has an accessible name: ${field && field.aria}`);
check(!!field && field.inFind && field.beforeFilter, 'it sits in .diamond-find, above "Filter by tag" (the Agents order)');
check(!!field && field.sameLook === true, `drawn exactly like #agent-search: ${field && field.look} vs ${field && field.agentLook}`);
check(!!field && field.shown, 'it is drawn without a click');

// ── Names: substring, case-insensitive; matched letters marked ───────────────
if (field) {
	await type('hoog');
	check(JSON.stringify(await names()) === JSON.stringify(['Cornelis Hoogland', 'Fred Hoogland']),
		`"hoog" matches names anywhere in them: ${JSON.stringify(await names())}`);
	const marks = await page.$$eval('#diamond-list .session-box-name .rail-hit', (els) => els.map((e) => ({
		t: e.textContent, c: getComputedStyle(e).color })));
	const accent = await page.evaluate(() => {
		const p = document.createElement('span'); p.style.color = 'var(--accent)'; document.body.appendChild(p);
		const c = getComputedStyle(p).color; p.remove(); return c;
	});
	check(marks.length === 2 && marks.every((m) => m.t === 'Hoog' && m.c === accent),
		`the matched letters, in their own case, take the accent colour: ${JSON.stringify(marks)} accent ${accent}`);
	const heights = await page.$$eval('#diamond-list .diamond-box', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
	await type('');
	const heights0 = await page.$$eval('#diamond-list .diamond-box', (els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
	check(heights.every((h) => heights0.includes(h)), `tiles keep their height while marked: ${JSON.stringify(heights)} / ${JSON.stringify(heights0)}`);
	check((await page.$$('#diamond-list .rail-hit')).length === 0 && (await names()).length === 6,
		'an empty field shows every Diamond again and marks nothing');

	// ── Tags: prefix, not substring ─────────────────────────────────────────
	await type('writ');
	check(JSON.stringify(await names()) === JSON.stringify(['Brand voice']), `"writ" finds the Diamond tagged writing: ${JSON.stringify(await names())}`);
	await type('PHIL');
	check(JSON.stringify(await names()) === JSON.stringify(['Ontheism']), `tags match case-insensitively ("PHIL"): ${JSON.stringify(await names())}`);
	await type('ork');
	check((await names()).length === 0, `a tag matches from its start only ("ork" is not "work"): ${JSON.stringify(await names())}`);

	// ── No match ────────────────────────────────────────────────────────────
	await type('zebra');
	check((await names()).length === 0 && JSON.stringify(await note()) === JSON.stringify(['No match']),
		`nothing fits: the list says "No match" and nothing else: ${JSON.stringify(await note())}`);

	// ── Composition with the tag filter: both apply ─────────────────────────
	await type('');
	check(await poolClick('family'), 'the pool offers "family"');
	check(JSON.stringify(await names()) === JSON.stringify(['Cornelis Hoogland', 'Fred Hoogland']),
		`the filter alone: family -> ${JSON.stringify(await names())}`);
	await type('cor');
	check(JSON.stringify(await names()) === JSON.stringify(['Cornelis Hoogland']),
		`filter AND search: family + "cor" -> ${JSON.stringify(await names())}`);
	await type('ship');
	check((await names()).length === 0 && JSON.stringify(await note()) === JSON.stringify(['No match']),
		`a name outside the filter stays out ("ship" under family): ${JSON.stringify(await names())} ${JSON.stringify(await note())}`);
	await type('cor');
	// A tag-filter repaint (a chip clicked) redraws the list: the field and its narrowing must survive it.
	await poolClick('family');	// family -> refused
	await poolClick('family');	// refused -> off
	check((await page.inputValue('#diamond-search')) === 'cor' && JSON.stringify(await names()) === JSON.stringify(['Cornelis Hoogland']),
		`the filter going off keeps the search: ${JSON.stringify(await names())}`);

	// ── Esc clears ──────────────────────────────────────────────────────────
	await page.focus('#diamond-search');
	await page.keyboard.press('Escape');
	await page.waitForTimeout(300);
	check((await page.inputValue('#diamond-search')) === '' && (await names()).length === 6,
		`Esc clears the field and every Diamond comes back: ${JSON.stringify(await names())}`);
	check(await page.evaluate(() => !!document.querySelector('#panel-rail') && getComputedStyle(document.querySelector('#panel-rail')).display !== 'none'),
		'and Esc in the field did not close the rail as well');

	// ── A new Diamond is never hidden by the search ─────────────────────────
	await type('zebra');
	await page.click('#new-diamond-btn', { timeout: 8000 });
	await page.waitForSelector('.dlg-input', { timeout: 10000 });
	await page.fill('.dlg-input', 'Quokka studies');
	await page.click('.dlg-ok', { force: true });
	await page.waitForTimeout(900);
	check((await names()).includes('Quokka studies') && (await page.inputValue('#diamond-search')) === '',
		`a Diamond just made is on the rail, the search put down: ${JSON.stringify(await names())}`);
}

const errs = errors(s).filter((e) => !/502 \(Bad Gateway\)/.test(e));
check(errs.length === 0, `no console errors: ${JSON.stringify(errs.slice(0, 3))}`);
await s.close();

console.log(out.join('\n'));
console.log(bad === 0 ? `\nALL ${out.length} CHECKS PASSED` : `\n${bad} of ${out.length} FAILED`);
process.exit(bad === 0 ? 0 : 1);
