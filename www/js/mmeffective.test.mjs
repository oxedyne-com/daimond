/* ============================================================
   Test — one resolver, DaimondModels.effective(target, role)
   (D-20261018-09 U1b; spec §3, "One resolver, one chain").
   ------------------------------------------------------------
   The chain, per role: the target's own pick, then the global
   Jobs pick, then the target's daimon (or chat) model, then the
   default. Images stops at the global Images pick and otherwise
   runs where the workers do. A pick that cannot run here falls
   to the next link. Summarising rides the conversation's key.

     B1  the chain per role, with `from`;
     B3  a global Workers pick reaches a Diamond without its own,
         and not one with its own;
     B4  an unrunnable pick falls through;
     B5  Summarising on another provider answers '';
     B6  the Jobs picks travel: exportSync / applySync, newer
         wins, a tombstoned provider clears;
     B7  a chat's own Workers pick is what its workers run on.

   The REAL models.js and the REAL daimond.js functions (lifted by
   testlift.mjs). Red proof on the live record:
     MM_SRC_REV=14ef947b node www/js/mmeffective.test.mjs
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

// The page's side: the real resolvers and the reader daimond.js binds, over this storage.
const FNS = ['readJson', 'diamondModels', 'diamondModel', 'modelPicksOf', 'diamondPicks', 'chatPicks',
	'summarisingPick', 'diamondWorkerModel', 'diamondVisionModel', 'turnModelOf', 'chatWorkerModel'];
const L = lift(source('daimond.js'), FNS, ['DIAMOND_MODELS_KEY']);
const cfg = { foldProvider: '', foldModel: '' };
const page = new Function('window', 'localStorage', 'cfg', 'DaimondModels', L.body + '\nreturn {'
	+ FNS.map((f) => f + ': typeof ' + f + ' === "function" ? ' + f + ' : null').join(', ') + '};')(
	win, localStorage, cfg, M);
if (M.bindPicks && page.diamondPicks) {
	M.bindPicks({ diamond: page.diamondPicks, chat: page.chatPicks, summarising: page.summarisingPick });
}

function has(names) {
	const gone = names.filter((n) => typeof M[n] !== 'function');
	if (gone.length) check('DaimondModels has ' + names.join(', '), false, 'missing: ' + gone.join(', '));
	return gone.length === 0;
}
const pair = (e) => (e ? (e.provider || '') + '/' + (e.model || '') + (e.from ? ' <' + e.from + '>' : '') : String(e));
const D = (id) => ({ kind: 'diamond', id: id });
function records(all) { localStorage.setItem('daimond-diamond-models', JSON.stringify(all)); }

async function main() {
	if (L.missing.length) console.log('  (this revision lacks: ' + L.missing.join(', ') + ')');
	M.init({});
	M.addProvider('openrouter', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey('openrouter', 'or-key');
	M.addProvider('fireworks', { url: 'https://api.fireworks.ai/inference/v1', name: 'Fireworks' });
	await M.setKey('fireworks', 'fw-key');
	M.addProvider('slow', { url: 'https://slow.example/v1', name: 'Slow' });	// no key: cannot run here
	M.setDefault('openrouter', 'or/default');
	records({
		d1: { provider: 'fireworks', model: 'fw/daimon', workerProvider: 'fireworks', workerModel: 'fw/worker',
			visionProvider: 'openrouter', visionModel: 'or/vision', at: 1 },
		d3: { provider: 'fireworks', model: 'fw/daimon', at: 1 },
		d4: { provider: 'fireworks', model: 'fw/daimon', workerProvider: 'slow', workerModel: 'slow/worker',
			visionProvider: 'slow', visionModel: 'slow/vision', at: 1 },
	});

	const first = M.exportSync();	// before any Jobs pick is made (B6)

	console.log('B1 the chain per role, with `from`');
	if (has(['effective', 'getJob', 'setJob', 'bindPicks'])) {
		const E = M.effective;
		check('own daimon', pair(E(D('d1'), 'daimon')) === 'fireworks/fw/daimon <own>', pair(E(D('d1'), 'daimon')));
		check('own workers', pair(E(D('d1'), 'workers')) === 'fireworks/fw/worker <own>');
		check('own images', pair(E(D('d1'), 'images')) === 'openrouter/or/vision <own>');
		check('no record: daimon is the default', pair(E(D('d2'), 'daimon')) === 'openrouter/or/default <default>');
		check('no pick: workers follow the daimon', pair(E(D('d3'), 'workers')) === 'fireworks/fw/daimon <daimon>',
			pair(E(D('d3'), 'workers')));
		check('no pick: images follow the daimon', pair(E(D('d3'), 'images')) === 'fireworks/fw/daimon <daimon>');
		check('no pick: drafting follows the daimon', pair(E(D('d3'), 'drafting')) === 'fireworks/fw/daimon <daimon>');
		check('no target: workers on the default', pair(E(null, 'workers')) === 'openrouter/or/default <default>');
		check('no target: drafting on the default', pair(E(null, 'drafting')) === 'openrouter/or/default <default>');
		M.setJob('workers', 'openrouter', 'or/jobworker');
		check('Jobs workers beat the daimon', pair(E(D('d3'), 'workers')) === 'openrouter/or/jobworker <jobs>');
		check('own workers beat Jobs', pair(E(D('d1'), 'workers')) === 'fireworks/fw/worker <own>');
		check('images without a pick run where the workers do',
			pair(E(D('d3'), 'images')) === 'openrouter/or/jobworker <workers>', pair(E(D('d3'), 'images')));
		M.setJob('images', 'fireworks', 'fw/jobvision');
		check('Jobs images beat the workers', pair(E(D('d3'), 'images')) === 'fireworks/fw/jobvision <jobs>');
		check('own images beat Jobs', pair(E(D('d1'), 'images')) === 'openrouter/or/vision <own>');
		M.setJob('drafting', 'fireworks', 'fw/draft');
		check('Jobs drafting beats the daimon', pair(E(D('d3'), 'drafting')) === 'fireworks/fw/draft <jobs>');
		check('resolveDraft answers the Jobs drafting pick', (M.resolveDraft() || {}).model === 'fw/draft');
		check('a Jobs pick does not touch the daimon', pair(E(D('d3'), 'daimon')) === 'fireworks/fw/daimon <own>');
		M.setJob('workers', '', ''); M.setJob('images', '', ''); M.setJob('drafting', '', '');
		check('cleared Jobs picks fall back to the daimon', pair(E(D('d3'), 'workers')) === 'fireworks/fw/daimon <daimon>'
			&& pair(E(D('d3'), 'images')) === 'fireworks/fw/daimon <daimon>');
	}

	console.log('B3 a global Workers pick reaches a Diamond without its own, and not one with its own');
	if (has(['setJob'])) {
		M.setJob('workers', 'openrouter', 'or/jobworker');
		const w3 = page.diamondWorkerModel('d3'), w1 = page.diamondWorkerModel('d1');
		check('diamondWorkerModel(d3) is the Jobs pick', w3.model === 'or/jobworker' && w3.provider === 'openrouter', pair(w3));
		check('diamondWorkerModel(d1) keeps its own', w1.model === 'fw/worker', pair(w1));
		check('diamondVisionModel(d3) follows the workers', page.diamondVisionModel('d3').model === 'or/jobworker');
		M.setJob('workers', '', '');
	}

	console.log('B4 an unrunnable pick falls through');
	if (has(['effective', 'setJob'])) {
		check('own workers on a keyless provider fall to the daimon', pair(M.effective(D('d4'), 'workers')) === 'fireworks/fw/daimon <daimon>',
			pair(M.effective(D('d4'), 'workers')));
		M.setJob('workers', 'slow', 'slow/jobworker');
		check('and past an unrunnable Jobs pick too', pair(M.effective(D('d4'), 'workers')) === 'fireworks/fw/daimon <daimon>');
		M.setJob('workers', 'openrouter', 'or/jobworker');
		check('to a runnable Jobs pick when there is one', pair(M.effective(D('d4'), 'workers')) === 'openrouter/or/jobworker <jobs>');
		check('own images on a keyless provider fall to the workers', pair(M.effective(D('d4'), 'images')) === 'openrouter/or/jobworker <workers>',
			pair(M.effective(D('d4'), 'images')));
		M.setJob('drafting', 'slow', 'slow/draft');
		check('an unrunnable drafting pick falls to the default', (M.resolveDraft() || {}).model === 'or/default');
		M.setJob('workers', '', ''); M.setJob('drafting', '', '');
	}

	console.log('B5 Summarising rides the conversation\'s own key');
	if (has(['effective'])) {
		cfg.foldProvider = 'fireworks'; cfg.foldModel = 'fw/fold';
		check('a pick on the running provider is used', M.effective({ kind: 'run', provider: 'fireworks' }, 'summarising').model === 'fw/fold');
		const off = M.effective({ kind: 'run', provider: 'openrouter' }, 'summarising');
		check('a pick on another provider answers \'\'', off.model === '' && off.provider === 'openrouter', pair(off));
		check('a Diamond on the pick\'s provider gets it', M.effective(D('d1'), 'summarising').model === 'fw/fold');
		check('a Diamond on another provider gets \'\'', M.effective(D('d2'), 'summarising').model === '');
		cfg.foldProvider = ''; cfg.foldModel = '';
		check('no pick: \'\'', M.effective({ kind: 'run', provider: 'fireworks' }, 'summarising').model === '');
	}

	console.log('B7 a chat with its own Workers pick dispatches workers on it');
	const chat = { id: 'c1', name: 'c', provider: 'openrouter', model: 'or/chat', workerProvider: 'fireworks', workerModel: 'fw/chatworker' };
	const cw = page.chatWorkerModel(chat);
	check('chatWorkerModel is the chat\'s Workers pick', cw.model === 'fw/chatworker' && cw.provider === 'fireworks' && cw.chosen === true, pair(cw));
	const bare = { id: 'c2', name: 'c', provider: 'openrouter', model: 'or/chat' };
	check('a chat with no Workers pick: its own model', page.chatWorkerModel(bare).model === 'or/chat');
	check('a Diamond\'s chat: the Diamond\'s daimon', page.chatWorkerModel({ id: 'c3', diamondId: 'd1' }).model === 'fw/daimon');
	check('turnModelOf a chat is still its own model', page.turnModelOf(chat).model === 'or/chat');

	console.log('B6 the Jobs picks travel');
	if (has(['setJob', 'getJob'])) {
		check('no picks yet: the parcel carried no Jobs fields', !('workers' in first) && !('images' in first)
			&& !('workersAt' in first) && !('imagesAt' in first));
		check('a cleared pick travels, stamped', 'workers' in M.exportSync() && M.exportSync().workers.model === '');
		M.setJob('workers', 'openrouter', 'or/jobworker');
		M.setJob('images', 'fireworks', 'fw/jobvision');
		const sent = M.exportSync();
		check('the parcel carries both picks', !!sent.workers && sent.workers.model === 'or/jobworker' && sent.workersAt > 0
			&& !!sent.images && sent.images.model === 'fw/jobvision' && sent.imagesAt > 0);
		const older = JSON.parse(JSON.stringify(sent));
		older.workers = { provider: 'openrouter', model: 'or/older' }; older.workersAt = sent.workersAt - 1000;
		await M.applySync(older);
		check('an older pick loses', M.getJob('workers').model === 'or/jobworker');
		const newer = JSON.parse(JSON.stringify(sent));
		newer.workers = { provider: 'fireworks', model: 'fw/newer' }; newer.workersAt = sent.workersAt + 1000;
		newer.images  = { provider: '', model: '' };                  newer.imagesAt  = sent.imagesAt + 1000;
		await M.applySync(newer);
		check('a newer pick wins', M.getJob('workers').model === 'fw/newer', pair(M.getJob('workers')));
		check('a newer clear wins', M.getJob('images').model === '');
		check('and re-exports as it landed', M.exportSync().workersAt === newer.workersAt
			&& M.exportSync().imagesAt === newer.imagesAt);
		M.setJob('images', 'fireworks', 'fw/jobvision');
		await M.applySync({ providers: {}, tombs: { fireworks: Date.now() + 86400000 } });
		check('a tombstoned provider clears its picks', M.getJob('workers').model === '' && M.getJob('images').model === '',
			pair(M.getJob('workers')) + ' ' + pair(M.getJob('images')));
		check('and the workers fall back', pair(M.effective(D('d2'), 'workers')) === 'openrouter/or/default <daimon>');
	}

	console.log('\n' + (failures ? 'FAILED ' + failures : 'PASSED') + ' of ' + checks + ' checks'
		+ (process.env.MM_SRC_REV ? ' (at ' + process.env.MM_SRC_REV + ')' : ''));
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
