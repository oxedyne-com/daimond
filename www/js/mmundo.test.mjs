/* ============================================================
   Test -- D-20261018-09 U2b: Undo is compare-and-set, and a
   device that cannot run the default says so.
   ------------------------------------------------------------
   `DaimondModels.undoEveryone(rec)` puts back each field of an
   *Everyone uses* record, and the default, only where it still
   holds what `setEveryone` wrote. `everyoneStanding()` says
   whether this device can run the default, and on what it runs.

     H1  Undo with no interference: the exact prior map, both
         devices, after sync;
     H2  B changes Email after the change set arrived: A's Undo
         leaves Email, names it in `kept`, B adopts the rest;
     H3  B moved the default since: Undo leaves the default;
     H4  the default on Fireworks, a device with no Fireworks key:
         `here` false, `using`, `missing` 'Fireworks AI'.

   Two devices, each in its own vm realm with its own storage:
   the REAL models.js, stamp.js and store.js, and the REAL
   daimond.js record, chat and pick functions (testlift.mjs).
   They sync as the app does: the models parcel (`exportSync` /
   `applySync`), each Diamond record (`adoptDiamondModel`) and
   each chat (`mergeChatRecords`). Red proof:

     MM_SRC_REV=14ef947b node www/js/mmundo.test.mjs
   ============================================================ */
import vm from 'node:vm';
import { source, lift } from './testlift.mjs';
import { loadStore } from './storefixture.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

// ── His shape, as U1f's migration leaves it (mmeveryone.test.mjs) ───────────
const OR = 'openrouter', FW = 'fireworks';
const DS    = 'deepseek/deepseek-v4.1-flash';
const GLM   = 'z-ai/glm-5.3', GLMF = 'z-ai/glm-5.3-flash', GEM = 'google/gemini-2.5-flash-lite';
const FWDS  = 'accounts/fireworks/models/deepseek-v4p1-flash';
const FWGLM = 'accounts/fireworks/models/glm-5p3-flash';
const X     = { provider: OR, model: GLMF };	// the pick
const S = Date.UTC(2026, 9, 1);
const rec = (p, m, wp, wm, vp, vm, eff) => ({ provider: p || '', model: m || '', workerProvider: wp || '', workerModel: wm || '',
	visionProvider: vp || '', visionModel: vm || '', effort: eff || '', effortProvider: eff ? OR : '',
	effortModel: eff ? DS : '', at: S, eat: eff ? S : 0 });
const NAMES = { 'd-daimond': 'Daimond', 'd-reit': 'Reit Hoogland', 'd-email': 'Email', 'd-oxegen': 'Oxegen',
	'd-hematite': 'Hematite', 'd-ontheism': 'Ontheism', 'd-kernel': 'Kernel notes' };
function migrated() {
	return {
		'd-daimond':  rec(OR, GLM, OR, GLMF, OR, GEM),
		'd-reit':     rec(),
		'd-email':    rec(FW, FWDS),
		'd-oxegen':   rec('', '', '', '', '', '', 'high'),
		'd-hematite': rec(),
		'd-ontheism': rec(),
		'd-kernel':   rec(OR, GLMF),
	};
}
const chat = (id, name, p, m) => ({ id, name, provider: p || '', model: m || '', workerProvider: '', workerModel: '',
	updatedAt: S, metaAt: S, mat: S, messages: [] });
function hisShape() {
	return {
		models: migrated(),
		chats: [chat('c1', 'one'), chat('c2', 'two'), chat('c3', 'three', OR, GLM)],
		draft: { provider: OR, model: GLM },
		jobs: { workers: { provider: FW, model: FWDS }, images: { provider: OR, model: GEM } },
	};
}

// ── One device, in its own realm ────────────────────────────────────────────
const PAGE = ['readJson', 'diamondModels', 'setDiamondModel', 'blankDiamondModel', 'mergeDiamondModel',
	'adoptDiamondModel', 'modelPicksOf', 'diamondPicks', 'chatPicks', 'summarisingPick', 'setFoldPick',
	'chatDisplayName', 'everyoneTargets', 'clearPick', 'setPick', 'settlePicks',
	'withRecent', 'chatOwnsModel', 'slimChat', 'chatFields', 'takeChatMeta', 'chatTurnBeats', 'chatMetaBeats',
	'chatMetaFields', 'chatModelBeats', 'takeChatModel', 'chatMatOf', 'chatMatSplit', 'mergeFold',
	'mergeChatRecords', 'touchChatMeta', 'touchChatModel'];
const PAGE_VARS = ['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF', '_picksDirty',
	'CHAT_TURN_FIELDS', 'CHAT_META_FIELDS', 'CHAT_NAME_FIELDS', 'CHAT_MODEL_FIELDS', '_chatModelShedSaid'];
const MKEY = 'daimond-diamond-models', CKEY = 'daimond-byok';
const copy = (o) => JSON.parse(JSON.stringify(o));

async function device(o) {
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
	vm.runInContext(source('stamp.js'), ctx);
	vm.runInContext(source('models.js'), ctx);
	const M = ctx.DaimondModels;
	M.init({ onChange: () => {} });
	M.addProvider(OR, { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey(OR, 'or-key');
	if (o.fireworks !== false) {
		M.addProvider(FW, { url: 'https://api.fireworks.ai/inference/v1', name: 'Fireworks AI' });
		await M.setKey(FW, 'fw-key');
	}
	M.setDefault(OR, DS);
	if (o.draft && M.setDraft) M.setDraft(o.draft.provider, o.draft.model);
	for (const role of Object.keys(o.jobs || {})) if (M.setJob) M.setJob(role, o.jobs[role].provider, o.jobs[role].model);
	localStorage.setItem(MKEY, JSON.stringify(o.models || {}));
	const cfg = { foldProvider: '', foldModel: '' };
	localStorage.setItem(CKEY, JSON.stringify(cfg));
	const chats = copy(o.chats || []);
	const diamonds = Object.keys(o.models || {}).map((id) => ({ id, name: NAMES[id] || id }));
	const L = lift(source('daimond.js'), PAGE, PAGE_VARS);
	const env = {
		DaimondModels: M, Notes: undefined, cfg, CFG_KEY: CKEY, chats, diamonds, _diamondApps: {},
		_diamondAppProvider: new Map(), applyFoldSettings: () => {}, persisted: 0,
		persistChats: () => { env.persisted++; localStorage.setItem('chats', JSON.stringify(chats)); },
		tOr: (k, d) => d, chatOpening: () => '', diag: () => {},
		// The transcript is not under test: no turns, so the union is the empty list.
		slimMessages: (m) => m || [], mergeMessages: (l, r) => (l || []).concat(r || []),
	};
	Object.assign(ctx, env);
	const api = vm.runInContext(L.body + `
		;(function () {
			function fn(n) { try { return eval(n); } catch (e) { return null; } }
			var api = {};
			${JSON.stringify(PAGE)}.forEach(function (n) { api[n] = fn(n); });
			return api;
		})()`, ctx);
	if (M.bindPicks) M.bindPicks({ diamond: api.diamondPicks, chat: api.chatPicks, summarising: api.summarisingPick,
		list: api.everyoneTargets, clear: api.clearPick, set: api.setPick, settle: api.settlePicks });
	return { M, page: api, ls, cfg, chats, missing: L.missing,
		recs: () => JSON.parse(localStorage.getItem(MKEY) || '{}') };
}

/// One pull: `to` merges what `from` holds, as the app's sync does.
async function pull(to, from) {
	await to.M.applySync(JSON.parse(JSON.stringify(from.M.exportSync())));
	const theirs = from.recs();
	for (const id of Object.keys(theirs)) to.page.adoptDiamondModel(id, copy(theirs[id]), false);
	from.chats.forEach((c) => {
		const i = to.chats.findIndex((x) => x.id === c.id);
		if (i >= 0) to.chats[i] = to.page.mergeChatRecords(copy(c), to.chats[i]);
	});
}
async function both(a, b) { await pull(b, a); await pull(a, b); }

// Every synced pick, as one string per field: the map Undo must put back.
function map(d) {
	const r = d.recs(), out = {};
	for (const id of Object.keys(r).sort()) {
		out[id] = [r[id].provider, r[id].model, r[id].workerProvider, r[id].workerModel,
			r[id].visionProvider, r[id].visionModel].join('|');
	}
	d.chats.forEach((c) => { out[c.id] = [c.provider, c.model, c.workerProvider, c.workerModel].join('|'); });
	const def = d.M.getDefault();
	out.def = def.provider + '|' + def.model;
	['drafting', 'workers', 'images'].forEach((role) => { const j = d.M.getJob(role); out[role] = j.provider + '|' + j.model; });
	return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function diff(a, b) { return Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => k + ': ' + a[k] + ' → ' + b[k]); }

function has(d, names) {
	const gone = names.filter((n) => typeof d.M[n] !== 'function');
	if (gone.length) check('DaimondModels has ' + names.join(', '), false, 'missing: ' + gone.join(', ')
		+ (d.missing.length ? '; daimond.js lacks ' + d.missing.join(', ') : ''));
	return gone.length === 0;
}

async function pair() {
	const a = await device(hisShape()), b = await device(hisShape());
	await both(a, b);
	return { a, b };
}

async function main() {
	const APP = source('daimond.js');
	const binds = /DaimondModels\.bindPicks\(\{[^}]*\}\)/.exec(APP);
	check('daimond.js binds set, the writer Undo restores through', !!binds && /\bset:/.test(binds[0]), binds && binds[0]);

	// ── H1 no interference ───────────────────────────────────────────
	console.log('\nH1: Undo with nobody else writing puts back the exact prior map, on both devices');
	{
		const { a, b } = await pair();
		if (has(a, ['setEveryone', 'undoEveryone'])) {
			const before = map(a), fold0 = { provider: OR, model: GLM };
			a.page.setFoldPick(fold0.provider, fold0.model);
			check('H1 the two devices start the same', same(before, map(b)), diff(before, map(b)));
			const u = a.M.setEveryone(X, true);
			await both(a, b);
			check('H1 the change set arrived on B', map(b).def === OR + '|' + GLMF && map(b)['d-daimond'] === '||||' + OR + '|' + GEM, map(b));
			const r = a.M.undoEveryone(u);
			check('H1 nothing is kept', r && Array.isArray(r.kept) && r.kept.length === 0, r);
			check('H1 every field and the default restored', r && r.restored === u.fields.length + 1, [r, u.fields.length]);
			check('H1 A holds the prior map', same(map(a), before), diff(before, map(a)));
			check('H1 A\'s Summarising is back', a.cfg.foldModel === GLM && a.cfg.foldProvider === OR, a.cfg);
			await both(a, b);
			check('H1 B holds the prior map after sync', same(map(b), before), diff(before, map(b)));
			check('H1 A still holds it after B\'s parcel', same(map(a), before), diff(before, map(a)));
		}
	}

	// ── H2 B changed Email since ─────────────────────────────────────
	console.log('\nH2: B changes Email after the change set arrived; A\'s Undo leaves Email and names it');
	{
		const { a, b } = await pair();
		if (has(a, ['setEveryone', 'undoEveryone'])) {
			const before = map(a);
			const u = a.M.setEveryone(X, true);
			await both(a, b);
			b.page.setDiamondModel('d-email', { provider: FW, model: FWGLM });
			await both(a, b);
			check('H2 A sees B\'s Email', map(a)['d-email'] === FW + '|' + FWGLM + '||||', map(a)['d-email']);
			const r = a.M.undoEveryone(u);
			const kept = (r && r.kept) || [];
			check('H2 kept is exactly Email\'s daimon', kept.length === 1 && kept[0].name === 'Email'
				&& kept[0].kind === 'diamond' && kept[0].role === 'daimon', kept);
			await both(a, b);
			const want = Object.assign({}, before, { 'd-email': FW + '|' + FWGLM + '||||' });
			check('H2 A: Email keeps B\'s model, the rest is back', same(map(a), want), diff(want, map(a)));
			check('H2 B adopts the rest', same(map(b), want), diff(want, map(b)));
		}
	}

	// ── H3 B moved the default since ─────────────────────────────────
	console.log('\nH3: B moved the default since; Undo leaves the default and restores the rest');
	{
		const { a, b } = await pair();
		if (has(a, ['setEveryone', 'undoEveryone'])) {
			const before = map(a);
			const u = a.M.setEveryone(X, true);
			await both(a, b);
			b.M.setDefault(OR, GLM);
			await both(a, b);
			const r = a.M.undoEveryone(u);
			const kept = (r && r.kept) || [];
			check('H3 kept is the default alone', kept.length === 1 && kept[0].kind === 'default', kept);
			await both(a, b);
			const want = Object.assign({}, before, { def: OR + '|' + GLM });
			check('H3 A: the default stays B\'s, the picks are back', same(map(a), want), diff(want, map(a)));
			check('H3 B likewise', same(map(b), want), diff(want, map(b)));
		}
	}

	// ── H4 no key for the default here ───────────────────────────────
	console.log('\nH4: the default on Fireworks, on a device with no Fireworks key');
	{
		const a = await device({ models: {} }), b = await device({ models: {}, fireworks: false });
		await both(a, b);
		if (has(b, ['setEveryone', 'everyoneStanding'])) {
			a.M.setEveryone({ provider: FW, model: FWGLM }, true);
			await both(a, b);
			const s = b.M.everyoneStanding();
			check('H4 pick is the synced default', s && s.pick && s.pick.provider === FW && s.pick.model === FWGLM, s);
			check('H4 not here', s && s.here === false, s);
			check('H4 using the last default B could run', s && s.using && s.using.provider === OR && s.using.model === DS, s);
			check('H4 missing names Fireworks AI', s && s.missing === 'Fireworks AI', s);
			check('H4 B runs a follower on it, not on Fireworks', b.M.effective(null, 'daimon').model === DS, b.M.effective(null, 'daimon'));
			const t = a.M.everyoneStanding();
			check('H4 A, with the key, is here', t && t.here === true && t.missing === '' && t.using.model === FWGLM, t);
		}
	}

	console.log('\n' + (checks - failures) + '/' + checks + ' passed');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
