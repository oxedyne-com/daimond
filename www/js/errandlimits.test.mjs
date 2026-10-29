/* ============================================================
   Test -- the errand carries the page's limits, and a hand-back says why in plain words (KT-2b).
   ------------------------------------------------------------
   A runner builds the turn's agent from the errand alone. Since KT-2a it applies the page's
   `limits` (engine `TurnLimits`, design §2.5 item 14) and hands back, cause `limits`, an errand
   that carries none: it never runs on a guessed window. So the page sends what it applied:
   `errandLimits(chat)` over the same figures `applyFoldSettings` and `applyRoundLimit` put on
   an agent here, and `makeErrand` writes them in the runner's field order.

   The vector is the runner's own (`LIMITS`, kimberlite/src/errands/tests.rs), read from that
   file, so the page and the runner cannot drift apart unseen.

   And a hand-back for `thread` or `limits` leaves the person a plain sentence on the chat, with
   the device's name and no id or jargon (rc ruling, 24 Oct), in all eight locales.

   Run:  node www/js/errandlimits.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { makeWindow } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { source, lift } from './testlift.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The runner's vector, as the page's names and order.
const RS = readPage(new URL('../../kimberlite/src/errands/tests.rs', import.meta.url), 'utf8');
const LM = /const LIMITS: &str = r#"(.*)"#;/.exec(RS);
const LIMITS = LM ? JSON.parse(LM[1]) : null;
check('the runner\'s LIMITS vector is readable', !!LIMITS);
const LIMITS_JSON = JSON.stringify(LIMITS);

// ── The envelope ─────────────────────────────────────────────────────────
const PEER = readPage(new URL('./peer.js', import.meta.url), 'utf8');
const pw = { addEventListener() {}, dispatchEvent() { return true; } };
new Function('window', 'document', 'with (window) {\n' + PEER + '\n}')(pw, { addEventListener() {} });
const P = pw.DaimondPeer;
{
	const e = P.makeErrand({ limits: LIMITS });
	check('makeErrand carries the limits as the runner reads them', JSON.stringify(e.limits) === LIMITS_JSON,
		JSON.stringify(e.limits));
	check('no limits writes no key', !('limits' in P.makeErrand({})));
	check('a string is no limits', !('limits' in P.makeErrand({ limits: '{"window":1}' })));
	check('a list is no limits', !('limits' in P.makeErrand({ limits: [1] })));
	const odd = P.makeErrand({ limits: { tune: 't', window: '5', foldAt: -1, contextCap: 2.7, spendCap: 'x', bogus: 1 } }).limits;
	check('the fields are coerced and written in the runner\'s order', same(odd,
		{ window: 5, foldAt: 0, contextCap: 2, spendCap: 0, maxRounds: 0, foldModel: '', foldPrompt: '', tune: 't' }),
		JSON.stringify(odd));
	check('an errand made again keeps the limits', JSON.stringify(P.makeErrand(e).limits) === LIMITS_JSON);
	const chat = { id: 'c9', messages: [{ role: 'user', content: 'go', mid: 't9', ts: 1 }] };
	const sent = (extra) => P.buildDispatch(chat, Object.assign({ turnId: 't9', prompt: 'go', now: 2 }, extra)).errand(0);
	check('a dispatch carries its limits', JSON.stringify(sent({ limits: LIMITS }).limits) === LIMITS_JSON);
	check('a dispatch with none carries no key', !('limits' in sent({})));
}
// ── The report keeps the causes a runner sends ───────────────────────────
{
	for (const c of ['thread', 'limits']) {
		check('a report keeps cause ' + c, P.makeReport({ status: 'handback', cause: c }).cause === c);
	}
	check('an unknown cause is dropped', P.makeReport({ status: 'handback', cause: 'bogus' }).cause === '');
}
// ── The page reads its own limits ────────────────────────────────────────
{
	const env = (over) => Object.assign({
		cfg: { foldAt: 0.8, contextCap: 200000, spendCap: 0.5, maxRounds: 40, tune: '{"retire_at":0.4}' },
		errandModelOf: () => ({ provider: 'anthropic', model: 'm-1', url: '' }),
		Prompts: { md: { compactor: 'Fold é "well".' } },
	}, over || {});
	const win = (over) => Object.assign(makeWindow({}), {
		DaimondPricing: { contextWindow: (m, p) => (m === 'm-1' && p === 'anthropic' ? 1048576 : null) },
		DaimondModels: { effective: (h, role) => ({ model: (h.provider === 'anthropic' && role === 'summarising') ? 'm-fold' : '' }) },
	}, over || {});
	let F = null;
	try { F = loadPage({ window: win(), want: ['errandLimits'], stub: env() }); }
	catch (e) { check('errandLimits is in daimond.js', false, String(e && e.message)); }
	if (F) {
		check('the page\'s limits are the runner\'s vector, byte for byte', JSON.stringify(F.errandLimits({ id: 'c1' })) === LIMITS_JSON,
			JSON.stringify(F.errandLimits({ id: 'c1' })));
		const G = loadPage({ window: win({ DaimondPricing: { contextWindow: () => null } }), want: ['errandLimits'], stub: env({ cfg: {}, Prompts: { md: {} } }) });
		const z = G.errandLimits({ id: 'c1' });
		check('nothing set and an unknown window send zeros, the engine\'s defaults', same(z,
			{ window: 0, foldAt: 0, contextCap: 0, spendCap: 0, maxRounds: 0, foldModel: 'm-fold', foldPrompt: '', tune: '' }),
			JSON.stringify(z));
	}
	const src = source('daimond.js');
	check('dispatchToPeer sends errandLimits(chat) as limits', /limits:\s*errandLimits\(chat\),/.test(src));
}
// ── The hand-back note ───────────────────────────────────────────────────
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-Hans'];
function table(code) {
	let got = null;
	const w = { DaimondI18n: { register: (c, t) => { got = t; } } };
	new Function('window', readPage(new URL('../i18n/' + code + '.js', import.meta.url), 'utf8'))(w);
	return got || {};
}
function tOf(tab) {
	return (k, v) => {
		const s = tab[k];
		if (s == null) return k;
		return v ? s.replace(/\{(\w+)\}/g, (w, n) => (v[n] != null ? String(v[n]) : w)) : s;
	};
}
const SRC = source('daimond.js');
{
	for (const code of LOCALES) {
		const tab = table(code);
		let F = null;
		try { F = loadPage({ window: makeWindow({}), want: ['handBackNote', 'seatReason'], stub: { t: tOf(tab) } }); }
		catch (e) { check(code + ': handBackNote is in daimond.js', false, String(e && e.message)); continue; }
		const th = F.handBackNote('thread', 'argonaut'), li = F.handBackNote('limits', 'argonaut');
		const dr = F.handBackNote('door', 'argonaut');	// the session sent as a reference (KT-4b)
		for (const [c, s] of [['thread', th], ['limits', li], ['door', dr]]) {
			check(code + ' ' + c + ': a sentence naming the device', typeof s === 'string' && s.includes('argonaut')
				&& /[.。!]$/.test(s) && !s.includes('{') && !/^chat\./.test(s), s);
			check(code + ' ' + c + ': no device id', !/[0-9a-f]{8}/.test(s), s);
		}
		check(code + ': the three causes read differently', th !== li && dr !== th && dr !== li, dr);
		const an = F.handBackNote('thread', '');
		check(code + ': an unnamed device reads as another device', an.includes(tab['devices.another'] || '\u0000'), an);
		if (code === 'en') {
			for (const [c, s] of [['thread', th], ['limits', li], ['door', dr]]) {
				check('en ' + c + ': no jargon', !/runner|thread|handed back|limits|errand/i.test(s), s);
			}
			check('en limits: says to reload', /reload/i.test(li), li);
		}
	}
}
// ── The fallback writes it ───────────────────────────────────────────────
{
	const tab = table('en');
	const t = tOf(tab);
	const run = async (m, cause) => {
		const tid = 'T1';
		const chat = { id: 'c1', messages: [m] };
		let why = null;
		const env = {
			chats: [chat], _handBack: { T1: 'c1' }, _handBackCause: { T1: cause }, _localRecovering: {}, _fallbackInFlight: {},
			endHandOffNotRun: async (c, mm, w) => { why = w; },
			DaimondPost: { collect: async () => {} },
			DaimondSync: { leaseGet: async () => ({ version: 3, leases: {}, unread: false }) },
			DaimondLease: { adopt: () => {}, record: () => null },
			DaimondPeer: { REASON_DISPATCHED: 'dispatched', recoverDecision: () => true, dispatchState: () => 'peer-held', runErrand: () => {} },
			dispatchedChat: () => null, dispatchedTurnFinished: () => false, selfDeviceId: () => 'PHONE',
			recoverOneLocally: async () => { why = 'ran here'; },
			peerReports: Object.create(null), diag: () => {},
			deviceNameFor: (id) => (id === 'ab12cd34ef567890' ? 'argonaut' : ''), t,
			Date, JSON, String, Object, Array, Promise,
		};
		env.window = env;
		const l = lift(SRC, ['runDispatchFallback', 'leaseDoorRead', 'handBackNote', 'seatReason']);
		if (l.missing.length) return 'missing ' + l.missing.join(',');
		const scope = new Proxy(env, { has: (o, k) => typeof k === 'string' && k in o, get: (o, k) => o[k], set: (o, k, v) => { o[k] = v; return true; } });
		const f = new Function('scope', 'with (scope) {\n' + l.body + '\nreturn [runDispatchFallback, handBackNote];\n}')(scope);
		await f[0]('c1', tid, {});
		return { why, want: f[1](cause, 'argonaut') };
	};
	const base = { why: 'dispatched', iturn: 'T1', dispatchedBy: 'PHONE', toDevice: 'ab12cd34ef567890' };
	for (const cause of ['thread', 'limits']) {
		const r = await run(Object.assign({}, base), cause);
		check('a ' + cause + ' hand-back ends with the plain note', !!r && r.why === r.want && typeof r.why === 'string', JSON.stringify(r));
	}
	// KT-4b: a turn whose session went as a reference, handed back `thread`, says it was too big to send.
	{
		const r = await run(Object.assign({ overDoor: true }, base), 'thread');
		const door = t('chat.handback_too_big', { name: 'argonaut' });
		check('an over-door hand-back ends with its own plain note', !!r && r.why === door, JSON.stringify(r));
	}
	check('the old jargon is gone', !/'[^'\n]*could not take the thread/.test(SRC));
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) process.exit(1);
