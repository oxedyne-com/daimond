/* ============================================================
   Test -- A rating_log MESSAGE SURVIVES AN r526 DEVICE (U2 plan, unit H, section 11).
   ------------------------------------------------------------
   U2 writes `rating_log` messages into a chat's transcript, the legacy
   carrier. A device still on r526 knows no such role, and it will meet the
   message in three places, each of which has to leave it alone:

     1. the union of two copies of a transcript  (mergeMessages),
     2. the trim done on its way into storage     (slimMessages),
     3. the drawing of a stored message            (drawHistoryMessage).

   The r526 code is not loaded here; these are FAITHFUL PORTS of it, taken
   from the U1-port base `18ea5e68` (`www/js/daimond.js` :1222-1325,
   :3744-3765 and :22245-22308 there), as `immutable.test.mjs` ports its own
   predicates. They carry r526's behaviour, not U2's: U2's `drawHistoryMessage`
   has a `rating_log` arm, and that is what the OLD dispatch below lacks.

   A MUTANT PORT, a merge that drops every role it does not know, is run
   through the same assertions and must fail them, which proves the
   assertions can fail.

   5.3.0 (U3 plan section 5, V1) adds the two shapes the new build writes -- a `files_log` message and a v2 `prod` (`via` last) --
   to the same three ports. Each must survive union in both orders byte for byte, pass slim whole, and draw nothing under the old
   dispatch. The page builder's own bytes are `dev/fixtures/rating_u3.json` (P1a writes it): until it exists, one check says so.

   U4 (5.3.0, V3c) adds the user message's two keys, `pre` (the note the person's message took) and `app` (set on a message the
   app made), and the files_log's `delta`. The last section puts a 5.2.10 page's merge beside a 5.3.0 page's records: nothing is
   lost, the old page hands the unknown keys back unchanged (merge, slim, merge again), the real ratings.js reads them back (the
   note for the next message depends on `app`), and the 5.2.9 model projection sends `content` alone, which is the limit
   section 10.4 of the plan states. A second mutant, a merge that rebuilds each message from the keys r526 knows, fails it.

   Run:  node www/js/ratings.mixed.test.mjs
         node www/js/ratings.mixed.test.mjs --as-strip    # the 5.3.0 section against the key-stripping mutant: it must go red
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const J = JSON.stringify;
let checks = 0, failures = 0, quiet = false;
function check(name, cond, detail) {
	checks++;
	if (cond) { if (!quiet) console.log('  ok   ' + name); }
	else { failures++; if (!quiet) console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// ── r526's pure halves, ported ──────────────────────────────────────────
var OLD_LEGACY = /^legacy-\d+$/;
function stampMessages(msgs, scope) {
	var at = scope || 'nochat';
	(msgs || []).forEach(function (m, i) {
		if (!m.mid)                      m.mid = 'legacy-' + at + '-' + ('0000' + i).slice(-4);
		else if (OLD_LEGACY.test(m.mid)) m.mid = 'legacy-' + at + '-' + m.mid.slice(7);
		if (!m.ts) m.ts = 0;
	});
	return msgs || [];
}
function unbadge(m) {
	if (!m || !m.interrupted) return m;
	var out = {};
	for (var k in m) {
		if (!Object.prototype.hasOwnProperty.call(m, k)) continue;
		if (k === 'interrupted' || k === 'why') continue;
		out[k] = m[k];
	}
	return out;
}
/// `mergeMessages`, line for line. `tombs` is the tombstone map (empty here).
function mergeMessages(a, b, scope, tombs) {
	var at = {}, out = [];
	tombs = tombs || {};
	stampMessages(a, scope).concat(stampMessages(b, scope)).forEach(function (m) {
		if (tombs[m.mid]) return;
		var had = at[m.mid];
		if (had === undefined) { at[m.mid] = out.length; out.push(m); return; }
		var prev = out[had];
		if (!prev.provisional !== !m.provisional) { if (prev.provisional) out[had] = m; return; }
		if (!prev.framed !== !m.framed) { if (prev.framed) out[had] = m; return; }
		if (!prev.interrupted !== !m.interrupted) { prev = out[had] = unbadge(prev); m = unbadge(m); }
		if ((prev.elided || 0) && !(m.elided || 0)) { out[had] = m; return; }
		else if (m.role === prev.role && !(m.elided || 0) && !(prev.elided || 0)) {
			var pc = prev.content == null ? '' : String(prev.content);
			var mc = m.content    == null ? '' : String(m.content);
			if (mc.length > pc.length && mc.lastIndexOf(pc, 0) === 0) out[had] = m;
		}
	});
	out.sort(function (x, y) {
		if ((x.ts || 0) !== (y.ts || 0)) return (x.ts || 0) - (y.ts || 0);
		return String(x.mid).localeCompare(String(y.mid));
	});
	return out;
}
/// The mutant: r526's merge that forgets any role it was not written for.
const KNOWN = ['user', 'assistant', 'error_log', 'note_log', 'fold_log', 'vision_log', 'think_log', 'leak_log', 'end_log', 'tool_log'];
function mergeMutant(a, b, scope, tombs) {
	return mergeMessages(a, b, scope, tombs).filter(function (m) { return KNOWN.indexOf(m.role) >= 0; });
}
/// `slimMessages`, branch for branch; the two text helpers are reduced to their arithmetic, which a
/// rating_log never reaches (it is none of tool_log, think_log, vision_log or error_log).
var TOOL_KEEP = 2048, LOG_KEEP_HEAD = 2048, LOG_KEEP_TAIL = 1024;
function slimMessages(msgs) {
	return (msgs || []).map(function (m) {
		if (!m || m.elided) return m;
		if (m.role === 'tool_log') {
			var body = String(m.content == null ? '' : m.content);
			if (body.length <= TOOL_KEEP) return m;
			var out = {};
			for (var k in m) { if (Object.prototype.hasOwnProperty.call(m, k)) out[k] = m[k]; }
			out.content = body.slice(0, TOOL_KEEP); out.elided = body.length - TOOL_KEEP;
			return out;
		}
		if (m.role === 'think_log' || m.role === 'vision_log' || m.role === 'error_log') {
			var b = String(m.content == null ? '' : m.content);
			if (b.length <= LOG_KEEP_HEAD + LOG_KEEP_TAIL) return m;
			var o = {};
			for (var kk in m) { if (Object.prototype.hasOwnProperty.call(m, kk)) o[kk] = m[kk]; }
			o.content = b.slice(0, LOG_KEEP_HEAD); o.elided = b.length - LOG_KEEP_HEAD;
			return o;
		}
		return m;
	});
}
/// `drawHistoryMessage`'s role dispatch: which drawing each role reaches. '' is "nothing drawn".
function oldDispatch(m) {
	if (m.role === 'user' && m.interject) return 'interjected';
	else if (m.role === 'user') return 'user';
	else if (m.role === 'assistant') return 'assistant';
	else if (m.role === 'error_log') return 'error';
	else if (m.role === 'note_log') return 'note';
	else if (m.role === 'fold_log') return 'compacted';
	else if (m.role === 'vision_log') return 'compacted';
	else if (m.role === 'think_log') return 'thinking';
	else if (m.role === 'leak_log') return 'leak';
	else if (m.role === 'end_log') return 'ending';
	else if (m.role === 'tool_log') return 'tool';
	return '';
}

// ── The data: §2.3's fixture and an ordinary transcript ────────────────
const FIX = JSON.parse(readFileSync(join(HERE, '..', '..', 'dev', 'fixtures', 'rating_u2.json'), 'utf8'));
const plain = () => [
	{ role: 'user',      mid: 'u-1', ts: 1790000000000, content: 'first question' },
	{ role: 'assistant', mid: 'a-1', ts: 1790000001000, content: 'first answer', prod: [] },
	{ role: 'end_log',   mid: 'e-1', ts: 1790000001500, content: '' },
	{ role: 'user',      mid: 'u-2', ts: 1790000050000, content: 'second question' },
	{ role: 'assistant', mid: 'a-2', ts: 1790000051000, content: 'second answer', prod: [] },
];
const fix = () => JSON.parse(J(FIX));
const only = (ms) => ms.filter((m) => m.role === 'rating_log');

/// The assertions, run against a merge. Returns nothing; counts into `failures`.
function suite(label, merge) {
	const base = plain(), rated = plain().concat(fix()), want = J(fix());
	// 1. a union with its own copy
	const self = merge(rated, JSON.parse(J(rated)), 'c1');
	check(`${label}: a union with its own copy keeps all three ratings, byte-identical`, J(only(self)) === want, J(only(self).map((m) => m.mid)));
	check(`${label}: and adds and loses nothing else (${rated.length} messages)`, self.length === rated.length, self.length + '');
	// 2. a union with a transcript that lacks them, in both orders
	const ab = merge(rated, base, 'c1'), ba = merge(base, rated, 'c1');
	check(`${label}: rated then bare: the ratings survive, byte-identical`, J(only(ab)) === want, only(ab).length + ' kept');
	check(`${label}: bare then rated: the ratings survive, byte-identical`, J(only(ba)) === want, only(ba).length + ' kept');
	check(`${label}: both orders give one and the same transcript`, J(ab) === J(ba), '');
	check(`${label}: the ratings sit after the turns they follow, in (ts, mid) order`, J(ab.map((m) => m.mid)) === J(['u-1', 'a-1', 'e-1', 'u-2', 'a-2'].concat(fix().map((m) => m.mid))), J(ab.map((m) => m.mid)));
	// 3. a peer that holds the ratings and a stale copy of the chat (the phone that never saw them)
	const half = merge(base.slice(0, 2), rated, 'c1');
	check(`${label}: a stale two-message copy merged with the rated chat ends with every message`, half.length === rated.length && J(only(half)) === want, half.length + ' of ' + rated.length);
	// 4. the same union twice is a fixed point
	const again = merge(ab, rated, 'c1');
	check(`${label}: merging the result again changes nothing`, J(again) === J(ab), '');
}

console.log('\n-- the r526 ports');
suite('r526 merge', mergeMessages);

console.log('\n-- slimMessages');
const f3 = fix(), s3 = slimMessages(f3);
check('slim: returned untouched, byte-identical and by identity', s3.every((m, i) => m === f3[i]) && J(s3) === J(fix()), '');
const longNote = fix(); longNote[1].rating.note = 'x'.repeat(8192);
const sl = slimMessages(longNote);
check('slim: even a note of the full 8192 bytes is not clipped', sl[1] === longNote[1] && sl[1].rating.note.length === 8192 && !('elided' in sl[1]), '');

console.log('\n-- the old dispatch');
check('dispatch: r526 draws nothing for any of the three ratings', fix().every((m) => oldDispatch(m) === ''), fix().map(oldDispatch).join(','));
check('dispatch: the port does draw what r526 draws (so "nothing" above is a finding and not a broken port)', plain().map(oldDispatch).join(',') === 'user,assistant,ending,user,assistant', plain().map(oldDispatch).join(','));

// ── 5.3.0: a files_log message and a v2 prod ──────────────────────────
const V2 = (h, k, via) => ({ h, k, m: 'glm-5.2', pv: 'fireworks', cm: 'glm', fam: 'glm', fi: false, cls: 'fast', role: 'daimon', sp: 'sp1:00ab12cd',
	d: 'd1', c: 'c1', t: 'u-2', dev: 'dev-a', at: 1790000051000, hash: k === 'file' ? 'h-3f2a' : '', run: '', via });
const FILES = () => [
	{ role: 'files_log', mid: 'f-1', ts: 1790000052000, prod: [V2('p1:file:chat:c1/v2/n.md', 'file', ''), V2('p1:file:chat:c1/v2/o.md', 'file', 'command')] },
];
const v2answer = () => ({ role: 'assistant', mid: 'a-3', ts: 1790000053000, content: 'third answer', prod: [V2('p1:answer:c1/a-3', 'answer', '')] });
const filesOnly = (ms) => ms.filter((m) => m.role === 'files_log');
function suite3(label, merge) {
	const base = plain(), full = plain().concat(FILES(), [v2answer()]), wantF = J(FILES()), wantA = J(v2answer());
	const self = merge(full, JSON.parse(J(full)), 'c1');
	check(`${label}: a union with its own copy keeps the files_log and the v2 answer, byte-identical`, J(filesOnly(self)) === wantF && J(self.find((m) => m.mid === 'a-3')) === wantA, J(self.map((m) => m.mid)));
	const ab = merge(full, base, 'c1'), ba = merge(base, full, 'c1');
	check(`${label}: full then bare: both survive, byte-identical`, J(filesOnly(ab)) === wantF && J(ab.find((m) => m.mid === 'a-3')) === wantA, filesOnly(ab).length + ' files_log kept');
	check(`${label}: bare then full: both survive, byte-identical`, J(filesOnly(ba)) === wantF && J(ba.find((m) => m.mid === 'a-3')) === wantA, filesOnly(ba).length + ' files_log kept');
	check(`${label}: both orders give one and the same transcript`, J(ab) === J(ba), '');
	check(`${label}: the files_log sits after the answer it follows and before the next`, J(ab.map((m) => m.mid)) === J(['u-1', 'a-1', 'e-1', 'u-2', 'a-2', 'f-1', 'a-3']), J(ab.map((m) => m.mid)));
	check(`${label}: merging the result again changes nothing`, J(merge(ab, full, 'c1')) === J(ab), '');
}
console.log('\n-- 5.3.0: files_log and a v2 prod through the r526 merge');
suite3('r526 merge', mergeMessages);
console.log('\n-- 5.3.0: slim and the old dispatch');
const f4 = FILES().concat([v2answer()]), s4 = slimMessages(f4);
check('slim: a files_log and a v2 answer come back whole, byte-identical and by identity', s4.every((m, i) => m === f4[i]) && J(s4) === J(FILES().concat([v2answer()])), '');
check('dispatch: r526 draws nothing for a files_log', FILES().every((m) => oldDispatch(m) === ''), FILES().map(oldDispatch).join(','));
check('dispatch: and draws the v2 answer as an answer', oldDispatch(v2answer()) === 'assistant', oldDispatch(v2answer()));
check('prod: every v2 record carries the 18 keys, via last', [...FILES()[0].prod, ...v2answer().prod].every((p) => Object.keys(p).length === 18 && Object.keys(p)[17] === 'via'), '');
let u3fix = null;
try { u3fix = JSON.parse(readFileSync(join(HERE, '..', '..', 'dev', 'fixtures', 'rating_u3.json'), 'utf8')); } catch (e) { u3fix = null; }
check('fixture: dev/fixtures/rating_u3.json (the page builder\'s own bytes, written by P1a) exists and holds a files_log', !!u3fix && JSON.stringify(u3fix).includes('files_log'), u3fix ? 'no files_log in it' : 'not there yet: P1a writes it');
if (u3fix) {
	const ms = Array.isArray(u3fix) ? u3fix : (u3fix.messages || []), want = J(ms), c = plain().concat(JSON.parse(want));
	const r1 = mergeMessages(c, plain(), 'c1'), r2 = mergeMessages(plain(), c, 'c1');
	check('fixture: its messages survive the r526 merge in both orders, byte-identical', J(r1.filter((m) => !plain().some((p) => p.mid === m.mid))) === J(r2.filter((m) => !plain().some((p) => p.mid === m.mid))) && r1.length === c.length, r1.length + ' of ' + c.length);
	check('fixture: slim passes them whole', slimMessages(JSON.parse(want)).every((m, i) => J(m) === J(ms[i])), '');
	check('fixture: and r526 draws nothing for its files_log', ms.filter((m) => m.role === 'files_log').every((m) => oldDispatch(m) === ''), '');
}

// ── 5.3.0 beside 5.2.10: pre, app, delta and file ratings ─────────────
// The 5.2.9 model projection, ported from `tailAfter` and the call that sends its result (`daimond.js` at ca22cb06, :32714 and :32638):
// a screen message the stored session does not account for is sent as its role and `content`, and nothing else.
function tailAfterOld(chat, sess) {
	var msgs = chat.messages || [];
	var from = -1;
	if (sess && sess.upto) {
		for (var i = 0; i < msgs.length; i++) {
			if (msgs[i] && msgs[i].mid === sess.upto) { from = i; break; }
		}
	}
	var tail = (from >= 0)
		? msgs.slice(from + 1)
		: msgs.filter(function (m) { return m && (m.ts || 0) > ((sess && sess.uptoTs) || 0); });
	return tail.filter(function (m) {
		return m && m.content && (m.role === 'user' || m.role === 'assistant');
	});
}
const sentOld = (chat, sess) => tailAfterOld(chat, sess).map((m) => [m.role, m.content || '']);
/// The mutant: a merge that rebuilds each message from the keys r526 knew, so any other key is lost on the way through. A
/// rating is carried whole (the ratings were never the question here) and a files_log keeps `prod`, so what this drops is exactly
/// the three keys 5.3.0 adds to old roles: a user message's `pre` and `app`, and a files_log's `delta`.
const R526_KEYS = ['role', 'content', 'mid', 'ts', 'prod', 'interrupted', 'why', 'provisional', 'framed', 'elided', 'interject', 'iturn'];
function mergeStrip(a, b, scope, tombs) {
	return mergeMessages(a, b, scope, tombs).map(function (m) {
		if (m.role === 'rating_log') return m;
		var o = {}, keep = R526_KEYS.concat(m.role === 'files_log' ? ['prod'] : []);
		keep.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(m, k)) o[k] = m[k]; });
		return o;
	});
}
const MIXED_AS_STRIP = process.argv.includes('--as-strip');

// The real ratings.js and provenance.js, in a bare window as ratings.test.mjs loads them: the 5.3.0 page's reading of the chat.
const RW = (() => {
	const win = {};
	for (const f of ['provenance.js', 'ratings.js']) new Function('window', readFileSync(join(HERE, f), 'utf8'))(win);
	return win.DaimondRatings;
})();
/// What a 5.3.0 page wrote into one chat, in the key order it writes it: the page builder's own `files_log` (with `delta`),
/// file rating and user message with `pre` (`rating_u3.json`), a rating of an answer, a preset (`app`, set after `ts` as
/// `pushUserRecord` does) and a rating of a file after it. The two ratings after the person's message are the ones the next
/// note tells, and the preset between them must not cut: that is the one thing here that reads `app` back.
const NEW530 = () => {
	const fx = JSON.parse(readFileSync(join(HERE, '..', '..', 'dev', 'fixtures', 'rating_u3.json'), 'utf8'));
	const fileRate = fx.find((m) => m.role === 'rating_log');
	const rate = (mid, ts, h, k, hash, sign) => {
		const r = JSON.parse(J(fileRate));
		r.mid = mid; r.ts = ts; r.rating.h = h; r.rating.hash = hash; r.rating.s = sign; r.rating.burst = mid;
		r.rating.tags = []; r.rating.note = ''; r.rating.dims = {};
		r.rating.prod = Object.assign({}, r.rating.prod, { h, k, hash, via: '' });
		return r;
	};
	return fx.concat([
		rate('r-mfq3c0e1-a2b3c', 1790000750000, 'p1:answer:c1/a-2', 'answer', '', 1),
		{ role: 'user', content: '@text Check the lexer tests.', mid: 'mfq3e-0-cdefg', iturn: 'mfq3e-0-cdefg', ts: 1790000800000, app: true },
		rate('r-mfq3c0e2-d4e5f', 1790000900000, 'p1:file:d-thesis/v4/code/lex.rs', 'file', 'ab'.repeat(32), -1),
	]).sort((x, y) => (x.ts - y.ts) || (x.mid < y.mid ? -1 : 1));
};
const KEYS530 = ['files_log', 'rating_log', 'user'];
/// Only the 5.3.0 page's own messages out of a transcript, by mid, so a union's other messages do not enter the byte compare.
const new530 = (ms) => ms.filter((m) => NEW530().some((n) => n.mid === m.mid));
function suite4(label, merge) {
	const mine = NEW530(), want = J(mine);
	const full = plain().concat(JSON.parse(want));
	// The 5.2.10 page: a stale copy of the chat (it never saw any of the above) with a turn of its own, made while the 5.3.0 page
	// was still on its files_log. It sorts before the person's message with `pre`, so it does not cut the note.
	const old = plain().concat([
		{ role: 'user',      mid: 'u-9', ts: 1790000100000, content: 'a question from the old page' },
		{ role: 'assistant', mid: 'a-9', ts: 1790000101000, content: 'its answer', prod: [] },
	]);
	const ab = merge(JSON.parse(J(old)), JSON.parse(J(full)), 'c1'), ba = merge(JSON.parse(J(full)), JSON.parse(J(old)), 'c1');
	check(`${label}: the old merge beside the new records keeps all ${mine.length}, byte-identical, in both orders`, J(new530(ab)) === want && J(new530(ba)) === want, new530(ab).length + ' of ' + mine.length + ' kept');
	check(`${label}: and the old page's own turn too, in one and the same transcript either way`, ab.length === full.length + 2 && J(ab) === J(ba), ab.length + ' messages');
	const keyed = (ms, role, k) => ms.filter((m) => m.role === role && Object.prototype.hasOwnProperty.call(m, k)).length;
	check(`${label}: pre, app and delta are still on the messages that held them`, keyed(ab, 'user', 'pre') === 1 && keyed(ab, 'user', 'app') === 1 && keyed(ab, 'files_log', 'delta') === 1,
		`pre ${keyed(ab, 'user', 'pre')}, app ${keyed(ab, 'user', 'app')}, delta ${keyed(ab, 'files_log', 'delta')}`);
	const preset = ab.find((m) => m.app === true);
	check(`${label}: the preset keeps \`app\` as its last key (the order the page wrote)`, !!preset && J(Object.keys(preset)) === J(['role', 'content', 'mid', 'iturn', 'ts', 'app']), preset ? '' : 'no message holds app');
	// The old page stores what it merged (slim) and sends it on; the new page merges that with its own copy again.
	const stored = slimMessages(ab), back = merge(JSON.parse(J(full)), JSON.parse(J(stored)), 'c1');
	check(`${label}: the old page's stored copy, slimmed, is byte-identical to the merge`, J(stored) === J(ab), '');
	check(`${label}: and the new page's merge with it holds its own records unchanged, and the chat is a fixed point`, J(new530(back)) === want && J(merge(JSON.parse(J(back)), JSON.parse(J(full)), 'c1')) === J(back), '');
	// The new page reads them back. `noteFor` is the real one: it names both ratings made after the person's message only if the
	// preset kept `app`, since a preset without it is read as the person's and cuts the note.
	const noteNew = RW.noteFor(full), noteBack = RW.noteFor(back);
	check(`${label}: the real noteFor on the old page's round trip is the one it gives the 5.3.0 page's own copy`, noteBack === noteNew && noteNew !== '', J(noteBack));
	check(`${label}: and it tells both ratings made after the person's message, the preset between them not cutting`,
		/^\[Daimond: the user rated your answer of .+ \+1\. They rated the change to code\/lex\.rs −1\.\]$/.test(noteBack), J(noteBack));
	const said = back.find((m) => m.mid === 'mfq3d-0-vwxyz'), pset = back.find((m) => m.mid === 'mfq3e-0-cdefg');
	check(`${label}: the person's message keeps its pre, and the preset keeps its mark and takes no note`,
		!!said && said.pre === NEW530().find((m) => m.mid === 'mfq3d-0-vwxyz').pre && !!pset && pset.app === true && pset.pre === undefined, '');
	// The 5.2.9 limit: what a runner on the old build sends of the new chat is each message's `content` and nothing more.
	const sess = { upto: 'a-1', uptoTs: 1790000001000 }, sent = sentOld({ messages: back }, sess);
	check(`${label}: an old runner's projection of the chat sends role and content only, so the note is not sent (plan 10.4)`,
		J(sent) === J([['user', 'second question'], ['assistant', 'second answer'], ['user', 'a question from the old page'], ['assistant', 'its answer'], ['user', 'Now fix the lexer.'], ['user', '@text Check the lexer tests.']])
		&& !J(sent).includes('[Daimond'), J(sent));
}
console.log('\n-- 5.3.0 beside 5.2.10: pre, app, delta, file ratings');
suite4(MIXED_AS_STRIP ? 'strip mutant' : 'r526 merge', MIXED_AS_STRIP ? mergeStrip : mergeMessages);
console.log('\n-- 5.3.0: the old dispatch draws a message with pre or app as a user message and the new roles as nothing');
check('dispatch: a user message with pre or app is drawn as the person\'s (its words, not its note)', NEW530().filter((m) => m.role === 'user').every((m) => oldDispatch(m) === 'user'), '');
check('dispatch: a files_log and a file rating draw nothing', NEW530().filter((m) => m.role !== 'user').every((m) => oldDispatch(m) === ''), '');
check('fixture: the 5.3.0 chat holds one each of files_log (with delta), a user with pre, a user with app, and two or more ratings of files and answers',
	J(Array.from(new Set(NEW530().map((m) => m.role))).sort()) === J(KEYS530.slice().sort())
	&& NEW530().filter((m) => m.role === 'files_log' && Array.isArray(m.delta) && m.delta.length).length === 1
	&& NEW530().filter((m) => m.role === 'user' && m.pre).length === 1 && NEW530().filter((m) => m.role === 'user' && m.app === true).length === 1
	&& NEW530().filter((m) => m.role === 'rating_log').length === 3, '');

console.log('\n-- the mutant: a merge that forgets roles it does not know');
const before = failures; quiet = true;
suite('mutant', mergeMutant);
const caught2a = failures - before; suite3('mutant', mergeMutant);
quiet = false;
const caught = failures - before;
failures = before;		// the mutant's failures are the point, not a failure of this file
check(`mutant: the same assertions FAIL against it (${caught2a} of 7 caught for the ratings, ${caught - caught2a} of 6 for files_log)`, caught2a >= 5 && caught - caught2a >= 4, caught2a + ' + ' + (caught - caught2a) + ' caught');
check('mutant: it drops the files_log (so the new assertions fail for the right reason)', filesOnly(mergeMutant(plain().concat(FILES()), plain(), 'c1')).length === 0, '');
check('mutant: it drops the ratings (so the assertions fail for the right reason)', only(mergeMutant(plain().concat(fix()), plain(), 'c1')).length === 0, '');
if (!MIXED_AS_STRIP) {
	const b4 = failures; quiet = true;
	suite4('strip', mergeStrip);
	quiet = false;
	const caught4 = failures - b4;
	failures = b4;
	check(`mutant: a merge that rebuilds each message from r526's keys FAILS the 5.3.0 section (${caught4} of 10 caught)`, caught4 >= 6, caught4 + ' caught');
	const stripped = mergeStrip(plain().concat(NEW530()), plain(), 'c1');
	check('mutant: it drops pre, app and delta (so those assertions fail for the right reason)',
		!stripped.some((m) => 'pre' in m) && !stripped.some((m) => 'app' in m) && stripped.filter((m) => m.role === 'files_log').every((m) => !('delta' in m)), '');
}

console.log(`\n${checks - failures} ok, ${failures} failed`);
process.exit(failures ? 1 : 0);
