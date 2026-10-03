/* ============================================================
   Test -- one chat's record converges across devices (r53 W-rec).
   ------------------------------------------------------------
   THE BUG (soak item 4, `chats/<n>/name: "" vs `). Three rules disagreed
   about one chat record's metadata, so two devices each kept their own:
     1. the runner's seed-built record was a copy stamped afresh (`updatedAt:
        Date.now()`, no `metaAt`) with no name and no worker, so it outranked
        the phone's real choice; and `seedFrom` sent `c.title`, a field no chat
        record has, so a seed never carried the name;
     2. the tab adoption took only a strictly newer stamp and kept its own
        worker over an empty one, where `mergeChatRecords` takes the
        canonically greater side at a tie and an empty value as a value;
     3. `stampOf` could not see a merge that decided a field at a tie, so the
        save skipped the merged record and the next read put the old one back.
   And "" against an absent `name` were two byte forms of one value.

   THE LAW. A chat record's metadata (and its turn fields) is a register:
   the later stamp wins, a tie goes to the canonically greater value, and
   every value is held in one normalised form. One helper (`chatMetaBeats`,
   `chatTurnBeats`, `takeChatMeta`) decides it for the merge and the tab
   adoption alike; the store's change stamp carries the decided fields; a
   replica keeps the stamp it came with (0 where it came with none).

   WHAT IS CHECKED, through the REAL functions lifted from the tree:
     A. `mergeChatRecords` is a join on the record's bytes on generated
        pairs and triples: idempotent, commutative, associative;
     B. the tab adoption lands where `mergeChatRecords` does, both ways;
     C. `stampOf` moves whenever a merge changes a decided field;
     D. a seed carries the record's name and worker, and the graft's
        replica keeps a stamp of 0.
     node www/js/chatlaw.test.mjs      # ALL PASS
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { makeWindow, sliceDaimond, rng } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = readFileSync(join(HERE, 'daimond.js'), 'utf8');

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const w = makeWindow({ now: 1_000_000_000 });
const want = ['mergeChatRecords', 'slimChat', 'chatFields'];
const has = (n) => new RegExp('\\n\\t+function ' + n + '\\(').test(APP);
for (const n of ['chatMetaBeats', 'chatTurnBeats', 'takeChatMeta']) if (has(n)) want.push(n);
const F = sliceDaimond(w, want, { loadMsgTombs: () => ({}) }).fns;
const { mergeChatRecords, slimChat } = F;

/// Lifts `function name(...) { ... }` at any indentation by counting braces.
function extractFn(src, name) {
	const m = new RegExp('\\n\\t+(async )?function ' + name + '\\(').exec(src);
	if (!m) throw new Error('function not found: ' + name);
	const start = m.index + 1;
	const brace = src.indexOf('{', start);
	let depth = 0, i = brace;
	for (; i < src.length; i++) {
		if (src[i] === '{') depth++;
		else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return src.slice(start, i);
}
const { stampOf } = new Function([
	// `stampOf` and the residency-aware reads it makes (5.2.1's chatstore fix), as chatstamp.test lifts them.
	extractFn(APP, 'stampOf'), extractFn(APP, 'msgStanding'), extractFn(APP, 'standingOf'),
	extractFn(APP, 'chatMsgCount'), extractFn(APP, 'chatSessionMsgs'),
	'return { stampOf };',
].join('\n'))();

// The record as it travels, without the transcript (the message law's own test covers it).
const bytes = (c) => { const o = Object.assign({}, c); delete o.messages; delete o.session; return JSON.stringify(o); };
const M = (a, b) => mergeChatRecords(structuredClone(a), structuredClone(b), { localMsgs: [], remoteMsgs: [] });

/// One device's copy of chat `c1`: the values copies really take, absent keys included.
function rec(r) {
	const o = { id: 'c1', messages: [] };
	const put = (k, vals) => { const v = r.pick(vals); if (v !== undefined) o[k] = v; };
	put('name', [undefined, '', '', 'Plan', 'plan']);
	put('model', [undefined, '', 'm1']);
	put('provider', [undefined, '', 'p1']);
	put('workerModel', [undefined, '', 'w1', 'w2']);
	put('workerProvider', [undefined, '', 'wp']);
	put('status', [undefined, 'active', 'archived']);
	put('holds', [undefined, [], ['f1']]);
	put('diamondId', [undefined, '', 'd1']);
	put('updatedAt', [undefined, 0, 100, 100, 200]);
	put('metaAt', [undefined, 0, 100, 100, 200]);
	put('promptTokens', [undefined, 0, 5, 9]);
	put('costUsd', [undefined, 0, 0.01]);
	return o;
}

console.log('\nA. the join laws on the record\'s bytes (2000 generated pairs and triples)\n');
{
	const r = rng(0x5eed);
	let idem = 0, comm = 0, assoc = 0, fixed = 0, eg = '';
	const N = 2000;
	for (let i = 0; i < N; i++) {
		const a = rec(r), b = rec(r), c = rec(r);
		const ab = M(a, b), ba = M(b, a);
		if (bytes(M(ab, ab)) === bytes(ab)) idem++;
		if (bytes(ab) === bytes(ba)) comm++; else if (!eg) eg = bytes(ab) + ' | ' + bytes(ba);
		if (bytes(M(M(a, b), c)) === bytes(M(a, M(b, c)))) assoc++;
		if (bytes(M(ab, a)) === bytes(ab) && bytes(M(b, ab)) === bytes(ab)) fixed++;
	}
	check('idempotent: a merged record merged with itself is unchanged', idem === N, idem + '/' + N);
	check('commutative: either device\'s order gives the same bytes', comm === N, comm + '/' + N + ' ' + eg);
	check('associative: the order of arrival does not matter', assoc === N, assoc + '/' + N);
	check('a fixed point: merging an input back in changes nothing', fixed === N, fixed + '/' + N);
	const x = M({ id: 'c1', name: '', updatedAt: 5, metaAt: 5 }, { id: 'c1', updatedAt: 5, metaAt: 5 });
	const y = M({ id: 'c1', updatedAt: 5, metaAt: 5 }, { id: 'c1', name: '', updatedAt: 5, metaAt: 5 });
	check('"" against an absent name is one value, the same bytes both ways', bytes(x) === bytes(y) && x.name === '', bytes(x) + ' | ' + bytes(y));
	check('a record travels with `name` a string even when it was never set', slimChat({ id: 'c1' }).name === '');
}

// ── The tab adoption, lifted from the tree: the block that updates `c` from `s`. ──
function adoptionFn() {
	const at = APP.indexOf('var sMeta = (typeof s.metaAt');
	const end = APP.indexOf('return c;', at);
	if (at < 0 || end < 0) throw new Error('the tab adoption block was not found');
	const body = APP.slice(at, end);
	const args = ['s', 'c', 'DaimondStamp', 'slimChat', 'chatFields', 'CHAT_TURN_FIELDS', 'CHAT_META_FIELDS'];
	const extra = ['chatMetaBeats', 'chatTurnBeats', 'takeChatMeta'].filter(has);
	return new Function(...args, ...extra, body + '\nreturn c;');
}
const ADOPT = adoptionFn();
const TF = ['promptTokens', 'completionTokens', 'cachedTokens', 'costUsd', 'prevPrompt', 'prevCompletion', 'lastPrompt', 'prevCached', 'prevCost'];
const MF = ['name', 'model', 'provider', 'workerModel', 'workerProvider', 'status', 'foldedInto', 'holds', 'diamondId'];
const adopt = (s, c) => ADOPT(structuredClone(s), structuredClone(c), w.DaimondStamp, slimChat, F.chatFields, TF, MF,
	...['chatMetaBeats', 'chatTurnBeats', 'takeChatMeta'].filter(has).map((n) => F[n]));
const decided = (c) => { const s = slimChat(c); const o = {}; for (const k of MF.concat(TF, ['updatedAt', 'metaAt'])) o[k] = s[k]; return JSON.stringify(o); };

console.log('\nB. the tab adoption lands where the merge does\n');
{
	const r = rng(0xada9);
	let agree = 0, eg = '';
	const N = 2000;
	for (let i = 0; i < N; i++) {
		// A tab's copy against the store's: the store's is a summary, normalised as `summaryOf` writes it.
		const s = slimChat(rec(r)), c = rec(r);
		const t = adopt(s, c), m = M(s, c);
		if (decided(t) === decided(m)) agree++; else if (!eg) eg = decided(t) + ' | ' + decided(m);
	}
	check('on 2000 generated pairs, the tab holds what `mergeChatRecords` gives', agree === N, agree + '/' + N + ' ' + eg);
	const phone = { id: 'c1', name: 'Plan', workerModel: '', updatedAt: 100, metaAt: 200 };
	const tab = { id: 'c1', name: 'Plan', workerModel: 'w1', updatedAt: 100, metaAt: 100 };
	check('a newer empty worker is taken as a value, not kept over', adopt(slimChat(phone), tab).workerModel === '');
	const tie1 = { id: 'c1', name: 'Plan', workerModel: 'w2', updatedAt: 100, metaAt: 100 };
	check('a tie goes to the canonically greater side, as the merge sends it',
		adopt(slimChat(tie1), tab).workerModel === M(tie1, tab).workerModel && M(tie1, tab).workerModel === 'w2');
}

console.log('\nC. the store\'s change stamp sees a merge that decides a field at a tie\n');
{
	const r = rng(0x57a3);
	let seen = 0, n = 0, eg = '';
	for (let i = 0; i < 2000; i++) {
		const a = rec(r), b = rec(r);
		const m = M(a, b);
		const before = Object.assign({}, b, { _loaded: true }), after = Object.assign({}, m, { _loaded: true });
		if (decided(before) === decided(after)) continue;
		n++;
		if (stampOf(before) !== stampOf(after)) seen++; else if (!eg) eg = decided(before) + ' -> ' + decided(after);
	}
	check('every merge that changes a decided field changes the stamp', n > 0 && seen === n, seen + '/' + n + ' ' + eg);
	const sum = { id: 'c1', v: 3, name: '', model: '', provider: '', diamondId: '', workerModel: '', workerProvider: '',
		status: 'active', promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, prevPrompt: 0,
		prevCompletion: 0, prevCached: 0, prevCost: 0, lastPrompt: 0, holds: [], updatedAt: 7, metaAt: 7,
		foldedInto: null, msgCount: 0, standing: 'p0f0i0' };
	const live = { id: 'c1', updatedAt: 7, metaAt: 7, messages: [], holds: [], _loaded: true };
	check('a live chat with its fields unset stamps as its summary does (nothing rewritten at boot)',
		stampOf(live) === stampOf(Object.assign({}, sum, { _loaded: false })), stampOf(live) + ' | ' + stampOf(sum));
}

console.log('\nD. a seed carries the name and the worker; the replica keeps its stamp\n');
{
	const src = readFileSync(join(HERE, 'peer.js'), 'utf8');
	const win = { console, setTimeout: () => 0, clearTimeout: () => {} };
	win.window = win;
	const ctx = vm.createContext(win);
	let seed = null;
	try {
		vm.runInContext(src, ctx);
		seed = win.DaimondPeer.seedFrom({ id: 'c1', name: 'Plan', model: 'm1', provider: 'p1', workerModel: 'w1', workerProvider: 'wp',
			messages: [{ role: 'user', content: 'hi', mid: 'u1', ts: 1 }] }, 'u1');
	} catch (e) { seed = { err: String(e) }; }
	check('the seed carries the record\'s `name`', seed && seed.name === 'Plan', JSON.stringify(seed));
	check('and its worker model and provider', seed && seed.workerModel === 'w1' && seed.workerProvider === 'wp', JSON.stringify(seed));
	const g = extractFn(APP, 'graftSeed');
	check('the replica is built with the record\'s `name` and worker from the seed',
		/name:\s*String\(seed\.name/.test(g) && /workerModel:\s*String\(seed\.workerModel/.test(g));
	check('the replica keeps a stamp of 0 on both axes (it outranks nothing the dispatcher wrote)',
		/updatedAt:\s*0,/.test(g) && /metaAt:\s*0,/.test(g) && !/updatedAt:\s*Date\.now\(\)/.test(g));
	check('a graft moves no stamp', !/touchChat\(chat\)/.test(g));
	const phone = { id: 'c1', name: 'Plan', workerModel: 'w1', workerProvider: 'wp', updatedAt: 50, metaAt: 50 };
	const replica = { id: 'c1', name: 'Plan', workerModel: 'w1', workerProvider: 'wp', updatedAt: 0, metaAt: 0 };
	check('the phone\'s record over the replica, both ways', bytes(M(phone, replica)) === bytes(M(replica, phone))
		&& M(replica, phone).metaAt === 50);
}

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
if (failures) process.exitCode = 1;
