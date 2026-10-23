/* ============================================================
   Test — one display name for a model, at every call site
   (D-20261018-09 U3a + U5a, INT provstatus 23 Oct).
   ------------------------------------------------------------
   U5a's `displayName(provider, model)` (the catalogue's name) and
   U3a's `displayName(model)` (the id tidied) both merged in, and the
   later declaration won: every U5a caller passing `(p.id, m)` drew the
   PROVIDER id tidied ("Or") where the model's name belongs. There is
   one `displayName(provider, model)` now, with U3a's tidy as its last
   fallback (`tidyName`).

     (a) NAMED. The catalogue's name, its maker prefix dropped.
     (b) TIDIED. No catalogue name: the id's leaf as its maker writes it.
     (c) DRAWN. The pulldown (`fillSelect`, a U5a call site) shows the
         catalogue name, never the provider id.

     node www/js/models_names.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const store = new Map();
const localStorage = {
	getItem:    (k) => (store.has(k) ? store.get(k) : null),
	setItem:    (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};

// Just enough of an element for `fillSelect`: children, dataset, text, a flat option query.
class El {
	constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.textContent = ''; }
	get firstChild() { return this.children[0] || null; }
	set innerHTML(v) { this.children = []; }
	appendChild(c) { this.children.push(c); return c; }
	insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? 0 : i, 0, c); return c; }
	options() { return this.children.flatMap((c) => c.tagName === 'OPTION' ? [c] : c.options()); }
	querySelectorAll(q) { return q === 'option' ? this.options() : []; }
	querySelector(q) { return this.options().find((o) => !o.disabled) || null; }
}

const win = globalThis;
win.dispatchEvent = () => true;
const documentShim = {
	addEventListener: () => {},
	getElementById:   () => null,
	createElement:    (tag) => new El(tag),
	visibilityState:  'hidden',
};
function loadScript(rel) {
	const body = readFileSync(join(HERE, rel), 'utf8');
	const fn = new Function('window', 'document', 'localStorage', 'console', 'globalThis', body);
	fn(win, documentShim, localStorage, console, globalThis);
}

loadStore(win, localStorage);
const tombMap = {};
win.DaimondCore = {
	tombs:      () => Object.assign({}, tombMap),
	tombstone:  (k, id, at) => { tombMap[id] = at || Date.now(); },
	mergeTombs: (k, inc) => { for (const id in (inc || {})) if (!tombMap[id] || inc[id] > tombMap[id]) tombMap[id] = inc[id]; return Object.assign({}, tombMap); },
};
loadScript('stamp.js');
globalThis.DaimondStamp = win.DaimondStamp;
loadScript('models.js');

const M = win.DaimondModels;

const REPLY = { data: [
	{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: DeepSeek V4.1 Flash',
		pricing: { prompt: '0.0000003', completion: '0.0000012' } },
	{ id: 'z-ai/glm-5.3-flash', pricing: { prompt: '0.000001', completion: '0.000003' } },
] };

async function main() {
	win.fetch = async () => ({ ok: true, json: async () => REPLY });
	M.init({});
	M.addProvider('or', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey('or', 'k-or');
	await M.fetchModels('or');

	console.log('(a) the catalogue names the model');
	const named = M.displayName('or', 'deepseek/deepseek-v4.1-flash');
	check('the catalogue name, its maker prefix dropped', named === 'DeepSeek V4.1 Flash', JSON.stringify(named));

	console.log('(b) no catalogue name: the id tidied');
	const tidy = M.displayName('or', 'z-ai/glm-5.3-flash');
	check('the leaf as its maker writes it', tidy === 'GLM 5.3 Flash', JSON.stringify(tidy));
	const bare = M.displayName('', 'z-ai/glm-5.3-flash');
	check('and with no provider known', bare === 'GLM 5.3 Flash', JSON.stringify(bare));

	console.log('(c) the pulldown draws the model, never the provider');
	const sel = new El('select');
	M.fillSelect(sel, 'or', 'deepseek/deepseek-v4.1-flash');
	const opts = sel.options();
	const ds = opts.find((o) => o.value === 'deepseek/deepseek-v4.1-flash');
	check('the option is there', !!ds, opts.length + ' option(s)');
	check('it reads the catalogue name', !!ds && ds.textContent.startsWith('DeepSeek V4.1 Flash'),
		ds && JSON.stringify(ds.textContent));
	check('no option reads the provider id', !opts.some((o) => /^(or|Or)\b/.test(o.textContent)),
		JSON.stringify(opts.map((o) => o.textContent)));

	console.log(failures ? '\nFAILED ' + failures + ' of ' + checks : '\nall ' + checks + ' checks pass');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
