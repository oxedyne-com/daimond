// R5a: the "Here | <runner>" switch offers a paired native runner only while its signed
// beat is fresh, it says it serves, it is free and its engine id equals the page's (X12).
// Two-context class (rulings §1, §14): two pages, each with its own copy of peer.js, read
// the same gateway answer and must make the same offer.
//   node www/js/runneroffer.test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}

/// One page: its own window with its own peer.js, as a second device would have.
function page() {
	const win = { addEventListener() {}, dispatchEvent() { return true; } };
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
	return win;
}

const ENGINE = 'ab'.repeat(32);
const OTHER  = 'cd'.repeat(32);
const now = Date.now();
const chat = { id: 'c1', model: 'm', provider: 'credits' };

/// The gateway's presence answer with the runner's row as `over` makes it.
function answer(over) {
	return {
		rn:  Object.assign({ name: 'box-one', last_seen: now, runner: true, kind: 'runner',
			serviced: true, serviced_at: now, mobile: false, busy: 0, engine: ENGINE }, over || {}),
		tab: { name: 'laptop', last_seen: now, mobile: false },
	};
}

/// What the switch on `win` offers for `ans` with the page's engine id `mine`.
function offer(win, ans, mine, forChat, more) {
	win.DaimondPeer.setEngineId(mine);
	win.DaimondPresence.ingest(ans, now);
	return win.DaimondPeer.seatSwitch(forChat || chat, win.DaimondPresence.snapshot(),
		Object.assign({ selfId: 'me', runnerOnly: true, freshWindowMs: win.DaimondPeer.DISPATCH_FRESH_MS }, more || {}), now);
}

const A = page(), B = page();
{
	const a = offer(A, answer(), ENGINE);
	check('O1 a fresh, serving, free runner on the page\'s engine is offered by its name',
		a.runner && a.runner.deviceId === 'rn' && a.runner.label === 'box-one' && a.choice === 'runner',
		JSON.stringify(a));
	const b = offer(B, answer(), ENGINE);
	// `until` is each device's own clock, so the offer is the runner and the choice.
	const same = (x) => JSON.stringify({ runner: x.runner, choice: x.choice });
	check('O2 two devices see the same offer', same(a) === same(b),
		JSON.stringify(a) + ' / ' + JSON.stringify(b));
}
{
	const s = offer(A, answer({ engine: OTHER }), ENGINE);
	check('O3 a runner with another engine id is not offered', s.runner === null, JSON.stringify(s));
	const b = offer(B, answer({ engine: OTHER }), ENGINE);
	check('O3b nor on the second device', b.runner === null, JSON.stringify(b));
}
{
	const ans = answer(); delete ans.rn.engine;
	const s = offer(A, ans, ENGINE);
	check('O4 an unstamped runner (no engine id) is never offered', s.runner === null, JSON.stringify(s));
}
{
	const s = offer(A, answer(), '');
	check('O5 a page that does not know its own engine id offers no native runner', s.runner === null,
		JSON.stringify(s));
}
{
	const s = offer(A, answer({ last_seen: now - 10 * 60 * 1000, serviced_at: now - 10 * 60 * 1000 }), ENGINE);
	check('O6 a stale beat hides it', s.runner === null, JSON.stringify(s));
}
{
	const s = offer(A, answer({ serviced: false, serviced_at: 0 }), ENGINE);
	check('O7 serving=false hides it', s.runner === null, JSON.stringify(s));
}
{
	const s = offer(A, answer({ busy: 1, busy_chats: ['other'] }), ENGINE);
	check('O8 a runner busy with another chat is not offered', s.runner === null, JSON.stringify(s));
}
{
	// A tab runner carries no engine id and is judged as before: the gate is the native kind's.
	const ans = { tab: { name: 'desk', last_seen: now, runner: true, serviced: true, serviced_at: now,
		mobile: false, busy: 0 } };
	const s = offer(A, ans, ENGINE);
	check('O9 a tab runner is offered as before', s.runner && s.runner.deviceId === 'tab', JSON.stringify(s));
}
{
	// The send takes the same election: a mismatched native runner is never dispatched to.
	A.DaimondPeer.setEngineId(ENGINE);
	A.DaimondPresence.ingest(answer({ engine: OTHER }), now);
	const d = A.DaimondPeer.autoDispatchDecision(chat, A.DaimondPresence.snapshot(),
		{ selfId: 'me', isPhone: true, freshWindowMs: A.DaimondPeer.DISPATCH_FRESH_MS }, now);
	check('O10 the send does not hand a turn to a runner on another engine',
		!(d.dispatch && d.peer && d.peer.deviceId === 'rn'), JSON.stringify(d));
}

{
	// R3c4c lead ruling: a native runner serves Daimond credits only, so a chat on its own key
	// is never offered one, by the switch or by the send, and nor is a chat whose resolved pair
	// is not credits. The election judges `provider`, the pair in force the page resolves
	// (daimond.js electProvider), before the stored pick, which is '' for a chat that follows
	// the default (QA-B #3). A tab runner is not judged here.
	const byok = { id: 'c2', model: 'm', provider: 'anthropic' };
	const s = offer(A, answer(), ENGINE, byok);
	check('O11 a chat on its own key is not offered a native runner', s.runner === null, JSON.stringify(s));
	const none = offer(B, answer(), ENGINE, { id: 'c3', model: 'm', provider: 'credits' }, { provider: 'anthropic' });
	check('O11b nor a chat whose resolved pair is not credits', none.runner === null, JSON.stringify(none));
	const unres = offer(B, answer(), ENGINE, { id: 'c4', model: '', provider: '' });
	check('O11b2 nor one whose pair nothing resolves', unres.runner === null, JSON.stringify(unres));
	const fol = offer(B, answer(), ENGINE, { id: 'c5', model: '', provider: '' }, { provider: 'credits' });
	check('O11b3 a following chat whose pair resolves to credits is offered it',
		!!(fol.runner && fol.runner.deviceId === 'rn'), JSON.stringify(fol));
	A.DaimondPeer.setEngineId(ENGINE);
	A.DaimondPresence.ingest(answer(), now);
	const d = A.DaimondPeer.autoDispatchDecision(byok, A.DaimondPresence.snapshot(),
		{ selfId: 'me', isPhone: true, freshWindowMs: A.DaimondPeer.DISPATCH_FRESH_MS }, now);
	check('O11c the send does not hand an own-key turn to a native runner',
		!(d.dispatch && d.peer && d.peer.deviceId === 'rn'), JSON.stringify(d));
	const c = A.DaimondPeer.autoDispatchDecision(chat, A.DaimondPresence.snapshot(),
		{ selfId: 'me', isPhone: true, freshWindowMs: A.DaimondPeer.DISPATCH_FRESH_MS }, now);
	check('O11d a credits turn is still handed to it', !!(c.dispatch && c.peer && c.peer.deviceId === 'rn'),
		JSON.stringify(c));
	const t = offer(A, { tab: { name: 'desk', last_seen: now, runner: true, serviced: true, serviced_at: now,
		mobile: false, busy: 0 } }, ENGINE, byok);
	check('O11e a tab runner is still offered to an own-key chat', t.runner && t.runner.deviceId === 'tab',
		JSON.stringify(t));
}

// SEATWHY (SEAT-DIAG, 2026-10-24): the owner starred his paired runner and his chat, on his own
// OpenRouter key, drew plain "Here" with nothing to say why. The switch now names the reason.
{
	const byok = { id: 'c6', model: 'm', provider: 'openrouter' };
	const s = offer(A, answer(), ENGINE, byok, { nominatedId: 'rn', provider: 'openrouter' });
	check('O12a an own-key chat with a nominated native runner says it serves credits only',
		!s.runner && s.why === 'runner-credits-only' && s.runnerId === 'rn', JSON.stringify(s));
	const e = offer(A, answer({ engine: OTHER }), ENGINE, chat, { nominatedId: 'rn', provider: 'credits' });
	check('O12b a nominated native runner on another engine says so',
		!e.runner && e.why === 'runner-engine' && e.runnerId === 'rn', JSON.stringify(e));
	const ok = offer(A, answer(), ENGINE, chat, { nominatedId: 'rn', provider: 'credits' });
	check('O12c an offered runner carries no reason', ok.runner && !ok.why, JSON.stringify(ok));
	const tab = offer(A, answer(), ENGINE, byok, { nominatedId: 'tab', provider: 'openrouter' });
	check('O12d a tab nominee gives no credits reason', tab.why !== 'runner-credits-only', JSON.stringify(tab));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
