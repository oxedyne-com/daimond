/* ============================================================
   shorter.test.mjs -- the SHORTER trail names only a chat the parcel shortened
   (UNBLOCK-1 lane, FLOW; diagnosis:
   ~/usr/code/ai/claude/notes/daimond_rig_20261016/diag/shorter/SHORTER_diagnosis.md).

   THE BUG. `applyChats` checked every stored chat for a shortened transcript, the
   ones the parcel never carried included. Such a chat stays as its summary (no
   messages held, a real `msgCount`), so it read as shortened to 0 and wrote a false
   `sync chats SHORTER n -> 0` line in the durable trail.

   `applyChats` runs here as written, lifted out of daimond.js by source, with its
   store and UI stubbed.

   Run: node www/js/shorter.test.mjs
   ============================================================ */
import { makeWindow, sliceDaimond } from '../../dev/syncprobe.mjs';

let failures = 0, checks = 0;
function check(name, cond, detail) {
	checks++;
	if (cond) console.log('  ok   ' + name);
	else { console.log('  FAIL ' + name + (detail !== undefined ? '  (' + detail + ')' : '')); failures++; }
}

const msg = (mid, role, content, ts) => ({ mid, role, content, ts });
const A_MSGS = [msg('a1', 'user', 'one', 1), msg('a2', 'assistant', 'two', 2), msg('a3', 'user', 'three', 3)];
const B_MSGS = [msg('b1', 'user', 'b one', 1), msg('b2', 'assistant', 'b two', 2)];

/// Two stored chats, neither resident (summaries since Stage 1): A and B.
function world() {
	const w = makeWindow({});
	const rec = { saved: null, trail: [] };
	const stored = [
		{ id: 'A', name: 'A', messages: [], msgCount: A_MSGS.length, _loaded: false, updatedAt: 100, metaAt: 100 },
		{ id: 'B', name: 'B', messages: [], msgCount: B_MSGS.length, _loaded: false, updatedAt: 100, metaAt: 100 },
	];
	const held = { A: A_MSGS, B: B_MSGS };
	const ChatStore = {
		vouched: () => true,
		booted: async () => {},
		putTombs: async () => true,
		stored: () => (rec.saved || stored).slice(),
		loadMessages: async (id) => ({ messages: JSON.parse(JSON.stringify(held[id] || [])), session: null }),
		save: (list) => { rec.saved = list; },
		sweepTombs: async () => false,
	};
	w.DaimondChunks = { materialiseBytes: async () => null };
	w.DaimondCloud = { contentGet: () => null, contentSet: () => true };
	const stub = {
		ChatStore,
		notePeerRef: () => {},
		onChatsChangedElsewhere: () => {},
		DaimondMarksHere: { chatSettle: () => false, chatDropAll: () => {} },
		dropChatApp: () => {},
		trail: (k, d) => { rec.trail.push(k + ' | ' + d); },
		diag: () => {},
		fileHash: (s) => 'h' + String(s).length,
	};
	const { fns } = sliceDaimond(w, ['applyChats'], stub);
	return { applyChats: fns.applyChats, rec };
}

const shorter = (rec, id) => rec.trail.filter((l) => l.indexOf('SHORTER') !== -1 && l.indexOf(id + ':') !== -1);

console.log('shorter: the SHORTER trail names only a chat this parcel shortened\n');

// (a) A parcel carrying A only: B, never carried, is not "shortened to 0".
{
	const h = world();
	await h.applyChats({ chats: [{ id: 'A', name: 'A', messages: JSON.parse(JSON.stringify(A_MSGS)), updatedAt: 200, metaAt: 100 }],
		tombs: {}, msgTombs: {} }, 'dev-b');
	check('a chat the parcel did not carry writes no SHORTER line', shorter(h.rec, 'B').length === 0, JSON.stringify(h.rec.trail));
	check('  nor does the carried chat it left whole', shorter(h.rec, 'A').length === 0, JSON.stringify(h.rec.trail));
}

// (b) A parcel whose message tombstone shortens A still says so; B stays silent.
{
	const h = world();
	await h.applyChats({ chats: [{ id: 'A', name: 'A', messages: JSON.parse(JSON.stringify(A_MSGS.slice(0, 2))), updatedAt: 200, metaAt: 100 }],
		tombs: {}, msgTombs: { a3: 150 } }, 'dev-b');
	const la = shorter(h.rec, 'A');
	check('a tombstone that shortens a carried chat writes its SHORTER line', la.length === 1 && /3 -> 2/.test(la[0]), JSON.stringify(h.rec.trail));
	check('  and the chat it did not carry still writes none', shorter(h.rec, 'B').length === 0, JSON.stringify(h.rec.trail));
}

console.log('\n' + (checks - failures) + ' of ' + checks + ' checks pass');
process.exit(failures ? 1 : 0);
