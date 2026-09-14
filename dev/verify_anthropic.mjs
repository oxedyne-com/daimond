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
// So this asserts the ADDRESS AND HEADERS ON THE WIRE, intercepted at the browser, not
// what the app believes it sent. Needs dev/serve.mjs (DAIMOND_PORT, default 8777).
//
// The last section runs a TURN on that route, for the three things only a direct call can
// show: that the engine prices a reply the provider charges nothing for (measure 6a -- and
// `r: 1` in the ledger, not an estimate `e`), and that the thinking and effort settings reach
// a body (measure 5), which no OpenAI-dialect request carries at all.
import { open, errors, newChat, chat } from './harness.mjs';

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

// ── A turn on the direct path costs a booked figure, not an estimate ───────
//
// MEASURE 6a, from the browser. Anthropic reports usage and NEVER a cost, so before the list
// price table landed in src/llm.rs the engine handed the page `cost_usd: 0` on every direct
// call: the spend cap was inert by design, and the ledger showed either nothing or a figure the
// JS table had estimated on the engine's behalf. The two are told apart by one field --
// `DaimondLedger` marks a provider-reported cost `r: 1` and an estimate `e: true` -- so THAT is
// what is asserted here, rather than merely "the ledger is not zero", which was already true.
//
// The turn is answered from the intercepted route, so no key, no network and no cost are
// involved. The reply is the Messages API's own event stream, which is also what makes the two
// measure-5 fields on the request readable: this is the only dialect that carries them.

const bodies = [];
await p.route('**://api.anthropic.com/v1/messages', async (route) => {
	bodies.push(route.request().postData() || '');
	await route.fulfill({
		status: 200,
		contentType: 'text/event-stream',
		headers: { 'access-control-allow-origin': '*' },
		body: [
			'event: message_start',
			'data: {"type":"message_start","message":{"id":"msg_1","usage":'
				+ '{"input_tokens":12000,"cache_creation_input_tokens":0,'
				+ '"cache_read_input_tokens":8000,"output_tokens":1}}}',
			'',
			'event: content_block_start',
			'data: {"type":"content_block_start","index":0,'
				+ '"content_block":{"type":"text","text":""}}',
			'',
			'event: content_block_delta',
			'data: {"type":"content_block_delta","index":0,'
				+ '"delta":{"type":"text_delta","text":"Two plus two is four."}}',
			'',
			'event: content_block_stop',
			'data: {"type":"content_block_stop","index":0}',
			'',
			'event: message_delta',
			'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},'
				+ '"usage":{"output_tokens":600}}',
			'',
			'event: message_stop',
			'data: {"type":"message_stop"}',
			'',
		].join('\n'),
	});
});

// AND THE MODEL IS CHOSEN, rather than left to the list's own order. `fetchModels`
// sorts the ids and takes the first, so the two the stub answers with leave
// `claude-haiku-5` selected -- and everything this section measures is a property of
// the model, not of the transport:
//
//   * a Haiku takes no adaptive thinking (`model_takes_adaptive_thinking`, src/llm.rs,
//     which is right to exclude it: that family takes `budget_tokens`), so the engine
//     correctly sends neither `thinking` nor `output_config`, and the two measure-5
//     cells below asserted a body no correct client would ever produce;
//   * neither price table knows that id, so the engine books nothing and the page
//     falls back to its own estimate -- `e: true`, which is exactly what the `r: 1`
//     cell exists to forbid, and a figure ($0.00632) that is the unknown-model
//     fallback rather than any Anthropic rate.
//
// So the turn runs on the model the comments below already price it at. A user picks
// their model; this picks the same way, through the select the app listens to.
await p.evaluate(() => {
	const sel = document.getElementById('cfg-model');
	sel.value = 'claude-opus-5';
	sel.dispatchEvent(new Event('change', { bubbles: true }));
});
const picked = await p.evaluate(() => (document.getElementById('cfg-model') || {}).value || '');
// Asserted, not assumed: a select that did not take the value would leave every cell
// below measuring a different model and saying nothing about it.
check('the turn is set to run on Opus 5, whose rates the cells below quote',
	picked === 'claude-opus-5', picked);

// The picker was left on Anthropic above, with the endpoint filled in and a key typed, so the
// settings this turn runs under are the ones a user would have.
await p.evaluate(() => { const b = document.getElementById('byok-save'); if (b) b.click(); });
await p.waitForTimeout(600);
await newChat(s);
let turned = true;
try { await chat(s, 'what is two plus two'); }
catch (e) { turned = false; check('a turn ran on the direct path', false, e.message); }

if (turned) {
	check('the turn went to the Messages API', bodies.length > 0, `${bodies.length} request(s)`);
	const sent = (() => { try { return JSON.parse(bodies[bodies.length - 1] || '{}'); }
		catch { return {}; } })();

	// MEASURE 5 ON THE WIRE: the only dialect that can carry either field.
	check('the request asks for adaptive thinking',
		!!sent.thinking && sent.thinking.type === 'adaptive', JSON.stringify(sent.thinking));
	check('and names the effort it wants',
		!!sent.output_config && typeof sent.output_config.effort === 'string',
		JSON.stringify(sent.output_config));
	// And the system turn carries a cache breakpoint, which is what makes a multi-round turn
	// affordable at all (measure 6a's other half).
	const marked = JSON.stringify(sent.system || []).includes('cache_control');
	check('the system prompt carries a cache breakpoint', marked);

	// MEASURE 6a: the engine priced its own call, so the ledger entry is REPORTED.
	const led = await p.evaluate(() => {
		try { return JSON.parse(localStorage.getItem('daimond-ledger') || '[]'); }
		catch { return []; }
	});
	const last = led[led.length - 1] || {};
	check('the turn reached the ledger', led.length > 0, `${led.length} entr(y/ies)`);
	check('with a non-zero cost on a path the provider prices at nothing',
		(last.u || 0) > 0, `$${last.u}`);
	// 12,000 fresh + 8,000 cached prompt at Opus 5's $5.00/$0.50, 600 out at $25.00.
	const want = (12000 * 5 + 8000 * 0.5) / 1e6 + 600 * 25 / 1e6;
	check('at the list price the table publishes',
		Math.abs((last.u || 0) - want) < 1e-6, `booked $${last.u}, list price $${want}`);
	check('booked as REPORTED by the engine rather than estimated by the page',
		last.r === 1 && !last.e, JSON.stringify(last));
}

// THE GATEWAY ROUTES ARE NOT WHAT THIS FILE IS ABOUT, and this page is deliberately
// not connected to one (`connect: false`), so `/api/*` is answered by whatever is --
// or is not -- listening. With no gateway that is a 502 from the dev server's proxy,
// which this filter has always excused; with one up the same page is told 401 at
// `/api/tools` and 402 at `/api/sync`, both of them the correct answer to a device
// with no session and no Pro. Excusing only the 502 made this file's result depend on
// whether a gateway happened to be running beside it -- 14/4 alone, 13/5 in a world.
// Narrowed to the gateway's own routes, so an error anywhere else still reddens it.
const GW_NONEVENT = /\b(401|402|502)\b|Unauthorized|Payment Required|Bad Gateway/;
const errs = errors(s).filter(e => !(/\/api\//.test(e) && GW_NONEVENT.test(e)));
check('nothing threw', errs.length === 0, errs.slice(0, 2).join(' | '));

await s.close();
console.log(`\n${ok.length} passed, ${bad.length} failed`);
if (bad.length) { bad.forEach(b => console.log('  FAILED: ' + b)); process.exit(1); }
