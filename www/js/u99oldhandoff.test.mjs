/* ============================================================
   Test: an ended hand-off a later turn follows draws no tile (UNBLOCK-99).

   His Lifelog chat (diamond 19ffb69baea2, chat cmsrl1djg-1-e7uq7; his iPhone
   screenshot of 3 Nov 10:41, notes/daimond_phone_review_20261103/
   his_iphone_lifelog_20261103_1041.png; dev/fixtures/u99/his_lifelog_notrun.txt) showed three stacked tiles,
   "Not run · Oct 3", "Not run · Oct 13", "Not run · Oct 14", each with
   "Runs here -- keep this open": hand-offs of October that found nobody,
   each followed by later turns, drawn as permanent records (UNBLOCK-83)
   that stood last in the chat because their state still read as live.

     O1  his shape: three ended hand-offs, each followed by later turns,
         draw no tile and no "Runs here" hint
     O2  a hand-off still on the road keeps its tile, spinner and words,
         even where a later turn follows it
     O3  the newest turn's hand-off that found nobody, on a phone, keeps
         its tile and its "Runs here -- keep this open" hint
     O4  a superseded hand-off whose answer bubble drew keeps the bubble
         and no "Not run" footer under it

   Lifts the REAL functions out of daimond.js (MM_SRC_REV=<rev> runs them
   at that revision: the live record 98409426d draws the tiles, so O1 and
   O4 go red there) and runs them in a scope of fakes.

   Run:  node www/js/u99oldhandoff.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { source, lift } from './testlift.mjs';

const SRC = source('daimond.js');

let checks = 0, failures = 0;
function check(name, ok, detail) {
	checks++;
	if (ok) { console.log('  ok   ' + name); return; }
	failures++;
	console.log('  FAIL ' + name + (detail ? '\n       ' + detail : ''));
}

const FNS = ['appendDispatchedTile', 'renderDispatchedFooter', 'seatTileNote', 'handoffLive', 'turnLive',
	'turnSuperseded', 'opensTurn', 'isUndoNote', 'handoffEnded', 'drawOldNotRun'];
// The fix's predicate is absent on the live record, and the record's "Not run · <date>" words in the fix.
const OPTIONAL = ['handoffEnded', 'drawOldNotRun'];

function el(tag) {
	return { tag, children: [], handlers: {}, textContent: '', className: '', dataset: {}, attrs: {}, title: '',
		innerHTML: '', classList: { add() {} },
		setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
		appendChild(c) { this.children.push(c); return c; },
		addEventListener(k, f) { this.handlers[k] = f; } };
}
function texts(e, out = []) { if (e.textContent) out.push(e.textContent); e.children.forEach((c) => texts(c, out)); return out; }
function hasClass(e, c) { return String(e.className || '').split(' ').includes(c) || e.children.some((x) => hasClass(x, c)); }

// His Lifelog, read off his phone: dev/fixtures/u99/his_lifelog_notrun.txt.
const HIS = JSON.parse(readFileSync(new URL('../../dev/fixtures/u99/his_lifelog_notrun.txt', import.meta.url), 'utf8')
	.split('\n').filter((l, i) => i > 0 && l && !l.startsWith('#')).join('\n'));
const DAYS = HIS.handoffs.map((s) => +s.slice(8, 10));
const OCT = (d) => Date.UTC(2026, 9, d, 9, 0, 0);

// His Lifelog's shape: three hand-offs that found nobody (Oct 3, 13, 14), each followed by a
// later turn and its answer, then the newest turn.
function lifelog() {
	const msgs = [];
	DAYS.forEach((d, i) => {
		const tid = 'h' + i;
		msgs.push({ role: 'user', content: 'note for Oct ' + d, mid: tid, iturn: tid, ts: OCT(d) });
		msgs.push({ role: 'assistant', content: '', interrupted: true, why: 'dispatched', iturn: tid, mid: tid + '-ph',
			itext: 'note for Oct ' + d, ts: OCT(d) + 1000 });
		msgs.push({ role: 'user', content: 'later ' + d, mid: 'l' + i, iturn: 'l' + i, ts: OCT(d) + 60000 });
		msgs.push({ role: 'assistant', content: 'answered', mid: 'l' + i + '-a', iturn: 'l' + i, ts: OCT(d) + 90000 });
	});
	msgs.push({ role: 'user', content: 'the newest', mid: 'n', iturn: 'n', ts: OCT(20) });
	msgs.push({ role: 'assistant', content: '', interrupted: true, why: 'dispatched', iturn: 'n', mid: 'n-ph',
		itext: 'the newest', ts: OCT(20) + 1000 });
	return { id: HIS.chat, diamondId: HIS.diamond, messages: msgs };
}

// `states`: the §5 state each turn's placeholder reads, by iturn.
function world(chat, states) {
	const W = { posted: [], missing: [] };
	const env = {
		window: null, Date, String, Object, Array, JSON, Math, Error,
		document: { createElement: el },
		t: (k) => k, tOr: (k) => k,
		current: chat, pg: { current: chat },
		peerUiStateFor: (m) => states[String(m.iturn)] || 'dispatched',
		dispatchedAnswerPresent: () => false,
		handoffClaimLabel: () => '', handoffTargetLabel: () => '',
		buildTile: (kind, o) => { const t = el('div'); t.kind = kind; t.opts = o; t._body = el('div'); t.appendChild(t._body); return t; },
		drawHandoffWorkers: () => {}, tagTurn: () => {}, blockerFor: () => null,
		postToChat: (t) => { W.posted.push(t); },
		renderBlockerFooter: () => {},
		turnRunnerId: () => '', runnerLabel: () => '', interruptedRunner: () => null, pausedBack: () => '',
		consentActPhrase: () => '', _openAsk: {},
		seatReason: () => ({ why: 'why', label: 'label' }), notRunWhyKey: () => null,
		DaimondTime: { fmtLocal: (ts) => 'Oct ' + new Date(ts).getUTCDate() },
		isMobileDeviceSelf: () => true, seatPlanNow: () => ({ why: 'no-desktop' }), deviceLabelFor: () => '',
		seatNameOf: () => '',
		DaimondPeer: { uiState: () => 'x', dispatchControl: () => '', steerEchoes: () => ({}) },
		retryTurn: () => {}, reRunParked: () => {}, continueTurn: () => {}, answerAgain: () => {},
	};
	env.window = env;
	const L = lift(SRC, FNS, []);
	W.missing = L.missing.filter((n) => !OPTIONAL.includes(n));
	const body = L.body + '\nreturn {' + FNS.map((n) => n + ': ' + (L.missing.includes(n) ? 'null' : n)).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
		get: (t, k) => { if (!(k in t) && typeof k === 'string' && !(k in globalThis)) throw new ReferenceError(k + ' is not in the fakes'); return t[k]; },
		set: (t, k, v) => { t[k] = v; return true; },
	});
	W.f = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
	return W;
}

const placeholders = (c) => c.messages.filter((m) => m.why === 'dispatched');
const notRunWords = (t) => texts(t).filter((s) => /^turn\.not_run/.test(s));
const hint = (t) => texts(t).filter((s) => s === 'seat.tile_local_mobile');

{
	console.log('O1: his Lifelog: three ended hand-offs a later turn follows draw nothing');
	const chat = lifelog();
	const W = world(chat, { h0: HIS.state, h1: HIS.state, h2: HIS.state, n: 'dispatched' });
	check('O1 every function lifts', W.missing.length === 0, W.missing.join(', '));
	placeholders(chat).slice(0, 3).forEach((m) => W.f.appendDispatchedTile(m));
	check('O1 his three are October hand-offs', DAYS.join() === '3,13,14' && HIS.shown.length === 3, JSON.stringify(HIS.handoffs));
	check('O1 no tile is drawn for the three', W.posted.length === 0,
		W.posted.map((t) => notRunWords(t).concat(hint(t)).join('+')).join(' | '));
	check('O1 no "Runs here -- keep this open" on any of them', W.posted.every((t) => hint(t).length === 0));
	// Every ended state, not just the one his phone read.
	['failed', 'interrupted', 'parked', 'ending', 'no-peer-awake', 'not-dispatched'].forEach((st) => {
		const V = world(lifelog(), { h0: st });
		V.f.appendDispatchedTile(placeholders(lifelog())[0]);
		check('O1 a superseded hand-off ended "' + st + '" draws nothing', V.posted.length === 0);
	});
	check('O1 the rows stand in the chat', placeholders(chat).length === 4);
}
{
	console.log('O2: a hand-off still on the road keeps its tile and spinner');
	['dispatched', 'claimed', 'running', 'awaiting-consent'].forEach((st) => {
		const chat = lifelog();
		const W = world(chat, { h1: st });
		W.f.appendDispatchedTile(placeholders(chat)[1]);
		const t = W.posted[0];
		check('O2 superseded but "' + st + '": one tile, spinning, no "Not run"', W.posted.length === 1 && hasClass(t, 'ti-spin')
			&& notRunWords(t).length === 0, t ? texts(t).join(',') : 'no tile');
	});
}
{
	console.log('O3: the newest turn\'s hand-off that found nobody keeps its tile and hint');
	const chat = lifelog();
	const W = world(chat, { n: 'no-peer-awake' });
	W.f.appendDispatchedTile(placeholders(chat)[3]);
	const t = W.posted[0];
	check('O3 one tile, with "Runs here -- keep this open"', W.posted.length === 1 && hint(t).length === 1,
		t ? texts(t).join(',') : 'no tile');
	check('O3 and no "Not run" record words', !!t && notRunWords(t).length === 0, t ? texts(t).join(',') : '');
}
{
	console.log('O4: a superseded hand-off with an answer bubble: no "Not run" footer under it');
	const chat = lifelog();
	const W = world(chat, { h0: 'failed' });
	const m = Object.assign({}, placeholders(chat)[0], { content: 'part of an answer' });
	const foot = el('div');
	W.f.renderDispatchedFooter(foot, m);
	check('O4 the footer says nothing and offers nothing', foot.children.length === 0, texts(foot).join(','));
}

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
process.exit(failures ? 1 : 0);
