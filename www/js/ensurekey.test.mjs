/* ============================================================
   Test — F1: a turn over the float raises its key IN PLACE,
   never re-mints/re-runs; the raise is gated on the gateway,
   and a 402 counts as a key refusal.
   ------------------------------------------------------------
   The charge-for-nothing bug: a minted credits key is capped at
   a small float ($2). A turn worth more than that was refused at
   the cap and — worse — the refusal was a 402 the old regex did
   not match, so the whole turn was billed once for nothing and
   then stuck. The client half of the fix (gateway ensure mode is
   already committed, 6b5afb0f):

     www/js/models.js  — `mintRequest(slot, node, opts)` can post
       `{slot, want_minor, ensure:true}`, and `ensure()` raises a
       live key's cap in place. It is GATED on the reply carrying
       `raised_minor`: a gateway without it is treated as a plain
       mint and never asked to ensure again, so an old gateway is
       not made to rotate the key every turn.
     www/js/daimond.js — `runTurn`/the worker call `ensure` at
       turn start and top up on `round_meta`; `keyRefused` matches
       402 as well as 401/403.

   Part A drives the REAL www/js/models.js in a browser sandbox
   with a stubbed gateway, and proves:
     (1) an ensure over the float RAISES in place (raised_minor>0,
         key null, cap moved) and does NOT rotate the key;
     (2) the request actually carries {ensure:true, want_minor};
     (3) callers arriving together coalesce to ONE request;
     (4) a gateway with no `raised_minor` is handled as a mint
         ONCE and then ensure switches off — no per-turn rotation.

   Part B extracts the SHIPPED `keyRefused` from www/js/daimond.js
   and proves 402/401/403 are refusals and 400/404/429 are not.

   Part C is a source guard over www/js/daimond.js: the turn-start
   ensure, the mid-turn top-up, the fresh-key rebuild and the
   worker ensure are actually wired in (daimond.js cannot be
   executed here — it is an ES module importing the wasm surface).

   Each check is proven able to fail by a --break mode that damages
   the one shipped line it guards:

     node www/js/ensurekey.test.mjs --break nowant       # request drops want_minor/ensure
     node www/js/ensurekey.test.mjs --break rotateonraise # a raise rotates the key
     node www/js/ensurekey.test.mjs --break nogate        # the raised_minor gate is dropped
     node www/js/ensurekey.test.mjs --break regex402      # keyRefused goes back to 401/403 only
     node www/js/ensurekey.test.mjs --break noturnstart   # the turn-start ensure is removed
     node www/js/ensurekey.test.mjs                       # and then, clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_SRC  = join(HERE, 'models.js');
const DAIMOND_SRC = join(HERE, 'daimond.js');

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
// Each damages ONE shipped line the four client changes live in.
function patchModels(src) {
	if (BREAK === 'nowant') {
		// The request stops carrying the ensure fields, so the gateway can only mint.
		return src.replace('body.ensure     = true;', '/* BROKEN: no ensure field */;');
	}
	if (BREAK === 'rotateonraise') {
		// A raise-in-place reply (key null) is installed as a mint, rotating the key.
		return src.replace(
			'if (j.key && j.url) {\n\t\t\t\t// A raise cannot save a dead key, so the gateway minted after all.',
			'if (true) {\n\t\t\t\t// BROKEN: install even on a raise-in-place, rotating the key.');
	}
	if (BREAK === 'nogate') {
		// The gate is dropped, so a gateway that never sent raised_minor is not
		// recognised as old and ensure keeps firing (and rotating) every turn.
		return src.replace(
			'if (!j || typeof j.raised_minor !== \'number\') {',
			'if (false) { /* BROKEN: gate dropped */');
	}
	return src;
}
function patchDaimond(src) {
	if (BREAK === 'regex402') {
		return src.replace('return /\\b40[123]\\b/.test(s);', 'return /\\b40[13]\\b/.test(s);');
	}
	if (BREAK === 'noturnstart') {
		// Remove the chat turn-start ensure call, leaving only the mid-turn one.
		return src.replace(
			'var er = await DaimondModels.ensure(0, wantMinor, chatSpendNode(chat));',
			'var er = null; /* BROKEN: turn-start ensure removed */');
	}
	return src;
}

// ── A minimal browser sandbox for models.js ────────────────────
// models.js is a classic-script IIFE reading the bare globals
// `window`, `document`, `localStorage`, `fetch`; it attaches
// `DaimondModels` onto window.
function loadModels() {
	const store = new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.dispatchEvent = () => true;
	// 'hidden' keeps the credit heartbeat from starting — no tab here.
	const documentShim = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
	// A stubbed gateway. `mode` is set per test; every call records the parsed body.
	const gw = { mode: 'ensure', calls: [], bal: 600 };
	const fetchStub = async (url, opts) => {
		const body = JSON.parse((opts && opts.body) || '{}');
		gw.calls.push(body);
		let reply;
		if (gw.mode === 'oldgateway') {
			// Predates ensure: ignores the ensure fields, always mints at the float.
			reply = { ok: true, key: 'sk-mint-' + gw.calls.length, url: 'https://openrouter.ai/api/v1',
				limit_minor: 200, credits_minor: gw.bal, currency: 'usd' };
		} else if (body.ensure) {
			// Ensure-aware: raise the live key in place, no new key.
			const want = Math.min(body.want_minor | 0, 500);       // gateway clamps to max_headroom
			reply = { ok: true, key: null, url: 'https://openrouter.ai/api/v1',
				limit_minor: want, raised_minor: Math.max(0, want - 200),
				credits_minor: gw.bal, currency: 'usd' };
		} else {
			// A plain mint on an ensure-aware gateway (no ensure field sent).
			reply = { ok: true, key: 'sk-mint-' + gw.calls.length, url: 'https://openrouter.ai/api/v1',
				limit_minor: 200, credits_minor: gw.bal, currency: 'usd' };
		}
		return { ok: true, status: 200, json: async () => reply };
	};
	const g = { window: win, document: documentShim, localStorage, fetch: fetchStub, console };
	// The IIFE reads these names; `globalThis` inside resolves to `g` so bare
	// `fetch` finds the stub.
	let body = readFileSync(MODELS_SRC, 'utf8');
	body = patchModels(body);
	const fn = new Function('window', 'document', 'localStorage', 'fetch', 'console', 'globalThis', body);
	fn(win, documentShim, localStorage, fetchStub, console, g);
	return { M: win.DaimondModels, gw };
}

// ── Part B: the shipped keyRefused, extracted and run ──────────
function extractKeyRefused() {
	let src = readFileSync(DAIMOND_SRC, 'utf8');
	src = patchDaimond(src);
	const m = src.match(/function keyRefused\(raw\) \{[\s\S]*?\n\t\}/);
	if (!m) { console.error('ABORT: keyRefused not found in daimond.js'); process.exit(2); }
	return new Function('return (' + m[0] + ')')();
}

async function main() {
	// ── (1) RAISE IN PLACE, NOT A RE-MINT ──────────────────────
	console.log('(1) a turn over the float raises the key in place, without rotating it');
	{
		const { M, gw } = loadModels();
		if (!M || !M.ensure) { console.error('ABORT: DaimondModels.ensure missing'); process.exit(2); }
		gw.mode = 'ensure';
		const genBefore = M.creditsGen();
		const r = await M.ensure(0, 500, '');
		check('the gateway was asked once', gw.calls.length === 1, 'calls=' + gw.calls.length);
		check('the reply raised the cap (raised_minor > 0)', !!r && r.raised_minor > 0,
			'raised_minor=' + (r && r.raised_minor));
		check('no fresh key came back — the live key was raised', !!r && !r.key);
		check('the key generation did NOT advance (no rotation, no re-mint)',
			M.creditsGen() === genBefore, 'gen ' + genBefore + '→' + M.creditsGen());
		check('the credits row now shows the raised cap',
			M.creditsState().limit === 500, 'limit=' + M.creditsState().limit);
	}

	// ── (2) THE REQUEST CARRIES THE ENSURE FIELDS ──────────────
	console.log('(2) the ensure request actually carries {ensure:true, want_minor}');
	{
		const { M, gw } = loadModels();
		gw.mode = 'ensure';
		await M.ensure(0, 500, '');
		const body = gw.calls[0] || {};
		check('slot 0 is named', body.slot === 0, 'slot=' + body.slot);
		check('ensure:true is sent', body.ensure === true, 'ensure=' + body.ensure);
		check('want_minor is the turn cap', body.want_minor === 500, 'want_minor=' + body.want_minor);
	}

	// ── (3) COALESCING ─────────────────────────────────────────
	console.log('(3) callers arriving together make one request, not a stampede');
	{
		const { M, gw } = loadModels();
		gw.mode = 'ensure';
		await Promise.all([M.ensure(0, 500, ''), M.ensure(0, 500, ''), M.ensure(0, 500, '')]);
		check('three concurrent ensures made ONE gateway call', gw.calls.length === 1,
			'calls=' + gw.calls.length);
	}

	// ── (4) THE raised_minor GATE — clean fallback, no per-turn rotation ──
	console.log('(4) a gateway with no raised_minor is handled once, then ensure stands down');
	{
		const { M, gw } = loadModels();
		gw.mode = 'oldgateway';
		check('ensure is active before the first call', M.ensureActive() === true);
		const r1 = await M.ensure(0, 500, '');
		check('the old gateway’s reply carries no raised_minor', !!r1 && r1.raised_minor === undefined);
		check('ensure switched itself off after the ungated reply', M.ensureActive() === false);
		// The one mint it did was adopted, so this turn runs on a live key rather than
		// being billed for nothing on the key the gateway just revoked.
		check('the minted key was adopted (generation advanced once)', M.creditsGen() === 1,
			'gen=' + M.creditsGen());
		const r2 = await M.ensure(0, 500, '');
		check('a later ensure is a no-op (returns null)', r2 === null);
		check('and makes NO second request — the key is not rotated every turn',
			gw.calls.length === 1, 'calls=' + gw.calls.length);
	}

	// ── (5) 402 IS A KEY REFUSAL ───────────────────────────────
	console.log('(5) keyRefused matches 402 (a capped key), as well as 401/403');
	{
		const keyRefused = extractKeyRefused();
		check('402 is a refusal (OpenRouter’s capped-key status)',
			keyRefused('Provider error 402 Payment Required') === true);
		check('401 is a refusal (disabled/invalid key)', keyRefused('HTTP 401 unauthorized') === true);
		check('403 is a refusal (forbidden)', keyRefused('got a 403 back') === true);
		check('an error object’s message is read too',
			keyRefused({ message: 'status 402' }) === true);
		check('400 is NOT a key refusal', keyRefused('400 bad request') === false);
		check('404 is NOT a key refusal', keyRefused('404 not found') === false);
		check('429 is NOT a key refusal', keyRefused('429 too many requests') === false);
	}

	// ── (6) THE daimond.js WIRING IS PRESENT ───────────────────
	console.log('(6) source guard — daimond.js wires ensure at turn start, mid-turn, on a fresh key, and for workers');
	{
		let src = readFileSync(DAIMOND_SRC, 'utf8');
		src = patchDaimond(src);
		const chatCall = /DaimondModels\.ensure\(0, wantMinor, chatSpendNode\(chat\)\)/g;
		const chatCalls = (src.match(chatCall) || []).length;
		check('the chat calls ensure at BOTH turn start and mid-turn (round_meta)',
			chatCalls === 2, 'occurrences=' + chatCalls);
		check('a fresh key from ensure rebuilds the app around it',
			/if \(er && er\.key\) \{[\s\S]{0,120}?rebuildAppWithout\(chat, umid\)/.test(src));
		check('the worker raises its own slot before its turn',
			src.includes('DaimondModels.ensure(run.slot, ensureWantMinor(), runNode)'));
		check('the want is the turn spend cap, defaulting to the engine figure',
			src.includes('cfg.spendCap || DEFAULT_SPEND_CAP'));
		check('the mid-turn top-up reads the mid-turn-safe live_cost_usd getter',
			/wantMinor && DaimondModels\.ensureActive\(\)[\s\S]{0,200}?live_cost_usd/.test(src));
	}

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks
		+ ' checks' + (BREAK ? ' (--break ' + BREAK + ')' : ''));
	if (BREAK) {
		// Fail-first: a --break run is meant to go red. Green under a break means the
		// check could not see the damage, which is itself the failure.
		console.log('(--break ' + BREAK + ': the failures above are the point)');
		process.exit(failures > 0 ? 0 : 1);
	}
	process.exit(failures ? 1 : 0);
}

main();
