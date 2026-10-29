/* ============================================================
   Test — WKEY-FRESH: a browser worker's key is ONE ask, sized
   to the turn, and a refused key ask is shown, never swallowed.
   ------------------------------------------------------------
   The fault (live, latent): a worker minted its slot key at the
   float (`mintSlot`) and then asked `ensure` on the same slot
   milliseconds later. The gateway's per-slot floor (2 s) refused
   the second ask with 429, the worker swallowed it as best-effort,
   and so every browser worker ran on a key capped at the float
   ($2). A turn over that was refused at the cap, its attempt
   billed, and the turn re-run on a fresh key: paid twice.

   The fix:
     www/js/models.js  — `keySlot(slot, want, node)` posts ONE
       `{slot, ensure:true, fresh:true, want_minor}`, installs the
       key it answers, and THROWS on a refusal or a keyless reply.
     www/js/daimond.js — the worker keys its slot with `keySlot`
       at `ensureWantMinor()`, and asks nothing more at turn start.

   The REAL models.js runs against a stub gateway that keeps the
   real one's rules: a per-slot floor of 2 s (429 inside it), a
   plain mint at the float (200), an ensure that raises a live key
   in place and answers no key, and a `fresh` ensure that rotates
   and mints at the clamped want (500). The REAL worker key segment
   of daimond.js — from `takeSlot` to the end of its refusal catch —
   is lifted and run against it.

   Each check is proven able to fail by a --break mode:

     node www/js/wkeyfresh.test.mjs --break twoask   # the worker goes back to mint + swallowed ensure
     node www/js/wkeyfresh.test.mjs --break nofresh  # the request drops `fresh`
     node www/js/wkeyfresh.test.mjs --break swallow  # the worker swallows a refused key ask
     node www/js/wkeyfresh.test.mjs                  # and then, clean
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadStore } from './storefixture.mjs';

const HERE        = dirname(fileURLToPath(import.meta.url));
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

const KEY_CALL = 'await DaimondModels.keySlot(run.slot, ensureWantMinor(), runNode);';

function patchModels(src) {
	if (BREAK === 'floatremint') {
		// The remint goes back to a plain mint at the float.
		return src.replace('return await keySlot(slot, wantMinor, node);', 'return await mintSlot(slot, node);');
	}
	if (BREAK === 'nofresh') return src.replace('if (opts.fresh) body.fresh = true;', '/* BROKEN: no fresh */');
	return src;
}

function patchDaimond(src) {
	if (BREAK === 'oldstring') {
		// Both remint catches go back to the one credits string, whatever the refusal.
		return src.split('if (e2 && e2.noCredits) throw new Error(').join('throw new Error(');
	}
	if (BREAK === 'twoask') {
		// The old pair: mint at the float, then a best-effort ensure whose refusal is swallowed.
		return src.replace(KEY_CALL, 'await DaimondModels.mintSlot(run.slot, runNode); '
			+ 'try { await DaimondModels.ensure(run.slot, ensureWantMinor(), runNode); } catch (ew) { /* best-effort */ }');
	}
	if (BREAK === 'swallow') {
		return src.replace(KEY_CALL, 'try { ' + KEY_CALL + ' } catch (ew) { /* BROKEN: swallowed */ }');
	}
	return src;
}

// ── The real models.js, against a stub gateway with the real rules ──
function loadModels() {
	const store = new Map();
	const localStorage = {
		getItem:    (k) => (store.has(k) ? store.get(k) : null),
		setItem:    (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	const win = {};
	win.dispatchEvent = () => true;
	const documentShim = { addEventListener: () => {}, getElementById: () => null, visibilityState: 'hidden' };
	const FLOAT = 200, MAX = 500, FLOOR_MS = 2000;
	// `live[slot]` is the key the gateway holds live there; `last[slot]` the time of its last ask.
	const gw = { calls: [], live: {}, last: {}, now: 0, refuse: 0, n: 0, ignoreFresh: false };
	const fetchStub = async (url, opts) => {
		const body = JSON.parse((opts && opts.body) || '{}');
		gw.calls.push(body);
		const s = body.slot | 0;
		const res = (status, j) => ({ ok: status === 200, status, json: async () => j });
		if (gw.refuse) return res(gw.refuse, { ok: false, error: 'Refused (' + gw.refuse + ').' });
		if (gw.last[s] !== undefined && gw.now - gw.last[s] < FLOOR_MS) {
			return res(429, { ok: false, error: 'That was just asked for; try again in a moment.' });
		}
		gw.last[s] = gw.now;
		const mint = (cap) => {
			gw.live[s] = { key: 'sk-' + (++gw.n), cap };
			return res(200, { ok: true, key: gw.live[s].key, url: 'https://openrouter.ai/api/v1',
				limit_minor: cap, raised_minor: 0, credits_minor: 900, currency: 'usd' });
		};
		const want = Math.min(Math.max(body.want_minor | 0, FLOAT), MAX);
		if (!body.ensure) return mint(FLOAT);
		if ((body.fresh && !gw.ignoreFresh) || !gw.live[s]) return mint(want);
		// A plain ensure on a live slot raises it in place and answers no key.
		const raised = Math.max(0, want - gw.live[s].cap);
		gw.live[s].cap = Math.max(gw.live[s].cap, want);
		return res(200, { ok: true, key: null, url: 'https://openrouter.ai/api/v1',
			limit_minor: gw.live[s].cap, raised_minor: raised, credits_minor: 900, currency: 'usd' });
	};
	const g = { window: win, document: documentShim, localStorage, fetch: fetchStub, console };
	const body = patchModels(readPage(MODELS_SRC, 'utf8'));
	loadStore(win, localStorage);
	const fn = new Function('window', 'document', 'localStorage', 'fetch', 'console', 'globalThis', body);
	fn(win, documentShim, localStorage, fetchStub, console, g);
	return { M: win.DaimondModels, gw };
}

// ── The real worker key segment of daimond.js ──────────────────
// From the slot being taken to the end of the refusal catch: the whole of a worker's key path
// before it builds its app. Run as an async function with `this` as the pump.
function workerKeySegment() {
	const src = patchDaimond(readPage(DAIMOND_SRC, 'utf8'));
	const A = 'if (onCredits) {\n\t\t\t\trun.slot = self.takeSlot();';
	const Z = '\n\t\t\ttry {\n\t\t\t\tbuild();';
	const a = src.indexOf(A), z = src.indexOf(Z, a);
	if (a < 0 || z < 0) { console.error('ABORT: the worker key segment is not in daimond.js'); process.exit(2); }
	const seg = src.slice(a, z);
	return new Function('run', 'self', 'onCredits', 'DaimondModels', 'ensureWantMinor', 'runNode',
		'friendlyError', 'closeEarly', 'isPassingFailure',
		'return (async function () {\n' + seg + '\n\treturn true;\n}).call(this);');
}

async function runWorker(M, slot, want) {
	const seg  = workerKeySegment();
	const run  = { text: '', said: [] };
	const self = { takeSlot: () => slot, giveSlot: () => {} };
	const pump = { active: 1, render() {}, pump() {} };
	let closed = false;
	const went = await seg.call(pump, run, self, true, M, () => want, 'self',
		(e) => (e && e.message) || String(e), () => { closed = true; }, () => false);
	return { run, went: went === true, closed };
}

// ── The real first-attempt-and-retry block of daimond.js ───────
// The attempt dies on its key (a 401 mid-turn); the worker remints ITS OWN slot and re-runs.
function retryBlock() {
	const src = patchDaimond(readPage(DAIMOND_SRC, 'utf8'));
	const A = '\t\t\t\ttry {\n\t\t\t\t\t// Cleared as it is read';
	const Z = '\t\t\t\t// A stopped or paused worker keeps whatever it managed to do';
	const a = src.indexOf(A), z = src.indexOf(Z, a);
	if (a < 0 || z < 0) { console.error('ABORT: the worker retry block is not in daimond.js'); process.exit(2); }
	return new Function('run', 'state', 'DaimondModels', 'billAttempt', 'self', 'build', 'scope', 'seedSession',
		'turnMeter', 'window', 'RESUME_NUDGE', 'VISION_NUDGE', 'runNode', 'firstAsk', 'ensureWantMinor',
		'friendlyError',
		'var reminted = false, wmeter = null, sink = {}, authFail = false;'
		+ ' state.fail = function () { authFail = true; };'
		+ ' return (async function () {\n' + src.slice(a, z) + '\n})();');
}

async function main() {
	console.log('(1) a worker on a slot a previous worker left live is keyed in ONE ask, at the turn\'s want');
	{
		const { M, gw } = loadModels();
		// A previous worker's key, live at the float on slot 2 and asked long ago.
		gw.live[2] = { key: 'sk-old', cap: 200 }; gw.last[2] = -10_000;
		const r = await runWorker(M, 2, 1500);
		check('the worker went on to build', r.went && !r.closed, 'status=' + r.run.status);
		check('the worker asked the gateway exactly once', gw.calls.length === 1, 'calls=' + gw.calls.length);
		const b = gw.calls[0] || {};
		check('the ask is a fresh ensure at the turn\'s want', b.slot === 2 && b.ensure === true
			&& b.fresh === true && b.want_minor === 1500, JSON.stringify(b));
		const s = M.slotConfig(2);
		check('the worker holds the key the gateway minted, not the old one',
			!!s && s.key === (gw.live[2] && gw.live[2].key) && s.key !== 'sk-old', 'key=' + (s && s.key));
		check('the key is capped at the want (clamped to 500), not the float',
			gw.live[2] && gw.live[2].cap === 500, 'cap=' + (gw.live[2] && gw.live[2].cap));
	}

	console.log('(2) a worker on an empty slot: one ask, the wanted cap');
	{
		const { M, gw } = loadModels();
		const r = await runWorker(M, 3, 500);
		check('one ask', gw.calls.length === 1, 'calls=' + gw.calls.length);
		check('a key at the want', r.went && gw.live[3] && gw.live[3].cap === 500
			&& M.slotConfig(3) && M.slotConfig(3).key === gw.live[3].key,
			'cap=' + (gw.live[3] && gw.live[3].cap));
	}

	console.log('(3) a refused key ask is shown on the run, not run on a smaller key');
	for (const status of [429, 402, 503]) {
		const { M, gw } = loadModels();
		gw.refuse = status;
		const r = await runWorker(M, 4, 500);
		// A refused key never reached the loop, so it is `not_started` with the refusal as its
		// reason (ZERO-ROUND), never `error` and never run on a smaller key.
		check(status + ': the run could not start, and goes no further', r.run.status === 'not_started'
			&& /Refused/.test(r.run.why || '') && !r.went && r.closed,
			'status=' + r.run.status + ' went=' + r.went);
		check(status + ': the refusal is in the run\'s text', /Refused/.test(r.run.text), 'text=' + r.run.text);
		check(status + ': the slot holds no key', !M.slotConfig(4), 'slot=' + JSON.stringify(M.slotConfig(4)));
	}

	console.log('(4) a gateway that answers no key (it does not honour `fresh`) is a refusal, not a keyless run');
	{
		const { M, gw } = loadModels();
		gw.ignoreFresh = true;
		gw.live[5] = { key: 'sk-old', cap: 200 }; gw.last[5] = -10_000;
		let threw = null;
		try { await M.keySlot(5, 500, ''); } catch (e) { threw = e; }
		check('keySlot throws on a keyless reply', !!threw, threw ? threw.message : 'no throw');
		check('and installs nothing', !M.slotConfig(5), 'slot=' + JSON.stringify(M.slotConfig(5)));
	}

	console.log('(6) a mid-turn 401 remints the worker\'s slot in ONE fresh ask at the turn\'s want, never the float');
	{
		const { M, gw } = loadModels();
		await M.keySlot(6, 1500, '');
		const first = M.slotConfig(6) && M.slotConfig(6).key;
		gw.now = 60_000;				// the turn ran a minute: well past the floor
		gw.calls.length = 0;
		const state = {};
		const run = { task: 'Survey the notes', status: 'running', tools: [], slot: 6, _gen: M.slotConfig(6).gen };
		let sent = 0, threw = null;
		const mkApp = () => ({ async run_turn() { if (++sent === 1) { state.fail(); throw new Error('401'); } } });
		run.app = mkApp();
		try {
			await retryBlock()(run, state, M, () => {}, { render() {} }, () => { run.app = mkApp(); },
				async () => {}, () => {}, () => null, {}, 'RESUME', 'VISION', 'self', (r) => r.task, () => 1500);
		} catch (e) { threw = e; }
		check('the retry ran', !threw && sent === 2, threw ? threw.message : 'sent=' + sent);
		check('the remint is ONE ask', gw.calls.length === 1, 'calls=' + gw.calls.length);
		const b = gw.calls[0] || {};
		check('the remint is a fresh ensure at the turn\'s want', b.slot === 6 && b.ensure === true
			&& b.fresh === true && b.want_minor === 1500, JSON.stringify(b));
		check('the reminted key is capped at the want, not the float', gw.live[6] && gw.live[6].cap === 500,
			'cap=' + (gw.live[6] && gw.live[6].cap));
		check('the worker holds the new key', M.slotConfig(6) && M.slotConfig(6).key !== first
			&& M.slotConfig(6).key === gw.live[6].key, 'key=' + (M.slotConfig(6) && M.slotConfig(6).key));
	}

	console.log('(7) a refused remint shows its own reason; only a noCredits refusal says the credits ran out');
	const CREDITS = /credits have run out/;
	const friendly = (e) => 'F:' + ((e && e.message) || String(e));
	for (const [status, credits] of [[429, false], [503, false], [402, true]]) {
		// The worker, through its real retry block against the real models.js.
		const { M, gw } = loadModels();
		await M.keySlot(7, 1500, '');
		gw.now = 60_000; gw.refuse = status;
		const state = {};
		const run = { task: 'Survey the notes', status: 'running', tools: [], slot: 7, _gen: M.slotConfig(7).gen };
		run.app = { async run_turn() { state.fail(); throw new Error('401'); } };
		let threw = null;
		try {
			await retryBlock()(run, state, M, () => {}, { render() {} }, () => {}, async () => {}, () => {},
				() => null, {}, 'RESUME', 'VISION', 'self', (r) => r.task, () => 1500, friendly);
		} catch (e) { threw = e; }
		const msg = threw ? threw.message : '';
		if (credits) check('worker ' + status + ': the credits text', CREDITS.test(msg), msg);
		else check('worker ' + status + ': its own reason, not credits', msg === 'F:Refused (' + status + ').', msg);
		// The chat's remint catch, lifted and run on the same refusal.
		const src = patchDaimond(readPage(DAIMOND_SRC, 'utf8'));
		const c = src.indexOf('catch (e2) {', src.indexOf('DaimondModels.remint(chat._gen'));
		const z = src.indexOf('REMINT-REFUSAL-END', c);
		const body = c > 0 && z > c ? src.slice(c + 'catch (e2) {'.length, z) : 'throw new Error("no catch")';
		let cthrew = null;
		const e2 = new Error('Refused (' + status + ').'); e2.noCredits = status === 402;
		try { new Function('e2', 'friendlyError', body)(e2, friendly); } catch (e) { cthrew = e; }
		const cm = cthrew ? cthrew.message : '';
		if (credits) check('chat ' + status + ': the credits text', CREDITS.test(cm), cm);
		else check('chat ' + status + ': its own reason, not credits', cm === 'F:Refused (' + status + ').', cm);
	}

	console.log('(5) source guard — the worker makes no second key ask at turn start');
	{
		const src = patchDaimond(readPage(DAIMOND_SRC, 'utf8'));
		check('daimond.js has no worker ensure on its own slot', !src.includes('DaimondModels.ensure(run.slot,'));
		check('the worker never mints its first key at the float', !src.includes('DaimondModels.mintSlot(run.slot'));
	}

	console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' + (checks - failures) + '/' + checks
		+ ' checks' + (BREAK ? ' (--break ' + BREAK + ')' : ''));
	if (BREAK) {
		// Fail-first: a --break run must go red; green under a break means the check is blind.
		if (!failures) { console.log('BREAK NOT CAUGHT: --break ' + BREAK + ' left every check green'); process.exit(1); }
		console.log('break caught (exit 0)');
		process.exit(0);
	}
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
