/* ============================================================
   Test — a one-shot request heals a refused credits key (2026-10-12).
   ------------------------------------------------------------
   The images model answered 401 "User not found" on the owner's
   tab: its credits key was mint generation 1, revoked by a later
   mint on another device (the gateway keeps one live key per
   account slot, so the loss a key can cause is one float). The
   chat heals that in its turn loop; `DaimondVision.look` made its
   request by hand and did not, so the daimon went blind.

   This drives the real www/js/models.js and asserts
     (a) a 401 on the credits row mints once and sends again on
         the fresh key;
     (b) a provider key the user typed is never retried;
     (c) a mint that fails is named on the answer, not swallowed;
     (d) a key already replaced by another caller's mint is taken,
         not minted again;
   and that daimond.js's look goes through `sendOnKey` and names
   the model and provider when it fails.

     node www/js/lookheal.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
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

const store = new Map();
const localStorage = {
	getItem:    (k) => (store.has(k) ? store.get(k) : null),
	setItem:    (k, v) => store.set(k, String(v)),
	removeItem: (k) => store.delete(k),
};
const win = globalThis;
win.dispatchEvent = () => true;
const documentShim = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
function loadScript(rel) {
	const body = readPage(join(HERE, rel), 'utf8');
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

let mints = 0, mintFails = false;
win.fetch = async (url) => {
	if (String(url).indexOf('/api/inference-key') >= 0) {
		if (mintFails) return { ok: false, status: 402, json: async () => ({ ok: false, error: 'no credits', credits_minor: 0 }) };
		mints++;
		return { ok: true, status: 200, json: async () => ({ ok: true, key: 'k' + mints, url: 'https://or.example/api/v1', credits_minor: 100, limit_minor: 50 }) };
	}
	return { ok: true, json: async () => ({ data: [] }) };
};

async function main() {
	if (typeof M.sendOnKey !== 'function') { check('DaimondModels.sendOnKey exists', false); return done(); }
	M.init({});
	await M.syncCredits({ authed: true, credits: 100 });
	check('the credits row holds mint 1', M.creditsGen() === 1 && mints === 1, 'gen ' + M.creditsGen());

	console.log('(a) a refused credits key: mint once, send again');
	const seen = [];
	const refuseFirst = async (r) => { seen.push(r.apiKey); return seen.length === 1 ? { ok: false, status: 401, raw: 'User not found' } : { ok: true, status: 200 }; };
	const a = await M.sendOnKey(M.CREDITS, 'x/eyes', '', refuseFirst);
	check('sent twice, the second on the fresh key', seen.join(',') === 'k1,k2', seen.join(','));
	check('the answer is the retry, marked', !!a && a.ok === true && a.reminted === true, JSON.stringify(a));
	check('exactly one mint', mints === 2, 'mints ' + mints);

	console.log('(b) a key the user typed is never retried');
	M.addProvider('own', { url: 'https://own.example/api/v1', name: 'Own' });
	await M.setKey('own', 'k-own');
	let sends = 0;
	const b = await M.sendOnKey('own', 'x/eyes', '', async () => { sends++; return { ok: false, status: 401 }; });
	check('one send, the refusal answered as it came', sends === 1 && b.status === 401 && !b.reminted, 'sends ' + sends);
	check('and no mint', mints === 2, 'mints ' + mints);

	console.log('(c) a mint that fails is named');
	mintFails = true;
	const c = await M.sendOnKey(M.CREDITS, 'x/eyes', '', async () => ({ ok: false, status: 401 }));
	check('the refusal comes back with the mint\'s reason', !!c && c.status === 401 && /no credits/.test(c.remintError || ''), JSON.stringify(c));
	mintFails = false;
	await M.syncCredits({ authed: true, credits: 100 });

	console.log('(d) a key another caller already replaced is taken, not minted');
	const before = mints, gen = M.creditsGen();
	const keys = [];
	const d = await M.sendOnKey(M.CREDITS, 'x/eyes', '', async (r) => {
		keys.push(r.apiKey);
		// Another agent's mint lands while this request is out.
		if (keys.length === 1) { await M.remint(gen, ''); return { ok: false, status: 401 }; }
		return { ok: true, status: 200 };
	});
	check('one mint between them, and the retry on it', mints === before + 1 && keys[1] === 'k' + mints && d.ok, keys.join(',') + ' mints ' + mints);

	console.log('(e) the look is wired through it');
	const src = readPage(join(HERE, 'daimond.js'), 'utf8');
	const at = src.indexOf('async function lookAt(');
	const body = at >= 0 ? src.slice(at, src.indexOf('window.DaimondVision', at)) : '';
	check('lookAt sends through DaimondModels.sendOnKey', /DaimondModels\.sendOnKey\(/.test(body));
	check('lookAt names the provider in a failure', /providerName\(/.test(body) || /lookWho\(/.test(body));
	check('lookAt warns the console, which the lens records', /console\.warn\(/.test(body));
	done();
}
function done() {
	console.log('\n' + (failures ? ('FAILED ' + failures + ' of ' + checks) : ('ok: ' + checks + ' checks')));
	process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
