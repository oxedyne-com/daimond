/* ============================================================
   Test — a put of unknown outcome is resent, never "not sent"
   (www/js/post.js, WSTALL-RETRY, 2026-10-17).
   ------------------------------------------------------------
   The defect: when the store's writer did not answer in time
   the gateway said 500, and post.js told the person "it has not
   been sent" although the row could still land. Sending it again
   by hand seals a new envelope, which the relay cannot tell from
   a second message.

   The fix: the gateway answers 504 `{ok:false, unknown:true}`
   for that case, and `putOnce` resends the SAME body after 1, 2
   and 4 s (the relay de-duplicates on sender and address). A put
   still unknown after the resends says "may still arrive", and
   `shortfall` lists it apart from the refusals.

   Drives the REAL post.js against a fake relay whose answers are
   scripted per call. Waits of the resend lengths run at once.

   Proven able to fail:
     node www/js/postunknown.test.mjs --break noresend   # 504 answered without a resend
     node www/js/postunknown.test.mjs                    # clean
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? (process.argv[i + 1] || '') : '';
})();
const KNOWN = ['noresend'];
if (BREAK && !KNOWN.includes(BREAK)) {
	console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + KNOWN.join(', '));
	process.exit(2);
}

const RESEND_WAITS = [1000, 2000, 4000];

/// A page holding the real post.js, its relay answering `script` in turn (the last
/// answer repeats). Records every POST body and every resend wait.
function makeTab(script) {
	const puts = [], waits = [];
	const gwFetch = (url, o) => {
		if (o && o.method === 'POST') {
			const i = Math.min(puts.length, script.length - 1);
			puts.push(o.body);
			const s = script[i];
			const j = s === 200 ? { ok: true, seq: 1 } : s === 504
				? { ok: false, unknown: true, error: 'not known whether it was stored' }
				: { ok: false, error: 'no' };
			return Promise.resolve({ status: s, json: () => Promise.resolve(j) });
		}
		return new Promise(() => {});		// nothing else answers here
	};
	// The resend waits run at once; every other timer (the deadline) never fires.
	const fakeSetTimeout = (fn, ms) => {
		if (RESEND_WAITS.includes(ms)) { waits.push(ms); setImmediate(fn); }
		return 0;
	};
	const local = new Map();
	const document = {
		readyState: 'complete', visibilityState: 'hidden', addEventListener() {},
		createElement: () => ({ className: '', textContent: '', dataset: {}, style: {},
			setAttribute() {}, appendChild(c) { return c; }, addEventListener() {},
			classList: { add() {}, remove() {}, toggle() {} }, children: [] }),
		querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
	};
	const win = {
		addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
		location: { origin: 'https://example.test', href: 'https://example.test/' },
		navigator: { onLine: true },
		localStorage: {
			getItem: (k) => (local.has(k) ? local.get(k) : null),
			setItem: (k, v) => local.set(k, String(v)), removeItem: (k) => local.delete(k),
		},
		DaimondIdentity: {
			isUnlocked: () => false, deviceId: () => 'dev-a',
			publicKeyB64url: () => 'pub-self', sealingKeyRaw: () => null,
			wrap: async (s) => s, unwrap: async (s) => s,
		},
		DaimondGateway: { clientApi: () => 9, gwFetch },
		DEBUG_SHARE: { event: () => {} },
	};
	win.window = win;
	let src = readFileSync(join(HERE, 'post.js'), 'utf8');
	if (BREAK === 'noresend') {
		const from = src.indexOf('var RESEND_WAITS_MS = [1000, 2000, 4000];');
		if (from < 0) throw new Error('postunknown: could not find the resend waits');
		src = src.replace('var RESEND_WAITS_MS = [1000, 2000, 4000];', 'var RESEND_WAITS_MS = [];');
	}
	const fn = new Function('window', 'document', 'setTimeout', 'clearTimeout',
		'setInterval', 'clearInterval',
		'with (window) {\n' + src + '\n}');
	fn(win, document, fakeSetTimeout, () => {}, () => 0, () => {});
	return { puts, waits, P: win.DaimondPost };
}

const BODY = { to: 'pub-bob', addr: 'addr-1', envelope: 'SEALED-1' };

async function main() {
	console.log('a 504 is resent with the identical body, and the 200 that follows is ok');
	{
		const tab = makeTab([504, 200]);
		const r = await tab.P.post(BODY);
		check('the put is ok once the relay answers 200', r && r.ok === true, JSON.stringify(r));
		check('it was sent exactly twice', tab.puts.length === 2, 'puts: ' + tab.puts.length);
		check('the resend carries the identical body', tab.puts.length === 2 && tab.puts[0] === tab.puts[1],
			JSON.stringify(tab.puts));
		check('the first resend waited 1 s', tab.waits[0] === 1000, JSON.stringify(tab.waits));
	}

	console.log('after the resends are spent, the answer is unknown and never "not sent"');
	{
		const tab = makeTab([504]);
		const r = await tab.P.post(BODY);
		check('four puts in all (one and three resends)', tab.puts.length === 4, 'puts: ' + tab.puts.length);
		check('every put carries the identical body', tab.puts.every((b) => b === tab.puts[0]));
		check('the result is not ok', r && r.ok === false, JSON.stringify(r));
		check('the result says unknown', r && r.unknown === true, JSON.stringify(r));
		check('the result status is 504', r && r.status === 504, JSON.stringify(r));
		check('its words never say "not been sent"', r && !/not been sent/i.test(String(r.why)), String(r && r.why));
		check('its words say it may still arrive', r && /may still arrive/i.test(String(r.why)), String(r && r.why));
	}

	console.log('a refusal is answered at once, with no resend');
	{
		const tab = makeTab([413]);
		const r = await tab.P.post(BODY);
		check('a 413 is put once', tab.puts.length === 1, 'puts: ' + tab.puts.length);
		check('a 413 is not unknown', r && !r.unknown, JSON.stringify(r));
	}

	console.log('shortfall lists a 504 apart from the refusals');
	{
		const tab = makeTab([200]);
		const said = tab.P.shortfall({ refused: [
			{ to: 'pub-carol-0000', status: 504 },
			{ to: 'pub-dave-00000', status: 413 },
		] });
		check('the 504 is under "could not confirm"', /could not confirm it for: pub-caro/.test(said), said);
		check('the 504 is not under "would not take it"',
			!/would not take it for:[^.]*pub-caro/.test(said), said);
		check('the 413 is still a refusal', /would not take it for: pub-dave/.test(said), said);
	}

	console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
	process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
