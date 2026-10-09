/* ============================================================
   Test — the provider's own model list says which models take
   pictures (r540 T2, owner D1).
   ------------------------------------------------------------
   The engine's hand allow-list of model names is wrong for every
   model released after it was written, so a multimodal model it
   had never heard of (`z-ai/glm-5.3-flash`) was told it "cannot be
   shown pictures". The provider's `/models` reply says what each
   model takes; `DaimondModels` keeps that, and the page hands it to
   the engine (`set_sight`) before a model is dispatched.

   This drives the real www/js/models.js and asserts:

     (a) READ. `sightOf` reads OpenRouter's `architecture.input_modalities`,
         the older `architecture.modality` ("text+image->text"), a
         top-level `input_modalities`, and a `capabilities` flag;
         a text-only entry is false; an entry that says nothing is
         null, which is NOT the same as false.

     (b) KEPT. `fetchModels` stores the flag on the model's rates row
         (so it is merged and synced with them) and `sightFor` answers
         true, false or null for a model.

     (c) SURVIVES THE SYNC SHAPE. The sorted copy a device syncs keeps
         the flag, including on a row that carries no prices.

   No browser: the stand-in covers what models.js touches.
     node www/js/modelsight.test.mjs
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
if (!M || typeof M.sightOf !== 'function' || typeof M.sightFor !== 'function') {
	console.error('ABORT: DaimondModels.sightOf / sightFor missing');
	process.exit(2);
}

// What an OpenRouter-shaped reply says, entry by entry.
const REPLY = { data: [
	{ id: 'z-ai/glm-5.3-flash', architecture: { input_modalities: ['text', 'image'], modality: 'text+image->text' },
		pricing: { prompt: '0.0000003', completion: '0.0000012' } },
	{ id: 'acme/old-modality', architecture: { modality: 'text+image->text' } },
	{ id: 'acme/text-only', architecture: { input_modalities: ['text'], modality: 'text->text' },
		pricing: { prompt: '0.000001', completion: '0.000002' } },
	{ id: 'acme/top-level', input_modalities: ['Image', 'text'] },
	{ id: 'acme/flagged', capabilities: { vision: true } },
	{ id: 'acme/silent' },
	{ id: 'acme/priced-only', pricing: { prompt: '0.000001', completion: '0.000002' } },
] };

async function main() {
	console.log('(a) sightOf reads what the provider says, and null when it says nothing');
	const by = (id) => M.sightOf(REPLY.data.find((m) => m.id === id));
	check('input_modalities with image is true', by('z-ai/glm-5.3-flash') === true);
	check('only the older modality string is true', by('acme/old-modality') === true);
	check('text-only is false', by('acme/text-only') === false);
	check('a top-level list, any case, is true', by('acme/top-level') === true);
	check('a capabilities flag is read', by('acme/flagged') === true);
	check('an entry that says nothing is null, not false', by('acme/silent') === null);
	check('a bare string or nothing is null', M.sightOf('x') === null && M.sightOf(null) === null);

	console.log('(b) fetchModels keeps the flag and sightFor answers from it');
	win.fetch = async () => ({ ok: true, json: async () => REPLY });
	M.init({});
	M.addProvider('or', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey('or', 'k-or');
	await M.fetchModels('or');
	check('the unknown multimodal model is true', M.sightFor('or', 'z-ai/glm-5.3-flash') === true);
	check('the text-only model is false', M.sightFor('or', 'acme/text-only') === false);
	check('a model the list is silent on is null', M.sightFor('or', 'acme/silent') === null);
	check('a priced model with no word on pictures is null', M.sightFor('or', 'acme/priced-only') === null);
	check('a model not in the list is null', M.sightFor('or', 'acme/absent') === null);
	check('an unknown provider is null', M.sightFor('nobody', 'z-ai/glm-5.3-flash') === null);
	const rate = M.rateFor('or', 'z-ai/glm-5.3-flash');
	check('the prices still come through beside it', !!rate && rate.inPerM > 0 && rate.outPerM > 0,
		JSON.stringify(rate));
	check('a row with only the flag is no price', M.rateFor('or', 'acme/top-level') === null);

	console.log('(c) the flag survives the sync shape');
	const rec = win.DaimondStore.get('daimond-models-v2');
	const rates = rec && rec.providers && rec.providers.or && rec.providers.or.rates;
	check('the stored rates row carries it', !!rates && rates['z-ai/glm-5.3-flash'] && rates['z-ai/glm-5.3-flash'].sees === true);
	check('so does a row with no prices', !!rates && rates['acme/top-level'] && rates['acme/top-level'].sees === true);
	check('a silent model has no row to confuse with a no', !!rates && rates['acme/silent'] === undefined);

	console.log('(d) the live wire: OpenRouter /models, 9 Oct 2026, entries verbatim');
	// The architecture objects below are what the provider sent. z-ai/glm-5.3 reads text only
	// and z-ai/glm-5.3-flash takes images, so the two ids a hand table cannot tell apart are
	// told apart by the provider.
	const wire = (id, architecture) => M.sightOf({ id, architecture });
	check('z-ai/glm-5.3-flash takes pictures',
		wire('z-ai/glm-5.3-flash', { modality: 'text+image+video->text', input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] }) === true);
	check('z-ai/glm-5v-turbo takes pictures, image listed first',
		wire('z-ai/glm-5v-turbo', { modality: 'text+image+video->text', input_modalities: ['image', 'text', 'video'], output_modalities: ['text'] }) === true);
	check('z-ai/glm-5.3 is text-only',
		wire('z-ai/glm-5.3', { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] }) === false);
	check('an image in OUTPUT only is not image input',
		wire('x/draws', { modality: 'text->image', input_modalities: ['text'], output_modalities: ['image'] }) === false);

	console.log('(e) the page hands it to the engine at every place an app is built');
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const lift = (name) => {
		const at = src.indexOf('\tfunction ' + name + '(');
		const end = at < 0 ? -1 : src.indexOf('\n\t}\n', at);
		return at < 0 || end < 0 ? null : src.slice(at, end + 4);
	};
	const applySrc = lift('applySight');
	check('applySight is defined in daimond.js', !!applySrc);
	const calls = src.split('applySight(').length - 2;		// less the definition
	const routed = src.split('applyProviderRouting(').length - 2;
	check('it is called wherever provider routing is applied (chat, worker, daimon)',
		calls === routed && calls === 3, calls + ' vs ' + routed);
	const seen = [];
	const mk = (sees) => ({ DaimondModels: { sightFor: () => sees } });
	const run = (sees, app) => new Function('DaimondModels', applySrc + '\nreturn applySight;')(mk(sees).DaimondModels)(app, 'or', 'm');
	run(true,  { set_sight: (n) => seen.push(n) });
	run(false, { set_sight: (n) => seen.push(n) });
	run(null,  { set_sight: (n) => seen.push(n) });
	check('true is 1, false is -1, nothing said is 0', seen.join(',') === '1,-1,0', seen.join(','));
	let threw = false;
	try { run(true, {}); run(true, null); run(true, { set_sight: () => { throw new Error('old wasm'); } }); }
	catch (e) { threw = true; }
	check('an older engine with no setter, or one that throws, is no error', !threw);

	console.log('\n' + (failures ? ('FAILED ' + failures + ' of ' + checks) : ('ok: ' + checks + ' checks')));
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
