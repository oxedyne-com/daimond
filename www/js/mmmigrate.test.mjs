/* ============================================================
   Test -- D-20261018-09 U1f: copies become follows.
   ------------------------------------------------------------
   Every chat and New Diamond used to store a COPY of the default,
   so moving the default moved nothing he could see. `migrateInherit`
   clears, once per device, each stored pick that only restates what
   it would follow, against the stored default, provider-aware, and
   keeps this device's prior values for `unmigrateInherit`.

   The fixture is his real shape (spec Review 18 Oct item 1). The
   REAL functions are lifted from daimond.js and stamp.js
   (testlift.mjs), one sandbox per device. Red proof:

     MM_SRC_REV=14ef947b node www/js/mmmigrate.test.mjs   # F1, F6 fail
     node www/js/mmmigrate.test.mjs                       # all pass

   F6's peer always runs 14ef947b's code, by `git show`.
   ============================================================ */
import { source, lift } from './testlift.mjs';

const APP   = source('daimond.js');
const STAMP = source('stamp.js');
const OLD   = source('daimond.js', '14ef947b');
const OLD_STAMP = source('stamp.js', '14ef947b');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const FNS = ['readJson', 'diamondModels', 'setDiamondModel', 'blankDiamondModel', 'mergeDiamondModel',
	'adoptDiamondModel', 'diamondModel', 'migrateInherit', 'unmigrateInherit', 'setFoldPick',
	'withRecent', 'chatOwnsModel', 'slimChat', 'chatFields', 'takeChatMeta', 'chatTurnBeats', 'chatMetaBeats',
	'chatMetaFields', 'chatModelBeats', 'takeChatModel', 'chatMatOf', 'chatMatSplit', 'mergeFold',
	'mergeChatRecords', 'touchChatMeta', 'touchChatModel'];
const VARS = ['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF', 'INHERIT_KEY',
	'CHAT_TURN_FIELDS', 'CHAT_META_FIELDS', 'CHAT_NAME_FIELDS', 'CHAT_MODEL_FIELDS', '_chatModelShedSaid'];
const MKEY = 'daimond-diamond-models', IKEY = 'daimond-inherit-v1', CKEY = 'daimond-config';

// ── His real shape ────────────────────────────────────────────────────────────
const OR = 'openrouter', FW = 'fireworks';
const DEF   = { provider: OR, model: 'deepseek/deepseek-v4.1-flash' };
const GLM   = 'z-ai/glm-5.3', GLMF = 'z-ai/glm-5.3-flash', GEM = 'google/gemini-2.5-flash-lite';
const FWDS  = 'accounts/fireworks/models/deepseek-v4p1-flash';
const S = Date.UTC(2026, 9, 1);	// when the copies were made
const rec = (p, m, wp, wm, vp, vm, eff) => ({ provider: p, model: m, workerProvider: wp || '', workerModel: wm || '',
	visionProvider: vp || '', visionModel: vm || '', effort: eff ? eff.effort : '', effortProvider: eff ? eff.p : '',
	effortModel: eff ? eff.m : '', at: S, eat: eff ? S : 0 });
function shape() {
	return {
		models: {
			'd-daimond':  rec(OR, GLM, OR, GLMF, OR, GEM),
			'd-reit':     rec(OR, DEF.model, OR, DEF.model),
			'd-email':    rec(FW, FWDS, FW, FWDS),
			'd-oxegen':   rec(OR, DEF.model, OR, DEF.model, '', '', { effort: 'high', p: OR, m: DEF.model }),
			'd-hematite': rec(OR, DEF.model, OR, DEF.model),
			'd-ontheism': rec(OR, DEF.model, OR, DEF.model),
			'd-kernel':   rec(OR, GLMF),
		},
		chats: [
			{ id: 'c1', name: 'one',   provider: OR, model: DEF.model, workerProvider: OR, workerModel: DEF.model, updatedAt: S, metaAt: S },
			{ id: 'c2', name: 'two',   provider: OR, model: DEF.model, workerProvider: OR, workerModel: DEF.model, updatedAt: S, metaAt: S },
			{ id: 'c3', name: 'three', provider: OR, model: GLM,       workerProvider: OR, workerModel: GLM,       updatedAt: S, metaAt: S },
		],
		draft: { provider: OR, model: DEF.model },
	};
}

/// One device: its own storage, clock and models store, and the real code over them. A name the
/// revision lacks comes back null and is listed in `missing`.
function device(src, stampSrc, o) {
	o = o || {};
	const L = lift(src, FNS, VARS);
	const ls = new Map();
	const localStorage = {
		getItem: (k) => (ls.has(k) ? ls.get(k) : null),
		setItem: (k, v) => { ls.set(k, String(v)); },
	};
	const clock = { t: Date.UTC(2026, 9, 18, 22, 0, 0) + (o.skew || 0) };
	const DateStub = { now: () => clock.t };
	const sh = shape();
	localStorage.setItem(MKEY, JSON.stringify(o.models || sh.models));
	// The models store as models.js holds it: `storedChoice` reads it raw, null with no provider.
	const ms = { providers: o.empty ? {} : { openrouter: 1, fireworks: 1 }, def: o.def || DEF, defAt: S,
		draft: sh.draft, draftAt: S };
	const win = {};
	new Function('window', 'Date', stampSrc)(win, DateStub);
	win.DaimondModels = {
		getDefault: () => ({ provider: ms.def.provider, model: ms.def.model }),
		storedChoice: (slot) => (Object.keys(ms.providers).length
			? { provider: (ms[slot] && ms[slot].provider) || '', model: (ms[slot] && ms[slot].model) || '' } : null),
		setDraft: (p, m) => { ms.draft = { provider: m ? (p || '') : '', model: m || '' }; ms.draftAt = win.DaimondStamp.next(ms.draftAt); },
	};
	const cfg = { foldProvider: OR, foldModel: DEF.model };
	localStorage.setItem(CKEY, JSON.stringify({ foldProvider: OR, foldModel: DEF.model }));
	const chats = o.chats || sh.chats;
	const env = {
		window: win, localStorage: localStorage, Date: DateStub, DaimondStamp: win.DaimondStamp,
		DaimondModels: win.DaimondModels, Notes: undefined, cfg: cfg, CFG_KEY: CKEY, chats: chats,
		chatsUp: o.chatsUp !== false, _diamondApps: {}, _diamondAppProvider: new Map(),
		applyFoldSettings: () => {}, persistChats: () => { env.persisted++; }, persisted: 0,
		diag: () => {}, tel: () => {},
		slimMessages: (m) => m || [],
		mergeMessages: (l, r) => {
			const seen = new Set(), out = [];
			(l || []).concat(r || []).forEach((m) => { if (!seen.has(m.mid)) { seen.add(m.mid); out.push(m); } });
			return out;
		},
	};
	const body = L.body + `
		function fn(n) { try { return eval(n); } catch (e) { return null; } }
		var api = {};
		${JSON.stringify(FNS)}.forEach(function (n) { api[n] = fn(n); });
		return api;`;
	const keys = Object.keys(env);
	const api = new Function(...keys, body)(...keys.map((k) => env[k]));
	Object.assign(api, { missing: L.missing, clock, ms, cfg, chats, env, ls,
		rec: (id) => JSON.parse(localStorage.getItem(MKEY))[id],
		recs: () => JSON.parse(localStorage.getItem(MKEY)) });
	return api;
}

/// Run `f`, turning a missing function into a named failure rather than a throw.
function guarded(name, d, f) {
	try { return f(); }
	catch (e) { check(name, false, 'threw: ' + e.message + (d.missing.length ? '; revision lacks ' + d.missing.join(', ') : '')); return undefined; }
}
const run = (name, d) => guarded(name, d, () => d.migrateInherit());
const pair = (c) => [c.provider || '', c.model || '', c.workerProvider || '', c.workerModel || ''].join('|');
const daimon = (r) => [r.provider, r.model].join('|');
const workers = (r) => [r.workerProvider, r.workerModel].join('|');
const images = (r) => [r.visionProvider, r.visionModel].join('|');
const snap = (d) => JSON.stringify({ ls: [...d.ls.entries()], chats: d.chats, ms: d.ms, cfg: d.cfg });
const copy = (x) => JSON.parse(JSON.stringify(x));

// ── F1 his shape → the expected map ─────────────────────────────────────────
console.log('F1: his real shape migrates to the expected map');
{
	const A = device(APP, STAMP);
	const before = copy(A.recs());
	const ran = run('F1 migrateInherit runs', A);
	check('F1 it ran', ran === true, ran);
	const r = A.recs();
	for (const id of ['d-daimond', 'd-kernel']) {
		// Unchanged but for the last-run pair the migration seeds (QA B #1; qa_mmB_migrate M2).
		const picks = (x) => { const y = copy(x); ['ranProvider', 'ranModel', 'rat', 'wat', 'vat'].forEach((k) => delete y[k]); return y; };
		check('F1 ' + id + ' is unchanged', JSON.stringify(picks(r[id])) === JSON.stringify(picks(before[id])), [before[id], r[id]]);
	}
	// Email keeps its own model on its own key; its Workers, a copy of that daimon, now follow it
	// (rule 1, as chat 3's), so what its workers run on is unchanged.
	check('F1 d-email keeps its Fireworks daimon, unstamped', daimon(r['d-email']) === FW + '|' + FWDS && (+r['d-email'].dat || r['d-email'].at) === S, r['d-email']);
	check('F1 d-email Workers follow that daimon', workers(r['d-email']) === '|', r['d-email']);
	for (const id of ['d-reit', 'd-oxegen', 'd-hematite', 'd-ontheism']) {
		check('F1 ' + id + ' follows: daimon and Workers \'\'', daimon(r[id]) === '|' && workers(r[id]) === '|', r[id]);
		check('F1 ' + id + ' clear is stamped past S', +r[id].at > S && (!r[id].wat || +r[id].wat > S), r[id]);
	}
	check('F1 the Effort half stays', r['d-oxegen'].effort === 'high' && r['d-oxegen'].effortModel === DEF.model
		&& r['d-oxegen'].eat === S, r['d-oxegen']);
	check('F1 Daimond keeps its Images pick', images(r['d-daimond']) === OR + '|' + GEM, r['d-daimond']);
	const [c1, c2, c3] = A.chats;
	check('F1 chat 1 follows', pair(c1) === '|||', pair(c1));
	check('F1 chat 2 follows', pair(c2) === '|||', pair(c2));
	check('F1 chat 3 keeps its model, its Workers clear', pair(c3) === OR + '|' + GLM + '||', pair(c3));
	// `metaAt` moves with it, the whole clock an old build reads; the name half's `nat` stays (S).
	check('F1 each moved chat moved its model stamp and not its name stamp', [c1, c2, c3].every((c) => c.mat > S && c.metaAt === c.mat && c.nat === S), A.chats);
	check('F1 the chats are saved once', A.env.persisted === 1, A.env.persisted);
	check('F1 Drafting follows, stamped', A.ms.draft.model === '' && A.ms.draftAt > S, A.ms);
	check('F1 Summarising follows', A.cfg.foldModel === '' && JSON.parse(A.ls.get(CKEY)).foldModel === '', A.cfg);
	const kept = JSON.parse(A.ls.get(IKEY) || 'null');
	check('F1 the prior copy is kept', kept && JSON.stringify(kept.diamondModels) === JSON.stringify(before)
		&& kept.chats.c1.model === DEF.model && kept.draft.model === DEF.model && kept.fold.model === DEF.model, kept);
}

// ── F2 a second run writes nothing ──────────────────────────────────────────
console.log('\nF2: a second run writes nothing');
{
	const A = device(APP, STAMP);
	run('F2 first run', A);
	const s1 = snap(A);
	A.clock.t += 60000;
	const again = run('F2 second run', A);
	check('F2 the second run declines', again === false, again);
	check('F2 nothing moved, no stamp', snap(A) === s1);
	// And with the marker cleared by hand, a rerun over the migrated state still clears nothing.
	A.ls.delete(IKEY);
	const s2 = JSON.stringify({ r: A.recs(), c: A.chats, ms: A.ms });
	run('F2 rerun without the marker', A);
	check('F2 a rerun over the migrated state moves no record or stamp',
		JSON.stringify({ r: A.recs(), c: A.chats, ms: A.ms }) === s2);
}

// ── F3 provider-aware ────────────────────────────────────────────────────────
console.log('\nF3: equal means the same provider and the same model');
{
	const sh = shape();
	sh.models['d-fwtwin'] = rec(FW, DEF.model, FW, DEF.model);	// same id as the default, another key
	const A = device(APP, STAMP, { models: sh.models });
	run('F3 runs', A);
	check('F3 Email on Fireworks stays', daimon(A.rec('d-email')) === FW + '|' + FWDS && (+A.rec('d-email').dat || A.rec('d-email').at) === S, A.rec('d-email'));
	check('F3 a Fireworks pick with the OpenRouter default\'s id stays', daimon(A.rec('d-fwtwin')) === FW + '|' + DEF.model
		&& (+A.rec('d-fwtwin').dat || A.rec('d-fwtwin').at) === S, A.rec('d-fwtwin'));
	// A pick naming no provider names the default's, as `resolve` reads it.
	const B = device(APP, STAMP, { models: { 'd-bare': rec('', DEF.model, '', '') } });
	run('F3 bare-provider run', B);
	check('F3 a pick with no provider and the default\'s id follows', daimon(B.rec('d-bare')) === '|', B.rec('d-bare'));
}

// ── F4 unmigrateInherit restores ────────────────────────────────────────────
console.log('\nF4: unmigrateInherit restores the exact prior values, with newer stamps');
{
	const A = device(APP, STAMP);
	const before = copy(A.recs()), chatsBefore = A.chats.map(pair), draftBefore = copy(A.ms.draft);
	run('F4 migrate', A);
	const mid = copy(A.recs()), draftAt = A.ms.draftAt, mats = A.chats.map((c) => c.mat);
	A.clock.t += 60000;
	const ok = guarded('F4 unmigrate runs', A, () => A.unmigrateInherit());
	check('F4 it ran', ok === true, ok);
	const r = A.recs();
	const half = (x) => [x.provider, x.model, x.workerProvider, x.workerModel, x.visionProvider, x.visionModel,
		x.effort, x.effortProvider, x.effortModel].join('|');
	for (const id of Object.keys(before)) {
		check('F4 ' + id + ' prior values back', half(r[id]) === half(before[id]), [before[id], r[id]]);
		const newer = ['at', 'wat', 'vat'].some((k) => +r[id][k] > +(mid[id][k] || 0));
		if (half(mid[id]) !== half(before[id])) check('F4 ' + id + ' restored with a newer stamp', newer, [mid[id], r[id]]);
	}
	check('F4 chats back', JSON.stringify(A.chats.map(pair)) === JSON.stringify(chatsBefore), A.chats.map(pair));
	check('F4 chat stamps newer', A.chats.every((c, i) => c.mat > mats[i]), [mats, A.chats.map((c) => c.mat)]);
	check('F4 Drafting back, newer stamp', JSON.stringify(A.ms.draft) === JSON.stringify(draftBefore) && A.ms.draftAt > draftAt, A.ms);
	check('F4 Summarising back', A.cfg.foldModel === DEF.model && A.cfg.foldProvider === OR, A.cfg);
	check('F4 the marker stays, so it does not migrate again', A.ls.has(IKEY) && A.migrateInherit() === false);
}

// ── F5 an empty store or default writes nothing ──────────────────────────────
console.log('\nF5: an empty store, an empty default or chats not up writes nothing and sets no marker');
for (const [label, o] of [['empty store', { empty: true }], ['empty default', { def: { provider: '', model: '' } }],
	['chats not loaded', { chatsUp: false }]]) {
	const A = device(APP, STAMP, o);
	const s = snap(A);
	const ran = run('F5 ' + label + ' runs', A);
	check('F5 ' + label + ': declines', ran === false, ran);
	check('F5 ' + label + ': nothing written, no marker', snap(A) === s && !A.ls.has(IKEY));
}

// ── F6 the parcel, to a peer on 14ef947b ─────────────────────────────────────
console.log('\nF6: the parcel carries \'\' with stamps, and a 14ef947b peer adopts it');
{
	const A = device(APP, STAMP);
	const P = device(OLD, OLD_STAMP);	// the live record's code, holding the same copies
	run('F6 migrate', A);
	const parcel = copy(A.recs());	// the Diamonds section carries the record verbatim (`models[d.id]`)
	for (const id of ['d-reit', 'd-oxegen', 'd-hematite', 'd-ontheism']) {
		const r = parcel[id];
		check('F6 ' + id + ' travels as \'\' with a newer stamp', r.model === '' && r.provider === '' && +r.at > S, r);
		const took = guarded('F6 ' + id + ' adopted', P, () => P.adoptDiamondModel(id, copy(r), false));
		check('F6 ' + id + ' the peer adopts it', took === true, took);
		const m = P.diamondModel(id);
		check('F6 ' + id + ' the peer\'s diamondModel answers the default', m.provider === DEF.provider && m.model === DEF.model, m);
	}
	for (const id of ['d-daimond', 'd-kernel']) {
		check('F6 ' + id + ' an unmoved record moves nothing on the peer', P.adoptDiamondModel(id, copy(parcel[id]), false) === false);
	}
}

// ── F7 two devices both migrating converge ───────────────────────────────────
console.log('\nF7: two devices both migrating converge');
{
	const A = device(APP, STAMP), B = device(APP, STAMP, { skew: 7000 });
	run('F7 A migrates', A);
	B.clock.t += 3000;
	run('F7 B migrates', B);
	const ra = copy(A.recs()), rb = copy(B.recs());
	for (const id of Object.keys(ra)) {
		guarded('F7 ' + id + ' crosses', A, () => { A.adoptDiamondModel(id, copy(rb[id]), false); B.adoptDiamondModel(id, copy(ra[id]), false); });
	}
	check('F7 the Diamond records converge', JSON.stringify(A.recs()) === JSON.stringify(B.recs()), [A.recs(), B.recs()]);
	const ca = A.chats.map((c) => A.slimChat(c)), cb = B.chats.map((c) => B.slimChat(c));
	const atA = ca.map((c, i) => A.mergeChatRecords(copy(cb[i]), copy(c)));
	const atB = cb.map((c, i) => B.mergeChatRecords(copy(ca[i]), copy(c)));
	check('F7 the chats converge', JSON.stringify(atA.map((c) => [pair(c), c.mat])) === JSON.stringify(atB.map((c) => [pair(c), c.mat])),
		[atA.map(pair), atB.map(pair)]);
	check('F7 and both hold the migrated map', atA.map(pair).join(',') === '|||,|||,' + OR + '|' + GLM + '||', atA.map(pair));
	check('F7 a follower stays a follower on both', daimon(A.rec('d-reit')) === '|' && daimon(B.rec('d-reit')) === '|');
}

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
process.exit(failures ? 1 : 0);
