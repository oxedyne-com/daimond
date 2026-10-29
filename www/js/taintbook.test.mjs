/* ============================================================
   taintbook.test.mjs — a chat's taint is ONE-WAY and DURABLE (H3 TAINT-DURABLE, CCPARITY R1)

   WHAT IS CHECKED. A conversation that has read outside content (a web page, a fetched file)
   is tainted, and the engine then refuses to send what it holds anywhere on its own. The
   engine's flag lives in memory, so the RECORD carries it as `taintedAt` (H3's `tainted_at`):
   the earliest time the conversation read outside content, absent while it never has.
   Four arms, each on the REAL code lifted from daimond.js and stamp.js
   (`dev/syncprobe.mjs` `sliceDaimond`):

     (a) reload  — `slimChat` -> JSON -> `hydrateChat` keeps the stamp, a clean record travels
                   without the key, and `applyChatTaint` puts it on an engine built for the chat;
                   `ensureApp` calls it on every engine it builds.
     (b) merge   — `mergeChatRecords` keeps the stamp from either side, in either order, even
                   when the clean side wins both the turn and the metadata stamps; two stamps
                   keep the earlier. The tab adoption joins it the same way and tells the engine.
     (c) trip    — `keepChatTaint` copies a tainted engine's verdict onto the record, never
                   clears it, and `captureSession` does that before anything can return.
     (d) laws    — `DaimondStamp.taint` is a monotone OR: set beats unset, the earlier stamp
                   wins, and it is commutative, associative and idempotent.

   RED on e1f2866d4 (none of the functions exist there): run with TREE=<that checkout>.
   BREAKS, each on a patched copy of the tree, each turning its arm red:
     node www/js/taintbook.test.mjs --break merge    # mergeChatRecords drops the loser's taint
     node www/js/taintbook.test.mjs --break reload   # hydrateChat forgets the taint
     node www/js/taintbook.test.mjs --break trip     # keepChatTaint never marks the record

   Run:  node www/js/taintbook.test.mjs
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── The breaks: a patched copy of the tree, selected before syncprobe reads TREE. ──
const BREAKS = {
	merge:  ['\t\tchatTaintJoin(out, a, b);\n', '\n'],
	reload: ['taintedAt: chatTaintOf(c) || undefined };', 'taintedAt: undefined };'],
	trip:   ['return t ? markChatTainted(c) : false;', 'return false;'],
};
const bi = process.argv.indexOf('--break');
const BREAK = bi >= 0 ? process.argv[bi + 1] : '';
if (BREAK && !BREAKS[BREAK]) { console.error('unknown break ' + JSON.stringify(BREAK) + '; known: ' + Object.keys(BREAKS).join(', ')); process.exit(2); }
let scratch = '';
if (BREAK) {
	const from = process.env.TREE || join(HERE, '..', '..');
	scratch = mkdtempSync(join(tmpdir(), 'taintbook-break-'));
	mkdirSync(join(scratch, 'www', 'js'), { recursive: true });
	for (const f of ['stamp.js', 'store.js']) if (existsSync(join(from, 'www', 'js', f))) copyFileSync(join(from, 'www', 'js', f), join(scratch, 'www', 'js', f));
	const src = readPage(join(from, 'www', 'js', 'daimond.js'), 'utf8');
	const [a, b] = BREAKS[BREAK];
	if (!src.includes(a)) { console.error('break ' + BREAK + ': the line to patch is not in daimond.js'); process.exit(2); }
	writeFileSync(join(scratch, 'www', 'js', 'daimond.js'), src.replace(a, b));
	process.env.TREE = scratch;
	process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
	console.log('BREAK ' + BREAK + ' (a patched copy of the tree)');
}
const { makeWindow, rng, TREE } = await import('../../dev/syncprobe.mjs');
const { loadPage } = await import('./test/page.mjs');
const APP = readPage(join(TREE, 'www', 'js', 'daimond.js'), 'utf8');

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}
/// Lift `names` from the tree, or answer the reason it cannot (the functions are absent before R1).
function lift(win, names, stub) {
	try { return loadPage({ window: win, want: names, stub: stub }); }
	catch (e) { check('the tree has ' + names.join(', '), false, String(e && e.message || e)); return null; }
}
/// The body of `function name(...) { ... }` in the tree, by counting braces ('' when absent).
function fnSrc(name) {
	const m = new RegExp('\\n\\t+(async )?function ' + name + '\\(').exec(APP);
	if (!m) return '';
	const brace = APP.indexOf('{', m.index + 1);
	let depth = 0, i = brace;
	for (; i < APP.length; i++) {
		if (APP[i] === '{') depth++;
		else if (APP[i] === '}') { depth--; if (depth === 0) { i++; break; } }
	}
	return APP.slice(m.index + 1, i);
}
/// A stand-in engine that records what it was told.
const engine = (tainted) => {
	const e = { told: 0, tainted: !!tainted };
	e.set_tainted = () => { e.told++; e.tainted = true; };
	e.is_tainted = () => e.tainted;
	return e;
};
const NOW = 1_000_000_000;

console.log('\n(a) reload: the record keeps the taint, and a rebuilt engine starts tainted\n');
{
	const w = makeWindow({ now: NOW });
	const F = lift(w, ['slimChat', 'hydrateChat', 'applyChatTaint'], { loadMsgTombs: () => ({}) });
	if (F) {
		const back = (c) => F.hydrateChat(JSON.parse(JSON.stringify(F.slimChat(c))));
		const t = back({ id: 'c1', name: 'Plan', updatedAt: 5, metaAt: 5, taintedAt: 42 });
		check('slimChat -> JSON -> hydrateChat keeps taintedAt', t.taintedAt === 42, t.taintedAt);
		const clean = F.slimChat({ id: 'c1', name: 'Plan', updatedAt: 5, metaAt: 5 });
		check('a clean record travels without the key (the push-skip fixed point)', !('taintedAt' in clean), Object.keys(clean));
		check('a clean record reloads clean', !back({ id: 'c1', updatedAt: 5, metaAt: 5 }).taintedAt);
		const e = engine(false);
		check('applyChatTaint tells the engine built for a tainted record', F.applyChatTaint(t, e) === true && e.told === 1 && e.tainted, e.told);
		const e2 = engine(false);
		check('applyChatTaint leaves the engine of a clean record alone', F.applyChatTaint(back({ id: 'c2', updatedAt: 1 }), e2) === false && e2.told === 0);
	}
	const ea = fnSrc('ensureApp');
	check('ensureApp puts the record\'s taint on every engine it builds', /\n\t\tapplyChatTaint\(chat, chat\.app\);/.test(ea));
	check('ensureApp keeps the old engine\'s verdict before a model switch drops it',
		ea.indexOf('keepChatTaint(chat, chat.app)') >= 0 && ea.indexOf('keepChatTaint(chat, chat.app)') < ea.indexOf('chat.app = null'));
}

console.log('\n(b) merge: the taint survives either side and either order\n');
{
	const w = makeWindow({ now: NOW });
	const F = lift(w, ['mergeChatRecords', 'slimChat'], { loadMsgTombs: () => ({}) });
	if (F) {
		const M = (a, b) => F.mergeChatRecords(structuredClone(a), structuredClone(b), { localMsgs: [], remoteMsgs: [] });
		const set = { id: 'c1', name: 'Plan', updatedAt: 100, metaAt: 100, taintedAt: 50 };
		const fresh = { id: 'c1', name: 'Plan 2', updatedAt: 200, metaAt: 300 };	// wins both stamps, never tainted
		check('merge(tainted, clean) is tainted', M(set, fresh).taintedAt === 50, M(set, fresh).taintedAt);
		check('merge(clean, tainted) is tainted', M(fresh, set).taintedAt === 50, M(fresh, set).taintedAt);
		check('...and the clean side still wins the fields it won', M(set, fresh).name === 'Plan 2' && M(fresh, set).name === 'Plan 2');
		const later = Object.assign({}, fresh, { taintedAt: 150 });
		check('two stamps keep the earlier, in either order', M(set, later).taintedAt === 50 && M(later, set).taintedAt === 50);
		check('two clean records merge clean, without the key', !('taintedAt' in M(fresh, { id: 'c1', updatedAt: 1 })));
		const r = rng(0x7a17);
		let held = 0; const N = 500;
		for (let i = 0; i < N; i++) {
			const a = { id: 'c1', updatedAt: r.pick([0, 100, 200]), metaAt: r.pick([0, 100, 200]), name: r.pick(['', 'A', 'B']) };
			const b = { id: 'c1', updatedAt: r.pick([0, 100, 200]), metaAt: r.pick([0, 100, 200]), name: r.pick(['', 'A', 'B']) };
			const ta = r.pick([0, 0, 30, 90]), tb = r.pick([0, 0, 30, 90]);
			if (ta) a.taintedAt = ta; if (tb) b.taintedAt = tb;
			const want = ta && tb ? Math.min(ta, tb) : (ta || tb || undefined);
			if (M(a, b).taintedAt === want && M(b, a).taintedAt === want) held++;
		}
		check('on ' + N + ' generated pairs, the merge is the earlier set stamp, both orders', held === N, held + '/' + N);
	}
	// The tab adoption, lifted from the tree: the block that updates `c` from the store's `s`.
	const at = APP.indexOf('var sMeta = (typeof s.metaAt');
	const end = APP.indexOf('return c;', at);
	const block = at >= 0 && end > at ? APP.slice(at, end) : '';
	check('the tab adoption joins the taint under no guard and tells the engine',
		/\n\t+if \(chatTaintJoin\(c, s, c\) && c\.app\) applyChatTaint\(c, c\.app\);/.test(block));
	const G = lift(makeWindow({ now: NOW }), ['chatTaintJoin', 'applyChatTaint', 'hereOf', 'nativeJoin', 'deriveNativeTotals']);	// and the derived totals (RT-C)
	if (G && block) {
		const has = (n) => new RegExp('\\n\\t+function ' + n + '\\(').test(APP);
		const extra = ['chatMetaBeats', 'chatTurnBeats', 'takeChatMeta', 'chatMetaFields', 'takeChatModel'].filter(has);
		const H = lift(makeWindow({ now: NOW }), ['slimChat', 'chatFields'].concat(extra), { loadMsgTombs: () => ({}) });
		if (H) {
			const ADOPT = new Function('s', 'c', 'DaimondStamp', 'slimChat', 'chatFields', 'CHAT_TURN_FIELDS', 'CHAT_META_FIELDS',
				'chatTaintJoin', 'applyChatTaint', 'hereOf', 'nativeJoin', 'deriveNativeTotals', ...extra, block + '\nreturn c;');
			const w2 = makeWindow({ now: NOW });
			const e = engine(false);
			const c = { id: 'c1', name: 'Plan', updatedAt: 300, metaAt: 300, _generating: true, app: e };	// a turn in flight here
			const s = H.slimChat({ id: 'c1', name: 'Old', updatedAt: 100, metaAt: 100, taintedAt: 70 });
			const out = ADOPT(s, c, w2.DaimondStamp, H.slimChat, H.chatFields, [], [], G.chatTaintJoin, G.applyChatTaint, G.hereOf, G.nativeJoin, G.deriveNativeTotals, ...extra.map((n) => H[n]));
			check('the adoption takes an older store copy\'s taint, mid-turn', out.taintedAt === 70, out.taintedAt);
			check('...and tells the engine this tab holds at once', e.told === 1 && e.tainted, e.told);
		}
	}
}

console.log('\n(c) trip: the engine\'s verdict lands on the record, one-way\n');
{
	const w = makeWindow({ now: NOW });
	const F = lift(w, ['keepChatTaint']);
	if (F) {
		const c = { id: 'c1' };
		check('a tainted engine marks its record', F.keepChatTaint(c, engine(true)) === true && c.taintedAt === NOW, c.taintedAt);
		const d = { id: 'c1', taintedAt: 7 };
		check('a record already marked keeps its earlier stamp', F.keepChatTaint(d, engine(true)) === false && d.taintedAt === 7, d.taintedAt);
		const e = { id: 'c1', taintedAt: 7 };
		check('a clean engine never clears a mark', F.keepChatTaint(e, engine(false)) === false && e.taintedAt === 7, e.taintedAt);
		const f = { id: 'c1' };
		check('a clean engine leaves a clean record clean', F.keepChatTaint(f, engine(false)) === false && !('taintedAt' in f));
		check('an engine without is_tainted, or none, changes nothing', F.keepChatTaint(f, {}) === false && F.keepChatTaint(f, null) === false && !('taintedAt' in f));
	}
	const cs = fnSrc('captureSession');
	check('captureSession keeps the verdict FIRST, before anything can return',
		/^function captureSession\(chat, app, back\) \{(\s*\/\/[^\n]*)*\s*keepChatTaint\(chat, app\);/.test(cs.replace(/^\t+/, '')));
}

console.log('\n(d) DaimondStamp.taint is a monotone OR\n');
{
	const S = makeWindow({ now: NOW }).DaimondStamp;
	const T = S && S.taint;
	check('stamp.js has DaimondStamp.taint', typeof T === 'function');
	if (typeof T === 'function') {
		check('unset with unset is 0', T(undefined, 0) === 0 && T(null, -5) === 0 && T('x', NaN) === 0);
		check('set beats unset, in either order', T(40, undefined) === 40 && T(0, 40) === 40);
		check('two set stamps keep the earlier', T(40, 90) === 40 && T(90, 40) === 40);
		const r = rng(0x0a7b);
		const V = [undefined, null, 0, -1, 10, 20, 20.7, 'x'];
		let comm = 0, assoc = 0, idem = 0; const N = 2000;
		for (let i = 0; i < N; i++) {
			const a = r.pick(V), b = r.pick(V), c = r.pick(V);
			if (T(a, b) === T(b, a)) comm++;
			if (T(T(a, b), c) === T(a, T(b, c))) assoc++;
			if (T(T(a, b), T(a, b)) === T(a, b) && T(T(a, b), a) === T(a, b)) idem++;
		}
		check('commutative', comm === N, comm + '/' + N);
		check('associative', assoc === N, assoc + '/' + N);
		check('idempotent, and a join absorbs its inputs', idem === N, idem + '/' + N);
	}
}

console.log('\n' + checks + ' checks, ' + failures + ' failed' + (BREAK ? ' (BREAK ' + BREAK + ')' : ''));
process.exit(failures ? 1 : 0);
