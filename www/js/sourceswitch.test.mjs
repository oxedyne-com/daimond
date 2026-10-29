/* ============================================================
   Test — the per-chat credit-source switch in the composer row
   (OWNKEY SW-1, D-20261024-19; design ownkey_design.md §3).
   ------------------------------------------------------------
   "and it should be easy to switch between credit sources!!!!!!"
   A chat's payment source is switched plainly and per chat, not
   only by moving the global default.

     S1  THE LIST. Daimond credits first, then each provider whose
         key opens on this device (none without one), then "Add a
         provider…"; the current source is checked. 0, 1 and 6
         providers.
     S2  THE STORE. An ordinary chat stores to its own picks; a
         Diamond's chat to the Diamond's model set; the global
         default and every other record are unchanged.
     S2b THE PIN. A source picked on the switch is stored as picked,
         even when it equals the default, so a later move of the
         default does not move the chat (QA-B F1).
     S3  THE MAPPING. Same model when the source lists it, else the
         same canonical name with the vendor prefix stripped, else
         the default's model when the default is on that source,
         else the source's first model.
     S4  THE EFFORT is re-clamped to the new model's levels.
     S6  THE EYE (SW-1b shots). A move that keeps the model's name
         says which sources it moved between, not "Thinker to
         Thinker"; a second press on the switch shuts its menu; the
         source's name gives way when it is the row's only shrinker.
     S5  THE STRINGS. The dead `chat.model_for_chat` is gone from
         all eight locales and the five new keys are in each.

   The REAL models.js and the REAL daimond.js functions (lifted by
   testlift.mjs), in a vm realm.
     node --test www/js/sourceswitch.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import vm from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { source, lift } from './testlift.mjs';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const OR = 'openrouter', FW = 'fireworks', AN = 'anthropic', CR = 'credits';
const MKEY = 'daimond-diamond-models';
const PAGE = ['readJson', 'diamondModels', 'setDiamondModel', 'modelPicksOf', 'diamondPicks', 'chatPicks',
	'summarisingPick', 'diamondEffort', 'diamondModel', 'storedPick', 'chatPairInForce', 'touchChatModel',
	'chatMatOf', 'sourcePairOf', 'sourceOf', 'sourceMenuRows', 'switchChatSource', 'shortModel', 'sourceLabel',
	'sourceMovedPair'];
const PAGE_VARS = ['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF', 'CHAT_MODEL_FIELDS'];

// What each provider's `/models` says it lists, with the Effort levels it takes.
const eff = (levels) => ({ reasoning: { supported_efforts: levels } });
const LISTS = {
	'https://openrouter.ai/api/v1': [
		{ id: 'anthropic/claude-opus-5', ...eff(['low', 'medium', 'high', 'xhigh']) },
		{ id: 'z-ai/glm-5.3', ...eff(['low', 'medium', 'high', 'xhigh', 'max']) },
		{ id: 'or/default' },
	],
	'https://api.fireworks.ai/inference/v1': [
		{ id: 'accounts/fireworks/models/kimi-k3', ...eff(['low', 'high']) },
		{ id: 'z-ai/glm-5.3', ...eff(['low', 'medium', 'high']) },
	],
	'https://api.anthropic.com/v1': [
		{ id: 'claude-haiku-5' },
		{ id: 'claude-opus-5', ...eff(['low', 'medium', 'high']) },
	],
	'https://credits.example/v1': [
		{ id: 'credits/one' },
		{ id: 'claude-opus-5', ...eff(['low', 'medium', 'high', 'xhigh', 'max']) },
	],
};

async function device(o) {
	o = o || {};
	const ls = new Map();
	const localStorage = {
		getItem:    (k) => (ls.has(k) ? ls.get(k) : null),
		setItem:    (k, v) => ls.set(k, String(v)),
		removeItem: (k) => ls.delete(k),
	};
	const doc = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
	const ctx = vm.createContext({ console, localStorage, document: doc, setTimeout, clearTimeout,
		dispatchEvent: () => true, addEventListener: () => {} });
	ctx.window = ctx;
	loadStore(ctx, localStorage);
	const tombs = {};
	ctx.DaimondCore = {
		tombs:      () => Object.assign({}, tombs),
		tombstone:  (k, id, at) => { tombs[id] = at || Date.now(); },
		mergeTombs: (k, inc) => Object.assign(tombs, inc || {}),
	};
	ctx.fetch = async (url) => {
		const base = Object.keys(LISTS).find((b) => String(url).indexOf(b) === 0);
		return { ok: true, status: 200, json: async () => ({ data: LISTS[base] || [{ id: 'generic/model' }] }) };
	};
	vm.runInContext(source('stamp.js'), ctx);
	vm.runInContext(source('models.js'), ctx);
	const M = ctx.DaimondModels;
	M.init({ onChange: () => {} });
	const add = async (id, url, name, key) => {
		M.addProvider(id, { url, name });
		if (key) { await M.setKey(id, key); await M.fetchModels(id); }
	};
	await add(CR, 'https://credits.example/v1', 'Daimond credits', 'cr-key');
	if (o.providers !== 0) {
		await add(OR, 'https://openrouter.ai/api/v1', 'OpenRouter', 'or-key');
		await add(FW, 'https://api.fireworks.ai/inference/v1', 'Fireworks AI', 'fw-key');
		await add(AN, 'https://api.anthropic.com/v1', 'Anthropic', 'an-key');
		await add('nokey', 'https://nokey.example/v1', 'No Key Here', '');	// no key: never listed
	}
	for (const x of (o.extra || [])) await add(x.id, 'https://' + x.id + '.example/v1', x.name, 'k-' + x.id);
	M.setDefault(o.defProvider || (o.providers === 0 ? CR : OR), o.defModel || (o.providers === 0 ? 'credits/one' : 'or/default'));
	localStorage.setItem(MKEY, JSON.stringify(o.models || {}));
	const chats = JSON.parse(JSON.stringify(o.chats || []));
	const L = lift(source('daimond.js'), PAGE, PAGE_VARS);
	const env = {
		DaimondModels: M, cfg: { foldProvider: '', foldModel: '' }, chats, diamonds: [], persisted: 0,
		persistChats: () => { env.persisted++; }, resetDiamondApps: () => {}, bumpDiamonds: () => {},
		t: (k) => k, tOr: (k, d) => d, diag: () => {},
	};
	Object.assign(ctx, env);
	const api = vm.runInContext(L.body + `
		;(function () {
			function fn(n) { try { return eval(n); } catch (e) { return null; } }
			var api = {};
			${JSON.stringify(PAGE)}.forEach(function (n) { api[n] = fn(n); });
			return api;
		})()`, ctx);
	M.bindPicks({ diamond: api.diamondPicks, chat: api.chatPicks, summarising: api.summarisingPick });
	return { M, page: api, chats, env, missing: L.missing, recs: () => JSON.parse(localStorage.getItem(MKEY) || '{}') };
}

const chat = (id, p, m, extra) => Object.assign({ id, name: id, provider: p || '', model: m || '',
	workerProvider: '', workerModel: '', effort: '', updatedAt: 1, metaAt: 1, mat: 1, messages: [] }, extra || {});
const ids = (rows) => rows.map((r) => (r.add ? '+add' : r.id) + (r.checked ? '*' : '')).join(',');

async function main() {
	const d0 = await device({ chats: [chat('c1', OR, 'z-ai/glm-5.3')] });
	if (d0.missing.length) console.log('  (this revision lacks: ' + d0.missing.join(', ') + ')');
	const need = ['sourceOf', 'sourceMenuRows', 'switchChatSource'].filter((n) => typeof d0.page[n] !== 'function');
	const needM = ['sources', 'modelOnSource', 'planSource', 'effortClamp'].filter((n) => typeof d0.M[n] !== 'function');
	check('the page and DaimondModels carry the switch', !need.length && !needM.length,
		'missing: ' + need.concat(needM).join(', '));
	if (need.length || needM.length) return strings();

	console.log('S1 the list: credits, then each provider whose key opens here, then Add');
	{
		const rows = d0.page.sourceMenuRows(d0.chats[0]);
		check('order is credits, then keyed providers, then Add; the current is checked',
			ids(rows) === CR + ',' + OR + '*,' + FW + ',' + AN + ',+add', ids(rows));
		check('a provider with no key is not listed', !rows.some((r) => r.id === 'nokey'));
		check('the credits row is marked as credits and carries a balance slot',
			rows[0].credits === true && typeof rows[0].balance === 'string');
		check('a provider row carries its row name', rows[1].name === 'OpenRouter', rows[1].name);
		const none = await device({ providers: 0, chats: [chat('c1')] });
		check('0 providers: credits (checked, the default is on it) and Add',
			ids(none.page.sourceMenuRows(none.chats[0])) === CR + '*,+add', ids(none.page.sourceMenuRows(none.chats[0])));
		const one = await device({ providers: 0, extra: [{ id: 'p1', name: 'Solo' }], chats: [chat('c1')] });
		check('1 provider: credits, it, Add', ids(one.page.sourceMenuRows(one.chats[0])) === CR + '*,p1,+add');
		const six = await device({ providers: 0, chats: [chat('c1')],
			extra: [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'p' + n, name: 'Provider ' + n + ' with a very long name indeed' })) });
		const r6 = six.page.sourceMenuRows(six.chats[0]);
		check('6 providers: all six between credits and Add', ids(r6) === CR + '*,p1,p2,p3,p4,p5,p6,+add', ids(r6));
		check('the source of a chat following the default is the default\'s',
			none.page.sourceOf(none.chats[0]) === CR);
	}

	console.log('S2 a pick stores per chat and per Diamond; the default is unchanged');
	{
		const d = await device({
			chats: [chat('c1', OR, 'z-ai/glm-5.3'), chat('c2', OR, 'z-ai/glm-5.3'), chat('dc', '', '', { diamondId: 'dA' })],
			models: { dA: { provider: OR, model: 'anthropic/claude-opus-5', workerProvider: OR, workerModel: 'z-ai/glm-5.3',
				visionProvider: OR, visionModel: 'z-ai/glm-5.3', at: 1 }, dB: { provider: OR, model: 'z-ai/glm-5.3', at: 1 } },
		});
		const def0 = JSON.stringify(d.M.getDefault());
		const out = d.page.switchChatSource(d.chats[0], FW);
		check('an ordinary chat moves to the new source', d.chats[0].provider === FW && d.chats[0].model === 'z-ai/glm-5.3',
			d.chats[0].provider + '/' + d.chats[0].model);
		check('it says what moved', out && out.before.provider === OR && out.after.provider === FW);
		check('the chat was saved', d.env.persisted > 0);
		check('another chat is unchanged', d.chats[1].provider === OR);
		check('the global default is unchanged', JSON.stringify(d.M.getDefault()) === def0);
		check('the chat now reads its new source', d.page.sourceOf(d.chats[0]) === FW);

		const r0 = JSON.stringify(d.recs().dB);
		d.page.switchChatSource(d.chats[2], AN);
		const a = d.recs().dA;
		check('a Diamond\'s chat stores to the Diamond\'s model set', a.provider === AN && a.model === 'claude-opus-5',
			a.provider + '/' + a.model);
		check('the Diamond chat\'s own record holds no model', !d.chats[2].provider && !d.chats[2].model);
		check('its workers half on the old source moves too', a.workerProvider === AN, a.workerProvider + '/' + a.workerModel);
		check('its images half on the old source moves, or clears when no same model is there',
			(a.visionProvider === AN) || (!a.visionProvider && !a.visionModel), a.visionProvider + '/' + a.visionModel);
		check('another Diamond is unchanged', JSON.stringify(d.recs().dB) === r0);
		check('the global default is still unchanged', JSON.stringify(d.M.getDefault()) === def0);
		check('the menu inside the Diamond checks the Diamond\'s source',
			ids(d.page.sourceMenuRows(d.chats[2])).indexOf(AN + '*') >= 0);

		const w = await device({ chats: [chat('c1', OR, 'z-ai/glm-5.3', { workerProvider: OR, workerModel: 'anthropic/claude-opus-5' }),
			chat('c2', OR, 'z-ai/glm-5.3', { workerProvider: AN, workerModel: 'claude-haiku-5' })] });
		w.page.switchChatSource(w.chats[0], AN);
		check('a chat\'s workers half on the old source moves with it',
			w.chats[0].workerProvider === AN && w.chats[0].workerModel === 'claude-opus-5',
			w.chats[0].workerProvider + '/' + w.chats[0].workerModel);
		w.page.switchChatSource(w.chats[1], FW);
		check('a workers half set on another source stays where it was set',
			w.chats[1].workerProvider === AN && w.chats[1].workerModel === 'claude-haiku-5');
	}

	console.log('S2b a source picked on the switch stays when the default later moves (D-20261024-19, QA-B F1)');
	{
		// The default is on credits. The chat is on his Anthropic key; he switches it to Credits.
		const d = await device({ defProvider: CR, defModel: 'claude-opus-5',
			chats: [chat('c1', AN, 'claude-opus-5'), chat('dc', '', '', { diamondId: 'dA' })],
			models: { dA: { provider: AN, model: 'claude-opus-5', at: 1 } } });
		const out = d.page.switchChatSource(d.chats[0], CR);
		check('the switch moved the chat to credits', out && d.page.sourceOf(d.chats[0]) === CR, d.page.sourceOf(d.chats[0]));
		check('the pair equal to the default is stored as picked, not as "follow"',
			d.chats[0].provider === CR && d.chats[0].model === 'claude-opus-5', d.chats[0].provider + '/' + d.chats[0].model);
		d.page.switchChatSource(d.chats[1], CR);
		// Later he moves the global default to his own key (Models -> Make default).
		d.M.setDefault(AN, 'claude-opus-5');
		check('an ordinary chat he switched to Credits still pays with Credits after the default moves',
			d.page.sourceOf(d.chats[0]) === CR, 'now ' + d.page.sourceOf(d.chats[0]));
		check('a Diamond he switched to Credits still pays with Credits after the default moves',
			d.page.sourceOf(d.chats[1]) === CR, 'now ' + d.page.sourceOf(d.chats[1]));

		// The same through a default that passes over the pick (chat and Diamond on his key).
		const e = await device({ defProvider: CR, defModel: 'claude-opus-5',
			chats: [chat('c1', CR, 'claude-opus-5'), chat('dc', '', '', { diamondId: 'dB' })],
			models: { dB: { provider: CR, model: 'claude-opus-5', at: 1 } } });
		e.page.switchChatSource(e.chats[0], AN);
		e.page.switchChatSource(e.chats[1], AN);
		check('both now pay with his Anthropic key', e.page.sourceOf(e.chats[0]) === AN && e.page.sourceOf(e.chats[1]) === AN);
		e.M.setDefault(AN, 'claude-opus-5');
		e.M.setDefault(CR, 'claude-opus-5');
		check('the chat he put on his key is still on his key', e.page.sourceOf(e.chats[0]) === AN, 'now ' + e.page.sourceOf(e.chats[0]));
		check('the Diamond he put on his key is still on his key', e.page.sourceOf(e.chats[1]) === AN, 'now ' + e.page.sourceOf(e.chats[1]));
	}

	console.log('S3 the three mapping steps');
	{
		const d = await device({});
		const m = (to, model) => { const r = d.M.modelOnSource(to, model); return r ? r.model + ' <' + r.step + '>' : 'null'; };
		check('1. the same model when the source lists it', m(FW, 'z-ai/glm-5.3') === 'z-ai/glm-5.3 <same>', m(FW, 'z-ai/glm-5.3'));
		check('2. the canonical name, vendor prefix stripped (anthropic/claude-opus-5 ↔ claude-opus-5)',
			m(AN, 'anthropic/claude-opus-5') === 'claude-opus-5 <name>', m(AN, 'anthropic/claude-opus-5'));
		check('2. and back the other way', m(OR, 'claude-opus-5') === 'anthropic/claude-opus-5 <name>', m(OR, 'claude-opus-5'));
		check('3a. the default\'s model when the default is on that source', m(OR, 'claude-haiku-5') === 'or/default <default>',
			m(OR, 'claude-haiku-5'));
		check('3b. else the source\'s first model', m(FW, 'claude-haiku-5') === 'accounts/fireworks/models/kimi-k3 <first>',
			m(FW, 'claude-haiku-5'));
		check('a source with no model listed maps to nothing', d.M.modelOnSource('nokey', 'x') === null);
	}

	console.log('S4 the Effort is re-clamped to the new model\'s levels');
	{
		const d = await device({ chats: [chat('c1', OR, 'anthropic/claude-opus-5', { effort: 'xhigh' }),
			chat('c2', OR, 'z-ai/glm-5.3', { effort: 'medium' }), chat('c3', OR, 'z-ai/glm-5.3', { effort: 'max' })] });
		const c = (e, p, m) => d.M.effortClamp(e, p, m).effort;
		check('a level the new model offers is kept', c('medium', FW, 'z-ai/glm-5.3') === 'medium');
		check('a level above the new model\'s top comes down to its top', c('xhigh', AN, 'claude-opus-5') === 'high',
			c('xhigh', AN, 'claude-opus-5'));
		check('a level between two rungs comes down to the one below', c('medium', FW, 'accounts/fireworks/models/kimi-k3') === 'low',
			c('medium', FW, 'accounts/fireworks/models/kimi-k3'));
		check('a model with no levels clears it', c('high', AN, 'claude-haiku-5') === '');
		check('no Effort stays none', c('', FW, 'z-ai/glm-5.3') === '');
		d.page.switchChatSource(d.chats[0], AN);
		check('the switch writes the clamped level on the chat', d.chats[0].effort === 'high', d.chats[0].effort);
		d.page.switchChatSource(d.chats[2], FW);
		check('max on a model topping out at high is high', d.chats[2].effort === 'high', d.chats[2].effort);
		const dm = await device({ chats: [chat('dc', '', '', { diamondId: 'dA' })],
			models: { dA: { provider: OR, model: 'anthropic/claude-opus-5', effort: 'xhigh', effortProvider: OR,
				effortModel: 'anthropic/claude-opus-5', at: 1 } } });
		dm.page.switchChatSource(dm.chats[0], AN);
		const r = dm.recs().dA;
		check('a Diamond\'s Effort is clamped and paired with the new model',
			r.effort === 'high' && r.effortProvider === AN && r.effortModel === 'claude-opus-5',
			r.effort + ' ' + r.effortProvider + '/' + r.effortModel);
	}

	strings();
	await eye();
}

async function eye() {
	console.log('S6 the eye');
	{
		const d = await device({ chats: [chat('c1', OR, 'anthropic/claude-opus-5')] });
		const P = d.page;
		check('the pair names the sources when the model keeps its name',
			typeof P.sourceMovedPair === 'function' && (() => {
				const x = P.sourceMovedPair({ before: { provider: OR, model: 'anthropic/claude-opus-5' },
					after: { provider: AN, model: 'claude-opus-5' } });
				return x.from === 'OpenRouter' && x.to === 'Anthropic';
			})());
		check('the pair names the models when they differ',
			typeof P.sourceMovedPair === 'function' && (() => {
				const x = P.sourceMovedPair({ before: { provider: OR, model: 'or/default' },
					after: { provider: AN, model: 'claude-opus-5' } });
				return x.from !== x.to && x.from !== 'OpenRouter';
			})());
		check('credits are named as the switch names them',
			typeof P.sourceLabel === 'function' && P.sourceLabel(CR) === 'astat.credits');
	}
	{
		// The outside-click listener runs in the capture phase, ahead of the button's own click:
		// unless it leaves the switch alone, it shuts the menu and the button opens it again.
		const src = source('daimond.js');
		const m = src.match(/function onSourceMenuOutside\(e\) \{([\s\S]*?)\n\t\}|function onSourceMenuOutside\(e\) \{([^\n]*)\}/);
		check('the outside click leaves the switch to toggle its own menu',
			!!m && /source-btn|_sourceAnchor/.test(m[1] || m[2]), m ? (m[1] || m[2]).trim() : 'no handler');
	}
	{
		// A row's shrink weights that sum below one give away only that fraction of the overflow
		// (CSS Flexbox §9.7), so with no runner on screen a weight of 0.01 left the source whole
		// and pushed the Effort's + out of a narrow panel (1280x720, 27px). Every part of the row
		// that gives way takes a weight of at least one; the order is kept by the ratio.
		const css = readPage(join(HERE, '..', 'css', 'app.css'), 'utf8');
		const w = (sel) => { const m = css.match(new RegExp('\\n' + sel.replace('.', '\\.') + ' \\{ flex: 0 ([0-9.]+) auto;')); return m ? +m[1] : NaN; };
		const src = w('.source-switch'), seat = w('.seat-switch');
		check('the source gives way on its own, with no runner beside it', src >= 1, 'source ' + src);
		check('the runner\'s name still gives way first', seat > src, 'seat ' + seat + ', source ' + src);
	}
}

function strings() {
	console.log('S5 the strings');
	{
		const dir = join(HERE, '..', 'i18n');
		const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
		check('eight locales', files.length === 8, files.join(' '));
		const KEYS = ['composer.source', 'composer.source_help', 'composer.source_add', 'composer.source_this_chat',
			'composer.source_this_diamond'];
		for (const f of files) {
			const s = readPage(join(dir, f), 'utf8');
			check(f + ': chat.model_for_chat is gone', s.indexOf("'chat.model_for_chat'") < 0);
			const gone = KEYS.filter((k) => !new RegExp("\\n\\t'" + k.replace('.', '\\.') + "':").test(s));
			check(f + ': the five source keys are there', !gone.length, gone.join(', '));
		}
		const js = readdirSync(HERE).filter((f) => f.endsWith('.js'))
			.some((f) => readPage(join(HERE, f), 'utf8').indexOf('chat.model_for_chat') >= 0);
		check('no script reads the dead key', !js);
	}
}

main().then(() => {
	console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
	process.exit(failures ? 1 : 0);
}, (e) => { console.error(e); process.exit(1); });
