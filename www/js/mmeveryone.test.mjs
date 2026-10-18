/* ============================================================
   Test -- D-20261018-09 U2a: Everyone uses X.
   ------------------------------------------------------------
   `DaimondModels.setEveryone(pick, moveAll)` sets the default and,
   in the same synchronous change set, clears every pick equal to
   it; with Move Them Too every text-model pick. Images stay.
   `planEveryone(pick)` is the data the confirm is written from.
   The old star (`setDefault`) clears equal picks the same way.

     G1  Move Them Too on his migrated shape;
     G2  Keep Theirs;
     G3  6 Diamonds + 3 chats, 3 exceptions, one equal: the plan;
     G4  one call, one change set, every write landed on return;
     G5  setDefault(p, m) clears a Diamond pinned to that pair.

   The REAL models.js, and the REAL daimond.js functions behind
   the reader it binds (testlift.mjs). Red proof:

     MM_SRC_REV=14ef947b node www/js/mmeveryone.test.mjs
   ============================================================ */
import { source, lift } from './testlift.mjs';
import { loadStore } from './storefixture.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

// ── His shape, as U1f's migration leaves it (mmmigrate.test.mjs F1) ─────────
const OR = 'openrouter', FW = 'fireworks';
const DS    = 'deepseek/deepseek-v4.1-flash';
const GLM   = 'z-ai/glm-5.3', GLMF = 'z-ai/glm-5.3-flash', GEM = 'google/gemini-2.5-flash-lite';
const FWDS  = 'accounts/fireworks/models/deepseek-v4p1-flash';
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
	updatedAt: S, metaAt: S, mat: S });

// ── One device: the real models.js and the page's reader over one storage ───
const PAGE = ['readJson', 'diamondModels', 'setDiamondModel', 'modelPicksOf', 'diamondPicks', 'chatPicks',
	'summarisingPick', 'setFoldPick', 'touchChatModel', 'chatMatOf', 'chatDisplayName',
	'everyoneTargets', 'clearPick', 'setPick', 'settlePicks'];
const PAGE_VARS = ['DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF', 'DIAMOND_EFFORT_HALF', '_picksDirty'];
const MKEY = 'daimond-diamond-models', SKEY = 'daimond-models-v2', CKEY = 'daimond-byok';

async function device(o) {
	const ls = new Map();
	const localStorage = {
		getItem:    (k) => (ls.has(k) ? ls.get(k) : null),
		setItem:    (k, v) => ls.set(k, String(v)),
		removeItem: (k) => ls.delete(k),
	};
	// One device at a time on the real global, as mmeffective.test.mjs runs models.js.
	const win = globalThis;
	win.dispatchEvent = () => true;
	const doc = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
	const load = (body) => new Function('window', 'document', 'localStorage', 'console', 'globalThis', body)(
		win, doc, localStorage, console, win);
	loadStore(win, localStorage);
	const tombs = {};
	win.DaimondCore = {
		tombs:      () => Object.assign({}, tombs),
		tombstone:  (k, id, at) => { tombs[id] = at || Date.now(); },
		mergeTombs: (k, inc) => Object.assign(tombs, inc || {}),
	};
	load(source('stamp.js'));
	const DaimondStamp = win.DaimondStamp;
	load(source('models.js'));
	const M = win.DaimondModels;
	const changes = { n: 0 };
	M.init({ onChange: () => { changes.n++; } });
	M.addProvider(OR, { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey(OR, 'or-key');
	M.addProvider(FW, { url: 'https://api.fireworks.ai/inference/v1', name: 'Fireworks AI' });
	await M.setKey(FW, 'fw-key');
	M.setDefault(OR, DS);
	if (o.draft && M.setDraft) M.setDraft(o.draft.provider, o.draft.model);
	for (const role of Object.keys(o.jobs || {})) if (M.setJob) M.setJob(role, o.jobs[role].provider, o.jobs[role].model);
	localStorage.setItem(MKEY, JSON.stringify(o.models));
	const cfg = { foldProvider: (o.fold && o.fold.provider) || '', foldModel: (o.fold && o.fold.model) || '' };
	localStorage.setItem(CKEY, JSON.stringify(cfg));
	const chats = o.chats;
	const diamonds = Object.keys(o.models).map((id) => ({ id, name: NAMES[id] || id }));
	const L = lift(source('daimond.js'), PAGE, PAGE_VARS);
	const env = {
		window: win, localStorage, DaimondStamp, DaimondModels: M, Notes: undefined, cfg, CFG_KEY: CKEY,
		chats, diamonds, _diamondApps: {}, _diamondAppProvider: new Map(), applyFoldSettings: () => {},
		persistChats: () => { env.persisted++; localStorage.setItem('chats', JSON.stringify(chats)); }, persisted: 0,
		tOr: (k, d) => d, chatOpening: () => '', diag: () => {},
	};
	const body = L.body + `
		function fn(n) { try { return eval(n); } catch (e) { return null; } }
		var api = {};
		${JSON.stringify(PAGE)}.forEach(function (n) { api[n] = fn(n); });
		return api;`;
	const keys = Object.keys(env);
	const page = new Function(...keys, body)(...keys.map((k) => env[k]));
	// What daimond.js binds at start-up, read from its own source below (`binds`).
	if (M.bindPicks) {
		M.bindPicks({ diamond: page.diamondPicks, chat: page.chatPicks, summarising: page.summarisingPick,
			list: page.everyoneTargets, clear: page.clearPick, settle: page.settlePicks });
	}
	return { M, page, env, ls, cfg, chats, changes, missing: L.missing,
		recs: () => JSON.parse(localStorage.getItem(MKEY)), rec: (id) => JSON.parse(localStorage.getItem(MKEY))[id] };
}

function has(d, names) {
	const gone = names.filter((n) => typeof d.M[n] !== 'function');
	if (gone.length) check('DaimondModels has ' + names.join(', '), false, 'missing: ' + gone.join(', ')
		+ (d.missing.length ? '; daimond.js lacks ' + d.missing.join(', ') : ''));
	return gone.length === 0;
}
const daimon  = (r) => [r.provider, r.model].join('|');
const workers = (r) => [r.workerProvider, r.workerModel].join('|');
const images  = (r) => [r.visionProvider, r.visionModel].join('|');
const pairC   = (c) => [c.provider, c.model, c.workerProvider, c.workerModel].join('|');
const def     = (d) => { const x = d.M.getDefault(); return x.provider + '|' + x.model; };
const names   = (l) => (l || []).map((w) => w.name).sort();

function hisShape(extra) {
	return Object.assign({
		models: migrated(),
		chats: [chat('c1', 'one'), chat('c2', 'two'), chat('c3', 'three', OR, GLM)],
		jobs: { images: { provider: OR, model: GEM } },
	}, extra || {});
}

async function main() {
	// Daimond.js binds the reader with its writers, not the readers alone.
	const APP = source('daimond.js');
	const binds = /DaimondModels\.bindPicks\(\{[^}]*\}\)/.exec(APP);
	check('daimond.js binds list, clear and settle', !!binds && /list:/.test(binds[0]) && /clear:/.test(binds[0])
		&& /settle:/.test(binds[0]), binds && binds[0]);

	// ── G1 Move Them Too ─────────────────────────────────────────────
	console.log('\nG1: Move Them Too clears every text pick, keeps the Images, sets the default');
	{
		const d = await device(hisShape({ draft: { provider: OR, model: GLM }, fold: { provider: OR, model: GLM },
			jobs: { workers: { provider: FW, model: FWDS }, images: { provider: OR, model: GEM } } }));
		if (has(d, ['setEveryone', 'planEveryone'])) {
			const plan = d.M.planEveryone(X);
			check('G1 Kernel notes is equal, not named', names(plan.equal).includes('Kernel notes')
				&& !names(plan.own).includes('Kernel notes'), plan);
			const u = d.M.setEveryone(X, true);
			const r = d.recs();
			check('G1 the default is the pick', def(d) === OR + '|' + GLMF, def(d));
			for (const id of Object.keys(r)) {
				check('G1 ' + id + ' daimon and Workers follow', daimon(r[id]) === '|' && workers(r[id]) === '|', r[id]);
			}
			check('G1 Daimond keeps its Images', images(r['d-daimond']) === OR + '|' + GEM, r['d-daimond']);
			check('G1 the Effort half stays', r['d-oxegen'].effort === 'high' && r['d-oxegen'].eat === S, r['d-oxegen']);
			check('G1 each cleared record is stamped past S', ['d-daimond', 'd-email', 'd-kernel'].every((id) => +r[id].at > S), r);
			check('G1 every chat follows', d.chats.every((c) => pairC(c) === '|||'), d.chats.map(pairC));
			check('G1 the cleared chat moved its model stamp', d.chats[2].mat > S && d.chats[2].metaAt === d.chats[2].mat && d.chats[2].nat === S, d.chats[2]);
			check('G1 Drafting follows', d.M.getJob('drafting').model === '', d.M.getJob('drafting'));
			check('G1 global Workers follow', d.M.getJob('workers').model === '', d.M.getJob('workers'));
			check('G1 global Images stay', d.M.getJob('images').model === GEM, d.M.getJob('images'));
			check('G1 Summarising follows', d.cfg.foldModel === '' && JSON.parse(d.ls.get(CKEY)).foldModel === '', d.cfg);
			// The undo record: what was written over what, the default included, and no Images. Daimond's
			// daimon and Workers, Email, Kernel notes, chat three, then the three Jobs.
			const f = (u && u.fields) || [];
			const one = (kind, id, role) => f.filter((x) => x.target.kind === kind && (x.target.id || '') === id && x.role === role)[0];
			check('G1 undo: the default', u && u.def && u.def.before.model === DS && u.def.wrote.model === GLMF, u && u.def);
			check('G1 undo: Kernel notes\' daimon', (one('diamond', 'd-kernel', 'daimon') || {}).before
				&& one('diamond', 'd-kernel', 'daimon').before.model === GLMF && one('diamond', 'd-kernel', 'daimon').wrote.model === '');
			check('G1 undo: Daimond\'s Workers', ((one('diamond', 'd-daimond', 'workers') || {}).before || {}).model === GLMF);
			check('G1 undo: chat three', ((one('chat', 'c3', 'daimon') || {}).before || {}).model === GLM, f);
			check('G1 undo: the Jobs', ['drafting', 'workers', 'summarising'].every((role) => one('jobs', '', role)), f);
			check('G1 undo: no Images field', !f.some((x) => x.role === 'images'), f);
			check('G1 undo: only what held a pick', f.length === 2 + 1 + 1 + 1 + 3, f.map((x) => (x.target.id || 'jobs') + '.' + x.role));
		}
	}

	// ── G2 Keep Theirs ───────────────────────────────────────────────
	console.log('\nG2: Keep Theirs moves the default and clears only what equals it');
	{
		const d = await device(hisShape({ draft: { provider: OR, model: GLM }, fold: { provider: OR, model: GLMF },
			jobs: { workers: { provider: OR, model: GLMF }, images: { provider: OR, model: GEM } } }));
		if (has(d, ['setEveryone'])) {
			d.M.setEveryone(X, false);
			const r = d.recs();
			check('G2 the default is the pick', def(d) === OR + '|' + GLMF, def(d));
			check('G2 Kernel notes follows', daimon(r['d-kernel']) === '|' && +r['d-kernel'].at > S, r['d-kernel']);
			check('G2 Daimond keeps all three', daimon(r['d-daimond']) === OR + '|' + GLM && workers(r['d-daimond']) === OR + '|' + GLMF
				&& images(r['d-daimond']) === OR + '|' + GEM && +r['d-daimond'].at === S, r['d-daimond']);
			check('G2 Email keeps its Fireworks daimon', daimon(r['d-email']) === FW + '|' + FWDS && +r['d-email'].at === S, r['d-email']);
			check('G2 chat three keeps its model', pairC(d.chats[2]) === OR + '|' + GLM + '||' && d.chats[2].mat === S, d.chats[2]);
			check('G2 Drafting on another model stays', d.M.getJob('drafting').model === GLM, d.M.getJob('drafting'));
			check('G2 Summarising equal to the pick follows', d.cfg.foldModel === '', d.cfg);
			// Email's workers read the global Workers pick: cleared, they would leave X for Fireworks.
			check('G2 a global Workers pick some daimon of its own reads stays', d.M.getJob('workers').model === GLMF, d.M.getJob('workers'));
			check('G2 the followers now run on the pick', ['d-reit', 'd-oxegen', 'd-hematite'].every((id) =>
				d.M.effective({ kind: 'diamond', id }, 'daimon').model === GLMF));
		}
	}

	// ── G3 the plan ──────────────────────────────────────────────────
	console.log('\nG3: 6 Diamonds and 3 chats, 3 exceptions, one equal: who is named, what is counted');
	{
		const models = migrated();
		delete models['d-ontheism'];
		const d = await device(hisShape({ models, chats: [chat('c1', 'one'), chat('c2', 'two'), chat('c3', 'three')] }));
		if (has(d, ['planEveryone'])) {
			const before = JSON.stringify([...d.ls.entries()]) + def(d);
			const p = d.M.planEveryone(X);
			check('G3 own is exactly Daimond and Email', JSON.stringify(names(p.own)) === '["Daimond","Email"]', p.own);
			check('G3 own says each is a Diamond', (p.own || []).every((w) => w.kind === 'diamond'), p.own);
			check('G3 equal is Kernel notes', JSON.stringify(names(p.equal)) === '["Kernel notes"]', p.equal);
			check('G3 three daimons and three chats switch', p.follow && p.follow.daimons === 3 && p.follow.chats === 3, p.follow);
			check('G3 Daimond\'s Images are kept', JSON.stringify(names((p.imagesKept || []).filter((w) => w.kind === 'diamond'))) === '["Daimond"]', p.imagesKept);
			check('G3 planning writes nothing', JSON.stringify([...d.ls.entries()]) + def(d) === before);
			const q = d.M.planEveryone({ provider: OR, model: DS });
			check('G3 the default itself switches nobody', q.follow.daimons === 0 && q.follow.chats === 0, q.follow);
		}
	}

	// ── G4 one call, one change set ──────────────────────────────────
	console.log('\nG4: setEveryone returns a value, and every write has landed when it does');
	{
		const d = await device(hisShape({ fold: { provider: OR, model: GLMF } }));
		if (has(d, ['setEveryone'])) {
			const n0 = d.changes.n, p0 = d.env.persisted;
			const u = d.M.setEveryone(X, true);
			check('G4 not a Promise', !!u && typeof u === 'object' && typeof u.then !== 'function', u);
			check('G4 one store change, so one parcel', d.changes.n - n0 === 1, d.changes.n - n0);
			check('G4 the default is on disk', JSON.parse(d.ls.get(SKEY) || '{}').def.model === GLMF);
			check('G4 the Diamond records are on disk', daimon(d.rec('d-kernel')) === '|' && daimon(d.rec('d-daimond')) === '|');
			check('G4 the chats are saved, once', d.env.persisted - p0 === 1
				&& JSON.parse(d.ls.get('chats')).every((c) => pairC(c) === '|||'), d.env.persisted - p0);
			check('G4 Summarising is on disk', JSON.parse(d.ls.get(CKEY)).foldModel === '');
		}
	}

	// ── G5 the star clears equal picks ───────────────────────────────
	console.log('\nG5: setDefault(p, m) clears a Diamond pinned to that very pair');
	{
		const d = await device(hisShape());
		d.M.setDefault(OR, GLMF);
		const r = d.recs();
		check('G5 the default moved', def(d) === OR + '|' + GLMF, def(d));
		check('G5 Kernel notes, pinned to it, now follows', daimon(r['d-kernel']) === '|', r['d-kernel']);
		check('G5 Daimond, on another daimon, keeps its Workers', workers(r['d-daimond']) === OR + '|' + GLMF, r['d-daimond']);
	}

	console.log('\n' + (checks - failures) + '/' + checks + ' passed');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('  FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
