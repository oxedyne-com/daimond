/* ============================================================
   Test — a chat's Effort is stepped from the model's own levels
   (D-20261006-04/-05; owner ruling 9 Oct: "build it").
   ------------------------------------------------------------
   OpenRouter's `/models` entry names the reasoning levels each
   model takes (`reasoning.supported_efforts`) and its default
   (`reasoning.default_effort`). The chat's Effort control is drawn
   from that list and from nothing else, so a model with no levels
   shows no control and sends nothing.

     (a) READ. `effortsOf` reads the levels, ordered low to high,
         drops a rung this build cannot spell, and is null for a
         model that names none.

     (b) KEPT. `fetchModels` stores them on the model's rates row,
         `effortsFor` answers from it, and the sync copy keeps them.

     (c) A MODEL CHANGE. `effortAfterSwitch` keeps a level the new
         model offers and clears one it does not, saying so.

     (d) THE WIRE. The page hands the chat's level to the engine at
         every place an app is built, empty when unset.

   No browser: the stand-in covers what models.js touches.
     node www/js/models.test.mjs
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

// Entries as OpenRouter sent them on 9 Oct 2026 (`reasoning` objects verbatim).
const REPLY = { data: [
	{ id: 'acme/three', pricing: { prompt: '0.000001', completion: '0.000002' },
		reasoning: { mandatory: true, supported_efforts: ['high', 'medium', 'low'], default_effort: 'medium' } },
	{ id: 'z-ai/glm-5.3', pricing: { prompt: '0.000001', completion: '0.000003' },
		reasoning: { mandatory: true, default_enabled: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'max' } },
	{ id: 'deepseek/deepseek-chat', pricing: { prompt: '0.0000003', completion: '0.0000012' }, reasoning: null },
	{ id: 'acme/switch-only', reasoning: { mandatory: false, default_enabled: true } },
	{ id: 'acme/odd', reasoning: { supported_efforts: ['ultra', 'low', 'minimal', 'none'] } },
	{ id: 'acme/levels-only', reasoning: { supported_efforts: ['low', 'high'] } },
] };

async function main() {
	if (!M || typeof M.effortsOf !== 'function' || typeof M.effortsFor !== 'function'
			|| typeof M.effortAfterSwitch !== 'function') {
		check('DaimondModels.effortsOf / effortsFor / effortAfterSwitch exist', false);
		console.log('\nFAILED ' + failures + ' of ' + checks);
		process.exit(1);
	}

	console.log('(a) effortsOf reads the model\'s own levels, low to high');
	const by = (id) => M.effortsOf(REPLY.data.find((m) => m.id === id));
	const three = by('acme/three');
	check('low/medium/high, in that order', !!three && three.levels.join(',') === 'low,medium,high',
		JSON.stringify(three));
	check('its default is named', !!three && three.dflt === 'medium');
	const glm = by('z-ai/glm-5.3');
	check('a ladder with gaps keeps its gaps', !!glm && glm.levels.join(',') === 'low,high,max', JSON.stringify(glm));
	check('a model with no reasoning object has no levels', by('deepseek/deepseek-chat') === null);
	check('an on/off switch alone is no levels', by('acme/switch-only') === null);
	const odd = by('acme/odd');
	check('a rung this build cannot spell is dropped', !!odd && odd.levels.join(',') === 'none,minimal,low',
		JSON.stringify(odd));
	check('a bare string or nothing is null', M.effortsOf('x') === null && M.effortsOf(null) === null);

	console.log('(b) fetchModels keeps them and effortsFor answers');
	win.fetch = async () => ({ ok: true, json: async () => REPLY });
	M.init({});
	M.addProvider('or', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey('or', 'k-or');
	await M.fetchModels('or');
	const f = M.effortsFor('or', 'acme/three');
	check('the stored levels come back', !!f && f.levels.join(',') === 'low,medium,high' && f.dflt === 'medium',
		JSON.stringify(f));
	check('a model with none answers null', M.effortsFor('or', 'deepseek/deepseek-chat') === null);
	check('an unlisted model answers null', M.effortsFor('or', 'acme/absent') === null);
	check('an unknown provider answers null', M.effortsFor('nobody', 'acme/three') === null);
	check('a row with levels and no price still has its levels',
		(M.effortsFor('or', 'acme/levels-only') || { levels: [] }).levels.join(',') === 'low,high');
	check('and the prices still come through', !!M.rateFor('or', 'acme/three'));
	const exp = M.exportSync();
	const rows = exp && exp.providers && (exp.providers.or || (Array.isArray(exp.providers)
		? exp.providers.find((p) => p.id === 'or') : null));
	const synced = rows && rows.rates;
	check('the sync copy carries the levels', !!synced && !!synced['acme/three']
		&& Array.isArray(synced['acme/three'].efforts) && synced['acme/three'].efforts.join(',') === 'low,medium,high',
		JSON.stringify(synced && synced['acme/three']));
	check('and a levels-only row', !!synced && !!synced['acme/levels-only']);

	console.log('(c) a model change keeps a level the new model has and clears one it has not');
	const keep = M.effortAfterSwitch('low', 'or', 'z-ai/glm-5.3');
	check('low survives a move to a model that has low', keep.effort === 'low' && keep.cleared === false,
		JSON.stringify(keep));
	const gone = M.effortAfterSwitch('medium', 'or', 'z-ai/glm-5.3');
	check('medium is cleared on a model without it, and says so', gone.effort === '' && gone.cleared === true,
		JSON.stringify(gone));
	const none = M.effortAfterSwitch('low', 'or', 'deepseek/deepseek-chat');
	check('any level is cleared on a model with no levels', none.effort === '' && none.cleared === true);
	const unset = M.effortAfterSwitch('', 'or', 'deepseek/deepseek-chat');
	check('unset stays unset, quietly', unset.effort === '' && unset.cleared === false);

	console.log('(d) the page hands the level to the engine wherever an app is built');
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const lift = (name) => {
		const at = src.indexOf('\tfunction ' + name + '(');
		const end = at < 0 ? -1 : src.indexOf('\n\t}\n', at);
		return at < 0 || end < 0 ? null : src.slice(at, end + 4);
	};
	const applySrc = lift('applyEffort');
	check('applyEffort is defined in daimond.js', !!applySrc);
	if (applySrc) {
		const sent = [];
		const run = (effort, app, levels) => new Function('DaimondModels', applySrc + '\nreturn applyEffort;')(
			{ effortsFor: () => (levels ? { levels: levels, dflt: '' } : null) })(app, 'or', 'm', effort);
		const app = { set_reasoning_effort: (e) => sent.push(e) };
		run('low', app, ['low', 'medium', 'high']);
		run('', app, ['low', 'medium', 'high']);
		run('low', app, null);
		run('max', app, ['low', 'medium', 'high']);
		check('low goes as low; unset, no levels and a level the model lacks go as empty',
			sent.join('|') === 'low|||', JSON.stringify(sent));
		let threw = false;
		try { run('low', {}, ['low']); run('low', null, ['low']); run('low', { set_reasoning_effort: () => { throw new Error('old'); } }, ['low']); }
		catch (e) { threw = true; }
		check('an older engine with no setter, or one that throws, is no error', !threw);
	}
	const calls = src.split('applyEffort(').length - 2;
	const routed = src.split('applyProviderRouting(').length - 2;
	check('it is applied wherever provider routing is (chat, worker, daimon)', calls >= routed && routed === 3,
		calls + ' vs ' + routed);

	console.log('(e) a Diamond on the default keeps its Effort without pinning the model');
	if (typeof M.effortInForce !== 'function') check('DaimondModels.effortInForce exists', false);
	else {
		const rec = { effort: 'low', effortProvider: 'or', effortModel: 'acme/three' };
		check('on the model it was set for, the level holds', M.effortInForce(rec, 'or', 'acme/three').effort === 'low');
		const moved = M.effortInForce(rec, 'or', 'z-ai/glm-5.3');
		check('on another model that offers it, it is kept', moved.effort === 'low' && moved.dropped === false,
			JSON.stringify(moved));
		const lost = M.effortInForce({ effort: 'medium', effortProvider: 'or', effortModel: 'acme/three' }, 'or', 'z-ai/glm-5.3');
		check('on another model that lacks it, it is dropped', lost.effort === '' && lost.dropped === true,
			JSON.stringify(lost));
		check('no level is nothing to drop', M.effortInForce({}, 'or', 'acme/three').dropped === false
			&& M.effortInForce(null, 'or', 'acme/three').effort === '');
	}
	const setSrc = lift('setDiamondModel'), effSrc = lift('diamondEffort'), setEffSrc = lift('setDiamondEffort');
	check('setDiamondModel, diamondEffort and setDiamondEffort are defined in daimond.js',
		!!setSrc && !!effSrc && !!setEffSrc);
	if (setSrc && effSrc && setEffSrc && typeof M.effortInForce === 'function') {
		const KEY = 'models-test-diamonds';
		const dflt = { provider: 'or', model: 'acme/three' };
		const page = new Function('DaimondModels', 'localStorage', 'readJson', 'DIAMOND_MODELS_KEY', 'dflt',
			setSrc + effSrc + setEffSrc
			+ '\nfunction diamondModels() { return readJson(DIAMOND_MODELS_KEY, {}) || {}; }'
			+ '\nfunction diamondModel(id) { var m = diamondModels()[id]; return m && m.model ? m : dflt; }'
			+ '\nreturn { setDiamondModel: setDiamondModel, diamondEffort: diamondEffort, setDiamondEffort: setDiamondEffort, diamondModel: diamondModel };')(
			M, localStorage, (k, f) => { try { return JSON.parse(localStorage.getItem(k)) || f; } catch (e) { return f; } },
			KEY, dflt);
		const rec = () => (JSON.parse(localStorage.getItem(KEY) || '{}') || {}).d1 || {};
		page.setDiamondEffort('d1', 'low');
		check('setting Effort on a default-model Diamond pins no model', !rec().model, JSON.stringify(rec()));
		check('and records the level with the model it was set for',
			rec().effort === 'low' && rec().effortModel === 'acme/three', JSON.stringify(rec()));
		check('the Diamond reads its level', page.diamondEffort('d1') === 'low');
		dflt.model = 'z-ai/glm-5.3';
		check('a default change is followed', page.diamondModel('d1').model === 'z-ai/glm-5.3');
		check('and a level the new default offers is kept', page.diamondEffort('d1') === 'low');
		dflt.model = 'acme/three';
		page.setDiamondEffort('d1', 'medium');
		dflt.model = 'z-ai/glm-5.3';
		check('a level the new default lacks is dropped', page.diamondEffort('d1') === '');
		dflt.model = 'acme/three';
		check('and stays dropped', page.diamondEffort('d1') === '' && !rec().effort, JSON.stringify(rec()));
		page.setDiamondModel('d2', { provider: 'or', model: 'acme/three' });
		page.setDiamondEffort('d2', 'high');
		const d2 = (JSON.parse(localStorage.getItem(KEY)) || {}).d2 || {};
		check('a pinned Diamond keeps its model and its level', d2.model === 'acme/three' && d2.effort === 'high',
			JSON.stringify(d2));
	}

	console.log('\n' + (failures ? ('FAILED ' + failures + ' of ' + checks) : ('ok: ' + checks + ' checks')));
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
