/* ============================================================
   Test — a handed-off turn carries the asker's resolved set
   (D-20261018-09 U1e; Models spec §3, "A handed-off turn carries
   its resolved set").
   ------------------------------------------------------------
   The asker resolves { daimon, workers, images } and sends it on
   the errand, marked `src: 'asker'` for chats and `src: 'diamond'`
   for Diamonds (so older runners keep the daimon half, QA B #5);
   the runner runs that set, not its own.

     E1  a following chat (model ''), asker default A, runner
         default B: the runner's turn runs A;
     E2  the runner's workers for that turn run on the asker's
         Workers pick;
     E3  an older asker's errand (an unmarked pair, or a Diamond's
         `src: 'diamond'` primary) runs as before;
     E4  a marked set the runner cannot run is handed back 401
         (`runnerErrorKind`), never swapped for the runner's own;
     E5a that set, on a runner that HOLDS the provider row at the
         asker's stamp (HT3 `at`) but whose key is missing or failed,
         and an unmarked Diamond whose key the runner lacks, is
         refused by `peerReady` before the claim, at once: the real
         `DaimondPeer.runErrand` writes no lease, runs nothing, hands
         it back `undeliverable` (cause `models`) and acks, so the
         asker runs it here at once (D-20261018-09 PR). Its diag reads
         `ready MODELS` and never `handed back`, which only a post-claim
         401 logs, once (diag_preclaim_merge.md; red on 529df246);
     E5b that set, on a runner that never got the row (its sync
         stalled), is BEHIND the asker's horizon, not never (HT3,
         invariant 15): `peerReady` waits to the readiness deadline,
         then refuses it `models-behind`, which the asker still reads
         as a hand-back and runs here. Red on cfeb63029, which called
         it `models` at once.

   Two sandboxes (node:vm), each with its own storage and the REAL
   store.js, stamp.js and models.js; the REAL daimond.js functions
   (`errandModelOf`, `peerRunErrandDeps`, `steerModelFor`, the turn
   set and `Workers` methods, `peerReady`), lifted, and the REAL
   peer.js for E5. The runner's turn engine is a stub that records
   what `runTurn` is handed. Red proof:
     MM_SRC_REV=14ef947b node www/js/mmerrand.test.mjs
     MM_SRC_REV=a7b7b69a node www/js/mmerrand.test.mjs   (E5a)
     MM_SRC_REV=cfeb63029 node www/js/mmerrand.test.mjs  (E5b)
   ============================================================ */
import { source, liftFn } from './testlift.mjs';
import vm from 'node:vm';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const SRC   = source('daimond.js');
const STORE = source('store.js');
const STAMP = source('stamp.js');
const MODS  = source('models.js');

/// `name: function (...) { ... }` inside the `Workers` object literal; '' when absent.
function liftMethod(src, name) {
	const m = new RegExp('\\n\\t\\t' + name + ': function \\(').exec(src);
	if (!m) return '';
	const brace = src.indexOf('{', m.index);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(m.index + 1, i);
}

const FNS = ['readJson', 'diamondModels', 'diamondModel', 'modelPicksOf', 'diamondPicks', 'chatPicks',
	'summarisingPick', 'diamondWorkerModel', 'diamondVisionModel', 'turnModelOf', 'chatWorkerModel',
	'taskWantsVision', 'turnModelsOfDiamond', 'turnModelsOfChat', 'turnModelsOfRun', 'errandModelOf',
	'sentModelsOf', 'claimedModelsOf', 'steerModelsFor', 'steerModelFor', 'peerRunErrandDeps', 'diamondCanRun',
	'errandUnrunnable', 'modelsAt', 'peerReady', 'askerReadiness', 'lackedNote', 'runnerTurnOpts'];
const METHODS = ['holdTurn', 'turnModelsFor', 'spawn', 'dispatch', 'routeFor'];
const VARS = ['DIAMOND_MODELS_KEY', 'IMAGE_EXT'];
function liftVar(src, name) {
	const m = new RegExp('\\n\\t+var ' + name + '\\b').exec(src);
	if (!m) return '';
	return src.slice(m.index + 1, src.indexOf(';\n', m.index) + 1);
}
const have = FNS.filter((f) => liftFn(SRC, f));
const meth = METHODS.map((n) => [n, liftMethod(SRC, n)]).filter((x) => x[1]);
const missing = FNS.filter((f) => !have.includes(f)).concat(METHODS.filter((n) => !meth.find((x) => x[0] === n)));
const BODY = VARS.map((v) => liftVar(SRC, v)).join('\n') + '\n' + have.map((f) => liftFn(SRC, f)).join('\n');

/// One device: a vm realm with its own storage, models.js and the lifted functions. Every name
/// the lifted code reaches that is neither lifted, set in `own`, nor a realm global is a
/// permissive stub (any property, any call, never a thenable).
async function device(name, keys, def, jobs, seed, rows) {
	const store = new Map(Object.entries(seed || {}));
	const ctx = vm.createContext({
		console: console, crypto: globalThis.crypto, TextEncoder: TextEncoder, TextDecoder: TextDecoder,
		setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval, clearInterval: clearInterval,
		atob: atob, btoa: btoa,
		localStorage: {
			getItem:    (k) => (store.has(k) ? store.get(k) : null),
			setItem:    (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
		},
		document: { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' },
	});
	vm.runInContext('var window = globalThis; window.addEventListener = function () {}; window.dispatchEvent = function () { return true; };'
		+ 'var tombMap = {}; window.DaimondCore = { tombs: function () { return Object.assign({}, tombMap); },'
		+ ' tombstone: function (k, id, at) { tombMap[id] = at || Date.now(); },'
		+ ' mergeTombs: function () { return Object.assign({}, tombMap); } };', ctx);
	for (const s of [STORE, STAMP]) vm.runInContext('(function (window, localStorage) {' + s + '\n})(window, localStorage);', ctx);
	vm.runInContext('var DaimondStamp = window.DaimondStamp, DaimondStore = window.DaimondStore;', ctx);
	vm.runInContext(MODS, ctx);
	const M = ctx.DaimondModels;
	M.init({});
	for (const k of keys) {
		M.addProvider(k, { url: 'https://' + k + '.example/v1', name: k });
		await M.setKey(k, k + '-key');
	}
	// Rows held with no key: synced here, at or past the asker's stamp, and unopenable.
	for (const k of (rows || [])) M.addProvider(k, { url: 'https://' + k + '.example/v1', name: k });
	M.setDefault(def.provider, def.model);
	// A revision with no Jobs picks (14ef947b) has no Workers pick to send: its arms are red by name.
	for (const r in (jobs || {})) if (M.setJob) M.setJob(r, jobs[r].provider, jobs[r].model);
	if (jobs && !M.setJob) console.log('  (this revision\'s models.js lacks: setJob)');

	const U = new Proxy(function () {}, {
		get: (t, k) => (k === 'then' || k === Symbol.unscopables) ? undefined
			: k === Symbol.toPrimitive ? () => '' : U,
		apply: () => U,
		construct: () => U,
	});
	const diags = [], ran = [];
	const own = {
		diags: diags, ran: ran, cfg: { foldProvider: '', foldModel: '', spendCap: 1 }, chats: [], diamonds: [],
		DEFAULT_SPEND_CAP: 1, THROUGH_WAIT_MS: 0,
		diag: (a, b) => diags.push(a + ' ' + (b || '')),
		deviceId: () => name, priorSessionRun: () => null, revealAgents: () => {},
		friendlyError: (e) => String(e && e.message || e),
		governorClearsDispatch: () => ({ ok: true }),
		diamondCanRun: () => true,
		// The runner's turn engine: what it is handed is the whole of what is under test.
		runTurn: async (chat, text, opts) => { ran.push({ chat: chat, opts: opts || {} }); },
		runSteerDetached: async () => { ran.push({ steer: true }); },
	};
	const inner = vm.runInContext('globalThis', ctx);
	const scope = new Proxy(own, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in inner)),
		get: (t, k) => k === Symbol.unscopables ? undefined : (k in t ? t[k] : U),
		set: (t, k, v) => { t[k] = v; return true; },
	});
	const api = vm.runInContext('(function (scope) { with (scope) { return (function () {\n' + BODY + `
		var Workers = {
			liveTurns: {}, batches: {}, batchSeq: 0, seq: 0, runs: [], queue: [],
			persist: function () {}, render: function () {}, pump: function () {},
			` + meth.map((x) => x[1]).join(',\n') + `
		};
		var lifted = { ` + have.map((f) => f + ': ' + f).join(', ') + ` };
		function fn(n) { return lifted[n] || null; }
		return { Workers: Workers, fn: fn };
	})(); } })`, ctx)(scope);
	if (M.bindPicks && api.fn('diamondPicks')) {
		M.bindPicks({ diamond: api.fn('diamondPicks'), chat: api.fn('chatPicks'), summarising: api.fn('summarisingPick') });
	}
	return { name: name, M: M, own: own, api: api, fn: api.fn, W: api.Workers };
}

const pr = (p) => (p ? (p.provider || '') + '/' + (p.model || '') : '(none)');

/// What the runner's turn ran on, from what `runTurn` was handed: through `turnModelsOfRun` where
/// the revision has it, else as runTurn did then, the runner's own resolution of the chat.
function runnerSet(R, chat, opts) {
	const run = R.fn('turnModelsOfRun');
	if (run) return run(chat, opts.models);
	const ofChat = R.fn('turnModelsOfChat');
	if (ofChat) return ofChat(chat);
	const d = R.fn('turnModelOf')(chat);
	return { daimon: d, workers: R.fn('chatWorkerModel') ? R.fn('chatWorkerModel')(chat) : d };
}

/// One handed-off chat turn on runner R: the errand's model as it crossed the wire, through the
/// real `peerRunErrandDeps().runTurn`. Answers the set it ran on, or the error it handed back.
async function handOff(R, chat, sent) {
	R.own.ran.length = 0;
	const deps = R.fn('peerRunErrandDeps')({});
	try {
		await deps.runTurn({ chat: chat }, 'hi', { turnId: 't-' + chat.id, promptInTranscript: true,
			model: JSON.parse(JSON.stringify(sent)) });
	} catch (e) { return { err: e }; }
	const call = R.own.ran.find((r) => r.chat);
	return call ? { set: runnerSet(R, call.chat, call.opts), opts: call.opts } : { err: new Error('runTurn not reached') };
}

async function main() {
	if (missing.length) console.log('  (this revision lacks: ' + missing.join(', ') + ')');
	const A  = { provider: 'openrouter', model: 'or/model-a' };
	const B  = { provider: 'fireworks',  model: 'fw/model-b' };
	const WK = { provider: 'fireworks',  model: 'fw/worker-w' };
	const asker  = await device('asker',  ['openrouter', 'fireworks'], A, { workers: WK });
	const runner = await device('runner', ['openrouter', 'fireworks'], B);
	// No Fireworks key; Diamond dU thinks on Fireworks, dO on OpenRouter.
	const bare   = await device('bare',   ['openrouter'], A, null, { 'daimond-diamond-models':
		JSON.stringify({ dU: { provider: B.provider, model: B.model }, dO: { provider: A.provider, model: A.model } }) });
	bare.own.diamonds.push({ id: 'dU', name: 'Unkeyed' }, { id: 'dO', name: 'Keyed' });
	// The same, but it holds the Fireworks row (made after the asker's, so at or past its stamp)
	// with no key in it: the fact is here and can never run, which is `never`, not `behind`.
	const held   = await device('held',   ['openrouter'], A, null, { 'daimond-diamond-models':
		JSON.stringify({ dU: { provider: B.provider, model: B.model }, dO: { provider: A.provider, model: A.model } }) },
		['fireworks']);
	held.own.diamonds.push({ id: 'dU', name: 'Unkeyed' }, { id: 'dO', name: 'Keyed' });

	console.log('E1 a following chat handed off runs the asker\'s default, not the runner\'s');
	const chatA = { id: 'c1', name: 'Chat', model: '', provider: '', messages: [] };
	const sent = asker.fn('errandModelOf')(chatA);
	check('the errand is marked the asker\'s set', sent && sent.src === 'asker', JSON.stringify(sent));
	const chatR = { id: 'c1', name: 'Chat', model: '', provider: '', messages: [] };	// the runner's synced copy
	const h1 = await handOff(runner, chatR, sent);
	check('the runner\'s turn runs A', !h1.err && pr(h1.set.daimon) === pr(A), h1.err ? String(h1.err.message) : pr(h1.set.daimon));

	console.log('E2 the runner\'s workers for that turn run on the asker\'s Workers');
	check('the errand carries the asker\'s Workers', !!sent.workers && pr(sent.workers) === pr(WK), pr(sent.workers));
	if (!h1.err) {
		runner.W.holdTurn('t-c1', { chatId: chatR.id, chatName: chatR.name, depth: 0, models: h1.set });
		const out = JSON.parse(await runner.W.spawn(JSON.stringify({ turn: 't-c1', name: 'w1', task: 'read the code' })));
		const run = out.started ? runner.W.runs.find((r) => r.id === out.id) : null;
		check('a worker of the turn runs on the asker\'s Workers', !!run && pr(run) === pr(WK), run ? pr(run) : out.why);
	} else check('a worker of the turn runs on the asker\'s Workers', false, 'no turn');
	const steer = runner.fn('steerModelsFor');
	const dA = { id: 'dF', name: 'Diamond' };
	const dsent = asker.fn('errandModelOf')({ id: 'cd', diamondId: dA.id, messages: [] });
	// A Diamond's keeps the marker a 14ef947b runner honours (QA B #5), with the whole set beside it.
	check('a following Diamond\'s errand is the asker\'s set', dsent.src === 'diamond' && pr(dsent) === pr(A)
		&& pr(dsent.workers) === pr(WK), JSON.stringify(dsent));
	const dset = steer ? steer(dA.id, { model: JSON.parse(JSON.stringify(dsent)) }) : null;
	check('the runner\'s Diamond turn runs the asker\'s daimon and Workers',
		!!dset && pr(dset.daimon) === pr(A) && pr(dset.workers) === pr(WK), dset ? pr(dset.daimon) + ' ' + pr(dset.workers) : 'steerModelsFor missing');

	console.log('E3 an older asker\'s errand runs as it did');
	// A chat pinned to B on the runner's copy, so its own resolution is B under every revision.
	const pinned = { id: 'c3', name: 'Pinned', model: B.model, provider: B.provider, messages: [] };
	const h3 = await handOff(runner, pinned, { provider: 'openrouter', model: 'or/stale', url: '' });
	check('an unmarked chat pair runs the runner\'s own resolution (B), not the sent one', !h3.err && pr(h3.set.daimon) === pr(B),
		h3.err ? String(h3.err.message) : pr(h3.set.daimon));
	const old = runner.fn('steerModelFor')(dA.id, { model: { provider: A.provider, model: A.model, url: '', src: 'diamond' } });
	check('a Diamond\'s `src: diamond` primary still runs', pr(old) === pr(A), pr(old));
	const oldU = runner.fn('steerModelFor')(dA.id, { model: { provider: 'openrouter', model: 'or/stale', url: '' } });
	check('an unmarked Diamond pair runs the Diamond\'s own (B)', pr(oldU) === pr(B), pr(oldU));

	console.log('E4 a marked set the runner cannot run is handed back 401');
	const HB = / unrunnable here, handed back/;
	const handedBack = (R) => R.own.diags.filter((l) => HB.test(l)).length;
	bare.own.diags.length = 0;
	const fwChat = { id: 'c2', name: 'Fw', model: B.model, provider: B.provider, messages: [] };
	const fwSent = asker.fn('errandModelOf')(fwChat);
	const h4 = await handOff(bare, { id: 'c2', name: 'Fw', model: '', provider: '', messages: [] }, fwSent);
	check('a chat on a provider the runner has no key for: 401, not run', !!h4.err && h4.err.code === 401 && bare.own.ran.length === 0,
		h4.err ? 'code ' + h4.err.code : 'ran on ' + pr(h4.set && h4.set.daimon));
	const h4w = await handOff(bare, { id: 'c1', name: 'Chat', model: '', provider: '', messages: [] }, sent);
	check('a runnable daimon with unrunnable Workers: 401, not run', !!h4w.err && h4w.err.code === 401 && bare.own.ran.length === 0,
		h4w.err ? 'code ' + h4w.err.code : 'ran, workers ' + pr(h4w.set && h4w.set.workers));
	check('E5 each post-claim chat 401 logs one hand-back line', handedBack(bare) === 2, bare.own.diags);
	bare.own.ran.length = 0;
	bare.own.diags.length = 0;
	let dErr = null;
	try { await bare.fn('peerRunErrandDeps')({}).runTurn({ chat: { id: 'cd', diamondId: dA.id, messages: [] } }, 'hi',
		{ turnId: 't-d', model: JSON.parse(JSON.stringify(dsent)) }); }
	catch (e) { dErr = e; }
	check('a Diamond turn with unrunnable Workers: 401, not steered', !!dErr && dErr.code === 401 && bare.own.ran.length === 0,
		dErr ? 'code ' + dErr.code : 'steered');
	check('E5 the post-claim Diamond 401 logs exactly one hand-back line', handedBack(bare) === 1, bare.own.diags);

	console.log('E5a a set the runner holds at the stamp and cannot run is refused before the claim, at once');
	const stale = { provider: 'openrouter', model: 'or/stale', url: '' };	// an unmarked pair
	const unrun = [
		['an unrunnable daimon',                 { chatId: 'c2', model: fwSent }],
		['unrunnable Workers',                   { chatId: 'c1', model: sent }],
		['a Diamond with unrunnable Workers',    { chatId: 'cd', diamondId: dA.id, model: dsent }],
		['an unmarked Diamond with no key here', { chatId: 'cu', diamondId: 'dU', model: stale }],
	];
	const ready = (R, f) => R.fn('peerRunErrandDeps')({}).ready(Object.assign({ turnId: 't-' + f.chatId, through: null },
		JSON.parse(JSON.stringify(f))), []);
	const fwAt = sent && sent.at ? sent.at.fireworks : undefined;
	check('E5a the errand names the asker\'s Fireworks stamp, and the runner holds the row at or past it',
		typeof fwAt === 'number' && held.M.stampAt && held.M.stampAt('fireworks') >= fwAt,
		'at ' + fwAt + ', held ' + (held.M.stampAt ? held.M.stampAt('fireworks') : '(no stampAt)'));
	for (const [what, f] of unrun) {
		held.own.diags.length = 0;
		const rd = await ready(held, f);
		check('E5a ready refuses ' + what + ' with cause models', !!rd && rd.ok === false && rd.cause === 'models', JSON.stringify(rd));
		check('E5a its diag reads ready MODELS, never a hand-back', held.own.diags.some((l) => /^ready MODELS /.test(l))
			&& handedBack(held) === 0, held.own.diags);
	}
	// A failed seal at or past the stamp is the other `never`: judged by the same pure rule.
	const jF = held.M.judgeAt ? held.M.judgeAt({ fireworks: 100 }, { fireworks: { touched: 100, tomb: 0, keyed: true, key: 'failed' } }) : null;
	check('E5a a held row whose seal failed here is never', !!jF && jF.verdict === 'never', JSON.stringify(jF));

	console.log('E5b a set whose row the runner never got (sync stalled) is behind: models-behind at the deadline');
	const WAIT = 300;
	for (const [what, f] of unrun.slice(0, 3)) {
		bare.own.diags.length = 0;
		const t0 = Date.now();
		const rd = await bare.fn('peerReady')(Object.assign({ turnId: 't-' + f.chatId, through: null }, JSON.parse(JSON.stringify(f))), [], WAIT);
		const took = Date.now() - t0;
		check('E5b ready refuses ' + what + ' with cause models-behind, at the deadline',
			!!rd && rd.ok === false && rd.cause === 'models-behind' && took >= WAIT - 20,
			JSON.stringify(rd) + ' after ' + took + 'ms');
		check('E5b its diag reads ready MODELS-BEHIND, never MODELS or a hand-back',
			bare.own.diags.some((l) => /^ready MODELS-BEHIND /.test(l)) && !bare.own.diags.some((l) => /^ready MODELS /.test(l))
			&& handedBack(bare) === 0, bare.own.diags);
	}
	const okChat = await ready(runner, { chatId: 'c1', model: sent });
	const okDia  = await ready(bare, { chatId: 'co', diamondId: 'dO', model: stale });
	check('ready still answers ok for a set the runner can run', !!okChat && okChat.ok === true && !!okDia && okDia.ok === true,
		JSON.stringify([okChat, okDia]));

	// The real peer.js: the refusal through `runErrand` to the asker's own reading of the report.
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	const quiet = { debug() {}, log() {}, warn() {}, error() {} };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + source(rel) + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
	const P = win.DaimondPeer;
	/// The real `runErrand` on runner R, refusing before the claim with `cause`.
	async function throughPeer(tag, R, cause) {
		const NOW = Date.now(), TID = 't-' + tag;
		const leases = { version: 1, map: {} };
		const cas = {
			read:  async () => ({ version: leases.version, leases: JSON.parse(JSON.stringify(leases.map)) }),
			write: async (base, next) => {
				if (base !== leases.version) return { ok: false, version: leases.version };
				leases.version++; leases.map = JSON.parse(JSON.stringify(next)); return { ok: true, version: leases.version };
			},
		};
		let ran = 0, acked = 0;
		const reports = [];
		const errand = P.makeErrand({ turnId: TID, chatId: 'c1', eid: 'e-' + TID, ts: NOW, deadline: NOW + 15 * 60000,
			dispatchedBy: 'DESK', to: 'PEER', prompt: 'hi', model: JSON.parse(JSON.stringify(sent)),
			seed: { chatId: 'c1', title: '', provider: '', model: '', msgs: [{ role: 'user', content: 'hi', mid: TID, ts: NOW }] } });
		const rDeps = R.fn('peerRunErrandDeps')({});
		const res = await P.runErrand(errand, {
			selfId: 'PEER', cas: cas, presence: {}, finished: async () => false, busyFor: () => 0, ownTurns: () => [],
			ready: rDeps.ready,
			reconstruct: async () => ({ chat: { id: 'c1', messages: [] }, app: null }),
			// What the run dep does when it is reached with this set: `sentModelsOf`'s 401.
			runTurn: async () => { ran++; const e = new Error('the turn’s workers model has no usable api key on this device'); e.code = 401; throw e; },
			abort: () => {}, pushResult: async () => 1,
			post: async (r) => { reports.push(r); }, ack: async () => { acked++; },
			setTimer: (fn) => setInterval(fn, 20), clearTimer: (h) => clearInterval(h),
		});
		const lease = leases.map[TID] || null;
		const rep = reports[reports.length - 1] || null;
		check(tag + ' no lease is written and nothing runs', !lease && ran === 0,
			'lease ' + (lease ? lease.mode + ' by ' + lease.holder : 'none') + ', runTurn ' + ran + ', trace ' + (res.trace || []).join(' '));
		check(tag + ' one undeliverable report with cause ' + cause, reports.length === 1 && rep.status === 'undeliverable' && rep.cause === cause,
			JSON.stringify(rep && { status: rep.status, cause: rep.cause, why: rep.why }));
		check(tag + ' the errand is acked once', acked === 1, 'acks ' + acked);
		const ph = { why: P.REASON_DISPATCHED, dispatchedBy: 'DESK', iturn: TID, mid: 'ph-' + TID, ts: NOW, deadline: NOW + 15 * 60000, itext: 'hi' };
		check(tag + ' the asker reads it as a hand-back and runs it here', P.handBackReport(rep) === true
			&& P.uiState(ph, lease, rep, 'DESK', Date.now()) === 'claimed' && P.recoverDecision(ph, lease, false, 'DESK', Date.now()) === true,
			'handBack ' + P.handBackReport(rep) + ', tile ' + P.uiState(ph, lease, rep, 'DESK', Date.now()));
	}
	await throughPeer('E5a', held, 'models');
	await throughPeer('E5b', bare, 'models-behind');

	console.log((failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks + ' checks');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL — threw: ' + (e && e.stack || e)); process.exit(1); });
