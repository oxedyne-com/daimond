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

console.log('\nQA6: a later Workers pick on a slow-clock new device survives an old peer\'s echo');
{
	const ID = 'dia-s';
	const N1 = ddev(APP, STAMP), N2 = ddev(APP, STAMP), O = ddev(OLD, OSTAMP);
	const S = { provider: 'openrouter', model: 'z-ai/glm-5.3', workerProvider: 'openrouter', workerModel: 'z-ai/glm-5.3-flash',
		visionProvider: '', visionModel: '', effort: '', effortProvider: '', effortModel: '', at: 1000, eat: 0 };
	N1.put(ID, S); N2.put(ID, S); O.put(ID, S);
	N1.clock.t = O.clock.t = 6000; N2.clock.t = 5000;	// N2 runs one second slow
	N1.setDiamondModel(ID, { visionProvider: 'openrouter', visionModel: 'google/gemini-new' });	// Images pick on N1
	O.adoptDiamondModel(ID, N1.rec(ID), false);		// the old peer takes it (at 6000)
	N2.adoptDiamondModel(ID, N1.rec(ID), false);	// N2 takes it too
	N2.setDiamondModel(ID, { workerProvider: 'openrouter', workerModel: 'qwen/qwen3-coder' });	// later, on N2
	N2.adoptDiamondModel(ID, O.rec(ID), false);		// the old peer's unchanged record arrives
	check('QA6 N2\'s later Workers pick survives the old peer\'s echo', N2.rec(ID).workerModel === 'qwen/qwen3-coder', N2.rec(ID));
	O.adoptDiamondModel(ID, N2.rec(ID), false);
	check('QA6 and the old peer takes it', O.rec(ID).workerModel === 'qwen/qwen3-coder', O.rec(ID));
}
console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
