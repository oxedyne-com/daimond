/* ============================================================
   Test — the transcript law at the sync door (DL-2, 2026-09-27).

   THE BUG. `applyChats` (www/js/daimond.js) checked a chat's transcript
   only by accident: a chat this device already held was unioned, and the
   union's `forEach` threw on a transcript that was not a list, which
   refused the whole `chats` section. A chat it had NEVER held was adopted
   as sent. `[null]` was stored and reported merged; every later pull from
   the same sender then failed `chats`, so sync.js stopped pushing this
   device's own work; and once the chat was opened, `ChatStore.write`'s
   union threw inside an IndexedDB handler and aborted every save. A string
   was not stored, but its write threw half way down the list, so every new
   chat after it in the parcel never landed and a false alarm stood.

   THE FIX. One law, `transcriptOk`: a transcript is absent or a list of
   message records. `applyChats` applies it to every chat after its
   reference is resolved, held or new, and refuses the chat alone, naming
   it in `refused` so the rest of the parcel lands and sync.js adopts the
   version. The same law guards the backup restore, the old localStorage
   migration (`mergeInto`) and `ChatStore.write` (browser-proved by
   dev/verify_transcriptlaw.mjs, which needs IndexedDB).

   `applyChats` runs here AS WRITTEN, lifted out of daimond.js by source
   (`dev/syncprobe.mjs` `sliceDaimond`), with the store, the chunk store and
   the UI stubbed.

   Run:  node www/js/transcriptlaw.test.mjs
         node www/js/transcriptlaw.test.mjs --break nolaw    # the law off: base behaviour
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BREAK = (() => {
	const i = process.argv.indexOf('--break');
	return i >= 0 ? String(process.argv[i + 1] || '') : '';
})();
if (BREAK && BREAK !== 'nolaw') { console.error('unknown break ' + BREAK + '; one of: nolaw'); process.exit(2); }

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}

const msg = (mid, role, content, ts) => ({ mid, role, content, ts });
const GOOD = [msg('g1', 'user', 'hello from elsewhere', 10), msg('g2', 'assistant', 'hi', 11)];
const MINE = [msg('m1', 'user', 'mine', 1), msg('m2', 'assistant', 'mine back', 2), msg('m3', 'user', 'more', 3)];

// Every shape that is not a transcript, and the partial shapes that are.
const BAD = {
	nullElem:   [null],
	numElem:    [5],
	strElem:    ['x'],
	listElem:   [[]],
	mixed:      [msg('x1', 'user', 'readable', 5), null],
	string:     'not-a-list',
	object:     { 0: msg('x2', 'user', 'array-like', 6) },
	number:     42,
	boolean:    true,
};
const PARTIAL = { absent: undefined, null: null, empty: [], good: GOOD };

/// A fresh world: one stored chat of this device's own, and applyChats lifted with its
/// store, chunk store and UI stubbed. Answers the harness and what it recorded.
function world(opts) {
	opts = opts || {};
	const w = makeWindow({});
	const rec = { saved: null, peer: [], trail: [], contentSet: [] };
	const stored = [{ id: 'own', name: 'own', messages: [], msgCount: MINE.length, _loaded: false,
		updatedAt: 100, metaAt: 100 }];
	const ChatStore = {
		vouched: () => true,
		booted: async () => {},
		putTombs: async () => true,
		stored: () => (rec.saved || stored).slice(),
		loadMessages: async (id) => ({ messages: id === 'own' ? JSON.parse(JSON.stringify(MINE)) : [], session: null }),
		save: (list) => { rec.saved = list; },
		sweepTombs: async () => false,
	};
	w.DaimondChunks = { materialiseBytes: async () => opts.bytes === undefined ? null : new TextEncoder().encode(opts.bytes) };
	w.DaimondCloud = {
		contentGet: () => null,
		contentSet: (k, v) => { rec.contentSet.push(k); return true; },
	};
	const stub = {
		ChatStore,
		notePeerRef: (key, carried, adopted, from) => { rec.peer.push({ key, carried: !!carried, adopted }); },
		onChatsChangedElsewhere: () => {},
		DaimondMarksHere: { chatSettle: () => false, chatDropAll: () => {} },
		dropChatApp: () => {},
		trail: (w2, d) => { rec.trail.push(w2 + ' | ' + d); },
		diag: () => {},
		fileHash: (s) => 'h' + String(s).length,
	};
	if (BREAK === 'nolaw') {
		stub.transcriptOk = () => true;			// the base: nothing is checked
		stub.chatIdOk = (id) => !!id;
	}
	const { fns } = sliceDaimond(w, ['applyChats'], stub);
	return { applyChats: fns.applyChats, rec };
}

async function apply(h, chats) {
	let threw = '', got = null;
	try { got = await h.applyChats({ chats: JSON.parse(JSON.stringify(chats)), tombs: {}, msgTombs: {} }, 'dev-a'); }
	catch (e) { threw = String((e && e.message) || e); }
	const out = {};
	(h.rec.saved || []).forEach((c) => { if (c && c.id) out[c.id] = c; });
	return { threw, refused: (got && got.refused) || [], out };
}
const count = (c) => (c && Array.isArray(c.messages)) ? c.messages.length : -1;

console.log('transcriptlaw: a transcript is a list of message records or absent, at the sync door\n');

// ── A NEW chat that is not a transcript is refused alone; the good chat behind it lands ──
for (const [shape, bad] of Object.entries(BAD)) {
	const h = world();
	const r = await apply(h, [
		{ id: 'x-' + shape, name: 'X', messages: bad, messagesRef: null, updatedAt: 200, metaAt: 200 },
		{ id: 'y-' + shape, name: 'Y', messages: GOOD, messagesRef: null, updatedAt: 200, metaAt: 200 },
	]);
	check(shape + ': a new chat carrying it is refused, not stored',
		r.threw === '' && !r.out['x-' + shape] && r.refused.indexOf('x-' + shape) !== -1,
		'threw=' + r.threw + ' stored=' + !!r.out['x-' + shape] + ' refused=' + JSON.stringify(r.refused));
	check(shape + ':   and the good new chat after it lands whole',
		count(r.out['y-' + shape]) === 2, 'y=' + count(r.out['y-' + shape]));
	check(shape + ':   and this device\'s own chat is untouched',
		!!r.out.own && r.out.own.msgCount === MINE.length, JSON.stringify(r.out.own || null).slice(0, 80));
}

// ── A HELD chat arriving as one is refused alone: this device's copy stands ──
for (const [shape, bad] of Object.entries(BAD)) {
	const h = world();
	const r = await apply(h, [
		{ id: 'own', name: 'renamed there', messages: bad, messagesRef: null, updatedAt: 900, metaAt: 900 },
		{ id: 'y-' + shape, name: 'Y', messages: GOOD, messagesRef: null, updatedAt: 200, metaAt: 200 },
	]);
	check(shape + ': a held chat carrying it is refused, and the merge does not throw',
		r.threw === '' && r.refused.indexOf('own') !== -1,
		'threw=' + r.threw + ' refused=' + JSON.stringify(r.refused));
	check(shape + ':   and the good chat beside it still lands', count(r.out['y-' + shape]) === 2);
}

// ── Partial transcripts are transcripts: merged, never refused, never shortening ──
for (const [shape, msgs] of Object.entries(PARTIAL)) {
	const h = world();
	const r = await apply(h, [
		{ id: 'own', name: 'own', messages: msgs, messagesRef: null, updatedAt: 150, metaAt: 150 },
		{ id: 'n-' + shape, name: 'N', messages: msgs, messagesRef: null, updatedAt: 200, metaAt: 200 },
	]);
	check(shape + ' (partial): merged into the held chat, refused nowhere, shortening nothing',
		r.threw === '' && r.refused.length === 0 && count(r.out.own) >= MINE.length,
		'threw=' + r.threw + ' refused=' + JSON.stringify(r.refused) + ' own=' + count(r.out.own));
	check(shape + ' (partial):   and a new chat carrying it lands with a list',
		Array.isArray(r.out['n-' + shape] && r.out['n-' + shape].messages)
			&& count(r.out['n-' + shape]) === (Array.isArray(msgs) ? msgs.length : 0),
		'n=' + count(r.out['n-' + shape]));
}

// ── A REFERENCE that resolves to something that is not a transcript ──
{
	const h = world({ bytes: '[null]' });
	const ref = { v: 1, size: 6, key: 'k-ref', chunks: [{ addr: 'a1', size: 6 }] };
	const r = await apply(h, [{ id: 'x-ref', name: 'X', messagesRef: ref, updatedAt: 200, metaAt: 200 }]);
	check('a new chat whose reference resolves to [null] is refused, not stored',
		r.threw === '' && !r.out['x-ref'] && r.refused.indexOf('x-ref') !== -1,
		'threw=' + r.threw + ' refused=' + JSON.stringify(r.refused));
	check('  and its sender\'s chunks are not claimed as this device\'s own',
		h.rec.contentSet.indexOf('@c/x-ref') === -1, JSON.stringify(h.rec.contentSet));
	const p = h.rec.peer.find((x) => x.key === '@c/x-ref');
	check('  but stay declared live in the sender\'s slot, so no commit sweeps them',
		!!p && p.carried === true && p.adopted === false, JSON.stringify(p || null));
}

// ── An id that is not a plain chat id is refused before anything reads it ──
for (const id of ['a#b', 'a/b', 'a\\b', '..', 5]) {
	const h = world();
	const r = await apply(h, [
		{ id, name: 'bad id', messages: GOOD, messagesRef: null, updatedAt: 200, metaAt: 200 },
		{ id: 'y-id', name: 'Y', messages: GOOD, messagesRef: null, updatedAt: 200, metaAt: 200 },
	]);
	check('id ' + JSON.stringify(id) + ' is refused and the good chat beside it lands',
		r.threw === '' && !r.out[String(id)] && count(r.out['y-id']) === 2 && r.refused.length === 1,
		'threw=' + r.threw + ' stored=' + !!r.out[String(id)] + ' refused=' + JSON.stringify(r.refused));
}

// ── The other doors and the store, held to their source (the browser verifier runs them) ──
if (!BREAK) {
	const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
	const syncSrc = readFileSync(join(HERE, 'sync.js'), 'utf8');
	const restoreAt = src.indexOf("trail('restore chat REFUSED'");
	check('the backup restore applies the same law before it adopts or merges a chat',
		restoreAt > 0 && src.lastIndexOf('!transcriptOk(r.messages)', restoreAt) > src.lastIndexOf('for (var di = 0; di < data.chats.length; di++)', restoreAt));
	check('the old localStorage migration (`mergeInto`) applies it to both sides',
		/function mergeInto\(base, incoming\) \{[\s\S]{0,900}!transcriptOk\(c\.messages\)[\s\S]{0,700}!transcriptOk\(st\.messages\)/.test(src));
	check('the store\'s union handler catches, so it cannot abort the transaction',
		/g\.onsuccess = function \(\) \{\s*try \{\s*var old = g\.result;\s*if \(old && !transcriptOk\(old\.messages\)\)/.test(src));
	check('and a transcript in hand that is not one never reaches the row',
		/appendChunks\(mcS, c\.id, c\.messages\);[\s\S]{0,500}if \(!transcriptOk\(c\.messages\)\) \{\s*skip\(/.test(src));
	check('applySync names a refused chat in `refused`, not in `failed`',
		/refused\.chats = got\.refused/.test(src) && /return \{ failed: failed, refused: refused \};/.test(src));
	check('sync.js reads `refused` apart from `failed`, so a refused chat does not hold the version back',
		/lastRefused = \(report && report\.refused/.test(syncSrc) && /return failed\.concat\(core\);/.test(syncSrc));
}

console.log('\n' + (checks - failures) + ' of ' + checks + ' checks pass');
if (BREAK) {
	console.log(failures ? `break '${BREAK}' was CAUGHT.` : `break '${BREAK}' PASSED: the checks prove nothing.`);
	process.exit(failures ? 0 : 1);
}
process.exit(failures ? 1 : 0);
