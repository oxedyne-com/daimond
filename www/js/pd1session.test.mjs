/* ============================================================
   Test -- a session sent home by chunks (POSTDOOR PD1, page half).
   ------------------------------------------------------------
   A runner's session over the post door no longer stays there: Kimberlite puts it to sealed
   chunks on his account and the report carries `sessionRef`, their manifest (chunks.js's own
   `offloadPieces` shape), over a body `{v, chat, sig, upto, session}`. The tab reads it
   (`fetchRunnerSession`) and stores it as an inline session (`settleRunnerSession`). When the
   chunks were not stored, the report says `sessionStayed` with `sessionWhy`, and the turn
   shows why, keeping its status (runner-b's ruling, 08 Nov: nothing invites a rerun).

   WHAT IS CHECKED. The REAL functions, lifted from daimond.js over stubs, with
   `DaimondChunks.materialiseBytes` answering each piece's plaintext as the gateway's chunks
   would:
     (a) a report carrying `sessionRef` is read and its session stored: 'stored';
     (b) `chat.session.upto === ref.upto`, and the report heard again answers 'stored';
     (c) a piece not held, pieces out of order, or a body for another chat: nothing is stored,
         the turn says its chunks were not read;
     (d) `sessionStayed` with `sessionWhy` ("HTTP 402"): 'stayed', one note row on the turn
         naming why, drawn when the chat is on screen, once however often the report is heard;
         no status changed and nothing to rerun;
     (e) nothing is read where nothing would be stored: a session already held (a re-collect, or
         a tab that cannot unseal the pieces) answers 'stored' with no read and no row; a parked
         report and a busy chat read nothing; a turn noted as stayed whose session is later stored
         loses its row, through a tombstone;
     (f) the guards each have a case: a manifest whose size is not its pieces, a body whose
         `upto` is not the reference's while its session's is, a report carrying both `session`
         and `sessionRef` (the inline session is kept, nothing read), and a reference to another
         chat on this chat's turn.

   Run:  node www/js/pd1session.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readPage(join(HERE, 'daimond.js'), 'utf8');
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + JSON.stringify(detail) + ')')); }
}

/// The source of `function name(...) {...}`, brace-balanced, or null.
function lift(src, name) {
	let start = src.indexOf('\n\tasync function ' + name + '(');
	if (start < 0) start = src.indexOf('\n\tfunction ' + name + '(');
	if (start < 0) return null;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start + 1, i);
}

const T0 = 1790000000000;
const ask = (t, ts, text) => ({ role: 'user', mid: t, iturn: t, ts, content: text });
const ans = (t, mid, ts, text) => ({ role: 'assistant', mid, iturn: t, ts, content: text });
const RUN_MSGS = [
	{ role: 'user', content: 'q1', mid: 'u1' },
	{ role: 'assistant', content: 'a1-words' },
	{ role: 'user', content: 'read it', mid: 't2' },
	{ role: 'assistant', content: '', tool_calls: [{ id: 'call_9', name: 'file_read', arguments: '{}' }] },
	{ role: 'tool', content: 'x'.repeat(5000), tool_call_id: 'call_9' },
	{ role: 'assistant', content: 'it says 7' },
];
const SESSION = { v: 1, msgs: RUN_MSGS, turnStart: 2, base: 'a1', upto: 'e-k5-final', uptoTs: T0 + 3 };
function chat(over) {
	return Object.assign({
		id: 'c1', _loaded: true, app: { stale: true },
		messages: [ask('u1', T0, 'q1'), ans('u1', 'a1', T0 + 1, 'a1-words'), ask('t2', T0 + 2, 'read it'),
			ans('t2', 'e-k5-final', T0 + 3, 'it says 7')],
		session: { v: 1, upto: 'a1', uptoTs: T0 + 1, marks: { u1: 0 },
			msgs: [{ role: 'user', content: 'q1', mid: 'u1' }, { role: 'assistant', content: 'a1-words' }] },
	}, over || {});
}

// ── The gateway's chunks: each piece's plaintext by address, and the manifest over them ──
const sha = (b) => createHash('sha256').update(b).digest('hex');
let held = new Map();
function putBody(body, pieceBytes) {
	const all = new TextEncoder().encode(JSON.stringify(body));
	const chunks = [], hashes = [];
	for (let at = 0; at < all.length; at += pieceBytes) {
		const p = all.subarray(at, Math.min(all.length, at + pieceBytes));
		const addr = sha(Buffer.concat([Buffer.from('sealed:'), p]));
		held.set(addr, p);
		chunks.push({ addr, size: p.length + 40 });
		hashes.push(sha(p));
	}
	return { v: 2, size: all.length, key: sha(Buffer.from(hashes.join(''))), chunks, chat: body.chat, sig: null, upto: body.upto };
}
const body = (over) => Object.assign({ v: 1, chat: 'c1', sig: null, upto: SESSION.upto, session: SESSION }, over || {});
function report(over) {
	return Object.assign({ t: 'report', status: 'done', turnId: 't2', chatId: 'c1', finalTail: 1 }, over || {});
}

const st = { diags: [], held: null, saved: 0, drawn: [], tombs: [], redrawn: 0, reads: 0 };
const stubs = {
	diag: (tag, d) => st.diags.push(tag + ' ' + d),
	chatHoldingTurn: () => st.held,
	touchChat() {}, persistChats: () => { st.saved++; },
	markChatTainted: () => false,
	loadMsgTombs: () => ({}),
	t: (k, a) => k + (a ? ' ' + JSON.stringify(a) : ''),
	touchMsg: (m) => m,
	appendNote: (s) => st.drawn.push(s),
	msgTombstone: (mids) => { st.tombs.push(...mids); return Promise.resolve(true); },
	renderHistory: () => { st.redrawn++; },
};
const names = ['fetchRunnerSession', 'readSessionRef', 'hexOf', 'settleRunnerSession', 'noteSessionStayed', 'staleEngine',
	'captureSession', 'sessionHeld', 'keepChatTaint', 'sessionMarker', 'engineHolds', 'sessionGate', 'sessionUpto',
	'dropSessionStayed'];
const missing = names.filter((n) => !lift(SRC, n));
check('the chunked session is read and settled through daimond.js', missing.length === 0, missing);
const win = {
	DaimondPeer: { settlingReport: (r) => !!r && r.t === 'report' && r.status !== 'parked' },
	DaimondChunks: {
		materialiseBytes: async (m) => {
			st.reads++;
			const parts = [];
			for (const c of m.chunks) { const p = held.get(c.addr); if (!p) return null; parts.push(p); }
			return new Uint8Array(Buffer.concat(parts));
		},
	},
};
const F = missing.length ? null : new Function('window', ...Object.keys(stubs),
	'var current = null, DaimondChunks = window.DaimondChunks;\n' + names.map((n) => lift(SRC, n)).join('\n')
	+ '\nreturn { fetchRunnerSession, readSessionRef, settleRunnerSession, onScreen: (c) => { current = c; } };');
const api = F ? F(win, ...Object.values(stubs)) : null;
async function settle(c, r, filed) {
	st.held = c; st.diags = []; st.saved = 0; st.drawn = []; st.tombs = []; st.redrawn = 0; st.reads = 0;
	try { return api ? api.settleRunnerSession(await api.fetchRunnerSession(r, filed), filed) : ''; } catch (e) { return 'threw ' + e.message; }
}
const notes = (c) => c.messages.filter((m) => m.role === 'note_log');

// (a) A session sent home by chunks is stored.
{
	held = new Map();
	const ref = putBody(body(), 2048);
	const c = chat();
	let why = null;
	try { why = api ? await api.readSessionRef(ref) : null; } catch (e) { why = 'threw ' + e.message; }
	const out = await settle(c, report({ sessionRef: ref }));
	check('(a) the reference reads', why && typeof why === 'object', why);
	check('(a) a report carrying sessionRef over ' + ref.chunks.length + ' pieces answers stored', out === 'stored', { out, d: st.diags });
	check('(a) the session stored is the one the chunks carry',
		JSON.stringify(c.session && c.session.msgs) === JSON.stringify(RUN_MSGS), c.session);
	// (b)
	check('(b) chat.session.upto is the reference\'s upto', c.session && c.session.upto === ref.upto, c.session);
	check('(b) no note on a session that came home', notes(c).length === 0, notes(c));
	const again = await settle(c, report({ sessionRef: ref }));
	check('(b) the report heard again answers stored', again === 'stored', again);
}
// (c) Chunks that cannot be read, or are not the body the reference names, store nothing.
for (const [label, make] of [
	['a piece not held', () => { const r = putBody(body(), 2048); held.delete(r.chunks[1].addr); return r; }],
	['pieces out of order', () => { const r = putBody(body(), 2048); r.chunks.reverse(); return r; }],
	['the chunks of another body for the turn', () => {
		const r = putBody(body(), 2048);
		const other = putBody(body({ session: Object.assign({}, SESSION, { msgs: RUN_MSGS.slice(0, 2) }) }), 2048);
		return Object.assign(r, { chunks: other.chunks, size: other.size });
	}],
	['a body for another chat', () => { const r = putBody(body({ chat: 'c9' }), 2048); r.chat = 'c1'; return r; }],
	['a body whose session ends elsewhere', () => putBody(body({ session: Object.assign({}, SESSION, { upto: 'zz' }) }), 2048)],
]) {
	held = new Map();
	const c = chat();
	const before = JSON.stringify(c.session);
	const out = await settle(c, report({ sessionRef: make() }));
	check('(c) ' + label + ': stayed, nothing stored', out === 'stayed' && JSON.stringify(c.session) === before, { out, s: c.session });
	check('(c) ' + label + ': the turn says its chunks were not read',
		notes(c).length === 1 && notes(c)[0].content.includes('turn.session_unread') && notes(c)[0].iturn === 't2', notes(c));
}
// (d) The runner could not store the chunks: the turn says why, once, and keeps its status.
{
	const c = chat();
	if (api) api.onScreen(c);
	const r = report({ sessionStayed: 1, sessionWhy: 'HTTP 402' });
	const out = await settle(c, r);
	check('(d) a session that stayed answers stayed', out === 'stayed', out);
	const n = notes(c);
	check('(d) one note row on the turn names why', n.length === 1 && n[0].iturn === 't2'
		&& n[0].content.startsWith('turn.session_stayed') && n[0].content.includes('HTTP 402'), n);
	check('(d) drawn at once on the chat on screen', st.drawn.length === 1 && st.drawn[0].includes('HTTP 402'), st.drawn);
	check('(d) the note is kept', st.saved > 0);
	check('(d) the turn keeps its status', r.status === 'done' && c.messages.every((m) => !m.notRun && !m.interrupted), c.messages);
	if (api) api.onScreen(null);
	await settle(c, report({ sessionStayed: 1, sessionWhy: 'HTTP 402' }));
	check('(d) heard again, still one note', notes(c).length === 1, notes(c));
	const quiet = chat();
	await settle(quiet, report({ sessionStayed: 1 }));
	check('(d) an older runner\'s bare sessionStayed adds no row', notes(quiet).length === 0, notes(quiet));
}

// (e) Nothing is read where nothing would be stored.
{
	held = new Map();
	const ref = putBody(body(), 2048);
	const c = chat();
	await settle(c, report({ sessionRef: ref }));
	held = new Map();	// a tab that cannot unseal them reads none of the pieces
	const out = await settle(c, report({ sessionRef: ref }));
	check('(e) a session already held answers stored with no read', out === 'stored' && st.reads === 0, { out, reads: st.reads });
	check('(e) a session already held whose pieces cannot be read here adds no row', notes(c).length === 0, notes(c));
}
{
	held = new Map();
	const ref = putBody(body(), 2048);
	const gone = held.get(ref.chunks[1].addr);
	held.delete(ref.chunks[1].addr);
	const c = chat();
	if (api) api.onScreen(c);
	const first = await settle(c, report({ sessionRef: ref }));
	check('(e) a first hearing whose piece is missing: stayed, one row', first === 'stayed' && notes(c).length === 1, { first, n: notes(c) });
	held.set(ref.chunks[1].addr, gone);
	const later = await settle(c, report({ sessionRef: ref }));
	check('(e) a later hearing stores the session', later === 'stored' && c.session.upto === ref.upto, { later, s: c.session });
	check('(e) the row that said it stayed is retracted', notes(c).length === 0, notes(c));
	check('(e) through a tombstone, and redrawn on screen', st.tombs.includes('stayed-t2') && st.redrawn === 1, { t: st.tombs, r: st.redrawn });
	if (api) api.onScreen(null);
	const c2 = chat();
	c2.messages.push({ role: 'note_log', content: 'turn.session_stayed', mid: 'stayed-t2', iturn: 't2', ts: T0 + 4 });
	c2.session = { v: 1, upto: ref.upto, uptoTs: T0 + 3, marks: {}, msgs: RUN_MSGS };
	const synced = await settle(c2, report({ sessionRef: ref }));
	check('(e) a row synced in on a session already held is retracted', synced === 'stored' && notes(c2).length === 0
		&& st.reads === 0, { synced, n: notes(c2), reads: st.reads });
}
{
	held = new Map();
	const ref = putBody(body(), 2048);
	const parked = await settle(chat(), report({ status: 'parked', sessionRef: ref }));
	check('(e) a parked report reads nothing', parked === '' && st.reads === 0, { parked, reads: st.reads });
	const busy = await settle(chat({ _generating: true }), report({ sessionRef: ref }));
	check('(e) a busy chat reads nothing', busy === 'busy' && st.reads === 0, { busy, reads: st.reads });
	const c = chat();
	const wOut = await settle(c, report({ sessionRef: ref }), false);
	check('(e) words not filed read nothing', wOut === 'words' && st.reads === 0 && notes(c).length === 0, { wOut, reads: st.reads });
}
// (f) Each guard has its case.
{
	held = new Map();
	const ref = putBody(body(), 2048);
	ref.size += 1;
	const c = chat(), before = JSON.stringify(c.session);
	const out = await settle(c, report({ sessionRef: ref }));
	check('(f) a manifest whose size is not its pieces: stayed, nothing stored', out === 'stayed' && JSON.stringify(c.session) === before, { out, s: c.session });
}
{
	held = new Map();
	const ref = putBody(body({ upto: 'zz' }), 2048);
	ref.upto = SESSION.upto;
	const c = chat(), before = JSON.stringify(c.session);
	const out = await settle(c, report({ sessionRef: ref }));
	check('(f) a body whose upto is not the reference\'s: stayed, nothing stored', out === 'stayed' && JSON.stringify(c.session) === before, { out, s: c.session });
}
{
	held = new Map();
	const other = Object.assign({}, SESSION, { msgs: RUN_MSGS.slice(0, 2) });
	const ref = putBody(body({ session: other }), 2048);
	const c = chat();
	const out = await settle(c, report({ session: SESSION, sessionRef: ref }));
	check('(f) a report carrying both keeps its inline session, reading nothing', out === 'stored' && st.reads === 0
		&& JSON.stringify(c.session.msgs) === JSON.stringify(RUN_MSGS), { out, reads: st.reads, s: c.session });
}
{
	held = new Map();
	const ref = putBody(body({ chat: 'c9' }), 2048);
	const c = chat(), before = JSON.stringify(c.session);
	const out = await settle(c, report({ sessionRef: ref }));
	check('(f) a reference to another chat on this chat\'s turn: stayed, nothing stored', out === 'stayed'
		&& JSON.stringify(c.session) === before && st.reads === 0, { out, reads: st.reads, s: c.session });
}

console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nALL PASS (${checks} checks)`);
process.exit(failures ? 1 : 0);
