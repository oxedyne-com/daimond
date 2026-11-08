/* ============================================================
   Test -- a kind of worker runs on its kind's model and effort
   (KINDS-1; ledger E2 + K7).
   ------------------------------------------------------------
   The engine hands `Workers.spawn` the kind a `spawn_agent` call
   named (its model, provider, effort and tools, from the kind's
   file under `.daimond/agents/`); the page runs the worker on that
   pair, asks for that effort, and narrows its belt to those tools.

     K1  a chat's workers are on A; a reviewer kind on B is asked
         for; it runs on B, at effort high, with its tools;
     K2  no kind: the worker runs on the chat's worker pick A, and
         its effort is the chat's where the chat is on that model;
     K3  a kind naming no model runs on the chat's pick A.

   The REAL page functions (`kindPick`, `workerEffort`,
   `chatWorkerModel`, `Workers.spawn` / `dispatch` ...), lifted on
   the harness of mmturnset.test.mjs. Red on the base:
     MM_SRC_REV=a866c3846 node www/js/kinds.test.mjs
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
	'copyTurnSet', 'sentModelsOf', 'steerModelsFor', 'kindPick', 'workerEffort'];
const METHODS = ['holdTurn', 'turnModelsFor', 'spawn', 'dispatch', 'routeFor', 'gather', 'isTerminal'];
// Optional: a revision before U1d2 has none of these, and is judged on what it does in their place.
const OPTIONAL = ['steerTurnSet', 'copyTurnSet', 'kindPick', 'workerEffort'];
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
	function workerKind() { return 'brief'; }
	function workerKindSaid() { return 'brief'; }
	function forkable() { return false; }
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
async function spawnRun(turn, name, task, kind) {
	const out = JSON.parse(await W.spawn(JSON.stringify({ turn: turn, name: name, task: task, kind: kind || null })));
	return out.started ? W.runs.find((r) => r.id === out.id) : { why: out.why };
}
const pair = (run) => run && run.model ? (run.provider || '') + '/' + run.model : 'not started: ' + (run && run.why);

async function main() {
	if (missing.length) console.log('  (this revision lacks: ' + missing.join(', ') + ')');
	M.init({});
	M.addProvider('openrouter', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey('openrouter', 'or-key');
	M.addProvider('fireworks', { url: 'https://api.fireworks.ai/inference/v1', name: 'Fireworks' });
	await M.setKey('fireworks', 'fw-key');
	const A = 'openrouter/or/model-a', B = 'fireworks/fw/model-b';
	M.setDefault('openrouter', 'or/model-a');
	const chat = { id: 'c1', name: 'Chat', model: 'or/model-a', provider: 'openrouter', effort: 'low', messages: [] };
	chats.push(chat);
	startChatTurn('t1', chat);
	const effort = (run) => page.workerEffort ? page.workerEffort(run, chat) : '(no workerEffort)';

	console.log('K1 a reviewer kind runs on its own model, effort and tools');
	const rev = await spawnRun('t1', 'rev', 'review the change',
		{ name: 'reviewer', provider: 'fireworks', model: 'fw/model-b', effort: 'high', tools: ['file_read', 'file_list'] });
	check('the reviewer runs on B', pair(rev) === B, pair(rev));
	check('at effort high', effort(rev) === 'high', effort(rev));
	check('with its tools', JSON.stringify(rev.kindTools || null) === '["file_read","file_list"]', JSON.stringify(rev.kindTools));
	check('and says which kind it is', rev.kind === 'reviewer', String(rev.kind));

	console.log('K2 no kind: the chat\'s worker pick, at the chat\'s effort');
	const plain = await spawnRun('t1', 'plain', 'read the code');
	check('an ordinary worker runs on A', pair(plain) === A, pair(plain));
	check('at the chat\'s effort', effort(plain) === 'low', effort(plain));

	console.log('K3 a kind naming no model runs on the chat\'s pick');
	const bare = await spawnRun('t1', 'bare', 'read the code', { name: 'builder', provider: '', model: '', effort: '', tools: null });
	check('on A', pair(bare) === A, pair(bare));

	console.log(checks + ' checks, ' + failures + ' failed');
	process.exitCode = failures ? 1 : 0;
}
main();
