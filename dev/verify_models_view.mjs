// gateway: none
// verify_models_view.mjs -- the Models view's top half, driven by DOM clicks (D-20261018-09 U3a).
//
// Owner, 18 Oct: "Reimagine the Models menu ... I can't understand it" and "a simple way to change
// the default _and_ all current daimon/chat models to a selected model". The layer underneath
// (planEveryone, setEveryone, undoEveryone) is proved by verify_everyone.mjs; this proves the
// panel a person touches, on his names and his shape, by pressing what he presses: the real
// search-filter picker, Move Them Too, Keep Theirs, Undo, an Except row's "Default (name)".
//
//   V1 Everyone uses is the first control and shows the standing default and a turn's cost.
//   V2 Changing it asks in the panel, naming Daimond and Email only and counting the switch;
//      Move Them Too puts every next turn on X (mock log) and leaves Images; Undo restores the
//      exact map; with Email moved on a second device first, Undo leaves it and says so.
//   V3 Except lists only true exceptions, and a row's "Default (name)" clears it to follows.
//   V4 Keep Theirs never moves a Workers pick equal to X onto a global Workers pick (mm-latent
//      8af816746 fixed this on 90eaed81; --break latent1 reverts it).
//   V5 Undo after Move Them Too puts back an Effort level the new model lacked (mm-latent
//      5a075ccf7 on 90eaed81; --break latent2 reverts it).
//   Rows carry no fill, and are 44px high on a phone.
//
//   node dev/verify_models_view.mjs [--shots DIR]
//   node dev/verify_models_view.mjs --break noask           # the change applies without asking
//   node dev/verify_models_view.mjs --break countequal      # the confirm names the equal pick too
//   node dev/verify_models_view.mjs --break undoblind       # Undo overwrites a later change
//   node dev/verify_models_view.mjs --break nodefaultclear  # "Default (name)" is refused
//   node dev/verify_models_view.mjs --break latent1         # 8af816746 reverted
//   node dev/verify_models_view.mjs --break latent2         # 5a075ccf7 reverted
//   node dev/verify_models_view.mjs --break rowfill         # an Except row gets a fill
//   node dev/verify_models_view.mjs --break pickfield       # an Except row's picker draws a field (daylight)
//   --rev SHA serves this branch's www files as at SHA (red on 90eaed816); --shots DIR --look obsidian|porcelain
//
// Every break is a SOURCE patch served through `page.route`; each anchor must land exactly once.
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, connectMock, scratch, steerDiamond, storedChats, mockLog, clearMockLog,
	contentText, revealComposer, statusRow } from './harness.mjs';

const BI  = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');
const SI  = process.argv.indexOf('--shots');
const SHOTS = SI >= 0 ? (process.argv[SI + 1] || '') : '';
// --look obsidian|porcelain: the palette the shots are drawn in (daylight skin), as shot_crystaldefault.
const LI  = process.argv.indexOf('--look');
const LOOK = LI >= 0 ? (process.argv[LI + 1] || '') : '';

const DEF_M  = 'deepseek/deepseek-v4.1-flash';
const X_M    = 'z-ai/glm-5.3-flash';
const GLM    = 'z-ai/glm-5.3';
const EYES   = 'google/gemini-2.5-flash-lite';
const FW_M   = 'accounts/fireworks/models/deepseek-v4p1-flash';
const PEER_M = 'mock/thinker';
const LACKS  = 'mock/eyes';	// offers high and low, not medium
const FW     = 'fireworks-mock';
const MOCK   = process.env.DAIMOND_MOCK || '';
const NAMES  = ['Daimond', 'Oxegen', 'Hematite', 'Ontheism', 'Reit Hoogland', 'Email'];
const CHATS  = ['Kernel notes', 'Reading list', 'Groceries'];
// His models, listed by the mock's /models as well as its own, so the picker offers them.
const EXTRA  = [DEF_M, X_M, GLM, EYES, FW_M];

// ── The source breaks ───────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_BREAKS = {
	noask: [{ file: 'js/models.js', find: '\t\t\tif (!planEveryone(g).own.length) {', with: '\t\t\tif (true) {' }],
	countequal: [{ file: 'js/models.js', find: '\t\tvar names = plan.own.map(ownerName).filter(Boolean);',
		with: '\t\tvar names = plan.own.concat(plan.equal).map(ownerName).filter(Boolean);' }],
	undoblind: [
		{ file: 'js/models.js', find: '\t\t\tif (samePair(store.def, rec.def.wrote)) {', with: '\t\t\tif (true) {' },
		{ file: 'js/models.js', find: '\t\t\tif (!now || !samePair(now, f.wrote)) {', with: '\t\t\tif (!now) {' },
	],
	nodefaultclear: [{ file: 'js/models.js',
		find: "\t\t\tpicks.set(x.target, 'daimon', (!g.model || isPick(g, pairOf(store.def))) ? null : g);",
		with: "\t\t\tif (g.model) picks.set(x.target, 'daimon', g);" }],
	latent1: [{ file: 'js/models.js',
		find: '(moveAll || (onTo && gwTo && isPick(own.workers, to)))', with: '(moveAll || (onTo && isPick(own.workers, to)))' }],
	latent2: [{ file: 'js/models.js',
		find: '\t\t\tif (e && e.level) undo.efforts.push(', with: '\t\t\tif (false) undo.efforts.push(' }],
	rowfill: [{ file: 'css/models.css', find: '.models-exc { padding: 6px 0; }',
		with: '.models-exc { padding: 6px 0; background: var(--bg-tertiary); }' }],
	pickfield: [{ file: 'css/skin-daylight.css',
		find: ':root[data-skin="daylight"] .mp-models-exc-sel > input.mp-in { background-color: transparent; padding: 5px 20px 5px 4px; }',
		with: '' }],
};
if (BREAK && !SRC_BREAKS[BREAK]) {
	console.error(`unknown --break '${BREAK}'; one of: ${Object.keys(SRC_BREAKS).join(', ')}`);
	process.exit(2);
}
const served = {};
for (const b of (SRC_BREAKS[BREAK] || [])) {
	let body = served[b.file] || fs.readFileSync(path.join(HERE, '..', 'www', b.file), 'utf8');
	const n = body.split(b.find).length - 1;
	if (n !== 1) {
		console.error(`break '${BREAK}': the anchor appears ${n} times in ${b.file}, so nothing was broken `
			+ 'and the run would prove nothing. Move the anchor with the file.\n  ' + b.find.split('\n')[0].trim());
		process.exit(2);
	}
	served[b.file] = body.replace(b.find, b.with);
}

// --rev SHA: serve every www file this branch changed as it stood at SHA (the red run on the base).
const RI = process.argv.indexOf('--rev');
const REV = RI >= 0 ? (process.argv[RI + 1] || '') : '';
if (REV) {
	const { execFileSync } = await import('node:child_process');
	const root = path.join(HERE, '..');
	const files = execFileSync('git', ['diff', '--name-only', REV, 'HEAD', '--', 'www'], { cwd: root, encoding: 'utf8' })
		.split('\n').filter(f => f && !/\.test\.mjs$/.test(f));
	for (const f of files) {
		try { served[f.replace(/^www\//, '')] = execFileSync('git', ['show', REV + ':' + f], { cwd: root, encoding: 'utf8' }); }
		catch (e) { /* new on this branch: served as is */ }
	}
	console.log(`  ..   serving ${Object.keys(served).length} www file(s) as at ${REV}`);
}

let failures = 0;
const realFw = [];	// requests that tried the real Fireworks
const check = (cond, msg, detail) => {
	console.log((cond ? '  ok   ' : '  FAIL ') + msg + (detail != null ? ' — ' + detail : ''));
	if (!cond) failures++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/// Make a Diamond through the dialog a person uses.
async function create(p, name) {
	await p.evaluate(() => document.getElementById('new-diamond-btn').click());
	await p.waitForSelector('.dlg-card', { timeout: 8000 });
	await p.evaluate((nm) => {
		const card = [...document.querySelectorAll('.dlg-card')].filter(c => c.getClientRects().length).pop();
		const inp = card.querySelector('input.dlg-input');
		inp.value = nm;
		inp.dispatchEvent(new Event('input', { bubbles: true }));
		card.querySelector('.dlg-ok').click();
	}, name);
	// UNTIL ITS TILE IS ON THE RAIL, not a fixed 900ms. The sixth Diamond, made while the
	// earlier ones are still booting, can take longer than that on a loaded host, and the
	// next dialog opened over a creation still in flight lost it (I step 2: seeding red,
	// twice, under --break perdispatch, which touches nothing creation runs).
	await p.waitForFunction((nm) => [...document.querySelectorAll('#diamond-list .diamond-box')]
		.some(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim() === nm),
		name, { timeout: 15000 }).catch(() => {});
	await p.waitForTimeout(300);
}

const s = await open({
	name: 'modelsview', profile: scratch('pw', 'modelsview-' + process.pid),
	serviceWorkers: 'block',
	route: async (page) => {
		if (LOOK) await page.addInitScript((th) => { try { localStorage.setItem('daimond-skin', 'daylight'); localStorage.setItem('daimond-theme', th); } catch (e) {} }, LOOK);
		for (const f of Object.keys(served)) {
			await page.route('**/' + f, r => r.fulfill({ status: 200,
				contentType: f.endsWith('.css') ? 'text/css' : (f.endsWith('.html') ? 'text/html' : 'application/javascript'), body: served[f] }));
		}
		await page.context().route(/fireworks\.ai/, r => { realFw.push(r.request().url()); return r.abort(); });
		// The mock's model list, with his models added.
		await page.context().route(u => !!MOCK && u.origin === new URL(MOCK).origin && /\/models$/.test(u.pathname), async r => {
			const res  = await r.fetch();
			const body = await res.json().catch(() => ({ data: [] }));
			const have = new Set((body.data || []).map(m => m.id));
			body.data = (body.data || []).concat(EXTRA.filter(id => !have.has(id)).map(id => ({ id, object: 'model' })));
			await r.fulfill({ response: res, body: JSON.stringify(body), contentType: 'application/json' });
		});
	},
});
const { page: p } = s;

/// The requests the mock logged whose last user message carries `tag`.
const lastUser = (e) => {
	const u = (e.messages || []).filter(m => m && m.role === 'user').pop();
	return u ? contentText(u.content) : '';
};
const tagged = (tag) => mockLog().filter(e => lastUser(e).includes(tag));

/// Wait until the mock has been quiet for `ms` and nothing spins.
async function quiet(ms = 2500, cap = 60000) {
	const t0 = Date.now();
	let n = mockLog().length, since = Date.now();
	while (Date.now() - t0 < cap) {
		await sleep(300);
		const m = mockLog().length;
		if (m !== n) { n = m; since = Date.now(); continue; }
		const spin = await p.evaluate(() => !!document.querySelector('.chat-spinner')).catch(() => false);
		if (!spin && Date.now() - since >= ms) return true;
	}
	return false;
}

/// One turn on a Diamond, by id, saying `text`.
async function steer(id, text) {
	await p.evaluate((did) => {
		const b = document.querySelector(`#diamond-list .diamond-box[data-id="${did}"]`);
		if (b) b.click();
	}, id);
	await p.waitForTimeout(700);
	await steerDiamond(s, text);
}

/// One turn on a chat, by id, saying `text`.
async function say(id, text) {
	await p.evaluate((cid) => {
		const b = document.querySelector(`#session-list .chat-box[data-id="${cid}"]`);
		if (b) b.click();
	}, id);
	await p.waitForTimeout(700);
	await revealComposer(p);
	await p.fill('#chat-input', text);
	await p.click('#chat-send');
}

/// The models the requests carrying `tag` ran on, as a set.
const modelsOf = (tag) => [...new Set(tagged(tag).map(e => e.model))];

/// Every text and Images pick, as the records hold them: the four global choices, each
/// Diamond's record and each chat's, by name. Stamps and the `ran` pair are not picks.
async function picksMap() {
	const page = await p.evaluate(({ names }) => {
		const M = window.DaimondModels;
		const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		const ids = {};
		document.querySelectorAll('#diamond-list .diamond-box').forEach(b => {
			const nm = ((b.querySelector('.session-box-name') || {}).textContent || '').trim();
			if (names.includes(nm)) ids[nm] = b.dataset.id;
		});
		const dia = {};
		names.forEach(nm => {
			const r = all[ids[nm]] || {};
			dia[nm] = ['provider', 'model', 'workerProvider', 'workerModel', 'visionProvider', 'visionModel']
				.map(k => r[k] || '').join('|');
		});
		const g = {};
		['def', 'draft', 'workers', 'images'].forEach(k => {
			const c = M.storedChoice(k) || {};
			g[k] = (c.provider || '') + '|' + (c.model || '');
		});
		return { g, dia };
	}, { names: NAMES });
	const rows = await storedChats(s);
	const chats = {};
	(rows || []).forEach(c => {
		if (c && CHATS.includes(c.name)) {
			chats[c.name] = ['provider', 'model', 'workerProvider', 'workerModel'].map(k => c[k] || '').join('|');
		}
	});
	return { ...page, chats };
}

/// The fields two maps disagree on, as `where.name: before -> after`.
function diffMaps(a, b) {
	const out = [];
	for (const sec of ['g', 'dia', 'chats']) {
		const keys = new Set([...Object.keys(a[sec] || {}), ...Object.keys(b[sec] || {})]);
		for (const k of keys) {
			if ((a[sec] || {})[k] !== (b[sec] || {})[k]) out.push(`${sec}.${k}: ${(a[sec] || {})[k]} -> ${(b[sec] || {})[k]}`);
		}
	}
	return out;
}

/// How many `model` rows each Diamond's History holds (`DaimondVersions.rows`, what the panel draws).
const historyCounts = (ids) => p.evaluate(async (ids) => {
	const out = {};
	for (const [nm, id] of Object.entries(ids)) {
		let rows = [];
		try { rows = await window.DaimondVersions.rows(id); } catch (e) { rows = []; }
		out[nm] = (rows || []).filter(r => (r.cause || r.kind) === 'model').length;
	}
	return out;
}, ids);


// ── The panel ───────────────────────────────────────────────────────

/// Open the Models panel the way he reaches it: Settings home, "This device", the model row.
async function openPanel() {
	await statusRow(p, '#astat-model');
	await p.evaluate(() => document.getElementById('astat-model').click());
	await p.waitForSelector('#models-list .models-everyone', { timeout: 10000 });
	await p.waitForTimeout(300);
}

const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/// Choose `text` (a row's leading words) in the picker `mp` (a Locator on the `.mp` wrapper).
async function choose(mp, text) {
	const inp = mp.locator('input.mp-in');
	await inp.scrollIntoViewIfNeeded();
	await inp.click();
	await p.waitForSelector('#mp-pop', { state: 'visible', timeout: 5000 });
	const row = p.locator('#mp-pop .mp-row').filter({ has: p.locator('.mp-main', { hasText: new RegExp('^\\s*' + reEsc(text) + '(\\s|·|\\(|$)') }) }).first();
	await row.scrollIntoViewIfNeeded();
	await row.click();
	await p.waitForTimeout(400);
}

const everyoneMp = () => p.locator('#models-list .models-everyone .mp-models-everyone-sel');
const excMp = (name) => p.locator('#models-list .models-exc').filter({ has: p.locator('.models-exc-name', { hasText: new RegExp('^' + reEsc(name) + '$') }) }).locator('.mp-models-exc-sel');
const jobMp = (job) => p.locator(`#models-list .models-job:has(select[data-job="${job}"]) .mp-models-job-sel`);
const text = (sel) => p.evaluate((q) => { const e = document.querySelector(q); return e ? e.textContent.trim() : null; }, sel);
const excNames = () => p.evaluate(() => [...document.querySelectorAll('#models-list .models-exc .models-exc-name')].map(e => e.textContent.trim()));
const excSub = (name) => p.evaluate((nm) => {
	const r = [...document.querySelectorAll('#models-list .models-exc')].find(x => x.querySelector('.models-exc-name').textContent.trim() === nm);
	const s = r && r.querySelector('.models-exc-sub');
	return s ? s.textContent.trim() : '';
}, name);
const diaRec = (id) => p.evaluate((id) => JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}, id);

async function shotAs(label) {
	if (!SHOTS) return;
	fs.mkdirSync(SHOTS, { recursive: true });
	const eng = (process.env.DAIMOND_BROWSER || 'chromium').toLowerCase();
	await p.screenshot({ path: path.join(SHOTS, `u3a_${label}_${LOOK || 'default'}_${eng}.png`) }).catch(() => {});
}

try {
	await connectMock(s, { model: 'mock/fast' });
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);

	// ══ Seed: his names, his shape ═════════════════════════════════════
	const setup = await p.evaluate(async ({ DEF_M, FW_M, EYES, FW, MOCK }) => {
		const M = window.DaimondModels;
		const P = M.getDefault().provider;
		M.addProvider(FW, { name: 'Fireworks AI', url: MOCK });
		await M.setKey(FW, 'mock-key');
		await M.fetchModels(P);
		await M.fetchModels(FW);
		M.setDefault(P, DEF_M);
		M.setJob('images', P, EYES);
		M.setDraft(P, DEF_M);
		const r = M.resolve(FW, FW_M) || {};
		return { P, fwUrl: r.baseUrl || '', fwKey: !!r.apiKey, def: M.getDefault() };
	}, { DEF_M, FW_M, EYES, FW, MOCK });
	const P = setup.P;
	check(!!P && !!MOCK && setup.fwUrl === MOCK && setup.fwKey && setup.def.model === DEF_M,
		'seeded: the default is DeepSeek V4.1 Flash, and "Fireworks AI" runs at the mock with its own key',
		JSON.stringify(setup));

	for (const nm of NAMES) await create(p, nm);
	const ids = await p.evaluate((names) => {
		const out = {};
		document.querySelectorAll('#diamond-list .diamond-box').forEach(b => {
			const nm = ((b.querySelector('.session-box-name') || {}).textContent || '').trim();
			if (names.includes(nm)) out[nm] = b.dataset.id;
		});
		return out;
	}, NAMES);
	check(NAMES.every(n => ids[n]), 'six Diamonds made through the New Diamond dialog', Object.keys(ids).join(', '));

	// The two pinned Diamonds' picks, as his records hold them.
	await p.evaluate(({ ids, P, GLM, X_M, EYES, FW_M, FW }) => {
		const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		const now = Date.now();
		all[ids.Daimond] = Object.assign({}, all[ids.Daimond], { provider: P, model: GLM, workerProvider: P,
			workerModel: X_M, visionProvider: P, visionModel: EYES, at: now, wat: now, vat: now });
		all[ids.Email] = Object.assign({}, all[ids.Email], { provider: FW, model: FW_M,
			workerProvider: FW, workerModel: FW_M, at: now, wat: now });
		localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
	}, { ids, P, GLM, X_M, EYES, FW_M, FW });

	// Three chats; Kernel notes on X, the others following.
	const chatIds = {};
	for (const nm of CHATS) {
		chatIds[nm] = await newChat(s);
		await revealComposer(p);
		await p.fill('#chat-input', '@text hello ' + nm);
		await p.click('#chat-send');
		await quiet(1500);
	}
	// Named, and Kernel notes put on X, as his other device's parcel would: through the merge.
	const rows0 = await storedChats(s);
	const seeded = await p.evaluate(async ({ rows, chatIds, P, X_M }) => {
		const out = [];
		const next = (n) => (window.DaimondStamp ? DaimondStamp.next(n || 0) : Math.max(Date.now(), (n || 0) + 1));
		Object.entries(chatIds).forEach(([nm, id]) => {
			const r = rows.find(c => c && c.id === id);
			if (!r) return;
			const c = JSON.parse(JSON.stringify(r));
			c.name = nm;
			c.metaAt = next(Math.max(c.metaAt || 0, c.updatedAt || 0));
			if (nm === 'Kernel notes') { c.provider = P; c.model = X_M; c.mat = next(Math.max(c.mat || 0, c.metaAt)); }
			out.push(c);
		});
		const got = await window.DaimondCore.applySync({ chats: out }, Date.now());
		return { n: out.length, failed: (got && got.failed) || [] };
	}, { rows: rows0, chatIds, P, X_M });
	await p.waitForTimeout(1200);
	const prior = await picksMap();
	check(seeded.n === 3 && CHATS.every(n => prior.chats[n] != null) && prior.chats['Kernel notes'] === `${P}|${X_M}||`,
		'three chats, named, Kernel notes on GLM 5.3 Flash (seeded as a peer parcel, merged by applySync)',
		JSON.stringify(prior.chats));
	check(prior.dia.Daimond === `${P}|${GLM}|${P}|${X_M}|${P}|${EYES}` && prior.dia.Email.startsWith(`${FW}|${FW_M}`)
		&& ['Oxegen', 'Hematite', 'Ontheism', 'Reit Hoogland'].every(n => prior.dia[n] === '|||||'),
		'his shape: Daimond and Email pinned, the other four following', JSON.stringify(prior.dia));
	const PN = await p.evaluate((P) => window.DaimondModels.providerName(P), P);
	const X_T = `GLM 5.3 Flash · ${PN}`;	// X under the mock's own key: the same model is on "Fireworks AI" too
	const rail = await p.evaluate(() => [...document.querySelectorAll('#diamond-list .diamond-box')]
		.map(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim()));
	const others = rail.filter(n => n && !NAMES.includes(n));

	// ══ V1: Everyone uses, first, standing, priced ═════════════════════
	await openPanel();
	const v1 = await p.evaluate(() => {
		const list = document.getElementById('models-list');
		const first = list.querySelector('input.mp-in, button');
		const heads = [...list.querySelectorAll('.models-head')].map(h => h.textContent.trim());
		return { firstIn: !!(first && first.closest('.mp-models-everyone-sel')), value: first ? first.value : '',
			heads, turn: (list.querySelector('.models-turn') || {}).textContent || '',
			draftOld: !!document.querySelector('.models-draft-sel'), foot: !!list.querySelector('.models-default'),
			jobs: [...list.querySelectorAll('select.models-job-sel')].map(s => s.dataset.job + '=' + (s.value || 'same')) };
	});
	check(v1.firstIn && v1.heads[0] === 'Everyone uses', 'V1 Everyone uses is the first control', JSON.stringify(v1.heads));
	check(/^DeepSeek V4\.1 Flash\b/.test(v1.value), 'V1 it shows the standing default by its display name', v1.value);
	check(/^About \S+ a turn$/.test(v1.turn.trim()), 'V1 under it, what a turn costs', v1.turn);
	check(!v1.draftOld && v1.foot && v1.jobs.length === 4, 'Jobs holds Workers, Images, Drafting, Summarising; the old Drafting row is gone',
		v1.jobs.join(' '));
	await shotAs('rest_desk');

	// ══ V3a: Except at rest ════════════════════════════════════════════
	const exc0 = await excNames();
	check(JSON.stringify(exc0.slice().sort()) === JSON.stringify(['Daimond', 'Email', 'Kernel notes']),
		'V3 Except lists only the true exceptions: Daimond, Email, Kernel notes (on X, not the default)', JSON.stringify(exc0));
	const subD = await excSub('Daimond'), subE = await excSub('Email');
	check(subD === 'Workers: GLM 5.3 Flash · Images: Gemini 2.5 Flash Lite' && subE.startsWith('Through Fireworks AI'),
		'V3 a row\'s second line names its jobs, and the paying provider when not his own', `${subD} | ${subE}`);

	// ══ V2: the confirm, Move Them Too, Undo ═══════════════════════════
	await choose(everyoneMp(), X_T);
	const ask = await text('#models-list .models-ask-text');
	const stillDef = await p.evaluate(() => window.DaimondModels.storedChoice('def').model);
	check(ask != null && stillDef === DEF_M, 'V2 changing it asks first, in the panel, and nothing has moved yet', `${ask} / ${stillDef}`);
	const nD = 4 + others.length;
	// Of his Diamonds and chats it names the two that differ; the Drafting job, pinned to the old
	// default, is named too, by its job. Kernel notes, already on X, is not.
	const named = NAMES.concat(CHATS, others).filter(n => (ask || '').includes(n));
	check(!!ask && ask.includes(`${nD} daimons and 2 chats switch at their next turn.`)
		&& JSON.stringify(named.sort()) === JSON.stringify(['Daimond', 'Email']) && /have their own model\.$/.test(ask),
		`V2 it names Daimond and Email only and counts ${nD} daimons and 2 chats`, ask);
	const btns = await p.evaluate(() => [...document.querySelectorAll('#models-list .models-ask button')].map(b => b.textContent.trim()));
	check(JSON.stringify(btns) === JSON.stringify(['Move Them Too', 'Keep Theirs']), 'V2 the answers, in Title Case', JSON.stringify(btns));
	await shotAs('ask_desk');
	await p.click('#models-list .models-ask button.models-move');
	await p.waitForTimeout(500);
	const done = await text('#models-list .models-done-text');
	check(!!done && done === `All ${nD + 1 + 1} daimons and 3 chats are on GLM 5.3 Flash.`.replace(`${nD + 2}`, String(nD + 2)),
		'V2 then the Undo line says where everyone is', done);
	check(await p.evaluate(() => !!document.querySelector('#models-list .models-done button.models-undo')), 'V2 with its Undo');
	await shotAs('done_desk');
	const moved = await picksMap();
	check(moved.g.images === prior.g.images && moved.dia.Daimond.endsWith(`|${P}|${EYES}`),
		'V2 Images untouched: the global pick and Daimond\'s own', `${moved.g.images} / ${moved.dia.Daimond}`);
	clearMockLog();
	for (const nm of NAMES) { await steer(ids[nm], `@text mv-${nm}`); await quiet(); }
	for (const nm of CHATS) { await say(chatIds[nm], `@text mv-${nm}`); await quiet(); }
	const mv = Object.fromEntries([...NAMES, ...CHATS].map(n => [n, modelsOf(`mv-${n}`)]));
	check([...NAMES, ...CHATS].every(n => mv[n].length === 1 && mv[n][0] === X_M),
		'V2 after Move Them Too every next turn runs on GLM 5.3 Flash (mock log)', JSON.stringify(mv));
	await openPanel();
	await p.click('#models-list .models-done button.models-undo');
	await p.waitForTimeout(500);
	const undoneTxt = await text('#models-list .models-done-text');
	const back = await picksMap();
	const d0 = diffMaps(prior, back);
	check(d0.length === 0 && undoneTxt === 'Put back as it was.', 'V2 Undo restores the exact map, and says so',
		d0.length ? d0.join('; ') : undoneTxt);

	// Compare-and-set: Move Them Too again, Email moved on the other device, then Undo.
	await choose(everyoneMp(), X_T);
	await p.click('#models-list .models-ask button.models-move');
	// Until Email's clear is on disk: the other device's parcel is built from what is stored.
	await p.waitForFunction((id) => !(JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).model,
		ids.Email, { timeout: 8000 }).catch(() => {});
	await p.waitForTimeout(1200);
	const peer = await p.evaluate(async ({ id, P, PEER_M }) => {
		const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		const r = JSON.parse(JSON.stringify(all[id] || {}));
		r.provider = P; r.model = PEER_M;
		// As the other device's setDiamondModel writes it: the daimon pair is stamped past both
		// its own `dat` and `at`, and `dat` is then dropped because it equals `at`. Bumping `at`
		// alone leaves a copied `dat` (the Undo's stamp) in force, and the merge rightly ignores it.
		const prev = Math.max(typeof r.dat === 'number' ? r.dat : 0, +r.at || 0);
		r.at = window.DaimondStamp ? DaimondStamp.next(prev) : Date.now() + 1000;
		delete r.dat;
		const got = await window.DaimondCore.applySync({ diamonds: [{ id: id, data: '', touched: 0, model: r }] }, Date.now());
		const now = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {};
		return { failed: (got && got.failed) || [], held: (got && got.held) || [], model: now.model || '', sent: r.at, wasAt: (all[id] || {}).at, wasDat: (all[id] || {}).dat, now: now.at };
	}, { id: ids.Email, P, PEER_M });
	check(peer.model === PEER_M, 'simulated arrival: the other device puts Email on mock/thinker', JSON.stringify(peer));
	await openPanel();
	await p.click('#models-list .models-done button.models-undo');
	await p.waitForTimeout(500);
	const casTxt = await text('#models-list .models-done-text');
	const back2 = await picksMap();
	const want = JSON.parse(JSON.stringify(prior));
	want.dia.Email = [P, PEER_M, FW, FW_M, '', ''].join('|');
	const d1 = diffMaps(want, back2);
	check(d1.length === 0, 'V2 Undo leaves the field the other device changed, and restores the rest', d1.join('; ') || 'exact');
	check(casTxt === 'Email was changed on another device and keeps its model.', 'V2 and says so, naming Email', casTxt);

	// ══ V4: Keep Theirs keeps an equal Workers pick off a global Workers pick ══
	await p.evaluate(({ id, P, X_M }) => {
		const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		all[id] = Object.assign({}, all[id], { workerProvider: P, workerModel: X_M, wat: Date.now() });
		localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
	}, { id: ids.Oxegen, P, X_M });
	await openPanel();
	await choose(jobMp('workers'), `Fast · ${PN}`);
	const gw = await p.evaluate(() => window.DaimondModels.storedChoice('workers'));
	check(gw && gw.model === 'mock/fast', 'Jobs → Workers sets the global Workers pick', JSON.stringify(gw));
	await choose(everyoneMp(), X_T);
	const ask4 = await text('#models-list .models-ask-text');
	await p.click('#models-list .models-ask button.models-keep');
	await p.waitForTimeout(500);
	const ox = await p.evaluate((id) => ({ eff: window.DaimondModels.effective({ kind: 'diamond', id }, 'workers'),
		rec: (JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {}).workerModel || '' }), ids.Oxegen);
	check(ox.eff.model === X_M && ox.rec === X_M,
		'V4 Keep Theirs: Oxegen\'s Workers pick, equal to X, stays and runs on X, not the global Workers pick (mm-latent 8af816746)',
		JSON.stringify(ox) + ' / ' + ask4);
	const exc4 = await excNames();
	check(JSON.stringify(exc4.slice().sort()) === JSON.stringify(['Daimond', 'Email', 'Oxegen']),
		'V3 after Keep Theirs, Kernel notes (equal to X) follows and leaves Except; Oxegen\'s job puts it in', JSON.stringify(exc4));
	const subO = await excSub('Oxegen');
	check(subO === 'Workers: GLM 5.3 Flash', 'V3 Oxegen\'s row names its Workers pick', subO);
	await choose(jobMp('workers'), 'Same as daimon');

	// ══ V3b: "Default (name)" clears a row to follows ══════════════════
	const e0 = await diaRec(ids.Email);
	await choose(excMp('Email'), 'Default (GLM 5.3 Flash)');
	const e1 = await diaRec(ids.Email);
	const eEff = await p.evaluate((id) => window.DaimondModels.effective({ kind: 'diamond', id }, 'daimon'), ids.Email);
	check(!e1.model && !e1.provider && (+e1.at || 0) > (+e0.at || 0) && eEff.model === X_M && eEff.from === 'default',
		'V3 Email\'s "Default (GLM 5.3 Flash)" clears its own model, as a stamped write, and it follows',
		`${e0.model}@${e0.at} -> ${e1.model || '∅'}@${e1.at}, runs ${eEff.model} from ${eEff.from}`);

	// ══ V5: Undo puts back an Effort level the new model lacked ════════
	await p.evaluate(({ id, P, PEER_M }) => {
		const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		const now = Date.now();
		all[id] = Object.assign({}, all[id], { provider: P, model: PEER_M, at: now,
			effort: 'medium', effortProvider: P, effortModel: PEER_M, eat: now });
		localStorage.setItem('daimond-diamond-models', JSON.stringify(all));
	}, { id: ids.Ontheism, P, PEER_M });
	await openPanel();
	await choose(everyoneMp(), `Eyes · ${PN}`);
	await p.click('#models-list .models-ask button.models-move');
	await p.waitForTimeout(400);
	clearMockLog();
	await steer(ids.Ontheism, '@text eff-Ontheism'); await quiet();
	const o1 = await diaRec(ids.Ontheism);
	check(!o1.model && !o1.effort && modelsOf('eff-Ontheism')[0] === LACKS,
		'V5 after Move Them Too, Ontheism runs on mock/eyes and its Effort "medium" (which that lacks) is dropped',
		JSON.stringify({ model: o1.model, effort: o1.effort, ran: modelsOf('eff-Ontheism') }));
	await openPanel();
	await p.click('#models-list .models-done button.models-undo');
	await p.waitForTimeout(500);
	const o2 = await diaRec(ids.Ontheism);
	check(o2.model === PEER_M && o2.effort === 'medium',
		'V5 Undo puts Ontheism back on mock/thinker with its Effort "medium" (mm-latent 5a075ccf7)',
		JSON.stringify({ model: o2.model, effort: o2.effort }));

	// ══ Rows: tokens only, no fills; 44px on a phone ═══════════════════
	const fills = await p.evaluate(() => [...document.querySelectorAll('#models-list .models-exc, #models-list .models-job, '
		+ '#models-list .models-everyone, #models-list .models-except, #models-list .models-jobs')]
		.map(e => getComputedStyle(e).backgroundColor).filter(c => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent'));
	check(fills.length === 0, 'rows carry no fill', fills.join(', '));
	// An Except row's picker draws no field, and every picker keeps its text clear of its chevron
	// (the daylight one-field rule outranked both: a long name ran under the chevron).
	const pk = await p.evaluate(() => [...document.querySelectorAll('#models-list .mp-models-exc-sel > input.mp-in, '
		+ '#models-list .mp-models-job-sel > input.mp-in, #models-list .mp-models-everyone-sel > input.mp-in')].map(i => {
		const cs = getComputedStyle(i), exc = i.parentNode.classList.contains('mp-models-exc-sel');
		return { exc, bg: cs.backgroundColor, pr: parseFloat(cs.paddingRight) };
	}));
	const pkBad = pk.filter(x => (x.exc && x.bg !== 'rgba(0, 0, 0, 0)' && x.bg !== 'transparent') || x.pr < 18);
	check(pk.length > 0 && pkBad.length === 0, 'an Except row\'s picker has no field; every picker keeps room for its chevron',
		JSON.stringify(pkBad.length ? pkBad : pk.length));
	await p.setViewportSize({ width: 390, height: 845 });
	await openPanel();
	const low = await p.evaluate(() => [...document.querySelectorAll('#models-list .models-exc-top, #models-list .models-job')]
		.filter(e => e.getClientRects().length).map(e => Math.round(e.getBoundingClientRect().height)).filter(h => h < 44));
	check(low.length === 0, 'on a phone every Except and Jobs row is at least 44px', JSON.stringify(low));
	await shotAs('rest_phone');
	check(realFw.length === 0, 'nothing was sent to the real Fireworks', `${realFw.length} request(s)`);
} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try {
		console.log('  ..   diag', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('#models-list .mp')].slice(0, 3).map(w => {
			const r = w.getBoundingClientRect(); const i = w.querySelector('input');
			return { cls: w.className, r: [r.x, r.y, r.width, r.height].map(Math.round), vis: getComputedStyle(w).visibility, disp: getComputedStyle(w).display, i: i && i.value };
		}))));
	} catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_models_view: all checks pass.`
	: `\nverify_models_view: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
