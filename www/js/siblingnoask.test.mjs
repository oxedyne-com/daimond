/* ============================================================
   Test -- a sibling tab draws the asking tab's message with its reply
   (SIBLING-NOASK, UNBLOCK-121; runner-b t29b walk, step 4).
   ------------------------------------------------------------
   Two tabs on one Diamond share one IndexedDB (the real ChatStore over
   test/fakeidb.mjs). Tab A sends a turn that runs on Kimberlite, and its
   store has stopped committing (the walk's 03:13:38), so its ask never
   reaches the store or a push. Tab B loads the chat from the store and
   folds the turn's log (the real page/turnlog.js over the real wasm row
   codec). Before the fix the log carried the reply alone, and B drew it
   as a second answer to its own earlier ask.

   Now tab A's errand (the real peer.js `buildDispatch`/`makeErrand`)
   carries the turn's own message as `msg`, and Kimberlite logs it as the
   turn's first row (its half, `msg_body` and the poster, is held by
   kimberlite/tests/errand_settle.rs `test_siblingnoask_*`). The rows here
   are what that poster writes from the errand: the ask from `msg` with the
   prompt as its words, then the reply, then the end.

     NOASK   B's stored transcript lacks A's ask (the stall)
     MSG     A's errand carries its message: no `_` field, no second copy
             of the words, the asker's own fields kept, its own words kept
             where they differ from the prompt
     FOLD    B shows the ask, with its fields, before the reply, each once
     OLD     an older page's errand (no `msg`) is unchanged: no key

     node www/js/siblingnoask.test.mjs

   Needs www/pkg (dev/build-wasm.sh --no-opt).
   ============================================================ */
import { readPage } from '../../dev/pagesrc.mjs';
import { makeWindow, loadScript } from '../../dev/syncprobe.mjs';
import { loadPage } from './test/page.mjs';
import { fakeIdb } from './test/fakeidb.mjs';
import { loadSeal, installSeal } from './sealfixture.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + JSON.stringify(detail) + ')' : '')); failures++; }
}

const NOW = 1_000_000_000;
const wasm = await loadSeal();
const seal = installSeal({});
const TL = await import('./page/turnlog.js');

/// A tab running the real ChatStore over the IndexedDB `data`.
function storeTab(data) {
	const w = makeWindow({ now: NOW });
	w.indexedDB = fakeIdb(data, { n: 0, open: 0 }); w.IDBKeyRange = { bound: (lower, upper) => ({ lower, upper }) };
	w.setTimeout = setTimeout; w.clearTimeout = clearTimeout;
	loadScript(w, 'trash.js');	// DaimondPolicy: storewait.js bounds each wait by its storeWaitMs
	loadScript(w, 'storewait.js');	// ChatStore opens through it, as index.html loads it before the page
	return loadPage({ window: w, want: ['ChatStore'], stub: { t: (k) => k, tOr: (k, d) => d,
		noteCloudIndexStuck() {}, storageAlarm() {}, storageAlarmClear() {} } }).ChatStore;
}

/// The real peer.js, whole.
function peer() {
	const pw = { addEventListener() {}, dispatchEvent() { return true; } };
	new Function('window', 'document', 'with (window) {\n' + readPage(new URL('./peer.js', import.meta.url), 'utf8') + '\n}')(
		pw, { addEventListener() {} });
	return pw.DaimondPeer;
}

let seq = 0;
function wire(turn, n, kind, body) {
	const head = { seq: ++seq, turn, n, kind, member: 'acct', daimon: 'D1', at: NOW + 100 + seq, len: 0 };
	const plain = wasm.row_seal(JSON.stringify(head), JSON.stringify(body));
	return JSON.parse(wasm.row_wire(JSON.stringify(head), plain));
}

/// The rows Kimberlite's poster writes for errand `e` (settle.rs `msg_body`, logpost.rs): the
/// turn's own message first where the errand carries one, its words the prompt, then the reply.
function kimberliteRows(e) {
	const rows = [];
	let n = 1;
	const m = e.msg;
	if (m && m.mid === e.turnId && m.role === 'user') {
		const meta = {};
		Object.keys(m).forEach((k) => { if (!['mid', 'role', 'content', 'whole'].includes(k)) meta[k] = m[k]; });
		rows.push(wire(e.turnId, n++, 'msg', { mid: m.mid, role: 'user', text: 'content' in m ? m.content : e.prompt,
			meta: Object.keys(meta).length ? meta : undefined }));
	}
	rows.push(wire(e.turnId, n++, 'msg', { mid: e.turnId + '-a', role: 'assistant', text: 'the runner\'s reply' }));
	rows.push(wire(e.turnId, n++, 'end', { status: 'done', totals: null, alerts: [], undo: null, tried: ['kim'] }));
	return rows;
}

const P = peer();
const earlier = [
	{ mid: 's1', role: 'user', content: 'the sibling asked first', ts: NOW - 500 },
	{ mid: 's1-a', role: 'assistant', content: 'its answer', ts: NOW - 400 },
];
const ask = { mid: 'T2', role: 'user', content: 'the asking tab asks', ts: NOW - 100, effort: 'high', _pending: 1 };

const data = new Map();
const A = storeTab(data), B = storeTab(data);
await A.boot();
A.save([{ id: 'c1', diamondId: 'D1', name: 'D1', updatedAt: NOW - 400, metaAt: 1, messages: earlier.slice(), _loaded: true }]);
await A.settled();
// Tab A's store has stopped committing: its ask lives in its memory only.
const chatA = { id: 'c1', diamondId: 'D1', _loaded: true, messages: earlier.concat([ask]) };

await B.boot();
const got = await B.loadMessages('c1');
const chatB = { id: 'c1', diamondId: 'D1', _loaded: true, messages: (got && got.messages || []).slice() };
check('NOASK B\'s transcript holds the earlier turn', chatB.messages.map((m) => m.mid).join() === 's1,s1-a',
	chatB.messages.map((m) => m.mid));
check('NOASK and not A\'s ask', !chatB.messages.some((m) => m.mid === 'T2'));

const e = P.buildDispatch(chatA, { turnId: 'T2', prompt: ask.content, now: NOW }).errand(0);
check('MSG the errand carries the turn\'s own message', !!e.msg && e.msg.mid === 'T2' && e.msg.role === 'user', e.msg);
check('MSG its words go once, as the prompt', !!e.msg && !('content' in e.msg) && e.prompt === ask.content, e.msg);
check('MSG no local field leaves the device', !!e.msg && !('_pending' in e.msg), e.msg);
check('MSG the asker\'s own fields are kept', !!e.msg && e.msg.effort === 'high' && e.msg.ts === ask.ts, e.msg);
check('MSG it survives makeErrand again', JSON.stringify(P.makeErrand(e).msg) === JSON.stringify(e.msg));
// The prompt can differ from the words the chat holds; then the message keeps its own (QA P1).
const typed = { mid: 'T4', role: 'user', content: 'his words as he typed them', ts: NOW - 50 };
const e4 = P.buildDispatch({ id: 'c1', diamondId: 'D1', _loaded: true, messages: earlier.concat([typed]) },
	{ turnId: 'T4', prompt: 'the prompt the dispatch sends', now: NOW }).errand(0);
check('MSG words that differ from the prompt are kept', !!e4.msg && e4.msg.content === typed.content, e4.msg);

const log = kimberliteRows(e);
const door = (since) => {
	const out = log.filter((r) => r.seq > since);
	return { ok: true, rows: out, head: log[log.length - 1].seq, low: 0, more: false };
};
const isTile = (m, t) => m.why === 'dispatched' && String(m.iturn) === String(t);
const { liftSource } = await import('../../dev/syncprobe.mjs');
const law = new Function([
	'function loadMsgTombs() { return {}; }',
	'var DaimondStamp = (function () { var window = {}; ' + readPage(new URL('./stamp.js', import.meta.url), 'utf8')
		+ '\n return window.DaimondStamp; })();',
	liftSource(['msgJoin'], ['loadMsgTombs', 'window', 'DaimondStamp']).src,
	'return { msgJoin: msgJoin };',
].join('\n'))();
await TL.readChat(chatB, { seal, unwrap: async (b) => b, join: law.msgJoin, isTile, onEnd() {},
	read: async (_id, since) => door(since) });
const ids = chatB.messages.map((m) => m.mid);
check('FOLD B shows the ask before the reply', ids.join() === 's1,s1-a,T2,T2-a', ids);
const drawn = chatB.messages.find((m) => m.mid === 'T2') || {};
check('FOLD the ask reads as A wrote it', drawn.role === 'user' && drawn.content === ask.content && drawn.effort === 'high',
	drawn);
check('FOLD each message once', new Set(ids).size === ids.length, ids);

const old = P.makeErrand({ turnId: 'T3', chatId: 'c1', prompt: 'x' });
check('OLD an errand built with no message has no msg key', !('msg' in old));

console.log('\n' + (checks - failures) + '/' + checks + ' checks passed');
if (failures) process.exit(1);
