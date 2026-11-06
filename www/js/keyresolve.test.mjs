/* ============================================================
   Test — KEY-RESOLVE: no page script can read a provider key.
   ------------------------------------------------------------
   A probe that printed `DaimondModels.resolve()` put his key in a
   transcript (06 Nov 2026). Any page script, or a daimon's page
   change, could do the same. The key now leaves models.js only
   inside the request path: an engine it builds (`engine`,
   `slotEngine`) or a fetch to the provider's own origin
   (`providerFetch`). This drives the REAL www/js/models.js in a
   sandbox, with a FAKE key, and asserts:

     (a) NO EXPORT RETURNS IT. Every `window.DaimondModels` member
         is called with a spread of arguments, its answer awaited,
         and the answer searched recursively for the fake key.
     (b) A PROVIDER REQUEST STILL CARRIES IT: `providerFetch` puts
         it in the auth header, an engine is built on it, and a
         fetch off the provider's origin is refused.
     (c) MR1-STYLE CALLS GET NO KEY: `resolve(p, m)` and
         `resolveDraft()` answer `{ provider, model, baseUrl,
         usable }` and nothing else.
     (d) NO PAGE FILE READS A KEY OFF A RESOLVER: a scan of www/js
         for `keyFor(` and `.apiKey` outside the legacy config.

   Red on d49d81496 (dev/keyresolve_red.sh runs it on that
   models.js). The key is fake, made up here; never print a real one.

     node www/js/keyresolve.test.mjs
     KEYRESOLVE_MODELS=<path to a models.js> node www/js/keyresolve.test.mjs
   ============================================================ */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = process.env.KEYRESOLVE_MODELS || join(HERE, 'models.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name + (detail ? ' — ' + detail : ''));
	else { console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); failures++; }
}

// Made up for this test: no provider has ever issued it.
const FAKE = 'fake-keyresolve-Q7Z3-not-a-real-key';	// allowlist secret
const ORIGIN = 'https://openrouter.ai';

// ── A minimal browser sandbox, as draftmodel.test.mjs builds it ──
const kv = new Map();
const localStorage = {
	getItem:    (k) => (kv.has(k) ? kv.get(k) : null),
	setItem:    (k, v) => kv.set(k, String(v)),
	removeItem: (k) => kv.delete(k),
};
const win = globalThis;
win.dispatchEvent = () => true;
const documentShim = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
// Every request the module makes, with its headers, so (b) can see the key go out.
const sent = [];
win.fetch = async (url, init) => {
	sent.push({ url: String(url), init: init || {} });
	return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', headers: { get: () => null } };
};
function loadScript(path) {
	const body = readFileSync(path, 'utf8');
	new Function('window', 'document', 'localStorage', 'console', 'globalThis', body)(win, documentShim, localStorage, console, globalThis);
}
loadStore(win, localStorage);
const tombMap = {};
win.DaimondCore = {
	tombs:      () => Object.assign({}, tombMap),
	tombstone:  (k, id, at) => { tombMap[id] = at || Date.now(); },
	mergeTombs: (k, inc) => { for (const id in (inc || {})) if (!tombMap[id] || inc[id] > tombMap[id]) tombMap[id] = inc[id]; return Object.assign({}, tombMap); },
};
loadScript(join(HERE, 'stamp.js'));
globalThis.DaimondStamp = win.DaimondStamp;
loadScript(MODELS);
const M = win.DaimondModels;
if (!M || !M.resolve) { console.error('ABORT: DaimondModels.resolve missing'); process.exit(2); }

// A stand-in engine that keeps what it is given where no search can reach it, as the wasm
// does: the key is in its linear memory, never on the object.
const given = new WeakMap();
class FakeEngine {
	constructor(base, key, model) { given.set(this, { base: base, key: key, model: model }); }
}

/// Does `v`, searched to any depth, hold the fake key? A path to it, or ''.
function holds(v, path, seen) {
	if (typeof v === 'string') return v.indexOf(FAKE) !== -1 ? path || '(value)' : '';
	if (!v || (typeof v !== 'object' && typeof v !== 'function')) return '';
	if (seen.has(v)) return '';
	seen.add(v);
	if (typeof v === 'function') return '';
	let keys = [];
	try { keys = Object.getOwnPropertyNames(v); } catch (e) { return ''; }
	for (const k of keys) {
		let x;
		try { x = v[k]; } catch (e) { continue; }
		const hit = holds(x, path + '.' + k, seen);
		if (hit) return hit;
	}
	return '';
}

const settle = (p) => Promise.race([Promise.resolve(p).catch((e) => e), new Promise((r) => setTimeout(() => r(undefined), 150))]);

async function setup() {
	if (!M.providers().some((p) => p.id === 'openrouter')) M.addProvider('openrouter', { url: ORIGIN + '/api/v1', name: 'OpenRouter' });
	await M.setKey('openrouter', FAKE);	// always: a member such as setKey may have written another
	M.setDefault('openrouter', 'some/model');
}

async function main() {
	M.init({});
	await setup();
	check('the fake key is stored and usable', M.ready() && M.hasKey('openrouter'));

	// ── (c) MR1-style calls get no key ───────────────────────────
	console.log('(c) resolve and resolveDraft answer a descriptor, never the key');
	const r = M.resolve('openrouter', 'some/model');
	check('resolve(p, m) still says the model can run', !!r && r.usable === true && r.model === 'some/model' && r.provider === 'openrouter');
	check('resolve(p, m) holds no key', !holds(r, 'resolve', new Set()), holds(r, 'resolve', new Set()));
	check('resolve("", "") holds no key', !holds(M.resolve('', ''), 'resolve', new Set()));
	check('resolveDraft() holds no key', !holds(M.resolveDraft(), 'resolveDraft', new Set()));
	check('resolve answers only provider, model, baseUrl, usable',
		!!r && Object.keys(r).sort().join(',') === 'baseUrl,model,provider,usable', r ? Object.keys(r).sort().join(',') : 'null');
	check('no keyFor export', typeof M.keyFor === 'undefined');

	// ── (a) no export returns it ─────────────────────────────────
	console.log('(a) no window.DaimondModels member answers the key, whatever it is asked');
	const ARGS = [[], ['openrouter'], ['openrouter', 'some/model'], ['', ''], [0], [1], ['openrouter', 'some/model', null, 0]];
	const leaks = [];
	for (const name of Object.keys(M)) {
		const v = M[name];
		if (typeof v !== 'function') {
			const hit = holds(v, name, new Set());
			if (hit) leaks.push(hit);
			continue;
		}
		for (const a of ARGS) {
			let out;
			try { out = await settle(v.apply(M, a)); } catch (e) { out = e; }
			const hit = holds(out, name + '(' + a.map(String).join(',') + ')', new Set());
			if (hit) leaks.push(hit);
			await setup();	// a mutator (removeProvider, lock) must not leave the rest vacuous
		}
	}
	check('every member was asked with the key stored', M.canRun('openrouter'));
	check('no member answers a value holding the key', leaks.length === 0, leaks.slice(0, 6).join('; '));

	// ── (b) a provider request still carries it ──────────────────
	console.log('(b) the request path still sends the key, and only to the provider');
	sent.length = 0;
	let res = null, err = null;
	try { res = await M.providerFetch('openrouter', ORIGIN + '/api/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); }
	catch (e) { err = e; }
	const go = sent[sent.length - 1];
	const auth = go && go.init && go.init.headers ? JSON.stringify(go.init.headers) : '';
	check('providerFetch sends the request', !err && !!res && !!go, err ? String(err.message || err) : '');
	check('the request carries the key in its auth header', auth.indexOf(FAKE) !== -1);
	check('the caller\'s own headers go too', auth.indexOf('application/json') !== -1);
	let refused = false;
	sent.length = 0;
	try { await M.providerFetch('openrouter', 'https://elsewhere.example/steal', {}); } catch (e) { refused = true; }
	check('a fetch off the provider\'s origin is refused, unsent', refused && sent.length === 0);
	let bound = false, app = null;
	try { bound = M.bindEngine(FakeEngine); app = M.engine('openrouter', 'some/model', 256, 'sys', false); } catch (e) { app = null; }
	const g = app ? given.get(app) : null;
	check('engine() builds on the stored key', bound && !!g && g.key === FAKE && g.model === 'some/model');
	check('a second engine class is refused', !!M.bindEngine && M.bindEngine(class Other {}) === false);
	check('engine() is null where resolve is', !!M.engine && M.engine('nobody', 'x', 256, '', false) === null);

	// ── (d) no page file reads a key off a resolver ──────────────
	console.log('(d) no www/js file reads a key out of DaimondModels');
	// The legacy single-provider config (`cfg.apiKey`, sealed as `apiKeyEnc`) predates models.js
	// and is migrated into it; those files may name it, nothing else may read `.apiKey`.
	const LEGACY = new Set(['page/util.js', 'page/passkey_phrase.js', 'page/settingsui.js', 'page/boot.js', 'debugshare.js', 'models.js']);
	const bad = [];
	const walk = (d) => readdirSync(d).forEach((f) => {
		const p = join(d, f);
		if (statSync(p).isDirectory()) return walk(p);
		if (!/\.js$/.test(f)) return;
		const rel = relative(HERE, p);
		readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
			if (rel !== 'models.js' && /\bkeyFor\s*\(/.test(line)) bad.push(rel + ':' + (i + 1) + ' keyFor(');
			if (!LEGACY.has(rel) && /\.apiKey\b/.test(line)) bad.push(rel + ':' + (i + 1) + ' .apiKey');
			if (LEGACY.has(rel) && /\b(r|a|d|got|res)\.apiKey\b/.test(line)) bad.push(rel + ':' + (i + 1) + ' resolver .apiKey');
		});
	});
	walk(HERE);
	check('no keyFor( outside models.js, no .apiKey off a resolver', bad.length === 0, bad.slice(0, 8).join('; '));

	console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('ABORT', e && e.stack || e); process.exit(2); });
