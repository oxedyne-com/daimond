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
import { source, lift, liftFn } from './testlift.mjs';

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
	'adoptDiamondModel', 'diamondModel', 'migrateInherit', 'unmigrateInherit', 'setFoldPick', 'everyDiamondClient',
	'withRecent', 'chatOwnsModel', 'slimChat', 'chatFields', 'takeChatMeta', 'chatTurnBeats', 'chatMetaBeats',
	'chatMetaFields', 'chatModelBeats', 'takeChatModel', 'chatMatOf', 'chatMatSplit', 'mergeFold',
	'mergeChatRecords', 'touchChatMeta', 'touchChatModel', 'noteModelInForce', 'bootInherit', 'inheritGate'];
const VARS = ['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF', 'INHERIT_KEY',
	'CHAT_TURN_FIELDS', 'CHAT_META_FIELDS', 'CHAT_NAME_FIELDS', 'CHAT_MODEL_FIELDS', '_chatModelShedSaid', '_inheritDone'];
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
		chatsUp: o.chatsUp !== false, diamonds: o.diamonds, _diamondApps: {}, _daimonApps: new Map(), _diamondAppProvider: new Map(),
		applyFoldSettings: () => {}, persistChats: () => { env.persisted++; }, persisted: 0,
		diag: () => {}, tel: () => {}, t: (k) => k,
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

// ── QA-B M1: unmigrate after later deliberate changes ──
{
	const A = device(APP, STAMP);
	run('M1 migrate', A);
	A.clock.t += 86400000;	// a day later he pins Kernel notes to GLM 5.3 and a turn records Reit's ran pair
	A.setDiamondModel('d-kernel', { provider: OR, model: GLM });
	A.setDiamondModel('d-reit', { ranProvider: OR, ranModel: DEF.model });
	A.chats[2].provider = FW; A.chats[2].model = FWDS; A.touchChatModel(A.chats[2]);	// and moves chat three to Fireworks
	A.clock.t += 60000;
	A.unmigrateInherit();
	check('M1 a pick made after the migration survives unmigrate', daimon(A.rec('d-kernel')) === OR + '|' + GLM, A.rec('d-kernel'));
	check('M1 a chat model changed after the migration survives unmigrate', A.chats[2].model === FWDS, pair(A.chats[2]));
	check('M1 the ran pair a turn wrote survives unmigrate', A.rec('d-reit').ranModel === DEF.model, A.rec('d-reit'));
}
// ── QA-B M2: the migration seeds each Diamond's last-run pair with the pair in force before it ──
{
	const A = device(APP, STAMP, { diamonds: [{ id: 'd-bare', name: 'Bare' }, { id: 'd-reit', name: 'Reit' }] });
	run('M2 migrate', A);
	const ranOf = (r) => r ? [r.ranProvider || '', r.ranModel || ''].join('|') : '';
	check('M2 a pinned Diamond\'s ran is its own pick', ranOf(A.rec('d-daimond')) === OR + '|' + GLM, A.rec('d-daimond'));
	check('M2 a Diamond cleared to follow keeps the default it ran on', ranOf(A.rec('d-reit')) === OR + '|' + DEF.model, A.rec('d-reit'));
	check('M2 a Diamond on another provider keeps its own', ranOf(A.rec('d-email')) === FW + '|' + FWDS, A.rec('d-email'));
	check('M2 a Diamond with no record gets the default', ranOf(A.rec('d-bare')) === OR + '|' + DEF.model, A.rec('d-bare'));
	check('M2 the copy names what it cleared', !!JSON.parse(A.ls.get(IKEY)).cleared, JSON.parse(A.ls.get(IKEY)).cleared);
	// A ran pair already written by a new-build turn is left alone.
	const B = device(APP, STAMP, { models: Object.assign(shape().models, { 'd-kernel': Object.assign(rec(OR, GLMF), { ranProvider: OR, ranModel: GLM }) }) });
	run('M2 migrate B', B);
	check('M2 an existing ran pair is kept', ranOf(B.rec('d-kernel')) === OR + '|' + GLM, B.rec('d-kernel'));
}
// ── QA-B M3: a seed never beats a real turn's ran pair ──
// B migrates and runs a turn on GLM 5.3, which writes the one note. A, not yet synced, migrates
// an hour later and seeds Reit's ran pair with the default. Once they sync, a turn on GLM 5.3
// on either device writes no second note.
await (async () => {
	const A = device(APP, STAMP), B = device(APP, STAMP);
	const notes = [];
	const app = (who) => ({ record_model_change: async (id, text) => { notes.push(who + ':' + id); } });
	const to = { provider: OR, model: GLM };
	run('M3 migrate B', B);
	B.clock.t += 3600000;
	await guarded('M3 B turn', B, () => B.noteModelInForce('d-reit', to, app('B')));
	A.clock.t += 7200000;
	run('M3 migrate A', A);
	const sync = (x, y) => Object.keys(y.recs()).forEach((id) => x.adoptDiamondModel(id, y.rec(id), false));
	sync(A, B); sync(B, A);
	check('M3 after sync both hold the turn\'s ran pair', A.rec('d-reit').ranModel === GLM && B.rec('d-reit').ranModel === GLM,
		[A.rec('d-reit'), B.rec('d-reit')]);
	A.clock.t += 60000; B.clock.t += 60000;
	await guarded('M3 A turn', A, () => A.noteModelInForce('d-reit', to, app('A')));
	await guarded('M3 B turn 2', B, () => B.noteModelInForce('d-reit', to, app('B')));
	check('M3 one history note across both devices', notes.length === 1, notes);
})();
// ── QA-B round 2, limit 1 (D-20261018-09 I5): the migration runs once the Diamond list is read ──
// A template Diamond (or one made without a key) has no model record, so only the Diamond list
// names it. The boot is driven in the order daimond.js itself takes: whatever `completeUnlock`
// runs before the list is read, then the list, then whatever the boot's `loadDiamonds` step runs
// after it. The default then moves, and its first new-build turn must write the history note.
await (async () => {
	const unlockSrc = liftFn(APP, 'completeUnlock'), allSrc = liftFn(APP, 'renderAll');
	const listStep = allSrc.slice(allSrc.indexOf("step('loadDiamonds'"));
	const atUnlock = /\n\s*try \{ migrateInherit\(\);/.test(unlockSrc);
	const afterList = /loadDiamonds\(\)\.then\(bootInherit/.test(listStep);
	check('M4 the unlock does not migrate before the Diamond list is read', !atUnlock);
	check('M4 the boot migrates once its Diamond list is read', afterList);
	const live = [];		// the boot's `diamonds`, empty until the list is read
	const A = device(APP, STAMP, { models: Object.assign(shape().models), diamonds: live });
	if (atUnlock) run('M4 migrate at unlock', A);
	live.push({ id: 'd-tpl', name: 'Template' });
	if (afterList) guarded('M4 boot migrate', A, () => A.bootInherit());
	A.clock.t += 86400000;
	A.ms.def = { provider: OR, model: GLM };		// the default moves before the template's first turn
	const notes = [];
	const app = { record_model_change: async (id) => { notes.push(id); } };
	await guarded('M4 template turn', A, () => A.noteModelInForce('d-tpl', { provider: OR, model: GLM }, app));
	check('M4 a template Diamond with no record gets its note after a default move', notes.join() === 'd-tpl', notes);
	// No parcel goes out before the migration: `collectSync` waits on the gate it opens.
	const coll = liftFn(APP, 'collectSync');
	check('M4 the parcel waits for the boot migration', /await inheritGate\(/.test(coll.slice(0, coll.indexOf('verifyManifestPresence'))));
	const B = device(APP, STAMP);
	let opened = false;
	const g = guarded('M4 gate', B, () => B.inheritGate(60000));
	if (g) g.then(() => { opened = true; });
	await new Promise((r) => setTimeout(r, 10));
	check('M4 the gate is shut until the boot migration has run', !opened && !!g);
	guarded('M4 boot migrate B', B, () => B.bootInherit());
	await new Promise((r) => setTimeout(r, 10));
	check('M4 the gate opens once it has run', opened);
})();
console.log((failures ? 'FAIL' : 'ok') + ' qa_migrate: ' + (checks - failures) + '/' + checks);
if (failures) process.exit(1);
