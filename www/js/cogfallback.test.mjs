/* ============================================================
   Test — the model pulldown never puts the starred model in place
   of the one a Diamond actually has (r535 U5, the cog fallback).
   ------------------------------------------------------------
   The Diamond cog pulldown is filled by `DaimondModels.fillSelect`
   with the model the Diamond runs on now. When that model was not
   among the options (its provider was removed, its key is gone, the
   catalogue no longer lists it), the fill fell back to the STARRED
   default, so the pulldown showed a model nobody had picked and
   Change would then have switched the Diamond onto it.

   This drives the real www/js/models.js over a stand-in `<select>`
   and asserts what the fix turns on:

     (a) KEPT. A saved model that is not offered is shown as its own
         first option, selected, enabled, marked `dataset.kept`, and
         the starred default is NOT the selection.

     (b) EMPTY STAYS DEFAULT. Asking for no model still gets the
         starred default, and draws no kept option.

     (c) LISTED IS UNCHANGED. Asking for a model that is offered
         selects it and draws no kept option; the option list is the
         one an empty ask draws.

     (d) NO CHANGE. Reading the pulldown back as it was filled plans
         no switch, so Change stays hidden; picking the starred model
         and then the kept one again plans none either.

   No browser: the stand-in covers what fillSelect and `pick` touch.
     node www/js/cogfallback.test.mjs
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

// ── A stand-in <select> ────────────────────────────────────────
// Only what `fillSelect`, `select` and `pick` touch. A single-select keeps one chosen option;
// with none chosen the first enabled option stands, as a browser's reset algorithm has it.
function root(el) { while (el.parent) el = el.parent; return el; }
function mkEl(tag) {
	const el = {
		tag, children: [], parent: null, dataset: {},
		textContent: '', value: '', title: '', label: '', disabled: false,
	};
	el.appendChild = (c) => { c.parent = el; el.children.push(c); return c; };
	el.insertBefore = (c, ref) => {
		c.parent = el;
		const i = ref ? el.children.indexOf(ref) : -1;
		if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
		return c;
	};
	Object.defineProperty(el, 'firstChild', { get: () => el.children[0] || null });
	if (tag === 'option') {
		Object.defineProperty(el, 'selected', {
			get: () => root(el)._chosen === el,
			set: (v) => { const r = root(el); if (v) r._chosen = el; else if (r._chosen === el) r._chosen = null; },
		});
	}
	if (tag === 'select') {
		el._chosen = null;
		const all = () => {
			const out = [];
			const walk = (n) => n.children.forEach((c) => { if (c.tag === 'option') out.push(c); else walk(c); });
			walk(el);
			return out;
		};
		Object.defineProperty(el, 'innerHTML', { set: () => { el.children = []; el._chosen = null; }, get: () => '' });
		el.querySelectorAll = () => all();
		el.querySelector = () => all().find((o) => !o.disabled) || null;
		Object.defineProperty(el, 'selectedOptions', {
			get: () => {
				const o = el._chosen || all().find((x) => !x.disabled);
				return o ? [o] : [];
			},
		});
		el.options = () => all();
	}
	return el;
}

// ── A minimal browser sandbox ──────────────────────────────────
const store = new Map();
const localStorage = {
	getItem:    (k) => (store.has(k) ? store.get(k) : null),
	setItem:    (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
const win = globalThis;
win.dispatchEvent = () => true;
const documentShim = {
	addEventListener: () => {},
	getElementById:   () => null,
	createElement:    mkEl,
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
if (!M || !M.fillSelect || !M.pick) { console.error('ABORT: DaimondModels.fillSelect/pick missing'); process.exit(2); }

// The catalogue a provider answers with, served to `fetchModels`.
win.fetch = async () => ({
	ok: true,
	json: async () => ({ data: [{ id: 'm-star' }, { id: 'm-other' }, { id: 'm-third' }] }),
});

const sel = () => mkEl('select');
const opts = (s) => s.options();
const chosen = (s) => s.selectedOptions[0] || null;

async function main() {
	M.init({});
	M.addProvider('fw', { url: 'https://api.fireworks.ai/x', name: 'Fireworks' });
	await M.setKey('fw', 'k-fw');
	await M.fetchModels('fw');
	M.setDefault('fw', 'm-star');

	// ── (c) LISTED IS UNCHANGED ────────────────────────────────
	console.log('(c) a model that is offered is selected, and nothing else is drawn');
	const sBase = sel();
	M.fillSelect(sBase, '', '');
	const baseCount = opts(sBase).length;
	const sListed = sel();
	M.fillSelect(sListed, 'fw', 'm-other');
	check('the listed model is the selection',
		!!chosen(sListed) && chosen(sListed).value === 'm-other' && chosen(sListed).dataset.provider === 'fw');
	check('no kept option is drawn', !opts(sListed).some((o) => o.dataset.kept === '1'));
	check('the option list is the one an empty ask draws', opts(sListed).length === baseCount,
		opts(sListed).length + ' vs ' + baseCount);

	// ── (b) EMPTY STAYS DEFAULT ────────────────────────────────
	console.log('(b) asking for no model still gets the starred default');
	check('an empty ask selects the starred default',
		!!chosen(sBase) && chosen(sBase).value === 'm-star' && chosen(sBase).dataset.provider === 'fw');
	check('an empty ask draws no kept option', !opts(sBase).some((o) => o.dataset.kept === '1'));

	// ── (a) KEPT ───────────────────────────────────────────────
	console.log('(a) a saved model that is not offered stays the selection');
	const sGone = sel();
	M.fillSelect(sGone, 'fw', 'm-gone');
	const kept = chosen(sGone);
	check('the selection is the saved model', !!kept && kept.value === 'm-gone',
		kept ? kept.value : 'none');
	check('the starred default is not the selection', !!kept && kept.value !== 'm-star');
	check('it carries its provider and the kept mark',
		!!kept && kept.dataset.provider === 'fw' && kept.dataset.kept === '1');
	check('it is enabled, so it reads as a value and not a refusal', !!kept && kept.disabled === false);
	check('it is the first option', opts(sGone)[0] === kept);
	check('it says the model is not offered',
		!!kept && kept.textContent.indexOf('m-gone') === 0 && kept.textContent.indexOf('models.not_offered') !== -1,
		kept ? kept.textContent : '');
	check('the offered models are all still there',
		opts(sGone).length === baseCount + 1, opts(sGone).length + ' vs ' + (baseCount + 1));

	console.log('(a′) the same when the saved provider is gone');
	const sNoProv = sel();
	M.fillSelect(sNoProv, 'removed-provider', 'm-star');
	const k2 = chosen(sNoProv);
	check('a model named for a provider that is not listed is kept, not swapped for the starred one',
		!!k2 && k2.dataset.kept === '1' && k2.dataset.provider === 'removed-provider' && k2.value === 'm-star');

	// ── (d) NO CHANGE ──────────────────────────────────────────
	console.log('(d) the kept pick plans no change, so Change stays hidden');
	const own = { provider: 'fw', model: 'm-gone' };
	const first = M.pick(sGone);
	check('pick reads the saved model back', first.model === 'm-gone' && first.provider === 'fw',
		first.provider + '/' + first.model);
	check('the pulldown as filled plans no switch', M.planModelSwitch(own, first, 0).changed === false);
	const star = opts(sGone).find((o) => o.value === 'm-star' && !o.dataset.fav);
	star.selected = true;
	check('picking the starred model is a change', M.planModelSwitch(own, M.pick(sGone), 0).changed === true);
	kept.selected = true;
	check('picking the kept model back plans no change', M.planModelSwitch(own, M.pick(sGone), 0).changed === false);

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks + ' checks');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
