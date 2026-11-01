/* ============================================================
   Test -- words said mid-turn on a runner are drawn where the model got them, and
   never as heard by a runner that has not shown it hears (UNBLOCK-59, page half).

   "I added a prompt mid-turn ... that said 'you cut in here' but I don't know what
   that means or whether it reached argonaut/Kimberlite" (31 Oct): the page drew
   "You cut in here" for words Kimberlite never handed to its model, then sent them
   again as a new turn.

     K1  a report's `heardStep` (the codec's new last key) is read over `heard`, only
         when something was heard, each step 2 or more;
     K2  the said bubble stands where the model got the words, at the runner's own
         record of them (after request N-1's output, before request N's), which is not
         drawn twice; a row Kimberlite writes under the said id (`interject:1`) stays put;
     K3  a native runner whose presence row does not say `hears` is not spoken to: the
         words wait in the queue, shown there, as the next turn; one that says it is,
         and its report's step and unheard words are read as before;
     K4  with no runner record of the words the thread draws byte for byte as before;
     K5  the runner's record of the words opens no turn (`turnSpan`, the turn count).

   Lifts the REAL functions out of daimond.js and the REAL peer.js.
   Red proof on the base (339feb876): K1, K2, K3 and K5 fail.   `node www/js/kimbsaypage.test.mjs`
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC  = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}
function lift(name) {
	let a = SRC.indexOf('\n\tfunction ' + name + '(');
	if (a < 0) a = SRC.indexOf('\n\tasync function ' + name + '(');
	if (a < 0) { console.log('  (this revision lacks: ' + name + ')'); return ''; }
	return SRC.slice(a, SRC.indexOf('\n\t}\n', a) + 3);
}

// ── peer.js, loaded as the page loads it ──
const win = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readPage(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(win, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const P = win.DaimondPeer;

// ── The fixture: one handed-off turn of run R, request 1 called a tool, words said
// during it were taken at the seam and rode request 2 (the runner's record, `R-t2`). ──
const RUN = 'R';
const SAID = { role: 'user', interject: true, content: 'you cut in here', mid: 's1', ts: 1500 };
function thread(said) {
	return [
		{ role: 'user', content: 'read the pages', mid: 'q1', ts: 1000 },
		{ role: 'think_log', content: 'request 1 working', mid: RUN + '-t0', ts: 1200, run: RUN, whole: 1 },
		said,
		{ role: 'tool_log', name: 'read', content: 'request 1 call', mid: RUN + '-t1', ts: 1600, run: RUN, whole: 1 },
		{ role: 'user', content: 'you cut in here', mid: RUN + '-t2', ts: 2000, run: RUN, whole: 1 },
		{ role: 'think_log', content: 'request 2 working', mid: RUN + '-t3', ts: 2100, run: RUN, whole: 1 },
		{ role: 'assistant', content: 'done', mid: RUN + '-final', ts: 2500, run: RUN, whole: 1 },
	];
}

console.log('K1 the codec: heardStep is read over heard');
{
	const mk = (f) => P.makeReport(Object.assign({ turnId: 't1', chatId: 'c1', status: 'done' }, f));
	const a = mk({ heard: ['s1', 's2'], heardStep: { s1: 2, s2: 4, sX: 3 } });
	check('with heardStep: each heard id with its step, nothing else',
		JSON.stringify(a.heardStep) === '{"s1":2,"s2":4}', JSON.stringify(a.heardStep));
	const b = mk({ heard: ['s1'] });
	check('without heardStep: no key', !('heardStep' in b), JSON.stringify(b));
	const c = mk({ heard: [], heardStep: { s1: 2 } });
	check('heard empty: no key', !('heardStep' in c) && c.heard.length === 0, JSON.stringify(c));
	const d = mk({ heard: ['s1'], heardStep: { s1: 1 } });
	check('a step below 2 is not a seam: no key', !('heardStep' in d), JSON.stringify(d));
}

console.log('K2 the bubble stands where the model got the words');
for (const step of [2, 0]) {
	const msgs = thread(Object.assign({}, SAID, step ? { heardStep: step } : {}));
	const out = P.heardOrder ? P.heardOrder(msgs) : msgs;
	const ix = (mid) => out.findIndex((m) => m.mid === mid);
	const tag = step ? ' (heardStep ' + step + ')' : ' (its step not yet here)';
	check('after request 1\'s output, before request 2\'s' + tag,
		ix('s1') === ix(RUN + '-t1') + 1 && ix(RUN + '-t3') === ix('s1') + 1, out.map((m) => m.mid).join(','));
	check('the runner\'s own record of the words is not drawn twice' + tag,
		ix(RUN + '-t2') === -1 && out.length === msgs.length - 1, out.map((m) => m.mid).join(','));
}
{
	const early = thread(Object.assign({}, SAID, { heardStep: 2 })).filter((m) => m.mid !== RUN + '-t2');
	const o2 = P.heardOrder ? P.heardOrder(early) : early;
	check('before the runner\'s rows arrive, it stands where it was said',
		o2.map((m) => m.mid).join(',') === early.map((m) => m.mid).join(','));
	// Kimberlite's row as it is to be written: under the said id, `interject:1`, at the seam.
	const fut = thread(Object.assign({}, SAID)).filter((m) => m.mid !== 's1' && m.mid !== RUN + '-t2');
	fut.splice(3, 0, { role: 'user', interject: 1, content: 'you cut in here', mid: 's1', ts: 2000, run: RUN, whole: 1 });
	const o3 = P.heardOrder ? P.heardOrder(fut) : fut;
	check('a row under the said id with interject:1 is the said bubble, where it stands', o3 === fut);
}
{
	// The same words said twice: each record answers one said row, in order.
	const two = [
		{ role: 'user', content: 'go', mid: 'q1', ts: 1000 },
		{ role: 'user', interject: true, content: 'again', mid: 'sa', ts: 1100 },
		{ role: 'user', interject: true, content: 'again', mid: 'sb', ts: 1150 },
		{ role: 'user', content: 'again', mid: RUN + '-t0', ts: 1300, run: RUN, whole: 1 },
		{ role: 'think_log', content: 'x', mid: RUN + '-t1', ts: 1400, run: RUN, whole: 1 },
		{ role: 'user', content: 'again', mid: RUN + '-t2', ts: 1500, run: RUN, whole: 1 },
	];
	const e = P.steerEchoes ? P.steerEchoes(two) : null;
	check('each record answers one said row', !!e && e[RUN + '-t0'] === 'sa' && e[RUN + '-t2'] === 'sb', JSON.stringify(e));
	const later = [{ role: 'user', interject: true, content: 'again', mid: 'sa', ts: 1100 },
		{ role: 'user', content: 'next question', mid: 'q2', ts: 1200 },
		{ role: 'user', content: 'again', mid: RUN + '-t0', ts: 1300, run: RUN, whole: 1 }];
	check('words said in an earlier turn answer no record in a later one', !P.steerEchoes || P.steerEchoes(later) === null);
}

// ── The asker's side, lifted: the say, the report, the bubble. ──
const NAMES = ['sayToRunner', 'requeueUnheard', 'hearsSaid', 'markHeard', 'appendInterjected'];
function el(tag) {
	return { tag: tag, className: '', textContent: '', title: '', style: {}, kids: [],
		appendChild(k) { this.kids.push(k); return k; } };
}
function ser(e) {
	const st = Object.keys(e.style).sort().map((k) => k + ':' + e.style[k]).join(';');
	return '<' + e.tag + ' class="' + e.className + '" title="' + e.title + '" style="' + st + '">'
		+ e.textContent + e.kids.map(ser).join('') + '</' + e.tag + '>';
}
const STR = { 'chat.interjected': 'You cut in here', 'chat.interjected_help': 'Said at this point; the model saw it from here.' };
function world(row) {
	const W = { said: [], recs: [], drawn: [], posted: [], resent: [], rendered: 0, queued: [], drained: 0 };
	// Kimberlite argonaut1's presence row, from its signed beat, through the real ingest.
	win.DaimondPresence.ingest({ argonaut1: Object.assign({ name: 'argonaut', last_seen: Date.now(), kind: 'runner',
		modelset: true }, row || {}) }, Date.now());
	const chat = { id: 'c1', messages: [] };
	const env = {
		window: null, diag: () => {}, dsEvent: () => {}, Date: Date, String: String, Object: Object, Array: Array,
		JSON: JSON, Math: Math, Promise: Promise,
		honoursModelSet: () => true, loadDevices: () => ({}), DaimondPresence: win.DaimondPresence,
		enqueueMessage: (c, text, words, drawn) => { W.queued.push({ text: text, drawn: drawn }); },
		drainAfterHeld: () => { W.drained++; },
		DaimondPeer: { frameHears: () => true, syncCas: () => ({}) },
		DaimondLease: { holder: () => 'argonaut1', say: async (tid, w) => { W.said.push(w); return { ok: true }; } },
		_peerStopping: {}, _progressView: {}, _saidThere: {},
		commitRatings: () => {}, ratingPre: () => '', newMid: () => 'm' + (W.said.length + 1), peerSyncShim: () => ({}),
		giveUpSent: () => {},
		pushUserRecord: (c, rec) => { W.recs.push(rec); c.messages.push(rec); return rec; },
		syncSendMode: () => {}, resendUnheard: (s) => { W.resent.push(s.mid); },
		touchMsg: (m) => m, touchChat: () => {}, persistChats: () => {}, renderHistory: () => { W.rendered++; },
		pg: { chats: [chat], current: chat }, chats: [chat], current: chat,
		document: { createElement: el },
		t: (k) => STR[k] || k, finalizeAssistant: () => {}, tagTurn: () => {}, postToChat: (d) => { W.posted.push(d); },
		nearBottom: () => false, setScrollTop: () => {}, chatOutput: { scrollHeight: 0 },
	};
	env.window = env;
	const have = NAMES.map((n) => [n, lift(n)]).filter((x) => x[1]);
	const body = have.map((x) => x[1]).join('\n') + '\nreturn {' + have.map((x) => x[0] + ': ' + x[0]).join(', ') + '};';
	const scope = new Proxy(env, {
		has: (t, k) => typeof k === 'string' && (k in t || !(k in globalThis)),
		get: (t, k) => t[k],
		set: (t, k, v) => { t[k] = v; return true; },
	});
	W.f = new Function('scope', 'with (scope) {\n' + body + '\n}')(scope);
	W.chat = chat;
	return W;
}

console.log('K3 a runner that has not said it hears is not spoken to');
{
	const W = world();
	const ok = await W.f.sayToRunner(W.chat, { iturn: 't1' }, 'you cut in here', 'you cut in here', 'argonaut1');
	check('nothing is said over the lease, and no bubble claims it cut in',
		ok === true && W.said.length === 0 && W.recs.length === 0 && W.posted.length === 0,
		'ok=' + ok + ' said=' + W.said.length + ' recs=' + JSON.stringify(W.recs));
	check('the words wait in the queue, shown there, as the next turn, under the runner drawn',
		W.queued.length === 1 && W.queued[0].text === 'you cut in here' && W.queued[0].drawn === 'argonaut1' && W.drained === 1,
		JSON.stringify(W.queued));
	const W0 = world({ hears: false });
	await W0.f.sayToRunner(W0.chat, { iturn: 't1' }, 'x', 'x');
	check('hears:false is not hears', W0.said.length === 0 && W0.queued.length === 1);
}
for (const hears of [1, true]) {
	const W = world({ hears: hears });
	const ok = await W.f.sayToRunner(W.chat, { iturn: 't1' }, 'you cut in here', 'you cut in here');
	const rec = W.recs[0] || {};
	check('hears:' + hears + ' in its beat: said over the lease, drawn as cut in',
		ok === true && W.said.length === 1 && W.queued.length === 0 && rec.interject === true
			&& W.posted[0] && W.posted[0].kids[0].textContent === '↳ You cut in here', JSON.stringify(rec));
	W.f.requeueUnheard({ turnId: 't1', heard: [rec.mid], heardStep: { [rec.mid]: 2 } });
	check('a report naming them heard stamps the step, resends nothing',
		rec.heardStep === 2 && W.resent.length === 0 && W.rendered === 1, JSON.stringify(rec));
	await W.f.sayToRunner(W.chat, { iturn: 't2' }, 'and this', 'and this');
	W.f.requeueUnheard({ turnId: 't2', heard: [] });
	check('words not in heard keep the requeue path', W.resent.length === 1 && W.resent[0] === (W.recs[1] || {}).mid, JSON.stringify(W.resent));
}

console.log('K4 no heardStep: the render is byte for byte as before');
{
	const plain = thread(Object.assign({}, SAID)).filter((m) => m.mid !== RUN + '-t2');
	check('the drawn order is the transcript itself',
		!P.heardOrder || P.heardOrder(plain) === plain);
	const W = world();
	W.f.appendInterjected('you cut in here');
	// The bubble as the base (339feb876) draws it.
	const BASE = '<div class="chat-msg chat-msg-interjected" title="" style="textAlign:right">'
		+ '<div class="chat-queued-head" title="Said at this point; the model saw it from here." style="">↳ You cut in here</div>'
		+ '<div class="chat-msg-content" title="Said at this point; the model saw it from here." style="'
		+ 'background:var(--accent-soft);borderLeft:3px solid var(--accent);borderRadius:var(--radius-lg);color:var(--accent-text);'
		+ 'display:inline-block;maxWidth:82%;padding:8px 14px;textAlign:left">you cut in here</div></div>';
	check('a cut-in bubble draws the same bytes', W.posted.every((d) => ser(d) === BASE), W.posted.map(ser).join('\n'));
}

console.log('K5 the runner\'s record of the words opens no turn');
{
	const msgs = thread(Object.assign({}, SAID)).map((m) => (m.mid === 'q1' ? Object.assign({}, m, { mid: 'T1' }) : m));
	const span = P.turnSpan(msgs, 'T1').map((m) => m.mid).join(',');
	check('the turn\'s span runs past the said words and their record to its answer',
		span === [RUN + '-t0', RUN + '-t1', RUN + '-t3', RUN + '-final'].join(','), span);
	const e = P.steerEchoes ? P.steerEchoes(msgs) : null;
	const turns = msgs.filter((m) => m.role === 'user' && !m.interject && !(e && e[String(m.mid)])).length;
	check('one question, one turn', turns === 1, String(turns));
}

console.log(failures ? '\n' + failures + ' FAILED' : '\nall passed');
process.exit(failures ? 1 : 0);
