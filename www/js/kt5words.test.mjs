/* ============================================================
   Test -- a runner's staged words are filed here before its session lands (U2b).
   ------------------------------------------------------------
   A turn run on a Kimberlite runner folds over the tab's own words log, sent as `seed.words`,
   and files nothing on the runner's disk: what its folds staged comes home on the report as
   `words` (the words log's entry form). The asking tab files them into its own log through
   the wasm door `words_file`, under the keeper of the chat holding the turn -- never one the
   report names -- and only then stores the runner's session. A filing that fails stores no
   session, so the engine is laid from the transcript, where every word still is.

   WHAT IS CHECKED, over the REAL peer.js and the REAL daimond.js functions lifted by source:
     (a) buildDispatch puts `seed.words` beside the session, and the reference rung drops it;
     (b) makeReport writes `words` last, only when non-empty, as the runner's vector has it;
     (c) onReport files the words BEFORE the session is stored, keeper `chat:<id>` or the
         Diamond id of the chat holding the turn, whatever the report names;
     (d) a filing that fails stores no session, drops the engine, and says so;
     (e) a report heard again files again and stores once;
     (f) a report with no words files nothing and still lands.

   Run:  node www/js/kt5words.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}

/// The index just past the brace that closes the one at `open`.
function balanced(src, open) {
	let depth = 0, i = open;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) return i + 1; }
	}
	return i;
}
/// The source of `[async] function name(...) {...}`, or null.
function lift(src, name) {
	const m = new RegExp('\\n\\t(async )?function ' + name + '\\(').exec(src);
	if (!m) return null;
	return src.slice(m.index + 1, balanced(src, src.indexOf('{', m.index)));
}

// ── The real peer.js ──
const pw = { addEventListener() {}, dispatchEvent() { return true; } };
{
	const quiet = { debug() {}, log() {}, warn() {}, error: console.error };
	const doc = { readyState: 'complete', addEventListener() {}, querySelector: () => null,
		querySelectorAll: () => [], getElementById: () => null };
	for (const rel of ['stamp.js', 'peer.js']) {
		const body = readFileSync(join(HERE, rel), 'utf8');
		new Function('window', 'document', 'console', 'localStorage', 'navigator', 'CustomEvent',
			'with (window) {\n' + body + '\n}')(pw, doc, quiet,
			{ getItem: () => null, setItem() {}, removeItem() {} }, { storage: {} }, function () {});
	}
}
const P = pw.DaimondPeer;
const PEER_SRC = readFileSync(join(HERE, 'peer.js'), 'utf8');
const T0 = 1790000000000;
const LOG = '## His words\n\n### [k1] 2026-10-25\n> q1\n\n';
const WORDS = '\n### [m1] 2026-10-25\n> u2 first "quoted" é\n\n### 2026-10-25\n> over\n> two lines\n\n';

// (a) The seed carries the log beside the session; the reference rung drops it.
{
	const small = { id: 'chat-u2', provider: 'openrouter', model: 'test/m', holds: [], messages: [
		{ role: 'user', content: 'q1', mid: 'k1', ts: T0 },
		{ role: 'assistant', content: 'a1', mid: 'k2', ts: T0 + 1 },
		{ role: 'user', content: 'the u2 turn', mid: 'TURN-U2', ts: T0 + 2 }] };
	const o = { turnId: 'TURN-U2', prompt: 'the u2 turn', dispatchedBy: 'devPHONE', now: T0 };
	const sess = { v: 1, msgs: [{ role: 'user', content: 'FOLD' }], upto: 'k1', uptoTs: T0, marks: {},
		tail: [{ role: 'assistant', content: 'a1', mid: 'k2' }] };
	let seed = null;
	try { seed = P.buildDispatch(small, Object.assign({}, o, { session: sess, words: LOG })).errand(0).seed; } catch (e) { seed = { threw: e.message }; }
	const keys = seed ? Object.keys(seed) : [];
	check('(a) the seed carries the words log, just after the session', seed && seed.words === LOG
		&& keys.indexOf('words') === keys.indexOf('session') + 1, keys);
	let bare = null;
	try { bare = P.buildDispatch(small, Object.assign({}, o, { words: LOG })).errand(0).seed; } catch (e) { bare = null; }
	check('(a) and with no session too', !!bare && bare.words === LOG && !('session' in bare));
	let none = null;
	try { none = P.buildDispatch(small, Object.assign({}, o, { session: sess, words: null })).errand(0).seed; } catch (e) { none = null; }
	check('(a) no words given, none sent', !!none && !('words' in none) && !!none.session);
	const fit = lift(PEER_SRC, 'sealFittingErrand') || '';
	const rung = fit.slice(fit.indexOf('if (p.fields.seed && p.fields.seed.session)'));
	check('(a) the reference rung drops the words with the session', /o1\.session\s*=\s*null;[\s\S]{0,200}o1\.words\s*=\s*null;/.test(rung.slice(0, 600))
		|| /o1\.words\s*=\s*null;[\s\S]{0,200}o1\.session\s*=\s*null;/.test(rung.slice(0, 600)));
}

// (b) makeReport writes `words` last, only when there are any, as the runner's codec does.
{
	const rep = P.makeReport({ eid: 'e1', turnId: 't1', chatId: 'c1', sessionStayed: 1, words: WORDS });
	check('(b) makeReport carries the words, last, after sessionStayed',
		JSON.stringify(rep).endsWith(',"sessionStayed":1,"words":' + JSON.stringify(WORDS) + '}'), JSON.stringify(rep).slice(-160));
	const both = P.makeReport({ eid: 'e1', alerts: [{ op: 'clear', key: 'k' }], words: WORDS });
	check('(b) after the alerts too', JSON.stringify(both).endsWith('"alerts":[{"op":"clear","key":"k"}],"words":' + JSON.stringify(WORDS) + '}'));
	check('(b) a report with no words names none', !('words' in P.makeReport({ words: '' })) && !('words' in P.makeReport({}))
		&& !('words' in P.makeReport({ words: 5 })));
	const nv = JSON.parse(readFileSync(join(HERE, '../../kimberlite/src/errands/testdata/native_vectors.json'), 'utf8'));
	const g = nv.golden.report_words || '';
	const back = g ? JSON.stringify(P.makeReport(JSON.parse(g))) : '';
	check('(b) the runner\'s report_words vector is the bytes makeReport writes', !!g && back === g, back.slice(-160));
}

// (c)-(f) The tab's onReport and settle, lifted from daimond.js over stubs.
const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
function reportHandler() {
	const at = SRC.indexOf('DaimondPeer.onReport(');
	if (at < 0) return '';
	const open = SRC.indexOf('function', at);
	const start = SRC.slice(at, open).includes('async') ? SRC.lastIndexOf('async', open) : open;
	return '(' + SRC.slice(start, balanced(SRC, SRC.indexOf('{', open))) + ')';
}
const st = { held: null, diags: [], persisted: 0, filed: [], fail: false };
const stubs = {
	window: { DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' && r.status !== 'parked', handBackReport: () => false } },
	DaimondPeer: { handBackReport: () => false, settlingReport: (r) => !!r && r.t === 'report' && r.status !== 'parked' },
	Wasm: {
		words_file: async (keeper, entries) => {
			st.filed.push({ keeper, entries, upto: st.held && st.held.session ? st.held.session.upto : null });
			if (st.fail) throw new Error('the store is gone');
			return 'filed 2 of his messages';
		},
	},
	diag: (t, d) => st.diags.push(t + ' ' + d),
	chatHoldingTurn: () => st.held,
	touchChat() {}, persistChats() { st.persisted++; },
	markChatTainted: () => false,
	loadMsgTombs: () => ({}),
	peerReports: {}, takeReportTaint() {}, settleRunnerAlerts() {}, settleRunnerAsk() {}, recordCarriedTurn() {}, requeueUnheard() {},
	_openAsk: {}, markPlaceholderParked() {}, updateExpedite() {}, adoptFinalFrame: () => false, readReportedFinal: () => false, otherErrandReport: () => false, renderDispatchedBadges() {},
};
const names = ['settleRunnerWords', 'settleRunnerSession', 'staleEngine', 'captureSession', 'sessionHeld', 'keepChatTaint'];
const lifted = names.map((n) => lift(SRC, n));
check('daimond.js files a runner\'s words (settleRunnerWords)', !!lifted[0]);
const handler = reportHandler();
const api = new Function('stubs', 'with (stubs) {\n' + lifted.filter(Boolean).join('\n')
	+ '\nreturn { onReport: ' + (handler || 'null') + ' };\n}')(stubs);

const RUN = [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1' },
	{ role: 'user', content: 'read it', mid: 't2' }, { role: 'assistant', content: 'it says 7' }];
function chat(over) {
	const app = { busy: false };
	return Object.assign({ id: 'c1', _loaded: true, app, _held: { app }, messages: [],
		session: { v: 1, upto: 'a1', uptoTs: T0 + 1, marks: { u1: 0 }, msgs: RUN.slice(0, 2) } }, over || {});
}
const report = (over) => Object.assign({ t: 'report', status: 'done', turnId: 't2', chatId: 'not-this-chat',
	keeper: 'chat:not-this-chat', words: WORDS,
	session: { v: 1, msgs: RUN, turnStart: 2, base: 'a1', upto: 'e-t2-final', uptoTs: T0 + 3 } }, over || {});
async function hear(c, r) {
	st.held = c; st.diags = []; st.filed = []; st.persisted = 0;
	try { await api.onReport(r); } catch (e) { st.diags.push('threw ' + e.message); }
}

// (c) Filed first, under the holding chat's keeper.
{
	const c = chat();
	await hear(c, report());
	check('(c) the words are filed once, as the report carries them', st.filed.length === 1 && st.filed[0].entries === WORDS, st.filed);
	check('(c) under the holding chat\'s keeper, not the report\'s', st.filed[0] && st.filed[0].keeper === 'chat:c1', st.filed[0]);
	check('(c) BEFORE the session is stored', st.filed[0] && st.filed[0].upto === 'a1', st.filed[0]);
	check('(c) then the session lands', c.session.upto === 'e-t2-final' && st.persisted === 1, { upto: c.session.upto, diags: st.diags });
	const d = chat({ id: 'dc1', diamondId: 'd1' });
	await hear(d, report());
	check('(c) a Diamond\'s chat files under the Diamond', st.filed[0] && st.filed[0].keeper === 'd1', st.filed[0]);
}
// (d) The filing fails: no session, no engine, said.
{
	const c = chat();
	st.fail = true;
	await hear(c, report());
	st.fail = false;
	check('(d) a failed filing stores no session', c.session.upto === 'a1', c.session.upto);
	check('(d) and drops the stale engine', c.app === null, !!c.app);
	check('(d) and says his words were not filed', st.diags.some((t) => /words/.test(t) && /not filed/.test(t)), st.diags);
}
// (e) Heard again: filed again (the merge dedupes), stored once.
{
	const c = chat();
	await hear(c, report());
	const first = st.persisted;
	await hear(c, report());
	check('(e) a report heard again files again', st.filed.length === 1 && st.filed[0].keeper === 'chat:c1');
	check('(e) and stores once', first === 1 && st.persisted === 0 && c.session.upto === 'e-t2-final', { first, again: st.persisted });
}
// (f) No words: nothing filed, the session lands; no holding chat: nothing filed.
{
	const c = chat();
	await hear(c, report({ words: undefined }));
	check('(f) a report with no words files nothing and lands', st.filed.length === 0 && c.session.upto === 'e-t2-final');
	await hear(null, report());
	check('(f) a turn no chat holds files nothing', st.filed.length === 0);
}
console.log((failures ? 'FAIL' : 'PASS') + ' kt5words ' + (checks - failures) + '/' + checks);
process.exit(failures ? 1 : 0);
