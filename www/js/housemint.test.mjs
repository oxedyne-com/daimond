/* ============================================================
   Test -- FIRE HOUSE-MINT: the page never decides "no credits"
   for itself; the mint's answer is the only verdict.
   ------------------------------------------------------------
   `syncCredits` used to stand the credits row down as `nocredits`
   whenever the balance it was handed was at or below zero, before
   the gateway was asked. The house account runs below zero by
   design (rulings §16 HOUSE CAP, `house_limit_minor`), so the
   owner's own page showed "no credits" and never minted.

   This drives the REAL www/js/models.js against a stubbed gateway:
     (1) a house account at -1200 with a 5000 cap mints from the
         page, and the row is ready on the minted key;
     (2) an ordinary account at 0 still asks the gateway, and the
         row carries the gateway's own refusal text, not a verdict
         drawn on the page.

   On a tree with the client pre-check this is RED.

   Run:  node www/js/housemint.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_SRC = join(HERE, 'models.js');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? ' -- ' + detail : '')); failures++; }
}

const REFUSAL = 'Your balance is US$0.00. Top up to keep working.';

// `reply` is the gateway's answer to a mint: `{ status, body }`.
function loadModels(reply) {
	const store = new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = { dispatchEvent: () => true };
	// 'hidden' keeps the credit heartbeat from starting.
	const doc = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
	const gw = { mints: 0 };
	const fetchStub = async (url, opts) => {
		const isMint = !!(opts && opts.method === 'POST');
		if (isMint) gw.mints++;
		const r = isMint ? reply : { status: 200, body: { data: [] } };
		return { ok: r.status < 400, status: r.status, json: async () => r.body };
	};
	const g = { window: win, document: doc, localStorage, fetch: fetchStub, console };
	loadStore(win, localStorage);
	const fn = new Function('window', 'document', 'localStorage', 'fetch', 'console', 'globalThis',
		readFileSync(MODELS_SRC, 'utf8'));
	fn(win, doc, localStorage, fetchStub, console, g);
	return { M: win.DaimondModels, gw };
}

async function main() {
	console.log('(1) a house account below zero, within its cap, mints from the page');
	{
		const { M, gw } = loadModels({ status: 200, body: {
			ok: true, key: 'sk-house-1', url: 'https://openrouter.ai/api/v1',
			limit_minor: 200, credits_minor: -1200, house_limit_minor: 5000, currency: 'usd',
		} });
		const ok = await M.syncCredits({ authed: true, credits: -1200, currency: 'usd' });
		const st = M.creditsState();
		check('the gateway was asked to mint', gw.mints === 1, 'mints=' + gw.mints);
		check('syncCredits reports success', ok === true, 'ok=' + ok);
		check('the row is ready, not nocredits', st.state === 'ready', 'state=' + st.state);
		check('the minted key is live', st.ready === true);
	}

	console.log('(2) an ordinary account at zero gets the gateway\'s refusal, in its words');
	{
		const { M, gw } = loadModels({ status: 402, body: { ok: false, error: REFUSAL, credits_minor: 0 } });
		const ok = await M.syncCredits({ authed: true, credits: 0, currency: 'usd' });
		const st = M.creditsState();
		check('the gateway was asked', gw.mints === 1, 'mints=' + gw.mints);
		check('syncCredits reports no key', ok === false, 'ok=' + ok);
		check('the row stands down as nocredits', st.state === 'nocredits', 'state=' + st.state);
		check('the row carries the gateway\'s refusal text', st.why === REFUSAL, 'why=' + JSON.stringify(st.why));
	}

	console.log((failures ? 'FAIL' : 'PASS') + ': ' + (checks - failures) + '/' + checks);
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
