/* ============================================================
   Test — one owner for a Diamond's model (UNBLOCK-5, C3).
   ------------------------------------------------------------
   Lifelog's turn said glm-5.3 with the Diamond set to deepseek
   v4.1 flash. The daimon's chat record kept its own copy of the
   model, refreshed by an unstamped write in `daimonChat`, so a
   merge with a peer's copy met at an equal `metaAt` and kept the
   canonically greater value: `z-ai/…` beat `deepseek/…` on every
   device, for good.

   Now the Diamond's record owns `model`. A chat inside a Diamond
   holds no model pair (shed on read and on write, logged once),
   and every label, the meter and the errand read the Diamond's
   through `turnModelOf`. Diamond field writes stamp with
   `DaimondStamp.next`, so a change made after seeing a value
   outranks it whatever the clocks.

   The REAL functions are lifted from daimond.js and stamp.js by a
   brace-balanced scan and run in one sandbox per device, each with
   its own localStorage, chat list and clock. Nothing here is a
   reimplementation.

   Run:  node www/js/diamondmodel.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const PEER = readFileSync(join(HERE, 'peer.js'), 'utf8');
const STAMP = readFileSync(join(HERE, 'stamp.js'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

/// `function name(...) { ... }` at any indentation, by counting braces; '' when absent.
function liftFn(src, name) {
	const m = new RegExp('\\n\\t+(?:async )?function ' + name + '\\(').exec(src);
	if (!m) return '';
	const start = m.index + 1;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}
/// `var name = …;` to the first line ending in `;`; '' when absent.
function liftVar(src, name) {
	const m = new RegExp('\\n\\t+var ' + name + '\\b').exec(src);
	if (!m) return '';
	const end = src.indexOf(';\n', m.index);
	return src.slice(m.index + 1, end + 1);
}

const FNS = ['withRecent', 'chatOwnsModel', 'slimChat', 'chatFields', 'takeChatMeta', 'chatTurnBeats',
	'chatMetaBeats', 'mergeFold', 'mergeChatRecords', 'hydrateChat', 'diamondModels', 'setDiamondModel',
	'blankDiamondModel', 'mergeDiamondModel', 'adoptDiamondModel', 'diamondModel', 'turnEffortOf',
	'turnModelOf', 'errandModelOf', 'respModel', 'shortModel', 'daimonChat', 'errandForRecovery',
	'steerModelFor', 'readJson', 'sentModelsOf', 'steerModelsFor', 'turnModelsOfDiamond', 'turnModelsOfChat',
	'chatWorkerModel', 'diamondWorkerModel', 'diamondVisionModel',
	// The chat's model half on its own stamp (D-20261018-09 U1c).
	'chatMetaFields', 'chatModelBeats', 'takeChatModel', 'chatMatOf', 'chatMatSplit'];
const VARS = ['CHAT_TURN_FIELDS', 'CHAT_META_FIELDS', 'CHAT_NAME_FIELDS', 'CHAT_MODEL_FIELDS', 'DIAMOND_MODELS_KEY', 'DIAMOND_MODEL_HALF',
	'DIAMOND_EFFORT_HALF', '_chatModelShedSaid'];
const BODY = VARS.map(function (v) { return liftVar(APP, v); }).join('\n') + '\n'
	+ FNS.map(function (f) { return liftFn(APP, f); }).join('\n');

const clock = { t: Date.UTC(2026, 9, 14, 6, 0, 0) };
const DAY = 86400000, MIN = 60000;

/// One device: its own storage, chats, clock offset and the real code over them.
function device(name, skew) {
	const store = new Map();
	const localStorage = {
		getItem: function (k) { return store.has(k) ? store.get(k) : null; },
		setItem: function (k, v) { store.set(k, String(v)); },
	};
	const RealDate = Date;
	class FakeDate extends RealDate {}
	FakeDate.now = function () { return clock.t + skew; };
	const window = {
		DaimondModels: {
			getDefault: function () { return { provider: 'openrouter', model: 'openrouter/default' }; },
			resolve: function (p, m) { return m && p !== 'nokey' ? { provider: p || 'openrouter', model: m } : null; },
			// The daimon link of models.js's chain (mmeffective.test.mjs drives the real one).
			effective: function (t, role) {
				var rec = (t && t.kind === 'diamond')
					? (JSON.parse(localStorage.getItem('daimond-diamond-models') || '{}')[t.id] || {}) : ((t && t.chat) || {});
				return rec.model ? { provider: rec.provider || '', model: rec.model, from: 'own' }
					: { provider: 'openrouter', model: 'openrouter/default', from: 'default' };
			},
		},
	};
	const logs = [];
	const env = {
		window: window, localStorage: localStorage, Date: FakeDate, logs: logs,
		diag: function (tag, d) { logs.push(tag + ' ' + d); },
		slimMessages: function (m) { return m || []; },
		mergeMessages: function (l, r) {
			const seen = new Set(), out = [];
			(l || []).concat(r || []).forEach(function (m) { if (!seen.has(m.mid)) { seen.add(m.mid); out.push(m); } });
			return out;
		},
		stampMessages: function (m) { return m; },
		newChatId: (function () { let n = 0; return function () { return name + '-chat-' + (++n); }; })(),
		persistChats: function () {},
		t: function (k) { return k; },
		storedPre: function () { return ''; },
		storedEffort: function () { return null; },
		diamondEffort: function () { return ''; },
	};
	const src = STAMP + '\n' + BODY + `
		var DaimondStamp = window.DaimondStamp, DaimondModels = window.DaimondModels, chats = [], current = null, currentDiamond = null, cfg = { model: 'cfg/default' };
		var DaimondPeer = { makeErrand: function (o) { return o; }, handoffDeadline: function () { return 0; } };
		var DaimondSync = { version: function () { return 0; } };
		function fn(n) { try { return eval(n); } catch (e) { return null; } }
		return {
			chats: function () { return chats; },
			setChats: function (c) { chats = c; },
			open: function (c, d) { current = c; currentDiamond = d || null; },
			slimChat: slimChat, mergeChatRecords: mergeChatRecords, hydrateChat: hydrateChat,
			diamondModels: diamondModels, setDiamondModel: setDiamondModel, adoptDiamondModel: adoptDiamondModel,
			diamondModel: diamondModel, respModel: respModel, shortModel: shortModel, daimonChat: daimonChat,
			errandForRecovery: errandForRecovery, turnModelOf: fn('turnModelOf'), steerModelFor: fn('steerModelFor'),
		};`;
	const make = new Function('window', 'localStorage', 'Date', 'diag', 'slimMessages', 'mergeMessages',
		'stampMessages', 'newChatId', 'persistChats', 't', 'storedPre', 'storedEffort', 'diamondEffort', src);
	const api = make(env.window, env.localStorage, env.Date, env.diag, env.slimMessages, env.mergeMessages,
		env.stampMessages, env.newChatId, env.persistChats, env.t, env.storedPre, env.storedEffort, env.diamondEffort);
	api.name = name; api.logs = logs;
	return api;
}

const GLM = { provider: 'z-ai', model: 'z-ai/glm-5.3-flash' };
const DSK = { provider: 'deepseek', model: 'deepseek/deepseek-v4.1-flash' };
const F = { id: 'dia-lifelog', name: 'Lifelog' };

/// The daimon record a device stored before this fix: it carries its own (stale) model.
function legacyRecord(model, at) {
	return { id: 'chat-lifelog', name: 'Lifelog', diamondId: F.id, model: model.model, provider: model.provider,
		messages: [{ mid: 'm1', role: 'user', content: 'hi' }], status: 'active', updatedAt: at, metaAt: at };
}

/// Every pair exchanges the Diamond-models record and the daimon's chat record, twice round,
/// as the sync parcel would: the record travels `slimChat`ed and merges `(incoming, local)`.
function syncAll(devs) {
	for (let round = 0; round < 2; round++) {
		devs.forEach(function (x) {
			devs.forEach(function (y) {
				if (x === y) return;
				y.adoptDiamondModel(F.id, x.diamondModels()[F.id], false);
				const yc = y.chats(), xc = x.chats()[0];
				if (!xc) return;
				if (!yc[0]) { y.setChats([y.hydrateChat(JSON.parse(JSON.stringify(x.slimChat(xc))))]); return; }
				yc[0] = y.mergeChatRecords(JSON.parse(JSON.stringify(x.slimChat(xc))), yc[0]);
			});
		});
	}
}

/// What each device draws on the daimon's Thinking/Daimond tile, against its Diamond's model.
/// The face is opened first (`daimonChat`, which is where the old refresh lived) and the next
/// sync pull lands after it, as it did on the iPhone between 05:58:55 and 06:03:56. The last
/// device is the runner: it never opens the face and runs on its synced record (diag cause 3).
function labels(devs) {
	devs.slice(0, -1).forEach(function (d) { d.daimonChat(F); });
	syncAll(devs);
	return devs.map(function (d) {
		d.open(d.chats()[0], { id: F.id, name: F.name });
		return { dev: d.name, label: d.respModel(), dia: d.shortModel(d.diamondModel(F.id).model) };
	});
}

/// The REAL functions `names`, lifted and run against `own`: every other name they reach is a
/// permissive stub (any property, any call, never a thenable), so a test sets only what it reads.
function lifted(names, own) {
	const U = new Proxy(function () {}, {
		get: function (t, k) {
			if (k === 'then' || k === Symbol.unscopables) return undefined;
			if (k === Symbol.toPrimitive) return function () { return ''; };
			return U;
		},
		apply: function () { return U; },
		construct: function () { return U; },
	});
	const scope = new Proxy(own, {
		has: function (t, k) { return typeof k === 'string' && (k in t || !(k in globalThis)); },
		get: function (t, k) { return k === Symbol.unscopables ? undefined : (k in t ? t[k] : U); },
		set: function (t, k, v) { t[k] = v; return true; },
	});
	const src = names.map(function (n) { return liftFn(APP, n); }).join('\n')
		+ '\nreturn {' + names.map(function (n) { return n + ': ' + n; }).join(', ') + '};';
	return new Function('scope', 'with (scope) { return (function () {' + src + '})(); }')(scope);
}

/// A runner whose copy of the Diamond's record says glm runs a handed-off turn carrying `model`
/// through the real `runSteerDetached` -> `runSteer` -> `steerModelFor`. `diamondApp` records the
/// pair it is asked for and stops the turn there. Answers the pairs built and the turn's error.
async function runnerSteer(model) {
	const built = [], STOP = new Error('stop');
	const DaimondModels = { resolve: function (p, m) { return m && p !== 'nokey' ? { provider: p, model: m } : null; },
		effective: function () { return { provider: GLM.provider, model: GLM.model, from: 'own' }; } };
	const fns = lifted(['sentModelsOf', 'steerModelsFor', 'steerModelFor', 'steerTurnSet', 'copyTurnSet', 'turnModelsOfDiamond', 'runSteer', 'runSteerHeld', 'runSteerDetached'], {
		window: { DaimondModels: DaimondModels }, DaimondModels: DaimondModels,
		diamondModel: function () { return { provider: GLM.provider, model: GLM.model }; },
		// The set's daimon half is the pair `steerModelFor` resolved; the other halves are not asked about.
		turnModelsOfDiamond: function (id, d) { return { daimon: { provider: d.provider, model: d.model }, workers: {}, images: {} }; },
		diag: function () {},
		diamondBusy: function () { return false; },
		document: { getElementById: function () { return null; } },
		currentDiamond: null, centreMode: '',
		diamondEffort: function () { return ''; },
		storedEffort: function () { return null; },
		// The Diamond's daimon client (U3a: `daimonApp`, claimed for the turn and settled after it).
		daimonApp: function (id, pick) { built.push({ provider: pick && pick.provider, model: pick && pick.model }); throw STOP; },
		claimDaimon: function (app) { return app; }, daimonSettled: function () {},
		// The engine's TurnSpec (U4a, `engine::turn::resolve`, tested there): for an unmarked errand the
		// turn runs the model this device's record of the Diamond stores.
		turnSpecFor: function (f, preset, depth, detached, how) {
			var m = this.diamondModel(f.id);
			return { preset: '', depth: depth || '', instruction: preset || '', refused: '',
				model: { provider: m.provider, model: m.model } };
		},
	});
	let err = null;
	try { await fns.runSteerDetached(F, 'hi', { id: 'chat-lifelog', diamondId: F.id, messages: [] }, { turnId: 't9', model: model }); }
	catch (e) { err = e; }
	return { built: built, err: err === STOP ? null : (err ? { code: err.code, msg: String(err.message) } : null) };
}

// ── Arm 1: a Diamond chat's label always equals the Diamond's, on three devices ──────────
console.log('diamondmodel: arm 1 -- the label is the Diamond\'s on three devices');
(function () {
	const T0 = clock.t;
	const A = device('A', 0), B = device('B', 0), C = device('C', 0);
	[A, B, C].forEach(function (d) { d.setChats([d.hydrateChat(legacyRecord(GLM, T0))]); });
	A.setDiamondModel(F.id, GLM);
	syncAll([A, B, C]);
	clock.t += 10 * MIN;
	A.setDiamondModel(F.id, DSK);			// the owner moves Lifelog onto deepseek
	A.daimonChat(F); B.daimonChat(F);		// opened on A, and on B before the parcel lands
	syncAll([A, B, C]);
	labels([A, B, C]).forEach(function (l) {
		check(l.dev + ': the label names the Diamond\'s model', l.label === l.dia && l.dia === 'deepseek-v4.1-flash', l);
	});
	[A, B, C].forEach(function (d) {
		const wire = d.slimChat(d.chats()[0]);
		check(d.name + ': the daimon\'s record carries no model', !('model' in JSON.parse(JSON.stringify(wire)))
			&& !('provider' in JSON.parse(JSON.stringify(wire))), wire.model);
	});
})();

// ── Arm 2: a change made on B after seeing A's wins everywhere, whatever the clocks ─────
console.log('\ndiamondmodel: arm 2 -- B (5 min slow) after A (2 days fast) wins on all three');
(function () {
	clock.t += DAY;
	const T0 = clock.t;
	const A = device('A', 2 * DAY), B = device('B', -5 * MIN), C = device('C', 0);
	[A, B, C].forEach(function (d) { d.setChats([d.hydrateChat(legacyRecord(DSK, T0))]); });
	A.setDiamondModel(F.id, GLM);			// stamped two days ahead
	A.daimonChat(F);
	syncAll([A, B, C]);
	clock.t += MIN;
	B.setDiamondModel(F.id, DSK);			// made after seeing A's, on a clock behind
	B.daimonChat(F);
	syncAll([A, B, C]);
	check('B\'s write outranks A\'s stamp', B.diamondModels()[F.id].at > T0 + 2 * DAY, B.diamondModels()[F.id].at - T0);
	labels([A, B, C]).forEach(function (l) {
		check(l.dev + ': the Diamond and its label are B\'s model', l.dia === 'deepseek-v4.1-flash' && l.label === l.dia, l);
	});
})();

// ── Arm 3: the errand carries the resolved model, and the runner runs it ──────────────
console.log('\ndiamondmodel: arm 3 -- the errand carries the model the asker resolved');
await (async function () {
	const A = device('A', 0);
	A.setDiamondModel(F.id, DSK);
	const stale = legacyRecord(GLM, clock.t);	// a record still holding the stale copy in memory
	A.setChats([stale]);
	const er = A.errandForRecovery(stale, { iturn: 't1', itext: 'hi', ts: clock.t });
	check('errandForRecovery carries the Diamond\'s model', er.model && er.model.model === DSK.model, er.model);
	const ordinary = { id: 'c2', name: 'x', model: 'anthropic/claude', provider: 'anthropic', messages: [] };
	const eo = A.errandForRecovery(ordinary, { iturn: 't2', itext: 'hi' });
	check('an ordinary chat\'s errand carries its own model', eo.model && eo.model.model === 'anthropic/claude', eo.model);

	// The runner holds an older copy of the Diamond's record (glm); the errand says deepseek,
	// marked the asker's resolution. Each errand runs through the REAL `runSteerDetached` and
	// `runSteer`, against a stubbed `diamondApp` that records the pair the turn's app is built with.
	// A Diamond's keeps `src: 'diamond'`, which older runners honour; a chat's is `src: 'asker'`
	// (D-20261018-09 U1e, QA B #5; mmerrand.test.mjs).
	check('the errand marks a Diamond\'s pair the asker\'s resolution', er.model && er.model.src === 'diamond' && !!er.model.workers, er.model);
	check('an ordinary chat\'s pair is so marked too', eo.model && eo.model.src === 'asker', eo.model);
	const sent = await runnerSteer(er.model);
	check('the runner builds the turn\'s app on the sent model, not its own copy',
		sent.built.length === 1 && sent.built[0].model === DSK.model, sent);
	const old = await runnerSteer({ provider: GLM.provider, model: 'z-ai/glm-stale', url: '' });
	check('an unmarked (older asker\'s) pair runs the Diamond\'s own',
		old.built.length === 1 && old.built[0].model === GLM.model, old);
	const nokey = await runnerSteer({ provider: 'nokey', model: 'x/unrunnable', url: '', src: 'diamond' });
	check('a marked pair the runner cannot run is handed back 401, never run on its own copy',
		nokey.built.length === 0 && nokey.err && nokey.err.code === 401, nokey);
	check('daimonChat writes no model', !/rec\.model\s*=/.test(liftFn(APP, 'daimonChat')));

	// A daimon errand that beats its parcel: the runner builds the chat from the seed, and it is
	// the Diamond's, so `runTurn` services it through `steer_crystal` and not the chat engine.
	const own = { chats: [] };
	const g = lifted(['graftSeed'], own);
	try { await g.graftSeed({ chatId: 'chat-new', diamondId: F.id, seed: { msgs: [{ role: 'user', content: 'hi' }] } }); }
	catch (e) { /* only the record it built is under test */ }
	const seeded = own.chats.find(function (c) { return c.id === 'chat-new'; });
	check('graftSeed keeps the errand\'s Diamond on a never-synced chat', !!seeded && seeded.diamondId === F.id,
		seeded && seeded.diamondId);
})();

// ── Arm 4: the stale copy is shed on read and on write, logged once ──────────────────
console.log('\ndiamondmodel: arm 4 -- an old record\'s model is shed on read and write, logged once');
(function () {
	const A = device('A', 0);
	const h = A.hydrateChat(legacyRecord(GLM, clock.t));
	check('read: hydrateChat drops it', h.model === undefined && h.provider === undefined, { m: h.model, p: h.provider });
	const w = JSON.parse(JSON.stringify(A.slimChat(legacyRecord(GLM, clock.t))));
	check('write: slimChat drops it', !('model' in w) && !('provider' in w) && !('workerModel' in w), w);
	A.hydrateChat(legacyRecord(GLM, clock.t)); A.slimChat(legacyRecord(GLM, clock.t));
	check('the shed is logged once', A.logs.filter(function (l) { return /chat model shed/.test(l); }).length === 1, A.logs);
	const o = A.slimChat({ id: 'c3', model: 'anthropic/claude', provider: 'anthropic', messages: [] });
	check('an ordinary chat keeps its own model', o.model === 'anthropic/claude' && o.provider === 'anthropic', o);
})();

console.log('\n' + (checks - failures) + '/' + checks + ' passed');
process.exit(failures ? 1 : 0);
