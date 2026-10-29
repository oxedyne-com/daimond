/* ============================================================
   Test -- a runner turn's alerts come home (KT-5d A).
   ------------------------------------------------------------
   A Diamond's turn run on a runner has no page, so each `pending_raise` / `pending_clear` it
   makes is carried home on its report as `alerts`: `{op:'raise',key,headline,detail,needs}` or
   `{op:'clear',key}`, in order. The asking tab puts each on its Pending panel through the same
   door a local turn takes (`DaimondPendingTool`), under the chat's own Diamond.

   WHAT IS CHECKED, over the REAL alerts.js and peer.js and the REAL `settleRunnerAlerts`
   lifted from daimond.js:
     (a) makeReport writes `alerts` last, normalised, and only when there are any;
     (b) a report's raise lands on the panel under the chat's Diamond, and its clear takes
         one down, in order;
     (c) the same report heard again applies nothing twice;
     (d) a turn held by no chat, or by a chat in no Diamond, applies nothing;
     (e) a chat not resident is loaded from the report's chatId, and must hold the turn;
     (f) "applied" is kept per errand across a reload, so a cleared alert never comes back;
     (g) each alert is stamped by the turn's own time, so a replay never outranks a take-down;
     (h) the applied record is bounded (QA ccp4-b K2).

   Run:  node www/js/kt5dalerts.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, storage } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}

/// The source of `function name(...) {...}`, brace-balanced, or null.
function lift(src, name) {
	let start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) return null;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

// (a) The real peer.js's makeReport.
const pw = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readPage(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(pw, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const P = pw.DaimondPeer;
const ALERTS = [{ op: 'raise', key: 'imap-login', headline: 'Mail login failing', detail: 'Re-enter it.', needs: true },
	{ op: 'clear', key: 'old' }];
const rep = P.makeReport({ eid: 'e1', turnId: 't1', chatId: 'c1', alerts: ALERTS });
check('(a) makeReport carries the alerts, last', JSON.stringify(rep).endsWith(',"alerts":' + JSON.stringify(ALERTS) + '}'),
	JSON.stringify(rep).slice(-200));
const messy = P.makeReport({ alerts: [{ op: 'raise', key: 'k', headline: 'h' }, { op: 'nuke', key: 'x' }, { op: 'clear' },
	{ op: 'clear', key: 'c', headline: 'extra' }, 'junk', { op: 'raise', key: 5, headline: 'h', needs: true }] });
check('(a) a malformed alert is dropped or filled as the runner reads it', JSON.stringify(messy.alerts)
	=== '[{"op":"raise","key":"k","headline":"h","detail":"","needs":false},{"op":"clear","key":"c"}]', messy.alerts);
check('(a) a report with no alerts names none', !('alerts' in P.makeReport({ alerts: [] })) && !('alerts' in P.makeReport({})));

// (b)-(h) The real alerts.js, and the tab's settle lifted from daimond.js.
const SRC = readPage(join(HERE, 'daimond.js'), 'utf8');
const ALERTS_SRC = readPage(join(HERE, 'alerts.js'), 'utf8');
const NAMES = ['chatHoldsTurn', 'chatHoldingReport', 'settleRunnerAlerts'];
const bodies = NAMES.map((n) => lift(SRC, n));
check('the tab applies a report\'s alerts through daimond.js', bodies.every(Boolean), NAMES.filter((n, i) => !bodies[i]));
const body = bodies.every(Boolean) ? bodies.join('\n') : null;
const st = { held: null, diags: [], chats: [] };
const NOW = 1_790_000_000_000;
/// One tab over the real alerts.js; `ls` shared is a reload of the same device.
function tab(ls) {
	const w = makeWindow({ now: NOW, ls });
	new Function('window', 'with (window) {\n' + ALERTS_SRC + '\n}')(w);
	const load = async (c) => { if (c && !c._loaded) { c.messages = c._stored || []; c._loaded = true; } return c; };
	const F = body ? new Function('window', 'chatHoldingTurn', 'diag', 'chats', 'loadChatMessages',
		body + '\nreturn settleRunnerAlerts;')(w, () => st.held, (t, d) => st.diags.push(t + ' ' + d), st.chats, load) : null;
	return { w, settle: async (r) => { try { return F ? await F(r) : -1; } catch (e) { return 'threw ' + e.message; } } };
}
const TS = NOW - 60_000;	// the turn's own time on the runner, a minute before it is heard
const done = Object.assign({}, rep, { status: 'done', ts: TS });
{
	const { w, settle } = tab();
	// Raised before the turn, so the turn's clear is the later word.
	JSON.parse(w.DaimondPendingTool.raise('mail', JSON.stringify({ key: 'old', headline: 'Stale', detail: '', needs: true }), TS - 1000));
	st.held = { id: 'c1', diamondId: 'mail' };
	const n = await settle(done);
	const live = w.DaimondAlerts.live();
	check('(b) both alerts are applied', n === 2, n);
	check('(b) the raise is on the panel under the chat\'s Diamond, the clear took the old one down',
		live.length === 1 && live[0].diamond === 'mail' && live[0].key === 'imap-login' && live[0].headline === 'Mail login failing'
		&& live[0].needs === true, live);
	check('(c) the same report heard again applies nothing', await settle(done) === 0);
	// One raised here after the turn stands against the turn's older clear.
	JSON.parse(w.DaimondPendingTool.raise('mail', JSON.stringify({ key: 'old', headline: 'Back', detail: '', needs: true })));
	await settle(Object.assign({}, done, { eid: 'e1-again', alerts: [{ op: 'clear', key: 'old' }] }));
	check('(g) a raise made after the turn stands against its clear', w.DaimondAlerts.live().some((a) => a.key === 'old'));
}
{
	const { w, settle } = tab();
	st.held = null;
	check('(d) a turn no chat holds applies nothing', await settle(rep) === 0 && w.DaimondAlerts.live().length === 0);
	st.held = { id: 'c2', diamondId: '' };
	check('(d) a chat in no Diamond applies nothing', await settle(Object.assign({}, rep, { eid: 'e2' })) === 0
		&& w.DaimondAlerts.live().length === 0);
}
// (e) QA ccp4-b K2: the chat is not resident (a report heard after a reload); it is loaded from
// the report's chatId, and its alerts applied once it is seen to hold the turn.
{
	const { w, settle } = tab();
	st.held = null;
	st.chats.length = 0;
	st.chats.push({ id: 'c1', diamondId: 'mail', _loaded: false, messages: null,
		_stored: [{ role: 'user', mid: 't1' }, { role: 'assistant' }] });
	const n = await settle(Object.assign({}, done, { eid: 'e-res' }));
	check('(e) a chat not resident is loaded from the report\'s chatId and its alerts applied', n === 2
		&& w.DaimondAlerts.live().some((a) => a.key === 'imap-login' && a.diamond === 'mail'), { n, live: w.DaimondAlerts.live() });
	st.chats.length = 0;
	st.chats.push({ id: 'c1', diamondId: 'mail', _loaded: false, messages: null, _stored: [{ role: 'user', mid: 'other' }] });
	const { w: w2, settle: s2 } = tab();
	check('(e) a chat the report names that does not hold the turn applies nothing',
		await s2(Object.assign({}, done, { eid: 'e-res2' })) === 0 && w2.DaimondAlerts.live().length === 0);
	st.chats.length = 0;
}
// (f) Applied is kept per errand across a reload, and a cleared alert never comes back.
{
	const ls = storage();
	st.held = { id: 'c1', diamondId: 'mail' };
	const a = tab(ls);
	const n = await a.settle(Object.assign({}, done, { eid: 'e-f' }));
	const up = a.w.DaimondAlerts.live().find((x) => x.key === 'imap-login');
	check('(g) a carried alert is stamped by the turn\'s time, not the time it is applied', n === 2 && !!up && up.at === TS,
		up && up.at);
	JSON.parse(a.w.DaimondPendingTool.clear('mail', JSON.stringify({ key: 'imap-login' })));
	const b = tab(ls);
	check('(f) after a reload the same report applies nothing', await b.settle(Object.assign({}, done, { eid: 'e-f' })) === 0);
	check('(f) the alert he cleared stays cleared', !b.w.DaimondAlerts.live().some((x) => x.key === 'imap-login'));
	// Even where the applied record has forgotten it, the turn's stamp loses to the later clear.
	for (const k of [...ls._m.keys()]) if (k.indexOf('heard') >= 0) ls.removeItem(k);
	const c = tab(ls);
	await c.settle(Object.assign({}, done, { eid: 'e-f' }));
	check('(g) a replayed raise never outranks a later take-down', !c.w.DaimondAlerts.live().some((x) => x.key === 'imap-login'),
		c.w.DaimondAlerts.live());
}
// (h) The applied record is bounded: past its size the oldest are forgotten.
{
	const ls = storage();
	const { w } = tab(ls);
	const H = w.DaimondAlerts;
	for (let i = 0; i < 260; i++) H.hear && H.hear('e' + i);
	const rec = [...ls._m.entries()].find(([k]) => k.indexOf('heard') >= 0);
	const n = rec ? Object.keys(JSON.parse(rec[1]).eids || JSON.parse(rec[1])).length : -1;
	check('(h) the applied record is bounded', n > 0 && n <= 200, n);
	check('(h) the newest is kept, the oldest forgotten', !!H.heard && H.heard('e259') && !H.heard('e0'));
}
console.log((failures ? 'FAIL' : 'PASS') + ' kt5dalerts ' + (checks - failures) + '/' + checks);
process.exit(failures ? 1 : 0);
