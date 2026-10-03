/* ============================================================
   Test -- a collect reads the settled store (QA F-1, 3 Oct 2026).
   ------------------------------------------------------------
   THE FAULT. `collectChatsRefs` read a chat's transcript through `ChatStore.loadMessages`
   while a save of that chat was still queued behind an earlier write (`ChatStore.schedule`
   holds the newer list until the one writing finishes, and its transaction is created
   only then). A read made meanwhile is ordered before that write and serves the OLD
   transcript. The old serial's fingerprint equalled the stored manifest's, so the collect
   named the old manifest, and `noteFps` put that fingerprint on the summary beside the
   `seed` of the NEW copy in hand (`carryChatFigures` had taken it at the save). Every
   later collect then found `sum.fp` equal to the manifest's and reused it with no load,
   across reloads, so the far device lacked the newest message until the chat moved
   again. A hand-off's immediate `flush()` after `persistChats`, or a write that outlasts
   the push debounce, is the trigger.

   THE FIX. The collect awaits `ChatStore.settled()` before it reads the mirror ("never
   past a write of our own", the law `refresh` already states), and `noteFps`'s database
   put lands only while the stored row's `seed` still equals the seed the collect measured.

   WHAT IS CHECKED. The REAL `collectChatsRefs` (with the `slimChat`, `fileHash` and
   `freshestFirst` it reaches) lifted from the tree under test (dev/syncprobe.mjs),
   against a store that keeps the ordering that matters: a read serves the disk as it
   is when the read begins, a queued write lands later, and `settled()` resolves when it
   has. `noteFps` in the stand-in keeps the mirror's own seed test, as the real one does.
     1. the race collect names the NEW transcript (a fresh manifest, the new message
        offloaded), never the old manifest;
     2. the summary's `fp` is not the old serial's, whatever it is beside the new seed;
     3. a quiet collect after it still names the new transcript;
     4. the control, the write landed before the collect, is the same;
     5. the database put of `noteFps` is a compare-and-set on the row's `seed` (the
        store's own closure cannot be lifted without a database, so this is a guard on
        the source, and the browser probe `qa_stalefp` is the behavioural proof).
     node www/js/stalefp.test.mjs            # ALL PASS
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0;
function check(name, cond, detail) {
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); failures++; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const msg  = (mid, text) => ({ role: 'user', content: text, mid: mid, ts: 1 });
const OLD  = [msg('m1', 'first'), msg('m2', 'second')];
const NEW  = OLD.concat([msg('m3', 'THE NEWEST MESSAGE')]);

/// One scenario: a chat at the old transcript with a stored manifest for it, the chat
/// moved in hand (the mirror holds the new seed, `fp` cleared as `carryChatFigures`
/// leaves it), its write still queued, and a collect begun.
async function scenario(landFirst) {
	const win = makeWindow({ now: 1_000_000_000 });
	const { fileHash } = sliceDaimond(win, ['fileHash'], {}).fns;
	const ser = (m) => JSON.stringify(m);

	let disk = OLD.slice();							// what the store serves
	let writeLands = null;							// resolves when the queued write has landed
	const offloaded = [];							// the serials offloaded
	const manifests = { '@c/c1': { v: 1, size: ser(OLD).length, key: 'K-' + fileHash(ser(OLD)), chunks: ['k0'], fp: fileHash(ser(OLD)) } };
	const mirror = [{ id: 'c1', name: 'c1', model: 'm', provider: '', updatedAt: 5, metaAt: 5,
		bytes: ser(NEW).length, fp: '', seed: fileHash(ser(NEW)) }];

	const ChatStore = {
		stored:       () => mirror,
		loadMessages: async (id) => ({ messages: disk.slice() }),		// the disk as it is when the read begins
		settled:      () => writeLands || Promise.resolve(),
		noteFps: (fixes) => {											// the mirror half of the real one
			fixes.forEach((f) => { const m = mirror.find((x) => x.id === f.id); if (m && (m.seed || '') === (f.seed || '')) { m.bytes = f.bytes; if (f.fp) m.fp = f.fp; } });
		},
	};
	win.DaimondChunks = { offloadBytes: async (tag, bytes) => {
		const s = new TextDecoder().decode(bytes); offloaded.push(s);
		return { v: 1, size: s.length, key: 'K-' + fileHash(s), chunks: ['k-' + fileHash(s)] };
	} };
	win.DaimondCloud = {
		available:     () => true,
		contentGet:    (k) => manifests[k] || null,
		contentSet:    (k, m) => { manifests[k] = m; return true; },
		contentForget: () => {},
		contentReap:   () => {},
	};
	const { collectChatsRefs } = sliceDaimond(win, ['collectChatsRefs'], {
		ChatStore, storedChats: () => ChatStore.stored(), noteCloudIndexStuck: () => {},
	}).fns;

	// The save of the new copy is queued behind a write in flight: it lands later.
	writeLands = wait(30).then(() => { disk = NEW.slice(); writeLands = null; });
	if (landFirst) await writeLands;

	const nameOf = (parcel) => { const e = parcel.find((c) => c.id === 'c1'); return e && e.messagesRef ? e.messagesRef.key : null; };
	const first  = await collectChatsRefs(0);					// budget 0: every chat is a reference
	await writeLands;											// the write lands in the end, as it does in life
	const second = await collectChatsRefs(0);					// a quiet collect, the same state
	return { fileHash, ser, key0: manifests['@c/c1'].key, k1: nameOf(first), k2: nameOf(second),
		offloaded, mirror: mirror[0], oldKey: 'K-' + fileHash(ser(OLD)), newKey: 'K-' + fileHash(ser(NEW)),
		oldFp: fileHash(ser(OLD)), newFp: fileHash(ser(NEW)) };
}

console.log('\n-- a collect behind a queued write of the chat --');
const r = await scenario(false);
check('1. the race collect names the NEW transcript, not the old manifest', r.k1 === r.newKey && r.k1 !== r.oldKey,
	'named ' + r.k1 + ', old ' + r.oldKey + ', new ' + r.newKey);
check('1. and the newest message was offloaded', r.offloaded.some((s) => s.indexOf('THE NEWEST MESSAGE') >= 0),
	'offloaded ' + r.offloaded.length + ' serial(s)');
check('2. the summary\'s fp is not the old serial\'s beside the new copy\'s seed', r.mirror.fp !== r.oldFp,
	'fp ' + r.mirror.fp + ' seed ' + r.mirror.seed);
check('3. a quiet collect after it still names the new transcript', r.k2 === r.newKey, 'named ' + r.k2);

console.log('\n-- the control: the write landed before the collect --');
const c = await scenario(true);
check('4. control: the collect names the new transcript', c.k1 === c.newKey && c.k2 === c.newKey, 'named ' + c.k1 + ' then ' + c.k2);
check('4. control: the summary\'s fp is the new serial\'s', c.mirror.fp === c.newFp, 'fp ' + c.mirror.fp);

console.log('\n-- the database put of noteFps is a compare-and-set on the seed --');
const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, 'daimond.js'), 'utf8');
const at = src.indexOf('noteFps: function (fixes)');
const body = at < 0 ? '' : src.slice(at, src.indexOf('loadCount:', at));
const put = body.indexOf('st.put(s)');
const cas = body.indexOf('(s.seed || \'\') !== (f.seed || \'\')');
check('5. the row\'s seed is compared with the measured seed before the put lands', at >= 0 && put > 0 && cas > 0 && cas < put,
	'noteFps ' + at + ', compare ' + cas + ', put ' + put);

console.log(failures ? '\n' + failures + ' FAILED' : '\nALL PASS');
process.exit(failures ? 1 : 0);
