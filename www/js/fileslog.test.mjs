/* ============================================================
   Test -- A CHAT'S FILES ROW IS A `files_log`, DISPLAY ONLY (plan sections 1 J4,
   J6, J10 and 2; lane P, P1b).
   ------------------------------------------------------------
   A chat turn that changed files leaves one `files_log` message under its answer:
   `{ role, mid, ts, prod }`, one `k: 'file'` record per manifest row that names its
   author, appended once at the end of the turn and drawn from its records alone. It
   is never sent to the model.

   daimond.js cannot be loaded whole in Node (see badge.test.mjs), so this LIFTS the
   real functions by name with a brace-balanced scan and runs them against the REAL
   provenance.js, ratings.js and peer.js; the turn itself is too large to run here, so
   its order is held by position. The page is proven by the world run (p_fw.mjs FC0-FC7:
   the stored row, the tile, a tap, a reload with the store gone, the phone).

   Run:  node www/js/fileslog.test.mjs
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

// ── The real modules, in a bare scope ──────────────────────
const win = {};
for (const f of ['provenance.js', 'ratings.js']) new Function('window', readFileSync(join(HERE, f), 'utf8'))(win);
const R = win.DaimondRatings, V = win.DaimondProvenance;
function loadPeer() {
	const w = {};
	const noEl = { appendChild() {}, addEventListener() {}, setAttribute() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } };
	const document = { readyState: 'complete', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
		getElementById: () => null, createElement: () => Object.assign({}, noEl), body: noEl };
	new Function('window', 'document', 'console', 'setTimeout', 'clearTimeout', 'Date', 'with (window) {\n' + PEER + '\n}')(w, document, console, setTimeout, clearTimeout, Date);
	return w;
}
const Peer = loadPeer().DaimondPeer;

// ── Fixtures: the manifest of a chat's second turn, as the engine kept it ──
const CID = 'cmuqe851w-1-0wcku', STORE = 'chat:' + CID, W = 'chats/' + CID + '/work/';
const BY = { role: 'chat', m: 'mock/fast', pv: 'custom:http://127.0.0.1:9186/v1/chat/completions', sp: 'sp1:73e0bd97' };
const H = (c) => c.repeat(64);
const MAN = [{ version: 2, v: 1, ts: 1790911099440, cause: 'turn', turn: '', note: '', files: [
	{ path: W + 'n.md', hash: H('a'), bytes: 9, by: BY },
	{ path: W + 'o.md', hash: H('b'), bytes: 10, was: H('c'), by: BY },
	{ path: W + 'sub/deep.md', hash: H('d'), bytes: 5, by: Object.assign({}, BY, { via: 'command' }) },
	{ path: W + 'nobody.md', hash: H('e'), bytes: 5 },										// no author: no record (J1)
	{ path: W + 'gone.md', gone: true, was: H('f'), by: BY },									// deleted
] }, { version: 1, v: 1, ts: 1790911096186, cause: 'turn', turn: '', note: '', files: [{ path: W + 'o.md', hash: H('c'), bytes: 4, by: BY }] }];

// ── Lifts ──────────────────────────────────────────────────
const names = ['turnFileProds', 'filesLogOf', 'tsPast'];		// tsPast: the one rule a record's time follows
const src = {}; for (const n of names) src[n] = lift(SRC, n);
check('turnFileProds, filesLogOf and tsPast are in daimond.js', names.every((n) => !!src[n]), names.filter((n) => !src[n]).join(','));
let asked = [], diffs = [];
// What the store's diff answers for a pair of bodies; a pair not here is one it cannot compare (binary, past the cap, not held).
const DIFFS = { ['>' + H('a')]: { add: 3, del: 0, rows: [] }, [H('c') + '>' + H('b')]: { add: 2, del: 1, rows: [] } };
function scope(manifests) {
	if (!names.every((n) => !!src[n])) return null;
	const w = { DaimondProvenance: V, DaimondRatings: R, DaimondVersions: { manifests: async (id) => { asked.push(id); return manifests; }, diff: async (id, was, now) => { diffs.push([id, was, now]); return DIFFS[(was || '') + '>' + now] || null; } } };
	const stampProd = (o) => V.stamp(o);
	let seq = 0;
	return new Function('window', 'DaimondProvenance', 'DaimondVersions', 'stampProd', 'selfDeviceId', 'newMid', 'Date', names.map((n) => src[n]).join('\n') + '\nreturn { turnFileProds, filesLogOf };')(w, w.DaimondProvenance, w.DaimondVersions, stampProd, () => 'dev-1', () => 'mid-' + (++seq), Date);
}
const S = scope(MAN) || { turnFileProds: async () => { throw new Error('missing'); }, filesLogOf: async () => { throw new Error('missing'); } };
const ev = (keeper, version) => ({ type: 'versions', keeper, version, files: [W + 'n.md'] });
const run = async (f) => { try { return await f(); } catch (e) { return 'threw: ' + e.message; } };

async function main() {
	// ═══ 1. The row's records ═══
	console.log('\nThe files_log holds one record per manifest row that names its author');
	{
		const chat = { id: CID, messages: [{ role: 'user', content: 'go', mid: 'u1', ts: 1790911000000 }, { role: 'assistant', content: 'done', mid: 'a1', ts: 1790911090000 }] };
		asked = []; diffs = [];
		const log = await run(() => S.filesLogOf(chat, ev(STORE, 2), 'u1'));
		check('a chat keeper\'s event makes a row', log && typeof log === 'object' && log.role === 'files_log', JSON.stringify(log));
		same('its keys are role, mid, ts, prod, delta, in that order, and it has no content', Object.keys(log || {}), ['role', 'mid', 'ts', 'prod', 'delta']);
		same('its delta is the +N -M of each row the store can count, by handle, made when the row is: a new file is all-add, an update counts against the version before it', (log && log.delta) || null, [{ h: 'p1:file:' + STORE + '/v2/' + W + 'n.md', add: 3, del: 0 }, { h: 'p1:file:' + STORE + '/v2/' + W + 'o.md', add: 2, del: 1 }]);
		same('a row it cannot count (deep.md, no honest diff) and a gone file have no entry: they read a dot and a minus', ((log && log.delta) || []).map((d) => d.h.split('/v2/')[1]), [W + 'n.md', W + 'o.md']);
		same('the counts were asked of the chat\'s own store, never of a gone file', diffs.map((d) => d[0] + ' ' + (d[1] ? 'update' : 'new')), [STORE + ' new', STORE + ' update', STORE + ' new']);
		check('the manifest read is the chat\'s own store', asked.join() === STORE, asked);
		const p = (log && log.prod) || [];
		same('one record for each row with an author, in manifest order (the unattributed row has none, the gone one has)', p.map((r) => r.h.split('/v2/')[1]), [W + 'n.md', W + 'o.md', W + 'sub/deep.md', W + 'gone.md']);
		check('the handle is p1:file:chat:<id>/v<N>/<store path>, and the page reads it back as that file', p.every((r) => r.h === 'p1:file:' + STORE + '/v2/' + r.h.split('/v2/')[1] && R.fileOf(r.h) && R.fileOf(r.h).store === STORE && R.fileOf(r.h).v === 2), p.map((r) => r.h));
		check('every record is the 18-key Prod v2, a file, with the author the manifest names', p.every((r) => r.k === 'file' && Object.keys(r).length === 18 && r.role === 'chat' && r.m === 'mock/fast' && r.sp === 'sp1:73e0bd97' && V.isProd(r)), p.map((r) => Object.keys(r).length));
		check('it is the chat\'s record: no Diamond, this chat, the turn\'s own message, this device, the manifest\'s time', p.every((r) => r.d === '' && r.c === CID && r.t === 'u1' && r.dev === 'dev-1' && r.at === 1790911099440), p.map((r) => [r.d, r.c, r.t, r.dev, r.at]));
		same('a hash is the file\'s own, and a gone file\'s is empty', p.map((r) => r.hash), [H('a'), H('b'), H('d'), '']);
		same('via is the command mark where a window found it, and empty otherwise', p.map((r) => r.via), ['', '', 'command', '']);
		check('the row is not yet on the chat (the caller pushes it, once)', chat.messages.length === 2);
		check('it is later than the last message, so a reload\'s merge keeps it under the answer', log.ts > 1790911090000, log.ts);
		const tied = { id: CID, messages: [{ role: 'assistant', content: 'done', mid: 'a1', ts: 9e15 }] };
		const log2 = await run(() => S.filesLogOf(tied, ev(STORE, 2), 'u1'));
		check('even when the clock has not moved past it', log2.ts === 9e15 + 1, log2.ts);
		const byTime = (list) => list.slice().sort((x, y) => ((x.ts || 0) - (y.ts || 0)) || String(x.mid).localeCompare(String(y.mid)));
		const msgs = chat.messages.concat([log]);
		same('a reload\'s order (by time, then id) is the push order: the row stays under its answer', byTime(msgs).map((m) => m.mid), msgs.map((m) => m.mid));
	}

	// ═══ 2. Where it is not made ═══
	console.log('\nA row is made for a chat\'s own store only, and only where a row is credited');
	{
		const chat = { id: CID, messages: [] };
		check('a Diamond\'s keeper makes none (its daimon\'s turn has the tail note)', (await run(() => S.filesLogOf(chat, ev('1a0f2b3c', 2), 'u1'))) === null);
		check('an event with no version, or version 0, makes none', (await run(() => S.filesLogOf(chat, { type: 'versions', keeper: STORE }, 'u1'))) === null && (await run(() => S.filesLogOf(chat, ev(STORE, 0), 'u1'))) === null);
		check('a version the store does not hold makes none', (await run(() => S.filesLogOf(chat, ev(STORE, 9), 'u1'))) === null);
		check('junk makes none and does not throw', (await run(() => S.filesLogOf(chat, null, 'u1'))) === null && (await run(() => S.filesLogOf(chat, {}, 'u1'))) === null);
		const none = scope([{ version: 2, files: [{ path: W + 'a.md', hash: H('a') }, { path: W + 'b.md', hash: H('b'), by: { role: '' } }] }]);
		check('a turn whose rows name nobody makes none (J1: never the wrong agent)', (await run(() => none.filesLogOf(chat, ev(STORE, 2), 'u1'))) === null);
		const nolib = new Function('window', 'DaimondProvenance', 'DaimondVersions', 'stampProd', 'selfDeviceId', 'newMid', 'Date', src.turnFileProds + '\n' + src.filesLogOf + '\n' + src.tsPast + '\nreturn filesLogOf;')({ DaimondVersions: { manifests: async () => MAN } }, undefined, { manifests: async () => MAN }, () => null, () => 'd', () => 'm', Date);
		check('without the provenance module a row is not made (nothing is stamped)', (await run(() => nolib(chat, ev(STORE, 2), 'u1'))) === null);
	}

	// ═══ 3. The turn writes it once, at the end, after the answer and before the ending ═══
	console.log('\nThe turn holds the event and writes the row in its `finally`, once');
	{
		const arm = SRC.indexOf("ev.type === 'versions'"), armEnd = SRC.indexOf("ev.type === 'interjected'", arm);
		const armSrc = SRC.slice(arm, armEnd);
		check('the versions arm holds a chat keeper\'s event and draws nothing (the answer is not in the transcript yet)',
			/filesEv = ev/.test(armSrc) && /indexOf\('chat:'\) === 0/.test(armSrc) && !/appendFilesLog|chat\.messages\.push/.test(armSrc), armSrc);
		check('offerTurnUndo is the 5.2.9 toast: it reads `files` and never `made`', !/\bmade\b/.test(lift(SRC, 'offerTurnUndo') || 'made'), '');
		const iFlog = SRC.indexOf('var flog = await filesLogOf(chat, fev, umid)');
		const iKeep = SRC.indexOf('await app.end_keeper_turn(', arm), iEnd = SRC.indexOf('chat.messages.push(pendingEnd)', arm);
		check('it is written after the Diamond store\'s turn end and before the ending', iKeep > 0 && iFlog > iKeep && iEnd > iFlog, { iKeep, iFlog, iEnd });
		const tryEnd = SRC.indexOf('} finally {', arm);
		check('and in the `finally`, so a turn that wrote a file and then failed still has its row', tryEnd > 0 && iFlog > tryEnd, { tryEnd, iFlog });
		check('it is pushed, then drawn only where this chat is on screen', /chat\.messages\.push\(flog\); if \(owns\(\)\) appendFilesLog\(flog\)/.test(SRC));
		check('the event is spent after it is read (a second path to the row would write it twice)', /var fev = filesEv; filesEv = null;/.test(SRC) && (SRC.match(/filesLogOf\(/g) || []).length === 2, (SRC.match(/filesLogOf\(/g) || []).length);
		check('only runTurn makes one: no other caller of filesLogOf, and nothing else pushes a files_log', (SRC.match(/role:\s*'files_log'/g) || []).length === 1, (SRC.match(/role:\s*'files_log'/g) || []).length);
		check('a failure to build it never fails the turn', /try \{\s*var flog = await filesLogOf[\s\S]{0,260}catch \(eF\)/.test(SRC));
	}

	// ═══ 4. Display only ═══
	console.log('\nThe row is display only: never sent to the model');
	{
		const chat = { id: CID, provider: 'p', model: 'm', messages: [
			{ role: 'user', content: 'first', mid: 'u1', ts: 1 }, { role: 'assistant', content: 'one', mid: 'a1', ts: 2 },
			{ role: 'files_log', mid: 'f1', ts: 3, prod: [V.stamp({ h: 'p1:file:' + STORE + '/v1/' + W + 'o.md', k: 'file', role: 'chat', hash: H('c') })] },
			{ role: 'user', content: 'turn-9', mid: 'turn-9', ts: 4 }] };
		const seed = Peer.seedFrom(chat, 'turn-9', 24, 4000);
		check('a hand-off seed leaves it out (only user, assistant and tool travel)', !!seed && seed.msgs.map((m) => m.mid).join() === 'u1,a1' || (!!seed && !seed.msgs.some((m) => m.role === 'files_log')), seed && seed.msgs.map((m) => m.role + ':' + m.mid));
		const fed = (SRC.match(/m\.content && \(m\.role === 'user' \|\| m\.role === 'assistant'\)/g) || []).length + (SRC.match(/msg\.content && \(msg\.role === 'user' \|\| msg\.role === 'assistant'\)/g) || []).length;
		check('the engine\'s history is built from user and assistant messages that carry content, and a files_log carries none', fed >= 2 && !/files_log/.test(PEER), fed);
		check('a watcher\'s progress frames do not carry it (it is not one of the roles drawn from a frame)', !/files_log/.test(PEER.slice(PEER.indexOf('var PROGRESS_ROLES'), PEER.indexOf('var PROGRESS_ROLES') + 300)));
		check('no file handle or files_log text is composed into any request by the page', !/files_log/.test(lift(SRC, 'ratingPre') + lift(SRC, 'pushUserRecord') + lift(SRC, 'storedPre')));
		check('the note\'s cut is not moved by it (it is not a user message)', R.noteFor(chat.messages.concat([R.message(R.build({ prod: V.stamp({ h: 'p1:answer:' + CID + '/a1', k: 'answer', role: 'chat' }), s: -1, clear: false, tags: [], dims: {}, note: '', src: 'tap', sup: '', burst: 'b', tools: '', len: 3 }), 'r-1', 5)]).slice(0, 5), { hhmm: () => '10:00' }) === '[Daimond: the user rated your answer of 10:00 −1.]');
	}

	// ═══ 5. Drawn from its records alone ═══
	console.log('\nIt is drawn from its records, rated as the Diamond\'s rows are');
	{
		const arm = lift(SRC, 'drawHistoryMessage') || '';
		check('drawHistoryMessage draws a files_log through appendFilesLog', /m\.role === 'files_log'\)\s*\{\s*appendFilesLog\(m\)/.test(arm));
		const af = lift(SRC, 'appendFilesLog') || '', fb = lift(SRC, '_filesLogBox') || '', fr = lift(SRC, '_turnFileRow') || '';
		check('the box is built from the message\'s own records (no store lookup, no await)', !!af && !!fb && !/await|DaimondVersions/.test(af + fb), '');
		check('it wears the Diamond tail note\'s Files tile and then mounts the rating group on its rows', /buildTile\('tool', \{ who: tOr\('chat\.who_files', 'Files'\), expanded: true/.test(af) && /mountFileRates\(box\)/.test(af));
		const drawPart = fr.slice(fr.indexOf('if (still && e && e.gone)'), fr.indexOf('} else if (was || now)'));
		check('a still row draws its count from its record and asks the store nothing until it is pressed', /typeof e\.add === 'number'\) paintDelta\(\{ add: e\.add, del: e\.del \}\)/.test(drawPart) && drawPart.indexOf('DaimondVersions') > drawPart.indexOf("addEventListener('click'"), drawPart.slice(0, 300));
		check('a gone file keeps its minus and nothing to press', /if \(still && e && e\.gone\) \{[\s\S]{0,160}'−';/.test(fr));
		check('a press folds an open diff away first (it needs no store for that), then asks the manifest for the version before', drawPart.indexOf("querySelector('.tf-sbs')") > 0 && drawPart.indexOf("querySelector('.tf-sbs')") < drawPart.indexOf('manifests(id)'), '');
		check('a new file opens the file as its name does, an update folds the diff in, and a version not held leaves a dot (a Diamond row\'s own three)', /!ent \|\| !ent\.hash\) \{ de\.textContent = '·'/.test(drawPart) && /!ent\.was\) \{ openTurnFile\(id, name, ent\.hash\)/.test(drawPart) && /paintDiff\(d\)/.test(drawPart), '');
		check('the box takes the message\'s delta and hands each row its add and del', /_filesLogBox\(recs, m\.delta\)/.test(af) && /add: c && typeof c\.add === 'number'/.test(fb), '');
		check('and takes its handle from its record', /still && e && e\.h \? e\.h/.test(fr));
		const rf = lift(SRC, 'rateFileRecs') || '';
		const recsOf = new Function('window', 'DaimondProvenance', 'current', rf + '\nreturn rateFileRecs;')(win, V, { messages: [
			{ role: 'user', content: '[Daimond: this turn changed 1 file (v2): a.md]', prod: [V.stamp({ h: 'p1:file:D1/v2/diamonds/D1/a.md', k: 'file', role: 'daimon' })] },
			{ role: 'files_log', mid: 'f1', ts: 3, prod: [V.stamp({ h: 'p1:file:' + STORE + '/v2/' + W + 'n.md', k: 'file', role: 'chat' }), V.stamp({ h: 'p1:answer:x/y', k: 'answer', role: 'chat' })] },
			{ role: 'assistant', mid: 'a', prod: [V.stamp({ h: 'p1:file:X/v1/x', k: 'file', role: 'chat' })] }] });
		same('rateFileRecs finds a chat\'s file records beside a Diamond tail note\'s, and only file records of those two', [...recsOf().keys()], ['p1:file:D1/v2/diamonds/D1/a.md', 'p1:file:' + STORE + '/v2/' + W + 'n.md']);
		// the names as a reader sees them
		same('the chat\'s files read from the chat\'s folder', ['n.md', 'sub/deep.md'].map((p) => V.rel(W + p, STORE)), ['n.md', 'sub/deep.md']);
		const bnd = R.build({ prod: V.stamp({ h: 'p1:file:' + STORE + '/v2/' + W + 'n.md', k: 'file', role: 'chat', hash: H('a') }), s: 1, clear: false, tags: [], dims: {}, note: '', src: 'tap', sup: '', burst: 'b', tools: 'file_write', len: 99 });
		check('a rating of a chat\'s file keeps the record\'s hash and holds no tools and no length (D6)', bnd.hash === H('a') && bnd.tools === '' && bnd.len === 0, JSON.stringify({ hash: bnd.hash, tools: bnd.tools, len: bnd.len }));
		check('the note tells the model of it by the path it wrote', /rated the change to chats\/cmuqe851w-1-0wcku\/work\/n\.md \+1/.test(R.noteFor([R.message(bnd, 'r-1', 5)], { hhmm: () => '10:00' })), R.noteFor([R.message(bnd, 'r-1', 5)], { hhmm: () => '10:00' }));
	}

	console.log(failures ? ('\nFAIL -- ' + failures + '/' + checks + ' checks') : '\nALL PASS -- ' + checks + ' checks');
	if (failures) process.exitCode = 1;
}

import('node:test').then(({ test }) => {
	test(fileURLToPath(import.meta.url), main);
}).catch(() => { main(); });
