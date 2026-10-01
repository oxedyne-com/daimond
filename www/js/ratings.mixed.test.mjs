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

   Run:  node www/js/ratings.mixed.test.mjs
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

console.log('\n-- the mutant: a merge that forgets roles it does not know');
const before = failures; quiet = true;
suite('mutant', mergeMutant);
quiet = false;
const caught = failures - before;
failures = before;		// the mutant's failures are the point, not a failure of this file
check(`mutant: the same assertions FAIL against it (${caught} of 7 caught)`, caught >= 5, caught + ' caught');
check('mutant: it drops the ratings (so the assertions fail for the right reason)', only(mergeMutant(plain().concat(fix()), plain(), 'c1')).length === 0, '');

console.log(`\n${checks - failures} ok, ${failures} failed`);
process.exit(failures ? 1 : 0);
