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
         `here` false, `using`, `missing` 'Fireworks AI';
     H5  Move Them Too onto a model that lacks a Diamond's Effort
         level, which drops at the next read: Undo brings the
         level back with the model, and leaves an Effort chosen
         since (red on 529df246);
     H6  B picks Y for a Diamond after the move, or moves the
         default under a follower: Undo writes no level onto Y
         (red on cd3359c36).

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
	'diamondEffort', 'diamondModel', 'setDiamondEffort',
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

	// ── H5 Undo brings back an Effort level dropped meanwhile ────────
	console.log('\nH5: Undo after Move Them Too brings back an Effort level the new model lacked');
	{
		const sh = hisShape();
		sh.models['d-pin'] = rec(OR, DS, '', '', '', '', 'high');	// pinned, with an Effort on that model
		const a = await device(sh), b = await device(sh);
		await both(a, b);
		if (has(a, ['setEveryone', 'undoEveryone'])) {
			const eff = (d, id) => d.page.diamondEffort(id);
			check('H5 both Diamonds start on high', eff(a, 'd-oxegen') === 'high' && eff(a, 'd-pin') === 'high');
			const u = a.M.setEveryone(X, true);
			// The next read, on the new model, which offers no such level: dropped quietly.
			check('H5 the new model drops the level', eff(a, 'd-oxegen') === '' && eff(a, 'd-pin') === '');
			const r = a.M.undoEveryone(u);
			check('H5 nothing is kept', r && r.kept.length === 0, r);
			check('H5 the pin is back', a.recs()['d-pin'].model === DS, a.recs()['d-pin']);
			check('H5 the follower\'s Effort is back with the default', eff(a, 'd-oxegen') === 'high', a.recs()['d-oxegen']);
			check('H5 the pinned Diamond\'s Effort is back with its model', eff(a, 'd-pin') === 'high', a.recs()['d-pin']);
			await both(a, b);
			check('H5 B holds both levels after sync', eff(b, 'd-oxegen') === 'high' && eff(b, 'd-pin') === 'high',
				[b.recs()['d-oxegen'], b.recs()['d-pin']]);
		}
		// An Effort chosen after the drop is a newer decision, and Undo leaves it.
		const c = await device(sh);
		if (has(c, ['setEveryone', 'undoEveryone'])) {
			const u = c.M.setEveryone(X, true);
			c.page.diamondEffort('d-oxegen');
			c.page.setDiamondEffort('d-oxegen', 'low');
			c.M.undoEveryone(u);
			check('H5 an Effort chosen since stays', c.recs()['d-oxegen'].effort === 'low', c.recs()['d-oxegen']);
		}
	}

	// ── H6 a level goes back only with its model ─────────────────────
	console.log('\nH6: Undo leaves the Effort off a Diamond whose model was picked since on B');
	{
		const sh = hisShape();
		sh.models['d-pin'] = rec(OR, DS, '', '', '', '', 'high');
		const a = await device(sh), b = await device(sh);
		await both(a, b);
		if (has(a, ['setEveryone', 'undoEveryone'])) {
			const u = a.M.setEveryone(X, true);
			a.page.diamondEffort('d-pin');
			a.page.diamondEffort('d-oxegen');
			await both(a, b);
			b.page.setDiamondModel('d-pin', { provider: OR, model: GLM });	// Y for the pin
			b.page.setDiamondModel('d-oxegen', { provider: OR, model: GLM });	// the follower pins Y
			await both(a, b);
			const r = a.M.undoEveryone(u);
			check('H6 the pin is kept as B chose it', a.recs()['d-pin'].model === GLM, a.recs()['d-pin']);
			check('H6 no high written onto the pin\'s Y', a.recs()['d-pin'].effort === '', a.recs()['d-pin']);
			check('H6 no high written onto the follower\'s Y', a.recs()['d-oxegen'].effort === '', a.recs()['d-oxegen']);
			check('H6 neither Effort is counted restored', r && r.restored === u.fields.length - 1 + 1, [r, u.fields.length]);
		}
		// B moves the default since: a follower's level stays off, with the default.
		const c = await device(sh), d = await device(sh);
		await both(c, d);
		if (has(c, ['setEveryone', 'undoEveryone'])) {
			const u = c.M.setEveryone(X, true);
			c.page.diamondEffort('d-oxegen');
			await both(c, d);
			d.M.setDefault(OR, GLM);
			await both(c, d);
			c.M.undoEveryone(u);
			check('H6 a follower on a default moved since gets no level', c.recs()['d-oxegen'].effort === '', c.recs()['d-oxegen']);
			check('H6 the pin, put back, still gets its level', c.page.diamondEffort('d-pin') === 'high', c.recs()['d-pin']);
		}
	}

	console.log('\n' + (checks - failures) + '/' + checks + ' passed');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
