// gateway: none
// verify_everyone.mjs -- *Everyone uses X*, proved in the real app (D-20261018-09 U2d).
//
// Owner, 18 Oct: "I'd also like a simple way to change the default _and_ all current
// daimon/chat models to a selected model." The panel that offers it is U3's, so this
// drives the call the panel will make -- `DaimondModels.planEveryone`, `setEveryone`,
// `undoEveryone` -- by `page.evaluate`, in the real app, on his names: six Diamonds
// (Daimond, Oxegen, Hematite, Ontheism, Reit Hoogland, Email) and three chats, three of
// them exceptions, one of which (Kernel notes) is already on the new pick.
//
// Every claim is measured from the RUNS (the mock log's `model`, per request, found by
// a tag the turn carries) and from the RECORDS, never from a pulldown.
//
//   1. The plan names only the two that differ and counts what switches.
//   2. After Move Them Too every next turn runs on X, workers included; Images picks
//      are untouched; History shows one model entry per Diamond, at its next turn and
//      not before; one change set says nothing per Diamond (at most one toast).
//   3. A busy Diamond (its turn held by the mock's pacing) finishes on the old model,
//      its later fan-out and gather round too.
//   4. Undo restores the exact prior map. With one field changed by a second device
//      first -- a SIMULATED ARRIVAL: a record built as that device's parcel and merged
//      through `DaimondCore.applySync`, the path a pull takes -- Undo leaves it and
//      `kept` names it.
//   5. Keep Theirs moves only the default and the followers (and clears the pick that
//      is equal to X, which now follows).
//
//   node dev/verify_everyone.mjs
//   node dev/verify_everyone.mjs --break noclear      # equal picks left pinned
//   node dev/verify_everyone.mjs --break images       # Images picks cleared too
//   node dev/verify_everyone.mjs --break perdispatch  # a turn re-resolves per dispatch
//   node dev/verify_everyone.mjs --break undoblind    # Undo overwrites a later change
//   node dev/verify_everyone.mjs --break toasts       # a toast per Diamond
//   node dev/verify_everyone.mjs --break noteearly    # the note on change, not at turn start
//
// Every break is a SOURCE patch of the named seam, served through `page.route` (the
// seams are closures the page cannot reach). Each anchor must land exactly once, or the
// run refuses: an anchor that drifted is a break that quietly stopped applying.
//
// Needs dev/serve.mjs and dev/mockllm.mjs (dev/world.sh N --up gives both).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, newChat, connectMock, scratch, shot, steerDiamond, storedChats, mockLog, clearMockLog,
	contentText, revealComposer } from './harness.mjs';

const BI  = process.argv.indexOf('--break');
const BEQ = process.argv.find(a => a.startsWith('--break='));
const BREAK = BEQ ? BEQ.split('=')[1] : (BI >= 0 ? (process.argv[BI + 1] || '') : '');

// His model names. The provider is the mock's, as `P`, and "Fireworks AI" is a second provider
// on the same mock, so "equal" is tested on the provider as well as the model. Its id is
// `fireworks-mock`, never the KNOWN `fireworks`: that id falls back to the real Fireworks
// address whenever its stored url is empty, and the mock's own provider (`custom:<url>`)
// stores none, so a first draft sent Email's turns to api.fireworks.ai (401, 0 at the mock).
const DEF_M  = 'deepseek/deepseek-v4.1-flash';
const X_M    = 'z-ai/glm-5.3-flash';
const GLM    = 'z-ai/glm-5.3';
const EYES   = 'google/gemini-2.5-flash-lite';
const FW_M   = 'accounts/fireworks/models/deepseek-v4p1-flash';
const PEER_M = 'mock/thinker';
const FW     = 'fireworks-mock';
const MOCK   = process.env.DAIMOND_MOCK || '';	// the world's mock, by its full url		// what the second device puts Email on
const NAMES  = ['Daimond', 'Oxegen', 'Hematite', 'Ontheism', 'Reit Hoogland', 'Email'];
const CHATS  = ['Kernel notes', 'Reading list', 'Groceries'];

// ── The source breaks ───────────────────────────────────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_BREAKS = {
	// A pick equal to the new default stays pinned instead of following.
	noclear: [{ file: 'js/models.js',
		find: '\t\treturn !!(p && p.model) && p.model === to.model && (p.provider || to.provider) === to.provider;',
		with: '\t\treturn false;' }],
	// Images picks cleared with the text picks: the global one and every Diamond's.
	images: [{ file: 'js/models.js',
		find: "\t\tif (picks && typeof picks.settle === 'function') picks.settle();\n\t\tsave();\n\t\treturn undo;",
		with: "\t\tif (moveAll) {\n"
			+ "\t\t\tstore.images = blankPair(); store.imagesAt = DaimondStamp.next(store.imagesAt);\n"
			+ "\t\t\tvar _all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');\n"
			+ "\t\t\tObject.keys(_all).forEach(function (k) { _all[k].visionProvider = ''; _all[k].visionModel = '';"
			+ " _all[k].vat = Date.now(); });\n"
			+ "\t\t\tlocalStorage.setItem('daimond-diamond-models', JSON.stringify(_all));\n"
			+ "\t\t}\n"
			+ "\t\tif (picks && typeof picks.settle === 'function') picks.settle();\n\t\tsave();\n\t\treturn undo;" }],
	// The turn's set ignored: every dispatch, and the gather round, resolves now.
	perdispatch: [
		{ file: 'js/daimond.js', find: '\t\t\t\t\tvar tm = live.models || null;', with: '\t\t\t\t\tvar tm = null;' },
		{ file: 'js/daimond.js', find: '\t\tif (held && held.daimon) return copyTurnSet(held);',
			with: '\t\tif (false) return copyTurnSet(held);' },
	],
	// Undo writes every field back, whatever happened to it since.
	undoblind: [
		{ file: 'js/models.js', find: '\t\t\tif (samePair(store.def, rec.def.wrote)) {', with: '\t\t\tif (true) {' },
		{ file: 'js/models.js', find: '\t\t\tif (!now || !samePair(now, f.wrote)) {', with: '\t\t\tif (!now) {' },
	],
	// The old receipt per Diamond, from every write the change set makes.
	toasts: [{ file: 'js/daimond.js', find: '\t\t\tsetDiamondModel(target.id, pick);',
		with: "\t\t\tsetDiamondModel(target.id, pick);\n"
			+ "\t\t\ttoast('The daimon moved from its model to ' + (md || 'the default'));" }],
	// The note written when the pick changes, not at the turn that runs on it.
	noteearly: [
		{ file: 'js/daimond.js', find: '\t\ttry { await noteModelInForce(diamondId, dsPair, fa); }',
			with: '\t\ttry { /* noteearly */ }' },
		{ file: 'js/daimond.js', find: '\t\t\tsetDiamondModel(target.id, pick);',
			with: "\t\t\tsetDiamondModel(target.id, pick);\n"
				+ "\t\t\tif (role === 'daimon') { try { var _m = diamondModel(target.id);"
				+ " noteModelInForce(target.id, _m, diamondApp(target.id, _m)); } catch (e) {} }" },
	],
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
	name: 'everyone', profile: scratch('pw', 'everyone-' + process.pid),
	// No service worker, so every request is seen by the routes below.
	serviceWorkers: 'block',
	route: async (page) => {
		for (const f of Object.keys(served)) {
			await page.route('**/' + f, r => r.fulfill({
				status: 200, contentType: 'application/javascript', body: served[f] }));
		}
		// The real Fireworks is never asked: a request there is refused and counted.
		await page.context().route(/fireworks\.ai/, r => { realFw.push(r.request().url()); return r.abort(); });
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

try {
	await connectMock(s, { model: 'mock/fast' });
	if (BREAK) console.log(`  ..   running with --break ${BREAK}`);

	// ══ Seed: his names, his shape ═════════════════════════════════════
	const setup = await p.evaluate(async ({ DEF_M, FW_M, EYES, FW, MOCK }) => {
		const M = window.DaimondModels;
		const P = M.getDefault().provider;
		M.addProvider(FW, { name: 'Fireworks AI', url: MOCK });
		await M.setKey(FW, 'mock-key');
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

	// ══ Turn 1 on each, on its own models ══════════════════════════════
	clearMockLog();
	for (const nm of NAMES) { await steer(ids[nm], `@text pre-${nm}`); await quiet(); }
	for (const nm of CHATS) { await say(chatIds[nm], `@text pre-${nm}`); await quiet(); }
	const pre = Object.fromEntries([...NAMES, ...CHATS].map(n => [n, modelsOf(`pre-${n}`)]));
	const preWant = { Daimond: GLM, Email: FW_M, 'Kernel notes': X_M };
	check([...NAMES, ...CHATS].every(n => pre[n].length === 1 && pre[n][0] === (preWant[n] || DEF_M)),
		'before: each turn ran on its own pick or the default', JSON.stringify(pre));
	const hist0 = await historyCounts(ids);

	// ══ 1. The plan ════════════════════════════════════════════════════
	const plan = await p.evaluate(({ P, X_M }) => window.DaimondModels.planEveryone({ provider: P, model: X_M }), { P, X_M });
	const named = plan.own.filter(o => o.kind !== 'jobs').map(o => o.name).sort();
	// The profile brings Diamonds of its own (Lucy, Neil), all following: they switch too.
	const rail = await p.evaluate(() => [...document.querySelectorAll('#diamond-list .diamond-box')]
		.map(b => ((b.querySelector('.session-box-name') || {}).textContent || '').trim()));
	const others = rail.filter(n => !NAMES.includes(n));
	check(JSON.stringify(named) === JSON.stringify(['Daimond', 'Email']),
		'the plan names only the two that differ', JSON.stringify(named));
	check(plan.follow.daimons === 4 + others.length && plan.follow.chats === 2,
		`and counts what switches: his 4 following Diamonds, the profile's ${others.length} (${others.join(', ')}), and 2 chats`,
		JSON.stringify(plan.follow));
	check(plan.equal.some(e => e.name === 'Kernel notes'),
		'Kernel notes, already on GLM 5.3 Flash, is equal and not named', JSON.stringify(plan.equal.map(e => e.name)));

	// ══ 2/3. Move Them Too, with Oxegen mid-turn ═══════════════════════
	// Oxegen's turn is paced by the mock: two fan-out rounds four seconds apart, then a gather.
	const BUSY = 'busytag';
	await steer(ids.Oxegen, `@rounds 2/4000 spawn_agent {"name":"w{n}","task":"${BUSY} worker {n} say ok"}`);
	const t0 = Date.now();
	while (Date.now() - t0 < 20000 && !mockLog().some(e => (e.tools || []).includes('spawn_agent')
		&& lastUser(e).includes(BUSY))) await sleep(150);
	const busyFrom = mockLog().length;
	await p.evaluate(() => {
		window.__toasts = [];
		new MutationObserver((ms) => ms.forEach(m => m.addedNodes.forEach(n => {
			if (n.nodeType === 1 && /toast/.test(n.className || '')) window.__toasts.push((n.textContent || '').trim());
		}))).observe(document.body, { childList: true, subtree: true });
	});
	const undo1 = await p.evaluate(({ P, X_M }) => window.DaimondModels.setEveryone({ provider: P, model: X_M }, true), { P, X_M });
	const histNow = await historyCounts(ids);
	await p.waitForTimeout(2500);
	const toasts = await p.evaluate(() => window.__toasts.filter(t => /model|moved/i.test(t)));
	check(toasts.length <= 1, 'one change set, no toast per Diamond', `${toasts.length} toast(s)`
		+ (toasts.length ? ': ' + toasts.slice(0, 3).join(' | ') : ''));
	await quiet(4000, 90000);
	const busyLog = mockLog().slice(busyFrom);
	const busyAll = mockLog().filter(e => lastUser(e).includes(BUSY) || /worker \d+ say ok/.test(lastUser(e)));
	const busyModels = [...new Set(busyLog.map(e => e.model))];
	check(busyLog.length >= 3 && busyModels.length === 1 && busyModels[0] === DEF_M,
		'a busy Diamond finishes its turn on the old model: later rounds, workers and gather',
		`${busyLog.length} request(s) after the change on ${JSON.stringify(busyModels)}; turn total ${busyAll.length}`);

	const after = await picksMap();
	check(after.g.def === `${P}|${X_M}`, 'the default is GLM 5.3 Flash', after.g.def);
	check(after.dia.Daimond === `||||${P}|${EYES}` && after.dia.Email === '|||||'
		&& after.chats['Kernel notes'] === '|||' && after.g.draft === '|',
		'Move Them Too cleared every text pick: daimon, workers, chat, Drafting',
		JSON.stringify({ Daimond: after.dia.Daimond, Email: after.dia.Email, kn: after.chats['Kernel notes'], draft: after.g.draft }));
	check(after.g.images === `${P}|${EYES}` && after.dia.Daimond.endsWith(`${P}|${EYES}`),
		'Images picks untouched: the global Images and Daimond\'s own', `${after.g.images}; ${after.dia.Daimond}`);
	check(Object.keys(ids).every(n => histNow[n] === hist0[n]),
		'no history entry at the change itself', JSON.stringify({ before: hist0, atChange: histNow }));

	clearMockLog();
	for (const nm of NAMES) {
		const fan = nm === 'Daimond' || nm === 'Email';
		await steer(ids[nm], fan ? `@tool spawn_agent {"name":"w","task":"wk-${nm} say ok"}` : `@text post-${nm}`);
		await quiet(3000);
	}
	for (const nm of CHATS) { await say(chatIds[nm], `@text post-${nm}`); await quiet(); }
	const post = Object.fromEntries(NAMES.map(n => [n, modelsOf(n === 'Daimond' || n === 'Email' ? `wk-${n}` : `post-${n}`)]));
	CHATS.forEach(n => { post[n] = modelsOf(`post-${n}`); });
	check([...NAMES, ...CHATS].every(n => post[n].length >= 1 && post[n].every(m => m === X_M)),
		'after Move Them Too every next turn runs on GLM 5.3 Flash', JSON.stringify(post));
	const workerReqs = mockLog().filter(e => /wk-(Daimond|Email) say ok/.test(lastUser(e)) && !(e.tools || []).includes('spawn_agent'));
	check(workerReqs.length >= 2 && workerReqs.every(e => e.model === X_M),
		'and their workers too', `${workerReqs.length} worker request(s) on ${JSON.stringify([...new Set(workerReqs.map(e => e.model))])}`);
	const hist1 = await historyCounts(ids);
	const added = Object.fromEntries(NAMES.map(n => [n, hist1[n] - hist0[n]]));
	check(NAMES.every(n => added[n] === 1), 'History shows one model entry per Diamond, at its next turn',
		JSON.stringify(added));
	await shot(s, 'after-move');

	// ══ 4. Undo: exact, and compare-and-set ════════════════════════════
	// First the clean case on a fresh change set: exact.
	const mid = await picksMap();
	const undoX = await p.evaluate(({ P }) => window.DaimondModels.setEveryone({ provider: P, model: 'mock/fast' }, true), { P });
	const undoXr = await p.evaluate((u) => window.DaimondModels.undoEveryone(u), undoX);
	const midBack = await picksMap();
	const d0 = diffMaps(mid, midBack);
	check(d0.length === 0 && undoXr.kept.length === 0, 'Undo with nothing changed since restores the exact map',
		d0.length ? d0.join('; ') : `restored ${undoXr.restored}`);

	// Then the first change set, after Email's daimon was moved on the other device.
	const peer = await p.evaluate(async ({ id, P, PEER_M }) => {
		const all = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}');
		const r = JSON.parse(JSON.stringify(all[id] || {}));
		r.provider = P; r.model = PEER_M;
		r.at = window.DaimondStamp ? DaimondStamp.next(+r.at || 0) : Date.now() + 1000;
		const got = await window.DaimondCore.applySync({ diamonds: [{ id: id, data: '', touched: 0, model: r }] }, Date.now());
		const now = JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[id] || {};
		return { failed: (got && got.failed) || [], model: now.model || '' };
	}, { id: ids.Email, P, PEER_M });
	check(peer.model === PEER_M, 'simulated arrival: the other device\'s parcel puts Email on mock/thinker',
		JSON.stringify(peer));
	const undone = await p.evaluate((u) => window.DaimondModels.undoEveryone(u), undo1);
	const back = await picksMap();
	const want = JSON.parse(JSON.stringify(prior));
	want.dia.Email = [P, PEER_M, FW, FW_M, '', ''].join('|');
	const d1 = diffMaps(want, back);
	check(d1.length === 0, 'Undo restores the prior map, all but the field the other device changed',
		d1.length ? d1.join('; ') : `restored ${undone.restored}`);
	check(undone.kept.length === 1 && undone.kept[0].name === 'Email' && undone.kept[0].role === 'daimon',
		'and `kept` names Email\'s daimon', JSON.stringify(undone.kept));

	// ══ 5. Keep Theirs ═════════════════════════════════════════════════
	const beforeKeep = await picksMap();
	await p.evaluate(({ P, X_M }) => window.DaimondModels.setEveryone({ provider: P, model: X_M }, false), { P, X_M });
	const kept = await picksMap();
	const dk = diffMaps(beforeKeep, kept);
	const wantK = [`g.def: ${P}|${DEF_M} -> ${P}|${X_M}`, `chats.Kernel notes: ${P}|${X_M}|| -> |||`];
	check(JSON.stringify(dk.sort()) === JSON.stringify(wantK.sort()),
		'Keep Theirs moves only the default, and the pick equal to it now follows', dk.join('; ') || '(nothing moved)');
	clearMockLog();
	for (const nm of ['Daimond', 'Email', 'Oxegen']) { await steer(ids[nm], `@text keep-${nm}`); await quiet(); }
	for (const nm of ['Kernel notes', 'Reading list']) { await say(chatIds[nm], `@text keep-${nm}`); await quiet(); }
	const keep = Object.fromEntries(['Daimond', 'Email', 'Oxegen', 'Kernel notes', 'Reading list'].map(n => [n, modelsOf(`keep-${n}`)]));
	const keepWant = { Daimond: GLM, Email: PEER_M, Oxegen: X_M, 'Kernel notes': X_M, 'Reading list': X_M };
	check(Object.keys(keepWant).every(n => keep[n].length === 1 && keep[n][0] === keepWant[n]),
		'and the runs say so: the exceptions on theirs, the followers on GLM 5.3 Flash', JSON.stringify(keep));
	check(realFw.length === 0, 'nothing was sent to the real Fireworks', `${realFw.length} request(s)`);
} catch (e) {
	check(false, 'the run finished', String(e && e.message || e));
	try { await shot(s, 'threw'); } catch {}
} finally {
	await s.close();
}

console.log(failures === 0
	? `\nverify_everyone: all checks pass.`
	: `\nverify_everyone: ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
