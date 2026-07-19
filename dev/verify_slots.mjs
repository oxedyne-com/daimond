// verify_slots.mjs — parallel workers each run on their OWN minted key.
//
// The overspend the multi-key work fixes is caused by parallel workers SHARING
// one spend-capped key: their concurrent requests race the host's stale cap
// check and overshoot it. The fix is a key per concurrent slot. This proves the
// CLIENT half end to end: a conductor that dispatches several workers makes the
// gateway mint a DISTINCT slot per worker, and each worker's real provider
// request carries its OWN slot key — never a shared one, never the chat's.
//
// The gateway is not run; its /api/inference-key is fetch-stubbed to hand back a
// key keyed to the slot in the request body, exactly as the real one now keys by
// slot. The provider endpoint is stubbed to record which bearer key each request
// used. Everything else is the real wasm, the real models.js and the real
// daimond.js Workers pool. Needs dev/serve.mjs :8777 and dev/mockllm.mjs :9099.
import { open, signInAs, shot, MOCK } from './harness.mjs';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (body, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_URL  = `${OR_BASE}/chat/completions`;
const FLOAT   = 200;
const WORKER_SAYS = /You are a worker agent dispatched/;
// A key whose slot is legible in a haystack.
const keyForSlot = (slot) => `sk-or-v1-SLOT${slot}-zqxwmarker000000000000000000000000000000`;
const slotOf = (auth) => { const m = /SLOT(\d+)-/.exec(auth || ''); return m ? Number(m[1]) : null; };

const ok = [], bad = [];
const check = (name, pass, detail) => {
	(pass ? ok : bad).push(name);
	console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const gw = { bal: 2000, mintedSlots: [], providerCalls: [] };

async function stubGateway(page) {
	await page.route('**/api/account',        r => r.fulfill(json({ ok: true })));
	await page.route('**/api/auth/challenge', r => r.fulfill(json({ ok: true, challenge: 'chal-zqxw', challenge_id: 'cid-1' })));
	await page.route('**/api/auth/verify',    r => r.fulfill(json({ ok: true })));
	await page.route('**/api/balance',        r => r.fulfill(json({ ok: true, credits_minor: gw.bal, currency: 'usd', entries: [] })));

	// The contract under test: the body names a slot, and the key handed back is
	// that slot's own. The real gateway does exactly this.
	await page.route('**/api/inference-key', r => {
		let slot = 0;
		try { slot = (JSON.parse(r.request().postData() || '{}').slot) | 0; } catch (e) { slot = 0; }
		gw.mintedSlots.push(slot);
		return r.fulfill(json({
			ok: true, key: keyForSlot(slot), url: OR_BASE,
			limit_minor: Math.min(FLOAT, gw.bal), credits_minor: gw.bal, currency: 'usd',
		}));
	});

	await page.route('https://openrouter.ai/api/v1/models',
		r => r.fulfill(json({ data: [{ id: 'anthropic/claude-opus-4.5' }, { id: 'openai/gpt-5.2' }] })));

	// The provider the browser talks to directly. Record the bearer key and
	// whether the caller was a worker, then let the mock actually answer.
	await page.route(OR_URL, async (r) => {
		const auth = r.request().headers()['authorization'] || '';
		const sent = r.request().postData() || '';
		gw.providerCalls.push({ slot: slotOf(auth), worker: WORKER_SAYS.test(sent) });
		const res  = await fetch(MOCK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: sent });
		const body = await res.text();
		return r.fulfill({ status: res.status, headers: CORS, contentType: res.headers.get('content-type') || 'application/json', body });
	});
}

const s = await open({ name: 'slots', signIn: false, connect: false });
const { page } = s;
await stubGateway(page);
await signInAs(s, 'slots');
await page.waitForTimeout(2500);   // unlock → bootstrap → mint slot 0 → list catalogue

// Start new chats and Facets on credits, so the conductor and its workers all run
// on the minted key path (slot 0 for the chat/conductor, ≥1 for workers).
await page.evaluate(() => window.DaimondModels.setDefault('credits', 'anthropic/claude-opus-4.5'));

check('unlock minted slot 0 (the chat/conductor key)', gw.mintedSlots.includes(0), 'slots ' + JSON.stringify(gw.mintedSlots));

// A Facet, and a conductor turn that dispatches three workers at once.
await page.click('#new-facet-btn');
await page.waitForSelector('.dlg-input', { timeout: 8000 });
await page.fill('.dlg-input', 'Audit');
await page.click('.dlg-ok');
await page.waitForSelector('#steer-input', { timeout: 10000 });
await page.waitForTimeout(400);
const steer = '@tools spawn_agent {"name":"a","task":"inspect one"} ;; '
	+ 'spawn_agent {"name":"b","task":"inspect two"} ;; '
	+ 'spawn_agent {"name":"c","task":"inspect three"}';
await page.fill('#steer-input', steer);
await page.click('#steer-send');

// Wait for all three workers to finish (Workers.active back to 0).
const until = async (fn, ms = 25000) => {
	const t0 = Date.now();
	for (;;) { try { if (await page.evaluate(fn)) return true; } catch (e) {} if (Date.now() - t0 > ms) return false; await new Promise(r => setTimeout(r, 150)); }
};
await until(() => gw.__done, 100).catch(() => {});
await page.waitForTimeout(6000);   // let the fan-out run against the mock

// ── The assertions ────────────────────────────────────────────────
const workerSlots = gw.mintedSlots.filter(x => x >= 1);
const uniqWorker  = Array.from(new Set(workerSlots));
check('three workers minted three distinct worker slots',
	uniqWorker.length >= 3 && workerSlots.length === uniqWorker.length,
	'minted slots ' + JSON.stringify(gw.mintedSlots));
check('no worker used slot 0 (the chat/conductor key)',
	!gw.providerCalls.some(c => c.worker && c.slot === 0),
	JSON.stringify(gw.providerCalls));

const workerCallSlots = gw.providerCalls.filter(c => c.worker).map(c => c.slot);
const uniqCallSlots = Array.from(new Set(workerCallSlots));
check('each worker request carried its OWN distinct slot key',
	workerCallSlots.length >= 3 && uniqCallSlots.length === workerCallSlots.length,
	'worker call slots ' + JSON.stringify(workerCallSlots));

await shot(s, 'slots');
await s.close();
console.log('\nminted slots: ' + JSON.stringify(gw.mintedSlots));
console.log('provider calls: ' + JSON.stringify(gw.providerCalls));
console.log(ok.length + ' ok, ' + bad.length + ' failed');
process.exit(bad.length ? 1 : 0);
