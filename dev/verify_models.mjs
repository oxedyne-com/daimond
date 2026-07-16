// verify_models.mjs — a key per provider, and one model starred as the default.
//
// Daimond used to hold ONE provider: a base URL, a key, a model. The model you want for a cheap
// classification is not the one you want for a hard refactor, and they rarely sit behind the same
// key — so a key is held per provider now, and exactly one model is the default a new chat starts
// on. This drives that: the migration off the old single config (which a real user HAS, with a
// real key in it), adding a second provider without evicting the first, starring a default, and
// the status row that counts what all of them can run.
import { open, signInAs, shot } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'models', connect: false });
const p = s.page;
await p.waitForTimeout(1500);

// ── The migration ───────────────────────────────────────────────────────
//
// A user on the old build has a provider, a key and a model in `daimond-byok`. The shape changed
// underneath them; losing any of it would be the app forgetting something they told it.

await p.evaluate(() => {
	localStorage.setItem('daimond-byok', JSON.stringify({
		baseUrl: 'https://api.fireworks.ai/inference/v1/chat/completions',
		apiKey:  'old-single-key',
		model:   'accounts/fireworks/models/glm-5p2',
		maxTokens: 4096, tools: true,
	}));
	localStorage.setItem('daimond-models', JSON.stringify([
		'accounts/fireworks/models/glm-5p2', 'accounts/fireworks/models/other',
	]));
	localStorage.removeItem('daimond-models-v2');   // as if this build had never run
});
await p.reload({ waitUntil: 'domcontentloaded' });
await signInAs(s, 'models');
await p.waitForTimeout(2000);

const migrated = await p.evaluate(() => {
	const M = window.DaimondModels;
	const provs = M.providers();
	const d = M.getDefault();
	return {
		provs: provs.map(x => ({ id: x.id, hasKey: x.hasKey, count: x.count })),
		def:   d,
		key:   M.keyFor('fireworks'),
		ready: M.ready(),
		count: M.count(),
	};
});
check('the single provider is carried into the store that holds many',
	migrated.provs.length === 1 && migrated.provs[0].id === 'fireworks' && migrated.provs[0].hasKey,
	JSON.stringify(migrated.provs));
check('its key survives the change of shape', migrated.key === 'old-single-key');
check('and the model they chose is still the default',
	migrated.def.provider === 'fireworks' && /glm-5p2$/.test(migrated.def.model),
	`${migrated.def.provider} / ${migrated.def.model}`);
check('the app can still run', migrated.ready === true);

// ── The status row counts models, not providers ─────────────────────────

const rail = await p.evaluate(() => {
	const r = document.getElementById('astat-model');
	return { text: r ? r.textContent.trim() : '(none)', count: window.DaimondModels.count() };
});
check('the status row says Models and counts them',
	/Models/.test(rail.text) && rail.text.includes(String(rail.count)),
	`${rail.text} (count ${rail.count})`);

// ── A second provider joins; it does not evict the first ────────────────

const second = await p.evaluate(async () => {
	const M = window.DaimondModels;
	M.addProvider('groq', {});
	await M.setKey('groq', 'the-groq-key');
	// Stand in for the provider's /models answer: the network is not under test here.
	M.providers();
	const store = JSON.parse(localStorage.getItem('daimond-models-v2'));
	store.providers.groq.models = ['llama-3.3-70b', 'mixtral-8x7b'];
	localStorage.setItem('daimond-models-v2', JSON.stringify(store));
	M.init({});                                   // reload the store from disk
	await M.unseal();
	return {
		provs: M.providers().map(x => ({ id: x.id, count: x.count, hasKey: x.hasKey })),
		count: M.count(),
		fireworksKey: M.keyFor('fireworks'),
		groqKey: M.keyFor('groq'),
		def: M.getDefault(),
	};
});
check('a second provider is added alongside the first',
	second.provs.length === 2, JSON.stringify(second.provs));
check('and does not evict the first provider’s key',
	second.fireworksKey === 'old-single-key' && second.groqKey === 'the-groq-key');
check('the model count is the sum across providers',
	second.count === 4, second.count + ' models');
check('and adding a provider does not silently move the default',
	second.def.provider === 'fireworks', second.def.provider);

// ── Starring a different default ────────────────────────────────────────

const starred = await p.evaluate(() => {
	const M = window.DaimondModels;
	M.setDefault('groq', 'llama-3.3-70b');
	const r = M.resolve('', '');            // what a NEW chat would run on
	const keep = M.resolve('fireworks', 'accounts/fireworks/models/glm-5p2');
	return { def: M.getDefault(), resolved: r, kept: keep };
});
check('starring a model makes it what a new chat runs on',
	starred.resolved && starred.resolved.provider === 'groq'
	&& starred.resolved.model === 'llama-3.3-70b'
	&& starred.resolved.apiKey === 'the-groq-key',
	JSON.stringify(starred.resolved && { p: starred.resolved.provider, m: starred.resolved.model }));
check('a chat already running on another provider still resolves to it',
	starred.kept && starred.kept.provider === 'fireworks'
	&& starred.kept.apiKey === 'old-single-key',
	'an existing chat is not dragged onto the new default');

// ── The panel ───────────────────────────────────────────────────────────

await p.evaluate(() => { document.getElementById('astat-model').click(); });
await p.waitForTimeout(700);

const panel = await p.evaluate(() => {
	const list = document.getElementById('models-list');
	const heads = [...document.querySelectorAll('.models-prov-name')].map(e => e.textContent);
	return {
		shown:  !!(document.getElementById('admin-models') || {}).offsetParent,
		heads:  heads,
		footer: (document.querySelector('.models-default') || {}).textContent || '',
	};
});
check('the Models row opens the models form', panel.shown === true);
check('and it lists every provider', panel.heads.length === 2, panel.heads.join(', '));
check('and says plainly what a new chat will start on',
	/Groq/.test(panel.footer) && /llama-3\.3-70b/.test(panel.footer), panel.footer.trim());

// Expand one and check the star is on the model itself.
await p.evaluate(() => {
	[...document.querySelectorAll('.models-prov-head')]
		.find(h => /Groq/.test(h.textContent)).click();
});
await p.waitForTimeout(400);
const expanded = await p.evaluate(() => {
	const models = [...document.querySelectorAll('.models-model')].map(m => m.textContent.trim());
	const on = (document.querySelector('.models-model.on') || {}).textContent || '';
	return { models, on };
});
check('expanding a provider shows its models, with the default starred',
	expanded.models.length === 2 && /★/.test(expanded.on) && /llama-3\.3-70b/.test(expanded.on),
	expanded.on.replace(/\s+/g, ' '));

await shot(s, 'models');
const errs = s.errs.filter(e => !/favicon|404|401|net::ERR/.test(e));
console.log('\nconsole errors:', errs.slice(0, 4));
await s.close();

console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) console.log('FAILED:\n  ' + bad.join('\n  '));
process.exit(bad.length ? 1 : 0);
