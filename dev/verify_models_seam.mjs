// gateway: none
// verify_models_seam.mjs — the Models panel draws the same DOM before and after a pure split.
//
// FIRE D-20261018-09 S0 cut `render()` in models.js into `renderProviders(box)` (the provider
// rows) and `routingFor(providerId, model, box)` (the per-model routing field and its note), so
// three later units can each own one block. A split that moves code is only a split if nothing
// on screen moves with it. This loads the page twice in one browser, once with `models.js` as it
// was at a base commit and once as it is in the tree, seeds the same store each time (two
// providers, a twin model on both, a routing value, every row opened), and compares the
// serialised `#models-list`. A second arm takes OpenRouter's catalogue away so the routing
// preference shows only in the "set earlier" disclosure, the other place the field is drawn.
//
//   node dev/verify_models_seam.mjs [--base <rev>]   # default base: 90eaed81 (r578d)
//
// Exit 0 when every arm is identical, 1 on any difference (the first one is printed).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, signInAs } from './harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const die  = (why) => { console.error('ABORT: ' + why); process.exit(2); };

const bi   = process.argv.indexOf('--base');
const BASE = bi > 0 ? process.argv[bi + 1] : '90eaed8160a9ab9551c7c1891678942f946a7fd7';
let before;
try {
	before = execFileSync('git', ['-C', ROOT, 'show', BASE + ':www/js/models.js'],
		{ encoding: 'utf8', maxBuffer: 64 << 20 });
} catch (e) { die(`cannot read www/js/models.js at ${BASE}: ${e.message}`); }
const after = fs.readFileSync(path.join(ROOT, 'www/js/models.js'), 'utf8');
if (before === after) die('models.js is unchanged from the base; there is nothing to compare');

let served = after;		// which models.js the next load is given

const s = await open({
	name: 'modelsseam', connect: false,
	route: async (pg) => {
		await pg.route('**/models.js',
			(r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: served }));
		// No catalogue request leaves the machine: the store is seeded by hand.
		await pg.route((url) => /\/models$/.test(url.pathname), (r) => r.abort());
	},
});
const p = s.page;

/// Seed one arm's store, open every provider row, and return `#models-list` serialised.
async function draw(arm) {
	await p.evaluate(() => localStorage.removeItem('daimond-models-v2'));
	await p.reload({ waitUntil: 'domcontentloaded' });
	await signInAs(s, 'modelsseam');
	await p.waitForTimeout(800);
	await p.evaluate(async (arm) => {
		const M = window.DaimondModels;
		M.addProvider('openrouter', {});
		M.addProvider('groq', {});
		await M.setKey('openrouter', 'seam-or-key');
		await M.setKey('groq', 'seam-groq-key');
		const raw = JSON.parse(localStorage.getItem('daimond-models-v2'));
		// `llama-3.3-70b` on both rows is the twin; the OpenRouter ids carry a vendor prefix,
		// which `baseName` strips, so the twin is found across the two spellings.
		raw.providers.openrouter.models = arm === 'nocat' ? []
			: ['meta-llama/llama-3.3-70b', 'deepseek/deepseek-v3'];
		raw.providers.groq.models = ['llama-3.3-70b', 'mixtral-8x7b'];
		localStorage.setItem('daimond-models-v2', JSON.stringify(raw));
		M.init({});
		await M.unseal();
		M.setRouting('openrouter', 'meta-llama/llama-3.3-70b', 'groq, -together');
		M.setRouting('openrouter', 'deepseek/deepseek-v3', '!fireworks');
		M.setDefault('groq', 'llama-3.3-70b');
		M.render();
	}, arm);
	await p.waitForTimeout(300);
	// Open every row; each click redraws, so the heads are looked up afresh each time.
	for (const id of ['openrouter', 'groq']) {
		await p.evaluate((id) => {
			const h = document.querySelector(`[data-prov="${id}"] .models-prov-head`);
			if (h && h.getAttribute('aria-expanded') !== 'true') h.click();
		}, id);
		await p.waitForTimeout(200);
	}
	return p.evaluate(() => {
		const el = document.getElementById('models-list');
		// The field's value is a property, not an attribute; serialise it so a routing value
		// drawn into the wrong box, or not at all, is a difference.
		const vals = [...el.querySelectorAll('input')].map(i => i.value);
		return {
			html:   el ? el.outerHTML : '',
			vals:   vals,
			twins:  el.querySelectorAll('.models-econ').length,
			fields: el.querySelectorAll('.models-routing-input').length,
			disc:   el.querySelectorAll('.models-routing-disc').length,
		};
	});
}

const bad = [];
for (const arm of ['full', 'nocat']) {
	served = before;
	const a = await draw(arm);
	served = after;
	const b = await draw(arm);
	const same = a.html === b.html && JSON.stringify(a.vals) === JSON.stringify(b.vals);
	// The seed must exercise what it claims to, or an empty panel would compare equal.
	const seeded = arm === 'full'
		? a.twins >= 2 && a.fields === 2 && a.vals.includes('groq, -together')
		: a.disc === 1 && a.fields === 2;
	console.log(`${same && seeded ? 'PASS' : 'FAIL'}  ${arm}: ${a.html.length} chars, `
		+ `${a.fields} routing field(s), ${a.twins} twin mark(s), ${a.disc} disclosure(s); `
		+ (same ? 'identical' : 'DIFFERENT'));
	if (!seeded) bad.push(`${arm}: the seed did not draw what it was meant to`);
	if (!same) {
		let i = 0;
		while (i < a.html.length && a.html[i] === b.html[i]) i++;
		console.log(`  first difference at ${i}:\n  base: ${a.html.slice(i - 80, i + 120)}\n`
			+ `  head: ${b.html.slice(i - 80, i + 120)}`);
		bad.push(`${arm}: #models-list differs`);
	}
}
await s.close();
if (bad.length) { console.log('\nFAILED:\n  ' + bad.join('\n  ')); process.exit(1); }
console.log('\nthe panel is identical before and after the split');
process.exit(0);
