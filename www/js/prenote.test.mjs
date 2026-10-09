/* ============================================================
   Test -- U4's note is SET ONCE, ON A PERSON'S MESSAGE, AND CARRIED BY A
   HAND-OFF (plan sections 1 J9 and 2 `pre`; lane P, P2a's J9 wiring).
   ------------------------------------------------------------
   `pre` is the note ahead of the person's words (`DaimondRatings.noteFor`),
   stored on the user message beside `content` and never in it. It is set
   where a person's message is first appended, in the step that appends it,
   and nowhere else; a replay carries the one the record already holds.

   daimond.js cannot be loaded whole in Node (see badge.test.mjs), so this
   LIFTS the real functions by name with a brace-balanced scan and runs them
   against the REAL ratings.js, provenance.js and peer.js. The three send
   paths are too large to run here, so they are held by position: the owner of
   every call is read from the source, and a new caller, a new gate or a second
   `noteFor` is what reddens it. The page itself is proven by the world run
   (p_pre.mjs): a rating, a send, the stored record's `pre`, the bubble.

   Run:  node www/js/prenote.test.mjs
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) { console.log('  ok   ' + name); }
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : '')); failures++; }
}
function same(name, got, want) {
	const a = JSON.stringify(got), b = JSON.stringify(want);
	check(name, a === b, 'got ' + a + ' want ' + b);
}

const SRC = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const PEER = readFileSync(join(HERE, 'peer.js'), 'utf8');

/// The source of `function name(...) {...}` (or async), brace-balanced, or null.
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
/// The one-tab function a character offset sits in: the owner of a call.
function ownerAt(src, idx) {
	const head = src.slice(0, idx);
	const re = /\n\t(?:async )?function (\w+)\(/g;
	let m, last = '';
	while ((m = re.exec(head))) last = m[1];
	return last;
}
/// The top-level arguments of a call's text `f(a, g(b, c), d);`.
function topArgs(text) {
	const open = text.indexOf('(');
	const out = []; let depth = 0, cur = '', q = '';
	for (let i = open + 1; i < text.length; i++) {
		const ch = text[i];
		if (q) { cur += ch; if (ch === q && text[i - 1] !== '\\') q = ''; continue; }
		if (ch === "'" || ch === '"') { q = ch; cur += ch; continue; }
		if ('([{'.includes(ch)) depth++;
		if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
		if (ch === ',' && depth === 0) { out.push(cur.replace(/\s+/g, ' ').trim()); cur = ''; continue; }
		cur += ch;
	}
	out.push(cur.replace(/\s+/g, ' ').trim());
	return out;
}
/// Every call of `name(` outside its own declaration: { owner, args } with the text up to the closing `);`.
function calls(src, name) {
	const out = [], re = new RegExp('\\b' + name + '\\(', 'g');
	let m;
	while ((m = re.exec(src))) {
		const before = src.slice(Math.max(0, m.index - 16), m.index);
		if (/function\s*$/.test(before)) continue;
		const end = src.indexOf(');', m.index);
		out.push({ owner: ownerAt(src, m.index), text: src.slice(m.index, end + 2) });
	}
	return out;
}

// ── The real modules, in a bare scope ──────────────────────
const win = {};
for (const f of ['provenance.js', 'ratings.js']) new Function('window', readFileSync(join(HERE, f), 'utf8'))(win);
const R = win.DaimondRatings;
function loadPeer() {
	const w = {};
	const noEl = { appendChild() {}, addEventListener() {}, setAttribute() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } };
	const document = { readyState: 'complete', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
		getElementById: () => null, createElement: () => Object.assign({}, noEl), body: noEl };
	new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date', 'with (window) {\n' + PEER + '\n}')(w, document, console, setTimeout, clearTimeout, Date);
	return w;
}
const Peer = loadPeer().DaimondPeer;

// ── Fixtures ───────────────────────────────────────────────
const P = { h: 'p1:answer:c7/m1', k: 'answer', m: 'accounts/fireworks/models/glm-5p2', pv: 'fireworks', cm: 'glm-5.2', fam: 'glm-5',
	fi: false, cls: 'open-frontier', role: 'chat', sp: 'sp1:3f9a0c12', d: '', c: 'c7', t: 'mfq19-0-abcde', dev: 'd-4f2a',
	at: 1790000000000, hash: '', run: '' };
const B = Date.UTC(2026, 9, 2, 10, 0, 0);
const T = (m, s) => B + (m * 60 + (s || 0)) * 1000;
const U = (mid, ts, text, extra) => Object.assign({ role: 'user', content: text || 'say ' + mid, mid, ts }, extra || {});
const A = (n, ts) => ({ role: 'assistant', content: 'answer ' + n, mid: 'm' + n, ts });
function rate(n, mid, ts, o) {
	o = o || {};
	return R.message(R.build({ prod: Object.assign({}, P, { h: 'p1:answer:c7/m' + n }), s: o.s === undefined ? 1 : o.s, clear: !!o.clear,
		tags: o.tags || [], dims: {}, note: o.note || '', src: 'tap', sup: o.sup || '', burst: mid, tools: '', len: 10 }), mid, ts);
}
const J = JSON.stringify;
const hasPre = (m) => Object.prototype.hasOwnProperty.call(m, 'pre');

// ── Lifts: the real helpers, in one scope with the real ratings ──
const names = ['ratingPre', 'pushUserRecord', 'tsPast', 'storedPre', 'landInterjection', 'recoverUserRecord', 'interjectMessage', 'heldNote'];
const src = {};
for (const n of names) src[n] = lift(SRC, n);
check('ratingPre, pushUserRecord, tsPast and storedPre are in daimond.js', ['ratingPre', 'pushUserRecord', 'tsPast', 'storedPre'].every((n) => !!src[n]), names.filter((n) => !src[n]).join(','));
const have = names.filter((n) => !!src[n]);
const calls_ = { interject: [], rendered: 0, gave: [], committed: [] };	// what the stubs saw
function scope() {
	const mid = { n: 0 };
	const stubs = { newMid: () => 'mi' + (++mid.n), nowTs: () => Date.now(), commitRatings: (id) => { calls_.committed.push(id); return false; },
		giveUpSent: (c, w) => { calls_.gave.push(w); }, syncSendMode: () => {}, renderQueue: () => { calls_.rendered++; } };
	return new Function('window', 'DaimondRatings', ...Object.keys(stubs), have.map((n) => src[n]).join('\n') + '\nreturn { ' + have.join(', ') + ' };')(win, R, ...Object.values(stubs));
}
const miss = (n) => () => { throw new Error(n + ' missing'); };
const S = Object.assign({ ratingPre: () => '<missing>', pushUserRecord: miss('pushUserRecord'), storedPre: () => '<missing>',
	landInterjection: miss('landInterjection'), recoverUserRecord: miss('recoverUserRecord'), interjectMessage: miss('interjectMessage') }, scope());
const run = (f) => { try { return f(); } catch (e) { return 'threw: ' + e.message; } };

// ═══ 1. pushUserRecord: the one place `pre` is set ═══
console.log('\nA person\'s message takes the note in the step that appends it');
{
	const words = 'just give me the command';
	const chat = () => ({ id: 'c7', messages: [U('u1', T(0)), A(1, T(1)), rate(1, 'r-1', T(2), { s: -1, tags: ['long'], note: words })] });
	const c1 = chat(), before = R.noteFor(c1.messages);
	check('the fixture has a note to carry', /^\[Daimond: the user rated your answer of \d\d:\d\d −1 \(Too long\): "just give me the command"\.\]$/.test(before), before);
	const typed = 'now do the second one';
	const rec1 = { role: 'user', content: typed, mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(c1, rec1, true));
	check('said: the record joins the chat exactly once, last', c1.messages.length === 4 && c1.messages[3] === rec1 && c1.messages.filter((m) => m.mid === 'u2').length === 1);
	check('said: pre is the note of the transcript as it stood BEFORE the record joined', rec1.pre === before, rec1.pre);
	check('said: content is only what was typed, and pre is the last key', rec1.content === typed && Object.keys(rec1).pop() === 'pre', Object.keys(rec1));
	check('said: no [Daimond: anywhere in what the bubble draws (content)', !/\[Daimond:/.test(rec1.content));

	const c2 = chat(), rec2 = { role: 'user', content: typed, mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(c2, rec2, false));
	check('not said: the record joins and carries no pre key, though a note could be composed', c2.messages.length === 4 && c2.messages[3] === rec2 && !hasPre(rec2) && R.noteFor(c2.messages.slice(0, 3)) !== '');
	const rec2b = { role: 'user', content: typed, mid: 'u3', ts: T(3) };
	run(() => S.pushUserRecord(c2, rec2b));
	check('no flag at all is not said', c2.messages.length === 5 && c2.messages[4] === rec2b && !hasPre(rec2b));

	const c3 = { id: 'c7', messages: [U('u1', T(0)), A(1, T(1))] }, rec3 = { role: 'user', content: typed, mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(c3, rec3, true));
	check('said with nothing to tell: the record joins and the key is absent, not empty (J5)', c3.messages.length === 3 && c3.messages[2] === rec3 && !hasPre(rec3));

	// told once: the model hears of a rating on the next message only
	const c4 = chat(), r4a = { role: 'user', content: 'one', mid: 'u2', ts: T(3) }, r4b = { role: 'user', content: 'two', mid: 'u3', ts: T(4) };
	run(() => S.pushUserRecord(c4, r4a, true));
	run(() => S.pushUserRecord(c4, r4b, true));
	check('pre is set exactly once: the second message has none', hasPre(r4a) && !hasPre(r4b));
	c4.messages.push(rate(1, 'r-2', T(5), { s: 1, sup: 'r-1' }));
	const r4c = { role: 'user', content: 'three', mid: 'u4', ts: T(6) };
	run(() => S.pushUserRecord(c4, r4c, true));
	check('and a new rating after that message is told on the next, and only it', hasPre(r4c) && /\+1/.test(r4c.pre) && !/just give me/.test(r4c.pre), r4c.pre);
	check('the earlier record is never rewritten', r4a.pre === before);
	// a tail note (the app's, not a person's) is no boundary and takes none
	const c5 = chat(), tailRec = { role: 'user', content: '[Daimond: this turn changed 1 file (v2): a.md]', mid: 'u9', ts: T(3), prod: [] };
	run(() => S.pushUserRecord(c5, tailRec, false));
	check('the tail note, pushed unsaid, takes no pre', c5.messages.length === 4 && c5.messages[3] === tailRec && !hasPre(tailRec));
}

// ═══ 1b. The app's own records are marked, so a rating before one is not lost ═══
console.log('\nAn app-made user record is marked `app` at creation, in the step that appends it');
{
	const hasApp = (m) => Object.prototype.hasOwnProperty.call(m, 'app');
	const base = () => ({ id: 'c7', messages: [U('u1', T(0)), A(1, T(1)), rate(1, 'r-1', T(2), { s: -1, tags: ['long'] })] });
	const c = base(), preset = { role: 'user', content: 'a preset instruction', mid: 'p1', ts: T(3) };
	run(() => S.pushUserRecord(c, preset, false));
	check('not said: the record is marked app, once, as its last key, and carries no pre', preset.app === true && Object.keys(preset).pop() === 'app' && !hasPre(preset), Object.keys(preset));
	const bare = { role: 'user', content: 'x', mid: 'p2', ts: T(3) };
	run(() => S.pushUserRecord(base(), bare));
	check('no flag at all is not said, so it is marked too', bare.app === true && !hasPre(bare));
	const said = { role: 'user', content: 'the person typed this', mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(base(), said, true));
	check('said: a person\'s record is never marked app', !hasApp(said) && hasPre(said));
	const quiet = { role: 'user', content: 'the person typed this', mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord({ id: 'c7', messages: [U('u1', T(0)), A(1, T(1))] }, quiet, true));
	check('said with nothing to tell: no pre and still no app mark', !hasApp(quiet) && !hasPre(quiet));
	const withTurn = { role: 'user', content: 'go on', mid: 'p3', ts: T(3), iturn: 'p3' };
	run(() => S.pushUserRecord(base(), withTurn, false));
	check('the mark goes last, after iturn, as pre does', Object.keys(withTurn).join() === 'role,content,mid,ts,iturn,app', Object.keys(withTurn));
	// the scenario: a rating, a preset turn, then the person's next message
	const c2 = base();
	run(() => S.pushUserRecord(c2, { role: 'user', content: 'a preset instruction', mid: 'p1', ts: T(3) }, false));
	c2.messages.push(A(2, T(4)));
	const next = { role: 'user', content: 'now do the second one', mid: 'u2', ts: T(5) };
	run(() => S.pushUserRecord(c2, next, true));
	check('a preset turn between a rating and the person\'s next message: the rating is told on that message', hasPre(next) && /^\[Daimond: the user rated your answer of \d\d:\d\d −1 \(Too long\)\.\]$/.test(next.pre), next.pre);
	c2.messages.push(A(3, T(6)));
	const after = { role: 'user', content: 'and the third', mid: 'u3', ts: T(7) };
	run(() => S.pushUserRecord(c2, after, true));
	check('and it is told once: the message after that takes none', !hasPre(after));
	check('the earlier records are never rewritten', c2.messages.filter((m) => m.mid === 'p1').length === 1 && c2.messages.find((m) => m.mid === 'p1').app === true && !hasPre(c2.messages.find((m) => m.mid === 'p1')));
	// an older record has no mark, and reads as the person's, as it does today
	const c3 = base(); c3.messages.push({ role: 'user', content: 'an older preset, from before the mark', mid: 'old', ts: T(3) }, A(2, T(4)));
	const n3 = { role: 'user', content: 'next', mid: 'u2', ts: T(5) };
	run(() => S.pushUserRecord(c3, n3, true));
	check('a record from before the mark reads as the person\'s: the rating before it is not told (as 5.3.0 without the mark)', !hasPre(n3));
	// ORDER SURVIVES A RELOAD. A transcript is merged by time and then by id, so a rating committed in the same
	// millisecond as the message it rode ahead of could come back AFTER it (a user mid 'm...' sorts before 'r-...'),
	// and the next message would tell it a second time. The record's time must therefore pass the one before it.
	const byTime = (list) => list.slice().sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || String(x.mid).localeCompare(String(y.mid)));
	const c4 = { id: 'c7', messages: [U('u1', T(0)), A(1, T(1)), rate(1, 'r-zz', T(2), { s: -1 })] };
	const sameMs = { role: 'user', content: 'sent in the very millisecond the rating was committed', mid: 'mfq1a-9-abcde', ts: T(2) };
	run(() => S.pushUserRecord(c4, sameMs, true));
	check('a record tied with the one before it takes a later time', sameMs.ts > T(2), sameMs.ts - T(2));
	same('so a reload\'s merge order is the push order: the rating still precedes the message that told it', byTime(c4.messages).map((m) => m.mid), c4.messages.map((m) => m.mid));
	const c5b = { id: 'c7', messages: [U('u1', T(0)), A(1, T(1)), rate(1, 'r-zz', T(2), { s: -1 })] };
	const later = { role: 'user', content: 'later', mid: 'mfq1a-9-abcdf', ts: T(3) };
	run(() => S.pushUserRecord(c5b, later, true));
	check('a record already later than the one before it keeps its own time', later.ts === T(3), later.ts);
	const c6 = { id: 'c7', messages: [] }, first = { role: 'user', content: 'first', mid: 'u1', ts: T(0) };
	run(() => S.pushUserRecord(c6, first, true));
	check('the first record of a chat keeps its own time', first.ts === T(0) && c6.messages.length === 1);
	// position: the mark is written in the same step, before the record joins the chat
	const pu = lift(SRC, 'pushUserRecord') || '', at = pu.indexOf('rec.app = true'), pushAt = pu.indexOf('.push(rec)');
	check('pushUserRecord writes the mark before the record joins the transcript', at > 0 && pushAt > at, pu);
	const setters = []; { const re = /\b(?!jmeta\b)\w+\.app\s*=\s*true/g; let mm; while ((mm = re.exec(SRC))) setters.push(ownerAt(SRC, mm.index)); }
	same('in daimond.js only pushUserRecord marks a record, and graftSeed copies the mark onto a runner\'s copy', setters.sort(), ['graftSeed', 'pushUserRecord']);
}

// ═══ 2. The three paths, held by position ═══
console.log('\nThe three paths set it, and nothing else does');
{
	const sites = calls(SRC, 'pushUserRecord');
	const gate = (c) => topArgs(c.text)[2];
	const by = {}; sites.forEach((c) => { (by[c.owner] = by[c.owner] || []).push(gate(c)); });
	same('the callers are runTurn, maybeAutoDispatch, runSteer, an interjection landing and the journal recovery', Object.keys(by).sort(), ['landInterjection', 'maybeAutoDispatch', 'recoverUserRecord', 'runSteer', 'runTurn']);
	same('path 1 (local chat send): gated on the person flag runTurn is given, or on a note a replay hands it', by.runTurn, ["!!opts.person || typeof opts.told === 'string'"]);
	same('path 5 (an interjection landing) is a person\'s message', by.landInterjection, ['true']);
	same('the journal recovery restores the mark it was opened with', by.recoverUserRecord, ['meta.app !== true']);
	same('path 3 (the peer-dispatch push): a person\'s send, always', by.maybeAutoDispatch, ['true']);
	same('path 4 (the Diamond send): gated on how.said, which only a person\'s typing passes', by.runSteer, ['!!(how && how.said)']);
	// J9: the ratings are committed (a pending draft is a rating_log) before the note is composed
	const idxs = []; { const re = /\bpushUserRecord\(/g; let mm; while ((mm = re.exec(SRC))) if (!/function\s*$/.test(SRC.slice(Math.max(0, mm.index - 16), mm.index))) idxs.push(mm.index); }
	const committedFirst = idxs.map((i) => { const k = SRC.lastIndexOf('commitRatings(', i); return { owner: ownerAt(SRC, i), ok: k > 0 && ownerAt(SRC, k) === ownerAt(SRC, i) }; });
	same('every send path commits the ratings before it composes the note (so a pending draft is already a record)', committedFirst.filter((c) => !['landInterjection', 'recoverUserRecord'].includes(c.owner)).map((c) => c.owner + ':' + c.ok).sort(), ['maybeAutoDispatch:true', 'runSteer:true', 'runTurn:true']);
	{ const ij = lift(SRC, 'interjectMessage') || ''; check('and so does the interjection, at the typing step, before it composes', ij.indexOf('commitRatings(') > 0 && ij.indexOf('commitRatings(') < ij.indexOf('ratingPre('), ij.slice(0, 200)); }
	check('no send path pushes its user record by hand any more',
		!/chat\.messages\.push\(urec\)/.test(SRC) && !/rec\.messages\.push\(\{ role: 'user', content: instruction/.test(SRC)
		&& !/chat\.messages\.push\(\{ role: 'user', content: text, mid: umid, iturn: umid/.test(SRC));
	check('ratingPre is called from pushUserRecord and the interjection\'s typing step alone, and noteFor from ratingPre alone',
		calls(SRC, 'ratingPre').map((c) => c.owner).sort().join() === 'interjectMessage,pushUserRecord' && calls(SRC, 'noteFor').map((c) => c.owner).join() === 'ratingPre',
		calls(SRC, 'ratingPre').map((c) => c.owner).concat(calls(SRC, 'noteFor').map((c) => c.owner)));
	// the callers of runTurn that carry the person flag are the composer, the queue and a retry; the rest have none
	const rt = calls(SRC, 'runTurn').filter((c) => c.owner !== 'runTurn');
	const withPerson = rt.filter((c) => /person:\s*true/.test(c.text));
	same('the person flag reaches runTurn from three places only (the composer, drainQueue, retryTurn)', withPerson.map((c) => c.owner).sort(), ['drainQueue', 'retryTurn', 'sendPressed']);
	const none = rt.filter((c) => !/person:\s*true/.test(c.text)).map((c) => c.text.replace(/\s+/g, ' ').slice(0, 60));
	check('a Continue, a gather round and a peer turn pass no person flag (so they take no pre)',
		none.length >= 3 && none.every((t) => !/person/.test(t)), none);
	// the steer: how.said only from the composer and the Diamond queue
	const steers = calls(SRC, 'runSteer').filter((c) => /said:\s*true/.test(c.text)).map((c) => c.owner);
	const dsteer = calls(SRC, 'doSteer').filter((c) => /said:\s*true/.test(c.text)).map((c) => c.owner);
	same('how.said is passed by drainSteerQueue to runSteer', steers, ['drainSteerQueue']);
	same('how.said is passed by the composer to doSteer, and by nothing else', dsteer, ['sendPressed']);
	check('doSteer hands how on to runSteer', /return runSteer\(currentDiamond, presetArg, depthArg, null, how\)/.test(lift(SRC, 'doSteer') || ''));
	// the bubble: appendUserMessage takes (text, ts, prod) and no site hands it a note
	check('no appendUserMessage call is given a pre', !/appendUserMessage\([^)]*\bpre\b/.test(SRC));
	check('a stored record is drawn from its content (history redraw)', /appendUserMessage\(m\.content, m\.ts, m\.prod, m\.files[,)]/.test(SRC));
	// path 5 and the journal recovery are wired in section 7 and 8 below.
}

// ═══ 3. A replay carries what the record holds ═══
console.log('\nA replay carries the original pre and computes none');
{
	const NOTE = '[Daimond: the user rated your answer of 10:01 −1.]';
	const chat = { id: 'c7', provider: 'p', model: 'm', messages: [
		U('u1', T(0)), A(1, T(1)), U('t1', T(3), 'the turn', { iturn: 't1', pre: NOTE }), A(2, T(4)),
		rate(2, 'r-9', T(5), { s: -2, tags: ['wrong'], note: 'a rating since' }) ] };
	check('the fixture would compose a different note now', R.noteFor(chat.messages) !== NOTE && R.noteFor(chat.messages) !== '');
	check('storedPre reads the original record\'s pre', S.storedPre(chat, 't1') === NOTE, S.storedPre(chat, 't1'));
	check('storedPre of a record that took none is empty, though a note could be composed now', S.storedPre(chat, 'u1') === '');
	check('storedPre of an unknown turn is empty', S.storedPre(chat, 'nope') === '' && S.storedPre(null, 't1') === '' && S.storedPre(chat, '') === '');
	check('storedPre never composes (the transcript is not changed by asking)', chat.messages.length === 5);
	const efr = lift(SRC, 'errandForRecovery'), dtp = lift(SRC, 'dispatchToPeer');
	check('errandForRecovery and dispatchToPeer are in daimond.js', !!efr && !!dtp);
	if (efr) {
		const mk = new Function('window', 'DaimondPeer', 'DaimondSync', 'selfDeviceId', 'storedPre', efr + '\nreturn errandForRecovery;');
		const f = mk(win, Peer, { version: () => 7 }, () => 'dev-self', S.storedPre);
		const e = run(() => f(chat, { iturn: 't1', itext: 'the turn', dispatchedBy: 'devA', ts: T(3) }, false));
		check('errandForRecovery carries the stored pre beside the prompt', e && e.pre === NOTE && e.prompt === 'the turn', e && e.pre);
		const e0 = run(() => f(chat, { iturn: 'u1', itext: 'say u1', ts: T(0) }, false));
		check('a recovered turn whose record took no pre carries none (it is not recomputed)', e0 && e0.pre === '', e0 && e0.pre);
	}
	check('dispatchToPeer puts the stored pre in the errand it builds (every re-dispatch goes through it)',
		/pre:\s*storedPre\(chat, turnId\)/.test(dtp || ''));
	const rd = ['{ parkCount: count }', 'String(m.itext || \'\')', 'turn.text'].map((s) => SRC.indexOf(s) > 0);
	check('the three re-dispatch sites call dispatchToPeer, and none of them composes', rd.every(Boolean)
		&& calls(SRC, 'dispatchToPeer').every((c) => !/ratingPre|noteFor/.test(c.text)));
}

// ═══ 4. The hand-off: the errand and the seed ═══
console.log('\nThe errand and the seed carry it');
{
	const NOTE = '[Daimond: the user rated your answer of 10:01 +1.]';
	const e = Peer.makeErrand({ turnId: 't', chatId: 'c', prompt: 'do it', pre: NOTE });
	check('makeErrand carries pre beside prompt', e.pre === NOTE && e.prompt === 'do it', e.pre);
	check('an errand without one has the empty string (none)', Peer.makeErrand({ turnId: 't', prompt: 'x' }).pre === '' && Peer.makeErrand({ pre: null }).pre === '' && Peer.makeErrand(null).pre === '');
	check('it survives the envelope\'s JSON byte for byte', JSON.parse(JSON.stringify(Peer.makeErrand({ prompt: 'x', pre: 'Étape "2"\n日本語 ✓' }))).pre === 'Étape "2"\n日本語 ✓');
	const chat = { id: 'c', provider: 'p', model: 'm', messages: [
		U('q1', T(0), 'first', { pre: 'N1' }), Object.assign(A(1, T(1)), { pre: 'not for an assistant' }), U('q3', T(2), 'plain'),
		U('q4', T(3), 'empty', { pre: '' }), U('q5', T(4), 'odd', { pre: { a: 1 } }), U('turn-9', T(5), 'do the thing', { pre: NOTE }) ] };
	const plan = Peer.buildDispatch(chat, { turnId: 'turn-9', prompt: 'do the thing', pre: NOTE, dispatchedBy: 'dev', now: T(5) });
	check('buildDispatch hands pre to the errand and names it in the fields', plan.errand(0).pre === NOTE && plan.fields.pre === NOTE, plan.fields.pre);
	check('buildDispatch without pre builds the 5.2.9 errand, empty', Peer.buildDispatch(chat, { turnId: 'turn-9', prompt: 'x', now: T(5) }).errand(0).pre === '');
	const seed = plan.errand(0).seed, by = {}; seed.msgs.forEach((m) => { by[m.mid] = m; });
	check('the seed carries a user message\'s pre', by.q1 && by.q1.pre === 'N1' && by['turn-9'].pre === NOTE, by.q1);
	check('and only on a user message, only when a non-empty string',
		!!by.q3 && !!by.q4 && !!by.q5 && !hasPre(by.q3) && !hasPre(by.q4) && !hasPre(by.q5),
		Object.keys(by).map((k) => k + ':' + hasPre(by[k])));
	check('an assistant row in the seed has no pre', seed.msgs.filter((m) => m.role === 'assistant').every((m) => !hasPre(m)));
	// The mark travels too, so the runner's copy of a record is the same record (J5), and a third device that
	// takes it from the runner first still reads an app-made turn as the app's.
	const chatA = { id: 'c', provider: 'p', model: 'm', messages: [
		U('q1', T(0), 'a person', { pre: 'N1' }), U('q2', T(1), 'a preset', { app: true }), Object.assign(A(1, T(2)), { app: true }),
		U('q4', T(3), 'odd', { app: 'yes' }), U('q5', T(4), 'false', { app: false }), U('turn-9', T(5), 'do the thing') ] };
	const seedA = Peer.buildDispatch(chatA, { turnId: 'turn-9', prompt: 'do the thing', dispatchedBy: 'dev', now: T(5) }).errand(0).seed, byA = {};
	seedA.msgs.forEach((m) => { byA[m.mid] = m; });
	check('the seed carries a user message\'s app mark', !!byA.q2 && byA.q2.app === true, byA.q2);
	check('and only on a user message, only when it is true', !!byA.q1 && !!byA.q4 && !!byA.q5 && !('app' in byA.q1) && !('app' in byA.q4) && !('app' in byA.q5) && seedA.msgs.filter((m) => m.role === 'assistant').every((m) => !('app' in m)),
		Object.keys(byA).map((k) => k + ':' + ('app' in byA[k])));
	check('seedGraft hands the runner\'s chat the mark with the message',
		Peer.seedGraft({ messages: [] }, JSON.parse(JSON.stringify({ seed: seedA, turnId: 'turn-9' }))).find((m) => m.mid === 'q2').app === true);
	const gr2 = SRC.indexOf('var add = DaimondPeer.seedGraft(chat, errand);');
	check('the runner\'s grafted copy of a user message keeps the mark', gr2 > 0 && /gm\.app\s*=\s*true/.test(SRC.slice(gr2, gr2 + 800)), SRC.slice(gr2, gr2 + 300));
	check('the seed\'s content and mid are untouched by it', by.q1.content === 'first' && by['turn-9'].content === 'do the thing');
	// the budget counts the note, so a seed stays a small envelope
	const huge = { id: 'c', messages: [U('a', T(0), 'a', { pre: 'x'.repeat(300) }), U('b', T(1), 'b', { pre: 'y'.repeat(300) }), U('turn', T(2), 'go')] };
	const clipped = Peer.seedFrom(huge, 'turn', 24, 400);
	check('a note counts against the seed\'s character budget (the oldest whole message goes first)', !!clipped && clipped.msgs.map((m) => m.mid).join() === 'b,turn', clipped && clipped.msgs.map((m) => m.mid));
	check('seedGraft hands the runner\'s chat the pre with the message',
		Peer.seedGraft({ messages: [] }, JSON.parse(JSON.stringify({ seed, turnId: 'turn-9' }))).find((m) => m.mid === 'q1').pre === 'N1');
	const gr = SRC.indexOf('var add = DaimondPeer.seedGraft(chat, errand);');
	check('the runner\'s grafted copy of a user message keeps the pre', gr > 0 && /\bpre\b/.test(SRC.slice(gr, gr + 600)), SRC.slice(gr, gr + 300));
	check('threadSig stays mid-based: a note changes nothing in the fingerprint',
		JSON.stringify(Peer.threadSig(chat, 'turn-9')) === JSON.stringify(Peer.threadSig({ id: 'c', messages: chat.messages.map((m) => { const c = Object.assign({}, m); delete c.pre; return c; }) }, 'turn-9')));
}

// ═══ 6. A note fixed elsewhere is written as given ═══
console.log('\npushUserRecord writes a told note and composes none');
{
	const base = () => ({ id: 'c7', messages: [U('u1', T(0)), A(1, T(1)), rate(1, 'r-1', T(2), { s: -1, tags: ['long'] })] });
	const composed = R.noteFor(base().messages);
	check('the fixture has a different note to compose', composed !== '' && composed !== 'KEPT');
	const r1 = { role: 'user', content: 'x', mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(base(), r1, true, 'KEPT'));
	check('said with a told note: it is written as given, not composed', r1.pre === 'KEPT' && Object.keys(r1).pop() === 'pre', r1.pre);
	const r2 = { role: 'user', content: 'x', mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(base(), r2, true, ''));
	check('said with an empty told note: none, and none is composed either', !hasPre(r2) && !('app' in r2), Object.keys(r2));
	const r3 = { role: 'user', content: 'x', mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(base(), r3, false, 'KEPT'));
	check('not said: a told note is ignored and the record is the app\'s', !hasPre(r3) && r3.app === true, Object.keys(r3));
	const r4 = { role: 'user', content: 'x', mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(base(), r4, true, undefined));
	check('said with no told note: composed, as before', r4.pre === composed, r4.pre);
	const r5 = { role: 'user', content: 'x', mid: 'u2', ts: T(3) };
	run(() => S.pushUserRecord(base(), r5, true, { a: 1 }));
	check('a told note that is not a string is not one: composed', r5.pre === composed, r5.pre);
	// ratingPre from a position: what a note composed there already told is not told again
	const c = base();
	check('ratingPre with no position is the whole transcript\'s note', S.ratingPre(c) === composed);
	check('ratingPre from the end tells nothing the transcript before it holds', S.ratingPre(c, c.messages.length) === '', S.ratingPre(c, c.messages.length));
	c.messages.push(rate(1, 'r-2', T(4), { s: 1, sup: 'r-1' }));
	check('and only what was rated since', /\+1\.\]$/.test(S.ratingPre(c, 3)) && !/Too long/.test(S.ratingPre(c, 3)), S.ratingPre(c, 3));
	check('a position past the end is the end, below zero the start', S.ratingPre(c, 99) === '' && S.ratingPre(c, -5) === S.ratingPre(c, 0), S.ratingPre(c, 99));
	check('asking from a position never changes the transcript', c.messages.length === 4 && c.messages.every((m) => !('content' in m) || m.content !== ''));
}

// ═══ 7. Path 5: a steer into a running chat turn ═══
console.log('\nA steer into a running turn is composed when typed, kept with its text, and written as sent');
{
	const mk = (messages) => {
		const sent = [];
		const chat = { id: 'c7', messages, app: { interject(t, p) { sent.push({ t, p }); return sent.length; } } };
		return { chat, sent };
	};
	const base = () => [U('u1', T(0)), A(1, T(1)), rate(1, 'r-1', T(2), { s: -1, tags: ['long'], note: 'too wordy' })];
	const { chat, sent } = mk(base());
	const want = R.noteFor(chat.messages);
	check('interjectMessage returns true and commits the ratings first', run(() => S.interjectMessage(chat, 'actually, wasm', 'actually, wasm')) === true && calls_.committed.includes('c7'));
	check('the engine was handed the words and the note composed now', sent.length === 1 && sent[0].t === 'actually, wasm' && sent[0].p === want, sent);
	check('the text waits as a string, and its note beside it', J(chat._interject) === J(['actually, wasm']) && (chat._interjectNote || []).length === 1 && chat._interjectNote[0].pre === want, J(chat._interjectNote));
	// a second correction before the first lands: it must not tell the same rating again
	run(() => S.interjectMessage(chat, 'and use the DEV build', 'and use the DEV build'));
	check('a second correction before the first lands is handed no note: the first already told it', sent.length === 2 && !sent[1].p, sent[1]);
	chat.messages.push(rate(2, 'r-5', T(6), { s: 1 }));		// a rating made while both wait
	run(() => S.interjectMessage(chat, 'one more', 'one more'));
	check('a rating made while they waited is told once, by the next', /\+1\.\]$/.test(sent[2].p) && !/Too long/.test(sent[2].p), sent[2].p);
	// landing: the record carries the note the engine was SENT
	const r1 = run(() => S.landInterjection(chat, 'actually, wasm'));
	check('the record carries the same string the engine was sent, content apart', r1.pre === want && r1.content === 'actually, wasm' && r1.interject === true && Object.keys(r1).pop() === 'pre', Object.keys(r1));
	check('it joins the chat once, last, and leaves the waiting list and the note list in step', chat.messages[chat.messages.length - 1] === r1 && chat.messages.filter((m) => m.mid === r1.mid).length === 1 && J(chat._interject) === J(['and use the DEV build', 'one more']) && (chat._interjectNote || []).length === 2);
	const r2 = run(() => S.landInterjection(chat, 'and use the DEV build'));
	check('the second landed with none: no pre key, not an app record', !hasPre(r2) && !('app' in r2), Object.keys(r2));
	const r3 = run(() => S.landInterjection(chat, 'one more'));
	check('the third carries what it was sent', r3.pre === sent[2].p, r3.pre);
	// recomputing at the ack would have claimed more than the model read
	const lateRating = rate(3, 'r-9', T(9), { s: -1 });
	chat.messages.push(lateRating);
	check('a rating made after typing is not claimed by a record that landed before it was told', R.noteFor(chat.messages) !== '' && !/−1\.\]$/.test(r3.pre));
	// the same words typed twice land in order, each with its own note
	const d = mk(base());
	run(() => S.interjectMessage(d.chat, 'again', 'again'));
	d.chat.messages.push(rate(2, 'r-5', T(6), { s: 1 }));
	run(() => S.interjectMessage(d.chat, 'again', 'again'));
	const l1 = run(() => S.landInterjection(d.chat, 'again')), l2 = run(() => S.landInterjection(d.chat, 'again'));
	check('identical words land first in, first out, each with its own note', l1.pre === d.sent[0].p && l2.pre === d.sent[1].p && l1.pre !== l2.pre, J([l1.pre, l2.pre]));
	// an ack for something never waited on (the mirror was cleared) records the person's words with no claim
	const e = mk(base());
	const l3 = run(() => S.landInterjection(e.chat, 'never mirrored'));
	check('an interjection the mirror does not hold lands with no pre', !hasPre(l3) && l3.content === 'never mirrored', Object.keys(l3));
	// the engine that cannot take one
	const none = { id: 'c7', messages: base(), app: {} };
	check('a chat whose engine takes no interjection is still turned away, unchanged', run(() => S.interjectMessage(none, 'x', 'x')) === false && !none._interjectNote);
	const refuses = { id: 'c7', messages: base(), app: { interject() { throw new Error('no'); } } };
	check('and an engine that refuses leaves nothing waiting', run(() => S.interjectMessage(refuses, 'x', 'x')) === false && !(refuses._interject || []).length && !(refuses._interjectNote || []).length);
	// every place that empties the waiting list empties the note list with it
	const resets = []; { const re = /\._interject\s*=\s*\[\]/g; let mm; while ((mm = re.exec(SRC))) resets.push(SRC.slice(mm.index, mm.index + 120)); }
	check('every `_interject = []` is followed by the note list\'s own reset', resets.length >= 3 && resets.every((r) => /_interjectNote\s*=\s*\[\]/.test(r)), resets.length);
	const unw = lift(SRC, 'unwait') || '';
	check('withdrawing a waiting message takes its note out with it', /_interject\.splice\(i, 1\)/.test(unw) && /_interjectNote/.test(unw));
}

// ═══ 8. Where the note is handed to the engine, the journal and the runner ═══
console.log('\nThe turn-starting exports, the journal and the runner carry it');
{
	// The tail is appended where the engine is laid in (`seedEngine`) and where a live one is brought up to the chat (`reconcileEngine`).
	const rt = lift(SRC, 'runTurn') || '', rs = lift(SRC, 'runSteer') || '', ea = (lift(SRC, 'seedEngine') || '') + '\n' + (lift(SRC, 'reconcileEngine') || '');
	const runs = rt.match(/app\.run_turn\([^;]*\);/g) || [];
	check('every run_turn of a chat turn hands the engine the turn\'s note', runs.length === 3 && runs.every((r) => /^app\.run_turn\(text, onEvent, turnPre \|\| undefined\);$/.test(r)), runs);
	check('the turn\'s note is the one a replay was handed, else the record\'s own', /var turnPre = \(typeof opts\.told === 'string'\) \? opts\.told\s*: /.test(rt) && /reusePrompt \|\| urec/.test(rt));
	check('a worker and the triage reader take none', !/run_turn\([^)]*pre/i.test(SRC.slice(SRC.indexOf('run.app.run_turn(task, sink)') - 40, SRC.indexOf('run.app.run_turn(task, sink)') + 60)));
	const open = rt.indexOf('J.turnOpen(');
	check('the journal opens a turn with its note and its mark', open > 0 && /pre/.test(rt.slice(open - 400, open + 200)) && /app/.test(rt.slice(open - 400, open + 200)) && /turnPre/.test(rt.slice(open - 400, open + 200)), rt.slice(open - 200, open + 160));
	check('a steer\'s note is read off its record, or the errand\'s for a runner, and handed to steer_crystal last', /steer_crystal\([\s\S]*JSON\.stringify\(marks\.unconfirmed \|\| \[\]\),\s*steerPre \|\| undefined\)/.test(rs) && /detached\.pre/.test(rs));
	check('the detached steer is handed the errand\'s note', /pre:\s*\(ropts && ropts\.pre\)/.test(lift(SRC, 'runSteerDetached') || ''));
	check('a screen-transcript tail restored into the engine carries each user message\'s note', /append_message\(m\.role, m\.content \|\| '',\s*[^)]*m\.pre/.test(ea), ea.slice(ea.indexOf('append_message') - 20, ea.indexOf('append_message') + 160));
	// the runner
	const re = SRC.indexOf('await runTurn(c.chat, prompt, {');
	check('the runner\'s chat turn is handed the errand\'s note as told, so its own copy is the person\'s and carries it', re > 0 && /told:/.test(SRC.slice(re, re + 260)) && /ropts\.pre/.test(SRC.slice(re, re + 260)), SRC.slice(re, re + 240));
	check('runErrand hands its runner the errand\'s note, always a string', /d\.runTurn\(ctx, e\.prompt, \{[^}]*pre:\s*\(typeof e\.pre === 'string'\) \? e\.pre : ''/.test(PEER));
	// the journal's recovery
	const rec = lift(SRC, 'recoverInterrupted') || '';
	check('the recovery rebuilds a missing question through recoverUserRecord, never by hand', /recoverUserRecord\(chat, iturn, t\)/.test(rec) && !/role: 'user', content: t\.userText/.test(rec));
	const ruText = lift(SRC, 'recoverUserRecord') || '';
	check('and reads the note and the mark from the turn\'s own opening entry', /meta\.pre/.test(ruText) && /meta\.app/.test(ruText), ruText);
	const ct = lift(SRC, 'continueTurn') || '';
	check('a turn re-asked after nothing arrived keeps the retracted question\'s note and is not marked the app\'s', /told:/.test(ct) && /\.app !== true/.test(ct), ct.slice(ct.indexOf('contOpts') - 20, ct.indexOf('contOpts') + 200));
	check('the retraction finds the turn\'s question by its mid too, since a chat not resident at boot never has its iturn mark, and drops what it found', /turnMessagesOf\(chat, iturn\)/.test(ct) && /mine\.indexOf\(x\) === -1/.test(ct));
	// a recovered record, run
	const meta = (o) => ({ turnId: 'it1', userText: 'a question', meta: o });
	const cc = { id: 'c7', messages: [U('u1', T(0)), A(1, T(1))] };
	const q1 = run(() => S.recoverUserRecord(cc, 'it1', meta({ pre: '[Daimond: the user rated your answer of 10:01 +1.]', amid: 'm9' })));
	check('a recovered question carries the note the journal held, content apart, and keeps its turn keys', q1 && q1.pre === '[Daimond: the user rated your answer of 10:01 +1.]' && q1.content === 'a question' && q1.mid === 'it1' && q1.iturn === 'it1' && !('app' in q1), q1 && Object.keys(q1));
	const q2 = run(() => S.recoverUserRecord(cc, 'it2', meta({ app: true })));
	check('a recovered preset keeps its mark and takes no note', q2 && q2.app === true && !hasPre(q2), q2 && Object.keys(q2));
	const q3 = run(() => S.recoverUserRecord(cc, 'it3', { turnId: 'it3', userText: 'old journal', meta: { model: 'm' } }));
	check('a journal from before the fields recovers the plain record it always did', q3 && J(Object.keys(q3)) === J(['role', 'content', 'mid', 'iturn', 'ts']), q3 && Object.keys(q3));
	const q4 = run(() => S.recoverUserRecord(cc, 'it4', { turnId: 'it4', userText: 'no meta' }));
	check('and one with no meta at all', q4 && !hasPre(q4) && !('app' in q4) && q4.content === 'no meta', q4 && Object.keys(q4));
	check('the journal passes the meta through untouched (it carries pre and app by being opaque)', /meta:\s*meta \|\| null/.test(readFileSync(join(HERE, 'journal.js'), 'utf8')));
}

// ═══ 5. tailAfter and dedupeSession compare content only ═══
console.log('\ntailAfter and dedupeSession are content only');
{
	const ta = lift(SRC, 'tailAfter'), ds = lift(SRC, 'dedupeSession');
	check('tailAfter and dedupeSession are in daimond.js', !!ta && !!ds);
	check('neither mentions pre', !/\bpre\b/.test(ta || 'pre') && !/\bpre\b/.test(ds || 'pre'));
	if (ta && ds) {
		const fn = new Function(ta + '\n' + ds + '\nreturn { tailAfter, dedupeSession };')();
		const withPre = [U('m1', T(0), 'hello', { pre: 'N0' }), A(2, T(1)), U('m3', T(2), 'do X', { pre: '[Daimond: rated.]' }), A(4, T(3)), U('m5', T(4), 'then Y', { pre: 'N5' })];
		const plain = withPre.map((m) => { const c = Object.assign({}, m); delete c.pre; return c; });
		const sess = { upto: 'm2' };
		const strip = (l) => l.map((m) => m.role + ':' + m.content + ':' + m.mid);
		same('tailAfter names the same messages by content with and without pre', strip(fn.tailAfter({ messages: withPre }, sess)), strip(fn.tailAfter({ messages: plain }, sess)));
		same('and that is the messages after the marker', strip(fn.tailAfter({ messages: withPre }, sess)), ['user:do X:m3', 'assistant:answer 4:m4', 'user:then Y:m5']);
		same('by time too, when the marker is gone', strip(fn.tailAfter({ messages: withPre }, { upto: 'gone', uptoTs: T(1) })), strip(fn.tailAfter({ messages: plain }, { upto: 'gone', uptoTs: T(1) })));
		const smsgs = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'answer 2' }, { role: 'user', content: 'do X' }, { role: 'user', content: 'do X' }, { role: 'assistant', content: 'answer 4' }];
		const a = fn.dedupeSession(smsgs, withPre, 'm4', 0), b = fn.dedupeSession(smsgs, plain, 'm4', 0);
		same('dedupeSession drops the same true duplicate with and without pre on the transcript', a.map((m) => m.content), b.map((m) => m.content));
		same('and that duplicate is the one dropped', a.map((m) => m.content), ['hello', 'answer 2', 'do X', 'answer 4']);
		const sp = smsgs.map((m) => m.role === 'user' ? Object.assign({ pre: 'the session never holds it' }, m) : m);
		same('a session user message carrying a pre is judged by its content too', fn.dedupeSession(sp, withPre, 'm4', 0).map((m) => m.content), a.map((m) => m.content));
	}
}

// ═══ 9. A turn asked again finds its question by its mid, in all three doors ═══
console.log('\nretryTurn, answerAgain and continueTurn retract the turn\'s question, marked or not');
{
	// A chat not resident at boot never has its question marked `iturn` (the recovery's bridge record loses the
	// first-copy merge to the stored one), but the question's mid IS the turn's id. A retraction that filters on the
	// mark alone leaves the question beside the re-ask, and the model is told both (and, with a note, told twice).
	// One helper finds a turn's messages; no message is marked after it has joined the chat.
	const helper = lift(SRC, 'turnMessagesOf');
	const fns = ['continueTurn', 'retryTurn', 'answerAgain'].map((n) => lift(SRC, n));
	check('the three doors are in daimond.js', fns.every(Boolean));
	const spy = () => ({ tombstoned: [], ran: [], journal: [] });
	function doors(sp) {
		const st = {
			DaimondPeer: { isAskAnswer: Peer.isAskAnswer, dispatchState: () => 'no-peer-awake', dispatchControl: () => '' },
			DaimondLease: { record: () => null }, DaimondJournal: { clearTurn: (id) => sp.journal.push(id) },
			loadMsgTombs: () => ({}), msgTombstone: (mids) => sp.tombstoned.push(...mids), touchChat() {}, persistChats() {}, renderHistory() {},
			runTurn: (chat, text, opts) => { sp.ran.push({ text, opts, had: (chat.messages || []).map((m) => m.mid) }); }, ChatStore: { compact() {} },
			newMid: () => 'nmid', CONTINUE_NUDGE: '__nudge__', handoffTargetLabel: () => '', peerUiStateFor: () => '', selfDeviceId: () => 'SELF', turnHold: () => '', _askCard: null };
		const body = (helper ? helper + '\n' : '') + fns.filter(Boolean).join('\n') + '\nreturn { continueTurn, retryTurn, answerAgain };';
		return new Function('window', 'DaimondRatings', ...Object.keys(st), body)(Object.assign({}, st), R, ...Object.values(st));
	}
	// The transcript of a chat not resident at boot: the question has the turn's id for its mid and NO iturn mark; the answer carries it.
	const cold = () => ({ id: 'c9', messages: [
		U('mold', T(0), 'an earlier question'), A(1, T(1)),
		U('t9', T(2), 'the question', { pre: '[Daimond: the user rated your answer of 10:01 +1.]' }),
		Object.assign(A(3, T(3)), { iturn: 't9' }) ] });
	const mids = (c) => c.messages.map((m) => m.mid);

	{ // retryTurn
		const sp = spy(), d = doors(sp), c = cold();
		const went = run(() => d.retryTurn(c, 't9', 'the question', { person: true }));
		check('retryTurn: the unmarked question is retracted with its answer, and tombstoned', sp.tombstoned.includes('t9') && sp.tombstoned.includes('m3'), sp.tombstoned);
		check('retryTurn: the model is asked once, and the old question is not in the chat beside it', sp.ran.length === 1 && !sp.ran[0].had.includes('t9') && !mids(c).includes('t9'), { ran: sp.ran.map((r) => r.had), left: mids(c), went });
		check('retryTurn: the earlier turn stays', mids(c).join() === 'mold,m1', mids(c));
	}
	{ // retryTurn: the marked question (a resident chat) still goes, as before
		const sp = spy(), d = doors(sp), c = cold();
		c.messages[2].iturn = 't9';
		run(() => d.retryTurn(c, 't9', 'the question', { person: true }));
		check('retryTurn: a marked question is retracted as it always was', sp.tombstoned.includes('t9') && sp.ran.length === 1 && mids(c).join() === 'mold,m1', { t: sp.tombstoned, left: mids(c) });
	}
	{ // retryTurn: a turn whose only message is the unmarked question
		const sp = spy(), d = doors(sp), c = { id: 'c9', messages: [U('t8', T(0), 'alone')] };
		run(() => d.retryTurn(c, 't8', 'alone', { person: true }));
		check('retryTurn: a turn with only its unmarked question is retracted and asked again', sp.tombstoned.includes('t8') && sp.ran.length === 1 && !mids(c).includes('t8'), { t: sp.tombstoned, left: mids(c) });
	}
	{ // answerAgain
		const sp = spy(), d = doors(sp), c = { id: 'c9', messages: [ U('ta', T(0), 'ask'), A(1, T(1)),
			U('tb', T(2), 'Chose: Detach the paths'), Object.assign({ role: 'assistant', content: '', mid: 'mph', ts: T(3), why: 'dispatched' }, { iturn: 'tb' }) ] };
		run(() => d.answerAgain(c, 'tb'));
		check('answerAgain: the unmarked answer is retracted with its placeholder, and tombstoned', sp.tombstoned.includes('tb') && sp.tombstoned.includes('mph') && !sp.tombstoned.includes('ta'), sp.tombstoned);
		check('answerAgain: nothing of the turn is left, and nothing is sent', !mids(c).includes('tb') && !mids(c).includes('mph') && sp.ran.length === 0, mids(c));
	}
	{ // continueTurn (fixed at 76d9d1f8): held so the helper cannot regress it
		const sp = spy(), d = doors(sp), c = cold();
		run(() => d.continueTurn(c, 't9', 'the question'));
		check('continueTurn: the unmarked question is retracted and asked once, with the retracted note', sp.ran.length === 1 && !mids(c).includes('t9') && !sp.ran[0].had.includes('t9')
			&& sp.ran[0].opts && sp.ran[0].opts.told === '[Daimond: the user rated your answer of 10:01 +1.]', { ran: sp.ran, left: mids(c) });
	}
	// One finder, no marking
	const n = (re) => (SRC.match(re) || []).length;
	check('the finder is one helper', !!helper && /x\.iturn === iturn \|\| \(x\.role === 'user' && x\.mid === iturn\)/.test(helper), helper);
	check('all three doors use it', fns.every((f) => f && /turnMessagesOf\(chat, iturn\)/.test(f)), fns.map((f) => f && /turnMessagesOf/.test(f)));
	check('the `x.iturn === iturn` test is written once in the page (the helper), and no door marks a message', n(/x\.iturn === iturn/g) === 1 && fns.every((f) => f && !/\.iturn = /.test(f)), n(/x\.iturn === iturn/g));
}

console.log(failures ? ('\nFAIL -- ' + failures + '/' + checks + ' checks') : '\nALL PASS -- ' + checks + ' checks');
if (failures) process.exitCode = 1;
