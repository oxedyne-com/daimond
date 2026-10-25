/* ============================================================
   Test — no send fails in silence (API-FLOOR 3).
   ------------------------------------------------------------
   THE FAULT. A tab below the gateway's floor had every post refused 426,
   and nothing said so: Settings' "Share diagnostic log" showed "Could not
   share: the server declined (426)" with no way to try again, and the
   Lens's picture poll (lensshot.js) dropped every failure on the floor, so
   the beat's `postFail` read 0 while nothing was landing.

   THE RULE.
     (a) `DaimondGateway.failWhy(status)` is the one sentence for why a
         request did not land: unreachable (0), out of date (426), too soon
         (429), or the status the server answered.
     (b) `DaimondDiag.flush()` answers that reason and its status, and counts
         a failure that reached the wire into the beat (`notePostFail`); a
         share the client's own floor held back never left, so is not counted.
     (c) Settings' share, through `DaimondDiag.shareControl`, shows
         "Not sent: {reason}" with a Retry that shares again.
     (d) lensshot.js counts a failed poll into the beat and logs it to the
         console; a 403 (this account may not use the Lens) is an answer,
         not a failure.
   The consent sheet's own failed state is in support.test.mjs, and
   `notePostFail` itself in debugshare.test.mjs.

   Run red with MM_SRC_REV=60f49f37c.  Run: node www/js/sendfail.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { source, liftFn } from './testlift.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, ok, detail) {
	if (ok) { console.log('ok   ' + name); return; }
	failures++;
	console.log('FAIL ' + name + (detail ? '\n     ' + detail : ''));
}
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 6; i++) await tick(); }

// The English table, read the way the app registers it.
function enTable() {
	let caught = null;
	const sb = { window: { DaimondI18n: { register: (c, t) => { caught = t; } } } };
	sb.globalThis = sb;
	vm.createContext(sb);
	vm.runInContext(readFileSync(join(HERE, '..', 'i18n', 'en.js'), 'utf8'), sb);
	return caught;
}
const EN = enTable();
const I18N = {
	t: (k, v) => {
		if (!Object.prototype.hasOwnProperty.call(EN, k)) return k;
		return String(EN[k]).replace(/\{(\w+)\}/g, (w, n) => (v && n in v) ? String(v[n]) : w);
	},
};

// (a) the real failWhy, lifted out of gateway.js beside its own `t`.
const gw = source('gateway.js');
const failWhySrc = liftFn(gw, 'failWhy');
const failWhy = failWhySrc
	? new Function('window', 'DaimondI18n', liftFn(gw, 't') + '\n' + failWhySrc + '\nreturn failWhy;')({ DaimondI18n: I18N }, I18N)
	: () => '';
console.log('(a) failWhy names why a request did not land');
check('gateway.js has failWhy', !!failWhySrc);
check('no answer at all: unreachable', failWhy(0) === EN['gateway.fail_unreachable'] && !!EN['gateway.fail_unreachable'], failWhy(0));
check('a missing status reads the same', failWhy(undefined) === failWhy(0));
check('426: out of date', failWhy(426) === EN['gateway.fail_stale'] && !!EN['gateway.fail_stale'], failWhy(426));
check('429: too soon', failWhy(429) === EN['gateway.fail_soon'] && !!EN['gateway.fail_soon'], failWhy(429));
check('anything else names the status', failWhy(503) === 'the server answered 503', failWhy(503));

function makeButton() {
	const b = { textContent: '', hidden: false, disabled: false, _l: [] };
	b.addEventListener = (type, fn) => { if (type === 'click') b._l.push(fn); };
	b.click = () => b._l.forEach((fn) => fn({}));
	return b;
}

// (b), (c) the real diag.js.
function loadDiag(answer) {
	const store = new Map([['daimond-diagnostics', '1']]);
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	let fails = 0;
	const win = {
		addEventListener() {},
		DaimondI18n: I18N,
		DaimondGateway: { clientApi: () => 3, failWhy },
		DEBUG_SHARE: { notePostFail: () => { fails += 1; } },
	};
	const document = { visibilityState: 'visible', addEventListener() {}, createElement: () => makeButton() };
	const env = { answer };
	const fetchImpl = () => env.answer();
	new Function('window', 'document', 'localStorage', 'fetch', 'console', 'with (window) {\n'
		+ source('diag.js') + '\n}')(win, document, localStorage, fetchImpl, { log() {}, warn() {} });
	env.D = win.DaimondDiag;
	env.fails = () => fails;
	env.allow = () => store.delete('daimond-diag-flushed');	// the client floor, waited out
	return env;
}

console.log('(b) a failed share says why and is counted');
{
	const env = loadDiag(() => Promise.resolve({ ok: false, status: 500 }));
	const r = await env.D.flush();
	check('a refused share answers ok:false with its status', r.ok === false && r.status === 500, JSON.stringify(r));
	check('and the reason failWhy gives', r.why === 'the server answered 500', r.why);
	check('and is counted into the beat', env.fails() === 1, String(env.fails()));

	const held = await env.D.flush();
	check('a second share inside the client floor is too soon', held.ok === false && held.why === failWhy(429), held.why);
	check('and, never having left, is not counted', env.fails() === 1, String(env.fails()));

	env.allow();
	env.answer = () => Promise.reject(new TypeError('Failed to fetch'));
	const lost = await env.D.flush();
	check('a share that reached nobody is unreachable', lost.ok === false && lost.status === 0 && lost.why === failWhy(0), lost.why);
	check('and is counted', env.fails() === 2, String(env.fails()));

	env.allow();
	env.answer = () => Promise.resolve({ ok: true, status: 200 });
	const good = await env.D.flush();
	check('revert: a share that lands is ok and counted as nothing', good.ok === true && env.fails() === 2);
}

console.log('(c) Settings\' share shows "Not sent: {reason}" with Retry');
{
	const env = loadDiag(() => Promise.resolve({ ok: false, status: 426 }));
	const btn = makeButton(), retry = makeButton();
	const go = typeof env.D.shareControl === 'function' ? env.D.shareControl(btn, retry) : null;
	check('diag.js offers shareControl', typeof go === 'function');
	if (go) {
		check('Retry is hidden before anything has failed', retry.hidden === true);
		check('and reads Retry', retry.textContent === EN['mail.retry'], retry.textContent);
		await go();
		check('a refused share reads Not sent: with the reason',
			btn.textContent === I18N.t('mail.unsent', { reason: failWhy(426) }), btn.textContent);
		check('and shows Retry', retry.hidden === false);

		env.allow();
		env.answer = () => Promise.resolve({ ok: true, status: 200 });
		await go();
		check('Retry shares again, and a landed share says so', btn.textContent === EN['settings.diag_shared'], btn.textContent);
		check('and puts Retry away', retry.hidden === true);
	}
}

// (d) the real lensshot.js.
function loadLens(answer) {
	const store = new Map([['daimond-lensshot', '1']]);
	const localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
	};
	let fails = 0;
	const warned = [];
	const timers = [];
	const win = {
		DaimondGateway: { clientApi: () => 3 },
		DaimondIdentity: { deviceId: () => 'dev-1' },
		DEBUG_SHARE: { notePostFail: () => { fails += 1; } },
	};
	const document = { hidden: false, addEventListener() {} };
	const env = { answer };
	const fetchImpl = () => env.answer();
	const st = (fn) => { timers.push(fn); return timers.length; };
	const con = { log() {}, warn: (...a) => warned.push(a.join(' ')), error: (...a) => warned.push(a.join(' ')) };
	new Function('window', 'document', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'console',
		'with (window) {\n' + source('lensshot.js') + '\n}')(win, document, localStorage, fetchImpl, st, () => {}, con);
	env.L = win.DaimondLensShot;
	env.fails = () => fails;
	env.warned = warned;
	env.poll = async () => { const fn = timers.shift(); if (fn) fn(); await settle(); };
	return env;
}

console.log('(d) a failed Lens poll is counted and logged');
{
	const env = loadLens(() => Promise.resolve({ ok: false, status: 502 }));
	env.L.wire({});
	await env.poll();
	check('a refused poll is counted into the beat', env.fails() === 1, String(env.fails()));
	check('and logged to the console with its status', env.warned.some((w) => /lens/i.test(w) && /502/.test(w)), JSON.stringify(env.warned));

	env.answer = () => Promise.reject(new TypeError('Failed to fetch'));
	await env.poll();
	check('a poll that reached nobody is counted too', env.fails() === 2, String(env.fails()));

	env.answer = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
	await env.poll();
	check('revert: a poll answered with nothing to do counts nothing', env.fails() === 2, String(env.fails()));

	env.answer = () => Promise.resolve({ ok: false, status: 403 });
	await env.poll();
	check('revert: a 403 is an answer (no Lens for this account), not a failure', env.fails() === 2, String(env.fails()));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall sendfail checks passed');
process.exit(failures ? 1 : 0);
