// QA-B (rc QA, D-20261018-09): turn-path reads of a chat's raw record, which for a following
// chat now holds ''. Real models.js; real daimond.js functions lifted.
import { source, lift } from './testlift.mjs';
import { loadStore } from './storefixture.mjs';
let failures = 0, checks = 0;
function check(n, c, d) { checks++; if (c) console.log('  ok   ' + n); else { console.log('  FAIL ' + n + (d !== undefined ? '  (' + JSON.stringify(d) + ')' : '')); failures++; } }
const store = new Map();
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
const win = globalThis; win.dispatchEvent = () => true;
const documentShim = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
const loadScript = (b) => new Function('window', 'document', 'localStorage', 'console', 'globalThis', b)(win, documentShim, localStorage, console, globalThis);
loadStore(win, localStorage);
const tombMap = {};
win.DaimondCore = { tombs: () => Object.assign({}, tombMap), tombstone: (k, id, at) => { tombMap[id] = at || Date.now(); }, mergeTombs: () => Object.assign({}, tombMap) };
loadScript(source('stamp.js')); globalThis.DaimondStamp = win.DaimondStamp;
loadScript(source('models.js'));
const M = win.DaimondModels;
const L = lift(source('daimond.js'), ['readJson', 'canRemint', 'setFoldPick', 'applyFoldSettings', 'summarisingPick'], ['CFG_KEY']);
if (L.missing.length) console.log('  lacks: ' + L.missing.join(', '));
const folds = [];
const cfg = { foldProvider: '', foldModel: '' };
const chat = { id: 'c1', provider: '', model: '', app: { set_fold_model: (m) => folds.push(m) }, _appPair: { provider: 'openrouter', model: 'or/default' } };
const page = new Function('window', 'localStorage', 'DaimondModels', 'cfg', 'chats', '_diamondApps', '_diamondAppProvider', 'Prompts',
	L.body + '\nreturn { canRemint, setFoldPick, summarisingPick };')(win, localStorage, M, cfg, [chat], {}, new Map(), null);
async function main() {
	M.init({});
	// The page's reader, as boot binds it (daimond.js `bindPicks`): the Summarising pick is cfg's.
	if (M.bindPicks) M.bindPicks({ summarising: page.summarisingPick });
	M.addProvider('openrouter', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	await M.setKey('openrouter', 'or-key');
	M.setDefault('openrouter', 'or/default');
	// T2: a Summarising pick on the default's provider reaches a live following chat's engine.
	page.setFoldPick('openrouter', 'or/summ');
	check('T2 live following-chat engine gets the Summarising pick', folds[folds.length - 1] === 'or/summ', folds);
	// T1: a following chat on the credits default may re-mint (F1 headroom, refusal retry).
	const C = M.CREDITS;
	check('T1 a following chat on the credits default can re-mint',
		page.canRemint({ provider: '', model: '', _appPair: { provider: C, model: 'x' } }) === true || !C, C);
}
main().then(() => { console.log((failures ? 'FAIL' : 'ok') + ' qa_turn: ' + (checks - failures) + '/' + checks); if (failures) process.exit(1); });
