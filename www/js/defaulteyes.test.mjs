/* ============================================================
   Test — the account's default images model (D-20261009-27).
   ------------------------------------------------------------
   A daimon whose own model reads no pictures, in a Diamond with no
   images model chosen, was left with a table and no eyes. The
   default is the model a provider with a key lists as taking
   pictures whose one look (1,500 in, 200 out, plus any per-picture
   price) costs least at its quoted rates; a model quoted at nothing
   is passed over (free endpoints are rate-limited), ties go to the
   provider's id then the model's, and no vendor is named.

   This drives the real www/js/models.js and asserts
     (a) no seeing priced model: null;
     (b) the cheapest seeing priced model wins, the free and the
         text-only are passed over, a per-picture price counts;
     (c) the model that refused may be skipped, ties are by ids,
         and a provider with no key offers nothing.

   No browser: the stand-in covers what models.js touches.
     node www/js/defaulteyes.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// ── A minimal browser sandbox ──────────────────────────────────
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
if (!M || typeof M.cheapestSeeing !== 'function') {
	console.error('ABORT: DaimondModels.cheapestSeeing missing');
	process.exit(2);
}

const seeing = (id, inp, out, extra) => Object.assign({ id, architecture: { input_modalities: ['text', 'image'] },
	pricing: { prompt: inp, completion: out } }, extra || {});
let reply = { data: [] };
// models.js re-reads its stored record after a write, off the awaited path; let it land.
const settle = () => new Promise((r) => setTimeout(r, 20));

async function main() {
	win.fetch = async () => ({ ok: true, json: async () => reply });
	M.init({});
	M.addProvider('pa', { url: 'https://a.example/api/v1', name: 'A' });
	await M.setKey('pa', 'k-a');

	console.log('(a) nothing seeing and priced: no default');
	reply = { data: [
		{ id: 'x/text', architecture: { input_modalities: ['text'] }, pricing: { prompt: '0.0000001', completion: '0.0000001' } },
		{ id: 'x/eyes-unpriced', architecture: { input_modalities: ['text', 'image'] } },
		seeing('x/eyes-free', '0', '0'),
	] };
	await M.fetchModels('pa'); await settle();
	check('text-only, unpriced and free models give no default', M.cheapestSeeing() === null, JSON.stringify(M.cheapestSeeing()));

	console.log('(b) the cheapest look wins');
	reply = { data: reply.data.concat([
		seeing('x/eyes-dear', '0.000003', '0.000015'),
		seeing('x/eyes-cheap', '0.0000001', '0.0000004'),
		seeing('x/eyes-cheaper-tokens', '0.00000005', '0.0000002', { pricing: { prompt: '0.00000005', completion: '0.0000002', image: '0.001' } }),
	]) };
	await M.fetchModels('pa'); await settle();
	const d = M.cheapestSeeing();
	check('the cheapest seeing priced model is the default', !!d && d.provider === 'pa' && d.model === 'x/eyes-cheap', JSON.stringify(d));
	check('one look is priced at 1,500 in and 200 out', !!d && Math.abs(d.usd - 0.00023) < 1e-9, d && d.usd);
	check('a per-picture price counts against a model', M.rateFor('pa', 'x/eyes-cheaper-tokens') !== null
		&& JSON.stringify(win.DaimondStore.get('daimond-models-v2').providers.pa.rates['x/eyes-cheaper-tokens']).includes('"img":0.001'));

	console.log('(c) skip, ties, keys');
	const s = M.cheapestSeeing({ provider: 'pa', model: 'x/eyes-cheap' });
	check('the model that refused is skipped', !!s && s.model === 'x/eyes-cheaper-tokens', JSON.stringify(s));
	M.addProvider('pb', { url: 'https://b.example/api/v1', name: 'B' });
	await M.setKey('pb', 'k-b');
	reply = { data: [seeing('a/eyes-cheap', '0.0000001', '0.0000004')] };
	await M.fetchModels('pb'); await settle();
	const t = M.cheapestSeeing();
	check('a tie goes to the provider id first', !!t && t.provider === 'pa' && t.model === 'x/eyes-cheap', JSON.stringify(t));
	await M.setKey('pa', ''); await settle();
	const k = M.cheapestSeeing();
	check('a provider with no key offers nothing', !!k && k.provider === 'pb', JSON.stringify(k));

	console.log('(d) the floor: a maker the account already uses first');
	reply = { data: [seeing('a/eyes-cheap', '0.0000001', '0.0000004'), seeing('a/eyes-dear', '0.000003', '0.000015'),
		seeing('z/eyes-cheapest', '0.00000001', '0.00000001')] };
	await M.fetchModels('pb'); await settle();
	const n = M.cheapestSeeing();
	check('with no model in use, the catalogue-wide cheapest, so marked', !!n && n.model === 'z/eyes-cheapest' && n.familiar === false, JSON.stringify(n));
	M.setDefault('pb', 'a/chat'); await settle();
	const f = M.cheapestSeeing();
	check('the default\'s maker is preferred to a cheaper stranger', !!f && f.model === 'a/eyes-cheap' && f.familiar === true, JSON.stringify(f));
	const u = M.cheapestSeeing(null, [{ provider: 'pb', model: 'z/chat' }]);
	check('a maker a Diamond uses counts, and the cheapest of the familiar wins', !!u && u.model === 'z/eyes-cheapest' && u.familiar === true, JSON.stringify(u));
	reply = { data: reply.data.concat([seeing('a/eyes-cheap:batch', '0.00000005', '0.0000002')]) };
	await M.fetchModels('pb'); await settle();
	const b = M.cheapestSeeing();
	check('a batch variant, which answers on its own schedule, is not the default', !!b && b.model === 'a/eyes-cheap', JSON.stringify(b));
	M.setDefault('pb', 'q/chat'); await settle();
	const q = M.cheapestSeeing();
	check('no familiar maker offering a seeing model: the catalogue-wide cheapest', !!q && q.model === 'z/eyes-cheapest' && q.familiar === false, JSON.stringify(q));

	console.log('\n' + (failures ? ('FAILED ' + failures + ' of ' + checks) : ('ok: ' + checks + ' checks')));
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
