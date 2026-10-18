import { source, lift } from './testlift.mjs';

const APP   = source('daimond.js');
const STAMP = source('stamp.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const MERGE_FNS = ['withRecent', 'chatOwnsModel', 'slimChat', 'chatFields', 'takeChatMeta', 'chatTurnBeats',
	'chatMetaBeats', 'chatMetaFields', 'chatModelBeats', 'takeChatModel', 'chatMatOf', 'chatMatSplit',
	'mergeFold', 'mergeChatRecords', 'touchChatMeta', 'touchChatModel'];
const CREATE_FNS = ['storedPick', 'chatPairInForce', 'newChat', 'startChat', 'createDiamond'];
const VARS = ['CHAT_TURN_FIELDS', 'CHAT_META_FIELDS', 'CHAT_NAME_FIELDS', 'CHAT_MODEL_FIELDS', '_chatModelShedSaid'];
const NAMES = MERGE_FNS.concat(CREATE_FNS);

const DEF = { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' };
const GLM = { provider: 'openrouter', model: 'z-ai/glm-5.3' };
const FW  = { provider: 'fireworks', model: 'deepseek/deepseek-v4.1-flash' };	// same id, another key

/// One device: the lifted code over its own clock, chat list and model store. Names the
/// revision lacks come back null and are listed in `missing`.
function device(src, name, skew) {
	const L = lift(src, NAMES, VARS);
	const clock = { t: Date.UTC(2026, 9, 18, 9, 0, 0) };
	const RealDate = Date;
	class FakeDate extends RealDate {}
	FakeDate.now = function () { return clock.t + (skew || 0); };
	const providers = { openrouter: 1, fireworks: 1 };
	const window = {
		DaimondModels: {
			getDefault: function () { return { provider: DEF.provider, model: DEF.model }; },
			// The real rule (models.js `resolve`): '' is the default's provider, and its model too
			// when no provider is named.
			resolve: function (p, m) {
				const id = p || DEF.provider;
				const mm = m || (p ? '' : DEF.model);
				if (!providers[id] || !mm) return null;
				return { provider: id, model: mm, baseUrl: 'u', apiKey: 'k' };
			},
			effortAfterSwitch: function (e) { return { effort: e || '', cleared: false }; },
			pick: function (x) { return x; },
		},
	};
	const made = [];
	const env = {
		window: window, Date: FakeDate,
		diag: function () {}, tel: function () {}, persistChats: function () {}, selectChat: function () {},
		renderSessionList: function () {}, isMobile: function () { return false; }, mshow: function () {},
		renderPendingCentre: function () {}, openSettings: function () {}, t: function (k) { return k; },
		slimMessages: function (m) { return m || []; },
		mergeMessages: function (l, r) {
			const seen = new Set(), out = [];
			(l || []).concat(r || []).forEach(function (m) { if (!seen.has(m.mid)) { seen.add(m.mid); out.push(m); } });
			return out;
		},
		newChatId: (function () { let n = 0; return function () { return name + '-chat-' + (++n); }; })(),
		chatInput: { focus: function () {} },
		// createDiamond's surroundings: the dialog answers with `dialogVals`, after its own validate.
		dialogVals: { v: null, said: null },
		setDiamondModel: function (id, pick) { made.push({ id: id, pick: pick }); },
		diamondApp: function () { return { create_diamond: async function () { return 'dia-' + (made.length + 1); } }; },
	};
	const body = STAMP + '\n' + L.body + `
		var DaimondStamp = window.DaimondStamp, DaimondModels = window.DaimondModels;
		var chats = [], current = null, cfg = { model: '' }, diamonds = [];
		async function dialog(o) { dialogVals.said = o.validate ? o.validate(dialogVals.v) : ''; return dialogVals.said ? null : dialogVals.v; }
		function takeDiamondLabel() {} function peekDiamondLabel() { return 'diamond-0001'; }
		function bumpDiamonds() {} function clearDiamondFilters() {} async function loadDiamonds() {}
		function selectDiamond() {} function noticeDialog() {}
		function fn(n) { try { return eval(n); } catch (e) { return null; } }
		var api = { chats: function () { return chats; } };
		${JSON.stringify(NAMES)}.forEach(function (n) { api[n] = fn(n); });
		return api;`;
	const keys = Object.keys(env);
	const api = new Function(...keys, body)(...keys.map((k) => env[k]));
	api.missing = L.missing; api.clock = clock; api.made = made; api.env = env; api.name = name;
	return api;
}

/// Run `f`, turning a ReferenceError for a function the revision lacks into a named failure.
function guarded(name, d, f) {
	try { return f(); }
	catch (e) { check(name, false, 'threw: ' + e.message + (d.missing.length ? '; revision lacks ' + d.missing.join(', ') : '')); return undefined; }
}

const pair = (c) => ({ model: c.model || '', provider: c.provider || '', workerModel: c.workerModel || '', workerProvider: c.workerProvider || '' });

// ════ QA-A (review half A): mixed-build round trips, new → 14ef947b → new ════
const OLD = source('daimond.js', '14ef947b');
const OSTAMP = source('stamp.js', '14ef947b');

// ── Diamond record device, lifted from a given source (as mmrecord.test.mjs) ──
function ddev(src, stampSrc) {
	const L = lift(src, ['readJson', 'diamondModels', 'setDiamondModel', 'blankDiamondModel', 'mergeDiamondModel',
		'adoptDiamondModel'], ['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF']);
	const store = new Map();
	const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
	const clock = { t: 1000 };
	const DateStub = { now: () => clock.t };
	const win = {};
	new Function('window', 'Date', stampSrc)(win, DateStub);
	const api = new Function('localStorage', 'Date', 'DaimondStamp', 'Notes', L.body +
		'\nreturn { diamondModels: diamondModels, setDiamondModel: setDiamondModel, adoptDiamondModel: adoptDiamondModel };'
	)(localStorage, DateStub, win.DaimondStamp, undefined);
	api.clock = clock;
	api.rec = (id) => JSON.parse(JSON.stringify(api.diamondModels()[id]));
	api.put = (id, r) => { const all = api.diamondModels(); all[id] = JSON.parse(JSON.stringify(r)); localStorage.setItem('daimond-diamond-models', JSON.stringify(all)); };
	return api;
}

console.log('\nQA1: a Workers pick on a new build survives an old peer\'s later daimon change');
{
	const ID = 'dia-x';
	const N = ddev(APP, STAMP), O = ddev(OLD, OSTAMP);
	const S = { provider: 'openrouter', model: 'z-ai/glm-5.3', workerProvider: 'openrouter', workerModel: 'z-ai/glm-5.3-flash',
		visionProvider: '', visionModel: '', effort: '', effortProvider: '', effortModel: '', at: 5000, eat: 0 };
	N.put(ID, S); O.put(ID, S);
	N.clock.t = O.clock.t = 6000;
	// New device: a Workers pick (moves `wat` only).
	N.setDiamondModel(ID, { workerProvider: 'openrouter', workerModel: 'qwen/qwen3-coder' });
	O.adoptDiamondModel(ID, N.rec(ID), false);
	check('QA1 the old peer sees the Workers pick', O.rec(ID).workerModel === 'qwen/qwen3-coder', O.rec(ID));
	// Old device, later: a daimon change (moves its `at`, carries the Workers pair it holds).
	O.clock.t = 7000;
	O.setDiamondModel(ID, { provider: 'openrouter', model: 'anthropic/claude-x' });
	N.adoptDiamondModel(ID, O.rec(ID), false);
	check('QA1 on the new device the daimon change lands', N.rec(ID).model === 'anthropic/claude-x', N.rec(ID));
	check('QA1 on the new device the Workers pick survives', N.rec(ID).workerModel === 'qwen/qwen3-coder', N.rec(ID));
}

console.log('\nQA2: a Workers clear on a new build survives an old peer\'s later daimon change');
{
	const ID = 'dia-y';
	const N = ddev(APP, STAMP), O = ddev(OLD, OSTAMP);
	const S = { provider: 'openrouter', model: 'z-ai/glm-5.3', workerProvider: 'openrouter', workerModel: 'z-ai/glm-5.3-flash',
		visionProvider: '', visionModel: '', effort: '', effortProvider: '', effortModel: '', at: 5000, eat: 0 };
	N.put(ID, S); O.put(ID, S);
	N.clock.t = O.clock.t = 6000;
	N.setDiamondModel(ID, { workerProvider: '', workerModel: '' });
	O.adoptDiamondModel(ID, N.rec(ID), false);
	O.clock.t = 7000;
	O.setDiamondModel(ID, { provider: 'openrouter', model: 'anthropic/claude-x' });
	N.adoptDiamondModel(ID, O.rec(ID), false);
	check('QA2 the Workers clear is not undone', !N.rec(ID).workerModel, N.rec(ID));
}

console.log('\nQA3: a chat model edit on a new build survives an old peer\'s later rename');
{
	const N = device(APP, 'N', 0), Od = device(OLD, 'O', 0);
	const S = { id: 'chat-z', name: 'Before', messages: [{ mid: 'm1', role: 'user', content: 'hi' }],
		model: GLM.model, provider: GLM.provider, workerModel: '', workerProvider: '', status: 'active',
		updatedAt: N.clock.t - 60000, metaAt: N.clock.t - 60000 };
	for (const [label, to] of [['to the default (clear)', { model: '', provider: '' }], ['to Fireworks', { model: FW.model, provider: FW.provider }]]) {
		const onN = JSON.parse(JSON.stringify(S));
		let onO = JSON.parse(JSON.stringify(S));
		N.clock.t += 1000;
		onN.model = to.model; onN.provider = to.provider;
		(N.touchChatModel || N.touchChatMeta)(onN);
		onO = Od.mergeChatRecords(N.slimChat(onN), Od.slimChat(onO));	// the old peer receives it
		check('QA3 ' + label + ': the old peer adopts the model edit', (onO.model || '') === to.model, pair(onO));
		Od.clock.t = N.clock.t + 1000;
		onO.name = 'After';
		Od.touchChatMeta(onO);
		const back = N.mergeChatRecords(Od.slimChat(onO), N.slimChat(onN));
		check('QA3 ' + label + ': the rename lands', back.name === 'After', back.name);
		check('QA3 ' + label + ': the model edit survives on the new device', (back.model || '') === to.model, pair(back));
	}
}

console.log('\nQA5: an Images pick on a new build replaces an old peer\'s stale Images pair and survives its later daimon change');
{
	const ID = 'dia-v';
	const N = ddev(APP, STAMP), O = ddev(OLD, OSTAMP);
	const S = { provider: 'openrouter', model: 'z-ai/glm-5.3', workerProvider: '', workerModel: '',
		visionProvider: 'openrouter', visionModel: 'google/gemini-old', effort: '', effortProvider: '', effortModel: '', at: 5000, eat: 0 };
	N.put(ID, S); O.put(ID, S);
	N.clock.t = O.clock.t = 6000;
	N.setDiamondModel(ID, { visionProvider: 'openrouter', visionModel: 'google/gemini-new' });
	O.adoptDiamondModel(ID, N.rec(ID), false);
	check('QA5 the old peer sees the Images pick', O.rec(ID).visionModel === 'google/gemini-new', O.rec(ID));
	O.clock.t = 7000;
	O.setDiamondModel(ID, { provider: 'openrouter', model: 'anthropic/claude-x' });
	N.adoptDiamondModel(ID, O.rec(ID), false);
	check('QA5 on the new device the daimon change lands', N.rec(ID).model === 'anthropic/claude-x', N.rec(ID));
	check('QA5 on the new device the Images pick survives', N.rec(ID).visionModel === 'google/gemini-new', N.rec(ID));
}

console.log('\nQA4: a Workers pick on a default-following Diamond reaches an old peer');
{
	const ID = 'dia-w';
	const N = ddev(APP, STAMP), O = ddev(OLD, OSTAMP);
	N.clock.t = O.clock.t = 6000;
	N.setDiamondModel(ID, { workerProvider: 'openrouter', workerModel: 'qwen/qwen3-coder' });
	O.adoptDiamondModel(ID, N.rec(ID), false);
	const o = O.diamondModels()[ID];
	check('QA4 the old peer holds the Workers pick', !!o && o.workerModel === 'qwen/qwen3-coder', o || null);
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
