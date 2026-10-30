/* ============================================================
   Test -- a runner turn's question comes home as buttons (RUNNER-ASK, UNBLOCK-38).
   ------------------------------------------------------------
   A turn run on a runner that puts him a choice ends with `report.ask`, the question's
   payload. The asking tab draws the existing Decision tile from it, inline at the end of the
   turn, and his pick is his next message.

   WHAT IS CHECKED, over the REAL peer.js and the REAL settle, card and send lifted from
   daimond.js:
     (a) settleRunnerAsk stores one Ask row and draws one Decision tile from `report.ask`,
         in plain text: a payload holding HTML shows as literal text;
     (b) the pick is sent once, through the one send entry, on the seat drawn at the press;
     (c) a reload redraws the tile from the stored row, the report heard again stores
         nothing more, and nothing is sent until he presses;
     (d) a report with no `ask` changes nothing;
     (e) makeReport writes `ask` last, and only when present.

   Run:  node www/js/runnerask.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
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

// ── A DOM just large enough for the card ─────────────────────
class El {
	constructor(tag) {
		this.tagName = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.style = {};
		this.attrs = {}; this.on = {}; this._text = ''; this.innerHTMLSet = []; this.className = '';
		const self = this;
		this.classList = {
			add(...c) { const s = new Set(self.className.split(' ').filter(Boolean)); c.forEach((x) => s.add(x)); self.className = [...s].join(' '); },
			remove(...c) { self.className = self.className.split(' ').filter((x) => x && !c.includes(x)).join(' '); },
			toggle(c, on) { if (on) this.add(c); else this.remove(c); },
			contains(c) { return self.className.split(' ').includes(c); },
		};
	}
	set textContent(v) { this._text = String(v); this.children = []; }
	get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
	set innerHTML(v) { this.innerHTMLSet.push(String(v)); }
	appendChild(c) { if (c.parentNode) c.remove(); c.parentNode = this; this.children.push(c); return c; }
	insertBefore(c, ref) {
		if (c.parentNode) c.remove();
		c.parentNode = this;
		const i = this.children.indexOf(ref);
		if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
		return c;
	}
	remove() { if (this.parentNode) { const p = this.parentNode; p.children = p.children.filter((x) => x !== this); this.parentNode = null; } }
	contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
	setAttribute(k, v) { this.attrs[k] = String(v); }
	addEventListener(k, f) { (this.on[k] = this.on[k] || []).push(f); }
	click() { (this.on.click || []).forEach((f) => f({ preventDefault() {} })); }
	focus() {}
	all() { return this.children.flatMap((c) => [c, ...c.all()]); }
	querySelectorAll(sel) { const cls = sel.replace(/^\./, ''); return this.all().filter((e) => e.classList.contains(cls)); }
	querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
const document = { createElement: (t) => new El(t), body: null };

// ── The real peer.js, for makeReport ─────────────────────────
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

// ── The tab: the settle, the card and the one send entry ────
const SRC = readPage(join(HERE, 'daimond.js'), 'utf8');
const NAMES = ['chatHoldsTurn', 'chatHoldingReport', 'runnerAskArgs', 'settleRunnerAsk', 'askDrawable', 'askCurrent',
	'blockedAsk', 'renderAsk', 'askAnswer', 'askClose', 'askMarkAnswered', 'sendUserMessage'];
const bodies = NAMES.map((n) => lift(SRC, n));
check('the tab draws a runner\'s question through daimond.js', bodies.every(Boolean), NAMES.filter((n, i) => !bodies[i]));

const NOW = 1_790_000_000_000;
const HTML = '<img src=x onerror="alert(1)"><b>bold</b>';
const ASK = {
	key: 'publish', header: 'Diary',
	question: 'Publish the diary ' + HTML + '?',
	options: [
		{ label: 'Museum first', means: 'Ask the Amsterdam museum ' + HTML, recommended: true },
		{ label: 'Publish now', description: 'Translate and publish' },
	],
	recommend: 'Museum first', why: 'The museum may hold the rights.', if_silent: 'I will draft the museum letter.',
	multi: false,
};

/// One tab. `stored` is the chat's transcript as the store holds it, shared by a reload.
function tab(stored) {
	const st = { sent: [], drawn: 0, persisted: 0, diags: [], seat: 'argonaut', presses: [], tombs: {} };
	const chatOutput = new El('div');
	document.body = chatOutput;
	const chat = { id: 'c1', diamondId: '', _loaded: false, messages: null, _stored: stored };
	const chats = [chat];
	const load = async (c) => { if (c && !c._loaded) { c.messages = c._stored; c._loaded = true; } return c; };
	const env = {
		window: { DaimondPeer: P }, document, chats, loadChatMessages: load, chatInput: { value: '' },
		chatHoldingTurn: () => null, diag: (t, d) => st.diags.push(t + ' ' + d),
		loadMsgTombs: () => st.tombs, touchMsg: (m) => m, touchChat() {}, persistChats() { st.persisted++; },
		ownsChat: (c) => c === env.current, renderHistory(msgs) {
			st.drawn++;
			msgs.forEach((m) => {
				if (m.role === 'tool_log' && m.name === 'ask') F.renderAsk(m.args, m.ts);
				else if (m.role === 'user') F.askMarkAnswered(m.content, m.app === true);
			});
		},
		current: chat, chatOutput, t: (k, a) => k + (a ? ':' + JSON.stringify(a) : ''), SEND_ARROW: '<svg></svg>',
		ASK_CHOSE: 'Chose: ', ASK_OTHER: 'Other: ', ASK_SILENT_MAX_MS: 30 * 60 * 1000,
		finalizeAssistant() {}, pinAwaiting(c) { chatOutput.appendChild(c); }, unpinAwaiting() {},
		firstAwaiting: () => null, renderQueue() {}, nearBottom: () => false, setScrollTop() {},
		armAskIdleBound() {}, Date: { now: () => NOW },
		// The one send entry's own collaborators: the seat it reads at the press, and the body.
		seatDrawnRunner: () => st.seat,
		holdSend(c) { c._sending = true; return () => { c._sending = false; }; },
		async sendPressed(target, text, press) { st.sent.push({ chat: target && target.id, text, drawn: press.drawn }); },
	};
	const names = Object.keys(env);
	const F = bodies.every(Boolean) ? new Function(...names,
		'var _askCard = null;\n' + bodies.join('\n') + '\nreturn { settleRunnerAsk, renderAsk, askMarkAnswered, sendUserMessage,'
		+ ' askCard: function () { return _askCard; } };')(...names.map((k) => env[k])) : null;
	return { st, chat, chatOutput, F, settle: async (r) => { try { return F ? await F.settleRunnerAsk(r) : 'no settle'; } catch (e) { return 'threw ' + e.message; } } };
}
const rep = P.makeReport({ eid: 'e-ask1', turnId: 't1', chatId: 'c1', status: 'done', ts: NOW - 5000, words: 'w', ask: ASK });

// (a) One Ask row, one tile, plain text.
const turn = () => [{ role: 'user', mid: 't1', content: 'Can I publish it?', ts: NOW - 60_000 },
	{ role: 'assistant', mid: 'a1', iturn: 't1', content: 'Here is what I found.', ts: NOW - 6000 }];
const shared = turn();
{
	const { st, chat, chatOutput, F, settle } = tab(shared);
	const took = await settle(rep);
	const rows = (chat.messages || []).filter((m) => m.role === 'tool_log' && m.name === 'ask');
	check('(a) the report\'s question is stored as one Ask row at the end of the turn', took === true && rows.length === 1
		&& chat.messages[chat.messages.length - 1] === rows[0] && rows[0].iturn === 't1' && rows[0].outcome === 'done'
		&& st.persisted >= 1, { took, rows, persisted: st.persisted });
	const cards = chatOutput.querySelectorAll('.ask-card');
	check('(a) one Decision tile is drawn', cards.length === 1, cards.length);
	const card = cards[0];
	const q = card && card.querySelector('.ask-q');
	check('(a) the question is plain text: its HTML shows as literal text', !!q && q.textContent === ASK.question, q && q.textContent);
	const means = card ? card.querySelectorAll('.ask-means').map((e) => e.textContent) : [];
	check('(a) each option\'s words are plain text, a description standing for its meaning',
		means[0] === ASK.options[0].means && means[1] === 'Translate and publish', means);
	const html = card ? card.all().flatMap((e) => e.innerHTMLSet) : [];
	check('(a) none of the model\'s words reach innerHTML', !html.some((h) => h.indexOf('onerror') >= 0 || h.indexOf('<b>') >= 0), html);
	check('(a) the recommended option is marked', !!card && card.querySelectorAll('.recommended').length === 1);
	check('(a) drawing sends nothing', st.sent.length === 0, st.sent);

	// (b) The pick: once, through the one send entry, on the seat drawn at the press.
	const opt = card && card.querySelectorAll('.ask-opt')[0];
	// A press in flight holds the send, and the switch is redrawn Here while it waits: the pick
	// still goes on the seat drawn when he pressed (rulings l.19).
	let free;
	chat._sending = true;
	chat._sent = new Promise((r) => { free = r; });
	if (opt) { opt.click(); st.seat = ''; opt.click(); }
	chat._sending = false;
	free();
	await new Promise((r) => setTimeout(r, 0));
	check('(b) the pick is sent once, as his next message', st.sent.length === 1 && st.sent[0].text === 'Chose: Museum first'
		&& st.sent[0].chat === 'c1', st.sent);
	check('(b) on the seat drawn at the press', st.sent.length === 1 && st.sent[0].drawn === 'argonaut', st.sent);
	check('(b) the card is answered', !!card && card.dataset.answered === '1');
	// The send's body stores his row; the store holds it for the reload below.
	shared.push({ role: 'user', mid: 't2', content: 'Chose: Museum first', ts: NOW + 1000 });
}

// (c) A reload: the tile is redrawn from the stored row, the report heard again stores nothing.
{
	const { st, chat, chatOutput, F, settle } = tab(shared);
	const again = await settle(rep);
	const rows = (chat.messages || []).filter((m) => m.role === 'tool_log' && m.name === 'ask');
	check('(c) the report heard again after a reload stores no second row', again === false && rows.length === 1,
		{ again, n: rows.length });
	st.drawn = 0;
	chatOutput.children = [];
	if (F) {
		chat.messages.forEach((m) => {
			if (m.role === 'tool_log' && m.name === 'ask') F.renderAsk(m.args, m.ts);
			else if (m.role === 'user') F.askMarkAnswered(m.content, m.app === true);
		});
	}
	const cards = chatOutput.querySelectorAll('.ask-card');
	check('(c) the tile is redrawn from the stored row', cards.length === 1
		&& cards[0].querySelector('.ask-q').textContent === ASK.question, cards.length);
	check('(c) the redrawn tile reads answered by the pick that followed it', cards.length === 1 && cards[0].dataset.answered === '1'
		&& cards[0].querySelectorAll('.chosen').length === 1);
	check('(c) a reload sends nothing', st.sent.length === 0, st.sent);
	// The question still open on a reload: redrawn, and still nothing sent until he presses.
	const open = tab(turn());
	await open.settle(rep);
	const o2 = tab(open.chat.messages);
	await o2.settle(rep);
	o2.chatOutput.children = [];
	if (o2.F) o2.chat.messages.forEach((m) => { if (m.role === 'tool_log' && m.name === 'ask') o2.F.renderAsk(m.args, m.ts); });
	const c2 = o2.chatOutput.querySelectorAll('.ask-card');
	check('(c) an open question is redrawn open, and nothing is sent', c2.length === 1 && !c2[0].dataset.answered
		&& o2.st.sent.length === 0 && o2.chat.messages.filter((m) => m.name === 'ask').length === 1);
	// A tombstoned row stays gone.
	const t3 = tab(turn());
	t3.st.tombs['ask-e-ask1'] = 1;
	check('(c) an Ask row deleted here is not brought back', await t3.settle(rep) === false
		&& !(t3.chat.messages || []).some((m) => m.name === 'ask'));
}

// (d) No `ask`, or one the tile cannot draw: nothing changes.
{
	const { st, chat, chatOutput, settle } = tab(turn());
	const before = JSON.stringify(turn());
	const none = P.makeReport({ eid: 'e2', turnId: 't1', chatId: 'c1', status: 'done', ts: NOW });
	check('(d) a report with no ask stores and draws nothing', await settle(none) === false && st.persisted === 0
		&& chatOutput.children.length === 0 && (chat.messages === null || JSON.stringify(chat.messages) === before), chat.messages);
	const bad = Object.assign({}, rep, { eid: 'e3', ask: { question: 'Which?', options: [{ label: 'One' }] } });
	check('(d) a question the tile cannot draw stores nothing', await settle(bad) === false && st.persisted === 0
		&& !(chat.messages || []).some((m) => m.name === 'ask'));
	const blocked = Object.assign({}, rep, { eid: 'e4', ask: Object.assign({}, ASK, { app: 'blocked' }) });
	await settle(blocked);
	const row = (chat.messages || []).find((m) => m.name === 'ask');
	check('(d) a runner\'s question never passes for the engine\'s own blocked Decision', !row || JSON.parse(row.args).app === undefined,
		row && row.args);
	const other = tab(turn());
	other.chat.messages = [{ role: 'user', mid: 'zz' }];
	other.chat._loaded = true;
	check('(d) a chat that does not hold the turn takes nothing', await other.settle(Object.assign({}, rep, { eid: 'e5' })) === false
		&& other.chat.messages.length === 1);
}

// (g) ORDER (QA round 2, MED2 race): the report names the frame's own Ask row (`report.ask.row`),
// so report-first and frame-first each leave exactly one row and draw exactly one card.
{
	const RID = 'R1-t3';
	const repRow = P.makeReport({ eid: 'e-ask9', turnId: 't1', chatId: 'c1', status: 'done', ts: NOW - 5000,
		ask: Object.assign({}, ASK, { row: RID }) });
	// The frame's row holds the ask tool's own arguments, each option's meaning as `means` (the contract).
	const TOOL = Object.assign({}, ASK, { options: ASK.options.map((op) => ({ label: op.label, means: op.means || op.description,
		...(op.recommended ? { recommended: true } : {}) })) });
	const frameRow = { mid: RID, role: 'tool_log', name: 'ask', args: JSON.stringify(TOOL), content: '', outcome: 'done',
		ts: NOW - 5500, run: 'R1', whole: 1 };
	const askRows = (c) => (c.messages || []).filter((m) => m.role === 'tool_log' && m.name === 'ask');
	// Report first. The log's copy of the row that lands after it joins by mid (turnlog.test JOIN).
	const a = tab(turn());
	const tookA = await a.settle(repRow);
	const rowsA = askRows(a.chat);
	check('(g) report first: the row is stored under the frame\'s own id', tookA === true && rowsA.length >= 1 && rowsA[0].mid === RID,
		rowsA.map((m) => m.mid));
	check('(g) report first: exactly one Ask row (one card)', rowsA.length === 1, rowsA.map((m) => m.mid));
	// Frame first, then the report.
	const b = tab(turn().concat([Object.assign({ iturn: 't1' }, frameRow)]));
	const tookB = await b.settle(repRow);
	const rowsB = askRows(b.chat);
	check('(g) frame first, then the report: exactly one Ask row (one card), nothing stored', tookB === false && rowsB.length === 1
		&& b.st.persisted === 0, rowsB.map((m) => m.mid));
	// The card count, drawn from each transcript as a reload draws it.
	for (const [name, t] of [['report first', a], ['frame first', b]]) {
		const ms = t.chat.messages.slice();
		t.chatOutput.children.length = 0;
		ms.forEach((m) => { if (m.role === 'tool_log' && m.name === 'ask') t.F.renderAsk(m.args, m.ts); });
		check('(g) ' + name + ': one card drawn', t.chatOutput.querySelectorAll('.ask-card').length === 1, t.chatOutput.querySelectorAll('.ask-card').length);
	}
	const c = tab(turn());
	await c.settle(Object.assign({}, repRow, { ask: Object.assign({}, ASK, { row: '<b>bad id</b>' }) }));
	check('(g) a row id that is not an id falls back to ask-<eid>', askRows(c.chat).length === 1 && askRows(c.chat)[0].mid === 'ask-e-ask9',
		askRows(c.chat).map((m) => m.mid));
}

// (f) QA MED2: one ask row per question. The runner's final frame already carries the question as
// the done Ask row its run wrote; the report's copy then stores nothing, so one tile is drawn.
{
	const framed = turn().concat([{ role: 'tool_log', mid: 'R1-t3', iturn: 't1', run: 'R1', name: 'ask',
		args: JSON.stringify(ASK), content: '', outcome: 'done', ts: NOW - 5500 }]);
	const { st, chat, chatOutput, settle } = tab(framed);
	const took = await settle(rep);
	const rows = (chat.messages || []).filter((m) => m.role === 'tool_log' && m.name === 'ask');
	check('(f) a frame that holds the question\'s Ask row: the report stores no second row', took === false && rows.length === 1
		&& rows[0].mid === 'R1-t3' && st.persisted === 0, rows.map((m) => m.mid));
	check('(f) and draws no second tile', chatOutput.querySelectorAll('.ask-card').length === 0, chatOutput.children.length);
	const other = tab(turn().concat([{ role: 'tool_log', mid: 'R1-t3', iturn: 't1', run: 'R1', name: 'ask',
		args: JSON.stringify(Object.assign({}, ASK, { question: 'Another question?' })), content: '', outcome: 'done', ts: NOW - 5500 }]));
	check('(f) a frame whose Ask row is another question does not stand for this one', await other.settle(rep) === true
		&& other.chat.messages.filter((m) => m.name === 'ask').length === 2);
}

// (e) makeReport writes `ask` last, only when present.
{
	const s = JSON.stringify(rep);
	check('(e) makeReport carries the ask, last, after words', s.endsWith(',"words":"w","ask":' + JSON.stringify(ASK) + '}'), s.slice(-160));
	check('(e) a report with no ask names none', !('ask' in P.makeReport({ eid: 'x' }))
		&& !('ask' in P.makeReport({ ask: null })) && !('ask' in P.makeReport({ ask: 'text' })) && !('ask' in P.makeReport({ ask: [1] })));
	const words = P.makeReport({ eid: 'x', words: 'w', alerts: [{ op: 'clear', key: 'k' }], ask: { question: 'q' } });
	const keys = Object.keys(words);
	check('(e) ask follows alerts and words', keys.slice(-3).join() === 'alerts,words,ask', keys);
}

console.log((failures ? 'FAIL' : 'PASS') + ' runnerask ' + (checks - failures) + '/' + checks);
process.exit(failures ? 1 : 0);
