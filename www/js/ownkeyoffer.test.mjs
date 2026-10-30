/* ============================================================
   Test — the page offers the runner on any source the chat pays
   with, his own key included (OWNKEY OK-2; D-20261024-18/-19/-21;
   design ownkey_design.md §1.2, §2, §5.2, §5.4, review H3, M2, L2,
   owner ruling Q2).
   ------------------------------------------------------------
     K1  THE ERRAND'S KEYS. `makeErrand` carries every non-credits
         source the halves name, sealed only (`url`, `keyEnc`,
         `fetched`), never a plaintext key and never `credits`.
     K2  THE ABI. The page's engine ABI closes the errand, after
         `keys`, after `sessionRef`; the bytes match the runner's
         golden `errand_abi`.
     K3  PRESENCE carries a runner's `abi` and `abiMin`.
     K4  THE OFFER. An ABI runner is offered on the two-sided range
         and only for sources it can reach; a legacy runner keeps
         the old binary's capability: credits and the same wasm.
     K5  REACH. `runnerReach`: credits; a sealed key on an https
         host that is not loopback (LAN https too); http needs
         https; loopback is on this device; a plaintext key must
         be unlocked to seal; no key.
     K6  SEATWHY names the source, the reason, the engine, and the
         re-approval a passphrase change needs (M2).
     K7  A REPORT below the page's min is not applied (H3).
     K8  `cost.by` is booked to each own-key source's pool.
     K9  THE SAME FAULT ELSEWHERE. Every menu whose button toggles
         leaves its button to its own click; the empty source reads
         "Credits".
     K10 A FRAME below the page's min is not taken (A2): `abiOk` and
         sync.js's frame abi. (P2.3a: a turn's rows come by the log, so
         the frame adoption's arm went with the frame read path.)
     K11 THE OCR ROWS (A1). The errand also carries his sealed
         `openrouter` and `mistral` rows when they reach the runner,
         as `ocr.js` reads PDFs and pictures with them; one that does
         not reach it is left out, and credits never ride along.

   No browser: stand-ins cover what each module touches.
     node www/js/ownkeyoffer.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { source, lift } from './testlift.mjs';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + String(detail).slice(0, 200) + ')' : '')); failures++; }
}

const CR = 'credits';
const ENGINE = 'ab'.repeat(32), OTHER = 'cd'.repeat(32);
const now = Date.now();

// ── models.js, with an identity that seals ────────────────────────
async function models(unlocked) {
	const ls = new Map();
	const localStorage = {
		getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k),
	};
	const doc = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
	const ctx = vm.createContext({ console, localStorage, document: doc, setTimeout, clearTimeout, URL,
		dispatchEvent: () => true, addEventListener: () => {} });
	ctx.window = ctx;
	loadStore(ctx, localStorage);
	ctx.DaimondCore = { tombs: () => ({}), tombstone: () => {}, mergeTombs: () => {} };
	ctx.DaimondIdentity = {
		isUnlocked: () => unlocked,
		wrap:       async (k) => 'SEALED(' + k + ')',
		unwrap:     async (e) => String(e).replace(/^SEALED\(|\)$/g, ''),
	};
	ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) });
	vm.runInContext(source('stamp.js'), ctx);
	vm.runInContext(source('models.js'), ctx);
	const M = ctx.DaimondModels;
	M.init({ onChange: () => {} });
	return M;
}

async function reachChecks() {
	const M = await models(true);
	const add = async (id, url, key) => { M.addProvider(id, { url, name: id.toUpperCase() }); if (key) await M.setKey(id, key); };
	await add(CR, 'https://credits.example/v1', 'cr-key');
	await add('an', 'https://api.anthropic.com/v1', 'an-key');
	await add('lan', 'https://192.168.1.20:8443/v1', 'lan-key');
	await add('http', 'http://models.example/v1', 'h-key');
	await add('loop', 'https://localhost:11434/v1', 'l-key');
	await add('loop6', 'https://[::1]:8000/v1', 'l6-key');
	await add('loop4', 'http://127.0.0.1:8000/v1', 'l4-key');
	await add('none', 'https://none.example/v1', '');
	const P = await models(false);
	P.addProvider('plain', { url: 'https://plain.example/v1', name: 'Plain' });
	await P.setKey('plain', 'p-key');
	const r = (Mx, id) => (typeof Mx.runnerReach === 'function' ? Mx.runnerReach(id) : null);
	const why = (Mx, id) => { const x = r(Mx, id); return x ? (x.ok ? 'ok' : x.why) : 'no runnerReach'; };
	check('K5 credits reach the runner', why(M, CR) === 'ok', why(M, CR));
	check('K5 a sealed key on a public https host reaches it', why(M, 'an') === 'ok', why(M, 'an'));
	check('K5 a sealed key on a LAN https host reaches it (D-21)', why(M, 'lan') === 'ok', why(M, 'lan'));
	check('K5 plain http is refused: it needs https', why(M, 'http') === 'https', why(M, 'http'));
	check('K5 loopback is on this device', why(M, 'loop') === 'device' && why(M, 'loop6') === 'device'
		&& why(M, 'loop4') === 'device', [why(M, 'loop'), why(M, 'loop6'), why(M, 'loop4')].join());
	// QA-B F4: every literal loopback form, judged on the host text (the page cannot resolve
	// names; the runner's resolved-address check stays the authority and hands back `keys`).
	const LOOP = { lh1: 'https://localhost./v1', lh2: 'https://app.localhost/v1', lh3: 'https://LOCALHOST:9/v1',
		v4a: 'https://127.0.0.1/v1', v4b: 'https://127.255.3.4:8/v1', v4c: 'https://127.1/v1', zero: 'https://0.0.0.0:8000/v1',
		v6a: 'https://[::1]/v1', v6b: 'https://[0:0:0:0:0:0:0:1]/v1', v6c: 'https://[::]:8000/v1',
		v6d: 'https://[::ffff:127.0.0.1]/v1', v6e: 'https://[::ffff:7f12:3456]/v1' };
	const NEAR = { n1: 'https://localhost.example.com/v1', n2: 'https://notlocalhost/v1', n3: 'https://128.0.0.1/v1',
		n4: 'https://[::2]/v1', n5: 'https://[::ffff:8.8.8.8]/v1', n6: 'https://1.0.0.0/v1' };
	for (const [id, url] of Object.entries(LOOP)) await add(id, url, 'k-' + id);
	for (const [id, url] of Object.entries(NEAR)) await add(id, url, 'k-' + id);
	for (const [id, url] of Object.entries(LOOP)) check('K5b loopback ' + url + ' is on this device', why(M, id) === 'device', why(M, id));
	for (const [id, url] of Object.entries(NEAR)) check('K5b ' + url + ' is not loopback', why(M, id) === 'ok', why(M, id));
	check('K5 a row with no key has none saved', why(M, 'none') === 'nokey' && why(M, 'gone') === 'nokey', why(M, 'none'));
	check('K5 a plaintext key must be unlocked to seal (L2)', why(P, 'plain') === 'unlock', why(P, 'plain'));
	const sr = (Mx, id) => (typeof Mx.sealedRow === 'function' ? Mx.sealedRow(id) : 'no sealedRow');
	const an = sr(M, 'an');
	check('K1 the sealed row is url, keyEnc and fetched, in that order', !!an && typeof an === 'object'
		&& JSON.stringify(Object.keys(an)) === '["url","keyEnc","fetched"]' && an.keyEnc === 'SEALED(an-key)'
		&& an.url === 'https://api.anthropic.com/v1' && typeof an.fetched === 'number', JSON.stringify(an));
	check('K1 credits, a plaintext key and no key give no sealed row',
		sr(M, CR) === null && sr(P, 'plain') === null && sr(M, 'none') === null, JSON.stringify([sr(M, CR), sr(P, 'plain')]));
	return M;
}

// ── peer.js, one page ───────────────────────────────────────────
function page(M, shared, more) {
	const ls = shared || new Map();
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	if (M) win.DaimondModels = M;
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	const localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
	for (const rel of ['stamp.js'].concat(more || [], ['peer.js'])) {
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + readPage(join(HERE, rel), 'utf8') + '\n}')(win, doc, quiet, localStorage, { storage: {} }, function () {});
	}
	win._ls = ls;
	return win;
}

function answer(over) {
	return {
		rn:  Object.assign({ name: 'argonaut', last_seen: now, runner: true, kind: 'runner',
			serviced: true, serviced_at: now, mobile: false, busy: 0, engine: ENGINE }, over || {}),
		tab: { name: 'laptop', last_seen: now, mobile: false },
	};
}
function offer(win, ans, sources, more) {
	win.DaimondPeer.setEngineId(ENGINE);
	win.DaimondPresence.ingest(ans, now);
	return win.DaimondPeer.seatSwitch({ id: 'c1', model: 'm', provider: sources[0] || '' }, win.DaimondPresence.snapshot(),
		Object.assign({ selfId: 'me', runnerOnly: true, nominatedId: 'rn', sources: sources,
			freshWindowMs: win.DaimondPeer.DISPATCH_FRESH_MS }, more || {}), now);
}

const GOLD_ABI_TAIL = ',"limits":{"window":1048576,"foldAt":0.8,"contextCap":200000,"spendCap":0.5,"maxRounds":40,"foldModel":"m-fold","foldPrompt":"Fold é \\"well\\".","tune":"{\\"retire_at\\":0.4}"},"abi":1}';
const LIMITS = { window: 1048576, foldAt: 0.8, contextCap: 200000, spendCap: 0.5, maxRounds: 40,
	foldModel: 'm-fold', foldPrompt: 'Fold é "well".', tune: '{"retire_at":0.4}' };

function errandChecks(M) {
	const W = page(M), P = W.DaimondPeer;
	check('K2 setEngineAbi sits beside setEngineId', typeof P.setEngineAbi === 'function');
	if (typeof P.setEngineAbi !== 'function') return;
	P.setEngineAbi(1, 1);
	const model = { provider: 'an', model: 'claude', url: '', workers: { provider: CR, model: 'w' },
		images: { provider: 'lan', model: 'i' } };
	const e = P.makeErrand({ turnId: 't1', chatId: 'c1', prompt: 'hi', model: model, limits: LIMITS,
		sessionRef: { chat: 'c1', sig: 1, upto: 'm1' } });
	const keys = Object.keys(e.keys || {});
	check('K1 the errand carries a key for every own-key source the halves name', keys.join() === 'an,lan', keys.join());
	check('K1 credits are never in keys (I4)', !('credits' in (e.keys || {})));
	const js = JSON.stringify(e);
	check('K1 no plaintext key is in the errand (I1)', !/an-key"|lan-key"|"key":/.test(js), js.slice(-300));
	const ks = Object.keys(e);
	check('K2 abi is the last key, after keys, after sessionRef', ks[ks.length - 1] === 'abi'
		&& ks[ks.length - 2] === 'keys' && ks[ks.length - 3] === 'sessionRef', ks.slice(-4).join());
	check('K2 abi is the page\'s ENGINE_ABI', e.abi === 1, e.abi);
	const c = P.makeErrand({ turnId: 't1', chatId: 'c1', model: { provider: CR, model: 'x' }, limits: LIMITS });
	check('K1 a credits-only errand carries no keys', !('keys' in c));
	check('K2 the limits-and-abi tail is the runner\'s golden errand_abi, byte for byte', JSON.stringify(c).endsWith(GOLD_ABI_TAIL),
		JSON.stringify(c).slice(-120));
	const W0 = page(M);
	const e0 = W0.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: CR, model: 'x' } });
	check('K2 a page with no ABI writes none', !('abi' in e0));
	const ek = P.makeErrand({ turnId: 't', chatId: 'c', model: model, keys: { an: { url: 'https://a/v1', keyEnc: 'S', fetched: 5, key: 'PLAIN' }, credits: { url: 'u', keyEnc: 'S' } } });
	check('K1 keys given are coerced: sealed fields only, credits dropped', JSON.stringify(ek.keys) === '{"an":{"url":"https://a/v1","keyEnc":"S","fetched":5}}',
		JSON.stringify(ek.keys));
}

async function ocrRowChecks() {
	const M = await models(true);
	const add = async (id, url, key) => { M.addProvider(id, { url, name: id.toUpperCase() }); if (key) await M.setKey(id, key); };
	await add(CR, 'https://openrouter.ai/api/v1', 'cr-key');
	await add('an', 'https://api.anthropic.com/v1', 'an-key');
	await add('openrouter', 'https://openrouter.ai/api/v1', 'or-key');
	await add('mistral', 'https://api.mistral.ai/v1', 'mi-key');
	const W = page(M), P = W.DaimondPeer;
	const e = P.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'an', model: 'claude', workers: { provider: CR, model: 'w' } } });
	const keys = Object.keys(e.keys || {});
	check('K11 the halves\' rows first, then his openrouter and mistral rows', keys.join() === 'an,openrouter,mistral', keys.join());
	check('K11 the OCR rows are sealed only', JSON.stringify((e.keys || {}).mistral) === JSON.stringify(M.sealedRow('mistral'))
		&& !/or-key"|mi-key"|"key":/.test(JSON.stringify(e)), JSON.stringify((e.keys || {}).mistral));
	const c = P.makeErrand({ turnId: 't', chatId: 'c', model: { provider: CR, model: 'x' } });
	check('K11 a credits turn carries his OCR rows too, and never credits', Object.keys(c.keys || {}).join() === 'openrouter,mistral'
		&& !('credits' in (c.keys || {})), JSON.stringify(c.keys));
	const o = P.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'openrouter', model: 'x' } });
	check('K11 a half on openrouter names its row once', Object.keys(o.keys || {}).join() === 'openrouter,mistral', JSON.stringify(o.keys));
	const N = await models(true);
	N.addProvider('mistral', { url: 'http://mistral.lan/v1', name: 'M' });
	await N.setKey('mistral', 'mi-key');
	N.addProvider('openrouter', { url: 'https://localhost:8000/v1', name: 'O' });
	await N.setKey('openrouter', 'or-key');
	const n = page(N).DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: CR, model: 'x' } });
	check('K11 an OCR row that does not reach the runner is left out', !('keys' in n), JSON.stringify(n.keys));
}

// QA OKD-A M-2: the errand carries ocr.js's own route for the turn's reads, before abi, and a
// runner pays with credits only where that route names credits.
async function ocrRouteChecks() {
	const at = async (rows, dflt) => {
		const M = await models(true);
		for (const [id, url, key] of rows) { M.addProvider(id, { url, name: id.toUpperCase() }); await M.setKey(id, key); }
		if (dflt) M.setDefault(dflt, 'm1');
		const W = page(M, null, ['ocr.js']);
		W.DaimondPeer.setEngineAbi(1, 1);
		return W;
	};
	const CRROW = [CR, 'https://openrouter.ai/api/v1/chat/completions', 'cr-key'];
	const AN = ['an', 'https://api.anthropic.com/v1/messages', 'an-key'];
	const own = await at([CRROW, AN], 'an');
	const r1 = own.DaimondOcr && own.DaimondOcr.route ? own.DaimondOcr.route() : null;
	check('M2 ocr.js exposes its route', !!r1, String(r1));
	if (!r1) return;
	check('M2 an own-key default off OpenRouter, no openrouter or mistral row: no read is paid',
		r1.pdf === '' && r1.image === '', JSON.stringify(r1));
	const e1 = own.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'an', model: 'm1' } });
	const ks = Object.keys(e1);
	check('M2 the errand carries the route as ocr, before abi, after keys', JSON.stringify(e1.ocr) === '{"pdf":"","image":""}'
		&& ks[ks.length - 1] === 'abi' && ks[ks.length - 2] === 'ocr' && ks[ks.length - 3] === 'keys', ks.slice(-4).join());
	const cr = await at([CRROW, AN], CR);
	const e2 = cr.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: CR, model: 'm1' } });
	check('M2 a default on OpenRouter credits routes both reads to credits, and carries no credits row',
		JSON.stringify(e2.ocr) === '{"pdf":"credits","image":"credits"}' && !('keys' in e2), JSON.stringify(e2));
	const both = await at([CRROW, AN, ['openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'or-key'],
		['mistral', 'https://api.mistral.ai/v1/chat/completions', 'mi-key']], CR);
	const e3 = both.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'an', model: 'm1' } });
	check('M2 his openrouter row pays PDFs, his mistral row reads pictures first',
		JSON.stringify(e3.ocr) === '{"pdf":"openrouter","image":"mistral"}'
		&& Object.keys(e3.keys || {}).join() === 'an,openrouter,mistral', JSON.stringify([e3.ocr, Object.keys(e3.keys || {})]));
	const oth = await at([AN, ['orx', 'https://openrouter.ai/api/v1/chat/completions', 'orx-key']], 'orx');
	const e4 = oth.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'an', model: 'm1' } });
	check('M2 a default of his own on OpenRouter is routed by its id, and its row is sent',
		JSON.stringify(e4.ocr) === '{"pdf":"orx","image":"orx"}' && !!(e4.keys || {}).orx, JSON.stringify([e4.ocr, Object.keys(e4.keys || {})]));
	// UNBLOCK-9 U4: the "Image editing" Jobs pick rides the route that pays for it, so a runner's
	// image_edit uses the model the tab would; with no pick and no catalogue, none is written.
	check('U4 no image pick and no catalogue: the route names no edit model', !('edit' in e2.ocr), JSON.stringify(e2.ocr));
	cr.DaimondModels.setJob('imageEditing', CR, 'bfl/flux-x');
	const e9 = cr.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: CR, model: 'm1' } });
	const k9 = Object.keys(e9);
	check('U4 the image pick rides the errand route as edit, the errand still closing ocr, abi',
		e9.ocr.edit === 'bfl/flux-x' && e9.ocr.pdf === 'credits' && typeof e9.ocr.editPrice === 'string'
		&& k9[k9.length - 1] === 'abi' && k9[k9.length - 2] === 'ocr', JSON.stringify([e9.ocr, k9.slice(-2)]));
	// Lead ruling (ledger l.375): a row the runner cannot reach counts as absent in the errand's
	// route, so a turn that never reads is never handed back for it. The tab's own route keeps it.
	const ORHTTP = ['openrouter', 'http://openrouter.example/api/v1/chat/completions', 'or-key'];
	const MIHTTP = ['mistral', 'http://mistral.example/v1', 'mi-key'];
	const consistent = (e) => [e.ocr.pdf, e.ocr.image].every((p) => !p || p === CR || !!(e.keys || {})[p]);
	const hx = await at([CRROW, AN, ORHTTP, MIHTTP], 'an');
	const e6 = hx.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'an', model: 'm1' } });
	check('R1 the tab still routes its own reads to his http rows', JSON.stringify(hx.DaimondOcr.route()) === '{"pdf":"openrouter","image":"mistral"}',
		JSON.stringify(hx.DaimondOcr.route()));
	check('R1 his http openrouter row, default off OpenRouter: the runner is routed no read, and the errand is consistent',
		JSON.stringify(e6.ocr) === '{"pdf":"","image":""}' && consistent(e6) && Object.keys(e6.keys || {}).join() === 'an',
		JSON.stringify([e6.ocr, Object.keys(e6.keys || {})]));
	const hc = await at([CRROW, AN, ORHTTP], CR);
	const e7 = hc.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'an', model: 'm1' } });
	check('R1 his http openrouter row, default on OpenRouter credits: the runner reads with credits',
		JSON.stringify(e7.ocr) === '{"pdf":"credits","image":"credits"}' && consistent(e7), JSON.stringify([e7.ocr, e7.keys]));
	const hd = await at([AN, ORHTTP], 'openrouter');
	const e8 = hd.DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: 'an', model: 'm1' } });
	check('R1 a default that is his http openrouter row routes the runner no read',
		JSON.stringify(e8.ocr) === '{"pdf":"","image":""}' && consistent(e8), JSON.stringify([e8.ocr, e8.keys]));
	// One Mistral address for tab and runner: the tab posts pictures to his row's /ocr sibling, as
	// models.js siblingUrl, which is what the runner's `sibling` does.
	for (const [url, want] of [['https://eu.mistral.example/v1', 'https://eu.mistral.example/v1/ocr'],
		['https://eu.mistral.example/v1/chat/completions', 'https://eu.mistral.example/v1/ocr']]) {
		const mw = await at([AN, ['mistral', url, 'mi-key']], 'an');
		const posts = [];
		mw.fetch = async (u) => { posts.push(String(u)); return { ok: true, status: 200, text: async () => '{"pages":[]}' }; };
		let got = '';
		try { got = await mw.DaimondOcr.image('{}', '{}'); } catch (err) { got = String(err); }
		check('R2 the tab posts a picture to his mistral row\'s /ocr sibling (' + url + ')',
			posts[0] === want && /"route":"mistral"/.test(got), JSON.stringify([posts, got]));
	}
	// One OpenRouter address for tab and runner: the tab posts PDFs to his row's chat-completions
	// endpoint, as models.js chatUrl, which is what the runner's `LlmClient::from_url` does.
	const pdfPosts = async (W) => {
		const posts = [];
		W.fetch = async (u) => { posts.push(String(u)); return { ok: true, status: 200, text: async () => '{}' }; };
		try { await W.DaimondOcr.chat('{}'); } catch (err) { posts.push(String(err)); }
		return posts;
	};
	for (const [url, want] of [['https://or.example/api/v1', 'https://or.example/api/v1/chat/completions'],
		['https://or.example/api/v1/', 'https://or.example/api/v1/chat/completions'],
		['https://or.example/api/v1/chat/completions', 'https://or.example/api/v1/chat/completions']]) {
		const posts = await pdfPosts(await at([AN, ['openrouter', url, 'or-key']], 'an'));
		check('R3 the tab posts a PDF to his openrouter row\'s chat endpoint (' + url + ')',
			posts.length === 1 && posts[0] === want, JSON.stringify(posts));
	}
	for (const [url, want] of [['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1/chat/completions'],
		['https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1/chat/completions']]) {
		const posts = await pdfPosts(await at([[CR, url, 'cr-key'], AN], CR));
		check('R3 with no openrouter row the credits route still pays PDFs (' + url + ')',
			posts.length === 1 && posts[0] === want, JSON.stringify(posts));
	}
	const e5 = page(await models(true)).DaimondPeer.makeErrand({ turnId: 't', chatId: 'c', model: { provider: CR, model: 'x' } });
	check('M2 a page without ocr.js writes no ocr', !('ocr' in e5), JSON.stringify(e5).slice(-80));
}

function offerChecks(M) {
	const W = page(M), P = W.DaimondPeer;
	if (typeof P.setEngineAbi !== 'function') { check('K3 setEngineAbi exists', false); return; }
	P.setEngineAbi(1, 1);
	W.DaimondPresence.ingest(answer({ abi: 1, abiMin: 1 }), now);
	const snap = W.DaimondPresence.snapshot();
	check('K3 presence carries a runner\'s abi and abiMin', snap.rn && snap.rn.abi === 1 && snap.rn.abiMin === 1, JSON.stringify(snap.rn));
	W.DaimondPresence.ingest(answer({ abi: 0 }), now);
	check('K3 a runner with no ABI carries neither', !('abi' in W.DaimondPresence.snapshot().rn));
	const abi = (o, s) => offer(W, answer(Object.assign({ abi: 1, abiMin: 1 }, o)), s);
	const own = abi({}, ['an']);
	check('K4 an ABI runner is offered on his own key', !!own.runner && own.runner.deviceId === 'rn', JSON.stringify(own));
	const other = abi({ engine: OTHER }, ['an', CR]);
	check('K4 an ABI runner is offered whatever wasm it runs', !!other.runner, JSON.stringify(other));
	// RUNNER-DOOR: a starred runner with no live door, or with no row at all, says why.
	const deaf = abi({ listening: false, doors: 0, heard_at: 0, stated: true }, ['an']);
	check('RUNNER-DOOR a starred runner that does not listen: runner-silent', !deaf.runner && deaf.why === 'runner-silent'
		&& deaf.runnerId === 'rn', JSON.stringify(deaf));
	const gone = offer(W, { tab: { name: 'laptop', last_seen: now, mobile: false } }, ['an']);
	check('RUNNER-DOOR a starred runner with no presence row: runner-silent', !gone.runner && gone.why === 'runner-silent',
		JSON.stringify(gone));
	// SEATWHY-ALL: a starred runner that listens and is still passed over always says why.
	check('SEATWHY-ALL an offered runner names no reason', !own.why, JSON.stringify(own));
	const busy = abi({ busy: 1 }, ['an']);
	// UNBLOCK-57: a native runner is never passed over for the busy its machine's tabs beat.
	check('SEATWHY-ALL a starred runner on a busy machine is offered', !!busy.runner && !busy.why, JSON.stringify(busy));
	const phone = abi({ mobile: true }, ['an']);
	check('SEATWHY-ALL a starred runner that is a phone: runner-phone', !phone.runner && phone.why === 'runner-phone',
		JSON.stringify(phone));
	const req = offer(W, answer({ abi: 1, abiMin: 1 }), ['an'], { needFolder: true });
	check('SEATWHY-ALL a starred runner without the chat\'s folder: runner-require', !req.runner
		&& req.why === 'runner-require' && req.require === 'folder', JSON.stringify(req));
	const none = abi({}, []);
	check('SEATWHY-ALL a turn with no source at all: runner-nosource', !none.runner && none.why === 'runner-nosource',
		JSON.stringify(none));
	W.DaimondPresence.ingest(answer({}), now);
	W.DaimondPeer.setEngineId('');
	const unk = W.DaimondPeer.seatSwitch({ id: 'c1', model: 'm', provider: CR }, W.DaimondPresence.snapshot(),
		{ selfId: 'me', runnerOnly: true, nominatedId: 'rn', sources: [CR], freshWindowMs: W.DaimondPeer.DISPATCH_FRESH_MS }, now);
	check('SEATWHY-ALL a legacy runner before this page knows its engine: runner-unchecked', !unk.runner
		&& unk.why === 'runner-unchecked', JSON.stringify(unk));
	const lan = abi({}, ['lan', CR]);
	check('K4 an ABI runner is offered a LAN https source', !!lan.runner, JSON.stringify(lan));
	const http = abi({}, ['http']);
	check('K4 http is not offered, and SEATWHY names the source and the reason',
		!http.runner && http.why === 'runner-source' && http.source === 'http' && http.reach === 'https', JSON.stringify(http));
	const loop = abi({}, [CR, 'loop']);
	check('K4 a loopback half is not offered: on this device', !loop.runner && loop.why === 'runner-source'
		&& loop.source === 'loop' && loop.reach === 'device', JSON.stringify(loop));
	const old = abi({ abi: 2, abiMin: 2 }, [CR]);
	check('K4 a runner whose min is past the page\'s ABI is not offered: runner-engine',
		!old.runner && old.why === 'runner-engine', JSON.stringify(old));
	P.setEngineAbi(3, 2);
	const behind = abi({ abi: 1, abiMin: 1 }, [CR]);
	check('K4 a runner below the page\'s min is not offered: runner-engine', !behind.runner && behind.why === 'runner-engine', JSON.stringify(behind));
	const range = abi({ abi: 2, abiMin: 1 }, [CR]);
	check('K4 a runner inside the two-sided range is offered', !!range.runner, JSON.stringify(range));
	P.setEngineAbi(1, 1);
	// The legacy branch: the old binary's capability.
	const lc = offer(W, answer(), [CR]);
	check('K4 a legacy runner on the same wasm is offered credits', !!lc.runner, JSON.stringify(lc));
	const lo = offer(W, answer(), ['an']);
	check('K4 a legacy runner is not offered his key: runner-credits-only', !lo.runner && lo.why === 'runner-credits-only', JSON.stringify(lo));
	const lm = offer(W, answer(), [CR, 'an']);
	check('K4 a legacy runner is not offered a set with any own-key half', !lm.runner && lm.why === 'runner-credits-only', JSON.stringify(lm));
	const le = offer(W, answer({ engine: OTHER }), [CR]);
	check('K4 a legacy runner on another wasm: runner-engine', !le.runner && le.why === 'runner-engine', JSON.stringify(le));
	check('K4 sourcesOf reads the pid set across the halves', typeof P.sourcesOf === 'function'
		&& P.sourcesOf({ sources: ['an', CR, 'an', ''] }).join() === 'an,credits' && P.sourcesOf({ provider: CR }).join() === CR);

	// M2: a passphrase change strands his keys on the runner until it is re-approved.
	const hb = { t: 'report', status: 'undeliverable', cause: 'keys', by: 'rn', turnId: 't9', chatId: 'c1',
		why: 're-approve argonaut after a passphrase change' };
	check('K6 the passphrase hand-back is read as such', typeof P.rekeyFrom === 'function' && P.rekeyFrom(hb) === 'rn'
		&& P.rekeyFrom(Object.assign({}, hb, { why: 'seal did not open' })) === '' && P.rekeyFrom(Object.assign({}, hb, { cause: 'thread' })) === '');
	if (typeof P.noteRekey === 'function') {
		P.noteRekey('rn');
		const mk = abi({}, ['an']);
		check('K6 M2: own-key sources are not offered after a passphrase change',
			!mk.runner && mk.why === 'runner-rekey', JSON.stringify(mk));
		const mc = abi({}, [CR]);
		check('K6 M2: credits still are', !!mc.runner, JSON.stringify(mc));
		const W2 = page(M, W._ls);
		W2.DaimondPeer.setEngineAbi(1, 1);
		const re = offer(W2, answer({ abi: 1, abiMin: 1 }), ['an']);
		check('K6 M2: the mark outlives a reload', !re.runner && re.why === 'runner-rekey', JSON.stringify(re));
		P.clearRekey('rn');
		const back = abi({}, ['an']);
		check('K6 M2: re-approval offers his keys again', !!back.runner, JSON.stringify(back));
		// QA-B F2: a mark set before any runner-pair list was read takes its generation from the
		// gateway's next list, never this device's clock, which may run ahead of the gateway's.
		const g0 = Math.floor(Date.now() / 1000) - 3600;	// the gateway's clock, an hour behind
		P.noteRekey('rk');
		check('K6b M2: the first list after the mark names its generation, and does not clear it',
			P.rekeyApproved([{ device: 'rk', state: 'active', approved: g0 }]) === false && P.rekeyed('rk'));
		check('K6b M2: a re-approval after it clears the mark under clock skew',
			P.rekeyApproved([{ device: 'rk', state: 'active', approved: g0 + 5 }]) === true && !P.rekeyed('rk'));
	} else check('K6 M2 marks exist', false);

	// H3: a report below the page's min is not applied.
	const pres = { rn: { kind: 'runner', abi: 1, abiMin: 1 }, leg: { kind: 'runner' }, tab: {} };
	const ok = (r) => (typeof P.reportAbiOk === 'function' ? P.reportAbiOk(r, pres) : 'none');
	P.setEngineAbi(2, 2);
	check('K7 a runner report below the page\'s min is refused', ok({ by: 'rn', abi: 1 }) === false, ok({ by: 'rn', abi: 1 }));
	check('K7 an ABI runner\'s report naming no ABI is refused', ok({ by: 'rn' }) === false);
	check('K7 a report at the min is applied', ok({ by: 'rn', abi: 2 }) === true);
	check('K7 a tab\'s and a legacy runner\'s report are applied', ok({ by: 'tab' }) === true && ok({ by: 'leg' }) === true);
	// A2: the same rule for a frame, by the runner its lease names; a frame naming an ABI is an
	// ABI runner's whoever holds the lease.
	const fok = (a, by) => (typeof P.abiOk === 'function' ? P.abiOk(a, by, pres) : 'none');
	check('K10 abiOk: an ABI runner\'s frame below the min, or naming none, is refused', fok(1, 'rn') === false && fok(0, 'rn') === false,
		[fok(1, 'rn'), fok(0, 'rn')]);
	check('K10 abiOk: a frame at the min is taken', fok(2, 'rn') === true);
	check('K10 abiOk: a legacy runner\'s and a tab\'s frame are taken', fok(0, 'leg') === true && fok(0, 'tab') === true);
	check('K10 abiOk: a frame naming an ABI below the min is refused, its runner unknown', fok(1, '') === false && fok(0, '') === true,
		[fok(1, ''), fok(0, '')]);
	P.setEngineAbi(1, 1);
}

// ── A2: sync.js hands a frame's abi to the page ─────────────────
async function syncFrameChecks() {
	const L = lift(source('sync.js'), ['getProgressFrame'], []);
	check('K10 getProgressFrame is there', L.missing.length === 0, L.missing.join());
	if (L.missing.length) return;
	let sealed = null;
	const ctx = vm.createContext({
		ready: () => true, entitled: true, sessionGone: false, WAKE_ID: 'w1', PULL_TIMEOUT_MS: 1,
		call: async () => ({ status: 200, json: { seq: 7, blob: 'B' } }),
		progUnseal: async () => sealed,
	});
	const get = vm.runInContext(L.body + ';getProgressFrame', ctx);
	sealed = { turn: 't1', seq: 1, tail: 'x', final: true, abi: 3 };
	const a = await get('t1', 0);
	check('K10 a runner\'s frame keeps its abi', !!a && a.abi === 3 && a.final === true && a.seq === 7, JSON.stringify(a));
	sealed = { turn: 't1', seq: 1, tail: 'x', final: true };
	const b = await get('t1', 0);
	check('K10 a frame naming none reads abi 0', !!b && b.abi === 0, JSON.stringify(b));
}

// ── daimond.js, the page half ───────────────────────────────────
function pageChecks() {
	const NAMES = ['electSources', 'seatReason', 'seatWhyKey', 'bookReportCost', 'handBackNote', 'wasmEngineAbi'];
	const L = lift(source('daimond.js'), NAMES, []);
	check('K6 the page functions are there', L.missing.length === 0, L.missing.join());
	if (L.missing.length) return;
	const booked = [];
	const ctx = vm.createContext({
		console,
		t: (k, o) => k + (o ? JSON.stringify(o) : ''),
		tOr: (k, d) => d,
		deviceLabelFor: (id) => (id === 'rn' ? 'argonaut' : ''),
		errandModelOf: (c) => c.model,
		chats: [{ id: 'c1', model: { provider: 'an', model: 'claude', workers: { provider: CR, model: 'w' }, images: { provider: '', model: '' } } }],
		DaimondModels: { CREDITS: CR, providerName: (id) => id.toUpperCase() },
		DaimondLedger: { record: (x) => { booked.push(x); return x; } },
		diag: () => {},
	});
	ctx.window = ctx;
	const api = vm.runInContext(L.body + ';({' + NAMES.map((n) => n + ':' + n).join(',') + '})', ctx);
	// The reason's sentence, as the seat switch draws it (sourcemenu.js).
	const whyText = (sw) => { const r = api.seatReason(api.seatWhyKey(sw)); return r ? r.why : ''; };
	check('K4 electSources is the pid set across the halves', api.electSources(ctx.chats[0]).join() === 'an,credits',
		api.electSources(ctx.chats[0]).join());
	const src = whyText({ why: 'runner-source', runnerId: 'rn', source: 'http', reach: 'https' });
	check('K6 runner-source names the runner, the provider and the reason', /^seat\.why_runner_source/.test(src)
		&& src.indexOf('"name":"argonaut"') > 0 && src.indexOf('"provider":"HTTP"') > 0 && src.indexOf('seat.reach_https') > 0, src);
	check('K6 runner-engine says it updates itself', whyText({ why: 'runner-engine', runnerId: 'rn' }).indexOf('seat.why_runner_engine') === 0);
	check('K6 runner-rekey asks for re-approval', whyText({ why: 'runner-rekey', runnerId: 'rn' }).indexOf('seat.why_runner_rekey') === 0);
	check('K6 the legacy reason keeps its line', whyText({ why: 'runner-credits-only', runnerId: 'rn' }).indexOf('seat.why_runner_credits') === 0);
	check('RUNNER-DOOR runner-silent says it is not listening', whyText({ why: 'runner-silent', runnerId: 'rn' }).indexOf('seat.why_runner_quiet') === 0);
	check('TRUTH runner-unchecked has its line', whyText({ why: 'runner-unchecked', runnerId: 'rn' }).indexOf('seat.why_runner_unchecked') === 0,
		whyText({ why: 'runner-unchecked', runnerId: 'rn' }));
	check('TRUTH page-old has its line', whyText({ why: 'page-old', runnerId: 'rn' }).indexOf('seat.why_page_old') === 0,
		whyText({ why: 'page-old', runnerId: 'rn' }));
	for (const [why, key] of [['runner-busy', 'busy'], ['runner-phone', 'phone'], ['runner-require', 'require'],
		['runner-nosource', 'nosource']]) {
		check('SEATWHY-ALL ' + why + ' has its line', whyText({ why: why, runnerId: 'rn' }).indexOf('seat.why_runner_' + key) === 0,
			whyText({ why: why, runnerId: 'rn' }));
	}
	check('K6 no reason, no line', whyText({}) === '' && whyText(null) === '');
	check('K7 an abi hand-back says the runner runs another version', api.handBackNote('abi', 'argonaut').indexOf('seat.why_runner_engine') === 0,
		api.handBackNote('abi', 'argonaut'));
	check('K6 a keys hand-back keeps the runner\'s own words', api.handBackNote('keys', 'argonaut', 're-approve argonaut after a passphrase change')
		.indexOf('re-approve argonaut after a passphrase change') >= 0, api.handBackNote('keys', 'argonaut', 'x'));
	const n = api.bookReportCost({ t: 'report', status: 'done', turnId: 't1', chatId: 'c1', ts: 1760000600000,
		cost: { usd: 0.5, by: { an: 0.4, credits: 0.1 } } });
	check('K8 cost.by books each own-key source to its pool, credits left to the gateway meter', n === 1 && booked.length === 1
		&& booked[0].provider === 'an' && booked[0].costUsd === 0.4 && booked[0].ts === 1760000600000 && booked[0].turnId === 't1'
		&& booked[0].model === 'claude', JSON.stringify(booked));
	// The wasm's one export (`engine_abi`, src/wasm/entry.rs) hands back `[abi, min]` as a Uint32Array.
	const abiOf = (W) => JSON.stringify(api.wasmEngineAbi(W));
	check('K2 engine_abi() is read as [abi, min]', abiOf({ engine_abi: () => new Uint32Array([3, 2]) }) === '[3,2]',
		abiOf({ engine_abi: () => new Uint32Array([3, 2]) }));
	check('K2 a wasm with no engine_abi is legacy, 0/0', abiOf({}) === '[0,0]' && abiOf(null) === '[0,0]');
	check('K2 a malformed engine_abi is legacy, 0/0', [
		{ engine_abi: () => 3 },
		{ engine_abi: () => new Uint32Array([3]) },
		{ engine_abi: () => [3, 2, 1] },
		{ engine_abi: () => [2, 3] },
		{ engine_abi: () => ['x', 1] },
		{ engine_abi: () => { throw new Error('no'); } },
		{ engine_abi: 7 },
	].every((W) => abiOf(W) === '[0,0]'));
	check('K2 the page reads no engine_abi_min', source('daimond.js').indexOf('engine_abi_min') < 0);
	const n2 = api.bookReportCost({ t: 'report', status: 'done', turnId: 't2', chatId: 'c1', ts: 1, cost: { usd: 0.1 } });
	check('K8 a report with no cost.by books nothing', n2 === 0 && booked.length === 1);
	// QA-B F5: the same report booked twice (two collects, a re-read) is one entry in the REAL
	// ledger: its key is (t, model, tokens, provider), and every booking of one report gives the same.
	const ls = new Map();
	const lctx = vm.createContext({ console, localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null),
		setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) }, dispatchEvent: () => true });
	lctx.window = lctx;
	loadStore(lctx, lctx.localStorage);
	vm.runInContext(source('ledger.js'), lctx);
	ctx.DaimondLedger = lctx.DaimondLedger;
	const rep = { t: 'report', status: 'done', turnId: 't3', chatId: 'c1', ts: 1760000900000, cost: { usd: 0.3, by: { an: 0.3 } } };
	api.bookReportCost(rep);
	api.bookReportCost(JSON.parse(JSON.stringify(rep)));
	const held = lctx.DaimondLedger.entries().filter((e) => e.tid === 't3');
	check('K8b a repeated booking of one report is dropped by the ledger key', held.length === 1 && held[0].u === 0.3
		&& held[0].pv === 'an' && held[0].m === 'claude', JSON.stringify(held));
	// cost.models: a report booked after the chat switched model books once, under the model it ran.
	ctx.chats[0].model = Object.assign({}, ctx.chats[0].model, { model: 'claude-next' });
	const ran = { t: 'report', status: 'done', turnId: 't4', chatId: 'c1', ts: 1760000950000,
		cost: { usd: 0.2, by: { an: 0.2 }, models: { an: 'claude' } } };
	api.bookReportCost(ran);
	api.bookReportCost(JSON.parse(JSON.stringify(ran)));
	const ranHeld = lctx.DaimondLedger.entries().filter((e) => e.tid === 't4');
	check('K8b a report booked after a model switch books once, under the model it ran', ranHeld.length === 1
		&& ranHeld[0].u === 0.2 && ranHeld[0].pv === 'an' && ranHeld[0].m === 'claude', JSON.stringify(ranHeld));
	const fell = { t: 'report', status: 'done', turnId: 't5', chatId: 'c1', ts: 1760000960000, cost: { usd: 0.1, by: { an: 0.1 } } };
	api.bookReportCost(fell);
	const fellHeld = lctx.DaimondLedger.entries().filter((e) => e.tid === 't5');
	check('K8b a report with no cost.models falls back to the chat\'s model', fellHeld.length === 1
		&& fellHeld[0].m === 'claude-next', JSON.stringify(fellHeld));
	check('K6 an oversize hand-back keeps the runner\'s own words', api.handBackNote('oversize', 'argonaut',
		'The answer was too large to send back (3 MB, the most is 2 MB).').indexOf('too large') >= 0,
		api.handBackNote('oversize', 'argonaut', 'x'));
}

function stringChecks() {
	const KEYS = ['seat.why_runner_source', 'seat.why_runner_rekey', 'seat.why_runner_engine',
		'seat.reach_https', 'seat.reach_device', 'seat.reach_unlock', 'seat.reach_nokey'];
	const dir = join(HERE, '..', 'i18n');
	for (const f of ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans']) {
		const s = readPage(join(dir, f + '.js'), 'utf8');
		const lack = KEYS.filter((k) => s.indexOf("'" + k + "'") < 0);
		check('K6 ' + f + ' has every new seat string', lack.length === 0, lack.join());
	}
	const en = readPage(join(dir, 'en.js'), 'utf8');
	check('K6 runner-engine: it updates itself', /'seat\.why_runner_engine':\s*'\{name\} runs another Daimond version; it updates itself\.'/.test(en));
}

function menuChecks() {
	const src = source('daimond.js');
	const body = (name) => { const m = new RegExp('function ' + name + '\\((?:e|ev)\\) \\{([\\s\\S]*?)\\n\\t+\\}|function ' + name + '\\((?:e|ev)\\) \\{([^\\n]*)\\}').exec(src); return m ? (m[1] || m[2]) : ''; };
	check('K9 the Chats menu leaves its button to toggle it', /chats-menu-btn|_chatsAnchor/.test(body('onChatsMenuOutside')), body('onChatsMenuOutside').trim());
	check('K9 the files panel menu leaves its anchor to toggle it', /anchor/.test(body('onPopOutside')), body('onPopOutside').trim());
	check('K9 the fold picker leaves its anchor to toggle it', /_foldAnchor/.test(body('onFoldOutside')), body('onFoldOutside').trim());
	check('K9 the tag menu leaves anything inside its anchor', /anchor\.contains/.test(body('onTagMoreOutside')), body('onTagMoreOutside').trim());
	check('K9 the fold picker shuts on a second press of its anchor', /_foldMenu && _foldAnchor === anchor/.test(src));
	check('K9 an empty source reads Credits, not "Pays with"', !/nm\.textContent = name \|\| t\('composer\.source'\)/.test(src)
		&& /nm\.textContent = name \|\| t\('astat\.credits'\)/.test(src));
}

// SEAT-LABELS truth (owner, 25 Oct ~18:2x: "I can't click argonaut"): the seat line read
// "argonaut takes Daimond-credits chats only" on his own-key chat while argonaut's row carried
// abi 1, because the page's own ABI was 0. An ABI unknown on either side is "not checked yet",
// never the legacy case, and the offer is decided again once the ABI arrives.
function truthChecks(M) {
	const W = page(M), P = W.DaimondPeer;
	// His state: argonaut's row names abi 1, his chat is on his own key, this page has not read its ABI.
	const his = offer(W, answer({ abi: 1, abiMin: 1 }), ['an']);
	check('TRUTH an ABI runner before this page knows its ABI is not checked yet, not credits-only',
		!his.runner && his.why === 'runner-unchecked' && his.runnerId === 'rn', JSON.stringify(his));
	P.setEngineAbi(1, 1);
	const then = offer(W, answer({ abi: 1, abiMin: 1 }), ['an']);
	check('TRUTH once the ABI arrives the same runner is offered on his own key', !!then.runner
		&& then.runner.deviceId === 'rn' && !then.why, JSON.stringify(then));
	// A row that names no ABI and no engine: its build is not known either.
	const bare = offer(W, answer({ engine: '' }), ['an']);
	check('TRUTH a runner row with no ABI and no engine id is not checked yet', !bare.runner
		&& bare.why === 'runner-unchecked', JSON.stringify(bare));
	// The legacy reason is true only for a row that truly names no ABI while the page knows its own.
	const leg = offer(W, answer(), ['an']);
	check('TRUTH a row naming no ABI, page ABI known: the legacy credits-only reason',
		!leg.runner && leg.why === 'runner-credits-only', JSON.stringify(leg));
	// A page whose wasm predates the ABI (it read 0) facing an ABI runner: the page is behind.
	const W2 = page(M), P2 = W2.DaimondPeer;
	P2.setEngineAbi(0, 0);
	const stale = offer(W2, answer({ abi: 1, abiMin: 1 }), ['an']);
	check('TRUTH a page below the runner-offer ABI says the page is behind, not credits-only',
		!stale.runner && stale.why === 'page-old' && stale.runnerId === 'rn', JSON.stringify(stale));
	const lc = offer(W2, answer({ abi: 1, abiMin: 1 }), [CR]);
	check('TRUTH a legacy page still hands credits to a runner on its own wasm (the legacy rule)', !!lc.runner,
		JSON.stringify(lc));
	// Before the page reads its ABI an ABI runner is not offered at all, credits or not.
	const W3 = page(M);
	const early = offer(W3, answer({ abi: 1, abiMin: 1 }), [CR]);
	check('TRUTH an ABI runner is not offered credits before the page knows its ABI', !early.runner
		&& early.why === 'runner-unchecked', JSON.stringify(early));
	check('TRUTH engineAbiKnown reports the page side', typeof P.engineAbiKnown === 'function'
		&& P.engineAbiKnown() === true && page(M).DaimondPeer.engineAbiKnown() === false);
}

const M = await reachChecks();
errandChecks(M);
await ocrRowChecks();
await ocrRouteChecks();
offerChecks(M);
truthChecks(M);
pageChecks();
await syncFrameChecks();
stringChecks();
menuChecks();
console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
