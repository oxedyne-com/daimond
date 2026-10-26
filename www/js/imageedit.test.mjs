/* ============================================================
   Test — the image tool's tab half (UNBLOCK-9, D-20261014-06
   "colourise Rozina.jpg").
   ------------------------------------------------------------
     I1  THE ROUTE. `DaimondOcr.images(body)` posts the body to
         `/images` beside his openrouter row's chat endpoint, with
         his key, and resolves the raw reply.
     I2  A LINK IS FETCHED. A reply whose picture is a `url` comes
         back with the picture's bytes in `b64_json`.
     I3  NO KEY. With no OpenRouter route, it refuses in words that
         say what is needed, and posts nothing.
     I4  THE DEFAULT. With no pick, the Image editing model is the
         cheapest PRICED model that takes a picture in: a
         text->image-only model, a token-priced one and a google/
         one are never it; the account's makers come first.
     I5  THE PICK. A Jobs pick wins over the computed default.
     I6  THE CATALOGUE. `imageModel()` fetches `/images/models` and
         each candidate's own `endpoints`, never a google/ one's.

   No browser: stand-ins cover what each module touches.
     node www/js/imageedit.test.mjs
   ============================================================ */
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { source } from './testlift.mjs';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + String(detail).slice(0, 300) + ')' : '')); failures++; }
}

async function models() {
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
	ctx.DaimondIdentity = { isUnlocked: () => true, wrap: async (k) => 'SEALED(' + k + ')',
		unwrap: async (e) => String(e).replace(/^SEALED\(|\)$/g, '') };
	ctx.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) });
	vm.runInContext(source('stamp.js'), ctx);
	vm.runInContext(source('models.js'), ctx);
	const M = ctx.DaimondModels;
	M.init({ onChange: () => {} });
	return M;
}

/// ocr.js in a window holding `M`, its `fetch` answered by `answer(url, opts)`.
function ocr(M, answer) {
	const win = { DaimondModels: M, URL, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), posts: [] };
	win.fetch = async (u, o) => { win.posts.push({ url: String(u), opts: o || {} }); return answer(String(u), o || {}); };
	new Function('window', 'with (window) {\n' + readFileSync(join(HERE, 'ocr.js'), 'utf8') + '\n}')(win);
	return win;
}

const text = (body, ok = true, status = 200) => ({ ok, status, text: async () => body, json: async () => JSON.parse(body) });

// The catalogue's shapes, as OpenRouter's Image API listed them on 26 Oct 2026.
const refs = (max) => ({ input_references: { type: 'range', min: 0, max } });
const MODELS = [
	{ id: 'acme/cheap-t2i',   name: 'T2I',   architecture: { output_modalities: ['image'] }, supported_parameters: {}, endpoints: '/api/v1/images/models/acme/cheap-t2i/endpoints' },
	{ id: 'google/nano',      name: 'Nano',  architecture: { output_modalities: ['image'] }, supported_parameters: refs(4), endpoints: '/api/v1/images/models/google/nano/endpoints' },
	{ id: 'acme/tokens',      name: 'Tok',   architecture: { output_modalities: ['image'] }, supported_parameters: refs(2), endpoints: '/api/v1/images/models/acme/tokens/endpoints' },
	{ id: 'bfl/klein',        name: 'Klein', architecture: { output_modalities: ['image'] }, supported_parameters: refs(4), endpoints: '/api/v1/images/models/bfl/klein/endpoints' },
	{ id: 'seed/dream',       name: 'Dream', architecture: { output_modalities: ['image'] }, supported_parameters: refs(10), endpoints: '/api/v1/images/models/seed/dream/endpoints' },
];
const priced = (unit, usd) => ({ endpoints: [{ pricing: [{ billable: 'input_image', unit: 'image', cost_usd: 0 },
	{ billable: 'output_image', unit, cost_usd: usd }] }] });
const ENDPOINTS = {
	'acme/cheap-t2i': priced('image', 0.001),
	'google/nano':    priced('image', 0.002),
	'acme/tokens':    { endpoints: [{ pricing: [{ billable: 'output_image', unit: 'token', cost_usd: 0.0000001 }] }] },
	'bfl/klein':      priced('image', 0.008),
	'seed/dream':     priced('megapixel', 0.018),
};

async function orRow() {
	const M = await models();
	M.addProvider('openrouter', { url: 'https://openrouter.ai/api/v1/chat/completions', name: 'OpenRouter' });
	await M.setKey('openrouter', 'or-key');
	return M;
}

async function routeChecks() {
	const M = await orRow();
	const W = ocr(M, () => text('{"created":0,"data":[{"b64_json":"QUJD","media_type":"image/jpeg"}]}'));
	const got = await W.DaimondOcr.images('{"model":"x"}');
	const p = W.posts[0] || { opts: {} };
	check('I1 posts to /images beside his chat endpoint', p.url === 'https://openrouter.ai/api/v1/images', p.url);
	check('I1 with his key and the body as given', /or-key/.test(JSON.stringify(p.opts.headers)) && p.opts.body === '{"model":"x"}',
		JSON.stringify(p.opts));
	check('I1 resolves the raw reply', /"b64_json":"QUJD"/.test(got), got);

	const L = ocr(M, (u) => u === 'https://cdn.example/p.png'
		? { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([65, 66, 67]).buffer }
		: text('{"data":[{"url":"https://cdn.example/p.png"}]}'));
	const linked = JSON.parse(await L.DaimondOcr.images('{}'));
	check('I2 a linked picture is fetched into b64_json', linked.data[0].b64_json === 'QUJD' && !linked.data[0].url
		&& L.posts[1] && L.posts[1].url === 'https://cdn.example/p.png', JSON.stringify([linked, L.posts.map((x) => x.url)]));

	const N = ocr(await models(), () => text('{}'));
	let why = '';
	try { await N.DaimondOcr.images('{}'); } catch (e) { why = String(e.message || e); }
	check('I3 no route: refused in words, nothing posted', /OpenRouter key or Daimond credits/.test(why) && N.posts.length === 0, why);
}

async function ruleChecks() {
	const M = await models();
	const prices = {};
	for (const m of MODELS) { const p = M.imagePrice(ENDPOINTS[m.id]); if (p) prices[m.id] = p; }
	check('I4 a token-priced model has no price', !prices['acme/tokens'], JSON.stringify(prices['acme/tokens']));
	check('I4 the price is the output picture', prices['bfl/klein'] && prices['bfl/klein'].usd === 0.008
		&& prices['seed/dream'].unit === 'megapixel', JSON.stringify(prices));
	const best = M.cheapestImage(MODELS, prices);
	check('I4 the cheapest priced picture-taker, never text->image only, never google/', best && best.id === 'bfl/klein',
		JSON.stringify(best));
	check('I4 none priced: no default', M.cheapestImage(MODELS, {}) === null);
	// A maker the account already thinks with comes first, as cheapestSeeing.
	M.addProvider('or2', { url: 'https://openrouter.ai/api/v1', name: 'OR' });
	await M.setKey('or2', 'k');
	M.setDefault('or2', 'seed/chat-1');
	const fam = M.cheapestImage(MODELS, prices);
	check('I4 the account\'s own maker first', fam && fam.id === 'seed/dream', JSON.stringify(fam));
}

async function catalogueChecks() {
	const M = await orRow();
	const W = ocr(M, (u) => {
		if (u === 'https://openrouter.ai/api/v1/images/models') return text(JSON.stringify({ data: MODELS }));
		const id = Object.keys(ENDPOINTS).find((k) => u === 'https://openrouter.ai/api/v1/images/models/' + k + '/endpoints');
		return id ? text(JSON.stringify(ENDPOINTS[id])) : text('{}', false, 404);
	});
	const got = JSON.parse(await W.DaimondOcr.imageModel());
	check('I6 the default comes from the catalogue', got.id === 'bfl/klein' && got.price === 'models.image_per_image',
		JSON.stringify(got));
	const asked = W.posts.map((p) => p.url);
	check('I6 the list, then each picture-taker\'s endpoints, never google/\'s', asked[0] === 'https://openrouter.ai/api/v1/images/models'
		&& asked.some((u) => /bfl\/klein\/endpoints$/.test(u)) && !asked.some((u) => /google/.test(u))
		&& !asked.some((u) => /cheap-t2i/.test(u)), asked.join(' '));
	M.setJob('imageEditing', 'openrouter', 'google/nano');
	const n = W.posts.length;
	const pick = JSON.parse(await W.DaimondOcr.imageModel());
	check('I5 his pick wins, google/ included, with no second fetch', pick.id === 'google/nano' && W.posts.length === n,
		JSON.stringify(pick));
}

/// U5, "colourise Rozina.jpg" on the tab's route against the real mock (`dev/mockllm.mjs` on a
/// free port): the default comes from the mock's catalogue, the edit is one POST to `/images`
/// beside his row, and the reply's picture is the mock's bytes, inline.
async function mockChecks() {
	const dir = mkdtempSync(join(tmpdir(), 'imageedit-'));
	const mock = spawn(process.execPath, [join(HERE, '..', '..', 'dev', 'mockllm.mjs'), '0'],
		{ env: Object.assign({}, process.env, { DAIMOND_MOCK_LOG: join(dir, 'mock.log') }), stdio: ['ignore', 'pipe', 'inherit'] });
	try {
		const port = await new Promise((ok, no) => {
			let out = '';
			mock.stdout.on('data', (b) => { out += b; const m = /127\.0\.0\.1:(\d+)\//.exec(out); if (m) ok(Number(m[1])); });
			mock.on('exit', (c) => no(new Error('mockllm exited ' + c)));
		});
		const M = await models();
		M.addProvider('openrouter', { url: 'http://127.0.0.1:' + port + '/api/v1/chat/completions', name: 'OpenRouter' });
		await M.setKey('openrouter', 'or-key');
		const win = { DaimondModels: M, URL, btoa: (s) => Buffer.from(s, 'binary').toString('base64'), fetch };
		new Function('window', 'with (window) {\n' + readFileSync(join(HERE, 'ocr.js'), 'utf8') + '\n}')(win);
		const pick = JSON.parse(await win.DaimondOcr.imageModel());
		check('U5 the default is the mock catalogue\'s priced picture-taker', pick.id === 'mock/image-edit'
			&& pick.price === 'models.image_per_image', JSON.stringify(pick));
		const rozina = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x52, 0x4F, 0x5A]).toString('base64');	// "Rozina.jpg"
		const body = JSON.stringify({ model: pick.id, prompt: 'colourise, period-accurate',
			input_references: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + rozina } }],
			response_format: 'b64_json' });
		const reply = JSON.parse(await win.DaimondOcr.images(body));
		const got = Buffer.from(String((reply.data && reply.data[0] && reply.data[0].b64_json) || ''), 'base64');
		check('U5 colourise Rozina.jpg: the mock\'s picture comes back inline', got.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
			&& got.toString('latin1').includes('Comment\0MOCK-COLOUR'), got.toString('hex'));
		const rows = readFileSync(join(dir, 'mock.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
			.filter((r) => r.imageEdit);
		check('U5 one edit reached the mock, with the instruction and one picture', rows.length === 1
			&& rows[0].prompt === 'colourise, period-accurate' && rows[0].pictures === 1 && rows[0].model === 'mock/image-edit',
			JSON.stringify(rows));
	} finally {
		mock.kill();
		rmSync(dir, { recursive: true, force: true });
	}
}

await routeChecks();
await ruleChecks();
await catalogueChecks();
await mockChecks();
console.log(checks + ' checks, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
