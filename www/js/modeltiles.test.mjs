/* ============================================================
   Test — tiles, chips and toasts draw a model by its name
   (INT QA L-c, 23 Oct; ruling "an example he names means all").
   ------------------------------------------------------------
   The Models menu says "DeepSeek V4.1 Flash" while a tile said
   "deepseek-v4p1-flash": `shortModel` drew the raw id's leaf at
   every tile, rail chip, run chip and model-switch toast. It now
   goes through `DaimondModels.displayName(provider, model)`, and
   the raw id stays in the hover.

     (a) NAMED. `shortModel` draws the catalogue's name, a twin's
         name for a provider with none, the tidied id otherwise.
     (b) DRAWN. The header label (`respModel`) and the effort note
         (`effortClearedNote`) carry the name, never a raw id.
     (c) EVERY SITE. Each `shortModel` call in daimond.js passes the
         provider, so no site is left drawing a leaf without it.

   The real models.js and the real daimond.js functions, lifted.
   Failing-first: `MM_SRC_REV=6ca70f3ff` (the leaf drawn) and
   `--break leaf` (shortModel back on the id's last segment) fail.

     node www/js/modeltiles.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';
import { source } from './testlift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BREAK = process.argv.includes('--break') ? process.argv[process.argv.indexOf('--break') + 1] : '';
if (BREAK && BREAK !== 'leaf') { console.error('ABORT: no break called "' + BREAK + '"'); process.exit(2); }
let APP = source('daimond.js');
if (BREAK === 'leaf') {
	const out = APP.replace("DaimondModels.displayName(provider || '', String(m))", "String(m).split('/').pop()");
	if (out === APP) { console.error('ABORT: the "leaf" break no longer matches'); process.exit(2); }
	APP = out;
}

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
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

const store = new Map();
const localStorage = {
	getItem:    (k) => (store.has(k) ? store.get(k) : null),
	setItem:    (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
const win = globalThis;
win.dispatchEvent = () => true;
const documentShim = {
	addEventListener: () => {},
	getElementById:   () => null,
	createElement:    () => ({ appendChild: () => {}, dataset: {} }),
	visibilityState:  'hidden',
};
function loadScript(rel) {
	const body = readFileSync(join(HERE, rel), 'utf8');
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
loadScript('stamp.js');
globalThis.DaimondStamp = win.DaimondStamp;
loadScript('models.js');
const M = win.DaimondModels;

const DS_OR = 'deepseek/deepseek-v4.1-flash';
const DS_FW = 'accounts/fireworks/models/deepseek-v4p1-flash';
const GLM   = 'z-ai/glm-5.3-flash';
const REPLY = { data: [
	{ id: DS_OR, name: 'DeepSeek: DeepSeek V4.1 Flash', pricing: { prompt: '0.0000003', completion: '0.0000012' } },
	{ id: GLM, pricing: { prompt: '0.000001', completion: '0.000003' } },
] };

/// A raw id, or its bare leaf, where a name belongs.
function raw(text, id) {
	const leaf = id.slice(id.lastIndexOf('/') + 1);
	return text.includes('/') || text.includes(leaf);
}

// The lifted functions, over a chat and a Diamond the test sets.
const BODY = ['shortModel', 'respModel', 'effortClearedNote'].map((f) => liftFn(APP, f)).join('\n');
const make = new Function('window', 'DaimondModels', 'state', 't', BODY + `
	var current = null, currentDiamond = null, cfg = { model: '' };
	function turnModelOf(c) { return { provider: c.provider || '', model: c.model || '' }; }
	function diamondModel(id) { return state.diamonds[id] || { provider: '', model: '' }; }
	return {
		shortModel: shortModel, effortClearedNote: effortClearedNote,
		respModel: function (c, d) { current = c; currentDiamond = d; cfg.model = state.cfg; return respModel(); },
	};`);
const state = { diamonds: { d1: { provider: 'fw', model: DS_FW } }, cfg: GLM };
const tt = (k, o) => k + ':' + JSON.stringify(o || {});
const D = make(win, M, state, tt);

async function main() {
	win.fetch = async () => ({ ok: true, json: async () => REPLY });
	M.init({});
	M.addProvider('or', { url: 'https://openrouter.ai/api/v1', name: 'OpenRouter' });
	M.addProvider('fw', { url: 'https://api.fireworks.ai/inference/v1', name: 'Fireworks AI' });
	await M.setKey('or', 'k-or');
	await M.fetchModels('or');

	console.log('(a) shortModel draws the name');
	const a1 = D.shortModel(DS_OR, 'or');
	check('the catalogue name', a1 === 'DeepSeek V4.1 Flash', JSON.stringify(a1));
	const a2 = D.shortModel(DS_FW, 'fw');
	check('a Fireworks id, by its twin\'s name', a2 === 'DeepSeek V4.1 Flash', JSON.stringify(a2));
	const a3 = D.shortModel(GLM, 'or');
	check('no catalogue name: the id tidied', a3 === 'GLM 5.3 Flash', JSON.stringify(a3));
	const a4 = D.shortModel(DS_FW, '');
	check('no provider known: still named', !raw(a4, DS_FW), JSON.stringify(a4));

	console.log('(b) the header label and the effort note');
	const b1 = D.respModel({ provider: 'fw', model: DS_FW }, null);
	check('a chat\'s header names its model', b1 === 'DeepSeek V4.1 Flash', JSON.stringify(b1));
	const b2 = D.respModel({ provider: '', model: '' }, { id: 'd1' });
	check('a Diamond\'s header names its model', b2 === 'DeepSeek V4.1 Flash', JSON.stringify(b2));
	const b3 = D.respModel(null, null);
	check('the app default, named', b3 === 'GLM 5.3 Flash', JSON.stringify(b3));
	const b4 = D.effortClearedNote({ cleared: true }, 'fw', DS_FW);
	check('the effort-cleared note names the model', b4.includes('DeepSeek V4.1 Flash') && !raw(b4, DS_FW), b4);

	console.log('(c) every call site passes the provider');
	const calls = [...APP.matchAll(/shortModel\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)]
		.map((m) => m[1]).filter((args) => !/^m, provider$/.test(args));
	const bare = calls.filter((args) => !/,/.test(args));
	check('call sites found', calls.length >= 9, calls.length + ' site(s)');
	check('none draws a model without its provider', bare.length === 0, JSON.stringify(bare));

	console.log(failures ? '\nFAILED ' + failures + ' of ' + checks : '\nall ' + checks + ' checks pass');
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.log('FAIL threw: ' + (e && e.stack || e)); process.exit(1); });
