/* ============================================================
   Test — a turn resolves its models once, at its start
   (D-20261018-09 U1d; Models spec §3, "A turn keeps the models
   it started with").
   ------------------------------------------------------------
   A turn resolves { daimon, workers, images } once, where it
   begins, and holds the set on its run state (`Workers.holdTurn`
   owner `models`); every fan-out round of that turn dispatches on
   it. A change of default made during the turn applies from the
   next turn, for Diamonds and chats alike.

     D1  a following Diamond's turn starts on A; the default moves
         to B during round 1; round 2's workers (text and image)
         are dispatched on A; the next turn is on B;
     D3  the same for a following chat;
     D4  a Diamond fan-out starts on A; the default moves to B while
         its workers run; the gather round (`Workers.gather` ->
         `runSteer`) runs on A (U1d2);
     D5  a dispatch with no turn set resolves at dispatch and says
         so in one `diag` line;
     D6  a runner's turn on the asker's sent set (daimon A, Workers
         C): its start (`steerTurnSet` with no held set, as `runSteer`
         at depth 0) keeps the sent Workers, its worker runs on C,
         and its gather round runs on A with Workers C.

   The REAL models.js and the REAL daimond.js functions and
   `Workers` methods (`holdTurn`, `spawn`, `dispatch`, `routeFor`,
   `turnModelsFor`, `gather`), lifted; the runner (`pump`) is a stub
   that starts nothing, and `runSteer` a stub that records the set
   its round resolves (`steerTurnSet`, or on a revision without it
   the two calls `runSteer` made in its place). Red proof on the
   live record: D1-D3, D5, D6 at 14ef947b; D4 at 7629fb9d:
     MM_SRC_REV=7629fb9d node www/js/mmturnset.test.mjs
   ============================================================ */
import { source, lift } from './testlift.mjs';
import { loadStore } from './storefixture.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const store = new Map();
const localStorage = {
	getItem:    (k) => (store.has(k) ? store.get(k) : null),
	setItem:    (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
const win = globalThis;
win.dispatchEvent = () => true;
const documentShim = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
function loadScript(body) {
	const fn = new Function('window', 'document', 'localStorage', 'console', 'globalThis', body);
	fn(win, documentShim, localStorage, console, globalThis);
}

loadStore(win, localStorage);
const tombMap = {};
win.DaimondCore = {
	tombs:      () => Object.assign({}, tombMap),
	tombstone:  (k, id, at) => { tombMap[id] = at || Date.now(); },
	mergeTombs: (k, inc) => { for (const id in (inc || {})) if (!tombMap[id] || inc[id] > tombMap[id]) tombMap[id] = inc[id]; return Object.assign({}, tombMap); },
};
loadScript(source('stamp.js'));
globalThis.DaimondStamp = win.DaimondStamp;
loadScript(source('models.js'));
const M = win.DaimondModels;

/// `name: function (...) { ... },` inside the `Workers` object literal; '' when absent.
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

const SRC = source('daimond.js');
const FNS = ['readJson', 'diamondModels', 'diamondModel', 'modelPicksOf', 'diamondPicks', 'chatPicks',
	'summarisingPick', 'diamondWorkerModel', 'diamondVisionModel', 'turnModelOf', 'chatWorkerModel',
	'taskWantsVision', 'turnModelsOfDiamond', 'turnModelsOfChat', 'steerModelFor', 'steerTurnSet',
	'copyTurnSet', 'sentModelsOf', 'steerModelsFor'];
const METHODS = ['holdTurn', 'turnModelsFor', 'spawn', 'dispatch', 'routeFor', 'gather', 'isTerminal'];
// Optional: a revision before U1d2 has none of these, and is judged on what it does in their place.
const OPTIONAL = ['steerTurnSet', 'copyTurnSet'];
const L = lift(SRC, FNS, ['DIAMOND_MODELS_KEY', 'IMAGE_EXT']);
const meth = METHODS.map((n) => [n, liftMethod(SRC, n)]);
const missing = L.missing.filter((n) => !OPTIONAL.includes(n)).concat(meth.filter((x) => !x[1]).map((x) => x[0]));

const diags = [];
const cfg = { foldProvider: '', foldModel: '', spendCap: 1 };
const chats = [];
const diamonds = [{ id: 'dF', name: 'dF' }];
const rounds = [];	// the set each gather round resolved: { depth, daimon }
const page = new Function('window', 'localStorage', 'cfg', 'DaimondModels', 'chats', 'diags', 'diamonds', 'rounds', L.body + `
	function diag(a, b) { diags.push(a + ' ' + (b || '')); }
	// What runSteer resolves at its head, and nothing else.
	function runSteer(f, preset, depth, detached, how, held) {
		var set = typeof steerTurnSet === 'function' ? steerTurnSet(f.id, detached, held)
			: turnModelsOfDiamond(f.id, steerModelFor(f.id, detached));
		rounds.push({ depth: depth, daimon: set.daimon.provider + '/' + set.daimon.model,
			workers: set.workers.provider + '/' + set.workers.model });
		return Promise.resolve('');
	}
	function workerEndingNote() { return ''; }
	function reportBody(r) { return 'found ' + r.name; }
	function reportHasSubstance() { return true; }
	function withCommas(x) { return x; }
	function workersHeld() { return false; }
	function diamondBusy() { return false; }
	function diamondCanRun() { return true; }
	function setCrystalStatus() {}
	var FOLLOW_MAX_MS = 1000, _lastSteer = {};
	function revealAgents() {}
	function priorSessionRun() { return null; }
	function deviceId() { return 'dev1'; }
	function friendlyError(e) { return String(e && e.message || e); }
	function governorClearsDispatch() { return { ok: true }; }
	var DEFAULT_SPEND_CAP = 1;
	var Workers = {
		liveTurns: {}, batches: {}, batchSeq: 0, seq: 0, runs: [], queue: [], MAX_GATHER_DEPTH: 3,
		tellDaimon: function () {},
		persist: function () {}, render: function () {}, pump: function () {},
		` + meth.filter((x) => x[1]).map((x) => x[1]).join(',\n') + `
	};
	return { Workers: Workers, ` + FNS.map((f) => f + ': typeof ' + f + ' === "function" ? ' + f + ' : null').join(', ') + '};')(
	win, localStorage, cfg, M, chats, diags, diamonds, rounds);
if (M.bindPicks && page.diamondPicks) {
	M.bindPicks({ diamond: page.diamondPicks, chat: page.chatPicks, summarising: page.summarisingPick });
}
const W = page.Workers;

/// What the turn's run state is given at its start: the owner `runSteer` / `runTurn` holds.
/// A revision with no set holds the owner as it always did, so its dispatch re-resolves.
function startDiamondTurn(turn, id) {
	const owner = { diamondId: id, diamondName: id, depth: 0, how: null };
	if (page.turnModelsOfDiamond) owner.models = page.turnModelsOfDiamond(id, page.diamondModel(id));
	W.holdTurn(turn, owner);
}
function startChatTurn(turn, chat) {
	const owner = { chatId: chat.id, chatName: chat.name, depth: 0 };
	if (page.turnModelsOfChat) owner.models = page.turnModelsOfChat(chat);
	W.holdTurn(turn, owner);
}
async function spawn(turn, name, task) {
	const out = JSON.parse(await W.spawn(JSON.stringify({ turn: turn, name: name, task: task })));
	const run = out.started ? W.runs.find((r) => r.id === out.id) : null;
	return run ? (run.provider || '') + '/' + run.model : 'not started: ' + out.why;
}

async function main() {
	if (missing.length) console.log('  (this revision lacks: ' + missing.join(', ') + ')');
	M.init({});
	M.addProvider('openrouter', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey('openrouter', 'or-key');
	M.addProvider('fireworks', { url: 'https://api.fireworks.ai/inference/v1', name: 'Fireworks' });
	await M.setKey('fireworks', 'fw-key');
	const A = 'openrouter/or/model-a', B = 'fireworks/fw/model-b';

	console.log('D1 a following Diamond: a default moved mid-turn leaves the turn on A');
	M.setDefault('openrouter', 'or/model-a');
	startDiamondTurn('t1', 'dF');
	const r1 = await spawn('t1', 'r1', 'read the code');
	check('round 1 worker on A', r1 === A, r1);
	M.setDefault('fireworks', 'fw/model-b');		// the default moves while the turn runs
	const r2 = await spawn('t1', 'r2', 'summarise the findings');
	check('round 2 worker still on A', r2 === A, r2);
	const r2i = await spawn('t1', 'r2i', 'describe shot.png');
	check('round 2 image worker still on A', r2i === A, r2i);
	if (W.turnModelsFor) {
		const tm = W.turnModelsFor('dF');
		check('turnModelsFor names the turn\'s daimon A', !!tm && (tm.daimon.provider + '/' + tm.daimon.model) === A);
	} else check('Workers.turnModelsFor exists', false, 'missing');
	W.liveTurns = {};
	startDiamondTurn('t2', 'dF');
	const n1 = await spawn('t2', 'n1', 'read the code');
	check('the next turn\'s worker on B', n1 === B, n1);

	console.log('D3 a following chat: a default moved mid-turn leaves the turn on A');
	M.setDefault('openrouter', 'or/model-a');
	const chat = { id: 'c1', name: 'Chat', model: '', provider: '', messages: [] };
	chats.push(chat);
	startChatTurn('c-t1', chat);
	const c1 = await spawn('c-t1', 'c1', 'read the code');
	check('round 1 worker on A', c1 === A, c1);
	M.setDefault('fireworks', 'fw/model-b');
	const c2 = await spawn('c-t1', 'c2', 'summarise the findings');
	check('round 2 worker still on A', c2 === A, c2);
	check('the chat record still follows (stores no model)', chat.model === '' && chat.provider === '');
	W.liveTurns = {};
	startChatTurn('c-t2', chat);
	const c3 = await spawn('c-t2', 'c3', 'read the code');
	check('the next turn\'s worker on B', c3 === B, c3);

	console.log('D4 a Diamond fan-out: a default moved while its workers run leaves the gather round on A');
	M.setDefault('openrouter', 'or/model-a');
	W.liveTurns = {};
	startDiamondTurn('g1', 'dF');
	const g1 = await spawn('g1', 'g1', 'read the code');
	check('the fan-out\'s worker on A', g1 === A, g1);
	delete W.liveTurns.g1;			// the turn ends; its workers run on
	const gb = Object.keys(W.batches).find((k) => W.batches[k].turnId === 'g1');
	M.setDefault('fireworks', 'fw/model-b');	// the default moves during the fan-out
	W.runs.filter((r) => r.batch === gb).forEach((r) => { r.status = 'done'; });
	rounds.length = 0;
	W.gather(gb);
	await new Promise((res) => setTimeout(res, 20));
	check('one gather round ran', rounds.length === 1, JSON.stringify(rounds));
	check('the gather round\'s daimon on A', !!rounds[0] && rounds[0].daimon === A, rounds[0] && rounds[0].daimon);
	check('the gather round\'s workers on A', !!rounds[0] && rounds[0].workers === A, rounds[0] && rounds[0].workers);

	console.log('D5 a dispatch with no turn set resolves at dispatch and says so');
	diags.length = 0;
	const ids = W.dispatch('dF', 'dF', [{ name: 'loose', task: 'read' }], false, null, 0, undefined);
	const loose = W.runs.find((r) => r.id === ids[0]);
	check('resolved now, on B', !!loose && (loose.provider + '/' + loose.model) === B, loose && loose.model);
	check('one diag line names it', diags.filter((d) => /no turn set/.test(d)).length === 1, diags.join(' | '));

	console.log('D6 a runner\'s turn on the asker\'s sent set keeps the sent Workers through its gather round');
	M.setDefault('fireworks', 'fw/model-b');
	const C = 'fireworks/fw/model-c';
	const detached = { model: { src: 'asker', provider: 'openrouter', model: 'or/model-a', url: '',
		workers: { provider: 'fireworks', model: 'fw/model-c', chosen: true },
		images:  { provider: 'fireworks', model: 'fw/model-c', chosen: false } } };
	let start = null;
	try { start = page.steerTurnSet ? page.steerTurnSet('dF', detached) : null; }
	catch (e) { start = null; console.log('  (steerTurnSet threw: ' + (e && e.message) + ')'); }
	const half = (p) => (p ? p.provider + '/' + p.model : 'none');
	check('the start\'s daimon is the sent A', !!start && half(start.daimon) === A, start && half(start.daimon));
	check('the start\'s Workers are the sent C', !!start && half(start.workers) === C, start && half(start.workers));
	W.liveTurns = {};
	W.holdTurn('s1', { diamondId: 'dF', diamondName: 'dF', depth: 0, how: null, models: start || undefined });
	const s1 = await spawn('s1', 's1', 'read the code');
	check('the runner\'s worker on C', s1 === C, s1);
	delete W.liveTurns.s1;
	const sb = Object.keys(W.batches).find((k) => W.batches[k].turnId === 's1');
	W.runs.filter((r) => r.batch === sb).forEach((r) => { r.status = 'done'; });
	rounds.length = 0;
	if (sb) W.gather(sb);
	await new Promise((res) => setTimeout(res, 20));
	check('the gather round\'s daimon on A', !!rounds[0] && rounds[0].daimon === A, rounds[0] && rounds[0].daimon);
	check('the gather round\'s Workers on C', !!rounds[0] && rounds[0].workers === C, rounds[0] && rounds[0].workers);

	console.log((failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks + ' checks');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL — threw: ' + (e && e.stack || e)); process.exit(1); });
