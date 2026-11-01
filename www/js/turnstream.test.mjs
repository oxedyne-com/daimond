/* ============================================================
   Test -- the page never refuses a hand-off turn for its size (UNBLOCK-83 TURN-STREAM, page half).
   ------------------------------------------------------------
   THE FAULT. His long chat (a 1.6 MB turn, Fred Hoogland) ended "not run" on argonaut: the
   page bounded the session it hands off by reference at `SESSION_REF_MAX` (8 MiB) and, past
   it, ended the turn "not run: size" without posting. The session already goes in door-sized
   chunks (ERRAND-REF, `DaimondChunks.offloadBytes`, 256 KiB pieces), which Kimberlite
   reassembles (turnstream2); a total bound is never the page's to impose. Kimberlite refuses
   only when its `run.memory_max` cannot hold the session, and hands the turn back `size`.

   WHAT IS CHECKED, over the REAL `sealFittingErrand` and `sessionByChunks` lifted from peer.js
   and the REAL `buildDispatch`, with the seal and the chunk store stubbed:
     (a) a chat whose session is over 8 MiB goes by reference: no `notRun`, a `sessionRef`
         naming the chunks the store gave, and the errand carries the reference, not the session;
     (b) a small chat's errand is the one `buildDispatch` writes, sealed once, no reference;
     (c) a chunk put that fails ends the turn "not run" once, cause `post`, with the reason.

     node www/js/turnstream.test.mjs            # ALL PASS
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { failures++; console.log('  FAIL ' + name + (detail === undefined ? '' : '  (' + detail + ')')); }
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
/// The source of `[async] function name(...) {...}`, or ''.
function lift(src, name) {
	const m = new RegExp('\\n\\t(async )?function ' + name + '\\(').exec(src);
	if (!m) return '';
	return src.slice(m.index + 1, balanced(src, src.indexOf('{', m.index)));
}

// ── The real peer.js, for buildDispatch ──
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
const P   = pw.DaimondPeer;
const SRC = readPage(join(HERE, 'peer.js'), 'utf8');

/// The two hand-off functions over stubs. Any module-level `var X = …;` they name is lifted
/// too, so the base's `SESSION_REF_MAX` comes with them and the arm runs on either tree.
function handoff(store) {
	const fns  = ['sessionByChunks', 'sealFittingErrand'].map((n) => lift(SRC, n));
	const vars = ['SESSION_REF_MAX', 'SEED_MAX_CHARS'].map((n) => {
		const m = new RegExp('\\n\\tvar ' + n + ' = [^;]*;').exec(SRC);
		return m ? m[0].trim() : '';
	});
	const seals = [], diags = [];
	const win = { DaimondChunks: store };
	const sealForSelf = async (obj) => {
		const json = JSON.stringify(obj);
		seals.push(json);
		return { envelope: Buffer.from(json).toString('base64') };
	};
	const make = new Function('window', 'DaimondChunks', 'buildDispatch', 'sealForSelf', 'diag',
		vars.join('\n') + '\n' + fns.join('\n') + '\nreturn sealFittingErrand;');
	return { fit: make(win, store, P.buildDispatch, sealForSelf, (t, d) => diags.push(t + ' ' + d)), seals, diags };
}

const T0   = 1790000000000;
const CAP  = 192 * 1024;		// a post door, bytes of plaintext
function chatOf(id) {
	return { id, provider: 'openrouter', model: 'test/m', holds: [], messages: [
		{ role: 'user', content: 'q1', mid: 'k1', ts: T0 },
		{ role: 'assistant', content: 'a1', mid: 'k2', ts: T0 + 1 },
		{ role: 'user', content: 'the turn', mid: 'TURN-TS', ts: T0 + 2 }] };
}
function opts(session) {
	return { turnId: 'TURN-TS', prompt: 'the turn', dispatchedBy: 'devPHONE', now: T0, eid: 'eid-ts', session };
}
function sessionOf(chars) {
	return { v: 1, msgs: [{ role: 'user', content: 'x'.repeat(chars) }], upto: 'k1', uptoTs: T0, marks: {},
		tail: [{ role: 'assistant', content: 'a1', mid: 'k2' }] };
}

console.log('\n(a) a session over 8 MiB goes by reference\n');
{
	const puts = [];
	const store = { offloadBytes: async (label, bytes) => {
		puts.push({ label, n: bytes.length });
		const n = Math.ceil(bytes.length / 262144);
		return { v: 2, size: bytes.length, key: 'k'.repeat(64),
			chunks: Array.from({ length: n }, (_, i) => ({ addr: 'a' + i, size: 262144 + 28 })) };
	} };
	const H = handoff(store);
	const big = 9 * 1048576;
	const r = await H.fit(chatOf('chat-big'), opts(sessionOf(big)), null, CAP);
	check('(a1) no "not run" for its size', !r.notRun, r.notRun + ': ' + r.why);
	check('(a2) the whole session was put in the chunk store once, under session:<chat>',
		puts.length === 1 && puts[0].label === 'session:chat-big' && puts[0].n > big, JSON.stringify(puts));
	const ref = r.sessionRef || {};
	check('(a3) the reference is ERRAND-REF\'s {chat, sig, upto, v:2, size, key, chunks}',
		ref.chat === 'chat-big' && ref.upto === 'k1' && ref.v === 2 && ref.size === (puts[0] || {}).n
			&& ref.chunks && ref.chunks.length === Math.ceil(ref.size / 262144), JSON.stringify(ref).slice(0, 200));
	const last = JSON.parse(H.seals[H.seals.length - 1] || '{}');
	const sd = last.seed || {};
	check('(a4) the posted errand carries the reference and not the session',
		!!r.body && !sd.session && JSON.stringify(sd.sessionRef || last.sessionRef || null) === JSON.stringify(ref),
		Object.keys(sd).join(','));
	check('(a5) and fits the door', Buffer.from(H.seals[H.seals.length - 1] || '').length <= CAP);
}

console.log('\n(b) a small chat\'s errand is today\'s\n');
{
	const store = { offloadBytes: async () => { throw new Error('a small chat puts nothing'); } };
	const H = handoff(store);
	const o = opts(sessionOf(2000));
	const r = await H.fit(chatOf('chat-small'), o, null, CAP);
	const today = JSON.stringify(P.buildDispatch(chatOf('chat-small'), o).errand(0));
	check('(b1) sealed once, the bytes buildDispatch writes', H.seals.length === 1 && H.seals[0] === today,
		H.seals.length + ' seals');
	check('(b2) no reference, no "not run"', !r.sessionRef && !r.notRun && r.tries === 1);
}

console.log('\n(c) a chunk put that fails is one "not run" row\n');
{
	const store = { offloadBytes: async () => { throw new Error('chunk door 503'); } };
	const H = handoff(store);
	const r = await H.fit(chatOf('chat-fail'), opts(sessionOf(9 * 1048576)), null, CAP);
	check('(c1) not run, cause post, the reason named', r.notRun === 'post' && /chunk door 503/.test(r.why || ''),
		r.notRun + ': ' + r.why);
	check('(c2) and nothing is posted', r.body === null);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
