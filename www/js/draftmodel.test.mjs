/* ============================================================
   Test — the dedicated drafting model (Track D).
   ------------------------------------------------------------
   The note→proposal drafting in triage.js runs on the CHAT model
   until the user picks a model of its own in AI settings. This
   drives the REAL www/js/models.js and www/js/triage.js in a
   minimal browser sandbox and asserts the three things the design
   turns on:

     (a) UNSET → CHAT. With no drafting model chosen, `resolveDraft`
         answers exactly what `resolve('','')` does — same provider,
         same model, same key — so behaviour is the pre-Track-D one
         and there is zero regression.

     (b) SET → CHOSEN. Once a drafting model is set, `resolveDraft`
         answers THAT model, and clearing it (empty model) falls
         back to the chat model again.

     (c) THE COST LINE FOLLOWS. `DaimondTriage.estimate()` prices the
         model `resolveDraft` returns, so the ceiling a person reads
         before the drafting press is the drafting model's, not the
         chat model's, whenever one is set.

   Each check is proven able to fail: the two --break modes damage
   the shipped `resolveDraft` the two ways it could plausibly be got
   wrong, and the checks that guard each defect go red under it.

     node www/js/draftmodel.test.mjs --break nofallback  # unset stops being chat
     node www/js/draftmodel.test.mjs --break ignoredraft # the choice is ignored
     node www/js/draftmodel.test.mjs                     # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i > 0 ? String(process.argv[i + 1] || '') : '';
})();

// ── The patches that prove the checks can fail ─────────────────
// Each damages the ONE shipped function this feature lives in, the
// two ways it could plausibly be got wrong.
//
//   nofallback  the unset case stops answering the chat model — the
//               regression the whole "defaults to chat" rule exists
//               to prevent. (a) goes red.
//   ignoredraft the user's chosen model is never consulted — drafting
//               silently stays on chat. (b) and (c) go red.
function patchModels(src) {
	if (BREAK === 'nofallback') {
		return src.replace('if (dr.model) return resolve(dr.provider, dr.model);\n\t\treturn resolve(\'\', \'\');',
			'if (dr.model) return resolve(dr.provider, dr.model);\n\t\treturn null;');
	}
	if (BREAK === 'ignoredraft') {
		return src.replace('if (dr.model) return resolve(dr.provider, dr.model);',
			'if (false) return resolve(dr.provider, dr.model);');
	}
	return src;
}

// ── A minimal browser sandbox ──────────────────────────────────
// models.js and triage.js are classic-script IIFEs reading the bare
// globals `window`, `document`, `localStorage`, and (guarded) the
// timers. They attach `DaimondModels` / `DaimondTriage` onto window.
const store = new Map();
const localStorage = {
	getItem:    (k) => (store.has(k) ? store.get(k) : null),
	setItem:    (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
// `window` IS globalThis here, deliberately: in a browser `window.DaimondModels =
// x` also creates the bare global `DaimondModels`, and triage.js's `pick()` reads
// that bare global (`return DaimondModels.resolveDraft()`) — so a separate `win`
// object would leave that reference undefined and every `pick()` would swallow a
// ReferenceError and answer null. Making window the real global is what makes the
// cross-module references resolve the way they do on the page.
const win = globalThis;
win.dispatchEvent = () => true;
// triage.js registers a top-level click listener; models.js a guarded
// visibilitychange one. Neither is fired here — the stub only has to
// exist so the modules load.
const documentShim = {
	addEventListener: () => {},
	getElementById:   () => null,
};
function loadScript(rel, transform) {
	let body = readFileSync(join(HERE, rel), 'utf8');
	if (transform) body = transform(body);
	const fn = new Function('window', 'document', 'localStorage', 'console', 'globalThis', body);
	fn(win, documentShim, localStorage, console, globalThis);
}

loadScript('models.js', patchModels);
loadScript('triage.js');

const M = win.DaimondModels;
const T = win.DaimondTriage;
if (!M || !M.resolveDraft) { console.error('ABORT: DaimondModels.resolveDraft missing'); process.exit(2); }
if (!T || !T.estimate)     { console.error('ABORT: DaimondTriage.estimate missing');    process.exit(2); }

// A pricing stub keyed by model, so a run's ceiling differs by which model priced
// it — the only way to show the cost line followed the drafting model rather than
// merely naming it. Non-null `rate` makes `estimate` go on to `priceFor`.
const PRICE = { 'chat-model': 0.11, 'draft-model': 0.42 };
win.DaimondPricing = {
	rate:     () => ({}),
	priceFor: (model) => ({ usd: PRICE[model] != null ? PRICE[model] : 0 }),
};

const NOTES = [{ id: 'n1', text: 'the box loses my text', at: 1 }];

/// The drafting model resolveDraft answers, or '' when it answers nothing — so a
/// broken build that returns null reads as a clean FAIL rather than crashing the run.
const draftModel = () => { const r = M.resolveDraft(); return r ? r.model : ''; };

async function main() {
	M.init({});
	M.addProvider('fireworks', { url: 'https://api.fireworks.ai/x', name: 'Fireworks' });
	await M.setKey('fireworks', 'chat-key');			// plaintext-at-rest: no identity here
	M.setDefault('fireworks', 'chat-model');

	// ── (a) UNSET → CHAT ───────────────────────────────────────
	console.log('(a) unset drafting model resolves to the chat model');
	const chat  = M.resolve('', '');
	const dUn   = M.resolveDraft();
	check('resolveDraft answers a config when chat is set', !!dUn);
	check('unset drafting model === chat model',
		!!dUn && dUn.model === 'chat-model' && dUn.provider === 'fireworks',
		dUn ? dUn.model : String(dUn));
	check('unset drafting config equals resolve("","")',
		!!dUn && !!chat && dUn.model === chat.model && dUn.provider === chat.provider
			&& dUn.apiKey === chat.apiKey && dUn.baseUrl === chat.baseUrl);
	check('getDraft reports nothing set', M.getDraft().model === '' && M.getDraft().provider === '');
	const eUn = T.estimate(NOTES, []);
	check('estimate prices the chat model when unset',
		eUn.model === 'chat-model' && eUn.known === true && eUn.usd === PRICE['chat-model'],
		'usd=' + eUn.usd + ' model=' + eUn.model);

	// ── (b) SET → CHOSEN ───────────────────────────────────────
	console.log('(b) a chosen drafting model wins, and diverges from chat');
	M.setDraft('fireworks', 'draft-model');
	const dSet = M.resolveDraft();
	check('set drafting model resolves to the chosen model',
		!!dSet && dSet.model === 'draft-model', dSet ? dSet.model : String(dSet));
	check('the chat model is UNCHANGED by the drafting choice',
		M.resolve('', '').model === 'chat-model');
	check('getDraft reports the chosen model',
		M.getDraft().model === 'draft-model' && M.getDraft().provider === 'fireworks');

	// ── (c) THE COST LINE FOLLOWS ──────────────────────────────
	console.log('(c) the cost estimate prices the drafting model, not the chat model');
	const eSet = T.estimate(NOTES, []);
	check('estimate names the drafting model', eSet.model === 'draft-model', eSet.model);
	check('estimate prices the DRAFTING model, not the chat model',
		eSet.usd === PRICE['draft-model'] && eSet.usd !== PRICE['chat-model'],
		'usd=' + eSet.usd);

	// ── clearing falls back to chat ────────────────────────────
	console.log('(b′) clearing the drafting model falls back to chat');
	M.setDraft('', '');
	check('cleared drafting model resolves to chat again', draftModel() === 'chat-model');
	check('estimate prices the chat model again after clearing',
		T.estimate(NOTES, []).usd === PRICE['chat-model']);

	// ── a drafting model whose provider is removed falls back ──
	console.log('(d) removing a drafting model’s provider falls back to chat, never to nothing');
	M.addProvider('together', { url: 'https://api.together.xyz/x', name: 'Together' });
	await M.setKey('together', 'together-key');
	M.setDraft('together', 'together-model');
	check('drafting model set on a second provider', draftModel() === 'together-model');
	M.removeProvider('together');
	check('after its provider is removed, drafting falls back to chat',
		draftModel() === 'chat-model');
	check('and getDraft reports nothing set again', M.getDraft().model === '');

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks
		+ ' checks' + (BREAK ? ' (--break ' + BREAK + ')' : ''));
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('ABORT:', e && e.stack ? e.stack : e); process.exit(2); });
