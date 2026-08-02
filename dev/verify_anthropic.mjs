// verify_anthropic.mjs — is Anthropic actually selectable, and does the request it
// produces have the shape Anthropic accepts?
//
// A direct Anthropic transport was added and nothing could reach it: the provider
// was not in the picker at all. Two things then went wrong the moment it was, and
// both had the same cause — daimond.js carried its own copy of two rules that
// models.js already knows properly:
//
//   - the listing endpoint. Anthropic's `/v1/models` is a SIBLING of `/v1/messages`,
//     so appending `/models` asked `/v1/messages/models`, which is nobody's
//     endpoint and 404s.
//   - the auth header. Anthropic refuses a bearer token; it wants `x-api-key`, a
//     pinned version, and the header that makes its edge answer a browser at all.
//     A hardcoded `Authorization: Bearer` got a 401 and read as a bad key.
//
// So this asserts the ADDRESS AND HEADERS ON THE WIRE, intercepted at the browser,
// not what the app believes it sent. Needs dev/serve.mjs (:8777).
import { open, errors } from './harness.mjs';

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name + (detail ? ' — ' + detail : ''));
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const s = await open({ name: 'anthropic', connect: false });
const p = s.page;

// Anthropic is never actually called: the route is intercepted and answered here,
// so no key, no network and no cost are involved in finding out what was sent.
const seen = [];
await p.route('**://api.anthropic.com/**', async (route) => {
	const req = route.request();
	seen.push({ url: req.url(), method: req.method(), headers: req.headers() });
	await route.fulfill({
		status: 200,
		contentType: 'application/json',
		headers: { 'access-control-allow-origin': '*' },
		body: JSON.stringify({ data: [{ id: 'claude-opus-5' }, { id: 'claude-haiku-5' }] }),
	});
});

// ── The picker offers it ───────────────────────────────────────────────────

await p.evaluate(() => {
	const open = document.getElementById('settings-btn') || document.querySelector('[data-admin="settings"]');
	if (open) open.click();
});
await p.waitForTimeout(400);

const options = await p.evaluate(() => {
	const sel = document.getElementById('cfg-provider');
	return sel ? [...sel.options].map(o => ({ value: o.value, label: o.textContent })) : [];
});
check('Anthropic is in the provider picker',
	options.some(o => o.value === 'anthropic'), options.map(o => o.value).join(', '));

// ── Choosing it fills in the right endpoint ────────────────────────────────

await p.evaluate(() => {
	const sel = document.getElementById('cfg-provider');
	sel.value = 'anthropic';
	sel.dispatchEvent(new Event('change', { bubbles: true }));
});
await p.waitForTimeout(300);
const base = await p.evaluate(() => (document.getElementById('cfg-base-url') || {}).value || '');
check('choosing it fills in the messages endpoint', /api\.anthropic\.com\/v1\/messages$/.test(base), base);

// ── Typing a key makes the app go and list the models ──────────────────────

await p.evaluate(() => {
	const k = document.getElementById('cfg-api-key');
	k.value = 'sk-ant-not-a-real-key';
	k.dispatchEvent(new Event('input', { bubbles: true }));
	k.dispatchEvent(new Event('change', { bubbles: true }));
});
await p.waitForTimeout(2500);

check('the app went and asked for the model list', seen.length > 0, `${seen.length} requests`);
const list = seen[seen.length - 1] || { url: '', headers: {} };
check('at /v1/models, a sibling of /v1/messages — not /v1/messages/models',
	/\/v1\/models$/.test(list.url), list.url);
check('with x-api-key, which is what Anthropic wants',
	!!list.headers['x-api-key'], Object.keys(list.headers).filter(h => /key|author|anthropic/i.test(h)).join(', '));
check('and NOT a bearer token, which it refuses',
	!list.headers['authorization'], list.headers['authorization'] || 'absent');
check('with the version pinned', !!list.headers['anthropic-version'], list.headers['anthropic-version'] || 'missing');
check('and the header that makes its edge answer a page at all',
	list.headers['anthropic-dangerous-direct-browser-access'] === 'true');

const models = await p.evaluate(() => {
	const sel = document.getElementById('cfg-model');
	return sel ? [...sel.options].map(o => o.value) : [];
});
check('and the models it answered with are on offer', models.includes('claude-opus-5'), models.join(', '));

const errs = errors(s).filter(e => !/502|Bad Gateway/.test(e));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
